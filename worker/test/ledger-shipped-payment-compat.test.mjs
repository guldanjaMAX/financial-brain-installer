import { makeLedger } from './fixtures/owner-route-book.mjs';
import { assertOwnerLedgerContract } from './helpers/ledger-answer-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { accountKindIdentity } from '../src/lib/fin-account-kinds.js';

// Human answers retain the shipped reader's exact reviewed-liability policy.
// A generic memo cannot change a known endpoint; expense categories still veto.
for (const kind of ['card', 'loan']) for (const locator of ['label', 'mask']) {
  test(`human reviewed ${kind} ${locator} keeps shipped spending and expense veto`, async t => {
    t.mock.method(Date, 'now', () => Date.parse(NOW));
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    const f = ledgerFixture(t);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES ('liability-unit','owner','other','liability','2222','Lender Unit','manual','owner_stated','confirmed',?)`, NOW);
    const account = f.first("SELECT * FROM fin_accounts WHERE account_slug='liability-unit'");
    f.raw(`INSERT INTO fin_account_kind_reviews (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
      VALUES (?,?,?,?,'liability','owner','owner_account_kind',?,?)`, account.tenant_id, account.id,
      accountKindIdentity(account), kind, NOW, 'a'.repeat(64));
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('liability-unit','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
    f.add('ordinary', 'Service expense', 'Service Unit', { cents: 10000, direction: 'outflow' });
    f.raw("UPDATE fin_transactions SET category='GENERAL_SERVICES',category_basis_state='confirmed'");
    const read = async () => {
      f.calls.length = 0;
      const before = f.first('SELECT total_changes() n').n;
      const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
        body: JSON.stringify({ q: 'What did I spend this month, and on what?' }),
      }), f.env, { waitUntil() {} });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ledger?.kind, 'expense_summary');
      assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'human route reaches transaction evidence');
      assert.equal(f.first('SELECT total_changes() n').n, before, 'human reader is read-only');
      return body;
    };
    assert.equal((await read()).ledger.total_minor, 10000, 'populated nonpayment control');
    f.add('reviewed-payment', 'Account activity', locator === 'label' ? 'Lender Unit' : 'account 2222',
      { cents: 2500, direction: 'outflow' });
    const payment = await read();
    assert.equal(payment.ledger.total_minor, 10000, 'reviewed endpoint excludes the same 2500 cents as the shipped reader');
    assert.equal(payment.ledger.own_account_payments.total_minor, 2500);
    assert.equal(payment.ledger.own_account_payments.count, 1);
    assert.match(payment.answer, /\$100\.00/);
    assertOwnerLedgerContract(payment);
    assert.throws(() => assertOwnerLedgerContract({ ...payment,
      confidence: { ...payment.confidence, percent: 95, band: 'High' } }), assert.AssertionError,
    'the same populated reading cannot acquire unsupported High confidence');
    f.raw("UPDATE fin_transactions SET category='BANK_FEES',category_basis_state='confirmed' WHERE txn_uid='reviewed-payment'");
    const fee = await read();
    assert.equal(fee.ledger.total_minor, 12500, 'explicit bank fee overrides endpoint identity');
    assert.equal(fee.ledger.own_account_payments.count, 0);
  });
}

for (const label of ['buisness', 'buisness checking']) {
  test(`human balance retains literal ${label} and its exact account`, async t => {
    t.mock.method(Date, 'now', () => Date.parse('2026-11-03T19:00:00Z'));
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    const { f } = makeLedger(427, t);
    f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='personal'", label);
    const read = async q => {
      f.calls.length = 0;
      const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
        body: JSON.stringify({ q }),
      }), f.env, { waitUntil() {} });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.ok(f.calls.some(sql => /AS account_kind_review_json\b/.test(sql)), 'human route reaches the literal inventory decision');
      return body;
    };
    const control = await read('What is my account ending 2222 balance?');
    assert.equal(control.ledger.accounts[0].current_minor, 170427);
    const body = await read(`What's in my ${label} account?`);
    assert.equal(body.ledger?.kind, 'balance');
    assert.deepEqual(body.ledger.accounts, control.ledger.accounts);
    assert.match(body.answer, /1,704\.27/);
    assert.doesNotMatch(body.answer, /5,004\.27/);
    assertOwnerLedgerContract(body);
  });
}
