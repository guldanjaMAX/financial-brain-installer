import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBankExportImport } from '../src/lib/fin-import.js';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
import { claimSimpleFinAccess, runSimpleFinMaintenance, assignSimpleFinAccountEntity, simpleFinFeedStatus, promoteSimpleFinWindows } from '../src/lib/simplefin-bank-feed.js';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { maintainAccountKind } from '../src/lib/fin-account-kinds.js';
import { reviewSimpleFinReplacement } from '../src/lib/simplefin-reconciliation.js';
import { maintainSimpleFinCoverage } from '../src/lib/simplefin-coverage-review.js';
import { handleBankFeed } from '../src/lib/bank-feed.js';
import { bindLegacySimpleFinAccount, simpleFinCoverageSummaryStatement } from '../src/lib/simplefin-ledger.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { businessFeed, NOW, epoch, decimal } from './fixtures/simplefin/business-feed.mjs';

// Fixture roles separate gross activity from payment-free activity. The loan
// has reciprocal exact account labels, so its incoming leg leaves activity and
// its principal is disclosed once. The card acknowledgement stays unpaired.
const paymentFreeActivity = data => {
  const month = data.events.filter(row => row.day >= '2026-10-01' && row.day <= '2026-10-31');
  const out = -month.filter(row => row.cents < 0 && ['card_payment','loan_payment'].includes(row.role))
    .reduce((sum,row) => sum + row.cents,0);
  const incoming = month.filter(row => row.cents > 0 && ['card_payment','loan_payment'].includes(row.role))
    .reduce((sum,row) => sum + row.cents,0);
  const unpairedAcknowledgement = month.filter(row => row.cents > 0 && row.role === 'card_payment')
    .reduce((sum,row) => sum + row.cents,0);
  return { credits: data.oracle.credits - incoming, debits: data.oracle.debits - out, excluded: out + unpairedAcknowledgement };
};

