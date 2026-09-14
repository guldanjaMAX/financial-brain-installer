/**
 * Pure offline contract proving that no traffic-bearing version of any
 * non-campaign Worker binds either campaign D1 database or Vectorize index.
 *
 * The caller must aggregate every page of the initial Workers Beta list and
 * pass its provider `total_count`. For each non-campaign Worker it must pass
 * the unmodified deployment-list result (latest first) and one full version
 * detail for every traffic-bearing version in the latest deployment.
 */

import { createHash } from "node:crypto";

export const V048_EXCLUSIVE_RESOURCE_CUSTODY_SCHEMA_VERSION = 1;
export const V048_EXCLUSIVE_RESOURCE_CUSTODY_KIND =
  "v048_exclusive_campaign_resource_custody_v1";
export const V048_EXCLUSIVE_RESOURCE_CUSTODY_AUTHORITY_KIND =
  "v048_exclusive_campaign_resource_custody_authority_v1";
export const V048_CURRENT_WORKER_BINDING_TYPES = Object.freeze([
  "ai",
  "ai_search",
  "ai_search_namespace",
  "analytics_engine",
  "assets",
  "browser",
  "d1",
  "data_blob",
  "dispatch_namespace",
  "durable_object_namespace",
  "flagship",
  "hyperdrive",
  "images",
  "inherit",
  "json",
  "kv_namespace",
  "media",
  "messaging",
  "mtls_certificate",
  "pipelines",
  "plain_text",
  "queue",
  "r2_bucket",
  "ratelimit",
  "secret_key",
  "secret_text",
  "secrets_store_secret",
  "send_email",
  "service",
  "text_blob",
  "vectorize",
  "version_metadata",
  "vpc_network",
  "vpc_service",
  "wasm_module",
  "workflow",
]);

const CUSTODY_HASH_DOMAIN =
  "financial-brain:v0.4.8:exclusive-resource-custody:v1";
const CAMPAIGN_HASH_DOMAIN =
  "financial-brain:v0.4.8:exclusive-resource-custody:campaign:v1";
const WORKER_LIST_HASH_DOMAIN =
  "financial-brain:v0.4.8:exclusive-resource-custody:worker-list:v1";
const BINDING_SET_HASH_DOMAIN =
  "financial-brain:v0.4.8:exclusive-resource-custody:binding-set:v1";
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const SAFE_IDENTIFIER_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const CURRENT_BINDING_TYPE_SET = new Set(V048_CURRENT_WORKER_BINDING_TYPES);
const INITIAL_WORKER_ALLOWED_KEYS = new Set([
  "created_on",
  "deployed_on",
  "id",
  "logpush",
  "name",
  "observability",
  "references",
  "subdomain",
  "tags",
  "tail_consumers",
  "updated_on",
]);
const DEPLOYMENT_ALLOWED_KEYS = new Set([
  "annotations",
  "author_email",
  "created_on",
  "id",
  "source",
  "strategy",
  "versions",
]);
const VERSION_ALLOWED_KEYS = new Set(["id", "metadata", "number", "resources"]);
const VERSION_RESOURCE_ALLOWED_KEYS = new Set(["bindings", "script", "script_runtime"]);
const MAX_WORKERS = 10_000;
const MAX_DEPLOYMENTS = 10_000;
const MAX_BINDINGS = 4_096;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_STRING_BYTES = 1024 * 1024;
const MAX_BINDING_SET_BYTES = 4 * 1024 * 1024;

export class V048ExclusiveResourceCustodyContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048ExclusiveResourceCustodyContractError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048ExclusiveResourceCustodyContractError(code);
}

function record(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.values(descriptors).some((descriptor) =>
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) {
    refuse(code);
  }
  return value;
}

function exactKeys(value, keys, code) {
  const actual = Object.keys(value).sort(binaryCompare);
  const expected = [...keys].sort(binaryCompare);
  if (canonical(actual) !== canonical(expected)) refuse(code);
}

