/**
 * Local K0 preparation for the fixed v0.4.8 disposable recovery campaign.
 *
 * This module has no provider or network path. It may create only four fixed
 * macOS Keychain items after an exact preview approval. A prior or partial
 * state is never overwritten: it requires a separate, manually reviewed reset.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  keychainChildEnvironment,
  parseAdminKeySecretReference,
} from "./admin-key-persistence.mjs";
import {
  generateBankAccessWrappingKey,
  validateBankAccessWrappingKey,
} from "./bank-access-wrapping-key.mjs";
import {
  generateRecoveryArtifactKey,
  validateRecoveryArtifactKey,
} from "./recovery-artifact-crypto.mjs";
import {
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateOutputPath,
  assertPrivateAggregateReceiptDirectory,
  clearPrivateAggregateReceiptReservation,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SECURITY_PATH = "/usr/bin/security";
const DEFAULT_EXPECT_PATH = "/usr/bin/expect";
const DEFAULT_EXPECT_SCRIPT_PATH = join(HERE, "..", "connectors", "keychain-write.exp");
const MAX_KEYCHAIN_OUTPUT_BYTES = 4096;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const ADMIN_KEY_RE = /^[a-f0-9]{48}$/u;
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS = 13;
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES =
  64 * 1024;
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES =
  512 * 1024;

export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PROTOCOL =
  "v048-disposable-recovery-field-keychain-prep-v1";
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME =
  "v048-disposable-field-keychain-prep.json";
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX =
  "v048-disposable-field-keychain-prep-reset-";
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX =
  "v048-disposable-field-keychain-prep-reset-journal-";
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_PROTOCOL =
  "v048-disposable-recovery-field-keychain-reset-v1";
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PROTOCOL =
  "v048-disposable-recovery-field-keychain-reset-journal-v1";
export const DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL =
  "v048-disposable-recovery-field-keychain-verification-v1";

const LOCATOR_DEFINITIONS = Object.freeze([
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

const LOCATORS = Object.freeze(LOCATOR_DEFINITIONS.map((definition) =>
  Object.freeze({
    ...definition,
    locator: Object.freeze({
      ...parseAdminKeySecretReference(definition.reference),
      reference: definition.reference,
    }),
    locator_sha256: sha256(definition.reference),
  })));

const RESET_JOURNAL_STATES = Object.freeze([
  "planned",
  "sent_unconfirmed",
  "confirmed",
  "reconciled",
  "complete",
]);
const KEYCHAIN_VERIFICATION_CAPABILITIES = new WeakSet();
const KEYCHAIN_PREPARED_RECEIPT_CAPABILITIES = new WeakSet();

export class DisposableRecoveryFieldKeychainPrepError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldKeychainPrepError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldKeychainPrepError(code);
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

function checkedBinding(value) {
  const fields = [
    "candidate_sha",
    "candidate_tree_sha",
    "package_sha256",
    "field_receipt_sha256",
    "account_id",
  ];
  if (!exactKeys(value, fields) ||
      !COMMIT_RE.test(String(value.candidate_sha || "")) ||
      !COMMIT_RE.test(String(value.candidate_tree_sha || "")) ||
      !SHA256_RE.test(String(value.package_sha256 || "")) ||
      !SHA256_RE.test(String(value.field_receipt_sha256 || "")) ||
      !ACCOUNT_ID_RE.test(String(value.account_id || ""))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_BINDING_INVALID");
  }
  return immutable(value);
}

function preparationFingerprint(binding) {
  return sha256(canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PROTOCOL,
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    account_fingerprint: sha256(binding.account_id),
    campaign_keychain_locator_sha256: LOCATORS.map((entry) => entry.locator_sha256),
  }));
}

export function disposableRecoveryFieldKeychainPreparationFingerprint(bindingInput) {
  return preparationFingerprint(checkedBinding(bindingInput));
}

function publicBinding(binding) {
  return immutable({
    candidate_sha: binding.candidate_sha,
    candidate_tree_sha: binding.candidate_tree_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    account_fingerprint: sha256(binding.account_id),
    preparation_fingerprint: preparationFingerprint(binding),
  });
}

function approvalFor(binding) {
  return sha256(canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PROTOCOL,
    action: "K0",
    binding: publicBinding(binding),
    campaign_keychain_locator_sha256: LOCATORS.map((entry) => entry.locator_sha256),
  }));
}

export function disposableRecoveryFieldKeychainPrepApprovalFingerprint(bindingInput) {
  return approvalFor(checkedBinding(bindingInput));
}

function checkedPlatform(platform) {
  if (platform !== "darwin") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_MACOS_REQUIRED");
  }
}

function checkedAdapter(keychain) {
  if (!keychain || typeof keychain.inspect !== "function" ||
      typeof keychain.read !== "function" || typeof keychain.write !== "function" ||
      typeof keychain.delete !== "function") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_INVALID");
  }
  return keychain;
}

function checkedReadAdapter(keychain) {
  if (!keychain || typeof keychain.inspect !== "function" ||
      typeof keychain.read !== "function") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_INVALID");
  }
  return keychain;
}

function outputContext(receiptPath, expectedReceiptDirectory) {
  let parent;
  try {
    parent = assertPrivateAggregateReceiptDirectory(
      realpathSync(resolve(expectedReceiptDirectory)),
      { code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PATH_INVALID" },
    );
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PATH_INVALID");
  }
  const path = resolve(receiptPath);
  if (dirname(path) !== parent.path ||
      basename(path) !== DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PATH_INVALID");
  }
  return Object.freeze({
    path,
    pendingPath: privateAggregateReceiptPendingPath(path),
    stagedPath: privateAggregateReceiptStagedPath(path),
    commitPath: privateAggregateReceiptCommitPath(path),
    parent,
  });
}

function receiptDirectoryIdentitySha256(parent) {
  if (!parent?.info || parent.info.isDirectory?.() !== true) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_PARENT_CHANGED");
  }
  return sha256(canonical({
    device: String(parent.info.dev),
    inode: String(parent.info.ino),
  }));
}

function assertOutputParentCurrent(output, code =
  "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_PARENT_CHANGED") {
  let current;
  try {
    current = assertPrivateAggregateReceiptDirectory(output.parent.path, { code });
  } catch {
    refuse(code);
  }
  if (current.info.dev !== output.parent.info.dev ||
      current.info.ino !== output.parent.info.ino ||
      receiptDirectoryIdentitySha256(current) !==
        receiptDirectoryIdentitySha256(output.parent)) {
    refuse(code);
  }
  return current;
}

async function inspectAll(keychain) {
  const states = [];
  for (const definition of LOCATORS) {
    const state = await keychain.inspect(definition.locator);
    if (!["present", "item_not_found"].includes(state)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_STATE_INVALID");
    }
    states.push(Object.freeze({
      locator_sha256: definition.locator_sha256,
      purpose: definition.purpose,
      format: definition.format,
      lookup: state,
    }));
  }
  return Object.freeze(states);
}

function assertAllAbsent(states) {
  if (states.some((entry) => entry.lookup !== "item_not_found")) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESET_REQUIRED");
  }
}

function previewResult(binding, states, approvalFingerprint) {
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_prep_preview",
    action: "K0",
    status: "ready_for_separate_approval",
    binding: publicBinding(binding),
    keychain_mutation: false,
    provider_access: false,
    provider_mutation: false,
    campaign_items: states,
    k0_approval_fingerprint: approvalFingerprint,
  });
}

/** Verify the exact fixed campaign items are all absent. No value is read. */
export async function previewDisposableRecoveryFieldKeychainPrep({
  binding,
  keychain,
  platform = process.platform,
}) {
  checkedPlatform(platform);
  const checked = checkedBinding(binding);
  const adapter = checkedAdapter(keychain);
  const states = await inspectAll(adapter);
  assertAllAbsent(states);
  return previewResult(checked, states, approvalFor(checked));
}

function bufferValue(value, code) {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  refuse(code);
}

