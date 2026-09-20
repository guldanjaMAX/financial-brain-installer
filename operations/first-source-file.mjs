/**
 * Injection-only contract for the supervised first-source, exact-file pilot.
 *
 * This module deliberately performs no filesystem, credential, or network IO.
 * The eventual `brain ingest-file` adapter must inject every boundary. That
 * keeps the ordering, approval binding, and same-item proof contract testable
 * without a live Brain or customer data.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const FIRST_SOURCE_FILE_CONTRACT_VERSION = 1;
export const FIRST_SOURCE_FILE_RUNTIME_IDENTITY_SCHEME =
  "brain.runtime-payload.sha256.v1";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA256_ID_RE = /^sha256:[a-f0-9]{64}$/u;
const ORIGINAL_ID_RE = /^hmac-sha256:[a-f0-9]{64}$/u;
const PROBE_ID_RE = /^probe-v1:[a-f0-9]{64}$/u;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/u;
const MAX_LOCATOR_BYTES = 1_024;
const MAX_QUERY_BYTES = 768;
const encoder = new TextEncoder();

const SOURCE_REGISTRATION_POLICY_VALUE = {
  mode: "read_only",
  require_pre_existing: true,
  required_kind: "upload",
  expected_match_count: 1,
  registration_allowed: false,
};

const PASSIVE_READINESS_POLICY_VALUE = {
  mode: "bounded_passive_wait",
  retryable_error_code: "source_original_result_family_vector_unready",
  max_attempts: 25,
  attempt_timeout_ms: 10_000,
  wait_interval_ms: 10_000,
  wall_clock_timeout_ms: 250_000,
  manual_drain: false,
  reingest: false,
};

const RESULT_FAMILY_UNRELATED_BACKLOG_CODE = "first_source_result_family_unrelated_backlog";

const EFFECT_EXCLUSIONS_VALUE = {
  exact_file_count: 1,
  manual_windows_x64_only: true,
  ocr: false,
  whole_source_walk: false,
  whole_source_complete: false,
  removal_inference: false,
  family_reconciliation: false,
  vector_drain: false,
  resume_state: false,
  scheduling: false,
};

const EXACT_LOCAL_BOUNDARY_VALUE = {
  kind: "one_exact_local_file",
  exact_file_resolved: true,
  root_entry_count: 1,
  walked: false,
  unrelated_content_read: false,
  removal_inferred: false,
  ocr_attempted: false,
  credential_scan: "passed",
};

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeJson(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${label} contains a non-canonical number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${label} contains a cycle`);
    seen.add(value);
    const normalized = value.map((child) => normalizeJson(child, label, seen));
    seen.delete(value);
    return normalized;
  }
  if (!plainObject(value)) throw new TypeError(`${label} must be canonical JSON data`);
  if (seen.has(value)) throw new TypeError(`${label} contains a cycle`);
  seen.add(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (!key || key.normalize("NFC") !== key) {
      throw new TypeError(`${label} contains a non-canonical key`);
    }
    normalized[key] = normalizeJson(value[key], label, seen);
  }
  seen.delete(value);
  return normalized;
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

function digestId(value) {
  return `sha256:${sha256Canonical(value)}`;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be one object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an unexpected shape`);
  }
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new TypeError(`${label} must be one lowercase SHA-256 value`);
  }
  return value;
}

function byteCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be one nonnegative safe integer`);
  }
  return value;
}

function decimal(value, label) {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : value;
  if (typeof normalized !== "string" || !DECIMAL_RE.test(normalized)) {
    throw new TypeError(`${label} must be one nonnegative decimal integer`);
  }
  return normalized;
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be one canonical nonempty value`);
  }
  return value;
}

function safeOptionName(value) {
  const name = String(value || "").split("=", 1)[0];
  return /^[a-z0-9-]{1,64}$/u.test(name) ? name : "unknown";
}

/** One canonical Windows-safe, source-relative file locator using `/`. */
export function canonicalFirstSourceFileLocator(value) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") ||
      encoder.encode(value).length > MAX_LOCATOR_BYTES || value.startsWith("/") ||
      value.endsWith("/") || value.includes("\\") || value.includes("//") ||
      /[\u0000-\u001f\u007f<>:"|?*]/u.test(value)) {
    throw new TypeError("--file needs one canonical source-relative file locator");
  }
  const parts = value.split("/");
  if (parts.length !== 1) {
    throw new TypeError("--file needs one canonical source-relative locator for the direct file in the dedicated source root");
  }
  for (const part of parts) {
    const stem = part.split(".", 1)[0].toUpperCase();
    if (!part || part === "." || part === ".." || /[ .]$/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
      throw new TypeError("--file needs one canonical source-relative file locator");
    }
  }
  return value;
}

