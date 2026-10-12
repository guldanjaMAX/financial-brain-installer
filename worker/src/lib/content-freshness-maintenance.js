import { contentFreshness } from './content-freshness.js';
import { jsonResponse } from './core.js';
import { backendOf } from './store.js';

export const CONTENT_REFRESH_PATH = '/api/admin/brain/content/refresh-dates';
const HASH = /^[a-f0-9]{64}$/;
const MARKER_SQL = 'SELECT instance,nonce,generation FROM ingest_removal_generation WHERE id=1';
const MESSAGES = {
  content_dates_d1_required: 'Content-date repair requires the D1 document store. Ask your installer to review storage before continuing.',
  content_dates_approval_required: 'Preview the page, then apply with its exact approval hash.',
  content_dates_stale: 'This content-date approval is stale. Preview the same cursor again before applying.',
  content_dates_blocked: 'This page contains a document over 500 chunks. Ask your installer to review it. No page changes were made.',
  content_dates_queue_budget: 'The vector queue exceeds the queue budget, or this page would exceed it. Wait for indexing to finish, then preview again. Use a smaller page if needed.',
  content_dates_unavailable: 'Content-date repair could not be verified. Ask your installer to check the database upgrade, then preview again.',
};
function refuse(code) { throw Object.assign(new Error(MESSAGES[code]), { code }); }
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value))))).map(b => b.toString(16).padStart(2, '0')).join('');

async function marker(env) {
  const row = await env.DB.prepare(MARKER_SQL).first();
  if (!row || !/^[a-f0-9]{32}$/.test(row.instance) || !/^[a-f0-9]{32}$/.test(row.nonce) ||
      !Number.isSafeInteger(row.generation) || row.generation < 0) refuse('content_dates_unavailable');
  return [row.instance, row.nonce, row.generation];
}
async function queueDepth(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM vector_outbox').first();
  if (!Number.isSafeInteger(row?.n) || row.n < 0) refuse('content_dates_unavailable');
  return row.n;
}
const QUEUE_SIZE_SQL = `(SELECT COUNT(*) FROM vector_outbox) + (SELECT COUNT(*) FROM chunks c
  WHERE c.doc_uid IN (SELECT value FROM json_each(?1))
    AND NOT EXISTS (SELECT 1 FROM vector_outbox o WHERE o.chunk_uid=c.chunk_uid))`;
async function checkQueue(env, ids, budget) {
  const row = await env.DB.prepare(`SELECT ${QUEUE_SIZE_SQL} AS n`).bind(ids).first();
  if (!Number.isSafeInteger(row?.n) || row.n < 0) refuse('content_dates_unavailable');
  if (row.n > budget) refuse('content_dates_queue_budget');
}

/** Read-only planning; one atomic approved page, including its replay receipt.
 * Schema 52's corpus marker covers metadata, text, membership and chunk edits.
 * It is bracketed around planning and checked again INSIDE the write batch.
 * No cron, provider calls, deletions, or partial-page commits belong here.
 */
