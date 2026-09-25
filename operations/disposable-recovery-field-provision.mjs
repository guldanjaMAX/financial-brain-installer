/**
 * A1/A3 provisioning ceremony for the fixed v0.4.8 disposable field proof.
 *
 * Preview is local-only. Preflight performs GETs and writes one private
 * receipt. Mutation requires the exact receipt-derived approval, reserves its
 * receipt and generated manifest before any provider mutation, then creates
 * only the fixed D1, Vectorize, and immutable Worker identity. Every mutation
 * is journaled prepared-before-call. An unconfirmed call is never retried.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateOutputPath,
  assertPrivateAggregateReceiptDirectory,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptCommitPath,
  privateAggregateReceiptPendingPath,
  readPrivateAggregateReceipt,
  recoverPrivateAggregateReceiptFinalization,
  reservePrivateAggregateReceipt,
  resumePrivateAggregateReceiptReservation,
  validatePrivateAggregateReceiptReservation,
} from "./private-aggregate-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
  disposableRecoveryDeploymentJournalSha256,
  readDisposableRecoveryDeploymentJournal,
  runJournaledDisposableRecoveryDeploymentMutation,
  summarizeDisposableRecoveryDeploymentJournal,
} from "./disposable-recovery-deployment-journal.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL,
  assertDisposableRecoveryFieldKeychainVerificationCapability,
  disposableRecoveryFieldKeychainPreparationFingerprint,
} from "./disposable-recovery-field-keychain-prep.mjs";
import {
  V048_DISPOSABLE_CAMPAIGN,
  V048_DISPOSABLE_CAMPAIGN_CORPORA,
  validateV048DisposableCampaignManifest,
} from "./v048-disposable-campaign-contract.mjs";

export const DISPOSABLE_RECOVERY_FIELD_PROVISION_SCHEMA_VERSION = 1;
export const DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL =
  "v048-disposable-recovery-field-provision-v1";
export const DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES = Object.freeze({
  source_preflight: "v048-disposable-source-provision-preflight.json",
  source_phase: "v048-disposable-source-provision.json",
  source_journal: "v048-disposable-source-provision-journal.jsonl",
  source_manifest: "v048-disposable-source.manifest.json",
  target_preflight: "v048-disposable-target-provision-preflight.json",
  target_phase: "v048-disposable-target-provision.json",
  target_journal: "v048-disposable-target-provision-journal.jsonl",
  target_manifest: "v048-disposable-target.manifest.json",
});

const SHA256_RE = /^[a-f0-9]{64}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID_RE = /^[a-f0-9]{32}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const RESOURCES = Object.freeze({
  source: V048_DISPOSABLE_CAMPAIGN.source.name,
  target: V048_DISPOSABLE_CAMPAIGN.target.name,
});
const TARGET_BANK_KEY_LOCATOR =
  `keychain://${V048_DISPOSABLE_CAMPAIGN.target.name}/bank-wrapping-v2`;
const KEYCHAIN_PURPOSES = Object.freeze([
  "source_admin_key",
  "target_admin_key",
  "recovery_artifact_key",
  "bank_access_wrapping_key_v2",
]);
const KEYCHAIN_FORMATS = Object.freeze([
  "lowercase_hex_48",
  "lowercase_hex_48",
  "recovery_artifact_v1",
  "bank_access_wrapping_v2",
]);
const VECTOR_METADATA_INDEXES = Object.freeze([
  Object.freeze({ propertyName: "source", indexType: "string" }),
  Object.freeze({ propertyName: "client", indexType: "string" }),
  Object.freeze({ propertyName: "category", indexType: "string" }),
  Object.freeze({ propertyName: "top_folder", indexType: "string" }),
  Object.freeze({ propertyName: "platform", indexType: "string" }),
  Object.freeze({ propertyName: "document_date", indexType: "number" }),
]);

export class DisposableRecoveryFieldProvisionError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldProvisionError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldProvisionError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plainObject(value) &&
    canonical(Object.keys(value).sort()) === canonical([...keys].sort());
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
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) immutable(child);
  return value;
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) refuse("DISPOSABLE_RECOVERY_PROVISION_CLOCK_INVALID");
  return date.toISOString();
}

function checkedRole(value) {
  if (!Object.hasOwn(RESOURCES, value)) refuse("DISPOSABLE_RECOVERY_PROVISION_ROLE_INVALID");
  return value;
}

function checkedDirectory(value) {
  try {
    return assertPrivateAggregateReceiptDirectory(resolve(value), {
      code: "DISPOSABLE_RECOVERY_PROVISION_DIRECTORY_INVALID",
    }).path;
  } catch {
    refuse("DISPOSABLE_RECOVERY_PROVISION_DIRECTORY_INVALID");
  }
}

function exactPath(path, directory, expectedName, code) {
  const target = resolve(path || "");
  if (dirname(target) !== directory || basename(target) !== expectedName) refuse(code);
  return target;
}

function checkedHash(value, code) {
  if (!SHA256_RE.test(String(value ?? ""))) refuse(code);
  return value;
}

function checkedKeychainProof(proof, base, provider, role) {
  const code = "DISPOSABLE_RECOVERY_PROVISION_KEYCHAIN_PROOF_INVALID";
  try {
    assertDisposableRecoveryFieldKeychainVerificationCapability(proof);
  } catch {
    refuse(code);
  }
  if (!plainObject(proof) || proof.schema_version !== 1 ||
      proof.protocol !== DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_PROTOCOL ||
      typeof proof.revalidate !== "function" ||
      !Array.isArray(proof.campaign_keychain_locator_sha256) ||
      !Array.isArray(proof.campaign_keychain_value_sha256) ||
      !Array.isArray(proof.campaign_items) ||
      proof.campaign_keychain_locator_sha256.length !== KEYCHAIN_PURPOSES.length ||
      proof.campaign_keychain_value_sha256.length !== KEYCHAIN_PURPOSES.length ||
      proof.campaign_items.length !== KEYCHAIN_PURPOSES.length) refuse(code);
  for (const field of [
    "receipt_sha256", "preparation_fingerprint", "account_fingerprint",
    "keychain_binding_sha256",
  ]) checkedHash(proof[field], code);
  for (const values of [
    proof.campaign_keychain_locator_sha256,
    proof.campaign_keychain_value_sha256,
  ]) {
    if (values.some((value) => !SHA256_RE.test(String(value || ""))) ||
        new Set(values).size !== KEYCHAIN_PURPOSES.length) refuse(code);
  }
  const expectedPreparation = disposableRecoveryFieldKeychainPreparationFingerprint({
    candidate_sha: base.candidate_sha,
    candidate_tree_sha: base.candidate_tree_sha,
    package_sha256: base.package_sha256,
    field_receipt_sha256: base.field_receipt_sha256,
    account_id: provider.accountId,
  });
  if (proof.preparation_fingerprint !== expectedPreparation ||
      proof.account_fingerprint !== sha256(provider.accountId)) refuse(code);
  for (let index = 0; index < KEYCHAIN_PURPOSES.length; index += 1) {
    const item = proof.campaign_items[index];
    if (!exactKeys(item, ["purpose", "format", "locator_sha256", "value_sha256"]) ||
        item.purpose !== KEYCHAIN_PURPOSES[index] ||
        item.format !== KEYCHAIN_FORMATS[index] ||
        item.locator_sha256 !== proof.campaign_keychain_locator_sha256[index] ||
        item.value_sha256 !== proof.campaign_keychain_value_sha256[index]) refuse(code);
  }
  const evidenceBase = {
    schema_version: proof.schema_version,
    protocol: proof.protocol,
    receipt_sha256: proof.receipt_sha256,
    preparation_fingerprint: proof.preparation_fingerprint,
    account_fingerprint: proof.account_fingerprint,
    campaign_keychain_locator_sha256: proof.campaign_keychain_locator_sha256,
    campaign_keychain_value_sha256: proof.campaign_keychain_value_sha256,
    campaign_items: proof.campaign_items,
  };
  if (proof.keychain_binding_sha256 !== sha256(canonical(evidenceBase))) refuse(code);
  const expectedProviderLocatorHashes = role === "source"
    ? [sha256(provider.adminKeyLocator), null, null]
    : [
        sha256(provider.adminKeyLocator),
        sha256(provider.recoveryArtifactKeyLocator),
        sha256(provider.bankWrappingKeyLocator),
      ];
  const expectedCampaignLocatorHashes = role === "source"
    ? [proof.campaign_keychain_locator_sha256[0], null, null]
    : proof.campaign_keychain_locator_sha256.slice(1);
  if (canonical(expectedProviderLocatorHashes) !== canonical(expectedCampaignLocatorHashes)) {
    refuse(code);
  }
  return immutable(evidenceBase);
}

/** Bind provisioning to the same package/runtime closure used by A2/A4. */
export function disposableRecoveryProvisioningBinding(
  preparation,
  provider,
  roleInput,
  keychainProof,
) {
  const role = checkedRole(roleInput);
  const base = preparation?.binding;
  if (!plainObject(base) || provider?.role !== role || provider.resourceName !== RESOURCES[role] ||
      !ACCOUNT_ID_RE.test(String(provider.accountId || ""))) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_BINDING_INVALID");
  }
  for (const field of [
    "candidate_sha", "candidate_tree_sha", "field_receipt_run_id",
    "field_receipt_sha256", "package_filename", "package_bytes", "package_sha256",
    "package_file_count", "execution_inventory_sha256",
    "installed_execution_inventory_sha256", "wrangler_version",
    "wrangler_wrapper_sha256", "wrangler_runtime_inventory_sha256",
    "wrangler_entrypoint_sha256", "node_version", "node_executable_sha256",
  ]) {
    if (!Object.hasOwn(base, field)) refuse("DISPOSABLE_RECOVERY_PROVISION_BINDING_INVALID");
  }
  for (const field of [
    "field_receipt_sha256", "package_sha256", "execution_inventory_sha256",
    "installed_execution_inventory_sha256", "wrangler_wrapper_sha256",
    "wrangler_runtime_inventory_sha256", "wrangler_entrypoint_sha256",
    "node_executable_sha256",
  ]) checkedHash(base[field], "DISPOSABLE_RECOVERY_PROVISION_BINDING_INVALID");
  for (const field of [
    "candidateModuleInventorySha256", "migrationInventorySha256",
    "bootstrapModuleInventorySha256",
  ]) checkedHash(provider[field], "DISPOSABLE_RECOVERY_PROVISION_BINDING_INVALID");
  const checkedProof = checkedKeychainProof(keychainProof, base, provider, role);
  const bindingBase = {
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL,
    role,
    action: role === "source" ? "A1" : "A3",
    account_id: provider.accountId,
    resource_name: provider.resourceName,
    ...base,
    candidate_module_inventory_sha256: provider.candidateModuleInventorySha256,
    migration_inventory_sha256: provider.migrationInventorySha256,
    bootstrap_module_inventory_sha256: provider.bootstrapModuleInventorySha256,
    keychain_prep_receipt_sha256: checkedProof.receipt_sha256,
    keychain_preparation_fingerprint: checkedProof.preparation_fingerprint,
    keychain_account_fingerprint: checkedProof.account_fingerprint,
    campaign_keychain_items: checkedProof.campaign_items,
    keychain_binding_sha256: keychainProof.keychain_binding_sha256,
    admin_key_locator_sha256: sha256(provider.adminKeyLocator),
    ...(provider.recoveryArtifactKeyLocator
      ? { recovery_artifact_key_locator_sha256: sha256(provider.recoveryArtifactKeyLocator) }
      : {}),
    ...(provider.bankWrappingKeyLocator
      ? { bank_wrapping_key_locator_sha256: sha256(provider.bankWrappingKeyLocator) }
      : {}),
  };
  return immutable({
    ...bindingBase,
    campaign_fingerprint: sha256(canonical(bindingBase)),
  });
}

