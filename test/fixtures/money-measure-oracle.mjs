import assert from 'node:assert/strict';

const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const key = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const bucket = value => ['uncategorized', 'uncategorised', 'unsorted'].includes(key(value));

// Scope comes from the caller's request, never from the answer being checked.
// Expected integers come from authored fixture rows or a direct raw-row read;
// neither oracle imports the clean classifier or queries its derived view.
export function fixtureMoneyMeasures(f, { question = 'How much did I spend?', intents = [], oracleRows } = {}) {
  const stored = f.rows(`SELECT t.*,a.mask AS account,a.account_kind,
    EXISTS(SELECT 1 FROM fin_account_kind_reviews r WHERE r.account_id=a.id AND r.tenant_id=a.tenant_id
      AND r.revoked_at IS NULL AND r.identity_json=json_array(a.tenant_id,a.id,a.account_slug,a.entity_slug,
        a.mask,a.currency,a.feed_mode,a.external_ref,a.source_feed,a.institution)) AS account_kind_confirmed
    FROM fin_transactions t JOIN fin_accounts a
    ON a.account_slug=t.account_slug WHERE t.pending=0 AND t.removed_at IS NULL AND t.superseded_by_id IS NULL`);
  const authored = oracleRows && new Map(oracleRows.map(row => [row.id, row]));
  const rows = stored.filter(row => !authored || authored.has(row.txn_uid)).map(row => {
    const authoredRow = authored?.get(row.txn_uid);
    if (authoredRow) assert.equal(row.amount_minor, authoredRow.cents, 'authored cents match the stored fixture');
    return { ...row, oracle: authoredRow?.oracle };
  });
  const scopes = intents.length ? intents : [{ kind: 'expense_summary' }];
  return scopes.map(intent => {
    const where = [], filters = [];
    const add = (sql, predicate) => { where.push(sql); filters.push(predicate); };
    if (intent.from) add(`posted_on>=${literal(intent.from)}`, row => row.posted_on >= intent.from);
    if (intent.to) add(`posted_on<=${literal(intent.to)}`, row => row.posted_on <= intent.to);
    if (intent.mask) add(`account=${literal(intent.mask)}`, row => row.account === intent.mask);
    if (intent.accountKind) add(`account_kind=${literal(intent.accountKind)}`, row => row.account_kind === intent.accountKind);
    const category = intent.categorySelector || (intent.kind === 'category' || intent.matchType === 'category' ? intent.match : null);
    const payee = !category && ['merchant', 'largest', 'deposits'].includes(intent.kind) ? intent.match : null;
    if (category) {
      if (bucket(category)) add("COALESCE(category,'')=''", row => !row.category);
      else add(`lower(category)=${literal(key(category))}`, row => key(row.category) === key(category));
    }
    if (payee) add(`lower(COALESCE(payee,description))=${literal(key(payee))}`, row => key(row.payee || row.description) === key(payee));
    const members = rows.filter(row => filters.every(filter => filter(row)));
    const sum = list => list.reduce((n, row) => n + row.amount_minor, 0);
    const out = members.filter(row => row.direction === 'outflow');
    const incoming = members.filter(row => row.direction === 'inflow');
    const suffix = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const inflow = intent.direction === 'inflow';
    if (intent.kind === 'largest' || intent.kind === 'deposits') {
      const direction = inflow ? 'inflow' : 'outflow';
      const field = inflow ? 'amount_minor' : 'expense_minor';
      const limit = intent.limit || 10;
      const expected = (inflow ? incoming : out).filter(row => row.amount_minor > 0)
        .sort((a,b) => (intent.kind==='deposits' ? b.posted_on.localeCompare(a.posted_on) : b.amount_minor-a.amount_minor) || a.id-b.id).slice(0,limit)
        .map(row => ({ total: row.amount_minor }));
      return { sql: `SELECT ${field} total FROM txn${suffix}${suffix ? ' AND ' : ' WHERE '}direction=${literal(direction)} AND ${field}>0 ORDER BY ${intent.kind==='deposits' ? 'posted_on' : field} DESC,id LIMIT ${limit}`, expected };
    }
    if (inflow) return { sql: `SELECT COALESCE(SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE 0 END),0) total FROM txn${suffix}`, expected: [{ total: sum(incoming) }] };
    const net = !/\bgross\b/i.test(question) && /\b(?:net|after refunds|after returns|minus returns|less refunds|netted|taken off)\b/i.test(question);
    // A credit on an unreviewed 'other' account is a possible refund, never a
    // certified deduction. This rule reads raw account evidence independently.
    const reviewedAccount = row => row.account_kind !== 'other' || row.account_kind_confirmed === 1;
    const refunds = incoming.filter(row => reviewedAccount(row) &&
      (row.oracle ? /^(?:prior_)?refund$/.test(row.oracle) : /\brefund\b/i.test(row.description || '')));
    const columns = `COALESCE(SUM(expense_minor),0) gross_minor${net ? ',COALESCE(SUM(refund_minor),0) refund_minor,COALESCE(SUM(expense_minor-refund_minor),0) total' : ''}`;
    const expected = group => {
      const gross = sum(group.filter(row => out.includes(row)));
      const returned = sum(group.filter(row => refunds.includes(row)));
      return { gross_minor: gross, ...(net ? { refund_minor: returned, total: gross-returned } : {}) };
    };
    if (/\b(?:by|per) month\b|\bmonth by month\b/i.test(question)) {
      const months = [...new Set(members.map(row => row.posted_on.slice(0,7)))].sort();
      return { sql: `SELECT substr(posted_on,1,7) month,${columns} FROM txn${suffix} GROUP BY substr(posted_on,1,7) ORDER BY month`,
        expected: months.map(month => ({ month, ...expected(members.filter(row => row.posted_on.startsWith(month))) })) };
    }
    return { sql: `SELECT ${columns} FROM txn${suffix}`, expected: [expected(members)] };
  });
}