function equalBuffers(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateSecret(value, format) {
  const text = String(value);
  if (format === "lowercase_hex_48") return ADMIN_KEY_RE.test(text);
  try {
    if (format === "recovery_artifact_v1") {
      validateRecoveryArtifactKey(text);
      return true;
    }
    if (format === "bank_access_wrapping_v2") {
      validateBankAccessWrappingKey(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function generateSecrets(randomBytesImpl) {
  if (typeof randomBytesImpl !== "function") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RANDOM_INVALID");
  }
  const ownedRandom = (length) => {
    const source = randomBytesImpl(length);
    if (!Buffer.isBuffer(source) || source.length !== length) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RANDOM_INVALID");
    }
    return source;
  };
  const admin = () => {
    const bytes = ownedRandom(24);
    try { return bytes.toString("hex"); }
    finally { bytes.fill(0); }
  };
  const generatedBuffers = [];
  const generatorRandom = (length) => {
    const bytes = ownedRandom(length);
    generatedBuffers.push(bytes);
    return bytes;
  };
  let values;
  try {
    values = [
      admin(),
      admin(),
      generateRecoveryArtifactKey(generatorRandom),
      generateBankAccessWrappingKey(generatorRandom),
    ];
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RANDOM_INVALID");
  } finally {
    for (const bytes of generatedBuffers) bytes.fill(0);
  }
  if (new Set(values).size !== values.length ||
      values.some((value, index) => !validateSecret(value, LOCATORS[index].format))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RANDOM_COLLISION");
  }
  return values.map((value) => Buffer.from(value, "utf8"));
}

async function boundary(revalidate, reservation = null) {
  if (reservation) {
    try {
      validatePrivateAggregateReceiptReservation(reservation, {
        code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED",
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED");
    }
  }
  let valid;
  try { valid = await revalidate(); }
  catch { refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_EVIDENCE_CHANGED"); }
  if (valid !== true) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_EVIDENCE_CHANGED");
  }
  if (reservation) {
    try {
      validatePrivateAggregateReceiptReservation(reservation, {
        code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED",
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED");
    }
  }
}

class InjectedProcessDeath extends Error {
  constructor() {
    super("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH");
    this.name = "InjectedProcessDeath";
    this.code = "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH";
  }
}

async function transition(hook, name) {
  try { await hook(name); }
  catch { throw new InjectedProcessDeath(); }
}

function pendingMarker(binding, approvalFingerprint, valueHashes) {
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_prep_pending",
    action: "K0",
    binding: publicBinding(binding),
    k0_approval_fingerprint: approvalFingerprint,
    campaign_keychain_locator_sha256: LOCATORS.map((entry) => entry.locator_sha256),
    campaign_keychain_value_sha256: valueHashes,
  });
}

function assertPendingMarker(marker, binding, approvalFingerprint) {
  if (!exactKeys(marker, [
    "schema_version", "kind", "action", "binding", "k0_approval_fingerprint",
    "campaign_keychain_locator_sha256", "campaign_keychain_value_sha256",
  ]) || marker.schema_version !== 1 ||
      marker.kind !== "v048_disposable_recovery_field_keychain_prep_pending" ||
      marker.action !== "K0" ||
      canonical(marker.binding) !== canonical(publicBinding(binding)) ||
      marker.k0_approval_fingerprint !== approvalFingerprint ||
      !Array.isArray(marker.campaign_keychain_locator_sha256) ||
      !Array.isArray(marker.campaign_keychain_value_sha256) ||
      marker.campaign_keychain_locator_sha256.length !== LOCATORS.length ||
      marker.campaign_keychain_value_sha256.length !== LOCATORS.length ||
      canonical(marker.campaign_keychain_locator_sha256) !== canonical(
        LOCATORS.map((entry) => entry.locator_sha256),
      ) ||
      marker.campaign_keychain_value_sha256.some((value) =>
        !SHA256_RE.test(String(value || ""))) ||
      new Set(marker.campaign_keychain_value_sha256).size !== LOCATORS.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED");
  }
  return immutable(marker);
}

function readPendingMarker(output, binding, approvalFingerprint) {
  let loaded;
  let reservation;
  try {
    loaded = readPrivateAggregateReceipt(output.pendingPath, {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED",
    });
    const marker = assertPendingMarker(loaded.value, binding, approvalFingerprint);
    reservation = resumePrivateAggregateReceiptReservation(output, marker);
    validatePrivateAggregateReceiptReservation(reservation, {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED",
    });
    return marker;
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED");
  } finally {
    if (reservation) abandonPrivateAggregateReceipt(reservation);
  }
}

async function readExistingSecrets(keychain, expectedHashes = null) {
  const secrets = [];
  try {
    for (let index = 0; index < LOCATORS.length; index += 1) {
      if (await keychain.inspect(LOCATORS[index].locator) !== "present") {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESET_REQUIRED");
      }
      const current = bufferValue(
        await keychain.read(LOCATORS[index].locator),
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED",
      );
      if (current === null ||
          !validateSecret(current.toString("utf8"), LOCATORS[index].format) ||
          expectedHashes && sha256(current) !== expectedHashes[index]) {
        if (current) current.fill(0);
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
      }
      secrets.push(current);
    }
    if (new Set(secrets.map((secret) => sha256(secret))).size !== LOCATORS.length) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
    }
    return secrets;
  } catch (error) {
    for (const secret of secrets) secret.fill(0);
    if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
  }
}

function reservationMarkerSha256(marker) {
  return sha256(`${JSON.stringify(marker, null, 2)}\n`);
}

function resetReceiptName(markerSha256) {
  if (!SHA256_RE.test(String(markerSha256 || ""))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_EVIDENCE_INVALID");
  }
  return `${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX}${markerSha256}.json`;
}

function resetOutputContext(output, markerSha256) {
  const path = join(output.parent.path, resetReceiptName(markerSha256));
  return Object.freeze({
    path,
    pendingPath: privateAggregateReceiptPendingPath(path),
    stagedPath: privateAggregateReceiptStagedPath(path),
    commitPath: privateAggregateReceiptCommitPath(path),
    parent: output.parent,
  });
}

function readResidueMarker(output, binding, approvalFingerprint, { allowSingle = false } = {}) {
  if (existsSync(output.commitPath)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_FINALIZATION_IN_PROGRESS");
  }
  const mainPresent = existsSync(output.path);
  const pendingPresent = existsSync(output.pendingPath);
  if (!mainPresent && !pendingPresent) return null;
  if (!allowSingle && (!mainPresent || !pendingPresent)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_EVIDENCE_INVALID");
  }
  if (mainPresent && pendingPresent) {
    return readPendingMarker(output, binding, approvalFingerprint);
  }
  const path = pendingPresent ? output.pendingPath : output.path;
  try {
    const loaded = readPrivateAggregateReceipt(path, {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_EVIDENCE_INVALID",
    });
    return assertPendingMarker(loaded.value, binding, approvalFingerprint);
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_EVIDENCE_INVALID");
  }
}

async function inspectResetItems(keychain, marker, originalItems = null) {
  const items = [];
  for (let index = 0; index < LOCATORS.length; index += 1) {
    const definition = LOCATORS[index];
    const lookup = await keychain.inspect(definition.locator);
    if (!['present', 'item_not_found'].includes(lookup)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_STATE_INVALID");
    }
    let valueSha256 = null;
    let current;
    try {
      if (lookup === "present") {
        current = bufferValue(
          await keychain.read(definition.locator),
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_STATE_INVALID",
        );
        if (current === null ||
            !validateSecret(current.toString("utf8"), definition.format)) {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_STATE_INVALID");
        }
        valueSha256 = sha256(current);
        if (valueSha256 !== marker.campaign_keychain_value_sha256[index]) {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_VALUE_CHANGED");
        }
      }
    } finally {
      if (current) current.fill(0);
    }
    const item = immutable({
      locator_sha256: definition.locator_sha256,
      purpose: definition.purpose,
      format: definition.format,
      lookup,
      value_sha256: valueSha256,
    });
    if (originalItems) {
      const original = originalItems[index];
      if (!original || original.locator_sha256 !== item.locator_sha256 ||
          original.purpose !== item.purpose || original.format !== item.format ||
          !["present", "item_not_found"].includes(original.lookup) ||
          original.lookup === "item_not_found" && lookup !== "item_not_found" ||
          original.lookup === "present" &&
            original.value_sha256 !== marker.campaign_keychain_value_sha256[index] ||
          lookup === "present" && item.value_sha256 !== original.value_sha256) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_STATE_INVALID");
      }
    }
    items.push(item);
  }
  return Object.freeze(items);
}

function resetApprovalFingerprint(binding, marker, items, output) {
  assertOutputParentCurrent(output);
  return sha256(canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_PROTOCOL,
    action: "K0_RESET",
    binding: publicBinding(binding),
    reservation_marker_sha256: reservationMarkerSha256(marker),
    campaign_items: items,
    receipt_path_sha256: sha256(output.path),
    pending_path_sha256: sha256(output.pendingPath),
    receipt_directory_identity_sha256:
      receiptDirectoryIdentitySha256(output.parent),
  }));
}

function resetAuthorizationMarker(binding, marker, items, output, approvalFingerprint) {
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_reset_authorization_pending",
    action: "K0_RESET",
    binding: publicBinding(binding),
    reservation_marker: marker,
    reservation_marker_sha256: reservationMarkerSha256(marker),
    campaign_items: items,
    receipt_path_sha256: sha256(output.path),
    pending_path_sha256: sha256(output.pendingPath),
    receipt_directory_identity_sha256:
      receiptDirectoryIdentitySha256(output.parent),
    approval_fingerprint: approvalFingerprint,
  });
}

function resetAuthorizationReceipt(
  binding,
  marker,
  items,
  output,
  approvalFingerprint,
  authorizedAt,
) {
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_reset_authorization",
    status: "authorized",
    authorized_at: authorizedAt,
    action: "K0_RESET",
    binding: publicBinding(binding),
    reservation_marker: marker,
    reservation_marker_sha256: reservationMarkerSha256(marker),
    campaign_items: items,
    receipt_path_sha256: sha256(output.path),
    pending_path_sha256: sha256(output.pendingPath),
    receipt_directory_identity_sha256:
      receiptDirectoryIdentitySha256(output.parent),
    approval_fingerprint: approvalFingerprint,
    provider_access: false,
    provider_mutation: false,
    shared_cloudflare_token_touched: false,
  });
}

function assertResetAuthorizationReceipt(receipt, binding, output) {
  if (!exactKeys(receipt, [
    "schema_version", "kind", "status", "authorized_at", "action", "binding",
    "reservation_marker", "reservation_marker_sha256", "campaign_items",
    "receipt_path_sha256", "pending_path_sha256",
    "receipt_directory_identity_sha256", "approval_fingerprint",
    "provider_access", "provider_mutation", "shared_cloudflare_token_touched",
  ]) || receipt.schema_version !== 1 ||
      receipt.kind !== "v048_disposable_recovery_field_keychain_reset_authorization" ||
      receipt.status !== "authorized" || receipt.action !== "K0_RESET" ||
      new Date(receipt.authorized_at).toISOString() !== receipt.authorized_at ||
      canonical(receipt.binding) !== canonical(publicBinding(binding)) ||
      receipt.reservation_marker_sha256 !==
        reservationMarkerSha256(receipt.reservation_marker) ||
      receipt.receipt_path_sha256 !== sha256(output.path) ||
      receipt.pending_path_sha256 !== sha256(output.pendingPath) ||
      receipt.receipt_directory_identity_sha256 !==
        receiptDirectoryIdentitySha256(output.parent) ||
      receipt.approval_fingerprint !== resetApprovalFingerprint(
        binding,
        receipt.reservation_marker,
        receipt.campaign_items,
        output,
      ) || receipt.provider_access !== false || receipt.provider_mutation !== false ||
      receipt.shared_cloudflare_token_touched !== false) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
  }
  assertPendingMarker(
    receipt.reservation_marker,
    binding,
    approvalFor(binding),
  );
  if (!Array.isArray(receipt.campaign_items) ||
      receipt.campaign_items.length !== LOCATORS.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
  }
  assertOutputParentCurrent(output);
  for (let index = 0; index < LOCATORS.length; index += 1) {
    const item = receipt.campaign_items[index];
    const definition = LOCATORS[index];
    if (!exactKeys(item, [
      "locator_sha256", "purpose", "format", "lookup", "value_sha256",
    ]) || item.locator_sha256 !== definition.locator_sha256 ||
        item.purpose !== definition.purpose || item.format !== definition.format ||
        !["present", "item_not_found"].includes(item.lookup) ||
        item.lookup === "present" &&
          item.value_sha256 !== receipt.reservation_marker
            .campaign_keychain_value_sha256[index] ||
        item.lookup === "item_not_found" && item.value_sha256 !== null) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
    }
  }
  return immutable(receipt);
}

