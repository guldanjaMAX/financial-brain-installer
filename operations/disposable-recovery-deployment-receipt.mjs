/**
 * Strict private receipts for the fixed v0.4.8 disposable Worker deployment.
 *
 * Schema v2 separates source and target approvals, requires an immutable
 * preflight before each phase, and binds provider observations through hashes
 * of raw-evidence manifests. The old combined schema remains available only
 * through explicitly named legacy validators for fixture compatibility.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";

import { readPrivateAggregateReceipt } from "./private-aggregate-receipt.mjs";

export const DISPOSABLE_RECOVERY_LEGACY_DEPLOYMENT_PROTOCOL =
  "v048-disposable-recovery-deployment-v1";
export const DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL =
  "v048-disposable-recovery-deployment-v2";
export const DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL =
  "v048-disposable-recovery-source-preflight-v2";
export const DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL =
  "v048-disposable-recovery-source-phase-v2";
export const DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL =
  "v048-disposable-recovery-target-preflight-v2";

export const DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME =
  "v048-disposable-source-preflight-receipt.json";
export const DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME =
  "v048-disposable-source-deployment-receipt.json";
export const DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME =
  "v048-disposable-target-preflight-receipt.json";
export const DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME =
  "v048-disposable-deployment-receipt.json";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const NODE_VERSION_RE = /^v(?:22|2[3-9]|[3-9][0-9])\.[0-9]+\.[0-9]+$/u;
const PACKAGE_NAME = "brain-installer-0.4.8.tgz";
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_FILES = 100_000;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const PRODUCT_VERSION = "0.4.8";
const WRANGLER_VERSION = "4.131.1";
const CLIENT_SLUG = "v048-field-proof";
const SOURCE_RESOURCE = "brain-test-v048-field-source-recovery-gate-a48f1101";
const TARGET_RESOURCE = "brain-test-v048-field-target-recovery-gate-a48f1102";

const SELF_ATTESTATION_FIELDS = new Set([
  "accepted",
  "bindings_exact",
  "code_exact",
  "exact_package_proven",
  "exact_provider_readback_proven",
  "provider_readback",
  "resources_exact",
  "routes_and_custom_domains_empty_proven",
  "source_active_proven",
  "target_active_uploaded_not_promoted_proven",
  "target_paused_proven",
]);

const BINDING_BASE_FIELDS = Object.freeze([
  "schema_version",
  "run_id",
  "plan_fingerprint",
  "candidate_sha",
  "candidate_tree_sha",
  "field_receipt_sha256",
  "field_receipt_run_id",
  "package_filename",
  "package_bytes",
  "package_sha256",
  "package_file_count",
  "execution_inventory_sha256",
  "installed_execution_inventory_sha256",
  "source_manifest_fingerprint",
  "source_resource_fingerprint",
  "target_manifest_fingerprint",
  "target_resource_fingerprint",
  "runtime_contract_fingerprint",
  "wrangler_version",
  "wrangler_wrapper_sha256",
  "wrangler_runtime_inventory_sha256",
  "wrangler_entrypoint_sha256",
  "node_version",
  "node_executable_sha256",
]);

const BINDING_FIELDS = Object.freeze([
  "schema_version",
  "run_id",
  "campaign_fingerprint",
  ...BINDING_BASE_FIELDS.slice(2),
]);

export class DisposableRecoveryDeploymentReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryDeploymentReceiptError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryDeploymentReceiptError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields) {
  if (!plainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(descriptors, field)) &&
    keys.every((key) =>
      descriptors[key].enumerable === true &&
      Object.hasOwn(descriptors[key], "value"));
}

function immutableClone(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
    return item;
  };
  return freeze(clone);
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validIso(value) {
  if (typeof value !== "string" || value.length !== 24 || CONTROL_RE.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function hashes(values) {
  return values.every((value) => SHA256_RE.test(String(value || "")));
}

function opaqueProviderValue(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    !CONTROL_RE.test(value);
}

function providerId(value) {
  return PROVIDER_ID_RE.test(String(value || ""));
}

function assertNoSelfAttestation(value, code, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) refuse(code);
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !Object.hasOwn(descriptors[key], "value")) {
        refuse(code);
      }
      if (SELF_ATTESTATION_FIELDS.has(key)) refuse(code);
      assertNoSelfAttestation(descriptors[key].value, code, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function assertBindingBase(binding, code) {
  assertNoSelfAttestation(binding, code);
  if (!exactKeys(binding, BINDING_BASE_FIELDS) ||
      binding.schema_version !== 2 ||
      !UUID_RE.test(String(binding.run_id || "")) ||
      !COMMIT_RE.test(String(binding.candidate_sha || "")) ||
      !COMMIT_RE.test(String(binding.candidate_tree_sha || "")) ||
      binding.candidate_sha === binding.candidate_tree_sha ||
      !UUID_RE.test(String(binding.field_receipt_run_id || "")) ||
      binding.package_filename !== PACKAGE_NAME ||
      !Number.isSafeInteger(binding.package_bytes) ||
      binding.package_bytes < 1 ||
      binding.package_bytes > MAX_PACKAGE_BYTES ||
      !Number.isSafeInteger(binding.package_file_count) ||
      binding.package_file_count < 1 ||
      binding.package_file_count > MAX_PACKAGE_FILES ||
      binding.execution_inventory_sha256 !==
        binding.installed_execution_inventory_sha256 ||
      binding.source_manifest_fingerprint === binding.target_manifest_fingerprint ||
      binding.source_resource_fingerprint === binding.target_resource_fingerprint ||
      binding.wrangler_version !== WRANGLER_VERSION ||
      !NODE_VERSION_RE.test(String(binding.node_version || "")) ||
      !hashes([
        binding.plan_fingerprint,
        binding.field_receipt_sha256,
        binding.package_sha256,
        binding.execution_inventory_sha256,
        binding.installed_execution_inventory_sha256,
        binding.source_manifest_fingerprint,
        binding.source_resource_fingerprint,
        binding.target_manifest_fingerprint,
        binding.target_resource_fingerprint,
        binding.runtime_contract_fingerprint,
        binding.wrangler_wrapper_sha256,
        binding.wrangler_runtime_inventory_sha256,
        binding.wrangler_entrypoint_sha256,
        binding.node_executable_sha256,
      ])) {
    refuse(code);
  }
  return immutableClone(binding);
}

/**
 * Derive the fixed campaign identity. The phase run UUID is deliberately
 * excluded so an interrupted run cannot redefine the reviewed campaign.
 */
