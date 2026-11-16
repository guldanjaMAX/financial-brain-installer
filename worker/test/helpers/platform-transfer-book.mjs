// Synthetic, offline D1 book for platform and transfer regressions.
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const WT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
// Import by URL, never by a filesystem path: a Windows path such as C:\... is not a valid ESM specifier.
const { queryMoney } = await import(new URL('../../../worker/src/lib/money-query.js', import.meta.url).href);
const MIG = fileURLToPath(new URL('../../../migrations/d1/', import.meta.url));
const migrations = readdirSync(MIG).filter(n => n.endsWith('.sql')).sort().map(n => readFileSync(MIG + n, 'utf8'));
globalThis.fetch = async () => { throw new Error('network forbidden in audit'); };

// accounts: [{slug,kind,mask,label,institution,entity,mode,currency,coverage:[from,to]|null}]
// rows: [{uid,acct,day,cents,dir:'inflow'|'outflow',memo,payee,cat,cbs,prov,basis,pending,currency}]
export function book({ accounts, rows, at = '2026-11-01T12:00:00Z', coverage = ['2026-10-01', '2026-10-31'], query = queryMoney }) {
  const db = new DatabaseSync(':memory:');
  for (const sql of migrations) db.exec(sql);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  for (const [slug, kind] of [['business', 'business'], ['household', 'household']])
    run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at) VALUES (?,?,?,'owner_stated','confirmed',?)`, slug, 'Owner ' + slug, kind, at);
  for (const a of accounts) {
    const kind = a.kind || 'checking';
    run(`INSERT INTO fin_accounts(account_slug,entity_slug,label,institution,account_kind,balance_role,mask,currency,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, a.slug, a.entity || 'business', a.label ?? a.slug, a.institution ?? null, kind,
      ['card', 'loan', 'line_of_credit'].includes(kind) ? 'liability' : 'asset', a.mask ?? null, a.currency || 'USD', a.mode || 'manual', at);
    const cov = a.coverage === undefined ? coverage : a.coverage;
    if ((a.mode || 'manual') === 'live' && a.connect !== false) {
      const ref = 'acct_' + createHash('sha256').update(a.slug).digest('hex').slice(0, 32);
      run('UPDATE fin_accounts SET external_ref=? WHERE account_slug=?', ref, a.slug);
      run(`INSERT INTO bank_feed_items(item_ref,access_ciphertext,access_iv,environment,status,status_detail,connected_at,removed_at,last_synced_at)
        VALUES (?,?,?,'production','connected','Synthetic status',?,NULL,?)`, a.slug, Buffer.from('synthetic storage bytes').toString('base64'), Buffer.from('synthetic iv').toString('base64'), at, at);
      run(`INSERT INTO plaid_account_entity_assignments(item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
        VALUES (?,'synthetic',?,?,?,?,?,?)`, a.slug, ref, a.entity || 'business', at, at, at, at);
      run(`INSERT INTO bank_feed_health(tenant_id,item_ref,last_successful_sync_at,data_through) VALUES ('primary',?,?,?)`, a.slug, at, at.slice(0, 10));
    }
    if (cov) run(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,provenance,basis_state,computed_at,recorded_at)
      VALUES (?,'complete',?,?,'owner_stated','confirmed',?,?)`, a.slug, cov[0], cov[1], at, at);
  }
  for (const r of rows) {
    const prov = r.prov || 'owner_stated';
    run(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,payee,category,category_basis_state,pending,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.uid, r.acct, r.day, r.cents, r.dir, r.currency || 'USD', r.memo ?? null, r.payee ?? null, r.cat ?? null,
      r.cbs === undefined ? null : r.cbs, Number(r.pending || 0), prov, prov === 'feed' ? 'bank-feed:synthetic' : null, r.basis || 'confirmed', at);
  }
  const statement = (sql, binds = []) => ({ bind: (...v) => statement(sql, v),
    all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }), first: async () => db.prepare(sql).get(...binds) ?? null });
  const env = { STORAGE: 'd1', BRAIN_TIMEZONE: 'America/Los_Angeles', DB: { prepare: sql => statement(sql), batch: async s => Promise.all(s.map(x => x.all())) } };
  const run2 = run;
  const now = Date.parse(at);
  const before = () => db.prepare('SELECT total_changes() AS n').get().n;
  async function ask(sql, { from = '2026-10-01', to = '2026-10-31', period = true, extra = {} } = {}) {
    const n = before();
    let out;
    try {
      const r = await query(env, { sql, ...(period ? { period_from: from, period_to: to } : {}), ...extra }, { now: () => now });
      out = { ok: true, rows: r.rows.map(x => ({ ...x })), line: r.confidence?.line || r.confidence?.display || (r.confidence_text || '').split('\n')[0], percent: r.confidence?.percent, level: r.confidence?.level,
        reasons: r.confidence?.reasons, missing: r.confidence?.missing, gaps: (r.confidence?.selection_gaps || []).map(g => g.code + (g.reasons ? ':' + g.reasons.map(x => x.reason + '/' + x.treatment).join('|') : '')) };
    } catch (e) { out = { ok: false, code: e.code, reason: e.reason, message: String(e.message).slice(0, 200) }; }
    if (before() !== n) throw new Error('route wrote to the database');
    return out;
  }
  const dump = async (o = {}) => {
    const r = await ask(`SELECT txn_uid,posted_on,account,account_kind,direction,amount_minor,money_kind,movement_classification AS cls,estimated,estimate_reason,possible_transfer,transfer_basis,processor,payer_group,income_minor,expense_minor,refund_minor,sales_adjust_minor,income_adjust_minor,paid_minor FROM txn ORDER BY posted_on,id`, { ...o });
    return r.ok ? r.rows : r;
  };
  return { db, env, ask, dump, run, close: () => db.close() };
}
export const scalar = r => { if (!r.ok) return { error: r.code + ':' + (r.reason || '') }; const row = r.rows[0]; if (!row) return null; const v = Object.values(row); return v.length === 1 ? v[0] : row; };
export const fmtRow = r => `${r.txn_uid} ${r.posted_on} ${r.account}/${r.account_kind} ${r.direction} ${r.amount_minor} kind=${r.money_kind} cls=${r.cls} est=${r.estimated}${r.estimate_reason ? '(' + r.estimate_reason + ')' : ''} pt=${r.possible_transfer}${r.transfer_basis ? '(' + r.transfer_basis + ')' : ''} proc=${r.processor} payer=${r.payer_group} inc=${r.income_minor} exp=${r.expense_minor} ref=${r.refund_minor} sadj=${r.sales_adjust_minor} iadj=${r.income_adjust_minor} paid=${r.paid_minor}`;
