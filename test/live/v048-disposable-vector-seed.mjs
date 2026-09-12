#!/usr/bin/env node
/**
 * Seed the exact disposable v0.4.8 recovery source with a deterministic,
 * fictional 3,201-document corpus.
 *
 * This runner does not provision, deploy, reindex, forget, or clean up any
 * resource. It accepts no source or content input. Its only live mutation is
 * the fixed batch ingest below, followed by the ordinary bounded vector drain.
 * Private per-document receipts and retrieval bodies stay in memory; the
 * durable outcome contains aggregate counts and booleans only.
 */

import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { provenanceTargetRuntimePackageFingerprint } from "../../brain.mjs";
import {
  assertExactBrainResponseOrigin,
  fetchBrainWithAdminKey,
} from "../../components/brain-http.mjs";
import {
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  reservePrivateAggregateReceipt,
  validatePrivateAggregateReceiptReservation,
} from "../../operations/private-aggregate-receipt.mjs";
import {
  createPlanEnvironment,
  readSourceIdentity,
} from "../../scripts/field-prepare.mjs";

export const V048_SEED_DOCUMENT_COUNT = 3_201;
export const V048_SEED_BATCH_SIZE = 50;
export const V048_SEED_BATCH_COUNT = Math.ceil(V048_SEED_DOCUMENT_COUNT / V048_SEED_BATCH_SIZE);
export const V048_SEED_SOURCE = "v048_vector_field_seed";
export const V048_SEED_MARKER = "v048-orchid-ledger-field-marker";
export const V048_SEED_MARKER_TITLE = "Synthetic v0.4.8 orchid ledger marker";
export const V048_SEED_REQUIRED_SCHEMA_VERSION = 46;
export const V048_SEED_CORPUS_SHA256 =
  "8aa4ca39a530041d6d163d75961399bc47f32c4dc798118e62603d0593169e77";

const RELEASE = "0.4.8";
const GATE = "v048_disposable_vector_seed";
const EXPECTED_WORKER = "brain-test-v048-field-source-recovery-gate-a48f1101";
const EXPECTED_CLIENT_SLUG = "v048-field-proof";
const EXPECTED_CLIENT_DISPLAY_NAME = "Synthetic Field Gate v0.4.8";
const EXPECTED_ADMIN_LOCATOR = `keychain://${EXPECTED_WORKER}/owner`;
const EXPECTED_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EXPECTED_EMBED_DIMENSIONS = 768;
const BINDING_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 2;
const MAX_PRIVATE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DRAIN_ROUNDS = 256;
const REFUSAL = "The documents do not answer the question.";
const SUPPORTED_QUERY = "What is the stable v0.4.8 orchid ledger field marker?";
const UNSUPPORTED_QUERY = "What exact recipe describes the cobalt glacier souffle?";

export const V048_CONNECTOR_KEYS = Object.freeze([
  "google_drive", "gmail", "calendar", "imap", "imessage", "zoom",
  "slack", "notion", "quickbooks", "microsoft", "dropbox", "hubspot",
  "upload", "local_folder", "bank_feed", "whatsapp",
]);

export class V048DisposableVectorSeedError extends Error {
  constructor(code) {
    super(code);
    this.name = "V048DisposableVectorSeedError";
    this.code = code;
  }
}

function refuse(code) {
  throw new V048DisposableVectorSeedError(code);
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value;
}

function count(value, code, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) refuse(code);
  return value;
}

function exactKeys(value, keys, code) {
  object(value, code);
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    refuse(code);
  }
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.nlink === right?.nlink && left?.size === right?.size &&
    left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertOwnedDirectFile(info, code, { privateFile = false, maximum } = {}) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.size < 1 || (maximum !== undefined && info.size > maximum) ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      (privateFile && process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    refuse(code);
  }
}

