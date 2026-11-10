import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import './own-movement-suffix-regressions.cases.mjs';

const spent = 'How much did I spend this month?';
const moneyOut = 'How much money went out this month?';
function book(t, description, payee = null, { connected = false, category = null, inflow = false } = {}) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('purchase', 'Store purchase', 'Store Unit', { cents: 567, direction: 'outflow' });
  f.add('customer', 'Customer payment', 'Customer Unit', { cents: 100000 });
  f.add('candidate', description, payee, { cents: 12345, direction: inflow ? 'inflow' : 'outflow' });
  if (category) f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid='candidate'", category);
  if (connected) {
    f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES ('reserve','owner','savings','asset','5678','Reserve account','manual','owner_stated','confirmed','2026-10-12')`);
    f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('reserve','complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')`);
  }
  return f;
}
async function reached(f, question = spent) {
  const start = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  const b = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted membership decision reached');
  assert.ok(b.ledger, 'ledger renderer reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer is read-only');
  return b;
}
for (const connected of [false, true]) test(`structured outside payee vetoes own nomination, connected=${connected}`, async t => {
  for (const description of ['WIRE TRANSFER TO SAVINGS SUPPLY', 'TRANSFER TO MY SAVINGS', 'TRANSFER TO ACCOUNT XXXX5678']) {
    const b = await reached(book(t, description, 'Savings Supply', { connected }));
    assert.equal(b.ledger.expense_total_minor, 12912, description);
    assert.equal(b.ledger.possible_payments, undefined, 'outside payee is never an own-movement exclusion');
  }
  const control = await reached(book(t, 'TRANSFER TO MY SAVINGS', null, { connected }));
  assert.equal(control.ledger.expense_total_minor, 567);
  assert.equal(control.ledger.possible_payments.length, 1, 'same channel with no outside identity is nominated');
});
test('whole destination rejects trailing identity and unresolved identity never disappears', async t => {
  for (const destination of ['SAVINGS SUPPLY', 'SAVINGS BANK & TRUST', 'SAVINGS STORE UNIT', 'SAVINGS XXXX5678 SUPPLY',
    'SAVINGS UNIT ACCOUNT XXXX6789', 'BROKERAGE UNIT ACCOUNT XXXX6789', 'RETIREMENT UNIT ACCOUNT XXXX6789', 'ESCROW UNIT ACCOUNT XXXX6789']) {
    const b = await reached(book(t, 'WIRE TRANSFER TO ' + destination));
    assert.equal(b.ledger.complete, false, destination + ': unresolved identity cannot certify spending');
    assert.equal(b.ledger.expense_total_minor, null, 'withheld without an own-movement subtraction');
    assert.ok(!b.ledger.possible_payments?.some(row => !row.included_in_total), 'ambiguous identity is never excluded');
  }
  for (const description of ['TRANSFER TO MY SAVINGS ACCOUNT ****5678', 'TRANSFER TO SAVINGS xx5678']) {
    const b = await reached(book(t, description));
    assert.equal(b.ledger.expense_total_minor, 567);
    assert.equal(b.ledger.possible_payments[0].destination, 'savings account');
  }
  const vendor = await reached(book(t, 'Store purchase', 'Savings Supply'));
  assert.equal(vendor.ledger.expense_total_minor, 12912);
  assert.equal(vendor.ledger.complete, true, 'ordinary vendor green control');
});
test('exact owned labels and masks keep their identity instead of substring matching', async t => {
  for (const payee of ['Reserve account', '5678']) {
    const b = await reached(book(t, 'TRANSFER TO MY SAVINGS', payee, { connected: true }));
    assert.equal(b.ledger.expense_total_minor, 567);
    assert.ok(b.ledger.possible_payments?.length, 'exact owned identity can nominate without proving a pair');
  }
  const b = await reached(book(t, 'TRANSFER TO MY SAVINGS', 'Reserve account services', { connected: true }));
  assert.equal(b.ledger.expense_total_minor, 12912, 'a label plus a party is outside evidence');
});
test('retirement remittance uses closed retirement forms and leaves service fees in spending', async t => {
  for (const role of ['401K', '403B', 'IRA', 'ROTH', 'ROTH IRA', 'RETIREMENT']) {
    for (const ending of ['CONTRIB', 'CONTRIBUTION', 'REMITTANCE']) {
      const b = await reached(book(t, `ACH DEBIT ${role} ${ending}`));
      assert.equal(b.ledger.expense_total_minor, 567);
      assert.equal(b.ledger.possible_payments[0].destination, 'retirement account');
      const out = await reached(book(t, `ACH DEBIT ${role} ${ending}`), moneyOut);
      assert.equal(out.ledger.expense_total_minor, 12912);
      assert.equal(out.ledger.possible_payments[0].included_in_total, true);
    }
  }
  const mixed = await reached(book(t, 'ACH DEBIT 401K REMITTANCE FEE 2.00'));
  assert.equal(mixed.ledger.expense_total_minor, null, 'unresolved components are never split');
  assert.equal(mixed.ledger.reason, 'own_movement_mixed_components');
  for (const [description, payee] of [['ACH DEBIT PLAN UNIT 401K REMITTANCE', 'Plan Unit'],
    ['ACH DEBIT 401K ADMIN FEE', 'Plan Unit'], ['ACH DEBIT 401K REMITTANCE SERVICES', null]]) {
    const b = await reached(book(t, description, payee));
    assert.equal(b.ledger.expense_total_minor, 12912);
    assert.equal(b.ledger.possible_payments, undefined, 'outside retirement service green control');
  }
});
test('owner expense confirmation still vetoes retirement and savings exclusions', async t => {
  for (const description of ['ACH DEBIT 401K REMITTANCE', 'TRANSFER TO MY SAVINGS',
    'WIRE TRANSFER TO SAVINGS SUPPLY', 'WIRE TRANSFER TO BANK UNIT ACCOUNT XXXX6789']) {
    const b = await reached(book(t, description, null, { category: 'SERVICES' }));
    assert.equal(b.ledger.expense_total_minor, 12912);
    assert.equal(b.ledger.complete, false);
    assert.equal(b.ledger.reason, 'own_movement_category_conflict');
    assert.equal(b.ledger.own_movement_conflicts.length, 1);
  }
});
test('incoming self movement is disclosed unverified and never acquires pair proof', async t => {
  for (const connected of [false, true]) {
    const f = book(t, 'ZELLE FROM SELF', null, { connected, inflow: true });
    if (connected) {
      f.add('self-out', 'ZELLE TO SELF', null, { cents: 12345, direction: 'outflow' });
      f.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='candidate'");
    }
    const b = await reached(f, 'Who paid me this month?');
    assert.equal(b.ledger.total_minor, 100000, 'ordinary customer remains the only payer');
    assert.equal(b.ledger.not_payments.count, 1);
    assert.equal(b.ledger.not_payments.total_minor, 12345);
    assert.equal(b.ledger.not_payments.rows[0].verified, false);
    assert.match(b.answer, /possibly from your own account/);
    assert.equal(b.ledger.complete, false);
    assert.ok(b.ledger.groups.every(group => group.complete === false));
    assert.ok(b.citations.some(c => c.n === b.ledger.not_payments.rows[0].n && c.amount_minor === 12345));
    assert.equal(b.ledger.matched_own_transfers?.count || 0, 0, 'no opposite leg exists');
  }
});

