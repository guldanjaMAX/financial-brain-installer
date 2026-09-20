#!/usr/bin/env node

/**
 * Fixed A13-A16 operator entry point for the v0.4.8 disposable campaign.
 *
 * Every command is one-brain only. Cloudflare credentials have no CLI or
 * environment option: the broker can reach them only through the separately
 * reviewed owner-only Keychain wrapper.
 */

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectDisposableRecoveryDeploymentPreparation,
} from "./cloudflare-recovery-adapter.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES,
} from "./disposable-recovery-field-provision.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
} from "./disposable-recovery-deployment-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  createDisposableRecoveryFieldKeychainPrep,
  verifyDisposableRecoveryFieldKeychainPrep,
} from "./disposable-recovery-field-keychain-prep.mjs";
import {
  DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  assertDisposableRecoveryTargetEvalReceipt,
} from "./disposable-recovery-field-acceptance.mjs";
import {
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_ABSENT_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_ABSENT_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME,
  assertDisposableRecoveryTeardownA12EvidenceCapability,
  assertDisposableRecoveryTeardownProvisionArtifactsCapability,
  readDisposableRecoverySourceTeardownReceipt,
  readDisposableRecoveryTeardownA12Evidence,
  readDisposableRecoveryTeardownProvisionArtifacts,
  runDisposableRecoveryTeardownMutation,
  runDisposableRecoveryTeardownPreview,
} from "./disposable-recovery-field-teardown.mjs";
import {
  assertPrivateAggregateReceiptDirectory,
  readPrivateAggregateReceipt,
} from "./private-aggregate-receipt.mjs";
import {
  loadVerifiedRecoveryPlan,
} from "./verified-recovery.mjs";

export const DISPOSABLE_RECOVERY_FIELD_TEARDOWN_CLI_SCHEMA_VERSION = 1;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA40_RE = /^[a-f0-9]{40}$/u;
const COMMANDS = new Set([
  "help",
  "source-preview",
  "source-mutate",
  "target-preview",
  "target-mutate",
]);
const VALUE_OPTIONS = Object.freeze([
  "candidate-sha",
  "field-receipt",
  "package",
  "plan",
  "state",
  "golden",
  "receipt-directory",
  "source-manifest",
  "target-manifest",
  "wrangler-wrapper",
  "teardown-wrapper",
]);
const MAINTENANCE_WINDOW = Object.freeze({
  single_operator: true,
  other_actors_paused: true,
});

export class DisposableRecoveryFieldTeardownCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldTeardownCliError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldTeardownCliError(code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactUtcRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u
    .exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour && calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
}

function safeOption(value) {
  const option = String(value ?? "").split("=", 1)[0];
  return /^[a-z0-9-]{1,64}$/u.test(option) ? option : "unknown";
}

/** Strict parser: no positionals, equals syntax, duplicate, or secret flags. */
export function parseDisposableRecoveryFieldTeardownArguments(argv = []) {
  if (!Array.isArray(argv)) refuse("DISPOSABLE_TEARDOWN_CLI_ARGUMENTS_INVALID");
  const [rawCommand, ...tokens] = argv;
  const command = rawCommand === "--help" || rawCommand === "-h"
    ? "help"
    : String(rawCommand ?? "");
  if (!COMMANDS.has(command)) refuse("DISPOSABLE_TEARDOWN_CLI_COMMAND_INVALID");
  if (command === "help") {
    if (tokens.length !== 0) refuse("DISPOSABLE_TEARDOWN_CLI_ARGUMENTS_INVALID");
    return Object.freeze({ command });
  }
  const mutation = command.endsWith("-mutate");
  const approval = command.startsWith("source-") ? "approve-a14" : "approve-a16";
  const allowed = new Set([
    ...VALUE_OPTIONS,
    "maintenance-window-confirmed",
    "resume",
    ...(mutation ? [approval] : []),
  ]);
  const values = {};
  const seen = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    if (!token.startsWith("--") || token === "--" || token.includes("=")) {
      refuse("DISPOSABLE_TEARDOWN_CLI_ARGUMENTS_INVALID");
    }
    const option = safeOption(token.slice(2));
    if (!allowed.has(option) || seen.has(option)) {
      refuse("DISPOSABLE_TEARDOWN_CLI_OPTION_INVALID");
    }
    seen.add(option);
    if (["resume", "maintenance-window-confirmed"].includes(option)) {
      values[option] = true;
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || String(next).startsWith("--") || !String(next)) {
      refuse("DISPOSABLE_TEARDOWN_CLI_ARGUMENTS_INVALID");
    }
    values[option] = String(next);
    index += 1;
  }
  if (VALUE_OPTIONS.some((option) => !Object.hasOwn(values, option)) ||
      values["maintenance-window-confirmed"] !== true ||
      !SHA40_RE.test(String(values["candidate-sha"] || "")) ||
      mutation && !SHA256_RE.test(String(values[approval] || ""))) {
    refuse("DISPOSABLE_TEARDOWN_CLI_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    command,
    role: command.startsWith("source-") ? "source" : "target",
    mutation,
    candidateSha: values["candidate-sha"],
    fieldReceiptPath: values["field-receipt"],
    packagePath: values.package,
    planPath: values.plan,
    statePath: values.state,
    goldenPath: values.golden,
    receiptDirectory: values["receipt-directory"],
    sourceManifestPath: values["source-manifest"],
    targetManifestPath: values["target-manifest"],
    wranglerWrapperPath: values["wrangler-wrapper"],
    teardownWrapperPath: values["teardown-wrapper"],
    approvalFingerprint: mutation ? values[approval] : null,
    resume: values.resume === true,
    maintenanceWindow: MAINTENANCE_WINDOW,
  });
}