function readStableFile(path, code, { privateFile = false, maximum = MAX_PRIVATE_JSON_BYTES } = {}) {
  if (!isAbsolute(path || "")) refuse(code);
  const absolute = resolve(path);
  let descriptor;
  let bytes;
  let returned = false;
  try {
    const before = lstatSync(absolute);
    assertOwnedDirectFile(before, code, { privateFile, maximum });
    if (realpathSync(absolute) !== absolute) refuse(code);
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse(code);
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const consumed = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(consumed) || consumed < 1) refuse(code);
      offset += consumed;
    }
    if (!sameFile(opened, fstatSync(descriptor)) || !sameFile(opened, lstatSync(absolute))) {
      refuse(code);
    }
    const result = Object.freeze({ absolute, bytes, sha256: sha256(bytes), info: opened });
    returned = true;
    return result;
  } catch (error) {
    if (error instanceof V048DisposableVectorSeedError) throw error;
    refuse(code);
  } finally {
    if (!returned && bytes) bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readStableJson(path, pathCode, jsonCode) {
  const loaded = readStableFile(path, pathCode, { privateFile: true });
  try {
    let value;
    try { value = JSON.parse(loaded.bytes.toString("utf8")); } catch { refuse(jsonCode); }
    object(value, jsonCode);
    return Object.freeze({
      absolute: loaded.absolute,
      value,
      sha256: loaded.sha256,
      info: loaded.info,
    });
  } finally {
    loaded.bytes.fill(0);
  }
}

function insideRoot(path, root) {
  const delta = relative(root, path);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function assertReceiptOutsideExecutionTrees(output, roots) {
  if (!output || !isAbsolute(output.path || "")) refuse("V048_SEED_RECEIPT_PATH_REFUSED");
  const target = resolve(output.path);
  for (const root of roots) {
    if (root && insideRoot(target, root)) refuse("V048_SEED_RECEIPT_INSIDE_EXECUTION_TREE");
  }
  return output;
}

export function v048SeedCorpusSha256(documents = buildV048SyntheticDocuments()) {
  return sha256(canonical(documents));
}

function inspectStablePackageArchive(path) {
  const code = "V048_SEED_PACKAGE_ARCHIVE_REFUSED";
  if (!isAbsolute(path || "")) refuse(code);
  const absolute = resolve(path);
  let descriptor;
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    const before = lstatSync(absolute);
    assertOwnedDirectFile(before, code, { maximum: MAX_PACKAGE_ARCHIVE_BYTES });
    if (realpathSync(absolute) !== absolute) refuse(code);
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse(code);
    const digest = createHash("sha256");
    let offset = 0;
    while (offset < opened.size) {
      const requested = Math.min(chunk.length, opened.size - offset);
      const consumed = readSync(descriptor, chunk, 0, requested, offset);
      if (!Number.isSafeInteger(consumed) || consumed < 1) refuse(code);
      digest.update(chunk.subarray(0, consumed));
      offset += consumed;
    }
    if (!sameFile(opened, fstatSync(descriptor)) || !sameFile(opened, lstatSync(absolute))) {
      refuse(code);
    }
    return Object.freeze({
      absolute,
      sha256: digest.digest("hex"),
      bytes: opened.size,
      info: opened,
    });
  } catch (error) {
    if (error instanceof V048DisposableVectorSeedError) throw error;
    refuse(code);
  } finally {
    chunk.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Build the only corpus this runner can send. */
export function buildV048SyntheticDocuments() {
  const documents = Array.from({ length: V048_SEED_DOCUMENT_COUNT }, (_, index) => {
    const ordinal = String(index + 1).padStart(4, "0");
    const marker = index === 0;
    const content = marker
      ? `Fictional field record ${ordinal}. The stable marker is ${V048_SEED_MARKER}. This describes no real person or organization.`
      : `Fictional field record ${ordinal}. The painted tile belongs on imaginary shelf ${(index % 97) + 1}. This describes no real person or organization.`;
    if (content.length >= 256) refuse("V048_SEED_FIXTURE_GEOMETRY_INVALID");
    return Object.freeze({
      source_type: V048_SEED_SOURCE,
      source_id: `v048-field-${ordinal}`,
      title: marker ? V048_SEED_MARKER_TITLE : `Synthetic v0.4.8 field record ${ordinal}`,
      content,
      metadata: Object.freeze({ platform: "field_fixture", category: "synthetic" }),
    });
  });
  const frozen = Object.freeze(documents);
  if (v048SeedCorpusSha256(frozen) !== V048_SEED_CORPUS_SHA256) {
    refuse("V048_SEED_CORPUS_DIGEST_MISMATCH");
  }
  return frozen;
}

export function batchV048SyntheticDocuments(documents = buildV048SyntheticDocuments()) {
  if (!Array.isArray(documents) || documents.length !== V048_SEED_DOCUMENT_COUNT) {
    refuse("V048_SEED_FIXTURE_COUNT_INVALID");
  }
  const batches = [];
  for (let offset = 0; offset < documents.length; offset += V048_SEED_BATCH_SIZE) {
    batches.push(Object.freeze(documents.slice(offset, offset + V048_SEED_BATCH_SIZE)));
  }
  if (batches.length !== V048_SEED_BATCH_COUNT ||
      batches.some((batch) => batch.length < 1 || batch.length > V048_SEED_BATCH_SIZE)) {
    refuse("V048_SEED_BATCH_GEOMETRY_INVALID");
  }
  return Object.freeze(batches);
}

/** Refuse every manifest except the one exact, disposable source campaign. */
export function validateV048SyntheticSourceManifest(manifest) {
  object(manifest, "V048_SEED_MANIFEST_INVALID");
  if (manifest.manifest_version !== 1 ||
      manifest.client?.slug !== EXPECTED_CLIENT_SLUG ||
      manifest.client?.display_name !== EXPECTED_CLIENT_DISPLAY_NAME ||
      manifest.brain?.version !== RELEASE ||
      manifest.brain?.worker_name !== EXPECTED_WORKER ||
      manifest.infrastructure?.cloudflare?.storage !== "d1" ||
      manifest.infrastructure.cloudflare.d1_database_name !== EXPECTED_WORKER ||
      manifest.infrastructure.cloudflare.vectorize_index !== EXPECTED_WORKER ||
      manifest.retrieval?.embed_model !== EXPECTED_EMBED_MODEL ||
      manifest.retrieval?.embed_dimensions !== EXPECTED_EMBED_DIMENSIONS ||
      manifest.operations?.admin_key_secret !== EXPECTED_ADMIN_LOCATOR) {
    refuse("V048_SEED_MANIFEST_CONTRACT_MISMATCH");
  }

  const accountId = manifest.infrastructure.cloudflare.account_id;
  const databaseId = manifest.infrastructure.cloudflare.d1_database_id;
  if (!/^[a-f0-9]{32}$/i.test(String(accountId || "")) ||
      !/^[a-f0-9]{32}$/i.test(String(databaseId || ""))) {
    refuse("V048_SEED_MANIFEST_RESOURCE_ID_INVALID");
  }

  const domain = String(manifest.brain.domain || "");
  const expectedDomain = new RegExp(
    `^${EXPECTED_WORKER}\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.workers\\.dev$`,
  );
  if (!expectedDomain.test(domain)) refuse("V048_SEED_MANIFEST_DOMAIN_MISMATCH");

  const corpora = object(manifest.corpora, "V048_SEED_CONNECTOR_CONTRACT_INVALID");
  for (const key of V048_CONNECTOR_KEYS) {
    if (!object(corpora[key], "V048_SEED_CONNECTOR_CONTRACT_INVALID") ||
        corpora[key].enabled !== false) {
      refuse("V048_SEED_CONNECTORS_MUST_BE_DISABLED");
    }
  }
  for (const [key, value] of Object.entries(corpora)) {
    if (!key.startsWith("_") && value && typeof value === "object" &&
        Object.hasOwn(value, "enabled") && value.enabled !== false) {
      refuse("V048_SEED_CONNECTORS_MUST_BE_DISABLED");
    }
  }

  return Object.freeze({
    baseUrl: `https://${domain}`,
    connectorsDeclared: V048_CONNECTOR_KEYS.length,
  });
}

/** Validate the private, hash-only execution binding. */
export function validateV048SeedBinding(binding) {
  exactKeys(binding, [
    "schema_version", "candidate_commit", "runner_sha256", "package_sha256",
    "package_bytes", "package_content_fingerprint", "manifest_sha256", "corpus_sha256",
  ], "V048_SEED_BINDING_INVALID");
  if (binding.schema_version !== BINDING_SCHEMA_VERSION ||
      !COMMIT_RE.test(String(binding.candidate_commit || "")) ||
      !SHA256_RE.test(String(binding.runner_sha256 || "")) ||
      !SHA256_RE.test(String(binding.package_sha256 || "")) ||
      !Number.isSafeInteger(binding.package_bytes) || binding.package_bytes < 1 ||
      binding.package_bytes > MAX_PACKAGE_ARCHIVE_BYTES ||
      !SHA256_RE.test(String(binding.package_content_fingerprint || "")) ||
      !SHA256_RE.test(String(binding.manifest_sha256 || "")) ||
      !SHA256_RE.test(String(binding.corpus_sha256 || ""))) {
    refuse("V048_SEED_BINDING_INVALID");
  }
  if (binding.corpus_sha256 !== V048_SEED_CORPUS_SHA256) {
    refuse("V048_SEED_CORPUS_BINDING_MISMATCH");
  }
  return Object.freeze({ ...binding });
}

function validateSourceIdentity(identity, binding) {
  object(identity, "V048_SEED_SOURCE_IDENTITY_MISMATCH");
  if (identity.head_sha !== binding.candidate_commit ||
      identity.package_version !== RELEASE || identity.working_tree_clean !== true ||
      identity.shallow_repository !== false || identity.diff_check_clean !== true ||
      identity.identity_stable_during_check !== true ||
      identity.package_alignment?.aligned !== true) {
    refuse("V048_SEED_SOURCE_IDENTITY_MISMATCH");
  }
  return identity;
}

function readBoundSourceIdentity(sourceRoot, binding, readIdentity, environmentFactory) {
  try {
    return validateSourceIdentity(
      readIdentity(binding.candidate_commit, environmentFactory(process.env), { root: sourceRoot }),
      binding,
    );
  } catch (error) {
    if (error instanceof V048DisposableVectorSeedError) throw error;
    refuse("V048_SEED_SOURCE_IDENTITY_MISMATCH");
  }
}

function readPackageFingerprint(root, fingerprintRuntimePackage) {
  let fingerprint;
  try { fingerprint = fingerprintRuntimePackage({ root }); } catch {
    refuse("V048_SEED_PACKAGE_CONTENT_MISMATCH");
  }
  if (!SHA256_RE.test(String(fingerprint || ""))) {
    refuse("V048_SEED_PACKAGE_CONTENT_MISMATCH");
  }
  return fingerprint;
}

function assertCurrentFile(path, expected, code) {
  let current;
  try { current = lstatSync(path); } catch { refuse(code); }
  if (!sameFile(expected, current) || !current.isFile() || current.isSymbolicLink() ||
      current.nlink !== 1 || realpathSync(path) !== path) refuse(code);
}

function assertCurrentDirectory(path, expected, code) {
  let current;
  try { current = lstatSync(path); } catch { refuse(code); }
  if (!sameFile(expected, current) || !current.isDirectory() || current.isSymbolicLink() ||
      realpathSync(path) !== path) refuse(code);
}

/**
 * Bind the runner to one clean checkout, reviewed archive, installed package,
 * private manifest, and canonical corpus before any provider or credential use.
 */
export function inspectV048SeederLocalBindings({
  bindingPath,
  manifestPath,
  packageArchivePath,
  installerRoot,
  sourceRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url))),
  runnerPath = realpathSync(fileURLToPath(import.meta.url)),
}, {
  readIdentity = readSourceIdentity,
  environmentFactory = createPlanEnvironment,
  fingerprintRuntimePackage = provenanceTargetRuntimePackageFingerprint,
} = {}) {
  const bindingLoaded = readStableJson(
    bindingPath, "V048_SEED_BINDING_PATH_REFUSED", "V048_SEED_BINDING_INVALID",
  );
  const binding = validateV048SeedBinding(bindingLoaded.value);
  const canonicalSourceRoot = resolve(sourceRoot);
  let sourceInfo;
  try {
    sourceInfo = lstatSync(canonicalSourceRoot);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() ||
        realpathSync(canonicalSourceRoot) !== canonicalSourceRoot ||
        (typeof process.getuid === "function" && sourceInfo.uid !== process.getuid())) {
      refuse("V048_SEED_SOURCE_IDENTITY_MISMATCH");
    }
  } catch (error) {
    if (error instanceof V048DisposableVectorSeedError) throw error;
    refuse("V048_SEED_SOURCE_IDENTITY_MISMATCH");
  }
  readBoundSourceIdentity(canonicalSourceRoot, binding, readIdentity, environmentFactory);

  const runner = readStableFile(runnerPath, "V048_SEED_RUNNER_BINDING_MISMATCH", {
    maximum: MAX_PRIVATE_JSON_BYTES,
  });
  runner.bytes.fill(0);
  if (runner.sha256 !== binding.runner_sha256) refuse("V048_SEED_RUNNER_BINDING_MISMATCH");

  const archive = inspectStablePackageArchive(packageArchivePath);
  if (archive.sha256 !== binding.package_sha256 || archive.bytes !== binding.package_bytes) {
    refuse("V048_SEED_PACKAGE_ARCHIVE_MISMATCH");
  }

  const manifestLoaded = readStableJson(
    manifestPath, "V048_SEED_MANIFEST_PATH_REFUSED", "V048_SEED_MANIFEST_INVALID",
  );
  if (manifestLoaded.sha256 !== binding.manifest_sha256) {
    refuse("V048_SEED_MANIFEST_BINDING_MISMATCH");
  }
  validateV048SyntheticSourceManifest(manifestLoaded.value);

  const canonicalInstallerRoot = validateInstallerRoot(installerRoot);
  const installerInfo = lstatSync(canonicalInstallerRoot);
  const sourceFingerprint = readPackageFingerprint(canonicalSourceRoot, fingerprintRuntimePackage);
  const installedFingerprint = readPackageFingerprint(canonicalInstallerRoot, fingerprintRuntimePackage);
  if (sourceFingerprint !== binding.package_content_fingerprint ||
      installedFingerprint !== binding.package_content_fingerprint) {
    refuse("V048_SEED_PACKAGE_CONTENT_MISMATCH");
  }

  const revalidate = ({ full = false } = {}) => {
    const rebound = readStableJson(
      bindingLoaded.absolute, "V048_SEED_BINDING_PATH_REFUSED", "V048_SEED_BINDING_INVALID",
    );
    validateV048SeedBinding(rebound.value);
    if (rebound.sha256 !== bindingLoaded.sha256) refuse("V048_SEED_BINDING_CHANGED");
    const remanifest = readStableJson(
      manifestLoaded.absolute, "V048_SEED_MANIFEST_PATH_REFUSED", "V048_SEED_MANIFEST_INVALID",
    );
    if (remanifest.sha256 !== binding.manifest_sha256) {
      refuse("V048_SEED_MANIFEST_BINDING_MISMATCH");
    }
    validateV048SyntheticSourceManifest(remanifest.value);
    const rerunner = readStableFile(runner.absolute, "V048_SEED_RUNNER_BINDING_MISMATCH", {
      maximum: MAX_PRIVATE_JSON_BYTES,
    });
    rerunner.bytes.fill(0);
    if (rerunner.sha256 !== binding.runner_sha256) refuse("V048_SEED_RUNNER_BINDING_MISMATCH");
    assertCurrentFile(archive.absolute, archive.info, "V048_SEED_PACKAGE_ARCHIVE_CHANGED");
    assertCurrentDirectory(canonicalSourceRoot, sourceInfo, "V048_SEED_SOURCE_IDENTITY_MISMATCH");
    assertCurrentDirectory(canonicalInstallerRoot, installerInfo, "V048_SEED_PACKAGE_CONTENT_MISMATCH");
    if (full) {
      readBoundSourceIdentity(canonicalSourceRoot, binding, readIdentity, environmentFactory);
      const rearchive = inspectStablePackageArchive(archive.absolute);
      if (rearchive.sha256 !== binding.package_sha256 || rearchive.bytes !== binding.package_bytes) {
        refuse("V048_SEED_PACKAGE_ARCHIVE_MISMATCH");
      }
      if (readPackageFingerprint(canonicalSourceRoot, fingerprintRuntimePackage) !==
            binding.package_content_fingerprint ||
          readPackageFingerprint(canonicalInstallerRoot, fingerprintRuntimePackage) !==
            binding.package_content_fingerprint) {
        refuse("V048_SEED_PACKAGE_CONTENT_MISMATCH");
      }
    }
    return true;
  };

  return Object.freeze({
    manifest: manifestLoaded.value,
    manifestPath: manifestLoaded.absolute,
    binding,
    bindingPath: bindingLoaded.absolute,
    packageArchivePath: archive.absolute,
    installerRoot: canonicalInstallerRoot,
    sourceRoot: canonicalSourceRoot,
    runnerPath: runner.absolute,
    revalidate,
  });
}

