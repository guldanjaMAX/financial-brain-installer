/**
 * Closed manifest contract for the one disposable v0.4.8 recovery campaign.
 *
 * This module is deliberately dependency-free so every campaign entry point
 * can reject an incorrect target before opening a wrapper, credential store,
 * or network connection. It validates locators, never their secret values.
 */

export const V048_DISPOSABLE_CAMPAIGN_VERSION = "0.4.8";
export const V048_DISPOSABLE_CAMPAIGN_CLIENT_SLUG = "v048-field-proof";
export const V048_DISPOSABLE_CAMPAIGN_DISPLAY_NAME = "Synthetic Field Gate v0.4.8";
export const V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME =
  "brain-test-v048-field-source-recovery-gate-a48f1101";
export const V048_DISPOSABLE_CAMPAIGN_TARGET_NAME =
  "brain-test-v048-field-target-recovery-gate-a48f1102";
export const V048_DISPOSABLE_CAMPAIGN_SOURCE_ADMIN_KEY_LOCATOR =
  `keychain://${V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME}/owner`;
export const V048_DISPOSABLE_CAMPAIGN_TARGET_ADMIN_KEY_LOCATOR =
  `keychain://${V048_DISPOSABLE_CAMPAIGN_TARGET_NAME}/owner`;
export const V048_DISPOSABLE_CAMPAIGN_ARTIFACT_KEY_LOCATOR =
  `keychain://${V048_DISPOSABLE_CAMPAIGN_TARGET_NAME}/artifact-v1`;
export const V048_DISPOSABLE_CAMPAIGN_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const V048_DISPOSABLE_CAMPAIGN_EMBED_DIMENSIONS = 768;
export const V048_DISPOSABLE_CAMPAIGN_CORPORA = Object.freeze([
  "google_drive", "gmail", "calendar", "imap", "imessage", "zoom",
  "slack", "notion", "quickbooks", "microsoft", "dropbox", "hubspot",
  "upload", "local_folder", "bank_feed", "whatsapp",
]);

export const V048_DISPOSABLE_CAMPAIGN = Object.freeze({
  version: V048_DISPOSABLE_CAMPAIGN_VERSION,
  clientSlug: V048_DISPOSABLE_CAMPAIGN_CLIENT_SLUG,
  displayName: V048_DISPOSABLE_CAMPAIGN_DISPLAY_NAME,
  source: Object.freeze({
    name: V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME,
    adminKeyLocator: V048_DISPOSABLE_CAMPAIGN_SOURCE_ADMIN_KEY_LOCATOR,
  }),
  target: Object.freeze({
    name: V048_DISPOSABLE_CAMPAIGN_TARGET_NAME,
    adminKeyLocator: V048_DISPOSABLE_CAMPAIGN_TARGET_ADMIN_KEY_LOCATOR,
    artifactKeyLocator: V048_DISPOSABLE_CAMPAIGN_ARTIFACT_KEY_LOCATOR,
  }),
  retrieval: Object.freeze({
    embedModel: V048_DISPOSABLE_CAMPAIGN_EMBED_MODEL,
    embedDimensions: V048_DISPOSABLE_CAMPAIGN_EMBED_DIMENSIONS,
  }),
});

const ROLE_SET = new Set(["source", "target"]);
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;
const D1_DATABASE_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class V048DisposableCampaignContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048DisposableCampaignContractError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048DisposableCampaignContractError(code);
}

function object(value, code = "V048_CAMPAIGN_MANIFEST_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value;
}

function normalizedFieldName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function forbiddenBindingField(key) {
  const normalized = normalizedFieldName(key);
  return normalized === "bindings" || normalized === "route" || normalized === "routes" ||
    normalized === "custom_domain" || normalized === "custom_domains" ||
    normalized === "r2" || normalized.startsWith("r2_") ||
    normalized === "kv" || normalized.startsWith("kv_");
}

function isTargetIsolationAttestation(path, key, role, value) {
  return role === "target" &&
    path.length === 2 && path[0] === "operations" && path[1] === "recovery_field_gate" &&
    (key === "routes" || key === "custom_domains") &&
    Array.isArray(value) && value.length === 0;
}

function assertNoExtraProviderBindings(value, role, path = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      assertNoExtraProviderBindings(value[index], role, [...path, String(index)]);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenBindingField(key) && !isTargetIsolationAttestation(path, key, role, child)) {
      refuse("V048_CAMPAIGN_EXTRA_PROVIDER_BINDING_REFUSED");
    }
    assertNoExtraProviderBindings(child, role, [...path, key]);
  }
}

function expectedRole(role) {
  if (!ROLE_SET.has(role)) refuse("V048_CAMPAIGN_ROLE_INVALID");
  return role === "source" ? V048_DISPOSABLE_CAMPAIGN.source : V048_DISPOSABLE_CAMPAIGN.target;
}

function assertWorkersDevDomain(domain, expectedName) {
  const labels = typeof domain === "string" ? domain.toLowerCase().split(".") : [];
  if (labels.length < 4 || labels[0] !== expectedName ||
      labels.slice(-2).join(".") !== "workers.dev" ||
      labels.slice(1, -2).some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    refuse("V048_CAMPAIGN_DOMAIN_MISMATCH");
  }
  return domain.toLowerCase();
}

