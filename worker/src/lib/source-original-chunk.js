/**
 * Opaque commitments for the exact stored chunk bytes of a bound document
 * revision. The full stored text includes the title prefix used by retrieval;
 * neither that text nor its title belongs in a durable family receipt.
 */

const REVISION_ID_RE = /^rev-v1:[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash the exact revision/index/title/text tuple stored and searched in D1.
 * A title-bearing chunk must already contain the production title prefix.
 */
export async function sourceOriginalChunkReceiptHash({
  document_revision_id: documentRevisionId,
  chunk_ix: chunkIndex,
  title = null,
  text,
} = {}) {
  if (!REVISION_ID_RE.test(documentRevisionId || "") ||
      !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
      (title !== null && typeof title !== "string") || typeof text !== "string") {
    throw new TypeError("source original chunk receipt fields are invalid");
  }
  if (title && !text.startsWith(`[${title}]\n\n`)) {
    throw new TypeError("source original chunk receipt does not include the stored title prefix");
  }
  const receipt = {
    contract_version: 1,
    document_revision_id: documentRevisionId,
    chunk_ix: chunkIndex,
    title,
    text,
  };
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical(receipt)));
  return `sha256:${hex(digest)}`;
}
