/**
 * Provider-neutral portable recovery for exports larger than one D1 import.
 *
 * Transport, a coherent source cut, the reviewed durable-table/normalization
 * contract and SQL statement boundaries belong to the caller. openUnits must
 * yield complete independently executable SQL units, in dependency order,
 * including schema, recovery markers and finalization. Never split a SQL
 * statement, transaction, trigger or UTF-8 sequence at a byte boundary.
 *
 * This module owns the encrypted set, exact ordered coverage, restart and
 * empty-disposable-target rules. It resolves no credentials and has no CLI,
 * provider transport, production cutover or database deletion capability.
 * The existing single-artifact recovery path remains separate and unchanged.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, rmdirSync,
  unlinkSync, writeSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  assertNoRecoveryArtifactResidue, encryptRecoveryArtifact,
  withDecryptedRecoveryArtifact,
} from "./recovery-artifact-crypto.mjs";

export const RECOVERY_MULTIPART_IMPORT_BYTES = 5 * 1024 ** 3;
const ENVELOPE_BYTES = 52; // FBRREC1, salt, IV and authentication tag.
const MANIFEST = "manifest.json.fbrenc";
const BINDING = "export-binding.json.fbrenc";
const LOCK = ".set-lock";
const MAX_MANIFEST_BYTES = 16 * 1024 ** 2;
const MAX_PARTS = 10_000;
const SHA = /^[0-9a-f]{64}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SNAPSHOT_KEYS = ["schema_fingerprint", "content_fingerprint", "aggregate_fingerprint", "tables"];
const canonical = (value) => JSON.stringify(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const filename = (index) => `part-${String(index).padStart(6, "0")}.sql.fbrenc`;

function refuse(reason) {
  const error = new Error(`RECOVERY_MULTIPART_${reason}`);
  error.code = error.message;
  throw error;
}
function requireThat(condition, reason) { if (!condition) refuse(reason); }
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function digest(value) { return typeof value === "string" && SHA.test(value); }
function snapshotValue(value) {
  requireThat(exact(value, SNAPSHOT_KEYS) && SNAPSHOT_KEYS.slice(0, 3).every((key) => digest(value[key])) &&
    Array.isArray(value.tables) && value.tables.length > 0 && value.tables.length <= 1000, "SNAPSHOT_INVALID");
  const tables = value.tables.map((item) => {
    requireThat(exact(item, ["table", "rows"]) && TABLE.test(item.table) && integer(item.rows), "SNAPSHOT_INVALID");
    return { table: item.table, rows: item.rows };
  });
  requireThat(new Set(tables.map(({ table }) => table)).size === tables.length, "SNAPSHOT_INVALID");
  return { schema_fingerprint: value.schema_fingerprint, content_fingerprint: value.content_fingerprint,
    aggregate_fingerprint: value.aggregate_fingerprint, tables };
}
function sameSnapshot(actual, expected, reason) {
  requireThat(canonical(snapshotValue(actual)) === canonical(snapshotValue(expected)), reason);
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function owned(info) {
  return (typeof process.getuid !== "function" || info.uid === process.getuid()) &&
    (process.platform === "win32" || (info.mode & 0o077) === 0);
}
function privateDirectory(path, create = false) {
  requireThat(typeof path === "string" && isAbsolute(path) && resolve(path) === path, "DIRECTORY_INVALID");
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const info = lstatSync(path);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && owned(info) && realpathSync(path) === path,
    "DIRECTORY_INVALID");
  return info;
}
function syncDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function stableFile(path, maximum, consume = null) {
  const before = lstatSync(path);
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && owned(before) &&
    integer(before.size, 1, maximum), "FILE_UNSAFE");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    requireThat(sameFile(before, fstatSync(fd)), "FILE_CHANGED");
    const hasher = createHash("sha256");
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      requireThat(bytes <= maximum, "FILE_TOO_LARGE");
      hasher.update(buffer.subarray(0, count));
      if (consume) consume(buffer.subarray(0, count));
    }
    requireThat(bytes === before.size && sameFile(before, fstatSync(fd)) && sameFile(before, lstatSync(path)),
      "FILE_CHANGED");
    return { bytes, sha256: hasher.digest("hex") };
  } finally { buffer.fill(0); closeSync(fd); }
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    requireThat(count > 0, "WRITE_FAILED");
    offset += count;
  }
}
function temporary(directory) {
  const path = join(directory, `.brain-recovery-plaintext.tmp-${randomBytes(16).toString("hex")}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    (constants.O_NOFOLLOW || 0), 0o600);
  const identity = fstatSync(fd);
  return { path, fd, identity };
}
function removeTemporary(file) {
  if (file.fd !== null) { closeSync(file.fd); file.fd = null; }
  const info = lstatSync(file.path);
  requireThat(info.dev === file.identity.dev && info.ino === file.identity.ino && info.nlink === 1,
    "TEMPORARY_CHANGED");
  unlinkSync(file.path);
}
async function encryptedJson(directory, name, value, withKey) {
  const file = temporary(directory);
  const bytes = Buffer.from(canonical(value));
  try {
    requireThat(bytes.length <= MAX_MANIFEST_BYTES - ENVELOPE_BYTES, "MANIFEST_TOO_LARGE");
    writeAll(file.fd, bytes); fsyncSync(file.fd); closeSync(file.fd); file.fd = null;
    await withKey((key) => encryptRecoveryArtifact(file.path, join(directory, name), key));
  } finally { bytes.fill(0); removeTemporary(file); }
}
function addCoverage(state, coverage, tables) {
  requireThat(Array.isArray(coverage), "COVERAGE_INVALID");
  for (const range of coverage) {
    requireThat(exact(range, ["table", "first_row", "last_row"]), "COVERAGE_INVALID");
    const index = tables.findIndex(({ table }) => table === range.table);
    requireThat(index >= 0 && integer(range.first_row, 1) && integer(range.last_row, range.first_row) &&
      range.last_row <= tables[index].rows && range.first_row === state.counts[index] + 1 &&
      tables.slice(0, index).every(({ rows }, i) => state.counts[i] === rows), "COVERAGE_INVALID");
    state.counts[index] = range.last_row;
  }
}
function appendCoverage(result, ranges) {
  for (const range of ranges) {
    const previous = result.at(-1);
    if (previous && previous.table === range.table && previous.last_row + 1 === range.first_row) {
      previous.last_row = range.last_row;
    } else result.push({ ...range });
  }
  return result;
}
function manifestValue(value) {
  requireThat(exact(value, ["format", "source_resource_fingerprint", "snapshot", "max_part_bytes", "part_count",
    "parts", "sql_sha256", "binding_sha256"]) && value.format === "financial_brain_recovery_multipart_v1" &&
    digest(value.source_resource_fingerprint) && digest(value.sql_sha256) && digest(value.binding_sha256) &&
    integer(value.max_part_bytes, ENVELOPE_BYTES + 1, RECOVERY_MULTIPART_IMPORT_BYTES) &&
    integer(value.part_count, 1, MAX_PARTS) && Array.isArray(value.parts) && value.parts.length === value.part_count,
  "MANIFEST_INVALID");
  const snapshot = snapshotValue(value.snapshot);
  const state = { counts: snapshot.tables.map(() => 0) };
  value.parts.forEach((part, i) => {
    requireThat(exact(part, ["index", "name", "bytes", "sha256", "sql_bytes", "sql_sha256", "coverage"]) &&
      part.index === i + 1 && part.name === filename(i + 1) &&
      integer(part.bytes, ENVELOPE_BYTES + 1, value.max_part_bytes) &&
      integer(part.sql_bytes, 1, value.max_part_bytes - ENVELOPE_BYTES) &&
      part.bytes === part.sql_bytes + ENVELOPE_BYTES && digest(part.sha256) && digest(part.sql_sha256),
    "PART_ORDER_OR_METADATA_INVALID");
    addCoverage(state, part.coverage, snapshot.tables);
  });
  requireThat(snapshot.tables.every(({ rows }, i) => state.counts[i] === rows), "COVERAGE_INCOMPLETE");
  requireThat(value.binding_sha256 === bindingFingerprint(value.source_resource_fingerprint, snapshot, value.max_part_bytes),
    "MANIFEST_BINDING_MISMATCH");
  return value;
}
function bindingFingerprint(source, snapshot, maximum) {
  return sha(canonical({ source_resource_fingerprint: source, snapshot, max_part_bytes: maximum }));
}
function exactInventory(directory, expected) {
  requireThat(canonical(readdirSync(directory).sort()) === canonical([...expected].sort()), "SET_INVENTORY_MISMATCH");
}
async function consumeParts(directory, manifest, withKey, callback) {
  const aggregate = createHash("sha256");
  for (const part of manifest.parts) {
    const path = join(directory, part.name);
    const ciphertext = stableFile(path, manifest.max_part_bytes);
    requireThat(ciphertext.bytes === part.bytes && ciphertext.sha256 === part.sha256, "PART_HASH_MISMATCH");
    await withKey((key) => withDecryptedRecoveryArtifact(path, directory, key, async (plaintext) => {
      const sql = stableFile(plaintext, manifest.max_part_bytes - ENVELOPE_BYTES, (bytes) => aggregate.update(bytes));
      requireThat(sql.bytes === part.sql_bytes && sql.sha256 === part.sql_sha256, "PART_PLAINTEXT_MISMATCH");
      await callback(plaintext, part.index);
      requireThat(stableFile(plaintext, manifest.max_part_bytes).sha256 === part.sql_sha256, "PART_PLAINTEXT_CHANGED");
    }));
  }
  requireThat(aggregate.digest("hex") === manifest.sql_sha256, "SQL_FINGERPRINT_MISMATCH");
}
async function readManifest(directory, expected, withKey) {
  requireThat(digest(expected), "MANIFEST_PIN_REQUIRED");
  const ciphertext = stableFile(join(directory, MANIFEST), MAX_MANIFEST_BYTES);
  requireThat(ciphertext.sha256 === expected, "MANIFEST_HASH_MISMATCH");
  const manifest = await withKey((key) => withDecryptedRecoveryArtifact(join(directory, MANIFEST), directory, key, (path) => {
    stableFile(path, MAX_MANIFEST_BYTES);
    let parsed;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { refuse("MANIFEST_INVALID"); }
    return manifestValue(parsed);
  }));
  requireThat(stableFile(join(directory, MANIFEST), MAX_MANIFEST_BYTES).sha256 === expected, "MANIFEST_CHANGED");
  return manifest;
}

/**
 * Export/resume a set into a dedicated owner-only directory. Each unit is
 * {sql: Buffer, coverage: [{table, first_row, last_row}]}; row ranges are
 * one-based ordinals in the caller's frozen canonical table ordering.
 * inspectExport must execute consumeParts into a local empty verifier and
 * return independently measured schema/content/aggregate fingerprints.
 * inspectSource must remeasure the same coherent source cut before sealing.
 * withKey resolves custody only while its callback runs; no key enters argv.
 */