export function disposableRecoveryDeploymentCampaignFingerprint(bindingInput) {
  if (!plainObject(bindingInput)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID");
  }
  const input = structuredClone(bindingInput);
  if (exactKeys(input, BINDING_FIELDS)) delete input.campaign_fingerprint;
  const binding = assertBindingBase(
    input,
    "DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID",
  );
  const { run_id: _runId, ...campaignBinding } = binding;
  return sha256(canonical({
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    release: PRODUCT_VERSION,
    client_slug: CLIENT_SLUG,
    package_filename: PACKAGE_NAME,
    source_resource: SOURCE_RESOURCE,
    target_resource: TARGET_RESOURCE,
    source_mode: "active",
    target_initial_mode: "paused-for-upgrade",
    campaign_binding: campaignBinding,
  }));
}

/** Validate the immutable package, plan, manifest, runtime, and campaign bind. */
export function assertDisposableRecoveryDeploymentBinding(binding) {
  if (!exactKeys(binding, BINDING_FIELDS) ||
      !SHA256_RE.test(String(binding?.campaign_fingerprint || ""))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID");
  }
  const base = structuredClone(binding);
  delete base.campaign_fingerprint;
  assertBindingBase(base, "DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID");
  if (binding.campaign_fingerprint !==
      disposableRecoveryDeploymentCampaignFingerprint(base)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID");
  }
  return immutableClone(binding);
}

/** Derive the source-only A2 approval from the exact preflight receipt. */
export function disposableRecoverySourceA2Fingerprint(
  bindingInput,
  sourcePreflightReceiptSha256,
) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  if (!SHA256_RE.test(String(sourcePreflightReceiptSha256 || ""))) {
    refuse("DISPOSABLE_RECOVERY_SOURCE_APPROVAL_INVALID");
  }
  return sha256(canonical({
    schema_version: 2,
    approval: "A2",
    purpose: "deploy_reviewed_active_source_and_write_fixed_synthetic_seed",
    protocol: DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
    binding,
    source_preflight_receipt_sha256: sourcePreflightReceiptSha256,
  }));
}

/** Derive the target-only A4 approval from all preceding causal receipts. */
export function disposableRecoveryTargetA4Fingerprint(
  bindingInput,
  sourcePhaseReceiptSha256,
  seedReceiptSha256,
  targetPreflightReceiptSha256,
) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  const links = [
    sourcePhaseReceiptSha256,
    seedReceiptSha256,
    targetPreflightReceiptSha256,
  ];
  if (!hashes(links) || new Set(links).size !== links.length) {
    refuse("DISPOSABLE_RECOVERY_TARGET_APPROVAL_INVALID");
  }
  return sha256(canonical({
    schema_version: 2,
    approval: "A4",
    purpose: "upload_reviewed_target_versions_and_deploy_paused_only",
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    binding,
    source_phase_receipt_sha256: sourcePhaseReceiptSha256,
    seed_receipt_sha256: seedReceiptSha256,
    target_preflight_receipt_sha256: targetPreflightReceiptSha256,
  }));
}