export async function refreshContentDates(env, {
  after = 0, limit, dryRun = true, approve, queueBudget = 500, now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(after) || after < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)) ||
      typeof dryRun !== 'boolean' || !Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(queueBudget) || queueBudget < 0 || queueBudget > 10000) throw new TypeError('invalid freshness maintenance page');
  if ((!dryRun && (typeof approve !== 'string' || !HASH.test(approve))) || (dryRun && approve !== undefined)) {
    refuse('content_dates_approval_required');
  }
  if (!dryRun) {
    const saved = await env.DB.prepare('SELECT start_cursor,receipt FROM content_date_refresh_receipts WHERE plan_hash=?1').bind(approve).first();
    if (saved) {
      const receipt = JSON.parse(saved.receipt);
      if (saved.start_cursor !== after || (limit !== undefined && limit !== receipt.limit)) refuse('content_dates_stale');
      // Historical acknowledgement only: never repeat writes, even if indexing
      // has since drained or later ingest changed the repaired documents.
      return { ...receipt, updated: 0, chunks_requeued: 0, replayed: true, queue_depth: await queueDepth(env) };
    }
  }
  const opening = await marker(env);
  const readLimit = limit ?? 10;
  const page = (await env.DB.prepare(`SELECT rowid AS cursor, doc_uid, title, document_date,
    date_source, date_reliable FROM documents WHERE rowid > ?1 AND deleted_at IS NULL
      AND (date_source IS NULL OR date_source IN ('','none','filename','path','content'))
    ORDER BY rowid LIMIT ?2`).bind(after, readLimit + 1).all()).results;
  if (!Array.isArray(page)) refuse('content_dates_unavailable');
  const inventory = [];
  for (const doc of page.slice(0, readLimit)) {
    const chunks = (await env.DB.prepare(`SELECT text,document_date FROM chunks WHERE doc_uid=?1
      ORDER BY chunk_ix LIMIT 501`).bind(doc.doc_uid).all()).results;
    if (!Array.isArray(chunks)) refuse('content_dates_unavailable');
    const blocked = chunks.length > 500;
    const fresh = blocked ? null : contentFreshness({ title: doc.title, content: chunks.map(c => c.text).join('\n'),
      date: doc.document_date, dateSource: doc.date_source });
    const change = !!fresh && (fresh.value !== doc.document_date || doc.date_source !== 'content' ||
      doc.date_reliable !== 1 || chunks.some(c => c.document_date !== fresh.value));
    inventory.push({ cursor: doc.cursor, uid: doc.doc_uid, blocked, change, date: fresh?.value, chunks: chunks.length });
  }
  if (JSON.stringify(opening) !== JSON.stringify(await marker(env))) refuse('content_dates_stale');
  const depth = await queueDepth(env);
  async function plan(size) {
    const rows = inventory.slice(0, size), changes = rows.filter(row => row.change);
    const blocked = rows.filter(row => row.blocked).length;
    const cursor = blocked ? after : (rows.at(-1)?.cursor ?? after);
    const hash = await digest(['content-dates-v1', opening, after, size, rows, page.length > size]);
    return { rows, changes, receipt: { dry_run: dryRun, documents: rows.length, planned: changes.length,
      chunks: changes.reduce((sum, row) => sum + row.chunks, 0), blocked_documents: blocked,
      queue_depth: depth, plan_hash: hash, limit: size, cursor, next_cursor: String(cursor),
      complete: !blocked && page.length <= size, updated: 0, chunks_requeued: 0, replayed: false } };
  }
  let selected = await plan(readLimit);
  if (dryRun) return selected.receipt;
  // The public apply syntax needs only the hash and original cursor. At most
  // ten read-only prefix hashes recover a custom preview limit, without saving
  // previews or silently applying a default-sized page instead.
  if (limit === undefined && selected.receipt.plan_hash !== approve) {
    for (let size = 1; size < 10; size++) {
      const candidate = await plan(size);
      if (candidate.receipt.plan_hash === approve) { selected = candidate; break; }
    }
  }
  const { changes, receipt } = selected;
  if (receipt.plan_hash !== approve) refuse('content_dates_stale');
  if (receipt.blocked_documents) refuse('content_dates_blocked');
  const ids = JSON.stringify(changes.map(row => row.uid));
  await checkQueue(env, ids, queueBudget);
  const statements = [
    env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM ingest_removal_generation
      WHERE id=1 AND instance=?1 AND nonce=?2 AND generation=?3) THEN 1
      ELSE json_extract('content date revision changed','$') END AS verified`).bind(...opening),
    env.DB.prepare(`SELECT CASE WHEN ${QUEUE_SIZE_SQL} <= ?2 THEN 1
      ELSE json_extract('content date queue budget exceeded','$') END AS verified`).bind(ids, queueBudget),
  ];
  for (const row of changes) {
    statements.push(
      env.DB.prepare('UPDATE chunks SET document_date=?2 WHERE doc_uid=?1').bind(row.uid, row.date),
      env.DB.prepare(`INSERT INTO vector_outbox(chunk_uid,vector_id,op,queued_at,attempts,last_error)
        SELECT chunk_uid,COALESCE(vector_id,chunk_uid),'upsert',?2,0,NULL FROM chunks WHERE doc_uid=?1
        ON CONFLICT(chunk_uid) DO UPDATE SET vector_id=excluded.vector_id,op='upsert',
          queued_at=excluded.queued_at,attempts=0,last_error=NULL`).bind(row.uid, now),
      env.DB.prepare("UPDATE documents SET document_date=?2,date_source='content',date_reliable=1 WHERE doc_uid=?1").bind(row.uid, row.date),
      env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM documents d
        WHERE d.doc_uid=?1 AND d.document_date=?2 AND d.date_source='content' AND d.date_reliable=1)
        AND (SELECT COUNT(*) FROM chunks WHERE doc_uid=?1)=?3
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc_uid=?1 AND (c.document_date IS NOT ?2
          OR NOT EXISTS (SELECT 1 FROM vector_outbox o WHERE o.chunk_uid=c.chunk_uid
            AND o.op='upsert' AND o.vector_id=COALESCE(c.vector_id,c.chunk_uid)))) THEN 1
        ELSE json_extract('content date readback failed','$') END AS verified`).bind(row.uid, row.date, row.chunks),
    );
  }
  const done = { ...receipt, updated: changes.length, chunks_requeued: receipt.chunks };
  statements.push(env.DB.prepare(`INSERT INTO content_date_refresh_receipts(plan_hash,start_cursor,receipt,applied_at)
    VALUES (?1,?2,json_set(?3,'$.queue_depth',(SELECT COUNT(*) FROM vector_outbox)),?4)`)
    .bind(approve, after, JSON.stringify(done), now));
  statements.push(env.DB.prepare('SELECT receipt FROM content_date_refresh_receipts WHERE plan_hash=?1').bind(approve));
  let result;
  try { result = await env.DB.batch(statements); }
  catch {
    // The batch rolls back on any failed guard or readback. A concurrent exact
    // apply may have committed first; its durable receipt is the only replay.
    const saved = await env.DB.prepare('SELECT receipt FROM content_date_refresh_receipts WHERE plan_hash=?1 AND start_cursor=?2').bind(approve, after).first();
    if (saved) return { ...JSON.parse(saved.receipt), updated: 0, chunks_requeued: 0, replayed: true, queue_depth: await queueDepth(env) };
    await checkQueue(env, ids, queueBudget);
    refuse('content_dates_stale');
  }
  const saved = result?.at(-1)?.results?.[0]?.receipt;
  if (typeof saved !== 'string') refuse('content_dates_unavailable');
  return JSON.parse(saved);
}

