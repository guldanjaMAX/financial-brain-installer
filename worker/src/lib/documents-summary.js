/**
 * Corpus summaries have two deliberately separate costs.
 *
 * The ordinary documents response is a hot health/readiness surface. It reads
 * only the source-sized receipt and inventory tables and never walks document
 * metadata or chunk rows. Exact logical-document and chunk totals belong to
 * the explicit report route below, where both tables are visited in fixed
 * keyset pages and the opening/closing mutation marker must agree.
 */

export const DOCUMENT_REPORT_DOCUMENT_PAGE_SIZE = 5_000;
export const DOCUMENT_REPORT_CHUNK_PAGE_SIZE = 5_000;
export const DOCUMENT_REPORT_MAX_DOCUMENT_PAGES = 100;
export const DOCUMENT_REPORT_MAX_CHUNK_PAGES = 300;

export const DOCUMENT_COUNT_NOTE =
  "not counted on large Brains; run `brain report` for the full count";

const HOT_SUMMARY_SQL = `
  WITH source_names AS (
    SELECT source FROM corpus_stats
    UNION
    SELECT source FROM document_source_inventory
  )
  SELECT names.source AS source_type,
         CASE WHEN inventory.source IS NULL THEN 0 ELSE 1 END AS has_documents,
         stats.last_ingest_at
    FROM source_names names
    LEFT JOIN document_source_inventory inventory USING (source)
    LEFT JOIN corpus_stats stats USING (source)
   ORDER BY names.source`;

const SOURCE_DOCUMENT_COUNT_SQL = `
  SELECT COUNT(*) AS documents,
         COALESCE(MAX(rowid), 0) AS document_high_water,
         COALESCE((SELECT outbox_generation FROM install_state WHERE id = 1), 0)
           AS corpus_mutation_generation
    FROM documents
   WHERE source = ?1 AND deleted_at IS NULL`;

const REPORT_MARKER_SQL = `
  SELECT i.schema_version,
         i.outbox_generation,
         COALESCE((SELECT MAX(rowid) FROM documents), 0) AS document_high_water,
         COALESCE((SELECT MAX(id) FROM chunks), 0) AS chunk_high_water,
         COALESCE((SELECT MAX(ingested_at) FROM documents), 0) AS latest_document_ingest,
         COALESCE((SELECT SUM(documents) FROM corpus_stats), 0) AS corpus_documents,
         COALESCE((SELECT SUM(chunks) FROM corpus_stats), 0) AS corpus_chunks,
         COALESCE((SELECT MAX(last_ingest_at) FROM corpus_stats), 0) AS last_ingest_at,
         COALESCE((SELECT MAX(id) FROM source_events), 0) AS source_event_high_water,
         (SELECT COUNT(*) FROM sources) AS source_count,
         COALESCE(i.vector_projection_status, '') AS vector_projection_status,
         COALESCE(i.vector_projection_mutation_id, '') AS vector_projection_mutation_id,
         COALESCE(i.vector_projection_submitted_at, 0) AS vector_projection_submitted_at,
         EXISTS(
           SELECT 1 FROM vector_outbox
            WHERE queued_at >= -9223372036854775808 LIMIT 1
         ) AS outbox_pending
    FROM install_state i
   WHERE i.id = 1`;

const DOCUMENT_PAGE_SQL = `
  WITH page AS MATERIALIZED (
    SELECT rowid AS document_rowid, source, source_id, meta
      FROM documents
     WHERE rowid > ?1 AND rowid <= ?2 AND deleted_at IS NULL
     ORDER BY rowid
     LIMIT ?3
  )
  SELECT document_rowid, source, source_id,
         CASE WHEN json_valid(meta) THEN json_extract(meta, '$.part_of') END AS part_of
    FROM page
   ORDER BY document_rowid`;

const CHUNK_PAGE_SQL = `
  WITH page AS MATERIALIZED (
    SELECT id, chunk_uid, doc_uid
      FROM chunks
     WHERE id > ?1 AND id <= ?2
     ORDER BY id
     LIMIT ?3
  ), live AS (
    SELECT page.id, documents.source,
           CASE WHEN outbox.chunk_uid IS NULL THEN 0 ELSE 1 END AS pending
      FROM page
      CROSS JOIN documents ON documents.doc_uid = page.doc_uid
                          AND documents.deleted_at IS NULL
      LEFT JOIN vector_outbox outbox ON outbox.chunk_uid = page.chunk_uid
  ), page_state AS (
    SELECT COUNT(*) AS scanned, COALESCE(MAX(id), ?1) AS last_id FROM page
  )
  SELECT 1 AS page_state, NULL AS source_type, scanned AS chunks,
         0 AS pending_vectors, last_id
    FROM page_state
  UNION ALL
  SELECT 0 AS page_state, source AS source_type, COUNT(*) AS chunks,
         COALESCE(SUM(pending), 0) AS pending_vectors, NULL AS last_id
    FROM live
   GROUP BY source`;

