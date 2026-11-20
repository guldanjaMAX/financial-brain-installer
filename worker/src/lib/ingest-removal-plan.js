import { forget, forgetFamilies } from "./store-d1.js";
import { OWNER_REMOVAL_SOURCES } from "./owner-removals.js";

class RemovalPlanError extends Error {
  constructor(message, code = "INGEST_REMOVAL_INVALID", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Only fixed public codes cross this boundary; D1 messages can contain data. */
export function ingestRemovalFailure(error) {
  if (error instanceof RemovalPlanError) return { status: error.status, code: error.code };
  if (error instanceof SyntaxError) return { status: 400, code: "INGEST_REMOVAL_INVALID" };
  // The shared family resolver predates typed removal errors. Preserve these
  // exact domain refusals as conflicts; none is an infrastructure retry signal.
  if (error?.message === "family original identity changed; review the exact target again") {
    return { status: 409, code: "INGEST_REMOVAL_CHANGED" };
  }
  if (["each document family needs a base_doc_uid and any keep_doc_uids must belong to it",
    "family original identity is invalid"].includes(error?.message)) {
    return { status: 409, code: "INGEST_REMOVAL_INVALID" };
  }
  // D1 CPU resets can improve with a smaller request. Unknown infrastructure
  // failures remain retryable, but never acquire permission to replay a delete.
  const capacity = /D1_ERROR[^\r\n"]*exceeded[^\S\r\n]+(?:its[^\S\r\n]+)?CPU[^\S\r\n]+time[^\S\r\n]+limit/i
    .test(typeof error?.message === "string" ? error.message : "");
  return {
    status: 503,
    code: capacity ? "INGEST_REMOVAL_CAPACITY" : "INGEST_REMOVAL_UNAVAILABLE",
    // Where it failed and whether the delete may already be in. A caller that
    // sees committed:true or "unknown" must read back before retrying.
    stage: REMOVAL_STAGES.has(error?.removalStage) ? error.removalStage : "unknown",
    committed: [true, false, "unknown"].includes(error?.removalCommitted) ? error.removalCommitted : "unknown",
    d1_class: classifyProviderError(error),
    provider_message: safeProviderMessage(error),
  };
}

const REMOVAL_STAGES = new Set(["delete_batch", "readback", "marker"]);

/** A fixed token for the database's own failure, safe to log and to show. */
export function classifyProviderError(error) {
  const text = typeof error?.message === "string" ? error.message : "";
  if (/exceeded[^\r\n]{0,40}CPU[^\r\n]{0,20}time[^\r\n]{0,10}limit/i.test(text)) return "cpu_limit";
  if (/time(?:d)?[\s-]?out/i.test(text)) return "timeout";
  if (/overload|queued for too long|SQLITE_BUSY|database is locked|busy/i.test(text)) return "busy";
  if (/storage[^\r\n]{0,30}(?:unavailable|operation exceeded)|unavailable/i.test(text)) return "storage_unavailable";
  if (/network|connection|reset|socket/i.test(text)) return "network";
  return text ? "other" : "unknown";
}

/**
 * The provider's own first line, with anything that could carry a document or
 * mailbox identity removed: quoted values, long hex or digit runs, addresses.
 */
export function safeProviderMessage(error) {
  const text = typeof error?.message === "string" ? error.message : "";
  return text.split(/\r?\n/)[0]
    .replace(/(["'`]).*?\1/g, "...")
    .replace(/\S+@\S+/g, "...")
    .replace(/[0-9a-f]{12,}/gi, "#")
    .replace(/\d{6,}/g, "#")
    .replace(/\b[a-z0-9_-]{2,32}:[^\s:]{6,}/gi, (match) => /^D1_ERROR:/i.test(match) ? match : "...")
    .slice(0, 160);
}

const stageFailure = (error, stage, committed) => {
  if (error && typeof error === "object" && !(error instanceof RemovalPlanError)) {
    error.removalStage ??= stage;
    error.removalCommitted ??= committed;
  }
  return error;
};

const same = (a, b) => a?.instance === b?.instance && a?.nonce === b?.nonce && a?.generation === b?.generation && a?.runtime === b?.runtime;

export async function readIngestRemovalRequest(request) {
  const limit = 512 * 1024;
  if (Number(request.headers.get("content-length")) > limit || !request.body) throw new RemovalPlanError("Invalid removal request size.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RemovalPlanError("Invalid removal request size.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !["preview", "apply"].includes(body.action) ||
      Object.keys(body).some((key) => !(body.action === "preview"
        ? ["action", "families", "marker"]
        : ["action", "targets", "marker", ...REMEMBER_FIELDS]).includes(key))) {
    throw new RemovalPlanError("Invalid removal request shape.");
  }
  if (body.action === "apply") rememberRequest(body);
  return body;
}
const REMEMBER_FIELDS = ["remember_removal", "run_id", "batch_no", "reason", "receipt_nonce"];

/** Validated "remember this removal" request, or null for an ordinary apply. */
export function rememberRequest(body) {
  const present = REMEMBER_FIELDS.filter((key) => body[key] !== undefined);
  if (!present.length) return null;
  if (body.remember_removal !== true || typeof body.run_id !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(body.run_id) ||
      (body.receipt_nonce !== undefined &&
        (typeof body.receipt_nonce !== "string" || !/^[a-f0-9]{32}$/.test(body.receipt_nonce))) ||
      !Number.isSafeInteger(body.batch_no) || body.batch_no < 0 ||
      (body.reason !== undefined && (typeof body.reason !== "string" || !/^[a-z0-9_ -]{1,64}$/.test(body.reason)))) {
    throw new RemovalPlanError("Invalid removal memory request.");
  }
  return { runId: body.run_id, batchNo: body.batch_no, receiptNonce: body.receipt_nonce, reason: body.reason ?? "owner_removal" };
}

export async function ingestRemovalMarker(env) {
  const row = await env.DB.prepare(
    "SELECT instance, nonce, generation FROM ingest_removal_generation WHERE id = 1",
  ).first();
  const runtime = env.INGEST_VERSION?.id;
  if (!row || !Number.isSafeInteger(row.generation) || !runtime) {
    throw new RemovalPlanError("The Brain needs the removal-plan migration and version binding before removal review.", "INGEST_REMOVAL_UNAVAILABLE", 409);
  }
  return { instance: row.instance, nonce: row.nonce, generation: row.generation, runtime };
}

/** The preview shares the actual family resolver, but never calls a writer. */
export async function previewIngestRemovals(env, { families = [], marker = null } = {}) {
  if (!Array.isArray(families) || families.length > 50) throw new RemovalPlanError("Removal preview needs at most 50 families.");
  const before = await ingestRemovalMarker(env);
  if (marker && !same(marker, before)) throw new RemovalPlanError("Stored inventory or runtime changed; plan ingestion again.", "INGEST_REMOVAL_CHANGED", 409);
  const result = await forgetFamilies(env, { families, dryRun: true });
  const after = await ingestRemovalMarker(env);
  if (!same(before, after)) throw new RemovalPlanError("Stored inventory changed during preview; plan ingestion again.", "INGEST_REMOVAL_CHANGED", 409);
  return { marker: after, targets: [...result.targets].sort(), documents: result.documents, excluded_documents: result.excluded_documents || 0 };
}

/** Apply exact physical identities, never a freshly expanded family selector. */
export async function applyIngestRemovals(env, { targets, marker, ...memory } = {}) {
  const rememberRemoval = rememberRequest(memory);
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 50 ||
      targets.some((uid) => typeof uid !== "string" || !uid) || new Set(targets).size !== targets.length) {
    throw new RemovalPlanError("Removal apply needs 1 to 50 exact document identities.");
  }
  if (!same(marker, await ingestRemovalMarker(env))) {
    throw new RemovalPlanError("Stored inventory or runtime changed; plan ingestion again.", "INGEST_REMOVAL_CHANGED", 409);
  }
  if (rememberRemoval) {
    // Clean my Brain remembers Gmail and Drive items only. Any other source in
    // the batch is refused before anything is written.
    const marksForSources = targets.map((_, index) => `?${index + 1}`).join(",");
    const { results: sources } = await env.DB.prepare(
      `SELECT DISTINCT source FROM documents WHERE doc_uid IN (${marksForSources})`,
    ).bind(...targets).all();
    if ((sources || []).some((row) => !OWNER_REMOVAL_SOURCES.includes(row.source))) {
      throw new RemovalPlanError("Clean my Brain removes Gmail and Drive items only; nothing was removed.",
        "OWNER_REMOVAL_SOURCE_UNSUPPORTED", 400);
    }
  }
  // forget's transaction fence is essential: a preflight read cannot prevent
  // another writer changing the corpus between that read and DELETE.
  let receipt;
  try {
    receipt = await forget(env, { docUids: targets, dryRun: false, ingestRemovalFence: marker, rememberRemoval });
  } catch (error) {
    // The batch is atomic, but a failure can still arrive after it committed.
    throw stageFailure(error, "delete_batch", "unknown");
  }
  const marks = targets.map(() => "?").join(",");
  let left;
  try {
    left = await env.DB.prepare(`SELECT doc_uid FROM documents WHERE doc_uid IN (${marks})`)
      .bind(...targets).all();
  } catch (error) {
    throw stageFailure(error, "readback", true);
  }
  let after;
  try {
    after = await ingestRemovalMarker(env);
  } catch (error) {
    throw stageFailure(error, "marker", true);
  }
  if (left.results.length || receipt.documents !== targets.length ||
      !same(receipt.ingest_removal_marker, after)) {
    throw new RemovalPlanError("Removal readback did not match the exact plan; plan ingestion again.", "INGEST_REMOVAL_UNVERIFIED", 409);
  }
  return { documents: receipt.documents, marker: receipt.ingest_removal_marker,
    ...(rememberRemoval ? { remembered: true, run_id: rememberRemoval.runId, batch_no: rememberRemoval.batchNo } : {}) };
}
