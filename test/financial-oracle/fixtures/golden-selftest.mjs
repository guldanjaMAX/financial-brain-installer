// Fixture arithmetic only. This does not test a deployed Brain or an Intuit API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./golden-company.json', import.meta.url)));
const requests = JSON.parse(readFileSync(new URL('./seed-requests.json', import.meta.url)));
const expected = key => BigInt(fixture.expected_minor[key]);
function ledger(events) {
  const totals = Object.fromEntries(Object.keys(fixture.accounts).map(id => [id, 0n]));
  for (const event of events) for (const p of event.postings) {
    totals[p.account] += BigInt(p.minor) * (p.side === 'debit' ? 1n : -1n);
  }
  return totals;
}
const totals = ledger(fixture.events);
const roleTotal = role => Object.entries(fixture.accounts)
  .filter(([, a]) => a.role === role).reduce((s, [id]) => s + totals[id], 0n);

test('all 20 source events have balanced nonempty postings and fixed dates', () => {
  assert.equal(fixture.events.length, 20);
  assert.equal(new Set(fixture.events.map(e => e.id)).size, 20);
  for (const event of fixture.events) {
    assert.ok(event.postings.length >= 2);
    assert.match(event.date, /^202[45]-\d{2}-\d{2}$/);
    assert.equal(event.postings.reduce((s, p) => s + BigInt(p.minor) * (p.side === 'debit' ? 1n : -1n), 0n), 0n);
  }
});
test('independent debit-credit oracle agrees with expected balances, profit and equation', () => {
  for (const id of ['checking','savings','ar','undeposited','equipment']) assert.equal(totals[id], expected(id));
  for (const id of ['ap','card','sales_tax','payroll','loan','revenue','interest']) assert.equal(-totals[id], expected(id));
  assert.equal(roleTotal('expense'), expected('expenses'));
  const profit = -roleTotal('income') - roleTotal('expense');
  assert.equal(profit, expected('profit'));
  assert.equal(roleTotal('asset'), expected('assets'));
  assert.equal(-roleTotal('liability'), expected('liabilities'));
  const equity = -roleTotal('equity') - roleTotal('contra_equity') + profit;
  assert.equal(equity, expected('equity'));
  assert.equal(roleTotal('asset'), -roleTotal('liability') + equity);
});
test('trial balance and cash rollforward close exactly', () => {
  assert.equal(Object.values(totals).filter(x => x > 0n).reduce((s,x) => s+x,0n), expected('trial_balance_debits'));
  assert.equal(-Object.values(totals).filter(x => x < 0n).reduce((s,x) => s+x,0n), expected('trial_balance_credits'));
  const cash = totals.checking + totals.savings;
  assert.equal(cash, expected('bank_cash'));
  assert.equal(cash - 1500000n, expected('cash_change'));
  const bankLines = fixture.events.filter(e => e.date >= fixture.period.start).flatMap(e => e.postings)
    .filter(p => ['checking','savings'].includes(p.account));
  assert.equal(bankLines.filter(p => p.side === 'debit').reduce((s,p) => s+BigInt(p.minor),0n),expected('bank_inflows'));
  assert.equal(bankLines.filter(p => p.side === 'credit').reduce((s,p) => s+BigInt(p.minor),0n),expected('bank_outflows'));
});
test('open-item truth includes payment and applied credit without double counting', () => {
  assert.equal(120000n - 70000n - 10000n, BigInt(fixture.expected_open_items[0].minor));
  assert.equal(60000n - 25000n, BigInt(fixture.expected_open_items[2].minor));
  assert.equal(fixture.expected_open_items.slice(0,2).reduce((s,x)=>s+BigInt(x.minor),0n), expected('ar'));
  assert.equal(fixture.expected_open_items.slice(2).reduce((s,x)=>s+BigInt(x.minor),0n), expected('ap'));
});
test('one expense perturbation moves cash and profit by exactly 123 cents', () => {
  const changed = structuredClone(fixture.events);
  const event = changed.find(e => e.id === 'S12');
  assert.equal(event.postings.length, 2);
  for (const p of event.postings) p.minor = String(BigInt(p.minor) + 123n);
  const altered = ledger(changed);
  assert.equal(altered.checking - totals.checking, -123n);
  assert.equal(altered.supplies - totals.supplies, 123n);
  assert.equal(altered.revenue, totals.revenue);
  assert.notDeepEqual(altered, totals);
});
test('transfer and draw change bank activity without becoming revenue or expenses', () => {
  const beforeTransfer = ledger(fixture.events.filter(e => e.id !== 'S15'));
  assert.equal(totals.checking - beforeTransfer.checking, -100000n);
  assert.equal(totals.savings - beforeTransfer.savings, 100000n);
  assert.equal(totals.revenue, beforeTransfer.revenue);
  const beforeDraw = ledger(fixture.events.filter(e => e.id !== 'S16'));
  assert.equal(totals.checking - beforeDraw.checking, -40000n);
  assert.equal(totals.draws - beforeDraw.draws, 40000n);
  assert.equal(totals.supplies, beforeDraw.supplies);
});
test('symbolic API plan covers every source event and the credit application', () => {
  assert.equal(requests.requests.length, 21);
  for (const e of fixture.events) assert.equal(requests.requests.filter(r => r.seed_id === e.id).length, 1);
  assert.equal(requests.requests.filter(r => r.seed_id === 'S05-apply').length, 1);
  for (const r of requests.requests) {
    assert.equal(r.method, 'POST');
    assert.match(r.path, /^\/v3\/company\/\{sandbox_realm\}\/[a-z]+$/);
  }
});
test('the base golden is dated accrual evidence, with no assumed live clock', () => {
  assert.equal(fixture.period.basis, 'accrual');
  assert.equal(fixture.clock, '2025-01-31T23:59:59.000Z');
  assert.equal(fixture.synthetic_only, true);
  assert.equal(fixture.events.filter(e => e.date < fixture.period.start).length, 1);
});
