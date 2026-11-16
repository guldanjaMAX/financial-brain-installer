import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { queryMoney, MONEY_GUIDE, MONEY_EXAMPLE_SQL } from '../../src/lib/money-query.js';
import { accountLinkIdentity } from '../../src/lib/fin-account-links.js';
import { moneyMovementReading } from '../../src/lib/money-analysis.js';
const at = '2026-10-31T12:00:00Z';
export function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../../migrations/d1/', import.meta.url)).filter(n => n.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(`../../../migrations/d1/${name}`, import.meta.url), 'utf8'));
  t.after(() => db.close());
  const calls = [];
  const statement = (sql, binds = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
  });
  const env = { STORAGE: 'd1', DB: {
    prepare(sql) { calls.push(sql); return statement(sql); },
    batch: async statements => Promise.all(statements.map(s => s.all())),
  } };
  const run = (sql, ...binds) => db.prepare(sql).run(...binds);
  for (const [slug, kind] of [['business', 'business'], ['household', 'household']])
    run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'owner_stated','confirmed',?)`, slug, slug, kind, at);
  function account(slug, { mode = 'live', entity = 'business', mask = '1111', kind = 'checking', currency = 'USD' } = {}) {
    run(`INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,mask,currency,
      feed_mode,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`,
    slug, entity, slug, kind, ['card', 'loan', 'line_of_credit'].includes(kind) ? 'liability' : 'asset', mask, currency, mode, at);
  }
  function row(uid, slug, cents, { day = '2026-10-02', direction = 'inflow', memo = null, payee = null,
    category = null, currency = 'USD', pending = 0 } = {}) {
    run(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,
      description,payee,category,category_basis_state,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?,'owner_stated','confirmed',?)`,
    uid, slug, day, cents, direction, currency, memo, payee, category, pending, at);
  }
  function link(manual, live) {
    const get = slug => db.prepare('SELECT * FROM fin_accounts WHERE account_slug=?').get(slug);
    run(`INSERT INTO fin_account_links(tenant_id,manual_account_slug,live_account_slug,identity_json,
      link_plan_hash,linked_at) VALUES ('primary',?,?,?,?,?)`, manual, live,
    JSON.stringify([accountLinkIdentity(get(manual)), accountLinkIdentity(get(live))]), 'a'.repeat(64), at);
  }
  function coverage(slug, from, to) {
    run(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,
      provenance,basis_state,computed_at,recorded_at) VALUES (?,'complete',?,?,'owner_stated','confirmed',?,?)`, slug, from, to, at, at);
  }
  const query = async sql => (await queryMoney(env, { sql })).rows.map(r => ({ ...r }));
  return { db, env, run, calls, account, row, link, coverage, query };
}