async function connected(t, options = {}) {
  t.mock.method(Date,'now',() => Date.parse(NOW));
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = await createProductFixture({ ...options, env: { BANK_FEED_PROVIDER: 'simplefin', BANK_FEED_ENV: 'production',
    BRAIN_TIMEZONE: 'UTC', BANK_FEED_WRAPPING_KEY_V2: `v2.${randomBytes(32).toString('base64url')}` } });
  t.after(() => f.close());
  let claims = 0;
  const access = new URL('https://provider.invalid/feed');
  access.username = randomBytes(8).toString('hex'); access.password = randomBytes(8).toString('hex');
  const claim = await claimSimpleFinAccess(f.env, { requestId: 'business-fixture-claim-0001', now: NOW,
    setupToken: btoa('https://provider.invalid/claim'), fetchImpl: async request => {
      claims++; assert.equal(request.method, 'POST'); return new Response(access.href);
    } });
  assert.equal(claim.status, 201); assert.equal(claims, 1);
  seedOwnedEntity(f, 'owner-business', 'Owner business');
  f.calls = [];
  f.pull = async (payload, now = NOW, filter = false) => {
    f.raw("UPDATE simplefin_connections SET next_pull_at='2000-01-01'");
    return (options.sf?.runSimpleFinMaintenance || runSimpleFinMaintenance)(f.env, { now, maxRequestsPerItem: 1, fetchImpl: async request => {
      const url = new URL(request.url); f.calls.push(url.searchParams);
      assert.equal(url.username, ''); assert.equal(url.password, '');
      const value = structuredClone(payload);
      if (filter) for (const account of value.accounts) account.transactions = account.transactions.filter(row =>
        row.pending || row.posted >= Number(url.searchParams.get('start-date')) && row.posted < Number(url.searchParams.get('end-date')));
      return Response.json(value);
    } });
  };
  f.finishBackfill = async (payload, now = NOW) => {
    for (let n=0; f.first('SELECT backfill_next<=backfill_end pending FROM simplefin_connections').pending; n++) {
      assert.ok(n<12, 'bounded real historical requests');
      assert.equal((await f.pull(payload, now, true)).items[0].ok, true);
    }
    assert.equal(f.first('SELECT state FROM bank_feed_backfill').state, 'complete');
    f.backfillCallCount = f.calls.length;
  };
  f.assign = async () => {
    for (const [i, row] of f.rows('SELECT account_ref FROM simplefin_account_assignments').entries()) {
      const result = await assignSimpleFinAccountEntity(f.env, { request_id: `business-assignment-${row.account_ref}`,
        account_ref: row.account_ref, entity_slug: 'owner-business' }, { now: NOW });
      assert.equal(result.body.ok, true);
    }
  };
  f.reviewCalls = 0;
  f.review = async (body, now = NOW, expectedStatus = 200) => {
    const headers = await f.ownerHeaders();
    const path = '/api/bank-feed/simplefin/review';
    const request = new Request(`https://brain.invalid${path}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    f.reviewCalls++;
    const response = await handleBankFeed(f.env,request,new URL(request.url),path,{bankFeedNow:now});
    const value = await response.json();
    assert.equal(response.status,expectedStatus,JSON.stringify(value));
    return value;
  };
  f.ask = async (question, now = NOW) => {
    const before = f.first('SELECT total_changes() n').n;
    const sqlBefore = f.seen.sql.length;
    const result = await (options.answer || withLedgerAnswer)({ env: f.env, question, now: Date.parse(now), grantScope: { all: true }, scopePrincipalKind: 'owner' },
      async gap => Response.json({ answer: null, gaps: gap ? [gap] : [], citations: [] }));
    const body = await result.json();
    assert.equal(f.first('SELECT total_changes() n').n, before, 'money answers are read only');
    const parsed = classifyLedgerQuestion(question, { now: Date.parse(now) });
    if (parsed.kind) assert.ok(f.seen.sql.slice(sqlBefore).some(sql => /FROM fin_accounts/.test(sql)), 'real inventory decision reached');
    else assert.equal(body.gaps?.[0]?.reason, 'ledger_wording_unsupported', 'real classifier refusal reached');
    return body;
  };
  return f;
}

test('SF business: exclusive end bound includes the closing second and initial pull starts with recent history', async t => {
  const f = await connected(t), data = businessFeed();
  const cursor = f.first('SELECT backfill_next FROM simplefin_connections').backfill_next;
  assert.equal((await f.pull(data.response, NOW, true)).items[0].ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(Number(f.calls[0].get('end-date')), epoch('2026-11-05') - 43200);
  assert.equal(f.calls[0].get('start-date'), String(epoch('2026-08-07') - 43200));
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 0, 'assignment is still required');
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_stage_transactions').n, data.oracle.count);
  await f.assign();
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1500);
  assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next, cursor,
    'the first recent window cannot certify older history');
});

test('SF business: pending rows are excluded beside posted controls; replacement posts once under a new id', async t => {
  const f = await connected(t), data = businessFeed();
  const pending = await f.pull(data.pending);
  assert.equal(f.calls.length, 1, 'pending response reached the adapter');
  assert.equal(pending.items[0].ok, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_stage_transactions').n, 1499,
    'posted control is staged while the pending authorization is excluded');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 0);
  f.raw('UPDATE bank_feed_items SET last_synced_at=NULL');
  assert.equal((await f.pull(data.response)).items[0].ok, true, 'posted replacement is the green control');
  await f.assign();
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1500);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id='temporary-authorization'").n, 0);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id='posted-replacement'").n, 1);
});

test('SF business: current structured and legacy reauthentication errors remain readable and block history progress', async t => {
  const f = await connected(t), data = businessFeed();
  const start = f.first('SELECT backfill_next FROM simplefin_connections').backfill_next;
  for (const value of [data.reauth, { ...data.response, errlist: [], errors: ['Reconnect the credit institution to resume updates.'] }]) {
    const result = await f.pull(value);
    assert.equal(result.items[0].partial, true);
    assert.deepEqual((await simpleFinFeedStatus(f.env)).connections[0].provider_errors, ['Reconnect the credit institution to resume updates.']);
    assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next, start);
  }
  assert.equal(f.calls.length, 2);
  assert.equal((await f.pull(data.response)).items[0].partial, false, 'clear response is the green control');
});

test('SF business: optional transactions and legacy org are accepted without inventing currency or a balance date', async t => {
  const f = await connected(t), data = businessFeed();
  const account = { ...data.response.accounts[0], org: { name: 'Deposit Institution' } };
  delete account.transactions;
  assert.equal((await f.pull({ accounts: [account], errors: [] })).items[0].ok, true);
  assert.equal(f.first('SELECT institution_label FROM simplefin_account_assignments').institution_label, 'Deposit Institution');
  for (const invalid of [{ ...account, currency: 'custom-currency' }, { ...account, 'balance-date': null }]) {
    const result = await f.pull({ accounts: [{ ...invalid, transactions: [] }], errlist: [] });
    assert.equal(result.items[0].code, 'simplefin_response_invalid');
  }
  assert.equal(f.calls.length, 3, 'both invalid account decisions were reached');
});

test('SF business: omitted available balance means the stated balance; malformed dates never become epoch zero', async t => {
  const f = await connected(t), data = businessFeed();
  const value = structuredClone(data.response);
  value.accounts[0].transactions[0].posted = null;
  assert.equal((await f.pull(value)).items[0].ok, true);
  await f.assign();
  assert.equal(f.first("SELECT available_minor FROM fin_balance_snapshots z JOIN fin_accounts a ON a.account_slug=z.account_slug WHERE a.label='Business Savings'").available_minor, 1900520);
  const unread = f.first('SELECT posted_on,basis_state FROM fin_transactions WHERE external_id=?', value.accounts[0].transactions[0].id);
  assert.equal(unread.posted_on, null);
  assert.equal(unread.basis_state, 'unparsed');
  const valid = await f.pull(data.response);
  assert.equal(valid.items[0].ok, true, 'usable posted timestamp repairs the same identity');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE basis_state=\'unparsed\'').n, 0);
});

test('SF business: retained staging with no balance timestamp cannot manufacture a current balance', async t => {
  const f = await connected(t), data = businessFeed();
  await f.pull(data.response);
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_stage_accounts').n, 4, 'real staging decision reached');
  // Model a pre-fix response already durable in the synthetic database.
  f.raw(`UPDATE simplefin_stage_accounts SET balance_epoch=NULL WHERE provider_account_id IN
    (SELECT provider_account_id FROM simplefin_account_assignments WHERE source_account_id='operating')`);
  await f.assign();
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, data.oracle.count, 'usable transaction control still promotes');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_balance_snapshots').n, 3, 'only the three dated balances are publishable');
});

test('SF business: stable transaction ids update amounts and dates; reversals, refunds and signed card deltas survive', async t => {
  const f = await connected(t), data = businessFeed();
  await f.pull(data.response); await f.assign();
  const corrected = structuredClone(data.response);
  const row = corrected.accounts[0].transactions.find(row => row.id === 'target-payment');
  row.amount = '1234.57'; row.posted = epoch('2026-10-24');
  assert.equal((await f.pull(corrected)).items[0].ok, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1500);
  assert.deepEqual({ ...f.first("SELECT raw_amount_minor,posted_on FROM fin_transactions WHERE external_id='target-payment'") }, { raw_amount_minor: 123457, posted_on: '2026-10-24' });
  for (const [id, cents, direction] of [['reversed-charge', -7999, 'outflow'], ['charge-reversal', 7999, 'inflow'], ['card-payment-in', 85000, 'inflow']]) {
    const saved = f.first('SELECT raw_amount_minor,direction FROM fin_transactions WHERE external_id=?', id);
    assert.equal(saved.raw_amount_minor, cents); assert.equal(saved.direction, direction);
  }
  assert.equal(f.first('SELECT COUNT(DISTINCT institution) n FROM fin_accounts').n, 2);
});

test('SF business: every stored cent and monthly gross total matches the independent event oracle', async t => {
  const f = await connected(t), data = businessFeed();
  await f.pull(data.response, NOW, true); await f.assign();
  const actual = f.rows(`SELECT a.label,t.external_id,t.posted_on,t.raw_amount_minor,t.amount_minor,t.direction
    FROM fin_transactions t JOIN fin_accounts a ON a.account_slug=t.account_slug`);
  assert.equal(actual.length, data.events.length);
  const byId = new Map(data.events.map(row => [row.id, row]));
  for (const row of actual) {
    const expected = byId.get(row.external_id);
    assert.ok(expected); assert.equal(row.raw_amount_minor, expected.cents);
    assert.equal(row.amount_minor, Math.abs(expected.cents)); assert.equal(row.posted_on, expected.day);
    assert.equal(row.direction, expected.cents < 0 ? 'outflow' : 'inflow');
  }
  const month = actual.filter(row => row.posted_on >= '2026-10-01' && row.posted_on <= '2026-10-31');
  assert.equal(month.filter(row => row.direction === 'inflow').reduce((n,row) => n+row.amount_minor, 0), data.oracle.credits);
  assert.equal(month.filter(row => row.direction === 'outflow').reduce((n,row) => n+row.amount_minor, 0), data.oracle.debits);
});

test('SF business: refresh overlaps two days after verified backfill and the 24 request budget covers history plus refresh', async t => {
  const f = await connected(t), data = businessFeed();
  await f.pull(data.response); await f.assign();
  await f.finishBackfill(data.response);
  await f.pull(data.response);
  assert.equal(f.calls.at(-1).get('start-date'), String(epoch('2026-11-02') - 43200));
  for (let n = f.calls.length; n < 24; n++) assert.equal((await f.pull(data.response)).items[0].ok, true);
  assert.equal(f.first('SELECT requests_today n FROM simplefin_connections').n, 24);
  assert.equal((await f.pull(data.response)).items[0].code, 'simplefin_daily_request_limit');
  assert.equal(f.calls.length, 24, 'refusal followed 24 real dispatches');
  assert.equal((await f.pull(data.response, '2026-11-05T12:00:00Z')).items[0].ok, true, 'next day resets budget');
});

export const QUESTION_GROUPS = [
  ['What is in each account right now?', 'What are my account balances?', 'Show my current balances', 'How much is in each account?'],
  ['Show my last 10 transactions', 'What were my last 10 transactions?', 'My last 10 transactions', 'List my last 10 transactions'],
  ['How much money came in last month?', 'Money in last month', 'Show money in last month', 'What was my money in last month?'],
  ['How much money went out last month?', 'Money out last month', 'Show money out last month', 'What was my money out last month?'],
  ['What were my 5 biggest expenses last month?', 'Show my 5 largest expenses last month', 'My top 5 expenses last month', 'List my 5 biggest expenses last month'],
  ['Did the payment of $1234.56 arrive around October 23, 2026?', 'Did $1234.56 arrive around October 23, 2026?', 'Did I receive $1234.56 around October 23, 2026?', 'Was a payment of $1234.56 received around October 23, 2026?'],
];

test('SF business: day-one wording reaches the exact ledger intent, with restriction controls', () => {
  const expected = ['balance', 'transactions', 'totals', 'totals', 'largest', 'payment'];
  for (const [index, group] of QUESTION_GROUPS.entries()) for (const question of group) {
    const kind = classifyLedgerQuestion(question, { now: Date.parse(NOW) }).kind;
    // The existing natural "went out" form selects ordinary expenses;
    // explicit money-out forms retain the gross movement view.
    assert.ok(kind === expected[index] || index === 3 && kind === 'expense_summary', question);
  }
  for (const question of ['What is in each account next year?', 'How much is in each account in 2024?',
    'Did I receive $1234.56 before October 23, 2026?', 'Money in last month excluding refunds']) {
    assert.equal(classifyLedgerQuestion(question, { now: Date.parse(NOW) }).kind, null, question);
  }
});

test('SF business: incomplete provider history refuses totals before independent certification', async t => {
  const f = await connected(t), data = businessFeed();
  data.response.errlist = [{ code: 'con.incomplete', msg: 'Incomplete transaction listing. Try again later.' }];
  await f.pull(data.response, NOW, true); await f.assign();
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, data.oracle.count);
  const scores = { RIGHT: 0, PARTLY: 0, 'honest-refusal': 0, WRONG: 0 };
  const renderedCents = answer => [...answer.matchAll(/(-?)\$([\d,]+)\.(\d{2})/g)]
    .map(match => (match[1] ? -1 : 1) * (Number(match[2].replaceAll(',', '')) * 100 + Number(match[3])));
  for (const [group, wordings] of QUESTION_GROUPS.entries()) for (const wording of wordings) {
    const body = await f.ask(wording);
    let score = 'honest-refusal';
    if (body.ledger) {
      const ledger = body.ledger;
      if (group === 0) {
        assert.deepEqual(ledger.accounts.map(row => row.current_minor).sort((a,b) => a-b), [...data.oracle.balances].sort((a,b) => a-b));
        assert.ok(ledger.accounts.some(row => row.as_of === '2026-10-10'), 'old balance date remains visible');
        assert.deepEqual(renderedCents(body.answer).sort((a,b) => a-b), [...data.oracle.balances].sort((a,b) => a-b));
        assert.match(body.answer, /recorded balances/); score = 'PARTLY';
      } else if (group === 1) {
        assert.equal(ledger.kind, 'transactions'); assert.equal(ledger.rows.length, 10);
        const expected = data.events.filter(row => row.day === '2026-11-04').map(row => Math.abs(row.cents));
        assert.ok(ledger.rows.every(row => expected.includes(row.amount_minor)), 'latest receipts match fixture cents'); score = 'PARTLY';
        assert.deepEqual(renderedCents(body.answer), ledger.rows.map(row => row.direction === 'outflow' ? -row.amount_minor : row.amount_minor));
      } else if (group === 5 && ledger.found === true) {
        assert.ok(body.citations.some(row => row.amount_minor === data.oracle.payment)); score = 'RIGHT';
      } else if (group === 2 || group === 3 || group === 4) {
        assert.equal(ledger.complete, false, 'unreviewed types and partial history cannot certify full money totals');
        score = 'PARTLY';
      } else assert.fail(`unexpected ledger result for question group ${group}`);
    } else {
      assert.ok(body.gaps?.length, 'refusal contains a reason');
      assert.ok(body.gaps[0].reason === 'coverage_review_required',
        `only the measured coverage or account-type refusal is acceptable: ${JSON.stringify(body.gaps)}`);
      assert.equal(body.answer, null, 'refusal cannot print an unsupported figure');
    }
    assert.equal(score, group < 2 ? 'PARTLY' : 'honest-refusal', 'ingest-only coverage cannot inherit the later synthetic certificate');
    scores[score]++;
    t.diagnostic(JSON.stringify({ group: group + 1, wording, score, reason: body.gaps?.[0]?.reason ?? null }));
  }
  assert.deepEqual(scores, { RIGHT: 0, PARTLY: 8, 'honest-refusal': 16, WRONG: 0 });
  // An explicit owner review is a separate product path, never a guessed kind.
  for (const [index, account] of f.rows('SELECT account_slug,label FROM fin_accounts ORDER BY id').entries()) {
    const kind = /Checking/.test(account.label) ? 'checking' : /Savings/.test(account.label) ? 'savings' : /Card/.test(account.label) ? 'card' : 'loan';
    const preview = await maintainAccountKind(f.env, { selector: account.account_slug, kind, now: NOW });
    assert.ok(preview.plan_hash, `review ${index} reached preview`);
    const result = await maintainAccountKind(f.env, { selector: account.account_slug, kind, now: NOW, dryRun: false, approve: preview.plan_hash });
    assert.equal(result.complete, true);
  }
  // The corrected response and an independent owner comparison establish the
  // green arithmetic control through the product route, without a SQL certificate.
  data.response.errlist = [];
  assert.equal((await f.pull(data.response, NOW, true)).items[0].ok, true);
  await reviewCoverage(f);
  const incoming = await f.ask('How much money came in last month?');
  assert.equal(incoming.ledger?.combined_inflow_minor, data.oracle.credits);
  assert.equal(incoming.ledger.lead_accounts.reduce((n,a) => n + a.credits_minor,0), data.oracle.ordinaryCredits);
  const outgoing = await f.ask('Show money out last month including transfers');
  assert.equal(outgoing.ledger?.accounts.reduce((n,row) => n+row.debits_minor, 0), paymentFreeActivity(data).debits);
  assert.equal(outgoing.ledger.payment_exclusions.total_minor, paymentFreeActivity(data).excluded);
  const largest = await f.ask(QUESTION_GROUPS[4][0]);
  assert.deepEqual(largest.ledger?.lead_rows.map(row => row.amount_minor), data.oracle.expenses.map(row => -row.cents));
  for (const wording of QUESTION_GROUPS[5]) {
    const found = await f.ask(wording);
    assert.equal(found.ledger?.found, true);
    assert.ok(found.citations.some(row => row.amount_minor === data.oracle.payment));
  }
  const absent = await f.ask('Did the payment of $99999.99 arrive around October 23, 2026?');
  assert.equal(absent.ledger?.found, false, 'green control: certified dates permit a bounded absence');
});

async function reviewKinds(f) {
  for (const account of f.rows('SELECT account_slug,label FROM fin_accounts ORDER BY id')) {
    const kind = /Checking/.test(account.label) ? 'checking' : /Savings/.test(account.label) ? 'savings' : /Card/.test(account.label) ? 'card' : 'loan';
    const preview = await f.review({action:'kind',account_slug:account.account_slug,kind,dry_run:true});
    assert.ok(preview.plan_hash); assert.equal(preview.blocked, false);
    assert.equal((await f.review({action:'kind',account_slug:account.account_slug,kind,dry_run:false,approve:preview.plan_hash})).complete,true);
  }
}

function smallFeed() {
  const value = businessFeed().response;
  value.accounts = value.accounts.slice(0,1);
  value.accounts[0].transactions = [{ id: 'original-posted', posted: epoch('2026-11-03'),
    transacted_at: epoch('2026-11-02'), amount: '-43.21', description: 'Posted purchase', payee: 'Supply Store' }];
  return value;
}

for (const boundary of ['before-lineage', 'after-lineage', 'after-import', 'before-summary']) {
  test(`SF durable recovery: ${boundary} cannot restore an old bank comparison`, async t => {
    for (const interrupted of [false, true]) {
      const f = await connected(t), value = smallFeed();
      await f.pull(value); await f.assign(); await reviewKinds(f);
      await reviewCoverage(f, '2026-11-01', '2026-11-04');
      assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_coverage_reviews WHERE revoked_at IS NULL').n, 1);
      assert.equal((await f.ask('Show money out this month')).ledger?.accounts[0].debits_minor, 4321);
      await f.finishBackfill(value);
      value.accounts[0].transactions[0].id = 'replacement-posted';
      const batch = f.env.DB.batch.bind(f.env.DB);
      let reached = 0;
      f.env.DB.batch = async statements => {
        const matches = statements.some(s => boundary.includes('lineage')
          ? /INSERT INTO simplefin_transaction_lineage/.test(s.sql)
          : boundary === 'after-import' ? /INSERT INTO fin_transactions/.test(s.sql)
            : /SET state='promoted'/.test(s.sql));
        if (!matches || reached) return batch(statements);
        reached++;
        if (interrupted && ['before-lineage', 'before-summary'].includes(boundary)) throw Error('fixture interruption');
        const result = await batch(statements);
        if (interrupted) throw Error('fixture interruption');
        return result;
      };
      const pull = await f.pull(value);
      f.env.DB.batch = batch;
      assert.equal(reached, 1, 'real durable boundary reached in both arms');
      assert.equal(pull.items[0].ok, !interrupted);
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2, 'both source rows committed');
      assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_coverage_reviews WHERE revoked_at IS NULL').n, 0,
        'affected review invalidated before any imported ledger row can commit');
      if (boundary === 'after-lineage') assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE reviewed_at IS NULL AND revoked_at IS NULL').n, 1);
      if (interrupted) await promoteSimpleFinWindows(f.env, { now: NOW });
      assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE reviewed_at IS NULL AND revoked_at IS NULL').n, 1,
        'replay retains the proposal, including interruption before its insert');
      assert.equal(f.first('SELECT coverage_status FROM fin_account_coverage').coverage_status, 'partial');
      assert.equal((await f.ask('Show money out this month')).gaps?.[0]?.reason, 'period_outside_coverage');
      const proposal = f.first('SELECT account_ref,predecessor_id,successor_id FROM simplefin_transaction_lineage');
      const options = { accountRef: proposal.account_ref, predecessorId: proposal.predecessor_id, successorId: proposal.successor_id, now: NOW };
      const preview = await reviewSimpleFinReplacement(f.env, options);
      assert.equal(preview.blocked, false);
      await reviewSimpleFinReplacement(f.env, { ...options, dryRun: false, approve: preview.plan_hash, confirmSameEvent: true });
      await reviewCoverage(f, '2026-11-01', '2026-11-04');
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n, 1);
      // A coverage review repairs history authority, not a failed institution
      // sync. The interrupted arm needs a successful pull before money returns.
      if (interrupted) {
        const held = await f.ask('Show money out this month');
        assert.equal(held.ledger, undefined);
        assert.match(held.gaps[0].detail, /institution sync error/);
        assert.equal((await f.pull(value)).items[0].ok, true);
      }
      assert.equal((await f.ask('Show money out this month')).ledger?.accounts[0].debits_minor, 4321,
        'fresh explicit review is the green control for every boundary');
    }
  });
}

for (const [field, changed] of [
  ['txn_uid', 'changed-uid'], ['posted_on', '2026-10-31'], ['amount_minor', 4322], ['direction', 'inflow'],
  ['raw_amount_minor', -4322], ['currency', 'EUR'], ['description', 'Changed purchase'], ['payee', 'Changed supplier'],
  ['pending', 1], ['basis_state', 'proposed'], ['removed_at', NOW], ['superseded_by_id', 1],
]) {
  test(`SF certificate facts: changed ${field} refuses until exact facts match`, async t => {
    const f = await connected(t); await f.pull(smallFeed()); await f.assign(); await reviewKinds(f);
    await reviewCoverage(f, '2026-11-01', '2026-11-04');
    const row = f.first('SELECT * FROM fin_transactions');
    const account = f.first('SELECT account_ref,item_ref FROM simplefin_account_assignments');
    const derive = () => simpleFinCoverageSummaryStatement(f.env, { tenantId: 'primary', itemRef: account.item_ref,
      account: { account_ref: account.account_ref, account_slug: row.account_slug }, stamp: NOW }).run();
    if (field === 'removed_at') f.raw("UPDATE fin_transactions SET removal_reason='Synthetic removal'");
    f.raw(`UPDATE fin_transactions SET ${field}=?`, changed);
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_coverage_reviews WHERE revoked_at IS NULL').n, 1,
      'active stale approval reaches the derivation decision');
    await derive();
    assert.equal(f.first('SELECT coverage_status FROM fin_account_coverage').coverage_status, 'partial');
    assert.equal((await f.ask('Show money out this month')).gaps?.[0]?.reason, 'period_outside_coverage');
    f.raw(`UPDATE fin_transactions SET ${field}=?`, row[field]);
    await derive();
    assert.equal((await f.ask('Show money out this month')).ledger?.accounts[0].debits_minor, 4321,
      'green control differs only in the changed fact');
  });
}

test('SF certificate facts: unresolved lineage blocks even an otherwise exact active comparison', async t => {
  const f = await connected(t), value = smallFeed();
  await f.pull(value); await f.assign(); await reviewKinds(f); await reviewCoverage(f, '2026-11-01', '2026-11-04');
  await f.finishBackfill(value);
  value.accounts[0].transactions[0].id = 'replacement-posted'; await f.pull(value);
  const proposal = f.first('SELECT * FROM simplefin_transaction_lineage');
  assert.ok(proposal, 'real proposal decision reached');
  const fields = ['id','txn_uid','posted_on','amount_minor','direction','raw_amount_minor','currency','description','payee','pending','basis_state','removed_at','superseded_by_id'];
  const facts = f.rows('SELECT * FROM fin_transactions ORDER BY id').map(row => fields.map(field => row[field]));
  // A retained active comparison whose rows already match must still fail
  // closed on unresolved identity, independently of the fact-equality gate.
  f.raw('UPDATE simplefin_coverage_reviews SET revoked_at=NULL,transactions_json=?', JSON.stringify(facts));
  const account = f.first('SELECT account_slug FROM fin_accounts');
  await simpleFinCoverageSummaryStatement(f.env, { tenantId: 'primary', itemRef: proposal.item_ref,
    account: { ...account, account_ref: proposal.account_ref }, stamp: NOW }).run();
  assert.equal(f.first('SELECT coverage_status FROM fin_account_coverage').coverage_status, 'partial');
  const options = { accountRef: proposal.account_ref, predecessorId: proposal.predecessor_id, successorId: proposal.successor_id, now: NOW };
  const preview = await reviewSimpleFinReplacement(f.env, options);
  await reviewSimpleFinReplacement(f.env, { ...options, dryRun: false, approve: preview.plan_hash, confirmSameEvent: true });
  await reviewCoverage(f, '2026-11-01', '2026-11-04');
  assert.equal((await f.ask('Show money out this month')).ledger?.accounts[0].debits_minor, 4321);
});

for (const field of ['connection_id', 'source_account_id', 'account_ref']) {
  test(`SF promotion identity: changed ${field} cannot reuse a staged assignment`, async t => {
    const f = await connected(t); await f.pull(smallFeed());
    const original = f.first('SELECT * FROM simplefin_account_assignments');
    f.raw(`UPDATE simplefin_account_assignments SET ${field}=?,entity_slug='owner-business'`,
      field === 'account_ref' ? 'sfa_00000000000000000000000000000001' : 'different-identity');
    const reads = f.seen.sql.length;
    await assert.rejects(promoteSimpleFinWindows(f.env, { now: NOW }), { code: 'simplefin_account_identity_review_required' });
    assert.ok(f.seen.sql.slice(reads).some(sql => /FROM simplefin_stage_accounts s/.test(sql)), 'exact promotion identity decision reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 0);
    f.raw(`UPDATE simplefin_account_assignments SET ${field}=?`, original[field]);
    await promoteSimpleFinWindows(f.env, { now: NOW });
    assert.equal(f.first('SELECT raw_amount_minor FROM fin_transactions').raw_amount_minor, -4321);
  });
}

for (const field of ['connection_id', 'source_account_id', 'account_ref', 'null-connection', 'null-source']) {
  test(`SF conflict boundary: racing ${field} cannot adopt a storage key`, async t => {
    const f = await connected(t), batch = f.env.DB.batch.bind(f.env.DB);
    let reached = 0, expected;
    f.env.DB.batch = async statements => {
      const insert = statements.find(s => /INSERT INTO simplefin_account_assignments/.test(s.sql));
      if (insert && !reached) {
        reached++;
        const p = insert.params;
        expected = { connection_id: p[9], source_account_id: p[10], account_ref: p[3] };
        const conflict = { ...expected, [field]: 'different-identity' };
        if (field === 'account_ref') conflict.account_ref = 'sfa_00000000000000000000000000000001';
        if (field === 'null-connection') conflict.connection_id = null;
        if (field === 'null-source') conflict.source_account_id = null;
        f.raw(`INSERT INTO simplefin_account_assignments
          (tenant_id,item_ref,provider_account_id,account_ref,connection_id,source_account_id,currency,first_seen_at,last_seen_at)
          VALUES (?,?,?,?,?,?,'USD',?,?)`, p[0], p[1], p[2], conflict.account_ref, conflict.connection_id, conflict.source_account_id, NOW, NOW);
      }
      return batch(statements);
    };
    const result = await f.pull(smallFeed()); f.env.DB.batch = batch;
    assert.equal(reached, 1, 'conflict inserted after preflight and before the real UPSERT');
    assert.equal(result.items[0].ok, false);
    assert.equal(f.first('SELECT account_label FROM simplefin_account_assignments').account_label, null,
      'conflicting row metadata was not updated');
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_stage_accounts').n, 0);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 0);
    f.raw('UPDATE simplefin_account_assignments SET connection_id=?,source_account_id=?,account_ref=?',
      expected.connection_id, expected.source_account_id, expected.account_ref);
    assert.equal((await f.pull(smallFeed())).items[0].ok, true, 'exact-identity control differs only in refused identity');
    await f.assign();
    assert.equal(f.first('SELECT raw_amount_minor FROM fin_transactions').raw_amount_minor, -4321);
  });
}

for (const legacyId of ['["connection-b","account-b"]', 'ordinary-legacy', '["","account-b"]', '["connection-b"," account-b "]']) {
  test(`SF storage boundary: schema-0059 identity ${legacyId} remains independent`, async t => {
    const f = await connected(t, { migrationThrough: 59 });
    const item = f.first('SELECT item_ref FROM simplefin_connections').item_ref;
    const ref = 'sfa_00000000000000000000000000000001';
    const slug = `simplefin-${ref.slice(4)}`;
    f.raw(`INSERT INTO simplefin_account_assignments
      (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,currency,first_seen_at,last_seen_at)
      VALUES ('primary',?,?,?,'owner-business','USD',?,?)`, item, legacyId, ref, NOW, NOW);
    // The actual generic importer runs against schema 0059 before upgrade.
    const plan = prepareBankExportImport({ ok: true, format: 'simplefin', signConvention: 'simplefin_negative_amount_is_outflow',
      establishedBy: 'Synthetic signed bank record', sourceDocUid: null, sourceLabel: `bank-feed:${item}`,
      accounts: [{ accountKey: slug, institution: 'Deposit Institution', label: 'Business Checking', mask: null,
        accountKind: 'other', balanceRole: 'neither', currency: 'USD', externalRef: ref,
        periodStart: '2026-11-01', periodEnd: '2026-11-04', ledgerBalanceMinor: 1000, availableBalanceMinor: 1000,
        balanceAsOf: '2026-11-04', transactions: [{ locator: 'simplefin/transaction/txn-1', externalId: 'txn-1',
          postedOn: '2026-11-03', description: 'Posted purchase', payee: 'Supply Store', rawAmountMinor: -1000,
          amountMinor: 1000, direction: 'outflow', pending: false, currency: 'USD', unparsedReason: null }] }] },
      { tenantId: 'primary', entitySlug: 'owner-business', now: NOW, origin: { provenance: 'feed', sourceFeed: `bank-feed:${item}` } });
    assert.equal(plan.receipt.imported, true);
    await f.env.DB.batch(plan.statements.map(([sql, binds]) => f.env.DB.prepare(sql).bind(...binds)));
    f.raw("UPDATE fin_transactions SET source_provider='simplefin'");
    const legacy = f.first('SELECT * FROM simplefin_account_assignments');
    for (const file of ['0060_simplefin_account_identity.sql', '0061_balance_position_evidence.sql'])
      for (const sql of f.splitStatements(readFileSync(new URL(`../../migrations/d1/${file}`, import.meta.url), 'utf8'))) f.raw(sql);
    const value = smallFeed();
    if (legacyId.includes('["",')) delete value.accounts[0].conn_id;
    else value.accounts[0].conn_id = 'connection-b';
    value.accounts[0].id = legacyId.includes(' account-b ') ? ' account-b ' : 'account-b';
    value.accounts[0].transactions[0].id = 'txn-1';
    value.accounts[0].transactions[0].amount = '-20.00';
    const result = await f.pull(value);
    assert.equal(f.calls.length, 1, 'new tuple reaches normal provider staging');
    const unchanged = f.first('SELECT * FROM simplefin_account_assignments WHERE account_ref=?', ref);
    for (const [key, value] of Object.entries(legacy)) assert.equal(unchanged[key], value, `legacy ${key}`);
    assert.equal(f.first('SELECT raw_amount_minor FROM fin_transactions WHERE account_slug=?', slug).raw_amount_minor, -1000);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1, 'new identity has no inherited owner assignment');
    if (!result.items[0].ok) {
      assert.equal(result.items[0].code, 'simplefin_account_identity_review_required');
      // Same response, differing only in the refused account identity.
      value.accounts[0].id = 'noncolliding-control';
      assert.equal((await f.pull(value)).items[0].ok, true);
    }
    const unassigned = f.first('SELECT account_ref FROM simplefin_account_assignments WHERE account_ref<>? AND entity_slug IS NULL', ref);
    assert.ok(unassigned, 'separate owner decision is required');
    assert.equal((await assignSimpleFinAccountEntity(f.env, { request_id: 'separate-assignment-control', account_ref: unassigned.account_ref,
      entity_slug: 'owner-business' }, { now: NOW })).body.ok, true);
    assert.deepEqual(f.rows('SELECT raw_amount_minor FROM fin_transactions ORDER BY raw_amount_minor').map(r => r.raw_amount_minor), [-2000, -1000]);
  });
}

test('SF subset: an explicit warning-free transaction array cannot certify history without source review', async t => {
  const f = await connected(t), value = smallFeed();
  await f.pull(value); await f.assign(); await reviewKinds(f);
  assert.equal(f.calls.length, 1, 'explicit provider subset was promoted');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
  const answer = await f.ask('Show money out this month');
  assert.equal(answer.answer, null);
  assert.equal(answer.gaps[0].reason, 'period_outside_coverage');
});

test('SF identity audit: connection-local account ids remain independent across pulls and within one response', async t => {
  const f = await connected(t), first = smallFeed();
  await f.pull(first); await f.assign();
  const second = structuredClone(first);
  second.accounts[0].conn_id = 'credit-bank'; second.accounts[0].name = 'Separate account';
  second.accounts[0].transactions[0].amount = '999.99';
  await f.finishBackfill(first);
  assert.equal((await f.pull(second)).items[0].ok, true);
  assert.equal(f.calls.length, f.backfillCallCount+1, 'both identities and real backfill decisions reached');
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_account_assignments').n, 2);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1, 'new identity still waits for owner assignment');
  await f.assign();
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n, 2);
  assert.deepEqual(f.rows('SELECT raw_amount_minor FROM fin_transactions ORDER BY raw_amount_minor').map(r => r.raw_amount_minor), [-4321,99999]);
  const both = { ...first, accounts: [...first.accounts,...second.accounts] };
  assert.equal((await f.pull(both)).items[0].ok, true, 'same-response control preserves both tuples');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
});

test('SF rotation audit: a uniquely replaced posted id retains both source rows and counts one event', async t => {
  const f = await connected(t), value = smallFeed();
  await f.pull(value); await f.assign(); await reviewKinds(f);
  await f.finishBackfill(value);
  value.accounts[0].transactions[0].id = 'replacement-posted';
  assert.equal((await f.pull(value)).items[0].ok, true);
  assert.equal(f.calls.length, f.backfillCallCount+1, 'replacement and real backfill observations reached');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2, 'source rows retained');
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE revoked_at IS NULL').n, 1);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n, 2, 'subset only proposes; it cannot decide identity');
  const proposal = f.first('SELECT account_ref,predecessor_id,successor_id FROM simplefin_transaction_lineage');
  const options = { accountRef:proposal.account_ref,predecessorId:proposal.predecessor_id,successorId:proposal.successor_id,now:NOW };
  const preview = await reviewSimpleFinReplacement(f.env,options);
  assert.equal(preview.blocked,false);
  assert.equal((await reviewSimpleFinReplacement(f.env,{...options,dryRun:false,approve:preview.plan_hash,confirmSameEvent:true})).complete,true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n, 1);
  await reviewCoverage(f);
  const answer = await f.ask('Show money out this month');
  assert.equal(answer.ledger?.accounts.reduce((n,a) => n+a.debits_minor,0), 4321);
  assert.equal((await f.pull(value)).items[0].ok, true, 'replacement replay is idempotent');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
});

async function reviewCoverage(f, from='2026-08-07', to='2026-11-04') {
  for (const { account_ref } of f.rows('SELECT account_ref FROM simplefin_account_assignments')) {
    const preview = await f.review({action:'coverage',account_ref,from,to,dry_run:true});
    assert.equal(preview.blocked,false);
    assert.equal((await f.review({action:'coverage',account_ref,from,to,dry_run:false,approve:preview.plan_hash,confirm_source_comparison:true})).complete,true);
  }
}

test('SF first session: completed owner review and covered periods answer all 24 wordings in exact cents', async t => {
  const f = await connected(t), data = businessFeed();
  assert.equal((await f.pull(data.response, NOW, true)).items[0].ok, true);
  await f.assign();
  const unreviewed = await f.ask(QUESTION_GROUPS[4][0]);
  assert.equal(unreviewed.gaps?.[0]?.reason, 'period_outside_coverage', 'named account kinds still require independent coverage');
  await reviewKinds(f);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews WHERE revoked_at IS NULL').n, 4);
  // Step 4: the synthetic owner compares the independent bank ledger for these
  // dates, then approves the product's exact coverage preview. No raw SQL certificate.
  await reviewCoverage(f);
  let right = 0;
  for (const [group, wordings] of QUESTION_GROUPS.entries()) for (const wording of wordings) {
    const body = await f.ask(wording), ledger = body.ledger;
    assert.ok(ledger, `${wording}: ${body.gaps?.[0]?.reason}`);
    assert.equal(body.gaps?.length || 0, 0, wording);
    const rendered = [...body.answer.matchAll(/(-?)\$([\d,]+)\.(\d{2})/g)]
      .map(m => (m[1] ? -1 : 1) * (Number(m[2].replaceAll(',', '')) * 100 + Number(m[3])));
    if (group === 0) {
      assert.deepEqual(ledger.accounts.map(a => a.current_minor).sort((a,b) => a-b), [...data.oracle.balances].sort((a,b) => a-b));
      assert.deepEqual(rendered.sort((a,b) => a-b), [...data.oracle.balances].sort((a,b) => a-b));
      assert.ok(ledger.accounts.some(a => a.as_of === '2026-10-10'));
      assert.match(body.answer, /recorded balances/);
    } else if (group === 1) {
      assert.equal(ledger.complete, true); assert.equal(ledger.rows.length, 10);
      const latest = data.events.filter(e => e.day === '2026-11-04');
      for (const row of ledger.rows) assert.ok(latest.some(e => Math.abs(e.cents) === row.amount_minor && e.day === row.posted_on));
      assert.deepEqual(rendered, ledger.rows.map(r => (r.direction === 'outflow' ? -1 : 1) * r.amount_minor));
    } else if (group === 2) {
      const credits = ledger.combined_inflow_minor !== undefined ? data.oracle.credits : paymentFreeActivity(data).credits;
      assert.equal(ledger.accounts.reduce((n,a) => n+a.credits_minor,0), credits);
      if (ledger.combined_inflow_minor !== undefined) {
        assert.equal(ledger.combined_inflow_minor, data.oracle.credits);
        assert.ok(rendered.includes(data.oracle.credits));
        assert.equal(ledger.lead_accounts.reduce((n,a) => n+a.credits_minor,0), data.oracle.ordinaryCredits);
      } else {
        for (const a of ledger.accounts) assert.ok(rendered.includes(a.credits_minor));
        const loan = data.events.find(e => e.role === 'loan_payment' && e.cents < 0);
        assert.ok(loan, 'authored loan payment reaches the activity decision');
        assert.equal(ledger.payment_exclusions.loan_minor, -loan.cents);
        const loanRows = ledger.payment_exclusions.rows.filter(row => row.payment_kind === 'loan');
        assert.equal(loanRows.length, 1, 'reciprocal principal is disclosed once');
        assert.equal(loanRows[0].amount_minor, -loan.cents);
        assert.ok(body.citations.some(ref => ref.n === loanRows[0].n && ref.amount_minor === -loan.cents));
        assert.equal(ledger.payment_exclusions.rows.filter(row => row.payment_kind === 'card').length, 2,
          'an unpaired acknowledgement does not become a reciprocal pair');
      }
    } else if (group === 3) {
      if (ledger.kind === 'expense_summary') {
        const expenses = data.events.filter(e => e.day >= '2026-10-01' && e.day <= '2026-10-31' && e.role === 'expense');
        const cents = -expenses.reduce((n,e) => n+e.cents,0);
        assert.equal(ledger.total_minor, cents); assert.ok(rendered.includes(cents));
      } else {
        assert.equal(ledger.accounts.reduce((n,a) => n+a.debits_minor,0), paymentFreeActivity(data).debits);
        for (const a of ledger.accounts) assert.ok(rendered.includes(a.debits_minor));
      }
    } else if (group === 4) {
      assert.equal(ledger.complete, true);
      assert.deepEqual(ledger.lead_rows.map(r => r.amount_minor), data.oracle.expenses.map(e => -e.cents));
      for (const e of data.oracle.expenses) assert.ok(rendered.includes(-e.cents));
    } else {
      assert.equal(ledger.found, true); assert.ok(body.citations.some(c => c.amount_minor === data.oracle.payment));
      assert.ok(rendered.includes(data.oracle.payment));
    }
    right++; t.diagnostic(JSON.stringify({ group: group+1, wording, score: 'RIGHT' }));
  }
  assert.equal(right, 24);
  const missing = await f.ask('How much money came in during July 2026?');
  assert.equal(missing.answer, null); assert.equal(missing.gaps[0].reason, 'period_outside_coverage');
  assert.equal((await f.ask('Did the payment of $99999.99 arrive around October 23, 2026?')).ledger?.found, false);
});


test('SF coverage review: missing arrays, unread data, stale approval and absent source comparison fail closed', async t => {
  const f=await connected(t),value=smallFeed();
  delete value.accounts[0].transactions;
  await f.pull(value);await f.assign();await reviewKinds(f);
  const ref=f.first('SELECT account_ref FROM simplefin_account_assignments').account_ref;
  const options={accountRef:ref,from:'2026-10-01',to:'2026-10-31',now:NOW};
  const missing=await maintainSimpleFinCoverage(f.env,options);
  assert.equal(missing.blocked,true);assert.equal(missing.transaction_count,0);
  assert.ok(f.seen.sql.some(sql => /simplefin_account_windows/.test(sql)), 'window decision reached');
  value.accounts[0].transactions=[];
  await f.pull(value);
  const empty=await maintainSimpleFinCoverage(f.env,options);
  assert.equal(empty.blocked,false,'explicit empty listing is eligible for owner comparison');
  await assert.rejects(maintainSimpleFinCoverage(f.env,{...options,dryRun:false,approve:empty.plan_hash}),/Compare the bank history/);
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_coverage_reviews').n,0);
  value.accounts[0].transactions=smallFeed().accounts[0].transactions;
  value.accounts[0].transactions[0].posted=epoch('2026-10-20');
  f.raw('UPDATE bank_feed_items SET last_synced_at=NULL');
  await f.pull(value);
  await assert.rejects(maintainSimpleFinCoverage(f.env,{...options,dryRun:false,approve:empty.plan_hash,confirmSourceComparison:true}),/Compare the bank history/);
  const current=await maintainSimpleFinCoverage(f.env,options);
  assert.equal(current.transaction_count,1);
  assert.equal((await maintainSimpleFinCoverage(f.env,{...options,dryRun:false,approve:current.plan_hash,confirmSourceComparison:true})).complete,true);
  assert.equal((await f.ask('Show money out last month')).ledger?.accounts.reduce((n,a)=>n+a.debits_minor,0),4321);
  value.accounts[0].transactions[0].amount='-43.22';
  f.raw('UPDATE bank_feed_items SET last_synced_at=NULL');await f.pull(value);
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_coverage_reviews WHERE revoked_at IS NULL').n,0,'changed cents revoke the comparison');
  assert.equal((await f.ask('Show money out last month')).gaps[0].reason,'period_outside_coverage');
});

test('SF replacement review: ambiguity, same-day repeats and reappearance preserve economic multiplicity', async t => {
  const f=await connected(t),value=smallFeed();
  value.accounts[0].transactions.push({...value.accounts[0].transactions[0],id:'repeat-posted'});
  await f.pull(value);await f.assign();
  await f.finishBackfill(value);
  value.accounts[0].transactions=[{...value.accounts[0].transactions[0],id:'replacement-posted'}];
  await f.pull(value);
  assert.equal(f.calls.length,f.backfillCallCount+1, 'replacement follows real history decisions');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n,3);
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage').n,0,'ambiguous two-to-one never proposes a merge');
  const g=await connected(t),one=smallFeed();await g.pull(one);await g.assign();
  await g.finishBackfill(one);
  one.accounts[0].transactions[0].id='replacement-posted';await g.pull(one);
  const row=g.first('SELECT * FROM simplefin_transaction_lineage');
  const opts={accountRef:row.account_ref,predecessorId:row.predecessor_id,successorId:row.successor_id,now:NOW};
  const preview=await reviewSimpleFinReplacement(g.env,opts);assert.equal(preview.blocked,false);
  await assert.rejects(reviewSimpleFinReplacement(g.env,{...opts,dryRun:false,approve:preview.plan_hash}),/Compare both bank references/);
  assert.equal(g.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n,2);
  await reviewSimpleFinReplacement(g.env,{...opts,dryRun:false,approve:preview.plan_hash,confirmSameEvent:true});
  one.accounts[0].transactions.push({...one.accounts[0].transactions[0],id:'original-posted'});await g.pull(one);
  assert.equal(g.first('SELECT COUNT(*) n FROM fin_transactions').n,2,'reappearance restores the same durable row');
  assert.equal(g.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n,2);
  assert.equal(g.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE revoked_at IS NULL').n,0);
});

test('SF owner review route: sessions, provider selection and upgrade pause guard all review writes', async t => {
  const f=await connected(t),path='/api/bank-feed/simplefin/review';
  const body={action:'coverage',dry_run:true};
  let calls=0;const original=f.env.DB.prepare;
  f.env.DB.prepare=sql=>{if(/simplefin_coverage_reviews/.test(sql))calls++;return original(sql)};
  const send=async headers=>{const request=new Request(`https://brain.invalid${path}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return handleBankFeed(f.env,request,new URL(request.url),path,{bankFeedNow:NOW})};
  assert.equal((await send({})).status,401);assert.equal(calls,0);
  const headers=await f.ownerHeaders();
  f.env.VECTOR_DRAIN_MODE='paused-for-upgrade';assert.equal((await send(headers)).status,503);
  delete f.env.VECTOR_DRAIN_MODE;f.env.BANK_FEED_PROVIDER='plaid';assert.equal((await send(headers)).status,404);
  f.env.BANK_FEED_PROVIDER='simplefin';assert.equal((await send(headers)).status,409,'authorized malformed request reaches review validation');
  await f.pull(smallFeed());await f.assign();await reviewKinds(f);await reviewCoverage(f);
  assert.ok(calls>0,'green owner control reaches the exact review write path');
});

test('SF coverage review: native D1 binding accepts every constructed statement', async t => {
  const f=await connected(t);await f.pull(smallFeed());await f.assign();
  const original=f.env.DB.prepare;let bindings=0;
  f.env.DB.prepare=sql=>{const statement=original(sql),bind=statement.bind;statement.bind=(...params)=>{
    bindings++;assert.equal(params.includes(undefined),false,'D1 never accepts undefined binds');return bind(...params)};return statement};
  await reviewCoverage(f);assert.ok(bindings>5);
});

test('SF legacy identity: exact approved binding preserves ledger references and existing kind review', async t => {
  const f=await connected(t),value=smallFeed();await f.pull(value);await f.assign();await reviewKinds(f);
  const account=f.first('SELECT * FROM simplefin_account_assignments');
  const original=f.first('SELECT id,account_slug,external_ref FROM fin_accounts');
  const review=f.first('SELECT * FROM fin_account_kind_reviews');
  // Model retained pre-connection keys. No ledger or review is rewritten.
  f.raw('UPDATE simplefin_stage_accounts SET provider_account_id=?',account.source_account_id);
  f.raw('UPDATE simplefin_stage_transactions SET provider_account_id=?',account.source_account_id);
  f.raw('UPDATE simplefin_account_assignments SET provider_account_id=source_account_id,connection_id=NULL');
  f.raw('UPDATE bank_feed_items SET last_synced_at=NULL');
  const refused=await f.pull(value);
  assert.equal(f.calls.length,2);assert.equal(refused.items[0].code,'simplefin_account_identity_review_required');
  assert.deepEqual(f.first('SELECT id,account_slug,external_ref FROM fin_accounts'),original);
  const options={accountRef:account.account_ref,connectionId:'deposit-bank',now:NOW};
  const preview=await bindLegacySimpleFinAccount(f.env,options);assert.equal(preview.blocked,false);assert.equal(preview.mutation_count,0);
  await assert.rejects(bindLegacySimpleFinAccount(f.env,{...options,dryRun:false,approve:'0'.repeat(64)}),/exact owner approval/);
  const result=await bindLegacySimpleFinAccount(f.env,{...options,dryRun:false,approve:preview.plan_hash});
  assert.equal(result.complete,true);
  assert.equal((await bindLegacySimpleFinAccount(f.env,{...options,dryRun:false,approve:preview.plan_hash})).mutation_count,0);
  assert.equal((await f.pull(value)).items[0].ok,true,'fresh exact tuple is the green replay control');
  assert.deepEqual(f.first('SELECT id,account_slug,external_ref FROM fin_accounts'),original);
  assert.deepEqual(f.first('SELECT * FROM fin_account_kind_reviews'),review);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,1);
  const rebind=await bindLegacySimpleFinAccount(f.env,{...options,connectionId:'credit-bank'});
  assert.equal(rebind.blocked,true,'an established tuple cannot be rebound to another connection');
});

