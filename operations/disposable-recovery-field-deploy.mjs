/**
 * Provider-neutral producer for the fixed v0.4.8 disposable deployment proof.
 *
 * No executable Cloudflare provider ships for this interface. The remaining
 * provider must split A2 source deployment from A4 target deployment and bind
 * raw readback plus an ambiguity journal before this core can be field-enabled.
 * The injected provider seam exists for bounded contract tests only.
 */

import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN,
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DisposableRecoveryDeploymentReceiptError,
  assertDisposableRecoveryDeploymentBinding,
  assertDisposableRecoveryDeploymentReceipt,
  readDisposableRecoveryDeploymentReceipt,
} from "./disposable-recovery-deployment-receipt.mjs";
import {
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  reservePrivateAggregateReceipt,
  validatePrivateAggregateReceiptReservation,
} from "./private-aggregate-receipt.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SOURCE_TAG = "v048-field-source-active";
const TARGET_PAUSED_TAG = "v048-field-target-paused";
const TARGET_ACTIVE_TAG = "v048-field-target-active";

export const DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY = false;

export class DisposableRecoveryFieldDeploymentError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldDeploymentError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldDeploymentError(code);
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

function providerRequest(binding, operation, role, mode = null, extra = {}) {
  const resourceFingerprint = role === "source"
    ? binding.source_resource_fingerprint
    : binding.target_resource_fingerprint;
  return Object.freeze({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    operation,
    role,
    mode,
    resource_fingerprint: resourceFingerprint,
    package_filename: binding.package_filename,
    package_sha256: binding.package_sha256,
    package_execution_inventory_sha256: binding.execution_inventory_sha256,
    source_entrypoint: "worker/src/index.js",
    compatibility_date: "2026-01-01",
    ...extra,
  });
}

function assertExecution(value, binding) {
  const fields = [
    "schema_version", "fresh_call_directory", "fresh_wrapper_copy",
    "copied_package_source", "package_execution_inventory_sha256",
    "wrangler_wrapper_sha256", "wrangler_runtime_inventory_sha256",
    "wrangler_entrypoint_sha256", "node_executable_sha256",
    "source_revalidated_before_and_after", "wrapper_revalidated_before_and_after",
    "runtime_revalidated_before_and_after",
  ];
  if (!exactKeys(value, fields) || value.schema_version !== 1 ||
      value.fresh_call_directory !== true || value.fresh_wrapper_copy !== true ||
      value.copied_package_source !== true ||
      value.package_execution_inventory_sha256 !== binding.execution_inventory_sha256 ||
      value.wrangler_wrapper_sha256 !== binding.wrangler_wrapper_sha256 ||
      value.wrangler_runtime_inventory_sha256 !==
        binding.wrangler_runtime_inventory_sha256 ||
      value.wrangler_entrypoint_sha256 !== binding.wrangler_entrypoint_sha256 ||
      value.node_executable_sha256 !== binding.node_executable_sha256 ||
      value.source_revalidated_before_and_after !== true ||
      value.wrapper_revalidated_before_and_after !== true ||
      value.runtime_revalidated_before_and_after !== true) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTION_UNPROVEN");
  }
  return true;
}

function assertEnvelope(envelope, binding) {
  if (!exactKeys(envelope, ["execution", "value"])) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_RESPONSE_INVALID");
  }
  assertExecution(envelope.execution, binding);
  return envelope.value;
}

function versionId(value) {
  if (!exactKeys(value, ["version_id"]) || !UUID_RE.test(String(value.version_id || ""))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_UPLOAD_UNCONFIRMED");
  }
  return value.version_id;
}

