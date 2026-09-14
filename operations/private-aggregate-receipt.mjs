/**
 * Durable, owner-only aggregate receipt writes for supervised field gates.
 *
 * The final path is reserved before any external mutation. Finalization keeps
 * the staged descriptor open through rename, exact readback, and the directory
 * durability barrier. Native Windows is refused because mode bits and uid do
 * not prove a current-user-only DACL, and this helper has no DACL verifier.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_FINALIZATION_COMMIT_BYTES = 4 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const FINALIZATION_COMMIT_KIND = "private_aggregate_receipt_finalization_commit";
const MAX_ACL_INSPECTION_BYTES = 64 * 1024;
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM",
]);

export class PrivateAggregateReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = "PrivateAggregateReceiptError";
    this.code = code;
  }
}

function refuse(code) {
  throw new PrivateAggregateReceiptError(code);
}

function assertSupportedReceiptPlatform(platform, code) {
  if (platform === "win32" || process.platform === "win32") refuse(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.size === right?.size && left?.mtimeMs === right?.mtimeMs;
}

function sameSingleFileIdentity(left, right) {
  return left?.isFile?.() === true && right?.isFile?.() === true &&
    left.nlink === 1 && right.nlink === 1 && sameFile(left, right);
}

function sameStableSingleFile(left, right) {
  return sameSingleFileIdentity(left, right) && left.ctimeMs === right.ctimeMs;
}

function sameStableDirectory(left, right) {
  return left?.isDirectory?.() === true && right?.isDirectory?.() === true &&
    sameFile(left, right) && left.ctimeMs === right.ctimeMs;
}

function sameInode(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function assertOwner(info, code) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) refuse(code);
}

function assertPrivateDirectoryInfo(info, expectedInfo, code, platform = process.platform) {
  if (!info?.isDirectory?.() || info.isSymbolicLink?.() ||
      !sameInode(info, expectedInfo) ||
      (platform !== "win32" && (info.mode & 0o077) !== 0)) refuse(code);
  assertOwner(info, code);
  return info;
}

function assertBoundPrivateDirectory(path, expectedInfo, code, {
  platform = process.platform,
} = {}) {
  const absolute = resolve(path);
  let info;
  try { info = lstatSync(absolute); } catch { refuse(code); }
  assertPrivateDirectoryInfo(info, expectedInfo, code, platform);
  if (realpathSync(absolute) !== absolute) refuse(code);
  info = assertNoDarwinAcl(absolute, info, code, { platform });
  return assertPrivateDirectoryInfo(info, expectedInfo, code, platform);
}

function assertNoDarwinAcl(path, expectedInfo, code, {
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (platform !== "darwin") return expectedInfo;
  let before;
  let after;
  let stdout;
  let stderr;
  try {
    before = lstatSync(path);
    const stableBefore = expectedInfo?.isDirectory?.()
      ? sameStableDirectory(expectedInfo, before)
      : sameStableSingleFile(expectedInfo, before);
    if (!stableBefore) refuse(code);
    const result = run(
      "/bin/ls",
      ["-ldebn", path],
      {
        cwd: "/",
        encoding: null,
        env: { LANG: "C", LC_ALL: "C" },
        maxBuffer: MAX_ACL_INSPECTION_BYTES,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stderr.length !== 0 ||
        stdout.length < 2 || stdout.length > MAX_ACL_INSPECTION_BYTES ||
        stdout.at(-1) !== 0x0a || stdout.subarray(0, -1).includes(0x0a)) {
      refuse(code);
    }
    const firstSpace = stdout.indexOf(0x20);
    if (firstSpace < 10 || stdout.subarray(0, firstSpace).includes(0x2b)) refuse(code);
    after = lstatSync(path);
    const stableAfter = before.isDirectory()
      ? sameStableDirectory(before, after)
      : sameStableSingleFile(before, after);
    if (!stableAfter) refuse(code);
    return after;
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (Buffer.isBuffer(stdout)) stdout.fill(0);
    if (Buffer.isBuffer(stderr)) stderr.fill(0);
  }
}

/** Fail closed on a macOS extended ACL without exposing the inspected path. */
export function assertNoDarwinReceiptAcl(path, expectedInfo, {
  code = "PRIVATE_AGGREGATE_RECEIPT_ACL_REFUSED",
  run = spawnSync,
} = {}) {
  return assertNoDarwinAcl(path, expectedInfo, code, {
    platform: process.platform,
    run,
  });
}

function assertPrivateEmptyReceiptFile(path, descriptor, code, platform = process.platform) {
  fchmodSync(descriptor, 0o600);
  let opened;
  let current;
  try {
    opened = fstatSync(descriptor);
    current = lstatSync(path);
  } catch { refuse(code); }
  if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 0 ||
      (platform !== "win32" && (opened.mode & 0o077) !== 0) ||
      !sameStableSingleFile(opened, current)) refuse(code);
  assertOwner(opened, code);
  assertOwner(current, code);
  current = assertNoDarwinAcl(path, current, code, { platform });
  const openedAfter = fstatSync(descriptor);
  if (!sameStableSingleFile(current, openedAfter) || openedAfter.size !== 0 ||
      (platform !== "win32" && (openedAfter.mode & 0o077) !== 0)) refuse(code);
  assertOwner(openedAfter, code);
  return openedAfter;
}

function assertPrivateDirectory(path, code) {
  const absolute = resolve(path);
  let info;
  try { info = lstatSync(absolute); } catch { refuse(code); }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(absolute) !== absolute ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)) refuse(code);
  assertOwner(info, code);
  info = assertNoDarwinAcl(absolute, info, code);
  return Object.freeze({ path: absolute, info });
}

/** Prove one existing receipt directory is private without changing its ACL. */
export function assertPrivateAggregateReceiptDirectory(path, {
  code = "PRIVATE_AGGREGATE_RECEIPT_PARENT_REFUSED",
} = {}) {
  assertSupportedReceiptPlatform(process.platform, code);
  return assertPrivateDirectory(path, code);
}

/** Prove a newly opened receipt file is empty and private before any write. */
export function assertPrivateAggregateEmptyReceiptFile(path, descriptor, {
  code = "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID",
  platform = process.platform,
} = {}) {
  assertSupportedReceiptPlatform(platform, code);
  if (!isAbsolute(path || "") || !Number.isSafeInteger(descriptor)) refuse(code);
  return assertPrivateEmptyReceiptFile(resolve(path), descriptor, code, platform);
}

function pendingReceiptPath(path) {
  return path.endsWith(".json")
    ? `${path.slice(0, -5)}.pending.json`
    : `${path}.pending`;
}

function finalizationCommitPath(path) {
  return path.endsWith(".json")
    ? `${path.slice(0, -5)}.commit.json`
    : `${path}.commit`;
}

function stagedReceiptPath(path) {
  return path.endsWith(".json")
    ? `${path.slice(0, -5)}.staged.json`
    : `${path}.staged`;
}

export function privateAggregateReceiptPendingPath(path) {
  if (!isAbsolute(path || "")) {
    refuse("PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED");
  }
  return pendingReceiptPath(resolve(path));
}

export function privateAggregateReceiptCommitPath(path) {
  if (!isAbsolute(path || "")) {
    refuse("PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED");
  }
  return finalizationCommitPath(resolve(path));
}

/** Return the one deterministic private staging sibling for a final receipt. */
export function privateAggregateReceiptStagedPath(path) {
  if (!isAbsolute(path || "")) {
    refuse("PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED");
  }
  return stagedReceiptPath(resolve(path));
}

function assertPathAbsent(path, code) {
  try {
    lstatSync(path);
    refuse(code);
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    if (error?.code !== "ENOENT") refuse(code);
  }
}

function pathPresent(path, code) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    refuse(code);
  }
}

/** Validate a new absolute receipt destination and bind its private parent. */
export function assertPrivateAggregateOutputPath(path, {
  code = "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED",
} = {}) {
  assertSupportedReceiptPlatform(process.platform, code);
  if (!isAbsolute(path || "")) refuse(code);
  const absolute = resolve(path);
  const parent = assertPrivateDirectory(dirname(absolute), code);
  const pendingPath = pendingReceiptPath(absolute);
  const commitPath = finalizationCommitPath(absolute);
  const stagedPath = stagedReceiptPath(absolute);
  assertPathAbsent(absolute, "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_EXISTS");
  assertPathAbsent(pendingPath, "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_PENDING");
  assertPathAbsent(commitPath, "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_PENDING");
  assertPathAbsent(stagedPath, "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_PENDING");
  return Object.freeze({ path: absolute, pendingPath, commitPath, stagedPath, parent });
}

function windowsDirectorySyncUnsupported(error, platform) {
  return platform === "win32" && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error?.code);
}

