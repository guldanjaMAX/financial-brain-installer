/**
 * Verified, append-only correction links for conversational memories.
 *
 * `metadata.supersedes` is intent supplied by the caller. It never gets to
 * suppress a document by itself. This module resolves that intent to one exact
 * live memory record, limits eligible targets to records the conversational
 * writer actually owns, and records the relationship in the dedicated D1
 * ledger only after the successor has been read back exactly.
 */

import {
  OWNER_NOTES_SOURCE,
  ownerNoteWriteProvenance,
  publicOwnerNoteProvenance,
} from "./owner-note-contract.js";

export const LEGACY_MCP_SOURCE = "curated";
const MEMORY_SUPERSESSION_SCHEMA_VERSION = 37;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export class MemorySupersessionError extends Error {
  constructor(message, { code = "memory_supersession_refused", status = 409 } = {}) {
    super(message);
    this.name = "MemorySupersessionError";
    this.code = code;
    this.status = status;
  }
}

function parsedMetadata(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isLessonId(value) {
  return /^lesson\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:-[a-f0-9]{64})?$/.test(String(value || ""));
}

function exactContentHash(value) {
  return SHA256_HEX.test(String(value || ""));
}

function missingMemorySupersessionTable(error) {
  const message = String(error?.message || error || "");
  return /(?:no such table[^\n]*memory_supersessions|memory_supersessions[^\n]*(?:does not exist|not found))/i.test(message);
}

/**
 * The hybrid search layer normally contains a failed modality so keyword and
 * vector retrieval can degrade independently. A missing correction ledger is
 * different: once schema 37 is installed, either modality returning results
 * without the current-memory predicate could resurface a known-wrong record.
 * The schema-36 compatibility fallback consumes this error before it reaches
 * the hybrid layer, so any remaining missing-table error is an integrity stop.
 */
export function memorySupersessionIntegrityFailure(error) {
  return missingMemorySupersessionTable(error);
}

/**
 * A release Worker is deliberately deployed in paused mode before its pending
 * migrations run. Schema 36 therefore needs to remain readable during that
 * window. Never use this fallback for a schema that claims migration 0037:
 * a missing ledger there is corruption, and current-answer reads must fail
 * closed instead of resurfacing a known-wrong memory.
 */
