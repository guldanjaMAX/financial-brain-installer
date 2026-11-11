import { simpleFinCoverageSummaryStatement, simpleFinReviewTransactionsSql } from './simplefin-ledger.js';
import { SIMPLEFIN_POSTED_HISTORY_REVISION } from './bank-feed-profiles.js';

const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))]
  .map(n => n.toString(16).padStart(2,'0')).join('');
const snapshotSql = `SELECT json_object('identity',json_array(a.id,a.account_slug,a.entity_slug,a.currency,a.external_ref,a.source_feed,a.institution),
  'item_ref',s.item_ref,'account_slug',a.account_slug,
  'transactions',json((${simpleFinReviewTransactionsSql('?3','?4')})),
  'windows',json((SELECT json_group_array(json_array(r.window_start,r.window_end,r.revision,r.complete,w.revision,w.staging_revision,w.state,w.errlist_json))
    FROM simplefin_account_windows r JOIN simplefin_sync_windows w ON w.tenant_id=r.tenant_id AND w.item_ref=r.item_ref
      AND w.window_start=r.window_start AND w.window_end=r.window_end
    WHERE r.tenant_id=a.tenant_id AND r.account_ref=a.external_ref
      AND r.window_start<=?4 AND r.window_end>=?3)),
  'pending_identity',EXISTS(SELECT 1 FROM simplefin_transaction_lineage l WHERE l.tenant_id=a.tenant_id
    AND l.account_ref=a.external_ref AND l.revoked_at IS NULL AND l.reviewed_at IS NULL),
  'owned',EXISTS(SELECT 1 FROM fin_entities e WHERE e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
    AND e.superseded_by_id IS NULL AND e.relationship='owned' AND e.basis_state='confirmed')) AS snapshot
  FROM fin_accounts a JOIN simplefin_account_assignments s ON s.tenant_id=a.tenant_id AND s.account_ref=a.external_ref
  WHERE a.tenant_id=?1 AND a.external_ref=?2 AND a.superseded_by_id IS NULL AND a.basis_state='confirmed'
    AND a.source_feed=('bank-feed:'||s.item_ref) AND s.connection_id IS NOT NULL`;

// The owner compares their bank's record, not merely another SimpleFIN page.
// Preview hashes the exact rows and source revisions; a stale approval refuses.
export async function maintainSimpleFinCoverage(env, { tenantId = env.BANK_FEED_TENANT || 'primary',
  accountRef, from, to, dryRun = true, approve, confirmSourceComparison = false,
  now = new Date().toISOString() } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenantId) || !/^sfa_[a-f0-9]{32}$/.test(accountRef || '') ||
      !validDay(from) || !validDay(to) || from>to || typeof dryRun !== 'boolean' ||
      !Number.isFinite(Date.parse(now))) throw Error('Invalid SimpleFIN coverage review scope');
  const record = await env.DB.prepare(snapshotSql).bind(tenantId,accountRef,from,to).first();
  if (!record?.snapshot) throw Error('SimpleFIN coverage account unavailable');
  const snapshot = JSON.parse(record.snapshot);
  const windows = snapshot.windows.filter(w => w[3] === 1 && w[2] === w[4] && w[4] === w[5] && w[6] === 'promoted' &&
    w[7] === '[]' && w[4].startsWith(SIMPLEFIN_POSTED_HISTORY_REVISION))
    .sort((a,b) => a[0].localeCompare(b[0]));
  let through = null;
  for (const w of windows) {
    if (through === null && w[0]<=from && w[1]>=from) through=w[1];
    else if (through && w[0]<=new Date(Date.parse(through)+86400000).toISOString().slice(0,10) && w[1]>through) through=w[1];
  }
  const unread = snapshot.transactions.some(t => t[10] !== 'confirmed' || t[2] === null || t[9] !== 0 || t[11] !== null);
  const blocked = !snapshot.owned || snapshot.pending_identity || !through || through<to || unread || snapshot.transactions.length>10000;
  const planHash = await digest(JSON.stringify(['simplefin-coverage-review-v1',tenantId,accountRef,from,to,record.snapshot]));
  const receipt = { dry_run: dryRun, blocked: Boolean(blocked), complete: false, plan_hash: planHash,
    from,to,account_ref:accountRef,transaction_count:snapshot.transactions.filter(t => t[12] === null).length,
    mutation_count:0, source_comparison_required:true };
  if (dryRun) return receipt;
  if (blocked || confirmSourceComparison !== true || approve !== planHash)
    throw Error('Compare the bank history for these dates, then approve the exact current coverage preview');
  const identity = JSON.stringify(snapshot.identity), stamp = new Date(now).toISOString();
  const statements = [
    env.DB.prepare(`SELECT CASE WHEN (${snapshotSql.replace(' AS snapshot','')})=?5 THEN 1
      ELSE json_extract('simplefin coverage review snapshot changed','$') END AS verified`)
      .bind(tenantId,accountRef,from,to,record.snapshot),
    env.DB.prepare(`INSERT INTO simplefin_coverage_reviews
      (tenant_id,account_ref,covered_from,covered_to,identity_json,transactions_json,plan_hash,reviewed_at,revoked_at)
      VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(tenant_id,account_ref,covered_from,covered_to) DO UPDATE SET
        identity_json=excluded.identity_json,transactions_json=excluded.transactions_json,
        plan_hash=excluded.plan_hash,reviewed_at=excluded.reviewed_at,revoked_at=NULL`)
      .bind(tenantId,accountRef,from,to,identity,JSON.stringify(snapshot.transactions),planHash,stamp),
  ];
  // Recompute from real receipts. The review does not fabricate an ingest window.
  // Only the summary UPDATE is needed; the receipt INSERT belongs to promotion.
  const summary = simpleFinCoverageSummaryStatement(env,{ tenantId,itemRef:snapshot.item_ref,stamp,
    account:{account_ref:accountRef,account_slug:snapshot.account_slug} });
  statements.push(summary,env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM fin_account_coverage
    WHERE tenant_id=? AND account_slug=? AND coverage_status='complete' AND covered_from<=? AND covered_to>=?
      AND superseded_by_id IS NULL) THEN 1 ELSE json_extract('simplefin coverage readback failed','$') END AS verified`)
    .bind(tenantId,snapshot.account_slug,from,to));
  const result = await env.DB.batch(statements);
  if (result.at(-1)?.results?.[0]?.verified !== 1) throw Error('SimpleFIN coverage readback unavailable');
  return { ...receipt,complete:true,mutation_count:1 };
}
