import test from 'node:test';
import assert from 'node:assert/strict';
import { queryMoney, handleMoneyQuery } from '../src/lib/money-query.js';
import { overviewMoney } from '../src/lib/money-overview.js';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { MONEY_GUIDE, MONEY_TOOLS } from '../src/lib/money-query-contract.js';

const STAMP = '2025-12-31T18:00:00Z';
const NOW = Date.parse(STAMP);
const SQL = "SELECT SUM(amount_minor) AS paid_minor FROM txn WHERE posted_on BETWEEN '2025-01-01' AND '2025-12-31' AND direction='outflow'";
const payment = (extra = {}) => ({ source_ref: 'payment-email-fixture', paid_on: '2025-03-14',
  amount_minor: 73500, currency: 'USD', direction: 'outflow', ...extra });

function book(t, { provider = 'plaid', requestedDays = 730, state = 'complete', history = 'HISTORICAL_UPDATE_COMPLETE', opening = null } = {}) {
  const f = overviewFixture(t);
  f.account('deposit', 'live'); f.connection('deposit', provider);
  f.run('UPDATE bank_feed_items SET last_synced_at=?', STAMP);
  f.coverage('deposit', '2025-11-18', '2025-12-31');
  f.row('posted-payment', 'deposit', '2025-11-18', 184500, 'outflow', { description: 'Services purchase' });
  f.run("UPDATE fin_transactions SET payee='Service vendor' WHERE txn_uid='posted-payment'");
  f.run("UPDATE fin_transactions SET category='PURCHASE',category_basis_state='confirmed'");
  f.row('opening-proof', 'deposit', '2025-11-18', 1, 'inflow', { description: 'OPENING DEPOSIT' });
  f.run("UPDATE fin_transactions SET category='OWNER_CONTRIBUTION',category_basis_state='confirmed' WHERE txn_uid='opening-proof'");
  if (opening) f.run('UPDATE fin_accounts SET opened_on=?', opening);
  f.run(`INSERT INTO bank_feed_backfill(item_ref,requested_days,state,queued_at,finished_at,provider_history_state)
    VALUES ('deposit',?,?,?, ?,?)`, requestedDays, state, STAMP, state === 'complete' ? STAMP : null, history);
  return { ...f, read: (payment_evidence) => queryMoney(f.env, { sql: SQL, ...(payment_evidence === undefined ? {} : { payment_evidence }) }, { now: () => NOW }) };
}

test('confirmed explicit account lifetime is a green control through real SQL and overview', async t => {
  const f = book(t, { opening: '2025-11-18' });
  const result = await f.read();
  assert.equal(result.rows[0].paid_minor, 184500);
  assert.equal(result.confidence.percent, 95);
  const overview = await overviewMoney(f.env, { now: () => NOW });
  assert.deepEqual(overview.accounts[0].gaps, []);
  assert.equal(overview.confidence.percent, 89, 'the compound overview has no allow-listed SQL certificate');
  assert.match(overview.confidence.reasons.join(' '), /query shape not certified/);
});

for (const provider of ['plaid', 'simplefin']) test(`${provider}: completed history and opening wording cannot prove the account lifetime`, async t => {
  const f = book(t, { provider });
  const result = await f.read();
  assert.equal(result.rows[0].paid_minor, 184500, 'real SQL returned the posted amount');
  assert.ok(f.calls.some(sql => sql.includes("'confidence_accounts'")), 'safe history projection was reached');
  assert.equal(result.confidence.percent,64);
  assert.match(result.confidence.missing.join(' '),/2025-01-01.*2025-11-17/);
  const overview = await overviewMoney(f.env, { now: () => NOW });
  assert.equal(overview.accounts[0].row_count,2);
  assert.ok(overview.accounts[0].gaps.length,'the unknown lifetime reaches the coverage decision');
  assert.ok(overview.confidence.percent<90);
  assert.equal(overview.accounts[0].account_start,null);
  if(provider==='simplefin')assert.match(overview.confidence.reasons.join(' '),/pending not collected/);
  f.run("UPDATE fin_accounts SET opened_on='2025-11-18'");
  assert.equal((await f.read()).confidence.percent,95,'independent owner opening date supplies the green control');
});

test('truncated requested history retains a real gap and its exact start date', async t => {
  const f = book(t,{opening:'2025-11-18'});
  assert.equal((await f.read()).confidence.percent, 95, 'earlier-window green control');
  f.run('UPDATE fin_accounts SET opened_on=NULL');
  f.run('UPDATE bank_feed_backfill SET requested_days=44'); // Inclusive start equals first posting.
  const result = await f.read();
  assert.equal(result.rows[0].paid_minor, 184500, 'truncated arm still ran the money query');
  assert.ok(result.confidence.percent < 90);
  assert.match(result.confidence.reasons.join(' '), /bank history only starts 2025-11-18/);
  assert.match(result.confidence.missing.join(' '), /2025-01-01.*2025-11-17/);
  const overview = await overviewMoney(f.env, { now: () => NOW });
  assert.ok(overview.accounts[0].gaps.length, 'overview also reaches the gap decision');
  assert.ok(overview.confidence.percent < 90);
});

