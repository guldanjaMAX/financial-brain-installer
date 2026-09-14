/**
 * A17 local closeout for the fixed v0.4.8 disposable recovery campaign.
 *
 * This runs only after the direct target evaluation and both ordered provider
 * teardown receipts exist. It removes exactly four fixed campaign Keychain
 * items, verifies their absence without reading their values, and proves the
 * shared test-account Cloudflare token still resolves without printing it.
 * It never calls Cloudflare and never deletes retained evidence artifacts.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  keychainChildEnvironment,
  parseAdminKeySecretReference,
} from "./admin-key-persistence.mjs";
import { hasStoredCloudflareToken } from "./cloudflare-token-store.mjs";
import {
  DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
  DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  assertDisposableRecoveryManualTeardownClosure,
  assertDisposableRecoveryTargetEvalReceipt,
} from "./disposable-recovery-field-acceptance.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES,
  DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME,
} from "./disposable-recovery-field-deploy.mjs";
import {
  assertDisposableRecoveryFieldKeychainPreparedReceiptCapability,
  assertDisposableRecoveryFieldKeychainVerificationCapability,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PROTOCOL,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PROTOCOL,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL,
  assertDisposableRecoveryFieldKeychainResetAuthorizationReceipt,
  readDisposableRecoveryFieldKeychainPreparedReceipt,
  verifyDisposableRecoveryFieldKeychainResetJournal,
  verifyDisposableRecoveryFieldKeychainPrep,
} from "./disposable-recovery-field-keychain-prep.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES,
} from "./disposable-recovery-field-provision.mjs";
import {
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_ABSENT_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_ABSENT_PREVIEW_NAME,
  assertDisposableRecoveryBrainTeardownReceipt,
  assertDisposableRecoveryTeardownA12EvidenceCapability,
  assertDisposableRecoveryTeardownProvisionArtifactsCapability,
  readDisposableRecoveryTeardownA12Evidence,
  readDisposableRecoveryTeardownProvisionArtifacts,
} from "./disposable-recovery-field-teardown.mjs";
import {
  assertDisposableRecoveryTargetEvalBinding,
} from "./disposable-recovery-target-eval.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL,
  appendDisposableRecoveryFieldCloseoutDeletionJournal,
  assertDisposableRecoveryFieldCloseoutDeletionJournalRecords,
  readDisposableRecoveryFieldCloseoutDeletionJournal,
} from "./disposable-recovery-field-closeout-journal.mjs";
import {
  assertNoDarwinReceiptAcl,
  assertPrivateAggregateOutputPath,
  assertPrivateAggregateReceiptDirectory,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptCommitPath,
  privateAggregateReceiptPendingPath,
  privateAggregateReceiptStagedPath,
  readPrivateAggregateReceipt,
  recoverPrivateAggregateReceiptFinalization,
  reservePrivateAggregateReceipt,
  resumePrivateAggregateReceiptReservation,
  validatePrivateAggregateReceiptReservation,
} from "./private-aggregate-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
  createDisposableRecoveryFieldCloseoutTerminalAnchor,
  disposableRecoveryFieldCloseoutFinalizationCommitSha256,
  disposableRecoveryFieldCloseoutTerminalAnchorValue,
  readDisposableRecoveryFieldCloseoutTerminalAnchor,
} from "./disposable-recovery-field-closeout-terminal-anchor.mjs";
import {
  hasRecoveryArtifactResiduePathComponent,
  isRecoveryArtifactResiduePathComponent,
} from "./recovery-artifact-residue-policy.mjs";
import {
  inspectVerifiedRecoveryManifestBindings,
  validateVerifiedRecoveryPlan,
  validateVerifiedRecoveryState,
} from "./verified-recovery.mjs";

let readTestCloseoutRuntime = null;
if (process.env.NODE_TEST_CONTEXT === "child-v8") {
  try {
    ({ readTestDisposableRecoveryFieldCloseoutRuntime:
      readTestCloseoutRuntime } = await import(
      "../test/helpers/disposable-recovery-closeout-keychain.mjs"
    ));
  } catch {
    // Packaged production artifacts deliberately exclude test helpers.
  }
}

export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PROTOCOL =
  "v048-disposable-recovery-field-closeout-v1";
/** @deprecated The permanent terminal anchor replaces the removable guard. */
export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_POST_DELETE_GUARD_NAME =
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME;
export {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL,
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
};

const SHA256_RE = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const K0_RESET_RECEIPT_RE =
  /^v048-disposable-field-keychain-prep-reset-[a-f0-9]{64}\.json$/u;
const K0_RESET_JOURNAL_EVENT_RE = new RegExp(
  `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX}` +
    `([a-f0-9]{64})-([0-9]{2})-` +
    `(planned|sent-unconfirmed|confirmed|reconciled|complete)\\.json$`,
  "u",
);
const KEYCHAIN_DEFINITIONS = Object.freeze([
  Object.freeze({
    reference: "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
    purpose: "source_admin_key",
    format: "lowercase_hex_48",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
    purpose: "target_admin_key",
    format: "lowercase_hex_48",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
    purpose: "recovery_artifact_key",
    format: "recovery_artifact_v1",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/bank-wrapping-v2",
    purpose: "bank_access_wrapping_key_v2",
    format: "bank_access_wrapping_v2",
  }),
]);
const KEYCHAIN_LOCATORS = Object.freeze(KEYCHAIN_DEFINITIONS.map((definition) =>
  Object.freeze({
    ...definition,
    locator: Object.freeze({
      reference: definition.reference,
      ...parseAdminKeySecretReference(definition.reference),
    }),
    locator_sha256: sha256(definition.reference),
  })));
const KEYCHAIN_DELETE_AUTHORIZATIONS = new WeakMap();
const KEYCHAIN_CLOSEOUT_ADAPTERS = new WeakMap();
const A17_LIVE_K0_CAPABILITIES = new WeakMap();
const VERIFIED_CLOSEOUT_EVIDENCE = new WeakMap();
const MAX_FIXED_RECEIPT_BYTES = 64 * 1024 * 1024;
const MAX_EXPLICIT_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 10_000;
const MAX_ARTIFACT_DEPTH = 32;
const MAX_SEMANTIC_JSON_BYTES = 64 * 1024 * 1024;
const ENCRYPTED_PROVENANCE_ARTIFACT = ".brain-recovery-export.sql.fbrenc";
export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES = Object.freeze([
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_preflight,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_phase,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_manifest,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_journal,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_preflight,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_phase,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_manifest,
  DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_journal,
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.source_preflight,
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.source_phase,
  DISPOSABLE_RECOVERY_SOURCE_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.target_preflight,
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.target_phase,
  DISPOSABLE_RECOVERY_TARGET_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.seed,
  DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_ABSENT_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_PREVIEW_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_TEARDOWN_ABSENT_PREVIEW_NAME,
]);
export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EXPLICIT_EVIDENCE_ROLES = Object.freeze([
  "source_manifest",
  "target_manifest",
  "plan",
  "state",
  "wrangler_wrapper",
  "golden",
  "field_receipt",
  "package",
]);

export class DisposableRecoveryFieldCloseoutError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldCloseoutError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldCloseoutError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields) {
  return plainObject(value) && Object.keys(value).sort().join("\0") ===
    [...fields].sort().join("\0");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function markerSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
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

function immutable(value) {
  const copy = structuredClone(value);
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    Object.freeze(entry);
    for (const child of Object.values(entry)) freeze(child);
    return entry;
  };
  return freeze(copy);
}

function sameStableFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink &&
    left.mode === right.mode && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertOwned(info) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
}

function transientEvidenceName(value) {
  return isRecoveryArtifactResiduePathComponent(value);
}

function assertNoTransientPathComponents(path) {
  if (hasRecoveryArtifactResiduePathComponent(path)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
}

function checkedPrivateDirectory(path, { runAclInspection } = {}) {
  const absolute = resolve(path);
  let info;
  try {
    assertNoTransientPathComponents(absolute);
    info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        realpathSync(absolute) !== absolute || (info.mode & 0o077) !== 0) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    assertOwned(info);
    info = assertNoDarwinReceiptAcl(absolute, info, {
      code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID",
      ...(runAclInspection ? { run: runAclInspection } : {}),
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  return Object.freeze({ path: absolute, info });
}

function hashStablePrivateFile(path, {
  maxBytes,
  parseJson = false,
  runAclInspection,
} = {}) {
  const absolute = resolve(path);
  let before;
  let descriptor;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash("sha256");
  const captured = [];
  let capturedBuffer;
  let bytes = 0;
  try {
    assertNoTransientPathComponents(absolute);
    before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        !Number.isSafeInteger(before.size) || before.size < 1 ||
        before.size > maxBytes || realpathSync(absolute) !== absolute ||
        (before.mode & 0o077) !== 0) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    assertOwned(before);
    before = assertNoDarwinReceiptAcl(absolute, before, {
      code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID",
      ...(runAclInspection ? { run: runAclInspection } : {}),
    });
    descriptor = openSync(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameStableFile(opened, before)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      hash.update(buffer.subarray(0, count));
      if (parseJson) captured.push(Buffer.from(buffer.subarray(0, count)));
    }
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(absolute);
    if (bytes !== before.size || !sameStableFile(openedAfter, before) ||
        !sameStableFile(after, before) || realpathSync(absolute) !== absolute) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_CHANGED");
    }
    const sha256Value = hash.digest("hex");
    if (!parseJson) return Object.freeze({ bytes, sha256: sha256Value });
    let value;
    try {
      capturedBuffer = Buffer.concat(captured, bytes);
      value = JSON.parse(capturedBuffer.toString("utf8"));
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    return Object.freeze({ bytes, sha256: sha256Value, value });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  } finally {
    buffer.fill(0);
    if (capturedBuffer) capturedBuffer.fill(0);
    for (const chunk of captured) chunk.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* a failed read is already refused */ }
    }
  }
}

