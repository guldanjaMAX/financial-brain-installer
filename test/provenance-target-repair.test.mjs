import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  PROVENANCE_TARGET_REPAIR_EFFECTS,
  PROVENANCE_TARGET_REPAIR_OPTIONAL_EFFECTS,
  PROVENANCE_TARGET_REPAIR_OPTIONAL_OPERATIONS,
  PROVENANCE_TARGET_REPAIR_OPERATIONS,
  bindPrivateProvenanceTargetRepairSeal,
  canonicalProvenanceTargetLocator,
  formatPrivateProvenanceTargetSealRequest,
  preparePrivateProvenanceTargetRepair,
  publicProvenanceTargetRepairPlan,
  renderProvenanceTargetRepairPlan,
  selectPrivateProvenanceTargetDiscoveryReceipt,
  validatePrivateProvenanceAcceptedResolutionResponse,
  validatePrivateProvenanceResultFamilyResponse,
} from "../operations/provenance-target-repair.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const hashId = (value) => `sha256:${hash(value)}`;
const digest = (character) => character.repeat(64);
const id = (character) => `sha256:${digest(character)}`;
const originalId = (character) => `hmac-sha256:${digest(character)}`;

const existingInput = Object.freeze({
  productVersion: "0.4.7",
  candidateRuntimePackageFingerprint: digest("0"),
  manifestFingerprint: digest("1"),
  sourceConfigFingerprint: digest("2"),
  rootIdentity: Object.freeze({
    path: "/synthetic/private/source",
    realpath: "/synthetic/private/source",
    device: 41,
    inode: 73,
  }),
  source: Object.freeze({ id: "client_docs", kind: "upload", registered: true }),
  sourceSnapshotId: id("3"),
  locator: "tax/2025/return.pdf",
  original: Object.freeze({
    original_content_sha256: digest("4"),
    original_byte_count: 9876,
    text_state: "native_readable",
    text_reliable: true,
    extraction_complete: true,
    page_count: 12,
    page_count_state: "authoritative",
    multi_record: false,
  }),
  priorGap: Object.freeze({
    sequence: 17,
    outcome: "gap",
    reason_code: "provenance_unassessed",
    observation_hash: id("5"),
    original_id: originalId("6"),
    original_content_sha256: digest("4"),
  }),
  discoveryRequired: false,
  history: Object.freeze({
    checked: true,
    conflict: false,
    accepted_resolution_exists: false,
    unresolved_gap_count: 1,
  }),
  retrievalQuery: "synthetic exact-family retrieval probe",
  ocr: Object.freeze({ enabled: false, attempted: false }),
});

const clone = (value) => structuredClone(value);

function sealFor(draft, sealedOriginalId) {
  const targetSetHash = hashId({
    contract_version: 1,
    source: draft.input.source.id,
    plan_id: draft.plan_id,
    source_snapshot_id: draft.input.sourceSnapshotId,
    targets: [{ locator_kind: "source_relative_path", original_id: sealedOriginalId }],
  });
  return {
    contract_version: 1,
    mode: "seal",
    source: draft.input.source.id,
    plan_id: draft.plan_id,
    source_snapshot_id: draft.input.sourceSnapshotId,
    target_set_hash: targetSetHash,
    target_count: 1,
    targets: [{ position: 0, original_id: sealedOriginalId }],
    scope: {
      kind: "bounded_target_set",
      maximum_targets: 10,
      whole_source_complete: false,
      accepted_outcomes_supported: false,
      repair_verification_supported: false,
      raw_original_result_family_receipt: "available_non_authorizing",
      meaning: "Evidence applies only to the explicitly sealed originals; it is not a whole-source enumeration.",
    },
  };
}

function resultFamilyResponseFor(plan, operation = "record", patch = {}) {
  return {
    contract_version: 1,
    mode: "result_family",
    operation,
    source: plan.input.source.id,
    original_id: plan.seal.targets[0].original_id,
    family_receipt_hash: id("b"),
    verification_hash: id("c"),
    document_count: 1,
    chunk_count: 2,
    vector_readiness_hash: id("d"),
    retrieval_probe_id: `probe-v1:${digest("e")}`,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    recorded: operation === "record",
    replayed: operation === "verify",
    accepted_outcome_authorized: false,
    ...patch,
  };
}