function allowedKeys(value, allowed, required, code) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    refuse(code);
  }
}

function binaryCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(binaryCompare).map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function domainHash(domain, value) {
  const encoded = canonical(value);
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(encoded)), "ascii")
    .update("\0", "utf8")
    .update(encoded, "utf8")
    .digest("hex");
}

function boundedText(value, maximum, code) {
  if (typeof value !== "string" || !value || value.length > maximum ||
      value.trim() !== value || CONTROL_RE.test(value)) {
    refuse(code);
  }
  return value;
}

function isoTimestamp(value, code) {
  const timestamp = boundedText(value, 128, code);
  const parsed = new Date(timestamp);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp) ||
      !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    refuse(code);
  }
  return timestamp;
}

function safeIdentifier(value, code) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_RE.test(value)) refuse(code);
  return value;
}

function uuid(value, code) {
  if (typeof value !== "string" || !UUID_RE.test(value)) refuse(code);
  return value.toLowerCase();
}

function nonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) refuse(code);
  return value;
}

function normalizeCampaignRoleResource(value, code) {
  record(value, code);
  exactKeys(
    value,
    ["d1DatabaseId", "vectorizeIndexName", "workerName", "workerState"],
    code,
  );
  if (value.workerState !== "present" && value.workerState !== "absent") {
    refuse(code);
  }
  return Object.freeze({
    worker_name: safeIdentifier(value.workerName, code),
    worker_state: value.workerState,
    d1_database_id: uuid(value.d1DatabaseId, code),
    vectorize_index_name: safeIdentifier(value.vectorizeIndexName, code),
  });
}

function normalizeCampaignResources(value) {
  const code = "V048_EXCLUSIVE_CUSTODY_CAMPAIGN_INVALID";
  record(value, code);
  exactKeys(value, ["source", "target", "teardownRole"], code);
  if (value.teardownRole !== "source" && value.teardownRole !== "target") refuse(code);
  const source = normalizeCampaignRoleResource(value.source, code);
  const target = normalizeCampaignRoleResource(value.target, code);
  const workerNames = [source.worker_name, target.worker_name];
  const d1DatabaseIds = [source.d1_database_id, target.d1_database_id];
  const vectorizeIndexNames = [
    source.vectorize_index_name,
    target.vectorize_index_name,
  ];
  if (new Set(workerNames).size !== 2 || new Set(d1DatabaseIds).size !== 2 ||
      new Set(vectorizeIndexNames).size !== 2) {
    refuse(code);
  }
  if ((value.teardownRole === "source" && target.worker_state !== "present") ||
      (value.teardownRole === "target" && source.worker_state !== "absent")) {
    refuse(code);
  }
  const campaignWorkers = [source, target];
  const presentWorkerNames = campaignWorkers
    .filter((worker) => worker.worker_state === "present")
    .map((worker) => worker.worker_name);
  const absentWorkerNames = campaignWorkers
    .filter((worker) => worker.worker_state === "absent")
    .map((worker) => worker.worker_name);
  return Object.freeze({
    teardown_role: value.teardownRole,
    source,
    target,
    worker_names: Object.freeze(workerNames.sort(binaryCompare)),
    present_worker_names: Object.freeze(presentWorkerNames.sort(binaryCompare)),
    absent_worker_names: Object.freeze(absentWorkerNames.sort(binaryCompare)),
    d1_database_ids: Object.freeze(d1DatabaseIds.sort(binaryCompare)),
    vectorize_index_names: Object.freeze(vectorizeIndexNames.sort(binaryCompare)),
  });
}

function normalizeInitialWorker(worker, code) {
  record(worker, code);
  allowedKeys(worker, INITIAL_WORKER_ALLOWED_KEYS, ["deployed_on", "id", "name"], code);
  const deployedOn = worker.deployed_on === null
    ? null
    : isoTimestamp(worker.deployed_on, code);
  return Object.freeze({
    id: safeIdentifier(worker.id, code),
    name: safeIdentifier(worker.name, code),
    deployed_on: deployedOn,
  });
}

