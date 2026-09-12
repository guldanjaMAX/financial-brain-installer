/**
 * IO orchestration for one exact, owner-approved local provenance repair.
 *
 * The pure approval contract lives in provenance-target-repair.mjs. This file
 * supplies the intentionally narrow bridge to local IO and authenticated
 * Worker calls. Every IO boundary is injected so the complete order, lease
 * fencing and privacy contract can be proved without a real Brain.
 */

import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";

import { splitOversized } from "../ingest/envelope-batching.mjs";
import { collectPrivateLocalProvenanceAssessment } from "./provenance-source-assessment.mjs";
import {
  PROVENANCE_TARGET_REPAIR_AUTHENTICATED_CHECK_ORDER,
  assertPrivateProvenanceTargetRepairApproval,
  authorizePrivateProvenanceTargetRepair,
  bindPrivateProvenanceTargetRepairSeal,
  canonicalProvenanceTargetLocator,
  formatPrivateProvenanceAcceptedResolutionRequest,
  formatPrivateProvenanceResultFamilyRequest,
  formatPrivateProvenanceTargetDiscoveryRequest,
  formatPrivateProvenanceTargetSealRequest,
  preparePrivateProvenanceTargetRepair,
  publicProvenanceTargetRepairPlan,
  renderProvenanceTargetRepairPlan,
  selectPrivateProvenanceTargetDiscoveryReceipt,
  validatePrivateProvenanceAcceptedResolutionResponse,
  validatePrivateProvenanceResultFamilyResponse,
} from "./provenance-target-repair.mjs";
import { ingestEnvelopeValidationError } from "../worker/src/lib/ingest-envelope.js";
import { normalizeSourceOriginalReceipt } from "../worker/src/lib/source-original-binding.js";
import { sanitizeEnvelope, scanEnvelope } from "../worker/src/lib/secret-scan.js";
import { restampFirstPartySourceProvenance } from "../worker/src/lib/provenance-receipt.js";

export const PROVENANCE_TARGET_CLI_SCHEMA_VERSION = 1;
export const PROVENANCE_TARGET_REQUIRED_SCHEMA = 46;

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SHA_ID_RE = /^sha256:[a-f0-9]{64}$/;
const ORIGINAL_ID_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const RUN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_QUERY_BYTES = 768;
const MAX_DOCUMENTS = 256;
const encoder = new TextEncoder();

const APPLY_STAGES = Object.freeze([
  "discovery_recorded",
  "exact_original_ingested",
  "exact_family_reconciled",
  "vector_outbox_drained",
  "result_family_recorded",
  "result_family_verified",
  "accepted_resolution_recorded",
  "accepted_resolution_verified",
]);

