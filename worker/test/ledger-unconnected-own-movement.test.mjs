import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';

// Synthetic truth: every destination below is the owner's own account and is
// not connected. Bank text may nominate a possible own movement; it can never
// certify that movement as spending, a ranking entry or a recurring charge.
const families = [
  ['savings', 'SAVINGS UNIT', 'savings', 'savings', ['savings account']],
  ['brokerage', 'BROKERAGE UNIT', 'investment', 'brokerage', ['investment account']],
  ['retirement', 'RETIREMENT UNIT', 'retirement', 'retirement', ['retirement account']],
  ['escrow', 'ESCROW UNIT', 'escrow', 'escrow', ['escrow account']],
  ['second-bank', 'BANK UNIT', 'account', 'account', ['account']],
  ['self-p2p', 'SELF', 'self', 'self', ['account (sent to yourself)']],
  ['owner-draw', 'PERSONAL OWNER DRAW', 'personal account', 'owner draw', ['personal account', 'personal account (owner draw)']],
  ['owner-contribution', 'BUSINESS OWNER CONTRIBUTION', 'business account', 'owner contribution', ['business account', 'business account (owner contribution)']],
];
const forms = [
  ['uppercase-mask', (institution, kind) => `${institution} TRANSFER TO ${kind.toUpperCase()} XXXX6789`],
  ['channel', (institution, kind, channel) => `ONLINE TRANSFER TO ${channel.toUpperCase()} XXXX6789`],
  ['processor', institution => `ACH DEBIT ${institution} CONTRIB`],
  // A bank's institution words are identity, not an account-role locator.
  ['wire', (institution, kind, channel) => `WIRE TRANSFER TO ${channel.toUpperCase()} XXXX6789`],
  ['plain', (institution, kind) => `transfer to ${kind}`],
];
// Category states. Only an owner-confirmed expense category vetoes the
// nomination; a provider proposal or a confirmed movement code does not.
const categories = [
  ['absent', null, null],
  ['provider-transfer', 'TRANSFER_OUT', 'proposed'],
  ['provider-expense', 'GENERAL_SERVICES', 'proposed'],
  ['owner-transfer', 'TRANSFER_OUT', 'confirmed'],
  ['owner-expense', 'SERVICES', 'confirmed'],
];
// Fixed seed: a deterministic rotation gives every family all five category
// states and every form at least one of each state, in a reproducible order.
const SEED = 0x0f7;
const witnesses = families.flatMap(([family, institution, kind, channel, destinations], familyIndex) =>
  forms.map(([form, describe], formIndex) => ({ family, form, destinations,
    description: describe(institution, kind, channel),
    category: categories[(familyIndex + formIndex + SEED) % categories.length] })));
const wentOut = 'How much went out this month?';
const questions = ['How much did I spend this month?', wentOut,
  'What were my biggest expenses this month?', 'Show recurring charges'];
// "went out" measures money out (went-out v2): no connected account could have
// received these postings, so a possible own movement left the connected
// accounts. It stays in money out and is disclosed; spending excludes it.

function book(t, description, [, category, basis] = categories[0], payee = null) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('purchase', 'Store purchase', 'Store Unit', { cents: 567, direction: 'outflow' });
  for (const [i, date] of ['2026-08-05', '2026-09-05', '2026-10-05'].entries())
    f.add('move-' + i, description, payee, { cents: 12345, direction: 'outflow', date });
  if (category) f.raw("UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid LIKE 'move-%'", category, basis);
  return f;
}
async function reached(f, question) {
  const before = f.first('SELECT total_changes() n').n, start = f.calls.length;
  const b = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'no writes');
  assert.ok(b.ledger, 'ledger answer reached');
  return b;
}
const amounts = l => (l.lead_rows || l.rows || []).map(r => r.amount_minor);

