// Opt-in desired-behavior probes. These stay red until the later product repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../worker/test/ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { prepareBankExportImport } from '../worker/src/lib/fin-import.js';

const now = '2026-10-31T19:00:00Z';
function seed(t, { kind = 'loan', memo = 'payment to account 4242', repayment = true } = {}) {
  const f = fixture(t); f.owner();
  for (const [slug, mask, type, role] of [['cash', '3131', 'checking', 'asset'],
    ['debt', '4242', kind, kind === 'loan' ? 'liability' : 'neither']]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,'manual','owner_stated','confirmed',?)`, slug, type, role, mask, now);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-09-01','2026-11-07',?,'owner_stated','confirmed',?)`, slug, now, now);
  }
  for (const [i, cents] of [6000, 5000, 4000, 3000, 2000, 1000, ...(repayment ? [40000] : [])].entries()) {
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
      VALUES (?,'cash','2026-10-12',?,'outflow',?,'owner_stated','confirmed',?)`, `row-${i}`, cents,
    i === 6 ? memo : `store ${i}`, now);
  }
  f.env.BRAIN_TIMEZONE = 'America/Phoenix';
  f.ask = async question => {
    const b = await (await withLedgerAnswer({ env: f.env, question, now,
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('unexpected fallback'))).json();
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'nonempty real read decision');
    assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n >= 6);
    return b;
  };
  return f;
}

test('RED ranking excludes proved repayment before taking five', async t => {
  const f = seed(t);
  const b = await f.ask('What were my five biggest expenses this month?');
  assert.deepEqual(b.ledger.lead_rows.map(r => r.amount_minor), [6000, 5000, 4000, 3000, 2000]);
});
test('GREEN ranking without repayment', async t => {
  const f = seed(t, { repayment: false });
  const b = await f.ask('What were my five biggest expenses this month?');
  assert.deepEqual(b.ledger.lead_rows.map(r => r.amount_minor), [6000, 5000, 4000, 3000, 2000]);
});
test('RED expense shorthand selects ordinary expenses', async t => {
  const f = seed(t);
  const b = await f.ask('Spend this month');
  const displayed = b.ledger.expense_total_minor ?? b.ledger.accounts.reduce((sum, a) => sum + a.debits_minor, 0);
  assert.equal(displayed, 21000);
});
test('GREEN supported expense headline', async t => {
  assert.equal((await seed(t).ask('What are my expenses?')).ledger.expense_total_minor, 21000);
});
test('RED unclassified debt cannot certify the full expense headline', async t => {
  const b = await seed(t, { kind: 'other' }).ask('What are my expenses?');
  assert.notEqual(b.ledger.complete, true);
});
test('GREEN typed debt separates whole payment', async t => {
  const b = await seed(t).ask('What are my expenses?');
  assert.equal(b.ledger.own_account_payments.loan_minor, 40000);
});
test('RED provider replay preserves prior reviewed debt classification', t => {
  const f = seed(t);
  const plan = prepareBankExportImport({ ok: true, accounts: [{ accountKey: 'debt',
    accountKind: 'other', balanceRole: 'neither', mask: '4242', transactions: [] }] },
  { entitySlug: 'owner', now, origin: { provenance: 'feed', sourceFeed: 'bank-feed:synthetic' } });
  assert.ok(plan.statements.length > 1, 'real import plan reached');
  for (const [sql, binds] of plan.statements) f.raw(sql, ...binds);
  assert.equal(f.first("SELECT account_kind FROM fin_accounts WHERE account_slug='debt'").account_kind, 'loan');
});
test('GREEN provider replay retains an explicitly typed debt', t => {
  const f = seed(t);
  const plan = prepareBankExportImport({ ok: true, accounts: [{ accountKey: 'debt',
    accountKind: 'loan', balanceRole: 'liability', mask: '4242', transactions: [] }] },
  { entitySlug: 'owner', now, origin: { provenance: 'feed', sourceFeed: 'bank-feed:synthetic' } });
  assert.ok(plan.statements.length > 1);
  for (const [sql, binds] of plan.statements) f.raw(sql, ...binds);
  assert.equal(f.first("SELECT account_kind FROM fin_accounts WHERE account_slug='debt'").account_kind, 'loan');
});
test('RED account-number memo locates a typed unique debt', async t => {
  const b = await seed(t, { memo: 'payment to acct no. xxxx4242' }).ask('What are my expenses?');
  assert.equal(b.ledger.expense_total_minor, 21000);
});
test('GREEN supported locator separates whole payment', async t => {
  assert.equal((await seed(t).ask('What are my expenses?')).ledger.expense_total_minor, 21000);
});