const EXECUTOR_CALLBACKS = Object.freeze([
  "recordDiscovery",
  "ingestPrepared",
  "reconcileFamily",
  "drainVectorOutbox",
  "recordResultFamily",
  "verifyResultFamily",
  "recordAcceptedResolution",
  "verifyAcceptedResolution",
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function sha256Canonical(value) {
  return sha256(canonical(value));
}

function exactJson(left, right) {
  return canonical(left) === canonical(right);
}

function requiredCallback(dependencies, name) {
  const callback = dependencies?.[name];
  if (typeof callback !== "function") {
    throw new TypeError(`provenance target repair requires injected ${name}`);
  }
  return callback;
}

function assertExecutorAvailable(dependencies) {
  for (const name of EXECUTOR_CALLBACKS) requiredCallback(dependencies, name);
}

function validateCandidateRuntime(value, invocation) {
  if (!plainObject(value) || value.verified !== true ||
      value.product_version !== invocation.productVersion ||
      value.package_fingerprint !== invocation.candidateRuntimePackageFingerprint) {
    throw new TypeError("candidate runtime does not match the exact package and product version");
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !value || (!isAbsolute(value) && !win32.isAbsolute(value))) {
    throw new TypeError(`${label} must be one absolute path`);
  }
  return value;
}

const MAX_UNSIGNED_64 = 18_446_744_073_709_551_615n;

function exactFilesystemInteger(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_UNSIGNED_64) {
      throw new TypeError(`${label} is unavailable`);
    }
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(10);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is unavailable`);
  }
  return value;
}

async function directIdentity(path, expectedType, dependencies, assertOwned = async () => {}) {
  const lstat = requiredCallback(dependencies, "lstat");
  const realpath = requiredCallback(dependencies, "realpath");
  await assertOwned();
  const first = await lstat(path);
  const typeMatches = expectedType === "file"
    ? first?.isFile?.() === true
    : first?.isDirectory?.() === true;
  if (!typeMatches || first?.isSymbolicLink?.() === true) {
    throw new TypeError(`${expectedType === "file" ? "manifest" : "source root"} must be one direct ${expectedType}`);
  }
  await assertOwned();
  const resolved = absolutePath(await realpath(path), `resolved ${expectedType}`);
  await assertOwned();
  const second = await lstat(resolved);
  await assertOwned();
  const secondMatches = expectedType === "file"
    ? second?.isFile?.() === true
    : second?.isDirectory?.() === true;
  const firstDevice = exactFilesystemInteger(first?.dev, `${expectedType} device`);
  const firstInode = exactFilesystemInteger(first?.ino, `${expectedType} inode`);
  const secondDevice = exactFilesystemInteger(second?.dev, `resolved ${expectedType} device`);
  const secondInode = exactFilesystemInteger(second?.ino, `resolved ${expectedType} inode`);
  if (!secondMatches || second?.isSymbolicLink?.() === true ||
      firstDevice !== secondDevice || firstInode !== secondInode) {
    throw new TypeError(`${expectedType} identity changed during realpath validation`);
  }
  return Object.freeze({ path, realpath: resolved, device: firstDevice, inode: firstInode });
}

function sameIdentity(left, right) {
  return left.path === right.path && left.realpath === right.realpath &&
    left.device === right.device && left.inode === right.inode;
}

function normalizedInvocation(input, { requireApproval = false } = {}) {
  if (!plainObject(input)) throw new TypeError("provenance target repair needs one invocation");
  const manifestPath = absolutePath(input.manifestPath, "manifest path");
  const source = input.source;
  if (typeof source !== "string" || !SOURCE_RE.test(source)) {
    throw new TypeError("source must be one canonical manifest source id");
  }
  const target = canonicalProvenanceTargetLocator(input.target);
  const productVersion = String(input.productVersion || "");
  if (!productVersion || productVersion !== productVersion.trim()) {
    throw new TypeError("product version must be one exact nonempty value");
  }
  const candidateRuntimePackageFingerprint = String(input.candidateRuntimePackageFingerprint || "");
  if (!SHA_RE.test(candidateRuntimePackageFingerprint)) {
    throw new TypeError("candidate runtime package fingerprint must be one SHA-256 value");
  }
  const approvalId = input.approvalId ?? null;
  if (requireApproval && !SHA_RE.test(String(approvalId || ""))) {
    throw new TypeError("apply requires the exact 64-character approval id from preview");
  }
  return Object.freeze({
    manifestPath,
    source,
    target,
    productVersion,
    candidateRuntimePackageFingerprint,
    approvalId,
  });
}

function safeOptionName(value) {
  const name = String(value || "").split("=", 1)[0];
  return /^[a-z0-9-]{1,64}$/.test(name) ? name : "unknown";
}

/** Strict target-lane argv parser. It never accepts ignored positionals or duplicate flags. */
export function parseProvenanceTargetRepairArgv(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError("provenance target repair arguments must be a list");
  if (!argv.length || String(argv[0]).startsWith("--")) {
    throw new TypeError("provenance target repair needs exactly one manifest path first");
  }
  const manifest = String(argv[0]);
  const allowed = new Set(["source", "target", "apply", "approve", "json"]);
  const values = new Set(["source", "target", "approve"]);
  const parsed = { manifest, source: null, target: null, apply: false, approve: null, json: false };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--") || token === "--") {
      throw new TypeError("unexpected positional argument in provenance target repair");
    }
    const key = token.slice(2);
    if (key.includes("=")) {
      throw new TypeError(`--${safeOptionName(key)} must be written as a separate option and value`);
    }
    if (!allowed.has(key)) {
      throw new TypeError(`unknown option --${safeOptionName(key)}`);
    }
    if (seen.has(key)) throw new TypeError(`duplicate option --${key}`);
    seen.add(key);
    if (!values.has(key)) {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new TypeError(`--${key} needs a value`);
    }
    parsed[key] = String(next);
    index += 1;
  }
  if (!parsed.source || !SOURCE_RE.test(parsed.source)) {
    throw new TypeError("--source needs one canonical manifest source id");
  }
  parsed.target = canonicalProvenanceTargetLocator(parsed.target);
  if (parsed.apply && !SHA_RE.test(String(parsed.approve || ""))) {
    throw new TypeError("--apply requires --approve with the exact preview approval id");
  }
  if (!parsed.apply && parsed.approve !== null) {
    throw new TypeError("--approve is valid only with --apply");
  }
  if (parsed.apply && parsed.json) {
    throw new TypeError("--json is a preview option and cannot be combined with --apply");
  }
  return Object.freeze(parsed);
}

async function manifestBoundary(invocation, dependencies, assertOwned) {
  const identity = await directIdentity(invocation.manifestPath, "file", dependencies, assertOwned);
  await assertOwned();
  const bytes = await requiredCallback(dependencies, "readFile")(invocation.manifestPath);
  await assertOwned();
  if (!(typeof bytes === "string" || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    throw new TypeError("manifest reader did not return exact bytes");
  }
  const text = Buffer.from(bytes).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("manifest file is not valid JSON");
  }
  const local = parsed?.corpora?.local_folder;
  if (!plainObject(parsed) || !plainObject(local) || local.enabled !== true ||
      typeof local.path !== "string" || !local.path ||
      typeof local.source !== "string" || !SOURCE_RE.test(local.source)) {
    throw new TypeError("manifest must explicitly enable one corpora.local_folder path and source");
  }
  const root = absolutePath(local.path, "corpora.local_folder.path");
  if (local.source !== invocation.source) {
    throw new TypeError("source must exactly match corpora.local_folder.source");
  }
  if (parsed.safety?.credential_scanner?.enabled === false) {
    throw new TypeError("one-target repair requires the credential scanner to remain enabled");
  }
  const confirmedIdentity = await directIdentity(
    invocation.manifestPath,
    "file",
    dependencies,
    assertOwned,
  );
  if (!sameIdentity(identity, confirmedIdentity)) {
    throw new TypeError("manifest identity changed while its exact bytes were read");
  }
  return Object.freeze({
    identity: confirmedIdentity,
    fingerprint: sha256(Buffer.from(bytes)),
    value: Object.freeze(parsed),
    root,
  });
}

function validateHealth(value, productVersion) {
  if (!plainObject(value) || value.ok !== true || value.active !== true ||
      value.accepting_documents !== true || value.product_version !== productVersion ||
      !Number.isSafeInteger(value.schema_version) ||
      value.schema_version < PROVENANCE_TARGET_REQUIRED_SCHEMA) {
    throw new TypeError("live Brain is not the exact active schema-46-or-newer product");
  }
  return value;
}

function validateVectorReadiness(value) {
  if (!plainObject(value) || value.ready !== true || value.pending !== 0 ||
      value.submitted !== 0 || value.projection_status !== "verified" ||
      !Number.isSafeInteger(value.expected_vectors) || value.expected_vectors < 0 ||
      value.actual_vectors !== value.expected_vectors) {
    throw new TypeError("authenticated vector projection is not exactly ready with zero queued work");
  }
  return value;
}

function validateSourceInventory(value, source) {
  if (!plainObject(value) || value.contract_version !== 3 || value.kind !== "source_inventory" ||
      value.complete !== true || value.truncated !== false || value.cursor !== null ||
      !Array.isArray(value.sources) || value.returned !== value.sources.length ||
      value.total !== value.sources.length || value.snapshot?.stable !== true ||
      !SHA_ID_RE.test(String(value.snapshot?.id || ""))) {
    throw new TypeError("source inventory is not one complete stable contract-v3 snapshot");
  }
  const selected = value.sources.filter((row) => row?.source_id === source);
  if (selected.length !== 1 || selected[0].name !== source ||
      selected[0].kind !== "upload" || selected[0].registered !== true) {
    throw new TypeError("source inventory does not contain exactly one registered upload row");
  }
  const semantic = {
    contract_version: value.contract_version,
    kind: value.kind,
    total: value.total,
    sources: [...value.sources].sort((left, right) =>
      String(left?.source_id || "").localeCompare(String(right?.source_id || ""))),
    recovery_plan_summary: value.recovery_plan_summary,
    limitations: value.limitations,
  };
  return Object.freeze({
    row: selected[0],
    sourceSnapshotId: `sha256:${sha256Canonical(semantic)}`,
  });
}

function validateAssessment(value, invocation) {
  const assessment = value?.assessment;
  const observations = value?.private_observations;
  if (!plainObject(assessment) || assessment.operation !== "provenance-source-assessment" ||
      assessment.mode !== "read_only" || assessment.read_only !== true ||
      assessment.assessment_complete !== true || assessment.target_count !== 1 ||
      assessment.assessed_original_count !== 1 || assessment.traversal?.complete !== true ||
      assessment.target_resolution?.complete !== true ||
      assessment.target_resolution?.equality_only !== true ||
      assessment.ocr?.enabled !== false || assessment.ocr?.attempted !== false ||
      !Array.isArray(observations) || observations.length !== 1) {
    throw new TypeError("local assessment did not completely resolve one exact read-only target");
  }
  const original = observations[0];
  if (!plainObject(original) || original.assessment_complete !== true ||
      original.locator_kind !== "source_relative_path" || original.locator !== invocation.target ||
      original.text_state !== "native_readable" || original.text_reliable !== true ||
      original.extraction_complete !== true || original.multi_record !== false ||
      !SHA_RE.test(String(original.original_content_sha256 || "")) ||
      !Number.isSafeInteger(original.original_byte_count) || original.original_byte_count < 0 ||
      !["authoritative", "not_applicable"].includes(original.page_count_state) ||
      (original.page_count_state === "authoritative" &&
        (!Number.isSafeInteger(original.page_count) || original.page_count < 1)) ||
      (original.page_count_state === "not_applicable" && original.page_count !== null)) {
    throw new TypeError("target is not one complete reliable native-readable original with OCR off");
  }
  return Object.freeze({
    original_content_sha256: original.original_content_sha256,
    original_byte_count: original.original_byte_count,
    text_state: "native_readable",
    text_reliable: true,
    extraction_complete: true,
    page_count: original.page_count,
    page_count_state: original.page_count_state,
    multi_record: false,
  });
}

function structuralPreparedEnvelopes(prepared, invocation, original) {
  if (!plainObject(prepared) || prepared.skip || prepared.incomplete === true ||
      !plainObject(prepared.envelope) || prepared.envelopes !== undefined) {
    throw new TypeError("exact target preparation did not produce one splittable document envelope");
  }
  const sanitized = sanitizeEnvelope(prepared.envelope);
  // Ordinary local ingest stamps its direct-source lineage in batchStream.
  // This exact-target lane deliberately bypasses that whole-source stream, so
  // it must apply the same canonical first-party stamp before structural
  // splitting. A native-text flag without that lineage is only partial
  // provenance and can never support a schema-45 accepted resolution.
  const stamped = restampFirstPartySourceProvenance(sanitized, {
    textSource: sanitized.text_source,
    textReliable: sanitized.text_reliable,
  });
  const envelopes = splitOversized(stamped);
  if (!Array.isArray(envelopes) || envelopes.length < 1 || envelopes.length > MAX_DOCUMENTS) {
    throw new TypeError("prepared structural family is empty or exceeds the exact repair bound");
  }
  const expectedReceipt = {
    version: 1,
    locator_kind: "source_relative_path",
    original_content_sha256: original.original_content_sha256,
    original_byte_count: original.original_byte_count,
  };
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    const validation = ingestEnvelopeValidationError(envelope);
    if (validation) throw new TypeError("prepared target envelope failed the ingest contract");
    let receipt;
    try {
      receipt = normalizeSourceOriginalReceipt(envelope.source_original_receipt);
    } catch {
      throw new TypeError("prepared target is not bound to the assessed raw original");
    }
    if (!exactJson(receipt, expectedReceipt) || envelope.source_type !== invocation.source ||
        envelope.text_source !== "native" || envelope.text_reliable !== true ||
        typeof envelope.content !== "string" || !envelope.content.trim() ||
        plainObject(envelope.metadata) && Object.hasOwn(envelope.metadata, "family_of")) {
      throw new TypeError("prepared target does not match the assessed native original");
    }
    if (scanEnvelope(envelope).shouldRefuse) {
      throw new TypeError("credential scanner refused the exact prepared target");
    }
    if (envelopes.length === 1) {
      if (envelope.source_id !== invocation.target ||
          ["part", "part_count", "part_of"].some((key) => Object.hasOwn(envelope.metadata, key))) {
        throw new TypeError("single-document target has an unexpected structural identity");
      }
    } else if (envelope.source_id !== `${invocation.target}#part${index + 1}of${envelopes.length}` ||
        envelope.metadata?.part !== index + 1 ||
        envelope.metadata?.part_count !== envelopes.length ||
        envelope.metadata?.part_of !== invocation.target) {
      throw new TypeError("split target is not one exact contiguous structural family");
    }
  }
  return Object.freeze(envelopes.map((envelope) => Object.freeze(envelope)));
}

