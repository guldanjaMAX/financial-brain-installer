const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

// These stored identities must still agree at every read. A provider reassignment
// or replacement account cannot inherit an old approval through its slug.
export const accountLinkIdentity = a => [a.id, a.account_slug, a.entity_slug, a.mask,
  a.account_kind, a.institution, a.currency, a.balance_role, a.feed_mode, a.external_ref, a.source_feed];

const ACCOUNTS = `SELECT json_group_array(json_object(
  'id',a.id,'account_slug',a.account_slug,'entity_slug',a.entity_slug,'mask',a.mask,
  'account_kind',a.account_kind,'institution',a.institution,'currency',a.currency,
  'balance_role',a.balance_role,'feed_mode',a.feed_mode,'external_ref',a.external_ref,
  'source_feed',a.source_feed,'label',a.label,'basis_state',a.basis_state,
  'owned',EXISTS(SELECT 1 FROM fin_entities e WHERE e.tenant_id=a.tenant_id
    AND e.entity_slug=a.entity_slug AND e.superseded_by_id IS NULL
    AND e.relationship='owned' AND e.basis_state='confirmed')))
  FROM (SELECT * FROM fin_accounts WHERE tenant_id=?1 AND account_slug IN (?2,?3)
    AND superseded_by_id IS NULL ORDER BY account_slug) a`;
// The active endpoints plus the most recent exact pair suffice for conflict and
// replay checks. Historic approvals are retained but never scanned wholesale.
const LINKS = `SELECT json_group_array(json_object('id',id,'manual_account_slug',manual_account_slug,
  'live_account_slug',live_account_slug,'identity_json',identity_json,
  'link_plan_hash',link_plan_hash,'unlink_plan_hash',unlink_plan_hash,'unlinked_at',unlinked_at))
  FROM (SELECT * FROM fin_account_links WHERE tenant_id=?1 AND unlinked_at IS NULL AND manual_account_slug IN (?2,?3)
    UNION SELECT * FROM fin_account_links WHERE tenant_id=?1 AND unlinked_at IS NULL AND live_account_slug IN (?2,?3)
    UNION SELECT * FROM fin_account_links WHERE id=(SELECT id FROM fin_account_links
      WHERE tenant_id=?1 AND manual_account_slug=?2 AND live_account_slug=?3 ORDER BY id DESC LIMIT 1)
    ORDER BY id)`;
const SNAPSHOT = `SELECT (${ACCOUNTS}) AS accounts,(${LINKS}) AS links`;
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value)))).map(n => n.toString(16).padStart(2, '0')).join('');

/**
 * Couple every effective-account inventory mutation to its derived document
 * debt. The generation fences a writer that already read the old inventory;
 * the source row makes the incomplete replacement visible and retryable.
 */
export function bankActivityInvalidationPlan({ at }) {
  return [
    [
      `UPDATE bank_activity_refresh_state
          SET generation=generation+1,requested_at=?
        WHERE id=(SELECT CASE
          WHEN EXISTS (SELECT 1 FROM bank_activity_refresh_state WHERE id=1) THEN 1
          ELSE json_extract('bank activity refresh state unavailable','$') END)`,
      [at],
    ],
    [
      `UPDATE sources
          SET status='indexing',last_complete_sweep_at=NULL,sync_cursor=NULL,
              stale_reason='bank activity refresh pending'
        WHERE name='bank_activity' AND kind='bank_activity'`,
      [],
    ],
  ];
}

export function bankActivityInvalidationStatements(env, options) {
  return bankActivityInvalidationPlan(options)
    .map(([sql, binds]) => env.DB.prepare(sql).bind(...binds));
}