/**
 * Strictly authenticate one retained K0 reset authorization without reading
 * Keychain or mutating its receipt. This is the shared offline parser used by
 * final closeout evidence review.
 */
export function assertDisposableRecoveryFieldKeychainResetAuthorizationReceipt({
  receipt,
  binding,
  receiptPath,
  expectedReceiptDirectory,
}) {
  const checked = checkedBinding(binding);
  const output = outputContext(receiptPath, expectedReceiptDirectory);
  return assertResetAuthorizationReceipt(receipt, checked, output);
}

function readResetAuthorization(resetOutput, binding) {
  try {
    assertOutputParentCurrent(resetOutput);
    const loaded = readPrivateAggregateReceipt(resetOutput.path, {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID",
    });
    const receipt = assertResetAuthorizationReceipt(loaded.value, binding, outputContext(
      join(resetOutput.parent.path, DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME),
      resetOutput.parent.path,
    ));
    const exactOutput = resetOutputContext(
      outputContext(
        join(resetOutput.parent.path, DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME),
        resetOutput.parent.path,
      ),
      receipt.reservation_marker_sha256,
    );
    if (resetOutput.path !== exactOutput.path ||
        resetOutput.pendingPath !== exactOutput.pendingPath ||
        resetOutput.commitPath !== exactOutput.commitPath) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
    }
    assertOutputParentCurrent(resetOutput);
    return Object.freeze({
      receipt,
      receiptSha256: loaded.sha256,
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
  }
}

function resetJournalStateSlug(state) {
  if (!RESET_JOURNAL_STATES.includes(state)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  return state.replaceAll("_", "-");
}

function resetJournalEventName(markerSha256, eventIndex, state) {
  if (!SHA256_RE.test(String(markerSha256 || "")) ||
      !Number.isSafeInteger(eventIndex) || eventIndex < 0 ||
      eventIndex >= DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  return `${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX}` +
    `${markerSha256}-${String(eventIndex).padStart(2, "0")}-` +
    `${resetJournalStateSlug(state)}.json`;
}

function resetJournalOutputContext(output, markerSha256, eventIndex, state) {
  const path = join(
    output.parent.path,
    resetJournalEventName(markerSha256, eventIndex, state),
  );
  return Object.freeze({
    path,
    pendingPath: privateAggregateReceiptPendingPath(path),
    stagedPath: privateAggregateReceiptStagedPath(path),
    commitPath: privateAggregateReceiptCommitPath(path),
    parent: output.parent,
  });
}

function resetJournalEventData({
  binding,
  markerSha256,
  authorization,
  output,
  resetOutput,
  journalOutput,
  eventIndex,
  itemIndex,
  state,
  previousEventSha256,
}) {
  if (!SHA256_RE.test(String(authorization?.receiptSha256 || "")) ||
      !Number.isSafeInteger(eventIndex) || eventIndex < 0 ||
      eventIndex >= DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS ||
      !RESET_JOURNAL_STATES.includes(state) ||
      state === "complete" && itemIndex !== null ||
      state !== "complete" && (!Number.isSafeInteger(itemIndex) ||
        itemIndex < 0 || itemIndex >= LOCATORS.length) ||
      eventIndex === 0 && previousEventSha256 !== null ||
      eventIndex > 0 && !SHA256_RE.test(String(previousEventSha256 || ""))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  return immutable({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PROTOCOL,
    action: "K0_RESET",
    binding: publicBinding(binding),
    approval_fingerprint: authorization.receipt.approval_fingerprint,
    authorization_receipt_sha256: authorization.receiptSha256,
    reservation_marker_sha256: markerSha256,
    keychain_receipt_path_sha256: sha256(output.path),
    keychain_pending_path_sha256: sha256(output.pendingPath),
    reset_authorization_receipt_path_sha256: sha256(resetOutput.path),
    receipt_directory_path_sha256: sha256(output.parent.path),
    receipt_directory_identity_sha256:
      receiptDirectoryIdentitySha256(output.parent),
    journal_event_path_sha256: sha256(journalOutput.path),
    campaign_items: authorization.receipt.campaign_items,
    ordered_keychain_locator_sha256: LOCATORS.map((entry) => entry.locator_sha256),
    ordered_keychain_purpose: LOCATORS.map((entry) => entry.purpose),
    event_index: eventIndex,
    item_index: itemIndex,
    state,
    previous_event_sha256: previousEventSha256,
    provider_access: false,
    provider_mutation: false,
    shared_cloudflare_token_touched: false,
  });
}

function resetJournalMarker(data) {
  return immutable({
    kind: "v048_disposable_recovery_field_keychain_reset_journal_pending",
    ...data,
  });
}

function resetJournalReceipt(data) {
  return immutable({
    kind: "v048_disposable_recovery_field_keychain_reset_journal_event",
    status: "durable",
    ...data,
  });
}

function assertResetJournalReceipt(receipt, expected) {
  if (!plainObject(receipt) ||
      canonical(receipt) !== canonical(resetJournalReceipt(expected))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  return immutable(receipt);
}

function resetJournalGroups(output, markerSha256) {
  assertOutputParentCurrent(output);
  let names;
  try { names = readdirSync(output.parent.path); }
  catch { refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID"); }
  assertOutputParentCurrent(output);
  const prefix = `${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX}` +
    `${markerSha256}-`;
  const pattern = new RegExp(
    `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX}` +
      `${markerSha256}-([0-9]{2})-` +
      `(planned|sent-unconfirmed|confirmed|reconciled|complete)` +
      `(?:\\.(pending|staged|commit))?\\.json$`,
    "u",
  );
  const groups = new Map();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = pattern.exec(name);
    if (!match) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    const eventIndex = Number.parseInt(match[1], 10);
    const state = match[2].replaceAll("-", "_");
    if (eventIndex >= DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    const existing = groups.get(eventIndex);
    if (existing && existing.state !== state) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    const group = existing ?? {
      eventIndex,
      state,
      main: false,
      pending: false,
      staged: false,
      commit: false,
    };
    const part = match[3] ?? "main";
    if (group[part]) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    group[part] = true;
    groups.set(eventIndex, group);
  }
  const ordered = [...groups.values()].sort((left, right) =>
    left.eventIndex - right.eventIndex);
  if (ordered.length > DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS ||
      ordered.some((group, index) => group.eventIndex !== index)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  return ordered.map((group) => Object.freeze(group));
}

function resetJournalMachine(authorization) {
  const candidates = authorization.receipt.campaign_items
    .map((item, index) => item.lookup === "present" ? index : null)
    .filter((index) => index !== null);
  return {
    candidates,
    candidateOffset: 0,
    phase: candidates.length ? "planned" : "complete",
    done: false,
  };
}

function expectedResetJournalStep(machine, actualState = null) {
  if (machine.done) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  const itemIndex = machine.phase === "complete"
    ? null
    : machine.candidates[machine.candidateOffset];
  if (machine.phase === "terminal") {
    if (!["confirmed", "reconciled"].includes(actualState)) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    return { itemIndex, state: actualState };
  }
  if (actualState !== null && actualState !== machine.phase) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  return { itemIndex, state: machine.phase };
}

function advanceResetJournalMachine(machine, state) {
  if (state === "planned") machine.phase = "sent_unconfirmed";
  else if (state === "sent_unconfirmed") machine.phase = "terminal";
  else if (["confirmed", "reconciled"].includes(state)) {
    machine.candidateOffset += 1;
    machine.phase = machine.candidateOffset === machine.candidates.length
      ? "complete"
      : "planned";
  } else if (state === "complete") {
    machine.done = true;
  } else {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
}

function readResetJournalFinalEvent(journalOutput, expected) {
  try {
    assertOutputParentCurrent(journalOutput);
    const loaded = readPrivateAggregateReceipt(journalOutput.path, {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID",
      maxBytes: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
    });
    assertOutputParentCurrent(journalOutput);
    return Object.freeze({
      receipt: assertResetJournalReceipt(loaded.value, expected),
      receiptSha256: loaded.sha256,
      bytes: loaded.info.size,
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
}

function resetJournalExpectedData({
  binding,
  markerSha256,
  authorization,
  output,
  resetOutput,
  eventIndex,
  itemIndex,
  state,
  previousEventSha256,
}) {
  const journalOutput = resetJournalOutputContext(
    output,
    markerSha256,
    eventIndex,
    state,
  );
  return Object.freeze({
    journalOutput,
    data: resetJournalEventData({
      binding,
      markerSha256,
      authorization,
      output,
      resetOutput,
      journalOutput,
      eventIndex,
      itemIndex,
      state,
      previousEventSha256,
    }),
  });
}

function readFinalResetJournal({
  binding,
  markerSha256,
  authorization,
  output,
  resetOutput,
  requireComplete = false,
}) {
  const groups = resetJournalGroups(output, markerSha256);
  const machine = resetJournalMachine(authorization);
  const events = [];
  let previousEventSha256 = null;
  let totalBytes = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group.main || group.pending || group.staged || group.commit) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INCOMPLETE");
    }
    const step = expectedResetJournalStep(machine, group.state);
    const expected = resetJournalExpectedData({
      binding,
      markerSha256,
      authorization,
      output,
      resetOutput,
      eventIndex: index,
      itemIndex: step.itemIndex,
      state: step.state,
      previousEventSha256,
    });
    const loaded = readResetJournalFinalEvent(expected.journalOutput, expected.data);
    totalBytes += loaded.bytes;
    if (totalBytes > DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    events.push(loaded);
    previousEventSha256 = loaded.receiptSha256;
    advanceResetJournalMachine(machine, step.state);
  }
  if (requireComplete && !machine.done) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INCOMPLETE");
  }
  return Object.freeze({
    machine,
    events: Object.freeze(events),
    previousEventSha256,
    totalBytes,
  });
}

/**
 * Strictly authenticate the retained, hash-only K0_RESET deletion journal.
 * This offline verifier performs no Keychain access and no filesystem writes.
 */
export function verifyDisposableRecoveryFieldKeychainResetJournal({
  binding,
  resetReceiptPath,
  expectedReceiptDirectory,
}) {
  const checked = checkedBinding(binding);
  const output = outputContext(
    join(expectedReceiptDirectory, DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME),
    expectedReceiptDirectory,
  );
  const name = basename(resolve(resetReceiptPath));
  const match = new RegExp(
    `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX}` +
      `([a-f0-9]{64})\\.json$`,
    "u",
  ).exec(name);
  if (!match || dirname(resolve(resetReceiptPath)) !== output.parent.path) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  const resetOutput = resetOutputContext(output, match[1]);
  if (resetOutput.path !== resolve(resetReceiptPath)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  const authorization = readResetAuthorization(resetOutput, checked);
  if (authorization.receipt.reservation_marker_sha256 !== match[1]) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  const journal = readFinalResetJournal({
    binding: checked,
    markerSha256: match[1],
    authorization,
    output,
    resetOutput,
    requireComplete: true,
  });
  return immutable({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PROTOCOL,
    status: "complete",
    reset_authorization_receipt_sha256: authorization.receiptSha256,
    reservation_marker_sha256: match[1],
    event_count: journal.events.length,
    total_bytes: journal.totalBytes,
    final_event_sha256: journal.previousEventSha256,
    event_receipt_sha256: journal.events.map((event) => event.receiptSha256),
    provider_access: false,
    provider_mutation: false,
    shared_cloudflare_token_touched: false,
  });
}

function recoverResetJournalEvent({
  group,
  expected,
  clearJournalReservation,
  finalizeJournalReceipt,
  recoverJournalReceipt,
}) {
  const { journalOutput, data } = expected;
  const marker = resetJournalMarker(data);
  const receipt = resetJournalReceipt(data);
  if (!group.main && group.pending && !group.staged && !group.commit) {
    clearJournalReservation(journalOutput, marker, {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID",
    });
    return null;
  }
  if (!group.main) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  if (group.staged || group.commit) {
    try {
      recoverJournalReceipt(
        journalOutput,
        marker,
        (candidate) => {
          assertResetJournalReceipt(candidate, data);
          return true;
        },
        { code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID" },
      );
    } catch (error) {
      if (error instanceof InjectedProcessDeath) throw error;
      // Once the sent-unconfirmed record entered deterministic finalization,
      // never turn its damaged or partial staging state into permission to
      // repeat the Keychain deletion. Preserve every guard and require manual
      // reconciliation through the existing ambiguous-delete refusal.
      if (data.state === "sent_unconfirmed") {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS");
      }
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
  }
  if (existsSync(journalOutput.pendingPath)) {
    let reservation;
    let finalized = false;
    try {
      reservation = resumePrivateAggregateReceiptReservation(journalOutput, marker);
      finalizeJournalReceipt(reservation, receipt);
      finalized = true;
    } finally {
      if (reservation && !finalized) abandonPrivateAggregateReceipt(reservation);
    }
  }
  return readResetJournalFinalEvent(journalOutput, data);
}

function loadResetJournalRuntime({
  binding,
  markerSha256,
  authorization,
  output,
  resetOutput,
  clearJournalReservation,
  finalizeJournalReceipt,
  recoverJournalReceipt,
}) {
  const groups = resetJournalGroups(output, markerSha256);
  const machine = resetJournalMachine(authorization);
  const events = [];
  let previousEventSha256 = null;
  let totalBytes = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group.main && group.pending && !group.staged && !group.commit &&
        index !== groups.length - 1) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    const step = expectedResetJournalStep(machine, group.state);
    const expected = resetJournalExpectedData({
      binding,
      markerSha256,
      authorization,
      output,
      resetOutput,
      eventIndex: index,
      itemIndex: step.itemIndex,
      state: step.state,
      previousEventSha256,
    });
    const loaded = recoverResetJournalEvent({
      group,
      expected,
      clearJournalReservation,
      finalizeJournalReceipt,
      recoverJournalReceipt,
    });
    if (!loaded) {
      if (index !== groups.length - 1) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
      }
      break;
    }
    totalBytes += loaded.bytes;
    if (totalBytes > DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    events.push(loaded);
    previousEventSha256 = loaded.receiptSha256;
    advanceResetJournalMachine(machine, step.state);
  }
  return {
    machine,
    events,
    previousEventSha256,
    totalBytes,
  };
}

function appendResetJournalEvent({
  journal,
  binding,
  markerSha256,
  authorization,
  output,
  resetOutput,
  state,
  itemIndex,
  reserveJournalReceipt,
  finalizeJournalReceipt,
}) {
  const eventIndex = journal.events.length;
  const expectedStep = expectedResetJournalStep(journal.machine, state);
  if (expectedStep.itemIndex !== itemIndex || expectedStep.state !== state) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  const expected = resetJournalExpectedData({
    binding,
    markerSha256,
    authorization,
    output,
    resetOutput,
    eventIndex,
    itemIndex,
    state,
    previousEventSha256: journal.previousEventSha256,
  });
  let reservation;
  let finalized = false;
  try {
    reservation = reserveJournalReceipt(
      assertPrivateAggregateOutputPath(expected.journalOutput.path, {
        code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID",
      }),
      resetJournalMarker(expected.data),
    );
    finalizeJournalReceipt(reservation, resetJournalReceipt(expected.data));
    finalized = true;
  } finally {
    if (reservation && !finalized) abandonPrivateAggregateReceipt(reservation);
  }
  const loaded = readResetJournalFinalEvent(expected.journalOutput, expected.data);
  const totalBytes = journal.totalBytes + loaded.bytes;
  if (totalBytes > DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
  }
  journal.events.push(loaded);
  journal.previousEventSha256 = loaded.receiptSha256;
  journal.totalBytes = totalBytes;
  advanceResetJournalMachine(journal.machine, state);
  return loaded;
}

async function assertJournalTerminalItemsAbsent(keychain, journal) {
  const terminalItems = new Set(journal.events
    .filter((event) => ["confirmed", "reconciled"].includes(event.receipt.state))
    .map((event) => event.receipt.item_index));
  for (const itemIndex of terminalItems) {
    if (await keychain.inspect(LOCATORS[itemIndex].locator) !== "item_not_found") {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETED_VALUE_REAPPEARED");
    }
  }
}

function findResetAuthorizationByApproval(output, binding, approvalFingerprint) {
  assertOutputParentCurrent(output);
  let names;
  try { names = readdirSync(output.parent.path); }
  catch { refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID"); }
  assertOutputParentCurrent(output);
  const matches = [];
  const pattern = new RegExp(
    `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX}([a-f0-9]{64})\\.json$`,
    "u",
  );
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const resetOutput = resetOutputContext(output, match[1]);
    try {
      const loaded = readResetAuthorization(resetOutput, binding);
      if (loaded.receipt.approval_fingerprint === approvalFingerprint) {
        matches.push(Object.freeze({ resetOutput, loaded }));
      }
    } catch { /* unrelated or incomplete reset receipts grant no authority */ }
  }
  if (matches.length !== 1) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
  }
  return matches[0];
}

async function resetEvidenceBoundary(revalidate) {
  let valid;
  try { valid = await revalidate(); }
  catch { refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_EVIDENCE_CHANGED"); }
  if (valid !== true) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_EVIDENCE_CHANGED");
  }
}

/** Preview an exact cleanup of a partial K0 run. No item is removed. */
export async function previewDisposableRecoveryFieldKeychainReset({
  binding,
  receiptPath,
  expectedReceiptDirectory,
  keychain,
  platform = process.platform,
}) {
  checkedPlatform(platform);
  const checked = checkedBinding(binding);
  const adapter = checkedAdapter(keychain);
  const output = outputContext(receiptPath, expectedReceiptDirectory);
  const marker = readResidueMarker(output, checked, approvalFor(checked), {
    allowSingle: true,
  });
  if (!marker) refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_NOT_REQUIRED");
  const items = await inspectResetItems(adapter, marker);
  const markerSha256 = reservationMarkerSha256(marker);
  const resetOutput = resetOutputContext(output, markerSha256);
  if (existsSync(resetOutput.path) || existsSync(resetOutput.pendingPath) ||
      existsSync(resetOutput.commitPath)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RESUME_REQUIRED");
  }
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_reset_preview",
    action: "K0_RESET",
    status: "ready_for_separate_approval",
    binding: publicBinding(checked),
    reservation_marker_sha256: markerSha256,
    receipt_directory_identity_sha256:
      receiptDirectoryIdentitySha256(output.parent),
    campaign_items: items,
    keychain_mutation: false,
    provider_access: false,
    provider_mutation: false,
    shared_cloudflare_token_touched: false,
    reset_receipt_name: resetReceiptName(markerSha256),
    reset_approval_fingerprint: resetApprovalFingerprint(
      checked,
      marker,
      items,
      output,
    ),
  });
}

/**
 * Execute one exact-approved partial-K0 cleanup. The durable authorization
 * receipt is written before any Keychain deletion and retained afterward.
 */
export async function runDisposableRecoveryFieldKeychainReset({
  binding,
  approvalFingerprint,
  singleOperatorConfirmed,
  receiptPath,
  expectedReceiptDirectory,
  keychain,
  resume = false,
  platform = process.platform,
  revalidate = () => true,
  now = () => new Date(),
  onTransition = () => {},
  reserveReceipt = reservePrivateAggregateReceipt,
  finalizeReceipt = finalizePrivateAggregateReceipt,
  reserveJournalReceipt = reservePrivateAggregateReceipt,
  finalizeJournalReceipt = finalizePrivateAggregateReceipt,
  recoverJournalReceipt = recoverPrivateAggregateReceiptFinalization,
  clearJournalReservation = clearPrivateAggregateReceiptReservation,
}) {
  checkedPlatform(platform);
  const checked = checkedBinding(binding);
  if (!SHA256_RE.test(String(approvalFingerprint || "")) ||
      singleOperatorConfirmed !== true ||
      typeof resume !== "boolean" || typeof revalidate !== "function" ||
      typeof now !== "function" || typeof onTransition !== "function" ||
      typeof reserveReceipt !== "function" ||
      typeof finalizeReceipt !== "function" ||
      typeof reserveJournalReceipt !== "function" ||
      typeof finalizeJournalReceipt !== "function" ||
      typeof recoverJournalReceipt !== "function" ||
      typeof clearJournalReservation !== "function") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_ARGUMENTS_INVALID");
  }
  const adapter = checkedAdapter(keychain);
  const output = outputContext(receiptPath, expectedReceiptDirectory);
  if (existsSync(output.commitPath)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_FINALIZATION_IN_PROGRESS");
  }
  let marker = readResidueMarker(output, checked, approvalFor(checked), {
    allowSingle: true,
  });
  const residueMarkerPresentAtStart = marker !== null;
  let resetOutput;
  let authorization;
  if (!marker) {
    if (!resume) refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_NOT_REQUIRED");
    const found = findResetAuthorizationByApproval(output, checked, approvalFingerprint);
    resetOutput = found.resetOutput;
    authorization = found.loaded;
    marker = authorization.receipt.reservation_marker;
  } else {
    resetOutput = resetOutputContext(output, reservationMarkerSha256(marker));
  }

  if (resume && residueMarkerPresentAtStart &&
      !existsSync(resetOutput.path) && !existsSync(resetOutput.pendingPath) &&
      !existsSync(resetOutput.commitPath)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
  }

  await resetEvidenceBoundary(revalidate);
  if (!authorization) {
    const existingAuthorization = existsSync(resetOutput.path) ||
      existsSync(resetOutput.pendingPath) || existsSync(resetOutput.commitPath);
    if (existingAuthorization && !resume) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RESUME_REQUIRED");
    }
    if (resume && existsSync(resetOutput.path) &&
        !existsSync(resetOutput.pendingPath) && !existsSync(resetOutput.commitPath)) {
      authorization = readResetAuthorization(resetOutput, checked);
    }
  }
  if (!authorization) {
    const items = await inspectResetItems(adapter, marker);
    const expectedApproval = resetApprovalFingerprint(checked, marker, items, output);
    if (approvalFingerprint !== expectedApproval) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_APPROVAL_INVALID");
    }
    const authorizationMarker = resetAuthorizationMarker(
      checked,
      marker,
      items,
      output,
      expectedApproval,
    );
    if (!existsSync(resetOutput.path) && existsSync(resetOutput.pendingPath) &&
        !existsSync(resetOutput.commitPath)) {
      try {
        clearPrivateAggregateReceiptReservation(resetOutput, authorizationMarker, {
          code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID",
        });
      } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
      }
      refuse(
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_AUTHORIZATION_RESTART_REQUIRED",
      );
    }
    if (existsSync(resetOutput.commitPath)) {
      try {
        recoverPrivateAggregateReceiptFinalization(
          resetOutput,
          authorizationMarker,
          (candidate) => {
            assertResetAuthorizationReceipt(candidate, checked, output);
            return true;
          },
        );
      } catch {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
      }
    }
    if (existsSync(resetOutput.path) && !existsSync(resetOutput.pendingPath) &&
        !existsSync(resetOutput.commitPath)) {
      authorization = readResetAuthorization(resetOutput, checked);
    } else {
      let reservation;
      let finalized = false;
      try {
        reservation = existsSync(resetOutput.path) || existsSync(resetOutput.pendingPath)
          ? resumePrivateAggregateReceiptReservation(resetOutput, authorizationMarker)
          : reserveReceipt(
              assertPrivateAggregateOutputPath(resetOutput.path, {
                code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID",
              }),
              authorizationMarker,
            );
        await transition(onTransition, "reset_authorization_reserved");
        await resetEvidenceBoundary(revalidate);
        let authorizedAt;
        try {
          const value = now();
          authorizedAt = (value instanceof Date ? value : new Date(value)).toISOString();
        } catch {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_CLOCK_INVALID");
        }
        const receipt = resetAuthorizationReceipt(
          checked,
          marker,
          items,
          output,
          expectedApproval,
          authorizedAt,
        );
        assertResetAuthorizationReceipt(receipt, checked, output);
        finalizeReceipt(reservation, receipt);
        finalized = true;
        await transition(onTransition, "reset_authorization_finalized");
      } catch (error) {
        if (error instanceof InjectedProcessDeath || existsSync(resetOutput.commitPath)) {
          throw error;
        }
        if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
      } finally {
        if (reservation && !finalized) abandonPrivateAggregateReceipt(reservation);
      }
      authorization = readResetAuthorization(resetOutput, checked);
    }
  }
  if (authorization.receipt.approval_fingerprint !== approvalFingerprint ||
      reservationMarkerSha256(marker) !==
        authorization.receipt.reservation_marker_sha256) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_APPROVAL_INVALID");
  }

  const authorizationSha256 = authorization.receiptSha256;
  const proveAuthorization = () => {
    const current = readResetAuthorization(resetOutput, checked);
    if (current.receiptSha256 !== authorizationSha256 ||
        current.receipt.approval_fingerprint !== approvalFingerprint) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID");
    }
  };
  proveAuthorization();
  const markerSha256 = authorization.receipt.reservation_marker_sha256;
  const journalInput = {
    binding: checked,
    markerSha256,
    authorization,
    output,
    resetOutput,
    clearJournalReservation,
    finalizeJournalReceipt,
    recoverJournalReceipt,
  };
  const loadJournal = () => loadResetJournalRuntime(journalInput);
  const appendJournal = async (journal, state, itemIndex) => {
    const eventIndex = journal.events.length;
    await transition(
      onTransition,
      `before_reset_journal:${eventIndex}:${state}`,
    );
    const event = appendResetJournalEvent({
      journal,
      binding: checked,
      markerSha256,
      authorization,
      output,
      resetOutput,
      state,
      itemIndex,
      reserveJournalReceipt,
      finalizeJournalReceipt,
    });
    await transition(
      onTransition,
      `after_reset_journal:${eventIndex}:${state}`,
    );
    return event;
  };

  while (true) {
    const journal = loadJournal();
    await assertJournalTerminalItemsAbsent(adapter, journal);
    if (journal.machine.done) {
      await resetEvidenceBoundary(revalidate);
      proveAuthorization();
      const items = await inspectResetItems(
        adapter,
        marker,
        authorization.receipt.campaign_items,
      );
      if (items.some((item) => item.lookup !== "item_not_found")) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETED_VALUE_REAPPEARED");
      }
      proveAuthorization();
      clearPrivateAggregateReceiptReservation(output, marker, {
        code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RESERVATION_INVALID",
        onTransition: (name) => onTransition(`reset_${name}`),
      });
      await resetEvidenceBoundary(revalidate);
      const finalItems = await inspectResetItems(
        adapter,
        marker,
        authorization.receipt.campaign_items,
      );
      if (finalItems.some((item) => item.lookup !== "item_not_found")) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETED_VALUE_REAPPEARED");
      }
      proveAuthorization();
      readFinalResetJournal({
        binding: checked,
        markerSha256,
        authorization,
        output,
        resetOutput,
        requireComplete: true,
      });
      return Object.freeze({
        status: "reset_complete",
        receipt: authorization.receipt,
        receiptSha256: authorization.receiptSha256,
        campaignItemsAbsent: LOCATORS.length,
      });
    }

    if (journal.machine.phase === "complete") {
      await resetEvidenceBoundary(revalidate);
      proveAuthorization();
      const items = await inspectResetItems(
        adapter,
        marker,
        authorization.receipt.campaign_items,
      );
      if (items.some((item) => item.lookup !== "item_not_found")) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_FAILED");
      }
      await appendJournal(journal, "complete", null);
      continue;
    }

    const itemIndex = journal.machine.candidates[journal.machine.candidateOffset];
    if (journal.machine.phase === "terminal") {
      await resetEvidenceBoundary(revalidate);
      proveAuthorization();
      const currentItems = await inspectResetItems(
        adapter,
        marker,
        authorization.receipt.campaign_items,
      );
      if (currentItems[itemIndex].lookup !== "item_not_found") {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS");
      }
      await appendJournal(journal, "reconciled", itemIndex);
      continue;
    }

    let currentItems = await inspectResetItems(
      adapter,
      marker,
      authorization.receipt.campaign_items,
    );
    if (currentItems[itemIndex].lookup !== "present") {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_STATE_CHANGED");
    }
    if (journal.machine.phase === "planned") {
      await appendJournal(journal, "planned", itemIndex);
    }

    await resetEvidenceBoundary(revalidate);
    proveAuthorization();
    await transition(
      onTransition,
      `before_reset_delete:${LOCATORS[itemIndex].purpose}`,
    );
    currentItems = await inspectResetItems(
      adapter,
      marker,
      authorization.receipt.campaign_items,
    );
    if (currentItems[itemIndex].lookup !== "present") {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_STATE_CHANGED");
    }
    const beforeSendJournal = loadJournal();
    if (beforeSendJournal.machine.phase !== "sent_unconfirmed" ||
        beforeSendJournal.machine.candidates[beforeSendJournal.machine.candidateOffset] !==
          itemIndex) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    await appendJournal(beforeSendJournal, "sent_unconfirmed", itemIndex);
    currentItems = await inspectResetItems(
      adapter,
      marker,
      authorization.receipt.campaign_items,
    );
    if (currentItems[itemIndex].lookup !== "present") {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS");
    }
    await resetEvidenceBoundary(revalidate);
    currentItems = await inspectResetItems(
      adapter,
      marker,
      authorization.receipt.campaign_items,
    );
    if (currentItems[itemIndex].lookup !== "present") {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS");
    }
    proveAuthorization();
    const deleteBoundaryJournal = loadJournal();
    if (deleteBoundaryJournal.machine.phase !== "terminal" ||
        deleteBoundaryJournal.events.length !== beforeSendJournal.events.length ||
        deleteBoundaryJournal.previousEventSha256 !==
          beforeSendJournal.previousEventSha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    try {
      await adapter.delete(LOCATORS[itemIndex].locator);
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS");
    }
    await transition(
      onTransition,
      `after_reset_delete:${LOCATORS[itemIndex].purpose}`,
    );
    if (await adapter.inspect(LOCATORS[itemIndex].locator) !== "item_not_found") {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_FAILED");
    }
    proveAuthorization();
    const afterDeleteJournal = loadJournal();
    if (afterDeleteJournal.machine.phase !== "terminal" ||
        afterDeleteJournal.machine.candidates[afterDeleteJournal.machine.candidateOffset] !==
          itemIndex) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID");
    }
    await appendJournal(afterDeleteJournal, "confirmed", itemIndex);
  }
}

