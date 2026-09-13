/**
 * Provider-neutral phased producer for the fixed v0.4.8 disposable proof.
 *
 * This core has no credential, network, account, provisioning, teardown, or
 * release authority. An injected adapter may translate the closed semantic
 * requests below into the reviewed transport only after a phase receipt has
 * been reserved. Source deployment, synthetic seeding, and target deployment
 * remain separate approval and receipt boundaries.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  DisposableRecoveryDeploymentReceiptError,
  assertDisposableRecoveryDeploymentBinding,
  assertDisposableRecoveryDeploymentReceiptChain,
  assertDisposableRecoverySourcePhaseReceipt,
  assertDisposableRecoverySourcePreflightReceipt,
  assertDisposableRecoveryTargetPhaseReceipt,
  assertDisposableRecoveryTargetPreflightReceipt,
  disposableRecoverySourceA2Fingerprint,
  disposableRecoveryTargetA4Fingerprint,
  readDisposableRecoveryDeploymentReceipt,
  readDisposableRecoverySourcePhaseReceipt,
  readDisposableRecoverySourcePreflightReceipt,
  readDisposableRecoveryTargetPreflightReceipt,
} from "./disposable-recovery-deployment-receipt.mjs";
import {
  DisposableRecoveryDeploymentJournalError,
  disposableRecoveryDeploymentJournalSha256,
  readDisposableRecoveryDeploymentJournal,
  runJournaledDisposableRecoveryDeploymentMutation,
  summarizeDisposableRecoveryDeploymentJournal,
} from "./disposable-recovery-deployment-journal.mjs";
import {
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  assertDisposableRecoverySeedReceipt,
} from "./disposable-recovery-seeder.mjs";
import {
  PrivateAggregateReceiptError,
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateReceiptDirectory,
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptPendingPath,
  readPrivateAggregateReceipt,
  reservePrivateAggregateReceipt,
  resumePrivateAggregateReceiptReservation,
  validatePrivateAggregateReceiptReservation,
} from "./private-aggregate-receipt.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const OPERATION_RE = /^[a-z][a-z0-9_]{0,63}$/u;
const COMPATIBILITY_DATE = "2026-01-01";
const SOURCE_TAG = "v048-field-source-active";
const TARGET_PAUSED_TAG = "v048-field-target-paused";
const TARGET_ACTIVE_TAG = "v048-field-target-active";
const SEED_RECEIPT_NAME = "v048-disposable-seed-receipt.json";
const MAX_SEED_RECEIPT_BYTES = 2 * 1024 * 1024;

export const DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME =
  "v048-disposable-source-deployment-journal.jsonl";
export const DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME =
  "v048-disposable-target-deployment-journal.jsonl";

// The provider and split command entry point are present in the package. This
// marker is deliberately narrower: it flips only after the exact packaged
// path completes the reviewed live disposable proof. Local/fixture execution
// is not field proof.
export const DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ENTRYPOINT_AVAILABLE = true;
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
    keys.every((field) => descriptors[field].enumerable === true &&
      Object.hasOwn(descriptors[field], "value"));
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_VALUE_INVALID");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.keys(descriptors).length !== value.length + 1 ||
        !Object.hasOwn(descriptors, "length")) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_VALUE_INVALID");
    }
    const values = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, "value")) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_VALUE_INVALID");
      }
      values.push(canonicalValue(descriptor.value, seen));
    }
    return `[${values.join(",")}]`;
  }
  if (!plainObject(value) || seen.has(value)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_VALUE_INVALID");
  }
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields = Reflect.ownKeys(descriptors);
    if (fields.some((field) => typeof field !== "string" ||
        descriptors[field].enumerable !== true ||
        !Object.hasOwn(descriptors[field], "value"))) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_VALUE_INVALID");
    }
    return `{${fields.sort().map((field) =>
      `${JSON.stringify(field)}:${canonicalValue(descriptors[field].value, seen)}`
    ).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function canonical(value) {
  return canonicalValue(value);
}

function immutableClone(value) {
  const clone = JSON.parse(canonical(value));
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
    return item;
  };
  return freeze(clone);
}

function sha256(value) {
  return disposableRecoveryDeploymentJournalSha256(value);
}

function hash(value) {
  if (!SHA256_RE.test(String(value || ""))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_HASH_INVALID");
  }
  return value;
}

function providerId(value) {
  if (!PROVIDER_ID_RE.test(String(value || ""))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ID_INVALID");
  }
  return value;
}

function etag(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
      CONTROL_RE.test(value)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ETAG_INVALID");
  }
  return value;
}

function completionTime(now) {
  let value;
  try { value = new Date(now()).toISOString(); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_CLOCK_INVALID"); }
  return value;
}

function sameValue(left, right) {
  return canonical(left) === canonical(right);
}

function sameBinding(left, right) {
  return sha256(left) === sha256(right);
}

function assertExpectedDirectory(path) {
  try { return realpathSync(resolve(path)); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_PATH_INVALID"); }
}

function assertArtifactPath(path, directory, name, code) {
  const absolute = resolve(path);
  if (dirname(absolute) !== directory || basename(absolute) !== name) refuse(code);
  return absolute;
}

function assertModuleInventorySha256(value) {
  return hash(value);
}

function requestBase(binding, phase, operation, role, mode) {
  return {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    phase,
    operation,
    role,
    mode,
    campaign_fingerprint: binding.campaign_fingerprint,
    package_sha256: binding.package_sha256,
    runtime_contract_fingerprint: binding.runtime_contract_fingerprint,
    resource_fingerprint: role === "source"
      ? binding.source_resource_fingerprint
      : binding.target_resource_fingerprint,
  };
}

/**
 * Return the complete non-secret mutation plan. Raw modules, bindings,
 * credentials, account IDs, and provider paths never enter this value.
 */
export function disposableRecoveryDeploymentRequestPlan(
  bindingInput,
  moduleInventorySha256Input,
) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  const moduleInventorySha256 =
    assertModuleInventorySha256(moduleInventorySha256Input);
  const upload = (phase, role, mode, tag) => Object.freeze({
    ...requestBase(binding, phase, "upload_version", role, mode),
    module_inventory_sha256: moduleInventorySha256,
    compatibility_date: COMPATIBILITY_DATE,
    handlers: Object.freeze(["fetch", "scheduled"]),
    tag,
    deploy_after_upload: false,
  });
  const deploy = (phase, role, mode, versionSelector) => Object.freeze({
    ...requestBase(binding, phase, "deploy_version", role, mode),
    version_selector: versionSelector,
    traffic_percent: 100,
    force: false,
  });
  const requests = {
    source_active_upload: upload("source", "source", "active", SOURCE_TAG),
    source_active_deployment: deploy(
      "source", "source", "active", "source_active_upload",
    ),
    target_paused_upload: upload(
      "target", "target", "paused-for-upgrade", TARGET_PAUSED_TAG,
    ),
    target_active_upload: upload(
      "target", "target", "active", TARGET_ACTIVE_TAG,
    ),
    target_paused_deployment: deploy(
      "target", "target", "paused-for-upgrade", "target_paused_upload",
    ),
  };
  return immutableClone(requests);
}

