#!/usr/bin/env node

/**
 * Operator entry point for the fixed v0.4.8 disposable deployment proof.
 *
 * Preview is local and read-only. Preflight performs Cloudflare GETs and writes
 * only its owner-private evidence receipt. Provisioning is split into A1/A3
 * and deployment is split into A2/A4; there is no combined source-and-target command.
 * Cloudflare credentials have no argv or environment option here and are
 * resolved only by the reviewed provider from the macOS Keychain.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

import {
  inspectDisposableRecoveryDeploymentPreparation,
  inspectDisposableRecoveryProvisioningPreparation,
  inspectDisposableRecoverySourceDeploymentPreparation,
} from "./cloudflare-recovery-adapter.mjs";
import {
  prepareCloudflareDisposableDeploymentProvider,
  prepareCloudflareDisposableProvisioningProvider,
} from "./cloudflare-disposable-deployment-provider.mjs";
import {
  disposableRecoveryProvisionApprovalFingerprint,
  disposableRecoveryProvisionPaths,
  disposableRecoveryProvisioningBinding,
  runDisposableRecoveryProvisionPhase,
  runDisposableRecoveryProvisionPreflight,
} from "./disposable-recovery-field-provision.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ENTRYPOINT_AVAILABLE,
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES,
  DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME,
  runDisposableRecoverySourcePhase,
  runDisposableRecoverySourcePreflight,
  runDisposableRecoveryTargetPhase,
  runDisposableRecoveryTargetPreflight,
} from "./disposable-recovery-field-deploy.mjs";
import {
  disposableRecoverySourceA2Fingerprint,
  disposableRecoveryTargetA4Fingerprint,
} from "./disposable-recovery-deployment-receipt.mjs";
import {
  assertPrivateAggregateReceiptDirectory,
  readPrivateAggregateReceipt,
} from "./private-aggregate-receipt.mjs";
import {
  createDisposableRecoveryFieldKeychainPrep,
  disposableRecoveryFieldKeychainPreparationFingerprint,
  verifyDisposableRecoveryFieldKeychainPrep,
} from "./disposable-recovery-field-keychain-prep.mjs";
import { loadVerifiedRecoveryPlan } from "./verified-recovery.mjs";
import {
  assertV048DisposableCampaignManifestPair,
  validateV048DisposableCampaignManifest,
} from "./v048-disposable-campaign-contract.mjs";

export const DISPOSABLE_RECOVERY_FIELD_DEPLOY_CLI_SCHEMA_VERSION = 1;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA40_RE = /^[a-f0-9]{40}$/u;
const MAX_CAMPAIGN_MANIFEST_BYTES = 1024 * 1024;
const COMMANDS = new Set([
  "help",
  "source-provision-preview",
  "source-provision-preflight",
  "source-provision-mutate",
  "source-preview",
  "source-preflight",
  "source-mutate",
  "target-provision-preview",
  "target-provision-preflight",
  "target-provision-mutate",
  "target-preview",
  "target-preflight",
  "target-mutate",
]);
const BASE_VALUE_OPTIONS = Object.freeze([
  "account-id",
  "candidate-sha",
  "field-receipt",
  "keychain-receipt",
  "package",
  "plan",
  "receipt-directory",
  "source-manifest",
  "wrangler-wrapper",
]);

export class DisposableRecoveryFieldDeployCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldDeployCliError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldDeployCliError(code);
}

function safeOption(value) {
  const option = String(value ?? "").split("=", 1)[0];
  return /^[a-z0-9-]{1,64}$/u.test(option) ? option : "unknown";
}

/** Strict parser: no positionals, `--x=value`, duplicates, or credential flags. */
export function parseDisposableRecoveryFieldDeployArguments(argv = []) {
  if (!Array.isArray(argv)) refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID");
  const [rawCommand, ...tokens] = argv;
  const command = rawCommand === "--help" || rawCommand === "-h"
    ? "help"
    : String(rawCommand ?? "");
  if (!COMMANDS.has(command)) refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_COMMAND_INVALID");
  if (command === "help") {
    if (tokens.length !== 0) refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID");
    return Object.freeze({ command });
  }
  const mutation = command.endsWith("-mutate");
  const sourceCommand = command.startsWith("source-");
  const provisioning = command.includes("-provision-");
  const sourceMutation = command === "source-mutate";
  const targetMutation = command === "target-mutate";
  const sourceProvisionMutation = command === "source-provision-mutate";
  const targetProvisionMutation = command === "target-provision-mutate";
  const requiredValues = provisioning
    ? [
        "account-id", "candidate-sha", "field-receipt", "package",
        "keychain-receipt", "receipt-directory", "wrangler-wrapper",
      ]
    : [...BASE_VALUE_OPTIONS, ...(sourceCommand ? [] : ["target-manifest"])];
  const allowed = new Set([
    ...requiredValues,
    ...(sourceMutation ? ["approve-a2"] : []),
    ...(targetMutation ? ["approve-a4"] : []),
    ...(sourceProvisionMutation ? ["approve-a1"] : []),
    ...(targetProvisionMutation ? ["approve-a3"] : []),
    ...(mutation ? ["resume"] : []),
  ]);
  const values = {};
  const seen = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    if (!token.startsWith("--") || token === "--" || token.includes("=")) {
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID");
    }
    const option = safeOption(token.slice(2));
    if (!allowed.has(option) || seen.has(option)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_OPTION_INVALID");
    }
    seen.add(option);
    if (option === "resume") {
      values.resume = true;
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || String(next).startsWith("--") || String(next).length === 0) {
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID");
    }
    values[option] = String(next);
    index += 1;
  }
  if (requiredValues.some((option) => !Object.hasOwn(values, option)) ||
      values.resume !== undefined && values.resume !== true ||
      !SHA40_RE.test(values["candidate-sha"]) ||
      !/^[a-f0-9]{32}$/u.test(String(values["account-id"] ?? "")) ||
      sourceProvisionMutation && !SHA256_RE.test(String(values["approve-a1"] ?? "")) ||
      targetProvisionMutation && !SHA256_RE.test(String(values["approve-a3"] ?? "")) ||
      sourceMutation && !SHA256_RE.test(String(values["approve-a2"] ?? "")) ||
      targetMutation && !SHA256_RE.test(String(values["approve-a4"] ?? ""))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    command,
    ...(provisioning ? { provisioning: true } : {}),
    accountId: values["account-id"],
    candidateSha: values["candidate-sha"],
    fieldReceiptPath: values["field-receipt"],
    packagePath: values.package,
    keychainReceiptPath: values["keychain-receipt"],
    ...(provisioning ? {} : { planPath: values.plan }),
    receiptDirectory: values["receipt-directory"],
    ...(provisioning ? {} : { sourceManifestPath: values["source-manifest"] }),
    ...(sourceCommand || provisioning ? {} : { targetManifestPath: values["target-manifest"] }),
    wranglerWrapperPath: values["wrangler-wrapper"],
    ...(sourceProvisionMutation ? { a1ApprovalFingerprint: values["approve-a1"] } : {}),
    ...(targetProvisionMutation ? { a3ApprovalFingerprint: values["approve-a3"] } : {}),
    ...(sourceMutation ? { a2ApprovalFingerprint: values["approve-a2"] } : {}),
    ...(targetMutation ? { a4ApprovalFingerprint: values["approve-a4"] } : {}),
    ...(mutation ? { resume: values.resume === true } : {}),
  });
}