for (const w of witnesses) {
  const [state] = w.category;
  if (state === 'owner-expense') continue;
  test(`own movement excluded and disclosed on every spending surface: ${w.family}/${w.form}/${state}`, async t => {
    const f = book(t, w.description, w.category);
    for (const q of questions) {
      const b = await reached(f, q), l = b.ledger;
      const candidates = l.possible_payments;
      assert.ok(candidates?.length > 0, 'nonempty own-movement decision');
      for (const r of candidates) {
        assert.equal(r.payment_kind, 'own_account');
        assert.ok(w.destinations.includes(r.destination), `bounded destination role: ${r.destination}`);
        assert.equal(r.amount_minor, 12345);
        assert.ok(b.citations.some(c => c.n === r.n && c.amount_minor === r.amount_minor && c.posted_on === r.posted_on));
        assert.ok(b.answer.includes(q === wentOut ? `included above, possibly a transfer to your own ${r.destination} (counterpart not proved): $123.45`
          : `possible transfer to your own ${r.destination}, not counted as spending: $123.45`), 'own line');
        assert.equal(r.included_in_total, q === wentOut ? true : undefined);
        assert.ok(b.answer.includes(w.description), 'bank text quoted without parsing');
      }
      if (q === wentOut) { assert.equal(l.expense_total_minor, 567 + 12345, 'money out keeps the possible own movement'); assert.equal(l.complete, true); }
      assert.doesNotMatch(b.answer, /retained in income\/spend totals\): \$123\.45/, 'never also kept as an unmatched transfer');
      if (q === questions[0]) { assert.equal(l.expense_total_minor, 567, 'store green control'); assert.equal(l.complete, true); }
      if (l.kind === 'largest') assert.deepEqual(amounts(l), [567], 'ranking keeps only the store');
      if (l.kind === 'recurring') assert.equal(l.recurring.length, 0, 'never a recurring charge');
    }
  });
}

for (const w of witnesses.filter(w => w.category[0] === 'owner-expense')) {
  test(`owner-confirmed expense category vetoes the exclusion and withholds certification: ${w.family}/${w.form}`, async t => {
    const f = book(t, w.description, w.category);
    for (const q of questions) {
      const b = await reached(f, q), l = b.ledger;
      if (q === wentOut) {
        // Money out never removes a possible own movement, so the owner's
        // category has nothing to veto: both readings count the posting.
        assert.equal(l.expense_total_minor, 12912, 'money out counts it under either reading');
        assert.equal(l.complete, true);
        assert.equal(l.own_movement_conflicts, undefined);
        const [r] = l.possible_payments;
        assert.ok(w.destinations.includes(r.destination));
        assert.equal(r.included_in_total, true);
        assert.ok(b.answer.includes(`included above, possibly a transfer to your own ${r.destination} (counterpart not proved): $123.45`), 'own line');
        continue;
      }
      assert.equal(l.possible_payments, undefined, 'veto: never excluded as an own movement');
      assert.equal(l.complete, false, 'conflicting bank text is never certified');
      assert.equal(l.reason, 'own_movement_category_conflict');
      assert.ok(l.own_movement_conflicts?.length > 0);
      for (const r of l.own_movement_conflicts) {
        assert.ok(w.destinations.includes(r.destination));
        assert.ok(b.citations.some(c => c.n === r.n && c.amount_minor === 12345));
      }
      assert.doesNotMatch(b.answer, /^You spent/m);
      assert.ok(b.answer.includes('counted as spending because you confirmed its category as SERVICES'));
      assert.ok(b.answer.includes(w.description));
      if (l.kind === 'expense_summary') assert.equal(l.expense_total_minor, 12912, 'owner category keeps it in spending');
      if (l.kind === 'largest') assert.deepEqual(amounts(l), [12345, 567], 'owner category keeps it ranked');
    }
  });
}