function plannedRequestHashes(requests) {
  return Object.freeze({
    source_active_upload_sha256: sha256(requests.source_active_upload),
    source_active_deployment_sha256: sha256(requests.source_active_deployment),
    target_paused_upload_sha256: sha256(requests.target_paused_upload),
    target_active_upload_sha256: sha256(requests.target_active_upload),
    target_paused_deployment_sha256: sha256(requests.target_paused_deployment),
  });
}

function assertProvider(provider) {
  const fields = ["deployVersion", "readSnapshot", "uploadVersion"];
  if (!exactKeys(provider, fields) ||
      fields.some((field) => typeof provider[field] !== "function")) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_INVALID");
  }
  return provider;
}

function assertProviderMetadata(value) {
  if (!exactKeys(value, [
    "body_sha256", "content_type", "schema_version", "status",
  ]) || value.schema_version !== 1 || value.status !== 200 ||
      !["application/json", "application/json; charset=utf-8"]
        .includes(value.content_type)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_EVIDENCE_INVALID");
  }
  hash(value.body_sha256);
  return immutableClone(value);
}

function assertUploadResult(value, expectedRequest) {
  if (!exactKeys(value, [
    "deployed", "operation", "request", "response", "schema_version",
    "script_etag", "version_id",
  ]) || value.schema_version !== 1 || value.operation !== "upload_version" ||
      value.deployed !== false ||
      (value.script_etag !== null && typeof value.script_etag !== "string") ||
      !exactKeys(value.request, [
        "bindings_sha256", "body_sha256", "metadata_sha256", "module_count",
        "module_inventory_sha256",
      ]) || !Number.isSafeInteger(value.request.module_count) ||
      value.request.module_count < 1 || value.request.module_count > 512 ||
      value.request.module_inventory_sha256 !==
        expectedRequest.module_inventory_sha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_UPLOAD_RESULT_INVALID");
  }
  providerId(value.version_id);
  for (const field of [
    "bindings_sha256", "body_sha256", "metadata_sha256",
    "module_inventory_sha256",
  ]) hash(value.request[field]);
  const providerMetadata = assertProviderMetadata(value.response);
  return Object.freeze({
    provider_metadata: providerMetadata,
    result: Object.freeze({ version_id: value.version_id }),
  });
}

function assertDeployResult(value, expectedVersionId) {
  if (!exactKeys(value, [
    "accepted", "deployment_id", "operation", "percentage", "request_body_sha256",
    "response", "schema_version", "version_id",
  ]) || value.schema_version !== 1 || value.operation !== "deploy_version" ||
      value.accepted !== true || value.percentage !== 100 ||
      value.version_id !== expectedVersionId) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_DEPLOY_RESULT_INVALID");
  }
  providerId(value.deployment_id);
  providerId(value.version_id);
  hash(value.request_body_sha256);
  const providerMetadata = assertProviderMetadata(value.response);
  return Object.freeze({
    provider_metadata: providerMetadata,
    result: Object.freeze({
      accepted: true,
      deployment_id: value.deployment_id,
      version_id: value.version_id,
    }),
  });
}

function assertResource(value, { empty }) {
  const fields = [
    "custom_domains_count", "d1_exists", "d1_name_and_id_exact",
    "previews_enabled", "routes_count", "schedules_count", "vector_count",
    "vector_dimensions", "vector_metric", "vectorize_exists",
    "vectorize_name_exact", "worker_exists", "workers_dev_enabled",
  ];
  if (!exactKeys(value, fields) || value.worker_exists !== true ||
      value.d1_exists !== true || value.vectorize_exists !== true ||
      value.d1_name_and_id_exact !== true || value.vectorize_name_exact !== true ||
      value.vector_dimensions !== 768 || value.vector_metric !== "cosine" ||
      !Number.isSafeInteger(value.vector_count) || value.vector_count < 0 ||
      value.workers_dev_enabled !== true || value.previews_enabled !== false ||
      value.routes_count !== 0 || value.custom_domains_count !== 0 ||
      !Number.isSafeInteger(value.schedules_count) || value.schedules_count < 0 ||
      value.schedules_count > 64 || (empty && value.vector_count !== 0)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RESOURCE_INVALID");
  }
  return immutableClone(value);
}

function assertVersion(value) {
  if (!exactKeys(value, [
    "bindings_sha256", "bindings_without_mode_sha256", "handlers",
    "named_handlers_count", "script_etag", "version_id",
  ]) || !Array.isArray(value.handlers) || value.handlers.length !== 2 ||
      [...value.handlers].sort().join(",") !== "fetch,scheduled" ||
      !Number.isSafeInteger(value.named_handlers_count) ||
      value.named_handlers_count < 0) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_VERSION_INVALID");
  }
  providerId(value.version_id);
  etag(value.script_etag);
  hash(value.bindings_sha256);
  hash(value.bindings_without_mode_sha256);
  return immutableClone(value);
}

function assertDeployment(value) {
  if (!exactKeys(value, [
    "deployment_id", "traffic_percent", "version_id",
  ]) || value.traffic_percent !== 100) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TRAFFIC_INVALID");
  }
  providerId(value.deployment_id);
  providerId(value.version_id);
  return immutableClone(value);
}

function assertSourcePin(value, binding, expected = null) {
  if (!exactKeys(value, [
    "active_deployment_id", "active_script_etag", "active_traffic_percent",
    "active_version_id", "resource", "resource_fingerprint",
  ]) || value.resource_fingerprint !== binding.source_resource_fingerprint ||
      value.active_traffic_percent !== 100) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_PIN_INVALID");
  }
  providerId(value.active_deployment_id);
  providerId(value.active_version_id);
  etag(value.active_script_etag);
  assertResource(value.resource, { empty: false });
  if (expected && (value.active_version_id !== expected.active_version_id ||
      value.active_script_etag !== expected.active_script_etag ||
      value.active_deployment_id !== expected.active_deployment_id)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_PIN_INVALID");
  }
  return immutableClone(value);
}