const safeWhole = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`documents report returned an invalid ${label}`);
  }
  return number;
};

const safeMarkerText = (value, label) => {
  if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`documents report returned an invalid ${label}`);
  }
  return value;
};

const normalizedMarker = (row) => {
  if (!row || typeof row !== "object") {
    throw new Error("documents report could not read its mutation marker");
  }
  return Object.freeze({
    schema_version: safeWhole(row.schema_version, "schema version"),
    outbox_generation: safeWhole(row.outbox_generation, "outbox generation"),
    document_high_water: safeWhole(row.document_high_water, "document high water"),
    chunk_high_water: safeWhole(row.chunk_high_water, "chunk high water"),
    latest_document_ingest: safeWhole(row.latest_document_ingest, "document ingest marker"),
    corpus_documents: safeWhole(row.corpus_documents, "document marker"),
    corpus_chunks: safeWhole(row.corpus_chunks, "chunk marker"),
    last_ingest_at: safeWhole(row.last_ingest_at, "ingest marker"),
    source_event_high_water: safeWhole(row.source_event_high_water, "source event marker"),
    source_count: safeWhole(row.source_count, "source count"),
    vector_projection_status: safeMarkerText(row.vector_projection_status, "projection status"),
    vector_projection_mutation_id: safeMarkerText(row.vector_projection_mutation_id, "projection mutation"),
    vector_projection_submitted_at: safeWhole(row.vector_projection_submitted_at, "projection timestamp"),
    outbox_pending: safeWhole(row.outbox_pending ?? 0, "outbox state"),
  });
};

const sameMarker = (left, right) =>
  Object.keys(left).every((key) => key === "outbox_pending" || left[key] === right[key]);

const emptyReportRow = (source) => ({
  source_type: source,
  stored_documents: 0,
  logical_documents: 0,
  chunks: 0,
  pending_vectors: 0,
  last_ingested: null,
});

const publicReportRow = (row, pendingVectorCountsExact) => ({
  source_type: row.source_type,
  documents: row.logical_documents,
  logical_documents: row.logical_documents,
  stored_documents: row.stored_documents,
  document_counts_exact: true,
  chunks: row.chunks,
  chunk_counts_exact: true,
  total: row.chunks,
  embedded: Math.max(0, row.chunks - row.pending_vectors),
  pending_vectors: row.pending_vectors,
  pending_vector_counts_exact: pendingVectorCountsExact,
  last_ingested: row.last_ingested,
});

/** Source-sized informational rows for health, status, MCP, and readiness. */
export async function readDocumentSummary(env) {
  const { results } = await env.DB.prepare(HOT_SUMMARY_SQL).all();
  const rows = (results || []).map((row) => ({
    source_type: row.source_type,
    has_documents: Number(row.has_documents) === 1,
    documents: null,
    logical_documents: null,
    stored_documents: null,
    document_counts_exact: false,
    chunks: null,
    chunk_counts_exact: false,
    total: null,
    embedded: null,
    pending_vectors: null,
    last_ingested: row.last_ingest_at
      ? new Date(Number(row.last_ingest_at)).toISOString()
      : null,
    count_note: DOCUMENT_COUNT_NOTE,
  }));
  return {
    rows,
    summary: {
      status: "informational",
      complete: false,
      exact_counts_available_from: "brain report",
      count_note: DOCUMENT_COUNT_NOTE,
    },
  };
}

/** Exact source-scoped preflight for a destructive forget confirmation. */
export async function readExactSourceForgetPreview(env, source) {
  const normalized = String(source || "");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new TypeError("source document count needs a normalized source name");
  }
  const row = await env.DB.prepare(SOURCE_DOCUMENT_COUNT_SQL).bind(normalized).first();
  return {
    documents: safeWhole(row?.documents, "source document count"),
    document_high_water: safeWhole(row?.document_high_water, "source document high water"),
    corpus_mutation_generation: safeWhole(
      row?.corpus_mutation_generation,
      "corpus mutation generation",
    ),
  };
}

export async function readExactSourceDocumentCount(env, source) {
  return (await readExactSourceForgetPreview(env, source)).documents;
}

/**
 * Exact on-demand report. Each corpus statement has both a keyset and a fixed
 * row budget. A supported corpus/outbox mutation between pages invalidates the
 * whole result instead of publishing a mixed snapshot.
 */
