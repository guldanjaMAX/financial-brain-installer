import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { replay, waitForQuiet, ROOT } from './money-replay.mjs';
import { compareRuns } from './money-compare.mjs';
import { SCORING_IDENTITY } from './money-score.mjs';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { cases as batchCases, snapshotFor as batchSnapshot } from '../../worker/test/fixtures/fastloop-batch2-cases.mjs';
import { contract as batchContract } from '../../worker/test/fixtures/fastloop-batch2-key.mjs';
import { cases as earlyCases, snapshotFor as earlySnapshot } from './early-month-cases.mjs';
import { reviewEarlyMonth } from './early-month-key.mjs';
import { cases, snapshotFor } from './vendor-family-cases.mjs';
import { reviewVendorFamily } from './vendor-family-key.mjs';

export function benchmarkVendorFamily() {
  const baselineSha = 'cc679bb0237103c0fa03261345ab3ccf4b5e61cf';
  const sourceOverrides = {}, copiedSourceSha256 = {};
  for (const name of ['ledger-answer.js', 'ledger-analysis.js', 'ledger-question.js', 'ledger-reader.js']) {
    const source = execFileSync('git', ['show', `${baselineSha}:worker/src/lib/${name}`], {
      cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR || process.env.HOME },
    });
    sourceOverrides[name] = source;
    copiedSourceSha256[name] = createHash('sha256').update(source).digest('hex');
  }
  const inputs = [...BASE_CASES, ...CONTROLS];
  const before = { ...replay({ sourceOverrides }), scoring_identity: SCORING_IDENTITY };
  const after = { ...replay(), scoring_identity: SCORING_IDENTITY };
  const comparison = compareRuns(before, after, inputs);
  assert.equal(comparison.regression_gate, true, comparison.failures.join('\n'));
  for (const [slice, snapshot, review] of [[batchCases, batchSnapshot, batchContract],
    [earlyCases, earlySnapshot, (o, c) => c.previous ? reviewEarlyMonth(o, c) : null]]) {
    const prior = replay({ cases: slice, snapshotFor: snapshot, sourceOverrides });
    const next = replay({ cases: slice, snapshotFor: snapshot });
    for (const [i, c] of slice.entries()) {
      review(prior.observations[i], c); review(next.observations[i], c);
      assert.deepEqual(next.observations[i].body, prior.observations[i].body, `${c.id}: prior answers remain identical`);
    }
  }
  const prior = replay({ cases, snapshotFor, sourceOverrides }), next = replay({ cases, snapshotFor });
  let missingBefore = 0;
  for (const [i, c] of cases.entries()) {
    missingBefore += reviewVendorFamily(prior.observations[i], { baseline: true }).missing_family;
    assert.equal(reviewVendorFamily(next.observations[i]).missing_family, 0, c.id);
  }
  assert.equal(missingBefore, 9, 'baseline must reproduce the structured-family gap');
  return { baseline_sha: baselineSha, copied_source_sha256: copiedSourceSha256,
    baseline_source_digest: prior.source_digest, candidate_source_digest: next.source_digest,
    legacy_cases: inputs.length, batch_cases: batchCases.length, early_month_cases: earlyCases.length,
    development_cases: cases.length, cases: inputs.length + batchCases.length + earlyCases.length + cases.length,
    new_wrong_figures: 0, new_unsupported_claims: 0, regression_gate: true,
    missing_family_before: missingBefore, missing_family_after: 0,
    inherited_wrong_figures: comparison.inherited_wrong_figures,
    provider_calls: 0, production_writes: 0, release_evidence: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  waitForQuiet({ PATH: '/usr/bin:/bin' });
  console.log(JSON.stringify(benchmarkVendorFamily(), null, 2));
}
