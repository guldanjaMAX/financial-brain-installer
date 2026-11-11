import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './ledger-review-fixture.mjs';

// Synthetic truth, from authored tags only (never a product classifier):
//   receipt - money a customer paid in; the only income in this book
//   moved   - one leg of a move between two of the owner's connected accounts
//   repay   - one leg of a payment to the owner's connected card
//   spend   - a purchase
// "Who paid me" lists payers and an income total. A credit that money in
// subtracts as a proved own move is never a payer either, and the answer
// boundary admits no own-account money (any certainty), owner contribution,
// refund or reversal into a payer row or an income total: those are listed on
// one disclosed line with their amounts.
const PAYER_QUESTIONS = ['Who paid me last month?', 'Who piad me last month?', 'Show who sent me mony last month'];
const MONEY_IN = 'How much money came in last month?';
const ACCOUNTS = [['store-checking', 'store', 'checking', 'asset', '4100'], ['home-checking', 'personal', 'checking', 'asset', '4101'],
  ['store-card', 'store', 'card', 'liability', '4102']];
const BASE_ROWS = [
  ['store-checking', '2026-09-03', 18044, 'inflow', 'CED PAYMENT', 'Cedar', 'receipt'],
  ['store-checking', '2026-09-08', 130443, 'inflow', 'Card Sales', 'Card Sales', 'receipt'],
  ['store-card', '2026-09-14', 4588, 'inflow', 'Card Sales', 'Card Sales', 'receipt'],
  ['store-checking', '2026-09-16', 123456, 'inflow', 'Payer Unit', 'Payer Unit', 'receipt'],
  ['store-checking', '2026-09-05', 7999, 'outflow', 'Clearline Internet', 'Clearline Internet', 'spend'],
  ['store-card', '2026-09-09', 2310, 'outflow', 'Supply purchase', 'Supply Unit', 'spend'],
  ['store-checking', '2026-09-12', 80011, 'outflow', 'payment to account 4102', 'Payment', 'repay'],
  ['store-card', '2026-09-12', 80011, 'inflow', 'payment from account 4100', 'Payment', 'repay'],
];
// The witness: row-91/row-92 shape, 50011 minor between two owned checking
// accounts, each leg naming the other exact owned account.
const MOVE_ROWS = [
  ['store-checking', '2026-09-12', 50011, 'outflow', 'payment to account 4101', 'Payment', 'moved'],
  ['home-checking', '2026-09-12', 50011, 'inflow', 'payment from account 4100', 'Payment', 'moved'],
];

