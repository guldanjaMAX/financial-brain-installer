#!/usr/bin/env node

/**
 * Operator entry point for the fixed v0.4.8 disposable deployment proof.
 *
 * Preview is local and read-only. Preflight performs Cloudflare GETs and writes
 * only its owner-private evidence receipt. Mutation is split into source A2
 * and target A4 commands; there is no combined source-and-target command.
 * Cloudflare credentials have no argv or environment option here and are
 * resolved only by the reviewed provider from the macOS Keychain.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import {
  inspectDisposableRecoveryDeploymentPreparation,
  inspectDisposableRecoverySourceDeploymentPreparation,
} from "./cloudflare-recovery-adapter.mjs";
import {
  prepareCloudflareDisposableDeploymentProvider,
} from "./cloudflare-disposable-deployment-provider.mjs";
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
} from "./private-aggregate-receipt.mjs";
import { loadVerifiedRecoveryPlan } from "./verified-recovery.mjs";

export const DISPOSABLE_RECOVERY_FIELD_DEPLOY_CLI_SCHEMA_VERSION = 1;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA40_RE = /^[a-f0-9]{40}$/u;
const COMMANDS = new Set([
  "help",
  "source-preview",
  "source-preflight",
  "source-mutate",
  "target-preview",
  "target-preflight",
  "target-mutate",
]);
const BASE_VALUE_OPTIONS = Object.freeze([
  "candidate-sha",
  "field-receipt",
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
  const sourceMutation = command === "source-mutate";
  const targetMutation = command === "target-mutate";
  const requiredValues = [
    ...BASE_VALUE_OPTIONS,
    ...(sourceCommand ? [] : ["target-manifest"]),
  ];
  const allowed = new Set([
    ...requiredValues,
    ...(sourceMutation ? ["approve-a2"] : []),
    ...(targetMutation ? ["approve-a4"] : []),
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
      sourceMutation && !SHA256_RE.test(String(values["approve-a2"] ?? "")) ||
      targetMutation && !SHA256_RE.test(String(values["approve-a4"] ?? ""))) {
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    command,
    candidateSha: values["candidate-sha"],
    fieldReceiptPath: values["field-receipt"],
    packagePath: values.package,
    planPath: values.plan,
    receiptDirectory: values["receipt-directory"],
    sourceManifestPath: values["source-manifest"],
    ...(sourceCommand ? {} : { targetManifestPath: values["target-manifest"] }),
    wranglerWrapperPath: values["wrangler-wrapper"],
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

function previewResult(command, preparation, provider) {
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
    campaign_fingerprint: preparation.binding.campaign_fingerprint,
    module_inventory_sha256: provider.moduleInventorySha256,
  });
}

/** Execute exactly one local, GET-only, source-only, or target-only command. */
export async function executeDisposableRecoveryFieldDeploy(parsedInput, {
  platform = process.platform,
  assertReceiptDirectory = assertPrivateAggregateReceiptDirectory,
  loadPlan = loadVerifiedRecoveryPlan,
  inspectPreparation = inspectDisposableRecoveryDeploymentPreparation,
  inspectSourcePreparation = inspectDisposableRecoverySourceDeploymentPreparation,
  prepareProvider = prepareCloudflareDisposableDeploymentProvider,
  runSourcePreflight = runDisposableRecoverySourcePreflight,
  runSourcePhase = runDisposableRecoverySourcePhase,
  runTargetPreflight = runDisposableRecoveryTargetPreflight,
  runTargetPhase = runDisposableRecoveryTargetPhase,
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
  let preparation;
  let provider;
  try {
    const plan = loadPlan(parsed.planPath);
    const sourceCommand = parsed.command.startsWith("source-");
    const prepare = sourceCommand ? inspectSourcePreparation : inspectPreparation;
    preparation = prepare({
      candidateSha: parsed.candidateSha,
      fieldReceiptPath: parsed.fieldReceiptPath,
      packagePath: parsed.packagePath,
      wranglerWrapperPath: parsed.wranglerWrapperPath,
      sourceManifestPath: parsed.sourceManifestPath,
      ...(sourceCommand ? {} : { targetManifestPath: parsed.targetManifestPath }),
      plan,
    });
    provider = prepareProvider({
      manifestBindings: preparation.manifestBindings,
      executionPins: preparation.executionPins,
      phase: sourceCommand ? "source" : "target",
    }, { platform });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldDeployCliError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOY_CLI_PREPARATION_FAILED");
  }
  const paths = artifactPaths(directory);
  if (parsed.command.endsWith("-preview")) {
    return previewResult(parsed.command, preparation, provider);
  }
  const shared = {
    binding: preparation.binding,
    moduleInventorySha256: provider.moduleInventorySha256,
    expectedReceiptDirectory: directory,
    createProvider: provider.createProvider,
    revalidate: preparation.revalidate,
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
  const source = "--candidate-sha <40-hex> --source-manifest <private-file> " +
    "--plan <private-file> " +
    "--field-receipt <private-file> --package <private-tarball> " +
    "--wrangler-wrapper <owner-only-wrapper> --receipt-directory <owner-only-dir>";
  const target = `${source} --target-manifest <private-file>`;
  return Object.freeze([
    "Fixed v0.4.8 disposable Cloudflare proof. macOS Keychain only; Windows is unsupported.",
    `source-preview ${source}`,
    `source-preflight ${source}`,
    `source-mutate ${source} --approve-a2 <fingerprint> [--resume]`,
    `target-preview ${target}`,
    `target-preflight ${target}`,
    `target-mutate ${target} --approve-a4 <fingerprint> [--resume]`,
    "Preview performs no network access or writes. Preflight uses Cloudflare GETs only and writes a private evidence receipt.",
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
