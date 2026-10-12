import { DEFAULT_TENANT } from "./fin-d1.js";
import { ledgerDay, shiftLedgerDay } from "./ledger-question.js";
import { accountLinkIdentity } from "./fin-account-links.js";

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

// Labels identify transfer counterparts; provider references only validate the
// owner's saved link. Neither reference nor credential is exposed in citations.
const ACCOUNTS_SQL = `SELECT a.id,a.account_slug,a.entity_slug,a.mask,a.account_kind,a.institution,a.label,a.external_ref,a.source_feed,
      a.currency,a.feed_mode,a.balance_role,a.basis_state,c.coverage_status,c.covered_from,c.covered_to,
      c.basis_state AS coverage_basis,i.last_synced_at,
      l.manual_account_slug AS link_manual,l.live_account_slug AS link_live,l.identity_json AS link_identity
    FROM fin_accounts a
    JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
      AND e.superseded_by_id IS NULL AND e.relationship='owned' AND e.basis_state='confirmed'
    LEFT JOIN fin_account_coverage c ON c.tenant_id=a.tenant_id AND c.account_slug=a.account_slug
      AND c.superseded_by_id IS NULL
    LEFT JOIN bank_feed_items i ON i.tenant_id=a.tenant_id AND a.source_feed=('bank-feed:'||i.item_ref)
    LEFT JOIN fin_account_links l ON l.tenant_id=a.tenant_id AND l.unlinked_at IS NULL
      AND (l.manual_account_slug=a.account_slug OR l.live_account_slug=a.account_slug)
    WHERE a.tenant_id=? AND a.superseded_by_id IS NULL
    ORDER BY a.entity_slug,a.account_slug LIMIT ?`;

export async function readEffectiveAccounts(env, { tenantId = env.BANK_FEED_TENANT || DEFAULT_TENANT } = {}) {
  return groupAccounts(await rows(env, ACCOUNTS_SQL, [tenantId, MAX_ACCOUNTS + 1]));
}

