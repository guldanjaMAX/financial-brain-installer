/**
 * Pure, single-target review contract for retrospective upload provenance.
 *
 * Every function in this module is side-effect free. It can bind a review and
 * validate bodies produced by the authenticated Worker, but it cannot execute
 * a request or authorize a mutation. Exact locators, roots, retrieval queries,
 * content measurements, and sealed identities are private orchestration
 * material. Only `publicProvenanceTargetRepairPlan` is suitable for terminal or
 * JSON output.
 */

import { createHash } from "node:crypto";

export const PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION = 1;

export const PROVENANCE_TARGET_REPAIR_OPERATIONS = Object.freeze([
  "record_single_target_discovery_gap",
  "record_exact_result_family",
  "record_single_target_accepted_resolution",
  "verify_single_target_accepted_resolution",
]);

export const PROVENANCE_TARGET_REPAIR_OPTIONAL_OPERATIONS = Object.freeze([
  "verify_exact_result_family",
]);

export const PROVENANCE_TARGET_REPAIR_EFFECTS = Object.freeze([
  "when no unresolved observation exists, record one deterministic discovery gap before any separately authorized data-path repair",
  "refuse this first gate if proof would require draining or otherwise processing any global vector backlog",
  "record the exact current result family after raw-original binding and retrieval proof",
  "record and verify one accepted provenance resolution only after exact binding, retrieval, and citation proof",
]);

export const PROVENANCE_TARGET_REPAIR_OPTIONAL_EFFECTS = Object.freeze([
  "verify the exact result-family receipt as an additional readback assertion",
]);

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SHA_ID_RE = /^sha256:[a-f0-9]{64}$/;
const ORIGINAL_ID_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const PROBE_ID_RE = /^probe-v1:[a-f0-9]{64}$/;
const RUN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:\//;
const MAX_LOCATOR_BYTES = 2_048;
const MAX_QUERY_BYTES = 4_096;
const MAX_ROOT_BYTES = 8_192;
const encoder = new TextEncoder();

const WORKER_BOUNDED_SCOPE = Object.freeze({
  kind: "bounded_target_set",
  maximum_targets: 10,
  whole_source_complete: false,
  accepted_outcomes_supported: false,
  repair_verification_supported: false,
  raw_original_result_family_receipt: "available_non_authorizing",
  meaning: "Evidence applies only to the explicitly sealed originals; it is not a whole-source enumeration.",
});

const WORKER_ACCEPTED_RESOLUTION_SCOPE = Object.freeze({
  ...WORKER_BOUNDED_SCOPE,
  kind: "single_target_accepted_resolution",
  maximum_targets: 1,
  accepted_outcomes_supported: true,
  accepted_resolution_mode: "one_exact_current_result_family",
  repair_verification_supported: true,
});

const PRIOR_REASON_CODES = Object.freeze({
  gap: new Set([
    "provenance_unassessed",
    "current_document_missing",
    "ocr_partial_review",
    "scan_only_ocr_needed",
    "password_protected",
    "unsupported_format",
    "extraction_failed",
    "original_unavailable",
  ]),
  failed: new Set(["extraction_failed", "original_unavailable", "index_write_failed"]),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function hashId(value) {
  return `sha256:${hash(value)}`;
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length &&
    keys.every((key) => fields.includes(key)) && fields.every((key) => keys.includes(key));
}

function exactScope(value, expected) {
  return exactObject(value, Object.keys(expected)) && canonical(value) === canonical(expected);
}

function boundedText(value, label, maxBytes, { trimmed = false } = {}) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") ||
      CONTROL_RE.test(value) || encoder.encode(value).length > maxBytes ||
      (trimmed && value !== value.trim())) {
    throw new TypeError(`${label} must be one bounded canonical string`);
  }
  return value;
}

function fingerprint(value, label) {
  if (!SHA_RE.test(String(value || ""))) {
    throw new TypeError(`${label} must be one SHA-256 fingerprint`);
  }
  return value;
}

function hashIdentifier(value, label) {
  if (!SHA_ID_RE.test(String(value || ""))) {
    throw new TypeError(`${label} must be one SHA-256 identifier`);
  }
  return value;
}

/** Validate one canonical POSIX source-relative locator without resolving it. */
export function canonicalProvenanceTargetLocator(value) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") ||
      encoder.encode(value).length > MAX_LOCATOR_BYTES || CONTROL_RE.test(value) ||
      value.includes("\\") || value.startsWith("/") || WINDOWS_ABSOLUTE_RE.test(value) ||
      value.endsWith("/") || value.includes("//")) {
    throw new TypeError("target must be one canonical POSIX source-relative locator");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError("target must not contain empty, dot, or parent segments");
  }
  return value;
}