/** Validate one raw private manifest against its exact campaign role. */
export function validateV048DisposableCampaignManifest(manifest, role) {
  const expected = expectedRole(role);
  object(manifest);
  const otherRoleName = role === "source"
    ? V048_DISPOSABLE_CAMPAIGN_TARGET_NAME
    : V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME;
  if (manifest.brain?.worker_name === otherRoleName) {
    refuse("V048_CAMPAIGN_ROLE_RESOURCE_MISMATCH");
  }
  assertNoExtraProviderBindings(manifest, role);

  if (manifest.manifest_version !== 1) refuse("V048_CAMPAIGN_MANIFEST_VERSION_MISMATCH");
  if (manifest.client?.slug !== V048_DISPOSABLE_CAMPAIGN_CLIENT_SLUG) {
    refuse("V048_CAMPAIGN_CLIENT_SLUG_MISMATCH");
  }
  if (manifest.client?.display_name !== V048_DISPOSABLE_CAMPAIGN_DISPLAY_NAME) {
    refuse("V048_CAMPAIGN_DISPLAY_NAME_MISMATCH");
  }
  if (manifest.brain?.version !== V048_DISPOSABLE_CAMPAIGN_VERSION) {
    refuse("V048_CAMPAIGN_PRODUCT_VERSION_MISMATCH");
  }

  const cloudflare = object(
    manifest.infrastructure?.cloudflare,
    "V048_CAMPAIGN_CLOUDFLARE_CONTRACT_MISMATCH",
  );
  if (cloudflare.storage !== "d1") refuse("V048_CAMPAIGN_STORAGE_MISMATCH");
  if (manifest.brain?.worker_name !== expected.name ||
      cloudflare.d1_database_name !== expected.name ||
      cloudflare.vectorize_index !== expected.name) {
    refuse("V048_CAMPAIGN_RESOURCE_NAME_MISMATCH");
  }
  if (!ACCOUNT_ID_RE.test(String(cloudflare.account_id || "")) ||
      !D1_DATABASE_ID_RE.test(String(cloudflare.d1_database_id || ""))) {
    refuse("V048_CAMPAIGN_RESOURCE_ID_INVALID");
  }
  if (manifest.retrieval?.embed_model !== V048_DISPOSABLE_CAMPAIGN_EMBED_MODEL ||
      manifest.retrieval?.embed_dimensions !== V048_DISPOSABLE_CAMPAIGN_EMBED_DIMENSIONS) {
    refuse("V048_CAMPAIGN_RETRIEVAL_CONTRACT_MISMATCH");
  }

  const corpora = object(manifest.corpora, "V048_CAMPAIGN_CORPORA_CONTRACT_MISMATCH");
  for (const key of V048_DISPOSABLE_CAMPAIGN_CORPORA) {
    const corpus = object(corpora[key], "V048_CAMPAIGN_CORPORA_CONTRACT_MISMATCH");
    if (corpus.enabled !== false) refuse("V048_CAMPAIGN_CORPUS_ENABLED_REFUSED");
  }
  for (const [key, corpus] of Object.entries(corpora)) {
    if (!key.startsWith("_") &&
        (!corpus || typeof corpus !== "object" || Array.isArray(corpus) ||
          corpus.enabled !== false)) {
      refuse("V048_CAMPAIGN_CORPUS_ENABLED_REFUSED");
    }
  }

  const operations = object(manifest.operations, "V048_CAMPAIGN_OPERATIONS_CONTRACT_MISMATCH");
  if (operations.admin_key_secret !== expected.adminKeyLocator) {
    refuse("V048_CAMPAIGN_ADMIN_KEY_LOCATOR_MISMATCH");
  }
  if (role === "source") {
    if (Object.hasOwn(operations, "recovery_artifact_key_secret") ||
        Object.hasOwn(operations, "recovery_field_gate")) {
      refuse("V048_CAMPAIGN_SOURCE_ROLE_MISMATCH");
    }
  } else {
    if (operations.recovery_artifact_key_secret !== expected.artifactKeyLocator) {
      refuse("V048_CAMPAIGN_ARTIFACT_KEY_LOCATOR_MISMATCH");
    }
    const isolation = object(
      operations.recovery_field_gate,
      "V048_CAMPAIGN_TARGET_ROLE_MISMATCH",
    );
    if (!Array.isArray(isolation.routes) || isolation.routes.length !== 0 ||
        !Array.isArray(isolation.custom_domains) || isolation.custom_domains.length !== 0) {
      refuse("V048_CAMPAIGN_EXTRA_PROVIDER_BINDING_REFUSED");
    }
  }

  return Object.freeze({
    role,
    name: expected.name,
    clientSlug: V048_DISPOSABLE_CAMPAIGN_CLIENT_SLUG,
    displayName: V048_DISPOSABLE_CAMPAIGN_DISPLAY_NAME,
    productVersion: V048_DISPOSABLE_CAMPAIGN_VERSION,
    workerName: expected.name,
    databaseName: expected.name,
    vectorizeIndex: expected.name,
    accountId: String(cloudflare.account_id).toLowerCase(),
    databaseId: String(cloudflare.d1_database_id).toLowerCase(),
    domain: assertWorkersDevDomain(manifest.brain?.domain, expected.name),
    adminKeyLocator: expected.adminKeyLocator,
    ...(role === "target" ? { artifactKeyLocator: expected.artifactKeyLocator } : {}),
  });
}

/** Validate both raw manifests and bind the campaign to one Cloudflare account. */
export function assertV048DisposableCampaignManifestPair(sourceManifest, targetManifest) {
  const source = validateV048DisposableCampaignManifest(sourceManifest, "source");
  const target = validateV048DisposableCampaignManifest(targetManifest, "target");
  if (source.accountId !== target.accountId) refuse("V048_CAMPAIGN_ACCOUNT_MISMATCH");
  if (source.databaseId === target.databaseId) refuse("V048_CAMPAIGN_D1_ID_COLLISION");
  return Object.freeze({ source, target });
}
