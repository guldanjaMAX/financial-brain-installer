/**
 * Local staging-source cleanup.
 *
 * This module deliberately separates proof, planning, and mutation. Callers
 * must obtain exact current document, provenance, and vector readback proof
 * from the Brain before a file may enter a plan. The executor receives a Trash adapter rather than a
 * generic filesystem delete function so no cleanup path can degrade to rm.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const ROLE_ALIASES = Object.freeze({
  ongoing: "ongoing",
  staging: "staging",
  "one-time-import": "staging",
});
const SHA256_RE = /^[0-9a-f]{64}$/;

function stableFilesystemIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function validFilesystemIdentity(value) {
  return value && typeof value === "object" &&
    typeof value.dev === "string" && value.dev.length > 0 &&
    typeof value.ino === "string" && value.ino.length > 0;
}

export function sameFilesystemIdentity(left, right) {
  return validFilesystemIdentity(left) && validFilesystemIdentity(right) &&
    left.dev === right.dev && left.ino === right.ino;
}

function sameObservedFile(left, right) {
  return sameFilesystemIdentity(left.filesystem_identity, right.filesystem_identity) &&
    left.canonical_path === right.canonical_path &&
    left.original_content_sha256 === right.original_content_sha256 &&
    left.bytes === right.bytes;
}

/** Hash one opened ordinary file and prove the pathname still names that file. */
export function inspectCleanupFile(path) {
  const target = resolve(path);
  const pathBefore = lstatSync(target);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1) {
    throw new TypeError("cleanup can inspect only one ordinary file");
  }
  const descriptor = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(descriptor);
    const identity = stableFilesystemIdentity(before);
    if (!before.isFile() || before.nlink !== 1 ||
        !sameFilesystemIdentity(identity, stableFilesystemIdentity(pathBefore))) {
      throw new TypeError("a cleanup candidate changed while it was opened");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor);
    if (!sameFilesystemIdentity(identity, stableFilesystemIdentity(after)) ||
        Number(after.size) !== bytes ||
        Number(after.mtimeMs) !== Number(before.mtimeMs) ||
        Number(after.ctimeMs) !== Number(before.ctimeMs)) {
      throw new TypeError("a cleanup candidate changed while it was hashed");
    }
    const pathAfter = lstatSync(target);
    if (!sameFilesystemIdentity(identity, stableFilesystemIdentity(pathAfter))) {
      throw new TypeError("a cleanup candidate pathname changed while it was hashed");
    }
    return Object.freeze({
      path: target,
      canonical_path: realpathSync(target),
      bytes,
      original_content_sha256: hash.digest("hex"),
      filesystem_identity: identity,
      mtime_ms: Number(after.mtimeMs),
    });
  } finally {
    closeSync(descriptor);
  }
}

export function sourceRole(source = {}) {
  const value = source?.role == null ? "ongoing" : String(source.role);
  const role = ROLE_ALIASES[value];
  if (!role) throw new TypeError("source role must be ongoing, staging, or one-time-import");
  return role;
}

function confirmationFor(confirmations, file) {
  return confirmations?.[`${file.source}:${file.key}`] || null;
}

function safeFile(file) {
  if (!file || typeof file !== "object" || typeof file.source !== "string" ||
      typeof file.key !== "string" || typeof file.path !== "string" ||
      typeof file.canonical_path !== "string" ||
      !SHA256_RE.test(file.original_content_sha256 || "") ||
      !validFilesystemIdentity(file.filesystem_identity) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
    throw new TypeError("cleanup candidates need source, key, canonical path, byte hash, filesystem identity, and byte count");
  }
  return Object.freeze({
    ...file,
    filesystem_identity: Object.freeze({ ...file.filesystem_identity }),
  });
}

function safeExternalOriginal(value) {
  if (!value || typeof value !== "object" || typeof value.path !== "string" ||
      typeof value.canonical_path !== "string" || !Number.isSafeInteger(value.bytes) ||
      !SHA256_RE.test(value.original_content_sha256 || "") ||
      !validFilesystemIdentity(value.filesystem_identity)) return null;
  return Object.freeze({
    path: value.path,
    canonical_path: value.canonical_path,
    bytes: value.bytes,
    original_content_sha256: value.original_content_sha256,
    filesystem_identity: Object.freeze({ ...value.filesystem_identity }),
  });
}

