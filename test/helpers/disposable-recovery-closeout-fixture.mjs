import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
} from "../../operations/cloudflare-recovery-adapter.mjs";
import {
  DISPOSABLE_TEARDOWN_NAMES,
} from "../../operations/cloudflare-disposable-teardown-provider.mjs";
import {
  LOCKED_WRANGLER_ENTRYPOINT,
  LOCKED_WRANGLER_RUNTIME_DIRECTORY,
} from "../../operations/locked-wrangler-runtime.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  disposableRecoveryDeploymentCampaignFingerprint,
  disposableRecoverySourceA2Fingerprint,
  disposableRecoveryTargetA4Fingerprint,
  disposableRecoveryVectorizeMutationQuiescenceClaim,
} from "../../operations/disposable-recovery-deployment-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES,
} from "../../operations/disposable-recovery-field-deploy.mjs";
import {
  DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
} from "../../operations/disposable-recovery-field-acceptance.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  disposableRecoveryFieldKeychainPrepApprovalFingerprint,
  previewDisposableRecoveryFieldKeychainReset,
  runDisposableRecoveryFieldKeychainPrep,
  runDisposableRecoveryFieldKeychainReset,
} from "../../operations/disposable-recovery-field-keychain-prep.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES,
  disposableRecoveryProvisionApprovalFingerprint,
  disposableRecoveryProvisionPaths,
  disposableRecoveryProvisioningBinding,
  runDisposableRecoveryProvisionPhase,
  runDisposableRecoveryProvisionPreflight,
} from "../../operations/disposable-recovery-field-provision.mjs";
import {
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  disposableRecoverySeedExecutionApprovalFingerprint,
  seedDisposableRecoveryFixture,
} from "../../operations/disposable-recovery-seeder.mjs";
import {
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME,
  assertDisposableRecoveryBrainTeardownReceipt,
  readDisposableRecoveryTeardownProvisionArtifacts,
} from "../../operations/disposable-recovery-field-teardown.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES,
  readDisposableRecoveryFieldCloseoutEvidence,
} from "../../operations/disposable-recovery-field-closeout.mjs";
import {
  VERIFIED_RECOVERY_STAGES,
  bindVerifiedRecoveryFieldProof,
  initializeVerifiedRecovery,
  reviewVerifiedRecoveryVectorizeMutationQuiescence,
  runVerifiedRecovery,
  writeVerifiedRecoveryState,
} from "../../operations/verified-recovery.mjs";
import {
  createTestDisposableRecoveryK0Capability,
} from "./disposable-recovery-k0-capability.mjs";
import {
  createDisposableCampaignAuthorityFixture,
} from "./disposable-campaign-authority.mjs";

export const CLOSEOUT_FIXTURE_ACCOUNT_ID = "a".repeat(32);
export const CLOSEOUT_FIXTURE_REFERENCES = Object.freeze([
  "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/bank-wrapping-v2",
]);

const HASH = (character) => character.repeat(64);
const SOURCE_WORKER_ID = "b".repeat(32);
const TARGET_WORKER_ID = "c".repeat(32);
const SOURCE_D1 = "11111111-1111-4111-8111-111111111111";
const TARGET_D1 = "22222222-2222-4222-8222-222222222222";
const SOURCE_VERSION = "33333333-3333-4333-8333-333333333333";
const TARGET_VERSION = "44444444-4444-4444-8444-444444444444";
const TARGET_ACTIVE_DEPLOYMENT =
  "12121212-1212-4212-8212-121212121212";
const SOURCE_DEPLOYMENT = "88888888-8888-4888-8888-888888888888";
const TARGET_PAUSED_DEPLOYMENT =
  "99999999-9999-4999-8999-999999999999";
const SEED_RECEIPT_NAME = "v048-disposable-seed-receipt.json";
const COMPLETED_BOOTSTRAP_CHECKPOINT_NAME =
  ".brain-recovery-test-bootstrap-interruption-v1.completed.json";
const COMPLETED_BOOTSTRAP_RESUME_NAME =
  ".brain-recovery-test-bootstrap-resume-authorized-v1.completed.json";
const COMPLETED_BOOTSTRAP_PROMOTION_NAME =
  ".brain-recovery-test-bootstrap-promotion-authorized-v1.completed.json";
const VECTOR_CREATED_ON = "2022-11-15T18:25:44.442097Z";
const ARTIFACT_BYTES = Buffer.from("encrypted provenance fixture\n", "utf8");
const WORKER_MISSING_CODE_SHA256 = sha256(JSON.stringify({ codes: [10007] }));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function compactReceiptSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function interruptionSeedControl(candidate) {
  return {
    source_preflight_receipt_sha256:
      candidate.sourcePreflightReceiptSha256,
    source_phase_receipt_sha256: candidate.sourcePhaseReceiptSha256,
    seed_receipt_sha256: candidate.seedReceiptSha256,
    target_preflight_receipt_sha256:
      candidate.targetPreflightReceiptSha256,
    deployment_receipt_sha256: candidate.deploymentReceiptSha256,
    seed_fixture_sha256: candidate.seedFixtureSha256,
    seed_d1_content_fingerprint: candidate.seedD1ContentFingerprint,
    seed_document_count: candidate.seedDocumentCount,
    seed_chunk_count: candidate.seedChunkCount,
    seed_fts_count: candidate.seedFtsCount,
    seed_vector_count: candidate.seedVectorCount,
    seed_replay_unchanged_documents:
      candidate.seedReplayUnchangedDocuments,
  };
}

function interruptionApprovalFingerprint(plan, candidate, wrapperSha256) {
  return sha256(canonical({
    schema_version: 7,
    purpose: "controlled_synthetic_mid_bootstrap_interruption",
    mode: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    candidate_sha: candidate.candidateSha,
    candidate_tree_sha: candidate.candidateTreeSha,
    field_receipt_sha256: candidate.fieldReceiptSha256,
    field_receipt_run_id: candidate.fieldReceiptRunId,
    package_filename: candidate.packageFilename,
    package_bytes: candidate.packageBytes,
    package_sha256: candidate.packageSha256,
    package_file_count: candidate.packageFileCount,
    execution_inventory_sha256: candidate.executionInventorySha256,
    source_preflight_receipt_sha256:
      candidate.sourcePreflightReceiptSha256,
    source_phase_receipt_sha256: candidate.sourcePhaseReceiptSha256,
    seed_receipt_sha256: candidate.seedReceiptSha256,
    target_preflight_receipt_sha256:
      candidate.targetPreflightReceiptSha256,
    deployment_receipt_sha256: candidate.deploymentReceiptSha256,
    seed_fixture_sha256: candidate.seedFixtureSha256,
    seed_d1_content_fingerprint: candidate.seedD1ContentFingerprint,
    seed_document_count: candidate.seedDocumentCount,
    seed_chunk_count: candidate.seedChunkCount,
    seed_fts_count: candidate.seedFtsCount,
    seed_vector_count: candidate.seedVectorCount,
    seed_replay_unchanged_documents:
      candidate.seedReplayUnchangedDocuments,
    wrangler_runtime_inventory_sha256:
      candidate.wranglerRuntimeInventorySha256,
    wrangler_entrypoint: candidate.wranglerRuntimeEntrypoint,
    wrangler_entrypoint_sha256: candidate.wranglerRuntimeEntrypointSha256,
    wrangler_runtime_package_count: candidate.wranglerRuntimePackageCount,
    wrangler_runtime_file_count: candidate.wranglerRuntimeFileCount,
    wrangler_runtime_bytes: candidate.wranglerRuntimeBytes,
    wrangler_runtime_directory: candidate.wranglerRuntimeDirectory,
    wrangler_runtime_schema_version: candidate.wranglerRuntimeSchemaVersion,
    wrangler_host_platform: candidate.wranglerHostPlatform,
    wrangler_host_arch: candidate.wranglerHostArch,
    wrangler_host_libc: candidate.wranglerHostLibc,
    node_version: candidate.nodeVersion,
    node_executable_sha256: candidate.nodeExecutableSha256,
    wrangler_wrapper_sha256: wrapperSha256,
    plan_fingerprint: plan.plan_fingerprint,
    source_manifest_fingerprint: plan.source_manifest_fingerprint,
    target_manifest_fingerprint: plan.target_manifest_fingerprint,
    source_resource_fingerprint: plan.source_resource_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    client_slug: "v048-field-proof",
    product_version: "0.4.8",
    data_class: "deterministic_fictional_synthetic_only",
    stage: "rebuild_vectorize",
    hook_point:
      "after_observed_persisted_nonfinal_bootstrap_v2_receipt_before_sleep_or_active_promotion",
  }));
}

