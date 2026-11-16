import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function canRetry(error, attempt, platform) {
  return platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code) && attempt < 9;
}

export const RENAME_IDENTITY_KEYS = Object.freeze(["dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs", "mode"]);
const BIGINT_IDENTITY_KEYS = Object.freeze(["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs", "mode"]);

function isBigintIdentity(identity) { return typeof identity?.ino === "bigint"; }

function regularSingleFile(identity) {
  return identity?.isFile() && !identity.isSymbolicLink()
    && identity.nlink === (isBigintIdentity(identity) ? 1n : 1);
}

function sameInode(actual, expected) {
  return regularSingleFile(actual) && regularSingleFile(expected)
    && typeof actual.dev === typeof expected.dev && typeof actual.ino === typeof expected.ino
    && actual.dev === expected.dev && actual.ino === expected.ino;
}

export function captureRenameIdentity(path, { lstat = lstatSync, bigint = false } = {}) {
  try { return lstat(path, { bigint }); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// A pathname can change while Windows releases a reader. Keep the expected
// predecessor and staging inode pinned; callers retain their own refusal code.
export function sameRenameIdentity(actual, expected) {
  if (!sameInode(actual, expected)) return false;
  const keys = isBigintIdentity(expected) ? BIGINT_IDENTITY_KEYS : RENAME_IDENTITY_KEYS;
  return keys.every(key => typeof actual[key] === typeof expected[key]
    && (typeof expected[key] === "number" || typeof expected[key] === "bigint")
    && actual[key] === expected[key]);
}

export function renameIdentityMatches(path, expected, { lstat = lstatSync } = {}) {
  try {
    const actual = captureRenameIdentity(path, { lstat, bigint: isBigintIdentity(expected) });
    if (actual === null || expected === null) return actual === expected;
    return sameRenameIdentity(actual, expected);
  } catch { return false; }
}

function proofIo(overrides) {
  return { lstatSync, openSync, fstatSync, readSync, closeSync, unlinkSync, ...overrides };
}

function sameStagedIdentity(actual, expected) {
  if (!sameInode(actual, expected)) return false;
  const keys = isBigintIdentity(expected) ? BIGINT_IDENTITY_KEYS : RENAME_IDENTITY_KEYS;
  return keys.filter(key => key !== "ctimeMs" && key !== "ctimeNs").every(key =>
    typeof actual[key] === typeof expected[key]
    && (typeof expected[key] === "number" || typeof expected[key] === "bigint")
    && actual[key] === expected[key]);
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const baselineRetries = new WeakMap();

// ACL changes can move Windows change time after the post-close baseline;
// POSIX chmod and sync clients also change it without changing owned bytes.
// Keep ctime out of this byte-backed proof on every platform. Metadata-only
// predecessor checks retain their existing stricter exported comparator.
function observeStagedBytes(path, expected, bytes, { fs = {} } = {}) {
  let io, descriptor, observed, probe, operation;
  try {
    io = proofIo(fs);
    if (!regularSingleFile(expected)) return false;
    const intended = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const bigint = isBigintIdentity(expected);
    const length = bigint ? BigInt(intended.length) : intended.length;
    const actual = io.lstatSync(path, { bigint });
    if (actual.size !== length || !sameStagedIdentity(actual, expected)) return false;
    operation = "open";
    descriptor = io.openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    operation = undefined;
    if (!sameStagedIdentity(io.fstatSync(descriptor, { bigint }), expected)) return false;
    observed = Buffer.alloc(intended.length);
    let total = 0;
    while (total < intended.length) {
      operation = "read";
      const count = io.readSync(descriptor, observed, total, intended.length - total, total);
      operation = undefined;
      if (!Number.isInteger(count) || count <= 0 || count > intended.length - total) return false;
      total += count;
    }
    probe = Buffer.alloc(1);
    operation = "read";
    const trailing = io.readSync(descriptor, probe, 0, 1, intended.length);
    operation = undefined;
    if (trailing !== 0) return false;
    if (!timingSafeEqual(observed, intended)) return false;
    if (!sameStagedIdentity(io.fstatSync(descriptor, { bigint }), expected)) return false;
    const closing = descriptor;
    descriptor = undefined;
    io.closeSync(closing);
    return sameStagedIdentity(io.lstatSync(path, { bigint }), expected);
  } catch (error) {
    // A sharing lock denies observation; it does not prove changed bytes.
    // Only the retrying callers may spend their budget on this third outcome.
    return operation === "open" || operation === "read" ? { error } : false;
  }
  finally {
    observed?.fill(0);
    probe?.fill(0);
    if (descriptor !== undefined) {
      try { io.closeSync(descriptor); }
      catch {
        // A failed close makes descriptor custody uncertain. Do not turn an
        // earlier sharing refusal into another open with that handle unresolved.
        return false;
      }
    }
  }
}

export function stagedBytesMatch(path, expected, bytes, { fs = {} } = {}) {
  return observeStagedBytes(path, expected, bytes, { fs }) === true;
}

// Capture only after all writes, metadata changes and descriptor close. The
// create-time inode binds this observation to this attempt's exclusive create.
export function captureStagedProof(path, bytes, created, { fs = {} } = {}) {
  return captureStagedProofWithRetry(path, bytes, created, { fs });
}

// Keep the original capture API synchronous and nullable. The explicit variant
// provides injected platform/backoff boundaries without changing that contract.
export function captureStagedProofWithRetry(path, bytes, created, {
  fs = {}, platform = process.platform, sleep = sleepSync,
} = {}) {
  try {
    const io = proofIo(fs);
    let expected;
    for (let attempt = 0; ; attempt++) {
      let result;
      try {
        expected ??= io.lstatSync(path, { bigint: isBigintIdentity(created) });
        if (!sameInode(expected, created)) return null;
        result = observeStagedBytes(path, expected, bytes, { fs: io });
      } catch (error) { result = { error }; }
      if (result === true) {
        // Baseline observation and publication share the same wait budget.
        // Keep this bookkeeping private; the returned proof remains a Stats.
        baselineRetries.set(expected, attempt);
        return Object.freeze(expected);
      }
      if (!result || !canRetry(result.error, attempt, platform)) return null;
      sleep(225);
    }
  } catch { return null; }
}

// Staging cleanup requires a successful exclusive create and no publication.
// An authorized destination removal additionally supplies its exact publication
// or approved snapshot proof and bytes; path or content equality is not authority.
// Node exposes no unlink-by-handle primitive: the final pathname check reduces
// accidental replacement deletion, but cannot make check-plus-unlink atomic.
export function removeOwnedStaging(path, created, { proof, bytes = null, fs = {} } = {}) {
  try {
    const io = proofIo(fs);
    if (!regularSingleFile(created)) return false;
    const current = captureRenameIdentity(path, { lstat: io.lstatSync, bigint: isBigintIdentity(created) });
    if (current === null || !sameInode(current, created)) return false;
    // An explicitly null proof means capture refused. Only an omitted proof
    // permits creation-identity-only cleanup of an unpublished staging file.
    if (proof !== undefined && !stagedBytesMatch(path, proof, bytes, { fs: io })) return false;
    io.unlinkSync(path);
    return captureRenameIdentity(path, { lstat: io.lstatSync, bigint: isBigintIdentity(created) }) === null;
  } catch { return false; }
}

function requireStagedBytes(path, staged, fs, attempt, platform) {
  if (!staged) return true;
  const result = observeStagedBytes(path, staged.expected, staged.bytes, { fs });
  if (result === true) return true;
  if (result && canRetry(result.error, attempt, platform)) return false;
  staged.refuse();
  throw new Error("the staged file changed before it could be replaced");
}

// Windows readers can briefly deny replacement of a staged file. Retry only
// rename or a temporarily unobservable byte proof, keeping the same bytes and
// caller-owned cleanup and permission work. Definite proof refusals never retry.
// Ten Windows attempts have at most 2,025 ms of backoff. Every attempt requires
// fresh caller-owned identity or lifecycle-lock proof, including the first one.
export function renameWithRetrySync(from, to, {
  revalidate,
  staged,
  fs,
  platform = process.platform,
  rename: renameImpl = renameSync,
  sleep = sleepSync,
} = {}) {
  for (let attempt = baselineRetries.get(staged?.expected) || 0; ; attempt++) {
    revalidate();
    if (!requireStagedBytes(from, staged, fs, attempt, platform)) {
      sleep(225);
      continue;
    }
    try {
      return renameImpl(from, to);
    } catch (error) {
      if (!canRetry(error, attempt, platform)) throw error;
      sleep(225);
    }
  }
}

// Promise-based writers must yield while waiting, while synchronous checkpoint
// callers above must finish persistence before advancing their source cursor.
export async function renameWithRetry(from, to, {
  revalidate,
  staged,
  fs,
  platform = process.platform,
  rename: renameImpl = rename,
  sleep = delay,
} = {}) {
  for (let attempt = baselineRetries.get(staged?.expected) || 0; ; attempt++) {
    await revalidate();
    // This synchronous proof and the rename invocation share one turn.
    if (!requireStagedBytes(from, staged, fs, attempt, platform)) {
      await sleep(225);
      continue;
    }
    try {
      return await renameImpl(from, to);
    } catch (error) {
      if (!canRetry(error, attempt, platform)) throw error;
      await sleep(225);
    }
  }
}

// Receipts and update state are staged beside their destination, then renamed
// over it. Windows refuses that rename while a virus scan, indexer, backup or
// sync client still holds either name open. Retry only that sharing refusal,
// with a short growing backoff (1,900 ms in all), and only while our own staged
// file is still present: a vanished source means the outcome is unknown, so
// the original error stands. A Windows host retries whichever platform a
// caller models, because the host's file system is what holds the lock.
export const LOCAL_FILE_LOCKED = "LOCAL_FILE_LOCKED";
export const FILE_REPLACE_DELAYS_MS = Object.freeze([50, 100, 250, 500, 1000]);
const FILE_SHARING_REFUSALS = Object.freeze(["EPERM", "EACCES", "EBUSY"]);

function localFileLocked(cause, attempts, action = "save") {
  const error = new Error(
    `Windows kept a Brain file in use through ${attempts} ${action} attempts (${cause.code}), so it was left unchanged. ` +
      "Close any program that may be reading the Brain folder, such as a backup, sync or virus scan, then run the same command again.",
    { cause },
  );
  error.code = cause.code;
  error.supportCode = LOCAL_FILE_LOCKED;
  error.renameAttempts = attempts;
  return error;
}

// Windows refuses to replace a file that carries the read-only attribute with
// the same EPERM a sharing lock gives. Waiting never clears it, so it is named
// at once rather than retried and misreported as a program holding the file.
function localFileReadOnly(cause) {
  const error = new Error(
    `Windows would not replace a Brain file because the file is marked read-only (${cause.code}), so it was left unchanged. ` +
      "Turn off the read-only setting on the files in the Brain folder, then run the same command again.",
    { cause },
  );
  error.code = cause.code;
  error.supportCode = LOCAL_FILE_LOCKED;
  error.readOnlyDestination = true;
  error.renameAttempts = 1;
  return error;
}

// Node reports the Windows read-only attribute as a missing owner write bit.
function readOnlyFile(path) {
  try {
    const state = lstatSync(path);
    return state.isFile() && (state.mode & 0o200) === 0;
  } catch { return false; }
}

// An unobservable path counts as present: present staging keeps a retry
// possible, and a present destination stops one.
function pathPresent(path) {
  try { return captureRenameIdentity(path) !== null; }
  catch { return true; }
}

export function replaceFileWithRetrySync(from, to, {
  platform = process.platform,
  rename: renameImpl = renameSync,
  sleep = sleepSync,
  revalidate = () => {},
} = {}) {
  const windows = platform === "win32" || process.platform === "win32";
  for (let attempt = 0; ; attempt++) {
    revalidate();
    try {
      return renameImpl(from, to);
    } catch (error) {
      if (!windows || !FILE_SHARING_REFUSALS.includes(error?.code) || !pathPresent(from)) throw error;
      if (readOnlyFile(to)) throw localFileReadOnly(error);
      if (attempt >= FILE_REPLACE_DELAYS_MS.length) throw localFileLocked(error, attempt + 1);
      sleep(FILE_REPLACE_DELAYS_MS[attempt]);
    }
  }
}

// A finished step removes its receipt. A reader that opened the receipt
// without delete sharing makes Windows refuse that removal for a moment. Retry
// only that refusal, on the same file: a file that is already gone is the
// intended result, and a file replaced under the same name is never removed.
export function removeFileWithRetrySync(path, {
  platform = process.platform,
  unlink: unlinkImpl = unlinkSync,
  sleep = sleepSync,
} = {}) {
  const windows = platform === "win32" || process.platform === "win32";
  let pinned = null;
  try { pinned = captureRenameIdentity(path); } catch { /* The removal below reports it. */ }
  for (let attempt = 0; ; attempt++) {
    try {
      return unlinkImpl(path);
    } catch (error) {
      if (!windows || !FILE_SHARING_REFUSALS.includes(error?.code) || !regularSingleFile(pinned)) throw error;
      let current;
      try { current = captureRenameIdentity(path); } catch { throw error; }
      if (current === null) return undefined;
      if (!sameInode(current, pinned)) throw error;
      if (attempt >= FILE_REPLACE_DELAYS_MS.length) throw localFileLocked(error, attempt + 1, "removal");
      sleep(FILE_REPLACE_DELAYS_MS[attempt]);
    }
  }
}

// A lock folder is written under a private name, then renamed into place.
// Windows refuses that rename while a scanner still holds the new owner
// record. Retry only while our folder is still staged and nothing has taken
// the name: an existing destination is a real competitor, never waited for.
export function publishDirectoryWithRetrySync(from, to, {
  platform = process.platform,
  rename: renameImpl = renameSync,
  sleep = sleepSync,
} = {}) {
  const windows = platform === "win32" || process.platform === "win32";
  for (let attempt = 0; ; attempt++) {
    try {
      return renameImpl(from, to);
    } catch (error) {
      if (!windows || !FILE_SHARING_REFUSALS.includes(error?.code) || !pathPresent(from) || pathPresent(to)) throw error;
      if (attempt >= FILE_REPLACE_DELAYS_MS.length) throw localFileLocked(error, attempt + 1, "publish");
      sleep(FILE_REPLACE_DELAYS_MS[attempt]);
    }
  }
}
