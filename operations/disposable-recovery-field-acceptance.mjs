/**
 * Strict, local-only final acceptance for the v0.4.8 disposable recovery rung.
 * These readers validate sanitized receipts that are produced only after the
 * real target evaluation and teardown ceremonies. They perform no credential,
 * provider, network, Keychain, or mutation operation.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  assertDisposableRecoveryDeploymentReceiptChain,
  assertDisposableRecoverySourcePhaseReceipt,
  assertDisposableRecoverySourcePreflightReceipt,
  assertDisposableRecoveryTargetPhaseReceipt,
  assertDisposableRecoveryTargetPreflightReceipt,
} from "./disposable-recovery-deployment-receipt.mjs";
import { assertDisposableRecoverySeedReceipt } from "./disposable-recovery-seeder.mjs";
import {
  assertCloudflareDisposableCampaignSemanticAuthority,
  assertCloudflareDisposableCampaignSemanticContinuation,
} from "./cloudflare-disposable-deployment-provider.mjs";
import { readCompletedTestBootstrapProof } from "./cloudflare-recovery-adapter.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PROTOCOL,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PROTOCOL,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL,
  verifyDisposableRecoveryFieldKeychainResetJournal,
} from "./disposable-recovery-field-keychain-prep.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL,
  readDisposableRecoveryFieldCloseoutDeletionJournal,
} from "./disposable-recovery-field-closeout-journal.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
  assertDisposableRecoveryFieldCloseoutTerminalAnchor,
  disposableRecoveryFieldCloseoutFinalizationCommitSha256,
  disposableRecoveryFieldCloseoutTerminalAnchorValue,
  readDisposableRecoveryFieldCloseoutTerminalAnchor,
} from "./disposable-recovery-field-closeout-terminal-anchor.mjs";
import {
  assertNoDarwinReceiptAcl,
  readPrivateAggregateReceipt,
} from "./private-aggregate-receipt.mjs";
import {
  hasRecoveryArtifactResiduePathComponent,
  isRecoveryArtifactResiduePathComponent,
} from "./recovery-artifact-residue-policy.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES,
  readDisposableRecoveryProvisionArtifacts,
} from "./disposable-recovery-field-provision.mjs";
import {
  VERIFIED_RECOVERY_STAGES,
  validateVerifiedRecoveryPlan,
  validateVerifiedRecoveryState,
} from "./verified-recovery.mjs";

let readTestRetainedRecensusTransition = null;
if (process.env.NODE_TEST_CONTEXT === "child-v8") {
  try {
    ({ readNextTestDisposableRecoveryRetainedRecensusTransition:
      readTestRetainedRecensusTransition } = await import(
      "../test/helpers/disposable-recovery-acceptance-runtime.mjs"
    ));
  } catch {
    // Packaged production artifacts deliberately exclude test helpers.
  }
}

export const DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME =
  "v048-disposable-target-eval-receipt.json";
export const DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME =
  "v048-disposable-manual-teardown-closure.json";

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const STORAGE_KINDS = Object.freeze(["d1", "vectorize"]);
const STORAGE_ABSENCE_AUTHORITY =
  "two_stable_exhaustive_account_inventories";
const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PROTOCOL =
  "v048-disposable-recovery-field-closeout-v1";
const WORKER_MISSING_CODE_SHA256 = createHash("sha256")
  .update(JSON.stringify({ codes: [10007] }))
  .digest("hex");
const EMPTY_WORKER_SCHEDULES_SHA256 = createHash("sha256")
  .update(JSON.stringify([]))
  .digest("hex");
const CLOSEOUT_KEYCHAIN_ITEMS = Object.freeze([
  Object.freeze({
    reference: "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
    purpose: "source_admin_key", format: "lowercase_hex_48",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
    purpose: "target_admin_key", format: "lowercase_hex_48",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
    purpose: "recovery_artifact_key", format: "recovery_artifact_v1",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/bank-wrapping-v2",
    purpose: "bank_access_wrapping_key_v2", format: "bank_access_wrapping_v2",
  }),
]);
const REQUIRED_RETAINED_RECEIPT_NAMES = Object.freeze([
  "v048-disposable-field-keychain-prep.json",
  "v048-disposable-source-provision-preflight.json",
  "v048-disposable-source-provision.json",
  "v048-disposable-source.manifest.json",
  "v048-disposable-source-provision-journal.jsonl",
  "v048-disposable-target-provision-preflight.json",
  "v048-disposable-target-provision.json",
  "v048-disposable-target.manifest.json",
  "v048-disposable-target-provision-journal.jsonl",
  "v048-disposable-source-preflight-receipt.json",
  "v048-disposable-source-deployment-receipt.json",
  "v048-disposable-source-deployment-journal.jsonl",
  "v048-disposable-target-preflight-receipt.json",
  "v048-disposable-deployment-receipt.json",
  "v048-disposable-target-deployment-journal.jsonl",
  "v048-disposable-seed-receipt.json",
  "v048-disposable-target-eval-receipt.json",
  "v048-disposable-source-teardown-preview.json",
  "v048-disposable-source-teardown.json",
  "v048-disposable-source-teardown-absent-preview.json",
  "v048-disposable-target-teardown-preview.json",
  "v048-disposable-target-teardown.json",
  "v048-disposable-target-teardown-absent-preview.json",
]);
const RETAINED_RESET_RECEIPT_RE =
  /^v048-disposable-field-keychain-prep-reset-[a-f0-9]{64}\.json$/u;
const RETAINED_RESET_JOURNAL_EVENT_RE = new RegExp(
  `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX}` +
    `([a-f0-9]{64})-([0-9]{2})-` +
    `(planned|sent-unconfirmed|confirmed|reconciled|complete)\\.json$`,
  "u",
);
const RETAINED_EXPLICIT_ROLES = Object.freeze([
  "source_manifest", "target_manifest", "plan", "state",
  "wrangler_wrapper", "golden", "field_receipt", "package",
]);
const MAX_FIXED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EXPLICIT_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 10_000;
const MAX_ARTIFACT_DEPTH = 32;
const ENCRYPTED_PROVENANCE_ARTIFACT =
  ".brain-recovery-export.sql.fbrenc";
const DISPOSABLE_RECOVERY_SEED_RECEIPT_NAME =
  "v048-disposable-seed-receipt.json";
const INTERRUPTION_CANDIDATE_EVIDENCE_KEYS = Object.freeze([
  "candidateSha", "candidateTreeSha", "fieldReceiptRunId",
  "fieldReceiptSha256", "packageFilename", "packageBytes", "packageSha256",
  "packageFileCount", "executionInventorySha256",
  "sourcePreflightReceiptSha256", "sourcePhaseReceiptSha256",
  "deploymentReceiptSha256", "seedReceiptSha256",
  "targetPreflightReceiptSha256", "seedFixtureSha256",
  "seedD1ContentFingerprint", "seedDocumentCount", "seedChunkCount",
  "seedFtsCount", "seedVectorCount", "seedReplayUnchangedDocuments",
  "wranglerRuntimeInventorySha256", "wranglerRuntimeEntrypoint",
  "wranglerRuntimeEntrypointSha256", "wranglerRuntimePackageCount",
  "wranglerRuntimeFileCount", "wranglerRuntimeBytes",
  "wranglerRuntimeDirectory", "wranglerRuntimeSchemaVersion",
  "wranglerHostPlatform", "wranglerHostArch", "wranglerHostLibc",
  "nodeVersion", "nodeExecutableSha256",
]);
const VERIFIED_DEPLOYMENT_EVIDENCE_READS = new WeakMap();
const VERIFIED_INTERRUPTION_EVIDENCE_READS = new WeakMap();
const VERIFIED_TARGET_EVAL_READS = new WeakMap();
const VERIFIED_TEARDOWN_CLOSURE_READS = new WeakMap();

export class DisposableRecoveryFieldAcceptanceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DisposableRecoveryFieldAcceptanceError";
    this.code = code;
  }
}

function refuse(code, message = code) {
  throw new DisposableRecoveryFieldAcceptanceError(code, message);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function privateReceiptSha256(value) {
  return createHash("sha256")
    .update(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"))
    .digest("hex");
}

function sameStableEntry(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertOwner(info) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
}

function assertCleanPhysicalPath(path) {
  if (hasRecoveryArtifactResiduePathComponent(path)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
}

function readPrivateDirectory(path) {
  const absolute = resolve(path);
  let info;
  try {
    assertCleanPhysicalPath(absolute);
    info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        realpathSync(absolute) !== absolute ||
        process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    assertOwner(info);
    info = assertNoDarwinReceiptAcl(absolute, info, {
      code: "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED",
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldAcceptanceError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  return Object.freeze({ path: absolute, info });
}

function hashPrivateFile(path, maxBytes) {
  const absolute = resolve(path);
  let before;
  let descriptor;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    assertCleanPhysicalPath(absolute);
    before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        !Number.isSafeInteger(before.size) || before.size < 1 ||
        before.size > maxBytes || realpathSync(absolute) !== absolute ||
        process.platform !== "win32" && (before.mode & 0o077) !== 0) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    assertOwner(before);
    before = assertNoDarwinReceiptAcl(absolute, before, {
      code: "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED",
    });
    descriptor = openSync(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 ||
        !sameStableEntry(opened, before)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    while (true) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      bytes += count;
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      hash.update(chunk.subarray(0, count));
    }
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(absolute);
    if (bytes !== before.size || !sameStableEntry(openedAfter, before) ||
        !sameStableEntry(after, before) || realpathSync(absolute) !== absolute) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    return Object.freeze({ bytes, sha256: hash.digest("hex") });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldAcceptanceError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  } finally {
    chunk.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* a failed read already refuses */ }
    }
  }
}

