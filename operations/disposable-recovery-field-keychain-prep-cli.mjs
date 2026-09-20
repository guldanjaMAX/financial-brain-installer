#!/usr/bin/env node

/**
 * Operator entry point for K0 of the fixed v0.4.8 disposable recovery proof.
 *
 * Preview verifies the sealed candidate inputs and checks only whether the four
 * fixed campaign Keychain items are absent. Execute requires the exact preview
 * fingerprint and an explicit single-operator confirmation. No provider or
 * network path is reachable from this entry point, and secret values never
 * appear in arguments, environment-derived output, or receipts.
 */

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectDisposableRecoveryProvisioningPreparation,
} from "./cloudflare-recovery-adapter.mjs";
import {
  createDisposableRecoveryFieldKeychainPrep,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  previewDisposableRecoveryFieldKeychainPrep,
  previewDisposableRecoveryFieldKeychainReset,
  runDisposableRecoveryFieldKeychainPrep,
  runDisposableRecoveryFieldKeychainReset,
} from "./disposable-recovery-field-keychain-prep.mjs";
import {
  assertPrivateAggregateReceiptDirectory,
} from "./private-aggregate-receipt.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA40_RE = /^[a-f0-9]{40}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const COMMANDS = new Set([
  "help", "preview", "execute", "reset-preview", "reset-execute",
]);
const COMMON_OPTIONS = Object.freeze([
  "account-id",
  "candidate-sha",
  "field-receipt",
  "package",
  "receipt-directory",
  "wrangler-wrapper",
]);

export class DisposableRecoveryFieldKeychainPrepCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldKeychainPrepCliError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldKeychainPrepCliError(code);
}

function checkedOption(value) {
  const option = String(value ?? "").split("=", 1)[0];
  return /^[a-z0-9-]{1,64}$/u.test(option) ? option : "unknown";
}

/** Strict parser: no positionals, equals syntax, duplicates, or secret flags. */
export function parseDisposableRecoveryFieldKeychainPrepArguments(argv = []) {
  if (!Array.isArray(argv)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_ARGUMENTS_INVALID");
  }
  const [rawCommand, ...tokens] = argv;
  const command = rawCommand === "--help" || rawCommand === "-h"
    ? "help"
    : String(rawCommand ?? "");
  if (!COMMANDS.has(command)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_COMMAND_INVALID");
  }
  if (command === "help") {
    if (tokens.length) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_ARGUMENTS_INVALID");
    }
    return Object.freeze({ command });
  }

  const execute = command === "execute" || command === "reset-execute";
  const required = [
    ...COMMON_OPTIONS,
    ...(command === "execute" ? ["approve-k0", "confirm-single-operator"] : []),
    ...(command === "reset-execute"
      ? ["approve-k0-reset", "confirm-single-operator"]
      : []),
  ];
  const allowed = new Set([
    ...required,
    ...(execute ? ["resume"] : []),
  ]);
  const values = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] ?? "");
    if (!token.startsWith("--") || token === "--" || token.includes("=")) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_ARGUMENTS_INVALID");
    }
    const option = checkedOption(token.slice(2));
    if (!allowed.has(option) || Object.hasOwn(values, option)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_OPTION_INVALID");
    }
    if (["confirm-single-operator", "resume"].includes(option)) {
      values[option] = true;
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || String(next).startsWith("--") || !String(next)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_ARGUMENTS_INVALID");
    }
    values[option] = String(next);
    index += 1;
  }
  if (required.some((option) => !Object.hasOwn(values, option)) ||
      Object.keys(values).some((option) => !allowed.has(option)) ||
      !ACCOUNT_ID_RE.test(String(values["account-id"] ?? "")) ||
      !SHA40_RE.test(String(values["candidate-sha"] ?? "")) ||
      command === "execute" && !SHA256_RE.test(String(values["approve-k0"] ?? "")) ||
      command === "reset-execute" &&
        !SHA256_RE.test(String(values["approve-k0-reset"] ?? "")) ||
      execute && values["confirm-single-operator"] !== true) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    command,
    accountId: values["account-id"],
    candidateSha: values["candidate-sha"],
    fieldReceiptPath: values["field-receipt"],
    packagePath: values.package,
    receiptDirectory: values["receipt-directory"],
    wranglerWrapperPath: values["wrangler-wrapper"],
    ...(execute ? {
      approvalFingerprint: command === "execute"
        ? values["approve-k0"]
        : values["approve-k0-reset"],
      singleOperatorConfirmed: true,
      resume: values.resume === true,
    } : {}),
  });
}

function k0Binding(preparation, accountId) {
  const binding = preparation?.binding;
  return Object.freeze({
    candidate_sha: binding?.candidate_sha,
    candidate_tree_sha: binding?.candidate_tree_sha,
    package_sha256: binding?.package_sha256,
    field_receipt_sha256: binding?.field_receipt_sha256,
    account_id: accountId,
  });
}

