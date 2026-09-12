/**
 * Fixed synthetic corpus for the disposable v0.4.8 recovery field campaign.
 *
 * This module has no live transport, credential lookup, file reader, or corpus
 * input. A field adapter must inject the two authenticated data-plane calls.
 * The returned receipt contains aggregate evidence only. The built-in fixture
 * is exported solely so a reviewed adapter can submit those exact documents.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withFirstPartySourceProvenance } from "../worker/src/lib/provenance-receipt.js";

export const DISPOSABLE_RECOVERY_SEED_PROTOCOL = "disposable-recovery-seed-v1";
export const DISPOSABLE_RECOVERY_SEED_DOCUMENTS = 6_001;
export const DISPOSABLE_RECOVERY_SEED_BATCH_SIZE = 50;
export const DISPOSABLE_RECOVERY_SEED_BATCHES = Math.ceil(
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS / DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
);
export const DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS = 6_001;
export const DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION = "0.4.8";
export const DISPOSABLE_RECOVERY_MARKER = "v048-orchid-ledger-field-marker";
export const DISPOSABLE_RECOVERY_VECTOR_DIMENSIONS = 768;
export const DISPOSABLE_RECOVERY_VECTOR_METRIC = "cosine";

const DATA_CLASS = "deterministic_fictional_synthetic_only";
const FIXTURE_SOURCE_TYPE = "recovery_field_v048";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,127}$/u;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function fixtureDocument(index) {
  const ordinal = String(index).padStart(4, "0");
  const content = index === 0
    ? `Synthetic recovery marker ${DISPOSABLE_RECOVERY_MARKER}. This fictional record is only for a disposable field test.`
    : `Synthetic fictional recovery record ${ordinal}. This deterministic text exists only to test D1 ingestion and recovery.`;
  return deepFreeze(withFirstPartySourceProvenance({
    source_type: FIXTURE_SOURCE_TYPE,
    source_id: `record-${ordinal}`,
    title: `Synthetic recovery record ${ordinal}`,
    content,
    metadata: {
      platform: "synthetic",
      fixture_protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
      ordinal: index,
    },
  }, { textSource: "native", textReliable: true }));
}

const FIXTURE = deepFreeze(Array.from(
  { length: DISPOSABLE_RECOVERY_SEED_DOCUMENTS },
  (_, index) => fixtureDocument(index),
));

export const DISPOSABLE_RECOVERY_FIXTURE_SHA256 = sha256(canonicalJson(FIXTURE));

export class DisposableRecoverySeedError extends Error {
  constructor(code, message, {
    mayHaveWritten = false,
    safeToRetry = false,
    confirmedDocuments = 0,
    ambiguousDocuments = 0,
  } = {}) {
    super(message);
    this.name = "DisposableRecoverySeedError";
    this.code = code;
    this.may_have_written = mayHaveWritten;
    this.safe_to_retry = safeToRetry;
    this.confirmed_documents = confirmedDocuments;
    this.ambiguous_documents = ambiguousDocuments;
  }
}

function fail(code, message, state) {
  throw new DisposableRecoverySeedError(code, message, state);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function validateRuntimeInventory(body, { final = false, errorState } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.version !== DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION ||
      body.backend !== "d1" || body.vector_drain_mode !== "active" ||
      !Array.isArray(body.rows)) {
    fail("inventory_contract_mismatch", "The D1 inventory did not match the sealed v0.4.8 campaign contract.", errorState);
  }

  if (!final) {
    if (body.rows.length !== 0) {
      fail("inventory_not_disposable", "The destination was not an empty disposable Brain, so nothing was seeded.");
    }
    return null;
  }

  const matches = body.rows.filter((row) => row?.source_type === FIXTURE_SOURCE_TYPE);
  const row = matches[0] || null;
  if (body.rows.length !== 1 || matches.length !== 1 ||
      row.document_counts_exact !== true || row.chunk_counts_exact !== true ||
      row.documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      row.logical_documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      row.stored_documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      !safeInteger(row.chunks) || row.chunks < DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS ||
      row.total !== row.chunks) {
    fail("d1_count_proof_failed", "Exact D1 inventory did not prove the required synthetic documents and chunks.", errorState);
  }
  return row;
}

function validateProjectionReadyInventory(body, row, errorState) {
  const backlog = body?.vector_backlog;
  const readiness = body?.vector_readiness;
  if (!row || row.embedded !== row.chunks ||
      !backlog || typeof backlog !== "object" || Array.isArray(backlog) ||
      backlog.pending !== 0 || backlog.upserts !== 0 || backlog.deletes !== 0 ||
      backlog.submitted !== 0 ||
      !readiness || typeof readiness !== "object" || Array.isArray(readiness) ||
      readiness.ready !== true || readiness.expected_vectors !== row.chunks ||
      readiness.actual_vectors !== row.chunks || readiness.pending !== 0 ||
      readiness.submitted !== 0) {
    fail(
      "projection_not_settled",
      "The synthetic projection was not exactly ready, so no D1 content proof was issued.",
      errorState,
    );
  }
  return true;
}

function validateDirectD1Proof(value, row, errorState) {
  if (!exactKeys(value, [
    "content_fingerprint", "document_count", "chunk_count", "fts_count",
    "pending_outbox", "failed_vectors",
  ]) || !SHA256_RE.test(String(value.content_fingerprint || "")) ||
      value.document_count !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      value.chunk_count !== row.chunks || value.fts_count !== row.chunks ||
      value.pending_outbox !== 0 || value.failed_vectors !== 0) {
    fail(
      "direct_d1_fingerprint_invalid",
      "The direct D1 fingerprint did not prove the exact settled synthetic corpus.",
      errorState,
    );
  }
  return Object.freeze({ ...value });
}

function validateOpeningDirectD1Proof(value) {
  if (!exactKeys(value, [
    "document_count", "chunk_count", "fts_count", "pending_outbox", "failed_vectors",
  ]) || value.document_count !== 0 || value.chunk_count !== 0 || value.fts_count !== 0 ||
      value.pending_outbox !== 0 || value.failed_vectors !== 0) {
    fail(
      "opening_direct_d1_not_empty",
      "Independent D1 counts did not prove an empty disposable source, so nothing was seeded.",
      { safeToRetry: false },
    );
  }
  return Object.freeze({ ...value });
}

function validateDeploymentProof(value, binding) {
  if (!exactKeys(value, [
    "deployment_receipt_sha256", "source_resource_fingerprint",
    "source_active_version_id", "source_script_etag", "source_active_traffic_percent",
    "target_resource_fingerprint", "target_paused_version_id",
    "target_paused_script_etag", "target_active_version_id",
    "target_active_script_etag", "target_paused_traffic_percent",
    "target_active_not_promoted", "provider_readback",
  ]) || value.deployment_receipt_sha256 !== binding.deployment_receipt_sha256 ||
      value.source_resource_fingerprint !== binding.source_resource_fingerprint ||
      value.source_active_version_id !== binding.source_active_version_id ||
      value.source_script_etag !== binding.source_script_etag ||
      value.source_active_traffic_percent !== 100 ||
      value.target_resource_fingerprint !== binding.target_resource_fingerprint ||
      value.target_paused_version_id !== binding.target_paused_version_id ||
      value.target_paused_script_etag !== binding.target_paused_script_etag ||
      value.target_active_version_id !== binding.target_active_version_id ||
      value.target_active_script_etag !== binding.target_active_script_etag ||
      value.target_paused_traffic_percent !== 100 ||
      value.target_active_not_promoted !== true || value.provider_readback !== true) {
    fail(
      "deployment_identity_invalid",
      "The live disposable Worker versions did not match the exact package deployment receipt.",
      { safeToRetry: false },
    );
  }
  return Object.freeze({ ...value });
}

function validateIndependentProjection(value, row, errorState) {
  if (!exactKeys(value, [
    "vectorize_vectors", "vector_dimensions", "vector_metric",
    "quarantined_vectors", "independent_control_plane",
  ]) || !safeInteger(value.vectorize_vectors) || value.vectorize_vectors !== row.chunks ||
      value.vector_dimensions !== DISPOSABLE_RECOVERY_VECTOR_DIMENSIONS ||
      value.vector_metric !== DISPOSABLE_RECOVERY_VECTOR_METRIC ||
      value.quarantined_vectors !== 0 || value.independent_control_plane !== true) {
    fail(
      "independent_projection_invalid",
      "Independent Vectorize evidence did not match the exact settled D1 chunk count.",
      errorState,
    );
  }
  return Object.freeze({ ...value });
}

function validateRetrievalChecks(value, errorState) {
  if (!exactKeys(value, ["supported_case_cited", "unsupported_case_refused"]) ||
      value.supported_case_cited !== true || value.unsupported_case_refused !== true) {
    fail(
      "retrieval_checks_invalid",
      "The supported citation and unrelated refusal checks did not both pass.",
      errorState,
    );
  }
  return Object.freeze({ ...value });
}

/** Validate the private package, manifest, and candidate binding for one run. */
export function assertDisposableRecoverySeedBinding(binding) {
  const opaqueProviderEtag = (value) => typeof value === "string" &&
    value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!exactKeys(binding, [
    "schema_version", "candidate_sha", "candidate_tree_sha",
    "field_receipt_sha256", "deployment_receipt_sha256",
    "package_sha256", "package_file_count",
    "execution_inventory_sha256", "installed_execution_inventory_sha256",
    "runner_sha256", "seeder_sha256", "content_fingerprint_helper_sha256",
    "source_manifest_fingerprint", "source_resource_fingerprint",
    "target_manifest_fingerprint", "target_resource_fingerprint",
    "source_active_version_id", "source_script_etag",
    "target_paused_version_id", "target_paused_script_etag",
    "target_active_version_id", "target_active_script_etag",
    "runtime_contract_fingerprint", "wrangler_wrapper_sha256",
    "wrangler_runtime_inventory_sha256", "wrangler_entrypoint_sha256",
    "node_executable_sha256", "execution_approval_fingerprint",
  ]) || binding.schema_version !== 3 ||
      !COMMIT_RE.test(String(binding.candidate_sha || "")) ||
      !COMMIT_RE.test(String(binding.candidate_tree_sha || "")) ||
      !Number.isSafeInteger(binding.package_file_count) || binding.package_file_count < 1 ||
      [
        binding.field_receipt_sha256,
        binding.deployment_receipt_sha256,
        binding.package_sha256,
        binding.execution_inventory_sha256,
        binding.installed_execution_inventory_sha256,
        binding.runner_sha256,
        binding.seeder_sha256,
        binding.content_fingerprint_helper_sha256,
        binding.source_manifest_fingerprint,
        binding.source_resource_fingerprint,
        binding.target_manifest_fingerprint,
        binding.target_resource_fingerprint,
        binding.runtime_contract_fingerprint,
        binding.wrangler_wrapper_sha256,
        binding.wrangler_runtime_inventory_sha256,
        binding.wrangler_entrypoint_sha256,
        binding.node_executable_sha256,
        binding.execution_approval_fingerprint,
      ].some((value) => !SHA256_RE.test(String(value || ""))) ||
      !opaqueProviderEtag(binding.source_script_etag) ||
      !opaqueProviderEtag(binding.target_paused_script_etag) ||
      !opaqueProviderEtag(binding.target_active_script_etag) ||
      !VERSION_RE.test(String(binding.source_active_version_id || "")) ||
      !VERSION_RE.test(String(binding.target_paused_version_id || "")) ||
      !VERSION_RE.test(String(binding.target_active_version_id || "")) ||
      new Set([
        binding.source_active_version_id,
        binding.target_paused_version_id,
        binding.target_active_version_id,
      ]).size !== 3) {
    fail("seed_binding_invalid", "The private synthetic seed binding is invalid.");
  }
  if (binding.execution_approval_fingerprint !==
      disposableRecoverySeedExecutionApprovalFingerprint(binding)) {
    fail("seed_binding_invalid", "The private synthetic seed approval binding is invalid.");
  }
  return Object.freeze({ ...binding });
}

