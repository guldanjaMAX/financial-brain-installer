import test from 'node:test';
import assert from 'node:assert/strict';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { categoryFor } from '../src/lib/ledger-analysis.js';

test('only confirmed labels establish category membership', () => {
  for (const state of [null, 'proposed', 'unknown']) assert.equal(categoryFor({ category: 'software', category_basis_state: state }), null);
  assert.equal(categoryFor({ category: 'software', category_basis_state: 'confirmed' }), 'software');
});
for (const question of ['How much did I spend on software in October 2026?', 'What were my top spending categories in October 2026?']) {
  test(`confirmed membership and visible excluded rows: ${question}`, async t => {
    const f = ledgerFixture(t);
    for (const [uid, category, state, cents] of [['confirmed', 'software', 'confirmed', 100], ['proposed', 'software', 'proposed', 2], ['unknown', null, null, 3]]) {
      f.add(uid, 'Store purchase', 'Store One', { cents, direction: 'outflow' });
      f.raw('UPDATE fin_transactions SET category=?, category_basis_state=? WHERE txn_uid=?', category, state, uid);
    }
    const body = await f.ask(question);
    assert.equal(body.ledger.unconfirmed_category_count, 2);
    assert.equal(body.ledger.unsorted_minor, 5);
    assert.match(body.answer, /2 rows totaling \$0\.05.*left out/);
    if (body.ledger.confirmed_category_subtotal_minor != null) assert.equal(body.ledger.confirmed_category_subtotal_minor, 100);
    else assert.equal((body.ledger.category_groups || body.ledger.groups).find(g => g.category === 'software').total_minor, 100);
  });
}
for (const [description, state] of [['Store refund', 'confirmed'], ['Store refund without receipt', 'confirmed'], ['Store deposit', 'confirmed'], ['Not a refund', 'confirmed'], ['Store refund', 'proposed'], ['refund only', 'confirmed'], ['proposed refund only', 'proposed']]) {
  test(`category refund evidence: ${description}, ${state}`, async t => {
    const f = ledgerFixture(t);
    if (!description.includes('only')) f.add('expense', 'Store purchase', 'Store One', { cents: 100, direction: 'outflow' });
    f.add('credit', description.includes('only') ? 'Store refund' : description, 'Store One', { cents: 25, direction: 'inflow' });
    f.raw("UPDATE fin_transactions SET category='software', category_basis_state='confirmed'");
    f.raw("UPDATE fin_transactions SET category_basis_state=? WHERE txn_uid='credit'", state);
    f.env.ANTHROPIC_API_KEY = 'fixture-not-a-key';
    const response = await withLedgerAnswer({ env: f.env, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
      question: 'Could you retrieve spending in the category software for October 2026 after refunds?',
      callLLM: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
        kind: 'category', direction: 'outflow', count: null, vendor_text: 'software', account_hint: null, amount_text: null, date_text: null,
        period: { type: 'between', from: '2026-10-01', to: '2026-10-31' },
      }] }) }] }) }, () => assert.fail('no document fallback'));
    const body = await response.json();
    assert.equal(body.ledger.net_refunds_unavailable, true);
    assert.equal(body.ledger.net_expense_minor, undefined, 'closed-world refund basis withheld');
    assert.equal(body.ledger.total_minor, description.includes('only') ? state === 'confirmed' ? 0 : null : 100, 'unknown category cannot certify an empty gross amount');
    const possible = body.ledger.possible_refunds;
    assert.equal(possible.length, 1, 'credit disclosed once even if category unconfirmed');
    assert.equal(possible[0].amount_minor, 25);
    assert.ok(body.answer.includes('[' + possible[0].n + ']'), 'possible credit cited');
    if (state === 'proposed' && description.includes('only')) {
      assert.equal(body.ledger.selector_unresolved, true);
      assert.match(body.answer, /not recognized/);
    } else if (state === 'proposed') {
      assert.equal(body.ledger.unconfirmed_category_count, 1);
      assert.equal(body.ledger.unsorted_minor, 25);
      assert.match(body.answer, /left out of confirmed category totals/);
    }
  });
}
test('exclusion disclosure is independently scored, including its count and cents', async () => {
  const { replay } = await import('../../eval/fast-loop/money-replay.mjs');
  const { scoreObservation } = await import('../../eval/fast-loop/money-score.mjs');
  const { BASE_CASES } = await import('../../test/fixtures/fastloop-money/input.mjs');
  const input = BASE_CASES.find(c => c.id === 'M05');
  const observation = replay({ cases: [input] }).observations[0];
  assert.equal(scoreObservation(observation, input).verdict, 'correct');
  for (const mutate of [
    body => { body.ledger.unconfirmed_category_count++; },
    body => { body.answer = body.answer.replace(/(Unconfirmed categories: )\d+/, (_, prefix) => prefix + '99'); },
    body => { body.answer = body.answer.replace(/(Unconfirmed categories: .*totaling )\$[\d,.]+/, '$1$0.01'); },
  ]) {
    const broken = structuredClone(observation);
    mutate(broken.body);
    assert.ok(scoreObservation(broken, input).safety_failures.length);
  }
});