test('SF owner page: actual rendered handlers require preview and source comparison before confirming dates', async t => {
  const { default:vm }=await import('node:vm');
  const { simpleFinConnectPageHtml }=await import('../src/lib/simplefin-bank-feed.js');
  const f=await connected(t);await f.pull(smallFeed());await f.assign();
  class Element {
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.textContent='';this.value='';this.style={};this.checked=false}
    append(...values){this.children.push(...values)}
    prepend(...values){this.children.unshift(...values)}
    replaceChildren(...values){this.children=values;this.textContent=''}
    get options(){return this.children.filter(n=>n.tagName==='OPTION')}
    get selectedIndex(){return this.options.findIndex(n=>n.value===this.value)}
  }
  const html=simpleFinConnectPageHtml({}).html,nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element('div')]));
  const all=(node,tag)=>[...(node.tagName===tag?[node]:[]),...node.children.flatMap(n=>all(n,tag))];
  const button=(node,text)=>all(node,'BUTTON').find(n=>n.textContent===text);
  const headers=await f.ownerHeaders(),calls=[];
  const context=vm.createContext({document:{getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag)},
    crypto:{randomUUID:()=> 'ui-fixture-request-0001'},fetch:async(path,init={})=>{
      assert.ok(path.startsWith('/api/'));const request=new Request(`https://brain.invalid${path}`,{...init,headers:{...headers,...init.headers}});
      if(path.endsWith('/simplefin/review'))calls.push(JSON.parse(init.body));
      return path.startsWith('/api/bank-feed/')?handleBankFeed(f.env,request,new URL(request.url),path,{bankFeedNow:NOW}):f.worker.fetch(request,f.env,{});
    }});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context,{timeout:1000});
  // Wait on the rendered state, not a tick count: slower CI runners need more turns for the page's fetch chain.
  for(const end=Date.now()+10000;Date.now()<end && all(nodes.get('reviews'),'ARTICLE').length!==1;)await new Promise(resolve=>setTimeout(resolve,5));
  let card=all(nodes.get('reviews'),'ARTICLE')[0];assert.ok(card,'actual owner inventory populated the review controls');
  const type=all(card,'SELECT')[0];type.value='checking';type.onchange();
  await button(card,'Preview account type').onclick();assert.equal(calls.length,1);assert.equal(calls[0].dry_run,true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n,0);
  await button(card,'Confirm Checking').onclick();assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n,1);
  card=all(nodes.get('reviews'),'ARTICLE')[0];const inputs=all(card,'INPUT');
  inputs[0].value='2026-08-07';inputs[1].value='2026-11-04';
  await button(card,'Preview bank dates').onclick();assert.equal(calls.length,3);
  await button(card,'Confirm compared bank dates').onclick();
  assert.equal(calls.length,3,'unchecked comparison reached Apply but sent no request');
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_coverage_reviews').n,0);
  inputs[2].checked=true;await button(card,'Confirm compared bank dates').onclick();
  assert.equal(calls.length,4);assert.equal(calls[3].confirm_source_comparison,true);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_account_coverage WHERE coverage_status='complete'").n,1);
  assert.equal((await f.ask('Show money out this month')).ledger?.accounts.reduce((n,a)=>n+a.debits_minor,0),4321);
});

