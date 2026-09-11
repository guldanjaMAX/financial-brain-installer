/**
 * Pure approval and readback contract for legacy source-provenance repair.
 *
 * This module never reads a credential, source, manifest, or network. The CLI
 * gives it already-sanitized observations. Keeping the approval hash here makes
 * the important distinction testable: the Worker's observation timestamp is
 * deliberately volatile, while any meaningful source or candidate change must
 * invalidate an earlier approval.
 */

import { createHash } from "node:crypto";

export const PROVENANCE_REPAIR_SOURCE_KINDS = Object.freeze([
  "upload",
  "drive",
  "gmail",
  "calendar",
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^sha256:[a-f0-9]{64}$/;
const CANDIDATE_RE = /^hmac-sha256:[a-f0-9]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function withoutVolatileRecoveryPage(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new TypeError("source recovery needs one summary object");
  }
  const { page: _page, ...stable } = summary;
  return stable;
}

function observationOf(receipt, label) {
  if (!receipt?.snapshot || !SNAPSHOT_RE.test(String(receipt.snapshot.id || "")) ||
      typeof receipt.as_of !== "string" || receipt.snapshot.as_of !== receipt.as_of) {
    throw new TypeError(`${label} needs one valid Worker snapshot observation`);
  }
  return Object.freeze({
    snapshot_id: receipt.snapshot.id,
    as_of: receipt.as_of,
  });
}

/**
 * Derive a deterministic remote generation from complete validated receipts.
 *
 * Worker snapshot IDs include `as_of`, so using them as the approval identity
 * would make an unchanged preview stale on its very next read. The raw IDs are
 * retained as observation receipts, while these hashes exclude only paging and
 * time fields. Every source row and every candidate field remains bound.
 */
export function provenanceRepairRemoteGeneration({ inventory, recovery, sourceId }) {
  if (!inventory || inventory.complete !== true || inventory.truncated !== false ||
      !Array.isArray(inventory.sources) || inventory.returned !== inventory.sources.length ||
      inventory.total !== inventory.sources.length) {
    throw new TypeError("provenance repair needs one complete source inventory");
  }
  if (!recovery || recovery.complete !== true || recovery.truncated !== false ||
      recovery.source_filter !== sourceId || !Array.isArray(recovery.candidates) ||
      recovery.returned !== recovery.candidates.length || recovery.total !== recovery.candidates.length) {
    throw new TypeError("provenance repair needs one complete source-filtered recovery inventory");
  }
  const selected = inventory.sources.filter((row) => row?.source_id === sourceId);
  if (selected.length !== 1) {
    throw new TypeError(`source inventory must contain exactly one row for ${sourceId}`);
  }
  const source = selected[0];
  if (!source.recovery_plan || source.recovery_plan.candidate_documents !== recovery.total ||
      recovery.recovery_plan_summary?.candidate_documents !== recovery.total) {
    throw new TypeError("source inventory and recovery candidate counts do not describe one remote generation");
  }

  const candidateIds = [];
  const seen = new Set();
  for (const candidate of recovery.candidates) {
    const id = String(candidate?.record_id || "");
    if (!CANDIDATE_RE.test(id) || seen.has(id) || candidate.source_id !== sourceId ||
        candidate.source_kind !== source.kind) {
      throw new TypeError("source recovery contains a duplicate or mismatched candidate");
    }
    seen.add(id);
    candidateIds.push(id);
  }
  candidateIds.sort();

  const inventorySemantic = {
    contract_version: inventory.contract_version,
    kind: inventory.kind,
    total: inventory.total,
    sources: [...inventory.sources].sort((left, right) => left.source_id.localeCompare(right.source_id)),
    recovery_plan_summary: inventory.recovery_plan_summary,
    limitations: inventory.limitations,
  };
  const recoverySemantic = {
    contract_version: recovery.contract_version,
    kind: recovery.kind,
    total: recovery.total,
    source_filter: recovery.source_filter,
    candidates: [...recovery.candidates].sort((left, right) =>
      left.record_id.localeCompare(right.record_id)),
    recovery_plan_summary: withoutVolatileRecoveryPage(recovery.recovery_plan_summary),
    limitations: recovery.limitations,
  };

  return Object.freeze({
    source,
    inventory_generation: hash(inventorySemantic),
    recovery_generation: hash(recoverySemantic),
    candidate_set_hash: hash(candidateIds),
    candidate_ids: Object.freeze(candidateIds),
    candidate_count: candidateIds.length,
    observations: Object.freeze({
      source_inventory: observationOf(inventory, "source inventory"),
      source_recovery: observationOf(recovery, "source recovery"),
    }),
  });
}

function validHash(value, label) {
  if (!SHA256_RE.test(String(value || ""))) throw new TypeError(`${label} must be a SHA-256 fingerprint`);
  return value;
}

/** Build the exact state-bound approval plan shown before a source rewalk. */
export function provenanceRepairPlan({
  productVersion,
  manifestFingerprint,
  sourceConfigFingerprint,
  source,
  remote,
  readiness,
  rewalk,
  ocr,
}) {
  validHash(manifestFingerprint, "manifest fingerprint");
  validHash(sourceConfigFingerprint, "source config fingerprint");
  if (!source || typeof source.id !== "string" || !source.id || typeof source.kind !== "string") {
    throw new TypeError("provenance repair needs one exact source identity");
  }
  if (!remote || !Array.isArray(remote.candidate_ids) || remote.candidate_count !== remote.candidate_ids.length) {
    throw new TypeError("provenance repair needs one exact recovery generation");
  }
  validHash(remote.inventory_generation, "source inventory generation");
  validHash(remote.recovery_generation, "source recovery generation");
  validHash(remote.candidate_set_hash, "candidate set fingerprint");
  if (!readiness || typeof readiness !== "object" || !Array.isArray(readiness.blockers)) {
    throw new TypeError("provenance repair needs one local readiness receipt");
  }
  if (!rewalk || rewalk.reset !== true || rewalk.limit !== null || rewalk.scope !== "whole_source" ||
      rewalk.mode !== "full_rewalk_reingest") {
    throw new TypeError("provenance repair may approve only a reset, no-limit whole-source rewalk");
  }
  if (!ocr || typeof ocr !== "object" || typeof ocr.enabled !== "boolean") {
    throw new TypeError("provenance repair needs the exact OCR policy state");
  }

  const expectedIds = [...remote.candidate_ids].sort();
  if (new Set(expectedIds).size !== expectedIds.length ||
      expectedIds.some((id) => !CANDIDATE_RE.test(id))) {
    throw new TypeError("provenance repair candidate IDs are invalid or duplicated");
  }
  const internal = {
    schema_version: 1,
    operation: "provenance-repair",
    product_version: String(productVersion || ""),
    manifest_fingerprint: manifestFingerprint,
    source_config_fingerprint: sourceConfigFingerprint,
    source: { id: source.id, kind: source.kind },
    remote_generation: {
      inventory: remote.inventory_generation,
      recovery: remote.recovery_generation,
    },
    expected_candidates: {
      count: expectedIds.length,
      ids: expectedIds,
      set_hash: remote.candidate_set_hash,
    },
    readiness,
    rewalk,
    ocr,
  };
  const planId = hash(internal);
  const supported = PROVENANCE_REPAIR_SOURCE_KINDS.includes(source.kind);
  const blockers = [
    ...readiness.blockers.map(String),
    ...(!supported ? [`source kind ${source.kind} has no supported full rewalk`] : []),
    ...(expectedIds.length === 0 ? ["this source has no current recovery candidates"] : []),
  ];

  return Object.freeze({
    schema_version: 1,
    operation: "provenance-repair",
    mode: "preview",
    read_only: true,
    product_version: String(productVersion || ""),
    source: Object.freeze({ id: source.id, kind: source.kind }),
    manifest_fingerprint: manifestFingerprint,
    source_config_fingerprint: sourceConfigFingerprint,
    remote_generation: Object.freeze({
      inventory: remote.inventory_generation,
      recovery: remote.recovery_generation,
      candidate_set: remote.candidate_set_hash,
    }),
    observations: remote.observations,
    expected_candidates: Object.freeze({
      count: expectedIds.length,
      ids: Object.freeze(expectedIds),
      set_hash: remote.candidate_set_hash,
    }),
    readiness: Object.freeze({ ...readiness, blockers: Object.freeze([...readiness.blockers]) }),
    rewalk: Object.freeze({ ...rewalk }),
    ocr: Object.freeze({ ...ocr }),
    effects: Object.freeze([
      "re-read and reingest the entire selected source through its existing supported ingest path",
      "create or update current source documents and reconcile split-document families",
      "possibly remove stale, deleted, cancelled, policy-excluded, or now-refused source records through the existing deletion approval gate",
      "spend OCR inference only where OCR is enabled and the supported source returns scanned pages",
    ]),
    boundaries: Object.freeze({
      relabels_legacy_metadata: false,
      individual_target_repair: false,
      credentials_in_command_or_receipt: false,
      changes_access_or_zones: false,
      changes_passkeys_or_devices: false,
      creates_skipped_original_receipts: false,
    }),
    blockers: Object.freeze(blockers),
    can_apply: blockers.length === 0,
    plan_id: planId,
  });
}

export function renderProvenanceRepairPlan(plan, applyCommand) {
  const lines = [
    "",
    "  Provenance recovery preview",
    "",
    "  This preview is read-only. Nothing has changed.",
    `  Source: ${plan.source.id} (${plan.source.kind})`,
    `  Legacy candidates observed: ${plan.expected_candidates.count}`,
    `  Candidate set: ${plan.expected_candidates.set_hash}`,
    "  Method: re-read the whole authorized source, reset prior progress, and use no item limit.",
    "  This does not relabel legacy rows and does not claim it can repair one opaque record by itself.",
    "",
    `  Local source/config: ${plan.readiness.source}`,
    `  Credential: ${plan.readiness.credential}`,
    `  Scheduler: ${plan.readiness.scheduler}`,
    `  OCR: ${plan.ocr.detail}`,
    "",
    "  Possible effects: current documents may be created or updated; split families may be reconciled; stale, deleted, cancelled, policy-excluded, or newly refused records may be proposed for removal.",
    "  The existing removal safety gate remains separate. If it asks for --approve-removals, this run stops and no provenance-repair success is claimed.",
  ];
  if (plan.can_apply) {
    lines.push(
      "",
      "  If the owner approves this entire source rewalk and its possible OCR cost, run exactly:",
      `    ${applyCommand}`,
    );
  } else {
    lines.push("", "  This plan cannot be applied:");
    for (const blocker of plan.blockers) lines.push(`    - ${blocker}`);
  }
  return `${lines.join("\n")}\n`;
}

function completedFullSweepReceipt(afterSource, beforeSource) {
  const receipt = afterSource?.receipt;
  const latest = receipt?.latest_run;
  const completeAt = Date.parse(String(receipt?.complete_history_through || ""));
  const startedAt = Date.parse(String(latest?.started_at || ""));
  const finishedAt = Date.parse(String(latest?.finished_at || ""));
  const priorRunHash = hash(beforeSource?.receipt?.latest_run ?? null);
  const currentRunHash = hash(latest ?? null);
  const reasons = [];
  if (receipt?.status !== "ready") reasons.push("source receipt is not ready");
  if (!latest || latest.outcome !== "completed") reasons.push("latest source run is not completed");
  if (latest?.walk_complete !== true) reasons.push("latest source run did not complete its walk");
  if (latest?.docs_failed !== 0) reasons.push("latest source run did not prove zero failed documents");
  if (latest?.docs_refused !== 0) reasons.push("latest source run did not prove zero refused documents");
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    reasons.push("latest source run has no valid completed time range");
  }
  if (!Number.isFinite(completeAt) || !Number.isFinite(finishedAt) || completeAt < finishedAt) {
    reasons.push("source receipt does not prove this run completed the whole source history");
  }
  if (priorRunHash === currentRunHash) reasons.push("source receipt did not advance to a new run");
  return Object.freeze({ verified: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** Compare exact opaque candidates only after the new full-sweep receipt passes. */
export function provenanceRepairReadback({ before, after }) {
  if (!before?.source || !after?.source ||
      before.source.source_id !== after.source.source_id ||
      before.source.kind !== after.source.kind) {
    throw new TypeError("provenance repair readback source identity changed");
  }
  const receipt = completedFullSweepReceipt(after.source, before.source);
  if (!receipt.verified) {
    return Object.freeze({
      status: "unverified",
      complete: false,
      receipt,
      fixed_candidate_ids: Object.freeze([]),
      fixed_count: 0,
      remaining_candidate_ids: Object.freeze([]),
      remaining_count: null,
      new_candidate_ids: Object.freeze([]),
      new_count: null,
      meaning: "The source rewalk may have changed records, but no candidate is called fixed because the exact full-sweep receipt did not verify.",
    });
  }

  const beforeIds = new Set(before.candidate_ids || []);
  const afterIds = new Set(after.candidate_ids || []);
  const fixed = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const remaining = [...beforeIds].filter((id) => afterIds.has(id)).sort();
  const introduced = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const complete = remaining.length === 0 && introduced.length === 0;
  return Object.freeze({
    status: complete ? "complete" : fixed.length ? "partial" : "no_change",
    complete,
    receipt,
    fixed_candidate_ids: Object.freeze(fixed),
    fixed_count: fixed.length,
    remaining_candidate_ids: Object.freeze(remaining),
    remaining_count: remaining.length,
    new_candidate_ids: Object.freeze(introduced),
    new_count: introduced.length,
    meaning: complete
      ? "Every candidate in the approved source-level preview is absent from the fresh recovery readback."
      : "Only candidates absent from the fresh recovery readback are called fixed; remaining and newly observed candidates stay unresolved.",
  });
}
