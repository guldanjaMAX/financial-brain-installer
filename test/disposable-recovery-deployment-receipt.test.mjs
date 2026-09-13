import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_LEGACY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
  assertDisposableRecoveryDeploymentBinding,
  assertDisposableRecoveryDeploymentReceipt,
  assertDisposableRecoveryDeploymentReceiptChain,
  assertDisposableRecoverySourcePhaseReceipt,
  assertDisposableRecoverySourcePreflightReceipt,
  assertDisposableRecoveryTargetPhaseReceipt,
  assertDisposableRecoveryTargetPreflightReceipt,
  assertLegacyDisposableRecoveryDeploymentReceipt,
  disposableRecoveryDeploymentCampaignFingerprint,
  disposableRecoverySourceA2Fingerprint,
  disposableRecoveryTargetA4Fingerprint,
  legacyDisposableRecoveryDeploymentApprovalFingerprint,
  readDisposableRecoveryDeploymentReceipt,
  readDisposableRecoverySourcePreflightReceipt,
} from "../operations/disposable-recovery-deployment-receipt.mjs";

function hash(index) {
  return Number(index).toString(16).padStart(64, "0");
}

function bindingFixture(runId = "10000000-0000-4000-8000-000000000001") {
  const base = {
    schema_version: 2,
    run_id: runId,
    plan_fingerprint: hash(1),
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    field_receipt_sha256: hash(2),
    field_receipt_run_id: "20000000-0000-4000-8000-000000000002",
    package_filename: "brain-installer-0.4.8.tgz",
    package_bytes: 123_456,
    package_sha256: hash(3),
    package_file_count: 541,
    execution_inventory_sha256: hash(4),
    installed_execution_inventory_sha256: hash(4),
    source_manifest_fingerprint: hash(5),
    source_resource_fingerprint: hash(6),
    target_manifest_fingerprint: hash(7),
    target_resource_fingerprint: hash(8),
    runtime_contract_fingerprint: hash(9),
    wrangler_version: "4.127.1",
    wrangler_wrapper_sha256: hash(10),
    wrangler_runtime_inventory_sha256: hash(11),
    wrangler_entrypoint_sha256: hash(12),
    node_version: "v22.22.0",
    node_executable_sha256: hash(13),
  };
  return {
    schema_version: 2,
    run_id: base.run_id,
    campaign_fingerprint:
      disposableRecoveryDeploymentCampaignFingerprint(base),
    ...Object.fromEntries(Object.entries(base).slice(2)),
  };
}

function snapshot(start) {
  return {
    first_raw_evidence_manifest_sha256: hash(start),
    second_raw_evidence_manifest_sha256: hash(start + 1),
    first_semantic_sha256: hash(start + 2),
    second_semantic_sha256: hash(start + 2),
    stable_semantic_sha256: hash(start + 2),
  };
}

function versionEvidence({
  bindings,
  id,
  module,
  request,
  response,
  readback,
  scriptEtag,
  withoutMode,
}) {
  return {
    version_id: id,
    script_etag: scriptEtag,
    upload_request_sha256: hash(request),
    module_inventory_sha256: hash(module),
    bindings_sha256: hash(bindings),
    bindings_without_mode_sha256: hash(withoutMode),
    upload_response_evidence_manifest_sha256: hash(response),
    version_readback_evidence_manifest_sha256: hash(readback),
  };
}

function deploymentEvidence({
  id,
  request,
  response,
  readback,
  versionId,
}) {
  return {
    deployment_id: id,
    version_id: versionId,
    traffic_percent: 100,
    deployment_request_sha256: hash(request),
    deployment_response_evidence_manifest_sha256: hash(response),
    deployment_readback_evidence_manifest_sha256: hash(readback),
  };
}

