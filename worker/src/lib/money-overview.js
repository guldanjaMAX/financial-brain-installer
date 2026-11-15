import { queryMoney } from './money-query.js';
import { accountKindReviewSql, applyAccountKindReview } from './fin-account-kinds.js';
import { MONEY_OVERVIEW_NEXT_STEP, unavailableMoneyOverview } from './money-query-contract.js';
import { confidenceText, unknownMoneyConfidence, limitMoneyConfidence, MONEY_ACCOUNT_HISTORY_SQL, moneyAccountStart } from './money-confidence.js';

const unavailable = () => Object.assign(new Error('Could not read this part of the money overview.'),
  { code: 'MONEY_OVERVIEW_UNAVAILABLE' });
const invalid = () => Object.assign(new Error('The money overview takes an empty JSON object.'), { code: 'MONEY_OVERVIEW_INVALID' });
const dayAfter = (day, offset) => new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

function calendar(zone, instant) {
  let timeZone = zone, basis = 'configured', format;
  try {
    if (typeof zone !== 'string' || !zone) throw new Error();
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    timeZone = 'UTC'; basis = 'fallback_utc';
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const months = Array.from({ length: 12 }, (_, i) => {
    const first = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 12 + i, 1)).toISOString().slice(0, 10);
    const next = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 1)).toISOString().slice(0, 10);
    return { month: first.slice(0, 7), from: first, through: i === 11 ? today : dayAfter(next, -1), totals: [] };
  });
  return { today, time_zone: timeZone, time_zone_basis: basis, months };
}

// Fixed projection, never caller SQL. Credential columns and provider IDs cannot
// cross this boundary. A configured live feed alone does not prove connection.
const CONNECTION_SQL = `SELECT a.tenant_id,a.account_slug,a.label,a.mask,a.account_kind,a.balance_role,
  a.currency,a.status,a.feed_mode,a.opened_on,a.closed_on,${MONEY_ACCOUNT_HISTORY_SQL} AS history_json,${accountKindReviewSql('a')} AS account_kind_review_json,
  EXISTS(SELECT 1 FROM (
    SELECT tenant_id,account_ref,item_ref FROM plaid_account_entity_assignments WHERE entity_slug IS NOT NULL
    UNION ALL SELECT tenant_id,account_ref,item_ref FROM simplefin_account_assignments WHERE entity_slug IS NOT NULL
  ) p JOIN bank_feed_items b ON b.tenant_id=p.tenant_id AND b.item_ref=p.item_ref
    WHERE p.tenant_id=a.tenant_id AND p.account_ref=a.external_ref
      AND b.status='connected' AND b.removed_at IS NULL AND b.environment='production'
      AND a.feed_mode='live' AND a.status='open') AS connected
  FROM fin_accounts a WHERE a.superseded_by_id IS NULL ORDER BY a.tenant_id,a.account_slug LIMIT 1001`;

function overviewSql(from, today) {
  return `SELECT 'account' AS section,json_object(
    'tenant_id',c.tenant_id,'account_slug',c.account_slug,'account_identity',c.account_identity,
    'last4',c.account,'label',c.account_label,'kind',a.account_kind,'currency',c.currency,
    'status',a.status,'feed_mode',a.feed_mode,'identity_basis',c.identity_basis,
    'first_row',c.first_row,'last_row',c.last_row,'row_count',c.row_count,
    'coverage_status',c.coverage_status,'covered_from',c.covered_from,'covered_to',c.covered_to,
    'coverage_confirmed',CASE WHEN cc.coverage_status='complete' AND cc.basis_state='confirmed'
      AND date(cc.covered_from,'+0 days')=cc.covered_from AND date(cc.covered_to,'+0 days')=cc.covered_to
      AND cc.covered_from<=cc.covered_to AND COALESCE(cc.basis_note,'') NOT LIKE 'Read from a bank export covering %' THEN 1 ELSE 0 END,
    'opened_on',a.opened_on,'closed_on',a.closed_on,
    'unreadable_rows',c.unreadable_rows,'unconfirmed_rows',c.unconfirmed_rows,
    'duplicate_rows_removed',c.duplicate_rows_removed,'possible_duplicate_count',c.possible_duplicate_count,
    'last_observed_at',c.last_observed_at,'last_sync',c.last_sync,
    'pending_rows',c.pending_rows,'pending_collection',c.pending_collection,'pending_stale_rows',c.pending_stale_rows
  ) AS value FROM coverage c JOIN fin_accounts a ON a.tenant_id=c.tenant_id AND a.account_slug=c.account_slug AND a.superseded_by_id IS NULL
    LEFT JOIN fin_account_coverage cc ON cc.tenant_id=a.tenant_id AND cc.account_slug=a.account_slug AND cc.superseded_by_id IS NULL
  UNION ALL SELECT 'month',json_object('month',substr(posted_on,1,7),'currency',currency,
    'money_in_minor',SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE 0 END),
    'money_out_minor',SUM(CASE WHEN direction='outflow' THEN amount_minor ELSE 0 END),
    'income_minor',SUM(income_minor),'expense_minor',SUM(expense_minor),
    'estimated_in_minor',SUM(CASE WHEN estimated=1 AND direction='inflow' THEN amount_minor ELSE 0 END),
    'estimated_out_minor',SUM(CASE WHEN estimated=1 AND direction='outflow' THEN amount_minor ELSE 0 END),
    'row_count',count(*)) FROM txn WHERE posted_on BETWEEN '${from}' AND '${today}'
    GROUP BY substr(posted_on,1,7),currency ORDER BY section,value`;
}