function assertDoubleReadSnapshot(snapshot, code) {
  const fields = [
    "first_raw_evidence_manifest_sha256",
    "second_raw_evidence_manifest_sha256",
    "first_semantic_sha256",
    "second_semantic_sha256",
    "stable_semantic_sha256",
  ];
  assertNoSelfAttestation(snapshot, code);
  if (!exactKeys(snapshot, fields) ||
      !hashes(fields.map((field) => snapshot[field])) ||
      snapshot.first_raw_evidence_manifest_sha256 ===
        snapshot.second_raw_evidence_manifest_sha256 ||
      snapshot.first_semantic_sha256 !== snapshot.second_semantic_sha256 ||
      snapshot.first_semantic_sha256 !== snapshot.stable_semantic_sha256) {
    refuse(code);
  }
  return immutableClone(snapshot);
}

function assertSourceJournal(journal, binding, code) {
  const fields = [
    "run_id",
    "through_sequence",
    "event_count",
    "head_sha256",
    "event_manifest_sha256",
  ];
  if (!exactKeys(journal, fields) || journal.run_id !== binding.run_id ||
      journal.through_sequence !== 4 || journal.event_count !== 4 ||
      !hashes([journal.head_sha256, journal.event_manifest_sha256])) {
    refuse(code);
  }
  return immutableClone(journal);
}

function assertTargetJournal(journal, binding, code) {
  const fields = [
    "run_id",
    "through_sequence",
    "event_count",
    "source_prefix_head_sha256",
    "head_sha256",
    "event_manifest_sha256",
  ];
  if (!exactKeys(journal, fields) || journal.run_id !== binding.run_id ||
      journal.through_sequence !== 6 || journal.event_count !== 6 ||
      !hashes([
        journal.source_prefix_head_sha256,
        journal.head_sha256,
        journal.event_manifest_sha256,
      ])) {
    refuse(code);
  }
  return immutableClone(journal);
}

function assertVersionEvidence(version, code) {
  const fields = [
    "version_id",
    "script_etag",
    "upload_request_sha256",
    "module_inventory_sha256",
    "bindings_sha256",
    "bindings_without_mode_sha256",
    "upload_response_evidence_manifest_sha256",
    "version_readback_evidence_manifest_sha256",
  ];
  assertNoSelfAttestation(version, code);
  if (!exactKeys(version, fields) || !providerId(version.version_id) ||
      !opaqueProviderValue(version.script_etag) ||
      !hashes(fields.slice(2).map((field) => version[field])) ||
      version.upload_response_evidence_manifest_sha256 ===
        version.version_readback_evidence_manifest_sha256) {
    refuse(code);
  }
  return immutableClone(version);
}

function assertDeploymentEvidence(deployment, code) {
  const fields = [
    "deployment_id",
    "version_id",
    "traffic_percent",
    "deployment_request_sha256",
    "deployment_response_evidence_manifest_sha256",
    "deployment_readback_evidence_manifest_sha256",
  ];
  assertNoSelfAttestation(deployment, code);
  if (!exactKeys(deployment, fields) ||
      !providerId(deployment.deployment_id) ||
      !providerId(deployment.version_id) ||
      deployment.traffic_percent !== 100 ||
      !hashes(fields.slice(3).map((field) => deployment[field])) ||
      deployment.deployment_response_evidence_manifest_sha256 ===
        deployment.deployment_readback_evidence_manifest_sha256) {
    refuse(code);
  }
  return immutableClone(deployment);
}

/** Validate the immutable read-only gate that precedes source mutation. */
export function assertDisposableRecoverySourcePreflightReceipt(receipt) {
  const code = "DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_INVALID";
  assertNoSelfAttestation(receipt, code);
  const fields = [
    "schema_version",
    "protocol",
    "kind",
    "status",
    "completed_at",
    "binding",
    "planned_requests",
    "snapshot",
  ];
  if (!exactKeys(receipt, fields) || receipt.schema_version !== 2 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL ||
      receipt.kind !== "source_preflight" || receipt.status !== "passed" ||
      !validIso(receipt.completed_at)) {
    refuse(code);
  }
  assertDisposableRecoveryDeploymentBinding(receipt.binding);
  const plannedFields = [
    "source_active_upload_sha256",
    "source_active_deployment_sha256",
    "seed_fixture_sha256",
  ];
  if (!exactKeys(receipt.planned_requests, plannedFields) ||
      !hashes(plannedFields.map((field) => receipt.planned_requests[field])) ||
      new Set(plannedFields.map((field) => receipt.planned_requests[field])).size !==
        plannedFields.length) {
    refuse(code);
  }
  assertDoubleReadSnapshot(receipt.snapshot, code);
  return immutableClone(receipt);
}