function artifactPaths(directory) {
  return Object.freeze({
    sourcePreflight: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.source_preflight,
    ),
    sourcePhase: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.source_phase,
    ),
    sourceJournal: join(directory, DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME),
    seed: join(directory, DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.seed),
    targetPreflight: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.target_preflight,
    ),
    targetPhase: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.target_phase,
    ),
    targetJournal: join(directory, DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME),
  });
}

function previewResult(command, preparation, provider, keychainProof) {
  return Object.freeze({
    schema_version: DISPOSABLE_RECOVERY_FIELD_DEPLOY_CLI_SCHEMA_VERSION,
    kind: command,
    status: "ready_for_read_only_preflight",
    provider_entrypoint_available:
      DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ENTRYPOINT_AVAILABLE,
    field_proven:
      DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
    cloudflare_access: false,
    cloudflare_mutation: false,
    brain_mutation: false,
    local_write: false,
    keychain_access: "read_only",
    keychain_prep_receipt_sha256: keychainProof.receipt_sha256,
    keychain_binding_sha256: keychainProof.keychain_binding_sha256,
    campaign_fingerprint: preparation.binding.campaign_fingerprint,
    module_inventory_sha256: provider.moduleInventorySha256,
  });
}

function readCampaignManifest(path) {
  let raw;
  try {
    raw = readFileSync(resolve(path));
    if (!Buffer.isBuffer(raw) || raw.length < 2 ||
        raw.length > MAX_CAMPAIGN_MANIFEST_BYTES) {
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_CAMPAIGN_INVALID");
    }
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldDeployCliError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_CAMPAIGN_INVALID");
  } finally {
    raw?.fill?.(0);
  }
}