/** Strict argv parser for the dedicated preview/apply command. */
export function parseFirstSourceFileArgv(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError("ingest-file arguments must be a list");
  if (!argv.length || typeof argv[0] !== "string" || !argv[0] || argv[0].startsWith("--") ||
      /[\u0000-\u001f\u007f]/u.test(argv[0])) {
    throw new TypeError("ingest-file needs exactly one manifest path first");
  }
  const manifest = argv[0];
  const allowed = new Set([
    "source",
    "file",
    "expect-runtime-sha256",
    "apply",
    "approve",
    "json",
  ]);
  const valued = new Set(["source", "file", "expect-runtime-sha256", "approve"]);
  const parsed = {
    manifest,
    source: null,
    file: null,
    expectedRuntimeSha256: null,
    apply: false,
    approve: null,
    json: false,
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--") || token === "--") {
      throw new TypeError("unexpected positional argument in ingest-file");
    }
    const key = token.slice(2);
    if (key.includes("=")) {
      throw new TypeError(`--${safeOptionName(key)} must use a separate option and value`);
    }
    if (!allowed.has(key)) throw new TypeError(`unknown option --${safeOptionName(key)}`);
    if (seen.has(key)) throw new TypeError(`duplicate option --${key}`);
    seen.add(key);
    if (!valued.has(key)) {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (typeof next !== "string" || !next || next.startsWith("--")) {
      throw new TypeError(`--${key} needs a value`);
    }
    if (key === "expect-runtime-sha256") parsed.expectedRuntimeSha256 = next;
    else parsed[key] = next;
    index += 1;
  }
  if (typeof parsed.source !== "string" || !SOURCE_RE.test(parsed.source)) {
    throw new TypeError("--source needs one canonical manifest source id");
  }
  parsed.file = canonicalFirstSourceFileLocator(parsed.file);
  parsed.expectedRuntimeSha256 = hash(
    parsed.expectedRuntimeSha256,
    "--expect-runtime-sha256",
  );
  if (parsed.apply) {
    if (!SHA256_RE.test(String(parsed.approve || ""))) {
      throw new TypeError("--apply requires --approve with the exact preview approval fingerprint");
    }
    if (parsed.json) throw new TypeError("--json is a preview-only option");
  } else {
    if (parsed.approve !== null) throw new TypeError("--approve is valid only with --apply");
    if (!parsed.json) throw new TypeError("preview requires --json");
  }
  return deepFreeze({
    ...parsed,
    mode: parsed.apply ? "apply" : "preview",
  });
}

function normalizeInvocation(value, mode) {
  if (!plainObject(value)) throw new TypeError("ingest-file needs one parsed invocation");
  const manifest = nonempty(value.manifest, "manifest path");
  if (!SOURCE_RE.test(String(value.source || ""))) {
    throw new TypeError("source must be one canonical manifest source id");
  }
  const file = canonicalFirstSourceFileLocator(value.file);
  const expectedRuntimeSha256 = hash(
    value.expectedRuntimeSha256,
    "expected runtime SHA-256",
  );
  const apply = value.apply === true;
  const json = value.json === true;
  const approve = value.approve ?? null;
  if (mode === "preview" && (apply || !json || approve !== null)) {
    throw new TypeError("preview requires --json and cannot include apply approval");
  }
  if (mode === "apply" && (!apply || json || !SHA256_RE.test(String(approve || "")))) {
    throw new TypeError("apply requires one exact approval and cannot include --json");
  }
  return deepFreeze({
    manifest,
    source: value.source,
    file,
    expectedRuntimeSha256,
    apply,
    json,
    approve,
    mode,
  });
}

function normalizeArchitecture(value) {
  exactKeys(value, [
    "platform",
    "native_windows_architecture",
    "node_process_architecture",
    "native_probe",
    "native_probe_fingerprint",
  ], "architecture identity");
  if (value.platform !== "win32" || value.native_windows_architecture !== "x64" ||
      value.node_process_architecture !== "x64" ||
      value.native_probe !== "RuntimeInformation.OSArchitecture") {
    throw new TypeError("ingest-file requires native Windows x64 and a Node x64 process");
  }
  return deepFreeze({
    platform: "win32",
    native_windows_architecture: "x64",
    node_process_architecture: "x64",
    native_probe: "RuntimeInformation.OSArchitecture",
    native_probe_fingerprint: hash(value.native_probe_fingerprint, "native architecture probe fingerprint"),
  });
}

/** Bind the native Windows gate receipt to the pilot's private architecture identity. */
export function firstSourceArchitectureIdentity(result, assertResult) {
  if (typeof assertResult !== "function") {
    throw new TypeError("the native Windows architecture result validator is unavailable");
  }
  assertResult(result);
  if (result.eligible !== true || result.status !== "verified") {
    throw new TypeError("the first-source pilot requires native Windows x64");
  }
  return deepFreeze({
    platform: "win32",
    native_windows_architecture: "x64",
    node_process_architecture: "x64",
    native_probe: "RuntimeInformation.OSArchitecture",
    native_probe_fingerprint: sha256Canonical(result),
  });
}

function normalizeManifestIdentity(value) {
  exactKeys(value, ["content_sha256", "byte_count", "filesystem_identity_sha256"], "manifest identity");
  return deepFreeze({
    content_sha256: hash(value.content_sha256, "manifest content hash"),
    byte_count: byteCount(value.byte_count, "manifest byte count"),
    filesystem_identity_sha256: hash(value.filesystem_identity_sha256, "manifest filesystem identity"),
  });
}

function normalizeRootIdentity(value) {
  exactKeys(value, ["filesystem_identity_sha256", "realpath_sha256"], "root identity");
  return deepFreeze({
    filesystem_identity_sha256: hash(value.filesystem_identity_sha256, "root filesystem identity"),
    realpath_sha256: hash(value.realpath_sha256, "root realpath identity"),
  });
}