/** Exact approval value for the sealed synthetic seed execution, never a secret. */
export function disposableRecoverySeedExecutionApprovalFingerprint(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("seed_binding_invalid", "The private synthetic seed binding is invalid.");
  }
  const approvalInput = { ...binding };
  delete approvalInput.execution_approval_fingerprint;
  return sha256(canonicalJson({
    schema_version: 1,
    purpose: "execute_exact_v048_disposable_recovery_seed",
    fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
    fixture_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
    fixture_batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
    binding: approvalInput,
  }));
}

function validateBatchReceipt(body, documents, expectedStatus, errorState) {
  const counters = ["created", "updated", "unchanged", "refused", "failed", "total"];
  if (!exactKeys(body, [...counters, "results"]) ||
      counters.some((key) => !safeInteger(body[key])) ||
      body.total !== documents.length ||
      body.created + body.updated + body.unchanged + body.refused + body.failed !== body.total ||
      body[expectedStatus] !== documents.length ||
      (expectedStatus === "created" ? body.unchanged !== 0 : body.created !== 0) ||
      body.updated !== 0 || body.refused !== 0 || body.failed !== 0 ||
      !Array.isArray(body.results) || body.results.length !== documents.length) {
    fail("ingest_receipt_rejected", "A synthetic ingest batch was not accepted exactly as submitted.", errorState);
  }

  for (let index = 0; index < documents.length; index++) {
    const result = body.results[index];
    const document = documents[index];
    if (!exactKeys(result, ["source_type", "source_id", "doc_uid", "status", "chunks"]) ||
        result.status !== expectedStatus ||
        result.source_type !== document.source_type || result.source_id !== document.source_id ||
        result.doc_uid !== `${document.source_type}:${document.source_id}` ||
        (expectedStatus === "created" && (!safeInteger(result.chunks) || result.chunks < 1)) ||
        (expectedStatus === "unchanged" && result.chunks !== 0)) {
      fail("ingest_result_unbound", "A synthetic ingest result was missing its exact ordered receipt binding.", errorState);
    }
  }
}

