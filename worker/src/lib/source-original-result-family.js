/**
 * Immutable, privacy-preserving proof that one directly observed original is
 * represented by an exact current document/chunk family and can be retrieved
 * and cited through the production owner path.
 *
 * Raw locators, raw queries, document ids, titles and text exist only while
 * this request runs. Durable rows retain opaque original/revision identities
 * and canonical hashes only. This receipt is evidence, not authority to write
 * an accepted source-original observation.
 */

import { sourceOriginalChunkReceiptHash } from "./source-original-chunk.js";
import {
  SOURCE_ORIGINAL_TENANT_ID,
  deriveSourceOriginalId,
  loadSourceOriginalSigningKey,
  normalizeSourceOriginalLocator,
  normalizeSourceOriginalReceipt,
  normalizeSourceOriginalSource,
} from "./source-original-binding.js";
import { vectorReadiness } from "./store-d1.js";

export const SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION = 1;

const MAX_DOCUMENTS = 256;
// One JSON-bound member insert plus the two seals keeps the write transaction
// at three statements while bounding the private full-text snapshot.
const MAX_CHUNKS = 500;
const MAX_RETRIEVAL_RESULTS = 50;
const MAX_QUERY_BYTES = 4096;
const SHA_ID_RE = /^sha256:[a-f0-9]{64}$/;
const REVISION_ID_RE = /^rev-v1:[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export class SourceOriginalResultFamilyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SourceOriginalResultFamilyError";
    this.status = status;
    this.code = code;
  }
}

const refuse = (code, message, status = 400) => {
  throw new SourceOriginalResultFamilyError(status, code, message);
};

function exactObject(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Id(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return `sha256:${hex(digest)}`;
}

async function probeId(signingKey, originalId, query) {
  // Queries are often low entropy. A plain digest would be reversible with a
  // small dictionary, so reuse the recovered original-id HMAC domain key.
  const digest = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    encoder.encode(`financial-brain:source-original-retrieval-probe:v1\0${originalId}\0${query}`),
  );
  return `probe-v1:${hex(digest)}`;
}

function portable(value) {
  return JSON.parse(JSON.stringify(value));
}

function rowsOf(result) {
  if (!result || !Array.isArray(result.results)) {
    throw new SourceOriginalResultFamilyError(
      503,
      "source_original_result_family_database_unavailable",
      "result-family database read is unavailable",
    );
  }
  return result.results;
}

function normalizedRequest(body) {
  const fields = [
    "contract_version", "mode", "operation", "source", "locator_kind", "locator",
    "original_content_sha256", "original_byte_count", "retrieval_query",
  ];
  const required = fields.filter((field) => field !== "operation");
  if (!exactObject(body, fields, required) ||
      body.contract_version !== SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION ||
      body.mode !== "result_family") {
    refuse("source_original_result_family_invalid_request", "result_family request does not match the exact contract");
  }
  const operation = body.operation === undefined ? "record" : body.operation;
  if (!["record", "verify"].includes(operation)) {
    refuse("source_original_result_family_invalid_operation", "operation must be record or verify");
  }
  const source = normalizeSourceOriginalSource(body.source);
  const normalizedLocator = normalizeSourceOriginalLocator(body.locator_kind, body.locator);
  const originalReceipt = normalizeSourceOriginalReceipt({
    version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    locator_kind: normalizedLocator.locator_kind,
    original_content_sha256: body.original_content_sha256,
    original_byte_count: body.original_byte_count,
  });
  const query = body.retrieval_query;
  if (typeof query !== "string" || !query.trim() || query !== query.normalize("NFC") ||
      encoder.encode(query).length > MAX_QUERY_BYTES) {
    refuse("source_original_result_family_invalid_query", "retrieval_query must be one bounded canonical private query");
  }
  return Object.freeze({
    operation,
    source,
    locator_kind: normalizedLocator.locator_kind,
    locator: normalizedLocator.locator,
    original_content_sha256: originalReceipt.original_content_sha256,
    original_byte_count: originalReceipt.original_byte_count,
    query,
  });
}

