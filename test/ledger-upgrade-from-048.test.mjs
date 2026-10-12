import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { cmdMigrate, cmdLedger, splitStatements } from '../brain.mjs';
import worker from '../worker/src/index.js';
import { importBankExport } from './fixtures/ledger-schema48/fin-import.mjs';

// 048 means schema 48, not product 0.4.8. There was no public 0.4.9 tag.
// These exact bytes are in both 0d9126246b8f791e4a9d57c2c80e873882455a06
// (the supervised 0.4.9 kit lineage) and eac2d9396658c35d8c28607f2caf2edba10e4745.
// Keep the historical writer frozen: importing today's writer would hide the
// row-number identities this upgrade must repair. No Git is needed in CI.
const PREFIX = 48;
const PREFIX_SHA = 'abd9fe29f4da753f3ce78275d51d0dc27a0ce21546589b7ee03764253afa7f8e';
const WRITER_SHA = 'c7ca841b2093b857f080e6279775f8690ae65be95093f3d97a095e058d3f95cc';
const NOW = '2026-10-11T12:00:00.000Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const migrationDir = new URL('../migrations/d1/', import.meta.url);
const migrations = readdirSync(migrationDir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort().map(file => {
  const sql = readFileSync(new URL(file, migrationDir), 'utf8');
  return { file, sql, version: Number(file.slice(0, 4)), checksum: sha(sql).slice(0, 16) };
});

// Only the D1 transport is replaced. SQL, transactional guards, CLI handlers,
// authentication, maintenance receipts and Think all execute product code.
function database() {
  const sqlite = new DatabaseSync(':memory:'), seen = [];
  const execute = (sql, binds, mode) => {
    seen.push(sql);
    const statement = sqlite.prepare(sql);
    if (mode === 'first') return statement.get(...binds) ?? null;
    if (mode === 'all') return { results: statement.all(...binds) };
    const result = statement.run(...binds);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  };
  const prepare = (sql, binds = []) => ({ sql, binds, bind: (...args) => prepare(sql, args),
    first: async () => execute(sql, binds, 'first'), all: async () => execute(sql, binds, 'all'),
    run: async () => execute(sql, binds, 'run') });
  const DB = { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(s => execute(s.sql, s.binds, /^\s*(SELECT|WITH|PRAGMA)\b/i.test(s.sql) ? 'all' : 'run'));
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, seen, DB, rows: (sql, ...args) => sqlite.prepare(sql).all(...args),
    raw: (sql, ...args) => sqlite.prepare(sql).run(...args) };
}

const durableTables = ['fin_entities', 'fin_accounts', 'fin_account_coverage', 'fin_statements',
  'fin_balance_snapshots', 'fin_transactions', 'fin_obligations'];
function snapshot(f, omitIdentity = false) {
  return JSON.stringify(Object.fromEntries(durableTables.map(table => [table,
    f.rows(`SELECT * FROM ${table} ORDER BY id`).map(row => {
      if (omitIdentity && table === 'fin_transactions') delete row.txn_uid;
      return row;
    })])));
}
const totals = f => JSON.stringify(f.rows(`SELECT account_slug,COUNT(*) n,
  SUM(amount_minor) cents,SUM(raw_amount_minor) raw_cents,
  SUM(CASE direction WHEN 'inflow' THEN amount_minor ELSE -amount_minor END) signed_cents
  FROM fin_transactions GROUP BY account_slug ORDER BY account_slug`));

function txn(day, cents, description, index, live = false) {
  return { postedOn: day, amountMinor: Math.abs(cents), direction: cents < 0 ? 'outflow' : 'inflow',
    rawAmountMinor: live ? -cents : cents, description, locator: `line:${index}`, currency: 'USD',
    ...(live ? { externalId: `feed-${index}` } : {}) };
}
async function seedLegacy(f) {
  const overlap = live => [txn('2026-09-15', 12001, 'Synthetic payer deposit', 2101, live),
    txn('2026-09-16', -2300, 'Office supplies', 2102, live),
    txn('2026-09-20', -7001, 'Transfer to savings account 9876', 2103, live)];
  const filler = Array.from({ length: 2100 }, (_, i) => txn('2026-08-15',
    i < 2 ? -100 : (i % 2 ? -1 : 1) * (100 + i), 'Synthetic activity', i + 1));
  for (const [slug, kind, mask, live, transactions] of [
    ['manual-account', 'checking', '4321', false, [...filler, ...overlap(false)]],
    ['live-account', 'checking', '4321', true, overlap(true)],
    ['reserve-account', 'savings', '9876', true, [txn('2026-09-20', 7001, 'Transfer from checking account 4321', 1, true)]],
  ]) {
    const envelope = { ok: true, sourceDocUid: 'upload:synthetic-export', sourceLabel: 'synthetic.csv',
      currency: 'USD', signConvention: live ? 'positive_is_outflow' : 'negative_is_outflow',
      accounts: [{ accountKey: slug, accountKind: kind, balanceRole: 'asset', mask, currency: 'USD',
        institution: 'Synthetic Bank', externalRef: slug, periodStart: live ? '2026-09-01' : '2026-08-01',
        periodEnd: '2026-09-30', ledgerBalanceMinor: live ? 98765 : 87654,
        balanceAsOf: live ? '2026-09-30' : '2026-09-29', transactions }] };
    const receipt = await importBankExport({ DB: f.DB }, envelope, { entitySlug: 'owner-company', now: NOW,
      ...(live ? { origin: { provenance: 'feed', sourceFeed: 'bank-feed:synthetic-feed' } } : {}) });
    assert.equal(receipt.imported, true); assert.equal(receipt.transactions, transactions.length);
  }
  // These are owner review facts supported by schema 48. The old importer
  // deliberately writes partial coverage and does not assign categories.
  f.raw("UPDATE fin_entities SET relationship='owned'");
  f.raw("UPDATE fin_account_coverage SET coverage_status='complete',provenance='owner_stated'");
  f.raw("UPDATE fin_transactions SET category='Office',category_basis_state='confirmed' WHERE description='Office supplies'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,
    provenance,basis_state,recorded_at) VALUES ('loan-account','owner-company','loan','liability','9999','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,computed_at,provenance,basis_state,recorded_at)
    VALUES ('loan-account','missing',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.raw(`INSERT INTO fin_obligations (obligation_uid,entity_slug,kind,account_slug,principal_minor,
    balance_minor,balance_as_of,payment_minor,payment_cadence,provenance,basis_state,recorded_at)
    VALUES ('owner-loan','owner-company','loan','loan-account',2500000,1234567,'2026-09-30',34567,'monthly','owner_stated','confirmed',?)`, NOW);
}

test('populated schema 48 survives the candidate migration and approved money maintenance', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  let network = 0, processes = 0, launchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('network forbidden'); });
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    t.mock.method(childProcess, method, () => { processes++; throw new Error('host tool forbidden'); });
  }
  syncBuiltinESMExports();
  t.after(() => {
    assert.equal(network, 0); assert.equal(processes, 0); assert.equal(launchCalls, 0);
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ledger-upgrade-')));
  const f = database();
  t.after(() => { f.sqlite.close(); rmSync(home, { recursive: true, force: true }); });
  const manifestPath = join(home, 'synthetic.manifest.json'), keyPath = join(home, 'fixture-admin-key');
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  const manifest = { client: { slug: 'synthetic-owner' }, brain: { domain: 'brain.invalid', version: '0.4.9' },
    admin_key_file: keyPath, infrastructure: { cloudflare: { storage: 'd1', d1_database_id: 'synthetic-database' } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let modelCalls = 0;
  const env = { DB: f.DB, STORAGE_BACKEND: 'd1', ADMIN_KEY: readFileSync(keyPath, 'utf8'),
    VECTORIZE: { query: async () => ({ matches: [] }) },
    AI: { run: async model => { modelCalls++; if (model.includes('bge-')) return { data: [[0.1, 0.2]] };
      return { response: 'No supporting documents.' }; } } };
  const routeCalls = [];
  const deps = { loadManifest: () => ({ m: JSON.parse(readFileSync(manifestPath, 'utf8')) }),
    resolveAdminKey: () => readFileSync(keyPath, 'utf8'), write: () => {},
    launchctl: () => { launchCalls++; throw new Error('launch forbidden'); },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).hostname, 'brain.invalid'); assert.equal(init.redirect, 'error');
      routeCalls.push(JSON.parse(init.body));
      return worker.fetch(new Request(url, init), env, {});
    } };
  const ask = async q => {
    const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY },
      body: JSON.stringify({ q }),
    }), env, {});
    assert.equal(response.status, 200);
    return response.json();
  };
  let baseline, money;
  await t.test('historical prefix and writer seed real legacy identities before migration', async () => {
    const prefix = migrations.filter(m => m.version <= PREFIX);
    assert.equal(prefix.length, 48);
    assert.equal(sha(prefix.map(m => `${m.file}:${sha(m.sql)}\n`).join('')), PREFIX_SHA);
    assert.equal(sha(readFileSync(new URL('./fixtures/ledger-schema48/fin-import.mjs', import.meta.url))), WRITER_SHA);
    for (const m of prefix) {
      for (const sql of splitStatements(m.sql)) f.sqlite.exec(sql);
      f.raw('INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (?,?,?,?)',
        m.version, m.file.slice(0, -4), NOW, m.checksum);
    }
    f.raw(`INSERT INTO install_state (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
      VALUES (1,'synthetic-owner','0.4.9',48,0,?,'test')`, NOW);
    assert.equal(f.rows('SELECT MAX(version) v FROM schema_migrations')[0].v, 48);
    assert.equal(f.rows("SELECT name FROM sqlite_master WHERE name='fin_account_links'").length, 0);
    await seedLegacy(f);
    assert.equal(f.rows('SELECT COUNT(*) n FROM fin_transactions')[0].n, 2107);
    assert.equal(f.rows("SELECT COUNT(*) n FROM fin_transactions WHERE txn_uid LIKE 'manual-account:line:%'")[0].n, 2103);
    assert.equal(f.rows("SELECT COUNT(*) n FROM fin_transactions WHERE category_basis_state='confirmed'")[0].n, 2);
    assert.equal(f.rows("SELECT COUNT(*) n FROM fin_account_coverage WHERE covered_from IS NULL AND covered_to IS NULL")[0].n, 1);
    baseline = snapshot(f); money = totals(f);
  });
  const migrationCalls = [];
  const migrate = () => cmdMigrate(manifestPath, { silent: true, migrationIntentDirectory: join(home, 'intents'),
    resolveAccount: async () => ({ id: 'synthetic-account' }),
    d1Query: async (_account, _database, sql, params = []) => {
      migrationCalls.push({ sql, params });
      if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) return { results: f.rows(sql, ...params) };
      if (params.length) f.raw(sql, ...params); else f.sqlite.exec(sql);
      return { results: [] };
    } });
  await t.test('the update migration handler preserves every legacy byte and is restart safe', async () => {
    const pending = migrations.filter(m => m.version > PREFIX);
    assert.deepEqual(pending.slice(0, 7).map(m => m.version), [49, 50, 51, 52, 53, 54, 55]);
    const receipt = await migrate();
    assert.equal(receipt.applied, pending.length); assert.equal(receipt.schemaVersion, migrations.at(-1).version);
    assert.equal(snapshot(f), baseline); assert.equal(totals(f), money);
    assert.deepEqual(f.rows('SELECT version,checksum FROM schema_migrations ORDER BY version').map(r => ({ ...r })),
      migrations.map(m => ({ version: m.version, checksum: m.checksum })));
    assert.equal(f.rows('SELECT schema_version FROM install_state')[0].schema_version, migrations.at(-1).version);
    assert.equal(f.rows('SELECT product_version FROM install_state')[0].product_version, '0.4.9',
      'migration alone must not claim a verified deployment');
    assert.deepEqual(migrationCalls.filter(c => /INSERT INTO schema_migrations/.test(c.sql)).map(c => c.params[0]), pending.map(m => m.version));
    assert.equal((await migrate()).applied, 0); assert.equal(snapshot(f), baseline);
    assert.equal(f.rows('PRAGMA integrity_check')[0].integrity_check, 'ok');
  });
  await t.test('real rekey CLI and authenticated Worker cross the 2000-row page boundary', async () => {
    const args = ['rekey', manifestPath, '--account', 'manual-account'];
    const invariant = snapshot(f, true), pages = [];
    for (let page = 0; page < 4; page++) {
      const before = snapshot(f);
      const preview = await cmdLedger([...args, '--preview'], deps);
      assert.equal(preview.blocked, false); assert.equal(preview.mutation_count, 0);
      assert.equal(snapshot(f), before, 'preview reads a populated plan without writing');
      if (!preview.candidate_count) { assert.equal(preview.complete, true); break; }
      assert.ok(preview.candidate_count > 0 && preview.candidate_count <= 2000);
      const reached = routeCalls.length;
      await assert.rejects(cmdLedger([...args, '--apply', '--approve', '0'.repeat(64)], deps), /stale/);
      assert.equal(routeCalls.length, reached + 1); assert.equal(snapshot(f), before);
      const done = await cmdLedger([...args, '--apply', '--approve', preview.plan_hash], deps);
      assert.equal(done.mutation_count, preview.candidate_count); pages.push(done.mutation_count);
      assert.equal(totals(f), money); assert.equal(snapshot(f, true), invariant);
      assert.equal(f.rows('SELECT COUNT(DISTINCT txn_uid) n FROM fin_transactions')[0].n, 2107);
      assert.equal(done.complete, page === 1); assert.equal(done.has_more, page === 0);
    }
    assert.deepEqual(pages, [2000, 103]);
    assert.equal(f.rows("SELECT COUNT(*) n FROM fin_transactions WHERE txn_uid LIKE 'manual-account:line:%'")[0].n, 0);
    assert.equal(f.rows("SELECT COUNT(*) n FROM fin_transactions WHERE account_slug='manual-account' AND amount_minor=100")[0].n, 2,
      'two identical charges retain their multiplicity across identity repair');
  });
  const monthQuestion = 'How much money came in and went out in September 2026 for account 4321?';
  await t.test('unlinked twins refuse, then exact CLI approval permits single-count precedence', async () => {
    const before = snapshot(f), start = f.seen.length;
    const refusal = await ask(monthQuestion);
    assert.equal(refusal.code, 'ledger_account_link_required'); assert.equal(refusal.answer, null);
    assert.ok(f.seen.slice(start).some(sql => sql.includes('FROM fin_accounts')));
    const args = ['link-accounts', manifestPath, '--manual', 'manual-account', '--live', 'live-account'];
    const preview = await cmdLedger([...args, '--preview'], deps);
    assert.equal(preview.accounts.length, 2); assert.equal(preview.blocked, false);
    assert.equal(preview.mutation_count, 0); assert.equal(snapshot(f), before);
    const calls = routeCalls.length;
    await assert.rejects(cmdLedger([...args, '--apply', '--approve', '0'.repeat(64)], deps), /stale/);
    assert.equal(routeCalls.length, calls + 1); assert.equal(f.rows('SELECT * FROM fin_account_links').length, 0);
    const done = await cmdLedger([...args, '--apply', '--approve', preview.plan_hash], deps);
    assert.equal(done.complete, true); assert.equal(done.mutation_count, 1);
    assert.equal(f.rows('SELECT * FROM fin_account_links').length, 1);
    assert.equal(snapshot(f), before); assert.equal(totals(f), money);
    const control = await ask(monthQuestion);
    assert.equal(control.ledger.accounts.length, 1);
    assert.equal(control.ledger.accounts[0].credits_minor, 12001);
    assert.equal(control.ledger.accounts[0].debits_minor, 9301);
  });
  await t.test('Think returns exact cents, refuses uncovered money, and retains transfer candidates', async () => {
    const before = snapshot(f), changes = f.rows('SELECT total_changes() n')[0].n;
    const models = modelCalls;
    const balance = await ask('What is my balance for account 4321?');
    assert.equal(balance.ledger.accounts[0].current_minor, 98765);
    assert.equal(balance.citations[0].amount_minor, 98765); assert.equal(balance.citations[0].supplied_by, 'live');
    const payment = await ask('Did the payment of $120.01 arrive on 2026-09-15 in account 4321?');
    assert.equal(payment.ledger.found, true); assert.equal(payment.ledger.amount_minor, 12001);
    assert.deepEqual(payment.citations.map(c => [c.amount_minor, c.account_mask]), [[12001, '4321']]);
    const amountDecision = f.seen.length;
    const absent = await ask('Did the payment of $120.02 arrive on 2026-09-15 in account 4321?');
    assert.equal(absent.ledger.found, false); assert.equal(absent.ledger.amount_minor, 12002);
    assert.ok(f.seen.slice(amountDecision).some(sql => sql.includes('fin_transactions')));
    const month = await ask(monthQuestion);
    assert.deepEqual(month.ledger.accounts.map(a => [a.credits_minor, a.debits_minor]), [[12001, 9301]]);
    const transfer = await ask('How much did I transfer between my own accounts in September 2026 for account 4321?');
    assert.equal(transfer.ledger.kind, 'transfers'); assert.equal(transfer.ledger.total_minor, 7001);
    assert.equal(transfer.ledger.candidate_transfer_count, 1); assert.equal(transfer.ledger.matched_transfer_count, 0);
    assert.equal(transfer.ledger.transfers[0].excluded_from_totals, false);
    assert.equal(transfer.ledger.includes_own_transfers, true);
    assert.deepEqual([transfer.ledger.transfers[0].outgoing.amount_minor,
      transfer.ledger.transfers[0].incoming.amount_minor], [7001, 7001]);
    const retained = await ask(monthQuestion);
    assert.deepEqual(retained.ledger.accounts.map(a => [a.credits_minor, a.debits_minor]), [[12001, 9301]]);
    assert.match(transfer.answer, /no rows were removed as transfers/);
    assert.equal(modelCalls, models, 'successful money answers never use model arithmetic');
    for (const question of ['How much money came in July 2026 for account 4321?',
      'How much money came in September 2026 for account 9999?']) {
      const start = f.seen.length;
      const refused = await ask(question);
      assert.equal(refused.gaps[0].reason, 'period_outside_coverage');
      assert.equal(refused.gaps[0].type, 'ledger_out_of_coverage'); assert.equal(refused.ledger, undefined);
      assert.ok(f.seen.slice(start).some(sql => sql.includes('FROM fin_accounts')));
    }
    assert.equal((await ask(monthQuestion)).ledger.accounts[0].debits_minor, 9301, 'covered green control after both refusals');
    assert.equal(snapshot(f), before); assert.equal(totals(f), money);
    assert.equal(f.rows('SELECT total_changes() n')[0].n, changes, 'Think reads never mutate financial rows');
  });
});
