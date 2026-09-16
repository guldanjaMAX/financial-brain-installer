/**
 * Recompute the complete reviewed D1 deletion-state fingerprint immediately
 * before a disposable database can be deleted.
 *
 * Cloudflare authority stays in the caller's already approved Wrangler wrapper.
 * This module chooses every Wrangler argument, owns the private export file, and
 * hashes raw durable, security, queue, and FTS-shadow state, and returns only
 * the SHA-256 that the teardown coordinator compares privately.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  MIGRATION_CONTRACT_SQL,
  RECOVERY_DURABLE_TABLES,
  validateMigrationContract,
} from "./cloudflare-recovery-adapter.mjs";
import {
  V048_D1_DELETION_STATE_FTS_COUNT_SQL,
  V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  V048_D1_DELETION_STATE_INVENTORY_SQL,
  V048_D1_DELETION_STATE_KIND,
  V048_D1_DELETION_STATE_MAX_EXPORT_BYTES,
  V048_D1_DELETION_STATE_SCHEMA_SQL,
  V048_D1_DELETION_STATE_SEQUENCE_SQL,
  fingerprintV048D1DeletionState,
  normalizeV048D1DeletionStateSequences as normalizeSharedV048D1DeletionStateSequences,
} from "./v048-d1-deletion-state-contract.mjs";

export const V048_TEARDOWN_D1_CONTENT_MAX_BYTES =
  V048_D1_DELETION_STATE_MAX_EXPORT_BYTES;
export const V048_TEARDOWN_D1_WRANGLER_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const V048_TEARDOWN_D1_TEMPORARY_PREFIX = "v048-teardown-d1-proof-";
export const V048_TEARDOWN_D1_EXPORT_NAME = "d1-content.sql";

export const V048_D1_DELETION_QUICK_CHECK_SQL = "PRAGMA quick_check";
export {
  V048_D1_DELETION_STATE_FTS_COUNT_SQL,
  V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  V048_D1_DELETION_STATE_INVENTORY_SQL,
  V048_D1_DELETION_STATE_KIND,
  V048_D1_DELETION_STATE_MAX_EXPORT_BYTES,
  V048_D1_DELETION_STATE_SCHEMA_SQL,
  V048_D1_DELETION_STATE_SEQUENCE_SQL,
};

const V048_SCHEMA_VERSION = 46;
const DATABASE_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const DATABASE_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export class V048TeardownD1ContentProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048TeardownD1ContentProofError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048TeardownD1ContentProofError(code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactObjectKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) {
    refuse(code);
  }
}

function exactText(value, code, {
  allowNull = false,
  allowEmpty = false,
  allowControls = false,
} = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || (!allowEmpty && !value) ||
      value.length > 1024 * 1024 || value.includes("\0") ||
      (!allowControls && CONTROL_RE.test(value))) {
    refuse(code);
  }
  return value;
}

function nonNegativeInteger(value, code) {
  const normalized = typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) refuse(code);
  return normalized;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ownedByCurrentUser(info) {
  const uid = currentUid();
  return uid === null || info?.uid === uid;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.nlink === right?.nlink && left?.uid === right?.uid && left?.gid === right?.gid;
}

function sameDirectoryIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.uid === right?.uid && left?.gid === right?.gid;
}

function sameStableFile(left, right) {
  return sameIdentity(left, right) && left?.size === right?.size &&
    left?.mode === right?.mode && left?.mtimeMs === right?.mtimeMs &&
    left?.ctimeMs === right?.ctimeMs;
}

function assertPrivateDirectory(path, expected = null) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    refuse("V048_TEARDOWN_D1_TEMPORARY_DIRECTORY_UNSAFE");
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info) ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o700)) {
    refuse("V048_TEARDOWN_D1_TEMPORARY_DIRECTORY_UNSAFE");
  }
  let canonical;
  let followed;
  try {
    canonical = realpathSync(path);
    followed = statSync(canonical);
  } catch {
    refuse("V048_TEARDOWN_D1_TEMPORARY_DIRECTORY_UNSAFE");
  }
  if (followed.dev !== info.dev || followed.ino !== info.ino ||
      (expected && !sameStableFile(expected, info))) {
    refuse("V048_TEARDOWN_D1_TEMPORARY_DIRECTORY_CHANGED");
  }
  return info;
}

function createPrivateExport(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() ||
        opened.nlink !== 1 || !sameStableFile(opened, current) ||
        !ownedByCurrentUser(opened) || opened.size !== 0 ||
        (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600)) {
      refuse("V048_TEARDOWN_D1_EXPORT_UNSAFE");
    }
    return opened;
  } catch (error) {
    if (error instanceof V048TeardownD1ContentProofError) throw error;
    refuse("V048_TEARDOWN_D1_EXPORT_UNSAFE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertExportAfterWrangler(path, created) {
  let current;
  try {
    current = lstatSync(path);
  } catch {
    refuse("V048_TEARDOWN_D1_EXPORT_UNSAFE");
  }
  if (current.size > V048_TEARDOWN_D1_CONTENT_MAX_BYTES) {
    refuse("V048_TEARDOWN_D1_EXPORT_TOO_LARGE");
  }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      !ownedByCurrentUser(current) || !sameIdentity(created, current) ||
      (process.platform !== "win32" && (current.mode & 0o777) !== 0o600)) {
    refuse("V048_TEARDOWN_D1_EXPORT_UNSAFE");
  }
  return current;
}

function hashStableExport(prefix, path, expected) {
  if (!Buffer.isBuffer(prefix)) refuse("V048_TEARDOWN_D1_CONTENT_INVALID");
  if (prefix.length + expected.size > V048_TEARDOWN_D1_CONTENT_MAX_BYTES) {
    refuse("V048_TEARDOWN_D1_EXPORT_TOO_LARGE");
  }
  let descriptor;
  let block;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameStableFile(expected, opened)) refuse("V048_TEARDOWN_D1_EXPORT_CHANGED");
    const hasher = createHash("sha256").update(prefix);
    block = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, block, 0, block.length, null);
      if (!count) break;
      bytes += count;
      if (prefix.length + bytes > V048_TEARDOWN_D1_CONTENT_MAX_BYTES) {
        refuse("V048_TEARDOWN_D1_EXPORT_TOO_LARGE");
      }
      hasher.update(block.subarray(0, count));
    }
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (bytes !== opened.size || !sameStableFile(opened, afterDescriptor) ||
        !sameStableFile(opened, afterPath)) {
      refuse("V048_TEARDOWN_D1_EXPORT_CHANGED");
    }
    return Object.freeze({
      sha256: hasher.digest("hex"),
      bytes,
    });
  } catch (error) {
    if (error instanceof V048TeardownD1ContentProofError) throw error;
    refuse("V048_TEARDOWN_D1_EXPORT_UNSAFE");
  } finally {
    if (block) block.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function d1RowsFromJson(output) {
  if (!Buffer.isBuffer(output) || output.length < 2 ||
      output.length > V048_TEARDOWN_D1_WRANGLER_OUTPUT_MAX_BYTES) {
    refuse("V048_TEARDOWN_D1_WRANGLER_OUTPUT_INVALID");
  }
  const copy = Buffer.from(output);
  try {
    let payload;
    try {
      payload = JSON.parse(copy.toString("utf8"));
    } catch {
      refuse("V048_TEARDOWN_D1_RESPONSE_INVALID");
    }
    const envelopes = Array.isArray(payload) ? payload : [payload];
    if (envelopes.length !== 1 || !envelopes[0] ||
        typeof envelopes[0] !== "object" || Array.isArray(envelopes[0]) ||
        envelopes[0].success === false || !Array.isArray(envelopes[0].results)) {
      refuse("V048_TEARDOWN_D1_RESPONSE_INVALID");
    }
    return envelopes[0].results;
  } finally {
    copy.fill(0);
  }
}

async function invokeWrangler(runWrangler, args, { json = false } = {}) {
  let output;
  try {
    output = await runWrangler(Object.freeze([...args]));
  } catch {
    refuse("V048_TEARDOWN_D1_WRANGLER_CALL_FAILED");
  }
  if (!Buffer.isBuffer(output) ||
      output.length > V048_TEARDOWN_D1_WRANGLER_OUTPUT_MAX_BYTES) {
    refuse("V048_TEARDOWN_D1_WRANGLER_OUTPUT_INVALID");
  }
  return json ? d1RowsFromJson(output) : null;
}

async function d1Rows(binding, runWrangler, sql) {
  return invokeWrangler(runWrangler, [
    "d1", "execute", binding.databaseId,
    "--remote", "--command", sql, "--json",
  ], { json: true });
}

function validateBinding(binding, runWrangler) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      !DATABASE_NAME_RE.test(String(binding.databaseName || "")) ||
      !ACCOUNT_ID_RE.test(String(binding.accountId || "")) ||
      !DATABASE_ID_RE.test(String(binding.databaseId || "")) ||
      !new Set(["source", "target"]).has(binding.role) ||
      typeof runWrangler !== "function") {
    refuse("V048_TEARDOWN_D1_CAPTURE_INPUT_INVALID");
  }
  return Object.freeze({
    role: binding.role,
    accountId: binding.accountId,
    databaseId: binding.databaseId,
    databaseName: binding.databaseName,
  });
}

function normalizeQuickCheck(rows) {
  const code = "V048_TEARDOWN_D1_QUICK_CHECK_INVALID";
  if (!Array.isArray(rows) || rows.length !== 1) refuse(code);
  exactObjectKeys(rows[0], ["quick_check"], code);
  if (rows[0].quick_check !== "ok") refuse(code);
  return "ok";
}

function normalizeTableInventory(rows) {
  const code = "V048_TEARDOWN_D1_TABLE_INVENTORY_INVALID";
  if (!Array.isArray(rows)) refuse(code);
  const names = rows.map((row) => {
    exactObjectKeys(row, ["name"], code);
    return exactText(row.name, code);
  });
  const expected = [
    ...RECOVERY_DURABLE_TABLES,
    "chunks_fts",
    ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  ].sort();
  if (canonical(names) !== canonical(expected)) refuse(code);
  return Object.freeze(names);
}

function normalizeLogicalSchema(rows) {
  const code = "V048_TEARDOWN_D1_LOGICAL_SCHEMA_INVALID";
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4096) refuse(code);
  const normalized = rows.map((row) => {
    exactObjectKeys(row, ["type", "name", "tbl_name", "sql"], code);
    const type = exactText(row.type, code);
    if (!new Set(["index", "table", "trigger", "view"]).has(type)) refuse(code);
    return Object.freeze({
      type,
      name: exactText(row.name, code),
      tbl_name: exactText(row.tbl_name, code),
      sql: exactText(row.sql, code, { allowNull: true, allowControls: true }),
    });
  });
  const ordered = [...normalized].sort((left, right) =>
    (left.type < right.type ? -1 : left.type > right.type ? 1 : 0) ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
      (left.tbl_name < right.tbl_name ? -1 : left.tbl_name > right.tbl_name ? 1 : 0));
  if (canonical(normalized) !== canonical(ordered)) refuse(code);
  return Object.freeze(normalized);
}

function normalizeSequences(rows, inventory) {
  try {
    return normalizeSharedV048D1DeletionStateSequences(rows, inventory);
  } catch {
    refuse("V048_TEARDOWN_D1_SEQUENCE_INVALID");
  }
}

function normalizeFtsCount(rows) {
  const code = "V048_TEARDOWN_D1_FTS_COUNT_INVALID";
  if (!Array.isArray(rows) || rows.length !== 1) refuse(code);
  exactObjectKeys(rows[0], ["fts_count"], code);
  return nonNegativeInteger(rows[0].fts_count, code);
}

function cleanupPrivateDirectory(directory, createdDirectory) {
  let current;
  try {
    current = lstatSync(directory);
  } catch {
    refuse("V048_TEARDOWN_D1_TEMPORARY_CLEANUP_FAILED");
  }
  if (!current.isDirectory() || current.isSymbolicLink() ||
      !sameDirectoryIdentity(createdDirectory, current) || !ownedByCurrentUser(current) ||
      (process.platform !== "win32" && (current.mode & 0o777) !== 0o700)) {
    refuse("V048_TEARDOWN_D1_TEMPORARY_CLEANUP_FAILED");
  }
  try {
    rmSync(directory, { recursive: true, force: false });
  } catch {
    refuse("V048_TEARDOWN_D1_TEMPORARY_CLEANUP_FAILED");
  }
}

/**
 * Return the v048_d1_deletion_state_v1 SHA-256 for one exact schema-46 D1.
 *
 * `runWrangler(args)` must execute the already approved wrapper in its standard
 * argv mode and resolve with a bounded Buffer containing stdout. The caller owns
 * that Buffer; this helper never changes it. A rejected or nonzero child must be
 * rejected by the caller rather than represented as successful output.
 */
