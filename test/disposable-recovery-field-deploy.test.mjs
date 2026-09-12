import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  assertDisposableRecoveryDeploymentBinding,
  assertDisposableRecoveryDeploymentReceipt,
  disposableRecoveryDeploymentApprovalFingerprint,
  readDisposableRecoveryDeploymentReceipt,
} from "../operations/disposable-recovery-deployment-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
  runDisposableRecoveryFieldDeployment,
  disposableRecoveryDeploymentRequestPlan,
} from "../operations/disposable-recovery-field-deploy.mjs";
import { privateAggregateReceiptPendingPath } from
  "../operations/private-aggregate-receipt.mjs";

const H = (value) => value.repeat(64);
const SOURCE_VERSION = "10000000-0000-4000-8000-000000000001";
const PAUSED_VERSION = "20000000-0000-4000-8000-000000000002";
const ACTIVE_VERSION = "30000000-0000-4000-8000-000000000003";
const SOURCE_SCRIPT_ETAG = "source-etag-v048";
const PAUSED_SCRIPT_ETAG = "target-paused-etag-v048";
const ACTIVE_SCRIPT_ETAG = "target-active-etag-v048";

function bindingFixture() {
  const base = {
    schema_version: 1,
    plan_fingerprint: H("0"),
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    field_receipt_sha256: H("3"),
    field_receipt_run_id: "40000000-0000-4000-8000-000000000004",
    package_filename: "brain-installer-0.4.8.tgz",
    package_bytes: 123456,
    package_sha256: H("4"),
    package_file_count: 541,
    execution_inventory_sha256: H("5"),
    installed_execution_inventory_sha256: H("5"),
    source_manifest_fingerprint: H("6"),
    source_resource_fingerprint: H("7"),
    target_manifest_fingerprint: H("8"),
    target_resource_fingerprint: H("9"),
    runtime_contract_fingerprint: H("a"),
    wrangler_version: "4.127.1",
    wrangler_wrapper_sha256: H("b"),
    wrangler_runtime_inventory_sha256: H("c"),
    wrangler_entrypoint_sha256: H("d"),
    node_version: "v22.22.0",
    node_executable_sha256: H("e"),
  };
  return Object.freeze({
    ...base,
    execution_approval_fingerprint:
      disposableRecoveryDeploymentApprovalFingerprint(base),
  });
}

function execution(binding) {
  return {
    schema_version: 1,
    fresh_call_directory: true,
    fresh_wrapper_copy: true,
    copied_package_source: true,
    package_execution_inventory_sha256: binding.execution_inventory_sha256,
    wrangler_wrapper_sha256: binding.wrangler_wrapper_sha256,
    wrangler_runtime_inventory_sha256: binding.wrangler_runtime_inventory_sha256,
    wrangler_entrypoint_sha256: binding.wrangler_entrypoint_sha256,
    node_executable_sha256: binding.node_executable_sha256,
    source_revalidated_before_and_after: true,
    wrapper_revalidated_before_and_after: true,
    runtime_revalidated_before_and_after: true,
  };
}

function version(mode, versionId) {
  const target = versionId !== SOURCE_VERSION;
  return {
    version_id: versionId,
    mode,
    script_etag: versionId === SOURCE_VERSION
      ? SOURCE_SCRIPT_ETAG
      : versionId === PAUSED_VERSION
        ? PAUSED_SCRIPT_ETAG
        : ACTIVE_SCRIPT_ETAG,
    bindings_sha256: mode === "paused-for-upgrade" ? H("1") :
      target ? H("2") : H("3"),
    bindings_without_mode_sha256: target ? H("4") : H("5"),
    code_exact: true,
    bindings_exact: true,
    resources_exact: true,
    compatibility_date: "2026-01-01",
    handlers: ["fetch", "scheduled"],
  };
}

function resource(binding, role) {
  return {
    resource_fingerprint: role === "source"
      ? binding.source_resource_fingerprint
      : binding.target_resource_fingerprint,
    worker_exists: true,
    d1_exists: true,
    vectorize_exists: true,
    d1_name_and_id_exact: true,
    vectorize_name_exact: true,
    vector_dimensions: 768,
    vector_metric: "cosine",
    workers_dev_enabled: true,
    routes_count: 0,
    custom_domains_count: 0,
    provider_readback: true,
  };
}

