import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
import { MONEY_GUIDE } from '../src/lib/money-query-contract.js';
import { MONEY_KIND_DOUBTS } from '../src/lib/clean-money-evidence.js';

const NOW = Date.parse('2026-11-13T15:00:00Z');
const PERIOD = { period_from:'2026-10-01', period_to:'2026-10-31' };
const incomeSql = "SELECT SUM(income_minor) AS income_minor FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const contractSql = MONEY_GUIDE.match(/Answer-contract queries: (SELECT .*?;)/)?.[1];
assert.ok(contractSql, 'the published answer-contract query exists');

function book(t) {
  t.mock.method(Date, 'now', () => NOW);
  const f = overviewFixture(t);
  f.account('operating');
  f.run("UPDATE fin_entities SET kind='business'");
  f.coverage('operating', '2026-10-01', '2026-11-13');
  const add = (id, cents, direction, description, category = null, basis = null) => {
    f.row(id, 'operating', '2026-10-12', cents, direction, { description });
    f.run('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', category, basis, id);
  };
  const query = sql => queryMoney(f.env, { sql, ...PERIOD }, { now:() => NOW });
  return { ...f, add, query };
}

test('treatment: a counted certificate estimate is counted by the published query', async t => {
  const f = book(t);
  f.add('unknown', 120000, 'outflow', 'ACH DEBIT');
  const support = await f.query('SELECT * FROM txn');
  assert.equal(support.rows.length, 1, 'the certificate decision was reached');
  assert.equal(support.rows[0].estimated, 1);
  assert.equal(support.rows[0].estimate_reason, 'rail_only_counterparty_unrecorded');
  assert.equal(support.rows[0].expense_minor, 120000);
  const result = await f.query(contractSql);
  assert.equal(result.rows.length, 1, 'the shipped helper reached the nonempty book');
  assert.equal(result.rows[0].expense_minor, 120000);
  t.diagnostic(JSON.stringify({ figure:result.rows[0], confidence:result.confidence.percent }));
  assert.equal(result.rows[0].estimated_counted_minor, 120000);
  assert.equal(result.rows[0].estimated_left_out_minor, 0);
  assert.match(MONEY_GUIDE, /COUNTED \(estimated\)/);
  assert.match(MONEY_GUIDE, /LEFT OUT \(estimated\)/);
  assert.ok(result.confidence.percent < 90);
  assert.match(result.confidence_text, /\$1,200\.00/);
});

test('treatment control: a legacy counted estimate retains its dollars', async t => {
  const f = book(t);
  f.add('unknown', 40000, 'inflow', 'LOAN PROCEEDS');
  const support = await f.query('SELECT * FROM txn');
  assert.equal(support.rows.length, 1);
  assert.match(support.rows[0].estimate_reason, /_counted$/);
  assert.equal(support.rows[0].income_minor, 40000);
  const result = await f.query(contractSql);
  assert.equal(result.rows[0].estimated_counted_minor, 40000);
  assert.equal(result.rows[0].estimated_left_out_minor, 0);
});

test('treatment control: estimated owner money stays left out of operating totals', async t => {
  const f = book(t);
  f.add('draw', 30000, 'outflow', 'OWNER DRAW');
  const support = await f.query('SELECT * FROM txn');
  assert.equal(support.rows.length, 1);
  assert.equal(support.rows[0].money_kind, 'owner_money');
  assert.equal(support.rows[0].estimated, 1);
  assert.equal(support.rows[0].expense_minor, 0);
  const result = await f.query(contractSql);
  assert.equal(result.rows[0].estimated_counted_minor, 0);
  assert.equal(result.rows[0].estimated_left_out_minor, 30000);
});

// Execute the exact published helper over real captured txn rows. Vary only
// the reason to prove that every certificate reason handles both treatments.
test('treatment: every certificate doubt has counted and left-out controls, including signed adjustments', async t => {
  const f = book(t);
  f.add('unknown', 120000, 'outflow', 'ACH DEBIT');
  const captured = await f.query('SELECT * FROM txn');
  assert.equal(captured.rows.length, 1, 'the real certificate path supplied the row');
  const row = captured.rows[0], db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const columns = Object.keys(row);
  db.exec(`CREATE TABLE txn (${columns.map(c => '"' + c + '"').join(',')})`);
  const insert = db.prepare(`INSERT INTO txn VALUES (${columns.map(() => '?').join(',')})`);
  const cases = [
    ['expense', { expense_minor:120000 }, true],
    ['income', { income_minor:120000 }, true],
    ['additional interest', { interest_expense_minor:120000 }, true],
    ['sales return', { sales_adjust_minor:-120000 }, true],
    ['purchase refund', { refund_minor:120000 }, true],
    ['refund reversal', { refund_minor:-120000 }, true],
    ['no operating contribution', {}, false],
  ];
  assert.ok(MONEY_KIND_DOUBTS.length > 0, 'the reason registry is nonempty');
  let reached = 0;
  for (const reason of MONEY_KIND_DOUBTS) for (const [label, contribution, counted] of cases) {
    const input = { ...row, income_minor:0, expense_minor:0, interest_expense_minor:0,
      sales_adjust_minor:0, refund_minor:0, ...contribution, estimate_reason:reason };
    db.exec('DELETE FROM txn');
    insert.run(...columns.map(c => input[c]));
    const result = db.prepare(contractSql).get();
    reached++;
    assert.equal(result.estimated_counted_minor, counted ? 120000 : 0, reason + '/' + label);
    assert.equal(result.estimated_left_out_minor, counted ? 0 : 120000, reason + '/' + label);
  }
  assert.equal(reached, MONEY_KIND_DOUBTS.length * cases.length);
  t.diagnostic(`${reached} nonempty reason/contribution arms`);
});

