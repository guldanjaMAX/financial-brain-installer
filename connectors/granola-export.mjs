/** Supervised file import. The caller supplies authorized local request custody. */
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { open, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import { batches, envelopeBytes } from "../ingest/envelope-batching.mjs";
import { textQuality } from "../ingest/quality.mjs";
import { scanEnvelope } from "../worker/src/lib/secret-scan.js";
import { granolaError, normalizeGranolaRecord } from "./granola-records.mjs";
import { GRANOLA_EXPORT_MAX_BYTES, GRANOLA_EXPORT_READER_PATH } from "./granola-export-reader.mjs";

export { GRANOLA_EXPORT_MAX_BYTES };
const CONFIG_KEYS = new Set(["_comment", "enabled", "source", "transport", "format", "owner_email", "export_path"]);
const fail = (code, stage, message) => { throw granolaError(code, stage, message); };

export function validateGranolaConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key => !CONFIG_KEYS.has(key)) || config.enabled !== true ||
      typeof config.source !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(config.source) ||
      config.transport !== "file-export" || config.format !== "granola.meeting.v1" ||
      typeof config.owner_email !== "string" || config.owner_email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(config.owner_email) ||
      typeof config.export_path !== "string" || /[\u0000-\u001f\u007f]/u.test(config.export_path) ||
      !isAbsolute(config.export_path) ||
      (process.platform === "win32" && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(parse(config.export_path).root))) {
    fail("GRANOLA_CONFIG_INVALID", "config", "An enabled, reviewed file-export configuration with exact owner binding and absolute export path is required.");
  }
  return Object.freeze({ ...config });
}

const sameDirectory = (stat, expected) => stat.isDirectory() && !stat.isSymbolicLink() &&
  stat.dev === expected.dev && stat.ino === expected.ino &&
  (process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === expected.uid));

async function verifyRoot({ root, canonicalRoot, stat, handle }) {
  // Both spellings must still name the directory whose permissions passed.
  // In particular, realpath must never replace that original identity check.
  if (!sameDirectory(await lstat(root), stat) ||
      !sameDirectory(await lstat(canonicalRoot), stat) ||
      (handle && !sameDirectory(await handle.stat(), stat))) throw new Error();
}

async function readExport(path, custody) {
  const { root, canonicalRoot } = custody;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || dirname(resolve(path)) !== root || !path.endsWith(".json")) throw new Error();
    await verifyRoot(custody);
    const entry = await lstat(path);
    const canonicalPath = resolve(canonicalRoot, basename(path));
    if (!entry.isFile() || entry.isSymbolicLink() || await realpath(path) !== canonicalPath) throw new Error();
    const expected = stat => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid });
    // A separate process pins cwd in the kernel without changing the caller's
    // global cwd. The child verifies that directory before any member read.
    const bytes = await new Promise((accept, reject) => {
      const env = process.platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot } : {};
      const child = execFile(process.execPath, [GRANOLA_EXPORT_READER_PATH], {
        cwd: canonicalRoot, env, encoding: "buffer", maxBuffer: GRANOLA_EXPORT_MAX_BYTES + 1,
        timeout: 10_000, windowsHide: true,
      }, (error, stdout) => error ? reject(new Error()) : accept(stdout));
      child.stdin.on("error", () => reject(new Error()));
      child.stdin.end(JSON.stringify({ member: basename(path), root: expected(custody.stat), entry: expected(entry) }));
    });
    await verifyRoot(custody);
    return bytes;
  } catch {
    // Filesystem exceptions can carry private filenames. Keep only a fixed code.
    fail("GRANOLA_FILE_UNSAFE", "file", "Selected export is not a stable bounded regular JSON file inside the declared root.");
  }
}