test('SF coverage review: older backfill cannot revoke an unchanged reviewed recent period', async t => {
  const f=await connected(t),value=smallFeed();await f.pull(value);await f.assign();await reviewKinds(f);
  await reviewCoverage(f,'2026-10-01','2026-11-04');
  assert.equal((await f.ask('Show money out this month')).ledger?.accounts.reduce((n,a)=>n+a.debits_minor,0),4321);
  f.raw("UPDATE simplefin_connections SET backfill_next='2024-11-05'");
  value.accounts[0].transactions=[{...value.accounts[0].transactions[0],id:'historical-posted',posted:epoch('2024-11-06'),transacted_at:epoch('2024-11-05')}];
  assert.equal((await f.pull(value,NOW,true)).items[0].ok,true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,2,'historical row really promoted');
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_coverage_reviews WHERE revoked_at IS NULL').n,1);
  assert.equal((await f.ask('Show money out this month')).ledger?.accounts.reduce((n,a)=>n+a.debits_minor,0),4321);
});


// Each row uses the real provider, assignment and authenticated review paths.
// Payer words cannot silently select the empty account and certify absence.
function emptyPayerWindow(f, result) {
  assert.equal(result.ledger.kind, 'payment');
  assert.equal(result.ledger.found, null, 'bounded absence does not prove that a payer never paid');
  assert.equal(result.ledger.complete, false);
  assert.equal(result.ledger.total_minor, null);
  assert.equal(result.ledger.amount_minor, 123456);
  assert.equal(result.ledger.match_basis, 'none');
  assert.equal(result.ledger.attribution_incomplete, false);
  assert.deepEqual(result.ledger.amount_candidates, []);
  assert.deepEqual(result.citations, []);
  assert.equal(result.ledger.accounts.length, 1);
  assert.equal(result.ledger.accounts[0].account_mask,
    f.first("SELECT mask FROM fin_accounts WHERE account_kind='card'").mask);
  assert.match(result.answer, /No deposit of \$1,234\.56/);
  assert.doesNotMatch(result.answer, /No charges at|\$0\.00/);
}
const payerCases = [
  ...['checking','savings','card','loan','investment','retirement','escrow'].flatMap(kind =>
    ['from','via'].map(clause => ({ sender:`${kind} supplier`,
      question:`Did I receive $1234.56 ${clause} ${kind} supplier around October 23, 2026?` }))),
  ...['checking','savings','card','investment','retirement','escrow'].map(kind => ({ sender:`${kind} supplier`,
    question:`Did the ${kind} supplier payment of $1234.56 arrive around October 23, 2026?` })),
  ...['arrive','arrived','receive','received','come','came','land','landed','hit','reach','reached','clear','cleared','post','posted']
    .map(verb => ({sender:'card supplier',question:`Did $1234.56 from card supplier ${verb} around October 23, 2026?`})),
  ...['account 1234 supplier','ending 1234 supplier','mask 1234 supplier'].map(sender => ({sender,
    question:`Did I receive $1234.56 from ${sender} around October 23, 2026?`})),
  {sender:'card supplier',question:'Did the deposit of USD 1234.56 from card supplier arrive around October 23, 2026?'},
  {sender:'card supplier',question:'Did the $1234.56 paid from card supplier arrive around October 23, 2026?'},
  {sender:'card supplier',question:'Did the payment of 1234.56 dollars from card supplier arrive around October 23, 2026?'},
  {sender:'savings platform card supplier',question:'Did I receive $1234.56 from card supplier via savings platform around October 23, 2026?'},
  {sender:'CARD SUPPLIER',question:'DID I RECEIVE $1234.56 FROM CARD SUPPLIER AROUND OCTOBER 23, 2026?'},
];
for (const [index,{sender,question}] of payerCases.entries()) {
  test(`SF payer scope: row ${index+1} preserves literal payer evidence`, async t => {
    const f=await connected(t),value=businessFeed().response;
    value.accounts=[value.accounts[0],value.accounts[2]];
    for (const account of value.accounts) account.transactions=[];
    value.accounts[0].transactions=[{id:'payer-receipt',posted:epoch('2026-10-23'),
      transacted_at:epoch('2026-10-23'),amount:'1234.56',description:'Customer receipt',payee:sender}];
    assert.equal((await f.pull(value,NOW,true)).items[0].ok,true);
    await f.assign();await reviewKinds(f);await reviewCoverage(f,'2026-10-01','2026-10-31');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n,2);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,1);
    const ask=async wording=>{
      const start=f.seen.sql.length;
      const result=await f.ask(wording);
      assert.ok(f.seen.sql.slice(start).some(sql=>sql.includes("t.amount_minor = ?5 AND t.direction='inflow'")),
        'payment SQL decision reached, including the absence control');
      assert.equal(result.ledger?.kind,'payment');
      return result;
    };
    // Run all arms even on the red product, so absence cannot pass vacuously.
    const actual=await ask(question);
    const noun=await ask(`Did the payment of $1234.56 from ${sender} arrive around October 23, 2026?`);
    const restricted=await ask(question.replace(/around/i,'into card account around'));
    assert.equal(noun.ledger.found,true,'noun-bearing green control finds the same source receipt');
    assert.equal(noun.ledger.complete,true);
    emptyPayerWindow(f,restricted);
    assert.equal(actual.ledger.found,true,'payer-only words must not certify false absence');
    assert.equal(actual.ledger.complete,true);
    assert.ok(actual.citations.some(row=>row.amount_minor===123456));
    const parsed=classifyLedgerQuestion(question,{now:Date.parse(NOW),timeZone:'UTC'});
    assert.equal(parsed.accountKind,null);assert.equal(parsed.mask,null);
    assert.deepEqual(parsed.counterpartyWords,sender.toLowerCase().match(/[\p{L}\p{N}]+/gu));
  });
}


