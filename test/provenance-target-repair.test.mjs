import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  PROVENANCE_TARGET_REPAIR_AUTHENTICATED_CHECK_ORDER,
  PROVENANCE_TARGET_REPAIR_EFFECTS,
  PROVENANCE_TARGET_REPAIR_OPERATIONS,
  authorizePrivateProvenanceTargetRepair,
  assertPrivateProvenanceTargetRepairApproval,
  bindPrivateProvenanceTargetRepairSeal,
  canonicalProvenanceTargetLocator,
  formatPrivateProvenanceAcceptedResolutionRequest,
  formatPrivateProvenanceResultFamilyRequest,
  formatPrivateProvenanceTargetDiscoveryRequest,
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
  productVersion: "0.4.8",
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
  priorAccepted: null,
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

function proofFor(designPlan) {
  const input = designPlan.input;
  return {
    authority: "owner_admin_authenticated_orchestrator",
    check_order: [...PROVENANCE_TARGET_REPAIR_AUTHENTICATED_CHECK_ORDER],
    source_lease: {
      source: input.source.id,
      acquired: true,
      held: true,
      before_private_access: true,
      before_network_access: true,
      before_state_access: true,
      lease_fingerprint: digest("b"),
    },
    authenticated_inventory: {
      authenticated: true,
      complete: true,
      truncated: false,
      source_snapshot_id: input.sourceSnapshotId,
      source: { ...input.source },
      target_original_id: designPlan.seal.targets[0].original_id,
      target_set_hash: designPlan.seal.target_set_hash,
      history_complete: true,
      history_conflict: false,
      accepted_resolution_exists: input.history.accepted_resolution_exists,
      unresolved_gap_count: input.history.unresolved_gap_count,
      prior_observation_hash: input.priorGap?.observation_hash ?? null,
      accepted_observation_hash: input.priorAccepted?.observation_hash ?? null,
    },
    local_readback: {
      candidate_runtime_package_fingerprint: input.candidateRuntimePackageFingerprint,
      manifest_fingerprint: input.manifestFingerprint,
      source_config_fingerprint: input.sourceConfigFingerprint,
      root_identity_fingerprint: hash(input.rootIdentity),
      original_content_sha256: input.original.original_content_sha256,
      original_byte_count: input.original.original_byte_count,
      text_state: input.original.text_state,
      page_count: input.original.page_count,
      page_count_state: input.original.page_count_state,
      ocr_enabled: false,
    },
  };
}