function assertBaseline(value, binding, role) {
  if (!exactKeys(value, [
    "baseline_deployment_id", "baseline_script_etag", "baseline_traffic_percent",
    "baseline_version_id", "resource", "resource_fingerprint",
  ]) || value.resource_fingerprint !== (role === "source"
    ? binding.source_resource_fingerprint
    : binding.target_resource_fingerprint) || value.baseline_traffic_percent !== 100) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_BASELINE_INVALID");
  }
  providerId(value.baseline_deployment_id);
  providerId(value.baseline_version_id);
  etag(value.baseline_script_etag);
  assertResource(value.resource, { empty: true });
  return immutableClone(value);
}

function assertSourcePreflightSemantic(value, binding) {
  if (!exactKeys(value, ["source"])) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_PREFLIGHT_INVALID");
  }
  assertBaseline(value.source, binding, "source");
  return immutableClone(value);
}

function assertSourceFinalSemantic(value, binding, sourceVersionId) {
  if (!exactKeys(value, ["source"]) || !exactKeys(value.source, [
    "active_deployment", "active_version", "resource", "resource_fingerprint",
  ]) || value.source.resource_fingerprint !== binding.source_resource_fingerprint) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_FINAL_INVALID");
  }
  const version = assertVersion(value.source.active_version);
  const deployment = assertDeployment(value.source.active_deployment);
  assertResource(value.source.resource, { empty: true });
  if (version.version_id !== sourceVersionId ||
      deployment.version_id !== sourceVersionId) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_FINAL_INVALID");
  }
  return immutableClone(value);
}

function sourceReceiptPin(sourcePhaseReceipt) {
  return Object.freeze({
    active_version_id: sourcePhaseReceipt.source.active_version.version_id,
    active_script_etag: sourcePhaseReceipt.source.active_version.script_etag,
    active_deployment_id: sourcePhaseReceipt.source.active_deployment.deployment_id,
  });
}

function assertTargetPreflightSemantic(value, binding, sourcePhaseReceipt, seedReceipt) {
  if (!exactKeys(value, ["source", "target"])) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_PREFLIGHT_INVALID");
  }
  const source = assertSourcePin(
    value.source,
    binding,
    sourceReceiptPin(sourcePhaseReceipt),
  );
  assertBaseline(value.target, binding, "target");
  if (source.resource.vector_count !== seedReceipt.projection.vectorize_vectors ||
      source.resource.vector_count < DISPOSABLE_RECOVERY_SEED_DOCUMENTS) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_PREFLIGHT_INVALID");
  }
  return immutableClone(value);
}

function assertTargetFinalSemantic(
  value,
  binding,
  sourcePhaseReceipt,
  seedReceipt,
  pausedVersionId,
  activeVersionId,
) {
  if (!exactKeys(value, ["source", "target"]) || !exactKeys(value.target, [
    "active_version", "paused_deployment", "paused_version", "resource",
    "resource_fingerprint",
  ]) || value.target.resource_fingerprint !== binding.target_resource_fingerprint) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_FINAL_INVALID");
  }
  const source = assertSourcePin(
    value.source,
    binding,
    sourceReceiptPin(sourcePhaseReceipt),
  );
  const pausedVersion = assertVersion(value.target.paused_version);
  const activeVersion = assertVersion(value.target.active_version);
  const deployment = assertDeployment(value.target.paused_deployment);
  assertResource(value.target.resource, { empty: true });
  if (source.resource.vector_count !== seedReceipt.projection.vectorize_vectors ||
      pausedVersion.version_id !== pausedVersionId ||
      activeVersion.version_id !== activeVersionId ||
      pausedVersion.version_id === activeVersion.version_id ||
      deployment.version_id !== pausedVersion.version_id ||
      pausedVersion.bindings_sha256 === activeVersion.bindings_sha256 ||
      pausedVersion.bindings_without_mode_sha256 !==
        activeVersion.bindings_without_mode_sha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_FINAL_INVALID");
  }
  return immutableClone(value);
}

function assertSnapshotEvidence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SNAPSHOT_EVIDENCE_INVALID");
  }
  const operations = new Set();
  const evidence = value.map((entry) => {
    if (!exactKeys(entry, [
      "body_sha256", "content_type", "operation", "schema_version", "status",
    ]) || !OPERATION_RE.test(String(entry.operation || "")) ||
        operations.has(entry.operation)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SNAPSHOT_EVIDENCE_INVALID");
    }
    operations.add(entry.operation);
    const providerMetadata = assertProviderMetadata({
      schema_version: entry.schema_version,
      status: entry.status,
      content_type: entry.content_type,
      body_sha256: entry.body_sha256,
    });
    return Object.freeze({ operation: entry.operation, ...providerMetadata });
  });
  return immutableClone(evidence);
}

function assertSnapshotEnvelope(value, request, semanticValidator) {
  if (!exactKeys(value, [
    "evidence", "phase", "read_ordinal", "schema_version", "semantic", "stage",
  ]) || value.schema_version !== 1 || value.phase !== request.phase ||
      value.stage !== request.stage || value.read_ordinal !== request.read_ordinal) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SNAPSHOT_INVALID");
  }
  const evidence = assertSnapshotEvidence(value.evidence);
  const semantic = semanticValidator(value.semantic);
  const rawEvidenceManifestSha256 = sha256({
    schema_version: 1,
    kind: "cloudflare_raw_evidence_manifest",
    phase: request.phase,
    stage: request.stage,
    read_ordinal: request.read_ordinal,
    evidence,
  });
  return Object.freeze({
    semantic,
    semanticSha256: sha256(semantic),
    rawEvidenceManifestSha256,
  });
}

async function doubleReadSnapshot({
  provider,
  beforeBoundary,
  binding,
  phase,
  stage,
  expected = null,
  semanticValidator,
}) {
  const reads = [];
  for (const readOrdinal of [1, 2]) {
    const request = Object.freeze({
      schema_version: 2,
      protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
      operation: "read_snapshot",
      phase,
      stage,
      read_ordinal: readOrdinal,
      campaign_fingerprint: binding.campaign_fingerprint,
      expected: immutableClone(expected),
    });
    await beforeBoundary();
    let response;
    try { response = await provider.readSnapshot(request); }
    catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_READ_FAILED"); }
    await beforeBoundary();
    reads.push(assertSnapshotEnvelope(response, request, semanticValidator));
  }
  if (reads[0].semanticSha256 !== reads[1].semanticSha256 ||
      !sameValue(reads[0].semantic, reads[1].semantic) ||
      reads[0].rawEvidenceManifestSha256 === reads[1].rawEvidenceManifestSha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SNAPSHOT_DRIFT");
  }
  return Object.freeze({
    semantic: reads[1].semantic,
    receipt: Object.freeze({
      first_raw_evidence_manifest_sha256: reads[0].rawEvidenceManifestSha256,
      second_raw_evidence_manifest_sha256: reads[1].rawEvidenceManifestSha256,
      first_semantic_sha256: reads[0].semanticSha256,
      second_semantic_sha256: reads[1].semanticSha256,
      stable_semantic_sha256: reads[1].semanticSha256,
    }),
  });
}