function privateRetrievalQuery(envelopes) {
  const words = String(envelopes[0]?.content || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 64);
  let query = words.join(" ");
  while (query && encoder.encode(query).length > MAX_QUERY_BYTES) {
    words.pop();
    query = words.join(" ");
  }
  if (!query) throw new TypeError("prepared target cannot produce a bounded private retrieval query");
  return query;
}

function validateObservationInventory(value, source) {
  if (!plainObject(value) || value.contract_version !== 1 || value.mode !== "inventory" ||
      value.source !== source || !SHA_ID_RE.test(String(value.snapshot_id || "")) ||
      !Array.isArray(value.observations) || value.returned !== value.observations.length ||
      value.total !== value.observations.length || value.page_complete !== true ||
      value.next_after_sequence !== null || value.scope?.whole_source_complete !== false) {
    throw new TypeError("observation inventory is not one complete stable source snapshot");
  }
  const seen = new Set();
  for (const observation of value.observations) {
    if (!plainObject(observation) || !Number.isSafeInteger(observation.sequence) ||
        observation.sequence < 1 || seen.has(observation.sequence) ||
        observation.source !== source || !ORIGINAL_ID_RE.test(String(observation.original_id || "")) ||
        !SHA_ID_RE.test(String(observation.observation_hash || "")) ||
        ![0, 1].includes(observation.authority_chain_version) ||
        (observation.predecessor_observation_hash !== null &&
          !SHA_ID_RE.test(String(observation.predecessor_observation_hash || "")))) {
      throw new TypeError("observation inventory contains an invalid or duplicate row");
    }
    seen.add(observation.sequence);
  }
  return Object.freeze({
    inventory: value,
    semanticId: `sha256:${sha256Canonical({
      contract_version: value.contract_version,
      source,
      observations: [...value.observations].sort((a, b) => a.sequence - b.sequence),
    })}`,
  });
}