function gapsFor(account, from, to) {
  // No transactions on a day is not a missing feed day. Only confirmed coverage
  // bounds can subtract history from the unverified window; respect account life.
  const startOfLife = moneyAccountStart(account);
  if (startOfLife && startOfLife > from) from = startOfLife;
  if (account.closed_on && account.closed_on < to) to = account.closed_on;
  if (from > to) return [];
  if (!account.coverage_confirmed) return [{ from, to, reason: 'unverified_history' }];
  const start = account.covered_from, end = account.covered_to;
  if (end < from || start > to) return [{ from, to, reason: 'outside_confirmed_coverage' }];
  const gaps = [];
  if (from < start) gaps.push({ from, to: dayAfter(start, -1), reason: 'outside_confirmed_coverage' });
  if (end < to) gaps.push({ from: dayAfter(end, 1), to, reason: 'outside_confirmed_coverage' });
  return gaps;
}

function coverageText(result) {
  const lines = [`Today: ${result.today} (${result.time_zone}${result.time_zone_basis === 'fallback_utc' ? ', explicit UTC fallback; owner time zone unavailable' : ''}).`,
    `Monthly window: ${result.window.from} through ${result.today}; current month through today.`,
    'Money in/out are gross clean posted cash movements; income/expense totals separately exclude classified transfers, repayments and refunds. Currencies stay separate.'];
  if (result.months && !result.accounts.some(a => a.row_count > 0)) lines.push('No clean bank rows are available. Zero observed amounts do not prove no activity.');
  if (result.accounts?.length === 0) lines.push('No accounts are recorded; account coverage is unknown.');
  for (const a of result.accounts || []) {
    const identity = `Account ${JSON.stringify(a.label || a.account_slug)} (${a.last4 || 'last four unknown'}, ${a.kind || 'kind unknown'}, ${a.currency}): ` +
      `${a.connected === null ? 'connection unknown' : a.connected ? 'connected' : 'not connected'}; ${a.status}. ` +
      `Provider kind: ${a.provider_kind || 'unknown'}; owner review: ${a.kind_review_state}. `;
    if (!a.coverage_available) { lines.push(identity + 'Could not read clean account coverage; history, row counts and dollar impact are unknown.'); continue; }
    lines.push(identity +
      `Observed rows: ${a.first_row || 'none'} through ${a.last_row || 'none'} (${a.row_count}). ` +
      `Account start: ${a.account_start || 'not established'}${a.account_start && !a.opened_on ? ` (first posted transaction; completed provider request starts ${a.history.completed_from})` : ''}. ` +
      `Confirmed complete coverage: ${a.coverage_confirmed ? `${a.covered_from} through ${a.covered_to}` : 'not established'}. ` +
      `Gaps/unverified history: ${a.gaps.length ? a.gaps.map(g => `${g.from} through ${g.to} (${g.reason})`).join('; ') : 'none within confirmed bounds'}. ` +
      `Pending not counted: ${a.pending_collection==='not_collected' ? 'not collected by this feed (amount unknown)' : a.pending_rows}; unreadable: ${a.unreadable_rows}; unconfirmed: ${a.unconfirmed_rows}; possible duplicate rows: ${a.possible_duplicate_count}; precedence duplicates removed: ${a.duplicate_rows_removed}; identity: ${a.identity_basis}. ` +
      'Counts are not dollar amounts; see confidence for measured uncertainty amounts. Other unreadable, unconfirmed and duplicate impacts may be unknown.');
  }
  for (const limitation of result.limitations) lines.push(limitation.text);
  lines.push('Row dates are observations, not proof of complete history. Connection status does not prove a successful current sync; confidence states any missing or stale successful-sync evidence. Monthly amounts may be incomplete where coverage is unverified. Scope the answer coverage line to its actual accounts and dates. Unknown history has unknown dollar impact. Keep exact gross posted amounts exact; label uncertain classification amounts as estimates and show the uncertain rows.');
  return lines.join('\n');
}