function versionReadback(value, role, mode, expectedId) {
  const fields = [
    "version_id", "mode", "script_etag", "bindings_sha256",
    "bindings_without_mode_sha256", "code_exact", "bindings_exact",
    "resources_exact", "compatibility_date", "handlers",
  ];
  if (!exactKeys(value, fields) || value.version_id !== expectedId ||
      value.mode !== mode || typeof value.script_etag !== "string" ||
      value.script_etag.length < 1 || value.script_etag.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value.script_etag) ||
      !SHA256_RE.test(String(value.bindings_sha256 || "")) ||
      !SHA256_RE.test(String(value.bindings_without_mode_sha256 || "")) ||
      value.code_exact !== true || value.bindings_exact !== true ||
      value.resources_exact !== true || value.compatibility_date !== "2026-01-01" ||
      !Array.isArray(value.handlers) || value.handlers.length !== 2 ||
      [...value.handlers].sort().join(",") !== "fetch,scheduled") {
    refuse(role === "source"
      ? "DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_VERSION_INVALID"
      : "DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_VERSION_INVALID");
  }
  return Object.freeze(structuredClone(value));
}

function deploymentAccepted(value) {
  if (!exactKeys(value, ["accepted"]) || value.accepted !== true) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_MUTATION_UNCONFIRMED");
  }
  return true;
}

function deploymentReadback(value, expectedVersionId) {
  if (!exactKeys(value, ["versions"]) || !Array.isArray(value.versions) ||
      value.versions.length !== 1 ||
      !exactKeys(value.versions[0], ["version_id", "percentage"]) ||
      value.versions[0].version_id !== expectedVersionId ||
      value.versions[0].percentage !== 100) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TRAFFIC_INVALID");
  }
  return true;
}

function resourceReadback(value, expectedFingerprint) {
  const fields = [
    "resource_fingerprint", "worker_exists", "d1_exists", "vectorize_exists",
    "d1_name_and_id_exact", "vectorize_name_exact", "vector_dimensions",
    "vector_metric", "workers_dev_enabled", "routes_count",
    "custom_domains_count", "provider_readback",
  ];
  if (!exactKeys(value, fields) || value.resource_fingerprint !== expectedFingerprint ||
      value.worker_exists !== true || value.d1_exists !== true ||
      value.vectorize_exists !== true || value.d1_name_and_id_exact !== true ||
      value.vectorize_name_exact !== true || value.vector_dimensions !== 768 ||
      value.vector_metric !== "cosine" || value.workers_dev_enabled !== true ||
      value.routes_count !== 0 || value.custom_domains_count !== 0 ||
      value.provider_readback !== true) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RESOURCE_INVALID");
  }
  return Object.freeze(structuredClone(value));
}

function assertProvider(provider) {
  const methods = [
    "uploadVersion", "readVersion", "deployVersion", "readDeployment",
    "readResourceContract",
  ];
  if (!provider || typeof provider !== "object" || Array.isArray(provider) ||
      Object.keys(provider).length !== methods.length ||
      methods.some((method) => typeof provider[method] !== "function")) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_INVALID");
  }
  return provider;
}

