import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const stderrTail = child => String(child.stderr || '').slice(-400).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ');

// Only an OS timeout permits one fresh, identical replay. Product failures,
// permission refusals and malformed results must remain visible on attempt 1.
export function runReplayChild({ label, args, options, spawn = spawnSync,
  beforeAttempt = () => {}, writeStderr = line => process.stderr.write(line), now = () => performance.now(),
  failureMessage = child => `${label}_CHILD_FAILED:${child.status}:${child.error?.code || String(child.stderr || '').slice(0, 300)}` }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    beforeAttempt();
    const started = now();
    // spawnSync otherwise waits forever for a timed-out child ignoring SIGTERM.
    const child = spawn(process.execPath, args, { ...options, timeout: 120000, killSignal: 'SIGKILL' });
    const timedOut = child.status === null && child.error?.code === 'ETIMEDOUT';
    if (timedOut) {
      writeStderr(`REPLAY_CHILD_TIMEOUT ${label} attempt=${attempt} ms=${Math.round(now() - started)} stderr=${stderrTail(child)}\n`);
      if (attempt === 1) continue;
    }
    if (child.status !== 0 || child.error) throw Error(`${failureMessage(child)}${timedOut ? ` stderr=${stderrTail(child)}` : ''}`);
    return child;
  }
}
