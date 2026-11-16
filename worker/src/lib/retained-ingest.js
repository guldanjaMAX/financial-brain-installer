import { sourceOriginalChunkReceiptHash } from './source-original-chunk.js';

// This is a document bound, independent of the size of its source or corpus.
export const RETAINED_CHUNK_LIMIT = 512;
const PACKED_CHUNK_SLICE = 48;

// Only explicit admission decisions may settle an unaccepted Drive event.
// SQL/transport/ownership/readback errors remain retryable, never omissions.
const ADMISSION_REASONS = Object.freeze({
  retained_prior_revision_limit: 'The accepted document exceeds the bounded revision snapshot limit; its text is retained. Owner-reviewed recovery is required.',
  retained_incoming_revision_limit: 'The replacement exceeds the bounded chunk limit; the accepted text is retained. Split the source document before retrying.',
  retained_document_retired: 'The accepted document is retired; owner-reviewed recovery is required before accepting a replacement.',
});

export class RetainedIngestAdmissionError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ADMISSION_REASONS, code)) throw new TypeError('unknown retained admission code');
    super(ADMISSION_REASONS[code]);
    this.code = code;
  }
}

export function retainedIngestFailureReceipt(error) {
  return error instanceof RetainedIngestAdmissionError
    ? { code:error.code, retryable:false, retry_class:'owner_recovery', error:ADMISSION_REASONS[error.code] }
    : { code:'ingest_write_failed', retryable:true, retry_class:'retry',
      error:'The document write failed; retry the same file identity. Accepted text is retained.' };
}

/** Shortened revisions retain their tail in D1, outside the active reading. */
export function activeChunkSql(chunk = 'c', document = null) {
  for (const alias of [chunk, document].filter(Boolean)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('invalid SQL alias');
  }
  const meta = document ? `${document}.meta` : `(SELECT retained_owner.meta FROM documents retained_owner WHERE retained_owner.doc_uid=${chunk}.doc_uid)`;
  return ` AND ${chunk}.chunk_ix < COALESCE(CASE WHEN json_valid(${meta}) AND json_extract(${meta},'$.brain_retained_ingest')=1
    AND json_type(${meta},'$.brain_active_chunk_count')='integer'
    THEN json_extract(${meta},'$.brain_active_chunk_count') END,9223372036854775807)`;
}

export function retainedIngestRequested(input, prior) {
  let meta = prior?.meta;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return input.md?.brain_retained_ingest === 1 || meta?.brain_retained_ingest === 1;
}

/** Persist both representations before the canonical row can change. */
export async function checkpointRetainedIngest(env, { docUid, envelope, chunks, revision, prior, vectorIdFor }) {
  if (chunks.length > RETAINED_CHUNK_LIMIT) throw new RetainedIngestAdmissionError('retained_incoming_revision_limit');
  const snapshot = await env.DB.batch([
    env.DB.prepare('SELECT * FROM documents WHERE doc_uid=?1').bind(docUid),
    env.DB.prepare('SELECT * FROM chunks WHERE doc_uid=?1 ORDER BY chunk_ix LIMIT 513').bind(docUid),
  ]);
  const document = snapshot[0]?.results?.[0] ?? null, oldChunks = snapshot[1]?.results;
  if (document?.deleted_at != null) throw new RetainedIngestAdmissionError('retained_document_retired');
  if (!Array.isArray(oldChunks)) throw new Error('retained snapshot read failed; retry this document');
  if (oldChunks.length > RETAINED_CHUNK_LIMIT) throw new RetainedIngestAdmissionError('retained_prior_revision_limit');
  if ((document?.content_hash ?? null) !== (prior?.content_hash ?? null) ||
      (document?.document_revision_id ?? null) !== (prior?.document_revision_id ?? null) ||
      (document?.meta ?? null) !== (prior?.meta ?? null)) {
    throw new Error('retained revision changed before checkpoint; retry this document');
  }
  const next = await Promise.all(chunks.map(async c => ({ ...c, vector_id: await vectorIdFor(c.chunk_uid),
    result_chunk_receipt_hash: c.bound_document_revision_id ? await sourceOriginalChunkReceiptHash({
      document_revision_id:c.bound_document_revision_id, chunk_ix:c.chunk_ix, title:c.title, text:c.text,
    }) : null })));
  const stageId = revision.document_revision_id;
  await env.DB.prepare(`INSERT INTO retained_ingest_stages
    (stage_id,doc_uid,prior_document,prior_chunks,next_envelope,next_chunks,pending_marker,document_revision_id,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`).bind(stageId, docUid, document ? JSON.stringify(document) : null,
      JSON.stringify(oldChunks), JSON.stringify(envelope), JSON.stringify(next), revision.pending_marker, stageId, revision.ingested_at).run();
  // Exact readback is the write-ahead checkpoint proof, never a write count.
  const saved = await env.DB.prepare('SELECT next_chunks,prior_chunks FROM retained_ingest_stages WHERE stage_id=?1').bind(stageId).first();
  if (saved?.next_chunks !== JSON.stringify(next) || saved?.prior_chunks !== JSON.stringify(oldChunks)) throw new Error('retained stage readback failed');
  return { stageId, document, chunks:next };
}