function collisionSemantic(value, binding, { afterD1 = null } = {}) {
  if (!plainObject(value) || value.account_id !== binding.account_id ||
      value.resource_name !== binding.resource_name ||
      !Array.isArray(value.worker_ids) || !Array.isArray(value.d1_ids) ||
      !Array.isArray(value.vectorize_names) || !Array.isArray(value.responses)) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_COLLISION_READ_INVALID");
  }
  const expectedD1Ids = afterD1 === null ? [] : [afterD1];
  if (value.worker_exists !== false || value.vectorize_exists !== false ||
      value.worker_ids.length !== 0 || value.vectorize_names.length !== 0 ||
      value.d1_exists !== (afterD1 !== null) ||
      canonical(value.d1_ids) !== canonical(expectedD1Ids)) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_COLLISION_REFUSED");
  }
  const evidence = value.responses.map((entry) => {
    if (!plainObject(entry) || entry.schema_version !== 1 || entry.status !== 200 ||
        !SHA256_RE.test(String(entry.body_sha256 || ""))) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_COLLISION_READ_INVALID");
    }
    return {
      operation: String(entry.operation || ""),
      schema_version: 1,
      status: 200,
      content_type: String(entry.content_type || ""),
      body_sha256: entry.body_sha256,
    };
  });
  return immutable({
    account_id: value.account_id,
    resource_name: value.resource_name,
    worker_exists: false,
    d1_exists: afterD1 !== null,
    vectorize_exists: false,
    expected_d1_id: afterD1,
    evidence,
  });
}