function readKeychainVerificationBinding(parsed, readKeychainReceipt) {
  let publicBinding;
  try {
    const loaded = readKeychainReceipt(resolve(parsed.keychainReceiptPath), {
      code: "DISPOSABLE_RECOVERY_DEPLOY_CLI_KEYCHAIN_RECEIPT_INVALID",
      maxBytes: 1024 * 1024,
    });
    publicBinding = loaded?.value?.binding;
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED");
  }
  const fields = [
    "candidate_sha",
    "candidate_tree_sha",
    "package_sha256",
    "field_receipt_sha256",
    "account_fingerprint",
    "preparation_fingerprint",
  ];
  if (!publicBinding || typeof publicBinding !== "object" ||
      Array.isArray(publicBinding) ||
      Object.keys(publicBinding).sort().join("\0") !== fields.sort().join("\0") ||
      publicBinding.candidate_sha !== parsed.candidateSha ||
      !SHA40_RE.test(String(publicBinding.candidate_tree_sha || "")) ||
      [
        publicBinding.package_sha256,
        publicBinding.field_receipt_sha256,
        publicBinding.account_fingerprint,
        publicBinding.preparation_fingerprint,
      ].some((value) => !SHA256_RE.test(String(value || "")))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED");
  }
  return Object.freeze({
    candidate_sha: parsed.candidateSha,
    candidate_tree_sha: publicBinding.candidate_tree_sha,
    package_sha256: publicBinding.package_sha256,
    field_receipt_sha256: publicBinding.field_receipt_sha256,
    account_id: parsed.accountId,
  });
}