/** Flush a POSIX directory entry after revalidating its exact identity. */
export function syncPrivateReceiptDirectory(
  directoryPath,
  expectedDirectoryInfo,
  finalPath,
  expectedFinalInfo,
  code = "PRIVATE_AGGREGATE_RECEIPT_PARENT_CHANGED",
  {
    platform = process.platform,
    openDirectoryHandle = openSync,
    statDirectoryHandle = fstatSync,
    syncDirectoryHandle = fsyncSync,
    closeDirectoryHandle = closeSync,
    openFinalHandle = openSync,
    statFinalHandle = fstatSync,
    syncFinalHandle = fsyncSync,
    closeFinalHandle = closeSync,
  } = {},
) {
  assertSupportedReceiptPlatform(platform, code);
  const absoluteDirectory = resolve(directoryPath);
  const absoluteFinal = resolve(finalPath);
  if (dirname(absoluteFinal) !== absoluteDirectory) refuse(code);
  const aclCheckedDirectory = assertBoundPrivateDirectory(
    absoluteDirectory,
    expectedDirectoryInfo,
    code,
    { platform },
  );
  let initialFinal = lstatSync(absoluteFinal);
  if (!initialFinal.isFile() || initialFinal.isSymbolicLink() || initialFinal.nlink !== 1 ||
      (expectedFinalInfo && !sameStableSingleFile(initialFinal, expectedFinalInfo))) refuse(code);
  assertOwner(initialFinal, code);
  initialFinal = assertNoDarwinAcl(absoluteFinal, initialFinal, code, { platform });

  let directoryDescriptor;
  let directoryFailure = null;
  try {
    try {
      directoryDescriptor = openDirectoryHandle(
        absoluteDirectory,
        fsConstants.O_RDONLY |
          (platform === "win32" ? 0 : (fsConstants.O_DIRECTORY || 0)) |
          (fsConstants.O_NOFOLLOW || 0),
      );
    } catch (error) {
      if (!windowsDirectorySyncUnsupported(error, platform)) throw error;
      directoryFailure = error;
    }
    if (directoryDescriptor !== undefined) {
      const opened = statDirectoryHandle(directoryDescriptor);
      assertPrivateDirectoryInfo(opened, aclCheckedDirectory, code, platform);
      try {
        syncDirectoryHandle(directoryDescriptor);
      } catch (error) {
        if (!windowsDirectorySyncUnsupported(error, platform)) throw error;
        directoryFailure = error;
      }
      if (!directoryFailure) {
        const openedAfterSync = statDirectoryHandle(directoryDescriptor);
        if (!sameStableDirectory(opened, openedAfterSync)) refuse(code);
        assertPrivateDirectoryInfo(openedAfterSync, expectedDirectoryInfo, code, platform);
        const finalDirectory = assertBoundPrivateDirectory(
          absoluteDirectory,
          expectedDirectoryInfo,
          code,
          { platform },
        );
        if (!sameStableDirectory(openedAfterSync, finalDirectory)) refuse(code);
        const finalFile = lstatSync(absoluteFinal);
        if (!sameStableSingleFile(initialFinal, finalFile)) refuse(code);
        assertNoDarwinAcl(absoluteFinal, finalFile, code, { platform });
      }
    }
  } finally {
    if (directoryDescriptor !== undefined) closeDirectoryHandle(directoryDescriptor);
  }
  if (!directoryFailure) return true;

  let finalDescriptor;
  let finalFailure = null;
  try {
    const before = lstatSync(absoluteFinal);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (expectedFinalInfo && !sameStableSingleFile(before, expectedFinalInfo))) refuse(code);
    finalDescriptor = openFinalHandle(
      absoluteFinal,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = statFinalHandle(finalDescriptor);
    if (!sameStableSingleFile(before, opened)) refuse(code);
    syncFinalHandle(finalDescriptor);
    const openedAfter = statFinalHandle(finalDescriptor);
    const finalAfter = lstatSync(absoluteFinal);
    const directoryAfter = assertBoundPrivateDirectory(
      absoluteDirectory,
      expectedDirectoryInfo,
      code,
      { platform },
    );
    if (!sameStableSingleFile(before, openedAfter) ||
        !sameStableSingleFile(before, finalAfter) ||
        !sameInode(directoryAfter, expectedDirectoryInfo)) refuse(code);
    assertNoDarwinAcl(absoluteFinal, finalAfter, code, { platform });
  } catch (error) {
    finalFailure = error;
  } finally {
    if (finalDescriptor !== undefined) {
      try { closeFinalHandle(finalDescriptor); } catch (error) { finalFailure ||= error; }
    }
  }
  if (finalFailure) throw finalFailure;
  return true;
}

export function writePrivateReceiptDescriptor(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(written) || written < 1) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_WRITE_FAILED");
    }
    offset += written;
  }
}

export function readPrivateReceiptDescriptor(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(read) || read < 1) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_READ_FAILED");
    }
    offset += read;
  }
  return bytes;
}

