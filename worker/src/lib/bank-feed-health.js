import { DISCOVERED_LEDGER_REFERENCE_SQL, MONEY_FEED_ASSIGNMENTS_SQL } from './money-feed-assignment.js';
import { verifiedMoneySyncInstant } from './money-confidence.js';

// Operational freshness is independent of webhook delivery and document writes.
// Never copy provider payloads, credentials, or raw error text into this record.
export const BANK_SYNC_SECONDS = 86400;
export const BANK_OVERDUE_SECONDS = 172800;
export const BANK_PENDING_OVERDUE_SECONDS = 43200;

const LOGIN = new Set(['ITEM_LOGIN_REQUIRED','PENDING_EXPIRATION','USER_PERMISSION_REVOKED',
  'ITEM_NOT_FOUND','ACCESS_NOT_GRANTED','INVALID_ACCESS_TOKEN','simplefin_login_required']);
export const bankOwnerRecoveryRequired = code => LOGIN.has(code);
export function bankSyncError(code) {
  if(code==='BANK_ACCESS_REFERENCE_UNREADABLE') return {code,meaning:'Needs reconnect. Saved bank access cannot be opened; history is kept.',action:'Use Replace unreadable connection in Access > Banks.'};
  if (bankOwnerRecoveryRequired(code)) return {code, meaning:'Your bank needs you to sign in again.', action:'Sign in again to restore the bank connection.'};
  if (['RATE_LIMIT_EXCEEDED','simplefin_daily_request_limit'].includes(code)) return {code, meaning:'The bank provider request limit was reached.', action:'Wait for the next sync after the provider limit resets.'};
  if (code === 'BANK_SYNC_PARTIAL') return {code, meaning:'The bank returned incomplete activity; current coverage is not yet verified.', action:'Wait for the next sync; review the connection if the issue continues.'};
  return {code:'BANK_SYNC_FAILED', meaning:'The bank could not be read on the last attempt.', action:'Wait for the next sync; review the connection if the issue continues.'};
}

export function bankAttemptStatement(env, tenantId, itemRef, stamp) {
  return env.DB.prepare(`INSERT INTO bank_feed_health (tenant_id,item_ref,last_attempt_at) VALUES (?,?,?)
    ON CONFLICT(tenant_id,item_ref) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`)
    .bind(tenantId,itemRef,stamp);
}
export function bankSuccessStatement(env, tenantId, itemRef, stamp, through, proof) {
  return env.DB.prepare(`INSERT INTO bank_feed_health
    (tenant_id,item_ref,last_successful_sync_at,data_through) SELECT ?,?,?,? WHERE EXISTS (${proof.sql})
    ON CONFLICT(tenant_id,item_ref) DO UPDATE SET last_successful_sync_at=excluded.last_successful_sync_at,
      data_through=excluded.data_through,last_error_code=NULL,last_error_meaning=NULL`)
    .bind(tenantId,itemRef,stamp,through,...proof.binds);
}
export function bankErrorStatement(env, tenantId, itemRef, stamp, code) {
  const error=bankSyncError(code);
  return env.DB.prepare(`INSERT INTO bank_feed_health
    (tenant_id,item_ref,last_attempt_at,last_error_code,last_error_meaning) VALUES (?,?,?,?,?)
    ON CONFLICT(tenant_id,item_ref) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
      last_error_code=excluded.last_error_code,last_error_meaning=excluded.last_error_meaning`)
    .bind(tenantId,itemRef,stamp,error.code,error.meaning);
}

