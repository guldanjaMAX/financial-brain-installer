// Explicit offline authoring only. Ordinary replay never captures a missing
// call. Preserve historical tapes and bind each replacement to exact bytes.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { CASES, loadTapes } from './day3-bench.mjs';
import { replayRoute } from './route-replay.mjs';
import { workingTreeSources } from './ledger-sources.mjs';
import { sha } from './money-replay.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function tapeChanges(before, after, path = []) {
  if (typeof before === 'object' && before !== null) {
    assert.equal(Array.isArray(before), Array.isArray(after));
    if (Array.isArray(before)) assert.equal(before.length, after.length);
    const changes = [];
    for (const key of Object.keys(before)) {
      assert.ok(Object.hasOwn(after, key), 'no frozen field may disappear');
      changes.push(...tapeChanges(before[key], after[key], [...path, key]));
    }
    for (const key of Object.keys(after).filter(key => !Object.hasOwn(before, key))) {
      assert.equal(key, 'entity_kind');
      assert.equal(before.entity_slug, 'owner');
      assert.equal(after[key], 'business', 'the synthetic seed explicitly declares this kind');
      changes.push({ path: [...path, key], missing: true, value: after[key] });
    }
    return changes;
  }
  if (before === after) return [];
  // The installed schema already includes account-kind reviews. Older tapes
  // predate it; no model request, figure, bind or other response may change.
  assert.ok((path.at(-1) === 'schema_version' && before === 57 && [58, 59].includes(after)) ||
    (typeof before === 'string' && sha(before) === '511315a8f707696def73f2bcdf1759704fa16b1f636dabc5c983a4fdc562f3a6' &&
      // Current admission additionally checks SimpleFIN proof versions. Every
      // bind, response, model tape and historical arm remains exact below.
      ['085a3cb746a3831a3f0a640f08a0ffbd57297d917c3e1dfe483d8d581d74efa6',
        '0560a90893bdbca03eb46f39580b9d0e6fd87070fe7c3560a58d12de0a571b2e'].includes(sha(after))),
  `unreviewed tape change at ${path.join('/')}`);
  return [{ path, before_sha256: sha(before), value: after }];
}

export function buildRouterTapes() {
  const previous = loadTapes({ router: false }).candidate;
  const sources = workingTreeSources();
  const run = replayRoute({ cases: CASES, capture: true, sourceOverrides: sources });
  assert.equal(run.observations.length, CASES.length);
  assert.ok(run.observations.every(o => o.execution_status === 'complete'));
  assert.equal(run.provider_calls, 0);
  assert.equal(run.production_writes, 0);
  assert.ok(Object.values(run.tapes).every(tape => ['d1','provider','model']
    .every(channel => tape[channel].every(entry => !entry.error))));
  const changes = CASES.flatMap(({ id }) => {
    assert.deepEqual(run.tapes[id].model, previous[id].model, 'model tapes stay frozen');
    assert.deepEqual(run.tapes[id].provider, previous[id].provider, 'provider tapes stay frozen');
    const edits = tapeChanges(previous[id], run.tapes[id]);
    return edits.length ? [{ id, before_sha256: sha(previous[id]), edits }] : [];
  });
  assert.ok(changes.length > 0, 'the reviewed inventory change must reach the tape');
  return { schema: 1, version: 'router-inventory-v1', base_sha256: sha(previous),
    source_sha256: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)])),
    changes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const patch = buildRouterTapes();
  const bytes = JSON.stringify(patch, null, 2) + '\n';
  writeFileSync(new URL('../../test/fixtures/fastloop-day3/candidate-router-v1.json', import.meta.url), bytes);
  console.log(JSON.stringify({ cases: patch.changes.length, sha256: sha(bytes),
    provider_calls: 0, production_writes: 0 }));
}