// Period and payer positions share one expected ledger window. Every row has
// the same receipt, a reordered positive control, and an empty-account arm.
const paymentPeriods = [
  ['last month','2026-10-01','2026-10-31','2026-10-02'],
  ['this month','2026-11-01','2026-11-04','2026-11-02'],
  ['yesterday','2026-11-03','2026-11-03','2026-11-03'],
  ['last 30 days','2026-10-06','2026-11-04','2026-10-07'],
  ['today','2026-11-04','2026-11-04','2026-11-04'],
  ['this week','2026-11-02','2026-11-04','2026-11-02'],
  ['recent','2026-10-22','2026-11-04','2026-10-23'],
  ['October 2026','2026-10-01','2026-10-31','2026-10-02'],
  ...['2026-10-23','October 23, 2026','23 October 2026','10/23/2026'].map(date=>
    [date,'2026-10-16','2026-10-30','2026-10-23',['','on ','around ']]),
];
const paymentForms = [
  ['from',period=>`Did the payment of $1234.56 arrive from card supplier ${period}?`,
    period=>`Did the payment of $1234.56 arrive ${period} from card supplier?`],
  ['via',period=>`Did I receive $1234.56 via card supplier ${period}?`,
    period=>`Did I receive $1234.56 ${period} via card supplier?`],
  ['named',period=>`Did the card supplier payment of $1234.56 arrive ${period}?`,
    period=>`Did the payment of $1234.56 arrive ${period} from card supplier?`],
  ['amountless',period=>`Did the payment arrive from card supplier ${period}?`,
    period=>`Did the payment arrive ${period} from card supplier?`],
];
async function reviewedPayerFixture(t,day='2026-10-02',sender='card supplier',nearby=false) {
  const f=await connected(t),value=businessFeed().response;
  value.accounts=[value.accounts[0],value.accounts[2]];
  for (const account of value.accounts) account.transactions=[];
  value.accounts[0].transactions=[{id:'period-payer-receipt',posted:epoch(day),transacted_at:epoch(day),
    amount:'1234.56',description:'Customer receipt',payee:sender}];
  if(nearby)value.accounts[0].transactions.push({id:'period-other-amount',posted:epoch(day),transacted_at:epoch(day),
    amount:'1234.57',description:'Customer receipt',payee:sender});
  const now='2026-11-04T23:59:59.000Z';
  assert.equal((await f.pull(value,now,true)).items[0].ok,true);
  await f.assign();await reviewKinds(f);await reviewCoverage(f,'2026-10-01','2026-11-04');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n,2);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,nearby?2:1);
  return {f,now};
}
for (const [periodText,from,to,day,prefixes=['','in ','during ','for ','over ','during the ','for the ']] of paymentPeriods) {
  for (const prefix of prefixes) {
    for (const [form,trailing,reordered] of paymentForms) {
      const period=prefix+periodText;
      test(`SF payment spans: ${form} ${period} preserves the requested period`,async t=>{
        const {f,now}=await reviewedPayerFixture(t,day,'card supplier',form!=='amountless');
        const ask=async question=>{
          const start=f.seen.sql.length;
          const result=await f.ask(question,now);
          const reads=f.seen.sql.slice(start).flatMap((sql,index)=>
            sql.includes("t.amount_minor = ?5 AND t.direction='inflow'")?[f.seen.binds[start+index]]:[]);
          assert.ok(reads.length,'payment transaction SQL decision reached');
          // Exact cents are local after the bounded read; retain window admission.
          assert.equal(reads[0][4],null,'complete bounded payment window reached');
          assert.equal(result.ledger?.amount_minor,form==='amountless'?null:123456,'requested cents retained by the payment reader');
          if (result.ledger?.found===false) {
            assert.ok(reads.some(binds=>binds[4]===null),'all-inflow absence recheck reached');
            assert.match(result.answer,/No deposits at all in this period/,'definite absence decision reached');
          }
          if (result.ledger?.found===null) {
            assert.ok(reads.some(binds=>binds[4]===null),'bounded absence uses the all-inflow deciding read');
            emptyPayerWindow(f,result);
          }
          return {result,reads,parsed:classifyLedgerQuestion(question,{now:Date.parse(now),timeZone:'UTC'})};
        };
        // All arms execute before green expectations, retaining the red absence
        // trace and the reordered control from the same provider/owner setup.
        const actual=await ask(trailing(period));
        const control=await ask(reordered(period));
        const restricted=await ask(reordered(period).replace(/arrive|receive/,'$& into card account'));
        for (const arm of [control,actual,restricted]) {
          assert.deepEqual([arm.parsed.from,arm.parsed.to],[from,to]);
          assert.deepEqual(arm.parsed.counterpartyWords,['card','supplier']);
          assert.deepEqual([arm.result.ledger?.from,arm.result.ledger?.to],[from,to]);
          for (const binds of arm.reads) assert.deepEqual(binds.slice(2,4),[from,to]);
        }
        assert.equal(control.result.ledger.found,true,'period-only reorder finds the source receipt');
        assert.equal(actual.result.ledger.found,true,'trailing period finds the source receipt');
        assert.ok(actual.result.citations.some(row=>row.amount_minor===123456&&row.posted_on===day));
        if(form!=='amountless') {
          assert.equal(actual.result.citations.length,1,'nearby same-payer amount cannot enter an exact receipt');
          assert.ok(actual.result.citations.every(row=>row.amount_minor===123456));
          assert.doesNotMatch(actual.result.answer,/1,234\.57/,'other cents remain outside named exact lookup');
        }
        assert.equal(actual.parsed.accountKind,null);assert.equal(actual.parsed.mask,null);
        assert.equal(restricted.parsed.accountKind,'card');
        if(form==='amountless') assert.equal(restricted.result.ledger.found,false,'amountless empty-account control');
        else emptyPayerWindow(f,restricted.result);
      });
    }
  }
}
for (const [index,[question,controlQuestion,sender='card supplier']] of [
  ...['in','during','for','over'].map(preposition=>[
    `Did the payment arrive ${preposition} $1234.56 last month from card supplier?`,
    'Did the payment arrive $1234.56 last month from card supplier?',
  ]),
  [
    "Did the payment of $1234.56 arrive from card supplier last month this month?",
    "Did the payment of $1234.56 arrive from card supplier last month?",
  ],
  [
    "Did the payment of $1234.56 arrive from card supplier recent last month?",
    "Did the payment of $1234.56 arrive from card supplier last month?",
  ],
  [
    "Did the payment of $1234.56 arrive last month from card supplier this month?",
    "Did the payment of $1234.56 arrive last month from card supplier?",
  ],
  [
    "Did the payment of $1234.56 arrive from card supplier last month yesterday?",
    "Did the payment of $1234.56 arrive from card supplier last month?",
  ],
  [
    "Did the payment of $1234.56 arrive from card supplier around October 2, 2026 last month?",
    "Did the payment of $1234.56 arrive from card supplier last month?",
  ],
  [
    "Did the payment of $1234.56 arrive from card supplier last month tomorrow?",
    "Did the payment of $1234.56 arrive from card supplier last month?",
  ],
  [
    "Did the payment of $1234.56 arrive from card supplier last month supplier?",
    "Did the payment of $1234.56 arrive from card supplier last month?",
  ],
  [
    "Did the payment of $1234.56 arrive from card supplier from savings supplier last month?",
    "Did the payment of $1234.56 arrive from card supplier last month?",
  ],
  [
    "Did the payment of $1234.56 arrive from card supplier via savings platform via escrow platform last month?",
    "Did the payment of $1234.56 arrive from card supplier via savings platform last month?",
    "savings platform card supplier",
  ],
].entries()) {
  test(`SF payment spans: ambiguous row ${index+1} refuses before applying a default`,async t=>{
    const {f,now}=await reviewedPayerFixture(t,'2026-10-02',sender);
    const control=await f.ask(controlQuestion,now);
    const start=f.seen.sql.length;
    const actual=await f.ask(question,now);
    assert.equal(actual.gaps?.[0]?.reason,'ledger_wording_unsupported','real classifier refusal reached');
    assert.equal(classifyLedgerQuestion(question,{now:Date.parse(now),timeZone:'UTC'}).kind,null);
    assert.ok(!f.seen.sql.slice(start).some(sql=>sql.includes("t.amount_minor = ?5 AND t.direction='inflow'")));
    assert.equal(control.ledger?.found,true,'unambiguous period is the green control');
  });
}