function normalizeInitialWorkerList(value, campaign) {
  const code = "V048_EXCLUSIVE_CUSTODY_WORKER_LIST_INVALID";
  record(value, code);
  exactKeys(value, ["total_count", "workers"], code);
  const totalCount = nonNegativeSafeInteger(value.total_count, code);
  if (!Array.isArray(value.workers) || value.workers.length !== totalCount ||
      value.workers.length < campaign.present_worker_names.length ||
      value.workers.length > MAX_WORKERS ||
      Object.keys(value.workers).length !== value.workers.length) {
    refuse(code);
  }
  const workers = value.workers.map((worker) => normalizeInitialWorker(worker, code));
  if (new Set(workers.map((worker) => worker.id)).size !== workers.length ||
      new Set(workers.map((worker) => worker.name)).size !== workers.length ||
      campaign.present_worker_names.some((name) =>
        workers.filter((worker) => worker.name === name).length !== 1) ||
      campaign.absent_worker_names.some((name) =>
        workers.some((worker) => worker.name === name))) {
    refuse(code);
  }
  workers.sort((left, right) =>
    binaryCompare(left.name, right.name) || binaryCompare(left.id, right.id));
  return Object.freeze({
    total_count: totalCount,
    workers: Object.freeze(workers),
    sha256: domainHash(WORKER_LIST_HASH_DOMAIN, { total_count: totalCount, workers }),
  });
}

function normalizeJson(value, code, state, depth = 0) {
  state.nodes++;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) refuse(code);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) refuse(code);
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_JSON_STRING_BYTES) refuse(code);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_BINDINGS || Object.keys(value).length !== value.length) {
      refuse(code);
    }
    return value.map((entry) => normalizeJson(entry, code, state, depth + 1));
  }
  record(value, code);
  const keys = Object.keys(value);
  if (keys.length > MAX_BINDINGS) refuse(code);
  return Object.fromEntries(keys.sort(binaryCompare).map((key) => [
    key,
    normalizeJson(value[key], code, state, depth + 1),
  ]));
}

function normalizeBinding(binding, campaign) {
  const code = "V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID";
  record(binding, code);
  if (!Object.hasOwn(binding, "name") || !Object.hasOwn(binding, "type")) refuse(code);
  const name = boundedText(binding.name, 256, code);
  const type = boundedText(binding.type, 64, code);
  if (!CURRENT_BINDING_TYPE_SET.has(type)) {
    refuse("V048_EXCLUSIVE_CUSTODY_BINDING_TYPE_UNKNOWN");
  }
  if (type === "inherit") {
    refuse("V048_EXCLUSIVE_CUSTODY_BINDING_INHERIT_UNRESOLVED");
  }

  let d1 = 0;
  let vectorize = 0;
  if (type === "d1") {
    allowedKeys(
      binding,
      new Set(["database_id", "id", "name", "type"]),
      ["database_id", "name", "type"],
      code,
    );
    const databaseId = uuid(binding.database_id, code);
    if (Object.hasOwn(binding, "id") && uuid(binding.id, code) !== databaseId) {
      refuse("V048_EXCLUSIVE_CUSTODY_BINDING_ID_AMBIGUOUS");
    }
    if (campaign.d1_database_ids.includes(databaseId)) {
      refuse("V048_EXCLUSIVE_CUSTODY_CAMPAIGN_RESOURCE_BOUND");
    }
    d1 = 1;
  } else if (type === "vectorize") {
    exactKeys(binding, ["index_name", "name", "type"], code);
    const indexName = safeIdentifier(binding.index_name, code);
    if (campaign.vectorize_index_names.includes(indexName)) {
      refuse("V048_EXCLUSIVE_CUSTODY_CAMPAIGN_RESOURCE_BOUND");
    }
    vectorize = 1;
  } else if (Object.hasOwn(binding, "database_id") ||
      Object.hasOwn(binding, "index_name")) {
    refuse("V048_EXCLUSIVE_CUSTODY_BINDING_ID_AMBIGUOUS");
  }

  const normalized = normalizeJson(binding, code, { nodes: 0 });
  return Object.freeze({ name, type, d1, vectorize, normalized });
}

