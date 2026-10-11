import { DEFAULT_TENANT } from "./fin-d1.js";
import { ledgerDay, shiftLedgerDay } from "./ledger-question.js";

const MAX_ACCOUNTS = 200;
const MAX_ROWS = 5000;
const validWindow = a => [a.covered_from, a.covered_to].every(day =>
  /^\d{4}-\d{2}-\d{2}$/.test(day || "") && Number.isFinite(Date.parse(day)) && ledgerDay(day) === day
) && a.covered_from <= a.covered_to;

async function rows(env, sql, binds) {
  const result = await env.DB.prepare(sql).bind(...binds).all();
  if (!Array.isArray(result?.results)) throw new Error("ledger read unavailable");
  return result.results;
}

// No labels, external references or credential columns are selected. The source
// account slug remains internal row provenance, never the public account label.
const ACCOUNTS_SQL = `SELECT a.account_slug,a.entity_slug,a.mask,a.account_kind,
      a.currency,a.feed_mode,a.balance_role,a.basis_state,c.coverage_status,c.covered_from,c.covered_to,
      c.basis_state AS coverage_basis,i.last_synced_at
    FROM fin_accounts a
    JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
      AND e.superseded_by_id IS NULL AND e.relationship='owned' AND e.basis_state='confirmed'
    LEFT JOIN fin_account_coverage c ON c.tenant_id=a.tenant_id AND c.account_slug=a.account_slug
      AND c.superseded_by_id IS NULL
    LEFT JOIN bank_feed_items i ON i.tenant_id=a.tenant_id AND a.source_feed=('bank-feed:'||i.item_ref)
    WHERE a.tenant_id=? AND a.superseded_by_id IS NULL
    ORDER BY a.entity_slug,a.account_slug LIMIT ?`;

export async function readEffectiveAccounts(env, { tenantId = env.BANK_FEED_TENANT || DEFAULT_TENANT } = {}) {
  return groupAccounts(await rows(env, ACCOUNTS_SQL, [tenantId, MAX_ACCOUNTS + 1]));
}

