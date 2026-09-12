/**
 * Bounded chunk-table scan for `brain diagnose`.
 *
 * D1 gives each SQL statement a hard execution window. Running several whole
 * corpus aggregates independently made a large, healthy Brain likely to time
 * out while trying to prove it was healthy. This scanner visits one fixed
 * high-water range once, in keyset pages, and derives all of the exact chunk
 * integrity counts from that same bounded pass.
 */

export const DEFAULT_DIAGNOSE_CHUNK_PAGE_SIZE = 50_000;
export const DEFAULT_DIAGNOSE_CHUNK_PAGE_BUDGET = 100;
export const DEFAULT_DIAGNOSE_STATEMENT_BUDGET = 128;

export const DIAGNOSE_MUTATION_MARKER_SQL = `
  SELECT i.schema_version AS schema_version,
         i.outbox_generation AS outbox_generation,
         COALESCE((SELECT max(id) FROM chunks), 0) AS high_water_id,
         COALESCE((SELECT sum(documents) FROM corpus_stats), 0) AS corpus_documents,
         COALESCE((SELECT sum(chunks) FROM corpus_stats), 0) AS corpus_chunks,
         COALESCE((SELECT max(last_ingest_at) FROM corpus_stats), 0) AS corpus_last_ingest_at,
         COALESCE((SELECT max(id) FROM source_events), 0) AS source_event_high_water,
         (SELECT count(*) FROM sources) AS source_count,
         COALESCE(i.vector_projection_status, '') AS vector_projection_status,
         COALESCE(i.vector_projection_mutation_id, '') AS vector_projection_mutation_id,
         COALESCE(i.vector_projection_submitted_at, 0) AS vector_projection_submitted_at
    FROM install_state i
   WHERE i.id = 1`;

// MATERIALIZED prevents SQLite from flattening the limited keyset page into
// the joins below. Every expensive text operation is therefore bounded by
// pageSize even when a table contains millions of chunks or sparse row ids.
export const DIAGNOSE_CHUNK_PAGE_SQL = `
  WITH chunk_page AS MATERIALIZED (
    SELECT id, doc_uid, source, zone, text
      FROM chunks
     WHERE id > ?1 AND id <= ?2
     ORDER BY id
     LIMIT ?3
  )
  SELECT count(*) AS scanned,
         COALESCE(max(p.id), ?1) AS last_id,
         COALESCE(sum(CASE WHEN trim(p.text) = '' THEN 1 ELSE 0 END), 0) AS blank,
         COALESCE(sum(CASE WHEN length(p.text) > ?4 THEN 1 ELSE 0 END), 0) AS oversized,
         COALESCE(sum(CASE WHEN d.doc_uid IS NULL THEN 1 ELSE 0 END), 0) AS orphaned,
         COALESCE(sum(CASE WHEN d.doc_uid IS NOT NULL AND p.source IS NOT d.source THEN 1 ELSE 0 END), 0) AS source_mismatch,
         COALESCE(sum(CASE WHEN s.name IS NOT NULL AND p.zone IS NOT s.zone THEN 1 ELSE 0 END), 0) AS zone_mismatch
    FROM chunk_page p
    LEFT JOIN documents d ON d.doc_uid = p.doc_uid
    LEFT JOIN sources s ON s.name = p.source`;

const whole = (value, name, { allowZero = true } = {}) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`diagnose returned an invalid ${name}`);
  }
  return number;
};

const token = (value, name, { max = 200 } = {}) => {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`diagnose returned an invalid ${name}`);
  }
  return value;
};

export function mutationMarker(row) {
  if (!row || typeof row !== "object") throw new Error("diagnose could not read the corpus marker");
  return {
    schemaVersion: whole(row.schema_version, "schema version"),
    outboxGeneration: whole(row.outbox_generation, "outbox generation"),
    highWaterId: whole(row.high_water_id, "chunk high-water id"),
    corpusDocuments: whole(row.corpus_documents, "corpus document marker"),
    corpusChunks: whole(row.corpus_chunks, "corpus chunk marker"),
    corpusLastIngestAt: whole(row.corpus_last_ingest_at, "corpus ingest marker"),
    sourceEventHighWater: whole(row.source_event_high_water, "source event high-water id"),
    sourceCount: whole(row.source_count, "source count"),
    vectorProjectionStatus: token(row.vector_projection_status, "vector projection status", { max: 64 }),
    // Keep the provider's opaque mutation identity inside the comparison. The
    // public diagnosis receipt strips it before returning JSON.
    vectorProjectionMutationId: token(row.vector_projection_mutation_id, "vector projection mutation id"),
    vectorProjectionSubmittedAt: whole(row.vector_projection_submitted_at, "vector projection submission marker"),
  };
}

