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

export const DISPOSABLE_RECOVERY_FIXTURE_PROTOCOL = "disposable-recovery-seed-v1";
export const DISPOSABLE_RECOVERY_SEED_PROTOCOL =
  "disposable-recovery-seed-receipt-v2";
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
const PROVIDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
      fixture_protocol: DISPOSABLE_RECOVERY_FIXTURE_PROTOCOL,
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

function documentsForBatchPrefix(batches) {
  if (!safeInteger(batches) || batches > DISPOSABLE_RECOVERY_SEED_BATCHES) {
    return null;
  }
  return Math.min(
    batches * DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
    DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  );
}

function exactKeys(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function validateRuntimeInventory(body, {
  final = false,
  expectedDocuments = 0,
  errorState,
} = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.version !== DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION ||
      body.backend !== "d1" || body.vector_drain_mode !== "active" ||
      !Array.isArray(body.rows)) {
    fail("inventory_contract_mismatch", "The D1 inventory did not match the sealed v0.4.8 campaign contract.", errorState);
  }

  if (!final) {
    if (expectedDocuments === 0) {
      if (body.rows.length !== 0) {
        fail("inventory_not_disposable", "The destination was not an empty disposable Brain, so nothing was seeded.");
      }
      return null;
    }
    const matches = body.rows.filter((row) => row?.source_type === FIXTURE_SOURCE_TYPE);
    const row = matches[0] || null;
    if (body.rows.length !== 1 || matches.length !== 1 ||
        row.document_counts_exact !== true || row.chunk_counts_exact !== true ||
        row.documents !== expectedDocuments || row.logical_documents !== expectedDocuments ||
        row.stored_documents !== expectedDocuments || row.chunks !== expectedDocuments ||
        row.total !== expectedDocuments || !safeInteger(row.embedded) ||
        row.embedded > expectedDocuments) {
      fail(
        "resume_inventory_mismatch",
        "The disposable Brain did not match the exact confirmed seed prefix, so resume stopped before another batch.",
        errorState,
      );
    }
    return row;
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

function validateOpeningDirectD1Proof(value, expectedDocuments = 0) {
  if (!exactKeys(value, [
    "document_count", "chunk_count", "fts_count", "pending_outbox", "failed_vectors",
  ]) || value.document_count !== expectedDocuments ||
      value.chunk_count !== expectedDocuments || value.fts_count !== expectedDocuments ||
      !safeInteger(value.pending_outbox) || value.pending_outbox > expectedDocuments ||
      value.failed_vectors !== 0) {
    fail(
      expectedDocuments === 0
        ? "opening_direct_d1_not_empty"
        : "resume_direct_d1_mismatch",
      expectedDocuments === 0
        ? "Independent D1 counts did not prove an empty disposable source, so nothing was seeded."
        : "Independent D1 counts did not match the exact confirmed seed prefix, so resume stopped before another batch.",
      { safeToRetry: false },
    );
  }
  return Object.freeze({ ...value });
}

/** Validate the content-free progress needed to resume the deterministic seed. */
export function assertDisposableRecoverySeedResumeState(value) {
  if (!exactKeys(value, [
    "opening_empty_verified",
    "verified_completed_batch_prefix", "verified_completed_document_prefix",
    "verified_replay_batch_prefix", "verified_replay_document_prefix",
  ]) || typeof value.opening_empty_verified !== "boolean" ||
      !safeInteger(value.verified_completed_batch_prefix) ||
      !safeInteger(value.verified_completed_document_prefix) ||
      !safeInteger(value.verified_replay_batch_prefix) ||
      !safeInteger(value.verified_replay_document_prefix) ||
      documentsForBatchPrefix(value.verified_completed_batch_prefix) !==
        value.verified_completed_document_prefix ||
      documentsForBatchPrefix(value.verified_replay_batch_prefix) !==
        value.verified_replay_document_prefix ||
      value.verified_replay_batch_prefix > value.verified_completed_batch_prefix ||
      (value.verified_replay_batch_prefix > 0 &&
        value.verified_completed_batch_prefix !== DISPOSABLE_RECOVERY_SEED_BATCHES) ||
      ((value.verified_completed_batch_prefix > 0 ||
        value.verified_replay_batch_prefix > 0) &&
        value.opening_empty_verified !== true)) {
    fail(
      "seed_resume_state_invalid",
      "The private synthetic seed resume state is invalid.",
      { safeToRetry: false },
    );
  }
  return deepFreeze({ ...value });
}

function initialResumeState() {
  return assertDisposableRecoverySeedResumeState({
    opening_empty_verified: false,
    verified_completed_batch_prefix: 0,
    verified_completed_document_prefix: 0,
    verified_replay_batch_prefix: 0,
    verified_replay_document_prefix: 0,
  });
}

async function checkpointThrough(checkpoint, state, errorState = {}) {
  if (!checkpoint) return;
  try {
    await checkpoint(deepFreeze(structuredClone(state)));
  } catch {
    fail(
      "seed_resume_checkpoint_failed",
      "The private seed resume checkpoint could not be written and read back exactly.",
      errorState,
    );
  }
}

function validateSourceDeploymentProof(value, binding) {
  if (!exactKeys(value, [
    "source_phase_receipt_sha256", "source_phase_run_id",
    "source_a2_approval_fingerprint", "source_resource_fingerprint",
    "source_active_version_id", "source_script_etag", "source_deployment_id",
    "source_active_traffic_percent",
  ]) || value.source_phase_receipt_sha256 !== binding.source_phase_receipt_sha256 ||
      value.source_phase_run_id !== binding.source_phase_run_id ||
      value.source_a2_approval_fingerprint !== binding.source_a2_approval_fingerprint ||
      value.source_resource_fingerprint !== binding.source_resource_fingerprint ||
      value.source_active_version_id !== binding.source_active_version_id ||
      value.source_script_etag !== binding.source_script_etag ||
      value.source_deployment_id !== binding.source_deployment_id ||
      value.source_active_traffic_percent !== 100) {
    fail(
      "source_deployment_identity_invalid",
      "The live disposable source Worker did not match the exact source-phase receipt.",
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
    "field_receipt_sha256", "source_phase_receipt_sha256",
    "package_sha256", "package_file_count",
    "execution_inventory_sha256", "installed_execution_inventory_sha256",
    "runner_sha256", "seeder_sha256", "content_fingerprint_helper_sha256",
    "source_manifest_fingerprint", "source_resource_fingerprint",
    "source_phase_run_id", "source_a2_approval_fingerprint",
    "source_active_version_id", "source_script_etag", "source_deployment_id",
    "runtime_contract_fingerprint", "wrangler_wrapper_sha256",
    "wrangler_runtime_inventory_sha256", "wrangler_entrypoint_sha256",
    "node_executable_sha256", "execution_approval_fingerprint",
  ]) || binding.schema_version !== 4 ||
      !COMMIT_RE.test(String(binding.candidate_sha || "")) ||
      !COMMIT_RE.test(String(binding.candidate_tree_sha || "")) ||
      !Number.isSafeInteger(binding.package_file_count) || binding.package_file_count < 1 ||
      [
        binding.field_receipt_sha256,
        binding.source_phase_receipt_sha256,
        binding.package_sha256,
        binding.execution_inventory_sha256,
        binding.installed_execution_inventory_sha256,
        binding.runner_sha256,
        binding.seeder_sha256,
        binding.content_fingerprint_helper_sha256,
        binding.source_manifest_fingerprint,
        binding.source_resource_fingerprint,
        binding.source_a2_approval_fingerprint,
        binding.runtime_contract_fingerprint,
        binding.wrangler_wrapper_sha256,
        binding.wrangler_runtime_inventory_sha256,
        binding.wrangler_entrypoint_sha256,
        binding.node_executable_sha256,
        binding.execution_approval_fingerprint,
      ].some((value) => !SHA256_RE.test(String(value || ""))) ||
      !opaqueProviderEtag(binding.source_script_etag) ||
      !VERSION_RE.test(String(binding.source_active_version_id || "")) ||
      !PROVIDER_ID_RE.test(String(binding.source_phase_run_id || "")) ||
      !PROVIDER_ID_RE.test(String(binding.source_deployment_id || ""))) {
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
    schema_version: 3,
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
    source_phase_receipt_and_live_identity_required: true,
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
    "resume", "checkpoint",
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
      (options.checkpoint !== undefined && typeof options.checkpoint !== "function") ||
      (options.now !== undefined && typeof options.now !== "function")) {
    fail(
      "invalid_dependencies",
      "The synthetic seeder requires reviewed ingest, direct D1, independent Vectorize, and retrieval transports.",
    );
  }
  const binding = assertDisposableRecoverySeedBinding(options.binding);
  let progress = options.resume === undefined
    ? initialResumeState()
    : assertDisposableRecoverySeedResumeState(options.resume);
  const checkpoint = options.checkpoint;

  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "verify_opening_direct_d1",
    ambiguous_write_boundary: null,
  }, {
    safeToRetry: true,
    confirmedDocuments: progress.verified_completed_document_prefix,
  });

  let openingDirectD1;
  try {
    openingDirectD1 = validateOpeningDirectD1Proof(
      await options.readOpeningDirectD1(),
      progress.verified_completed_document_prefix,
    );
  } catch (error) {
    if (error instanceof DisposableRecoverySeedError) throw error;
    fail(
      "opening_direct_d1_failed",
      "Independent D1 counts could not prove an empty disposable source, so nothing was seeded.",
      { safeToRetry: false },
    );
  }
  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "verify_source_deployment",
    ambiguous_write_boundary: null,
  }, {
    safeToRetry: true,
    confirmedDocuments: progress.verified_completed_document_prefix,
  });
  let sourceDeployment;
  try {
    sourceDeployment = validateSourceDeploymentProof(await options.verifyDeployment(), binding);
  } catch (error) {
    if (error instanceof DisposableRecoverySeedError) throw error;
    fail(
      "source_deployment_identity_failed",
      "The live disposable source Worker could not be rebound to the exact source-phase receipt.",
      { safeToRetry: false },
    );
  }
  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "verify_opening_inventory",
    ambiguous_write_boundary: null,
  }, {
    safeToRetry: true,
    confirmedDocuments: progress.verified_completed_document_prefix,
  });
  const opening = await inventoryThrough(options.readInventory, {
    safeToRetry: true,
    confirmedDocuments: progress.verified_completed_document_prefix,
  });
  validateRuntimeInventory(opening, {
    expectedDocuments: progress.verified_completed_document_prefix,
    errorState: {
      safeToRetry: false,
      confirmedDocuments: progress.verified_completed_document_prefix,
    },
  });
  progress = assertDisposableRecoverySeedResumeState({
    ...progress,
    opening_empty_verified: true,
  });

  for (
    let offset = progress.verified_completed_document_prefix;
    offset < FIXTURE.length;
    offset += DISPOSABLE_RECOVERY_SEED_BATCH_SIZE
  ) {
    const documents = Object.freeze(FIXTURE.slice(offset, offset + DISPOSABLE_RECOVERY_SEED_BATCH_SIZE));
    const batchNumber = progress.verified_completed_batch_prefix + 1;
    const errorState = {
      mayHaveWritten: true,
      safeToRetry: false,
      confirmedDocuments: offset,
      ambiguousDocuments: documents.length,
    };
    await checkpointThrough(checkpoint, {
      ...progress,
      pending_seed_action: "ingest_fixture_batch",
      ambiguous_write_boundary: {
        action: "ingest_fixture_batch",
        batch_number: batchNumber,
        document_prefix_start: offset,
        document_count: documents.length,
      },
    }, {
      safeToRetry: true,
      confirmedDocuments: offset,
    });
    let body;
    try {
      body = await options.ingestBatch(documents);
    } catch {
      fail("ingest_transport_failed", "A synthetic ingest batch could not be confirmed. Recreate the disposable destination before retrying.", errorState);
    }
    validateBatchReceipt(body, documents, "created", errorState);
    progress = assertDisposableRecoverySeedResumeState({
      ...progress,
      verified_completed_batch_prefix: batchNumber,
      verified_completed_document_prefix: offset + documents.length,
    });
    await checkpointThrough(checkpoint, {
      ...progress,
      pending_seed_action: progress.verified_completed_document_prefix === FIXTURE.length
        ? "verify_seeded_inventory"
        : "ingest_fixture_batch",
      ambiguous_write_boundary: null,
    }, errorState);
  }

  const seededState = {
    mayHaveWritten: true,
    safeToRetry: false,
    confirmedDocuments: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  };
  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "verify_seeded_inventory",
    ambiguous_write_boundary: null,
  }, seededState);
  const inventory = await inventoryThrough(options.readInventory, seededState);
  validateRuntimeInventory(inventory, { final: true, errorState: seededState });

  // Replay progress is a crash diagnostic, not content proof. Its counters are
  // not bound to the exact D1 bytes, so a later invocation must start this
  // proof at zero even when an earlier invocation confirmed a replay prefix.
  // Otherwise count-stable tampering inside that skipped prefix could survive
  // while the remaining batches and a syntactically valid final fingerprint
  // still produce a false full-fixture receipt.
  progress = assertDisposableRecoverySeedResumeState({
    ...progress,
    verified_replay_batch_prefix: 0,
    verified_replay_document_prefix: 0,
  });

  // A full pass in this invocation is intentionally mandatory. Exact unchanged
  // receipts bind every final D1 identity and content hash to the sealed fixture;
  // a generated document count or an unrelated 6,001-row corpus cannot pass.
  for (
    let offset = progress.verified_replay_document_prefix;
    offset < FIXTURE.length;
    offset += DISPOSABLE_RECOVERY_SEED_BATCH_SIZE
  ) {
    const documents = Object.freeze(FIXTURE.slice(offset, offset + DISPOSABLE_RECOVERY_SEED_BATCH_SIZE));
    const batchNumber = progress.verified_replay_batch_prefix + 1;
    const errorState = { ...seededState, ambiguousDocuments: documents.length };
    await checkpointThrough(checkpoint, {
      ...progress,
      pending_seed_action: "verification_replay_batch",
      ambiguous_write_boundary: {
        action: "verification_replay_batch",
        batch_number: batchNumber,
        document_prefix_start: offset,
        document_count: documents.length,
      },
    }, seededState);
    let body;
    try {
      body = await options.ingestBatch(documents);
    } catch {
      fail("replay_transport_failed", "The synthetic verification replay could not be confirmed, so no field proof was issued.", errorState);
    }
    validateBatchReceipt(body, documents, "unchanged", errorState);
    progress = assertDisposableRecoverySeedResumeState({
      ...progress,
      verified_replay_batch_prefix: batchNumber,
      verified_replay_document_prefix: offset + documents.length,
    });
    await checkpointThrough(checkpoint, {
      ...progress,
      pending_seed_action: progress.verified_replay_document_prefix === FIXTURE.length
        ? "settle_projection"
        : "verification_replay_batch",
      ambiguous_write_boundary: null,
    }, errorState);
  }

  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "settle_projection",
    ambiguous_write_boundary: null,
  }, seededState);
  try {
    await options.settleProjection();
  } catch {
    fail(
      "projection_settle_failed",
      "The synthetic vector projection did not settle. Reconcile the disposable source before retrying.",
      seededState,
    );
  }

  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "verify_settled_inventory",
    ambiguous_write_boundary: null,
  }, seededState);
  const verifiedInventory = await inventoryThrough(options.readInventory, seededState);
  const row = validateRuntimeInventory(verifiedInventory, { final: true, errorState: seededState });
  validateProjectionReadyInventory(verifiedInventory, row, seededState);
  let independentProjection;
  let evaluation;
  try {
    await checkpointThrough(checkpoint, {
      ...progress,
      pending_seed_action: "verify_independent_projection",
      ambiguous_write_boundary: null,
    }, seededState);
    independentProjection = validateIndependentProjection(
      await options.readIndependentProjection(),
      row,
      seededState,
    );
    await checkpointThrough(checkpoint, {
      ...progress,
      pending_seed_action: "verify_retrieval",
      ambiguous_write_boundary: null,
    }, seededState);
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
    await checkpointThrough(checkpoint, {
      ...progress,
      pending_seed_action: "capture_direct_d1_fingerprint",
      ambiguous_write_boundary: null,
    }, seededState);
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
  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "verify_closing_inventory",
    ambiguous_write_boundary: null,
  }, seededState);
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
    schema_version: 4,
    protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
    status: "passed",
    completed_at: completionTime(options.now || Date.now, seededState),
    data_class: DATA_CLASS,
    binding,
    source_deployment: sourceDeployment,
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
      // A resumed invocation observes the verified prefix rather than the
      // original zero. The durable resume chain can advance only after the
      // first invocation proved all five opening counts were zero.
      documents: 0,
      chunks: 0,
      fts: 0,
      pending_outbox: 0,
      failed_vectors: 0,
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
  await checkpointThrough(checkpoint, {
    ...progress,
    pending_seed_action: "finalize_seed_receipt",
    ambiguous_write_boundary: null,
  }, seededState);
  return deepFreeze(receipt);
}

/** Strictly validate one persisted private schema-4 seed receipt. */
export function assertDisposableRecoverySeedReceipt(receipt) {
  let completedAtValid = false;
  try {
    completedAtValid = new Date(receipt?.completed_at).toISOString() === receipt?.completed_at;
  } catch { /* fixed refusal below */ }
  if (!exactKeys(receipt, [
    "schema_version", "protocol", "status", "completed_at", "data_class",
    "binding", "source_deployment", "fixture", "ingest", "verification_replay", "opening_d1", "d1",
    "projection", "evaluation", "proof_boundary",
  ]) || receipt.schema_version !== 4 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_SEED_PROTOCOL ||
      receipt.status !== "passed" || receipt.data_class !== DATA_CLASS ||
      !completedAtValid) {
    fail("seed_receipt_invalid", "The private synthetic seed receipt is invalid.");
  }
  assertDisposableRecoverySeedBinding(receipt.binding);
  validateSourceDeploymentProof(receipt.source_deployment, receipt.binding);
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
