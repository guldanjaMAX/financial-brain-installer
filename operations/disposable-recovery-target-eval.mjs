/**
 * Aggregate, owner-private target evaluation for the v0.4.8 disposable field
 * campaign. The transport may read the exact recovered target and run the
 * private release profile, but it must return only bounded status, booleans,
 * counts, hashes, and the already reviewed active-version identity. Questions,
 * answers, citations, credentials, and raw provider responses are never
 * serialized by this producer. It does not alter corpus, configuration, access,
 * or infrastructure; answer-model calls may create ordinary aggregate usage
 * records.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  assertDisposableRecoveryTargetEvalReceipt,
} from "./disposable-recovery-field-acceptance.mjs";
import {
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateOutputPath,
  assertPrivateAggregateReceiptDirectory,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptCommitPath,
  privateAggregateReceiptPendingPath,
  readPrivateAggregateReceipt,
  recoverPrivateAggregateReceiptFinalization,
  reservePrivateAggregateReceipt,
  resumePrivateAggregateReceiptReservation,
  validatePrivateAggregateReceiptReservation,
} from "./private-aggregate-receipt.mjs";
import {
  assertDisposableRecoveryFieldKeychainVerificationBinding,
} from "./disposable-recovery-field-keychain-prep.mjs";
import {
  assertCloudflareDisposableCampaignSemanticAuthority,
  assertCloudflareDisposableCampaignSemanticContinuation,
} from "./cloudflare-disposable-deployment-provider.mjs";

export const DISPOSABLE_RECOVERY_TARGET_EVAL_PROTOCOL =
  "v048-disposable-target-eval-v1";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,127}$/u;
const EXPECTED_DOCUMENTS = 6_001;

export class DisposableRecoveryTargetEvalError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryTargetEvalError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryTargetEvalError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields) {
  return plainObject(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
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

function immutable(value) {
  const copy = structuredClone(value);
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    Object.freeze(entry);
    for (const child of Object.values(entry)) freeze(child);
    return entry;
  };
  return freeze(copy);
}

export function assertDisposableRecoveryTargetEvalBinding(value) {
  const fields = [
    "candidate_sha", "candidate_tree_sha", "package_sha256", "field_receipt_sha256",
    "campaign_fingerprint", "keychain_binding_sha256", "recovery_plan_fingerprint",
    "recovery_state_sha256",
    "golden_sha256", "source_resource_fingerprint", "target_resource_fingerprint",
    "active_worker_version_id",
  ];
  if (!exactKeys(value, fields) ||
      !COMMIT_RE.test(String(value.candidate_sha || "")) ||
      !COMMIT_RE.test(String(value.candidate_tree_sha || "")) ||
      value.candidate_sha === value.candidate_tree_sha ||
      [
        "package_sha256",
        "field_receipt_sha256",
        "campaign_fingerprint",
        "keychain_binding_sha256",
        "recovery_plan_fingerprint",
        "recovery_state_sha256",
        "golden_sha256",
        "source_resource_fingerprint",
        "target_resource_fingerprint",
      ].some((field) => !SHA256_RE.test(String(value[field] || ""))) ||
      value.source_resource_fingerprint === value.target_resource_fingerprint ||
      !PROVIDER_ID_RE.test(String(value.active_worker_version_id || ""))) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_BINDING_INVALID");
  }
  return immutable(value);
}

export function disposableRecoveryTargetEvalApprovalFingerprint(bindingInput) {
  const binding = assertDisposableRecoveryTargetEvalBinding(bindingInput);
  return sha256(canonical({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_TARGET_EVAL_PROTOCOL,
    action: "read_exact_active_target_and_run_private_release_evaluation",
    binding,
  }));
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_OBSERVATION_INVALID");
  }
  return value;
}

function assertObservation(value, binding) {
  if (!exactKeys(value, [
    "target_resource_fingerprint", "worker_version_id", "mode", "health",
    "projection", "usage", "snapshot_sha256",
  ]) || value.target_resource_fingerprint !== binding.target_resource_fingerprint ||
      value.worker_version_id !== binding.active_worker_version_id || value.mode !== "active" ||
      !exactKeys(value.health, ["status", "version", "accepting_documents"]) ||
      value.health.status !== "pass" || value.health.version !== "0.4.8" ||
      value.health.accepting_documents !== true ||
      !exactKeys(value.projection, [
        "documents", "d1_chunks", "fts_rows", "vectorize_vectors",
        "pending_outbox", "failed_vectors",
      ]) || !SHA256_RE.test(String(value.snapshot_sha256 || ""))) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_OBSERVATION_INVALID");
  }
  const projection = {
    documents: count(value.projection.documents),
    d1_chunks: count(value.projection.d1_chunks),
    fts_rows: count(value.projection.fts_rows),
    vectorize_vectors: count(value.projection.vectorize_vectors),
    pending_outbox: count(value.projection.pending_outbox),
    failed_vectors: count(value.projection.failed_vectors),
  };
  if (projection.documents !== EXPECTED_DOCUMENTS ||
      projection.d1_chunks < EXPECTED_DOCUMENTS ||
      projection.fts_rows !== projection.d1_chunks ||
      projection.vectorize_vectors !== projection.d1_chunks ||
      projection.pending_outbox !== 0 || projection.failed_vectors !== 0) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_PROJECTION_INVALID");
  }
  if (!exactKeys(value.usage, ["records", "max_id"])) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_OBSERVATION_INVALID");
  }
  const usage = {
    records: count(value.usage.records),
    max_id: count(value.usage.max_id),
  };
  if ((usage.records === 0 && usage.max_id !== 0) ||
      (usage.records > 0 && usage.max_id < usage.records)) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_OBSERVATION_INVALID");
  }
  return immutable({ ...value, projection, usage });
}

function assertAppendOnlyUsage(before, after) {
  if (after.usage.records < before.usage.records ||
      after.usage.max_id < before.usage.max_id ||
      (after.usage.records === before.usage.records &&
        after.usage.max_id !== before.usage.max_id) ||
      (after.usage.records > before.usage.records &&
        after.usage.max_id === before.usage.max_id)) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_USAGE_CHANGED_INVALID");
  }
  return true;
}

function assertReleaseEval(value) {
  if (!exactKeys(value, [
    "profile", "status", "critical_failures", "unauthorized_retrievals",
  ]) || value.profile !== "release" || value.status !== "pass" ||
      value.critical_failures !== 0 || value.unauthorized_retrievals !== 0) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RELEASE_PROFILE_FAILED");
  }
  return immutable(value);
}

function assertSupportedCase(value) {
  if (!exactKeys(value, ["cited", "citation_count"]) || value.cited !== true ||
      !Number.isSafeInteger(value.citation_count) || value.citation_count < 1) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_SUPPORTED_CASE_FAILED");
  }
  return immutable(value);
}

function assertUnsupportedCase(value) {
  if (!exactKeys(value, ["refused"]) || value.refused !== true) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_UNSUPPORTED_CASE_FAILED");
  }
  return immutable(value);
}

function exactIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_CLOCK_INVALID");
  return date.toISOString();
}

async function assertEvidenceUnchanged(revalidate) {
  let valid;
  try { valid = await revalidate(); }
  catch { refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED"); }
  if (valid !== true) refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED");
}

async function boundary(revalidate, reservation) {
  await assertEvidenceUnchanged(revalidate);
  try {
    validatePrivateAggregateReceiptReservation(reservation, {
      code: "DISPOSABLE_RECOVERY_TARGET_EVAL_RESERVATION_CHANGED",
    });
  } catch { refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RESERVATION_CHANGED"); }
}

function readExisting(path, binding) {
  let loaded;
  try {
    loaded = readPrivateAggregateReceipt(path, {
      code: "DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_INVALID",
    });
    assertDisposableRecoveryTargetEvalReceipt(loaded.value, binding);
  } catch {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_INVALID");
  }
  return Object.freeze({ receipt: loaded.value, receiptSha256: loaded.sha256 });
}

/**
 * Execute a corpus-read-only live evaluation and persist only its aggregate result.
 * The transport contract deliberately rejects extra keys so private question,
 * answer, citation, raw provider-response, and credential material cannot reach
 * the receipt.
 */
