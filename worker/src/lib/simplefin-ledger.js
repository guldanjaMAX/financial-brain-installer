// Listing receipts prove publication, not bank-history completeness. Keep islands
// separate: MIN/MAX of unrelated pulls would certify gaps in the history.
import { SIMPLEFIN_POSTED_HISTORY_REVISION } from './bank-feed-profiles.js';

export const simpleFinReviewTransactionsSql = (from, to) => `SELECT json_group_array(json_array(id,txn_uid,posted_on,amount_minor,direction,
  raw_amount_minor,currency,description,payee,pending,basis_state,removed_at,superseded_by_id))
  FROM (SELECT * FROM fin_transactions t WHERE t.tenant_id=a.tenant_id AND t.account_slug=a.account_slug
    AND (t.posted_on BETWEEN ${from} AND ${to} OR t.posted_on IS NULL) ORDER BY id LIMIT 10001)`;

export function simpleFinCoverageStatements(env, { tenantId, itemRef, window, accounts, stamp }) {
  return accounts.map(account =>
    env.DB.prepare(`INSERT INTO simplefin_account_windows
      (tenant_id,item_ref,account_ref,window_start,window_end,revision,complete,recorded_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,item_ref,account_ref,window_start,window_end) DO UPDATE SET
        revision=excluded.revision,complete=excluded.complete,recorded_at=excluded.recorded_at`)
      .bind(tenantId,itemRef,account.account_ref,window.window_start,window.window_end,window.revision,
        account.complete ? 1 : 0,stamp));
}

export function simpleFinCoverageSummaryStatement(env,{tenantId,itemRef,account,stamp}) {
  return env.DB.prepare(`WITH verified AS (
      SELECT r.window_start,r.window_end FROM simplefin_account_windows r
      JOIN simplefin_sync_windows w ON w.tenant_id=r.tenant_id AND w.item_ref=r.item_ref
        AND w.window_start=r.window_start AND w.window_end=r.window_end
        AND w.revision=r.revision AND w.staging_revision=w.revision AND w.state='promoted'
      WHERE r.tenant_id=?1 AND r.item_ref=?2 AND r.account_ref=?3 AND r.complete=1
        AND w.errlist_json='[]'
        AND substr(w.revision,1,${SIMPLEFIN_POSTED_HISTORY_REVISION.length})='${SIMPLEFIN_POSTED_HISTORY_REVISION}'
        AND NOT EXISTS (SELECT 1 FROM simplefin_account_windows bad
          WHERE bad.tenant_id=r.tenant_id AND bad.item_ref=r.item_ref AND bad.account_ref=r.account_ref
            AND bad.complete=0 AND bad.recorded_at>=r.recorded_at
            AND bad.window_start<=r.window_end AND bad.window_end>=r.window_start)
    ), prior AS (
      SELECT *,MAX(window_end) OVER (ORDER BY window_start,window_end
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_end FROM verified
    ), islands AS (
      SELECT *,SUM(CASE WHEN prior_end IS NULL OR window_start>date(prior_end,'+1 day') THEN 1 ELSE 0 END)
        OVER (ORDER BY window_start,window_end) AS island FROM prior
    ), latest AS (
      SELECT MIN(window_start) AS start,MAX(window_end) AS end FROM islands GROUP BY island
      ORDER BY end DESC LIMIT 1
    ), certified AS (
      SELECT r.covered_from AS start,r.covered_to AS end FROM simplefin_coverage_reviews r
      JOIN fin_accounts a ON a.tenant_id=r.tenant_id AND a.external_ref=r.account_ref AND a.superseded_by_id IS NULL
      JOIN latest l ON r.covered_from>=l.start AND r.covered_to<=l.end
      WHERE r.tenant_id=?1 AND r.account_ref=?3 AND r.revoked_at IS NULL
        AND r.identity_json=json_array(a.id,a.account_slug,a.entity_slug,a.currency,a.external_ref,a.source_feed,a.institution)
        AND r.transactions_json=(${simpleFinReviewTransactionsSql('r.covered_from','r.covered_to')})
        AND NOT EXISTS(SELECT 1 FROM simplefin_transaction_lineage pending
          WHERE pending.tenant_id=r.tenant_id AND pending.account_ref=r.account_ref
            AND pending.revoked_at IS NULL AND pending.reviewed_at IS NULL)
      ORDER BY r.covered_to DESC,r.reviewed_at DESC LIMIT 1
    ) UPDATE fin_account_coverage SET
      coverage_status=CASE WHEN EXISTS(SELECT 1 FROM certified) THEN 'complete' ELSE 'partial' END,
      covered_from=(SELECT start FROM certified),covered_to=COALESCE((SELECT end FROM certified),covered_to),
      basis_note=CASE WHEN EXISTS(SELECT 1 FROM certified)
        THEN 'Owner compared the bank history with these exact ledger rows for this bounded interval; SimpleFIN listings alone do not establish completeness.'
        ELSE 'SimpleFIN supplies a subset. Compare the bank history and approve a bounded coverage review before totals or absence answers.' END,
      computed_at=?5,recorded_at=?5
      WHERE tenant_id=?1 AND account_slug=?4 AND source_feed=('bank-feed:'||?2)
        AND superseded_by_id IS NULL`)
      .bind(tenantId,itemRef,account.account_ref,account.account_slug,stamp);
}

