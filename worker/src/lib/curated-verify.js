import { backendOf, D1, expectedD1ContentHash } from "./store.js";
import { normalizeIngestEnvelopeProvenance } from "./provenance-receipt.js";
import { ingestEnvelopeValidationError } from "./ingest-envelope.js";
import { sanitizeEnvelope } from "./secret-scan.js";
import { jsonResponse, privateNoStore } from "./core.js";

const MAX_BYTES = 2 * 1024 * 1024;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// D1 applies JSON Merge Patch: null object members remove prior values.
function patchedMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null)
    .map(([key, item]) => [key, patchedMetadata(item)]));
}

async function readEnvelope(request) {
  if (!request.body || Number(request.headers.get("content-length")) > MAX_BYTES) throw new Error();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Read-only, full-admin-only confirmation of the current durable envelope. */
export async function handleCuratedVerify(env, request) {
  const respond = (body, status = 200) => privateNoStore(jsonResponse(body, status));
  if (backendOf(env) !== D1) return respond({ error: "curated verification requires D1" }, 409);
  let submitted;
  try { submitted = await readEnvelope(request); }
  catch { return respond({ error: "invalid curated verification body" }, 400); }
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) ||
      Object.keys(submitted).some(key => !["source_type", "source_id", "title", "content", "metadata"].includes(key)) ||
      submitted.source_type !== "curated" || typeof submitted.title !== "string") {
    return respond({ error: "invalid curated verification envelope" }, 400);
  }
  try {
    const safe = sanitizeEnvelope(submitted);
    const envelope = normalizeIngestEnvelopeProvenance(safe);
    if (ingestEnvelopeValidationError(envelope)) return respond({ error: "invalid curated verification envelope" }, 400);
    const uid = `curated:${envelope.source_id}`;
    const hash = await expectedD1ContentHash(env, envelope);
    // A replica older than the acknowledged write cannot establish freshness.
    const db = env.DB.withSession ? env.DB.withSession("first-primary") : env.DB;
    const row = await db.prepare(`SELECT doc_uid, source, source_id, title, content_hash, meta
      FROM documents WHERE doc_uid=?1 AND deleted_at IS NULL`).bind(uid).first();
    const metadata = row ? JSON.parse(row.meta || "{}") : null;
    const confirmed = row?.doc_uid === uid && row?.source === "curated" &&
      row?.source_id === envelope.source_id && row?.content_hash === hash &&
      row?.title === envelope.title && canonical(metadata) === canonical(patchedMetadata(envelope.metadata));
    const neutral = { title: safe.title, content: safe.content, metadata: safe.metadata };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      `curated-sync-envelope-v1\0${canonical(neutral)}`));
    const envelopeHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return respond({ doc_uid: uid, confirmed: Boolean(confirmed), envelope_sha256: confirmed ? envelopeHash : null });
  } catch {
    // Neither private input nor database/transport exception text may escape.
    return respond({ error: "curated revision verification unavailable" }, 503);
  }
}
