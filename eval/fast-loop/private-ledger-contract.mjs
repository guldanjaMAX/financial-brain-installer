import { createHash } from 'node:crypto';

// These are the complete table dependencies of the three reviewed SQL reads
// in ledger-reader.js. Provider rows are projections, never credential exports.
export const TABLES = Object.freeze([
  { name: 'fin_entities' },
  { name: 'fin_accounts' },
  { name: 'fin_account_kind_reviews' },
  { name: 'fin_account_coverage' },
  { name: 'fin_account_links' },
  { name: 'fin_transactions' },
  { name: 'fin_balance_snapshots' },
  { name: 'bank_feed_items', columns: ['tenant_id', 'item_ref', 'last_synced_at', 'status', 'removed_at'] },
  { name: 'bank_feed_backfill', columns: ['tenant_id', 'item_ref', 'state', 'provider_history_state', 'unread_lines', 'requested_days', 'queued_at', 'finished_at'] },
  { name: 'plaid_sync_windows', columns: ['tenant_id', 'item_ref'] },
  { name: 'simplefin_account_assignments', columns: ['tenant_id', 'item_ref', 'account_ref'] },
  { name: 'simplefin_sync_windows', columns: ['tenant_id', 'item_ref', 'state', 'revision', 'staging_revision', 'errlist_json'] },
].map(Object.freeze));
export const MAX_TABLE_ROWS = 10000;
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const fail = code => { throw Error(`PRIVATE_REPLAY_${code}`); };
export function exportQueries(tenant) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant)) fail('INVALID_ARGUMENTS');
  const where = `WHERE tenant_id='${tenant}'`;
  return {
    // One SELECT, no compound terms: D1 refuses a nine-term UNION (SQLITE_ERROR 7500).
    'counts.sql': `SELECT j.value AS table_name,CASE j.value\n` +
      TABLES.map(t => ` WHEN '${t.name}' THEN (SELECT COUNT(*) FROM (SELECT 1 FROM ${t.name} ${where} LIMIT ${MAX_TABLE_ROWS + 1}))`).join('\n') +
      `\n END AS row_count FROM json_each('${JSON.stringify(TABLES.map(t => t.name))}') AS j ORDER BY j.key;\n`,
    ...Object.fromEntries(TABLES.map(t => [`${t.name}.sql`, `SELECT ${t.columns?.join(',') || '*'} FROM ${t.name} ${where} LIMIT ${MAX_TABLE_ROWS + 1};\n`])),
  };
}
export function d1Rows(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true ||
      !Array.isArray(value[0].results) || value[0].meta?.changes !== 0 || value[0].meta?.rows_written !== 0) fail('EXPORT_INVALID');
  return value[0].results;
}
export function validateEnvelope(meta, tables, before, after, questions) {
  if (meta?.schema !== 1 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(meta.now_utc) ||
      !Number.isFinite(Date.parse(meta.now_utc)) ||
      new Date(meta.now_utc).toISOString() !== (meta.now_utc.includes('.') ? meta.now_utc : meta.now_utc.replace('Z', '.000Z')) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(meta.tenant_id) ||
      meta.consistency !== 'owner-reviewed-stable-money-window') fail('EXPORT_INVALID');
  try { new Intl.DateTimeFormat('en-US', { timeZone: meta.owner_time_zone }).format(new Date(meta.now_utc)); }
  catch { fail('EXPORT_INVALID'); }
  if (typeof meta.owner_time_zone !== 'string' || !meta.owner_time_zone.length) fail('EXPORT_INVALID');
  const counts = value => {
    if (!Array.isArray(value) || value.length !== TABLES.length || new Set(value.map(v => v?.table_name)).size !== TABLES.length) fail('EXPORT_INVALID');
    return Object.fromEntries(value.map(v => [v.table_name, v.row_count]));
  };
  const first = counts(before), last = counts(after);
  let total = 0;
  for (const t of TABLES) {
    const rows = tables[t.name];
    if (!Array.isArray(rows) || rows.length > MAX_TABLE_ROWS || first[t.name] !== rows.length || last[t.name] !== rows.length) fail('EXPORT_INVALID');
    total += rows.length;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.tenant_id !== meta.tenant_id ||
          (t.columns && (Object.keys(row).length !== t.columns.length || Object.keys(row).some(k => !t.columns.includes(k)))) ||
          Object.values(row).some(v => v !== null && typeof v !== 'string' && (typeof v !== 'number' || !Number.isSafeInteger(v)))) fail('EXPORT_INVALID');
    }
  }
  if (total > 50000) fail('EXPORT_INVALID');
  if (!Array.isArray(questions) || !questions.length || questions.length > 1000 ||
      new Set(questions.map(q => q?.id)).size !== questions.length || questions.some(q =>
        !q || Object.keys(q).some(k => !['id', 'question'].includes(k)) ||
        typeof q.id !== 'string' || !q.id.length || q.id.length > 128 ||
        typeof q.question !== 'string' || !q.question.trim() || q.question.length > 10000)) fail('QUESTIONS_INVALID');
  return { ...meta, now_utc: new Date(meta.now_utc).toISOString() };
}
export function figures(body) {
  const found = [];
  const walk = (value, path) => {
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key;
        if (/_minor$/.test(key) && item !== null && typeof item !== 'object') {
          if (!Number.isSafeInteger(item)) fail('FIGURE_INVALID');
          found.push({ path: next, cents: String(item), kind: 'structured' });
        } else walk(item, next);
      }
    } else if (typeof value === 'string') {
      let index = 0;
      for (const match of value.matchAll(/(-?)\$([\d,]+)\.(\d{2})(?!\d)/g)) {
        found.push({ path: `${path}.amounts.${index++}`, cents: String(BigInt(`${match[1]}${match[2].replaceAll(',', '')}${match[3]}`)), kind: 'displayed' });
      }
    }
  };
  walk(body, '');
  return found;
}
