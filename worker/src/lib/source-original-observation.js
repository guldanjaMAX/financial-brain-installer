/**
 * Bounded, privacy-preserving evidence for directly observed source originals.
 *
 * The raw source-relative locator is accepted only long enough to derive a
 * durable HMAC identity and inspect the exact current D1 document family. It
 * is never stored or returned. This ledger can prove the outcome of at most
 * ten named originals; it cannot prove that a whole source was enumerated.
 */

import { jsonResponse, privateNoStore, validateAdminKey } from "./core.js";
import { storedProvenanceMarkerAssessment } from "./provenance-receipt.js";
import {
  SOURCE_ORIGINAL_TENANT_ID,
  SourceOriginalBindingError,
  deriveSourceOriginalId,
  hashSourceOriginalResultBinding,
  loadSourceOriginalSigningKey,
  normalizeSourceOriginalLocator,
  normalizeSourceOriginalReceipt,
  normalizeSourceOriginalSource,
} from "./source-original-binding.js";
import { backendOf, D1 } from "./store.js";
import {
  buildSourceOriginalResultFamilyProof,
  handleSourceOriginalResultFamily,
  SourceOriginalResultFamilyError,
} from "./source-original-result-family.js";
import {
  recordSourceOriginalAcceptedResolution,
  SourceOriginalAcceptedResolutionError,
  verifySourceOriginalAcceptedResolution,
} from "./source-original-accepted-resolution.js";

export const SOURCE_ORIGINAL_OBSERVATION_PATH = "/api/admin/brain/source-original-observations";
export const SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION = 1;
export const SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS = 10;

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_DOCUMENTS_PER_ORIGINAL = 256;
const RUN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SHA_ID_RE = /^sha256:[a-f0-9]{64}$/;
const ORIGINAL_ID_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const encoder = new TextEncoder();

const OBSERVATION_STAGES = Object.freeze(["discovery", "repair"]);
const OBSERVATION_OUTCOMES = Object.freeze(["accepted", "gap", "adjudicated_exclusion", "failed"]);
const OBSERVATION_TEXT_STATES = Object.freeze([
  "native_readable", "ocr_reliable", "ocr_partial", "scan_only_ocr_needed",
  "empty", "password_protected", "unsupported", "extraction_failed", "unavailable",
]);
const OBSERVATION_PAGE_COUNT_STATES = Object.freeze(["authoritative", "not_applicable", "unavailable"]);
const OBSERVATION_REASON_CODES = Object.freeze([
  "accepted_provenance_verified", "provenance_unassessed", "ocr_partial_review",
  "scan_only_ocr_needed", "empty_original", "password_protected", "unsupported_format",
  "extraction_failed", "original_unavailable", "source_policy_excluded",
  "current_document_missing", "index_write_failed",
]);
const OBSERVATION_OUTCOME_TRIPLES = Object.freeze([
  "accepted|accepted_provenance_verified|native_readable",
  "accepted|accepted_provenance_verified|ocr_reliable",
  "gap|provenance_unassessed|native_readable",
  "gap|provenance_unassessed|ocr_reliable",
  "gap|current_document_missing|native_readable",
  "gap|current_document_missing|ocr_reliable",
  "gap|current_document_missing|unavailable",
  "gap|ocr_partial_review|ocr_partial",
  "gap|scan_only_ocr_needed|scan_only_ocr_needed",
  "gap|password_protected|password_protected",
  "gap|unsupported_format|unsupported",
  "gap|extraction_failed|extraction_failed",
  "gap|original_unavailable|unavailable",
  "adjudicated_exclusion|empty_original|empty",
  "adjudicated_exclusion|source_policy_excluded|unsupported",
  "adjudicated_exclusion|source_policy_excluded|unavailable",
  "failed|extraction_failed|extraction_failed",
  "failed|original_unavailable|unavailable",
  "failed|index_write_failed|unavailable",
]);

/** The complete vocabulary accepted by record mode. */
export const SOURCE_ORIGINAL_OBSERVATION_VOCABULARY = Object.freeze({
  locator_kinds: Object.freeze(["source_relative_path"]),
  stages: OBSERVATION_STAGES,
  outcomes: OBSERVATION_OUTCOMES,
  text_states: OBSERVATION_TEXT_STATES,
  page_count_states: OBSERVATION_PAGE_COUNT_STATES,
  reason_codes: OBSERVATION_REASON_CODES,
  outcome_triples: OBSERVATION_OUTCOME_TRIPLES,
  recordable_outcomes: Object.freeze(["gap", "adjudicated_exclusion", "failed"]),
  raw_original_result_binding: "available_for_bound_current_revisions",
  accepted_result_family_receipt: "available_non_authorizing",
  accepted_resolution: "available_for_one_exact_current_result_family",
});

const STAGES = new Set(OBSERVATION_STAGES);
const OUTCOMES = new Set(OBSERVATION_OUTCOMES);
const TEXT_STATES = new Set(OBSERVATION_TEXT_STATES);
const PAGE_COUNT_STATES = new Set(OBSERVATION_PAGE_COUNT_STATES);
const OUTCOME_TRIPLES = new Set(OBSERVATION_OUTCOME_TRIPLES);

const respond = (body, status = 200) => privateNoStore(jsonResponse(body, status));

class ObservationRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const refuse = (code, message, status = 400) => {
  throw new ObservationRequestError(status, code, message);
};

function exactObject(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Id(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function requestBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    await request.body?.cancel("source original observation request exceeded limit").catch(() => {});
    refuse("source_original_request_too_large", "request is too large", 413);
  }
  if (!request.body) refuse("source_original_invalid_json", "request must be one JSON object");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += bytes.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel("source original observation request exceeded limit").catch(() => {});
        refuse("source_original_request_too_large", "request is too large", 413);
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed;
  } catch (error) {
    if (error instanceof ObservationRequestError) throw error;
    refuse("source_original_invalid_json", "request must be one JSON object");
  }
}

function normalizedSource(value) {
  return normalizeSourceOriginalSource(value);
}

function normalizedLocator(value) {
  return normalizeSourceOriginalLocator("source_relative_path", value).locator;
}