function bootstrapObservation(plan, phase) {
  const promoted = phase === "promotion";
  const cursorPosition = promoted ? 6_113 : 4_000;
  return {
    schema_version: 1,
    protocol: "bootstrap-v2",
    target_identity_fingerprint: plan.target_resource_fingerprint,
    epoch: 1,
    base_count: 0,
    cursor_position: cursorPosition,
    high_water_position: 6_113,
    cursor_present: true,
    cursor_advanced: true,
    cursor_matches_checkpoint: phase === "resume",
    batch_rows: cursorPosition,
    progressed_batch_rows: cursorPosition,
    queued: 0,
    submitted: 0,
    confirmed: cursorPosition,
    failed: 0,
    outbox_pending: 0,
    outbox_submitted: 0,
    outbox_failed: 0,
    provider_vectors: cursorPosition,
    d1_documents: 6_001,
    d1_chunks: 6_113,
    d1_fts: 6_113,
    corpus_matches_restore: true,
    target_paused: true,
    active_not_promoted: true,
    ready_to_interrupt: phase === "checkpoint",
  };
}

function createCompletedInterruptionProof({
  artifactDirectory,
  plan,
  binding,
  fieldProof,
  sourcePreflightSha256,
  sourcePhaseSha256,
  seedReceipt,
  seedReceiptSha256,
  targetPreflightSha256,
  deploymentSha256,
}) {
  const candidate = Object.freeze({
    candidateSha: binding.candidate_sha,
    candidateTreeSha: binding.candidate_tree_sha,
    fieldReceiptRunId: binding.field_receipt_run_id,
    fieldReceiptSha256: binding.field_receipt_sha256,
    packageFilename: binding.package_filename,
    packageBytes: binding.package_bytes,
    packageSha256: binding.package_sha256,
    packageFileCount: binding.package_file_count,
    executionInventorySha256: binding.execution_inventory_sha256,
    sourcePreflightReceiptSha256: sourcePreflightSha256,
    sourcePhaseReceiptSha256: sourcePhaseSha256,
    deploymentReceiptSha256: deploymentSha256,
    seedReceiptSha256,
    targetPreflightReceiptSha256: targetPreflightSha256,
    seedFixtureSha256: seedReceipt.fixture.sha256,
    seedD1ContentFingerprint: seedReceipt.d1.content_fingerprint,
    seedDocumentCount: seedReceipt.d1.documents,
    seedChunkCount: seedReceipt.d1.chunks,
    seedFtsCount: seedReceipt.d1.fts,
    seedVectorCount: seedReceipt.projection.vectorize_vectors,
    seedReplayUnchangedDocuments:
      seedReceipt.verification_replay.unchanged_documents,
    wranglerRuntimeInventorySha256:
      binding.wrangler_runtime_inventory_sha256,
    wranglerRuntimeEntrypoint: LOCKED_WRANGLER_ENTRYPOINT,
    wranglerRuntimeEntrypointSha256: binding.wrangler_entrypoint_sha256,
    wranglerRuntimePackageCount: 1,
    wranglerRuntimeFileCount: 1,
    wranglerRuntimeBytes: 1,
    wranglerRuntimeDirectory: LOCKED_WRANGLER_RUNTIME_DIRECTORY,
    wranglerRuntimeSchemaVersion: 1,
    wranglerHostPlatform: "darwin",
    wranglerHostArch: "arm64",
    wranglerHostLibc: "none",
    nodeVersion: binding.node_version,
    nodeExecutableSha256: binding.node_executable_sha256,
  });
  const approval = interruptionApprovalFingerprint(
    plan,
    candidate,
    binding.wrangler_wrapper_sha256,
  );
  const privateCursorSha256 = sha256("a17-private-cursor");
  const checkpoint = {
    schema_version: 7,
    mode: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    plan_fingerprint: plan.plan_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    candidate_sha: candidate.candidateSha,
    candidate_tree_sha: candidate.candidateTreeSha,
    field_receipt_sha256: candidate.fieldReceiptSha256,
    field_receipt_run_id: candidate.fieldReceiptRunId,
    package_filename: candidate.packageFilename,
    package_bytes: candidate.packageBytes,
    package_sha256: candidate.packageSha256,
    package_file_count: candidate.packageFileCount,
    execution_inventory_sha256: candidate.executionInventorySha256,
    ...interruptionSeedControl(candidate),
    wrangler_runtime_inventory_sha256:
      candidate.wranglerRuntimeInventorySha256,
    wrangler_entrypoint: candidate.wranglerRuntimeEntrypoint,
    wrangler_entrypoint_sha256: candidate.wranglerRuntimeEntrypointSha256,
    wrangler_runtime_package_count: candidate.wranglerRuntimePackageCount,
    wrangler_runtime_file_count: candidate.wranglerRuntimeFileCount,
    wrangler_runtime_bytes: candidate.wranglerRuntimeBytes,
    wrangler_runtime_directory: candidate.wranglerRuntimeDirectory,
    wrangler_runtime_schema_version: candidate.wranglerRuntimeSchemaVersion,
    wrangler_host_platform: candidate.wranglerHostPlatform,
    wrangler_host_arch: candidate.wranglerHostArch,
    wrangler_host_libc: candidate.wranglerHostLibc,
    node_version: candidate.nodeVersion,
    node_executable_sha256: candidate.nodeExecutableSha256,
    wrangler_wrapper_sha256: binding.wrangler_wrapper_sha256,
    interruption_approval_fingerprint: approval,
    private_cursor_sha256: privateCursorSha256,
    observation: bootstrapObservation(plan, "checkpoint"),
  };
  const checkpointSha256 = compactReceiptSha256(checkpoint);
  const sharedAuthorization = {
    schema_version: 3,
    mode: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    plan_fingerprint: plan.plan_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    candidate_sha: candidate.candidateSha,
    field_receipt_sha256: candidate.fieldReceiptSha256,
    package_sha256: candidate.packageSha256,
    execution_inventory_sha256: candidate.executionInventorySha256,
    ...interruptionSeedControl(candidate),
    wrangler_runtime_inventory_sha256:
      candidate.wranglerRuntimeInventorySha256,
    wrangler_entrypoint: candidate.wranglerRuntimeEntrypoint,
    wrangler_entrypoint_sha256: candidate.wranglerRuntimeEntrypointSha256,
    interruption_approval_fingerprint: approval,
    checkpoint_sha256: checkpointSha256,
  };
  const resume = {
    ...sharedAuthorization,
    private_cursor_sha256: privateCursorSha256,
    observation: bootstrapObservation(plan, "resume"),
  };
  const promotion = {
    ...sharedAuthorization,
    active_worker_version_id: TARGET_VERSION,
    private_cursor_sha256: sha256("a17-promoted-private-cursor"),
    observation: bootstrapObservation(plan, "promotion"),
  };
  const values = Object.freeze([
    Object.freeze([COMPLETED_BOOTSTRAP_CHECKPOINT_NAME, checkpoint]),
    Object.freeze([COMPLETED_BOOTSTRAP_RESUME_NAME, resume]),
    Object.freeze([COMPLETED_BOOTSTRAP_PROMOTION_NAME, promotion]),
  ]);
  for (const [name, value] of values) {
    writePrivate(join(artifactDirectory, name), `${JSON.stringify(value)}\n`);
  }
  return Object.freeze({
    checkpointSha256,
    resumeSha256: compactReceiptSha256(resume),
    promotionSha256: compactReceiptSha256(promotion),
    fieldProof,
  });
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
  return realpathSync(path);
}