const receiptTransitions = [
  ['same-day','2026-11-04','2026-11-04','2026-11-03'],
  ['next-day','2026-11-04','2026-11-05','2026-11-03'],
  ['two-days','2026-11-04','2026-11-06','2026-11-04'],
  ['month-boundary','2026-11-30','2026-12-01','2026-11-29'],
  ['year-boundary','2026-12-31','2027-01-01','2026-12-30'],
];
for (const [label,firstDay,secondDay,eventDay] of receiptTransitions) {
  test(`SF receipt transition: ${label} keeps the complete listing receipt coherent`,async t=>{
    const f=await connected(t),value=smallFeed(),at=day=>`${day}T23:59:59.000Z`;
    const from=`${eventDay.slice(0,7)}-01`;
    Object.assign(value.accounts[0].transactions[0],{posted:epoch(eventDay),transacted_at:epoch(eventDay)});
    assert.equal((await f.pull(value,at(firstDay),true)).items[0].ok,true);await f.assign();await reviewKinds(f);
    // Complete historical backfill through maintenance, rather than editing its cursor.
    for (let n=0;f.first('SELECT backfill_next<=backfill_end pending FROM simplefin_connections').pending;n++) {
      assert.ok(n<12,'bounded synthetic historical backfill');
      assert.equal((await f.pull(value,at(firstDay),true)).items[0].ok,true);
    }
    assert.equal(f.first('SELECT state FROM bank_feed_backfill').state,'complete');
    value.accounts[0].transactions[0].id='replacement-posted';
    assert.equal((await f.pull(value,at(firstDay),true)).items[0].ok,true);
    const row=f.first('SELECT * FROM simplefin_transaction_lineage');assert.ok(row);
    const body={action:'replacement',account_ref:row.account_ref,predecessor_id:row.predecessor_id,successor_id:row.successor_id};
    const preview=await f.review({...body,dry_run:true},at(firstDay));assert.equal(preview.blocked,false,'initial receipt is reviewable');
    const calls=f.calls.length,sqlStart=f.seen.sql.length;
    assert.equal((await f.pull(value,at(secondDay),true)).items[0].ok,true);
    assert.equal(f.calls.length,calls+1,'second daily provider request reached');
    const start=new Date(Date.parse(secondDay)-2*86400000).toISOString().slice(0,10);
    assert.equal(f.calls.at(-1).get('start-date'),String(Date.parse(`${start}T00:00:00Z`)/1000));
    assert.equal(f.calls.at(-1).get('end-date'),String(Date.parse(`${secondDay}T00:00:00Z`)/1000+86400));
    assert.ok(f.seen.sql.slice(sqlStart).some(sql=>sql.includes('INSERT INTO simplefin_transaction_lineage') && sql.includes('ON CONFLICT')),
      'existing-pair conflict decision reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage').n,1);
    const fresh=await f.review({...body,dry_run:true},at(secondDay));
    const stale=await f.review({...body,dry_run:false,approve:preview.plan_hash,confirm_same_event:true},at(secondDay),409);
    assert.equal(stale.code,'simplefin_review_required','a genuinely stale preview is refused');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n,2);
    assert.equal(fresh.blocked,false,'current receipt remains reviewable after a refreshed proposal');
    const receipt=f.first(`SELECT l.item_ref,l.window_start,l.window_end,l.revision,w.revision current_revision
      FROM simplefin_transaction_lineage l JOIN simplefin_sync_windows w
        ON w.tenant_id=l.tenant_id AND w.item_ref=l.item_ref AND w.window_start=l.window_start AND w.window_end=l.window_end`);
    assert.equal(receipt.window_start,start);assert.equal(receipt.window_end,secondDay);
    assert.equal(receipt.revision,receipt.current_revision);
    const noCompare=await f.review({...body,dry_run:false,approve:fresh.plan_hash},at(secondDay),409);
    assert.equal(noCompare.code,'simplefin_review_required','same valid receipt without source comparison refuses');
    assert.equal((await f.review({...body,dry_run:false,approve:fresh.plan_hash,confirm_same_event:true},at(secondDay))).complete,true);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,2);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n,1);
    const coverage={action:'coverage',account_ref:row.account_ref,from,to:secondDay};
    const cp=await f.review({...coverage,dry_run:true},at(secondDay));assert.equal(cp.blocked,false);
    await f.review({...coverage,dry_run:false,approve:cp.plan_hash,confirm_source_comparison:true},at(secondDay));
    const month=new Date(`${eventDay}T00:00:00Z`).toLocaleString('en-US',{month:'long',timeZone:'UTC'});
    const question=firstDay.slice(0,7)===secondDay.slice(0,7)?'Show money out this month':`Show money out during ${month} ${eventDay.slice(0,4)}`;
    assert.equal((await f.ask(question,at(secondDay))).ledger?.accounts.reduce((sum,a)=>sum+a.debits_minor,0),4321);
    assert.equal((await f.pull(value,at(secondDay),true)).items[0].ok,true,'same-day approved replay is idempotent');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,2);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n,1);
    // Co-presence differs only by the returned predecessor: it must revoke.
    value.accounts[0].transactions.push({...value.accounts[0].transactions[0],id:'original-posted'});
    assert.equal((await f.pull(value,at(secondDay),true)).items[0].ok,true);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,2);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n,2);
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE revoked_at IS NULL').n,0);
    const coPresent=await f.review({...body,dry_run:true},at(secondDay));assert.equal(coPresent.blocked,true);
    await f.review({...body,dry_run:false,approve:coPresent.plan_hash,confirm_same_event:true},at(secondDay),409);
  });
}