/** Execute exactly one local, GET-only, source-only, or target-only command. */
export async function executeDisposableRecoveryFieldDeploy(parsedInput, {
  platform = process.platform,
  assertReceiptDirectory = assertPrivateAggregateReceiptDirectory,
  loadPlan = loadVerifiedRecoveryPlan,
  inspectPreparation = inspectDisposableRecoveryDeploymentPreparation,
  inspectSourcePreparation = inspectDisposableRecoverySourceDeploymentPreparation,
  inspectProvisioningPreparation = inspectDisposableRecoveryProvisioningPreparation,
  prepareProvider = prepareCloudflareDisposableDeploymentProvider,
  prepareProvisioningProvider = prepareCloudflareDisposableProvisioningProvider,
  createKeychain = createDisposableRecoveryFieldKeychainPrep,
  verifyKeychainPrep = verifyDisposableRecoveryFieldKeychainPrep,
  readKeychainReceipt = readPrivateAggregateReceipt,
  runProvisionPreflight = runDisposableRecoveryProvisionPreflight,
  runProvisionPhase = runDisposableRecoveryProvisionPhase,
  runSourcePreflight = runDisposableRecoverySourcePreflight,
  runSourcePhase = runDisposableRecoverySourcePhase,
  runTargetPreflight = runDisposableRecoveryTargetPreflight,
  runTargetPhase = runDisposableRecoveryTargetPhase,
  loadCampaignManifest = readCampaignManifest,
  validateSourceCampaignManifest = validateV048DisposableCampaignManifest,
  validateCampaignManifestPair = assertV048DisposableCampaignManifestPair,
} = {}) {
  const parsed = parsedInput?.command
    ? parsedInput
    : parseDisposableRecoveryFieldDeployArguments(parsedInput);
  if (parsed.command === "help") return Object.freeze({ help: true });
  if (platform !== "darwin") refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_MACOS_REQUIRED");
  let directory;
  try {
    directory = assertReceiptDirectory(resolve(parsed.receiptDirectory), {
      code: "DISPOSABLE_RECOVERY_DEPLOY_CLI_RECEIPT_DIRECTORY_INVALID",
    }).path;
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_RECEIPT_DIRECTORY_INVALID");
  }
  if (parsed.provisioning === true) {
    const role = parsed.command.startsWith("source-") ? "source" : "target";
    let preparation;
    let provider;
    let binding;
    let keychainProof;
    let revalidate;
    try {
      preparation = inspectProvisioningPreparation({
        candidateSha: parsed.candidateSha,
        fieldReceiptPath: parsed.fieldReceiptPath,
        packagePath: parsed.packagePath,
        wranglerWrapperPath: parsed.wranglerWrapperPath,
      });
      const keychain = createKeychain({ platform });
      const keychainVerificationBinding = Object.freeze({
        candidate_sha: preparation.binding.candidate_sha,
        candidate_tree_sha: preparation.binding.candidate_tree_sha,
        package_sha256: preparation.binding.package_sha256,
        field_receipt_sha256: preparation.binding.field_receipt_sha256,
        account_id: parsed.accountId,
      });
      keychainProof = await verifyKeychainPrep({
        binding: keychainVerificationBinding,
        receiptPath: parsed.keychainReceiptPath,
        expectedReceiptDirectory: directory,
        keychain,
        platform,
      });
      provider = prepareProvisioningProvider({
        executionPins: preparation.executionPins,
        role,
        accountId: parsed.accountId,
        keychainBinding: keychainVerificationBinding,
        keychainProof,
      }, { platform });
      binding = disposableRecoveryProvisioningBinding(
        preparation,
        provider,
        role,
        keychainProof,
      );
      revalidate = async () => {
        if (await preparation.revalidate() !== true) return false;
        return await keychainProof.revalidate() === true;
      };
    } catch (error) {
      if (error instanceof DisposableRecoveryFieldDeployCliError) throw error;
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED");
    }
    const paths = disposableRecoveryProvisionPaths(directory, role);
    if (parsed.command.endsWith("-preview")) {
      return Object.freeze({
        schema_version: 1,
        kind: parsed.command,
        status: "ready_for_read_only_collision_preflight",
        action: binding.action,
        cloudflare_access: false,
        cloudflare_mutation: false,
        brain_mutation: false,
        local_write: false,
        campaign_fingerprint: binding.campaign_fingerprint,
        keychain_access: "read_only",
        keychain_prep_receipt_sha256: binding.keychain_prep_receipt_sha256,
        keychain_binding_sha256: binding.keychain_binding_sha256,
        candidate_module_inventory_sha256: binding.candidate_module_inventory_sha256,
        migration_inventory_sha256: binding.migration_inventory_sha256,
        bootstrap_module_inventory_sha256: binding.bootstrap_module_inventory_sha256,
      });
    }
    if (parsed.command.endsWith("-preflight")) {
      const result = await runProvisionPreflight({
        binding,
        keychainProof,
        provider,
        receiptPath: paths.preflight,
        expectedReceiptDirectory: directory,
        revalidate,
      });
      return Object.freeze({
        schema_version: 1,
        kind: parsed.command,
        status: "passed",
        action: binding.action,
        cloudflare_access: "read_only",
        cloudflare_mutation: false,
        local_receipt_written: true,
        receipt_sha256: result.receiptSha256,
        [`${binding.action.toLowerCase()}_approval_fingerprint`]:
          disposableRecoveryProvisionApprovalFingerprint(binding, result.receiptSha256),
      });
    }
    const result = await runProvisionPhase({
      binding,
      keychainProof,
      provider,
      preflightReceiptPath: paths.preflight,
      approvalFingerprint: role === "source"
        ? parsed.a1ApprovalFingerprint
        : parsed.a3ApprovalFingerprint,
      journalPath: paths.journal,
      receiptPath: paths.phase,
      manifestPath: paths.manifest,
      expectedReceiptDirectory: directory,
      resume: parsed.resume,
      revalidate,
    });
    return Object.freeze({
      schema_version: 1,
      kind: parsed.command,
      status: "passed",
      action: binding.action,
      phase: role === "source" ? "A1_source_provision" : "A3_target_provision",
      receipt_sha256: result.receiptSha256,
      manifest_sha256: result.manifestSha256,
      manifest_path: paths.manifest,
      worker_identity: "sealed_in_owner_private_receipt_and_manifest",
    });
  }
  let preparation;
  let provider;
  let keychainProof;
  let keychainVerificationBinding;
  try {
    const plan = loadPlan(parsed.planPath);
    const sourceCommand = parsed.command.startsWith("source-");
    const keychain = createKeychain({ platform });
    keychainVerificationBinding = readKeychainVerificationBinding(
      parsed,
      readKeychainReceipt,
    );
    keychainProof = await verifyKeychainPrep({
      binding: keychainVerificationBinding,
      receiptPath: parsed.keychainReceiptPath,
      expectedReceiptDirectory: directory,
      keychain,
      platform,
    });
    const sourceManifest = loadCampaignManifest(parsed.sourceManifestPath);
    if (sourceCommand) {
      validateSourceCampaignManifest(sourceManifest, "source");
    } else {
      const targetManifest = loadCampaignManifest(parsed.targetManifestPath);
      validateCampaignManifestPair(sourceManifest, targetManifest);
    }
    const prepare = sourceCommand ? inspectSourcePreparation : inspectPreparation;
    preparation = prepare({
      candidateSha: parsed.candidateSha,
      fieldReceiptPath: parsed.fieldReceiptPath,
      packagePath: parsed.packagePath,
      wranglerWrapperPath: parsed.wranglerWrapperPath,
      sourceManifestPath: parsed.sourceManifestPath,
      ...(sourceCommand ? {} : { targetManifestPath: parsed.targetManifestPath }),
      keychainProof,
      plan,
    });
    const manifestAccounts = sourceCommand
      ? [preparation.manifestBindings?.source?.accountId]
      : [
          preparation.manifestBindings?.source?.accountId,
          preparation.manifestBindings?.target?.accountId,
        ];
    if (manifestAccounts.some((accountId) => accountId !== parsed.accountId)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED");
    }
    const expectedPreparationFingerprint =
      disposableRecoveryFieldKeychainPreparationFingerprint({
        candidate_sha: preparation.binding.candidate_sha,
        candidate_tree_sha: preparation.binding.candidate_tree_sha,
        package_sha256: preparation.binding.package_sha256,
        field_receipt_sha256: preparation.binding.field_receipt_sha256,
        account_id: parsed.accountId,
      });
    if (preparation.binding.keychain_binding_sha256 !==
          keychainProof.keychain_binding_sha256 ||
        keychainProof.preparation_fingerprint !== expectedPreparationFingerprint) {
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED");
    }
    if (!sourceCommand &&
        !SHA256_RE.test(String(preparation.vectorizeMutationQuiescenceFingerprint ?? ""))) {
      refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_VECTORIZE_QUIESCENCE_REQUIRED");
    }
    provider = prepareProvider({
      manifestBindings: preparation.manifestBindings,
      executionPins: preparation.executionPins,
      phase: sourceCommand ? "source" : "target",
      keychainBinding: keychainVerificationBinding,
      keychainProof,
    }, { platform });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldDeployCliError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED");
  }
  const paths = artifactPaths(directory);
  if (parsed.command.endsWith("-preview")) {
    return previewResult(parsed.command, preparation, provider, keychainProof);
  }
  const revalidate = async () => {
    if (await preparation.revalidate() !== true) return false;
    return await keychainProof.revalidate() === true;
  };
  const shared = {
    binding: preparation.binding,
    keychainBinding: keychainVerificationBinding,
    keychainProof,
    moduleInventorySha256: provider.moduleInventorySha256,
    expectedReceiptDirectory: directory,
    createProvider: provider.createProvider,
    revalidate,
  };
  if (parsed.command === "source-preflight") {
    const result = await runSourcePreflight({
      ...shared,
      receiptPath: paths.sourcePreflight,
    });
    return Object.freeze({
      schema_version: 1,
      kind: parsed.command,
      status: "passed",
      cloudflare_access: "read_only",
      cloudflare_mutation: false,
      brain_mutation: false,
      local_receipt_written: true,
      receipt_sha256: result.receiptSha256,
      a2_approval_fingerprint: disposableRecoverySourceA2Fingerprint(
        preparation.binding,
        result.receiptSha256,
      ),
      field_proven: DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
    });
  }
  if (parsed.command === "source-mutate") {
    const result = await runSourcePhase({
      ...shared,
      sourcePreflightReceiptPath: paths.sourcePreflight,
      a2ApprovalFingerprint: parsed.a2ApprovalFingerprint,
      journalPath: paths.sourceJournal,
      receiptPath: paths.sourcePhase,
      resume: parsed.resume,
    });
    return Object.freeze({
      schema_version: 1,
      kind: parsed.command,
      status: "passed",
      phase: "A2_source_only",
      receipt_sha256: result.receiptSha256,
      field_proven: DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
    });
  }
  if (parsed.command === "target-preflight") {
    const result = await runTargetPreflight({
      ...shared,
      sourcePhaseReceiptPath: paths.sourcePhase,
      seedReceiptPath: paths.seed,
      vectorizeMutationQuiescenceFingerprint:
        preparation.vectorizeMutationQuiescenceFingerprint,
      receiptPath: paths.targetPreflight,
    });
    return Object.freeze({
      schema_version: 1,
      kind: parsed.command,
      status: "passed",
      cloudflare_access: "read_only",
      cloudflare_mutation: false,
      brain_mutation: false,
      local_receipt_written: true,
      receipt_sha256: result.receiptSha256,
      a4_approval_fingerprint: disposableRecoveryTargetA4Fingerprint(
        preparation.binding,
        result.receipt.source_phase_receipt_sha256,
        result.receipt.seed_receipt_sha256,
        result.receiptSha256,
      ),
      field_proven: DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
    });
  }
  if (parsed.command === "target-mutate") {
    const result = await runTargetPhase({
      ...shared,
      sourcePhaseReceiptPath: paths.sourcePhase,
      seedReceiptPath: paths.seed,
      targetPreflightReceiptPath: paths.targetPreflight,
      a4ApprovalFingerprint: parsed.a4ApprovalFingerprint,
      vectorizeMutationQuiescenceFingerprint:
        preparation.vectorizeMutationQuiescenceFingerprint,
      journalPath: paths.targetJournal,
      receiptPath: paths.targetPhase,
      resume: parsed.resume,
    });
    return Object.freeze({
      schema_version: 1,
      kind: parsed.command,
      status: "passed",
      phase: "A4_target_only",
      receipt_sha256: result.receiptSha256,
      field_proven: DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY,
    });
  }
  refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_COMMAND_INVALID");
}

