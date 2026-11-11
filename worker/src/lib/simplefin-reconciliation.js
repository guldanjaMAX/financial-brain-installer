import { SIMPLEFIN_POSTED_HISTORY_REVISION } from './bank-feed-profiles.js';

// Exact listing transitions propose replacements; SimpleFIN's subset contract
// cannot prove them. Never collapse co-present or indistinguishable purchases.
const protectedSql = `t.category_basis_state='confirmed'
  OR EXISTS(SELECT 1 FROM fin_exceptions e WHERE e.tenant_id=t.tenant_id AND e.txn_uid=t.txn_uid)
  OR EXISTS(SELECT 1 FROM fin_reconciliation_claims c WHERE c.tenant_id=t.tenant_id
    AND c.claim_ref_table='fin_transactions' AND c.claim_ref_uid=t.txn_uid)
  OR EXISTS(SELECT 1 FROM fin_reconciliations r WHERE r.tenant_id=t.tenant_id AND r.account_slug=t.account_slug)
  OR EXISTS(SELECT 1 FROM fin_period_closes p JOIN fin_accounts a
    ON a.tenant_id=p.tenant_id AND a.entity_slug=p.entity_slug AND a.superseded_by_id IS NULL
    WHERE a.tenant_id=t.tenant_id AND a.account_slug=t.account_slug)`;
const inventorySql = `SELECT json_group_array(json_object('id',t.id,'txn_uid',t.txn_uid,'external_id',t.external_id,
  'posted_on',t.posted_on,'raw_amount_minor',t.raw_amount_minor,'amount_minor',t.amount_minor,
  'direction',t.direction,'currency',t.currency,'description',t.description,'payee',t.payee,
  'pending',t.pending,'basis_state',t.basis_state,'removed_at',t.removed_at,'removal_reason',t.removal_reason,
  'superseded_by_id',t.superseded_by_id,'protected',(${protectedSql})))
  FROM (SELECT * FROM fin_transactions WHERE tenant_id=?1 AND account_slug=?2
    AND source_provider='simplefin' AND source_feed=?3 ORDER BY id LIMIT 10001) t`;
export async function simpleFinTransactionInventory(env, { tenantId, accountSlug, sourceFeed }) {
  const snapshot = await env.DB.prepare(inventorySql).bind(tenantId,accountSlug,sourceFeed).first();
  if (!snapshot || typeof Object.values(snapshot)[0] !== 'string') throw Error('SimpleFIN reconciliation inventory unavailable');
  const json = Object.values(snapshot)[0], rows = JSON.parse(json);
  if (rows.length > 10000) throw Error('SimpleFIN reconciliation inventory limit');
  return { json, rows, tenantId, accountSlug, sourceFeed };
}
const guard = (env, inventory) => env.DB.prepare(`SELECT CASE WHEN (${inventorySql})=?4
  THEN 1 ELSE json_extract('simplefin reconciliation snapshot changed','$') END AS verified`)
  .bind(inventory.tenantId,inventory.accountSlug,inventory.sourceFeed,inventory.json);