async function inventoryThrough(readInventory, errorState) {
  try {
    return await readInventory();
  } catch {
    fail("inventory_transport_failed", "The authenticated D1 inventory could not be read, so no field proof was issued.", errorState);
  }
}

function completionTime(now, errorState) {
  let date;
  try {
    date = new Date(now());
  } catch {
    fail("clock_invalid", "The field receipt clock was invalid.", errorState);
  }
  if (!Number.isFinite(date.getTime())) fail("clock_invalid", "The field receipt clock was invalid.", errorState);
  return date.toISOString();
}

export function disposableRecoverySeedPlan() {
  return deepFreeze({
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
    operation: "plan",
    data_class: DATA_CLASS,
    writes: false,
    external_source_input: false,
    expected_worker_version: DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION,
    fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
    fixture_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
    maximum_batch_documents: DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
    fixture_batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
    minimum_d1_chunks: DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
    authenticated_d1_inventory_required: true,
    opening_direct_d1_empty_required: true,
    deployment_receipt_and_live_identity_required: true,
    settled_vector_projection_required: true,
    direct_d1_content_fingerprint_required: true,
    independent_vectorize_projection_required: true,
    supported_and_refused_retrieval_checks_required: true,
  });
}

/** Return the immutable built-in fixture for a reviewed transport adapter. */
export function disposableRecoveryFixture() {
  return FIXTURE;
}

