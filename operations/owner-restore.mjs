/** Pure plan and sequencing contract for an in-place owner restore. */
import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function count(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return number;
}

export function normalizeRestoreTime(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new TypeError("--to must be an explicit RFC3339 timestamp with a timezone");
  }
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new TypeError("--to must be an explicit RFC3339 timestamp with a timezone");
  return date.toISOString();
}

function replacementIndexName(current, seed) {
  const safe = String(current || "brain-vectors").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "brain-vectors";
  return `${safe.slice(0, 43)}-restore-${sha256(seed).slice(0, 10)}`;
}

export function buildOwnerRestorePlan({
  manifestFingerprint,
  manifest,
  targetTime,
  targetBookmark,
  currentBookmark,
  before,
  operation = "restore",
}) {
  if (!/^[a-f0-9]{64}$/.test(String(manifestFingerprint || ""))) {
    throw new TypeError("restore planning needs the exact manifest fingerprint");
  }
  const normalizedTime = normalizeRestoreTime(targetTime);
  if (!targetBookmark || !currentBookmark) throw new TypeError("restore planning needs current and target D1 bookmarks");
  const infrastructure = manifest?.infrastructure?.cloudflare;
  if (!infrastructure?.d1_database_id || !infrastructure?.vectorize_index) {
    throw new TypeError("restore planning needs the manifest's D1 and Vectorize identities");
  }
  const snapshot = Object.freeze({
    documents: count(before?.documents, "before documents"),
    chunks: count(before?.chunks, "before chunks"),
    vectors: count(before?.vectors, "before vectors"),
    active_ingests: count(before?.active_ingests ?? 0, "active ingests"),
    active_updates: count(before?.active_updates ?? 0, "active updates"),
  });
  const base = {
    contract_version: 1,
    operation,
    manifest_fingerprint: manifestFingerprint,
    target_time: normalizedTime,
    target_bookmark: String(targetBookmark),
    current_bookmark: String(currentBookmark),
    database_id_sha256: sha256(String(infrastructure.d1_database_id)),
    current_index_sha256: sha256(String(infrastructure.vectorize_index)),
    replacement_index: replacementIndexName(infrastructure.vectorize_index, `${manifestFingerprint}:${normalizedTime}`),
    before: snapshot,
    effects: {
      d1_restore: true,
      replacement_vector_index: true,
      old_vector_index_retained: true,
      manifest_vector_binding_change: true,
      worker_pause_and_redeploy: true,
      full_vector_reprojection: true,
    },
  };
  return Object.freeze({ ...base, approval_fingerprint: sha256(canonical(base)) });
}

function validateAfter(after) {
  const normalized = {
    documents: count(after?.documents, "after documents"),
    chunks: count(after?.chunks, "after chunks"),
    vectors: count(after?.vectors, "after vectors"),
    pending_outbox: count(after?.pending_outbox ?? 0, "after pending outbox"),
  };
  if (normalized.vectors !== normalized.chunks || normalized.pending_outbox !== 0) {
    throw new Error("restore completed D1 but did not prove an exact settled vector projection");
  }
  return normalized;
}

/**
 * Execute only after rebuilding the same preview under the mutation lock.
 * Every effect is injected so the offline suite can prove ordering and stops.
 */
export async function executeOwnerRestore(request, dependencies) {
  const targetTime = normalizeRestoreTime(request?.targetTime);
  const pinned = await dependencies.loadPinnedManifest(request.manifestPath);
  const observed = await dependencies.observe({ manifestPath: request.manifestPath, manifest: pinned.manifest, targetTime });
  const plan = buildOwnerRestorePlan({
    manifestFingerprint: pinned.fingerprint,
    manifest: pinned.manifest,
    targetTime,
    targetBookmark: observed.targetBookmark,
    currentBookmark: observed.currentBookmark,
    before: observed.before,
    operation: request.operation || "restore",
  });
  if (plan.before.active_ingests > 0) throw new Error("restore refused because an ingest is running");
  if (plan.before.active_updates > 0) throw new Error("restore refused because an update is running");
  if (!request.approval) return Object.freeze({ status: "preview", plan });
  if (request.approval !== plan.approval_fingerprint) {
    throw new Error("restore approval no longer matches the current state; preview again");
  }
  for (const name of ["createRestorePoint", "restoreD1", "resetLocalState", "rebuildProjection", "readAfter", "writeReceipt"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`restore execution needs ${name}`);
  }
  await dependencies.createRestorePoint({ plan, pinned });
  const restoreResult = await dependencies.restoreD1({ plan, pinned });
  if (!restoreResult?.previousBookmark) {
    throw new Error("D1 restore did not return the pre-restore bookmark; recovery stopped");
  }
  const localState = await dependencies.resetLocalState({ plan, pinned, restoreResult });
  const projection = await dependencies.rebuildProjection({ plan, pinned, restoreResult });
  const after = validateAfter(await dependencies.readAfter({ plan, pinned, restoreResult, projection }));
  const receipt = Object.freeze({
    contract_version: 1,
    operation: plan.operation,
    approval_fingerprint: plan.approval_fingerprint,
    target_time: plan.target_time,
    target_bookmark: plan.target_bookmark,
    undo_bookmark: String(restoreResult.previousBookmark),
    before: plan.before,
    after,
    local_resume_states_reset: Number(localState?.reset || 0),
    projection: "verified",
    old_vector_index_retained: true,
  });
  await dependencies.writeReceipt({ plan, receipt });
  return Object.freeze({ status: "restored", plan, receipt });
}