export async function overviewMoney(env, { now = Date.now, timeoutMs = 10000, ...queryOptions } = {}) {
  const instant = now();
  const result = calendar(env.BRAIN_TIMEZONE, instant);
  result.window = { from: result.months[0].from, to: result.today, current_month_partial: true };
  const months = result.months;
  result.accounts = null; result.months = null; result.limitations = [];
  // Independent reads share one deadline. A stalled connection read must not
  // discard completed clean totals, and overflow must not discard the calendar
  // or the safe account inventory. Neither snapshot certifies the other.
  const cleanRead = async () => {
    const query = await queryMoney(env, { sql: overviewSql(result.window.from, result.today), max_rows: 1000 }, {
      ...queryOptions, maxSnapshotRows:queryOptions.maxScanRows ?? 10000, timeoutMs, now: () => instant, pendingQuestion:false, confidenceScope: { from: result.window.from, to: result.today, filters: {}, currenciesSeparated: true } });
    result.confidence = query.confidence;
    if(query.complete===false)throw Object.assign(unavailable(),{code:'MONEY_QUERY_SCAN_LIMIT'});
    if(query.truncated)throw unavailable();
    const accounts = [];
    for (const row of query.rows) {
      const value = JSON.parse(row.value);
      if (row.section === 'account') {
        const evidence=query.evidence?.accounts.find(a=>a.tenant_id===value.tenant_id && a.account_slug===value.account_slug);
        accounts.push({...value,history_holes:evidence?.history_holes || []});
      }
      else if (row.section === 'month') {
        const month = months.find(m => m.month === value.month);
        if (!month) throw unavailable();
        delete value.month; month.totals.push(value);
      } else throw unavailable();
    }
    const currencies = new Set(accounts.map(a => a.currency));
    for (const month of months) for (const total of month.totals) currencies.add(total.currency);
    for (const month of months) {
      delete month.from;
      for (const currency of currencies) if (!month.totals.some(total => total.currency === currency)) month.totals.push({
        currency, money_in_minor: 0, money_out_minor: 0, income_minor: 0, expense_minor: 0,
        estimated_in_minor: 0, estimated_out_minor: 0, row_count: 0,
      });
      month.totals.sort((a, b) => a.currency.localeCompare(b.currency));
    }
    return accounts;
  };
  const inventoryRead = async () => {
    let timer;
    try {
      const read = await Promise.race([
        Promise.resolve().then(() => env.DB.prepare(CONNECTION_SQL).all()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); }),
      ]);
      if (read?.success === false || !Array.isArray(read?.results) || read.results.length > 1000) throw unavailable();
      return read.results.map(raw => {
        const a = applyAccountKindReview(raw);
        // Only these reviewed fields may leave the trusted private projection.
        return { tenant_id: a.tenant_id, account_slug: a.account_slug, label: a.label, last4: a.mask,
          kind: a.account_kind, provider_kind: a.provider_account_kind, role: a.balance_role,
          kind_review_state: a.account_kind_review?.state || 'unreviewed',
          kind_balance_conflict: Boolean(a.account_kind_balance_conflict), currency: a.currency,
          status: a.status, feed_mode: a.feed_mode, opened_on: a.opened_on, closed_on: a.closed_on, history: JSON.parse(a.history_json),
          connected: a.connected === 1, coverage_available: false, row_count: null, gaps: null };
      });
    } finally { clearTimeout(timer); }
  };
  const [clean, inventory] = await Promise.allSettled([cleanRead(), inventoryRead()]);
  const key = a => JSON.stringify([a.tenant_id, a.account_slug]);
  if (clean.status === 'fulfilled') {
    result.months = months;
    result.accounts = clean.value.map(a => ({ ...a, provider_kind: a.kind, kind: null,
      kind_review_state: 'unavailable', connected: null, coverage_available: true,
      gaps: [...gapsFor(a, result.window.from, result.today),...(a.history_holes || [])] }));
  } else {
    const code = ['MONEY_QUERY_SCAN_LIMIT', 'MONEY_QUERY_TIMEOUT', 'MONEY_QUERY_UNAVAILABLE'].includes(clean.reason?.code)
      ? clean.reason.code : 'MONEY_OVERVIEW_UNAVAILABLE';
    result.limitations.push({ scope: 'clean_coverage_and_monthly_totals', code,
      text: `Could not read clean account coverage and monthly totals${code === 'MONEY_QUERY_SCAN_LIMIT' ? ': transaction history exceeds the scan budget' : ''}. Their dollar impact is unknown.` });
  }
  if (inventory.status === 'fulfilled') {
    const byAccount = new Map((result.accounts || []).map(a => [key(a), a]));
    for (const a of inventory.value) {
      const covered = byAccount.get(key(a));
      byAccount.set(key(a), { ...covered, ...a, ...(covered ? { coverage_available: true, row_count: covered.row_count, gaps: covered.gaps } : {}) });
    }
    result.accounts = [...byAccount.values()];
    if (clean.status === 'fulfilled' && (result.accounts.length !== clean.value.length || result.accounts.some(a => a.kind_review_state === 'unavailable')))
      result.limitations.push({ scope: 'account_inventory', code: 'MONEY_OVERVIEW_UNAVAILABLE', text: 'Account inventory changed between reads. Some account coverage or kinds could not be verified; dollar impact is unknown.' });
  } else result.limitations.push({ scope: 'account_inventory', code: 'MONEY_OVERVIEW_UNAVAILABLE',
    text: 'Could not read the reviewed account kinds and connection inventory. Connection status and effective kinds are unknown; dollar impact is unknown.' });
  for (const a of result.accounts || []) {
    a.account_start = moneyAccountStart(a);
    if (a.coverage_available) a.gaps = [...gapsFor(a, result.window.from, result.today),...(a.history_holes || [])];
  }
  result.accounts?.sort((a, b) => a.tenant_id.localeCompare(b.tenant_id) || a.account_slug.localeCompare(b.account_slug));
  result.status = result.limitations.length ? 'partial' : 'complete';
  result.confidence ||= unknownMoneyConfidence();
  // Inventory and coverage are independent reads. A later loss of coverage or
  // connection cannot inherit a High score from the earlier clean snapshot.
  for (const a of result.accounts || []) {
    const label = `Account ending ${/^\d{4}$/.test(a.last4) ? a.last4 : '(last four unknown)'}`;
    const addGap = (reason, fix, cap) => {
      if (!result.confidence.reasons.some(r => r.includes(label) && r.includes(reason)))
        result.confidence = limitMoneyConfidence(result.confidence, `${label}: ${reason}`, `${label}: ${fix}`, cap);
    };
    // The overview counts posted rows only, so a feed that does not collect
    // pending is named without dropping the posted totals below High.
    if (a.pending_collection === 'not_collected') addGap('pending not collected by this feed; posted totals exclude pending; amount unknown.',
      'Check current pending entries at the bank, or connect a feed that collects pending transactions.', 95);
    if (a.connected !== true) addGap('connection is not verified by the overview inventory.',
      `Verify the account connection and complete history for ${result.window.from} through ${result.today}.`, 69);
    if (!a.coverage_available) addGap('clean coverage is unavailable.',
      `Read and confirm history for ${result.window.from} through ${result.today}; missing dollar impact is unknown.`, 69);
    for (const gap of a.gaps || []) addGap(`${gap.from} through ${gap.to}`,
      `Supply and confirm complete history for ${gap.from} through ${gap.to}; missing dollar impact is unknown.`, 89);
    for (const [field, cap] of [['unreadable_rows', 69], ['unconfirmed_rows', 89], ['possible_duplicate_count', 89]])
      if (a[field] > 0) addGap(`${a[field]} ${field.replaceAll('_', ' ')} observed in the overview.`,
        `Compare the affected rows with statements for ${result.window.from} through ${result.today}; unresolved dollar impact is unknown.`, cap);
  }
  for (const limitation of result.limitations) result.confidence = limitMoneyConfidence(result.confidence, limitation.text,
    'Read the unavailable ' + limitation.scope.replaceAll('_', ' ') + ' and verify its accounts, dates and dollar impact.');
  if (result.time_zone_basis !== 'configured') result.confidence = limitMoneyConfidence(result.confidence,
    'The owner calendar uses a UTC fallback; the requested local dates are unverified.', 'Configure the owner time zone and verify the requested period.');
  result.confidence_text = confidenceText(result.confidence);
  result.next_step = MONEY_OVERVIEW_NEXT_STEP;
  result.coverage_text = coverageText(result) + '\n' + result.confidence_text;
  return result;
}

export function validateOverviewArguments(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw invalid();
}

export async function handleMoneyOverview(env, request) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
  try {
    if (request.method !== 'POST') return new Response(JSON.stringify({ ...unavailableMoneyOverview(), error: 'Use a private JSON POST body.' }), { status: 405, headers });
    let body;
    try { body = await request.json(); } catch { throw invalid(); }
    validateOverviewArguments(body);
    return new Response(JSON.stringify(await overviewMoney(env)), { headers });
  } catch (e) {
    if (e?.code === 'MONEY_OVERVIEW_INVALID') return new Response(JSON.stringify({
      ...unavailableMoneyOverview(), code: 'MONEY_OVERVIEW_INVALID', error: 'The money overview takes an empty JSON object.',
    }), { status: 400, headers });
    return new Response(JSON.stringify(unavailableMoneyOverview()), { headers });
  }
}