test('ambiguous wire identity retains the money-out counterpart decision', async t => {
  const description = 'WIRE TO OWNER ESCROW XXXX5678';
  const control = book(t, description, null, { connected: true });
  control.add('other-in', 'Incoming credit', null, { cents: 12346 });
  control.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='other-in'");
  assert.equal((await reached(control, moneyOut)).ledger.expense_total_minor, 12912, 'different amount cannot be a counterpart');
  const f = book(t, description, null, { connected: true });
  f.add('other-in', 'Incoming credit', null, { cents: 12345 });
  f.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='other-in'");
  const b = await reached(f, moneyOut);
  assert.equal(b.ledger.expense_total_minor, null, 'an unproved matching deposit withholds money out');
  assert.equal(b.ledger.complete, false);
  assert.equal(b.ledger.reason, 'money_out_destination_unconfirmed');
  assert.equal(b.ledger.possible_transfers.length, 1, 'ambiguous identity stays a generic transfer candidate');
  assert.equal(b.ledger.possible_transfers[0].destination, undefined, 'no owned destination is invented');
  assert.equal((await reached(f)).ledger.expense_total_minor, null, 'spending identity remains withheld');
});

test('monthly category conflicts retain the ambiguous destination without inventing an owned role', async t => {
  const f = book(t, 'WIRE TRANSFER TO SAVINGS SUPPLY', null, { category: 'SERVICES' });
  f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  const { withLedgerAnswer } = await import('../src/lib/ledger-answer.js');
  const start = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  let interpretations = 0;
  const b = await (await withLedgerAnswer({ env: f.env, question: 'Could you retrieve spending by month from August 1 through October 12?',
    now: Date.parse('2026-10-12T12:00:00Z'), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => { interpretations++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
      intents: [{ kind: 'expense_summary', direction: 'outflow', count: null, vendor_text: null, account_hint: null, amount_text: null,
        date_text: null, period: { type: 'between', from: '2026-08-01', to: '2026-10-12' } }] }) }] }; } },
  () => assert.fail('no document fallback'))).json();
  assert.equal(interpretations, 1, 'monthly interpretation reached');
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted monthly decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer is read-only');
  assert.equal(b.ledger.months.length, 3);
  assert.ok(b.ledger.months.slice(0, 2).every(month => month.total_minor === 0), 'ordinary empty-month controls');
  const month = b.ledger.months[2];
  assert.equal(month.complete, false);
  assert.equal(month.reason, 'own_movement_category_conflict');
  const [row] = month.own_movement_conflicts;
  assert.equal(row.amount_minor, 12345);
  assert.equal(row.identity_unconfirmed, true);
  assert.equal(row.destination, undefined);
  assert.ok(b.citations.some(c => c.n === row.n && c.amount_minor === 12345), 'conflict evidence survives citation rebasing');
  assert.match(b.answer, /a transfer with an unconfirmed destination/);
  assert.doesNotMatch(b.answer, /undefined/);
});