function providerHarness(binding, events, { failAt = null } = {}) {
  const envelope = (value) => ({ execution: execution(binding), value });
  const record = (method, request, value) => {
    events.push({ method, request });
    if (events.length === failAt) throw new Error("ambiguous-provider-result");
    return envelope(value);
  };
  return {
    uploadVersion(request) {
      const id = request.role === "source" ? SOURCE_VERSION :
        request.mode === "paused-for-upgrade" ? PAUSED_VERSION : ACTIVE_VERSION;
      return record("uploadVersion", request, { version_id: id });
    },
    readVersion(request) {
      return record("readVersion", request, version(request.mode, request.version_id));
    },
    deployVersion(request) {
      return record("deployVersion", request, { accepted: true });
    },
    readDeployment(request) {
      const id = request.role === "source" ? SOURCE_VERSION : PAUSED_VERSION;
      return record("readDeployment", request, {
        versions: [{ version_id: id, percentage: 100 }],
      });
    },
    readResourceContract(request) {
      return record("readResourceContract", request, resource(binding, request.role));
    },
  };
}

function privateDirectory() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "v048-deployment-receipt-")));
  if (process.platform !== "win32") chmodSync(path, 0o700);
  return path;
}

test("deployment binding and review plan accept only the fixed campaign", () => {
  assert.equal(DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY, false);
  const binding = bindingFixture();
  assert.deepEqual(assertDisposableRecoveryDeploymentBinding(binding), binding);
  const plan = disposableRecoveryDeploymentRequestPlan(binding);
  assert.equal(plan.length, 12);
  assert.deepEqual(plan.map((entry) => `${entry.operation}:${entry.role}:${entry.mode}`), [
    "upload_version:source:active",
    "read_version:source:active",
    "deploy_version:source:active",
    "read_deployment:source:null",
    "read_resource_contract:source:null",
    "upload_version:target:paused-for-upgrade",
    "read_version:target:paused-for-upgrade",
    "upload_version:target:active",
    "read_version:target:active",
    "deploy_version:target:paused-for-upgrade",
    "read_deployment:target:null",
    "read_resource_contract:target:null",
  ]);
  assert.equal(plan.some((entry) =>
    Object.keys(entry).some((key) =>
      /^(?:account_id|worker_name|database_id|database_name|vectorize_index|domain|routes)$/u
        .test(key))), false);
  assert.throws(() => assertDisposableRecoveryDeploymentBinding({
    ...binding,
    package_filename: "other.tgz",
  }), /DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID/);
  assert.throws(() => assertDisposableRecoveryDeploymentBinding({
    ...binding,
    plan_fingerprint: H("f"),
  }), /DISPOSABLE_RECOVERY_DEPLOYMENT_BINDING_INVALID/);
});

