import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DisposableRecoveryTargetEvalError,
  assertDisposableRecoveryTargetEvalBinding,
  disposableRecoveryTargetEvalApprovalFingerprint,
  runDisposableRecoveryTargetEvaluation,
} from "../operations/disposable-recovery-target-eval.mjs";
import {
  CloudflareRecoveryAdapterError,
  recoveryExportTables,
  validateDisposableRecoveryTargetSupportedResponse,
  validateDisposableRecoveryTargetUnsupportedResponse,
} from "../operations/cloudflare-recovery-adapter.mjs";
import {
  DISPOSABLE_RECOVERY_MARKER,
  disposableRecoveryFixture,
} from "../operations/disposable-recovery-seeder.mjs";
import {
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptCommitPath,
  reservePrivateAggregateReceipt,
} from "../operations/private-aggregate-receipt.mjs";
import {
  createTestDisposableRecoveryK0Capability,
} from "./helpers/disposable-recovery-k0-capability.mjs";
import {
  createDisposableCampaignAuthorityFixture,
} from "./helpers/disposable-campaign-authority.mjs";

const SOURCE_VERSION_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_DEPLOYMENT_ID = "10000000-0000-4000-8000-000000000002";
const TARGET_PAUSED_VERSION_ID = "20000000-0000-4000-8000-000000000001";
const TARGET_PAUSED_DEPLOYMENT_ID = "20000000-0000-4000-8000-000000000002";
const TARGET_ACTIVE_VERSION_ID = "30000000-0000-4000-8000-000000000001";
const TARGET_ACTIVE_DEPLOYMENT_ID = "30000000-0000-4000-8000-000000000002";

const keychainBinding = Object.freeze({
  candidate_sha: "1".repeat(40),
  candidate_tree_sha: "2".repeat(40),
  package_sha256: "3".repeat(64),
  field_receipt_sha256: "4".repeat(64),
  account_id: "e".repeat(32),
});
const K0 = await createTestDisposableRecoveryK0Capability(keychainBinding);
const binding = Object.freeze({
  candidate_sha: keychainBinding.candidate_sha,
  candidate_tree_sha: keychainBinding.candidate_tree_sha,
  package_sha256: keychainBinding.package_sha256,
  field_receipt_sha256: keychainBinding.field_receipt_sha256,
  campaign_fingerprint: "5".repeat(64),
  keychain_binding_sha256: K0.proof.keychain_binding_sha256,
  recovery_plan_fingerprint: "6".repeat(64),
  recovery_state_sha256: "7".repeat(64),
  golden_sha256: "8".repeat(64),
  source_resource_fingerprint: "9".repeat(64),
  target_resource_fingerprint: "a".repeat(64),
  active_worker_version_id: TARGET_ACTIVE_VERSION_ID,
});

