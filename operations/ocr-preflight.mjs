/**
 * Aggregate-only planning contract for local scanned-PDF OCR.
 *
 * This policy module deliberately owns no filesystem, key-store, HTTP, Brain,
 * or model capability. The CLI gives it content-free extraction observations
 * from local reads and it returns only counts and ranges. Operating-system file
 * provider effects from those reads remain unknown. Exact keys are versioned
 * so a future caller cannot accidentally add a filename, path, parser error,
 * or document content to machine-readable output.
 */

export const OCR_PREFLIGHT_SCHEMA_VERSION = 1;
export const OCR_PREFLIGHT_KIND = "local_ocr_preflight";
export const OCR_PREFLIGHT_DEFAULT_MAX_PAGES_PER_DOCUMENT = 40;
export const OCR_PREFLIGHT_DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const OCR_PREFLIGHT_PRICING_BASIS_VERSION = 1;

const OCR_PREFLIGHT_PRICED_RANGE = Object.freeze({
  input_usd_per_m: 0.1,
  output_usd_per_m: 0.3,
  input_tokens_per_page_low: 2_000,
  input_tokens_per_page_high: 4_000,
  output_tokens_per_page_low: 400,
  output_tokens_per_page_high: 1_200,
  seconds_per_page_low: 1,
  seconds_per_page_high: 3,
});

export const OCR_PREFLIGHT_FAILURE_CODES = Object.freeze([
  "INVALID_REQUEST",
  "MANIFEST_UNAVAILABLE",
  "MANIFEST_POLICY_INVALID",
  "SOURCE_UNAVAILABLE",
  "DEPENDENCIES_UNAVAILABLE",
  "PREFLIGHT_FAILED",
]);

const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "plan_fingerprint",
  "dry_run",
  "read_only",
  "aggregate_only",
  "status",
  "coverage",
  "policy",
  "pricing_basis",
  "affected_documents",
  "pages",
  "estimate",
  "unknown_or_uninspectable",
  "actions",
  "local_file_read_effects",
  "failure",
]);
const COVERAGE_KEYS = Object.freeze([
  "filesystem_scope_complete",
  "plan_complete",
  "pdf_documents_observed",
  "pdf_documents_inspected",
  "pdf_documents_uninspectable",
  "scope_items_uninspectable",
]);
const POLICY_KEYS = Object.freeze([
  "ocr_enabled",
  "ocr_model",
  "max_pages_per_document",
  "daily_spend_cap_usd",
  "daily_spend_cap_configured",
  "daily_spend_cap_source",
]);
const PRICING_BASIS_KEYS = Object.freeze([
  "version",
  "model",
  "status",
  "high_is_guaranteed_upper_bound",
  "input_usd_per_m",
  "output_usd_per_m",
  "input_tokens_per_page_low",
  "input_tokens_per_page_high",
  "output_tokens_per_page_low",
  "output_tokens_per_page_high",
  "seconds_per_page_low",
  "seconds_per_page_high",
]);
const AFFECTED_KEYS = Object.freeze([
  "scan_only",
  "with_authoritative_page_count",
  "with_unknown_page_count",
]);
const PAGE_KEYS = Object.freeze([
  "affected_known",
  "cap_eligible_known",
  "excluded_by_document_cap_known",
]);
const ESTIMATE_KEYS = Object.freeze([
  "basis",
  "pages",
  "usd_low",
  "usd_high",
  "minutes_low",
  "minutes_high",
  "complete",
  "estimated_fits_configured_cap",
  "remaining_shared_daily_budget_usd",
  "remaining_shared_daily_budget_state",
  "actual_affordability",
]);
const UNKNOWN_KEYS = Object.freeze([
  "scan_only_page_count_unknown",
  "password_protected_documents",
  "unsupported_documents",
  "extraction_failed_documents",
  "unavailable_documents",
  "invalid_observation_documents",
  "scope_items",
]);
const ACTION_KEYS = Object.freeze([
  "ocr_performed",
  "application_http_request_performed",
  "application_key_store_accessed",
  "brain_write_performed",
  "checkpoint_write_performed",
  "cursor_write_performed",
  "ingest_state_write_performed",
  "application_filesystem_write_performed",
]);
const LOCAL_FILE_READ_EFFECT_KEYS = Object.freeze([
  "file_provider_hydration",
  "file_provider_network_access",
  "file_provider_credential_use",
  "file_provider_filesystem_mutation",
]);
const FAILURE_KEYS = Object.freeze(["code"]);

