import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  assertDisposableRecoveryDeploymentBinding,
  assertDisposableRecoveryDeploymentReceiptChain,
  assertDisposableRecoverySourcePhaseReceipt,
  assertDisposableRecoverySourcePreflightReceipt,
  assertDisposableRecoveryTargetPhaseReceipt,
  assertDisposableRecoveryTargetPreflightReceipt,
  disposableRecoveryDeploymentCampaignFingerprint,
  disposableRecoverySourceA2Fingerprint,
  disposableRecoveryTargetA4Fingerprint,
  readDisposableRecoveryDeploymentReceipt,
  readDisposableRecoverySourcePhaseReceipt,
  readDisposableRecoverySourcePreflightReceipt,
  readDisposableRecoveryTargetPreflightReceipt,
} from "../operations/disposable-recovery-deployment-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ENTRYPOINT_AVAILABLE,
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES,
  DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME,
  disposableRecoveryDeploymentRequestPlan,
  runDisposableRecoveryFieldDeployment,
  runDisposableRecoverySourcePhase,
  runDisposableRecoverySourcePreflight,
  runDisposableRecoveryTargetPhase,
  runDisposableRecoveryTargetPreflight,
} from "../operations/disposable-recovery-field-deploy.mjs";
import {
  disposableRecoveryDeploymentJournalSha256,
  readDisposableRecoveryDeploymentJournal,
  runJournaledDisposableRecoveryDeploymentMutation,
  summarizeDisposableRecoveryDeploymentJournal,
} from "../operations/disposable-recovery-deployment-journal.mjs";
import {
  DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION,
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  DISPOSABLE_RECOVERY_SEED_PROTOCOL,
  DISPOSABLE_RECOVERY_VECTOR_DIMENSIONS,
  DISPOSABLE_RECOVERY_VECTOR_METRIC,
  assertDisposableRecoverySeedReceipt,
  disposableRecoverySeedExecutionApprovalFingerprint,
} from "../operations/disposable-recovery-seeder.mjs";
import {
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptPendingPath,
  readPrivateAggregateReceipt,
  reservePrivateAggregateReceipt,
} from "../operations/private-aggregate-receipt.mjs";

const FIXED_DAY = "2026-09-12";
const MODULE_INVENTORY_SHA256 = digest("reviewed-module-inventory");
const SOURCE_VERSION_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_DEPLOYMENT_ID = "10000000-0000-4000-8000-000000000002";
const TARGET_PAUSED_VERSION_ID = "20000000-0000-4000-8000-000000000001";
const TARGET_ACTIVE_VERSION_ID = "30000000-0000-4000-8000-000000000001";
const TARGET_DEPLOYMENT_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_SCRIPT_ETAG = "source-active-etag-v048";
const TARGET_PAUSED_SCRIPT_ETAG = "target-paused-etag-v048";
const TARGET_ACTIVE_SCRIPT_ETAG = "target-active-etag-v048";

function digest(label) {
  return createHash("sha256").update(String(label)).digest("hex");
}

function bindingFixture(runId = "40000000-0000-4000-8000-000000000004") {
  const base = {
    schema_version: 2,
    run_id: runId,
    plan_fingerprint: digest("plan"),
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    field_receipt_sha256: digest("field-receipt"),
    field_receipt_run_id: "50000000-0000-4000-8000-000000000005",
    package_filename: "brain-installer-0.4.8.tgz",
    package_bytes: 123_456,
    package_sha256: digest("package"),
    package_file_count: 541,
    execution_inventory_sha256: digest("execution-inventory"),
    installed_execution_inventory_sha256: digest("execution-inventory"),
    source_manifest_fingerprint: digest("source-manifest"),
    source_resource_fingerprint: digest("source-resource"),
    target_manifest_fingerprint: digest("target-manifest"),
    target_resource_fingerprint: digest("target-resource"),
    runtime_contract_fingerprint: digest("runtime-contract"),
    wrangler_version: "4.131.1",
    wrangler_wrapper_sha256: digest("wrangler-wrapper"),
    wrangler_runtime_inventory_sha256: digest("wrangler-runtime"),
    wrangler_entrypoint_sha256: digest("wrangler-entrypoint"),
    node_version: "v22.22.0",
    node_executable_sha256: digest("node-executable"),
  };
  return Object.freeze({
    schema_version: 2,
    run_id: base.run_id,
    campaign_fingerprint:
      disposableRecoveryDeploymentCampaignFingerprint(base),
    ...Object.fromEntries(Object.entries(base).slice(2)),
  });
}