function normalizedRootIdentity(value) {
  const fields = ["path", "realpath", "device", "inode"];
  if (!exactObject(value, fields)) {
    throw new TypeError("target repair needs one exact source-root identity");
  }
  const path = boundedText(value.path, "declared source root", MAX_ROOT_BYTES);
  const realpath = boundedText(value.realpath, "resolved source root", MAX_ROOT_BYTES);
  const absolute = (candidate) => candidate.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\");
  if (!absolute(path) || !absolute(realpath) ||
      !Number.isSafeInteger(value.device) || value.device < 0 ||
      !Number.isSafeInteger(value.inode) || value.inode < 0) {
    throw new TypeError("target repair source-root identity is invalid");
  }
  return Object.freeze({ path, realpath, device: value.device, inode: value.inode });
}

function normalizedSource(value) {
  const fields = ["id", "kind", "registered"];
  if (!exactObject(value, fields) || !SOURCE_RE.test(String(value.id || "")) ||
      value.kind !== "upload" || value.registered !== true) {
    throw new TypeError("target repair requires exactly one registered upload source");
  }
  return Object.freeze({ id: value.id, kind: "upload", registered: true });
}

function normalizedOriginal(value) {
  const fields = [
    "original_content_sha256", "original_byte_count", "text_state", "text_reliable",
    "extraction_complete", "page_count", "page_count_state", "multi_record",
  ];
  if (!exactObject(value, fields) || !SHA_RE.test(String(value.original_content_sha256 || "")) ||
      !Number.isSafeInteger(value.original_byte_count) || value.original_byte_count < 0 ||
      value.text_state !== "native_readable" ||
      value.text_reliable !== true || value.extraction_complete !== true ||
      value.multi_record !== false ||
      !["authoritative", "not_applicable"].includes(value.page_count_state) ||
      (value.page_count_state === "authoritative" &&
        (!Number.isSafeInteger(value.page_count) || value.page_count < 1 || value.page_count > 10_000)) ||
      (value.page_count_state === "not_applicable" && value.page_count !== null)) {
    throw new TypeError("target repair needs one complete, reliable, single-record original receipt");
  }
  return Object.freeze({
    original_content_sha256: value.original_content_sha256,
    original_byte_count: value.original_byte_count,
    text_state: value.text_state,
    text_reliable: true,
    extraction_complete: true,
    page_count: value.page_count,
    page_count_state: value.page_count_state,
    multi_record: false,
  });
}

function normalizedPriorGap(value, original) {
  const fields = [
    "sequence", "outcome", "reason_code", "observation_hash", "original_id",
    "original_content_sha256",
  ];
  if (!exactObject(value, fields) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Object.hasOwn(PRIOR_REASON_CODES, value.outcome) ||
      !PRIOR_REASON_CODES[value.outcome].has(value.reason_code) ||
      !SHA_ID_RE.test(String(value.observation_hash || "")) ||
      !ORIGINAL_ID_RE.test(String(value.original_id || "")) ||
      value.original_content_sha256 !== original.original_content_sha256) {
    throw new TypeError("target repair needs one exact unresolved prior gap for the same original bytes");
  }
  return Object.freeze({
    sequence: value.sequence,
    outcome: value.outcome,
    reason_code: value.reason_code,
    observation_hash: value.observation_hash,
    original_id: value.original_id,
    original_content_sha256: value.original_content_sha256,
  });
}

function normalizedHistory(value, discoveryRequired, priorGap) {
  const fields = ["checked", "conflict", "accepted_resolution_exists", "unresolved_gap_count"];
  const expectedGapCount = discoveryRequired ? 0 : 1;
  if (!exactObject(value, fields) || value.checked !== true || value.conflict !== false ||
      value.accepted_resolution_exists !== false ||
      value.unresolved_gap_count !== expectedGapCount ||
      (discoveryRequired ? priorGap !== null : priorGap === null)) {
    throw new TypeError(
      "target repair requires checked, conflict-free history with no accepted resolution",
    );
  }
  return Object.freeze({
    checked: true,
    conflict: false,
    accepted_resolution_exists: false,
    unresolved_gap_count: expectedGapCount,
  });
}