function groupAccounts(accounts) {
  if (accounts.length > MAX_ACCOUNTS) throw new Error("ledger account limit");
  const groups = new Map();
  const institution = a => String(a.institution || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const identity = a => JSON.stringify([a.entity_slug, a.mask, a.account_kind]);
  const bySlug = new Map(accounts.map(a => [a.account_slug, a]));
  const approved = new Map(), unresolved = new Map();
  for (const a of accounts) {
    if (!a.link_manual) continue;
    const manual = bySlug.get(a.link_manual), live = bySlug.get(a.link_live);
    if (manual && live && manual.feed_mode === 'manual' && live.feed_mode === 'live' &&
        manual.basis_state === 'confirmed' && live.basis_state === 'confirmed' &&
        a.link_identity === JSON.stringify([accountLinkIdentity(manual), accountLinkIdentity(live)])) {
      approved.set(manual.account_slug, live.account_slug);
    } else unresolved.set(a.account_slug, { manual: manual || { account_slug: a.link_manual }, live: live || { account_slug: a.link_live } });
  }
  // Coincident institution/entity/mask/kind are candidates, never authority.
  // Missing institution is also uncertain. Only an approved pair may suppress
  // overlapping rows, even when external references happen to look alike.
  for (const manual of accounts.filter(a => a.feed_mode === 'manual')) {
    for (const live of accounts.filter(a => a.feed_mode === 'live')) {
      if (approved.get(manual.account_slug) === live.account_slug) continue;
      if (/^\d{1,4}$/.test(manual.mask || '') && identity(manual) === identity(live) &&
          (!institution(manual) || !institution(live) || institution(manual) === institution(live))) {
        const candidate = { manual, live };
        unresolved.set(manual.account_slug, candidate); unresolved.set(live.account_slug, candidate);
      }
    }
  }
  for (const account of accounts) {
    const key = approved.get(account.account_slug) || account.account_slug;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  return [...groups.values()].map(members => {
    const live = members.filter(a => a.feed_mode === "live");
    const manual = members.filter(a => a.feed_mode === "manual");
    const primary = live[0] || members[0];
    const linkRequired = members.map(a => unresolved.get(a.account_slug)).find(Boolean);
    const ambiguous = Boolean(linkRequired) || members.length > 1 && !(members.length === 2 && live.length === 1 && manual.length === 1 &&
      members.every(a => a.currency === primary.currency && a.balance_role === primary.balance_role));
    return { ...primary, members, live: live[0] || null, ambiguous, linkRequired };
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

const unknownTwinCoverage = account => account.members.length > 1 && account.live &&
  (!validWindow(account.live) || account.live.coverage_status !== "complete" || account.live.coverage_basis !== "confirmed");

export function effectivePeriodCovered(account, from, to) {
  // Admission and row precedence must refuse the same unbounded live overlap.
  if (unknownTwinCoverage(account)) return false;
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
  if (accounts.some(unknownTwinCoverage)) throw new Error("ledger twin coverage unknown");
  const mapping = accounts.flatMap(account => account.members.map(member => ({
    slug: member.account_slug, effective: account.account_slug,
    // A twin's live rows are authoritative only inside its proven interval;
    // the complete manual source supplies the outside interval alone.
    include_from: member.feed_mode === "live" && account.members.length > 1 ? member.covered_from : null,
    include_to: member.feed_mode === "live" && account.members.length > 1 ? member.covered_to : null,
    exclude_from: member.feed_mode === "manual" && account.live && validWindow(account.live) ? account.live.covered_from : null,
    exclude_to: member.feed_mode === "manual" && account.live && validWindow(account.live) ? account.live.covered_to : null,
    last_synced_at: member.feed_mode === "live" ? member.last_synced_at : null,
  })));
  const select = `SELECT t.id,t.account_slug AS source_account_slug,
      json_extract(m.value,'$.effective') AS effective_account_slug,
      json_extract(m.value,'$.last_synced_at') AS last_synced_at,
      t.posted_on,t.amount_minor,t.direction,t.currency,t.description,t.payee,t.category,t.category_basis_state,t.basis_state
    FROM json_each(?1) m CROSS JOIN fin_transactions t INDEXED BY idx_fin_transactions_account ON t.account_slug=json_extract(m.value,'$.slug')
    WHERE t.tenant_id=?2 AND t.superseded_by_id IS NULL AND t.removed_at IS NULL AND t.pending=0
      AND (json_extract(m.value,'$.exclude_from') IS NULL OR t.posted_on IS NULL OR
        NOT (t.posted_on BETWEEN json_extract(m.value,'$.exclude_from') AND json_extract(m.value,'$.exclude_to')))
      AND (json_extract(m.value,'$.include_from') IS NULL OR t.posted_on IS NULL OR
        t.posted_on BETWEEN json_extract(m.value,'$.include_from') AND json_extract(m.value,'$.include_to'))
      AND (?5 IS NULL OR (t.amount_minor = ?5 AND t.direction='inflow') OR t.basis_state<>'confirmed' OR t.posted_on IS NULL)
    `;
  // Separate the undated refusal arm so both arms use the account/date index.
  // CROSS JOIN fixes the small mapping as the outer loop; SQLite otherwise
  // chooses a tenant-wide scan for json_each despite the account/date index.
  const result = await snapshotRows(env, accounts, `SELECT * FROM (
    ${select} AND t.posted_on BETWEEN ?3 AND ?4
    UNION ALL ${select} AND t.posted_on IS NULL
    ) LIMIT ?6`,
  [JSON.stringify(mapping), tenantId, from, to, amountMinor, MAX_ROWS + 1], { tenantId, mask, accountKind });
  if (result.length > MAX_ROWS) throw new Error("ledger row limit");
  // Sorting in SQL before LIMIT scans the entire covered range. Sort only
  // after the bound is proven, so a large ledger stops at the overflow row.
  return result.sort((a, b) => String(a.posted_on || "").localeCompare(String(b.posted_on || "")) || a.id - b.id);
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
