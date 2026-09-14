import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import {
  disposableRecoveryProvisionApprovalFingerprint,
  disposableRecoveryProvisionPaths,
  disposableRecoveryProvisioningBinding,
  readDisposableRecoveryProvisionArtifacts,
  runDisposableRecoveryProvisionPhase as runDisposableRecoveryProvisionPhaseImpl,
  runDisposableRecoveryProvisionPreflight as runDisposableRecoveryProvisionPreflightImpl,
} from "../operations/disposable-recovery-field-provision.mjs";
import { buildVerifiedRecoveryPlan } from "../operations/verified-recovery.mjs";
import {
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptCommitPath,
  privateAggregateReceiptPendingPath,
} from "../operations/private-aggregate-receipt.mjs";
import {
  assertDisposableRecoveryFieldKeychainVerificationCapability,
} from "../operations/disposable-recovery-field-keychain-prep.mjs";
import {
  createTestDisposableRecoveryK0Capability,
} from "./helpers/disposable-recovery-k0-capability.mjs";

const MACOS_PRIVATE_RECEIPT_SKIP =
  "requires a verifier-minted K0 capability and private receipt ACL proof";
function testWithMacosPrivateReceipt(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  return test(name, {
    ...options,
    skip: process.platform === "win32" ? MACOS_PRIVATE_RECEIPT_SKIP : options.skip,
  }, fn);
}

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const TEST_ACCOUNT_ID = "a".repeat(32);
const DEPLOY_K0 = process.platform === "win32" ? null
  : await createTestDisposableRecoveryK0Capability({
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    package_sha256: digest("package"),
    field_receipt_sha256: digest("field-receipt"),
    account_id: TEST_ACCOUNT_ID,
  });
const PROVISION_K0 = process.platform === "win32" ? null
  : await createTestDisposableRecoveryK0Capability({
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    package_sha256: digest("package"),
    field_receipt_sha256: digest("field"),
    account_id: TEST_ACCOUNT_ID,
  });
const runDisposableRecoveryProvisionPreflight = (input) =>
  runDisposableRecoveryProvisionPreflightImpl({
    ...input,
    keychainProof: PROVISION_K0.proof,
  });
const runDisposableRecoveryProvisionPhase = (input) =>
  runDisposableRecoveryProvisionPhaseImpl({
    ...input,
    keychainProof: PROVISION_K0.proof,
  });
const COMMON = [
  "--account-id", TEST_ACCOUNT_ID,
  "--candidate-sha", "1".repeat(40),
  "--source-manifest", "/private/source.json",
  "--plan", "/private/plan.json",
  "--field-receipt", "/private/field.json",
  "--package", "/private/package.tgz",
  "--keychain-receipt", "/private/receipts/v048-disposable-field-keychain-prep.json",
  "--wrangler-wrapper", "/private/wrapper",
  "--receipt-directory", "/private/receipts",
];
const TARGET_COMMON = [...COMMON, "--target-manifest", "/private/target.json"];
const PROVISION_COMMON = [
  "--account-id", TEST_ACCOUNT_ID,
  "--candidate-sha", "1".repeat(40),
  "--field-receipt", "/private/field.json",
  "--package", "/private/package.tgz",
  "--keychain-receipt", "/private/receipts/v048-disposable-field-keychain-prep.json",
  "--wrangler-wrapper", "/private/wrapper",
  "--receipt-directory", "/private/receipts",
];
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
  base.keychain_binding_sha256 = DEPLOY_K0.proof.keychain_binding_sha256;
  return {
    schema_version: base.schema_version,
    run_id: base.run_id,
    campaign_fingerprint: disposableRecoveryDeploymentCampaignFingerprint(base),
    ...Object.fromEntries(Object.entries(base).slice(2)),
  };
}

