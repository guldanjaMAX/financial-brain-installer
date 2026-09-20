/**
 * Privacy-safe failure contract for connector source receipts.
 *
 * Provider errors can contain filenames, account names, remote identifiers,
 * request URLs, or source content. They are useful in the private local
 * terminal, but they are not safe durable metadata. The Worker therefore
 * accepts only one of these closed issue codes for an error receipt and treats
 * every missing or unknown value as the generic INGEST_FAILED code.
 */
export const SOURCE_RECEIPT_ISSUE_CODES = Object.freeze([
  "AUTH_DENIED",
  "AUTH_EXPIRED",
  "AUTH_REQUIRED",
  "COMMAND_FAILED",
  "CONFIG_INVALID",
  "EXTRACTION_FAILED",
  "FORMAT_UNSUPPORTED",
  "HEALTH_CHECK_FAILED",
  "INDEX_WRITE_FAILED",
  "INGEST_FAILED",
  "INPUT_REFUSED",
  "INTERNAL_ERROR",
  "MIGRATION_FAILED",
  "NETWORK_UNREACHABLE",
  "PDF_PROCESS_FAILED",
  "PDF_PROCESS_TIMEOUT",
  "RATE_LIMITED",
  "REMOTE_NOT_FOUND",
  "REMOTE_PERMISSION_DENIED",
  "REMOTE_UNAVAILABLE",
  "SAFETY_REVIEW_REQUIRED",
  "SCHEDULE_INSTALL_FAILED",
  "SCHEDULE_RUN_FAILED",
  "UPGRADE_FAILED",
  "VECTOR_DRAIN_FAILED",
]);

const ISSUE_CODES = new Set(SOURCE_RECEIPT_ISSUE_CODES);
export const DEFAULT_SOURCE_RECEIPT_ISSUE_CODE = "INGEST_FAILED";

export const SOURCE_FAILURE_EVIDENCE_VERSION = 1;
export const GMAIL_FAILURE_OPERATION_CLASSES = Object.freeze([
  "gmail_profile_read",
  "gmail_history_list",
  "gmail_message_list",
  "gmail_policy_read",
  "gmail_message_read",
  "gmail_unknown",
]);
export const GOOGLE_PROVIDER_REASON_CODES = Object.freeze([
  "access_not_configured",
  "auth_error",
  "backend_error",
  "daily_limit_exceeded",
  "failed_precondition",
  "forbidden",
  "insufficient_permissions",
  "invalid_argument",
  "not_found",
  "permission_denied",
  "quota_exceeded",
  "rate_limit_exceeded",
  "resource_exhausted",
  "unauthenticated",
  "unavailable",
  "unknown",
  "user_rate_limit_exceeded",
]);

const GMAIL_FAILURE_OPERATIONS = new Set(GMAIL_FAILURE_OPERATION_CLASSES);
const GMAIL_DOCUMENT_FAILURE_OPERATIONS = new Set([
  "gmail_policy_read",
  "gmail_message_read",
]);
const GOOGLE_PROVIDER_REASONS = new Set(GOOGLE_PROVIDER_REASON_CODES);
const SOURCE_FAILURE_EVIDENCE_KEYS = Object.freeze([
  "version",
  "operation_class",
  "http_status",
  "provider_reason",
  "checkpoint_readback",
  "checkpoint_done",
  "checkpoint_skipped",
  "cursor_preservation",
]);
const GOOGLE_PROVIDER_REASON_ALIASES = new Map([
  ["accessnotconfigured", "access_not_configured"],
  ["autherror", "auth_error"],
  ["backenderror", "backend_error"],
  ["dailylimitexceeded", "daily_limit_exceeded"],
  ["failedprecondition", "failed_precondition"],
  ["forbidden", "forbidden"],
  ["insufficientpermissions", "insufficient_permissions"],
  ["invalidargument", "invalid_argument"],
  ["notfound", "not_found"],
  ["permissiondenied", "permission_denied"],
  ["quotaexceeded", "quota_exceeded"],
  ["ratelimitexceeded", "rate_limit_exceeded"],
  ["resourceexhausted", "resource_exhausted"],
  ["unauthenticated", "unauthenticated"],
  ["unavailable", "unavailable"],
  ["userratelimitexceeded", "user_rate_limit_exceeded"],
]);

const isPlainRecord = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Collapse a provider-owned reason into a closed metadata category in memory. */
export function canonicalGoogleProviderReason(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const key = String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return GOOGLE_PROVIDER_REASON_ALIASES.get(key) || "unknown";
}

