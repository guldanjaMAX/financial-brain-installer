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

import { loadStoredCloudflareToken } from "./cloudflare-token-store.mjs";
import {
  createCloudflareDisposableDeploymentTransport,
} from "./cloudflare-disposable-deployment-transport.mjs";

export const CLOUDFLARE_DISPOSABLE_DEPLOYMENT_PROVIDER_SCHEMA_VERSION = 1;

const COMPATIBILITY_DATE = "2026-01-01";
const MAIN_MODULE = "index.js";
const WORKER_PREFIX = "worker/src/";
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
  if (!exactKeys(value, fields) || !["source", "target"].includes(role) ||
      !Array.isArray(value.enabledCorpora) || value.enabledCorpora.length !== 0 ||
      value.bankFeedEnabled !== false || value.recoveryFieldGate !== null ||
      value.embeddingDimensions !== 768 || value.productVersion !== "0.4.8") {
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
  if (phase === "target") checkedBinding(value.target, "target");
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
  });
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

/**
 * Load the exact package-pinned module inventory and return a provider factory
 * suitable for one of the four split field-runner commands.
 */
export function prepareCloudflareDisposableDeploymentProvider(
  { manifestBindings, executionPins, phase },
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
    const sourceTransport = transportFor(bindings.source);
    const targetTransport = context.phase === "target"
      ? transportFor(bindings.target)
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
      return Object.freeze({ deployment, semanticDeployment, version, resource });
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
      return Object.freeze({ deployment, semanticDeployment, version, resource });
    };

    const evidenceFor = (...groups) => Object.freeze(groups.flatMap((group) =>
      Array.isArray(group) ? group : [group]));

    const readSnapshot = async (requestInput) => {
      const request = checkSnapshotRequest(requestInput, context);
      if (request.stage === "source_preflight") {
        if (request.expected !== null) refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
        const source = await sourceCurrent();
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
            },
          },
        });
      }
      if (request.stage === "target_preflight") {
        if (request.expected !== null) refuse("CF_DISPOSABLE_PROVIDER_REQUEST_INVALID");
        const source = await sourceCurrent();
        const target = await targetCurrent();
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
          ),
          semantic: {
            source: {
              active_deployment_id: source.semanticDeployment.deployment_id,
              active_script_etag: source.version.value.script_etag,
              active_traffic_percent: 100,
              active_version_id: source.semanticDeployment.version_id,
              resource: resourceSemantic(source.resource.value),
              resource_fingerprint: context.binding.source_resource_fingerprint,
            },
            target: {
              baseline_deployment_id: target.semanticDeployment.deployment_id,
              baseline_script_etag: target.version.value.script_etag,
              baseline_traffic_percent: 100,
              baseline_version_id: target.semanticDeployment.version_id,
              resource: resourceSemantic(target.resource.value),
              resource_fingerprint: context.binding.target_resource_fingerprint,
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
          ),
          semantic: {
            source: {
              active_deployment_id: source.semanticDeployment.deployment_id,
              active_script_etag: source.version.value.script_etag,
              active_traffic_percent: 100,
              active_version_id: source.semanticDeployment.version_id,
              resource: resourceSemantic(source.resource.value),
              resource_fingerprint: context.binding.source_resource_fingerprint,
            },
            target: {
              active_version: versionSemantic(active.value),
              paused_deployment: target.semanticDeployment,
              paused_version: versionSemantic(target.version.value),
              resource: resourceSemantic(target.resource.value),
              resource_fingerprint: context.binding.target_resource_fingerprint,
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

    return Object.freeze({ deployVersion, readSnapshot, uploadVersion });
  };

  return Object.freeze({
    schema_version: CLOUDFLARE_DISPOSABLE_DEPLOYMENT_PROVIDER_SCHEMA_VERSION,
    moduleInventorySha256: moduleSet.moduleInventorySha256,
    createProvider,
  });
}
