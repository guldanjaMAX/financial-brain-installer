import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitStatements } from '../../brain.mjs';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
import * as currentFeed from '../src/lib/simplefin-bank-feed.js';
import { handleBankFeed } from '../src/lib/bank-feed.js';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { NOW, epoch } from './fixtures/simplefin/business-feed.mjs';

const directory=new URL('../../migrations/d1/',import.meta.url);

test('SimpleFIN 0060 upgrades real schema 0059 without changing legacy references or source rows', () => {
  const db=new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync(directory).filter(f => f.endsWith('.sql') && Number.parseInt(f,10)<=59).sort())
      for (const sql of splitStatements(readFileSync(new URL(file,directory),'utf8'))) db.exec(sql);
    db.exec(`INSERT INTO simplefin_account_assignments
      (tenant_id,item_ref,provider_account_id,account_ref,currency,first_seen_at,last_seen_at)
      VALUES ('primary','fixture-item','legacy-account','sfa_00000000000000000000000000000001','USD','2026-10-01','2026-10-01');
      INSERT INTO simplefin_connections(tenant_id,item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,updated_at)
      VALUES ('primary','fixture-item','2026-08-01','2026-11-05','2026-11-04','2026-11-05','2026-11-04');
      INSERT INTO simplefin_sync_windows(tenant_id,item_ref,window_start,window_end,state,fetched_at,promoted_at,revision,staging_revision)
      VALUES ('primary','fixture-item','2026-10-01','2026-10-31','promoted','2026-11-04','2026-11-04','old-revision','old-revision');
      INSERT INTO simplefin_stage_accounts(tenant_id,item_ref,window_start,window_end,provider_account_id,currency,revision)
      VALUES ('primary','fixture-item','2026-10-01','2026-10-31','legacy-account','USD','old-revision');
      INSERT INTO simplefin_stage_transactions(tenant_id,item_ref,window_start,window_end,provider_account_id,provider_transaction_id,currency,revision)
      VALUES ('primary','fixture-item','2026-10-01','2026-10-31','legacy-account','legacy-event','USD','old-revision');`);
    const assignment=db.prepare('SELECT * FROM simplefin_account_assignments').get();
    const transactions=db.prepare('SELECT * FROM simplefin_stage_transactions').all();
    const migration=readFileSync(new URL('0060_simplefin_account_identity.sql',directory),'utf8');
    assert.ok(splitStatements(migration).length>10,'apply the real migration');
    for(const sql of splitStatements(migration))db.exec(sql);
    const upgraded=db.prepare('SELECT * FROM simplefin_account_assignments').get();
    assert.equal(upgraded.connection_id,null,'no connection guessed');
    assert.equal(upgraded.source_account_id,'legacy-account');
    for(const [key,value] of Object.entries(assignment))assert.equal(upgraded[key],value,key);
    assert.deepEqual(db.prepare('SELECT * FROM simplefin_stage_transactions').all(),transactions);
    assert.equal(db.prepare('SELECT staging_revision FROM simplefin_sync_windows').get().staging_revision,'identity-unverified');
    assert.equal(db.prepare('SELECT backfill_next FROM simplefin_connections').get().backfill_next,'2026-10-01');
    assert.equal(db.prepare('SELECT transactions_present FROM simplefin_stage_accounts').get().transactions_present,0);
    for(const [index,connection] of ['connection-a','connection-b'].entries())db.prepare(`INSERT INTO simplefin_account_assignments
      (tenant_id,item_ref,provider_account_id,source_account_id,connection_id,account_ref,currency,first_seen_at,last_seen_at)
      VALUES ('primary','fixture-item',?,?,?,?, 'USD','2026-11-04','2026-11-04')`)
      .run(JSON.stringify([connection,'same-account']),'same-account',connection,`sfa_${String(index+2).padStart(32,'0')}`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM simplefin_account_assignments').get().n,3);
  } finally {db.close()}
});

test('balance position 0061 preserves existing figures and leaves legacy sign evidence unknown', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync(directory).filter(file => file.endsWith('.sql') && Number.parseInt(file, 10) <= 60).sort())
      for (const sql of splitStatements(readFileSync(new URL(file, directory), 'utf8'))) db.exec(sql);
    db.exec(`INSERT INTO fin_balance_snapshots
      (tenant_id,account_slug,as_of_date,current_minor,available_minor,currency,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','legacy-card','2026-11-04',12537,50000,'USD','feed','bank-feed:fixture-item','confirmed','2026-11-04');`);
    const before = db.prepare('SELECT * FROM fin_balance_snapshots').all();
    const statements = splitStatements(readFileSync(new URL('0061_balance_position_evidence.sql', directory), 'utf8'));
    assert.equal(statements.length, 1, 'actual additive migration reached');
    for (const sql of statements) db.exec(sql);
    const after = db.prepare('SELECT * FROM fin_balance_snapshots').all();
    assert.equal(after.length, before.length);
    for (const [index, row] of after.entries()) {
      const { provider_position_minor, ...preserved } = row;
      assert.equal(provider_position_minor, null, 'a historical sign is never inferred from a current label');
      assert.deepEqual({ ...preserved }, { ...before[index] }, 'every existing snapshot field and identity survives');
    }
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});

const legacyReason = 'Absent from verified SimpleFIN posted history';
const legacyFeedUrl = new URL('./fixtures/simplefin/schema59-bank-feed.mjs', import.meta.url);
const feedUrl = new URL('../src/lib/simplefin-bank-feed.js', import.meta.url);
const digest = source => createHash('sha256').update(source).digest('hex');

