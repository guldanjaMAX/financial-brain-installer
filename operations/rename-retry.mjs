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
