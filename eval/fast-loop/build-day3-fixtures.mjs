// Explicit offline authoring. Ordinary replay never calls this module.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PERMANENT } from '../../test/fixtures/fastloop-day3/permanent.mjs';
import { DEVELOPMENT } from '../../test/fixtures/fastloop-day3/development.mjs';
import { RESERVED } from '../../test/fixtures/fastloop-day3/reserved.mjs';
import { validateBank } from '../../test/fixtures/fastloop-day3/builders.mjs';
import { replayRoute } from './route-replay.mjs';
import { batch1Sources, sourceInventory } from './batch1-sources.mjs';
import { sha } from './money-replay.mjs';

const sources = batch1Sources();
for (const [split, cases] of [['development', [...PERMANENT, ...DEVELOPMENT]], ['reserved', RESERVED]]) {
  validateBank(cases);
  const tapes = {};
  for (const [revision, sourceOverrides] of [['baseline', {}], ['batch1', sources]]) {
    const run = replayRoute({ cases, capture: true, sourceOverrides });
    assert.equal(run.observations.length, cases.length);
    assert.ok(run.observations.every(o => o.execution_status === 'complete'),
      JSON.stringify(run.observations.filter(o => o.execution_status !== 'complete').map(o => ({ id: o.id, fatal: o.fatal }))));
    assert.ok(Object.values(run.tapes).every(t => ['d1', 'provider', 'model'].every(k => t[k].every(e => !e.error))));
    tapes[revision] = run.tapes;
  }
  writeFileSync(new URL(`../../test/fixtures/fastloop-day3/${split}-tapes.json`, import.meta.url), JSON.stringify(tapes, null, 2) + '\n');
  console.log(JSON.stringify({ split, cases: cases.length, input_sha256: sha(cases), tape_sha256: sha(tapes),
    candidate_sources: sourceInventory(sources), provider_calls: 0 }));
}