function dependencies(calls) {
  const binding = bindingFixture();
  const proof = DEPLOY_K0.proof;
  const inspect = (input) => {
    calls.push({ method: "inspectPreparation", input });
    assert.equal(input.keychainProof, proof);
    assert.equal(
      assertDisposableRecoveryFieldKeychainVerificationCapability(
        input.keychainProof,
        proof.keychain_binding_sha256,
      ),
      proof,
    );
    return {
      binding,
      manifestBindings: {
        source: { accountId: TEST_ACCOUNT_ID },
        target: { accountId: TEST_ACCOUNT_ID },
      },
      executionPins: [{ fixture: true }],
      vectorizeMutationQuiescenceFingerprint: digest("vectorize-quiescence"),
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
    readKeychainReceipt(path, options) {
      calls.push({ method: "readKeychainReceipt", path, options });
      return {
        value: {
          binding: {
            candidate_sha: binding.candidate_sha,
            candidate_tree_sha: binding.candidate_tree_sha,
            package_sha256: binding.package_sha256,
            field_receipt_sha256: binding.field_receipt_sha256,
            account_fingerprint: proof.account_fingerprint,
            preparation_fingerprint: proof.preparation_fingerprint,
          },
        },
      };
    },
    loadCampaignManifest(path) {
      calls.push({ method: "loadCampaignManifest", path });
      return { fixture: path };
    },
    validateSourceCampaignManifest(value, role) {
      calls.push({ method: "validateSourceCampaignManifest", value, role });
      return value;
    },
    validateCampaignManifestPair(source, target) {
      calls.push({ method: "validateCampaignManifestPair", source, target });
      return { source, target };
    },
    createKeychain(options) {
      calls.push({ method: "createKeychain", options });
      return {};
    },
    async verifyKeychainPrep(input) {
      calls.push({ method: "verifyKeychainPrep", input });
      return proof;
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
  const help = disposableRecoveryFieldDeployHelp().join("\n");
  assert.equal(help.includes("source-target"), false);
  assert.match(help,
    /Required order: A1 source provision, separately approved A3 target provision, freeze the full plan, A2 source deploy, source seed, then A4 target deploy\./u);
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

testWithMacosPrivateReceipt("preview is local-only and invokes no phase runner", async () => {
  const calls = [];
  const parsed = parseDisposableRecoveryFieldDeployArguments([
    "target-preview", ...TARGET_COMMON,
  ]);
  const result = await executeDisposableRecoveryFieldDeploy(parsed, dependencies(calls));
  assert.equal(result.kind, "target-preview");
  assert.equal(result.cloudflare_access, false);
  assert.equal(result.cloudflare_mutation, false);
  assert.equal(result.local_write, false);
  assert.equal(result.keychain_access, "read_only");
  assert.match(result.keychain_prep_receipt_sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.keychain_binding_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.provider_entrypoint_available, true);
  assert.equal(result.field_proven, false);
  assert.deepEqual(calls.map(({ method }) => method), [
    "assertReceiptDirectory", "loadPlan", "createKeychain",
    "readKeychainReceipt", "verifyKeychainPrep", "loadCampaignManifest",
    "loadCampaignManifest", "validateCampaignManifestPair",
    "inspectPreparation", "prepareProvider",
  ]);
});

testWithMacosPrivateReceipt("source and target commands dispatch only their named phase with fixed paths", async () => {
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
    assert.equal(
      phaseCalls[0].input.keychainProof.keychain_binding_sha256,
      phaseCalls[0].input.binding.keychain_binding_sha256,
    );
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

test("A2/A4 commands require the K0 receipt before preparation", async () => {
  const withoutKeychainReceipt = COMMON.filter((value, index, values) =>
    value !== "--keychain-receipt" && values[index - 1] !== "--keychain-receipt");
  let touched = false;
  await assert.rejects(
    executeDisposableRecoveryFieldDeploy([
      "source-preview", ...withoutKeychainReceipt,
    ], {
      platform: "darwin",
      assertReceiptDirectory: () => { touched = true; },
      loadPlan: () => { touched = true; },
      inspectSourcePreparation: () => { touched = true; },
      createKeychain: () => { touched = true; },
      verifyKeychainPrep: () => { touched = true; },
      prepareProvider: () => { touched = true; },
    }),
    (error) => error.code === "DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID",
  );
  assert.equal(touched, false);
});

testWithMacosPrivateReceipt("A2/A4 reject invalid K0 evidence before provider preparation", async () => {
  let providerPrepared = false;
  const calls = [];
  const deps = dependencies(calls);
  deps.verifyKeychainPrep = async () => {
    throw new Error("synthetic-invalid-k0");
  };
  deps.prepareProvider = () => {
    providerPrepared = true;
    return { moduleInventorySha256: digest("modules"), createProvider() {} };
  };
  await assert.rejects(
    executeDisposableRecoveryFieldDeploy(
      parseDisposableRecoveryFieldDeployArguments(["source-preview", ...COMMON]),
      deps,
    ),
    (error) => error.code === "DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED",
  );
  assert.equal(providerPrepared, false);

  let accountMismatchTouchedK0 = false;
  let accountMismatchPreparedProvider = false;
  const mismatchCalls = [];
  const mismatch = dependencies(mismatchCalls);
  mismatch.inspectSourcePreparation = () => ({
    binding: bindingFixture(),
    manifestBindings: { source: { accountId: "b".repeat(32) } },
    executionPins: [],
    revalidate: () => true,
  });
  mismatch.createKeychain = () => {
    accountMismatchTouchedK0 = true;
    return {};
  };
  mismatch.prepareProvider = () => {
    accountMismatchPreparedProvider = true;
    return { moduleInventorySha256: digest("modules"), createProvider() {} };
  };
  await assert.rejects(
    executeDisposableRecoveryFieldDeploy(
      parseDisposableRecoveryFieldDeployArguments(["source-preview", ...COMMON]),
      mismatch,
    ),
    (error) => error.code === "DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED",
  );
  assert.equal(accountMismatchTouchedK0, true);
  assert.equal(accountMismatchPreparedProvider, false);
});

testWithMacosPrivateReceipt("A2/A4 mutation boundary revalidates preparation and all K0 values", async () => {
  const calls = [];
  const binding = bindingFixture();
  let preparationRevalidations = 0;
  const preparation = {
    binding,
    manifestBindings: {
      source: { accountId: TEST_ACCOUNT_ID },
      target: { accountId: TEST_ACCOUNT_ID },
    },
    executionPins: [],
    revalidate: async () => {
      preparationRevalidations += 1;
      return true;
    },
  };
  const proof = DEPLOY_K0.proof;
  let boundaryCalls = 0;
  const deps = dependencies(calls);
  deps.inspectSourcePreparation = () => preparation;
  deps.verifyKeychainPrep = () => proof;
  deps.runSourcePhase = async (input) => {
    boundaryCalls += 1;
    assert.equal(input.keychainProof, proof);
    assert.equal(await input.revalidate(), true);
    return { receipt: { kind: "source_phase" }, receiptSha256: digest("source-phase") };
  };
  const result = await executeDisposableRecoveryFieldDeploy(
    parseDisposableRecoveryFieldDeployArguments([
      "source-mutate", ...COMMON, "--approve-a2", "a".repeat(64),
    ]),
    deps,
  );
  assert.equal(result.status, "passed");
  assert.equal(boundaryCalls, 1);
  assert.equal(preparationRevalidations, 1);
  assert.equal(
    assertDisposableRecoveryFieldKeychainVerificationCapability(
      proof,
      preparation.binding.keychain_binding_sha256,
    ),
    proof,
  );
});

testWithMacosPrivateReceipt("main emits only a closed error code on a failed command", async () => {
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

function provisioningPreparation() {
  return {
    binding: {
      schema_version: 1,
      candidate_sha: "1".repeat(40),
      candidate_tree_sha: "2".repeat(40),
      field_receipt_run_id: "50000000-0000-4000-8000-000000000005",
      field_receipt_sha256: digest("field"),
      package_filename: "brain-installer-0.4.8.tgz",
      package_bytes: 123456,
      package_sha256: digest("package"),
      package_file_count: 541,
      execution_inventory_sha256: digest("execution"),
      installed_execution_inventory_sha256: digest("execution"),
      wrangler_version: "4.131.1",
      wrangler_wrapper_sha256: digest("wrapper"),
      wrangler_runtime_inventory_sha256: digest("wrangler-runtime"),
      wrangler_entrypoint_sha256: digest("wrangler-entrypoint"),
      node_version: "v22.22.0",
      node_executable_sha256: digest("node"),
    },
    executionPins: [],
    revalidate: () => true,
  };
}

function provisioningBinding(preparation, provider, role) {
  return disposableRecoveryProvisioningBinding(
    preparation,
    provider,
    role,
    PROVISION_K0.proof,
  );
}

function provisioningProvider(role, calls, collision = null, { failOnceAt = null } = {}) {
  const source = role === "source";
  const resourceName = `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}`;
  const accountId = "a".repeat(32);
  const d1 = source
    ? "10000000-0000-4000-8000-000000000001"
    : "20000000-0000-4000-8000-000000000002";
  const worker = source ? "1".repeat(32) : "2".repeat(32);
  const version = source
    ? "30000000-0000-4000-8000-000000000003"
    : "40000000-0000-4000-8000-000000000004";
  const deployment = source
    ? "50000000-0000-4000-8000-000000000005"
    : "60000000-0000-4000-8000-000000000006";
  const createdOn = "2026-09-13T12:00:00.000Z";
  const remote = {
    d1: false,
    vector: false,
    metadata: new Map(),
    worker: false,
    schema: false,
    baseline: false,
  };
  let failed = false;
  const commit = (step, change) => {
    change();
    if (!failed && failOnceAt === step) {
      failed = true;
      throw new Error("synthetic-lost-provider-response");
    }
  };
  const providerMetadata = () => ({
    schema_version: 1,
    status: 200,
    content_type: "application/json",
    body_sha256: digest(`provider-${calls.length}`),
  });
  const responseEvidence = () => ({
    operation: "fixture",
    ...providerMetadata(),
  });
  const absent = () => ({
    schema_version: 1,
    operation: "read_provisioning_collisions",
    account_id: accountId,
    resource_name: resourceName,
    worker_exists: false,
    d1_exists: false,
    vectorize_exists: false,
    worker_ids: [],
    d1_ids: [],
    vectorize_names: [],
    responses: [responseEvidence()],
  });
  const provider = {
    role,
    accountId,
    resourceName,
    adminKeyLocator: `keychain://${resourceName}/owner`,
    recoveryArtifactKeyLocator: source ? null : `keychain://${resourceName}/artifact-v1`,
    bankWrappingKeyLocator: source ? null : `keychain://${resourceName}/bank-wrapping-v2`,
    candidateModuleInventorySha256: digest("candidate-modules"),
    migrationInventorySha256: digest("migrations"),
    bootstrapModuleInventorySha256: digest("bootstrap"),
    async readCollisions() {
      calls.push("readCollisions");
      if (collision) return collision(absent());
      const value = absent();
      if (remote.d1) {
        value.d1_exists = true;
        value.d1_ids = [d1];
      }
      if (remote.vector) {
        value.vectorize_exists = true;
        value.vectorize_names = [resourceName];
        value.vectorize_created_on = createdOn;
      }
      if (remote.worker) {
        value.worker_exists = true;
        value.worker_ids = [worker];
      }
      return value;
    },
    createMutationProvider() {
      calls.push("resolveAllSecrets");
      return {
        async createD1() {
          calls.push("createD1");
          commit("create_d1", () => { remote.d1 = true; });
          return { provider_metadata: providerMetadata(), result: { database_id: d1 } };
        },
        async reconcileD1() {
          calls.push("reconcile:create_d1");
          return remote.d1
            ? { outcome: "confirmed", value: {
                provider_metadata: providerMetadata(), result: { database_id: d1 },
              } }
            : { outcome: "resume_safe" };
        },
        async createVectorize() {
          calls.push("createVectorize");
          commit("create_vectorize", () => { remote.vector = true; });
          return {
            provider_metadata: providerMetadata(),
            result: { accepted: true, created_on: createdOn },
          };
        },
        async reconcileVectorize() {
          calls.push("reconcile:create_vectorize");
          return remote.vector
            ? { outcome: "confirmed", value: {
                provider_metadata: providerMetadata(),
                result: { accepted: true, created_on: createdOn },
              } }
            : { outcome: "resume_safe" };
        },
        async createMetadataIndex({ propertyName, indexType }) {
          calls.push(`metadata:${propertyName}:${indexType}`);
          commit(`create_metadata_${propertyName}`, () => {
            remote.metadata.set(propertyName, indexType);
          });
          return {
            provider_metadata: providerMetadata(),
            result: { property_name: propertyName, index_type: indexType },
          };
        },
        async reconcileMetadataIndex({ propertyName, indexType }) {
          calls.push(`reconcile:create_metadata_${propertyName}`);
          return remote.metadata.get(propertyName) === indexType
            ? { outcome: "confirmed", value: {
                provider_metadata: providerMetadata(),
                result: { property_name: propertyName, index_type: indexType },
              } }
            : { outcome: "resume_safe" };
        },
        async createWorker() {
          calls.push("createWorker");
          commit("create_worker_identity", () => { remote.worker = true; });
          return { provider_metadata: providerMetadata(), result: { worker_id: worker } };
        },
        async reconcileWorker() {
          calls.push("reconcile:create_worker_identity");
          return remote.worker
            ? { outcome: "confirmed", value: {
                provider_metadata: providerMetadata(), result: { worker_id: worker },
              } }
            : { outcome: "resume_safe" };
        },
        async initializeSourceSchema() {
          calls.push("initializeSourceSchema");
          commit("initialize_source_schema", () => { remote.schema = true; });
          return {
            provider_metadata: providerMetadata(),
            result: { migration_inventory_sha256: digest("migrations"), schema_version: 46 },
          };
        },
        async reconcileSourceSchema() {
          calls.push("reconcile:initialize_source_schema");
          return remote.schema
            ? { outcome: "confirmed", value: {
                provider_metadata: providerMetadata(),
                result: { migration_inventory_sha256: digest("migrations"), schema_version: 46 },
              } }
            : { outcome: "resume_safe" };
        },
        async readFinalIdentity() {
          calls.push("readFinalIdentity");
          return { worker_id: worker, hostname: `${resourceName}.fixture.workers.dev` };
        },
        async createBaseline() {
          calls.push("createBaseline");
          commit("create_active_baseline", () => { remote.baseline = true; });
          return { provider_metadata: providerMetadata(), result: { version_id: version } };
        },
        async reconcileBaseline() {
          calls.push("reconcile:create_active_baseline");
          return remote.baseline
            ? { outcome: "confirmed", value: {
                provider_metadata: providerMetadata(), result: { version_id: version },
              } }
            : { outcome: "resume_safe" };
        },
        async readFinal(input) {
          calls.push(`readFinal:${input.baselineVersionId}`);
          return {
            semantic: {
              account_id: accountId,
              role,
              resource_name: resourceName,
              worker_id: worker,
              worker_created_on: createdOn,
              worker_tag_sha256: digest("worker-tag"),
              hostname: `${resourceName}.fixture.workers.dev`,
              database_id: d1,
              active_deployment_id: deployment,
              active_version_id: input.baselineVersionId,
              active_script_etag: "fixture-etag",
              active_traffic_percent: 100,
              baseline_mode: "maintenance-bootstrap",
              bindings_sha256: digest("bindings"),
              bootstrap_tag_sha256: digest("bootstrap-tag"),
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
              schema_version: source ? 46 : null,
              user_tables: source ? null : 0,
              content_rows: 0,
              vector_count: 0,
              vectorize_created_on: input.vectorCreatedOn,
              metadata_indexes_sha256: digest("metadata"),
            },
            evidence: [responseEvidence()],
          };
        },
        dispose() { calls.push("dispose"); },
      };
    },
  };
  return provider;
}

test("provision parser exposes A1/A3 without plan, manifest, or credentials", () => {
  for (const [command, approval] of [
    ["source-provision-mutate", ["--approve-a1", "a".repeat(64)]],
    ["target-provision-mutate", ["--approve-a3", "b".repeat(64)]],
  ]) {
    const parsed = parseDisposableRecoveryFieldDeployArguments([
      command, ...PROVISION_COMMON, ...approval,
    ]);
    assert.equal(parsed.provisioning, true);
    assert.equal(Object.hasOwn(parsed, "planPath"), false);
    assert.equal(parsed.resume, false);
  }
  assert.equal(parseDisposableRecoveryFieldDeployArguments([
    "source-provision-mutate", ...PROVISION_COMMON,
    "--approve-a1", "a".repeat(64), "--resume",
  ]).resume, true);
});

testWithMacosPrivateReceipt("provision preview is local-only", async () => {
  const calls = [];
  const result = await executeDisposableRecoveryFieldDeploy(
    parseDisposableRecoveryFieldDeployArguments([
      "source-provision-preview", ...PROVISION_COMMON,
    ]),
    {
      platform: "darwin",
      assertReceiptDirectory: (path) => ({ path: resolve(path) }),
      inspectProvisioningPreparation: () => provisioningPreparation(),
      createKeychain: () => ({}),
      verifyKeychainPrep: () => PROVISION_K0.proof,
      prepareProvisioningProvider: () => provisioningProvider("source", calls),
    },
  );
  assert.equal(result.action, "A1");
  assert.equal(result.cloudflare_access, false);
  assert.deepEqual(calls, []);
});

test("provisioning requires the K0 receipt before provider preparation", async () => {
  const withoutKeychainReceipt = PROVISION_COMMON.filter((value, index, values) =>
    value !== "--keychain-receipt" && values[index - 1] !== "--keychain-receipt");
  let touched = false;
  await assert.rejects(
    executeDisposableRecoveryFieldDeploy([
      "source-provision-preview", ...withoutKeychainReceipt,
    ], {
      platform: "darwin",
      assertReceiptDirectory: () => { touched = true; },
      inspectProvisioningPreparation: () => { touched = true; },
      createKeychain: () => { touched = true; },
      verifyKeychainPrep: () => { touched = true; },
      prepareProvisioningProvider: () => { touched = true; },
    }),
    (error) => error.code === "DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID",
  );
  assert.equal(touched, false);
});

test("an invalid K0 proof refuses before the provisioning provider is prepared", async () => {
  let providerPrepared = false;
  await assert.rejects(
    executeDisposableRecoveryFieldDeploy(
      parseDisposableRecoveryFieldDeployArguments([
        "source-provision-preview", ...PROVISION_COMMON,
      ]),
      {
        platform: "darwin",
        assertReceiptDirectory: (path) => ({ path: resolve(path) }),
        inspectProvisioningPreparation: () => provisioningPreparation(),
        createKeychain: () => ({}),
        verifyKeychainPrep: async () => {
          const error = new Error("synthetic-invalid-k0-proof");
          error.code = "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RECEIPT_INVALID";
          throw error;
        },
        prepareProvisioningProvider: () => {
          providerPrepared = true;
          return provisioningProvider("source", []);
        },
      },
    ),
    (error) => error.code === "DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED",
  );
  assert.equal(providerPrepared, false);
});

testWithMacosPrivateReceipt("the provisioning mutation boundary invokes preparation and K0 revalidation", async () => {
  const calls = [];
  const preparation = provisioningPreparation();
  let preparationRevalidations = 0;
  preparation.revalidate = async () => {
    preparationRevalidations += 1;
    return true;
  };
  const keychainProof = PROVISION_K0.proof;
  let boundaryCalls = 0;
  const result = await executeDisposableRecoveryFieldDeploy(
    parseDisposableRecoveryFieldDeployArguments([
      "source-provision-mutate", ...PROVISION_COMMON,
      "--approve-a1", "a".repeat(64),
    ]),
    {
      platform: "darwin",
      assertReceiptDirectory: (path) => ({ path: resolve(path) }),
      inspectProvisioningPreparation: () => preparation,
      createKeychain: () => ({}),
      verifyKeychainPrep: () => keychainProof,
      prepareProvisioningProvider: () => provisioningProvider("source", calls),
      runProvisionPhase: async (input) => {
        boundaryCalls += 1;
        assert.equal(input.keychainProof, keychainProof);
        assert.equal(await input.revalidate(), true);
        return {
          receiptSha256: digest("source-provision-phase"),
          manifestSha256: digest("source-provision-manifest"),
        };
      },
    },
  );
  assert.equal(result.kind, "source-provision-mutate");
  assert.equal(boundaryCalls, 1);
  assert.equal(preparationRevalidations, 1);
  assert.equal(
    assertDisposableRecoveryFieldKeychainVerificationCapability(
      keychainProof,
      keychainProof.keychain_binding_sha256,
    ),
    keychainProof,
  );
});

testWithMacosPrivateReceipt("A1/A3 provision phases journal metadata indexes, preserve target emptiness, and bind Worker ID", async (t) => {
  for (const role of ["source", "target"]) {
    await t.test(role, async () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), `v048-${role}-provision-`)));
      chmodSync(directory, 0o700);
      try {
        const calls = [];
        const provider = provisioningProvider(role, calls);
        const binding = provisioningBinding(
          provisioningPreparation(), provider, role,
        );
        const paths = disposableRecoveryProvisionPaths(directory, role);
        const preflight = await runDisposableRecoveryProvisionPreflight({
          binding, provider, receiptPath: paths.preflight,
          expectedReceiptDirectory: directory,
        });
        const approval = disposableRecoveryProvisionApprovalFingerprint(
          binding, preflight.receiptSha256,
        );
        const result = await runDisposableRecoveryProvisionPhase({
          binding, provider, preflightReceiptPath: paths.preflight,
          approvalFingerprint: approval, journalPath: paths.journal,
          receiptPath: paths.phase, manifestPath: paths.manifest,
          expectedReceiptDirectory: directory,
        });
        assert.match(result.receipt.final_state.worker_id, /^[a-f0-9]{32}$/u);
        assert.equal(
          result.manifest.infrastructure.cloudflare.worker_id,
          result.receipt.final_state.worker_id,
        );
        assert.equal(result.receipt.final_state.resource_name, provider.resourceName);
        const readback = readDisposableRecoveryProvisionArtifacts({
          receiptPath: paths.phase,
          manifestPath: paths.manifest,
          expectedReceiptDirectory: directory,
          role,
        });
        assert.equal(readback.workerId, result.receipt.final_state.worker_id);
        assert.equal(readback.resourceName, provider.resourceName);
        assert.equal(
          Object.hasOwn(result.manifest.operations, "recovery_artifact_key_secret"),
          role === "target",
        );
        assert.equal(
          Object.hasOwn(result.manifest.operations, "bank_access_wrapping_key_secret"),
          role === "target",
        );
        assert.equal(calls.filter((value) => value.startsWith("metadata:")).length, 6);
        assert.equal(calls.includes("initializeSourceSchema"), role === "source");
        assert.equal(result.receipt.final_state.vector_count, 0);
        if (role === "target") assert.equal(result.receipt.final_state.user_tables, 0);
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes("fixture-admin-value"), false);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
});

testWithMacosPrivateReceipt("provision collision and wrong approval refuse before every mutation", async () => {
  for (const collisionKey of ["worker", "d1", "vectorize"]) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `v048-collision-${collisionKey}-`)));
    chmodSync(directory, 0o700);
    try {
      const calls = [];
      const provider = provisioningProvider("source", calls, (value) => {
        value[`${collisionKey}_exists`] = true;
        if (collisionKey === "worker") value.worker_ids = ["f".repeat(32)];
        if (collisionKey === "d1") {
          value.d1_ids = ["70000000-0000-4000-8000-000000000007"];
        }
        if (collisionKey === "vectorize") value.vectorize_names = [value.resource_name];
        return value;
      });
      const binding = provisioningBinding(
        provisioningPreparation(), provider, "source",
      );
      const paths = disposableRecoveryProvisionPaths(directory, "source");
      await assert.rejects(
        runDisposableRecoveryProvisionPreflight({
          binding, provider, receiptPath: paths.preflight,
          expectedReceiptDirectory: directory,
        }),
        (error) => error.code === "DISPOSABLE_RECOVERY_PROVISION_COLLISION_REFUSED",
      );
      assert.equal(calls.some((value) => value.startsWith("create")), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  const directory = realpathSync(mkdtempSync(join(tmpdir(), "v048-approval-refusal-")));
  chmodSync(directory, 0o700);
  try {
    const calls = [];
    const provider = provisioningProvider("target", calls);
    const binding = provisioningBinding(
      provisioningPreparation(), provider, "target",
    );
    const paths = disposableRecoveryProvisionPaths(directory, "target");
    await runDisposableRecoveryProvisionPreflight({
      binding, provider, receiptPath: paths.preflight,
      expectedReceiptDirectory: directory,
    });
    await assert.rejects(
      runDisposableRecoveryProvisionPhase({
        binding, provider, preflightReceiptPath: paths.preflight,
        approvalFingerprint: "0".repeat(64), journalPath: paths.journal,
        receiptPath: paths.phase, manifestPath: paths.manifest,
        expectedReceiptDirectory: directory,
      }),
      (error) => error.code === "DISPOSABLE_RECOVERY_PROVISION_APPROVAL_INVALID",
    );
    assert.equal(calls.includes("resolveAllSecrets"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

testWithMacosPrivateReceipt("A1 and A3 resume every sent-unconfirmed boundary without blind retry", async (t) => {
  const commonSteps = [
    "create_d1",
    "create_vectorize",
    "create_metadata_source",
    "create_metadata_client",
    "create_metadata_category",
    "create_metadata_top_folder",
    "create_metadata_platform",
    "create_metadata_document_date",
    "create_worker_identity",
    "create_active_baseline",
  ];
  for (const role of ["source", "target"]) {
    const steps = role === "source"
      ? [...commonSteps.slice(0, -1), "initialize_source_schema", commonSteps.at(-1)]
      : commonSteps;
    for (const step of steps) {
      await t.test(`${role}:${step}`, async () => {
        const directory = realpathSync(mkdtempSync(
          join(tmpdir(), `v048-resume-${role}-${step}-`),
        ));
        chmodSync(directory, 0o700);
        try {
          const calls = [];
          const provider = provisioningProvider(role, calls, null, { failOnceAt: step });
          const binding = provisioningBinding(
            provisioningPreparation(), provider, role,
          );
          const paths = disposableRecoveryProvisionPaths(directory, role);
          const preflight = await runDisposableRecoveryProvisionPreflight({
            binding, provider, receiptPath: paths.preflight,
            expectedReceiptDirectory: directory,
          });
          const approvalFingerprint = disposableRecoveryProvisionApprovalFingerprint(
            binding, preflight.receiptSha256,
          );
          const args = {
            binding,
            provider,
            preflightReceiptPath: paths.preflight,
            approvalFingerprint,
            journalPath: paths.journal,
            receiptPath: paths.phase,
            manifestPath: paths.manifest,
            expectedReceiptDirectory: directory,
          };
          await assert.rejects(runDisposableRecoveryProvisionPhase(args));
          const completed = await runDisposableRecoveryProvisionPhase({ ...args, resume: true });
          assert.equal(completed.receipt.status, "passed", `${role}:${step}`);
          const mutationLabel = step.startsWith("create_metadata_")
            ? `metadata:${step.slice("create_metadata_".length)}:`
            : ({
                create_d1: "createD1",
                create_vectorize: "createVectorize",
                create_worker_identity: "createWorker",
                initialize_source_schema: "initializeSourceSchema",
                create_active_baseline: "createBaseline",
              })[step];
          assert.equal(
            calls.filter((value) => mutationLabel.endsWith(":")
              ? value.startsWith(mutationLabel)
              : value === mutationLabel).length,
            1,
            `${role}:${step} must not be mutated twice`,
          );
          assert.equal(calls.includes(`reconcile:${step}`), true, `${role}:${step}`);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});

testWithMacosPrivateReceipt("provision output pair resumes every reservation and finalization boundary", async (t) => {
  for (const stoppedAt of [
    "receipt_reserved", "manifest_reserved", "manifest_finalized", "receipt_finalized",
  ]) {
    await t.test(stoppedAt, async () => {
      const directory = realpathSync(mkdtempSync(
        join(tmpdir(), `v048-output-resume-${stoppedAt}-`),
      ));
      chmodSync(directory, 0o700);
      try {
        const calls = [];
        const provider = provisioningProvider("source", calls);
        const binding = provisioningBinding(
          provisioningPreparation(), provider, "source",
        );
        const paths = disposableRecoveryProvisionPaths(directory, "source");
        const preflight = await runDisposableRecoveryProvisionPreflight({
          binding, provider, receiptPath: paths.preflight,
          expectedReceiptDirectory: directory,
        });
        let stopped = false;
        const args = {
          binding,
          provider,
          preflightReceiptPath: paths.preflight,
          approvalFingerprint: disposableRecoveryProvisionApprovalFingerprint(
            binding, preflight.receiptSha256,
          ),
          journalPath: paths.journal,
          receiptPath: paths.phase,
          manifestPath: paths.manifest,
          expectedReceiptDirectory: directory,
          checkpoint: async (stage) => {
            if (!stopped && stage === stoppedAt) {
              stopped = true;
              throw new Error(`synthetic output crash: ${stage}`);
            }
            return true;
          },
        };
        await assert.rejects(runDisposableRecoveryProvisionPhase(args),
          new RegExp(`synthetic output crash: ${stoppedAt}`));
        const completed = await runDisposableRecoveryProvisionPhase({ ...args, resume: true });
        assert.equal(completed.receipt.status, "passed");
        assert.equal(calls.filter((value) => value === "createD1").length, 1);
        assert.equal(calls.filter((value) => value === "createBaseline").length, 1);
        const readback = readDisposableRecoveryProvisionArtifacts({
          receiptPath: paths.phase,
          manifestPath: paths.manifest,
          expectedReceiptDirectory: directory,
          role: "source",
        });
        assert.equal(readback.receiptSha256, completed.receiptSha256);
        assert.equal(readback.manifestSha256, completed.manifestSha256);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

testWithMacosPrivateReceipt("A1/A3 recover a durable final left with its guard for either output", async (t) => {
  for (const role of ["source", "target"]) {
    for (const artifact of ["manifest", "receipt"]) {
      await t.test(`${role}:${artifact}`, async () => {
        const directory = realpathSync(mkdtempSync(
          join(tmpdir(), `v048-finalization-recovery-${role}-${artifact}-`),
        ));
        chmodSync(directory, 0o700);
        try {
          const calls = [];
          const provider = provisioningProvider(role, calls);
          const binding = provisioningBinding(
            provisioningPreparation(), provider, role,
          );
          const paths = disposableRecoveryProvisionPaths(directory, role);
          const preflight = await runDisposableRecoveryProvisionPreflight({
            binding, provider, receiptPath: paths.preflight,
            expectedReceiptDirectory: directory,
          });
          const targetPath = artifact === "manifest" ? paths.manifest : paths.phase;
          let injected = false;
          const args = {
            binding,
            provider,
            preflightReceiptPath: paths.preflight,
            approvalFingerprint: disposableRecoveryProvisionApprovalFingerprint(
              binding, preflight.receiptSha256,
            ),
            journalPath: paths.journal,
            receiptPath: paths.phase,
            manifestPath: paths.manifest,
            expectedReceiptDirectory: directory,
            finalizeReceipt(reservation, value) {
              if (!injected && reservation.path === targetPath) {
                injected = true;
                return finalizePrivateAggregateReceipt(reservation, value, {
                  removePending() {
                    throw new Error(`synthetic ${artifact} post-rename death`);
                  },
                });
              }
              return finalizePrivateAggregateReceipt(reservation, value);
            },
          };
          await assert.rejects(runDisposableRecoveryProvisionPhase(args), (error) =>
            error.code === (artifact === "manifest"
              ? "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_FINALIZATION_FAILED"
              : "DISPOSABLE_RECOVERY_PROVISION_RECEIPT_FINALIZATION_FAILED"));
          assert.equal(injected, true);
          assert.equal(existsSync(targetPath), true);
          assert.equal(existsSync(privateAggregateReceiptPendingPath(targetPath)), true);
          assert.equal(existsSync(privateAggregateReceiptCommitPath(targetPath)), true);
          const completed = await runDisposableRecoveryProvisionPhase({
            ...args,
            resume: true,
            finalizeReceipt: finalizePrivateAggregateReceipt,
          });
          assert.equal(completed.receipt.status, "passed");
          assert.equal(existsSync(privateAggregateReceiptPendingPath(targetPath)), false);
          assert.equal(existsSync(privateAggregateReceiptCommitPath(targetPath)), false);
          assert.equal(calls.filter((value) => value === "createD1").length, 1);
          assert.equal(calls.filter((value) => value === "createBaseline").length, 1);
          const readback = readDisposableRecoveryProvisionArtifacts({
            receiptPath: paths.phase,
            manifestPath: paths.manifest,
            expectedReceiptDirectory: directory,
            role,
          });
          assert.equal(readback.receiptSha256, completed.receiptSha256);
          assert.equal(readback.manifestSha256, completed.manifestSha256);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});

testWithMacosPrivateReceipt("generated A1 and A3 manifests build the full verified-recovery plan without null locators", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "v048-provision-plan-")));
  chmodSync(directory, 0o700);
  try {
    for (const role of ["source", "target"]) {
      const calls = [];
      const provider = provisioningProvider(role, calls);
      const binding = provisioningBinding(
        provisioningPreparation(), provider, role,
      );
      const paths = disposableRecoveryProvisionPaths(directory, role);
      const preflight = await runDisposableRecoveryProvisionPreflight({
        binding, provider, receiptPath: paths.preflight,
        expectedReceiptDirectory: directory,
      });
      await runDisposableRecoveryProvisionPhase({
        binding,
        provider,
        preflightReceiptPath: paths.preflight,
        approvalFingerprint: disposableRecoveryProvisionApprovalFingerprint(
          binding, preflight.receiptSha256,
        ),
        journalPath: paths.journal,
        receiptPath: paths.phase,
        manifestPath: paths.manifest,
        expectedReceiptDirectory: directory,
      });
    }
    const sourcePath = disposableRecoveryProvisionPaths(directory, "source").manifest;
    const targetPath = disposableRecoveryProvisionPaths(directory, "target").manifest;
    const source = readDisposableRecoveryProvisionArtifacts({
      receiptPath: disposableRecoveryProvisionPaths(directory, "source").phase,
      manifestPath: sourcePath,
      expectedReceiptDirectory: directory,
      role: "source",
    });
    assert.equal(Object.hasOwn(
      source.manifest.operations, "recovery_artifact_key_secret",
    ), false);
    assert.equal(Object.hasOwn(
      source.manifest.operations, "bank_access_wrapping_key_secret",
    ), false);
    const plan = buildVerifiedRecoveryPlan(sourcePath, targetPath, {
      runId: "90000000-0000-4000-8000-000000000009",
      createdAt: "2026-09-13T12:00:00.000Z",
    });
    assert.equal(plan.isolation.required_initial_user_tables, 0);
    assert.equal(plan.isolation.required_initial_vectors, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