function writePrivate(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  writeFileSync(path, bytes, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

async function createK0ResetHistory({
  receiptDirectory,
  receiptPath,
  binding,
  k0,
}) {
  const savedValues = new Map([...k0.keychain.values].map(([reference, value]) => [
    reference,
    value === null ? null : Buffer.from(value),
  ]));
  for (const [reference, value] of k0.keychain.values) {
    value?.fill(0);
    k0.keychain.values.set(reference, null);
  }
  unlinkSync(receiptPath);
  let randomCall = 0;
  let interrupted = false;
  try {
    await runDisposableRecoveryFieldKeychainPrep({
      binding,
      approvalFingerprint:
        disposableRecoveryFieldKeychainPrepApprovalFingerprint(binding),
      singleOperatorConfirmed: true,
      receiptPath,
      expectedReceiptDirectory: receiptDirectory,
      keychain: k0.keychain.adapter,
      platform: "darwin",
      randomBytesImpl: (length) => Buffer.alloc(length, ++randomCall),
      revalidate: () => true,
      now: () => new Date("2026-09-13T12:01:00.000Z"),
      onTransition(name) {
        if (name === "after_write:target_admin_key") {
          throw new Error("fixture controlled K0 interruption");
        }
      },
    });
  } catch (error) {
    if (error?.code !==
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH") {
      throw error;
    }
    interrupted = true;
  }
  if (!interrupted) throw new Error("closeout fixture K0 interruption failed");
  const preview = await previewDisposableRecoveryFieldKeychainReset({
    binding,
    receiptPath,
    expectedReceiptDirectory: receiptDirectory,
    keychain: k0.keychain.adapter,
    platform: "darwin",
  });
  const reset = await runDisposableRecoveryFieldKeychainReset({
    binding,
    approvalFingerprint: preview.reset_approval_fingerprint,
    singleOperatorConfirmed: true,
    receiptPath,
    expectedReceiptDirectory: receiptDirectory,
    keychain: k0.keychain.adapter,
    platform: "darwin",
    revalidate: () => true,
    now: () => new Date("2026-09-13T12:02:00.000Z"),
  });
  if (reset.status !== "reset_complete") {
    throw new Error("closeout fixture K0 reset failed");
  }
  for (const [reference, value] of savedValues) {
    k0.keychain.values.set(
      reference,
      value === null ? null : Buffer.from(value),
    );
    value?.fill(0);
  }
  copyFileSync(
    join(k0.directory, DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME),
    receiptPath,
  );
  if (process.platform !== "win32") chmodSync(receiptPath, 0o600);
  return Object.freeze({
    resetReceiptName: preview.reset_receipt_name,
    journalNames: Object.freeze(readdirSync(receiptDirectory)
      .filter((name) => name.startsWith(
        "v048-disposable-field-keychain-prep-reset-journal-",
      ))
      .sort()),
  });
}

function preparationBinding(paths) {
  const packageBytes = readFileSync(paths.package).length;
  return Object.freeze({
    schema_version: 1,
    candidate_sha: "a".repeat(40),
    candidate_tree_sha: "b".repeat(40),
    field_receipt_run_id: SOURCE_VERSION,
    field_receipt_sha256: sha256(readFileSync(paths.fieldReceipt)),
    package_filename: "brain-installer-0.4.8.tgz",
    package_bytes: packageBytes,
    package_sha256: sha256(readFileSync(paths.package)),
    package_file_count: 1,
    execution_inventory_sha256: HASH("1"),
    installed_execution_inventory_sha256: HASH("1"),
    wrangler_version: "4.131.1",
    wrangler_wrapper_sha256: sha256(readFileSync(paths.wranglerWrapper)),
    wrangler_runtime_inventory_sha256: HASH("4"),
    wrangler_entrypoint_sha256: HASH("5"),
    node_version: "v22.0.0",
    node_executable_sha256: HASH("6"),
  });
}

function provisionProvider(role) {
  const source = role === "source";
  const resourceName = DISPOSABLE_TEARDOWN_NAMES[role];
  const workerId = source ? SOURCE_WORKER_ID : TARGET_WORKER_ID;
  const databaseId = source ? SOURCE_D1 : TARGET_D1;
  const versionId = source ? SOURCE_VERSION : TARGET_VERSION;
  const deploymentId = source
    ? "55555555-5555-4555-8555-555555555555"
    : "66666666-6666-4666-8666-666666666666";
  let d1Created = false;
  let vectorCreated = false;
  let workerCreated = false;
  const providerMetadata = () => ({
    schema_version: 1,
    status: 200,
    content_type: "application/json",
    body_sha256: HASH("7"),
  });
  const providerResult = (result) => ({
    provider_metadata: providerMetadata(),
    result,
  });
  const responseEvidence = () => ({ operation: "fixture", ...providerMetadata() });
  const semantic = () => ({
    account_id: CLOSEOUT_FIXTURE_ACCOUNT_ID,
    role,
    resource_name: resourceName,
    worker_id: workerId,
    worker_created_on: VECTOR_CREATED_ON,
    worker_tag_sha256: HASH("8"),
    hostname: `${resourceName}.fixture.workers.dev`,
    database_id: databaseId,
    active_deployment_id: deploymentId,
    active_version_id: versionId,
    active_script_etag: "fixture-etag",
    active_traffic_percent: 100,
    baseline_mode: "maintenance-bootstrap",
    bindings_sha256: HASH("9"),
    resource: {
      custom_domains_count: 0,
      d1_exists: true,
      d1_name_and_id_exact: true,
      previews_enabled: false,
      routes_count: 0,
      schedules_count: 0,
      vector_count: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
      vectorize_exists: true,
      vectorize_name_exact: true,
      worker_exists: true,
      workers_dev_enabled: true,
    },
    bootstrap_tag_sha256: HASH("a"),
    schema_version: source ? 47 : null,
    user_tables: source ? null : 0,
    content_rows: 0,
    vector_count: 0,
    vectorize_created_on: VECTOR_CREATED_ON,
    metadata_indexes_sha256: HASH("b"),
  });
  return Object.freeze({
    role,
    accountId: CLOSEOUT_FIXTURE_ACCOUNT_ID,
    resourceName,
    adminKeyLocator: `keychain://${resourceName}/owner`,
    recoveryArtifactKeyLocator: source
      ? null
      : `keychain://${resourceName}/artifact-v1`,
    bankWrappingKeyLocator: source
      ? null
      : `keychain://${resourceName}/bank-wrapping-v2`,
    candidateModuleInventorySha256: HASH("c"),
    migrationInventorySha256: HASH("d"),
    bootstrapModuleInventorySha256: HASH("e"),
    async readCollisions() {
      return {
        schema_version: 1,
        operation: "read_provisioning_collisions",
        account_id: CLOSEOUT_FIXTURE_ACCOUNT_ID,
        resource_name: resourceName,
        worker_exists: workerCreated,
        d1_exists: d1Created,
        vectorize_exists: vectorCreated,
        worker_ids: workerCreated ? [workerId] : [],
        d1_ids: d1Created ? [databaseId] : [],
        vectorize_names: vectorCreated ? [resourceName] : [],
        responses: [responseEvidence()],
      };
    },
    async createMutationProvider() {
      return {
        async createD1() {
          d1Created = true;
          return providerResult({ database_id: databaseId });
        },
        async reconcileD1() { return { outcome: "resume_safe" }; },
        async createVectorize() {
          vectorCreated = true;
          return providerResult({ accepted: true, created_on: VECTOR_CREATED_ON });
        },
        async reconcileVectorize() { return { outcome: "resume_safe" }; },
        async createMetadataIndex({ propertyName, indexType }) {
          return providerResult({ property_name: propertyName, index_type: indexType });
        },
        async reconcileMetadataIndex() { return { outcome: "resume_safe" }; },
        async createWorker() {
          workerCreated = true;
          return providerResult({ worker_id: workerId });
        },
        async reconcileWorker() { return { outcome: "resume_safe" }; },
        async initializeSourceSchema() {
          return providerResult({
            migration_inventory_sha256: HASH("d"),
            schema_version: 47,
          });
        },
        async reconcileSourceSchema() { return { outcome: "resume_safe" }; },
        async readFinalIdentity() {
          return { worker_id: workerId, hostname: `${resourceName}.fixture.workers.dev` };
        },
        async createBaseline() { return providerResult({ version_id: versionId }); },
        async reconcileBaseline() { return { outcome: "resume_safe" }; },
        async readFinal() {
          return { semantic: semantic(), evidence: [responseEvidence()] };
        },
        dispose() {},
      };
    },
  });
}

async function createProvisions(receiptDirectory, base, k0) {
  const capabilities = {};
  for (const role of ["source", "target"]) {
    const provider = provisionProvider(role);
    const binding = disposableRecoveryProvisioningBinding(
      { binding: base },
      provider,
      role,
      k0.proof,
    );
    const paths = disposableRecoveryProvisionPaths(receiptDirectory, role);
    const preflight = await runDisposableRecoveryProvisionPreflight({
      binding,
      keychainProof: k0.proof,
      provider,
      receiptPath: paths.preflight,
      expectedReceiptDirectory: receiptDirectory,
      revalidate: () => true,
      now: () => new Date(role === "source"
        ? "2026-09-13T12:05:00.000Z"
        : "2026-09-13T12:15:00.000Z"),
    });
    await runDisposableRecoveryProvisionPhase({
      binding,
      keychainProof: k0.proof,
      provider,
      preflightReceiptPath: paths.preflight,
      approvalFingerprint: disposableRecoveryProvisionApprovalFingerprint(
        binding,
        preflight.receiptSha256,
      ),
      journalPath: paths.journal,
      receiptPath: paths.phase,
      manifestPath: paths.manifest,
      expectedReceiptDirectory: receiptDirectory,
      revalidate: () => true,
      now: () => new Date(role === "source"
        ? "2026-09-13T12:10:00.000Z"
        : "2026-09-13T12:20:00.000Z"),
    });
    capabilities[role] = readDisposableRecoveryTeardownProvisionArtifacts({
      receiptPath: paths.phase,
      manifestPath: paths.manifest,
      expectedReceiptDirectory: receiptDirectory,
      role,
    });
  }
  return Object.freeze(capabilities);
}

function deploymentVersion(id, label, moduleHash, withoutModeHash) {
  return {
    version_id: id,
    script_etag: `${label}-etag`,
    upload_request_sha256: sha256(`${label}-request`),
    module_inventory_sha256: moduleHash,
    bindings_sha256: sha256(`${label}-bindings`),
    bindings_without_mode_sha256: withoutModeHash,
    upload_response_evidence_manifest_sha256: sha256(`${label}-response`),
    version_readback_evidence_manifest_sha256: sha256(`${label}-readback`),
  };
}

function deploymentTraffic(id, versionId, label) {
  return {
    deployment_id: id,
    version_id: versionId,
    traffic_percent: 100,
    deployment_request_sha256: sha256(`${label}-request`),
    deployment_response_evidence_manifest_sha256:
      sha256(`${label}-response`),
    deployment_readback_evidence_manifest_sha256:
      sha256(`${label}-readback`),
  };
}

function deploymentSnapshot(label, semantic) {
  const semanticSha256 = sha256(canonical(semantic));
  return {
    first_raw_evidence_manifest_sha256: sha256(`${label}-raw-1`),
    second_raw_evidence_manifest_sha256: sha256(`${label}-raw-2`),
    first_semantic_sha256: semanticSha256,
    second_semantic_sha256: semanticSha256,
    stable_semantic_sha256: semanticSha256,
  };
}

function deploymentNetworkIsolation(role) {
  return {
    worker_identity_proved: true,
    worker_identity_sha256: sha256(`${role}-worker-identity`),
    workers_dev_identity_proved: true,
    worker_previews_disabled: true,
    worker_cache_enabled: false,
    worker_extra_exports: 0,
    worker_tail_consumers: 0,
    worker_assets: false,
    worker_logpush: false,
    cron_triggers: 0,
    routes: 0,
    custom_domains: 0,
  };
}

function deploymentSemanticVersion(evidence) {
  return {
    bindings_sha256: evidence.bindings_sha256,
    bindings_without_mode_sha256: evidence.bindings_without_mode_sha256,
    handlers: ["fetch", "scheduled"],
    named_handlers_count: 0,
    script_etag: evidence.script_etag,
    version_id: evidence.version_id,
  };
}

function deploymentSemanticResource() {
  return {
    custom_domains_count: 0,
    d1_exists: true,
    d1_name_and_id_exact: true,
    previews_enabled: false,
    routes_count: 0,
    schedules_count: 0,
    vector_count: 0,
    vector_dimensions: 768,
    vector_metric: "cosine",
    vectorize_exists: true,
    vectorize_name_exact: true,
    worker_exists: true,
    workers_dev_enabled: true,
  };
}

function deploymentSourcePreflight(binding) {
  return {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
    kind: "source_preflight",
    status: "passed",
    completed_at: "2026-09-13T12:21:00.000Z",
    binding,
    planned_requests: {
      source_active_upload_sha256: sha256("a12-source-request"),
      source_active_deployment_sha256:
        sha256("a12-source-deployment-request"),
      seed_fixture_sha256: sha256("a12-seed-fixture-request"),
    },
    snapshot: deploymentSnapshot(
      "a12-source-preflight",
      { state: "source_preflight" },
    ),
  };
}

function deploymentSourcePhase(binding, sourcePreflightSha256) {
  const activeVersion = deploymentVersion(
    SOURCE_VERSION,
    "a12-source",
    sha256("a12-source-module"),
    sha256("a12-source-bindings-without-mode"),
  );
  const activeDeployment = deploymentTraffic(
    SOURCE_DEPLOYMENT,
    SOURCE_VERSION,
    "a12-source-deployment",
  );
  const value = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
    kind: "source_phase",
    status: "passed",
    completed_at: "2026-09-13T12:22:00.000Z",
    binding,
    source_preflight_receipt_sha256: sourcePreflightSha256,
    a2_approval_fingerprint: disposableRecoverySourceA2Fingerprint(
      binding,
      sourcePreflightSha256,
    ),
    journal: {
      run_id: binding.run_id,
      through_sequence: 4,
      event_count: 4,
      head_sha256: sha256("a12-source-journal-head"),
      event_manifest_sha256: sha256("a12-source-journal-manifest"),
    },
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version: activeVersion,
      active_deployment: activeDeployment,
    },
    final_snapshot: deploymentSnapshot(
      "a12-source-final",
      { state: "source_active" },
    ),
  };
  return value;
}