async function createCheckedProvider(createProvider, beforeBoundary, context) {
  if (typeof createProvider !== "function") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_INVALID");
  }
  await beforeBoundary();
  let provider;
  try { provider = await createProvider(beforeBoundary, immutableClone(context)); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_CREATION_FAILED"); }
  await beforeBoundary();
  return assertProvider(provider);
}

async function reserveAndFinalizePhase({
  binding,
  expectedReceiptDirectory,
  receiptPath,
  receiptName,
  kind,
  revalidate,
  now,
  build,
  validate,
  read,
  resume = false,
  resumeCheck = () => true,
}) {
  if (process.platform === "win32") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_POSIX_REQUIRED");
  }
  if (typeof revalidate !== "function" || typeof now !== "function" ||
      typeof build !== "function" || typeof validate !== "function" ||
      typeof read !== "function" || typeof resumeCheck !== "function" ||
      typeof resume !== "boolean") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_DEPENDENCY_INVALID");
  }
  const expectedDirectory = assertExpectedDirectory(expectedReceiptDirectory);
  const expectedPath = assertArtifactPath(
    receiptPath,
    expectedDirectory,
    receiptName,
    "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_PATH_INVALID",
  );
  let revalidated;
  try { revalidated = await revalidate(); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_EVIDENCE_CHANGED"); }
  if (revalidated !== true) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_EVIDENCE_CHANGED");
  }
  const pendingPath = privateAggregateReceiptPendingPath(expectedPath);
  if (!resume && (existsSync(expectedPath) || existsSync(pendingPath))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RESUME_REQUIRED");
  }
  if (resume && (!existsSync(expectedPath) || !existsSync(pendingPath))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RESUME_NOT_AVAILABLE");
  }
  let output;
  try {
    output = resume
      ? Object.freeze({
          path: expectedPath,
          pendingPath,
          parent: assertPrivateAggregateReceiptDirectory(expectedDirectory, {
            code: "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_PATH_INVALID",
          }),
        })
      : assertPrivateAggregateOutputPath(expectedPath);
  } catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_PATH_INVALID"); }
  const marker = Object.freeze({
    schema_version: 2,
    kind: `v048_disposable_recovery_${kind}_pending`,
    status: "provider_result_unconfirmed",
    binding,
  });
  let reservation = null;
  let finalized = false;
  try {
    try {
      reservation = resume
        ? resumePrivateAggregateReceiptReservation(output, marker)
        : reservePrivateAggregateReceipt(output, marker);
    } catch {
      refuse(resume
        ? "DISPOSABLE_RECOVERY_DEPLOYMENT_RESUME_STATE_INVALID"
        : "DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_PATH_INVALID");
    }
    const beforeBoundary = async () => {
      let current;
      try { current = await revalidate(); }
      catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_EVIDENCE_CHANGED"); }
      if (current !== true) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_EVIDENCE_CHANGED");
      }
      try {
        validatePrivateAggregateReceiptReservation(reservation, {
          code: "DISPOSABLE_RECOVERY_DEPLOYMENT_RESERVATION_CHANGED",
        });
      } catch {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RESERVATION_CHANGED");
      }
      return true;
    };
    await beforeBoundary();
    let resumable;
    try { resumable = await resumeCheck(); }
    catch (error) {
      if (error instanceof DisposableRecoveryFieldDeploymentError) throw error;
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
    }
    if (resumable !== true) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
    }
    await beforeBoundary();
    const receipt = await build({ beforeBoundary, completedAt: completionTime(now) });
    validate(receipt);
    await beforeBoundary();
    if (finalizePrivateAggregateReceipt(reservation, receipt) !== true) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_FINALIZATION_FAILED");
    }
    finalized = true;
    const loaded = read(output.path);
    validate(loaded.value);
    if (!sameValue(loaded.value, receipt)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_READBACK_FAILED");
    }
    return Object.freeze({ receipt: immutableClone(receipt), receiptSha256: loaded.sha256 });
  } finally {
    if (reservation && !finalized) abandonPrivateAggregateReceipt(reservation);
  }
}

function readSourcePreflight(path, directory) {
  const exactPath = assertArtifactPath(
    path,
    directory,
    DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
    "DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_INVALID",
  );
  try { return readDisposableRecoverySourcePreflightReceipt(exactPath); }
  catch { refuse("DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_INVALID"); }
}

function readSourcePhase(path, directory) {
  const exactPath = assertArtifactPath(
    path,
    directory,
    DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
    "DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_INVALID",
  );
  try { return readDisposableRecoverySourcePhaseReceipt(exactPath); }
  catch { refuse("DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_INVALID"); }
}

function readTargetPreflight(path, directory) {
  const exactPath = assertArtifactPath(
    path,
    directory,
    DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
    "DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_INVALID",
  );
  try { return readDisposableRecoveryTargetPreflightReceipt(exactPath); }
  catch { refuse("DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_INVALID"); }
}

function readSeed(path, directory) {
  const exactPath = assertArtifactPath(
    path,
    directory,
    SEED_RECEIPT_NAME,
    "DISPOSABLE_RECOVERY_DEPLOYMENT_SEED_RECEIPT_INVALID",
  );
  try {
    const loaded = readPrivateAggregateReceipt(exactPath, {
      code: "DISPOSABLE_RECOVERY_DEPLOYMENT_SEED_RECEIPT_INVALID",
      maxBytes: MAX_SEED_RECEIPT_BYTES,
    });
    assertDisposableRecoverySeedReceipt(loaded.value);
    return loaded;
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SEED_RECEIPT_INVALID");
  }
}