function familyComplete(documents, source, base) {
  if (documents.some((document) => Object.hasOwn(document.metadata || {}, "family_of"))) return false;
  const structural = documents.some((document) =>
    Object.hasOwn(document.metadata || {}, "part_of") ||
    Object.hasOwn(document.metadata || {}, "part") ||
    Object.hasOwn(document.metadata || {}, "part_count")
  );
  if (!structural) return documents.length === 1 && documents[0].doc_uid === base;

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

async function exactFamilySnapshot(env, request, originalId) {
  const base = `${request.source}:${request.locator}`;
  const result = await env.DB.prepare(
    `SELECT d.doc_uid,d.source_id,d.title AS document_title,d.meta,
            d.document_revision_id,d.source_original_binding_hash,
            d.content_hash,d.provenance_receipt_digest,
            bound.contract_version AS binding_contract_version,
            bound.tenant_id AS binding_tenant_id,
            bound.source AS binding_source,
            bound.original_id AS binding_original_id,
            bound.locator_kind AS binding_locator_kind,
            bound.original_content_sha256 AS binding_content_sha256,
            bound.original_byte_count AS binding_byte_count,
            c.chunk_uid,c.chunk_ix,c.source AS chunk_source,c.title,c.text,c.bound_document_revision_id,
            c.result_chunk_receipt_hash
       FROM documents AS d
       LEFT JOIN source_original_result_bindings AS bound
         ON bound.binding_hash=d.source_original_binding_hash
        AND bound.document_revision_id=d.document_revision_id
        AND bound.source=d.source
        AND bound.document_content_hash=d.content_hash
        AND bound.provenance_receipt_digest=d.provenance_receipt_digest
       LEFT JOIN chunks AS c ON c.doc_uid=d.doc_uid
      WHERE d.source=?1 AND d.deleted_at IS NULL AND (
        d.source_id=?2 OR
        d.doc_uid=?3 OR
        substr(d.doc_uid,1,length(?3 || '#part'))=?3 || '#part' OR
        (json_valid(d.meta) AND json_type(d.meta,'$.family_of')='text' AND json_extract(d.meta,'$.family_of')=?3) OR
        (json_valid(d.meta) AND json_type(d.meta,'$.part_of')='text' AND
          json_extract(d.meta,'$.part_of') IN (?2,?3)) OR
        (bound.tenant_id=?4 AND bound.original_id=?5 AND bound.locator_kind=?6 AND
          bound.original_content_sha256=?7 AND bound.original_byte_count=?8)
      )
      ORDER BY d.doc_uid,c.chunk_ix
      LIMIT ?9`,
  ).bind(
    request.source,
    request.locator,
    base,
    SOURCE_ORIGINAL_TENANT_ID,
    originalId,
    request.locator_kind,
    request.original_content_sha256,
    request.original_byte_count,
    MAX_CHUNKS + MAX_DOCUMENTS + 1,
  ).all();
  const rows = rowsOf(result);
  if (rows.length > MAX_CHUNKS + MAX_DOCUMENTS) {
    refuse("source_original_result_family_too_large", "result family exceeds the bounded proof size", 503);
  }

  const documentsByUid = new Map();
  const chunks = [];
  for (const row of rows) {
    const docUid = String(row.doc_uid || "");
    if (!documentsByUid.has(docUid)) {
      let metadata = null;
      try {
        const parsed = JSON.parse(String(row.meta ?? ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
      } catch {
        // A malformed structural contract can never become a family receipt.
      }
      documentsByUid.set(docUid, {
        doc_uid: docUid,
        source_id: String(row.source_id || ""),
        metadata,
        document_revision_id: row.document_revision_id,
        source_original_binding_hash: row.source_original_binding_hash,
        binding_contract_version: Number(row.binding_contract_version),
        binding_tenant_id: row.binding_tenant_id,
        binding_source: row.binding_source,
        binding_original_id: row.binding_original_id,
        binding_locator_kind: row.binding_locator_kind,
        binding_content_sha256: row.binding_content_sha256,
        binding_byte_count: Number(row.binding_byte_count),
      });
    }
    if (row.chunk_uid !== null && row.chunk_uid !== undefined) {
      chunks.push({
        chunk_uid: String(row.chunk_uid),
        doc_uid: docUid,
        document_revision_id: row.document_revision_id,
        source_original_binding_hash: row.source_original_binding_hash,
        chunk_ix: Number(row.chunk_ix),
        source: row.chunk_source === null ? null : String(row.chunk_source),
        document_title: row.document_title === null ? null : String(row.document_title),
        title: row.title === null ? null : String(row.title),
        text: String(row.text),
        bound_document_revision_id: row.bound_document_revision_id,
        chunk_receipt_hash: row.result_chunk_receipt_hash,
      });
    }
  }
  const documents = [...documentsByUid.values()];
  if (documents.length > MAX_DOCUMENTS || chunks.length > MAX_CHUNKS) {
    refuse("source_original_result_family_too_large", "result family exceeds the bounded proof size", 503);
  }
  if (!documents.length || !familyComplete(documents, request.source, base)) {
    refuse("source_original_result_family_incomplete", "the exact current result family is missing or incomplete", 409);
  }
  if (chunks.length < documents.length) {
    refuse("source_original_result_family_chunks_missing", "every family revision must contain at least one exact chunk", 409);
  }

  for (const document of documents) {
    if (!REVISION_ID_RE.test(document.document_revision_id || "") ||
        !SHA_ID_RE.test(document.source_original_binding_hash || "") ||
        document.binding_contract_version !== SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION ||
        document.binding_tenant_id !== SOURCE_ORIGINAL_TENANT_ID ||
        document.binding_source !== request.source || document.binding_original_id !== originalId ||
        document.binding_locator_kind !== request.locator_kind ||
        document.binding_content_sha256 !== request.original_content_sha256 ||
        document.binding_byte_count !== request.original_byte_count) {
      refuse("source_original_result_family_binding_mismatch", "a current family revision is not bound to the exact original", 409);
    }
  }

  const chunkPositions = new Map();
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk.chunk_ix) || chunk.chunk_ix < 0 ||
        chunk.source !== request.source ||
        chunk.title !== chunk.document_title ||
        chunk.bound_document_revision_id !== chunk.document_revision_id ||
        !SHA_ID_RE.test(chunk.chunk_receipt_hash || "")) {
      refuse("source_original_result_family_chunk_mismatch", "a current family chunk is not bound to its exact revision", 409);
    }
    let expectedHash;
    try {
      expectedHash = await sourceOriginalChunkReceiptHash({
        document_revision_id: chunk.document_revision_id,
        chunk_ix: chunk.chunk_ix,
        title: chunk.title,
        text: chunk.text,
      });
    } catch {
      refuse("source_original_result_family_chunk_mismatch", "a current family chunk has an invalid stored receipt", 409);
    }
    if (expectedHash !== chunk.chunk_receipt_hash) {
      refuse("source_original_result_family_chunk_mismatch", "a current family chunk receipt does not match its stored bytes", 409);
    }
    const positions = chunkPositions.get(chunk.document_revision_id) || [];
    positions.push(chunk.chunk_ix);
    chunkPositions.set(chunk.document_revision_id, positions);
  }
  for (const document of documents) {
    const positions = (chunkPositions.get(document.document_revision_id) || []).sort((a, b) => a - b);
    if (!positions.length || positions.some((position, index) => position !== index)) {
      refuse("source_original_result_family_chunk_mismatch", "family chunk indexes are not complete and contiguous", 409);
    }
  }

  const documentMembers = documents.map((document) => ({
    document_revision_id: document.document_revision_id,
    source_original_binding_hash: document.source_original_binding_hash,
  })).sort((left, right) => left.document_revision_id.localeCompare(right.document_revision_id));
  const members = chunks.map((chunk) => ({
    document_revision_id: chunk.document_revision_id,
    source_original_binding_hash: chunk.source_original_binding_hash,
    chunk_ix: chunk.chunk_ix,
    chunk_receipt_hash: chunk.chunk_receipt_hash,
  })).sort((left, right) =>
    left.document_revision_id.localeCompare(right.document_revision_id) || left.chunk_ix - right.chunk_ix
  );
  return {
    documents,
    chunks,
    members,
    document_count: documents.length,
    chunk_count: chunks.length,
    document_set_hash: await sha256Id(canonical({
      contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
      members: documentMembers,
    })),
    chunk_set_hash: await sha256Id(canonical({
      contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
      chunks: members.map(({ document_revision_id, chunk_ix, chunk_receipt_hash }) => ({
        document_revision_id, chunk_ix, chunk_receipt_hash,
      })),
    })),
  };
}

