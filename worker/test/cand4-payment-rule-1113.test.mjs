import './fixtures/payment-scope-1113.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, fixture, NOW } from './ledger-review-fixture.mjs';
import worker from '../src/index.js';
import { queryMoney } from '../src/lib/money-query.js';

const question = 'How much came in and went out in October 2026?';
function book(t) {
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('card-unit','owner','card','liability','2222','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('card-unit','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.add('purchase', 'Purchase Unit', 'Store Unit', { cents: 10000, direction: 'outflow' });
  return f;
}
async function human(f, q = question) {
  const before = f.calls.length;
  const response = await worker.fetch(new Request('https://fixture.invalid/api/rag/think', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY }, body: JSON.stringify({ q }),
  }), f.env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(f.calls.slice(before).some(sql => /fin_accounts/.test(sql)), 'account decision reached');
  assert.ok(body.ledger, 'ledger decision reached');
  return body;
}
const sum = body => body.ledger.accounts.reduce((n, a) => n + a.debits_minor, 0);
const lead = body => body.ledger.lead_accounts?.reduce((n, a) => n + a.debits_minor, 0);
function answered(body) {
  assert.doesNotMatch(body.answer, /withheld|cannot|can't/i);
  assert.equal(body.confidence.percent, 0);
  assert.match(body.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
  assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
}
function payment(f, { coded = true, proved = false } = {}) {
  f.add('payment', proved ? 'TRANSFER TO ACCOUNT 2222' : 'Card payment', proved ? null : 'Payment Unit', { cents: 2500, direction: 'outflow' });
  if (coded) f.raw("UPDATE fin_transactions SET category='LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',category_basis_state='confirmed' WHERE txn_uid='payment'");
  if (proved) {
    f.add('receipt', 'TRANSFER FROM ACCOUNT 1234', null, { cents: 2500, direction: 'inflow' });
    f.raw("UPDATE fin_transactions SET account_slug='card-unit' WHERE txn_uid='receipt'");
  }
}
for (const mode of ['coded-unproved', 'description-unproved', 'coded-proved', 'description-proved', 'mixed-unproved', 'channel-unproved', 'mixed-channel-unproved', 'empty']) {
  test(mode, async t => {
    const f = book(t);
    const green = await human(f);
    assert.equal(sum(green), 10000); assert.equal(lead(green), 10000); answered(green);
    if (mode === 'empty') f.raw('DELETE FROM fin_transactions');
    else payment(f, { coded: !mode.startsWith('description'), proved: mode.endsWith('-proved') });
    if (mode === 'channel-unproved') f.raw("UPDATE fin_transactions SET payee=NULL,category=NULL,category_basis_state=NULL WHERE txn_uid='payment'");
    if (mode === 'mixed-channel-unproved') {
      f.add('second-payment', 'CARD AUTOPAY', null, { cents: 700, direction: 'outflow' });
    }
    if (mode === 'mixed-unproved') {
      f.add('second-payment', 'Card payment', 'Payment Unit', { cents: 700, direction: 'outflow' });
    }
    const body = await human(f);
    const expected = mode === 'empty' ? 0 : mode.endsWith('-proved') ? 10000 : mode.startsWith('mixed-') ? 13200 : 12500;
    console.log(JSON.stringify({ mode, expected, raw: sum(body), lead: lead(body), reason: body.ledger.reason,
      confidence: body.confidence.percent, ...(mode.includes('channel') ? {answer:body.answer} : {}), payments: body.ledger.possible_payments?.map(r => ({ amount:r.amount_minor, included:r.included_in_total, basis:r.basis })) }));
    assert.equal(sum(body), expected); assert.equal(lead(body), expected); answered(body);
    const spend = await human(f, 'How much did I spend in October 2026?');
    const spendExpected = mode === 'empty' ? 0 : mode === 'description-unproved' ? 12500 : mode === 'mixed-unproved' ? 10700 : 10000;
    assert.equal(spend.ledger.total_minor, spendExpected, 'unchanged shipped spending membership');
    answered(spend);
    if (mode.endsWith('-unproved')) {
      const money = await queryMoney(f.env, { sql: 'SELECT SUM(expense_minor) AS total FROM txn' });
      assert.equal(money.rows[0].total, expected, 'tools count unproved payments');
      assert.match(body.answer, /may be counted twice/);
      assert.match(body.answer, /ending 2222/);
      const foot = body.answer.split('Missing or counted twice:')[1].split('Estimates:')[0];
      assert.match(foot, /\$25\.00/);
      assert.match(foot, /ending 2222/);
      assert.doesNotMatch(foot, /duplicate dollar impact is unknown/);
      if (['description-unproved', 'mixed-unproved'].includes(mode)) {
        assert.match(spend.answer, /possibly a card payment: \$(?:25|7)\.00/);
        assert.match(spend.answer, /ending 2222/);
      } else if (mode === 'channel-unproved') assert.match(spend.answer, /possible card payment, not counted as spending: \$25\.00/);
      else assert.match(spend.answer, /Payments to loans and cards/);
    }
    if (mode === 'coded-unproved') {
      assert.equal(body.ledger.complete, false);
      assert.equal(body.ledger.possible_payments_included_minor, 2500);
      assert.equal(body.ledger.possible_payments[0].destination_unconfirmed, true);
      const spend = await human(f, 'How much did I spend in October 2026?');
      assert.equal(spend.ledger.total_minor, 10000);
      const money = await queryMoney(f.env, { sql: 'SELECT SUM(expense_minor) AS total FROM txn' });
      assert.equal(money.rows[0].total, 12500);
    }
  });
}
