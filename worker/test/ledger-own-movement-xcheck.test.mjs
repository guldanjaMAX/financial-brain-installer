import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';

// Synthetic truth: every movement row below goes to the owner's own account or
// liability. Its other leg is connected only where a test connects it. The
// store purchase is the only ordinary spending, and the client payment the
// only income, so every figure below has one exact integer-cent answer.
const STORE = 567, CLIENT = 50000, MOVE = 12345;
const questions = { spent: 'How much did I spend this month?', largest: 'What were my biggest expenses this month?',
  recurring: 'What are my recurring charges?', net: 'What was my net income this month?' };
const dates = ['2026-08-05', '2026-09-05', '2026-10-05'];

function book(t, description, { monthly = false, category = null, payee = null } = {}) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('purchase', 'Store purchase', 'Store Unit', { cents: STORE, direction: 'outflow' });
  f.add('client', 'CLIENT PAYMENT', 'Client Unit', { cents: CLIENT, direction: 'inflow' });
  for (const [i, date] of (monthly ? dates : dates.slice(2)).entries())
    f.add('move-' + i, description, payee, { cents: MOVE, direction: 'outflow', date });
  if (category) f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid LIKE 'move-%'", category);
  return f;
}
function connect(f, { kind = 'savings', mask = '5678', label = null, role = 'asset' } = {}) {
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('connected-own','owner',?,?,?,?,'live','feed','bank-feed:fixture-feed','confirmed','2026-10-12')`, kind, role, mask, label);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('connected-own','complete','2024-01-01','2026-10-31','2026-10-12','feed','bank-feed:fixture-feed','confirmed','2026-10-12')`);
  return f;
}
function deposit(f, description, cents = MOVE) {
  f.add('leg-in', description, null, { cents, direction: 'inflow' });
  f.raw("UPDATE fin_transactions SET account_slug='connected-own' WHERE txn_uid='leg-in'");
}
async function reached(f, question) {
  const before = f.first('SELECT total_changes() n').n, start = f.calls.length;
  const b = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'no writes');
  assert.ok(b.ledger, 'ledger answer reached');
  return b;
}
const ranked = l => (l.lead_rows || []).map(r => r.amount_minor);

// Excluded and disclosed on every spending surface: spending, ranking and
// cadence. Net income is money in minus money out (went-out v2): no connected
// account received the posting, so it stays in money out and is disclosed.
async function assertExcluded(t, f, monthlyF, { line, kind = null, destination = null }) {
  const spent = await reached(f, questions.spent);
  assert.equal(spent.ledger.expense_total_minor, STORE, 'never counted as spending');
  assert.equal(spent.ledger.complete, true);
  const candidate = spent.ledger.possible_payments?.[0];
  assert.ok(candidate, 'nominated and disclosed');
  if (kind) assert.equal(candidate.payment_kind, kind);
  if (destination) assert.equal(candidate.destination, destination);
  assert.ok(spent.citations.some(c => c.n === candidate.n && c.amount_minor === MOVE), 'cited');
  assert.ok(spent.answer.includes(line), line);
  assert.deepEqual(ranked((await reached(f, questions.largest)).ledger), [STORE], 'ranking keeps only the store');
  const net = await reached(f, questions.net);
  assert.equal(net.ledger.net_minor, CLIENT - STORE - MOVE, 'net income is exact under the money-out rule');
  assert.equal(net.ledger.possible_payments?.[0]?.included_in_total, true, 'counted money-out operand');
  assert.ok(net.answer.includes('included in money out above, possibly '), 'money-out disclosure');
  assert.equal((await reached(monthlyF, questions.recurring)).ledger.recurring.length, 0, 'never a recurring charge');
}