async function projectionReceipt(env, originalId, expectedReadiness) {
  const state = await env.DB.prepare(
    `SELECT schema_version,outbox_generation,
            vector_projection_mutation_id,vector_projection_submitted_at,
            vector_projection_status,vector_projection_bootstrap_epoch,
            (SELECT COUNT(*) FROM chunks) AS expected_vector_count,
            (SELECT COUNT(*) FROM vector_outbox) AS global_outbox_count,
            (SELECT COUNT(*)
               FROM vector_outbox AS pending
               JOIN chunks AS c ON c.chunk_uid=pending.chunk_uid
               JOIN source_original_result_bindings AS bound
                 ON bound.document_revision_id=c.bound_document_revision_id
              WHERE bound.tenant_id=?1 AND bound.original_id=?2) AS target_outbox_count
       FROM install_state WHERE id=1`,
  ).bind(SOURCE_ORIGINAL_TENANT_ID, originalId).first();
  if (!state || Number(state.schema_version) < 44) {
    throw new SourceOriginalResultFamilyError(
      503,
      "source_original_result_family_schema_unavailable",
      "result-family receipt schema is not active",
    );
  }
  const receipt = {
    contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    outbox_generation: Number(state.outbox_generation),
    vector_projection_mutation_id: state.vector_projection_mutation_id === null
      ? null
      : String(state.vector_projection_mutation_id),
    vector_projection_submitted_at: state.vector_projection_submitted_at === null
      ? null
      : Number(state.vector_projection_submitted_at),
    vector_projection_bootstrap_epoch: Number(state.vector_projection_bootstrap_epoch),
    vector_projection_status: String(state.vector_projection_status || ""),
    expected_vector_count: Number(state.expected_vector_count),
    actual_vector_count: Number(expectedReadiness?.actual_vectors),
    target_outbox_count: Number(state.target_outbox_count),
    global_outbox_count: Number(state.global_outbox_count),
  };
  const numbers = [
    receipt.outbox_generation, receipt.vector_projection_bootstrap_epoch,
    receipt.expected_vector_count, receipt.actual_vector_count,
    receipt.target_outbox_count, receipt.global_outbox_count,
  ];
  const mutationPairValid = (receipt.vector_projection_mutation_id === null) ===
    (receipt.vector_projection_submitted_at === null);
  if (expectedReadiness?.ready !== true || expectedReadiness.pending !== 0 ||
      expectedReadiness.submitted !== 0 || expectedReadiness.projection_status !== "verified" ||
      numbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      !mutationPairValid || receipt.vector_projection_status !== "verified" ||
      receipt.target_outbox_count !== 0 || receipt.global_outbox_count !== 0 ||
      receipt.expected_vector_count !== receipt.actual_vector_count ||
      receipt.expected_vector_count !== Number(expectedReadiness.expected_vectors) ||
      receipt.actual_vector_count !== Number(expectedReadiness.actual_vectors) ||
      receipt.outbox_generation !== Number(expectedReadiness.outbox_generation) ||
      receipt.vector_projection_mutation_id !== (expectedReadiness.mutation_id ?? null) ||
      receipt.vector_projection_bootstrap_epoch !== Number(expectedReadiness.bootstrap_epoch) ||
      receipt.vector_projection_submitted_at !== (expectedReadiness.mutation_submitted_at ?? null)) {
    refuse("source_original_result_family_vector_unready", "the exact global and target vector projection is not ready", 409);
  }
  return {
    ...receipt,
    vector_readiness_hash: await sha256Id(canonical(receipt)),
  };
}

