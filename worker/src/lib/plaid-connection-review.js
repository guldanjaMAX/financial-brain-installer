import { PlaidAccountEntityError } from "./plaid-account-entities.js";

const REVIEW_CODE = "plaid_duplicate_connection_review";
function review() {
  throw new PlaidAccountEntityError(REVIEW_CODE,
    "This bank may already be connected. Review the saved connection before adding another copy.", 409);
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
    `SELECT item_ref,institution_ref FROM bank_feed_items WHERE tenant_id=? LIMIT 251`,
  ).bind(tenantId).all())?.results;
  if (!Array.isArray(items) || items.length > 250) review();
  if (items.length === 0) return;
  if (typeof institutionRef !== "string" || !institutionRef || institutionRef.length > 200 ||
      items.some((item) => !item.institution_ref)) review();
  const relevant = items.filter((item) => item.institution_ref === institutionRef);
  if (!relevant.length) return;
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > 250) review();
  const incoming = accounts.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account) ||
        typeof account.id !== "string" || !account.id || account.id.length > 256 ||
        typeof account.name !== "string" || !account.name.trim() || account.name.length > 512 ||
        typeof account.mask !== "string" || !/^[A-Za-z0-9*]{2,4}$/.test(account.mask)) review();
    return { id: account.id, mask: account.mask.toLowerCase() };
  });
  for (const item of relevant) {
    // Retain disconnected history in this check. Connecting again must not
    // quietly count the same historical account as new money.
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
