import { lstatSync, renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function canRetry(error, attempt, platform) {
  return platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code) && attempt < 9;
}

export function captureRenameIdentity(path, { lstat = lstatSync } = {}) {
  try { return lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// A pathname can change while Windows releases a reader. Keep the expected
// predecessor and staging inode pinned; callers retain their own refusal code.
export function renameIdentityMatches(path, expected, { lstat = lstatSync } = {}) {
  try {
    const actual = captureRenameIdentity(path, { lstat });
    if (actual === null || expected === null) return actual === expected;
    return actual.isFile() && expected.isFile()
      && !actual.isSymbolicLink() && !expected.isSymbolicLink()
      && ["dev", "ino", "nlink", "size", "mtimeMs", "mode"].every(key => actual[key] === expected[key]);
  } catch { return false; }
}

// Windows readers can briefly deny replacement of a staged file. Retry only
// rename, keeping the same bytes and caller-owned cleanup and permission work.
// Ten Windows attempts have at most 2,025 ms of backoff. Every attempt requires
// fresh caller-owned identity or lifecycle-lock proof, including the first one.
export function renameWithRetrySync(from, to, {
  revalidate,
  platform = process.platform,
  rename: renameImpl = renameSync,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    revalidate();
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
  platform = process.platform,
  rename: renameImpl = rename,
  sleep = delay,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    await revalidate();
    try {
      return await renameImpl(from, to);
    } catch (error) {
      if (!canRetry(error, attempt, platform)) throw error;
      await sleep(225);
    }
  }
}
