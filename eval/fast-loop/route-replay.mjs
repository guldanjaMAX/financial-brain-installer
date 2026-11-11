import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ROOT, waitForQuiet, validateSourceOverrides } from './money-replay.mjs';
import { BASE_CASES, evidence } from '../../test/fixtures/fastloop-money/input.mjs';
import { sha256 } from './exact-tape.mjs';
import { runReplayChild } from './child-run.mjs';
import { searchDisclosureTapes } from './search-disclosure-tapes.mjs';

export function replayRoute({ cases = BASE_CASES, capture = false, fixtures,
  authority = 'owner', fixtureId, trace = true, fault = null, arms = false, sourceOverrides = {} } = {}, { spawn, writeStderr } = {}) {
  validateSourceOverrides(sourceOverrides);
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(ROOT, 'lane-evidence/home-route'),
    BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[name]) env[name] = process.env[name];
  const inputs = cases.map(c => ({ ...c, snapshot: c.snapshot || evidence(c.profile),
    modelOutputs: c.modelOutputs || ['The documents do not answer the question.'] }));
  if (!capture && !fixtures) fixtures = loadRouteTapes();
  if (!capture) fixtures = searchDisclosureTapes(fixtures);
  const started = performance.now();
  const child = runReplayChild({ label: 'ROUTE', spawn, writeStderr, beforeAttempt: () => waitForQuiet(env),
    args: ['--experimental-vm-modules', '--permission', `--allow-fs-read=${ROOT}`,
    '--import', new URL('../../test/fixtures/cli-side-effect-tripwire.mjs', import.meta.url).href,
    fileURLToPath(new URL('./route-worker.mjs', import.meta.url))], options: { cwd: ROOT, env,
    input: JSON.stringify({ root: ROOT, inputs, capture, fixtures, authority, fixtureId, trace, fault, arms, sourceOverrides }),
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 } });
  const run = JSON.parse(child.stdout);
  return { ...run, wall_ms: performance.now() - started,
    node_version: process.version, input_set_digest: sha256(inputs), tape_digest: sha256(fixtures || run.tapes || {}),
    observation_digest: sha256(run.observations || run.arms),
    harness_digest: sha256(['route-replay.mjs', 'route-worker.mjs', 'worker-compartment.mjs', 'child-run.mjs', 'child-stall.mjs', 'ledger-sql-contracts.mjs',
      'exact-tape.mjs', 'retrieval-arms.mjs', 'money-worker.mjs', 'search-disclosure-tapes.mjs']
      .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))) };
}

// Apply only the explicitly authored pending reads. Frozen base exchanges and
// all provider/model streams remain bound to the authoring proof and hashes.
export function loadRouteTapes() {
  const base = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-route/tapes.json', import.meta.url), 'utf8'));
  const bytes = readFileSync(new URL('../../test/fixtures/fastloop-route/disclosure-v1.json', import.meta.url), 'utf8');
  if (sha256(bytes) !== 'a27dbe61ce7d5b17a48730c4b9348acc0e0d9995264e4e8955da63e89e4e76af') throw Error('ROUTE_DISCLOSURE_PATCH_INVALID');
  const patch = JSON.parse(bytes);
  if (patch.schema !== 1 || patch.version !== 'pending-disclosure-v1' || sha256(base) !== patch.base_sha256)
    throw Error('ROUTE_DISCLOSURE_BASE_MISMATCH');
  for (const change of patch.changes) {
    if (!Object.hasOwn(base, change.id) || sha256(base[change.id]) !== change.before_sha256)
      throw Error('ROUTE_DISCLOSURE_CASE_MISMATCH');
    base[change.id] = change.tape;
  }
  return base;
}
