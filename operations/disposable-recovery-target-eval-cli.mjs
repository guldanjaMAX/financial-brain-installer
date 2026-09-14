#!/usr/bin/env node
/**
 * Preview and execute the aggregate post-recovery target evaluation. Preview
 * is local-only. Execute reuses the already reviewed recovery adapter and its
 * exact resource, wrapper, Keychain, active-version, health, D1, Vectorize,
 * and private release-suite checks. It writes no corpus, configuration,
 * access, or infrastructure state; answer-model calls may create ordinary
 * aggregate usage records.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createCloudflareRecoveryFieldGateAdapters,
} from "./cloudflare-recovery-adapter.mjs";
import {
  assertDisposableRecoveryDeploymentReceiptChain,
  readDisposableRecoveryDeploymentReceipt,
  readDisposableRecoverySourcePhaseReceipt,
  readDisposableRecoverySourcePreflightReceipt,
  readDisposableRecoveryTargetPreflightReceipt,
} from "./disposable-recovery-deployment-receipt.mjs";
import {
  assertDisposableRecoverySeedReceipt,
} from "./disposable-recovery-seeder.mjs";
import {
  assertDisposableRecoveryTargetEvalBinding,
  disposableRecoveryTargetEvalApprovalFingerprint,
  runDisposableRecoveryTargetEvaluation,
} from "./disposable-recovery-target-eval.mjs";
import {
  assertDisposableRecoveryFieldKeychainVerificationBinding,
  createDisposableRecoveryFieldKeychainPrep,
  verifyDisposableRecoveryFieldKeychainPrep,
} from "./disposable-recovery-field-keychain-prep.mjs";
import { readPrivateAggregateReceipt } from "./private-aggregate-receipt.mjs";
import {
  validateVerifiedRecoveryPlan,
  validateVerifiedRecoveryState,
  verifiedRecoveryStatus,
} from "./verified-recovery.mjs";

export class DisposableRecoveryTargetEvalCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryTargetEvalCliError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryTargetEvalCliError(code);
}

function readPrivate(path, code) {
  try { return readPrivateAggregateReceipt(resolve(path), { code, maxBytes: 16 * 1024 * 1024 }); }
  catch { refuse(code); }
}

function assertPreparation(values, includeRevalidation = true) {
  let sourcePreflight;
  let sourcePhase;
  let seed;
  let targetPreflight;
  let deployment;
  let planRecord;
  let stateRecord;
  let goldenRecord;
  let plan;
  let state;
  try {
    sourcePreflight = readDisposableRecoverySourcePreflightReceipt(
      resolve(values["source-preflight-receipt"]),
    );
    sourcePhase = readDisposableRecoverySourcePhaseReceipt(
      resolve(values["source-phase-receipt"]),
    );
    seed = readPrivate(values["seed-receipt"], "DISPOSABLE_RECOVERY_TARGET_EVAL_SEED_INVALID");
    assertDisposableRecoverySeedReceipt(seed.value);
    targetPreflight = readDisposableRecoveryTargetPreflightReceipt(
      resolve(values["target-preflight-receipt"]),
    );
    deployment = readDisposableRecoveryDeploymentReceipt(resolve(values["deployment-receipt"]));
    assertDisposableRecoveryDeploymentReceiptChain({
      source_preflight: sourcePreflight,
      source_phase: sourcePhase,
      seed_receipt_sha256: seed.sha256,
      target_preflight: targetPreflight,
      target_phase: deployment,
    });
    planRecord = readPrivate(values.plan, "DISPOSABLE_RECOVERY_TARGET_EVAL_PLAN_INVALID");
    stateRecord = readPrivate(values.state, "DISPOSABLE_RECOVERY_TARGET_EVAL_STATE_INVALID");
    goldenRecord = readPrivate(values.golden, "DISPOSABLE_RECOVERY_TARGET_EVAL_GOLDEN_INVALID");
    plan = validateVerifiedRecoveryPlan(planRecord.value);
    state = validateVerifiedRecoveryState(stateRecord.value, plan);
  } catch (error) {
    if (error instanceof DisposableRecoveryTargetEvalCliError) throw error;
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_INVALID");
  }
  const status = verifiedRecoveryStatus(plan, state);
  const deploymentBinding = deployment.value.binding;
  const field = state.field_proof;
  const seedBinding = seed.value.binding;
  const seedSource = sourcePhase.value.source;
  const seedMatchesCampaign = [
    ["candidate_sha", deploymentBinding.candidate_sha],
    ["candidate_tree_sha", deploymentBinding.candidate_tree_sha],
    ["field_receipt_sha256", deploymentBinding.field_receipt_sha256],
    ["package_sha256", deploymentBinding.package_sha256],
    ["package_file_count", deploymentBinding.package_file_count],
    ["execution_inventory_sha256", deploymentBinding.execution_inventory_sha256],
    ["installed_execution_inventory_sha256",
      deploymentBinding.installed_execution_inventory_sha256],
    ["source_manifest_fingerprint", plan.source_manifest_fingerprint],
    ["source_resource_fingerprint", plan.source_resource_fingerprint],
    ["runtime_contract_fingerprint", plan.runtime_contract_fingerprint],
    ["wrangler_wrapper_sha256", deploymentBinding.wrangler_wrapper_sha256],
    ["wrangler_runtime_inventory_sha256",
      deploymentBinding.wrangler_runtime_inventory_sha256],
    ["wrangler_entrypoint_sha256", deploymentBinding.wrangler_entrypoint_sha256],
    ["node_executable_sha256", deploymentBinding.node_executable_sha256],
    ["source_phase_receipt_sha256", sourcePhase.sha256],
    ["source_phase_run_id", sourcePhase.value.binding.run_id],
    ["source_a2_approval_fingerprint", sourcePhase.value.a2_approval_fingerprint],
    ["source_active_version_id", seedSource.active_version.version_id],
    ["source_script_etag", seedSource.active_version.script_etag],
    ["source_deployment_id", seedSource.active_deployment.deployment_id],
  ].every(([name, expected]) => seedBinding?.[name] === expected);
  if (status.status !== "complete" || !field ||
      !seedMatchesCampaign ||
      deploymentBinding.plan_fingerprint !== plan.plan_fingerprint ||
      deploymentBinding.source_manifest_fingerprint !== plan.source_manifest_fingerprint ||
      deploymentBinding.target_manifest_fingerprint !== plan.target_manifest_fingerprint ||
      deploymentBinding.source_resource_fingerprint !== plan.source_resource_fingerprint ||
      deploymentBinding.target_resource_fingerprint !== plan.target_resource_fingerprint ||
      field.candidate_sha !== deploymentBinding.candidate_sha ||
      field.package_sha256 !== deploymentBinding.package_sha256 ||
      field.field_receipt_sha256 !== deploymentBinding.field_receipt_sha256 ||
      field.source_phase_receipt_sha256 !== sourcePhase.sha256 ||
      field.seed_receipt_sha256 !== seed.sha256 ||
      field.deployment_receipt_sha256 !== deployment.sha256 ||
      field.seed_d1_content_fingerprint !== seed.value.d1.content_fingerprint ||
      field.expected_documents !== seed.value.d1.documents ||
      field.expected_chunks !== seed.value.d1.chunks ||
      field.expected_fts !== seed.value.d1.fts ||
      field.seed_replay_unchanged_documents !==
        seed.value.verification_replay.unchanged_documents ||
      typeof deployment.value.target.active_version.version_id !== "string" ||
      !deployment.value.target.active_version.version_id ||
      deployment.value.target.active_version.version_id ===
        deployment.value.target.paused_version.version_id) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_INVALID");
  }
  const binding = assertDisposableRecoveryTargetEvalBinding({
    candidate_sha: deploymentBinding.candidate_sha,
    candidate_tree_sha: deploymentBinding.candidate_tree_sha,
    package_sha256: deploymentBinding.package_sha256,
    field_receipt_sha256: deploymentBinding.field_receipt_sha256,
    campaign_fingerprint: deploymentBinding.campaign_fingerprint,
    keychain_binding_sha256: deploymentBinding.keychain_binding_sha256,
    recovery_plan_fingerprint: plan.plan_fingerprint,
    recovery_state_sha256: stateRecord.sha256,
    golden_sha256: goldenRecord.sha256,
    source_resource_fingerprint: plan.source_resource_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    active_worker_version_id: deployment.value.target.active_version.version_id,
  });
  const evidence = Object.freeze({
    source_preflight_sha256: sourcePreflight.sha256,
    source_phase_sha256: sourcePhase.sha256,
    seed_sha256: seed.sha256,
    target_preflight_sha256: targetPreflight.sha256,
    deployment_sha256: deployment.sha256,
    plan_sha256: planRecord.sha256,
    state_sha256: stateRecord.sha256,
    golden_sha256: goldenRecord.sha256,
  });
  const prepared = {
    binding,
    approvalFingerprint: disposableRecoveryTargetEvalApprovalFingerprint(binding),
    plan,
    state,
    deployment,
    stateSha256: stateRecord.sha256,
    goldenSha256: goldenRecord.sha256,
    evidence,
  };
  if (includeRevalidation) {
    prepared.revalidate = () => {
      let current;
      try { current = assertPreparation(values, false); }
      catch { refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED"); }
      if (JSON.stringify(current.evidence) !== JSON.stringify(evidence) ||
          JSON.stringify(current.binding) !== JSON.stringify(binding) ||
          current.approvalFingerprint !== prepared.approvalFingerprint) {
        refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED");
      }
      return true;
    };
  }
  return Object.freeze(prepared);
}

const COMMON_FLAGS = Object.freeze([
  "account-id", "keychain-receipt", "source-manifest", "target-manifest",
  "plan", "state", "artifact-directory",
  "wrangler-wrapper", "golden", "source-preflight-receipt", "source-phase-receipt",
  "seed-receipt", "target-preflight-receipt", "deployment-receipt",
]);
const EXECUTE_FLAGS = Object.freeze([
  "receipt", "approve-target-eval", "approve-plan", "approve-disposable-target",
  "approve-target-execution", "approve-source-export-blocking", "approve-wrapper",
  "approve-golden",
]);

export function parseDisposableRecoveryTargetEvalArguments(argv) {
  if (!Array.isArray(argv) || !["preview", "execute"].includes(argv[0])) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_ARGUMENTS_INVALID");
  }
  const command = argv[0];
  const allowed = new Set([
    ...COMMON_FLAGS,
    ...(command === "execute" ? EXECUTE_FLAGS : []),
  ]);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/u.test(flag || "") || !allowed.has(flag.slice(2)) ||
        typeof value !== "string" || !value || value.startsWith("--") ||
        Object.hasOwn(values, flag.slice(2))) {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_ARGUMENTS_INVALID");
    }
    values[flag.slice(2)] = value;
  }
  const required = [
    ...COMMON_FLAGS,
    ...(command === "execute" ? EXECUTE_FLAGS : []),
  ];
  if (argv.length !== 1 + required.length * 2 ||
      required.some((field) => !values[field]) ||
      Object.keys(values).some((field) => !required.includes(field)) ||
      !/^[a-f0-9]{32}$/u.test(String(values["account-id"] || ""))) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_ARGUMENTS_INVALID");
  }
  return Object.freeze({ command, values: Object.freeze(values) });
}

function gateConfig(values, preparation, execute) {
  return Object.freeze({
    sourceManifestPath: resolve(values["source-manifest"]),
    targetManifestPath: resolve(values["target-manifest"]),
    planPath: resolve(values.plan),
    statePath: resolve(values.state),
    artifactDirectory: resolve(values["artifact-directory"]),
    wranglerWrapperPath: resolve(values["wrangler-wrapper"]),
    goldenPath: resolve(values.golden),
    fieldDeploymentReceiptPath: resolve(values["deployment-receipt"]),
    plan: preparation.plan,
    state: preparation.state,
    ...(execute ? {
      approvePlan: values["approve-plan"],
      approveDisposableTarget: values["approve-disposable-target"],
      approveTargetExecution: values["approve-target-execution"],
      approveSourceExportBlocking: values["approve-source-export-blocking"],
      approveWrapper: values["approve-wrapper"],
      approveGolden: values["approve-golden"],
    } : {}),
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseDisposableRecoveryTargetEvalArguments(argv);
  const values = parsed.values;
  const preparation = (dependencies.inspectPreparation ?? assertPreparation)(values);
  const keychainBinding = Object.freeze({
    candidate_sha: preparation.binding.candidate_sha,
    candidate_tree_sha: preparation.binding.candidate_tree_sha,
    package_sha256: preparation.binding.package_sha256,
    field_receipt_sha256: preparation.binding.field_receipt_sha256,
    account_id: values["account-id"],
  });
  let keychainProof;
  try {
    const createKeychain = dependencies.createKeychain ??
      createDisposableRecoveryFieldKeychainPrep;
    const verifyKeychainPrep = dependencies.verifyKeychainPrep ??
      verifyDisposableRecoveryFieldKeychainPrep;
    keychainProof = await verifyKeychainPrep({
      binding: keychainBinding,
      receiptPath: resolve(values["keychain-receipt"]),
      expectedReceiptDirectory: resolve(values["artifact-directory"]),
      keychain: createKeychain({ platform: dependencies.platform ?? process.platform }),
      platform: dependencies.platform ?? process.platform,
    });
    assertDisposableRecoveryFieldKeychainVerificationBinding(
      keychainProof,
      keychainBinding,
      preparation.binding.keychain_binding_sha256,
    );
  } catch {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_KEYCHAIN_BINDING_INVALID");
  }
  const createGate = dependencies.createGate ?? createCloudflareRecoveryFieldGateAdapters;
  const gate = createGate({
    ...gateConfig(values, preparation, parsed.command === "execute"),
    keychainBinding,
    keychainProof,
  }, dependencies);
  if (typeof preparation.revalidate !== "function" ||
      typeof gate.revalidate !== "function" ||
      !Array.isArray(gate.manifestAccountIds) ||
      gate.manifestAccountIds.length !== 2 ||
      gate.manifestAccountIds.some((accountId) => accountId !== keychainBinding.account_id) ||
      JSON.stringify(gate.a4CampaignAuthority) !== JSON.stringify(
        preparation.deployment.value.final_semantic.campaign_authority,
      ) ||
      preparation.binding.golden_sha256 !== gate.goldenApprovalFingerprint) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_INVALID");
  }
  const revalidate = async () => {
    try {
      assertDisposableRecoveryFieldKeychainVerificationBinding(
        keychainProof,
        keychainBinding,
        preparation.binding.keychain_binding_sha256,
      );
    } catch {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED");
    }
    if (await preparation.revalidate() !== true ||
        await keychainProof.revalidate() !== true ||
        await gate.revalidate() !== true ||
        gate.manifestAccountIds.some((accountId) => accountId !== keychainBinding.account_id) ||
        preparation.binding.golden_sha256 !== gate.goldenApprovalFingerprint) {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED");
    }
    try {
      assertDisposableRecoveryFieldKeychainVerificationBinding(
        keychainProof,
        keychainBinding,
        preparation.binding.keychain_binding_sha256,
      );
    } catch {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED");
    }
    return true;
  };
  await revalidate();
  const preview = Object.freeze({
    mode: "v048_disposable_target_eval",
    preview_writes: "none",
    execute_writes: "ordinary_aggregate_usage_records_only",
    execute_corpus_mutations: false,
    execute_provider_mutations: false,
    execute_may_create_ordinary_aggregate_usage_records: true,
    keychain_binding_sha256: preparation.binding.keychain_binding_sha256,
    target_eval_approval_fingerprint: preparation.approvalFingerprint,
    plan_approval_fingerprint: preparation.plan.plan_fingerprint,
    target_resource_approval_fingerprint: preparation.plan.target_resource_fingerprint,
    target_execution_approval_fingerprint: gate.targetExecutionApprovalFingerprint,
    source_export_blocking_approval_fingerprint:
      preparation.plan.source_resource_fingerprint,
    wrapper_approval_fingerprint: gate.wrapperApprovalFingerprint,
    golden_approval_fingerprint: gate.goldenApprovalFingerprint,
  });
  if (parsed.command === "preview") {
    (dependencies.stdout ?? ((value) => process.stdout.write(value)))(
      `${JSON.stringify(preview, null, 2)}\n`,
    );
    return preview;
  }
  if (values["approve-target-eval"] !== preparation.approvalFingerprint ||
      values["approve-plan"] !== preparation.plan.plan_fingerprint ||
      values["approve-disposable-target"] !== preparation.plan.target_resource_fingerprint ||
      values["approve-target-execution"] !== gate.targetExecutionApprovalFingerprint ||
      values["approve-source-export-blocking"] !== preparation.plan.source_resource_fingerprint ||
      values["approve-wrapper"] !== gate.wrapperApprovalFingerprint ||
      values["approve-golden"] !== gate.goldenApprovalFingerprint) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_APPROVAL_INVALID");
  }
  await revalidate();
  const lock = gate.acquireLock();
  let releaseError = null;
  try {
    const result = await (dependencies.runEvaluation ??
      runDisposableRecoveryTargetEvaluation)({
      binding: preparation.binding,
      keychainBinding,
      keychainProof,
      a4CampaignAuthority:
        preparation.deployment.value.final_semantic.campaign_authority,
      approvalFingerprint: values["approve-target-eval"],
      receiptPath: resolve(values.receipt),
      expectedReceiptDirectory: resolve(values["artifact-directory"]),
      transport: gate.targetEvaluationTransport,
      revalidate,
      now: dependencies.now ?? (() => new Date()),
    });
    (dependencies.stdout ?? ((value) => process.stdout.write(value)))(
      `${JSON.stringify({
        mode: "v048_disposable_target_eval",
        status: result.receipt.status,
        receipt_sha256: result.receiptSha256,
      }, null, 2)}\n`,
    );
    return result;
  } finally {
    try { gate.releaseLock(lock); } catch (error) { releaseError = error; }
    if (releaseError) throw releaseError;
  }
}

function usage() {
  return "usage: brain-v048-disposable-target-eval preview|execute <reviewed exact flags>";
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) &&
    realpathSync.native(fileURLToPath(import.meta.url)) ===
      realpathSync.native(resolve(process.argv[1]));
} catch { /* missing or replaced invocation paths are never direct runs */ }
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || error?.message || "target evaluation failed"}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