function seedBatchReceipt(documents, status) {
  return {
    created: status === "created" ? documents.length : 0,
    updated: 0,
    unchanged: status === "unchanged" ? documents.length : 0,
    refused: 0,
    failed: 0,
    total: documents.length,
    results: documents.map((document) => ({
      source_type: document.source_type,
      source_id: document.source_id,
      doc_uid: `${document.source_type}:${document.source_id}`,
      status,
      chunks: status === "created" ? 1 : 0,
    })),
  };
}

function seedInventory(complete) {
  if (!complete) {
    return {
      version: "0.4.8",
      backend: "d1",
      vector_drain_mode: "active",
      rows: [],
    };
  }
  return {
    version: "0.4.8",
    backend: "d1",
    vector_drain_mode: "active",
    vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
    vector_readiness: {
      ready: true,
      expected_vectors: 6_113,
      actual_vectors: 6_113,
      pending: 0,
      submitted: 0,
    },
    rows: [{
      source_type: "recovery_field_v048",
      documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      logical_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      stored_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      document_counts_exact: true,
      chunks: 6_113,
      chunk_counts_exact: true,
      total: 6_113,
      embedded: 6_113,
    }],
  };
}

async function createSeedReceipt(binding, sourcePhase, sourcePhaseSha256) {
  const base = {
    schema_version: 4,
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    field_receipt_sha256: binding.field_receipt_sha256,
    source_phase_receipt_sha256: sourcePhaseSha256,
    package_sha256: binding.package_sha256,
    package_file_count: binding.package_file_count,
    execution_inventory_sha256: binding.execution_inventory_sha256,
    installed_execution_inventory_sha256:
      binding.installed_execution_inventory_sha256,
    runner_sha256: sha256("a12-seed-runner"),
    seeder_sha256: sha256("a12-seeder"),
    content_fingerprint_helper_sha256:
      sha256("a12-content-fingerprint-helper"),
    source_manifest_fingerprint: binding.source_manifest_fingerprint,
    source_resource_fingerprint: binding.source_resource_fingerprint,
    source_phase_run_id: binding.run_id,
    source_a2_approval_fingerprint: sourcePhase.a2_approval_fingerprint,
    source_active_version_id: sourcePhase.source.active_version.version_id,
    source_script_etag: sourcePhase.source.active_version.script_etag,
    source_deployment_id: sourcePhase.source.active_deployment.deployment_id,
    runtime_contract_fingerprint: binding.runtime_contract_fingerprint,
    wrangler_wrapper_sha256: binding.wrangler_wrapper_sha256,
    wrangler_runtime_inventory_sha256:
      binding.wrangler_runtime_inventory_sha256,
    wrangler_entrypoint_sha256: binding.wrangler_entrypoint_sha256,
    node_executable_sha256: binding.node_executable_sha256,
  };
  const seedBinding = Object.freeze({
    ...base,
    execution_approval_fingerprint:
      disposableRecoverySeedExecutionApprovalFingerprint(base),
  });
  let inventoryReads = 0;
  let ingestCalls = 0;
  return seedDisposableRecoveryFixture({
    binding: seedBinding,
    readOpeningDirectD1: async () => ({
      document_count: 0,
      chunk_count: 0,
      fts_count: 0,
      pending_outbox: 0,
      failed_vectors: 0,
    }),
    verifyDeployment: async () => ({
      source_phase_receipt_sha256: sourcePhaseSha256,
      source_phase_run_id: binding.run_id,
      source_a2_approval_fingerprint: sourcePhase.a2_approval_fingerprint,
      source_resource_fingerprint: binding.source_resource_fingerprint,
      source_active_version_id: sourcePhase.source.active_version.version_id,
      source_script_etag: sourcePhase.source.active_version.script_etag,
      source_deployment_id: sourcePhase.source.active_deployment.deployment_id,
      source_active_traffic_percent: 100,
    }),
    ingestBatch: async (documents) => {
      const status = ingestCalls < DISPOSABLE_RECOVERY_SEED_BATCHES
        ? "created"
        : "unchanged";
      ingestCalls += 1;
      return seedBatchReceipt(documents, status);
    },
    readInventory: async () => seedInventory(++inventoryReads > 1),
    settleProjection: async () => {},
    readContentFingerprint: async () => ({
      content_fingerprint: sha256("a12-content"),
      document_count: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      chunk_count: 6_113,
      fts_count: 6_113,
      pending_outbox: 0,
      failed_vectors: 0,
    }),
    readIndependentProjection: async () => ({
      vectorize_vectors: 6_113,
      vector_dimensions: 768,
      vector_metric: "cosine",
      quarantined_vectors: 0,
      independent_control_plane: true,
    }),
    runRetrievalChecks: async () => ({
      supported_case_cited: true,
      unsupported_case_refused: true,
    }),
    now: () => new Date("2026-09-13T12:23:00.000Z"),
  });
}

