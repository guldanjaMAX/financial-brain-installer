#!/usr/bin/env node
/**
 * Sealed live transport for the exact v0.4.8 disposable recovery source.
 *
 * The corpus lives only in disposable-recovery-seeder.mjs. This runner accepts
 * no content or source selector, reserves an owner-only ambiguity marker before
 * any credential/provider boundary, and persists only the strict aggregate
 * receipt validated by that module. It provisions, deploys, deletes, repairs,
 * reindexes, and releases nothing.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAdminKey } from "../brain.mjs";
import {
  assertExactBrainResponseOrigin,
  fetchBrainWithAdminKey,
} from "../components/brain-http.mjs";
import {
  captureRecoveryD1ContentFingerprint,
  inspectRecoveryWranglerWrapper,
  inspectDisposableRecoverySeedPreparation,
  readStablePrivateFileRecord,
  stablePrivateFileRecord,
} from "./cloudflare-recovery-adapter.mjs";
import {
  DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION,
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  DISPOSABLE_RECOVERY_SEED_PROTOCOL,
  assertDisposableRecoverySeedBinding,
  assertDisposableRecoverySeedReceipt,
  assertDisposableRecoverySeedResumeState,
  disposableRecoveryFixture,
  seedDisposableRecoveryFixture,
} from "./disposable-recovery-seeder.mjs";
import { keychainChildEnvironment } from "./admin-key-persistence.mjs";
import {
  LOCKED_WRANGLER_VERSION,
  assertMaterializedWranglerRuntimeUnchanged,
  materializeLockedWranglerRuntime,
} from "./locked-wrangler-runtime.mjs";
import {
  abandonPrivateAggregateReceipt,
  assertNoDarwinReceiptAcl,
  assertPrivateAggregateReceiptDirectory,
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptPendingPath,
  readPrivateAggregateReceipt,
  reservePrivateAggregateReceipt,
  resumePrivateAggregateReceiptReservation,
  syncPrivateReceiptDirectory,
  validatePrivateAggregateReceiptReservation,
} from "./private-aggregate-receipt.mjs";
import {
  inspectVerifiedRecoverySourceManifestBinding,
  loadVerifiedRecoveryPlan,
} from "./verified-recovery.mjs";

const RECEIPT_NAME = "v048-disposable-seed-receipt.json";
const RESUME_NAME = "v048-disposable-seed-resume.json";
const SOURCE_RESOURCE = "brain-test-v048-field-source-recovery-gate-a48f1101";
const CLIENT_SLUG = "v048-field-proof";
const CLIENT_DISPLAY_NAME = "Synthetic Field Gate v0.4.8";
const SCHEMA_VERSION = 46;
const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_DRAIN_ROUNDS = 20_000;
const REFUSAL = "The documents do not answer the question.";
const SUPPORTED_QUERY = "What is the stable v0.4.8 orchid ledger field marker?";
const UNSUPPORTED_QUERY = "What exact recipe describes the cobalt glacier souffle?";
const DIRECT_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM documents) AS document_count,
  (SELECT COUNT(*) FROM chunks) AS chunk_count,
  (SELECT COUNT(*) FROM chunks_fts) AS fts_count,
  (SELECT COUNT(*) FROM vector_outbox) AS pending_outbox,
  (SELECT COUNT(*) FROM vector_outbox
    WHERE attempts > 0 AND last_error IS NOT NULL) AS failed_vectors`;

export class DisposableRecoveryFieldSeedError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldSeedError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldSeedError(code);
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value;
}

function count(value, code) {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) refuse(code);
  return number;
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

function exactKeys(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

const RESUME_ACTIONS = new Set([
  "reserve_final_receipt",
  "verify_opening_direct_d1",
  "verify_source_deployment",
  "verify_opening_inventory",
  "ingest_fixture_batch",
  "verify_seeded_inventory",
  "verification_replay_batch",
  "settle_projection",
  "verify_settled_inventory",
  "verify_independent_projection",
  "verify_retrieval",
  "capture_direct_d1_fingerprint",
  "verify_closing_inventory",
  "finalize_seed_receipt",
]);
const WRITE_ACTIONS = new Set([
  "ingest_fixture_batch",
  "verification_replay_batch",
]);
const SAFE_RESUME_STEP = "rerun_exact_approved_seed_command";
const AMBIGUOUS_RESUME_STEP =
  "do_not_retry_pending_batch; technician_must_reconcile_or_recreate_disposable_destination";
const COMPLETE_RESUME_STEP = "use_exact_verified_seed_receipt";

function resumeIdentity(binding) {
  const checked = assertDisposableRecoverySeedBinding(binding);
  return Object.freeze({
    schema_version: 1,
    candidate_sha: checked.candidate_sha,
    package_sha256: checked.package_sha256,
    field_receipt_sha256: checked.field_receipt_sha256,
    source_phase_receipt_sha256: checked.source_phase_receipt_sha256,
    seed_execution_approval_fingerprint: checked.execution_approval_fingerprint,
    seed_binding_sha256: sha256(canonical(checked)),
    fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
    seed_receipt_protocol: DISPOSABLE_RECOVERY_SEED_PROTOCOL,
    seed_receipt_schema_version: 4,
  });
}

function resumableProgress(record) {
  return assertDisposableRecoverySeedResumeState({
    opening_empty_verified: record.opening_empty_verified,
    verified_completed_batch_prefix: record.verified_completed_batch_prefix,
    verified_completed_document_prefix: record.verified_completed_document_prefix,
    verified_replay_batch_prefix: record.verified_replay_batch_prefix,
    verified_replay_document_prefix: record.verified_replay_document_prefix,
  });
}

export function assertDisposableRecoverySeedResumeRecord(record, binding) {
  if (!exactKeys(record, [
    "schema_version", "kind", "status", "checkpoint_sequence", "identity",
    "opening_empty_verified",
    "verified_completed_batch_prefix", "verified_completed_document_prefix",
    "verified_replay_batch_prefix", "verified_replay_document_prefix",
    "pending_seed_action", "ambiguous_write_boundary", "next_actor",
    "safe_next_step", "final_seed_receipt_sha256",
  ]) || record.schema_version !== 1 ||
      record.kind !== "v048_disposable_recovery_seed_resume" ||
      !["execution_in_progress", "write_confirmation_ambiguous", "complete"]
        .includes(record.status) ||
      !Number.isSafeInteger(record.checkpoint_sequence) || record.checkpoint_sequence < 0 ||
      canonical(record.identity) !== canonical(resumeIdentity(binding))) {
    refuse("DISPOSABLE_RECOVERY_SEED_RESUME_INVALID");
  }
  const progress = resumableProgress(record);
  const ambiguity = record.ambiguous_write_boundary;
  if (ambiguity !== null) {
    if (!exactKeys(ambiguity, [
      "action", "batch_number", "document_prefix_start", "document_count",
    ]) || !WRITE_ACTIONS.has(ambiguity.action) ||
        !Number.isSafeInteger(ambiguity.batch_number) || ambiguity.batch_number < 1 ||
        ambiguity.batch_number > DISPOSABLE_RECOVERY_SEED_BATCHES ||
        !Number.isSafeInteger(ambiguity.document_prefix_start) ||
        !Number.isSafeInteger(ambiguity.document_count) || ambiguity.document_count < 1 ||
        ambiguity.document_prefix_start + ambiguity.document_count >
          DISPOSABLE_RECOVERY_SEED_DOCUMENTS) {
      refuse("DISPOSABLE_RECOVERY_SEED_RESUME_INVALID");
    }
    const expectedBatch = ambiguity.action === "ingest_fixture_batch"
      ? progress.verified_completed_batch_prefix + 1
      : progress.verified_replay_batch_prefix + 1;
    const expectedStart = ambiguity.action === "ingest_fixture_batch"
      ? progress.verified_completed_document_prefix
      : progress.verified_replay_document_prefix;
    const expectedCount = Math.min(
      DISPOSABLE_RECOVERY_SEED_BATCH_SIZE,
      DISPOSABLE_RECOVERY_SEED_DOCUMENTS - expectedStart,
    );
    if (ambiguity.batch_number !== expectedBatch ||
        ambiguity.document_prefix_start !== expectedStart ||
        ambiguity.document_count !== expectedCount) {
      refuse("DISPOSABLE_RECOVERY_SEED_RESUME_INVALID");
    }
  }
  if (record.status === "execution_in_progress") {
    if (!RESUME_ACTIONS.has(record.pending_seed_action) || ambiguity !== null ||
        record.next_actor !== "field_runner" || record.safe_next_step !== SAFE_RESUME_STEP ||
        record.final_seed_receipt_sha256 !== null) {
      refuse("DISPOSABLE_RECOVERY_SEED_RESUME_INVALID");
    }
  } else if (record.status === "write_confirmation_ambiguous") {
    if (!WRITE_ACTIONS.has(record.pending_seed_action) || ambiguity === null ||
        ambiguity.action !== record.pending_seed_action ||
        record.next_actor !== "technician" ||
        record.safe_next_step !== AMBIGUOUS_RESUME_STEP ||
        record.final_seed_receipt_sha256 !== null) {
      refuse("DISPOSABLE_RECOVERY_SEED_RESUME_INVALID");
    }
  } else if (record.pending_seed_action !== null || ambiguity !== null ||
      record.next_actor !== "none" || record.safe_next_step !== COMPLETE_RESUME_STEP ||
      progress.verified_completed_batch_prefix !== DISPOSABLE_RECOVERY_SEED_BATCHES ||
      progress.verified_replay_batch_prefix !== DISPOSABLE_RECOVERY_SEED_BATCHES ||
      !/^[a-f0-9]{64}$/u.test(String(record.final_seed_receipt_sha256 || ""))) {
    refuse("DISPOSABLE_RECOVERY_SEED_RESUME_INVALID");
  }
  return Object.freeze(structuredClone(record));
}

function initialResumeRecord(binding) {
  return assertDisposableRecoverySeedResumeRecord({
    schema_version: 1,
    kind: "v048_disposable_recovery_seed_resume",
    status: "execution_in_progress",
    checkpoint_sequence: 0,
    identity: resumeIdentity(binding),
    opening_empty_verified: false,
    verified_completed_batch_prefix: 0,
    verified_completed_document_prefix: 0,
    verified_replay_batch_prefix: 0,
    verified_replay_document_prefix: 0,
    pending_seed_action: "reserve_final_receipt",
    ambiguous_write_boundary: null,
    next_actor: "field_runner",
    safe_next_step: SAFE_RESUME_STEP,
    final_seed_receipt_sha256: null,
  }, binding);
}

function checkpointResumeRecord(previous, checkpoint, binding) {
  const progress = assertDisposableRecoverySeedResumeState({
    opening_empty_verified: checkpoint?.opening_empty_verified,
    verified_completed_batch_prefix: checkpoint?.verified_completed_batch_prefix,
    verified_completed_document_prefix: checkpoint?.verified_completed_document_prefix,
    verified_replay_batch_prefix: checkpoint?.verified_replay_batch_prefix,
    verified_replay_document_prefix: checkpoint?.verified_replay_document_prefix,
  });
  const ambiguous = checkpoint?.ambiguous_write_boundary ?? null;
  const record = {
    schema_version: 1,
    kind: "v048_disposable_recovery_seed_resume",
    status: ambiguous === null
      ? "execution_in_progress"
      : "write_confirmation_ambiguous",
    checkpoint_sequence: previous.checkpoint_sequence + 1,
    identity: resumeIdentity(binding),
    ...progress,
    pending_seed_action: checkpoint?.pending_seed_action,
    ambiguous_write_boundary: ambiguous,
    next_actor: ambiguous === null ? "field_runner" : "technician",
    safe_next_step: ambiguous === null ? SAFE_RESUME_STEP : AMBIGUOUS_RESUME_STEP,
    final_seed_receipt_sha256: null,
  };
  return assertDisposableRecoverySeedResumeRecord(record, binding);
}

function completeResumeRecord(previous, receiptSha256, binding) {
  return assertDisposableRecoverySeedResumeRecord({
    ...previous,
    status: "complete",
    checkpoint_sequence: previous.checkpoint_sequence + 1,
    pending_seed_action: null,
    ambiguous_write_boundary: null,
    next_actor: "none",
    safe_next_step: COMPLETE_RESUME_STEP,
    final_seed_receipt_sha256: receiptSha256,
  }, binding);
}

function resumeSummary(record) {
  return Object.freeze({
    status: record.status,
    pending_seed_action: record.pending_seed_action,
    verified_completed_batch_prefix: record.verified_completed_batch_prefix,
    verified_completed_document_prefix: record.verified_completed_document_prefix,
    verified_replay_batch_prefix: record.verified_replay_batch_prefix,
    verified_replay_document_prefix: record.verified_replay_document_prefix,
    ambiguous_write_boundary: record.ambiguous_write_boundary,
    next_actor: record.next_actor,
    safe_next_step: record.safe_next_step,
  });
}

function readBoundResumeRecord(path, binding) {
  try {
    const readback = readPrivateAggregateReceipt(path, {
      code: "DISPOSABLE_RECOVERY_SEED_RESUME_READBACK_FAILED",
    });
    return Object.freeze({
      ...readback,
      value: assertDisposableRecoverySeedResumeRecord(readback.value, binding),
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldSeedError) throw error;
    refuse("DISPOSABLE_RECOVERY_SEED_RESUME_READBACK_FAILED");
  }
}

function persistResumeRecord(path, record, binding, expectedSha256 = null) {
  const code = "DISPOSABLE_RECOVERY_SEED_RESUME_WRITE_FAILED";
  const absolute = resolve(path);
  let reservation = null;
  let stagingPath = null;
  try {
    const parent = assertPrivateAggregateReceiptDirectory(dirname(absolute), { code });
    if (absolute !== join(parent.path, RESUME_NAME)) refuse(code);
    if (expectedSha256 === null) {
      if (existsSync(absolute)) refuse(code);
    } else {
      const current = readBoundResumeRecord(absolute, binding);
      if (current.sha256 !== expectedSha256) refuse(code);
    }
    const checked = assertDisposableRecoverySeedResumeRecord(record, binding);
    stagingPath = join(
      parent.path,
      `.v048-disposable-seed-resume-${randomBytes(12).toString("hex")}.json`,
    );
    const output = assertPrivateAggregateOutputPath(stagingPath, { code });
    reservation = reservePrivateAggregateReceipt(output, {
      schema_version: 1,
      kind: "v048_disposable_recovery_seed_resume_update_pending",
      record_sha256: sha256(canonical(checked)),
    });
    finalizePrivateAggregateReceipt(reservation, checked);
    reservation = null;
    const staged = readPrivateAggregateReceipt(stagingPath, { code });
    if (canonical(staged.value) !== canonical(checked)) refuse(code);
    if (expectedSha256 === null) {
      if (existsSync(absolute)) refuse(code);
    } else if (readBoundResumeRecord(absolute, binding).sha256 !== expectedSha256) {
      refuse(code);
    }
    renameSync(stagingPath, absolute);
    stagingPath = null;
    const renamedInfo = lstatSync(absolute);
    syncPrivateReceiptDirectory(
      parent.path,
      parent.info,
      absolute,
      renamedInfo,
      code,
    );
    const final = readBoundResumeRecord(absolute, binding);
    if (canonical(final.value) !== canonical(checked)) refuse(code);
    return final;
  } catch (error) {
    if (reservation) abandonPrivateAggregateReceipt(reservation);
    if (error instanceof DisposableRecoveryFieldSeedError) throw error;
    throw new DisposableRecoveryFieldSeedError(code);
  }
}

function reservationMarker(binding) {
  const identity = resumeIdentity(binding);
  return Object.freeze({
    schema_version: 2,
    kind: "v048_disposable_recovery_seed_pending",
    status: "execution_in_progress",
    fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
    expected_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
    expected_batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
    identity,
    resume_record_kind: "v048_disposable_recovery_seed_resume",
  });
}

function withResumeSummary(error, record) {
  const wrapped = error && typeof error === "object"
    ? error
    : new DisposableRecoveryFieldSeedError("DISPOSABLE_RECOVERY_SEED_FAILED");
  try {
    Object.defineProperty(wrapped, "resume_record", {
      value: resumeSummary(record),
      enumerable: true,
      configurable: true,
    });
  } catch { /* the durable record remains authoritative */ }
  return wrapped;
}

