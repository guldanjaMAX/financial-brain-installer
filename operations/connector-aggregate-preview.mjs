const RECEIPT_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "source",
  "dry_run",
  "aggregate_only",
  "status",
  "scope",
  "counts",
  "removal_candidates",
  "coverage",
  "failure",
]);
const COUNT_KEYS = Object.freeze([
  "observed",
  "would_send",
  "unchanged",
  "skipped",
  "removal_candidates",
]);
const REMOVAL_KEYS = Object.freeze([
  "source_policy",
  "source_deleted",
  "intentional_skip",
]);
const COVERAGE_KEYS = Object.freeze([
  "complete",
  "bounded",
  "units_total",
  "units_succeeded",
  "units_failed",
]);
const FAILURE_KEYS = Object.freeze(["code", "retryable"]);

export const CONNECTOR_AGGREGATE_PREVIEW_SCHEMA_VERSION = 1;
export const CONNECTOR_AGGREGATE_PREVIEW_KIND = "connector_aggregate_preview";
export const CONNECTOR_AGGREGATE_PREVIEW_SOURCES = Object.freeze(["drive", "calendar"]);
export const CONNECTOR_AGGREGATE_PREVIEW_STATUSES = Object.freeze([
  "complete",
  "incomplete",
  "failed",
]);
export const CONNECTOR_AGGREGATE_PREVIEW_SCOPES = Object.freeze([
  "full",
  "incremental",
  "mixed",
  "unknown",
]);
export const CONNECTOR_AGGREGATE_PREVIEW_FAILURE_CODES = Object.freeze([
  "PREVIEW_BOUNDED",
  "PROVIDER_SCOPE_INCOMPLETE",
  "SOURCE_COVERAGE_INCOMPLETE",
  "BRAIN_EFFECT_UNKNOWN",
  "INVALID_REQUEST",
  "MANIFEST_UNAVAILABLE",
  "AUTH_REQUIRED",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "NETWORK_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "PREVIEW_FAILED",
]);

const SOURCE_SET = new Set(CONNECTOR_AGGREGATE_PREVIEW_SOURCES);
const RECEIPT_SOURCE_SET = new Set([...CONNECTOR_AGGREGATE_PREVIEW_SOURCES, "unknown"]);
const STATUS_SET = new Set(CONNECTOR_AGGREGATE_PREVIEW_STATUSES);
const SCOPE_SET = new Set(CONNECTOR_AGGREGATE_PREVIEW_SCOPES);
const FAILURE_CODE_SET = new Set(CONNECTOR_AGGREGATE_PREVIEW_FAILURE_CODES);
const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has fields outside the versioned aggregate preview schema`);
  }
}

function assertCount(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer${nullable ? " or null" : ""}`);
  }
}

function frozenReceipt(receipt) {
  Object.freeze(receipt.counts);
  Object.freeze(receipt.removal_candidates);
  Object.freeze(receipt.coverage);
  if (receipt.failure) Object.freeze(receipt.failure);
  return Object.freeze(receipt);
}

/**
 * Return whether the explicit aggregate mode was selected, while refusing any
 * spelling that could be mistaken for a working privacy boundary.
 */
export function aggregateConnectorPreviewRequested(flags = {}, source = "") {
  const requested = flags["aggregate-json"];
  if (requested === undefined) return false;
  if (requested !== true) throw new TypeError("--aggregate-json does not take a value");
  if (flags["dry-run"] !== true) {
    throw new TypeError("--aggregate-json requires --dry-run; aggregate output never accompanies a write");
  }
  const normalized = String(source || "").trim().toLowerCase();
  if (!SOURCE_SET.has(normalized)) {
    throw new TypeError("--aggregate-json currently supports only --from drive and --from calendar");
  }
  return true;
}

/**
 * Count candidate identities without returning any of them. The precedence is
 * the same as the real removal planner, so a candidate appearing for two
 * reasons is counted once and assigned to its first authoritative reason.
 */