function bankHealthSql(includeRetained) {
  return `SELECT i.item_ref,i.status,i.connected_at,i.removed_at,h.item_ref AS health_item_ref,h.last_attempt_at,h.last_successful_sync_at,
    h.data_through,COALESCE(h.last_webhook_at,(SELECT MAX(w.received_at) FROM plaid_webhook_events w
      WHERE w.tenant_id=i.tenant_id AND w.item_ref=i.item_ref)) AS last_webhook_at,
    CASE WHEN r.last_error_code='BANK_ACCESS_REFERENCE_UNREADABLE' THEN r.last_error_code ELSE h.last_error_code END AS last_error_code,
    h.last_error_meaning,r.state AS reconciliation_state,
    COALESCE(c.next_pull_at,NULLIF(MAX(COALESCE(r.due_at,''),COALESCE(r.provider_retry_not_before,'')),'')) AS next_due_at,
    CASE WHEN c.item_ref IS NOT NULL THEN 'pending' ELSE r.state END AS pending_state
    FROM bank_feed_items i LEFT JOIN bank_feed_health h ON h.tenant_id=i.tenant_id AND h.item_ref=i.item_ref
    LEFT JOIN plaid_reconciliation r ON r.tenant_id=i.tenant_id AND r.item_ref=i.item_ref
    LEFT JOIN simplefin_connections c ON c.tenant_id=i.tenant_id AND c.item_ref=i.item_ref
    WHERE i.tenant_id=? AND (i.removed_at IS NULL${includeRetained ? ` OR EXISTS (
      SELECT 1 FROM fin_accounts a WHERE a.tenant_id=i.tenant_id AND a.superseded_by_id IS NULL
        AND a.source_feed='bank-feed:'||i.item_ref)` : ''}) ORDER BY i.item_ref`;
}

export async function bankHealthRows(env, {read=null,includeRetained=false}={}) {
  const tenantId=String(env.BANK_FEED_TENANT || 'primary');
  const sql=bankHealthSql(includeRetained);
  return read ? read(sql,[tenantId]) : (await env.DB.prepare(sql).bind(tenantId).all()).results;
}
export function bankConnectionHealth(row, now) {
  const stamp = new Date(now).getTime();
  const success = Date.parse(row.last_successful_sync_at || '');
  const start = Number.isFinite(success) ? success : Date.parse(row.connected_at || '');
  // An upgrade leaves legacy SimpleFIN health unobserved until a verified pull.
  // The connection's age alone cannot prove that its bank feed stopped syncing.
  const observed = row.health_item_ref != null || Number.isFinite(success) || Boolean(row.last_attempt_at || row.last_error_code);
  const successOverdue = observed && (!Number.isFinite(start) || stamp-start>BANK_OVERDUE_SECONDS*1000);
  const due=Date.parse(row.next_due_at || '');
  const pendingOverdue=observed && ['pending','retryable'].includes(row.pending_state || row.reconciliation_state) &&
    Number.isFinite(due) && stamp-due>BANK_PENDING_OVERDUE_SECONDS*1000;
  const overdue=successOverdue || pendingOverdue;
  const login = ['reauth_required','permission_revoked'].includes(row.status) || bankOwnerRecoveryRequired(row.last_error_code);
  const unreadable=row.last_error_code==='BANK_ACCESS_REFERENCE_UNREADABLE';
  const action=unreadable ? 'Use Replace unreadable connection in Access > Banks. Saved history is kept.' : login ? 'Sign in again, then use Repair connection in Access > Banks.' : 'Wait for the next sync; review the connection if the issue continues.';
  const state=unreadable ? 'needs_reconnect' : login ? 'login_required' : overdue ? 'overdue' : row.last_error_code ? 'error' : !row.last_successful_sync_at ? 'waiting' : 'healthy';
  const line=[unreadable ? 'Needs reconnect. Saved bank access cannot be opened; history is kept.' : login ? 'Your bank needs you to sign in again.' : successOverdue ? 'No successful bank sync for more than 48 hours.'
    : pendingOverdue ? `The bank sync due at ${row.next_due_at} is more than 12 hours late.`
    : row.last_error_meaning || (!row.last_successful_sync_at ? 'Waiting for the first complete bank sync.' : 'Bank connection is up to date.'),
    row.last_successful_sync_at ? `Last successful sync: ${row.last_successful_sync_at}.` : 'No successful sync recorded.',
    ...(state==='healthy' ? [] : [action])].join(' ');
  return {state,overdue,pending_overdue:pendingOverdue,needs_sign_in:!unreadable && login,needs_reconnect:unreadable,next_due_at:row.next_due_at||null,
    pending_state:row.pending_state||row.reconciliation_state||null,last_attempt_at:row.last_attempt_at||null,last_successful_sync_at:row.last_successful_sync_at||null,
    data_through:row.data_through||null,last_webhook_at:row.last_webhook_at||null,
    last_error_code:row.last_error_code||null,last_error_meaning:row.last_error_meaning||null,action,status_line:line};
}