function deploymentTargetPreflight(
  binding,
  sourcePhaseSha256,
  seedReceiptSha256,
  vectorizeMutationQuiescence,
) {
  return {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
    kind: "target_preflight",
    status: "passed",
    completed_at: "2026-09-13T12:23:30.000Z",
    binding,
    source_phase_receipt_sha256: sourcePhaseSha256,
    seed_receipt_sha256: seedReceiptSha256,
    vectorize_mutation_quiescence: vectorizeMutationQuiescence,
    planned_requests: {
      target_paused_upload_sha256: sha256("a12-paused-request"),
      target_active_upload_sha256: sha256("a12-active-request"),
      target_paused_deployment_sha256:
        sha256("a12-paused-deployment-request"),
    },
    snapshot: deploymentSnapshot(
      "a12-target-preflight",
      { state: "target_preflight" },
    ),
  };
}

function deploymentTargetPhase({
  binding,
  vectorizeMutationQuiescence,
  sourcePhase,
  sourcePhaseSha256,
  seedReceiptSha256,
  targetPreflightSha256,
}) {
  const sharedModule = sha256("a12-target-module");
  const sharedWithoutMode = sha256("a12-target-bindings-without-mode");
  const pausedVersion = deploymentVersion(
    "77777777-7777-4777-8777-777777777777",
    "a12-paused",
    sharedModule,
    sharedWithoutMode,
  );
  const activeVersion = deploymentVersion(
    TARGET_VERSION,
    "a12-active",
    sharedModule,
    sharedWithoutMode,
  );
  const sourceNetworkIsolation = deploymentNetworkIsolation("source");
  const targetNetworkIsolation = deploymentNetworkIsolation("target");
  const campaignInput = {
    source: {
      workerName: DISPOSABLE_TEARDOWN_NAMES.source,
      workerId: SOURCE_WORKER_ID,
      databaseId: SOURCE_D1,
      vectorizeIndexName: DISPOSABLE_TEARDOWN_NAMES.source,
      deploymentId: SOURCE_DEPLOYMENT,
      versionId: SOURCE_VERSION,
      scriptEtag: "a12-source-etag",
      reviewedGenerationSha256:
        sha256("a12-source-reviewed-generation"),
    },
    target: {
      workerName: DISPOSABLE_TEARDOWN_NAMES.target,
      workerId: TARGET_WORKER_ID,
      databaseId: TARGET_D1,
      vectorizeIndexName: DISPOSABLE_TEARDOWN_NAMES.target,
      paused: {
        deploymentId: TARGET_PAUSED_DEPLOYMENT,
        versionId: pausedVersion.version_id,
        scriptEtag: pausedVersion.script_etag,
        reviewedGenerationSha256:
          sha256("a12-target-paused-reviewed-generation"),
      },
      active: {
        deploymentId: TARGET_ACTIVE_DEPLOYMENT,
        versionId: activeVersion.version_id,
        scriptEtag: activeVersion.script_etag,
        reviewedGenerationSha256:
          sha256("a12-target-active-reviewed-generation"),
      },
    },
    sourceNetworkIsolation,
    targetNetworkIsolation,
    nonCampaignBindingText: "stable-binding",
  };
  const a4Campaign = createDisposableCampaignAuthorityFixture(campaignInput);
  const evaluatedCampaign = createDisposableCampaignAuthorityFixture({
    ...campaignInput,
    targetMode: "active",
  });
  const finalSemantic = {
    campaign_authority: a4Campaign.authority,
    campaign_custody: a4Campaign.custody,
    source: {
      active_deployment_id: sourcePhase.source.active_deployment.deployment_id,
      active_script_etag: sourcePhase.source.active_version.script_etag,
      active_traffic_percent: 100,
      active_version_id: sourcePhase.source.active_version.version_id,
      network_isolation: sourceNetworkIsolation,
      resource: deploymentSemanticResource(),
      resource_fingerprint: binding.source_resource_fingerprint,
      worker_generation: {
        schema_version: 1,
        worker_identity_proved: true,
        worker_generation_proved: true,
        worker_generation_sha256: a4Campaign.custody.roles.source
          .worker_protection.worker_generation_sha256,
      },
    },
    target: {
      active_version: deploymentSemanticVersion(activeVersion),
      network_isolation: targetNetworkIsolation,
      paused_deployment: {
        deployment_id: campaignInput.target.paused.deploymentId,
        traffic_percent: 100,
        version_id: pausedVersion.version_id,
      },
      paused_version: deploymentSemanticVersion(pausedVersion),
      resource: deploymentSemanticResource(),
      resource_fingerprint: binding.target_resource_fingerprint,
      worker_generation: {
        schema_version: 1,
        worker_identity_proved: true,
        worker_generation_proved: true,
        worker_generation_sha256: a4Campaign.custody.roles.target
          .worker_protection.worker_generation_sha256,
      },
    },
    vectorize_mutation_quiescence: vectorizeMutationQuiescence,
  };
  const receipt = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    kind: "target_phase",
    status: "passed",
    completed_at: "2026-09-13T12:24:00.000Z",
    binding,
    source_phase_receipt_sha256: sourcePhaseSha256,
    seed_receipt_sha256: seedReceiptSha256,
    target_preflight_receipt_sha256: targetPreflightSha256,
    a4_approval_fingerprint: disposableRecoveryTargetA4Fingerprint(
      binding,
      sourcePhaseSha256,
      seedReceiptSha256,
      targetPreflightSha256,
    ),
    vectorize_mutation_quiescence: vectorizeMutationQuiescence,
    journal: {
      run_id: binding.run_id,
      through_sequence: 6,
      event_count: 6,
      source_prefix_head_sha256: sourcePhase.journal.head_sha256,
      head_sha256: sha256("a12-target-journal-head"),
      event_manifest_sha256: sha256("a12-target-journal-manifest"),
    },
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version_id: sourcePhase.source.active_version.version_id,
      active_script_etag: sourcePhase.source.active_version.script_etag,
      active_deployment_id: sourcePhase.source.active_deployment.deployment_id,
    },
    target: {
      resource_fingerprint: binding.target_resource_fingerprint,
      paused_version: pausedVersion,
      active_version: activeVersion,
      paused_deployment: {
        deployment_id: TARGET_PAUSED_DEPLOYMENT,
        version_id: pausedVersion.version_id,
        traffic_percent: 100,
        deployment_request_sha256: sha256("a12-paused-deployment-request"),
        deployment_response_evidence_manifest_sha256:
          sha256("a12-paused-deployment-response"),
        deployment_readback_evidence_manifest_sha256:
          sha256("a12-paused-deployment-readback"),
      },
    },
    final_semantic: finalSemantic,
    final_snapshot: deploymentSnapshot("a12-target-final", finalSemantic),
  };
  return Object.freeze({
    receipt,
    a4Authority: a4Campaign.authority,
    evaluatedAuthority: evaluatedCampaign.authority,
  });
}

function recoveryClock(start) {
  let value = Date.parse(start);
  return () => {
    const result = new Date(value);
    value += 1000;
    return result;
  };
}