test('an earlier requested window without completed readable history cannot erase a gap', async t => {
  const f = book(t,{opening:'2025-11-18'});
  assert.equal((await f.read()).confidence.percent, 95, 'completed control');
  f.run('UPDATE fin_accounts SET opened_on=NULL');
  for (const update of ["state='running'", "state='complete',provider_history_state='INITIAL_UPDATE_COMPLETE'",
    "provider_history_state='HISTORICAL_UPDATE_COMPLETE',unread_lines=1"]) {
    f.run('UPDATE bank_feed_backfill SET ' + update);
    const result = await f.read();
    assert.equal(result.rows[0].paid_minor, 184500);
    assert.ok(result.confidence.percent < 90, update);
    assert.match(result.confidence.reasons.join(' '), /bank history only starts 2025-11-18/, 'the history decision, rather than an optional-read failure, lowered the score');
  }
});

test('explicit earlier opening and gaps after the inferred start remain missing history', async t => {
  const f = book(t,{opening:'2025-11-18'});
  assert.equal((await f.read()).confidence.percent, 95, 'owner-recorded opening green control');
  f.run("UPDATE fin_accounts SET opened_on='2025-01-01'");
  const explicit = await f.read();
  assert.ok(explicit.confidence.percent < 90, 'an explicit earlier opening wins over inference');
  assert.match(explicit.confidence.missing.join(' '), /2025-01-01.*2025-11-17/);
  f.run('UPDATE fin_accounts SET opened_on=NULL');
  f.run("UPDATE fin_account_coverage SET covered_from='2025-11-20'");
  const result = await f.read();
  assert.equal(result.row_count, 1);
  assert.ok(result.confidence.percent < 90, 'a gap inside the account lifetime remains a gap');
  assert.match(result.confidence.missing.join(' '), /2025-01-01.*2025-11-19/);
});

test('payment-email example: March document and November account identify an unconnected paying account', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const f = book(t,{opening:'2025-11-18'});
  const control = await f.read();
  assert.equal(control.confidence.percent, 95);
  const evidence = payment({ account_name: 'Prior card', account_last4: '6789' });
  const result = await f.read([evidence]);
  assert.equal(result.rows[0].paid_minor, 184500, 'document figure is never added to bank SQL');
  assert.ok(result.confidence.percent < 90);
  assert.match(result.confidence.reasons.join(' '), /this payment came from an account or card that is not connected/);
  assert.match(result.confidence.reasons.join(' '), /735\.00.*2025-03-14|2025-03-14.*735\.00/);
  assert.match(result.confidence.reasons.join(' '), /Prior card.*6789/);
  assert.match(result.confidence.missing.join(' '), /Prior card.*6789/);
  assert.doesNotMatch(result.confidence.missing.join(' '), /bank history/i);
  assert.doesNotMatch(result.confidence.reasons.join(' '), /without confirmed complete coverage|bank history only starts/);
  assert.deepEqual((await f.read([evidence])).confidence, result.confidence, 'same evidence produces same score');
  const http = await handleMoneyQuery(f.env, new Request('https://brain.invalid/api/admin/brain/money-query', {
    method: 'POST', body: JSON.stringify({ sql: SQL, payment_evidence: [evidence] }),
  }));
  const body = await http.json();
  assert.equal(http.status, 200);
  assert.deepEqual(body.confidence, result.confidence, 'HTTP uses the same computed score');
  const remote = await handleMcp(f.env, new Request('https://brain.invalid/mcp', { method: 'POST', body: JSON.stringify({
    id: 1, method: 'tools/call', params: { name: 'brain_money_query', arguments: { sql: SQL, payment_evidence: [evidence] } },
  }) }), new URL('https://brain.invalid/mcp'), { grant: { profile: 'owner-assistant' } });
  const rpc = await remote.json();
  assert.notEqual(rpc.result.isError, true);
  assert.deepEqual(JSON.parse(rpc.result.content[0].text).confidence, result.confidence, 'remote tool uses the same computed score');
});