async function callProvider(provider, method, request, binding, beforeBoundary) {
  await beforeBoundary();
  let envelope;
  try { envelope = await provider[method](request); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_AMBIGUOUS"); }
  await beforeBoundary();
  return assertEnvelope(envelope, binding);
}

function uploadRequest(binding, role, mode, tag) {
  return providerRequest(binding, "upload_version", role, mode, {
    tag,
    message: `Financial Brain ${DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN.productVersion} ` +
      `disposable recovery ${role} ${mode}`,
    deploy_after_upload: false,
  });
}

function readVersionRequest(binding, role, mode, id) {
  return providerRequest(binding, "read_version", role, mode, { version_id: id });
}

function deployRequest(binding, role, mode, id) {
  return providerRequest(binding, "deploy_version", role, mode, {
    version_id: id,
    percentage: 100,
  });
}

function readDeploymentRequest(binding, role) {
  return providerRequest(binding, "read_deployment", role);
}

function readResourceRequest(binding, role) {
  return providerRequest(binding, "read_resource_contract", role);
}

/**
 * Reserve, execute the fixed source/target sequence, and durably finalize only
 * after independent version, traffic, resource, route, and domain readback.
 */
export async function runDisposableRecoveryFieldDeployment({
  binding: bindingInput,
  receiptPath,
  expectedReceiptDirectory,
  createProvider,
  revalidate = () => true,
  now = () => new Date(),
}, dependencies = {}) {
  if (process.platform !== "darwin") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_MACOS_REQUIRED");
  }
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  if (typeof createProvider !== "function" || typeof revalidate !== "function" ||
      typeof now !== "function") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_DEPENDENCY_INVALID");
  }
  const assertOutput = dependencies.assertOutput ?? assertPrivateAggregateOutputPath;
  const reserve = dependencies.reserve ?? reservePrivateAggregateReceipt;
  const validateReservation = dependencies.validateReservation ??
    validatePrivateAggregateReceiptReservation;
  const finalize = dependencies.finalize ?? finalizePrivateAggregateReceipt;
  const abandon = dependencies.abandon ?? abandonPrivateAggregateReceipt;
  const readReceipt = dependencies.readReceipt ?? readDisposableRecoveryDeploymentReceipt;

  if (await revalidate() !== true) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_EVIDENCE_CHANGED");
  }
  const output = assertOutput(resolve(receiptPath));
  let expectedDirectory;
  try { expectedDirectory = realpathSync(resolve(expectedReceiptDirectory)); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_PATH_INVALID"); }
  if (output.path !== join(expectedDirectory, DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME) ||
      output.parent.path !== expectedDirectory) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_PATH_INVALID");
  }

  const marker = Object.freeze({
    schema_version: 1,
    kind: "v048_disposable_recovery_deployment_pending",
    status: "provider_result_unconfirmed",
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    binding,
    sequence: Object.freeze([
      "source_active_upload_and_deploy",
      "target_paused_and_active_upload",
      "target_paused_deploy",
      "exact_provider_readback",
    ]),
  });
  let reservation = null;
  let finalized = false;
  try {
    reservation = reserve(output, marker);
    const beforeBoundary = async () => {
      if (await revalidate() !== true) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_EVIDENCE_CHANGED");
      }
      validateReservation(reservation, {
        code: "DISPOSABLE_RECOVERY_DEPLOYMENT_RESERVATION_CHANGED",
      });
      return true;
    };
    await beforeBoundary();
    const provider = assertProvider(await createProvider(beforeBoundary, { binding }));

    let calls = 0;
    const call = async (method, request) => {
      const value = await callProvider(provider, method, request, binding, beforeBoundary);
      calls += 1;
      return value;
    };

    const sourceUploadedId = versionId(await call(
      "uploadVersion", uploadRequest(binding, "source", "active", SOURCE_TAG),
    ));
    const sourceActive = versionReadback(await call(
      "readVersion", readVersionRequest(binding, "source", "active", sourceUploadedId),
    ), "source", "active", sourceUploadedId);
    deploymentAccepted(await call(
      "deployVersion", deployRequest(binding, "source", "active", sourceActive.version_id),
    ));
    deploymentReadback(await call(
      "readDeployment", readDeploymentRequest(binding, "source"),
    ), sourceActive.version_id);
    const sourceResource = resourceReadback(await call(
      "readResourceContract", readResourceRequest(binding, "source"),
    ), binding.source_resource_fingerprint);

    const pausedUploadedId = versionId(await call(
      "uploadVersion", uploadRequest(binding, "target", "paused-for-upgrade", TARGET_PAUSED_TAG),
    ));
    const targetPaused = versionReadback(await call(
      "readVersion",
      readVersionRequest(binding, "target", "paused-for-upgrade", pausedUploadedId),
    ), "target", "paused-for-upgrade", pausedUploadedId);
    const activeUploadedId = versionId(await call(
      "uploadVersion", uploadRequest(binding, "target", "active", TARGET_ACTIVE_TAG),
    ));
    const targetActive = versionReadback(await call(
      "readVersion", readVersionRequest(binding, "target", "active", activeUploadedId),
    ), "target", "active", activeUploadedId);
    if (targetPaused.version_id === targetActive.version_id ||
        targetPaused.bindings_sha256 === targetActive.bindings_sha256 ||
        targetPaused.bindings_without_mode_sha256 !==
          targetActive.bindings_without_mode_sha256) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_PAIR_INVALID");
    }
    deploymentAccepted(await call(
      "deployVersion",
      deployRequest(binding, "target", "paused-for-upgrade", targetPaused.version_id),
    ));
    deploymentReadback(await call(
      "readDeployment", readDeploymentRequest(binding, "target"),
    ), targetPaused.version_id);
    const targetResource = resourceReadback(await call(
      "readResourceContract", readResourceRequest(binding, "target"),
    ), binding.target_resource_fingerprint);

    if (calls !== 12) refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_CALL_SEQUENCE_INVALID");
    let completedAt;
    try { completedAt = new Date(now()).toISOString(); }
    catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_CLOCK_INVALID"); }
    const receipt = {
      schema_version: 1,
      protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
      status: "passed",
      completed_at: completedAt,
      campaign: {
        release: DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN.productVersion,
        client_slug: DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN.clientSlug,
        source_resource: DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN.sourceResource,
        target_resource: DISPOSABLE_RECOVERY_DEPLOYMENT_CAMPAIGN.targetResource,
      },
      binding,
      source: {
        resource_fingerprint: binding.source_resource_fingerprint,
        active_version: sourceActive,
        active_traffic_percent: 100,
        resource_contract: sourceResource,
      },
      target: {
        resource_fingerprint: binding.target_resource_fingerprint,
        initially_paused: true,
        paused_version: targetPaused,
        active_version: targetActive,
        paused_traffic_percent: 100,
        active_not_promoted: true,
        resource_contract: targetResource,
      },
      execution: {
        provider_calls: calls,
        fresh_wrapper_copy_per_call: true,
        copied_package_source_per_call: true,
        materialized_runtime_per_call: true,
        revalidated_before_and_after_each_call: true,
        package_execution_inventory_sha256: binding.execution_inventory_sha256,
        wrangler_wrapper_sha256: binding.wrangler_wrapper_sha256,
        wrangler_runtime_inventory_sha256: binding.wrangler_runtime_inventory_sha256,
        wrangler_entrypoint_sha256: binding.wrangler_entrypoint_sha256,
        node_executable_sha256: binding.node_executable_sha256,
      },
      proof_boundary: {
        aggregate_only: true,
        synthetic_disposable_only: true,
        exact_package_proven: true,
        exact_provider_readback_proven: true,
        source_active_proven: true,
        target_paused_proven: true,
        target_active_uploaded_not_promoted_proven: true,
        routes_and_custom_domains_empty_proven: true,
        recovery_run: false,
        teardown_run: false,
        release_authorized: false,
        customer_data_read: false,
      },
    };
    assertDisposableRecoveryDeploymentReceipt(receipt);
    await beforeBoundary();
    if (finalize(reservation, receipt) !== true) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_FINALIZATION_FAILED");
    }
    finalized = true;
    const readback = readReceipt(output.path);
    assertDisposableRecoveryDeploymentReceipt(readback.value);
    if (canonical(readback.value) !== canonical(receipt)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_READBACK_FAILED");
    }
    return Object.freeze({ receipt: Object.freeze(receipt), receiptSha256: readback.sha256 });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldDeploymentError ||
        error instanceof DisposableRecoveryDeploymentReceiptError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_FAILED");
  } finally {
    if (reservation && !finalized) abandon(reservation);
  }
}

/** Pure fixed request list for review and an injected pinned-provider adapter. */
export function disposableRecoveryDeploymentRequestPlan(bindingInput) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  return Object.freeze([
    uploadRequest(binding, "source", "active", SOURCE_TAG),
    providerRequest(binding, "read_version", "source", "active"),
    providerRequest(binding, "deploy_version", "source", "active"),
    readDeploymentRequest(binding, "source"),
    readResourceRequest(binding, "source"),
    uploadRequest(binding, "target", "paused-for-upgrade", TARGET_PAUSED_TAG),
    providerRequest(binding, "read_version", "target", "paused-for-upgrade"),
    uploadRequest(binding, "target", "active", TARGET_ACTIVE_TAG),
    providerRequest(binding, "read_version", "target", "active"),
    providerRequest(binding, "deploy_version", "target", "paused-for-upgrade"),
    readDeploymentRequest(binding, "target"),
    readResourceRequest(binding, "target"),
  ]);
}