function networkIsolation(role) {
  return {
    worker_identity_proved: true,
    worker_identity_sha256: `${role === "source" ? "b" : "c"}`.repeat(64),
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

function campaignAuthority(
  targetMode,
  nonCampaignBindingText = "stable-binding",
  overrides = {},
) {
  return createDisposableCampaignAuthorityFixture({
    source: {
      workerName: "brain-test-v048-field-source-recovery-gate-a48f1101",
      databaseId: "10000000-0000-4000-8000-000000000011",
      vectorizeIndexName:
        "brain-test-v048-field-source-recovery-gate-a48f1101",
      deploymentId: SOURCE_DEPLOYMENT_ID,
      versionId: SOURCE_VERSION_ID,
      scriptEtag: "source-etag-v048",
      reviewedGenerationSha256: "d".repeat(64),
    },
    target: {
      workerName: "brain-test-v048-field-target-recovery-gate-a48f1102",
      databaseId: "20000000-0000-4000-8000-000000000012",
      vectorizeIndexName:
        "brain-test-v048-field-target-recovery-gate-a48f1102",
      paused: {
        deploymentId: TARGET_PAUSED_DEPLOYMENT_ID,
        versionId: TARGET_PAUSED_VERSION_ID,
        scriptEtag: "target-paused-etag-v048",
        reviewedGenerationSha256: "e".repeat(64),
      },
      active: {
        deploymentId: TARGET_ACTIVE_DEPLOYMENT_ID,
        versionId: TARGET_ACTIVE_VERSION_ID,
        scriptEtag: "target-active-etag-v048",
        reviewedGenerationSha256: "f".repeat(64),
      },
    },
    sourceNetworkIsolation: networkIsolation("source"),
    targetNetworkIsolation: networkIsolation("target"),
    targetMode,
    nonCampaignBindingText,
    ...overrides,
  }).authority;
}

const A4_CAMPAIGN_AUTHORITY = campaignAuthority("paused");
const A12_CAMPAIGN_AUTHORITY = campaignAuthority("active");

function observation(overrides = {}) {
  return {
    target_resource_fingerprint: binding.target_resource_fingerprint,
    worker_version_id: binding.active_worker_version_id,
    mode: "active",
    health: { status: "pass", version: "0.4.8", accepting_documents: true },
    projection: {
      documents: 6_001,
      d1_chunks: 7_202,
      fts_rows: 7_202,
      vectorize_vectors: 7_202,
      pending_outbox: 0,
      failed_vectors: 0,
    },
    usage: { records: 4, max_id: 4 },
    snapshot_sha256: "b".repeat(64),
    ...overrides,
  };
}

function transport(overrides = {}) {
  return {
    observeCampaignAuthority: async () => A12_CAMPAIGN_AUTHORITY,
    observeTarget: async () => observation(),
    runReleaseEval: async () => ({
      profile: "release", status: "pass", critical_failures: 0,
      unauthorized_retrievals: 0,
    }),
    runSupportedCase: async () => ({ cited: true, citation_count: 2 }),
    runUnsupportedCase: async () => ({ refused: true }),
    ...overrides,
  };
}

function workspace() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "brain-target-eval-")));
  if (process.platform !== "win32") chmodSync(path, 0o700);
  return path;
}

async function run(path, overrides = {}) {
  return runDisposableRecoveryTargetEvaluation({
    binding,
    keychainBinding,
    keychainProof: K0.proof,
    a4CampaignAuthority: A4_CAMPAIGN_AUTHORITY,
    approvalFingerprint: disposableRecoveryTargetEvalApprovalFingerprint(binding),
    receiptPath: join(path, "v048-disposable-target-eval-receipt.json"),
    expectedReceiptDirectory: path,
    transport: transport(),
    revalidate: () => true,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  });
}