function normalizedInput(value) {
  const fields = [
    "productVersion", "candidateRuntimePackageFingerprint", "manifestFingerprint",
    "sourceConfigFingerprint", "rootIdentity", "source", "sourceSnapshotId", "locator",
    "original", "priorGap", "discoveryRequired", "history", "retrievalQuery", "ocr",
  ];
  if (!exactObject(value, fields)) {
    throw new TypeError("target repair input does not match the exact private planning contract");
  }
  const productVersion = boundedText(value.productVersion, "product version", 128, { trimmed: true });
  const original = normalizedOriginal(value.original);
  if (typeof value.discoveryRequired !== "boolean") {
    throw new TypeError("target repair must state whether discovery recording is required");
  }
  const priorGap = value.discoveryRequired
    ? value.priorGap === null ? null : (() => {
        throw new TypeError("discovery-required target repair cannot also bind an existing gap");
      })()
    : normalizedPriorGap(value.priorGap, original);
  const history = normalizedHistory(value.history, value.discoveryRequired, priorGap);
  if (!exactObject(value.ocr, ["enabled", "attempted"]) ||
      value.ocr.enabled !== false || value.ocr.attempted !== false) {
    throw new TypeError("target repair requires OCR to remain disabled and unattempted");
  }
  return Object.freeze({
    productVersion,
    candidateRuntimePackageFingerprint: fingerprint(
      value.candidateRuntimePackageFingerprint,
      "candidate runtime package fingerprint",
    ),
    manifestFingerprint: fingerprint(value.manifestFingerprint, "manifest fingerprint"),
    sourceConfigFingerprint: fingerprint(value.sourceConfigFingerprint, "source configuration fingerprint"),
    rootIdentity: normalizedRootIdentity(value.rootIdentity),
    source: normalizedSource(value.source),
    sourceSnapshotId: hashIdentifier(value.sourceSnapshotId, "source snapshot"),
    locator: canonicalProvenanceTargetLocator(value.locator),
    original,
    priorGap,
    discoveryRequired: value.discoveryRequired,
    history,
    retrievalQuery: boundedText(value.retrievalQuery, "retrieval query", MAX_QUERY_BYTES, { trimmed: true }),
    ocr: Object.freeze({ enabled: false, attempted: false }),
  });
}

function intendedOperations(input) {
  return Object.freeze(PROVENANCE_TARGET_REPAIR_OPERATIONS.filter((operation) =>
    operation !== "record_single_target_discovery_gap" || input.discoveryRequired));
}

function intendedEffects(input) {
  return Object.freeze(PROVENANCE_TARGET_REPAIR_EFFECTS.filter((effect, index) =>
    index !== 0 || input.discoveryRequired));
}

function planningBinding(input) {
  const retrievalQueryDigest = hash({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    operation: "provenance-target-repair-query",
    query: input.retrievalQuery,
  });
  return Object.freeze({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    operation: "provenance-target-repair",
    product_version: input.productVersion,
    candidate_runtime_package_fingerprint: input.candidateRuntimePackageFingerprint,
    manifest_fingerprint: input.manifestFingerprint,
    source_config_fingerprint: input.sourceConfigFingerprint,
    root_identity: input.rootIdentity,
    source: input.source,
    source_snapshot_id: input.sourceSnapshotId,
    target: Object.freeze({
      ordinal: 1,
      locator_kind: "source_relative_path",
      locator: input.locator,
      ...input.original,
    }),
    history: input.history,
    discovery: input.discoveryRequired
      ? Object.freeze({
          required: true,
          proposed_target: Object.freeze({
            observation_stage: "discovery",
            outcome: "gap",
            reason_code: "provenance_unassessed",
            text_state: input.original.text_state,
            original_content_sha256: input.original.original_content_sha256,
            original_byte_count: input.original.original_byte_count,
            page_count: input.original.page_count,
            page_count_state: input.original.page_count_state,
            resolves_observation_hash: null,
          }),
        })
      : Object.freeze({ required: false, prior_gap: input.priorGap }),
    retrieval: Object.freeze({
      strategy: "explicit_private_owner_probe",
      query_digest: retrievalQueryDigest,
    }),
    ocr: input.ocr,
    intended_operations: intendedOperations(input),
    intended_effects: intendedEffects(input),
    optional_operations: PROVENANCE_TARGET_REPAIR_OPTIONAL_OPERATIONS,
    optional_effects: PROVENANCE_TARGET_REPAIR_OPTIONAL_EFFECTS,
  });
}