function privateDirectory(prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function artifactPaths(directory) {
  return Object.freeze({
    sourcePreflight: join(
      directory,
      DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
    ),
    sourcePhase: join(directory, DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME),
    sourceJournal: join(directory, DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME),
    seed: join(directory, DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.seed),
    targetPreflight: join(
      directory,
      DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
    ),
    targetPhase: join(directory, DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME),
    targetJournal: join(directory, DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME),
  });
}

function resource(binding, role, vectorCount) {
  return {
    custom_domains_count: 0,
    d1_exists: true,
    d1_name_and_id_exact: true,
    previews_enabled: false,
    routes_count: 0,
    schedules_count: 0,
    vector_count: vectorCount,
    vector_dimensions: 768,
    vector_metric: "cosine",
    vectorize_exists: true,
    vectorize_name_exact: true,
    worker_exists: true,
    workers_dev_enabled: true,
    resource_fingerprint: role === "source"
      ? binding.source_resource_fingerprint
      : binding.target_resource_fingerprint,
  };
}

function resourceContract(binding, role, vectorCount) {
  const { resource_fingerprint: _fingerprint, ...contract } =
    resource(binding, role, vectorCount);
  return contract;
}

function baseline(binding, role) {
  const prefix = role === "source" ? "60000000" : "70000000";
  return {
    baseline_deployment_id: `${prefix}-0000-4000-8000-000000000002`,
    baseline_script_etag: `${role}-baseline-etag-v048`,
    baseline_traffic_percent: 100,
    baseline_version_id: `${prefix}-0000-4000-8000-000000000001`,
    resource: resourceContract(binding, role, 0),
    resource_fingerprint: role === "source"
      ? binding.source_resource_fingerprint
      : binding.target_resource_fingerprint,
  };
}

const VERSION_EVIDENCE = Object.freeze({
  source: Object.freeze({
    bindings_sha256: digest("source-bindings"),
    bindings_without_mode_sha256: digest("source-bindings-without-mode"),
    script_etag: SOURCE_SCRIPT_ETAG,
    version_id: SOURCE_VERSION_ID,
  }),
  targetPaused: Object.freeze({
    bindings_sha256: digest("target-paused-bindings"),
    bindings_without_mode_sha256: digest("target-bindings-without-mode"),
    script_etag: TARGET_PAUSED_SCRIPT_ETAG,
    version_id: TARGET_PAUSED_VERSION_ID,
  }),
  targetActive: Object.freeze({
    bindings_sha256: digest("target-active-bindings"),
    bindings_without_mode_sha256: digest("target-bindings-without-mode"),
    script_etag: TARGET_ACTIVE_SCRIPT_ETAG,
    version_id: TARGET_ACTIVE_VERSION_ID,
  }),
});

function versionReadback(version) {
  return {
    bindings_sha256: version.bindings_sha256,
    bindings_without_mode_sha256: version.bindings_without_mode_sha256,
    handlers: ["fetch", "scheduled"],
    named_handlers_count: 0,
    script_etag: version.script_etag,
    version_id: version.version_id,
  };
}

function sourcePin(binding, vectorCount) {
  return {
    active_deployment_id: SOURCE_DEPLOYMENT_ID,
    active_script_etag: SOURCE_SCRIPT_ETAG,
    active_traffic_percent: 100,
    active_version_id: SOURCE_VERSION_ID,
    resource: resourceContract(binding, "source", vectorCount),
    resource_fingerprint: binding.source_resource_fingerprint,
  };
}

function providerHarness(binding, { failMutation = null } = {}) {
  const calls = [];
  const contexts = [];
  const state = { sourceVectors: 0 };

  const semanticFor = (request) => {
    if (request.stage === "source_preflight") {
      return { source: baseline(binding, "source") };
    }
    if (request.stage === "source_final") {
      return {
        source: {
          active_deployment: {
            deployment_id: SOURCE_DEPLOYMENT_ID,
            traffic_percent: 100,
            version_id: SOURCE_VERSION_ID,
          },
          active_version: versionReadback(VERSION_EVIDENCE.source),
          resource: resourceContract(binding, "source", state.sourceVectors),
          resource_fingerprint: binding.source_resource_fingerprint,
        },
      };
    }
    if (request.stage === "target_preflight") {
      return {
        source: sourcePin(binding, state.sourceVectors),
        target: baseline(binding, "target"),
      };
    }
    if (request.stage === "target_final") {
      return {
        source: sourcePin(binding, state.sourceVectors),
        target: {
          active_version: versionReadback(VERSION_EVIDENCE.targetActive),
          paused_deployment: {
            deployment_id: TARGET_DEPLOYMENT_ID,
            traffic_percent: 100,
            version_id: TARGET_PAUSED_VERSION_ID,
          },
          paused_version: versionReadback(VERSION_EVIDENCE.targetPaused),
          resource: resourceContract(binding, "target", 0),
          resource_fingerprint: binding.target_resource_fingerprint,
        },
      };
    }
    throw new Error("unexpected synthetic snapshot stage");
  };

  const uploadVersion = async (request, openingSemantic) => {
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(openingSemantic), true);
    const version = request.phase === "source"
      ? VERSION_EVIDENCE.source
      : request.mode === "paused-for-upgrade"
        ? VERSION_EVIDENCE.targetPaused
        : VERSION_EVIDENCE.targetActive;
    calls.push({ method: "uploadVersion", request, version_id: version.version_id });
    if (failMutation === `${request.phase}:upload_version:${request.mode}`) {
      throw new Error("synthetic ambiguous upload");
    }
    return {
      deployed: false,
      operation: "upload_version",
      request: {
        bindings_sha256: version.bindings_sha256,
        body_sha256: digest(`upload-body:${version.version_id}`),
        metadata_sha256: digest(`upload-metadata:${version.version_id}`),
        module_count: 3,
        module_inventory_sha256: request.module_inventory_sha256,
      },
      response: {
        body_sha256: digest(`upload-response:${version.version_id}`),
        content_type: "application/json",
        schema_version: 1,
        status: 200,
      },
      schema_version: 1,
      script_etag: version.script_etag,
      version_id: version.version_id,
    };
  };

  const deployVersion = async (request, versionId, openingSemantic) => {
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(openingSemantic), true);
    const deploymentId = request.phase === "source"
      ? SOURCE_DEPLOYMENT_ID
      : TARGET_DEPLOYMENT_ID;
    calls.push({ method: "deployVersion", request, version_id: versionId });
    if (failMutation === `${request.phase}:deploy_version:${request.mode}`) {
      throw new Error("synthetic ambiguous deployment");
    }
    return {
      accepted: true,
      deployment_id: deploymentId,
      operation: "deploy_version",
      percentage: 100,
      request_body_sha256: digest(`deploy-body:${deploymentId}`),
      response: {
        body_sha256: digest(`deploy-response:${deploymentId}`),
        content_type: "application/json; charset=utf-8",
        schema_version: 1,
        status: 200,
      },
      schema_version: 1,
      version_id: versionId,
    };
  };

  const readSnapshot = async (request) => {
    const semantic = semanticFor(request);
    calls.push({ method: "readSnapshot", request, semantic });
    return {
      evidence: [{
        body_sha256: digest(
          `snapshot:${request.phase}:${request.stage}:${request.read_ordinal}`,
        ),
        content_type: "application/json",
        operation: "read_snapshot_evidence",
        schema_version: 1,
        status: 200,
      }],
      phase: request.phase,
      read_ordinal: request.read_ordinal,
      schema_version: 1,
      semantic,
      stage: request.stage,
    };
  };

  return Object.freeze({
    calls,
    contexts,
    markSeeded() { state.sourceVectors = DISPOSABLE_RECOVERY_SEED_DOCUMENTS; },
    createProvider: async (_beforeBoundary, context) => {
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(context.binding), true);
      assert.equal(Object.isFrozen(context.requests), true);
      contexts.push(context);
      return Object.freeze({ deployVersion, readSnapshot, uploadVersion });
    },
  });
}