function artifactPaths(directory, role) {
  const source = role === "source";
  return Object.freeze({
    preview: join(directory, source
      ? DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_PREVIEW_NAME
      : DISPOSABLE_RECOVERY_TARGET_TEARDOWN_PREVIEW_NAME),
    receipt: join(directory, source
      ? DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME
      : DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME),
    absent: join(directory, source
      ? DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_ABSENT_PREVIEW_NAME
      : DISPOSABLE_RECOVERY_TARGET_TEARDOWN_ABSENT_PREVIEW_NAME),
    sourceTeardown: join(directory, DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME),
    sourceProvision: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_phase,
    ),
    targetProvision: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_phase,
    ),
    targetEval: join(directory, DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME),
    deployment: join(directory, DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME),
  });
}

function provisionPin(value) {
  try {
    assertDisposableRecoveryTeardownProvisionArtifactsCapability(value);
  } catch {
    refuse("DISPOSABLE_TEARDOWN_CLI_PROVISION_ARTIFACT_INVALID");
  }
  const vectorizeCreatedOn = value?.receipt?.final_state?.vectorize_created_on;
  const completedAt = value?.receipt?.completed_at;
  if (!exactUtcRfc3339(vectorizeCreatedOn) ||
      !exactUtcRfc3339(completedAt) ||
      !value?.receipt?.binding || typeof value.receipt.binding !== "object" ||
      Array.isArray(value.receipt.binding) ||
      !value?.manifest || typeof value.manifest !== "object" ||
      Array.isArray(value.manifest)) {
    refuse("DISPOSABLE_TEARDOWN_CLI_PROVISION_ARTIFACT_INVALID");
  }
  if (value.vectorizeCreatedOn !== vectorizeCreatedOn ||
      value.completedAt !== completedAt ||
      value.binding !== value.receipt.binding) {
    refuse("DISPOSABLE_TEARDOWN_CLI_PROVISION_ARTIFACT_INVALID");
  }
  return value;
}

