/**
 * Privacy-preserving identity and result receipts for directly observed source
 * originals. Locators are accepted only as transient HMAC inputs and are never
 * included as a raw locator field in the durable result-binding receipt.
 */

export const SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION = 1;
export const SOURCE_ORIGINAL_TENANT_ID = "primary";

const MAX_LOCATOR_BYTES = 2048;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ORIGINAL_ID_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const REVISION_ID_RE = /^rev-v1:[a-f0-9]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();

// This cache coalesces only concurrent reads. It is cleared after settlement,
// so recovery/import of a previously absent key is observable on the next call.
const signingKeyLoads = new WeakMap();

export class SourceOriginalBindingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SourceOriginalBindingError";
    this.status = status;
    this.code = code;
  }
}

const refuse = (code, message, status = 400) => {
  throw new SourceOriginalBindingError(status, code, message);
};

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length &&
    keys.every((key) => fields.includes(key)) && fields.every((key) => keys.includes(key));
}

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

async function sha256Id(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return `sha256:${hex(digest)}`;
}

export function normalizeSourceOriginalSource(value) {
  if (typeof value !== "string" || !SOURCE_RE.test(value)) {
    refuse("source_original_invalid_source", "source must be a normalized source id");
  }
  return value;
}

export function normalizeSourceOriginalLocator(locatorKind, locator) {
  if (locatorKind !== "source_relative_path") {
    refuse("source_original_invalid_locator_kind", "locator_kind is not supported");
  }
  if (typeof locator !== "string" || locator.length === 0 ||
      encoder.encode(locator).length > MAX_LOCATOR_BYTES || locator !== locator.normalize("NFC") ||
      locator.startsWith("/") || locator.endsWith("/") || locator.includes("\\") ||
      locator.includes("//") || CONTROL_RE.test(locator)) {
    refuse("source_original_invalid_locator", "target locator must be one canonical source-relative path");
  }
  const segments = locator.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    refuse("source_original_invalid_locator", "target locator must be one canonical source-relative path");
  }
  return Object.freeze({ locator_kind: locatorKind, locator });
}

/** Validate an exact private receipt admitted only through full-admin ingest. */
export function normalizeSourceOriginalReceipt(value) {
  const fields = [
    "version", "locator_kind", "original_content_sha256", "original_byte_count",
  ];
  if (!exactObject(value, fields)) {
    refuse("source_original_invalid_content_receipt", "source original receipt must use the exact contract");
  }
  if (value.version !== SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION) {
    refuse("source_original_binding_contract_unsupported", "source original receipt version is not supported");
  }
  if (value.locator_kind !== "source_relative_path") {
    refuse("source_original_invalid_locator_kind", "locator_kind is not supported");
  }
  if (!SHA_RE.test(value.original_content_sha256) ||
      !Number.isSafeInteger(value.original_byte_count) || value.original_byte_count < 0) {
    refuse("source_original_invalid_content_receipt", "source original receipt needs a hash and byte count");
  }
  return Object.freeze({
    version: SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION,
    locator_kind: value.locator_kind,
    original_content_sha256: value.original_content_sha256,
    original_byte_count: value.original_byte_count,
  });
}

async function readSourceOriginalSigningKey(db) {
  const row = await db.prepare(
    "SELECT tenant_id, signing_salt FROM source_original_id_key_state WHERE tenant_id=?1",
  ).bind(SOURCE_ORIGINAL_TENANT_ID).first();
  const secret = String(row?.signing_salt || "");
  if (row?.tenant_id !== SOURCE_ORIGINAL_TENANT_ID || !SHA_RE.test(secret)) {
    throw new SourceOriginalBindingError(
      503,
      "source_original_id_key_unavailable",
      "original identity key is unavailable",
    );
  }
  return crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

/** Load the schema-42 identity key, coalescing concurrent reads per D1 binding. */
export async function loadSourceOriginalSigningKey(env) {
  const db = env?.DB;
  if (!db || (typeof db !== "object" && typeof db !== "function")) {
    throw new TypeError("D1 database binding is unavailable");
  }
  const existing = signingKeyLoads.get(db);
  if (existing) return existing;

  const pending = readSourceOriginalSigningKey(db);
  signingKeyLoads.set(db, pending);
  try {
    return await pending;
  } finally {
    if (signingKeyLoads.get(db) === pending) signingKeyLoads.delete(db);
  }
}

/** Derive the exact schema-42 HMAC identity without retaining the locator. */
export async function deriveSourceOriginalId(signingKey, {
  source,
  locator_kind: locatorKind,
  locator,
} = {}) {
  const normalizedSource = normalizeSourceOriginalSource(source);
  const normalizedLocator = normalizeSourceOriginalLocator(locatorKind, locator);
  const input = [
    "financial-brain:source-original:v1",
    SOURCE_ORIGINAL_TENANT_ID,
    normalizedSource,
    normalizedLocator.locator_kind,
    normalizedLocator.locator,
  ].join("\0");
  const signature = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(input));
  return `hmac-sha256:${hex(signature)}`;
}