async function moduleCopy(t, origin, source = readFileSync(origin, 'utf8'), dependencies = {}) {
  const original = readFileSync(origin, 'utf8');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'simplefin-upgrade-')));
  t.after(() => {
    assert.equal(readFileSync(origin, 'utf8'), original, 'named mutant leaves product source restored');
    rmSync(scratch, { recursive: true, force: true });
  });
  const resolved = source.replace(/from (["'])(\.{1,2}\/[^"']+)\1/g, (_, quote, dependency) =>
    `from ${JSON.stringify(dependencies[dependency] || new URL(dependency, origin).href)}`);
  const path = join(scratch, 'copy.mjs');
  writeFileSync(path, resolved);
  t.diagnostic(JSON.stringify({ source_sha256: digest(source), copy_sha256: digest(resolved) }));
  const url = pathToFileURL(path).href;
  return { url, module: await import(url) };
}

// The immutable snapshot is the actual schema59 feed at the pinned base, not a
// reimplementation of its withdrawal SQL. Only relative imports are rebound.
async function legacyFixture(t, { withdraw = true, sf = currentFeed, amountMinor = 23791 } = {}) {
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const source = readFileSync(legacyFeedUrl, 'utf8');
  assert.equal(digest(source), '24d53db107657df46362dc48444157398740c41cb388ae89b93f7dedc08fb292');
  const base = (await moduleCopy(t, feedUrl, source)).module;
  const f = await createProductFixture({ migrationThrough: 59, env: {
    BANK_FEED_PROVIDER: 'simplefin', BANK_FEED_ENV: 'production', BRAIN_TIMEZONE: 'UTC',
    BANK_FEED_WRAPPING_KEY_V2: `v2.${randomBytes(32).toString('base64url')}`,
  } });
  t.after(() => f.close());
  seedOwnedEntity(f, 'owner-business', 'Owner business');
  const access = new URL('https://provider.invalid/feed');
  access.username = 'fixture'; access.password = 'fixture';
  const claimed = await base.claimSimpleFinAccess(f.env, {
    requestId: 'upgrade-fixture-claim-0001', now: NOW,
    setupToken: btoa('https://provider.invalid/claim'),
    fetchImpl: async () => new Response(access.href),
  });
  assert.equal(claimed.status, 201);
  f.raw("UPDATE simplefin_connections SET backfill_start='2026-10-01',backfill_next='2026-10-01',backfill_end='2026-11-04'");
  f.payload = { errlist: [], accounts: [{ id: 'legacy-account', conn_id: 'legacy-bank',
    name: 'Operating Checking', currency: 'USD', balance: '642.81', 'balance-date': epoch('2026-11-04'),
    transactions: [{ id: 'retained-event', posted: epoch('2026-11-03'), amount: `${Math.trunc(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, '0')}`,
      description: 'Invoice settlement', payee: 'Fixture Buyer' }],
  }] };
  f.calls = { base: 0, current: 0 };
  f.windowCalls = [];
  f.pull = async (payload = f.payload, feed = sf, name = 'current', { filter = false } = {}) => {
    f.raw("UPDATE simplefin_connections SET next_pull_at='2000-01-01'");
    return feed.runSimpleFinMaintenance(f.env, { now: NOW, maxRequestsPerItem: 1,
      fetchImpl: async request => {
        f.calls[name]++;
        const url = new URL(request.url), from = Number(url.searchParams.get('start-date')), to = Number(url.searchParams.get('end-date'));
        f.windowCalls.push({ name, from, to });
        const value = structuredClone(payload);
        if (filter) for (const account of value.accounts) account.transactions = account.transactions.filter(row =>
          row.pending || row.posted >= from && row.posted < to);
        return Response.json(value);
      } });
  };
  assert.equal((await f.pull(f.payload, base, 'base')).items[0].ok, true);
  f.assignment = f.first('SELECT * FROM simplefin_account_assignments');
  assert.equal((await base.assignSimpleFinAccountEntity(f.env, {
    request_id: 'upgrade-assignment-0001', account_ref: f.assignment.account_ref, entity_slug: 'owner-business',
  }, { now: NOW })).body.ok, true);
  f.original = f.first('SELECT id,txn_uid,account_slug,source_feed,external_id,amount_minor FROM fin_transactions');
  assert.equal(f.original.amount_minor, amountMinor, 'real base import is the initial green control');
  assert.equal(f.first('SELECT removed_at FROM fin_transactions').removed_at, null);
  f.subset = structuredClone(f.payload);
  f.subset.accounts[0].transactions = [];
  if (withdraw) {
    assert.equal((await f.pull(f.subset, base, 'base')).items[0].ok, true);
    assert.equal(f.calls.base, 2, 'omission reached actual base publication');
    assert.ok(f.first('SELECT removed_at FROM fin_transactions').removed_at, 'actual base withdrawal reached');
    assert.equal(f.first('SELECT removal_reason FROM fin_transactions').removal_reason, legacyReason);
  }
  f.base = base;
  f.review = async body => {
    const headers = await f.ownerHeaders();
    const path = '/api/bank-feed/simplefin/review';
    const request = new Request(`https://brain.invalid${path}`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const response = await handleBankFeed(f.env, request, new URL(request.url), path, { bankFeedNow: NOW });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  f.upgrade = async () => {
    const before = f.first('SELECT * FROM fin_transactions');
    for (const file of ['0060_simplefin_account_identity.sql', '0061_balance_position_evidence.sql'])
      for (const sql of splitStatements(readFileSync(new URL(file, directory), 'utf8'))) f.sqlite.exec(sql);
    assert.deepEqual(f.first('SELECT * FROM fin_transactions'), before, 'real migrations preserve the complete withdrawn row');
    const body = { action: 'identity', account_ref: f.assignment.account_ref, connection_id: 'legacy-bank' };
    const preview = await f.review({ ...body, dry_run: true });
    assert.equal(preview.blocked, false);
    assert.equal((await f.review({ ...body, dry_run: false, approve: preview.plan_hash })).complete, true);
  };
  f.assertIdentity = () => {
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1, 'no duplicate source event');
    assert.deepEqual(f.first('SELECT id,txn_uid,account_slug,source_feed,external_id,amount_minor FROM fin_transactions'), f.original);
  };
  f.assertActive = () => {
    f.assertIdentity();
    assert.deepEqual(f.first('SELECT removed_at,removal_reason FROM fin_transactions'),
      Object.assign(Object.create(null), { removed_at: null, removal_reason: null }), 'exact posted reappearance restores only the legacy marker');
  };
  return f;
}

for (const mode of ['base-reappearance', 'upgrade-present', 'upgrade-reappearance']) {
  test(`SimpleFIN three-arm schema59 recovery: ${mode}`, async t => {
    const f = await legacyFixture(t, { withdraw: mode !== 'upgrade-present' });
    if (mode === 'base-reappearance') {
      assert.equal((await f.pull(f.payload, f.base, 'base')).items[0].ok, true);
      assert.equal(f.calls.base, 3, 'real base reappearance control reached');
    } else {
      await f.upgrade();
      for (let n = 0; n < 2; n++) assert.equal((await f.pull()).items[0].ok, true);
      assert.equal(f.calls.current, 2, 'current publication and idempotent retry reached');
      f.assertActive();
      const coverage = { action: 'coverage', account_ref: f.assignment.account_ref, from: '2026-10-01', to: '2026-11-04' };
      const preview = await f.review({ ...coverage, dry_run: true });
      assert.equal(preview.transaction_count, 1, 'nonempty coverage decision reached');
      assert.equal(preview.blocked, false);
      assert.equal((await f.review({ ...coverage, dry_run: false, approve: preview.plan_hash, confirm_source_comparison: true })).complete, true);
      const before = f.first('SELECT total_changes() n').n, start = f.seen.sql.length;
      const response = await withLedgerAnswer({ env: f.env, now: Date.parse(NOW),
        question: 'Did the payment of $237.91 arrive this month?', grantScope: { all: true }, scopePrincipalKind: 'owner' },
      async gap => Response.json({ answer: null, gaps: gap ? [gap] : [], citations: [] }));
      const answer = await response.json();
      assert.equal(answer.ledger?.found, true, 'upgraded payment answer is affirmative');
      assert.ok(answer.citations.some(row => row.amount_minor === 23791));
      assert.match(answer.answer, /\$237\.91/);
      assert.ok(f.seen.sql.slice(start).some(sql => /FROM fin_transactions/.test(sql)), 'real payment admission reached');
      assert.equal(f.first('SELECT total_changes() n').n, before, 'answer is read only');
    }
    f.assertActive();
    assert.equal(f.first('PRAGMA integrity_check').integrity_check, 'ok');
    assert.deepEqual(f.rows('PRAGMA foreign_key_check'), []);
  });
}

async function unreadReplay(t, sf = currentFeed, mode = 'unread-amount') {
  const f = await legacyFixture(t, { sf });
  await f.upgrade();
  const payload = structuredClone(f.payload), event = payload.accounts[0].transactions[0];
  if (mode === 'unread-amount') event.amount = '0.001';
  if (mode === 'unread-posting') delete event.posted;
  if (mode === 'pending') event.pending = true;
  if (mode === 'retained-absence') payload.accounts[0].transactions = [];
  const tombstone = f.first('SELECT removed_at,removal_reason FROM fin_transactions');
  const result = await f.pull(payload);
  assert.equal(f.calls.current, 1, 'negative arm reached current provider observation');
  assert.equal(result.items[0].ok, true);
  const staged = f.first('SELECT COUNT(*) n FROM simplefin_stage_transactions WHERE revision=(SELECT revision FROM simplefin_sync_windows ORDER BY revision DESC LIMIT 1)').n;
  assert.equal(staged, mode.startsWith('unread') ? 1 : 0, 'readability/pending/absence decision reached');
  assert.deepEqual(f.first('SELECT removed_at,removal_reason FROM fin_transactions'), tombstone,
    'unread, pending or absent evidence must retain the legacy tombstone');
  assert.equal((await f.pull()).items[0].ok, true, 'fresh posted evidence is the green control');
  f.assertActive();
}
for (const mode of ['unread-amount', 'unread-posting', 'pending', 'retained-absence'])
  test(`SimpleFIN legacy absence control: ${mode}`, async t => unreadReplay(t, currentFeed, mode));

async function protectedReplay(t, sf = currentFeed, otherReason = false) {
  const f = await legacyFixture(t, { sf });
  await f.upgrade();
  if (otherReason) f.raw("UPDATE fin_transactions SET removal_reason='Owner retained withdrawal'");
  else f.raw("UPDATE fin_transactions SET category='owner-category',category_basis_state='confirmed'");
  const before = f.first('SELECT category,category_basis_state FROM fin_transactions');
  const tombstone = f.first('SELECT removed_at,removal_reason FROM fin_transactions');
  const start = f.seen.sql.length;
  assert.equal((await f.pull()).items[0].ok, true);
  assert.equal(f.calls.current, 1, 'protected arm reached current posted publication');
  assert.ok(f.seen.sql.slice(start).some(sql => /simplefin_transaction_lineage/.test(sql)), 'restoration decision reached');
  assert.deepEqual(f.first('SELECT category,category_basis_state FROM fin_transactions'), before,
    'owner evidence must survive reappearance');
  if (otherReason) assert.deepEqual(f.first('SELECT removed_at,removal_reason FROM fin_transactions'), tombstone,
    'other withdrawal reasons must survive reappearance');
  else f.assertActive();
  f.assertIdentity();
  if (otherReason) f.raw('UPDATE fin_transactions SET removal_reason=?', legacyReason);
  assert.equal((await f.pull()).items[0].ok, true, 'unprotected exact legacy marker is the green control');
  f.assertActive();
}
test('SimpleFIN legacy absence preserves owner evidence', async t => protectedReplay(t));
test('SimpleFIN legacy absence preserves other withdrawal reasons', async t => protectedReplay(t, currentFeed, true));

for (const race of ['revision', 'inventory', 'reason', 'owner']) {
  test(`SimpleFIN legacy restoration fences a changed ${race}`, async t => {
    const f = await legacyFixture(t);
    await f.upgrade();
    const batch = f.env.DB.batch.bind(f.env.DB);
    let reached = 0;
    f.env.DB.batch = async statements => {
      if (statements.some(row => /SET removed_at=NULL,removal_reason=NULL/.test(row.sql))) {
        reached++;
        if (reached === 1) {
          if (race === 'revision') f.raw("UPDATE simplefin_sync_windows SET staging_revision=staging_revision||'~newer'");
          if (race === 'inventory') f.raw('UPDATE fin_transactions SET raw_amount_minor=raw_amount_minor+1');
          if (race === 'reason') f.raw("UPDATE fin_transactions SET removal_reason='Owner retained withdrawal'");
          if (race === 'owner') f.raw("UPDATE fin_transactions SET category_basis_state='confirmed'");
        }
      }
      return batch(statements);
    };
    const outcome = await f.pull();
    assert.equal(f.calls.current, 1, 'racing response reached provider observation');
    assert.equal(reached, 1, 'nonempty legacy restoration transaction reached');
    assert.equal(outcome.items[0].ok, false, 'changed snapshot refuses publication');
    assert.ok(f.first('SELECT removed_at FROM fin_transactions').removed_at, 'stale response cannot restore');
    assert.equal(f.first('SELECT COUNT(*) n FROM simplefin_account_windows WHERE complete=1').n, 0);
    f.env.DB.batch = batch;
    f.raw("UPDATE fin_transactions SET raw_amount_minor=23791,removal_reason=?,category_basis_state='proposed'", legacyReason);
    assert.equal((await f.pull()).items[0].ok, true, 'fresh response is the green control');
    f.assertActive();
  });
}

test('SimpleFIN late posted response cannot restore after a newer subset observation', async t => {
  const f = await legacyFixture(t);
  await f.upgrade();
  const batch = f.env.DB.batch.bind(f.env.DB);
  let reached, release, decisions = 0;
  const ready = new Promise(resolve => { reached = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.env.DB.batch = async statements => {
    if (statements.some(row => /SET removed_at=NULL,removal_reason=NULL/.test(row.sql)) && ++decisions === 1) {
      reached(); await blocked;
    }
    return batch(statements);
  };
  const older = f.pull();
  await ready;
  try {
    assert.equal((await f.pull(f.subset)).items[0].ok, true, 'newer subset is actually published');
    assert.ok(f.first('SELECT removed_at FROM fin_transactions').removed_at, 'newer absence retains the marker');
  } finally { release(); }
  const stale = await older;
  f.env.DB.batch = batch;
  assert.equal(f.calls.current, 2, 'both current-code provider observations reached');
  assert.equal(decisions, 1, 'late response reached a nonempty restoration decision');
  assert.equal(stale.items[0].ok, false, 'stale posted evidence is refused');
  assert.ok(f.first('SELECT removed_at FROM fin_transactions').removed_at, 'stale observation cannot restore');
  assert.equal((await f.pull()).items[0].ok, true, 'fresh posted response is the green control');
  f.assertActive();
});

for (const evidence of ['exception', 'claim', 'reconciliation', 'period-close']) {
  test(`SimpleFIN legacy restoration preserves owner ${evidence} evidence`, async t => {
    const f = await legacyFixture(t);
    await f.upgrade();
    const { txn_uid: uid, account_slug: account } = f.original;
    let table;
    if (evidence === 'exception') {
      table = 'fin_exceptions';
      f.raw(`INSERT INTO fin_exceptions (exception_uid,kind,issue,txn_uid,first_seen,provenance,basis_state,recorded_at)
        VALUES ('owner-exception','other','Owner review retained',?,'2026-11-04','owner_stated','confirmed',?)`, uid, NOW);
    } else if (evidence === 'claim') {
      table = 'fin_reconciliation_claims';
      f.raw(`INSERT INTO fin_reconciliation_claims
        (claim_uid,reconciliation_uid,label,amount_minor,as_of,claim_ref_table,claim_ref_uid,provenance,basis_state,recorded_at)
        VALUES ('owner-claim','owner-reconciliation','Owner evidence',23791,'2026-11-04','fin_transactions',?,'owner_stated','confirmed',?)`, uid, NOW);
    } else if (evidence === 'reconciliation') {
      table = 'fin_reconciliations';
      f.raw(`INSERT INTO fin_reconciliations (reconciliation_uid,account_slug,measure,computed_at,recorded_at)
        VALUES ('owner-reconciliation',?,'period_receipts',?,?)`, account, NOW, NOW);
    } else {
      table = 'fin_period_closes';
      f.raw(`INSERT INTO fin_period_closes
        (close_id,entity_slug,period_start,period_end,status,evidence_state,evidence_json,updated_at)
        VALUES ('owner-close','owner-business','2026-11-01','2026-11-04','accepted','complete','{}',?)`, NOW);
    }
    const before = f.rows(`SELECT * FROM ${table}`);
    assert.equal(before.length, 1, 'nonempty owner evidence is the protection witness');
    const start = f.seen.sql.length;
    assert.equal((await f.pull()).items[0].ok, true);
    assert.equal(f.calls.current, 1, 'owner-protected event reached current publication');
    assert.ok(f.seen.sql.slice(start).some(sql => /simplefin_transaction_lineage/.test(sql)), 'restoration decision reached');
    assert.deepEqual(f.rows(`SELECT * FROM ${table}`), before, 'owner evidence is byte-for-byte preserved');
    f.assertActive();
    assert.equal((await f.pull()).items[0].ok, true, 'repeated posted evidence is the green control');
    f.assertActive();
    assert.deepEqual(f.rows(`SELECT * FROM ${table}`), before, 'recovery and retry preserve owner evidence');
  });
}

test('SimpleFIN legacy restoration keeps tenant, source, account and event identities separate', async t => {
  const f = await legacyFixture(t);
  await f.upgrade();
  const original = f.first('SELECT * FROM fin_transactions');
  const clones = [
    { tenant_id: 'other-tenant' },
    { txn_uid: 'other-source-event', source_feed: 'bank-feed:other-item' },
    { txn_uid: 'other-account-event', account_slug: 'other-account' },
    { txn_uid: 'other-event', external_id: 'absent-event' },
    { txn_uid: 'other-provider-event', source_provider: 'plaid' },
  ];
  const columns = Object.keys(original).filter(key => key !== 'id');
  for (const changed of clones) {
    const row = { ...original, ...changed };
    f.raw(`INSERT INTO fin_transactions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      ...columns.map(key => row[key]));
  }
  const before = f.rows('SELECT * FROM fin_transactions WHERE id<>?', original.id);
  assert.equal(before.length, 5, 'nonempty colliding identities are the refusal witnesses');
  assert.equal((await f.pull()).items[0].ok, true);
  assert.equal(f.calls.current, 1, 'same-ID posted publication reached');
  assert.equal(f.first('SELECT removed_at FROM fin_transactions WHERE id=?', original.id).removed_at, null,
    'exact tuple is the green control');
  assert.deepEqual(f.rows('SELECT * FROM fin_transactions WHERE id<>?', original.id), before,
    'no adjacent identity or retained absent event is restored or overwritten');
});

const reconciliationUrl = new URL('../src/lib/simplefin-reconciliation.js', import.meta.url);
async function incompleteListingReplay(t, sf = currentFeed, mode = 'transactions-omitted', retained = false, historyOnly = false) {
  const f = await legacyFixture(t, { sf, amountMinor: 49183 });
  await f.upgrade();
  const payload = structuredClone(f.payload);
  if (mode === 'transactions-omitted') delete payload.accounts[0].transactions;
  if (mode === 'out-of-window') payload.accounts[0].transactions[0].posted = epoch('2026-09-01');
  if (mode === 'complete-empty') payload.accounts[0].transactions = [];
  assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next, '2026-10-01');
  assert.equal((await f.pull(payload)).items[0].ok, true);
  assert.equal(f.calls.current, 1, 'fault reaches current publication through the provider response');
  const window = (from, to) => ({ name: 'current', from: Date.parse(`${from}T00:00:00Z`) / 1000, to: Date.parse(`${to}T00:00:00Z`) / 1000 });
  const historical = window('2026-10-01', '2026-11-05'), recent = window('2026-11-02', '2026-11-05');
  assert.deepEqual(f.windowCalls.filter(row => row.name === 'current'), [historical], 'exact historical request, exclusive endpoint');
  const receipt = f.first("SELECT complete FROM simplefin_account_windows WHERE window_start='2026-10-01'");
  assert.equal(receipt.complete, mode === 'complete-empty' ? 1 : 0, 'account completeness decision reached');
  assert.equal(f.first('SELECT current_minor FROM fin_balance_snapshots ORDER BY id DESC LIMIT 1').current_minor, 64281,
    'usable balances survive an incomplete listing');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE id=?', f.original.id).n, 1,
    'the original durable source row survives');
  if (mode === 'out-of-window') assert.equal(f.first('SELECT posted_on FROM fin_transactions').posted_on, '2026-09-01',
    'readable source evidence is retained without certifying the requested interval');
  if (mode !== 'complete-empty') {
    const blocked = await f.review({ action: 'coverage', account_ref: f.assignment.account_ref,
      from: '2026-10-01', to: '2026-11-04', dry_run: true });
    assert.equal(blocked.blocked, true, 'incomplete receipt reaches the owner coverage refusal');
    if (retained) {
      // Reproduce the durable pre-fix state once. Recovery below never edits
      // either cursor or last_synced_at, even when the old backfill is complete.
      f.raw("UPDATE simplefin_sync_windows SET state='promoted',promoted_at=?", NOW);
      f.raw("UPDATE simplefin_connections SET backfill_next='2026-11-05'");
      f.raw("UPDATE bank_feed_backfill SET state='complete',finished_at=?", NOW);
      const before = f.seen.sql.length;
      await sf.promoteSimpleFinWindows(f.env, { now: NOW });
      assert.ok(f.seen.sql.length > before, 'already-promoted receipt reaches maintenance without a provider request');
      assert.equal(f.first('SELECT state FROM bank_feed_backfill').state, 'running',
        'promoted incomplete receipt reopens completed backfill');
      assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next, '2026-11-05',
        'repair does not require rewinding the persisted cursor');
    } else {
      assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next, '2026-10-01',
        'incomplete listing must not advance the history cursor');
      assert.equal(f.first('SELECT state FROM simplefin_sync_windows').state, 'staged', 'incomplete listing stays retryable');
      assert.notEqual(f.first('SELECT state FROM bank_feed_backfill').state, 'complete');
    }
  }
  const corrected = structuredClone(f.payload);
  corrected.accounts[0].transactions.push({ id: 'older-receipt', posted: epoch('2026-10-20'), amount: '375.91',
    description: 'Historical settlement', payee: 'Fixture Buyer' });
  const retryWitnesses = [];
  if (historyOnly) {
    // Isolate the independent history walk: suppress the retry selection only
    // after executing it, so its real unresolved receipt is still witnessed.
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes('ORDER BY window_start,window_end LIMIT 1')) return statement;
      return { bind: (...values) => {
        const bound = statement.bind(...values);
        return { ...bound, first: async () => {
          const retry = await bound.first();
          if (retry) retryWitnesses.push(window(retry.window_start, new Date(Date.parse(`${retry.window_end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)));
          return null;
        } };
      } };
    };
  }
  for (let n = 0; n < 3; n++) assert.equal((await f.pull(corrected, sf, 'current', { filter: true })).items[0].ok, true);
  if (historyOnly) assert.deepEqual(retryWitnesses, [historical, recent], 'history walk independently sees both unresolved upgrade receipts');
  const expected = mode === 'complete-empty' ? [historical, recent, recent, recent] : [historical, historical, recent, recent];
  assert.deepEqual(f.windowCalls.filter(row => row.name === 'current'), expected,
    'oldest incomplete interval is retried before rolling recent history');
  const older = f.first("SELECT amount_minor,removed_at FROM fin_transactions WHERE external_id='older-receipt'");
  if (mode === 'complete-empty') assert.equal(older, null, 'explicit empty-array progress does not invent historical rows');
  else {
    assert.equal(older.amount_minor, 37591, 'corrected exact historical request recovers independent cents');
    assert.equal(older.removed_at, null);
    const broad = { action: 'coverage', account_ref: f.assignment.account_ref, from: '2026-10-01', to: '2026-11-04' };
    const preview = await f.review({ ...broad, dry_run: true });
    assert.equal(preview.transaction_count, 2, 'nonempty historical owner comparison reached');
    assert.equal(preview.blocked, false);
    assert.equal(f.first('SELECT coverage_status FROM fin_account_coverage').coverage_status, 'partial',
      'automatic recovery still requires owner completeness approval');
    assert.equal((await f.review({ ...broad, dry_run: false, approve: preview.plan_hash, confirm_source_comparison: true })).complete, true);
  }
  const options = { action: 'coverage', account_ref: f.assignment.account_ref, from: '2026-11-02', to: '2026-11-04' };
  const preview = await f.review({ ...options, dry_run: true });
  assert.equal(preview.blocked, false, 'recent-window green control reaches the same owner comparison');
  assert.equal(preview.transaction_count, 1);
  assert.equal((await f.review({ ...options, dry_run: false, approve: preview.plan_hash, confirm_source_comparison: true })).complete, true);
  const before = f.first('SELECT total_changes() n').n, sqlStart = f.seen.sql.length;
  const answer = await (await withLedgerAnswer({ env: f.env, now: Date.parse(NOW),
    question: 'Did the payment of $491.83 arrive this week?', grantScope: { all: true }, scopePrincipalKind: 'owner' },
  async gap => Response.json({ answer: null, gaps: gap ? [gap] : [], citations: [] }))).json();
  assert.equal(answer.ledger?.found, true, 'recent payment affirmative green control');
  assert.ok(answer.citations.some(row => row.amount_minor === 49183));
  assert.ok(f.seen.sql.slice(sqlStart).some(sql => /FROM fin_transactions/.test(sql)), 'real payment admission reached');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'answer is read only');
  assert.equal(f.first("SELECT complete FROM simplefin_account_windows WHERE window_start='2026-10-01'").complete, 1);
  assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next, '2026-11-05');
  assert.equal(f.first('SELECT state FROM bank_feed_backfill').state, 'complete');
}