function validatePrivateDraft(value) {
  if (!value || value.contract_version !== PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION ||
      value.operation !== "provenance-target-repair" || value.stage !== "awaiting_seal" ||
      !value.input || !SHA_RE.test(String(value.plan_id || "")) ||
      !value.run_ids ||
      !RUN_RE.test(String(value.run_ids.discovery || "")) ||
      !RUN_RE.test(String(value.run_ids.accepted_resolution || ""))) {
    throw new TypeError("private target-repair draft is invalid");
  }
  const normalized = normalizedInput(value.input);
  const binding = planningBinding(normalized);
  if (hash(binding) !== value.plan_id ||
      canonical(value.run_ids) !== canonical({
        discovery: `ptrd_${value.plan_id}`,
        accepted_resolution: `ptra_${value.plan_id}`,
      })) {
    throw new TypeError("private target-repair draft no longer matches its plan");
  }
  return Object.freeze({ input: normalized, binding, planId: value.plan_id });
}

/**
 * PRIVATE/EPHEMERAL. Build the state-bound draft used for the read-only Worker
 * seal. Never print or persist this return value because it contains paths,
 * the locator, the retrieval query, and raw-byte measurements.
 */
export function preparePrivateProvenanceTargetRepair(input) {
  const normalized = normalizedInput(input);
  const binding = planningBinding(normalized);
  const planId = hash(binding);
  return Object.freeze({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    operation: "provenance-target-repair",
    stage: "awaiting_seal",
    plan_id: planId,
    run_ids: Object.freeze({
      discovery: `ptrd_${planId}`,
      accepted_resolution: `ptra_${planId}`,
    }),
    input: normalized,
  });
}

/** PRIVATE request body for the authenticated, read-only seal operation. */
export function formatPrivateProvenanceTargetSealRequest(draft) {
  const { input, planId } = validatePrivateDraft(draft);
  return Object.freeze({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    mode: "seal",
    source: input.source.id,
    plan_id: planId,
    source_snapshot_id: input.sourceSnapshotId,
    targets: Object.freeze([Object.freeze({
      locator_kind: "source_relative_path",
      locator: input.locator,
    })]),
  });
}

function normalizedSeal(draft, receipt) {
  const { input, planId } = validatePrivateDraft(draft);
  const fields = [
    "contract_version", "mode", "source", "plan_id", "source_snapshot_id",
    "target_set_hash", "target_count", "targets", "scope",
  ];
  if (!exactObject(receipt, fields) ||
      receipt.contract_version !== PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION ||
      receipt.mode !== "seal" || receipt.source !== input.source.id ||
      receipt.plan_id !== planId || receipt.source_snapshot_id !== input.sourceSnapshotId ||
      receipt.target_count !== 1 || !Array.isArray(receipt.targets) || receipt.targets.length !== 1 ||
      !exactObject(receipt.targets[0], ["position", "original_id"]) ||
      receipt.targets[0].position !== 0 ||
      !ORIGINAL_ID_RE.test(String(receipt.targets[0].original_id || "")) ||
      (input.priorGap !== null && receipt.targets[0].original_id !== input.priorGap.original_id) ||
      !SHA_ID_RE.test(String(receipt.target_set_hash || "")) ||
      !exactScope(receipt.scope, WORKER_BOUNDED_SCOPE)) {
    throw new TypeError("Worker seal does not match the exact one-target repair draft");
  }
  const expectedTargetSetHash = hashId({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    source: input.source.id,
    plan_id: planId,
    source_snapshot_id: input.sourceSnapshotId,
    targets: [{
      locator_kind: "source_relative_path",
      original_id: receipt.targets[0].original_id,
    }],
  });
  if (receipt.target_set_hash !== expectedTargetSetHash) {
    throw new TypeError("Worker seal target set does not match the exact private target");
  }
  return Object.freeze({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    mode: "seal",
    source: input.source.id,
    plan_id: planId,
    source_snapshot_id: input.sourceSnapshotId,
    target_set_hash: receipt.target_set_hash,
    target_count: 1,
    targets: Object.freeze([Object.freeze({
      position: 0,
      original_id: receipt.targets[0].original_id,
    })]),
    scope: WORKER_BOUNDED_SCOPE,
  });
}

