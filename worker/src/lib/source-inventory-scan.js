/** Read-only keyset inventory. No schema/index build or corpus-sized SQL. */
import { sourceInventorySlice, inventoryLatestRunsSql } from "./store-d1.js";
import { customApiPointerTablesPresent } from "./custom-api-visibility.js";

export const INVENTORY_DOCUMENT_PAGE_SIZE = 5000;
export const INVENTORY_MAX_PAGES = 1000;
const RECEIPT_PAGE_SIZE = 5000;
const SOURCE_LIMIT = 10000;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const rows = async (env, sql, binds = []) => {
  const result = await env.DB.prepare(sql).bind(...binds).all();
  if (!Array.isArray(result?.results)) fail("source_inventory_unavailable");
  return result.results;
};
const boundedTable = async (env, table, columns, limit, order) => {
  const result = await rows(env, `SELECT ${columns} FROM ${table} ORDER BY ${order} LIMIT ?1`, [limit + 1]);
  if (result.length > limit) fail("source_inventory_too_large");
  return result;
};
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(JSON.stringify(value)),
))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function marker(env) {
  // Schema 45 already fences every document/chunk change. Recovery import
  // suppresses that fence, so refuse it rather than inventing snapshot proof.
  const state = await env.DB.prepare(`SELECT schema_version, outbox_generation,
    source_original_retrieval_generation AS generation,
    EXISTS(SELECT 1 FROM source_original_result_family_recovery_state
      WHERE mode='verified_recovery_import') AS recovering
    FROM install_state WHERE id=1`).first();
  if (!state || !Number.isSafeInteger(state.generation) || state.generation < 0 || state.recovering) {
    fail("source_inventory_marker_unavailable");
  }
  const sources = await boundedTable(env, "sources", "*", SOURCE_LIMIT, "name");
  // Every supported sync-run mutation appends a source event in the same
  // batch. That append-only high-water mark fences historical receipts; current
  // heads additionally detect a changed in-flight/latest receipt. Never hash
  // or cap a whole lifetime history just to read today's receipt.
  const highWater = await env.DB.prepare(`SELECT
    COALESCE((SELECT MAX(id) FROM source_events),0) AS events,
    COALESCE((SELECT MAX(rowid) FROM sync_runs),0) AS runs`).first();
  if (!highWater || ![highWater.events, highWater.runs].every(value => Number.isSafeInteger(value) && value >= 0)) fail("source_inventory_marker_unavailable");
  const runs = await rows(env, inventoryLatestRunsSql);
  if (runs.some(run => run.inventory_head_unproven !== 0)) fail("source_inventory_run_order_unavailable");
  const custom = [];
  const pointersPresent = await customApiPointerTablesPresent(env);
  if (pointersPresent === null) fail("source_inventory_marker_unavailable");
  if (pointersPresent) {
    custom.push(await boundedTable(env, "custom_api_current_jobs", "*", SOURCE_LIMIT, "source"));
    // Settled jobs cannot change visibility. Current pointers, active jobs and
    // the current schedule receipt contain the mutable state readers use.
    const active = await rows(env, `SELECT * FROM custom_api_jobs INDEXED BY idx_custom_api_jobs_one_active
      WHERE status IN ('staged','applying','promoting','promoted') ORDER BY source LIMIT ?1`, [SOURCE_LIMIT + 1]);
    if (active.length > SOURCE_LIMIT) fail("source_inventory_too_large");
    custom.push(active);
    custom.push(await boundedTable(env, "custom_api_schedule_state", "*", SOURCE_LIMIT, "source"));
  }
  // Only the digest crosses the HTTP boundary, never raw scope or run errors.
  return digest({ state, sources, runs, highWater, custom });
}

