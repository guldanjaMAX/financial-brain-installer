import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { ledgerFixture } from './ledger-review-fixture.mjs';

const spent = 'How much did I spend this month?';
const moneyOut = 'How much money went out this month?';
const evidence = [];
if (process.env.S9G_REPRO_RESULT) process.on('exit', () =>
  writeFileSync(process.env.S9G_REPRO_RESULT, JSON.stringify(evidence, null, 2) + '\n'));

function book(t, description, payee = null) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('purchase', 'Store purchase', 'Store Unit', { cents: 567, direction: 'outflow' });
  f.add('movement', description, payee, { cents: 12345, direction: 'outflow' });
  return f;
}

async function reached(f, label, question = spent, rows = 2) {
  assert.equal(f.rows('SELECT * FROM fin_transactions').length, rows, 'authored postings persisted');
  const start = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  const b = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted decision reached');
  assert.ok(b.ledger, 'ledger answer reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'no writes');
  evidence.push({ label, question, answer: b.answer, ledger: b.ledger });
  return b;
}

async function green(t, description = 'Supply purchase', payee = 'Supply Unit') {
  const b = await reached(book(t, description, payee), 'green ' + description);
  assert.equal(b.ledger.expense_total_minor, 12912, 'ordinary vendor stays in spending');
  assert.equal(b.ledger.complete, true, 'supported vendor remains answerable');
}

test('R1-B1 suffixed self preserves pre-R1 protection', async t => {
  await green(t);
  for (const description of ['ZELLE TO SELF', 'ZELLE TO SELF REF 5678', 'ZELLE TO SELF ACCOUNT ****5678']) {
    const b = await reached(book(t, description), description);
    assert.ok(b.ledger.complete === false || b.ledger.expense_total_minor === 567,
      'R1-B1 suffixed self cannot certify movement as spending');
  }
  // An account/reference suffix is closed. Appending a party cannot inherit SELF ownership.
  for (const description of ['ZELLE TO SELF SUPPLY', 'ZELLE TO SELF REF 5678 SUPPLY',
    'ZELLE TO SELF ACCOUNT ****5678 SUPPLY']) await green(t, description, null);
  await green(t, 'ZELLE TO SELF ACCOUNT ****5678', 'Supply Unit');
});

test('R1-B1 paired suffix retains money-out hold', async t => {
  await green(t);
  const single = await reached(book(t, 'ZELLE TO SELF ACCOUNT ****5678'), 'single suffix out', moneyOut);
  assert.equal(single.ledger.expense_total_minor, 12912, 'unproved single outflow stays in money out');
  const f = book(t, 'ZELLE TO SELF ACCOUNT ****5678');
  f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('other','owner','savings','asset','5678','Reserve account','manual','owner_stated','confirmed','2026-10-12')`);
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('other','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')`);
  f.add('customer', 'Customer payment', 'Customer Unit', { cents: 100000 });
  f.add('deposit', 'ZELLE FROM SELF ACCOUNT ****1234', null, { cents: 12345 });
  f.raw("UPDATE fin_transactions SET account_slug='other' WHERE txn_uid='deposit'");
  const s = await reached(f, 'paired suffix spending', spent, 4);
  const o = await reached(f, 'paired suffix out', moneyOut, 4);
  const p = await reached(f, 'paired suffix payer', 'Who paid me this month?', 4);
  assert.equal(o.ledger.complete, false, 'R1-B1 visible unproved counterpart must withhold money out');
  assert.equal(o.ledger.expense_total_minor, null);
  assert.ok(s.ledger.complete === false || s.ledger.expense_total_minor === 567);
  assert.equal(p.ledger.total_minor, 100000, 'own credit excluded from payer income');
  assert.equal(p.ledger.not_payments.total_minor, 12345);
  assert.equal(p.ledger.complete, false, 'payer qualification preserved');
});

test('R1-B2 retirement remittance account suffix is not certified spending', async t => {
  await green(t);
  for (const description of ['ACH DEBIT 401K REMITTANCE', 'ACH DEBIT 401K CONTRIB ACCOUNT ****5678',
    'ACH DEBIT 401K CONTRIBUTION ACCOUNT ****5678']) {
    const b = await reached(book(t, description), 'retirement control ' + description);
    assert.equal(b.ledger.expense_total_minor, 567);
    assert.ok(b.ledger.possible_payments.length > 0);
  }
  const b = await reached(book(t, 'ACH DEBIT 401K REMITTANCE ACCOUNT ****5678'), 'retirement suffix');
  assert.ok(b.ledger.complete === false || b.ledger.expense_total_minor === 567,
    'R1-B2 remittance suffix cannot certify movement as spending');
  await green(t, 'ACH DEBIT 401K REMITTANCE ACCOUNT ****5678 SERVICES', null);
  await green(t, 'ACH DEBIT 401K REMITTANCE ACCOUNT ****5678', 'Plan Unit');
  const mixed = await reached(book(t, 'ACH DEBIT 401K REMITTANCE ACCOUNT ****5678 FEE 2.00'), 'retirement mixed');
  assert.equal(mixed.ledger.complete, false);
  assert.equal(mixed.ledger.expense_total_minor, null, 'component amounts never inferred');
  assert.equal(mixed.ledger.reason, 'own_movement_mixed_components');
});

test('R1-B3 raw star mask preserves movement evidence', async t => {
  for (const role of ['RESERVE', 'EMERGENCY']) await t.test(role, async t => {
    await green(t);
    const control = await reached(book(t, `TRANSFER TO MY ${role} xx5678`), role + ' x-mask control');
    assert.equal(control.ledger.complete, false, 'unresolved decorated destination control');
    const account = await reached(book(t, `TRANSFER TO MY ${role} ACCOUNT ****5678`), role + ' account control');
    assert.equal(account.ledger.complete, false);
    const f = book(t, `TRANSFER TO MY ${role} ****5678`);
    const b = await reached(f, role + ' star spending');
    const out = await reached(f, role + ' star out', moneyOut);
    assert.ok(b.ledger.complete === false || b.ledger.expense_total_minor === 567,
      'R1-B3 raw star mask cannot certify movement as spending');
    assert.equal(out.ledger.expense_total_minor, 12912, 'unproved destination remains in money out');
    assert.ok((out.ledger.possible_payments?.length || out.ledger.possible_transfers?.length) > 0,
      'unproved movement disclosed');
    await green(t, `TRANSFER TO MY ${role} ****5678`, 'Supply Unit');
  });
});