// The intent and affected-date revocations commit together before import. The
// immutable inventory also survives response loss immediately before lineage.
export async function simpleFinPromotionIntent(env, { inventory, current, accountRef, window, stamp }) {
  const binds = [inventory.tenantId,window.item_ref,accountRef,window.window_start,window.window_end,window.revision];
  const sql = `SELECT before_json FROM simplefin_promotion_intents
    WHERE tenant_id=? AND item_ref=? AND account_ref=? AND window_start=? AND window_end=? AND revision=?`;
  const prior = await env.DB.prepare(sql).bind(...binds).first();
  const before = prior ? { ...inventory,json:prior.before_json,rows:JSON.parse(prior.before_json) } : inventory;
  const changedDays = new Set();
  const liveBefore = new Map(before.rows.filter(row => row.superseded_by_id === null).map(row => [row.external_id,row]));
  for (const row of current) {
    const old = liveBefore.get(row.externalId);
    const expected = [row.postedOn,row.rawAmountMinor,row.amountMinor,row.direction,row.currency,
      row.description || null,row.payee || null,row.pending ? 1 : 0,row.unparsedReason ? 'unparsed' : 'confirmed'];
    const actual = old && [old.posted_on,old.raw_amount_minor,old.amount_minor,old.direction,old.currency,
      old.description,old.payee,old.pending,old.basis_state];
    if (JSON.stringify(expected) === JSON.stringify(actual)) continue;
    if (old) changedDays.add(old.posted_on);
    changedDays.add(row.postedOn);
  }
  return { before, statements: [
    guard(env,inventory),
    env.DB.prepare(`INSERT INTO simplefin_promotion_intents
      (tenant_id,item_ref,account_ref,window_start,window_end,revision,before_json,recorded_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(...binds,before.json,stamp),
    env.DB.prepare(`SELECT CASE WHEN (${sql})=?7 THEN 1
      ELSE json_extract('simplefin promotion intent changed','$') END AS verified`).bind(...binds,before.json),
    env.DB.prepare(`UPDATE simplefin_coverage_reviews SET revoked_at=? WHERE tenant_id=? AND account_ref=? AND revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(?) day WHERE day.value IS NULL OR day.value BETWEEN covered_from AND covered_to)`)
      .bind(stamp,inventory.tenantId,accountRef,JSON.stringify([...changedDays])),
  ] };
}

// Restore a predecessor before importing a reappearing provider ID. Otherwise
// the importer's live-only uniqueness index would create a third source row.
export async function simpleFinRestoreStatements(env, inventory, currentIds, stamp,
  { current = [], window, complete = false } = {}) {
  const { results } = await env.DB.prepare(`SELECT l.predecessor_id,l.successor_id,t.external_id
    FROM simplefin_transaction_lineage l JOIN fin_transactions t ON t.id=l.predecessor_id AND t.tenant_id=l.tenant_id
    WHERE l.tenant_id=? AND t.account_slug=? AND l.revoked_at IS NULL`)
    .bind(inventory.tenantId,inventory.accountSlug).all();
  const restore = results.filter(r => currentIds.has(r.external_id));
  const pairs = JSON.stringify(restore.map(row => [row.predecessor_id,row.successor_id]));
  // Schema59 could withdraw a source ID before lineage existed. A subset's
  // omission cannot renew that decision, but exact readable posted evidence
  // can undo this one legacy reason. Owner evidence and every other reason
  // remain authoritative. The caller commits this guard behind its revision
  // fence, so neither a late response nor a changed disposition may restore it.
  const readableIds = new Set(complete && window?.revision.startsWith(SIMPLEFIN_POSTED_HISTORY_REVISION)
    ? current.filter(row => !row.unparsedReason && !row.pending && row.postedOn >= window.window_start &&
      row.postedOn <= window.window_end).map(row => row.externalId) : []);
  const legacy = inventory.rows.filter(row => row.removed_at !== null && row.superseded_by_id === null &&
    row.removal_reason === 'Absent from verified SimpleFIN posted history' && readableIds.has(row.external_id));
  // Set-based writes keep the inventory guard and the whole restoration in one
  // bounded transaction. Slicing this list would invalidate its original guard.
  const statements = restore.length ? [
    env.DB.prepare(`UPDATE fin_transactions SET superseded_by_id=NULL
      WHERE tenant_id=? AND (id,superseded_by_id) IN
        (SELECT json_extract(p.value,'$[0]'),json_extract(p.value,'$[1]') FROM json_each(?) p)`)
      .bind(inventory.tenantId,pairs),
    env.DB.prepare(`UPDATE simplefin_transaction_lineage SET revoked_at=?
      WHERE tenant_id=? AND revoked_at IS NULL AND (predecessor_id,successor_id) IN
        (SELECT json_extract(p.value,'$[0]'),json_extract(p.value,'$[1]') FROM json_each(?) p)`)
      .bind(stamp,inventory.tenantId,pairs),
  ] : [];
  if (legacy.length) statements.push(env.DB.prepare(`UPDATE fin_transactions SET removed_at=NULL,removal_reason=NULL
    WHERE tenant_id=? AND account_slug=? AND source_provider='simplefin' AND source_feed=?
      AND id IN (SELECT value FROM json_each(?)) AND superseded_by_id IS NULL
      AND removal_reason='Absent from verified SimpleFIN posted history'`)
    .bind(inventory.tenantId,inventory.accountSlug,inventory.sourceFeed,JSON.stringify(legacy.map(row => row.id))));
  return statements.length ? [guard(env,inventory), ...statements] : [];
}
const shape = row => JSON.stringify([row.postedOn,row.rawAmountMinor,row.currency,row.description || null,row.payee || null]);
const ledgerShape = row => shape({ postedOn:row.posted_on,rawAmountMinor:row.raw_amount_minor,
  currency:row.currency,description:row.description,payee:row.payee });
const groups = (rows,key) => {
  const map = new Map();
  for (const row of rows) { const k=key(row); if (!map.has(k)) map.set(k,[]); map.get(k).push(row); }
  return map;
};
export async function simpleFinReconciliationPlan(env, { before, current, tenantId, itemRef, accountRef,
  window, stamp, complete }) {
  // Here complete means all staging rows are readable and published. It never
  // grants history coverage or authorizes the proposed supersession.
  if (!complete) return { statements: [], ambiguous: false };
  const after = await simpleFinTransactionInventory(env,before);
  const currentIds = new Set(current.map(r => r.externalId));
  const previousIds = new Set(before.rows.filter(r => r.superseded_by_id === null).map(r => r.external_id));
  const missing = after.rows.filter(r => r.superseded_by_id === null && !currentIds.has(r.external_id) &&
    r.posted_on >= window.window_start && r.posted_on <= window.window_end);
  const oldGroups = groups(missing,ledgerShape), currentGroups = groups(current,shape);
  const statements = [], pairs = [];
  let ambiguous = false;
  for (const [key, old] of oldGroups) {
    const replacements = currentGroups.get(key) || [];
    if (!replacements.length) { ambiguous = true; continue; }
    const replacement = replacements[0];
    const next = after.rows.find(r => r.external_id === replacement.externalId && r.superseded_by_id === null);
    if (old.length !== 1 || replacements.length !== 1 ||
        old[0].protected || next?.protected || !next || old[0].removed_at || next.removed_at ||
        old[0].basis_state !== 'confirmed' || next.basis_state !== 'confirmed' || old[0].pending || next.pending) {
      ambiguous = true; continue;
    }
    // Exact occurrence metadata, including nulls, is an additional requirement.
    // Staging retains the absent ID from the preceding response revision.
    const prior = await env.DB.prepare(`SELECT posted_epoch,transacted_epoch,amount_decimal,description,payee,memo
      FROM simplefin_stage_transactions WHERE tenant_id=? AND item_ref=? AND provider_account_id=?
        AND provider_transaction_id=? ORDER BY window_end DESC LIMIT 1`)
      .bind(tenantId,itemRef,window.provider_account_id,old[0].external_id).first();
    const source = replacement.source;
    if (!prior || prior.posted_epoch !== source.posted_epoch || prior.transacted_epoch !== source.transacted_epoch ||
        prior.description !== source.description || prior.payee !== source.payee || prior.memo !== source.memo) {
      ambiguous = true; continue;
    }
    if (previousIds.has(replacement.externalId)) {
      const existing = await env.DB.prepare(`SELECT 1 AS present FROM simplefin_transaction_lineage
        WHERE tenant_id=? AND predecessor_id=? AND successor_id=? AND revoked_at IS NULL AND reviewed_at IS NULL`)
        .bind(tenantId,old[0].id,next.id).first();
      if (!existing) { ambiguous = true; continue; }
    }
    pairs.push([old[0],next]);
  }
  if (pairs.length) {
    statements.push(guard(env,after));
    // The listing proof is one receipt tuple. A new revision belongs to its
    // own item and window; mixing it with old bounds makes review impossible.
    statements.push(
      env.DB.prepare(`INSERT INTO simplefin_transaction_lineage
        (tenant_id,account_ref,predecessor_id,successor_id,item_ref,window_start,window_end,revision,recorded_at,revoked_at)
        SELECT ?,?,json_extract(p.value,'$[0]'),json_extract(p.value,'$[1]'),?,?,?,?,?,NULL
        FROM json_each(?) p WHERE 1
        ON CONFLICT(tenant_id,predecessor_id,successor_id) DO UPDATE SET
          account_ref=excluded.account_ref,item_ref=excluded.item_ref,
          window_start=excluded.window_start,window_end=excluded.window_end,
          revision=excluded.revision,recorded_at=excluded.recorded_at,revoked_at=NULL`)
        .bind(tenantId,accountRef,itemRef,window.window_start,window.window_end,window.revision,stamp,
          JSON.stringify(pairs.map(([old,next]) => [old.id,next.id]))),
    );
  }
  return { statements, ambiguous: ambiguous || pairs.length>0 };
}


// This is deliberately an owner decision. SimpleFIN supplies a subset and no
// predecessor reference; disappearance plus exact shape proposes, never proves.
export async function reviewSimpleFinReplacement(env, { tenantId = env.BANK_FEED_TENANT || 'primary',
  accountRef, predecessorId, successorId, dryRun = true, approve, confirmSameEvent = false,
  now = new Date().toISOString() } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenantId) || !/^sfa_[a-f0-9]{32}$/.test(accountRef || '') ||
      !Number.isSafeInteger(predecessorId) || !Number.isSafeInteger(successorId) || predecessorId<1 || successorId<1 ||
      predecessorId === successorId || typeof dryRun !== 'boolean' || !Number.isFinite(Date.parse(now)))
    throw Error('Invalid SimpleFIN replacement scope');
  const scope = await env.DB.prepare(`SELECT a.account_slug,a.source_feed FROM fin_accounts a
    JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
      AND e.superseded_by_id IS NULL AND e.relationship='owned' AND e.basis_state='confirmed'
    WHERE a.tenant_id=? AND a.external_ref=? AND a.superseded_by_id IS NULL`).bind(tenantId,accountRef).first();
  if (!scope) throw Error('SimpleFIN replacement account unavailable');
  const inventory = await simpleFinTransactionInventory(env,{tenantId,accountSlug:scope.account_slug,sourceFeed:scope.source_feed});
  const candidateSql = `SELECT json_object('item_ref',l.item_ref,'window_start',l.window_start,'window_end',l.window_end,
    'revision',l.revision,'reviewed_at',l.reviewed_at,'review_plan_hash',l.review_plan_hash,'revoked_at',l.revoked_at,
    'current',w.revision=l.revision AND w.revision=w.staging_revision AND w.state='promoted' AND w.errlist_json='[]',
    'old_present',EXISTS(SELECT 1 FROM simplefin_stage_transactions st JOIN simplefin_account_assignments a
      ON a.tenant_id=st.tenant_id AND a.item_ref=st.item_ref AND a.provider_account_id=st.provider_account_id
      WHERE st.tenant_id=l.tenant_id AND a.account_ref=l.account_ref AND st.item_ref=l.item_ref
        AND st.window_start=l.window_start AND st.window_end=l.window_end AND st.revision=l.revision
        AND st.provider_transaction_id=(SELECT external_id FROM fin_transactions WHERE tenant_id=l.tenant_id AND id=l.predecessor_id)),
    'new_present',EXISTS(SELECT 1 FROM simplefin_stage_transactions st JOIN simplefin_account_assignments a
      ON a.tenant_id=st.tenant_id AND a.item_ref=st.item_ref AND a.provider_account_id=st.provider_account_id
      WHERE st.tenant_id=l.tenant_id AND a.account_ref=l.account_ref AND st.item_ref=l.item_ref
        AND st.window_start=l.window_start AND st.window_end=l.window_end AND st.revision=l.revision
        AND st.provider_transaction_id=(SELECT external_id FROM fin_transactions WHERE tenant_id=l.tenant_id AND id=l.successor_id))) AS snapshot
    FROM simplefin_transaction_lineage l JOIN simplefin_sync_windows w ON w.tenant_id=l.tenant_id AND w.item_ref=l.item_ref
      AND w.window_start=l.window_start AND w.window_end=l.window_end
    WHERE l.tenant_id=?1 AND l.account_ref=?2 AND l.predecessor_id=?3 AND l.successor_id=?4`;
  const record = await env.DB.prepare(candidateSql).bind(tenantId,accountRef,predecessorId,successorId).first();
  if (!record?.snapshot) throw Error('No exact SimpleFIN replacement proposal');
  const candidate = JSON.parse(record.snapshot), old=inventory.rows.find(r => r.id===predecessorId), next=inventory.rows.find(r => r.id===successorId);
  const desired = old?.superseded_by_id===successorId && candidate.reviewed_at !== null && candidate.revoked_at === null;
  const blocked = !old || !next || !candidate.current || candidate.old_present || !candidate.new_present || candidate.revoked_at !== null ||
    old.protected || next.protected || old.removed_at || next.removed_at || next.superseded_by_id !== null ||
    old.superseded_by_id !== null && !desired || old.basis_state !== 'confirmed' || next.basis_state !== 'confirmed' ||
    ledgerShape(old)!==ledgerShape(next);
  const planHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(
    JSON.stringify(['simplefin-replacement-v1',tenantId,accountRef,predecessorId,successorId,inventory.json,record.snapshot]))))]
    .map(n => n.toString(16).padStart(2,'0')).join('');
  const receipt = { dry_run:dryRun,blocked:Boolean(blocked),complete:!blocked && desired,plan_hash:planHash,
    predecessor_id:predecessorId,successor_id:successorId,mutation_count:0,source_comparison_required:true };
  if (dryRun) return receipt;
  if (blocked || confirmSameEvent !== true || approve!==planHash && !(desired && approve===candidate.review_plan_hash))
    throw Error('Compare both bank references, then approve the exact current replacement preview');
  if (desired) return receipt;
  const stamp = new Date(now).toISOString();
  const result = await env.DB.batch([
    guard(env,inventory),
    env.DB.prepare(`SELECT CASE WHEN (${candidateSql.replace(' AS snapshot','')})=?5 THEN 1
      ELSE json_extract('simplefin replacement proposal changed','$') END AS verified`)
      .bind(tenantId,accountRef,predecessorId,successorId,record.snapshot),
    env.DB.prepare(`UPDATE simplefin_transaction_lineage SET reviewed_at=?,review_plan_hash=?
      WHERE tenant_id=? AND predecessor_id=? AND successor_id=? AND revoked_at IS NULL AND reviewed_at IS NULL`)
      .bind(stamp,planHash,tenantId,predecessorId,successorId),
    env.DB.prepare(`UPDATE fin_transactions SET superseded_by_id=? WHERE tenant_id=? AND id=? AND superseded_by_id IS NULL`)
      .bind(successorId,tenantId,predecessorId),
    env.DB.prepare(`UPDATE simplefin_coverage_reviews SET revoked_at=? WHERE tenant_id=? AND account_ref=? AND revoked_at IS NULL`)
      .bind(stamp,tenantId,accountRef),
    env.DB.prepare(`UPDATE fin_account_coverage SET coverage_status='partial',basis_note='Replacement reviewed; compare the bounded bank history again.'
      WHERE tenant_id=? AND account_slug=? AND superseded_by_id IS NULL`).bind(tenantId,scope.account_slug),
    env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM fin_transactions t JOIN simplefin_transaction_lineage l
      ON l.tenant_id=t.tenant_id AND l.predecessor_id=t.id AND l.successor_id=t.superseded_by_id
      WHERE t.tenant_id=? AND t.id=? AND t.superseded_by_id=? AND l.review_plan_hash=? AND l.reviewed_at=?)
      THEN 1 ELSE json_extract('simplefin replacement readback failed','$') END AS verified`)
      .bind(tenantId,predecessorId,successorId,planHash,stamp),
  ]);
  if (result.at(-1)?.results?.[0]?.verified !== 1) throw Error('SimpleFIN replacement readback unavailable');
  return { ...receipt,complete:true,mutation_count:1 };
}