function resultProjection(pair, position) {
  return {
    position,
    result: portable(pair.result),
  };
}

async function retrievedIdentity(env, pair) {
  const result = pair?.result;
  const citation = pair?.citation;
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      !citation || typeof citation !== "object" || Array.isArray(citation) ||
      typeof result.doc_uid !== "string" || typeof result.chunk_uid !== "string") {
    refuse("source_original_result_family_retrieval_invalid", "retrieval did not return an exact citable chunk", 409);
  }
  const expectedRef = result.ref_key || result.drive_file_id || null;
  const expectedTitle = String(result.title || "untitled").slice(0, 140);
  if (citation.n !== 1 || citation.source !== result.source || citation.ref !== expectedRef ||
      citation.title !== expectedTitle || canonical(portable(citation.lineage ?? null)) !==
        canonical(portable(result.lineage ?? null))) {
    refuse("source_original_result_family_citation_mismatch", "the top citation is not projected from the top retrieved result", 409);
  }
  const found = await env.DB.prepare(
    `SELECT d.document_revision_id,c.chunk_ix,c.result_chunk_receipt_hash,
            c.bound_document_revision_id
       FROM chunks AS c
       JOIN documents AS d ON d.doc_uid=c.doc_uid
      WHERE d.deleted_at IS NULL AND d.doc_uid=?1 AND c.chunk_uid=?2
      LIMIT 2`,
  ).bind(result.doc_uid, result.chunk_uid).all();
  const rows = rowsOf(found);
  if (rows.length !== 1) {
    refuse("source_original_result_family_retrieval_changed", "the top retrieved chunk is no longer current", 409);
  }
  const row = rows[0];
  if (!REVISION_ID_RE.test(row.document_revision_id || "") ||
      row.bound_document_revision_id !== row.document_revision_id ||
      !Number.isSafeInteger(Number(row.chunk_ix)) || Number(row.chunk_ix) < 0 ||
      !SHA_ID_RE.test(row.result_chunk_receipt_hash || "")) {
    refuse("source_original_result_family_retrieval_unbound", "the top retrieved chunk has no exact revision receipt", 409);
  }
  return {
    document_revision_id: String(row.document_revision_id),
    chunk_ix: Number(row.chunk_ix),
    chunk_receipt_hash: String(row.result_chunk_receipt_hash),
  };
}