export function aggregateRemovalCandidateCounts({
  sourcePolicy = [],
  sourceDeleted = [],
  intentionalSkip = [],
} = {}) {
  const assigned = new Set();
  const count = (values) => {
    const unique = new Set([...values].map((value) => String(value || "")).filter(Boolean));
    let total = 0;
    for (const value of unique) {
      if (assigned.has(value)) continue;
      assigned.add(value);
      total++;
    }
    return total;
  };
  return Object.freeze({
    source_policy: count(sourcePolicy),
    source_deleted: count(sourceDeleted),
    intentional_skip: count(intentionalSkip),
  });
}

/** Validate the exact machine contract. Unknown fields fail closed. */
export function assertConnectorAggregatePreviewReceipt(receipt) {
  assertExactKeys(receipt, RECEIPT_KEYS, "aggregate preview receipt");
  if (receipt.schema_version !== CONNECTOR_AGGREGATE_PREVIEW_SCHEMA_VERSION ||
      receipt.kind !== CONNECTOR_AGGREGATE_PREVIEW_KIND ||
      receipt.dry_run !== true || receipt.aggregate_only !== true) {
    throw new TypeError("aggregate preview receipt identity is invalid");
  }
  if (!RECEIPT_SOURCE_SET.has(receipt.source)) throw new TypeError("aggregate preview source is invalid");
  if (!STATUS_SET.has(receipt.status)) throw new TypeError("aggregate preview status is invalid");
  if (!SCOPE_SET.has(receipt.scope)) throw new TypeError("aggregate preview scope is invalid");

  assertExactKeys(receipt.counts, COUNT_KEYS, "aggregate preview counts");
  assertExactKeys(receipt.removal_candidates, REMOVAL_KEYS, "aggregate preview removal candidates");
  assertExactKeys(receipt.coverage, COVERAGE_KEYS, "aggregate preview coverage");
  for (const [key, value] of Object.entries(receipt.counts)) {
    assertCount(value, `counts.${key}`, { nullable: true });
  }
  for (const [key, value] of Object.entries(receipt.removal_candidates)) {
    assertCount(value, `removal_candidates.${key}`, { nullable: true });
  }
  for (const key of ["units_total", "units_succeeded", "units_failed"]) {
    assertCount(receipt.coverage[key], `coverage.${key}`, { nullable: true });
  }
  if (typeof receipt.coverage.complete !== "boolean" || typeof receipt.coverage.bounded !== "boolean") {
    throw new TypeError("aggregate preview coverage flags must be boolean");
  }

  const removalValues = Object.values(receipt.removal_candidates);
  if (receipt.counts.removal_candidates !== null && removalValues.every((value) => value !== null)) {
    const total = removalValues.reduce((sum, value) => sum + value, 0);
    if (receipt.counts.removal_candidates !== total) {
      throw new TypeError("aggregate preview removal total does not match its categories");
    }
  }
  const units = [
    receipt.coverage.units_total,
    receipt.coverage.units_succeeded,
    receipt.coverage.units_failed,
  ];
  if (units.every((value) => value !== null) && units[1] + units[2] !== units[0]) {
    throw new TypeError("aggregate preview coverage units do not add up");
  }
  if (receipt.status === "complete" && [
    ...Object.values(receipt.counts),
    ...removalValues,
    ...units,
  ].some((value) => value === null)) {
    throw new TypeError("a complete aggregate preview cannot contain unknown counts");
  }

  if (receipt.failure === null) {
    if (receipt.status !== "complete" || receipt.coverage.complete !== true || receipt.coverage.bounded) {
      throw new TypeError("only an unbounded complete aggregate preview may omit failure");
    }
  } else {
    assertExactKeys(receipt.failure, FAILURE_KEYS, "aggregate preview failure");
    if (!FAILURE_CODE_SET.has(receipt.failure.code) || typeof receipt.failure.retryable !== "boolean") {
      throw new TypeError("aggregate preview failure is invalid");
    }
    if (receipt.status === "complete" || receipt.coverage.complete) {
      throw new TypeError("an incomplete aggregate preview must carry non-complete status and coverage");
    }
  }
  if (receipt.source === "unknown" &&
      (receipt.status !== "failed" || receipt.failure?.code !== "INVALID_REQUEST")) {
    throw new TypeError("an unknown aggregate preview source is valid only for an invalid request");
  }
  return receipt;
}