function acceptedResolutionResponseFor(plan, family, operation = "record", patch = {}) {
  return {
    contract_version: 1,
    mode: "accepted_resolution",
    operation,
    source: plan.input.source.id,
    run_id: plan.run_ids.accepted_resolution,
    original_id: plan.seal.targets[0].original_id,
    target_set_hash: plan.seal.target_set_hash,
    target_count: 1,
    resolves_observation_hash: plan.input.priorGap?.observation_hash ?? null,
    accepted_observation_hash: id("7"),
    resolution_hash: id("8"),
    activation_hash: id("9"),
    family_receipt_hash: family.family_receipt_hash,
    verification_hash: family.verification_hash,
    document_count: family.document_count,
    chunk_count: family.chunk_count,
    vector_readiness_hash: family.vector_readiness_hash,
    retrieval_probe_id: family.retrieval_probe_id,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    status: "accepted_resolution_current",
    recorded: operation === "record",
    replayed: operation === "verify",
    reactivated: false,
    accepted_outcome_authorized: true,
    bounded_target_set_repair_verified: true,
    scope: {
      kind: "single_target_accepted_resolution",
      maximum_targets: 1,
      whole_source_complete: false,
      accepted_outcomes_supported: true,
      repair_verification_supported: true,
      raw_original_result_family_receipt: "available_non_authorizing",
      meaning: "Evidence applies only to the explicitly sealed originals; it is not a whole-source enumeration.",
      accepted_resolution_mode: "one_exact_current_result_family",
    },
    ...patch,
  };
}

/* POSIX locators are exact, NFC, and source-relative. */
assert.equal(canonicalProvenanceTargetLocator("nested/é/report.pdf"), "nested/é/report.pdf");
for (const invalid of [
  "", "/absolute.pdf", "C:/absolute.pdf", "trailing/", "double//name.pdf",
  "dot/./name.pdf", "parent/../name.pdf", "windows\\name.pdf", "line\nbreak.pdf",
  "nested/e\u0301.pdf", `${"é".repeat(1025)}.pdf`,
]) {
  assert.throws(() => canonicalProvenanceTargetLocator(invalid), /target/);
}

/* Existing-gap plans are deterministic and every private binding stays private. */
const draft = preparePrivateProvenanceTargetRepair(existingInput);
const duplicateDraft = preparePrivateProvenanceTargetRepair(clone(existingInput));
assert.equal(draft.plan_id, duplicateDraft.plan_id);
assert.equal(draft.run_ids.discovery, `ptrd_${draft.plan_id}`);
assert.equal(draft.run_ids.accepted_resolution, `ptra_${draft.plan_id}`);
assert.notEqual(draft.run_ids.discovery, draft.run_ids.accepted_resolution);
assert.deepEqual(formatPrivateProvenanceTargetSealRequest(draft), {
  contract_version: 1,
  mode: "seal",
  source: "client_docs",
  plan_id: draft.plan_id,
  source_snapshot_id: id("3"),
  targets: [{ locator_kind: "source_relative_path", locator: "tax/2025/return.pdf" }],
});