async function runProbe(env, retrieve, query, retrievalProbeId, memberKeys) {
  let response;
  try {
    response = await retrieve({ query, limit: MAX_RETRIEVAL_RESULTS });
  } catch {
    throw new SourceOriginalResultFamilyError(
      503,
      "source_original_result_family_retrieval_unavailable",
      "the production retrieval path is unavailable",
    );
  }
  if (!response || typeof response !== "object" || Array.isArray(response) ||
      response.degraded !== false || response.retrieval_scope !== "owner" ||
      response.access?.principal !== "owner" ||
      !Array.isArray(response.ignored_filters) || response.ignored_filters.length !== 0 ||
      !Array.isArray(response.results) || response.results.length < 1 ||
      response.results.length > MAX_RETRIEVAL_RESULTS) {
    refuse("source_original_result_family_retrieval_unready", "the production owner retrieval path is degraded or incomplete", 409);
  }
  const top = await retrievedIdentity(env, response.results[0]);
  const memberKey = `${top.document_revision_id}\0${top.chunk_ix}\0${top.chunk_receipt_hash}`;
  if (!memberKeys.has(memberKey)) {
    refuse("source_original_result_family_citation_mismatch", "the top retrieval and citation are not from the proved result family", 409);
  }
  const resultHash = await sha256Id(canonical({
    contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    retrieval_probe_id: retrievalProbeId,
    retrieval_scope: "owner",
    results: response.results.map((pair, index) => resultProjection(pair, index + 1)),
  }));
  const citationSetHash = await sha256Id(canonical({
    contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    retrieval_probe_id: retrievalProbeId,
    citations: response.results.map((pair) => portable(pair.citation)),
  }));
  return {
    result_hash: resultHash,
    citation_set_hash: citationSetHash,
    document_revision_id: top.document_revision_id,
    chunk_ix: top.chunk_ix,
  };
}

function familyReceiptFields(value) {
  return {
    contract_version: Number(value.contract_version),
    tenant_id: String(value.tenant_id),
    source: String(value.source),
    original_id: String(value.original_id),
    locator_kind: String(value.locator_kind),
    original_content_sha256: String(value.original_content_sha256),
    original_byte_count: Number(value.original_byte_count),
    document_count: Number(value.document_count),
    document_set_hash: String(value.document_set_hash),
    chunk_count: Number(value.chunk_count),
    chunk_set_hash: String(value.chunk_set_hash),
  };
}

function verificationFields(value) {
  return {
    contract_version: Number(value.contract_version),
    tenant_id: String(value.tenant_id),
    family_receipt_hash: String(value.family_receipt_hash),
    outbox_generation: Number(value.outbox_generation),
    vector_projection_mutation_id: value.vector_projection_mutation_id === null
      ? null
      : String(value.vector_projection_mutation_id),
    vector_projection_submitted_at: value.vector_projection_submitted_at === null
      ? null
      : Number(value.vector_projection_submitted_at),
    vector_projection_bootstrap_epoch: Number(value.vector_projection_bootstrap_epoch),
    vector_projection_status: String(value.vector_projection_status),
    expected_vector_count: Number(value.expected_vector_count),
    actual_vector_count: Number(value.actual_vector_count),
    target_outbox_count: Number(value.target_outbox_count),
    global_outbox_count: Number(value.global_outbox_count),
    vector_readiness_hash: String(value.vector_readiness_hash),
    retrieval_contract_version: Number(value.retrieval_contract_version),
    retrieval_probe_id: String(value.retrieval_probe_id),
    retrieval_status: String(value.retrieval_status),
    retrieval_result_hash_a: String(value.retrieval_result_hash_a),
    retrieval_result_hash_b: String(value.retrieval_result_hash_b),
    retrieved_document_revision_id_a: String(value.retrieved_document_revision_id_a),
    retrieved_document_revision_id_b: String(value.retrieved_document_revision_id_b),
    retrieved_chunk_ix_a: Number(value.retrieved_chunk_ix_a),
    retrieved_chunk_ix_b: Number(value.retrieved_chunk_ix_b),
    citation_status: String(value.citation_status),
    citation_set_hash_a: String(value.citation_set_hash_a),
    citation_set_hash_b: String(value.citation_set_hash_b),
    cited_document_revision_id_a: String(value.cited_document_revision_id_a),
    cited_document_revision_id_b: String(value.cited_document_revision_id_b),
  };
}

function memberFields(value) {
  return {
    document_revision_id: String(value.document_revision_id),
    source_original_binding_hash: String(value.source_original_binding_hash),
    chunk_ix: Number(value.chunk_ix),
    chunk_receipt_hash: String(value.chunk_receipt_hash),
  };
}