/* POSIX locators are exact, NFC, and source-relative. */
assert.equal(canonicalProvenanceTargetLocator("nested/é/report.pdf"), "nested/é/report.pdf");
for (const invalid of [
  "", "/absolute.pdf", "C:/absolute.pdf", "trailing/", "double//name.pdf",
  "dot/./name.pdf", "parent/../name.pdf", "windows\\name.pdf", "line\nbreak.pdf",
  "control/\u0085.pdf", "nested/e\u0301.pdf", `${"é".repeat(1025)}.pdf`,
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
const designPlan = bindPrivateProvenanceTargetRepairSeal(draft, sealed);
const duplicateDesign = bindPrivateProvenanceTargetRepairSeal(duplicateDraft, sealed);
assert.equal(designPlan.approval_id, duplicateDesign.approval_id);
const designPublic = publicProvenanceTargetRepairPlan(designPlan);
assert.equal(designPublic.can_apply, false);
assert.equal(designPublic.status, "design_only_executor_unavailable");
assert.doesNotMatch(renderProvenanceTargetRepairPlan(designPlan), /--apply --approve/);
assert.throws(() => assertPrivateProvenanceTargetRepairApproval(
  designPlan,
  designPublic.approval_id,
), /approval/);
const privatePlan = authorizePrivateProvenanceTargetRepair(designPlan, proofFor(designPlan));
const duplicatePlan = authorizePrivateProvenanceTargetRepair(
  duplicateDesign,
  proofFor(duplicateDesign),
);
assert.equal(privatePlan.approval_id, duplicatePlan.approval_id);
const publicPlan = publicProvenanceTargetRepairPlan(privatePlan);
assert.equal(publicPlan.source.id, "client_docs");
assert.equal(publicPlan.target_count, 1);
assert.equal(publicPlan.ocr.enabled, false);
assert.equal(publicPlan.evidence.discovery_required, false);
assert.equal(publicPlan.evidence.authority, "lease_first_authenticated_orchestrator_checks");
assert.equal(publicPlan.boundaries.whole_source_complete, false);
assert.equal(publicPlan.boundaries.may_process_preexisting_vector_backlog, true);
assert.equal(publicPlan.private_retrieval.exact_probe_count, 8);
assert.equal(publicPlan.private_retrieval.creates_embeddings, true);
assert.equal(publicPlan.private_retrieval.creates_ordinary_aggregate_usage_records, true);
assert.equal(publicPlan.can_apply, true);
assert.equal(publicPlan.approval_id, privatePlan.approval_id);
assert.equal(publicPlan.intended_operations.includes("record_single_target_discovery_gap"), false);
assert.deepEqual(publicPlan.effects, PROVENANCE_TARGET_REPAIR_EFFECTS.slice(1));
assert.deepEqual(publicPlan.intended_operations, [
  "reingest_exact_original",
  "clean_stale_exact_family_siblings_if_needed",
  "drain_global_vector_outbox",
  "record_schema44_result_family",
  "verify_schema44_result_family",
  "record_schema45_accepted_resolution",
  "verify_schema45_accepted_resolution",
]);

const publicJson = JSON.stringify(publicPlan);
for (const privateValue of [
  existingInput.rootIdentity.path,
  existingInput.locator,
  existingInput.retrievalQuery,
  existingInput.manifestFingerprint,
  existingInput.sourceConfigFingerprint,
  existingInput.candidateRuntimePackageFingerprint,
  existingInput.sourceSnapshotId,
  existingInput.original.original_content_sha256,
  existingInput.priorGap.original_id,
  existingInput.priorGap.observation_hash,
  sealed.target_set_hash,
  draft.plan_id,
]) {
  assert.equal(publicJson.includes(privateValue), false, `public plan leaked ${privateValue}`);
}
assert.match(publicJson, new RegExp(publicPlan.approval_id));
const rendered = renderProvenanceTargetRepairPlan(privatePlan);
assert.match(rendered, /This preview is read-only\. Nothing has changed\./);
assert.match(rendered, new RegExp(`--apply --approve ${publicPlan.approval_id}`));
assert.equal(rendered.includes(existingInput.locator), false);
assert.equal(rendered.includes(existingInput.retrievalQuery), false);

assert.doesNotThrow(() =>
  assertPrivateProvenanceTargetRepairApproval(privatePlan, publicPlan.approval_id));
assert.throws(() =>
  assertPrivateProvenanceTargetRepairApproval(privatePlan, digest("f")), /approval/);
assert.deepEqual(publicPlan.intended_operations, PROVENANCE_TARGET_REPAIR_OPERATIONS.slice(1));

const resultFamily = formatPrivateProvenanceResultFamilyRequest(privatePlan, {
  operation: "record",
  approvalId: publicPlan.approval_id,
});
assert.deepEqual(resultFamily, {
  contract_version: 1,
  mode: "result_family",
  operation: "record",
  source: "client_docs",
  locator_kind: "source_relative_path",
  locator: existingInput.locator,
  original_content_sha256: existingInput.original.original_content_sha256,
  original_byte_count: existingInput.original.original_byte_count,
  retrieval_query: existingInput.retrievalQuery,
});
const verifiedResultFamily = formatPrivateProvenanceResultFamilyRequest(privatePlan, {
  operation: "verify",
  approvalId: publicPlan.approval_id,
});
assert.equal(verifiedResultFamily.operation, "verify");
assert.deepEqual(
  { ...verifiedResultFamily, operation: "record" },
  resultFamily,
);
const resultFamilyRecordReceipt = {
  contract_version: 1,
  mode: "result_family",
  operation: "record",
  source: existingInput.source.id,
  original_id: existingInput.priorGap.original_id,
  family_receipt_hash: id("c"),
  verification_hash: id("d"),
  document_count: 1,
  chunk_count: 2,
  vector_readiness_hash: id("e"),
  retrieval_probe_id: `probe-v1:${digest("f")}`,
  retrieval_status: "deterministic",
  citation_status: "same_family",
  recorded: true,
  replayed: false,
  accepted_outcome_authorized: false,
};
const resultFamilyVerifyReceipt = {
  ...resultFamilyRecordReceipt,
  operation: "verify",
  recorded: false,
  replayed: true,
};
assert.equal(validatePrivateProvenanceResultFamilyResponse(
  privatePlan,
  resultFamilyRecordReceipt,
  { operation: "record", approvalId: publicPlan.approval_id },
).recorded, true);
assert.equal(validatePrivateProvenanceResultFamilyResponse(
  privatePlan,
  resultFamilyVerifyReceipt,
  {
    operation: "verify",
    approvalId: publicPlan.approval_id,
    recordReceipt: resultFamilyRecordReceipt,
  },
).replayed, true);
const accepted = formatPrivateProvenanceAcceptedResolutionRequest(privatePlan, {
  operation: "verify",
  approvalId: publicPlan.approval_id,
  resultFamilyRecordReceipt,
  resultFamilyVerifyReceipt,
});
assert.equal(accepted.run_id, privatePlan.run_ids.accepted_resolution);
assert.equal(accepted.targets[0].resolves_observation_hash, existingInput.priorGap.observation_hash);

const acceptedScope = {
  ...sealed.scope,
  kind: "single_target_accepted_resolution",
  maximum_targets: 1,
  accepted_outcomes_supported: true,
  accepted_resolution_mode: "one_exact_current_result_family",
  repair_verification_supported: true,
};
const acceptedRecordReceipt = {
  contract_version: 1,
  mode: "accepted_resolution",
  operation: "record",
  source: existingInput.source.id,
  run_id: privatePlan.run_ids.accepted_resolution,
  original_id: existingInput.priorGap.original_id,
  target_set_hash: sealed.target_set_hash,
  target_count: 1,
  accepted_observation_hash: id("7"),
  resolution_hash: id("2"),
  activation_hash: id("3"),
  family_receipt_hash: resultFamilyRecordReceipt.family_receipt_hash,
  verification_hash: resultFamilyRecordReceipt.verification_hash,
  document_count: resultFamilyRecordReceipt.document_count,
  chunk_count: resultFamilyRecordReceipt.chunk_count,
  vector_readiness_hash: resultFamilyRecordReceipt.vector_readiness_hash,
  retrieval_probe_id: resultFamilyRecordReceipt.retrieval_probe_id,
  retrieval_status: "deterministic",
  citation_status: "same_family",
  status: "accepted_resolution_current",
  recorded: true,
  replayed: false,
  reactivated: false,
  accepted_outcome_authorized: true,
  bounded_target_set_repair_verified: true,
  scope: acceptedScope,
};
const acceptedVerifyReceipt = {
  ...acceptedRecordReceipt,
  operation: "verify",
  recorded: false,
  replayed: true,
};
assert.equal(validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  acceptedRecordReceipt,
  {
    operation: "record",
    approvalId: publicPlan.approval_id,
    resultFamilyRecordReceipt,
    resultFamilyVerifyReceipt,
  },
).recorded, true);
assert.throws(() => validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  { ...acceptedRecordReceipt, accepted_observation_hash: existingInput.priorGap.observation_hash },
  {
    operation: "record",
    approvalId: publicPlan.approval_id,
    resultFamilyRecordReceipt,
    resultFamilyVerifyReceipt,
  },
), /accepted-resolution response/);
assert.equal(validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  acceptedVerifyReceipt,
  {
    operation: "verify",
    approvalId: publicPlan.approval_id,
    resultFamilyRecordReceipt,
    resultFamilyVerifyReceipt,
    recordReceipt: acceptedRecordReceipt,
  },
).replayed, true);
assert.throws(() => validatePrivateProvenanceAcceptedResolutionResponse(
  privatePlan,
  acceptedRecordReceipt,
  {
    operation: "record",
    approvalId: publicPlan.approval_id,
    resultFamilyRecordReceipt,
  },
), /record and verify/);
assert.throws(() => formatPrivateProvenanceTargetDiscoveryRequest(privatePlan, {
  approvalId: publicPlan.approval_id,
}), /already has/);

