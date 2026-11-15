import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';

const period = { period_from:'2026-10-01', period_to:'2026-10-31' };
const window = { from:period.period_from, through:period.period_to };
const sql = "SELECT currency,SUM(income_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND income_minor>0 GROUP BY currency";
const now = () => Date.parse('2026-11-14T18:00:00Z');
function book(t, { purchaseDay=null, category='CLIENT_INCOME', coverageFrom='2026-09-01' } = {}) {
  const f = fixture(t);
  f.env.BRAIN_TIMEZONE = 'UTC';
  f.account('operating', { mode:'manual' });
  f.coverage('operating', coverageFrom, period.period_to);
  if (purchaseDay) f.row('purchase', 'operating', 50000, {
    day:purchaseDay, direction:'outflow', payee:'Service vendor', category:'SOFTWARE',
  });
  f.row('receipt', 'operating', 100000, { day:'2026-10-02', payee:'Customer', category });
  if (purchaseDay) f.row('credit', 'operating', 50000, {
    day:'2026-10-10', payee:'Service vendor', memo:'ACH CREDIT', category,
  });
  return f;
}
const query = (f, extra={}) => queryMoney(f.env, { sql, ...period, measure:'net_receipts', ...extra }, { now });
async function support(f, extra={}) {
  const r = await query(f, { ...extra, sql:"SELECT txn_uid,income_minor,estimated,estimate_reason FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND income_minor>0" });
  assert.ok(r.rows.length, 'real classified receipt rows reached the membership decision');
  return r.rows;
}
function figure(r, cents) {
  assert.deepEqual(r.rows.map(row => ({ ...row })), [{ currency:'USD', cents }]);
  assert.ok(r.confidence.reasons.length);
  assert.ok(r.confidence.missing.length);
}
function unread(r, cents, partyAmounts=[cents]) {
  figure(r, cents);
  assert.ok(r.confidence.percent < 90, r.confidence_text);
  assert.match(r.confidence.reasons.join(' '), /earlier history was not read/);
  for(const minor of partyAmounts)assert.ok(r.confidence.reasons.some(reason => reason.includes(`USD $${(minor / 100).toLocaleString('en-US', { minimumFractionDigits:2 })}`)),
    'the unread-history reason names each party contribution');
  assert.equal(partyAmounts.reduce((n,v)=>n+v,0),cents,'all provisional dollars are disclosed');
  assert.match(r.confidence.missing.join(' '), /full history|earlier purchase/);
}

test('RLL-01: confirmed income cannot bypass an unread supplier purchase', async t => {
  const f = book(t, { purchaseDay:'2026-09-10' });
  const classified = await support(f, window);
  assert.equal(classified.find(r => r.txn_uid === 'credit').estimated, 0,
    'the stale code acquired a certificate before the missing history was checked');
  const r = await query(f, window);
  t.diagnostic(`bounded supplier credit: ${r.confidence_text}`);
  unread(r, 150000, [100000,50000]); // Independent operating receipts are 100000; retain the provisional cash figure.
  assert.ok(f.calls.some(s => s.includes("'2026-09-25'")), 'the actual six-day matching read was reached');
});

test('RLL-01 High control: ordinary customer receipts with all history read retain High', async t => {
  const f = book(t), classified = await support(f);
  assert.equal(classified[0].estimated, 0);
  const r = await query(f);
  figure(r, 100000);
  assert.equal(r.confidence.percent, 95);
});

test('RLL-01 nearby purchase: read supplier evidence retains the figure below High', async t => {
  const f = book(t, { purchaseDay:'2026-09-28' });
  const classified = await support(f, window), credit = classified.find(r => r.txn_uid === 'credit');
  assert.equal(credit.income_minor, 50000);
  assert.equal(credit.estimated, 1, 'the matching margin reached contrary supplier membership');
  assert.match(credit.estimate_reason, /vendor|return/);
  const r = await query(f, window);
  figure(r, 150000);
  assert.ok(r.confidence.percent < 90, r.confidence_text);
  assert.match(r.confidence_text, /500\.00/);
});

test('RLL-01 all-history read: the older supplier purchase defeats the income certificate', async t => {
  const f = book(t, { purchaseDay:'2026-09-10' });
  const classified = await support(f), credit = classified.find(r => r.txn_uid === 'credit');
  assert.equal(credit.income_minor, 50000);
  assert.equal(credit.estimated, 1, 'the older purchase reached contrary supplier membership');
  assert.match(credit.estimate_reason, /vendor|return/);
  const r = await query(f);
  figure(r, 150000);
  assert.ok(r.confidence.percent < 90, r.confidence_text);
  assert.match(r.confidence_text, /500\.00/);
});

for (const category of ['CLIENT_INCOME', 'INCOME', 'INTEREST_INCOME', 'sales revenue']) {
  test(`RLL-01 ${category}: category spelling cannot certify unread party history`, async t => {
    const f = book(t, { category });
    assert.equal((await support(f, window))[0].estimated, 0, 'confirmed code decision was reached');
    const r = await query(f, window);
    unread(r, 100000);
    const green = await query(f);
    figure(green, 100000);
    assert.equal(green.confidence.percent, 95, 'reading the history preserves the ordinary High control');
  });
}

test('RLL-01: a 90-day read cannot certify a supplier history that includes older purchases', async t => {
  const f = book(t, { purchaseDay:'2026-02-10', coverageFrom:'2026-01-01' });
  const wider = { from:'2026-06-01', through:period.period_to };
  assert.equal((await support(f, wider)).find(r => r.txn_uid === 'credit').estimated, 0);
  unread(await query(f, wider), 150000, [100000,50000]);
  const all = await query(f);
  figure(all, 150000);
  assert.ok(all.confidence.percent < 90, all.confidence_text);
  assert.equal((await support(f)).find(r => r.txn_uid === 'credit').estimated, 1);
});