function normalizeBindingSet(bindings, campaign, workerId, versionId) {
  const code = "V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID";
  if (!Array.isArray(bindings) || bindings.length > MAX_BINDINGS ||
      Object.keys(bindings).length !== bindings.length) {
    refuse(code);
  }
  const normalized = bindings.map((binding) => normalizeBinding(binding, campaign));
  if (new Set(normalized.map((binding) => binding.name)).size !== normalized.length) {
    refuse(code);
  }
  normalized.sort((left, right) =>
    binaryCompare(left.name, right.name) ||
    binaryCompare(left.type, right.type) ||
    binaryCompare(canonical(left.normalized), canonical(right.normalized)));
  const fullBindings = normalized.map((binding) => binding.normalized);
  const encoded = canonical(fullBindings);
  if (Buffer.byteLength(encoded) > MAX_BINDING_SET_BYTES) refuse(code);
  return Object.freeze({
    count: normalized.length,
    d1: normalized.reduce((total, binding) => total + binding.d1, 0),
    vectorize: normalized.reduce((total, binding) => total + binding.vectorize, 0),
    sha256: domainHash(BINDING_SET_HASH_DOMAIN, {
      worker_id: workerId,
      version_id: versionId,
      bindings: fullBindings,
    }),
  });
}

function normalizeLatestDeployment(deploymentList) {
  const code = "V048_EXCLUSIVE_CUSTODY_DEPLOYMENT_INVALID";
  record(deploymentList, code);
  exactKeys(deploymentList, ["deployments"], code);
  const deployments = deploymentList.deployments;
  if (!Array.isArray(deployments) || deployments.length > MAX_DEPLOYMENTS ||
      Object.keys(deployments).length !== deployments.length) {
    refuse(code);
  }
  if (deployments.length === 0) return null;

  const latest = record(deployments[0], code);
  allowedKeys(
    latest,
    DEPLOYMENT_ALLOWED_KEYS,
    ["created_on", "id", "strategy", "versions"],
    code,
  );
  if (latest.strategy !== "percentage" || !Array.isArray(latest.versions) ||
      latest.versions.length < 1 || latest.versions.length > 2 ||
      Object.keys(latest.versions).length !== latest.versions.length) {
    refuse(code);
  }
  const normalizedVersions = latest.versions.map((version) => {
    record(version, code);
    exactKeys(version, ["percentage", "version_id"], code);
    if (typeof version.percentage !== "number" || !Number.isFinite(version.percentage) ||
        version.percentage < 0.01 || version.percentage > 100) {
      refuse(code);
    }
    return Object.freeze({
      percentage: version.percentage,
      version_id: uuid(version.version_id, code),
    });
  });
  const total = normalizedVersions.reduce((sum, version) => sum + version.percentage, 0);
  if (new Set(normalizedVersions.map((version) => version.version_id)).size !==
        normalizedVersions.length || Math.abs(total - 100) > 1e-9) {
    refuse(code);
  }
  normalizedVersions.sort((left, right) => binaryCompare(left.version_id, right.version_id));
  return Object.freeze({
    created_on: isoTimestamp(latest.created_on, code),
    id: uuid(latest.id, code),
    versions: Object.freeze(normalizedVersions),
  });
}