const sealed = sealFor(draft, existingInput.priorGap.original_id);
const privatePlan = bindPrivateProvenanceTargetRepairSeal(draft, sealed);
const duplicatePlan = bindPrivateProvenanceTargetRepairSeal(duplicateDraft, sealed);
assert.equal(privatePlan.review_binding_id, duplicatePlan.review_binding_id);
const publicPlan = publicProvenanceTargetRepairPlan(privatePlan);
assert.equal(publicPlan.source.id, "client_docs");
assert.equal(publicPlan.target_count, 1);
assert.equal(publicPlan.ocr.enabled, false);
assert.equal(publicPlan.status, "design_only_executor_unavailable");
assert.equal(publicPlan.input_claims.authority, "unverified_private_planning_input");
assert.equal(publicPlan.input_claims.discovery_required, false);
assert.equal(Object.hasOwn(publicPlan.input_claims, "prior_outcome"), false);
assert.equal(Object.hasOwn(publicPlan.input_claims, "prior_reason_code"), false);
assert.equal(publicPlan.boundaries.whole_source_complete, false);
assert.equal(publicPlan.boundaries.reingest_represented, false);
assert.equal(publicPlan.boundaries.reingest_authorized, false);
assert.equal(publicPlan.boundaries.document_mutation_authorized, false);
assert.equal(publicPlan.boundaries.may_process_preexisting_vector_backlog, false);
assert.equal(publicPlan.boundaries.family_shape_transition_allowed, false);
assert.equal(publicPlan.boundaries.future_executor_requires_family_shape_assessment, true);
assert.equal(publicPlan.boundaries.global_vector_backlog_processing_allowed, false);
assert.equal(publicPlan.boundaries.caller_asserted_history_authoritative, false);
assert.equal(
  publicPlan.boundaries.future_executor_requires_complete_authenticated_inventory_snapshot,
  true,
);
assert.equal(
  publicPlan.boundaries.future_executor_rechecks_history_immediately_under_source_lease,
  true,
);
assert.equal(publicPlan.can_apply, false);
assert.equal(publicPlan.executor_available, false);
assert.equal(publicPlan.future_execution_requires_fresh_owner_approval, true);
assert.equal(publicPlan.review_binding_id, privatePlan.review_binding_id);
assert.equal(publicPlan.intended_operations.includes("record_single_target_discovery_gap"), false);
assert.equal(publicPlan.intended_operations.includes("verify_exact_result_family"), false);
assert.deepEqual(publicPlan.optional_operations, PROVENANCE_TARGET_REPAIR_OPTIONAL_OPERATIONS);
assert.deepEqual(publicPlan.effects, PROVENANCE_TARGET_REPAIR_EFFECTS.slice(1));
assert.deepEqual(publicPlan.optional_effects, PROVENANCE_TARGET_REPAIR_OPTIONAL_EFFECTS);

const publicJson = JSON.stringify(publicPlan);
for (const privateValue of [
  existingInput.rootIdentity.path,
  existingInput.locator,
  existingInput.retrievalQuery,
  existingInput.candidateRuntimePackageFingerprint,
  existingInput.manifestFingerprint,
  existingInput.sourceConfigFingerprint,
  existingInput.sourceSnapshotId,
  existingInput.original.original_content_sha256,
  existingInput.priorGap.original_id,
  existingInput.priorGap.observation_hash,
  sealed.target_set_hash,
  draft.plan_id,
]) {
  assert.equal(publicJson.includes(privateValue), false, `public plan leaked ${privateValue}`);
}
assert.match(publicJson, new RegExp(publicPlan.review_binding_id));
const rendered = renderProvenanceTargetRepairPlan(privatePlan);
assert.match(rendered, /This preview is read-only\. Nothing has changed\./);
assert.match(rendered, /Execution is unavailable until a separately reviewed executor/);
assert.match(rendered, /complete authenticated inventory snapshot/);
assert.match(rendered, /carries no execution authority/);
assert.equal(rendered.includes("--apply"), false);
assert.equal(rendered.includes(existingInput.locator), false);
assert.equal(rendered.includes(existingInput.retrievalQuery), false);

const tamperedPrivatePlan = clone(privatePlan);
tamperedPrivatePlan.owner_visible_plan.input_claims.text_state = "tampered control text";
assert.throws(() => renderProvenanceTargetRepairPlan(tamperedPrivatePlan), /review binding/);

assert.equal(PROVENANCE_TARGET_REPAIR_OPERATIONS.includes("drain_global_vector_outbox"), false);
assert.equal(PROVENANCE_TARGET_REPAIR_OPERATIONS.includes("reingest_exact_original"), false);
assert.equal(PROVENANCE_TARGET_REPAIR_OPERATIONS.includes("verify_exact_result_family"), false);
assert.equal(JSON.stringify(PROVENANCE_TARGET_REPAIR_EFFECTS).includes("stale split siblings"), false);

