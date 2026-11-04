import { bankActivityInvalidationStatements } from './fin-account-links.js';

export const REVIEWED_ACCOUNT_KINDS = Object.freeze(['checking','savings','card','loan','line_of_credit','other']);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
export const validAccountKindSelector = value => typeof value === 'string' &&
  (SLUG.test(value) || /^id:[1-9][0-9]{0,14}$/.test(value));
export function reviewedAccountRole(kind, role) {
  if (!REVIEWED_ACCOUNT_KINDS.includes(kind)) throw Error('Invalid reviewed account kind.');
  const expected = ['checking','savings'].includes(kind) ? 'asset' : kind === 'other' ? null : 'liability';
  if ((role !== undefined && !['asset','liability'].includes(role)) || (expected && role !== undefined && role !== expected) ||
      (!expected && role === undefined)) throw Error('Choose a compatible asset or liability role.');
  return expected || role;
}

// Kind, role, labels and observation times can change on replay. None identifies
// an account. Provider reference, source, tenant, entity and durable row identity do.
export const accountKindIdentity = a => JSON.stringify([a.tenant_id,a.id,a.account_slug,a.entity_slug,
  a.mask,a.currency,a.feed_mode,a.external_ref,a.source_feed,a.institution]);
const identitySql = a => `json_array(${a}.tenant_id,${a}.id,${a}.account_slug,${a}.entity_slug,
  ${a}.mask,${a}.currency,${a}.feed_mode,${a}.external_ref,${a}.source_feed,${a}.institution)`;
export const effectiveAccountKindSql = a => `COALESCE((SELECT r.kind FROM fin_account_kind_reviews r
  WHERE r.tenant_id=${a}.tenant_id AND r.account_id=${a}.id AND r.revoked_at IS NULL
    AND r.identity_json=${identitySql(a)}),${a}.account_kind,'')`;
export const accountKindReviewSql = a => `(SELECT json_object('id',r.id,'kind',r.kind,'role',r.role,
  'reviewer',r.reviewer,'source',r.source,'reviewed_at',r.reviewed_at,'revoked_at',r.revoked_at,
  'identity_json',r.identity_json,'identity_matches',r.identity_json=${identitySql(a)})
  FROM fin_account_kind_reviews r WHERE r.tenant_id=${a}.tenant_id AND r.account_id=${a}.id
  ORDER BY r.id DESC LIMIT 1)`;
export function accountKindReview(row) {
  const review = row.account_kind_review_json ? JSON.parse(row.account_kind_review_json) : null;
  return review ? { ...review, state: review.revoked_at !== null ? 'revoked' : review.identity_matches === 1 ? 'current' : 'stale' } : null;
}
export function applyAccountKindReview(row) {
  const review = accountKindReview(row);
  return { ...row, provider_account_kind: row.account_kind, provider_balance_role: row.balance_role,
    account_kind_review: review, account_kind: review?.state === 'current' ? review.kind : row.account_kind,
    balance_role: review?.state === 'current' ? review.role : row.balance_role,
    // Keep the saved review visible without certifying its conflicting type.
    // Provider observation changes do not revoke or replace owner history.
    account_kind_balance_conflict: review?.state === 'current' && row.balance_role === 'liability' &&
      ['checking','savings'].includes(review.kind) };
}

const accountInventorySql = selection => `SELECT json_group_array(json_object('tenant_id',a.tenant_id,'id',a.id,
  'account_slug',a.account_slug,'entity_slug',a.entity_slug,'mask',a.mask,'institution',a.institution,
  'account_kind',a.account_kind,'balance_role',a.balance_role,'currency',a.currency,
  'feed_mode',a.feed_mode,'external_ref',a.external_ref,'source_feed',a.source_feed,'basis_state',a.basis_state,
  'status',a.status,'closed_on',a.closed_on,'superseded_by_id',a.superseded_by_id,
  'owned',EXISTS(SELECT 1 FROM fin_entities e WHERE e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
    AND e.superseded_by_id IS NULL AND e.relationship='owned' AND e.basis_state='confirmed')))
  FROM (SELECT * FROM fin_accounts WHERE ${selection} ORDER BY id LIMIT 3) a`;