function requireAmbiguousWriteReview(record) {
  throw withResumeSummary(
    new DisposableRecoveryFieldSeedError(
      "DISPOSABLE_RECOVERY_SEED_AMBIGUOUS_WRITE_REVIEW_REQUIRED",
    ),
    record,
  );
}

function readExistingSeedReceipt(path, binding) {
  try {
    const readback = readPrivateAggregateReceipt(path, {
      code: "DISPOSABLE_RECOVERY_SEED_RECEIPT_READBACK_FAILED",
    });
    assertDisposableRecoverySeedReceipt(readback.value);
    if (canonical(readback.value.binding) !== canonical(binding)) {
      refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_READBACK_FAILED");
    }
    return readback;
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldSeedError) throw error;
    refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_READBACK_FAILED");
  }
}

function readStablePrivateWrapper(path, expectedSha256) {
  try {
    const code = "DISPOSABLE_RECOVERY_SEED_WRANGLER_WRAPPER_INVALID";
    const checked = inspectRecoveryWranglerWrapper(path);
    if (checked.hash !== expectedSha256) {
      checked.raw.fill(0);
      refuse(code);
    }
    return checked;
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldSeedError) throw error;
    refuse("DISPOSABLE_RECOVERY_SEED_WRANGLER_WRAPPER_INVALID");
  }
}