const familyRecordReceipt = resultFamilyResponseFor(privatePlan);
assert.deepEqual(validatePrivateProvenanceResultFamilyResponse(
  privatePlan,
  familyRecordReceipt,
  { operation: "record" },
), familyRecordReceipt);
const familyVerifyReceipt = resultFamilyResponseFor(privatePlan, "verify");
assert.deepEqual(validatePrivateProvenanceResultFamilyResponse(
  privatePlan,
  familyVerifyReceipt,
  {
    operation: "verify",
    recordReceipt: familyRecordReceipt,
  },
), familyVerifyReceipt);

const acceptedRecordReceipt = acceptedResolutionResponseFor(privatePlan, familyRecordReceipt);
assert.equal(
  acceptedRecordReceipt.resolves_observation_hash,
  existingInput.priorGap.observation_hash,
);
assert.deepEqual(validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  acceptedRecordReceipt,
  {
    operation: "record",
    resultFamilyReceipt: familyRecordReceipt,
  },
), acceptedRecordReceipt);
const acceptedVerifyReceipt = acceptedResolutionResponseFor(
  privatePlan,
  familyRecordReceipt,
  "verify",
);
assert.deepEqual(validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  acceptedVerifyReceipt,
  {
    operation: "verify",
    resultFamilyReceipt: familyRecordReceipt,
    recordReceipt: acceptedRecordReceipt,
  },
), acceptedVerifyReceipt);
const mismatchedCurrentVerify = clone(acceptedVerifyReceipt);
mismatchedCurrentVerify.activation_hash = id("f");
assert.throws(() => validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  mismatchedCurrentVerify,
  {
    operation: "verify",
    resultFamilyReceipt: familyRecordReceipt,
    recordReceipt: acceptedRecordReceipt,
  },
), /current record identity/);
for (const [field, value] of [
  ["vector_readiness_hash", id("f")],
  ["retrieval_probe_id", `probe-v1:${digest("f")}`],
]) {
  const mismatchedProofVerify = clone(acceptedVerifyReceipt);
  mismatchedProofVerify[field] = value;
  assert.throws(() => validatePrivateProvenanceAcceptedResolutionResponse(
    privatePlan,
    mismatchedProofVerify,
    {
      operation: "verify",
      resultFamilyReceipt: familyRecordReceipt,
      recordReceipt: acceptedRecordReceipt,
    },
  ), /current record identity/);
}

const refreshedAcceptedReceipt = acceptedResolutionResponseFor(privatePlan, familyRecordReceipt, "record", {
  verification_hash: id("a"),
  vector_readiness_hash: id("b"),
  retrieval_probe_id: `probe-v1:${digest("c")}`,
  activation_hash: id("d"),
  reactivated: true,
});
assert.doesNotThrow(() => validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  refreshedAcceptedReceipt,
  {
    operation: "record",
    resultFamilyReceipt: familyRecordReceipt,
  },
));

/* Every plan-defining input invalidates an earlier review binding. */
for (const mutate of [
  (input) => { input.productVersion = "0.4.8"; },
  (input) => { input.candidateRuntimePackageFingerprint = digest("f"); },
  (input) => { input.manifestFingerprint = digest("7"); },
  (input) => { input.sourceConfigFingerprint = digest("8"); },
  (input) => { input.rootIdentity.inode += 1; },
  (input) => { input.locator = "tax/2025/amended.pdf"; },
  (input) => { input.original.original_byte_count += 1; },
  (input) => { input.original.page_count += 1; },
  (input) => { input.priorGap.sequence += 1; },
  (input) => { input.retrievalQuery = "different explicit private probe"; },
]) {
  const changed = clone(existingInput);
  mutate(changed);
  assert.notEqual(preparePrivateProvenanceTargetRepair(changed).plan_id, draft.plan_id);
}