function normalizeFileIdentity(value) {
  exactKeys(value, [
    "filesystem_identity_sha256",
    "realpath_sha256",
    "byte_count",
    "link_count",
    "mtime_ns",
    "ctime_ns",
  ], "file identity");
  if (value.link_count !== 1) {
    throw new TypeError("exact file must have one filesystem link");
  }
  return deepFreeze({
    filesystem_identity_sha256: hash(value.filesystem_identity_sha256, "file filesystem identity"),
    realpath_sha256: hash(value.realpath_sha256, "file realpath identity"),
    byte_count: byteCount(value.byte_count, "file byte count"),
    link_count: 1,
    mtime_ns: decimal(value.mtime_ns, "file mtime"),
    ctime_ns: decimal(value.ctime_ns, "file ctime"),
  });
}

function normalizeRuntimeIdentity(value, invocation) {
  exactKeys(value, [
    "identity_scheme",
    "runtime_payload_sha256",
    "expected_runtime_sha256",
    "product_version",
  ], "runtime identity");
  if (value.identity_scheme !== FIRST_SOURCE_FILE_RUNTIME_IDENTITY_SCHEME) {
    throw new TypeError("runtime identity uses an unsupported scheme");
  }
  const runtimePayloadSha256 = hash(
    value.runtime_payload_sha256,
    "runtime payload SHA-256",
  );
  const expectedRuntimeSha256 = hash(
    value.expected_runtime_sha256,
    "expected runtime SHA-256",
  );
  if (runtimePayloadSha256 !== expectedRuntimeSha256 ||
      expectedRuntimeSha256 !== invocation.expectedRuntimeSha256) {
    throw new TypeError("runtime identity does not match the independently expected payload");
  }
  return deepFreeze({
    identity_scheme: FIRST_SOURCE_FILE_RUNTIME_IDENTITY_SCHEME,
    runtime_payload_sha256: runtimePayloadSha256,
    expected_runtime_sha256: expectedRuntimeSha256,
    product_version: nonempty(value.product_version, "product version"),
  });
}

function normalizeOriginalIdentity(value) {
  exactKeys(value, ["content_sha256", "byte_count"], "original identity");
  return deepFreeze({
    content_sha256: hash(value.content_sha256, "original content hash"),
    byte_count: byteCount(value.byte_count, "original byte count"),
  });
}

function normalizeEnvelopeIdentity(value, invocation) {
  exactKeys(value, [
    "source_type",
    "source_id",
    "doc_uid",
    "envelope_sha256",
    "content_sha256",
    "content_byte_count",
  ], "envelope identity");
  const expectedDocUid = `${invocation.source}:${invocation.file}`;
  if (value.source_type !== invocation.source || value.source_id !== invocation.file ||
      value.doc_uid !== expectedDocUid) {
    throw new TypeError("envelope identity is not the one requested source-relative file");
  }
  return deepFreeze({
    source_type: value.source_type,
    source_id: value.source_id,
    doc_uid: value.doc_uid,
    envelope_sha256: hash(value.envelope_sha256, "envelope fingerprint"),
    content_sha256: hash(value.content_sha256, "envelope content hash"),
    content_byte_count: byteCount(value.content_byte_count, "envelope content byte count"),
  });
}

function normalizeBoundary(value) {
  const normalized = normalizeJson(value, "exact local boundary");
  if (canonical(normalized) !== canonical(EXACT_LOCAL_BOUNDARY_VALUE)) {
    throw new TypeError("local context did not prove the exact one-file boundary");
  }
  return deepFreeze(normalized);
}

function normalizeEnvelope(value, invocation, original, identity) {
  const normalized = normalizeJson(value, "prepared envelope");
  if (!plainObject(normalized) || normalized.source_type !== invocation.source ||
      normalized.source_id !== invocation.file || normalized.text_source !== "native" ||
      normalized.text_reliable !== true || typeof normalized.content !== "string" ||
      !normalized.content.trim() || normalized.content.normalize("NFC") !== normalized.content ||
      Object.hasOwn(normalized, "envelopes") || Object.hasOwn(normalized, "ocr")) {
    throw new TypeError("exact file did not produce one native reliable envelope");
  }
  const receipt = normalized.source_original_receipt;
  if (!plainObject(receipt) || receipt.version !== 1 ||
      receipt.locator_kind !== "source_relative_path" ||
      receipt.original_content_sha256 !== original.content_sha256 ||
      receipt.original_byte_count !== original.byte_count) {
    throw new TypeError("prepared envelope is not bound to the exact original bytes");
  }
  const contentBytes = encoder.encode(normalized.content);
  if (sha256(contentBytes) !== identity.content_sha256 ||
      contentBytes.length !== identity.content_byte_count ||
      sha256Canonical(normalized) !== identity.envelope_sha256) {
    throw new TypeError("prepared envelope changed after its identity was captured");
  }
  return deepFreeze(normalized);
}

function normalizeQuery(value) {
  if (typeof value !== "string" || !value || value !== value.trim() ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value) ||
      encoder.encode(value).length > MAX_QUERY_BYTES) {
    throw new TypeError("exact file needs one bounded canonical private retrieval query");
  }
  return value;
}