export async function sourceInventoryScanPage(env, { after = 0, limit = INVENTORY_DOCUMENT_PAGE_SIZE,
  now = Date.now(), snapshot = null, eventsAfter = 0, runsAfter = 0, freshnessOnly = false } = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > INVENTORY_DOCUMENT_PAGE_SIZE) throw new TypeError("invalid inventory page");
  if (![eventsAfter, runsAfter].every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError("invalid receipt page");
  const before = await marker(env);
  if (snapshot !== null && snapshot !== before) fail("source_inventory_changed");
  // INTEGER PRIMARY KEY range lookup, including tombstones in the work bound.
  // Filtering deleted/custom rows before LIMIT would make sparse pages unbounded.
  const page = await env.DB.prepare(`SELECT COUNT(*) AS scanned, COALESCE(MAX(r), ?1) AS through_id
    FROM (SELECT rowid AS r FROM documents WHERE rowid > ?1 ORDER BY rowid LIMIT ?2)`)
    .bind(after, freshnessOnly ? 0 : limit).first();
  if (!page || !Number.isSafeInteger(page.scanned) || page.scanned < 0 || page.scanned > limit ||
      !Number.isSafeInteger(page.through_id) || (page.scanned ? page.through_id <= after : page.through_id !== after)) {
    fail("source_inventory_invalid_page");
  }
  // A pathological document cannot turn a bounded document page into an
  // unbounded chunk scan. The covering chunk index stops this proof at 50,001.
  const chunkBound = await env.DB.prepare(`WITH inventory_document_page AS MATERIALIZED (
    SELECT doc_uid FROM documents WHERE rowid > ?1 ORDER BY rowid LIMIT ?2
  ) SELECT COUNT(*) AS n FROM (SELECT c.rowid FROM inventory_document_page p
    CROSS JOIN chunks c INDEXED BY idx_chunks_doc ON c.doc_uid=p.doc_uid LIMIT 50001)`)
    .bind(after, freshnessOnly ? 0 : limit).first();
  if (!chunkBound || !Number.isSafeInteger(chunkBound.n) || chunkBound.n < 0) fail("source_inventory_chunk_limit");
  if (chunkBound.n > 50000) {
    if (limit === 1) fail("source_inventory_chunk_limit");
    return sourceInventoryScanPage(env, { after, limit: Math.floor(limit / 2), now, snapshot: before,
      eventsAfter, runsAfter, freshnessOnly });
  }
  const receiptRanges = {};
  for (const [name, table, key, offset] of [["events", "source_events", "id", eventsAfter], ["runs", "sync_runs", "rowid", runsAfter]]) {
    const range = await env.DB.prepare(`SELECT COUNT(*) AS scanned,COALESCE(MAX(r),?1) AS through_id
      FROM (SELECT ${key} AS r FROM ${table} WHERE ${key} > ?1 ORDER BY ${key} LIMIT ?2)`)
      .bind(offset, RECEIPT_PAGE_SIZE).first();
    if (!range || !Number.isSafeInteger(range.scanned) || range.scanned < 0 || range.scanned > RECEIPT_PAGE_SIZE ||
        !Number.isSafeInteger(range.through_id) || (range.scanned ? range.through_id <= offset : range.through_id !== offset)) fail("source_inventory_invalid_page");
    receiptRanges[name] = range;
  }
  const inventory = await sourceInventorySlice(env, { now, documentPage: { after, limit: freshnessOnly ? 0 : limit },
    receiptPage: { events: eventsAfter, runs: runsAfter } });
  if (await marker(env) !== before) fail("source_inventory_changed");
  return { ...inventory, snapshot: before, scan: {
    after, through: page.through_id, scanned: page.scanned, limit,
    max_pages: INVENTORY_MAX_PAGES, max_documents: INVENTORY_MAX_PAGES * INVENTORY_DOCUMENT_PAGE_SIZE,
    receipts: { limit: RECEIPT_PAGE_SIZE, events: receiptRanges.events.scanned, runs: receiptRanges.runs.scanned },
  }, receiptThrough: { events: receiptRanges.events.through_id, runs: receiptRanges.runs.through_id },
    complete: page.scanned < limit && Object.values(receiptRanges).every(range => range.scanned < RECEIPT_PAGE_SIZE) };
}

/** Daily scheduling uses the same receipt pages without visiting documents. */
export async function sourceFreshnessPage(env, options = {}) {
  return sourceInventoryScanPage(env, { ...options, freshnessOnly: true });
}

export function missingInventoryFence(error) {
  return /no such (?:column: source_original_retrieval_generation|table: source_original_result_family_recovery_state)/.test(String(error?.message));
}