/* Unsafe source/history/OCR/extraction states fail before any request exists. */
for (const mutate of [
  (input) => { input.source.registered = false; },
  (input) => { input.source.kind = "drive"; },
  (input) => { input.ocr.enabled = true; },
  (input) => { input.original.text_state = "ocr_reliable"; },
  (input) => { input.original.multi_record = true; },
  (input) => { input.history.conflict = true; },
  (input) => { input.history.accepted_resolution_exists = true; },
]) {
  const invalid = clone(existingInput);
  mutate(invalid);
  assert.throws(() => preparePrivateProvenanceTargetRepair(invalid));
}
const changedSeal = clone(sealed);
changedSeal.target_set_hash = id("9");
assert.throws(() => bindPrivateProvenanceTargetRepairSeal(draft, changedSeal), /target set/);
for (const mutate of [
  (receipt) => { delete receipt.scope; },
  (receipt) => { receipt.scope.whole_source_complete = true; },
  (receipt) => { receipt.scope.extra = "not-worker-schema"; },
  (receipt) => { receipt.extra = true; },
]) {
  const invalidSeal = clone(sealed);
  mutate(invalidSeal);
  assert.throws(() => bindPrivateProvenanceTargetRepairSeal(draft, invalidSeal), /Worker seal/);
}

/* Worker response validators fail closed on identity, hash, state, and scope drift. */
for (const mutate of [
  (receipt) => { receipt.source = "other_source"; },
  (receipt) => { receipt.original_id = originalId("f"); },
  (receipt) => { receipt.family_receipt_hash = "not-a-hash"; },
  (receipt) => { receipt.document_count = 0; },
  (receipt) => { receipt.chunk_count = 501; },
  (receipt) => { receipt.retrieval_probe_id = id("f"); },
  (receipt) => { receipt.recorded = true; receipt.replayed = true; },
  (receipt) => { receipt.accepted_outcome_authorized = true; },
  (receipt) => { receipt.scope = { whole_source_complete: false }; },
]) {
  const invalid = clone(familyRecordReceipt);
  mutate(invalid);
  assert.throws(() => validatePrivateProvenanceResultFamilyResponse(
    privatePlan,
    invalid,
    { operation: "record" },
  ), /result-family response/);
}
for (const mutate of [
  (receipt) => { receipt.source = "other_source"; },
  (receipt) => { receipt.run_id = "other_run"; },
  (receipt) => { receipt.original_id = originalId("f"); },
  (receipt) => { receipt.target_set_hash = id("f"); },
  (receipt) => { delete receipt.resolves_observation_hash; },
  (receipt) => { receipt.resolves_observation_hash = id("f"); },
  (receipt) => { receipt.family_receipt_hash = id("f"); },
  (receipt) => { receipt.verification_hash = "not-a-hash"; },
  (receipt) => { receipt.vector_readiness_hash = "not-a-hash"; },
  (receipt) => { receipt.retrieval_probe_id = id("f"); },
  (receipt) => { receipt.status = "not_current"; },
  (receipt) => { receipt.recorded = true; receipt.replayed = true; },
  (receipt) => { receipt.accepted_outcome_authorized = false; },
  (receipt) => { receipt.scope.whole_source_complete = true; },
  (receipt) => { receipt.scope.extra = true; },
]) {
  const invalid = clone(acceptedRecordReceipt);
  mutate(invalid);
  assert.throws(() => validatePrivateProvenanceAcceptedResolutionResponse(
    privatePlan,
    invalid,
    {
      operation: "record",
      resultFamilyReceipt: familyRecordReceipt,
    },
  ), /accepted-resolution response/);
}

/* Fresh-target reviews validate only a complete authenticated discovery receipt. */
const discoveryInput = clone(existingInput);
discoveryInput.priorGap = null;
discoveryInput.discoveryRequired = true;
discoveryInput.history.unresolved_gap_count = 0;
const discoveryDraft = preparePrivateProvenanceTargetRepair(discoveryInput);
const discoverySeal = sealFor(discoveryDraft, originalId("a"));
const discoveryPlan = bindPrivateProvenanceTargetRepairSeal(discoveryDraft, discoverySeal);
const discoveryPublic = publicProvenanceTargetRepairPlan(discoveryPlan);
assert.equal(discoveryPublic.input_claims.discovery_required, true);
assert.equal(discoveryPublic.intended_operations[0], "record_single_target_discovery_gap");
assert.equal(discoveryPublic.effects[0], PROVENANCE_TARGET_REPAIR_EFFECTS[0]);
assert.match(discoveryPublic.effects[0], /separately authorized data-path repair/);
assert.equal(discoveryPublic.effects[0].includes("before ingest"), false);