for (const mode of ['transactions-omitted', 'out-of-window', 'complete-empty'])
  test(`SimpleFIN incomplete historical listing recovery: ${mode}`, t => incompleteListingReplay(t, currentFeed, mode));
for (const mode of ['transactions-omitted', 'out-of-window'])
  test(`SimpleFIN repairs already-promoted incomplete receipt: ${mode}`, t => incompleteListingReplay(t, currentFeed, mode, true));
test('SimpleFIN verified-history walk excludes promoted incomplete receipts',
  t => incompleteListingReplay(t, currentFeed, 'out-of-window', true, true));

async function omittedAccountReplay(t, sf = currentFeed, { omissions = 1, control = false,
  disconnect = false, retained = false, historyOnly = false, empty = false } = {}) {
  const f = await legacyFixture(t, { sf, amountMinor: 49183 });
  await f.upgrade();
  const incomplete = structuredClone(f.payload);
  delete incomplete.accounts[0].transactions;
  assert.equal((await f.pull(incomplete)).items[0].ok, true);
  const receiptSql = `SELECT r.*,w.state,w.revision AS parent_revision,c.backfill_next
    FROM simplefin_account_windows r JOIN simplefin_sync_windows w
      USING(tenant_id,item_ref,window_start,window_end)
    JOIN simplefin_connections c USING(tenant_id,item_ref)
    WHERE r.account_ref=? AND r.window_start='2026-10-01' AND r.window_end='2026-11-04'`;
  const originalReceipt = f.first(receiptSql, f.assignment.account_ref);
  assert.equal(originalReceipt.complete, 0, 'real incomplete account receipt reached');
  assert.equal(originalReceipt.state, 'staged');
  const expectedStarts = ['2026-10-01'];
  for (let n = 0; n < omissions; n++) {
    assert.equal((await f.pull(control ? incomplete : { accounts: [], errlist: [] })).items[0].ok, true,
      'omitted account remains a successful, retryable provider pull');
    expectedStarts.push('2026-10-01');
    const receipt = f.first(receiptSql, f.assignment.account_ref);
    assert.notEqual(receipt.parent_revision, originalReceipt.parent_revision, 'parent revision actually advances');
    assert.equal(receipt.complete, 0, 'revision advance must retain the incomplete receipt');
    if (!control) assert.equal(receipt.revision, originalReceipt.revision, 'omission preserves the exact unresolved receipt');
    assert.equal(receipt.state, 'staged', 'omission must not promote unresolved work');
    assert.equal(receipt.backfill_next, '2026-10-01', 'omission must not advance the history cursor');
    assert.notEqual(f.first('SELECT state FROM bank_feed_backfill').state, 'complete');
    const blocked = await f.review({ action: 'coverage', account_ref: f.assignment.account_ref,
      from: '2026-10-01', to: '2026-11-04', dry_run: true });
    assert.equal(blocked.blocked, true, 'retained incomplete receipt reaches real coverage refusal');
  }
  assert.equal(f.calls.current, 1 + omissions, 'every omission reached the real publication decision');
  const retainedRow = f.first('SELECT id,txn_uid,account_slug,source_feed,external_id,amount_minor FROM fin_transactions');
  assert.deepEqual(retainedRow, f.original, 'omission preserves source identity and cents');
  assert.equal(f.first('SELECT current_minor FROM fin_balance_snapshots ORDER BY id DESC LIMIT 1').current_minor, 64281);
  if (disconnect) {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
    const path = '/api/bank-feed/disconnect';
    const request = new Request(`https://brain.invalid${path}`, { method: 'POST',
      headers: { ...await f.ownerHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_ref: f.assignment.item_ref }) });
    const response = await handleBankFeed(f.env, request, new URL(request.url), path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).history_kept, true, 'supported owner disconnect decision reached');
    assert.equal(f.first('SELECT status FROM bank_feed_items').status, 'removed');
    assert.equal(f.first('SELECT removed_at FROM bank_feed_items').removed_at, NOW, 'owner action uses the anchored fixture clock');
    for (let n = 0; n < 2; n++) assert.equal((await f.pull()).ran, 0);
    assert.equal(f.calls.current, 1 + omissions, 'owner-disconnected connection stops provider dispatch');
    assert.equal(f.first(receiptSql, f.assignment.account_ref).complete, 0, 'disconnect keeps unresolved history evidence');
    assert.deepEqual(f.first('SELECT id,txn_uid,account_slug,source_feed,external_id,amount_minor FROM fin_transactions'), retainedRow);
    assert.equal(f.first('SELECT coverage_status FROM fin_account_coverage').coverage_status, 'partial');
    return;
  }
  if (retained) {
    // Reproduce the old revision filter through real publication, then repair
    // the fixture's other legacy interval so only this receipt can reopen progress.
    const original = readFileSync(feedUrl, 'utf8'), decision = 'AND incomplete.complete=0)';
    assert.equal(original.split(decision).length, 2, 'one pre-fix revision filter reproduced');
    const beforeFix = (await moduleCopy(t, feedUrl, original.replace(decision,
      'AND incomplete.revision=${windowAlias}.revision AND incomplete.complete=0)'))).module;
    assert.equal((await f.pull({ accounts: [], errlist: [] }, beforeFix)).items[0].ok, true);
    assert.equal((await f.pull(f.payload, beforeFix, 'current', { filter: true })).items[0].ok, true);
    expectedStarts.push('2026-10-01', '2026-11-02');
    const persisted = f.first(receiptSql, f.assignment.account_ref);
    assert.equal(persisted.state, 'promoted', 'actual old promoter publishes the cross-revision incomplete receipt');
    assert.equal(persisted.complete, 0);
    assert.notEqual(persisted.revision, persisted.parent_revision);
    assert.equal(f.first('SELECT count(*) n FROM simplefin_account_windows WHERE complete=0').n, 1,
      'only the omitted account interval remains unresolved');
    for (const row of f.rows('SELECT state,revision,staging_revision,errlist_json FROM simplefin_sync_windows')) {
      assert.equal(row.state, 'promoted');
      assert.equal(row.revision, row.staging_revision);
      assert.equal(row.errlist_json, '[]');
    }
    assert.equal(f.first('SELECT state FROM bank_feed_backfill').state, 'complete', 'real pre-fix completion reached');
    await sf.promoteSimpleFinWindows(f.env, { now: NOW });
    assert.equal(f.first('SELECT state FROM bank_feed_backfill').state, 'running',
      'cross-revision incomplete receipt reopens completed progress');
    assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next, '2026-11-05');
  }
  const retries = [];
  if (historyOnly) {
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes('ORDER BY window_start,window_end LIMIT 1')) return statement;
      return { bind: (...values) => {
        const bound = statement.bind(...values);
        return { ...bound, first: async () => {
          const retry = await bound.first();
          if (retry) retries.push([retry.window_start, retry.window_end]);
          return null;
        } };
      } };
    };
  }
  const corrected = structuredClone(f.payload);
  corrected.accounts[0].transactions.push({ id: 'omission-historical-receipt', posted: epoch('2026-10-20'),
    amount: '375.91', description: 'Historical settlement', payee: 'Fixture Buyer' });
  if (empty) {
    const replacement = structuredClone(f.payload);
    replacement.accounts[0].transactions = [];
    assert.equal((await f.pull(replacement)).items[0].ok, true);
    expectedStarts.push('2026-10-01');
    assert.equal(f.first(receiptSql, f.assignment.account_ref).complete, 1, 'explicit empty replacement resolves the exact interval');
  }
  for (let n = 0; n < 3; n++) assert.equal((await f.pull(corrected, sf, 'current', { filter: true })).items[0].ok, true);
  expectedStarts.push(empty ? '2026-11-02' : '2026-10-01', '2026-11-02', '2026-11-02');
  assert.deepEqual(f.windowCalls.filter(row => row.name === 'current').map(row =>
    new Date(row.from * 1000).toISOString().slice(0, 10)), expectedStarts,
  'omitted account must retry the unresolved interval before rolling history');
  assert.equal(f.calls.current, expectedStarts.length, 'all corrected request-filtered provider calls reached');
  if (historyOnly) assert.deepEqual(retries, [['2026-10-01', '2026-11-04']],
    'real retry selector witnesses the sole unresolved interval before isolating the history walk');
  const older = f.first("SELECT amount_minor,removed_at FROM fin_transactions WHERE external_id='omission-historical-receipt'");
  if (empty) assert.equal(older, null, 'explicit empty progress never invents a historical event');
  else {
    assert.equal(older.amount_minor, 37591, 'returning exact account recovers independent historical cents');
    assert.equal(older.removed_at, null);
    const broad = await f.review({ action: 'coverage', account_ref: f.assignment.account_ref,
      from: '2026-10-01', to: '2026-11-04', dry_run: true });
    assert.equal(broad.blocked, false);
    assert.equal(broad.transaction_count, 2, 'recovered historical owner comparison is nonempty');
  }
  assert.equal(f.first('SELECT coverage_status FROM fin_account_coverage').coverage_status, 'partial',
    'automatic recovery still waits for owner completeness approval');
  const options = { action: 'coverage', account_ref: f.assignment.account_ref, from: '2026-11-02', to: '2026-11-04' };
  const preview = await f.review({ ...options, dry_run: true });
  assert.equal(preview.blocked, false);
  assert.equal(preview.transaction_count, 1, 'recent green control reaches owner comparison');
  assert.equal((await f.review({ ...options, dry_run: false, approve: preview.plan_hash, confirm_source_comparison: true })).complete, true);
  const before = f.first('SELECT total_changes() n').n, sqlStart = f.seen.sql.length;
  const answer = await (await withLedgerAnswer({ env: f.env, now: Date.parse(NOW),
    question: 'Did the payment of $491.83 arrive this week?', grantScope: { all: true }, scopePrincipalKind: 'owner' },
  async gap => Response.json({ answer: null, gaps: gap ? [gap] : [], citations: [] }))).json();
  assert.equal(answer.ledger?.found, true, 'recent affirmative payment green control');
  assert.ok(answer.citations.some(row => row.amount_minor === 49183));
  assert.ok(f.seen.sql.slice(sqlStart).some(sql => /FROM fin_transactions/.test(sql)), 'real payment SQL reached');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'answer remains read only');
  const final = f.first(receiptSql, f.assignment.account_ref);
  assert.equal(final.complete, 1);
  assert.equal(final.revision, final.parent_revision, 'complete replacement retains the exact revision fence');
  assert.equal(final.backfill_next, '2026-11-05');
  assert.equal(f.first('SELECT state FROM bank_feed_backfill').state, 'complete');
}

