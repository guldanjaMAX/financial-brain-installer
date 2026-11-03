// Explicit synthetic fixture authoring, never a replay fallback or live capture.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { DOCUMENT_CASES, CLOCK_CASES } from '../../test/fixtures/fastloop-route/input.mjs';
import { replayRoute } from './route-replay.mjs';

const cases = [...BASE_CASES, ...CONTROLS, ...DOCUMENT_CASES, ...CLOCK_CASES];
const run = replayRoute({ cases, capture: true });
assert.equal(run.observations.length, cases.length);
assert.ok(run.observations.every(o => o.execution_status === 'complete'),
  JSON.stringify(run.observations.filter(o => o.execution_status !== 'complete').map(o => ({ id: o.id, fatal: o.fatal }))));
assert.ok(Object.values(run.tapes).every(tape => ['d1', 'provider', 'model'].every(channel => tape[channel].every(entry => !entry.error))),
  'ordinary fixtures must not conceal an unexpected dependency error');
const tapes = { ...run.tapes };
for (const authority of ['proxy', 'anonymous']) {
  const input = CONTROLS.find(c => c.id === 'M06/typed');
  const peer = replayRoute({ cases: [input], capture: true, authority });
  assert.ok(peer.observations.every(o => o.execution_status === 'complete'));
  tapes[`authority/${authority}`] = peer.tapes[input.id];
}
writeFileSync(new URL('../../test/fixtures/fastloop-route/tapes.json', import.meta.url), `${JSON.stringify(tapes, null, 2)}\n`);
console.log(`Synthetic tapes authored: ${Object.keys(tapes).length}; no provider calls.`);
