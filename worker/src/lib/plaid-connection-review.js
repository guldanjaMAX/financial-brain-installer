import { PlaidAccountEntityError } from "./plaid-account-entities.js";

const REVIEW_CODE = "plaid_duplicate_connection_review";
function review() {
  throw new PlaidAccountEntityError(REVIEW_CODE,
    "This bank may already be connected. Review the saved connection before adding another copy.", 409);
}

function reconnectSupport() {
  throw new PlaidAccountEntityError("plaid_reconnect_support_required",
    "This disconnected bank has saved history or prior sync progress. Contact support before reconnecting it so that history is not counted twice.", 409);
}

// Absence of current accounts alone is not proof of no promotion: superseded
// rows, withdrawn transactions and cursor/progress receipts also retain history.
// Keep this predicate identical in preflight and the atomic cleanup guard.
const NEVER_PROMOTED_ITEM = `SELECT 1 FROM bank_feed_items i
  WHERE i.tenant_id=?1 AND i.item_ref=?2 AND i.removed_at IS NOT NULL
    AND (i.cursor IS NULL OR i.cursor='') AND i.last_synced_at IS NULL
    AND i.cursor_updated_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM fin_accounts WHERE tenant_id=?1 AND source_feed=?3)
    AND NOT EXISTS (SELECT 1 FROM fin_transactions WHERE tenant_id=?1 AND source_feed=?3)
    AND NOT EXISTS (SELECT 1 FROM fin_balance_snapshots WHERE tenant_id=?1 AND source_feed=?3)
    AND NOT EXISTS (SELECT 1 FROM fin_account_coverage WHERE tenant_id=?1 AND source_feed=?3)
    AND NOT EXISTS (SELECT 1 FROM fin_obligations WHERE tenant_id=?1 AND source_feed=?3)
    AND NOT EXISTS (SELECT 1 FROM bank_feed_backfill WHERE tenant_id=?1 AND item_ref=?2
      AND (pages_done>0 OR transactions_seen>0 OR finished_at IS NOT NULL OR state='complete'))
    AND NOT EXISTS (SELECT 1 FROM plaid_sync_windows WHERE tenant_id=?1 AND item_ref=?2 AND state='promoted')`;

/** Only abandoned provider staging is disposable; ledger and custody receipts stay. */
export function plaidStagingCleanupStatements(env, tenantId, itemRef) {
  const window = "SELECT window_ref FROM plaid_sync_windows WHERE tenant_id=? AND item_ref=?";
  return [
    env.DB.prepare(`DELETE FROM plaid_sync_stage_transactions
      WHERE tenant_id=? AND window_ref IN (${window})`).bind(tenantId, tenantId, itemRef),
    env.DB.prepare(`DELETE FROM plaid_sync_stage_accounts
      WHERE tenant_id=? AND window_ref IN (${window})`).bind(tenantId, tenantId, itemRef),
    env.DB.prepare("DELETE FROM plaid_sync_windows WHERE tenant_id=? AND item_ref=?").bind(tenantId, itemRef),
  ];
}

/**
 * Link metadata is an ambiguity signal, never proof that two accounts are the
 * same. Do not merge, delete, or reassign financial history from a name or mask.
 * Plaid recommends this review before the one-time public-token exchange:
 * https://plaid.com/docs/link/duplicate-items/
 *
 * Caller holds the tenant's new-connection exchange claim. This closes the
 * gap where two sessions both inspect an empty inventory and then exchange.
 */
export async function assertPlaidConnectionDistinct(env, { tenantId, institutionRef, accounts }) {
  const items = (await env.DB.prepare(
    `SELECT item_ref,institution_ref,removed_at FROM bank_feed_items WHERE tenant_id=? LIMIT 251`,
  ).bind(tenantId).all())?.results;
  if (!Array.isArray(items) || items.length > 250) review();
  if (items.length === 0) return;
  if (typeof institutionRef !== "string" || !institutionRef || institutionRef.length > 200 ||
      items.some((item) => !item.institution_ref)) review();
  const relevant = items.filter((item) => item.institution_ref === institutionRef);
  if (!relevant.length) return;
  const active = relevant.filter((item) => item.removed_at === null);
  if (active.length) {
    if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > 250) review();
    const incoming = accounts.map((account) => {
      if (!account || typeof account !== "object" || Array.isArray(account) ||
          typeof account.id !== "string" || !account.id || account.id.length > 256 ||
          typeof account.name !== "string" || !account.name.trim() || account.name.length > 512 ||
          typeof account.mask !== "string" || !/^[A-Za-z0-9*]{2,4}$/.test(account.mask)) review();
      return { id: account.id, mask: account.mask.toLowerCase() };
    });
    for (const item of active) {
      const saved = (await env.DB.prepare(
        `SELECT external_ref AS provider_account_id,mask FROM fin_accounts
          WHERE tenant_id=? AND source_feed=? AND superseded_by_id IS NULL
         UNION
         SELECT s.provider_account_id,s.mask FROM plaid_sync_stage_accounts s
          JOIN plaid_sync_windows w ON w.tenant_id=s.tenant_id AND w.window_ref=s.window_ref
          WHERE s.tenant_id=? AND w.item_ref=? LIMIT 501`,
      ).bind(tenantId, `bank-feed:${item.item_ref}`, tenantId, item.item_ref).all())?.results;
      if (!Array.isArray(saved) || saved.length === 0 || saved.length > 500) review();
      for (const prior of saved) {
        if (typeof prior.mask !== "string" || !/^[A-Za-z0-9*]{2,4}$/.test(prior.mask)) review();
        if (incoming.some((account) => account.id === prior.provider_account_id ||
            account.mask === prior.mask.toLowerCase())) review();
      }
    }
  }
  const abandoned = [];
  for (const item of relevant.filter((item) => item.removed_at !== null)) {
    const proof = await env.DB.prepare(`SELECT EXISTS (${NEVER_PROMOTED_ITEM}) AS never_promoted`)
      .bind(tenantId, item.item_ref, `bank-feed:${item.item_ref}`).first();
    if (proof?.never_promoted !== 1) reconnectSupport();
    abandoned.push(item.item_ref);
  }
  // Do not erase old staging until every duplicate decision has passed. A
  // removed Item cannot promote through the sync lease fence. Recheck here
  // anyway so changed custody/history rolls the entire cleanup back.
  if (abandoned.length) {
    await env.DB.batch(abandoned.flatMap((itemRef) => [
      env.DB.prepare(`SELECT CASE WHEN EXISTS (${NEVER_PROMOTED_ITEM})
        THEN 1 ELSE json_extract('plaid reconnect history changed','$') END AS reconnect_cleanup_guard`)
        .bind(tenantId, itemRef, `bank-feed:${itemRef}`),
      ...plaidStagingCleanupStatements(env, tenantId, itemRef),
    ]));
  }
}