async function prepareTeardownEvidence(parsed, directory, {
  loadPlan,
  inspectPreparation,
  readProvisionArtifacts,
  readA12Capability,
  readReceipt,
  createKeychain,
  platform,
}) {
  const plan = loadPlan(parsed.planPath);
  const paths = artifactPaths(directory, parsed.role);
  const readArtifacts = () => ({
    source: provisionPin(readProvisionArtifacts({
      receiptPath: paths.sourceProvision,
      manifestPath: parsed.sourceManifestPath,
      expectedReceiptDirectory: directory,
      role: "source",
    })),
    target: provisionPin(readProvisionArtifacts({
      receiptPath: paths.targetProvision,
      manifestPath: parsed.targetManifestPath,
      expectedReceiptDirectory: directory,
      role: "target",
    })),
  });
  const artifacts = Object.freeze(readArtifacts());
  if (artifacts.source.accountId !== artifacts.target.accountId) {
    refuse("DISPOSABLE_TEARDOWN_CLI_PROVISION_ARTIFACT_INVALID");
  }
  let keychainBinding;
  try {
    const loaded = readReceipt(
      join(directory, DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME),
      { code: "DISPOSABLE_TEARDOWN_CLI_KEYCHAIN_RECEIPT_INVALID" },
    );
    keychainBinding = loaded?.value?.binding;
  } catch {
    refuse("DISPOSABLE_TEARDOWN_CLI_KEYCHAIN_RECEIPT_INVALID");
  }
  const keychainBindingFields = [
    "candidate_sha", "candidate_tree_sha", "package_sha256",
    "field_receipt_sha256", "account_fingerprint", "preparation_fingerprint",
  ];
  if (!keychainBinding || typeof keychainBinding !== "object" ||
      Array.isArray(keychainBinding) ||
      Object.keys(keychainBinding).sort().join("\0") !==
        keychainBindingFields.sort().join("\0") ||
      keychainBinding.candidate_sha !== parsed.candidateSha ||
      !SHA40_RE.test(String(keychainBinding.candidate_tree_sha || "")) ||
      [keychainBinding.package_sha256, keychainBinding.field_receipt_sha256,
        keychainBinding.account_fingerprint,
        keychainBinding.preparation_fingerprint]
        .some((value) => !SHA256_RE.test(String(value || "")))) {
    refuse("DISPOSABLE_TEARDOWN_CLI_KEYCHAIN_RECEIPT_INVALID");
  }
  let keychainProof;
  try {
    const keychain = createKeychain({ platform });
    const readOnlyKeychain = Object.freeze({
      inspect: keychain?.inspect,
      read: keychain?.read,
    });
    keychainProof = await verifyDisposableRecoveryFieldKeychainPrep({
      binding: {
        candidate_sha: parsed.candidateSha,
        candidate_tree_sha: keychainBinding.candidate_tree_sha,
        package_sha256: keychainBinding.package_sha256,
        field_receipt_sha256: keychainBinding.field_receipt_sha256,
        account_id: artifacts.source.accountId,
      },
      receiptPath: join(
        directory,
        DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
      ),
      expectedReceiptDirectory: directory,
      keychain: readOnlyKeychain,
      platform,
    });
  } catch {
    refuse("DISPOSABLE_TEARDOWN_CLI_KEYCHAIN_RECEIPT_INVALID");
  }
  const base = inspectPreparation({
    candidateSha: parsed.candidateSha,
    fieldReceiptPath: parsed.fieldReceiptPath,
    packagePath: parsed.packagePath,
    wranglerWrapperPath: parsed.wranglerWrapperPath,
    sourceManifestPath: parsed.sourceManifestPath,
    targetManifestPath: parsed.targetManifestPath,
    keychainProof,
    plan,
  });
  if (base.binding?.candidate_tree_sha !== keychainBinding.candidate_tree_sha ||
      base.binding?.package_sha256 !== keychainBinding.package_sha256 ||
      base.binding?.field_receipt_sha256 !== keychainBinding.field_receipt_sha256 ||
      base.binding?.keychain_binding_sha256 !==
        keychainProof.keychain_binding_sha256) {
    refuse("DISPOSABLE_TEARDOWN_CLI_KEYCHAIN_RECEIPT_INVALID");
  }
  let a12Evidence;
  try {
    a12Evidence = readA12Capability({
      targetEvalReceiptPath: paths.targetEval,
      statePath: parsed.statePath,
      goldenPath: parsed.goldenPath,
      deploymentReceiptPath: paths.deployment,
      expectedReceiptDirectory: directory,
      plan,
    });
    assertDisposableRecoveryTeardownA12EvidenceCapability(a12Evidence);
  } catch {
    refuse("DISPOSABLE_TEARDOWN_CLI_TARGET_EVAL_RECEIPT_INVALID");
  }
  const targetEvalReceipt = a12Evidence.target_eval_receipt;
  let targetEvalBinding;
  try {
    targetEvalBinding = assertDisposableRecoveryTargetEvalReceipt(
      targetEvalReceipt.value,
      targetEvalReceipt.value.binding,
    ).binding;
  } catch {
    refuse("DISPOSABLE_TEARDOWN_CLI_TARGET_EVAL_RECEIPT_INVALID");
  }
  if (!exactUtcRfc3339(targetEvalReceipt.value.completed_at) ||
      [artifacts.source, artifacts.target].some((artifact) =>
        Date.parse(artifact.completedAt) >
          Date.parse(targetEvalReceipt.value.completed_at))) {
    refuse("DISPOSABLE_TEARDOWN_CLI_TARGET_EVAL_RECEIPT_INVALID");
  }
  if (targetEvalBinding.candidate_sha !== base.binding?.candidate_sha ||
      targetEvalBinding.candidate_tree_sha !== base.binding?.candidate_tree_sha ||
      targetEvalBinding.package_sha256 !== base.binding?.package_sha256 ||
      targetEvalBinding.field_receipt_sha256 !== base.binding?.field_receipt_sha256 ||
      targetEvalBinding.keychain_binding_sha256 !==
        keychainProof.keychain_binding_sha256 ||
      targetEvalBinding.campaign_fingerprint !== base.binding?.campaign_fingerprint ||
      targetEvalBinding.recovery_plan_fingerprint !==
        base.binding?.plan_fingerprint ||
      targetEvalBinding.source_resource_fingerprint !==
        base.binding?.source_resource_fingerprint ||
      targetEvalBinding.target_resource_fingerprint !==
        base.binding?.target_resource_fingerprint) {
    refuse("DISPOSABLE_TEARDOWN_CLI_TARGET_EVAL_RECEIPT_INVALID");
  }
  if (Date.parse(artifacts.source.completedAt) >
        Date.parse(artifacts.target.completedAt) ||
      Date.parse(artifacts.target.completedAt) >
        Date.parse(a12Evidence.deployment_completed_at)) {
    refuse("DISPOSABLE_TEARDOWN_CLI_DEPLOYMENT_RECEIPT_INVALID");
  }
  if (targetEvalBinding.recovery_state_sha256 !== a12Evidence.state_sha256 ||
      targetEvalBinding.golden_sha256 !== a12Evidence.golden_sha256 ||
      targetEvalBinding.active_worker_version_id !==
        a12Evidence.active_worker_version_id) {
    refuse("DISPOSABLE_TEARDOWN_CLI_TARGET_EVAL_RECEIPT_INVALID");
  }
  const artifactFingerprint = canonical({
    artifacts,
    targetEvalReceipt,
    a12Evidence,
  });
  const revalidate = async () => {
    if (await base.revalidate() !== true || canonical({
      artifacts: readArtifacts(),
      targetEvalReceipt,
      a12Evidence,
    }) !== artifactFingerprint) {
      refuse("DISPOSABLE_TEARDOWN_CLI_EVIDENCE_CHANGED");
    }
    return true;
  };
  const revalidateKeychain = async () => {
    if (await revalidate() !== true || await keychainProof.revalidate() !== true ||
        await revalidate() !== true) {
      refuse("DISPOSABLE_TEARDOWN_CLI_EVIDENCE_CHANGED");
    }
    return true;
  };
  await revalidate();
  await revalidateKeychain();
  return Object.freeze({
    ...base,
    provisionArtifacts: artifacts,
    targetEvalReceipt,
    a12Evidence,
    keychainProof,
    revalidate,
    revalidateKeychain,
  });
}

