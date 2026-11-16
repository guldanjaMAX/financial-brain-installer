import assert from 'node:assert/strict';
import { finalizeOwnerLedgerAnswer } from '../../src/lib/document-answer.js';

export function futureComparison(result, expected = 0) {
  assert.equal(result.extraction, 1, 'the extraction decision was reached');
  assert.equal(result.documents, 0);
  assert.ok(result.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')), 'real historical facts were read');
  const [future, historical] = result.body.ledger.parts;
  assert.deepEqual([future.from, future.to], ['2027-10-01', '2027-10-31']);
  assert.deepEqual([historical.from, historical.to], ['2025-09-01', '2025-09-30']);
  assert.equal(future.projection, true);
  assert.equal(future.estimate, true);
  assert.equal(future.complete, false);
  assert.equal(future.coverage.complete, false, 'future feed coverage cannot certify the estimate');
  assert.equal(future.total_minor, expected);
  assert.deepEqual([future.basis.from, future.basis.to], ['2026-07-07', '2026-11-03']);
  assert.equal(future.basis.patterns.length, expected ? 1 : 0);
  assert.equal(historical.expense_total_minor, 0, 'historical empty-period control retains exact zero');
  assert.equal(result.body.ledger.comparison, undefined);
  assert.equal(result.body.ledger.comparison_unavailable.reason, 'operand_incomplete');
  assert.equal(result.body.evidence_gate.complete, false);
  assert.match(result.body.answer, /Projection: about \$[\d.]+.*2027/s);
  assert.match(result.body.answer, expected ? /Likely only/ : /pattern-only estimate, not a prediction of no activity/);
  const owner = finalizeOwnerLedgerAnswer(result.body);
  assert.equal(owner.confidence.percent, 0, 'compatibility projection cannot claim High');
  assert.match(owner.confidence_text, /Confidence: Low \(0%\).*Why:.+Missing:/s);
}