function normalizeVersionDetail(version, campaign, workerId, expectedVersionId) {
  const code = "V048_EXCLUSIVE_CUSTODY_VERSION_INVALID";
  record(version, code);
  allowedKeys(version, VERSION_ALLOWED_KEYS, ["id", "resources"], code);
  const versionId = uuid(version.id, code);
  if (versionId !== expectedVersionId) {
    refuse("V048_EXCLUSIVE_CUSTODY_TRAFFIC_VERSION_COVERAGE_INVALID");
  }
  const resources = record(version.resources, code);
  allowedKeys(resources, VERSION_RESOURCE_ALLOWED_KEYS, [], code);
  if (!Object.hasOwn(resources, "bindings")) {
    refuse("V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID");
  }
  const bindings = normalizeBindingSet(
    resources.bindings,
    campaign,
    workerId,
    versionId,
  );
  return Object.freeze({
    version_id: versionId,
    binding_count: bindings.count,
    d1_bindings: bindings.d1,
    vectorize_bindings: bindings.vectorize,
    bindings_sha256: bindings.sha256,
  });
}

function normalizeWorkerEvidence(evidence, expectedWorker, campaign) {
  const coverageCode = "V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID";
  record(evidence, coverageCode);
  exactKeys(
    evidence,
    ["deploymentList", "trafficVersions", "workerId", "workerName"],
    coverageCode,
  );
  const workerId = safeIdentifier(evidence.workerId, coverageCode);
  const workerName = safeIdentifier(evidence.workerName, coverageCode);
  if (workerId !== expectedWorker.id || workerName !== expectedWorker.name) {
    refuse(coverageCode);
  }
  const latest = normalizeLatestDeployment(evidence.deploymentList);
  if (!Array.isArray(evidence.trafficVersions) ||
      evidence.trafficVersions.length > 2 ||
      Object.keys(evidence.trafficVersions).length !== evidence.trafficVersions.length) {
    refuse("V048_EXCLUSIVE_CUSTODY_TRAFFIC_VERSION_COVERAGE_INVALID");
  }
  if (latest === null) {
    if (expectedWorker.deployed_on !== null) {
      refuse("V048_EXCLUSIVE_CUSTODY_DEPLOYED_STATE_INVALID");
    }
    if (evidence.trafficVersions.length !== 0) {
      refuse("V048_EXCLUSIVE_CUSTODY_TRAFFIC_VERSION_COVERAGE_INVALID");
    }
    return Object.freeze({
      worker_id: workerId,
      worker_name: workerName,
      deployed: false,
      latest_deployment_id: null,
      traffic_versions: Object.freeze([]),
    });
  }

  if (expectedWorker.deployed_on === null ||
      latest.created_on !== expectedWorker.deployed_on) {
    refuse("V048_EXCLUSIVE_CUSTODY_DEPLOYED_STATE_INVALID");
  }

  const expectedIds = latest.versions.map((version) => version.version_id);
  const suppliedIds = evidence.trafficVersions.map((version) =>
    uuid(version?.id, "V048_EXCLUSIVE_CUSTODY_VERSION_INVALID"));
  if (evidence.trafficVersions.length !== expectedIds.length ||
      new Set(suppliedIds).size !== suppliedIds.length ||
      canonical([...suppliedIds].sort(binaryCompare)) !== canonical(expectedIds)) {
    refuse("V048_EXCLUSIVE_CUSTODY_TRAFFIC_VERSION_COVERAGE_INVALID");
  }
  const detailById = new Map(evidence.trafficVersions.map((version) => [version.id.toLowerCase(), version]));
  const trafficVersions = latest.versions.map((traffic) => Object.freeze({
    percentage: traffic.percentage,
    ...normalizeVersionDetail(
      detailById.get(traffic.version_id),
      campaign,
      workerId,
      traffic.version_id,
    ),
  }));
  return Object.freeze({
    worker_id: workerId,
    worker_name: workerName,
    deployed: true,
    latest_deployment_id: latest.id,
    traffic_versions: Object.freeze(trafficVersions),
  });
}