export function buildLocalCleanupPlan({ files = [], sources = {}, confirmations = {} } = {}) {
  const copies = [];
  const onlyCopies = [];
  let inspected = 0;
  for (const raw of files) {
    const file = safeFile(raw);
    if (sourceRole(sources[file.source] || {}) !== "staging") continue;
    if (sources[file.source]?.retired === true) continue;
    inspected++;
    const proof = confirmationFor(confirmations, file);
    if (proof?.accepted_resolution_current !== true) continue;
    const external = safeExternalOriginal(proof.external_original);
    const distinctMatchingExternal = external &&
      external.original_content_sha256 === file.original_content_sha256 &&
      external.bytes === file.bytes &&
      external.canonical_path !== file.canonical_path &&
      !sameFilesystemIdentity(external.filesystem_identity, file.filesystem_identity)
      ? external
      : null;
    const item = Object.freeze({
      ...file,
      proof: typeof proof.proof === "string" ? proof.proof : null,
      external_original: distinctMatchingExternal,
    });
    if (item.external_original) copies.push(item);
    else onlyCopies.push(item);
  }
  const items = Object.freeze([...copies, ...onlyCopies]);
  const plan_id = createHash("sha256").update(JSON.stringify(items.map((item) => ({
    source: item.source,
    key: item.key,
    path: resolve(item.path),
    canonical_path: item.canonical_path,
    bytes: item.bytes,
    mtime_ms: item.mtime_ms,
    original_content_sha256: item.original_content_sha256,
    filesystem_identity: item.filesystem_identity,
    proof: item.proof,
    external_original: item.external_original,
  })))).digest("hex");
  return Object.freeze({
    version: 2,
    preview: true,
    copies: Object.freeze(copies),
    only_copies: Object.freeze(onlyCopies),
    items,
    plan_id,
    total_files: items.length,
    total_bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    inspected_files: inspected,
    eligible_files: items.length,
    ineligible_files: inspected - items.length,
    decision_points: inspected,
  });
}

function requireChoice(choice) {
  if (!["keep", "archive", "remove"].includes(choice)) {
    throw new TypeError("an only copy needs an explicit keep, archive, or remove choice");
  }
  return choice;
}

/** Move one file to the operating system's recoverable Trash. Never calls rm. */
export async function moveFileToSystemTrash(path, {
  platform = process.platform,
  spawn = spawnSync,
  stat = lstatSync,
  expectedIdentity = null,
} = {}) {
  const target = resolve(path);
  const before = stat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new TypeError("cleanup can move only one ordinary file to Trash");
  }
  if (expectedIdentity && !sameFilesystemIdentity(expectedIdentity, stableFilesystemIdentity(before))) {
    throw new TypeError("the cleanup candidate changed before the Trash operation");
  }
  if (platform === "darwin") {
    const script = String.raw`
ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const manager = $.NSFileManager.defaultManager;
  const ok = manager.trashItemAtURLResultingItemURLError(url, undefined, undefined);
  if (!ok) throw new Error('trash failed');
  return 'ok';
}`;
    const result = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, target], {
      encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin" },
    });
    if (result.status !== 0) throw new Error("macOS could not move the file to Trash");
    if (existsSync(target)) throw new Error("macOS did not confirm that the file reached Trash");
    return;
  }
  if (platform === "win32") {
    const script = [
      "$target=$args[0]",
      "(New-Object -ComObject Shell.Application).Namespace(10).MoveHere($target, 16)",
      "$until=(Get-Date).AddSeconds(30)",
      "while ((Test-Path -LiteralPath $target) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }",
      "if (Test-Path -LiteralPath $target) { exit 1 }",
    ].join("; ");
    const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, target], {
      encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    if (result.status !== 0) throw new Error("Windows could not move the file to Recycle Bin");
    return;
  }
  const result = spawn("gio", ["trash", "--", target], {
    encoding: "utf8", timeout: 30_000,
  });
  if (result.status !== 0) throw new Error("the system Trash command is unavailable");
  if (existsSync(target)) throw new Error("the system did not confirm that the file reached Trash");
}

function pendingMoveContext(file) {
  const quarantineRoot = join(
    dirname(resolve(file.path)),
    `.brain-cleanup-trash-${randomBytes(12).toString("hex")}`,
  );
  return Object.freeze({
    quarantine_root: quarantineRoot,
    quarantine_path: join(quarantineRoot, basename(file.path)),
  });
}

