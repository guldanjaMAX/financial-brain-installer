import { forget, forgetFamilies } from "./store-d1.js";

const same = (a, b) => a?.instance === b?.instance && a?.nonce === b?.nonce && a?.generation === b?.generation && a?.runtime === b?.runtime;

export async function readIngestRemovalRequest(request) {
  const limit = 512 * 1024;
  if (Number(request.headers.get("content-length")) > limit || !request.body) throw new Error("Invalid removal request size.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Invalid removal request size.");
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
        ? ["action", "families", "marker"] : ["action", "targets", "marker"]).includes(key))) {
    throw new Error("Invalid removal request shape.");
  }
  return body;
}
export async function ingestRemovalMarker(env) {
  const row = await env.DB.prepare(
    "SELECT instance, nonce, generation FROM ingest_removal_generation WHERE id = 1",
  ).first();
  const runtime = env.INGEST_VERSION?.id;
  if (!row || !Number.isSafeInteger(row.generation) || !runtime) {
    throw new Error("The Brain needs the removal-plan migration and version binding before removal review.");
  }
  return { instance: row.instance, nonce: row.nonce, generation: row.generation, runtime };
}

/** The preview shares the actual family resolver, but never calls a writer. */
export async function previewIngestRemovals(env, { families = [], marker = null } = {}) {
  if (!Array.isArray(families) || families.length > 50) throw new Error("Removal preview needs at most 50 families.");
  const before = await ingestRemovalMarker(env);
  if (marker && !same(marker, before)) throw new Error("Stored inventory or runtime changed; plan ingestion again.");
  const result = await forgetFamilies(env, { families, dryRun: true });
  const after = await ingestRemovalMarker(env);
  if (!same(before, after)) throw new Error("Stored inventory changed during preview; plan ingestion again.");
  return { marker: after, targets: [...result.targets].sort(), documents: result.documents, excluded_documents: result.excluded_documents || 0 };
}

/** Apply exact physical identities, never a freshly expanded family selector. */
export async function applyIngestRemovals(env, { targets, marker } = {}) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 50 ||
      targets.some((uid) => typeof uid !== "string" || !uid) || new Set(targets).size !== targets.length) {
    throw new Error("Removal apply needs 1 to 50 exact document identities.");
  }
  if (!same(marker, await ingestRemovalMarker(env))) {
    throw new Error("Stored inventory or runtime changed; plan ingestion again.");
  }
  // forget's transaction fence is essential: a preflight read cannot prevent
  // another writer changing the corpus between that read and DELETE.
  const receipt = await forget(env, { docUids: targets, dryRun: false, ingestRemovalFence: marker });
  const marks = targets.map(() => "?").join(",");
  const left = await env.DB.prepare(`SELECT doc_uid FROM documents WHERE doc_uid IN (${marks})`)
    .bind(...targets).all();
  if (left.results.length || receipt.documents !== targets.length ||
      !same(receipt.ingest_removal_marker, await ingestRemovalMarker(env))) {
    throw new Error("Removal readback did not match the exact plan; plan ingestion again.");
  }
  return { documents: receipt.documents, marker: receipt.ingest_removal_marker };
}