function reviewSignFeed(label, cents = -12537, count = 1) {
  return { errlist: [], accounts: [{ id: 'review-sign-account', conn_id: 'review-sign-bank', name: label,
    currency: 'USD', balance: decimal(cents), 'balance-date': epoch('2026-11-04'),
    transactions: Array.from({ length: count }, (_, index) => ({ id: `old-${index}`,
      posted: epoch('2026-11-03'), transacted_at: epoch('2026-11-02'),
      amount: decimal(-(1111 + index)), description: `Purchase ${index}`, payee: `Fixture Vendor ${index}` })) }] };
}

async function reviewSignKind(f, kind, extra = {}) {
  const { account_slug } = f.first('SELECT account_slug FROM fin_accounts');
  const body = { action: 'kind', account_slug, kind, ...extra };
  const preview = await f.review({ ...body, dry_run: true });
  assert.equal(preview.blocked, false, 'exact owned account reached the type decision');
  const applied = await f.review({ ...body, dry_run: false, approve: preview.plan_hash });
  assert.equal(applied.complete, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews WHERE revoked_at IS NULL').n, 1);
  return { ...body, dry_run: false, approve: preview.plan_hash };
}

async function assertReviewedPosition(f, cents, group) {
  const body = await f.ask('What are my account balances?');
  assert.equal(body.ledger?.accounts.length, 1, 'balance inventory was admitted');
  assert.equal(body.ledger.accounts[0].balance_group, group);
  assert.equal(body.ledger.accounts[0].current_minor, cents, 'independent reviewed cents');
  assert.ok(body.citations.some(row => row.amount_minor === cents), 'citation agrees with reviewed cents');
  const rendered = [...body.answer.matchAll(/(-?)\$([\d,]+)\.(\d{2})/g)].map(match =>
    (match[1] ? -1 : 1) * (Number(match[2].replaceAll(',', '')) * 100 + Number(match[3])));
  assert.ok(rendered.includes(cents), 'rendered sign agrees with reviewed cents');
}

// Expected positions are generated independently in integer cents. Label-only
// changes and repeat approvals must never reinterpret an already-normalized row.
for (const cents of [12537, 63129, 91207]) {
  for (const [label, kind, group, expected] of [
    ['Everyday Account', 'card', 'liability', cents],
    ['Travel Credit Card', 'card', 'liability', cents],
    ['Business Loan', 'loan', 'liability', cents],
    ['Operating Checking', 'checking', 'cash', -cents],
    ['Everyday Account', 'other', 'other', cents],
  ]) test(`SF reviewed sign: ${label}, ${kind}, ${cents} cents, rename and replay`, async t => {
    const f = await connected(t), payload = reviewSignFeed(label, -cents);
    assert.equal((await f.pull(payload)).items[0].ok, true);
    await f.assign();
    assert.equal(f.first('SELECT provider_position_minor FROM fin_balance_snapshots').provider_position_minor, -cents,
      'snapshot retains signed provider evidence independently of its normalized balance');
    const approval = await reviewSignKind(f, kind, kind === 'other' ? { role: 'liability' } : {});
    await assertReviewedPosition(f, expected, group);
    const saved = f.first('SELECT * FROM fin_account_kind_reviews WHERE revoked_at IS NULL');
    await f.finishBackfill(payload);
    for (const renamed of ['Everyday Account', 'Travel Savings', label]) {
      payload.accounts[0].name = renamed;
      assert.equal((await f.pull(payload, NOW, true)).items[0].ok, true);
      assert.equal((await f.review(approval)).mutation_count, 0, 'original approval replays after label changes');
      assert.deepEqual(f.first('SELECT * FROM fin_account_kind_reviews WHERE revoked_at IS NULL'), saved);
      await assertReviewedPosition(f, expected, group);
    }
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_balance_snapshots').n, 1, 'replay retains one snapshot identity');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1, 'replay retains one event identity');
  });
}

async function reconciliationPopulation(t, { count = 55, phase = null, loss = null, race = false, sf } = {}) {
  const f = await connected(t, { sf }), original = reviewSignFeed('Operating Checking', 12537, count);
  assert.equal((await f.pull(original)).items[0].ok, true);
  await f.assign();
  await f.finishBackfill(original);
  const replacement = structuredClone(original);
  for (const row of replacement.accounts[0].transactions) row.id = row.id.replace('old-', 'new-');
  const batch = f.DB.batch, batches = [];
  let interruptions = 0;
  let racedRow;
  f.DB.batch = async statements => {
    const proposal = statements.some(row => /INSERT INTO simplefin_transaction_lineage/.test(row.sql));
    const restoration = statements.some(row => /SET superseded_by_id=NULL/.test(row.sql));
    if (proposal || restoration) {
      assert.match(statements[0].sql, /AS revision_guard/, 'reconciliation shares its transaction with the revision fence');
      assert.match(statements[1].sql, /simplefin reconciliation snapshot changed/, 'exact inventory guard precedes the writes');
    }
    batches.push({ size: statements.length, proposal, restoration });
    const interrupt = interruptions === 0 && loss && (phase === 'proposal' ? proposal : restoration);
    if (interrupt && race) {
      interruptions++;
      racedRow = f.first('SELECT id,payee FROM fin_transactions ORDER BY id LIMIT 1');
      f.raw('UPDATE fin_transactions SET payee=? WHERE id=?', 'Changed fixture', racedRow.id);
      return batch(statements);
    }
    if (interrupt && loss === 'before') { interruptions++; throw Error('synthetic reconciliation interruption'); }
    const result = await batch(statements);
    if (interrupt) { interruptions++; throw Error('synthetic reconciliation response loss'); }
    return result;
  };
  if (phase === 'proposal') {
    assert.equal((await f.pull(replacement, NOW, true)).items[0].ok, false);
    assert.equal(interruptions, 1, 'publication decision reached before refusal');
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage').n, loss === 'before' ? 0 : count);
    if (race) f.raw('UPDATE fin_transactions SET payee=? WHERE id=?', racedRow.payee, racedRow.id);
    await promoteSimpleFinWindows(f.env, { now: NOW });
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE revoked_at IS NULL').n, count,
      'durable revision replay recovers every unpublished proposal before a fresh provider observation');
  }
  assert.equal((await f.pull(replacement, NOW, true)).items[0].ok, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE revoked_at IS NULL').n, count,
    'all distinct proposal decisions reached');
  const expectedEvents = f.rows('SELECT id,txn_uid,external_id,amount_minor,raw_amount_minor,posted_on FROM fin_transactions ORDER BY id');
  assert.equal(expectedEvents.length, count * 2);
  const { account_ref } = f.first('SELECT account_ref FROM simplefin_account_assignments');
  for (const row of f.rows('SELECT predecessor_id,successor_id FROM simplefin_transaction_lineage')) {
    const options = { action: 'replacement', account_ref, ...row };
    const preview = await f.review({ ...options, dry_run: true });
    assert.equal(preview.blocked, false);
    assert.equal((await f.review({ ...options, dry_run: false, approve: preview.plan_hash, confirm_same_event: true })).complete, true);
  }
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n, count);
  const copresent = structuredClone(replacement);
  copresent.accounts[0].transactions.push(...original.accounts[0].transactions);
  if (phase === 'restoration') {
    assert.equal((await f.pull(copresent, NOW, true)).items[0].ok, false);
    assert.equal(interruptions, 1, 'restoration decision reached before refusal');
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE revoked_at IS NOT NULL').n,
      loss === 'before' ? 0 : count, 'restoration is atomic across every relationship');
    if (race) f.raw('UPDATE fin_transactions SET payee=? WHERE id=?', racedRow.payee, racedRow.id);
  }
  for (let replay = 0; replay < 2; replay++) {
    assert.equal((await f.pull(copresent, NOW, true)).items[0].ok, true);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE superseded_by_id IS NULL').n, count * 2);
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_transaction_lineage WHERE revoked_at IS NOT NULL').n, count);
    assert.deepEqual(f.rows('SELECT id,txn_uid,external_id,amount_minor,raw_amount_minor,posted_on FROM fin_transactions ORDER BY id'), expectedEvents,
      'replay preserves exact source inventory and cents');
  }
  assert.ok(batches.some(row => row.proposal), 'proposal batch witness');
  assert.ok(batches.some(row => row.restoration), 'restoration batch witness');
  assert.ok(batches.every(row => row.size <= 51), `bounded reconciliation batches, largest ${Math.max(...batches.map(row => row.size))}`);
  assert.ok(batches.filter(row => row.proposal).every(row => row.size === 3), 'proposal publication uses three statements at every population size');
  assert.ok(batches.filter(row => row.restoration).every(row => row.size === 4), 'restoration uses four statements at every population size');
  t.diagnostic(JSON.stringify({ relationships: count, proposal_statements: 3, restoration_statements: 4 }));
}