async function boundary(revalidate, reservation = null) {
  let valid;
  try { valid = await revalidate(); }
  catch { refuse("DISPOSABLE_RECOVERY_PROVISION_EVIDENCE_CHANGED"); }
  if (valid !== true) refuse("DISPOSABLE_RECOVERY_PROVISION_EVIDENCE_CHANGED");
  if (reservation) {
    try {
      validatePrivateAggregateReceiptReservation(reservation, {
        code: "DISPOSABLE_RECOVERY_PROVISION_RESERVATION_CHANGED",
      });
    } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_RESERVATION_CHANGED"); }
  }
  return true;
}

function keychainBoundRevalidator(binding, keychainProof, evidenceRevalidate) {
  let proof;
  try {
    proof = assertDisposableRecoveryFieldKeychainVerificationCapability(
      keychainProof,
      binding?.keychain_binding_sha256,
    );
  } catch {
    refuse("DISPOSABLE_RECOVERY_PROVISION_KEYCHAIN_PROOF_INVALID");
  }
  if (typeof evidenceRevalidate !== "function") {
    refuse("DISPOSABLE_RECOVERY_PROVISION_KEYCHAIN_PROOF_INVALID");
  }
  return async () => {
    let evidenceValid;
    let keychainValid;
    try {
      evidenceValid = await evidenceRevalidate();
      if (evidenceValid === true) keychainValid = await proof.revalidate();
    } catch {
      refuse("DISPOSABLE_RECOVERY_PROVISION_KEYCHAIN_PROOF_INVALID");
    }
    if (evidenceValid !== true || keychainValid !== true) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_KEYCHAIN_PROOF_INVALID");
    }
    return true;
  };
}

async function doubleCollisionRead(provider, binding, revalidate, options = {}) {
  await boundary(revalidate);
  const first = collisionSemantic(await provider.readCollisions(), binding, options);
  await boundary(revalidate);
  const second = collisionSemantic(await provider.readCollisions(), binding, options);
  await boundary(revalidate);
  const firstSemantic = { ...first, evidence: undefined };
  const secondSemantic = { ...second, evidence: undefined };
  if (canonical(firstSemantic) !== canonical(secondSemantic)) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_COLLISION_CHANGED");
  }
  return immutable({ first, second, stable_semantic_sha256: sha256(canonical(firstSemantic)) });
}

function receiptOutput(path, directory, expectedName, code) {
  const target = exactPath(path, directory, expectedName, code);
  try { return assertPrivateAggregateOutputPath(target, { code }); }
  catch { refuse(code); }
}

function resumedReceiptOutput(path, directory, expectedName, code) {
  const target = exactPath(path, directory, expectedName, code);
  let parent;
  try {
    parent = assertPrivateAggregateReceiptDirectory(directory, { code });
  } catch { refuse(code); }
  return Object.freeze({
    path: target,
    pendingPath: privateAggregateReceiptPendingPath(target),
    parent,
  });
}

function reserveOutput(output, marker, code) {
  try { return reservePrivateAggregateReceipt(output, marker); }
  catch { refuse(code); }
}

function finalizeOutput(
  reservation,
  value,
  code,
  finalizeReceipt = finalizePrivateAggregateReceipt,
) {
  try {
    if (finalizeReceipt(reservation, value) !== true) refuse(code);
    const loaded = readPrivateAggregateReceipt(reservation.path, { code });
    if (canonical(loaded.value) !== canonical(value)) refuse(code);
    return loaded;
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldProvisionError) throw error;
    refuse(code);
  }
}

function validatePreflightReceipt(value, binding) {
  if (!plainObject(value) || value.schema_version !== 1 ||
      value.protocol !== DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL ||
      value.kind !== `${binding.role}_provision_preflight` || value.status !== "passed" ||
      canonical(value.binding) !== canonical(binding) ||
      !plainObject(value.snapshot) ||
      !SHA256_RE.test(String(value.snapshot.stable_semantic_sha256 || "")) ||
      !Array.isArray(value.snapshot.reads) || value.snapshot.reads.length !== 2 ||
      typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at))) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_PREFLIGHT_RECEIPT_INVALID");
  }
  return value;
}

export function disposableRecoveryProvisionApprovalFingerprint(binding, preflightSha256) {
  checkedHash(preflightSha256, "DISPOSABLE_RECOVERY_PROVISION_APPROVAL_INVALID");
  return sha256(canonical({
    schema_version: 1,
    protocol: `${DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL}-approval`,
    action: binding.action,
    role: binding.role,
    binding,
    preflight_sha256: preflightSha256,
  }));
}

export async function runDisposableRecoveryProvisionPreflight({
  binding,
  keychainProof,
  provider,
  receiptPath,
  expectedReceiptDirectory,
  revalidate: evidenceRevalidate = () => true,
  now = () => new Date(),
}) {
  const role = checkedRole(binding?.role);
  const revalidate = keychainBoundRevalidator(
    binding,
    keychainProof,
    evidenceRevalidate,
  );
  if (provider?.role !== role || typeof provider.readCollisions !== "function") {
    refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_INVALID");
  }
  const directory = checkedDirectory(expectedReceiptDirectory);
  const output = receiptOutput(
    receiptPath, directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_preflight`],
    "DISPOSABLE_RECOVERY_PROVISION_PREFLIGHT_PATH_INVALID",
  );
  const marker = immutable({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL,
    kind: `${role}_provision_preflight_pending`,
    status: "read_only_provider_result_unconfirmed",
    binding,
  });
  const reservation = reserveOutput(output, marker,
    "DISPOSABLE_RECOVERY_PROVISION_PREFLIGHT_PATH_INVALID");
  let finalized = false;
  try {
    await boundary(revalidate, reservation);
    const snapshot = await doubleCollisionRead(provider, binding, revalidate);
    const receipt = immutable({
      schema_version: 1,
      protocol: DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL,
      kind: `${role}_provision_preflight`,
      status: "passed",
      completed_at: isoNow(now),
      binding,
      snapshot: {
        stable_semantic_sha256: snapshot.stable_semantic_sha256,
        reads: [snapshot.first, snapshot.second],
      },
    });
    validatePreflightReceipt(receipt, binding);
    await boundary(revalidate, reservation);
    const loaded = finalizeOutput(reservation, receipt,
      "DISPOSABLE_RECOVERY_PROVISION_PREFLIGHT_FINALIZATION_FAILED");
    finalized = true;
    return immutable({ receipt, receiptSha256: loaded.sha256 });
  } finally {
    if (!finalized) abandonPrivateAggregateReceipt(reservation);
  }
}

function readPreflight(path, directory, role, binding) {
  const target = exactPath(
    path, directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_preflight`],
    "DISPOSABLE_RECOVERY_PROVISION_PREFLIGHT_RECEIPT_INVALID",
  );
  try {
    const loaded = readPrivateAggregateReceipt(target, {
      code: "DISPOSABLE_RECOVERY_PROVISION_PREFLIGHT_RECEIPT_INVALID",
    });
    validatePreflightReceipt(loaded.value, binding);
    return loaded;
  } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_PREFLIGHT_RECEIPT_INVALID"); }
}