export async function planGranolaExport({ config: supplied, files } = {}) {
  const config = validateGranolaConfig(supplied);
  if (!Array.isArray(files) || !files.length || files.length > 100) {
    fail("GRANOLA_CONFIG_INVALID", "selection", "An explicit file selection of 1-100 meeting exports is required.");
  }
  let custody;
  try {
    const root = resolve(config.export_path);
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error();
    // Refuse a linked root itself; canonicalize only its permitted ancestors.
    const canonicalRoot = await realpath(root);
    custody = { root, canonicalRoot, stat, handle: null };
    // Windows does not expose POSIX directory-open flags. Its native identity
    // checks still bind both paths; POSIX also retains a no-follow descriptor.
    if (process.platform !== "win32") {
      custody.handle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }
    await verifyRoot(custody);
  } catch {
    await custody?.handle?.close();
    fail("GRANOLA_FILE_UNSAFE", "file", "The declared export root must remain the same owner-only regular directory without links.");
  }
  try {
    const byId = new Map();
    let totalBytes = 0, duplicateExports = 0;
    for (const file of files) {
      const bytes = await readExport(file, custody);
      totalBytes += bytes.length;
      if (totalBytes > 8 * 1024 * 1024) fail("GRANOLA_EXPORT_TOO_LARGE", "file", "Selected export bytes exceed the bounded import limit.");
      let record;
      try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { fail("GRANOLA_EXPORT_INVALID", "schema", "Meeting export is not valid UTF-8 JSON."); }
      const doc = normalizeGranolaRecord(record, { source: config.source, ownerEmail: config.owner_email });
      if (!textQuality(doc.content).ok) fail("GRANOLA_TEXT_QUALITY_REFUSED", "content", "Meeting text failed the common quality check.");
      if (scanEnvelope(doc).shouldRefuse) fail("GRANOLA_CONTENT_REFUSED", "content", "Meeting export failed the common credential scan.");
      if (envelopeBytes(doc) > 800_000) fail("GRANOLA_EXPORT_TOO_LARGE", "content", "Meeting metadata exceeds the bounded envelope limit.");
      const previous = byId.get(doc.source_id);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(doc)) {
          fail("GRANOLA_DUPLICATE_CONFLICT", "dedupe", "Selected exports contain conflicting revisions of one meeting; select one reviewed revision.");
        }
        duplicateExports++;
      } else byId.set(doc.source_id, doc);
    }
    return { source: config.source, kind: "granola", documents: [...byId.values()], files_seen: files.length, duplicate_exports: duplicateExports };
  } finally { await custody.handle?.close(); }
}

async function reply(request, path, body, code) {
  let conflict = false, receipt;
  try {
    const response = await request(path, body);
    conflict = path.endsWith("source-register") && response?.status === 409;
    if (!conflict) {
      if (!response?.ok || response.redirected === true) throw new Error();
      receipt = await response.json();
    }
  } catch {
    // Adapter and reader errors are untrusted even when they carry our code.
    fail(code, "delivery", "Import did not receive an exact successful receipt; retry the same reviewed files.");
  }
  if (conflict) fail("GRANOLA_SOURCE_KIND_CONFLICT", "registry", "Declared source is registered with an incompatible kind.");
  return receipt;
}

/** No ambient credentials, default fetch, cursor, scheduler or deletion capability. */
export async function importGranolaExport(input, { request } = {}) {
  const plan = await planGranolaExport(input);
  if (typeof request !== "function") fail("GRANOLA_CONFIG_INVALID", "delivery", "An authorized request adapter is required.");
  const registration = await reply(request, "/api/admin/brain/source-register", {
    source: plan.source, kind: plan.kind,
  }, "GRANOLA_REGISTRATION_UNVERIFIED");
  if (registration?.source !== plan.source || registration?.kind !== plan.kind ||
      typeof registration?.registered !== "boolean" ||
      (registration.registered && (registration.registry_event_recorded !== true ||
        typeof registration.operation_id !== "string" || !registration.operation_id)) ||
      (!registration.registered && (Object.hasOwn(registration, "registry_event_recorded") ||
        Object.hasOwn(registration, "operation_id")))) {
    fail("GRANOLA_REGISTRATION_UNVERIFIED", "registry", "Source registration did not confirm the planned identity and kind.");
  }
  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const group of batches(plan.documents.map(envelope => ({ envelope })))) {
    const docs = group.map(item => item.envelope);
    const receipt = await reply(request, "/api/admin/brain/ingest/batch", { docs }, "GRANOLA_IMPORT_INCOMPLETE");
    if (receipt?.total !== docs.length || !Array.isArray(receipt.results) || receipt.results.length !== docs.length) {
      fail("GRANOLA_IMPORT_INCOMPLETE", "receipt", "Batch receipt is incomplete; retry the same reviewed files.");
    }
    for (let index = 0; index < docs.length; index++) {
      const doc = docs[index], result = receipt.results[index];
      if (result?.source_type !== doc.source_type || result?.source_id !== doc.source_id ||
          result?.doc_uid !== `${doc.source_type}:${doc.source_id}` || !Object.hasOwn(counts, result?.status)) {
        fail("GRANOLA_IMPORT_INCOMPLETE", "receipt", "A planned meeting lacks an exact accepted receipt; retry the same reviewed files.");
      }
      counts[result.status]++;
    }
  }
  return { complete: true, files_seen: plan.files_seen, records: plan.documents.length,
    duplicate_exports: plan.duplicate_exports, ...counts, semantic_index: "not_verified" };
}