function assertReceipt(receipt, binding, approvalFingerprint) {
  const fields = [
    "schema_version", "kind", "status", "completed_at", "binding",
    "k0_approval_fingerprint", "single_operator_confirmed", "all_absent_at_start",
    "all_created_this_run", "independent_values", "provider_access",
    "provider_mutation", "campaign_items",
  ];
  if (!exactKeys(receipt, fields) || receipt.schema_version !== 1 ||
      receipt.kind !== "v048_disposable_recovery_field_keychain_prep" ||
      receipt.status !== "prepared" ||
      new Date(receipt.completed_at).toISOString() !== receipt.completed_at ||
      canonical(receipt.binding) !== canonical(publicBinding(binding)) ||
      receipt.k0_approval_fingerprint !== approvalFingerprint ||
      receipt.single_operator_confirmed !== true ||
      receipt.all_absent_at_start !== true || receipt.all_created_this_run !== true ||
      receipt.independent_values !== true || receipt.provider_access !== false ||
      receipt.provider_mutation !== false || !Array.isArray(receipt.campaign_items) ||
      receipt.campaign_items.length !== LOCATORS.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID");
  }
  for (let index = 0; index < LOCATORS.length; index += 1) {
    const item = receipt.campaign_items[index];
    const definition = LOCATORS[index];
    if (!exactKeys(item, [
      "locator_sha256", "value_sha256", "purpose", "format",
      "created", "readback_verified",
    ]) || item.locator_sha256 !== definition.locator_sha256 ||
        item.purpose !== definition.purpose || item.format !== definition.format ||
        !SHA256_RE.test(String(item.value_sha256 || "")) ||
        item.created !== true || item.readback_verified !== true) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID");
    }
  }
  if (new Set(receipt.campaign_items.map((item) => item.value_sha256)).size !==
      LOCATORS.length) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID");
  }
  return immutable(receipt);
}