export async function runDisposableRecoveryTargetEvaluation({
  binding: bindingInput,
  keychainBinding,
  keychainProof,
  a4CampaignAuthority: a4CampaignAuthorityInput,
  approvalFingerprint,
  receiptPath,
  expectedReceiptDirectory,
  transport,
  revalidate,
  now = () => new Date(),
}) {
  const binding = assertDisposableRecoveryTargetEvalBinding(bindingInput);
  let a4CampaignAuthority;
  try {
    a4CampaignAuthority =
      assertCloudflareDisposableCampaignSemanticAuthority(
        a4CampaignAuthorityInput,
      );
  } catch {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_AUTHORITY_INVALID");
  }
  if (a4CampaignAuthority.target_mode !== "paused" ||
      a4CampaignAuthority.approved_versions.target_active.version_id !==
        binding.active_worker_version_id) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_AUTHORITY_INVALID");
  }
  let proof;
  try {
    proof = assertDisposableRecoveryFieldKeychainVerificationBinding(
      keychainProof,
      keychainBinding,
      binding.keychain_binding_sha256,
    );
  } catch {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_KEYCHAIN_BINDING_INVALID");
  }
  if (keychainBinding.candidate_sha !== binding.candidate_sha ||
      keychainBinding.candidate_tree_sha !== binding.candidate_tree_sha ||
      keychainBinding.package_sha256 !== binding.package_sha256 ||
      keychainBinding.field_receipt_sha256 !== binding.field_receipt_sha256 ||
      typeof revalidate !== "function") {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_KEYCHAIN_BINDING_INVALID");
  }
  const revalidateBoundEvidence = async () => {
    try {
      assertDisposableRecoveryFieldKeychainVerificationBinding(
        proof,
        keychainBinding,
        binding.keychain_binding_sha256,
      );
      if (await revalidate() !== true || await proof.revalidate() !== true) {
        refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED");
      }
      assertDisposableRecoveryFieldKeychainVerificationBinding(
        proof,
        keychainBinding,
        binding.keychain_binding_sha256,
      );
    } catch (error) {
      if (error instanceof DisposableRecoveryTargetEvalError) throw error;
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED");
    }
    return true;
  };
  const expectedApproval = disposableRecoveryTargetEvalApprovalFingerprint(binding);
  if (approvalFingerprint !== expectedApproval) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_APPROVAL_INVALID");
  }
  if (!transport || typeof transport.observeCampaignAuthority !== "function" ||
      typeof transport.observeTarget !== "function" ||
      typeof transport.runReleaseEval !== "function" ||
      typeof transport.runSupportedCase !== "function" ||
      typeof transport.runUnsupportedCase !== "function" ||
      typeof now !== "function") {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_TRANSPORT_INVALID");
  }
  await assertEvidenceUnchanged(revalidateBoundEvidence);
  let directory;
  try {
    directory = assertPrivateAggregateReceiptDirectory(realpathSync(resolve(expectedReceiptDirectory)), {
      code: "DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_PATH_INVALID",
    });
  } catch { refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_PATH_INVALID"); }
  const outputPath = resolve(receiptPath);
  if (dirname(outputPath) !== directory.path ||
      basename(outputPath) !== DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_PATH_INVALID");
  }
  const pendingPath = privateAggregateReceiptPendingPath(outputPath);
  const commitPath = privateAggregateReceiptCommitPath(outputPath);
  const marker = immutable({
    schema_version: 1,
    kind: "v048_disposable_target_eval_pending",
    status: "read_only_evaluation_in_progress",
    approval_fingerprint: expectedApproval,
    binding,
  });
  const recoveryOutput = Object.freeze({
    path: outputPath,
    pendingPath,
    commitPath,
    parent: directory,
  });
  if (existsSync(commitPath)) {
    await assertEvidenceUnchanged(revalidateBoundEvidence);
    try {
      recoverPrivateAggregateReceiptFinalization(
        recoveryOutput,
        marker,
        (candidate) => {
          assertDisposableRecoveryTargetEvalReceipt(candidate, binding);
          return true;
        },
      );
    } catch {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RESERVATION_INCOMPLETE");
    }
    await assertEvidenceUnchanged(revalidateBoundEvidence);
  }
  if (existsSync(outputPath) && !existsSync(pendingPath) && !existsSync(commitPath)) {
    await assertEvidenceUnchanged(revalidateBoundEvidence);
    const existing = readExisting(outputPath, binding);
    await assertEvidenceUnchanged(revalidateBoundEvidence);
    return existing;
  }
  if (!existsSync(outputPath) && existsSync(pendingPath)) {
    refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RESERVATION_INCOMPLETE");
  }
  const resuming = existsSync(outputPath) && existsSync(pendingPath);
  let output;
  if (resuming) {
    output = recoveryOutput;
  } else {
    try {
      output = assertPrivateAggregateOutputPath(outputPath, {
        code: "DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_PATH_INVALID",
      });
    } catch { refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_PATH_INVALID"); }
  }
  let reservation;
  await assertEvidenceUnchanged(revalidateBoundEvidence);
  try {
    reservation = resuming
      ? resumePrivateAggregateReceiptReservation(output, marker)
      : reservePrivateAggregateReceipt(output, marker);
  } catch {
    refuse(resuming
      ? "DISPOSABLE_RECOVERY_TARGET_EVAL_RESERVATION_INCOMPLETE"
      : "DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_PATH_INVALID");
  }
  let finalized = false;
  try {
    await boundary(revalidateBoundEvidence, reservation);
    let campaignBefore;
    try {
      campaignBefore = assertCloudflareDisposableCampaignSemanticContinuation(
        a4CampaignAuthority,
        await transport.observeCampaignAuthority(),
        "active",
      );
    } catch {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_CHANGED");
    }
    await boundary(revalidateBoundEvidence, reservation);
    const before = assertObservation(await transport.observeTarget(), binding);
    await boundary(revalidateBoundEvidence, reservation);
    const evaluation = assertReleaseEval(await transport.runReleaseEval());
    await boundary(revalidateBoundEvidence, reservation);
    const supported = assertSupportedCase(await transport.runSupportedCase());
    await boundary(revalidateBoundEvidence, reservation);
    const unsupported = assertUnsupportedCase(await transport.runUnsupportedCase());
    await boundary(revalidateBoundEvidence, reservation);
    const after = assertObservation(await transport.observeTarget(), binding);
    await boundary(revalidateBoundEvidence, reservation);
    let campaignAfter;
    try {
      campaignAfter = assertCloudflareDisposableCampaignSemanticContinuation(
        a4CampaignAuthority,
        await transport.observeCampaignAuthority(),
        "active",
      );
    } catch {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_CHANGED");
    }
    await boundary(revalidateBoundEvidence, reservation);
    if (canonical(campaignBefore) !== canonical(campaignAfter)) {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_CAMPAIGN_CHANGED");
    }
    if (after.snapshot_sha256 !== before.snapshot_sha256 ||
        canonical(after.projection) !== canonical(before.projection) ||
        after.worker_version_id !== before.worker_version_id) {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_TARGET_CHANGED");
    }
    assertAppendOnlyUsage(before, after);
    const receipt = immutable({
      schema_version: 1,
      kind: "v048_disposable_target_eval",
      status: "passed",
      completed_at: exactIso(now),
      binding,
      campaign_protection: {
        a4_authority: a4CampaignAuthority,
        evaluated_authority: campaignAfter,
      },
      target: {
        resource_fingerprint: binding.target_resource_fingerprint,
        worker_version_id: binding.active_worker_version_id,
        mode: "active",
      },
      projection: before.projection,
      checks: {
        health: {
          status: "pass",
          version: before.health.version,
          accepting_documents: true,
          before_snapshot_sha256: before.snapshot_sha256,
          after_snapshot_sha256: after.snapshot_sha256,
          active_version_unchanged: true,
          projection_unchanged: true,
        },
        eval_profile: evaluation.profile,
        eval_status: evaluation.status,
        critical_failures: evaluation.critical_failures,
        unauthorized_retrievals: evaluation.unauthorized_retrievals,
        supported_marker_case: {
          direct_target_check: true,
          cited: true,
          citation_count: supported.citation_count,
        },
        unsupported_case: { direct_target_check: true, refused: true },
      },
    });
    assertDisposableRecoveryTargetEvalReceipt(receipt, binding);
    await boundary(revalidateBoundEvidence, reservation);
    try {
      if (finalizePrivateAggregateReceipt(reservation, receipt) !== true) {
        refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_FINALIZATION_FAILED");
      }
    } catch (error) {
      if (error instanceof DisposableRecoveryTargetEvalError) throw error;
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_FINALIZATION_FAILED");
    }
    finalized = true;
    const readback = readExisting(outputPath, binding);
    if (canonical(readback.receipt) !== canonical(receipt)) {
      refuse("DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_INVALID");
    }
    await assertEvidenceUnchanged(revalidateBoundEvidence);
    return readback;
  } finally {
    if (!finalized) abandonPrivateAggregateReceipt(reservation);
  }
}