function normalizedPlanInput(input) {
  if (!plainObject(input) || !plainObject(input.invocation)) {
    throw new TypeError("first-source plan needs one exact input");
  }
  const invocation = deepFreeze({
    manifest: nonempty(input.invocation.manifest, "manifest path"),
    source: SOURCE_RE.test(String(input.invocation.source || ""))
      ? input.invocation.source
      : (() => { throw new TypeError("source must be one canonical manifest source id"); })(),
    file: canonicalFirstSourceFileLocator(input.invocation.file),
    expectedRuntimeSha256: hash(
      input.invocation.expectedRuntimeSha256,
      "expected runtime SHA-256",
    ),
  });
  const architectureIdentity = normalizeArchitecture(input.architectureIdentity);
  const manifestIdentity = normalizeManifestIdentity(input.manifestIdentity);
  const rootIdentity = normalizeRootIdentity(input.rootIdentity);
  const fileIdentity = normalizeFileIdentity(input.fileIdentity);
  const runtimeIdentity = normalizeRuntimeIdentity(input.runtimeIdentity, invocation);
  const originalIdentity = normalizeOriginalIdentity(input.originalIdentity);
  const envelopeIdentity = normalizeEnvelopeIdentity(input.envelopeIdentity, invocation);
  if (fileIdentity.byte_count !== originalIdentity.byte_count) {
    throw new TypeError("exact file size does not match the original-byte receipt");
  }
  const envelope = normalizeEnvelope(input.envelope, invocation, originalIdentity, envelopeIdentity);
  const retrievalQuery = normalizeQuery(input.retrievalQuery);
  const boundary = normalizeBoundary(input.boundary);
  return deepFreeze({
    invocation,
    architectureIdentity,
    manifestIdentity,
    rootIdentity,
    fileIdentity,
    runtimeIdentity,
    originalIdentity,
    envelopeIdentity,
    envelope,
    retrievalQuery,
    boundary,
  });
}

function buildPlanFromNormalized(input) {
  const bindings = deepFreeze({
    invocation: digestId(input.invocation),
    manifest: digestId(input.manifestIdentity),
    root: digestId(input.rootIdentity),
    file: digestId(input.fileIdentity),
    runtime: digestId(input.runtimeIdentity),
    architecture: digestId(input.architectureIdentity),
    original: digestId(input.originalIdentity),
    envelope: digestId(input.envelopeIdentity),
    prepared_envelope: digestId(input.envelope),
    retrieval_query: digestId({ query: input.retrievalQuery }),
    local_boundary: digestId(input.boundary),
  });
  const approvalFingerprint = sha256Canonical({
    domain: "financial-brain:first-source-file:approval:v1",
    contract_version: FIRST_SOURCE_FILE_CONTRACT_VERSION,
    operation: "first-source-file",
    bindings,
    effects: EFFECT_EXCLUSIONS_VALUE,
  });
  return deepFreeze({
    schema_version: FIRST_SOURCE_FILE_CONTRACT_VERSION,
    operation: "first-source-file",
    status: "ready_for_approval",
    approval_fingerprint: approvalFingerprint,
    run_id: `fsf_${approvalFingerprint.slice(0, 48)}`,
    bindings,
    scope: {
      kind: "one_exact_local_file",
      file_count: 1,
      whole_source_complete: false,
    },
    effects: { ...EFFECT_EXCLUSIONS_VALUE },
  });
}

/**
 * Pure approval plan. Every supplied identity is reduced to an opaque digest;
 * no path, locator, query, content, or configured source id is returned.
 */
export function buildFirstSourceFilePlan(input) {
  return buildPlanFromNormalized(normalizedPlanInput(input));
}

function requiredCallback(dependencies, name) {
  const callback = dependencies?.[name];
  if (typeof callback !== "function") {
    throw new TypeError(`first-source file requires injected ${name}`);
  }
  return callback;
}

function proofState(completed = []) {
  const stages = new Set(completed);
  const familyCurrent = stages.has("result_family_verified");
  return deepFreeze({
    received: stages.has("exact_item_received"),
    saved: familyCurrent,
    search_ready: familyCurrent,
    answer_checked: familyCurrent,
  });
}

function receiptBase(mode) {
  return {
    schema_version: FIRST_SOURCE_FILE_CONTRACT_VERSION,
    operation: "first-source-file",
    mode,
    scope: {
      kind: "one_exact_local_file",
      file_count: 1,
      whole_source_complete: false,
    },
    effects: { ...EFFECT_EXCLUSIONS_VALUE },
    privacy: {
      manifest_path_printed: false,
      source_id_printed: false,
      file_locator_printed: false,
      retrieval_query_printed: false,
      content_printed: false,
    },
  };
}

function previewReceipt(plan) {
  return deepFreeze({
    ...receiptBase("preview"),
    status: "ready_for_approval",
    complete: false,
    approval_fingerprint: plan.approval_fingerprint,
    proof: proofState(),
  });
}

function incompleteReceipt(mode, stage, completed) {
  return deepFreeze({
    ...receiptBase(mode),
    status: "incomplete",
    complete: false,
    failed_stage: stage,
    completed_stages: [...completed],
    proof: proofState(completed),
  });
}

