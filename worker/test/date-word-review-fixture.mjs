import assert from 'node:assert/strict';
import { setup } from './c3-calendar-scope-fixture.mjs';

// A changed calendar contract must prove facts and disclose the unused limit,
// rather than turn a former refusal into a vacuous "no error" assertion.
export function unusedReading(r, total, words) {
  assert.equal(r.extraction, 1);
  assert.equal(r.documents, 0);
  assert.ok(r.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')));
  assert.equal(r.body.ledger.total_minor ?? r.body.ledger.expense_total_minor, total);
  assert.ok(r.body.ledger.unused_calendar_limits?.length);
  if (words) assert.ok(r.body.ledger.unused_calendar_limits.join(' ').includes(words));
  for (const limit of r.body.ledger.unused_calendar_limits) {
    assert.ok(r.body.answer.includes(`I did not narrow it by '${limit}'`));
    assert.ok(r.body.clarification.best_reading.includes(limit));
  }
  assert.equal(r.body.evidence_gate.complete, false);
}

export const facts = r => {
  assert.equal(r.extraction, 1, 'real extraction decision reached');
  assert.equal(r.documents, 0);
  assert.ok(r.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')), 'real transaction read reached');
};
export function disclosed(r, words, amount = 1700) {
  facts(r);
  assert.equal(r.body.ledger.total_minor, amount);
  assert.deepEqual([r.body.ledger.from, r.body.ledger.to], ['2026-10-01', '2026-10-31']);
  assert.ok(r.body.ledger.unused_calendar_limits?.includes(words), 'exact unused limit retained');
  assert.ok(r.body.answer.includes(`I did not narrow it by '${words}'`), 'unused limit explained beside figure');
  assert.equal(r.body.evidence_gate.complete, false, 'broader reading is not the complete requested answer');
  assert.ok(r.body.clarification.best_reading.includes(words));
}

export function comparisonSetup(t) {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-11-02'");
  f.add('main', '2026-11-02', 900); f.add('main', '2026-11-03', 99999);
  f.add('main', '2026-10-02', 500); f.add('main', '2026-10-03', 4000);
  return f;
}
export function aligned(r, reverse = false) {
  facts(r);
  const periods = [['2026-11-01', '2026-11-02'], ['2026-10-01', '2026-10-02']];
  assert.deepEqual(r.body.ledger.parts.map(p => [p.from, p.to]), reverse ? periods.toReversed() : periods);
  assert.deepEqual(r.body.ledger.comparison.figures_minor, reverse ? [500, 900] : [900, 500]);
  assert.equal(r.body.ledger.comparison.difference_minor, reverse ? -400 : 400);
  assert.doesNotMatch(r.body.answer, /(?:November|October) 1 to 3/);
  assert.doesNotMatch(r.body.clarification.best_reading, /(?:November|October) 1 to 3/);
  assert.ok(r.body.ledger.parts.every(p => p.operand_coverage.to === p.to && p.operand_coverage.complete));
}
