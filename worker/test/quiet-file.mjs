import { existsSync } from 'node:fs';

// Lane hosts may supply a quiet-file locator. Shared tests have no machine
// default and need no POSIX shell, including when running on Windows.
export function waitForQuietFile({
  quietFile = process.env.BRAIN_TEST_QUIET_FILE,
  exists = existsSync,
  wait = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  while (quietFile && exists(quietFile)) wait(60_000);
}