function recoveryEvidence(
  stage,
  context,
  fieldProof = null,
  vectorizeMutationQuiescenceSha256 = null,
  interruptionProof = null,
) {
  const artifactSha256 = sha256(ARTIFACT_BYTES);
  const schemaFingerprint = sha256("a12-schema");
  const aggregateFingerprint = sha256("a12-aggregate");
  const contentFingerprint = sha256("a12-content");
  const bankProof = {
    protocol: "bank-security-v1",
    reconciliation_at: "2026-09-13T12:25:00.000Z",
    rows: [],
  };
  const chunks = 6_113;
  return ({
    export_d1: {
      artifact_sha256: artifactSha256,
      artifact_bytes: ARTIFACT_BYTES.length,
    },
    verify_export: {
      artifact_sha256: artifactSha256,
      artifact_bytes: ARTIFACT_BYTES.length,
      integrity: "ok",
      schema_fingerprint: schemaFingerprint,
      aggregate_fingerprint: aggregateFingerprint,
      content_fingerprint: contentFingerprint,
      source_d1_deletion_state_fingerprint: HASH("f"),
      document_count: 6_001,
      chunk_count: chunks,
      fts_count: chunks,
    },
    prove_target_clean: {
      target_resource_fingerprint: context.targetResourceFingerprint,
      user_table_count: 0,
      vector_count: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
    },
    restore_d1: { artifact_sha256: artifactSha256, import_completed: true },
    verify_d1: {
      integrity: "ok",
      schema_fingerprint: schemaFingerprint,
      aggregate_fingerprint: aggregateFingerprint,
      content_fingerprint: contentFingerprint,
      document_count: 6_001,
      chunk_count: chunks,
      fts_count: chunks,
      non_bank_content_fingerprint: contentFingerprint,
      bank_security_fingerprint: sha256(canonical(bankProof)),
      bank_security_proof: bankProof,
    },
    reconcile_security: {
      integrity: "ok",
      schema_fingerprint: schemaFingerprint,
      aggregate_fingerprint: aggregateFingerprint,
      content_fingerprint: contentFingerprint,
      document_count: 6_001,
      chunk_count: chunks,
      fts_count: chunks,
      bank_protected: 0,
      bank_reauthorization_required: 0,
      bank_legacy_rewrap_required: 0,
      bank_unsupported_key_versions: 0,
    },
    rebuild_vectorize: {
      chunk_count: chunks,
      vector_count: chunks,
      pending_outbox: 0,
      failed_vectors: 0,
      ...(vectorizeMutationQuiescenceSha256 ? {
        vectorize_mutation_quiescence_sha256:
          vectorizeMutationQuiescenceSha256,
        vector_id_set_sha256: HASH("1"),
        vector_watermark_sha256: HASH("2"),
        vector_barrier_sha256: HASH("3"),
        promotion_intent_sha256: HASH("4"),
      } : {}),
      ...(fieldProof ? {
        source_phase_receipt_sha256: fieldProof.source_phase_receipt_sha256,
        deployment_receipt_sha256: fieldProof.deployment_receipt_sha256,
        seed_receipt_sha256: fieldProof.seed_receipt_sha256,
        bootstrap_interruption_checkpoint_sha256:
          interruptionProof?.checkpointSha256 ??
            sha256("a12-bootstrap-interruption"),
        bootstrap_resume_authorization_sha256:
          interruptionProof?.resumeSha256 ?? sha256("a12-bootstrap-resume"),
        bootstrap_promotion_authorization_sha256:
          interruptionProof?.promotionSha256 ??
            sha256("a12-bootstrap-promotion"),
      } : {}),
    },
    verify_health: { status: "pass", failure_count: 0, vector_backlog: 0 },
    verify_eval: {
      profile: "release",
      status: "pass",
      critical_failures: 0,
      unauthorized_retrievals: 0,
      final_d1_content_fingerprint: contentFingerprint,
      final_d1_deletion_state_fingerprint: HASH("9"),
      target_eval_llm_append: {
        schema_version: 1,
        kind: "v048_target_eval_llm_append_v1",
        before_rows: 2,
        appended_rows: 2,
        after_rows: 4,
        rag_think_rows: 1,
        rag_evidence_gate_rows: 1,
        transition_sha256: HASH("e"),
      },
      ...(vectorizeMutationQuiescenceSha256 ? {
        vectorize_mutation_quiescence_sha256:
          vectorizeMutationQuiescenceSha256,
      } : {}),
    },
  })[stage];
}

async function createA12(
  receiptDirectory,
  explicit,
  artifactDirectory,
  provisions,
  base,
  k0,
) {
  const quiescence = reviewVerifiedRecoveryVectorizeMutationQuiescence(
    explicit.sourceManifest,
    explicit.targetManifest,
  );
  const initialized = initializeVerifiedRecovery(
    explicit.sourceManifest,
    explicit.targetManifest,
    explicit.plan,
    explicit.state,
    {
      now: new Date("2026-09-13T12:21:00.000Z"),
      approveVectorizeMutationQuiescence:
        quiescence.vectorize_mutation_quiescence_sha256,
    },
  );
  const bindingBase = {
    ...base,
    schema_version: 2,
    run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    plan_fingerprint: initialized.plan.plan_fingerprint,
    keychain_binding_sha256: k0.proof.keychain_binding_sha256,
    source_manifest_fingerprint: initialized.plan.source_manifest_fingerprint,
    source_resource_fingerprint: initialized.plan.source_resource_fingerprint,
    target_manifest_fingerprint: initialized.plan.target_manifest_fingerprint,
    target_resource_fingerprint: initialized.plan.target_resource_fingerprint,
    runtime_contract_fingerprint: initialized.plan.runtime_contract_fingerprint,
  };
  const binding = Object.freeze({
    ...bindingBase,
    campaign_fingerprint:
      disposableRecoveryDeploymentCampaignFingerprint(bindingBase),
  });
  const vectorizeMutationQuiescence =
    disposableRecoveryVectorizeMutationQuiescenceClaim(
      binding,
      quiescence.vectorize_mutation_quiescence_sha256,
    );
  const sourcePreflight = deploymentSourcePreflight(binding);
  const sourcePreflightPath = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  );
  writePrivate(
    sourcePreflightPath,
    `${JSON.stringify(sourcePreflight, null, 2)}\n`,
  );
  const sourcePreflightSha256 = receiptSha256(sourcePreflight);
  const sourcePhase = deploymentSourcePhase(
    binding,
    sourcePreflightSha256,
  );
  const sourcePhasePath = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  );
  writePrivate(sourcePhasePath, `${JSON.stringify(sourcePhase, null, 2)}\n`);
  const sourcePhaseSha256 = receiptSha256(sourcePhase);
  const seedReceipt = await createSeedReceipt(
    binding,
    sourcePhase,
    sourcePhaseSha256,
  );
  const seedReceiptPath = join(receiptDirectory, SEED_RECEIPT_NAME);
  writePrivate(seedReceiptPath, `${JSON.stringify(seedReceipt, null, 2)}\n`);
  const seedReceiptSha256 = receiptSha256(seedReceipt);
  const targetPreflight = deploymentTargetPreflight(
    binding,
    sourcePhaseSha256,
    seedReceiptSha256,
    vectorizeMutationQuiescence,
  );
  const targetPreflightPath = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  );
  writePrivate(
    targetPreflightPath,
    `${JSON.stringify(targetPreflight, null, 2)}\n`,
  );
  const targetPreflightSha256 = receiptSha256(targetPreflight);
  const deploymentFixture = deploymentTargetPhase({
    binding,
    vectorizeMutationQuiescence,
    sourcePhase,
    sourcePhaseSha256,
    seedReceiptSha256,
    targetPreflightSha256,
  });
  const deployment = deploymentFixture.receipt;
  const deploymentPath = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  );
  writePrivate(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  const deploymentSha256 = receiptSha256(deployment);
  const adapters = Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [
    id,
    async (context) => recoveryEvidence(
      id,
      context,
      null,
      quiescence.vectorize_mutation_quiescence_sha256,
    ),
  ]));
  let checkpointState = initialized.state;
  try {
    await runVerifiedRecovery(initialized.plan, initialized.state, adapters, {
      clock: recoveryClock("2026-09-13T12:25:00.000Z"),
      revalidateManifests: async () => true,
      approveVectorizeMutationQuiescence:
        quiescence.vectorize_mutation_quiescence_sha256,
      persistState: async (state) => { checkpointState = state; },
      afterStageCheckpoint: async (stage) => {
        if (stage === "reconcile_security") throw new Error("fixture-checkpoint");
      },
    });
  } catch (error) {
    if (error.message !== "fixture-checkpoint") throw error;
  }
  const fieldProof = {
    schema_version: 1,
    kind: "v048_disposable_recovery_seed_bridge",
    candidate_sha: binding.candidate_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    source_phase_receipt_sha256: deployment.source_phase_receipt_sha256,
    deployment_receipt_sha256: deploymentSha256,
    seed_receipt_sha256: deployment.seed_receipt_sha256,
    fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
    seed_d1_content_fingerprint: sha256("a12-content"),
    expected_documents: 6_001,
    expected_chunks: 6_113,
    expected_fts: 6_113,
    seed_replay_unchanged_documents: 6_001,
    paired_stop_stage: "rebuild_vectorize",
  };
  const boundState = bindVerifiedRecoveryFieldProof(
    checkpointState,
    initialized.plan,
    fieldProof,
    { now: new Date("2026-09-13T12:38:00.000Z") },
  );
  const interruptionProof = createCompletedInterruptionProof({
    artifactDirectory,
    plan: initialized.plan,
    binding,
    fieldProof,
    sourcePreflightSha256,
    sourcePhaseSha256,
    seedReceipt,
    seedReceiptSha256,
    targetPreflightSha256,
    deploymentSha256,
  });
  const completingAdapters = Object.fromEntries(
    VERIFIED_RECOVERY_STAGES.map(({ id }) => [
      id,
      async (context) => recoveryEvidence(
        id,
        context,
        fieldProof,
        quiescence.vectorize_mutation_quiescence_sha256,
        interruptionProof,
      ),
    ]),
  );
  const completed = await runVerifiedRecovery(
    initialized.plan,
    boundState,
    completingAdapters,
    {
      clock: recoveryClock("2026-09-13T12:39:00.000Z"),
      revalidateManifests: async () => true,
      approveVectorizeMutationQuiescence:
        quiescence.vectorize_mutation_quiescence_sha256,
    },
  );
  if (completed.ok !== true) throw new Error("closeout fixture recovery failed");
  writeVerifiedRecoveryState(explicit.state, completed.state, initialized.plan);
  const stateSha256 = sha256(readFileSync(explicit.state));
  const goldenSha256 = sha256(readFileSync(explicit.golden));
  const targetEval = targetEvalReceipt(
    binding,
    stateSha256,
    goldenSha256,
    deploymentFixture,
  );
  const targetEvalPath = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  );
  writePrivate(targetEvalPath, `${JSON.stringify(targetEval, null, 2)}\n`);
  return Object.freeze({
    plan: initialized.plan,
    binding,
    sourcePreflight,
    sourcePreflightPath,
    sourcePreflightSha256,
    sourcePhase,
    sourcePhasePath,
    sourcePhaseSha256,
    seedReceipt,
    seedReceiptPath,
    seedReceiptSha256,
    targetPreflight,
    targetPreflightPath,
    targetPreflightSha256,
    deployment,
    deploymentPath,
    targetEval,
    targetEvalPath,
    targetEvalSha256: receiptSha256(targetEval),
    state: completed.state,
    stateSha256,
    interruptionProof,
    provisions,
  });
}