/** The router supplies the admin-key and upgrade-pause boundaries. */
export async function handleContentRefreshDates(env, request) {
  if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ reason: MESSAGES.content_dates_approval_required }, 400); }
  const keys = ['dry_run', 'approve', 'cursor', 'limit', 'queue_budget'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k)) ||
      typeof body.dry_run !== 'boolean' ||
      (body.cursor !== undefined && (typeof body.cursor !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(body.cursor) || !Number.isSafeInteger(Number(body.cursor)))) ||
      (body.limit !== undefined && (!body.dry_run || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 10)) ||
      (body.queue_budget !== undefined && (!Number.isInteger(body.queue_budget) || body.queue_budget < 0 || body.queue_budget > 10000)) ||
      (body.dry_run ? body.approve !== undefined : typeof body.approve !== 'string' || !HASH.test(body.approve))) {
    return jsonResponse({ code: 'content_dates_approval_required', reason: MESSAGES.content_dates_approval_required }, 400);
  }
  try {
    if (backendOf(env) !== 'd1') refuse('content_dates_d1_required');
    return jsonResponse(await refreshContentDates(env, { after: Number(body.cursor ?? '0'), limit: body.limit,
      dryRun: body.dry_run, approve: body.approve, queueBudget: body.queue_budget }));
  } catch (error) {
    const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'content_dates_unavailable';
    return jsonResponse({ code, reason: MESSAGES[code] }, code === 'content_dates_unavailable' ? 503 : 409);
  }
}