function assertStablePrivateWrapper(pin) {
  try {
    const code = "DISPOSABLE_RECOVERY_SEED_WRANGLER_WRAPPER_CHANGED";
    const checked = readStablePrivateFileRecord(pin, {
      code,
      maxBytes: 64 * 1024,
      executable: true,
    });
    try { assertNoDarwinReceiptAcl(checked.path, checked.info, { code }); }
    finally { checked.raw.fill(0); }
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldSeedError) throw error;
    refuse("DISPOSABLE_RECOVERY_SEED_WRANGLER_WRAPPER_CHANGED");
  }
  return true;
}

function assertExactSourceCampaign(source) {
  const exact = (value, expected) => value === expected;
  const exactRuntime = (binding) =>
    binding?.embeddingModel === "@cf/baai/bge-base-en-v1.5" &&
    binding?.embeddingDimensions === 768 && binding?.chunkSize === "1500" &&
    binding?.chunkOverlap === "300" && binding?.dailyLlmCapUsd === "10" &&
    binding?.answerModel === "@cf/meta/llama-3.3-70b-instruct-fp8-fast" &&
    binding?.credentialScanner === "on" && binding?.ocrEnabled === "0" &&
    binding?.ocrModel === "@cf/google/gemma-4-26b-a4b-it";
  const noConnectors = (binding) => Array.isArray(binding?.enabledCorpora) &&
    binding.enabledCorpora.length === 0 && binding.bankFeedEnabled === false;
  const exactWorkerDomain = (binding, resource) => {
    const labels = String(binding?.domain || "").split(".");
    return labels[0] === resource && labels.length >= 4 &&
      labels.slice(-2).join(".") === "workers.dev";
  };
  if (!source ||
      !exact(source.clientSlug, CLIENT_SLUG) ||
      !exact(source.clientDisplayName, CLIENT_DISPLAY_NAME) ||
      !exact(source.productVersion, DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION) ||
      !exact(source.adminKeySecret, `keychain://${SOURCE_RESOURCE}/owner`) ||
      source.recoveryArtifactKeySecret !== null ||
      source.recoveryFieldGate !== null ||
      !exactRuntime(source) ||
      !noConnectors(source) ||
      ![source.workerName, source.databaseName, source.vectorizeIndex]
        .every((value) => value === SOURCE_RESOURCE) ||
      !exactWorkerDomain(source, SOURCE_RESOURCE)) {
    refuse("DISPOSABLE_RECOVERY_SEED_CAMPAIGN_INVALID");
  }
  return source;
}

