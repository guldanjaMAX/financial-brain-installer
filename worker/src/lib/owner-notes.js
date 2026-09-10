/**
 * Conversational owner notes have one reserved, reversible source lifecycle.
 *
 * The generic ingest route deliberately does not invent source registrations:
 * Drive, Gmail, uploads, and every other producer own their own receipt and
 * history boundary. A local or approved remote MCP write is different. D1 is
 * the durable store for each direct write, so the write path can register it,
 * update its exact count, and prove that one row before reporting success. It
 * does not claim that every historical conversation was captured.
 */

import {
  documentAccessSql, scopeSql, sourceFamilyCounts,
} from "./store-d1.js";
import {
  EVIDENCE_LINEAGE_VERSION, evidenceLineageValidationError,
} from "./evidence-lineage.js";
import { isSourceKindConflict, resolveSourceKind } from "./source-receipt.js";
import {
  OWNER_NOTES_KIND, OWNER_NOTES_SOURCE,
  ownerNoteWriteProvenance, publicOwnerNoteProvenance,
} from "./owner-note-contract.js";
import {
  finalizeMemorySupersession, MemorySupersessionError, prepareMemorySupersession,
} from "./memory-supersession.js";

export {
  OWNER_NOTES_KIND, OWNER_NOTES_ROUTE, OWNER_NOTES_SOURCE,
  ownerNoteWriteProvenance, publicOwnerNoteProvenance,
} from "./owner-note-contract.js";

const RECEIPT_ACTIONS = new Set(["created", "updated", "unchanged"]);
const OWNER_NOTE_LINEAGE_MAX_ROOTS = 16;
const LINEAGE_ID_CONTROL = /[\u0000-\u001f\u007f]/;
export class OwnerNoteLifecycleError extends Error {
  constructor(message, {
    code = "owner_note_lifecycle_failed",
    status = 500,
    mayHaveWritten = false,
  } = {}) {
    super(message);
    this.name = "OwnerNoteLifecycleError";
    this.code = code;
    this.status = status;
    this.may_have_written = mayHaveWritten;
  }
}

function metadataObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return {};
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function lineageFailure(message, { code, status = 422 } = {}) {
  return new OwnerNoteLifecycleError(message, { code, status });
}

function lineageTooLarge() {
  return lineageFailure(
    "The supporting-document lineage is too large to verify safely in one write. Nothing was written.",
    { code: "owner_note_lineage_too_large", status: 413 },
  );
}

function validLineageDocumentId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.includes(":") && !LINEAGE_ID_CONTROL.test(value);
}

function validLineageRootId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !LINEAGE_ID_CONTROL.test(value);
}

/**
 * Read one lineage node through the same exact D1 authorization predicates as
 * retrieval. Returning one generic refusal for absent, deleted, empty, and
 * out-of-scope rows prevents this write path from becoming a document oracle.
 */
async function readableLineageDocument(env, docUid, { scope, access }) {
  const scoped = scopeSql(scope, "d", 2);
  const exact = documentAccessSql(access, "d", "d", scoped.nextParam);
  try {
    const row = await env.DB.prepare(
      `SELECT d.doc_uid, d.meta
         FROM documents d
        WHERE d.doc_uid=?1
          AND d.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM chunks readable_chunk WHERE readable_chunk.doc_uid=d.doc_uid)
          ${scoped.clause}${exact.clause}`,
    ).bind(docUid, ...scoped.params, ...exact.params).first();
    if (row) return row;
  } catch {
    throw lineageFailure(
      "The Brain could not verify the supporting-document lineage. Nothing was written.",
      { code: "owner_note_lineage_unavailable", status: 503 },
    );
  }
  throw lineageFailure(
    "One or more supporting documents could not be confirmed as live and readable in this connection. Nothing was written.",
    { code: "owner_note_lineage_reference_unavailable" },
  );
}