test('payment absent during an existing account lifetime names the unknown paying account', async t => {
  const f = book(t, { opening: '2025-11-18' });
  assert.equal((await f.read()).confidence.percent, 95);
  const result = await f.read([payment({ paid_on: '2025-12-10' })]);
  assert.equal(result.row_count, 1, 'the posted bank aggregate is available');
  assert.ok(result.confidence.percent < 90);
  assert.match(result.confidence.reasons.join(' '), /this payment came from an account or card that is not connected/);
  assert.match(result.confidence.missing.join(' '), /account or card.*2025-12-10/);
  assert.doesNotMatch(result.confidence.missing.join(' '), /bank history/i);
});

test('a matching bank candidate prevents the missing-account claim but cannot certify document facts at High', async t => {
  const f = book(t, { opening: '2025-11-18' });
  const evidence = payment({ paid_on: '2025-11-18', amount_minor: 184500, account_last4: '1234' });
  assert.equal((await f.read()).confidence.percent, 95, 'bank-only control');
  const result = await f.read([evidence]);
  assert.equal(result.rows[0].paid_minor, 184500);
  assert.doesNotMatch(result.confidence.reasons.join(' '), /this payment came from an account or card that is not connected/);
  assert.ok(result.confidence.percent < 90, 'date and amount equality alone cannot certify a document reconciliation');
  assert.match(result.confidence.missing.join(' '), /reconcil/i);
  const wrongCard = await f.read([{ ...evidence, account_last4: '6789' }]);
  assert.match(wrongCard.confidence.reasons.join(' '), /this payment came from an account or card that is not connected/);
});

test('pending, removed, wrong-currency and opposite-direction rows cannot corroborate a payment', async t => {
  const f = book(t, { opening: '2025-11-18' });
  assert.equal((await f.read()).confidence.percent, 95);
  f.row('pending', 'deposit', '2025-12-10', 73500, 'outflow', { pending: true });
  f.row('removed', 'deposit', '2025-12-10', 73500, 'outflow', { removed: true });
  f.row('currency', 'deposit', '2025-12-10', 73500, 'outflow', { currency: 'CAD' });
  f.row('direction', 'deposit', '2025-12-10', 73500, 'inflow');
  const result = await f.read([payment({ paid_on: '2025-12-10' })]);
  assert.equal(result.rows[0].paid_minor, 258000, 'real bank SQL retains only its applicable posted rows');
  assert.match(result.confidence.reasons.join(' '), /this payment came from an account or card that is not connected/);
});

test('pre-opening periods cost no account-days while the document payment remains answerable', async t => {
  const f = book(t, { opening: '2025-11-18' });
  assert.equal((await f.read()).confidence.percent, 95);
  const result = await queryMoney(f.env, { sql: SQL.replace('2025-01-01', '2025-03-01').replace('2025-12-31', '2025-03-31'),
    payment_evidence: [payment()] }, { now: () => NOW });
  assert.equal(result.row_count, 1, 'the pre-opening aggregate executed');
  assert.equal(result.rows[0].paid_minor, null, 'no bank amount is invented');
  assert.match(result.confidence.reasons.join(' '), /this payment came from an account or card that is not connected/);
  assert.doesNotMatch(result.confidence.reasons.join(' '), /bank history|without confirmed complete coverage/);
});

test('invalid document evidence lowers confidence without discarding the bank answer', async t => {
  const f = book(t, { opening: '2025-11-18' });
  assert.equal((await f.read()).confidence.percent, 95);
  const result = await f.read([payment({ paid_on: 'invalid' })]);
  assert.equal(result.rows[0].paid_minor, 184500);
  assert.equal(result.confidence.percent, 0);
  assert.match(result.confidence.reasons.join(' '), /Document payment evidence has an invalid or incomplete/);
  assert.match(result.confidence.missing.join(' '), /payment document/);
});

test('document evidence without a comparable clean snapshot cannot inherit an unrelated score', async t => {
  const f = book(t,{opening:'2025-11-18'});
  assert.equal((await f.read()).confidence.percent, 95);
  const result = await queryMoney(f.env, { sql: 'SELECT 7 AS available', payment_evidence: [payment()] }, { now: () => NOW });
  assert.equal(result.rows[0].available, 7, 'unsupported scope is still answered');
  assert.equal(result.confidence.percent, 0);
  assert.match(result.confidence.missing.join(' '), /paying account or card/);
});

test('the shared tool contract exposes document payment evidence and the account-start rule', () => {
  const schema = MONEY_TOOLS.find(tool => tool.name === 'brain_money_query').inputSchema.properties.payment_evidence;
  assert.equal(schema.maxItems, 20);
  assert.ok(schema.items.required.includes('source_ref'));
  assert.match(MONEY_GUIDE, /payment_evidence/);
  assert.match(MONEY_GUIDE, /bank history only starts/);
  assert.match(MONEY_GUIDE, /this payment came from an account or card that is not connected/);
});