function providerResultValidator(value) {
  if (!plainObject(value) || !plainObject(value.provider_metadata) ||
      !plainObject(value.result)) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_RESULT_INVALID");
  }
  return value;
}

async function journalMutation({
  binding, role, directory, journalPath, step, effect, request, mutate, reconcile,
  beforeBoundary,
}) {
  return runJournaledDisposableRecoveryDeploymentMutation({
    binding,
    phase: `${role}_provision`,
    step,
    effect,
    request,
    journalPath,
    expectedJournalDirectory: directory,
    mutate: async () => {
      await beforeBoundary();
      const result = await mutate();
      await beforeBoundary();
      return result;
    },
    ...(typeof reconcile === "function" ? {
      reconcile: async () => {
        await beforeBoundary();
        const result = await reconcile();
        await beforeBoundary();
        return result;
      },
    } : {}),
    validate: providerResultValidator,
  });
}

function manifestFor(binding, provider, finalState) {
  const source = binding.role === "source";
  const campaignRole = source
    ? V048_DISPOSABLE_CAMPAIGN.source
    : V048_DISPOSABLE_CAMPAIGN.target;
  return immutable({
    manifest_version: 1,
    client: {
      slug: V048_DISPOSABLE_CAMPAIGN.clientSlug,
      display_name: V048_DISPOSABLE_CAMPAIGN.displayName,
    },
    brain: {
      version: V048_DISPOSABLE_CAMPAIGN.version,
      domain: finalState.hostname,
      worker_name: binding.resource_name,
    },
    infrastructure: {
      cloudflare: {
        account_id: binding.account_id,
        storage: "d1",
        worker_id: finalState.worker_id,
        d1_database_name: binding.resource_name,
        d1_database_id: finalState.database_id,
        vectorize_index: binding.resource_name,
      },
    },
    corpora: Object.fromEntries(
      V048_DISPOSABLE_CAMPAIGN_CORPORA.map((name) => [name, { enabled: false }]),
    ),
    retrieval: {
      embed_model: V048_DISPOSABLE_CAMPAIGN.retrieval.embedModel,
      embed_dimensions: V048_DISPOSABLE_CAMPAIGN.retrieval.embedDimensions,
      chunk_size: 1500,
      chunk_overlap: 300,
      answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    },
    safety: {
      credential_scanner: { enabled: true, gate_version: 5, mode: "refuse" },
      daily_llm_spend_cap_usd: 10,
      ocr: { enabled: false, model: "@cf/meta/llama-4-scout-17b-16e-instruct" },
    },
    operations: source
      ? { admin_key_secret: campaignRole.adminKeyLocator }
      : {
          admin_key_secret: campaignRole.adminKeyLocator,
          recovery_artifact_key_secret: campaignRole.artifactKeyLocator,
          bank_access_wrapping_key_secret: TARGET_BANK_KEY_LOCATOR,
          recovery_field_gate: { routes: [], custom_domains: [] },
        },
  });
}

function validateProviderLocators(binding, provider) {
  if (typeof provider.adminKeyLocator !== "string" ||
      sha256(provider.adminKeyLocator) !== binding.admin_key_locator_sha256) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_CHANGED");
  }
  for (const [valueField, hashField] of [
    ["recoveryArtifactKeyLocator", "recovery_artifact_key_locator_sha256"],
    ["bankWrappingKeyLocator", "bank_wrapping_key_locator_sha256"],
  ]) {
    const present = Object.hasOwn(binding, hashField);
    const value = provider[valueField];
    if (present !== (typeof value === "string") ||
        present && sha256(value) !== binding[hashField]) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_CHANGED");
    }
  }
  return true;
}

function validateFinalSemantic(value, binding) {
  const keys = [
    "account_id", "role", "resource_name", "worker_id", "worker_created_on",
    "worker_tag_sha256", "hostname",
    "database_id", "active_deployment_id", "active_version_id", "active_script_etag",
    "active_traffic_percent", "baseline_mode", "bindings_sha256", "resource",
    "bootstrap_tag_sha256",
    "schema_version", "user_tables", "content_rows", "vector_count",
    "vectorize_created_on", "metadata_indexes_sha256",
  ];
  const resourceKeys = [
    "custom_domains_count", "d1_exists", "d1_name_and_id_exact", "previews_enabled",
    "routes_count", "schedules_count", "vector_count", "vector_dimensions",
    "vector_metric", "vectorize_exists", "vectorize_name_exact", "worker_exists",
    "workers_dev_enabled",
  ];
  if (!exactKeys(value, keys) || value.account_id !== binding.account_id ||
      value.role !== binding.role || value.resource_name !== binding.resource_name ||
      !WORKER_ID_RE.test(String(value.worker_id || "")) ||
      !UUID_RE.test(String(value.database_id || "")) ||
      !UUID_RE.test(String(value.active_deployment_id || "")) ||
      !UUID_RE.test(String(value.active_version_id || "")) ||
      typeof value.active_script_etag !== "string" || value.active_script_etag.length < 1 ||
      value.active_traffic_percent !== 100 || value.baseline_mode !== "maintenance-bootstrap" ||
      !SHA256_RE.test(String(value.bindings_sha256 || "")) ||
      !SHA256_RE.test(String(value.worker_tag_sha256 || "")) ||
      !SHA256_RE.test(String(value.bootstrap_tag_sha256 || "")) ||
      !SHA256_RE.test(String(value.metadata_indexes_sha256 || "")) ||
      !Number.isFinite(Date.parse(value.worker_created_on)) ||
      !Number.isFinite(Date.parse(value.vectorize_created_on)) ||
      typeof value.hostname !== "string" ||
      !value.hostname.startsWith(`${binding.resource_name}.`) ||
      !exactKeys(value.resource, resourceKeys) ||
      value.resource.worker_exists !== true || value.resource.d1_exists !== true ||
      value.resource.d1_name_and_id_exact !== true || value.resource.vectorize_exists !== true ||
      value.resource.vectorize_name_exact !== true || value.resource.workers_dev_enabled !== true ||
      value.resource.previews_enabled !== false || value.resource.custom_domains_count !== 0 ||
      value.resource.routes_count !== 0 || value.resource.schedules_count !== 0 ||
      value.resource.vector_count !== 0 || value.resource.vector_dimensions !== 768 ||
      value.resource.vector_metric !== "cosine" || value.content_rows !== 0 ||
      value.vector_count !== 0 ||
      binding.role === "source" && (value.schema_version !== 46 || value.user_tables !== null) ||
      binding.role === "target" && (value.schema_version !== null || value.user_tables !== 0)) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_FINAL_READBACK_INVALID");
  }
  return value;
}

