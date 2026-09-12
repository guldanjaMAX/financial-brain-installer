/**
 * Stable content fingerprints for one normalized D1 data export.
 *
 * The caller owns the Cloudflare transport and the temporary file lifecycle.
 * This module owns only the byte contract: a reviewed normalized
 * `install_state` prefix followed by one direct Wrangler D1 data export. It
 * never resolves credentials, invokes Wrangler, reads a manifest, or removes a
 * file. Both the recovery adapter and the synthetic field seeder use this
 * exact implementation so their fingerprints cannot drift semantically.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export class RecoveryContentFingerprintError extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryContentFingerprintError";
    this.code = code;
  }
}

function refuse(code) {
  throw new RecoveryContentFingerprintError(code);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

function assertMaximum(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_BYTES) {
    refuse("RECOVERY_CONTENT_FINGERPRINT_LIMIT_INVALID");
  }
  return value;
}

function assertStableExport(path, maxBytes) {
  if (typeof path !== "string" || !path || !isAbsolute(path)) {
    refuse("RECOVERY_CONTENT_EXPORT_PATH_INVALID");
  }
  const absolute = resolve(path);
  let info;
  try { info = lstatSync(absolute); } catch {
    refuse("RECOVERY_CONTENT_EXPORT_INVALID");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.size > maxBytes || realpathSync(absolute) !== absolute ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    refuse("RECOVERY_CONTENT_EXPORT_INVALID");
  }
  return Object.freeze({ path: absolute, info });
}

function assertPreparedExportPath(path, prefix, maxBytes) {
  if (!Buffer.isBuffer(prefix) || typeof path !== "string" || !path || !isAbsolute(path)) {
    refuse("RECOVERY_CONTENT_FINGERPRINT_DEPENDENCIES_INVALID");
  }
  const absolute = resolve(path);
  if (absolute !== path || prefix.length > maxBytes) {
    refuse("RECOVERY_CONTENT_EXPORT_PATH_INVALID");
  }
  const parentPath = dirname(absolute);
  let parent;
  try {
    parent = lstatSync(parentPath);
    lstatSync(absolute);
    refuse("RECOVERY_CONTENT_EXPORT_ALREADY_EXISTS");
  } catch (error) {
    if (error instanceof RecoveryContentFingerprintError) throw error;
    if (error?.code !== "ENOENT") refuse("RECOVERY_CONTENT_EXPORT_PATH_INVALID");
  }
  if (!parent?.isDirectory() || parent.isSymbolicLink() ||
      realpathSync(parentPath) !== parentPath ||
      (typeof process.getuid === "function" && parent.uid !== process.getuid()) ||
      (process.platform !== "win32" && (parent.mode & 0o077) !== 0)) {
    refuse("RECOVERY_CONTENT_EXPORT_PARENT_INVALID");
  }
  return Object.freeze({ path: absolute, parentPath, parent });
}

function assertExportRemoved(prepared) {
  let parent;
  try {
    parent = lstatSync(prepared.parentPath);
    lstatSync(prepared.path);
    refuse("RECOVERY_CONTENT_EXPORT_CLEANUP_FAILED");
  } catch (error) {
    if (error instanceof RecoveryContentFingerprintError) throw error;
    if (error?.code !== "ENOENT") refuse("RECOVERY_CONTENT_EXPORT_CLEANUP_FAILED");
  }
  if (!parent?.isDirectory() || parent.isSymbolicLink() ||
      !sameInode(parent, prepared.parent) || realpathSync(prepared.parentPath) !== prepared.parentPath ||
      (typeof process.getuid === "function" && parent.uid !== process.getuid()) ||
      (process.platform !== "win32" && (parent.mode & 0o077) !== 0)) {
    refuse("RECOVERY_CONTENT_EXPORT_PARENT_CHANGED");
  }
  return true;
}

/** Hash the exact normalized prefix followed by one stable direct D1 export. */
export function hashNormalizedRecoveryDataExport(
  normalizedInstallState,
  exportPath,
  maxBytes = DEFAULT_MAX_BYTES,
) {
  if (!Buffer.isBuffer(normalizedInstallState)) {
    refuse("RECOVERY_CONTENT_PREFIX_INVALID");
  }
  const maximum = assertMaximum(maxBytes);
  const checked = assertStableExport(exportPath, maximum);
  if (normalizedInstallState.length + checked.info.size > maximum) {
    refuse("RECOVERY_CONTENT_EXPORT_TOO_LARGE");
  }

  let descriptor;
  try {
    descriptor = openSync(
      checked.path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) {
      refuse("RECOVERY_CONTENT_EXPORT_CHANGED");
    }
    const hasher = createHash("sha256").update(normalizedInstallState);
    const block = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const read = readSync(descriptor, block, 0, block.length, null);
        if (!read) break;
        hasher.update(block.subarray(0, read));
      }
    } finally {
      block.fill(0);
    }
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      refuse("RECOVERY_CONTENT_EXPORT_CHANGED");
    }
    return hasher.digest("hex");
  } catch (error) {
    if (error instanceof RecoveryContentFingerprintError) throw error;
    refuse("RECOVERY_CONTENT_EXPORT_READ_FAILED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Capture one direct D1 fingerprint through caller-supplied transport hooks.
 * The export callback must create `exportPath`. Successful captures always
 * clean up. Ambiguous failures retain residue by default; only a caller that
 * owns a separate retry journal may select fixed failure cleanup. The
 * normalized prefix is always wiped.
 */
export async function captureDirectD1ContentFingerprint({
  normalizedInstallState,
  exportPath,
  exportData,
  cleanupExport,
  maxBytes = DEFAULT_MAX_BYTES,
  cleanupOnFailure = false,
}) {
  if (!Buffer.isBuffer(normalizedInstallState) ||
      typeof exportData !== "function" || typeof cleanupExport !== "function" ||
      typeof cleanupOnFailure !== "boolean") {
    refuse("RECOVERY_CONTENT_FINGERPRINT_DEPENDENCIES_INVALID");
  }
  let prepared = null;
  let captured = false;
  try {
    const maximum = assertMaximum(maxBytes);
    prepared = assertPreparedExportPath(
      exportPath,
      normalizedInstallState,
      maximum,
    );
    await exportData(prepared.path);
    const fingerprint = hashNormalizedRecoveryDataExport(
      normalizedInstallState,
      prepared.path,
      maximum,
    );
    captured = true;
    await cleanupExport(prepared.path);
    assertExportRemoved(prepared);
    return fingerprint;
  } catch (error) {
    if (prepared && !captured && cleanupOnFailure) {
      await cleanupExport(prepared.path);
      assertExportRemoved(prepared);
    }
    throw error;
  } finally {
    normalizedInstallState.fill(0);
  }
}