function normalizedResultBindingReceipt(value) {
  const fields = [
    "contract_version", "tenant_id", "source", "original_id", "locator_kind",
    "document_revision_id", "original_content_sha256", "original_byte_count",
    "document_content_hash", "provenance_receipt_digest",
  ];
  if (!exactObject(value, fields) ||
      value.contract_version !== SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION ||
      value.tenant_id !== SOURCE_ORIGINAL_TENANT_ID) {
    refuse("source_original_invalid_result_binding", "source original result binding must use the exact contract");
  }
  const source = normalizeSourceOriginalSource(value.source);
  if (!ORIGINAL_ID_RE.test(value.original_id) || value.locator_kind !== "source_relative_path" ||
      !REVISION_ID_RE.test(value.document_revision_id) ||
      !SHA_RE.test(value.original_content_sha256) ||
      !Number.isSafeInteger(value.original_byte_count) || value.original_byte_count < 0 ||
      !SHA_RE.test(value.document_content_hash) || !SHA_RE.test(value.provenance_receipt_digest)) {
    refuse("source_original_invalid_result_binding", "source original result binding fields are invalid");
  }
  return Object.freeze({
    contract_version: SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION,
    tenant_id: SOURCE_ORIGINAL_TENANT_ID,
    source,
    original_id: value.original_id,
    locator_kind: value.locator_kind,
    document_revision_id: value.document_revision_id,
    original_content_sha256: value.original_content_sha256,
    original_byte_count: value.original_byte_count,
    document_content_hash: value.document_content_hash,
    provenance_receipt_digest: value.provenance_receipt_digest,
  });
}

/** Recompute the deterministic receipt hash used for exact D1 readback. */
export async function hashSourceOriginalResultBinding(receipt) {
  return sha256Id(canonical(normalizedResultBindingReceipt(receipt)));
}

/**
 * Seal a transient locator and exact-byte receipt into a durable result
 * binding. The returned receipt intentionally has no raw locator field.
 */
export async function createSourceOriginalResultBinding(env, {
  source,
  locator,
  source_original_receipt: sourceOriginalReceipt,
  document_revision_id: documentRevisionId,
  document_content_hash: documentContentHash,
  provenance_receipt_digest: provenanceReceiptDigest,
} = {}) {
  const normalizedSource = normalizeSourceOriginalSource(source);
  const rawReceipt = normalizeSourceOriginalReceipt(sourceOriginalReceipt);
  const transientLocator = normalizeSourceOriginalLocator(rawReceipt.locator_kind, locator);
  const signingKey = await loadSourceOriginalSigningKey(env);
  const originalId = await deriveSourceOriginalId(signingKey, {
    source: normalizedSource,
    ...transientLocator,
  });
  const receipt = normalizedResultBindingReceipt({
    contract_version: SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION,
    tenant_id: SOURCE_ORIGINAL_TENANT_ID,
    source: normalizedSource,
    original_id: originalId,
    locator_kind: rawReceipt.locator_kind,
    document_revision_id: documentRevisionId,
    original_content_sha256: rawReceipt.original_content_sha256,
    original_byte_count: rawReceipt.original_byte_count,
    document_content_hash: documentContentHash,
    provenance_receipt_digest: provenanceReceiptDigest,
  });
  return Object.freeze({
    receipt,
    binding_hash: await hashSourceOriginalResultBinding(receipt),
  });
}