export async function bankHealthMap(env, now) {
  return new Map((await bankHealthRows(env)).map(row=>[row.item_ref,bankConnectionHealth(row,now)]));
}

/** Recompute even when no provider call is due, including Items awaiting login. */
export async function reconcileBankFeedHealth(env, now) {
  if (env.VECTOR_DRAIN_MODE==='paused-for-upgrade') return;
  const tenantId=String(env.BANK_FEED_TENANT||'primary');
  const rows=await bankHealthRows(env);
  if (!rows.length) return;
  for (const row of rows) {
    const health=bankConnectionHealth(row,now);
    const uid=`bank-feed-health:${row.item_ref}`;
    if (health.overdue || ['needs_reconnect','login_required','error'].includes(health.state)) {
      await env.DB.prepare(`INSERT INTO fin_exceptions
        (tenant_id,exception_uid,kind,issue,detail,first_seen,waiting_on,provenance,source_feed,basis_state,recorded_at)
        VALUES (?,?,'other',?,?,?,?,'derived',?,'confirmed',?)
        ON CONFLICT(tenant_id,exception_uid) DO UPDATE SET issue=excluded.issue,detail=excluded.detail,
          waiting_on=excluded.waiting_on,resolved_at=NULL,resolution=NULL,recorded_at=excluded.recorded_at`)
        .bind(tenantId,uid,health.state==='login_required' ? 'Bank sign-in required' : health.overdue ? 'Bank feed overdue' : 'Bank sync needs attention',
          health.status_line,String(now).slice(0,10),health.action,`bank-feed:${row.item_ref}`,now).run();
    } else if (health.state==='healthy') {
      await env.DB.prepare(`UPDATE fin_exceptions SET resolved_at=?,resolution='A complete current bank sync succeeded.',recorded_at=?
        WHERE tenant_id=? AND exception_uid=? AND resolved_at IS NULL`).bind(String(now).slice(0,10),now,tenantId,uid).run();
    }
  }
  // Slowest connection governs source freshness. A fast connection or a
  // document projection must never conceal another connection's missing days.
  const allSuccessful=rows.every(row=>row.last_successful_sync_at);
  const last=allSuccessful ? rows.map(row=>row.last_successful_sync_at).sort()[0] : null;
  const health=rows.map(row=>bankConnectionHealth(row,now));
  const problem=health.find(row=>row.state==='needs_reconnect') || health.find(row=>row.state==='login_required') || health.find(row=>row.overdue) || health.find(row=>row.state==='error');
  await env.DB.prepare(`INSERT INTO sources (name,kind,status,created_at,last_ingest_at,expected_refresh_seconds,stale_reason)
    VALUES ('bank_activity','bank_activity','ready',?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET expected_refresh_seconds=excluded.expected_refresh_seconds,
      last_ingest_at=excluded.last_ingest_at,stale_reason=excluded.stale_reason`)
    .bind(now,last,BANK_SYNC_SECONDS,problem ? problem.status_line : null).run();
  return {needs_attention:health.filter(row=>row.state!=='healthy').length};
}