test('non-unique owned payee locators withhold instead of becoming outside evidence', async t => {
  for (const mode of ['label', 'mask']) for (const category of [null, 'SERVICES']) for (const position of ['payee', 'destination']) {
    const locator = mode === 'label' ? 'Reserve account' : 'account 5678';
    const f = book(t, position === 'destination' ? 'TRANSFER TO ' + locator : 'TRANSFER TO MY SAVINGS',
      position === 'payee' ? locator : null, { category });
    f.owner('other-owner');
    for (const [slug, owner, mask, label] of [
      ['reserve-one', 'owner', '5678', 'Reserve account'],
      ['reserve-two', 'other-owner', mode === 'mask' ? '5678' : '6789', mode === 'label' ? 'Reserve account' : 'Other reserve'],
    ]) {
      f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
        VALUES (?,?,'savings','asset',?,?,'manual','owner_stated','confirmed','2026-10-12')`, slug, owner, mask, label);
      f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,'complete','2024-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')`, slug);
    }
    const b = await reached(f);
    assert.equal(b.ledger.complete, false, mode + ': owned ambiguity cannot certify outside spending');
    assert.equal(b.ledger.expense_total_minor, category ? 12912 : null);
    assert.equal(b.ledger.reason, category ? 'own_movement_category_conflict' : 'own_movement_identity_unconfirmed');
    assert.ok(b.citations.some(c => c.amount_minor === 12345), 'ambiguous posting remains visible');
    if (category) assert.equal(b.ledger.own_movement_conflicts[0].identity_unconfirmed, true);
    else assert.equal(b.ledger.possible_own_movement_count, 1, 'identity decision stays nonempty');
    const out = await reached(f, moneyOut);
    assert.equal(out.ledger.expense_total_minor, 12912, 'without a counterpart money out counts the posting');
    assert.ok(Array.isArray(out.ledger.possible_payments), 'possible-payment receipt list remains present');
    const candidate = out.ledger.possible_payments.find(row => row.amount_minor === 12345);
    assert.ok(candidate, 'the ambiguous owned locator retains its receipt');
    assert.equal(candidate.payment_kind, 'own_account', 'owned locator ambiguity preserves the existing metadata contract');
    assert.equal(candidate.destination, undefined, 'metadata never invents an owned destination');
    assert.equal(candidate.included_in_total, true);
    assert.match(out.answer, /possibly a transfer/);
    assert.doesNotMatch(out.answer, /own_account payment|undefined/);
    f.add('matching-in', 'Incoming credit', null, { cents: 12345 });
    f.raw("UPDATE fin_transactions SET account_slug='reserve-one' WHERE txn_uid='matching-in'");
    const counterpart = await reached(f, moneyOut);
    assert.equal(counterpart.ledger.expense_total_minor, null, 'owned locator ambiguity retains the equal-amount counterpart hold');
    assert.equal(counterpart.ledger.reason, 'money_out_destination_unconfirmed');
    assert.ok(Array.isArray(counterpart.ledger.possible_payments), 'withheld possible-payment receipt list remains present');
    const withheld = counterpart.ledger.possible_payments.find(row => row.amount_minor === 12345);
    assert.ok(withheld, 'the withheld posting retains its receipt');
    assert.equal(withheld.destination_unconfirmed, true);
    assert.equal(withheld.destination, undefined);
    assert.ok(counterpart.citations.some(c => c.n === withheld.n && c.amount_minor === 12345));
  }
});