async function readStoredProof(env, familyReceiptHash, verificationHash) {
  const [receiptResult, memberResult, verificationResult] = await Promise.all([
    env.DB.prepare(
      `SELECT contract_version,tenant_id,source,original_id,locator_kind,
              original_content_sha256,original_byte_count,document_count,document_set_hash,
              chunk_count,chunk_set_hash,family_receipt_hash,sealed_at
         FROM source_original_result_family_receipts WHERE family_receipt_hash=?1 LIMIT 2`,
    ).bind(familyReceiptHash).all(),
    env.DB.prepare(
      `SELECT document_revision_id,source_original_binding_hash,chunk_ix,chunk_receipt_hash
         FROM source_original_result_family_members WHERE family_receipt_hash=?1
        ORDER BY document_revision_id,chunk_ix LIMIT ?2`,
    ).bind(familyReceiptHash, MAX_CHUNKS + 1).all(),
    env.DB.prepare(
      `SELECT contract_version,tenant_id,family_receipt_hash,outbox_generation,
              vector_projection_mutation_id,vector_projection_submitted_at,
              vector_projection_bootstrap_epoch,vector_projection_status,
              expected_vector_count,actual_vector_count,target_outbox_count,global_outbox_count,
              vector_readiness_hash,retrieval_contract_version,retrieval_probe_id,retrieval_status,
              retrieval_result_hash_a,retrieval_result_hash_b,
              retrieved_document_revision_id_a,retrieved_document_revision_id_b,
              retrieved_chunk_ix_a,retrieved_chunk_ix_b,citation_status,
              citation_set_hash_a,citation_set_hash_b,
              cited_document_revision_id_a,cited_document_revision_id_b,
              verification_hash,verified_at
         FROM source_original_result_family_verifications WHERE verification_hash=?1 LIMIT 2`,
    ).bind(verificationHash).all(),
  ]);
  return {
    receipts: rowsOf(receiptResult),
    members: rowsOf(memberResult),
    verifications: rowsOf(verificationResult),
  };
}

function storedProofMatches(stored, familyReceipt, members, verification) {
  if (stored.receipts.length !== 1 || stored.members.length !== members.length ||
      stored.verifications.length !== 1) return false;
  const receipt = stored.receipts[0];
  const verified = stored.verifications[0];
  return receipt.family_receipt_hash === familyReceipt.family_receipt_hash &&
    canonical(familyReceiptFields(receipt)) === canonical(familyReceiptFields(familyReceipt)) &&
    canonical(stored.members.map(memberFields)) === canonical(members.map(memberFields)) &&
    verified.verification_hash === verification.verification_hash &&
    canonical(verificationFields(verified)) === canonical(verificationFields(verification));
}