function boundedJson(value, code) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PROVIDER_BYTES) {
    refuse(code);
  }
  try { return JSON.parse(value); } catch { refuse(code); }
}

function d1Rows(payload) {
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (envelopes.length !== 1 || !envelopes[0] || envelopes[0].success === false ||
      !Array.isArray(envelopes[0].results)) {
    refuse("DISPOSABLE_RECOVERY_SEED_D1_RESPONSE_INVALID");
  }
  return envelopes[0].results;
}

function syncDirectory(path) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(path, 0);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertPrivatePartial(path, parent) {
  const absolute = resolve(path);
  if (dirname(absolute) !== parent || !absolute.endsWith(".sql.partial")) {
    refuse("DISPOSABLE_RECOVERY_SEED_EXPORT_PATH_INVALID");
  }
  return absolute;
}

function validateHealth(body) {
  if (body?.ok !== true || body?.accepting_documents !== true || body?.status !== "ok" ||
      body?.version !== DISPOSABLE_RECOVERY_EXPECTED_WORKER_VERSION ||
      body?.brain !== CLIENT_SLUG || body?.vector_drain_mode !== "active" ||
      body?.schema_version !== SCHEMA_VERSION) {
    refuse("DISPOSABLE_RECOVERY_SEED_HEALTH_INVALID");
  }
  return true;
}

function validateSupported(body) {
  const marker = disposableRecoveryFixture()[0];
  if (body?.mode !== "think" || typeof body.answer !== "string" || !body.answer.trim() ||
      body.answer === REFUSAL || body.answer_error != null || !Array.isArray(body.citations) ||
      !body.citations.some((citation) => citation?.source === marker.source_type &&
        citation?.title === marker.title) || body.evidence_gate?.supported === false) {
    refuse("DISPOSABLE_RECOVERY_SEED_SUPPORTED_CASE_FAILED");
  }
  return true;
}

function validateUnsupported(body) {
  if (body?.mode !== "think" || body.answer !== REFUSAL || body.answer_error != null ||
      !Array.isArray(body.citations) || body.citations.length !== 0) {
    refuse("DISPOSABLE_RECOVERY_SEED_UNSUPPORTED_CASE_FAILED");
  }
  return true;
}