export async function captureV048TeardownD1DeletionStateFingerprint({
  binding,
  runWrangler,
} = {}) {
  const checkedBinding = validateBinding(binding, runWrangler);
  const temporaryParent = resolve(tmpdir());
  let directory;
  let createdDirectory;
  let result;
  let failure = null;
  try {
    directory = resolve(mkdtempSync(join(tmpdir(), V048_TEARDOWN_D1_TEMPORARY_PREFIX)));
    // Pin the inode immediately. No recursive cleanup is permitted until this
    // exact directory identity is known.
    createdDirectory = assertPrivateDirectory(directory);
    if (dirname(directory) !== temporaryParent ||
        !basename(directory).startsWith(V048_TEARDOWN_D1_TEMPORARY_PREFIX)) {
      refuse("V048_TEARDOWN_D1_TEMPORARY_DIRECTORY_UNSAFE");
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    createdDirectory = assertPrivateDirectory(directory);
    const exportPath = join(directory, V048_TEARDOWN_D1_EXPORT_NAME);
    const createdExport = createPrivateExport(exportPath);
    createdDirectory = assertPrivateDirectory(directory);

    let migrations;
    try {
      migrations = validateMigrationContract(
        await d1Rows(checkedBinding, runWrangler, MIGRATION_CONTRACT_SQL),
      );
    } catch (error) {
      if (error instanceof V048TeardownD1ContentProofError) throw error;
      refuse("V048_TEARDOWN_D1_MIGRATION_CONTRACT_INVALID");
    }
    if (migrations.length !== V048_SCHEMA_VERSION ||
        migrations.at(-1)?.version !== V048_SCHEMA_VERSION) {
      refuse("V048_TEARDOWN_D1_MIGRATION_CONTRACT_INVALID");
    }

    const quickCheck = normalizeQuickCheck(await d1Rows(
      checkedBinding,
      runWrangler,
      V048_D1_DELETION_QUICK_CHECK_SQL,
    ));
    const inventory = normalizeTableInventory(await d1Rows(
      checkedBinding,
      runWrangler,
      V048_D1_DELETION_STATE_INVENTORY_SQL,
    ));
    const schemaRows = normalizeLogicalSchema(await d1Rows(
      checkedBinding,
      runWrangler,
      V048_D1_DELETION_STATE_SCHEMA_SQL,
    ));
    const sequenceRows = normalizeSequences(await d1Rows(
      checkedBinding,
      runWrangler,
      V048_D1_DELETION_STATE_SEQUENCE_SQL,
    ), inventory);
    const ftsCount = normalizeFtsCount(await d1Rows(
      checkedBinding,
      runWrangler,
      V048_D1_DELETION_STATE_FTS_COUNT_SQL,
    ));

    await invokeWrangler(runWrangler, [
      "d1", "export", checkedBinding.databaseId,
      "--remote", "--no-schema", "--output", exportPath,
      ...[
        ...RECOVERY_DURABLE_TABLES,
        ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
      ].flatMap((table) => ["--table", table]),
    ]);
    const exported = assertExportAfterWrangler(exportPath, createdExport);
    assertPrivateDirectory(directory, createdDirectory);
    const children = readdirSync(directory);
    if (children.length !== 1 || children[0] !== V048_TEARDOWN_D1_EXPORT_NAME) {
      refuse("V048_TEARDOWN_D1_TEMPORARY_DIRECTORY_CHANGED");
    }
    const durableExport = hashStableExport(Buffer.alloc(0), exportPath, exported);
    try {
      result = fingerprintV048D1DeletionState({
        role: checkedBinding.role,
        binding: {
          account_id: checkedBinding.accountId,
          database_id: checkedBinding.databaseId,
          database_name: checkedBinding.databaseName,
        },
        migrations: migrations.map(({ version, name, checksum }) => ({
          version,
          name,
          checksum,
        })),
        quickCheck,
        inventory,
        schemaRows,
        durableExportSha256: durableExport.sha256,
        durableExportBytes: durableExport.bytes,
        sequenceRows,
        ftsCount,
      });
    } catch {
      refuse("V048_TEARDOWN_D1_DELETION_STATE_INVALID");
    }
    assertPrivateDirectory(directory, createdDirectory);
  } catch (error) {
    failure = error;
  } finally {
    if (directory && createdDirectory) {
      try {
        cleanupPrivateDirectory(directory, createdDirectory);
      } catch (cleanupError) {
        failure = cleanupError;
      }
    }
  }
  if (failure) {
    if (failure instanceof V048TeardownD1ContentProofError) throw failure;
    refuse("V048_TEARDOWN_D1_CONTENT_CAPTURE_FAILED");
  }
  return result;
}

// Backward-compatible name for the teardown coordinator while the more exact
// deletion-state terminology propagates through its private proof plumbing.
export const captureV048TeardownD1ContentFingerprint =
  captureV048TeardownD1DeletionStateFingerprint;