function sealedOriginalId(privatePlan) {
  const value = privatePlan?.seal?.original_id ?? privatePlan?.seal?.targets?.[0]?.original_id;
  if (!ORIGINAL_ID_RE.test(String(value || ""))) {
    throw new TypeError("sealed target has no exact opaque original identity");
  }
  return value;
}

function targetHistory(observationInventory, originalId, original) {
  const rows = observationInventory.observations
    .filter((row) => row.original_id === originalId)
    .sort((left, right) => left.sequence - right.sequence);
  let schema46ChainStarted = false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.authority_chain_version === 0) {
      if (schema46ChainStarted || row.predecessor_observation_hash !== null) {
        throw new TypeError("target observation authority history is not one legacy prefix");
      }
      continue;
    }
    schema46ChainStarted = true;
    const expectedPredecessor = index === 0 ? null : rows[index - 1].observation_hash;
    if (row.predecessor_observation_hash !== expectedPredecessor) {
      throw new TypeError("target observation authority history is not one contiguous chain");
    }
  }
  const changedBytes = rows.filter((row) =>
    row.original_content_sha256 !== null &&
    row.original_content_sha256 !== original.original_content_sha256);
  if (changedBytes.length) {
    throw new TypeError("target observation history conflicts with the currently assessed bytes");
  }
  const unresolved = rows.filter((row) =>
    ["gap", "failed"].includes(row.outcome) &&
    row.original_content_sha256 === original.original_content_sha256 &&
    !rows.some((candidate) => candidate.resolves_observation_hash === row.observation_hash));
  if (unresolved.length > 1) {
    throw new TypeError("target has more than one unresolved observation for the same bytes");
  }
  const acceptedRows = rows.filter((row) => row.outcome === "accepted");
  if (acceptedRows.length > 1) {
    throw new TypeError("target has more than one accepted observation");
  }
  const accepted = acceptedRows[0] || null;
  let resolvedGap = null;
  if (accepted) {
    const resolved = rows.filter((row) =>
      ["gap", "failed"].includes(row.outcome) &&
      row.observation_hash === accepted.resolves_observation_hash &&
      row.original_content_sha256 === original.original_content_sha256);
    if (resolved.length !== 1 || unresolved.length !== 0 ||
        rows.at(-1)?.observation_hash !== accepted.observation_hash ||
        accepted.observation_stage !== "repair" ||
        accepted.reason_code !== "accepted_provenance_verified" ||
        accepted.locator_kind !== "source_relative_path" || accepted.target_count !== 1 ||
        !RUN_RE.test(String(accepted.run_id || "")) ||
        !SHA_RE.test(String(accepted.plan_id || "")) ||
        !SHA_ID_RE.test(String(accepted.source_snapshot_id || "")) ||
        !SHA_ID_RE.test(String(accepted.target_set_hash || "")) ||
        !SHA_ID_RE.test(String(accepted.resolves_observation_hash || "")) ||
        accepted.text_state !== original.text_state ||
        accepted.original_content_sha256 !== original.original_content_sha256 ||
        accepted.original_byte_count !== original.original_byte_count ||
        accepted.page_count !== original.page_count ||
        accepted.page_count_state !== original.page_count_state ||
        !Number.isSafeInteger(accepted.result_document_count) ||
        accepted.result_document_count < 1 ||
        !SHA_ID_RE.test(String(accepted.result_document_set_hash || "")) ||
        !Number.isSafeInteger(accepted.recorded_at) || accepted.recorded_at < 0) {
      throw new TypeError("accepted target history is incomplete or conflicts with the current original");
    }
    resolvedGap = resolved[0];
  }
  if (!accepted && !unresolved.length && rows.length) {
    throw new TypeError("target history is not a fresh discovery or one unresolved same-byte gap");
  }
  const prior = resolvedGap || unresolved[0] || null;
  return Object.freeze({
    discoveryRequired: prior === null,
    priorGap: prior === null ? null : Object.freeze({
      sequence: prior.sequence,
      outcome: prior.outcome,
      reason_code: prior.reason_code,
      observation_hash: prior.observation_hash,
      original_id: prior.original_id,
      original_content_sha256: prior.original_content_sha256,
    }),
    priorAccepted: accepted === null ? null : Object.freeze({
      sequence: accepted.sequence,
      run_id: accepted.run_id,
      plan_id: accepted.plan_id,
      source_snapshot_id: accepted.source_snapshot_id,
      target_set_hash: accepted.target_set_hash,
      observation_hash: accepted.observation_hash,
      resolves_observation_hash: accepted.resolves_observation_hash,
      original_id: accepted.original_id,
      original_content_sha256: accepted.original_content_sha256,
    }),
    history: Object.freeze({
      checked: true,
      conflict: false,
      accepted_resolution_exists: accepted !== null,
      unresolved_gap_count: accepted !== null || prior === null ? 0 : 1,
    }),
  });
}

async function sealDraft(draft, adminAccess, dependencies, assertOwned) {
  const request = formatPrivateProvenanceTargetSealRequest(draft);
  await assertOwned();
  const receipt = await requiredCallback(dependencies, "sealTargets")({
    request,
    adminAccess,
    assertOwned,
  });
  await assertOwned();
  return bindPrivateProvenanceTargetRepairSeal(draft, receipt);
}

