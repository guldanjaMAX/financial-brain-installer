/**
 * Pure, offline contract for the inbound-reference projection returned by
 * Cloudflare's Workers Beta `Get Worker` endpoint.
 *
 * Callers pass the response `result`, not the Cloudflare response envelope.
 * Mutable Worker metadata is accepted only under the currently documented
 * top-level keys and is deliberately excluded from this reference proof.
 */

import { createHash } from "node:crypto";

export const V048_WORKER_REFERENCE_SCHEMA_VERSION = 1;
export const V048_WORKER_REFERENCE_SNAPSHOT_KIND =
  "v048_worker_reference_snapshot_v1";
export const V048_WORKER_REFERENCE_MAX_ID_LENGTH = 128;
export const V048_WORKER_REFERENCE_KEYS = Object.freeze([
  "dispatch_namespace_outbounds",
  "domains",
  "durable_objects",
  "queues",
  "workers",
]);

const HASH_DOMAIN =
  "financial-brain:v0.4.8:worker-reference-snapshot:v1";
const SUBDOMAIN_HASH_DOMAIN =
  "financial-brain:v0.4.8:worker-reference-subdomain-metadata:v1";
const WORKER_NAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IMMUTABLE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const RESULT_ALLOWED_KEYS = new Set([
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
const SUBDOMAIN_ALLOWED_KEYS = new Set([
  "enabled",
  "preview_url_suffix",
  "previews_enabled",
  "url",
]);

export class V048WorkerReferenceContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048WorkerReferenceContractError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048WorkerReferenceContractError(code);
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

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
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

function exactOwnKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) refuse(code);
}

function allowedOwnKeys(value, allowed, required, code) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    refuse(code);
  }
}

function exactEmptyArray(value, code) {
  if (!Array.isArray(value) || value.length !== 0 ||
      Object.keys(value).length !== 0 ||
      Reflect.ownKeys(value).some((key) => key !== "length")) {
    refuse(code);
  }
}

function workerName(value, code) {
  if (typeof value !== "string" || !WORKER_NAME_RE.test(value)) refuse(code);
  return value;
}

function immutableWorkerId(value, code) {
  if (typeof value !== "string" ||
      value.length > V048_WORKER_REFERENCE_MAX_ID_LENGTH ||
      !IMMUTABLE_ID_RE.test(value)) {
    refuse(code);
  }
  return value;
}

function boundedText(value, maximum, code) {
  if (typeof value !== "string" || !value || value.length > maximum ||
      value.trim() !== value || CONTROL_RE.test(value)) {
    refuse(code);
  }
  return value;
}

function dnsName(value, code) {
  if (value.length > 253 || value.endsWith(".") ||
      value.split(".").some((label) => !DNS_LABEL_RE.test(label))) {
    refuse(code);
  }
  return value;
}

function expectedWorkersDevDomain(value, expectedWorkerName, code) {
  const domain = boundedText(value, 253, code);
  dnsName(domain, code);
  if (!domain.startsWith(`${expectedWorkerName}.`) ||
      !domain.endsWith(".workers.dev") ||
      domain === `${expectedWorkerName}.workers.dev`) {
    refuse(code);
  }
  return domain;
}

function normalizeSubdomain(subdomain, expectedWorkerName, expectedDomain) {
  const code = "V048_WORKER_REFERENCE_SUBDOMAIN_INVALID";
  record(subdomain, code);
  allowedOwnKeys(
    subdomain,
    SUBDOMAIN_ALLOWED_KEYS,
    ["enabled", "preview_url_suffix", "previews_enabled", "url"],
    code,
  );
  if (subdomain.enabled !== true) {
    refuse("V048_WORKER_REFERENCE_SUBDOMAIN_DISABLED");
  }
  if (subdomain.previews_enabled !== false) {
    refuse("V048_WORKER_REFERENCE_PREVIEWS_ENABLED");
  }

  const url = boundedText(subdomain.url, 2048, code);
  const suffix = boundedText(subdomain.preview_url_suffix, 253, code);
  const urlPrefix = "https://";
  if (!url.startsWith(urlPrefix) || url.includes("/", urlPrefix.length)) refuse(code);
  const hostname = dnsName(url.slice(urlPrefix.length), code);
  if (hostname !== expectedDomain || suffix !== `-${expectedDomain}`) {
    refuse(code);
  }

  return Object.freeze({
    enabled: true,
    previews_enabled: false,
    metadata_present: true,
    metadata_sha256: domainHash(SUBDOMAIN_HASH_DOMAIN, { url, suffix }),
  });
}