function chainFixture() {
  const binding = bindingFixture();
  const sourcePreflightSha256 = hash(100);
  const sourcePhaseSha256 = hash(101);
  const seedReceiptSha256 = hash(102);
  const targetPreflightSha256 = hash(103);
  const targetPhaseSha256 = hash(104);
  const sourcePreflight = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
    kind: "source_preflight",
    status: "passed",
    completed_at: "2026-09-12T01:00:00.000Z",
    binding,
    planned_requests: {
      source_active_upload_sha256: hash(110),
      source_active_deployment_sha256: hash(111),
      seed_fixture_sha256: hash(112),
    },
    snapshot: snapshot(120),
  };
  const sourcePhase = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
    kind: "source_phase",
    status: "passed",
    completed_at: "2026-09-12T01:05:00.000Z",
    binding,
    source_preflight_receipt_sha256: sourcePreflightSha256,
    a2_approval_fingerprint:
      disposableRecoverySourceA2Fingerprint(binding, sourcePreflightSha256),
    journal: {
      run_id: binding.run_id,
      through_sequence: 4,
      event_count: 4,
      head_sha256: hash(130),
      event_manifest_sha256: hash(131),
    },
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version: versionEvidence({
        id: "source-version-1",
        scriptEtag: "\"source-etag\"",
        request: 110,
        module: 132,
        bindings: 133,
        withoutMode: 134,
        response: 135,
        readback: 136,
      }),
      active_deployment: deploymentEvidence({
        id: "source-deployment-1",
        versionId: "source-version-1",
        request: 111,
        response: 137,
        readback: 138,
      }),
    },
    final_snapshot: snapshot(140),
  };
  const targetPreflight = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
    kind: "target_preflight",
    status: "passed",
    completed_at: "2026-09-12T01:10:00.000Z",
    binding,
    source_phase_receipt_sha256: sourcePhaseSha256,
    seed_receipt_sha256: seedReceiptSha256,
    planned_requests: {
      target_paused_upload_sha256: hash(150),
      target_active_upload_sha256: hash(151),
      target_paused_deployment_sha256: hash(152),
    },
    snapshot: snapshot(160),
  };
  const targetPhase = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    kind: "target_phase",
    status: "passed",
    completed_at: "2026-09-12T01:15:00.000Z",
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
    journal: {
      run_id: binding.run_id,
      through_sequence: 6,
      event_count: 6,
      source_prefix_head_sha256: sourcePhase.journal.head_sha256,
      head_sha256: hash(170),
      event_manifest_sha256: hash(171),
    },
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version_id: sourcePhase.source.active_version.version_id,
      active_script_etag: sourcePhase.source.active_version.script_etag,
      active_deployment_id: sourcePhase.source.active_deployment.deployment_id,
    },
    target: {
      resource_fingerprint: binding.target_resource_fingerprint,
      paused_version: versionEvidence({
        id: "target-paused-version-1",
        scriptEtag: "opaque-paused-etag",
        request: 150,
        module: 172,
        bindings: 173,
        withoutMode: 174,
        response: 175,
        readback: 176,
      }),
      active_version: versionEvidence({
        id: "target-active-version-1",
        scriptEtag: "opaque-active-etag",
        request: 151,
        module: 172,
        bindings: 177,
        withoutMode: 174,
        response: 178,
        readback: 179,
      }),
      paused_deployment: deploymentEvidence({
        id: "target-deployment-1",
        versionId: "target-paused-version-1",
        request: 152,
        response: 180,
        readback: 181,
      }),
    },
    final_snapshot: snapshot(190),
  };
  return {
    binding,
    sourcePreflightSha256,
    sourcePhaseSha256,
    seedReceiptSha256,
    targetPreflightSha256,
    targetPhaseSha256,
    sourcePreflight,
    sourcePhase,
    targetPreflight,
    targetPhase,
  };
}

function loaded(value, sha256) {
  return { value, sha256 };
}

function completeChain(fixture) {
  return {
    source_preflight:
      loaded(fixture.sourcePreflight, fixture.sourcePreflightSha256),
    source_phase: loaded(fixture.sourcePhase, fixture.sourcePhaseSha256),
    seed_receipt_sha256: fixture.seedReceiptSha256,
    target_preflight:
      loaded(fixture.targetPreflight, fixture.targetPreflightSha256),
    target_phase: loaded(fixture.targetPhase, fixture.targetPhaseSha256),
  };
}

