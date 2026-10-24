import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function canRetry(error, attempt) {
  return ["EPERM", "EACCES", "EBUSY"].includes(error?.code) && attempt < 9;
}

// Windows readers can briefly deny replacement of a staged file. Retry only
// rename, keeping the same bytes and caller-owned cleanup and permission work.
// Ten attempts have at most 2,025 ms of backoff; the final native error wins.
export function renameWithRetrySync(from, to, {
  rename: renameImpl = renameSync,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameImpl(from, to);
    } catch (error) {
      if (!canRetry(error, attempt)) throw error;
      sleep(225);
    }
  }
}

// Promise-based writers must yield while waiting, while synchronous checkpoint
// callers above must finish persistence before advancing their source cursor.
export async function renameWithRetry(from, to, {
  rename: renameImpl = rename,
  sleep = delay,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await renameImpl(from, to);
    } catch (error) {
      if (!canRetry(error, attempt)) throw error;
      await sleep(225);
    }
  }
}
