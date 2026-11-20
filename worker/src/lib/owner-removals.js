// "Clean my Brain": the owner-removal ledger, its proof reads and the counter
// check. Schema 70 owns the table; schema 65 owns the counters this verifies.
//
// A removal the owner approved is remembered by the item's OWN base id
// (gmail:<messageId>, drive:<fileId>: the document uid with any "#part..."
// suffix removed) so a full re-read of Gmail or Drive cannot bring it back.
// Never by a shared file family: one export file can hold many independent
// documents, and removing one must not block its kept siblings. Only Gmail and
// Drive items are remembered; that is the whole scope of "Clean my Brain".
// Only `brain clean` writes the ledger. Removals that ingest plans for itself
// (a source deleted, a policy change) never do, so an item the owner restores in
// Gmail or Drive can still come back through an ordinary ingest.
import { isCanonicalStoredFamilyUid } from "./stored-family-identity.js";
import { outboxDepth } from "./store-d1.js";

export const OWNER_REMOVED_LABEL = "owner_removed";
export const OWNER_REMOVAL_LEDGER_SCHEMA = 70;
export const OWNER_REMOVAL_CHECK_MAX = 97;
const BIND_LIMIT = 90;

export class OwnerRemovalError extends Error {
  constructor(message, code = "OWNER_REMOVAL_INVALID", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Sources "Clean my Brain" works on. Anything else is refused, never remembered. */
export const OWNER_REMOVAL_SOURCES = Object.freeze(["gmail", "drive"]);

/** The base id of one stored or incoming document: its uid without "#part..." parts. */
export const ownerRemovalBaseUid = (uid) => {
  const text = String(uid);
  const at = text.indexOf("#part");
  return at < 0 ? text : text.slice(0, at);
};

/**
 * Ledger keys an incoming envelope is checked against: its own base id, plus
 * the item it declares itself a part of (family_of or part_of, source-prefixed),
 * so an attachment or a split part of a removed item stays out with it. A
 * declared family that is not itself a removed item matches nothing.
 */
export function envelopeOwnerRemovalKeys(envelope) {
  const source = envelope?.source_type;
  if (!OWNER_REMOVAL_SOURCES.includes(source) || envelope?.source_id == null) return [];
  const keys = new Set([ownerRemovalBaseUid(`${source}:${envelope.source_id}`)]);
  const metadata = envelope.metadata && typeof envelope.metadata === "object" ? envelope.metadata : {};
  for (const declared of [metadata.family_of, metadata.part_of]) {
    if (typeof declared !== "string" || !declared) continue;
    keys.add(ownerRemovalBaseUid(declared.startsWith(`${source}:`) ? declared : `${source}:${declared}`));
  }
  return [...keys];
}

/** True when the ledger names this envelope's own item or the item it belongs to. */
export const envelopeIsOwnerRemoved = (envelope, removed) =>
  envelopeOwnerRemovalKeys(envelope).some((key) => removed.has(key));

/** Does this Brain have the ledger table? A schema number alone is not proof. */
export async function ownerRemovalLedgerPresent(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owner_removals') AS present",
    ).bind().first();
    return Number(row?.present) === 1;
  } catch {
    return false;
  }
}

const missingLedger = (error) => /no such table:\s*(?:main\.)?owner_removals\b/i.test(String(error?.message));

/** Live ledger rows among these family keys. An older schema has none. */
export async function ownerRemovedAmong(env, familyUids) {
  const wanted = [...new Set((familyUids || []).filter((uid) => typeof uid === "string" && uid))];
  const removed = new Set();
  for (let i = 0; i < wanted.length; i += BIND_LIMIT) {
    const group = wanted.slice(i, i + BIND_LIMIT);
    const marks = group.map((_, index) => `?${index + 1}`).join(",");
    let rows;
    try {
      ({ results: rows } = await env.DB.prepare(
        `SELECT family_uid FROM owner_removals WHERE restored_at IS NULL AND family_uid IN (${marks})`,
      ).bind(...group).all());
    } catch (error) {
      if (missingLedger(error)) return new Set();
      throw error;
    }
    for (const row of rows || []) removed.add(row.family_uid);
  }
  return removed;
}