for (const count of [1, 55, 131]) test(`SF reconciliation: ${count} relationships stay bounded and replay exactly`, async t => {
  await reconciliationPopulation(t, { count });
});
for (const phase of ['proposal', 'restoration']) for (const loss of ['before', 'after']) {
  test(`SF reconciliation: ${phase} interrupted ${loss} commit and replayed`, async t => {
    await reconciliationPopulation(t, { phase, loss });
  });
}
for (const phase of ['proposal', 'restoration']) test(`SF reconciliation: ${phase} fences a changed inventory`, async t => {
  await reconciliationPopulation(t, { phase, loss: 'before', race: true });
});

async function reviewModuleCopy(t, relative, change = source => source, dependencies = {}) {
  const origin = new URL(relative, import.meta.url);
  const original = readFileSync(origin, 'utf8');
  const changed = change(original);
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'simplefin-review-')));
  t.after(() => {
    assert.equal(readFileSync(origin, 'utf8'), original, 'product source is restored after each named mutant');
    rmSync(directory, { recursive: true, force: true });
  });
  const resolved = changed.replace(/from (["'])(\.{1,2}\/[^"']+)\1/g, (_, quote, dependency) =>
    `from ${JSON.stringify(dependencies[dependency] || new URL(dependency, origin).href)}`);
  const path = join(directory, 'copy.mjs');
  writeFileSync(path, resolved);
  const sha = source => createHash('sha256').update(source).digest('hex');
  t.diagnostic(JSON.stringify({ copied_source: relative, source_sha256: sha(original), copy_sha256: sha(resolved) }));
  return { url: pathToFileURL(path).href, module: await import(pathToFileURL(path).href) };
}

async function signMutationReplay(t, answer, mode) {
  const f = await connected(t, { answer });
  const payload = reviewSignFeed(mode === 'rename' ? 'Travel Credit Card' : 'Everyday Account');
  assert.equal((await f.pull(payload)).items[0].ok, true);
  await f.assign();
  await assertReviewedPosition(f, mode === 'rename' ? 12537 : -12537, mode === 'rename' ? 'liability' : 'other');
  await reviewSignKind(f, 'card');
  await assertReviewedPosition(f, 12537, 'liability');
  if (mode === 'initial') return;
  await f.finishBackfill(payload);
  payload.accounts[0].name = mode === 'rename' ? 'Everyday Account' : 'Travel Credit Card';
  assert.equal((await f.pull(payload, NOW, true)).items[0].ok, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews WHERE revoked_at IS NULL').n, 1);
  await assertReviewedPosition(f, 12537, 'liability');
}

for (const [name, before, after, mode] of [
  ['card review sign ignored', "THEN -b.provider_position_minor ELSE b.provider_position_minor END",
    "THEN b.provider_position_minor ELSE b.provider_position_minor END", 'initial'],
  ['label change overrides review', 'role: account.balance_role,', 'role: member.provider_balance_role,', 'rename'],
  ['double negation', 'THEN -b.provider_position_minor ELSE b.provider_position_minor END',
    'THEN -b.current_minor ELSE b.provider_position_minor END', 'normalized'],
]) test(`SF named mutant killed and restored: ${name}`, async t => {
  await signMutationReplay(t, withLedgerAnswer, mode);
  const reader = await reviewModuleCopy(t, '../src/lib/ledger-reader.js', source => {
    assert.equal(source.split(before).length, 2, 'one live balance decision is mutated');
    return source.replace(before, after);
  });
  const answer = await reviewModuleCopy(t, '../src/lib/ledger-answer.js', undefined, { './ledger-reader.js': reader.url });
  await assert.rejects(signMutationReplay(t, answer.module.withLedgerAnswer, mode),
    error => error.code === 'ERR_ASSERTION' && /independent reviewed cents/.test(error.message));
});

test('SF named mutant killed and restored: unbounded reconciliation', async t => {
  await reconciliationPopulation(t);
  const reconciliation = await reviewModuleCopy(t, '../src/lib/simplefin-reconciliation.js', source => {
    const start = source.indexOf('  const pairs = JSON.stringify(restore.map');
    const end = source.indexOf('\nconst shape =', start);
    assert.ok(start > 0 && end > start, 'bounded restoration decision reached exactly');
    return source.slice(0, start) + `  return restore.length ? [guard(env,inventory), ...restore.flatMap(row => [
      env.DB.prepare('UPDATE fin_transactions SET superseded_by_id=NULL WHERE tenant_id=? AND id=? AND superseded_by_id=?')
        .bind(inventory.tenantId,row.predecessor_id,row.successor_id),
      env.DB.prepare('UPDATE simplefin_transaction_lineage SET revoked_at=? WHERE tenant_id=? AND predecessor_id=? AND successor_id=? AND revoked_at IS NULL')
        .bind(stamp,inventory.tenantId,row.predecessor_id,row.successor_id),
    ])] : [];
  }` + source.slice(end);
  });
  const sf = await reviewModuleCopy(t, '../src/lib/simplefin-bank-feed.js', undefined,
    { './simplefin-reconciliation.js': reconciliation.url });
  await assert.rejects(reconciliationPopulation(t, { sf: sf.module }),
    error => error.code === 'ERR_ASSERTION' && /bounded reconciliation batches/.test(error.message));
});

test('SF legacy sign: missing provider evidence refuses until a fresh exact observation', async t => {
  const f = await connected(t), payload = reviewSignFeed('Everyday Account');
  assert.equal((await f.pull(payload)).items[0].ok, true);
  await f.assign();
  await reviewSignKind(f, 'card');
  await assertReviewedPosition(f, 12537, 'liability');
  // Represent a snapshot carried through 0061, which deliberately invents no sign.
  f.raw('UPDATE fin_balance_snapshots SET provider_position_minor=NULL');
  const saved = f.first('SELECT * FROM fin_account_kind_reviews');
  const refused = await f.ask('What are my account balances?');
  assert.equal(refused.answer, null);
  assert.equal(refused.gaps[0].reason, 'balance_unavailable');
  assert.ok(f.seen.sql.some(sql => /provider_position_minor/.test(sql)), 'sign-evidence decision reached');
  assert.equal((await f.pull(payload)).items[0].ok, true);
  await assertReviewedPosition(f, 12537, 'liability');
  assert.deepEqual(f.first('SELECT * FROM fin_account_kind_reviews'), saved);
});