function assertSeedChain(seedLoaded, sourcePhaseLoaded, binding) {
  const seed = seedLoaded.value;
  const source = sourcePhaseLoaded.value;
  const seedBinding = seed.binding;
  if (seedBinding.source_phase_receipt_sha256 !== sourcePhaseLoaded.sha256 ||
      seedBinding.source_phase_run_id !== binding.run_id ||
      seedBinding.source_a2_approval_fingerprint !== source.a2_approval_fingerprint ||
      seedBinding.source_resource_fingerprint !== binding.source_resource_fingerprint ||
      seedBinding.source_active_version_id !== source.source.active_version.version_id ||
      seedBinding.source_script_etag !== source.source.active_version.script_etag ||
      seedBinding.source_deployment_id !== source.source.active_deployment.deployment_id ||
      seedBinding.candidate_sha !== binding.candidate_sha ||
      seedBinding.candidate_tree_sha !== binding.candidate_tree_sha ||
      seedBinding.field_receipt_sha256 !== binding.field_receipt_sha256 ||
      seedBinding.package_sha256 !== binding.package_sha256 ||
      seedBinding.package_file_count !== binding.package_file_count ||
      seedBinding.execution_inventory_sha256 !== binding.execution_inventory_sha256 ||
      seedBinding.installed_execution_inventory_sha256 !==
        binding.installed_execution_inventory_sha256 ||
      seedBinding.source_manifest_fingerprint !== binding.source_manifest_fingerprint ||
      seedBinding.runtime_contract_fingerprint !== binding.runtime_contract_fingerprint ||
      seedBinding.wrangler_wrapper_sha256 !== binding.wrangler_wrapper_sha256 ||
      seedBinding.wrangler_runtime_inventory_sha256 !==
        binding.wrangler_runtime_inventory_sha256 ||
      seedBinding.wrangler_entrypoint_sha256 !== binding.wrangler_entrypoint_sha256 ||
      seedBinding.node_executable_sha256 !== binding.node_executable_sha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SEED_RECEIPT_INVALID");
  }
  return true;
}

function linkedRevalidator(revalidate, readers) {
  return async () => {
    if (await revalidate() !== true) return false;
    for (const { read, sha256: expectedSha256 } of readers) {
      const current = read();
      if (current.sha256 !== expectedSha256) return false;
    }
    return true;
  };
}

function journalPath(path, directory, expectedName) {
  return assertArtifactPath(
    path,
    directory,
    expectedName,
    "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PATH_INVALID",
  );
}

function confirmedJournalRecord(records, step, requestSha256) {
  const confirmed = records.find((record) =>
    record.record_type === "confirmed" && record.step === step);
  if (!confirmed || confirmed.request_sha256 !== requestSha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
  }
  return confirmed;
}

function responseManifestSha256(record) {
  return sha256({
    schema_version: 1,
    kind: "journaled_provider_response",
    phase: record.phase,
    step: record.step,
    request_sha256: record.request_sha256,
    provider_metadata: record.provider_metadata,
  });
}

function readbackManifestSha256(component, snapshot) {
  return sha256({
    schema_version: 1,
    kind: "provider_readback_component",
    component,
    raw_evidence_manifest_sha256:
      snapshot.second_raw_evidence_manifest_sha256,
    stable_semantic_sha256: snapshot.stable_semantic_sha256,
  });
}