for (const [text, destination] of [['Transfer to personal', 'personal account'], ['Transfer to business', 'business account'],
  ['TRANSFER TO MY PERSONAL XXXX5678', 'personal account'], ['ONLINE TRANSFER TO BUSINESS ACCOUNT 5678', 'business account']]) {
  test(`bare owner account destination is a possible own movement: ${text}`, async t => {
    await assertExcluded(t, book(t, text), book(t, text, { monthly: true }),
      { line: `possible transfer to your own ${destination}, not counted as spending: $123.45`, kind: 'own_account', destination });
  });
}

for (const [text, kind] of [['Transfer to credit card', 'card'], ['TRANSFER TO CREDIT CARD XXXX5678', 'card'],
  ['Transfer to loan', 'loan'], ['TRANSFER TO MORTGAGE ACCT 5678', 'loan'],
  ['ACH DEBIT OWNER LOAN PAYMENT', 'loan'], ['ACH DEBIT SYNTHETIC LENDER MORTGAGE PMT XXXX5678', 'loan'],
  ['ACH DEBIT SYNTHETIC ISSUER CREDIT CARD AUTOPAY', 'card']]) {
  test(`liability transfer and processor forms share the payment nomination: ${text}`, async t => {
    await assertExcluded(t, book(t, text), book(t, text, { monthly: true }),
      { line: `possible ${kind} payment, not counted as spending: $123.45`, kind });
  });
}

for (const [text, account] of [['ACH DEBIT OWNER SAVINGS CONTRIB', { label: 'savings' }], ['WIRE TO ACCT 5678', { kind: 'checking' }],
  ['BROKERAGE CONTRIBUTION XXXX5678', { kind: 'investment' }], ['ZELLE TO SELF XXXX5678', { kind: 'checking' }]]) {
  test(`connected destination named without endpoint proof is still possible: ${text}`, async t => {
    await assertExcluded(t, connect(book(t, text), account), connect(book(t, text, { monthly: true }), account),
      { line: 'possible transfer to your own', kind: 'own_account' });
    // The deposit proves its own leg; the outgoing text proves nothing. An
    // equal deposit in a connected account could be its other leg, so money
    // out is withheld rather than counting a likely own movement.
    const paired = connect(book(t, text), account);
    deposit(paired, 'Transfer from account 1234');
    const pairedNet = await reached(paired, questions.net);
    assert.equal(pairedNet.ledger.net_minor ?? null, null);
    assert.equal(pairedNet.ledger.reason, 'money_out_destination_unconfirmed');
    assert.equal((await reached(paired, questions.spent)).ledger.expense_total_minor, STORE);
  });
}

test('connected destination with an outside structured payee stays ordinary spending', async t => {
  // The existing readers resolve the named connected account and keep the row
  // as ordinary money because the payee is an outside party; never override.
  for (const [text, account] of [['WIRE TO ACCT 5678', { kind: 'checking' }],
    ['TRANSFER TO LOAN ACCT NO. XXXX5678', { kind: 'loan', role: 'liability' }],
    ['ACH DEBIT OWNER SAVINGS CONTRIB', { label: 'savings' }]]) {
    const b = await reached(connect(book(t, text, { payee: 'Outside Unit' }), account), questions.spent);
    assert.equal(b.ledger.possible_payments, undefined, `${text}: an outside payee is never a possible own movement`);
    assert.equal(b.ledger.expense_total_minor, STORE + MOVE);
    assert.deepEqual(ranked((await reached(connect(book(t, text, { payee: 'Outside Unit' }), account), questions.largest)).ledger), [MOVE, STORE]);
    // Control: the same row with a channel payee is still a possible movement.
    const channel = await reached(connect(book(t, text, { payee: 'Online Transfer' }), account), questions.spent);
    assert.equal(channel.ledger.expense_total_minor, STORE, `${text}: channel payee carries no party`);
  }
});

