import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';

test('R1 future deposits preserve the requested payer and account', async t => {
  const f = setup(t);
  for (const day of ['2026-08-20', '2026-09-20', '2026-10-20']) {
    f.add('main', day, 10000, 'inflow', 'Synthetic Payer deposit', 'Synthetic Payer');
    f.add('main', day, 20000, 'inflow', 'Other Payer deposit', 'Other Payer');
  }
  const exact = await ask(f, 'how much money will come in from Synthetic Payer next month',
    raw(intent('deposits', { direction: 'inflow', vendor_text: 'Synthetic Payer' })));
  assert.equal(exact.body.ledger?.total_minor, Math.round(10000 * 31 / 30.4375));
  const payment = await ask(f, 'how much money will come in from Synthetic Payer next month',
    raw(intent('payment', { direction: 'inflow', vendor_text: 'Synthetic Payer' })));
  assert.equal(payment.body.ledger?.total_minor, Math.round(10000 * 31 / 30.4375));
  for (const day of ['2026-08-20', '2026-09-20', '2026-10-20'])
    f.add('personal', day, 40000, 'inflow', 'Monthly deposit', 'Synthetic Payer');
  for (const account_hint of [null, 'business']) {
    const { body } = await ask(f, `how much money will come in from Synthetic Payer next month${account_hint ? ' in business accounts' : ''}`,
      raw(intent('deposits', { direction: 'inflow', vendor_text: 'Synthetic Payer', account_hint })));
    assert.equal(body.ledger?.total_minor, Math.round((account_hint ? 10000 : 50000) * 31 / 30.4375));
    assert.equal(body.ledger.projection, true);
    assert.equal(body.ledger.rows.length, account_hint ? 3 : 6);
  }
});

test('R2 pending deposits preserve direction before totals and evidence', async t => {
  const f = setup(t);
  f.add('main', '2026-11-02', 10000, 'inflow', 'Pending deposit', 'Synthetic Payer');
  f.add('main', '2026-11-02', 90000, 'outflow', 'Pending purchase', 'Synthetic Vendor');
  f.raw('UPDATE fin_transactions SET pending=1 WHERE posted_on=\'2026-11-02\'');
  const { body } = await ask(f, 'show my pending deposits this month', raw(intent('transactions', { direction: 'inflow' })));
  assert.equal(body.ledger?.total_minor, 10000);
  assert.equal(body.ledger.rows.length, 1);
  assert.equal(body.ledger.rows[0].direction, 'inflow');
});

test('R3 future open ranges use a finite labeled projection', async t => {
  const f = setup(t);
  for (const day of ['2026-08-20', '2026-09-20', '2026-10-20']) f.add('main', day, 10000, 'outflow', 'Monthly service', 'Synthetic Service');
  for (const [phrase, from, to, days] of [
    ['after 2026-12-01', '2026-12-02', '2026-12-31', 30],
    ['since 2026-12-01', '2026-12-01', '2026-12-31', 31],
    ['after 2026-12-31', '2027-01-01', '2027-01-31', 31],
  ]) {
    const { body } = await ask(f, `what will my expenses be ${phrase}`, raw(intent()));
    assert.equal(body.ledger?.from, from);
    assert.equal(body.ledger.to, to);
    assert.equal(body.ledger.total_minor, Math.round(10000 * days / 30.4375));
    assert.equal(body.ledger.projection, true);
    assert.match(body.answer, /Projection: about/);
    assert.match(body.answer, /open-ended.*end of.*month/i);
  }
});

test('open date ranges use available coverage and exclude the named day', async t => {
  const f = setup(t);
  for (const [word, from, to, total] of [
    ['before', '2024-01-01', '2026-10-09', 700],
    ['after', '2026-10-11', '2026-11-03', 0],
  ]) {
    const { body } = await ask(f, `what were my expenses ${word} 2026-10-10`, raw(intent()));
    assert.equal(body.ledger.from, from);
    assert.equal(body.ledger.to, to);
    assert.equal(body.ledger.total_minor, total);
    assert.match(body.answer, /Bank history/);
  }
});

test('checking a question does not select checking accounts', async t => {
  const f = setup(t);
  f.add('reserve', '2026-10-20', 888);
  for (const voice of ['I am checking something: ', "I'm checking something: ", 'checking something: ']) {
    const { body } = await ask(f, `${voice}what were my expenses last month`, raw(intent()));
    assert.equal(body.ledger?.total_minor, 2588, voice);
    assert.ok(body.ledger.accounts.some(a => a.account_mask === '2222'));
  }
});

test('personal vs buisness keeps both sides', async t => {
  const f = setup(t);
  for (const account_hint of [null, 'personal', 'business']) {
    const { body } = await ask(f, 'what were my expenses last month and how many of them were personal vs buisness and can you list them out', raw(intent('expense_summary', { account_hint })));
    assert.equal(body.ledger.total_minor, 1700, account_hint);
    assert.ok(body.ledger.accounts.some(a => a.account_mask === '1111'));
    assert.ok(body.ledger.accounts.some(a => a.account_mask === '4444'));
  }
});