function assertPendingReceiptMarker(reservation, code) {
  let before;
  let descriptor;
  let bytes;
  try {
    before = lstatSync(reservation.pendingPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (process.platform !== "win32" && (before.mode & 0o077) !== 0) ||
        !sameStableSingleFile(before, reservation.pendingInfo) ||
        before.size !== reservation.markerSize) refuse(code);
    assertOwner(before, code);
    before = assertNoDarwinAcl(reservation.pendingPath, before, code);
    descriptor = openSync(
      reservation.pendingPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!sameStableSingleFile(before, opened)) refuse(code);
    bytes = Buffer.alloc(reservation.markerSize);
    readPrivateReceiptDescriptor(descriptor, bytes);
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(reservation.pendingPath);
    if (sha256(bytes) !== reservation.markerHash ||
        !sameStableSingleFile(opened, openedAfter) ||
        !sameStableSingleFile(opened, after)) refuse(code);
    return after;
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (bytes) bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertFinalReceiptForPendingCommit(
  reservation,
  expected,
  code,
  platform = process.platform,
) {
  if (!expected || !expected.info || !Number.isSafeInteger(expected.size) ||
      expected.size < 1 || expected.size > MAX_RECEIPT_BYTES ||
      !SHA256_RE.test(expected.sha256 || "")) refuse(code);
  let before;
  let descriptor;
  let bytes;
  try {
    before = lstatSync(reservation.path);
    if (!sameStableSingleFile(expected.info, before) || before.size !== expected.size ||
        before.isSymbolicLink() || (platform !== "win32" && (before.mode & 0o077) !== 0)) {
      refuse(code);
    }
    assertOwner(before, code);
    before = assertNoDarwinAcl(reservation.path, before, code, { platform });
    descriptor = openSync(
      reservation.path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!sameStableSingleFile(before, opened) ||
        (platform !== "win32" && (opened.mode & 0o077) !== 0)) refuse(code);
    assertOwner(opened, code);
    bytes = Buffer.alloc(expected.size);
    readPrivateReceiptDescriptor(descriptor, bytes);
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(reservation.path);
    if (sha256(bytes) !== expected.sha256 ||
        !sameStableSingleFile(opened, openedAfter) ||
        !sameStableSingleFile(opened, after)) refuse(code);
    return after;
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (bytes) bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateReservation(reservation, code) {
  if (!reservation || reservation.closed === true ||
      !Number.isSafeInteger(reservation.descriptor)) refuse(code);
  let parent;
  let current;
  let opened;
  try {
    parent = lstatSync(reservation.parentPath);
    current = lstatSync(reservation.path);
    opened = fstatSync(reservation.descriptor);
  } catch { refuse(code); }
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      realpathSync(reservation.parentPath) !== reservation.parentPath ||
      !sameInode(parent, reservation.parentInfo) ||
      (process.platform !== "win32" && (parent.mode & 0o077) !== 0) ||
      !Number.isSafeInteger(reservation.markerSize) || reservation.markerSize < 1 ||
      reservation.markerSize > MAX_RECEIPT_BYTES || !SHA256_RE.test(reservation.markerHash || "") ||
      typeof reservation.pendingPath !== "string" ||
      reservation.pendingPath !== pendingReceiptPath(reservation.path) ||
      typeof reservation.commitPath !== "string" ||
      reservation.commitPath !== finalizationCommitPath(reservation.path) ||
      typeof reservation.stagedPath !== "string" ||
      reservation.stagedPath !== stagedReceiptPath(reservation.path) ||
      !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      (process.platform !== "win32" && (current.mode & 0o077) !== 0) ||
      current.size !== reservation.markerSize ||
      !sameStableSingleFile(reservation.info, current) ||
      !sameStableSingleFile(reservation.info, opened)) refuse(code);
  assertOwner(parent, code);
  assertOwner(current, code);
  parent = assertNoDarwinAcl(reservation.parentPath, parent, code);
  current = assertNoDarwinAcl(reservation.path, current, code);
  opened = fstatSync(reservation.descriptor);
  if (!sameStableSingleFile(current, opened) || !sameInode(parent, reservation.parentInfo)) {
    refuse(code);
  }
  let markerBytes;
  try {
    markerBytes = Buffer.alloc(reservation.markerSize);
    readPrivateReceiptDescriptor(reservation.descriptor, markerBytes);
    const openedAfter = fstatSync(reservation.descriptor);
    const currentAfter = lstatSync(reservation.path);
    if (sha256(markerBytes) !== reservation.markerHash ||
        !sameStableSingleFile(opened, openedAfter) ||
        !sameStableSingleFile(opened, currentAfter)) refuse(code);
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (markerBytes) markerBytes.fill(0);
  }
  assertPathAbsent(reservation.stagedPath, code);
  assertPathAbsent(reservation.commitPath, code);
  assertPendingReceiptMarker(reservation, code);
  return true;
}

/** Re-prove both durable marker files and their still-open reservation handle. */
export function validatePrivateAggregateReceiptReservation(reservation, {
  code = "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED",
} = {}) {
  assertSupportedReceiptPlatform(process.platform, code);
  return validateReservation(reservation, code);
}

function removePendingReceiptMarker(
  reservation,
  code,
  platform = process.platform,
  expectedFinal = null,
) {
  if (!expectedFinal?.parentInfo) refuse(code);
  const parentAtStart = assertBoundPrivateDirectory(
    reservation.parentPath,
    reservation.parentInfo,
    code,
    { platform },
  );
  if (!sameStableDirectory(expectedFinal.parentInfo, parentAtStart)) refuse(code);
  const before = assertPendingReceiptMarker(reservation, code);
  let descriptor;
  try {
    descriptor = openSync(
      reservation.pendingPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!sameStableSingleFile(before, opened)) refuse(code);
    closeSync(descriptor);
    descriptor = undefined;
    if (!sameStableSingleFile(before, lstatSync(reservation.pendingPath))) refuse(code);
    const verifiedFinal = assertFinalReceiptForPendingCommit(
      reservation,
      expectedFinal,
      code,
      platform,
    );
    const parentAtCommit = assertBoundPrivateDirectory(
      reservation.parentPath,
      reservation.parentInfo,
      code,
      { platform },
    );
    if (!sameStableDirectory(parentAtStart, parentAtCommit)) refuse(code);
    const finalAtCommit = lstatSync(reservation.path);
    if (!sameStableSingleFile(verifiedFinal, finalAtCommit) ||
        (platform !== "win32" && (finalAtCommit.mode & 0o077) !== 0) ||
        !sameStableSingleFile(before, lstatSync(reservation.pendingPath))) refuse(code);
    assertOwner(finalAtCommit, code);
    assertNoDarwinAcl(reservation.path, finalAtCommit, code, { platform });
    // The final receipt and its directory entry were already flushed and every
    // descriptor was closed. The durable finalization commitment remains as a
    // recovery guard until this removal is itself flushed.
    unlinkSync(reservation.pendingPath);
    return true;
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function closeReservationHandle(reservation, closeHandle = closeSync) {
  if (!reservation || reservation.closed === true ||
      !Number.isSafeInteger(reservation.descriptor)) {
    refuse("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED");
  }
  const descriptor = reservation.descriptor;
  closeHandle(descriptor);
  reservation.descriptor = undefined;
  reservation.closed = true;
}

function validateClosedReservation(reservation, code, platform) {
  if (!reservation || reservation.closed !== true || reservation.descriptor !== undefined) refuse(code);
  let parent;
  let current;
  try {
    parent = lstatSync(reservation.parentPath);
    current = lstatSync(reservation.path);
  } catch { refuse(code); }
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      realpathSync(reservation.parentPath) !== reservation.parentPath ||
      !sameInode(parent, reservation.parentInfo) ||
      (platform !== "win32" && (parent.mode & 0o077) !== 0) ||
      !Number.isSafeInteger(reservation.markerSize) || reservation.markerSize < 1 ||
      reservation.markerSize > MAX_RECEIPT_BYTES || !SHA256_RE.test(reservation.markerHash || "") ||
      reservation.commitPath !== finalizationCommitPath(reservation.path) ||
      reservation.stagedPath !== stagedReceiptPath(reservation.path) ||
      !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      (platform !== "win32" && (current.mode & 0o077) !== 0) ||
      current.size !== reservation.markerSize || reservation.info?.size !== reservation.markerSize ||
      !sameInode(reservation.info, current)) refuse(code);
  assertOwner(parent, code);
  assertOwner(current, code);
  parent = assertNoDarwinAcl(reservation.parentPath, parent, code, { platform });
  current = assertNoDarwinAcl(reservation.path, current, code, { platform });

  let markerDescriptor;
  let markerBytes;
  let markerMatches = false;
  let stable;
  try {
    markerDescriptor = openSync(
      reservation.path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) |
        (platform === "win32" ? 0 : (fsConstants.O_NONBLOCK || 0)),
    );
    const opened = fstatSync(markerDescriptor);
    if (!sameStableSingleFile(current, opened)) refuse(code);
    markerBytes = Buffer.alloc(reservation.markerSize);
    readPrivateReceiptDescriptor(markerDescriptor, markerBytes);
    const openedAfter = fstatSync(markerDescriptor);
    stable = lstatSync(reservation.path);
    markerMatches = sha256(markerBytes) === reservation.markerHash &&
      sameStableSingleFile(current, openedAfter) &&
      sameStableSingleFile(current, stable);
  } catch {
    // Refuse below without exposing receipt bytes.
  } finally {
    if (markerBytes) markerBytes.fill(0);
    if (markerDescriptor !== undefined) closeSync(markerDescriptor);
  }
  if (!markerMatches) refuse(code);
  return stable;
}

function syncReservationDirectory(reservation, code, expectedFinalInfo = null, options = {}) {
  return syncPrivateReceiptDirectory(
    reservation.parentPath,
    reservation.parentInfo,
    reservation.path,
    expectedFinalInfo,
    code,
    options,
  );
}

function exactDataObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return keys.length === fields.length && fields.every((field) =>
    Object.hasOwn(descriptors, field) && descriptors[field].enumerable === true &&
    Object.hasOwn(descriptors[field], "value"));
}

function pathSha256(path) {
  return sha256(resolve(path));
}

function finalizationCommitValue(
  markerHash,
  finalHash,
  finalBytes,
  finalPath,
  stagedPath,
) {
  return Object.freeze({
    schema_version: 1,
    kind: FINALIZATION_COMMIT_KIND,
    reservation_marker_sha256: markerHash,
    final_receipt_sha256: finalHash,
    final_receipt_bytes: finalBytes,
    final_receipt_path_sha256: pathSha256(finalPath),
    staged_receipt_path_sha256: pathSha256(stagedPath),
  });
}

function assertFinalizationCommit(value, markerHash, finalPath, stagedPath, code) {
  if (!exactDataObject(value, [
    "schema_version", "kind", "reservation_marker_sha256",
    "final_receipt_sha256", "final_receipt_bytes",
    "final_receipt_path_sha256", "staged_receipt_path_sha256",
  ]) || value.schema_version !== 1 || value.kind !== FINALIZATION_COMMIT_KIND ||
      value.reservation_marker_sha256 !== markerHash ||
      !SHA256_RE.test(String(value.final_receipt_sha256 || "")) ||
      value.final_receipt_sha256 === markerHash ||
      !Number.isSafeInteger(value.final_receipt_bytes) ||
      value.final_receipt_bytes < 1 || value.final_receipt_bytes > MAX_RECEIPT_BYTES ||
      value.final_receipt_path_sha256 !== pathSha256(finalPath) ||
      value.staged_receipt_path_sha256 !== pathSha256(stagedPath)) {
    refuse(code);
  }
  return Object.freeze(structuredClone(value));
}

function serializedPrivateJson(value, maxBytes, code) {
  let bytes;
  try { bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
  catch { refuse(code); }
  if (bytes.length < 1 || bytes.length > maxBytes) {
    bytes.fill(0);
    refuse(code);
  }
  return bytes;
}

function readFinalizationCommitRecord(path, markerHash, finalPath, stagedPath, code) {
  const record = readPrivateAggregateReceiptFile(path, {
    code,
    maxBytes: MAX_FINALIZATION_COMMIT_BYTES,
    absentPaths: [],
  });
  const value = assertFinalizationCommit(
    record.value,
    markerHash,
    finalPath,
    stagedPath,
    code,
  );
  const expected = serializedPrivateJson(value, MAX_FINALIZATION_COMMIT_BYTES, code);
  try {
    if (record.info.size !== expected.length || record.sha256 !== sha256(expected)) refuse(code);
  } finally {
    expected.fill(0);
  }
  return Object.freeze({ ...record, value });
}

function writeFinalizationCommitRecord(binding, finalRecord, {
  writeBytes,
  readBytes,
  syncFile,
  syncCommitDirectory,
  platform,
  code = "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_COMMIT_INVALID",
}) {
  const finalHash = finalRecord?.sha256;
  const finalBytes = finalRecord?.info?.size;
  if (!SHA256_RE.test(finalHash || "") || finalHash === binding.markerHash ||
      !Number.isSafeInteger(finalBytes) || finalBytes < 1 ||
      finalBytes > MAX_RECEIPT_BYTES) refuse(code);
  const value = finalizationCommitValue(
    binding.markerHash,
    finalHash,
    finalBytes,
    binding.path,
    binding.stagedPath,
  );
  const bytes = serializedPrivateJson(value, MAX_FINALIZATION_COMMIT_BYTES, code);
  let descriptor;
  let readback;
  try {
    try {
        descriptor = openSync(
        binding.commitPath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
    } catch (error) {
      if (error?.code === "EEXIST") refuse(code);
      throw error;
    }
    assertPrivateEmptyReceiptFile(binding.commitPath, descriptor, code, platform);
    writeBytes(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    syncFile(descriptor);
    let info = fstatSync(descriptor);
    let current = lstatSync(binding.commitPath);
    if (!sameStableSingleFile(info, current) || info.size !== bytes.length) refuse(code);
    assertOwner(info, code);
    current = assertNoDarwinAcl(binding.commitPath, current, code, { platform });
    if (!sameStableSingleFile(info, current)) refuse(code);
    readback = Buffer.alloc(bytes.length);
    readBytes(descriptor, readback);
    if (!readback.equals(bytes) ||
        !sameStableSingleFile(info, fstatSync(descriptor)) ||
        !sameStableSingleFile(info, lstatSync(binding.commitPath))) refuse(code);
    syncCommitDirectory(
      binding.parentPath,
      binding.parentInfo,
      binding.commitPath,
      info,
      code,
      { platform },
    );
    info = fstatSync(descriptor);
    if (!sameStableSingleFile(info, lstatSync(binding.commitPath))) refuse(code);
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    bytes.fill(0);
    if (readback) readback.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return readFinalizationCommitRecord(
    binding.commitPath,
    binding.markerHash,
    binding.path,
    binding.stagedPath,
    code,
  );
}

function rereadExactPrivateRecord(record, code, { guarded = true } = {}) {
  const current = readPrivateAggregateReceiptFile(record.path, {
    code,
    maxBytes: Math.max(record.info.size, 1),
    absentPaths: guarded
      ? [
          pendingReceiptPath(record.path),
          finalizationCommitPath(record.path),
          stagedReceiptPath(record.path),
        ]
      : [],
  });
  if (current.sha256 !== record.sha256 || current.info.size !== record.info.size ||
      !sameStableSingleFile(current.info, record.info)) refuse(code);
  return current;
}

function removeExactPrivateRecord(record, code, {
  guarded = true,
  unlink = unlinkSync,
} = {}) {
  const current = rereadExactPrivateRecord(record, code, { guarded });
  try {
    if (!sameStableSingleFile(current.info, lstatSync(record.path))) refuse(code);
    unlink(record.path);
    assertPathAbsent(record.path, code);
    return true;
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  }
}

function fsyncAndRereadExactPrivateRecord(record, binding, code, {
  readBytes = readPrivateReceiptDescriptor,
  syncFile = fsyncSync,
  syncDirectory = syncPrivateReceiptDirectory,
} = {}) {
  const parentBefore = assertBoundPrivateDirectory(
    binding.parentPath,
    binding.parentInfo,
    code,
    { platform: binding.platform },
  );
  if (!sameStableDirectory(record.parent.info, parentBefore)) refuse(code);
  const before = rereadExactPrivateRecord(record, code, { guarded: false });
  let descriptor;
  let bytes;
  try {
    descriptor = openSync(
      record.path,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!sameStableSingleFile(before.info, opened)) refuse(code);
    syncFile(descriptor);
    const openedAfterSync = fstatSync(descriptor);
    const pathAfterSync = lstatSync(record.path);
    if (!sameStableSingleFile(opened, openedAfterSync) ||
        !sameStableSingleFile(opened, pathAfterSync)) refuse(code);
    bytes = Buffer.alloc(record.info.size);
    readBytes(descriptor, bytes);
    const openedAfterRead = fstatSync(descriptor);
    const pathAfterRead = lstatSync(record.path);
    if (sha256(bytes) !== record.sha256 ||
        !sameStableSingleFile(opened, openedAfterRead) ||
        !sameStableSingleFile(opened, pathAfterRead)) refuse(code);
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (bytes) bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectory(
    binding.parentPath,
    binding.parentInfo,
    record.path,
    record.info,
    code,
    { platform: binding.platform },
  );
  const durable = rereadExactPrivateRecord(record, code, { guarded: false });
  const parentAfter = assertBoundPrivateDirectory(
    binding.parentPath,
    binding.parentInfo,
    code,
    { platform: binding.platform },
  );
  if (!sameStableDirectory(parentBefore, parentAfter) ||
      !sameStableDirectory(durable.parent.info, parentAfter)) refuse(code);
  return durable;
}

const FINALIZATION_STATE = Object.freeze({
  STAGED: "marker_pending_staged",
  STAGED_COMMITTED: "marker_pending_staged_committed",
  FINAL_PENDING_COMMITTED: "final_pending_committed",
  FINAL_COMMITTED: "final_committed",
  TERMINAL: "terminal_final",
});

function samePresence(left, right) {
  return left.main === right.main && left.pending === right.pending &&
    left.staged === right.staged && left.commit === right.commit;
}

function finalizationPresence(binding, code) {
  return Object.freeze({
    main: pathPresent(binding.path, code),
    pending: pathPresent(binding.pendingPath, code),
    staged: pathPresent(binding.stagedPath, code),
    commit: pathPresent(binding.commitPath, code),
  });
}

function assertRecordParent(record, binding, code) {
  if (!record?.parent || record.parent.path !== binding.parentPath ||
      !sameInode(record.parent.info, binding.parentInfo)) refuse(code);
  return record;
}

function assertFinalReceiptRecord(record, binding, code) {
  if (record.sha256 === binding.markerHash || record.info.size > MAX_RECEIPT_BYTES) {
    refuse(code);
  }
  if (binding.expectedFinal &&
      (record.sha256 !== binding.expectedFinal.sha256 ||
        record.info.size !== binding.expectedFinal.size)) refuse(code);
  if (binding.validateFinalReceipt) {
    try {
      if (binding.validateFinalReceipt(record.value) !== true) refuse(code);
    } catch (error) {
      if (error instanceof PrivateAggregateReceiptError && error.code === code) throw error;
      refuse(code);
    }
  }
  return record;
}

function inspectPrivateAggregateFinalizationState(binding, code) {
  const parentAtStart = assertBoundPrivateDirectory(
    binding.parentPath,
    binding.parentInfo,
    code,
    { platform: binding.platform },
  );
  const before = finalizationPresence(binding, code);
  if (!before.main) refuse(code);
  let kind;
  if (before.pending && before.staged && !before.commit) {
    kind = FINALIZATION_STATE.STAGED;
  } else if (before.pending && before.staged && before.commit) {
    kind = FINALIZATION_STATE.STAGED_COMMITTED;
  } else if (before.pending && !before.staged && before.commit) {
    kind = FINALIZATION_STATE.FINAL_PENDING_COMMITTED;
  } else if (!before.pending && !before.staged && before.commit) {
    kind = FINALIZATION_STATE.FINAL_COMMITTED;
  } else if (!before.pending && !before.staged && !before.commit) {
    kind = FINALIZATION_STATE.TERMINAL;
  } else {
    refuse(code);
  }

  const main = assertRecordParent(readPrivateAggregateReceiptFile(binding.path, {
    code,
    maxBytes: MAX_RECEIPT_BYTES,
    absentPaths: [],
  }), binding, code);
  const mainIsMarker = main.sha256 === binding.markerHash &&
    main.info.size === binding.markerSize;
  const expectsMarker = kind === FINALIZATION_STATE.STAGED ||
    kind === FINALIZATION_STATE.STAGED_COMMITTED;
  if (mainIsMarker !== expectsMarker) refuse(code);

  let pending = null;
  if (before.pending) {
    pending = assertRecordParent(readPrivateAggregateReceiptFile(binding.pendingPath, {
      code,
      maxBytes: binding.markerSize,
      absentPaths: [],
    }), binding, code);
    if (pending.sha256 !== binding.markerHash ||
        pending.info.size !== binding.markerSize) refuse(code);
  }

  let staged = null;
  let final = null;
  if (before.staged) {
    staged = assertFinalReceiptRecord(
      assertRecordParent(readPrivateAggregateReceiptFile(binding.stagedPath, {
        code,
        maxBytes: MAX_RECEIPT_BYTES,
        absentPaths: [],
      }), binding, code),
      binding,
      code,
    );
  } else if (!mainIsMarker) {
    final = assertFinalReceiptRecord(main, binding, code);
  }

  let commit = null;
  if (before.commit) {
    commit = assertRecordParent(readFinalizationCommitRecord(
      binding.commitPath,
      binding.markerHash,
      binding.path,
      binding.stagedPath,
      code,
    ), binding, code);
    const receiptRecord = staged ?? final;
    if (!receiptRecord ||
        receiptRecord.sha256 !== commit.value.final_receipt_sha256 ||
        receiptRecord.info.size !== commit.value.final_receipt_bytes) refuse(code);
  }

  const parent = assertBoundPrivateDirectory(
    binding.parentPath,
    binding.parentInfo,
    code,
    { platform: binding.platform },
  );
  const after = finalizationPresence(binding, code);
  if (!sameStableDirectory(parentAtStart, parent) ||
      !samePresence(before, after)) refuse(code);
  return Object.freeze({ kind, main, pending, staged, final, commit, parent });
}

function assertOpenReservationState(reservation, state, stagedDescriptor, code) {
  if (!reservation || reservation.closed === true ||
      !Number.isSafeInteger(reservation.descriptor) ||
      !sameStableSingleFile(state.main.info, reservation.info) ||
      !sameStableSingleFile(state.main.info, fstatSync(reservation.descriptor)) ||
      !state.pending || !sameStableSingleFile(state.pending.info, reservation.pendingInfo)) {
    refuse(code);
  }
  if (stagedDescriptor !== undefined &&
      (!state.staged ||
        !sameStableSingleFile(state.staged.info, fstatSync(stagedDescriptor)))) refuse(code);
  return true;
}

function closeFinalizationHandles(context) {
  if (context.stagedDescriptor !== undefined) {
    const descriptor = context.stagedDescriptor;
    context.closeStaged(descriptor);
    context.stagedDescriptor = undefined;
  }
  if (context.reservation && !context.reservation.closed) {
    closeReservationHandle(context.reservation, context.closeReservation);
  }
}

function invokeTerminalAuthority(context, phase, finalReceipt, code) {
  const request = Object.freeze({
    phase,
    finalReceipt,
    finalPath: context.binding.path,
    pendingPath: context.binding.pendingPath,
    stagedPath: context.binding.stagedPath,
    commitPath: context.binding.commitPath,
  });
  try {
    if (context.validateTerminalAuthority(request) !== true) refuse(code);
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError && error.code === code) throw error;
    refuse(code);
  }
  return true;
}

function completePrivateAggregateFinalization(context) {
  let state = inspectPrivateAggregateFinalizationState(
    context.binding,
    context.codes.inspect,
  );
  while (true) {
    if (state.kind === FINALIZATION_STATE.STAGED) {
      if (context.reservation) {
        assertOpenReservationState(
          context.reservation,
          state,
          context.stagedDescriptor,
          context.codes.commit,
        );
      }
      const durableStaged = context.durablyRevalidateStaged(
        state.staged,
        context.codes.commit,
      );
      state = inspectPrivateAggregateFinalizationState(context.binding, context.codes.commit);
      if (state.kind !== FINALIZATION_STATE.STAGED ||
          !sameStableSingleFile(state.staged.info, durableStaged.info) ||
          state.staged.sha256 !== durableStaged.sha256) refuse(context.codes.commit);
      context.writeCommit(state.staged, context.codes.commit);
      state = inspectPrivateAggregateFinalizationState(context.binding, context.codes.commit);
      if (state.kind !== FINALIZATION_STATE.STAGED_COMMITTED) refuse(context.codes.commit);
      context.onFinalizationTransition("finalization_commit_durable");
      continue;
    }

    if (state.kind === FINALIZATION_STATE.STAGED_COMMITTED) {
      if (context.reservation) {
        assertOpenReservationState(
          context.reservation,
          state,
          context.stagedDescriptor,
          context.codes.final,
        );
      }
      const parentBeforeCommitSync = state.parent;
      context.syncSidecar(state.commit, context.codes.final);
      state = inspectPrivateAggregateFinalizationState(context.binding, context.codes.final);
      if (state.kind !== FINALIZATION_STATE.STAGED_COMMITTED ||
          !sameStableDirectory(parentBeforeCommitSync, state.parent)) {
        refuse(context.codes.final);
      }
      context.rename(context.binding.stagedPath, context.binding.path);
      const renamed = lstatSync(context.binding.path);
      if (!sameFile(state.staged.info, renamed) || renamed.nlink !== 1 ||
          (context.binding.platform !== "win32" && (renamed.mode & 0o077) !== 0)) {
        refuse(context.codes.final);
      }
      if (context.stagedDescriptor !== undefined &&
          !sameStableSingleFile(renamed, fstatSync(context.stagedDescriptor))) {
        refuse(context.codes.final);
      }
      if (context.reservation && !context.reservation.closed &&
          fstatSync(context.reservation.descriptor).nlink !== 0) refuse(context.codes.final);
      context.syncFinal(renamed, context.codes.parent);
      state = inspectPrivateAggregateFinalizationState(context.binding, context.codes.final);
      if (state.kind !== FINALIZATION_STATE.FINAL_PENDING_COMMITTED ||
          !sameStableSingleFile(state.final.info, renamed)) refuse(context.codes.final);
      if (context.stagedDescriptor !== undefined &&
          !sameStableSingleFile(state.final.info, fstatSync(context.stagedDescriptor))) {
        refuse(context.codes.final);
      }
      context.onFinalizationTransition("final_receipt_durable");
      continue;
    }

    if (state.kind === FINALIZATION_STATE.FINAL_PENDING_COMMITTED) {
      const parentBeforeClose = state.parent;
      closeFinalizationHandles(context);
      state = inspectPrivateAggregateFinalizationState(context.binding, context.codes.pending);
      if (state.kind !== FINALIZATION_STATE.FINAL_PENDING_COMMITTED ||
          !sameStableDirectory(parentBeforeClose, state.parent)) {
        refuse(context.codes.pending);
      }
      rereadExactPrivateRecord(state.final, context.codes.pending, { guarded: false });
      rereadExactPrivateRecord(state.commit, context.codes.pending, { guarded: false });
      context.removePending(state, context.codes.pending);
      context.syncFinal(state.final.info, context.codes.parent);
      state = inspectPrivateAggregateFinalizationState(context.binding, context.codes.pending);
      if (state.kind !== FINALIZATION_STATE.FINAL_COMMITTED) refuse(context.codes.pending);
      context.onFinalizationTransition("pending_marker_removal_durable");
      continue;
    }

    if (state.kind === FINALIZATION_STATE.FINAL_COMMITTED) {
      closeFinalizationHandles(context);
      rereadExactPrivateRecord(state.final, context.codes.commitRemoval, { guarded: false });
      rereadExactPrivateRecord(state.commit, context.codes.commitRemoval, { guarded: false });
      invokeTerminalAuthority(
        context,
        "before_commit_guard_removal",
        state.final,
        context.codes.commitRemoval,
      );
      const authorizedFinal = state.final;
      const authorizedCommit = state.commit;
      state = inspectPrivateAggregateFinalizationState(
        context.binding,
        context.codes.commitRemoval,
      );
      if (state.kind !== FINALIZATION_STATE.FINAL_COMMITTED ||
          state.final.sha256 !== authorizedFinal.sha256 ||
          !sameStableSingleFile(state.final.info, authorizedFinal.info) ||
          state.commit.sha256 !== authorizedCommit.sha256 ||
          !sameStableSingleFile(state.commit.info, authorizedCommit.info)) {
        refuse(context.codes.commitRemoval);
      }
      context.removeCommit(state.commit, context.codes.commitRemoval);
      context.syncFinal(state.final.info, context.codes.parent);
      state = inspectPrivateAggregateFinalizationState(
        context.binding,
        context.codes.commitRemoval,
      );
      if (state.kind !== FINALIZATION_STATE.TERMINAL) {
        refuse(context.codes.commitRemoval);
      }
      context.onFinalizationTransition("finalization_commit_removal_durable");
      continue;
    }

    if (state.kind === FINALIZATION_STATE.TERMINAL) {
      closeFinalizationHandles(context);
      invokeTerminalAuthority(
        context,
        "accept_terminal_final",
        state.final,
        context.codes.commitRemoval,
      );
      return state.final;
    }
    refuse(context.codes.inspect);
  }
}

/** Reserve the final path with a durable exact marker before external work. */
export function reservePrivateAggregateReceipt(output, marker, {
  onTransition = () => {},
} = {}) {
  assertSupportedReceiptPlatform(
    process.platform,
    "PRIVATE_AGGREGATE_RECEIPT_PLATFORM_UNSUPPORTED",
  );
  if (!output?.path || !output?.pendingPath || !output?.parent?.path ||
      typeof onTransition !== "function" ||
      dirname(output.path) !== output.parent.path ||
      dirname(output.pendingPath) !== output.parent.path ||
      output.pendingPath !== pendingReceiptPath(output.path) ||
      (output.commitPath !== undefined &&
        output.commitPath !== finalizationCommitPath(output.path)) ||
      (output.stagedPath !== undefined &&
        output.stagedPath !== stagedReceiptPath(output.path))) {
    refuse("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID");
  }
  const parent = assertPrivateDirectory(
    output.parent.path,
    "PRIVATE_AGGREGATE_RECEIPT_PARENT_REFUSED",
  );
  if (!sameInode(parent.info, output.parent.info)) {
    refuse("PRIVATE_AGGREGATE_RECEIPT_PARENT_CHANGED");
  }
  let descriptor;
  let pendingDescriptor;
  const reservation = {
    path: output.path,
    pendingPath: output.pendingPath,
    commitPath: finalizationCommitPath(output.path),
    stagedPath: stagedReceiptPath(output.path),
    parentPath: parent.path,
    parentInfo: parent.info,
    descriptor: undefined,
    info: null,
    pendingInfo: null,
    markerSize: null,
    markerHash: null,
    closed: false,
  };
  let bytes;
  try {
    assertPathAbsent(
      reservation.commitPath,
      "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_COLLISION",
    );
    assertPathAbsent(
      reservation.stagedPath,
      "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_COLLISION",
    );
    bytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    if (bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID");
    }
    reservation.markerSize = bytes.length;
    reservation.markerHash = sha256(bytes);
    try {
      pendingDescriptor = openSync(
        output.pendingPath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
    } catch (error) {
      if (error?.code === "EEXIST") {
        refuse("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_COLLISION");
      }
      throw error;
    }
    assertPrivateEmptyReceiptFile(
      output.pendingPath,
      pendingDescriptor,
      "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID",
    );
    writePrivateReceiptDescriptor(pendingDescriptor, bytes);
    fsyncSync(pendingDescriptor);
    fchmodSync(pendingDescriptor, 0o600);
    reservation.pendingInfo = fstatSync(pendingDescriptor);
    const pendingCurrent = lstatSync(output.pendingPath);
    if (!reservation.pendingInfo.isFile() || reservation.pendingInfo.nlink !== 1 ||
        reservation.pendingInfo.size !== reservation.markerSize ||
        (process.platform !== "win32" && (reservation.pendingInfo.mode & 0o077) !== 0) ||
        !sameStableSingleFile(reservation.pendingInfo, pendingCurrent)) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID");
    }
    assertOwner(reservation.pendingInfo, "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID");
    closeSync(pendingDescriptor);
    pendingDescriptor = undefined;
    syncPrivateReceiptDirectory(
      reservation.parentPath,
      reservation.parentInfo,
      reservation.pendingPath,
      reservation.pendingInfo,
      "PRIVATE_AGGREGATE_RECEIPT_PARENT_CHANGED",
    );
    // A crash here leaves only the authenticated pending marker. Because this
    // function has not returned, no caller can yet have received authority to
    // begin external work; the exact marker may therefore be cancelled safely.
    onTransition("pending_marker_durable");
    try {
      descriptor = openSync(
        output.path,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
      reservation.descriptor = descriptor;
    } catch (error) {
      if (error?.code === "EEXIST") {
        refuse("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_COLLISION");
      }
      throw error;
    }
    assertPrivateEmptyReceiptFile(
      output.path,
      descriptor,
      "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID",
    );
    writePrivateReceiptDescriptor(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    reservation.info = fstatSync(descriptor);
    const current = lstatSync(output.path);
    if (!reservation.info.isFile() || reservation.info.nlink !== 1 ||
        reservation.info.size !== reservation.markerSize ||
        (process.platform !== "win32" && (reservation.info.mode & 0o077) !== 0) ||
        !sameFile(reservation.info, current)) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID");
    }
    assertOwner(reservation.info, "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_INVALID");
    syncReservationDirectory(
      reservation,
      "PRIVATE_AGGREGATE_RECEIPT_PARENT_CHANGED",
      reservation.info,
    );
    validateReservation(reservation, "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED");
    return reservation;
  } catch (error) {
    if (pendingDescriptor !== undefined) {
      try { closeSync(pendingDescriptor); } catch { /* keep conservative marker */ }
    }
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* keep conservative marker */ }
    }
    reservation.closed = true;
    throw error;
  } finally {
    if (bytes) bytes.fill(0);
  }
}

/**
 * Reopen the two exact conservative marker files left by an interrupted run.
 * The caller must separately prove that resuming the external operation is
 * safe. This helper grants no retry authority; it only restores the local
 * descriptor needed to finalize the same aggregate receipt later.
 */
export function resumePrivateAggregateReceiptReservation(output, marker) {
  const code = "PRIVATE_AGGREGATE_RECEIPT_RESUME_INVALID";
  assertSupportedReceiptPlatform(process.platform, code);
  if (!output?.path || !output?.pendingPath || !output?.parent?.path ||
      dirname(output.path) !== output.parent.path ||
      dirname(output.pendingPath) !== output.parent.path ||
      output.pendingPath !== pendingReceiptPath(output.path) ||
      (output.commitPath !== undefined &&
        output.commitPath !== finalizationCommitPath(output.path)) ||
      (output.stagedPath !== undefined &&
        output.stagedPath !== stagedReceiptPath(output.path))) {
    refuse(code);
  }
  const parent = assertPrivateDirectory(output.parent.path, code);
  if (!sameInode(parent.info, output.parent.info)) refuse(code);
  let bytes;
  let descriptor;
  const reservation = {
    path: output.path,
    pendingPath: output.pendingPath,
    commitPath: finalizationCommitPath(output.path),
    stagedPath: stagedReceiptPath(output.path),
    parentPath: parent.path,
    parentInfo: parent.info,
    descriptor: undefined,
    info: null,
    pendingInfo: null,
    markerSize: null,
    markerHash: null,
    closed: false,
  };
  try {
    assertPathAbsent(reservation.commitPath, code);
    assertPathAbsent(reservation.stagedPath, code);
    bytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    if (bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES) refuse(code);
    reservation.markerSize = bytes.length;
    reservation.markerHash = sha256(bytes);
    reservation.pendingInfo = lstatSync(output.pendingPath);
    descriptor = openSync(
      output.path,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0),
    );
    reservation.descriptor = descriptor;
    reservation.info = fstatSync(descriptor);
    validateReservation(reservation, code);
    return reservation;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve both markers */ }
    }
    reservation.descriptor = undefined;
    reservation.closed = true;
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (bytes) bytes.fill(0);
  }
}

/** Replace a reserved marker with one exact, durably read-back JSON receipt. */
export function finalizePrivateAggregateReceipt(reservation, receipt, {
  writeBytes = writePrivateReceiptDescriptor,
  readBytes = readPrivateReceiptDescriptor,
  syncFile = fsyncSync,
  rename = renameSync,
  syncDirectory = syncReservationDirectory,
  syncCommitDirectory = syncPrivateReceiptDirectory,
  removePending = removePendingReceiptMarker,
  removeCommit = removeExactPrivateRecord,
  platform = process.platform,
  closeReservation = closeSync,
  closeTemporary = closeSync,
  onFinalizationTransition = () => {},
  validateTerminalAuthority = () => true,
} = {}) {
  assertSupportedReceiptPlatform(platform, "PRIVATE_AGGREGATE_RECEIPT_PLATFORM_UNSUPPORTED");
  if (typeof onFinalizationTransition !== "function" ||
      typeof validateTerminalAuthority !== "function") {
    refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
  }
  validateReservation(reservation, "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED");
  let stagedDescriptor;
  let context = null;
  let bytes;
  try {
    bytes = serializedPrivateJson(
      receipt,
      MAX_RECEIPT_BYTES,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID",
    );
    stagedDescriptor = openSync(
      reservation.stagedPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    assertPrivateEmptyReceiptFile(
      reservation.stagedPath,
      stagedDescriptor,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID",
      platform,
    );
    onFinalizationTransition("staged_receipt_created");
    writeBytes(stagedDescriptor, bytes);
    onFinalizationTransition("staged_receipt_written");
    fchmodSync(stagedDescriptor, 0o600);
    syncFile(stagedDescriptor);
    let stagedInfo = fstatSync(stagedDescriptor);
    let stagedCurrent = lstatSync(reservation.stagedPath);
    if (!stagedInfo.isFile() || stagedInfo.nlink !== 1 ||
        stagedInfo.size !== bytes.length ||
        (platform !== "win32" && (stagedInfo.mode & 0o077) !== 0) ||
        !sameStableSingleFile(stagedInfo, stagedCurrent)) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    }
    assertOwner(stagedInfo, "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    stagedCurrent = assertNoDarwinAcl(
      reservation.stagedPath,
      stagedCurrent,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID",
      { platform },
    );
    if (!sameStableSingleFile(stagedInfo, stagedCurrent) ||
        !sameStableSingleFile(stagedInfo, fstatSync(stagedDescriptor))) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    }
    let readback;
    try {
      readback = Buffer.alloc(bytes.length);
      readBytes(stagedDescriptor, readback);
      if (!readback.equals(bytes) ||
          !sameStableSingleFile(stagedInfo, fstatSync(stagedDescriptor)) ||
          !sameStableSingleFile(stagedInfo, lstatSync(reservation.stagedPath))) {
        refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
      }
    } finally {
      if (readback) readback.fill(0);
    }
    onFinalizationTransition("staged_receipt_file_fsynced");
    syncCommitDirectory(
      reservation.parentPath,
      reservation.parentInfo,
      reservation.stagedPath,
      stagedInfo,
      "PRIVATE_AGGREGATE_RECEIPT_PARENT_CHANGED",
      { platform },
    );
    const expectedFinal = Object.freeze({
      sha256: sha256(bytes),
      size: bytes.length,
    });
    const binding = {
      path: reservation.path,
      pendingPath: reservation.pendingPath,
      stagedPath: reservation.stagedPath,
      commitPath: reservation.commitPath,
      parentPath: reservation.parentPath,
      parentInfo: reservation.parentInfo,
      markerHash: reservation.markerHash,
      markerSize: reservation.markerSize,
      expectedFinal,
      validateFinalReceipt: null,
      platform,
    };
    const stagedRecord = assertRecordParent(readPrivateAggregateReceiptFile(
      reservation.stagedPath,
      {
        code: "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID",
        maxBytes: MAX_RECEIPT_BYTES,
        absentPaths: [reservation.commitPath],
      },
    ), binding, "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    if (stagedRecord.sha256 !== expectedFinal.sha256 ||
        stagedRecord.info.size !== expectedFinal.size ||
        !sameStableSingleFile(stagedRecord.info, stagedInfo) ||
        !sameStableSingleFile(stagedRecord.info, fstatSync(stagedDescriptor))) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    }
    const stagedState = inspectPrivateAggregateFinalizationState(
      binding,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID",
    );
    if (stagedState.kind !== FINALIZATION_STATE.STAGED) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    }
    assertOpenReservationState(
      reservation,
      stagedState,
      stagedDescriptor,
      "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED",
    );
    onFinalizationTransition("staged_receipt_durable");

    context = {
      binding,
      reservation,
      stagedDescriptor,
      closeStaged: closeTemporary,
      closeReservation,
      rename,
      onFinalizationTransition,
      validateTerminalAuthority,
      codes: {
        inspect: "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED",
        commit: "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_COMMIT_INVALID",
        final: "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED",
        pending: "PRIVATE_AGGREGATE_RECEIPT_PENDING_CHANGED",
        commitRemoval: "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_COMMIT_CHANGED",
        parent: "PRIVATE_AGGREGATE_RECEIPT_PARENT_CHANGED",
      },
      syncSidecar(record, code) {
        return syncCommitDirectory(
          reservation.parentPath,
          reservation.parentInfo,
          record.path,
          record.info,
          code,
          { platform },
        );
      },
      durablyRevalidateStaged(record, code) {
        return fsyncAndRereadExactPrivateRecord(record, binding, code, {
          readBytes,
          syncFile,
          syncDirectory: syncCommitDirectory,
        });
      },
      syncFinal(expectedInfo, code) {
        return syncDirectory(reservation, code, expectedInfo);
      },
      writeCommit(record, code) {
        return writeFinalizationCommitRecord(binding, record, {
          writeBytes,
          readBytes,
          syncFile,
          syncCommitDirectory,
          platform,
          code,
        });
      },
      removePending(state, code) {
        return removePending(reservation, code, platform, {
          info: state.final.info,
          parentInfo: state.parent,
          size: state.final.info.size,
          sha256: state.final.sha256,
        });
      },
      removeCommit(record, code) {
        return removeCommit(record, code, { guarded: false });
      },
    };
    const finalRecord = completePrivateAggregateFinalization(context);
    if (finalRecord.sha256 !== expectedFinal.sha256 ||
        finalRecord.info.size !== expectedFinal.size) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED");
    }
    return true;
  } finally {
    if (bytes) bytes.fill(0);
    const openStagedDescriptor = context ? context.stagedDescriptor : stagedDescriptor;
    if (openStagedDescriptor !== undefined) {
      try { closeSync(openStagedDescriptor); } catch { /* guards remain */ }
    }
  }
}

