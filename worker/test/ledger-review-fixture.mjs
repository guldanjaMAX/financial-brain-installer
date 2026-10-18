import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

export const NOW = '2026-10-12T12:00:00.000Z';
export function fixture(t, { knownPayers = true, answer = withLedgerAnswer } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const dir = new URL('../../migrations/d1/', import.meta.url);
  const migrations = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of migrations) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.prepare(`INSERT INTO install_state (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
    VALUES (1,'fixture','0.0.0-test',?,0,?,'test')`).run(Math.max(...migrations.map(file => Number(file.slice(0, 4)))), NOW);
  const calls = [];
  const execute = (sql, params, mode) => {
    calls.push(sql);
    const statement = db.prepare(sql);
    if (mode === 'first') return statement.get(...params) ?? null;
    if (mode === 'all' || /\bRETURNING\b/i.test(sql) || /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) return { results: statement.all(...params), success: true };
    const result = statement.run(...params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  };
  const prepared = (sql, params = []) => ({ sql, params, bind: (...p) => prepared(sql, p),
    all: async () => execute(sql, params, 'all'), first: async () => execute(sql, params, 'first'), run: async () => execute(sql, params, 'run') });
  const env = { STORAGE: 'd1', DB: { prepare: prepared, async batch(statements) {
    db.exec('BEGIN');
    try { const out = statements.map(s => execute(s.sql, s.params)); db.exec('COMMIT'); return out; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } }, ADMIN_KEY: randomBytes(24).toString('hex'), SESSION_SIGNING_KEY: randomBytes(32).toString('hex'),
    VECTORIZE: { async upsert() { return {}; }, async deleteByIds() { return {}; } },
    AI: { async run() { return { data: [[0.1, 0.2]] }; } } };
  const raw = (sql, ...params) => db.prepare(sql).run(...params);
  if (knownPayers) seedKnownPayers({ raw }, ['Fixture Payer', 'Fixture Payerplus', 'Unrelated Payer', 'Synthetic payer', 'Fixture Bank', 'Fixture Sender', 'Fixture'], NOW);
  const first = (sql, ...params) => db.prepare(sql).get(...params);
  const rows = (sql, ...params) => db.prepare(sql).all(...params);
  const owner = (slug = 'owner') => raw(`INSERT INTO fin_entities (entity_slug,legal_name,display_label,kind,status,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,?,'business','active','owned','owner_stated','confirmed',?)`, slug, 'Synthetic owner', 'Synthetic owner', NOW);
  let documentCalls = 0;
  const ask = async question => {
    const response = await answer({ env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner' }, async gap => {
      documentCalls++;
      return Response.json({ route: 'documents', gaps: gap ? [gap] : [] });
    });
    return response.json();
  };
  return { env, calls, raw, first, rows, owner, ask, get documentCalls() { return documentCalls; } };
}

export function ledgerFixture(t, { legacy = false, ...options } = {}) {
  const f = fixture(t, options); f.owner();
  f.raw(`INSERT INTO bank_feed_items (item_ref,access_ciphertext,access_iv,environment,connected_at,last_synced_at)
    VALUES ('fixture-feed',?,?,'sandbox','2026-10-01T00:00:00.000Z',?)`, randomBytes(24).toString('base64'), randomBytes(12).toString('base64'), NOW);
  f.raw(`INSERT INTO bank_feed_backfill (item_ref,requested_days,state,queued_at,finished_at,provider_history_state)
    VALUES ('fixture-feed',730,'complete','2026-10-01T00:00:00.000Z',?,'HISTORICAL_UPDATE_COMPLETE')`, NOW);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('fixture-account','owner','checking','asset','1234','live','feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('fixture-account','complete',?,'2026-10-12',?,'feed','bank-feed:fixture-feed','confirmed',?)`, legacy ? null : '2024-01-01', NOW, NOW);
  f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
    VALUES ('fixture-account','2026-10-12',0,'feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
  f.add = (uid, description, payee, { date = '2026-10-05', cents = 2500, direction = 'inflow' } = {}) => f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
    VALUES (?,'fixture-account',?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`, uid, date, cents, direction, description, payee, NOW);
  return f;
}
