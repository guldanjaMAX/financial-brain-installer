import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { run, proposeExpectations } from '../src/lib/money-tools/expected_income.js';
import { parseContract, dollars } from '../src/lib/money-tools/_expected-income-helpers.js';

const range = { from: '2026-10-01', to: '2026-10-31' };
test('ready-to-say dollar amounts preserve cents over the full supported integer range', () => {
  assert.equal(dollars(Number.MAX_SAFE_INTEGER), '$90,071,992,547,409.91');
  assert.equal(dollars(101), '$1.01');
});
function expectation(f, overrides = {}) {
  const e = { id: 'contract-one', client: 'Client One', amount_minor: 10000, cadence: 'monthly',
    start_on: '2026-10-01', end_on: null, source_document_id: 'document-one',
    source_title: 'Service contract', source_date: '2026-09-01', confirmed_by_owner: 1, ...overrides };
  f.raw(`INSERT INTO fin_expectations (${Object.keys(e).join(',')}) VALUES (${Object.keys(e).map(() => '?').join(',')})`, ...Object.values(e));
}
test('cash stays actual; partial deposits reduce likely remaining; uncontracted payers are listed', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.add('one', 'Client One deposit', 'Client One', { cents: 4000 });
  f.add('two', 'Client Two deposit', 'Client Two', { cents: 3000 });
  const r = await run(f.env, range);
  assert.equal(r.ok, true);
  assert.equal(r.figures.already_in_minor, 7000);
  assert.equal(r.figures.likely_remaining_minor, 6000);
  assert.equal(r.figures.likely_total_minor, 13000);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.expectations[0].paid_minor, 4000);
  assert.equal(r.paying_without_contract[0].payee, 'Client Two');
  assert.match(r.say[0], /Likely at least/);
  assert.match(r.say.join(' '), /Service contract.*2026-09-01/);
  assert.ok(r.coverage.accounts.length); assert.ok(r.id);
});
test('no deposit is reused across contracts and monthly occurrences', async t => {
  const f = ledgerFixture(t); expectation(f);
  expectation(f, { id: 'contract-two', source_document_id: 'document-two' });
  f.add('one', 'Client One deposit', 'Client One', { cents: 10000 });
  const r = await run(f.env, { from: '2026-10-01', to: '2026-11-30' });
  assert.equal(r.expectations.length, 4);
  assert.equal(r.expectations.filter(e => e.status === 'paid').length, 0);
  assert.equal(r.expectations.reduce((sum, e) => sum + e.paid_minor, 0), 0);
  assert.equal(r.figures.likely_remaining_minor, 30000);
});
test('unconfirmed, pending, refund, own transfer and uncertain rows never become actual income', async t => {
  const f = ledgerFixture(t); expectation(f, { confirmed_by_owner: 0 });
  for (const [uid, description] of [['pending', 'deposit'], ['refund', 'refund'], ['own', 'transfer from my account'], ['uncertain', 'deposit']]) {
    f.add(uid, description, 'Client One', { cents: 10000 });
  }
  f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='pending'");
  f.raw("UPDATE fin_transactions SET basis_state='proposed' WHERE txn_uid='uncertain'");
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 0);
  assert.equal(r.figures.likely_remaining_minor, 0);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.left_out.reduce((s, b) => s + b.total_minor, 0), 40000);
});
test('missing coverage and invalid dates downgrade without stopping the answer', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.raw("UPDATE fin_account_coverage SET coverage_status='partial'");
  const r = await run(f.env, range);
  assert.equal(r.ok, true); assert.equal(r.expectations[0].status, "can't tell");
  assert.ok(r.coverage.missing.length);
  const invalid = await run(f.env, { from: '2026-02-30', to: '2026-01-01' });
  assert.equal(invalid.ok, true); assert.ok(invalid.say.length);
});
test('month end anniversaries do not drift and end date is inclusive', async t => {
  const f = ledgerFixture(t); expectation(f, { start_on: '2026-01-31', end_on: '2026-03-31' });
  const r = await run(f.env, { from: '2026-02-01', to: '2026-04-30' });
  assert.deepEqual(r.expectations.map(e => e.due_on), ['2026-02-28', '2026-03-31']);
});
test('extracts proposals through existing search, exact readback and idempotent replay, never confirms', async t => {
  const f = ledgerFixture(t);
  f.raw(`INSERT INTO sources (name,kind,created_at) VALUES ('contract-fixture','upload',1)`);
  f.raw(`INSERT INTO documents (doc_uid,source,source_id,title,document_date,date_reliable,ingested_at,content_hash)
    VALUES ('document-one','contract-fixture','one','Service contract',?,1,1,'synthetic')`, Date.parse('2026-09-01'));
  f.raw(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
    VALUES ('chunk-one','document-one',0,?,'contract-fixture','Service contract',?)`,
    'Service contract\nClient: Client One\nAmount: USD 100.00\nCadence: monthly\nStart: 2026-10-01\nEnd: 2027-09-30', Date.parse('2026-09-01'));
  const a = await proposeExpectations(f.env, {});
  assert.equal(a.proposals.length, 1); assert.equal(a.proposals[0].amount_minor, 10000);
  assert.equal(a.proposals[0].confirmed_by_owner, 0);
  await proposeExpectations(f.env, {});
  assert.equal(f.first('SELECT count(*) n FROM fin_expectations').n, 1);
  assert.equal(f.first('SELECT confirmed_by_owner n FROM fin_expectations').n, 0);
  f.raw('UPDATE fin_expectations SET confirmed_by_owner=1');
  await proposeExpectations(f.env, {});
  assert.equal(f.first('SELECT confirmed_by_owner n FROM fin_expectations').n, 1);
});

test('uncertain payee deposits cannot be counted twice as cash plus expected money', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.add('one', 'payment from Client One', null, { cents: 10000 });
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 10000);
  assert.equal(r.figures.likely_remaining_minor, 0);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.figures.unattributed_deposits_minor, 10000);
  assert.match(r.say[0], /Likely at least/);
});
test('a database failure in one account is disclosed and other readable deposits survive', async t => {
  const f = ledgerFixture(t); expectation(f); f.add('one', 'deposit', 'Client One');
  const original = f.env.DB.batch;
  f.env.DB.batch = async statements => {
    if (statements[1].sql.includes('t.pending=1')) throw new Error('synthetic failure');
    return original(statements);
  };
  const r = await run(f.env, range);
  assert.equal(r.ok, true); assert.equal(r.figures.already_in_minor, 2500);
  assert.ok(r.coverage.missing.length);
});
test('contract date is reliable and conditional terms cannot become a fixed expectation', () => {
  const hit = { doc_uid: 'contract', title: 'Contract', document_date: Date.parse('2026-09-01'), date_reliable: 1,
    text: 'Client: Client One\nAmount: USD 100.00\nCadence: monthly\nStart: 2026-10-01\nEnd: none' };
  assert.ok(parseContract(hit));
  assert.equal(parseContract({ ...hit, date_reliable: 0 }), null);
  assert.equal(parseContract({ ...hit, text: hit.text + '\nOnly payable if the project is approved.' }), null);
});
test('unknown amounts and foreign amounts are not presented as a zero USD excluded total', async t => {
  const f = ledgerFixture(t); f.add('one', 'deposit', 'Client One');
  f.raw("UPDATE fin_transactions SET amount_minor=NULL,direction=NULL,basis_state='unparsed',unparsed_reason='synthetic' WHERE txn_uid='one'");
  const r = await run(f.env, range);
  assert.equal(r.left_out[0].unknown_count, 1);
  assert.equal(r.left_out[0].total_minor, null);
});

test('expectation reads are tenant isolated and missing contract income never becomes zero cash', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.raw("UPDATE fin_expectations SET tenant_id='other'");
  const r = await run(f.env, range);
  assert.equal(r.expectations.length, 0); assert.equal(r.figures.likely_total_minor, 0);
});
test('database rejects fractional amounts, impossible dates and implicit confirmation', t => {
  const f = ledgerFixture(t);
  assert.throws(() => expectation(f, { amount_minor: 100.5 }));
  assert.throws(() => expectation(f, { start_on: '2026-02-30' }));
  assert.throws(() => expectation(f, { end_on: '2026-09-30' }));
  assert.throws(() => expectation(f, { confirmed_by_owner: 2 }));
});
test('once, weekly, quarterly and yearly preserve exact integer amounts in future ranges', async t => {
  const f = ledgerFixture(t);
  for (const cadence of ['once', 'weekly', 'quarterly', 'yearly']) expectation(f, { id: cadence, cadence,
    amount_minor: 101, start_on: '2028-02-29', end_on: '2028-03-07' });
  const r = await run(f.env, { from: '2028-02-29', to: '2028-03-07' });
  assert.equal(r.expectations.length, 5); assert.equal(r.figures.likely_remaining_minor, 505);
  assert.equal(r.figures.already_in_minor, 0); assert.equal(r.ok, true);
});
test('proposed account ownership cannot contribute confirmed cash', async t => {
  const f = ledgerFixture(t); f.add('one', 'deposit', 'Client One');
  f.raw("UPDATE fin_accounts SET basis_state='proposed'");
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 0); assert.ok(r.coverage.missing.length);
});
test('uncertain owned entity membership is disclosed alongside the useful answer', async t => {
  const f = ledgerFixture(t); f.add('one', 'deposit', 'Client One');
  f.raw("UPDATE fin_entities SET basis_state='proposed'");
  const r = await run(f.env, range);
  assert.equal(r.ok, true);
  assert.ok(r.coverage.missing.some(line => line.includes('1234')));
});
test('net processor payouts are a separate named bucket, not a paying client', async t => {
  const f = ledgerFixture(t); f.add('payout', 'processor payout', 'Payment Processor');
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 0);
  assert.equal(r.left_out[0].bucket, 'payout');
  assert.equal(r.paying_without_contract.length, 0);
  assert.match(r.say.join(' '), /payout.*25\.00/);
});
test('an unverified deposit makes settlement uncertain while preserving the likely view', async t => {
  const f = ledgerFixture(t); expectation(f); f.add('one', 'deposit', 'Client One', { cents: 10000 });
  f.raw("UPDATE fin_transactions SET basis_state='proposed'");
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.figures.already_in_minor, 0); assert.equal(r.figures.likely_remaining_minor, 10000);
});
test('a partial contract inventory cannot claim a payer has no contract', async t => {
  const f = ledgerFixture(t);
  for (let i = 0; i < 1001; i++) expectation(f, { id: `contract-${String(i).padStart(4, '0')}`, client: `Client ${i}` });
  f.add('one', 'deposit', 'Client 1000');
  const r = await run(f.env, range);
  assert.ok(r.coverage.missing.length); assert.equal(r.paying_without_contract.length, 0);
});
test('an unrepresentable aggregate downgrades the figure and keeps the deposit rows', async t => {
  const f = ledgerFixture(t);
  f.add('one', 'deposit', 'Client One', { cents: Number.MAX_SAFE_INTEGER });
  f.add('two', 'deposit', 'Client Two', { cents: Number.MAX_SAFE_INTEGER });
  const r = await run(f.env, range);
  assert.equal(r.ok, true); assert.equal(r.figures.already_in_minor, null);
  assert.equal(r.rows.length, 2); assert.ok(r.say.length);
});
test('readable accounts share one transaction snapshot per current, pending and historical view', async t => {
  const f = ledgerFixture(t);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('second-account','owner','checking','asset','5678','live','feed','bank-feed:fixture-feed','confirmed','2026-10-01')`);
  f.add('one', 'deposit', 'Client One'); f.add('two', 'deposit', 'Client Two');
  f.raw("UPDATE fin_transactions SET account_slug='second-account' WHERE txn_uid='two'");
  let snapshots = 0;
  const original = f.env.DB.batch;
  f.env.DB.batch = async statements => { snapshots++; return original(statements); };
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 5000);
  assert.equal(snapshots, 3);
});
test('a broken expectation read keeps actual deposits and downgrades only the forecast', async t => {
  const f = ledgerFixture(t); f.add('one', 'deposit', 'Client One');
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => { if (sql.includes('SELECT * FROM fin_expectations')) throw new Error('synthetic database read failure'); return prepare(sql); };
  const r = await run(f.env, range);
  assert.equal(r.ok, false); assert.equal(r.figures.already_in_minor, 2500);
  assert.equal(r.figures.likely_remaining_minor, null); assert.equal(r.rows.length, 1);
});
test('an account bound keeps document expectations and is a partial answer rather than a database error', async t => {
  const f = ledgerFixture(t); expectation(f);
  for (let i = 0; i < 200; i++) f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES (?,'owner','checking','asset',?,'live','feed','bank-feed:fixture-feed','confirmed','2026-10-01')`, `account-${i}`, String(2000 + i));
  const r = await run(f.env, range);
  assert.equal(r.ok, true); assert.equal(r.expectations.length, 1);
  assert.equal(r.figures.already_in_minor, null); assert.equal(r.figures.likely_remaining_minor, 10000);
  assert.ok(r.coverage.missing.length);
});
test('a possible bank-name variant does not inflate likely income or prove invoice settlement', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.add('one', 'deposit', 'Client One LLC', { cents: 10000 });
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 10000);
  assert.equal(r.figures.likely_remaining_minor, 0);
  assert.equal(r.figures.likely_upper_minor, 20000);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.paying_without_contract.length, 0);
});
test('possible name variants cannot reduce another client’s unpaid expectation', async t => {
  const f = ledgerFixture(t); expectation(f);
  expectation(f, { id: 'contract-two', client: 'Client Two', source_document_id: 'document-two' });
  f.add('one', 'deposit', 'Client One', { cents: 10000 });
  f.add('extra', 'deposit', 'Client One LLC', { cents: 5000 });
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 15000);
  assert.equal(r.figures.likely_remaining_minor, 10000);
});
test('ordinary fixed-fee contract clauses propose terms without requiring machine field labels', () => {
  const hit = { doc_uid: 'document-one', title: 'Service agreement', date_reliable: 1,
    document_date: Date.parse('2026-09-01'),
    text: 'Service agreement\nClient One will pay USD 125.25 per month from 2026-10-01 through 2027-09-30.' };
  const e = parseContract(hit);
  assert.equal(e?.client, 'Client One'); assert.equal(e?.amount_minor, 12525);
  assert.equal(e?.cadence, 'monthly'); assert.equal(e?.confirmed_by_owner, 0);
  assert.equal(parseContract({ ...hit, text: hit.text + '\nClient Two shall pay USD 10.00 weekly from 2026-10-01 through 2026-11-01.' }), null);
});
test('client deposits in an owned personal account remain actual income', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.raw("UPDATE fin_entities SET kind='person'");
  f.add('one', 'client deposit', 'Client One', { cents: 10000 });
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 10000);
  assert.equal(r.figures.likely_remaining_minor, 0);
  assert.equal(r.expectations[0].status, 'paid');
  assert.equal(r.rows[0].side, 'personal');
});
test('an unexplained credit on a liability account is not cash received', async t => {
  const f = ledgerFixture(t);
  f.raw("UPDATE fin_accounts SET account_kind='card',balance_role='liability'");
  f.add('one', 'merchant credit', 'Seller', { cents: 10000 });
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 0);
  assert.equal(r.left_out[0].total_minor, 10000);
});

test('EI-01: two monthly deposits add a separate likely income line without becoming cash', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 1480000, start_on: '2026-11-01', source_title: 'Owner confirmed note', source_date: '2026-11-01' });
  f.add('prior-one', 'company deposit', 'Company One', { date: '2026-09-14', cents: 500000 });
  f.add('prior-two', 'company deposit', 'Company One', { date: '2026-10-15', cents: 500000 });
  const r = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.figures.already_in_minor, 0);
  assert.equal(r.figures.likely_total_minor, 1980000);
  assert.equal(r.recurring_income[0].remaining_minor, 500000);
  assert.equal(r.recurring_income[0].evidence.length, 2);
  assert.match(r.say.join(' '), /Company One.*14.*15.*two months|Company One.*14.*15.*2 months/);
  assert.match(r.say.join(' '), /Owner.confirmed.*2026-11-01/i);
});

test('EI-01: recurring deposits do not duplicate a contract or cash already received', async t => {
  const f = ledgerFixture(t);
  expectation(f, { client: 'Company One', amount_minor: 500000, start_on: '2026-11-01' });
  for (const [uid, date] of [['prior-one', '2026-09-14'], ['prior-two', '2026-10-15'], ['current', '2026-11-14']])
    f.add(uid, 'company deposit', 'Company One', { date, cents: 500000 });
  const r = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.figures.likely_total_minor, 500000);
  assert.equal(r.recurring_income.length, 0);
  f.raw('DELETE FROM fin_expectations');
  const received = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(received.figures.already_in_minor, 500000);
  assert.equal(received.figures.likely_remaining_minor, 0);
});

test('EI-02: September invoice payment does not settle October obligation', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 100000, start_on: '2026-09-01' });
  f.add('late', 'September invoice payment', 'Client One', { date: '2026-10-03', cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.notEqual(r.expectations[0].status, 'paid');
  assert.equal(r.figures.already_in_minor, 100000);
  assert.equal(r.figures.likely_remaining_minor, 100000);
  assert.equal(r.figures.likely_total_minor, 200000);
});

test('EI-02: payer identity alone cannot prove which month was settled', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 100000, start_on: '2026-09-01' });
  f.add('ambiguous', 'invoice payment', 'Client One', { cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.figures.likely_total_minor, 100000);
  assert.equal(r.figures.likely_upper_minor, 200000);
});

test('EI-02: explicit current invoice month can settle a continuing expectation', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 100000, start_on: '2026-09-01' });
  f.add('current', 'October 2026 invoice payment', 'Client One', { cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].status, 'paid');
  assert.equal(r.figures.likely_remaining_minor, 0);
});

test('EI-01: unconfirmed proposals cannot erase an evidenced monthly deposit', async t => {
  const f = ledgerFixture(t);
  expectation(f, { client: 'Company One', confirmed_by_owner: 0, amount_minor: 500000, start_on: '2026-11-01' });
  f.add('prior-one', 'company deposit', 'Company One', { date: '2026-09-14', cents: 500000 });
  f.add('prior-two', 'company deposit', 'Company One', { date: '2026-10-15', cents: 500000 });
  const r = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.figures.likely_total_minor, 500000);
});

test('EI-01: stale, irregular, pending and own-transfer histories cannot seed likely income', async t => {
  const f = ledgerFixture(t);
  for (const [payer, dates, cents, description] of [
    ['Stale Company', ['2026-07-14', '2026-08-15'], [500000, 500000], 'deposit'],
    ['Irregular Company', ['2026-09-14', '2026-10-15'], [500000, 10000], 'deposit'],
    ['Pending Company', ['2026-09-14', '2026-10-15'], [500000, 500000], 'deposit'],
    ['Owned Company', ['2026-09-14', '2026-10-15'], [500000, 500000], 'transfer from my account'],
  ]) for (let i = 0; i < 2; i++) f.add(`${payer}-${i}`, description, payer, { date: dates[i], cents: cents[i] });
  f.raw("UPDATE fin_transactions SET pending=1 WHERE payee='Pending Company'");
  const r = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.figures.likely_total_minor, 0);
  assert.equal(r.recurring_income.length, 0);
});

test('EI-02: ambiguous overlap cannot reuse cash already allocated to another expectation', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 100000, start_on: '2026-09-01' });
  expectation(f, { id: 'contract-two', amount_minor: 100000, start_on: '2026-10-01', source_document_id: 'document-two' });
  f.add('one', 'deposit', 'Client One', { cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 100000);
  assert.equal(r.figures.likely_remaining_minor, 100000);
  assert.equal(r.figures.likely_total_minor, 200000);
});

test('EI-02 R2: processing date cannot override the explicit invoice month', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 100000, start_on: '2026-09-01' });
  f.add('late-processed', 'September invoice payment processed 2026-10-03', 'Client One', { date: '2026-10-03', cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.figures.likely_total_minor, 200000);
});

test('EI-01 R2: possible contract name cannot hide a distinct recurring payer', async t => {
  const f = ledgerFixture(t);
  expectation(f, { client: 'Company One', amount_minor: 100000, start_on: '2026-11-01' });
  f.add('prior-one', 'deposit', 'Company One Services', { date: '2026-09-14', cents: 500000 });
  f.add('prior-two', 'deposit', 'Company One Services', { date: '2026-10-15', cents: 500000 });
  const r = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.figures.likely_total_minor, 600000);
  assert.equal(r.recurring_income.length, 1);
  assert.equal(r.recurring_income[0].possible_contract_overlap, true);
  assert.match(r.say.join(' '), /Company One Services.*possible.*contract/i);
});

test('EI-R1-03: historical row overflow preserves independently readable current cash', async t => {
  const f = ledgerFixture(t);
  f.raw(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
    SELECT 'history-'||x,'fixture-account','2026-09-01',100,'outflow','expense','Seller','feed','bank-feed:fixture-feed','confirmed','2026-10-12' FROM n`);
  f.add('current', 'deposit', 'Company Two', { date: '2026-11-03', cents: 100000 });
  const r = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.figures.already_in_minor, 100000);
  assert.equal(r.figures.likely_total_minor, 100000);
  assert.equal(r.rows.length, 1);
  f.add('overflow', 'expense', 'Seller', { date: '2026-09-01', cents: 100, direction: 'outflow' });
  const partial = await run(f.env, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(partial.figures.already_in_minor, 100000);
  assert.equal(partial.figures.likely_total_minor, 100000);
  assert.ok(partial.coverage.missing.some(line => /Repeating deposit history/.test(line)));
});

