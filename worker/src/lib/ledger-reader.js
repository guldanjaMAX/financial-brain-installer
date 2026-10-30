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
      CASE WHEN c.coverage_status='complete' AND c.basis_note LIKE 'Read from a bank export covering %'
        THEN 1 ELSE 0 END AS coverage_review_required,
      CASE WHEN a.feed_mode='live' AND c.coverage_status='complete' AND c.covered_from IS NULL
        AND c.basis_state='confirmed' AND c.provenance='feed' AND c.source_feed=a.source_feed
        AND i.status='connected' AND i.removed_at IS NULL
        AND b.state='complete' AND b.provider_history_state='HISTORICAL_UPDATE_COMPLETE'
        AND b.unread_lines=0 AND b.requested_days BETWEEN 1 AND 730
        AND b.queued_at<=b.finished_at AND b.finished_at=i.last_synced_at
        AND substr(b.finished_at,1,10)=c.covered_to
        AND date(substr(b.queued_at,1,10),'+0 days')=substr(b.queued_at,1,10)
        AND NOT EXISTS (SELECT 1 FROM plaid_sync_windows w WHERE w.tenant_id=a.tenant_id AND w.item_ref=i.item_ref)
        AND NOT EXISTS (SELECT 1 FROM fin_transactions t WHERE t.tenant_id=a.tenant_id
          AND t.account_slug=a.account_slug AND t.superseded_by_id IS NULL AND t.removed_at IS NULL)
        AND EXISTS (SELECT 1 FROM fin_balance_snapshots z WHERE z.tenant_id=a.tenant_id AND z.account_slug=a.account_slug)
        AND NOT EXISTS (SELECT 1 FROM fin_balance_snapshots z WHERE z.tenant_id=a.tenant_id AND z.account_slug=a.account_slug
          AND (z.current_minor IS NULL OR z.current_minor<>0 OR COALESCE(z.available_minor,0)<>0
            OR z.basis_state<>'confirmed' OR z.currency<>'USD'))
        THEN date(substr(b.queued_at,1,10),printf('-%d days',b.requested_days-1)) END AS empty_provider_from,
      l.manual_account_slug AS link_manual,l.live_account_slug AS link_live,l.identity_json AS link_identity
    FROM fin_accounts a
    JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
      AND e.superseded_by_id IS NULL AND e.relationship='owned' AND e.basis_state='confirmed'
    LEFT JOIN fin_account_coverage c ON c.tenant_id=a.tenant_id AND c.account_slug=a.account_slug
      AND c.superseded_by_id IS NULL
    LEFT JOIN bank_feed_items i ON i.tenant_id=a.tenant_id AND a.source_feed=('bank-feed:'||i.item_ref)
    LEFT JOIN bank_feed_backfill b ON b.tenant_id=i.tenant_id AND b.item_ref=i.item_ref
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
  const pairKey = pair => JSON.stringify([pair.manual.account_slug, pair.live.account_slug]);
  const addUnresolved = pair => {
    // One account can collide with several records. Retain every edge until
    // the question's window is checked; a later historical pair cannot erase
    // an overlapping pair. The inventory limit bounds this candidate graph.
    for (const member of [pair.manual, pair.live]) {
      if (!unresolved.has(member.account_slug)) unresolved.set(member.account_slug, new Map());
      unresolved.get(member.account_slug).set(pairKey(pair), pair);
    }
  };
  for (const a of accounts) {
    if (!a.link_manual) continue;
    const manual = bySlug.get(a.link_manual), live = bySlug.get(a.link_live);
    if (manual && live && manual.feed_mode === 'manual' && live.feed_mode === 'live' &&
        manual.basis_state === 'confirmed' && live.basis_state === 'confirmed' &&
        a.link_identity === JSON.stringify([accountLinkIdentity(manual), accountLinkIdentity(live)])) {
      approved.set(manual.account_slug, live.account_slug);
    } else addUnresolved({ manual: manual || { account_slug: a.link_manual }, live: live || { account_slug: a.link_live } });
  }
  // Coincident institution/entity/mask/kind are candidates, never authority.
  // Missing institution is also uncertain. Only an approved pair may suppress
  // overlapping rows, even when external references happen to look alike.
  for (const manual of accounts.filter(a => a.feed_mode === 'manual')) {
    for (const live of accounts.filter(a => a.feed_mode === 'live')) {
      if (approved.get(manual.account_slug) === live.account_slug) continue;
      if (/^\d{1,4}$/.test(manual.mask || '') && identity(manual) === identity(live) &&
          (!institution(manual) || !institution(live) || institution(manual) === institution(live))) {
        addUnresolved({ manual, live });
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
    const links = new Map(members.flatMap(a => [...(unresolved.get(a.account_slug) || [])]));
    const linkRequired = links.size ? [...links.values()] : null;
    const ambiguous = members.length > 1 && !(members.length === 2 && live.length === 1 && manual.length === 1 &&
      members.every(a => a.currency === primary.currency && a.balance_role === primary.balance_role));
    return { ...primary, members, live: live[0] || null, ambiguous, linkRequired };
  });
}

export function accountLinkRequiredInWindow(account, intent) {
  return accountLinkPairsInWindow(account, intent).length > 0;
}

export function accountLinkPairsInWindow(account, intent) {
  if (!intent.kind) return [];
  return (account.linkRequired || []).filter(pair => {
    if (!intent.from || !intent.to) return true;
    // A known non-overlapping interval proves this collision is irrelevant.
    // Missing coverage cannot prove that, so it keeps the identity gate closed.
    const known = [pair.manual, pair.live].filter(a => a && validWindow(a));
    const start = [intent.from, ...known.map(a => a.covered_from)].sort().at(-1);
    const end = [intent.to, ...known.map(a => a.covered_to)].sort()[0];
    return start <= end;
  });
}

