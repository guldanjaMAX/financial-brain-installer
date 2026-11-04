import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASES, loadTapes } from '../eval/fast-loop/day3-bench.mjs';
import { replayRoute } from '../eval/fast-loop/route-replay.mjs';
import { workingTreeSources } from '../eval/fast-loop/ledger-sources.mjs';

test('reviewed copy keeps exact model replay with the old prompt as a negative control', () => {
  const current = loadTapes();
  const prior = structuredClone(current.candidate);
  const frozen = JSON.parse(readFileSync(new URL('./fixtures/fastloop-day3/candidate-inventory-v1.json', import.meta.url), 'utf8'));
  const old = frozen.additional.find(change => change.id === 'Q11').tape.model[0];
  prior.Q11.model[0] = old;
  assert.notDeepEqual(current.candidate.Q11.model[0].input, old.input, 'one reviewed prompt changed');
  assert.deepEqual(current.candidate.Q11.model[0].output, old.output, 'the model reply stays frozen');
  const options = { cases: ['D02', 'Q11'].map(id => CASES.find(c => c.id === id)), sourceOverrides: workingTreeSources() };
  for (const [fixtures, expected] of [[current.candidate, 'complete'], [prior, 'model_tape_miss']]) {
    const run = replayRoute({ ...options, fixtures });
    const [bank, document] = run.observations;
    assert.equal(bank.execution_status, 'complete', 'the same nonempty bank peer remains green');
    assert.equal(bank.body.ledger.expense_total_minor, 61000);
    assert.ok(document.trace.models.length > 0, 'both arms reach exact model-input comparison');
    assert.equal(document.execution_status, expected);
    if (expected !== 'complete') assert.ok(document.fatal.includes('MODEL_TAPE_MISS'));
    assert.equal(run.provider_calls, 0);
    assert.equal(run.production_writes, 0);
  }
});
