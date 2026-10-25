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

// Change time is useful metadata, but does not bind bytes on Windows: a
// same-user handle can set or suppress timestamp updates. Exact bounded bytes
// are the authority. Keep the descriptor and pathname brackets around the read.
export function stagedBytesMatch(path, expected, bytes, { fs = {} } = {}) {
  let io, descriptor, observed, probe;
  try {
    io = proofIo(fs);
    if (!regularSingleFile(expected)) return false;
    const intended = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const bigint = isBigintIdentity(expected);
    const length = bigint ? BigInt(intended.length) : intended.length;
    const actual = io.lstatSync(path, { bigint });
    if (actual.size !== length || !sameRenameIdentity(actual, expected)) return false;
    descriptor = io.openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!sameRenameIdentity(io.fstatSync(descriptor, { bigint }), expected)) return false;
    observed = Buffer.alloc(intended.length);
    let total = 0;
    while (total < intended.length) {
      const count = io.readSync(descriptor, observed, total, intended.length - total, total);
      if (!Number.isInteger(count) || count <= 0 || count > intended.length - total) return false;
      total += count;
    }
    probe = Buffer.alloc(1);
    if (io.readSync(descriptor, probe, 0, 1, intended.length) !== 0) return false;
    if (!timingSafeEqual(observed, intended)) return false;
    if (!sameRenameIdentity(io.fstatSync(descriptor, { bigint }), expected)) return false;
    const closing = descriptor;
    descriptor = undefined;
    io.closeSync(closing);
    return sameRenameIdentity(io.lstatSync(path, { bigint }), expected);
  } catch { return false; }
  finally {
    observed?.fill(0);
    probe?.fill(0);
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
  }
}

// Capture only after all writes, metadata changes and descriptor close. The
// create-time inode binds this observation to this attempt's exclusive create.
export function captureStagedProof(path, bytes, created, { fs = {} } = {}) {
  try {
    const io = proofIo(fs);
    const expected = io.lstatSync(path, { bigint: isBigintIdentity(created) });
    if (!sameInode(expected, created) || !stagedBytesMatch(path, expected, bytes, { fs: io })) return null;
    return Object.freeze(expected);
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

function requireStagedBytes(path, staged, fs) {
  if (staged && !stagedBytesMatch(path, staged.expected, staged.bytes, { fs })) {
    staged.refuse();
    throw new Error("the staged file changed before it could be replaced");
  }
}

// Windows readers can briefly deny replacement of a staged file. Retry only
// rename, keeping the same bytes and caller-owned cleanup and permission work.
// Ten Windows attempts have at most 2,025 ms of backoff. Every attempt requires
// fresh caller-owned identity or lifecycle-lock proof, including the first one.
export function renameWithRetrySync(from, to, {
  revalidate,
  staged,
  fs,
  platform = process.platform,
  rename: renameImpl = renameSync,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    revalidate();
    requireStagedBytes(from, staged, fs);
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
  for (let attempt = 0; ; attempt++) {
    await revalidate();
    // This synchronous proof and the rename invocation share one turn.
    requireStagedBytes(from, staged, fs);
    try {
      return await renameImpl(from, to);
    } catch (error) {
      if (!canRetry(error, attempt, platform)) throw error;
      await sleep(225);
    }
  }
}