/** Execute exactly one A13, A14, A15, or A16 ceremony. */
export async function executeDisposableRecoveryFieldTeardown(parsedInput, {
  platform = process.platform,
  assertReceiptDirectory = assertPrivateAggregateReceiptDirectory,
  loadPlan = loadVerifiedRecoveryPlan,
  inspectPreparation = inspectDisposableRecoveryDeploymentPreparation,
  readProvisionArtifacts = readDisposableRecoveryTeardownProvisionArtifacts,
  readA12Capability = readDisposableRecoveryTeardownA12Evidence,
  readSourceTeardownReceipt = readDisposableRecoverySourceTeardownReceipt,
  readReceipt = readPrivateAggregateReceipt,
  createKeychain = createDisposableRecoveryFieldKeychainPrep,
  runPreview = runDisposableRecoveryTeardownPreview,
  runMutation = runDisposableRecoveryTeardownMutation,
} = {}) {
  const parsed = parsedInput?.command
    ? parsedInput
    : parseDisposableRecoveryFieldTeardownArguments(parsedInput);
  if (parsed.command === "help") return Object.freeze({ help: true });
  if (platform !== "darwin") refuse("DISPOSABLE_TEARDOWN_CLI_MACOS_REQUIRED");
  let directory;
  try {
    directory = assertReceiptDirectory(resolve(parsed.receiptDirectory), {
      code: "DISPOSABLE_TEARDOWN_CLI_RECEIPT_DIRECTORY_INVALID",
    }).path;
  } catch {
    refuse("DISPOSABLE_TEARDOWN_CLI_RECEIPT_DIRECTORY_INVALID");
  }
  let preparation;
  try {
    preparation = await prepareTeardownEvidence(parsed, directory, {
      loadPlan,
      inspectPreparation,
      readProvisionArtifacts,
      readA12Capability,
      readReceipt,
      createKeychain,
      platform,
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldTeardownCliError) throw error;
    refuse("DISPOSABLE_TEARDOWN_CLI_PREPARATION_FAILED");
  }
  const paths = artifactPaths(directory, parsed.role);
  const sourceTeardownReceipt = parsed.role === "target"
    ? readSourceTeardownReceipt({
        receiptPath: paths.sourceTeardown,
        expectedReceiptDirectory: directory,
        preparation,
      })
    : null;
  if (!parsed.mutation) {
    const result = await runPreview({
      preparation,
      role: parsed.role,
      receiptPath: paths.preview,
      teardownWrapperPath: parsed.teardownWrapperPath,
      sourceTeardownReceipt,
      maintenanceWindow: parsed.maintenanceWindow,
      resume: parsed.resume,
    });
    const readback = readReceipt(paths.preview, { code: "TEARDOWN_PREVIEW_INVALID" });
    return Object.freeze({
      schema_version: 1,
      kind: parsed.command,
      action: parsed.role === "source" ? "A13" : "A15",
      status: "ready_for_separate_approval",
      cloudflare_access: "read_only",
      cloudflare_mutation: false,
      local_receipt_written: true,
      receipt_sha256: readback.sha256,
      [`${parsed.role === "source" ? "a14" : "a16"}_approval_fingerprint`]:
        result.approvalFingerprint,
    });
  }
  const preview = readReceipt(paths.preview, { code: "TEARDOWN_PREVIEW_INVALID" });
  const result = await runMutation({
    preparation,
    role: parsed.role,
    preview: preview.value,
    previewSha256: preview.sha256,
    approvalFingerprint: parsed.approvalFingerprint,
    teardownWrapperPath: parsed.teardownWrapperPath,
    receiptDirectory: directory,
    receiptPath: paths.receipt,
    absentPreviewPath: paths.absent,
    sourceTeardownReceipt,
    maintenanceWindow: parsed.maintenanceWindow,
    resume: parsed.resume,
  });
  const readback = readReceipt(paths.receipt, { code: "TEARDOWN_RECEIPT_INVALID" });
  return Object.freeze({
    schema_version: 1,
    kind: parsed.command,
    action: parsed.role === "source" ? "A14" : "A16",
    status: "passed",
    cloudflare_mutation: true,
    provider_absence_verified: result.receipt.absence.absent === 3,
    receipt_sha256: readback.sha256,
    resumed: parsed.resume,
  });
}

export function disposableRecoveryFieldTeardownHelp() {
  const common = "--candidate-sha <40-hex> --field-receipt <private-file> " +
    "--package <private-tarball> --plan <private-file> --state <private-file> " +
    "--golden <private-file> " +
    "--receipt-directory <owner-only-dir> --source-manifest <private-file> " +
    "--target-manifest <private-file> --wrangler-wrapper <owner-only-wrapper> " +
    "--teardown-wrapper <owner-only-keychain-wrapper> " +
    "--maintenance-window-confirmed";
  return Object.freeze([
    "Fixed v0.4.8 disposable teardown only. macOS Keychain only; Windows is unsupported.",
    `source-preview ${common} [--resume]`,
    `source-mutate ${common} --approve-a14 <fingerprint> [--resume]`,
    `target-preview ${common} [--resume]`,
    `target-mutate ${common} --approve-a16 <fingerprint> [--resume]`,
    "Source and target are separate ceremonies. Target preview requires the completed source receipt.",
    `Both source and target require the completed A12 receipt at <receipt-directory>/${DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME}.`,
    "Preview uses Cloudflare GETs and writes one private approval receipt; mutation deletes only Worker, Vectorize, then D1.",
    "A sent-unconfirmed DELETE is reconciled and never retried. Do not put credentials or tokens in command arguments.",
    "This entry point is fixture-tested, unapproved, and unfielded. It grants no release authority.",
  ]);
}

function safeFailureCode(error) {
  const value = String(error?.code ?? "");
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(value)
    ? value
    : "DISPOSABLE_TEARDOWN_CLI_FAILED";
}

export async function main(argv = process.argv.slice(2), {
  stdout = (value) => console.log(value),
  stderr = (value) => console.error(value),
  ...dependencies
} = {}) {
  let parsed;
  try { parsed = parseDisposableRecoveryFieldTeardownArguments(argv); }
  catch (error) {
    stderr(`Disposable recovery teardown stopped: ${safeFailureCode(error)}`);
    for (const line of disposableRecoveryFieldTeardownHelp()) stderr(line);
    return 1;
  }
  if (parsed.command === "help") {
    for (const line of disposableRecoveryFieldTeardownHelp()) stdout(line);
    return 0;
  }
  try {
    const result = await executeDisposableRecoveryFieldTeardown(parsed, dependencies);
    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    stderr(`Disposable recovery teardown stopped: ${safeFailureCode(error)}`);
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
    console.error("Disposable recovery teardown stopped: DISPOSABLE_TEARDOWN_CLI_FAILED");
    process.exitCode = 1;
  });
}