for (const omissions of [1, 2]) for (const control of [false, true])
  test(`SimpleFIN unresolved account survives ${omissions} response revisions, present control=${control}`,
    t => omittedAccountReplay(t, currentFeed, { omissions, control }));
for (const control of [false, true])
  test(`SimpleFIN unresolved account owner disconnect, present control=${control}`,
    t => omittedAccountReplay(t, currentFeed, { disconnect: true, control }));
test('SimpleFIN omitted account explicit empty replacement progresses', t => omittedAccountReplay(t, currentFeed, { empty: true }));
test('SimpleFIN promoted cross-revision incomplete receipt remains retryable', t => omittedAccountReplay(t, currentFeed, { retained: true }));
test('SimpleFIN verified-history walk rejects cross-revision incomplete receipts',
  t => omittedAccountReplay(t, currentFeed, { retained: true, historyOnly: true }));

for (const name of ['omission discharges work', 'revision advance clears interval']) {
  test(`SimpleFIN omission mutant killed and restored: ${name}`, async t => {
    await omittedAccountReplay(t);
    const original = readFileSync(feedUrl, 'utf8');
    let source;
    if (name === 'omission discharges work') {
      const decision = 'AND incomplete.complete=0)';
      assert.equal(original.split(decision).length, 2, 'one durable unresolved-account decision reached');
      source = original.replace(decision, 'AND incomplete.revision=${windowAlias}.revision AND incomplete.complete=0)');
    } else {
      const decision = '  // Usable rows and balances survive, but a missing array or an out-of-window';
      assert.equal(original.split(decision).length, 2, 'one account-receipt publication decision reached');
      source = original.replace(decision, `  await revisionBatch(env, tenantId, window, [env.DB.prepare(
        \`UPDATE simplefin_account_windows SET complete=1
          WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=? AND revision<>?\`)
        .bind(tenantId, window.item_ref, window.window_start, window.window_end, window.revision)]);
${decision}`);
    }
    const mutant = (await moduleCopy(t, feedUrl, source)).module;
    const signature = name === 'omission discharges work' ? /omission must not promote unresolved work/ :
      /revision advance must retain the incomplete receipt/;
    await assert.rejects(omittedAccountReplay(t, mutant),
      error => error.code === 'ERR_ASSERTION' && signature.test(error.message),
      'named omission mutant must fail at its durable decision assertion');
    assert.equal(readFileSync(feedUrl, 'utf8'), original, 'each named omission mutant is restored');
  });
}

