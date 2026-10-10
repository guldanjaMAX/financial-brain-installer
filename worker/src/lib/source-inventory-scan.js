/** Read-only keyset inventory. No schema/index build or corpus-sized SQL. */
import { sourceInventorySlice } from "./store-d1.js";
import { customApiPointerTablesPresent } from "./custom-api-visibility.js";

export const INVENTORY_DOCUMENT_PAGE_SIZE = 5000;
export const INVENTORY_MAX_PAGES = 1000;
const RECEIPT_LIMIT = 65536;
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
  const runs = await boundedTable(env, "sync_runs", "*", RECEIPT_LIMIT, "rowid");
  const events = await boundedTable(env, "source_events", "id,source_name,event,at", RECEIPT_LIMIT, "id");
  const custom = [];
  const pointersPresent = await customApiPointerTablesPresent(env);
  if (pointersPresent === null) fail("source_inventory_marker_unavailable");
  for (const table of pointersPresent ? ["custom_api_current_jobs", "custom_api_jobs"] : []) {
    try { custom.push(await boundedTable(env, table, "*", RECEIPT_LIMIT, "rowid")); }
    catch (error) {
      if (!String(error?.message).includes(`no such table: ${table}`)) throw error;
      custom.push(null);
    }
  }
  // Only the digest crosses the HTTP boundary, never raw scope or run errors.
  return digest({ state, sources, runs, events, custom });
}

export async function sourceInventoryScanPage(env, { after = 0, limit = INVENTORY_DOCUMENT_PAGE_SIZE,
  now = Date.now(), snapshot = null } = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > INVENTORY_DOCUMENT_PAGE_SIZE) throw new TypeError("invalid inventory page");
  const before = await marker(env);
  if (snapshot !== null && snapshot !== before) fail("source_inventory_changed");
  // INTEGER PRIMARY KEY range lookup, including tombstones in the work bound.
  // Filtering deleted/custom rows before LIMIT would make sparse pages unbounded.
  const page = await env.DB.prepare(`SELECT COUNT(*) AS scanned, COALESCE(MAX(r), ?1) AS through_id
    FROM (SELECT rowid AS r FROM documents WHERE rowid > ?1 ORDER BY rowid LIMIT ?2)`)
    .bind(after, limit).first();
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
    .bind(after, limit).first();
  if (!chunkBound || !Number.isSafeInteger(chunkBound.n) || chunkBound.n < 0) fail("source_inventory_chunk_limit");
  if (chunkBound.n > 50000) {
    if (limit === 1) fail("source_inventory_chunk_limit");
    return sourceInventoryScanPage(env, { after, limit: Math.floor(limit / 2), now, snapshot: before });
  }
  const inventory = await sourceInventorySlice(env, { now, documentPage: { after, limit } });
  if (await marker(env) !== before) fail("source_inventory_changed");
  return { ...inventory, snapshot: before, scan: {
    after, through: page.through_id, scanned: page.scanned, limit,
    max_pages: INVENTORY_MAX_PAGES, max_documents: INVENTORY_MAX_PAGES * INVENTORY_DOCUMENT_PAGE_SIZE,
  }, complete: page.scanned < limit };
}

/** Daily scheduling needs durable run receipts, not document inventory. */
export async function sourceFreshnessPage(env, { now = Date.now() } = {}) {
  const before = await marker(env);
  const inventory = await sourceInventorySlice(env, { now, documentPage: { after: 0, limit: 0 } });
  if (await marker(env) !== before) fail("source_inventory_changed");
  return inventory.rows.map((row) => {
    const { coverage: _coverage, ...freshness } = row.freshness;
    return { name: row.name, kind: row.kind, freshness, receipt: {
      last_successful_run_at: row.receipt?.last_successful_run_at ?? null,
      latest_run: row.receipt?.latest_run ?? null,
    } };
  });
}
