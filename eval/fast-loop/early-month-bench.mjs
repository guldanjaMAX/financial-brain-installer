import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { replay, waitForQuiet, ROOT } from './money-replay.mjs';
import { compareRuns } from './money-compare.mjs';
import { displayFigures } from './money-oracle.mjs';
import { SCORING_IDENTITY } from './money-score.mjs';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { cases as batchCases, snapshotFor as batchSnapshot } from '../../worker/test/fixtures/fastloop-batch2-cases.mjs';
import { contract as batchContract } from '../../worker/test/fixtures/fastloop-batch2-key.mjs';
import { cases, snapshotFor } from './early-month-cases.mjs';
import { reviewEarlyMonth } from './early-month-key.mjs';

export function benchmark() {
  const baselineSha = '129c78f554bb55a296e66380ae9e54382996ce67';
  const sourceOverrides = {}, copiedSourceSha256 = {};
  for (const name of ['ledger-answer.js', 'ledger-question.js', 'ledger-reader.js', 'ledger-analysis.js']) {
    const source = execFileSync('git', ['show', `${baselineSha}:worker/src/lib/${name}`], {
      cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: resolve(ROOT, 'lane-evidence/home-fastloop') },
    });
    sourceOverrides[name] = source;
    copiedSourceSha256[name] = createHash('sha256').update(source).digest('hex');
  }
  const inputs = [...BASE_CASES, ...CONTROLS];
  const baseline = { ...replay({ sourceOverrides }), scoring_identity: SCORING_IDENTITY };
  const candidate = { ...replay(), scoring_identity: SCORING_IDENTITY };
  const comparison = compareRuns(baseline, candidate, inputs);
  assert.equal(comparison.regression_gate, true, comparison.failures.join('\n'));
  const batchBefore = replay({ cases: batchCases, snapshotFor: batchSnapshot, sourceOverrides });
  const batchAfter = replay({ cases: batchCases, snapshotFor: batchSnapshot });
  for (const o of batchBefore.observations) batchContract(o, { wording: 'pinned' });
  for (const o of batchAfter.observations) batchContract(o);
  const before = replay({ cases, snapshotFor, sourceOverrides }), after = replay({ cases, snapshotFor });
  let missingBefore = 0, missingAfter = 0;
  for (const c of cases) {
    const prior = before.observations.find(o => o.id === c.id), next = after.observations.find(o => o.id === c.id);
    if (c.previous) {
      missingBefore += reviewEarlyMonth(prior, c, { wording: 'pinned' }).missing_previous;
      missingAfter += reviewEarlyMonth(next, c).missing_previous;
    } else {
      assert.equal(prior.execution_status, 'complete');
      assert.equal(next.execution_status, 'complete');
      const facts = body => { const copy = structuredClone(body); delete copy.answer; for (const gap of copy.gaps || []) delete gap.detail; return copy; };
      assert.deepEqual(facts(next.body), facts(prior.body), `${c.id}: selected-period machine values must stay identical`);
      assert.deepEqual(displayFigures(next.body.answer || '').map(({ text, cents }) => ({ text, cents })), displayFigures(prior.body.answer || '').map(({ text, cents }) => ({ text, cents })), `${c.id}: every displayed amount stays identical`);
    }
  }
  assert.ok(missingBefore > 0, 'baseline must reproduce missing previous-month answers');
  assert.equal(missingAfter, 0);
  return { baseline_sha: baselineSha, copied_source_sha256: copiedSourceSha256,
    baseline_source_digest: baseline.source_digest, candidate_source_digest: candidate.source_digest,
    cases: inputs.length + batchCases.length + cases.length, legacy_cases: inputs.length,
    batch_cases: batchCases.length, development_cases: cases.length,
    new_wrong_figures: 0, new_unsupported_claims: 0, regression_gate: true,
    missing_previous_before: missingBefore, missing_previous_after: missingAfter,
    inherited_wrong_figures: comparison.inherited_wrong_figures,
    provider_calls: 0, production_writes: 0, release_evidence: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  waitForQuiet({ PATH: '/usr/bin:/bin' });
  console.log(JSON.stringify(benchmark(), null, 2));
}