// Explicit maintenance for pre-connection identities. No name-based adoption or
// bulk rekey: bind one exact legacy reference before replaying retained stages.
export async function bindLegacySimpleFinAccount(env, { tenantId = env.BANK_FEED_TENANT || 'primary',
  accountRef, connectionId, dryRun = true, approve, now = new Date().toISOString() } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenantId) || !/^sfa_[a-f0-9]{32}$/.test(accountRef || '') ||
      typeof connectionId !== 'string' || connectionId.length > 512 || typeof dryRun !== 'boolean' ||
      !Number.isFinite(Date.parse(now))) throw Error('Invalid legacy account binding scope');
  const snapshotSql = `SELECT json_object('item_ref',a.item_ref,'provider_account_id',a.provider_account_id,
    'source_account_id',a.source_account_id,'connection_id',a.connection_id,'entity_slug',a.entity_slug,
    'conflict',EXISTS(SELECT 1 FROM simplefin_account_assignments b WHERE b.tenant_id=a.tenant_id
      AND b.item_ref=a.item_ref AND b.connection_id=?3 AND b.source_account_id=a.source_account_id
      AND b.account_ref<>a.account_ref)) AS snapshot
    FROM simplefin_account_assignments a WHERE a.tenant_id=?1 AND a.account_ref=?2`;
  const record = await env.DB.prepare(snapshotSql).bind(tenantId,accountRef,connectionId).first();
  if (!record?.snapshot) throw Error('Legacy account reference not found');
  const a = JSON.parse(record.snapshot);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(
    JSON.stringify(['simplefin-legacy-binding-v1',tenantId,accountRef,connectionId,record.snapshot]))))]
    .map(n => n.toString(16).padStart(2,'0')).join('');
  const blocked = Boolean(a.conflict || !a.source_account_id || a.connection_id !== null && a.connection_id !== connectionId);
  const receipt = { dry_run: dryRun, blocked, complete: !blocked && a.connection_id === connectionId,
    plan_hash: hash, account_ref: accountRef, mutation_count: 0 };
  if (dryRun) return receipt;
  const prior = await env.DB.prepare(`SELECT plan_hash FROM simplefin_account_identity_bindings
    WHERE tenant_id=? AND account_ref=? AND connection_id=?`).bind(tenantId,accountRef,connectionId).first();
  if (blocked || !/^[a-f0-9]{64}$/.test(approve || '') || approve !== hash && !(receipt.complete && approve === prior?.plan_hash))
    throw Error('Legacy account binding needs a fresh unblocked preview and exact owner approval');
  if (receipt.complete) return receipt;
  const subquery = snapshotSql.replace(' AS snapshot','');
  const result = await env.DB.batch([
    env.DB.prepare(`SELECT CASE WHEN (${subquery})=?4 THEN 1
      ELSE json_extract('simplefin binding snapshot changed','$') END AS verified`)
      .bind(tenantId,accountRef,connectionId,record.snapshot),
    env.DB.prepare(`UPDATE simplefin_account_assignments SET connection_id=?
      WHERE tenant_id=? AND account_ref=? AND connection_id IS NULL`).bind(connectionId,tenantId,accountRef),
    env.DB.prepare(`INSERT INTO simplefin_account_identity_bindings(tenant_id,account_ref,connection_id,plan_hash,bound_at)
      VALUES (?,?,?,?,?)`).bind(tenantId,accountRef,connectionId,hash,new Date(now).toISOString()),
    env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM simplefin_account_assignments
      WHERE tenant_id=? AND account_ref=? AND connection_id=? AND provider_account_id=? AND source_account_id=?)
      THEN 1 ELSE json_extract('simplefin binding readback failed','$') END AS verified`)
      .bind(tenantId,accountRef,connectionId,a.provider_account_id,a.source_account_id),
  ]);
  if (result.at(-1)?.results?.[0]?.verified !== 1) throw Error('SimpleFIN binding readback unavailable');
  return { ...receipt, complete: true, mutation_count: 1 };
}