/* An existing accepted observation produces a fresh approval that only revalidates proof. */
const reverifyInput = clone(existingInput);
reverifyInput.priorAccepted = {
  sequence: 18,
  run_id: privatePlan.run_ids.accepted_resolution,
  plan_id: privatePlan.plan_id,
  source_snapshot_id: existingInput.sourceSnapshotId,
  target_set_hash: sealed.target_set_hash,
  observation_hash: acceptedRecordReceipt.accepted_observation_hash,
  resolves_observation_hash: existingInput.priorGap.observation_hash,
  original_id: existingInput.priorGap.original_id,
  original_content_sha256: existingInput.original.original_content_sha256,
};
reverifyInput.history.accepted_resolution_exists = true;
reverifyInput.history.unresolved_gap_count = 0;
const reverifyDraft = preparePrivateProvenanceTargetRepair(reverifyInput);
const reverifySeal = sealFor(reverifyDraft, existingInput.priorGap.original_id);
const reverifyDesign = bindPrivateProvenanceTargetRepairSeal(reverifyDraft, reverifySeal);
const reverifyPlan = authorizePrivateProvenanceTargetRepair(
  reverifyDesign,
  proofFor(reverifyDesign),
);
const reverifyPublic = publicProvenanceTargetRepairPlan(reverifyPlan);
assert.equal(reverifyPublic.workflow, "accepted_resolution_reverification");
assert.equal(reverifyPublic.evidence.accepted_resolution_exists, true);
assert.equal(reverifyPublic.boundaries.exact_family_stale_sibling_cleanup_possible, false);
assert.equal(reverifyPublic.boundaries.may_process_preexisting_vector_backlog, false);
assert.deepEqual(
  reverifyPublic.intended_operations,
  PROVENANCE_TARGET_REPAIR_OPERATIONS.slice(4),
);
assert.deepEqual(reverifyPublic.effects, PROVENANCE_TARGET_REPAIR_EFFECTS.slice(5));
assert.match(renderProvenanceTargetRepairPlan(reverifyPlan), /will not reingest/i);
const reverifyPublicJson = JSON.stringify(reverifyPublic);
for (const privateValue of [
  reverifyInput.priorAccepted.run_id,
  reverifyInput.priorAccepted.plan_id,
  reverifyInput.priorAccepted.source_snapshot_id,
  reverifyInput.priorAccepted.target_set_hash,
  reverifyInput.priorAccepted.observation_hash,
  reverifyInput.priorAccepted.original_id,
]) {
  assert.equal(reverifyPublicJson.includes(privateValue), false,
    `re-verification preview leaked ${privateValue}`);
}