function sourceOfFamily(uid) {
  return uid.slice(0, uid.indexOf(":"));
}

function checkedFamilies(families, max) {
  if (!Array.isArray(families) || families.length < 1 || families.length > max ||
      new Set(families).size !== families.length ||
      families.some((uid) => !isCanonicalStoredFamilyUid(uid))) {
    throw new OwnerRemovalError(`Give 1 to ${max} unique canonical item identities.`);
  }
  if (families.some((uid) => !OWNER_REMOVAL_SOURCES.includes(sourceOfFamily(uid)))) {
    throw new OwnerRemovalError("Clean my Brain remembers only Gmail and Drive items.",
      "OWNER_REMOVAL_SOURCE_UNSUPPORTED");
  }
  if (families.some((uid) => uid.includes("#part"))) {
    throw new OwnerRemovalError("Give the item's base id, without a #part suffix.");
  }
  return families;
}

const checkedRunId = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw new OwnerRemovalError("run_id must be 8 to 64 letters, numbers, underscores or hyphens.");
  }
  return value;
};

/**
 * Backfill the ledger for families that are already gone (the removals made
 * before the ledger existed). A family that still has a live document is
 * refused: remembering it would only make the next ingest fail.
 */
export async function rememberOwnerRemovals(env, { families, run_id: runId, reason = "owner_removal", marker, now = Date.now } = {}) {
  checkedFamilies(families, 50);
  checkedRunId(runId);
  if (typeof reason !== "string" || !/^[a-z0-9_ -]{1,64}$/.test(reason)) {
    throw new OwnerRemovalError("reason must be short lowercase words.");
  }
  const marks = families.map((_, index) => `?${index + 1}`).join(",");
  const { results: live } = await env.DB.prepare(
    `SELECT family_doc_uid AS uid FROM document_family_index
      WHERE live = 1 AND family_doc_uid IN (${marks})
     UNION ALL
     SELECT doc_uid FROM documents WHERE doc_uid IN (${marks})`,
  ).bind(...families).all();
  if ((live || []).length) {
    throw new OwnerRemovalError(
      "Some of these families still have stored documents; remove them with brain clean first.",
      "OWNER_REMOVAL_FAMILY_LIVE", 409);
  }
  const at = now();
  let fence = [];
  if (marker !== undefined) {
    if (!marker || typeof marker.instance !== "string" || typeof marker.nonce !== "string" ||
        !Number.isSafeInteger(marker.generation) || marker.runtime !== env.INGEST_VERSION?.id) {
      throw new OwnerRemovalError("Removal inventory changed.", "INGEST_REMOVAL_CHANGED", 409);
    }
    fence = [env.DB.prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM ingest_removal_generation
          WHERE id=1 AND instance=?1 AND generation=?2 AND nonce=?3
       ) THEN 1 ELSE json('removal inventory changed') END AS verified`,
    ).bind(marker.instance, marker.generation, marker.nonce)];
  }
  await env.DB.batch([...fence, ...families.map((uid) => env.DB.prepare(
    `INSERT INTO owner_removals (family_uid, source, provider_id, removed_at, run_id, batch_no, reason)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
     ON CONFLICT(family_uid) DO UPDATE SET restored_at=NULL, removed_at=excluded.removed_at,
       run_id=excluded.run_id, reason=excluded.reason`,
  ).bind(uid, sourceOfFamily(uid), uid.slice(uid.indexOf(":") + 1), at, runId, reason))]);
  return { remembered: families.length };
}

/** Undo: the row stays, with its why, and stops blocking. */
export async function restoreOwnerRemovals(env, { families, now = Date.now } = {}) {
  checkedFamilies(families, 50);
  const marks = families.map((_, index) => `?${index + 2}`).join(",");
  const { results } = await env.DB.prepare(
    `UPDATE owner_removals SET restored_at = ?1
      WHERE restored_at IS NULL AND family_uid IN (${marks}) RETURNING family_uid`,
  ).bind(now(), ...families).all();
  return { restored: (results || []).length };
}

/**
 * Exact proof that one apply batch committed, for a caller whose request
 * returned a 5xx after the delete may have gone through: every target is gone
 * and the ledger carries this run and batch. Neither fact alone is proof.
 */
export async function ownerRemovalBatchProof(env, { run_id: runId, batch_no: batchNo, targets } = {}) {
  checkedRunId(runId);
  if (!Number.isSafeInteger(batchNo) || batchNo < 0) throw new OwnerRemovalError("batch_no must be a non-negative integer.");
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 50 ||
      targets.some((uid) => typeof uid !== "string" || !uid) || new Set(targets).size !== targets.length) {
    throw new OwnerRemovalError("Give 1 to 50 exact document identities.");
  }
  const marks = targets.map((_, index) => `?${index + 1}`).join(",");
  const roots = [...new Set(targets.map(ownerRemovalBaseUid))];
  const rootMarks = roots.map((_, index) => `?${index + 3}`).join(",");
  const [{ results: left }, ledger] = await Promise.all([
    env.DB.prepare(`SELECT doc_uid FROM documents WHERE doc_uid IN (${marks})`).bind(...targets).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n,
       SUM(CASE WHEN family_uid IN (${rootMarks}) THEN 1 ELSE 0 END) AS matched
       FROM owner_removals WHERE run_id = ?1 AND batch_no = ?2 AND restored_at IS NULL`)
      .bind(runId, batchNo, ...roots).first(),
  ]);
  const remaining = (left || []).length;
  const ledgerRows = Number(ledger?.n || 0);
  return {
    committed: remaining === 0 && ledgerRows === roots.length && Number(ledger?.matched) === roots.length,
    remaining_documents: remaining,
    ledger_rows: ledgerRows,
  };
}