async function buildPrivateContext(requestedInvocation, dependencies, lease) {
  const { assertOwned } = lease;
  // A preview may advertise approval only when every reviewed execution stage
  // has an injected implementation. Availability is checked, never exercised.
  assertExecutorAvailable(dependencies);
  await assertOwned();
  validateCandidateRuntime(await requiredCallback(dependencies, "verifyCandidateRuntime")({
    productVersion: requestedInvocation.productVersion,
    candidateRuntimePackageFingerprint: requestedInvocation.candidateRuntimePackageFingerprint,
    assertOwned,
  }), requestedInvocation);
  await assertOwned();
  const manifest = await manifestBoundary(requestedInvocation, dependencies, assertOwned);
  const invocation = Object.freeze({
    ...requestedInvocation,
    manifest: manifest.value,
    root: manifest.root,
  });
  const rootIdentity = await directIdentity(invocation.root, "directory", dependencies, assertOwned);
  const resolveAdmin = requiredCallback(dependencies, "resolveDurableAdminAccess");
  await assertOwned();
  const adminAccess = await resolveAdmin({
    manifest: invocation.manifest,
    manifestPath: invocation.manifestPath,
    assertOwned,
  });
  await assertOwned();
  if (!plainObject(adminAccess)) {
    throw new TypeError("durable admin access must be an injected opaque capability, not a literal key");
  }

  await assertOwned();
  validateHealth(await requiredCallback(dependencies, "readWorkerHealth")({
    manifest: invocation.manifest,
    manifestPath: invocation.manifestPath,
    adminAccess,
    assertOwned,
  }), invocation.productVersion);
  await assertOwned();
  validateVectorReadiness(await requiredCallback(dependencies, "readVectorReadiness")({
    manifest: invocation.manifest,
    manifestPath: invocation.manifestPath,
    adminAccess,
    assertOwned,
  }));
  await assertOwned();

  const readInventory = requiredCallback(dependencies, "readSourceInventory");
  const beforeInventory = validateSourceInventory(await readInventory({
    source: invocation.source,
    adminAccess,
    assertOwned,
  }), invocation.source);
  await assertOwned();
  const assess = dependencies.assessLocalSource ?? collectPrivateLocalProvenanceAssessment;
  const assessed = validateAssessment(await assess({
    sourceKind: "upload",
    root: rootIdentity.realpath,
    relativeLocators: [invocation.target],
    privatePrefixes: invocation.manifest.safety?.private_path_prefixes || [],
    assertOwned,
  }), invocation);
  await assertOwned();
  const afterInventory = validateSourceInventory(await readInventory({
    source: invocation.source,
    adminAccess,
    assertOwned,
  }), invocation.source);
  await assertOwned();
  if (beforeInventory.sourceSnapshotId !== afterInventory.sourceSnapshotId ||
      !exactJson(beforeInventory.row, afterInventory.row)) {
    throw new TypeError("registered source inventory changed during local assessment");
  }
  const confirmedRoot = await directIdentity(
    invocation.root,
    "directory",
    dependencies,
    assertOwned,
  );
  if (!sameIdentity(rootIdentity, confirmedRoot)) {
    throw new TypeError("source root identity changed during local assessment");
  }

  const prepared = await requiredCallback(dependencies, "prepareOriginal")({
    root: confirmedRoot.realpath,
    locator: invocation.target,
    sourceName: invocation.source,
    privatePrefixes: invocation.manifest.safety?.private_path_prefixes || [],
    ocr: null,
    allowStructuralSplit: true,
    assertOwned,
  });
  await assertOwned();
  // prepareOriginal is the point where the full ingest stack is loaded lazily.
  // Recheck the complete packed runtime after that import and read-only
  // extraction, before this preview can authorize any later mutation. This
  // makes a package-byte change between the initial fingerprint and the lazy
  // module load invalidate the plan instead of inheriting owner approval.
  validateCandidateRuntime(await requiredCallback(dependencies, "verifyCandidateRuntime")({
    productVersion: invocation.productVersion,
    candidateRuntimePackageFingerprint: invocation.candidateRuntimePackageFingerprint,
    assertOwned,
  }), invocation);
  await assertOwned();
  const envelopes = structuralPreparedEnvelopes(prepared, invocation, assessed);
  const retrievalQuery = privateRetrievalQuery(envelopes);
  const sourceConfigFingerprint = sha256Canonical({
    local_folder: invocation.manifest.corpora.local_folder,
    credential_scanner: invocation.manifest.safety?.credential_scanner || null,
    private_path_prefixes: invocation.manifest.safety?.private_path_prefixes || [],
  });

  const baseInput = {
    productVersion: invocation.productVersion,
    candidateRuntimePackageFingerprint: invocation.candidateRuntimePackageFingerprint,
    manifestFingerprint: manifest.fingerprint,
    sourceConfigFingerprint,
    rootIdentity: confirmedRoot,
    source: { id: invocation.source, kind: "upload", registered: true },
    sourceSnapshotId: afterInventory.sourceSnapshotId,
    locator: invocation.target,
    original: assessed,
    retrievalQuery,
    ocr: { enabled: false, attempted: false },
  };

  // The first seal discovers the target's opaque, path-stable identity without
  // trusting a local guess. Its plan is final only when history is actually
  // empty. An existing gap changes the approval binding and is resealed.
  const discoveryDraft = preparePrivateProvenanceTargetRepair({
    ...baseInput,
    priorGap: null,
    priorAccepted: null,
    discoveryRequired: true,
    history: {
      checked: true,
      conflict: false,
      accepted_resolution_exists: false,
      unresolved_gap_count: 0,
    },
  });
  const discoveryPlan = await sealDraft(discoveryDraft, adminAccess, dependencies, assertOwned);
  const readObservations = requiredCallback(dependencies, "readObservationInventory");
  const observedBefore = validateObservationInventory(await readObservations({
    source: invocation.source,
    adminAccess,
    assertOwned,
  }), invocation.source);
  await assertOwned();
  const history = targetHistory(observedBefore.inventory, sealedOriginalId(discoveryPlan), assessed);
  const designPlan = history.discoveryRequired
    ? discoveryPlan
    : await sealDraft(preparePrivateProvenanceTargetRepair({
        ...baseInput,
        priorGap: history.priorGap,
        priorAccepted: history.priorAccepted,
        discoveryRequired: false,
        history: history.history,
      }), adminAccess, dependencies, assertOwned);
  const observedAfter = validateObservationInventory(await readObservations({
    source: invocation.source,
    adminAccess,
    assertOwned,
  }), invocation.source);
  await assertOwned();
  if (observedBefore.semanticId !== observedAfter.semanticId) {
    throw new TypeError("target observation history changed while the approval plan was sealed");
  }
  const confirmedHistory = targetHistory(
    observedAfter.inventory,
    sealedOriginalId(designPlan),
    assessed,
  );
  if (!exactJson(history, confirmedHistory)) {
    throw new TypeError("target observation history no longer matches the sealed plan");
  }
  const finalInventory = validateSourceInventory(await readInventory({
    source: invocation.source,
    adminAccess,
    assertOwned,
  }), invocation.source);
  await assertOwned();
  if (beforeInventory.sourceSnapshotId !== finalInventory.sourceSnapshotId ||
      !exactJson(beforeInventory.row, finalInventory.row)) {
    throw new TypeError("registered source inventory changed while the private plan was sealed");
  }

  await assertOwned();
  const privatePlan = authorizePrivateProvenanceTargetRepair(designPlan, {
    authority: "owner_admin_authenticated_orchestrator",
    check_order: PROVENANCE_TARGET_REPAIR_AUTHENTICATED_CHECK_ORDER,
    source_lease: {
      source: invocation.source,
      acquired: true,
      held: true,
      before_private_access: true,
      before_network_access: true,
      before_state_access: true,
      lease_fingerprint: lease.fingerprint,
    },
    authenticated_inventory: {
      authenticated: true,
      complete: true,
      truncated: false,
      source_snapshot_id: finalInventory.sourceSnapshotId,
      source: { id: invocation.source, kind: "upload", registered: true },
      target_original_id: sealedOriginalId(designPlan),
      target_set_hash: designPlan.seal.target_set_hash,
      history_complete: true,
      history_conflict: false,
      accepted_resolution_exists: confirmedHistory.history.accepted_resolution_exists,
      unresolved_gap_count: confirmedHistory.history.unresolved_gap_count,
      prior_observation_hash: confirmedHistory.priorGap?.observation_hash ?? null,
      accepted_observation_hash: confirmedHistory.priorAccepted?.observation_hash ?? null,
    },
    local_readback: {
      candidate_runtime_package_fingerprint: invocation.candidateRuntimePackageFingerprint,
      manifest_fingerprint: manifest.fingerprint,
      source_config_fingerprint: sourceConfigFingerprint,
      root_identity_fingerprint: sha256Canonical(confirmedRoot),
      original_content_sha256: assessed.original_content_sha256,
      original_byte_count: assessed.original_byte_count,
      text_state: "native_readable",
      page_count: assessed.page_count,
      page_count_state: assessed.page_count_state,
      ocr_enabled: false,
    },
  });

  return Object.freeze({
    invocation,
    privatePlan,
    adminAccess,
    envelopes,
    family: Object.freeze({
      scope: "exact_structural_family",
      source: invocation.source,
      locator: invocation.target,
      base_doc_uid: `${invocation.source}:${invocation.target}`,
      keep_doc_uids: Object.freeze(envelopes.map((envelope) =>
        `${envelope.source_type}:${envelope.source_id}`)),
    }),
  });
}

