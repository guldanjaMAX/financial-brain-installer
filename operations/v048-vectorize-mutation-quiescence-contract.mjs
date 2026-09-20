/**
 * Pure approval contract for the v0.4.8 disposable target Vectorize index.
 *
 * The operator approval commits to one exact private manifest pair, the exact
 * target resource identity used by verified recovery, and a fixed continuous
 * no-competing-writer interval. Only privacy-safe SHA-256 values leave this
 * module.
 */

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME,
  V048_DISPOSABLE_CAMPAIGN_TARGET_NAME,
  V048_DISPOSABLE_CAMPAIGN_VERSION,
} from "./v048-disposable-campaign-contract.mjs";

export const V048_VECTORIZE_MUTATION_QUIESCENCE_SCHEMA_VERSION = 1;
export const V048_VECTORIZE_MUTATION_QUIESCENCE_KIND =
  "v048_vectorize_mutation_quiescence_v1";
export const V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE = Object.freeze({
  continuous: true,
  interval_start:
    "exact_disposable_target_vectorize_index_creation_or_provisioning",
  interval_end: "recovery_final_active_composite_proof_accepted",
  includes_pending_before_first_provider_observation: true,
  mutation_surfaces: Object.freeze([
    "cloudflare_dashboard",
    "cloudflare_rest_api",
    "wrangler_cli",
    "cloudflare_api_tokens",
    "all_non_campaign_writers",
  ]),
});

const SHA256_RE = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const D1_DATABASE_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const APPROVAL_HASH_DOMAIN =
  "financial-brain:v0.4.8:vectorize-mutation-quiescence:approval:v1";
const CAMPAIGN_HASH_DOMAIN =
  "financial-brain:v0.4.8:vectorize-mutation-quiescence:campaign:v1";
const SCOPE_HASH_DOMAIN =
  "financial-brain:v0.4.8:vectorize-mutation-quiescence:scope:v1";
const TARGET_IDENTITY_KEYS = Object.freeze([
  "accountId",
  "databaseId",
  "databaseName",
  "vectorizeIndex",
  "workerName",
  "domain",
]);

export class V048VectorizeMutationQuiescenceContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048VectorizeMutationQuiescenceContractError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048VectorizeMutationQuiescenceContractError(code);
}

function record(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    refuse(code);
  }
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
  record(value, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function hash(value, code) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) refuse(code);
  return value;
}

function normalizedTargetIdentity(target) {
  const code = "V048_VECTORIZE_MUTATION_QUIESCENCE_TARGET_INVALID";
  exactKeys(target, TARGET_IDENTITY_KEYS, code);
  if (!ACCOUNT_ID_RE.test(target.accountId) ||
      !D1_DATABASE_ID_RE.test(target.databaseId) ||
      target.databaseName !== V048_DISPOSABLE_CAMPAIGN_TARGET_NAME ||
      target.vectorizeIndex !== V048_DISPOSABLE_CAMPAIGN_TARGET_NAME ||
      target.workerName !== V048_DISPOSABLE_CAMPAIGN_TARGET_NAME) {
    refuse(code);
  }
  const labels = typeof target.domain === "string"
    ? target.domain.toLowerCase().split(".")
    : [];
  if (target.domain !== target.domain?.toLowerCase() || labels.length < 4 ||
      labels[0] !== V048_DISPOSABLE_CAMPAIGN_TARGET_NAME ||
      labels.slice(-2).join(".") !== "workers.dev" ||
      labels.slice(1, -2).some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    refuse(code);
  }
  return Object.freeze({
    accountId: target.accountId,
    databaseId: target.databaseId,
    databaseName: target.databaseName,
    vectorizeIndex: target.vectorizeIndex,
    workerName: target.workerName,
    domain: target.domain,
  });
}

/** Return the exact target resource hash used by verified recovery. */
export function v048TargetResourceFingerprint(target) {
  return sha256(canonical(normalizedTargetIdentity(target)));
}

function normalizedApprovalBinding(input) {
  const code = "V048_VECTORIZE_MUTATION_QUIESCENCE_INPUT_INVALID";
  exactKeys(input, [
    "sourceManifestSha256",
    "targetManifestSha256",
    "targetResourceFingerprint",
  ], code);
  return Object.freeze({
    source_manifest_sha256: hash(input.sourceManifestSha256, code),
    target_manifest_sha256: hash(input.targetManifestSha256, code),
    target_resource_fingerprint: hash(input.targetResourceFingerprint, code),
  });
}

function deriveAttestation(input) {
  const binding = normalizedApprovalBinding(input);
  const scopeSha256 = domainHash(
    SCOPE_HASH_DOMAIN,
    V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE,
  );
  const campaignIdentitySha256 = domainHash(CAMPAIGN_HASH_DOMAIN, {
    release: V048_DISPOSABLE_CAMPAIGN_VERSION,
    source_worker_name: V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME,
    target_worker_name: V048_DISPOSABLE_CAMPAIGN_TARGET_NAME,
    ...binding,
  });
  const approvalFingerprint = domainHash(APPROVAL_HASH_DOMAIN, {
    schema_version: V048_VECTORIZE_MUTATION_QUIESCENCE_SCHEMA_VERSION,
    kind: V048_VECTORIZE_MUTATION_QUIESCENCE_KIND,
    campaign_identity_sha256: campaignIdentitySha256,
    target_resource_fingerprint: binding.target_resource_fingerprint,
    scope_sha256: scopeSha256,
  });
  return Object.freeze({
    schema_version: V048_VECTORIZE_MUTATION_QUIESCENCE_SCHEMA_VERSION,
    kind: V048_VECTORIZE_MUTATION_QUIESCENCE_KIND,
    approval_fingerprint: approvalFingerprint,
    campaign_identity_sha256: campaignIdentitySha256,
    target_resource_fingerprint: binding.target_resource_fingerprint,
    scope_sha256: scopeSha256,
    continuous: V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE.continuous,
    interval_start: V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE.interval_start,
    interval_end: V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE.interval_end,
    includes_pending_before_first_provider_observation:
      V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE
        .includes_pending_before_first_provider_observation,
    mutation_surfaces_attested:
      V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE.mutation_surfaces.length,
  });
}

/** Derive the one approval fingerprint the operator must enter. */
export function v048VectorizeMutationQuiescenceApprovalFingerprint(input) {
  return deriveAttestation(input).approval_fingerprint;
}

/** Compare an operator-entered fingerprint and return aggregate-only proof. */
export function assertV048VectorizeMutationQuiescenceApproval(input) {
  const code = "V048_VECTORIZE_MUTATION_QUIESCENCE_APPROVAL_INVALID";
  exactKeys(input, [
    "sourceManifestSha256",
    "targetManifestSha256",
    "targetResourceFingerprint",
    "approvalFingerprint",
  ], code);
  const approvalFingerprint = hash(input.approvalFingerprint, code);
  const attestation = deriveAttestation({
    sourceManifestSha256: input.sourceManifestSha256,
    targetManifestSha256: input.targetManifestSha256,
    targetResourceFingerprint: input.targetResourceFingerprint,
  });
  if (approvalFingerprint !== attestation.approval_fingerprint) {
    refuse("V048_VECTORIZE_MUTATION_QUIESCENCE_APPROVAL_MISMATCH");
  }
  return attestation;
}
