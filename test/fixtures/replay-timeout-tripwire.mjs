// Inject one timeout at the actual worker boundary, then run a real green
// child. A CLI wrapper must leave room for both arms and their single retry.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const realSpawn = childProcess.spawnSync;
let attempts = 0;
const timedOut = () => ({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: 'SYNTHETIC_TIMEOUT' });
childProcess.spawnSync = (command, args, options) => {
  if (args.some(arg => /[\\/]private-ledger-replay\.mjs$/.test(arg))) {
    if (options.timeout < 490000) {
      process.stderr.write('REPLAY_OUTER_BUDGET_SHORT\n');
      return timedOut();
    }
    process.stderr.write('REPLAY_OUTER_BUDGET_REACHED\n');
    const child = realSpawn(command, ['--import', import.meta.url, ...args], options);
    // Forward fixture counters separately so the original CLI assertions still
    // inspect actual CLI stderr, including the launcher's recovery diagnostic.
    child.stderr = String(child.stderr || '').split('\n').filter(line => {
      if (!/^REPLAY_TIMEOUT_(?:DECISION_REACHED|GREEN_REACHED attempts=\d+)$/.test(line)) return true;
      process.stderr.write(line + '\n');
      return false;
    }).join('\n');
    if (new URL(import.meta.url).searchParams.has('unexpected-stderr') && child.status === 0) child.stderr += 'REPLAY_CHILD_TIMEOUT malformed\n';
    return child;
  }
  if (args.some(arg => /[\\/]private-ledger-worker\.mjs$/.test(arg))) {
    attempts++;
    if (attempts === 1) {
      process.stderr.write('REPLAY_TIMEOUT_DECISION_REACHED\n');
      return timedOut();
    }
    const child = realSpawn(command, args, options);
    if (child.status === 0) process.stderr.write(`REPLAY_TIMEOUT_GREEN_REACHED attempts=${attempts}\n`);
    return child;
  }
  return realSpawn(command, args, options);
};
syncBuiltinESMExports();