function noSecretMaterial(value) {
  const forbiddenKeys = new Set([
    "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY", "BANK_FEED_WRAPPING_KEY_V2",
    "admin_key", "rag_proxy_key", "session_signing_key", "bank_feed_wrapping_key_v2",
    "secret_bindings", "secret_text", "secret_values", "raw_body",
  ]);
  const walk = (entry) => {
    if (Array.isArray(entry)) return entry.every(walk);
    if (!entry || typeof entry !== "object") return true;
    return Object.entries(entry).every(([key, child]) =>
      !forbiddenKeys.has(key) && walk(child));
  };
  return walk(value);
}

function validateProvisionReceiptArtifact(
  value,
  binding,
  preflightSha256,
  approvalFingerprint,
  manifestSha256 = null,
) {
  if (!exactKeys(value, [
    "schema_version", "protocol", "kind", "status", "action", "completed_at", "binding",
    "preflight_sha256", "approval_fingerprint", "journal", "manifest_sha256",
    "final_state", "final_readback_sha256",
  ]) || value.schema_version !== 1 ||
      value.protocol !== DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL ||
      value.kind !== `${binding.role}_provision` || value.status !== "passed" ||
      value.action !== binding.action || !Number.isFinite(Date.parse(value.completed_at)) ||
      canonical(value.binding) !== canonical(binding) ||
      value.preflight_sha256 !== preflightSha256 ||
      value.approval_fingerprint !== approvalFingerprint ||
      value.approval_fingerprint !== disposableRecoveryProvisionApprovalFingerprint(
        binding, preflightSha256,
      ) ||
      !SHA256_RE.test(String(value.manifest_sha256 || "")) ||
      manifestSha256 !== null && value.manifest_sha256 !== manifestSha256 ||
      !SHA256_RE.test(String(value.final_readback_sha256 || "")) ||
      !exactKeys(value.journal, [
        "schema_version", "protocol", "journal_protocol", "phase", "binding_sha256",
        "through_sequence", "event_count", "head_sha256", "event_manifest_sha256",
      ]) || value.journal.schema_version !== 1 ||
      value.journal.protocol !== DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL ||
      value.journal.journal_protocol !== DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL ||
      value.journal.phase !== `${binding.role}_provision` ||
      value.journal.binding_sha256 !==
        disposableRecoveryDeploymentJournalSha256(binding) ||
      value.journal.through_sequence !== (binding.role === "source" ? 22 : 20) ||
      value.journal.event_count !== value.journal.through_sequence ||
      !SHA256_RE.test(String(value.journal.binding_sha256 || "")) ||
      !SHA256_RE.test(String(value.journal.head_sha256 || "")) ||
      !SHA256_RE.test(String(value.journal.event_manifest_sha256 || "")) ||
      !noSecretMaterial(value)) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_RECEIPT_INVALID");
  }
  validateFinalSemantic(value.final_state, binding);
  return true;
}

function validateProvisionManifestArtifact(value, binding, finalState = null) {
  const source = binding.role === "source";
  const expectedOperations = source
    ? ["admin_key_secret"]
    : [
        "admin_key_secret", "bank_access_wrapping_key_secret",
        "recovery_artifact_key_secret", "recovery_field_gate",
      ];
  const expectedRetrieval = {
    embed_model: V048_DISPOSABLE_CAMPAIGN.retrieval.embedModel,
    embed_dimensions: V048_DISPOSABLE_CAMPAIGN.retrieval.embedDimensions,
    chunk_size: 1500,
    chunk_overlap: 300,
    answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  };
  const expectedCorpora = Object.fromEntries(
    V048_DISPOSABLE_CAMPAIGN_CORPORA.map((name) => [name, { enabled: false }]),
  );
  const expectedRole = source
    ? V048_DISPOSABLE_CAMPAIGN.source
    : V048_DISPOSABLE_CAMPAIGN.target;
  const expectedSafety = {
    credential_scanner: { enabled: true, gate_version: 5, mode: "refuse" },
    daily_llm_spend_cap_usd: 10,
    ocr: { enabled: false, model: "@cf/meta/llama-4-scout-17b-16e-instruct" },
  };
  const cloudflare = value?.infrastructure?.cloudflare;
  const operations = value?.operations;
  if (!exactKeys(value, [
    "manifest_version", "client", "brain", "infrastructure", "corpora", "retrieval",
    "safety", "operations",
  ]) || value.manifest_version !== 1 ||
      canonical(value.client) !== canonical({
        slug: V048_DISPOSABLE_CAMPAIGN.clientSlug,
        display_name: V048_DISPOSABLE_CAMPAIGN.displayName,
      }) || !exactKeys(value.brain, ["version", "domain", "worker_name"]) ||
      value.brain.version !== V048_DISPOSABLE_CAMPAIGN.version ||
      value.brain.worker_name !== binding.resource_name ||
      typeof value.brain.domain !== "string" ||
      !value.brain.domain.startsWith(`${binding.resource_name}.`) ||
      !exactKeys(value.infrastructure, ["cloudflare"]) ||
      !exactKeys(cloudflare, [
        "account_id", "storage", "worker_id", "d1_database_name", "d1_database_id",
        "vectorize_index",
      ]) || cloudflare.account_id !== binding.account_id || cloudflare.storage !== "d1" ||
      !WORKER_ID_RE.test(String(cloudflare.worker_id || "")) ||
      !UUID_RE.test(String(cloudflare.d1_database_id || "")) ||
      cloudflare.d1_database_name !== binding.resource_name ||
      cloudflare.vectorize_index !== binding.resource_name ||
      canonical(value.corpora) !== canonical(expectedCorpora) ||
      canonical(value.retrieval) !== canonical(expectedRetrieval) ||
      canonical(value.safety) !== canonical(expectedSafety) ||
      !exactKeys(operations, expectedOperations) ||
      operations.admin_key_secret !== expectedRole.adminKeyLocator ||
      sha256(operations.admin_key_secret) !== binding.admin_key_locator_sha256 ||
      source === Object.hasOwn(operations, "recovery_artifact_key_secret") ||
      source === Object.hasOwn(operations, "bank_access_wrapping_key_secret") ||
      !source && (
        operations.recovery_artifact_key_secret !== expectedRole.artifactKeyLocator ||
        operations.bank_access_wrapping_key_secret !== TARGET_BANK_KEY_LOCATOR ||
        !exactKeys(operations.recovery_field_gate, ["routes", "custom_domains"]) ||
        !Array.isArray(operations.recovery_field_gate.routes) ||
        operations.recovery_field_gate.routes.length !== 0 ||
        !Array.isArray(operations.recovery_field_gate.custom_domains) ||
        operations.recovery_field_gate.custom_domains.length !== 0 ||
        sha256(operations.recovery_artifact_key_secret) !==
          binding.recovery_artifact_key_locator_sha256 ||
        sha256(operations.bank_access_wrapping_key_secret) !==
          binding.bank_wrapping_key_locator_sha256
      ) || !noSecretMaterial(value)) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID");
  }
  if (finalState !== null && (
    value.brain.domain !== finalState.hostname ||
    cloudflare.worker_id !== finalState.worker_id ||
    cloudflare.d1_database_id !== finalState.database_id
  )) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID");
  }
  try {
    validateV048DisposableCampaignManifest(value, binding.role);
  } catch {
    refuse("DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID");
  }
  return true;
}