/**
 * Validate and reconstruct safe Gmail failure evidence at the Worker boundary.
 *
 * Exact keys and closed values prevent a connector from smuggling a provider
 * message, remote id, token, path, or source content into durable metadata.
 */
export function normalizeSourceFailureEvidence(value, {
  status,
  kind,
  metricsVersion = null,
  measuredDocsFailed = null,
} = {}) {
  if (value === null || value === undefined) return null;
  if (status !== "error" || kind !== "gmail") {
    throw new TypeError("failure_evidence is permitted only for Gmail error receipts");
  }
  if (!isPlainRecord(value)) throw new TypeError("failure_evidence must be a plain object");
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !SOURCE_FAILURE_EVIDENCE_KEYS.includes(key));
  const missing = SOURCE_FAILURE_EVIDENCE_KEYS.find((key) => !Object.hasOwn(value, key));
  if (unexpected || missing || keys.length !== SOURCE_FAILURE_EVIDENCE_KEYS.length) {
    throw new TypeError("failure_evidence must contain exactly the version 1 fields");
  }
  if (value.version !== SOURCE_FAILURE_EVIDENCE_VERSION) {
    throw new TypeError("failure_evidence.version must be 1");
  }
  if (!GMAIL_FAILURE_OPERATIONS.has(value.operation_class)) {
    throw new TypeError("failure_evidence.operation_class is unsupported");
  }
  if (metricsVersion !== null && metricsVersion !== 0 && metricsVersion !== 1) {
    throw new TypeError("metricsVersion must be 0, 1, or null");
  }
  const hasMeasuredOutcomes = metricsVersion === 1 || measuredDocsFailed !== null;
  if (hasMeasuredOutcomes && !(
    typeof measuredDocsFailed === "number" && Number.isSafeInteger(measuredDocsFailed) && measuredDocsFailed >= 0
  )) {
    throw new TypeError("measuredDocsFailed must be a non-negative safe integer for measured outcomes");
  }
  if (hasMeasuredOutcomes && GMAIL_DOCUMENT_FAILURE_OPERATIONS.has(value.operation_class) && measuredDocsFailed === 0) {
    throw new TypeError("a measured Gmail document-operation failure requires docs_failed of at least 1");
  }
  if (value.http_status !== null && !(
    typeof value.http_status === "number" && Number.isSafeInteger(value.http_status) &&
    value.http_status >= 100 && value.http_status <= 599
  )) {
    throw new TypeError("failure_evidence.http_status must be an HTTP status integer or null");
  }
  if (value.provider_reason !== null && !GOOGLE_PROVIDER_REASONS.has(value.provider_reason)) {
    throw new TypeError("failure_evidence.provider_reason is unsupported");
  }
  if (value.provider_reason !== null && value.http_status === null) {
    throw new TypeError("failure_evidence.provider_reason requires an HTTP status");
  }
  if (!["verified", "unverified"].includes(value.checkpoint_readback)) {
    throw new TypeError("failure_evidence.checkpoint_readback is unsupported");
  }
  for (const field of ["checkpoint_done", "checkpoint_skipped"]) {
    if (value[field] !== null && !(
      typeof value[field] === "number" && Number.isSafeInteger(value[field]) && value[field] >= 0
    )) {
      throw new TypeError(`failure_evidence.${field} must be a non-negative safe integer or null`);
    }
  }
  if (!["present_preserved", "absent_preserved", "changed", "unverified"].includes(value.cursor_preservation)) {
    throw new TypeError("failure_evidence.cursor_preservation is unsupported");
  }
  if (value.checkpoint_readback === "verified") {
    if (value.checkpoint_done === null || value.checkpoint_skipped === null || value.cursor_preservation === "unverified") {
      throw new TypeError("verified failure_evidence requires measured checkpoints and cursor comparison");
    }
  } else if (
    value.checkpoint_done !== null || value.checkpoint_skipped !== null ||
    value.cursor_preservation !== "unverified"
  ) {
    throw new TypeError("unverified failure_evidence cannot claim checkpoints or cursor preservation");
  }
  return Object.freeze({
    version: SOURCE_FAILURE_EVIDENCE_VERSION,
    operation_class: value.operation_class,
    http_status: value.http_status,
    provider_reason: value.provider_reason,
    checkpoint_readback: value.checkpoint_readback,
    checkpoint_done: value.checkpoint_done,
    checkpoint_skipped: value.checkpoint_skipped,
    cursor_preservation: value.cursor_preservation,
  });
}