/**
 * Resolve one exact crash residue left by the finalization commit protocol.
 *
 * The caller must hold its normal operation lock and supply a strict receipt
 * validator. A staged receipt is reopened, file-synced, descriptor-read back,
 * parent-synced, and exact-reread before any commitment can be created. A
 * committed final receipt is exact-reread before the pending marker and then
 * the commitment are removed. Every other partial or substituted state is
 * refused without guard deletion. No receipt or marker content is returned.
 */
export function recoverPrivateAggregateReceiptFinalization(
  output,
  marker,
  validateFinalReceipt,
  {
    code = "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID",
    platform = process.platform,
    syncDirectory = syncPrivateReceiptDirectory,
    removeRecord = removeExactPrivateRecord,
    rename = renameSync,
    syncCommitDirectory = syncPrivateReceiptDirectory,
    readStagedBytes = readPrivateReceiptDescriptor,
    syncStagedFile = fsyncSync,
    onFinalizationTransition = () => {},
    validateTerminalAuthority = () => true,
  } = {},
) {
  assertSupportedReceiptPlatform(platform, code);
  if (!output?.path || !output?.pendingPath || !output?.parent?.path ||
      typeof validateFinalReceipt !== "function" ||
      typeof readStagedBytes !== "function" || typeof syncStagedFile !== "function" ||
      typeof onFinalizationTransition !== "function" ||
      typeof validateTerminalAuthority !== "function" ||
      dirname(output.path) !== output.parent.path ||
      dirname(output.pendingPath) !== output.parent.path ||
      output.pendingPath !== pendingReceiptPath(output.path) ||
      (output.commitPath !== undefined &&
        output.commitPath !== finalizationCommitPath(output.path)) ||
      (output.stagedPath !== undefined &&
        output.stagedPath !== stagedReceiptPath(output.path))) {
    refuse(code);
  }
  const path = resolve(output.path);
  const pendingPath = resolve(output.pendingPath);
  const commitPath = finalizationCommitPath(path);
  const stagedPath = stagedReceiptPath(path);
  const parent = assertPrivateDirectory(output.parent.path, code);
  if (path !== output.path || pendingPath !== output.pendingPath ||
      dirname(commitPath) !== parent.path || dirname(stagedPath) !== parent.path ||
      !sameInode(parent.info, output.parent.info)) {
    refuse(code);
  }
  const markerBytes = serializedPrivateJson(marker, MAX_RECEIPT_BYTES, code);
  try {
    const binding = {
      path,
      pendingPath,
      stagedPath,
      commitPath,
      parentPath: parent.path,
      parentInfo: output.parent.info,
      markerHash: sha256(markerBytes),
      markerSize: markerBytes.length,
      expectedFinal: null,
      validateFinalReceipt,
      platform,
    };
    const finalReadback = completePrivateAggregateFinalization({
      binding,
      reservation: null,
      stagedDescriptor: undefined,
      closeStaged: closeSync,
      closeReservation: closeSync,
      rename,
      onFinalizationTransition,
      validateTerminalAuthority,
      codes: {
        inspect: code,
        commit: code,
        final: code,
        pending: code,
        commitRemoval: code,
        parent: code,
      },
      syncSidecar(record, transitionCode) {
        return syncCommitDirectory(
          parent.path,
          output.parent.info,
          record.path,
          record.info,
          transitionCode,
          { platform },
        );
      },
      durablyRevalidateStaged(record, transitionCode) {
        return fsyncAndRereadExactPrivateRecord(record, binding, transitionCode, {
          readBytes: readStagedBytes,
          syncFile: syncStagedFile,
          syncDirectory: syncCommitDirectory,
        });
      },
      syncFinal(expectedInfo, transitionCode) {
        return syncDirectory(
          parent.path,
          output.parent.info,
          path,
          expectedInfo,
          transitionCode,
          { platform },
        );
      },
      writeCommit(record, transitionCode) {
        return writeFinalizationCommitRecord(binding, record, {
          writeBytes: writePrivateReceiptDescriptor,
          readBytes: readPrivateReceiptDescriptor,
          syncFile: fsyncSync,
          syncCommitDirectory,
          platform,
          code: transitionCode,
        });
      },
      removePending(state, transitionCode) {
        return removeRecord(state.pending, transitionCode, { guarded: false });
      },
      removeCommit(record, transitionCode) {
        return removeRecord(record, transitionCode, { guarded: false });
      },
    });
    return Object.freeze({
      status: "finalized",
      receipt_sha256: finalReadback.sha256,
    });
  } finally {
    markerBytes.fill(0);
  }
}

