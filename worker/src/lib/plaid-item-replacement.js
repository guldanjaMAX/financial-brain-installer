import { bankErrorStatement } from './bank-feed-health.js';
import { bankCoverageGaps } from './bank-coverage-intervals.js';
import { moneyMinorText } from './money-format.js';
import { bankFeedConfig, tenantReference, encryptAccessReference, decryptAccessReference, accountKindFor } from './bank-feed.js';
import { custodyDigest, inspectBankCustody } from './bank-custody.js';
import { createPlaidLinkToken, callPlaid, providerMinorUnits, stagedDirection, balanceRoundingQualifier } from './plaid-bank-feed.js';
import { normalisePlaidTransaction, plaidDecimalText, PlaidProtocolError } from './plaid-protocol.js';
import { MINOR_ROUNDED_QUALIFIER } from './fin-d1.js';
import { assertPlaidConnectionDistinct } from './plaid-connection-review.js';
import { plaidPublicAccountRef } from './plaid-account-entities.js';
import { accountKindIdentity } from './fin-account-kinds.js';
import { accountLinkIdentity, bankActivityInvalidationStatements } from './fin-account-links.js';

const stamp = value => {
  const n=Date.parse(value || new Date().toISOString());
  if(!Number.isFinite(n)) fail('replacement_time_invalid');
  return new Date(n).toISOString();
};
function fail(code) { throw Object.assign(Error('Bank recovery needs review. Saved history is kept.'),{code,status:409}); }
const tenant = env => tenantReference(env).tenantId;
const rows = async (env,sql,...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const one = (env,sql,...args) => env.DB.prepare(sql).bind(...args).first();
const statement = (env,sql,...args) => env.DB.prepare(sql).bind(...args);
const source = ref => 'bank-feed:'+ref;
const day = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
const currentOperationSql = `NOT EXISTS(SELECT 1 FROM plaid_item_replacements child
  WHERE child.tenant_id=plaid_item_replacements.tenant_id AND child.old_item_ref=plaid_item_replacements.new_item_ref AND child.state<>'cancelled')`;
const revisionGuard = (env,op) => statement(env,`SELECT CASE WHEN EXISTS(SELECT 1 FROM plaid_item_replacements
  WHERE tenant_id=? AND operation_ref=? AND revision=? AND state=? AND ${currentOperationSql}) THEN 1 ELSE json_extract('replacement revision changed','$') END`,
  op.tenant_id,op.operation_ref,op.revision,op.state);
const audit = (env,op,event,now) => statement(env,`INSERT INTO plaid_replacement_audit
  (tenant_id,operation_ref,revision,event,recorded_at) VALUES (?,?,?,?,?)`,op.tenant_id,op.operation_ref,op.revision,event,now);
// Page receipts share the existing append-only audit transaction with the
// staged page. An empty event list is still a poll; money is never its proof.
const POLL_PAGE='replacement_poll_page_v1';
const cursorDigest=cursor=>custodyDigest(['replacement-cursor-v1',cursor || null]);
async function pollPages(env,op,revision=op.revision) {
  const receipts=await rows(env,`SELECT event FROM plaid_replacement_audit
    WHERE tenant_id=? AND operation_ref=? AND revision=? AND event LIKE ? ORDER BY id`,
    op.tenant_id,op.operation_ref,revision,'{"type":"'+POLL_PAGE+'",%');
  return receipts.map(r=>JSON.parse(r.event));
}
function syncCompletion(op,pages,accounts,open=[],mapped=false) {
  const terminal=pages.at(-1),polled=!!terminal && !terminal.has_more;
  const states=accounts.map(a=>({account_slug:a.account_slug,state:
    !polled || !terminal.account_ids.includes(a.provider_id) ? 'unpolled' :
      open.some(d=>d.account_slug===a.account_slug || d.saved_occurrences.some(t=>t.account_slug===a.account_slug)) ? 'open_item' : 'polled'}));
  // Reconciliation is local to an occurrence. Neither an unresolved dollar nor
  // a quiet cursor may veto a proved poll, and neither can stand in for one.
  const eligible=mapped && states.length>0 && states.every(a=>a.state!=='unpolled');
  const state=op.state==='rolled_back' ? 'paused' : !pages.length ? 'unpolled' :
    !polled ? 'polling' : !eligible ? 'awaiting_accounts' :
      op.published_revision===op.revision && op.state==='active' ? 'complete' : 'ready';
  return {state,revision:op.revision,accounts:states,observed_at:polled?terminal.observed_at:null,
    cursor_advanced:polled && pages[0].request_cursor_digest!==terminal.next_cursor_digest};
}
// A later replacement can retire observations from any predecessor. Open their
// existing database fences only inside the same atomic publication transaction.
const latch = (env,op,on) => statement(env,`UPDATE plaid_item_replacements SET publishing=?1 WHERE tenant_id=?2 AND
  (operation_ref=?3 OR new_item_ref IN (SELECT item_ref FROM plaid_replacement_item_lineage WHERE tenant_id=?2 AND operation_ref=?3))`,on,op.tenant_id,op.operation_ref);
async function requireCurrentReplacement(env,op) {
  if(await one(env,`SELECT 1 FROM plaid_item_replacements WHERE tenant_id=? AND old_item_ref=? AND state<>'cancelled' LIMIT 1`,op.tenant_id,op.new_item_ref)) fail('replacement_successor_owns_connection');
}

// A single read snapshot and exact in-batch equality prevent an intervening
// reassignment, withdrawn review, row edit or late writer from reusing approval.
// This is private database evidence and is never returned by the owner route.
const SCOPE = `tenant_id=?1 AND (source_feed='bank-feed:'||?2 OR account_slug IN
 (SELECT account_slug FROM fin_accounts WHERE tenant_id=?1 AND source_feed='bank-feed:'||?2
 UNION SELECT b.account_slug FROM plaid_replacement_bindings b JOIN plaid_item_replacements r ON r.tenant_id=b.tenant_id AND r.operation_ref=b.operation_ref WHERE r.tenant_id=?1 AND r.old_item_ref=?2))`;
const FIELDS = {
  bank_feed_items:['id','tenant_id','item_ref','institution_ref','environment','status','removed_at','access_ciphertext','access_iv','key_version','cursor','last_synced_at'],
  fin_accounts:['id','tenant_id','account_slug','entity_slug','institution','label','mask','account_kind','balance_role','currency','feed_mode','status','external_ref','source_feed','basis_state','superseded_by_id'],
  fin_transactions:['id','txn_uid','account_slug','external_id','source_feed','posted_on','currency','amount_minor','direction','pending','removed_at','superseded_by_id','recorded_at'],
  plaid_occurrence_identities:['tenant_id','item_ref','provider_id','origin_row_id'],
  plaid_occurrence_heads:['tenant_id','origin_row_id','head_row_id'],
  plaid_occurrence_events:['tenant_id','operation_ref','revision','event_index','event_type','origin_row_id','observed_row_id','evidence','digest'],
  plaid_replacement_aliases:['tenant_id','operation_ref','provider_id','account_slug','canonical_row_id','created_at'],
  fin_entities:['id','entity_slug','relationship','status','basis_state','superseded_by_id'],
  fin_account_coverage:['id','account_slug','coverage_status','covered_from','covered_to','basis_state','source_feed','superseded_by_id'],
  bank_account_coverage_intervals:['tenant_id','account_slug','operation_ref','revision','covered_from','covered_to','evidence','observed_at'],
  fin_balance_snapshots:['id','account_slug','as_of_date','current_minor','available_minor','currency','source_feed','recorded_at'],
  fin_obligations:['id','obligation_uid','account_slug','entity_slug','kind','balance_minor','balance_as_of','currency','source_feed','recorded_at','superseded_by_id'],
  plaid_account_entity_assignments:['item_ref','provider_account_id','account_ref','entity_slug','assigned_at','updated_at'],
  fin_account_links:['id','manual_account_slug','live_account_slug','identity_json','link_plan_hash','unlinked_at','unlink_plan_hash'],
  fin_account_kind_reviews:['id','account_id','identity_json','kind','role','reviewer','source','reviewed_at','revoked_at','review_plan_hash'],
  plaid_revocation_outbox:['item_ref','state'],
  plaid_sync_windows:['item_ref','window_ref','state','next_page_index'],
};
const condition = table => table==='bank_account_coverage_intervals' ? `tenant_id=?1 AND account_slug IN (SELECT account_slug FROM fin_accounts WHERE tenant_id=?1 AND source_feed='bank-feed:'||?2 UNION SELECT b.account_slug FROM plaid_replacement_bindings b JOIN plaid_item_replacements r ON r.tenant_id=b.tenant_id AND r.operation_ref=b.operation_ref WHERE r.tenant_id=?1 AND r.old_item_ref=?2)` : table==='bank_feed_items' ? 'tenant_id=?1 AND item_ref=?2' :
  ['fin_accounts','fin_transactions','fin_account_coverage','fin_balance_snapshots'].includes(table) ? SCOPE :
  table==='fin_obligations' ? "tenant_id=?1 AND source_feed='bank-feed:'||?2" :
  ['plaid_account_entity_assignments','plaid_revocation_outbox','plaid_sync_windows'].includes(table) ? `tenant_id=?1 AND (item_ref=?2 OR item_ref IN (SELECT new_item_ref FROM plaid_item_replacements WHERE tenant_id=?1 AND old_item_ref=?2))` : 'tenant_id=?1';
const SNAPSHOT = `SELECT json_object(${Object.entries(FIELDS).map(([table,fields])=>
  `'${table}',json((SELECT json_group_array(json_object(${fields.map(f=>`'${f}',${f}`).join(',')})) FROM
  (SELECT * FROM ${table} WHERE ${condition(table)} ORDER BY ${fields.join(',')})))`).join(',')}) AS snapshot`;
const snapshot = async (env,item) => (await one(env,SNAPSHOT,tenant(env),item)).snapshot;
const snapshotGuard = (env,item,saved) => statement(env,`SELECT CASE WHEN (${SNAPSHOT})=?3 THEN 1
  ELSE json_extract('replacement evidence changed','$') END`,tenant(env),item,saved);
async function operation(env,ref) {
  const op=await one(env,'SELECT * FROM plaid_item_replacements WHERE tenant_id=? AND operation_ref=?',tenant(env),ref);
  if(!op) fail('replacement_not_found');
  return op;
}
async function verifyDiagnosis(env,op) {
  const diagnostic=await inspectBankCustody(env,await oldItem(env,op.old_item_ref));
  const identity=JSON.stringify([diagnostic.code,diagnostic.reference_fingerprint,diagnostic.key_fingerprint,env.INGEST_VERSION]);
  if(identity!==op.diagnosis_json || diagnostic.code!=='BANK_ACCESS_REFERENCE_UNREADABLE') fail('replacement_custody_changed');
}
async function oldItem(env,ref) {
  return one(env,'SELECT * FROM bank_feed_items WHERE tenant_id=? AND item_ref=?',tenant(env),ref);
}
export async function replacementPreview(env,{itemRef,now}={}) {
  now=stamp(now);
  const saved=await snapshot(env,itemRef), data=JSON.parse(saved), item=data.bank_feed_items[0];
  if(!item) fail('replacement_connection_not_found');
  const diagnostic=await inspectBankCustody(env,item);
  const existing=await one(env,`SELECT operation_ref,state FROM plaid_item_replacements WHERE tenant_id=? AND (old_item_ref=? OR new_item_ref=?)
    AND state NOT IN ('cancelled','rolled_back') AND NOT (state='active' AND new_item_ref=?)`,tenant(env),itemRef,itemRef,itemRef);
  const deployment=typeof env.INGEST_VERSION==='string' && env.INGEST_VERSION ? env.INGEST_VERSION : null;
  const eligible=env.BANK_FEED_PROVIDER==='plaid' && item.environment===(env.BANK_FEED_ENV || 'sandbox') && deployment!==null &&
    !item.removed_at && ['error','reauth_required'].includes(item.status) && diagnostic.code==='BANK_ACCESS_REFERENCE_UNREADABLE' &&
    data.plaid_revocation_outbox.length===0 && !existing;
  const expires=new Date(Date.parse(now)+15*60000).toISOString();
  const planHash=await custodyDigest(['bank-replacement-v1',saved,diagnostic.key_fingerprint,deployment,expires]);
  return {eligible,plan_hash:planHash,expires_at:expires,diagnostic,existing_operation:existing?.operation_ref || null,
    accounts:data.fin_accounts.filter(a=>a.superseded_by_id===null).map(a=>({account_slug:a.account_slug,last4:a.mask,currency:a.currency,type:a.account_kind,name:a.label,entity:a.entity_slug})),
    detail:'Keep every saved transaction, account owner choice and older month. A new bank sign-in will be staged, matched and reviewed before handover. Nothing is deleted. Old bank permission is not revoked.',
    _snapshot:saved};
}
export async function approveReplacement(env,{itemRef,approve,expiresAt,confirmUnrecoverable=false,now}={}) {
  now=stamp(now);
  if(!confirmUnrecoverable || !day(expiresAt?.slice(0,10)) || Date.parse(expiresAt)<=Date.parse(now) || Date.parse(expiresAt)>Date.parse(now)+15*60000) fail('replacement_approval_required');
  // Reconstruct the approved expiry, rather than sliding its lifetime on retry.
  const plan=await replacementPreview(env,{itemRef,now:new Date(Date.parse(expiresAt)-15*60000).toISOString()});
  if(!plan.eligible || plan.plan_hash!==approve) fail('replacement_approval_stale');
  const op={tenant_id:tenant(env),operation_ref:crypto.randomUUID(),old_item_ref:itemRef,revision:0};
  await env.DB.batch([snapshotGuard(env,itemRef,plan._snapshot),statement(env,`INSERT INTO plaid_item_replacements
    (tenant_id,operation_ref,old_item_ref,state,snapshot_json,plan_hash,diagnosis_json,approved_at,expires_at,updated_at)
    VALUES (?,?,?,'owner_approved',?,?,?,?,?,?)`,op.tenant_id,op.operation_ref,itemRef,plan._snapshot,approve,JSON.stringify([plan.diagnostic.code,plan.diagnostic.reference_fingerprint,plan.diagnostic.key_fingerprint,env.INGEST_VERSION]),now,expiresAt,now),audit(env,op,'owner_approved_preserve_history',now)]);
  return replacementStatus(env,{operationRef:op.operation_ref});
}
export async function replacementLink(env,{operationRef,url,fetchImpl,now}={}) {
  now=stamp(now); const op=await operation(env,operationRef);
  if(!['owner_approved','link_pending'].includes(op.state) || op.expires_at<=now) fail('replacement_link_not_ready');
  await verifyDiagnosis(env,op);
  await env.DB.batch([revisionGuard(env,op),snapshotGuard(env,op.old_item_ref,op.snapshot_json),
    statement(env,"UPDATE plaid_item_replacements SET state='link_pending',updated_at=? WHERE tenant_id=? AND operation_ref=?",now,op.tenant_id,operationRef)]);
  return createPlaidLinkToken(env,{url,sessionRef:'replace_'+operationRef.replaceAll('-',''),fetchImpl,now});
}

/** Claim the same shipped one-shot exchange and persist V2 custody first. */
export async function completeReplacementLink(env,{operationRef,publicToken,fetchImpl,now}={}) {
  now=stamp(now); const op=await operation(env,operationRef);
  if(op.new_item_ref) return replacementStatus(env,{operationRef});
  if(op.state==='exchange_claimed' || op.state==='outcome_unknown') fail('replacement_exchange_outcome_unknown');
  if(op.state!=='link_pending' || op.expires_at<=now || typeof publicToken!=='string' || !publicToken) fail('replacement_link_not_ready');
  const config=bankFeedConfig(env), session='replace_'+operationRef.replaceAll('-','');
  await verifyDiagnosis(env,op);
  const control=crypto.randomUUID(), sealed=await encryptAccessReference(env,control);
  if(await decryptAccessReference(env,{...sealed,keyVersion:sealed.keyVersion})===control) {
    // encrypt returns ciphertext/iv; plaintext stays only in this invocation.
  } else fail('replacement_storage_control_failed');
  const fingerprint=await custodyDigest(publicToken);
  await env.DB.batch([revisionGuard(env,op),snapshotGuard(env,op.old_item_ref,op.snapshot_json),
    statement(env,`SELECT CASE WHEN EXISTS(SELECT 1 FROM plaid_link_operations WHERE tenant_id=?1 AND session_ref=?2
      AND state='link_ready') AND NOT EXISTS(SELECT 1 FROM plaid_link_operations WHERE tenant_id=?1 AND state='exchange_started')
      THEN 1 ELSE json_extract('replacement exchange busy','$') END`,op.tenant_id,session),
    statement(env,"UPDATE plaid_link_operations SET state='exchange_started',public_token_fingerprint=?,updated_at=? WHERE tenant_id=? AND session_ref=?",fingerprint,now,op.tenant_id,session),
    statement(env,"UPDATE plaid_item_replacements SET state='exchange_claimed',updated_at=? WHERE tenant_id=? AND operation_ref=?",now,op.tenant_id,operationRef),audit(env,op,'exchange_claimed',now)]);
  let exchanged;
  try { exchanged=await callPlaid(env,'/item/public_token/exchange',{public_token:publicToken},{fetchImpl}); }
  catch { await statement(env,"UPDATE plaid_item_replacements SET state='outcome_unknown',updated_at=? WHERE tenant_id=? AND operation_ref=?",now,op.tenant_id,operationRef).run(); fail('replacement_exchange_outcome_unknown'); }
  if(typeof exchanged?.item_id!=='string' || !exchanged.item_id || !exchanged.access_token || exchanged.item_id===op.old_item_ref) fail('replacement_exchange_outcome_unknown');
  const wrapped=await encryptAccessReference(env,exchanged.access_token);
  // No conflict-upsert: an existing Item must never be adopted or overwritten.
  await env.DB.batch([statement(env,`SELECT CASE WHEN EXISTS(SELECT 1 FROM plaid_item_replacements WHERE tenant_id=? AND operation_ref=? AND state='exchange_claimed')
      THEN 1 ELSE json_extract('replacement exchange changed','$') END`,op.tenant_id,operationRef),latch(env,op,1),
    statement(env,`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,status,status_detail,connected_at)
      VALUES (?,?,?,?,?,?,'error','Replacement history is quarantined for owner review.',?)`,op.tenant_id,exchanged.item_id,wrapped.ciphertext,wrapped.iv,wrapped.keyVersion,config.environment,now),
    statement(env,"UPDATE plaid_item_replacements SET new_item_ref=?,state='candidate_staged',updated_at=? WHERE tenant_id=? AND operation_ref=?",exchanged.item_id,now,op.tenant_id,operationRef),
    statement(env,`UPDATE plaid_link_operations SET state='completed',item_ref=?,receipt_json=?,link_ciphertext=NULL,link_iv=NULL,link_key_version=NULL,completed_at=?,updated_at=? WHERE tenant_id=? AND session_ref=?`,exchanged.item_id,JSON.stringify({replacement_ref:operationRef,quarantined:true}),now,now,op.tenant_id,session),
    latch(env,op,0),audit(env,op,'candidate_custody_saved',now)]);
  return replacementStatus(env,{operationRef});
}

// Ordinary sync reads a provider amount through the protocol layer's decimal
// text, which expands exponent notation. A value that layer cannot read is
// passed on unchanged, so its refusal below is the one this path always gave.
function providerDecimal(value) {
  if(value===null || value===undefined) return value;
  try { return plaidDecimalText(value); }
  catch(error) { if(error instanceof PlaidProtocolError) return value; throw error; }
}
function normaliseEvent(row,operation) {
  if(typeof row?.transaction_id!=='string' || !row.transaction_id || row.transaction_id.length>256) fail('replacement_event_invalid');
  if(operation==='removed') return {id:row.transaction_id,operation};
  if(typeof row.account_id!=='string' || !day(row.date) || typeof row.pending!=='boolean') fail('replacement_event_invalid');
  const currency=row.iso_currency_code;
  // A decimal finer than the currency's minor unit rounds half-even and keeps
  // its exact text and marker, as ordinary sync stages it (plaid-bank-feed.js
  // transactionStageRows). Refusing it stopped the replaced bank with no way
  // out. A missing, malformed or unsupported-currency amount still refuses.
  const value=providerMinorUnits(providerDecimal(row.amount),currency);
  if(value.minor===null) fail('replacement_amount_needs_precision_review');
  // The ordinary sync's own validation and text rules, so a published successor
  // row stores exactly what ordinary sync stores for the same provider payload:
  // description is the merchant name when sent (else the bank text), payee is
  // the merchant, and the category is detailed-or-primary. Non-text fields and
  // half categories refuse the page; absent fields are omitted, not invented.
  let text;
  try { text=normalisePlaidTransaction(row); }
  catch(error) { if(error instanceof PlaidProtocolError) fail('replacement_event_invalid'); throw error; }
  return {id:row.transaction_id,account:row.account_id,date:row.date,decimal:text.amount,amount:Math.abs(value.minor),
    direction:stagedDirection(value),currency,pending:row.pending ? 1:0,
    pending_id:row.pending_transaction_id || null,name:text.name,
    ...(text.merchantName?{merchant:text.merchantName}:{}),...(text.categoryPrimary?{category_primary:text.categoryPrimary}:{}),
    ...(text.categoryDetailed?{category_detailed:text.categoryDetailed}:{}),...(value.rounded?{amount_minor_rounded:true}:{}),operation};
}
function normaliseAccount(a) {
  if(typeof a?.account_id!=='string' || !a.account_id || typeof a.name!=='string' || !a.balances?.iso_currency_code) fail('replacement_inventory_invalid');
  const current=providerMinorUnits(providerDecimal(a.balances.current),a.balances.iso_currency_code),
    available=providerMinorUnits(providerDecimal(a.balances.available),a.balances.iso_currency_code);
  // As ordinary sync promotes a balance: the rounded integer, with its marker
  // on the snapshot's source locator (schema 46 has no balance decimal column).
  const qualifier=balanceRoundingQualifier(current,available);
  return {id:a.account_id,name:a.name,official_name:a.official_name || null,mask:a.mask,balance_current:current.minor,balance_available:available.minor,
    kind:accountKindFor(a.type,a.subtype),currency:a.balances.iso_currency_code,...(qualifier?{balance_locator_qualifier:qualifier}:{})};
}
export async function stageReplacement(env,{operationRef,fetchImpl,autoAdmit=false,now}={}) {
  now=stamp(now); let op=await operation(env,operationRef);
  await requireCurrentReplacement(env,op);
  const retained=await pollPages(env,op);
  const legacyWindow=op.revision>op.published_revision && op.pages>0 && retained.length===0;
  if(legacyWindow) {
    const count=await one(env,`SELECT COUNT(*) n FROM plaid_replacement_audit WHERE tenant_id=? AND operation_ref=?
      AND revision=? AND event='history_page_retained'`,op.tenant_id,operationRef,op.revision);
    if(count.n!==op.pages) fail('replacement_poll_evidence_missing');
  }
  // A retained page must not pin every later provider fetch behind one row.
  // Initial account handover still needs the owner's explicit mapping approval.
  if(op.state==='history_review' && op.published_revision>0 && !legacyWindow) {
    const bindings=await rows(env,'SELECT account_slug,new_provider_id FROM plaid_replacement_bindings WHERE tenant_id=? AND operation_ref=?',op.tenant_id,operationRef);
    const mappings=bindings.map(b=>({account_slug:b.account_slug,provider_id:b.new_provider_id,confirm:true}));
    const plan=await reviewReplacement(env,{operationRef,mappings,now});
    if(plan.can_complete) return activateReplacement(env,{operationRef,mappings,approve:plan.plan_hash,expiresAt:plan.expires_at,now});
    op=await operation(env,operationRef);
  }
  if(!op.new_item_ref || !(['candidate_staged','active'].includes(op.state) || legacyWindow && op.state==='history_review')) {
    if(op.state==='history_review') return replacementStatus(env,{operationRef});
    fail('replacement_stage_not_ready');
  }
  const fetchOwner=crypto.randomUUID();
  const claim=await statement(env,`UPDATE plaid_item_replacements SET fetch_owner=?,fetch_expires_at=?
    WHERE tenant_id=? AND operation_ref=? AND revision=? AND state=? AND (fetch_owner IS NULL OR fetch_expires_at<=?) AND ${currentOperationSql}`,fetchOwner,
    new Date(Date.parse(now)+120000).toISOString(),op.tenant_id,operationRef,op.revision,op.state,now).run();
  if(claim.meta?.changes!==1) fail('replacement_stage_busy');
  const guard=()=>statement(env,`SELECT CASE WHEN EXISTS(SELECT 1 FROM plaid_item_replacements WHERE tenant_id=? AND operation_ref=?
    AND fetch_owner=? AND revision=? AND state=? AND ${currentOperationSql}) THEN 1 ELSE json_extract('replacement fetch ownership lost','$') END`,op.tenant_id,operationRef,fetchOwner,op.revision,op.state);
  try {
    const item=await oldItem(env,op.new_item_ref), predecessor=await oldItem(env,op.old_item_ref);
    const access=await decryptAccessReference(env,{ciphertext:item.access_ciphertext,iv:item.access_iv,keyVersion:item.key_version});
    const authority=await callPlaid(env,'/item/get',{access_token:access},{fetchImpl});
    if(authority?.item?.item_id!==op.new_item_ref || authority.item.institution_id!==predecessor.institution_ref || authority.item.error) fail('replacement_institution_mismatch');
    const accountResponse=await callPlaid(env,'/accounts/get',{access_token:access},{fetchImpl});
    if(!Array.isArray(accountResponse?.accounts) || !accountResponse.accounts.length || accountResponse.accounts.length>100) fail('replacement_inventory_invalid');
    const accounts=accountResponse.accounts.map(a=>({...normaliseAccount(a),observed_at:now}));
    if(new Set(accounts.map(a=>a.id)).size!==accounts.length) fail('replacement_inventory_invalid');
    await assertPlaidConnectionDistinct(env,{tenantId:op.tenant_id,institutionRef:predecessor.institution_ref,
      accounts:accounts.map(a=>({id:a.id,name:a.name,mask:a.mask})),replacementRef:operationRef});
    const identity=list=>JSON.stringify(list.map(({balance_current,balance_available,balance_locator_qualifier,observed_at,...a})=>a));
    if(op.inventory_json && identity(JSON.parse(op.inventory_json))!==identity(accounts)) fail('replacement_inventory_changed');
    const request={access_token:access,count:100};
    // Older retained windows lack cursor-chain receipts. Keep every event and
    // restart from the successor's published cursor, proving a fresh window
    // rather than certifying an unproved prefix or stranding its review debt.
    const requestCursor=legacyWindow ? item.cursor : op.cursor;
    if(requestCursor) request.cursor=requestCursor; // Never the predecessor's cursor.
    const page=await callPlaid(env,'/transactions/sync',request,{fetchImpl});
    if(typeof page?.has_more!=='boolean' || typeof page.next_cursor!=='string' || !page.next_cursor || page.next_cursor.length>256) fail('replacement_page_invalid');
    if(!['added','modified','removed'].every(k=>Array.isArray(page[k])) || page.added.length+page.modified.length+page.removed.length>500) fail('replacement_page_invalid');
    const events=['added','modified','removed'].flatMap(k=>page[k].map(r=>normaliseEvent(r,k)));
    if(events.some(e=>e.operation!=='removed' && !accounts.some(a=>a.id===e.account))) fail('replacement_event_account_missing');
    const revision=op.published_revision+1, start=op.pages*1000;
    const previous=await pollPages(env,op,revision),requestDigest=await cursorDigest(requestCursor),nextDigest=await cursorDigest(page.next_cursor);
    const retainedPrefix=previous[0]?.page_index || 0;
    if(!legacyWindow && previous.length+retainedPrefix!==op.pages || previous.length && (previous.at(-1).next_cursor_digest!==requestDigest || !previous.at(-1).has_more)) fail('replacement_poll_evidence_missing');
    const seen=new Set([requestDigest,...previous.flatMap(p=>[p.request_cursor_digest,p.next_cursor_digest])]);
    // Match ordinary sync: a terminal cursor may stay put. Continuing without
    // progress or cycling to another earlier cursor is never a completed poll.
    if(seen.has(nextDigest) && (page.has_more || nextDigest!==requestDigest)) fail('replacement_page_invalid');
    const receipt={type:POLL_PAGE,page_index:op.pages,request_cursor_digest:requestDigest,next_cursor_digest:nextDigest,
      has_more:page.has_more,account_ids:accounts.map(a=>a.id),observed_at:now};
    const values=[];
    for(let i=0;i<events.length;i++) values.push({index:start+i,id:events[i].id,account:events[i].account || null,
      payload:JSON.stringify(events[i]),digest:await custodyDigest(events[i])});
    await env.DB.batch([guard(),statement(env,`INSERT INTO plaid_replacement_events
      (tenant_id,operation_ref,revision,event_index,provider_id,provider_account_id,payload_json,digest)
      SELECT ?1,?2,?3,json_extract(value,'$.index'),json_extract(value,'$.id'),json_extract(value,'$.account'),json_extract(value,'$.payload'),json_extract(value,'$.digest')
      FROM json_each(?4)`,op.tenant_id,operationRef,revision,JSON.stringify(values)),
      statement(env,`UPDATE plaid_item_replacements SET cursor=?,pages=pages+1,inventory_json=?,history_state=?,revision=?,
        state=?,fetch_owner=NULL,fetch_expires_at=NULL,updated_at=? WHERE tenant_id=? AND operation_ref=?`,page.next_cursor,JSON.stringify(accounts),
        page.transactions_update_status || 'UNKNOWN',revision,page.has_more?'candidate_staged':'history_review',now,op.tenant_id,operationRef),
      audit(env,{...op,revision},'history_page_retained',now),audit(env,{...op,revision},JSON.stringify(receipt),now)]);
  } catch(error) {
    // Keep scheduled failures visible without leaking provider bodies or losing
    // the staged cursor. This exact fetch owner still owns the failure receipt.
    await env.DB.batch([guard(),latch(env,op,1),bankErrorStatement(env,op.tenant_id,op.new_item_ref,now,error?.code),latch(env,op,0),audit(env,op,'history_fetch_needs_review',now)]);
    throw error;
  } finally { await statement(env,'UPDATE plaid_item_replacements SET fetch_owner=NULL,fetch_expires_at=NULL WHERE tenant_id=? AND operation_ref=? AND fetch_owner=?',op.tenant_id,operationRef,fetchOwner).run(); }
  if(autoAdmit && op.published_revision>0) {
    const current=await operation(env,operationRef);
    if(current.state==='history_review') {
      const bindings=await rows(env,'SELECT account_slug,new_provider_id FROM plaid_replacement_bindings WHERE tenant_id=? AND operation_ref=?',op.tenant_id,operationRef);
      const mappings=bindings.map(b=>({account_slug:b.account_slug,provider_id:b.new_provider_id,confirm:true}));
      const plan=await reviewReplacement(env,{operationRef,mappings,now});
      // Initial owner approval authorizes ordinary future bank imports. Only
      // proved aliases and distinct activity after complete coverage qualify;
      // any overlap/correction remains durable for a fresh owner review.
      if(plan.can_complete) return activateReplacement(env,{operationRef,mappings,approve:plan.plan_hash,expiresAt:plan.expires_at,now});
    }
  }
  return replacementStatus(env,{operationRef});
}

const cleanName = v => String(v || '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const sameMoney = (a,b) => a.currency===b.currency && a.amount===b.amount_minor && a.direction===b.direction &&
  a.date===b.posted_on && a.pending===b.pending && !b.removed_at && b.superseded_by_id===null;
export async function reviewReplacement(env,{operationRef,mappings=[],choices=[],intervals=[],expiresAt=null,now}={}) {
  now=stamp(now); const op=await operation(env,operationRef);
  if(!['history_review','rolled_back','active'].includes(op.state)) fail('replacement_review_not_ready');
  const expires=expiresAt || new Date(Date.parse(now)+15*60000).toISOString();
  if(!Number.isFinite(Date.parse(expires)) || expires<=now || Date.parse(expires)>Date.parse(now)+15*60000) fail('replacement_review_expired');
  const saved=await snapshot(env,op.old_item_ref), data=JSON.parse(saved);
  const old=data.fin_accounts.filter(a=>a.superseded_by_id===null), incoming=JSON.parse(op.inventory_json || '[]');
  const priorBindings=await rows(env,'SELECT * FROM plaid_replacement_bindings WHERE tenant_id=? AND operation_ref=?',op.tenant_id,operationRef);
  const accountPlans=old.map(a=>{
    const candidates=incoming.filter(n=>n.mask && n.mask===a.mask && n.kind===a.account_kind && n.currency===a.currency &&
      [n.name,n.official_name].some(name=>cleanName(name)===cleanName(a.label)));
    const manual=mappings.filter(m=>m.account_slug===a.account_slug);
    if(manual.length>1) fail('replacement_mapping_ambiguous');
    const requested=manual[0];
    const n=requested ? incoming.find(n=>n.id===requested.provider_id) : candidates.length===1 ? candidates[0] : null;
    const prior=priorBindings.find(b=>b.account_slug===a.account_slug);
    const assignment=data.plaid_account_entity_assignments.find(p=>p.provider_account_id===(prior?.old_provider_id || a.external_ref) || p.account_ref===a.external_ref);
    const owner=data.fin_entities.find(e=>e.entity_slug===a.entity_slug && e.relationship==='owned' && e.status==='active' && e.superseded_by_id===null && e.basis_state==='confirmed');
    const compatible=!!n && n.mask===a.mask && n.kind===a.account_kind && n.currency===a.currency && owner && assignment?.entity_slug===a.entity_slug;
    return {account_slug:a.account_slug,last4:a.mask,name:a.label,currency:a.currency,type:a.account_kind,
      provider_id:n?.id || null,candidates:candidates.map(n=>({provider_id:n.id,name:n.name,last4:n.mask})),
      confirmed:compatible && requested?.confirm===true && (!prior || prior.new_provider_id===n.id),
      previous:a,old_provider_id:prior?.old_provider_id || assignment?.provider_account_id || a.external_ref};
  });
  const mapped=accountPlans.every(p=>p.confirmed) && accountPlans.length===incoming.length && old.length>0 &&
    new Set(accountPlans.map(p=>p.provider_id)).size===old.length;
  const events=await rows(env,`SELECT e.* FROM plaid_replacement_events e WHERE e.tenant_id=? AND e.operation_ref=?
    AND NOT EXISTS(SELECT 1 FROM plaid_replacement_decisions d WHERE d.tenant_id=e.tenant_id AND d.operation_ref=e.operation_ref
      AND d.revision=e.revision AND d.event_index=e.event_index) ORDER BY e.revision,e.event_index`,op.tenant_id,operationRef);
  const aliases=await rows(env,'SELECT * FROM plaid_replacement_aliases WHERE tenant_id=? AND operation_ref=?',op.tenant_id,operationRef);
  const itemRefs=(await rows(env,'SELECT item_ref FROM plaid_replacement_item_lineage WHERE tenant_id=? AND operation_ref=? ORDER BY item_ref',op.tenant_id,operationRef)).map(i=>i.item_ref);
  const seenIds=new Set();
  const decisions=events.map(event=>{
    const e=JSON.parse(event.payload_json), binding=accountPlans.find(p=>p.provider_id===e.account);
    const alias=aliases.find(a=>a.provider_id===e.id), pendingAlias=aliases.find(a=>a.provider_id===e.pending_id);
    // Every old identity follows the append-only correction graph to its head.
    // A mutable compatibility alias may be stale; it has no authority to hide
    // the live successor on a different account or a later replacement Item.
    const resolveIdentity=(id,legacyAlias)=>{
      if(!id)return [];
      const origins=data.plaid_occurrence_identities.filter(i=>itemRefs.includes(i.item_ref) && i.provider_id===id).map(i=>i.origin_row_id);
      if(legacyAlias)origins.push(legacyAlias.canonical_row_id);
      const heads=new Set(data.plaid_occurrence_heads.filter(h=>origins.includes(h.origin_row_id)).map(h=>h.head_row_id));
      return data.fin_transactions.filter(t=>heads.has(t.id));
    };
    const identity=resolveIdentity(e.id,alias);
    const pending=resolveIdentity(e.pending_id,pendingAlias);
    const prior=data.fin_transactions.filter(t=>e.operation==='removed' || t.account_slug===(binding?.account_slug || alias?.account_slug) || identity.includes(t) || pending.includes(t));
    const same=identity.filter(t=>e.operation!=='removed' && t.account_slug===binding?.account_slug && sameMoney(e,t));
    const admissionConflict=e.operation!=='added' || identity.length>0 || pending.length>0 || !!alias || !!pendingAlias;
    const cutoff=data.fin_account_coverage.find(c=>c.account_slug===binding?.account_slug && c.coverage_status==='complete' && c.basis_state==='confirmed' && c.superseded_by_id===null)?.covered_to;
    const possible=prior.filter(t=>!t.removed_at && t.superseded_by_id===null && t.currency===e.currency && t.amount_minor===e.amount && t.direction===e.direction);
    const proposal=choices.filter(c=>c.event_index===event.event_index && (c.event_revision===undefined || c.event_revision===event.revision));
    if(proposal.some(c=>c.event_revision===undefined) && events.filter(v=>v.event_index===event.event_index).length>1) fail('replacement_row_choice_ambiguous');
    if(proposal.length>1) fail('replacement_row_choice_ambiguous');
    const choice=proposal[0];
    let action='review', oldRow=null, evidence='A statement occurrence or provider identity is needed.';
    if(identity.length===1 && same.length===1 && !seenIds.has(e.id)) {action='duplicate';oldRow=same[0];evidence='Exact provider identity and economic fields.';}
    else if(binding && !admissionConflict && !e.pending && day(cutoff) && e.date>cutoff &&
      !pending.length && !possible.length && !seenIds.has(e.id)) {
      action='admit';evidence='After confirmed coverage; no known identity, pending link or equal-money overlap.';
    }
    if(choice) {
      if(!['admit','duplicate','replace','remove'].includes(choice.action) || typeof choice.evidence!=='string' || choice.evidence.length<8 || choice.evidence.length>500) fail('replacement_row_evidence_required');
      action=choice.action;evidence=choice.evidence;
      oldRow=choice.old_row_id===undefined ? null : prior.find(t=>t.id===choice.old_row_id);
      if(action==='duplicate' && (!oldRow || oldRow.account_slug!==binding?.account_slug || !sameMoney(e,oldRow) ||
        identity.length>0 && (identity.length!==1 || identity[0].id!==oldRow.id))) fail('replacement_duplicate_not_proved');
      const known=identity.length ? identity : pending;
      const exactHead=known.length===1 && known[0].id===oldRow?.id;
      if(['replace','remove'].includes(action) && (!oldRow || oldRow.superseded_by_id!==null ||
        (known.length>0 && !exactHead) ||
        (action==='replace' && (e.operation==='removed' || oldRow.removed_at && (!exactHead || e.operation!=='modified'))) ||
        (action==='remove' && (oldRow.removed_at ? !exactHead : e.operation!=='removed')))) fail('replacement_correction_not_proved');
      if(action==='admit' && admissionConflict) fail('replacement_admission_conflict');
    }
    if(!binding && e.operation!=='removed') action='review';
    if(e.operation==='removed' && !alias && !oldRow) action='review';
    if(seenIds.has(e.id)) action='review'; // Mutation pages need occurrence-by-occurrence reconciliation.
    seenIds.add(e.id);
    const savedRow=oldRow || identity[0] || pending[0];
    const amount=e.amount ?? savedRow?.amount_minor,currency=e.currency || savedRow?.currency;
    return {event_revision:event.revision,event_index:event.event_index,provider_id:e.id,account_slug:binding?.account_slug || savedRow?.account_slug || null,
      date:e.date || savedRow?.posted_on || null,amount_minor:amount ?? null,currency:currency || null,direction:e.direction || savedRow?.direction || null,
      action,old_row_id:oldRow?.id || null,evidence,digest:event.digest,
      amount_text:amount===undefined ? 'amount unknown' : currency+' '+moneyMinorText(amount,currency),
      saved_occurrences:prior.filter(t=>identity.includes(t) || pending.includes(t) || !t.removed_at && t.superseded_by_id===null && (t.amount_minor===e.amount || t.external_id===e.pending_id)).map(t=>({id:t.id,account_slug:t.account_slug,date:t.posted_on,currency:t.currency,direction:t.direction,amount_minor:t.amount_minor,amount_text:t.currency+' '+moneyMinorText(t.amount_minor,t.currency),pending:t.pending,withdrawn:!!t.removed_at}))};
  });
  // A provider pending removal retires an observation, not its posted successor.
  // Keep both audited decisions, with only the correction consuming the old head.
  for(const d of decisions) if(d.action==='remove') {
    const event=events.find(e=>e.revision===d.event_revision && e.event_index===d.event_index),e=JSON.parse(event.payload_json);
    if(e.operation!=='removed')continue;
    const origins=data.plaid_occurrence_identities.filter(i=>itemRefs.includes(i.item_ref) && i.provider_id===e.id).map(i=>i.origin_row_id);
    const observation=data.fin_transactions.find(t=>origins.includes(t.id) && t.pending===1 &&
      data.plaid_occurrence_heads.some(h=>h.origin_row_id===t.id && h.head_row_id===d.old_row_id));
    const head=data.fin_transactions.find(t=>t.id===d.old_row_id);
    const posting=decisions.some(p=>p.action==='replace' && p.old_row_id===d.old_row_id && events.some(v=>{
      const incoming=JSON.parse(v.payload_json);
      return v.revision===p.event_revision && v.event_index===p.event_index && incoming.pending_id===e.id && incoming.pending===0;
    }));
    // A same-ID posting makes that ID an economic identity. Its later removal
    // withdraws money; only an exclusively pending identity can retire for free.
    const postedIdentity=data.fin_transactions.some(t=>origins.includes(t.id) && t.pending===0);
    if(observation && !postedIdentity && (head?.pending===0 || posting)) {
      d.pending_observation_row_id=observation.id;d.old_row_id=null;
    }
  }
  // Conflicting claims stay local and visible; event ordering grants no authority.
  const conflicting=new Set(decisions.filter(d=>d.old_row_id!==null && d.action!=='review' &&
    decisions.filter(other=>other.old_row_id===d.old_row_id && other.action!=='review').length>1).map(d=>d.old_row_id));
  for(const d of decisions)if(conflicting.has(d.old_row_id))d.action='review';
  if(!Array.isArray(intervals) || intervals.some(i=>!accountPlans.some(p=>p.account_slug===i.account_slug) || !day(i.from) || !day(i.to) || i.from>i.to ||
    i.to>=now.slice(0,10) || typeof i.evidence!=='string' || i.evidence.length<8 || i.evidence.length>500)) fail('replacement_coverage_evidence_required');
  const ready=mapped && decisions.every(d=>d.action!=='review');
  const completion=syncCompletion(op,await pollPages(env,op),accountPlans,decisions.filter(d=>d.action==='review'),mapped);
  const hash=await custodyDigest(['replacement-review-v1',saved,op.operation_ref,op.revision,op.cursor,op.inventory_json,
    itemRefs,accountPlans.map(p=>[p.account_slug,p.provider_id,p.confirmed]),decisions,intervals,expires]);
  return {operation_ref:operationRef,revision:op.revision,plan_hash:hash,expires_at:expires,ready,can_complete:['ready','complete'].includes(completion.state),sync_completion:completion,
    accounts:accountPlans.map(({previous,...p})=>p),incoming_accounts:incoming.map(n=>({provider_id:n.id,name:n.name,last4:n.mask})),decisions,intervals,
    unresolved:decisions.filter(d=>d.action==='review').length,
    detail:'Every old row is kept. Only proved duplicate occurrences are counted once. Missing accounts or uncertain rows need your choice. Missing dollar impact is unknown unless listed.',
    _snapshot:saved,_accounts:accountPlans};
}

// Carry only currently valid account approvals. Old reviews are retained and
// revoked as superseded; stale or previously revoked reviews gain no authority.
async function successorReviews(env,accounts,hash,now) {
  const statements=[];
  for(const {before,after} of accounts) {
    const reviews=await rows(env,'SELECT * FROM fin_account_kind_reviews WHERE tenant_id=? AND account_id=? AND revoked_at IS NULL',before.tenant_id,before.id);
    for(const review of reviews) if(review.identity_json===accountKindIdentity(before)) statements.push(
      statement(env,'UPDATE fin_account_kind_reviews SET revoked_at=?,revoke_plan_hash=? WHERE id=? AND revoked_at IS NULL',now,hash,review.id),
      statement(env,`INSERT INTO fin_account_kind_reviews (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
        VALUES (?,?,?,?,?,'owner','owner_account_kind',?,?)`,before.tenant_id,before.id,accountKindIdentity(after),review.kind,review.role,now,hash));
  }
  const links=await rows(env,'SELECT * FROM fin_account_links WHERE tenant_id=? AND unlinked_at IS NULL',tenant(env));
  for(const link of links) {
    const pair=await rows(env,'SELECT * FROM fin_accounts WHERE tenant_id=? AND account_slug IN (?,?) AND superseded_by_id IS NULL ORDER BY account_slug',tenant(env),link.manual_account_slug,link.live_account_slug);
    const manual=pair.find(a=>a.account_slug===link.manual_account_slug),live=pair.find(a=>a.account_slug===link.live_account_slug);
    if(!manual || !live || link.identity_json!==JSON.stringify([accountLinkIdentity(manual),accountLinkIdentity(live)])) continue;
    if(!accounts.some(a=>a.before.id===manual.id || a.before.id===live.id)) continue;
    const next=a=>accounts.find(c=>c.before.id===a.id)?.after || a;
    statements.push(statement(env,'UPDATE fin_account_links SET unlinked_at=?,unlink_plan_hash=? WHERE id=? AND unlinked_at IS NULL',now,hash,link.id),
      statement(env,`INSERT INTO fin_account_links (tenant_id,manual_account_slug,live_account_slug,identity_json,link_plan_hash,linked_at)
        VALUES (?,?,?,?,?,?)`,tenant(env),link.manual_account_slug,link.live_account_slug,JSON.stringify([accountLinkIdentity(next(manual)),accountLinkIdentity(next(live))]),hash,now));
  }
  return statements;
}
export async function activateReplacement(env,{operationRef,approve,mappings,choices,intervals,expiresAt,now}={}) {
  now=stamp(now);const op=await operation(env,operationRef);
  await requireCurrentReplacement(env,op);
  if(op.state==='rolled_back') fail('replacement_resume_required');
  if(op.state==='active' && op.review_hash===approve) return replacementStatus(env,{operationRef});
  if(typeof expiresAt!=='string') fail('replacement_review_expiry_required');
  const plan=await reviewReplacement(env,{operationRef,mappings,choices,intervals,expiresAt,now});
  if(!plan.can_complete || plan.plan_hash!==approve) fail('replacement_review_stale_or_unresolved');
  const old=await oldItem(env,op.old_item_ref);
  if(op.published_revision===0) {
    await verifyDiagnosis(env,op);
    if(old.removed_at) fail('replacement_custody_changed');
  }
  const successor=await oldItem(env,op.new_item_ref);
  if(!successor || successor.removed_at || successor.environment!==old.environment) fail('replacement_candidate_changed');
  const pairs=[];
  for(const p of plan._accounts) pairs.push({before:p.previous,after:{...p.previous,source_feed:source(op.new_item_ref),external_ref:await plaidPublicAccountRef(op.tenant_id,op.new_item_ref,p.provider_id)}});
  const resolved=plan.decisions.filter(d=>d.action!=='review');
  const data=JSON.parse(plan._snapshot),coveragePlans=[];
  for(const p of plan._accounts) {
    const legacy=data.fin_account_coverage.find(c=>c.account_slug===p.account_slug && c.coverage_status==='complete' && c.basis_state==='confirmed' && c.superseded_by_id===null);
    const savedIntervals=await rows(env,'SELECT covered_from AS "from",covered_to AS "to" FROM bank_account_coverage_intervals WHERE tenant_id=? AND account_slug=?',op.tenant_id,p.account_slug);
    const intervals=[...savedIntervals,...plan.intervals.filter(i=>i.account_slug===p.account_slug)];
    if(legacy && day(legacy.covered_from) && day(legacy.covered_to))intervals.push({from:legacy.covered_from,to:legacy.covered_to});
    if(intervals.length){const from=intervals.map(i=>i.from).sort()[0],to=intervals.map(i=>i.to).sort().at(-1);
      coveragePlans.push({account_slug:p.account_slug,from,to,contiguous:bankCoverageGaps(from,to,intervals).length===0});}
  }
  const extra=await successorReviews(env,pairs.filter(p=>accountKindIdentity(p.before)!==accountKindIdentity(p.after)),approve,now);
  // The D1 batch, rather than application-side chunks, is the visibility barrier
  // for every SQL reader. Oversized plans remain staged and visibly unresolved.
  if(extra.length+pairs.length*4>65) fail('replacement_atomic_batch_too_large');
  const statements=[revisionGuard(env,op),snapshotGuard(env,op.old_item_ref,plan._snapshot),latch(env,op,1)];
  for(const p of plan._accounts) {
    const pair=pairs.find(a=>a.before.account_slug===p.account_slug);
    statements.push(statement(env,`INSERT INTO plaid_replacement_bindings (tenant_id,operation_ref,account_slug,old_provider_id,new_provider_id,new_account_ref,old_account_json,confirmed_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,operation_ref,account_slug) DO NOTHING`,op.tenant_id,operationRef,p.account_slug,p.old_provider_id,p.provider_id,pair.after.external_ref,JSON.stringify(pair.before),now),
      statement(env,`UPDATE fin_accounts SET source_feed=?,external_ref=? WHERE tenant_id=? AND id=?`,pair.after.source_feed,pair.after.external_ref,op.tenant_id,pair.before.id),
      statement(env,`INSERT INTO plaid_account_entity_assignments (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,item_ref,provider_account_id) DO NOTHING`,op.tenant_id,op.new_item_ref,p.provider_id,pair.after.external_ref,pair.after.entity_slug,now,now,now,now));
  }
  statements.push(...extra,statement(env,`INSERT INTO plaid_replacement_decisions (tenant_id,operation_ref,revision,event_index,action,old_row_id,evidence,pending_observation_row_id)
    SELECT ?1,?2,json_extract(value,'$.event_revision'),json_extract(value,'$.event_index'),json_extract(value,'$.action'),json_extract(value,'$.old_row_id'),json_extract(value,'$.evidence'),json_extract(value,'$.pending_observation_row_id') FROM json_each(?4)`,op.tenant_id,operationRef,op.revision,JSON.stringify(resolved)),
    statement(env,`UPDATE fin_transactions SET removed_at=?,removal_reason='Owner-reviewed replacement occurrence; original evidence kept.'
      WHERE tenant_id=? AND removed_at IS NULL AND id IN (SELECT json_extract(value,'$.old_row_id') FROM json_each(?) WHERE json_extract(value,'$.action') IN ('replace','remove'))`,now,op.tenant_id,JSON.stringify(resolved)),
    // An owner-reviewed replace is the same occurrence. As ordinary sync does on
    // update (plaid-bank-feed.js), the old row's owner-confirmed category and
    // basis survive; otherwise the provider's category is stored as proposed.
    statement(env,`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,raw_sign_convention,currency,
      description,payee,category,category_basis_state,pending,external_id,provenance,source_locator,source_feed,basis_state,recorded_at,pending_transaction_id,source_provider,source_amount_decimal)
      SELECT e.tenant_id,'replacement:'||e.operation_ref||':'||e.provider_id||':'||e.revision,b.account_slug,json_extract(e.payload_json,'$.date'),
      json_extract(e.payload_json,'$.amount'),json_extract(e.payload_json,'$.direction'),
      CASE WHEN json_extract(e.payload_json,'$.direction')='inflow' THEN -json_extract(e.payload_json,'$.amount') ELSE json_extract(e.payload_json,'$.amount') END,
      'feed_positive_amount_is_outflow',json_extract(e.payload_json,'$.currency'),json_extract(e.payload_json,'$.name'),json_extract(e.payload_json,'$.merchant'),
      CASE WHEN o.category_basis_state='confirmed' THEN o.category
        ELSE COALESCE(json_extract(e.payload_json,'$.category_detailed'),json_extract(e.payload_json,'$.category_primary')) END,
      CASE WHEN o.category_basis_state='confirmed' THEN 'confirmed' ELSE 'proposed' END,json_extract(e.payload_json,'$.pending'),e.provider_id,
      'feed','replacement/'||e.operation_ref||'/'||e.revision||CASE WHEN json_extract(e.payload_json,'$.amount_minor_rounded')=1
        THEN '${MINOR_ROUNDED_QUALIFIER}' ELSE '' END,?4,'confirmed',?5,json_extract(e.payload_json,'$.pending_id'),'plaid',json_extract(e.payload_json,'$.decimal')
      FROM plaid_replacement_events e JOIN plaid_replacement_decisions d ON d.tenant_id=e.tenant_id AND d.operation_ref=e.operation_ref AND d.revision=e.revision AND d.event_index=e.event_index
      JOIN plaid_replacement_bindings b ON b.tenant_id=e.tenant_id AND b.operation_ref=e.operation_ref AND b.new_provider_id=e.provider_account_id
      LEFT JOIN fin_transactions o ON o.tenant_id=e.tenant_id AND o.id=d.old_row_id AND d.action='replace'
      WHERE e.tenant_id=?1 AND e.operation_ref=?2 AND EXISTS(SELECT 1 FROM json_each(?3) v WHERE json_extract(v.value,'$.event_revision')=e.revision AND json_extract(v.value,'$.event_index')=e.event_index) AND d.action IN ('admit','replace')`,op.tenant_id,operationRef,JSON.stringify(resolved),source(op.new_item_ref),now),
    statement(env,`INSERT INTO plaid_replacement_aliases (tenant_id,operation_ref,provider_id,account_slug,canonical_row_id,created_at)
      SELECT e.tenant_id,e.operation_ref,e.provider_id,t.account_slug,t.id,?4 FROM plaid_replacement_events e
      JOIN plaid_replacement_decisions d ON d.tenant_id=e.tenant_id AND d.operation_ref=e.operation_ref AND d.revision=e.revision AND d.event_index=e.event_index
      JOIN fin_transactions t ON t.tenant_id=e.tenant_id AND ((d.action IN ('duplicate','remove') AND t.id=COALESCE(d.old_row_id,d.pending_observation_row_id)) OR
        (d.action IN ('admit','replace') AND t.txn_uid='replacement:'||e.operation_ref||':'||e.provider_id||':'||e.revision))
      WHERE e.tenant_id=?1 AND e.operation_ref=?2 AND EXISTS(SELECT 1 FROM json_each(?3) v WHERE json_extract(v.value,'$.event_revision')=e.revision AND json_extract(v.value,'$.event_index')=e.event_index)
      ON CONFLICT(tenant_id,operation_ref,provider_id) DO UPDATE SET canonical_row_id=excluded.canonical_row_id,account_slug=excluded.account_slug`,op.tenant_id,operationRef,JSON.stringify(resolved),now));
  if(plan.intervals.length) statements.push(statement(env,`INSERT INTO bank_account_coverage_intervals
    (tenant_id,account_slug,operation_ref,revision,covered_from,covered_to,evidence,observed_at)
    SELECT ?1,json_extract(value,'$.account_slug'),?2,?3,json_extract(value,'$.from'),json_extract(value,'$.to'),json_extract(value,'$.evidence'),?4 FROM json_each(?5)`,
    op.tenant_id,operationRef,op.revision,now,JSON.stringify(plan.intervals)));
  // Settling an older open item must not replay a balance observation or make
  // a connection appear freshly synced without a new provider page.
  if(op.revision>op.published_revision) {
    const balances=JSON.parse(op.inventory_json).map(n=>({...n,account_slug:plan._accounts.find(p=>p.provider_id===n.id).account_slug}));
    statements.push(statement(env,`INSERT INTO plaid_replacement_balance_evidence
      (tenant_id,operation_ref,revision,balance_id,snapshot_json,recorded_at)
      SELECT ?1,?2,?3,b.id,json_object('id',b.id,'account_slug',b.account_slug,'as_of_date',b.as_of_date,
        'current_minor',b.current_minor,'available_minor',b.available_minor,'currency',b.currency,'source_feed',b.source_feed,
        'source_locator',b.source_locator,'recorded_at',b.recorded_at),?4 FROM fin_balance_snapshots b
      JOIN plaid_replacement_bindings x ON x.tenant_id=b.tenant_id AND x.account_slug=b.account_slug AND x.operation_ref=?2
      JOIN json_each(?5) v ON json_extract(v.value,'$.account_slug')=b.account_slug
      WHERE b.tenant_id=?1 AND b.as_of_date=substr(json_extract(v.value,'$.observed_at'),1,10) AND b.provenance='feed'`,op.tenant_id,operationRef,op.revision,now,JSON.stringify(balances)),
      statement(env,`INSERT INTO fin_balance_snapshots (tenant_id,account_slug,as_of_date,current_minor,available_minor,currency,provenance,source_locator,source_feed,basis_state,recorded_at)
      SELECT ?1,json_extract(value,'$.account_slug'),substr(json_extract(value,'$.observed_at'),1,10),json_extract(value,'$.balance_current'),json_extract(value,'$.balance_available'),
        json_extract(value,'$.currency'),'feed','replacement/'||?3||'/'||?4||COALESCE(json_extract(value,'$.balance_locator_qualifier'),''),?5,'confirmed',json_extract(value,'$.observed_at') FROM json_each(?6) WHERE 1
      ON CONFLICT(tenant_id,account_slug,as_of_date,provenance) DO UPDATE SET current_minor=excluded.current_minor,
        available_minor=excluded.available_minor,currency=excluded.currency,source_feed=excluded.source_feed,
        source_locator=excluded.source_locator,recorded_at=excluded.recorded_at
      WHERE excluded.recorded_at>=fin_balance_snapshots.recorded_at`,op.tenant_id,now,operationRef,op.revision,source(op.new_item_ref),JSON.stringify(balances)));
    statements.push(statement(env,`INSERT INTO plaid_replacement_balance_evidence
      (tenant_id,operation_ref,revision,balance_id,snapshot_json,recorded_at)
      SELECT ?1,?2,?3,-o.id,json_object('kind','obligation','id',o.id,'obligation_uid',o.obligation_uid,
        'account_slug',o.account_slug,'balance_minor',o.balance_minor,'balance_as_of',o.balance_as_of,
        'currency',o.currency,'source_feed',o.source_feed,'recorded_at',o.recorded_at),?4
        FROM fin_obligations o JOIN plaid_replacement_bindings b ON b.tenant_id=o.tenant_id AND b.account_slug=o.account_slug AND b.operation_ref=?2
        WHERE o.tenant_id=?1 AND o.obligation_uid='plaid-obligation:'||o.account_slug AND o.provenance='feed' AND o.superseded_by_id IS NULL`,op.tenant_id,operationRef,op.revision,now),
      statement(env,`UPDATE fin_obligations AS o SET
        balance_minor=(SELECT json_extract(value,'$.balance_current') FROM json_each(?3) WHERE json_extract(value,'$.account_slug')=o.account_slug),
        balance_as_of=(SELECT substr(json_extract(value,'$.observed_at'),1,10) FROM json_each(?3) WHERE json_extract(value,'$.account_slug')=o.account_slug),
        recorded_at=(SELECT json_extract(value,'$.observed_at') FROM json_each(?3) WHERE json_extract(value,'$.account_slug')=o.account_slug),
        source_feed=?4,source_locator='replacement/'||?2||COALESCE((SELECT json_extract(value,'$.balance_locator_qualifier') FROM json_each(?3) WHERE json_extract(value,'$.account_slug')=o.account_slug),'')
        WHERE o.tenant_id=?1 AND o.obligation_uid='plaid-obligation:'||o.account_slug AND o.provenance='feed' AND o.superseded_by_id IS NULL
          AND EXISTS(SELECT 1 FROM json_each(?3) v WHERE json_extract(v.value,'$.account_slug')=o.account_slug
            AND json_extract(v.value,'$.kind') IN ('loan','line_of_credit') AND json_extract(v.value,'$.observed_at')>=o.recorded_at)
          AND NOT EXISTS(SELECT 1 FROM fin_obligations other WHERE other.tenant_id=o.tenant_id AND other.account_slug=o.account_slug
            AND other.superseded_by_id IS NULL AND other.id<>o.id)`,op.tenant_id,operationRef,JSON.stringify(balances),source(op.new_item_ref)));
  }
  if(op.published_revision===0) statements.push(statement(env,`INSERT INTO bank_account_coverage_intervals
    (tenant_id,account_slug,operation_ref,revision,covered_from,covered_to,evidence,observed_at)
    SELECT c.tenant_id,c.account_slug,?2,0,c.covered_from,c.covered_to,'Retained confirmed coverage before replacement.',?3
    FROM fin_account_coverage c JOIN plaid_replacement_bindings b ON b.tenant_id=c.tenant_id AND b.account_slug=c.account_slug AND b.operation_ref=?2
    WHERE c.tenant_id=?1 AND c.coverage_status='complete' AND c.basis_state='confirmed' AND c.superseded_by_id IS NULL
      AND c.covered_from IS NOT NULL AND c.covered_to IS NOT NULL`,op.tenant_id,operationRef,now));
  for(const c of coveragePlans.filter(c=>c.contiguous))statements.push(statement(env,`UPDATE fin_account_coverage SET
    coverage_status='complete',covered_from=?,covered_to=?,source_feed=?,basis_note='Owner-reviewed contiguous replacement intervals; original evidence kept.',
    computed_at=?,recorded_at=? WHERE tenant_id=? AND account_slug=? AND superseded_by_id IS NULL`,c.from,c.to,source(op.new_item_ref),now,now,op.tenant_id,c.account_slug));
  if(op.revision>op.published_revision) {
    // Poll freshness does not assert statement coverage. A quiet window clears
    // retry errors and dates the observation without manufacturing covered days.
    const through=plan.intervals.length && coveragePlans.length===plan._accounts.length && coveragePlans.every(c=>c.contiguous) && op.history_state==='HISTORICAL_UPDATE_COMPLETE'
      ? coveragePlans.map(c=>c.to).sort()[0] : null;
    statements.push(statement(env,`INSERT INTO bank_feed_health (tenant_id,item_ref,last_successful_sync_at,last_attempt_at,data_through)
      VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,item_ref) DO UPDATE SET last_successful_sync_at=excluded.last_successful_sync_at,
        last_attempt_at=excluded.last_attempt_at,data_through=COALESCE(excluded.data_through,bank_feed_health.data_through),
        last_error_code=NULL,last_error_meaning=NULL`,op.tenant_id,op.new_item_ref,plan.sync_completion.observed_at,plan.sync_completion.observed_at,through));
  }
  // Legacy coverage stays conservative. New intervals never fill a hole using
  // earliest/latest transaction dates or a provider historical-complete hint.
  statements.push(statement(env,`INSERT INTO plaid_reconciliation (tenant_id,item_ref,reason,state,due_at,attempts,updated_at)
    VALUES (?,?,'scheduled','complete',?,0,?) ON CONFLICT(tenant_id,item_ref) DO UPDATE SET reason='scheduled',state='complete',due_at=excluded.due_at,updated_at=excluded.updated_at`,
    op.tenant_id,op.new_item_ref,new Date(Date.parse(now)+360*60000).toISOString(),now),
    statement(env,`UPDATE bank_feed_items SET status='removed',removed_at=COALESCE(removed_at,?),status_detail='Replaced, history kept. Old bank permission was not revoked.' WHERE tenant_id=? AND item_ref=?`,now,op.tenant_id,op.old_item_ref),
    ...(op.revision>op.published_revision ? [statement(env,`UPDATE bank_feed_items SET status='connected',status_detail='Replacement active; reviewed history kept. Coverage gaps remain visible.',institution_ref=(SELECT institution_ref FROM bank_feed_items WHERE tenant_id=?6 AND item_ref=?7),institution_label=(SELECT institution_label FROM bank_feed_items WHERE tenant_id=?6 AND item_ref=?7),cursor=?1,cursor_updated_at=?2,last_synced_at=?3 WHERE tenant_id=?4 AND item_ref=?5`,op.cursor,now,plan.sync_completion.observed_at,op.tenant_id,op.new_item_ref,op.tenant_id,op.old_item_ref)] : [statement(env,"UPDATE bank_feed_items SET status='connected',removed_at=NULL,status_detail='Replacement active; retained review choices saved. Sync time unchanged.' WHERE tenant_id=? AND item_ref=?",op.tenant_id,op.new_item_ref)]),
    ...bankActivityInvalidationStatements(env,{at:now}),
    statement(env,`UPDATE plaid_item_replacements SET state='active',published_revision=revision,pages=0,review_hash=?,review_snapshot=?,updated_at=? WHERE tenant_id=? AND operation_ref=?`,approve,plan._snapshot,now,op.tenant_id,operationRef),
    latch(env,op,0),audit(env,op,'atomic_handover_history_kept',now));
  await env.DB.batch(statements);
  const readback=await operation(env,operationRef);
  if(readback.state!=='active' || readback.review_hash!==approve || readback.published_revision!==op.revision) fail('replacement_activation_readback_unavailable');
  return replacementStatus(env,{operationRef});
}

export async function replacementStatus(env,{operationRef}={}) {
  const op=await operation(env,operationRef);
  const count=await one(env,'SELECT COUNT(*) AS n FROM plaid_replacement_events WHERE tenant_id=? AND operation_ref=? AND revision>?',op.tenant_id,operationRef,op.published_revision);
  const bindings=await rows(env,'SELECT account_slug,new_provider_id FROM plaid_replacement_bindings WHERE tenant_id=? AND operation_ref=?',op.tenant_id,operationRef);
  const review=['active','history_review','rolled_back'].includes(op.state) ? await reviewReplacement(env,{operationRef,mappings:bindings.map(b=>({account_slug:b.account_slug,provider_id:b.new_provider_id,confirm:true})),now:op.updated_at}) : null;
  const open=review?.decisions.filter(d=>d.action==='review') || [];
  const completion=review?.sync_completion || syncCompletion(op,await pollPages(env,op),bindings.map(b=>({account_slug:b.account_slug,provider_id:b.new_provider_id})));
  return {operation_ref:operationRef,state:op.state,revision:op.revision,published_revision:op.published_revision,
    open_review_count:open.length,open_review_items:open,sync_completion:completion,
    staged_events:count.n,can_resume_review:op.state==='rolled_back' && (count.n>0 || open.length>0),history_kept:true,revoked_at_provider:false,
    detail:op.state==='active' ? 'Replacement is active. Sync can continue. '+open.length+' saved activity items need review; their affected periods remain provisional. Compare those occurrences with your statement. Old bank permission was not revoked.' :
      op.state==='rolled_back' ? 'Accounts point to the old connection. Saved facts and unresolved activity are kept. Review retained activity, then explicitly resume and confirm a handover if you choose to use the replacement again.' :
      op.state==='outcome_unknown' || op.state==='exchange_claimed' ? 'The bank sign-in result is uncertain. Resume this same recovery; do not start another sign-in.' :
      'Saved history is kept. Continue this recovery to review accounts and overlapping activity.'};
}
export async function rollbackReplacement(env,{operationRef,approve=null,now}={}) {
  now=stamp(now); const op=await operation(env,operationRef);
  await requireCurrentReplacement(env,op);
  if(!['active','history_review','candidate_staged','rolled_back'].includes(op.state) || op.published_revision<1) fail('replacement_rollback_not_active');
  if(op.state==='rolled_back') return replacementStatus(env,{operationRef});
  const saved=await snapshot(env,op.old_item_ref),bindings=await rows(env,'SELECT * FROM plaid_replacement_bindings WHERE tenant_id=? AND operation_ref=? ORDER BY account_slug',op.tenant_id,operationRef);
  const hash=await custodyDigest(['rollback-v1',operationRef,op.revision,saved,bindings]);
  if(approve===null) return {plan_hash:hash,history_kept:true,detail:'Point these accounts back to their old connection. Newly saved facts remain available. The old access is still unreadable and may not fetch new activity.'};
  if(approve!==hash) fail('replacement_rollback_stale');
  const pairs=[];
  for(const binding of bindings) {
    const before=await one(env,'SELECT * FROM fin_accounts WHERE tenant_id=? AND account_slug=? AND superseded_by_id IS NULL',op.tenant_id,binding.account_slug);
    const original=JSON.parse(binding.old_account_json);
    if(!before || before.entity_slug!==original.entity_slug) fail('replacement_rollback_assignment_changed');
    pairs.push({before,after:{...before,source_feed:original.source_feed,external_ref:original.external_ref}});
  }
  const reviews=await successorReviews(env,pairs,hash,now);
  if(reviews.length+pairs.length>65) fail('replacement_atomic_batch_too_large');
  await env.DB.batch([revisionGuard(env,op),snapshotGuard(env,op.old_item_ref,saved),latch(env,op,1),
    ...pairs.map(p=>statement(env,'UPDATE fin_accounts SET source_feed=?,external_ref=? WHERE tenant_id=? AND id=?',p.after.source_feed,p.after.external_ref,op.tenant_id,p.before.id)),...reviews,
    statement(env,"UPDATE bank_feed_items SET status='error',removed_at=NULL,status_detail='Replacement rolled back. Saved access still needs recovery.' WHERE tenant_id=? AND item_ref=?",op.tenant_id,op.old_item_ref),
    statement(env,"UPDATE bank_feed_items SET status='removed',removed_at=?,status_detail='Replacement rolled back, history kept.' WHERE tenant_id=? AND item_ref=?",now,op.tenant_id,op.new_item_ref),
    ...bankActivityInvalidationStatements(env,{at:now}),
    statement(env,"UPDATE plaid_item_replacements SET state='rolled_back',updated_at=? WHERE tenant_id=? AND operation_ref=?",now,op.tenant_id,operationRef),latch(env,op,0),audit(env,op,'rollback_history_kept',now)]);
  return replacementStatus(env,{operationRef});
}
export async function resumeReplacement(env,{operationRef,approve=null,now}={}) {
  now=stamp(now);const op=await operation(env,operationRef);
  await requireCurrentReplacement(env,op);
  const count=await one(env,'SELECT COUNT(*) n FROM plaid_replacement_events e WHERE tenant_id=? AND operation_ref=? AND NOT EXISTS(SELECT 1 FROM plaid_replacement_decisions d WHERE d.tenant_id=e.tenant_id AND d.operation_ref=e.operation_ref AND d.revision=e.revision AND d.event_index=e.event_index)',op.tenant_id,operationRef);
  if(op.state!=='rolled_back' || !count.n) fail('replacement_resume_not_ready');
  const saved=await snapshot(env,op.old_item_ref);
  const hash=await custodyDigest(['resume-rollback-review-v1',operationRef,op.revision,saved]);
  const detail='Resume review of retained activity. Accounts still point to the old connection and no new facts are published. A separate confirmed handover will use the replacement connection again.';
  if(approve===null)return {plan_hash:hash,history_kept:true,detail};
  if(approve!==hash)fail('replacement_resume_stale');
  const pages=await pollPages(env,op);
  // Rollback does not turn a partial provider window into a terminal one.
  // Resume its cursor walk before offering publication of the retained rows.
  const state=pages.at(-1)?.has_more ? 'candidate_staged' : 'history_review';
  // Reopen quarantine, never the account pointer. Normal review and its fresh
  // snapshot-bound handover remain mandatory after this separate owner choice.
  await env.DB.batch([revisionGuard(env,op),snapshotGuard(env,op.old_item_ref,saved),latch(env,op,1),
    statement(env,"UPDATE bank_feed_items SET status='error',removed_at=NULL,status_detail='Retained replacement activity needs review before a new handover.' WHERE tenant_id=? AND item_ref=?",op.tenant_id,op.new_item_ref),
    statement(env,"UPDATE plaid_item_replacements SET state=?,updated_at=? WHERE tenant_id=? AND operation_ref=?",state,now,op.tenant_id,operationRef),
    latch(env,op,0),audit(env,op,'rollback_review_resumed_history_kept',now)]);
  return replacementStatus(env,{operationRef});
}
export async function cancelReplacement(env,{operationRef,now}={}) {
  now=stamp(now); const op=await operation(env,operationRef);
  if(op.new_item_ref || !['owner_approved','link_pending'].includes(op.state)) fail('replacement_cancel_needs_custody_review');
  await env.DB.batch([revisionGuard(env,op),statement(env,"UPDATE plaid_item_replacements SET state='cancelled',updated_at=? WHERE tenant_id=? AND operation_ref=?",now,op.tenant_id,operationRef),audit(env,op,'cancelled_before_exchange',now)]);
  return replacementStatus(env,{operationRef});
}