export async function readExactDocumentReport(env, {
  documentPageSize = DOCUMENT_REPORT_DOCUMENT_PAGE_SIZE,
  chunkPageSize = DOCUMENT_REPORT_CHUNK_PAGE_SIZE,
  maxDocumentPages = DOCUMENT_REPORT_MAX_DOCUMENT_PAGES,
  maxChunkPages = DOCUMENT_REPORT_MAX_CHUNK_PAGES,
  now = () => Date.now(),
} = {}) {
  for (const [label, value, maximum] of [
    ["document page size", documentPageSize, DOCUMENT_REPORT_DOCUMENT_PAGE_SIZE],
    ["chunk page size", chunkPageSize, DOCUMENT_REPORT_CHUNK_PAGE_SIZE],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`${label} must be 1 to ${maximum}`);
    }
  }
  for (const [label, value] of [
    ["document page budget", maxDocumentPages],
    ["chunk page budget", maxChunkPages],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`);
  }

  const opening = normalizedMarker(await env.DB.prepare(REPORT_MARKER_SQL).first());
  const sourceRows = new Map();
  const families = new Map();
  const sourceReceipts = await env.DB.prepare(
    `SELECT names.source AS source_type, stats.last_ingest_at
       FROM (
         SELECT source FROM corpus_stats
         UNION
         SELECT source FROM document_source_inventory
       ) names
       LEFT JOIN corpus_stats stats USING (source)
      ORDER BY names.source`,
  ).all();
  for (const source of sourceReceipts.results || []) {
    const row = emptyReportRow(String(source.source_type));
    row.last_ingested = source.last_ingest_at
      ? new Date(Number(source.last_ingest_at)).toISOString()
      : null;
    sourceRows.set(row.source_type, row);
  }

  let documentCursor = 0;
  let documentPages = 0;
  while (documentCursor < opening.document_high_water) {
    if (++documentPages > maxDocumentPages) {
      throw new Error("documents report exceeded its document-page budget");
    }
    const { results } = await env.DB.prepare(DOCUMENT_PAGE_SQL)
      .bind(documentCursor, opening.document_high_water, documentPageSize).all();
    const page = results || [];
    if (!page.length) break;
    for (const document of page) {
      const source = String(document.source);
      if (!sourceRows.has(source)) sourceRows.set(source, emptyReportRow(source));
      sourceRows.get(source).stored_documents++;
      const family = document.part_of === null || document.part_of === undefined
        ? document.source_id
        : document.part_of;
      if (!families.has(source)) families.set(source, new Set());
      families.get(source).add(String(family));
    }
    const next = safeWhole(page.at(-1).document_rowid, "document cursor");
    if (next <= documentCursor) throw new Error("documents report document cursor did not advance");
    documentCursor = next;
    if (page.length < documentPageSize) break;
  }

  let chunkCursor = 0;
  let chunkPages = 0;
  while (chunkCursor < opening.chunk_high_water) {
    if (++chunkPages > maxChunkPages) {
      throw new Error("documents report exceeded its chunk-page budget");
    }
    const { results } = await env.DB.prepare(CHUNK_PAGE_SQL)
      .bind(chunkCursor, opening.chunk_high_water, chunkPageSize).all();
    const page = results || [];
    const state = page.find((row) => Number(row.page_state) === 1);
    const scanned = safeWhole(state?.chunks, "chunk page size");
    const next = safeWhole(state?.last_id, "chunk cursor");
    for (const aggregate of page.filter((row) => Number(row.page_state) === 0)) {
      const source = String(aggregate.source_type);
      if (!sourceRows.has(source)) sourceRows.set(source, emptyReportRow(source));
      const row = sourceRows.get(source);
      row.chunks += safeWhole(aggregate.chunks, "chunk count");
      row.pending_vectors += safeWhole(aggregate.pending_vectors, "pending-vector count");
    }
    if (scanned === 0) break;
    if (next <= chunkCursor) throw new Error("documents report chunk cursor did not advance");
    chunkCursor = next;
    if (scanned < chunkPageSize) break;
  }

  for (const [source, members] of families) {
    sourceRows.get(source).logical_documents = members.size;
  }
  const closing = normalizedMarker(await env.DB.prepare(REPORT_MARKER_SQL).first());
  if (!sameMarker(opening, closing)) {
    throw new Error("documents report overlapped a corpus change; run it again");
  }
  const at = Number(now());
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("documents report clock is invalid");
  const pendingVectorCountsExact = opening.outbox_pending === 0 && closing.outbox_pending === 0;
  return {
    rows: [...sourceRows.values()].sort((a, b) => a.source_type.localeCompare(b.source_type))
      .map((row) => publicReportRow(row, pendingVectorCountsExact)),
    summary: {
      status: "complete",
      complete: true,
      exact: pendingVectorCountsExact,
      document_counts_exact: true,
      chunk_counts_exact: true,
      pending_vector_counts_exact: pendingVectorCountsExact,
      pending_vectors_approximate: !pendingVectorCountsExact,
      as_of: new Date(at).toISOString(),
      document_pages: documentPages,
      chunk_pages: chunkPages,
    },
  };
}

export const documentsSummarySqlForTest = Object.freeze({
  hot: HOT_SUMMARY_SQL,
  sourceCount: SOURCE_DOCUMENT_COUNT_SQL,
  marker: REPORT_MARKER_SQL,
  documentPage: DOCUMENT_PAGE_SQL,
  chunkPage: CHUNK_PAGE_SQL,
});