function storedLineageRoots(row) {
  const metadata = metadataObject(row?.meta);
  if (!metadata) {
    throw lineageFailure(
      "A supporting document has unreadable lineage metadata. Nothing was written.",
      { code: "owner_note_lineage_invalid", status: 409 },
    );
  }
  const contractError = evidenceLineageValidationError(metadata);
  if (contractError) {
    throw lineageFailure(
      "A supporting document has invalid lineage metadata. Nothing was written.",
      { code: "owner_note_lineage_invalid", status: 409 },
    );
  }
  const lineage = metadata.evidence_lineage;
  if (lineage && Array.isArray(lineage.root_ids) && lineage.root_ids.length) {
    return [...new Set(lineage.root_ids.map((id) => String(id).trim()))].sort();
  }

  // root_ids and family_of are already durable family identifiers. They may
  // deliberately have no documents row, so neither is recursively resolved as
  // though it were another search result id.
  if ((!lineage || lineage.kind === "source_record") && metadata.family_of !== undefined) {
    const family = typeof metadata.family_of === "string" ? metadata.family_of.trim() : "";
    if (!validLineageRootId(family)) {
      throw lineageFailure(
        "A supporting document has invalid family lineage. Nothing was written.",
        { code: "owner_note_lineage_invalid", status: 409 },
      );
    }
    return [family];
  }
  if (lineage?.kind === "agent_derived" || lineage?.kind === "derived_record") return [];
  return [String(row.doc_uid)];
}

/**
 * Resolve MCP `derived_from` search-result ids to the durable source families
 * already recorded on those exact readable documents before the owner-note
 * source, document, chunks, or outbox can be changed. Recorded roots are
 * terminal identifiers, not document ids to dereference. The returned ids
 * stay server-private storage metadata.
 */
export async function resolveOwnerNoteLineage(env, derivedFrom, {
  scope = { all: true },
  access = null,
  successorDocUid = null,
} = {}) {
  const requested = Array.isArray(derivedFrom)
    ? [...new Set(derivedFrom.map((id) => typeof id === "string" ? id.trim() : id))].sort()
    : null;
  if (!requested || requested.length > OWNER_NOTE_LINEAGE_MAX_ROOTS ||
      requested.some((id) => !validLineageDocumentId(id))) {
    throw lineageTooLarge();
  }
  if (!requested.length) return [];

  const roots = new Set();
  for (const docUid of requested) {
    if (docUid === successorDocUid) {
      throw lineageFailure(
        "The supporting-document lineage contains a cycle. Nothing was written.",
        { code: "owner_note_lineage_cycle", status: 409 },
      );
    }
    const row = await readableLineageDocument(env, docUid, { scope, access });
    for (const root of storedLineageRoots(row)) {
      if (!validLineageRootId(root)) {
        throw lineageFailure(
          "A supporting document has invalid lineage metadata. Nothing was written.",
          { code: "owner_note_lineage_invalid", status: 409 },
        );
      }
      if (root === successorDocUid) {
        throw lineageFailure(
          "The supporting-document lineage contains a cycle. Nothing was written.",
          { code: "owner_note_lineage_cycle", status: 409 },
        );
      }
      roots.add(root);
    }
    if (roots.size > OWNER_NOTE_LINEAGE_MAX_ROOTS) throw lineageTooLarge();
  }
  return [...roots].sort();
}

async function canonicalizeOwnerNoteLineage(env, envelope, { scope, access }) {
  const submitted = envelope.metadata.evidence_lineage;
  if (submitted !== undefined && submitted.kind !== "agent_derived") {
    throw new OwnerNoteLifecycleError(
      "Conversational owner notes must be recorded as agent-derived evidence. Nothing was written.",
      { code: "owner_note_lineage_kind_invalid", status: 400 },
    );
  }
  const directIds = Array.isArray(submitted?.root_ids) ? submitted.root_ids : [];
  const rootIds = await resolveOwnerNoteLineage(env, directIds, {
    scope,
    access,
    successorDocUid: `${OWNER_NOTES_SOURCE}:${envelope.source_id}`,
  });
  envelope.metadata = {
    ...envelope.metadata,
    evidence_lineage: {
      version: EVIDENCE_LINEAGE_VERSION,
      kind: "agent_derived",
      root_ids: rootIds,
    },
  };
  return rootIds;
}

function exactStoredLineage(metadata, expectedRootIds) {
  const value = metadataObject(metadata);
  const lineage = value?.evidence_lineage;
  return lineage?.version === EVIDENCE_LINEAGE_VERSION && lineage?.kind === "agent_derived" &&
    Array.isArray(lineage.root_ids) &&
    JSON.stringify([...lineage.root_ids].sort()) === JSON.stringify([...expectedRootIds].sort());
}

function envelopeError(envelope, provenance) {
  if (String(envelope?.source_type || "") !== OWNER_NOTES_SOURCE) {
    return `conversational writes must use the reserved ${OWNER_NOTES_SOURCE} source`;
  }
  if (!envelope?.metadata || typeof envelope.metadata !== "object" ||
      Array.isArray(envelope.metadata)) {
    return "conversational writes require structured provenance metadata";
  }
  if (envelope.metadata.category !== "lesson") {
    return "conversational writes require the lesson category";
  }
  for (const [key, expected] of Object.entries(provenance)) {
    if (envelope.metadata[key] !== expected) {
      return "conversational write provenance did not match its authenticated channel";
    }
  }
  return null;
}

