import { LEGACY_EXPORT_IDENTITY_WHERE, transactionShape, transactionUid } from "./fin-import.js";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_ROWS = 2000;
// Snapshot every field that authorizes an identity decision. The same ordered
// serialization is checked inside the write transaction, including membership,
// so an intervening import, edit or tombstone cannot use an old approval.
const SNAPSHOT_SQL = `SELECT json_group_array(json_object(
  'id',id,'txn_uid',txn_uid,'source_doc_uid',source_doc_uid,'source_locator',source_locator,
  'posted_on',posted_on,'amount_minor',amount_minor,'direction',direction,
  'description',description,'currency',currency,'basis_state',basis_state,'removed_at',removed_at,
  'protected',EXISTS (SELECT 1 FROM fin_exceptions e WHERE e.tenant_id=t.tenant_id AND e.txn_uid=t.txn_uid)
    OR EXISTS (SELECT 1 FROM fin_reconciliation_claims c WHERE c.tenant_id=t.tenant_id
      AND c.claim_ref_table='fin_transactions' AND c.claim_ref_uid=t.txn_uid)
    OR EXISTS (SELECT 1 FROM fin_reconciliations r WHERE r.tenant_id=t.tenant_id AND r.account_slug=t.account_slug)
    OR EXISTS (SELECT 1 FROM fin_period_closes p JOIN fin_accounts a
      ON a.tenant_id=p.tenant_id AND a.entity_slug=p.entity_slug AND a.superseded_by_id IS NULL
      WHERE a.tenant_id=t.tenant_id AND a.account_slug=t.account_slug)))
  FROM (SELECT current.* FROM fin_transactions current WHERE tenant_id=?1 AND account_slug=?2
    AND provenance='extracted' AND external_id IS NULL AND superseded_by_id IS NULL
    AND EXISTS (SELECT 1 FROM fin_transactions legacy
      WHERE legacy.tenant_id=current.tenant_id AND legacy.account_slug=current.account_slug
        AND legacy.posted_on IS current.posted_on AND legacy.amount_minor IS current.amount_minor
        AND legacy.direction IS current.direction AND legacy.provenance='extracted'
        AND legacy.external_id IS NULL AND legacy.superseded_by_id IS NULL
        AND substr(legacy.txn_uid,1,length(legacy.account_slug)+6)=legacy.account_slug||':line:')
    ORDER BY posted_on,amount_minor,direction,id LIMIT ${MAX_ROWS + 1}) t`;

async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function scope(tenantId, accountSlug) {
  if (!SLUG.test(tenantId) || !SLUG.test(accountSlug)) throw new Error("invalid maintenance scope");
}

const asTransaction = row => ({ postedOn: row.posted_on, amountMinor: row.amount_minor,
  direction: row.direction, description: row.description });

/**
 * Owner-reviewed maintenance, never invoked by an import or schema upgrade.
 *
 * Multiple source documents may mean overlapping exports or distinct identical
 * charges. Retained rows cannot prove which. Report those row IDs for a separate
 * owner decision; never delete, tombstone or silently merge them here. The import gate
 * stays closed until the last legacy identity has been recovered.
 */