test('connected destination with an unproved matching deposit withholds net income instead of half-removing it', async t => {
  for (const [text, account, legText] of [['ACH DEBIT OWNER SAVINGS CONTRIB', { label: 'savings' }, 'DEPOSIT'],
    ['WIRE TO ACCT 5678', { kind: 'checking' }, 'INCOMING WIRE'], ['ZELLE TO SELF XXXX5678', { kind: 'checking' }, 'ZELLE FROM SELF']]) {
    const f = connect(book(t, text), account);
    deposit(f, legText);
    const net = await reached(f, questions.net);
    assert.equal(net.ledger.net_minor ?? null, null, `${text}: never one leg removed`);
    assert.equal(net.ledger.complete, false);
    // Went-out v2 keeps the outgoing leg in money out, so the equal deposit is
    // a possible other leg in a connected account and money out is withheld.
    assert.equal(net.ledger.reason, 'money_out_destination_unconfirmed');
    const [candidate] = net.ledger.possible_payments;
    assert.equal(candidate.destination_unconfirmed, true);
    assert.deepEqual(candidate.connected_counterpart_masks, ['5678']);
    assert.ok(net.citations.some(c => c.n === candidate.n && c.amount_minor === MOVE));
    assert.ok(net.answer.includes(text), 'outgoing leg quoted');
    // Spending never reads the deposit; it stays exact.
    assert.equal((await reached(f, questions.spent)).ledger.expense_total_minor, STORE);
    // A different amount is not a counterpart; net stays answered, and the
    // outgoing leg that reached no connected account stays in money out.
    const other = connect(book(t, text), account);
    deposit(other, legText, MOVE + 1);
    assert.equal((await reached(other, questions.net)).ledger.net_minor, CLIENT + MOVE + 1 - STORE - MOVE);
  }
});

test('a resolved owned endpoint is never a recurring charge, even without its other leg', async t => {
  for (const [text, account] of [['Transfer to investment', { kind: 'investment', label: 'investment' }],
    ['Transfer to escrow', { kind: 'escrow', label: 'escrow' }], ['Transfer to self', { kind: 'checking', label: 'self' }]]) {
    const f = connect(book(t, text, { monthly: true }), account);
    const b = await reached(f, questions.recurring);
    assert.equal(b.ledger.recurring.length, 0, `${text}: possible own movement excluded from cadence`);
    assert.equal(b.ledger.possible_payments.length, 3, 'unpaired endpoints remain possible');
    for (const row of b.ledger.possible_payments) {
      assert.equal(row.amount_minor, MOVE);
      assert.ok(b.citations.some(ref => ref.n === row.n && ref.amount_minor === MOVE));
      assert.ok(b.answer.split('\n').some(line => line.includes(`[${row.n}]`) && /possible.*not counted/.test(line)));
    }
    assert.equal((await reached(connect(book(t, text), account), questions.spent)).ledger.expense_total_minor, STORE);
  }
  const paired = connect(book(t, 'TRANSFER TO ACCOUNT 5678', { monthly: true }));
  for (const [index, date] of dates.entries()) {
    paired.add('paired-in-' + index, 'TRANSFER FROM ACCOUNT 1234', null, { date, cents: MOVE, direction: 'inflow' });
    paired.raw("UPDATE fin_transactions SET account_slug='connected-own' WHERE txn_uid=?", 'paired-in-' + index);
  }
  const proof = await reached(paired, questions.recurring);
  assert.equal(proof.ledger.monthly_total_minor, 0, 'proved pair control reaches the cadence partition');
  assert.equal(proof.ledger.set_aside_recurring.length, 0);
  assert.equal(proof.ledger.possible_owned_movements.length, 0);
});

test('an account-type review hold is kept by the existing reader, never partitioned away', async t => {
  const f = connect(book(t, 'TRANSFER TO SAVINGS 5678'), { kind: 'other' });
  const start = f.calls.length;
  const b = await f.ask(questions.spent);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted decision reached');
  assert.equal(b.ledger?.expense_total_minor ?? null, null, 'withheld, never a figure');
  assert.equal(b.ledger?.possible_payments, undefined, 'never partitioned as a possible movement');
  assert.ok(b.gaps?.some(gap => gap.reason === 'ledger_account_kind_review_required'), 'the review hold is asked');
});