/** Validate the immutable read-only gate that precedes target mutation. */
export function assertDisposableRecoveryTargetPreflightReceipt(receipt) {
  const code = "DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_INVALID";
  assertNoSelfAttestation(receipt, code);
  const fields = [
    "schema_version",
    "protocol",
    "kind",
    "status",
    "completed_at",
    "binding",
    "source_phase_receipt_sha256",
    "seed_receipt_sha256",
    "planned_requests",
    "snapshot",
  ];
  if (!exactKeys(receipt, fields) || receipt.schema_version !== 2 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL ||
      receipt.kind !== "target_preflight" || receipt.status !== "passed" ||
      !validIso(receipt.completed_at) ||
      !hashes([
        receipt.source_phase_receipt_sha256,
        receipt.seed_receipt_sha256,
      ]) ||
      receipt.source_phase_receipt_sha256 === receipt.seed_receipt_sha256) {
    refuse(code);
  }
  assertDisposableRecoveryDeploymentBinding(receipt.binding);
  const plannedFields = [
    "target_paused_upload_sha256",
    "target_active_upload_sha256",
    "target_paused_deployment_sha256",
  ];
  if (!exactKeys(receipt.planned_requests, plannedFields) ||
      !hashes(plannedFields.map((field) => receipt.planned_requests[field])) ||
      new Set(plannedFields.map((field) => receipt.planned_requests[field])).size !==
        plannedFields.length) {
    refuse(code);
  }
  assertDoubleReadSnapshot(receipt.snapshot, code);
  return immutableClone(receipt);
}

/** Validate the finalized source phase and its distinct A2 authorization. */
export function assertDisposableRecoverySourcePhaseReceipt(receipt) {
  const code = "DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_INVALID";
  assertNoSelfAttestation(receipt, code);
  const fields = [
    "schema_version",
    "protocol",
    "kind",
    "status",
    "completed_at",
    "binding",
    "source_preflight_receipt_sha256",
    "a2_approval_fingerprint",
    "journal",
    "source",
    "final_snapshot",
  ];
  if (!exactKeys(receipt, fields) || receipt.schema_version !== 2 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL ||
      receipt.kind !== "source_phase" || receipt.status !== "passed" ||
      !validIso(receipt.completed_at) ||
      !hashes([
        receipt.source_preflight_receipt_sha256,
        receipt.a2_approval_fingerprint,
      ])) {
    refuse(code);
  }
  const binding = assertDisposableRecoveryDeploymentBinding(receipt.binding);
  if (receipt.a2_approval_fingerprint !== disposableRecoverySourceA2Fingerprint(
    binding,
    receipt.source_preflight_receipt_sha256,
  )) {
    refuse(code);
  }
  assertSourceJournal(receipt.journal, binding, code);
  if (!exactKeys(receipt.source, [
    "resource_fingerprint",
    "active_version",
    "active_deployment",
  ]) ||
      receipt.source.resource_fingerprint !==
        binding.source_resource_fingerprint) {
    refuse(code);
  }
  const version = assertVersionEvidence(receipt.source.active_version, code);
  const deployment = assertDeploymentEvidence(receipt.source.active_deployment, code);
  if (deployment.version_id !== version.version_id ||
      deployment.deployment_request_sha256 === version.upload_request_sha256) {
    refuse(code);
  }
  assertDoubleReadSnapshot(receipt.final_snapshot, code);
  return immutableClone(receipt);
}

/** Validate the finalized target phase and its distinct A4 authorization. */
export function assertDisposableRecoveryTargetPhaseReceipt(receipt) {
  const code = "DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID";
  assertNoSelfAttestation(receipt, code);
  const fields = [
    "schema_version",
    "protocol",
    "kind",
    "status",
    "completed_at",
    "binding",
    "source_phase_receipt_sha256",
    "seed_receipt_sha256",
    "target_preflight_receipt_sha256",
    "a4_approval_fingerprint",
    "journal",
    "source",
    "target",
    "final_snapshot",
  ];
  if (!exactKeys(receipt, fields) || receipt.schema_version !== 2 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL ||
      receipt.kind !== "target_phase" || receipt.status !== "passed" ||
      !validIso(receipt.completed_at)) {
    refuse(code);
  }
  const links = [
    receipt.source_phase_receipt_sha256,
    receipt.seed_receipt_sha256,
    receipt.target_preflight_receipt_sha256,
  ];
  if (!hashes([...links, receipt.a4_approval_fingerprint]) ||
      new Set(links).size !== links.length) {
    refuse(code);
  }
  const binding = assertDisposableRecoveryDeploymentBinding(receipt.binding);
  if (receipt.a4_approval_fingerprint !== disposableRecoveryTargetA4Fingerprint(
    binding,
    ...links,
  )) {
    refuse(code);
  }
  assertTargetJournal(receipt.journal, binding, code);
  const sourceFields = [
    "resource_fingerprint",
    "active_version_id",
    "active_script_etag",
    "active_deployment_id",
  ];
  if (!exactKeys(receipt.source, sourceFields) ||
      receipt.source.resource_fingerprint !== binding.source_resource_fingerprint ||
      !providerId(receipt.source.active_version_id) ||
      !opaqueProviderValue(receipt.source.active_script_etag) ||
      !providerId(receipt.source.active_deployment_id)) {
    refuse(code);
  }
  const targetFields = [
    "resource_fingerprint",
    "paused_version",
    "active_version",
    "paused_deployment",
  ];
  if (!exactKeys(receipt.target, targetFields) ||
      receipt.target.resource_fingerprint !== binding.target_resource_fingerprint) {
    refuse(code);
  }
  const pausedVersion = assertVersionEvidence(receipt.target.paused_version, code);
  const activeVersion = assertVersionEvidence(receipt.target.active_version, code);
  const pausedDeployment = assertDeploymentEvidence(
    receipt.target.paused_deployment,
    code,
  );
  if (pausedVersion.version_id === activeVersion.version_id ||
      pausedVersion.upload_request_sha256 === activeVersion.upload_request_sha256 ||
      pausedVersion.bindings_sha256 === activeVersion.bindings_sha256 ||
      pausedVersion.module_inventory_sha256 !== activeVersion.module_inventory_sha256 ||
      pausedVersion.bindings_without_mode_sha256 !==
        activeVersion.bindings_without_mode_sha256 ||
      pausedDeployment.version_id !== pausedVersion.version_id ||
      new Set([
        pausedVersion.upload_request_sha256,
        activeVersion.upload_request_sha256,
        pausedDeployment.deployment_request_sha256,
      ]).size !== 3) {
    refuse(code);
  }
  assertDoubleReadSnapshot(receipt.final_snapshot, code);
  return immutableClone(receipt);
}

