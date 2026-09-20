#!/usr/bin/env node

/**
 * A17 operator entry point for the fixed v0.4.8 disposable field campaign.
 *
 * Preview reads only the exact owner-private provision receipts/manifests,
 * target evaluation, teardown receipts, and non-secret Keychain item status.
 * Execute removes only the four fixed campaign Keychain items and writes the
 * aggregate teardown closure. The exact campaign account is cross-bound to
 * both provision records; its shared Cloudflare token is checked and retained.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  disposableRecoveryFieldCloseoutApprovalFingerprint,
  previewDisposableRecoveryFieldCloseout,
  readDisposableRecoveryFieldCloseoutEvidence,
  runDisposableRecoveryFieldCloseout,
} from "./disposable-recovery-field-closeout.mjs";

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const PATH_OPTIONS = Object.freeze([
  "source-manifest",
  "target-manifest",
  "plan",
  "state",
  "artifact-directory",
  "wrangler-wrapper",
  "golden",
  "field-receipt",
  "package",
]);

export class DisposableRecoveryFieldCloseoutCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldCloseoutCliError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldCloseoutCliError(code);
}

function safeOption(value) {
  const option = String(value ?? "").split("=", 1)[0];
  return /^[a-z0-9-]{1,64}$/u.test(option) ? option : "unknown";
}

export function parseDisposableRecoveryFieldCloseoutArguments(argv = []) {
  if (!Array.isArray(argv)) refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID");
  const [rawCommand, ...tokens] = argv;
  const command = rawCommand === "--help" || rawCommand === "-h"
    ? "help"
    : String(rawCommand ?? "");
  if (!new Set(["help", "preview", "execute"]).has(command)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_COMMAND_INVALID");
  }
  if (command === "help") {
    if (tokens.length !== 0) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID");
    }
    return Object.freeze({ command });
  }
  const allowed = new Set([
    "account-id",
    "receipt-directory",
    ...PATH_OPTIONS,
    ...(command === "execute"
      ? ["approve-a17", "maintenance-window-confirmed", "resume"]
      : []),
  ]);
  const values = {};
  const seen = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    if (!token.startsWith("--") || token === "--" || token.includes("=")) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID");
    }
    const option = safeOption(token.slice(2));
    if (!allowed.has(option) || seen.has(option)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_OPTION_INVALID");
    }
    seen.add(option);
    if (["maintenance-window-confirmed", "resume"].includes(option)) {
      values[option] = true;
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || String(next).startsWith("--") || String(next).length === 0) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID");
    }
    values[option] = String(next);
    index += 1;
  }
  if (!ACCOUNT_ID_RE.test(String(values["account-id"] ?? "").toLowerCase()) ||
      !values["receipt-directory"] ||
      PATH_OPTIONS.some((option) => !values[option]) ||
      command === "execute" &&
        (!SHA256_RE.test(String(values["approve-a17"] ?? "")) ||
         values["maintenance-window-confirmed"] !== true) ||
      command === "preview" && Object.keys(values).length !== PATH_OPTIONS.length + 2) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    command,
    accountId: values["account-id"].toLowerCase(),
    receiptDirectory: values["receipt-directory"],
    sourceManifest: values["source-manifest"],
    targetManifest: values["target-manifest"],
    plan: values.plan,
    state: values.state,
    artifactDirectory: values["artifact-directory"],
    wranglerWrapper: values["wrangler-wrapper"],
    golden: values.golden,
    fieldReceipt: values["field-receipt"],
    package: values.package,
    ...(command === "execute" ? {
      approvalFingerprint: values["approve-a17"],
      resume: values.resume === true,
      maintenanceWindow: Object.freeze({
        single_operator: true,
        other_actors_paused: true,
      }),
    } : {}),
  });
}

export async function executeDisposableRecoveryFieldCloseout(parsedInput) {
  if (arguments.length !== 1) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID");
  }
  const parsed = parsedInput?.command
    ? parsedInput
    : parseDisposableRecoveryFieldCloseoutArguments(parsedInput);
  if (parsed.command === "help") return Object.freeze({ help: true });
  if (process.platform !== "darwin" &&
      process.env.NODE_TEST_CONTEXT !== "child-v8") {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_MACOS_REQUIRED");
  }
  let evidenceCapability;
  try {
    evidenceCapability = await readDisposableRecoveryFieldCloseoutEvidence({
      accountId: parsed.accountId,
      expectedReceiptDirectory: parsed.receiptDirectory,
      sourceManifestPath: parsed.sourceManifest,
      targetManifestPath: parsed.targetManifest,
      planPath: parsed.plan,
      statePath: parsed.state,
      artifactDirectory: parsed.artifactDirectory,
      wranglerWrapperPath: parsed.wranglerWrapper,
      goldenPath: parsed.golden,
      fieldReceiptPath: parsed.fieldReceipt,
      packagePath: parsed.package,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_EVIDENCE_INVALID");
  }
  let approvalFingerprint;
  try {
    approvalFingerprint =
      await disposableRecoveryFieldCloseoutApprovalFingerprint(evidenceCapability);
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_EVIDENCE_INVALID");
  }
  if (parsed.command === "preview") {
    let preview;
    try {
      preview = await previewDisposableRecoveryFieldCloseout({
        evidenceCapability,
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_PREVIEW_FAILED");
    }
    return Object.freeze({
      schema_version: 1,
      kind: "v048_disposable_recovery_field_closeout_preview",
      action: "A17",
      status: "ready_for_separate_approval",
      keychain_access: "read_only",
      keychain_mutation: false,
      provider_access: false,
      provider_mutation: false,
      retained_evidence_deleted: false,
      campaign_items_present: preview.campaign_items.length,
      keychain_preparation: preview.keychain_preparation,
      retained_evidence_inventory_sha256:
        preview.retained_evidence.inventory_sha256,
      shared_test_token_lookup: preview.shared_test_token_lookup,
      a17_approval_fingerprint: approvalFingerprint,
    });
  }
  if (parsed.approvalFingerprint !== approvalFingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_APPROVAL_INVALID");
  }
  let result;
  try {
    result = await runDisposableRecoveryFieldCloseout({
      evidenceCapability,
      approvalFingerprint,
      resume: parsed.resume,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_EXECUTION_FAILED");
  }
  return Object.freeze({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_closeout",
    action: "A17",
    status: result.receipt.status,
    campaign_keychain_items_absent: 4,
    shared_test_token_retained: true,
    provider_mutation: false,
    retained_evidence_deleted: false,
    receipt_sha256: result.receiptSha256,
    terminal_anchor_sha256: result.terminalAnchorSha256,
    resumed: parsed.resume,
  });
}
export function disposableRecoveryFieldCloseoutHelp() {
  const evidenceFlags = "--source-manifest <path> --target-manifest <path> --plan <path> --state <path> --artifact-directory <owner-only-dir> --wrangler-wrapper <path> --golden <path> --field-receipt <path> --package <path>";
  return Object.freeze([
    "Fixed v0.4.8 disposable field closeout only. macOS Keychain only; Windows is unsupported.",
    `preview --account-id <32-hex> --receipt-directory <owner-only-dir> ${evidenceFlags}`,
    `execute --account-id <32-hex> --receipt-directory <owner-only-dir> ${evidenceFlags} --approve-a17 <fingerprint> --maintenance-window-confirmed [--resume]`,
    "Preview reads and cross-binds the exact K0 receipt, source and target provision receipts and manifests, deployment records, target evaluation, ordered teardown records, and retained evidence inventory.",
    "It then checks four campaign items and confirms the exact campaign account's shared test token remains available.",
    "The artifact directory must be owner-only, contain the encrypted provenance artifact, and exclude transient provider runtime directories.",
    "Execute rehashes the exact retained set before each deletion, removes only the four fixed campaign items, and writes the final private closure plus its permanent terminal anchor. It never calls Cloudflare or deletes retained evidence.",
    "Do not put a token, admin key, encrypted provenance artifact key, bank-wrapping key, or other secret in command arguments.",
    "This A17 path is held and uncertified. It has fixture and offline proof only, no field or live proof, and grants no release authority.",
  ]);
}

function safeFailureCode(error) {
  const value = String(error?.code ?? "");
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(value)
    ? value
    : "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_FAILED";
}

export async function main(
  argv = process.argv.slice(2),
  io = {},
) {
  if (!io || typeof io !== "object" || Array.isArray(io) ||
      Object.keys(io).some((key) => !["stdout", "stderr"].includes(key)) ||
      (io.stdout !== undefined && typeof io.stdout !== "function") ||
      (io.stderr !== undefined && typeof io.stderr !== "function")) {
    throw new DisposableRecoveryFieldCloseoutCliError(
      "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID",
    );
  }
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    const parsed = parseDisposableRecoveryFieldCloseoutArguments(argv);
    if (parsed.command === "help") {
      stdout(disposableRecoveryFieldCloseoutHelp().join("\n") + "\n");
      return Object.freeze({ help: true });
    }
    const result = await executeDisposableRecoveryFieldCloseout(parsed);
    stdout(JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    stderr(safeFailureCode(error) + "\n");
    throw error;
  }
}
let directInvocation = false;
try {
  directInvocation = Boolean(process.argv[1]) &&
    realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(resolve(process.argv[1]));
} catch {
  directInvocation = false;
}

if (directInvocation) {
  main().catch(() => { process.exitCode = 1; });
}