/** Parse old or corrupt durable evidence without returning arbitrary JSON. */
export function parseStoredSourceFailureEvidence(value, context = {}) {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeSourceFailureEvidence(JSON.parse(value), context);
  } catch {
    return null;
  }
}

/** Normalize an untrusted receipt value against the server-owned allowlist. */
export function normalizeSourceReceiptIssueCode(value) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ISSUE_CODES.has(candidate) ? candidate : DEFAULT_SOURCE_RECEIPT_ISSUE_CODE;
}

/**
 * Classify a local connector failure without returning or retaining its text.
 * The message is inspected only in memory as a compatibility path for errors
 * that do not yet expose a typed code.
 */
export function sourceReceiptIssueCode(error, fallback = DEFAULT_SOURCE_RECEIPT_ISSUE_CODE) {
  const typed = [error?.code, error?.payload?.error_code, error?.payload?.issue_code]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toUpperCase());
  const safetySignals = [error, error?.payload]
    .filter((value) => value && typeof value === "object");
  if (safetySignals.some((value) =>
    value.uncertain === true || value.outcome_unknown === true || value.retry_safe === false
  ) || typed.some((value) => [
    "OAUTH_RESPONSE_UNCERTAIN",
    "REFRESH_OUTCOME_UNKNOWN",
    "PLAID_EXCHANGE_OUTCOME_UNKNOWN",
    "PLAID_REMOVE_OUTCOME_UNKNOWN",
    "PROVIDER_DELETION_NOT_CONFIRMED",
    "PROVIDER_REMOVAL_REVIEW_REQUIRED",
    "PROVIDER_SNAPSHOT_REMOVAL_REVIEW_REQUIRED",
  ].includes(value))) return "SAFETY_REVIEW_REQUIRED";

  const stable = typed.find((value) => ISSUE_CODES.has(value));
  if (stable) return stable;
  if (typed.some((value) => ["ACCESS_DENIED", "OWNER_CANCELED"].includes(value))) return "AUTH_DENIED";
  if (typed.includes("REFRESH_EXPIRED")) return "AUTH_EXPIRED";
  if (typed.some((value) => [
    "MISSING_REFRESH_TOKEN",
    "NOT_CONNECTED",
    "SOURCE_BINDING_MISSING",
  ].includes(value))) return "AUTH_REQUIRED";
  if (typed.some((value) => [
    "SOURCE_BINDING_CORRUPT",
    "SOURCE_BINDING_REQUIRED",
    "UNEXPECTED_COMPANY",
    "WRONG_ENVIRONMENT",
    "WRONG_REALM",
    "PROVIDER_IDENTITY_CONFLICT",
  ].includes(value))) return "SAFETY_REVIEW_REQUIRED";
  if (typed.some((value) => [
    "INVALID_PROVIDER_IDENTITY",
    "INVALID_PROVIDER_TOMBSTONE",
    "INVALID_INGEST_RECEIPT",
  ].includes(value))) return "CONFIG_INVALID";

  const message = String(error?.message || "");
  if (/PDF.*tim(?:e|ed) out/i.test(message)) return "PDF_PROCESS_TIMEOUT";
  if (/PDF.*process/i.test(message)) return "PDF_PROCESS_FAILED";
  if (/timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND/i.test(message)) return "NETWORK_UNREACHABLE";
  if (/rate.?limit|\b429\b/i.test(message)) return "RATE_LIMITED";
  if (/\b401\b|expired.*(?:auth|token)|reauthori[sz]/i.test(message)) return "AUTH_EXPIRED";
  if (/\b403\b|forbidden|permission denied|not permitted/i.test(message)) return "REMOTE_PERMISSION_DENIED";
  if (/admin key|credential.*(?:missing|required)|token is not set|sign.?in|required.*auth/i.test(message)) {
    return "AUTH_REQUIRED";
  }
  if (/not found|\b404\b/i.test(message)) return "REMOTE_NOT_FOUND";
  if (/extract/i.test(message)) return "EXTRACTION_FAILED";
  return normalizeSourceReceiptIssueCode(fallback);
}