async function persistProof(env, familyReceipt, members, verification, operation, recordedAt) {
  const before = await readStoredProof(
    env,
    familyReceipt.family_receipt_hash,
    verification.verification_hash,
  );
  if (storedProofMatches(before, familyReceipt, members, verification)) {
    return { recorded: false, replayed: true };
  }
  if (operation === "verify") {
    refuse("source_original_result_family_receipt_missing", "the exact current result-family proof is not recorded", 409);
  }
  const exactMembers = before.members.length === members.length &&
    canonical(before.members.map(memberFields)) === canonical(members.map(memberFields));
  if (before.receipts.length > 1 || before.verifications.length > 1 ||
      (before.receipts.length === 1 &&
        canonical(familyReceiptFields(before.receipts[0])) !== canonical(familyReceiptFields(familyReceipt))) ||
      (before.receipts.length === 1 && !exactMembers) ||
      (before.receipts.length === 0 && before.members.length > 0 && !exactMembers) ||
      (before.verifications.length === 1 &&
        canonical(verificationFields(before.verifications[0])) !== canonical(verificationFields(verification)))) {
    refuse("source_original_result_family_receipt_conflict", "stored result-family proof does not match the exact current proof", 409);
  }

  const statements = [];
  if (before.receipts.length === 0) {
    if (before.members.length === 0) {
      statements.push(env.DB.prepare(
        `INSERT INTO source_original_result_family_members
           (family_receipt_hash,document_revision_id,source_original_binding_hash,chunk_ix,chunk_receipt_hash)
         SELECT ?1,
                json_extract(value,'$[0]'),json_extract(value,'$[1]'),
                CAST(json_extract(value,'$[2]') AS INTEGER),json_extract(value,'$[3]')
           FROM json_each(?2)`,
      ).bind(familyReceipt.family_receipt_hash, JSON.stringify(members.map((member) => [
        member.document_revision_id,
        member.source_original_binding_hash,
        member.chunk_ix,
        member.chunk_receipt_hash,
      ]))));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO source_original_result_family_receipts
         (contract_version,tenant_id,source,original_id,locator_kind,
          original_content_sha256,original_byte_count,document_count,document_set_hash,
          chunk_count,chunk_set_hash,family_receipt_hash,sealed_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
    ).bind(
      familyReceipt.contract_version, familyReceipt.tenant_id, familyReceipt.source,
      familyReceipt.original_id, familyReceipt.locator_kind,
      familyReceipt.original_content_sha256, familyReceipt.original_byte_count,
      familyReceipt.document_count, familyReceipt.document_set_hash,
      familyReceipt.chunk_count, familyReceipt.chunk_set_hash,
      familyReceipt.family_receipt_hash, recordedAt,
    ));
  }
  if (before.verifications.length === 0) {
    statements.push(env.DB.prepare(
      `INSERT INTO source_original_result_family_verifications
         (contract_version,tenant_id,family_receipt_hash,outbox_generation,
          vector_projection_mutation_id,vector_projection_submitted_at,
          vector_projection_bootstrap_epoch,vector_projection_status,
          expected_vector_count,actual_vector_count,target_outbox_count,global_outbox_count,
          vector_readiness_hash,retrieval_contract_version,retrieval_probe_id,retrieval_status,
          retrieval_result_hash_a,retrieval_result_hash_b,
          retrieved_document_revision_id_a,retrieved_document_revision_id_b,
          retrieved_chunk_ix_a,retrieved_chunk_ix_b,citation_status,
          citation_set_hash_a,citation_set_hash_b,
          cited_document_revision_id_a,cited_document_revision_id_b,
          verification_hash,verified_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
               ?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)`,
    ).bind(
      verification.contract_version, verification.tenant_id, verification.family_receipt_hash,
      verification.outbox_generation, verification.vector_projection_mutation_id,
      verification.vector_projection_submitted_at, verification.vector_projection_bootstrap_epoch,
      verification.vector_projection_status, verification.expected_vector_count,
      verification.actual_vector_count, verification.target_outbox_count,
      verification.global_outbox_count, verification.vector_readiness_hash,
      verification.retrieval_contract_version, verification.retrieval_probe_id,
      verification.retrieval_status, verification.retrieval_result_hash_a,
      verification.retrieval_result_hash_b, verification.retrieved_document_revision_id_a,
      verification.retrieved_document_revision_id_b, verification.retrieved_chunk_ix_a,
      verification.retrieved_chunk_ix_b, verification.citation_status,
      verification.citation_set_hash_a, verification.citation_set_hash_b,
      verification.cited_document_revision_id_a, verification.cited_document_revision_id_b,
      verification.verification_hash, recordedAt,
    ));
  }

  let batchFailed = false;
  try {
    if (statements.length) await env.DB.batch(statements);
  } catch {
    // A concurrent exact writer may have won. Only exact, hash-checked readback
    // below may reconcile that race; every other state remains a failure.
    batchFailed = true;
  }
  const after = await readStoredProof(
    env,
    familyReceipt.family_receipt_hash,
    verification.verification_hash,
  );
  if (!storedProofMatches(after, familyReceipt, members, verification)) {
    throw new SourceOriginalResultFamilyError(
      503,
      "source_original_result_family_record_unavailable",
      "the exact result-family proof was not recorded",
    );
  }
  return batchFailed
    ? { recorded: false, replayed: true }
    : { recorded: statements.length > 0, replayed: false };
}