function normalizedLocatorTarget(value, { recorded = false } = {}) {
  const base = ["locator_kind", "locator", "original_id"];
  const fields = recorded
    ? [...base, "observation_stage", "outcome", "reason_code", "text_state",
      "original_content_sha256", "original_byte_count", "page_count", "page_count_state",
      "resolves_observation_hash"]
    : base.slice(0, 2);
  if (!exactObject(value, fields)) {
    refuse("source_original_invalid_target", "each target must use the exact bounded target contract");
  }
  if (value.locator_kind !== "source_relative_path") {
    refuse("source_original_invalid_locator_kind", "locator_kind is not supported");
  }
  const target = {
    locator_kind: value.locator_kind,
    locator: normalizedLocator(value.locator),
  };
  if (!recorded) return target;
  if (!ORIGINAL_ID_RE.test(value.original_id)) {
    refuse("source_original_invalid_id", "original_id is invalid");
  }
  if (!STAGES.has(value.observation_stage) || !OUTCOMES.has(value.outcome) ||
      !TEXT_STATES.has(value.text_state) ||
      !OUTCOME_TRIPLES.has(`${value.outcome}|${value.reason_code}|${value.text_state}`)) {
    refuse("source_original_invalid_outcome", "observation outcome is not in the closed contract");
  }
  const unavailableContent = value.text_state === "unavailable";
  if (unavailableContent) {
    if (value.original_content_sha256 !== null || value.original_byte_count !== null) {
      refuse("source_original_invalid_content_receipt", "unavailable content must use explicit null measurements");
    }
  } else if (!SHA_RE.test(value.original_content_sha256) ||
      !Number.isSafeInteger(value.original_byte_count) || value.original_byte_count < 0) {
    refuse("source_original_invalid_content_receipt", "observed content needs a hash and byte count");
  }
  if (!PAGE_COUNT_STATES.has(value.page_count_state) ||
      (value.page_count_state === "authoritative" &&
        (!Number.isSafeInteger(value.page_count) || value.page_count < 1 || value.page_count > 10000)) ||
      (value.page_count_state !== "authoritative" && value.page_count !== null)) {
    refuse("source_original_invalid_page_receipt", "page count state and value do not agree");
  }
  const resolves = value.resolves_observation_hash;
  if (value.observation_stage === "repair" && value.outcome === "accepted") {
    if (!SHA_ID_RE.test(resolves)) {
      refuse("source_original_invalid_resolution", "an accepted repair must name one prior observation receipt");
    }
  } else if (resolves !== null) {
    refuse("source_original_invalid_resolution", "only an accepted repair may resolve a prior observation");
  }
  return {
    ...target,
    original_id: value.original_id,
    observation_stage: value.observation_stage,
    outcome: value.outcome,
    reason_code: value.reason_code,
    text_state: value.text_state,
    original_content_sha256: value.original_content_sha256,
    original_byte_count: value.original_byte_count,
    page_count: value.page_count,
    page_count_state: value.page_count_state,
    resolves_observation_hash: resolves,
  };
}

function normalizedTargets(value, options) {
  if (!Array.isArray(value) || value.length < 1 || value.length > SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS) {
    refuse("source_original_invalid_target_count", `targets must contain 1-${SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS} entries`);
  }
  return value.map((target) => normalizedLocatorTarget(target, options));
}

function commonBinding(body, { recorded = false } = {}) {
  const fields = ["contract_version", "mode", "source", ...(recorded ? ["run_id"] : []),
    "plan_id", "source_snapshot_id", "target_set_hash", "targets"];
  const required = recorded ? fields : fields.filter((field) => field !== "target_set_hash");
  if (!exactObject(body, fields, required)) {
    refuse("source_original_invalid_request", "request does not match the selected mode contract");
  }
  if (body.contract_version !== SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION) {
    refuse("source_original_contract_unsupported", "contract_version is not supported");
  }
  const source = normalizedSource(body.source);
  if (!SHA_RE.test(body.plan_id) || !SHA_ID_RE.test(body.source_snapshot_id) ||
      (recorded && !SHA_ID_RE.test(body.target_set_hash))) {
    refuse("source_original_invalid_binding", "plan or snapshot binding is invalid");
  }
  return {
    source,
    plan_id: body.plan_id,
    source_snapshot_id: body.source_snapshot_id,
    target_set_hash: body.target_set_hash,
    targets: normalizedTargets(body.targets, { recorded }),
  };
}

function acceptedResolutionBinding(body) {
  const fields = [
    "contract_version", "mode", "operation", "source", "run_id", "plan_id",
    "source_snapshot_id", "target_set_hash", "targets", "retrieval_query",
  ];
  if (!exactObject(body, fields) ||
      body.contract_version !== SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION ||
      body.mode !== "accepted_resolution" || !RUN_RE.test(body.run_id)) {
    refuse("source_original_accepted_resolution_invalid_request", "accepted_resolution request does not match the exact contract");
  }
  const operation = body.operation;
  if (!["record", "verify"].includes(operation)) {
    refuse("source_original_accepted_resolution_invalid_operation", "accepted_resolution operation must be record or verify");
  }
  if (!Array.isArray(body.targets) || body.targets.length !== 1) {
    refuse("source_original_accepted_resolution_target_count", "accepted_resolution requires exactly one sealed target");
  }
  const value = body.targets[0];
  const targetFields = [
    "locator_kind", "locator", "original_id", "text_state",
    "original_content_sha256", "original_byte_count", "page_count",
    "page_count_state", "resolves_observation_hash",
  ];
  if (!exactObject(value, targetFields) || value.locator_kind !== "source_relative_path" ||
      !ORIGINAL_ID_RE.test(value.original_id) ||
      !["native_readable", "ocr_reliable"].includes(value.text_state) ||
      !SHA_RE.test(value.original_content_sha256) ||
      !Number.isSafeInteger(value.original_byte_count) || value.original_byte_count < 0 ||
      !["authoritative", "not_applicable"].includes(value.page_count_state) ||
      (value.page_count_state === "authoritative" &&
        (!Number.isSafeInteger(value.page_count) || value.page_count < 1 || value.page_count > 10000)) ||
      (value.page_count_state === "not_applicable" && value.page_count !== null) ||
      !SHA_ID_RE.test(value.resolves_observation_hash)) {
    refuse("source_original_accepted_resolution_invalid_target", "accepted_resolution target does not match the exact accepted-repair contract");
  }
  const source = normalizedSource(body.source);
  if (!SHA_RE.test(body.plan_id) || !SHA_ID_RE.test(body.source_snapshot_id) ||
      !SHA_ID_RE.test(body.target_set_hash)) {
    refuse("source_original_invalid_binding", "plan or snapshot binding is invalid");
  }
  return {
    operation,
    source,
    run_id: body.run_id,
    plan_id: body.plan_id,
    source_snapshot_id: body.source_snapshot_id,
    target_set_hash: body.target_set_hash,
    retrieval_query: body.retrieval_query,
    targets: [{
      locator_kind: value.locator_kind,
      locator: normalizedLocator(value.locator),
      original_id: value.original_id,
      observation_stage: "repair",
      outcome: "accepted",
      reason_code: "accepted_provenance_verified",
      text_state: value.text_state,
      original_content_sha256: value.original_content_sha256,
      original_byte_count: value.original_byte_count,
      page_count: value.page_count,
      page_count_state: value.page_count_state,
      resolves_observation_hash: value.resolves_observation_hash,
    }],
  };
}