function validateActiveHealth(body) {
  object(body, "V048_SEED_HEALTH_INVALID");
  if (body.ok !== true || body.status !== "ok" || body.accepting_documents !== true ||
      body.version !== RELEASE || body.vector_writer_protocol !== "lease-v1" ||
      body.vector_drain_mode !== "active" || body.version_mismatch === true ||
      (body.configured_version !== undefined && body.configured_version !== RELEASE)) {
    refuse("V048_SEED_SOURCE_NOT_ACTIVE");
  }
  if (body.brain !== EXPECTED_CLIENT_SLUG ||
      body.schema_version !== V048_SEED_REQUIRED_SCHEMA_VERSION) {
    refuse("V048_SEED_HEALTH_IDENTITY_MISMATCH");
  }
  return true;
}

function validateInventory(body, { empty = false } = {}) {
  object(body, "V048_SEED_INVENTORY_INVALID");
  if (body.version !== RELEASE || body.backend !== "d1" || body.vector_drain_mode !== "active" ||
      !Array.isArray(body.rows)) {
    refuse("V048_SEED_INVENTORY_INVALID");
  }
  const backlog = object(body.vector_backlog, "V048_SEED_BACKLOG_INVALID");
  const readiness = object(body.vector_readiness, "V048_SEED_READINESS_INVALID");
  const pending = count(backlog.pending, "V048_SEED_BACKLOG_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  const upserts = count(backlog.upserts, "V048_SEED_BACKLOG_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  const deletes = count(backlog.deletes, "V048_SEED_BACKLOG_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  const submitted = count(backlog.submitted, "V048_SEED_BACKLOG_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  if (upserts + deletes !== pending || submitted > pending) refuse("V048_SEED_BACKLOG_INVALID");

  const expectedVectors = count(readiness.expected_vectors, "V048_SEED_READINESS_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  const actualVectors = count(readiness.actual_vectors, "V048_SEED_READINESS_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  const readinessPending = count(readiness.pending, "V048_SEED_READINESS_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  const readinessSubmitted = count(readiness.submitted, "V048_SEED_READINESS_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
  if (readinessPending !== pending || readinessSubmitted !== submitted || readinessSubmitted > readinessPending ||
      typeof readiness.ready !== "boolean") {
    refuse("V048_SEED_READINESS_INVALID");
  }

  if (empty) {
    if (body.rows.length !== 0 || pending !== 0 || expectedVectors !== 0 || actualVectors !== 0 ||
        readiness.ready !== true) {
      refuse("V048_SEED_SOURCE_NOT_EMPTY");
    }
    return Object.freeze({ documents: 0, chunks: 0, vectors: 0 });
  }

  if (body.rows.length !== 1) refuse("V048_SEED_FINAL_CORPUS_INVALID");
  const row = object(body.rows[0], "V048_SEED_FINAL_CORPUS_INVALID");
  if (row.source_type !== V048_SEED_SOURCE ||
      row.document_counts_exact !== true || row.chunk_counts_exact !== true ||
      count(row.documents, "V048_SEED_FINAL_CORPUS_INVALID") !== V048_SEED_DOCUMENT_COUNT ||
      count(row.stored_documents, "V048_SEED_FINAL_CORPUS_INVALID") !== V048_SEED_DOCUMENT_COUNT ||
      count(row.logical_documents, "V048_SEED_FINAL_CORPUS_INVALID") !== V048_SEED_DOCUMENT_COUNT ||
      count(row.chunks, "V048_SEED_FINAL_CORPUS_INVALID") !== V048_SEED_DOCUMENT_COUNT ||
      count(row.total, "V048_SEED_FINAL_CORPUS_INVALID") !== V048_SEED_DOCUMENT_COUNT ||
      count(row.embedded, "V048_SEED_FINAL_CORPUS_INVALID") !== V048_SEED_DOCUMENT_COUNT ||
      pending !== 0 || upserts !== 0 || deletes !== 0 || submitted !== 0 ||
      expectedVectors !== V048_SEED_DOCUMENT_COUNT || actualVectors !== V048_SEED_DOCUMENT_COUNT ||
      readiness.ready !== true || readinessPending !== 0 || readinessSubmitted !== 0 ||
      readiness.projection_status !== "verified") {
    refuse("V048_SEED_FINAL_CORPUS_INVALID");
  }
  return Object.freeze({
    documents: row.documents,
    chunks: row.chunks,
    vectors: actualVectors,
    documentCountsExact: row.document_counts_exact,
    chunkCountsExact: row.chunk_counts_exact,
  });
}

function validateIngestReceipt(body, documents) {
  object(body, "V048_SEED_INGEST_RECEIPT_INVALID");
  if (!Array.isArray(body.results) || body.results.length !== documents.length ||
      count(body.total, "V048_SEED_INGEST_RECEIPT_INVALID") !== documents.length ||
      count(body.created, "V048_SEED_INGEST_RECEIPT_INVALID") !== documents.length ||
      count(body.updated, "V048_SEED_INGEST_RECEIPT_INVALID") !== 0 ||
      count(body.unchanged, "V048_SEED_INGEST_RECEIPT_INVALID") !== 0 ||
      count(body.refused, "V048_SEED_INGEST_RECEIPT_INVALID") !== 0 ||
      count(body.failed, "V048_SEED_INGEST_RECEIPT_INVALID") !== 0) {
    refuse("V048_SEED_INGEST_RECEIPT_INVALID");
  }
  for (let index = 0; index < documents.length; index++) {
    const result = object(body.results[index], "V048_SEED_INGEST_RECEIPT_INVALID");
    if (result.source_type !== V048_SEED_SOURCE ||
        result.source_id !== documents[index].source_id ||
        result.status !== "created" || result.chunks !== 1) {
      refuse("V048_SEED_INGEST_RECEIPT_INVALID");
    }
  }
  return documents.length;
}

function validateQuarantinePreview(body) {
  object(body, "V048_SEED_QUARANTINE_RECEIPT_INVALID");
  if (body.dry_run !== true ||
      count(body.quarantined, "V048_SEED_QUARANTINE_RECEIPT_INVALID") !== 0 ||
      count(body.selected, "V048_SEED_QUARANTINE_RECEIPT_INVALID") !== 0 ||
      count(body.retried, "V048_SEED_QUARANTINE_RECEIPT_INVALID") !== 0) {
    refuse("V048_SEED_QUARANTINE_RECEIPT_INVALID");
  }
  return true;
}

async function responseJson(response, code) {
  if (!response || typeof response.status !== "number" || typeof response.text !== "function") refuse(code);
  const contentType = String(response.headers?.get?.("content-type") || "");
  if (!contentType.toLowerCase().includes("application/json")) refuse(code);
  let raw;
  try { raw = await response.text(); } catch { refuse(code); }
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) refuse(code);
  try { return JSON.parse(raw); } catch { refuse(code); }
}

async function requestJson({ fetchImpl, makeSignal, baseUrl, adminKey, beforeRequest }, path, {
  method = "GET",
  body,
  authenticated = true,
  statuses = [200],
} = {}) {
  await beforeRequest();
  const url = new URL(path, `${baseUrl}/`);
  const headers = new Headers(body === undefined ? {} : { "Content-Type": "application/json" });
  const signal = makeSignal();
  const init = {
    method,
    headers,
    redirect: "error",
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  let response;
  try {
    response = authenticated
      ? await fetchBrainWithAdminKey(fetchImpl, url, init, () => adminKey)
      : await fetchImpl(url.href, init);
    if (!authenticated) assertExactBrainResponseOrigin(response, url);
  } catch {
    refuse("V048_SEED_TRANSPORT_FAILED");
  }
  const parsed = await responseJson(response, "V048_SEED_RESPONSE_INVALID");
  if (!statuses.includes(response.status)) refuse("V048_SEED_HTTP_FAILED");
  return Object.freeze({ status: response.status, body: parsed });
}

async function drainToReadiness(context, { sleep, onProgress }) {
  let previousRemaining = V048_SEED_DOCUMENT_COUNT;
  for (let round = 1; round <= MAX_DRAIN_ROUNDS; round++) {
    const response = await requestJson(context, "/api/admin/brain/drain", {
      method: "POST", body: {}, statuses: [200, 409],
    });
    if (response.status === 409) {
      const busy = object(response.body, "V048_SEED_DRAIN_BUSY_INVALID");
      const remaining = count(busy.remaining, "V048_SEED_DRAIN_BUSY_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
      const retrySeconds = count(busy.retry_after_seconds, "V048_SEED_DRAIN_BUSY_INVALID", { maximum: 60 });
      if (busy.busy !== true || remaining > previousRemaining || retrySeconds < 1) {
        refuse("V048_SEED_DRAIN_BUSY_INVALID");
      }
      previousRemaining = remaining;
      onProgress(Object.freeze({ phase: "drain", round, remaining, busy: true }));
      await sleep(retrySeconds * 1_000);
      continue;
    }

    const body = object(response.body, "V048_SEED_DRAIN_RECEIPT_INVALID");
    const drained = count(body.drained, "V048_SEED_DRAIN_RECEIPT_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
    const submitted = count(body.submitted, "V048_SEED_DRAIN_RECEIPT_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
    const waiting = count(body.waiting, "V048_SEED_DRAIN_RECEIPT_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
    const remaining = count(body.remaining, "V048_SEED_DRAIN_RECEIPT_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
    const expected = count(body.expected_vectors, "V048_SEED_DRAIN_RECEIPT_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
    const actual = count(body.actual_vectors, "V048_SEED_DRAIN_RECEIPT_INVALID", { maximum: V048_SEED_DOCUMENT_COUNT });
    if (typeof body.vector_ready !== "boolean" || expected !== V048_SEED_DOCUMENT_COUNT ||
        waiting > remaining || remaining > previousRemaining || actual > expected ||
        (remaining > 0 && drained === 0 && submitted === 0 && waiting === 0) ||
        (body.vector_ready && (remaining !== 0 || waiting !== 0 || actual !== expected))) {
      refuse("V048_SEED_DRAIN_RECEIPT_INVALID");
    }
    previousRemaining = remaining;
    onProgress(Object.freeze({ phase: "drain", round, remaining, busy: false }));
    if (body.vector_ready) return Object.freeze({ rounds: round });
    await sleep(1_500);
  }
  refuse("V048_SEED_DRAIN_LIMIT_REACHED");
}

function validateSupportedResult(body) {
  object(body, "V048_SEED_SUPPORTED_CASE_FAILED");
  if (body.mode !== "think" || typeof body.answer !== "string" || !body.answer.trim() ||
      body.answer === REFUSAL || body.answer_error != null || !Array.isArray(body.citations) ||
      !body.citations.some((citation) => citation?.source === V048_SEED_SOURCE &&
        citation?.title === V048_SEED_MARKER_TITLE) || body.evidence_gate?.supported === false) {
    refuse("V048_SEED_SUPPORTED_CASE_FAILED");
  }
  return true;
}

function validateUnsupportedResult(body) {
  object(body, "V048_SEED_UNSUPPORTED_CASE_FAILED");
  if (body.mode !== "think" || body.answer !== REFUSAL || body.answer_error != null ||
      !Array.isArray(body.citations) || body.citations.length !== 0) {
    refuse("V048_SEED_UNSUPPORTED_CASE_FAILED");
  }
  return true;
}

function completedAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) refuse("V048_SEED_CLOCK_INVALID");
  return date.toISOString();
}

export function assertV048AggregateSeedReceipt(receipt) {
  exactKeys(receipt, [
    "schema_version", "gate", "release", "completed_at", "data_class", "status",
    "binding", "contract", "ingest", "projection", "evaluation", "proof_boundary",
  ], "V048_SEED_AGGREGATE_RECEIPT_INVALID");
  validateV048SeedBinding(receipt.binding);
  exactKeys(receipt.contract, [
    "resource_names_match_plan", "connectors_declared", "connectors_enabled",
    "active_mode_proved", "worker_version", "health_brain_identity_proved",
    "schema_version", "document_counts_exact", "chunk_counts_exact",
  ], "V048_SEED_AGGREGATE_RECEIPT_INVALID");
  exactKeys(receipt.ingest, [
    "documents", "batches", "created", "refused", "failed", "one_chunk_documents",
  ], "V048_SEED_AGGREGATE_RECEIPT_INVALID");
  exactKeys(receipt.projection, [
    "d1_documents", "d1_chunks", "vectorize_vectors", "pending_outbox",
    "quarantined_vectors", "vector_readiness_proved", "drain_rounds",
  ], "V048_SEED_AGGREGATE_RECEIPT_INVALID");
  exactKeys(receipt.evaluation, ["supported_case_cited", "unsupported_case_refused"],
    "V048_SEED_AGGREGATE_RECEIPT_INVALID");
  if (receipt.schema_version !== RECEIPT_SCHEMA_VERSION || receipt.gate !== GATE ||
      receipt.release !== RELEASE ||
      receipt.data_class !== "deterministic_fictional_synthetic_only" || receipt.status !== "passed" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(receipt.completed_at) ||
      receipt.contract.resource_names_match_plan !== true ||
      receipt.contract.connectors_declared !== V048_CONNECTOR_KEYS.length ||
      receipt.contract.connectors_enabled !== 0 || receipt.contract.active_mode_proved !== true ||
      receipt.contract.worker_version !== RELEASE ||
      receipt.contract.health_brain_identity_proved !== true ||
      receipt.contract.schema_version !== V048_SEED_REQUIRED_SCHEMA_VERSION ||
      receipt.contract.document_counts_exact !== true ||
      receipt.contract.chunk_counts_exact !== true ||
      receipt.ingest.documents !== V048_SEED_DOCUMENT_COUNT ||
      receipt.ingest.batches !== V048_SEED_BATCH_COUNT ||
      receipt.ingest.created !== V048_SEED_DOCUMENT_COUNT || receipt.ingest.refused !== 0 ||
      receipt.ingest.failed !== 0 || receipt.ingest.one_chunk_documents !== V048_SEED_DOCUMENT_COUNT ||
      receipt.projection.d1_documents !== V048_SEED_DOCUMENT_COUNT ||
      receipt.projection.d1_chunks !== V048_SEED_DOCUMENT_COUNT ||
      receipt.projection.vectorize_vectors !== V048_SEED_DOCUMENT_COUNT ||
      receipt.projection.pending_outbox !== 0 || receipt.projection.quarantined_vectors !== 0 ||
      receipt.projection.vector_readiness_proved !== true ||
      !Number.isSafeInteger(receipt.projection.drain_rounds) || receipt.projection.drain_rounds < 1 ||
      receipt.evaluation.supported_case_cited !== true ||
      receipt.evaluation.unsupported_case_refused !== true ||
      receipt.proof_boundary !== "Synthetic source seeding and Worker-reported projection readiness only; independent control-plane parity, recovery, teardown, release, and customer use remain separate gates.") {
    refuse("V048_SEED_AGGREGATE_RECEIPT_INVALID");
  }
  return true;
}

/**
 * Run the live seeder. Every external dependency is injectable so the offline
 * test suite performs no provider call and no credential lookup.
 */
export async function runV048DisposableVectorSeed({
  manifest,
  manifestPath,
  receiptPath,
  installerRoot,
  sourceRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url))),
  binding,
}, {
  fetchImpl = globalThis.fetch,
  resolveAdminKey,
  makeSignal = () => AbortSignal.timeout(120_000),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = () => new Date(),
  onProgress = () => {},
  assertReceiptOutput = assertPrivateAggregateOutputPath,
  reserveReceipt = reservePrivateAggregateReceipt,
  validateReceiptReservation = validatePrivateAggregateReceiptReservation,
  finalizeReceipt = finalizePrivateAggregateReceipt,
  abandonReceipt = abandonPrivateAggregateReceipt,
  revalidateLocalBindings,
} = {}) {
  if (process.platform === "win32") refuse("V048_SEED_REQUIRES_POSIX_PRIVATE_RECEIPTS");
  const contract = validateV048SyntheticSourceManifest(manifest);
  const validatedBinding = validateV048SeedBinding(binding);
  if (typeof fetchImpl !== "function" || typeof resolveAdminKey !== "function" ||
      typeof makeSignal !== "function" || typeof sleep !== "function" || typeof now !== "function" ||
      typeof onProgress !== "function" || typeof assertReceiptOutput !== "function" ||
      typeof reserveReceipt !== "function" || typeof validateReceiptReservation !== "function" ||
      typeof finalizeReceipt !== "function" ||
      typeof abandonReceipt !== "function" || typeof revalidateLocalBindings !== "function") {
    refuse("V048_SEED_DEPENDENCY_INVALID");
  }

  const documents = buildV048SyntheticDocuments();
  if (v048SeedCorpusSha256(documents) !== validatedBinding.corpus_sha256) {
    refuse("V048_SEED_CORPUS_BINDING_MISMATCH");
  }
  await revalidateLocalBindings({ full: true });
  const output = assertReceiptOutsideExecutionTrees(
    await assertReceiptOutput(receiptPath),
    [resolve(sourceRoot), resolve(installerRoot)],
  );
  const marker = Object.freeze({
    schema_version: RECEIPT_SCHEMA_VERSION,
    gate: GATE,
    release: RELEASE,
    status: "execution_in_progress",
    data_class: "deterministic_fictional_synthetic_only",
    expected_documents: V048_SEED_DOCUMENT_COUNT,
    binding: validatedBinding,
  });
  let reservation = null;
  let finalized = false;
  try {
    reservation = await reserveReceipt(output, marker);
    const revalidateReceiptReservation = () => validateReceiptReservation(reservation, {
      code: "V048_SEED_RECEIPT_RESERVATION_CHANGED",
    });
    const context = {
      fetchImpl,
      makeSignal,
      baseUrl: contract.baseUrl,
      adminKey: null,
      beforeRequest: async () => {
        await revalidateLocalBindings({ full: false });
        revalidateReceiptReservation();
      },
    };

    const openingHealth = await requestJson(context, "/health", { authenticated: false });
    validateActiveHealth(openingHealth.body);

    await revalidateLocalBindings({ full: true });
    revalidateReceiptReservation();
    const key = await resolveAdminKey({ manifest, manifestPath, installerRoot });
    await revalidateLocalBindings({ full: true });
    revalidateReceiptReservation();
    if (!/^[a-f0-9]{48}$/.test(String(key || ""))) refuse("V048_SEED_ADMIN_KEY_INVALID");
    context.adminKey = key;

    const openingInventory = await requestJson(context, "/api/admin/brain/documents");
    validateInventory(openingInventory.body, { empty: true });

    const batches = batchV048SyntheticDocuments(documents);
    let created = 0;
    for (let index = 0; index < batches.length; index++) {
      const response = await requestJson(context, "/api/admin/brain/ingest/batch", {
        method: "POST", body: { docs: batches[index] },
      });
      created += validateIngestReceipt(response.body, batches[index]);
      if (index === 0 || (index + 1) % 8 === 0 || index + 1 === batches.length) {
        onProgress(Object.freeze({
          phase: "ingest",
          batches_completed: index + 1,
          documents_created: created,
        }));
      }
    }
    if (created !== V048_SEED_DOCUMENT_COUNT) refuse("V048_SEED_INGEST_TOTAL_INVALID");

    const drain = await drainToReadiness(context, { sleep, onProgress });
    const quarantine = await requestJson(context, "/api/admin/brain/vector-retry", {
      method: "POST", body: { confirm: false },
    });
    validateQuarantinePreview(quarantine.body);

    const finalInventory = await requestJson(context, "/api/admin/brain/documents");
    const final = validateInventory(finalInventory.body);

    const supported = await requestJson(context, "/api/rag/think", {
      method: "POST", body: { q: SUPPORTED_QUERY, source: V048_SEED_SOURCE, limit: 8 },
    });
    validateSupportedResult(supported.body);
    const unsupported = await requestJson(context, "/api/rag/think", {
      method: "POST", body: { q: UNSUPPORTED_QUERY, source: V048_SEED_SOURCE, limit: 8 },
    });
    validateUnsupportedResult(unsupported.body);

    const closingHealth = await requestJson(context, "/health", { authenticated: false });
    validateActiveHealth(closingHealth.body);
    await revalidateLocalBindings({ full: true });
    revalidateReceiptReservation();

    const receipt = Object.freeze({
      schema_version: RECEIPT_SCHEMA_VERSION,
      gate: GATE,
      release: RELEASE,
      completed_at: completedAt(now),
      data_class: "deterministic_fictional_synthetic_only",
      status: "passed",
      binding: validatedBinding,
      contract: Object.freeze({
        resource_names_match_plan: true,
        connectors_declared: contract.connectorsDeclared,
        connectors_enabled: 0,
        active_mode_proved: true,
        worker_version: RELEASE,
        health_brain_identity_proved: true,
        schema_version: V048_SEED_REQUIRED_SCHEMA_VERSION,
        document_counts_exact: final.documentCountsExact,
        chunk_counts_exact: final.chunkCountsExact,
      }),
      ingest: Object.freeze({
        documents: created,
        batches: batches.length,
        created,
        refused: 0,
        failed: 0,
        one_chunk_documents: created,
      }),
      projection: Object.freeze({
        d1_documents: final.documents,
        d1_chunks: final.chunks,
        vectorize_vectors: final.vectors,
        pending_outbox: 0,
        quarantined_vectors: 0,
        vector_readiness_proved: true,
        drain_rounds: drain.rounds,
      }),
      evaluation: Object.freeze({
        supported_case_cited: true,
        unsupported_case_refused: true,
      }),
      proof_boundary: "Synthetic source seeding and Worker-reported projection readiness only; independent control-plane parity, recovery, teardown, release, and customer use remain separate gates.",
    });
    assertV048AggregateSeedReceipt(receipt);
    await revalidateLocalBindings({ full: true });
    revalidateReceiptReservation();
    const finalizedResult = await finalizeReceipt(reservation, receipt);
    if (finalizedResult !== true) refuse("V048_SEED_RECEIPT_FINALIZATION_FAILED");
    finalized = true;
    return receipt;
  } finally {
    if (reservation && !finalized) await abandonReceipt(reservation);
  }
}

function parseValueArgs(args) {
  const values = new Map();
  const flags = new Set();
  const valueFlags = new Set([
    "--confirm", "--manifest", "--installer-root", "--package-archive", "--binding", "--receipt",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--execute") {
      if (flags.has(arg)) refuse("V048_SEED_ARGUMENT_INVALID");
      flags.add(arg);
      continue;
    }
    if (!valueFlags.has(arg) || values.has(arg) || index === args.length - 1 ||
        String(args[index + 1]).startsWith("--")) {
      refuse("V048_SEED_ARGUMENT_INVALID");
    }
    values.set(arg, args[++index]);
  }
  return { flags, values };
}

export function parseV048DisposableVectorSeedArgs(args) {
  if (!Array.isArray(args)) refuse("V048_SEED_ARGUMENT_INVALID");
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ mode: "help" });
  if (args.length === 1 && args[0] === "--plan") return Object.freeze({ mode: "plan" });
  const { flags, values } = parseValueArgs(args);
  if (!flags.has("--execute") || values.get("--confirm") !== "seed-v048-disposable-vector-source" ||
      !values.get("--manifest") || !values.get("--installer-root") ||
      !values.get("--package-archive") || !values.get("--binding") || !values.get("--receipt")) {
    refuse("V048_SEED_ARGUMENT_INVALID");
  }
  return Object.freeze({
    mode: "execute",
    manifestPath: values.get("--manifest"),
    installerRoot: values.get("--installer-root"),
    packageArchivePath: values.get("--package-archive"),
    bindingPath: values.get("--binding"),
    receiptPath: values.get("--receipt"),
  });
}

function validateInstallerRoot(path) {
  if (!isAbsolute(path || "")) refuse("V048_SEED_INSTALLER_ROOT_REFUSED");
  const absolute = resolve(path);
  let rootInfo;
  try { rootInfo = lstatSync(absolute); } catch { refuse("V048_SEED_INSTALLER_ROOT_REFUSED"); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(absolute) !== absolute ||
      (typeof process.getuid === "function" && rootInfo.uid !== process.getuid())) {
    refuse("V048_SEED_INSTALLER_ROOT_REFUSED");
  }
  for (const name of ["brain.mjs", "package.json"]) {
    let info;
    try { info = lstatSync(join(absolute, name)); } catch {
      refuse("V048_SEED_INSTALLER_ROOT_REFUSED");
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      refuse("V048_SEED_INSTALLER_ROOT_REFUSED");
    }
  }
  let packageJson;
  try { packageJson = JSON.parse(readFileSync(join(absolute, "package.json"), "utf8")); } catch {
    refuse("V048_SEED_INSTALLER_ROOT_REFUSED");
  }
  if (packageJson.version !== RELEASE) refuse("V048_SEED_INSTALLER_VERSION_MISMATCH");
  return absolute;
}

async function resolveInstalledAdminKey({ manifestPath, installerRoot }) {
  const module = await import(pathToFileURL(join(installerRoot, "brain.mjs")).href);
  if (typeof module.resolveAdminKey !== "function") refuse("V048_SEED_ADMIN_KEY_RESOLVER_MISSING");
  return module.resolveAdminKey(manifestPath, { ignoreEnvironment: true });
}

function usage() {
  return `Usage:
  node test/live/v048-disposable-vector-seed.mjs --plan
  node test/live/v048-disposable-vector-seed.mjs --execute \\
    --confirm seed-v048-disposable-vector-source \\
    --manifest /private/path/source.manifest.json \\
    --installer-root /path/to/exact-v0.4.8-package \\
    --package-archive /private/path/reviewed-v0.4.8.tgz \\
    --binding /private/path/v048-vector-seed-binding.json \\
    --receipt /private/path/v048-vector-seed-receipt.json

Execution writes exactly 3,201 fictional documents to the already-provisioned
campaign source, drains its vector outbox, and preserves an owner-only aggregate
receipt. It does not provision, deploy, reindex, forget, or clean up resources.`;
}

export async function main(args = process.argv.slice(2), {
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
} = {}) {
  const options = parseV048DisposableVectorSeedArgs(args);
  if (options.mode === "help") {
    stdout(`${usage()}\n`);
    return 0;
  }
  if (options.mode === "plan") {
    stdout(`${JSON.stringify({
      gate: GATE,
      release: RELEASE,
      plan_mode_live_actions: false,
      execution_mutates_live_resources: true,
      provisions_resources: false,
      removes_resources: false,
      accepts_external_source_or_content: false,
      fictional_documents: V048_SEED_DOCUMENT_COUNT,
      ingest_batches: V048_SEED_BATCH_COUNT,
      expected_chunks_per_document: 1,
      receipt: "owner-only aggregate JSON",
    }, null, 2)}\n`);
    return 0;
  }

  const local = inspectV048SeederLocalBindings(options);
  const receipt = await runV048DisposableVectorSeed({
    manifest: local.manifest,
    manifestPath: local.manifestPath,
    installerRoot: local.installerRoot,
    sourceRoot: local.sourceRoot,
    binding: local.binding,
    receiptPath: options.receiptPath,
  }, {
    resolveAdminKey: resolveInstalledAdminKey,
    revalidateLocalBindings: local.revalidate,
    onProgress: (progress) => stderr(`${JSON.stringify(progress)}\n`),
  });
  stdout(`${JSON.stringify({
    status: receipt.status,
    documents: receipt.ingest.documents,
    chunks: receipt.projection.d1_chunks,
    vector_readiness_proved: receipt.projection.vector_readiness_proved,
  }, null, 2)}\n`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("V048_DISPOSABLE_VECTOR_SEED_FAILED\n");
    process.exitCode = 1;
  });
}