export async function maintainAccountLink(env, { tenantId = env.BANK_FEED_TENANT || 'primary',
  manualSlug, liveSlug, unlink = false, dryRun = true, approve = null, now = new Date(Date.now()).toISOString() } = {}) {
  if (![tenantId, manualSlug, liveSlug].every(s => typeof s === 'string' && SLUG.test(s)) ||
      manualSlug === liveSlug || typeof unlink !== 'boolean' || typeof dryRun !== 'boolean') throw new Error('Invalid account link scope.');
  if (!dryRun && !HASH.test(approve || '')) throw new Error('Exact owner approval is required; preview the account link first.');
  const binds = [tenantId, manualSlug, liveSlug];
  const snapshot = await env.DB.prepare(SNAPSHOT).bind(...binds).first();
  if (typeof snapshot?.accounts !== 'string' || typeof snapshot?.links !== 'string') throw new Error('Account link inventory unavailable.');
  const accounts = JSON.parse(snapshot.accounts), links = JSON.parse(snapshot.links);
  const manual = accounts.find(a => a.account_slug === manualSlug), live = accounts.find(a => a.account_slug === liveSlug);
  const last = links.filter(l => l.manual_account_slug === manualSlug && l.live_account_slug === liveSlug).at(-1);
  const active = last && last.unlinked_at === null ? last : null;
  const identity = manual && live ? JSON.stringify([accountLinkIdentity(manual), accountLinkIdentity(live)]) : null;
  const eligible = accounts.length === 2 && manual?.feed_mode === 'manual' && live?.feed_mode === 'live' &&
    accounts.every(a => a.owned === 1 && a.basis_state === 'confirmed') &&
    ['entity_slug', 'account_kind', 'currency', 'balance_role'].every(k => manual[k] === live[k]);
  const conflict = links.some(l => l.unlinked_at === null && l.id !== active?.id);
  // Unlink must remain possible after an account changes or is retired. A new
  // link requires eligible current accounts and no competing active approval.
  const blocked = !unlink && (!eligible || conflict || Boolean(active && active.identity_json !== identity));
  const desired = unlink ? !active : !!active && !blocked;
  const planHash = await digest(JSON.stringify(['account-link-v1', ...binds, unlink, snapshot.accounts, snapshot.links]));
  const receipt = { dry_run: dryRun, action: unlink ? 'unlink' : 'link', manual_account_slug: manualSlug,
    live_account_slug: liveSlug, accounts: accounts.map(a => ({ account_slug: a.account_slug,
      institution: a.institution, mask: a.mask, kind: a.account_kind, label: a.label, feed_mode: a.feed_mode })),
    blocked, complete: desired, mutation_count: 0, plan_hash: planHash };
  if (dryRun) return receipt;
  // A lost receipt can replay only the exact persisted approval in its still
  // current state. An old link hash cannot undo a later unlink or relink.
  const replay = desired && last && approve === (unlink ? last.unlink_plan_hash : last.link_plan_hash);
  if (!replay && approve !== planHash) throw new Error('Account link approval is stale; preview again.');
  if (blocked) throw new Error('Account link is blocked. Review ownership and any existing link; unlink an outdated approval first.');
  const guard = env.DB.prepare(`SELECT CASE WHEN (${ACCOUNTS})=?4 AND (${LINKS})=?5 THEN 1
    ELSE json_extract('account link snapshot changed','$') END AS verified`).bind(...binds, snapshot.accounts, snapshot.links);
  const statements = [guard];
  if (!desired) {
    statements.push(unlink
      ? env.DB.prepare(`UPDATE fin_account_links SET unlinked_at=?4,unlink_plan_hash=?5
          WHERE tenant_id=?1 AND manual_account_slug=?2 AND live_account_slug=?3 AND unlinked_at IS NULL`).bind(...binds, now, planHash)
      : env.DB.prepare(`INSERT INTO fin_account_links
          (tenant_id,manual_account_slug,live_account_slug,identity_json,link_plan_hash,linked_at)
          VALUES (?1,?2,?3,?4,?5,?6)`).bind(...binds, identity, planHash, now),
      ...bankActivityInvalidationStatements(env, { at: now }));
  }
  const expectedHash = unlink ? (desired ? last?.unlink_plan_hash : planHash) : (desired ? active.link_plan_hash : planHash);
  const proof = unlink
    ? `NOT EXISTS(SELECT 1 FROM fin_account_links WHERE tenant_id=?1 AND manual_account_slug=?2 AND live_account_slug=?3 AND unlinked_at IS NULL)
       AND (?4 IS NULL OR EXISTS(SELECT 1 FROM fin_account_links WHERE tenant_id=?1 AND manual_account_slug=?2 AND live_account_slug=?3 AND unlink_plan_hash=?4))`
    : `EXISTS(SELECT 1 FROM fin_account_links WHERE tenant_id=?1 AND manual_account_slug=?2 AND live_account_slug=?3
       AND unlinked_at IS NULL AND link_plan_hash=?4 AND identity_json=?5)`;
  statements.push(env.DB.prepare(`SELECT CASE WHEN ${proof} THEN 1 ELSE json_extract('account link readback failed','$') END AS verified`)
    .bind(...binds, expectedHash ?? null, ...(unlink ? [] : [identity])));
  const result = await env.DB.batch(statements);
  if (result.at(-1)?.results?.[0]?.verified !== 1) throw new Error('Account link readback unavailable.');
  return { ...receipt, complete: true, mutation_count: desired ? 0 : 1 };
}