function targetEvalReceipt(
  binding,
  stateSha256,
  goldenSha256,
  campaignProtection,
) {
  const targetBinding = {
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    keychain_binding_sha256: binding.keychain_binding_sha256,
    campaign_fingerprint: binding.campaign_fingerprint,
    recovery_plan_fingerprint: binding.plan_fingerprint,
    recovery_state_sha256: stateSha256,
    golden_sha256: goldenSha256,
    source_resource_fingerprint: binding.source_resource_fingerprint,
    target_resource_fingerprint: binding.target_resource_fingerprint,
    active_worker_version_id: TARGET_VERSION,
  };
  return {
    schema_version: 1,
    kind: "v048_disposable_target_eval",
    status: "passed",
    completed_at: "2026-09-13T13:00:00.000Z",
    binding: targetBinding,
    campaign_protection: {
      a4_authority: campaignProtection.a4Authority,
      evaluated_authority: campaignProtection.evaluatedAuthority,
    },
    target: {
      resource_fingerprint: targetBinding.target_resource_fingerprint,
      worker_version_id: targetBinding.active_worker_version_id,
      mode: "active",
    },
    projection: {
      documents: 6_001,
      d1_chunks: 6_113,
      fts_rows: 6_113,
      vectorize_vectors: 6_113,
      pending_outbox: 0,
      failed_vectors: 0,
    },
    checks: {
      health: {
        status: "pass",
        version: "0.4.8",
        accepting_documents: true,
        before_snapshot_sha256: HASH("3"),
        after_snapshot_sha256: HASH("3"),
        active_version_unchanged: true,
        projection_unchanged: true,
      },
      eval_profile: "release",
      eval_status: "pass",
      critical_failures: 0,
      unauthorized_retrievals: 0,
      supported_marker_case: {
        direct_target_check: true,
        cited: true,
        citation_count: 1,
      },
      unsupported_case: { direct_target_check: true, refused: true },
    },
  };
}

function teardownReceipt(role, a12, provisions, wrapperSha256, sourceSha256 = null) {
  const source = role === "source";
  const resourceFingerprint = source
    ? a12.binding.source_resource_fingerprint
    : a12.binding.target_resource_fingerprint;
  const provision = provisions[role];
  const binding = {
    candidate_sha: a12.binding.candidate_sha,
    candidate_tree_sha: a12.binding.candidate_tree_sha,
    package_sha256: a12.binding.package_sha256,
    field_receipt_sha256: a12.binding.field_receipt_sha256,
    keychain_binding_sha256: a12.binding.keychain_binding_sha256,
    campaign_fingerprint: a12.binding.campaign_fingerprint,
    plan_fingerprint: a12.binding.plan_fingerprint,
    resource_fingerprint: resourceFingerprint,
    wrangler_wrapper_sha256: wrapperSha256,
    provision_receipt_sha256: provision.receiptSha256,
    provision_manifest_sha256: provision.manifestSha256,
    target_eval_receipt_sha256: a12.targetEvalSha256,
  };
  const fingerprints = source ? ["2", "3", "4"] : ["5", "6", "7"];
  const value = {
    schema_version: 1,
    kind: "v048_disposable_brain_teardown",
    role,
    status: "passed",
    binding,
    resource_fingerprint: resourceFingerprint,
    started_at: source
      ? "2026-09-13T13:01:00.000Z"
      : "2026-09-13T13:03:00.000Z",
    completed_at: source
      ? "2026-09-13T13:02:00.000Z"
      : "2026-09-13T13:04:00.000Z",
    target_eval_receipt_sha256: a12.targetEvalSha256,
    source_teardown_receipt_sha256: source ? null : sourceSha256,
    present_preview_sha256: source ? HASH("8") : HASH("9"),
    custody: {
      pagination_complete: true,
      incoming_references: {
        version_references: 0,
        service_bindings: 0,
        tail_consumers: 0,
      },
      routes: 0,
      custom_domains: 0,
      worker_schedule_passes: {
        present: {
          count: 0,
          exact_endpoint_status: 200,
          missing_code_sha256: null,
          schedules_sha256: sha256(canonical([])),
        },
        absent: {
          count: 0,
          exact_endpoint_status: 404,
          missing_code_sha256: WORKER_MISSING_CODE_SHA256,
          schedules_sha256: sha256(canonical([])),
        },
      },
      storage_inventory_passes: {
        d1: [0, 1].map(() => ({
          resource_kind: "d1",
          pagination_complete: true,
          entries_inspected: 1,
          matching_resources: 0,
          inventory_sha256: source ? HASH("a") : HASH("b"),
        })),
        vectorize: [0, 1].map(() => ({
          resource_kind: "vectorize",
          pagination_complete: true,
          entries_inspected: 1,
          matching_resources: 0,
          inventory_sha256: source ? HASH("c") : HASH("d"),
        })),
      },
      resources: ["worker", "vectorize", "d1"].map((kind, index) => ({
        kind,
        instance_fingerprint: HASH(fingerprints[index]),
      })),
    },
    actions: ["worker", "vectorize", "d1"].map((kind, index) => ({
      kind,
      instance_fingerprint: HASH(fingerprints[index]),
      request_sha256: HASH(String(index + (source ? 4 : 7))),
      transitions: ["planned", "sent_unconfirmed", "confirmed"],
      exact_endpoint_status: 404,
      missing_code_sha256: kind === "worker"
        ? WORKER_MISSING_CODE_SHA256
        : sha256(`missing-${role}-${kind}`),
      absence_authority: kind === "worker"
        ? "exact_id_404_code_10007"
        : "two_stable_exhaustive_account_inventories",
    })),
    absent_preview_sha256: source ? HASH("e") : HASH("f"),
    absence: { present: 0, absent: 3 },
  };
  assertDisposableRecoveryBrainTeardownReceipt(value, {
    role,
    expectedBinding: binding,
    expectedSourceTeardownReceiptSha256: source ? null : sourceSha256,
  });
  return value;
}

function runtimeValues(k0) {
  return new Map(CLOSEOUT_FIXTURE_REFERENCES.map((reference) => {
    const value = k0.keychain.values.get(reference);
    if (!Buffer.isBuffer(value)) throw new Error("closeout fixture K0 missing");
    return [reference, Buffer.from(value)];
  }));
}