const REVIEWS = `SELECT json_group_array(json_object('id',id,'account_id',account_id,'identity_json',identity_json,
  'kind',kind,'role',role,'reviewer',reviewer,'source',source,'reviewed_at',reviewed_at,
  'review_plan_hash',review_plan_hash,'revoked_at',revoked_at,'revoke_plan_hash',revoke_plan_hash))
  FROM (SELECT * FROM fin_account_kind_reviews WHERE tenant_id=?1 AND account_id=?3 ORDER BY id DESC LIMIT 1)`;
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value)))).map(n => n.toString(16).padStart(2,'0')).join('');

export async function maintainAccountKind(env, { tenantId = env.BANK_FEED_TENANT || 'primary',
  selector, kind, role, revoke = false, dryRun = true, approve,
  now = new Date(Date.now()).toISOString() } = {}) {
  if (!SLUG.test(tenantId) || !validAccountKindSelector(selector) || typeof revoke !== 'boolean' ||
      typeof dryRun !== 'boolean' || typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw Error('Invalid account review scope.');
  now = new Date(now).toISOString();
  if (revoke && (kind !== undefined || role !== undefined)) throw Error('Revoke does not accept a kind or role.');
  const desiredRole = revoke ? null : reviewedAccountRole(kind, role);
  if (!dryRun && !HASH.test(approve || '')) throw Error('Exact owner approval is required; preview first.');
  const exactId = selector.startsWith('id:');
  // Cleanup may select a retired durable row only by exact id. Slugs and masks
  // still describe current accounts; creation must never revive a retired row.
  // Direct id lookup also avoids scanning a large tenant's account inventory.
  const includeRetired = revoke && exactId;
  const selection = `tenant_id=?1 AND ${exactId ? 'id=CAST(substr(?2,4) AS INTEGER)' : '(account_slug=?2 OR mask=?2)'}
    ${includeRetired ? '' : 'AND superseded_by_id IS NULL'}`;
  const accountsSql = accountInventorySql(selection);
  // Account candidates and their latest review are read in one SQL snapshot.
  const snapshotSql = `SELECT (${accountsSql}) AS accounts,(${REVIEWS.replaceAll('?3',
    `(SELECT id FROM fin_accounts WHERE ${selection} ORDER BY id LIMIT 1)`)}) AS reviews`;
  const snapshot = await env.DB.prepare(snapshotSql).bind(tenantId, selector).first();
  if (typeof snapshot?.accounts !== 'string' || typeof snapshot?.reviews !== 'string') throw Error('Account review inventory unavailable.');
  const accounts = JSON.parse(snapshot.accounts), reviews = JSON.parse(snapshot.reviews);
  const account = accounts[0], last = reviews[0], active = last?.revoked_at === null ? last : null;
  const identity = account ? accountKindIdentity(account) : null;
  // A type review cannot change an observed amount owed into money held.
  // Balance interpretation needs separate evidence, including for saved reviews.
  const balanceConflict = !revoke && account?.balance_role === 'liability' && ['checking','savings'].includes(kind);
  const blocked = balanceConflict || accounts.length !== 1 || (!revoke && (account.owned !== 1 || account.basis_state !== 'confirmed' ||
    Boolean(active && active.identity_json !== identity)));
  const desired = revoke ? !active : !!active && active.identity_json === identity && active.kind === kind && active.role === desiredRole;
  const planHash = await digest(JSON.stringify(['account-kind-v1',tenantId,selector,revoke,kind ?? null,
    desiredRole,snapshot.accounts,snapshot.reviews]));
  const receipt = { dry_run: dryRun, action: revoke ? 'revoke' : 'review', selector,
    kind: revoke ? null : kind, role: desiredRole, blocked, complete: !blocked && desired,
    mutation_count: 0, plan_hash: planHash,
    balance_conflict: balanceConflict ? 'provider_liability_deposit_review' : null,
    accounts: accounts.map(a => ({ account_id: a.id, account_slug: a.account_slug,
      status: a.status, closed_on: a.closed_on, superseded_by_id: a.superseded_by_id,
      mask: a.mask, institution: a.institution, provider_kind: a.account_kind, provider_role: a.balance_role })),
    review: last ? { kind: last.kind, role: last.role, reviewer: last.reviewer, source: last.source,
      reviewed_at: last.reviewed_at, revoked_at: last.revoked_at,
      state: last.revoked_at !== null ? 'revoked' : last.identity_json === identity ? 'current' : 'stale' } : null };
  if (dryRun) return receipt;
  const replay = desired && last && approve === (revoke ? last.revoke_plan_hash : last.review_plan_hash);
  if (!replay && approve !== planHash) throw Error('Account review approval is stale; preview again.');
  if (blocked) throw Error('Account review is blocked. Select one exact owned account; revoke any stale review first.');
  const binds = [tenantId,selector,account.id];
  const statements = [env.DB.prepare(`SELECT CASE WHEN (${accountsSql})=?4 AND (${REVIEWS})=?5
    THEN 1 ELSE json_extract('account review snapshot changed','$') END AS verified`)
    .bind(...binds,snapshot.accounts,snapshot.reviews)];
  if (!desired) {
    // Replacement closes the previous review in the same transaction as the
    // new fact. No active review is ever overwritten by an importer.
    if (active) statements.push(env.DB.prepare(`UPDATE fin_account_kind_reviews SET revoked_at=?3,revoke_plan_hash=?4
      WHERE tenant_id=?1 AND account_id=?2 AND revoked_at IS NULL`).bind(tenantId,account.id,now,planHash));
    if (!revoke) statements.push(env.DB.prepare(`INSERT INTO fin_account_kind_reviews
      (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
      VALUES (?,?,?,?,?,'owner','owner_account_kind',?,?)`).bind(tenantId,account.id,identity,kind,desiredRole,now,planHash));
    statements.push(...bankActivityInvalidationStatements(env,{ at: now }));
  }
  const hash = desired ? (revoke ? last?.revoke_plan_hash : last.review_plan_hash) : planHash;
  const proof = revoke ? `NOT EXISTS(SELECT 1 FROM fin_account_kind_reviews WHERE tenant_id=?1 AND account_id=?2 AND revoked_at IS NULL)
    AND (?3 IS NULL OR EXISTS(SELECT 1 FROM fin_account_kind_reviews WHERE tenant_id=?1 AND account_id=?2
      AND revoke_plan_hash=?3 AND id=?4 AND revoked_at=?5))`
    : `EXISTS(SELECT 1 FROM fin_account_kind_reviews WHERE tenant_id=?1 AND account_id=?2 AND revoked_at IS NULL
      AND review_plan_hash=?3 AND identity_json=?4 AND kind=?5 AND role=?6 AND reviewer='owner' AND source='owner_account_kind'
      AND reviewed_at=?7)`;
  statements.push(env.DB.prepare(`SELECT CASE WHEN ${proof} THEN 1 ELSE json_extract('account review readback failed','$') END AS verified`)
    .bind(tenantId,account.id,hash ?? null,...(revoke ? [last?.id ?? null,desired ? last?.revoked_at ?? null : now]
      : [identity,kind,desiredRole,desired ? last.reviewed_at : now])));
  const result = await env.DB.batch(statements);
  if (result.at(-1)?.results?.[0]?.verified !== 1) throw Error('Account review readback unavailable.');
  return { ...receipt, complete: true, mutation_count: desired ? 0 : 1,
    review: revoke ? (last ? { ...receipt.review, state: 'revoked', revoked_at: desired ? last.revoked_at : now } : null)
      : { kind, role: desiredRole, reviewer: 'owner', source: 'owner_account_kind',
        reviewed_at: desired ? last.reviewed_at : now, revoked_at: null, state: 'current' } };
}