function readCompleted(output, binding, approvalFingerprint) {
  let loaded;
  try {
    loaded = readPrivateAggregateReceipt(output.path, {
      code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID",
    });
    assertReceipt(loaded.value, binding, approvalFingerprint);
  } catch {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID");
  }
  return Object.freeze({ receipt: loaded.value, receiptSha256: loaded.sha256 });
}

async function verifyCompletedValueStatus(completed, keychain, { allowMissing }) {
  const status = [];
  for (let index = 0; index < LOCATORS.length; index += 1) {
    let current;
    try {
      current = bufferValue(
        await keychain.read(LOCATORS[index].locator),
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED",
      );
      if (current === null) {
        if (!allowMissing) {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
        }
        status.push(Object.freeze({
          purpose: LOCATORS[index].purpose,
          lookup: "item_not_found",
        }));
        continue;
      }
      if (sha256(current) !== completed.receipt.campaign_items[index].value_sha256 ||
          !validateSecret(current.toString("utf8"), LOCATORS[index].format)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
      }
      status.push(Object.freeze({
        purpose: LOCATORS[index].purpose,
        lookup: "present",
      }));
    } catch (error) {
      if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
    } finally {
      if (current) current.fill(0);
    }
  }
  return Object.freeze(status);
}

async function verifyCompletedValues(completed, keychain) {
  await verifyCompletedValueStatus(completed, keychain, { allowMissing: false });
}