for (const name of ['any reappearance restores', 'owner evidence overwritten', 'tombstones cleared']) {
  test(`SimpleFIN legacy named mutant killed and restored: ${name}`, async t => {
    const replay = name === 'any reappearance restores' ? unreadReplay :
      (scope, sf) => protectedReplay(scope, sf, name === 'tombstones cleared');
    await replay(t, currentFeed);
    const original = readFileSync(reconciliationUrl, 'utf8');
    let changed;
    if (name === 'any reappearance restores') {
      const start = original.indexOf('  const readableIds = new Set('), end = original.indexOf('\n  const legacy =', start);
      assert.ok(start > 0 && end > start, 'one readable-posted decision reached');
      changed = original.slice(0, start) + '  const readableIds = currentIds;' + original.slice(end);
    } else if (name === 'owner evidence overwritten') {
      const before = 'SET removed_at=NULL,removal_reason=NULL';
      assert.equal(original.split(before).length, 2, 'one marker-only restoration decision reached');
      changed = original.replace(before, "SET removed_at=NULL,removal_reason=NULL,category=NULL,category_basis_state='proposed'");
    } else {
      const reason = "row.removal_reason === 'Absent from verified SimpleFIN posted history'";
      assert.equal(original.split(reason).length, 2, 'one withdrawal-reason decision reached');
      changed = original.replace(reason, 'true')
        .replace("AND removal_reason='Absent from verified SimpleFIN posted history'", 'AND 1');
    }
    const reconciliation = await moduleCopy(t, reconciliationUrl, changed);
    const sf = (await moduleCopy(t, feedUrl, undefined, { './simplefin-reconciliation.js': reconciliation.url })).module;
    const signature = name === 'any reappearance restores' ? /unread, pending or absent evidence must retain/ :
      name === 'owner evidence overwritten' ? /owner evidence must survive/ : /other withdrawal reasons must survive/;
    await assert.rejects(replay(t, sf), error => error.code === 'ERR_ASSERTION' && signature.test(error.message),
      'named mutant must fail its financial preservation assertion');
    assert.equal(readFileSync(reconciliationUrl, 'utf8'), original, 'each named mutant is restored');
  });
}