/**
 * Verify complete account-wide non-campaign Worker coverage and return a
 * privacy-safe aggregate receipt. All Worker/resource names and provider IDs
 * remain inside domain-separated hashes.
 */
function normalizeCustodyInput(input) {
  const inputCode = "V048_EXCLUSIVE_CUSTODY_INPUT_INVALID";
  record(input, inputCode);
  exactKeys(
    input,
    ["campaignResources", "initialWorkerList", "nonCampaignWorkers"],
    inputCode,
  );
  const { campaignResources, initialWorkerList, nonCampaignWorkers } = input;
  const campaign = normalizeCampaignResources(campaignResources);
  const initial = normalizeInitialWorkerList(initialWorkerList, campaign);
  if (!Array.isArray(nonCampaignWorkers) ||
      nonCampaignWorkers.length > MAX_WORKERS ||
      Object.keys(nonCampaignWorkers).length !== nonCampaignWorkers.length) {
    refuse(inputCode);
  }

  const reviewedCampaignNames = new Set(campaign.worker_names);
  const presentCampaignNames = new Set(campaign.present_worker_names);
  const expectedWorkers = initial.workers.filter(
    (worker) => !presentCampaignNames.has(worker.name),
  );
  if (nonCampaignWorkers.length !== expectedWorkers.length) {
    refuse("V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID");
  }
  const evidenceByName = new Map();
  for (const evidence of nonCampaignWorkers) {
    const name = safeIdentifier(
      evidence?.workerName,
      "V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID",
    );
    if (reviewedCampaignNames.has(name) || evidenceByName.has(name)) {
      refuse("V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID");
    }
    evidenceByName.set(name, evidence);
  }
  const normalizedWorkers = expectedWorkers.map((worker) => {
    const evidence = evidenceByName.get(worker.name);
    if (!evidence) refuse("V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID");
    return normalizeWorkerEvidence(evidence, worker, campaign);
  });

  return Object.freeze({ campaign, initial, normalizedWorkers });
}

function custodyReceiptFromNormalized(campaign, initial, normalizedWorkers) {
  const allTrafficVersions = normalizedWorkers.flatMap((worker) => worker.traffic_versions);
  const campaignSha256 = domainHash(CAMPAIGN_HASH_DOMAIN, campaign);
  const normalizedProof = Object.freeze({
    schema_version: V048_EXCLUSIVE_RESOURCE_CUSTODY_SCHEMA_VERSION,
    kind: V048_EXCLUSIVE_RESOURCE_CUSTODY_KIND,
    campaign_sha256: campaignSha256,
    initial_worker_list_sha256: initial.sha256,
    workers: Object.freeze(normalizedWorkers),
  });
  return Object.freeze({
    schema_version: V048_EXCLUSIVE_RESOURCE_CUSTODY_SCHEMA_VERSION,
    kind: V048_EXCLUSIVE_RESOURCE_CUSTODY_KIND,
    account_workers: initial.total_count,
    campaign_workers_reviewed: campaign.worker_names.length,
    campaign_workers_present: campaign.present_worker_names.length,
    campaign_workers_absent: campaign.absent_worker_names.length,
    non_campaign_workers: normalizedWorkers.length,
    deployed_non_campaign_workers:
      normalizedWorkers.filter((worker) => worker.deployed).length,
    traffic_versions_inspected: allTrafficVersions.length,
    bindings_inspected: allTrafficVersions.reduce(
      (total, version) => total + version.binding_count,
      0,
    ),
    d1_bindings_inspected: allTrafficVersions.reduce(
      (total, version) => total + version.d1_bindings,
      0,
    ),
    vectorize_bindings_inspected: allTrafficVersions.reduce(
      (total, version) => total + version.vectorize_bindings,
      0,
    ),
    campaign_d1_bindings: 0,
    campaign_vectorize_bindings: 0,
    initial_worker_list_sha256: initial.sha256,
    custody_sha256: domainHash(CUSTODY_HASH_DOMAIN, normalizedProof),
  });
}