function selectedSnapshotAccounts(accounts, { mask, accountKind, effectiveAccountSlugs = null }) {
  let allowed = null;
  if (effectiveAccountSlugs !== null) {
    if (!Array.isArray(effectiveAccountSlugs) || !effectiveAccountSlugs.length ||
        effectiveAccountSlugs.some(slug => typeof slug !== "string" || !slug.length) ||
        new Set(effectiveAccountSlugs).size !== effectiveAccountSlugs.length) {
      throw new Error("ledger account allow-list invalid");
    }
    allowed = new Set(effectiveAccountSlugs);
  }
  const selected = accounts.filter(account => (!allowed || allowed.has(account.account_slug)) &&
    (!mask || account.mask === mask) && (!accountKind || account.account_kind === accountKind));
  if (allowed && selected.length !== allowed.size) throw new Error("ledger account allow-list changed");
  return selected;
}

async function snapshotRows(env, accounts, sql, binds, { tenantId, mask, accountKind,
  effectiveAccountSlugs = null }) {
  // D1 batches run transactionally. Re-read the account mapping beside the
  // rows in that same snapshot, so a sync/assignment after account selection
  // cannot combine old coverage exclusions with new transactions or balances.
  const [inventory, facts] = await env.DB.batch([
    env.DB.prepare(ACCOUNTS_SQL).bind(tenantId, MAX_ACCOUNTS + 1),
    env.DB.prepare(sql).bind(...binds),
  ]);
  if (!Array.isArray(inventory?.results) || !Array.isArray(facts?.results)) throw new Error("ledger snapshot unavailable");
  const currentInventory = groupAccounts(inventory.results);
  const current = selectedSnapshotAccounts(currentInventory, { mask, accountKind, effectiveAccountSlugs });
  // An explicit effective-account list is derived from the whole authorized
  // inventory. Validate that inventory in this same snapshot, while the facts
  // query and its row bound remain limited to the exact selected mappings.
  const expected = effectiveAccountSlugs === null ? current : currentInventory;
  if (JSON.stringify(expected) !== JSON.stringify(accounts)) throw new Error("ledger mapping changed");
  return facts.results;
}

const unknownTwinCoverage = account => account.members.length > 1 && account.live &&
  (!validWindow(account.live) || account.live.coverage_review_required || account.live.coverage_status !== "complete" || account.live.coverage_basis !== "confirmed");

export function effectivePeriodCovered(account, from, to) {
  // The legacy upsert preserved "complete" while replacing the basis with a
  // partial-export note and widening MIN/MAX bounds. That fingerprint cannot
  // certify any gap, including before the next import. No stored row is fixed
  // or deleted here; a fresh independent coverage review must replace it.
  if (account.members.some(member => member.coverage_review_required)) return false;
  // Legacy empty feeds may lack a start even after historical promotion.
  // This deliberately requires zero activity for the entire stored history,
  // a confirmed zero balance and the matching completed provider receipt.
  // Emptiness alone is never coverage, and an unknown twin is never suppressed.
  if (account.members.length === 1 && account.empty_provider_from &&
      validWindow({ covered_from: account.empty_provider_from, covered_to: account.covered_to })) {
    return account.empty_provider_from <= from && account.covered_to >= to;
  }
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
  tenantId = env.BANK_FEED_TENANT || DEFAULT_TENANT, mask = null, accountKind = null,
  effectiveAccountSlugs = null } = {}) {
  const selected = selectedSnapshotAccounts(accounts, { mask, accountKind, effectiveAccountSlugs });
  if (selected.some(unknownTwinCoverage)) throw new Error("ledger twin coverage unknown");
  const mapping = selected.flatMap(account => account.members.map(member => ({
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
      t.posted_on,t.amount_minor,t.direction,t.currency,t.description,t.payee,t.category,t.category_basis_state,t.basis_state,
      CASE WHEN t.provenance='extracted' THEN EXISTS (
        SELECT 1 FROM fin_transactions other WHERE other.tenant_id=t.tenant_id AND other.account_slug=t.account_slug
          AND other.provenance='extracted' AND other.superseded_by_id IS NULL AND other.removed_at IS NULL
          AND other.pending=0 AND other.posted_on=t.posted_on AND other.amount_minor=t.amount_minor
          AND other.direction=t.direction AND other.currency=t.currency
          AND (other.external_id IS NULL)<>(t.external_id IS NULL)
      ) ELSE 0 END AS export_overlap_review
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
  [JSON.stringify(mapping), tenantId, from, to, amountMinor, MAX_ROWS + 1], {
    tenantId, mask, accountKind, effectiveAccountSlugs,
  });
  if (result.length > MAX_ROWS) throw new Error("ledger row limit");
  // Sorting in SQL before LIMIT scans the entire covered range. Sort only
  // after the bound is proven, so a large ledger stops at the overflow row.
  return result.sort((a, b) => String(a.posted_on || "").localeCompare(String(b.posted_on || "")) || a.id - b.id);
}

export async function readEffectiveBalances(env, accounts, {
  tenantId = env.BANK_FEED_TENANT || DEFAULT_TENANT, mask = null, accountKind = null,
  effectiveAccountSlugs = null,
} = {}) {
  const selected = selectedSnapshotAccounts(accounts, { mask, accountKind, effectiveAccountSlugs });
  const mapping = selected.flatMap(account => account.members.map(member => ({
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
    WHERE b.tenant_id=?) SELECT * FROM observations WHERE rank=1`, [JSON.stringify(mapping), tenantId], {
      tenantId, mask, accountKind, effectiveAccountSlugs,
    });
}