/** All canonical writes and final proof run in ONE document-isolated batch. */
export function retainedActivationStatements(env, { stage, revision, documentStatement }) {
  const old = stage.document;
  const statements = [env.DB.prepare(`INSERT INTO retained_ingest_activations(stage_id,verified)
    SELECT ?1, CASE WHEN (?3 IS NULL AND NOT EXISTS(SELECT 1 FROM documents WHERE doc_uid=?2))
      OR EXISTS(SELECT 1 FROM documents WHERE doc_uid=?2 AND content_hash=?3
        AND document_revision_id IS ?4 AND meta IS ?5 AND deleted_at IS ?6 AND source=?7 AND source_id=?8)
      THEN 1 ELSE 0 END`).bind(stage.stageId, revision.doc_uid, old?.content_hash ?? null,
        old?.document_revision_id ?? null, old?.meta ?? null, old?.deleted_at ?? null,
        old?.source ?? revision.source, old?.source_id ?? null), documentStatement];
  for (let offset = 0; offset < stage.chunks.length; offset += PACKED_CHUNK_SLICE) {
    const packed = JSON.stringify(stage.chunks.slice(offset, offset + PACKED_CHUNK_SLICE));
    statements.push(env.DB.prepare(`INSERT INTO chunks
      (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,client,category,top_folder,platform,vector_id,
       bound_document_revision_id,result_chunk_receipt_hash,zone)
      SELECT json_extract(j.value,'$.chunk_uid'),d.doc_uid,json_extract(j.value,'$.chunk_ix'),json_extract(j.value,'$.text'),
        d.source,d.title,d.document_date,d.client,d.category,d.top_folder,d.platform,json_extract(j.value,'$.vector_id'),
        json_extract(j.value,'$.bound_document_revision_id'),json_extract(j.value,'$.result_chunk_receipt_hash'),d.zone
      FROM json_each(?1) j JOIN documents d ON d.doc_uid=?2 AND d.content_hash=?3
      WHERE 1=1
      ON CONFLICT(chunk_uid) DO UPDATE SET text=excluded.text,title=excluded.title,document_date=excluded.document_date,
        client=excluded.client,category=excluded.category,top_folder=excluded.top_folder,platform=excluded.platform,
        vector_id=excluded.vector_id,bound_document_revision_id=excluded.bound_document_revision_id,
        result_chunk_receipt_hash=excluded.result_chunk_receipt_hash,zone=excluded.zone`).bind(packed, revision.doc_uid, revision.pending_marker));
    statements.push(env.DB.prepare(`INSERT INTO vector_outbox(chunk_uid,vector_id,op,queued_at,attempts,last_error)
      SELECT json_extract(j.value,'$.chunk_uid'),json_extract(j.value,'$.vector_id'),'upsert',?4,0,NULL
      FROM json_each(?1) j JOIN documents d ON d.doc_uid=?2 AND d.content_hash=?3
      WHERE 1=1
      ON CONFLICT(chunk_uid) DO UPDATE SET vector_id=excluded.vector_id,op='upsert',queued_at=excluded.queued_at,attempts=0,last_error=NULL`)
      .bind(packed, revision.doc_uid, revision.pending_marker, revision.ingested_at));
  }
  // Exact staged bytes, contiguous indices and marker ownership are checked
  // before the content hash can commit. CHECK failure rolls back activation.
  statements.push(env.DB.prepare(`UPDATE retained_ingest_activations SET verified=CASE WHEN
    EXISTS(SELECT 1 FROM documents d WHERE d.doc_uid=?2 AND d.content_hash=?3 AND d.source=?5
      AND d.document_revision_id=?6 AND d.provenance_receipt_digest=?7
      AND d.source_original_binding_hash IS ?8 AND d.deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM json_each(?4) j LEFT JOIN chunks c
      ON c.chunk_uid=json_extract(j.value,'$.chunk_uid')
      LEFT JOIN documents d ON d.doc_uid=?2
      WHERE c.chunk_uid IS NULL OR c.doc_uid<>?2 OR c.chunk_ix<>json_extract(j.value,'$.chunk_ix')
        OR c.title IS NOT d.title OR c.source IS NOT d.source OR c.document_date IS NOT d.document_date
        OR c.client IS NOT d.client OR c.category IS NOT d.category OR c.top_folder IS NOT d.top_folder
        OR c.platform IS NOT d.platform OR c.zone IS NOT d.zone
        OR c.text IS NOT json_extract(j.value,'$.text') OR c.vector_id IS NOT json_extract(j.value,'$.vector_id')
        OR c.bound_document_revision_id IS NOT json_extract(j.value,'$.bound_document_revision_id')
        OR c.result_chunk_receipt_hash IS NOT json_extract(j.value,'$.result_chunk_receipt_hash'))
    THEN 1 ELSE 0 END WHERE stage_id=?1`).bind(stage.stageId, revision.doc_uid, revision.pending_marker, JSON.stringify(stage.chunks), revision.source,
      revision.document_revision_id, revision.provenance_receipt_digest, revision.source_original_binding?.binding_hash ?? null));
  return statements;
}