async function sealedTargets(env, binding) {
  const key = await loadSourceOriginalSigningKey(env);
  const targets = [];
  for (const target of binding.targets) {
    targets.push({
      ...target,
      original_id: await deriveSourceOriginalId(key, {
        source: binding.source,
        locator_kind: target.locator_kind,
        locator: target.locator,
      }),
    });
  }
  if (new Set(targets.map((target) => target.original_id)).size !== targets.length) {
    refuse("source_original_duplicate_target", "targets must be unique");
  }
  const targetSetHash = await sha256Id(canonical({
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    source: binding.source,
    plan_id: binding.plan_id,
    source_snapshot_id: binding.source_snapshot_id,
    targets: targets.map((target) => ({
      locator_kind: target.locator_kind,
      original_id: target.original_id,
    })).sort((left, right) => left.original_id.localeCompare(right.original_id)),
  }));
  return { targets, targetSetHash };
}

async function requireUploadSource(env, source) {
  const row = await env.DB.prepare("SELECT name, kind FROM sources WHERE name=?1").bind(source).first();
  if (row?.name !== source) refuse("source_original_source_not_registered", "source is not registered", 404);
  if (row.kind !== "upload") {
    refuse("source_original_source_kind_unsupported", "only directly observed upload originals are supported", 409);
  }
}

function rowsOf(result) {
  if (!result || !Array.isArray(result.results)) throw new Error("D1 result is unavailable");
  return result.results;
}