function groupAccounts(accounts) {
  if (accounts.length > MAX_ACCOUNTS) throw new Error("ledger account limit");
  const groups = new Map();
  for (const account of accounts) {
    const key = /^\d{1,4}$/.test(account.mask || "")
      ? JSON.stringify([account.entity_slug, account.mask, account.account_kind])
      : JSON.stringify([account.account_slug]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  return [...groups.values()].map(members => {
    const live = members.filter(a => a.feed_mode === "live");
    const manual = members.filter(a => a.feed_mode === "manual");
    const primary = live[0] || members[0];
    const ambiguous = members.length > 1 && !(members.length === 2 && live.length === 1 && manual.length === 1 &&
      members.every(a => a.currency === primary.currency && a.balance_role === primary.balance_role));
    return { ...primary, members, live: live[0] || null, ambiguous };
  });
}

async function snapshotRows(env, accounts, sql, binds, { tenantId, mask, accountKind }) {
  // D1 batches run transactionally. Re-read the account mapping beside the
  // rows in that same snapshot, so a sync/assignment after account selection
  // cannot combine old coverage exclusions with new transactions or balances.
  const [inventory, facts] = await env.DB.batch([
    env.DB.prepare(ACCOUNTS_SQL).bind(tenantId, MAX_ACCOUNTS + 1),
    env.DB.prepare(sql).bind(...binds),
  ]);
  if (!Array.isArray(inventory?.results) || !Array.isArray(facts?.results)) throw new Error("ledger snapshot unavailable");
  const current = groupAccounts(inventory.results).filter(a => (!mask || a.mask === mask) && (!accountKind || a.account_kind === accountKind));
  if (JSON.stringify(current) !== JSON.stringify(accounts)) throw new Error("ledger mapping changed");
  return facts.results;
}

export function effectivePeriodCovered(account, from, to) {
  // A complete manual statement cannot fill a hole inside a partial live
  // window: those manual rows are excluded there by the same precedence rule.
  const intervals = [];
  for (const member of account.members) {
    if (member.coverage_status !== "complete" || member.coverage_basis !== "confirmed" || !validWindow(member)) continue;
    let pieces = [[member.covered_from, member.covered_to]];
    const live = account.live;
    if (member.feed_mode === "manual" && live && validWindow(live)) {
      pieces = pieces.flatMap(([start, end]) => {
        if (end < live.covered_from || start > live.covered_to) return [[start, end]];
        return [start < live.covered_from ? [start, shiftLedgerDay(live.covered_from, -1)] : null,
          end > live.covered_to ? [shiftLedgerDay(live.covered_to, 1), end] : null].filter(Boolean);
      });
    }
    intervals.push(...pieces);
  }
  intervals.sort(([a], [b]) => a.localeCompare(b));
  let cursor = from;
  for (const [start, end] of intervals) {
    if (end < cursor) continue;
    if (start > cursor) return false;
    if (end >= to) return true;
    cursor = shiftLedgerDay(end, 1);
  }
  return false;
}

export async function readEffectiveTransactions(env, accounts, { from, to, amountMinor = null,
  tenantId = env.BANK_FEED_TENANT || DEFAULT_TENANT, mask = null, accountKind = null } = {}) {
  const mapping = accounts.flatMap(account => account.members.map(member => ({
    slug: member.account_slug, effective: account.account_slug,
    exclude_from: member.feed_mode === "manual" && account.live && validWindow(account.live) ? account.live.covered_from : null,
    exclude_to: member.feed_mode === "manual" && account.live && validWindow(account.live) ? account.live.covered_to : null,
    last_synced_at: member.feed_mode === "live" ? member.last_synced_at : null,
  })));
  const result = await snapshotRows(env, accounts, `SELECT t.id,t.account_slug AS source_account_slug,
      json_extract(m.value,'$.effective') AS effective_account_slug,
      json_extract(m.value,'$.last_synced_at') AS last_synced_at,
      t.posted_on,t.amount_minor,t.direction,t.currency,t.description,t.payee,t.basis_state
    FROM json_each(?1) m JOIN fin_transactions t ON t.account_slug=json_extract(m.value,'$.slug')
    WHERE t.tenant_id=?2 AND t.superseded_by_id IS NULL AND t.removed_at IS NULL AND t.pending=0
      AND (t.posted_on BETWEEN ?3 AND ?4 OR t.posted_on IS NULL)
      AND (json_extract(m.value,'$.exclude_from') IS NULL OR t.posted_on IS NULL OR
        NOT (t.posted_on BETWEEN json_extract(m.value,'$.exclude_from') AND json_extract(m.value,'$.exclude_to')))
      AND (?5 IS NULL OR (t.amount_minor = ?5 AND t.direction='inflow') OR t.basis_state<>'confirmed' OR t.posted_on IS NULL)
    ORDER BY t.posted_on,t.id LIMIT ?6`, [JSON.stringify(mapping), tenantId, from, to, amountMinor, MAX_ROWS + 1], { tenantId, mask, accountKind });
  if (result.length > MAX_ROWS) throw new Error("ledger row limit");
  return result;
}

export async function readEffectiveBalances(env, accounts, {
  tenantId = env.BANK_FEED_TENANT || DEFAULT_TENANT, mask = null, accountKind = null,
} = {}) {
  const mapping = accounts.flatMap(account => account.members.map(member => ({
    slug: member.account_slug, effective: account.account_slug, live: member.feed_mode === "live" ? 1 : 0,
    last_synced_at: member.feed_mode === "live" ? member.last_synced_at : null,
  })));
  // Pick newest observation across twins, with live precedence only on ties.
  return snapshotRows(env, accounts, `WITH observations AS (
    SELECT b.id,b.account_slug AS source_account_slug,b.as_of_date,b.current_minor,b.currency,b.basis_state,
      json_extract(m.value,'$.effective') AS effective_account_slug,
      json_extract(m.value,'$.last_synced_at') AS last_synced_at,
      ROW_NUMBER() OVER (PARTITION BY json_extract(m.value,'$.effective')
        ORDER BY b.as_of_date DESC,b.recorded_at DESC,json_extract(m.value,'$.live') DESC,b.id DESC) AS rank
    FROM json_each(?) m JOIN fin_balance_snapshots b ON b.account_slug=json_extract(m.value,'$.slug')
    WHERE b.tenant_id=?) SELECT * FROM observations WHERE rank=1`, [JSON.stringify(mapping), tenantId], { tenantId, mask, accountKind });
}
