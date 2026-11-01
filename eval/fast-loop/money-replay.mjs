import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BASE_CASES, CONTROLS, evidence, validateInputs } from '../../test/fixtures/fastloop-money/input.mjs';

export const ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
export const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function waitForQuiet(env) {
  // Windows has no host quiet-file protocol or POSIX shell. On this host the
  // exact required loop runs immediately before every child Node invocation.
  if (process.platform !== 'win32') {
    const quiet = spawnSync('/bin/sh', ['-c', 'while [ -e /Users/jamesguldan/brain-work/MAC-QUIET ]; do sleep 60; done'],
      { env, timeout: 600000, encoding: 'utf8' });
    if (quiet.status !== 0) throw Error('MAC_QUIET_HELD');
  }
  if (existsSync('/Users/jamesguldan/brain-work/MAC-QUIET')) throw Error('MAC_QUIET_HELD');
}
export function replay({ cases = [...BASE_CASES, ...CONTROLS], fault = null, sourceOverrides = {} } = {}) {
  validateInputs(cases);
  // Only the three reviewed Batch 1 modules may be restored for a baseline or
  // mutant. The VM import/capability boundary and actual source hashes remain.
  for (const [name, source] of Object.entries(sourceOverrides)) if (
    !['ledger-analysis.js', 'ledger-answer.js', 'ledger-question.js'].includes(name) ||
    typeof source !== 'string' || !source.length) throw Error('INVALID_SOURCE_OVERRIDE');
  const inputs = cases.map(c => ({ ...c, snapshot: evidence(c.profile) }));
  // This is a trusted launcher, outside the product capability compartment.
  // No desktop environment, credentials, or model allowance enter the child.
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(ROOT, 'lane-evidence/home-fastloop'),
    BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[name]) env[name] = process.env[name];
  waitForQuiet(env);
  const start = performance.now();
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--permission', `--allow-fs-read=${ROOT}`,
    '--import', fileURLToPath(new URL('../../test/fixtures/cli-side-effect-tripwire.mjs', import.meta.url)),
    fileURLToPath(new URL('./money-worker.mjs', import.meta.url))], {
    cwd: ROOT, env, input: JSON.stringify({ root: ROOT, inputs, fault, sourceOverrides }),
    encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0) throw Error(`REPLAY_CHILD_FAILED:${child.status}:${child.error?.code || child.stderr.slice(0, 300)}`);
  const result = JSON.parse(child.stdout);
  result.harness_digest = sha(['./money-replay.mjs', './money-worker.mjs',
    '../../test/fixtures/cli-side-effect-tripwire.mjs', '../../test/fixtures/fastloop-money/input.mjs']
    .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')));
  result.wall_ms = performance.now() - start;
  result.input_set_digest = sha(inputs);
  result.bank_version = 'money-day1-v1';
  result.observation_digest = sha(result.observations);
  return result;
}
