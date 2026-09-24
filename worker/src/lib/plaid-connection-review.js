import { PlaidAccountEntityError } from "./plaid-account-entities.js";

const REVIEW_CODE = "plaid_duplicate_connection_review";
function review() {
  throw new PlaidAccountEntityError(REVIEW_CODE,
    "This bank may already be connected. Review the saved connection before adding another copy.", 409);
}

function normalizedText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function plaidIdentity(locator) {
  const prefix = "plaid/account-identity/";
  if (typeof locator !== "string" || !locator.startsWith(prefix)) return null;
  const parts = locator.slice(prefix.length).split("/");
  if (parts.length !== 3) return null;
  try {
    const [type, subtype, persistentAccountId] = parts.map((part) => decodeURIComponent(part));
    if (!type || type === "-" || !subtype || subtype === "-") return null;
    return {
      type: normalizedText(type),
      subtype: normalizedText(subtype),
      persistentAccountId: persistentAccountId === "-" ? null : persistentAccountId,
    };
  } catch {
    return null;
  }
}

/**
 * Link metadata is an ambiguity signal, never general merge authority. A live
 * match always refuses. A complete, unambiguous match against one removed Item
 * becomes a narrow reattach plan that the caller applies only after exchange.
 * A legacy removed ledger row with no identity locator may use the same private
 * plan only to reach staged review; authoritative reconciliation cannot promote it.
 * Plaid recommends this review before the one-time public-token exchange:
 * https://plaid.com/docs/link/duplicate-items/
 *
 * Caller holds the tenant's new-connection exchange claim. This closes the
 * gap where two sessions both inspect an empty inventory and then exchange.
 */
export async function assertPlaidConnectionDistinct(env, {
  tenantId,
  institutionRef,
  environment,
  accounts,
}) {
  const items = (await env.DB.prepare(
    `SELECT item_ref,institution_ref,environment,status,removed_at
       FROM bank_feed_items WHERE tenant_id=? LIMIT 251`,
  ).bind(tenantId).all())?.results;
  if (!Array.isArray(items) || items.length > 250) review();
  if (items.length === 0) return { action: "create", accounts: [] };
  if (typeof institutionRef !== "string" || !institutionRef || institutionRef.length > 200 ||
      items.some((item) => !item.institution_ref)) review();
  const relevant = items.filter((item) => item.institution_ref === institutionRef);
  if (!relevant.length) return { action: "create", accounts: [] };
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > 250) review();
  const incoming = accounts.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account) ||
        typeof account.id !== "string" || !account.id || account.id.length > 256 ||
        typeof account.name !== "string" || !account.name.trim() || account.name.length > 512 ||
        typeof account.mask !== "string" || !/^[A-Za-z0-9*]{2,4}$/.test(account.mask)) review();
    const type = normalizedText(account.type);
    const subtype = normalizedText(account.subtype);
    const accountKind = normalizedText(account.accountKind);
    return {
      id: account.id,
      name: normalizedText(account.name),
      mask: account.mask.toLowerCase(),
      type,
      subtype,
      accountKind,
      persistentAccountId: typeof account.persistentAccountId === "string" && account.persistentAccountId
        ? account.persistentAccountId
        : null,
    };
  });
  const reattach = [];
  const removedLedgerCounts = new Map();
  for (const item of relevant) {
    const saved = (await env.DB.prepare(
      `SELECT external_ref AS provider_account_id,mask,label,account_kind,source_locator,
              account_slug,entity_slug,'ledger' AS source_kind
         FROM fin_accounts
        WHERE tenant_id=? AND source_feed=? AND superseded_by_id IS NULL
       UNION ALL
       SELECT s.provider_account_id,s.mask,s.name AS label,s.account_kind,NULL AS source_locator,
              NULL AS account_slug,NULL AS entity_slug,'staged' AS source_kind
         FROM plaid_sync_stage_accounts s
        JOIN plaid_sync_windows w ON w.tenant_id=s.tenant_id AND w.window_ref=s.window_ref
        WHERE s.tenant_id=? AND w.item_ref=? LIMIT 501`,
    ).bind(tenantId, `bank-feed:${item.item_ref}`, tenantId, item.item_ref).all())?.results;
    if (!Array.isArray(saved) || saved.length > 500) review();
    const removed = item.removed_at !== null || item.status === "removed";
    // An active Item with no readable inventory is still ambiguous. A removed
    // Item with no ledger rows has no saved money to double count and must not
    // strand a later connection because an older build left an empty shell.
    if (saved.length === 0) {
      if (!removed) review();
      continue;
    }
    for (const prior of saved) {
      if (typeof prior.mask !== "string" || !/^[A-Za-z0-9*]{2,4}$/.test(prior.mask)) review();
    }
    if (!removed && saved.some((prior) => incoming.some((account) =>
      account.id === prior.provider_account_id || account.mask === prior.mask.toLowerCase()))) review();
    if (!removed) continue;
    if (item.environment !== environment) review();

    const ledger = saved.filter((prior) => prior.source_kind === "ledger");
    removedLedgerCounts.set(item.item_ref, new Set(ledger.map((prior) => prior.account_slug)).size);
    // Defect cleanup removes abandoned staging at disconnect. Ignore a stale
    // stage-only row from an older build because no ledger history exists to
    // reattach or double count.
    for (const account of incoming) {
      const exact = ledger.filter((prior) => prior.provider_account_id === account.id);
      const masked = exact.length === 0
        ? ledger.filter((prior) => prior.mask.toLowerCase() === account.mask)
        : [];
      const matches = exact.length > 0 ? exact : masked;
      if (matches.length > 1) review();
      if (matches.length === 1) {
        const [prior] = matches;
        const identity = plaidIdentity(prior.source_locator);
        const legacyIdentityMissing = prior.source_locator === null;
        if (typeof prior.account_slug !== "string" || !prior.account_slug ||
            typeof prior.entity_slug !== "string" || !prior.entity_slug ||
            !account.type || !account.subtype || !account.accountKind ||
            normalizedText(prior.label) !== account.name ||
            normalizedText(prior.mask) !== account.mask ||
            normalizedText(prior.account_kind) !== account.accountKind) review();
        // Rows promoted before the identity locator existed may enter the
        // replacement staging flow, but the missing proof is carried forward
        // so reconciliation must hold every staged dollar for owner review.
        // A malformed non-null locator is corruption, not a legacy row.
        if (!legacyIdentityMissing && (!identity || identity.type !== account.type ||
            identity.subtype !== account.subtype ||
            (identity.persistentAccountId && account.persistentAccountId &&
              identity.persistentAccountId !== account.persistentAccountId))) review();
        reattach.push({
          priorItemRef: item.item_ref,
          priorProviderAccountId: prior.provider_account_id,
          providerAccountId: account.id,
          accountSlug: prior.account_slug,
          entitySlug: prior.entity_slug,
          priorIdentityLocator: legacyIdentityMissing ? null : prior.source_locator,
        });
      }
    }
  }
  if (reattach.length === 0) return { action: "create", accounts: [] };
  if (new Set(reattach.map((row) => row.priorItemRef)).size !== 1 ||
      new Set(reattach.map((row) => row.accountSlug)).size !== reattach.length ||
      new Set(reattach.map((row) => row.providerAccountId)).size !== reattach.length) review();
  if (removedLedgerCounts.get(reattach[0].priorItemRef) !== reattach.length) review();
  return {
    action: "reattach",
    priorItemRef: reattach[0].priorItemRef,
    accounts: reattach,
  };
}