// These are trusted, credential-free projections, never caller SQL authority.
export async function moneyBankFreshness(env, {read,periodEnd,now,scope=null,ownerDay}) {
  const tenantId=String(env.BANK_FEED_TENANT||'primary');
  // Read both projections together so an empty Item inventory can still
  // disclose unresolved ledger sources from the same database snapshot.
  const evidence=await read(`WITH item_health AS (${bankHealthSql(true)})
    SELECT h.*,NULL AS ledger_account FROM item_health h
    UNION ALL
    SELECT h.*,json_object('tenant_id',a.tenant_id,'account_slug',a.account_slug,'mask',a.mask,
      'source_feed',a.source_feed,'item_ref',p.item_ref) AS ledger_account
    FROM fin_accounts a LEFT JOIN item_health h ON 0
    LEFT JOIN (${MONEY_FEED_ASSIGNMENTS_SQL}) p
      ON p.tenant_id=a.tenant_id AND ${DISCOVERED_LEDGER_REFERENCE_SQL}
    WHERE a.tenant_id=? AND a.superseded_by_id IS NULL
      AND (a.source_feed GLOB 'bank-feed:*'
        OR (a.source_feed IS NULL AND a.feed_mode='live' AND p.item_ref IS NOT NULL))`,[tenantId,tenantId]);
  const rows=[];
  const accounts=[];
  for (const row of evidence) {
    if (row.ledger_account === null) rows.push(row);
    else accounts.push(JSON.parse(row.ledger_account));
  }
  // Posting predicates cannot exclude an account from a freshness warning.
  const accountFilters=Object.entries(scope?.filters || {}).filter(([field])=>['tenant_id','account_slug'].includes(field));
  const selected=accounts.filter(account=>(!scope?.accountSlugs || scope.accountSlugs.includes(account.account_slug)) &&
    accountFilters.every(([field,value])=>account[field]===value));
  const narrowed=Array.isArray(scope?.accountSlugs) || accountFilters.length>0;
  const label=account=>/^\d{4}$/.test(account.mask||'') ? `the account ending ${account.mask}` : 'a selected bank-fed account';
  const gaps=[];
  for (const account of selected) {
    if (account.item_ref == null) gaps.push({
      reason:`Bank freshness is unknown for ${label(account)} because its bank feed assignment could not be verified.`,
      missing:'Verify the account assignment and confirm bank activity through the asked period.',
    });
  }
  if (!periodEnd && rows.length) return [...gaps,{reason:'The asked period and owner calendar could not be verified.',
    missing:'Provide period_end for the asked period or configure the owner time zone.'}];
  const instant=new Date(now).getTime();
  for (const row of rows) {
    // The ledger's saved Item can identify a gap even when the account has
    // no verified assignment. This read contributes only negative evidence.
    const affected=selected.filter(account=>account.item_ref===row.item_ref ||
      account.source_feed===`bank-feed:${row.item_ref}`);
    if (narrowed && !affected.length) continue;
    const sync=verifiedMoneySyncInstant(row.last_successful_sync_at,instant);
    const observedDay=sync === null ? null : ownerDay?.(row.last_successful_sync_at);
    if (!observedDay) {
      gaps.push({reason:'The bank observation date in the owner calendar could not be verified.',
        missing:'A successful bank sync and a configured owner time zone.'});
      continue;
    }
    // Provider window dates cannot prove the unobserved remainder of an owner day.
    const through=row.data_through ? [observedDay,row.data_through].sort()[0] : null;
    const unobservedTime=periodEnd>=observedDay && sync<instant;
    if (through && through>=periodEnd && !unobservedTime) continue;
    const health=bankConnectionHealth(row,now);
    const labels=affected.length ? affected.map(label) : ['a connected bank'];
    for (const account of labels) gaps.push({reason:through
      ? `No bank data after ${through} for ${account}.${row.removed_at ? ' This bank connection is disconnected.' : ''}` : `No complete bank sync recorded for ${account}.`,
      missing:`Bank activity after the last successful observation at ${row.last_successful_sync_at} through ${periodEnd}${unobservedTime ? ` (asked as of ${new Date(now).toISOString()})` : ''}. ${row.removed_at ? 'Reconnect this bank to check later activity; saved history remains available.' : health.action}`});
  }
  return gaps;
}
