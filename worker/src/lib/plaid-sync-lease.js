/** D1-fenced custody for one Plaid Item's complete sync window. */
export const PLAID_SYNC_LEASE_SECONDS = 120;
export const PLAID_SYNC_HARD_DEADLINE_SECONDS = 10 * 60;

export class PlaidSyncLeaseError extends Error {
  constructor(code = "PLAID_SYNC_LEASE_LOST") {
    super(code === "PLAID_SYNC_LEASE_LOST"
      ? "This bank refresh no longer owns its work. Its earlier progress is safe."
      : code === "PLAID_SYNC_PAUSED"
        ? "Bank refreshes are paused for the verified update. Earlier progress is safe."
        : code === "PLAID_SYNC_DEADLINE"
          ? "This bank refresh reached its safe time limit. The next refresh can resume its progress."
          : "The bank refresh could not verify exclusive ownership. Its earlier progress is safe.");
    this.name = "PlaidSyncLeaseError";
    this.code = code;
  }
}

const ACTIVE_ITEM = `EXISTS (
  SELECT 1 FROM bank_feed_items i
   WHERE i.tenant_id=plaid_sync_leases.tenant_id AND i.item_ref=plaid_sync_leases.item_ref
     AND i.removed_at IS NULL AND i.status IN ('connected','error')
     AND NOT EXISTS (SELECT 1 FROM plaid_revocation_outbox r
       WHERE r.tenant_id=i.tenant_id AND r.item_ref=i.item_ref)
)`;

function requireActiveMode(env) {
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") throw new PlaidSyncLeaseError("PLAID_SYNC_PAUSED");
}

function identity(lease) {
  if (!lease || typeof lease.tenantId !== "string" || !lease.tenantId ||
      typeof lease.itemRef !== "string" || !lease.itemRef ||
      typeof lease.ownerToken !== "string" || !lease.ownerToken) throw new PlaidSyncLeaseError();
  return [lease.tenantId, lease.itemRef, lease.ownerToken];
}

export async function ownsPlaidSyncLease(env, lease) {
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS owned FROM plaid_sync_leases
      WHERE tenant_id=? AND item_ref=? AND owner_token=? AND expires_at>unixepoch('now') AND hard_deadline_at>unixepoch('now') AND ${ACTIVE_ITEM}`,
  ).bind(...identity(lease)).first();
  return row?.owned === 1;
}

export async function claimPlaidSyncLease(env, { tenantId, itemRef, hardDeadlineAt = null } = {}) {
  requireActiveMode(env);
  if (hardDeadlineAt !== null && (!Number.isSafeInteger(hardDeadlineAt) || hardDeadlineAt < 1)) {
    throw new PlaidSyncLeaseError("PLAID_SYNC_LEASE_UNAVAILABLE");
  }
  const lease = Object.freeze({ tenantId, itemRef, ownerToken: crypto.randomUUID() });
  identity(lease);
  // The predicate and readback share one transaction. A busy Item creates no
  // second window and consumes no provider credential or call.
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO plaid_sync_leases (tenant_id,item_ref,owner_token,expires_at,hard_deadline_at)
       SELECT ?,?,?,MIN(unixepoch('now')+?,COALESCE(?,unixepoch('now')+?)),
         MIN(unixepoch('now')+?,COALESCE(?,unixepoch('now')+?))
       WHERE (? IS NULL OR unixepoch('now')<?) AND EXISTS (
         SELECT 1 FROM bank_feed_items i WHERE i.tenant_id=? AND i.item_ref=?
          AND i.removed_at IS NULL AND i.status IN ('connected','error')
          AND NOT EXISTS (SELECT 1 FROM plaid_revocation_outbox r
            WHERE r.tenant_id=i.tenant_id AND r.item_ref=i.item_ref)
       )
       ON CONFLICT(tenant_id,item_ref) DO UPDATE SET
         owner_token=excluded.owner_token,expires_at=excluded.expires_at,
         hard_deadline_at=excluded.hard_deadline_at
       WHERE plaid_sync_leases.expires_at<=unixepoch('now')`,
    ).bind(...identity(lease),
      PLAID_SYNC_LEASE_SECONDS, hardDeadlineAt, PLAID_SYNC_LEASE_SECONDS,
      PLAID_SYNC_HARD_DEADLINE_SECONDS, hardDeadlineAt, PLAID_SYNC_HARD_DEADLINE_SECONDS,
      hardDeadlineAt, hardDeadlineAt, tenantId, itemRef),
    env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM plaid_sync_leases
        WHERE tenant_id=? AND item_ref=? AND owner_token=? AND expires_at>unixepoch('now')
          AND hard_deadline_at>unixepoch('now') AND ${ACTIVE_ITEM}) AS owned,
        COALESCE(unixepoch('now')>=?,0) AS deadline_elapsed`,
    ).bind(...identity(lease), hardDeadlineAt),
  ]);
  const receipt = result?.[1]?.results?.[0];
  if (receipt?.deadline_elapsed === 1) throw new PlaidSyncLeaseError("PLAID_SYNC_DEADLINE");
  return receipt?.owned === 1 ? lease : null;
}

// The immutable hard deadline bounds the whole invocation, not just a single
// provider request. Late work remains staged and a new invocation can resume.
export async function runPlaidSyncBatch(env, lease, statements = []) {
  requireActiveMode(env);
  const params = identity(lease);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE plaid_sync_leases SET expires_at=MIN(unixepoch('now')+?,hard_deadline_at)
          WHERE tenant_id=? AND item_ref=? AND owner_token=? AND expires_at>unixepoch('now') AND hard_deadline_at>unixepoch('now') AND ${ACTIVE_ITEM}`,
      ).bind(PLAID_SYNC_LEASE_SECONDS, ...params),
      env.DB.prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM plaid_sync_leases
            WHERE tenant_id=? AND item_ref=? AND owner_token=? AND expires_at>unixepoch('now') AND hard_deadline_at>unixepoch('now') AND ${ACTIVE_ITEM}
         ) THEN 1 ELSE json_extract('plaid sync ownership lost','$') END AS plaid_sync_custody_guard`,
      ).bind(...params),
      ...statements,
    ]);
    return results.slice(2);
  } catch (error) {
    // A read distinguishes an ownership refusal from a still-owned SQL failure.
    // Either failure remains closed; never write an error receipt under a stale
    // owner after a failed batch or an unavailable ownership check.
    let owned;
    try { owned = await ownsPlaidSyncLease(env, lease); }
    catch { throw new PlaidSyncLeaseError("PLAID_SYNC_LEASE_UNAVAILABLE"); }
    if (!owned) throw new PlaidSyncLeaseError();
    throw error;
  }
}

export async function renewPlaidSyncLease(env, lease) {
  await runPlaidSyncBatch(env, lease);
}

export async function releasePlaidSyncLease(env, lease) {
  // Cleanup is scoped to the exact owner, including after expiry/takeover.
  // An interrupted cleanup leaves only the bounded lease, never an open writer.
  await env.DB.prepare(
    "DELETE FROM plaid_sync_leases WHERE tenant_id=? AND item_ref=? AND owner_token=?",
  ).bind(...identity(lease)).run();
}