async function moveVerifiedFileToSystemTrash(file, trash, context, afterIsolate) {
  const sourcePath = resolve(file.path);
  const quarantineRoot = context.quarantine_root;
  const quarantinedPath = context.quarantine_path;
  let quarantined = false;
  try {
    mkdirSync(quarantineRoot, { mode: 0o700 });
    renameSync(sourcePath, quarantinedPath);
    quarantined = true;
    const quarantinedObservation = inspectCleanupFile(quarantinedPath);
    if (!sameFilesystemIdentity(file.filesystem_identity, quarantinedObservation.filesystem_identity) ||
        quarantinedObservation.original_content_sha256 !== file.original_content_sha256 ||
        quarantinedObservation.bytes !== file.bytes) {
      throw new TypeError("a cleanup candidate changed before it could be isolated for Trash");
    }
    await afterIsolate(file, context);
    await trash(quarantinedPath, { expectedIdentity: file.filesystem_identity });
    quarantined = false;
    rmdirSync(quarantineRoot);
  } catch (error) {
    if (quarantined && existsSync(quarantinedPath) && !existsSync(sourcePath)) {
      try { renameSync(quarantinedPath, sourcePath); } catch { /* pending state records ambiguity */ }
    }
    try { rmdirSync(quarantineRoot); } catch { /* preserve the exact candidate for recovery */ }
    throw error;
  }
}

function validPendingQuarantine(record) {
  if (typeof record?.path !== "string" || typeof record?.quarantine_path !== "string") return null;
  const sourcePath = resolve(record.path);
  const quarantinePath = resolve(record.quarantine_path);
  const quarantineRoot = dirname(quarantinePath);
  if (dirname(quarantineRoot) !== dirname(sourcePath) ||
      !basename(quarantineRoot).startsWith(".brain-cleanup-trash-") ||
      basename(quarantinePath) !== basename(sourcePath)) return null;
  return { sourcePath, quarantinePath, quarantineRoot };
}

/** Resume or close one crash-persistent move intent from observable local state. */
export async function reconcilePendingCleanupMove(record, { trash = moveFileToSystemTrash } = {}) {
  if (!record || typeof record !== "object" || typeof record.path !== "string" ||
      !SHA256_RE.test(record.original_content_sha256 || "") ||
      !validFilesystemIdentity(record.filesystem_identity) ||
      !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    throw new TypeError("a pending cleanup move is malformed");
  }
  const sourcePath = resolve(record.path);
  const quarantine = record.quarantine_path ? validPendingQuarantine(record) : null;
  if (record.quarantine_path && !quarantine) {
    throw new TypeError("a pending cleanup quarantine path is unsafe");
  }
  if (quarantine && existsSync(quarantine.quarantinePath)) {
    const observed = inspectCleanupFile(quarantine.quarantinePath);
    if (!sameFilesystemIdentity(record.filesystem_identity, observed.filesystem_identity) ||
        observed.original_content_sha256 !== record.original_content_sha256 ||
        observed.bytes !== record.bytes) {
      throw new TypeError("a pending cleanup quarantine file no longer matches its move intent");
    }
    await trash(quarantine.quarantinePath, { expectedIdentity: record.filesystem_identity });
    if (existsSync(quarantine.quarantinePath)) {
      throw new Error("the pending cleanup file did not leave its quarantine");
    }
    rmdirSync(quarantine.quarantineRoot);
    return "moved";
  }
  if (existsSync(sourcePath)) return "not_moved";
  if (record.phase === "isolated") {
    // The exact file was re-hashed inside the private quarantine before this
    // phase was persisted. Its later absence closes a lost Trash response.
    return "moved";
  }
  throw new Error("a pending cleanup move is ambiguous; the source and quarantine are both absent");
}

function assertObservedCurrent(file) {
  let current;
  try {
    current = inspectCleanupFile(file.path);
  } catch {
    throw new TypeError("a cleanup candidate changed after preview; preview again");
  }
  if (!sameObservedFile(file, current) ||
      (Number.isFinite(file.mtime_ms) && Math.trunc(current.mtime_ms) !== Math.trunc(file.mtime_ms))) {
    throw new TypeError("a cleanup candidate changed after preview; preview again");
  }
  return current;
}

function assertExternalOriginalCurrent(file) {
  if (!file.external_original) return null;
  let current;
  try {
    current = inspectCleanupFile(file.external_original.path);
  } catch {
    throw new TypeError("the distinct external copy no longer exists; this file is now an only copy and needs a new preview");
  }
  if (!sameObservedFile(file.external_original, current) ||
      sameFilesystemIdentity(file.filesystem_identity, current.filesystem_identity) ||
      file.canonical_path === current.canonical_path) {
    throw new TypeError("the distinct external copy no longer matches; this file is now an only copy and needs a new preview");
  }
  return current;
}

