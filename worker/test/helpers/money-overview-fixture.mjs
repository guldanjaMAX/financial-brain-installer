import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const STAMP = '2025-12-31T18:00:00Z';
export function overviewFixture(t) {
  t.mock?.method(globalThis, 'fetch', async () => { throw new Error('endpoint contact forbidden'); });
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../../migrations/d1/', import.meta.url)).filter(n => n.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(`../../../migrations/d1/${name}`, import.meta.url), 'utf8'));
  t.after(() => db.close());
  const calls = [];
  const env = { STORAGE: 'd1', BRAIN_TIMEZONE: 'America/Los_Angeles', ADMIN_KEY: randomBytes(24).toString('hex'),
    SESSION_SIGNING_KEY: randomBytes(32).toString('hex'), DB: { prepare(sql) {
      calls.push(sql);
      const statement = binds => ({ all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }),
        first: async () => db.prepare(sql).get(...binds) ?? null });
      return { ...statement([]), bind: (...binds) => statement(binds) };
    } } };
  const run = (sql, ...binds) => {
    const result = db.prepare(sql).run(...binds);
    if (/^UPDATE bank_feed_items SET last_synced_at=/i.test(sql)) db.exec(`
      INSERT INTO bank_feed_health(tenant_id,item_ref,last_successful_sync_at,data_through)
      SELECT tenant_id,item_ref,last_synced_at,substr(last_synced_at,1,10) FROM bank_feed_items WHERE last_synced_at IS NOT NULL
      ON CONFLICT(tenant_id,item_ref) DO UPDATE SET last_successful_sync_at=excluded.last_successful_sync_at,data_through=excluded.data_through`);
    return result;
  };
  run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
    VALUES ('owner','Synthetic owner','household','owner_stated','confirmed',?)`, STAMP);
  const account = (slug, mode = 'manual', kind = 'checking', currency = 'USD', status = 'open') => run(
    `INSERT INTO fin_accounts(account_slug,entity_slug,label,mask,account_kind,balance_role,currency,feed_mode,status,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,'1234',?,?,?,?,?,'owner_stated','confirmed',?)`,
    slug, slug, kind, kind === 'card' ? 'liability' : 'asset', currency, mode, status, STAMP);
  const row = (uid, slug, day, cents, direction = 'inflow', extra = {}) => run(
    `INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,pending,removed_at,removal_reason,superseded_by_id,description,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, uid, slug, day, cents, direction, extra.currency ?? 'USD',
    Number(extra.pending ?? false), extra.removed ? STAMP : null, extra.removed ? 'removed' : null,
    extra.superseded ? 1 : null, extra.description ?? null, STAMP);
  const coverage = (slug, from, to, status = 'complete', basis = 'confirmed') => run(
    `INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,'owner_stated',?,?)`, slug, status, from, to, STAMP, basis, STAMP);
  const connection = (slug, provider = 'plaid', status = 'connected', environment = 'production') => {
    const ref = (provider === 'plaid' ? 'acct_' : 'sfa_') + createHash('sha256').update(slug).digest('hex').slice(0, 32);
    run('UPDATE fin_accounts SET external_ref=?,source_feed=? WHERE account_slug=?',
      provider === 'plaid' ? 'synthetic' : ref, 'bank-feed:' + slug, slug);
    // Only synthetic ciphertext-shaped storage, constructed at runtime.
    run(`INSERT INTO bank_feed_items(item_ref,access_ciphertext,access_iv,environment,status,status_detail,connected_at,removed_at)
      VALUES (?,?,?,?,?,'Synthetic status',?,?)`, slug, Buffer.from('synthetic storage bytes').toString('base64'),
      Buffer.from('synthetic iv').toString('base64'), environment, status, STAMP, status === 'removed' ? STAMP : null);
    if (provider === 'plaid') run(`INSERT INTO plaid_account_entity_assignments(item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
      VALUES (?,'synthetic',?,'owner',?,?,?,?)`, slug, ref, STAMP, STAMP, STAMP, STAMP);
    else {
      run(`INSERT INTO simplefin_connections(item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,updated_at)
        VALUES (?,'2025-12-03','2025-12-03','2025-12-03',?,?)`, slug, STAMP, STAMP);
      run(`INSERT INTO simplefin_account_assignments(item_ref,provider_account_id,account_ref,currency,entity_slug,first_seen_at,last_seen_at,assigned_at)
        VALUES (?,'synthetic',?,'USD','owner',?,?,?)`, slug, ref, STAMP, STAMP, STAMP);
    }
  };
  return { db, env, calls, run, account, row, coverage, connection };
}