/**
 * Seed the fixed fixture and issue an aggregate receipt only after the live
 * inventory callback proves actual D1 rows. No generated-length calculation
 * can satisfy this gate.
 */
export async function seedDisposableRecoveryFixture(options) {
  const allowed = new Set([
    "binding", "verifyDeployment", "ingestBatch", "readInventory",
    "readOpeningDirectD1", "settleProjection",
    "readContentFingerprint", "readIndependentProjection", "runRetrievalChecks", "now",
  ]);
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some((key) => !allowed.has(key)) ||
      typeof options.ingestBatch !== "function" || typeof options.readInventory !== "function" ||
      typeof options.readOpeningDirectD1 !== "function" ||
      typeof options.verifyDeployment !== "function" ||
      typeof options.settleProjection !== "function" ||
      typeof options.readContentFingerprint !== "function" ||
      typeof options.readIndependentProjection !== "function" ||
      typeof options.runRetrievalChecks !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")) {
    fail(
      "invalid_dependencies",
      "The synthetic seeder requires reviewed ingest, direct D1, independent Vectorize, and retrieval transports.",
    );
  }
  const binding = assertDisposableRecoverySeedBinding(options.binding);

  let openingDirectD1;
  try {
    openingDirectD1 = validateOpeningDirectD1Proof(await options.readOpeningDirectD1());
  } catch (error) {
    if (error instanceof DisposableRecoverySeedError) throw error;
    fail(
      "opening_direct_d1_failed",
      "Independent D1 counts could not prove an empty disposable source, so nothing was seeded.",
      { safeToRetry: false },
    );
  }
  let deployment;
  try {
    deployment = validateDeploymentProof(await options.verifyDeployment(), binding);
  } catch (error) {
    if (error instanceof DisposableRecoverySeedError) throw error;
    fail(
      "deployment_identity_failed",
      "The live disposable Worker versions could not be rebound to the exact package deployment receipt.",
      { safeToRetry: false },
    );
  }
  const opening = await inventoryThrough(options.readInventory, { safeToRetry: true });
  validateRuntimeInventory(opening);

  for (let offset = 0; offset < FIXTURE.length; offset += DISPOSABLE_RECOVERY_SEED_BATCH_SIZE) {
    const documents = Object.freeze(FIXTURE.slice(offset, offset + DISPOSABLE_RECOVERY_SEED_BATCH_SIZE));
    const errorState = {
      mayHaveWritten: true,
      safeToRetry: false,
      confirmedDocuments: offset,
      ambiguousDocuments: documents.length,
    };
    let body;
    try {
      body = await options.ingestBatch(documents);
    } catch {
      fail("ingest_transport_failed", "A synthetic ingest batch could not be confirmed. Recreate the disposable destination before retrying.", errorState);
    }
    validateBatchReceipt(body, documents, "created", errorState);
  }

  const seededState = {
    mayHaveWritten: true,
    safeToRetry: false,
    confirmedDocuments: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  };
  const inventory = await inventoryThrough(options.readInventory, seededState);
  validateRuntimeInventory(inventory, { final: true, errorState: seededState });

  // A second full pass is intentionally mandatory. Exact unchanged receipts
  // bind the final D1 identities and content hashes to the sealed fixture; a
  // generated document count or an unrelated 6,001-row corpus cannot pass.
  for (let offset = 0; offset < FIXTURE.length; offset += DISPOSABLE_RECOVERY_SEED_BATCH_SIZE) {
    const documents = Object.freeze(FIXTURE.slice(offset, offset + DISPOSABLE_RECOVERY_SEED_BATCH_SIZE));
    const errorState = { ...seededState, ambiguousDocuments: documents.length };
    let body;
    try {
      body = await options.ingestBatch(documents);
    } catch {
      fail("replay_transport_failed", "The synthetic verification replay could not be confirmed, so no field proof was issued.", errorState);
    }
    validateBatchReceipt(body, documents, "unchanged", errorState);
  }

  try {
    await options.settleProjection();
  } catch {
    fail(
      "projection_settle_failed",
      "The synthetic vector projection did not settle. Reconcile the disposable source before retrying.",
      seededState,
    );
  }

  const verifiedInventory = await inventoryThrough(options.readInventory, seededState);
  const row = validateRuntimeInventory(verifiedInventory, { final: true, errorState: seededState });
  validateProjectionReadyInventory(verifiedInventory, row, seededState);
  let independentProjection;
  let evaluation;
  try {
    independentProjection = validateIndependentProjection(
      await options.readIndependentProjection(),
      row,
      seededState,
    );
    evaluation = validateRetrievalChecks(await options.runRetrievalChecks(), seededState);
  } catch (error) {
    if (error instanceof DisposableRecoverySeedError) throw error;
    fail(
      "independent_field_proof_failed",
      "Independent source projection or retrieval proof could not be confirmed.",
      seededState,
    );
  }
  let directD1;
  try {
    directD1 = validateDirectD1Proof(
      await options.readContentFingerprint(),
      row,
      seededState,
    );
  } catch (error) {
    if (error instanceof DisposableRecoverySeedError) throw error;
    fail(
      "direct_d1_fingerprint_failed",
      "The direct D1 content fingerprint could not be confirmed, so no field proof was issued.",
      seededState,
    );
  }
  const closingInventory = await inventoryThrough(options.readInventory, seededState);
  const closingRow = validateRuntimeInventory(
    closingInventory,
    { final: true, errorState: seededState },
  );
  validateProjectionReadyInventory(closingInventory, closingRow, seededState);
  if (closingRow.documents !== row.documents || closingRow.chunks !== row.chunks ||
      closingRow.total !== row.total) {
    fail(
      "inventory_changed_during_fingerprint",
      "The D1 inventory changed while its content fingerprint was captured.",
      seededState,
    );
  }
  const receipt = {
    schema_version: 3,
    protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
    status: "passed",
    completed_at: completionTime(options.now || Date.now, seededState),
    data_class: DATA_CLASS,
    binding,
    deployment,
    fixture: {
      sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
      documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
      maximum_batch_documents: DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
    },
    ingest: {
      accepted_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      created_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      unchanged_documents: 0,
      updated_documents: 0,
      refused_documents: 0,
      failed_documents: 0,
    },
    verification_replay: {
      batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
      unchanged_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      exact_identity_and_content_replay: true,
    },
    opening_d1: {
      documents: openingDirectD1.document_count,
      chunks: openingDirectD1.chunk_count,
      fts: openingDirectD1.fts_count,
      pending_outbox: openingDirectD1.pending_outbox,
      failed_vectors: openingDirectD1.failed_vectors,
      independently_verified_empty: true,
    },
    d1: {
      worker_version: closingInventory.version,
      documents: closingRow.documents,
      chunks: closingRow.chunks,
      fts: directD1.fts_count,
      minimum_chunks: DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
      document_counts_exact: true,
      chunk_counts_exact: true,
      minimum_chunk_count_met: true,
      pending_outbox: directD1.pending_outbox,
      failed_vectors: directD1.failed_vectors,
      content_fingerprint: directD1.content_fingerprint,
      content_fingerprint_source: "direct_d1_normalized_export",
    },
    projection: independentProjection,
    evaluation,
    proof_boundary: {
      external_source_input: false,
      aggregate_only: true,
      authenticated_d1_inventory_verified: true,
      direct_d1_opening_empty_verified: true,
      worker_vector_readiness_verified: true,
      direct_d1_content_fingerprint_verified: true,
      vectorize_proven: true,
      retrieval_proven: true,
      recovery_proven: false,
    },
  };
  if (!SHA256_RE.test(receipt.fixture.sha256)) {
    fail("fixture_digest_invalid", "The fixed synthetic fixture digest was invalid.");
  }
  assertDisposableRecoverySeedReceipt(receipt);
  return deepFreeze(receipt);
}