export async function legacySchemaMayReadWithoutMemorySupersessions(env, error) {
  if (!missingMemorySupersessionTable(error)) return false;
  try {
    const installed = await env.DB.prepare(
      "SELECT schema_version FROM install_state WHERE id=1"
    ).first();
    const version = Number(installed?.schema_version);
    return Number.isSafeInteger(version) && version < MEMORY_SUPERSESSION_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

function targetRefusal(row) {
  if (!row) return {
    code: "memory_supersession_target_not_found",
    status: 404,
    message: "No live Brain record has that id. Search again and pass the exact id returned with the result. Nothing was written.",
  };
  if (row.deleted_at !== null && row.deleted_at !== undefined) return {
    code: "memory_supersession_target_not_live",
    status: 409,
    message: "That record is no longer live. Search again for the current memory before correcting it. Nothing was written.",
  };
  const metadata = parsedMetadata(row.meta);
  if (row.category !== "lesson" || metadata?.category !== "lesson") return {
    code: "memory_supersession_cross_category",
    status: 409,
    message: "This correction tool can replace only a conversational memory in the lesson category. It cannot suppress a source document or owner-confirmed record. Nothing was written.",
  };
  if (!isLessonId(row.source_id)) return {
    code: "memory_supersession_target_unsafe",
    status: 409,
      message: "That record does not have a reviewed conversational-memory identity. Use the owner controls to reconcile it instead. Nothing was written.",
  };
  if (row.doc_uid !== `${row.source}:${row.source_id}` || !exactContentHash(row.content_hash)) return {
    code: "memory_supersession_target_unsafe",
    status: 409,
    message: "That record does not have a complete conversational-memory identity and content receipt. Use the owner controls to reconcile it instead. Nothing was written.",
  };
  if (row.source === OWNER_NOTES_SOURCE) {
    if (!publicOwnerNoteProvenance(row.source, metadata)) return {
      code: "memory_supersession_target_unsafe",
      status: 409,
      message: "That owner-note record does not have verified conversational provenance. Use the owner controls to reconcile it instead. Nothing was written.",
    };
    return null;
  }
  // The old remote MCP writer used `curated`, category=lesson and the closed
  // written_by=connector marker. Older local writes carried no actor marker,
  // so they are intentionally not guessed at here.
  if (row.source === LEGACY_MCP_SOURCE && metadata?.written_by === "connector" &&
      !Object.hasOwn(metadata, "owner_confirmed") && !Object.hasOwn(metadata, "operative")) {
    return null;
  }
  return {
    code: "memory_supersession_target_unsafe",
    status: 409,
    message: "That record belongs to a primary, imported, or owner-confirmed source. A conversational note cannot suppress it. Use the owner controls to reconcile that source instead. Nothing was written.",
  };
}

async function targetRows(env, requested) {
  const exact = await env.DB.prepare(
    `SELECT doc_uid,source,source_id,category,content_hash,meta,deleted_at
       FROM documents WHERE doc_uid=?1`
  ).bind(requested).first();
  if (exact) return { exact: true, rows: [exact] };
  const result = await env.DB.prepare(
    `SELECT doc_uid,source,source_id,category,content_hash,meta,deleted_at
       FROM documents
      WHERE source_id=?1 AND source IN (?2,?3)
      ORDER BY doc_uid LIMIT 3`
  ).bind(requested, OWNER_NOTES_SOURCE, LEGACY_MCP_SOURCE).all();
  return { exact: false, rows: result?.results || [] };
}

/** Resolve caller intent before storage. No result from here authorizes a write. */
export async function prepareMemorySupersession(env, {
  requestedTarget,
  successorDocUid,
  successorContentHash,
  channel,
}) {
  const requested = String(requestedTarget || "").trim();
  if (!requested) {
    throw new MemorySupersessionError(
      "supersedes must name the exact id returned by Brain search. Nothing was written.",
      { code: "memory_supersession_target_required", status: 400 },
    );
  }
  if (!ownerNoteWriteProvenance(channel)) {
    throw new MemorySupersessionError("The correction channel is not supported. Nothing was written.", {
      code: "memory_supersession_channel_invalid", status: 400,
    });
  }
  if (!exactContentHash(successorContentHash)) {
    throw new MemorySupersessionError(
      "The correction does not have an exact content receipt. Retry the same correction; nothing was written.",
      { code: "memory_supersession_successor_hash_invalid", status: 400 },
    );
  }
  const found = await targetRows(env, requested);
  if (!found.exact && found.rows.length > 1) {
    throw new MemorySupersessionError(
      "That short record id matches more than one memory. Search again and pass the full source:source_id value. Nothing was written.",
      { code: "memory_supersession_target_ambiguous", status: 409 },
    );
  }
  const target = found.rows[0] || null;
  const refusal = targetRefusal(target);
  if (refusal) {
    throw new MemorySupersessionError(refusal.message, {
      code: refusal.code, status: refusal.status,
    });
  }
  if (target.doc_uid === successorDocUid) {
    throw new MemorySupersessionError("A memory cannot supersede itself. Nothing was written.", {
      code: "memory_supersession_self_reference", status: 409,
    });
  }

  const prior = await env.DB.prepare(
    `SELECT predecessor_doc_uid,successor_doc_uid,
            predecessor_content_hash,successor_content_hash,channel
       FROM memory_supersessions
      WHERE predecessor_doc_uid=?1 OR successor_doc_uid=?2
         OR predecessor_doc_uid=?2
      LIMIT 3`
  ).bind(target.doc_uid, successorDocUid).all();
  const links = prior?.results || [];
  const exactRetry = links.find((row) =>
    row.predecessor_doc_uid === target.doc_uid &&
    row.successor_doc_uid === successorDocUid &&
    row.predecessor_content_hash === target.content_hash &&
    row.successor_content_hash === successorContentHash &&
    row.channel === channel
  );
  const retriedSuccessorIsHistory = Boolean(exactRetry) && links.some((row) =>
    row.predecessor_doc_uid === successorDocUid
  );
  if (retriedSuccessorIsHistory) {
    throw new MemorySupersessionError(
      "That correction has since been corrected again. Search for the current memory before retrying. Nothing was written.",
      { code: "memory_supersession_target_stale", status: 409 },
    );
  }
  if (links.length && !exactRetry) {
    throw new MemorySupersessionError(
      "That memory has already been corrected, or this correction identity belongs to another record. Search again and correct the current result. Nothing was written.",
      { code: "memory_supersession_target_stale", status: 409 },
    );
  }

  return {
    requested,
    predecessor_doc_uid: target.doc_uid,
    predecessor_content_hash: target.content_hash,
    successor_doc_uid: successorDocUid,
    successor_content_hash: successorContentHash,
    channel,
    exact_retry: Boolean(exactRetry),
  };
}

function eligibleTargetGuard(alias = "predecessor") {
  return `(
    (${alias}.source='${OWNER_NOTES_SOURCE}'
      AND json_valid(${alias}.meta)
      AND json_extract(${alias}.meta,'$.category')='lesson'
      AND json_extract(${alias}.meta,'$.recorded_via') IN ('local_mcp','remote_mcp')
      AND json_extract(${alias}.meta,'$.written_by') IN ('owner_assistant','connector'))
    OR
    (${alias}.source='${LEGACY_MCP_SOURCE}'
      AND json_valid(${alias}.meta)
      AND json_extract(${alias}.meta,'$.category')='lesson'
      AND json_extract(${alias}.meta,'$.written_by')='connector'
      AND json_type(${alias}.meta,'$.owner_confirmed') IS NULL
      AND json_type(${alias}.meta,'$.operative') IS NULL)
  )`;
}

function eligibleSuccessorGuard(alias = "successor") {
  return `(
    (${alias}.source='${OWNER_NOTES_SOURCE}'
      AND ${alias}.category='lesson'
      AND json_valid(${alias}.meta)
      AND json_extract(${alias}.meta,'$.category')='lesson'
      AND (
        (json_extract(${alias}.meta,'$.recorded_via')='local_mcp'
          AND json_extract(${alias}.meta,'$.written_by')='owner_assistant'
          AND json_extract(${alias}.meta,'$.agent_profile')='owner-assistant')
        OR
        (json_extract(${alias}.meta,'$.recorded_via')='remote_mcp'
          AND json_extract(${alias}.meta,'$.written_by')='connector'
          AND json_extract(${alias}.meta,'$.agent_profile')='structured-contributor')
      ))
  )`;
}

/** Link the two exact rows after the successor has passed owner-note readback. */
export async function finalizeMemorySupersession(env, context, { now = Date.now() } = {}) {
  if (!context) return null;
  const provenance = ownerNoteWriteProvenance(context.channel);
  if (!provenance) {
    throw new MemorySupersessionError("The correction channel could not be verified.", {
      code: "memory_supersession_channel_invalid", status: 400,
    });
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO memory_supersessions
       (predecessor_doc_uid,successor_doc_uid,predecessor_content_hash,
        successor_content_hash,channel,created_at)
     SELECT predecessor.doc_uid,successor.doc_uid,
            predecessor.content_hash,successor.content_hash,?5,?6
       FROM documents predecessor, documents successor
      WHERE predecessor.doc_uid=?1 AND predecessor.deleted_at IS NULL
        AND predecessor.content_hash=?2 AND predecessor.category='lesson'
        AND successor.doc_uid=?3 AND successor.deleted_at IS NULL
        AND successor.content_hash=?4 AND successor.source='${OWNER_NOTES_SOURCE}'
        AND successor.category='lesson' AND json_valid(successor.meta)
        AND json_extract(successor.meta,'$.category')='lesson'
        AND json_extract(successor.meta,'$.recorded_via')=?5
        AND json_extract(successor.meta,'$.written_by')=?7
        AND json_extract(successor.meta,'$.agent_profile')=?8
        AND json_type(successor.meta,'$.supersedes')='text'
        AND length(trim(json_extract(successor.meta,'$.supersedes'))) > 0
        AND json_extract(successor.meta,'$.supersedes')=?9
        AND ${eligibleTargetGuard("predecessor")}`
  ).bind(
    context.predecessor_doc_uid,
    context.predecessor_content_hash,
    context.successor_doc_uid,
    context.successor_content_hash,
    context.channel,
    now,
    provenance.written_by,
    provenance.agent_profile,
    context.requested,
  ).run();

  const linked = await env.DB.prepare(
    `SELECT predecessor_doc_uid,successor_doc_uid,
            predecessor_content_hash,successor_content_hash,channel,created_at
       FROM memory_supersessions
      WHERE predecessor_doc_uid=?1 OR successor_doc_uid=?2
         OR predecessor_doc_uid=?2
      ORDER BY predecessor_doc_uid LIMIT 3`
  ).bind(context.predecessor_doc_uid, context.successor_doc_uid).all();
  const rows = linked?.results || [];
  const exact = rows.length === 1 &&
    rows[0].predecessor_doc_uid === context.predecessor_doc_uid &&
    rows[0].successor_doc_uid === context.successor_doc_uid &&
    rows[0].predecessor_content_hash === context.predecessor_content_hash &&
    rows[0].successor_content_hash === context.successor_content_hash &&
    rows[0].channel === context.channel;
  if (!exact) {
    throw new MemorySupersessionError(
      "The correction could not claim the exact current memory. Search again before retrying; do not treat the new note as current.",
      { code: "memory_supersession_commit_conflict", status: 409 },
    );
  }
  return {
    predecessor_doc_uid: rows[0].predecessor_doc_uid,
    successor_doc_uid: rows[0].successor_doc_uid,
    status: "current",
    history_preserved: true,
    action: context.exact_retry ? "unchanged" : "linked",
  };
}

/**
 * D1 predicate shared by keyword and vector hydration. A predecessor enters
 * history only through the verified ledger. A not-yet-linked correction stays
 * invisible, so a failed or racing write can never become current by accident.
 */
export function currentMemorySql(documentAlias = "d") {
  return `
    AND NOT EXISTS (
      SELECT 1 FROM memory_supersessions old_memory
       WHERE old_memory.predecessor_doc_uid=${documentAlias}.doc_uid
         AND old_memory.predecessor_content_hash=${documentAlias}.content_hash
         AND ${eligibleTargetGuard(documentAlias)}
    )
    AND NOT (
      ${documentAlias}.source='${OWNER_NOTES_SOURCE}'
      AND CASE WHEN json_valid(${documentAlias}.meta)
               THEN json_type(${documentAlias}.meta,'$.supersedes') IS NOT NULL
               ELSE 0 END
      AND NOT EXISTS (
        SELECT 1 FROM memory_supersessions current_memory
         WHERE current_memory.successor_doc_uid=${documentAlias}.doc_uid
           AND current_memory.successor_content_hash=${documentAlias}.content_hash
           AND current_memory.channel=json_extract(${documentAlias}.meta,'$.recorded_via')
           AND ${eligibleSuccessorGuard(documentAlias)}
      )
    )`;
}

function historyTime(value) {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

/** Public, content-free history marker for an exact fetch. */
export async function memoryHistoryForDocument(env, docUid, { source, metadata, contentHash } = {}) {
  let result = { results: [] };
  if (exactContentHash(contentHash)) {
    try {
      result = await env.DB.prepare(
        `SELECT predecessor_doc_uid,successor_doc_uid,created_at
           FROM memory_supersessions
          WHERE (predecessor_doc_uid=?1 AND predecessor_content_hash=?2)
             OR (successor_doc_uid=?1 AND successor_content_hash=?2)
          ORDER BY predecessor_doc_uid`
      ).bind(docUid, contentHash).all();
    } catch (error) {
      if (!await legacySchemaMayReadWithoutMemorySupersessions(env, error)) throw error;
    }
  }
  const rows = result?.results || [];
  const outgoing = rows.find((row) => row.predecessor_doc_uid === docUid) || null;
  const incoming = rows.find((row) => row.successor_doc_uid === docUid) || null;
  if (outgoing) {
    const changedAt = historyTime(outgoing.created_at);
    return {
      status: "superseded",
      current: false,
      visible_in_search: false,
      superseded_by: outgoing.successor_doc_uid,
      ...(incoming ? { corrects: incoming.predecessor_doc_uid } : {}),
      ...(changedAt ? { changed_at: changedAt } : {}),
    };
  }
  if (incoming) {
    const changedAt = historyTime(incoming.created_at);
    return {
      status: "current_correction",
      current: true,
      visible_in_search: true,
      corrects: incoming.predecessor_doc_uid,
      ...(changedAt ? { changed_at: changedAt } : {}),
    };
  }
  const meta = parsedMetadata(metadata);
  if (source === OWNER_NOTES_SOURCE && meta && Object.hasOwn(meta, "supersedes")) {
    return {
      status: "unconfirmed_correction",
      current: false,
      visible_in_search: false,
    };
  }
  return null;
}
