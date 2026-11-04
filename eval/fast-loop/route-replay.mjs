import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ROOT, waitForQuiet, validateSourceOverrides } from './money-replay.mjs';
import { BASE_CASES, evidence } from '../../test/fixtures/fastloop-money/input.mjs';
import { sha256 } from './exact-tape.mjs';

export function replayRoute({ cases = BASE_CASES, capture = false, fixtures,
  authority = 'owner', fixtureId, trace = true, fault = null, arms = false, sourceOverrides = {} } = {}) {
  validateSourceOverrides(sourceOverrides);
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(ROOT, 'lane-evidence/home-route'),
    BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[name]) env[name] = process.env[name];
  const inputs = cases.map(c => ({ ...c, snapshot: c.snapshot || evidence(c.profile),
    modelOutputs: c.modelOutputs || ['The documents do not answer the question.'] }));
  if (!capture && !fixtures) fixtures = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-route/tapes.json', import.meta.url), 'utf8'));
  waitForQuiet(env);
  const started = performance.now();
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--permission', `--allow-fs-read=${ROOT}`,
    '--import', new URL('../../test/fixtures/cli-side-effect-tripwire.mjs', import.meta.url).href,
    fileURLToPath(new URL('./route-worker.mjs', import.meta.url))], { cwd: ROOT, env,
    input: JSON.stringify({ root: ROOT, inputs, capture, fixtures, authority, fixtureId, trace, fault, arms, sourceOverrides }),
    encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (child.status !== 0) throw Error(`ROUTE_CHILD_FAILED:${child.status}:${child.error?.code || child.stderr.slice(0, 300)}`);
  const run = JSON.parse(child.stdout);
  return { ...run, wall_ms: performance.now() - started,
    node_version: process.version, input_set_digest: sha256(inputs), tape_digest: sha256(fixtures || run.tapes || {}),
    observation_digest: sha256(run.observations || run.arms),
    harness_digest: sha256(['route-replay.mjs', 'route-worker.mjs', 'worker-compartment.mjs',
      'exact-tape.mjs', 'retrieval-arms.mjs', 'money-worker.mjs']
      .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))) };
}