test('green controls: merchants, movement words in merchant text and owner-confirmed expenses stay spending', async t => {
  for (const [description, payee, category] of [
    ['MERCHANT PURCHASE', 'Store Unit', null], ['TRUCKING SERVICE', 'Transfer Trucking Unit', null],
    ['SAVINGS MARKET GROCERY', null, null], ['RETIREMENT HOME CARE', null, null], ['ESCROW SERVICES FEE', null, null],
    ['WIRE TRANSFER TO SUPPLIER UNIT INC', null, null], ['CHARITY CONTRIB', null, null], ['ZELLE TO PAYEE UNIT', null, null],
    ['SAVINGS UNIT TRANSFER TO SAVINGS XXXX6789', null, 'SERVICES'],
  ]) {
    const f = book(t, description, category ? ['owner-expense', category, 'confirmed'] : categories[0], payee);
    const b = await reached(f, questions[0]);
    assert.equal(b.ledger.expense_total_minor, 12912, `${description} stays spending`);
    assert.equal(b.ledger.possible_payments, undefined, `${description} is not excluded`);
    if (!category) assert.equal(b.ledger.complete, true);
    const ranked = await reached(f, questions[2]);
    assert.deepEqual(amounts(ranked.ledger), [12345, 567]);
  }
});

test('owner-confirmed movement categories never veto the own-movement exclusion', async t => {
  for (const category of ['TRANSFER_OUT_SAVINGS', 'Savings', 'Owner draw', 'Internal transfer']) {
    const f = book(t, 'ONLINE TRANSFER TO SAVINGS XXXX6789', ['owner-movement', category, 'confirmed']);
    const b = await reached(f, questions[0]);
    assert.equal(b.ledger.expense_total_minor, 567, `${category} is a movement code, not an expense`);
    assert.equal(b.ledger.complete, true);
    assert.equal(b.ledger.possible_payments?.length, 1);
    assert.equal(b.ledger.own_movement_conflicts, undefined);
  }
});