const reverifyFamilyRecord = {
  ...resultFamilyRecordReceipt,
  operation: "record",
  recorded: false,
  replayed: true,
};
const reverifyFamilyVerify = {
  ...reverifyFamilyRecord,
  operation: "verify",
};
const reverifyAcceptedRequest = formatPrivateProvenanceAcceptedResolutionRequest(
  reverifyPlan,
  {
    operation: "record",
    approvalId: reverifyPublic.approval_id,
    resultFamilyRecordReceipt: reverifyFamilyRecord,
    resultFamilyVerifyReceipt: reverifyFamilyVerify,
  },
);
assert.equal(reverifyAcceptedRequest.run_id, reverifyInput.priorAccepted.run_id);
assert.equal(reverifyAcceptedRequest.plan_id, reverifyInput.priorAccepted.plan_id);
assert.equal(
  reverifyAcceptedRequest.source_snapshot_id,
  reverifyInput.priorAccepted.source_snapshot_id,
);
assert.equal(
  reverifyAcceptedRequest.target_set_hash,
  reverifyInput.priorAccepted.target_set_hash,
);
assert.equal(
  reverifyAcceptedRequest.targets[0].resolves_observation_hash,
  existingInput.priorGap.observation_hash,
);
const reactivatedReceipt = {
  ...acceptedRecordReceipt,
  operation: "record",
  recorded: false,
  replayed: false,
  reactivated: true,
};
const validatedReactivated = validatePrivateProvenanceAcceptedResolutionResponse(
  reverifyPlan,
  reactivatedReceipt,
  {
    operation: "record",
    approvalId: reverifyPublic.approval_id,
    resultFamilyRecordReceipt: reverifyFamilyRecord,
    resultFamilyVerifyReceipt: reverifyFamilyVerify,
  },
);
assert.equal(validatedReactivated.reactivated, true);
const reactivatedVerify = {
  ...reactivatedReceipt,
  operation: "verify",
  recorded: false,
  replayed: true,
  reactivated: false,
};
assert.equal(validatePrivateProvenanceAcceptedResolutionResponse(
  reverifyPlan,
  reactivatedVerify,
  {
    operation: "verify",
    approvalId: reverifyPublic.approval_id,
    resultFamilyRecordReceipt: reverifyFamilyRecord,
    resultFamilyVerifyReceipt: reverifyFamilyVerify,
    recordReceipt: reactivatedReceipt,
  },
).replayed, true);

