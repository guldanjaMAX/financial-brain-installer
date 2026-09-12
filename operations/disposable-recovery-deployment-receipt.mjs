/**
 * Strict private receipt for the fixed v0.4.8 disposable Worker deployment.
 *
 * This module deliberately has no Cloudflare adapter import. The recovery
 * adapter can consume the receipt without creating a dependency cycle, while
 * the mutating producer remains a separate, explicitly injected field tool.
 */

import { createHash } from "node:crypto";

import { readPrivateAggregateReceipt } from "./private-aggregate-receipt.mjs";

export const DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL =
  "v048-disposable-recovery-deployment-v1";
export const DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME =
  "v048-disposable-deployment-receipt.json";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,127}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FIELD_RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu;
const PACKAGE_NAME = "brain-installer-0.4.8.tgz";
const PRODUCT_VERSION = "0.4.8";
const WRANGLER_VERSION = "4.127.1";
const CLIENT_SLUG = "v048-field-proof";
const SOURCE_RESOURCE = "brain-test-v048-field-source-recovery-gate-a48f1101";
const TARGET_RESOURCE = "brain-test-v048-field-target-recovery-gate-a48f1102";

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

function exactKeys(value, fields) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validIso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}

function hashes(values) {
  return values.every((value) => SHA256_RE.test(String(value || "")));
}

function opaqueProviderEtag(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    !CONTROL_RE.test(value);
}

export function disposableRecoveryDeploymentApprovalFingerprint(bindingInput) {
  if (!bindingInput || typeof bindingInput !== "object" || Array.isArray(bindingInput)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID");
  }
  const binding = structuredClone(bindingInput);
  delete binding.execution_approval_fingerprint;
  return sha256(canonical({
    schema_version: 1,
    purpose: "deploy_exact_v048_disposable_recovery_workers",
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    source_resource: SOURCE_RESOURCE,
    target_resource: TARGET_RESOURCE,
    source_mode: "active",
    target_initial_mode: "paused-for-upgrade",
    target_active_version_uploaded_not_promoted: true,
    binding,
  }));
}

/** Validate the private package, plan, manifest, runtime, and wrapper binding. */
export function assertDisposableRecoveryDeploymentBinding(binding) {
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
      !FIELD_RUN_ID_RE.test(String(binding.field_receipt_run_id || "")) ||
      binding.package_filename !== PACKAGE_NAME ||
      !Number.isSafeInteger(binding.package_bytes) || binding.package_bytes < 1 ||
      !Number.isSafeInteger(binding.package_file_count) || binding.package_file_count < 1 ||
      binding.execution_inventory_sha256 !== binding.installed_execution_inventory_sha256 ||
      binding.wrangler_version !== WRANGLER_VERSION ||
      !/^v(?:22|2[3-9]|[3-9][0-9])\.[0-9]+\.[0-9]+$/u.test(String(binding.node_version || "")) ||
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
      ]) || binding.execution_approval_fingerprint !==
        disposableRecoveryDeploymentApprovalFingerprint(binding)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID");
  }
  return Object.freeze(structuredClone(binding));
}

function assertVersion(value, mode, code) {
  const fields = [
    "version_id", "mode", "script_etag", "bindings_sha256",
    "bindings_without_mode_sha256", "code_exact", "bindings_exact",
    "resources_exact", "compatibility_date", "handlers",
  ];
  if (!exactKeys(value, fields) || !UUID_RE.test(String(value.version_id || "")) ||
      value.mode !== mode || !opaqueProviderEtag(value.script_etag) || !hashes([
        value.bindings_sha256,
        value.bindings_without_mode_sha256,
      ]) || value.code_exact !== true || value.bindings_exact !== true ||
      value.resources_exact !== true || value.compatibility_date !== "2026-01-01" ||
      !Array.isArray(value.handlers) || value.handlers.length !== 2 ||
      [...value.handlers].sort().join(",") !== "fetch,scheduled") {
    refuse(code);
  }
  return Object.freeze(structuredClone(value));
}

function assertResource(value, fingerprint, code) {
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
  return Object.freeze(structuredClone(value));
}