test('mixed bare, liability and processor movements withhold without splitting', async t => {
  for (const [text, reason] of [['TRANSFER TO PERSONAL FEE 2.00', 'own_movement_mixed_components'],
    ['Transfer to business $10.00 PLUS $2.00', 'own_movement_mixed_components'],
    ['Transfer to loan PRINCIPAL PLUS INTEREST', 'loan_payment_mixed_components'],
    ['TRANSFER TO CREDIT CARD FEE 2.00', 'own_movement_mixed_components'],
    ['Transfer to credit card $10.00 PLUS $2.00', 'own_movement_mixed_components'],
    ['ACH DEBIT SYNTHETIC LENDER LOAN PAYMENT FEE 2.00', 'loan_payment_mixed_components']]) {
    for (const question of [questions.spent, questions.largest]) {
      const l = (await reached(book(t, text), question)).ledger;
      assert.equal(l.complete, false, text);
      assert.equal(l.expense_total_minor, null);
      assert.equal(l.reason, reason);
    }
  }
});

test('owner-confirmed expense category on a newly read form is counted but never certified', async t => {
  for (const text of ['Transfer to personal', 'Transfer to business']) {
    const b = await reached(book(t, text, { category: 'SERVICES' }), questions.spent);
    assert.equal(b.ledger.expense_total_minor, STORE + MOVE, 'owner category keeps it in spending');
    assert.equal(b.ledger.complete, false);
    assert.equal(b.ledger.reason, 'own_movement_category_conflict');
    assert.equal(b.ledger.own_movement_conflicts?.length, 1);
  }
  const connected = connect(book(t, 'ACH DEBIT OWNER SAVINGS CONTRIB', { category: 'SERVICES' }), { label: 'savings' });
  const b = await reached(connected, questions.spent);
  assert.equal(b.ledger.expense_total_minor, STORE + MOVE);
  assert.equal(b.ledger.complete, false, 'a connected but unproved destination is not certified either');
  assert.equal(b.ledger.reason, 'own_movement_category_conflict');
});

test('green controls: outside parties named next to account words stay spending', async t => {
  for (const [text, payee] of [['TRANSFER TO BUSINESS SOLUTIONS LLC', null], ['TRANSFER TO PERSONAL TRAINER STUDIO', null],
    ['WIRE TRANSFER TO PERSONAL INJURY LAW GROUP', null], ['TRANSFER TO LOAN DEPOT UNIT INC', 'Loan Depot Unit Inc'],
    ['TRANSFER TO CREDIT CARD PROCESSING CO', null], ['ACH DEBIT LOAN PAYMENT PROCESSING CENTER', null],
    ['ACH DEBIT MERCHANT SERVICES CREDIT CARD PAYMENT PROCESSING FEE', null], ['PAYROLL UNIT PAYROLL', 'Payroll Unit'],
    ['PAYROLL TRANSFER TO PAYROLL UNIT', 'Payroll Unit'], ['WIRE TRANSFER TO PAYROLL ACCOUNT', null], ['ACH DEBIT PLAN UNIT 401K REMITTANCE', 'Plan Unit'],
    ['ACH DEBIT CHARITY UNIT DONATION', null], ['TRANSFER TO BUSINESS PARTNER UNIT', null]]) {
    const b = await reached(book(t, text, { payee }), questions.spent);
    assert.equal(b.ledger.expense_total_minor, STORE + MOVE, `${text} stays spending`);
    assert.equal(b.ledger.possible_payments, undefined, `${text} is not nominated`);
    assert.equal(b.ledger.complete, true);
    assert.deepEqual(ranked((await reached(book(t, text, { payee }), questions.largest)).ledger), [MOVE, STORE]);
  }
});