/**
 * The existing public validator name now accepts only the executable phased
 * schema. A legacy combined fixture can never flow through this entry point.
 */
export function assertDisposableRecoveryDeploymentReceipt(receipt) {
  return assertDisposableRecoveryTargetPhaseReceipt(receipt);
}

function sameBinding(left, right) {
  return canonical(left) === canonical(right);
}

function assertLoadedReceipt(loaded, assertReceipt, code) {
  if (!plainObject(loaded) || !SHA256_RE.test(String(loaded.sha256 || "")) ||
      !Object.hasOwn(loaded, "value")) {
    refuse(code);
  }
  return Object.freeze({
    value: assertReceipt(loaded.value),
    sha256: loaded.sha256,
  });
}

/**
 * Validate all hash edges, request-plan edges, journal prefix, and source pins.
 * Timestamps are only a supporting monotonicity check; hashes carry causality.
 */
export function assertDisposableRecoveryDeploymentReceiptChain(chain) {
  const code = "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_CHAIN_INVALID";
  if (!exactKeys(chain, [
    "source_preflight",
    "source_phase",
    "seed_receipt_sha256",
    "target_preflight",
    "target_phase",
  ]) || !SHA256_RE.test(String(chain?.seed_receipt_sha256 || ""))) {
    refuse(code);
  }
  const sourcePreflight = assertLoadedReceipt(
    chain.source_preflight,
    assertDisposableRecoverySourcePreflightReceipt,
    code,
  );
  const sourcePhase = assertLoadedReceipt(
    chain.source_phase,
    assertDisposableRecoverySourcePhaseReceipt,
    code,
  );
  const targetPreflight = assertLoadedReceipt(
    chain.target_preflight,
    assertDisposableRecoveryTargetPreflightReceipt,
    code,
  );
  const targetPhase = assertLoadedReceipt(
    chain.target_phase,
    assertDisposableRecoveryTargetPhaseReceipt,
    code,
  );
  const values = [
    sourcePreflight.value,
    sourcePhase.value,
    targetPreflight.value,
    targetPhase.value,
  ];
  if (values.some((value) => !sameBinding(value.binding, values[0].binding)) ||
      sourcePhase.value.source_preflight_receipt_sha256 !==
        sourcePreflight.sha256 ||
      sourcePhase.value.source.active_version.upload_request_sha256 !==
        sourcePreflight.value.planned_requests.source_active_upload_sha256 ||
      sourcePhase.value.source.active_deployment.deployment_request_sha256 !==
        sourcePreflight.value.planned_requests.source_active_deployment_sha256 ||
      targetPreflight.value.source_phase_receipt_sha256 !== sourcePhase.sha256 ||
      targetPreflight.value.seed_receipt_sha256 !== chain.seed_receipt_sha256 ||
      targetPhase.value.source_phase_receipt_sha256 !== sourcePhase.sha256 ||
      targetPhase.value.seed_receipt_sha256 !== chain.seed_receipt_sha256 ||
      targetPhase.value.target_preflight_receipt_sha256 !== targetPreflight.sha256 ||
      targetPhase.value.journal.source_prefix_head_sha256 !==
        sourcePhase.value.journal.head_sha256 ||
      targetPhase.value.source.resource_fingerprint !==
        sourcePhase.value.source.resource_fingerprint ||
      targetPhase.value.source.active_version_id !==
        sourcePhase.value.source.active_version.version_id ||
      targetPhase.value.source.active_script_etag !==
        sourcePhase.value.source.active_version.script_etag ||
      targetPhase.value.source.active_deployment_id !==
        sourcePhase.value.source.active_deployment.deployment_id ||
      targetPhase.value.target.paused_version.upload_request_sha256 !==
        targetPreflight.value.planned_requests.target_paused_upload_sha256 ||
      targetPhase.value.target.active_version.upload_request_sha256 !==
        targetPreflight.value.planned_requests.target_active_upload_sha256 ||
      targetPhase.value.target.paused_deployment.deployment_request_sha256 !==
        targetPreflight.value.planned_requests.target_paused_deployment_sha256) {
    refuse(code);
  }
  const times = values.map(({ completed_at }) => Date.parse(completed_at));
  if (times.some((time, index) => index > 0 && time < times[index - 1])) {
    refuse(code);
  }
  return Object.freeze({
    source_preflight: sourcePreflight,
    source_phase: sourcePhase,
    seed_receipt_sha256: chain.seed_receipt_sha256,
    target_preflight: targetPreflight,
    target_phase: targetPhase,
  });
}