/** Build, atomically record, or exactly reverify one bounded family proof. */
export async function handleSourceOriginalResultFamily(env, body, {
  retrieve,
  readBindingReadiness,
  readVectorReadiness = vectorReadiness,
} = {}) {
  if (typeof retrieve !== "function") {
    throw new SourceOriginalResultFamilyError(
      503,
      "source_original_result_family_retrieval_unavailable",
      "the production retrieval path is unavailable",
    );
  }
  if (typeof readBindingReadiness !== "function") {
    throw new SourceOriginalResultFamilyError(
      503,
      "source_original_result_family_binding_unavailable",
      "the source-original revision binding proof is unavailable",
    );
  }
  const request = normalizedRequest(body);
  if (request.operation === "record" && env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    throw new SourceOriginalResultFamilyError(
      503,
      "corpus_writes_paused",
      "brain writes are paused for a verified upgrade or rollback",
    );
  }
  const source = await env.DB.prepare("SELECT name,kind FROM sources WHERE name=?1")
    .bind(request.source).first();
  if (source?.name !== request.source) {
    refuse("source_original_source_not_registered", "source is not registered", 404);
  }
  if (source.kind !== "upload") {
    refuse("source_original_source_kind_unsupported", "only directly observed upload originals are supported", 409);
  }
  const signingKey = await loadSourceOriginalSigningKey(env);
  const originalId = await deriveSourceOriginalId(signingKey, {
    source: request.source,
    locator_kind: request.locator_kind,
    locator: request.locator,
  });
  const bindingReadiness = await readBindingReadiness(env, {
    source: request.source,
    locator: request.locator,
    locator_kind: request.locator_kind,
    original_content_sha256: request.original_content_sha256,
    original_byte_count: request.original_byte_count,
  });
  if (bindingReadiness.ready !== true || bindingReadiness.original_id !== originalId) {
    refuse("source_original_result_family_binding_mismatch", "the current family is not bound to the exact original", 409);
  }
  const family = await exactFamilySnapshot(env, request, originalId);
  if (family.document_count !== bindingReadiness.document_count) {
    refuse("source_original_result_family_changed", "the current result family changed during proof", 409);
  }

  const familyReceipt = {
    contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    tenant_id: SOURCE_ORIGINAL_TENANT_ID,
    source: request.source,
    original_id: originalId,
    locator_kind: request.locator_kind,
    original_content_sha256: request.original_content_sha256,
    original_byte_count: request.original_byte_count,
    document_count: family.document_count,
    document_set_hash: family.document_set_hash,
    chunk_count: family.chunk_count,
    chunk_set_hash: family.chunk_set_hash,
  };
  familyReceipt.family_receipt_hash = await sha256Id(canonical(familyReceipt));

  let readiness;
  try {
    readiness = await readVectorReadiness(env);
  } catch {
    throw new SourceOriginalResultFamilyError(
      503,
      "source_original_result_family_vector_unavailable",
      "the vector projection readiness proof is unavailable",
    );
  }
  const retrievalProbeId = await probeId(signingKey, originalId, request.query);
  const memberKeys = new Set(family.members.map((member) =>
    `${member.document_revision_id}\0${member.chunk_ix}\0${member.chunk_receipt_hash}`
  ));
  const firstProbe = await runProbe(env, retrieve, request.query, retrievalProbeId, memberKeys);
  const secondProbe = await runProbe(env, retrieve, request.query, retrievalProbeId, memberKeys);
  if (firstProbe.result_hash !== secondProbe.result_hash ||
      firstProbe.citation_set_hash !== secondProbe.citation_set_hash ||
      firstProbe.document_revision_id !== secondProbe.document_revision_id ||
      firstProbe.chunk_ix !== secondProbe.chunk_ix) {
    refuse("source_original_result_family_retrieval_nondeterministic", "identical production retrieval probes did not produce the same result and citation", 409);
  }
  const projection = await projectionReceipt(env, originalId, readiness);
  const verification = {
    contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    tenant_id: SOURCE_ORIGINAL_TENANT_ID,
    family_receipt_hash: familyReceipt.family_receipt_hash,
    outbox_generation: projection.outbox_generation,
    vector_projection_mutation_id: projection.vector_projection_mutation_id,
    vector_projection_submitted_at: projection.vector_projection_submitted_at,
    vector_projection_bootstrap_epoch: projection.vector_projection_bootstrap_epoch,
    vector_projection_status: projection.vector_projection_status,
    expected_vector_count: projection.expected_vector_count,
    actual_vector_count: projection.actual_vector_count,
    target_outbox_count: projection.target_outbox_count,
    global_outbox_count: projection.global_outbox_count,
    vector_readiness_hash: projection.vector_readiness_hash,
    retrieval_contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    retrieval_probe_id: retrievalProbeId,
    retrieval_status: "deterministic",
    retrieval_result_hash_a: firstProbe.result_hash,
    retrieval_result_hash_b: secondProbe.result_hash,
    retrieved_document_revision_id_a: firstProbe.document_revision_id,
    retrieved_document_revision_id_b: secondProbe.document_revision_id,
    retrieved_chunk_ix_a: firstProbe.chunk_ix,
    retrieved_chunk_ix_b: secondProbe.chunk_ix,
    citation_status: "same_family",
    citation_set_hash_a: firstProbe.citation_set_hash,
    citation_set_hash_b: secondProbe.citation_set_hash,
    cited_document_revision_id_a: firstProbe.document_revision_id,
    cited_document_revision_id_b: secondProbe.document_revision_id,
  };
  verification.verification_hash = await sha256Id(canonical(verification));
  const persistence = await persistProof(
    env,
    familyReceipt,
    family.members,
    verification,
    request.operation,
    Date.now(),
  );
  return {
    contract_version: SOURCE_ORIGINAL_RESULT_FAMILY_CONTRACT_VERSION,
    mode: "result_family",
    operation: request.operation,
    source: request.source,
    original_id: originalId,
    family_receipt_hash: familyReceipt.family_receipt_hash,
    verification_hash: verification.verification_hash,
    document_count: family.document_count,
    chunk_count: family.chunk_count,
    vector_readiness_hash: projection.vector_readiness_hash,
    retrieval_probe_id: retrievalProbeId,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    recorded: persistence.recorded,
    replayed: persistence.replayed,
    accepted_outcome_authorized: false,
  };
}