export function createInMemoryCloseoutRuntime(fixture, {
  states = Array(4).fill("present"),
  sharedTokenPresent = true,
  onInspect = async () => {},
  onRead = async () => {},
  onDelete = async () => {},
  onSharedToken = async () => {},
  now = () => new Date("2026-09-13T13:05:00.000Z"),
  onDeletionTransition = async () => {},
  onFinalizationTransition = () => {},
  onAnchorTransition = () => {},
} = {}) {
  const values = runtimeValues(fixture.k0);
  const status = new Map(CLOSEOUT_FIXTURE_REFERENCES.map((reference, index) => [
    reference,
    states[index],
  ]));
  const events = [];
  const referenceFor = (locator) => locator?.reference;
  const implementation = {
    async inspect(locator) {
      const reference = referenceFor(locator);
      if (!status.has(reference)) throw new Error("unexpected fixture locator");
      events.push(["inspect", reference]);
      await onInspect({ reference, status, events });
      return status.get(reference);
    },
    async read(locator) {
      const reference = referenceFor(locator);
      if (!values.has(reference)) throw new Error("unexpected fixture locator");
      events.push(["read", reference]);
      await onRead({ reference, status, values, events });
      return status.get(reference) === "item_not_found"
        ? null
        : Buffer.from(values.get(reference));
    },
    async delete(locator) {
      const reference = referenceFor(locator);
      if (!status.has(reference)) throw new Error("unexpected fixture locator");
      events.push(["delete", reference]);
      await onDelete({ reference, status, events });
      status.set(reference, "item_not_found");
      return true;
    },
    async sharedTokenPresent() {
      events.push(["shared-token", CLOSEOUT_FIXTURE_ACCOUNT_ID]);
      await onSharedToken({ status, values, events });
      return sharedTokenPresent;
    },
  };
  return Object.freeze({
    implementation,
    status,
    values,
    events,
    now,
    onDeletionTransition,
    onFinalizationTransition,
    onAnchorTransition,
  });
}

export async function createDisposableRecoveryCloseoutFixture({
  prefix = "brain-v048-closeout-genuine-",
  includeK0ResetHistory = false,
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  if (process.platform !== "win32") chmodSync(root, 0o700);
  const receiptDirectory = privateDirectory(join(root, "receipts"));
  const explicitDirectory = privateDirectory(join(root, "explicit"));
  const artifactDirectory = privateDirectory(join(root, "artifacts"));
  const explicit = Object.freeze({
    sourceManifest: join(receiptDirectory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_manifest),
    targetManifest: join(receiptDirectory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_manifest),
    plan: join(explicitDirectory, "verified-recovery-plan.json"),
    state: join(explicitDirectory, "verified-recovery-state.json"),
    wranglerWrapper: join(explicitDirectory, "wrangler-wrapper"),
    golden: join(explicitDirectory, "verified-recovery-golden.json"),
    fieldReceipt: join(explicitDirectory, "field-receipt.json"),
    package: join(explicitDirectory, "brain-installer-0.4.8.tgz"),
  });
  writePrivate(explicit.wranglerWrapper, "#!/bin/sh\nexit 1\n");
  writePrivate(explicit.golden, "{}\n");
  writePrivate(explicit.fieldReceipt, "{\"fixture\":\"field-receipt\"}\n");
  writePrivate(explicit.package, "fixture-package-bytes\n");
  writePrivate(
    join(artifactDirectory, ".brain-recovery-export.sql.fbrenc"),
    ARTIFACT_BYTES,
  );
  const base = preparationBinding(explicit);
  const k0Binding = Object.freeze({
    candidate_sha: base.candidate_sha,
    candidate_tree_sha: base.candidate_tree_sha,
    package_sha256: base.package_sha256,
    field_receipt_sha256: base.field_receipt_sha256,
    account_id: CLOSEOUT_FIXTURE_ACCOUNT_ID,
  });
  const k0 = await createTestDisposableRecoveryK0Capability(k0Binding);
  const k0Path = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  );
  copyFileSync(
    join(k0.directory, DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME),
    k0Path,
  );
  if (process.platform !== "win32") chmodSync(k0Path, 0o600);
  const k0ResetHistory = includeK0ResetHistory
    ? await createK0ResetHistory({
        receiptDirectory,
        receiptPath: k0Path,
        binding: k0Binding,
        k0,
      })
    : null;
  const provisions = await createProvisions(receiptDirectory, base, k0);
  const a12 = await createA12(
    receiptDirectory,
    explicit,
    artifactDirectory,
    provisions,
    base,
    k0,
  );
  const source = teardownReceipt(
    "source",
    a12,
    provisions,
    base.wrangler_wrapper_sha256,
  );
  const sourcePath = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
  );
  writePrivate(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  const sourceSha256 = receiptSha256(source);
  const target = teardownReceipt(
    "target",
    a12,
    provisions,
    base.wrangler_wrapper_sha256,
    sourceSha256,
  );
  const targetPath = join(
    receiptDirectory,
    DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME,
  );
  writePrivate(targetPath, `${JSON.stringify(target, null, 2)}\n`);
  for (const name of DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES) {
    const path = join(receiptDirectory, name);
    if (!existsSync(path)) writePrivate(path, `${JSON.stringify({ fixture: name })}\n`);
  }
  const readerOptions = Object.freeze({
    accountId: CLOSEOUT_FIXTURE_ACCOUNT_ID,
    expectedReceiptDirectory: receiptDirectory,
    sourceManifestPath: explicit.sourceManifest,
    targetManifestPath: explicit.targetManifest,
    planPath: explicit.plan,
    statePath: explicit.state,
    artifactDirectory,
    wranglerWrapperPath: explicit.wranglerWrapper,
    goldenPath: explicit.golden,
    fieldReceiptPath: explicit.fieldReceipt,
    packagePath: explicit.package,
  });
  const evidenceCapability = await readDisposableRecoveryFieldCloseoutEvidence(
    readerOptions,
  );
  return Object.freeze({
    root,
    receiptDirectory,
    explicitDirectory,
    artifactDirectory,
    explicit,
    base,
    k0,
    k0ResetHistory,
    provisions,
    a12,
    source,
    target,
    readerOptions,
    evidenceCapability,
    deploymentReceiptNames: DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES,
  });
}

/** Clone the already-generated immutable evidence set for an isolated test. */
export async function cloneDisposableRecoveryCloseoutFixture(
  source,
  { prefix = "brain-v048-closeout-clone-" } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  if (process.platform !== "win32") chmodSync(root, 0o700);
  const receiptDirectory = join(root, "receipts");
  const explicitDirectory = join(root, "explicit");
  const artifactDirectory = join(root, "artifacts");
  cpSync(source.receiptDirectory, receiptDirectory, { recursive: true });
  cpSync(source.explicitDirectory, explicitDirectory, { recursive: true });
  cpSync(source.artifactDirectory, artifactDirectory, { recursive: true });
  for (const directory of [receiptDirectory, explicitDirectory, artifactDirectory]) {
    if (process.platform !== "win32") chmodSync(directory, 0o700);
  }
  const explicit = Object.freeze({
    sourceManifest: join(receiptDirectory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_manifest),
    targetManifest: join(receiptDirectory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_manifest),
    plan: join(explicitDirectory, "verified-recovery-plan.json"),
    state: join(explicitDirectory, "verified-recovery-state.json"),
    wranglerWrapper: join(explicitDirectory, "wrangler-wrapper"),
    golden: join(explicitDirectory, "verified-recovery-golden.json"),
    fieldReceipt: join(explicitDirectory, "field-receipt.json"),
    package: join(explicitDirectory, "brain-installer-0.4.8.tgz"),
  });
  const readerOptions = Object.freeze({
    accountId: CLOSEOUT_FIXTURE_ACCOUNT_ID,
    expectedReceiptDirectory: receiptDirectory,
    sourceManifestPath: explicit.sourceManifest,
    targetManifestPath: explicit.targetManifest,
    planPath: explicit.plan,
    statePath: explicit.state,
    artifactDirectory,
    wranglerWrapperPath: explicit.wranglerWrapper,
    goldenPath: explicit.golden,
    fieldReceiptPath: explicit.fieldReceipt,
    packagePath: explicit.package,
  });
  const evidenceCapability = await readDisposableRecoveryFieldCloseoutEvidence(
    readerOptions,
  );
  return Object.freeze({
    ...source,
    root,
    receiptDirectory,
    explicitDirectory,
    artifactDirectory,
    explicit,
    readerOptions,
    evidenceCapability,
  });
}