function readV2Receipt(path, expectedName, assertReceipt, code, dependencies) {
  if (!plainObject(dependencies) ||
      Object.keys(dependencies).some((key) => key !== "readReceipt") ||
      (dependencies.readReceipt !== undefined &&
        typeof dependencies.readReceipt !== "function") ||
      basename(String(path || "")) !== expectedName) {
    refuse(code);
  }
  const readReceipt = dependencies.readReceipt ?? readPrivateAggregateReceipt;
  let loaded;
  try {
    loaded = readReceipt(path, { code, maxBytes: MAX_RECEIPT_BYTES });
    const value = assertReceipt(loaded?.value);
    if (!SHA256_RE.test(String(loaded?.sha256 || ""))) refuse(code);
    return Object.freeze({
      value,
      sha256: loaded.sha256,
      info: loaded.info,
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryDeploymentReceiptError &&
        error.code === code) {
      throw error;
    }
    refuse(code);
  }
}

export function readDisposableRecoverySourcePreflightReceipt(path, dependencies = {}) {
  return readV2Receipt(
    path,
    DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
    assertDisposableRecoverySourcePreflightReceipt,
    "DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_READ_FAILED",
    dependencies,
  );
}

export function readDisposableRecoverySourcePhaseReceipt(path, dependencies = {}) {
  return readV2Receipt(
    path,
    DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
    assertDisposableRecoverySourcePhaseReceipt,
    "DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_READ_FAILED",
    dependencies,
  );
}

export function readDisposableRecoveryTargetPreflightReceipt(path, dependencies = {}) {
  return readV2Receipt(
    path,
    DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
    assertDisposableRecoveryTargetPreflightReceipt,
    "DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_READ_FAILED",
    dependencies,
  );
}

export function readDisposableRecoveryTargetPhaseReceipt(path, dependencies = {}) {
  return readV2Receipt(
    path,
    DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
    assertDisposableRecoveryTargetPhaseReceipt,
    "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_READ_FAILED",
    dependencies,
  );
}

/** Read the final v2 target receipt under the existing final filename. */
export function readDisposableRecoveryDeploymentReceipt(path, dependencies = {}) {
  return readDisposableRecoveryTargetPhaseReceipt(path, dependencies);
}

/*
 * Legacy schema v1. These exports exist only for historical fixture validation.
 * No default reader or executable validator accepts this format.
 */

export function legacyDisposableRecoveryDeploymentApprovalFingerprint(bindingInput) {
  if (!bindingInput || typeof bindingInput !== "object" ||
      Array.isArray(bindingInput)) {
    refuse("DISPOSABLE_RECOVERY_LEGACY_BINDING_INVALID");
  }
  const binding = structuredClone(bindingInput);
  delete binding.execution_approval_fingerprint;
  return sha256(canonical({
    schema_version: 1,
    purpose: "deploy_exact_v048_disposable_recovery_workers",
    protocol: DISPOSABLE_RECOVERY_LEGACY_DEPLOYMENT_PROTOCOL,
    source_resource: SOURCE_RESOURCE,
    target_resource: TARGET_RESOURCE,
    source_mode: "active",
    target_initial_mode: "paused-for-upgrade",
    target_active_version_uploaded_not_promoted: true,
    binding,
  }));
}

/**
 * @deprecated Fixture compatibility only. This does not produce an executable
 * schema-v2 approval.
 */
export const disposableRecoveryDeploymentApprovalFingerprint =
  legacyDisposableRecoveryDeploymentApprovalFingerprint;

export function assertLegacyDisposableRecoveryDeploymentBinding(binding) {
  const fields = [
    "schema_version", "plan_fingerprint", "candidate_sha", "candidate_tree_sha",
    "field_receipt_sha256", "field_receipt_run_id", "package_filename",
    "package_bytes", "package_sha256", "package_file_count",
    "execution_inventory_sha256", "installed_execution_inventory_sha256",
    "source_manifest_fingerprint", "source_resource_fingerprint",
    "target_manifest_fingerprint", "target_resource_fingerprint",
    "runtime_contract_fingerprint", "wrangler_version", "wrangler_wrapper_sha256",
    "wrangler_runtime_inventory_sha256", "wrangler_entrypoint_sha256",
    "node_version", "node_executable_sha256", "execution_approval_fingerprint",
  ];
  if (!exactKeys(binding, fields) || binding.schema_version !== 1 ||
      !COMMIT_RE.test(String(binding.candidate_sha || "")) ||
      !COMMIT_RE.test(String(binding.candidate_tree_sha || "")) ||
      !UUID_RE.test(String(binding.field_receipt_run_id || "")) ||
      binding.package_filename !== PACKAGE_NAME ||
      !Number.isSafeInteger(binding.package_bytes) || binding.package_bytes < 1 ||
      !Number.isSafeInteger(binding.package_file_count) ||
      binding.package_file_count < 1 ||
      binding.execution_inventory_sha256 !==
        binding.installed_execution_inventory_sha256 ||
      binding.wrangler_version !== WRANGLER_VERSION ||
      !NODE_VERSION_RE.test(String(binding.node_version || "")) ||
      !hashes([
        binding.plan_fingerprint,
        binding.field_receipt_sha256,
        binding.package_sha256,
        binding.execution_inventory_sha256,
        binding.installed_execution_inventory_sha256,
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
      ]) ||
      binding.execution_approval_fingerprint !==
        legacyDisposableRecoveryDeploymentApprovalFingerprint(binding)) {
    refuse("DISPOSABLE_RECOVERY_LEGACY_BINDING_INVALID");
  }
  return immutableClone(binding);
}

function assertLegacyVersion(value, mode, code) {
  const fields = [
    "version_id", "mode", "script_etag", "bindings_sha256",
    "bindings_without_mode_sha256", "code_exact", "bindings_exact",
    "resources_exact", "compatibility_date", "handlers",
  ];
  if (!exactKeys(value, fields) || !UUID_RE.test(String(value.version_id || "")) ||
      value.mode !== mode || !opaqueProviderValue(value.script_etag) ||
      !hashes([value.bindings_sha256, value.bindings_without_mode_sha256]) ||
      value.code_exact !== true || value.bindings_exact !== true ||
      value.resources_exact !== true ||
      value.compatibility_date !== "2026-01-01" ||
      !Array.isArray(value.handlers) || value.handlers.length !== 2 ||
      [...value.handlers].sort().join(",") !== "fetch,scheduled") {
    refuse(code);
  }
  return immutableClone(value);
}

function assertLegacyResource(value, fingerprint, code) {
  const fields = [
    "resource_fingerprint", "worker_exists", "d1_exists", "vectorize_exists",
    "d1_name_and_id_exact", "vectorize_name_exact", "vector_dimensions",
    "vector_metric", "workers_dev_enabled", "routes_count",
    "custom_domains_count", "provider_readback",
  ];
  if (!exactKeys(value, fields) || value.resource_fingerprint !== fingerprint ||
      value.worker_exists !== true || value.d1_exists !== true ||
      value.vectorize_exists !== true || value.d1_name_and_id_exact !== true ||
      value.vectorize_name_exact !== true || value.vector_dimensions !== 768 ||
      value.vector_metric !== "cosine" || value.workers_dev_enabled !== true ||
      value.routes_count !== 0 || value.custom_domains_count !== 0 ||
      value.provider_readback !== true) {
    refuse(code);
  }
  return immutableClone(value);
}

/** Validate one historical combined fixture without making it executable. */
export function assertLegacyDisposableRecoveryDeploymentReceipt(receipt) {
  const code = "DISPOSABLE_RECOVERY_LEGACY_RECEIPT_INVALID";
  const binding = assertLegacyDisposableRecoveryDeploymentBinding(receipt?.binding);
  const fields = [
    "schema_version", "protocol", "status", "completed_at", "campaign",
    "binding", "source", "target", "execution", "proof_boundary",
  ];
  if (!exactKeys(receipt, fields) || receipt.schema_version !== 1 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_LEGACY_DEPLOYMENT_PROTOCOL ||
      receipt.status !== "passed" || !validIso(receipt.completed_at) ||
      !exactKeys(receipt.campaign, [
        "release", "client_slug", "source_resource", "target_resource",
      ]) || receipt.campaign.release !== PRODUCT_VERSION ||
      receipt.campaign.client_slug !== CLIENT_SLUG ||
      receipt.campaign.source_resource !== SOURCE_RESOURCE ||
      receipt.campaign.target_resource !== TARGET_RESOURCE) {
    refuse(code);
  }
  if (!exactKeys(receipt.source, [
    "resource_fingerprint", "active_version", "active_traffic_percent",
    "resource_contract",
  ]) ||
      receipt.source.resource_fingerprint !==
        binding.source_resource_fingerprint ||
      receipt.source.active_traffic_percent !== 100 ||
      !exactKeys(receipt.target, [
        "resource_fingerprint", "initially_paused", "paused_version",
        "active_version", "paused_traffic_percent", "active_not_promoted",
        "resource_contract",
      ]) ||
      receipt.target.resource_fingerprint !==
        binding.target_resource_fingerprint ||
      receipt.target.initially_paused !== true ||
      receipt.target.paused_traffic_percent !== 100 ||
      receipt.target.active_not_promoted !== true) {
    refuse(code);
  }
  const sourceVersion = assertLegacyVersion(
    receipt.source.active_version,
    "active",
    code,
  );
  const pausedVersion = assertLegacyVersion(
    receipt.target.paused_version,
    "paused-for-upgrade",
    code,
  );
  const activeVersion = assertLegacyVersion(
    receipt.target.active_version,
    "active",
    code,
  );
  assertLegacyResource(
    receipt.source.resource_contract,
    binding.source_resource_fingerprint,
    code,
  );
  assertLegacyResource(
    receipt.target.resource_contract,
    binding.target_resource_fingerprint,
    code,
  );
  if (sourceVersion.version_id === pausedVersion.version_id ||
      sourceVersion.version_id === activeVersion.version_id ||
      pausedVersion.version_id === activeVersion.version_id ||
      pausedVersion.bindings_sha256 === activeVersion.bindings_sha256 ||
      pausedVersion.bindings_without_mode_sha256 !==
        activeVersion.bindings_without_mode_sha256) {
    refuse(code);
  }
  if (!exactKeys(receipt.execution, [
    "provider_calls", "fresh_wrapper_copy_per_call",
    "copied_package_source_per_call", "materialized_runtime_per_call",
    "revalidated_before_and_after_each_call",
    "package_execution_inventory_sha256", "wrangler_wrapper_sha256",
    "wrangler_runtime_inventory_sha256", "wrangler_entrypoint_sha256",
    "node_executable_sha256",
  ]) || receipt.execution.provider_calls !== 12 ||
      receipt.execution.fresh_wrapper_copy_per_call !== true ||
      receipt.execution.copied_package_source_per_call !== true ||
      receipt.execution.materialized_runtime_per_call !== true ||
      receipt.execution.revalidated_before_and_after_each_call !== true ||
      receipt.execution.package_execution_inventory_sha256 !==
        binding.execution_inventory_sha256 ||
      receipt.execution.wrangler_wrapper_sha256 !==
        binding.wrangler_wrapper_sha256 ||
      receipt.execution.wrangler_runtime_inventory_sha256 !==
        binding.wrangler_runtime_inventory_sha256 ||
      receipt.execution.wrangler_entrypoint_sha256 !==
        binding.wrangler_entrypoint_sha256 ||
      receipt.execution.node_executable_sha256 !==
        binding.node_executable_sha256) {
    refuse(code);
  }
  if (!exactKeys(receipt.proof_boundary, [
    "aggregate_only", "synthetic_disposable_only", "exact_package_proven",
    "exact_provider_readback_proven", "source_active_proven",
    "target_paused_proven", "target_active_uploaded_not_promoted_proven",
    "routes_and_custom_domains_empty_proven", "recovery_run", "teardown_run",
    "release_authorized", "customer_data_read",
  ]) || receipt.proof_boundary.aggregate_only !== true ||
      receipt.proof_boundary.synthetic_disposable_only !== true ||
      receipt.proof_boundary.exact_package_proven !== true ||
      receipt.proof_boundary.exact_provider_readback_proven !== true ||
      receipt.proof_boundary.source_active_proven !== true ||
      receipt.proof_boundary.target_paused_proven !== true ||
      receipt.proof_boundary.target_active_uploaded_not_promoted_proven !== true ||
      receipt.proof_boundary.routes_and_custom_domains_empty_proven !== true ||
      receipt.proof_boundary.recovery_run !== false ||
      receipt.proof_boundary.teardown_run !== false ||
      receipt.proof_boundary.release_authorized !== false ||
      receipt.proof_boundary.customer_data_read !== false) {
    refuse(code);
  }
  return immutableClone(receipt);
}

export const DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN = Object.freeze({
  productVersion: PRODUCT_VERSION,
  clientSlug: CLIENT_SLUG,
  sourceResource: SOURCE_RESOURCE,
  targetResource: TARGET_RESOURCE,
  packageFilename: PACKAGE_NAME,
  wranglerVersion: WRANGLER_VERSION,
});