export function disposableRecoveryFieldDeployHelp() {
  const provision = "--account-id <32-hex> --candidate-sha <40-hex> " +
    "--field-receipt <private-file> --package <private-tarball> " +
    "--keychain-receipt <private-k0-receipt> " +
    "--wrangler-wrapper <owner-only-wrapper> --receipt-directory <owner-only-dir>";
  const source = "--candidate-sha <40-hex> --source-manifest <private-file> " +
    "--plan <private-file> " +
    "--field-receipt <private-file> --package <private-tarball> " +
    "--account-id <32-hex> --keychain-receipt <private-k0-receipt> " +
    "--wrangler-wrapper <owner-only-wrapper> --receipt-directory <owner-only-dir>";
  const target = `${source} --target-manifest <private-file>`;
  return Object.freeze([
    "Fixed v0.4.8 disposable Cloudflare proof. macOS Keychain only; Windows is unsupported.",
    "Required order: A1 source provision, separately approved A3 target provision, freeze the full plan, A2 source deploy, source seed, then A4 target deploy.",
    `source-provision-preview ${provision}`,
    `source-provision-preflight ${provision}`,
    `source-provision-mutate ${provision} --approve-a1 <fingerprint> [--resume]`,
    `target-provision-preview ${provision}`,
    `target-provision-preflight ${provision}`,
    `target-provision-mutate ${provision} --approve-a3 <fingerprint> [--resume]`,
    `source-preview ${source}`,
    `source-preflight ${source}`,
    `source-mutate ${source} --approve-a2 <fingerprint> [--resume]`,
    `target-preview ${target}`,
    `target-preflight ${target}`,
    `target-mutate ${target} --approve-a4 <fingerprint> [--resume]`,
    "Preview performs no network access or writes. Preflight uses Cloudflare GETs only and writes a private evidence receipt.",
    "A1/A3 create only fixed disposable resources and a maintenance bootstrap; generated manifests bind immutable Worker IDs.",
    "Mutation commands never combine source and target. Do not put credentials or tokens in command arguments.",
    "Entrypoint is packaged but not field-proven until the exact disposable run completes.",
  ]);
}