function custodyAuthority(campaign, initial, normalizedWorkers) {
  return Object.freeze({
    schema_version: V048_EXCLUSIVE_RESOURCE_CUSTODY_SCHEMA_VERSION,
    kind: V048_EXCLUSIVE_RESOURCE_CUSTODY_AUTHORITY_KIND,
    campaign,
    initial_worker_list: Object.freeze({
      total_count: initial.total_count,
      workers: initial.workers,
    }),
    non_campaign_workers: Object.freeze(normalizedWorkers),
  });
}

function normalizeAuthorityTrafficVersion(value, code) {
  record(value, code);
  exactKeys(value, [
    "binding_count", "bindings_sha256", "d1_bindings", "percentage",
    "vectorize_bindings", "version_id",
  ], code);
  const bindingCount = nonNegativeSafeInteger(value.binding_count, code);
  const d1Bindings = nonNegativeSafeInteger(value.d1_bindings, code);
  const vectorizeBindings = nonNegativeSafeInteger(value.vectorize_bindings, code);
  if (typeof value.percentage !== "number" || !Number.isFinite(value.percentage) ||
      value.percentage < 0.01 || value.percentage > 100 ||
      d1Bindings > bindingCount || vectorizeBindings > bindingCount ||
      typeof value.bindings_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.bindings_sha256)) {
    refuse(code);
  }
  return Object.freeze({
    percentage: value.percentage,
    version_id: uuid(value.version_id, code),
    binding_count: bindingCount,
    d1_bindings: d1Bindings,
    vectorize_bindings: vectorizeBindings,
    bindings_sha256: value.bindings_sha256,
  });
}

function normalizeAuthorityWorker(value, expected, code) {
  record(value, code);
  exactKeys(value, [
    "deployed", "latest_deployment_id", "traffic_versions", "worker_id",
    "worker_name",
  ], code);
  const workerId = safeIdentifier(value.worker_id, code);
  const workerName = safeIdentifier(value.worker_name, code);
  if (workerId !== expected.id || workerName !== expected.name ||
      typeof value.deployed !== "boolean" || !Array.isArray(value.traffic_versions) ||
      value.traffic_versions.length > 2 ||
      Object.keys(value.traffic_versions).length !== value.traffic_versions.length) {
    refuse(code);
  }
  const trafficVersions = value.traffic_versions.map((version) =>
    normalizeAuthorityTrafficVersion(version, code));
  if (new Set(trafficVersions.map((version) => version.version_id)).size !==
        trafficVersions.length) {
    refuse(code);
  }
  const latestDeploymentId = value.latest_deployment_id === null
    ? null
    : uuid(value.latest_deployment_id, code);
  if (value.deployed) {
    if (expected.deployed_on === null || latestDeploymentId === null ||
        trafficVersions.length < 1 ||
        Math.abs(trafficVersions.reduce((sum, version) =>
          sum + version.percentage, 0) - 100) > 1e-9) {
      refuse(code);
    }
  } else if (expected.deployed_on !== null || latestDeploymentId !== null ||
      trafficVersions.length !== 0) {
    refuse(code);
  }
  return Object.freeze({
    worker_id: workerId,
    worker_name: workerName,
    deployed: value.deployed,
    latest_deployment_id: latestDeploymentId,
    traffic_versions: Object.freeze(trafficVersions),
  });
}

/**
 * Revalidate the privacy-safe canonical preimage persisted by the field proof.
 * Raw binding values never enter this authority. Their provider-derived,
 * domain-separated binding-set hashes remain leaf commitments while every
 * enclosing custody/census hash and count is recomputed here.
 */