test('EI-02 R2: conflicting invoice periods cannot certify even a new expectation', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 100000 });
  f.add('conflicting', 'September invoice for October 2026', 'Client One', { cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.figures.likely_upper_minor, 200000);
});

test('EI-02: absent invoice wording cannot settle a continuing obligation', async t => {
  const f = ledgerFixture(t);
  expectation(f, { amount_minor: 100000, start_on: '2026-09-01' });
  f.add('no-period', 'Bank deposit', 'Client One', { cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.figures.likely_total_minor, 100000);
  assert.equal(r.figures.likely_upper_minor, 200000);
});

for (const memo of ['Invoice: September 2026', 'Invoice \u2014 September 2026', 'Invoice #123 September 2026']) {
  test(`EI-02 R3: unsupported invoice evidence never certifies settlement: ${memo}`, async t => {
    const f = ledgerFixture(t);
    expectation(f, { amount_minor: 100000 });
    f.add('prior-period', memo, 'Client One', { date: '2026-10-03', cents: 100000 });
    const r = await run(f.env, range);
    assert.equal(r.expectations[0].paid_minor, 0);
    assert.notEqual(r.expectations[0].status, 'paid');
    assert.equal(r.figures.already_in_minor, 100000);
    assert.equal(r.figures.likely_upper_minor ?? r.figures.likely_total_minor, 200000);
    if (memo === 'Invoice: September 2026') assert.equal(r.figures.likely_total_minor, 200000);
    else {
      assert.equal(r.expectations[0].status, "can't tell");
      assert.equal(r.figures.likely_total_minor, 100000);
      assert.equal(r.figures.possible_overlap_minor, 100000);
    }
  });
}

for (const memo of [
  'Invoice October 2026 USD 100.00; Invoice #123 September 2026 USD 900.00',
  'Invoice October 2026; Invoice #123 September 2026',
  'Invoice October 2026; Invoice October 2026',
  'Invoice October 2026 USD 100.00; Invoice September 2026 USD 900.00',
]) test(`structural settlement: mixed evidence stays uncertain: ${memo}`, async t => {
  const f = ledgerFixture(t); expectation(f, { amount_minor: 100000 });
  f.add('mixed', memo, 'Client One', { date: '2026-10-03', cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.figures.likely_upper_minor, 200000);
  assert.equal(r.figures.likely_total_minor, 100000);
  assert.equal(r.figures.likely_remaining_minor, 0);
  assert.equal(r.expectations[0].remaining_minor, 100000);
  assert.match(r.expectations[0].reason, /mixed|unclear/i);
});

for (const amounts of [[4000], [4000, 6000], [10000, 1000], [11000]])
  test(`structural settlement: partial or multiple deposits cannot certify paid: ${amounts}`, async t => {
    const f = ledgerFixture(t); expectation(f);
    amounts.forEach((cents, i) => f.add(`partial-${i}`, 'October 2026 invoice payment', 'Client One', { cents }));
    const r = await run(f.env, range);
    assert.equal(r.expectations[0].status, "can't tell");
    assert.ok(r.expectations[0].reason);
    assert.ok(r.say.some(line => line.includes("can't tell") && line.includes(r.expectations[0].reason)));
  });

test('structural settlement: a memo partial allocation cannot certify the whole deposit', async t => {
  const f = ledgerFixture(t); expectation(f, { amount_minor: 100000 });
  f.add('partial-memo', 'Invoice October 2026 USD 100.00; balance unallocated', 'Client One', { cents: 100000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.figures.likely_upper_minor, 200000);
});
for (const memo of ['Invoice October 2026 and September 2026', 'October 2026 invoice; remainder for earlier services'])
  test(`structural settlement: unclassified memo text cannot prove settlement: ${memo}`, async t => {
    const f = ledgerFixture(t); expectation(f, { amount_minor: 100000 });
    f.add('mixed-clause', memo, 'Client One', { cents: 100000 });
    const r = await run(f.env, range);
    assert.equal(r.expectations[0].status, "can't tell");
    assert.equal(r.expectations[0].paid_minor, 0);
    assert.equal(r.figures.likely_upper_minor, 200000);
  });
for (const memo of ['partial payment', 'September services payment'])
  test(`structural settlement: new expectation does not override memo uncertainty: ${memo}`, async t => {
    const f = ledgerFixture(t); expectation(f);
    f.add('unclear', memo, 'Client One', { cents: 10000 });
    const r = await run(f.env, range);
    assert.equal(r.expectations[0].status, "can't tell");
    assert.equal(r.expectations[0].paid_minor, 0);
  });

test('structural settlement: complete accounts with no matching deposit say not yet and why', async t => {
  const f = ledgerFixture(t); expectation(f);
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].status, 'not yet');
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.match(r.expectations[0].reason, /No matching deposit/);
  assert.ok(r.say.some(line => line.includes('not yet') && line.includes(r.expectations[0].reason)));
  assert.equal(r.figures.already_in_minor, 0);
  assert.equal(r.figures.likely_remaining_minor, 10000);
});

for (const weekly of [false, true])
  test(`structural settlement: one deposit cannot identify competing obligations: weekly=${weekly}`, async t => {
    const f = ledgerFixture(t); expectation(f, weekly ? { cadence: 'weekly' } : {});
    if (!weekly) expectation(f, { id: 'contract-two', source_document_id: 'document-two' });
    f.add('competing', 'October 2026 invoice payment', 'Client One', { cents: 10000 });
    const r = await run(f.env, range);
    assert.ok(r.expectations.every(e => e.status === "can't tell"));
    assert.equal(r.expectations.reduce((sum, e) => sum + e.paid_minor, 0), 0);
  });

for (const bucket of ['refund', 'pending', 'unverified', 'payout'])
  test(`structural settlement: excluded ${bucket} evidence cannot certify full settlement`, async t => {
    const f = ledgerFixture(t); expectation(f);
    f.add('clear', 'October 2026 invoice payment', 'Client One', { cents: 10000 });
    f.add('other', bucket === 'refund' ? 'refund' : bucket === 'payout' ? 'processor payout' : 'deposit', 'Client One',
      { cents: 10000, direction: bucket === 'refund' ? 'outflow' : 'inflow' });
    if (bucket === 'pending') f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='other'");
    if (bucket === 'unverified') f.raw("UPDATE fin_transactions SET basis_state='proposed' WHERE txn_uid='other'");
    const r = await run(f.env, range);
    assert.equal(r.expectations[0].status, "can't tell");
    assert.equal(r.expectations[0].paid_minor, 0);
    assert.equal(r.figures.likely_upper_minor, 20000);
    assert.equal(r.figures.likely_total_minor, 10000);
    assert.ok(r.left_out.some(b => b.bucket === bucket));
  });

test('structural settlement: a possible payer name on a refund preserves uncertainty', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.add('clear', 'October 2026 invoice payment', 'Client One', { cents: 10000 });
  f.add('refund-name', 'refund', 'Client One LLC', { cents: 10000, direction: 'outflow' });
  const r = await run(f.env, range);
  assert.equal(r.expectations[0].status, "can't tell");
  assert.equal(r.expectations[0].paid_minor, 0);
  assert.equal(r.figures.likely_upper_minor, 20000);
});