const observationBase = {
  source: discoveryInput.source.id,
  original_id: discoverySeal.targets[0].original_id,
  locator_kind: "source_relative_path",
  run_id: discoveryPlan.run_ids.discovery,
  plan_id: discoveryPlan.plan_id,
  source_snapshot_id: discoveryInput.sourceSnapshotId,
  target_set_hash: discoverySeal.target_set_hash,
  target_count: 1,
  observation_stage: "discovery",
  outcome: "gap",
  reason_code: "provenance_unassessed",
  text_state: "native_readable",
  original_content_sha256: discoveryInput.original.original_content_sha256,
  original_byte_count: discoveryInput.original.original_byte_count,
  page_count: discoveryInput.original.page_count,
  page_count_state: discoveryInput.original.page_count_state,
  result_document_count: 0,
  result_document_set_hash: hashId({ family: "before" }),
  resolves_observation_hash: null,
};
const discoveryObservation = {
  sequence: 22,
  ...observationBase,
  observation_hash: hashId({ contract_version: 1, tenant_id: "primary", ...observationBase }),
  recorded_at: 123456,
};
const discoveryResponse = {
  contract_version: 1,
  mode: "record",
  source: discoveryInput.source.id,
  run_id: discoveryPlan.run_ids.discovery,
  target_set_hash: discoverySeal.target_set_hash,
  target_count: 1,
  observations: [discoveryObservation],
  bounded_target_set_recorded: true,
  repair_receipts_recorded: false,
  scope: clone(discoverySeal.scope),
};
const selected = selectPrivateProvenanceTargetDiscoveryReceipt(discoveryPlan, discoveryResponse);
assert.equal(selected.observation_hash, discoveryObservation.observation_hash);
assert.throws(() =>
  selectPrivateProvenanceTargetDiscoveryReceipt(discoveryPlan, discoveryObservation),
  /complete authenticated Worker record envelope/,
);
const discoveryFamilyReceipt = resultFamilyResponseFor(discoveryPlan);
const discoveryAcceptedReceipt = acceptedResolutionResponseFor(
  discoveryPlan,
  discoveryFamilyReceipt,
  "record",
  { resolves_observation_hash: discoveryObservation.observation_hash },
);
assert.throws(() => validatePrivateProvenanceAcceptedResolutionResponse(
  discoveryPlan,
  discoveryAcceptedReceipt,
  {
    operation: "record",
    resultFamilyReceipt: discoveryFamilyReceipt,
  },
), /complete authenticated Worker record envelope/);
assert.deepEqual(validatePrivateProvenanceAcceptedResolutionResponse(
  discoveryPlan,
  discoveryAcceptedReceipt,
  {
    operation: "record",
    discoveryReceipt: discoveryResponse,
    resultFamilyReceipt: discoveryFamilyReceipt,
  },
), discoveryAcceptedReceipt);
for (const mutate of [
  (receipt) => { delete receipt.resolves_observation_hash; },
  (receipt) => { receipt.resolves_observation_hash = id("f"); },
]) {
  const invalid = clone(discoveryAcceptedReceipt);
  mutate(invalid);
  assert.throws(() => validatePrivateProvenanceAcceptedResolutionResponse(
    discoveryPlan,
    invalid,
    {
      operation: "record",
      discoveryReceipt: discoveryResponse,
      resultFamilyReceipt: discoveryFamilyReceipt,
    },
  ), /accepted-resolution response/);
}
const tamperedObservation = clone(discoveryResponse);
tamperedObservation.observations[0].result_document_count = 1;
assert.throws(() =>
  selectPrivateProvenanceTargetDiscoveryReceipt(discoveryPlan, tamperedObservation), /integrity/);

console.log("provenance target repair tests passed");