/**
 * Normalize and fingerprint the reference-bearing portion of one Cloudflare
 * Workers Beta `Get Worker` result. The receipt excludes Worker names and raw
 * workers.dev host metadata; both remain bound inside `snapshot_sha256`.
 */
export function normalizeV048WorkerReferenceSnapshot(
  result,
  { expectedWorkerName, expectedWorkerId, expectedDomain } = {},
) {
  const resultCode = "V048_WORKER_REFERENCE_RESULT_INVALID";
  record(result, resultCode);
  allowedOwnKeys(
    result,
    RESULT_ALLOWED_KEYS,
    ["id", "name", "references", "subdomain", "tail_consumers"],
    resultCode,
  );

  const expectedName = workerName(
    expectedWorkerName,
    "V048_WORKER_REFERENCE_ARGUMENT_INVALID",
  );
  const domain = expectedWorkersDevDomain(
    expectedDomain,
    expectedName,
    "V048_WORKER_REFERENCE_ARGUMENT_INVALID",
  );
  if (result.name !== expectedName) {
    refuse("V048_WORKER_REFERENCE_NAME_MISMATCH");
  }
  const id = immutableWorkerId(
    result.id,
    "V048_WORKER_REFERENCE_ID_INVALID",
  );
  if (expectedWorkerId !== undefined) {
    const expectedId = immutableWorkerId(
      expectedWorkerId,
      "V048_WORKER_REFERENCE_ARGUMENT_INVALID",
    );
    if (id !== expectedId) refuse("V048_WORKER_REFERENCE_ID_MISMATCH");
  }

  const references = record(
    result.references,
    "V048_WORKER_REFERENCES_INVALID",
  );
  exactOwnKeys(
    references,
    V048_WORKER_REFERENCE_KEYS,
    "V048_WORKER_REFERENCES_INVALID",
  );
  for (const key of V048_WORKER_REFERENCE_KEYS) {
    exactEmptyArray(references[key], "V048_WORKER_REFERENCE_PRESENT");
  }
  exactEmptyArray(
    result.tail_consumers,
    "V048_WORKER_TAIL_CONSUMER_PRESENT",
  );
  const normalizedSubdomain = normalizeSubdomain(
    result.subdomain,
    expectedName,
    domain,
  );
  const referenceCounts = Object.freeze(Object.fromEntries(
    V048_WORKER_REFERENCE_KEYS.map((key) => [key, 0]),
  ));
  const normalized = Object.freeze({
    schema_version: V048_WORKER_REFERENCE_SCHEMA_VERSION,
    kind: V048_WORKER_REFERENCE_SNAPSHOT_KIND,
    worker_id: id,
    reference_counts: referenceCounts,
    tail_consumers: 0,
    subdomain_enabled: true,
    previews_enabled: false,
    subdomain_metadata_present: normalizedSubdomain.metadata_present,
  });
  const snapshotSha256 = domainHash(HASH_DOMAIN, {
    ...normalized,
    worker_name: expectedName,
    expected_domain_sha256: domainHash(SUBDOMAIN_HASH_DOMAIN, domain),
    subdomain_metadata_sha256: normalizedSubdomain.metadata_sha256,
  });

  return Object.freeze({
    ...normalized,
    snapshot_sha256: snapshotSha256,
  });
}

export function fingerprintV048WorkerReferenceSnapshot(result, options) {
  return normalizeV048WorkerReferenceSnapshot(result, options).snapshot_sha256;
}