function readArtifactInventory(path) {
  const root = readPrivateDirectory(path);
  const directories = [];
  const items = [];
  let totalBytes = 0;
  const visit = (directory, depth) => {
    if (depth > MAX_ARTIFACT_DEPTH) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    const checked = readPrivateDirectory(directory);
    const withinRoot = relative(root.path, checked.path);
    if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    directories.push(checked);
    let entries;
    try {
      entries = readdirSync(checked.path, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." ||
          /[\u0000-\u001f\u007f]/u.test(entry.name) ||
          isRecoveryArtifactResiduePathComponent(entry.name)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      const candidate = join(checked.path, entry.name);
      let info;
      try { info = lstatSync(candidate); } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      if (info.isSymbolicLink()) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      if (info.isDirectory()) {
        visit(candidate, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      const relativeName = relative(root.path, candidate).split(sep).join("/");
      if (!safeRelativeName(relativeName)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      const hashed = hashPrivateFile(candidate, MAX_ARTIFACT_FILE_BYTES);
      totalBytes += hashed.bytes;
      if (items.length >= MAX_ARTIFACT_FILES ||
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      items.push(Object.freeze({ relative_name: relativeName, ...hashed }));
    }
  };
  visit(root.path, 0);
  items.sort((left, right) =>
    left.relative_name.localeCompare(right.relative_name));
  for (const prior of directories) {
    const current = readPrivateDirectory(prior.path);
    if (!sameStableEntry(current.info, prior.info)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
  }
  if (!items.some((item) =>
    item.relative_name === ENCRYPTED_PROVENANCE_ARTIFACT)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  return Object.freeze({
    path_sha256: createHash("sha256").update(root.path).digest("hex"),
    items,
    encrypted_provenance_artifact_present: true,
  });
}

function exactBinding(value, expected) {
  const keys = [
    "candidate_sha", "candidate_tree_sha", "package_sha256", "field_receipt_sha256",
    "campaign_fingerprint", "keychain_binding_sha256", "recovery_plan_fingerprint",
    "recovery_state_sha256",
    "golden_sha256", "source_resource_fingerprint", "target_resource_fingerprint", "active_worker_version_id",
  ];
  if (!exactKeys(value, keys) || !exactKeys(expected, keys) ||
      !COMMIT_RE.test(String(value.candidate_sha || "")) ||
      !COMMIT_RE.test(String(value.candidate_tree_sha || "")) ||
      keys.slice(2, 11).some((key) => !SHA256_RE.test(String(value[key] || ""))) ||
      typeof value.active_worker_version_id !== "string" || !value.active_worker_version_id ||
      JSON.stringify(canonical(value)) !== JSON.stringify(canonical(expected))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_BINDING_INVALID");
  }
  return Object.freeze(structuredClone(value));
}

function exactIso(value) {
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function safeRelativeName(value, { basenameOnly = false } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 ||
      value.startsWith("/") || value.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/u.test(value) || value.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const parts = value.split("/");
  return (!basenameOnly || parts.length === 1) &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function assertCloseoutKeychainPreparation(value, binding) {
  const fields = [
    "schema_version", "protocol", "receipt_sha256", "preparation_fingerprint",
    "account_fingerprint", "campaign_keychain_locator_sha256",
    "campaign_keychain_value_sha256", "campaign_items", "keychain_binding_sha256",
  ];
  if (!exactKeys(value, fields) || value.schema_version !== 1 ||
      value.protocol !== DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL ||
      [value.receipt_sha256, value.preparation_fingerprint, value.account_fingerprint,
        value.keychain_binding_sha256].some((entry) =>
        !SHA256_RE.test(String(entry || ""))) ||
      !Array.isArray(value.campaign_keychain_locator_sha256) ||
      !Array.isArray(value.campaign_keychain_value_sha256) ||
      !Array.isArray(value.campaign_items) ||
      value.campaign_keychain_locator_sha256.length !== CLOSEOUT_KEYCHAIN_ITEMS.length ||
      value.campaign_keychain_value_sha256.length !== CLOSEOUT_KEYCHAIN_ITEMS.length ||
      value.campaign_items.length !== CLOSEOUT_KEYCHAIN_ITEMS.length ||
      new Set(value.campaign_keychain_locator_sha256).size !== CLOSEOUT_KEYCHAIN_ITEMS.length ||
      new Set(value.campaign_keychain_value_sha256).size !== CLOSEOUT_KEYCHAIN_ITEMS.length) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  for (let index = 0; index < CLOSEOUT_KEYCHAIN_ITEMS.length; index += 1) {
    const item = value.campaign_items[index];
    const expected = CLOSEOUT_KEYCHAIN_ITEMS[index];
    const expectedLocatorSha256 = createHash("sha256")
      .update(expected.reference)
      .digest("hex");
    if (!exactKeys(item, ["purpose", "format", "locator_sha256", "value_sha256"]) ||
        item.purpose !== expected.purpose || item.format !== expected.format ||
        item.locator_sha256 !== expectedLocatorSha256 ||
        item.locator_sha256 !== value.campaign_keychain_locator_sha256[index] ||
        item.value_sha256 !== value.campaign_keychain_value_sha256[index] ||
        !SHA256_RE.test(String(item.locator_sha256 || "")) ||
        !SHA256_RE.test(String(item.value_sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
  }
  const expectedPreparationFingerprint = sha256Canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PROTOCOL,
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    account_fingerprint: value.account_fingerprint,
    campaign_keychain_locator_sha256: value.campaign_keychain_locator_sha256,
  });
  const keychainBindingBase = Object.fromEntries(
    fields.slice(0, -1).map((field) => [field, value[field]]),
  );
  if (value.preparation_fingerprint !== expectedPreparationFingerprint ||
      value.keychain_binding_sha256 !== sha256Canonical(keychainBindingBase)) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  return value;
}

function assertCloseoutRetainedEvidence(value, evidence, binding) {
  if (!exactKeys(value, ["inventory", "inventory_sha256"]) ||
      !exactKeys(value.inventory, [
        "schema_version", "kind", "receipt_directory", "explicit_files",
        "artifact_directory",
      ]) || value.inventory.schema_version !== 1 ||
      value.inventory.kind !== "v048_disposable_retained_evidence_inventory" ||
      !SHA256_RE.test(String(value.inventory_sha256 || "")) ||
      value.inventory_sha256 !== sha256Canonical(value.inventory)) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  const receiptDirectory = value.inventory.receipt_directory;
  if (!exactKeys(receiptDirectory, [
    "path_sha256", "items", "k0_reset_receipts", "k0_reset_journals",
  ]) ||
      !SHA256_RE.test(String(receiptDirectory.path_sha256 || "")) ||
      !Array.isArray(receiptDirectory.items) ||
      receiptDirectory.items.length !== REQUIRED_RETAINED_RECEIPT_NAMES.length ||
      !Array.isArray(receiptDirectory.k0_reset_receipts) ||
      receiptDirectory.k0_reset_receipts.length > 256 ||
      !Array.isArray(receiptDirectory.k0_reset_journals) ||
      receiptDirectory.k0_reset_journals.length !==
        receiptDirectory.k0_reset_receipts.length) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  const seen = new Map();
  let receiptBytes = 0;
  for (let index = 0; index < REQUIRED_RETAINED_RECEIPT_NAMES.length; index += 1) {
    const item = receiptDirectory.items[index];
    if (!exactKeys(item, ["name", "bytes", "sha256"]) ||
        item.name !== REQUIRED_RETAINED_RECEIPT_NAMES[index] ||
        seen.has(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        item.bytes > 64 * 1024 * 1024 || !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
    seen.set(item.name, item.sha256);
    receiptBytes += item.bytes;
    if (!Number.isSafeInteger(receiptBytes) || receiptBytes > 512 * 1024 * 1024) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
  }
  let priorResetName = null;
  for (const item of receiptDirectory.k0_reset_receipts) {
    if (!exactKeys(item, ["name", "bytes", "sha256"]) ||
        !RETAINED_RESET_RECEIPT_RE.test(String(item.name || "")) ||
        (priorResetName !== null && item.name.localeCompare(priorResetName) <= 0) ||
        seen.has(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        item.bytes > 64 * 1024 * 1024 || !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
    priorResetName = item.name;
    seen.set(item.name, item.sha256);
    receiptBytes += item.bytes;
    if (!Number.isSafeInteger(receiptBytes) || receiptBytes > 512 * 1024 * 1024) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
  }
  const journalNames = new Set();
  for (let resetIndex = 0;
    resetIndex < receiptDirectory.k0_reset_journals.length;
    resetIndex += 1) {
    const group = receiptDirectory.k0_reset_journals[resetIndex];
    const resetReceipt = receiptDirectory.k0_reset_receipts[resetIndex];
    const verification = group?.verification;
    if (!exactKeys(group, [
      "reset_receipt_name", "verification", "event_receipts",
    ]) || group.reset_receipt_name !== resetReceipt.name ||
        !exactKeys(verification, [
          "schema_version", "protocol", "status",
          "reset_authorization_receipt_sha256", "reservation_marker_sha256",
          "event_count", "total_bytes", "final_event_sha256",
          "event_receipt_sha256", "provider_access", "provider_mutation",
          "shared_cloudflare_token_touched",
        ]) || verification.schema_version !== 1 ||
        verification.protocol !==
          DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PROTOCOL ||
        verification.status !== "complete" ||
        verification.reset_authorization_receipt_sha256 !== resetReceipt.sha256 ||
        group.reset_receipt_name !==
          `v048-disposable-field-keychain-prep-reset-` +
            `${verification.reservation_marker_sha256}.json` ||
        !SHA256_RE.test(String(verification.reservation_marker_sha256 || "")) ||
        !Number.isSafeInteger(verification.event_count) ||
        verification.event_count < 1 ||
        verification.event_count >
          DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS ||
        !Number.isSafeInteger(verification.total_bytes) ||
        verification.total_bytes < 1 ||
        verification.total_bytes >
          DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES ||
        !SHA256_RE.test(String(verification.final_event_sha256 || "")) ||
        !Array.isArray(verification.event_receipt_sha256) ||
        verification.event_receipt_sha256.length !== verification.event_count ||
        verification.event_receipt_sha256.some((hash) =>
          !SHA256_RE.test(String(hash || ""))) ||
        new Set(verification.event_receipt_sha256).size !==
          verification.event_receipt_sha256.length ||
        verification.provider_access !== false ||
        verification.provider_mutation !== false ||
        verification.shared_cloudflare_token_touched !== false ||
        !Array.isArray(group.event_receipts) ||
        group.event_receipts.length !== verification.event_count) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
    let journalBytes = 0;
    for (let eventIndex = 0; eventIndex < group.event_receipts.length;
      eventIndex += 1) {
      const event = group.event_receipts[eventIndex];
      const match = RETAINED_RESET_JOURNAL_EVENT_RE.exec(String(event?.name || ""));
      if (!exactKeys(event, ["name", "bytes", "sha256"]) || !match ||
          match[1] !== verification.reservation_marker_sha256 ||
          Number.parseInt(match[2], 10) !== eventIndex ||
          seen.has(event.name) || journalNames.has(event.name) ||
          !Number.isSafeInteger(event.bytes) || event.bytes < 1 ||
          event.bytes >
            DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES ||
          event.sha256 !== verification.event_receipt_sha256[eventIndex]) {
        refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
      }
      journalNames.add(event.name);
      journalBytes += event.bytes;
      receiptBytes += event.bytes;
      if (!Number.isSafeInteger(journalBytes) ||
          !Number.isSafeInteger(receiptBytes) ||
          receiptBytes > 512 * 1024 * 1024) {
        refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
      }
    }
    if (journalBytes !== verification.total_bytes ||
        group.event_receipts.at(-1)?.sha256 !== verification.final_event_sha256) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
  }
  if (seen.get("v048-disposable-field-keychain-prep.json") !==
        evidence.keychain_preparation.receipt_sha256 ||
      seen.get("v048-disposable-target-eval-receipt.json") !==
        evidence.target_eval_receipt_sha256 ||
      seen.get("v048-disposable-source-teardown.json") !==
        evidence.source_teardown_receipt_sha256 ||
      seen.get("v048-disposable-target-teardown.json") !==
        evidence.target_teardown_receipt_sha256) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  const explicitFiles = value.inventory.explicit_files;
  if (!Array.isArray(explicitFiles) || explicitFiles.length !== RETAINED_EXPLICIT_ROLES.length) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  const pathHashes = new Set();
  const explicitHashes = new Map();
  for (let index = 0; index < RETAINED_EXPLICIT_ROLES.length; index += 1) {
    const item = explicitFiles[index];
    if (!exactKeys(item, ["role", "name", "path_sha256", "bytes", "sha256"]) ||
        item.role !== RETAINED_EXPLICIT_ROLES[index] ||
        !safeRelativeName(item.name, { basenameOnly: true }) ||
        !SHA256_RE.test(String(item.path_sha256 || "")) ||
        pathHashes.has(item.path_sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        item.bytes > 16 * 1024 * 1024 * 1024 ||
        !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
    pathHashes.add(item.path_sha256);
    explicitHashes.set(item.role, item.sha256);
  }
  if (explicitHashes.get("state") !== binding.recovery_state_sha256 ||
      explicitHashes.get("golden") !== binding.golden_sha256 ||
      explicitHashes.get("field_receipt") !== binding.field_receipt_sha256 ||
      explicitHashes.get("package") !== binding.package_sha256) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  const artifactDirectory = value.inventory.artifact_directory;
  if (!exactKeys(artifactDirectory, [
    "path_sha256", "items", "encrypted_provenance_artifact_present",
  ]) || !SHA256_RE.test(String(artifactDirectory.path_sha256 || "")) ||
      artifactDirectory.encrypted_provenance_artifact_present !== true ||
      !Array.isArray(artifactDirectory.items) || artifactDirectory.items.length < 1 ||
      artifactDirectory.items.length > 10_000) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  let priorName = null;
  let encryptedArtifactSeen = false;
  let artifactBytes = 0;
  for (const item of artifactDirectory.items) {
    if (!exactKeys(item, ["relative_name", "bytes", "sha256"]) ||
        !safeRelativeName(item.relative_name) ||
        (priorName !== null && item.relative_name.localeCompare(priorName) <= 0) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
    priorName = item.relative_name;
    artifactBytes += item.bytes;
    if (!Number.isSafeInteger(artifactBytes) || artifactBytes > 64 * 1024 ** 3) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
    if (item.relative_name === ".brain-recovery-export.sql.fbrenc") {
      encryptedArtifactSeen = true;
    }
  }
  if (!encryptedArtifactSeen) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  return value;
}

function assertPhysicalRetainedEvidence(options, retainedEvidence) {
  const expectedKeys = [
    "receiptPath", "binding", "sourceManifestPath", "targetManifestPath",
    "planPath", "statePath", "artifactDirectory", "wranglerWrapperPath",
    "goldenPath", "fieldReceiptPath", "packagePath",
  ];
  if (!exactKeys(options, expectedKeys)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  const receiptPath = resolve(options.receiptPath);
  const receiptDirectory = dirname(receiptPath);
  if (basename(receiptPath) !== DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const inventory = retainedEvidence.inventory;
  const checkedReceiptDirectory = readPrivateDirectory(receiptDirectory);
  if (inventory.receipt_directory.path_sha256 !== createHash("sha256")
    .update(checkedReceiptDirectory.path).digest("hex")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const resetItems = inventory.receipt_directory.k0_reset_receipts;
  const journalItems = inventory.receipt_directory.k0_reset_journals
    .flatMap((group) => group.event_receipts);
  const allReceiptItems = Object.freeze([
    ...inventory.receipt_directory.items.map((item) => Object.freeze({
      item,
      maxBytes: MAX_FIXED_FILE_BYTES,
    })),
    ...resetItems.map((item) => Object.freeze({
      item,
      maxBytes: MAX_FIXED_FILE_BYTES,
    })),
    ...journalItems.map((item) => Object.freeze({
      item,
      maxBytes:
        DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
    })),
  ]);
  const expectedNames = [
    ...REQUIRED_RETAINED_RECEIPT_NAMES,
    ...resetItems.map((item) => item.name),
    ...journalItems.map((item) => item.name),
    DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
    DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
    DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
  ].sort((left, right) => left.localeCompare(right));
  let entries;
  try {
    entries = readdirSync(receiptDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() ||
      isRecoveryArtifactResiduePathComponent(entry.name)) ||
      JSON.stringify(entries.map((entry) => entry.name)) !==
        JSON.stringify(expectedNames)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const matches = (path, item, maxBytes) => {
    const loaded = hashPrivateFile(path, maxBytes);
    if (loaded.bytes !== item.bytes || loaded.sha256 !== item.sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    return loaded;
  };
  for (const { item, maxBytes } of allReceiptItems) {
    matches(join(receiptDirectory, item.name), item, maxBytes);
  }
  const explicitPaths = Object.freeze({
    source_manifest: options.sourceManifestPath,
    target_manifest: options.targetManifestPath,
    plan: options.planPath,
    state: options.statePath,
    wrangler_wrapper: options.wranglerWrapperPath,
    golden: options.goldenPath,
    field_receipt: options.fieldReceiptPath,
    package: options.packagePath,
  });
  for (const item of inventory.explicit_files) {
    const path = resolve(explicitPaths[item.role]);
    if (basename(path) !== item.name ||
        createHash("sha256").update(path).digest("hex") !== item.path_sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    matches(path, item, MAX_EXPLICIT_FILE_BYTES);
  }
  const artifact = readArtifactInventory(options.artifactDirectory);
  if (JSON.stringify(canonical(artifact)) !==
      JSON.stringify(canonical(inventory.artifact_directory))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  try {
    const transition = readTestRetainedRecensusTransition?.();
    transition?.({ stage: "before_final_retained_evidence_recensus" });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const finalReceiptDirectory = readPrivateDirectory(receiptDirectory);
  let finalEntries;
  try {
    finalEntries = readdirSync(receiptDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  if (!sameStableEntry(
    finalReceiptDirectory.info,
    checkedReceiptDirectory.info,
  ) || JSON.stringify(finalEntries.map((entry) => entry.name)) !==
      JSON.stringify(expectedNames)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  for (const { item, maxBytes } of allReceiptItems) {
    matches(join(receiptDirectory, item.name), item, maxBytes);
  }
  for (const item of inventory.explicit_files) {
    matches(
      resolve(explicitPaths[item.role]),
      item,
      MAX_EXPLICIT_FILE_BYTES,
    );
  }
  if (JSON.stringify(canonical(readArtifactInventory(options.artifactDirectory))) !==
      JSON.stringify(canonical(artifact))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  return true;
}

function assertCloseoutDeletionJournalSummary(value) {
  if (!exactKeys(value, [
    "schema_version", "protocol", "path_sha256", "event_count",
    "head_sha256", "journal_sha256", "terminal_state",
  ]) || value.schema_version !== 1 ||
      value.protocol !==
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL ||
      !SHA256_RE.test(String(value.path_sha256 || "")) ||
      value.event_count !== CLOSEOUT_KEYCHAIN_ITEMS.length * 3 ||
      !SHA256_RE.test(String(value.head_sha256 || "")) ||
      !SHA256_RE.test(String(value.journal_sha256 || "")) ||
      value.terminal_state !== "all_campaign_items_confirmed_absent") {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  return value;
}

function assertStorageAbsenceProof(value) {
  if (!exactKeys(value, STORAGE_KINDS)) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  for (const kind of STORAGE_KINDS) {
    const passes = value[kind];
    if (!Array.isArray(passes) || passes.length !== 2 ||
        JSON.stringify(canonical(passes[0])) !==
          JSON.stringify(canonical(passes[1]))) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
    for (const pass of passes) {
      if (!exactKeys(pass, [
        "resource_kind", "pagination_complete", "entries_inspected",
        "matching_resources", "inventory_sha256",
      ]) || pass.resource_kind !== kind || pass.pagination_complete !== true ||
          !Number.isSafeInteger(pass.entries_inspected) ||
          pass.entries_inspected < 0 || pass.matching_resources !== 0 ||
          !SHA256_RE.test(String(pass.inventory_sha256 || ""))) {
        refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
      }
    }
  }
  return true;
}

function assertWorkerSchedulePasses(value) {
  if (!exactKeys(value, ["present", "absent"])) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  for (const state of ["present", "absent"]) {
    const pass = value[state];
    if (!exactKeys(pass, [
      "count", "exact_endpoint_status", "missing_code_sha256",
      "schedules_sha256",
    ]) || pass.count !== 0 ||
        pass.exact_endpoint_status !== (state === "present" ? 200 : 404) ||
        pass.missing_code_sha256 !== (state === "present"
          ? null
          : WORKER_MISSING_CODE_SHA256) ||
        pass.schedules_sha256 !== EMPTY_WORKER_SCHEDULES_SHA256) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
  }
  return true;
}

export function assertDisposableRecoveryTargetEvalReceipt(value, binding) {
  if (!exactKeys(value, [
    "schema_version", "kind", "status", "completed_at", "binding",
    "target", "projection", "checks", "campaign_protection",
  ]) ||
      value.schema_version !== 1 || value.kind !== "v048_disposable_target_eval" ||
      value.status !== "passed" || !exactIso(value.completed_at)) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_INVALID");
  }
  exactBinding(value.binding, binding);
  if (!exactKeys(value.target, ["resource_fingerprint", "worker_version_id", "mode"]) ||
      value.target.resource_fingerprint !== binding.target_resource_fingerprint ||
      value.target.worker_version_id !== binding.active_worker_version_id ||
      value.target.mode !== "active" ||
      !exactKeys(value.projection, ["documents", "d1_chunks", "fts_rows", "vectorize_vectors", "pending_outbox", "failed_vectors"]) ||
      !Number.isSafeInteger(value.projection.documents) || value.projection.documents !== 6_001 ||
      !Number.isSafeInteger(value.projection.d1_chunks) || value.projection.d1_chunks < 6_001 ||
      value.projection.fts_rows !== value.projection.d1_chunks ||
      value.projection.vectorize_vectors !== value.projection.d1_chunks ||
      value.projection.pending_outbox !== 0 || value.projection.failed_vectors !== 0 ||
      !exactKeys(value.checks, [
        "health", "eval_profile", "eval_status", "critical_failures",
        "unauthorized_retrievals", "supported_marker_case", "unsupported_case",
      ]) || !exactKeys(value.checks.health, [
        "status", "version", "accepting_documents", "before_snapshot_sha256",
        "after_snapshot_sha256", "active_version_unchanged", "projection_unchanged",
      ]) || value.checks.health.status !== "pass" || value.checks.health.version !== "0.4.9" ||
      value.checks.health.accepting_documents !== true ||
      !SHA256_RE.test(String(value.checks.health.before_snapshot_sha256 || "")) ||
      value.checks.health.after_snapshot_sha256 !== value.checks.health.before_snapshot_sha256 ||
      value.checks.health.active_version_unchanged !== true ||
      value.checks.health.projection_unchanged !== true ||
      value.checks.eval_profile !== "release" ||
      value.checks.eval_status !== "pass" || value.checks.critical_failures !== 0 ||
      value.checks.unauthorized_retrievals !== 0 ||
      !exactKeys(value.checks.supported_marker_case, ["direct_target_check", "cited", "citation_count"]) ||
      value.checks.supported_marker_case.direct_target_check !== true ||
      value.checks.supported_marker_case.cited !== true ||
      !Number.isSafeInteger(value.checks.supported_marker_case.citation_count) ||
      value.checks.supported_marker_case.citation_count < 1 ||
      !exactKeys(value.checks.unsupported_case, ["direct_target_check", "refused"]) ||
      value.checks.unsupported_case.direct_target_check !== true ||
      value.checks.unsupported_case.refused !== true) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_INVALID");
  }
  if (!exactKeys(value.campaign_protection, [
    "a4_authority", "evaluated_authority",
  ])) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_INVALID");
  }
  let a4Authority;
  let evaluatedAuthority;
  try {
    a4Authority = assertCloudflareDisposableCampaignSemanticAuthority(
      value.campaign_protection.a4_authority,
    );
    evaluatedAuthority = assertCloudflareDisposableCampaignSemanticAuthority(
      value.campaign_protection.evaluated_authority,
    );
    assertCloudflareDisposableCampaignSemanticContinuation(
      a4Authority,
      evaluatedAuthority,
      "active",
    );
  } catch {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_INVALID");
  }
  if (a4Authority.target_mode !== "paused" ||
      evaluatedAuthority.target_mode !== "active") {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_INVALID");
  }
  return Object.freeze(structuredClone(value));
}

function assertBrainTeardown(value, expectedResourceFingerprint) {
  if (!exactKeys(value, ["resource_fingerprint", "started_at", "completed_at", "present_preview_sha256", "custody", "actions", "absent_preview_sha256", "absence"]) ||
      value.resource_fingerprint !== expectedResourceFingerprint ||
      !exactIso(value.started_at) || !exactIso(value.completed_at) ||
      Date.parse(value.completed_at) < Date.parse(value.started_at) ||
      !SHA256_RE.test(String(value.present_preview_sha256 || "")) ||
      !SHA256_RE.test(String(value.absent_preview_sha256 || "")) ||
      value.present_preview_sha256 === value.absent_preview_sha256 ||
      !exactKeys(value.custody, [
        "pagination_complete", "incoming_references", "routes",
        "custom_domains", "worker_schedule_passes",
        "storage_inventory_passes", "resources",
      ]) ||
      value.custody.pagination_complete !== true ||
      !exactKeys(value.custody.incoming_references, ["version_references", "service_bindings", "tail_consumers"]) ||
      value.custody.incoming_references.version_references !== 0 ||
      value.custody.incoming_references.service_bindings !== 0 ||
      value.custody.incoming_references.tail_consumers !== 0 ||
      value.custody.routes !== 0 || value.custody.custom_domains !== 0 ||
      !assertWorkerSchedulePasses(value.custody.worker_schedule_passes) ||
      !assertStorageAbsenceProof(value.custody.storage_inventory_passes) ||
      !Array.isArray(value.custody.resources) || value.custody.resources.length !== 3 ||
      !Array.isArray(value.actions) || value.actions.length !== 3 ||
      !exactKeys(value.absence, ["present", "absent"]) ||
      value.absence.present !== 0 || value.absence.absent !== 3) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  const kinds = ["worker", "vectorize", "d1"];
  for (let index = 0; index < kinds.length; index++) {
    const resource = value.custody.resources[index];
    const action = value.actions[index];
    if (!exactKeys(resource, ["kind", "instance_fingerprint"]) ||
        resource.kind !== kinds[index] || !SHA256_RE.test(String(resource.instance_fingerprint || "")) ||
        !exactKeys(action, [
          "kind", "instance_fingerprint", "request_sha256", "transitions",
          "exact_endpoint_status", "missing_code_sha256", "absence_authority",
        ]) ||
        action.kind !== kinds[index] || action.instance_fingerprint !== resource.instance_fingerprint ||
        !SHA256_RE.test(String(action.request_sha256 || "")) ||
        !Array.isArray(action.transitions) || action.transitions.length !== 3 ||
        action.transitions[0] !== "planned" || action.transitions[1] !== "sent_unconfirmed" ||
        !["confirmed", "reconciled"].includes(action.transitions[2]) ||
        action.exact_endpoint_status !== 404 ||
        !SHA256_RE.test(String(action.missing_code_sha256 || "")) ||
        kinds[index] === "worker" &&
          action.missing_code_sha256 !== WORKER_MISSING_CODE_SHA256 ||
        action.absence_authority !== (kinds[index] === "worker"
          ? "exact_id_404_code_10007"
          : STORAGE_ABSENCE_AUTHORITY)) {
      refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
    }
  }
  return value;
}

export function assertDisposableRecoveryManualTeardownClosure(value, binding) {
  if (!exactKeys(value, ["schema_version", "kind", "status", "completed_at", "binding", "evidence", "maintenance_window", "ceremony_order", "source", "target", "ambiguity", "keychain"]) ||
      value.schema_version !== 1 || value.kind !== "v048_disposable_manual_teardown_closure" ||
      value.status !== "closed" || !exactIso(value.completed_at)) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  exactBinding(value.binding, binding);
  if (!exactKeys(value.evidence, [
    "target_eval_receipt_sha256", "source_teardown_receipt_sha256",
    "target_teardown_receipt_sha256", "keychain_preparation",
    "retained_evidence", "a17_approval_fingerprint",
  ]) || [
    value.evidence.target_eval_receipt_sha256,
    value.evidence.source_teardown_receipt_sha256,
    value.evidence.target_teardown_receipt_sha256,
    value.evidence.a17_approval_fingerprint,
  ].some((hash) => !SHA256_RE.test(String(hash || ""))) ||
      !exactKeys(value.maintenance_window, ["single_operator", "other_actors_paused"]) ||
      value.maintenance_window.single_operator !== true ||
      value.maintenance_window.other_actors_paused !== true ||
      !Array.isArray(value.ceremony_order) ||
      JSON.stringify(value.ceremony_order) !== JSON.stringify(["source", "target"])) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  const keychainPreparation = assertCloseoutKeychainPreparation(
    value.evidence.keychain_preparation,
    binding,
  );
  if (keychainPreparation.keychain_binding_sha256 !==
      binding.keychain_binding_sha256) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  assertCloseoutRetainedEvidence(value.evidence.retained_evidence, value.evidence, binding);
  const expectedA17Approval = sha256Canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PROTOCOL,
    action: "A17",
    binding,
    target_eval_receipt_sha256: value.evidence.target_eval_receipt_sha256,
    source_teardown_receipt_sha256: value.evidence.source_teardown_receipt_sha256,
    target_teardown_receipt_sha256: value.evidence.target_teardown_receipt_sha256,
    keychain_preparation: value.evidence.keychain_preparation,
    retained_evidence: value.evidence.retained_evidence,
    campaign_keychain_locator_sha256:
      value.evidence.keychain_preparation.campaign_keychain_locator_sha256,
  });
  if (value.evidence.a17_approval_fingerprint !== expectedA17Approval) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  assertBrainTeardown(value.source, binding.source_resource_fingerprint);
  assertBrainTeardown(value.target, binding.target_resource_fingerprint);
  const instanceFingerprints = [value.source, value.target].flatMap((brain) =>
    brain.custody.resources.map((resource) => resource.instance_fingerprint));
  if (Date.parse(value.source.completed_at) > Date.parse(value.target.started_at) ||
      Date.parse(value.completed_at) < Date.parse(value.target.completed_at) ||
      !exactKeys(value.ambiguity, ["unresolved_outcomes"]) || value.ambiguity.unresolved_outcomes !== 0 ||
      !exactKeys(value.keychain, [
        "campaign_items", "shared_test_token_lookup", "deletion_journal",
      ]) ||
      !Array.isArray(value.keychain.campaign_items) || value.keychain.campaign_items.length !== 4 ||
      !exactKeys(value.keychain.shared_test_token_lookup, ["lookup", "value_printed"]) ||
      value.keychain.shared_test_token_lookup.lookup !== "succeeded" ||
      value.keychain.shared_test_token_lookup.value_printed !== false ||
      !assertCloseoutDeletionJournalSummary(value.keychain.deletion_journal) ||
      value.keychain.campaign_items.some((entry, index) =>
        !exactKeys(entry, ["locator_sha256", "lookup"]) ||
        !SHA256_RE.test(String(entry.locator_sha256 || "")) ||
        entry.locator_sha256 !==
          value.evidence.keychain_preparation.campaign_keychain_locator_sha256[index] ||
        entry.lookup !== "item_not_found") ||
      new Set(value.keychain.campaign_items.map((entry) => entry.locator_sha256)).size !== 4 ||
      new Set(instanceFingerprints).size !== 6) {
    refuse("DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID");
  }
  return Object.freeze(structuredClone(value));
}

function assertFieldEvidenceBinding({
  chain,
  seed,
  plan,
  state,
  binding,
  interruptionProof,
  teardown,
}) {
  const deployment = chain?.target_phase?.value;
  const deploymentBinding = deployment?.binding;
  const sourcePhase = chain?.source_phase?.value;
  const seedBinding = seed?.binding;
  const field = state?.field_proof;
  const candidate = interruptionProof?.candidate_evidence;
  const pairs = [
    [binding?.candidate_sha, deploymentBinding?.candidate_sha],
    [binding?.candidate_tree_sha, deploymentBinding?.candidate_tree_sha],
    [binding?.package_sha256, deploymentBinding?.package_sha256],
    [binding?.field_receipt_sha256, deploymentBinding?.field_receipt_sha256],
    [binding?.campaign_fingerprint, deploymentBinding?.campaign_fingerprint],
    [binding?.keychain_binding_sha256, deploymentBinding?.keychain_binding_sha256],
    [teardown?.evidence?.keychain_preparation?.keychain_binding_sha256,
      deploymentBinding?.keychain_binding_sha256],
    [binding?.recovery_plan_fingerprint, deploymentBinding?.plan_fingerprint],
    [binding?.recovery_plan_fingerprint, plan?.plan_fingerprint],
    [binding?.source_resource_fingerprint, deploymentBinding?.source_resource_fingerprint],
    [binding?.source_resource_fingerprint, plan?.source_resource_fingerprint],
    [binding?.target_resource_fingerprint, deploymentBinding?.target_resource_fingerprint],
    [binding?.target_resource_fingerprint, plan?.target_resource_fingerprint],
    [binding?.active_worker_version_id, deployment?.target?.active_version?.version_id],
    [plan?.source_manifest_fingerprint, deploymentBinding?.source_manifest_fingerprint],
    [plan?.target_manifest_fingerprint, deploymentBinding?.target_manifest_fingerprint],
    [plan?.runtime_contract_fingerprint, deploymentBinding?.runtime_contract_fingerprint],
    [field?.candidate_sha, binding?.candidate_sha],
    [field?.package_sha256, binding?.package_sha256],
    [field?.field_receipt_sha256, binding?.field_receipt_sha256],
    [field?.source_phase_receipt_sha256, chain?.source_phase?.sha256],
    [field?.deployment_receipt_sha256, chain?.target_phase?.sha256],
    [field?.seed_receipt_sha256, chain?.seed_receipt_sha256],
    [candidate?.candidateSha, binding?.candidate_sha],
    [candidate?.candidateTreeSha, binding?.candidate_tree_sha],
    [candidate?.fieldReceiptSha256, binding?.field_receipt_sha256],
    [candidate?.packageSha256, binding?.package_sha256],
    [candidate?.sourcePreflightReceiptSha256, chain?.source_preflight?.sha256],
    [candidate?.sourcePhaseReceiptSha256, chain?.source_phase?.sha256],
    [candidate?.targetPreflightReceiptSha256, chain?.target_preflight?.sha256],
    [candidate?.deploymentReceiptSha256, chain?.target_phase?.sha256],
    [candidate?.seedReceiptSha256, chain?.seed_receipt_sha256],
    [seedBinding?.candidate_sha, deploymentBinding?.candidate_sha],
    [seedBinding?.candidate_tree_sha, deploymentBinding?.candidate_tree_sha],
    [seedBinding?.field_receipt_sha256, deploymentBinding?.field_receipt_sha256],
    [seedBinding?.source_phase_receipt_sha256, chain?.source_phase?.sha256],
    [seedBinding?.package_sha256, deploymentBinding?.package_sha256],
    [seedBinding?.package_file_count, deploymentBinding?.package_file_count],
    [seedBinding?.execution_inventory_sha256, deploymentBinding?.execution_inventory_sha256],
    [seedBinding?.installed_execution_inventory_sha256,
      deploymentBinding?.installed_execution_inventory_sha256],
    [seedBinding?.source_manifest_fingerprint, deploymentBinding?.source_manifest_fingerprint],
    [seedBinding?.source_resource_fingerprint, deploymentBinding?.source_resource_fingerprint],
    [seedBinding?.runtime_contract_fingerprint, deploymentBinding?.runtime_contract_fingerprint],
    [seedBinding?.wrangler_wrapper_sha256, deploymentBinding?.wrangler_wrapper_sha256],
    [seedBinding?.wrangler_runtime_inventory_sha256,
      deploymentBinding?.wrangler_runtime_inventory_sha256],
    [seedBinding?.wrangler_entrypoint_sha256, deploymentBinding?.wrangler_entrypoint_sha256],
    [seedBinding?.node_executable_sha256, deploymentBinding?.node_executable_sha256],
    [seedBinding?.source_phase_run_id, sourcePhase?.binding?.run_id],
    [seedBinding?.source_a2_approval_fingerprint, sourcePhase?.a2_approval_fingerprint],
    [seedBinding?.source_active_version_id, sourcePhase?.source?.active_version?.version_id],
    [seedBinding?.source_script_etag, sourcePhase?.source?.active_version?.script_etag],
    [seedBinding?.source_deployment_id, sourcePhase?.source?.active_deployment?.deployment_id],
  ];
  if (!deploymentBinding || !sourcePhase || !seedBinding || !field || !candidate ||
      pairs.some(([left, right]) => left === undefined || left !== right)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_BINDING_INVALID");
  }
  return true;
}

function readNamed(path, expectedName, validator, binding) {
  if (basename(String(path || "")) !== expectedName) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  try {
    const record = readPrivateAggregateReceipt(path, {
      code: "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED",
      maxBytes: 1024 * 1024,
    });
    return Object.freeze({ ...record, value: validator(record.value, binding) });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldAcceptanceError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
}

function readDisposableRecoverySeedReceiptInternal(path) {
  if (basename(String(path || "")) !==
      DISPOSABLE_RECOVERY_SEED_RECEIPT_NAME) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  try {
    const record = readPrivateAggregateReceipt(path, {
      code: "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED",
      maxBytes: 1024 * 1024,
    });
    assertDisposableRecoverySeedReceipt(record.value);
    return Object.freeze({
      ...record,
      value: Object.freeze(structuredClone(record.value)),
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldAcceptanceError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
}

function readDisposableRecoveryDeploymentEvidenceInternal(
  receiptDirectoryInput,
) {
  const before = readPrivateDirectory(receiptDirectoryInput);
  const from = (name, validator) => readNamed(
    join(before.path, name),
    name,
    validator,
  );
  const sourcePreflight = from(
    DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
    assertDisposableRecoverySourcePreflightReceipt,
  );
  const sourcePhase = from(
    DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
    assertDisposableRecoverySourcePhaseReceipt,
  );
  const seedReceipt = readDisposableRecoverySeedReceiptInternal(
    join(before.path, DISPOSABLE_RECOVERY_SEED_RECEIPT_NAME),
  );
  const targetPreflight = from(
    DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
    assertDisposableRecoveryTargetPreflightReceipt,
  );
  const targetPhase = from(
    DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
    assertDisposableRecoveryTargetPhaseReceipt,
  );
  const chain = assertDisposableRecoveryDeploymentReceiptChain({
    source_preflight: sourcePreflight,
    source_phase: sourcePhase,
    seed_receipt_sha256: seedReceipt.sha256,
    target_preflight: targetPreflight,
    target_phase: targetPhase,
  });
  const after = readPrivateDirectory(before.path);
  if (!sameStableEntry(before.info, after.info)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  return Object.freeze({
    chain,
    seedReceipt: Object.freeze({
      value: seedReceipt.value,
      sha256: seedReceipt.sha256,
    }),
  });
}

/**
 * Read the exact fixed A1-A4 receipt chain and A3 seed from one owner-private
 * receipt directory. The returned object is process-local authority, not a
 * serializable assertion supplied by a caller.
 */
export function readDisposableRecoveryFieldDeploymentEvidence(
  receiptDirectory,
) {
  if (arguments.length !== 1) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  const directory = resolve(receiptDirectory);
  const capability = readDisposableRecoveryDeploymentEvidenceInternal(
    directory,
  );
  VERIFIED_DEPLOYMENT_EVIDENCE_READS.set(capability, Object.freeze({
    directory,
    fingerprint: JSON.stringify(canonical(capability)),
  }));
  return capability;
}

function readDisposableRecoveryFieldInterruptionEvidenceInternal({
  deploymentEvidence,
  teardownClosure,
}) {
  const loadedDeployment = assertCurrentDeploymentEvidenceCapability(
    deploymentEvidence,
  );
  const loadedTeardown = assertCurrentTeardownClosureCapability(
    teardownClosure,
  );
  const deploymentAuthority = VERIFIED_DEPLOYMENT_EVIDENCE_READS.get(
    loadedDeployment,
  );
  const teardownAuthority = VERIFIED_TEARDOWN_CLOSURE_READS.get(
    loadedTeardown,
  );
  const readerOptions = teardownAuthority?.readerOptions;
  const receiptDirectory = readerOptions
    ? dirname(resolve(readerOptions.receiptPath))
    : null;
  if (!deploymentAuthority || !teardownAuthority ||
      deploymentAuthority.directory !== receiptDirectory) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  const explicitItems = new Map(
    loadedTeardown.value.evidence.retained_evidence.inventory.explicit_files
      .map((item) => [item.role, item]),
  );
  const readBoundReceipt = (role, path, validator, validatorInput = undefined) => {
    const absolute = resolve(path);
    const retained = explicitItems.get(role);
    if (!retained || basename(absolute) !== retained.name ||
        createHash("sha256").update(absolute).digest("hex") !==
          retained.path_sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    let record;
    try {
      record = readPrivateAggregateReceipt(absolute, {
        code: "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED",
        maxBytes: MAX_FIXED_FILE_BYTES,
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    if (record.sha256 !== retained.sha256 ||
        record.info?.size !== retained.bytes) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    let value;
    try { value = validator(record.value, validatorInput); }
    catch { refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED"); }
    return Object.freeze({ record, value });
  };
  const planRead = readBoundReceipt(
    "plan",
    readerOptions.planPath,
    validateVerifiedRecoveryPlan,
  );
  const stateRead = readBoundReceipt(
    "state",
    readerOptions.statePath,
    validateVerifiedRecoveryState,
    planRead.value,
  );
  const fieldReceiptPath = resolve(readerOptions.fieldReceiptPath);
  const retainedFieldReceipt = explicitItems.get("field_receipt");
  const fieldReceipt = hashPrivateFile(fieldReceiptPath, MAX_FIXED_FILE_BYTES);
  if (!retainedFieldReceipt || basename(fieldReceiptPath) !==
        retainedFieldReceipt.name ||
      createHash("sha256").update(fieldReceiptPath).digest("hex") !==
        retainedFieldReceipt.path_sha256 ||
      fieldReceipt.sha256 !== retainedFieldReceipt.sha256 ||
      fieldReceipt.bytes !== retainedFieldReceipt.bytes) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  let proof;
  try {
    proof = readCompletedTestBootstrapProof({
      artifactsDirectory: readerOptions.artifactDirectory,
      plan: planRead.value,
      state: stateRead.value,
      deploymentReceipt: loadedDeployment.chain.target_phase,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const candidate = proof?.candidate_evidence;
  const integerFields = [
    candidate?.packageBytes,
    candidate?.packageFileCount,
    candidate?.seedDocumentCount,
    candidate?.seedChunkCount,
    candidate?.seedFtsCount,
    candidate?.seedVectorCount,
    candidate?.seedReplayUnchangedDocuments,
    candidate?.wranglerRuntimePackageCount,
    candidate?.wranglerRuntimeFileCount,
    candidate?.wranglerRuntimeBytes,
    candidate?.wranglerRuntimeSchemaVersion,
    proof?.actual_chunks_admitted_to_epoch,
  ];
  const hashFields = [
    candidate?.fieldReceiptSha256,
    candidate?.packageSha256,
    candidate?.executionInventorySha256,
    candidate?.sourcePreflightReceiptSha256,
    candidate?.sourcePhaseReceiptSha256,
    candidate?.deploymentReceiptSha256,
    candidate?.seedReceiptSha256,
    candidate?.targetPreflightReceiptSha256,
    candidate?.seedFixtureSha256,
    candidate?.seedD1ContentFingerprint,
    candidate?.wranglerRuntimeInventorySha256,
    candidate?.wranglerRuntimeEntrypointSha256,
    candidate?.nodeExecutableSha256,
    proof?.checkpoint?.pin?.hash,
    proof?.resume?.pin?.hash,
    proof?.promotion?.pin?.hash,
  ];
  const deploymentBinding = loadedDeployment.chain.target_phase.value.binding;
  if (!exactKeys(proof, [
    "candidate_evidence", "checkpoint", "resume", "promotion",
    "actual_chunks_admitted_to_epoch",
  ]) || !exactKeys(candidate, INTERRUPTION_CANDIDATE_EVIDENCE_KEYS) ||
      integerFields.some((value) => !Number.isSafeInteger(value) || value < 1) ||
      proof.actual_chunks_admitted_to_epoch < 3_001 ||
      hashFields.some((value) => !SHA256_RE.test(String(value || ""))) ||
      !COMMIT_RE.test(String(candidate.candidateSha || "")) ||
      !COMMIT_RE.test(String(candidate.candidateTreeSha || "")) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(String(candidate.fieldReceiptRunId || "")) ||
      candidate.fieldReceiptSha256 !== fieldReceipt.sha256 ||
      candidate.fieldReceiptSha256 !== deploymentBinding.field_receipt_sha256 ||
      candidate.fieldReceiptRunId !== deploymentBinding.field_receipt_run_id ||
      candidate.sourcePreflightReceiptSha256 !==
        loadedDeployment.chain.source_preflight.sha256 ||
      candidate.sourcePhaseReceiptSha256 !==
        loadedDeployment.chain.source_phase.sha256 ||
      candidate.seedReceiptSha256 !== loadedDeployment.seedReceipt.sha256 ||
      candidate.targetPreflightReceiptSha256 !==
        loadedDeployment.chain.target_preflight.sha256 ||
      candidate.deploymentReceiptSha256 !==
        loadedDeployment.chain.target_phase.sha256) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_INTERRUPTION_INVALID");
  }
  return Object.freeze({
    recoveryPlan: planRead.value,
    recoveryPlanSha256: planRead.record.sha256,
    recoveryState: stateRead.value,
    recoveryStateSha256: stateRead.record.sha256,
    interruptionProof: Object.freeze({
      candidate_evidence: Object.freeze({ ...candidate }),
      checkpoint_sha256: proof.checkpoint.pin.hash,
      resume_authorization_sha256: proof.resume.pin.hash,
      promotion_authorization_sha256: proof.promotion.pin.hash,
      actual_chunks_admitted_to_epoch:
        proof.actual_chunks_admitted_to_epoch,
    }),
  });
}

/**
 * Reopen the fixed completed interruption records, the exact retained plan and
 * state, and the physical field receipt. Only this process-local capability can
 * carry interruption authority into final A17 acceptance.
 */
export function readDisposableRecoveryFieldInterruptionEvidence(options) {
  if (arguments.length !== 1 || !exactKeys(options, [
    "deploymentEvidence", "teardownClosure",
  ])) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  const request = Object.freeze({
    deploymentEvidence: options.deploymentEvidence,
    teardownClosure: options.teardownClosure,
  });
  const capability = readDisposableRecoveryFieldInterruptionEvidenceInternal(
    request,
  );
  VERIFIED_INTERRUPTION_EVIDENCE_READS.set(capability, Object.freeze({
    request,
    fingerprint: JSON.stringify(canonical(capability)),
  }));
  return capability;
}

function readDisposableRecoveryTargetEvalReceiptInternal(path, binding) {
  return readNamed(
    path,
    DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
    assertDisposableRecoveryTargetEvalReceipt,
    binding,
  );
}

export function readDisposableRecoveryTargetEvalReceipt(path, binding) {
  if (arguments.length !== 2) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  const loaded = readDisposableRecoveryTargetEvalReceiptInternal(path, binding);
  const capability = Object.freeze(loaded);
  VERIFIED_TARGET_EVAL_READS.set(capability, Object.freeze({
    path: resolve(path),
    binding: Object.freeze(structuredClone(binding)),
    fingerprint: JSON.stringify(canonical(capability)),
  }));
  return capability;
}

/**
 * Reopen every retained K0_RESET authorization and ordered journal event.
 * Inventory hashes are insufficient here: the production verifier authenticates
 * the actual reset state machine, and a directory census rejects unlisted reset
 * receipts or journal events.
 */
export function verifyDisposableRecoveryRetainedK0ResetEvidence({
  receiptDirectory: receiptDirectoryInput,
  retainedEvidence,
  binding,
  keychainPreparation,
}) {
  if (arguments.length !== 1) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  const receiptDirectory = resolve(receiptDirectoryInput);
  const inventory = retainedEvidence?.inventory?.receipt_directory;
  if (!inventory || inventory.path_sha256 !== createHash("sha256")
    .update(receiptDirectory)
    .digest("hex")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const readProvision = readDisposableRecoveryProvisionArtifacts;
  let source;
  let target;
  try {
    source = readProvision({
      receiptPath: join(
        receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_phase,
      ),
      manifestPath: join(
        receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_manifest,
      ),
      expectedReceiptDirectory: receiptDirectory,
      role: "source",
    });
    target = readProvision({
      receiptPath: join(
        receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_phase,
      ),
      manifestPath: join(
        receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_manifest,
      ),
      expectedReceiptDirectory: receiptDirectory,
      role: "target",
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  if (source?.accountId !== target?.accountId ||
      createHash("sha256").update(String(source?.accountId || "")).digest("hex") !==
        keychainPreparation?.account_fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const keychainBinding = Object.freeze({
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    account_id: source.accountId,
  });
  let entries;
  try {
    entries = readdirSync(receiptDirectory, {
      withFileTypes: true,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const resetEntries = [];
  const journalEntries = [];
  for (const entry of entries) {
    if (entry.name.startsWith(DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX)) {
      if (!entry.isFile() || entry.isSymbolicLink() ||
          !RETAINED_RESET_JOURNAL_EVENT_RE.test(entry.name)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      journalEntries.push(entry.name);
    } else if (entry.name.startsWith(
      DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX,
    )) {
      if (!entry.isFile() || entry.isSymbolicLink() ||
          !RETAINED_RESET_RECEIPT_RE.test(entry.name)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      resetEntries.push(entry.name);
    }
  }
  resetEntries.sort((left, right) => left.localeCompare(right));
  journalEntries.sort((left, right) => left.localeCompare(right));
  const expectedResetNames = inventory.k0_reset_receipts.map((item) => item.name);
  const expectedJournalNames = inventory.k0_reset_journals
    .flatMap((group) => group.event_receipts.map((item) => item.name))
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(resetEntries) !== JSON.stringify(expectedResetNames) ||
      JSON.stringify(journalEntries) !== JSON.stringify(expectedJournalNames)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  const readReceipt = readPrivateAggregateReceipt;
  const verifyReset = verifyDisposableRecoveryFieldKeychainResetJournal;
  for (let index = 0; index < inventory.k0_reset_receipts.length; index += 1) {
    const resetItem = inventory.k0_reset_receipts[index];
    const group = inventory.k0_reset_journals[index];
    let resetRecord;
    let verification;
    try {
      resetRecord = readReceipt(join(receiptDirectory, resetItem.name), {
        code: "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED",
        maxBytes: 64 * 1024 * 1024,
      });
      verification = verifyReset({
        binding: keychainBinding,
        resetReceiptPath: join(receiptDirectory, resetItem.name),
        expectedReceiptDirectory: receiptDirectory,
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    if (resetRecord.sha256 !== resetItem.sha256 ||
        resetRecord.info?.size !== resetItem.bytes ||
        JSON.stringify(canonical(verification)) !==
          JSON.stringify(canonical(group.verification))) {
      refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
    }
    for (const eventItem of group.event_receipts) {
      let eventRecord;
      try {
        eventRecord = readReceipt(join(receiptDirectory, eventItem.name), {
          code: "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED",
          maxBytes:
            DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
        });
      } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
      if (eventRecord.sha256 !== eventItem.sha256 ||
          eventRecord.info?.size !== eventItem.bytes) {
        refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
      }
    }
  }
  return true;
}

function readDisposableRecoveryManualTeardownClosureInternal(options) {
  const { receiptPath: path, binding } = options;
  const loaded = readNamed(
    path,
    DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
    assertDisposableRecoveryManualTeardownClosure,
    binding,
  );
  const receiptPath = resolve(path);
  const receiptDirectory = dirname(receiptPath);
  const closure = loaded.value;
  verifyDisposableRecoveryRetainedK0ResetEvidence({
    receiptDirectory,
    retainedEvidence: closure.evidence.retained_evidence,
    binding: closure.binding,
    keychainPreparation: closure.evidence.keychain_preparation,
  });
  assertPhysicalRetainedEvidence(
    options,
    closure.evidence.retained_evidence,
  );
  const pendingMarker = {
    schema_version: 1,
    kind: "v048_disposable_recovery_field_closeout_pending",
    status: "keychain_cleanup_in_progress",
    binding: closure.binding,
    target_eval_receipt_sha256: closure.evidence.target_eval_receipt_sha256,
    source_teardown_receipt_sha256:
      closure.evidence.source_teardown_receipt_sha256,
    target_teardown_receipt_sha256:
      closure.evidence.target_teardown_receipt_sha256,
    keychain_preparation: closure.evidence.keychain_preparation,
    retained_evidence: closure.evidence.retained_evidence,
    approval_fingerprint: closure.evidence.a17_approval_fingerprint,
    campaign_keychain_locator_sha256:
      closure.evidence.keychain_preparation.campaign_keychain_locator_sha256,
  };
  let terminalJournal;
  try {
    terminalJournal = readDisposableRecoveryFieldCloseoutDeletionJournal({
      journalPath: join(
        receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
      ),
      receiptPath,
      expectedReceiptDirectory: receiptDirectory,
      binding: {
        a17_approval_fingerprint: closure.evidence.a17_approval_fingerprint,
        retained_evidence_inventory_sha256:
          closure.evidence.retained_evidence.inventory_sha256,
        keychain_binding_sha256:
          closure.evidence.keychain_preparation.keychain_binding_sha256,
        reservation_marker_sha256: privateReceiptSha256(pendingMarker),
      },
      expectedSummary: closure.keychain.deletion_journal,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  if (!terminalJournal?.summary ||
      JSON.stringify(canonical(terminalJournal.summary)) !==
        JSON.stringify(canonical(closure.keychain.deletion_journal))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  let terminalAnchor;
  try {
    const expected = disposableRecoveryFieldCloseoutTerminalAnchorValue({
      receiptPath,
      expectedReceiptDirectory: receiptDirectory,
      reservationMarkerSha256: privateReceiptSha256(pendingMarker),
      finalReceiptSha256: loaded.sha256,
      finalReceiptBytes: loaded.info.size,
      finalizationCommitReceiptSha256:
        disposableRecoveryFieldCloseoutFinalizationCommitSha256({
          receiptPath,
          reservationMarkerSha256: privateReceiptSha256(pendingMarker),
          finalReceiptSha256: loaded.sha256,
          finalReceiptBytes: loaded.info.size,
        }),
      completedAt: closure.completed_at,
      approvalFingerprint: closure.evidence.a17_approval_fingerprint,
      retainedEvidenceInventorySha256:
        closure.evidence.retained_evidence.inventory_sha256,
      keychainBindingSha256:
        closure.evidence.keychain_preparation.keychain_binding_sha256,
      terminalJournal: closure.keychain.deletion_journal,
    });
    terminalAnchor = readDisposableRecoveryFieldCloseoutTerminalAnchor({
      receiptPath,
      expectedReceiptDirectory: receiptDirectory,
      expected,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  let finalAgain;
  let journalAgain;
  let anchorAgain;
  try {
    finalAgain = readNamed(
      receiptPath,
      DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
      assertDisposableRecoveryManualTeardownClosure,
      binding,
    );
    journalAgain = readDisposableRecoveryFieldCloseoutDeletionJournal({
      journalPath: join(
        receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
      ),
      receiptPath,
      expectedReceiptDirectory: receiptDirectory,
      binding: {
        a17_approval_fingerprint: closure.evidence.a17_approval_fingerprint,
        retained_evidence_inventory_sha256:
          closure.evidence.retained_evidence.inventory_sha256,
        keychain_binding_sha256:
          closure.evidence.keychain_preparation.keychain_binding_sha256,
        reservation_marker_sha256: privateReceiptSha256(pendingMarker),
      },
      expectedSummary: closure.keychain.deletion_journal,
    });
    anchorAgain = readDisposableRecoveryFieldCloseoutTerminalAnchor({
      receiptPath,
      expectedReceiptDirectory: receiptDirectory,
      expected: terminalAnchor.value,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  if (finalAgain.sha256 !== loaded.sha256 ||
      finalAgain.info?.size !== loaded.info?.size ||
      JSON.stringify(canonical(journalAgain.summary)) !==
        JSON.stringify(canonical(terminalJournal.summary)) ||
      anchorAgain.sha256 !== terminalAnchor.sha256) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED");
  }
  assertPhysicalRetainedEvidence(
    options,
    closure.evidence.retained_evidence,
  );
  return Object.freeze({
    ...loaded,
    terminalAnchor: Object.freeze({
      value: terminalAnchor.value,
      sha256: terminalAnchor.sha256,
      bytes: terminalAnchor.bytes,
    }),
  });
}

export function readDisposableRecoveryManualTeardownClosure(options) {
  if (arguments.length !== 1 || !options || typeof options !== "object" ||
      Array.isArray(options)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  const readerOptions = Object.freeze(structuredClone(options));
  const capability = readDisposableRecoveryManualTeardownClosureInternal(
    readerOptions,
  );
  VERIFIED_TEARDOWN_CLOSURE_READS.set(capability, Object.freeze({
    readerOptions,
    fingerprint: JSON.stringify(canonical(capability)),
  }));
  return capability;
}

function assertCurrentDeploymentEvidenceCapability(capability) {
  const authority = VERIFIED_DEPLOYMENT_EVIDENCE_READS.get(capability);
  if (!authority || !Object.isFrozen(capability) ||
      JSON.stringify(canonical(capability)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  const current = readDisposableRecoveryDeploymentEvidenceInternal(
    authority.directory,
  );
  if (JSON.stringify(canonical(current)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  return capability;
}

function assertCurrentInterruptionEvidenceCapability(capability) {
  const authority = VERIFIED_INTERRUPTION_EVIDENCE_READS.get(capability);
  if (!authority || !Object.isFrozen(capability) ||
      JSON.stringify(canonical(capability)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  const current = readDisposableRecoveryFieldInterruptionEvidenceInternal(
    authority.request,
  );
  if (JSON.stringify(canonical(current)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  return capability;
}

function assertCurrentTargetEvalCapability(capability) {
  const authority = VERIFIED_TARGET_EVAL_READS.get(capability);
  if (!authority || !Object.isFrozen(capability) ||
      JSON.stringify(canonical(capability)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  const current = readDisposableRecoveryTargetEvalReceiptInternal(
    authority.path,
    authority.binding,
  );
  if (JSON.stringify(canonical(current)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  return capability;
}

function assertCurrentTeardownClosureCapability(capability) {
  const authority = VERIFIED_TEARDOWN_CLOSURE_READS.get(capability);
  if (!authority || !Object.isFrozen(capability) ||
      JSON.stringify(canonical(capability)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  const current = readDisposableRecoveryManualTeardownClosureInternal(
    authority.readerOptions,
  );
  if (JSON.stringify(canonical(current)) !== authority.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  return capability;
}

function assertAcceptanceCapabilityDirectoryBinding({
  deploymentEvidence,
  interruptionEvidence,
  targetEvalReceipt,
  teardownClosure,
}) {
  const deploymentAuthority = VERIFIED_DEPLOYMENT_EVIDENCE_READS.get(
    deploymentEvidence,
  );
  const targetAuthority = VERIFIED_TARGET_EVAL_READS.get(targetEvalReceipt);
  const teardownAuthority = VERIFIED_TEARDOWN_CLOSURE_READS.get(
    teardownClosure,
  );
  const interruptionAuthority = VERIFIED_INTERRUPTION_EVIDENCE_READS.get(
    interruptionEvidence,
  );
  const teardownDirectory = teardownAuthority
    ? dirname(resolve(teardownAuthority.readerOptions.receiptPath))
    : null;
  if (!deploymentAuthority || !interruptionAuthority || !targetAuthority ||
      !teardownAuthority ||
      interruptionAuthority.request.deploymentEvidence !== deploymentEvidence ||
      interruptionAuthority.request.teardownClosure !== teardownClosure ||
      deploymentAuthority.directory !== teardownDirectory ||
      dirname(targetAuthority.path) !== teardownDirectory) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID");
  }
  return true;
}

function assertTeardownClosureTerminalAnchor(anchorInput, teardown) {
  let anchor;
  try {
    anchor = assertDisposableRecoveryFieldCloseoutTerminalAnchor(anchorInput);
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_TERMINAL_ANCHOR_INVALID");
  }
  const pendingMarker = {
    schema_version: 1,
    kind: "v048_disposable_recovery_field_closeout_pending",
    status: "keychain_cleanup_in_progress",
    binding: teardown.binding,
    target_eval_receipt_sha256: teardown.evidence.target_eval_receipt_sha256,
    source_teardown_receipt_sha256:
      teardown.evidence.source_teardown_receipt_sha256,
    target_teardown_receipt_sha256:
      teardown.evidence.target_teardown_receipt_sha256,
    keychain_preparation: teardown.evidence.keychain_preparation,
    retained_evidence: teardown.evidence.retained_evidence,
    approval_fingerprint: teardown.evidence.a17_approval_fingerprint,
    campaign_keychain_locator_sha256:
      teardown.evidence.keychain_preparation.campaign_keychain_locator_sha256,
  };
  const finalBytes = Buffer.byteLength(
    `${JSON.stringify(teardown, null, 2)}\n`,
    "utf8",
  );
  if (anchor.reservation_marker_sha256 !== privateReceiptSha256(pendingMarker) ||
      anchor.final_receipt_sha256 !== privateReceiptSha256(teardown) ||
      anchor.final_receipt_bytes !== finalBytes ||
      anchor.completed_at !== teardown.completed_at ||
      anchor.a17_approval_fingerprint !==
        teardown.evidence.a17_approval_fingerprint ||
      anchor.retained_evidence_inventory_sha256 !==
        teardown.evidence.retained_evidence.inventory_sha256 ||
      anchor.keychain_binding_sha256 !==
        teardown.evidence.keychain_preparation.keychain_binding_sha256 ||
      JSON.stringify(canonical(anchor.terminal_deletion_journal)) !==
        JSON.stringify(canonical(teardown.keychain.deletion_journal))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_TERMINAL_ANCHOR_INVALID");
  }
  return anchor;
}

export function assertDisposableRecoveryFieldAcceptance(options) {
  const expectedKeys = [
    "deploymentEvidence", "interruptionEvidence", "binding",
    "targetEvalReceipt", "teardownClosure",
  ];
  if (arguments.length !== 1 || !exactKeys(options, expectedKeys)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  const {
    deploymentEvidence,
    interruptionEvidence,
    binding,
    targetEvalReceipt,
    teardownClosure,
  } = options;
  const loadedDeployment = assertCurrentDeploymentEvidenceCapability(
    deploymentEvidence,
  );
  const loadedTargetEval = assertCurrentTargetEvalCapability(
    targetEvalReceipt,
  );
  const loadedTeardown = assertCurrentTeardownClosureCapability(
    teardownClosure,
  );
  const loadedInterruption = assertCurrentInterruptionEvidenceCapability(
    interruptionEvidence,
  );
  assertAcceptanceCapabilityDirectoryBinding({
    deploymentEvidence: loadedDeployment,
    interruptionEvidence: loadedInterruption,
    targetEvalReceipt: loadedTargetEval,
    teardownClosure: loadedTeardown,
  });
  const chain = loadedDeployment.chain;
  const seedReceipt = loadedDeployment.seedReceipt;
  const seed = seedReceipt.value;
  const plan = loadedInterruption.recoveryPlan;
  const state = loadedInterruption.recoveryState;
  const interruptionProof = loadedInterruption.interruptionProof;
  const targetEval = assertDisposableRecoveryTargetEvalReceipt(
    loadedTargetEval.value,
    binding,
  );
  const teardown = assertDisposableRecoveryManualTeardownClosure(
    loadedTeardown.value,
    binding,
  );
  const terminalAnchor = assertTeardownClosureTerminalAnchor(
    loadedTeardown.terminalAnchor.value,
    teardown,
  );
  const field = state.field_proof;
  assertFieldEvidenceBinding({
    chain,
    seed,
    plan,
    state,
    binding,
    interruptionProof,
    teardown,
  });
  const exported = state.completed.find((entry) => entry.id === "export_d1")?.evidence;
  const verifyExport = state.completed.find((entry) => entry.id === "verify_export")?.evidence;
  const retainedExport = teardown.evidence?.retained_evidence?.inventory
    ?.artifact_directory?.items?.find(
      (item) => item.relative_name === ".brain-recovery-export.sql.fbrenc",
    );
  const retainedWrapper = teardown.evidence?.retained_evidence?.inventory
    ?.explicit_files?.find((item) => item.role === "wrangler_wrapper");
  const retainedPlan = teardown.evidence?.retained_evidence?.inventory
    ?.explicit_files?.find((item) => item.role === "plan");
  const retainedState = teardown.evidence?.retained_evidence?.inventory
    ?.explicit_files?.find((item) => item.role === "state");
  const retainedReceiptHashes = new Map(
    teardown.evidence?.retained_evidence?.inventory?.receipt_directory?.items
      ?.map((item) => [item.name, item.sha256]) ?? [],
  );
  const rebuild = state.completed.find((entry) => entry.id === "rebuild_vectorize")?.evidence;
  const health = state.completed.find((entry) => entry.id === "verify_health")?.evidence;
  const evaluation = state.completed.find((entry) => entry.id === "verify_eval")?.evidence;
  const completedStageIds = state.completed.map((entry) => entry.id);
  const expectedStageIds = VERIFIED_RECOVERY_STAGES.map((stage) => stage.id);
  const completedStageTimes = state.completed.map((entry) =>
    exactIso(entry.completed_at) ? Date.parse(entry.completed_at) : Number.NaN);
  const nowValue = Date.now();
  const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  const finalStageAt = completedStageTimes.at(-1);
  const stateUpdatedAt = exactIso(state.updated_at) ? Date.parse(state.updated_at) : Number.NaN;
  const chainTimes = [
    chain.source_preflight.value.completed_at,
    chain.source_phase.value.completed_at,
    chain.target_preflight.value.completed_at,
    chain.target_phase.value.completed_at,
  ].map((value) => exactIso(value) ? Date.parse(value) : Number.NaN);
  const seedAt = exactIso(seed.completed_at) ? Date.parse(seed.completed_at) : Number.NaN;
  const targetPhaseAt = chainTimes.at(-1);
  const firstStageAt = completedStageTimes[0];
  const targetEvalAt = exactIso(targetEval.completed_at)
    ? Date.parse(targetEval.completed_at)
    : Number.NaN;
  const teardownTimes = [
    teardown.source.started_at,
    teardown.source.completed_at,
    teardown.target.started_at,
    teardown.target.completed_at,
    teardown.completed_at,
  ].map((value) => exactIso(value) ? Date.parse(value) : Number.NaN);
  const [sourceTeardownStartedAt, sourceTeardownCompletedAt,
    targetTeardownStartedAt, targetTeardownCompletedAt, teardownCompletedAt] = teardownTimes;
  const chronologyInvalid = !Number.isFinite(now) ||
    chainTimes.some((timestamp, index) =>
      !Number.isFinite(timestamp) || timestamp > now ||
      (index > 0 && timestamp < chainTimes[index - 1])) ||
    !Number.isFinite(seedAt) || seedAt > now ||
    !Number.isFinite(firstStageAt) || firstStageAt < targetPhaseAt ||
    completedStageTimes.some((timestamp, index) =>
      !Number.isFinite(timestamp) || timestamp > now ||
      (index > 0 && timestamp < completedStageTimes[index - 1])) ||
    !Number.isFinite(stateUpdatedAt) || stateUpdatedAt < finalStageAt || stateUpdatedAt > now ||
    !Number.isFinite(targetEvalAt) || targetEvalAt < finalStageAt || targetEvalAt > now ||
    teardownTimes.some((timestamp) => !Number.isFinite(timestamp) || timestamp > now) ||
    sourceTeardownCompletedAt < sourceTeardownStartedAt ||
    targetTeardownStartedAt < sourceTeardownCompletedAt ||
    targetTeardownCompletedAt < targetTeardownStartedAt ||
    teardownCompletedAt < targetTeardownCompletedAt;
  if (state.status !== "complete" ||
      JSON.stringify(completedStageIds) !== JSON.stringify(expectedStageIds) || !field ||
      field.source_phase_receipt_sha256 !== chain.source_phase.sha256 ||
      field.deployment_receipt_sha256 !== chain.target_phase.sha256 ||
      field.seed_receipt_sha256 !== chain.seed_receipt_sha256 ||
      field.seed_receipt_sha256 !== interruptionProof.candidate_evidence.seedReceiptSha256 ||
      field.candidate_sha !== interruptionProof.candidate_evidence.candidateSha ||
      field.package_sha256 !== interruptionProof.candidate_evidence.packageSha256 ||
      !retainedExport ||
      retainedExport.sha256 !== exported?.artifact_sha256 ||
      retainedExport.bytes !== exported?.artifact_bytes ||
      retainedExport.sha256 !== verifyExport?.artifact_sha256 ||
      retainedExport.bytes !== verifyExport?.artifact_bytes ||
      retainedWrapper?.sha256 !==
        chain?.target_phase?.value?.binding?.wrangler_wrapper_sha256 ||
      retainedPlan?.sha256 !== loadedInterruption.recoveryPlanSha256 ||
      retainedState?.sha256 !== loadedInterruption.recoveryStateSha256 ||
      retainedReceiptHashes.get(
        DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
      ) !== chain.source_preflight.sha256 ||
      retainedReceiptHashes.get(
        DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
      ) !== chain.source_phase.sha256 ||
      retainedReceiptHashes.get(
        DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
      ) !== chain.target_preflight.sha256 ||
      retainedReceiptHashes.get(
        DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
      ) !== chain.target_phase.sha256 ||
      retainedReceiptHashes.get(DISPOSABLE_RECOVERY_SEED_RECEIPT_NAME) !==
        seedReceipt.sha256 ||
      loadedTargetEval.sha256 !==
        teardown.evidence.target_eval_receipt_sha256 ||
      [chain.source_preflight, chain.source_phase, chain.target_preflight,
        chain.target_phase, seedReceipt].some((record) =>
        record.sha256 !== privateReceiptSha256(record.value)) ||
      verifyExport?.document_count !== 6_001 || verifyExport?.chunk_count < 6_001 ||
      verifyExport?.fts_count !== verifyExport?.chunk_count ||
      rebuild?.vector_count !== verifyExport?.chunk_count || rebuild?.pending_outbox !== 0 ||
      rebuild?.failed_vectors !== 0 || interruptionProof.actual_chunks_admitted_to_epoch < 3_001 ||
      health?.status !== "pass" || health?.failure_count !== 0 || health?.vector_backlog !== 0 ||
      evaluation?.profile !== "release" || evaluation?.status !== "pass" ||
      evaluation?.critical_failures !== 0 || evaluation?.unauthorized_retrievals !== 0 ||
      targetEval.projection.documents !== verifyExport.document_count ||
      targetEval.projection.d1_chunks !== verifyExport.chunk_count ||
      targetEval.projection.fts_rows !== verifyExport.fts_count ||
      targetEval.projection.vectorize_vectors !== rebuild.vector_count ||
      JSON.stringify(canonical(
        targetEval.campaign_protection.a4_authority,
      )) !== JSON.stringify(canonical(
        chain.target_phase.value.final_semantic.campaign_authority,
      )) ||
      teardown.evidence.target_eval_receipt_sha256 !== privateReceiptSha256(targetEval) ||
      Date.parse(seed.completed_at) < Date.parse(chain.source_phase.value.completed_at) ||
      Date.parse(seed.completed_at) > Date.parse(chain.target_preflight.value.completed_at) ||
      Date.parse(state.updated_at) < Date.parse(chain.target_phase.value.completed_at) ||
      Date.parse(targetEval.completed_at) < Date.parse(state.updated_at) ||
      chronologyInvalid ||
      Date.parse(teardown.source.started_at) < Date.parse(targetEval.completed_at) ||
      teardown.status !== "closed" || seed.status !== "passed") {
    refuse("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_INCOMPLETE");
  }
  assertCurrentDeploymentEvidenceCapability(loadedDeployment);
  assertCurrentInterruptionEvidenceCapability(loadedInterruption);
  assertCurrentTargetEvalCapability(loadedTargetEval);
  assertCurrentTeardownClosureCapability(loadedTeardown);
  return Object.freeze({
    status: "accepted",
    candidate_sha: field.candidate_sha,
    package_sha256: field.package_sha256,
    plan_fingerprint: plan.plan_fingerprint,
    documents: verifyExport.document_count,
    chunks: verifyExport.chunk_count,
    vectors: rebuild.vector_count,
    actual_chunks_admitted_to_epoch: interruptionProof.actual_chunks_admitted_to_epoch,
    terminal_anchor_sha256: privateReceiptSha256(terminalAnchor),
  });
}
