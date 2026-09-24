/** Read-only proof that a local original is safe to treat as consumed. */

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_CANDIDATES = 500;

function familyComplete(documents, source, locator) {
  const base = `${source}:${locator}`;
  const structural = documents.some((document) => {
    const metadata = document.metadata;
    return Object.hasOwn(metadata || {}, "part_of") ||
      Object.hasOwn(metadata || {}, "part") ||
      Object.hasOwn(metadata || {}, "part_count");
  });
  if (!structural) {
    return documents.length === 1 && documents[0].doc_uid === base &&
      documents[0].source_id === locator;
  }
  const parts = documents.map((document) => {
    const metadata = document.metadata;
    const partOf = metadata?.part_of;
    const part = metadata?.part;
    const total = metadata?.part_count;
    if (typeof partOf !== "string" || !partOf || !Number.isSafeInteger(part) ||
        !Number.isSafeInteger(total) || total < 2 || part < 1 || part > total) return null;
    const root = partOf.startsWith(`${source}:`) ? partOf : `${source}:${partOf}`;
    if (root !== base || document.source_id !== `${partOf}#part${part}of${total}` ||
        document.doc_uid !== `${source}:${document.source_id}`) return null;
    return { part, total };
  });
  if (parts.some((part) => part === null)) return false;
  const totals = new Set(parts.map((part) => part.total));
  const total = totals.size === 1 ? parts[0].total : 0;
  const positions = new Set(parts.map((part) => part.part));
  return documents.length === total && positions.size === total &&
    [...positions].every((position) => position >= 1 && position <= total);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRequest({ source, candidates } = {}) {
  if (typeof source !== "string" || !SOURCE_RE.test(source)) {
    throw new TypeError("source must be one safe source name");
  }
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES) {
    throw new TypeError(`candidates must contain 1 to ${MAX_CANDIDATES} files`);
  }
  const seen = new Set();
  const normalized = candidates.map((candidate) => {
    const source_id = candidate?.source_id;
    const original_content_sha256 = candidate?.original_content_sha256;
    const original_byte_count = candidate?.original_byte_count;
    if (typeof source_id !== "string" || !source_id || source_id.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(source_id)) {
      throw new TypeError("source_id must be one bounded private locator");
    }
    if (seen.has(source_id)) throw new TypeError("candidate source_id values must be unique");
    seen.add(source_id);
    if (typeof original_content_sha256 !== "string" || !SHA_RE.test(original_content_sha256)) {
      throw new TypeError("original_content_sha256 must be one lowercase sha256");
    }
    if (!Number.isSafeInteger(original_byte_count) || original_byte_count < 0) {
      throw new TypeError("original_byte_count must be a non-negative safe integer");
    }
    return { source_id, original_content_sha256, original_byte_count };
  });
  return { source, candidates: normalized };
}

const CURRENT_ACCEPTED_SQL = `
SELECT document.doc_uid,document.source_id,document.meta,document.document_revision_id,
       binding.original_id,chunk.chunk_uid,chunk.chunk_ix,chunk.vector_id,
       chunk.bound_document_revision_id,chunk.result_chunk_receipt_hash,
       (SELECT COUNT(*)
          FROM source_original_result_bindings other_binding
         WHERE other_binding.original_content_sha256=binding.original_content_sha256
           AND other_binding.original_byte_count=binding.original_byte_count
           AND other_binding.source<>binding.source) AS external_count
  FROM documents document
  JOIN source_original_result_bindings binding
    ON binding.document_revision_id=document.document_revision_id
   AND binding.source=document.source
  JOIN chunks chunk ON chunk.doc_uid=document.doc_uid
 WHERE document.source=?1
   AND (document.source_id=?2 OR
        (json_valid(document.meta) AND json_type(document.meta,'$.part_of')='text' AND
         json_extract(document.meta,'$.part_of') IN (?2, ?1 || ':' || ?2)))
   AND document.deleted_at IS NULL
   AND binding.original_content_sha256=?3
   AND binding.original_byte_count=?4
   AND document.provenance_receipt_status='complete'
   AND document.provenance_receipt_reason='lineage_and_text_recorded'
   AND document.provenance_receipt_digest=binding.provenance_receipt_digest
   AND document.content_hash=binding.document_content_hash
   AND chunk.vector_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM vector_outbox pending WHERE pending.chunk_uid=chunk.chunk_uid)
 ORDER BY chunk.chunk_ix
 LIMIT 10001`;

export async function localCleanupProof(env, request) {
  if (!env?.DB?.prepare) throw new TypeError("D1 is required");
  const normalized = normalizeRequest(request);
  const confirmations = [];
  let decisionPoints = 0;
  for (const candidate of normalized.candidates) {
    const result = await env.DB.prepare(CURRENT_ACCEPTED_SQL).bind(
      normalized.source,
      candidate.source_id,
      candidate.original_content_sha256,
      candidate.original_byte_count,
    ).all();
    decisionPoints++;
    const rows = result?.results || [];
    const documentsByUid = new Map();
    for (const row of rows) {
      if (documentsByUid.has(row.doc_uid)) continue;
      let metadata = null;
      try {
        const parsed = JSON.parse(String(row.meta ?? ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
      } catch {
        // Invalid structural metadata can never become cleanup authority.
      }
      documentsByUid.set(row.doc_uid, {
        doc_uid: row.doc_uid,
        source_id: row.source_id,
        document_revision_id: row.document_revision_id,
        metadata,
      });
    }
    const documents = [...documentsByUid.values()];
    const chunkPositions = new Map();
    let chunksComplete = rows.length > 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(Number(row.chunk_ix)) || Number(row.chunk_ix) < 0 ||
          row.bound_document_revision_id !== row.document_revision_id ||
          typeof row.result_chunk_receipt_hash !== "string" ||
          typeof row.vector_id !== "string") {
        chunksComplete = false;
        continue;
      }
      const positions = chunkPositions.get(row.doc_uid) || [];
      positions.push(Number(row.chunk_ix));
      chunkPositions.set(row.doc_uid, positions);
    }
    for (const document of documents) {
      const positions = (chunkPositions.get(document.doc_uid) || []).sort((a, b) => a - b);
      if (!positions.length || positions.some((position, index) => position !== index)) {
        chunksComplete = false;
      }
    }
    const oneOriginal = rows.length > 0 && rows.length <= 10_000 && chunksComplete &&
      familyComplete(documents, normalized.source, candidate.source_id) &&
      rows.every((row) => row.original_id === rows[0].original_id);
    let vectorsConfirmed = false;
    if (oneOriginal && env?.VECTORIZE?.getByIds) {
      const found = new Set();
      for (let offset = 0; offset < rows.length; offset += 20) {
        const page = await env.VECTORIZE.getByIds(rows.slice(offset, offset + 20).map((row) => row.vector_id));
        for (const vector of page || []) if (typeof vector?.id === "string") found.add(vector.id);
      }
      vectorsConfirmed = rows.every((row) => found.has(row.vector_id));
    }
    const accepted = oneOriginal && vectorsConfirmed;
    confirmations.push({
      source_id: candidate.source_id,
      accepted_resolution_current: accepted,
      matching_current_source: accepted && Number(rows[0].external_count) > 0
        ? "another_current_source"
        : null,
      proof: accepted ? await digest({
        contract: "financial-brain-local-cleanup-v1",
        source: normalized.source,
        ...candidate,
        original_id: rows[0].original_id,
      }) : null,
    });
  }
  return Object.freeze({
    contract_version: 1,
    source: normalized.source,
    confirmations,
    decision_points: decisionPoints,
  });
}