function book(t, rows) {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.owner('store'); f.owner('personal');
  f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='personal'");
  for (const [slug, entity, kind, role, mask] of ACCOUNTS) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,'manual','owner_stated','confirmed','2026-10-12')`, slug, entity, kind, role, mask, `Synthetic ${slug}`);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-06-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')`, slug);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',100000,'owner_stated','confirmed','2026-10-12')`, slug);
  }
  const authored = rows.map(([account, date, cents, direction, description, payee, tag], index) => {
    const uid = `row-${index + 1}`;
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,0,'owner_stated','confirmed','2026-10-12')`, uid, account, date, cents, direction, description, payee);
    return { uid, account, date, cents, direction, tag };
  });
  const income = authored.filter(row => row.direction === 'inflow' && row.tag === 'receipt').reduce((n, row) => n + row.cents, 0);
  return { f, authored, income };
}
async function reached(f, question) {
  const before = f.first('SELECT total_changes() n').n, start = f.calls.length;
  const b = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'no writes');
  assert.ok(b.ledger, `${question}: ledger answer reached`);
  return b;
}
const cash = minor => '$' + (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const citedAmounts = (b, numbers) => numbers.map(n => b.citations.find(c => c.n === n)?.amount_minor);

const RECEIPTS = 18044 + 130443 + 4588 + 123456;
const notPayment = l => (l.not_payments?.rows || []).map(row => [row.amount_minor, row.reason]);
function assertPayers(b, income, question) {
  const l = b.ledger;
  assert.equal(l.kind, 'merchant', question);
  assert.equal(l.total_minor, income, `${question}: income total\n${b.answer}`);
  assert.equal(l.lead_total_minor, income, `${question}: lead income total`);
  assert.ok(b.answer.includes(`Total income by merchant: ${cash(income)}.`), `${question}\n${b.answer}`);
  assert.equal(l.groups.reduce((n, group) => n + group.total_minor, 0), income, `${question}: payer groups sum to the income total`);
}

test('who paid me never lists a proved own-account move as a payer or as income (witness, three phrasings)', async t => {
  const { f, income } = book(t, [...BASE_ROWS, ...MOVE_ROWS]);
  assert.equal(income, RECEIPTS);
  const moneyIn = await reached(f, MONEY_IN);
  assert.equal(moneyIn.ledger.outside_inflow_minor, income, 'money-in control: outside inflow excludes the proved move');
  for (const question of PAYER_QUESTIONS) {
    const b = await reached(f, question), l = b.ledger;
    assertPayers(b, income, question);
    assert.equal(l.total_minor, moneyIn.ledger.outside_inflow_minor, `${question}: same figure as money in`);
    // Every payer group sums only customer receipts; the moved leg is in none.
    assert.ok(!l.groups.flatMap(group => citedAmounts(b, group.citations)).includes(50011), `${question}: own move is never a payer`);
    assert.deepEqual(notPayment(l), [[50011, 'a move between your own accounts']], `${question}: own move disclosed`);
    const ref = b.citations.find(c => c.n === l.not_payments.rows[0].n);
    assert.deepEqual([ref?.amount_minor, ref?.account_mask], [50011, '4101']);
    assert.ok(b.answer.includes(`Not counted as payments to you: ${cash(50011)} (a move between your own accounts ${cash(50011)} [${ref.n}]).`), `${question}: disclosure line`);
  }
});

test('green control: a real customer payment of the same amount stays a payer and stays income', async t => {
  // Same amount, date and receiving account, but the deposit names an outside
  // payer and no owned account. The second arm adds the outgoing leg that
  // names the receiving account; the outside payee keeps any pair unproved.
  const customer = [['home-checking', '2026-09-12', 50011, 'inflow', 'Client Unit', 'Client Unit', 'receipt']];
  for (const rows of [[...BASE_ROWS, ...customer], [...BASE_ROWS, MOVE_ROWS[0], ...customer]]) {
    const { f, income } = book(t, rows);
    assert.equal(income, RECEIPTS + 50011);
    const moneyIn = await reached(f, MONEY_IN);
    assert.equal(moneyIn.ledger.outside_inflow_minor, income, 'money-in control');
    for (const question of PAYER_QUESTIONS) {
      const b = await reached(f, question), l = b.ledger;
      assertPayers(b, income, question);
      const client = l.groups.find(group => citedAmounts(b, group.citations).includes(50011));
      assert.ok(client, `${question}: the customer stays a payer\n${b.answer}`);
      assert.equal(l.not_payments, undefined, `${question}: nothing to disclose`);
    }
  }
});

test('answer boundary: own money of any certainty, contributions, refunds and reversals are never payers', async t => {
  // One credit per arm next to the customer receipts. Money in keeps its own
  // gross and outside figures; the payer answer lists each arm separately.
  const arms = [
    ['single-leg named owned endpoint', MOVE_ROWS[1], 'a possible move from your own account'],
    ['owner contribution', ['store-checking', '2026-09-15', 11387, 'inflow', 'Owner contribution', 'Contribution Unit', 'moved'], 'an owner contribution'],
    ['refund', ['store-checking', '2026-09-17', 10976, 'inflow', 'Merchant refund for returned purchase', 'Refund Unit', 'refund'], 'a refund or reversal'],
    ['reversal', ['store-checking', '2026-09-18', 11113, 'inflow', 'Reversal returned item', 'Reversal Unit', 'refund'], 'a refund or reversal'],
    // An unnamed deposit equal to an outflow that names its account: the
    // pairing reader nominates the pair, so it is possibly own money.
    ['possible pair', ['home-checking', '2026-09-12', 50011, 'inflow', 'CLIENT UNIT DEPOSIT', null, 'moved'], 'a possible move from your own account', MOVE_ROWS[0]],
  ];
  for (const [name, credit, reason, extra] of arms) {
    const { f, income } = book(t, [...BASE_ROWS, credit, ...(extra ? [extra] : [])]);
    assert.equal(income, RECEIPTS, name);
    // Money in keeps an unproved pair in outside inflow (directed proof only).
    if (extra) assert.equal((await reached(f, MONEY_IN)).ledger.outside_inflow_minor, RECEIPTS + credit[2], `${name}: money-in control`);
    for (const question of PAYER_QUESTIONS) {
      const b = await reached(f, question), l = b.ledger;
      assertPayers(b, income, `${name}: ${question}`);
      assert.ok(!l.groups.flatMap(group => citedAmounts(b, group.citations)).includes(credit[2]), `${name}: never a payer`);
      assert.deepEqual(notPayment(l), [[credit[2], reason]], `${name}: disclosed with its amount\n${b.answer}`);
      assert.ok(b.answer.includes(`Not counted as payments to you: ${cash(credit[2])} (${reason} ${cash(credit[2])} [`), `${name}: disclosure line`);
    }
  }
});

test('possible own-account credit stays outside income and has a cited disclosure', async t => {
  // The explicit own-account subject nominates possible own money. A sender
  // label cannot turn it into income; gross money-in still keeps the credit.
  const credit = ['home-checking', '2026-09-14', 10839, 'inflow', 'Transfer from my unconnected own account', 'Unconnected Unit', 'unknown'];
  const { f } = book(t, [...BASE_ROWS, credit]);
  for (const question of PAYER_QUESTIONS) {
    const b = await reached(f, question), l = b.ledger;
    assertPayers(b, RECEIPTS, question);
    assert.equal(l.complete, false, `${question}: never certified`);
    assert.deepEqual(notPayment(l), [[credit[2], 'a possible move from your own account']]);
    assert.match(b.answer, /Not counted as payments to you: \$108\.39/, `${question}\n${b.answer}`);
  }
});

test('bare outside transfer stays listed with its attribution unconfirmed', async t => {
  const credit = ['home-checking', '2026-09-14', 10839, 'inflow', 'Transfer from Sender Unit', 'Sender Unit', 'unknown'];
  const { f } = book(t, [...BASE_ROWS, credit]);
  for (const question of PAYER_QUESTIONS) {
    const b = await reached(f, question);
    assertPayers(b, RECEIPTS + credit[2], question);
    assert.equal(b.ledger.complete, false);
    assert.equal(b.ledger.not_payments, undefined);
    assert.match(b.answer, /Possible transfer, unmatched/);
  }
});
