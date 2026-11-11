import { loanPaymentSubject } from '../src/lib/ledger-intent-contract.js';
import { ordinaryMoneyMembership, pairOwnTransfers } from '../src/lib/ledger-analysis.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { recordedIntent } from './fixtures/ledger-intent-cases.mjs';
const { withLedgerAnswer } = await import(process.env.LOAN_GUARD_MODULE || '../src/lib/ledger-answer.js');

// Authored cents and economic roles are independent of the product classifiers.
function book(t, { other = 'savings', rows = [], label = 'Operating' } = {}) {
  const f = fixture(t); f.owner();
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const [slug, kind, mask, name] of [['main', 'checking', '1234', label], ['other', other, '5678', 'Reserve']]) {
    f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,?, 'manual','owner_stated','confirmed',?)`, slug, kind, ['loan','card','line_of_credit'].includes(kind) ? 'liability' : 'asset', mask, name, NOW);
    f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',10000,'owner_stated','confirmed',?)`, slug, NOW);
  }
  for (const [i, r] of rows.entries()) f.raw(`INSERT INTO fin_transactions(txn_uid,external_id,account_slug,posted_on,amount_minor,direction,description,payee,pending,pending_transaction_id,provenance,basis_state,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, `row-${i}`, `external-${i}`, r.account || 'main', r.date || '2026-09-15', r.cents || 1,
    r.direction || 'outflow', r.description, r.payee || null, r.pending ? 1 : 0, r.pendingId ?? null, NOW);
  return f;
}
async function ask(f, question, kind = 'expense_summary', extra = {}) {
  const calls = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  let provider = 0;
  f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  const b = await (await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => { provider++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
      intents: Array.isArray(kind) ? kind : [recordedIntent(kind, { period: { type: 'last_month' }, direction: 'outflow', ...extra })] }) }] }; } },
  async gap => Response.json({ answer: null, gaps: gap ? [gap] : [] }))).json();
  assert.ok(provider || f.calls.length > calls, 'real parser or reader decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer performs no writes');
  return b;
}
const scopeForms = ['', ' for my business'];
for (const scope of scopeForms) {
  test(`G1 payment subject refuses ordinary expense substitution${scope}`, async t => {
    const f = book(t, { other: 'loan', rows: [{ description: 'Ordinary purchase', payee: 'Store Unit', cents: 123 }] });
    for (const subject of ['loan', 'mortgage', 'lender', 'line of credit']) {
      const b = await ask(f, `How much did I pay on my ${subject} last month${scope}?`, 'totals', { account_hint: subject, direction: 'outflow' });
      assert.match(b.answer || b.gaps?.[0]?.detail || '', /can(?:not|'t) confirm loan payments/i);
      assert.match(b.answer || b.gaps?.[0]?.detail || '', /loan account directly/i);
      assert.ok(!b.ledger || b.ledger.complete === false, 'no certified expense or widened zero');
      assert.doesNotMatch(b.answer || '', /You spent|Money out:|\$0\.00/);
    }
  });
  test(`G1 unresolved loan selector refuses widened spending${scope}`, async t => {
    const f = book(t, { rows: [{ description: 'Ordinary purchase', payee: 'Store Unit', cents: 123 }] });
    const b = await ask(f, `What did my loan account spend last month${scope}?`, 'expense_summary', { account_hint: 'loan account' });
    assert.match(b.answer || b.gaps?.[0]?.detail || '', /can(?:not|'t) confirm loan payments/i);
    assert.ok(!b.ledger || b.ledger.expense_total_minor == null, 'unresolved loan never widens');
  });
  test(`G2 uncertain own debit is excluded and disclosed in spending${scope}`, async t => {
    const f = book(t, { rows: [{ description: 'Transfer to account 9999' }, { description: 'Purchase payment for supplies', payee: 'Store Unit', cents: 123 }] });
    const b = await ask(f, `How much did I spend last month${scope}?`);
    assert.ok(b.ledger, 'populated spending reader reached');
    assert.ok(b.ledger.expense_total_minor === 123 || b.ledger.expense_total_minor == null && b.ledger.complete === false);
    assert.match(b.answer, /possible|unconfirmed|withheld/i);
    assert.match(b.answer, /transfer/i);
    assert.equal(b.ledger.possible_payments[0].amount_minor, 1);
    assert.match(b.answer, /possible transfer to your own .*not counted as spending: \$0\.01/i);
  });
  for (const description of ['TRANSFER TO ACCOUNT 5678', 'TRANSFER TO ACCOUNT 9999']) {
    test(`G3 unary outflow stays in money out${scope}: ${description}`, async t => {
      const f = book(t, { rows: [{ description }] });
      const b = await ask(f, `How much money went out last month${scope}?`, 'totals');
      assert.ok(b.ledger, 'money out reached');
      assert.equal(b.ledger.expense_total_minor, 1, b.answer);
      assert.match(b.answer, /possible|possibly|unproved/i);
      assert.equal(b.ledger.possible_payments[0].included_in_total, true);
    });
  }
  test(`G3 unary credit stays in net and is disclosed${scope}`, async t => {
    const f = book(t, { other: 'loan', rows: [{ description: 'LOAN ADVANCE FROM 5678', direction: 'inflow' }] });
    const b = await ask(f, `What was my net income last month${scope}?`, 'totals', { direction: 'both' });
    assert.ok(b.ledger, 'net reached');
    assert.equal(b.ledger.net_minor ?? b.ledger.covered_net_minor ?? b.ledger.lead_accounts.reduce((sum, a) => sum + a.credits_minor - a.debits_minor, 0), 1, b.answer);
    assert.match(b.answer, /Possible moves from your own accounts, retained in money in and net/);
    assert.equal(b.ledger.possible_owned_credits[0].included_in_total, true);
  });
  test(`G4 possible own credit is excluded from payer income and disclosed${scope}`, async t => {
    const f = book(t, { rows: [{ description: 'Transfer from my unconnected own account', payee: 'unconnected Unit', direction: 'inflow' },
      { description: 'Outside deposit', payee: 'Customer Unit', direction: 'inflow', cents: 123 }] });
    const b = await ask(f, `who paid me last month${scope ? ' for my business accounts' : ''}?`, 'merchant', { direction: 'inflow', ...(scope ? { account_hint: 'business accounts' } : {}) });
    if (scope && !b.ledger) {
      // This compound wording already stops at calendar admission. Its parsed
      // refusal must stay explicit and cannot certify the possible credit.
      assert.equal(b.gaps?.[0]?.reason, 'period_contradiction');
      assert.equal(b.evidence_gate.complete, false);
      assert.doesNotMatch(b.answer || '', /\$[0-9]/);
      return;
    }
    assert.ok(b.ledger, 'payer reader reached: ' + JSON.stringify(b));
    assert.equal(b.ledger.total_minor, 123, b.answer);
    assert.equal(b.ledger.not_payments.count, 1);
    assert.equal(b.ledger.not_payments.total_minor, 1);
    assert.match(b.answer, /possible.*own|possibly.*own|not payments to you/i);
  });
  for (const family of ['balance','out']) test(`G5 linked pending twin leaves ${family} appendix${scope}`, async t => {
    const f = book(t, { rows: [{ description: 'Pending purchase', pending: true }, { description: 'Posted purchase', pendingId: 'external-0' }] });
    if (family === 'balance') f.raw("UPDATE fin_balance_snapshots SET as_of_date='2026-09-15'");
    const b = await ask(f, family === 'balance' ? `Show my balances${scope}` : `How much money went out last month${scope}?`, family === 'balance' ? 'balance' : 'totals', family === 'balance' ? { period: { type: 'none' }, direction: null } : {});
    assert.ok(b.ledger, 'balance or outflow reader reached');
    assert.doesNotMatch(b.answer, /Pending (?:activity:|after .*outflows \$0\.01)/);
    assert.equal(b.ledger.pending_excluded?.count || 0, 0);
    if (family === 'out') assert.equal(b.ledger.expense_total_minor, 1);
  });
  for (const family of ['in','largest','deposits','net']) test(`G6 reciprocal typed loan pair counted once in ${family}${scope}`, async t => {
    const f = book(t, { other: 'loan', rows: [{ description: 'LOAN PAYMENT TO 5678' },
      { account: 'other', description: 'PAYMENT FROM ACCOUNT 1234', direction: 'inflow' }] });
    const specs = { in: ['How much money came in last month', 'totals', 'inflow'], largest: ['What were my largest expenses last month', 'largest', 'outflow'],
      deposits: ['Show my deposits last month', 'deposits', 'inflow'], net: ['What was my net income last month', 'totals', 'both'] };
    const [q, kind, direction] = specs[family];
    const b = await ask(f, q + scope + '?', kind, { direction });
    assert.ok(b.ledger, 'typed movement reader reached');
    if (family === 'in') assert.equal(b.ledger.outside_inflow_minor, 0, b.answer);
    if (family === 'net') assert.equal(b.ledger.net_minor ?? b.ledger.covered_net_minor ?? b.ledger.lead_accounts.reduce((sum, a) => sum + a.credits_minor - a.debits_minor, 0), 0, b.answer);
    const payment = b.ledger.payment_exclusions || b.ledger.own_account_payments;
    if (payment) { assert.equal(payment.total_minor, 1, b.answer); assert.equal(payment.count, 1); }
    assert.doesNotMatch(b.answer, /\$0\.02 across 2 payments/);
    assert.match(b.answer, /payment|transfer/i);
  });
}

test('green controls: loan balance, loan-named purchase account, card question, outside deposit and payment memo', async t => {
  const f = book(t, { other: 'loan', label: 'Loan supplies', rows: [{ description: 'Purchase payment for supplies', payee: 'Store Unit', cents: 123 },
    { description: 'Outside deposit', payee: 'Customer Unit', direction: 'inflow', cents: 456 }] });
  const balance = await ask(f, 'What is my loan balance?', 'balance', { period: { type: 'none' }, direction: null, account_hint: 'loan' });
  assert.ok(balance.ledger?.accounts.length); assert.match(balance.answer, /100\.00/);
  const purchase = await ask(f, 'How much did I spend in Loan supplies last month?', 'expense_summary', { account_hint: 'Loan supplies' });
  assert.equal(purchase.ledger.expense_total_minor, 123);
  const outside = await ask(f, 'Who paid me last month?', 'merchant', { direction: 'inflow' });
  assert.equal(outside.ledger.total_minor, 456);
  const card = await ask(f, 'What did I pay on my card last month?', 'transfers', { direction: null, account_hint: 'card' });
  assert.doesNotMatch(card.answer || card.gaps?.[0]?.detail || '', /cannot confirm loan payments/i);
});

test('green controls: unlinked hold remains pending, unique connected transfer remains excluded', async t => {
  const hold = book(t, { rows: [{ description: 'Hold', pending: true }, { description: 'Purchase', date: '2026-09-16' }] });
  const b = await ask(hold, 'How much money went out last month?', 'totals');
  assert.ok(b.ledger); assert.equal(b.ledger.expense_total_minor, 1);
  assert.match(b.answer, /Pending activity: \$0\.01/);
  const f = book(t, { rows: [{ description: 'TRANSFER TO ACCOUNT 5678' }, { account: 'other', description: 'TRANSFER FROM ACCOUNT 1234', direction: 'inflow' }] });
  const paired = await ask(f, 'How much money went out last month?', 'totals');
  assert.equal(paired.ledger.expense_total_minor, 0); assert.match(paired.answer, /moves between your own accounts/i);
});

test('equal connected counterpart within three days withholds money out', async t => {
  const f = book(t, { rows: [{ description: 'Transfer to my unconnected own account' }, { account: 'other', description: 'Outside deposit', direction: 'inflow', date: '2026-09-18' }] });
  const b = await ask(f, 'How much money went out last month?', 'totals');
  assert.ok(b.ledger, 'nonempty movement decision reached');
  assert.equal(b.ledger.expense_total_minor, null); assert.equal(b.ledger.complete, false);
  assert.equal(b.ledger.reason, 'money_out_destination_unconfirmed');
});

test('G6 recognizer consumes endpoints and pairs only unique reciprocal masks, amounts and dates', async t => {
  const { pairOwnTransfers, isDirectedOwnedTransfer } = await import(process.env.LOAN_GUARD_MODULE ? new URL('./ledger-analysis.js', process.env.LOAN_GUARD_MODULE).href : '../src/lib/ledger-analysis.js');
  const accounts = new Map([['main', { account_slug: 'main', account_kind: 'checking', members: [{ mask: '1234', account_kind: 'checking' }] }],
    ['other', { account_slug: 'other', account_kind: 'loan', members: [{ mask: '5678', account_kind: 'loan' }] }]]);
  const out = { id: 1, effective_account_slug: 'main', direction: 'outflow', amount_minor: 1, currency: 'USD', posted_on: '2026-09-15', description: 'LOAN PAYMENT TO 5678' };
  const incoming = { ...out, id: 2, effective_account_slug: 'other', direction: 'inflow', description: 'PAYMENT FROM ACCOUNT 1234' };
  const proved = rows => pairOwnTransfers(rows, accounts, { directedEvidence: true }).pairs.filter(pair => isDirectedOwnedTransfer(pair, accounts));
  assert.equal(proved([out, incoming]).length, 1, 'populated reciprocal green control reaches proof');
  for (const peer of [{ ...incoming, description: 'PAYMENT FROM ACCOUNT 1234 extra' }, { ...incoming, description: 'PAYMENT FROM ACCOUNT 9999' },
    { ...incoming, amount_minor: 2 }, { ...incoming, posted_on: '2026-09-19' }]) assert.equal(proved([out, peer]).length, 0);
  assert.equal(proved([out, incoming, { ...incoming, id: 3 }]).length, 0, 'competing counterpart never proves a pair');
  const f = book(t, { other: 'loan', rows: [{ description: out.description }, { account: 'other', description: incoming.description, direction: 'inflow', date: '2026-09-18' }] });
  const b = await ask(f, 'Show my deposits last month?', 'deposits', { direction: 'inflow' });
  assert.ok(b.ledger); assert.equal(b.ledger.payment_exclusions.total_minor, 1, b.answer);
  assert.equal(b.ledger.payment_exclusions.count, 1, 'three-day reciprocal payment disclosed once');
});

test('G5 linkage is confined to the same account', async t => {
  const f = book(t, { rows: [{ description: 'Hold', pending: true }, { account: 'other', description: 'Different account purchase', pendingId: 'external-0' }] });
  const b = await ask(f, 'How much money went out last month?', 'totals');
  assert.ok(b.ledger); assert.ok(b.ledger.pending_excluded, 'pending reader retained the unlinked observation');
  assert.equal(b.ledger.pending_excluded.count, 1);
  assert.match(b.answer, /Pending activity: \$0\.01/);
});

test('G4 named income never certifies a possible own-account credit', async t => {
  const f = book(t, { rows: [{ description: 'Transfer from my unconnected own account', payee: 'Other Unit', direction: 'inflow' }] });
  const b = await ask(f, 'How much income from Other Unit last month?', 'merchant', { direction: 'inflow', vendor_text: 'Other Unit' });
  assert.ok(b.ledger, 'named income decision reached');
  assert.equal(b.ledger.attributed_subtotal_minor ?? b.ledger.total_minor ?? 0, 0, b.answer);
  assert.match(b.answer, /possible.*own|possibly.*own|not counted as payments/i);
});

test('G5 linkage is confined to the same tenant', async t => {
  const f = book(t, { rows: [{ description: 'Hold', pending: true }, { description: 'Other tenant purchase', pendingId: 'external-0' }] });
  f.raw("UPDATE fin_transactions SET tenant_id='tenant-other' WHERE txn_uid='row-1'");
  const b = await ask(f, 'How much money went out last month?', 'totals');
  assert.ok(b.ledger); assert.ok(b.ledger.pending_excluded, 'pending reader retained the unlinked observation');
  assert.equal(b.ledger.pending_excluded.count, 1);
  assert.match(b.answer, /Pending activity: \$0\.01/);
});

test('G3 unary receiving payment stays in net until its counterpart is proved', async t => {
  const f = book(t, { other: 'card', rows: [{ account: 'other', description: 'PAYMENT FROM ACCOUNT 1234', direction: 'inflow' }] });
  const b = await ask(f, 'What was my net income last month?', 'totals', { direction: 'both' });
  assert.ok(b.ledger); assert.equal(b.ledger.net_minor, 1, b.answer);
  assert.equal(b.ledger.possible_owned_credits[0].included_in_total, true);
});

for (const family of ['out', 'net', 'payer']) test(`G3 one unpaired bilateral memo stays possible: ${family}`, async t => {
  const incoming = family !== 'out';
  const f = book(t, { rows: [{ account: incoming ? 'other' : 'main', description: 'TRANSFER FROM ACCOUNT 1234 TO ACCOUNT 5678',
    direction: incoming ? 'inflow' : 'outflow' }] });
  const b = await ask(f, family === 'out' ? 'How much money went out last month?' : family === 'net' ? 'What was my net income last month?' : 'Who paid me last month?',
    family === 'payer' ? 'merchant' : 'totals', { direction: family === 'payer' ? 'inflow' : 'both' });
  assert.ok(b.ledger, 'unpaired memo decision reached');
  if (family === 'out') assert.equal(b.ledger.expense_total_minor, 1, b.answer);
  if (family === 'net') assert.equal(b.ledger.net_minor, 1, b.answer);
  if (family === 'payer') { assert.equal(b.ledger.total_minor, 0, b.answer); assert.equal(b.ledger.not_payments.count, 1); }
  assert.match(b.answer, /possible|possibly|unproved/i);
});

test('green identity literal with loan-payment words remains ordinary vendor spending', async t => {
  for (const question of [undefined, null]) assert.equal(loanPaymentSubject(question, { match: 'Store Unit' }), false, 'parsed-only seam keeps its existing input contract');
  const f = book(t, { rows: [{ description: 'Supplies purchase', payee: 'Loan Payment Supplies', cents: 123 }] });
  const b = await ask(f, 'How much did I spend at Loan Payment Supplies last month?', 'merchant', { direction: 'outflow', vendor_text: 'Loan Payment Supplies' });
  assert.ok(b.ledger, 'literal vendor decision reached');
  assert.equal(b.ledger.total_minor, 123, b.answer);
  const outside = book(t, { rows: [{ description: 'payment to account 5678', payee: 'Store Unit', cents: 123 },
    { account: 'other', description: 'payment from account 1234', payee: 'Store Unit', direction: 'inflow', cents: 123 }] });
  const out = await ask(outside, 'How much money went out last month?', 'expense_summary');
  assert.equal(out.ledger.expense_total_minor, 123, 'an independently named outside payee remains an ordinary purchase');
  assert.equal(out.ledger.reason, undefined);
  const external = book(t, { rows: [{ description: 'Transfer to outside supplier invoice', payee: 'Outside Supplier', cents: 123 },
    { account: 'other', description: 'Transfer from outside customer invoice', payee: 'Outside Customer', direction: 'inflow', cents: 123 }] });
  const genuine = await ask(external, 'How much money went out last month?', 'expense_summary');
  assert.equal(genuine.ledger.expense_total_minor, 123, 'equal amounts cannot turn independent outside parties into an own movement');
  assert.equal(genuine.ledger.complete, true);
});

test('G1 an unresolved compound request retains its existing scope boundary', async t => {
  const f = book(t, { other: 'loan', rows: [{ description: 'Supplies purchase', payee: 'Store Unit', cents: 123 }] });
  const b = await ask(f, 'How much did I spend last month, and how much did I pay on my loan last month?', [
    recordedIntent('expense_summary', { direction: 'outflow', period: { type: 'last_month' } }),
    recordedIntent('totals', { direction: 'outflow', account_hint: 'loan', period: { type: 'last_month' } }),
  ]);
  assert.equal(b.ledger?.kind, 'scope_refused', 'the account-scope decision is reached');
  assert.ok(f.calls.some(sql => /JOIN fin_entities e/.test(sql)), 'nonempty inventory inspected');
  assert.equal(b.ledger.complete, false);
  assert.ok(b.gaps.some(gap => gap.reason === 'scope_unresolved'), JSON.stringify(b.gaps));
  assert.doesNotMatch(b.answer || '', /\$[0-9]/);
  const green = await ask(f, 'How much did I spend last month?');
  assert.equal(green.ledger.expense_total_minor, 123, 'ordinary spending control unchanged');
});

test('G4 category income shares the possible-own-credit exclusion and disclosure', async t => {
  const f = book(t, { rows: [{ description: 'Transfer from my unconnected own account', direction: 'inflow', payee: 'Other Unit' },
    { description: 'Outside deposit', direction: 'inflow', payee: 'Customer Unit', cents: 123 }] });
  f.raw("UPDATE fin_transactions SET category='income',category_basis_state='confirmed'");
  const b = await ask(f, 'How much income by category last month?', 'category', { direction: 'inflow' });
  assert.ok(b.ledger); assert.equal(b.ledger.total_minor, 123, b.answer);
  assert.equal(b.ledger.not_payments.count, 1); assert.equal(b.ledger.not_payments.total_minor, 1);
  assert.match(b.answer, /Not counted as payments to you/);
  f.raw("UPDATE fin_transactions SET category=NULL,category_basis_state=NULL");
  const unsorted = await ask(f, 'How much income by category last month?', 'category', { direction: 'inflow' });
  assert.ok(unsorted.ledger, 'unconfirmed category decision reached');
  assert.equal(unsorted.ledger.unsorted_minor, 123, unsorted.answer);
  assert.equal(unsorted.ledger.not_payments.total_minor, 1);
  f.raw("UPDATE fin_transactions SET category='income',category_basis_state='confirmed' WHERE txn_uid='row-1'");
  const named = await ask(f, 'How much income for category income last month?', 'category', { direction: 'inflow', vendor_text: 'income' });
  assert.equal(named.ledger.total_minor, null, 'narrow category keeps its established uncertainty boundary');
  assert.equal(named.ledger.category_total_unconfirmed, true);
  assert.equal(named.evidence_gate.complete, false);
  assert.equal(named.ledger.confirmed_category_subtotal_minor, 123);
  assert.equal(named.ledger.unsorted_minor, 1, 'uncategorized transaction context stays distinct from certified income');
  assert.ok(named.citations.some(row => row.amount_minor === 1), 'withheld category decision retains the raw credit citation');
});

test('G6 an unresolved endpoint tail cannot promote an own-looking credit into income', async t => {
  const f = book(t, { other: 'loan', rows: [{ description: 'LOAN ADVANCE FROM 5678 extra', direction: 'inflow' }] });
  const b = await ask(f, 'Who paid me last month?', 'merchant', { direction: 'inflow' });
  assert.ok(b.ledger, 'the unresolved endpoint reaches the payer reader');
  assert.equal(b.ledger.total_minor, 0, b.answer);
  assert.equal(b.ledger.not_payments.count, 1);
  assert.match(b.answer, /a possible move from your own account/);
});

// The prior connected-card review boundary remains authoritative when a
// confirmed expense category conflicts with a generic payment endpoint.
test('green accepted card expense conflict retains its ownership review hold', async t => {
  const f = book(t, { other: 'card', rows: [{ description: 'Service fee', payee: 'Store Unit', cents: 123 }] });
  f.raw("UPDATE fin_transactions SET category='BANK_FEES',category_basis_state='confirmed'");
  assert.equal((await ask(f, 'What did I spend last month?')).ledger.expense_total_minor, 123, 'confirmed fee green control');
  f.raw("UPDATE fin_transactions SET description='payment to account 5678',payee='card payment'");
  const held = await ask(f, 'What did I spend last month?');
  assert.equal(held.ledger.reason, 'owned_movement_unconfirmed');
  assert.equal(held.ledger.expense_total_minor, null);
  assert.equal(held.ledger.complete, false);
});

test('green reciprocal withdrawal proof preserves default and explicit inclusion', async t => {
  for (const kind of ['investment', 'retirement']) {
    const f = book(t, { other: kind, rows: [
      { account: 'other', description: 'Transfer to account 1234', cents: 345 },
      { account: 'main', direction: 'inflow', description: 'Transfer from account 5678', cents: 345 },
    ] });
    const b = await ask(f, 'What was my net income last month?', 'totals', { direction: 'both' });
    assert.equal(b.evidence_gate.complete, true, kind);
    assert.equal(b.ledger.net_minor, 0, kind);
    assert.equal(b.ledger.default_exclusions.withdrawal_minor, 345, kind);
    const included = await ask(f, 'What was my net income last month including withdrawals?', 'totals', { direction: 'both' });
    assert.equal(included.evidence_gate.complete, true, kind);
    assert.equal(included.ledger.net_minor, 345, kind);
    f.raw("UPDATE fin_accounts SET account_kind='other' WHERE account_slug='other'");
    const untyped = await ask(f, 'What was my net income last month?', 'totals', { direction: 'both' });
    assert.equal(untyped.evidence_gate.complete, false, 'an unknown kind cannot license the new asset-pair exclusion');
    assert.equal(untyped.ledger.total_minor, null);
    assert.equal(untyped.ledger.reason, 'money_out_destination_unconfirmed');
    assert.ok(untyped.ledger.possible_payments.some(row => row.amount_minor === 345), 'unconfirmed kind reaches a populated movement decision');
  }
  // The reader's normalized conflict flag is authoritative; a provider's raw
  // balance_role alone does not replace an owner-confirmed account kind.
  const accounts = new Map([['main', { account_slug:'main',account_kind:'checking',members:[{mask:'1234',account_kind:'checking'}] }],
    ['reserve', { account_slug:'reserve',account_kind:'investment',members:[{mask:'5678',account_kind:'investment'}] }]]);
  const rows = [{ id:1,effective_account_slug:'reserve',direction:'outflow',amount_minor:345,currency:'USD',posted_on:'2026-09-15',description:'Transfer to account 1234' },
    { id:2,effective_account_slug:'main',direction:'inflow',amount_minor:345,currency:'USD',posted_on:'2026-09-15',description:'Transfer from account 5678' }];
  const pairs=pairOwnTransfers(rows,accounts,{directedEvidence:true}).pairs;
  assert.equal(pairs.length,1,'unique reciprocal decision reached');
  assert.equal(ordinaryMoneyMembership(rows,pairs,accounts).excluded.size,2,'confirmed kind green control');
  accounts.get('reserve').account_kind_balance_conflict=true;
  assert.equal(pairOwnTransfers(rows,accounts,{directedEvidence:true}).pairs.length,1,'same populated candidate reaches the role decision');
  const conflicted=ordinaryMoneyMembership(rows,pairs,accounts);
  assert.equal(conflicted.excluded.size,0,'a conflicting kind and balance role cannot license an asset exclusion');
  assert.equal(conflicted.possible.size,2);
  accounts.get('reserve').account_kind_balance_conflict=false;
  accounts.get('main').account_kind_balance_conflict=true;
  assert.equal(pairOwnTransfers(rows,accounts,{directedEvidence:true}).pairs.length,1);
  assert.equal(ordinaryMoneyMembership(rows,pairs,accounts).excluded.size,0,'receiving role conflict also prevents the broader exclusion');
  accounts.get('main').account_kind_balance_conflict=false;
  accounts.get('main').account_kind='other'; accounts.get('main').members[0].account_kind='other';
  assert.equal(pairOwnTransfers(rows,accounts,{directedEvidence:true}).pairs.length,1);
  assert.equal(ordinaryMoneyMembership(rows,pairs,accounts).excluded.size,0,'receiving kind also needs confirmation');
});

test('green reciprocal liability proof survives receiving payment partition', async t => {
  const f = book(t, { other: 'card', rows: [
    { description: 'Transfer to credit card', cents: 345 },
    { account: 'other', direction: 'inflow', description: 'Transfer from account 1234', cents: 345 },
  ] });
  f.raw("UPDATE fin_accounts SET label='credit card' WHERE account_slug='other'");
  f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed' WHERE txn_uid='row-0'");
  const b = await ask(f, 'How much did I spend on software last month?', 'category', { vendor_text: 'software' });
  assert.equal(b.evidence_gate.complete, true);
  assert.equal(b.ledger.total_minor, 0, 'proved reciprocal payment cannot become category spending');
  assert.equal(b.ledger.payment_exclusions.total_minor, 345);
  assert.equal(b.ledger.payment_exclusions.count, 1);
  assert.ok(b.citations.some(row => row.amount_minor === 345), 'reciprocal payment decision remains cited');
  f.raw("UPDATE fin_transactions SET description='Ordinary purchase',payee='Store Unit' WHERE txn_uid='row-0'");
  const outside = await ask(f, 'How much did I spend on software last month?', 'category', { vendor_text: 'software' });
  assert.equal(outside.evidence_gate.complete, true, 'same category keeps an ordinary purchase');
  assert.equal(outside.ledger.total_minor, 345);
});