export function createDisposableRecoveryLiveTransports({
  source,
  seedBinding,
  sourcePhaseReceipt,
  sourcePhaseReceiptSha256,
  sourceManifestPath,
  receiptDirectory,
  wranglerWrapperPath,
  wranglerWrapperSha256,
  wranglerRuntime,
  beforeBoundary,
  fetchImpl = globalThis.fetch,
  runWrangler = (request) => spawnSync(request.command, request.args, request.options),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  resolveKey = (path) => resolveAdminKey(path, { ignoreEnvironment: true }),
  materializeWranglerRuntime = materializeLockedWranglerRuntime,
  assertMaterializedWranglerRuntime = assertMaterializedWranglerRuntimeUnchanged,
  environment = process.env,
}) {
  if (typeof fetchImpl !== "function" || typeof runWrangler !== "function" ||
      typeof sleep !== "function" || typeof resolveKey !== "function" ||
      typeof materializeWranglerRuntime !== "function" ||
      typeof assertMaterializedWranglerRuntime !== "function" ||
      !/^[a-f0-9]{64}$/u.test(String(wranglerWrapperSha256 || ""))) {
    refuse("DISPOSABLE_RECOVERY_SEED_TRANSPORT_INVALID");
  }
  const base = `https://${source.domain}`;
  let adminKey = null;
  let initialized = false;
  let wrapperVersionProven = false;

  const publicHealth = async () => {
    await beforeBoundary();
    let response;
    try { response = await fetchImpl(`${base}/health`, { redirect: "error" }); }
    catch { refuse("DISPOSABLE_RECOVERY_SEED_TRANSPORT_FAILED"); }
    assertExactBrainResponseOrigin(response, `${base}/health`);
    const text = await response.text();
    validateHealth(boundedJson(text, "DISPOSABLE_RECOVERY_SEED_HEALTH_INVALID"));
    await beforeBoundary();
  };

  const initialize = async () => {
    if (initialized) return;
    await publicHealth();
    await beforeBoundary();
    const value = await resolveKey(sourceManifestPath);
    await beforeBoundary();
    if (typeof value !== "string" || !/^[a-f0-9]{48}$/u.test(value)) {
      refuse("DISPOSABLE_RECOVERY_SEED_ADMIN_KEY_INVALID");
    }
    adminKey = value;
    initialized = true;
  };

  const request = async (path, { method = "GET", body } = {}) => {
    await initialize();
    await beforeBoundary();
    let response;
    try {
      response = await fetchBrainWithAdminKey(fetchImpl, `${base}${path}`, {
        method,
        redirect: "error",
        ...(body === undefined ? {} : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }, adminKey);
    } catch {
      refuse("DISPOSABLE_RECOVERY_SEED_TRANSPORT_FAILED");
    }
    assertExactBrainResponseOrigin(response, `${base}${path}`);
    const text = await response.text();
    const parsed = boundedJson(text, "DISPOSABLE_RECOVERY_SEED_RESPONSE_INVALID");
    await beforeBoundary();
    return Object.freeze({ status: response.status, body: parsed });
  };

  const wrangler = async (binding, args, { json = true } = {}) => {
    await beforeBoundary();
    const callDirectory = mkdtempSync(join(receiptDirectory, ".v048-seed-wrangler-"));
    if (process.platform !== "win32") chmodSync(callDirectory, 0o700);
    let result;
    let sourceWrapper = null;
    let executionWrapperPin = null;
    let materializedRuntime = null;
    try {
      mkdirSync(join(callDirectory, "logs"), { mode: 0o700 });
      sourceWrapper = readStablePrivateWrapper(wranglerWrapperPath, wranglerWrapperSha256);
      const executionWrapper = join(callDirectory, "wrangler-pinned");
      writeFileSync(executionWrapper, sourceWrapper.raw, { flag: "wx", mode: 0o700 });
      if (process.platform !== "win32") chmodSync(executionWrapper, 0o700);
      const pinnedWrapper = readStablePrivateWrapper(executionWrapper, wranglerWrapperSha256);
      executionWrapperPin = stablePrivateFileRecord(pinnedWrapper, null);
      pinnedWrapper.raw.fill(0);
      try {
        materializedRuntime = materializeWranglerRuntime(
          wranglerRuntime,
          join(callDirectory, "wrangler-runtime"),
        );
        assertMaterializedWranglerRuntime(materializedRuntime);
      } catch {
        refuse("DISPOSABLE_RECOVERY_SEED_WRANGLER_RUNTIME_INVALID");
      }
      await beforeBoundary();
      assertStablePrivateWrapper(executionWrapperPin);
      try { assertMaterializedWranglerRuntime(materializedRuntime); }
      catch { refuse("DISPOSABLE_RECOVERY_SEED_WRANGLER_RUNTIME_CHANGED"); }
      const env = {
        ...keychainChildEnvironment(environment),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
        CLOUDFLARE_ACCOUNT_ID: binding.accountId,
        WRANGLER_LOG: "log",
        WRANGLER_LOG_SANITIZE: "true",
        WRANGLER_LOG_PATH: join(callDirectory, "logs"),
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        BRAIN_RECOVERY_NODE: process.execPath,
        BRAIN_RECOVERY_WRANGLER_ENTRYPOINT: materializedRuntime.entrypointPath,
        BRAIN_RECOVERY_WRANGLER_RESOLUTION_GUARD: materializedRuntime.resolutionGuardPath,
      };
      result = runWrangler({
        command: executionWrapper,
        args,
        options: {
          cwd: callDirectory,
          env,
          encoding: "utf8",
          maxBuffer: MAX_PROVIDER_BYTES,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30 * 60 * 1000,
          windowsHide: true,
        },
      });
      assertStablePrivateWrapper(executionWrapperPin);
      try { assertMaterializedWranglerRuntime(materializedRuntime); }
      catch { refuse("DISPOSABLE_RECOVERY_SEED_WRANGLER_RUNTIME_CHANGED"); }
      await beforeBoundary();
      if (result?.status !== 0 || result?.signal || result?.error ||
          typeof result.stdout !== "string" || typeof result.stderr !== "string") {
        refuse("DISPOSABLE_RECOVERY_SEED_WRANGLER_FAILED");
      }
      return json
        ? boundedJson(result.stdout, "DISPOSABLE_RECOVERY_SEED_WRANGLER_RESPONSE_INVALID")
        : result.stdout;
    } finally {
      sourceWrapper?.raw.fill(0);
      rmSync(callDirectory, { recursive: true, force: true });
      await beforeBoundary();
    }
  };

  const ensureWrangler = async () => {
    if (wrapperVersionProven) return;
    const version = String(await wrangler(source, ["--version"], { json: false })).trim();
    if (version !== LOCKED_WRANGLER_VERSION) {
      refuse("DISPOSABLE_RECOVERY_SEED_WRANGLER_VERSION_INVALID");
    }
    wrapperVersionProven = true;
  };

  const readD1Rows = async (binding, sql) => {
    if (binding.workerName !== source.workerName || binding.databaseName !== source.databaseName ||
        binding.accountId !== source.accountId) {
      refuse("DISPOSABLE_RECOVERY_SEED_RESOURCE_CHANGED");
    }
    await ensureWrangler();
    return d1Rows(await wrangler(binding, [
      "d1", "execute", source.databaseName,
      "--remote", "--command", sql, "--json",
    ]));
  };

  const directCounts = async () => {
    const rows = await readD1Rows(source, DIRECT_COUNTS_SQL);
    if (rows.length !== 1) refuse("DISPOSABLE_RECOVERY_SEED_DIRECT_D1_INVALID");
    const row = rows[0];
    return Object.freeze({
      document_count: count(row.document_count, "DISPOSABLE_RECOVERY_SEED_DIRECT_D1_INVALID"),
      chunk_count: count(row.chunk_count, "DISPOSABLE_RECOVERY_SEED_DIRECT_D1_INVALID"),
      fts_count: count(row.fts_count, "DISPOSABLE_RECOVERY_SEED_DIRECT_D1_INVALID"),
      pending_outbox: count(row.pending_outbox, "DISPOSABLE_RECOVERY_SEED_DIRECT_D1_INVALID"),
      failed_vectors: count(row.failed_vectors, "DISPOSABLE_RECOVERY_SEED_DIRECT_D1_INVALID"),
    });
  };

  const liveVersion = async (binding, versionId, scriptEtag) => {
    await ensureWrangler();
    const version = object(await wrangler(binding, [
      "versions", "view", versionId, "--name", binding.workerName, "--json",
    ]), "DISPOSABLE_RECOVERY_SEED_DEPLOYMENT_CHANGED");
    const script = version.resources?.script;
    if (version.id !== versionId || !script || typeof script !== "object" ||
        script.etag !== scriptEtag) {
      refuse("DISPOSABLE_RECOVERY_SEED_DEPLOYMENT_CHANGED");
    }
    return true;
  };

  const liveDeployment = async (binding, versionId, deploymentId) => {
    await ensureWrangler();
    const deployment = object(await wrangler(binding, [
      "deployments", "status", "--name", binding.workerName, "--json",
    ]), "DISPOSABLE_RECOVERY_SEED_DEPLOYMENT_CHANGED");
    if (deployment.id !== deploymentId ||
        !Array.isArray(deployment.versions) || deployment.versions.length !== 1 ||
        deployment.versions[0]?.version_id !== versionId ||
        Number(deployment.versions[0]?.percentage) !== 100) {
      refuse("DISPOSABLE_RECOVERY_SEED_DEPLOYMENT_CHANGED");
    }
    return true;
  };

  return Object.freeze({
    readOpeningDirectD1: directCounts,
    verifyDeployment: async () => {
      const sourceVersion = sourcePhaseReceipt?.source?.active_version;
      const sourceDeployment = sourcePhaseReceipt?.source?.active_deployment;
      if (!seedBinding ||
          sourcePhaseReceiptSha256 !== seedBinding.source_phase_receipt_sha256 ||
          sourcePhaseReceipt?.binding?.source_resource_fingerprint !==
            seedBinding.source_resource_fingerprint ||
          sourcePhaseReceipt?.binding?.run_id !== seedBinding.source_phase_run_id ||
          sourcePhaseReceipt?.a2_approval_fingerprint !==
            seedBinding.source_a2_approval_fingerprint ||
          sourceVersion?.version_id !== seedBinding.source_active_version_id ||
          sourceVersion?.script_etag !== seedBinding.source_script_etag ||
          sourceDeployment?.deployment_id !== seedBinding.source_deployment_id ||
          sourceDeployment?.version_id !== sourceVersion?.version_id ||
          sourceDeployment?.traffic_percent !== 100) {
        refuse("DISPOSABLE_RECOVERY_SEED_DEPLOYMENT_INVALID");
      }
      await liveVersion(source, sourceVersion.version_id, sourceVersion.script_etag);
      await liveDeployment(
        source,
        sourceVersion.version_id,
        sourceDeployment.deployment_id,
      );
      return Object.freeze({
        source_phase_receipt_sha256: sourcePhaseReceiptSha256,
        source_phase_run_id: seedBinding.source_phase_run_id,
        source_a2_approval_fingerprint: seedBinding.source_a2_approval_fingerprint,
        source_resource_fingerprint: seedBinding.source_resource_fingerprint,
        source_active_version_id: sourceVersion.version_id,
        source_script_etag: sourceVersion.script_etag,
        source_deployment_id: sourceDeployment.deployment_id,
        source_active_traffic_percent: 100,
      });
    },
    ingestBatch: async (documents) => {
      const response = await request("/api/admin/brain/ingest/batch", {
        method: "POST",
        body: { docs: documents },
      });
      if (response.status !== 200) refuse("DISPOSABLE_RECOVERY_SEED_INGEST_FAILED");
      return response.body;
    },
    readInventory: async () => {
      const response = await request("/api/admin/brain/documents");
      if (response.status !== 200) refuse("DISPOSABLE_RECOVERY_SEED_INVENTORY_FAILED");
      return response.body;
    },
    settleProjection: async () => {
      let previousRemaining = Number.MAX_SAFE_INTEGER;
      for (let round = 1; round <= MAX_DRAIN_ROUNDS; round++) {
        const response = await request("/api/admin/brain/drain", { method: "POST", body: {} });
        if (![200, 409].includes(response.status)) refuse("DISPOSABLE_RECOVERY_SEED_DRAIN_FAILED");
        const remaining = count(response.body?.remaining,
          "DISPOSABLE_RECOVERY_SEED_DRAIN_RESPONSE_INVALID");
        if (remaining > previousRemaining) refuse("DISPOSABLE_RECOVERY_SEED_DRAIN_REGRESSED");
        previousRemaining = remaining;
        if (response.status === 200 && response.body?.vector_ready === true && remaining === 0) {
          return;
        }
        const delay = response.status === 409
          ? Math.max(1, Math.min(60, count(response.body?.retry_after_seconds,
            "DISPOSABLE_RECOVERY_SEED_DRAIN_RESPONSE_INVALID"))) * 1000
          : 1500;
        await sleep(delay);
      }
      refuse("DISPOSABLE_RECOVERY_SEED_DRAIN_LIMIT_REACHED");
    },
    readIndependentProjection: async () => {
      await ensureWrangler();
      const indexes = await wrangler(source, ["vectorize", "list", "--json"]);
      const matches = Array.isArray(indexes)
        ? indexes.filter((row) => row?.name === source.vectorizeIndex)
        : [];
      if (matches.length !== 1) refuse("DISPOSABLE_RECOVERY_SEED_VECTORIZE_INVALID");
      const config = matches[0]?.config || matches[0];
      const info = object(
        await wrangler(source, ["vectorize", "info", source.vectorizeIndex, "--json"]),
        "DISPOSABLE_RECOVERY_SEED_VECTORIZE_INVALID",
      );
      const retry = await request("/api/admin/brain/vector-retry", {
        method: "POST", body: { confirm: false },
      });
      if (retry.status !== 200 || retry.body?.dry_run !== true) {
        refuse("DISPOSABLE_RECOVERY_SEED_QUARANTINE_INVALID");
      }
      return Object.freeze({
        vectorize_vectors: count(info.vectorCount ?? info.vector_count,
          "DISPOSABLE_RECOVERY_SEED_VECTORIZE_INVALID"),
        vector_dimensions: count(info.dimensions ?? config.dimensions,
          "DISPOSABLE_RECOVERY_SEED_VECTORIZE_INVALID"),
        vector_metric: String(config.metric || "").toLowerCase(),
        quarantined_vectors: count(retry.body.quarantined,
          "DISPOSABLE_RECOVERY_SEED_QUARANTINE_INVALID"),
        independent_control_plane: true,
      });
    },
    runRetrievalChecks: async () => {
      const marker = disposableRecoveryFixture()[0];
      const supported = await request("/api/rag/think", {
        method: "POST", body: { q: SUPPORTED_QUERY, source: marker.source_type, limit: 8 },
      });
      if (supported.status !== 200) refuse("DISPOSABLE_RECOVERY_SEED_SUPPORTED_CASE_FAILED");
      validateSupported(supported.body);
      const unsupported = await request("/api/rag/think", {
        method: "POST", body: { q: UNSUPPORTED_QUERY, source: marker.source_type, limit: 8 },
      });
      if (unsupported.status !== 200) refuse("DISPOSABLE_RECOVERY_SEED_UNSUPPORTED_CASE_FAILED");
      validateUnsupported(unsupported.body);
      return Object.freeze({ supported_case_cited: true, unsupported_case_refused: true });
    },
    readContentFingerprint: async () => {
      const before = await directCounts();
      const exportPath = assertPrivatePartial(
        join(receiptDirectory, ".v048-disposable-seed-content.sql.partial"),
        receiptDirectory,
      );
      const contentFingerprint = await captureRecoveryD1ContentFingerprint({
        binding: source,
        exportPath,
        maxBytes: MAX_EXPORT_BYTES,
        cleanupOnFailure: false,
        // Match the reviewed recovery artifact projection: source cookies are
        // invalidated by advancing this value once, while no source row is
        // mutated by the fingerprint read itself.
        sessionGenerationMode: "increment",
      }, {
        readD1Rows,
        exportData: async ({ path, tables }) => {
          await ensureWrangler();
          await wrangler(source, [
            "d1", "export", source.databaseName, "--remote", "--no-schema",
            "--output", path,
            ...tables.flatMap((table) => ["--table", table]),
          ], { json: false });
          if (process.platform !== "win32") chmodSync(path, 0o600);
        },
        cleanupExport: async (path) => {
          const checked = assertPrivatePartial(path, receiptDirectory);
          if (!existsSync(checked)) refuse("DISPOSABLE_RECOVERY_SEED_EXPORT_CLEANUP_INVALID");
          const info = lstatSync(checked);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
              (typeof process.getuid === "function" && info.uid !== process.getuid())) {
            refuse("DISPOSABLE_RECOVERY_SEED_EXPORT_CLEANUP_INVALID");
          }
          unlinkSync(checked);
          syncDirectory(receiptDirectory);
        },
      });
      const after = await directCounts();
      if (canonical(before) !== canonical(after)) {
        refuse("DISPOSABLE_RECOVERY_SEED_DIRECT_D1_CHANGED");
      }
      return Object.freeze({ ...after, content_fingerprint: contentFingerprint });
    },
  });
}