export async function runDisposableRecoveryProvisionPhase({
  binding,
  keychainProof,
  provider,
  preflightReceiptPath,
  approvalFingerprint,
  journalPath: journalPathInput,
  receiptPath,
  manifestPath,
  expectedReceiptDirectory,
  resume = false,
  revalidate: evidenceRevalidate = () => true,
  checkpoint = async () => true,
  now = () => new Date(),
  finalizeReceipt = finalizePrivateAggregateReceipt,
  recoverFinalization = recoverPrivateAggregateReceiptFinalization,
}) {
  const role = checkedRole(binding?.role);
  const revalidate = keychainBoundRevalidator(
    binding,
    keychainProof,
    evidenceRevalidate,
  );
  if (typeof resume !== "boolean") {
    refuse("DISPOSABLE_RECOVERY_PROVISION_RESUME_INVALID");
  }
  if (typeof checkpoint !== "function" || typeof finalizeReceipt !== "function" ||
      typeof recoverFinalization !== "function") {
    refuse("DISPOSABLE_RECOVERY_PROVISION_DEPENDENCY_INVALID");
  }
  if (provider?.role !== role || typeof provider.createMutationProvider !== "function") {
    refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_INVALID");
  }
  const directory = checkedDirectory(expectedReceiptDirectory);
  const preflight = readPreflight(preflightReceiptPath, directory, role, binding);
  const expectedApproval = disposableRecoveryProvisionApprovalFingerprint(binding, preflight.sha256);
  if (approvalFingerprint !== expectedApproval) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_APPROVAL_INVALID");
  }
  const journalPath = exactPath(
    journalPathInput, directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_journal`],
    "DISPOSABLE_RECOVERY_PROVISION_JOURNAL_PATH_INVALID",
  );
  const journalExisted = existsSync(journalPath);
  if (!resume && journalExisted) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_RECONCILIATION_REQUIRED");
  }
  const outputBuilder = resume ? resumedReceiptOutput : receiptOutput;
  const receiptOutputValue = outputBuilder(
    receiptPath, directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_phase`],
    "DISPOSABLE_RECOVERY_PROVISION_RECEIPT_PATH_INVALID",
  );
  const manifestOutput = outputBuilder(
    manifestPath, directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_manifest`],
    "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_PATH_INVALID",
  );
  const markerBase = {
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL,
    status: "provider_result_unconfirmed_no_retry",
    binding,
    preflight_sha256: preflight.sha256,
    approval_fingerprint: expectedApproval,
  };
  const marker = { ...markerBase, kind: `${role}_provision_pending` };
  const manifestMarker = { ...markerBase, kind: `${role}_manifest_pending` };
  validateProviderLocators(binding, provider);
  const assertLinkedEvidence = async () => {
    await boundary(revalidate);
    const linked = readPreflight(preflightReceiptPath, directory, role, binding);
    if (linked.sha256 !== preflight.sha256) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_EVIDENCE_CHANGED");
    }
    await boundary(revalidate);
    return true;
  };
  const recoverOutputFinalization = async (output, outputMarker, validator) => {
    const commitPath = privateAggregateReceiptCommitPath(output.path);
    if (!existsSync(commitPath)) return null;
    await assertLinkedEvidence();
    let recovered;
    try {
      recovered = recoverFinalization(
        { ...output, commitPath }, outputMarker, validator,
      );
    } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_RESUME_INVALID"); }
    await assertLinkedEvidence();
    return recovered;
  };
  if (resume) {
    await recoverOutputFinalization(receiptOutputValue, marker, (candidate) =>
      validateProvisionReceiptArtifact(
        candidate, binding, preflight.sha256, expectedApproval,
      ));
    await recoverOutputFinalization(manifestOutput, manifestMarker, (candidate) =>
      validateProvisionManifestArtifact(candidate, binding));
  }
  if (resume && !existsSync(receiptOutputValue.pendingPath) &&
      !existsSync(privateAggregateReceiptCommitPath(receiptOutputValue.path))) {
    await assertLinkedEvidence();
    const completed = readDisposableRecoveryProvisionArtifacts({
      receiptPath, manifestPath, expectedReceiptDirectory: directory, role,
    });
    await assertLinkedEvidence();
    return completed;
  }
  let receiptReservation;
  try {
    receiptReservation = resume
      ? resumePrivateAggregateReceiptReservation(receiptOutputValue, marker)
      : reserveOutput(receiptOutputValue, marker,
        "DISPOSABLE_RECOVERY_PROVISION_RECEIPT_PATH_INVALID");
  } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_RESUME_INVALID"); }
  let manifestReservation;
  let existingManifestLoaded = null;
  let receiptFinalized = false;
  let manifestFinalized = false;
  let mutationProvider;
  try {
    await checkpoint("receipt_reserved");
    if (resume && !existsSync(manifestOutput.pendingPath)) {
      if (existsSync(manifestOutput.path)) {
        try {
          existingManifestLoaded = readPrivateAggregateReceipt(manifestOutput.path, {
            code: "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID",
          });
          manifestFinalized = true;
        } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_RESUME_INVALID"); }
      } else {
        // A crash may occur after the receipt reservation is durable but
        // before the manifest reservation starts. Reserve only the exact
        // still-absent companion output under the original marker binding.
        const freshManifestOutput = receiptOutput(
          manifestPath, directory,
          DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_manifest`],
          "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_PATH_INVALID",
        );
        try {
          manifestReservation = reserveOutput(
            freshManifestOutput, manifestMarker,
            "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_PATH_INVALID",
          );
        } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_RESUME_INVALID"); }
      }
    } else {
      try {
        manifestReservation = resume
          ? resumePrivateAggregateReceiptReservation(manifestOutput, manifestMarker)
          : reserveOutput(manifestOutput, manifestMarker,
            "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_PATH_INVALID");
      } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_RESUME_INVALID"); }
    }
    await checkpoint("manifest_reserved");
    const beforeBoundary = async () => {
      await boundary(revalidate, receiptReservation);
      if (manifestReservation) await boundary(revalidate, manifestReservation);
      if (existingManifestLoaded) {
        let current;
        try {
          current = readPrivateAggregateReceipt(manifestOutput.path, {
            code: "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID",
          });
        } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_EVIDENCE_CHANGED"); }
        if (current.sha256 !== existingManifestLoaded.sha256) {
          refuse("DISPOSABLE_RECOVERY_PROVISION_EVIDENCE_CHANGED");
        }
      }
      const linked = readPreflight(preflightReceiptPath, directory, role, binding);
      if (linked.sha256 !== preflight.sha256) {
        refuse("DISPOSABLE_RECOVERY_PROVISION_EVIDENCE_CHANGED");
      }
      return true;
    };
    await beforeBoundary();
    // This call resolves all role-specific Keychain values before the first
    // provider operation. Values remain closure-local and never enter a marker,
    // journal, manifest, or receipt.
    mutationProvider = await provider.createMutationProvider();
    await beforeBoundary();
    validateProviderLocators(binding, provider);
    let resumeRecords = [];
    if (journalExisted) {
      try {
        resumeRecords = readDisposableRecoveryDeploymentJournal(journalPath, {
          expectedJournalDirectory: directory,
        });
      } catch { refuse("DISPOSABLE_RECOVERY_PROVISION_RECONCILIATION_REQUIRED"); }
    } else {
      collisionSemantic(await provider.readCollisions(), binding);
    }

    const d1 = await journalMutation({
      binding, role, directory, journalPath,
      step: "create_d1", effect: "create_d1_database",
      request: { action: binding.action, account_id: binding.account_id,
        resource_name: binding.resource_name, kind: "d1" },
      mutate: mutationProvider.createD1,
      reconcile: () => mutationProvider.reconcileD1(beforeBoundary),
      beforeBoundary,
    });
    // With no Worker identity and no Vectorize index, this exact D1 UUID is the
    // only campaign resource. This is A3's no-competing-writer attestation
    // immediately before creating its vector index.
    if (!journalExisted || resumeRecords.length <= 2) {
      await beforeBoundary();
      collisionSemantic(await provider.readCollisions(), binding, { afterD1: d1.database_id });
    }
    const vector = await journalMutation({
      binding, role, directory, journalPath,
      step: "create_vectorize", effect: "create_vectorize_index",
      request: { action: binding.action, account_id: binding.account_id,
        resource_name: binding.resource_name, dimensions: 768, metric: "cosine" },
      mutate: mutationProvider.createVectorize,
      reconcile: () => mutationProvider.reconcileVectorize(d1.database_id, beforeBoundary),
      beforeBoundary,
    });
    if (vector.accepted !== true || typeof vector.created_on !== "string" ||
        !Number.isFinite(Date.parse(vector.created_on))) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_RESULT_INVALID");
    }
    for (const { propertyName, indexType } of VECTOR_METADATA_INDEXES) {
      const metadata = await journalMutation({
        binding, role, directory, journalPath,
        step: `create_metadata_${propertyName}`,
        effect: "create_vectorize_metadata_index",
        request: { action: binding.action, account_id: binding.account_id,
          resource_name: binding.resource_name, property_name: propertyName,
          index_type: indexType },
        mutate: () => mutationProvider.createMetadataIndex({ propertyName, indexType }),
        reconcile: () => mutationProvider.reconcileMetadataIndex(
          { propertyName, indexType }, beforeBoundary,
        ),
        beforeBoundary,
      });
      if (metadata.property_name !== propertyName || metadata.index_type !== indexType) {
        refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_RESULT_INVALID");
      }
    }
    const worker = await journalMutation({
      binding, role, directory, journalPath,
      step: "create_worker_identity", effect: "create_worker_identity",
      request: { action: binding.action, account_id: binding.account_id,
        resource_name: binding.resource_name, workers_dev_enabled: true,
        previews_enabled: false,
        worker_tag_sha256: sha256(
          `v048-field-${role}-${binding.campaign_fingerprint}`,
        ) },
      mutate: () => mutationProvider.createWorker({
        campaignFingerprint: binding.campaign_fingerprint,
      }),
      reconcile: () => mutationProvider.reconcileWorker(
        d1.database_id, binding.campaign_fingerprint, beforeBoundary,
      ),
      beforeBoundary,
    });
    if (!WORKER_ID_RE.test(worker.worker_id)) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_RESULT_INVALID");
    }
    let schema = null;
    if (role === "source") {
      schema = await journalMutation({
        binding, role, directory, journalPath,
        step: "initialize_source_schema", effect: "initialize_d1_schema",
        request: { action: "A1", database_id: d1.database_id, schema_version: 46,
          migration_inventory_sha256: binding.migration_inventory_sha256,
          content_rows: 0 },
        mutate: () => mutationProvider.initializeSourceSchema(d1.database_id, beforeBoundary),
        reconcile: () => mutationProvider.reconcileSourceSchema(
          d1.database_id, beforeBoundary,
        ),
        beforeBoundary,
      });
    }
    await beforeBoundary();
    const identity = await mutationProvider.readFinalIdentity?.({
      databaseId: d1.database_id, workerId: worker.worker_id,
      campaignFingerprint: binding.campaign_fingerprint,
    });
    const hostname = identity?.hostname ||
      `${binding.resource_name}.unknown.workers.dev`;
    if (!identity?.hostname) {
      // The real provider intentionally exposes this exact-ID read; injected
      // providers in tests must implement it too before a mutation can pass.
      refuse("DISPOSABLE_RECOVERY_PROVISION_WORKER_IDENTITY_UNCONFIRMED");
    }
    const baseline = await journalMutation({
      binding, role, directory, journalPath,
      step: "create_active_baseline", effect: "create_worker_baseline",
      request: { action: binding.action, account_id: binding.account_id,
        resource_name: binding.resource_name, worker_id: worker.worker_id,
        database_id: d1.database_id, hostname,
        bootstrap_module_inventory_sha256: binding.bootstrap_module_inventory_sha256,
        mode: "maintenance-bootstrap", traffic_percent: 100 },
      mutate: () => mutationProvider.createBaseline({
        databaseId: d1.database_id, workerId: worker.worker_id, hostname,
        campaignFingerprint: binding.campaign_fingerprint,
      }),
      reconcile: () => mutationProvider.reconcileBaseline({
        databaseId: d1.database_id, workerId: worker.worker_id, hostname,
        campaignFingerprint: binding.campaign_fingerprint,
      }, beforeBoundary),
      beforeBoundary,
    });
    if (!UUID_RE.test(baseline.version_id)) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_PROVIDER_RESULT_INVALID");
    }
    await beforeBoundary();
    const first = await mutationProvider.readFinal({
      databaseId: d1.database_id, workerId: worker.worker_id,
      vectorCreatedOn: vector.created_on,
      baselineVersionId: baseline.version_id,
      campaignFingerprint: binding.campaign_fingerprint,
    });
    await beforeBoundary();
    const second = await mutationProvider.readFinal({
      databaseId: d1.database_id, workerId: worker.worker_id,
      vectorCreatedOn: vector.created_on,
      baselineVersionId: baseline.version_id,
      campaignFingerprint: binding.campaign_fingerprint,
    });
    validateFinalSemantic(first?.semantic, binding);
    validateFinalSemantic(second?.semantic, binding);
    if (
        canonical(first.semantic) !== canonical(second.semantic) ||
        first.semantic.worker_id !== worker.worker_id ||
        first.semantic.database_id !== d1.database_id ||
        first.semantic.resource_name !== binding.resource_name ||
        first.semantic.account_id !== binding.account_id ||
        first.semantic.active_version_id !== baseline.version_id ||
        first.semantic.vector_count !== 0 || first.semantic.content_rows !== 0 ||
        role === "source" && (first.semantic.schema_version !== 46 ||
          schema?.schema_version !== 46) ||
        role === "target" && first.semantic.user_tables !== 0) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_FINAL_READBACK_INVALID");
    }
    const journal = summarizeDisposableRecoveryDeploymentJournal(journalPath, {
      expectedBinding: binding,
      expectedJournalDirectory: directory,
      expectedPhase: `${role}_provision`,
    });
    validateProviderLocators(binding, provider);
    const manifest = manifestFor(binding, provider, first.semantic);
    if (!noSecretMaterial(manifest)) refuse("DISPOSABLE_RECOVERY_PROVISION_SECRET_LEAK_REFUSED");
    await beforeBoundary();
    let manifestLoaded;
    if (existingManifestLoaded) {
      if (canonical(existingManifestLoaded.value) !== canonical(manifest)) {
        refuse("DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID");
      }
      manifestLoaded = existingManifestLoaded;
    } else {
      manifestLoaded = finalizeOutput(
        manifestReservation, manifest, "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_FINALIZATION_FAILED",
        finalizeReceipt,
      );
      manifestFinalized = true;
    }
    await checkpoint("manifest_finalized");
    const receipt = immutable({
      schema_version: 1,
      protocol: DISPOSABLE_RECOVERY_FIELD_PROVISION_PROTOCOL,
      kind: `${role}_provision`,
      status: "passed",
      action: binding.action,
      completed_at: isoNow(now),
      binding,
      preflight_sha256: preflight.sha256,
      approval_fingerprint: expectedApproval,
      journal,
      manifest_sha256: manifestLoaded.sha256,
      final_state: first.semantic,
      final_readback_sha256: sha256(canonical({ first, second })),
    });
    if (!noSecretMaterial(receipt) || !WORKER_ID_RE.test(receipt.final_state.worker_id)) {
      refuse("DISPOSABLE_RECOVERY_PROVISION_RECEIPT_INVALID");
    }
    await boundary(revalidate, receiptReservation);
    const receiptLoaded = finalizeOutput(
      receiptReservation, receipt, "DISPOSABLE_RECOVERY_PROVISION_RECEIPT_FINALIZATION_FAILED",
      finalizeReceipt,
    );
    receiptFinalized = true;
    await checkpoint("receipt_finalized");
    return immutable({
      receipt,
      receiptSha256: receiptLoaded.sha256,
      manifest,
      manifestSha256: manifestLoaded.sha256,
    });
  } finally {
    mutationProvider?.dispose?.();
    if (manifestReservation && !manifestFinalized) abandonPrivateAggregateReceipt(manifestReservation);
    if (!receiptFinalized) abandonPrivateAggregateReceipt(receiptReservation);
  }
}