export function mutationMarkerChanges(left, right) {
  if (!left || !right) return ["marker_unavailable"];
  const changed = [];
  if (left.schemaVersion !== right.schemaVersion) changed.push("schema");
  if (left.outboxGeneration !== right.outboxGeneration ||
      left.highWaterId !== right.highWaterId ||
      left.corpusDocuments !== right.corpusDocuments ||
      left.corpusChunks !== right.corpusChunks ||
      left.corpusLastIngestAt !== right.corpusLastIngestAt) {
    changed.push("corpus");
  }
  if (left.sourceEventHighWater !== right.sourceEventHighWater ||
      left.sourceCount !== right.sourceCount) {
    changed.push("sources");
  }
  if (left.vectorProjectionStatus !== right.vectorProjectionStatus ||
      left.vectorProjectionMutationId !== right.vectorProjectionMutationId ||
      left.vectorProjectionSubmittedAt !== right.vectorProjectionSubmittedAt) {
    changed.push("vector_projection");
  }
  return changed;
}

export function publicMutationMarker(marker) {
  if (!marker) return null;
  const {
    vectorProjectionMutationId,
    ...receipt
  } = marker;
  return {
    ...receipt,
    vectorProjectionMutationPresent: Boolean(vectorProjectionMutationId),
  };
}

const emptyCounts = () => ({
  total: 0,
  blank: 0,
  oversized: 0,
  orphaned: 0,
  sourceMismatch: 0,
  zoneMismatch: 0,
});

function incompleteScan({ pageSize, pages, highWaterId, coveredThroughId, counts, reason }) {
  return {
    complete: false,
    pageSize,
    pages,
    highWaterId,
    coveredThroughId,
    reason,
    counts,
  };
}

/**
 * Scan through the exact id range that existed at the opening marker.
 *
 * `canReadPage` reserves the caller's final marker statement. A failed or
 * malformed page never promotes the partial aggregates to complete counts.
 */
export async function scanChunkPages(first, {
  highWaterId,
  pageSize = DEFAULT_DIAGNOSE_CHUNK_PAGE_SIZE,
  pageBudget = DEFAULT_DIAGNOSE_CHUNK_PAGE_BUDGET,
  chunkCharWarn,
  canReadPage = () => true,
} = {}) {
  const highWater = whole(highWaterId, "chunk high-water id");
  const size = whole(pageSize, "chunk page size", { allowZero: false });
  const maxPages = whole(pageBudget, "chunk page budget", { allowZero: false });
  const warnAt = whole(chunkCharWarn, "chunk warning size", { allowZero: false });
  const counts = emptyCounts();
  let cursor = 0;
  let pages = 0;

  while (cursor < highWater) {
    if (pages >= maxPages) {
      return incompleteScan({
        pageSize: size, pages, highWaterId: highWater, coveredThroughId: cursor,
        counts, reason: "page_budget_exhausted",
      });
    }
    if (!canReadPage()) {
      return incompleteScan({
        pageSize: size, pages, highWaterId: highWater, coveredThroughId: cursor,
        counts, reason: "statement_budget_exhausted",
      });
    }

    let row;
    try {
      row = await first(DIAGNOSE_CHUNK_PAGE_SQL, cursor, highWater, size, warnAt);
    } catch {
      return incompleteScan({
        pageSize: size, pages, highWaterId: highWater, coveredThroughId: cursor,
        counts, reason: "page_query_failed",
      });
    }

    let scanned;
    let lastId;
    let pageCounts;
    try {
      scanned = whole(row?.scanned, "chunk page count");
      lastId = whole(row?.last_id, "chunk page cursor");
      pageCounts = {
        blank: whole(row.blank, "blank chunk count"),
        oversized: whole(row.oversized, "oversized chunk count"),
        orphaned: whole(row.orphaned, "orphan chunk count"),
        sourceMismatch: whole(row.source_mismatch, "chunk source mismatch count"),
        zoneMismatch: whole(row.zone_mismatch, "chunk zone mismatch count"),
      };
    } catch {
      return incompleteScan({
        pageSize: size, pages, highWaterId: highWater, coveredThroughId: cursor,
        counts, reason: "page_response_invalid",
      });
    }
    if (!scanned || scanned > size || lastId <= cursor || lastId > highWater ||
        Object.values(pageCounts).some((value) => value > scanned)) {
      return incompleteScan({
        pageSize: size, pages, highWaterId: highWater, coveredThroughId: cursor,
        counts, reason: "fixed_high_water_not_covered",
      });
    }

    counts.total += scanned;
    counts.blank += pageCounts.blank;
    counts.oversized += pageCounts.oversized;
    counts.orphaned += pageCounts.orphaned;
    counts.sourceMismatch += pageCounts.sourceMismatch;
    counts.zoneMismatch += pageCounts.zoneMismatch;
    cursor = lastId;
    pages++;
  }

  return {
    complete: true,
    pageSize: size,
    pages,
    highWaterId: highWater,
    coveredThroughId: cursor,
    reason: null,
    counts,
  };
}
