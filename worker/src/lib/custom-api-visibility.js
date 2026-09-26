/** SQL shared by every document reader that can expose custom API content. */
export function currentCustomApiDocumentSql(alias = "d") {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError("invalid SQL alias");
  const meta = `${alias}.meta`;
  const connector = `CASE WHEN json_valid(${meta}) THEN json_extract(${meta},'$.connector') END`;
  const logicalSourceId = `CASE WHEN json_valid(${meta}) THEN json_extract(${meta},'$.custom_api_source_id') END`;
  return ` AND (COALESCE(${connector},'')<>'custom_api' OR EXISTS (
    SELECT 1 FROM custom_api_current_jobs custom_api_current
    JOIN custom_api_document_versions custom_api_version
      ON custom_api_version.source=custom_api_current.source
     AND custom_api_version.job_id=custom_api_current.job_id
     WHERE custom_api_current.source=${alias}.source
       AND custom_api_version.logical_source_id=${logicalSourceId}
       AND custom_api_version.document_source_id=${alias}.source_id
  ))`;
}

/** Render a closed custom-source issue code only at an owner-facing boundary. */
export function customApiOwnerMessage(code, displayName = "custom business API") {
  const name = String(displayName || "custom business API").replace(/\s+/g, " ").trim().slice(0, 80) || "custom business API";
  if (code === "AUTH_REQUIRED") return `The ${name} refused the key. Ask its developer to check it.`;
  if (code === "RATE_LIMITED") return `The ${name} asked the Brain to wait. It will try again on the next scheduled pull.`;
  if (code === "REMOTE_UNAVAILABLE" || code === "NETWORK_UNREACHABLE") return `The ${name} could not be reached. The saved data was left unchanged.`;
  if (code === "RESPONSE_TOO_LARGE") return `The ${name} returned more data than this source allows. That endpoint was left unchanged. Ask its developer to add paging or narrow the endpoint.`;
  if (code === "REDIRECT_REFUSED") return `The ${name} tried to send the Brain to another address. The pull was refused before following it.`;
  if (code === "PERSISTENCE_VERIFY_FAILED") return `The Brain could not verify the saved ${name} update. The source remains marked for installer review.`;
  if (code === "CONFIG_INVALID") return `The ${name} setup is not valid. Ask the installer to review its manifest mapping.`;
  return `The ${name} returned data the Brain could not safely understand. The saved data was left unchanged.`;
}

export function customApiVersionedSourceId(sourceId, jobId) {
  return `${sourceId}:job:${jobId}`;
}

export function customApiLogicalSourceId(metadata, fallback) {
  let parsed = metadata;
  if (typeof metadata === "string") {
    try { parsed = JSON.parse(metadata); } catch { parsed = null; }
  }
  return parsed?.connector === "custom_api" && typeof parsed.custom_api_source_id === "string" && parsed.custom_api_source_id
    ? parsed.custom_api_source_id
    : fallback;
}

export function customApiPointerTableMissing(error) {
  return /no such table:\s*custom_api_(?:current_jobs|document_versions)\b/i.test(String(error?.message || error));
}

/**
 * The fail-closed clause for a schema without the 0048 pointer tables. Such a
 * Brain has no custom API documents, so "no custom API tables" reads as "no
 * custom API documents". A stale answer can only hide a custom API row, never
 * expose a staged or superseded version that the pointer would have excluded.
 */
export function absentCustomApiDocumentSql(alias = "d") {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError("invalid SQL alias");
  const meta = `${alias}.meta`;
  return ` AND COALESCE(CASE WHEN json_valid(${meta}) THEN json_extract(${meta},'$.connector') END,'')<>'custom_api'`;
}

/** The visibility clause for one reader, given whether the pointer tables exist. */
export function customApiVisibilitySql(alias, pointerTablesPresent) {
  return pointerTablesPresent ? currentCustomApiDocumentSql(alias) : absentCustomApiDocumentSql(alias);
}

const CUSTOM_API_POINTER_TABLES = Object.freeze(["custom_api_current_jobs", "custom_api_document_versions"]);
// A present answer is permanent: migrations only move forward. An absent answer
// is rechecked, because an older Brain gains 0048 mid-upgrade while this
// isolate may still be serving. Keyed by the D1 binding so separate databases
// never share an answer.
const CUSTOM_API_ABSENT_RECHECK_MS = 60_000;
const pointerTableState = new WeakMap();

function cachedCustomApiPointerTables(env, now = Date.now) {
  const db = env?.DB;
  if (!db || (typeof db !== "object" && typeof db !== "function")) return null;
  const cached = pointerTableState.get(db);
  if (cached?.present === true) return true;
  if (cached?.present === false && now() - cached.checkedAt < CUSTOM_API_ABSENT_RECHECK_MS) return false;
  return null;
}

/**
 * Whether both 0048 pointer tables exist: true, false, or null when the probe
 * itself could not answer. Checked by name against sqlite_master, once per
 * isolate, so a partially applied migration (D1 commits per statement) reads
 * as absent rather than claiming the pair from its first table.
 */
export async function customApiPointerTablesPresent(env, { now = Date.now } = {}) {
  const db = env?.DB;
  if (!db || (typeof db !== "object" && typeof db !== "function")) return null;
  const cached = cachedCustomApiPointerTables(env, now);
  if (cached !== null) return cached;
  let rows;
  try {
    const result = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?1,?2)",
    ).bind(...CUSTOM_API_POINTER_TABLES).all();
    rows = result?.results;
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.name !== "string")) return null;
  const names = new Set(rows.map((row) => row.name));
  const present = CUSTOM_API_POINTER_TABLES.every((name) => names.has(name));
  pointerTableState.set(db, { present, checkedAt: now() });
  return present;
}

/**
 * Run one document reader with the right custom API visibility clause. The
 * reader receives true for the pointer clause and false for the fail-closed
 * absent clause. An unanswerable probe tries the pointer clause, and a missing
 * pointer table still downgrades to the absent clause instead of an error.
 *
 * `probe: false` is for readers that account for every D1 statement they
 * issue: they use a cached answer when one exists and otherwise learn it from
 * the reader's own first statement, without a separate probe.
 */
export async function readWithCustomApiVisibility(env, run, { probe = true } = {}) {
  const present = probe ? await customApiPointerTablesPresent(env) : cachedCustomApiPointerTables(env);
  if (present === false) return run(false);
  try {
    const result = await run(true);
    const db = env?.DB;
    if (!probe && db && (typeof db === "object" || typeof db === "function")) {
      pointerTableState.set(db, { present: true, checkedAt: Date.now() });
    }
    return result;
  } catch (error) {
    if (!customApiPointerTableMissing(error)) throw error;
    const db = env?.DB;
    if (db && (typeof db === "object" || typeof db === "function")) {
      pointerTableState.set(db, { present: false, checkedAt: Date.now() });
    }
    return run(false);
  }
}