async function currentDocumentSnapshot(env, source, locator) {
  const base = `${source}:${locator}`;
  const result = await env.DB.prepare(
    `SELECT d.doc_uid,d.source,d.source_id,d.ingested_at,d.content_hash,d.meta,d.text_source,d.text_reliable,
            d.provenance_receipt_version,d.provenance_receipt_status,
            d.provenance_receipt_reason,d.provenance_receipt_digest,
            d.document_revision_id,d.source_original_binding_hash,
            (SELECT json_object(
               'contract_version',bound.contract_version,
               'tenant_id',bound.tenant_id,
               'source',bound.source,
               'original_id',bound.original_id,
               'locator_kind',bound.locator_kind,
               'document_revision_id',bound.document_revision_id,
               'original_content_sha256',bound.original_content_sha256,
               'original_byte_count',bound.original_byte_count,
               'document_content_hash',bound.document_content_hash,
               'provenance_receipt_digest',bound.provenance_receipt_digest,
               'binding_hash',bound.binding_hash)
               FROM source_original_result_bindings AS bound
              WHERE bound.binding_hash=d.source_original_binding_hash
                AND bound.document_revision_id=d.document_revision_id
                AND bound.source=d.source
                AND bound.document_content_hash=d.content_hash
                AND bound.provenance_receipt_digest=d.provenance_receipt_digest
              LIMIT 1) AS source_original_binding_receipt,
            COUNT(c.id) AS chunk_count,
            SUM(CASE WHEN length(trim(c.text)) > 0 THEN 1 ELSE 0 END) AS readable_chunk_count,
            COALESCE(SUM(length(c.text)),0) AS chunk_text_bytes
       FROM documents d
       LEFT JOIN chunks c ON c.doc_uid=d.doc_uid
      WHERE d.source=?1 AND d.deleted_at IS NULL AND (
        d.source_id=?2 OR
        d.doc_uid=?3 OR
        substr(d.doc_uid,1,length(?3 || '#part'))=?3 || '#part' OR
        (json_valid(d.meta) AND json_type(d.meta,'$.family_of')='text' AND json_extract(d.meta,'$.family_of')=?3) OR
        (d.source=?1 AND json_valid(d.meta) AND json_type(d.meta,'$.part_of')='text' AND
          json_extract(d.meta,'$.part_of') IN (?2,?3))
      )
      GROUP BY d.doc_uid
      ORDER BY d.doc_uid
      LIMIT ?4`,
  ).bind(source, locator, base, MAX_DOCUMENTS_PER_ORIGINAL + 1).all();
  const rows = rowsOf(result);
  if (rows.length > MAX_DOCUMENTS_PER_ORIGINAL) {
    throw new ObservationRequestError(503, "source_original_family_too_large", "document family exceeds the verification bound");
  }
  const documents = [];
  const bindingDocuments = [];
  for (const row of rows) {
    const assessment = await storedProvenanceMarkerAssessment(row);
    let metadata = null;
    try {
      const parsed = JSON.parse(String(row.meta ?? ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      // The shared marker assessment already treats malformed metadata as
      // unproven. Keep the target-root receipt false as well.
    }
    const receiptRoots = Array.isArray(metadata?.provenance_receipt?.root_ids)
      ? metadata.provenance_receipt.root_ids
      : [];
    let sourceOriginalBinding = null;
    try {
      const parsed = typeof row.source_original_binding_receipt === "string"
        ? JSON.parse(row.source_original_binding_receipt)
        : row.source_original_binding_receipt;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        sourceOriginalBinding = parsed;
      }
    } catch {
      // A malformed binding is not readiness. Keep it out of the stable
      // document-set hash and let the exact verifier fail closed below.
    }
    documents.push({
      doc_uid: String(row.doc_uid),
      source: String(row.source),
      source_id: String(row.source_id),
      ingested_at: Number(row.ingested_at),
      content_hash: String(row.content_hash),
      metadata_hash: await sha256Id(String(row.meta ?? "")),
      text_source: String(row.text_source ?? "unknown"),
      text_reliable: row.text_reliable === true || row.text_reliable === 1 || row.text_reliable === "1",
      provenance_receipt_version: row.provenance_receipt_version === null ? null : Number(row.provenance_receipt_version),
      provenance_receipt_status: row.provenance_receipt_status ?? null,
      provenance_receipt_reason: row.provenance_receipt_reason ?? null,
      provenance_receipt_digest: row.provenance_receipt_digest ?? null,
      provenance_marker_valid: assessment.provenance_marker_valid === true,
      provenance_assessed: assessment.provenance_assessed === true,
      target_root_bound: receiptRoots.includes(base),
      assessed_text_source: assessment.text_source,
      assessed_text_reliable: assessment.text_reliable === true,
      chunk_count: Number(row.chunk_count || 0),
      readable_chunk_count: Number(row.readable_chunk_count || 0),
      chunk_text_bytes: Number(row.chunk_text_bytes || 0),
    });
    bindingDocuments.push({
      doc_uid: String(row.doc_uid),
      source: String(row.source),
      content_hash: String(row.content_hash),
      provenance_receipt_digest: row.provenance_receipt_digest ?? null,
      document_revision_id: row.document_revision_id ?? null,
      source_original_binding_hash: row.source_original_binding_hash ?? null,
      source_original_binding: sourceOriginalBinding,
    });
  }
  const structuralParts = documents.map((document) => {
    if (!document.doc_uid.startsWith(`${base}#part`)) return null;
    const match = /^#part([1-9][0-9]*)of([1-9][0-9]*)$/.exec(document.doc_uid.slice(base.length));
    if (!match) return { valid: false, part: 0, total: 0 };
    return { valid: true, part: Number(match[1]), total: Number(match[2]) };
  });
  let familyComplete = documents.length === 1 && documents[0].doc_uid === base;
  if (structuralParts.some(Boolean)) {
    const parsed = structuralParts.filter(Boolean);
    const totals = new Set(parsed.map((part) => part.total));
    const total = totals.size === 1 ? parsed[0].total : 0;
    const numbers = new Set(parsed.map((part) => part.part));
    familyComplete = parsed.length === documents.length && parsed.every((part) => part.valid) &&
      total > 0 && parsed.length === total && numbers.size === total &&
      [...numbers].every((part) => part >= 1 && part <= total);
  }
  return {
    count: documents.length,
    hash: await sha256Id(canonical(documents)),
    documents,
    binding_documents: bindingDocuments,
    family_complete: familyComplete,
  };
}

function provenanceEvidenceMatches(textState, snapshot) {
  if (!snapshot.family_complete || !snapshot.documents.length ||
      !["native_readable", "ocr_reliable"].includes(textState)) return false;
  const expectedSource = textState === "native_readable" ? "native" : "ocr";
  return snapshot.documents.every((document) =>
    document.provenance_marker_valid === true &&
    document.provenance_assessed === true &&
    document.target_root_bound === true &&
    document.provenance_receipt_status === "complete" &&
    document.provenance_receipt_reason === "lineage_and_text_recorded" &&
    document.assessed_text_source === expectedSource &&
    document.assessed_text_reliable === true &&
    document.readable_chunk_count > 0
  );
}

async function rawOriginalBindingEvidenceMatches(target, snapshot) {
  if (!snapshot.family_complete || !snapshot.documents.length ||
      snapshot.binding_documents.length !== snapshot.documents.length ||
      !ORIGINAL_ID_RE.test(target.original_id || "") ||
      !SHA_RE.test(target.original_content_sha256 || "") ||
      !Number.isSafeInteger(target.original_byte_count) || target.original_byte_count < 0) {
    return false;
  }
  for (const document of snapshot.binding_documents) {
    const stored = document.source_original_binding;
    if (!stored || typeof stored !== "object" || Array.isArray(stored) ||
        stored.binding_hash !== document.source_original_binding_hash) return false;
    const { binding_hash: bindingHash, ...storedReceipt } = stored;
    const expectedReceipt = {
      contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
      tenant_id: SOURCE_ORIGINAL_TENANT_ID,
      source: document.source,
      original_id: target.original_id,
      locator_kind: target.locator_kind,
      document_revision_id: document.document_revision_id,
      original_content_sha256: target.original_content_sha256,
      original_byte_count: target.original_byte_count,
      document_content_hash: document.content_hash,
      provenance_receipt_digest: document.provenance_receipt_digest,
    };
    try {
      const expectedHash = await hashSourceOriginalResultBinding(expectedReceipt);
      if (bindingHash !== expectedHash ||
          await hashSourceOriginalResultBinding(storedReceipt) !== expectedHash ||
          canonical(storedReceipt) !== canonical(expectedReceipt)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function acceptedEvidenceIsValid(target, snapshot) {
  return target.outcome !== "accepted" || (
    provenanceEvidenceMatches(target.text_state, snapshot) &&
    await rawOriginalBindingEvidenceMatches(target, snapshot)
  );
}

async function observedOutcomeMatches(target, snapshot) {
  if (target.outcome === "accepted") return acceptedEvidenceIsValid(target, snapshot);
  if (target.outcome === "gap" && target.reason_code === "current_document_missing") {
    return snapshot.count === 0;
  }
  if (target.outcome === "gap" && target.reason_code === "provenance_unassessed") {
    // A complete marker is rooted to a logical locator, not to the exact
    // original bytes measured by this local observation. Until an
    // authoritative raw-byte binding exists, it cannot disprove this gap.
    return true;
  }
  return true;
}

/**
 * Read-only readiness check for one directly observed original. This is an
 * internal prerequisite for the schema-44 result-family proof. The record
 * route continues to reject accepted observations in this release even when
 * the separate non-authorizing family proof exists.
 */
export async function sourceOriginalResultBindingReadiness(env, {
  source,
  locator,
  locator_kind: locatorKind = "source_relative_path",
  original_content_sha256: originalContentSha256,
  original_byte_count: originalByteCount,
} = {}) {
  const normalizedSource = normalizeSourceOriginalSource(source);
  const normalizedLocator = normalizeSourceOriginalLocator(locatorKind, locator);
  const rawReceipt = normalizeSourceOriginalReceipt({
    version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    locator_kind: normalizedLocator.locator_kind,
    original_content_sha256: originalContentSha256,
    original_byte_count: originalByteCount,
  });
  const signingKey = await loadSourceOriginalSigningKey(env);
  const originalId = await deriveSourceOriginalId(signingKey, {
    source: normalizedSource,
    ...normalizedLocator,
  });
  const snapshot = await currentDocumentSnapshot(env, normalizedSource, normalizedLocator.locator);
  const ready = await rawOriginalBindingEvidenceMatches({
    original_id: originalId,
    locator_kind: rawReceipt.locator_kind,
    original_content_sha256: rawReceipt.original_content_sha256,
    original_byte_count: rawReceipt.original_byte_count,
  }, snapshot);
  return Object.freeze({
    ready,
    original_id: originalId,
    document_count: snapshot.count,
    document_set_hash: snapshot.hash,
    family_complete: snapshot.family_complete,
  });
}

export function sourceOriginalObservationReceiptFields(value) {
  return {
    contract_version: Number(value.contract_version),
    tenant_id: String(value.tenant_id),
    source: String(value.source),
    original_id: String(value.original_id),
    locator_kind: String(value.locator_kind),
    run_id: String(value.run_id),
    plan_id: String(value.plan_id),
    source_snapshot_id: String(value.source_snapshot_id),
    target_set_hash: String(value.target_set_hash),
    target_count: Number(value.target_count),
    observation_stage: String(value.observation_stage),
    outcome: String(value.outcome),
    reason_code: String(value.reason_code),
    text_state: String(value.text_state),
    original_content_sha256: value.original_content_sha256 === null ? null : String(value.original_content_sha256),
    original_byte_count: value.original_byte_count === null ? null : Number(value.original_byte_count),
    page_count: value.page_count === null ? null : Number(value.page_count),
    page_count_state: String(value.page_count_state),
    result_document_count: Number(value.result_document_count),
    result_document_set_hash: String(value.result_document_set_hash),
    resolves_observation_hash: value.resolves_observation_hash === null
      ? null
      : String(value.resolves_observation_hash),
  };
}

export async function sourceOriginalObservationHash(receipt) {
  return sha256Id(canonical(sourceOriginalObservationReceiptFields(receipt)));
}

const observationHash = sourceOriginalObservationHash;

const RECEIPT_COLUMNS = `sequence,contract_version,tenant_id,source,original_id,locator_kind,
  run_id,plan_id,source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,
  reason_code,text_state,original_content_sha256,original_byte_count,page_count,page_count_state,
  result_document_count,result_document_set_hash,resolves_observation_hash,observation_hash,recorded_at`;

async function repairLineageValid(env, receipt) {
  if (receipt.observation_stage !== "repair" || receipt.outcome !== "accepted") return true;
  if (!receipt.original_content_sha256 || !SHA_ID_RE.test(receipt.resolves_observation_hash)) return false;
  const result = await env.DB.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM source_original_observations
      WHERE source=?1 AND original_id=?2 AND observation_hash=?3 LIMIT 2`,
  ).bind(receipt.source, receipt.original_id, receipt.resolves_observation_hash).all();
  const rows = rowsOf(result);
  if (rows.length !== 1) return false;
  const prior = rows[0];
  return ["gap", "failed"].includes(prior.outcome) &&
    prior.original_content_sha256 !== null &&
    prior.original_content_sha256 === receipt.original_content_sha256 &&
    (prior.result_document_count !== receipt.result_document_count ||
      prior.result_document_set_hash !== receipt.result_document_set_hash) &&
    await observationHash(prior) === prior.observation_hash;
}

function publicReceipt(row) {
  return {
    sequence: Number(row.sequence),
    source: String(row.source),
    original_id: String(row.original_id),
    locator_kind: String(row.locator_kind),
    run_id: String(row.run_id),
    plan_id: String(row.plan_id),
    source_snapshot_id: String(row.source_snapshot_id),
    target_set_hash: String(row.target_set_hash),
    target_count: Number(row.target_count),
    observation_stage: String(row.observation_stage),
    outcome: String(row.outcome),
    reason_code: String(row.reason_code),
    text_state: String(row.text_state),
    original_content_sha256: row.original_content_sha256 === null ? null : String(row.original_content_sha256),
    original_byte_count: row.original_byte_count === null ? null : Number(row.original_byte_count),
    page_count: row.page_count === null ? null : Number(row.page_count),
    page_count_state: String(row.page_count_state),
    result_document_count: Number(row.result_document_count),
    result_document_set_hash: String(row.result_document_set_hash),
    resolves_observation_hash: row.resolves_observation_hash === null
      ? null
      : String(row.resolves_observation_hash),
    observation_hash: String(row.observation_hash),
    recorded_at: Number(row.recorded_at),
  };
}

function boundedScope() {
  return {
    kind: "bounded_target_set",
    maximum_targets: SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS,
    whole_source_complete: false,
    accepted_outcomes_supported: false,
    repair_verification_supported: false,
    raw_original_result_family_receipt: "available_non_authorizing",
    meaning: "Evidence applies only to the explicitly sealed originals; it is not a whole-source enumeration.",
  };
}

function acceptedResolutionScope() {
  return {
    ...boundedScope(),
    kind: "single_target_accepted_resolution",
    maximum_targets: 1,
    accepted_outcomes_supported: true,
    accepted_resolution_mode: "one_exact_current_result_family",
    repair_verification_supported: true,
  };
}

async function handleSeal(env, body) {
  const binding = commonBinding(body);
  await requireUploadSource(env, binding.source);
  const sealed = await sealedTargets(env, binding);
  return respond({
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    mode: "seal",
    source: binding.source,
    plan_id: binding.plan_id,
    source_snapshot_id: binding.source_snapshot_id,
    target_set_hash: sealed.targetSetHash,
    target_count: sealed.targets.length,
    targets: sealed.targets.map((target, position) => ({ position, original_id: target.original_id })),
    scope: boundedScope(),
  });
}

async function handleRecord(env, body) {
  const fields = ["contract_version", "mode", "source", "run_id", "plan_id", "source_snapshot_id", "target_set_hash", "targets"];
  if (!exactObject(body, fields) || !RUN_RE.test(body.run_id)) {
    refuse("source_original_invalid_request", "record request does not match the exact contract");
  }
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    throw new ObservationRequestError(503, "corpus_writes_paused", "brain writes are paused for a verified upgrade or rollback");
  }
  const binding = commonBinding(body, { recorded: true });
  await requireUploadSource(env, binding.source);
  const sealed = await sealedTargets(env, binding);
  if (sealed.targetSetHash !== binding.target_set_hash ||
      sealed.targets.some((target, index) => target.original_id !== binding.targets[index].original_id)) {
    refuse("source_original_binding_mismatch", "target identities do not match the sealed plan", 409);
  }

  const recordedAt = Date.now();
  const receipts = [];
  for (const target of binding.targets) {
    if (target.outcome === "accepted") {
      // Schema 44 can record the complete family and retrieval evidence, but
      // that proof is deliberately non-authorizing. Accepted repair remains a
      // separate reviewed change, so this release still refuses it here.
      throw new ObservationRequestError(
        409,
        "source_original_acceptance_chain_unavailable",
        "accepted outcomes require a result-family receipt and retrieval proof",
      );
    }
    const snapshot = await currentDocumentSnapshot(env, binding.source, target.locator);
    if (!await observedOutcomeMatches(target, snapshot)) {
      refuse("source_original_outcome_unobserved", "claimed outcome does not match exact current document evidence", 409);
    }
    const receipt = {
      contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
      tenant_id: SOURCE_ORIGINAL_TENANT_ID,
      source: binding.source,
      original_id: target.original_id,
      locator_kind: target.locator_kind,
      run_id: body.run_id,
      plan_id: binding.plan_id,
      source_snapshot_id: binding.source_snapshot_id,
      target_set_hash: binding.target_set_hash,
      target_count: binding.targets.length,
      observation_stage: target.observation_stage,
      outcome: target.outcome,
      reason_code: target.reason_code,
      text_state: target.text_state,
      original_content_sha256: target.original_content_sha256,
      original_byte_count: target.original_byte_count,
      page_count: target.page_count,
      page_count_state: target.page_count_state,
      result_document_count: snapshot.count,
      result_document_set_hash: snapshot.hash,
      resolves_observation_hash: target.resolves_observation_hash,
    };
    if (!await repairLineageValid(env, receipt)) {
      refuse("source_original_source_changed", "accepted repair does not resolve a prior gap for the same original bytes", 409);
    }
    receipts.push({ ...receipt, observation_hash: await observationHash(receipt), recorded_at: recordedAt });
  }

  const priorResult = await env.DB.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM source_original_observations
      WHERE run_id=?1 ORDER BY sequence LIMIT ?2`,
  ).bind(body.run_id, SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS + 1).all();
  const priorRows = rowsOf(priorResult);
  const expectedIds = new Set(receipts.map((receipt) => receipt.original_id));
  for (const row of priorRows) {
    if (await observationHash(row) !== row.observation_hash) {
      throw new ObservationRequestError(
        503,
        "source_original_observation_corrupt",
        "stored observation integrity check failed",
      );
    }
  }
  if (priorRows.length > SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS || priorRows.some((row) =>
    row.source !== binding.source || row.plan_id !== binding.plan_id ||
    row.source_snapshot_id !== binding.source_snapshot_id ||
    row.target_set_hash !== binding.target_set_hash ||
    Number(row.target_count) !== receipts.length || !expectedIds.has(String(row.original_id)))) {
    refuse("source_original_run_binding_conflict", "run_id already belongs to a different sealed target set", 409);
  }
  const prior = new Map(priorRows.map((row) => [String(row.original_id), row]));
  if (receipts.some((receipt) => prior.has(receipt.original_id) &&
      prior.get(receipt.original_id).observation_hash !== receipt.observation_hash)) {
    refuse("source_original_observation_conflict", "an immutable observation already exists for this run and original", 409);
  }

  // BEFORE INSERT duplicate guards protect SQLite's REPLACE loophole. Exact
  // retries therefore skip rows already proven identical instead of relying
  // on conflict handling at the insert statement.
  const pendingReceipts = receipts.filter((receipt) => !prior.has(receipt.original_id));
  let batchFailed = false;
  try {
    if (pendingReceipts.length) await env.DB.batch(pendingReceipts.map((receipt) => env.DB.prepare(
      `INSERT INTO source_original_observations
         (contract_version,tenant_id,source,original_id,locator_kind,run_id,plan_id,
          source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,reason_code,
          text_state,original_content_sha256,original_byte_count,page_count,page_count_state,
          result_document_count,result_document_set_hash,resolves_observation_hash,observation_hash,recorded_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)`,
    ).bind(
      receipt.contract_version, receipt.tenant_id, receipt.source, receipt.original_id,
      receipt.locator_kind, receipt.run_id, receipt.plan_id, receipt.source_snapshot_id,
      receipt.target_set_hash, receipt.target_count, receipt.observation_stage, receipt.outcome,
      receipt.reason_code, receipt.text_state, receipt.original_content_sha256,
      receipt.original_byte_count, receipt.page_count, receipt.page_count_state,
      receipt.result_document_count, receipt.result_document_set_hash,
      receipt.resolves_observation_hash, receipt.observation_hash, receipt.recorded_at,
    )));
  } catch {
    // Another identical request may have won the race. Only a complete,
    // integrity-checked readback below may reconcile that case.
    batchFailed = true;
  }

  const readbackResult = await env.DB.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM source_original_observations
      WHERE run_id=?1 ORDER BY sequence LIMIT ?2`,
  ).bind(body.run_id, SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS + 1).all();
  const readbackRows = rowsOf(readbackResult);
  const expected = new Map(receipts.map((receipt) => [receipt.original_id, receipt]));
  let exactReadback = readbackRows.length === receipts.length;
  for (const row of readbackRows) {
    const expectedReceipt = expected.get(String(row.original_id));
    if (!expectedReceipt || await observationHash(row) !== row.observation_hash ||
        row.observation_hash !== expectedReceipt.observation_hash) {
      exactReadback = false;
    }
  }
  const readback = new Map(readbackRows.map((row) => [String(row.original_id), row]));
  if (!exactReadback) {
    if (batchFailed && readbackRows.length < receipts.length &&
        readbackRows.every((row) => expected.has(String(row.original_id)))) {
      throw new ObservationRequestError(503, "source_original_record_unavailable", "observation batch was not recorded");
    }
    refuse("source_original_observation_conflict", "exact observation readback did not match", 409);
  }
  return respond({
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    mode: "record",
    source: binding.source,
    run_id: body.run_id,
    target_set_hash: binding.target_set_hash,
    target_count: receipts.length,
    observations: receipts.map((receipt) => publicReceipt(readback.get(receipt.original_id))),
    bounded_target_set_recorded: true,
    repair_receipts_recorded: receipts.every((receipt) => receipt.observation_stage === "repair" && receipt.outcome === "accepted"),
    scope: boundedScope(),
  });
}

async function handleAcceptedResolution(env, body, dependencies) {
  const binding = acceptedResolutionBinding(body);
  if (binding.operation === "record" && env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    throw new ObservationRequestError(
      503,
      "corpus_writes_paused",
      "brain writes are paused for a verified upgrade or rollback",
    );
  }
  await requireUploadSource(env, binding.source);
  const sealed = await sealedTargets(env, binding);
  const target = binding.targets[0];
  if (sealed.targetSetHash !== binding.target_set_hash ||
      sealed.targets.length !== 1 || sealed.targets[0].original_id !== target.original_id) {
    refuse("source_original_binding_mismatch", "target identity does not match the sealed one-original plan", 409);
  }

  const before = await currentDocumentSnapshot(env, binding.source, target.locator);
  if (!await acceptedEvidenceIsValid(target, before)) {
    refuse("source_original_outcome_unobserved", "accepted outcome does not match exact current document evidence", 409);
  }
  const proof = await buildSourceOriginalResultFamilyProof(env, {
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    mode: "result_family",
    operation: binding.operation,
    source: binding.source,
    locator_kind: target.locator_kind,
    locator: target.locator,
    original_content_sha256: target.original_content_sha256,
    original_byte_count: target.original_byte_count,
    retrieval_query: binding.retrieval_query,
  }, {
    ...dependencies,
    readBindingReadiness: sourceOriginalResultBindingReadiness,
  });
  if (proof.originalId !== target.original_id) {
    refuse("source_original_binding_mismatch", "result-family proof belongs to a different original", 409);
  }

  // The observation hash and the schema-44 family receipt use different
  // canonical projections. Re-read the observation projection after the
  // family/retrieval proof so both views describe the same bounded cut.
  const snapshot = await currentDocumentSnapshot(env, binding.source, target.locator);
  if (snapshot.count !== before.count || snapshot.hash !== before.hash ||
      proof.documentCount !== snapshot.count || !await acceptedEvidenceIsValid(target, snapshot)) {
    refuse("source_original_result_family_changed", "the exact current result family changed during accepted-resolution proof", 409);
  }
  const observation = {
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    tenant_id: SOURCE_ORIGINAL_TENANT_ID,
    source: binding.source,
    original_id: target.original_id,
    locator_kind: target.locator_kind,
    run_id: binding.run_id,
    plan_id: binding.plan_id,
    source_snapshot_id: binding.source_snapshot_id,
    target_set_hash: binding.target_set_hash,
    target_count: 1,
    observation_stage: "repair",
    outcome: "accepted",
    reason_code: "accepted_provenance_verified",
    text_state: target.text_state,
    original_content_sha256: target.original_content_sha256,
    original_byte_count: target.original_byte_count,
    page_count: target.page_count,
    page_count_state: target.page_count_state,
    result_document_count: snapshot.count,
    result_document_set_hash: snapshot.hash,
    resolves_observation_hash: target.resolves_observation_hash,
  };
  if (!await repairLineageValid(env, observation)) {
    refuse("source_original_source_changed", "accepted repair does not resolve one prior unresolved observation for the same original bytes", 409);
  }
  observation.observation_hash = await observationHash(observation);

  const persistence = binding.operation === "record"
    ? await recordSourceOriginalAcceptedResolution(env, { observation, proof })
    : await verifySourceOriginalAcceptedResolution(env, { observation, proof });
  return {
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    mode: "accepted_resolution",
    operation: binding.operation,
    source: binding.source,
    run_id: binding.run_id,
    original_id: target.original_id,
    target_set_hash: binding.target_set_hash,
    target_count: 1,
    resolves_observation_hash: observation.resolves_observation_hash,
    accepted_observation_hash: observation.observation_hash,
    resolution_hash: persistence.resolution_hash,
    activation_hash: persistence.activation_hash,
    family_receipt_hash: proof.familyReceipt.family_receipt_hash,
    verification_hash: proof.verification.verification_hash,
    document_count: proof.documentCount,
    chunk_count: proof.chunkCount,
    vector_readiness_hash: proof.projection.vector_readiness_hash,
    retrieval_probe_id: proof.retrievalProbeId,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    status: "accepted_resolution_current",
    recorded: persistence.recorded,
    replayed: persistence.replayed,
    reactivated: persistence.reactivated,
    accepted_outcome_authorized: true,
    bounded_target_set_repair_verified: true,
    scope: acceptedResolutionScope(),
  };
}

async function handleInventory(env, body) {
  const fields = ["contract_version", "mode", "source", "after_sequence", "limit", "snapshot_id"];
  if (!exactObject(body, fields, ["contract_version", "mode", "source"]) ||
      body.contract_version !== SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION) {
    refuse("source_original_invalid_request", "inventory request does not match the exact contract");
  }
  const source = normalizedSource(body.source);
  await loadSourceOriginalSigningKey(env);
  const after = body.after_sequence === undefined ? 0 : body.after_sequence;
  const limit = body.limit === undefined ? SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS : body.limit;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS ||
      (body.snapshot_id !== undefined && !SHA_ID_RE.test(body.snapshot_id))) {
    refuse("source_original_invalid_inventory_cursor", "inventory cursor or limit is invalid");
  }
  const marker = await env.DB.prepare(
    `SELECT COUNT(*) AS count,COALESCE(MAX(sequence),0) AS max_sequence,
            COALESCE(SUM(sequence),0) AS sequence_sum
       FROM source_original_observations WHERE source=?1`,
  ).bind(source).first();
  const snapshotId = await sha256Id(canonical({
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    source,
    count: Number(marker?.count || 0),
    max_sequence: Number(marker?.max_sequence || 0),
    sequence_sum: Number(marker?.sequence_sum || 0),
  }));
  if (body.snapshot_id !== undefined && body.snapshot_id !== snapshotId) {
    refuse("source_original_inventory_changed", "observation inventory changed; restart at the first page", 409);
  }
  const result = await env.DB.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM source_original_observations
      WHERE source=?1 AND sequence>?2 AND sequence<=?3 ORDER BY sequence LIMIT ?4`,
  ).bind(source, after, Number(marker?.max_sequence || 0), limit + 1).all();
  const rows = rowsOf(result);
  for (const row of rows) {
    if (await observationHash(row) !== row.observation_hash) {
      throw new ObservationRequestError(503, "source_original_observation_corrupt", "stored observation integrity check failed");
    }
  }
  const page = rows.slice(0, limit);
  const truncated = rows.length > limit;
  return respond({
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    mode: "inventory",
    source,
    snapshot_id: snapshotId,
    returned: page.length,
    total: Number(marker?.count || 0),
    page_complete: !truncated,
    next_after_sequence: truncated ? Number(page.at(-1).sequence) : null,
    observations: page.map(publicReceipt),
    scope: boundedScope(),
  });
}

async function handleVerify(env, body) {
  const fields = ["contract_version", "mode", "source", "run_id", "plan_id", "source_snapshot_id", "target_set_hash", "targets"];
  if (!exactObject(body, fields) || !RUN_RE.test(body.run_id)) {
    refuse("source_original_invalid_request", "verify request does not match the exact contract");
  }
  const binding = commonBinding(body, { recorded: true });
  await requireUploadSource(env, binding.source);
  const sealed = await sealedTargets(env, binding);
  if (sealed.targetSetHash !== binding.target_set_hash ||
      sealed.targets.some((target, index) => target.original_id !== binding.targets[index].original_id)) {
    refuse("source_original_binding_mismatch", "target identities do not match the sealed plan", 409);
  }
  const result = await env.DB.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM source_original_observations
      WHERE run_id=?1 ORDER BY sequence LIMIT ?2`,
  ).bind(body.run_id, SOURCE_ORIGINAL_OBSERVATION_MAX_TARGETS + 1).all();
  const runRows = rowsOf(result);
  const expectedIds = new Set(binding.targets.map((target) => target.original_id));
  const runBindingMatches = runRows.length === binding.targets.length && runRows.every((row) =>
    row.source === binding.source && row.plan_id === binding.plan_id &&
    row.source_snapshot_id === binding.source_snapshot_id &&
    row.target_set_hash === binding.target_set_hash &&
    Number(row.target_count) === binding.targets.length && expectedIds.has(String(row.original_id)));
  const stored = new Map(runRows.map((row) => [String(row.original_id), row]));
  const targets = [];
  for (const target of binding.targets) {
    const row = stored.get(target.original_id);
    let status = "missing_observation";
    if (!row) {
      status = "missing_observation";
    } else if (!runBindingMatches) {
      status = "run_binding_conflict";
    } else {
      const bindingMatches = row.source === binding.source && row.plan_id === binding.plan_id &&
        row.source_snapshot_id === binding.source_snapshot_id && row.target_set_hash === binding.target_set_hash &&
        Number(row.target_count) === binding.targets.length;
      if (!bindingMatches || await observationHash(row) !== row.observation_hash) {
        status = "observation_corrupt";
      } else if (row.outcome === "accepted") {
        status = "accepted_resolution_mode_required";
      } else if (target.original_content_sha256 !== row.original_content_sha256) {
        // The HMAC identity is path-stable, so bytes are a separate required
        // fence. Replacement at the same path is a new observation, never a
        // successful repair of the prior original.
        status = "source_changed";
      } else if (target.locator_kind !== row.locator_kind ||
          target.observation_stage !== row.observation_stage ||
          target.outcome !== row.outcome || target.reason_code !== row.reason_code ||
          target.text_state !== row.text_state ||
          target.original_byte_count !== row.original_byte_count ||
          target.page_count !== row.page_count || target.page_count_state !== row.page_count_state ||
          target.resolves_observation_hash !== row.resolves_observation_hash) {
        status = "submitted_observation_mismatch";
      } else {
        const snapshot = await currentDocumentSnapshot(env, binding.source, target.locator);
        if (snapshot.count !== Number(row.result_document_count) || snapshot.hash !== row.result_document_set_hash) {
          status = "current_result_changed";
        } else if (row.outcome === "gap") {
          status = "observed_gap";
        } else if (row.outcome === "adjudicated_exclusion") {
          status = "observed_exclusion";
        } else {
          status = "observed_failure";
        }
      }
    }
    targets.push({
      original_id: target.original_id,
      status,
      observation_hash: row?.observation_hash || null,
    });
  }
  const observationVerified = targets.every((target) =>
    ["observed_gap", "observed_exclusion", "observed_failure"].includes(target.status));
  return respond({
    contract_version: SOURCE_ORIGINAL_OBSERVATION_CONTRACT_VERSION,
    mode: "verify",
    source: binding.source,
    run_id: body.run_id,
    target_set_hash: binding.target_set_hash,
    target_count: targets.length,
    targets,
    bounded_target_set_observation_verified: observationVerified,
    bounded_target_set_repair_verified: false,
    scope: boundedScope(),
  }, observationVerified ? 200 : 409);
}

/** Handle every mode behind one admin-only, body-only private endpoint. */
export async function handleSourceOriginalObservation(env, request, dependencies = {}) {
  if (!validateAdminKey(request, env)) {
    return respond({ error: "unauthorized", code: "admin_required" }, 401);
  }
  if (request.method !== "POST") {
    return respond({
      error: "source original observations must use a JSON POST body so private locators never enter URLs",
      code: "source_original_post_required",
    }, 405);
  }
  if (backendOf(env) !== D1) {
    return respond({ error: "source original observations apply to the d1 backend only", code: "d1_required" }, 400);
  }
  try {
    const body = await requestBody(request);
    if (!exactObject(body, Object.keys(body)) || typeof body.mode !== "string") {
      refuse("source_original_invalid_request", "request mode is required");
    }
    if (body.mode === "seal") return await handleSeal(env, body);
    if (body.mode === "record") return await handleRecord(env, body);
    if (body.mode === "inventory") return await handleInventory(env, body);
    if (body.mode === "verify") return await handleVerify(env, body);
    if (body.mode === "accepted_resolution") {
      return respond(await handleAcceptedResolution(env, body, dependencies));
    }
    if (body.mode === "result_family") {
      return respond(await handleSourceOriginalResultFamily(env, body, {
        ...dependencies,
        readBindingReadiness: sourceOriginalResultBindingReadiness,
      }));
    }
    refuse("source_original_mode_unsupported", "mode must be seal, record, inventory, verify, result_family, or accepted_resolution");
  } catch (error) {
    if (error instanceof ObservationRequestError || error instanceof SourceOriginalBindingError ||
        error instanceof SourceOriginalResultFamilyError ||
        error instanceof SourceOriginalAcceptedResolutionError) {
      return respond({ error: error.message, code: error.code }, error.status);
    }
    return respond({ error: "source original observation is unavailable", code: "source_original_unavailable" }, 503);
  }
}