/** Reserve, execute, durably finalize, and read back one private seed receipt. */
export async function runDisposableRecoveryFieldSeed({
  binding,
  receiptPath,
  expectedReceiptDirectory,
  createTransports,
  revalidate = () => true,
  now = () => new Date(),
}, dependencies = {}) {
  if (process.platform === "win32") refuse("DISPOSABLE_RECOVERY_SEED_POSIX_REQUIRED");
  const checkedBinding = assertDisposableRecoverySeedBinding(binding);
  if (typeof createTransports !== "function" || typeof revalidate !== "function" ||
      typeof now !== "function") refuse("DISPOSABLE_RECOVERY_SEED_DEPENDENCY_INVALID");
  const assertOutput = dependencies.assertOutput ?? assertPrivateAggregateOutputPath;
  const reserve = dependencies.reserve ?? reservePrivateAggregateReceipt;
  const validateReservation = dependencies.validateReservation ??
    validatePrivateAggregateReceiptReservation;
  const finalize = dependencies.finalize ?? finalizePrivateAggregateReceipt;
  const abandon = dependencies.abandon ?? abandonPrivateAggregateReceipt;
  const readReceipt = dependencies.readReceipt ?? readPrivateAggregateReceipt;
  await revalidate();
  let expectedDirectory;
  try { expectedDirectory = realpathSync(resolve(expectedReceiptDirectory)); }
  catch { refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_PATH_INVALID"); }
  const absoluteReceiptPath = resolve(receiptPath);
  if (absoluteReceiptPath !== join(expectedDirectory, RECEIPT_NAME)) {
    refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_PATH_INVALID");
  }
  const parent = assertPrivateAggregateReceiptDirectory(expectedDirectory, {
    code: "DISPOSABLE_RECOVERY_SEED_RECEIPT_PATH_INVALID",
  });
  const resumePath = join(expectedDirectory, RESUME_NAME);
  const pendingPath = privateAggregateReceiptPendingPath(absoluteReceiptPath);
  let resumeReadback;
  if (existsSync(resumePath)) {
    resumeReadback = readBoundResumeRecord(resumePath, checkedBinding);
  } else {
    if (existsSync(absoluteReceiptPath) || existsSync(pendingPath)) {
      refuse("DISPOSABLE_RECOVERY_SEED_RESUME_MISSING");
    }
    resumeReadback = persistResumeRecord(
      resumePath,
      initialResumeRecord(checkedBinding),
      checkedBinding,
    );
  }
  if (resumeReadback.value.status === "write_confirmation_ambiguous") {
    requireAmbiguousWriteReview(resumeReadback.value);
  }

  const receiptExists = existsSync(absoluteReceiptPath);
  const pendingExists = existsSync(pendingPath);
  if (receiptExists && !pendingExists) {
    const existing = readExistingSeedReceipt(absoluteReceiptPath, checkedBinding);
    if (resumeReadback.value.status === "complete") {
      if (resumeReadback.value.final_seed_receipt_sha256 !== existing.sha256) {
        refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_READBACK_FAILED");
      }
    } else {
      const completed = completeResumeRecord(
        resumeReadback.value,
        existing.sha256,
        checkedBinding,
      );
      resumeReadback = persistResumeRecord(
        resumePath,
        completed,
        checkedBinding,
        resumeReadback.sha256,
      );
    }
    return Object.freeze({ receipt: existing.value, receiptSha256: existing.sha256 });
  }
  if (!receiptExists && pendingExists) {
    refuse("DISPOSABLE_RECOVERY_SEED_RESERVATION_INCOMPLETE");
  }

  const marker = reservationMarker(checkedBinding);
  let reservation = null;
  let finalized = false;
  try {
    if (receiptExists && pendingExists) {
      reservation = resumePrivateAggregateReceiptReservation({
        path: absoluteReceiptPath,
        pendingPath,
        parent,
      }, marker);
    } else {
      const output = assertOutput(absoluteReceiptPath);
      if (output.path !== absoluteReceiptPath || output.parent.path !== expectedDirectory) {
        refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_PATH_INVALID");
      }
      reservation = reserve(output, marker);
    }
    const beforeBoundary = async () => {
      await revalidate();
      validateReservation(reservation, {
        code: "DISPOSABLE_RECOVERY_SEED_RESERVATION_CHANGED",
      });
    };
    await beforeBoundary();
    const transports = await createTransports(beforeBoundary);
    const checkpoint = async (state) => {
      const next = checkpointResumeRecord(
        resumeReadback.value,
        state,
        checkedBinding,
      );
      resumeReadback = persistResumeRecord(
        resumePath,
        next,
        checkedBinding,
        resumeReadback.sha256,
      );
    };
    const receipt = await seedDisposableRecoveryFixture({
      binding: checkedBinding,
      ...transports,
      resume: resumableProgress(resumeReadback.value),
      checkpoint,
      now,
    });
    assertDisposableRecoverySeedReceipt(receipt);
    await beforeBoundary();
    if (finalize(reservation, receipt) !== true) {
      refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_FINALIZATION_FAILED");
    }
    finalized = true;
    const readback = readReceipt(absoluteReceiptPath, {
      code: "DISPOSABLE_RECOVERY_SEED_RECEIPT_READBACK_FAILED",
    });
    assertDisposableRecoverySeedReceipt(readback.value);
    if (canonical(readback.value) !== canonical(receipt)) {
      refuse("DISPOSABLE_RECOVERY_SEED_RECEIPT_READBACK_FAILED");
    }
    const completed = completeResumeRecord(
      resumeReadback.value,
      readback.sha256,
      checkedBinding,
    );
    resumeReadback = persistResumeRecord(
      resumePath,
      completed,
      checkedBinding,
      resumeReadback.sha256,
    );
    return Object.freeze({ receipt, receiptSha256: readback.sha256 });
  } catch (error) {
    throw withResumeSummary(error, resumeReadback.value);
  } finally {
    if (reservation && !finalized) abandon(reservation);
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || !["preview", "execute"].includes(argv[0])) {
    refuse("DISPOSABLE_RECOVERY_SEED_ARGUMENT_INVALID");
  }
  const command = argv[0];
  const allowed = new Set([
    "candidate-sha", "source-manifest", "plan", "field-receipt",
    "source-phase-receipt", "package", "wrangler-wrapper", "receipt", "approve",
  ]);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/u.test(flag || "") || !allowed.has(flag.slice(2)) ||
        typeof value !== "string" || !value || value.startsWith("--") ||
        Object.hasOwn(values, flag.slice(2))) {
      refuse("DISPOSABLE_RECOVERY_SEED_ARGUMENT_INVALID");
    }
    values[flag.slice(2)] = value;
  }
  const required = [
    "candidate-sha", "source-manifest", "plan", "field-receipt",
    "source-phase-receipt", "package", "wrangler-wrapper",
    ...(command === "execute" ? ["receipt", "approve"] : []),
  ];
  if (argv.length % 2 !== 1 || required.some((key) => !values[key]) ||
      Object.keys(values).some((key) => !required.includes(key))) {
    refuse("DISPOSABLE_RECOVERY_SEED_ARGUMENT_INVALID");
  }
  return Object.freeze({ command, values: Object.freeze(values) });
}