export async function executeLocalCleanup(plan, {
  approve = null,
  onlyCopyChoice = null,
  trash = moveFileToSystemTrash,
  archive = null,
  assertCurrent = assertObservedCurrent,
  assertExternalOriginal = assertExternalOriginalCurrent,
  beforeMove = async () => {},
  afterIsolate = async () => {},
  afterMove = async () => {},
  onMoveError = async () => {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!plan?.preview || !Array.isArray(plan.items)) throw new TypeError("a cleanup preview is required");
  if (approve !== plan.plan_id) throw new TypeError("cleanup requires the exact preview fingerprint");
  // A pathname check is evidence only at the instant it runs. This executor
  // cannot hold recoverable custody of an outside file across a platform Trash
  // move, so every provisional outside copy is conservatively handled as an
  // only copy at apply time. The owner's explicit choice is the safety gate.
  for (const file of plan.copies) {
    await assertCurrent(file);
    await assertExternalOriginal(file);
  }
  if (plan.copies.length && onlyCopyChoice == null) {
    throw new TypeError(
      "outside-copy path validation cannot hold custody through Trash; treat it as an only copy and choose keep, archive, or remove",
    );
  }
  const choice = plan.items.length ? requireChoice(onlyCopyChoice) : "keep";
  if (choice === "archive" && plan.items.length && typeof archive !== "function") {
    throw new TypeError("archive choice needs an owner-selected encrypted archive destination");
  }
  const selected = choice === "remove" || choice === "archive" ? plan.items : [];
  let trashed = 0;
  let archived = 0;
  for (const file of selected) {
    await assertCurrent(file);
    if (choice === "archive") {
      await archive(file.path);
      archived++;
    }
    const moveContext = trash === moveFileToSystemTrash ? pendingMoveContext(file) : null;
    await beforeMove(file, moveContext);
    try {
      if (trash === moveFileToSystemTrash) {
        await moveVerifiedFileToSystemTrash(file, trash, moveContext, afterIsolate);
      }
      else await trash(file.path, { expectedIdentity: file.filesystem_identity });
      if (existsSync(file.path)) {
        throw new Error("the Trash adapter returned but the cleanup source is still present");
      }
      trashed++;
      await afterMove(file);
    } catch (error) {
      await onMoveError(file, error);
      throw error;
    }
  }
  return Object.freeze({
    version: 1,
    operation: "cleanup-local",
    completed_at: now(),
    considered: plan.total_files,
    moved_to_trash: trashed,
    archived,
    kept: choice === "keep" ? plan.items.length : 0,
    bytes_released: selected.reduce((sum, file) => sum + file.bytes, 0),
    recoverable: true,
    deletion_primitive: "system_trash",
  });
}

export function markConsumed(state, { source, key, proof, consumed_at } = {}) {
  if (!state || typeof state !== "object") throw new TypeError("ingest state is required");
  if (typeof source !== "string" || typeof key !== "string" || typeof proof !== "string" || !proof) {
    throw new TypeError("consumed state needs source, key, and proof");
  }
  if (!state.consumed || typeof state.consumed !== "object") state.consumed = {};
  state.consumed[key] = { source, proof, consumed_at };
  return state;
}

export function missingOngoingKeys({
  knownKeys = [],
  presentKeys = [],
  role = "ongoing",
  consumed = {},
  cleanupPending = {},
} = {}) {
  const present = presentKeys instanceof Set ? presentKeys : new Set(presentKeys);
  const normalizedRole = sourceRole({ role });
  return [...knownKeys]
    .filter((key) => !present.has(key))
    .filter((key) => normalizedRole === "ongoing" || (!consumed?.[key] && !cleanupPending?.[key]))
    .sort();
}

export function retentionEligible(file, { now_ms = Date.now(), retention_days } = {}) {
  if (!Number.isSafeInteger(retention_days) || retention_days < 1) {
    throw new TypeError("retention_days must be a positive integer");
  }
  if (!Number.isFinite(file?.mtime_ms) || file.mtime_ms < 0) return false;
  return file.mtime_ms <= now_ms - retention_days * 86_400_000;
}

function uploadFolders(manifest) {
  const folders = manifest?.corpora?.upload?.folders;
  return Array.isArray(folders) ? folders : [];
}

export function retireStagingSource(manifest, source, { now = () => new Date().toISOString() } = {}) {
  const matches = uploadFolders(manifest).filter((folder) => folder?.source === source);
  if (matches.length !== 1) throw new TypeError("retirement needs exactly one declared upload folder source");
  const declaration = matches[0];
  if (sourceRole(declaration) !== "staging" || declaration.role !== "one-time-import") {
    throw new TypeError("only a one-time-import source can be retired");
  }
  declaration.retired = true;
  declaration.retired_at = now();
  return Object.freeze({
    version: 1,
    source,
    retired_at: declaration.retired_at,
    decision_points: matches.length,
    future_walks_stopped: true,
    documents_preserved: true,
  });
}