function seedReceiptFixture(binding, sourcePhaseLoaded) {
  const sourcePhase = sourcePhaseLoaded.value;
  const seedBindingBase = {
    schema_version: 4,
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    field_receipt_sha256: binding.field_receipt_sha256,
    source_phase_receipt_sha256: sourcePhaseLoaded.sha256,
    package_sha256: binding.package_sha256,
    package_file_count: binding.package_file_count,
    execution_inventory_sha256: binding.execution_inventory_sha256,
    installed_execution_inventory_sha256:
      binding.installed_execution_inventory_sha256,
    runner_sha256: digest("field-seed-runner"),
    seeder_sha256: digest("fixed-seeder"),
    content_fingerprint_helper_sha256: digest("content-fingerprint-helper"),
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
  const seedBinding = {
    ...seedBindingBase,
    execution_approval_fingerprint:
      disposableRecoverySeedExecutionApprovalFingerprint(seedBindingBase),
  };
  const receipt = {
    schema_version: 4,
    protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
    status: "passed",
    completed_at: `${FIXED_DAY}T12:02:00.000Z`,
    data_class: "deterministic_fictional_synthetic_only",
    binding: seedBinding,
    source_deployment: {
      source_phase_receipt_sha256: sourcePhaseLoaded.sha256,
      source_phase_run_id: binding.run_id,
      source_a2_approval_fingerprint: sourcePhase.a2_approval_fingerprint,
      source_resource_fingerprint: binding.source_resource_fingerprint,
      source_active_version_id: sourcePhase.source.active_version.version_id,
      source_script_etag: sourcePhase.source.active_version.script_etag,
      source_deployment_id: sourcePhase.source.active_deployment.deployment_id,
      source_active_traffic_percent: 100,
    },
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
      documents: 0,
      chunks: 0,
      fts: 0,
      pending_outbox: 0,
      failed_vectors: 0,
      independently_verified_empty: true,
    },
    d1: {
      worker_version: DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION,
      documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      chunks: DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
      fts: DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
      minimum_chunks: DISPOSABLE_RECOVERY_MINIMUM_D1_CHUNKS,
      document_counts_exact: true,
      chunk_counts_exact: true,
      minimum_chunk_count_met: true,
      pending_outbox: 0,
      failed_vectors: 0,
      content_fingerprint: digest("synthetic-d1-content"),
      content_fingerprint_source: "direct_d1_normalized_export",
    },
    projection: {
      vectorize_vectors: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      vector_dimensions: DISPOSABLE_RECOVERY_VECTOR_DIMENSIONS,
      vector_metric: DISPOSABLE_RECOVERY_VECTOR_METRIC,
      quarantined_vectors: 0,
      independent_control_plane: true,
    },
    evaluation: {
      supported_case_cited: true,
      unsupported_case_refused: true,
    },
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
  assert.equal(assertDisposableRecoverySeedReceipt(receipt), true);
  return receipt;
}

function persistPrivateReceipt(path, receipt) {
  const output = assertPrivateAggregateOutputPath(path);
  const reservation = reservePrivateAggregateReceipt(output, {
    schema_version: 1,
    kind: "synthetic_test_receipt_pending",
    status: "unconfirmed",
  });
  try {
    assert.equal(finalizePrivateAggregateReceipt(reservation, receipt), true);
  } catch (error) {
    abandonPrivateAggregateReceipt(reservation);
    throw error;
  }
  return readPrivateAggregateReceipt(path);
}

function phaseOptions(directory, paths, binding, harness) {
  return {
    sourcePreflight: {
      binding,
      moduleInventorySha256: MODULE_INVENTORY_SHA256,
      receiptPath: paths.sourcePreflight,
      expectedReceiptDirectory: directory,
      createProvider: harness.createProvider,
      now: () => `${FIXED_DAY}T12:00:00.000Z`,
    },
    sourcePhase: {
      binding,
      moduleInventorySha256: MODULE_INVENTORY_SHA256,
      sourcePreflightReceiptPath: paths.sourcePreflight,
      journalPath: paths.sourceJournal,
      receiptPath: paths.sourcePhase,
      expectedReceiptDirectory: directory,
      createProvider: harness.createProvider,
      now: () => `${FIXED_DAY}T12:01:00.000Z`,
    },
    targetPreflight: {
      binding,
      moduleInventorySha256: MODULE_INVENTORY_SHA256,
      sourcePhaseReceiptPath: paths.sourcePhase,
      seedReceiptPath: paths.seed,
      receiptPath: paths.targetPreflight,
      expectedReceiptDirectory: directory,
      createProvider: harness.createProvider,
      now: () => `${FIXED_DAY}T12:03:00.000Z`,
    },
    targetPhase: {
      binding,
      moduleInventorySha256: MODULE_INVENTORY_SHA256,
      sourcePhaseReceiptPath: paths.sourcePhase,
      seedReceiptPath: paths.seed,
      targetPreflightReceiptPath: paths.targetPreflight,
      journalPath: paths.targetJournal,
      receiptPath: paths.targetPhase,
      expectedReceiptDirectory: directory,
      createProvider: harness.createProvider,
      now: () => `${FIXED_DAY}T12:04:00.000Z`,
    },
  };
}

test("the public plan is the fixed five-request phased semantic plan", () => {
  assert.equal(DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY, false);
  assert.equal(DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ENTRYPOINT_AVAILABLE, true);
  const binding = bindingFixture();
  assert.deepEqual(assertDisposableRecoveryDeploymentBinding(binding), binding);

  const plan = disposableRecoveryDeploymentRequestPlan(
    binding,
    MODULE_INVENTORY_SHA256,
  );
  assert.deepEqual(Object.keys(plan), [
    "source_active_deployment",
    "source_active_upload",
    "target_active_upload",
    "target_paused_deployment",
    "target_paused_upload",
  ]);
  assert.deepEqual([
    plan.source_active_upload,
    plan.source_active_deployment,
    plan.target_paused_upload,
    plan.target_active_upload,
    plan.target_paused_deployment,
  ].map(({ phase, operation, role, mode }) =>
    `${phase}:${operation}:${role}:${mode}`), [
    "source:upload_version:source:active",
    "source:deploy_version:source:active",
    "target:upload_version:target:paused-for-upgrade",
    "target:upload_version:target:active",
    "target:deploy_version:target:paused-for-upgrade",
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.values(plan).every(Object.isFrozen), true);
  assert.equal(JSON.stringify(plan).includes(MODULE_INVENTORY_SHA256), true);
  assert.doesNotMatch(JSON.stringify(plan),
    /"(?:account_id|authorization|body|content|credentials|headers|modules|token)"\s*:/iu);
  assert.throws(
    () => disposableRecoveryDeploymentRequestPlan(binding),
    /DISPOSABLE_RECOVERY_DEPLOYMENT_HASH_INVALID/,
  );
});

test("source and target phases preserve separate approvals, journals, and exact receipt links", {
  skip: process.platform === "win32",
}, async () => {
  const directory = privateDirectory("v048-phased-deployment-");
  const paths = artifactPaths(directory);
  const binding = bindingFixture();
  const plan = disposableRecoveryDeploymentRequestPlan(binding, MODULE_INVENTORY_SHA256);
  const harness = providerHarness(binding);
  const options = phaseOptions(directory, paths, binding, harness);
  try {
    const sourcePreflightResult = await runDisposableRecoverySourcePreflight(
      options.sourcePreflight,
    );
    assert.equal(sourcePreflightResult.receipt.protocol,
      DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL);
    assert.equal(sourcePreflightResult.receipt.planned_requests
      .source_active_upload_sha256,
    disposableRecoveryDeploymentJournalSha256(plan.source_active_upload));
    assert.equal(sourcePreflightResult.receipt.planned_requests
      .source_active_deployment_sha256,
    disposableRecoveryDeploymentJournalSha256(plan.source_active_deployment));
    assert.equal(existsSync(paths.sourceJournal), false);
    assert.equal(existsSync(paths.targetJournal), false);
    assert.deepEqual(harness.calls.map(({ method }) => method), [
      "readSnapshot",
      "readSnapshot",
    ]);
    assert.deepEqual(harness.calls.map(({ request }) => request.read_ordinal), [1, 2]);

    const callsBeforeWrongA2 = harness.calls.length;
    await assert.rejects(
      runDisposableRecoverySourcePhase({
        ...options.sourcePhase,
        a2ApprovalFingerprint: digest("wrong-a2"),
      }),
      (error) => error?.code === "DISPOSABLE_RECOVERY_SOURCE_APPROVAL_INVALID",
    );
    assert.equal(harness.calls.length, callsBeforeWrongA2);
    assert.equal(existsSync(paths.sourcePhase), false);

    const sourcePreflightLoaded =
      readDisposableRecoverySourcePreflightReceipt(paths.sourcePreflight);
    assert.equal(sourcePreflightLoaded.sha256, sourcePreflightResult.receiptSha256);
    const a2ApprovalFingerprint = disposableRecoverySourceA2Fingerprint(
      binding,
      sourcePreflightLoaded.sha256,
    );
    const sourcePhaseResult = await runDisposableRecoverySourcePhase({
      ...options.sourcePhase,
      a2ApprovalFingerprint,
    });
    assert.equal(sourcePhaseResult.receipt.protocol,
      DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL);
    assert.equal(sourcePhaseResult.receipt.source_preflight_receipt_sha256,
      sourcePreflightLoaded.sha256);
    assert.equal(sourcePhaseResult.receipt.a2_approval_fingerprint,
      a2ApprovalFingerprint);
    assertDisposableRecoverySourcePreflightReceipt(sourcePreflightResult.receipt);
    assertDisposableRecoverySourcePhaseReceipt(sourcePhaseResult.receipt);

    const sourceRecords = readDisposableRecoveryDeploymentJournal(
      paths.sourceJournal,
      { expectedJournalDirectory: directory },
    );
    assert.equal(sourceRecords.length, 4);
    assert.deepEqual(sourceRecords.map(({ phase, step, record_type }) =>
      `${phase}:${step}:${record_type}`), [
      "source:upload_active_version:prepared",
      "source:upload_active_version:confirmed",
      "source:deploy_active_version:prepared",
      "source:deploy_active_version:confirmed",
    ]);
    assert.equal(sourceRecords[0].request_sha256,
      disposableRecoveryDeploymentJournalSha256(plan.source_active_upload));
    assert.equal(sourceRecords[2].request_sha256,
      disposableRecoveryDeploymentJournalSha256(plan.source_active_deployment));
    const sourceSummary = summarizeDisposableRecoveryDeploymentJournal(
      paths.sourceJournal,
      {
        expectedBinding: binding,
        expectedJournalDirectory: directory,
        expectedPhase: "source",
      },
    );
    assert.deepEqual(sourcePhaseResult.receipt.journal, {
      run_id: binding.run_id,
      through_sequence: sourceSummary.through_sequence,
      event_count: sourceSummary.event_count,
      head_sha256: sourceSummary.head_sha256,
      event_manifest_sha256: sourceSummary.event_manifest_sha256,
    });

    const sourcePhaseLoaded =
      readDisposableRecoverySourcePhaseReceipt(paths.sourcePhase);
    assert.equal(sourcePhaseLoaded.sha256, sourcePhaseResult.receiptSha256);
    const seedLoaded = persistPrivateReceipt(
      paths.seed,
      seedReceiptFixture(binding, sourcePhaseLoaded),
    );
    assert.equal(seedLoaded.value.binding.source_phase_receipt_sha256,
      sourcePhaseLoaded.sha256);
    harness.markSeeded();

    const targetPreflightResult = await runDisposableRecoveryTargetPreflight(
      options.targetPreflight,
    );
    assert.equal(targetPreflightResult.receipt.protocol,
      DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL);
    assert.equal(targetPreflightResult.receipt.source_phase_receipt_sha256,
      sourcePhaseLoaded.sha256);
    assert.equal(targetPreflightResult.receipt.seed_receipt_sha256, seedLoaded.sha256);
    assert.equal(targetPreflightResult.receipt.planned_requests
      .target_paused_upload_sha256,
    disposableRecoveryDeploymentJournalSha256(plan.target_paused_upload));
    assert.equal(targetPreflightResult.receipt.planned_requests
      .target_active_upload_sha256,
    disposableRecoveryDeploymentJournalSha256(plan.target_active_upload));
    assert.equal(targetPreflightResult.receipt.planned_requests
      .target_paused_deployment_sha256,
    disposableRecoveryDeploymentJournalSha256(plan.target_paused_deployment));
    assert.equal(existsSync(paths.targetJournal), false);
    assertDisposableRecoveryTargetPreflightReceipt(targetPreflightResult.receipt);

    const targetPreflightLoaded =
      readDisposableRecoveryTargetPreflightReceipt(paths.targetPreflight);
    assert.equal(targetPreflightLoaded.sha256,
      targetPreflightResult.receiptSha256);
    const callsBeforeWrongA4 = harness.calls.length;
    await assert.rejects(
      runDisposableRecoveryTargetPhase({
        ...options.targetPhase,
        a4ApprovalFingerprint: a2ApprovalFingerprint,
      }),
      (error) => error?.code === "DISPOSABLE_RECOVERY_TARGET_APPROVAL_INVALID",
    );
    assert.equal(harness.calls.length, callsBeforeWrongA4);
    assert.equal(existsSync(paths.targetPhase), false);

    const a4ApprovalFingerprint = disposableRecoveryTargetA4Fingerprint(
      binding,
      sourcePhaseLoaded.sha256,
      seedLoaded.sha256,
      targetPreflightLoaded.sha256,
    );
    assert.notEqual(a4ApprovalFingerprint, a2ApprovalFingerprint);
    const targetPhaseResult = await runDisposableRecoveryTargetPhase({
      ...options.targetPhase,
      a4ApprovalFingerprint,
    });
    assert.equal(targetPhaseResult.receipt.protocol,
      DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL);
    assert.equal(targetPhaseResult.receipt.source_phase_receipt_sha256,
      sourcePhaseLoaded.sha256);
    assert.equal(targetPhaseResult.receipt.seed_receipt_sha256, seedLoaded.sha256);
    assert.equal(targetPhaseResult.receipt.target_preflight_receipt_sha256,
      targetPreflightLoaded.sha256);
    assert.equal(targetPhaseResult.receipt.a4_approval_fingerprint,
      a4ApprovalFingerprint);
    assertDisposableRecoveryTargetPhaseReceipt(targetPhaseResult.receipt);

    const targetRecords = readDisposableRecoveryDeploymentJournal(
      paths.targetJournal,
      { expectedJournalDirectory: directory },
    );
    assert.equal(targetRecords.length, 6);
    assert.deepEqual(targetRecords.map(({ phase, step, record_type }) =>
      `${phase}:${step}:${record_type}`), [
      "target:upload_paused_version:prepared",
      "target:upload_paused_version:confirmed",
      "target:upload_active_version:prepared",
      "target:upload_active_version:confirmed",
      "target:deploy_paused_version:prepared",
      "target:deploy_paused_version:confirmed",
    ]);
    assert.deepEqual([
      targetRecords[0].request_sha256,
      targetRecords[2].request_sha256,
      targetRecords[4].request_sha256,
    ], [
      disposableRecoveryDeploymentJournalSha256(plan.target_paused_upload),
      disposableRecoveryDeploymentJournalSha256(plan.target_active_upload),
      disposableRecoveryDeploymentJournalSha256(plan.target_paused_deployment),
    ]);
    const targetSummary = summarizeDisposableRecoveryDeploymentJournal(
      paths.targetJournal,
      {
        expectedBinding: binding,
        expectedJournalDirectory: directory,
        expectedPhase: "target",
      },
    );
    assert.deepEqual(targetPhaseResult.receipt.journal, {
      run_id: binding.run_id,
      through_sequence: targetSummary.through_sequence,
      event_count: targetSummary.event_count,
      source_prefix_head_sha256: sourceSummary.head_sha256,
      head_sha256: targetSummary.head_sha256,
      event_manifest_sha256: targetSummary.event_manifest_sha256,
    });
    assert.notEqual(targetSummary.head_sha256, sourceSummary.head_sha256);
    assert.notEqual(targetSummary.event_manifest_sha256,
      sourceSummary.event_manifest_sha256);

    const targetPhaseLoaded =
      readDisposableRecoveryDeploymentReceipt(paths.targetPhase);
    assert.equal(targetPhaseLoaded.sha256, targetPhaseResult.receiptSha256);
    const chain = assertDisposableRecoveryDeploymentReceiptChain({
      source_preflight: sourcePreflightLoaded,
      source_phase: sourcePhaseLoaded,
      seed_receipt_sha256: seedLoaded.sha256,
      target_preflight: targetPreflightLoaded,
      target_phase: targetPhaseLoaded,
    });
    assert.equal(chain.source_phase.sha256, sourcePhaseLoaded.sha256);
    assert.equal(chain.target_phase.sha256, targetPhaseLoaded.sha256);

    assert.deepEqual(harness.contexts.map(({ stage }) => stage), [
      "source_preflight",
      "source_phase",
      "target_preflight",
      "target_phase",
    ]);
    assert.deepEqual(harness.calls
      .filter(({ method }) => method !== "readSnapshot")
      .map(({ method, request }) => `${request.phase}:${method}:${request.mode}`), [
      "source:uploadVersion:active",
      "source:deployVersion:active",
      "target:uploadVersion:paused-for-upgrade",
      "target:uploadVersion:active",
      "target:deployVersion:paused-for-upgrade",
    ]);
    for (const [phase, stage] of [
      ["source", "source_final"],
      ["target", "target_final"],
    ]) {
      const finalReads = harness.calls.filter(({ method, request }) =>
        method === "readSnapshot" && request.phase === phase &&
        request.stage === stage);
      assert.equal(finalReads.length, 2);
      assert.deepEqual(finalReads.map(({ request }) => request.read_ordinal), [1, 2]);
      assert.deepEqual(finalReads[0].semantic, finalReads[1].semantic);
      const finalReceipt = phase === "source"
        ? sourcePhaseResult.receipt.final_snapshot
        : targetPhaseResult.receipt.final_snapshot;
      assert.equal(finalReceipt.first_semantic_sha256,
        finalReceipt.second_semantic_sha256);
      assert.notEqual(finalReceipt.first_raw_evidence_manifest_sha256,
        finalReceipt.second_raw_evidence_manifest_sha256);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unconfirmed provider mutation remains ambiguous and cannot be blindly retried", {
  skip: process.platform === "win32",
}, async () => {
  const directory = privateDirectory("v048-phased-ambiguous-");
  const paths = artifactPaths(directory);
  const binding = bindingFixture("80000000-0000-4000-8000-000000000008");
  const harness = providerHarness(binding, {
    failMutation: "source:deploy_version:active",
  });
  const options = phaseOptions(directory, paths, binding, harness);
  try {
    const preflight = await runDisposableRecoverySourcePreflight(
      options.sourcePreflight,
    );
    const approval = disposableRecoverySourceA2Fingerprint(
      binding,
      preflight.receiptSha256,
    );
    await assert.rejects(
      runDisposableRecoverySourcePhase({
        ...options.sourcePhase,
        a2ApprovalFingerprint: approval,
      }),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS",
    );

    const mutationCalls = harness.calls.filter(({ method }) =>
      method === "uploadVersion" || method === "deployVersion");
    assert.deepEqual(mutationCalls.map(({ method }) => method), [
      "uploadVersion",
      "deployVersion",
    ]);
    const records = readDisposableRecoveryDeploymentJournal(paths.sourceJournal, {
      expectedJournalDirectory: directory,
    });
    assert.deepEqual(records.map(({ record_type, step, effect_state }) =>
      `${step}:${record_type}:${effect_state}`), [
      "upload_active_version:prepared:sent_unconfirmed",
      "upload_active_version:confirmed:confirmed",
      "deploy_active_version:prepared:sent_unconfirmed",
    ]);
    assert.equal(existsSync(paths.sourcePhase), true);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(paths.sourcePhase)), true);
    assert.equal(
      JSON.parse(readFileSync(paths.sourcePhase, "utf8")).status,
      "provider_result_unconfirmed",
    );

    const callsBeforeRetry = harness.calls.length;
    const factoriesBeforeRetry = harness.contexts.length;
    await assert.rejects(
      runDisposableRecoverySourcePhase({
        ...options.sourcePhase,
        a2ApprovalFingerprint: approval,
      }),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_DEPLOYMENT_RESUME_REQUIRED",
    );
    assert.equal(harness.calls.length, callsBeforeRetry);
    assert.equal(harness.contexts.length, factoriesBeforeRetry);
    assert.equal(harness.calls.filter(({ method }) => method === "deployVersion").length, 1);

    await assert.rejects(
      runDisposableRecoverySourcePhase({
        ...options.sourcePhase,
        a2ApprovalFingerprint: approval,
        resume: true,
      }),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS",
    );
    assert.equal(harness.calls.length, callsBeforeRetry,
      "explicit resume must adjudicate an ambiguous journal before provider I/O");
    assert.equal(harness.contexts.length, factoriesBeforeRetry);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit resume replays a confirmed prefix and continues only the next mutation", {
  skip: process.platform === "win32",
}, async () => {
  const directory = privateDirectory("v048-phased-resume-");
  const paths = artifactPaths(directory);
  const binding = bindingFixture("90000000-0000-4000-8000-000000000009");
  const harness = providerHarness(binding);
  const options = phaseOptions(directory, paths, binding, harness);
  let reservation;
  try {
    const preflight = await runDisposableRecoverySourcePreflight(
      options.sourcePreflight,
    );
    const approval = disposableRecoverySourceA2Fingerprint(
      binding,
      preflight.receiptSha256,
    );
    reservation = reservePrivateAggregateReceipt(
      assertPrivateAggregateOutputPath(paths.sourcePhase),
      {
        schema_version: 2,
        kind: "v048_disposable_recovery_source_phase_pending",
        status: "provider_result_unconfirmed",
        binding,
      },
    );
    abandonPrivateAggregateReceipt(reservation);
    const requests = disposableRecoveryDeploymentRequestPlan(
      binding,
      MODULE_INVENTORY_SHA256,
    );
    await runJournaledDisposableRecoveryDeploymentMutation({
      binding,
      effect: "create_worker_version",
      expectedJournalDirectory: directory,
      journalPath: paths.sourceJournal,
      mutate: async () => ({ version_id: SOURCE_VERSION_ID }),
      phase: "source",
      request: requests.source_active_upload,
      step: "upload_active_version",
      validate: async () => ({
        provider_metadata: {
          body_sha256: digest("resumed-source-upload-response"),
          content_type: "application/json",
          schema_version: 1,
          status: 200,
        },
        result: { version_id: SOURCE_VERSION_ID },
      }),
    });

    const result = await runDisposableRecoverySourcePhase({
      ...options.sourcePhase,
      a2ApprovalFingerprint: approval,
      resume: true,
    });
    assert.equal(result.receipt.status, "passed");
    assert.equal(existsSync(privateAggregateReceiptPendingPath(paths.sourcePhase)), false);
    assert.deepEqual(harness.calls
      .filter(({ method }) => method === "uploadVersion" || method === "deployVersion")
      .map(({ method }) => method), ["deployVersion"]);
    const records = readDisposableRecoveryDeploymentJournal(paths.sourceJournal, {
      expectedJournalDirectory: directory,
    });
    assert.equal(records.length, 4);
    assert.deepEqual(records[3].result, {
      accepted: true,
      deployment_id: SOURCE_DEPLOYMENT_ID,
      version_id: SOURCE_VERSION_ID,
    });
  } finally {
    if (reservation && !reservation.closed) abandonPrivateAggregateReceipt(reservation);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the legacy combined deployment runner is an unconditional refusal", async () => {
  await assert.rejects(
    runDisposableRecoveryFieldDeployment({
      createProvider: async () => {
        throw new Error("legacy runner must never create a provider");
      },
    }),
    (error) => error?.code ===
      "DISPOSABLE_RECOVERY_DEPLOYMENT_PHASE_SPLIT_REQUIRED",
  );
});