for (const cadence of ['weekly', 'once'])
  test(`structural settlement: a month-only invoice cannot resolve a partial-month ${cadence} window`, async t => {
    const f = ledgerFixture(t); expectation(f, { cadence, start_on: cadence === 'weekly' ? '2026-10-01' : '2026-10-22' });
    f.add('month-only', 'October 2026 invoice payment', 'Client One', { date: '2026-10-23', cents: 10000 });
    const r = await run(f.env, { from: '2026-10-20', to: '2026-10-26' });
    assert.equal(r.expectations.length, 1);
    assert.equal(r.expectations[0].status, "can't tell");
    assert.equal(r.expectations[0].paid_minor, 0);
    assert.equal(r.figures.likely_upper_minor, 20000);
  });

test('structural settlement: one weekly due in a complete invoice month can still be paid', async t => {
  const f = ledgerFixture(t); expectation(f, { cadence: 'weekly', start_on: '2026-10-29', end_on: '2026-10-31' });
  f.add('single-week', 'October 2026 invoice payment', 'Client One', { date: '2026-10-30', cents: 10000 });
  const r = await run(f.env, range);
  assert.equal(r.expectations.length, 1);
  assert.equal(r.expectations[0].status, 'paid');
});


test('COV-01 minimized: currency-review inventory is not coverage of a cash read', async t => {
  const f = ledgerFixture(t);
  f.raw('DELETE FROM fin_transactions');
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,source_feed,basis_state,recorded_at,currency)
    VALUES ('review','owner','checking','asset','5678','Tester reserve','live','feed','bank-feed:fixture-feed','confirmed','2026-10-12','EUR')`);
  f.add('unit', 'Synthetic receipt', 'Client One', { cents: 1, date: '2026-10-01' });
  expectation(f);
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 1);
  assert.deepEqual(r.coverage.accounts.map(a => a.account_mask), ['1234']);
  assert.match(r.say.join('\n'), /Coverage: 1 connected accounts/);
  assert.match(r.say.join('\n'), /5678 needs feed or currency review/);
});


test('COV-01 fallback: a history-only account is not counted as current cash coverage', async t => {
  const f = ledgerFixture(t); expectation(f);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,source_feed,basis_state,recorded_at,currency)
    VALUES ('unread','owner','checking','asset','5678','Tester reserve','live','feed','bank-feed:fixture-feed','confirmed','2026-10-12','USD')`);
  f.add('unit', 'Synthetic receipt', 'Client One', { cents: 1, date: '2026-10-01' });
  const original = f.env.DB.batch;
  f.env.DB.batch = async statements => {
    const transaction = statements.find(s => /JOIN fin_transactions/.test(s.sql));
    if (transaction && transaction.sql.includes('t.pending=0') && transaction.params[2] === range.from &&
        JSON.parse(transaction.params[0]).some(m => m.effective === 'unread')) throw new Error('synthetic unavailable read');
    return original(statements);
  };
  const r = await run(f.env, range);
  assert.equal(r.figures.already_in_minor, 1);
  assert.deepEqual(r.coverage.accounts.map(a => a.account_mask), ['1234']);
  assert.match(r.say.join('\n'), /5678 could not be read completely/);
  assert.match(r.say.join('\n'), /Coverage: 1 connected accounts/);
});