function usage() {
  return `Usage:
  node operations/disposable-recovery-field-seed.mjs preview --candidate-sha <40-hex> --source-manifest <private-file> --plan <private-file> --field-receipt <private-file> --source-phase-receipt <private-file> --package <exact-tarball> --wrangler-wrapper <private-wrapper>
  node operations/disposable-recovery-field-seed.mjs execute <same-flags> --receipt <private-dir>/${RECEIPT_NAME} --approve <preview-fingerprint>`;
}

export async function main(argv = process.argv.slice(2), {
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
  fetchImpl = globalThis.fetch,
  runWrangler,
  sleep,
  resolveKey,
  environment = process.env,
} = {}) {
  const parsed = parseArgs(argv);
  const values = parsed.values;
  const plan = loadVerifiedRecoveryPlan(resolve(values.plan));
  const source = assertExactSourceCampaign(inspectVerifiedRecoverySourceManifestBinding(
    plan,
    resolve(values["source-manifest"]),
  ).source);
  const preparation = inspectDisposableRecoverySeedPreparation({
    candidateSha: values["candidate-sha"],
    fieldReceiptPath: values["field-receipt"],
    sourcePhaseReceiptPath: values["source-phase-receipt"],
    packagePath: values.package,
    wranglerWrapperPath: values["wrangler-wrapper"],
    plan,
  });
  if (parsed.command === "preview") {
    stdout(`${JSON.stringify({
      mode: "v048_disposable_recovery_seed",
      writes: false,
      fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
      documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
      candidate_sha: preparation.binding.candidate_sha,
      package_sha256: preparation.binding.package_sha256,
      approval_fingerprint: preparation.approvalFingerprint,
      receipt: `owner-only ${RECEIPT_NAME}`,
    }, null, 2)}\n`);
    return 0;
  }
  if (values.approve !== preparation.approvalFingerprint) {
    refuse("DISPOSABLE_RECOVERY_SEED_APPROVAL_MISMATCH");
  }
  const receiptDirectory = resolve(dirname(values.receipt));
  const revalidate = async () => {
    preparation.revalidate();
    assertExactSourceCampaign(inspectVerifiedRecoverySourceManifestBinding(
      plan,
      resolve(values["source-manifest"]),
    ).source);
    return true;
  };
  const result = await runDisposableRecoveryFieldSeed({
    binding: preparation.binding,
    receiptPath: resolve(values.receipt),
    expectedReceiptDirectory: resolve(dirname(values["field-receipt"])),
    revalidate,
    createTransports: async (beforeBoundary) => createDisposableRecoveryLiveTransports({
      source,
      seedBinding: preparation.binding,
      sourcePhaseReceipt: preparation.sourcePhaseReceipt,
      sourcePhaseReceiptSha256: preparation.binding.source_phase_receipt_sha256,
      sourceManifestPath: resolve(values["source-manifest"]),
      receiptDirectory,
      wranglerWrapperPath: resolve(values["wrangler-wrapper"]),
      wranglerWrapperSha256: preparation.binding.wrangler_wrapper_sha256,
      wranglerRuntime: preparation.wranglerRuntime,
      beforeBoundary,
      fetchImpl,
      ...(runWrangler ? { runWrangler } : {}),
      ...(sleep ? { sleep } : {}),
      ...(resolveKey ? { resolveKey } : {}),
      environment,
    }),
  });
  stdout(`${JSON.stringify({
    status: result.receipt.status,
    documents: result.receipt.d1.documents,
    chunks: result.receipt.d1.chunks,
    fts: result.receipt.d1.fts,
    vectorize_vectors: result.receipt.projection.vectorize_vectors,
    supported_case_cited: result.receipt.evaluation.supported_case_cited,
    unsupported_case_refused: result.receipt.evaluation.unsupported_case_refused,
    receipt_sha256: result.receiptSha256,
  }, null, 2)}\n`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = typeof error?.code === "string"
      ? error.code
      : "DISPOSABLE_RECOVERY_SEED_FAILED";
    if (error?.resume_record) {
      process.stderr.write(`${JSON.stringify({
        status: "incomplete",
        code,
        resume: error.resume_record,
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`${code}\n`);
    }
    process.exitCode = 1;
  });
}