function publicPlanBase(input) {
  return Object.freeze({
    schema_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    operation: "provenance-target-repair",
    mode: "preview",
    read_only: true,
    status: "design_only_executor_unavailable",
    product_version: input.productVersion,
    source: Object.freeze({ id: input.source.id, kind: "upload", registered: true }),
    target_ordinal: 1,
    target_count: 1,
    ocr: Object.freeze({ enabled: false, attempted: false }),
    input_claims: Object.freeze({
      authority: "unverified_private_planning_input",
      discovery_required: input.discoveryRequired,
      text_state: input.original.text_state,
      text_reliable: true,
      extraction_complete: true,
      page_count_state: input.original.page_count_state,
    }),
    intended_operations: intendedOperations(input),
    effects: intendedEffects(input),
    optional_operations: PROVENANCE_TARGET_REPAIR_OPTIONAL_OPERATIONS,
    optional_effects: PROVENANCE_TARGET_REPAIR_OPTIONAL_EFFECTS,
    boundaries: Object.freeze({
      one_registered_upload_target: true,
      private_target_details_printed: false,
      whole_source_complete: false,
      reingest_represented: false,
      reingest_authorized: false,
      document_mutation_authorized: false,
      changes_other_source_documents: false,
      family_shape_transition_allowed: false,
      future_executor_requires_family_shape_assessment: true,
      global_vector_backlog_processing_allowed: false,
      may_process_preexisting_vector_backlog: false,
      changes_access_or_zones: false,
      changes_passkeys_or_devices: false,
      caller_asserted_history_authoritative: false,
      future_executor_requires_complete_authenticated_inventory_snapshot: true,
      future_executor_rechecks_history_immediately_under_source_lease: true,
    }),
    can_apply: false,
    executor_available: false,
    future_execution_requires_fresh_owner_approval: true,
  });
}

function reviewBinding(draft, seal, ownerVisiblePlan) {
  return Object.freeze({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    operation: "provenance-target-repair-review-binding",
    plan_id: draft.plan_id,
    planning_binding: planningBinding(draft.input),
    sealed_target: seal,
    owner_visible_plan: ownerVisiblePlan,
  });
}

/**
 * PRIVATE/EPHEMERAL. Bind the Worker seal and produce the final review binding.
 * Call `publicProvenanceTargetRepairPlan` before rendering anything.
 */
export function bindPrivateProvenanceTargetRepairSeal(draft, sealReceipt) {
  const validated = validatePrivateDraft(draft);
  const normalizedDraft = preparePrivateProvenanceTargetRepair(validated.input);
  const seal = normalizedSeal(normalizedDraft, sealReceipt);
  const visible = publicPlanBase(validated.input);
  const reviewBindingId = hash(reviewBinding(normalizedDraft, seal, visible));
  return Object.freeze({
    ...normalizedDraft,
    stage: "sealed_design_review",
    seal,
    review_binding_id: reviewBindingId,
    owner_visible_plan: Object.freeze({ ...visible, review_binding_id: reviewBindingId }),
  });
}

function validatePrivatePlan(value) {
  if (!value || value.stage !== "sealed_design_review" || !value.seal ||
      !SHA_RE.test(String(value.review_binding_id || "")) || !value.owner_visible_plan) {
    throw new TypeError("private target-repair plan is not a sealed design review");
  }
  const draft = Object.freeze({
    contract_version: value.contract_version,
    operation: value.operation,
    stage: "awaiting_seal",
    plan_id: value.plan_id,
    run_ids: value.run_ids,
    input: value.input,
  });
  const validated = validatePrivateDraft(draft);
  const seal = normalizedSeal(draft, value.seal);
  const sealedOriginalId = seal.targets[0].original_id;
  if (!ORIGINAL_ID_RE.test(String(sealedOriginalId || "")) ||
      (validated.input.priorGap !== null &&
        sealedOriginalId !== validated.input.priorGap.original_id)) {
    throw new TypeError("private target-repair plan has a mismatched sealed original");
  }
  const expectedSet = hashId({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    source: validated.input.source.id,
    plan_id: validated.planId,
    source_snapshot_id: validated.input.sourceSnapshotId,
    targets: [{ locator_kind: "source_relative_path", original_id: sealedOriginalId }],
  });
  const visible = publicPlanBase(validated.input);
  const expectedReviewBinding = hash(reviewBinding(draft, seal, visible));
  if (seal.target_set_hash !== expectedSet ||
      value.review_binding_id !== expectedReviewBinding ||
      canonical(value.owner_visible_plan) !== canonical({
        ...visible,
        review_binding_id: expectedReviewBinding,
      })) {
    throw new TypeError("private target-repair plan no longer matches its review binding");
  }
  return Object.freeze({
    input: validated.input,
    planId: validated.planId,
    seal,
    reviewBindingId: expectedReviewBinding,
    ownerVisiblePlan: value.owner_visible_plan,
  });
}

/** The only owner-safe serialization surface in this module. */
export function publicProvenanceTargetRepairPlan(privatePlan) {
  return validatePrivatePlan(privatePlan).ownerVisiblePlan;
}

const PUBLIC_OBSERVATION_FIELDS = Object.freeze([
  "sequence", "source", "original_id", "locator_kind", "run_id", "plan_id",
  "source_snapshot_id", "target_set_hash", "target_count", "observation_stage",
  "outcome", "reason_code", "text_state", "original_content_sha256",
  "original_byte_count", "page_count", "page_count_state", "result_document_count",
  "result_document_set_hash", "resolves_observation_hash", "observation_hash", "recorded_at",
]);