test('green control: a connected own transfer that pairs is a matched movement, not a possible one', async t => {
  const f = book(t, 'TRANSFER TO SAVINGS 6789');
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('connected-savings','owner','savings','asset','6789','live','feed','bank-feed:fixture-feed','confirmed','2026-10-12')`);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('connected-savings','complete','2024-01-01','2026-10-31','2026-10-12','feed','bank-feed:fixture-feed','confirmed','2026-10-12')`);
  for (const [i, date] of ['2026-08-05', '2026-09-05', '2026-10-05'].entries())
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'connected-savings',?,12345,'inflow','TRANSFER FROM CHECKING 1234','feed','bank-feed:fixture-feed','confirmed','2026-10-12')`, 'in-' + i, date);
  const b = await reached(f, questions[0]);
  assert.equal(b.ledger.expense_total_minor, 567);
  assert.equal(b.ledger.matched_transfer_count, 1);
  assert.equal(b.ledger.excluded_own_transfer_minor, 12345);
  assert.equal(b.ledger.possible_payments, undefined);
});

test('connected destination mask without endpoint proof is still a possible own movement', async t => {
  // Naming a connected account is not proof. The anchored endpoint grammar
  // cannot read this form, so no existing reader removes it: the shared
  // nominator must, or the own movement is counted as spending.
  const connect = f => {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      VALUES ('connected-savings','owner','savings','asset','6789','live','feed','bank-feed:fixture-feed','confirmed','2026-10-12')`);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES ('connected-savings','complete','2024-01-01','2026-10-31','2026-10-12','feed','bank-feed:fixture-feed','confirmed','2026-10-12')`);
    return f;
  };
  for (const text of ['SAVINGS UNIT TRANSFER TO SAVINGS XXXX6789', 'SAVINGS UNIT TRANSFER TO SAVINGS XXXX5555']) {
    const b = await reached(connect(book(t, text)), questions[0]);
    assert.equal(b.ledger.possible_payments?.length, 1, `${text}: nominated`);
    assert.equal(b.ledger.possible_payments[0].destination, 'savings account');
    assert.equal(b.ledger.expense_total_minor, 567);
    assert.equal(b.ledger.complete, true);
  }
  // A resolved account identity without its reciprocal posting is still only
  // a possible movement. Spending excludes it with the same cited disclosure.
  const proved = await reached(connect(book(t, 'TRANSFER TO SAVINGS 6789')), questions[0]);
  assert.deepEqual(proved.ledger.possible_payments.map(row => [row.amount_minor, row.destination]), [[12345, 'savings account']]);
  assert.match(proved.answer, /possible transfer to your own savings account, not counted as spending/);
  assert.equal(proved.ledger.expense_total_minor, 567);
});

for (const text of ['ONLINE TRANSFER TO SAVINGS XXXX6789 FEE 2.00', 'WIRE TRANSFER TO ACCOUNT XXXX6789 USD 100.00 USD 23.45',
  'TRANSFER TO RETIREMENT XXXX6789 PENALTY']) test(`mixed own movement withholds without splitting: ${text}`, async t => {
  const f = book(t, text);
  for (const q of [questions[0], questions[2]]) {
    const b = await reached(f, q), l = b.ledger;
    assert.equal(l.complete, false);
    assert.equal(l.total_minor, null);
    assert.equal(l.expense_total_minor, null);
    assert.equal(l.reason, 'own_movement_mixed_components');
    assert.match(b.answer, /possible transfer to your own account also names a fee, charge or second amount/);
    assert.ok(l.possible_payments?.length > 0);
    assert.ok(b.answer.includes(text));
  }
});

test('monthly components keep own-movement lines and conflict refusals', async t => {
  const { withLedgerAnswer } = await import('../src/lib/ledger-answer.js');
  for (const category of [categories[0], categories[4]]) {
    const f = book(t, 'ONLINE TRANSFER TO SAVINGS XXXX6789', category);
    f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
    let calls = 0;
    const intents = [{ kind: 'expense_summary', direction: 'outflow', count: null, vendor_text: null, account_hint: null,
      amount_text: null, date_text: null, period: { type: 'between', from: '2026-08-01', to: '2026-10-12' } }];
    const b = await (await withLedgerAnswer({ env: f.env, question: 'Could you retrieve spending by month from August 1 through October 12?',
      now: Date.parse('2026-10-12T12:00:00Z'), grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => { calls++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents }) }] }; } },
    () => assert.fail('no document fallback'))).json();
    assert.ok(calls > 0, 'injected interpretation admitted');
    assert.equal(b.ledger.months.length, 3, 'month decisions reached');
    for (const m of b.ledger.months) {
      if (category[0] === 'absent') {
        assert.equal(m.possible_payments.length, 1);
        assert.equal(m.possible_payments[0].destination, 'savings account');
        assert.ok(b.citations.some(c => c.n === m.possible_payments[0].n && c.posted_on === m.possible_payments[0].posted_on));
        assert.equal(m.total_minor, m.month === '2026-10' ? 567 : 0, 'ordinary store control');
      } else {
        assert.equal(m.available, false);
        assert.equal(m.total_minor, null);
        assert.equal(m.reason, 'own_movement_category_conflict');
        assert.equal(m.own_movement_conflicts.length, 1);
        assert.ok(b.citations.some(c => c.n === m.own_movement_conflicts[0].n));
      }
    }
    const line = category[0] === 'absent' ? 'possible transfer to your own savings account, not counted as spending:'
      : 'confirmed as SERVICES but the bank text names a possible transfer to your own savings account:';
    assert.equal(b.answer.split(line).length - 1, 3, 'each candidate has its own line');
  }
});

test('business-scoped spending uses the same partition', async t => {
  const f = book(t, 'ONLINE TRANSFER TO OWNER DRAW XXXX6789');
  f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  const { withLedgerAnswer } = await import('../src/lib/ledger-answer.js');
  const intents = [{ kind: 'expense_summary', direction: 'outflow', count: null, vendor_text: null, account_hint: 'business',
    amount_text: null, date_text: null, period: { type: 'this_month' } }];
  const b = await (await withLedgerAnswer({ env: f.env, question: 'How much did my business spend this month?',
    now: Date.parse('2026-10-12T12:00:00Z'), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents }) }] }) },
  () => assert.fail('no document fallback'))).json();
  assert.equal(b.ledger.operation_scope?.role, 'business', 'scoped decision reached');
  assert.equal(b.ledger.expense_total_minor, 567);
  assert.equal(b.ledger.possible_payments[0].destination, 'personal account (owner draw)');
  assert.ok(b.answer.includes('possible transfer to your own personal account (owner draw), not counted as spending: $123.45'));
});