for (const name of ['incomplete listing advances cursor', 'recovery skips promoted incomplete receipt']) {
  test(`SimpleFIN structural mutant killed and restored: ${name}`, async t => {
    const retained = name === 'recovery skips promoted incomplete receipt';
    await incompleteListingReplay(t, currentFeed, 'transactions-omitted', retained);
    const original = readFileSync(feedUrl, 'utf8');
    const before = 'function accountListingsCompleteSql(windowAlias = "w") {';
    assert.equal(original.split(before).length, 2, 'one shared durable receipt decision reached');
    let source;
    if (retained) {
      const start = original.indexOf('async function requestWindow('), end = original.indexOf('\nasync function readAccessUrl', start);
      assert.ok(start > 0 && end > start, 'live scheduler body reached');
      const scheduler = original.slice(start, end), decision = '${accountListingsCompleteSql()}';
      assert.equal(scheduler.split(decision).length, 3, 'retry selection and verified history both inspect account receipts');
      source = original.slice(0, start) + scheduler.replaceAll(decision, '1') + original.slice(end);
    } else {
      source = original.replace(before, `${before} return '1';`);
      const refusal = 'if (unread || coverage.some(account => !account.complete))';
      assert.equal(source.split(refusal).length, 2, 'one incomplete publication refusal reached');
      source = source.replace(refusal, 'if (false)');
    }
    const mutant = (await moduleCopy(t, feedUrl, source)).module;
    const signature = retained ? /oldest incomplete interval is retried/ : /incomplete listing must not advance/;
    await assert.rejects(incompleteListingReplay(t, mutant, 'transactions-omitted', retained),
      error => error.code === 'ERR_ASSERTION' && signature.test(error.message), 'named mutant must fail its scheduler assertion');
    assert.equal(readFileSync(feedUrl, 'utf8'), original, 'named structural mutant is restored');
  });
}