function validatedDiscoveryObservation(privatePlan, value) {
  const validated = validatePrivatePlan(privatePlan);
  const input = validated.input;
  if (input.discoveryRequired !== true || input.priorGap !== null) {
    throw new TypeError("this review does not bind a new discovery observation");
  }
  const envelopeFields = [
    "contract_version", "mode", "source", "run_id", "target_set_hash",
    "target_count", "observations", "bounded_target_set_recorded",
    "repair_receipts_recorded", "scope",
  ];
  if (!exactObject(value, envelopeFields) ||
      value.contract_version !== PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION ||
      value.mode !== "record" || value.source !== input.source.id ||
      value.run_id !== privatePlan.run_ids.discovery ||
      value.target_set_hash !== validated.seal.target_set_hash || value.target_count !== 1 ||
      value.bounded_target_set_recorded !== true || value.repair_receipts_recorded !== false ||
      !Array.isArray(value.observations) || value.observations.length !== 1 ||
      !exactScope(value.scope, WORKER_BOUNDED_SCOPE)) {
    throw new TypeError(
      "discovery receipt must be the complete authenticated Worker record envelope",
    );
  }
  const observation = value.observations[0];
  if (!exactObject(observation, PUBLIC_OBSERVATION_FIELDS) ||
      !Number.isSafeInteger(observation.sequence) || observation.sequence < 1 ||
      observation.source !== input.source.id ||
      observation.original_id !== validated.seal.targets[0].original_id ||
      observation.locator_kind !== "source_relative_path" ||
      observation.run_id !== privatePlan.run_ids.discovery ||
      observation.plan_id !== validated.planId ||
      observation.source_snapshot_id !== input.sourceSnapshotId ||
      observation.target_set_hash !== validated.seal.target_set_hash ||
      observation.target_count !== 1 || observation.observation_stage !== "discovery" ||
      observation.outcome !== "gap" || observation.reason_code !== "provenance_unassessed" ||
      observation.text_state !== input.original.text_state ||
      observation.original_content_sha256 !== input.original.original_content_sha256 ||
      observation.original_byte_count !== input.original.original_byte_count ||
      observation.page_count !== input.original.page_count ||
      observation.page_count_state !== input.original.page_count_state ||
      !Number.isSafeInteger(observation.result_document_count) ||
      observation.result_document_count < 0 ||
      !SHA_ID_RE.test(String(observation.result_document_set_hash || "")) ||
      observation.resolves_observation_hash !== null ||
      !SHA_ID_RE.test(String(observation.observation_hash || "")) ||
      !Number.isSafeInteger(observation.recorded_at) || observation.recorded_at < 0) {
    throw new TypeError("discovery observation does not match the sealed private review binding");
  }
  const expectedObservationHash = hashId({
    contract_version: PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION,
    tenant_id: "primary",
    source: observation.source,
    original_id: observation.original_id,
    locator_kind: observation.locator_kind,
    run_id: observation.run_id,
    plan_id: observation.plan_id,
    source_snapshot_id: observation.source_snapshot_id,
    target_set_hash: observation.target_set_hash,
    target_count: observation.target_count,
    observation_stage: observation.observation_stage,
    outcome: observation.outcome,
    reason_code: observation.reason_code,
    text_state: observation.text_state,
    original_content_sha256: observation.original_content_sha256,
    original_byte_count: observation.original_byte_count,
    page_count: observation.page_count,
    page_count_state: observation.page_count_state,
    result_document_count: observation.result_document_count,
    result_document_set_hash: observation.result_document_set_hash,
    resolves_observation_hash: null,
  });
  if (observation.observation_hash !== expectedObservationHash) {
    throw new TypeError("discovery observation integrity hash is invalid");
  }
  return Object.freeze(Object.fromEntries(
    PUBLIC_OBSERVATION_FIELDS.map((field) => [field, observation[field]]),
  ));
}

/** Select the observation only from a complete authenticated Worker record envelope. */
export function selectPrivateProvenanceTargetDiscoveryReceipt(privatePlan, response) {
  return validatedDiscoveryObservation(privatePlan, response);
}

function resolvingObservationHash(privatePlan, validated, discoveryReceipt) {
  if (validated.input.discoveryRequired) {
    return validatedDiscoveryObservation(privatePlan, discoveryReceipt).observation_hash;
  }
  if (discoveryReceipt !== undefined && discoveryReceipt !== null) {
    throw new TypeError("an existing-gap repair cannot substitute a new discovery receipt");
  }
  return validated.input.priorGap.observation_hash;
}