function checkedArtifactDirectory(path, { runAclInspection } = {}) {
  const root = checkedPrivateDirectory(path, { runAclInspection });
  const directorySnapshots = [];
  const items = [];
  let totalBytes = 0;
  const visit = (directory, depth) => {
    if (depth > MAX_ARTIFACT_DEPTH) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    const checkedDirectory = checkedPrivateDirectory(directory, { runAclInspection });
    const rootRelative = relative(root.path, checkedDirectory.path);
    if (rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    directorySnapshots.push(checkedDirectory);
    let entries;
    try {
      entries = readdirSync(checkedDirectory.path, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." ||
          /[\u0000-\u001f\u007f]/u.test(entry.name) ||
          transientEvidenceName(entry.name)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      const candidate = join(checkedDirectory.path, entry.name);
      let info;
      try { info = lstatSync(candidate); } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_CHANGED");
      }
      if (info.isSymbolicLink()) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      if (info.isDirectory()) {
        visit(candidate, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      const relativeName = relative(root.path, candidate).split(sep).join("/");
      if (!relativeName || relativeName.startsWith("../") ||
          relativeName.split("/").some((part) =>
            !part || part === "." || part === "..")) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      const hashed = hashStablePrivateFile(candidate, {
        maxBytes: MAX_ARTIFACT_FILE_BYTES,
        runAclInspection,
      });
      totalBytes += hashed.bytes;
      if (items.length >= MAX_ARTIFACT_FILES ||
          !Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      items.push(Object.freeze({ relative_name: relativeName, ...hashed }));
    }
  };
  visit(root.path, 0);
  items.sort((left, right) => left.relative_name.localeCompare(right.relative_name));
  for (const snapshot of directorySnapshots) {
    const current = checkedPrivateDirectory(snapshot.path, { runAclInspection });
    if (!sameStableFile(current.info, snapshot.info)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_CHANGED");
    }
  }
  if (!items.some((entry) =>
    entry.relative_name === ENCRYPTED_PROVENANCE_ARTIFACT)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  return Object.freeze({
    path_sha256: sha256(root.path),
    items,
    encrypted_provenance_artifact_present: true,
  });
}

function keychainPreparationData(value, binding, accountFingerprint, {
  allowMethods = false,
} = {}) {
  const fields = [
    "schema_version", "protocol", "receipt_sha256", "preparation_fingerprint",
    "account_fingerprint", "campaign_keychain_locator_sha256",
    "campaign_keychain_value_sha256", "campaign_items", "keychain_binding_sha256",
  ];
  const allowed = new Set([
    ...fields,
    ...(allowMethods ? [
      "campaign_keychain_status", "revalidate", "revalidateReceipt", "verifyItem",
    ] : []),
  ]);
  if (!plainObject(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
      fields.some((field) => !(field in value)) ||
      value.schema_version !== 1 ||
      value.protocol !== DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL ||
      !SHA256_RE.test(String(accountFingerprint || "")) ||
      value.account_fingerprint !== accountFingerprint ||
      [value.receipt_sha256, value.preparation_fingerprint,
        value.keychain_binding_sha256].some((hash) =>
        !SHA256_RE.test(String(hash || ""))) ||
      !Array.isArray(value.campaign_keychain_locator_sha256) ||
      !Array.isArray(value.campaign_keychain_value_sha256) ||
      !Array.isArray(value.campaign_items) ||
      value.campaign_keychain_locator_sha256.length !== KEYCHAIN_LOCATORS.length ||
      value.campaign_keychain_value_sha256.length !== KEYCHAIN_LOCATORS.length ||
      value.campaign_items.length !== KEYCHAIN_LOCATORS.length ||
      new Set(value.campaign_keychain_value_sha256).size !== KEYCHAIN_LOCATORS.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  const items = [];
  for (let index = 0; index < KEYCHAIN_LOCATORS.length; index += 1) {
    const expected = KEYCHAIN_LOCATORS[index];
    const item = value.campaign_items[index];
    if (!exactKeys(item, ["purpose", "format", "locator_sha256", "value_sha256"]) ||
        item.purpose !== expected.purpose || item.format !== expected.format ||
        item.locator_sha256 !== expected.locator_sha256 ||
        item.value_sha256 !== value.campaign_keychain_value_sha256[index] ||
        value.campaign_keychain_locator_sha256[index] !== expected.locator_sha256 ||
        !SHA256_RE.test(String(item.value_sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
    }
    items.push(immutable(item));
  }
  const expectedPreparationFingerprint = sha256(canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PROTOCOL,
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    account_fingerprint: accountFingerprint,
    campaign_keychain_locator_sha256:
      KEYCHAIN_LOCATORS.map((entry) => entry.locator_sha256),
  }));
  const data = immutable({
    schema_version: 1,
    protocol: value.protocol,
    receipt_sha256: value.receipt_sha256,
    preparation_fingerprint: value.preparation_fingerprint,
    account_fingerprint: value.account_fingerprint,
    campaign_keychain_locator_sha256: [...value.campaign_keychain_locator_sha256],
    campaign_keychain_value_sha256: [...value.campaign_keychain_value_sha256],
    campaign_items: items,
    keychain_binding_sha256: value.keychain_binding_sha256,
  });
  const bindingBase = {
    schema_version: data.schema_version,
    protocol: data.protocol,
    receipt_sha256: data.receipt_sha256,
    preparation_fingerprint: data.preparation_fingerprint,
    account_fingerprint: data.account_fingerprint,
    campaign_keychain_locator_sha256: data.campaign_keychain_locator_sha256,
    campaign_keychain_value_sha256: data.campaign_keychain_value_sha256,
    campaign_items: data.campaign_items,
  };
  if (data.preparation_fingerprint !== expectedPreparationFingerprint ||
      data.keychain_binding_sha256 !== binding.keychain_binding_sha256 ||
      data.keychain_binding_sha256 !== sha256(canonical(bindingBase))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  return data;
}

function checkedProvisionKeychainBindings(value, keychainPreparation) {
  if (!exactKeys(value, ["source", "target"])) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PROVISION_K0_INVALID");
  }
  const expected = {
    keychain_prep_receipt_sha256: keychainPreparation.receipt_sha256,
    keychain_preparation_fingerprint: keychainPreparation.preparation_fingerprint,
    keychain_account_fingerprint: keychainPreparation.account_fingerprint,
    campaign_keychain_items: keychainPreparation.campaign_items,
    keychain_binding_sha256: keychainPreparation.keychain_binding_sha256,
  };
  for (const role of ["source", "target"]) {
    if (!exactKeys(value[role], Object.keys(expected)) ||
        canonical(value[role]) !== canonical(expected)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PROVISION_K0_INVALID");
    }
  }
  return immutable(value);
}

function checkedRetainedEvidence(value, checked) {
  if (!exactKeys(value, ["inventory", "inventory_sha256"]) ||
      !exactKeys(value.inventory, [
        "schema_version", "kind", "receipt_directory", "explicit_files",
        "artifact_directory",
      ]) ||
      value.inventory.schema_version !== 1 ||
      value.inventory.kind !== "v048_disposable_retained_evidence_inventory" ||
      !SHA256_RE.test(String(value.inventory_sha256 || "")) ||
      value.inventory_sha256 !== sha256(canonical(value.inventory))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const receiptDirectory = value.inventory.receipt_directory;
  if (!exactKeys(receiptDirectory, [
    "path_sha256", "items", "k0_reset_receipts", "k0_reset_journals",
  ]) ||
      !SHA256_RE.test(String(receiptDirectory.path_sha256 || "")) ||
      !Array.isArray(receiptDirectory.items) ||
      receiptDirectory.items.length !==
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const fixedHashExpectations = new Map([
    [DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
      checked.keychainPreparation.receipt_sha256],
    [DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_phase,
      checked.source.value.binding.provision_receipt_sha256],
    [DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_manifest,
      checked.source.value.binding.provision_manifest_sha256],
    [DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_phase,
      checked.target.value.binding.provision_receipt_sha256],
    [DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_manifest,
      checked.target.value.binding.provision_manifest_sha256],
    [DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME, checked.targetEval.sha256],
    [DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME, checked.source.sha256],
    [DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME, checked.target.sha256],
  ]);
  let receiptBytes = 0;
  for (let index = 0;
    index < DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES.length;
    index += 1) {
    const item = receiptDirectory.items[index];
    if (!exactKeys(item, ["name", "bytes", "sha256"]) ||
        item.name !==
          DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES[index] ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        item.bytes > 64 * 1024 * 1024 ||
        !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    receiptBytes += item.bytes;
    if (!Number.isSafeInteger(receiptBytes) || receiptBytes > 512 * 1024 * 1024) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    const expected = fixedHashExpectations.get(item.name);
    if (expected !== undefined && item.sha256 !== expected) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
  }
  if (!Array.isArray(receiptDirectory.k0_reset_receipts) ||
      receiptDirectory.k0_reset_receipts.length > 256) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  let priorReset = null;
  for (const item of receiptDirectory.k0_reset_receipts) {
    if (!exactKeys(item, ["name", "bytes", "sha256"]) ||
        !K0_RESET_RECEIPT_RE.test(String(item.name || "")) ||
        (priorReset !== null && item.name.localeCompare(priorReset) <= 0) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        item.bytes > 64 * 1024 * 1024 ||
        !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    receiptBytes += item.bytes;
    if (!Number.isSafeInteger(receiptBytes) || receiptBytes > 512 * 1024 * 1024) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    priorReset = item.name;
  }
  if (!Array.isArray(receiptDirectory.k0_reset_journals) ||
      receiptDirectory.k0_reset_journals.length !==
        receiptDirectory.k0_reset_receipts.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
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
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    let journalBytes = 0;
    for (let eventIndex = 0; eventIndex < group.event_receipts.length;
      eventIndex += 1) {
      const event = group.event_receipts[eventIndex];
      const match = K0_RESET_JOURNAL_EVENT_RE.exec(String(event?.name || ""));
      if (!exactKeys(event, ["name", "bytes", "sha256"]) || !match ||
          match[1] !== verification.reservation_marker_sha256 ||
          Number.parseInt(match[2], 10) !== eventIndex ||
          journalNames.has(event.name) ||
          !Number.isSafeInteger(event.bytes) || event.bytes < 1 ||
          event.bytes >
            DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES ||
          event.sha256 !== verification.event_receipt_sha256[eventIndex]) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      journalNames.add(event.name);
      journalBytes += event.bytes;
      receiptBytes += event.bytes;
      if (!Number.isSafeInteger(journalBytes) ||
          !Number.isSafeInteger(receiptBytes) ||
          receiptBytes > 512 * 1024 * 1024) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
    }
    if (journalBytes !== verification.total_bytes ||
        group.event_receipts.at(-1)?.sha256 !==
          verification.final_event_sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
  }
  const explicitFiles = value.inventory.explicit_files;
  if (!Array.isArray(explicitFiles) ||
      explicitFiles.length !==
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EXPLICIT_EVIDENCE_ROLES.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const explicitHashExpectations = new Map([
    ["state", checked.binding.recovery_state_sha256],
    ["wrangler_wrapper", checked.source.value.binding.wrangler_wrapper_sha256],
    ["golden", checked.binding.golden_sha256],
    ["field_receipt", checked.binding.field_receipt_sha256],
    ["package", checked.binding.package_sha256],
  ]);
  const explicitPathHashes = new Set();
  for (let index = 0;
    index < DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EXPLICIT_EVIDENCE_ROLES.length;
    index += 1) {
    const item = explicitFiles[index];
    if (!exactKeys(item, ["role", "name", "path_sha256", "bytes", "sha256"]) ||
        item.role !==
          DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EXPLICIT_EVIDENCE_ROLES[index] ||
        !safeRelativeName(item.name, { basenameOnly: true }) ||
        !SHA256_RE.test(String(item.path_sha256 || "")) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        item.bytes > 16 * 1024 * 1024 * 1024 ||
        !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    if (explicitPathHashes.has(item.path_sha256)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    explicitPathHashes.add(item.path_sha256);
    const expected = explicitHashExpectations.get(item.role);
    if (expected !== undefined && item.sha256 !== expected) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
  }
  const artifactDirectory = value.inventory.artifact_directory;
  if (!exactKeys(artifactDirectory, [
    "path_sha256", "items", "encrypted_provenance_artifact_present",
  ]) || !SHA256_RE.test(String(artifactDirectory.path_sha256 || "")) ||
      artifactDirectory.encrypted_provenance_artifact_present !== true ||
      !Array.isArray(artifactDirectory.items) ||
      artifactDirectory.items.length < 1 || artifactDirectory.items.length > 10_000) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  let priorName = null;
  let encryptedArtifactSeen = false;
  let totalBytes = 0;
  for (const item of artifactDirectory.items) {
    if (!exactKeys(item, ["relative_name", "bytes", "sha256"]) ||
        !safeRelativeName(item.relative_name) ||
        (priorName !== null && item.relative_name.localeCompare(priorName) <= 0) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        !SHA256_RE.test(String(item.sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    priorName = item.relative_name;
    totalBytes += item.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 ** 3) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    if (item.relative_name === ".brain-recovery-export.sql.fbrenc") {
      encryptedArtifactSeen = true;
    }
  }
  if (!encryptedArtifactSeen) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  return immutable(value);
}

function exactCloseoutEvidencePaths(directory, options) {
  const fixedReceipts = Object.freeze(Object.fromEntries(
    DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES.map((name) => [
      name,
      join(directory, name),
    ]),
  ));
  return Object.freeze({
    fixedReceipts,
    targetEval: join(directory, DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME),
    sourceTeardown: join(directory, DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME),
    targetTeardown: join(directory, DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME),
    sourceProvision: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_phase,
    ),
    sourceProvisionManifest: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.source_manifest,
    ),
    targetProvision: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_phase,
    ),
    targetProvisionManifest: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES.target_manifest,
    ),
    deployment: join(
      directory,
      DISPOSABLE_RECOVERY_FIELD_DEPLOYMENT_RECEIPT_NAMES.target_phase,
    ),
    explicit: Object.freeze({
      source_manifest: resolve(options.sourceManifestPath),
      target_manifest: resolve(options.targetManifestPath),
      plan: resolve(options.planPath),
      state: resolve(options.statePath),
      wrangler_wrapper: resolve(options.wranglerWrapperPath),
      golden: resolve(options.goldenPath),
      field_receipt: resolve(options.fieldReceiptPath),
      package: resolve(options.packagePath),
    }),
    artifactDirectory: resolve(options.artifactDirectory),
  });
}

function hashMatchesItem(path, item, maxBytes = MAX_FIXED_RECEIPT_BYTES) {
  const current = hashStablePrivateFile(path, { maxBytes });
  if (current.bytes !== item.bytes || current.sha256 !== item.sha256) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_CHANGED");
  }
  return current;
}

async function buildPhysicalRetainedEvidence({
  binding,
  accountId,
  directory,
  paths,
  targetEval,
  source,
  target,
}) {
  const keychainPrepBinding = Object.freeze({
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    account_id: accountId,
  });
  let preparedReceiptCapability;
  try {
    preparedReceiptCapability = readDisposableRecoveryFieldKeychainPreparedReceipt({
      binding: keychainPrepBinding,
      receiptPath: paths.fixedReceipts[
        DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME
      ],
      expectedReceiptDirectory: directory,
    });
    assertDisposableRecoveryFieldKeychainPreparedReceiptCapability(
      preparedReceiptCapability,
      keychainPrepBinding,
      binding.keychain_binding_sha256,
    );
    if (await preparedReceiptCapability.revalidateReceipt() !== true) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
    }
    assertDisposableRecoveryFieldKeychainPreparedReceiptCapability(
      preparedReceiptCapability,
      keychainPrepBinding,
      binding.keychain_binding_sha256,
    );
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  const keychainPreparation = keychainPreparationData(
    preparedReceiptCapability,
    binding,
    sha256(accountId),
    { allowMethods: true },
  );
  const checkedDirectory = checkedPrivateDirectory(directory);
  const receiptItems = DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES
    .map((name) => Object.freeze({
      name,
      ...hashStablePrivateFile(paths.fixedReceipts[name], {
        maxBytes: MAX_FIXED_RECEIPT_BYTES,
      }),
    }));
  let directoryEntries;
  try {
    directoryEntries = readdirSync(checkedDirectory.path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  if (directoryEntries.some((entry) => transientEvidenceName(entry.name))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const resetPattern = new RegExp(
    `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX}` +
      `[a-f0-9]{64}\\.json$`,
    "u",
  );
  const resetNames = directoryEntries
    .filter((entry) => resetPattern.test(entry.name))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      return entry.name;
    });
  if (resetNames.length > 256) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const resetJournalEntries = directoryEntries
    .filter((entry) => entry.name.startsWith(
      DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX,
    ))
    .map((entry) => {
      const match = K0_RESET_JOURNAL_EVENT_RE.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      return Object.freeze({
        name: entry.name,
        reservationMarkerSha256: match[1],
        eventIndex: Number.parseInt(match[2], 10),
      });
    });
  const consumedResetJournalNames = new Set();
  const k0ResetReceipts = [];
  const k0ResetJournals = [];
  for (const name of resetNames) {
    const resetPath = join(directory, name);
    const loaded = hashStablePrivateFile(resetPath, {
      maxBytes: MAX_FIXED_RECEIPT_BYTES,
      parseJson: true,
    });
    let verification;
    try {
      assertDisposableRecoveryFieldKeychainResetAuthorizationReceipt({
        receipt: loaded.value,
        binding: keychainPrepBinding,
        receiptPath: paths.fixedReceipts[
          DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME
        ],
        expectedReceiptDirectory: directory,
      });
      verification = verifyDisposableRecoveryFieldKeychainResetJournal({
        binding: keychainPrepBinding,
        resetReceiptPath: resetPath,
        expectedReceiptDirectory: directory,
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    if (name !== `${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX}` +
          `${verification.reservation_marker_sha256}.json` ||
        verification.reset_authorization_receipt_sha256 !== loaded.sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    const matchingEvents = resetJournalEntries
      .filter((entry) => entry.reservationMarkerSha256 ===
        verification.reservation_marker_sha256)
      .sort((left, right) => left.eventIndex - right.eventIndex);
    if (matchingEvents.length !== verification.event_count ||
        matchingEvents.some((entry, index) => entry.eventIndex !== index)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    const eventReceipts = matchingEvents.map((entry, index) => {
      const event = Object.freeze({
        name: entry.name,
        ...hashStablePrivateFile(join(directory, entry.name), {
          maxBytes: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
        }),
      });
      if (event.sha256 !== verification.event_receipt_sha256[index] ||
          consumedResetJournalNames.has(entry.name)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
      consumedResetJournalNames.add(entry.name);
      return event;
    });
    if (eventReceipts.reduce((total, item) => total + item.bytes, 0) !==
          verification.total_bytes ||
        eventReceipts.at(-1)?.sha256 !== verification.final_event_sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    k0ResetReceipts.push(Object.freeze({
      name,
      bytes: loaded.bytes,
      sha256: loaded.sha256,
    }));
    k0ResetJournals.push(Object.freeze({
      reset_receipt_name: name,
      verification: immutable(verification),
      event_receipts: Object.freeze(eventReceipts),
    }));
  }
  if (consumedResetJournalNames.size !== resetJournalEntries.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const retainedReceiptBytes = [
    ...receiptItems,
    ...k0ResetReceipts,
    ...k0ResetJournals.flatMap((entry) => entry.event_receipts),
  ].reduce((total, item) => total + item.bytes, 0);
  if (!Number.isSafeInteger(retainedReceiptBytes) ||
      retainedReceiptBytes > 512 * 1024 * 1024) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const retainedNames = new Set(
    DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_RECEIPT_NAMES,
  );
  for (const item of k0ResetReceipts) retainedNames.add(item.name);
  for (const item of k0ResetJournals.flatMap((entry) => entry.event_receipts)) {
    retainedNames.add(item.name);
  }
  const closurePath = join(directory, DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME);
  const operationalNames = new Set([
    DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
    basename(privateAggregateReceiptPendingPath(closurePath)),
    basename(privateAggregateReceiptStagedPath(closurePath)),
    basename(privateAggregateReceiptCommitPath(closurePath)),
    DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
    DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
  ]);
  const allowedNames = new Set([
    ...retainedNames,
    ...operationalNames,
  ]);
  for (const entry of directoryEntries) {
    if (!allowedNames.has(entry.name) || transientEvidenceName(entry.name) ||
        !entry.isFile() || entry.isSymbolicLink()) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
    }
    if (operationalNames.has(entry.name)) {
      let info;
      const operationalPath = join(directory, entry.name);
      try {
        info = lstatSync(operationalPath);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
            info.size > MAX_FIXED_RECEIPT_BYTES ||
            realpathSync(operationalPath) !== operationalPath ||
            (info.mode & 0o077) !== 0) {
          refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
        }
        assertOwned(info);
        assertNoDarwinReceiptAcl(operationalPath, info, {
          code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID",
        });
      } catch (error) {
        if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
      }
    }
  }
  const planRead = hashStablePrivateFile(paths.explicit.plan, {
    maxBytes: MAX_SEMANTIC_JSON_BYTES,
    parseJson: true,
  });
  const stateRead = hashStablePrivateFile(paths.explicit.state, {
    maxBytes: MAX_SEMANTIC_JSON_BYTES,
    parseJson: true,
  });
  let plan;
  let state;
  try {
    plan = validateVerifiedRecoveryPlan(planRead.value);
    state = validateVerifiedRecoveryState(stateRead.value, plan);
    inspectVerifiedRecoveryManifestBindings(
      plan,
      paths.explicit.source_manifest,
      paths.explicit.target_manifest,
    );
  } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const semanticReads = new Map([
    ["plan", planRead],
    ["state", stateRead],
  ]);
  const explicitFiles = DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EXPLICIT_EVIDENCE_ROLES
    .map((role) => {
      const path = paths.explicit[role];
      const read = semanticReads.get(role);
      const hashed = read
        ? { bytes: read.bytes, sha256: read.sha256 }
        : hashStablePrivateFile(path, { maxBytes: MAX_EXPLICIT_FILE_BYTES });
      return Object.freeze({
        role,
        name: basename(path),
        path_sha256: sha256(path),
        ...hashed,
      });
    });
  const artifactInventory = checkedArtifactDirectory(paths.artifactDirectory);
  const encryptedArtifact = artifactInventory.items.find((entry) =>
    entry.relative_name === ENCRYPTED_PROVENANCE_ARTIFACT);
  const exported = state.completed.find((entry) => entry.id === "export_d1")?.evidence;
  const verifiedExport = state.completed.find((entry) =>
    entry.id === "verify_export")?.evidence;
  if (plan.plan_fingerprint !== binding.recovery_plan_fingerprint ||
      stateRead.sha256 !== binding.recovery_state_sha256 ||
      state.status !== "complete" ||
      !exported || !verifiedExport ||
      exported.artifact_sha256 !== verifiedExport.artifact_sha256 ||
      exported.artifact_bytes !== verifiedExport.artifact_bytes ||
      encryptedArtifact?.sha256 !== exported.artifact_sha256 ||
      encryptedArtifact?.bytes !== exported.artifact_bytes) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID");
  }
  const finalDirectory = checkedPrivateDirectory(directory);
  let finalEntries;
  try {
    finalEntries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_CHANGED");
  }
  if (!sameStableFile(checkedDirectory.info, finalDirectory.info) ||
      canonical(finalEntries.map((entry) => entry.name)) !==
        canonical(directoryEntries.map((entry) => entry.name)) ||
      finalEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink() ||
        transientEvidenceName(entry.name))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_CHANGED");
  }
  for (const item of receiptItems) {
    hashMatchesItem(paths.fixedReceipts[item.name], item);
  }
  for (const item of k0ResetReceipts) {
    hashMatchesItem(join(directory, item.name), item);
  }
  for (const group of k0ResetJournals) {
    for (const item of group.event_receipts) {
      hashMatchesItem(
        join(directory, item.name),
        item,
        DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
      );
    }
  }
  for (const item of explicitFiles) {
    hashMatchesItem(paths.explicit[item.role], item, MAX_EXPLICIT_FILE_BYTES);
  }
  if (canonical(checkedArtifactDirectory(paths.artifactDirectory)) !==
      canonical(artifactInventory)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_CHANGED");
  }
  try {
    if (await preparedReceiptCapability.revalidateReceipt() !== true) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
    }
    assertDisposableRecoveryFieldKeychainPreparedReceiptCapability(
      preparedReceiptCapability,
      keychainPrepBinding,
      binding.keychain_binding_sha256,
    );
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
  }
  const inventory = immutable({
    schema_version: 1,
    kind: "v048_disposable_retained_evidence_inventory",
    receipt_directory: {
      path_sha256: sha256(directory),
      items: receiptItems,
      k0_reset_receipts: k0ResetReceipts,
      k0_reset_journals: k0ResetJournals,
    },
    explicit_files: explicitFiles,
    artifact_directory: artifactInventory,
  });
  const retainedEvidence = checkedRetainedEvidence(
    { inventory, inventory_sha256: sha256(canonical(inventory)) },
    { binding, keychainPreparation, targetEval, source, target },
  );
  return Object.freeze({
    retainedEvidence,
    keychainPreparation,
    preparedReceiptCapability,
    keychainPrepBinding,
  });
}

function provisionKeychainProjection(provision) {
  const binding = provision.receipt.binding;
  return immutable({
    keychain_prep_receipt_sha256: binding.keychain_prep_receipt_sha256,
    keychain_preparation_fingerprint: binding.keychain_preparation_fingerprint,
    keychain_account_fingerprint: binding.keychain_account_fingerprint,
    campaign_keychain_items: binding.campaign_keychain_items,
    keychain_binding_sha256: binding.keychain_binding_sha256,
  });
}

function exactTeardownBinding(binding, provision, role, wrapperSha256, targetEvalSha256) {
  return immutable({
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    keychain_binding_sha256: binding.keychain_binding_sha256,
    campaign_fingerprint: binding.campaign_fingerprint,
    plan_fingerprint: binding.recovery_plan_fingerprint,
    resource_fingerprint: binding[`${role}_resource_fingerprint`],
    wrangler_wrapper_sha256: wrapperSha256,
    provision_receipt_sha256: provision.receiptSha256,
    provision_manifest_sha256: provision.manifestSha256,
    target_eval_receipt_sha256: targetEvalSha256,
  });
}

async function readCloseoutEvidenceSnapshot(options) {
  const required = [
    "accountId", "expectedReceiptDirectory",
    "sourceManifestPath", "targetManifestPath", "planPath", "statePath",
    "artifactDirectory", "wranglerWrapperPath", "goldenPath",
    "fieldReceiptPath", "packagePath",
  ];
  if (!exactKeys(options, required)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const accountId = String(options.accountId || "").toLowerCase();
  if (!ACCOUNT_ID_RE.test(accountId)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const directory = checkedPrivateDirectory(options.expectedReceiptDirectory).path;
  const paths = exactCloseoutEvidencePaths(directory, options);
  const planRead = hashStablePrivateFile(paths.explicit.plan, {
    maxBytes: MAX_SEMANTIC_JSON_BYTES,
    parseJson: true,
  });
  let plan;
  let manifestBindings;
  let sourceProvision;
  let targetProvision;
  let a12;
  try {
    plan = validateVerifiedRecoveryPlan(planRead.value);
    manifestBindings = inspectVerifiedRecoveryManifestBindings(
      plan,
      paths.explicit.source_manifest,
      paths.explicit.target_manifest,
    );
    sourceProvision = readDisposableRecoveryTeardownProvisionArtifacts({
      receiptPath: paths.sourceProvision,
      manifestPath: paths.sourceProvisionManifest,
      expectedReceiptDirectory: directory,
      role: "source",
    });
    targetProvision = readDisposableRecoveryTeardownProvisionArtifacts({
      receiptPath: paths.targetProvision,
      manifestPath: paths.targetProvisionManifest,
      expectedReceiptDirectory: directory,
      role: "target",
    });
    assertDisposableRecoveryTeardownProvisionArtifactsCapability(sourceProvision);
    assertDisposableRecoveryTeardownProvisionArtifactsCapability(targetProvision);
    a12 = readDisposableRecoveryTeardownA12Evidence({
      targetEvalReceiptPath: paths.targetEval,
      statePath: paths.explicit.state,
      goldenPath: paths.explicit.golden,
      deploymentReceiptPath: paths.deployment,
      expectedReceiptDirectory: directory,
      plan,
    });
    assertDisposableRecoveryTeardownA12EvidenceCapability(a12);
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  if (sourceProvision.accountId !== accountId ||
      targetProvision.accountId !== accountId ||
      sourceProvision.accountId !== targetProvision.accountId ||
      sourceProvision.accountId !== manifestBindings.source.accountId ||
      targetProvision.accountId !== manifestBindings.target.accountId ||
      sourceProvision.databaseId !== manifestBindings.source.databaseId ||
      targetProvision.databaseId !== manifestBindings.target.databaseId ||
      sourceProvision.resourceName !== manifestBindings.source.workerName ||
      targetProvision.resourceName !== manifestBindings.target.workerName) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const targetEvalLoaded = a12.target_eval_receipt;
  let binding;
  try {
    binding = assertDisposableRecoveryTargetEvalBinding(
      targetEvalLoaded.value.binding,
    );
    assertDisposableRecoveryTargetEvalReceipt(targetEvalLoaded.value, binding);
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const provisionOverlap = [
    "candidate_sha", "candidate_tree_sha", "package_sha256",
    "field_receipt_sha256", "keychain_binding_sha256",
  ];
  if (plan.plan_fingerprint !== binding.recovery_plan_fingerprint ||
      plan.source_resource_fingerprint !== binding.source_resource_fingerprint ||
      plan.target_resource_fingerprint !== binding.target_resource_fingerprint ||
      a12.state_sha256 !== binding.recovery_state_sha256 ||
      a12.golden_sha256 !== binding.golden_sha256 ||
      a12.active_worker_version_id !== binding.active_worker_version_id ||
      [sourceProvision, targetProvision].some((provision) =>
        provisionOverlap.some((field) =>
          provision.receipt.binding[field] !== binding[field]))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const wrapper = hashStablePrivateFile(paths.explicit.wrangler_wrapper, {
    maxBytes: MAX_EXPLICIT_FILE_BYTES,
  });
  let sourceLoaded;
  let targetLoaded;
  let source;
  let target;
  try {
    sourceLoaded = readPrivateAggregateReceipt(paths.sourceTeardown, {
      code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID",
    });
    source = assertDisposableRecoveryBrainTeardownReceipt(sourceLoaded.value, {
      role: "source",
      expectedBinding: exactTeardownBinding(
        binding,
        sourceProvision,
        "source",
        wrapper.sha256,
        targetEvalLoaded.sha256,
      ),
      expectedSourceTeardownReceiptSha256: null,
    });
    targetLoaded = readPrivateAggregateReceipt(paths.targetTeardown, {
      code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID",
    });
    target = assertDisposableRecoveryBrainTeardownReceipt(targetLoaded.value, {
      role: "target",
      expectedBinding: exactTeardownBinding(
        binding,
        targetProvision,
        "target",
        wrapper.sha256,
        targetEvalLoaded.sha256,
      ),
      expectedSourceTeardownReceiptSha256: sourceLoaded.sha256,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const chronology = [
    sourceProvision.completedAt,
    targetProvision.completedAt,
    a12.deployment_completed_at,
    a12.state_updated_at,
    targetEvalLoaded.value.completed_at,
    source.started_at,
    source.completed_at,
    target.started_at,
    target.completed_at,
  ].map((value) => Date.parse(value));
  if (chronology.some((value) => !Number.isFinite(value)) ||
      chronology.some((value, index) => index > 0 && value < chronology[index - 1])) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CHRONOLOGY_INVALID");
  }
  const targetEval = immutable({
    value: targetEvalLoaded.value,
    sha256: targetEvalLoaded.sha256,
  });
  const sourceEvidence = immutable({ value: source, sha256: sourceLoaded.sha256 });
  const targetEvidence = immutable({ value: target, sha256: targetLoaded.sha256 });
  const physical = await buildPhysicalRetainedEvidence({
    binding,
    accountId,
    directory,
    paths,
    targetEval,
    source: sourceEvidence,
    target: targetEvidence,
  });
  const projection = immutable({
    binding,
    accountFingerprint: sha256(accountId),
    keychainPreparation: physical.keychainPreparation,
    provisionKeychainBindings: {
      source: provisionKeychainProjection(sourceProvision),
      target: provisionKeychainProjection(targetProvision),
    },
    retainedEvidence: physical.retainedEvidence,
    targetEvalReceipt: targetEval,
    sourceTeardownReceipt: sourceEvidence,
    targetTeardownReceipt: targetEvidence,
  });
  checkedProvisionKeychainBindings(
    projection.provisionKeychainBindings,
    projection.keychainPreparation,
  );
  return Object.freeze({
    projection,
    authority: Object.freeze({
      accountId,
      directory,
      paths,
      keychainPrepBinding: physical.keychainPrepBinding,
      preparedReceiptCapability: physical.preparedReceiptCapability,
    }),
  });
}

/**
 * Read every non-secret A17 authority from its fixed owner-private path and
 * mint an uncopyable capability whose private closure repeats those reads.
 */
export async function readDisposableRecoveryFieldCloseoutEvidence(options) {
  const readerOptions = immutable(options);
  const snapshot = await readCloseoutEvidenceSnapshot(readerOptions);
  const capability = snapshot.projection;
  const fingerprint = canonical(capability);
  VERIFIED_CLOSEOUT_EVIDENCE.set(capability, Object.freeze({
    fingerprint,
    readerOptions,
    authority: snapshot.authority,
    revalidate: async () => {
      try {
        const current = await readCloseoutEvidenceSnapshot(readerOptions);
        return canonical(current.projection) === fingerprint;
      } catch {
        return false;
      }
    },
  }));
  return capability;
}

function closeoutEvidenceProjection(checked) {
  return immutable({
    binding: checked.binding,
    accountFingerprint: checked.accountFingerprint,
    keychainPreparation: checked.keychainPreparation,
    provisionKeychainBindings: checked.provisionKeychainBindings,
    retainedEvidence: checked.retainedEvidence,
    targetEvalReceipt: checked.targetEval,
    sourceTeardownReceipt: checked.source,
    targetTeardownReceipt: checked.target,
  });
}

/** Require the exact reader-owned, still-current aggregate A17 capability. */
export async function assertDisposableRecoveryFieldCloseoutEvidenceCapability(
  capability,
) {
  const owned = VERIFIED_CLOSEOUT_EVIDENCE.get(capability);
  if (!owned || !Object.isFrozen(capability) ||
      canonical(capability) !== owned.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const current = await owned.revalidate();
  if (current !== true || canonical(capability) !== owned.fingerprint) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  return capability;
}

async function checkedEvidenceCapability(capability) {
  await assertDisposableRecoveryFieldCloseoutEvidenceCapability(capability);
  return immutable({
    binding: capability.binding,
    accountFingerprint: capability.accountFingerprint,
    keychainPreparation: capability.keychainPreparation,
    provisionKeychainBindings: capability.provisionKeychainBindings,
    retainedEvidence: capability.retainedEvidence,
    targetEval: capability.targetEvalReceipt,
    source: capability.sourceTeardownReceipt,
    target: capability.targetTeardownReceipt,
  });
}

function projectBrainTeardown(receipt) {
  return immutable({
    resource_fingerprint: receipt.resource_fingerprint,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    present_preview_sha256: receipt.present_preview_sha256,
    custody: receipt.custody,
    actions: receipt.actions,
    absent_preview_sha256: receipt.absent_preview_sha256,
    absence: receipt.absence,
  });
}

function expectedEvidence(checked, approvalFingerprint) {
  return immutable({
    target_eval_receipt_sha256: checked.targetEval.sha256,
    source_teardown_receipt_sha256: checked.source.sha256,
    target_teardown_receipt_sha256: checked.target.sha256,
    keychain_preparation: checked.keychainPreparation,
    retained_evidence: checked.retainedEvidence,
    a17_approval_fingerprint: approvalFingerprint,
  });
}

function absentCampaignItems() {
  return immutable(locatorProofs().map((entry) => ({
    locator_sha256: entry.locator_sha256,
    lookup: "item_not_found",
  })));
}

function closedReceiptValue({
  checked,
  approvalFingerprint,
  maintenanceWindow,
  completedAt,
  campaignItems,
  deletionJournal,
}) {
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_manual_teardown_closure",
    status: "closed",
    completed_at: completedAt,
    binding: checked.binding,
    evidence: expectedEvidence(checked, approvalFingerprint),
    maintenance_window: maintenanceWindow,
    ceremony_order: ["source", "target"],
    source: projectBrainTeardown(checked.source.value),
    target: projectBrainTeardown(checked.target.value),
    ambiguity: { unresolved_outcomes: 0 },
    keychain: {
      campaign_items: campaignItems,
      shared_test_token_lookup: { lookup: "succeeded", value_printed: false },
      deletion_journal: deletionJournal,
    },
  });
}

function locatorProofs() {
  return Object.freeze(KEYCHAIN_LOCATORS.map((entry) => Object.freeze({
    locator: entry.locator,
    locator_sha256: entry.locator_sha256,
    purpose: entry.purpose,
    format: entry.format,
  })));
}

function approvalFingerprintForChecked(checked) {
  return sha256(canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PROTOCOL,
    action: "A17",
    binding: checked.binding,
    target_eval_receipt_sha256: checked.targetEval.sha256,
    source_teardown_receipt_sha256: checked.source.sha256,
    target_teardown_receipt_sha256: checked.target.sha256,
    keychain_preparation: checked.keychainPreparation,
    retained_evidence: checked.retainedEvidence,
    campaign_keychain_locator_sha256: locatorProofs().map((entry) => entry.locator_sha256),
  }));
}

export async function disposableRecoveryFieldCloseoutApprovalFingerprint(
  evidenceCapability,
) {
  return approvalFingerprintForChecked(
    await checkedEvidenceCapability(evidenceCapability),
  );
}

function checkedKeychainPreparationRuntime(value, checked) {
  if (!value || typeof value.revalidate !== "function" ||
      typeof value.revalidateReceipt !== "function" ||
      typeof value.verifyItem !== "function" ||
      !Array.isArray(value.campaign_keychain_status) ||
      value.campaign_keychain_status.length !== KEYCHAIN_LOCATORS.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  const data = keychainPreparationData(
    value,
    checked.binding,
    checked.accountFingerprint,
    { allowMethods: true },
  );
  if (canonical(data) !== canonical(checked.keychainPreparation)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  for (let index = 0; index < KEYCHAIN_LOCATORS.length; index += 1) {
    const status = value.campaign_keychain_status[index];
    if (!exactKeys(status, ["purpose", "lookup"]) ||
        status.purpose !== KEYCHAIN_LOCATORS[index].purpose ||
        !["present", "item_not_found"].includes(status.lookup)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
    }
  }
  return value;
}

async function assertKeychainPreparationCurrent(preparation, {
  allValues = false,
  purpose = null,
} = {}) {
  try {
    const result = purpose === null
      ? await preparation[allValues ? "revalidate" : "revalidateReceipt"]()
      : await preparation.verifyItem(purpose);
    if (result !== true) refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
  }
}

function brandCloseoutKeychainAdapter(
  adapter,
  evidenceCapability,
  checked,
  liveK0,
  runtime,
) {
  const frozen = Object.freeze(adapter);
  KEYCHAIN_CLOSEOUT_ADAPTERS.set(frozen, Object.freeze({
    evidenceCapability,
    evidenceFingerprint: canonical(closeoutEvidenceProjection(checked)),
    liveK0,
    runtime,
  }));
  return frozen;
}

function assertCloseoutKeychainAdapter(adapter, evidenceCapability, checked) {
  const authority = KEYCHAIN_CLOSEOUT_ADAPTERS.get(adapter);
  if (!authority || !Object.isFrozen(adapter) ||
      authority.evidenceCapability !== evidenceCapability ||
      authority.evidenceFingerprint !== canonical(closeoutEvidenceProjection(checked)) ||
      A17_LIVE_K0_CAPABILITIES.get(authority.liveK0)?.evidenceCapability !==
        evidenceCapability) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  return authority;
}

async function inspectKeychain(adapter, { allowMissing, verifySharedToken = true }) {
  const proofs = [];
  for (const proof of locatorProofs()) {
    const status = await adapter.inspect(proof.locator);
    if (!["present", "item_not_found"].includes(status) ||
        !allowMissing && status !== "present") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_STATE_INVALID");
    }
    proofs.push(Object.freeze({ locator_sha256: proof.locator_sha256, lookup: status }));
  }
  if (verifySharedToken && await adapter.sharedTokenPresent() !== true) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_SHARED_TOKEN_MISSING");
  }
  return Object.freeze(proofs);
}

function deletedPrefixLength(items, { fresh }) {
  const states = items.map((entry) => entry.lookup);
  if (fresh) {
    if (states.some((state) => state !== "present")) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_STATE_INVALID");
    }
    return 0;
  }
  let prefix = 0;
  while (states[prefix] === "item_not_found") prefix += 1;
  if (states.slice(prefix).some((state) => state !== "present")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_PREFIX_INVALID");
  }
  return prefix;
}

function assertK0StatusMatches(preparation, items) {
  if (preparation.campaign_keychain_status.some((entry, index) =>
    entry.purpose !== KEYCHAIN_LOCATORS[index].purpose ||
    entry.lookup !== items[index]?.lookup)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
  }
}

/** Read-only local preview. No Keychain item is removed. */
export async function previewDisposableRecoveryFieldCloseout(options) {
  if (!exactKeys(options, ["evidenceCapability"])) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  const { evidenceCapability } = options;
  const {
    checked,
    keychain,
    preparedKeychain: prepared,
  } = await runtimeForEvidence(evidenceCapability);
  await assertKeychainPreparationCurrent(prepared, { allValues: true });
  await boundary(evidenceCapability, checked, prepared, keychain);
  const items = await inspectKeychain(keychain, { allowMissing: false });
  await boundary(evidenceCapability, checked, prepared, keychain);
  assertK0StatusMatches(prepared, items);
  deletedPrefixLength(items, { fresh: true });
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_closeout_preview",
    action: "A17",
    provider_mutation: false,
    keychain_mutation: false,
    retained_evidence_deleted: false,
    keychain_preparation: checked.keychainPreparation,
    retained_evidence: checked.retainedEvidence,
    campaign_items: items,
    shared_test_token_lookup: "succeeded",
    approval_fingerprint: approvalFingerprintForChecked(checked),
  });
}

function pendingMarker(checked, approvalFingerprint) {
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_closeout_pending",
    status: "keychain_cleanup_in_progress",
    binding: checked.binding,
    target_eval_receipt_sha256: checked.targetEval.sha256,
    source_teardown_receipt_sha256: checked.source.sha256,
    target_teardown_receipt_sha256: checked.target.sha256,
    keychain_preparation: checked.keychainPreparation,
    retained_evidence: checked.retainedEvidence,
    approval_fingerprint: approvalFingerprint,
    campaign_keychain_locator_sha256: locatorProofs().map((entry) => entry.locator_sha256),
  });
}

async function boundary(
  evidenceCapability,
  checked,
  keychainPreparation,
  keychain,
  reservation = null,
) {
  await assertDisposableRecoveryFieldCloseoutEvidenceCapability(
    evidenceCapability,
  );
  await assertKeychainPreparationCurrent(keychainPreparation);
  await assertDisposableRecoveryFieldCloseoutEvidenceCapability(
    evidenceCapability,
  );
  assertCloseoutKeychainAdapter(keychain, evidenceCapability, checked);
  if (reservation === null) return;
  try {
    validatePrivateAggregateReceiptReservation(reservation, {
      code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RESERVATION_CHANGED",
    });
  } catch { refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RESERVATION_CHANGED"); }
}

function outputContext(path, expectedDirectory) {
  let parent;
  try {
    parent = assertPrivateAggregateReceiptDirectory(
      realpathSync(resolve(expectedDirectory)),
      { code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PATH_INVALID" },
    );
  } catch { refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PATH_INVALID"); }
  const target = resolve(path);
  if (dirname(target) !== parent.path ||
      basename(target) !== DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PATH_INVALID");
  }
  return Object.freeze({
    path: target,
    pendingPath: privateAggregateReceiptPendingPath(target),
    stagedPath: privateAggregateReceiptStagedPath(target),
    commitPath: privateAggregateReceiptCommitPath(target),
    terminalAnchorPath: resolve(
      parent.path,
      DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
    ),
    deletionJournalPath: resolve(
      parent.path,
      DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
    ),
    parent,
  });
}

function deletionJournalBinding(marker, checked, approvalFingerprint) {
  return Object.freeze({
    a17_approval_fingerprint: approvalFingerprint,
    retained_evidence_inventory_sha256:
      checked.retainedEvidence.inventory_sha256,
    keychain_binding_sha256: checked.keychainPreparation.keychain_binding_sha256,
    reservation_marker_sha256: markerSha256(marker),
  });
}

function deletionJournalArguments(output, marker, checked, approvalFingerprint) {
  return Object.freeze({
    journalPath: output.deletionJournalPath,
    receiptPath: output.path,
    expectedReceiptDirectory: output.parent.path,
    expectedReceiptDirectoryInfo: output.parent.info,
    binding: deletionJournalBinding(marker, checked, approvalFingerprint),
  });
}

function analyzedDeletionJournal(
  records,
  output,
  marker,
  checked,
  approvalFingerprint,
) {
  try {
    return assertDisposableRecoveryFieldCloseoutDeletionJournalRecords({
      ...deletionJournalArguments(output, marker, checked, approvalFingerprint),
      records,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
}

function readDeletionJournal(output, marker, checked, approvalFingerprint, {
  allowAbsent = true,
} = {}) {
  try {
    return readDisposableRecoveryFieldCloseoutDeletionJournal({
      ...deletionJournalArguments(output, marker, checked, approvalFingerprint),
      allowAbsent,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
}

function appendDeletionJournal(
  output,
  records,
  itemIndex,
  state,
  marker,
  checked,
  approvalFingerprint,
  io,
) {
  try {
    return appendDisposableRecoveryFieldCloseoutDeletionJournal({
      ...deletionJournalArguments(output, marker, checked, approvalFingerprint),
      records,
      itemIndex,
      state,
      io,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
}

function assertCompleteDeletionJournal(output, marker, checked, approvalFingerprint) {
  const records = readDeletionJournal(output, marker, checked, approvalFingerprint, {
    allowAbsent: false,
  }).records;
  const state = analyzedDeletionJournal(
    records,
    output,
    marker,
    checked,
    approvalFingerprint,
  );
  if (state.completed !== KEYCHAIN_LOCATORS.length || state.pending !== null) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
  return records;
}

function checkedDeletionJournalEvidence(value, output) {
  if (!exactKeys(value, [
    "schema_version", "protocol", "path_sha256", "event_count",
    "head_sha256", "journal_sha256", "terminal_state",
  ]) || value.schema_version !== 1 ||
      value.protocol !== DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL ||
      value.path_sha256 !== sha256(output.deletionJournalPath) ||
      value.event_count !== KEYCHAIN_LOCATORS.length * 3 ||
      !SHA256_RE.test(String(value.head_sha256 || "")) ||
      !SHA256_RE.test(String(value.journal_sha256 || "")) ||
      value.terminal_state !== "all_campaign_items_confirmed_absent") {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
  return immutable(value);
}

function deletionJournalEvidence(output, marker, checked, approvalFingerprint) {
  try {
    const loaded = readDisposableRecoveryFieldCloseoutDeletionJournal({
      ...deletionJournalArguments(output, marker, checked, approvalFingerprint),
    });
    if (loaded.summary === null) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
    }
    return checkedDeletionJournalEvidence(loaded.summary, output);
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
}

function acceptedCompletedReceipt(
  value,
  checked,
  approvalFingerprint,
  output,
  expectedJournal = null,
) {
  const accepted = assertDisposableRecoveryManualTeardownClosure(
    value,
    checked.binding,
  );
  if (canonical(accepted.evidence) !==
        canonical(expectedEvidence(checked, approvalFingerprint)) ||
      canonical(accepted.source) !==
        canonical(projectBrainTeardown(checked.source.value)) ||
      canonical(accepted.target) !==
        canonical(projectBrainTeardown(checked.target.value)) ||
      canonical(checkedDeletionJournalEvidence(
        accepted.keychain.deletion_journal,
        output,
      )) !== canonical(expectedJournal ?? accepted.keychain.deletion_journal)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RECEIPT_INVALID");
  }
  return accepted;
}

function readCompleted(output, checked, approvalFingerprint, expectedJournal = null) {
  let loaded;
  try {
    loaded = readPrivateAggregateReceipt(output.path, {
      code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RECEIPT_INVALID",
    });
    acceptedCompletedReceipt(
      loaded.value,
      checked,
      approvalFingerprint,
      output,
      expectedJournal,
    );
  } catch { refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RECEIPT_INVALID"); }
  return Object.freeze({ receipt: loaded.value, receiptSha256: loaded.sha256 });
}

function terminalAnchorExpected(
  output,
  marker,
  checked,
  approvalFingerprint,
  receipt,
  terminalJournal,
) {
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if (bytes.length < 1 || bytes.length > 2 * 1024 * 1024) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
    }
    const finalReceiptSha256 = sha256(bytes);
    return disposableRecoveryFieldCloseoutTerminalAnchorValue({
      receiptPath: output.path,
      expectedReceiptDirectory: output.parent.path,
      reservationMarkerSha256: markerSha256(marker),
      finalReceiptSha256,
      finalReceiptBytes: bytes.length,
      finalizationCommitReceiptSha256:
        disposableRecoveryFieldCloseoutFinalizationCommitSha256({
          receiptPath: output.path,
          reservationMarkerSha256: markerSha256(marker),
          finalReceiptSha256,
          finalReceiptBytes: bytes.length,
        }),
      completedAt: receipt.completed_at,
      approvalFingerprint,
      retainedEvidenceInventorySha256:
        checked.retainedEvidence.inventory_sha256,
      keychainBindingSha256:
        checked.keychainPreparation.keychain_binding_sha256,
      terminalJournal,
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
  } finally {
    if (bytes) bytes.fill(0);
  }
}

function readTerminalCompleted(
  output,
  marker,
  checked,
  approvalFingerprint,
) {
  const journal = deletionJournalEvidence(
    output,
    marker,
    checked,
    approvalFingerprint,
  );
  const completed = readCompleted(
    output,
    checked,
    approvalFingerprint,
    journal,
  );
  const expectedAnchor = terminalAnchorExpected(
    output,
    marker,
    checked,
    approvalFingerprint,
    completed.receipt,
    journal,
  );
  let anchor;
  try {
    anchor = readDisposableRecoveryFieldCloseoutTerminalAnchor({
      receiptPath: output.path,
      expectedReceiptDirectory: output.parent.path,
      expected: expectedAnchor,
    });
    const journalAgain = deletionJournalEvidence(
      output,
      marker,
      checked,
      approvalFingerprint,
    );
    const completedAgain = readCompleted(
      output,
      checked,
      approvalFingerprint,
      journal,
    );
    const anchorAgain = readDisposableRecoveryFieldCloseoutTerminalAnchor({
      receiptPath: output.path,
      expectedReceiptDirectory: output.parent.path,
      expected: expectedAnchor,
    });
    if (canonical(journalAgain) !== canonical(journal) ||
        completedAgain.receiptSha256 !== completed.receiptSha256 ||
        anchorAgain.sha256 !== anchor.sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_COMPLETED_STATE_CHANGED");
    }
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
  }
  return Object.freeze({
    ...completed,
    terminalAnchorSha256: anchor.sha256,
  });
}

function checkedCompletionTime(now, checked, { notBefore = null } = {}) {
  let iso;
  try {
    const value = now();
    iso = (value instanceof Date ? value : new Date(value)).toISOString();
  } catch { refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLOCK_INVALID"); }
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) ||
      timestamp < Date.parse(checked.target.value.completed_at) ||
      (notBefore !== null && timestamp < Date.parse(notBefore))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLOCK_INVALID");
  }
  return iso;
}

function assertJournalMatchesKeychain(journalState, campaignState) {
  if (!journalState || !Array.isArray(campaignState) ||
      campaignState.length !== KEYCHAIN_LOCATORS.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
  for (let index = 0; index < KEYCHAIN_LOCATORS.length; index += 1) {
    let expected = "present";
    if (index < journalState.completed) expected = "item_not_found";
    if (journalState.pending?.itemIndex === index &&
        journalState.pending.state === "sent_unconfirmed") {
      expected = "item_not_found";
    }
    if (campaignState[index]?.lookup !== expected) {
      refuse(journalState.pending?.itemIndex === index &&
          journalState.pending.state === "sent_unconfirmed"
        ? "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_AMBIGUOUS"
        : "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_STATE_INVALID");
    }
  }
  return true;
}

/**
 * Remove the exact campaign-only Keychain items and write the final aggregate
 * teardown closure. `resume` is required after an interrupted reservation;
 * already absent fixed items are verified and never deleted a second time.
 */
export async function runDisposableRecoveryFieldCloseout(options) {
  const allowed = new Set(["evidenceCapability", "approvalFingerprint", "resume"]);
  if (!plainObject(options) ||
      !Object.hasOwn(options, "evidenceCapability") ||
      !Object.hasOwn(options, "approvalFingerprint") ||
      Object.keys(options).some((key) => !allowed.has(key)) ||
      (Object.hasOwn(options, "resume") && typeof options.resume !== "boolean")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_ARGUMENTS_INVALID");
  }
  const {
    evidenceCapability,
    approvalFingerprint,
    resume = false,
  } = options;
  const {
    checked,
    keychain,
    preparedKeychain,
    hooks,
  } = await runtimeForEvidence(evidenceCapability);
  const expectedApproval = approvalFingerprintForChecked(checked);
  if (approvalFingerprint !== expectedApproval) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_APPROVAL_INVALID");
  }
  if (typeof keychain.inspect !== "function" ||
      typeof keychain.authorizeDelete !== "function" ||
      typeof keychain.delete !== "function" ||
      typeof keychain.sharedTokenPresent !== "function" ||
      Object.hasOwn(keychain, "read")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  const evidenceAuthority = VERIFIED_CLOSEOUT_EVIDENCE.get(evidenceCapability);
  if (!evidenceAuthority) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID");
  }
  const output = outputContext(
    join(
      evidenceAuthority.authority.directory,
      DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
    ),
    evidenceAuthority.authority.directory,
  );
  const marker = pendingMarker(checked, expectedApproval);
  const checkedMaintenanceWindow = immutable({
    single_operator: true,
    other_actors_paused: true,
  });
  const presence = () => Object.freeze({
    main: existsSync(output.path),
    pending: existsSync(output.pendingPath),
    staged: existsSync(output.stagedPath),
    commit: existsSync(output.commitPath),
    anchor: existsSync(output.terminalAnchorPath),
    journal: existsSync(output.deletionJournalPath),
  });
  let initial = presence();
  const terminalMain = initial.main && !initial.pending &&
    !initial.staged && !initial.commit;

  if (terminalMain) {
    if (!initial.anchor || !initial.journal) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
    }
    await boundary(evidenceCapability, checked, preparedKeychain, keychain);
    readTerminalCompleted(
      output,
      marker,
      checked,
      expectedApproval,
    );
    const current = await inspectKeychain(keychain, { allowMissing: true });
    await boundary(evidenceCapability, checked, preparedKeychain, keychain);
    if (current.some((entry) => entry.lookup !== "item_not_found")) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_COMPLETED_STATE_CHANGED");
    }
    return readTerminalCompleted(
      output,
      marker,
      checked,
      expectedApproval,
    );
  }
  if (initial.anchor && !initial.main && !initial.pending &&
      !initial.staged && !initial.commit) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
  }
  if ((initial.staged || initial.commit) && !initial.anchor) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
  }
  const aggregateResidue = initial.main || initial.pending || initial.staged ||
    initial.commit || initial.anchor;
  if (initial.journal && !aggregateResidue) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
  if (initial.anchor && !initial.journal) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
  }
  if (aggregateResidue !== resume) {
    refuse(aggregateResidue
      ? "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RESUME_REQUIRED"
      : "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RESUME_INVALID");
  }

  await assertKeychainPreparationCurrent(preparedKeychain, { allValues: true });
  await boundary(evidenceCapability, checked, preparedKeychain, keychain);

  let journalRecords = [];
  let journalInfo = null;
  let journalState = Object.freeze({ completed: 0, pending: null });
  let terminalJournal = null;
  let anchoredReceipt = null;
  let anchoredValue = null;

  if (resume) {
    const loadedJournal = readDeletionJournal(
      output,
      marker,
      checked,
      expectedApproval,
      { allowAbsent: !initial.journal },
    );
    journalRecords = loadedJournal.records;
    journalInfo = loadedJournal.info;
    journalState = analyzedDeletionJournal(
      journalRecords,
      output,
      marker,
      checked,
      expectedApproval,
    );
    if (initial.anchor) {
      if (!initial.journal ||
          journalState.completed !== KEYCHAIN_LOCATORS.length ||
          journalState.pending !== null) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
      }
      terminalJournal = deletionJournalEvidence(
        output,
        marker,
        checked,
        expectedApproval,
      );
      let loadedAnchor;
      try {
        loadedAnchor = readDisposableRecoveryFieldCloseoutTerminalAnchor({
          receiptPath: output.path,
          expectedReceiptDirectory: output.parent.path,
        });
      } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
      }
      anchoredReceipt = closedReceiptValue({
        checked,
        approvalFingerprint: expectedApproval,
        maintenanceWindow: checkedMaintenanceWindow,
        completedAt: loadedAnchor.value.completed_at,
        campaignItems: absentCampaignItems(),
        deletionJournal: terminalJournal,
      });
      anchoredValue = terminalAnchorExpected(
        output,
        marker,
        checked,
        expectedApproval,
        anchoredReceipt,
        terminalJournal,
      );
      try {
        readDisposableRecoveryFieldCloseoutTerminalAnchor({
          receiptPath: output.path,
          expectedReceiptDirectory: output.parent.path,
          expected: anchoredValue,
        });
      } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
      }
    }
  }

  const validateTerminalAuthority = ({
    phase,
    finalReceipt,
    finalPath,
    pendingPath,
    stagedPath,
    commitPath,
  }) => {
    if (!["before_commit_guard_removal", "accept_terminal_final"].includes(phase) ||
        finalPath !== output.path || pendingPath !== output.pendingPath ||
        stagedPath !== output.stagedPath || commitPath !== output.commitPath ||
        finalReceipt?.path !== output.path ||
        finalReceipt?.parent?.path !== output.parent.path ||
        finalReceipt?.parent?.info?.dev !== output.parent.info.dev ||
        finalReceipt?.parent?.info?.ino !== output.parent.info.ino ||
        finalReceipt?.info?.nlink !== 1 ||
        (finalReceipt?.info?.mode & 0o077) !== 0) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
    }
    if (!anchoredReceipt || !anchoredValue ||
        canonical(finalReceipt?.value) !== canonical(anchoredReceipt) ||
        finalReceipt.sha256 !== anchoredValue.final_receipt_sha256 ||
        finalReceipt.info?.size !== anchoredValue.final_receipt_bytes) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
    }
    const journal = deletionJournalEvidence(
      output,
      marker,
      checked,
      expectedApproval,
    );
    if (canonical(journal) !== canonical(terminalJournal)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
    }
    readDisposableRecoveryFieldCloseoutTerminalAnchor({
      receiptPath: output.path,
      expectedReceiptDirectory: output.parent.path,
      expected: anchoredValue,
    });
    return true;
  };

  if (initial.anchor && (initial.staged || initial.commit)) {
    const absentBeforeRecovery = await inspectKeychain(keychain, {
      allowMissing: true,
    });
    await boundary(evidenceCapability, checked, preparedKeychain, keychain);
    if (absentBeforeRecovery.some((entry) =>
      entry.lookup !== "item_not_found")) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_COMPLETED_STATE_CHANGED");
    }
    deletionJournalEvidence(output, marker, checked, expectedApproval);
    readDisposableRecoveryFieldCloseoutTerminalAnchor({
      receiptPath: output.path,
      expectedReceiptDirectory: output.parent.path,
      expected: anchoredValue,
    });
    let recovered;
    try {
      recovered = recoverPrivateAggregateReceiptFinalization(
        output,
        marker,
        (candidate) => {
          acceptedCompletedReceipt(
            candidate,
            checked,
            expectedApproval,
            output,
            terminalJournal,
          );
          return canonical(candidate) === canonical(anchoredReceipt);
        },
        {
          code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_FINALIZATION_RECOVERY_FAILED",
          onFinalizationTransition: hooks.onFinalizationTransition,
          validateTerminalAuthority,
        },
      );
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_FINALIZATION_RECOVERY_FAILED");
    }
    await boundary(evidenceCapability, checked, preparedKeychain, keychain);
    if (recovered?.status !== "finalized") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_FINALIZATION_RECOVERY_FAILED");
    }
    initial = presence();
    if (!initial.main || initial.pending || initial.staged || initial.commit ||
        !initial.anchor || !initial.journal) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_FINALIZATION_RECOVERY_FAILED");
    }
    return readTerminalCompleted(output, marker, checked, expectedApproval);
  }

  let reservation;
  try {
    reservation = resume
      ? resumePrivateAggregateReceiptReservation(output, marker)
      : reservePrivateAggregateReceipt(
          assertPrivateAggregateOutputPath(output.path, {
            code: "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_PATH_INVALID",
          }),
          marker,
        );
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RESERVATION_INVALID");
  }

  await boundary(
    evidenceCapability,
    checked,
    preparedKeychain,
    keychain,
    reservation,
  );
  let campaignState = await inspectKeychain(keychain, {
    allowMissing: resume,
    verifySharedToken: false,
  });
  await boundary(
    evidenceCapability,
    checked,
    preparedKeychain,
    keychain,
    reservation,
  );
  assertK0StatusMatches(preparedKeychain, campaignState);
  if (resume) assertJournalMatchesKeychain(journalState, campaignState);
  else deletedPrefixLength(campaignState, { fresh: true });
  if (await keychain.sharedTokenPresent() !== true) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_SHARED_TOKEN_MISSING");
  }
  await boundary(
    evidenceCapability,
    checked,
    preparedKeychain,
    keychain,
    reservation,
  );

  if (journalState.pending?.state === "sent_unconfirmed") {
    const itemIndex = journalState.pending.itemIndex;
    const pendingLocator = KEYCHAIN_LOCATORS[itemIndex];
    const pendingState = await keychain.inspect(pendingLocator.locator);
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    if (pendingState !== "item_not_found") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_AMBIGUOUS");
    }
    const reconciled = appendDeletionJournal(
      output,
      journalRecords,
      itemIndex,
      "reconciled_absent",
      marker,
      checked,
      expectedApproval,
      {},
    );
    journalRecords = reconciled.records;
    journalInfo = reconciled.info;
    await hooks.onDeletionTransition(Object.freeze({
      state: "reconciled_absent",
      item_index: itemIndex,
      purpose: pendingLocator.purpose,
    }));
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    journalState = analyzedDeletionJournal(
      journalRecords,
      output,
      marker,
      checked,
      expectedApproval,
    );
  }

  const proofs = locatorProofs();
  for (let index = journalState.completed;
    index < proofs.length;
    index += 1) {
    const proof = proofs[index];
    const current = await keychain.inspect(proof.locator);
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    if (current !== "present") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_STATE_INVALID");
    }
    if (journalState.pending === null) {
      const planned = appendDeletionJournal(
        output,
        journalRecords,
        index,
        "planned",
        marker,
        checked,
        expectedApproval,
        {},
      );
      journalRecords = planned.records;
      journalInfo = planned.info;
      await hooks.onDeletionTransition(Object.freeze({
        state: "planned",
        item_index: index,
        purpose: proof.purpose,
      }));
      await boundary(
        evidenceCapability,
        checked,
        preparedKeychain,
        keychain,
        reservation,
      );
      journalState = analyzedDeletionJournal(
        journalRecords,
        output,
        marker,
        checked,
        expectedApproval,
      );
    }
    if (journalState.pending?.itemIndex !== index ||
        journalState.pending.state !== "planned") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
    }

    const presentAgain = await keychain.inspect(proof.locator);
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    if (presentAgain !== "present") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_STATE_INVALID");
    }
    const sent = appendDeletionJournal(
      output,
      journalRecords,
      index,
      "sent_unconfirmed",
      marker,
      checked,
      expectedApproval,
      {},
    );
    journalRecords = sent.records;
    journalInfo = sent.info;
    await hooks.onDeletionTransition(Object.freeze({
      state: "sent_unconfirmed",
      item_index: index,
      purpose: proof.purpose,
    }));
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );

    let deleteAuthorization;
    try {
      deleteAuthorization = await keychain.authorizeDelete(proof.locator);
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
    }
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    let immediateJournal;
    try {
      immediateJournal = readDisposableRecoveryFieldCloseoutDeletionJournal({
        ...deletionJournalArguments(
          output,
          marker,
          checked,
          expectedApproval,
        ),
        expectedJournalInfo: journalInfo,
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
    }
    if (canonical(immediateJournal.records) !== canonical(journalRecords) ||
        immediateJournal.state.pending?.itemIndex !== index ||
        immediateJournal.state.pending?.state !== "sent_unconfirmed") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID");
    }
    const deletion = keychain.delete(proof.locator, deleteAuthorization);
    await deletion;
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );

    const deleted = await keychain.inspect(proof.locator);
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    if (deleted !== "item_not_found") {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_DELETE_FAILED");
    }
    const confirmed = appendDeletionJournal(
      output,
      journalRecords,
      index,
      "confirmed_absent",
      marker,
      checked,
      expectedApproval,
      {},
    );
    journalRecords = confirmed.records;
    journalInfo = confirmed.info;
    await hooks.onDeletionTransition(Object.freeze({
      state: "confirmed_absent",
      item_index: index,
      purpose: proof.purpose,
    }));
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    journalState = analyzedDeletionJournal(
      journalRecords,
      output,
      marker,
      checked,
      expectedApproval,
    );
  }

  terminalJournal = deletionJournalEvidence(
    output,
    marker,
    checked,
    expectedApproval,
  );
  const absent = await inspectKeychain(keychain, { allowMissing: true });
  await boundary(
    evidenceCapability,
    checked,
    preparedKeychain,
    keychain,
    reservation,
  );
  if (absent.some((entry) => entry.lookup !== "item_not_found")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_DELETE_FAILED");
  }

  if (anchoredReceipt === null) {
    const completedAt = checkedCompletionTime(hooks.now, checked);
    anchoredReceipt = closedReceiptValue({
      checked,
      approvalFingerprint: expectedApproval,
      maintenanceWindow: checkedMaintenanceWindow,
      completedAt,
      campaignItems: absent,
      deletionJournal: terminalJournal,
    });
    assertDisposableRecoveryManualTeardownClosure(
      anchoredReceipt,
      checked.binding,
    );
    anchoredValue = terminalAnchorExpected(
      output,
      marker,
      checked,
      expectedApproval,
      anchoredReceipt,
      terminalJournal,
    );
    hooks.onAnchorTransition("before_terminal_anchor");
    const finalAbsent = await inspectKeychain(keychain, { allowMissing: true });
    await boundary(
      evidenceCapability,
      checked,
      preparedKeychain,
      keychain,
      reservation,
    );
    if (finalAbsent.some((entry) => entry.lookup !== "item_not_found")) {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_COMPLETED_STATE_CHANGED");
    }
    deletionJournalEvidence(output, marker, checked, expectedApproval);
    try {
      createDisposableRecoveryFieldCloseoutTerminalAnchor({
        receiptPath: output.path,
        expectedReceiptDirectory: output.parent.path,
        expected: anchoredValue,
        resume: false,
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID");
    }
    hooks.onAnchorTransition("terminal_anchor_durable");
  }

  await boundary(
    evidenceCapability,
    checked,
    preparedKeychain,
    keychain,
    reservation,
  );
  deletionJournalEvidence(output, marker, checked, expectedApproval);
  readDisposableRecoveryFieldCloseoutTerminalAnchor({
    receiptPath: output.path,
    expectedReceiptDirectory: output.parent.path,
    expected: anchoredValue,
  });
  try {
    finalizePrivateAggregateReceipt(reservation, anchoredReceipt, {
      onFinalizationTransition: hooks.onFinalizationTransition,
      validateTerminalAuthority,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_FINALIZATION_FAILED");
  }
  await boundary(evidenceCapability, checked, preparedKeychain, keychain);
  const completedState = await inspectKeychain(keychain, { allowMissing: true });
  await boundary(evidenceCapability, checked, preparedKeychain, keychain);
  if (completedState.some((entry) => entry.lookup !== "item_not_found")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_COMPLETED_STATE_CHANGED");
  }
  return readTerminalCompleted(output, marker, checked, expectedApproval);
}
function childBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value), "utf8");
}

function missingResult(result, stderr) {
  return result?.status === 44 ||
    /could not be found|item not found|SecKeychainSearchCopyNext/iu.test(
      stderr.toString("utf8"),
    );
}

function checkedCloseoutLocatorEntry(locator) {
  const matched = KEYCHAIN_LOCATORS.find((entry) =>
    entry.locator.reference === locator?.reference &&
    entry.locator.service === locator?.service &&
    entry.locator.account === locator?.account);
  if (!matched) refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  return matched;
}

/** Exact macOS Keychain transport; only the private K0 verifier can call read. */
function createDisposableRecoveryFieldKeychainCloseoutTransport(accountId) {
  const checkedAccountId = String(accountId || "").toLowerCase();
  const platform = process.platform;
  const environment = process.env;
  const securityPath = "/usr/bin/security";
  if (platform !== "darwin" || !ACCOUNT_ID_RE.test(checkedAccountId)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  const checkedLocator = (locator) => checkedCloseoutLocatorEntry(locator).locator;
  const run = (action, locator) => {
    const exactLocator = checkedLocator(locator);
    const args = [action, "-s", exactLocator.service, "-a", exactLocator.account];
    const result = spawnSync(securityPath, args, {
      encoding: null,
      env: keychainChildEnvironment(environment),
      maxBuffer: 64 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
    const stdout = childBuffer(result?.stdout);
    const stderr = childBuffer(result?.stderr);
    try {
      if (result?.error || result?.signal) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_FAILED");
      }
      if (result?.status === 0) return "present";
      if (missingResult(result, stderr)) return "item_not_found";
      refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_FAILED");
    } finally {
      stdout.fill(0);
      stderr.fill(0);
      if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
      if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
    }
  };
  return Object.freeze({
    inspect: async (locator) => run("find-generic-password", locator),
    read: async (locator) => {
      const exactLocator = checkedLocator(locator);
      const args = [
        "find-generic-password", "-s", exactLocator.service,
        "-a", exactLocator.account, "-w",
      ];
      const result = spawnSync(securityPath, args, {
        encoding: null,
        env: keychainChildEnvironment(environment),
        maxBuffer: 8 * 1024,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        windowsHide: true,
      });
      const stdout = childBuffer(result?.stdout);
      const stderr = childBuffer(result?.stderr);
      let value;
      try {
        if (result?.error || result?.signal) {
          refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_FAILED");
        }
        if (result?.status !== 0) {
          if (missingResult(result, stderr)) return null;
          refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_FAILED");
        }
        let end = stdout.length;
        if (end > 0 && stdout[end - 1] === 0x0a) end -= 1;
        if (end > 0 && stdout[end - 1] === 0x0d) end -= 1;
        value = Buffer.from(stdout.subarray(0, end));
        if (value.length < 1 || value.length > 4096 ||
            value.includes(0x00) || value.includes(0x0a) || value.includes(0x0d)) {
          value.fill(0);
          refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_FAILED");
        }
        return value;
      } finally {
        stdout.fill(0);
        stderr.fill(0);
        if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
        if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
      }
    },
    delete: async (locator) => {
      const result = run("delete-generic-password", locator);
      if (result !== "present") {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_FAILED");
      }
      return true;
    },
    sharedTokenPresent: async () => hasStoredCloudflareToken(checkedAccountId, {
      platform,
      environment,
      processRunner: spawnSync,
      securityPath,
    }) === true,
  });
}

function mintA17LiveK0Capability(upstream, evidenceCapability, checked) {
  let verified;
  try {
    verified = assertDisposableRecoveryFieldKeychainVerificationCapability(
      upstream,
      checked.keychainPreparation.keychain_binding_sha256,
    );
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  const data = checkedKeychainPreparationRuntime(verified, checked);
  const capability = Object.freeze({
    ...data,
    campaign_keychain_status: immutable(verified.campaign_keychain_status),
    revalidate: async () => verified.revalidate(),
    revalidateReceipt: async () => verified.revalidateReceipt(),
    verifyItem: async (purpose) => verified.verifyItem(purpose),
  });
  A17_LIVE_K0_CAPABILITIES.set(capability, Object.freeze({
    upstream: verified,
    evidenceCapability,
    keychainBindingSha256: data.keychain_binding_sha256,
  }));
  return capability;
}

function assertA17LiveK0Capability(capability, evidenceCapability, checked) {
  const authority = A17_LIVE_K0_CAPABILITIES.get(capability);
  if (!authority || !Object.isFrozen(capability) ||
      authority.evidenceCapability !== evidenceCapability ||
      authority.keychainBindingSha256 !==
        checked.keychainPreparation.keychain_binding_sha256 ||
      canonical(keychainPreparationData(
        capability,
        checked.binding,
        checked.accountFingerprint,
        { allowMethods: true },
      )) !== canonical(checked.keychainPreparation)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  return capability;
}

function checkedRuntimeImplementation(value) {
  if (!value || typeof value.inspect !== "function" ||
      typeof value.read !== "function" || typeof value.delete !== "function" ||
      typeof value.sharedTokenPresent !== "function") {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  return value;
}

/**
 * Construct the one evidence-bound A17 adapter. Its live-value reader stays
 * private to K0 verification and is never exposed on the returned adapter.
 */
async function createDisposableRecoveryFieldKeychainCloseout(
  evidenceCapability,
) {
  if (arguments.length !== 1) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  const checked = await checkedEvidenceCapability(evidenceCapability);
  const evidenceAuthority = VERIFIED_CLOSEOUT_EVIDENCE.get(evidenceCapability);
  if (!evidenceAuthority) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  let testRuntime = null;
  if (typeof readTestCloseoutRuntime === "function") {
    try { testRuntime = readTestCloseoutRuntime(evidenceCapability); }
    catch { refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID"); }
  }
  const transport = checkedRuntimeImplementation(
    testRuntime?.implementation ??
      createDisposableRecoveryFieldKeychainCloseoutTransport(
        evidenceAuthority.authority.accountId,
      ),
  );
  let upstream;
  try {
    upstream = await verifyDisposableRecoveryFieldKeychainPrep({
      binding: evidenceAuthority.authority.keychainPrepBinding,
      receiptPath: evidenceAuthority.authority.paths.fixedReceipts[
        DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME
      ],
      expectedReceiptDirectory: evidenceAuthority.authority.directory,
      keychain: Object.freeze({
        inspect: async (locator) => transport.inspect(locator),
        read: async (locator) => transport.read(locator),
      }),
      platform: "darwin",
      allowMissing: true,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID");
  }
  await assertDisposableRecoveryFieldCloseoutEvidenceCapability(
    evidenceCapability,
  );
  const liveK0 = mintA17LiveK0Capability(upstream, evidenceCapability, checked);
  await assertKeychainPreparationCurrent(liveK0, { allValues: true });
  await assertDisposableRecoveryFieldCloseoutEvidenceCapability(
    evidenceCapability,
  );
  let adapter;
  adapter = brandCloseoutKeychainAdapter({
    inspect: async (locator) => {
      checkedCloseoutLocatorEntry(locator);
      return transport.inspect(locator);
    },
    authorizeDelete: async (locator) => {
      const entry = checkedCloseoutLocatorEntry(locator);
      assertA17LiveK0Capability(liveK0, evidenceCapability, checked);
      try {
        if (await liveK0.verifyItem(entry.purpose) !== true) {
          refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
        }
        await assertDisposableRecoveryFieldCloseoutEvidenceCapability(
          evidenceCapability,
        );
        if (await liveK0.revalidateReceipt() !== true) {
          refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
        }
        await assertDisposableRecoveryFieldCloseoutEvidenceCapability(
          evidenceCapability,
        );
      } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_CHANGED");
      }
      const authorization = Object.freeze(Object.create(null));
      KEYCHAIN_DELETE_AUTHORIZATIONS.set(authorization, Object.freeze({
        adapter,
        evidenceCapability,
        liveK0,
        reference: entry.locator.reference,
      }));
      return authorization;
    },
    delete: (locator, authorization) => {
      const entry = checkedCloseoutLocatorEntry(locator);
      const granted = KEYCHAIN_DELETE_AUTHORIZATIONS.get(authorization);
      if (!granted || granted.adapter !== adapter ||
          granted.evidenceCapability !== evidenceCapability ||
          granted.liveK0 !== liveK0 ||
          granted.reference !== entry.locator.reference) {
        refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
      }
      KEYCHAIN_DELETE_AUTHORIZATIONS.delete(authorization);
      return transport.delete(locator);
    },
    sharedTokenPresent: async () => transport.sharedTokenPresent(),
  }, evidenceCapability, checked, liveK0, Object.freeze({
    now: testRuntime?.now ?? (() => new Date()),
    onDeletionTransition: testRuntime?.onDeletionTransition ?? (async () => {}),
    onFinalizationTransition: testRuntime?.onFinalizationTransition ?? (() => {}),
    onAnchorTransition: testRuntime?.onAnchorTransition ?? (() => {}),
  }));
  if (Object.hasOwn(adapter, "read")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID");
  }
  return adapter;
}

async function runtimeForEvidence(evidenceCapability) {
  const checked = await checkedEvidenceCapability(evidenceCapability);
  const keychain = await createDisposableRecoveryFieldKeychainCloseout(
    evidenceCapability,
  );
  const authority = assertCloseoutKeychainAdapter(
    keychain,
    evidenceCapability,
    checked,
  );
  return Object.freeze({
    checked,
    keychain,
    preparedKeychain: assertA17LiveK0Capability(
      authority.liveK0,
      evidenceCapability,
      checked,
    ),
    hooks: authority.runtime,
  });
}