test('future expenses return a labeled repeating-history projection', async t => {
  const f = setup(t);
  for (const day of ['2026-08-20', '2026-09-20', '2026-10-20']) f.add('main', day, 10000, 'outflow', 'Monthly service', 'Synthetic Service');
  for (const day of ['2026-08-21', '2026-09-21', '2026-10-21']) f.add('main', day, 50000, 'outflow', 'Loan payment', 'Synthetic Lender');
  f.raw("UPDATE fin_transactions SET category='LOAN_PAYMENTS' WHERE amount_minor=50000");
  const { body } = await ask(f, 'what will my expenses be next month', raw(intent()));
  assert.equal(body.ledger.from, '2026-12-01');
  assert.equal(body.ledger.to, '2026-12-31');
  assert.equal(body.ledger.total_minor, Math.round(10000 * 31 / 30.4375));
  assert.equal(body.ledger.projection, true);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /Projection: about.*repeating charges/s);
  assert.equal(body.ledger.basis.patterns.length, 1);
  assert.equal(body.ledger.left_out.find(b => b.bucket === 'loan_payment').total_minor, 150000);
});

test('no-pattern projection explains its zero estimate', async t => {
  const f = setup(t);
  const { body } = await ask(f, 'money in next month', raw(intent('totals')));
  assert.equal(body.ledger.combined_inflow_minor, 0);
  assert.equal(body.ledger.estimate, true);
  assert.match(body.answer, /pattern-only estimate, not a prediction of no activity/);
});

test('a future vendor filter keeps unrelated recurring charges out', async t => {
  const f = setup(t);
  for (const day of ['2026-08-20', '2026-09-20', '2026-10-20']) {
    f.add('main', day, 10000, 'outflow', 'Monthly service', 'Synthetic Service');
    f.add('main', day, 20000, 'outflow', 'Monthly service', 'Other Service');
  }
  const { body } = await ask(f, 'what will I spend at Synthetic Service next month', raw(intent('merchant', { vendor_text: 'Synthetic Service' })));
  assert.equal(body.ledger.total_minor, Math.round(10000 * 31 / 30.4375));
});

test('future money in and out retain separate projections', async t => {
  const f = setup(t);
  for (const day of ['2026-08-20', '2026-09-20', '2026-10-20']) {
    f.add('main', day, 10000, 'outflow', 'Monthly service', 'Synthetic Service');
    f.add('main', day, 30000, 'inflow', 'Monthly deposit', 'Synthetic Payer');
  }
  const { body } = await ask(f, 'show money in and out next month', raw(intent('totals', { direction: 'both' })));
  assert.equal(body.ledger.combined_inflow_minor, Math.round(30000 * 31 / 30.4375));
  assert.equal(body.ledger.projected_outflow_minor, Math.round(10000 * 31 / 30.4375));
  assert.match(body.answer, /money in and.*ordinary spending/);
});

test('top vendors return ranked groups with the requested cap', async t => {
  const f = setup(t);
  for (let n = 1; n <= 7; n++) f.add('main', '2026-10-25', 1000 * n, 'outflow', 'Supplies', `Synthetic Vendor ${n}`);
  const { body } = await ask(f, 'what are my top 5 vendors this year', raw(intent('largest', { count: 5 })));
  assert.equal(body.ledger.groups.length, 5);
  assert.equal(body.ledger.groups[0].total_minor, 7000);
  assert.equal(body.ledger.omitted_group_count, 3);
});

test('pending returns pending rows and their figure, apart from posted cash', async t => {
  const f = setup(t);
  f.add('main', '2026-11-02', 345);
  f.raw("UPDATE fin_transactions SET pending=1 WHERE amount_minor=345");
  const { body } = await ask(f, 'is there anything showing as pending', raw(intent('transactions')));
  assert.equal(body.ledger.total_minor, 345);
  assert.equal(body.ledger.rows.length, 1);
  assert.match(body.answer, /excluded from completed cash/);
});

test('loan payments have their own figure without counting ordinary purchases', async t => {
  const f = setup(t);
  f.add('main', '2026-11-02', 4567, 'outflow', 'Loan payment', 'Synthetic Lender');
  f.raw("UPDATE fin_transactions SET category='LOAN_PAYMENTS' WHERE amount_minor=4567");
  f.add('main', '2026-11-02', 999);
  const { body } = await ask(f, 'how much did i put toward the loan', raw(intent()));
  assert.equal(body.ledger.total_minor, 4567);
  assert.equal(body.ledger.rows.length, 1);
  assert.match(body.answer, /Principal and interest are not separated/);
});
