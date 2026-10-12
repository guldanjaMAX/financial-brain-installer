import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { maintainAccountLink } from '../../../src/lib/fin-account-links.js';

export const NOW = '2026-10-11T12:00:00.000Z';

// Twin fixtures carry the same explicit approval required of owner accounts.
export async function linkAccounts(f, manualSlug = 'manual-account', liveSlug = 'live-account', unlink = false) {
  const args = { manualSlug, liveSlug, unlink, now: NOW };
  const plan = await maintainAccountLink(f.env, args);
  return maintainAccountLink(f.env, { ...args, dryRun: false, approve: plan.plan_hash });
}

export function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../migrations/d1/', import.meta.url);
  for (const file of readdirSync(migrations).filter(x => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const seen = [], queries = [];
  const execute = (sql, binds, mode) => {
    seen.push(sql);
    queries.push({ sql, binds });
    const statement = sqlite.prepare(sql);
    if (mode === 'first') return statement.get(...binds) ?? null;
    if (mode === 'all') return { results: statement.all(...binds) };
    const result = statement.run(...binds);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  };
  const prepare = (sql, binds = []) => ({
    sql, binds, bind: (...args) => prepare(sql, args),
    first: async () => execute(sql, binds, 'first'),
    all: async () => execute(sql, binds, 'all'),
    run: async () => execute(sql, binds, 'run'),
  });
  const DB = { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(s => execute(s.sql, s.binds,
        /^\s*(SELECT|WITH|PRAGMA)\b/i.test(s.sql) ? 'all' : 'run'));
      sqlite.exec('COMMIT');
      return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const raw = (sql, ...args) => sqlite.prepare(sql).run(...args);
  const rows = (sql, ...args) => sqlite.prepare(sql).all(...args);
  const first = (sql, ...args) => sqlite.prepare(sql).get(...args);
  raw(`INSERT INTO fin_entities (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('owner-company','Owner company','business','owned','owner_stated','confirmed',?)`, NOW);
  return { env: { DB }, DB, sqlite, raw, rows, first, seen, queries, close: () => sqlite.close() };
}

export function account(f, { slug = 'live-account', mask = '4321', mode = 'live', institution = 'Bank One', from = '2026-09-01', to = '2026-10-11', status = 'complete' } = {}) {
  f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,account_kind,balance_role,mask,institution,feed_mode,provenance,basis_state,recorded_at)
    VALUES (?,'owner-company','checking','asset',?,?,?,'owner_stated','confirmed',?)`, slug, mask, institution, mode, NOW);
  f.raw(`INSERT INTO fin_account_coverage
    (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES (?,?,?,?,?,'owner_stated','confirmed',?)`, slug, status, from, to, NOW, NOW);
}

export function transaction(f, { uid = 'credit-one', slug = 'live-account', day = '2026-09-15', amount = 123450, direction = 'inflow', pending = 0, removed = null, superseded = null } = {}) {
  f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,pending,removed_at,removal_reason,superseded_by_id,provenance,basis_state,recorded_at)
    VALUES (?,?,?,?,?,'Synthetic deposit',?,?,?,?,'owner_stated','confirmed',?)`,
  uid, slug, day, amount, direction, pending, removed, removed ? 'Synthetic withdrawal' : null, superseded, NOW);
}