test("provider creation follows both durable markers and exact readback finalizes", {
  skip: process.platform !== "darwin",
}, async () => {
  const directory = privateDirectory();
  const receiptPath = join(directory, DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME);
  const pendingPath = privateAggregateReceiptPendingPath(receiptPath);
  const binding = bindingFixture();
  const events = [];
  let revalidations = 0;
  try {
    const result = await runDisposableRecoveryFieldDeployment({
      binding,
      receiptPath,
      expectedReceiptDirectory: directory,
      revalidate: async () => { revalidations += 1; return true; },
      now: () => new Date("2026-09-12T12:00:00.000Z"),
      createProvider: async () => {
        assert.equal(existsSync(receiptPath), true,
          "the reserved final marker must precede provider creation");
        assert.equal(existsSync(pendingPath), true,
          "the explicit pending marker must precede provider creation");
        return providerHarness(binding, events);
      },
    });
    assert.equal(events.length, 12);
    assert.ok(revalidations >= 27);
    assert.equal(existsSync(pendingPath), false);
    assert.equal(result.receipt.source.active_version.version_id, SOURCE_VERSION);
    assert.equal(result.receipt.target.paused_version.version_id, PAUSED_VERSION);
    assert.equal(result.receipt.target.active_version.version_id, ACTIVE_VERSION);
    assert.equal(result.receipt.source.active_version.script_etag, SOURCE_SCRIPT_ETAG);
    assert.equal(result.receipt.target.paused_version.script_etag, PAUSED_SCRIPT_ETAG);
    assert.equal(result.receipt.target.active_version.script_etag, ACTIVE_SCRIPT_ETAG);
    assertDisposableRecoveryDeploymentReceipt(result.receipt);
    const loaded = readDisposableRecoveryDeploymentReceipt(receiptPath);
    assert.equal(loaded.sha256, result.receiptSha256);
    assert.equal(loaded.value.execution.provider_calls, 12);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ambiguous provider result retains both owner-only markers", {
  skip: process.platform !== "darwin",
}, async () => {
  const directory = privateDirectory();
  const receiptPath = join(directory, DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME);
  const pendingPath = privateAggregateReceiptPendingPath(receiptPath);
  const binding = bindingFixture();
  const events = [];
  try {
    await assert.rejects(runDisposableRecoveryFieldDeployment({
      binding,
      receiptPath,
      expectedReceiptDirectory: directory,
      createProvider: async () => providerHarness(binding, events, { failAt: 8 }),
    }), /DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_AMBIGUOUS/);
    assert.equal(events.length, 8);
    assert.equal(existsSync(receiptPath), true);
    assert.equal(existsSync(pendingPath), true);
    const finalMarker = JSON.parse(readFileSync(receiptPath, "utf8"));
    const pendingMarker = JSON.parse(readFileSync(pendingPath, "utf8"));
    assert.deepEqual(finalMarker, pendingMarker);
    assert.equal(finalMarker.status, "provider_result_unconfirmed");
    assert.throws(() => readDisposableRecoveryDeploymentReceipt(receiptPath),
      /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_READ_FAILED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a negative evidence revalidation retains markers before provider creation", {
  skip: process.platform !== "darwin",
}, async () => {
  const directory = privateDirectory();
  const receiptPath = join(directory, DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME);
  const pendingPath = privateAggregateReceiptPendingPath(receiptPath);
  const binding = bindingFixture();
  let revalidations = 0;
  let providerCreated = false;
  try {
    await assert.rejects(runDisposableRecoveryFieldDeployment({
      binding,
      receiptPath,
      expectedReceiptDirectory: directory,
      revalidate: async () => {
        revalidations += 1;
        return revalidations === 1;
      },
      createProvider: async () => {
        providerCreated = true;
        return providerHarness(binding, []);
      },
    }), /DISPOSABLE_RECOVERY_DEPLOYMENT_EVIDENCE_CHANGED/);
    assert.equal(providerCreated, false);
    assert.equal(existsSync(receiptPath), true);
    assert.equal(existsSync(pendingPath), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt validation rejects unproved traffic and malformed per-version etags", () => {
  const binding = bindingFixture();
  const receipt = {
    schema_version: 1,
    protocol: "v048-disposable-recovery-deployment-v1",
    status: "passed",
    completed_at: "2026-09-12T12:00:00.000Z",
    campaign: {
      release: "0.4.8",
      client_slug: "v048-field-proof",
      source_resource: "brain-test-v048-field-source-recovery-gate-a48f1101",
      target_resource: "brain-test-v048-field-target-recovery-gate-a48f1102",
    },
    binding,
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version: version("active", SOURCE_VERSION),
      active_traffic_percent: 100,
      resource_contract: resource(binding, "source"),
    },
    target: {
      resource_fingerprint: binding.target_resource_fingerprint,
      initially_paused: true,
      paused_version: version("paused-for-upgrade", PAUSED_VERSION),
      active_version: version("active", ACTIVE_VERSION),
      paused_traffic_percent: 100,
      active_not_promoted: true,
      resource_contract: resource(binding, "target"),
    },
    execution: {
      provider_calls: 12,
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
  assert.doesNotThrow(() => assertDisposableRecoveryDeploymentReceipt(receipt));
  assert.throws(() => assertDisposableRecoveryDeploymentReceipt({
    ...receipt,
    source: { ...receipt.source, active_traffic_percent: 99 },
  }), /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID/);
  assert.throws(() => assertDisposableRecoveryDeploymentReceipt({
    ...receipt,
    target: {
      ...receipt.target,
      active_version: { ...receipt.target.active_version, script_etag: "bad\netag" },
    },
  }), /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_INVALID/);
});