/**
 * Claim the fixed source only after the ordinary ingest validation and secret
 * scanner have accepted the envelope. Historical rows under this name are not
 * silently adopted: resolveSourceKind refuses that ambiguous boundary.
 */
export async function beginOwnerNoteWrite(env, envelope, {
  channel,
  expectedContentHash,
  scope = { all: true },
  access = null,
} = {}) {
  const provenance = ownerNoteWriteProvenance(channel);
  if (!provenance) {
    throw new OwnerNoteLifecycleError("unsupported owner-note write channel", {
      code: "owner_note_channel_invalid",
      status: 400,
    });
  }
  const invalid = envelopeError(envelope, provenance);
  if (invalid) {
    throw new OwnerNoteLifecycleError(invalid, {
      code: "owner_note_contract_invalid",
      status: 400,
    });
  }
  // This is intentionally the first database-backed owner-note operation.
  // Every caller-supplied search id is live and readable in the caller's exact
  // scope before source registration or any corpus write. Its recorded durable
  // roots are inherited as terminal family identifiers.
  const lineageRootIds = await canonicalizeOwnerNoteLineage(env, envelope, { scope, access });
  let supersession = null;
  if (envelope.metadata.supersedes) {
    const successorDocUid = `${OWNER_NOTES_SOURCE}:${envelope.source_id}`;
    try {
      supersession = await prepareMemorySupersession(env, {
        requestedTarget: envelope.metadata.supersedes,
        successorDocUid,
        successorContentHash: expectedContentHash,
        channel,
      });
    } catch (error) {
      if (!(error instanceof MemorySupersessionError)) throw error;
      throw new OwnerNoteLifecycleError(error.message, {
        code: error.code,
        status: error.status,
      });
    }
  }
  try {
    await resolveSourceKind(env, {
      source: OWNER_NOTES_SOURCE,
      requestedKind: OWNER_NOTES_KIND,
      defaultKind: OWNER_NOTES_KIND,
    });
  } catch (error) {
    if (isSourceKindConflict(error)) {
      throw new OwnerNoteLifecycleError(
        "The owner-notes source already exists with an incompatible or unregistered history. Nothing was written; review that source before retrying.",
        { code: "owner_note_source_conflict", status: 409 },
      );
    }
    throw error;
  }
  return { provenance, supersession, lineageRootIds };
}

/**
 * Make an uncertain write visible in source health without leaking the note or
 * the storage exception. This is best effort because the failure may itself be
 * a D1 outage. An exact retry repairs the same document identity and returns
 * the source to ready only after readback succeeds.
 */
export async function failOwnerNoteWrite(env, {
  now = Date.now(), detail = "owner-note write did not reach exact readback",
} = {}) {
  const at = new Date(now).toISOString();
  let documents = 0;
  try {
    documents = (await sourceFamilyCounts(env, { source: OWNER_NOTES_SOURCE })).logical_documents;
  } catch {
    // The fixed failure state matters more than a denormalized count. Preserve
    // the last known number if even the read is unavailable.
    documents = null;
  }
  const statements = [
    env.DB.prepare(
      `UPDATE sources
          SET status='error', stale_reason=NULL
              ${documents === null ? "" : ", document_count=?1"}
        WHERE name=${documents === null ? "?1" : "?2"} AND kind=${documents === null ? "?2" : "?3"}`
    ).bind(...(documents === null
      ? [OWNER_NOTES_SOURCE, OWNER_NOTES_KIND]
      : [documents, OWNER_NOTES_SOURCE, OWNER_NOTES_KIND])),
    env.DB.prepare(
      `INSERT INTO source_events (source_name,event,at,documents,detail)
       VALUES (?1,'error',?2,?3,?4)`
    ).bind(OWNER_NOTES_SOURCE, at, documents, detail),
  ];
  await env.DB.batch(statements);
  return { status: "error", documents };
}

/**
 * Verify the exact D1 row and source receipt on the primary before returning a
 * successful write. This intentionally does not expose the note body or hash.
 */