export class FirstSourceFileError extends Error {
  constructor(mode, stage, completed = [], privateCause = null) {
    super(`First-source exact-file ${mode} stopped at ${stage}. No broader source claim was made.`);
    this.name = "FirstSourceFileError";
    this.code = "FIRST_SOURCE_FILE_INCOMPLETE";
    this.stage = stage;
    this.receipt = incompleteReceipt(mode, stage, completed);
    Object.defineProperty(this, "privateCause", {
      value: privateCause,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

async function architectureGate(mode, dependencies) {
  try {
    return normalizeArchitecture(await requiredCallback(dependencies, "inspectArchitecture")());
  } catch (error) {
    if (error instanceof FirstSourceFileError) throw error;
    throw new FirstSourceFileError(mode, "windows_x64_gate", [], error);
  }
}

async function acquireLease(mode, invocation, dependencies) {
  try {
    const lease = await requiredCallback(dependencies, "acquireSourceLease")({
      manifest: invocation.manifest,
      source: invocation.source,
      file: invocation.file,
      expectedRuntimeSha256: invocation.expectedRuntimeSha256,
    });
    if (!plainObject(lease) || typeof lease.assertOwned !== "function" ||
        typeof lease.release !== "function" || !SHA256_RE.test(String(lease.fingerprint || ""))) {
      throw new TypeError("source lease did not provide its exact ownership contract");
    }
    return lease;
  } catch (error) {
    if (error instanceof FirstSourceFileError) throw error;
    throw new FirstSourceFileError(mode, "source_lease", [], error);
  }
}

async function openReadOnlySnapshot(invocation, dependencies) {
  try {
    const snapshot = await requiredCallback(dependencies, "openReadOnlySnapshot")({
      manifest: invocation.manifest,
      source: invocation.source,
      file: invocation.file,
      expectedRuntimeSha256: invocation.expectedRuntimeSha256,
    });
    if (!plainObject(snapshot) || snapshot.read_only !== true ||
        typeof snapshot.assertCurrent !== "function" || typeof snapshot.close !== "function" ||
        !SHA256_RE.test(String(snapshot.fingerprint || ""))) {
      throw new TypeError("preview snapshot did not provide a read-only stability contract");
    }
    return {
      fingerprint: snapshot.fingerprint,
      assertOwned: snapshot.assertCurrent,
      release: snapshot.close,
    };
  } catch (error) {
    if (error instanceof FirstSourceFileError) throw error;
    throw new FirstSourceFileError("preview", "read_only_snapshot", [], error);
  }
}

async function exactContext(mode, invocation, architectureIdentity, lease, dependencies) {
  try {
    await lease.assertOwned();
    const raw = await requiredCallback(dependencies, "loadExactContext")({
      manifest: invocation.manifest,
      source: invocation.source,
      file: invocation.file,
      expectedRuntimeSha256: invocation.expectedRuntimeSha256,
      architectureIdentity,
      assertOwned: lease.assertOwned,
    });
    await lease.assertOwned();
    if (!plainObject(raw) || !Array.isArray(raw.envelopes) || raw.envelopes.length !== 1) {
      throw new TypeError("local context must contain exactly one prepared envelope");
    }
    const normalized = normalizedPlanInput({
      invocation,
      architectureIdentity,
      manifestIdentity: raw.manifestIdentity,
      rootIdentity: raw.rootIdentity,
      fileIdentity: raw.fileIdentity,
      runtimeIdentity: raw.runtimeIdentity,
      originalIdentity: raw.originalIdentity,
      envelopeIdentity: raw.envelopeIdentity,
      envelope: raw.envelopes[0],
      retrievalQuery: raw.retrievalQuery,
      boundary: raw.boundary,
    });
    return deepFreeze({
      ...normalized,
      plan: buildPlanFromNormalized(normalized),
      lease_fingerprint: lease.fingerprint,
    });
  } catch (error) {
    if (error instanceof FirstSourceFileError) throw error;
    throw new FirstSourceFileError(mode, "exact_file_context", [], error);
  }
}

function approvalsEqual(left, right) {
  if (!SHA256_RE.test(String(left || "")) || !SHA256_RE.test(String(right || ""))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Read-only preview. Architecture is checked first, then a no-write snapshot
 * guard fences the local reads. The mutating source lease is apply-only.
 */
export async function previewFirstSourceFile(input, dependencies = {}) {
  const invocation = normalizeInvocation(input, "preview");
  const architectureIdentity = await architectureGate("preview", dependencies);
  const snapshot = await openReadOnlySnapshot(invocation, dependencies);
  try {
    const context = await exactContext("preview", invocation, architectureIdentity, snapshot, dependencies);
    await snapshot.assertOwned();
    return previewReceipt(context.plan);
  } catch (error) {
    if (error instanceof FirstSourceFileError) throw error;
    throw new FirstSourceFileError("preview", "exact_file_context", [], error);
  } finally {
    await snapshot.release();
  }
}

function validateIngestResult(value, context) {
  if (!plainObject(value) || !Array.isArray(value.results) || value.results.length !== 1 ||
      !Number.isSafeInteger(value.created) || !Number.isSafeInteger(value.updated) ||
      !Number.isSafeInteger(value.unchanged) || value.created < 0 || value.updated < 0 ||
      value.unchanged < 0 || value.created + value.updated + value.unchanged !== 1 ||
      value.refused !== 0 || value.failed !== 0) {
    throw new TypeError("ingest did not return one exact accepted item");
  }
  const result = value.results[0];
  const expected = context.envelopeIdentity;
  if (!plainObject(result) || result.source_type !== expected.source_type ||
      result.source_id !== expected.source_id || result.doc_uid !== expected.doc_uid ||
      !["created", "updated", "unchanged"].includes(result.status) ||
      value[result.status] !== 1) {
    throw new TypeError("ingest receipt does not match the exact approved item");
  }
  return deepFreeze({ outcome: result.status, exact_result_count: 1 });
}

// Validate the read-only inventory itself instead of accepting a boolean from
// the adapter. This cannot authorize registration or repair a missing source.
function validateSourceRegistration(value, source) {
  if (!plainObject(value) || value.contract_version !== 3 || value.kind !== "source_inventory" ||
      value.complete !== true || value.truncated !== false || value.cursor !== null ||
      !Array.isArray(value.sources) || !Number.isSafeInteger(value.returned) ||
      !Number.isSafeInteger(value.total) || value.returned !== value.sources.length ||
      value.total !== value.sources.length || !plainObject(value.snapshot) ||
      value.snapshot.stable !== true || !SHA256_ID_RE.test(String(value.snapshot.id || ""))) {
    throw new TypeError("source registration verification was not one complete stable read-only inventory");
  }
  const selected = value.sources.filter((row) => plainObject(row) &&
    (row.source_id === source || row.name === source));
  if (selected.length !== 1 || selected[0].name !== source || selected[0].kind !== "upload" ||
      selected[0].registered !== true) {
    throw new TypeError("the exact source is not one pre-existing registered upload source");
  }
  return deepFreeze({
    source_snapshot_id: value.snapshot.id,
    source_registration_id: digestId(selected[0]),
  });
}

function validateFamilyCore(value, operation) {
  if (!plainObject(value) || value.contract_version !== 1 || value.mode !== "result_family" ||
      value.operation !== operation || !SOURCE_RE.test(String(value.source || "")) ||
      !ORIGINAL_ID_RE.test(String(value.original_id || "")) ||
      !SHA256_ID_RE.test(String(value.family_receipt_hash || "")) ||
      !SHA256_ID_RE.test(String(value.verification_hash || "")) ||
      value.document_count !== 1 || !Number.isSafeInteger(value.chunk_count) ||
      value.chunk_count < 1 || value.accepted_outcome_authorized !== false) {
    throw new TypeError("result-family receipt did not prove the exact saved item");
  }
  if (operation === "record") {
    if (typeof value.recorded !== "boolean" || typeof value.replayed !== "boolean" ||
        value.recorded === value.replayed) {
      throw new TypeError("result-family record was neither one record nor one exact replay");
    }
  } else if (value.recorded !== false || value.replayed !== true) {
    throw new TypeError("result-family verification did not replay the recorded exact proof");
  }
}

function validateFamilySearch(value) {
  if (!SHA256_ID_RE.test(String(value.vector_readiness_hash || ""))) {
    throw new TypeError("result-family receipt did not prove Search ready");
  }
}

function validateFamilyAnswer(value) {
  if (!PROBE_ID_RE.test(String(value.retrieval_probe_id || "")) ||
      value.retrieval_status !== "deterministic" || value.citation_status !== "same_family") {
    throw new TypeError("result-family receipt did not prove Answer checked");
  }
}

function validateFamilyResponse(value, operation, source, record = null) {
  validateFamilyCore(value, operation);
  if (value.source !== source) throw new TypeError("result-family receipt changed source");
  validateFamilySearch(value);
  validateFamilyAnswer(value);
  const normalized = deepFreeze({
    original_id: value.original_id,
    family_receipt_hash: value.family_receipt_hash,
    verification_hash: value.verification_hash,
    document_count: value.document_count,
    chunk_count: value.chunk_count,
    vector_readiness_hash: value.vector_readiness_hash,
    retrieval_probe_id: value.retrieval_probe_id,
    retrieval_status: value.retrieval_status,
    citation_status: value.citation_status,
  });
  if (record && canonical(normalized) !== canonical(record)) {
    throw new TypeError("result-family verification does not match the recorded exact proof");
  }
  return normalized;
}

async function guardedApplyCall(stage, context, completed, callback, payload) {
  try {
    await context.assertOwned();
    const result = await callback(payload);
    await context.assertOwned();
    return result;
  } catch (error) {
    if (error instanceof FirstSourceFileError) throw error;
    throw new FirstSourceFileError("apply", stage, completed, error);
  }
}

function readBoundedTime(dependencies) {
  const readTime = dependencies?.readMonotonicTime ?? Date.now;
  if (typeof readTime !== "function") {
    throw new TypeError("first-source passive readiness needs an injected monotonic clock");
  }
  const value = readTime();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("first-source passive readiness clock returned an invalid value");
  }
  return value;
}

function recordAttemptContext(attempt, remainingTimeoutMs) {
  return deepFreeze({
    attempt,
    max_attempts: PASSIVE_READINESS_POLICY_VALUE.max_attempts,
    request_timeout_ms: Math.min(
      PASSIVE_READINESS_POLICY_VALUE.attempt_timeout_ms,
      remainingTimeoutMs,
    ),
    remaining_timeout_ms: remainingTimeoutMs,
  });
}

function privateCause(error) {
  return error instanceof FirstSourceFileError ? error.privateCause : error;
}

function exactVectorUnready(error) {
  return privateCause(error)?.code === PASSIVE_READINESS_POLICY_VALUE.retryable_error_code;
}

function unrelatedVectorBacklog(error) {
  return privateCause(error)?.code === RESULT_FAMILY_UNRELATED_BACKLOG_CODE;
}

async function recordFamilyWithPassiveReadiness(context, completed, dependencies, payload) {
  // The Worker may briefly refuse the proof while the already-enqueued exact
  // item becomes query-visible. Only that one refusal is retryable. Waiting is
  // injected and lease-guarded; this core never drains or reingests anything.
  const callback = requiredCallback(dependencies, "recordResultFamily");
  let wait = null;
  let lastVectorUnready = null;
  let startedAt;
  try {
    startedAt = readBoundedTime(dependencies);
  } catch (error) {
    throw new FirstSourceFileError("apply", "result_family_readiness_clock", completed, error);
  }
  const deadline = startedAt + PASSIVE_READINESS_POLICY_VALUE.wall_clock_timeout_ms;
  if (!Number.isSafeInteger(deadline)) {
    throw new FirstSourceFileError(
      "apply",
      "result_family_readiness_clock",
      completed,
      new TypeError("first-source passive readiness deadline is invalid"),
    );
  }

  for (let attempt = 1; attempt <= PASSIVE_READINESS_POLICY_VALUE.max_attempts; attempt += 1) {
    let remainingTimeoutMs;
    try {
      remainingTimeoutMs = deadline - readBoundedTime(dependencies);
    } catch (error) {
      throw new FirstSourceFileError("apply", "result_family_readiness_clock", completed, error);
    }
    if (remainingTimeoutMs <= 0) {
      throw new FirstSourceFileError(
        "apply",
        "result_family_readiness_timeout",
        completed,
        lastVectorUnready,
      );
    }

    try {
      return await guardedApplyCall(
        "result_family_record",
        context,
        completed,
        callback,
        {
          ...payload,
          readinessPolicy: deepFreeze({ ...PASSIVE_READINESS_POLICY_VALUE }),
          attemptContext: recordAttemptContext(attempt, remainingTimeoutMs),
        },
      );
    } catch (error) {
      if (unrelatedVectorBacklog(error) || exactVectorUnready(error)) {
        try {
          await context.assertOwned();
        } catch (leaseError) {
          throw new FirstSourceFileError(
            "apply",
            "result_family_record",
            completed,
            leaseError,
          );
        }
      }
      if (unrelatedVectorBacklog(error)) {
        throw new FirstSourceFileError(
          "apply",
          "result_family_unrelated_backlog",
          completed,
          privateCause(error),
        );
      }
      if (!exactVectorUnready(error)) throw error;
      lastVectorUnready = privateCause(error);
      if (attempt === PASSIVE_READINESS_POLICY_VALUE.max_attempts) {
        throw new FirstSourceFileError(
          "apply",
          "result_family_readiness_timeout",
          completed,
          lastVectorUnready,
        );
      }

      let waitRemaining;
      try {
        waitRemaining = deadline - readBoundedTime(dependencies);
      } catch (clockError) {
        throw new FirstSourceFileError(
          "apply",
          "result_family_readiness_clock",
          completed,
          clockError,
        );
      }
      if (waitRemaining <= 0) {
        throw new FirstSourceFileError(
          "apply",
          "result_family_readiness_timeout",
          completed,
          lastVectorUnready,
        );
      }
      if (wait === null) {
        try {
          wait = requiredCallback(dependencies, "passiveReadinessWait");
        } catch (waitError) {
          throw new FirstSourceFileError(
            "apply",
            "result_family_readiness_wait",
            completed,
            waitError,
          );
        }
      }
      await guardedApplyCall(
        "result_family_readiness_wait",
        context,
        completed,
        wait,
        {
          waitMs: Math.min(PASSIVE_READINESS_POLICY_VALUE.wait_interval_ms, waitRemaining),
          completedAttempts: attempt,
          retryableErrorCode: PASSIVE_READINESS_POLICY_VALUE.retryable_error_code,
          assertOwned: context.assertOwned,
        },
      );
    }
  }

  throw new FirstSourceFileError(
    "apply",
    "result_family_readiness_timeout",
    completed,
    lastVectorUnready,
  );
}

function familyRequest(context, operation) {
  return deepFreeze({
    contract_version: 1,
    mode: "result_family",
    operation,
    source: context.invocation.source,
    locator_kind: "source_relative_path",
    locator: context.invocation.file,
    original_content_sha256: context.originalIdentity.content_sha256,
    original_byte_count: context.originalIdentity.byte_count,
    retrieval_query: context.retrievalQuery,
  });
}

function successReceipt(plan, ingest) {
  return deepFreeze({
    ...receiptBase("apply"),
    status: "same_item_proved",
    complete: true,
    approval_fingerprint: plan.approval_fingerprint,
    ingest,
    proof: {
      received: true,
      saved: true,
      search_ready: true,
      answer_checked: true,
      result_family_recorded: true,
      result_family_verified: true,
    },
  });
}

/**
 * Apply only after recomputing the exact local cut under its source lease and
 * matching the preview fingerprint. Credential and network callbacks cannot
 * run before that comparison succeeds.
 */
export async function applyFirstSourceFile(input, dependencies = {}) {
  const invocation = normalizeInvocation(input, "apply");
  const architectureIdentity = await architectureGate("apply", dependencies);
  const lease = await acquireLease("apply", invocation, dependencies);
  const completed = [];
  try {
    const privateContext = await exactContext("apply", invocation, architectureIdentity, lease, dependencies);
    const context = { ...privateContext, assertOwned: lease.assertOwned };
    if (!approvalsEqual(privateContext.plan.approval_fingerprint, invocation.approve)) {
      throw new FirstSourceFileError("apply", "approval_recheck", completed);
    }

    let adminAccess;
    try {
      await lease.assertOwned();
      adminAccess = await requiredCallback(dependencies, "resolveAdminAccess")({
        manifest: invocation.manifest,
        source: invocation.source,
        approvalFingerprint: invocation.approve,
        assertOwned: lease.assertOwned,
      });
      await lease.assertOwned();
      if (adminAccess === null || adminAccess === undefined) {
        throw new TypeError("admin access was unavailable");
      }
    } catch (error) {
      throw new FirstSourceFileError("apply", "credential_access", completed, error);
    }

    try {
      const raw = await guardedApplyCall(
        "source_registration_verify",
        context,
        completed,
        requiredCallback(dependencies, "verifySourceRegistration"),
        {
          source: invocation.source,
          policy: deepFreeze({ ...SOURCE_REGISTRATION_POLICY_VALUE }),
          adminAccess,
          assertOwned: lease.assertOwned,
        },
      );
      validateSourceRegistration(raw, invocation.source);
    } catch (error) {
      if (error instanceof FirstSourceFileError) throw error;
      throw new FirstSourceFileError("apply", "source_registration_verify", completed, error);
    }
    completed.push("source_registration_verified");

    let ingest;
    try {
      const raw = await guardedApplyCall(
        "exact_item_received",
        context,
        completed,
        requiredCallback(dependencies, "ingestExact"),
        {
          envelope: privateContext.envelope,
          runId: privateContext.plan.run_id,
          approvalFingerprint: invocation.approve,
          adminAccess,
          assertOwned: lease.assertOwned,
        },
      );
      ingest = validateIngestResult(raw, privateContext);
    } catch (error) {
      if (error instanceof FirstSourceFileError) throw error;
      throw new FirstSourceFileError("apply", "exact_item_received", completed, error);
    }
    completed.push("exact_item_received");

    let record;
    try {
      const raw = await recordFamilyWithPassiveReadiness(
        context,
        completed,
        dependencies,
        {
          request: familyRequest(privateContext, "record"),
          approvalFingerprint: invocation.approve,
          adminAccess,
          assertOwned: lease.assertOwned,
        },
      );
      record = validateFamilyResponse(raw, "record", invocation.source);
    } catch (error) {
      if (error instanceof FirstSourceFileError) throw error;
      throw new FirstSourceFileError("apply", "result_family_record", completed, error);
    }
    completed.push("result_family_recorded");

    try {
      const raw = await guardedApplyCall(
        "result_family_verify",
        context,
        completed,
        requiredCallback(dependencies, "verifyResultFamily"),
        {
          request: familyRequest(privateContext, "verify"),
          approvalFingerprint: invocation.approve,
          recordReceipt: record,
          adminAccess,
          assertOwned: lease.assertOwned,
        },
      );
      validateFamilyResponse(raw, "verify", invocation.source, record);
    } catch (error) {
      if (error instanceof FirstSourceFileError) throw error;
      throw new FirstSourceFileError("apply", "result_family_verify", completed, error);
    }
    completed.push("result_family_verified");
    return successReceipt(privateContext.plan, ingest);
  } catch (error) {
    if (error instanceof FirstSourceFileError) throw error;
    throw new FirstSourceFileError("apply", "apply_orchestration", completed, error);
  } finally {
    await lease.release();
  }
}

/** Dispatch one already strictly parsed invocation. */
export async function runFirstSourceFile(input, dependencies = {}) {
  return input?.apply === true
    ? applyFirstSourceFile(input, dependencies)
    : previewFirstSourceFile(input, dependencies);
}

export function renderFirstSourceFileReceipt(receipt) {
  if (!plainObject(receipt) || receipt.operation !== "first-source-file") {
    throw new TypeError("first-source exact-file receipt is invalid");
  }
  if (receipt.mode === "preview" && receipt.status === "ready_for_approval") {
    return [
      "One exact local file is ready for explicit approval.",
      `Approval fingerprint: ${receipt.approval_fingerprint}`,
      "No credential, network, whole-source, removal, drain, state, or scheduling action ran.",
    ].join("\n");
  }
  if (receipt.complete === true && receipt.status === "same_item_proved") {
    return [
      "The approved file completed the same-item proof.",
      "Received, Saved, Search ready, and Answer checked are all proved.",
      "This does not claim whole-source completion or infer any removal.",
    ].join("\n");
  }
  return [
    "The first-source exact-file run is incomplete.",
    `It stopped at ${receipt.failed_stage}. No broader source claim was made.`,
  ].join("\n");
}

export const FIRST_SOURCE_FILE_EFFECT_EXCLUSIONS = deepFreeze({ ...EFFECT_EXCLUSIONS_VALUE });
export const FIRST_SOURCE_FILE_EXACT_LOCAL_BOUNDARY = deepFreeze({ ...EXACT_LOCAL_BOUNDARY_VALUE });
export const FIRST_SOURCE_FILE_SOURCE_REGISTRATION_POLICY = deepFreeze({
  ...SOURCE_REGISTRATION_POLICY_VALUE,
});
export const FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY = deepFreeze({
  ...PASSIVE_READINESS_POLICY_VALUE,
});
export const FIRST_SOURCE_FILE_RESULT_FAMILY_UNRELATED_BACKLOG_CODE =
  RESULT_FAMILY_UNRELATED_BACKLOG_CODE;