function journalSummary(path, directory, phase, binding) {
  const bindingSha256 = sha256(binding);
  let summary;
  try {
    summary = summarizeDisposableRecoveryDeploymentJournal(path, {
      expectedBinding: binding,
      expectedJournalDirectory: directory,
      expectedPhase: phase,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
  }
  if (summary.phase !== phase || summary.binding_sha256 !== bindingSha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
  }
  return summary;
}

function readJournal(path, directory) {
  try {
    return readDisposableRecoveryDeploymentJournal(path, {
      expectedJournalDirectory: directory,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
  }
}

function assertJournalResumeState(path, directory, phase, binding) {
  if (!existsSync(path)) return true;
  let records;
  try {
    records = readDisposableRecoveryDeploymentJournal(path, {
      expectedJournalDirectory: directory,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
  }
  const expectedBindingSha256 = sha256(binding);
  if (records.length < 1 || records.some((record) =>
    record.phase !== phase || record.binding_sha256 !== expectedBindingSha256)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_EVIDENCE_INVALID");
  }
  if (records.at(-1).effect_state === "sent_unconfirmed") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS");
  }
  return true;
}

async function runJournalMutation({
  binding,
  phase,
  step,
  effect,
  request,
  journalPath: path,
  directory,
  beforeBoundary,
  mutate,
  validate,
}) {
  return runJournaledDisposableRecoveryDeploymentMutation({
    binding,
    phase,
    step,
    effect,
    request,
    journalPath: path,
    expectedJournalDirectory: directory,
    mutate: async (semanticRequest) => {
      await beforeBoundary();
      let result;
      try { result = await mutate(semanticRequest); }
      catch { throw new Error("provider_mutation_unconfirmed"); }
      await beforeBoundary();
      return result;
    },
    validate,
  });
}

/** Read-only source preflight. It performs no mutation and creates no journal. */
export async function runDisposableRecoverySourcePreflight({
  binding: bindingInput,
  moduleInventorySha256,
  receiptPath,
  expectedReceiptDirectory,
  createProvider,
  revalidate = () => true,
  now = () => new Date(),
}) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  const requests = disposableRecoveryDeploymentRequestPlan(
    binding,
    moduleInventorySha256,
  );
  const hashes = plannedRequestHashes(requests);
  return reserveAndFinalizePhase({
    binding,
    expectedReceiptDirectory,
    receiptPath,
    receiptName: DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
    kind: "source_preflight",
    revalidate,
    now,
    validate: assertDisposableRecoverySourcePreflightReceipt,
    read: readDisposableRecoverySourcePreflightReceipt,
    build: async ({ beforeBoundary, completedAt }) => {
      const provider = await createCheckedProvider(createProvider, beforeBoundary, {
        binding,
        phase: "source",
        stage: "source_preflight",
        requests,
      });
      const snapshot = await doubleReadSnapshot({
        provider,
        beforeBoundary,
        binding,
        phase: "source",
        stage: "source_preflight",
        semanticValidator: (value) => assertSourcePreflightSemantic(value, binding),
      });
      return {
        schema_version: 2,
        protocol: DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
        kind: "source_preflight",
        status: "passed",
        completed_at: completedAt,
        binding,
        planned_requests: {
          source_active_upload_sha256: hashes.source_active_upload_sha256,
          source_active_deployment_sha256:
            hashes.source_active_deployment_sha256,
          seed_fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
        },
        snapshot: snapshot.receipt,
      };
    },
  });
}

/** A2 source-only mutation phase. The synthetic seed must run after this. */
export async function runDisposableRecoverySourcePhase({
  binding: bindingInput,
  moduleInventorySha256,
  sourcePreflightReceiptPath,
  a2ApprovalFingerprint,
  journalPath: journalPathInput,
  receiptPath,
  expectedReceiptDirectory,
  createProvider,
  revalidate = () => true,
  now = () => new Date(),
  resume = false,
}) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  const directory = assertExpectedDirectory(expectedReceiptDirectory);
  const preflight = readSourcePreflight(sourcePreflightReceiptPath, directory);
  if (!sameBinding(preflight.value.binding, binding) ||
      a2ApprovalFingerprint !== disposableRecoverySourceA2Fingerprint(
        binding,
        preflight.sha256,
      )) {
    refuse("DISPOSABLE_RECOVERY_SOURCE_APPROVAL_INVALID");
  }
  const requests = disposableRecoveryDeploymentRequestPlan(
    binding,
    moduleInventorySha256,
  );
  const hashes = plannedRequestHashes(requests);
  if (preflight.value.planned_requests.source_active_upload_sha256 !==
      hashes.source_active_upload_sha256 ||
      preflight.value.planned_requests.source_active_deployment_sha256 !==
        hashes.source_active_deployment_sha256 ||
      preflight.value.planned_requests.seed_fixture_sha256 !==
        DISPOSABLE_RECOVERY_FIXTURE_SHA256) {
    refuse("DISPOSABLE_RECOVERY_SOURCE_APPROVAL_INVALID");
  }
  const exactJournalPath = journalPath(
    journalPathInput,
    directory,
    DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME,
  );
  if (!resume && existsSync(exactJournalPath)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RESUME_REQUIRED");
  }
  const phaseRevalidate = linkedRevalidator(revalidate, [{
    read: () => readSourcePreflight(sourcePreflightReceiptPath, directory),
    sha256: preflight.sha256,
  }]);
  return reserveAndFinalizePhase({
    binding,
    expectedReceiptDirectory: directory,
    receiptPath,
    receiptName: DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
    kind: "source_phase",
    revalidate: phaseRevalidate,
    now,
    validate: assertDisposableRecoverySourcePhaseReceipt,
    read: readDisposableRecoverySourcePhaseReceipt,
    resume,
    resumeCheck: () => assertJournalResumeState(
      exactJournalPath,
      directory,
      "source",
      binding,
    ),
    build: async ({ beforeBoundary, completedAt }) => {
      const provider = await createCheckedProvider(createProvider, beforeBoundary, {
        binding,
        phase: "source",
        stage: "source_phase",
        requests,
        source_preflight_receipt_sha256: preflight.sha256,
      });
      const opening = await doubleReadSnapshot({
        provider,
        beforeBoundary,
        binding,
        phase: "source",
        stage: "source_preflight",
        semanticValidator: (value) => assertSourcePreflightSemantic(value, binding),
      });
      if (opening.receipt.stable_semantic_sha256 !==
          preflight.value.snapshot.stable_semantic_sha256) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PREFLIGHT_CHANGED");
      }
      const sourceUpload = await runJournalMutation({
        binding,
        phase: "source",
        step: "upload_active_version",
        effect: "create_worker_version",
        request: requests.source_active_upload,
        journalPath: exactJournalPath,
        directory,
        beforeBoundary,
        mutate: (request) => provider.uploadVersion(request, opening.semantic),
        validate: (value) => assertUploadResult(value, requests.source_active_upload),
      });
      const sourceVersionId = providerId(sourceUpload.version_id);
      const sourceDeployment = await runJournalMutation({
        binding,
        phase: "source",
        step: "deploy_active_version",
        effect: "replace_worker_deployment",
        request: requests.source_active_deployment,
        journalPath: exactJournalPath,
        directory,
        beforeBoundary,
        mutate: (request) => provider.deployVersion(
          request,
          sourceVersionId,
          opening.semantic,
        ),
        validate: (value) => assertDeployResult(value, sourceVersionId),
      });
      const final = await doubleReadSnapshot({
        provider,
        beforeBoundary,
        binding,
        phase: "source",
        stage: "source_final",
        expected: {
          active_deployment_id: sourceDeployment.deployment_id,
          active_version_id: sourceDeployment.version_id,
        },
        semanticValidator: (value) =>
          assertSourceFinalSemantic(value, binding, sourceVersionId),
      });
      const records = readJournal(exactJournalPath, directory);
      const summary = journalSummary(exactJournalPath, directory, "source", binding);
      const uploadRecord = confirmedJournalRecord(
        records,
        "upload_active_version",
        hashes.source_active_upload_sha256,
      );
      const deploymentRecord = confirmedJournalRecord(
        records,
        "deploy_active_version",
        hashes.source_active_deployment_sha256,
      );
      const source = final.semantic.source;
      if (deploymentRecord.result.deployment_id !==
            source.active_deployment.deployment_id ||
          deploymentRecord.result.version_id !==
            source.active_deployment.version_id) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_FINAL_INVALID");
      }
      return {
        schema_version: 2,
        protocol: DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
        kind: "source_phase",
        status: "passed",
        completed_at: completedAt,
        binding,
        source_preflight_receipt_sha256: preflight.sha256,
        a2_approval_fingerprint: a2ApprovalFingerprint,
        journal: {
          run_id: binding.run_id,
          through_sequence: summary.through_sequence,
          event_count: summary.event_count,
          head_sha256: summary.head_sha256,
          event_manifest_sha256: summary.event_manifest_sha256,
        },
        source: {
          resource_fingerprint: binding.source_resource_fingerprint,
          active_version: {
            version_id: source.active_version.version_id,
            script_etag: source.active_version.script_etag,
            upload_request_sha256: hashes.source_active_upload_sha256,
            module_inventory_sha256: moduleInventorySha256,
            bindings_sha256: source.active_version.bindings_sha256,
            bindings_without_mode_sha256:
              source.active_version.bindings_without_mode_sha256,
            upload_response_evidence_manifest_sha256:
              responseManifestSha256(uploadRecord),
            version_readback_evidence_manifest_sha256:
              readbackManifestSha256("source_active_version", final.receipt),
          },
          active_deployment: {
            deployment_id: source.active_deployment.deployment_id,
            version_id: source.active_deployment.version_id,
            traffic_percent: 100,
            deployment_request_sha256:
              hashes.source_active_deployment_sha256,
            deployment_response_evidence_manifest_sha256:
              responseManifestSha256(deploymentRecord),
            deployment_readback_evidence_manifest_sha256:
              readbackManifestSha256("source_active_deployment", final.receipt),
          },
        },
        final_snapshot: final.receipt,
      };
    },
  });
}

/** Read-only target preflight, bound to the completed source and seed. */
export async function runDisposableRecoveryTargetPreflight({
  binding: bindingInput,
  moduleInventorySha256,
  sourcePhaseReceiptPath,
  seedReceiptPath,
  receiptPath,
  expectedReceiptDirectory,
  createProvider,
  revalidate = () => true,
  now = () => new Date(),
}) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  const directory = assertExpectedDirectory(expectedReceiptDirectory);
  const sourcePhase = readSourcePhase(sourcePhaseReceiptPath, directory);
  const seed = readSeed(seedReceiptPath, directory);
  if (!sameBinding(sourcePhase.value.binding, binding)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_SOURCE_PHASE_RECEIPT_INVALID");
  }
  assertSeedChain(seed, sourcePhase, binding);
  const requests = disposableRecoveryDeploymentRequestPlan(
    binding,
    moduleInventorySha256,
  );
  const hashes = plannedRequestHashes(requests);
  const phaseRevalidate = linkedRevalidator(revalidate, [
    { read: () => readSourcePhase(sourcePhaseReceiptPath, directory),
      sha256: sourcePhase.sha256 },
    { read: () => readSeed(seedReceiptPath, directory), sha256: seed.sha256 },
  ]);
  return reserveAndFinalizePhase({
    binding,
    expectedReceiptDirectory: directory,
    receiptPath,
    receiptName: DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
    kind: "target_preflight",
    revalidate: phaseRevalidate,
    now,
    validate: assertDisposableRecoveryTargetPreflightReceipt,
    read: readDisposableRecoveryTargetPreflightReceipt,
    build: async ({ beforeBoundary, completedAt }) => {
      const provider = await createCheckedProvider(createProvider, beforeBoundary, {
        binding,
        phase: "target",
        stage: "target_preflight",
        requests,
        source_phase_receipt_sha256: sourcePhase.sha256,
        seed_receipt_sha256: seed.sha256,
      });
      const snapshot = await doubleReadSnapshot({
        provider,
        beforeBoundary,
        binding,
        phase: "target",
        stage: "target_preflight",
        semanticValidator: (value) => assertTargetPreflightSemantic(
          value,
          binding,
          sourcePhase.value,
          seed.value,
        ),
      });
      return {
        schema_version: 2,
        protocol: DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
        kind: "target_preflight",
        status: "passed",
        completed_at: completedAt,
        binding,
        source_phase_receipt_sha256: sourcePhase.sha256,
        seed_receipt_sha256: seed.sha256,
        planned_requests: {
          target_paused_upload_sha256: hashes.target_paused_upload_sha256,
          target_active_upload_sha256: hashes.target_active_upload_sha256,
          target_paused_deployment_sha256:
            hashes.target_paused_deployment_sha256,
        },
        snapshot: snapshot.receipt,
      };
    },
  });
}