/* Every plan-defining input invalidates an earlier approval. */
for (const mutate of [
  (input) => { input.productVersion = "0.4.9"; },
  (input) => { input.candidateRuntimePackageFingerprint = digest("9"); },
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
  (proof) => { proof.check_order.reverse(); },
  (proof) => { proof.source_lease.before_private_access = false; },
  (proof) => { proof.authenticated_inventory.complete = false; },
  (proof) => { proof.authenticated_inventory.accepted_resolution_exists = true; },
  (proof) => { proof.local_readback.candidate_runtime_package_fingerprint = digest("9"); },
]) {
  const invalidProof = proofFor(designPlan);
  mutate(invalidProof);
  assert.throws(() => authorizePrivateProvenanceTargetRepair(designPlan, invalidProof),
    /authenticated orchestrator checks/);
}

/* Fresh targets bind discovery into approval, record only after approval, and use its exact receipt. */
const discoveryInput = clone(existingInput);
discoveryInput.priorGap = null;
discoveryInput.priorAccepted = null;
discoveryInput.discoveryRequired = true;
discoveryInput.history.unresolved_gap_count = 0;
const discoveryDraft = preparePrivateProvenanceTargetRepair(discoveryInput);
const discoverySeal = sealFor(discoveryDraft, originalId("a"));
const discoveryDesign = bindPrivateProvenanceTargetRepairSeal(discoveryDraft, discoverySeal);
const discoveryPlan = authorizePrivateProvenanceTargetRepair(
  discoveryDesign,
  proofFor(discoveryDesign),
);
const discoveryPublic = publicProvenanceTargetRepairPlan(discoveryPlan);
assert.equal(discoveryPublic.evidence.discovery_required, true);
assert.equal(discoveryPublic.intended_operations[0], "record_single_target_discovery_gap");
assert.equal(discoveryPublic.effects[0], PROVENANCE_TARGET_REPAIR_EFFECTS[0]);

const discoveryRequest = formatPrivateProvenanceTargetDiscoveryRequest(discoveryPlan, {
  approvalId: discoveryPublic.approval_id,
});
assert.equal(discoveryRequest.run_id, discoveryPlan.run_ids.discovery);
assert.equal(discoveryRequest.targets[0].observation_stage, "discovery");
assert.equal(discoveryRequest.targets[0].resolves_observation_hash, null);

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
  authority_chain_version: 1,
  predecessor_observation_hash: null,
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
  scope: discoverySeal.scope,
};
const selected = selectPrivateProvenanceTargetDiscoveryReceipt(discoveryPlan, discoveryResponse);
assert.equal(selected.observation_hash, discoveryObservation.observation_hash);
const discoveryFamilyRecordReceipt = {
  ...resultFamilyRecordReceipt,
  original_id: discoverySeal.targets[0].original_id,
};
const discoveryFamilyVerifyReceipt = {
  ...discoveryFamilyRecordReceipt,
  operation: "verify",
  recorded: false,
  replayed: true,
};
const acceptedAfterDiscovery = formatPrivateProvenanceAcceptedResolutionRequest(discoveryPlan, {
  operation: "record",
  approvalId: discoveryPublic.approval_id,
  discoveryReceipt: discoveryResponse,
  resultFamilyRecordReceipt: discoveryFamilyRecordReceipt,
  resultFamilyVerifyReceipt: discoveryFamilyVerifyReceipt,
});
assert.equal(acceptedAfterDiscovery.run_id, discoveryPlan.run_ids.accepted_resolution);
assert.equal(acceptedAfterDiscovery.targets[0].resolves_observation_hash,
  discoveryObservation.observation_hash);
assert.throws(() => formatPrivateProvenanceAcceptedResolutionRequest(discoveryPlan, {
  operation: "record",
  approvalId: discoveryPublic.approval_id,
  resultFamilyRecordReceipt: discoveryFamilyRecordReceipt,
  resultFamilyVerifyReceipt: discoveryFamilyVerifyReceipt,
}), /discovery (receipt|observation)/);
const tamperedObservation = {
  ...discoveryResponse,
  observations: [{ ...selected, result_document_count: 1 }],
};
assert.throws(() =>
  selectPrivateProvenanceTargetDiscoveryReceipt(discoveryPlan, tamperedObservation), /integrity/);

console.log("provenance target repair tests passed");