const FAILURE_CODE_SET = new Set(OCR_PREFLIGHT_FAILURE_CODES);
const STATUS_SET = new Set(["complete", "incomplete", "failed"]);
const ESTIMATE_BASIS_SET = new Set([
  "all_cap_eligible_pages",
  "known_cap_eligible_pages_lower_bound",
  "unavailable",
]);
const DAILY_CAP_SOURCE_SET = new Set(["manifest", "not_configured", "unavailable"]);
const PRICING_STATUS_SET = new Set([
  "estimated_range",
  "unpriced_model",
  "pricing_contract_mismatch",
  "unavailable",
]);
const UNKNOWN_STATE = "unknown";
const PLAN_FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/u;
const CLOUDFLARE_MODEL_RE = /^@cf\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const INSPECTED_STATES = new Set([
  "native_readable",
  "ocr_reliable",
  "ocr_partial",
  "scan_only_ocr_needed",
  "empty",
]);
const UNINSPECTABLE_STATE_TO_KEY = Object.freeze({
  password_protected: "password_protected_documents",
  unsupported: "unsupported_documents",
  extraction_failed: "extraction_failed_documents",
  unavailable: "unavailable_documents",
});

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has fields outside the versioned OCR preflight schema`);
  }
}

function assertCount(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer${nullable ? " or null" : ""}`);
  }
}