function safeFailureCode(error) {
  const value = String(error?.code ?? "");
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(value)
    ? value
    : "DISPOSABLE_RECOVERY_DEPLOY_CLI_FAILED";
}

export async function main(argv = process.argv.slice(2), {
  stdout = (value) => console.log(value),
  stderr = (value) => console.error(value),
  ...dependencies
} = {}) {
  let parsed;
  try { parsed = parseDisposableRecoveryFieldDeployArguments(argv); }
  catch (error) {
    stderr(`Disposable recovery deployment stopped: ${safeFailureCode(error)}`);
    for (const line of disposableRecoveryFieldDeployHelp()) stderr(line);
    return 1;
  }
  if (parsed.command === "help") {
    for (const line of disposableRecoveryFieldDeployHelp()) stdout(line);
    return 0;
  }
  try {
    const result = await executeDisposableRecoveryFieldDeploy(parsed, dependencies);
    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    stderr(`Disposable recovery deployment stopped: ${safeFailureCode(error)}`);
    return 1;
  }
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) &&
    realpathSync.native(resolve(process.argv[1])) ===
      realpathSync.native(fileURLToPath(import.meta.url));
} catch { /* a missing or replaced invocation path is never a direct run */ }
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Disposable recovery deployment stopped: DISPOSABLE_RECOVERY_DEPLOY_CLI_FAILED");
    process.exitCode = 1;
  });
}
