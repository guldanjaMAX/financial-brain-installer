/**
 * Reviewed Cloudflare provider for the fixed v0.4.8 disposable deployment.
 *
 * This adapter is intentionally narrower than a general Workers client. It
 * loads only the Worker modules pinned by the sealed npm package, builds only
 * the fixed D1 runtime bindings, inherits a closed secret-name set from one
 * exact baseline version, and resolves Cloudflare credentials only through the
 * existing macOS Keychain store. It provisions, routes, migrates, seeds,
 * tears down, and releases nothing.
 */

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";

import { splitStatements, runRestartSafeMigrationStatements } from "../brain.mjs";
import { validateAdminKeyValue } from "./admin-key-file.mjs";
import {
  parseAdminKeySecretReference,
  readAdminKeyFromKeychain,
} from "./admin-key-persistence.mjs";
import { validateBankAccessWrappingKey } from "./bank-access-wrapping-key.mjs";
import { loadStoredCloudflareToken } from "./cloudflare-token-store.mjs";
import {
  assertCloudflareDisposableCampaignCustodyProof,
  createCloudflareDisposableDeploymentTransport,
} from "./cloudflare-disposable-deployment-transport.mjs";
import { validateRecoveryArtifactKey } from "./recovery-artifact-crypto.mjs";
import { deriveRagProxyKey } from "./rag-proxy-key.mjs";
import { deriveSessionSigningKey } from "./session-signing-key.mjs";
import {
  assertDisposableRecoveryFieldKeychainVerificationCapability,
  assertDisposableRecoveryFieldKeychainVerificationBinding,
} from "./disposable-recovery-field-keychain-prep.mjs";

export const CLOUDFLARE_DISPOSABLE_DEPLOYMENT_PROVIDER_SCHEMA_VERSION = 1;

const COMPATIBILITY_DATE = "2026-01-01";
const MAIN_MODULE = "index.js";
const WORKER_PREFIX = "worker/src/";
const MIGRATION_PREFIX = "migrations/d1/";
const PROVISION_RESOURCES = Object.freeze({
  source: "brain-test-v048-field-source-recovery-gate-a48f1101",
  target: "brain-test-v048-field-target-recovery-gate-a48f1102",
});
const PROVISION_LOCATORS = Object.freeze({
  sourceAdmin: "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
  targetAdmin: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
  targetBank: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/bank-wrapping-v2",
  targetArtifact: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
});
const BOOTSTRAP_MAIN_MODULE = "field-bootstrap.mjs";
const VECTOR_METADATA_INDEXES = Object.freeze([
  Object.freeze({ property_name: "source", index_type: "string" }),
  Object.freeze({ property_name: "client", index_type: "string" }),
  Object.freeze({ property_name: "category", index_type: "string" }),
  Object.freeze({ property_name: "top_folder", index_type: "string" }),
  Object.freeze({ property_name: "platform", index_type: "string" }),
  Object.freeze({ property_name: "document_date", index_type: "number" }),
]);
const BOOTSTRAP_SOURCE = Buffer.from([
  "export default {",
  "  async fetch() { return new Response('Financial Brain field bootstrap', { status: 503 }); },",
  "  async scheduled() {}",
  "};",
  "",
].join("\n"), "utf8");
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const REQUIRED_SECRET_NAMES = Object.freeze([
  "ADMIN_KEY",
  "RAG_PROXY_KEY",
  "SESSION_SIGNING_KEY",
]);
const TARGET_SECRET_NAMES = Object.freeze([
  ...REQUIRED_SECRET_NAMES,
  "BANK_FEED_WRAPPING_KEY_V2",
].sort());
const CAMPAIGN_SEMANTIC_AUTHORITY_HASH_DOMAIN =
  "financial-brain:v0.4.8:disposable-campaign-semantic-authority:v1";

export class CloudflareDisposableDeploymentProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "CloudflareDisposableDeploymentProviderError";
    this.code = code;
  }
}

function refuse(code) {
  throw new CloudflareDisposableDeploymentProviderError(code);
}

function checkedKeychainCapability(proof, expectedBindingSha256 = null) {
  try {
    return assertDisposableRecoveryFieldKeychainVerificationCapability(
      proof,
      expectedBindingSha256,
    );
  } catch {
    refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID");
  }
}

function checkedKeychainBindingCapability(
  proof,
  binding,
  expectedBindingSha256 = null,
) {
  try {
    return assertDisposableRecoveryFieldKeychainVerificationBinding(
      proof,
      binding,
      expectedBindingSha256,
    );
  } catch {
    refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID");
  }
}

async function keychainCapabilityBoundary(proof, binding, expectedBindingSha256) {
  let valid;
  try {
    checkedKeychainBindingCapability(proof, binding, expectedBindingSha256);
    valid = await proof.revalidate();
    checkedKeychainBindingCapability(proof, binding, expectedBindingSha256);
  }
  catch { refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID"); }
  if (valid !== true) {
    refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID");
  }
  return true;
}

function keychainBoundOperation(proof, binding, expectedBindingSha256, operation) {
  return async (...args) => {
    await keychainCapabilityBoundary(proof, binding, expectedBindingSha256);
    try { return await operation(...args); }
    finally {
      await keychainCapabilityBoundary(proof, binding, expectedBindingSha256);
    }
  };
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields) {
  return plainObject(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
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

function domainHash(domain, value) {
  const serialized = canonical(value);
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(serialized)), "ascii")
    .update("\0", "utf8")
    .update(serialized, "utf8")
    .digest("hex");
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.nlink === right?.nlink && left?.size === right?.size &&
    left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function immutable(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) immutable(child);
  return value;
}

function providerId(value, code = "CF_DISPOSABLE_PROVIDER_READBACK_INVALID") {
  const id = String(value ?? "").toLowerCase();
  if (!UUID_RE.test(id)) refuse(code);
  return id;
}

function checkedBinding(value, role) {
  const fields = [
    "accountId", "adminKeySecret", "answerModel", "bankFeedEnabled",
    "chunkOverlap", "chunkSize", "clientDisplayName", "clientSlug",
    "credentialScanner", "dailyLlmCapUsd", "databaseId", "databaseName",
    "domain", "embeddingDimensions", "embeddingModel", "enabledCorpora",
    "ocrEnabled", "ocrModel", "productVersion", "recoveryArtifactKeySecret",
    "recoveryFieldGate", "vectorizeIndex", "workerName",
  ];
  const exactTargetIsolation = role === "target" &&
    exactKeys(value.recoveryFieldGate, ["custom_domains", "routes"]) &&
    Array.isArray(value.recoveryFieldGate.custom_domains) &&
    value.recoveryFieldGate.custom_domains.length === 0 &&
    Array.isArray(value.recoveryFieldGate.routes) &&
    value.recoveryFieldGate.routes.length === 0;
  if (!exactKeys(value, fields) || !["source", "target"].includes(role) ||
      !Array.isArray(value.enabledCorpora) || value.enabledCorpora.length !== 0 ||
      value.bankFeedEnabled !== false ||
      (role === "source" ? value.recoveryFieldGate !== null : !exactTargetIsolation) ||
      value.embeddingDimensions !== 768 || value.productVersion !== "0.4.8" ||
      (role === "source" && value.recoveryArtifactKeySecret !== null) ||
      (role === "target" && typeof value.recoveryArtifactKeySecret !== "string")) {
    refuse("CF_DISPOSABLE_PROVIDER_BINDING_INVALID");
  }
  for (const field of [
    "accountId", "answerModel", "chunkOverlap", "chunkSize", "clientDisplayName",
    "clientSlug", "credentialScanner", "dailyLlmCapUsd", "databaseId",
    "databaseName", "embeddingModel", "ocrEnabled", "ocrModel",
    "productVersion", "vectorizeIndex", "workerName",
  ]) {
    if (typeof value[field] !== "string" || !value[field]) {
      refuse("CF_DISPOSABLE_PROVIDER_BINDING_INVALID");
    }
  }
  return value;
}

function assertBindings(value, phase) {
  const fields = phase === "source"
    ? ["planFingerprint", "source", "sourceManifestFingerprint"]
    : phase === "target"
      ? [
        "planFingerprint", "source", "sourceManifestFingerprint", "target",
        "targetManifestFingerprint",
      ]
      : null;
  if (!fields || !exactKeys(value, fields)) {
    refuse("CF_DISPOSABLE_PROVIDER_BINDING_INVALID");
  }
  for (const field of [
    "planFingerprint", "sourceManifestFingerprint",
    ...(phase === "target" ? ["targetManifestFingerprint"] : []),
  ]) {
    if (!SHA256_RE.test(String(value[field] ?? ""))) {
      refuse("CF_DISPOSABLE_PROVIDER_BINDING_INVALID");
    }
  }
  checkedBinding(value.source, "source");
  if (phase === "target") {
    checkedBinding(value.target, "target");
    if (value.source.accountId !== value.target.accountId ||
        value.source.databaseId === value.target.databaseId) {
      refuse("CF_DISPOSABLE_PROVIDER_BINDING_INVALID");
    }
  }
  return value;
}

function readPinnedModule(pin) {
  if (!plainObject(pin) || typeof pin.path !== "string" ||
      typeof pin.relative !== "string" || !pin.relative.startsWith(WORKER_PREFIX) ||
      !pin.relative.endsWith(".js") || !SHA256_RE.test(String(pin.hash || "")) ||
      !pin.info) {
    refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_INVALID");
  }
  const moduleName = pin.relative.slice(WORKER_PREFIX.length);
  if (!moduleName || moduleName.includes("\\") || moduleName.split("/").some((part) =>
    !part || part === "." || part === "..")) {
    refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_INVALID");
  }
  let descriptor;
  let bytes;
  try {
    const path = resolve(pin.path);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        !sameFile(before, pin.info) || path.split(sep).join("/").endsWith(
          `/${pin.relative}`,
        ) !== true) {
      refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_CHANGED");
    }
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_CHANGED");
    bytes = readFileSync(descriptor);
    const afterOpened = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || sha256(bytes) !== pin.hash ||
        !sameFile(opened, afterOpened) || !sameFile(opened, afterPath)) {
      refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_CHANGED");
    }
    return Object.freeze({
      name: moduleName,
      content_type: "application/javascript+module",
      bytes,
    });
  } catch (error) {
    if (error instanceof CloudflareDisposableDeploymentProviderError) throw error;
    bytes?.fill(0);
    refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_CHANGED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadModules(executionPins) {
  if (!Array.isArray(executionPins) || executionPins.length < 1) {
    refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_INVALID");
  }
  const pins = executionPins.filter((pin) =>
    typeof pin?.relative === "string" && pin.relative.startsWith(WORKER_PREFIX));
  const modules = pins.map(readPinnedModule).sort((left, right) =>
    left.name.localeCompare(right.name));
  if (modules.length < 1 || !modules.some((module) => module.name === MAIN_MODULE) ||
      new Set(modules.map((module) => module.name)).size !== modules.length) {
    for (const module of modules) module.bytes.fill(0);
    refuse("CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_INVALID");
  }
  const entries = modules.map((module) => ({
    name: module.name,
    content_type: module.content_type,
    bytes: module.bytes.length,
    sha256: sha256(module.bytes),
  }));
  return Object.freeze({
    mainModule: MAIN_MODULE,
    modules: Object.freeze(modules),
    moduleInventorySha256: sha256(canonical({
      main_module: MAIN_MODULE,
      modules: entries,
    })),
  });
}

function readPinnedMigration(pin) {
  if (!plainObject(pin) || typeof pin.path !== "string" ||
      typeof pin.relative !== "string" || !pin.relative.startsWith(MIGRATION_PREFIX) ||
      !/^migrations\/d1\/\d+_.*\.sql$/u.test(pin.relative) ||
      !SHA256_RE.test(String(pin.hash || "")) || !pin.info) {
    refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_INVALID");
  }
  let descriptor;
  let bytes;
  try {
    const path = resolve(pin.path);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        !sameFile(before, pin.info) ||
        path.split(sep).join("/").endsWith(`/${pin.relative}`) !== true) {
      refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_CHANGED");
    }
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_CHANGED");
    bytes = readFileSync(descriptor);
    const afterOpened = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || sha256(bytes) !== pin.hash ||
        !sameFile(opened, afterOpened) || !sameFile(opened, afterPath)) {
      refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_CHANGED");
    }
    const match = pin.relative.slice(MIGRATION_PREFIX.length).match(/^(\d+)_(.+)\.sql$/u);
    const version = Number(match?.[1]);
    if (!Number.isSafeInteger(version) || version < 1) {
      refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_INVALID");
    }
    return Object.freeze({
      relative: pin.relative,
      version,
      name: `${match[1]}_${match[2]}`,
      sql: bytes.toString("utf8"),
      sha256: pin.hash,
      checksum: pin.hash.slice(0, 16),
    });
  } catch (error) {
    if (error instanceof CloudflareDisposableDeploymentProviderError) throw error;
    refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_CHANGED");
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadMigrations(executionPins) {
  if (!Array.isArray(executionPins)) {
    refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_INVALID");
  }
  const migrations = executionPins
    .filter((pin) => typeof pin?.relative === "string" &&
      pin.relative.startsWith(MIGRATION_PREFIX))
    .map(readPinnedMigration)
    .sort((left, right) => left.version - right.version);
  if (migrations.length !== 46 || migrations.at(-1)?.version !== 46 ||
      migrations.some((migration, index) => migration.version !== index + 1) ||
      new Set(migrations.map(({ name }) => name)).size !== migrations.length) {
    refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_INVALID");
  }
  const inventory = migrations.map(({ relative, version, name, sha256: hash }) => ({
    relative, version, name, sha256: hash,
  }));
  return Object.freeze({
    migrations: Object.freeze(migrations),
    migrationInventorySha256: sha256(canonical(inventory)),
    schemaVersion: 46,
  });
}

function checkedProvisioningRole(value) {
  if (!Object.hasOwn(PROVISION_RESOURCES, value)) {
    refuse("CF_DISPOSABLE_PROVIDER_PROVISION_ROLE_INVALID");
  }
  return value;
}

function fixedProvisionBinding(role, accountId, databaseId, domain) {
  const resource = PROVISION_RESOURCES[role];
  return Object.freeze({
    accountId,
    adminKeySecret: role === "source"
      ? PROVISION_LOCATORS.sourceAdmin
      : PROVISION_LOCATORS.targetAdmin,
    answerModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    bankFeedEnabled: false,
    chunkOverlap: "300",
    chunkSize: "1500",
    clientDisplayName: "Synthetic Field Gate v0.4.8",
    clientSlug: "v048-field-proof",
    credentialScanner: "on",
    dailyLlmCapUsd: "10",
    databaseId,
    databaseName: resource,
    domain,
    embeddingDimensions: 768,
    embeddingModel: "@cf/baai/bge-base-en-v1.5",
    enabledCorpora: Object.freeze([]),
    ocrEnabled: "0",
    ocrModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
    productVersion: "0.4.8",
    recoveryArtifactKeySecret: role === "target" ? PROVISION_LOCATORS.targetArtifact : null,
    recoveryFieldGate: null,
    vectorizeIndex: resource,
    workerName: resource,
  });
}


function nonSecretBindings(binding, mode) {
  if (!["active", "paused-for-upgrade"].includes(mode)) {
    refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
  }
  return Object.freeze([
    { type: "d1", name: "DB", database_id: binding.databaseId },
    { type: "ai", name: "AI" },
    { type: "plain_text", name: "STORAGE", text: "d1" },
    { type: "vectorize", name: "VECTORIZE", index_name: binding.vectorizeIndex },
    { type: "plain_text", name: "BRAIN_NAME", text: binding.clientSlug },
    { type: "plain_text", name: "BRAIN_OWNER", text: binding.clientDisplayName },
    { type: "plain_text", name: "BRAIN_VERSION", text: binding.productVersion },
    ...(mode === "paused-for-upgrade"
      ? [{ type: "plain_text", name: "VECTOR_DRAIN_MODE", text: "paused-for-upgrade" }]
      : []),
    { type: "plain_text", name: "CHUNK_SIZE", text: binding.chunkSize },
    { type: "plain_text", name: "CHUNK_OVERLAP", text: binding.chunkOverlap },
    { type: "plain_text", name: "DAILY_LLM_CAP_USD", text: binding.dailyLlmCapUsd },
    { type: "plain_text", name: "ANSWER_MODEL", text: binding.answerModel },
    { type: "plain_text", name: "CREDENTIAL_SCANNER", text: binding.credentialScanner },
    { type: "plain_text", name: "OCR_ENABLED", text: binding.ocrEnabled },
    { type: "plain_text", name: "OCR_MODEL", text: binding.ocrModel },
  ]);
}

function secretNames(role) {
  return role === "target" ? TARGET_SECRET_NAMES : REQUIRED_SECRET_NAMES;
}

function versionExpectation(binding, role, mode) {
  return Object.freeze({
    compatibility_date: COMPATIBILITY_DATE,
    handlers: Object.freeze(["fetch", "scheduled"]),
    bindings: Object.freeze([
      ...nonSecretBindings(binding, mode),
      ...secretNames(role).map((name) => ({ type: "secret_text", name })),
    ]),
    mode_binding_name: mode === "paused-for-upgrade" ? "VECTOR_DRAIN_MODE" : null,
    protection: Object.freeze({
      role,
      expected_mode: role === "source"
        ? null
        : mode === "paused-for-upgrade" ? "paused" : "active",
    }),
  });
}

function bootstrapTag(role, campaignFingerprint) {
  if (!SHA256_RE.test(String(campaignFingerprint || ""))) {
    refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
  }
  return `v048-field-${role}-bootstrap-${campaignFingerprint}`;
}

function workerCampaignTag(role, campaignFingerprint) {
  if (!SHA256_RE.test(String(campaignFingerprint || ""))) {
    refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
  }
  return `v048-field-${role}-${campaignFingerprint}`;
}

function bootstrapMessage(role) {
  return `Financial Brain 0.4.8 disposable ${role} maintenance bootstrap`;
}


function resourceRequest(binding) {
  return Object.freeze({
    account_id: binding.accountId,
    script_name: binding.workerName,
    database: Object.freeze({ id: binding.databaseId, name: binding.databaseName }),
    vectorize: Object.freeze({
      name: binding.vectorizeIndex,
      dimensions: 768,
      metric: "cosine",
    }),
    expected: Object.freeze({
      workers_dev_enabled: true,
      previews_enabled: false,
      routes_count: 0,
      custom_domains_count: 0,
      domain: binding.domain,
      schedules: Object.freeze([]),
    }),
  });
}

function resourceSemantic(value) {
  const fields = [
    "custom_domains_count", "d1_exists", "d1_name_and_id_exact",
    "previews_enabled", "routes_count", "schedules_count", "vector_count",
    "vector_dimensions", "vector_metric", "vectorize_exists",
    "vectorize_name_exact", "worker_exists", "workers_dev_enabled",
  ];
  if (!plainObject(value) || fields.some((field) => !Object.hasOwn(value, field))) {
    refuse("CF_DISPOSABLE_PROVIDER_READBACK_INVALID");
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, value[field]])));
}