export function assertV048ExclusiveCampaignResourceCustodyAuthority(value) {
  const code = "V048_EXCLUSIVE_CUSTODY_AUTHORITY_INVALID";
  record(value, code);
  exactKeys(value, [
    "campaign", "initial_worker_list", "kind", "non_campaign_workers",
    "schema_version",
  ], code);
  if (value.schema_version !== V048_EXCLUSIVE_RESOURCE_CUSTODY_SCHEMA_VERSION ||
      value.kind !== V048_EXCLUSIVE_RESOURCE_CUSTODY_AUTHORITY_KIND) {
    refuse(code);
  }
  const suppliedCampaign = record(value.campaign, code);
  const campaign = normalizeCampaignResources({
    teardownRole: suppliedCampaign.teardown_role,
    source: {
      workerName: suppliedCampaign.source?.worker_name,
      workerState: suppliedCampaign.source?.worker_state,
      d1DatabaseId: suppliedCampaign.source?.d1_database_id,
      vectorizeIndexName: suppliedCampaign.source?.vectorize_index_name,
    },
    target: {
      workerName: suppliedCampaign.target?.worker_name,
      workerState: suppliedCampaign.target?.worker_state,
      d1DatabaseId: suppliedCampaign.target?.d1_database_id,
      vectorizeIndexName: suppliedCampaign.target?.vectorize_index_name,
    },
  });
  if (canonical(campaign) !== canonical(suppliedCampaign)) refuse(code);
  const suppliedInitial = record(value.initial_worker_list, code);
  exactKeys(suppliedInitial, ["total_count", "workers"], code);
  const initial = normalizeInitialWorkerList(suppliedInitial, campaign);
  if (canonical({ total_count: initial.total_count, workers: initial.workers }) !==
      canonical(suppliedInitial)) {
    refuse(code);
  }
  if (!Array.isArray(value.non_campaign_workers) ||
      Object.keys(value.non_campaign_workers).length !==
        value.non_campaign_workers.length) {
    refuse(code);
  }
  const presentCampaignNames = new Set(campaign.present_worker_names);
  const expectedWorkers = initial.workers.filter((worker) =>
    !presentCampaignNames.has(worker.name));
  if (value.non_campaign_workers.length !== expectedWorkers.length) refuse(code);
  const suppliedByName = new Map();
  for (const worker of value.non_campaign_workers) {
    const name = safeIdentifier(worker?.worker_name, code);
    if (campaign.worker_names.includes(name) || suppliedByName.has(name)) refuse(code);
    suppliedByName.set(name, worker);
  }
  const normalizedWorkers = expectedWorkers.map((expected) => {
    const supplied = suppliedByName.get(expected.name);
    if (!supplied) refuse(code);
    return normalizeAuthorityWorker(supplied, expected, code);
  });
  const authority = custodyAuthority(campaign, initial, normalizedWorkers);
  if (canonical(authority) !== canonical(value)) refuse(code);
  return Object.freeze({
    authority,
    receipt: custodyReceiptFromNormalized(campaign, initial, normalizedWorkers),
  });
}

/** Return both the aggregate receipt and its credential-free canonical preimage. */
export function verifyV048ExclusiveCampaignResourceCustodyWithAuthority(input = {}) {
  if (arguments.length !== 1) refuse("V048_EXCLUSIVE_CUSTODY_INPUT_INVALID");
  const { campaign, initial, normalizedWorkers } = normalizeCustodyInput(input);
  return Object.freeze({
    authority: custodyAuthority(campaign, initial, normalizedWorkers),
    receipt: custodyReceiptFromNormalized(campaign, initial, normalizedWorkers),
  });
}

export function verifyV048ExclusiveCampaignResourceCustody(input = {}) {
  if (arguments.length !== 1) refuse("V048_EXCLUSIVE_CUSTODY_INPUT_INVALID");
  return verifyV048ExclusiveCampaignResourceCustodyWithAuthority(input).receipt;
}