function completedVerificationEvidence(completed) {
  const campaignItems = completed.receipt.campaign_items.map((item) =>
    Object.freeze({
      purpose: item.purpose,
      format: item.format,
      locator_sha256: item.locator_sha256,
      value_sha256: item.value_sha256,
    }));
  const base = {
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL,
    receipt_sha256: completed.receiptSha256,
    preparation_fingerprint: completed.receipt.binding.preparation_fingerprint,
    account_fingerprint: completed.receipt.binding.account_fingerprint,
    campaign_keychain_locator_sha256:
      campaignItems.map((item) => item.locator_sha256),
    campaign_keychain_value_sha256:
      campaignItems.map((item) => item.value_sha256),
    campaign_items: campaignItems,
  };
  return immutable({
    ...base,
    keychain_binding_sha256: sha256(canonical(base)),
  });
}

function readStableCompletedVerificationEvidence(
  output,
  binding,
  approvalFingerprint,
  expected = null,
) {
  assertOutputParentCurrent(
    output,
    "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED",
  );
  const first = readCompleted(output, binding, approvalFingerprint);
  const second = readCompleted(output, binding, approvalFingerprint);
  assertOutputParentCurrent(
    output,
    "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED",
  );
  if (first.receiptSha256 !== second.receiptSha256 ||
      canonical(first.receipt) !== canonical(second.receipt)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
  }
  const evidence = completedVerificationEvidence(second);
  if (expected && canonical(evidence) !== canonical(expected)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
  }
  return evidence;
}

function assertHashOnlyVerificationEvidence(value, code) {
  const fields = [
    "schema_version", "protocol", "receipt_sha256", "preparation_fingerprint",
    "account_fingerprint", "campaign_keychain_locator_sha256",
    "campaign_keychain_value_sha256", "campaign_items",
    "keychain_binding_sha256",
  ];
  if (!value || typeof value !== "object" || value.schema_version !== 1 ||
      value.protocol !== DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL ||
      [value.receipt_sha256, value.preparation_fingerprint,
        value.account_fingerprint, value.keychain_binding_sha256].some((entry) =>
        !SHA256_RE.test(String(entry || ""))) ||
      !Array.isArray(value.campaign_keychain_locator_sha256) ||
      !Array.isArray(value.campaign_keychain_value_sha256) ||
      !Array.isArray(value.campaign_items) ||
      value.campaign_keychain_locator_sha256.length !== LOCATORS.length ||
      value.campaign_keychain_value_sha256.length !== LOCATORS.length ||
      value.campaign_items.length !== LOCATORS.length ||
      new Set(value.campaign_keychain_value_sha256).size !== LOCATORS.length) {
    refuse(code);
  }
  for (let index = 0; index < LOCATORS.length; index += 1) {
    const item = value.campaign_items[index];
    const locator = LOCATORS[index];
    if (!exactKeys(item, ["purpose", "format", "locator_sha256", "value_sha256"]) ||
        item.purpose !== locator.purpose || item.format !== locator.format ||
        item.locator_sha256 !== locator.locator_sha256 ||
        item.locator_sha256 !== value.campaign_keychain_locator_sha256[index] ||
        item.value_sha256 !== value.campaign_keychain_value_sha256[index] ||
        !SHA256_RE.test(String(item.value_sha256 || ""))) {
      refuse(code);
    }
  }
  const base = Object.fromEntries(fields.slice(0, -1).map((field) =>
    [field, value[field]]));
  if (value.keychain_binding_sha256 !== sha256(canonical(base))) refuse(code);
  return value;
}

function assertHashOnlyVerificationBinding(
  value,
  bindingInput,
  expectedBindingSha256,
  code,
) {
  const evidence = assertHashOnlyVerificationEvidence(value, code);
  const binding = checkedBinding(bindingInput);
  if ((expectedBindingSha256 !== null &&
       (!SHA256_RE.test(String(expectedBindingSha256 || "")) ||
        evidence.keychain_binding_sha256 !== expectedBindingSha256)) ||
      evidence.preparation_fingerprint !== preparationFingerprint(binding) ||
      evidence.account_fingerprint !== sha256(binding.account_id)) {
    refuse(code);
  }
  return evidence;
}

/**
 * Reopen the one fixed K0 prepared receipt without reading Keychain. The
 * returned capability is hash-only and authorizes receipt evidence only; it
 * cannot satisfy the separate live-Keychain verification capability boundary.
 */
export function readDisposableRecoveryFieldKeychainPreparedReceipt({
  binding: bindingInput,
  receiptPath,
  expectedReceiptDirectory,
}) {
  const binding = checkedBinding(bindingInput);
  const output = outputContext(receiptPath, expectedReceiptDirectory);
  const approvalFingerprint = approvalFor(binding);
  const evidence = readStableCompletedVerificationEvidence(
    output,
    binding,
    approvalFingerprint,
  );
  const capability = Object.freeze({
    ...evidence,
    revalidateReceipt: async () => {
      readStableCompletedVerificationEvidence(
        output,
        binding,
        approvalFingerprint,
        evidence,
      );
      return true;
    },
  });
  KEYCHAIN_PREPARED_RECEIPT_CAPABILITIES.add(capability);
  return capability;
}