function versionSemantic(value) {
  return Object.freeze({
    bindings_sha256: value.bindings_sha256,
    bindings_without_mode_sha256: value.bindings_without_mode_sha256,
    handlers: value.handlers,
    named_handlers_count: value.named_handlers_count,
    script_etag: value.script_etag,
    version_id: value.version_id,
  });
}

function deploymentSemantic(value) {
  if (!Array.isArray(value.versions) || value.versions.length !== 1 ||
      value.versions[0].percentage !== 100) {
    refuse("CF_DISPOSABLE_PROVIDER_READBACK_INVALID");
  }
  return Object.freeze({
    deployment_id: value.deployment_id,
    traffic_percent: 100,
    version_id: value.versions[0].version_id,
  });
}

function responseEvidence(operation, value) {
  const metadata = value?.response;
  if (!plainObject(metadata)) refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_INVALID");
  return Object.freeze({ operation, ...metadata });
}

function networkIsolationSemantic(value) {
  const fields = [
    "worker_identity_proved", "worker_identity_sha256",
    "workers_dev_identity_proved", "worker_previews_disabled",
    "worker_cache_enabled", "worker_extra_exports", "worker_tail_consumers",
    "worker_assets", "worker_logpush", "cron_triggers", "routes",
    "custom_domains",
  ];
  if (!exactKeys(value, fields) || value.worker_identity_proved !== true ||
      !SHA256_RE.test(String(value.worker_identity_sha256 ?? "")) ||
      value.workers_dev_identity_proved !== true ||
      value.worker_previews_disabled !== true || value.worker_cache_enabled !== false ||
      value.worker_extra_exports !== 0 || value.worker_tail_consumers !== 0 ||
      value.worker_assets !== false || value.worker_logpush !== false ||
      value.cron_triggers !== 0 || value.routes !== 0 || value.custom_domains !== 0) {
    refuse("CF_DISPOSABLE_PROVIDER_NETWORK_ISOLATION_UNVERIFIED");
  }
  return immutable({ ...value });
}

function workerGenerationSemantic(value) {
  if (!plainObject(value) || value.schema_version !== 1 ||
      value.worker_identity_proved !== true ||
      value.worker_generation_proved !== true ||
      !SHA256_RE.test(String(value.worker_generation_sha256 ?? ""))) {
    refuse("CF_DISPOSABLE_PROVIDER_WORKER_GENERATION_INVALID");
  }
  return Object.freeze({
    schema_version: 1,
    worker_identity_proved: true,
    worker_generation_proved: true,
    worker_generation_sha256: value.worker_generation_sha256,
  });
}

function campaignCustodySemantic(value) {
  if (!plainObject(value) || value.schema_version !== 1 ||
      value.operation !== "read_campaign_custody" || value.captures !== 2 ||
      !plainObject(value.roles) || !plainObject(value.campaign_custody) ||
      !SHA256_RE.test(String(value.proof_sha256 ?? "")) ||
      !Array.isArray(value.responses)) {
    refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNVERIFIED");
  }
  const { responses: _responses, ...semantic } = value;
  try { return immutable(assertCloudflareDisposableCampaignCustodyProof(semantic)); }
  catch { refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNVERIFIED"); }
}

function approvedVersionSemantic(value, code =
  "CF_DISPOSABLE_PROVIDER_CAMPAIGN_AUTHORITY_INVALID") {
  if (!exactKeys(value, [
    "version_id", "script_etag", "reviewed_worker_generation_sha256",
  ]) || typeof value.script_etag !== "string" || value.script_etag.length < 1 ||
      value.script_etag.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.script_etag) ||
      !SHA256_RE.test(String(value.reviewed_worker_generation_sha256 ?? ""))) {
    refuse(code);
  }
  return Object.freeze({
    version_id: providerId(value.version_id, code),
    script_etag: value.script_etag,
    reviewed_worker_generation_sha256: value.reviewed_worker_generation_sha256,
  });
}

function campaignSemanticAuthority({
  targetMode,
  approvedVersions,
  campaignCustody,
  sourceNetworkIsolation,
  targetNetworkIsolation,
}) {
  const semantic = {
    schema_version: 1,
    operation: "read_disposable_campaign_semantic_authority",
    target_mode: targetMode,
    approved_versions: approvedVersions,
    campaign_custody: campaignCustody,
    network_isolation: {
      source: sourceNetworkIsolation,
      target: targetNetworkIsolation,
    },
  };
  return assertCloudflareDisposableCampaignSemanticAuthority({
    ...semantic,
    authority_sha256: domainHash(CAMPAIGN_SEMANTIC_AUTHORITY_HASH_DOMAIN, semantic),
  });
}

/** Build and immediately recompute a durable A4/A12 campaign authority. */
export function createCloudflareDisposableCampaignSemanticAuthority(input) {
  if (!exactKeys(input, [
    "target_mode", "approved_versions", "campaign_custody",
    "source_network_isolation", "target_network_isolation",
  ])) {
    refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_AUTHORITY_INVALID");
  }
  return campaignSemanticAuthority({
    targetMode: input.target_mode,
    approvedVersions: input.approved_versions,
    campaignCustody: input.campaign_custody,
    sourceNetworkIsolation: input.source_network_isolation,
    targetNetworkIsolation: input.target_network_isolation,
  });
}