// The review's pre-commit fault happens after durable staging but before the
// final account receipt. Keep the real schema59 import, migrations and owner
// identity binding so a synthetic receipt cannot hide that ordering gap.
async function interruptedReceiptReplay(t, sf = currentFeed, {
  mode = 'before-commit-omission', prime = false, population = 1,
} = {}) {
  const f = await legacyFixture(t, { sf, amountMinor: 49183 });
  await f.upgrade();
  f.payload.accounts[0].balance = '751.39';
  for (let index = 1; index < population; index++) f.payload.accounts.push({
    ...structuredClone(f.payload.accounts[0]), id: `chunk-account-${String(index).padStart(3, '0')}`,
    balance: '0.00', transactions: [],
  });
  const interval = "window_start='2026-10-01' AND window_end='2026-11-04'";
  const receipt = () => f.first(`SELECT * FROM simplefin_account_windows WHERE ${interval} AND account_ref=?`, f.assignment.account_ref);
  const parent = () => f.first(`SELECT state,revision,staging_revision FROM simplefin_sync_windows WHERE ${interval}`);
  const originalBatch = f.env.DB.batch.bind(f.env.DB);
  if (prime || population > 1) {
    // Commit complete per-account receipts, then interrupt the final parent
    // transaction. The next real request must replace this exact interval.
    let primeDecision = 0;
    f.env.DB.batch = async statements => {
      if (statements.some(s => s.sql.includes("SET state='promoted',promoted_at=?"))) {
        primeDecision++;
        throw Error('injected parent promotion interruption');
      }
      return originalBatch(statements);
    };
    if (population === 1) assert.equal((await f.pull()).items[0].ok, false);
    else {
      assert.equal((await f.pull()).items[0].ok, true, 'real multi-account discovery waits for assignment');
      const assignments = f.rows('SELECT account_ref FROM simplefin_account_assignments WHERE entity_slug IS NULL ORDER BY account_ref');
      assert.equal(assignments.length, population - 1);
      for (const [index, row] of assignments.entries()) {
        const assign = () => sf.assignSimpleFinAccountEntity(f.env, {
          request_id: `interrupt-assignment-${index}`, account_ref: row.account_ref, entity_slug: 'owner-business',
        }, { now: NOW });
        if (index === assignments.length - 1) await assert.rejects(assign, /injected parent promotion interruption/);
        else assert.equal((await assign()).body.ok, true);
      }
    }
    assert.equal(primeDecision, 1, 'complete receipt replacement reaches real final parent publication');
    assert.equal(receipt().complete, 1, 'existing complete receipt is a real publication, not a fabricated row');
    assert.equal(f.first(`SELECT count(*) n FROM simplefin_account_windows WHERE ${interval}`).n, population);
    assert.equal(parent().state, 'staged');
  } else assert.equal(receipt(), null, 'review input starts without an account receipt for this interval');
  f.env.DB.batch = originalBatch;
  const incomplete = structuredClone(f.payload);
  delete incomplete.accounts[0].transactions;
  const chunk = population > 50 ? 2 : 1;
  let decision = 0, faultReached = 0, maxBatch = 0;
  const stageFault = mode.includes('stage-publication');
  f.env.DB.batch = async statements => {
    maxBatch = Math.max(maxBatch, statements.length);
    const target = stageFault ? statements.some(s => s.sql.includes('AS completeness_guard')) :
      statements.some(s => s.sql.includes('INSERT INTO simplefin_account_windows')) &&
      statements[0].sql.includes("AND w.revision=? AND w.state='staged'");
    if (target && ++decision === (stageFault ? 1 : chunk) && mode !== 'uninterrupted-omission') {
      faultReached++;
      if (mode.startsWith('after-')) {
        await originalBatch(statements);
        throw Error('injected committed response loss');
      }
      if (mode.startsWith('during-')) {
        const seen = f.seen.sql.length;
        f.control.failOn = /INSERT INTO simplefin_account_windows/;
        try { return await originalBatch(statements); }
        finally {
          f.control.failOn = null;
          assert.ok(f.seen.sql.slice(seen).some(sql => sql.includes('AS revision_guard')),
            'rollback fault executes the real transactional revision guard');
          assert.ok(f.seen.sql.slice(seen).some(sql => sql.includes('INSERT INTO simplefin_account_windows')),
            'rollback fault reaches the actual receipt statement');
        }
      }
      throw Error('injected receipt publication interruption');
    }
    return originalBatch(statements);
  };
  const currentBefore = f.calls.current;
  assert.equal((await f.pull(incomplete)).items[0].ok, mode === 'uninterrupted-omission');
  assert.equal(decision, stageFault ? 1 : Math.ceil(population / 50), 'requested publication fault point reached');
  assert.equal(faultReached, mode === 'uninterrupted-omission' ? 0 : 1);
  assert.equal(f.first(`SELECT transactions_present FROM simplefin_stage_accounts WHERE ${interval} AND provider_account_id=?`,
    f.assignment.provider_account_id).transactions_present, 0, 'incomplete observation is durably staged');
  assert.ok(parent().state === 'staged' || parent().revision !== parent().staging_revision,
    'interruption leaves staged or unpublished replacement work');
  f.env.DB.batch = originalBatch;
  const second = mode.endsWith('-present') ? incomplete : { accounts: [], errlist: [] };
  assert.equal((await f.pull(second)).items[0].ok, true);
  const middle = parent(), cursor = f.first('SELECT backfill_next FROM simplefin_connections').backfill_next;
  const corrected = structuredClone(f.payload);
  corrected.accounts[0].transactions.push({ id: 'interruption-historical-settlement', posted: epoch('2026-10-20'),
    amount: '375.91', description: 'Historical settlement', payee: 'Fixture Buyer' });
  for (let index = 0; index < 3; index++)
    assert.equal((await f.pull(corrected, sf, 'current', { filter: true })).items[0].ok, true);
  assert.equal(f.calls.current - currentBefore, 5, 'all five real injected-provider requests reached');
  const starts = f.windowCalls.filter(row => row.name === 'current').slice(currentBefore)
    .map(row => new Date(row.from * 1000).toISOString().slice(0, 10));
  assert.deepEqual(starts.slice(0, 2), ['2026-10-01', '2026-10-01']);
  assert.ok(maxBatch <= 51, 'all measured receipt and staging batches remain bounded');
  const broad = await f.review({ action: 'coverage', account_ref: f.assignment.account_ref,
    from: '2026-10-01', to: '2026-11-04', dry_run: true });
  const recent = { action: 'coverage', account_ref: f.assignment.account_ref, from: '2026-11-02', to: '2026-11-04' };
  const preview = await f.review({ ...recent, dry_run: true });
  assert.equal(preview.blocked, false);
  assert.equal(preview.transaction_count, 1, 'affirmative recent owner comparison reached');
  assert.equal(f.first('SELECT coverage_status FROM fin_account_coverage WHERE account_slug=?', f.original.account_slug).coverage_status,
    'partial', 'automatic repair still requires owner completeness approval');
  assert.equal((await f.review({ ...recent, dry_run: false, approve: preview.plan_hash, confirm_source_comparison: true })).complete, true);
  for (const row of f.rows('SELECT account_ref FROM simplefin_account_assignments WHERE account_ref<>?', f.assignment.account_ref)) {
    const scope = { ...recent, account_ref: row.account_ref };
    const plan = await f.review({ ...scope, dry_run: true });
    assert.equal(plan.blocked, false, 'chunk peers reach the same explicit owner completeness decision');
    assert.equal((await f.review({ ...scope, dry_run: false, approve: plan.plan_hash, confirm_source_comparison: true })).complete, true);
  }
  const before = f.first('SELECT total_changes() n').n, sqlStart = f.seen.sql.length;
  const ask = async question => (await withLedgerAnswer({ env: f.env, now: Date.parse(NOW), question,
    grantScope: { all: true }, scopePrincipalKind: 'owner' },
  async gap => Response.json({ answer: null, gaps: gap ? [gap] : [], citations: [] }))).json();
  const payment = await ask('Did the payment of $491.83 arrive this week?');
  assert.equal(payment.ledger?.found, true);
  assert.ok(payment.citations.some(row => row.amount_minor === 49183), 'independent recent payment cents remain cited');
  assert.ok(f.seen.sql.slice(sqlStart).some(sql => /FROM fin_transactions/.test(sql)), 'real payment decision reached');
  const balances = await ask('What are my account balances?');
  assert.deepEqual(balances.ledger.accounts.map(row => row.current_minor).sort((a, b) => a - b),
    [...Array(population - 1).fill(0), 75139], 'independent current balances remain answerable');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'answers remain read only');
  assert.deepEqual(f.first("SELECT id,txn_uid,account_slug,source_feed,external_id,amount_minor FROM fin_transactions WHERE external_id='retained-event'"),
    f.original, 'original source identity and independent cents survive every interruption arm');
  const historical = f.first("SELECT amount_minor,removed_at FROM fin_transactions WHERE external_id='interruption-historical-settlement'");
  t.diagnostic(JSON.stringify({ mode, prime, population, decision, faultReached, maxBatch,
    afterOmission: middle.state, cursor, starts, historical: historical?.amount_minor ?? null, broadBlocked: broad.blocked }));
  assert.equal(starts[2], '2026-10-01', 'interrupted publication must retain durable retry work after omission');
  assert.equal(middle.state, 'staged');
  assert.equal(cursor, '2026-10-01');
  assert.equal(historical?.amount_minor, 37591);
  assert.equal(historical.removed_at, null);
  assert.equal(broad.blocked, false);
  assert.equal(broad.transaction_count, 2);
  assert.equal(receipt().complete, 1);
  assert.equal(receipt().revision, parent().revision, 'complete replacement has exact revision identity');
}