/** Strictly validate one finalized deployment receipt. */
export function assertDisposableRecoveryDeploymentReceipt(receipt) {
  const binding = assertDisposableRecoveryDeploymentBinding(receipt?.binding);
  const fields = [
    "schema_version", "protocol", "status", "completed_at", "campaign",
    "binding", "source", "target", "execution", "proof_boundary",
  ];
  if (!exactKeys(receipt, fields) || receipt.schema_version !== 1 ||
      receipt.protocol !== DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL ||
      receipt.status !== "passed" || !validIso(receipt.completed_at) ||
      !exactKeys(receipt.campaign, [
        "release", "client_slug", "source_resource", "target_resource",
      ]) || receipt.campaign.release !== PRODUCT_VERSION ||
      receipt.campaign.client_slug !== CLIENT_SLUG ||
      receipt.campaign.source_resource !== SOURCE_RESOURCE ||
      receipt.campaign.target_resource !== TARGET_RESOURCE) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID");
  }
  const sourceFields = [
    "resource_fingerprint", "active_version", "active_traffic_percent",
    "resource_contract",
  ];
  const targetFields = [
    "resource_fingerprint", "initially_paused", "paused_version", "active_version",
    "paused_traffic_percent", "active_not_promoted", "resource_contract",
  ];
  if (!exactKeys(receipt.source, sourceFields) ||
      receipt.source.resource_fingerprint !== binding.source_resource_fingerprint ||
      receipt.source.active_traffic_percent !== 100 ||
      !exactKeys(receipt.target, targetFields) ||
      receipt.target.resource_fingerprint !== binding.target_resource_fingerprint ||
      receipt.target.initially_paused !== true ||
      receipt.target.paused_traffic_percent !== 100 ||
      receipt.target.active_not_promoted !== true) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID");
  }
  const sourceVersion = assertVersion(
    receipt.source.active_version,
    "active",
    "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID",
  );
  const pausedVersion = assertVersion(
    receipt.target.paused_version,
    "paused-for-upgrade",
    "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID",
  );
  const activeVersion = assertVersion(
    receipt.target.active_version,
    "active",
    "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID",
  );
  assertResource(
    receipt.source.resource_contract,
    binding.source_resource_fingerprint,
    "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID",
  );
  assertResource(
    receipt.target.resource_contract,
    binding.target_resource_fingerprint,
    "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID",
  );
  if (sourceVersion.version_id === pausedVersion.version_id ||
      sourceVersion.version_id === activeVersion.version_id ||
      pausedVersion.version_id === activeVersion.version_id ||
      pausedVersion.bindings_sha256 === activeVersion.bindings_sha256 ||
      pausedVersion.bindings_without_mode_sha256 !==
        activeVersion.bindings_without_mode_sha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID");
  }
  if (!exactKeys(receipt.execution, [
    "provider_calls", "fresh_wrapper_copy_per_call", "copied_package_source_per_call",
    "materialized_runtime_per_call", "revalidated_before_and_after_each_call",
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
      receipt.execution.wrangler_wrapper_sha256 !== binding.wrangler_wrapper_sha256 ||
      receipt.execution.wrangler_runtime_inventory_sha256 !==
        binding.wrangler_runtime_inventory_sha256 ||
      receipt.execution.wrangler_entrypoint_sha256 !==
        binding.wrangler_entrypoint_sha256 ||
      receipt.execution.node_executable_sha256 !== binding.node_executable_sha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID");
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
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID");
  }
  return Object.freeze(structuredClone(receipt));
}

/** Read one final-only owner receipt and reject any pending marker or drift. */
export function readDisposableRecoveryDeploymentReceipt(path, dependencies = {}) {
  const readReceipt = dependencies.readReceipt ?? readPrivateAggregateReceipt;
  let loaded;
  try {
    loaded = readReceipt(path, {
      code: "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_READ_FAILED",
    });
    assertDisposableRecoveryDeploymentReceipt(loaded.value);
  } catch (error) {
    if (error instanceof DisposableRecoveryDeploymentReceiptError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_READ_FAILED");
  }
  return Object.freeze({
    value: Object.freeze(structuredClone(loaded.value)),
    sha256: loaded.sha256,
    info: loaded.info,
  });
}

export const DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN = Object.freeze({
  productVersion: PRODUCT_VERSION,
  clientSlug: CLIENT_SLUG,
  sourceResource: SOURCE_RESOURCE,
  targetResource: TARGET_RESOURCE,
  packageFilename: PACKAGE_NAME,
  wranglerVersion: WRANGLER_VERSION,
});