/** Validate and recompute the durable, credential-free A4/A12 authority. */
export function assertCloudflareDisposableCampaignSemanticAuthority(value) {
  const code = "CF_DISPOSABLE_PROVIDER_CAMPAIGN_AUTHORITY_INVALID";
  if (!exactKeys(value, [
    "schema_version", "operation", "target_mode", "approved_versions",
    "campaign_custody", "network_isolation", "authority_sha256",
  ]) || value.schema_version !== 1 ||
      value.operation !== "read_disposable_campaign_semantic_authority" ||
      !["paused", "active"].includes(value.target_mode) ||
      !exactKeys(value.approved_versions, [
        "source", "target_paused", "target_active",
      ]) || !exactKeys(value.network_isolation, ["source", "target"])) {
    refuse(code);
  }
  let custody;
  try { custody = assertCloudflareDisposableCampaignCustodyProof(value.campaign_custody); }
  catch { refuse(code); }
  const sourceNetwork = networkIsolationSemantic(value.network_isolation.source);
  const targetNetwork = networkIsolationSemantic(value.network_isolation.target);
  const approved = Object.freeze({
    source: approvedVersionSemantic(value.approved_versions.source, code),
    target_paused: approvedVersionSemantic(
      value.approved_versions.target_paused,
      code,
    ),
    target_active: approvedVersionSemantic(
      value.approved_versions.target_active,
      code,
    ),
  });
  if (approved.target_paused.version_id === approved.target_active.version_id ||
      approved.target_paused.script_etag === approved.target_active.script_etag) {
    refuse(code);
  }
  const sourceGeneration = custody.generation_authority.source;
  const targetGeneration = custody.generation_authority.target;
  const selectedTarget = value.target_mode === "paused"
    ? approved.target_paused
    : approved.target_active;
  if (sourceGeneration.mode !== "active" ||
      sourceGeneration.version_id !== approved.source.version_id ||
      sourceGeneration.reviewed_worker_generation_sha256 !==
        approved.source.reviewed_worker_generation_sha256 ||
      targetGeneration.mode !== value.target_mode ||
      targetGeneration.version_id !== selectedTarget.version_id ||
      targetGeneration.reviewed_worker_generation_sha256 !==
        selectedTarget.reviewed_worker_generation_sha256 ||
      sourceNetwork.worker_identity_sha256 !==
        sourceGeneration.worker_identity_sha256 ||
      targetNetwork.worker_identity_sha256 !==
        targetGeneration.worker_identity_sha256) {
    refuse(code);
  }
  const semantic = {
    schema_version: 1,
    operation: value.operation,
    target_mode: value.target_mode,
    approved_versions: approved,
    campaign_custody: custody,
    network_isolation: { source: sourceNetwork, target: targetNetwork },
  };
  if (!SHA256_RE.test(String(value.authority_sha256 ?? "")) ||
      value.authority_sha256 !==
        domainHash(CAMPAIGN_SEMANTIC_AUTHORITY_HASH_DOMAIN, semantic)) {
    refuse(code);
  }
  return immutable({ ...semantic, authority_sha256: value.authority_sha256 });
}

function normalizedContinuationCustody(value, { ignoreTargetDeployment = false } = {}) {
  const copy = structuredClone(value);
  if (ignoreTargetDeployment) {
    const targetName = copy.campaign_custody_authority.campaign.target.worker_name;
    const worker = copy.campaign_custody_authority.initial_worker_list.workers
      .find((entry) => entry.name === targetName);
    if (!worker) refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_AUTHORITY_CHANGED");
    worker.deployed_on = "<approved-target-deployment>";
    copy.campaign_custody.initial_worker_list_sha256 = "<recomputed>";
    copy.campaign_custody.custody_sha256 = "<recomputed>";
    copy.roles.target.worker_instance_sha256 = "<recomputed>";
    copy.roles.target.worker_protection.worker_identity_sha256 = "<recomputed>";
    copy.roles.target.worker_protection.reviewed_worker_generation_sha256 =
      "<approved-target-generation>";
    copy.roles.target.worker_protection.worker_generation_sha256 = "<recomputed>";
    copy.generation_authority.target.mode = "<approved-target-mode>";
    copy.generation_authority.target.worker_identity_sha256 = "<recomputed>";
    copy.generation_authority.target.deployment_id = "<approved-target-deployment>";
    copy.generation_authority.target.version_id = "<approved-target-version>";
    copy.generation_authority.target.reviewed_worker_generation_sha256 =
      "<approved-target-generation>";
    copy.generation_authority.target.worker_generation_sha256 = "<recomputed>";
    copy.proof_sha256 = "<recomputed>";
  }
  return copy;
}

/** Prove a fresh paused/active census is the same approved A4 campaign. */
export function assertCloudflareDisposableCampaignSemanticContinuation(
  a4Input,
  freshInput,
  targetMode,
) {
  const code = "CF_DISPOSABLE_PROVIDER_CAMPAIGN_AUTHORITY_CHANGED";
  let a4;
  let fresh;
  try {
    a4 = assertCloudflareDisposableCampaignSemanticAuthority(a4Input);
    fresh = assertCloudflareDisposableCampaignSemanticAuthority(freshInput);
  } catch { refuse(code); }
  if (a4.target_mode !== "paused" || fresh.target_mode !== targetMode ||
      !["paused", "active"].includes(targetMode) ||
      canonical(a4.approved_versions) !== canonical(fresh.approved_versions) ||
      canonical(a4.network_isolation.source) !==
        canonical(fresh.network_isolation.source) ||
      (targetMode === "paused" && canonical(a4) !== canonical(fresh))) {
    refuse(code);
  }
  if (targetMode === "active") {
    const targetA4 = a4.network_isolation.target;
    const targetFresh = fresh.network_isolation.target;
    const withoutIdentity = (network) => {
      const { worker_identity_sha256: _identity, ...rest } = network;
      return rest;
    };
    if (canonical(withoutIdentity(targetA4)) !==
          canonical(withoutIdentity(targetFresh)) ||
        a4.campaign_custody.roles.target.worker_protection
          .worker_reference_snapshot_sha256 !==
          fresh.campaign_custody.roles.target.worker_protection
            .worker_reference_snapshot_sha256 ||
        canonical(normalizedContinuationCustody(a4.campaign_custody, {
          ignoreTargetDeployment: true,
        })) !== canonical(normalizedContinuationCustody(fresh.campaign_custody, {
          ignoreTargetDeployment: true,
        }))) {
      refuse(code);
    }
  }
  return fresh;
}

function vectorizeQuiescenceSemantic(value, targetResourceFingerprint) {
  const fields = [
    "schema_version", "kind", "approval_fingerprint", "campaign_identity_sha256",
    "target_resource_fingerprint", "scope_sha256", "continuous", "interval_start",
    "interval_end", "includes_pending_before_first_provider_observation",
    "mutation_surfaces_attested",
  ];
  if (!exactKeys(value, fields) || value.schema_version !== 1 ||
      value.kind !== "v048_vectorize_mutation_quiescence_v1" ||
      value.target_resource_fingerprint !== targetResourceFingerprint ||
      value.continuous !== true ||
      value.includes_pending_before_first_provider_observation !== true ||
      value.interval_start !==
        "exact_disposable_target_vectorize_index_creation_or_provisioning" ||
      value.interval_end !== "recovery_final_active_composite_proof_accepted" ||
      value.mutation_surfaces_attested !== 5 ||
      ["approval_fingerprint", "campaign_identity_sha256", "scope_sha256"].some((field) =>
        !SHA256_RE.test(String(value[field] ?? "")))) {
    refuse("CF_DISPOSABLE_PROVIDER_VECTORIZE_QUIESCENCE_INVALID");
  }
  return immutable({ ...value });
}

function resourceEvidence(prefix, value) {
  if (!Array.isArray(value?.responses)) refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_INVALID");
  return value.responses.map((entry) => Object.freeze({
    operation: `${prefix}_${entry.operation}`,
    schema_version: entry.schema_version,
    status: entry.status,
    content_type: entry.content_type,
    body_sha256: entry.body_sha256,
  }));
}

function currentRequest(binding) {
  return Object.freeze({
    account_id: binding.accountId,
    script_name: binding.workerName,
  });
}

function exactDeploymentRequest(binding, deploymentId) {
  return Object.freeze({
    account_id: binding.accountId,
    deployment_id: providerId(deploymentId),
    script_name: binding.workerName,
  });
}

function exactVersionRequest(binding, role, versionId, mode) {
  return Object.freeze({
    account_id: binding.accountId,
    script_name: binding.workerName,
    version_id: providerId(versionId),
    expected: versionExpectation(binding, role, mode),
  });
}

function checkSnapshotRequest(request, context) {
  if (!exactKeys(request, [
    "campaign_fingerprint", "expected", "operation", "phase", "protocol",
    "read_ordinal", "schema_version", "stage",
  ]) || request.schema_version !== 2 || request.operation !== "read_snapshot" ||
      request.campaign_fingerprint !== context.binding.campaign_fingerprint ||
      request.phase !== context.phase || ![1, 2].includes(request.read_ordinal)) {
    refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
  }
  const allowedStages = request.phase === "source"
    ? context.stage === "source_preflight"
      ? ["source_preflight"]
      : ["source_preflight", "source_final"]
    : context.stage === "target_preflight"
      ? ["target_preflight"]
      : ["target_preflight", "target_final"];
  if (!allowedStages.includes(request.stage)) {
    refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
  }
  return request;
}

function checkExpected(value, fields) {
  if (!exactKeys(value, fields)) refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
  const checked = {};
  for (const field of fields) checked[field] = providerId(value[field]);
  return Object.freeze(checked);
}

function checkedProvisionAccount(value) {
  const accountId = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(accountId)) {
    refuse("CF_DISPOSABLE_PROVIDER_PROVISION_ACCOUNT_INVALID");
  }
  return accountId;
}

function directResponseEvidence(value, operation) {
  const response = value?.response;
  if (!plainObject(response)) refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_INVALID");
  return Object.freeze({ operation, ...response });
}

function aggregateProviderMetadata(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.some((entry) =>
    !plainObject(entry) || entry.schema_version !== 1 || entry.status !== 200 ||
    !["application/json", "application/json; charset=utf-8"].includes(entry.content_type) ||
    !SHA256_RE.test(String(entry.body_sha256 || "")))) {
    refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_INVALID");
  }
  return Object.freeze({
    schema_version: 1,
    status: 200,
    content_type: "application/json",
    body_sha256: sha256(canonical(evidence)),
  });
}

function journalProviderResult(value, result, operation) {
  return Object.freeze({
    provider_metadata: aggregateProviderMetadata([
      directResponseEvidence(value, operation),
    ]),
    result: Object.freeze(result),
  });
}

function validateD1CountRow(value, fields) {
  if (!plainObject(value) || fields.some((field) =>
    !Object.hasOwn(value, field) || !Number.isSafeInteger(Number(value[field])) ||
    Number(value[field]) < 0)) {
    refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, Number(value[field])])));
}

function canonicalSchemaDefinition(value) {
  if (typeof value !== "string" || !value.trim()) {
    refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
  }
  return value
    .trim()
    .replace(/;\s*$/u, "")
    .replace(/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/iu, "CREATE TABLE ")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=])\s*/gu, "$1");
}