function previewResult(publicPlan, privateContext) {
  const result = { publicPlan };
  Object.defineProperty(result, "privateContext", {
    value: privateContext,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(result);
}

async function acquireInvocationLease(invocation, dependencies) {
  const lease = await requiredCallback(dependencies, "acquireSourceLease")({
    manifestPath: invocation.manifestPath,
    source: invocation.source,
  });
  if (!plainObject(lease) || typeof lease.assertOwned !== "function" ||
      typeof lease.release !== "function" || !SHA_RE.test(String(lease.fingerprint || ""))) {
    throw new TypeError("source lease did not provide a stable fingerprint and ownership guards");
  }
  return lease;
}

/**
 * Build a complete, read-only, one-target preview and its non-serializable
 * private context. The source lease begins before the first file or Brain read.
 */
export async function previewProvenanceTargetRepair(input, dependencies = {}) {
  const invocation = normalizedInvocation(input);
  const lease = await acquireInvocationLease(invocation, dependencies);
  try {
    await lease.assertOwned();
    const context = await buildPrivateContext(invocation, dependencies, lease);
    await lease.assertOwned();
    return previewResult(publicProvenanceTargetRepairPlan(context.privatePlan), context);
  } finally {
    await lease.release();
  }
}

function validateIngestResponse(value, context) {
  const count = context.envelopes.length;
  if (!plainObject(value) || !Array.isArray(value.results) || value.results.length !== count ||
      !Number.isSafeInteger(value.created) || !Number.isSafeInteger(value.updated) ||
      !Number.isSafeInteger(value.unchanged) || value.created < 0 || value.updated < 0 ||
      value.unchanged < 0 || value.created + value.updated + value.unchanged !== count ||
      Number(value.refused || 0) !== 0 || Number(value.failed || 0) !== 0) {
    throw new TypeError("ingest did not accept every exact prepared envelope");
  }
  for (let index = 0; index < count; index += 1) {
    const result = value.results[index];
    const envelope = context.envelopes[index];
    if (!plainObject(result) || result.source_type !== envelope.source_type ||
        result.source_id !== envelope.source_id ||
        !["created", "updated", "unchanged"].includes(result.status)) {
      throw new TypeError("ingest response does not match the exact prepared envelope order");
    }
  }
  return Object.freeze({ created: value.created, updated: value.updated, unchanged: value.unchanged });
}

function validateReconciliation(value, family) {
  if (!plainObject(value) || value.complete !== true || value.scope !== family.scope ||
      value.source !== family.source || value.base_doc_uid !== family.base_doc_uid ||
      !exactJson(value.keep_doc_uids, family.keep_doc_uids) ||
      !Number.isSafeInteger(value.removed_count) || value.removed_count < 0) {
    throw new TypeError("structural reconciliation did not prove the exact target family boundary");
  }
  return value;
}

function validateDrain(value) {
  const readiness = value?.readiness ?? value;
  validateVectorReadiness(readiness);
  if (value?.complete !== undefined && value.complete !== true) {
    throw new TypeError("global vector drain did not complete");
  }
  return readiness;
}

function publicIncompleteReceipt(source, stage, completedStages) {
  return Object.freeze({
    schema_version: PROVENANCE_TARGET_CLI_SCHEMA_VERSION,
    operation: "provenance-target-repair",
    mode: "apply",
    status: "incomplete",
    complete: false,
    source: Object.freeze({ id: source, kind: "upload" }),
    target_count: 1,
    failed_stage: stage,
    completed_stages: Object.freeze([...completedStages]),
    whole_source_complete: false,
  });
}

export class ProvenanceTargetCliError extends Error {
  constructor(stage, source, completedStages, privateCause = null) {
    super(`One-file provenance repair stopped at ${stage}. It is incomplete and did not claim success.`);
    this.name = "ProvenanceTargetCliError";
    this.code = "PROVENANCE_TARGET_REPAIR_INCOMPLETE";
    this.stage = stage;
    this.receipt = publicIncompleteReceipt(source, stage, completedStages);
    Object.defineProperty(this, "privateCause", { value: privateCause, enumerable: false });
  }
}

async function guardedMutation(stage, context, completedStages, assertOwned, callback, payload) {
  try {
    await assertOwned();
    const response = await callback({ ...payload, adminAccess: context.adminAccess, assertOwned });
    // A delayed response may arrive after another process stole or replaced the
    // lease. Keep that outcome explicitly incomplete instead of trusting it.
    await assertOwned();
    return response;
  } catch (error) {
    if (error instanceof ProvenanceTargetCliError) throw error;
    throw new ProvenanceTargetCliError(stage, context.invocation.source, completedStages, error);
  }
}

function publicSuccessReceipt(context, ingest, reconciliation, familyRecord, acceptedRecord) {
  const reverificationOnly = context.privatePlan.input.priorAccepted !== null;
  return Object.freeze({
    schema_version: PROVENANCE_TARGET_CLI_SCHEMA_VERSION,
    operation: "provenance-target-repair",
    mode: "apply",
    status: "accepted_resolution_current",
    complete: true,
    workflow: reverificationOnly
      ? "accepted_resolution_reverification"
      : "exact_original_repair",
    source: Object.freeze({ id: context.invocation.source, kind: "upload" }),
    target_count: 1,
    ocr: Object.freeze({ enabled: false, attempted: false }),
    ingest: Object.freeze({ ...ingest }),
    reconciliation: Object.freeze({
      performed: reconciliation.performed === true,
      exact_structural_family: reconciliation.performed === true,
      removed_count: reconciliation.removed_count,
    }),
    result_family: Object.freeze({
      recorded_or_replayed: familyRecord.recorded || familyRecord.replayed,
      verified: true,
      document_count: familyRecord.document_count,
      chunk_count: familyRecord.chunk_count,
      retrieval_status: "deterministic",
      citation_status: "same_family",
    }),
    accepted_resolution: Object.freeze({
      recorded_or_replayed: acceptedRecord.recorded || acceptedRecord.replayed || acceptedRecord.reactivated,
      reactivated: acceptedRecord.reactivated === true,
      verified: true,
      current: true,
    }),
    boundaries: Object.freeze({
      whole_source_complete: false,
      private_target_details_printed: false,
      changes_access_or_zones: false,
      changes_passkeys_or_devices: false,
    }),
  });
}

/**
 * Apply only after acquiring the source lease, recomputing the entire preview
 * under that lease, and matching the exact approval generated by that fresh cut.
 */
export async function applyProvenanceTargetRepair(input, dependencies = {}) {
  const invocation = normalizedInvocation(input, { requireApproval: true });
  const lease = await acquireInvocationLease(invocation, dependencies);
  const completed = [];
  let context = null;
  try {
    await lease.assertOwned();
    context = await buildPrivateContext(invocation, dependencies, lease);
    const currentPublicPlan = publicProvenanceTargetRepairPlan(context.privatePlan);
    if (currentPublicPlan.can_apply !== true ||
        (Object.hasOwn(currentPublicPlan, "executor_available") &&
          currentPublicPlan.executor_available !== true) ||
        (Object.hasOwn(currentPublicPlan, "approval_ready") &&
          currentPublicPlan.approval_ready !== true)) {
      throw new ProvenanceTargetCliError(
        "executor_contract",
        invocation.source,
        completed,
      );
    }
    try {
      assertPrivateProvenanceTargetRepairApproval(context.privatePlan, invocation.approvalId);
    } catch (error) {
      throw new ProvenanceTargetCliError("approval_recheck", invocation.source, completed, error);
    }

    let discoveryReceipt;
    if (context.privatePlan.input.discoveryRequired) {
      const request = formatPrivateProvenanceTargetDiscoveryRequest(context.privatePlan, {
        approvalId: invocation.approvalId,
      });
      const response = await guardedMutation(
        "discovery_record",
        context,
        completed,
        lease.assertOwned,
        requiredCallback(dependencies, "recordDiscovery"),
        { request },
      );
      try {
        selectPrivateProvenanceTargetDiscoveryReceipt(context.privatePlan, response);
        discoveryReceipt = response;
      } catch (error) {
        throw new ProvenanceTargetCliError("discovery_readback", invocation.source, completed, error);
      }
      completed.push(APPLY_STAGES[0]);
    }

    const reverificationOnly = context.privatePlan.input.priorAccepted !== null;
    let ingest = Object.freeze({
      performed: false,
      created: 0,
      updated: 0,
      unchanged: 0,
    });
    let reconciliation = Object.freeze({
      performed: false,
      removed_count: 0,
    });
    if (!reverificationOnly) {
      const ingestResponse = await guardedMutation(
        "exact_original_ingest",
        context,
        completed,
        lease.assertOwned,
        requiredCallback(dependencies, "ingestPrepared"),
        { envelopes: context.envelopes },
      );
      try {
        ingest = Object.freeze({
          performed: true,
          ...validateIngestResponse(ingestResponse, context),
        });
      } catch (error) {
        throw new ProvenanceTargetCliError("exact_original_ingest_readback", invocation.source, completed, error);
      }
      completed.push(APPLY_STAGES[1]);

      const reconcileResponse = await guardedMutation(
        "exact_family_reconciliation",
        context,
        completed,
        lease.assertOwned,
        requiredCallback(dependencies, "reconcileFamily"),
        { family: context.family },
      );
      try {
        reconciliation = Object.freeze({
          performed: true,
          ...validateReconciliation(reconcileResponse, context.family),
        });
      } catch (error) {
        throw new ProvenanceTargetCliError("exact_family_reconciliation_readback", invocation.source, completed, error);
      }
      completed.push(APPLY_STAGES[2]);

      const drainResponse = await guardedMutation(
        "global_vector_drain",
        context,
        completed,
        lease.assertOwned,
        requiredCallback(dependencies, "drainVectorOutbox"),
        { scope: "global" },
      );
      try {
        validateDrain(drainResponse);
      } catch (error) {
        throw new ProvenanceTargetCliError("global_vector_drain_readback", invocation.source, completed, error);
      }
      completed.push(APPLY_STAGES[3]);
    }

    const familyRecordRequest = formatPrivateProvenanceResultFamilyRequest(context.privatePlan, {
      operation: "record",
      approvalId: invocation.approvalId,
    });
    const familyRecordRaw = await guardedMutation(
      "result_family_record",
      context,
      completed,
      lease.assertOwned,
      requiredCallback(dependencies, "recordResultFamily"),
      { request: familyRecordRequest },
    );
    let familyRecord;
    try {
      familyRecord = validatePrivateProvenanceResultFamilyResponse(
        context.privatePlan,
        familyRecordRaw,
        { operation: "record", approvalId: invocation.approvalId },
      );
    } catch (error) {
      throw new ProvenanceTargetCliError("result_family_record_readback", invocation.source, completed, error);
    }
    completed.push(APPLY_STAGES[4]);

    const familyVerifyRequest = formatPrivateProvenanceResultFamilyRequest(context.privatePlan, {
      operation: "verify",
      approvalId: invocation.approvalId,
    });
    const familyVerifyRaw = await guardedMutation(
      "result_family_verify",
      context,
      completed,
      lease.assertOwned,
      requiredCallback(dependencies, "verifyResultFamily"),
      { request: familyVerifyRequest },
    );
    let familyVerify;
    try {
      familyVerify = validatePrivateProvenanceResultFamilyResponse(
        context.privatePlan,
        familyVerifyRaw,
        {
          operation: "verify",
          approvalId: invocation.approvalId,
          recordReceipt: familyRecord,
        },
      );
    } catch (error) {
      throw new ProvenanceTargetCliError("result_family_verify_readback", invocation.source, completed, error);
    }
    completed.push(APPLY_STAGES[5]);

    const acceptedRecordRequest = formatPrivateProvenanceAcceptedResolutionRequest(
      context.privatePlan,
      {
        operation: "record",
        approvalId: invocation.approvalId,
        ...(discoveryReceipt ? { discoveryReceipt } : {}),
        resultFamilyRecordReceipt: familyRecord,
        resultFamilyVerifyReceipt: familyVerify,
      },
    );
    const acceptedRecordRaw = await guardedMutation(
      "accepted_resolution_record",
      context,
      completed,
      lease.assertOwned,
      requiredCallback(dependencies, "recordAcceptedResolution"),
      { request: acceptedRecordRequest },
    );
    let acceptedRecord;
    try {
      acceptedRecord = validatePrivateProvenanceAcceptedResolutionResponse(
        context.privatePlan,
        acceptedRecordRaw,
        {
          operation: "record",
          approvalId: invocation.approvalId,
          discoveryReceipt,
          resultFamilyRecordReceipt: familyRecord,
          resultFamilyVerifyReceipt: familyVerify,
        },
      );
    } catch (error) {
      throw new ProvenanceTargetCliError("accepted_resolution_record_readback", invocation.source, completed, error);
    }
    completed.push(APPLY_STAGES[6]);

    const acceptedVerifyRequest = formatPrivateProvenanceAcceptedResolutionRequest(
      context.privatePlan,
      {
        operation: "verify",
        approvalId: invocation.approvalId,
        ...(discoveryReceipt ? { discoveryReceipt } : {}),
        resultFamilyRecordReceipt: familyRecord,
        resultFamilyVerifyReceipt: familyVerify,
      },
    );
    const acceptedVerifyRaw = await guardedMutation(
      "accepted_resolution_verify",
      context,
      completed,
      lease.assertOwned,
      requiredCallback(dependencies, "verifyAcceptedResolution"),
      { request: acceptedVerifyRequest },
    );
    let acceptedVerify;
    try {
      acceptedVerify = validatePrivateProvenanceAcceptedResolutionResponse(
        context.privatePlan,
        acceptedVerifyRaw,
        {
          operation: "verify",
          approvalId: invocation.approvalId,
          discoveryReceipt,
          resultFamilyRecordReceipt: familyRecord,
          resultFamilyVerifyReceipt: familyVerify,
          recordReceipt: acceptedRecord,
        },
      );
    } catch (error) {
      throw new ProvenanceTargetCliError("accepted_resolution_verify_readback", invocation.source, completed, error);
    }
    completed.push(APPLY_STAGES[7]);
    return publicSuccessReceipt(context, ingest, reconciliation, familyRecord, acceptedRecord);
  } catch (error) {
    if (error instanceof ProvenanceTargetCliError) throw error;
    throw new ProvenanceTargetCliError(
      context ? "apply_orchestration" : "preview_recompute",
      invocation.source,
      completed,
      error,
    );
  } finally {
    await lease.release();
  }
}

export function renderProvenanceTargetRepairReceipt(receipt) {
  if (!plainObject(receipt) || receipt.operation !== "provenance-target-repair") {
    throw new TypeError("provenance target repair receipt is invalid");
  }
  if (receipt.complete !== true) {
    return [
      "One-file provenance repair is incomplete.",
      `It stopped at ${receipt.failed_stage}. No whole-source completion claim was made.`,
    ].join("\n");
  }
  const reverified = receipt.workflow === "accepted_resolution_reverification";
  return [
    reverified
      ? "One-file provenance proof refresh is complete."
      : "One-file provenance repair is complete.",
    `Source ${receipt.source.id}: ${receipt.result_family.document_count} current document(s), ${receipt.result_family.chunk_count} cited chunk(s).`,
    reverified
      ? "The existing exact result family and accepted resolution were reverified without reingest, family cleanup, or a vector-queue drain."
      : "The exact result family was recorded and reverified, then its one-target accepted resolution was recorded and reverified.",
    "This does not claim the whole source is complete and did not change access, zones, passkeys, or devices.",
  ].join("\n");
}

export { renderProvenanceTargetRepairPlan };