const OWNER_MESSAGES = Object.freeze({
  AUTH_DENIED: "The connection was not authorized. Your installer can help reconnect it.",
  AUTH_EXPIRED: "The connection needs to be refreshed. Your installer can help reconnect it.",
  AUTH_REQUIRED: "This source needs to be connected before it can update.",
  CONFIG_INVALID: "This source needs a setup adjustment before it can update.",
  EXTRACTION_FAILED: "Some source material could not be prepared. Your installer can help review it and try again.",
  FORMAT_UNSUPPORTED: "Some source material uses a format that is not supported yet.",
  INDEX_WRITE_FAILED: "The latest update reached the brain but could not finish indexing. Your installer can safely retry it.",
  INGEST_FAILED: "The latest update did not finish. Your installer can safely retry it.",
  INPUT_REFUSED: "Some source material was held for review before it could be added.",
  NETWORK_UNREACHABLE: "The source could not be reached. It is safe to try again when the connection is available.",
  PDF_PROCESS_FAILED: "A PDF could not be prepared. Your installer can help review it and try again.",
  PDF_PROCESS_TIMEOUT: "A PDF took too long to prepare. Your installer can safely retry it.",
  RATE_LIMITED: "The source asked the brain to wait. It is safe to try again later.",
  REMOTE_NOT_FOUND: "The connected source could not be found. Your installer can help review the connection.",
  REMOTE_PERMISSION_DENIED: "The source did not allow this update. Your installer can help review its access.",
  REMOTE_UNAVAILABLE: "The source is temporarily unavailable. It is safe to try again later.",
  SAFETY_REVIEW_REQUIRED: "The latest update paused for a safety review. Your installer can help confirm the next step.",
  VECTOR_DRAIN_FAILED: "The latest update is stored, but search indexing still needs attention from your installer.",
});

/** Render only reviewed owner-facing copy, never a caller-supplied reason. */
export function sourceReceiptOwnerMessage(issueCode) {
  const code = normalizeSourceReceiptIssueCode(issueCode);
  return OWNER_MESSAGES[code] || OWNER_MESSAGES[DEFAULT_SOURCE_RECEIPT_ISSUE_CODE];
}

/** Stable refusal when one source name is already bound to another connector. */
export const SOURCE_KIND_CONFLICT = "SOURCE_KIND_CONFLICT";

export class SourceKindConflictError extends Error {
  constructor({ source, requestedKind, existingKind }) {
    super("source is already registered with a different connector kind");
    this.name = "SourceKindConflictError";
    this.code = SOURCE_KIND_CONFLICT;
    this.source = source;
    this.requested_kind = requestedKind;
    this.existing_kind = existingKind;
  }
}

/**
 * Resolve the immutable connector identity for a source before mutating any
 * lifecycle state. `sources.name` is the authorization scope and historical
 * documents read `sources.kind` at query time, so changing kind would relabel
 * every older record. An omitted kind preserves an existing binding; an
 * explicit conflicting kind is refused.
 */
export async function resolveSourceKind(env, {
  source, requestedKind = null, defaultKind,
}) {
  const requested = requestedKind || defaultKind;
  const at = new Date().toISOString();
  // This statement is both the first registration and the conflict check. A
  // SELECT followed by a later UPSERT lets two first-time callers choose
  // different kinds and lets the losing request write lifecycle receipts even
  // though its source mutation no-ops. Historical unregistered documents are
  // also a closed boundary: dynamically attaching a connector kind would
  // relabel those rows during retrieval.
  const claimed = await env.DB.prepare(
    `INSERT INTO sources (name,kind,status,created_at)
     SELECT ?1,
            COALESCE(?2, (SELECT lower(trim(kind)) FROM sources WHERE name=?1), ?3),
            'pending', ?4
      WHERE EXISTS (SELECT 1 FROM sources WHERE name=?1)
         OR NOT EXISTS (SELECT 1 FROM documents WHERE source=?1)
     ON CONFLICT(name) DO UPDATE SET kind=excluded.kind
       WHERE lower(trim(sources.kind))=excluded.kind
     RETURNING lower(trim(kind)) AS kind`
  ).bind(source, requestedKind, defaultKind, at).first();
  const kind = String(claimed?.kind || "").trim().toLowerCase();
  if (!kind) {
    throw new SourceKindConflictError({
      source,
      requestedKind: requested,
      existingKind: "unregistered-or-conflicting",
    });
  }
  return { kind, existing: true };
}

export function isSourceKindConflict(error) {
  return error?.code === SOURCE_KIND_CONFLICT;
}