const RESULT_FAMILY_RESPONSE_FIELDS = Object.freeze([
  "contract_version", "mode", "operation", "source", "original_id",
  "family_receipt_hash", "verification_hash", "document_count", "chunk_count",
  "vector_readiness_hash", "retrieval_probe_id", "retrieval_status", "citation_status",
  "recorded", "replayed", "accepted_outcome_authorized",
]);

function normalizedResultFamilyResponse(privatePlan, response, operation) {
  const validated = validatePrivatePlan(privatePlan);
  const recordState = response?.recorded === true && response?.replayed === false;
  const replayState = response?.recorded === false && response?.replayed === true;
  if (!["record", "verify"].includes(operation) ||
      !exactObject(response, RESULT_FAMILY_RESPONSE_FIELDS) ||
      response.contract_version !== PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION ||
      response.mode !== "result_family" || response.operation !== operation ||
      response.source !== validated.input.source.id ||
      response.original_id !== validated.seal.targets[0].original_id ||
      !SHA_ID_RE.test(String(response.family_receipt_hash || "")) ||
      !SHA_ID_RE.test(String(response.verification_hash || "")) ||
      !Number.isSafeInteger(response.document_count) || response.document_count < 1 ||
      response.document_count > 256 ||
      !Number.isSafeInteger(response.chunk_count) ||
      response.chunk_count < response.document_count || response.chunk_count > 500 ||
      !SHA_ID_RE.test(String(response.vector_readiness_hash || "")) ||
      !PROBE_ID_RE.test(String(response.retrieval_probe_id || "")) ||
      response.retrieval_status !== "deterministic" ||
      response.citation_status !== "same_family" ||
      response.accepted_outcome_authorized !== false ||
      (operation === "record" && !recordState && !replayState) ||
      (operation === "verify" && !replayState)) {
    throw new TypeError("result-family response does not match the exact sealed target and Worker schema");
  }
  return Object.freeze({ ...response });
}

function sameResultFamily(left, right) {
  return left.source === right.source && left.original_id === right.original_id &&
    left.family_receipt_hash === right.family_receipt_hash &&
    left.verification_hash === right.verification_hash &&
    left.document_count === right.document_count && left.chunk_count === right.chunk_count &&
    left.vector_readiness_hash === right.vector_readiness_hash &&
    left.retrieval_probe_id === right.retrieval_probe_id;
}

/**
 * Validate a complete schema-44 Worker body. A record response is already an
 * exact hash-checked readback; passing it to a later verify validation is an
 * optional additional equality assertion, not a prerequisite to admission.
 */
export function validatePrivateProvenanceResultFamilyResponse(
  privatePlan,
  response,
  { operation, recordReceipt } = {},
) {
  const normalized = normalizedResultFamilyResponse(privatePlan, response, operation);
  if (recordReceipt !== undefined) {
    if (operation !== "verify") {
      throw new TypeError("only result-family verify may compare a prior record receipt");
    }
    const recorded = normalizedResultFamilyResponse(privatePlan, recordReceipt, "record");
    if (!sameResultFamily(normalized, recorded)) {
      throw new TypeError("result-family verify response changed from the exact record readback");
    }
  }
  return normalized;
}

const ACCEPTED_RESOLUTION_RESPONSE_FIELDS = Object.freeze([
  "contract_version", "mode", "operation", "source", "run_id", "original_id",
  "target_set_hash", "target_count", "accepted_observation_hash", "resolution_hash",
  "activation_hash", "family_receipt_hash", "verification_hash", "document_count",
  "chunk_count", "vector_readiness_hash", "retrieval_probe_id", "retrieval_status",
  "citation_status", "status", "recorded", "replayed", "reactivated",
  "accepted_outcome_authorized", "bounded_target_set_repair_verified", "scope",
]);