/** Strictly validate one persisted private schema-3 seed receipt. */
export function assertDisposableRecoverySeedReceipt(receipt) {
  let completedAtValid = false;
  try {
    completedAtValid = new Date(receipt?.completed_at).toISOString() === receipt?.completed_at;
  } catch { /* fixed refusal below */ }
  if (!exactKeys(receipt, [
    "schema_version", "protocol", "status", "completed_at", "data_class",
    "binding", "deployment", "fixture", "ingest", "verification_replay", "opening_d1", "d1",
    "projection", "evaluation", "proof_boundary",
  ]) || receipt.schema_version !== 3 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_SEED_PROTOCOL ||
      receipt.status !== "passed" || receipt.data_class !== DATA_CLASS ||
      !completedAtValid) {
    fail("seed_receipt_invalid", "The private synthetic seed receipt is invalid.");
  }
  assertDisposableRecoverySeedBinding(receipt.binding);
  validateDeploymentProof(receipt.deployment, receipt.binding);
  if (!exactKeys(receipt.fixture, [
    "sha256", "documents", "batches", "maximum_batch_documents",
  ]) || receipt.fixture.sha256 !== DISPOSABLE_RECOVERY_FIXTURE_SHA256 ||
      receipt.fixture.documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      receipt.fixture.batches !== DISPOSABLE_RECOVERY_SEED_BATCHES ||
      receipt.fixture.maximum_batch_documents !== DISPOSABLE_RECOVERY_SEED_BATCH_SIZE ||
      !exactKeys(receipt.ingest, [
        "accepted_documents", "created_documents", "unchanged_documents",
        "updated_documents", "refused_documents", "failed_documents",
      ]) || receipt.ingest.accepted_documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      receipt.ingest.created_documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      receipt.ingest.unchanged_documents !== 0 || receipt.ingest.updated_documents !== 0 ||
      receipt.ingest.refused_documents !== 0 || receipt.ingest.failed_documents !== 0 ||
      !exactKeys(receipt.verification_replay, [
        "batches", "unchanged_documents", "exact_identity_and_content_replay",
      ]) || receipt.verification_replay.batches !== DISPOSABLE_RECOVERY_SEED_BATCHES ||
      receipt.verification_replay.unchanged_documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      receipt.verification_replay.exact_identity_and_content_replay !== true) {
    fail("seed_receipt_invalid", "The private synthetic seed receipt is invalid.");
  }
  if (!exactKeys(receipt.opening_d1, [
    "documents", "chunks", "fts", "pending_outbox", "failed_vectors",
    "independently_verified_empty",
  ]) || receipt.opening_d1.documents !== 0 || receipt.opening_d1.chunks !== 0 ||
      receipt.opening_d1.fts !== 0 || receipt.opening_d1.pending_outbox !== 0 ||
      receipt.opening_d1.failed_vectors !== 0 ||
      receipt.opening_d1.independently_verified_empty !== true) {
    fail("seed_receipt_invalid", "The private synthetic seed receipt is invalid.");
  }
  if (!exactKeys(receipt.d1, [
    "worker_version", "documents", "chunks", "fts", "minimum_chunks",
    "document_counts_exact", "chunk_counts_exact", "minimum_chunk_count_met",
    "pending_outbox", "failed_vectors", "content_fingerprint",
    "content_fingerprint_source",
  ]) || receipt.d1.worker_version !== DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION ||
      receipt.d1.documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      !safeInteger(receipt.d1.chunks) ||
      receipt.d1.chunks < DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS ||
      !safeInteger(receipt.d1.fts) ||
      receipt.d1.fts !== receipt.d1.chunks ||
      receipt.d1.minimum_chunks !== DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS ||
      receipt.d1.document_counts_exact !== true || receipt.d1.chunk_counts_exact !== true ||
      receipt.d1.minimum_chunk_count_met !== true ||
      !safeInteger(receipt.d1.pending_outbox) || receipt.d1.pending_outbox !== 0 ||
      !safeInteger(receipt.d1.failed_vectors) || receipt.d1.failed_vectors !== 0 ||
      !SHA256_RE.test(String(receipt.d1.content_fingerprint || "")) ||
      receipt.d1.content_fingerprint_source !== "direct_d1_normalized_export") {
    fail("seed_receipt_invalid", "The private synthetic seed receipt is invalid.");
  }
  validateIndependentProjection(
    receipt.projection,
    { chunks: receipt.d1.chunks },
    { safeToRetry: false },
  );
  validateRetrievalChecks(receipt.evaluation, { safeToRetry: false });
  if (!exactKeys(receipt.proof_boundary, [
    "external_source_input", "aggregate_only", "authenticated_d1_inventory_verified",
    "direct_d1_opening_empty_verified",
    "worker_vector_readiness_verified", "direct_d1_content_fingerprint_verified",
    "vectorize_proven", "retrieval_proven", "recovery_proven",
  ]) || receipt.proof_boundary.external_source_input !== false ||
      receipt.proof_boundary.aggregate_only !== true ||
      receipt.proof_boundary.authenticated_d1_inventory_verified !== true ||
      receipt.proof_boundary.direct_d1_opening_empty_verified !== true ||
      receipt.proof_boundary.worker_vector_readiness_verified !== true ||
      receipt.proof_boundary.direct_d1_content_fingerprint_verified !== true ||
      receipt.proof_boundary.vectorize_proven !== true ||
      receipt.proof_boundary.retrieval_proven !== true ||
      receipt.proof_boundary.recovery_proven !== false) {
    fail("seed_receipt_invalid", "The private synthetic seed receipt is invalid.");
  }
  return true;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--plan") {
    process.stderr.write("Usage: node operations/disposable-recovery-seeder.mjs --plan\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(disposableRecoverySeedPlan(), null, 2)}\n`);
  }
}
