import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuickBooksBankLines, __testing } from '../src/lib/qbo-bank-reconciliation.js';
import { booksCandidateComponents } from '../src/lib/books-candidate-graph.js';

const line = (id, amount, date = '2025-01-15') => ({
  line_uid: id, txn_uid: id, posted_on: date, amount_minor: amount,
  direction: 'outflow', currency: 'USD', source_doc_uid: `fixture:${id}`,
  source_locator: `fixture/${id}`,
});
const classify = (qboLines, bankLines) => classifyQuickBooksBankLines({
  qboLines, bankLines, bankCoverage: 'complete', qboCoverage: 'complete',
});
const signature = result => result.map(item => ({
  kind: item.classification, delta: item.delta_minor,
  qbo: item.quickbooks.map(row => row.amount_minor).sort(),
  bank: item.bank.map(row => row.amount_minor).sort(),
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('green control reaches a nonempty exact pair', () => {
  const result = classify([line('q1', 100)], [line('b1', 100)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].classification, 'exact_unique');
  assert.equal(result[0].quickbooks.length, 1);
  assert.equal(result[0].bank.length, 1);
});

test('FIN-001 retains ALL competitors and cannot select an amount by opaque ID order', () => {
  const first = classify([line('q1', 100), line('q2', 200)], [line('b1', 300)]);
  const renamed = classify([line('q2', 100), line('q1', 200)], [line('b1', 300)]);
  for (const result of [first, renamed]) {
    assert.equal(result.length, 1);
    assert.equal(result[0].quickbooks.length, 2, 'both contenders reached the decision');
    assert.equal(result[0].bank.length, 1);
    assert.equal(result[0].classification, 'ambiguous_duplicates');
    assert.equal(result[0].delta_minor, null);
  }
  assert.deepEqual(signature(first), signature(renamed));
});

test('an exact-looking pair cannot consume a competing timing or amount candidate', () => {
  for (const other of [line('q2', 200), line('q2', 100, '2025-01-16')]) {
    const result = classify([line('q1', 100), other], [line('b1', 100)]);
    assert.equal(result.flatMap(row => row.quickbooks).length, 2);
    assert.equal(result.flatMap(row => row.bank).length, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].classification, 'ambiguous_duplicates');
  }
});

test('reverse competition and transitive components allocate every row exactly once', () => {
  const qbo = [line('q1', 100), line('q2', 200, '2025-01-16')];
  const bank = [line('b1', 200), line('b2', 200, '2025-01-17')];
  const baseline = classify(qbo, bank);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].quickbooks.length, 2);
  assert.equal(baseline[0].bank.length, 2);
  assert.equal(baseline[0].classification, 'ambiguous_duplicates');
  assert.deepEqual(baseline, classify([...qbo].reverse(), [...bank].reverse()));
});

test('legacy money refuses unsafe or coerced amounts before classifying', () => {
  for (const amount of [Number.MAX_SAFE_INTEGER + 1, 1.5, '100', null, -1]) {
    assert.throws(() => classify([line('q1', amount)], [line('b1', 100)]),
      { code: 'invalid_reconciliation_evidence' });
  }
  assert.equal(classify([line('q1', 101)], [line('b1', 100)])[0].delta_minor, 1);
});

test('the production input guard never coerces null or decimal text into money', () => {
  const scope = { qbo_account_id: 'account', qbo_company_fingerprint: 'a'.repeat(64), direction: 'outflow',
    currency: 'USD', period_start: '2025-01-01', period_end: '2025-01-31' };
  const valid = { ...line('q1', 100), qbo_account_id: scope.qbo_account_id, qbo_company_fingerprint: scope.qbo_company_fingerprint };
  assert.equal(__testing.checkedQboLines([valid], scope).length, 1);
  for (const amount_minor of [null, '', '100', true, 1.5]) {
    assert.throws(() => __testing.checkedQboLines([{ ...valid, amount_minor }], scope), { code: 'invalid_qbo_evidence' });
  }
  assert.equal(__testing.checkedQboLines([{ ...valid, line_uid: ' q1', source_doc_uid: ' fixture:q1' }], scope)[0].line_uid, ' q1');
  assert.throws(() => __testing.checkedQboLines([{ ...valid, qbo_account_id: ' account' }], scope), { code: 'invalid_qbo_evidence' });
});

test('invalid calendar days cannot become exact matches', () => {
  assert.throws(() => classify([line('q1', 100, '2025-02-30')], [line('b1', 100, '2025-02-30')]),
    { code: 'invalid_reconciliation_evidence' });
  assert.equal(classify([line('q1', 100, '2025-02-28')], [line('b1', 100, '2025-02-28')])[0].classification, 'exact_unique');
});

test('dense candidate sets refuse visibly instead of truncating or producing an unbounded response', () => {
  const rows = count => Array.from({ length: count }, (_, id) => ({ id }));
  const control = booksCandidateComponents(rows(100), rows(100), () => 'candidate');
  assert.equal(control.length, 1);
  assert.equal(control[0].edges.length, 10000);
  let examined = 0;
  assert.throws(() => booksCandidateComponents(rows(101), rows(100), () => { examined++; return 'candidate'; }),
    { code: 'books_candidate_bound' });
  assert.ok(examined > 10000, 'the dense graph decision was reached');
});