/**
 * Counter check that never scans chunk text and never writes unless asked.
 * Schema 65 keeps corpus_stats exact on every row change, so this is a safety
 * net, not a step a removal depends on. chunks.source also counts chunks of
 * soft-deleted documents; those are subtracted, as the counters never held them.
 *
 * Both the read and the repair are ONE statement each, so a Gmail or Drive
 * ingest running at the same time can never produce a half-old, half-new
 * comparison, and a repair writes the counts it computed in its own statement,
 * never numbers read earlier.
 */
const EXACT_COUNTS_SQL = `
  SELECT (SELECT COUNT(*) FROM documents WHERE source = ?1 AND deleted_at IS NULL) AS documents,
         (SELECT COUNT(*) FROM chunks WHERE source = ?1)
           - (SELECT COUNT(*) FROM chunks
               WHERE doc_uid IN (SELECT doc_uid FROM documents WHERE source = ?1 AND deleted_at IS NOT NULL)) AS chunks,
         (SELECT documents FROM corpus_stats WHERE source = ?1) AS stored_documents,
         (SELECT chunks FROM corpus_stats WHERE source = ?1) AS stored_chunks`;

const REPAIR_COUNTS_SQL = `
  INSERT INTO corpus_stats (source, documents, chunks)
  SELECT ?1,
         (SELECT COUNT(*) FROM documents WHERE source = ?1 AND deleted_at IS NULL),
         (SELECT COUNT(*) FROM chunks WHERE source = ?1)
           - (SELECT COUNT(*) FROM chunks
               WHERE doc_uid IN (SELECT doc_uid FROM documents WHERE source = ?1 AND deleted_at IS NOT NULL))
   WHERE 1
  ON CONFLICT(source) DO UPDATE SET documents = excluded.documents, chunks = excluded.chunks`;

export async function verifyCorpusStats(env, { source, repair = false, instance } = {}) {
  if (instance !== undefined && (typeof instance !== "string" || !/^[a-f0-9]{32}$/.test(instance))) {
    throw new OwnerRemovalError("Invalid counter repair target.");
  }
  if (typeof source !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) {
    throw new OwnerRemovalError("source must contain only lowercase letters, numbers, underscores or hyphens.");
  }
  const row = await env.DB.prepare(EXACT_COUNTS_SQL).bind(source).first();
  const exact = { documents: Number(row?.documents || 0), chunks: Number(row?.chunks || 0) };
  const counters = { documents: Number(row?.stored_documents || 0), chunks: Number(row?.stored_chunks || 0) };
  const matches = exact.documents === counters.documents && exact.chunks === counters.chunks;
  let repaired = false;
  if (!matches && repair) {
    if (instance === undefined) {
      await env.DB.prepare(REPAIR_COUNTS_SQL).bind(source).run();
    } else {
      const result = await env.DB.prepare(REPAIR_COUNTS_SQL.replace("WHERE 1",
        "WHERE EXISTS (SELECT 1 FROM ingest_removal_generation WHERE id=1 AND instance=?2)"))
        .bind(source, instance).run();
      if (result?.meta?.changes !== 1) throw new OwnerRemovalError("The Brain target changed.", "INGEST_REMOVAL_CHANGED", 409);
    }
    repaired = true;
  }
  return {
    source, matches, repaired, exact, counters,
    ...(matches ? {} : { code: "CLEAN_COUNTERS_DRIFTED" }),
  };
}