function syncPrivateReceiptParentOnly(
  directoryPath,
  expectedDirectoryInfo,
  code,
  {
    platform = process.platform,
    openDirectoryHandle = openSync,
    statDirectoryHandle = fstatSync,
    syncDirectoryHandle = fsyncSync,
    closeDirectoryHandle = closeSync,
  } = {},
) {
  assertSupportedReceiptPlatform(platform, code);
  const absolute = resolve(directoryPath);
  let before;
  let descriptor;
  try {
    before = lstatSync(absolute);
    if (!before.isDirectory() || before.isSymbolicLink() ||
        realpathSync(absolute) !== absolute ||
        !sameInode(before, expectedDirectoryInfo) ||
        (platform !== "win32" && (before.mode & 0o077) !== 0)) refuse(code);
    assertOwner(before, code);
    before = assertNoDarwinAcl(absolute, before, code, { platform });
    descriptor = openDirectoryHandle(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) |
        (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = statDirectoryHandle(descriptor);
    assertPrivateDirectoryInfo(opened, before, code, platform);
    if (!sameStableDirectory(opened, before)) refuse(code);
    syncDirectoryHandle(descriptor);
    const openedAfter = statDirectoryHandle(descriptor);
    const after = lstatSync(absolute);
    assertPrivateDirectoryInfo(openedAfter, before, code, platform);
    assertPrivateDirectoryInfo(after, before, code, platform);
    if (realpathSync(absolute) !== absolute ||
        !sameStableDirectory(opened, openedAfter) ||
        !sameStableDirectory(opened, after)) refuse(code);
    const aclCheckedAfter = assertNoDarwinAcl(absolute, after, code, { platform });
    if (!sameStableDirectory(opened, aclCheckedAfter)) refuse(code);
    return true;
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (descriptor !== undefined) closeDirectoryHandle(descriptor);
  }
}

/**
 * Remove only an exact reservation marker pair after the caller has separately
 * proved cancellation authority. Either marker may already be absent after a
 * prior interrupted cancellation, but every marker still present must match
 * the supplied value byte-for-byte and a finalization commitment is refused.
 * This helper performs no external mutation and grants no reset authority.
 */
export function clearPrivateAggregateReceiptReservation(
  output,
  marker,
  {
    code = "PRIVATE_AGGREGATE_RECEIPT_CANCELLATION_INVALID",
    platform = process.platform,
    removeRecord = removeExactPrivateRecord,
    syncParent = syncPrivateReceiptParentOnly,
    onTransition = () => {},
  } = {},
) {
  assertSupportedReceiptPlatform(platform, code);
  if (!output?.path || !output?.pendingPath || !output?.parent?.path ||
      typeof removeRecord !== "function" || typeof syncParent !== "function" ||
      typeof onTransition !== "function" ||
      dirname(output.path) !== output.parent.path ||
      dirname(output.pendingPath) !== output.parent.path ||
      output.pendingPath !== pendingReceiptPath(output.path) ||
      (output.commitPath !== undefined &&
        output.commitPath !== finalizationCommitPath(output.path)) ||
      (output.stagedPath !== undefined &&
        output.stagedPath !== stagedReceiptPath(output.path))) refuse(code);
  const path = resolve(output.path);
  const pendingPath = resolve(output.pendingPath);
  const commitPath = finalizationCommitPath(path);
  const stagedPath = stagedReceiptPath(path);
  const parent = assertPrivateDirectory(output.parent.path, code);
  if (path !== output.path || pendingPath !== output.pendingPath ||
      !sameInode(parent.info, output.parent.info)) refuse(code);
  assertPathAbsent(commitPath, code);
  assertPathAbsent(stagedPath, code);
  const markerBytes = serializedPrivateJson(marker, MAX_RECEIPT_BYTES, code);
  const markerHash = sha256(markerBytes);
  try {
    const present = [path, pendingPath].filter((candidate) => pathPresent(candidate, code));
    const records = present.map((candidate) => {
      const record = readPrivateAggregateReceiptFile(candidate, {
        code,
        maxBytes: markerBytes.length,
        absentPaths: [commitPath, stagedPath],
      });
      if (record.sha256 !== markerHash || record.info.size !== markerBytes.length) refuse(code);
      return record;
    });
    for (const record of records) rereadExactPrivateRecord(record, code, { guarded: false });
    for (const record of records) {
      assertPathAbsent(commitPath, code);
      const current = rereadExactPrivateRecord(record, code, { guarded: false });
      removeRecord(current, code, { guarded: false });
      syncParent(parent.path, parent.info, code, { platform });
      assertPathAbsent(record.path, code);
      assertPathAbsent(commitPath, code);
      assertPathAbsent(stagedPath, code);
      for (const remaining of records) {
        if (remaining.path !== record.path && pathPresent(remaining.path, code)) {
          rereadExactPrivateRecord(remaining, code, { guarded: false });
        }
      }
      onTransition(record.path === path ? "final_marker_removed" : "pending_marker_removed");
    }
    assertPathAbsent(path, code);
    assertPathAbsent(pendingPath, code);
    assertPathAbsent(commitPath, code);
    assertPathAbsent(stagedPath, code);
    syncParent(parent.path, parent.info, code, { platform });
    return Object.freeze({ status: records.length ? "cleared" : "already_absent" });
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    markerBytes.fill(0);
  }
}

/** Close an unfinished reservation without deleting its conservative marker. */
export function abandonPrivateAggregateReceipt(reservation) {
  if (!reservation || reservation.closed === true) return;
  try { closeReservationHandle(reservation); } catch { /* leave marker for review */ }
}

function readPrivateAggregateReceiptFile(path, {
  code = "PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED",
  maxBytes = MAX_RECEIPT_BYTES,
  readFile = readFileSync,
  absentPaths = [],
} = {}) {
  assertSupportedReceiptPlatform(process.platform, code);
  if (!isAbsolute(path || "") || !Array.isArray(absentPaths) ||
      absentPaths.some((entry) => !isAbsolute(entry || ""))) refuse(code);
  const absolute = resolve(path);
  const guards = absentPaths.map((entry) => resolve(entry));
  let parent;
  let before;
  let descriptor;
  let raw;
  try {
    parent = assertPrivateDirectory(dirname(absolute), code);
    for (const guard of guards) assertPathAbsent(guard, code);
    before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 1 || before.size > maxBytes ||
        realpathSync(absolute) !== absolute ||
        (process.platform !== "win32" && (before.mode & 0o077) !== 0)) refuse(code);
    assertOwner(before, code);
    before = assertNoDarwinAcl(absolute, before, code);
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameStableSingleFile(before, opened) ||
        (process.platform !== "win32" && (opened.mode & 0o077) !== 0)) refuse(code);
    assertOwner(opened, code);
    raw = readFile(descriptor);
    if (!Buffer.isBuffer(raw)) refuse(code);
    const afterOpened = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (!sameStableSingleFile(opened, afterOpened) ||
        !sameStableSingleFile(opened, afterPath) ||
        realpathSync(absolute) !== absolute ||
        (process.platform !== "win32" &&
          ((afterOpened.mode & 0o077) !== 0 || (afterPath.mode & 0o077) !== 0)) ||
        raw.length !== opened.size) refuse(code);
    assertOwner(afterOpened, code);
    assertOwner(afterPath, code);
    assertNoDarwinAcl(absolute, afterPath, code);
    const parentAfter = assertPrivateDirectory(parent.path, code);
    if (!sameInode(parent.info, parentAfter.info)) refuse(code);
    for (const guard of guards) assertPathAbsent(guard, code);
    let value;
    try { value = JSON.parse(raw.toString("utf8")); } catch { refuse(code); }
    return Object.freeze({
      path: absolute,
      info: opened,
      parent: Object.freeze({ path: parent.path, info: parent.info }),
      sha256: sha256(raw),
      value: Object.freeze(structuredClone(value)),
    });
  } catch (error) {
    if (error instanceof PrivateAggregateReceiptError) throw error;
    refuse(code);
  } finally {
    if (raw) raw.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Read and parse one stable owner-only aggregate receipt without echoing it. */
export function readPrivateAggregateReceipt(path, options = {}) {
  if (!isAbsolute(path || "")) {
    refuse(options.code ?? "PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED");
  }
  const absolute = resolve(path);
  return readPrivateAggregateReceiptFile(absolute, {
    ...options,
    absentPaths: [
      pendingReceiptPath(absolute),
      finalizationCommitPath(absolute),
      stagedReceiptPath(absolute),
    ],
  });
}