export function connectorAggregatePreviewReceipt({
  source,
  status,
  scope,
  counts,
  removalCandidates,
  coverage,
  failure = null,
}) {
  const receipt = {
    schema_version: CONNECTOR_AGGREGATE_PREVIEW_SCHEMA_VERSION,
    kind: CONNECTOR_AGGREGATE_PREVIEW_KIND,
    source,
    dry_run: true,
    aggregate_only: true,
    status,
    scope,
    counts: {
      observed: counts.observed,
      would_send: counts.would_send,
      unchanged: counts.unchanged,
      skipped: counts.skipped,
      removal_candidates: counts.removal_candidates,
    },
    removal_candidates: {
      source_policy: removalCandidates.source_policy,
      source_deleted: removalCandidates.source_deleted,
      intentional_skip: removalCandidates.intentional_skip,
    },
    coverage: {
      complete: coverage.complete,
      bounded: coverage.bounded,
      units_total: coverage.units_total,
      units_succeeded: coverage.units_succeeded,
      units_failed: coverage.units_failed,
    },
    failure: failure === null ? null : {
      code: failure.code,
      retryable: failure.retryable,
    },
  };
  assertConnectorAggregatePreviewReceipt(receipt);
  return frozenReceipt(receipt);
}

function emptyFailureReceipt(source, code, retryable) {
  return connectorAggregatePreviewReceipt({
    source,
    status: "failed",
    scope: "unknown",
    counts: {
      observed: null,
      would_send: null,
      unchanged: null,
      skipped: null,
      removal_candidates: null,
    },
    removalCandidates: {
      source_policy: null,
      source_deleted: null,
      intentional_skip: null,
    },
    coverage: {
      complete: false,
      bounded: false,
      units_total: null,
      units_succeeded: null,
      units_failed: null,
    },
    failure: { code, retryable },
  });
}

export function connectorAggregatePreviewRequestFailure(source) {
  return emptyFailureReceipt(source, "INVALID_REQUEST", false);
}

export function connectorAggregatePreviewManifestFailure(source) {
  return emptyFailureReceipt(source, "MANIFEST_UNAVAILABLE", false);
}

export function connectorAggregatePreviewFailure(source, error) {
  const status = Number(error?.providerStatus ?? error?.status);
  const errorCode = String(error?.code || error?.cause?.code || "").toUpperCase();
  const errorName = String(error?.name || "");
  let code = "PREVIEW_FAILED";
  let retryable = false;
  if (error?.needsReauth === true || error?.needsReconsent === true || status === 401) {
    code = "AUTH_REQUIRED";
  } else if (status === 403) {
    code = "PERMISSION_DENIED";
  } else if (status === 429) {
    code = "RATE_LIMITED";
    retryable = true;
  } else if (status >= 500 && status <= 599) {
    code = "PROVIDER_UNAVAILABLE";
    retryable = true;
  } else if (NETWORK_CODES.has(errorCode) || errorName === "AbortError" || errorName === "TimeoutError") {
    code = "NETWORK_UNAVAILABLE";
    retryable = true;
  }
  return emptyFailureReceipt(source, code, retryable);
}

export function renderConnectorAggregatePreview(receipt) {
  return `${JSON.stringify(assertConnectorAggregatePreviewReceipt(receipt), null, 2)}\n`;
}