function legacyFixture() {
  const base = {
    schema_version: 1,
    plan_fingerprint: hash(201),
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    field_receipt_sha256: hash(202),
    field_receipt_run_id: "30000000-0000-4000-8000-000000000003",
    package_filename: "brain-installer-0.4.8.tgz",
    package_bytes: 123_456,
    package_sha256: hash(203),
    package_file_count: 541,
    execution_inventory_sha256: hash(204),
    installed_execution_inventory_sha256: hash(204),
    source_manifest_fingerprint: hash(205),
    source_resource_fingerprint: hash(206),
    target_manifest_fingerprint: hash(207),
    target_resource_fingerprint: hash(208),
    runtime_contract_fingerprint: hash(209),
    wrangler_version: "4.127.1",
    wrangler_wrapper_sha256: hash(210),
    wrangler_runtime_inventory_sha256: hash(211),
    wrangler_entrypoint_sha256: hash(212),
    node_version: "v22.22.0",
    node_executable_sha256: hash(213),
  };
  const binding = {
    ...base,
    execution_approval_fingerprint:
      legacyDisposableRecoveryDeploymentApprovalFingerprint(base),
  };
  const version = (mode, id, bindings, withoutMode) => ({
    version_id: id,
    mode,
    script_etag: "legacy-etag-" + id,
    bindings_sha256: hash(bindings),
    bindings_without_mode_sha256: hash(withoutMode),
    code_exact: true,
    bindings_exact: true,
    resources_exact: true,
    compatibility_date: "2026-01-01",
    handlers: ["fetch", "scheduled"],
  });
  const resource = (fingerprint) => ({
    resource_fingerprint: fingerprint,
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
  });
  return {
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_LEGACY_DEPLOYMENT_PROTOCOL,
    status: "passed",
    completed_at: "2026-09-12T01:00:00.000Z",
    campaign: {
      release: "0.4.8",
      client_slug: "v048-field-proof",
      source_resource: "brain-test-v048-field-source-recovery-gate-a48f1101",
      target_resource: "brain-test-v048-field-target-recovery-gate-a48f1102",
    },
    binding,
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version: version(
        "active",
        "40000000-0000-4000-8000-000000000004",
        214,
        215,
      ),
      active_traffic_percent: 100,
      resource_contract: resource(binding.source_resource_fingerprint),
    },
    target: {
      resource_fingerprint: binding.target_resource_fingerprint,
      initially_paused: true,
      paused_version: version(
        "paused-for-upgrade",
        "50000000-0000-4000-8000-000000000005",
        216,
        217,
      ),
      active_version: version(
        "active",
        "60000000-0000-4000-8000-000000000006",
        218,
        217,
      ),
      paused_traffic_percent: 100,
      active_not_promoted: true,
      resource_contract: resource(binding.target_resource_fingerprint),
    },
    execution: {
      provider_calls: 12,
      fresh_wrapper_copy_per_call: true,
      copied_package_source_per_call: true,
      materialized_runtime_per_call: true,
      revalidated_before_and_after_each_call: true,
      package_execution_inventory_sha256: binding.execution_inventory_sha256,
      wrangler_wrapper_sha256: binding.wrangler_wrapper_sha256,
      wrangler_runtime_inventory_sha256:
        binding.wrangler_runtime_inventory_sha256,
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
}

test("strict v2 receipts and their full causal chain validate", () => {
  const fixture = chainFixture();
  assert.deepEqual(
    assertDisposableRecoveryDeploymentBinding(fixture.binding),
    fixture.binding,
  );
  assert.deepEqual(
    assertDisposableRecoverySourcePreflightReceipt(fixture.sourcePreflight),
    fixture.sourcePreflight,
  );
  assert.deepEqual(
    assertDisposableRecoverySourcePhaseReceipt(fixture.sourcePhase),
    fixture.sourcePhase,
  );
  assert.deepEqual(
    assertDisposableRecoveryTargetPreflightReceipt(fixture.targetPreflight),
    fixture.targetPreflight,
  );
  assert.deepEqual(
    assertDisposableRecoveryDeploymentReceipt(fixture.targetPhase),
    fixture.targetPhase,
  );
  assert.deepEqual(
    assertDisposableRecoveryDeploymentReceiptChain(completeChain(fixture))
      .seed_receipt_sha256,
    fixture.seedReceiptSha256,
  );
});

test("campaign identity is stable across run IDs but approvals are run-bound", () => {
  const first = bindingFixture();
  const second = bindingFixture("90000000-0000-4000-8000-000000000009");
  assert.equal(first.campaign_fingerprint, second.campaign_fingerprint);
  assert.notEqual(
    disposableRecoverySourceA2Fingerprint(first, hash(220)),
    disposableRecoverySourceA2Fingerprint(second, hash(220)),
  );
});

test("A2 and A4 are distinct and cannot satisfy one another", () => {
  const fixture = chainFixture();
  assert.notEqual(
    fixture.sourcePhase.a2_approval_fingerprint,
    fixture.targetPhase.a4_approval_fingerprint,
  );
  const sourceSwap = structuredClone(fixture.sourcePhase);
  sourceSwap.a2_approval_fingerprint =
    fixture.targetPhase.a4_approval_fingerprint;
  assert.throws(
    () => assertDisposableRecoverySourcePhaseReceipt(sourceSwap),
    /DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_INVALID/,
  );
  const targetSwap = structuredClone(fixture.targetPhase);
  targetSwap.a4_approval_fingerprint =
    fixture.sourcePhase.a2_approval_fingerprint;
  assert.throws(
    () => assertDisposableRecoveryTargetPhaseReceipt(targetSwap),
    /DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID/,
  );
});

test("link swaps and receipt replay fail closed", () => {
  const fixture = chainFixture();
  const swapped = structuredClone(fixture.targetPhase);
  [
    swapped.source_phase_receipt_sha256,
    swapped.seed_receipt_sha256,
  ] = [
    swapped.seed_receipt_sha256,
    swapped.source_phase_receipt_sha256,
  ];
  assert.throws(
    () => assertDisposableRecoveryTargetPhaseReceipt(swapped),
    /DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID/,
  );

  const replay = structuredClone(fixture.sourcePhase);
  replay.binding = bindingFixture("90000000-0000-4000-8000-000000000009");
  replay.journal.run_id = replay.binding.run_id;
  replay.a2_approval_fingerprint = disposableRecoverySourceA2Fingerprint(
    replay.binding,
    replay.source_preflight_receipt_sha256,
  );
  const replayChain = completeChain(fixture);
  replayChain.source_phase = loaded(replay, fixture.sourcePhaseSha256);
  assert.throws(
    () => assertDisposableRecoveryDeploymentReceiptChain(replayChain),
    /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_CHAIN_INVALID/,
  );
});

test("strict schemas reject extra and missing fields", () => {
  const fixture = chainFixture();
  for (const [validator, value] of [
    [assertDisposableRecoverySourcePreflightReceipt, fixture.sourcePreflight],
    [assertDisposableRecoverySourcePhaseReceipt, fixture.sourcePhase],
    [assertDisposableRecoveryTargetPreflightReceipt, fixture.targetPreflight],
    [assertDisposableRecoveryTargetPhaseReceipt, fixture.targetPhase],
  ]) {
    const extra = structuredClone(value);
    extra.unexpected = hash(230);
    assert.throws(() => validator(extra), /_INVALID/);
    const missing = structuredClone(value);
    delete missing.kind;
    assert.throws(() => validator(missing), /_INVALID/);
  }
});

test("v2 rejects caller self-attestation booleans at every depth", () => {
  const fixture = chainFixture();
  const topLevel = structuredClone(fixture.targetPhase);
  topLevel.accepted = true;
  assert.throws(
    () => assertDisposableRecoveryTargetPhaseReceipt(topLevel),
    /DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID/,
  );
  const nested = structuredClone(fixture.sourcePhase);
  nested.final_snapshot.provider_readback = true;
  assert.throws(
    () => assertDisposableRecoverySourcePhaseReceipt(nested),
    /DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_INVALID/,
  );
  const version = structuredClone(fixture.targetPhase);
  version.target.active_version.code_exact = true;
  assert.throws(
    () => assertDisposableRecoveryTargetPhaseReceipt(version),
    /DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID/,
  );
});

test("double-read semantic drift and non-independent manifests are refused", () => {
  const fixture = chainFixture();
  const drift = structuredClone(fixture.targetPhase);
  drift.final_snapshot.second_semantic_sha256 = hash(231);
  assert.throws(
    () => assertDisposableRecoveryTargetPhaseReceipt(drift),
    /DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID/,
  );
  const oneRead = structuredClone(fixture.sourcePreflight);
  oneRead.snapshot.second_raw_evidence_manifest_sha256 =
    oneRead.snapshot.first_raw_evidence_manifest_sha256;
  assert.throws(
    () => assertDisposableRecoverySourcePreflightReceipt(oneRead),
    /DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_INVALID/,
  );
});

test("final target receipt requires source, seed, and target-preflight hashes", () => {
  const fixture = chainFixture();
  for (const field of [
    "source_phase_receipt_sha256",
    "seed_receipt_sha256",
    "target_preflight_receipt_sha256",
  ]) {
    const missing = structuredClone(fixture.targetPhase);
    delete missing[field];
    assert.throws(
      () => assertDisposableRecoveryTargetPhaseReceipt(missing),
      /DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID/,
    );
  }
});

test("journal prefix, source pins, and planned request hashes are causal", () => {
  const fixture = chainFixture();
  const prefixDrift = completeChain(fixture);
  prefixDrift.target_phase =
    loaded(structuredClone(fixture.targetPhase), fixture.targetPhaseSha256);
  prefixDrift.target_phase.value.journal.source_prefix_head_sha256 = hash(240);
  assert.throws(
    () => assertDisposableRecoveryDeploymentReceiptChain(prefixDrift),
    /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_CHAIN_INVALID/,
  );

  const pinDrift = completeChain(fixture);
  pinDrift.target_phase =
    loaded(structuredClone(fixture.targetPhase), fixture.targetPhaseSha256);
  pinDrift.target_phase.value.source.active_version_id = "another-version";
  assert.throws(
    () => assertDisposableRecoveryDeploymentReceiptChain(pinDrift),
    /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_CHAIN_INVALID/,
  );

  const requestDrift = completeChain(fixture);
  requestDrift.source_phase =
    loaded(structuredClone(fixture.sourcePhase), fixture.sourcePhaseSha256);
  requestDrift.source_phase.value.source.active_version.upload_request_sha256 =
    hash(241);
  assert.throws(
    () => assertDisposableRecoveryDeploymentReceiptChain(requestDrift),
    /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_CHAIN_INVALID/,
  );
});

test("v1 validates only through explicit legacy fixture entry point", () => {
  const legacy = legacyFixture();
  assert.deepEqual(
    assertLegacyDisposableRecoveryDeploymentReceipt(legacy),
    legacy,
  );
  assert.throws(
    () => assertDisposableRecoveryDeploymentReceipt(legacy),
    /DISPOSABLE_RECOVERY_TARGET_PHASE_RECEIPT_INVALID/,
  );
  assert.throws(
    () => readDisposableRecoveryDeploymentReceipt(
      "/private/" + DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
      {
        readReceipt: () => ({
          value: legacy,
          sha256: hash(250),
          info: {},
        }),
      },
    ),
    /DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_READ_FAILED/,
  );
});

test("phase readers retain owner-only primitive boundary and exact filename", () => {
  const fixture = chainFixture();
  let called = 0;
  const readReceipt = (path, options) => {
    called += 1;
    assert.equal(
      path,
      "/private/" + DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
    );
    assert.equal(
      options.code,
      "DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_READ_FAILED",
    );
    assert.equal(options.maxBytes, 1024 * 1024);
    return {
      value: fixture.sourcePreflight,
      sha256: fixture.sourcePreflightSha256,
      info: { mode: 0o600 },
    };
  };
  const result = readDisposableRecoverySourcePreflightReceipt(
    "/private/" + DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
    { readReceipt },
  );
  assert.equal(called, 1);
  assert.equal(result.sha256, fixture.sourcePreflightSha256);
  assert.throws(
    () => readDisposableRecoverySourcePreflightReceipt(
      "/private/wrong-name.json",
      { readReceipt },
    ),
    /DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_READ_FAILED/,
  );
});
