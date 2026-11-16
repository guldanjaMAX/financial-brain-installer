import assert from 'node:assert/strict';

// The compatibility reader has no feed/freshness assessment. Successful SQL
// cannot raise confidence; figure oracles remain in each caller's test.
export function assertOwnerLedgerContract(body) {
  assert.equal(body.answer_contract?.kind, 'ledger');
  assert.equal(body.answer_contract?.version, 1);
  assert.equal(body.status, undefined);
  assert.equal(body.answer_error, undefined);
  assert.equal(body.confidence?.percent, 0);
  assert.equal(body.confidence?.band, 'Low');
  assert.ok(body.confidence.basis.length && body.confidence.missing.length);
  assert.match(body.confidence_text, /^Confidence: Low \(0%\).*Why:.*Missing:/s);
  assert.match(body.answer, /\n\nCoverage: Accounts:.*\nMissing or counted twice:.*\nEstimates:.*\nHow to check:/s);
  assert.ok(body.answer.split('\n\nCoverage:')[0].trim(), 'the figure or best reading precedes its qualifications');
}
