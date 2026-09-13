import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
  DisposableRecoveryFieldDeployCliError,
  disposableRecoveryFieldDeployHelp,
  executeDisposableRecoveryFieldDeploy,
  main,
  parseDisposableRecoveryFieldDeployArguments,
} from "../operations/disposable-recovery-field-deploy-cli.mjs";
import {
  disposableRecoveryDeploymentCampaignFingerprint,
} from "../operations/disposable-recovery-deployment-receipt.mjs";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const COMMON = [
  "--candidate-sha", "1".repeat(40),
  "--source-manifest", "/private/source.json",
  "--plan", "/private/plan.json",
  "--field-receipt", "/private/field.json",
  "--package", "/private/package.tgz",
  "--wrangler-wrapper", "/private/wrapper",
  "--receipt-directory", "/private/receipts",
];
const TARGET_COMMON = [...COMMON, "--target-manifest", "/private/target.json"];
const commandArguments = (command) => command.startsWith("source-")
  ? COMMON
  : TARGET_COMMON;

function bindingFixture() {
  const base = {
    schema_version: 2,
    run_id: "40000000-0000-4000-8000-000000000004",
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
  return {
    schema_version: base.schema_version,
    run_id: base.run_id,
    campaign_fingerprint: disposableRecoveryDeploymentCampaignFingerprint(base),
    ...Object.fromEntries(Object.entries(base).slice(2)),
  };
}

function dependencies(calls) {
  const binding = bindingFixture();
  const inspect = (input) => {
    calls.push({ method: "inspectPreparation", input });
    return {
      binding,
      manifestBindings: { fixture: true },
      executionPins: [{ fixture: true }],
      revalidate: () => true,
    };
  };
  return {
    platform: "darwin",
    assertReceiptDirectory(path) {
      calls.push({ method: "assertReceiptDirectory", path });
      return { path: resolve(path) };
    },
    loadPlan(path) {
      calls.push({ method: "loadPlan", path });
      return { fixture: true };
    },
    inspectPreparation: inspect,
    inspectSourcePreparation: inspect,
    prepareProvider(input, options) {
      calls.push({ method: "prepareProvider", input, options });
      return {
        moduleInventorySha256: digest("modules"),
        createProvider: async () => { throw new Error("must remain unused in this seam"); },
      };
    },
    async runSourcePreflight(input) {
      calls.push({ method: "runSourcePreflight", input });
      return { receipt: { kind: "source_preflight" }, receiptSha256: digest("source-preflight") };
    },
    async runSourcePhase(input) {
      calls.push({ method: "runSourcePhase", input });
      return { receipt: { kind: "source_phase" }, receiptSha256: digest("source-phase") };
    },
    async runTargetPreflight(input) {
      calls.push({ method: "runTargetPreflight", input });
      return {
        receipt: {
          source_phase_receipt_sha256: digest("source-phase"),
          seed_receipt_sha256: digest("seed"),
        },
        receiptSha256: digest("target-preflight"),
      };
    },
    async runTargetPhase(input) {
      calls.push({ method: "runTargetPhase", input });
      return { receipt: { kind: "target_phase" }, receiptSha256: digest("target-phase") };
    },
  };
}

test("parser exposes only split commands and has no credential argument", () => {
  const source = parseDisposableRecoveryFieldDeployArguments([
    "source-mutate", ...COMMON, "--approve-a2", "a".repeat(64), "--resume",
  ]);
  assert.equal(source.command, "source-mutate");
  assert.equal(source.resume, true);
  assert.equal(Object.hasOwn(source, "a4ApprovalFingerprint"), false);

  const target = parseDisposableRecoveryFieldDeployArguments([
    "target-mutate", ...TARGET_COMMON, "--approve-a4", "b".repeat(64),
  ]);
  assert.equal(target.command, "target-mutate");
  assert.equal(target.resume, false);
  assert.equal(Object.hasOwn(target, "a2ApprovalFingerprint"), false);

  for (const argv of [
    ["deploy", ...COMMON],
    ["source-target-mutate", ...COMMON],
    ["source-preflight", ...COMMON, "--token", "value"],
    ["source-preflight", ...COMMON, "--cloudflare-api-token", "value"],
    ["source-preflight", ...COMMON, "--resume"],
    ["source-mutate", ...COMMON, "--approve-a4", "a".repeat(64)],
    ["target-mutate", ...TARGET_COMMON, "--approve-a2", "a".repeat(64)],
  ]) {
    assert.throws(
      () => parseDisposableRecoveryFieldDeployArguments(argv),
      DisposableRecoveryFieldDeployCliError,
    );
  }
  assert.equal(disposableRecoveryFieldDeployHelp().join("\n").includes("source-target"), false);
});

test("Windows refusal happens before files, provider, or credentials are touched", async () => {
  let touched = false;
  const parsed = parseDisposableRecoveryFieldDeployArguments([
    "source-preview", ...COMMON,
  ]);
  await assert.rejects(
    executeDisposableRecoveryFieldDeploy(parsed, {
      platform: "win32",
      assertReceiptDirectory: () => { touched = true; },
      loadPlan: () => { touched = true; },
      inspectPreparation: () => { touched = true; },
      inspectSourcePreparation: () => { touched = true; },
      prepareProvider: () => { touched = true; },
    }),
    (error) => error.code === "DISPOSABLE_RECOVERY_DEPLOY_CLI_MACOS_REQUIRED",
  );
  assert.equal(touched, false);
});

test("preview is local-only and invokes no phase runner", async () => {
  const calls = [];
  const parsed = parseDisposableRecoveryFieldDeployArguments([
    "target-preview", ...TARGET_COMMON,
  ]);
  const result = await executeDisposableRecoveryFieldDeploy(parsed, dependencies(calls));
  assert.equal(result.kind, "target-preview");
  assert.equal(result.cloudflare_access, false);
  assert.equal(result.cloudflare_mutation, false);
  assert.equal(result.local_write, false);
  assert.equal(result.provider_entrypoint_available, true);
  assert.equal(result.field_proven, false);
  assert.deepEqual(calls.map(({ method }) => method), [
    "assertReceiptDirectory", "loadPlan", "inspectPreparation", "prepareProvider",
  ]);
});

test("source and target commands dispatch only their named phase with fixed paths", async () => {
  for (const item of [
    {
      command: "source-preflight",
      extra: [],
      method: "runSourcePreflight",
      fingerprint: "a2_approval_fingerprint",
    },
    {
      command: "source-mutate",
      extra: ["--approve-a2", "a".repeat(64), "--resume"],
      method: "runSourcePhase",
      approval: ["a2ApprovalFingerprint", "a".repeat(64)],
    },
    {
      command: "target-preflight",
      extra: [],
      method: "runTargetPreflight",
      fingerprint: "a4_approval_fingerprint",
    },
    {
      command: "target-mutate",
      extra: ["--approve-a4", "b".repeat(64)],
      method: "runTargetPhase",
      approval: ["a4ApprovalFingerprint", "b".repeat(64)],
    },
  ]) {
    const calls = [];
    const result = await executeDisposableRecoveryFieldDeploy(
      parseDisposableRecoveryFieldDeployArguments([
        item.command, ...commandArguments(item.command), ...item.extra,
      ]),
      dependencies(calls),
    );
    const phaseCalls = calls.filter(({ method }) => method.startsWith("run"));
    assert.equal(phaseCalls.length, 1, item.command);
    assert.equal(phaseCalls[0].method, item.method, item.command);
    assert.equal(result.kind, item.command);
    assert.equal(result.field_proven, false);
    if (item.fingerprint) assert.match(result[item.fingerprint], /^[a-f0-9]{64}$/u);
    if (item.approval) assert.equal(phaseCalls[0].input[item.approval[0]], item.approval[1]);
    if (item.command === "source-mutate") {
      assert.equal(phaseCalls[0].input.resume, true);
      assert.match(phaseCalls[0].input.journalPath,
        /v048-disposable-source-deployment-journal\.jsonl$/u);
    }
    if (item.command === "target-mutate") {
      assert.equal(phaseCalls[0].input.resume, false);
      assert.match(phaseCalls[0].input.journalPath,
        /v048-disposable-target-deployment-journal\.jsonl$/u);
    }
  }
});

test("main emits only a closed error code on a failed command", async () => {
  const stdout = [];
  const stderr = [];
  const calls = [];
  const deps = dependencies(calls);
  deps.runSourcePhase = async () => {
    const error = new Error("private/path/that/must/not/be/rendered");
    error.code = "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS";
    throw error;
  };
  const code = await main([
    "source-mutate", ...COMMON, "--approve-a2", "a".repeat(64), "--resume",
  ], {
    ...deps,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, [
    "Disposable recovery deployment stopped: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS",
  ]);
  assert.equal(stderr.join("\n").includes("private/path"), false);
});