/** Run one K0 preview or exact approved local Keychain preparation. */
export async function executeDisposableRecoveryFieldKeychainPrep(parsedInput, {
  platform = process.platform,
  assertReceiptDirectory = assertPrivateAggregateReceiptDirectory,
  inspectPreparation = inspectDisposableRecoveryProvisioningPreparation,
  createKeychain = createDisposableRecoveryFieldKeychainPrep,
  previewPreparation = previewDisposableRecoveryFieldKeychainPrep,
  previewReset = previewDisposableRecoveryFieldKeychainReset,
  runPreparation = runDisposableRecoveryFieldKeychainPrep,
  runReset = runDisposableRecoveryFieldKeychainReset,
} = {}) {
  const parsed = parsedInput?.command
    ? parsedInput
    : parseDisposableRecoveryFieldKeychainPrepArguments(parsedInput);
  if (parsed.command === "help") return Object.freeze({ help: true });
  if (platform !== "darwin") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_MACOS_REQUIRED");
  }

  let directory;
  let preparation;
  let keychain;
  try {
    directory = assertReceiptDirectory(resolve(parsed.receiptDirectory), {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_RECEIPT_DIRECTORY_INVALID",
    }).path;
    preparation = inspectPreparation({
      candidateSha: parsed.candidateSha,
      fieldReceiptPath: parsed.fieldReceiptPath,
      packagePath: parsed.packagePath,
      wranglerWrapperPath: parsed.wranglerWrapperPath,
    });
    keychain = createKeychain({ platform });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldKeychainPrepCliError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_PREPARATION_FAILED");
  }
  const binding = k0Binding(preparation, parsed.accountId);
  const receiptPath = join(
    directory,
    DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  );
  if (parsed.command === "reset-preview") {
    return previewReset({
      binding,
      receiptPath,
      expectedReceiptDirectory: directory,
      keychain,
      platform,
    });
  }
  if (parsed.command === "reset-execute") {
    const result = await runReset({
      binding,
      approvalFingerprint: parsed.approvalFingerprint,
      singleOperatorConfirmed: parsed.singleOperatorConfirmed,
      receiptPath,
      expectedReceiptDirectory: directory,
      keychain,
      resume: parsed.resume,
      platform,
      revalidate: preparation.revalidate,
    });
    return Object.freeze({
      schema_version: 1,
      kind: "v048_disposable_recovery_field_keychain_reset",
      status: result.status,
      receipt_sha256: result.receiptSha256,
      campaign_keychain_items_absent: result.campaignItemsAbsent,
      shared_cloudflare_token_touched: false,
      provider_access: false,
      provider_mutation: false,
      resumed: parsed.resume,
    });
  }
  if (parsed.command === "preview") {
    const preview = await previewPreparation({ binding, keychain, platform });
    return Object.freeze({
      ...preview,
      keychain_access: "fixed_item_presence_only",
      receipt_path: receiptPath,
    });
  }
  if (parsed.command !== "execute") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_COMMAND_INVALID");
  }
  const result = await runPreparation({
    binding,
    approvalFingerprint: parsed.approvalFingerprint,
    singleOperatorConfirmed: parsed.singleOperatorConfirmed,
    receiptPath,
    expectedReceiptDirectory: directory,
    keychain,
    resume: parsed.resume,
    platform,
    revalidate: preparation.revalidate,
  });
  return Object.freeze({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_prep",
    status: result.receipt.status,
    receipt_sha256: result.receiptSha256,
    local_keychain_mutation: true,
    provider_access: false,
    provider_mutation: false,
  });
}

export function disposableRecoveryFieldKeychainPrepHelp() {
  const common = "--account-id <32-hex> --candidate-sha <40-hex> " +
    "--field-receipt <private-file> --package <private-tarball> " +
    "--wrangler-wrapper <owner-only-wrapper> --receipt-directory <owner-only-dir>";
  return Object.freeze([
    "K0 for the fixed v0.4.8 disposable recovery proof. macOS Keychain only.",
    `preview ${common}`,
    `execute ${common} --approve-k0 <preview-fingerprint> --confirm-single-operator [--resume]`,
    `reset-preview ${common}`,
    `reset-execute ${common} --approve-k0-reset <reset-preview-fingerprint> --confirm-single-operator [--resume]`,
    "Preview reads sealed local evidence and fixed-item presence only. It makes no writes or provider requests.",
    "Execute creates four fixed disposable campaign values and a private hash-only receipt.",
    "Reset is a separate exact-approved cleanup for a partial K0 run; it never touches the shared Cloudflare token.",
    "Never put a token, password, admin key, or recovery value in command arguments.",
  ]);
}

function safeFailureCode(error) {
  const value = String(error?.code ?? "");
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(value)
    ? value
    : "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_FAILED";
}

export async function main(argv = process.argv.slice(2), {
  stdout = (value) => console.log(value),
  stderr = (value) => console.error(value),
  ...dependencies
} = {}) {
  let parsed;
  try { parsed = parseDisposableRecoveryFieldKeychainPrepArguments(argv); }
  catch (error) {
    stderr(`Disposable recovery K0 stopped: ${safeFailureCode(error)}`);
    for (const line of disposableRecoveryFieldKeychainPrepHelp()) stderr(line);
    return 1;
  }
  if (parsed.command === "help") {
    for (const line of disposableRecoveryFieldKeychainPrepHelp()) stdout(line);
    return 0;
  }
  try {
    const result = await executeDisposableRecoveryFieldKeychainPrep(parsed, dependencies);
    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    stderr(`Disposable recovery K0 stopped: ${safeFailureCode(error)}`);
    return 1;
  }
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) &&
    realpathSync.native(resolve(process.argv[1])) ===
      realpathSync.native(fileURLToPath(import.meta.url));
} catch { /* missing or replaced invocation paths are never direct runs */ }
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Disposable recovery K0 stopped: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_FAILED");
    process.exitCode = 1;
  });
}
