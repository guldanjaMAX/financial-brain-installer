// Synthetic SQLite import and balance-query fixture. No external services.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { queryMoney } from '../../src/lib/money-query.js';
import { moneyGuideFor } from '../../src/lib/money-query-contract.js';
import { readBankExport } from '../../src/lib/bank-export.js';
import { validateBankEnvelope } from '../../src/lib/fin-upload.js';
import { prepareBankExportImport } from '../../src/lib/fin-import.js';

export const NOW = Date.parse('2026-11-14T18:00:00Z');
export const TZ = 'America/Phoenix';
const at = '2026-10-31T12:00:00Z';

export function book(t) {
  t.mock.method(globalThis,'fetch',() => { throw new Error('network forbidden'); });
  const db = new DatabaseSync(':memory:');
  t?.after(() => db.close());
  const dir = new URL('../../../migrations/d1/',import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(name,dir), 'utf8'));
  const statement = (sql, binds = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
    run: async () => db.prepare(sql).run(...binds),
  });
  const env = { STORAGE: 'd1', BRAIN_TIMEZONE: TZ, DB: {
    prepare(sql) { return statement(sql); },
    batch: async statements => { const out = []; for (const s of statements) out.push(await s.all()); return out; },
  } };
  const run = (sql, ...binds) => db.prepare(sql).run(...binds);
  for (const [slug, kind] of [['business', 'business'], ['household', 'household']])
    run(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'owner_stated','confirmed',?)`, slug, slug, kind, at);
  function account(slug, { mode = 'manual', entity = 'business', mask = '1111', kind = 'checking', currency = 'USD',
    label = slug, institution = 'Synthetic bank', status = 'open', opened = null, closed = null } = {}) {
    const role = ['card', 'loan', 'line_of_credit'].includes(kind) ? 'liability' : ['checking', 'savings'].includes(kind) ? 'asset' : 'neither';
    run(`INSERT INTO fin_accounts(account_slug,entity_slug,label,institution,account_kind,balance_role,mask,currency,
      feed_mode,status,opened_on,closed_on,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`,
    slug, entity, label, institution, kind, role, mask, currency, mode, status, opened, closed, at);
  }
  // A balance observation. feed = provider snapshot (Plaid shape: no provider position;
  // SimpleFIN shape: pass position). extracted = read from an uploaded document.
  function snapshot(slug, asOf, currentMinor, { available = null, position, provenance = 'feed', basis = 'confirmed',
    currency = 'USD', recordedAt = asOf + 'T12:00:00Z', sourceFeed = 'bank-feed:' + slug, sourceDoc = 'doc-' + slug } = {}) {
    run(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,available_minor,currency,provenance,
      source_doc_uid,source_feed,basis_state,recorded_at,provider_position_minor${basis === 'unparsed' ? ',unparsed_reason' : ''})
      VALUES (?,?,?,?,?,?,?,?,?,?,?${basis === 'unparsed' ? ",'unread'" : ''})`,
    slug, asOf, currentMinor, available, currency, provenance, provenance === 'extracted' ? sourceDoc : null,
    provenance === 'feed' ? sourceFeed : null, basis, recordedAt, position ?? null);
  }
  let n = 0;
  function row(slug, cents, { day = '2026-10-10', direction = 'outflow', memo = null, payee = null,
    category = null, currency = 'USD', pending = 0, uid } = {}) {
    run(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,
      description,payee,category,category_basis_state,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`,
    uid ?? `r${++n}`, slug, day, cents, direction, currency, memo, payee, category, category ? 'confirmed' : null, pending, at);
  }
  function coverage(slug, from = '2026-01-01', to = '2026-11-13') {
    run(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,
      provenance,basis_state,computed_at,recorded_at) VALUES (?,'complete',?,?,'owner_stated','confirmed',?,?)`, slug, from, to, at, at);
  }
  function connection(slug, entity = 'business', syncedAt = '2026-11-14T17:00:00Z') {
    const ref = 'acct_' + Buffer.from(slug).toString('hex').padEnd(32, '0').slice(0, 32);
    run('UPDATE fin_accounts SET external_ref=?,feed_mode=?,provenance=?,source_feed=? WHERE account_slug=?', 'synthetic', 'live', 'feed', 'bank-feed:' + slug, slug);
    run(`INSERT INTO bank_feed_items(item_ref,access_ciphertext,access_iv,environment,status,status_detail,connected_at,removed_at,last_synced_at)
      VALUES (?,?,?,'production','connected','Synthetic status',?,NULL,?)`, slug, Buffer.from('synthetic storage bytes').toString('base64'),
    Buffer.from('synthetic iv').toString('base64'), at, syncedAt);
    run(`INSERT INTO plaid_account_entity_assignments(item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
      VALUES (?,'synthetic',?,?,?,?,?,?)`, slug, ref, entity, at, syncedAt, at, at);
    run(`INSERT INTO bank_feed_health(tenant_id,item_ref,last_successful_sync_at,data_through) VALUES ('primary',?,?,?)`,
      slug, syncedAt, syncedAt.slice(0, 10));
  }
  // Real owner-import path: readBankExport -> validateBankEnvelope -> prepareBankExportImport
  // (the same statement builder the owner commit uses), executed in order.
  function importFile(text, { name, format, currency = 'USD', accountHint = null, entity = 'business', label } = {}) {
    let envelope = readBankExport(new TextEncoder().encode(text), { name, format, currency,
      sourceDocUid: 'owner-bank:' + entity + ':' + name, accountHint });
    if (envelope.ok && format === 'csv' && label) envelope = { ...envelope, accounts: envelope.accounts.map(a => ({ ...a, label })) };
    const checked = validateBankEnvelope(envelope);
    if (!checked.ok) return { refused: checked.error, envelope };
    const plan = prepareBankExportImport(checked.envelope, { entitySlug: entity, now: '2026-11-13T20:00:00Z',
      origin: { provenance: 'extracted', sourceDocUid: checked.envelope.sourceDocUid } });
    if (!plan.receipt.imported) return { refused: plan.receipt.reason, envelope };
    for (const [sql, binds] of plan.statements) db.prepare(sql).run(...binds);
    return { receipt: plan.receipt, envelope: checked.envelope };
  }
  // Provider-feed promotion boundary (what SimpleFIN's promoteWindow hands fin-import):
  // the same prepareBankExportImport writer, origin feed, with providerPositionMinor.
  function feedImport(envelope, sourceFeed, entity = 'business') {
    const plan = prepareBankExportImport(envelope, { entitySlug: entity, now: '2026-11-13T20:00:00Z', origin: { provenance: 'feed', sourceFeed } });
    if (!plan.receipt.imported) return { refused: plan.receipt.reason };
    for (const [sql, binds] of plan.statements) db.prepare(sql).run(...binds);
    return { receipt: plan.receipt };
  }
  const q = (sql, period, extra = {}) => queryMoney(env, { sql, ...period, time_zone: TZ, ...extra }, { now: () => NOW });
  return { db, env, run, account, snapshot, row, coverage, connection, importFile, feedImport, q };
}