function assertAmount(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number${nullable ? " or null" : ""}`);
  }
}

function addCount(left, right, label) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new TypeError(`${label} exceeds the safe aggregate count range`);
  return sum;
}

function freezeReceipt(receipt) {
  Object.freeze(receipt.coverage);
  Object.freeze(receipt.policy);
  Object.freeze(receipt.pricing_basis);
  Object.freeze(receipt.affected_documents);
  Object.freeze(receipt.pages);
  Object.freeze(receipt.estimate);
  Object.freeze(receipt.unknown_or_uninspectable);
  Object.freeze(receipt.actions);
  Object.freeze(receipt.local_file_read_effects);
  if (receipt.failure) Object.freeze(receipt.failure);
  return Object.freeze(receipt);
}

/** Parse the exact installed CLI tail after `<manifest>`. */
export function parseOcrPreflightArgv(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError("OCR preflight arguments must be an array");
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      if (Object.hasOwn(flags, "json")) throw new TypeError("--json may be supplied only once");
      flags.json = true;
      continue;
    }
    if (arg === "--path") {
      if (Object.hasOwn(flags, "path")) throw new TypeError("--path may be supplied only once");
      const value = argv[index + 1];
      if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
        throw new TypeError("--path requires one folder path");
      }
      flags.path = value;
      index++;
      continue;
    }
    throw new TypeError("OCR preflight accepts only --path <folder> and --json");
  }
  return ocrPreflightRequest(flags);
}

/** Validate an injected request with the same closed shape as installed CLI. */
export function ocrPreflightRequest(flags = {}) {
  assertExactKeys(flags, ["json", "path"], "OCR preflight request");
  if (flags.json !== true) throw new TypeError("OCR preflight requires --json");
  if (typeof flags.path !== "string" || !flags.path.trim()) {
    throw new TypeError("OCR preflight requires --path <folder>");
  }
  return Object.freeze({ path: flags.path, json: true });
}

/** Normalize only the manifest values that can change the proposed OCR bill. */
export function ocrPreflightPolicy(manifest = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("the manifest must be an object");
  }
  const safety = manifest.safety ?? {};
  const ocr = safety.ocr ?? {};
  if (!safety || typeof safety !== "object" || Array.isArray(safety) ||
      !ocr || typeof ocr !== "object" || Array.isArray(ocr)) {
    throw new TypeError("the OCR safety policy must be an object");
  }
  if (ocr.enabled !== undefined && typeof ocr.enabled !== "boolean") {
    throw new TypeError("safety.ocr.enabled must be boolean");
  }
  if (ocr.model !== undefined && typeof ocr.model !== "string") {
    throw new TypeError("safety.ocr.model must be a string");
  }
  const model = typeof ocr.model === "string" && ocr.model.trim()
    ? ocr.model.trim()
    : OCR_PREFLIGHT_DEFAULT_MODEL;
  if (!CLOUDFLARE_MODEL_RE.test(model)) {
    throw new TypeError("safety.ocr.model must be one exact Cloudflare @cf/<publisher>/<model> identifier");
  }
  const configuredMax = ocr.max_pages_per_document;
  const maxPages = configuredMax === undefined
    ? OCR_PREFLIGHT_DEFAULT_MAX_PAGES_PER_DOCUMENT
    : configuredMax;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new TypeError("safety.ocr.max_pages_per_document must be a positive safe integer");
  }
  const dailyCap = safety.daily_llm_spend_cap_usd;
  if (dailyCap !== undefined && (!Number.isFinite(dailyCap) || dailyCap < 0)) {
    throw new TypeError("safety.daily_llm_spend_cap_usd must be a finite non-negative number");
  }
  return Object.freeze({
    ocr_enabled: ocr.enabled === true,
    ocr_model: model,
    max_pages_per_document: maxPages,
    daily_spend_cap_usd: dailyCap ?? null,
    daily_spend_cap_configured: dailyCap !== undefined,
    daily_spend_cap_source: dailyCap === undefined ? "not_configured" : "manifest",
  });
}

function pricingRangeMatches(price) {
  return price && typeof price === "object" && !Array.isArray(price) &&
    price.input_usd_per_m === OCR_PREFLIGHT_PRICED_RANGE.input_usd_per_m &&
    price.output_usd_per_m === OCR_PREFLIGHT_PRICED_RANGE.output_usd_per_m &&
    Array.isArray(price.input_tokens_per_page) &&
    price.input_tokens_per_page.length === 2 &&
    price.input_tokens_per_page[0] === OCR_PREFLIGHT_PRICED_RANGE.input_tokens_per_page_low &&
    price.input_tokens_per_page[1] === OCR_PREFLIGHT_PRICED_RANGE.input_tokens_per_page_high &&
    Array.isArray(price.output_tokens_per_page) &&
    price.output_tokens_per_page.length === 2 &&
    price.output_tokens_per_page[0] === OCR_PREFLIGHT_PRICED_RANGE.output_tokens_per_page_low &&
    price.output_tokens_per_page[1] === OCR_PREFLIGHT_PRICED_RANGE.output_tokens_per_page_high &&
    Array.isArray(price.seconds_per_page) &&
    price.seconds_per_page.length === 2 &&
    price.seconds_per_page[0] === OCR_PREFLIGHT_PRICED_RANGE.seconds_per_page_low &&
    price.seconds_per_page[1] === OCR_PREFLIGHT_PRICED_RANGE.seconds_per_page_high;
}

/** Bind the exact model and the reviewed, explicitly non-guaranteed price range. */
export function ocrPreflightPricingBasis(model, price = null) {
  if (typeof model !== "string" || !CLOUDFLARE_MODEL_RE.test(model)) {
    throw new TypeError("OCR preflight pricing requires one exact Cloudflare model identifier");
  }
  const defaultModel = model === OCR_PREFLIGHT_DEFAULT_MODEL;
  const status = !defaultModel
    ? "unpriced_model"
    : pricingRangeMatches(price)
      ? "estimated_range"
      : "pricing_contract_mismatch";
  const priced = status === "estimated_range";
  return Object.freeze({
    version: OCR_PREFLIGHT_PRICING_BASIS_VERSION,
    model,
    status,
    // Cloudflare does not publish an image-token ceiling for this model. The
    // upper estimate is a planning bracket, never a guaranteed spend bound.
    high_is_guaranteed_upper_bound: false,
    ...Object.fromEntries(Object.keys(OCR_PREFLIGHT_PRICED_RANGE)
      .map((key) => [key, priced ? OCR_PREFLIGHT_PRICED_RANGE[key] : null])),
  });
}

function unknownLocalFileReadEffects() {
  return {
    file_provider_hydration: UNKNOWN_STATE,
    file_provider_network_access: UNKNOWN_STATE,
    file_provider_credential_use: UNKNOWN_STATE,
    file_provider_filesystem_mutation: UNKNOWN_STATE,
  };
}

/**
 * Reduce path-bearing walk skips to content-free OCR evidence.
 *
 * Source-policy exclusions are outside the approved corpus and do not become
 * guessed missing scans. A skipped PDF file is one unavailable document; an
 * unreadable directory/root/subtree is an unknown-size scope item.
 */
export function ocrPreflightWalkEvidence(skips = []) {
  if (!Array.isArray(skips)) throw new TypeError("walk skips must be an array");
  const observations = [];
  let scopeItems = 0;
  let rootUnavailable = false;
  for (const skip of skips) {
    if (!skip || typeof skip !== "object" || skip.adjudication === "source_policy") continue;
    const scope = String(skip.scope || "");
    if (scope === "root") {
      rootUnavailable = true;
      scopeItems = addCount(scopeItems, 1, "uninspectable scope items");
      continue;
    }
    if (scope === "directory" || scope === "subtree") {
      // A source-policy exclusion or an external symlink/junction subtree is
      // deliberately outside the approved ingest scope. walk() marks both as
      // adjudicated/coverage_gap:false; treating them as unknown would turn an
      // ordinary pnpm node_modules junction into a false OCR blocker.
      if (skip.coverage_gap === false || skip.adjudication) continue;
      scopeItems = addCount(scopeItems, 1, "uninspectable scope items");
      continue;
    }
    const locator = String(skip.path || "");
    if (!/\.pdf$/iu.test(locator)) continue;
    const state = skip.original_state === "empty" ? "empty" : "unavailable";
    observations.push(Object.freeze({
      state,
      format: "pdf",
      page_count_state: "unavailable",
    }));
  }
  return Object.freeze({
    observations: Object.freeze(observations),
    scope_items: scopeItems,
    root_unavailable: rootUnavailable,
  });
}

function emptyUnknownCounts(value = 0) {
  return {
    scan_only_page_count_unknown: value,
    password_protected_documents: value,
    unsupported_documents: value,
    extraction_failed_documents: value,
    unavailable_documents: value,
    invalid_observation_documents: value,
    scope_items: value,
  };
}

function rawUsdFromPricingBasis(pages, pricingBasis, suffix) {
  if (pricingBasis?.status !== "estimated_range") {
    throw new TypeError("an unpriced OCR model cannot produce a numeric estimate");
  }
  return (
    pages * pricingBasis[`input_tokens_per_page_${suffix}`] * pricingBasis.input_usd_per_m +
    pages * pricingBasis[`output_tokens_per_page_${suffix}`] * pricingBasis.output_usd_per_m
  ) / 1_000_000;
}

function estimateFromPricingBasis(pages, pricingBasis) {
  const at = (suffix) => rawUsdFromPricingBasis(pages, pricingBasis, suffix);
  return {
    pages,
    usd_low: +at("low").toFixed(4),
    usd_high: +at("high").toFixed(4),
    minutes_low: +((pages * pricingBasis.seconds_per_page_low) / 60).toFixed(1),
    minutes_high: +((pages * pricingBasis.seconds_per_page_high) / 60).toFixed(1),
  };
}

function normalizedCost(estimateCost, pages, pricingBasis) {
  if (typeof estimateCost !== "function") throw new TypeError("an OCR cost estimator is required");
  const estimate = estimateCost(pages);
  if (!estimate || typeof estimate !== "object" || estimate.pages !== pages) {
    throw new TypeError("the OCR cost estimator returned an invalid page count");
  }
  for (const key of ["usd_low", "usd_high", "minutes_low", "minutes_high"]) {
    assertAmount(estimate[key], `estimate.${key}`);
  }
  if (estimate.usd_low > estimate.usd_high || estimate.minutes_low > estimate.minutes_high) {
    throw new TypeError("the OCR cost estimate range is inverted");
  }
  const bound = estimateFromPricingBasis(pages, pricingBasis);
  if (["pages", "usd_low", "usd_high", "minutes_low", "minutes_high"]
    .some((key) => estimate[key] !== bound[key])) {
    throw new TypeError("the OCR cost estimate does not match its versioned pricing basis");
  }
  return estimate;
}

/** Build the aggregate-only plan from content-free per-PDF observations. */
export function ocrPreflightReceipt({
  planFingerprint,
  observations = [],
  walkComplete,
  scopeItems = 0,
  policy,
  pricingBasis,
  estimateCost,
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError("OCR observations must be an array");
  if (typeof walkComplete !== "boolean") throw new TypeError("walk completeness must be boolean");
  if (!PLAN_FINGERPRINT_RE.test(String(planFingerprint || ""))) {
    throw new TypeError("OCR preflight requires a state-bound plan fingerprint");
  }
  assertCount(scopeItems, "scopeItems");
  assertExactKeys(policy, POLICY_KEYS, "OCR preflight policy");
  assertExactKeys(pricingBasis, PRICING_BASIS_KEYS, "OCR preflight pricing basis");

  let observed = 0;
  let inspected = 0;
  let uninspectable = 0;
  let affected = 0;
  let withPages = 0;
  let withoutPages = 0;
  let affectedPages = 0;
  let capEligiblePages = 0;
  let excludedByDocumentCap = 0;
  const unknowns = emptyUnknownCounts();
  unknowns.scope_items = scopeItems;

  for (const observation of observations) {
    observed = addCount(observed, 1, "observed PDF documents");
    const valid = observation && typeof observation === "object" && !Array.isArray(observation) &&
      observation.format === "pdf" &&
      (INSPECTED_STATES.has(observation.state) || Object.hasOwn(UNINSPECTABLE_STATE_TO_KEY, observation.state));
    if (!valid) {
      uninspectable = addCount(uninspectable, 1, "uninspectable PDF documents");
      unknowns.invalid_observation_documents = addCount(
        unknowns.invalid_observation_documents, 1, "invalid OCR observations",
      );
      continue;
    }
    if (INSPECTED_STATES.has(observation.state)) {
      inspected = addCount(inspected, 1, "inspected PDF documents");
    } else {
      uninspectable = addCount(uninspectable, 1, "uninspectable PDF documents");
      const key = UNINSPECTABLE_STATE_TO_KEY[observation.state];
      unknowns[key] = addCount(unknowns[key], 1, key);
    }
    if (observation.state !== "scan_only_ocr_needed") continue;
    affected = addCount(affected, 1, "affected PDF documents");
    const authoritativePages = observation.page_count_state === "authoritative" &&
      observation.page_count_authoritative === true &&
      Number.isSafeInteger(observation.page_count) && observation.page_count >= 1;
    if (!authoritativePages) {
      withoutPages = addCount(withoutPages, 1, "scan-only PDFs with unknown pages");
      unknowns.scan_only_page_count_unknown = addCount(
        unknowns.scan_only_page_count_unknown, 1, "scan-only page-count unknowns",
      );
      continue;
    }
    withPages = addCount(withPages, 1, "scan-only PDFs with authoritative pages");
    affectedPages = addCount(affectedPages, observation.page_count, "affected PDF pages");
    const eligible = Math.min(observation.page_count, policy.max_pages_per_document);
    capEligiblePages = addCount(capEligiblePages, eligible, "cap-eligible PDF pages");
    excludedByDocumentCap = addCount(
      excludedByDocumentCap,
      observation.page_count - eligible,
      "pages excluded by the per-document cap",
    );
  }

  const filesystemScopeComplete = walkComplete && scopeItems === 0;
  const unknownTotal = Object.values(unknowns).reduce(
    (sum, value) => addCount(sum, value, "unknown or uninspectable items"),
    0,
  );
  const evidenceComplete = filesystemScopeComplete && unknownTotal === 0;
  const pricingAvailable = pricingBasis.status === "estimated_range";
  const estimateComplete = evidenceComplete && pricingAvailable;
  const planComplete = estimateComplete && policy.daily_spend_cap_configured;
  const basis = !pricingAvailable
    ? "unavailable"
    : evidenceComplete
      ? "all_cap_eligible_pages"
      : capEligiblePages > 0
        ? "known_cap_eligible_pages_lower_bound"
        : "unavailable";
  const estimated = basis === "unavailable"
    ? null
    : normalizedCost(estimateCost, capEligiblePages, pricingBasis);
  const estimatedFitsConfiguredCap = !estimateComplete || !policy.daily_spend_cap_configured
    ? null
    // Compare the unrounded planning bracket. The displayed range keeps the
    // existing four-decimal format, but rounding it down must never turn a cap
    // that is slightly too small into a positive fit result.
    : rawUsdFromPricingBasis(capEligiblePages, pricingBasis, "high") <= policy.daily_spend_cap_usd;
  const receipt = {
    schema_version: OCR_PREFLIGHT_SCHEMA_VERSION,
    kind: OCR_PREFLIGHT_KIND,
    plan_fingerprint: planFingerprint,
    dry_run: true,
    read_only: true,
    aggregate_only: true,
    status: planComplete ? "complete" : "incomplete",
    coverage: {
      filesystem_scope_complete: filesystemScopeComplete,
      plan_complete: planComplete,
      pdf_documents_observed: observed,
      pdf_documents_inspected: inspected,
      pdf_documents_uninspectable: uninspectable,
      scope_items_uninspectable: scopeItems,
    },
    policy: { ...policy },
    pricing_basis: { ...pricingBasis },
    affected_documents: {
      scan_only: affected,
      with_authoritative_page_count: withPages,
      with_unknown_page_count: withoutPages,
    },
    pages: {
      affected_known: affectedPages,
      cap_eligible_known: capEligiblePages,
      excluded_by_document_cap_known: excludedByDocumentCap,
    },
    estimate: {
      basis,
      pages: estimated?.pages ?? null,
      usd_low: estimated?.usd_low ?? null,
      usd_high: estimated?.usd_high ?? null,
      minutes_low: estimated?.minutes_low ?? null,
      minutes_high: estimated?.minutes_high ?? null,
      complete: estimateComplete,
      estimated_fits_configured_cap: estimatedFitsConfiguredCap,
      // This command intentionally performs no Brain read. The spend cap is
      // shared with other model calls, so current headroom and whether this run
      // would actually finish under it remain unknown.
      remaining_shared_daily_budget_usd: null,
      remaining_shared_daily_budget_state: UNKNOWN_STATE,
      actual_affordability: UNKNOWN_STATE,
    },
    unknown_or_uninspectable: unknowns,
    actions: {
      ocr_performed: false,
      application_http_request_performed: false,
      application_key_store_accessed: false,
      brain_write_performed: false,
      checkpoint_write_performed: false,
      cursor_write_performed: false,
      ingest_state_write_performed: false,
      application_filesystem_write_performed: false,
    },
    local_file_read_effects: unknownLocalFileReadEffects(),
    failure: null,
  };
  assertOcrPreflightReceipt(receipt);
  return freezeReceipt(receipt);
}

/** Build a fixed, identity-free failure receipt before any unsafe fallback. */
export function ocrPreflightFailureReceipt(code) {
  if (!FAILURE_CODE_SET.has(code)) throw new TypeError("unknown OCR preflight failure code");
  const nullUnknowns = emptyUnknownCounts(null);
  const receipt = {
    schema_version: OCR_PREFLIGHT_SCHEMA_VERSION,
    kind: OCR_PREFLIGHT_KIND,
    plan_fingerprint: null,
    dry_run: true,
    read_only: true,
    aggregate_only: true,
    status: "failed",
    coverage: {
      filesystem_scope_complete: false,
      plan_complete: false,
      pdf_documents_observed: null,
      pdf_documents_inspected: null,
      pdf_documents_uninspectable: null,
      scope_items_uninspectable: null,
    },
    policy: {
      ocr_enabled: null,
      ocr_model: null,
      max_pages_per_document: null,
      daily_spend_cap_usd: null,
      daily_spend_cap_configured: null,
      daily_spend_cap_source: "unavailable",
    },
    pricing_basis: {
      version: OCR_PREFLIGHT_PRICING_BASIS_VERSION,
      model: null,
      status: "unavailable",
      high_is_guaranteed_upper_bound: false,
      ...Object.fromEntries(Object.keys(OCR_PREFLIGHT_PRICED_RANGE).map((key) => [key, null])),
    },
    affected_documents: {
      scan_only: null,
      with_authoritative_page_count: null,
      with_unknown_page_count: null,
    },
    pages: {
      affected_known: null,
      cap_eligible_known: null,
      excluded_by_document_cap_known: null,
    },
    estimate: {
      basis: "unavailable",
      pages: null,
      usd_low: null,
      usd_high: null,
      minutes_low: null,
      minutes_high: null,
      complete: false,
      estimated_fits_configured_cap: null,
      remaining_shared_daily_budget_usd: null,
      remaining_shared_daily_budget_state: UNKNOWN_STATE,
      actual_affordability: UNKNOWN_STATE,
    },
    unknown_or_uninspectable: nullUnknowns,
    actions: {
      ocr_performed: false,
      application_http_request_performed: false,
      application_key_store_accessed: false,
      brain_write_performed: false,
      checkpoint_write_performed: false,
      cursor_write_performed: false,
      ingest_state_write_performed: false,
      application_filesystem_write_performed: false,
    },
    local_file_read_effects: unknownLocalFileReadEffects(),
    failure: { code },
  };
  assertOcrPreflightReceipt(receipt);
  return freezeReceipt(receipt);
}

/** Validate the exact machine contract. Unknown fields and contradictions fail closed. */
export function assertOcrPreflightReceipt(receipt) {
  assertExactKeys(receipt, TOP_LEVEL_KEYS, "OCR preflight receipt");
  if (receipt.schema_version !== OCR_PREFLIGHT_SCHEMA_VERSION || receipt.kind !== OCR_PREFLIGHT_KIND ||
      receipt.dry_run !== true || receipt.read_only !== true || receipt.aggregate_only !== true) {
    throw new TypeError("OCR preflight receipt identity is invalid");
  }
  if (!STATUS_SET.has(receipt.status)) throw new TypeError("OCR preflight status is invalid");
  assertExactKeys(receipt.coverage, COVERAGE_KEYS, "OCR preflight coverage");
  assertExactKeys(receipt.policy, POLICY_KEYS, "OCR preflight policy");
  assertExactKeys(receipt.pricing_basis, PRICING_BASIS_KEYS, "OCR preflight pricing basis");
  assertExactKeys(receipt.affected_documents, AFFECTED_KEYS, "OCR preflight affected documents");
  assertExactKeys(receipt.pages, PAGE_KEYS, "OCR preflight pages");
  assertExactKeys(receipt.estimate, ESTIMATE_KEYS, "OCR preflight estimate");
  assertExactKeys(receipt.unknown_or_uninspectable, UNKNOWN_KEYS, "OCR preflight unknowns");
  assertExactKeys(receipt.actions, ACTION_KEYS, "OCR preflight actions");
  assertExactKeys(receipt.local_file_read_effects, LOCAL_FILE_READ_EFFECT_KEYS, "OCR preflight local file read effects");

  for (const key of ["filesystem_scope_complete", "plan_complete"]) {
    if (typeof receipt.coverage[key] !== "boolean") throw new TypeError(`coverage.${key} must be boolean`);
  }
  for (const key of COVERAGE_KEYS.slice(2)) assertCount(receipt.coverage[key], `coverage.${key}`, { nullable: true });
  for (const [key, value] of Object.entries(receipt.affected_documents)) {
    assertCount(value, `affected_documents.${key}`, { nullable: true });
  }
  for (const [key, value] of Object.entries(receipt.pages)) assertCount(value, `pages.${key}`, { nullable: true });
  for (const [key, value] of Object.entries(receipt.unknown_or_uninspectable)) {
    assertCount(value, `unknown_or_uninspectable.${key}`, { nullable: true });
  }
  if (!ESTIMATE_BASIS_SET.has(receipt.estimate.basis) ||
      typeof receipt.estimate.complete !== "boolean") {
    throw new TypeError("OCR preflight estimate identity is invalid");
  }
  assertCount(receipt.estimate.pages, "estimate.pages", { nullable: true });
  for (const key of ["usd_low", "usd_high", "minutes_low", "minutes_high"]) {
    assertAmount(receipt.estimate[key], `estimate.${key}`, { nullable: true });
  }
  if (receipt.estimate.estimated_fits_configured_cap !== null &&
      typeof receipt.estimate.estimated_fits_configured_cap !== "boolean") {
    throw new TypeError("estimate.estimated_fits_configured_cap must be boolean or null");
  }
  assertAmount(receipt.estimate.remaining_shared_daily_budget_usd,
    "estimate.remaining_shared_daily_budget_usd", { nullable: true });
  if (receipt.estimate.remaining_shared_daily_budget_state !== UNKNOWN_STATE ||
      receipt.estimate.actual_affordability !== UNKNOWN_STATE) {
    throw new TypeError("OCR preflight cannot claim live shared-budget headroom or actual affordability");
  }
  if (!DAILY_CAP_SOURCE_SET.has(receipt.policy.daily_spend_cap_source)) {
    throw new TypeError("OCR preflight daily cap source is invalid");
  }
  if (receipt.policy.ocr_enabled !== null && typeof receipt.policy.ocr_enabled !== "boolean") {
    throw new TypeError("OCR preflight OCR policy flag is invalid");
  }
  if (receipt.policy.ocr_model !== null && !CLOUDFLARE_MODEL_RE.test(receipt.policy.ocr_model)) {
    throw new TypeError("OCR preflight policy model is invalid");
  }
  if (receipt.policy.daily_spend_cap_configured !== null &&
      typeof receipt.policy.daily_spend_cap_configured !== "boolean") {
    throw new TypeError("OCR preflight daily cap configured flag is invalid");
  }
  assertCount(receipt.policy.max_pages_per_document, "policy.max_pages_per_document", { nullable: true });
  assertAmount(receipt.policy.daily_spend_cap_usd, "policy.daily_spend_cap_usd", { nullable: true });
  if (Object.values(receipt.actions).some((value) => value !== false)) {
    throw new TypeError("OCR preflight may not report or perform an action");
  }
  if (Object.values(receipt.local_file_read_effects).some((value) => value !== UNKNOWN_STATE)) {
    throw new TypeError("local file-provider effects must remain unknown");
  }
  if (receipt.pricing_basis.version !== OCR_PREFLIGHT_PRICING_BASIS_VERSION ||
      !PRICING_STATUS_SET.has(receipt.pricing_basis.status) ||
      receipt.pricing_basis.high_is_guaranteed_upper_bound !== false) {
    throw new TypeError("OCR preflight pricing basis identity is invalid");
  }
  const pricingAmounts = Object.keys(OCR_PREFLIGHT_PRICED_RANGE)
    .map((key) => receipt.pricing_basis[key]);
  for (const [index, value] of pricingAmounts.entries()) {
    assertAmount(value, `pricing_basis.${Object.keys(OCR_PREFLIGHT_PRICED_RANGE)[index]}`, { nullable: true });
  }

  if (receipt.status === "failed") {
    assertExactKeys(receipt.failure, FAILURE_KEYS, "OCR preflight failure");
    if (!FAILURE_CODE_SET.has(receipt.failure.code)) throw new TypeError("OCR preflight failure code is invalid");
    const numeric = [
      ...COVERAGE_KEYS.slice(2).map((key) => receipt.coverage[key]),
      receipt.policy.max_pages_per_document,
      receipt.policy.daily_spend_cap_usd,
      ...pricingAmounts,
      ...Object.values(receipt.affected_documents),
      ...Object.values(receipt.pages),
      receipt.estimate.pages,
      receipt.estimate.usd_low,
      receipt.estimate.usd_high,
      receipt.estimate.minutes_low,
      receipt.estimate.minutes_high,
      receipt.estimate.remaining_shared_daily_budget_usd,
      ...Object.values(receipt.unknown_or_uninspectable),
    ];
    if (numeric.some((value) => value !== null) || receipt.plan_fingerprint !== null ||
        receipt.policy.ocr_enabled !== null ||
        receipt.policy.ocr_model !== null ||
        receipt.policy.daily_spend_cap_configured !== null ||
        receipt.policy.daily_spend_cap_source !== "unavailable" ||
        receipt.pricing_basis.model !== null || receipt.pricing_basis.status !== "unavailable" ||
        receipt.estimate.basis !== "unavailable" || receipt.estimate.complete ||
        receipt.estimate.estimated_fits_configured_cap !== null ||
        receipt.coverage.filesystem_scope_complete || receipt.coverage.plan_complete) {
      throw new TypeError("a failed OCR preflight cannot claim observed facts");
    }
    return receipt;
  }

  if (receipt.failure !== null) throw new TypeError("only a failed OCR preflight may carry a failure");
  if (!PLAN_FINGERPRINT_RE.test(String(receipt.plan_fingerprint || ""))) {
    throw new TypeError("OCR preflight plan fingerprint is invalid");
  }
  if (receipt.policy.ocr_enabled === null || receipt.policy.ocr_model === null ||
      receipt.policy.max_pages_per_document === null ||
      receipt.policy.daily_spend_cap_configured === null ||
      receipt.policy.daily_spend_cap_source === "unavailable") {
    throw new TypeError("a completed OCR preflight attempt requires a complete policy");
  }
  if (receipt.pricing_basis.model !== receipt.policy.ocr_model ||
      receipt.pricing_basis.status === "unavailable") {
    throw new TypeError("OCR preflight pricing must bind the exact policy model");
  }
  const pricingAvailable = receipt.pricing_basis.status === "estimated_range";
  const defaultModel = receipt.policy.ocr_model === OCR_PREFLIGHT_DEFAULT_MODEL;
  if ((defaultModel && !["estimated_range", "pricing_contract_mismatch"].includes(receipt.pricing_basis.status)) ||
      (!defaultModel && receipt.pricing_basis.status !== "unpriced_model")) {
    throw new TypeError("OCR preflight pricing status contradicts its exact model");
  }
  if (pricingAvailable) {
    for (const [key, value] of Object.entries(OCR_PREFLIGHT_PRICED_RANGE)) {
      if (receipt.pricing_basis[key] !== value) {
        throw new TypeError("OCR preflight pricing range does not match its version");
      }
    }
  } else if (pricingAmounts.some((value) => value !== null)) {
    throw new TypeError("an unpriced OCR model cannot carry a numeric pricing range");
  }
  if (!pricingAvailable && receipt.estimate.basis !== "unavailable") {
    throw new TypeError("an unpriced OCR model must keep its estimate unavailable");
  }
  if (receipt.policy.max_pages_per_document < 1) {
    throw new TypeError("OCR preflight requires a positive per-document page cap");
  }
  if (receipt.policy.daily_spend_cap_configured) {
    if (receipt.policy.daily_spend_cap_usd === null || receipt.policy.daily_spend_cap_source !== "manifest") {
      throw new TypeError("a configured daily cap requires its manifest value");
    }
  } else if (receipt.policy.daily_spend_cap_usd !== null ||
      receipt.policy.daily_spend_cap_source !== "not_configured") {
    throw new TypeError("an unconfigured daily cap must remain unknown");
  }
  if (receipt.coverage.pdf_documents_inspected + receipt.coverage.pdf_documents_uninspectable !==
      receipt.coverage.pdf_documents_observed) {
    throw new TypeError("OCR preflight document coverage does not add up");
  }
  if (receipt.affected_documents.with_authoritative_page_count +
      receipt.affected_documents.with_unknown_page_count !== receipt.affected_documents.scan_only) {
    throw new TypeError("OCR preflight affected-document counts do not add up");
  }
  if (receipt.affected_documents.scan_only > receipt.coverage.pdf_documents_inspected ||
      receipt.unknown_or_uninspectable.scan_only_page_count_unknown !==
        receipt.affected_documents.with_unknown_page_count) {
    throw new TypeError("OCR preflight scan-only counts contradict document coverage");
  }
  const uninspectableDocuments = [
    "password_protected_documents",
    "unsupported_documents",
    "extraction_failed_documents",
    "unavailable_documents",
    "invalid_observation_documents",
  ].reduce((sum, key) => sum + receipt.unknown_or_uninspectable[key], 0);
  if (uninspectableDocuments !== receipt.coverage.pdf_documents_uninspectable) {
    throw new TypeError("OCR preflight uninspectable-document categories do not add up");
  }
  if (receipt.pages.cap_eligible_known + receipt.pages.excluded_by_document_cap_known !==
      receipt.pages.affected_known) {
    throw new TypeError("OCR preflight page counts do not add up");
  }
  if (receipt.unknown_or_uninspectable.scope_items !== receipt.coverage.scope_items_uninspectable) {
    throw new TypeError("OCR preflight scope unknowns do not match coverage");
  }
  const unknownTotal = Object.values(receipt.unknown_or_uninspectable).reduce((sum, value) => sum + value, 0);
  const expectedEvidenceComplete = receipt.coverage.filesystem_scope_complete && unknownTotal === 0;
  const expectedEstimateComplete = expectedEvidenceComplete && pricingAvailable;
  const expectedPlanComplete = expectedEstimateComplete && receipt.policy.daily_spend_cap_configured;
  if (receipt.coverage.plan_complete !== expectedPlanComplete ||
      receipt.estimate.complete !== expectedEstimateComplete ||
      (receipt.status === "complete") !== expectedPlanComplete) {
    throw new TypeError("OCR preflight completeness claims contradict its unknowns");
  }
  if (receipt.estimate.basis === "unavailable") {
    if ([receipt.estimate.pages, receipt.estimate.usd_low, receipt.estimate.usd_high,
      receipt.estimate.minutes_low, receipt.estimate.minutes_high].some((value) => value !== null)) {
      throw new TypeError("an unavailable OCR estimate cannot carry numeric values");
    }
  } else {
    if (receipt.estimate.pages !== receipt.pages.cap_eligible_known ||
        [receipt.estimate.usd_low, receipt.estimate.usd_high,
          receipt.estimate.minutes_low, receipt.estimate.minutes_high].some((value) => value === null)) {
      throw new TypeError("an available OCR estimate must cover the known cap-eligible pages");
    }
    if (receipt.estimate.usd_low > receipt.estimate.usd_high ||
        receipt.estimate.minutes_low > receipt.estimate.minutes_high) {
      throw new TypeError("OCR preflight estimate range is inverted");
    }
    const bound = estimateFromPricingBasis(receipt.estimate.pages, receipt.pricing_basis);
    if (["pages", "usd_low", "usd_high", "minutes_low", "minutes_high"]
      .some((key) => receipt.estimate[key] !== bound[key])) {
      throw new TypeError("OCR preflight estimate does not match its versioned pricing basis");
    }
  }
  if (expectedEstimateComplete && receipt.estimate.basis !== "all_cap_eligible_pages") {
    throw new TypeError("a complete OCR preflight must estimate all cap-eligible pages");
  }
  if (!expectedEstimateComplete && receipt.estimate.basis === "all_cap_eligible_pages") {
    throw new TypeError("an incomplete OCR preflight cannot claim all pages were estimated");
  }
  const expectedFitsConfiguredCap = !expectedEstimateComplete || !receipt.policy.daily_spend_cap_configured
    ? null
    : rawUsdFromPricingBasis(receipt.estimate.pages, receipt.pricing_basis, "high") <=
      receipt.policy.daily_spend_cap_usd;
  if (receipt.estimate.estimated_fits_configured_cap !== expectedFitsConfiguredCap ||
      receipt.estimate.remaining_shared_daily_budget_usd !== null) {
    throw new TypeError("OCR preflight configured-cap comparison or unknown live headroom is invalid");
  }
  return receipt;
}

export const renderOcrPreflightReceipt = (receipt) =>
  `${JSON.stringify(assertOcrPreflightReceipt(receipt), null, 2)}\n`;