/** Require the genuine offline receipt capability and its exact raw binding. */
export function assertDisposableRecoveryFieldKeychainPreparedReceiptCapability(
  capability,
  binding,
  expectedBindingSha256 = null,
) {
  const code =
    "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREPARED_RECEIPT_CAPABILITY_INVALID";
  if (!capability || typeof capability !== "object" ||
      !Object.isFrozen(capability) ||
      !KEYCHAIN_PREPARED_RECEIPT_CAPABILITIES.has(capability) ||
      !exactKeys(capability, [
        "schema_version", "protocol", "receipt_sha256", "preparation_fingerprint",
        "account_fingerprint", "campaign_keychain_locator_sha256",
        "campaign_keychain_value_sha256", "campaign_items",
        "keychain_binding_sha256", "revalidateReceipt",
      ]) || typeof capability.revalidateReceipt !== "function") {
    refuse(code);
  }
  assertHashOnlyVerificationBinding(
    capability,
    binding,
    expectedBindingSha256,
    code,
  );
  return capability;
}

/**
 * Authenticate one completed K0 receipt and all four exact Keychain values.
 * The returned evidence contains hashes only. Its revalidator repeats the
 * receipt and Keychain proof and is intended to wrap every provider boundary.
 */
export async function verifyDisposableRecoveryFieldKeychainPrep({
  binding,
  receiptPath,
  expectedReceiptDirectory,
  keychain,
  platform = process.platform,
  allowMissing = false,
}) {
  checkedPlatform(platform);
  if (typeof allowMissing !== "boolean") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
  }
  const checked = checkedBinding(binding);
  const adapter = checkedReadAdapter(keychain);
  const output = outputContext(receiptPath, expectedReceiptDirectory);
  const expectedApproval = approvalFor(checked);

  const verifyReceipt = (expected = null) =>
    readStableCompletedVerificationEvidence(
      output,
      checked,
      expectedApproval,
      expected,
    );

  const verify = async (expected = null) => {
    const before = verifyReceipt(expected);
    const completed = readCompleted(output, checked, expectedApproval);
    if (completed.receiptSha256 !== before.receipt_sha256) {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
    }
    const status = await verifyCompletedValueStatus(completed, adapter, { allowMissing });
    const after = verifyReceipt(expected ?? before);
    return Object.freeze({ evidence: after, status });
  };

  const verified = await verify();
  const evidence = verified.evidence;
  const proof = Object.freeze({
    ...evidence,
    campaign_keychain_status: verified.status,
    revalidate: async () => {
      await verify(evidence);
      return true;
    },
    revalidateReceipt: async () => {
      verifyReceipt(evidence);
      return true;
    },
    verifyItem: async (purpose) => {
      const index = LOCATORS.findIndex((entry) =>
        entry.purpose === String(purpose ?? ""));
      if (index < 0) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
      }
      verifyReceipt(evidence);
      let current;
      try {
        current = bufferValue(
          await adapter.read(LOCATORS[index].locator),
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED",
        );
        if (current === null ||
            sha256(current) !== evidence.campaign_keychain_value_sha256[index] ||
            !validateSecret(current.toString("utf8"), LOCATORS[index].format)) {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
        }
      } catch (error) {
        if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED");
      } finally {
        if (current) current.fill(0);
      }
      verifyReceipt(evidence);
      return true;
    },
  });
  KEYCHAIN_VERIFICATION_CAPABILITIES.add(proof);
  return proof;
}

/**
 * Require the unforgeable in-process capability minted only by the live K0
 * verifier. A copied or reconstructed hash-only proof grants no authority.
 */
export function assertDisposableRecoveryFieldKeychainVerificationCapability(
  proof,
  expectedBindingSha256 = null,
) {
  if (!proof || typeof proof !== "object" || !Object.isFrozen(proof) ||
      !KEYCHAIN_VERIFICATION_CAPABILITIES.has(proof) ||
      expectedBindingSha256 !== null &&
        (!SHA256_RE.test(String(expectedBindingSha256 || "")) ||
          proof.keychain_binding_sha256 !== expectedBindingSha256)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_CAPABILITY_INVALID");
  }
  return proof;
}

/**
 * Cross-bind the unforgeable K0 capability to the exact raw campaign identity.
 * This assertion never mints authority. It only accepts the WeakSet-branded
 * proof returned by verifyDisposableRecoveryFieldKeychainPrep and recomputes
 * both the private account/preparation binding and the public proof digest.
 */
export function assertDisposableRecoveryFieldKeychainVerificationBinding(
  proof,
  bindingInput,
  expectedBindingSha256 = null,
) {
  const checkedProof = assertDisposableRecoveryFieldKeychainVerificationCapability(
    proof,
    expectedBindingSha256,
  );
  const binding = checkedBinding(bindingInput);
  const evidence = {
    schema_version: checkedProof.schema_version,
    protocol: checkedProof.protocol,
    receipt_sha256: checkedProof.receipt_sha256,
    preparation_fingerprint: checkedProof.preparation_fingerprint,
    account_fingerprint: checkedProof.account_fingerprint,
    campaign_keychain_locator_sha256:
      checkedProof.campaign_keychain_locator_sha256,
    campaign_keychain_value_sha256:
      checkedProof.campaign_keychain_value_sha256,
    campaign_items: checkedProof.campaign_items,
  };
  if (checkedProof.preparation_fingerprint !== preparationFingerprint(binding) ||
      checkedProof.account_fingerprint !== sha256(binding.account_id) ||
      checkedProof.keychain_binding_sha256 !== sha256(canonical(evidence))) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_CAPABILITY_INVALID");
  }
  return checkedProof;
}

async function verifyGeneratedValues(keychain, secrets, code) {
  for (let index = 0; index < LOCATORS.length; index += 1) {
    let current;
    try {
      current = bufferValue(await keychain.read(LOCATORS[index].locator), code);
      if (current === null || !equalBuffers(current, secrets[index]) ||
          sha256(current) !== sha256(secrets[index]) ||
          !validateSecret(current.toString("utf8"), LOCATORS[index].format)) {
        refuse(code);
      }
    } catch (error) {
      if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
      refuse(code);
    } finally {
      if (current) current.fill(0);
    }
  }
}

async function rollbackCreated({ keychain, secrets, attempted }) {
  let unproven = false;
  for (let index = attempted - 1; index >= 0; index -= 1) {
    let current;
    try {
      current = bufferValue(
        await keychain.read(LOCATORS[index].locator),
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_ROLLBACK_UNPROVEN",
      );
      if (current === null) continue;
      if (!equalBuffers(current, secrets[index])) {
        unproven = true;
        continue;
      }
      await keychain.delete(LOCATORS[index].locator);
      if (await keychain.inspect(LOCATORS[index].locator) !== "item_not_found") {
        unproven = true;
      }
    } catch {
      unproven = true;
    } finally {
      if (current) current.fill(0);
    }
  }
  if (unproven) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_ROLLBACK_UNPROVEN");
  }
}