const guide = moneyGuideFor({ now: NOW, timeZone: TZ });
export function recipe(name, asOf) {
  const m = guide.match(new RegExp(`\\n${name}:[^\\n]*\\n([^\\n]+)`));
  if (!m) throw new Error('guide recipe missing: ' + name);
  return m[1].replaceAll('2026-09-30', asOf).replace(/;\s*$/, '');
}
// Cash on hand, following the guide text: "Cash adds checking/savings assets only, never nets liabilities".
export const cashSql = (asOf, { status = false, byCurrency = true } = {}) =>
  `WITH bal AS (${recipe('Balances', asOf)}) SELECT ${byCurrency ? 'currency,' : ''}SUM(current_minor) AS cash_minor,COUNT(*) AS accounts,MIN(as_of_date) AS oldest_as_of,MAX(as_of_date) AS newest_as_of FROM bal WHERE account_kind IN ('checking','savings') AND balance_role='asset'${status ? " AND status='open'" : ''}${byCurrency ? ' GROUP BY currency' : ''}`;
export const owedSql = asOf =>
  `WITH bal AS (${recipe('Balances', asOf)}) SELECT currency,SUM(current_minor) AS owed_minor,COUNT(*) AS accounts FROM bal WHERE balance_role='liability' GROUP BY currency`;

// The guide's Balances recipe, re-expressed without LIMIT (same observation ordering,
// same signed-position and legacy-SimpleFIN rules) so the tool can score it High.
// The verbatim recipe carries LIMIT 1 and is always capped at Low (69%).
export const latestCtes = asOf => `latest AS (SELECT x.*,ROW_NUMBER() OVER (PARTITION BY x.tenant_id,x.account_slug ORDER BY x.as_of_date DESC,x.recorded_at DESC,x.id DESC) AS rn FROM fin_balance_snapshots x WHERE date(x.as_of_date,'+0 days')=x.as_of_date AND x.as_of_date<='${asOf}'),
bal AS (SELECT a.tenant_id,a.account_slug,a.mask AS account,a.label AS account_label,a.account_kind,a.balance_role,a.status,CASE WHEN e.kind IN ('business','property') THEN 'business' WHEN e.kind IN ('person','household') THEN 'personal' ELSE 'unassigned' END AS side,COALESCE(b.currency,a.currency) AS currency,b.as_of_date,b.basis_state,b.provenance,CASE WHEN b.provider_position_minor IS NOT NULL THEN CASE WHEN a.balance_role='liability' THEN -b.provider_position_minor ELSE b.provider_position_minor END WHEN EXISTS(SELECT 1 FROM simplefin_account_assignments s WHERE s.tenant_id=b.tenant_id AND ('simplefin-'||substr(s.account_ref,5))=b.account_slug AND b.source_feed=('bank-feed:'||s.item_ref)) THEN NULL ELSE b.current_minor END AS current_minor,b.available_minor,b.provider_position_minor FROM fin_accounts a LEFT JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug AND e.superseded_by_id IS NULL LEFT JOIN latest b ON b.tenant_id=a.tenant_id AND b.account_slug=a.account_slug AND b.rn=1 WHERE a.superseded_by_id IS NULL)`;
export const W = {
  perAccount: asOf => `WITH ${latestCtes(asOf)} SELECT * FROM bal ORDER BY tenant_id,account_slug`,
  cash: (asOf, { status = false, byCurrency = true, side = null } = {}) => `WITH ${latestCtes(asOf)} SELECT ${byCurrency ? 'currency,' : ''}SUM(current_minor) AS cash_minor,COUNT(*) AS accounts,MIN(as_of_date) AS oldest_as_of,MAX(as_of_date) AS newest_as_of FROM bal WHERE account_kind IN ('checking','savings') AND balance_role='asset'${status ? " AND status='open'" : ''}${side ? ` AND side='${side}'` : ''}${byCurrency ? ' GROUP BY currency' : ''}`,
  owed: asOf => `WITH ${latestCtes(asOf)} SELECT currency,SUM(current_minor) AS owed_minor,COUNT(*) AS accounts FROM bal WHERE balance_role='liability' GROUP BY currency`,
};
export const day = d => ({ period_from: d, period_to: d });