export async function completeOwnerNoteWrite(env, envelope, receipt, {
  channel,
  now = Date.now(),
  expectedContentHash,
  expectedLineageRootIds = [],
  supersession = null,
} = {}) {
  const provenance = ownerNoteWriteProvenance(channel);
  if (!provenance) {
    throw new OwnerNoteLifecycleError("unsupported owner-note write channel", {
      code: "owner_note_channel_invalid",
      status: 400,
      mayHaveWritten: true,
    });
  }
  const expectedDocUid = `${OWNER_NOTES_SOURCE}:${envelope.source_id}`;
  const action = String(receipt?.action || "");
  if (receipt?.doc_uid !== expectedDocUid || !RECEIPT_ACTIONS.has(action)) {
    throw new OwnerNoteLifecycleError(
      "The Brain accepted the request but did not return the exact owner-note receipt. Retry the same note; do not claim it was saved yet.",
      { code: "owner_note_receipt_unconfirmed", mayHaveWritten: true },
    );
  }

  if (!/^[a-f0-9]{64}$/.test(String(expectedContentHash || ""))) {
    throw new OwnerNoteLifecycleError(
      "The Brain could not establish the expected owner-note content marker. Nothing was claimed as saved.",
      { code: "owner_note_expected_hash_invalid", mayHaveWritten: true },
    );
  }
  const stored = await env.DB.prepare(
    `SELECT doc_uid, source, source_id, title, content_hash, meta
       FROM documents
      WHERE doc_uid=?1 AND deleted_at IS NULL`
  ).bind(expectedDocUid).first();
  const storedProvenance = publicOwnerNoteProvenance(stored?.source, stored?.meta);
  const exactDocument = stored?.doc_uid === expectedDocUid &&
    stored?.source === OWNER_NOTES_SOURCE &&
    stored?.source_id === String(envelope.source_id) &&
    stored?.title === envelope.title &&
    stored?.content_hash === expectedContentHash;
  const exactProvenance = storedProvenance?.channel === provenance.recorded_via &&
    storedProvenance?.actor === provenance.written_by &&
    storedProvenance?.agent_profile === provenance.agent_profile;
  const exactLineage = exactStoredLineage(stored?.meta, expectedLineageRootIds);
  if (!exactDocument || !exactProvenance || !exactLineage) {
    throw new OwnerNoteLifecycleError(
      "The Brain could not read the exact owner note and its provenance back from storage. Retry the same note; do not claim it was saved yet.",
      { code: "owner_note_readback_unconfirmed", mayHaveWritten: true },
    );
  }

  let correction = null;
  if (supersession) {
    try {
      correction = await finalizeMemorySupersession(env, supersession, { now });
    } catch (error) {
      if (!(error instanceof MemorySupersessionError)) throw error;
      throw new OwnerNoteLifecycleError(error.message, {
        code: error.code,
        status: error.status,
        mayHaveWritten: true,
      });
    }
  }

  const counts = await sourceFamilyCounts(env, { source: OWNER_NOTES_SOURCE });
  const at = new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sources
          SET status='ready', last_ingest_at=?1,
              document_count=?2, stale_reason=NULL
        WHERE name=?3 AND kind=?4`
    ).bind(at, counts.logical_documents, OWNER_NOTES_SOURCE, OWNER_NOTES_KIND),
    env.DB.prepare(
      `INSERT INTO source_events (source_name,event,at,documents,detail)
       VALUES (?1,'ingest',?2,?3,?4)`
    ).bind(
      OWNER_NOTES_SOURCE,
      at,
      counts.logical_documents,
      `direct owner note exact_readback=true channel=${provenance.recorded_via} action=${action}`,
    ),
  ]);

  const source = await env.DB.prepare(
    `SELECT name,kind,status,last_ingest_at,last_complete_sweep_at,document_count,zone
       FROM sources WHERE name=?1`
  ).bind(OWNER_NOTES_SOURCE).first();
  const exactSource = source?.name === OWNER_NOTES_SOURCE &&
    source?.kind === OWNER_NOTES_KIND && source?.status === "ready" &&
    source?.last_ingest_at === at &&
    Number(source?.document_count) === counts.logical_documents;
  if (!exactSource) {
    throw new OwnerNoteLifecycleError(
      "The note was stored, but its source receipt could not be read back exactly. Retry the same note; do not claim the source is current yet.",
      { code: "owner_note_source_receipt_unconfirmed", mayHaveWritten: true },
    );
  }

  return {
    ...receipt,
    confirmed: true,
    source: {
      name: source.name,
      kind: source.kind,
      status: source.status,
      documents: Number(source.document_count),
      last_ingest_at: source.last_ingest_at,
      // A direct write proves this record, not a complete historical sweep.
      complete_history_through: source.last_complete_sweep_at || null,
      zone: typeof source.zone === "string" && source.zone.trim() ? source.zone.trim() : null,
    },
    provenance: storedProvenance,
    ...(correction ? { correction } : {}),
  };
}