/** A4 target-only phase. It uploads active but deploys only paused. */
export async function runDisposableRecoveryTargetPhase({
  binding: bindingInput,
  moduleInventorySha256,
  sourcePhaseReceiptPath,
  seedReceiptPath,
  targetPreflightReceiptPath,
  a4ApprovalFingerprint,
  journalPath: journalPathInput,
  receiptPath,
  expectedReceiptDirectory,
  createProvider,
  revalidate = () => true,
  now = () => new Date(),
  resume = false,
}) {
  const binding = assertDisposableRecoveryDeploymentBinding(bindingInput);
  const directory = assertExpectedDirectory(expectedReceiptDirectory);
  const sourcePhase = readSourcePhase(sourcePhaseReceiptPath, directory);
  const seed = readSeed(seedReceiptPath, directory);
  const preflight = readTargetPreflight(targetPreflightReceiptPath, directory);
  if (!sameBinding(sourcePhase.value.binding, binding) ||
      !sameBinding(preflight.value.binding, binding)) {
    refuse("DISPOSABLE_RECOVERY_TARGET_APPROVAL_INVALID");
  }
  assertSeedChain(seed, sourcePhase, binding);
  const expectedApproval = disposableRecoveryTargetA4Fingerprint(
    binding,
    sourcePhase.sha256,
    seed.sha256,
    preflight.sha256,
  );
  if (a4ApprovalFingerprint !== expectedApproval ||
      preflight.value.source_phase_receipt_sha256 !== sourcePhase.sha256 ||
      preflight.value.seed_receipt_sha256 !== seed.sha256) {
    refuse("DISPOSABLE_RECOVERY_TARGET_APPROVAL_INVALID");
  }
  const requests = disposableRecoveryDeploymentRequestPlan(
    binding,
    moduleInventorySha256,
  );
  const hashes = plannedRequestHashes(requests);
  if (preflight.value.planned_requests.target_paused_upload_sha256 !==
      hashes.target_paused_upload_sha256 ||
      preflight.value.planned_requests.target_active_upload_sha256 !==
        hashes.target_active_upload_sha256 ||
      preflight.value.planned_requests.target_paused_deployment_sha256 !==
        hashes.target_paused_deployment_sha256) {
    refuse("DISPOSABLE_RECOVERY_TARGET_APPROVAL_INVALID");
  }
  const exactJournalPath = journalPath(
    journalPathInput,
    directory,
    DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME,
  );
  if (!resume && existsSync(exactJournalPath)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_RESUME_REQUIRED");
  }
  const phaseRevalidate = linkedRevalidator(revalidate, [
    { read: () => readSourcePhase(sourcePhaseReceiptPath, directory),
      sha256: sourcePhase.sha256 },
    { read: () => readSeed(seedReceiptPath, directory), sha256: seed.sha256 },
    { read: () => readTargetPreflight(targetPreflightReceiptPath, directory),
      sha256: preflight.sha256 },
  ]);
  return reserveAndFinalizePhase({
    binding,
    expectedReceiptDirectory: directory,
    receiptPath,
    receiptName: DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
    kind: "target_phase",
    revalidate: phaseRevalidate,
    now,
    validate: assertDisposableRecoveryTargetPhaseReceipt,
    read: readDisposableRecoveryDeploymentReceipt,
    resume,
    resumeCheck: () => assertJournalResumeState(
      exactJournalPath,
      directory,
      "target",
      binding,
    ),
    build: async ({ beforeBoundary, completedAt }) => {
      const provider = await createCheckedProvider(createProvider, beforeBoundary, {
        binding,
        phase: "target",
        stage: "target_phase",
        requests,
        source_phase_receipt_sha256: sourcePhase.sha256,
        seed_receipt_sha256: seed.sha256,
        target_preflight_receipt_sha256: preflight.sha256,
      });
      const opening = await doubleReadSnapshot({
        provider,
        beforeBoundary,
        binding,
        phase: "target",
        stage: "target_preflight",
        semanticValidator: (value) => assertTargetPreflightSemantic(
          value,
          binding,
          sourcePhase.value,
          seed.value,
        ),
      });
      if (opening.receipt.stable_semantic_sha256 !==
          preflight.value.snapshot.stable_semantic_sha256) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PREFLIGHT_CHANGED");
      }
      const pausedUpload = await runJournalMutation({
        binding,
        phase: "target",
        step: "upload_paused_version",
        effect: "create_worker_version",
        request: requests.target_paused_upload,
        journalPath: exactJournalPath,
        directory,
        beforeBoundary,
        mutate: (request) => provider.uploadVersion(request, opening.semantic),
        validate: (value) => assertUploadResult(value, requests.target_paused_upload),
      });
      const pausedVersionId = providerId(pausedUpload.version_id);
      const activeUpload = await runJournalMutation({
        binding,
        phase: "target",
        step: "upload_active_version",
        effect: "create_worker_version",
        request: requests.target_active_upload,
        journalPath: exactJournalPath,
        directory,
        beforeBoundary,
        mutate: (request) => provider.uploadVersion(request, opening.semantic),
        validate: (value) => assertUploadResult(value, requests.target_active_upload),
      });
      const activeVersionId = providerId(activeUpload.version_id);
      if (pausedVersionId === activeVersionId) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_PAIR_INVALID");
      }
      const pausedDeployment = await runJournalMutation({
        binding,
        phase: "target",
        step: "deploy_paused_version",
        effect: "replace_worker_deployment",
        request: requests.target_paused_deployment,
        journalPath: exactJournalPath,
        directory,
        beforeBoundary,
        mutate: (request) => provider.deployVersion(
          request,
          pausedVersionId,
          opening.semantic,
        ),
        validate: (value) => assertDeployResult(value, pausedVersionId),
      });
      const final = await doubleReadSnapshot({
        provider,
        beforeBoundary,
        binding,
        phase: "target",
        stage: "target_final",
        expected: {
          source_active_deployment_id:
            sourcePhase.value.source.active_deployment.deployment_id,
          source_active_version_id:
            sourcePhase.value.source.active_version.version_id,
          target_active_version_id: activeVersionId,
          target_paused_deployment_id: pausedDeployment.deployment_id,
          target_paused_version_id: pausedDeployment.version_id,
        },
        semanticValidator: (value) => assertTargetFinalSemantic(
          value,
          binding,
          sourcePhase.value,
          seed.value,
          pausedVersionId,
          activeVersionId,
        ),
      });
      const records = readJournal(exactJournalPath, directory);
      const summary = journalSummary(exactJournalPath, directory, "target", binding);
      const pausedUploadRecord = confirmedJournalRecord(
        records,
        "upload_paused_version",
        hashes.target_paused_upload_sha256,
      );
      const activeUploadRecord = confirmedJournalRecord(
        records,
        "upload_active_version",
        hashes.target_active_upload_sha256,
      );
      const deploymentRecord = confirmedJournalRecord(
        records,
        "deploy_paused_version",
        hashes.target_paused_deployment_sha256,
      );
      const target = final.semantic.target;
      if (deploymentRecord.result.deployment_id !==
            target.paused_deployment.deployment_id ||
          deploymentRecord.result.version_id !==
            target.paused_deployment.version_id) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_TARGET_FINAL_INVALID");
      }
      const versionEvidence = (component, version, uploadHash, record) => ({
        version_id: version.version_id,
        script_etag: version.script_etag,
        upload_request_sha256: uploadHash,
        module_inventory_sha256: moduleInventorySha256,
        bindings_sha256: version.bindings_sha256,
        bindings_without_mode_sha256: version.bindings_without_mode_sha256,
        upload_response_evidence_manifest_sha256: responseManifestSha256(record),
        version_readback_evidence_manifest_sha256:
          readbackManifestSha256(component, final.receipt),
      });
      const receipt = {
        schema_version: 2,
        protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
        kind: "target_phase",
        status: "passed",
        completed_at: completedAt,
        binding,
        source_phase_receipt_sha256: sourcePhase.sha256,
        seed_receipt_sha256: seed.sha256,
        target_preflight_receipt_sha256: preflight.sha256,
        a4_approval_fingerprint: a4ApprovalFingerprint,
        journal: {
          run_id: binding.run_id,
          through_sequence: summary.through_sequence,
          event_count: summary.event_count,
          source_prefix_head_sha256: sourcePhase.value.journal.head_sha256,
          head_sha256: summary.head_sha256,
          event_manifest_sha256: summary.event_manifest_sha256,
        },
        source: {
          resource_fingerprint: binding.source_resource_fingerprint,
          active_version_id: final.semantic.source.active_version_id,
          active_script_etag: final.semantic.source.active_script_etag,
          active_deployment_id: final.semantic.source.active_deployment_id,
        },
        target: {
          resource_fingerprint: binding.target_resource_fingerprint,
          paused_version: versionEvidence(
            "target_paused_version",
            target.paused_version,
            hashes.target_paused_upload_sha256,
            pausedUploadRecord,
          ),
          active_version: versionEvidence(
            "target_active_version",
            target.active_version,
            hashes.target_active_upload_sha256,
            activeUploadRecord,
          ),
          paused_deployment: {
            deployment_id: target.paused_deployment.deployment_id,
            version_id: target.paused_deployment.version_id,
            traffic_percent: 100,
            deployment_request_sha256: hashes.target_paused_deployment_sha256,
            deployment_response_evidence_manifest_sha256:
              responseManifestSha256(deploymentRecord),
            deployment_readback_evidence_manifest_sha256:
              readbackManifestSha256("target_paused_deployment", final.receipt),
          },
        },
        final_snapshot: final.receipt,
      };
      assertDisposableRecoveryDeploymentReceiptChain({
        source_preflight: readSourcePreflight(
          join(directory, DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME),
          directory,
        ),
        source_phase: sourcePhase,
        seed_receipt_sha256: seed.sha256,
        target_preflight: preflight,
        target_phase: { value: receipt, sha256: sha256(receipt) },
      });
      return receipt;
    },
  });
}

// Retain the old name only as an explicit refusal so no caller can accidentally
// collapse source, seed, and target into one approval again.
export async function runDisposableRecoveryFieldDeployment() {
  refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_PHASE_SPLIT_REQUIRED");
}

export const DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES = Object.freeze({
  source_preflight: DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  source_phase: DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  seed: SEED_RECEIPT_NAME,
  target_preflight: DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  target_phase: DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
});

// Preserve narrow error identities for callers that adjudicate ambiguity.
export const DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_ERROR_TYPES = Object.freeze([
  DisposableRecoveryFieldDeploymentError,
  DisposableRecoveryDeploymentReceiptError,
  DisposableRecoveryDeploymentJournalError,
  PrivateAggregateReceiptError,
]);