/**
 * The Brain's size for the 20% check and the before/after report, and the depth
 * of the vector clean-up queue. Two cheap reads: corpus_stats has one row per
 * source, and the queue depth is capped by the Worker at 10,001.
 */
export async function ownerRemovalSize(env) {
  const { results } = await env.DB.prepare("SELECT source, documents FROM corpus_stats").bind().all();
  const sources = {};
  let documents = 0;
  for (const row of results || []) {
    const count = Number(row.documents);
    if (!Number.isSafeInteger(count) || count < 0) throw new OwnerRemovalError("The stored document counts are unreadable.", "OWNER_REMOVAL_UNAVAILABLE", 503);
    sources[row.source] = count;
    documents += count;
  }
  let backlog = null;
  try {
    const depth = await outboxDepth(env);
    backlog = { pending: Number(depth.pending), pending_is_capped: depth.pending_is_capped === true };
  } catch { /* the size is still right; the caller treats an unknown queue as empty */ }
  return { documents, sources, vector_backlog: backlog };
}

/** One bounded read of the ledger for a client about to skip a re-read. */
export async function checkOwnerRemovals(env, { source, uids } = {}) {
  if (typeof source !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) {
    throw new OwnerRemovalError("source must contain only lowercase letters, numbers, underscores or hyphens.");
  }
  if (!Array.isArray(uids) || uids.length < 1 || uids.length > OWNER_REMOVAL_CHECK_MAX ||
      new Set(uids).size !== uids.length || uids.some((uid) => !isCanonicalStoredFamilyUid(uid, source))) {
    throw new OwnerRemovalError(`Give 1 to ${OWNER_REMOVAL_CHECK_MAX} unique canonical identities for the source.`);
  }
  return { owner_removed: [...await ownerRemovedAmong(env, uids)].sort() };
}

const ownerRemovalActions = new Set(["check", "remember", "restore", "proof", "size"]);

export async function readOwnerRemovalRequest(request) {
  const limit = 64 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new OwnerRemovalError("Request is too large.", "OWNER_REMOVAL_INVALID", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > limit) throw new OwnerRemovalError("Request is too large.", "OWNER_REMOVAL_INVALID", 413);
  let body;
  try { body = JSON.parse(raw); } catch { throw new OwnerRemovalError("Request must be a JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !ownerRemovalActions.has(body.action)) {
    throw new OwnerRemovalError("Choose check, remember, restore, proof or size.");
  }
  const allowed = {
    check: ["action", "source", "uids"],
    remember: ["action", "families", "run_id", "reason", "marker"],
    restore: ["action", "families"],
    proof: ["action", "run_id", "batch_no", "targets"],
    size: ["action"],
  }[body.action];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new OwnerRemovalError("Request has an unknown field.");
  return body;
}

export async function handleOwnerRemovals(env, body) {
  switch (body.action) {
    case "check": return checkOwnerRemovals(env, body);
    case "remember": return rememberOwnerRemovals(env, body);
    case "restore": return restoreOwnerRemovals(env, body);
    case "size": return ownerRemovalSize(env);
    default: return ownerRemovalBatchProof(env, body);
  }
}

/** Failure shape for the ledger routes. Only fixed codes cross the boundary. */
export function ownerRemovalFailure(error) {
  if (error instanceof OwnerRemovalError) return { status: error.status, code: error.code, error: error.message };
  return { status: 503, code: "OWNER_REMOVAL_UNAVAILABLE", error: "The removal ledger could not be read. Nothing was changed by this request." };
}
