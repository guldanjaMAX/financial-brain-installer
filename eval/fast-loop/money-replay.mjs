import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BASE_CASES, CONTROLS, evidence, validateInputs } from '../../test/fixtures/fastloop-money/input.mjs';
import { runReplayChild } from './child-run.mjs';

export const ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
// The host quiet file sits beside the checkout; override with BRAIN_MAC_QUIET_FILE.
export const QUIET_FILE = process.env.BRAIN_MAC_QUIET_FILE || resolve(ROOT, '..', 'MAC-QUIET');
export const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const PINNED_HTTP_BASELINE = Object.freeze({
  'money-veto.js': '7a49c89bfa75cc702a9668b98cc198de9a2f37fd76652b204ffedded6f2b5788',
});
export function waitForQuiet(env) {
  // Windows has no host quiet-file protocol or POSIX shell. On this host the
  // exact required loop runs immediately before every child Node invocation.
  if (process.platform !== 'win32') {
    const quiet = spawnSync('/bin/sh', ['-c', 'while [ -e "$BRAIN_MAC_QUIET_FILE" ]; do sleep 60; done'],
      { env: { ...env, BRAIN_MAC_QUIET_FILE: QUIET_FILE }, timeout: 600000, encoding: 'utf8' });
    if (quiet.status !== 0) throw Error('MAC_QUIET_HELD');
  }
  if (existsSync(QUIET_FILE)) throw Error('MAC_QUIET_HELD');
}
export function validateSourceOverrides(sourceOverrides) {
  // Only the reviewed ledger and import modules may be restored for a baseline or
  // mutant. The VM import/capability boundary and actual source hashes remain.
  for (const [name, source] of Object.entries(sourceOverrides)) if (
    typeof source !== 'string' || !source.length ||
    (!['ledger-analysis.js', 'ledger-answer.js', 'ledger-question.js', 'ledger-reader.js', 'fin-import.js', 'fin-d1.js'].includes(name) &&
      (!Object.hasOwn(PINNED_HTTP_BASELINE, name) || sha(source) !== PINNED_HTTP_BASELINE[name])))
    throw Error('INVALID_SOURCE_OVERRIDE');
}
export function replay({ cases = [...BASE_CASES, ...CONTROLS], fault = null,
  sourceOverrides = {}, validateCases = validateInputs,
  snapshotFor = c => c.snapshot || evidence(c.profile, c.account_reviews) } = {}, { spawn, writeStderr } = {}) {
  validateCases(cases);
  validateSourceOverrides(sourceOverrides);
  const inputs = cases.map(c => ({ ...c, snapshot: snapshotFor(c) }));
  // This is a trusted launcher, outside the product capability compartment.
  // No desktop environment, credentials, or model allowance enter the child.
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(ROOT, 'lane-evidence/home-fastloop'),
    BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[name]) env[name] = process.env[name];
  const start = performance.now();
  // ESM preloads need file URLs on Windows; the script argument stays a native path.
  const child = runReplayChild({ label: 'REPLAY', spawn, writeStderr, beforeAttempt: () => waitForQuiet(env),
    args: ['--experimental-vm-modules', '--permission', `--allow-fs-read=${ROOT}`,
    '--import', new URL('../../test/fixtures/cli-side-effect-tripwire.mjs', import.meta.url).href,
    fileURLToPath(new URL('./money-worker.mjs', import.meta.url))], options: {
    cwd: ROOT, env, input: JSON.stringify({ root: ROOT, inputs, fault, sourceOverrides }),
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  } });
  const result = JSON.parse(child.stdout);
  result.harness_digest = sha(['./money-replay.mjs', './money-worker.mjs', './child-run.mjs', './child-stall.mjs', './ledger-sql-contracts.mjs',
    '../../worker/src/lib/fin-account-kinds.js', '../../worker/src/lib/fin-account-links.js',
    '../../test/fixtures/cli-side-effect-tripwire.mjs', '../../test/fixtures/fastloop-money/input.mjs']
    .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')));
  result.wall_ms = performance.now() - start;
  result.input_set_digest = sha(inputs);
  result.bank_version = 'money-day1-v1';
  result.observation_digest = sha(result.observations);
  return result;
}
