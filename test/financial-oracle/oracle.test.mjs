import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculate, perturbExpense, decimalMinor } from './ledger.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/golden-company.json', import.meta.url)));

test('independent calculator recomputes all 23 values and all dated open items', () => {
  const result = calculate(fixture);
  assert.equal(Object.keys(result.values).length, 23);
  assert.deepEqual(result.values, fixture.expected_minor);
  assert.deepEqual(result.open_items.map(({id, minor, aging_bucket}) => ({id, minor, aging_bucket})), fixture.expected_open_items);
  assert.equal(result.events_checked, 20);
  assert.equal(result.total_income, '372500');
  assert.equal(result.transfer, '100000');
  assert.equal(result.transfer_net, '0');
});
test('truth is recomputed without trusting fixture expectations and order', () => {
  const altered = structuredClone(fixture);
  altered.expected_minor.checking = '1';
  altered.events.reverse();
  assert.equal(calculate(altered).values.checking, '1150500');
});
test('explicit cash and unknown bases refuse at the reached basis gate with an accrual control', () => {
  const control = calculate(fixture, {...fixture.period, basis:'accrual'});
  assert.equal(control.events_checked, 20);
  assert.deepEqual(control.values, fixture.expected_minor);
  for (const basis of ['cash', 'unknown', '', 'Accrual', ' accrual ', null, undefined, false, 0, {}]) {
    let reads = 0;
    const period = {...fixture.period, get basis() { reads++; return basis; }};
    assert.throws(() => calculate(fixture, period), {
      code:'ORACLE_BASIS_UNSUPPORTED', reason:'unsupported_basis', stage:'basis',
    });
    assert.ok(reads > 0, 'the requested basis was inspected');
  }
});
test('an unsupported fixture basis cannot be hidden by an omitted or accrual period override', () => {
  assert.equal(calculate(fixture).events_checked, 20);
  for (const basis of ['cash', 'unknown', null]) {
    const changed = structuredClone(fixture); changed.period.basis = basis;
    for (const period of [undefined, {start:fixture.period.start, end:fixture.period.end}, {...fixture.period}]) {
      assert.throws(() => calculate(changed, period), {
        code:'ORACLE_BASIS_UNSUPPORTED', reason:'unsupported_basis', stage:'basis',
      });
    }
  }
});
test('default, explicit and inherited accrual keep all truths and return their dated basis scope', () => {
  const control = calculate(fixture);
  assert.equal(control.events_checked, 20);
  assert.deepEqual(control.scope, fixture.period);
  assert.deepEqual(calculate(fixture, {...fixture.period, basis:'accrual'}), control);
  assert.deepEqual(calculate(fixture, {start:fixture.period.start, end:fixture.period.end}), control);
  assert.deepEqual(control.values, fixture.expected_minor);
  assert.deepEqual(control.open_items.map(({id, minor, aging_bucket}) => ({id, minor, aging_bucket})), fixture.expected_open_items);
});
test('30 independent expense perturbations move cash and profit by exact deltas', () => {
  const before = calculate(fixture);
  for (let delta = 1n; delta <= 30n; delta++) {
    const after = calculate(perturbExpense(fixture, delta));
    assert.equal(BigInt(after.values.profit) - BigInt(before.values.profit), -delta);
    assert.equal(BigInt(after.values.bank_cash) - BigInt(before.values.bank_cash), -delta);
    assert.equal(after.values.revenue, before.values.revenue);
    assert.equal(after.events_checked, 20);
  }
});
test('invalid posting, date and allocation are refused after a green ledger control', () => {
  assert.equal(calculate(fixture).events_checked, 20);
  for (const change of [f => f.events[1].date = '2025-02-30', f => f.events[1].postings[0].minor = '1',
    f => f.events[4].linked = 'S02', f => f.events[1].postings[0].side = 'unknown']) {
    const bad = structuredClone(fixture); change(bad);
    assert.throws(() => calculate(bad), /ORACLE_/);
  }
});
test('cutoff excludes future settlement; income uses requested period', () => {
  const f = structuredClone(fixture);
  f.events.find(e => e.id === 'S04').date = '2025-02-01';
  assert.equal(calculate(f).open_items.find(e => e.id === 'S01').minor, '110000');
  const feb = calculate(fixture, { start:'2025-02-01', end:'2025-02-28' });
  assert.equal(feb.values.profit, '0');
  assert.equal(feb.values.cash_change, '0');
  assert.equal(feb.values.equity, fixture.expected_minor.equity);
});
test('exact USD JPY KWD decimals reject ambiguity and preserve huge integers', () => {
  assert.equal(decimalMinor('9007199254740993.01', 2), 900719925474099301n);
  assert.equal(decimalMinor('-1.234', 3), -1234n);
  assert.equal(decimalMinor('12', 0), 12n);
  assert.equal(decimalMinor('-0.00', 2), 0n);
  for (const input of ['1e3', '1,000.00', ' 1.00', '0.001']) assert.throws(() => decimalMinor(input,2), /ORACLE_/);
});