export async function rekeyBankExportTransactions(env, {
  tenantId = "primary", accountSlug, dryRun = true, confirm = false, expectedPlanHash = null,
} = {}) {
  scope(tenantId, accountSlug);
  const result = await env.DB.prepare(`SELECT (${SNAPSHOT_SQL}) AS snapshot`).bind(tenantId, accountSlug).first();
  if (typeof result?.snapshot !== "string") throw new Error("maintenance inventory unavailable");
  const inventory = JSON.parse(result.snapshot);
  const bucket = row => JSON.stringify([row.posted_on, row.amount_minor, row.direction]);
  // Keep complete identity buckets together. No ordinal or cross-document
  // collision may be decided from only one side of a page boundary.
  const hasMore = inventory.length > MAX_ROWS;
  const boundary = hasMore ? bucket(inventory.at(-1)) : null;
  const rows = hasMore ? inventory.filter(row => bucket(row) !== boundary) : inventory;
  if (!rows.length && hasMore) throw new Error("An identity group exceeds 2000 rows. Keep imports blocked and request a separately reviewed identity plan; no rows changed.");
  const legacy = rows.filter(row => row.txn_uid.startsWith(`${accountSlug}:line:`));
  const groups = new Map();
  for (const row of rows) {
    const key = transactionShape(asTransaction(row));
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const rekeys = [];
  const review = new Set();
  for (const group of groups.values()) {
    if (!group.some(row => row.txn_uid.startsWith(`${accountSlug}:line:`))) continue;
    const documents = new Set(group.map(row => row.source_doc_uid));
    // Unparsed content and mixed currencies cannot establish a stable charge
    // identity. Existing v2 rows in a legacy group may already be duplicates.
    if (documents.size !== 1 || documents.has(null) ||
        new Set(group.map(row => row.currency)).size !== 1 ||
        group.some(row => row.protected || row.removed_at !== null || row.basis_state === "unparsed" || !row.posted_on ||
          row.amount_minor === null || !row.direction || !row.txn_uid.startsWith(`${accountSlug}:line:`))) {
      for (const row of group) review.add(row.id);
      continue;
    }
    // Identical lines are interchangeable, but their multiplicity is not.
    // Durable IDs give a repeatable order without depending on CSV row numbers.
    group.forEach((row, ordinal) => rekeys.push({ id: row.id,
      txn_uid: transactionUid(accountSlug, asTransaction(row), ordinal) }));
  }
  // A digest collision must stop for review, never turn into an ignored write.
  const targets = new Set();
  for (const change of rekeys) {
    if (targets.has(change.txn_uid)) for (const candidate of rekeys) review.add(candidate.id);
    targets.add(change.txn_uid);
  }
  const planHash = await digest(JSON.stringify(["bank-export-rekey-v2", tenantId, accountSlug, result.snapshot]));
  const receipt = { dry_run: dryRun, candidate_count: legacy.length, mutation_count: 0,
    has_more: hasMore, complete: !hasMore && legacy.length === 0,
    blocked: review.size > 0, review_row_ids: [...review].sort((a, b) => a - b), plan_hash: planHash };
  if (dryRun) return receipt;
  if (confirm !== true || typeof expectedPlanHash !== "string") throw new Error("exact owner approval is required");
  // A successful replay has no remaining legacy rows, even with its old hash.
  if (!legacy.length) return receipt;
  if (expectedPlanHash !== planHash) throw new Error("maintenance approval is stale; preview again");
  if (review.size) throw new Error("ambiguous export identities require separate owner review");
  if (typeof env.DB.batch !== "function") throw new Error("atomic maintenance is unavailable");
  const statements = [
    env.DB.prepare(`SELECT CASE WHEN (${SNAPSHOT_SQL})=? THEN 1
      ELSE json_extract('bank export maintenance snapshot changed','$') END AS maintenance_guard`)
      .bind(tenantId, accountSlug, result.snapshot),
    env.DB.prepare(`UPDATE fin_transactions SET txn_uid=(
      SELECT json_extract(value,'$.txn_uid') FROM json_each(?3) WHERE json_extract(value,'$.id')=fin_transactions.id)
      WHERE tenant_id=?1 AND account_slug=?2 AND ${LEGACY_EXPORT_IDENTITY_WHERE}
        AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?3))`)
      .bind(tenantId, accountSlug, JSON.stringify(rekeys)),
    // Readback belongs to the same transaction: a mismatch aborts the write.
    env.DB.prepare(`SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM json_each(?3) p LEFT JOIN fin_transactions t
        ON t.tenant_id=?1 AND t.account_slug=?2 AND t.id=json_extract(p.value,'$.id')
      WHERE t.id IS NULL OR t.txn_uid<>json_extract(p.value,'$.txn_uid'))
      THEN 1 ELSE json_extract('bank export maintenance readback failed','$') END AS verified`)
      .bind(tenantId, accountSlug, JSON.stringify(rekeys)),
  ];
  statements.push(env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM fin_transactions
    WHERE tenant_id=? AND account_slug=? AND ${LEGACY_EXPORT_IDENTITY_WHERE}) AS remaining`)
    .bind(tenantId, accountSlug));
  const committed = await env.DB.batch(statements);
  const remaining = committed.at(-1)?.results?.[0]?.remaining;
  if (remaining !== 0 && remaining !== 1) throw new Error("maintenance completion readback unavailable");
  return { ...receipt, mutation_count: rekeys.length, complete: remaining === 0, has_more: remaining === 1 };
}

/** Counts only. A separate owner-approved action must authorize any backfill. */
export async function previewFeedCategoryBackfill(env, { tenantId = "primary" } = {}) {
  if (!SLUG.test(tenantId)) throw new Error("invalid maintenance scope");
  const row = await env.DB.prepare(`SELECT COUNT(*) AS candidates FROM fin_transactions
    WHERE tenant_id=? AND provenance='feed' AND category IS NOT NULL
      AND category_basis_state IS NULL AND removed_at IS NULL AND superseded_by_id IS NULL`)
    .bind(tenantId).first();
  if (!Number.isSafeInteger(row?.candidates) || row.candidates < 0) throw new Error("category inventory unavailable");
  return { dry_run: true, candidate_count: row.candidates, mutation_count: 0, requires_owner_approval: true };
}