function normalizedAcceptedResolutionResponse(
  privatePlan,
  response,
  { operation, discoveryReceipt, resultFamilyReceipt },
) {
  const validated = validatePrivatePlan(privatePlan);
  resolvingObservationHash(privatePlan, validated, discoveryReceipt);
  const family = normalizedResultFamilyResponse(privatePlan, resultFamilyReceipt, "record");
  const recordState = response?.recorded === true && response?.replayed === false;
  const replayState = response?.recorded === false && response?.replayed === true;
  if (!["record", "verify"].includes(operation) ||
      !exactObject(response, ACCEPTED_RESOLUTION_RESPONSE_FIELDS) ||
      response.contract_version !== PROVENANCE_TARGET_REPAIR_CONTRACT_VERSION ||
      response.mode !== "accepted_resolution" || response.operation !== operation ||
      response.source !== validated.input.source.id ||
      response.run_id !== privatePlan.run_ids.accepted_resolution ||
      response.original_id !== validated.seal.targets[0].original_id ||
      response.target_set_hash !== validated.seal.target_set_hash ||
      response.target_count !== 1 ||
      !SHA_ID_RE.test(String(response.accepted_observation_hash || "")) ||
      !SHA_ID_RE.test(String(response.resolution_hash || "")) ||
      !SHA_ID_RE.test(String(response.activation_hash || "")) ||
      response.family_receipt_hash !== family.family_receipt_hash ||
      !SHA_ID_RE.test(String(response.verification_hash || "")) ||
      response.document_count !== family.document_count ||
      response.chunk_count !== family.chunk_count ||
      !SHA_ID_RE.test(String(response.vector_readiness_hash || "")) ||
      !PROBE_ID_RE.test(String(response.retrieval_probe_id || "")) ||
      response.retrieval_status !== "deterministic" ||
      response.citation_status !== "same_family" ||
      response.status !== "accepted_resolution_current" ||
      typeof response.reactivated !== "boolean" ||
      response.accepted_outcome_authorized !== true ||
      response.bounded_target_set_repair_verified !== true ||
      !exactScope(response.scope, WORKER_ACCEPTED_RESOLUTION_SCOPE) ||
      (operation === "record" && !recordState && !replayState) ||
      (operation === "verify" && (!replayState || response.reactivated !== false))) {
    throw new TypeError(
      "accepted-resolution response is not the exact current one-target Worker receipt",
    );
  }
  return Object.freeze({
    ...response,
    scope: WORKER_ACCEPTED_RESOLUTION_SCOPE,
  });
}

function sameAcceptedResolutionCurrentIdentity(left, right) {
  return left.source === right.source && left.run_id === right.run_id &&
    left.original_id === right.original_id && left.target_set_hash === right.target_set_hash &&
    left.accepted_observation_hash === right.accepted_observation_hash &&
    left.resolution_hash === right.resolution_hash && left.activation_hash === right.activation_hash &&
    left.family_receipt_hash === right.family_receipt_hash &&
    left.verification_hash === right.verification_hash &&
    left.vector_readiness_hash === right.vector_readiness_hash &&
    left.retrieval_probe_id === right.retrieval_probe_id;
}

/** Validate a complete schema-45 Worker record or current-state verify body. */
export function validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  response,
  { operation, discoveryReceipt, resultFamilyReceipt, recordReceipt } = {},
) {
  if (!resultFamilyReceipt) {
    throw new TypeError("accepted-resolution validation requires the exact result-family record readback");
  }
  const normalized = normalizedAcceptedResolutionResponse(privatePlan, response, {
    operation,
    discoveryReceipt,
    resultFamilyReceipt,
  });
  if (recordReceipt !== undefined) {
    if (operation !== "verify") {
      throw new TypeError("only accepted-resolution verify may compare a current record receipt");
    }
    const recorded = normalizedAcceptedResolutionResponse(privatePlan, recordReceipt, {
      operation: "record",
      discoveryReceipt,
      resultFamilyReceipt,
    });
    if (!sameAcceptedResolutionCurrentIdentity(normalized, recorded)) {
      throw new TypeError(
        "accepted-resolution verify response changed from the current record identity",
      );
    }
  }
  return normalized;
}

/** Render a canonical validated private plan without exposing its private fields. */
export function renderProvenanceTargetRepairPlan(privatePlan) {
  const publicPlan = publicProvenanceTargetRepairPlan(privatePlan);
  const lines = [
    "",
    "  One-file provenance repair design review",
    "",
    "  This preview is read-only. Nothing has changed.",
    `  Source: ${publicPlan.source.id} (registered upload)`,
    "  Target: one exact private original (its locator is not printed)",
    `  Unverified input claim: ${publicPlan.input_claims.text_state}; history is not owner-attested evidence.`,
    "  OCR: off; this repair cannot start OCR or create OCR charges.",
    "",
    "  Reingest and family-shape assessment are not represented; no document mutation is authorized.",
    "  This design refuses any global vector-backlog effect and does not claim whole-source completeness.",
    "",
    "  Execution is unavailable until a separately reviewed executor assesses family shape, consumes a complete authenticated inventory snapshot, rechecks history immediately under the source lease, and obtains fresh owner approval.",
    `  Review binding: ${publicPlan.review_binding_id} (carries no execution authority)`,
  ];
  return `${lines.join("\n")}\n`;
}