for (const category of ['CLIENT_INCOME', 'INTEREST_INCOME', 'client income', 'sales revenue', 'INCOME']) {
  test(`income: owner-confirmed ${category} certifies a qualified income category`, async t => {
    const f = book(t);
    f.add('receipt', 214511, 'inflow', 'Payment for work', category, 'confirmed');
    const support = await f.query('SELECT * FROM txn');
    assert.equal(support.rows.length, 1, 'the certificate decision was reached');
    assert.equal(support.rows[0].income_minor, 214511);
    const result = await f.query(incomeSql);
    assert.equal(result.rows[0].income_minor, 214511);
    t.diagnostic(JSON.stringify({ category, figure:result.rows[0].income_minor,
      estimated:support.rows[0].estimated, confidence:result.confidence.percent }));
    assert.equal(support.rows[0].estimated, 0);
    assert.equal(result.confidence.percent, 89, 'a confirmed type code does not resolve a missing payer');
    assert.match(result.confidence_text, /identity is unresolved/);
    assert.match(result.confidence_text, /2,145\.11/);
    f.run("UPDATE fin_transactions SET payee='Customer' WHERE txn_uid='receipt'");
    const resolved=await f.query(incomeSql);
    assert.equal(resolved.rows[0].income_minor,214511);
    assert.equal(resolved.confidence.percent,95,'the resolved all-history High control is retained');
  });
}

for (const [label, category, basis, description, expectEstimate=true] of [
  ['description only', null, null, 'Client income sales revenue', false],
  ['proposed category', 'CLIENT_INCOME', 'proposed', 'Payment for work', false],
  ['whole-word boundary', 'SALESFORCE', 'confirmed', 'Payment for work'],
  ['negated income', 'NOT_INCOME', 'confirmed', 'Payment for work'],
  ['non-income', 'NON_INCOME', 'confirmed', 'Payment for work'],
  ['negated sales', 'NO_SALES', 'confirmed', 'Payment for work'],
  ['income tax', 'INCOME_TAX', 'confirmed', 'Payment for work'],
  ['customer deposit', 'CUSTOMER_DEPOSIT_INCOME', 'confirmed', 'Payment for work'],
]) test(`income control: ${label} ${expectEstimate?'stays estimated':'counts at face value'}`, async t => {
  const f = book(t);
  f.add('receipt', 214511, 'inflow', description, category, basis);
  const support = await f.query('SELECT * FROM txn');
  assert.equal(support.rows.length, 1, 'the type decision was reached');
  assert.equal(support.rows[0].income_minor, 214511, 'classification doubt keeps the figure');
  const result = await f.query(incomeSql);
  assert.equal(result.rows[0].income_minor, 214511);
  t.diagnostic(JSON.stringify({ control:label, figure:result.rows[0].income_minor,
    estimated:support.rows[0].estimated, confidence:result.confidence.percent }));
  // Ordinary receipts still count at face value. Missing party identity now
  // caps the type certificate even when classification itself is unestimated.
  assert.equal(support.rows[0].estimated, Number(expectEstimate));
  if(expectEstimate){
    assert.ok(result.confidence.percent < 90);
    assert.match(result.confidence_text, /\$2,145\.11/);
    assert.match(result.confidence_text, /Missing:.*(?:category|record|statement)/is);
  } else {
    assert.equal(result.confidence.percent,89);
    assert.match(result.confidence_text,/identity is unresolved/);
    f.run("UPDATE fin_transactions SET payee='Customer' WHERE txn_uid='receipt'");
    const resolved=await f.query(incomeSql);
    assert.equal(resolved.rows[0].income_minor,214511);
    assert.equal(resolved.confidence.percent,95);
  }
});

for (const [label, category, description] of [
  ['sales tax code', 'SALES_TAX', 'Tax receipt'],
  ['qualified sales tax income', 'SALES_TAX_INCOME', 'Tax receipt'],
  ['qualified sales tax revenue', 'SALES_TAX_REVENUE', 'Tax receipt'],
  ['sales taxes', 'SALES_TAXES', 'Tax receipt'],
  ['collected tax category', 'TAX_COLLECTED', 'Receipt'],
  ['tax payable category', 'TAXES_PAYABLE', 'Receipt'],
  ['value added tax category', 'VAT_COLLECTED', 'Receipt'],
  ['goods and services tax category', 'GST_COLLECTED', 'Receipt'],
  ['sales tax descriptor', 'sales revenue', 'Sales tax collected for the government'],
  ['tax collected descriptor', 'CLIENT_INCOME', 'Tax collected for remittance'],
  ['value added tax descriptor', 'INCOME', 'Value added tax collected'],
]) test(`tax collected: ${label} cannot certify operating income`, async t => {
  const f = book(t);
  f.add('tax-receipt', 214511, 'inflow', description, category, 'confirmed');
  const support = await f.query('SELECT * FROM txn');
  assert.equal(support.rows.length, 1, 'the nonzero receipt reached the real type decision');
  assert.equal(support.rows[0].income_minor, 214511, 'tax doubt preserves the provisional figure');
  const result = await f.query(incomeSql);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].income_minor, 214511);
  t.diagnostic(JSON.stringify({ tax:label, estimated:support.rows[0].estimated, percent:result.confidence.percent }));
  assert.equal(support.rows[0].estimated, 1);
  assert.ok(result.confidence.percent < 90);
  assert.match(result.confidence_text, /\$2,145\.11/);
  assert.match(result.confidence_text, /tax.*(?:collected|remittance|government)/i);
  assert.match(result.confidence_text, /Missing:.*(?:tax|payable|remittance)/is);
  assert.equal(result.confidence.may_only_lower, true);
});