export async function exportMultipartRecovery({ directory, sourceResourceFingerprint, snapshot: inputSnapshot,
  openUnits, inspectExport, inspectSource, withKey, maxPartBytes = RECOVERY_MULTIPART_IMPORT_BYTES,
  onPartVerified = () => {},
}) {
  requireThat([openUnits, inspectExport, inspectSource, withKey, onPartVerified].every((fn) => typeof fn === "function") &&
    digest(sourceResourceFingerprint) && integer(maxPartBytes, ENVELOPE_BYTES + 1, RECOVERY_MULTIPART_IMPORT_BYTES),
  "DEPENDENCIES_INVALID");
  const snapshot = snapshotValue(inputSnapshot);
  const binding = bindingFingerprint(sourceResourceFingerprint, snapshot, maxPartBytes);
  privateDirectory(directory, true);
  assertNoRecoveryArtifactResidue(directory);
  const lock = join(directory, LOCK);
  try { mkdirSync(lock, { mode: 0o700 }); } catch { refuse("EXPORT_BUSY_OR_INTERRUPTED"); }
  let file = null;
  try {
    const prior = readdirSync(directory).filter((name) => name !== LOCK);
    requireThat(prior.every((name) => [MANIFEST, BINDING].includes(name) || /^part-\d{6}\.sql\.fbrenc$/.test(name)), "SET_INVENTORY_MISMATCH");
    // Bind T0 before publishing the first part. A matching prefix alone cannot
    // authorize adopting a changed suffix after an interrupted export.
    if (prior.includes(BINDING)) {
      stableFile(join(directory, BINDING), MAX_MANIFEST_BYTES);
      await withKey((key) => withDecryptedRecoveryArtifact(join(directory, BINDING), directory, key, (path) => {
        let value;
        try { value = JSON.parse(readFileSync(path, "utf8")); } catch { refuse("RESUME_BINDING_MISMATCH"); }
        requireThat(exact(value, ["binding_sha256"]) && value.binding_sha256 === binding, "RESUME_BINDING_MISMATCH");
      }));
    } else if (!prior.includes(MANIFEST)) {
      requireThat(prior.length === 0, "RESUME_BINDING_MISSING");
      await encryptedJson(directory, BINDING, { binding_sha256: binding }, withKey);
    }
    const hasBinding = !prior.includes(MANIFEST) || prior.includes(BINDING);
    const parts = [];
    const coverage = { counts: snapshot.tables.map(() => 0) };
    const allSql = createHash("sha256");
    let partBytes = 0;
    let ranges = [];
    async function finishPart() {
      if (!file) return;
      fsyncSync(file.fd); closeSync(file.fd); file.fd = null;
      const sql = stableFile(file.path, maxPartBytes - ENVELOPE_BYTES);
      const index = parts.length + 1;
      requireThat(index <= MAX_PARTS, "TOO_MANY_PARTS");
      const name = filename(index);
      const path = join(directory, name);
      let skipped = false;
      if (prior.includes(name)) {
        // The fresh frozen stream, rather than an unauthenticated progress
        // journal, supplies the expected bytes for a resumed prefix.
        const plaintextFile = file;
        removeTemporary(plaintextFile); file = null;
        await withKey((key) => withDecryptedRecoveryArtifact(path, directory, key, (plaintext) => {
          const existing = stableFile(plaintext, maxPartBytes - ENVELOPE_BYTES);
          requireThat(canonical(existing) === canonical(sql), "RESUME_PART_MISMATCH");
        }));
        skipped = true;
      } else {
        await withKey((key) => encryptRecoveryArtifact(file.path, path, key));
        removeTemporary(file); file = null;
        // Exact decryption/readback precedes a verified-part event.
        await withKey((key) => withDecryptedRecoveryArtifact(path, directory, key, (plaintext) => {
          requireThat(canonical(stableFile(plaintext, maxPartBytes - ENVELOPE_BYTES)) === canonical(sql),
            "PART_PLAINTEXT_MISMATCH");
        }));
      }
      const cipher = stableFile(path, maxPartBytes);
      requireThat(cipher.bytes === sql.bytes + ENVELOPE_BYTES, "PART_SIZE_INVALID");
      parts.push({ index, name, bytes: cipher.bytes, sha256: cipher.sha256,
        sql_bytes: sql.bytes, sql_sha256: sql.sha256, coverage: ranges });
      partBytes = 0; ranges = [];
      await onPartVerified(Object.freeze({ index, skipped }));
    }
    for await (const unit of openUnits()) {
      requireThat(exact(unit, ["sql", "coverage"]) && Buffer.isBuffer(unit.sql) &&
        integer(unit.sql.length, 1, maxPartBytes - ENVELOPE_BYTES), "SQL_UNIT_TOO_LARGE_OR_INVALID");
      addCoverage(coverage, unit.coverage, snapshot.tables);
      if (partBytes + unit.sql.length > maxPartBytes - ENVELOPE_BYTES) await finishPart();
      if (!file) file = temporary(directory);
      writeAll(file.fd, unit.sql);
      allSql.update(unit.sql);
      partBytes += unit.sql.length;
      // Merge as rows arrive: a multi-million-row part must not retain one
      // JavaScript object for every row merely to describe a contiguous range.
      appendCoverage(ranges, unit.coverage);
    }
    await finishPart();
    const manifest = manifestValue({ format: "financial_brain_recovery_multipart_v1",
      source_resource_fingerprint: sourceResourceFingerprint, snapshot, max_part_bytes: maxPartBytes,
      part_count: parts.length, parts, sql_sha256: allSql.digest("hex"), binding_sha256: binding });
    exactInventory(directory, [LOCK, ...(hasBinding ? [BINDING] : []), ...parts.map(({ name }) => name), ...(prior.includes(MANIFEST) ? [MANIFEST] : [])]);
    const consume = async (callback) => {
      requireThat(typeof callback === "function", "VERIFIER_INVALID");
      await consumeParts(directory, manifest, withKey, callback);
    };
    let verified = false;
    const readback = await inspectExport(async (callback) => { await consume(callback); verified = true; });
    requireThat(verified, "EXPORT_VERIFIER_NOT_REACHED");
    sameSnapshot(readback, snapshot, "EXPORT_FINGERPRINT_MISMATCH");
    sameSnapshot(await inspectSource(), snapshot, "SOURCE_CHANGED");
    if (prior.includes(MANIFEST)) {
      const previousHash = stableFile(join(directory, MANIFEST), MAX_MANIFEST_BYTES).sha256;
      requireThat(canonical(await readManifest(directory, previousHash, withKey)) === canonical(manifest), "RESUME_MANIFEST_MISMATCH");
    } else await encryptedJson(directory, MANIFEST, manifest, withKey);
    const encryptedManifest = stableFile(join(directory, MANIFEST), MAX_MANIFEST_BYTES);
    requireThat(canonical(await readManifest(directory, encryptedManifest.sha256, withKey)) === canonical(manifest),
      "MANIFEST_READBACK_MISMATCH");
    await consumeParts(directory, manifest, withKey, async () => {});
    exactInventory(directory, [LOCK, MANIFEST, ...(hasBinding ? [BINDING] : []), ...parts.map(({ name }) => name)]);
    if (hasBinding) { stableFile(join(directory, BINDING), MAX_MANIFEST_BYTES); unlinkSync(join(directory, BINDING)); }
    exactInventory(directory, [LOCK, MANIFEST, ...parts.map(({ name }) => name)]);
    syncDirectory(directory);
    return Object.freeze({ manifest_sha256: encryptedManifest.sha256, part_count: parts.length,
      artifact_bytes: parts.reduce((sum, part) => sum + part.bytes, encryptedManifest.bytes),
      binding_sha256: binding });
  } finally {
    if (file) removeTemporary(file);
    rmdirSync(lock);
    syncDirectory(directory);
  }
}

