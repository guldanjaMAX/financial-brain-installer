import { contentFreshness } from './content-freshness.js';

/** Bounded, resumable operator maintenance. Preview by default; no deletions.
 * The caller supplies the owner's D1 binding. This is deliberately not run on
 * reads or in cron. Corrected chunk dates re-enter the existing vector outbox.
 */
export async function refreshContentDates(env, { after = 0, limit = 10, dryRun = true, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10 ||
      typeof dryRun !== 'boolean' || !Number.isSafeInteger(now) || now < 0) throw new TypeError('invalid freshness maintenance page');
  const page = (await env.DB.prepare(`SELECT rowid AS cursor, doc_uid, title, document_date,
    date_source, date_reliable, content_hash, ingested_at FROM documents
    WHERE rowid > ?1 AND deleted_at IS NULL
      AND (date_source IS NULL OR date_source IN ('','none','filename','path','content'))
      ORDER BY rowid LIMIT ?2`).bind(after, limit + 1).all()).results || [];
  let cursor = after, planned = 0, updated = 0;
  for (const doc of page.slice(0, limit)) {
    const chunks = (await env.DB.prepare(`SELECT text FROM chunks WHERE doc_uid=?1
      ORDER BY chunk_ix LIMIT 501`).bind(doc.doc_uid).all()).results || [];
    // A partial document is never labelled repaired, nor skipped by a cursor.
    if (chunks.length > 500) return { cursor, planned, updated, complete: false, blocked: 'document_chunk_budget', dry_run: dryRun };
    const fresh = contentFreshness({ title: doc.title, content: chunks.map(chunk => chunk.text).join('\n'),
      date: doc.document_date, dateSource: doc.date_source });
    if (fresh && (fresh.value !== doc.document_date || doc.date_source !== 'content' || doc.date_reliable !== 1)) {
      planned++;
      if (!dryRun) {
        // Every statement tests the same observed revision. D1 batch is atomic;
        // concurrent ingest either wins before it or observes the finished date.
        const guard = `SELECT doc_uid FROM documents WHERE doc_uid=?1 AND content_hash=?2
          AND document_date IS ?3 AND date_source IS ?4 AND ingested_at=?5
          AND title IS ?6 AND deleted_at IS NULL`;
        const bind = [doc.doc_uid, doc.content_hash, doc.document_date, doc.date_source, doc.ingested_at, doc.title];
        const result = await env.DB.batch([
          env.DB.prepare(`UPDATE chunks SET document_date=?7 WHERE doc_uid IN (${guard})`).bind(...bind, fresh.value),
          env.DB.prepare(`INSERT OR REPLACE INTO vector_outbox (chunk_uid,vector_id,op,queued_at,attempts,last_error)
            SELECT chunk_uid,COALESCE(vector_id,chunk_uid),'upsert',?7,0,NULL FROM chunks
            WHERE doc_uid IN (${guard})`).bind(...bind, now),
          env.DB.prepare(`UPDATE documents SET document_date=?7,date_source='content',date_reliable=1
            WHERE doc_uid IN (${guard}) RETURNING doc_uid`).bind(...bind, fresh.value),
          env.DB.prepare(`SELECT d.document_date,d.date_source,d.date_reliable,
            (SELECT COUNT(*) FROM chunks c WHERE c.doc_uid=d.doc_uid AND c.document_date IS NOT d.document_date) AS mismatches,
            (SELECT COUNT(*) FROM chunks c WHERE c.doc_uid=d.doc_uid AND NOT EXISTS
              (SELECT 1 FROM vector_outbox o WHERE o.chunk_uid=c.chunk_uid AND o.op='upsert')) AS unqueued
            FROM documents d WHERE d.doc_uid=?1`).bind(doc.doc_uid),
        ]);
        const readback = result?.[3]?.results?.[0];
        if (result?.[2]?.results?.length !== 1 || !readback || readback.document_date !== fresh.value ||
            readback.date_source !== 'content' || readback.date_reliable !== 1 || readback.mismatches !== 0 || readback.unqueued !== 0) {
          return { cursor, planned, updated, complete: false, blocked: 'revision_or_readback_changed', dry_run: dryRun };
        }
        updated++;
      }
    }
    cursor = doc.cursor;
  }
  return { cursor, planned, updated, complete: page.length <= limit, dry_run: dryRun };
}
