import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { bookFor as storeBook, oracle as storeOracle } from './store-owner-shapes.measure.mjs';

// Synthetic books only. Every oracle sums authored economic tags and never
// calls a product classifier:
//   spend  - a purchase (money out and 0.4.27 spending)
//   moved  - one leg of a movement between two CONNECTED owned accounts
//   repay  - a repayment to a card or lender that is not connected
//   xfer   - a transfer to an account that is not connected (0.4.27 keeps it
//            in spending, so the spending control keeps it too)
// Money out = every completed outflow except moved legs. 0.4.27 spending =
// spend + xfer. Nothing in this file changes what spending means.
const at = Date.parse(NOW);
const WENT_OUT = ['How much money went out last month?', 'What went out last month?', 'How much went out in September 2026?'];
const SPENT = ['How much did I spend last month?', 'What did I spend last month?', 'What were my expenses last month?',
  'What was my spending last month?'];
const sum = rows => rows.reduce((n, row) => n + Math.abs(row.cents), 0);

function book(t, accounts, rows, { entities = ['owner'], partial = [] } = {}) {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const entity of entities) f.owner(entity);
  for (const [slug, kind, role, mask, entity = entities[0]] of accounts) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,'manual','owner_stated','confirmed','2026-10-12')`, slug, entity, kind, role, mask, `Synthetic ${slug}`);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,?,'2026-06-01','2026-10-12','2026-10-12','owner_stated','confirmed','2026-10-12')`, slug, partial.includes(slug) ? 'partial' : 'complete');
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',100000,'owner_stated','confirmed','2026-10-12')`, slug);
  }
  const authored = rows.map(([account, date, cents, description, payee, tag, category = null], index) => {
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,category,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,0,'owner_stated','confirmed','2026-10-12')`, `row-${index + 1}`, account, date,
    Math.abs(cents), cents < 0 ? 'outflow' : 'inflow', description, payee, category);
    return { account, date, cents, tag };
  });
  const september = authored.filter(row => row.date.startsWith('2026-09') && row.cents < 0 && !partial.includes(row.account));
  return { f, moneyOut: sum(september.filter(row => row.tag !== 'moved')),
    spending: sum(september.filter(row => ['spend', 'xfer'].includes(row.tag))) };
}
async function recorded(f, question, intents) {
  let calls = 0;
  f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  try {
    const body = await (await withLedgerAnswer({ env: f.env, question, now: at, grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => { calls++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
        intents: intents.map(intent => ({ direction: null, count: null, vendor_text: null, account_hint: null, amount_text: null,
          date_text: null, ...intent })) }) }] }; } }, () => assert.fail('ledger decision required'))).json();
    assert.equal(calls, 1, 'recorded interpretation reached');
    assert.ok(body.ledger, question);
    return body;
  } finally { delete f.env.ANTHROPIC_API_KEY; }
}
const lead = answer => answer.split('\n').find(line => /\$\d/.test(line));
function assertMoneyOut(b, expected, question) {
  const l = b.ledger;
  assert.equal(l.kind, 'expense_summary', question);
  assert.equal(l.expense_total_minor, expected, `${question}\n${b.answer}`);
  assert.equal(l.outflow_measure, 'money_out', question);
  assert.match(lead(b.answer), /^Money out(?: I could check)?: \$[\d,]+\.\d{2} /, question);
  assert.doesNotMatch(b.answer, /You spent|Spending I could check/, question);
}
function assertSpending(b, expected, question) {
  const l = b.ledger;
  assert.equal(l.kind, 'expense_summary', question);
  assert.equal(l.expense_total_minor, expected, `${question}\n${b.answer}`);
  assert.equal(l.outflow_measure, undefined, question);
  assert.match(lead(b.answer), /^(?:You spent|Spending I could check:) \$/, question);
  assert.ok(!b.answer.includes('included above'), question);
  assert.ok(!b.answer.includes('money out withheld'), question);
}
function assertWithheld(b, question) {
  const l = b.ledger;
  assert.equal(l.expense_total_minor, null, `${question}\n${b.answer}`);
  assert.equal(l.total_minor, null, question);
  assert.equal(l.complete, false, question);
  assert.equal(l.reason, 'money_out_destination_unconfirmed', question);
  assert.match(b.answer, /^Money out is withheld because a possible payment or transfer could have gone to one of your own connected accounts/m);
  assert.doesNotMatch(b.answer, /You spent|Money out: \$|included above/, question);
}

test('only the closed "went out" alternative of the expense grammar sets the money-out measure', () => {
  for (const question of WENT_OUT) {
    const intent = classifyLedgerQuestion(question, { now: at, timeZone: 'UTC' });
    assert.equal(intent.kind, 'expense_summary', question);
    assert.equal(intent.outflowMeasure, true, question);
  }
  for (const question of [...SPENT, 'How much have I spent this month?', 'What did I spend last month, and on what?']) {
    const intent = classifyLedgerQuestion(question, { now: at, timeZone: 'UTC' });
    assert.equal(intent.kind, 'expense_summary', `${question}: green expense control`);
    assert.equal(intent.outflowMeasure, undefined, question);
  }
});

// The store owner's own book: the $120 "Loan payment to outside lender" left
// the connected accounts (no loan account is connected). The $800 and $230
// card payments and the $500 transfer are named own movements and stay out.
async function storeAsk(t, seed, partial, question) {
  const shaped = storeBook(seed);
  const accounts = shaped.accounts.map(a => [a.slug, a.kind, a.kind === 'card' ? 'liability' : 'asset', a.mask, a.entity]);
  const rows = shaped.rows.filter(r => !r.pending).map(r => [shaped.accounts[r.account].slug, r.date, r.cents, r.description || r.payee, r.payee, r.move ? 'moved' : 'any']);
  const { f } = book(t, accounts, rows, { entities: ['store', 'personal'], partial: partial ? ['account-8'] : [] });
  const key = storeOracle(partial ? { ...shaped, rows: shaped.rows.filter(r => r.account !== 8) } : shaped);
  return { b: await f.ask(question), key };
}
test('store Q4: went out counts the outside loan payment and discloses it; spending still excludes it', async t => {
  for (const seed of [427, 10427, 20427]) for (const partial of [false, true]) {
    const { b, key } = await storeAsk(t, seed, partial, 'How much money went out last month?');
    assertMoneyOut(b, key.outgoing, `seed ${seed} partial ${partial}`);
    if (seed === 427 && !partial) assert.match(b.answer, /^Money out: \$5,316\.04 last month, not counting moves between your own accounts\.$/m);
    if (partial) assert.match(lead(b.answer), /^Money out I could check: .* \(some accounts missing dates\)/);
    const [candidate] = b.ledger.possible_payments;
    assert.equal(b.ledger.possible_payments.length, 1);
    assert.deepEqual([candidate.payment_kind, candidate.amount_minor, candidate.posted_on, candidate.included_in_total],
      ['loan', 12000, '2026-09-23', true]);
    assert.ok(b.answer.includes(`included above, possibly a loan payment (counterpart not proved): $120.00 on September 23, bank text quoted: "Loan payment to outside lender" [${candidate.n}].`));
    assert.equal(b.citations.filter(c => c.n === candidate.n && c.amount_minor === 12000).length, 1, 'one cited operand');
    assert.equal(b.ledger.own_account_payments.total_minor, 103000, 'named card payments stay out');
    assert.equal(b.ledger.excluded_own_transfer_minor, 50000, 'named own transfer stays out');
    const spent = (await storeAsk(t, seed, partial, 'What did I spend last month?')).b;
    assertSpending(spent, key.outgoing - 12000, `spending control seed ${seed}`);
    assert.ok(spent.answer.includes('possible loan payment, not counted as spending: $120.00 on September 23'));
  }
});

const CHECKING_CARD = [['checking', 'checking', 'asset', '4100'], ['card', 'card', 'liability', '4102']];
const PURCHASES = [['checking', '2026-09-03', -4520, 'Store purchase', 'Store Unit', 'spend'],
  ['card', '2026-09-07', -23000, 'Supply purchase', 'Supply Unit', 'spend'],
  ['card', '2026-09-11', -1999, 'Tool purchase', 'Tool Unit', 'spend'],
  ['checking', '2026-09-16', 123456, 'Payer deposit', 'Payer Unit', 'income']];

test('connected card: the proven payment is an own movement, so card purchases are counted once', async t => {
  const { f, moneyOut, spending } = book(t, CHECKING_CARD, [...PURCHASES,
    ['checking', '2026-09-20', -23000, 'payment to account 4102', 'Card payment', 'moved'],
    ['card', '2026-09-20', 23000, 'payment from account 4100', 'Card payment', 'moved']]);
  assert.equal(moneyOut, 4520 + 23000 + 1999);
  for (const question of WENT_OUT) {
    const b = await f.ask(question);
    assertMoneyOut(b, moneyOut, question);
    assert.equal(b.ledger.own_account_payments.card_minor, 23000, 'payment disclosed as excluded');
    assert.equal(b.ledger.possible_payments, undefined);
  }
  for (const question of SPENT) assertSpending(await f.ask(question), spending, question);
});

test('connected card: an unproven card payment is withheld from money out, never double counted', async t => {
  for (const [text, payee, receipt, category = null] of [['CARD AUTOPAY', null, 'PAYMENT THANK YOU'], ['ONLINE CARD PAYMENT', 'Card payment', 'PAYMENT THANK YOU'],
    ['CARDPAY 0042', null, 'Payment received'], ['AUTOPAY', null, 'PAYMENT THANK YOU', 'Credit Card Payment']]) {
    const { f, spending } = book(t, CHECKING_CARD, [...PURCHASES,
      ['checking', '2026-09-20', -23000, text, payee, 'moved', category], ['card', '2026-09-20', 23000, receipt, null, 'moved']]);
    for (const question of WENT_OUT) {
      const b = await f.ask(question);
      assertWithheld(b, `${text}: ${question}`);
      assert.ok(b.answer.includes('not counted, money out withheld: possibly a card payment') &&
        b.answer.includes('to a connected account (your account ending 4102): $230.00 on September 20'), b.answer);
      const record = b.ledger.possible_payments.find(row => row.amount_minor === 23000);
      assert.equal(record.destination_unconfirmed, true);
      assert.deepEqual(record.connected_counterpart_masks, ['4102']);
      assert.equal(record.included_in_total, undefined);
    }
    // 0.4.27 spending is unchanged: the payment stays out of spending.
    for (const question of SPENT) assertSpending(await f.ask(question), spending, `${text}: ${question}`);
  }
});

test('unconnected card: the payment left the connected accounts, so it counts in money out and is disclosed', async t => {
  const accounts = [['checking', 'checking', 'asset', '4100'], ['savings', 'savings', 'asset', '4101']];
  for (const [text, category, basis] of [['CARD AUTOPAY', null, 'description'], ['AUTOPAY', 'Credit Card Payment', 'bank_code']]) {
    const { f, moneyOut, spending } = book(t, accounts, [['checking', '2026-09-03', -4520, 'Store purchase', 'Store Unit', 'spend'],
      ['checking', '2026-09-20', -23000, text, null, 'repay', category], ['checking', '2026-09-16', 123456, 'Payer deposit', 'Payer Unit', 'income']]);
    assert.equal(moneyOut, 27520);
    for (const question of WENT_OUT) {
      const b = await f.ask(question);
      assertMoneyOut(b, moneyOut, `${text}: ${question}`);
      const [record] = b.ledger.possible_payments;
      assert.deepEqual([record.payment_kind, record.amount_minor, record.included_in_total, record.basis], ['card', 23000, true, basis]);
      assert.ok(b.answer.includes(`included above, possibly a card payment${basis === 'bank_code' ? ' (bank payment code)' : ''} (counterpart not proved): $230.00 on September 20, bank text quoted: "${text}" [${record.n}].`), b.answer);
      assert.ok(b.citations.some(c => c.n === record.n && c.amount_minor === 23000));
    }
    for (const question of SPENT) assertSpending(await f.ask(question), 4520, `${text}: ${question}`);
    assert.equal(spending, 4520);
  }
});

test('a possible own-account transfer to an unconnected savings account counts in money out and is disclosed', async t => {
  const { f, moneyOut, spending } = book(t, CHECKING_CARD, [...PURCHASES,
    ['checking', '2026-09-14', -50000, 'Online transfer to savings ending 9999', 'Transfer', 'xfer']]);
  assert.equal(moneyOut, 4520 + 23000 + 1999 + 50000);
  for (const question of WENT_OUT) {
    const b = await f.ask(question);
    assertMoneyOut(b, moneyOut, question);
    // The shared own-movement nominator reads this text as a possible
    // transfer to the owner's own savings account: money out keeps it and
    // names its destination role.
    const [record] = b.ledger.possible_payments;
    assert.deepEqual([record.payment_kind, record.destination, record.amount_minor, record.included_in_total], ['own_account', 'savings account', 50000, true]);
    assert.ok(b.answer.includes(`included above, possibly a transfer to your own savings account (counterpart not proved): $500.00 on September 14, bank text quoted: "Online transfer to savings ending 9999" [${record.n}].`), b.answer);
  }
  // Spending excludes the possible own movement (own-movement guard); the
  // 0.4.27 oracle tag kept it, so the spending figure is the purchases alone.
  for (const question of SPENT) assertSpending(await f.ask(question), spending - 50000, question);
  assert.equal(spending, moneyOut);
});

test('a transfer whose equal amount lands in a connected account within three days is withheld from money out', async t => {
  const accounts = [...CHECKING_CARD, ['savings', 'savings', 'asset', '4101']];
  const { f, spending } = book(t, accounts, [...PURCHASES,
    ['checking', '2026-09-14', -50000, 'Online transfer to savings', 'Transfer', 'moved'],
    ['savings', '2026-09-15', 50000, 'Online transfer', 'Transfer', 'moved']]);
  for (const question of WENT_OUT) {
    const b = await f.ask(question);
    assertWithheld(b, question);
    // The text names the owner's savings account: a possible own movement,
    // judged exactly like a transfer's other leg.
    const [record] = b.ledger.possible_payments;
    assert.deepEqual([record.payment_kind, record.destination], ['own_account', 'savings account']);
    assert.equal(record.destination_unconfirmed, true);
    assert.deepEqual(record.connected_counterpart_masks, ['4101']);
  }
  // Spending excludes the possible own movement (own-movement guard).
  for (const question of SPENT) assertSpending(await f.ask(question), spending, question);
});

test('connected loan: an unproven loan payment is withheld; an outside lender with no loan connected counts', async t => {
  const owned = [...CHECKING_CARD, ['mortgage', 'loan', 'liability', '4109']];
  const withheld = book(t, owned, [...PURCHASES, ['checking', '2026-09-23', -150000, 'Mortgage payment', 'Home Lender', 'moved'],
    ['mortgage', '2026-09-23', 150000, 'Payment received', null, 'moved']]);
  assertWithheld(await withheld.f.ask(WENT_OUT[0]), 'owned mortgage');
  assertSpending(await withheld.f.ask(SPENT[0]), withheld.spending, 'owned mortgage spending control');
  for (const category of [null, 'Loan Payments']) {
    const outside = book(t, CHECKING_CARD, [...PURCHASES, ['checking', '2026-09-23', -12000, 'Loan payment to outside lender', 'Outside Lender', 'repay', category]]);
    const b = await outside.f.ask(WENT_OUT[0]);
    assertMoneyOut(b, outside.moneyOut, `outside lender ${category}`);
    assert.equal(outside.moneyOut, 4520 + 23000 + 1999 + 12000);
    assert.equal(b.ledger.possible_payments[0].included_in_total, true);
    assertSpending(await outside.f.ask(SPENT[0]), outside.spending, `outside lender spending ${category}`);
  }
});

test('adversarial card shapes: split, other month, two cards, card refund', async t => {
  // Split payment to the connected card, each part naming it.
  const split = book(t, CHECKING_CARD, [...PURCHASES,
    ['checking', '2026-09-20', -10000, 'payment to account 4102', 'Card payment', 'moved'],
    ['checking', '2026-09-22', -13000, 'payment to account 4102', 'Card payment', 'moved'],
    ['card', '2026-09-22', 23000, 'payment from account 4100', 'Card payment', 'moved']]);
  const splitAnswer = await split.f.ask(WENT_OUT[0]);
  // The receipt is not an equal reciprocal leg for either debit. Keep both
  // possible postings and disclose them instead of inferring a split match.
  assertMoneyOut(splitAnswer, split.moneyOut + 23000, 'unproved split payment');
  assert.deepEqual(splitAnswer.ledger.possible_payments.map(row => row.amount_minor).sort((a, b) => a - b), [10000, 13000]);
  assert.ok(splitAnswer.ledger.possible_payments.every(row => row.included_in_total));
  assert.equal(split.moneyOut, 29519);
  // A split where one part is unproven is withheld, never partly counted.
  const halfSplit = book(t, CHECKING_CARD, [...PURCHASES,
    ['checking', '2026-09-20', -10000, 'payment to account 4102', 'Card payment', 'moved'],
    ['checking', '2026-09-22', -13000, 'CARD AUTOPAY', null, 'moved']]);
  assertWithheld(await halfSplit.f.ask(WENT_OUT[0]), 'half-proven split');
  // The September purchases are paid in October: each month counts its own purchases once.
  const later = book(t, CHECKING_CARD, [...PURCHASES,
    ['checking', '2026-10-02', -24999, 'payment to account 4102', 'Card payment', 'moved'],
    ['card', '2026-10-02', 24999, 'payment from account 4100', 'Card payment', 'moved'],
    ['checking', '2026-08-30', -777, 'Store purchase', 'Store Unit', 'spend']]);
  assertMoneyOut(await later.f.ask(WENT_OUT[0]), 4520 + 23000 + 1999, 'payment in a later month');
  const october = await later.f.ask('How much money went out this month?');
  assertMoneyOut(october, 0, 'the October payment is an own movement');
  // Two cards, one connected: a payment that could be either is withheld,
  // even when its text names a card that is not connected.
  for (const text of ['CARD AUTOPAY', 'payment to card 9999']) {
    const two = book(t, CHECKING_CARD, [...PURCHASES, ['checking', '2026-09-25', -5000, text, null, 'repay']]);
    assertWithheld(await two.f.ask(WENT_OUT[0]), `two cards: ${text}`);
    assertSpending(await two.f.ask(SPENT[0]), two.spending, `two cards spending: ${text}`);
  }
  // A refund credited to the card is money in, never subtracted from money out.
  const refund = book(t, CHECKING_CARD, [...PURCHASES, ['card', '2026-09-18', 2300, 'Refund Supply Unit', 'Supply Unit', 'income']]);
  assertMoneyOut(await refund.f.ask(WENT_OUT[0]), refund.moneyOut, 'card refund');
  assert.equal(refund.moneyOut, 29519);
});

const BUSINESS = [['biz', 'checking', 'asset', '4100', 'business'], ['bizcard', 'card', 'liability', '4102', 'business'],
  ['pers', 'checking', 'asset', '4104', 'personal']];
const BUSINESS_ROWS = [['biz', '2026-09-03', -4520, 'Store purchase', 'Store Unit', 'spend'],
  ['bizcard', '2026-09-07', -1999, 'Supply purchase', 'Supply Unit', 'spend'],
  ['pers', '2026-09-08', -3000, 'Grocery purchase', 'Grocer', 'spend'],
  ['biz', '2026-09-23', -12000, 'Loan payment to outside lender', 'Outside Lender', 'repay'],
  ['biz', '2026-08-03', -1000, 'Store purchase', 'Store Unit', 'spend'],
  ['biz', '2026-08-23', -12000, 'Loan payment to outside lender', 'Outside Lender', 'repay'],
  ['biz', '2026-09-16', 123456, 'Payer deposit', 'Payer Unit', 'income']];
const month = m => ({ type: 'between', from: `2026-${m}-01`, to: `2026-${m}-${m === '08' ? '31' : '30'}` });

test('model-read money out keeps the measure: business scope, month comparison and monthly breakdown', async t => {
  const { f } = book(t, BUSINESS, BUSINESS_ROWS, { entities: ['business', 'personal'] });
  f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='personal'");
  for (const [question, hint] of [['What went out of the business account last month?', 'business account'],
    ['How much money went out of my business accounts last month?', 'business accounts']]) {
    const b = await recorded(f, question, [{ kind: 'totals', direction: 'outflow', account_hint: hint, period: { type: 'last_month' } }]);
    assertMoneyOut(b, 4520 + 1999 + 12000, question);
    assert.equal(b.ledger.possible_payments[0].included_in_total, true);
  }
  const role = await recorded(f, 'What was my business money out last month?', [{ kind: 'expense_summary', direction: 'outflow', account_hint: 'business', period: { type: 'last_month' } }]);
  assertMoneyOut(role, 4520 + 1999 + 12000, 'role-scoped money out');
  const spendRole = await recorded(f, 'What was my business spending last month?', [{ kind: 'expense_summary', direction: 'outflow', account_hint: 'business', period: { type: 'last_month' } }]);
  assertSpending(spendRole, 4520 + 1999, 'role-scoped spending control');
  const compare = await recorded(f, 'Compare money out in September and August',
    ['09', '08'].map(m => ({ kind: 'expense_summary', direction: 'outflow', period: month(m) })));
  assert.deepEqual(compare.ledger.comparison, { figures_minor: [4520 + 1999 + 3000 + 12000, 1000 + 12000], difference_minor: 9519 + 12000 - 13000 });
  assert.ok(compare.ledger.parts.every(part => part.outflow_measure === 'money_out'));
  assert.doesNotMatch(compare.answer, /You spent/);
  const compareSpend = await recorded(f, 'Compare spending in September and August',
    ['09', '08'].map(m => ({ kind: 'expense_summary', direction: 'outflow', period: month(m) })));
  assert.deepEqual(compareSpend.ledger.comparison, { figures_minor: [9519, 1000], difference_minor: 8519 });
  const monthly = await recorded(f, 'Could you retrieve money out month by month since August?',
    [{ kind: 'expense_summary', direction: 'outflow', period: { type: 'since', date: '2026-08-01' } }]);
  assert.deepEqual(monthly.ledger.months.slice(0, 2).map(m => m.total_minor), [13000, 21519]);
  for (const m of monthly.ledger.months.slice(0, 2)) {
    const [payment] = m.possible_payments;
    assert.equal(payment.included_in_total, true);
    assert.ok(m.amount_citations.includes(payment.n), 'the included posting is an amount operand');
    const cited = monthly.citations.filter(c => m.amount_citations.includes(c.n));
    assert.equal(cited.reduce((n, c) => n + c.amount_minor, 0), m.total_minor, 'operands sum to the month figure');
  }
  const monthlySpend = await recorded(f, 'Could you retrieve spending month by month since August?',
    [{ kind: 'expense_summary', direction: 'outflow', period: { type: 'since', date: '2026-08-01' } }]);
  assert.deepEqual(monthlySpend.ledger.months.slice(0, 2).map(m => m.total_minor), [1000, 9519]);
});

test('business-scoped money out is withheld when a connected personal card could receive a card payment', async t => {
  const { f } = book(t, [...BUSINESS, ['perscard', 'card', 'liability', '4106', 'personal']],
    [...BUSINESS_ROWS.filter(row => row[5] !== 'repay'), ['biz', '2026-09-24', -8000, 'CARD AUTOPAY', null, 'moved']],
    { entities: ['business', 'personal'] });
  f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='personal'");
  const b = await recorded(f, 'What went out of the business account last month?',
    [{ kind: 'totals', direction: 'outflow', account_hint: 'business account', period: { type: 'last_month' } }]);
  assertWithheld(b, 'business scope, personal card connected');
  assert.deepEqual(b.ledger.possible_payments[0].connected_counterpart_masks.sort(), ['4102', '4106']);
});

test('a went-out answer that states no figure never calls a posting included', async t => {
  // A bare channel label refuses before reading; mixed loan components
  // withhold the whole answer. Neither may describe a posting as counted.
  for (const [text, payee, reason] of [['LOAN PAYMENT', null, 'payment_membership_unconfirmed'],
    ['Loan payment to outside lender principal 100.00 interest 20.00', 'Outside Lender', 'loan_payment_mixed_components']]) {
    const { f } = book(t, [['checking', 'checking', 'asset', '4100']], [['checking', '2026-09-03', -4520, 'Store purchase', 'Store Unit', 'spend'],
      ['checking', '2026-09-23', -12000, text, payee, 'repay']]);
    for (const question of [WENT_OUT[0], SPENT[0]]) {
      const b = await f.ask(question), l = b.ledger;
      assert.equal(l.reason, reason, question);
      assert.equal(l.expense_total_minor, null, question);
      assert.ok(l.possible_payments.every(row => row.included_in_total === undefined), question);
      assert.ok(!b.answer.includes('included above'), question);
      assert.match(b.answer, /possible loan payment, not counted/, question);
    }
  }
});

test('money in and out totals use the same money-out rule; money in is unchanged', async t => {
  const TOTALS = ['How much money came in and went out last month?', 'Show money out last month', 'What was my profit last month?'];
  const debits = b => Object.fromEntries(b.ledger.lead_accounts.map(account => [account.account_mask, account.debits_minor]));
  const credits = b => Object.fromEntries(b.ledger.lead_accounts.map(account => [account.account_mask, account.credits_minor]));
  // A loan payment (bank code or bank text) with no connected loan account left
  // the connected accounts: it is in that account's money out and disclosed.
  for (const category of [null, 'Loan Payments']) {
    const { f } = book(t, CHECKING_CARD, [...PURCHASES, ['checking', '2026-09-23', -12000, 'Loan payment to outside lender', 'Outside Lender', 'repay', category]]);
    for (const question of TOTALS) {
      const b = await f.ask(question);
      assert.equal(b.ledger.kind, 'totals', question);
      assert.equal(b.ledger.reason, undefined, question);
      assert.deepEqual(debits(b), { 4100: 4520 + 12000, 4102: 23000 + 1999 }, `${question}\n${b.answer}`);
      assert.deepEqual(credits(b), { 4100: 123456, 4102: 0 }, question);
      const [record] = b.ledger.possible_payments;
      assert.deepEqual([record.amount_minor, record.included_in_total], [12000, true], question);
      assert.ok(b.answer.includes(`included in money out above, possibly a loan payment${category ? ' (bank payment code)' : ''} (counterpart not proved): $120.00 on September 23`), b.answer);
      if (b.ledger.measure) assert.equal(b.ledger.net_minor, 123456 - (4520 + 12000) - (23000 + 1999), 'money in minus money out');
    }
    // Spending keeps excluding the payment, exactly as before.
    assertSpending(await f.ask(SPENT[0]), 4520 + 23000 + 1999, `totals spending control ${category}`);
  }
  // A card payment that could have reached the connected card is withheld,
  // never added to the card purchases it may settle.
  const { f } = book(t, CHECKING_CARD, [...PURCHASES, ['checking', '2026-09-20', -23000, 'AUTOPAY', null, 'moved', 'Credit Card Payment'],
    ['card', '2026-09-20', 23000, 'PAYMENT THANK YOU', null, 'moved']]);
  for (const question of TOTALS) {
    const b = await f.ask(question);
    assert.equal(b.ledger.reason, 'money_out_destination_unconfirmed', question);
    assert.equal(b.ledger.lead_accounts, undefined, question);
    assert.doesNotMatch(b.answer, /money out \$|debits \$/, question);
  }
  // Money in alone has no outgoing figure and is unchanged.
  const income = await f.ask('How much money came in last month?');
  assert.equal(income.ledger.reason, undefined);
  // A monthly money in/out reading withholds each such month, including when
  // the connected card's history is partial, instead of failing the read.
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-09-15' WHERE account_slug='card'");
  const monthly = await recorded(f, 'Could you retrieve money in and out month by month since August?',
    [{ kind: 'totals', direction: 'both', period: { type: 'since', date: '2026-08-01' } }]);
  const september = monthly.ledger.months.find(m => m.month === '2026-09');
  assert.equal(september.available, false);
  assert.equal(september.reason, 'money_out_destination_unconfirmed');
  assert.equal(september.outflow_minor ?? september.outflow_subtotal_minor, undefined);
});