/**
 * Only a freshly empty named disposable may receive ordered imports. A lost
 * import leaves a partial target for inspection; this API never clears or
 * retries that database. A subsequent restore needs another empty target.
 * inspectTarget must read identity, actual table count and final normalized
 * snapshot from the exact target. importPart may write only to that target.
 */
export async function restoreMultipartRecovery({ directory, expectedManifestSha256, target: inputTarget,
  inspectTarget, importPart, withKey,
}) {
  requireThat([inspectTarget, importPart, withKey].every((fn) => typeof fn === "function") &&
    exact(inputTarget, ["name", "resource_fingerprint"]) &&
    typeof inputTarget.name === "string" && /^recovery-gate-[a-z0-9][a-z0-9-]{2,63}$/.test(inputTarget.name) &&
    digest(inputTarget.resource_fingerprint), "TARGET_NOT_EXPLICIT_DISPOSABLE");
  const target = { ...inputTarget };
  privateDirectory(directory);
  assertNoRecoveryArtifactResidue(directory);
  const lock = join(directory, LOCK);
  try { mkdirSync(lock, { mode: 0o700 }); } catch { refuse("SET_BUSY_OR_INTERRUPTED"); }
  try {
    const manifest = await readManifest(directory, expectedManifestSha256, withKey);
    requireThat(target.resource_fingerprint !== manifest.source_resource_fingerprint, "TARGET_IS_SOURCE");
    const inventory = [LOCK, MANIFEST, ...manifest.parts.map(({ name }) => name)];
    exactInventory(directory, inventory);
    // Authenticate every part and the concatenated SQL before the first import.
    await consumeParts(directory, manifest, withKey, async () => {});
    async function inspect() {
      const state = await inspectTarget();
      requireThat(state?.name === target.name && state.resource_fingerprint === target.resource_fingerprint &&
        integer(state.user_table_count), "TARGET_IDENTITY_CHANGED");
      return state;
    }
    requireThat((await inspect()).user_table_count === 0, "TARGET_NOT_EMPTY");
    let imported = 0;
    await consumeParts(directory, manifest, withKey, async (path, index) => {
      exactInventory(directory, [...inventory, basename(path)]);
      const state = await inspect();
      if (index === 1) requireThat(state.user_table_count === 0, "TARGET_NOT_EMPTY");
      await importPart(Object.freeze({ path, index, target: Object.freeze({ ...target }) }));
      imported++;
    });
    requireThat(imported === manifest.part_count, "IMPORT_INCOMPLETE");
    const final = await inspect();
    sameSnapshot(final.snapshot, manifest.snapshot, "TARGET_FINGERPRINT_MISMATCH");
    exactInventory(directory, inventory);
    await consumeParts(directory, manifest, withKey, async () => {});
    requireThat(stableFile(join(directory, MANIFEST), MAX_MANIFEST_BYTES).sha256 === expectedManifestSha256,
      "MANIFEST_CHANGED");
    return Object.freeze({ import_completed: true, part_count: imported, manifest_sha256: expectedManifestSha256,
      ...manifest.snapshot });
  } finally { rmdirSync(lock); syncDirectory(directory); }
}

/** Authenticate the exact set for the adapter's separately journaled verify stage. */
export async function inspectMultipartRecovery({ directory, expectedManifestSha256, withKey, inspectExport }) {
  privateDirectory(directory);
  assertNoRecoveryArtifactResidue(directory);
  const manifest = await readManifest(directory, expectedManifestSha256, withKey);
  exactInventory(directory, [MANIFEST, ...manifest.parts.map(({ name }) => name)]);
  let consumed = false;
  const consume = async (callback) => { await consumeParts(directory, manifest, withKey, callback); consumed = true; };
  const local = inspectExport ? await inspectExport(consume, manifest.snapshot.tables) : await consume(async () => {});
  requireThat(consumed, "EXPORT_VERIFIER_NOT_REACHED");
  exactInventory(directory, [MANIFEST, ...manifest.parts.map(({ name }) => name)]);
  requireThat(stableFile(join(directory, MANIFEST), MAX_MANIFEST_BYTES).sha256 === expectedManifestSha256,
    "MANIFEST_CHANGED");
  return { manifest, local, manifest_bytes: stableFile(join(directory, MANIFEST), MAX_MANIFEST_BYTES).bytes };
}