export function disposableRecoveryProvisionPaths(directoryInput, roleInput) {
  const directory = resolve(directoryInput);
  const role = checkedRole(roleInput);
  return immutable({
    preflight: join(directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_preflight`]),
    phase: join(directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_phase`]),
    journal: join(directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_journal`]),
    manifest: join(directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_manifest`]),
  });
}

/**
 * Read and cross-bind one completed A1/A3 receipt with its generated manifest.
 * This is the sole owner-private Worker-ID bridge consumed by teardown.
 */
export function readDisposableRecoveryProvisionArtifacts({
  receiptPath,
  manifestPath,
  expectedReceiptDirectory,
  role: roleInput,
}) {
  const role = checkedRole(roleInput);
  const directory = checkedDirectory(expectedReceiptDirectory);
  const checkedReceiptPath = exactPath(
    receiptPath, directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_phase`],
    "DISPOSABLE_RECOVERY_PROVISION_RECEIPT_INVALID",
  );
  const checkedManifestPath = exactPath(
    manifestPath, directory, DISPOSABLE_RECOVERY_FIELD_PROVISION_NAMES[`${role}_manifest`],
    "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID",
  );
  let receiptLoaded;
  let manifestLoaded;
  try {
    receiptLoaded = readPrivateAggregateReceipt(checkedReceiptPath, {
      code: "DISPOSABLE_RECOVERY_PROVISION_RECEIPT_INVALID",
    });
    manifestLoaded = readPrivateAggregateReceipt(checkedManifestPath, {
      code: "DISPOSABLE_RECOVERY_PROVISION_MANIFEST_INVALID",
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_PROVISION_ARTIFACTS_INVALID");
  }
  const receipt = receiptLoaded.value;
  const manifest = manifestLoaded.value;
  if (!plainObject(receipt?.binding) || receipt.binding.role !== role ||
      receipt.binding.action !== (role === "source" ? "A1" : "A3") ||
      receipt.binding.resource_name !== RESOURCES[role] ||
      !ACCOUNT_ID_RE.test(String(receipt.binding.account_id || "")) ||
      !SHA256_RE.test(String(receipt.binding.campaign_fingerprint || ""))) {
    refuse("DISPOSABLE_RECOVERY_PROVISION_RECEIPT_INVALID");
  }
  validateProvisionReceiptArtifact(
    receipt,
    receipt.binding,
    receipt.preflight_sha256,
    receipt.approval_fingerprint,
    manifestLoaded.sha256,
  );
  validateProvisionManifestArtifact(manifest, receipt.binding, receipt.final_state);
  return immutable({
    role,
    accountId: receipt.final_state.account_id,
    resourceName: receipt.final_state.resource_name,
    workerId: receipt.final_state.worker_id,
    databaseId: receipt.final_state.database_id,
    receipt,
    receiptSha256: receiptLoaded.sha256,
    manifest,
    manifestSha256: manifestLoaded.sha256,
  });
}