for (const mode of ['uninterrupted-omission', 'before-commit-present', 'after-commit-omission', 'before-commit-omission',
  'during-commit-omission', 'before-stage-publication-omission', 'after-stage-publication-omission'])
  test(`SimpleFIN receipt interruption ${mode}`, t => interruptedReceiptReplay(t, currentFeed, { mode }));
for (const population of [1, 55]) for (const mode of ['before-commit-omission', 'during-commit-omission', 'after-commit-omission'])
  test(`SimpleFIN receipt interruption replaces complete receipts, accounts=${population}, ${mode}`,
    t => interruptedReceiptReplay(t, currentFeed, { mode, prime: true, population }));

for (const name of ['publish before durable work record', 'interrupt drops retry'])
  test(`SimpleFIN interruption mutant killed and restored: ${name}`, async t => {
    await interruptedReceiptReplay(t);
    const original = readFileSync(feedUrl, 'utf8');
    let source;
    if (name === 'publish before durable work record') {
      const record = `    statements.push(...simpleFinCoverageStatements(env, { tenantId, itemRef, window,
      accounts: [{ account_ref: ref, complete: false }], stamp }));`;
      assert.equal(original.split(record).length, 2, 'one pre-publication durable work record reached');
      // Delay the only durable account record until final receipt publication,
      // recreating the review's publication-before-record ordering.
      source = original.replace(record, '');
    } else {
      const catchPoint = '      const code = error instanceof SimpleFinError ? error.code : "simplefin_pull_unavailable";';
      assert.equal(original.split(catchPoint).length, 2, 'one maintenance interruption recovery decision reached');
      source = original.replace(catchPoint, `      await env.DB.prepare(
        \`DELETE FROM simplefin_account_windows WHERE tenant_id=? AND item_ref=? AND complete=0\`
      ).bind(tenantId, connection.item_ref).run();
${catchPoint}`);
    }
    const mutant = (await moduleCopy(t, feedUrl, source)).module;
    await assert.rejects(interruptedReceiptReplay(t, mutant),
      error => error.code === 'ERR_ASSERTION' && /interrupted publication must retain durable retry work/.test(error.message),
      'named mutant must fail the witnessed historical retry decision after green money controls');
    assert.equal(readFileSync(feedUrl, 'utf8'), original, 'each named interruption mutant is restored');
  });