test("writes only the validated aggregate direct-target receipt", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  try {
    const events = [];
    const result = await run(path, {
      transport: transport({
        observeCampaignAuthority: async () => {
          events.push("campaign");
          return A12_CAMPAIGN_AUTHORITY;
        },
        observeTarget: async () => { events.push("observe"); return observation(); },
        runReleaseEval: async () => {
          events.push("eval");
          return { profile: "release", status: "pass", critical_failures: 0,
            unauthorized_retrievals: 0 };
        },
        runSupportedCase: async () => { events.push("supported"); return { cited: true, citation_count: 1 }; },
        runUnsupportedCase: async () => { events.push("unsupported"); return { refused: true }; },
      }),
    });
    assert.deepEqual(events, [
      "campaign", "observe", "eval", "supported", "unsupported", "observe",
      "campaign",
    ]);
    assert.equal(result.receipt.status, "passed");
    assert.equal(result.receipt.projection.documents, 6_001);
    const serialized = readFileSync(result.receipt ? join(path,
      "v048-disposable-target-eval-receipt.json") : "", "utf8");
    assert.doesNotMatch(serialized, /orchid|cobalt|question|answer|credential|provider_id/iu);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("rejects extra answer material before it can reach the receipt", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  try {
    await assert.rejects(
      () => run(path, {
        transport: transport({
          runSupportedCase: async () => ({
            cited: true, citation_count: 1, answer: "private answer text",
          }),
        }),
      }),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_SUPPORTED_CASE_FAILED",
    );
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("direct target answer validators require the exact marker and exact refusal", () => {
  const marker = disposableRecoveryFixture()[0];
  const cited = [{ source: marker.source_type, title: marker.title }];
  assert.deepEqual(validateDisposableRecoveryTargetSupportedResponse({
    mode: "think",
    answer: `The marker is ${DISPOSABLE_RECOVERY_MARKER}.`,
    citations: cited,
    evidence_gate: { supported: true, complete: true },
  }), { cited: true, citation_count: 1 });
  assert.throws(
    () => validateDisposableRecoveryTargetSupportedResponse({
      mode: "think",
      answer: "A plausible but unsupported invented value.",
      citations: cited,
      evidence_gate: { supported: true, complete: true },
    }),
    (error) => error instanceof CloudflareRecoveryAdapterError &&
      error.code === "RECOVERY_DIRECT_TARGET_SUPPORTED_CASE_FAILED",
  );
  assert.deepEqual(validateDisposableRecoveryTargetUnsupportedResponse({
    mode: "think",
    answer: "The documents do not answer the question.",
    citations: [],
    evidence_gate: { supported: false, complete: false },
  }), { refused: true });
  assert.throws(
    () => validateDisposableRecoveryTargetUnsupportedResponse({
      mode: "think",
      answer: "The documents do not answer the question.",
      citations: cited,
      evidence_gate: { supported: false, complete: false },
    }),
    (error) => error instanceof CloudflareRecoveryAdapterError &&
      error.code === "RECOVERY_DIRECT_TARGET_UNSUPPORTED_CASE_FAILED",
  );
  for (const body of [
    {
      mode: "think",
      answer: `The marker is ${DISPOSABLE_RECOVERY_MARKER}.`,
      citations: cited,
    },
    {
      mode: "think",
      answer: "The documents do not answer the question.",
      citations: [],
    },
  ]) {
    assert.throws(
      () => body.citations.length
        ? validateDisposableRecoveryTargetSupportedResponse(body)
        : validateDisposableRecoveryTargetUnsupportedResponse(body),
      (error) => error instanceof CloudflareRecoveryAdapterError,
    );
  }
});

test("target binding refuses collapsed identities and malformed provider versions", () => {
  for (const changed of [
    { candidate_tree_sha: binding.candidate_sha },
    { target_resource_fingerprint: binding.source_resource_fingerprint },
    { active_worker_version_id: "version_with_underscore" },
    { active_worker_version_id: "x" },
  ]) {
    assert.throws(
      () => assertDisposableRecoveryTargetEvalBinding({ ...binding, ...changed }),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_BINDING_INVALID",
    );
  }
});

test("target evaluation requires the exact K0 binding and an explicit revalidator", async () => {
  const path = workspace();
  try {
    for (const overrides of [
      { keychainBinding: undefined, keychainProof: K0.proof, revalidate: () => true },
      { keychainBinding, keychainProof: Object.freeze({ ...K0.proof }), revalidate: () => true },
      {
        keychainBinding: { ...keychainBinding, candidate_sha: "f".repeat(40) },
        keychainProof: K0.proof,
        revalidate: () => true,
      },
      { revalidate: undefined },
    ]) {
      await assert.rejects(
        runDisposableRecoveryTargetEvaluation({
          binding,
          keychainBinding,
          keychainProof: K0.proof,
          a4CampaignAuthority: A4_CAMPAIGN_AUTHORITY,
          approvalFingerprint:
            disposableRecoveryTargetEvalApprovalFingerprint(binding),
          receiptPath: join(path, "v048-disposable-target-eval-receipt.json"),
          expectedReceiptDirectory: path,
          transport: transport(),
          ...overrides,
        }),
        (error) => error instanceof DisposableRecoveryTargetEvalError &&
          error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_KEYCHAIN_BINDING_INVALID",
      );
    }
    const missing = { ...binding };
    delete missing.keychain_binding_sha256;
    assert.throws(
      () => assertDisposableRecoveryTargetEvalBinding(missing),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_BINDING_INVALID",
    );
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("forged or cross-bound K0 proof is refused before transport or reservation", async () => {
  if (process.platform === "win32") return;
  for (const candidate of [
    Object.freeze({ ...K0.proof }),
    (await createTestDisposableRecoveryK0Capability({
      ...keychainBinding,
      account_id: "f".repeat(32),
    })).proof,
  ]) {
    const path = workspace();
    let calls = 0;
    try {
      await assert.rejects(
        () => run(path, {
          keychainProof: candidate,
          transport: transport({
            observeTarget: async () => { calls += 1; return observation(); },
          }),
        }),
        (error) => error instanceof DisposableRecoveryTargetEvalError &&
          error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_KEYCHAIN_BINDING_INVALID",
      );
      assert.equal(calls, 0);
      assert.equal(existsSync(join(
        path,
        "v048-disposable-target-eval-receipt.json",
      )), false);
    } finally { rmSync(path, { recursive: true, force: true }); }
  }
});

test("changed K0 evidence stops the next target operation", async () => {
  if (process.platform === "win32") return;
  const localK0 = await createTestDisposableRecoveryK0Capability(keychainBinding);
  const localBinding = Object.freeze({
    ...binding,
    keychain_binding_sha256: localK0.proof.keychain_binding_sha256,
  });
  const path = workspace();
  let releaseCalls = 0;
  try {
    await assert.rejects(
      () => runDisposableRecoveryTargetEvaluation({
        binding: localBinding,
        keychainBinding,
        keychainProof: localK0.proof,
        a4CampaignAuthority: A4_CAMPAIGN_AUTHORITY,
        approvalFingerprint:
          disposableRecoveryTargetEvalApprovalFingerprint(localBinding),
        receiptPath: join(path, "v048-disposable-target-eval-receipt.json"),
        expectedReceiptDirectory: path,
        transport: transport({
          observeTarget: async () => {
            await localK0.keychain.adapter.delete({
              reference:
                "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
            });
            return observation();
          },
          runReleaseEval: async () => {
            releaseCalls += 1;
            return { profile: "release", status: "pass", critical_failures: 0,
              unauthorized_retrievals: 0 };
          },
        }),
        revalidate: () => true,
      }),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED",
    );
    assert.equal(releaseCalls, 0);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("the target-evaluation content snapshot excludes only the mutable usage ledger", () => {
  const migrations = [{ version: 46 }];
  const ordinary = recoveryExportTables(migrations);
  const evaluation = recoveryExportTables(migrations, { excludeLlmCallLog: true });
  assert.equal(ordinary.includes("llm_call_log"), true);
  assert.equal(evaluation.includes("llm_call_log"), false);
  assert.equal(evaluation.includes("documents"), true);
  assert.equal(evaluation.includes("chunks"), true);
  assert.deepEqual(
    evaluation,
    ordinary.filter((table) => table !== "llm_call_log"),
  );
});

test("fails closed when projection or active identity changes", async () => {
  if (process.platform === "win32") return;
  for (const changed of [
    observation({ snapshot_sha256: "c".repeat(64) }),
    observation({ worker_version_id: "other-version" }),
    observation({ projection: { ...observation().projection, vectorize_vectors: 7_201 } }),
  ]) {
    const path = workspace();
    let reads = 0;
    try {
      await assert.rejects(
        () => run(path, {
          transport: transport({
            observeTarget: async () => (++reads === 1 ? observation() : changed),
          }),
        }),
        (error) => error instanceof DisposableRecoveryTargetEvalError,
      );
    } finally { rmSync(path, { recursive: true, force: true }); }
  }
});

test("route or custom-domain drift stops A12 before evaluation", async () => {
  if (process.platform === "win32") return;
  for (const field of ["routes", "custom_domains"]) {
    const path = workspace();
    const changed = structuredClone(A12_CAMPAIGN_AUTHORITY);
    changed.network_isolation.target[field] = 1;
    changed.authority_sha256 = "0".repeat(64);
    let evalCalls = 0;
    try {
      await assert.rejects(
        () => run(path, {
          transport: transport({
            observeCampaignAuthority: async () => changed,
            runReleaseEval: async () => {
              evalCalls += 1;
              return { profile: "release", status: "pass", critical_failures: 0,
                unauthorized_retrievals: 0 };
            },
          }),
        }),
        (error) => error instanceof DisposableRecoveryTargetEvalError &&
          error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_CHANGED",
      );
      assert.equal(evalCalls, 0);
      const residue = JSON.parse(readFileSync(join(
        path,
        "v048-disposable-target-eval-receipt.json",
      ), "utf8"));
      assert.equal(residue.status, "read_only_evaluation_in_progress");
      assert.equal(Object.hasOwn(residue, "campaign_protection"), false);
    } finally { rmSync(path, { recursive: true, force: true }); }
  }
});

test("noncampaign binding drift across the A12 bracket leaves no receipt", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  const changed = campaignAuthority("active", "changed-binding");
  let censusReads = 0;
  let evalCalls = 0;
  try {
    await assert.rejects(
      () => run(path, {
        transport: transport({
          observeCampaignAuthority: async () =>
            ++censusReads === 1 ? A12_CAMPAIGN_AUTHORITY : changed,
          runReleaseEval: async () => {
            evalCalls += 1;
            return { profile: "release", status: "pass", critical_failures: 0,
              unauthorized_retrievals: 0 };
          },
        }),
      }),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_CHANGED",
    );
    assert.equal(censusReads, 2);
    assert.equal(evalCalls, 1);
    const residue = JSON.parse(readFileSync(join(
      path,
      "v048-disposable-target-eval-receipt.json",
    ), "utf8"));
    assert.equal(residue.status, "read_only_evaluation_in_progress");
    assert.equal(Object.hasOwn(residue, "campaign_protection"), false);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("same-name Vectorize replacement with the expected count fails the A12 bracket", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  const replacement = campaignAuthority("active", "stable-binding", {
    targetVectorizeCreatedOn: "2026-09-13T12:00:00.000Z",
  });
  let censusReads = 0;
  let targetReads = 0;
  let evalCalls = 0;
  try {
    await assert.rejects(
      () => run(path, {
        transport: transport({
          observeCampaignAuthority: async () =>
            ++censusReads === 1 ? A12_CAMPAIGN_AUTHORITY : replacement,
          observeTarget: async () => {
            targetReads += 1;
            return observation();
          },
          runReleaseEval: async () => {
            evalCalls += 1;
            return { profile: "release", status: "pass", critical_failures: 0,
              unauthorized_retrievals: 0 };
          },
        }),
      }),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_CHANGED",
    );
    assert.equal(censusReads, 2);
    assert.equal(targetReads, 2,
      "both physical observations retain the expected 7,202-vector count");
    assert.equal(evalCalls, 1);
    const residue = JSON.parse(readFileSync(join(
      path,
      "v048-disposable-target-eval-receipt.json",
    ), "utf8"));
    assert.equal(residue.status, "read_only_evaluation_in_progress");
    assert.equal(Object.hasOwn(residue, "campaign_protection"), false);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("permits only append-shaped aggregate usage while keeping the corpus snapshot exact", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  let reads = 0;
  try {
    const result = await run(path, {
      transport: transport({
        observeTarget: async () => ++reads === 1
          ? observation({ usage: { records: 4, max_id: 7 } })
          : observation({ usage: { records: 9, max_id: 12 } }),
      }),
    });
    assert.equal(result.receipt.status, "passed");
    assert.equal(Object.hasOwn(result.receipt, "usage"), false);
    assert.equal(Object.hasOwn(result.receipt.checks, "usage"), false);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("rejects deletion- or rewrite-shaped aggregate usage drift", async () => {
  if (process.platform === "win32") return;
  for (const candidate of [
    { before: { records: 4, max_id: 4 }, after: { records: 3, max_id: 4 } },
    { before: { records: 4, max_id: 4 }, after: { records: 4, max_id: 5 } },
    { before: { records: 4, max_id: 10 }, after: { records: 5, max_id: 10 } },
  ]) {
    const path = workspace();
    let reads = 0;
    try {
      await assert.rejects(
        () => run(path, {
          transport: transport({
            observeTarget: async () => ++reads === 1
              ? observation({ usage: candidate.before })
              : observation({ usage: candidate.after }),
          }),
        }),
        (error) => error instanceof DisposableRecoveryTargetEvalError &&
          error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_USAGE_CHANGED_INVALID",
      );
    } finally { rmSync(path, { recursive: true, force: true }); }
  }
});

test("rejects failed eval, uncited support, false-answer case, and wrong approval", async () => {
  if (process.platform === "win32") return;
  const cases = [
    transport({ runReleaseEval: async () => ({
      profile: "release", status: "fail", critical_failures: 1,
      unauthorized_retrievals: 0,
    }) }),
    transport({ runSupportedCase: async () => ({ cited: false, citation_count: 0 }) }),
    transport({ runUnsupportedCase: async () => ({ refused: false }) }),
  ];
  for (const candidate of cases) {
    const path = workspace();
    try {
      await assert.rejects(() => run(path, { transport: candidate }),
        (error) => error instanceof DisposableRecoveryTargetEvalError);
    } finally { rmSync(path, { recursive: true, force: true }); }
  }
  const path = workspace();
  try {
    await assert.rejects(() => run(path, { approvalFingerprint: "f".repeat(64) }),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_APPROVAL_INVALID");
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("reuses a completed bound receipt without repeating the live evaluation", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  try {
    const first = await run(path);
    const second = await run(path, {
      transport: transport({
        observeTarget: async () => { throw new Error("must not run"); },
      }),
    });
    assert.equal(second.receiptSha256, first.receiptSha256);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("revalidates evidence around completed-receipt reuse", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  try {
    await run(path);
    await assert.rejects(
      () => run(path, {
        revalidate: () => false,
        transport: transport({
          observeTarget: async () => { throw new Error("must not run"); },
        }),
      }),
      (error) => error instanceof DisposableRecoveryTargetEvalError &&
        error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED",
    );
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("safely resumes an exact unfinished read-only reservation", async () => {
  if (process.platform === "win32") return;
  const path = workspace();
  try {
    await assert.rejects(
      () => run(path, {
        transport: transport({
          runReleaseEval: async () => { throw new Error("synthetic interruption"); },
        }),
      }),
      (error) => error?.message === "synthetic interruption",
    );
    let calls = 0;
    const resumed = await run(path, {
      transport: transport({
        observeTarget: async () => { calls += 1; return observation(); },
      }),
    });
    assert.equal(resumed.receipt.status, "passed");
    assert.equal(calls, 2);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("recovers an exact post-rename target receipt without repeating live evaluation", async () => {
  if (process.platform === "win32") return;
  const source = workspace();
  const target = workspace();
  const receiptPath = join(target, "v048-disposable-target-eval-receipt.json");
  const approvalFingerprint = disposableRecoveryTargetEvalApprovalFingerprint(binding);
  let reservation;
  try {
    const produced = await run(source);
    const marker = {
      schema_version: 1,
      kind: "v048_disposable_target_eval_pending",
      status: "read_only_evaluation_in_progress",
      approval_fingerprint: approvalFingerprint,
      binding,
    };
    const output = assertPrivateAggregateOutputPath(receiptPath);
    reservation = reservePrivateAggregateReceipt(output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, produced.receipt, {
        removePending() { throw new Error("synthetic_post_rename_death"); },
      }),
      /synthetic_post_rename_death/u,
    );
    assert.equal(existsSync(output.pendingPath), true);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(receiptPath)), true);

    const recovered = await run(target, {
      transport: transport({
        observeTarget: async () => { throw new Error("must not repeat live evaluation"); },
      }),
    });
    assert.equal(recovered.receiptSha256, produced.receiptSha256);
    assert.equal(existsSync(output.pendingPath), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(receiptPath)), false);
  } finally {
    if (reservation && !reservation.closed) abandonPrivateAggregateReceipt(reservation);
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
