/**
 * Durable, owner-only aggregate receipt writes for supervised field gates.
 *
 * The final path is reserved before any external mutation. Finalization keeps
 * the staged descriptor open through rename, exact readback, and the directory
 * durability barrier. Native Windows is refused because mode bits and uid do
 * not prove a current-user-only DACL, and this helper has no DACL verifier.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
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

export function privateAggregateReceiptPendingPath(path) {
  if (!isAbsolute(path || "")) {
    refuse("PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED");
  }
  return pendingReceiptPath(resolve(path));
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

/** Validate a new absolute receipt destination and bind its private parent. */
export function assertPrivateAggregateOutputPath(path, {
  code = "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED",
} = {}) {
  assertSupportedReceiptPlatform(process.platform, code);
  if (!isAbsolute(path || "")) refuse(code);
  const absolute = resolve(path);
  const parent = assertPrivateDirectory(dirname(absolute), code);
  const pendingPath = pendingReceiptPath(absolute);
  assertPathAbsent(absolute, "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_EXISTS");
  assertPathAbsent(pendingPath, "PRIVATE_AGGREGATE_RECEIPT_OUTPUT_PENDING");
  return Object.freeze({ path: absolute, pendingPath, parent });
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
    // This unlink is the commit point and deliberately the last fallible
    // operation. The final receipt and its directory entry were already
    // flushed and every descriptor was closed. A crash can conservatively
    // resurrect this pending marker, but final-only can never mean an
    // unverified post-rename failure.
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

/** Reserve the final path with a durable exact marker before external work. */
export function reservePrivateAggregateReceipt(output, marker) {
  assertSupportedReceiptPlatform(
    process.platform,
    "PRIVATE_AGGREGATE_RECEIPT_PLATFORM_UNSUPPORTED",
  );
  if (!output?.path || !output?.pendingPath || !output?.parent?.path ||
      dirname(output.path) !== output.parent.path ||
      dirname(output.pendingPath) !== output.parent.path ||
      output.pendingPath !== pendingReceiptPath(output.path)) {
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

/** Replace a reserved marker with one exact, durably read-back JSON receipt. */
export function finalizePrivateAggregateReceipt(reservation, receipt, {
  writeBytes = writePrivateReceiptDescriptor,
  readBytes = readPrivateReceiptDescriptor,
  syncFile = fsyncSync,
  rename = renameSync,
  syncDirectory = syncReservationDirectory,
  removePending = removePendingReceiptMarker,
  platform = process.platform,
  closeReservation = closeSync,
  closeTemporary = closeSync,
  random = randomBytes,
} = {}) {
  assertSupportedReceiptPlatform(platform, "PRIVATE_AGGREGATE_RECEIPT_PLATFORM_UNSUPPORTED");
  validateReservation(reservation, "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED");
  const temporaryPath = join(
    reservation.parentPath,
    `.private-aggregate-receipt-${random(12).toString("hex")}.tmp`,
  );
  let temporaryDescriptor;
  let temporaryIdentity = null;
  let temporaryInfo = null;
  let renamed = false;
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if (bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    }
    temporaryDescriptor = openSync(
      temporaryPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    temporaryIdentity = assertPrivateEmptyReceiptFile(
      temporaryPath,
      temporaryDescriptor,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID",
      platform,
    );
    writeBytes(temporaryDescriptor, bytes);
    syncFile(temporaryDescriptor);
    fchmodSync(temporaryDescriptor, 0o600);
    temporaryInfo = fstatSync(temporaryDescriptor);
    const temporaryCurrent = lstatSync(temporaryPath);
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1 ||
        temporaryInfo.size !== bytes.length ||
        (platform !== "win32" && (temporaryInfo.mode & 0o077) !== 0) ||
        !sameFile(temporaryInfo, temporaryCurrent)) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    }
    temporaryInfo = assertNoDarwinAcl(
      temporaryPath,
      temporaryInfo,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID",
      { platform },
    );
    if (!sameStableSingleFile(temporaryInfo, fstatSync(temporaryDescriptor))) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_INVALID");
    }
    validateReservation(reservation, "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED");
    let closedReservationInfo = null;
    if (platform === "win32") {
      closeReservationHandle(reservation, closeReservation);
      closedReservationInfo = validateClosedReservation(
        reservation,
        "PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED",
        platform,
      );
      if (!sameStableSingleFile(temporaryInfo, lstatSync(temporaryPath)) ||
          !sameStableSingleFile(closedReservationInfo, lstatSync(reservation.path))) {
        refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED");
      }
    }
    rename(temporaryPath, reservation.path);
    renamed = true;
    const finalCurrent = lstatSync(reservation.path);
    const finalOpened = fstatSync(temporaryDescriptor);
    if (!finalCurrent.isFile() || finalCurrent.isSymbolicLink() || finalCurrent.nlink !== 1 ||
        !sameFile(temporaryInfo, finalCurrent) ||
        !sameStableSingleFile(finalCurrent, finalOpened) ||
        (platform !== "win32" && fstatSync(reservation.descriptor).nlink !== 0)) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED");
    }
    assertNoDarwinAcl(
      reservation.path,
      finalCurrent,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED",
      { platform },
    );
    let readback;
    let verifiedCurrent;
    try {
      readback = Buffer.alloc(bytes.length);
      readBytes(temporaryDescriptor, readback);
      if (!readback.equals(bytes)) refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED");
      const openedAfterRead = fstatSync(temporaryDescriptor);
      verifiedCurrent = lstatSync(reservation.path);
      if (!sameStableSingleFile(finalOpened, openedAfterRead) ||
          !sameStableSingleFile(finalCurrent, verifiedCurrent) ||
          !sameStableSingleFile(verifiedCurrent, openedAfterRead)) {
        refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED");
      }
    } finally {
      if (readback) readback.fill(0);
    }
    syncDirectory(
      reservation,
      "PRIVATE_AGGREGATE_RECEIPT_PARENT_CHANGED",
      verifiedCurrent,
    );
    const durableCurrent = lstatSync(reservation.path);
    const durableParent = assertBoundPrivateDirectory(
      reservation.parentPath,
      reservation.parentInfo,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED",
      { platform },
    );
    if (!sameStableSingleFile(verifiedCurrent, durableCurrent) ||
        !sameInode(durableParent, reservation.parentInfo)) {
      refuse("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED");
    }
    assertNoDarwinAcl(
      reservation.path,
      durableCurrent,
      "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED",
      { platform },
    );
    closeTemporary(temporaryDescriptor);
    temporaryDescriptor = undefined;
    if (!reservation.closed) closeReservationHandle(reservation, closeReservation);
    removePending(
      reservation,
      "PRIVATE_AGGREGATE_RECEIPT_PENDING_CHANGED",
      platform,
      {
        info: durableCurrent,
        parentInfo: durableParent,
        size: bytes.length,
        sha256: sha256(bytes),
      },
    );
    return true;
  } catch (error) {
    if (!renamed && temporaryIdentity) {
      try {
        const current = lstatSync(temporaryPath);
        const opened = temporaryDescriptor === undefined ? null : fstatSync(temporaryDescriptor);
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
            sameInode(temporaryIdentity, current) &&
            (!opened || sameInode(temporaryIdentity, opened))) unlinkSync(temporaryPath);
      } catch {
        // Leave ambiguous private siblings untouched for review.
      }
    }
    throw error;
  } finally {
    if (bytes) bytes.fill(0);
    if (temporaryDescriptor !== undefined) {
      try { closeSync(temporaryDescriptor); } catch { /* marker remains */ }
    }
  }
}

/** Close an unfinished reservation without deleting its conservative marker. */
export function abandonPrivateAggregateReceipt(reservation) {
  if (!reservation || reservation.closed === true) return;
  try { closeReservationHandle(reservation); } catch { /* leave marker for review */ }
}

/** Read and parse one stable owner-only aggregate receipt without echoing it. */
export function readPrivateAggregateReceipt(path, {
  code = "PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED",
  maxBytes = MAX_RECEIPT_BYTES,
  readFile = readFileSync,
} = {}) {
  assertSupportedReceiptPlatform(process.platform, code);
  if (!isAbsolute(path || "")) refuse(code);
  const absolute = resolve(path);
  const pendingPath = pendingReceiptPath(absolute);
  let parent;
  let before;
  let descriptor;
  let raw;
  try {
    parent = assertPrivateDirectory(dirname(absolute), code);
    assertPathAbsent(pendingPath, code);
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
    assertPathAbsent(pendingPath, code);
    let value;
    try { value = JSON.parse(raw.toString("utf8")); } catch { refuse(code); }
    return Object.freeze({
      path: absolute,
      info: opened,
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
