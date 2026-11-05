// This projection never changes documents or removal-approval generations.
// The migration installs triggers before a resumable PK walk fills old rows.
// Readers switch only after the last page and its receipt commit together.
export const SOURCE_FAMILY_INDEX_BATCH_SIZE = 500;

export const SOURCE_FAMILY_EXPRESSION = `CASE
  WHEN json_valid(meta) AND json_type(meta,'$.family_of') = 'text'
   AND length(json_extract(meta,'$.family_of')) > 0
    THEN json_extract(meta,'$.family_of')
  WHEN json_valid(meta) AND json_type(meta,'$.part_of') = 'text'
   AND length(json_extract(meta,'$.part_of')) > 0
    THEN CASE
      WHEN substr(json_extract(meta,'$.part_of'),1,length(source)+1) = source || ':'
        THEN json_extract(meta,'$.part_of')
      ELSE source || ':' || json_extract(meta,'$.part_of') END
  ELSE doc_uid END`;

const DECLARED_EXPRESSION = `CASE WHEN json_valid(meta)
  AND json_type(meta,'$.family_of') = 'text'
  THEN json_extract(meta,'$.family_of') ELSE NULL END`;

async function indexState(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT cursor, complete FROM document_family_index_state WHERE id=1"
    ).bind().all();
    return results?.[0] ?? null;
  } catch (error) {
    // Only a genuinely older schema permits fallback. Capacity and transport
    // failures must still reach the existing D1-scoped inventory retry.
    if (/no such table:\s*(?:main\.)?document_family_index_state\b/i.test(String(error?.message))) return null;
    throw error;
  }
}

export async function sourceFamilyIndexReady(env) {
  return (await indexState(env))?.complete === 1;
}

export async function backfillSourceFamilyIndex(env) {
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") return { paused: true, advanced: 0 };
  const state = await indexState(env);
  if (!state) return { unavailable: true, advanced: 0 };
  if (state.complete === 1) return { complete: true, advanced: 0 };
  const lower = state.cursor === null ? "" : "doc_uid > ?1 AND ";
  const page = `SELECT doc_uid FROM documents WHERE ${lower}1
    ORDER BY doc_uid LIMIT ${SOURCE_FAMILY_INDEX_BATCH_SIZE}`;
  // Both statements select the same bounded PK page inside one transaction.
  // A write before the batch is included; a later write is covered by triggers.
  // No pre-read cursor can skip old rows when new identities fill its range.
  const fence = "EXISTS (SELECT 1 FROM document_family_index_state WHERE id=1 AND cursor IS ?1 AND complete=0)";
  const statements = [env.DB.prepare(
    `INSERT INTO document_family_index(doc_uid,family_doc_uid,declared_family_uid,live)
     SELECT doc_uid, ${SOURCE_FAMILY_EXPRESSION}, ${DECLARED_EXPRESSION}, deleted_at IS NULL
       FROM documents WHERE ${lower}${fence}
      ORDER BY doc_uid LIMIT ${SOURCE_FAMILY_INDEX_BATCH_SIZE}
     ON CONFLICT(doc_uid) DO UPDATE SET family_doc_uid=excluded.family_doc_uid,
       declared_family_uid=excluded.declared_family_uid, live=excluded.live
     RETURNING doc_uid`
  ).bind(state.cursor), env.DB.prepare(
    `UPDATE document_family_index_state
        SET cursor=COALESCE((SELECT MAX(doc_uid) FROM (${page})),cursor),
            complete=NOT EXISTS (SELECT 1 FROM documents WHERE ${lower}1
              ORDER BY doc_uid LIMIT 1 OFFSET ${SOURCE_FAMILY_INDEX_BATCH_SIZE - 1})
      WHERE id=1 AND cursor IS ?1 AND complete=0 RETURNING cursor, complete`
  ).bind(state.cursor)];
  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length || results.some(r => r.success === false)) {
    throw new Error("source-family index batch was not verified");
  }
  const receipt = results.at(-1)?.results;
  if (!Array.isArray(receipt)) throw new Error("source-family index receipt is unavailable");
  if (receipt.length === 0) return { contended: true, advanced: 0 };
  const written = results[0]?.results;
  if (!Array.isArray(written) || written.length > SOURCE_FAMILY_INDEX_BATCH_SIZE) {
    throw new Error("source-family index page readback is unavailable");
  }
  // SQLite BINARY order compares UTF-8 bytes, whereas JS sorts UTF-16 units.
  // Sorting encoded returned identities keeps non-BMP cursors exact as well.
  const encoder = new TextEncoder();
  const ordered = written.map(row => ({ uid: row.doc_uid, bytes: encoder.encode(row.doc_uid) }))
    .sort((a, b) => {
      for (let i = 0; i < Math.min(a.bytes.length, b.bytes.length); i++) {
        if (a.bytes[i] !== b.bytes[i]) return a.bytes[i] - b.bytes[i];
      }
      return a.bytes.length - b.bytes.length;
    });
  const cursor = ordered.at(-1)?.uid ?? state.cursor;
  const complete = written.length < SOURCE_FAMILY_INDEX_BATCH_SIZE ? 1 : 0;
  if (receipt.length !== 1 || receipt[0].cursor !== cursor || receipt[0].complete !== complete) {
    throw new Error("source-family index receipt did not match its page");
  }
  return { complete: complete === 1, advanced: written.length,
    ...(complete === 1 ? { finished: true } : {}) };
}