function expectedInitialSchemaPrefix(migrationSet) {
  const statements = splitStatements(migrationSet.migrations[0]?.sql || "");
  const installState = statements[0];
  const migrationLedger = statements[1];
  if (!/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+install_state\s*\(/iu.test(
    installState || "",
  ) || !/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+schema_migrations\s*\(/iu.test(
    migrationLedger || "",
  )) {
    refuse("CF_DISPOSABLE_PROVIDER_MIGRATION_INVENTORY_INVALID");
  }
  return Object.freeze({
    installStateSql: canonicalSchemaDefinition(installState),
  });
}

/**
 * Prepare the fixed A1/A3 provisioning provider without opening Keychain or
 * Cloudflare. Preview callers may safely stop after this function. The
 * returned mutation factory resolves every required local secret before its
 * first provider call; no secret value is returned or serialized.
 */
export function prepareCloudflareDisposableProvisioningProvider(
  { executionPins, role, accountId, keychainBinding, keychainProof },
  {
    platform = process.platform,
    fetchImpl = globalThis.fetch,
    loadToken = loadStoredCloudflareToken,
    readKeychain = readAdminKeyFromKeychain,
    createTransport = createCloudflareDisposableDeploymentTransport,
    now = () => new Date(),
  } = {},
) {
  const checkedRole = checkedProvisioningRole(role);
  const checkedAccountId = checkedProvisionAccount(accountId);
  const checkedKeychainProof = checkedKeychainBindingCapability(
    keychainProof,
    keychainBinding,
  );
  if (keychainBinding.account_id !== checkedAccountId) {
    refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID");
  }
  const keychainBindingSha256 = checkedKeychainProof.keychain_binding_sha256;
  const boundOperation = (operation) => keychainBoundOperation(
    checkedKeychainProof,
    keychainBinding,
    keychainBindingSha256,
    operation,
  );
  const keychainBoundary = () => keychainCapabilityBoundary(
    checkedKeychainProof,
    keychainBinding,
    keychainBindingSha256,
  );
  if (platform !== "darwin") refuse("CF_DISPOSABLE_PROVIDER_MACOS_KEYCHAIN_REQUIRED");
  if (typeof fetchImpl !== "function" || typeof loadToken !== "function" ||
      typeof readKeychain !== "function" || typeof createTransport !== "function" ||
      typeof now !== "function") {
    refuse("CF_DISPOSABLE_PROVIDER_DEPENDENCY_INVALID");
  }
  // Loading both inventories here binds preview output to the exact package
  // that later supplies A2/A4 and schema 46, even though the A1/A3 bootstrap
  // Worker itself is a deliberately tiny maintenance response.
  const moduleSet = loadModules(executionPins);
  for (const module of moduleSet.modules) module.bytes.fill(0);
  const migrationSet = loadMigrations(executionPins);
  const initialSchemaPrefix = expectedInitialSchemaPrefix(migrationSet);
  const resourceName = PROVISION_RESOURCES[checkedRole];
  const bootstrapModuleInventorySha256 = sha256(canonical({
    main_module: BOOTSTRAP_MAIN_MODULE,
    modules: [{
      name: BOOTSTRAP_MAIN_MODULE,
      content_type: "application/javascript+module",
      bytes: BOOTSTRAP_SOURCE.length,
      sha256: sha256(BOOTSTRAP_SOURCE),
    }],
  }));

  let transport = null;
  const getTransport = () => {
    if (transport) return transport;
    transport = createTransport({
      fetchImpl,
      resolveToken: async () => {
        let value;
        try { value = await loadToken(checkedAccountId, { platform: "darwin" }); }
        catch { refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_TOKEN_UNAVAILABLE"); }
        if (!Buffer.isBuffer(value)) {
          value?.fill?.(0);
          refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_TOKEN_UNAVAILABLE");
        }
        return value;
      },
    });
    return transport;
  };

  const readCollisionsRaw = () => getTransport().readProvisioningCollisions({
    account_id: checkedAccountId,
    resource_name: resourceName,
  });
  const readCollisions = boundOperation(readCollisionsRaw);

  const readSecret = (reference, validator, code) => {
    let value;
    try {
      value = readKeychain(parseAdminKeySecretReference(reference), {
        environment: process.env,
      });
      if (value === null) refuse(code);
      return validator(value);
    } catch (error) {
      if (error instanceof CloudflareDisposableDeploymentProviderError) throw error;
      refuse(code);
    }
  };

  const createMutationProvider = async () => {
    await keychainBoundary();
    const transport = getTransport();
    // Resolve every campaign secret before the collision recheck and before
    // any create. A missing later secret can never strand an earlier resource.
    let adminKey = readSecret(
      checkedRole === "source" ? PROVISION_LOCATORS.sourceAdmin : PROVISION_LOCATORS.targetAdmin,
      validateAdminKeyValue,
      "CF_DISPOSABLE_PROVIDER_PROVISION_ADMIN_KEY_UNAVAILABLE",
    );
    let artifactKey = null;
    let bankKey = null;
    if (checkedRole === "target") {
      artifactKey = readSecret(
        PROVISION_LOCATORS.targetArtifact,
        validateRecoveryArtifactKey,
        "CF_DISPOSABLE_PROVIDER_PROVISION_ARTIFACT_KEY_UNAVAILABLE",
      );
      bankKey = readSecret(
        PROVISION_LOCATORS.targetBank,
        validateBankAccessWrappingKey,
        "CF_DISPOSABLE_PROVIDER_PROVISION_BANK_KEY_UNAVAILABLE",
      );
    }
    let ragProxyKey = deriveRagProxyKey(adminKey);
    let sessionSigningKey = deriveSessionSigningKey(adminKey);

    const createD1 = async () => {
      const value = await transport.createD1Database({
        account_id: checkedAccountId,
        name: resourceName,
      });
      return journalProviderResult(value, { database_id: value.database_id }, "create_d1");
    };
    const stableProvisioningInventory = async (beforeBoundary = async () => true) => {
      if (typeof beforeBoundary !== "function") {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const read = async () => {
        if (await beforeBoundary() !== true) {
          refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_CHANGED");
        }
        const value = await readCollisions();
        if (value.account_id !== checkedAccountId || value.resource_name !== resourceName ||
            !Array.isArray(value.worker_ids) || !Array.isArray(value.d1_ids) ||
            !Array.isArray(value.vectorize_names) || !Array.isArray(value.responses)) {
          refuse("CF_DISPOSABLE_PROVIDER_READBACK_INVALID");
        }
        return value;
      };
      const first = await read();
      const second = await read();
      const project = (value) => ({
        account_id: value.account_id,
        resource_name: value.resource_name,
        worker_exists: value.worker_exists,
        d1_exists: value.d1_exists,
        vectorize_exists: value.vectorize_exists,
        worker_ids: value.worker_ids,
        d1_ids: value.d1_ids,
        vectorize_names: value.vectorize_names,
        vectorize_created_on: value.vectorize_created_on ?? null,
      });
      if (canonical(project(first)) !== canonical(project(second))) {
        refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
      }
      return Object.freeze({
        state: Object.freeze(project(first)),
        provider_metadata: aggregateProviderMetadata([
          ...first.responses.map((entry) => Object.freeze(entry)),
          ...second.responses.map((entry) => Object.freeze(entry)),
        ]),
      });
    };
    const readBaselineInventory = async (workerId, beforeBoundary) => {
      if (typeof beforeBoundary !== "function") {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      if (await beforeBoundary() !== true) {
        refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_CHANGED");
      }
      const value = await transport.readWorkerVersionInventory({
        account_id: checkedAccountId,
        worker_id: workerId,
      });
      if (value.worker_id !== workerId ||
          !Number.isSafeInteger(value.version_count) || value.version_count < 0 ||
          !Array.isArray(value.versions) || value.versions.length !== value.version_count ||
          !Array.isArray(value.responses)) {
        refuse("CF_DISPOSABLE_PROVIDER_READBACK_INVALID");
      }
      return value;
    };
    const baselineInventoryVersion = (inventory, expectedVersionId) => {
      if (inventory.version_count !== 1) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const version = inventory.versions[0];
      if (!plainObject(version) || version.version_id !== expectedVersionId) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      return version;
    };
    const readBaselineVersion = async (
      workerId, versionId, campaignFingerprint, beforeBoundary,
    ) => {
      if (typeof beforeBoundary !== "function") {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      if (await beforeBoundary() !== true) {
        refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_CHANGED");
      }
      const version = await transport.readWorkerVersionForProvisioning({
        account_id: checkedAccountId,
        worker_id: workerId,
        version_id: versionId,
      });
      if (version.worker_id !== workerId || version.version_id !== versionId ||
          version.compatibility_date !== COMPATIBILITY_DATE ||
          version.main_module !== BOOTSTRAP_MAIN_MODULE ||
          version.module_inventory_sha256 !== bootstrapModuleInventorySha256 ||
          version.tag_sha256 !== sha256(bootstrapTag(checkedRole, campaignFingerprint)) ||
          version.message_sha256 !== sha256(bootstrapMessage(checkedRole)) ||
          !SHA256_RE.test(String(version.bindings_sha256 ?? "")) ||
          version.behavior_exact !== true ||
          !SHA256_RE.test(String(version.behavior_sha256 ?? ""))) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      return version;
    };
    const reconcileD1 = async (beforeBoundary) => {
      const { state, provider_metadata: providerMetadata } =
        await stableProvisioningInventory(beforeBoundary);
      if (!state.worker_exists && !state.vectorize_exists && !state.d1_exists &&
          state.worker_ids.length === 0 && state.d1_ids.length === 0 &&
          state.vectorize_names.length === 0) {
        return Object.freeze({ outcome: "resume_safe" });
      }
      if (!state.worker_exists && !state.vectorize_exists && state.d1_exists &&
          state.worker_ids.length === 0 && state.d1_ids.length === 1 &&
          state.vectorize_names.length === 0) {
        return Object.freeze({
          outcome: "confirmed",
          value: Object.freeze({
            provider_metadata: providerMetadata,
            result: Object.freeze({ database_id: providerId(state.d1_ids[0]) }),
          }),
        });
      }
      refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
    };
    const createVectorize = async () => {
      const value = await transport.createVectorizeIndex({
        account_id: checkedAccountId,
        name: resourceName,
        dimensions: 768,
        metric: "cosine",
      });
      return journalProviderResult(value, {
        accepted: true,
        created_on: value.created_on,
      }, "create_vectorize");
    };
    const reconcileVectorize = async (databaseId, beforeBoundary) => {
      const checkedDatabaseId = providerId(databaseId,
        "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      const { state, provider_metadata: providerMetadata } =
        await stableProvisioningInventory(beforeBoundary);
      const baseExact = !state.worker_exists && state.worker_ids.length === 0 &&
        state.d1_exists && canonical(state.d1_ids) === canonical([checkedDatabaseId]);
      if (!baseExact) refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
      if (!state.vectorize_exists && state.vectorize_names.length === 0 &&
          state.vectorize_created_on === null) {
        return Object.freeze({ outcome: "resume_safe" });
      }
      if (!state.vectorize_exists || canonical(state.vectorize_names) !==
          canonical([resourceName]) ||
          !Number.isFinite(Date.parse(state.vectorize_created_on))) {
        refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
      }
      return Object.freeze({
        outcome: "confirmed",
        value: Object.freeze({
          provider_metadata: providerMetadata,
          result: Object.freeze({ accepted: true, created_on: state.vectorize_created_on }),
        }),
      });
    };
    const createMetadataIndex = async ({ propertyName, indexType }, {
      sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
      attempts = 100,
    } = {}) => {
      const expected = VECTOR_METADATA_INDEXES.find((entry) =>
        entry.property_name === propertyName && entry.index_type === indexType);
      if (!expected || typeof sleep !== "function" || !Number.isSafeInteger(attempts) ||
          attempts < 1 || attempts > 100) {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const evidence = [];
      const created = await transport.createVectorizeMetadataIndex({
        account_id: checkedAccountId,
        index_name: resourceName,
        property_name: propertyName,
        index_type: indexType,
      });
      evidence.push(directResponseEvidence(created, `create_metadata_${propertyName}`));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const read = await transport.readVectorizeMetadataIndexes({
          account_id: checkedAccountId,
          index_name: resourceName,
        });
        evidence.push(directResponseEvidence(read, `read_metadata_${propertyName}_${attempt}`));
        const exact = read.indexes.filter((entry) => entry.property_name === propertyName);
        if (exact.length === 1 && exact[0].index_type === indexType) {
          return Object.freeze({
            provider_metadata: aggregateProviderMetadata(evidence),
            result: Object.freeze({ property_name: propertyName, index_type: indexType }),
          });
        }
        if (exact.length > 0) refuse("CF_DISPOSABLE_PROVIDER_METADATA_INDEX_MISMATCH");
        if (attempt < attempts) await sleep(3_000);
      }
      refuse("CF_DISPOSABLE_PROVIDER_METADATA_INDEX_UNCONFIRMED");
    };
    const reconcileMetadataIndex = async (
      { propertyName, indexType }, beforeBoundary = async () => true,
    ) => {
      const expected = VECTOR_METADATA_INDEXES.find((entry) =>
        entry.property_name === propertyName && entry.index_type === indexType);
      if (!expected || typeof beforeBoundary !== "function") {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const read = async () => {
        if (await beforeBoundary() !== true) {
          refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_CHANGED");
        }
        return transport.readVectorizeMetadataIndexes({
          account_id: checkedAccountId,
          index_name: resourceName,
        });
      };
      const first = await read();
      const second = await read();
      if (canonical(first.indexes) !== canonical(second.indexes)) {
        refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
      }
      const exact = first.indexes.filter((entry) => entry.property_name === propertyName);
      if (exact.length === 0) return Object.freeze({ outcome: "resume_safe" });
      if (exact.length !== 1 || exact[0].index_type !== indexType) {
        refuse("CF_DISPOSABLE_PROVIDER_METADATA_INDEX_MISMATCH");
      }
      return Object.freeze({
        outcome: "confirmed",
        value: Object.freeze({
          provider_metadata: aggregateProviderMetadata([
            directResponseEvidence(first, `reconcile_metadata_${propertyName}_1`),
            directResponseEvidence(second, `reconcile_metadata_${propertyName}_2`),
          ]),
          result: Object.freeze({ property_name: propertyName, index_type: indexType }),
        }),
      });
    };
    const createWorker = async ({ campaignFingerprint }) => {
      const value = await transport.createWorkerIdentity({
        account_id: checkedAccountId,
        name: resourceName,
        tag: workerCampaignTag(checkedRole, campaignFingerprint),
      });
      return journalProviderResult(value, { worker_id: value.worker_id }, "create_worker_identity");
    };
    const reconcileWorker = async (databaseId, campaignFingerprint, beforeBoundary) => {
      const checkedDatabaseId = providerId(databaseId,
        "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      const { state, provider_metadata: inventoryMetadata } =
        await stableProvisioningInventory(beforeBoundary);
      if (!state.d1_exists || canonical(state.d1_ids) !== canonical([checkedDatabaseId]) ||
          !state.vectorize_exists || canonical(state.vectorize_names) !==
            canonical([resourceName])) {
        refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
      }
      if (!state.worker_exists && state.worker_ids.length === 0) {
        return Object.freeze({ outcome: "resume_safe" });
      }
      if (!state.worker_exists || state.worker_ids.length !== 1) {
        refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
      }
      const checkedWorkerId = String(state.worker_ids[0]).toLowerCase();
      const first = await readFinalIdentity({
        workerId: checkedWorkerId, campaignFingerprint,
      });
      const second = await readFinalIdentity({
        workerId: checkedWorkerId, campaignFingerprint,
      });
      if (canonical(first) !== canonical(second)) {
        refuse("CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
      }
      return Object.freeze({
        outcome: "confirmed",
        value: Object.freeze({
          provider_metadata: inventoryMetadata,
          result: Object.freeze({ worker_id: checkedWorkerId }),
        }),
      });
    };
    const readFinalIdentity = async ({ workerId, campaignFingerprint }) => {
      const checkedWorkerId = String(workerId ?? "").toLowerCase();
      if (!/^[a-f0-9]{32}$/u.test(checkedWorkerId)) {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const value = await transport.readWorkerIdentity({
        account_id: checkedAccountId,
        worker_id: checkedWorkerId,
        expected_name: resourceName,
        expected_tag: workerCampaignTag(checkedRole, campaignFingerprint),
      });
      return Object.freeze({
        worker_id: value.worker_id,
        hostname: value.hostname,
        created_on: value.created_on,
      });
    };

    const inspectSourceSchema = async (databaseId, beforeBoundary = async () => true) => {
      if (checkedRole !== "source") refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      if (typeof beforeBoundary !== "function") refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      const checkedDatabaseId = providerId(databaseId,
        "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      const evidence = [];
      const query = async (sql, params = []) => {
        if (await beforeBoundary() !== true) {
          refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_CHANGED");
        }
        const value = await transport.queryD1({
          account_id: checkedAccountId,
          database_id: checkedDatabaseId,
          sql,
          params,
        });
        evidence.push(directResponseEvidence(value, "initialize_source_schema_query"));
        return value;
      };
      const initial = await query(
        `SELECT
          (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV') AS user_table_count,
          (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
             AND name = 'schema_migrations') AS schema_migrations_table`,
      );
      const initialCounts = validateD1CountRow(initial.results[0], [
        "user_table_count", "schema_migrations_table",
      ]);
      if (![0, 1].includes(initialCounts.schema_migrations_table)) {
        refuse("CF_DISPOSABLE_PROVIDER_D1_NOT_EMPTY");
      }
      if (initialCounts.schema_migrations_table === 0 &&
          initialCounts.user_table_count !== 0) {
        if (initialCounts.user_table_count !== 1) {
          refuse("CF_DISPOSABLE_PROVIDER_D1_NOT_EMPTY");
        }
        // The first schema statement may have committed while its HTTP
        // response was lost. Adopt only that exact pinned install_state DDL;
        // any other table is a competing writer, not a resumable prefix.
        const partial = await query(
          `SELECT name, type, sql FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'
             ORDER BY name ASC`,
        );
        if (partial.results.length !== 1 || !exactKeys(partial.results[0], [
          "name", "type", "sql",
        ]) || partial.results[0].name !== "install_state" ||
            partial.results[0].type !== "table" ||
            canonicalSchemaDefinition(partial.results[0].sql) !==
              initialSchemaPrefix.installStateSql) {
          refuse("CF_DISPOSABLE_PROVIDER_D1_NOT_EMPTY");
        }
      }
      let appliedCount = 0;
      if (initialCounts.schema_migrations_table === 1) {
        const applied = await query(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC",
        );
        if (applied.results.length > migrationSet.migrations.length) {
          refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
        }
        for (const [index, row] of applied.results.entries()) {
          const expected = migrationSet.migrations[index];
          if (!plainObject(row) || Number(row.version) !== expected.version ||
              row.name !== expected.name || row.checksum !== expected.checksum) {
            refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
          }
        }
        appliedCount = applied.results.length;
      }
      return { checkedDatabaseId, evidence, query, appliedCount };
    };

    const inspectSourcePostlude = async (query) => {
      const observed = await query(
        `SELECT
          (SELECT COUNT(*) FROM install_state) AS install_state_total_rows,
          (SELECT COUNT(*) FROM install_state WHERE id = 1 AND schema_version = 46
             AND client_slug = 'v048-field-proof' AND product_version = '0.4.8'
             AND gate_version = 5 AND ring = 'stable'
             AND vector_projection_status = 'verified') AS install_state_valid_rows,
          (SELECT COUNT(*) FROM owner_financial_map_key_state) AS owner_key_total_rows,
          (SELECT COUNT(*) FROM owner_financial_map_key_state
             WHERE tenant_id = 'primary' AND length(signing_salt) = 64
             AND signing_salt = lower(signing_salt)
             AND signing_salt NOT GLOB '*[^0-9a-f]*') AS owner_key_valid_rows,
          (SELECT COUNT(*) FROM source_original_id_key_state) AS source_key_total_rows,
          (SELECT COUNT(*) FROM source_original_id_key_state
             WHERE tenant_id = 'primary' AND length(signing_salt) = 64
             AND signing_salt = lower(signing_salt)
             AND signing_salt NOT GLOB '*[^0-9a-f]*') AS source_key_valid_rows,
          (SELECT COUNT(*) FROM owner_financial_map_key_state AS owner_key
             JOIN source_original_id_key_state AS source_key
               ON source_key.tenant_id = owner_key.tenant_id
              AND source_key.signing_salt = owner_key.signing_salt
             WHERE owner_key.tenant_id = 'primary') AS equal_primary_key_rows`,
      );
      const counts = validateD1CountRow(observed.results[0], [
        "install_state_total_rows", "install_state_valid_rows",
        "owner_key_total_rows", "owner_key_valid_rows",
        "source_key_total_rows", "source_key_valid_rows", "equal_primary_key_rows",
      ]);
      const compatiblePair = (total, valid) =>
        total === 0 && valid === 0 || total === 1 && valid === 1;
      if (!compatiblePair(counts.install_state_total_rows,
        counts.install_state_valid_rows) ||
          !compatiblePair(counts.owner_key_total_rows, counts.owner_key_valid_rows) ||
          !compatiblePair(counts.source_key_total_rows, counts.source_key_valid_rows) ||
          counts.equal_primary_key_rows !== 0 ||
          counts.install_state_total_rows === 0 &&
            (counts.owner_key_total_rows !== 0 || counts.source_key_total_rows !== 0) ||
          counts.owner_key_total_rows === 0 && counts.source_key_total_rows !== 0) {
        refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
      }
      return Object.freeze({
        installStatePresent: counts.install_state_valid_rows === 1,
        ownerKeyPresent: counts.owner_key_valid_rows === 1,
        sourceKeyPresent: counts.source_key_valid_rows === 1,
        complete: counts.install_state_valid_rows === 1 &&
          counts.owner_key_valid_rows === 1 && counts.source_key_valid_rows === 1,
      });
    };

    const completeSourcePostlude = async (query) => {
      let state = await inspectSourcePostlude(query);
      if (!state.installStatePresent) {
        const installedAt = now().toISOString();
        await query(
          `INSERT INTO install_state
          (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
           vector_projection_status, vector_projection_bootstrap_epoch,
           vector_projection_bootstrap_cursor, vector_projection_bootstrap_high_water,
           source_original_retrieval_generation)
         VALUES (1,?,?,?,?,?,?,'verified',0,NULL,NULL,0)`,
          ["v048-field-proof", "0.4.8", 46, 5, installedAt, "stable"],
        );
        state = await inspectSourcePostlude(query);
      }
      if (!state.ownerKeyPresent) {
        await query(
          "INSERT OR IGNORE INTO owner_financial_map_key_state (tenant_id, signing_salt) " +
          "VALUES ('primary', lower(hex(randomblob(32))))",
        );
        state = await inspectSourcePostlude(query);
      }
      if (!state.sourceKeyPresent) {
        await query(
          "INSERT INTO source_original_id_key_state (tenant_id, signing_salt) " +
          "SELECT 'primary', lower(hex(randomblob(32))) WHERE NOT EXISTS " +
          "(SELECT 1 FROM source_original_id_key_state WHERE tenant_id = 'primary')",
        );
        state = await inspectSourcePostlude(query);
      }
      if (!state.complete) refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
      return state;
    };

    const readCompletedSourceSchema = async (query, evidence) => {
      const postlude = await inspectSourcePostlude(query);
      if (!postlude.complete) refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
      const final = await query(
        `SELECT
          (SELECT COUNT(*) FROM schema_migrations) AS migrations,
          (SELECT MAX(version) FROM schema_migrations) AS schema_version,
          (SELECT COUNT(*) FROM documents) AS documents,
          (SELECT COUNT(*) FROM chunks) AS chunks,
          (SELECT COUNT(*) FROM chunks_fts) AS fts,
          (SELECT COUNT(*) FROM vector_outbox) AS outbox`,
      );
      const counts = validateD1CountRow(final.results[0], [
        "migrations", "schema_version", "documents", "chunks", "fts", "outbox",
      ]);
      if (counts.migrations !== migrationSet.migrations.length || counts.schema_version !== 46 ||
          counts.documents !== 0 || counts.chunks !== 0 || counts.fts !== 0 ||
          counts.outbox !== 0) {
        refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
      }
      return Object.freeze({
        provider_metadata: aggregateProviderMetadata(evidence),
        result: Object.freeze({
          migration_inventory_sha256: migrationSet.migrationInventorySha256,
          schema_version: 46,
        }),
      });
    };

    const initializeSourceSchema = async (databaseId, beforeBoundary = async () => true) => {
      const inspection = await inspectSourceSchema(databaseId, beforeBoundary);
      const { query, evidence, appliedCount } = inspection;
      for (const migration of migrationSet.migrations.slice(appliedCount)) {
        await runRestartSafeMigrationStatements(
          splitStatements(migration.sql),
          (statement) => query(statement),
        );
        await query(
          "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)",
          [migration.version, migration.name, now().toISOString(), migration.checksum],
        );
      }
      await completeSourcePostlude(query);
      return readCompletedSourceSchema(query, evidence);
    };

    const reconcileSourceSchema = async (databaseId, beforeBoundary = async () => true) => {
      const inspection = await inspectSourceSchema(databaseId, beforeBoundary);
      if (inspection.appliedCount === migrationSet.migrations.length) {
        const postlude = await inspectSourcePostlude(inspection.query);
        if (!postlude.complete) return Object.freeze({ outcome: "resume_safe" });
        return Object.freeze({
          outcome: "confirmed",
          value: await readCompletedSourceSchema(inspection.query, inspection.evidence),
        });
      }
      return Object.freeze({ outcome: "resume_safe" });
    };

    const createBaseline = async ({ databaseId, workerId, hostname, campaignFingerprint }) => {
      const checkedWorkerId = String(workerId ?? "").toLowerCase();
      if (!/^[a-f0-9]{32}$/u.test(checkedWorkerId)) {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const binding = fixedProvisionBinding(
        checkedRole,
        checkedAccountId,
        providerId(databaseId, "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID"),
        String(hostname ?? ""),
      );
      const labels = binding.domain.split(".");
      if (labels[0] !== resourceName || labels.length < 4 ||
          labels.slice(-2).join(".") !== "workers.dev") {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const secretBindings = [
        { name: "ADMIN_KEY", text: adminKey },
        { name: "RAG_PROXY_KEY", text: ragProxyKey },
        { name: "SESSION_SIGNING_KEY", text: sessionSigningKey },
        ...(checkedRole === "target"
          ? [{ name: "BANK_FEED_WRAPPING_KEY_V2", text: bankKey }]
          : []),
      ];
      try {
        const value = await transport.createWorkerBaseline({
          account_id: checkedAccountId,
          worker_id: checkedWorkerId,
          main_module: BOOTSTRAP_MAIN_MODULE,
          modules: [{
            name: BOOTSTRAP_MAIN_MODULE,
            content_type: "application/javascript+module",
            bytes: BOOTSTRAP_SOURCE,
          }],
          compatibility_date: COMPATIBILITY_DATE,
          bindings: nonSecretBindings(binding, "active"),
          secret_bindings: secretBindings,
          tag: bootstrapTag(checkedRole, campaignFingerprint),
          message: bootstrapMessage(checkedRole),
        });
        return journalProviderResult(value, { version_id: value.version_id }, "create_baseline");
      } finally {
        for (const entry of secretBindings) entry.text = "";
      }
    };

    const readFinal = async ({
      databaseId, workerId, vectorCreatedOn, baselineVersionId, campaignFingerprint,
    }) => {
      const checkedDatabaseId = providerId(databaseId,
        "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      const checkedWorkerId = String(workerId ?? "").toLowerCase();
      if (!/^[a-f0-9]{32}$/u.test(checkedWorkerId)) {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const worker = await transport.readWorkerIdentity({
        account_id: checkedAccountId,
        worker_id: checkedWorkerId,
        expected_name: resourceName,
        expected_tag: workerCampaignTag(checkedRole, campaignFingerprint),
      });
      const binding = fixedProvisionBinding(
        checkedRole, checkedAccountId, checkedDatabaseId, worker.hostname,
      );
      const checkedBaselineVersionId = providerId(baselineVersionId,
        "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      const currentState = await transport.readCurrentDeploymentState(currentRequest(binding));
      if (currentState.deployment_count !== 1 || !plainObject(currentState.current)) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const current = currentState.current;
      const inventory = await readBaselineInventory(checkedWorkerId, async () => true);
      baselineInventoryVersion(inventory, checkedBaselineVersionId);
      const provisionVersion = await readBaselineVersion(
        checkedWorkerId, checkedBaselineVersionId, campaignFingerprint, async () => true,
      );
      const deployment = await transport.readDeployment(
        exactDeploymentRequest(binding, current.deployment_id),
      );
      const semanticDeployment = deploymentSemantic(deployment);
      if (canonical(current.versions) !== canonical(deployment.versions) ||
          semanticDeployment.version_id !== checkedBaselineVersionId) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const version = await transport.readVersion(
        exactVersionRequest(binding, checkedRole, semanticDeployment.version_id, "active"),
      );
      const settings = await transport.readWorkerVersionSettings({
        account_id: checkedAccountId,
        script_name: resourceName,
        main_module: BOOTSTRAP_MAIN_MODULE,
        compatibility_date: COMPATIBILITY_DATE,
        bindings: versionExpectation(binding, checkedRole, "active").bindings,
        tag: bootstrapTag(checkedRole, campaignFingerprint),
        message: bootstrapMessage(checkedRole),
        worker_tag: workerCampaignTag(checkedRole, campaignFingerprint),
      });
      if (version.bindings_sha256 !== provisionVersion.bindings_sha256 ||
          version.behavior_exact !== true || settings.behavior_exact !== true ||
          version.behavior_sha256 !== provisionVersion.behavior_sha256 ||
          !SHA256_RE.test(String(settings.behavior_sha256 ?? ""))) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const resource = await transport.readResourceContract(resourceRequest(binding));
      const metadata = await transport.readVectorizeMetadataIndexes({
        account_id: checkedAccountId,
        index_name: resourceName,
      });
      if (resource.vector_count !== 0 || resource.vectorize_created_on !== vectorCreatedOn ||
          canonical(metadata.indexes) !== canonical([...VECTOR_METADATA_INDEXES]
            .sort((left, right) => left.property_name.localeCompare(right.property_name)))) {
        refuse("CF_DISPOSABLE_PROVIDER_VECTOR_NOT_EMPTY");
      }
      let d1;
      if (checkedRole === "source") {
        d1 = await transport.queryD1({
          account_id: checkedAccountId,
          database_id: checkedDatabaseId,
          sql: `SELECT
            (SELECT COUNT(*) FROM schema_migrations) AS migrations,
            (SELECT MAX(version) FROM schema_migrations) AS schema_version,
            (SELECT COUNT(*) FROM documents) AS documents,
            (SELECT COUNT(*) FROM chunks) AS chunks,
            (SELECT COUNT(*) FROM chunks_fts) AS fts,
            (SELECT COUNT(*) FROM vector_outbox) AS outbox,
            (SELECT COUNT(*) FROM install_state) AS install_state_total_rows,
            (SELECT COUNT(*) FROM install_state WHERE id = 1 AND schema_version = 46
               AND client_slug = 'v048-field-proof' AND product_version = '0.4.8'
               AND gate_version = 5 AND ring = 'stable'
               AND vector_projection_status = 'verified') AS install_state_valid_rows,
            (SELECT COUNT(*) FROM owner_financial_map_key_state) AS owner_key_total_rows,
            (SELECT COUNT(*) FROM owner_financial_map_key_state
               WHERE tenant_id = 'primary' AND length(signing_salt) = 64
               AND signing_salt = lower(signing_salt)
               AND signing_salt NOT GLOB '*[^0-9a-f]*') AS owner_key_valid_rows,
            (SELECT COUNT(*) FROM source_original_id_key_state) AS source_key_total_rows,
            (SELECT COUNT(*) FROM source_original_id_key_state
               WHERE tenant_id = 'primary' AND length(signing_salt) = 64
               AND signing_salt = lower(signing_salt)
               AND signing_salt NOT GLOB '*[^0-9a-f]*') AS source_key_valid_rows,
            (SELECT COUNT(*) FROM owner_financial_map_key_state AS owner_key
               JOIN source_original_id_key_state AS source_key
                 ON source_key.tenant_id = owner_key.tenant_id
                AND source_key.signing_salt = owner_key.signing_salt
               WHERE owner_key.tenant_id = 'primary') AS equal_primary_key_rows`,
          params: [],
        });
        const counts = validateD1CountRow(d1.results[0], [
          "migrations", "schema_version", "documents", "chunks", "fts", "outbox",
          "install_state_total_rows", "install_state_valid_rows",
          "owner_key_total_rows", "owner_key_valid_rows",
          "source_key_total_rows", "source_key_valid_rows", "equal_primary_key_rows",
        ]);
        if (counts.migrations !== 46 || counts.schema_version !== 46 ||
            counts.documents !== 0 || counts.chunks !== 0 || counts.fts !== 0 ||
            counts.outbox !== 0 || counts.install_state_total_rows !== 1 ||
            counts.install_state_valid_rows !== 1 || counts.owner_key_total_rows !== 1 ||
            counts.owner_key_valid_rows !== 1 || counts.source_key_total_rows !== 1 ||
            counts.source_key_valid_rows !== 1 || counts.equal_primary_key_rows !== 0) {
          refuse("CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
        }
      } else {
        d1 = await transport.queryD1({
          account_id: checkedAccountId,
          database_id: checkedDatabaseId,
          sql: "SELECT COUNT(*) AS user_table_count FROM sqlite_master " +
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'",
          params: [],
        });
        if (validateD1CountRow(d1.results[0], ["user_table_count"]).user_table_count !== 0) {
          refuse("CF_DISPOSABLE_PROVIDER_D1_NOT_EMPTY");
        }
      }
      const evidence = [
        directResponseEvidence(worker, "read_worker_identity"),
        directResponseEvidence(currentState, "read_current_deployment_state"),
        ...inventory.responses.map((entry) => Object.freeze(entry)),
        directResponseEvidence(provisionVersion, "read_worker_version_for_provisioning"),
        directResponseEvidence(deployment, "read_deployment"),
        directResponseEvidence(version, "read_version"),
        directResponseEvidence(settings, "read_worker_version_settings"),
        ...resource.responses.map((entry) => Object.freeze(entry)),
        directResponseEvidence(metadata, "read_vectorize_metadata_indexes"),
        directResponseEvidence(d1, "read_d1_state"),
      ];
      return immutable({
        semantic: {
          account_id: checkedAccountId,
          role: checkedRole,
          resource_name: resourceName,
          worker_id: checkedWorkerId,
          worker_created_on: worker.created_on,
          worker_tag_sha256: worker.tag_sha256,
          hostname: worker.hostname,
          database_id: checkedDatabaseId,
          active_deployment_id: semanticDeployment.deployment_id,
          active_version_id: semanticDeployment.version_id,
          active_script_etag: version.script_etag,
          active_traffic_percent: 100,
          baseline_mode: "maintenance-bootstrap",
          bindings_sha256: version.bindings_sha256,
          bootstrap_tag_sha256: settings.tag_sha256,
          resource: resourceSemantic(resource),
          schema_version: checkedRole === "source" ? 46 : null,
          user_tables: checkedRole === "source" ? null : 0,
          content_rows: 0,
          vector_count: 0,
          vectorize_created_on: vectorCreatedOn,
          metadata_indexes_sha256: sha256(canonical(metadata.indexes)),
        },
        evidence,
      });
    };

    const reconcileBaseline = async ({
      databaseId, workerId, hostname, campaignFingerprint,
    }, beforeBoundary = async () => true) => {
      if (typeof beforeBoundary !== "function") {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const checkedWorkerId = String(workerId ?? "").toLowerCase();
      if (!/^[a-f0-9]{32}$/u.test(checkedWorkerId)) {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const binding = fixedProvisionBinding(
        checkedRole, checkedAccountId,
        providerId(databaseId, "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID"),
        String(hostname ?? ""),
      );
      const readState = async () => {
        if (await beforeBoundary() !== true) {
          refuse("CF_DISPOSABLE_PROVIDER_EVIDENCE_CHANGED");
        }
        return transport.readCurrentDeploymentState(currentRequest(binding));
      };
      const firstState = await readState();
      const firstInventory = await readBaselineInventory(checkedWorkerId, beforeBoundary);
      const secondState = await readState();
      const secondInventory = await readBaselineInventory(checkedWorkerId, beforeBoundary);
      if (canonical(firstState.current) !== canonical(secondState.current) ||
          firstState.deployment_count !== secondState.deployment_count ||
          firstInventory.version_count !== secondInventory.version_count ||
          canonical(firstInventory.versions) !== canonical(secondInventory.versions)) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      if (firstState.deployment_count === 0) {
        if (firstInventory.version_count !== 0) {
          // The version-create response may have been lost before the deploy
          // side effect completed. Never upload a second version into that
          // ambiguous Worker identity.
          refuse("CF_DISPOSABLE_PROVIDER_BASELINE_UPLOAD_AMBIGUOUS");
        }
        return Object.freeze({ outcome: "resume_safe" });
      }
      if (firstState.deployment_count !== 1 || !plainObject(firstState.current)) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const semanticDeployment = deploymentSemantic(firstState.current);
      baselineInventoryVersion(firstInventory, semanticDeployment.version_id);
      const provisionVersion = await readBaselineVersion(
        checkedWorkerId, semanticDeployment.version_id, campaignFingerprint, beforeBoundary,
      );
      const deployment = await transport.readDeployment(
        exactDeploymentRequest(binding, semanticDeployment.deployment_id),
      );
      if (canonical(deployment.versions) !== canonical(firstState.current.versions)) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const version = await transport.readVersion(
        exactVersionRequest(binding, checkedRole, semanticDeployment.version_id, "active"),
      );
      const settings = await transport.readWorkerVersionSettings({
        account_id: checkedAccountId,
        script_name: resourceName,
        main_module: BOOTSTRAP_MAIN_MODULE,
        compatibility_date: COMPATIBILITY_DATE,
        bindings: versionExpectation(binding, checkedRole, "active").bindings,
        tag: bootstrapTag(checkedRole, campaignFingerprint),
        message: bootstrapMessage(checkedRole),
        worker_tag: workerCampaignTag(checkedRole, campaignFingerprint),
      });
      if (version.bindings_sha256 !== provisionVersion.bindings_sha256 ||
          version.behavior_exact !== true || settings.behavior_exact !== true ||
          version.behavior_sha256 !== provisionVersion.behavior_sha256 ||
          !SHA256_RE.test(String(settings.behavior_sha256 ?? ""))) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const finalState = await readState();
      const finalInventory = await readBaselineInventory(checkedWorkerId, beforeBoundary);
      if (canonical(finalState.current) !== canonical(firstState.current) ||
          finalState.deployment_count !== firstState.deployment_count ||
          finalInventory.version_count !== firstInventory.version_count ||
          canonical(finalInventory.versions) !== canonical(firstInventory.versions)) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      return Object.freeze({
        outcome: "confirmed",
        value: Object.freeze({
          provider_metadata: aggregateProviderMetadata([
            directResponseEvidence(firstState, "reconcile_baseline_state_1"),
            ...firstInventory.responses.map((entry) => Object.freeze(entry)),
            directResponseEvidence(secondState, "reconcile_baseline_state_2"),
            ...secondInventory.responses.map((entry) => Object.freeze(entry)),
            directResponseEvidence(provisionVersion,
              "reconcile_baseline_provision_version"),
            directResponseEvidence(deployment, "reconcile_baseline_deployment"),
            directResponseEvidence(version, "reconcile_baseline_version"),
            directResponseEvidence(settings, "reconcile_baseline_settings"),
            directResponseEvidence(finalState, "reconcile_baseline_state_3"),
            ...finalInventory.responses.map((entry) => Object.freeze(entry)),
          ]),
          result: Object.freeze({ version_id: semanticDeployment.version_id }),
        }),
      });
    };

    const dispose = () => {
      adminKey = null;
      artifactKey = null;
      bankKey = null;
      ragProxyKey = null;
      sessionSigningKey = null;
    };
    await keychainBoundary();
    return Object.freeze({
      createD1: boundOperation(createD1),
      reconcileD1: boundOperation(reconcileD1),
      createVectorize: boundOperation(createVectorize),
      reconcileVectorize:
        boundOperation(reconcileVectorize),
      createMetadataIndex:
        boundOperation(createMetadataIndex),
      reconcileMetadataIndex:
        boundOperation(reconcileMetadataIndex),
      createWorker: boundOperation(createWorker),
      reconcileWorker: boundOperation(reconcileWorker),
      readFinalIdentity:
        boundOperation(readFinalIdentity),
      initializeSourceSchema:
        boundOperation(initializeSourceSchema),
      reconcileSourceSchema:
        boundOperation(reconcileSourceSchema),
      createBaseline: boundOperation(createBaseline),
      reconcileBaseline:
        boundOperation(reconcileBaseline),
      readFinal: boundOperation(readFinal),
      dispose,
    });
  };

  return Object.freeze({
    schema_version: 1,
    role: checkedRole,
    accountId: checkedAccountId,
    resourceName,
    adminKeyLocator: checkedRole === "source"
      ? PROVISION_LOCATORS.sourceAdmin
      : PROVISION_LOCATORS.targetAdmin,
    recoveryArtifactKeyLocator: checkedRole === "target"
      ? PROVISION_LOCATORS.targetArtifact
      : null,
    bankWrappingKeyLocator: checkedRole === "target" ? PROVISION_LOCATORS.targetBank : null,
    candidateModuleInventorySha256: moduleSet.moduleInventorySha256,
    migrationInventorySha256: migrationSet.migrationInventorySha256,
    bootstrapModuleInventorySha256,
    readCollisions,
    createMutationProvider,
  });
}


/**
 * Load the exact package-pinned module inventory and return a provider factory
 * suitable for one of the four split field-runner commands.
 */
export function prepareCloudflareDisposableDeploymentProvider(
  { manifestBindings, executionPins, phase, keychainBinding, keychainProof },
  {
    platform = process.platform,
    fetchImpl = globalThis.fetch,
    loadToken = loadStoredCloudflareToken,
    createTransport = createCloudflareDisposableDeploymentTransport,
  } = {},
) {
  if (platform !== "darwin") refuse("CF_DISPOSABLE_PROVIDER_MACOS_KEYCHAIN_REQUIRED");
  if (typeof fetchImpl !== "function" || typeof loadToken !== "function" ||
      typeof createTransport !== "function") {
    refuse("CF_DISPOSABLE_PROVIDER_DEPENDENCY_INVALID");
  }
  const bindings = assertBindings(manifestBindings, phase);
  const checkedKeychainProof = checkedKeychainBindingCapability(
    keychainProof,
    keychainBinding,
  );
  const manifestAccounts = phase === "source"
    ? [bindings.source.accountId]
    : [bindings.source.accountId, bindings.target.accountId];
  if (manifestAccounts.some((accountId) => accountId !== keychainBinding?.account_id)) {
    refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID");
  }
  const moduleSet = loadModules(executionPins);

  const transportFor = (binding) => createTransport({
    fetchImpl,
    resolveToken: async () => {
      let value;
      try { value = await loadToken(binding.accountId, { platform: "darwin" }); }
      catch { refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_TOKEN_UNAVAILABLE"); }
      if (!Buffer.isBuffer(value)) {
        value?.fill?.(0);
        refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_TOKEN_UNAVAILABLE");
      }
      return value;
    },
  });

  const createProvider = async (_beforeBoundary, context) => {
    if (!plainObject(context) || !plainObject(context.binding) ||
        !plainObject(context.requests) || context.phase !== phase ||
        context.binding.campaign_fingerprint === undefined ||
        context.binding.plan_fingerprint !== bindings.planFingerprint ||
        context.binding.source_manifest_fingerprint !==
          bindings.sourceManifestFingerprint ||
        phase === "target" && context.binding.target_manifest_fingerprint !==
          bindings.targetManifestFingerprint) {
      refuse("CF_DISPOSABLE_PROVIDER_CONTEXT_INVALID");
    }
    checkedKeychainCapability(
      checkedKeychainProof,
      context.binding.keychain_binding_sha256,
    );
    if (keychainBinding.candidate_sha !== context.binding.candidate_sha ||
        keychainBinding.candidate_tree_sha !== context.binding.candidate_tree_sha ||
        keychainBinding.package_sha256 !== context.binding.package_sha256 ||
        keychainBinding.field_receipt_sha256 !==
          context.binding.field_receipt_sha256) {
      refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID");
    }
    const keychainBindingSha256 = context.binding.keychain_binding_sha256;
    checkedKeychainBindingCapability(
      checkedKeychainProof,
      keychainBinding,
      keychainBindingSha256,
    );
    const boundOperation = (operation) => keychainBoundOperation(
      checkedKeychainProof,
      keychainBinding,
      keychainBindingSha256,
      operation,
    );
    await keychainCapabilityBoundary(
      checkedKeychainProof,
      keychainBinding,
      keychainBindingSha256,
    );
    const sourceTransport = transportFor(bindings.source);
    const targetTransport = context.phase === "target"
      ? transportFor(bindings.target)
      : null;
    const vectorizeMutationQuiescence = context.phase === "target"
      ? vectorizeQuiescenceSemantic(
        context.vectorize_mutation_quiescence,
        context.binding.target_resource_fingerprint,
      )
      : null;
    const readCurrentExact = async (transport, binding, prefix, expectedId = null) => {
      const current = await transport.readCurrentDeployment(currentRequest(binding));
      if (expectedId !== null && current.deployment_id !== expectedId) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const exact = await transport.readDeployment(
        exactDeploymentRequest(binding, current.deployment_id),
      );
      if (canonical(current.versions) !== canonical(exact.versions)) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      return Object.freeze({
        value: exact,
        evidence: Object.freeze([
          responseEvidence(`${prefix}_current_deployment`, current),
          responseEvidence(`${prefix}_exact_deployment`, exact),
        ]),
      });
    };

    const readVersion = async (transport, binding, role, versionId, mode, prefix) => {
      const value = await transport.readVersion(
        exactVersionRequest(binding, role, versionId, mode),
      );
      return Object.freeze({
        value,
        evidence: responseEvidence(`${prefix}_version`, value),
      });
    };

    const readResource = async (transport, binding, prefix) => {
      const value = await transport.readResourceContract(resourceRequest(binding));
      return Object.freeze({
        value,
        evidence: Object.freeze(resourceEvidence(prefix, value)),
      });
    };

    const localProtection = (role, current) => {
      const networkIsolation = networkIsolationSemantic(
        current.resource.value.network_isolation,
      );
      const reviewed = current.version.value.reviewed_worker_generation_sha256;
      if (!SHA256_RE.test(String(reviewed ?? ""))) {
        refuse("CF_DISPOSABLE_PROVIDER_WORKER_GENERATION_INVALID");
      }
      return Object.freeze({
        networkIsolation,
        workerGeneration: workerGenerationSemantic({
          schema_version: 1,
          worker_identity_proved: true,
          worker_generation_proved: true,
          worker_generation_sha256: sha256(canonical({
            schema_version: 1,
            role,
            mode: role === "source"
              ? "active"
              : current.mode === "paused-for-upgrade" ? "paused" : "active",
            worker_identity_sha256: networkIsolation.worker_identity_sha256,
            deployment_id: current.semanticDeployment.deployment_id,
            version_id: current.semanticDeployment.version_id,
            reviewed_worker_generation_sha256: reviewed,
          })),
        }),
      });
    };

    const readCampaignCustody = async (currentByRole) => {
      if (phase !== "target" || bindings.source.accountId !== bindings.target.accountId ||
          typeof targetTransport?.readCampaignCustody !== "function") {
        refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNAVAILABLE");
      }
      const resource = (role) => Object.freeze({
        worker_name: bindings[role].workerName,
        d1_database_id: bindings[role].databaseId,
        d1_database_name: bindings[role].databaseName,
        vectorize_index_name: bindings[role].vectorizeIndex,
        domain: bindings[role].domain,
      });
      const expected = (role) => Object.freeze({
        deployment_id: currentByRole[role].semanticDeployment.deployment_id,
        version_id: currentByRole[role].semanticDeployment.version_id,
        script_etag: currentByRole[role].version.value.script_etag,
        reviewed_worker_generation_sha256:
          currentByRole[role].version.value.reviewed_worker_generation_sha256,
      });
      let value;
      try {
        value = await targetTransport.readCampaignCustody({
          account_id: bindings.source.accountId,
          teardown_role: "source",
          campaign_resources: Object.freeze({
            source: resource("source"),
            target: resource("target"),
          }),
          expected_workers: Object.freeze({
            source: expected("source"),
            target: expected("target"),
          }),
        });
      } catch {
        refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNVERIFIED");
      }
      return Object.freeze({ value, semantic: campaignCustodySemantic(value) });
    };

    const custodyProtection = (role, current, custody) => {
      const local = localProtection(role, current);
      const proof = custody.value.roles?.[role]?.worker_protection;
      if (!plainObject(proof) || proof.worker_identity_sha256 !==
          local.networkIsolation.worker_identity_sha256 ||
          proof.reviewed_worker_generation_sha256 !==
            current.version.value.reviewed_worker_generation_sha256) {
        refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNVERIFIED");
      }
      return Object.freeze({
        networkIsolation: local.networkIsolation,
        workerGeneration: workerGenerationSemantic(proof),
      });
    };

    const sourceCurrent = async (expected = null) => {
      const deployment = await readCurrentExact(
        sourceTransport,
        bindings.source,
        "source",
        expected?.deploymentId ?? null,
      );
      const semanticDeployment = deploymentSemantic(deployment.value);
      if (expected?.versionId && semanticDeployment.version_id !== expected.versionId) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const version = await readVersion(
        sourceTransport,
        bindings.source,
        "source",
        semanticDeployment.version_id,
        "active",
        "source_active",
      );
      const resource = await readResource(sourceTransport, bindings.source, "source");
      return Object.freeze({
        deployment,
        semanticDeployment,
        version,
        resource,
        mode: "active",
      });
    };

    const targetCurrent = async (expected = null) => {
      const deployment = await readCurrentExact(
        targetTransport,
        bindings.target,
        "target",
        expected?.deploymentId ?? null,
      );
      const semanticDeployment = deploymentSemantic(deployment.value);
      if (expected?.versionId && semanticDeployment.version_id !== expected.versionId) {
        refuse("CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
      }
      const mode = expected?.mode ?? "active";
      const version = await readVersion(
        targetTransport,
        bindings.target,
        "target",
        semanticDeployment.version_id,
        mode,
        `target_${mode === "active" ? "active" : "paused"}`,
      );
      const resource = await readResource(targetTransport, bindings.target, "target");
      return Object.freeze({ deployment, semanticDeployment, version, resource, mode });
    };

    const evidenceFor = (...groups) => Object.freeze(groups.flatMap((group) =>
      Array.isArray(group) ? group : [group]));

    const readSnapshot = async (requestInput) => {
      const request = checkSnapshotRequest(requestInput, context);
      if (request.stage === "source_preflight") {
        if (request.expected !== null) refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
        const source = await sourceCurrent();
        const protection = localProtection("source", source);
        return immutable({
          schema_version: 1,
          phase: request.phase,
          stage: request.stage,
          read_ordinal: request.read_ordinal,
          evidence: evidenceFor(
            source.deployment.evidence,
            source.version.evidence,
            source.resource.evidence,
          ),
          semantic: {
            source: {
              baseline_deployment_id: source.semanticDeployment.deployment_id,
              baseline_script_etag: source.version.value.script_etag,
              baseline_traffic_percent: 100,
              baseline_version_id: source.semanticDeployment.version_id,
              resource: resourceSemantic(source.resource.value),
              resource_fingerprint: context.binding.source_resource_fingerprint,
              network_isolation: protection.networkIsolation,
              worker_generation: protection.workerGeneration,
            },
          },
        });
      }
      if (request.stage === "source_final") {
        const expected = checkExpected(request.expected, [
          "active_deployment_id", "active_version_id",
        ]);
        const source = await sourceCurrent({
          deploymentId: expected.active_deployment_id,
          versionId: expected.active_version_id,
        });
        const protection = localProtection("source", source);
        return immutable({
          schema_version: 1,
          phase: request.phase,
          stage: request.stage,
          read_ordinal: request.read_ordinal,
          evidence: evidenceFor(
            source.deployment.evidence,
            source.version.evidence,
            source.resource.evidence,
          ),
          semantic: {
            source: {
              active_deployment: source.semanticDeployment,
              active_version: versionSemantic(source.version.value),
              resource: resourceSemantic(source.resource.value),
              resource_fingerprint: context.binding.source_resource_fingerprint,
              network_isolation: protection.networkIsolation,
              worker_generation: protection.workerGeneration,
            },
          },
        });
      }
      if (request.stage === "target_preflight") {
        if (request.expected !== null) refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
        const source = await sourceCurrent();
        const target = await targetCurrent();
        const custody = await readCampaignCustody({ source, target });
        const sourceProtection = custodyProtection("source", source, custody);
        const targetProtection = custodyProtection("target", target, custody);
        return immutable({
          schema_version: 1,
          phase: request.phase,
          stage: request.stage,
          read_ordinal: request.read_ordinal,
          evidence: evidenceFor(
            source.deployment.evidence,
            source.version.evidence,
            source.resource.evidence,
            target.deployment.evidence,
            target.version.evidence,
            target.resource.evidence,
            resourceEvidence("campaign_custody", custody.value),
          ),
          semantic: {
            campaign_custody: custody.semantic,
            vectorize_mutation_quiescence: vectorizeMutationQuiescence,
            source: {
              active_deployment_id: source.semanticDeployment.deployment_id,
              active_script_etag: source.version.value.script_etag,
              active_traffic_percent: 100,
              active_version_id: source.semanticDeployment.version_id,
              resource: resourceSemantic(source.resource.value),
              resource_fingerprint: context.binding.source_resource_fingerprint,
              network_isolation: sourceProtection.networkIsolation,
              worker_generation: sourceProtection.workerGeneration,
            },
            target: {
              baseline_deployment_id: target.semanticDeployment.deployment_id,
              baseline_script_etag: target.version.value.script_etag,
              baseline_traffic_percent: 100,
              baseline_version_id: target.semanticDeployment.version_id,
              resource: resourceSemantic(target.resource.value),
              resource_fingerprint: context.binding.target_resource_fingerprint,
              network_isolation: targetProtection.networkIsolation,
              worker_generation: targetProtection.workerGeneration,
            },
          },
        });
      }
      if (request.stage === "target_final") {
        const expected = checkExpected(request.expected, [
          "source_active_deployment_id", "source_active_version_id",
          "target_active_version_id", "target_paused_deployment_id",
          "target_paused_version_id",
        ]);
        const source = await sourceCurrent({
          deploymentId: expected.source_active_deployment_id,
          versionId: expected.source_active_version_id,
        });
        const target = await targetCurrent({
          deploymentId: expected.target_paused_deployment_id,
          versionId: expected.target_paused_version_id,
          mode: "paused-for-upgrade",
        });
        const active = await readVersion(
          targetTransport,
          bindings.target,
          "target",
          expected.target_active_version_id,
          "active",
          "target_active",
        );
        const custody = await readCampaignCustody({ source, target });
        const sourceProtection = custodyProtection("source", source, custody);
        const targetProtection = custodyProtection("target", target, custody);
        const campaignAuthority = campaignSemanticAuthority({
          targetMode: "paused",
          approvedVersions: Object.freeze({
            source: Object.freeze({
              version_id: source.semanticDeployment.version_id,
              script_etag: source.version.value.script_etag,
              reviewed_worker_generation_sha256:
                source.version.value.reviewed_worker_generation_sha256,
            }),
            target_paused: Object.freeze({
              version_id: target.semanticDeployment.version_id,
              script_etag: target.version.value.script_etag,
              reviewed_worker_generation_sha256:
                target.version.value.reviewed_worker_generation_sha256,
            }),
            target_active: Object.freeze({
              version_id: active.value.version_id,
              script_etag: active.value.script_etag,
              reviewed_worker_generation_sha256:
                active.value.reviewed_worker_generation_sha256,
            }),
          }),
          campaignCustody: custody.semantic,
          sourceNetworkIsolation: sourceProtection.networkIsolation,
          targetNetworkIsolation: targetProtection.networkIsolation,
        });
        return immutable({
          schema_version: 1,
          phase: request.phase,
          stage: request.stage,
          read_ordinal: request.read_ordinal,
          evidence: evidenceFor(
            source.deployment.evidence,
            source.version.evidence,
            source.resource.evidence,
            target.deployment.evidence,
            target.version.evidence,
            active.evidence,
            target.resource.evidence,
            resourceEvidence("campaign_custody", custody.value),
          ),
          semantic: {
            campaign_authority: campaignAuthority,
            campaign_custody: custody.semantic,
            vectorize_mutation_quiescence: vectorizeMutationQuiescence,
            source: {
              active_deployment_id: source.semanticDeployment.deployment_id,
              active_script_etag: source.version.value.script_etag,
              active_traffic_percent: 100,
              active_version_id: source.semanticDeployment.version_id,
              resource: resourceSemantic(source.resource.value),
              resource_fingerprint: context.binding.source_resource_fingerprint,
              network_isolation: sourceProtection.networkIsolation,
              worker_generation: sourceProtection.workerGeneration,
            },
            target: {
              active_version: versionSemantic(active.value),
              paused_deployment: target.semanticDeployment,
              paused_version: versionSemantic(target.version.value),
              resource: resourceSemantic(target.resource.value),
              resource_fingerprint: context.binding.target_resource_fingerprint,
              network_isolation: targetProtection.networkIsolation,
              worker_generation: targetProtection.workerGeneration,
            },
          },
        });
      }
      refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
    };

    const uploadVersion = async (request, opening) => {
      const expectedRequest = request.role === "source"
        ? context.requests.source_active_upload
        : request.mode === "paused-for-upgrade"
          ? context.requests.target_paused_upload
          : context.requests.target_active_upload;
      if (canonical(request) !== canonical(expectedRequest) ||
          request.module_inventory_sha256 !== moduleSet.moduleInventorySha256 ||
          request.role !== context.phase) {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const binding = bindings[request.role];
      const baseline = opening?.[request.role];
      const baselineVersionId = providerId(baseline?.baseline_version_id,
        "CF_DISPOSABLE_PROVIDER_BASELINE_INVALID");
      return (request.role === "source" ? sourceTransport : targetTransport).uploadVersion({
        account_id: binding.accountId,
        script_name: binding.workerName,
        main_module: moduleSet.mainModule,
        modules: moduleSet.modules,
        compatibility_date: COMPATIBILITY_DATE,
        bindings: nonSecretBindings(binding, request.mode),
        secret_names: secretNames(request.role),
        baseline_version_id: baselineVersionId,
        tag: request.tag,
        message: `Financial Brain 0.4.8 disposable recovery ${request.role} ${request.mode}`,
      });
    };

    const deployVersion = async (request, versionId, _opening) => {
      const expectedRequest = request.role === "source"
        ? context.requests.source_active_deployment
        : context.requests.target_paused_deployment;
      const expectedVersionId = providerId(versionId,
        "CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      if (canonical(request) !== canonical(expectedRequest) ||
          request.role !== context.phase || request.traffic_percent !== 100 ||
          request.force !== false) {
        refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
      }
      const binding = bindings[request.role];
      return (request.role === "source" ? sourceTransport : targetTransport).deployVersion({
        account_id: binding.accountId,
        script_name: binding.workerName,
        version_id: expectedVersionId,
      });
    };

    return Object.freeze({
      deployVersion: boundOperation(deployVersion),
      readSnapshot: boundOperation(readSnapshot),
      uploadVersion: boundOperation(uploadVersion),
    });
  };

  return Object.freeze({
    schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_PROVIDER_SCHEMA_VERSION,
    moduleInventorySha256: moduleSet.moduleInventorySha256,
    createProvider,
  });
}

/**
 * Prepare the K0-bound read-only observer reused at A5, A7, and A12. Each
 * observation brackets the transport's own complete double census with two
 * exact network/resource reads for both campaign Workers.
 */
export function prepareCloudflareDisposableCampaignObserver(
  { manifestBindings, keychainBinding, keychainProof },
  {
    platform = process.platform,
    fetchImpl = globalThis.fetch,
    loadToken = loadStoredCloudflareToken,
    createTransport = createCloudflareDisposableDeploymentTransport,
  } = {},
) {
  if (platform !== "darwin") refuse("CF_DISPOSABLE_PROVIDER_MACOS_KEYCHAIN_REQUIRED");
  if (typeof fetchImpl !== "function" || typeof loadToken !== "function" ||
      typeof createTransport !== "function") {
    refuse("CF_DISPOSABLE_PROVIDER_DEPENDENCY_INVALID");
  }
  const bindings = assertBindings(manifestBindings, "target");
  const proof = checkedKeychainBindingCapability(keychainProof, keychainBinding);
  if (bindings.source.accountId !== bindings.target.accountId ||
      keychainBinding?.account_id !== bindings.source.accountId) {
    refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID");
  }
  const bindingSha256 = proof.keychain_binding_sha256;
  const transport = createTransport({
    fetchImpl,
    resolveToken: async () => {
      let value;
      try {
        value = await loadToken(bindings.source.accountId, { platform: "darwin" });
      } catch {
        refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_TOKEN_UNAVAILABLE");
      }
      if (!Buffer.isBuffer(value)) {
        value?.fill?.(0);
        refuse("CF_DISPOSABLE_PROVIDER_KEYCHAIN_TOKEN_UNAVAILABLE");
      }
      return value;
    },
  });
  if (typeof transport?.readResourceContract !== "function" ||
      typeof transport?.readCampaignCustody !== "function") {
    refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNAVAILABLE");
  }

  const observe = async (input) => {
    if (!exactKeys(input, ["a4_authority", "target_mode"]) ||
        !["paused", "active"].includes(input.target_mode)) {
      refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_AUTHORITY_INVALID");
    }
    const a4 = assertCloudflareDisposableCampaignSemanticAuthority(
      input.a4_authority,
    );
    const targetMode = input.target_mode;
    const resources = (role) => Object.freeze({
      worker_name: bindings[role].workerName,
      d1_database_id: bindings[role].databaseId,
      d1_database_name: bindings[role].databaseName,
      vectorize_index_name: bindings[role].vectorizeIndex,
      domain: bindings[role].domain,
    });
    const selectedTarget = targetMode === "paused"
      ? a4.approved_versions.target_paused
      : a4.approved_versions.target_active;
    const expectedWorkers = Object.freeze({
      source: Object.freeze({
        deployment_id:
          a4.campaign_custody.generation_authority.source.deployment_id,
        version_id: a4.approved_versions.source.version_id,
        script_etag: a4.approved_versions.source.script_etag,
        reviewed_worker_generation_sha256:
          a4.approved_versions.source.reviewed_worker_generation_sha256,
      }),
      target: Object.freeze({
        deployment_id: targetMode === "paused"
          ? a4.campaign_custody.generation_authority.target.deployment_id
          : null,
        version_id: selectedTarget.version_id,
        script_etag: selectedTarget.script_etag,
        reviewed_worker_generation_sha256:
          selectedTarget.reviewed_worker_generation_sha256,
      }),
    });
    const readNetwork = async (role) => networkIsolationSemantic(
      (await transport.readResourceContract(resourceRequest(bindings[role])))
        .network_isolation,
    );
    const before = Object.freeze({
      source: await readNetwork("source"),
      target: await readNetwork("target"),
    });
    let custodyValue;
    try {
      custodyValue = await transport.readCampaignCustody({
        account_id: bindings.source.accountId,
        teardown_role: "source",
        campaign_resources: Object.freeze({
          source: resources("source"),
          target: resources("target"),
        }),
        expected_workers: expectedWorkers,
      });
    } catch {
      refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNVERIFIED");
    }
    const custody = campaignCustodySemantic(custodyValue);
    const after = Object.freeze({
      source: await readNetwork("source"),
      target: await readNetwork("target"),
    });
    if (canonical(before) !== canonical(after) ||
        before.source.worker_identity_sha256 !==
          custody.roles.source.worker_protection.worker_identity_sha256 ||
        before.target.worker_identity_sha256 !==
          custody.roles.target.worker_protection.worker_identity_sha256) {
      refuse("CF_DISPOSABLE_PROVIDER_CAMPAIGN_AUTHORITY_CHANGED");
    }
    const fresh = campaignSemanticAuthority({
      targetMode,
      approvedVersions: a4.approved_versions,
      campaignCustody: custody,
      sourceNetworkIsolation: after.source,
      targetNetworkIsolation: after.target,
    });
    return assertCloudflareDisposableCampaignSemanticContinuation(
      a4,
      fresh,
      targetMode,
    );
  };

  return Object.freeze({
    schema_version: 1,
    observe: keychainBoundOperation(
      proof,
      keychainBinding,
      bindingSha256,
      observe,
    ),
  });
}