/** Create or exactly resume the four fixed campaign Keychain items. */
export async function runDisposableRecoveryFieldKeychainPrep({
  binding,
  approvalFingerprint,
  singleOperatorConfirmed,
  receiptPath,
  expectedReceiptDirectory,
  keychain,
  resume = false,
  platform = process.platform,
  randomBytesImpl = randomBytes,
  revalidate = () => true,
  now = () => new Date(),
  onTransition = () => {},
  reserveReceipt = reservePrivateAggregateReceipt,
  finalizeReceipt = finalizePrivateAggregateReceipt,
}) {
  checkedPlatform(platform);
  const checked = checkedBinding(binding);
  const expectedApproval = approvalFor(checked);
  if (approvalFingerprint !== expectedApproval) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_APPROVAL_INVALID");
  }
  if (singleOperatorConfirmed !== true || typeof resume !== "boolean" ||
      typeof revalidate !== "function" || typeof now !== "function" ||
      typeof onTransition !== "function" || typeof reserveReceipt !== "function" ||
      typeof finalizeReceipt !== "function") {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_ARGUMENTS_INVALID");
  }
  const adapter = checkedAdapter(keychain);
  const output = outputContext(receiptPath, expectedReceiptDirectory);
  if (existsSync(output.path) && !existsSync(output.pendingPath) &&
      !existsSync(output.commitPath)) {
    const completed = readCompleted(output, checked, expectedApproval);
    await verifyCompletedValues(completed, adapter);
    return completed;
  }
  const interrupted = existsSync(output.path) || existsSync(output.pendingPath) ||
    existsSync(output.commitPath);
  if (interrupted && !resume) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESUME_REQUIRED");
  }
  if (!interrupted && resume) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESUME_INVALID");
  }

  let secrets;
  let marker;
  let resuming = interrupted;
  if (resuming) {
    await boundary(revalidate);
    if (existsSync(output.commitPath)) {
      secrets = await readExistingSecrets(adapter);
      marker = pendingMarker(
        checked,
        expectedApproval,
        secrets.map((secret) => sha256(secret)),
      );
      let recovered;
      try {
        recovered = recoverPrivateAggregateReceiptFinalization(
          output,
          marker,
          (candidate) => {
            assertReceipt(candidate, checked, expectedApproval);
            return true;
          },
        );
      } catch {
        for (const secret of secrets) secret.fill(0);
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED");
      }
      await boundary(revalidate);
      if (recovered.status === "finalized") {
        const completed = readCompleted(output, checked, expectedApproval);
        await verifyCompletedValues(completed, adapter);
        for (const secret of secrets) secret.fill(0);
        return completed;
      }
    } else {
      if (!existsSync(output.path) || !existsSync(output.pendingPath)) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESET_REQUIRED");
      }
      marker = readPendingMarker(output, checked, expectedApproval);
      secrets = await readExistingSecrets(
        adapter,
        marker.campaign_keychain_value_sha256,
      );
    }
    if (!existsSync(output.path) || !existsSync(output.pendingPath) ||
        existsSync(output.commitPath)) {
      for (const secret of secrets) secret.fill(0);
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED");
    }
    if (!marker) marker = readPendingMarker(output, checked, expectedApproval);
    assertPendingMarker(marker, checked, expectedApproval);
    await boundary(revalidate);
  } else {
    await boundary(revalidate);
    const initial = await inspectAll(adapter);
    assertAllAbsent(initial);
    await boundary(revalidate);
    secrets = generateSecrets(randomBytesImpl);
    marker = pendingMarker(
      checked,
      expectedApproval,
      secrets.map((secret) => sha256(secret)),
    );
  }
  const valueHashes = secrets.map((secret) => sha256(secret));
  if (new Set(valueHashes).size !== LOCATORS.length) {
    for (const secret of secrets) secret.fill(0);
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RANDOM_COLLISION");
  }
  let attempted = 0;
  let reservation = null;
  let finalized = false;
  try {
    try {
      reservation = resuming
        ? resumePrivateAggregateReceiptReservation(output, marker)
        : reserveReceipt(
            assertPrivateAggregateOutputPath(output.path, {
              code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PATH_INVALID",
            }),
            marker,
          );
      validatePrivateAggregateReceiptReservation(reservation, {
        code: "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED",
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_FAILED");
    }
    await transition(onTransition, resuming ? "reservation_resumed" : "pending_reserved");
    if (resuming) {
      await verifyGeneratedValues(
        adapter,
        secrets,
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED",
      );
    } else {
      for (let index = 0; index < LOCATORS.length; index += 1) {
        await boundary(revalidate, reservation);
        if (await adapter.inspect(LOCATORS[index].locator) !== "item_not_found") {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESET_REQUIRED");
        }
        await boundary(revalidate, reservation);
        await transition(onTransition, `before_write:${LOCATORS[index].purpose}`);
        await boundary(revalidate, reservation);
        attempted = index + 1;
        await adapter.write(LOCATORS[index].locator, secrets[index]);
        await transition(onTransition, `after_write:${LOCATORS[index].purpose}`);
        await boundary(revalidate, reservation);
        let current;
        try {
          current = bufferValue(
            await adapter.read(LOCATORS[index].locator),
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_WRITE_FAILED",
          );
          if (current === null || !equalBuffers(current, secrets[index])) {
            refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_WRITE_FAILED");
          }
        } finally {
          if (current) current.fill(0);
        }
        await boundary(revalidate, reservation);
      }
    }
    let completedAt;
    try {
      const value = now();
      completedAt = (value instanceof Date ? value : new Date(value)).toISOString();
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLOCK_INVALID");
    }
    await boundary(revalidate, reservation);
    await verifyGeneratedValues(
      adapter,
      secrets,
      "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_WRITE_FAILED",
    );
    await boundary(revalidate, reservation);
    const receipt = immutable({
      schema_version: 1,
      kind: "v048_disposable_recovery_field_keychain_prep",
      status: "prepared",
      completed_at: completedAt,
      binding: publicBinding(checked),
      k0_approval_fingerprint: expectedApproval,
      single_operator_confirmed: true,
      all_absent_at_start: true,
      all_created_this_run: true,
      independent_values: true,
      provider_access: false,
      provider_mutation: false,
      campaign_items: LOCATORS.map((definition, index) => ({
        locator_sha256: definition.locator_sha256,
        value_sha256: valueHashes[index],
        purpose: definition.purpose,
        format: definition.format,
        created: true,
        readback_verified: true,
      })),
    });
    assertReceipt(receipt, checked, expectedApproval);
    await transition(onTransition, "before_finalization");
    await boundary(revalidate, reservation);
    try {
      finalizeReceipt(reservation, receipt);
    } catch {
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_FINALIZATION_FAILED");
    }
    finalized = true;
    await transition(onTransition, "after_finalization");
    const completed = readCompleted(output, checked, expectedApproval);
    await boundary(revalidate);
    await verifyGeneratedValues(
      adapter,
      secrets,
      "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED",
    );
    return completed;
  } catch (error) {
    if (error instanceof InjectedProcessDeath || finalized || resuming ||
        existsSync(output.commitPath)) throw error;
    try {
      await rollbackCreated({ keychain: adapter, secrets, attempted });
    } catch (rollbackError) {
      if (rollbackError instanceof DisposableRecoveryFieldKeychainPrepError &&
          rollbackError.code ===
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_ROLLBACK_UNPROVEN") {
        throw rollbackError;
      }
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_ROLLBACK_UNPROVEN");
    }
    if (error instanceof DisposableRecoveryFieldKeychainPrepError) throw error;
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_EXECUTION_FAILED");
  } finally {
    for (const secret of secrets) secret.fill(0);
    if (reservation && !finalized) abandonPrivateAggregateReceipt(reservation);
  }
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

function cleanResult(result) {
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
}

function strippedValue(buffer) {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 0x0a) end -= 1;
  if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
  return Buffer.from(buffer.subarray(0, end));
}

/** Fixed macOS transport. Secret values use stdin and readback, never argv. */
export function createDisposableRecoveryFieldKeychainPrep({
  platform = process.platform,
  environment = process.env,
  run = (command, args, options) => spawnSync(command, args, options),
  securityPath = DEFAULT_SECURITY_PATH,
  expectPath = DEFAULT_EXPECT_PATH,
  expectScriptPath = DEFAULT_EXPECT_SCRIPT_PATH,
} = {}) {
  checkedPlatform(platform);
  if (typeof run !== "function" || securityPath !== DEFAULT_SECURITY_PATH ||
      expectPath !== DEFAULT_EXPECT_PATH ||
      resolve(expectScriptPath) !== resolve(DEFAULT_EXPECT_SCRIPT_PATH)) {
    refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_INVALID");
  }
  const env = keychainChildEnvironment(environment);
  const checkedLocator = (locator) => {
    const fixed = LOCATORS.find((entry) =>
      entry.locator.service === locator?.service &&
      entry.locator.account === locator?.account &&
      (!locator.reference || locator.reference === entry.reference));
    if (!fixed) refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_INVALID");
    return fixed.locator;
  };
  const childOptions = (input = undefined) => ({
    encoding: null,
    env,
    ...(input === undefined ? {} : { input }),
    maxBuffer: MAX_KEYCHAIN_OUTPUT_BYTES,
    shell: false,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  const inspect = (locator) => {
    locator = checkedLocator(locator);
    const result = run(securityPath, [
      "find-generic-password", "-s", locator.service, "-a", locator.account,
    ], childOptions());
    const stderr = childBuffer(result?.stderr);
    try {
      if (!result?.error && !result?.signal && result?.status === 0) return "present";
      if (!result?.error && !result?.signal && missingResult(result, stderr)) {
        return "item_not_found";
      }
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
    } finally {
      stderr.fill(0);
      cleanResult(result);
    }
  };
  const read = (locator) => {
    locator = checkedLocator(locator);
    const result = run(securityPath, [
      "find-generic-password", "-s", locator.service, "-a", locator.account, "-w",
    ], childOptions());
    const stdout = childBuffer(result?.stdout);
    const stderr = childBuffer(result?.stderr);
    try {
      if (!result?.error && !result?.signal && missingResult(result, stderr)) return null;
      if (result?.error || result?.signal || result?.status !== 0 ||
          !stdout.length || stdout.length > MAX_KEYCHAIN_OUTPUT_BYTES) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
      }
      const value = strippedValue(stdout);
      if (!value.length || /[\r\n\0]/u.test(value.toString("utf8"))) {
        value.fill(0);
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
      }
      return value;
    } finally {
      stdout.fill(0);
      stderr.fill(0);
      cleanResult(result);
    }
  };
  const write = (locator, secretInput) => {
    locator = checkedLocator(locator);
    const secret = bufferValue(
      secretInput,
      "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED",
    );
    if (!secret?.length || secret.length >= MAX_KEYCHAIN_OUTPUT_BYTES) {
      if (secret) secret.fill(0);
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
    }
    const input = Buffer.alloc(secret.length + 1);
    secret.copy(input);
    input[input.length - 1] = 0x0a;
    try {
      const args = [
        expectScriptPath,
        securityPath,
        "add-generic-password",
        "-s", locator.service,
        "-a", locator.account,
        "-D", "application password",
        "-j", "Financial Brain disposable recovery field key",
        "-w",
      ];
      const metadata = [expectPath, ...args, ...Object.entries(env).flat()].join("\0");
      if (metadata.includes(secret.toString("utf8"))) {
        refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
      }
      const result = run(expectPath, args, childOptions(input));
      try {
        if (result?.error || result?.signal || result?.status !== 0) {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
        }
      } finally { cleanResult(result); }
      const verified = read(locator);
      try {
        if (verified === null || !equalBuffers(verified, secret)) {
          refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
        }
      } finally {
        if (verified) verified.fill(0);
      }
      return true;
    } finally {
      secret.fill(0);
      input.fill(0);
    }
  };
  const remove = (locator) => {
    locator = checkedLocator(locator);
    const result = run(securityPath, [
      "delete-generic-password", "-s", locator.service, "-a", locator.account,
    ], childOptions());
    const stderr = childBuffer(result?.stderr);
    try {
      if (!result?.error && !result?.signal &&
          (result?.status === 0 || missingResult(result, stderr))) return true;
      refuse("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_FAILED");
    } finally {
      stderr.fill(0);
      cleanResult(result);
    }
  };
  return Object.freeze({
    inspect: async (locator) => inspect(locator),
    read: async (locator) => read(locator),
    write: async (locator, secret) => write(locator, secret),
    delete: async (locator) => remove(locator),
  });
}
