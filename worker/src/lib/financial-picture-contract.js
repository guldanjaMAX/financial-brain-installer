/**
 * Closed public response contract for the read-only financial-picture receipt.
 *
 * The Worker runs this immediately before JSON serialization and the CLI runs
 * the same validator before returning or rendering a successful response. A
 * new public field therefore requires an intentional contract change in one
 * place; an accidental SQL/internal field cannot silently cross either
 * boundary.
 */

export const FINANCIAL_PICTURE_SECTIONS = Object.freeze([
  "entities",
  "periods",
  "accounts",
  "books",
  "payroll",
  "tax_returns",
  "filing_payments",
  "evidence",
  "conflicts",
]);

const SECTION_SET = new Set(FINANCIAL_PICTURE_SECTIONS);
const SAFE_CODE = /^[a-z][a-z0-9_]{0,127}$/;
const SAFE_ENTITY_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const SAFE_REFERENCE = /^(?:acct|books|claim|claim_record|conflict|corpus_source|database_snapshot|entity|evidence|filing|period|quickbooks_company|source_document|source_feed|source_locator|tax)_v2_[a-f0-9]{64}$/;
const RAW_FIELD = /^(?:id|uid|internal(?:_.*)?|raw(?:_.*)?|provider(?:_.*)?|source_doc_uid|source_locator|source_feed|linked_corpus_source|.*_id|.*_uid|.*_slug)$/i;
const IDENTIFIER_SHAPED_CODE = /(?:^|_)(?:id|uid|slug|provider|internal|raw|locator)(?:_|$)/i;
const DIAGNOSTIC_IDENTIFIER_EXCEPTIONS = new Set(["entity_slug", "source_locator"]);
const CONTROL = /[\u0000-\u001f\u007f]/;
const PUBLIC_SOURCE_KINDS = new Set([
  "drive", "gmail", "imap", "calendar", "imessage", "whatsapp", "zoom",
  "quickbooks", "slack", "notion", "microsoft", "dropbox", "hubspot",
  "plaid", "iphone-backup", "upload",
]);
const PROVENANCE_VALUES = new Set(["owner_stated", "extracted", "feed", "derived"]);
const BASIS_STATES = new Set(["confirmed", "proposed", "unparsed"]);
const FIELD_STATES = new Set([
  "not_owner_confirmed", "unavailable", "stored_value_missing",
  "stored_reference_unresolved", "stored_mapping_conflict",
  "stored_owner_assertion_unconfirmed",
]);
const UNAVAILABLE_REASONS = new Set([
  "not_requested", "payroll_registry_unavailable",
  "financial_ledger_status_unavailable", "financial_ledger_schema_not_installed",
  "privacy_reference_signing_unavailable", "database_session_unavailable",
  "database_binding_unavailable", "database_prepare_unavailable",
  "database_read_failed", "database_read_incomplete", "snapshot_anchor_unavailable",
  "database_count_unavailable", "database_result_unavailable",
]);
const PROVENANCE_REASON_BY_STATUS = Object.freeze({
  complete: new Set(["lineage_and_text_recorded"]),
  partial: new Set(["text_provenance_unavailable", "lineage_unavailable"]),
  unavailable: new Set([
    "provenance_unavailable", "provenance_receipt_missing_or_invalid",
    "mixed_provenance_receipts", "provenance_group_incomplete_or_bounded",
  ]),
});
const PROVENANCE_FIELD_SET = new Set([
  "provenance", "basis_state", "source_document_ref", "source_document_present",
  "source_document_reference_state", "source_locator_present", "source_locator_ref",
  "source_locator_state", "source_feed_ref", "source_feed_present", "source_feed_kind",
  "source_feed_kind_state", "source_feed_registry_state", "linked_corpus_source_ref",
  "linked_corpus_source_present", "linked_corpus_source_kind",
  "linked_corpus_source_state", "recorded_at", "unparsed_reason", "derivation_roots",
  "provenance_status_code", "provenance_reason_codes", "source_status",
  "source_last_ingest_at", "corpus_ingested_at_ms",
]);
const PROVENANCE_STATES = new Set([
  "owner_stated", "document_cited", "document_reference_unresolved", "incomplete",
  "feed_registry_cited", "feed_registry_unresolved", "derived_roots_cited",
  "derived_roots_unavailable", "unavailable",
]);
const DEBT_STATES = new Set([
  "not_requested", "insufficient_scope", "failed_new_provenance_debt",
  "passed_no_new_provenance_debt",
]);
const MAPPING_FIELDS = new Set([
  "account", "books_company", "covered_via_account", "entity", "evidence_role",
  "filing_or_payment_role", "holds", "kind", "ownership_basis_points",
  "parent_entity", "period", "relationship", "status", "tax_class",
  "tax_period", "tax_role",
]);

const ROOT_KEYS = [
  "schema_version", "operation", "read_only", "mutation_count",
  "completeness_verdict", "correctness_verdict", "tenant_scope", "filters",
  "provenance_baseline", "sections_requested", "page_limit", "request_cursor",
  "pagination_snapshot_scope", "reference_token_contract", "evidence_scope",
  "extraction_state_contract", "freshness_state_contract", "recovery_mode",
  "sections", "unavailable", "sections_unavailable", "provenance_debt_gate",
  "snapshot",
];
const SECTION_KEYS = [
  "state", "unavailable", "unavailable_reason", "unavailable_fields",
  "provenance_state", "provenance_fields", "verification_gap_summary",
  "blocks_financial_verification", "total", "returned", "truncated", "cursor",
  "next_cursor", "applied_filters", "not_applicable_filters",
  "real_world_completeness",
];
const AVAILABLE_SECTION_KEYS = [...SECTION_KEYS, "records", "reference_integrity"];
const GAP_KEYS = [
  "count_scope", "bounded_by_page_limit", "covers_all_matching_records",
  "scope_reason_codes", "examined", "provenance_records_examined", "affected",
  "blocking", "missing_fields", "by_provenance_state", "by_extraction_state",
  "by_freshness_state", "provenance_debt_since_baseline", "recovery_mode",
  "additional_reference_occurrences_affected", "blocking_reference_occurrences",
];
const GAP_REQUIRED = [
  "count_scope", "bounded_by_page_limit", "covers_all_matching_records",
  "examined", "affected", "blocking", "missing_fields", "by_provenance_state",
  "by_extraction_state", "by_freshness_state", "provenance_debt_since_baseline",
  "recovery_mode",
];
const DEBT_KEYS = [
  "state", "baseline_recorded_at", "comparison", "count_scope", "count_unit",
  "covers_all_matching_records", "new_records", "new_records_with_provenance_debt",
  "unclassifiable_recorded_at", "debt_reason_codes", "scope_reason_codes",
];
const DEBT_REQUIRED = [
  "state", "baseline_recorded_at", "count_scope", "count_unit",
  "covers_all_matching_records", "new_records", "new_records_with_provenance_debt",
  "unclassifiable_recorded_at", "debt_reason_codes",
];
const GATE_KEYS = [
  "state", "baseline_recorded_at", "comparison", "gate_scope", "count_unit",
  "sections_evaluated", "sections_excluded_as_unavailable", "scope_reason_codes",
  "new_records", "new_records_with_provenance_debt", "unclassifiable_recorded_at",
  "debt_reason_codes", "covers_all_evaluated_matching_records",
  "real_world_completeness",
];
const GATE_REQUIRED = [
  "state", "baseline_recorded_at", "gate_scope", "count_unit",
  "real_world_completeness",
];
const LINEAGE_KEYS = [
  "state", "status_code", "reason_codes", "missing_fields", "provenance",
  "basis_state", "unparsed_reason", "confidence_basis_points",
  "source_document_ref", "source_document_present",
  "source_document_reference_state", "source_locator_present",
  "source_locator_ref", "source_locator_state", "source_feed_ref",
  "source_feed_present", "source_feed_kind", "source_feed_kind_state",
  "source_feed_registry_state", "linked_corpus_source_ref",
  "linked_corpus_source_present", "linked_corpus_source_kind",
  "linked_corpus_source_state", "supersession_claimed",
  "superseded_by_reference_present", "claim_record_reference_state",
  "transaction_reference_state", "corpus_content_binding_state", "recorded_at",
  "derivation_roots",
];
const VERIFICATION_KEYS = [
  "provenance_state", "provenance_status_code", "provenance_reason_codes",
  "provenance_debt", "missing_provenance_fields", "missing_extraction_fields",
  "freshness_state", "missing_freshness_fields", "missing_verification_fields",
  "extraction", "freshness", "extraction_relevant",
  "blocks_financial_verification", "blocking_reasons", "gap_state",
  "gap_reason_codes",
];
const EXTRACTION_KEYS = [
  "state", "readable", "text_source", "text_reliable",
  "provenance_assessed", "provenance_status", "provenance_reason",
  "corpus_document_present", "corpus_content_binding_state", "unavailable_fields",
];
const FRESHNESS_KEYS = [
  "state", "current_or_stale", "source_status", "source_last_ingest_at",
  "corpus_ingested_at_ms", "evidence_recorded_at", "expected_cadence",
  "source_coverage", "missing_fields",
];
const SOURCE_COVERAGE_KEYS = [
  "state", "basis", "starter_context_state", "live_updates_state",
  "history_state", "meaning_search_state", "confirmed_range", "target_range",
  "current_window", "counts", "last_progress_at", "projection_pending",
  "waiting_on_owner_machine", "missing_fields",
];
const MAPPING_KEYS = [
  "state", "confirmed_by_owner", "field_states", "field_basis",
  "confirmed_fields", "stored_owner_assertion_fields", "missing_fields",
  "reason_codes",
];
const FIELD_BASIS_KEYS = [
  "provenance", "basis_state", "stored_owner_assertion",
  "owner_actor_receipt_present", "reference_present", "mapping_conflict",
  "stored_field",
];
const MATERIAL_FIELD_KEYS = [
  "stored_value", "confirmation_state", "confirmed_by_owner",
  "owner_actor_receipt_present", "stored_owner_assertion", "provenance",
  "basis_state", "missing_fields",
];
const INTEGRITY_KEYS = [
  "state", "unavailable", "unavailable_reason", "total", "returned",
  "truncated", "cursor", "next_cursor", "count_unit", "counts",
  "unresolved_current_reference_occurrences",
  "unresolved_or_mismatched_supersession_occurrences", "filter_scope",
  "missing_fields", "reason_codes", "blocks_financial_verification",
];

const RECORD_KEYS = Object.freeze({
  entities: [
    "entity_ref", "stored_name", "material_fields", "scope_state",
    "ownership_confirmed", "parent_entity_ref", "parent_entity_reference_state",
    "parent_mapping_confirmation", "scope_confirmation", "source_lineage",
    "entity_mapping_basis", "verification",
  ],
  periods: [
    "period_ref", "entity_ref", "account_ref", "account_reference_state",
    "entity_reference_state", "entity_account_mapping_state",
    "covered_via_account_ref", "covered_via_account_reference_state",
    "period_kind", "tax_year", "period_start", "period_end", "evidence_kind",
    "mapping_confirmation", "source_lineage", "entity_period_mapping_basis",
    "verification",
  ],
  accounts: [
    "account_ref", "masked_identity", "institution", "category",
    "stored_account_kind", "entity_ref", "entity_reference_state",
    "balance_role", "currency", "feed_mode", "expected_cadence", "status",
    "opened_on", "closed_on", "coverage", "mapping_confirmation",
    "source_lineage", "account_entity_mapping_basis", "verification",
  ],
  books: [
    "books_ref", "record_type", "system_identity", "entity_ref",
    "entity_reference_state", "account_ref", "account_reference_state",
    "entity_account_mapping_state", "document_kind", "tax_year", "period_start",
    "period_end", "evidence_count", "observed_record_from", "observed_record_to",
    "last_ingested_at_ms", "extraction_group_evidence", "mapping_confirmation",
    "source_lineage", "source_provenance", "verification",
  ],
  tax_returns: [
    "evidence_ref", "entity_ref", "entity_reference_state", "account_ref",
    "account_reference_state", "entity_account_mapping_state", "evidence_kind",
    "tax_year", "period_start", "period_end", "tax_form",
    "k1_issuer_or_recipient_role", "custody", "mapping_confirmation",
    "source_lineage", "entity_tax_period_mapping_basis", "verification",
  ],
  filing_payments: [
    "evidence_ref", "entity_ref", "entity_reference_state", "account_ref",
    "account_reference_state", "entity_account_mapping_state", "evidence_kind",
    "tax_year", "period_start", "period_end", "custody",
    "mapping_confirmation", "source_lineage", "entity_tax_period_mapping_basis",
    "verification",
  ],
  evidence: [
    "evidence_ref", "current_state", "superseded_by_ref", "supersession",
    "entity_ref", "entity_reference_state", "account_ref",
    "account_reference_state", "entity_account_mapping_state", "evidence_kind",
    "tax_year", "period_start", "period_end", "custody",
    "mapping_confirmation", "source_lineage", "provenance", "verification",
  ],
  conflicts: [
    "conflict_ref", "conflict_type", "conflict_state", "conflict_kind",
    "entity_ref", "entity_reference_state", "account_ref",
    "account_reference_state", "entity_account_mapping_state",
    "transaction_reference_state", "period_start", "period_end", "observed_at",
    "mapping_confirmation", "source_lineage", "conflict_derivation_basis",
    "derivation_root_page", "verification",
  ],
});

const APPLIED_FILTER_KEYS = Object.freeze({
  entities: ["entity_slug"],
  periods: ["entity_slug", "tax_year", "period_start", "period_end"],
  accounts: ["entity_slug", "period_start", "period_end"],
  books: ["entity_slug", "tax_year", "period_start", "period_end"],
  payroll: ["entity_slug", "tax_year", "period_start", "period_end"],
  tax_returns: ["entity_slug", "tax_year", "period_start", "period_end"],
  filing_payments: ["entity_slug", "tax_year", "period_start", "period_end"],
  evidence: ["entity_slug", "tax_year", "period_start", "period_end"],
  conflicts: ["entity_slug", "period_start", "period_end"],
});

function fail(path, message) {
  throw new TypeError(`invalid financial-picture receipt at ${path}: ${message}`);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertKeys(value, allowed, path, required = allowed) {
  if (!plainObject(value)) fail(path, "expected an object");
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length) fail(path, `unknown field ${extra[0]}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(path, `missing field ${missing[0]}`);
}

function assertJsonScalar(value, path) {
  if (value === null) return;
  if (!["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))) {
    fail(path, "expected a JSON scalar");
  }
}

function assertBoolean(value, path, { nullable = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== "boolean") fail(path, nullable ? "expected a boolean or null" : "expected a boolean");
}

function assertSafeInteger(value, path, { nullable = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null && nullable) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, nullable ? "expected a bounded integer or null" : "expected a bounded integer");
  }
}

function assertEnum(value, allowed, path, { nullable = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== "string" || !allowed.has(value)) fail(path, "unknown value");
}

function assertPublicText(value, path, { nullable = false, max = 512, empty = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== "string" || value.length > max || (!empty && value.length === 0) || CONTROL.test(value)) {
    fail(path, nullable ? "expected bounded public text or null" : "expected bounded public text");
  }
}

function assertDateOrNull(value, path) {
  if (value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, "expected an exact calendar date or null");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== value) fail(path, "expected a real calendar date or null");
}

function assertStoredTimestampOrNull(value, path) {
  if (value === null) return;
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    fail(path, "expected a stored UTC timestamp or null");
  }
}

function assertDateOrTimestampOrNull(value, path) {
  if (value === null) return;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    assertDateOrNull(value, path);
    return;
  }
  assertStoredTimestampOrNull(value, path);
}

function assertDiagnosticCode(value, path) {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) fail(path, "invalid diagnostic code");
  if ((!DIAGNOSTIC_IDENTIFIER_EXCEPTIONS.has(value) && IDENTIFIER_SHAPED_CODE.test(value)) ||
      /\d{2,}/.test(value)) {
    fail(path, "identifier-shaped diagnostic values are forbidden");
  }
}

function assertStringArray(value, path, allowed = null) {
  if (!Array.isArray(value)) fail(path, "expected an array");
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") fail(`${path}[${index}]`, "expected a string");
    if (allowed && !allowed.has(item)) fail(`${path}[${index}]`, "unknown value");
  }
}

function assertCodeArray(value, path) {
  assertStringArray(value, path);
  for (const [index, item] of value.entries()) {
    assertDiagnosticCode(item, `${path}[${index}]`);
  }
}

function assertCodeMap(value, path, { allowNull = false } = {}) {
  if (!plainObject(value)) fail(path, "expected a diagnostic count map");
  for (const [key, count] of Object.entries(value)) {
    assertDiagnosticCode(key, `${path}.${key}`);
    if (count === null && allowNull) continue;
    if (!Number.isSafeInteger(count) || count < 0) fail(`${path}.${key}`, "invalid count");
  }
}

function assertUniqueStringArray(value, path, allowed = null) {
  assertStringArray(value, path, allowed);
  if (new Set(value).size !== value.length) fail(path, "duplicate values are forbidden");
}

function assertExactStringArray(value, expected, path) {
  assertStringArray(value, path);
  if (value.length !== expected.length ||
      value.some((item, index) => item !== expected[index])) {
    fail(path, "wrong exact public contract values");
  }
}

function assertCursor(value, path) {
  if (value !== null && (typeof value !== "string" || !SAFE_CURSOR.test(value))) {
    fail(path, "expected a bounded opaque cursor or null");
  }
}

function assertReference(value, path) {
  if (value !== null && (typeof value !== "string" || !SAFE_REFERENCE.test(value))) {
    fail(path, "expected a keyed v2 reference or null");
  }
}

function assertTimestampOrNull(value, path) {
  if (value === null) return;
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    fail(path, "expected an exact UTC timestamp or null");
  }
}

function rejectRawKeys(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectRawKeys(item, `${path}[${index}]`));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const filterEcho = key === "entity_slug" &&
      (path === "$.filters" || path.endsWith(".applied_filters"));
    if (!filterEcho && RAW_FIELD.test(key)) {
      fail(`${path}.${key}`, "raw, internal, provider, UID, slug, feed, or locator fields are forbidden");
    }
    rejectRawKeys(nested, `${path}.${key}`);
  }
}

function assertSourceReferenceBundle(value, path) {
  const bundles = [
    ["source_document", "source_document_reference_state", "absent"],
    ["source_locator", "source_locator_state", "absent"],
    ["source_feed", "source_feed_registry_state", "absent"],
    ["linked_corpus_source", "linked_corpus_source_state", "absent"],
  ];
  for (const [prefix, stateKey, absentState] of bundles) {
    const present = value[`${prefix}_present`];
    const ref = value[`${prefix}_ref`];
    const state = value[stateKey];
    if (present === true && (ref === null || state === absentState)) {
      fail(`${path}.${prefix}`, "present source reference requires an opaque ref and non-absent state");
    }
    if (present === false && (ref !== null || state !== absentState)) {
      fail(`${path}.${prefix}`, "absent source reference cannot carry a ref or resolution state");
    }
  }
  if (value.source_feed_present === false &&
      (value.source_feed_kind !== null || value.source_feed_kind_state !== "absent")) {
    fail(`${path}.source_feed_kind`, "absent feed cannot carry a public kind");
  }
  if (value.source_feed_kind_state === "known_public_kind" && value.source_feed_kind === null) {
    fail(`${path}.source_feed_kind`, "known feed kind is missing");
  }
  if (value.source_feed_kind_state !== "known_public_kind" && value.source_feed_kind !== null) {
    fail(`${path}.source_feed_kind`, "unconfirmed feed kind cannot be exposed");
  }
  if (value.linked_corpus_source_present === false &&
      value.linked_corpus_source_kind !== null) {
    fail(`${path}.linked_corpus_source_kind`, "absent corpus source cannot carry a public kind");
  }
  if (value.linked_corpus_source_state === "known_public_kind" &&
      value.linked_corpus_source_kind === null) {
    fail(`${path}.linked_corpus_source_kind`, "known corpus source kind is missing");
  }
  if (value.linked_corpus_source_state !== "known_public_kind" &&
      value.linked_corpus_source_kind !== null) {
    fail(`${path}.linked_corpus_source_kind`, "unconfirmed corpus source kind cannot be exposed");
  }
}

function assertLineage(value, path) {
  assertKeys(value, LINEAGE_KEYS, path);
  assertEnum(value.state, new Set([
    "owner_stated", "document_cited", "document_reference_unresolved", "incomplete",
    "feed_registry_cited", "feed_registry_unresolved", "derived_roots_cited",
    "derived_roots_unavailable", "unavailable",
  ]), `${path}.state`);
  assertEnum(value.status_code, new Set(["complete", "incomplete"]), `${path}.status_code`);
  assertCodeArray(value.reason_codes, `${path}.reason_codes`);
  assertCodeArray(value.missing_fields, `${path}.missing_fields`);
  assertEnum(value.provenance, PROVENANCE_VALUES, `${path}.provenance`, { nullable: true });
  assertEnum(value.basis_state, BASIS_STATES, `${path}.basis_state`, { nullable: true });
  assertPublicText(value.unparsed_reason, `${path}.unparsed_reason`, { nullable: true, max: 512 });
  assertSafeInteger(value.confidence_basis_points, `${path}.confidence_basis_points`, {
    nullable: true, max: 10000,
  });
  assertReference(value.source_document_ref, `${path}.source_document_ref`);
  assertReference(value.source_locator_ref, `${path}.source_locator_ref`);
  assertReference(value.source_feed_ref, `${path}.source_feed_ref`);
  assertReference(value.linked_corpus_source_ref, `${path}.linked_corpus_source_ref`);
  for (const key of [
    "source_document_present", "source_locator_present", "source_feed_present",
    "linked_corpus_source_present", "supersession_claimed",
  ]) assertBoolean(value[key], `${path}.${key}`);
  assertBoolean(value.superseded_by_reference_present, `${path}.superseded_by_reference_present`, {
    nullable: true,
  });
  assertEnum(value.source_document_reference_state, new Set([
    "absent", "resolution_unavailable", "resolved", "unresolved",
  ]), `${path}.source_document_reference_state`);
  assertEnum(value.source_locator_state, new Set(["absent", "stable_hash_only"]), `${path}.source_locator_state`);
  assertEnum(value.source_feed_kind_state, new Set([
    "absent", "known_public_kind", "unavailable_or_unrecognized",
  ]), `${path}.source_feed_kind_state`);
  assertEnum(value.source_feed_registry_state, new Set(["absent", "resolved", "unresolved"]), `${path}.source_feed_registry_state`);
  assertEnum(value.linked_corpus_source_state, new Set([
    "absent", "known_public_kind", "stable_hash_only",
  ]), `${path}.linked_corpus_source_state`);
  assertEnum(value.claim_record_reference_state, new Set([
    "unavailable", "not_applicable", "current_record_resolved", "scope_mapping_conflict",
    "scope_mapping_unavailable", "unresolved", "unavailable_reference_table_missing",
    "unavailable_reference_uid_missing", "unavailable_no_stable_identifier_contract",
    "unavailable_unsupported_reference_table",
  ]), `${path}.claim_record_reference_state`, { nullable: true });
  assertEnum(value.transaction_reference_state, new Set([
    "not_applicable", "current_record_resolved", "account_mapping_conflict",
    "entity_mapping_conflict", "scope_mapping_unavailable", "unresolved",
  ]), `${path}.transaction_reference_state`, { nullable: true });
  assertEnum(value.corpus_content_binding_state, new Set([
    "not_applicable", "not_applicable_direct_corpus", "matched", "mismatched",
    "expected_content_hash_unavailable", "corpus_content_hash_unavailable",
    "corpus_document_unresolved",
  ]), `${path}.corpus_content_binding_state`);
  assertStoredTimestampOrNull(value.recorded_at, `${path}.recorded_at`);
  for (const key of ["source_feed_kind", "linked_corpus_source_kind"]) {
    if (value[key] !== null && !PUBLIC_SOURCE_KINDS.has(value[key])) {
      fail(`${path}.${key}`, "unknown public source kind");
    }
  }
  assertSourceReferenceBundle(value, path);
  if (value.status_code === "complete" &&
      (value.reason_codes.length > 0 || value.missing_fields.length > 0)) {
    fail(path, "complete provenance cannot carry missing fields or reasons");
  }
  if (value.supersession_claimed === false && value.superseded_by_reference_present !== null) {
    fail(path, "an absent supersession cannot carry a target-resolution claim");
  }
  if (!Array.isArray(value.derivation_roots)) fail(`${path}.derivation_roots`, "expected an array");
  value.derivation_roots.forEach((root, index) => assertDerivationRoot(root, `${path}.derivation_roots[${index}]`));
}

function assertExtraction(value, path) {
  assertKeys(value, EXTRACTION_KEYS, path);
  if (!["native", "ocr", "ocr_partial", "unreadable", "unavailable"].includes(value.state)) {
    fail(`${path}.state`, "unknown extraction state");
  }
  if (value.readable !== null && typeof value.readable !== "boolean") {
    fail(`${path}.readable`, "expected a boolean or null");
  }
  if (value.text_source !== null &&
      !["native", "ocr", "ocr_partial"].includes(value.text_source)) {
    fail(`${path}.text_source`, "unknown assessed text source");
  }
  if (value.text_reliable !== null && typeof value.text_reliable !== "boolean") {
    fail(`${path}.text_reliable`, "expected a boolean or null");
  }
  if (value.corpus_document_present !== null &&
      typeof value.corpus_document_present !== "boolean") {
    fail(`${path}.corpus_document_present`, "expected a boolean or null");
  }
  assertEnum(value.corpus_content_binding_state, new Set([
    "not_applicable", "not_applicable_direct_corpus", "matched", "mismatched",
    "expected_content_hash_unavailable", "corpus_content_hash_unavailable",
    "corpus_document_unresolved",
  ]), `${path}.corpus_content_binding_state`);
  if (typeof value.provenance_assessed !== "boolean") {
    fail(`${path}.provenance_assessed`, "expected a boolean");
  }
  if (!["complete", "partial", "unavailable"].includes(value.provenance_status)) {
    fail(`${path}.provenance_status`, "unknown provenance receipt status");
  }
  if (!SAFE_CODE.test(String(value.provenance_reason || ""))) {
    fail(`${path}.provenance_reason`, "invalid provenance receipt reason");
  }
  const allowedReasons = PROVENANCE_REASON_BY_STATUS[value.provenance_status];
  if (!allowedReasons?.has(value.provenance_reason)) {
    fail(path, "provenance receipt status and reason disagree");
  }
  assertCodeArray(value.unavailable_fields, `${path}.unavailable_fields`);
  if (value.provenance_assessed === false) {
    if (value.provenance_status !== "unavailable" ||
        !new Set([
          "provenance_receipt_missing_or_invalid",
          "provenance_group_incomplete_or_bounded",
        ]).has(value.provenance_reason) ||
        value.text_source !== null || value.text_reliable !== null ||
        !["unavailable", "unreadable"].includes(value.state)) {
      fail(path, "unassessed provenance cannot expose or confirm extraction fields");
    }
  } else {
    if (typeof value.text_reliable !== "boolean") {
      fail(`${path}.text_reliable`, "assessed provenance requires an explicit reliability boolean");
    }
    if (["native", "ocr", "ocr_partial"].includes(value.state) &&
        value.text_source !== value.state) {
      fail(path, "extraction state must match the assessed text source");
    }
  }
  if (value.state === "unreadable" && value.readable !== false) {
    fail(path, "unreadable extraction requires readable=false");
  }
}

function assertSourceCoverage(value, path) {
  assertKeys(value, SOURCE_COVERAGE_KEYS, path);
  if (!["available", "unavailable", "not_applicable"].includes(value.state)) {
    fail(`${path}.state`, "unknown source coverage state");
  }
  if (!["source_feed_registry", "linked_corpus_registry", "not_applicable"].includes(value.basis)) {
    fail(`${path}.basis`, "unknown source coverage basis");
  }
  for (const [key, allowed] of [
    ["starter_context_state", new Set(["preparing", "ready", "degraded"])],
    ["live_updates_state", new Set(["catching_up", "current", "stale", "unavailable"])],
    ["history_state", new Set(["not_started", "running", "complete", "needs_attention", "unknown"])],
    ["meaning_search_state", new Set(["projecting", "ready", "degraded", "unknown"])],
  ]) {
    if (value[key] !== null && !allowed.has(value[key])) {
      fail(`${path}.${key}`, "unknown canonical coverage state");
    }
  }
  for (const key of ["confirmed_range", "target_range"]) {
    assertKeys(value[key], ["from", "through"], `${path}.${key}`);
    for (const bound of ["from", "through"]) {
      assertTimestampOrNull(value[key][bound], `${path}.${key}.${bound}`);
    }
  }
  if (value.current_window !== null) fail(`${path}.current_window`, "must remain null until reviewed");
  assertKeys(value.counts, ["seen", "accepted", "refused", "failed"], `${path}.counts`);
  for (const [key, count] of Object.entries(value.counts)) {
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) {
      fail(`${path}.counts.${key}`, "invalid exact source run count");
    }
  }
  if (value.projection_pending !== null &&
      (!Number.isSafeInteger(value.projection_pending) || value.projection_pending < 0)) {
    fail(`${path}.projection_pending`, "invalid projection count");
  }
  assertBoolean(value.waiting_on_owner_machine, `${path}.waiting_on_owner_machine`, {
    nullable: true,
  });
  assertTimestampOrNull(value.last_progress_at, `${path}.last_progress_at`);
  assertCodeArray(value.missing_fields, `${path}.missing_fields`);
  const anyConfirmedRange = value.confirmed_range.from !== null ||
    value.confirmed_range.through !== null;
  if (anyConfirmedRange &&
      (Object.values(value.counts).some((count) => count === null) ||
       value.counts.refused !== 0 || value.counts.failed !== 0)) {
    fail(path, "a confirmed range requires one measured clean run");
  }
  if (value.state === "not_applicable") {
    const hasEvidence = [
      value.starter_context_state, value.live_updates_state, value.history_state,
      value.meaning_search_state, value.current_window, value.last_progress_at,
      value.projection_pending, value.waiting_on_owner_machine,
      ...Object.values(value.counts), ...Object.values(value.confirmed_range),
      ...Object.values(value.target_range),
    ].some((item) => item !== null);
    if (value.basis !== "not_applicable" || hasEvidence || value.missing_fields.length > 0) {
      fail(path, "not-applicable source coverage must contain no source evidence");
    }
  } else if (value.basis === "not_applicable") {
    fail(path, "source coverage evidence requires a source-registry basis");
  }
  if (value.state === "unavailable") {
    const hasEvidence = [
      value.starter_context_state, value.live_updates_state, value.history_state,
      value.meaning_search_state, value.current_window, value.last_progress_at,
      value.projection_pending, value.waiting_on_owner_machine,
      ...Object.values(value.counts), ...Object.values(value.confirmed_range),
      ...Object.values(value.target_range),
    ].some((item) => item !== null);
    if (hasEvidence || value.missing_fields.length === 0) {
      fail(path, "unavailable source coverage cannot contain assessed evidence");
    }
  }
  if (value.state === "available" &&
      [value.starter_context_state, value.live_updates_state,
        value.history_state, value.meaning_search_state].some((item) => item === null)) {
    fail(path, "available source coverage requires all canonical dimension states");
  }
}

function assertFreshness(value, path) {
  assertKeys(value, FRESHNESS_KEYS, path);
  assertEnum(value.state, new Set([
    "timestamps_available_assessment_not_computed", "unavailable",
  ]), `${path}.state`);
  if (value.current_or_stale !== null) fail(`${path}.current_or_stale`, "must remain null until reviewed");
  if (value.source_status !== null) assertDiagnosticCode(value.source_status, `${path}.source_status`);
  assertStoredTimestampOrNull(value.source_last_ingest_at, `${path}.source_last_ingest_at`);
  assertSafeInteger(value.corpus_ingested_at_ms, `${path}.corpus_ingested_at_ms`, { nullable: true });
  assertStoredTimestampOrNull(value.evidence_recorded_at, `${path}.evidence_recorded_at`);
  assertEnum(value.expected_cadence, new Set([
    "daily", "weekly", "monthly", "quarterly", "annual",
  ]), `${path}.expected_cadence`, { nullable: true });
  assertSourceCoverage(value.source_coverage, `${path}.source_coverage`);
  assertCodeArray(value.missing_fields, `${path}.missing_fields`);
}

function assertVerification(value, path) {
  assertKeys(value, VERIFICATION_KEYS, path);
  assertEnum(value.provenance_state, new Set([
    "owner_stated", "document_cited", "document_reference_unresolved", "incomplete",
    "feed_registry_cited", "feed_registry_unresolved", "derived_roots_cited",
    "derived_roots_unavailable", "unavailable",
  ]), `${path}.provenance_state`);
  assertEnum(value.provenance_status_code, new Set(["complete", "incomplete"]), `${path}.provenance_status_code`);
  assertBoolean(value.provenance_debt, `${path}.provenance_debt`);
  assertEnum(value.freshness_state, new Set([
    "timestamps_available_assessment_not_computed", "unavailable",
  ]), `${path}.freshness_state`);
  assertBoolean(value.extraction_relevant, `${path}.extraction_relevant`);
  assertBoolean(value.blocks_financial_verification, `${path}.blocks_financial_verification`);
  assertEnum(value.gap_state, new Set(["blocking", "clear"]), `${path}.gap_state`);
  for (const key of [
    "provenance_reason_codes", "missing_provenance_fields", "missing_extraction_fields",
    "missing_freshness_fields", "missing_verification_fields", "blocking_reasons",
    "gap_reason_codes",
  ]) assertCodeArray(value[key], `${path}.${key}`);
  assertExtraction(value.extraction, `${path}.extraction`);
  assertFreshness(value.freshness, `${path}.freshness`);
  if (value.provenance_debt !== (value.provenance_status_code === "incomplete")) {
    fail(path, "provenance debt must match the provenance status");
  }
  if (value.freshness_state !== value.freshness.state) {
    fail(path, "freshness summary must match the nested freshness state");
  }
  if (value.blocks_financial_verification !== (value.blocking_reasons.length > 0) ||
      value.gap_state !== (value.blocking_reasons.length > 0 ? "blocking" : "clear")) {
    fail(path, "blocking summary is internally inconsistent");
  }
}

function assertFieldBasisMap(value, path) {
  if (!plainObject(value)) fail(path, "expected a field basis map");
  for (const [field, basis] of Object.entries(value)) {
    if (!MAPPING_FIELDS.has(field)) fail(`${path}.${field}`, "unknown mapping field");
    assertKeys(
      basis,
      FIELD_BASIS_KEYS,
      `${path}.${field}`,
      ["provenance", "basis_state", "stored_owner_assertion", "owner_actor_receipt_present"],
    );
    assertEnum(basis.provenance, PROVENANCE_VALUES, `${path}.${field}.provenance`, { nullable: true });
    assertEnum(basis.basis_state, BASIS_STATES, `${path}.${field}.basis_state`, { nullable: true });
    assertBoolean(basis.stored_owner_assertion, `${path}.${field}.stored_owner_assertion`);
    assertBoolean(basis.owner_actor_receipt_present, `${path}.${field}.owner_actor_receipt_present`);
    if (Object.hasOwn(basis, "reference_present")) {
      assertBoolean(basis.reference_present, `${path}.${field}.reference_present`);
    }
    if (Object.hasOwn(basis, "mapping_conflict")) {
      assertBoolean(basis.mapping_conflict, `${path}.${field}.mapping_conflict`);
    }
    if (Object.hasOwn(basis, "stored_field") &&
        basis.stored_field !== "documents.meta.qbo_company_fingerprint") {
      fail(`${path}.${field}.stored_field`, "unknown stored-field marker");
    }
  }
}

function assertMapping(value, path, nullable = false) {
  if (value === null && nullable) return;
  assertKeys(value, MAPPING_KEYS, path);
  assertEnum(value.state, new Set([
    "stored_owner_assertions_unconfirmed", "current_owner_confirmation_required",
  ]), `${path}.state`);
  if (value.confirmed_by_owner !== null) {
    fail(`${path}.confirmed_by_owner`, "owner confirmation requires an unavailable actor receipt");
  }
  if (!plainObject(value.field_states)) fail(`${path}.field_states`, "expected a field state map");
  for (const [field, state] of Object.entries(value.field_states)) {
    if (!MAPPING_FIELDS.has(field) || !FIELD_STATES.has(state)) {
      fail(`${path}.field_states.${field}`, "invalid field state");
    }
  }
  assertFieldBasisMap(value.field_basis, `${path}.field_basis`);
  for (const key of ["confirmed_fields", "stored_owner_assertion_fields"]) {
    assertStringArray(value[key], `${path}.${key}`, MAPPING_FIELDS);
  }
  assertCodeArray(value.missing_fields, `${path}.missing_fields`);
  assertCodeArray(value.reason_codes, `${path}.reason_codes`);
  if (value.confirmed_fields.length !== 0) {
    fail(`${path}.confirmed_fields`, "no field can be owner-confirmed without an actor receipt");
  }
  const fields = Object.keys(value.field_states).sort();
  const basisFields = Object.keys(value.field_basis).sort();
  if (fields.length !== basisFields.length ||
      fields.some((field, index) => field !== basisFields[index])) {
    fail(path, "mapping field states and field evidence must cover the same fields");
  }
  for (const field of value.stored_owner_assertion_fields) {
    const basis = value.field_basis[field];
    if (value.field_states[field] !== "stored_owner_assertion_unconfirmed" ||
        basis?.stored_owner_assertion !== true || basis?.owner_actor_receipt_present !== false ||
        basis?.provenance !== "owner_stated" || basis?.basis_state !== "confirmed") {
      fail(`${path}.stored_owner_assertion_fields`, "stored owner assertion is not supported by field evidence");
    }
  }
}

function assertDerivationRoot(value, path) {
  const keys = [
    "claim_ref", "claim_target_kind", "claim_record_ref",
    "claim_record_reference_state", "provenance", "provenance_state",
    "provenance_status_code", "provenance_reason_codes",
    "missing_provenance_fields", "source_document_ref", "source_document_present",
    "source_document_reference_state", "source_locator_present", "source_locator_ref",
    "source_locator_state", "source_feed_ref", "source_feed_present",
    "source_feed_kind", "source_feed_kind_state", "source_feed_registry_state",
    "linked_corpus_source_ref", "linked_corpus_source_present",
    "linked_corpus_source_kind", "linked_corpus_source_state", "basis_state",
    "recorded_at", "freshness", "verification",
  ];
  assertKeys(value, keys, path);
  assertReference(value.claim_ref, `${path}.claim_ref`);
  assertReference(value.claim_record_ref, `${path}.claim_record_ref`);
  assertReference(value.source_document_ref, `${path}.source_document_ref`);
  assertReference(value.source_locator_ref, `${path}.source_locator_ref`);
  assertReference(value.source_feed_ref, `${path}.source_feed_ref`);
  assertReference(value.linked_corpus_source_ref, `${path}.linked_corpus_source_ref`);
  assertEnum(value.claim_record_reference_state, new Set([
    "unavailable", "not_applicable", "current_record_resolved", "scope_mapping_conflict",
    "scope_mapping_unavailable", "unresolved", "unavailable_reference_table_missing",
    "unavailable_reference_uid_missing", "unavailable_no_stable_identifier_contract",
    "unavailable_unsupported_reference_table",
  ]), `${path}.claim_record_reference_state`, { nullable: true });
  assertEnum(value.provenance, PROVENANCE_VALUES, `${path}.provenance`, { nullable: true });
  assertEnum(value.provenance_state, new Set([
    "owner_stated", "document_cited", "document_reference_unresolved", "incomplete",
    "feed_registry_cited", "feed_registry_unresolved", "derived_roots_cited",
    "derived_roots_unavailable", "unavailable",
  ]), `${path}.provenance_state`);
  assertEnum(value.provenance_status_code, new Set(["complete", "incomplete"]), `${path}.provenance_status_code`);
  assertEnum(value.basis_state, BASIS_STATES, `${path}.basis_state`, { nullable: true });
  assertStoredTimestampOrNull(value.recorded_at, `${path}.recorded_at`);
  for (const key of [
    "source_document_present", "source_locator_present", "source_feed_present",
    "linked_corpus_source_present",
  ]) assertBoolean(value[key], `${path}.${key}`);
  assertEnum(value.source_document_reference_state, new Set([
    "absent", "resolution_unavailable", "resolved", "unresolved",
  ]), `${path}.source_document_reference_state`);
  assertEnum(value.source_locator_state, new Set(["absent", "stable_hash_only"]), `${path}.source_locator_state`);
  assertEnum(value.source_feed_kind_state, new Set([
    "absent", "known_public_kind", "unavailable_or_unrecognized",
  ]), `${path}.source_feed_kind_state`);
  assertEnum(value.source_feed_registry_state, new Set(["absent", "resolved", "unresolved"]), `${path}.source_feed_registry_state`);
  assertEnum(value.linked_corpus_source_state, new Set([
    "absent", "known_public_kind", "stable_hash_only",
  ]), `${path}.linked_corpus_source_state`);
  for (const key of ["source_feed_kind", "linked_corpus_source_kind"]) {
    if (value[key] !== null && !PUBLIC_SOURCE_KINDS.has(value[key])) {
      fail(`${path}.${key}`, "unknown public source kind");
    }
  }
  assertSourceReferenceBundle(value, path);
  const targetKinds = new Set([
    "document", "statement", "transaction",
    "balance_snapshot_without_stable_identifier_contract", "unsupported",
  ]);
  if (value.claim_target_kind !== null && !targetKinds.has(value.claim_target_kind)) {
    fail(`${path}.claim_target_kind`, "unknown claim target kind");
  }
  assertCodeArray(value.provenance_reason_codes, `${path}.provenance_reason_codes`);
  assertCodeArray(value.missing_provenance_fields, `${path}.missing_provenance_fields`);
  assertFreshness(value.freshness, `${path}.freshness`);
  assertVerification(value.verification, `${path}.verification`);
}

function assertSourceProvenance(value, path) {
  const keys = [
    "source_document_ref", "source_document_present", "source_document_reference_state",
    "source_locator_present", "source_locator_ref", "source_locator_state",
    "source_feed_ref", "source_feed_present", "source_feed_kind",
    "source_feed_kind_state", "source_feed_registry_state",
    "linked_corpus_source_ref", "linked_corpus_source_present",
    "linked_corpus_source_kind", "linked_corpus_source_state", "source_status",
    "source_last_ingest_at", "provenance", "basis_state", "unparsed_reason",
    "provenance_state", "provenance_status_code", "provenance_reason_codes",
    "availability", "readable", "restricted", "recorded_at",
  ];
  assertKeys(value, keys, path);
  for (const key of [
    "source_document_ref", "source_locator_ref", "source_feed_ref",
    "linked_corpus_source_ref",
  ]) assertReference(value[key], `${path}.${key}`);
  for (const key of [
    "source_document_present", "source_locator_present", "source_feed_present",
    "linked_corpus_source_present", "readable", "restricted",
  ]) assertBoolean(value[key], `${path}.${key}`, { nullable: key === "readable" || key === "restricted" });
  for (const key of ["source_feed_kind", "linked_corpus_source_kind"]) {
    if (value[key] !== null && !PUBLIC_SOURCE_KINDS.has(value[key])) {
      fail(`${path}.${key}`, "unknown public source kind");
    }
  }
  assertSourceReferenceBundle(value, path);
  assertEnum(value.source_document_reference_state, new Set([
    "absent", "resolution_unavailable", "resolved", "unresolved",
  ]), `${path}.source_document_reference_state`);
  assertEnum(value.source_locator_state, new Set(["absent", "stable_hash_only"]), `${path}.source_locator_state`);
  assertEnum(value.source_feed_kind_state, new Set([
    "absent", "known_public_kind", "unavailable_or_unrecognized",
  ]), `${path}.source_feed_kind_state`);
  assertEnum(value.source_feed_registry_state, new Set(["absent", "resolved", "unresolved"]), `${path}.source_feed_registry_state`);
  assertEnum(value.linked_corpus_source_state, new Set([
    "absent", "known_public_kind", "stable_hash_only",
  ]), `${path}.linked_corpus_source_state`);
  if (value.source_status !== null) assertDiagnosticCode(value.source_status, `${path}.source_status`);
  assertStoredTimestampOrNull(value.source_last_ingest_at, `${path}.source_last_ingest_at`);
  assertEnum(value.provenance, PROVENANCE_VALUES, `${path}.provenance`, { nullable: true });
  assertEnum(value.basis_state, BASIS_STATES, `${path}.basis_state`, { nullable: true });
  assertPublicText(value.unparsed_reason, `${path}.unparsed_reason`, { nullable: true, max: 512 });
  assertEnum(value.provenance_state, new Set([
    "owner_stated", "document_cited", "document_reference_unresolved", "incomplete",
    "feed_registry_cited", "feed_registry_unresolved", "derived_roots_cited",
    "derived_roots_unavailable", "unavailable",
  ]), `${path}.provenance_state`);
  assertEnum(value.provenance_status_code, new Set(["complete", "incomplete"]), `${path}.provenance_status_code`);
  assertEnum(value.availability, new Set(["have_it", "can_get_it", "do_not_have_it"]), `${path}.availability`, { nullable: true });
  assertStoredTimestampOrNull(value.recorded_at, `${path}.recorded_at`);
  assertCodeArray(value.provenance_reason_codes, `${path}.provenance_reason_codes`);
}

function assertMaterialFields(value, path) {
  const fields = ["kind", "status", "holds", "ownership_basis_points", "tax_class", "relationship"];
  assertKeys(value, fields, path);
  for (const field of fields) {
    const itemPath = `${path}.${field}`;
    assertKeys(value[field], MATERIAL_FIELD_KEYS, itemPath);
    if (field === "ownership_basis_points") {
      assertSafeInteger(value[field].stored_value, `${itemPath}.stored_value`, {
        nullable: true, max: 10000,
      });
    } else if (field === "kind") {
      assertEnum(value[field].stored_value, new Set([
        "person", "household", "trust", "business", "property", "investment",
      ]), `${itemPath}.stored_value`, { nullable: true });
    } else if (field === "status") {
      assertEnum(value[field].stored_value, new Set([
        "active", "sold", "dissolved", "closed",
      ]), `${itemPath}.stored_value`, { nullable: true });
    } else if (field === "relationship") {
      assertEnum(value[field].stored_value, new Set(["owned", "counterparty"]), `${itemPath}.stored_value`, { nullable: true });
    } else {
      assertPublicText(value[field].stored_value, `${itemPath}.stored_value`, { nullable: true, max: 512 });
    }
    assertEnum(value[field].confirmation_state, FIELD_STATES, `${itemPath}.confirmation_state`);
    if (value[field].confirmed_by_owner !== null) {
      fail(`${itemPath}.confirmed_by_owner`, "owner confirmation requires an unavailable actor receipt");
    }
    assertBoolean(value[field].owner_actor_receipt_present, `${itemPath}.owner_actor_receipt_present`);
    assertBoolean(value[field].stored_owner_assertion, `${itemPath}.stored_owner_assertion`);
    assertEnum(value[field].provenance, PROVENANCE_VALUES, `${itemPath}.provenance`, { nullable: true });
    assertEnum(value[field].basis_state, BASIS_STATES, `${itemPath}.basis_state`, { nullable: true });
    assertCodeArray(value[field].missing_fields, `${itemPath}.missing_fields`);
    if (value[field].owner_actor_receipt_present !== false) {
      fail(`${itemPath}.owner_actor_receipt_present`, "owner actor receipt is unavailable in this schema");
    }
    if (value[field].stored_owner_assertion === true &&
        (value[field].confirmation_state !== "stored_owner_assertion_unconfirmed" ||
         value[field].provenance !== "owner_stated" ||
         value[field].basis_state !== "confirmed" || value[field].stored_value === null)) {
      fail(itemPath, "stored owner assertion cannot be presented as settled or unsupported");
    }
    if (value[field].stored_value === null &&
        !["stored_value_missing", "unavailable"].includes(value[field].confirmation_state)) {
      fail(itemPath, "missing material value must remain an explicit gap");
    }
  }
}

const ENTITY_REFERENCE_STATES = new Set([
  "current_entity_resolved", "unresolved", "stored_value_missing", "not_applicable",
]);
const ACCOUNT_REFERENCE_STATES = new Set([
  "current_account_resolved", "unresolved", "not_applicable",
]);
const ENTITY_ACCOUNT_MAPPING_STATES = new Set([
  "not_applicable", "unavailable_due_to_unresolved_reference", "consistent", "conflict",
]);

function assertEntityAndAccountReferences(value, path) {
  if (Object.hasOwn(value, "entity_reference_state")) {
    assertEnum(value.entity_reference_state, ENTITY_REFERENCE_STATES, `${path}.entity_reference_state`);
    const requiresRef = ["current_entity_resolved", "unresolved"].includes(value.entity_reference_state);
    if (requiresRef !== (value.entity_ref !== null)) {
      fail(`${path}.entity_ref`, "entity reference and resolution state disagree");
    }
  }
  if (Object.hasOwn(value, "account_reference_state")) {
    assertEnum(value.account_reference_state, ACCOUNT_REFERENCE_STATES, `${path}.account_reference_state`);
    const requiresRef = ["current_account_resolved", "unresolved"].includes(value.account_reference_state);
    if (requiresRef !== (value.account_ref !== null)) {
      fail(`${path}.account_ref`, "account reference and resolution state disagree");
    }
  }
  if (Object.hasOwn(value, "entity_account_mapping_state")) {
    assertEnum(value.entity_account_mapping_state, ENTITY_ACCOUNT_MAPPING_STATES, `${path}.entity_account_mapping_state`);
  }
}

function assertTaxAndPeriod(value, path) {
  if (Object.hasOwn(value, "tax_year")) {
    assertSafeInteger(value.tax_year, `${path}.tax_year`, { nullable: true, min: 1900, max: 2200 });
  }
  for (const key of ["period_start", "period_end"]) {
    if (Object.hasOwn(value, key)) assertDateOrNull(value[key], `${path}.${key}`);
  }
  if (value.period_start && value.period_end && value.period_end < value.period_start) {
    fail(path, "period end cannot precede period start");
  }
}

function assertCustody(value, path, { extended = false } = {}) {
  assertEnum(value.class, new Set(["reference", "reconcilable"]), `${path}.class`);
  assertEnum(value.availability, new Set(["have_it", "can_get_it", "do_not_have_it"]), `${path}.availability`);
  for (const key of ["filed_at", "received_at", ...(extended
    ? ["reconciled_through"] : [])]) {
    if (key === "received_at") assertDateOrTimestampOrNull(value[key], `${path}.${key}`);
    else assertDateOrNull(value[key], `${path}.${key}`);
  }
  assertPublicText(value.received_from, `${path}.received_from`, { nullable: true, max: 256 });
  if (extended) {
    assertPublicText(value.available_from, `${path}.available_from`, { nullable: true, max: 256 });
  }
  assertBoolean(value.readable, `${path}.readable`);
  assertBoolean(value.restricted, `${path}.restricted`);
  if (extended) {
    assertSafeInteger(value.available_within_days, `${path}.available_within_days`, {
      nullable: true, max: 36500,
    });
    assertBoolean(value.unreadable_reason_present, `${path}.unreadable_reason_present`);
  }
}

function assertGroupEvidence(value, evidenceCount, path) {
  assertKeys(value, [
    "evidence_records", "provenance_assessed_records",
    "provenance_unassessed_records", "missing_text_source", "missing_text_reliable",
  ], path);
  for (const key of Object.keys(value)) {
    assertSafeInteger(value[key], `${path}.${key}`);
  }
  if (value.evidence_records !== evidenceCount ||
      value.provenance_assessed_records + value.provenance_unassessed_records !== evidenceCount ||
      value.missing_text_source > evidenceCount || value.missing_text_reliable > evidenceCount ||
      value.missing_text_source < value.provenance_unassessed_records ||
      value.missing_text_reliable < value.provenance_unassessed_records) {
    fail(path, "group extraction counters are arithmetically inconsistent");
  }
}

function assertRecord(section, value, path) {
  const keys = RECORD_KEYS[section];
  if (!keys) fail(path, "records are not supported for this section");
  assertKeys(value, keys, path);
  for (const [key, nested] of Object.entries(value)) {
    if (key.endsWith("_ref")) assertReference(nested, `${path}.${key}`);
  }
  assertLineage(value.source_lineage, `${path}.source_lineage`);
  assertVerification(value.verification, `${path}.verification`);
  assertEntityAndAccountReferences(value, path);
  assertTaxAndPeriod(value, path);

  if (section === "entities") {
    if (value.entity_ref === null) fail(`${path}.entity_ref`, "entity record requires an opaque entity reference");
    assertKeys(value.stored_name, ["legal_name", "display_label"], `${path}.stored_name`);
    assertPublicText(value.stored_name.legal_name, `${path}.stored_name.legal_name`, { max: 512 });
    assertPublicText(value.stored_name.display_label, `${path}.stored_name.display_label`, { nullable: true, max: 512 });
    assertMaterialFields(value.material_fields, `${path}.material_fields`);
    assertEnum(value.scope_state, new Set([
      "stored_counterparty_assertion_unconfirmed", "stored_owner_assertion_unconfirmed",
      "possible_mention",
    ]), `${path}.scope_state`);
    if (value.ownership_confirmed !== null) {
      fail(`${path}.ownership_confirmed`, "ownership requires a current owner actor receipt");
    }
    assertEnum(value.parent_entity_reference_state, ENTITY_REFERENCE_STATES, `${path}.parent_entity_reference_state`);
    const parentRefRequired = ["current_entity_resolved", "unresolved"].includes(value.parent_entity_reference_state);
    if (parentRefRequired !== (value.parent_entity_ref !== null) ||
        (parentRefRequired && value.parent_mapping_confirmation === null) ||
        (!parentRefRequired && value.parent_mapping_confirmation !== null)) {
      fail(path, "parent entity reference, state, and mapping evidence disagree");
    }
    assertMapping(value.parent_mapping_confirmation, `${path}.parent_mapping_confirmation`, true);
    assertKeys(value.scope_confirmation, [
      "state", "ownership_confirmed", "relationship_confirmed_by_owner",
      "relationship_confirmation_state", "stored_owner_assertion",
      "owner_actor_receipt_present", "missing_fields", "reason_codes",
    ], `${path}.scope_confirmation`);
    assertEnum(value.scope_confirmation.state, new Set([
      "stored_counterparty_assertion_unconfirmed", "stored_owner_assertion_unconfirmed",
      "possible_mention",
    ]), `${path}.scope_confirmation.state`);
    if (value.scope_confirmation.ownership_confirmed !== null ||
        value.scope_confirmation.relationship_confirmed_by_owner !== null) {
      fail(`${path}.scope_confirmation`, "scope confirmation requires a current owner actor receipt");
    }
    assertEnum(value.scope_confirmation.relationship_confirmation_state, FIELD_STATES, `${path}.scope_confirmation.relationship_confirmation_state`);
    assertBoolean(value.scope_confirmation.stored_owner_assertion, `${path}.scope_confirmation.stored_owner_assertion`);
    assertBoolean(value.scope_confirmation.owner_actor_receipt_present, `${path}.scope_confirmation.owner_actor_receipt_present`);
    assertCodeArray(value.scope_confirmation.missing_fields, `${path}.scope_confirmation.missing_fields`);
    assertCodeArray(value.scope_confirmation.reason_codes, `${path}.scope_confirmation.reason_codes`);
    assertLineage(value.entity_mapping_basis, `${path}.entity_mapping_basis`);
  } else {
    assertMapping(value.mapping_confirmation, `${path}.mapping_confirmation`);
  }

  if (section === "periods") {
    if (value.period_ref === null) fail(`${path}.period_ref`, "period record requires an opaque reference");
    assertEnum(value.covered_via_account_reference_state, ACCOUNT_REFERENCE_STATES, `${path}.covered_via_account_reference_state`);
    const coveredRefRequired = ["current_account_resolved", "unresolved"].includes(value.covered_via_account_reference_state);
    if (coveredRefRequired !== (value.covered_via_account_ref !== null)) {
      fail(path, "covered-via account reference and state disagree");
    }
    assertEnum(value.period_kind, new Set([
      "tax_year", "document_period", "account_coverage", "statement_period", "period_close",
    ]), `${path}.period_kind`);
    if (value.evidence_kind !== null) assertDiagnosticCode(value.evidence_kind, `${path}.evidence_kind`);
    assertFieldBasisMap(value.entity_period_mapping_basis, `${path}.entity_period_mapping_basis`);
  } else if (section === "accounts") {
    if (value.account_ref === null || value.entity_ref === null) {
      fail(path, "account record requires opaque account and entity references");
    }
    assertPublicText(value.masked_identity, `${path}.masked_identity`, { max: 512 });
    assertPublicText(value.institution, `${path}.institution`, { nullable: true, max: 120 });
    assertEnum(value.category, new Set([
      "bank", "credit_card", "loan", "investment", "payment_processor", "unclassified",
    ]), `${path}.category`);
    assertEnum(value.stored_account_kind, new Set([
      "checking", "savings", "card", "loan", "line_of_credit", "investment",
      "retirement", "merchant", "point_of_sale", "escrow", "other",
    ]), `${path}.stored_account_kind`);
    assertEnum(value.balance_role, new Set(["asset", "liability", "neither"]), `${path}.balance_role`);
    if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
      fail(`${path}.currency`, "expected a three-letter currency code");
    }
    assertEnum(value.feed_mode, new Set(["live", "manual", "none"]), `${path}.feed_mode`);
    assertEnum(value.expected_cadence, new Set([
      "daily", "weekly", "monthly", "quarterly", "annual",
    ]), `${path}.expected_cadence`, { nullable: true });
    assertEnum(value.status, new Set(["open", "closed", "never_connected"]), `${path}.status`);
    assertDateOrNull(value.opened_on, `${path}.opened_on`);
    assertDateOrNull(value.closed_on, `${path}.closed_on`);
    assertFieldBasisMap(value.account_entity_mapping_basis, `${path}.account_entity_mapping_basis`);
    if (value.coverage !== null) {
      assertKeys(value.coverage, [
        "status", "covered_from", "covered_to", "covered_via_account_ref",
        "covered_via_account_reference_state", "computed_at", "mapping_confirmation",
        "source_lineage", "verification",
      ], `${path}.coverage`);
      assertEnum(value.coverage.status, new Set([
        "complete", "partial", "gapped", "indirect", "none", "unknown",
      ]), `${path}.coverage.status`);
      assertDateOrNull(value.coverage.covered_from, `${path}.coverage.covered_from`);
      assertDateOrNull(value.coverage.covered_to, `${path}.coverage.covered_to`);
      assertEnum(value.coverage.covered_via_account_reference_state, ACCOUNT_REFERENCE_STATES, `${path}.coverage.covered_via_account_reference_state`);
      assertStoredTimestampOrNull(value.coverage.computed_at, `${path}.coverage.computed_at`);
      assertReference(value.coverage.covered_via_account_ref, `${path}.coverage.covered_via_account_ref`);
      assertMapping(value.coverage.mapping_confirmation, `${path}.coverage.mapping_confirmation`);
      assertLineage(value.coverage.source_lineage, `${path}.coverage.source_lineage`);
      assertVerification(value.coverage.verification, `${path}.coverage.verification`);
    }
  } else if (section === "books") {
    if (value.books_ref === null) fail(`${path}.books_ref`, "books record requires an opaque reference");
    assertEnum(value.record_type, new Set([
      "quickbooks_company_observation", "books_document_evidence",
    ]), `${path}.record_type`);
    if (value.system_identity !== null) {
      assertKeys(value.system_identity, ["kind", "ref"], `${path}.system_identity`);
      if (value.system_identity.kind !== "quickbooks_company_reference") {
        fail(`${path}.system_identity.kind`, "unknown system identity kind");
      }
      assertReference(value.system_identity.ref, `${path}.system_identity.ref`);
    }
    if (value.document_kind !== null) assertDiagnosticCode(value.document_kind, `${path}.document_kind`);
    assertSafeInteger(value.evidence_count, `${path}.evidence_count`);
    assertDateOrNull(value.observed_record_from, `${path}.observed_record_from`);
    assertDateOrNull(value.observed_record_to, `${path}.observed_record_to`);
    assertSafeInteger(value.last_ingested_at_ms, `${path}.last_ingested_at_ms`, { nullable: true });
    assertGroupEvidence(value.extraction_group_evidence, value.evidence_count, `${path}.extraction_group_evidence`);
    assertSourceProvenance(value.source_provenance, `${path}.source_provenance`);
  } else if (section === "tax_returns" || section === "filing_payments") {
    if (value.evidence_ref === null) fail(`${path}.evidence_ref`, "tax evidence requires an opaque reference");
    assertKeys(value.custody, [
      "class", "availability", "filed_at", "received_from", "received_at",
      "readable", "restricted",
    ], `${path}.custody`);
    if (value.evidence_kind !== null) assertDiagnosticCode(value.evidence_kind, `${path}.evidence_kind`);
    if (section === "tax_returns" &&
        (value.tax_form !== null || value.k1_issuer_or_recipient_role !== null)) {
      fail(path, "tax form and K-1 role are unavailable in this schema");
    }
    assertCustody(value.custody, `${path}.custody`);
    assertLineage(value.entity_tax_period_mapping_basis, `${path}.entity_tax_period_mapping_basis`);
  } else if (section === "evidence") {
    if (value.evidence_ref === null) fail(`${path}.evidence_ref`, "evidence record requires an opaque reference");
    assertKeys(value.custody, [
      "class", "availability", "available_from", "available_within_days", "filed_at",
      "reconciled_through", "received_from", "received_at", "readable",
      "unreadable_reason_present", "restricted",
    ], `${path}.custody`);
    assertEnum(value.current_state, new Set([
      "current", "superseded", "supersession_unresolved",
    ]), `${path}.current_state`);
    if (value.evidence_kind !== null) assertDiagnosticCode(value.evidence_kind, `${path}.evidence_kind`);
    assertCustody(value.custody, `${path}.custody`, { extended: true });
    assertKeys(value.supersession, [
      "claimed", "stored_target_ref", "reference_state", "missing_fields",
    ], `${path}.supersession`);
    assertBoolean(value.supersession.claimed, `${path}.supersession.claimed`);
    assertEnum(value.supersession.reference_state, new Set([
      "not_applicable", "resolved_same_tenant_stable_key", "unresolved_or_mismatched",
    ]), `${path}.supersession.reference_state`);
    assertReference(value.supersession.stored_target_ref, `${path}.supersession.stored_target_ref`);
    assertCodeArray(value.supersession.missing_fields, `${path}.supersession.missing_fields`);
    const provenanceKeys = [
      "state", "status_code", "reason_codes", "kind", "basis_state",
      "unparsed_reason", "confidence_basis_points", "source_document_ref",
      "source_document_present", "source_document_reference_state",
      "source_locator_present", "source_locator_ref", "source_locator_state",
      "source_feed_ref", "source_feed_present", "source_feed_kind",
      "source_feed_kind_state", "source_feed_registry_state",
      "linked_corpus_source_ref", "linked_corpus_source_present",
      "linked_corpus_source_kind", "linked_corpus_source_state",
      "corpus_document_present", "recorded_at", "supersession_claimed",
      "superseded_by_reference_present", "corpus_ingested_at_ms", "source_status",
      "source_last_ingest_at",
    ];
    assertKeys(value.provenance, provenanceKeys, `${path}.provenance`);
    assertEnum(value.provenance.state, new Set([
      "owner_stated", "document_cited", "document_reference_unresolved", "incomplete",
      "feed_registry_cited", "feed_registry_unresolved", "derived_roots_cited",
      "derived_roots_unavailable", "unavailable",
    ]), `${path}.provenance.state`);
    assertEnum(value.provenance.status_code, new Set(["complete", "incomplete"]), `${path}.provenance.status_code`);
    assertEnum(value.provenance.kind, PROVENANCE_VALUES, `${path}.provenance.kind`, { nullable: true });
    assertEnum(value.provenance.basis_state, BASIS_STATES, `${path}.provenance.basis_state`, { nullable: true });
    assertPublicText(value.provenance.unparsed_reason, `${path}.provenance.unparsed_reason`, { nullable: true, max: 512 });
    assertSafeInteger(value.provenance.confidence_basis_points, `${path}.provenance.confidence_basis_points`, { nullable: true, max: 10000 });
    for (const key of [
      "source_document_present", "source_locator_present", "source_feed_present",
      "linked_corpus_source_present", "corpus_document_present", "supersession_claimed",
    ]) assertBoolean(value.provenance[key], `${path}.provenance.${key}`);
    assertBoolean(value.provenance.superseded_by_reference_present, `${path}.provenance.superseded_by_reference_present`, { nullable: true });
    assertStoredTimestampOrNull(value.provenance.recorded_at, `${path}.provenance.recorded_at`);
    assertSafeInteger(value.provenance.corpus_ingested_at_ms, `${path}.provenance.corpus_ingested_at_ms`, { nullable: true });
    if (value.provenance.source_status !== null) assertDiagnosticCode(value.provenance.source_status, `${path}.provenance.source_status`);
    assertStoredTimestampOrNull(value.provenance.source_last_ingest_at, `${path}.provenance.source_last_ingest_at`);
    for (const key of [
      "source_document_ref", "source_locator_ref", "source_feed_ref",
      "linked_corpus_source_ref",
    ]) assertReference(value.provenance[key], `${path}.provenance.${key}`);
    assertCodeArray(value.provenance.reason_codes, `${path}.provenance.reason_codes`);
    assertEnum(value.provenance.source_document_reference_state, new Set([
      "absent", "resolution_unavailable", "resolved", "unresolved",
    ]), `${path}.provenance.source_document_reference_state`);
    assertEnum(value.provenance.source_locator_state, new Set(["absent", "stable_hash_only"]), `${path}.provenance.source_locator_state`);
    assertEnum(value.provenance.source_feed_kind_state, new Set([
      "absent", "known_public_kind", "unavailable_or_unrecognized",
    ]), `${path}.provenance.source_feed_kind_state`);
    assertEnum(value.provenance.source_feed_registry_state, new Set(["absent", "resolved", "unresolved"]), `${path}.provenance.source_feed_registry_state`);
    assertEnum(value.provenance.linked_corpus_source_state, new Set([
      "absent", "known_public_kind", "stable_hash_only",
    ]), `${path}.provenance.linked_corpus_source_state`);
    for (const key of ["source_feed_kind", "linked_corpus_source_kind"]) {
      if (value.provenance[key] !== null && !PUBLIC_SOURCE_KINDS.has(value.provenance[key])) {
        fail(`${path}.provenance.${key}`, "unknown public source kind");
      }
    }
    assertSourceReferenceBundle(value.provenance, `${path}.provenance`);
    if (value.supersession.claimed !== value.provenance.supersession_claimed ||
        value.supersession.claimed !== (value.current_state !== "current") ||
        (value.current_state === "superseded") !== (value.superseded_by_ref !== null) ||
        (value.supersession.reference_state === "resolved_same_tenant_stable_key") !==
          (value.superseded_by_ref !== null)) {
      fail(path, "supersession state and opaque target reference disagree");
    }
  } else if (section === "conflicts") {
    if (value.conflict_ref === null) fail(`${path}.conflict_ref`, "conflict record requires an opaque reference");
    assertEnum(value.conflict_type, new Set(["reconciliation", "exception"]), `${path}.conflict_type`);
    assertDiagnosticCode(value.conflict_state, `${path}.conflict_state`);
    assertDiagnosticCode(value.conflict_kind, `${path}.conflict_kind`);
    assertEnum(value.transaction_reference_state, new Set([
      "not_applicable", "current_record_resolved", "account_mapping_conflict",
      "entity_mapping_conflict", "scope_mapping_unavailable", "unresolved",
    ]), `${path}.transaction_reference_state`);
    assertDateOrTimestampOrNull(value.observed_at, `${path}.observed_at`);
    assertLineage(value.conflict_derivation_basis, `${path}.conflict_derivation_basis`);
    assertKeys(value.derivation_root_page, [
      "total", "returned", "truncated", "cursor", "unavailable_reason",
    ], `${path}.derivation_root_page`);
    assertSafeInteger(value.derivation_root_page.total, `${path}.derivation_root_page.total`);
    assertSafeInteger(value.derivation_root_page.returned, `${path}.derivation_root_page.returned`);
    assertBoolean(value.derivation_root_page.truncated, `${path}.derivation_root_page.truncated`);
    if (value.derivation_root_page.cursor !== null) fail(`${path}.derivation_root_page.cursor`, "nested cursor is unavailable");
    assertPublicText(value.derivation_root_page.unavailable_reason, `${path}.derivation_root_page.unavailable_reason`, { nullable: true, max: 256 });
  }
}

function assertAppliedFilters(name, value, path) {
  assertKeys(value, APPLIED_FILTER_KEYS[name], path);
  for (const [key, nested] of Object.entries(value)) {
    if (key === "entity_slug") {
      if (nested !== null && (typeof nested !== "string" || !SAFE_ENTITY_SLUG.test(nested))) {
        fail(`${path}.${key}`, "expected an exact normalized entity filter or null");
      }
    } else if (key === "tax_year") {
      assertSafeInteger(nested, `${path}.${key}`, { nullable: true, min: 1900, max: 2200 });
    } else {
      assertDateOrNull(nested, `${path}.${key}`);
    }
  }
}

function assertDebtMetric(value, path, unavailable) {
  assertKeys(value, DEBT_KEYS, path, DEBT_REQUIRED);
  assertEnum(value.state, DEBT_STATES, `${path}.state`);
  assertStoredTimestampOrNull(value.baseline_recorded_at, `${path}.baseline_recorded_at`);
  if (Object.hasOwn(value, "comparison") &&
      value.comparison !== "durable_recorded_at_strictly_after_baseline") {
    fail(`${path}.comparison`, "wrong provenance-baseline comparison");
  }
  assertEnum(value.count_scope, new Set(["returned_page", "unavailable"]), `${path}.count_scope`);
  if (value.count_unit !== "provenance_record_occurrences") {
    fail(`${path}.count_unit`, "wrong provenance debt count unit");
  }
  assertBoolean(value.covers_all_matching_records, `${path}.covers_all_matching_records`, { nullable: true });
  for (const key of [
    "new_records", "new_records_with_provenance_debt", "unclassifiable_recorded_at",
  ]) assertSafeInteger(value[key], `${path}.${key}`, { nullable: true });
  assertCodeMap(value.debt_reason_codes, `${path}.debt_reason_codes`);
  if (Object.hasOwn(value, "scope_reason_codes")) {
    assertCodeArray(value.scope_reason_codes, `${path}.scope_reason_codes`);
  }
  if (value.state === "not_requested" && value.baseline_recorded_at !== null) {
    fail(path, "a not-requested baseline metric cannot carry a baseline");
  }
  if (value.state !== "not_requested" && value.baseline_recorded_at === null) {
    fail(path, "an evaluated baseline metric requires the baseline instant");
  }
  if (unavailable && value.state !== "not_requested" && value.state !== "insufficient_scope") {
    fail(path, "an unavailable section cannot pass or fail a provenance baseline");
  }
  if (value.new_records !== null && value.new_records_with_provenance_debt !== null &&
      value.new_records_with_provenance_debt > value.new_records) {
    fail(path, "provenance debt cannot exceed new records");
  }
}

function assertGapSummary(value, path, unavailable, returned) {
  assertKeys(value, GAP_KEYS, path, GAP_REQUIRED);
  assertEnum(value.count_scope, new Set(["returned_page", "unavailable"]), `${path}.count_scope`);
  assertBoolean(value.bounded_by_page_limit, `${path}.bounded_by_page_limit`);
  assertBoolean(value.covers_all_matching_records, `${path}.covers_all_matching_records`, { nullable: true });
  for (const key of [
    "examined", "provenance_records_examined", "affected", "blocking",
    "additional_reference_occurrences_affected", "blocking_reference_occurrences",
  ]) {
    if (Object.hasOwn(value, key)) {
      assertSafeInteger(value[key], `${path}.${key}`, { nullable: unavailable });
    }
  }
  if (Object.hasOwn(value, "scope_reason_codes")) {
    assertCodeArray(value.scope_reason_codes, `${path}.scope_reason_codes`);
  }
  for (const key of ["missing_fields", "by_provenance_state", "by_extraction_state", "by_freshness_state"]) {
    assertCodeMap(value[key], `${path}.${key}`, { allowNull: unavailable && key === "missing_fields" });
  }
  assertDebtMetric(value.provenance_debt_since_baseline, `${path}.provenance_debt_since_baseline`, unavailable);
  if (value.recovery_mode !== "planning_only_no_ocr_reingest_or_write") {
    fail(`${path}.recovery_mode`, "wrong read-only recovery mode");
  }
  if (unavailable) {
    if (value.count_scope !== "unavailable" || value.covers_all_matching_records !== null ||
        value.examined !== 0 || value.affected !== null || value.blocking !== null) {
      fail(path, "unavailable section gap counts must fail closed");
    }
  } else {
    if (value.count_scope !== "returned_page" || value.examined !== returned ||
        value.affected > returned || value.blocking > value.affected) {
      fail(path, "available section gap counts are inconsistent");
    }
  }
}

function assertReferenceIntegrity(value, path) {
  assertKeys(value, INTEGRITY_KEYS, path);
  assertEnum(value.state, new Set(["clear", "blocking"]), `${path}.state`);
  if (value.unavailable !== false || value.unavailable_reason !== null) {
    fail(path, "reference integrity must be an assessed exact count");
  }
  for (const key of [
    "total", "returned", "unresolved_current_reference_occurrences",
    "unresolved_or_mismatched_supersession_occurrences",
  ]) assertSafeInteger(value[key], `${path}.${key}`);
  assertBoolean(value.truncated, `${path}.truncated`);
  assertCursor(value.cursor, `${path}.cursor`);
  assertCursor(value.next_cursor, `${path}.next_cursor`);
  if (value.count_unit !== "unresolved_or_invalid_stable_reference_occurrences") {
    fail(`${path}.count_unit`, "wrong stable-reference count unit");
  }
  assertCodeMap(value.counts, `${path}.counts`);
  assertEnum(value.filter_scope, new Set([
    "tenant_wide_integrity_edges",
    "tenant_wide_integrity_edges_cannot_be_safely_attributed_to_exact_entity_filter",
  ]), `${path}.filter_scope`);
  assertCodeArray(value.missing_fields, `${path}.missing_fields`);
  assertCodeArray(value.reason_codes, `${path}.reason_codes`);
  assertBoolean(value.blocks_financial_verification, `${path}.blocks_financial_verification`);
  const countTotal = Object.values(value.counts).reduce((sum, count) => sum + count, 0);
  const classifiedTotal = value.unresolved_current_reference_occurrences +
    value.unresolved_or_mismatched_supersession_occurrences;
  const blocking = value.total > 0;
  if (value.returned !== value.total || countTotal !== value.total || classifiedTotal !== value.total ||
      value.truncated !== false || value.cursor !== null || value.next_cursor !== null ||
      value.state !== (blocking ? "blocking" : "clear") ||
      value.blocks_financial_verification !== blocking) {
    fail(path, "reference-integrity totals or blocking state disagree");
  }
}

function assertSection(name, value, path) {
  const unavailable = value?.unavailable === true;
  assertKeys(value, unavailable ? SECTION_KEYS : AVAILABLE_SECTION_KEYS, path);
  assertEnum(value.state, new Set(["available", "partial", "unavailable"]), `${path}.state`);
  assertBoolean(value.unavailable, `${path}.unavailable`);
  if (unavailable) {
    assertEnum(value.unavailable_reason, UNAVAILABLE_REASONS, `${path}.unavailable_reason`);
    if (value.state !== "unavailable") fail(path, "unavailable flag and section state disagree");
  } else if (value.unavailable_reason !== null || value.state === "unavailable") {
    fail(path, "available section cannot carry an unavailable reason or state");
  }
  assertCodeArray(value.unavailable_fields, `${path}.unavailable_fields`);
  assertUniqueStringArray(value.provenance_fields, `${path}.provenance_fields`, PROVENANCE_FIELD_SET);
  assertAppliedFilters(name, value.applied_filters, `${path}.applied_filters`);
  assertUniqueStringArray(value.not_applicable_filters, `${path}.not_applicable_filters`, new Set([
    "entity_slug", "tax_year", "period_start", "period_end",
  ]));
  assertBoolean(value.blocks_financial_verification, `${path}.blocks_financial_verification`, { nullable: true });
  assertSafeInteger(value.total, `${path}.total`, { nullable: unavailable });
  assertSafeInteger(value.returned, `${path}.returned`);
  assertBoolean(value.truncated, `${path}.truncated`, { nullable: unavailable });
  assertCursor(value.cursor, `${path}.cursor`);
  assertCursor(value.next_cursor, `${path}.next_cursor`);
  if (value.real_world_completeness !== "not_proven") {
    fail(`${path}.real_world_completeness`, "real-world completeness must remain unproven");
  }
  assertGapSummary(
    value.verification_gap_summary,
    `${path}.verification_gap_summary`,
    unavailable,
    value.returned,
  );
  if (unavailable) {
    const notRequested = value.unavailable_reason === "not_requested";
    if (value.total !== null || value.returned !== 0 || value.truncated !== null ||
        value.cursor !== null || value.next_cursor !== null ||
        value.provenance_fields.length !== 0 ||
        value.provenance_state !== (notRequested ? "not_requested" : "unavailable") ||
        value.blocks_financial_verification !== (notRequested ? null : true)) {
      fail(path, "unavailable section envelope is inconsistent");
    }
    return;
  }
  if (value.provenance_state !== "record_level") {
    fail(`${path}.provenance_state`, "available section requires record-level provenance");
  }
  if (!Array.isArray(value.records)) fail(`${path}.records`, "expected an array");
  if (value.returned !== value.records.length || value.returned > value.total ||
      value.truncated !== (value.next_cursor !== null) ||
      (!value.truncated && value.next_cursor !== null)) {
    fail(path, "section pagination counts are inconsistent");
  }
  value.records.forEach((record, index) => assertRecord(name, record, `${path}.records[${index}]`));
  assertReferenceIntegrity(value.reference_integrity, `${path}.reference_integrity`);
}

function assertProvenanceDebtGate(value, path, baseline, requestedUnavailable) {
  assertKeys(value, GATE_KEYS, path, GATE_REQUIRED);
  assertEnum(value.state, DEBT_STATES, `${path}.state`);
  assertStoredTimestampOrNull(value.baseline_recorded_at, `${path}.baseline_recorded_at`);
  if (Object.hasOwn(value, "comparison") &&
      value.comparison !== "durable_recorded_at_strictly_after_baseline") {
    fail(`${path}.comparison`, "wrong provenance-baseline comparison");
  }
  if (value.gate_scope !== "requested_sections_with_available_record_registry" ||
      value.count_unit !== "section_provenance_record_occurrences_may_overlap" ||
      value.real_world_completeness !== "not_proven") {
    fail(path, "wrong aggregate provenance-debt contract");
  }
  if (Object.hasOwn(value, "sections_evaluated")) {
    assertUniqueStringArray(value.sections_evaluated, `${path}.sections_evaluated`, SECTION_SET);
  }
  if (Object.hasOwn(value, "sections_excluded_as_unavailable")) {
    assertUniqueStringArray(
      value.sections_excluded_as_unavailable,
      `${path}.sections_excluded_as_unavailable`,
      SECTION_SET,
    );
  }
  if (Object.hasOwn(value, "scope_reason_codes")) {
    assertCodeArray(value.scope_reason_codes, `${path}.scope_reason_codes`);
  }
  if (Object.hasOwn(value, "debt_reason_codes")) {
    assertCodeMap(value.debt_reason_codes, `${path}.debt_reason_codes`);
  }
  for (const key of [
    "new_records", "new_records_with_provenance_debt", "unclassifiable_recorded_at",
  ]) {
    if (Object.hasOwn(value, key)) assertSafeInteger(value[key], `${path}.${key}`);
  }
  if (Object.hasOwn(value, "covers_all_evaluated_matching_records")) {
    assertBoolean(value.covers_all_evaluated_matching_records, `${path}.covers_all_evaluated_matching_records`);
  }
  if (baseline === null) {
    if (value.state !== "not_requested" || value.baseline_recorded_at !== null) {
      fail(path, "an absent provenance baseline cannot be evaluated");
    }
    return;
  }
  if (value.baseline_recorded_at !== baseline.recorded_at) {
    fail(path, "aggregate baseline does not match the request baseline");
  }
  if (requestedUnavailable.length > 0 && value.state !== "insufficient_scope") {
    fail(path, "requested unavailable sections force insufficient scope");
  }
  const excluded = value.sections_excluded_as_unavailable || [];
  if (excluded.length !== requestedUnavailable.length ||
      excluded.some((name, index) => name !== requestedUnavailable[index])) {
    fail(path, "unavailable requested sections disagree with the debt gate");
  }
  if (value.new_records_with_provenance_debt > value.new_records) {
    fail(path, "aggregate provenance debt cannot exceed new records");
  }
}

/**
 * Assert the exact successful public receipt schema. Returns the original
 * value so callers can use it inline without cloning sensitive intermediate
 * rows. Throws before JSON output on any unknown or raw-looking nested field.
 */
export function assertFinancialPicturePublicReceipt(value) {
  rejectRawKeys(value);
  assertKeys(value, ROOT_KEYS, "$", ROOT_KEYS);
  if (value.schema_version !== 2 || value.operation !== "financial_picture.inventory" ||
      value.read_only !== true || value.mutation_count !== 0) {
    fail("$", "wrong immutable operation contract");
  }
  if (value.completeness_verdict !== "not_computed" ||
      value.correctness_verdict !== "not_computed" ||
      value.tenant_scope !== "authenticated_brain") {
    fail("$", "inventory truth verdicts or tenant scope are not fail closed");
  }
  assertKeys(value.filters, ["entity_slug", "tax_year", "period_start", "period_end"], "$.filters");
  if (value.filters.entity_slug !== null &&
      (typeof value.filters.entity_slug !== "string" || !SAFE_ENTITY_SLUG.test(value.filters.entity_slug))) {
    fail("$.filters.entity_slug", "expected an exact normalized entity filter or null");
  }
  assertSafeInteger(value.filters.tax_year, "$.filters.tax_year", { nullable: true, min: 1900, max: 2200 });
  assertDateOrNull(value.filters.period_start, "$.filters.period_start");
  assertDateOrNull(value.filters.period_end, "$.filters.period_end");
  if (value.filters.period_start && value.filters.period_end &&
      value.filters.period_end < value.filters.period_start) {
    fail("$.filters", "period end cannot precede period start");
  }
  if (value.provenance_baseline !== null) {
    assertKeys(value.provenance_baseline, ["recorded_at"], "$.provenance_baseline");
    assertStoredTimestampOrNull(value.provenance_baseline.recorded_at, "$.provenance_baseline.recorded_at");
    if (value.provenance_baseline.recorded_at === null) {
      fail("$.provenance_baseline.recorded_at", "baseline instant cannot be null");
    }
  }
  assertUniqueStringArray(value.sections_requested, "$.sections_requested", SECTION_SET);
  assertUniqueStringArray(value.sections_unavailable, "$.sections_unavailable", SECTION_SET);
  if (value.sections_requested.length === 0) fail("$.sections_requested", "at least one section is required");
  assertSafeInteger(value.page_limit, "$.page_limit", { min: 1, max: 500 });
  assertCursor(value.request_cursor, "$.request_cursor");
  if (value.pagination_snapshot_scope !==
      "each response is one snapshot; compare snapshot receipts before combining pages") {
    fail("$.pagination_snapshot_scope", "wrong cross-page snapshot warning");
  }
  assertKeys(value.reference_token_contract, [
    "scheme", "key_scope", "stability", "pagination", "identifier_values_disclosed",
  ], "$.reference_token_contract");
  if (value.reference_token_contract.scheme !== "hmac_sha256_v2" ||
      value.reference_token_contract.key_scope !== "per_brain_session_signing_secret" ||
      value.reference_token_contract.stability !==
        "stable_within_one_brain_until_session_signing_key_rotation" ||
      value.reference_token_contract.pagination !==
        "stable_across_page_receipts_from_the_same_brain_key" ||
      value.reference_token_contract.identifier_values_disclosed !== false) {
    fail("$.reference_token_contract", "wrong keyed-reference contract");
  }
  if (value.evidence_scope !==
      "exact structured financial ledger and linked corpus custody metadata only") {
    fail("$.evidence_scope", "wrong evidence scope");
  }
  assertKeys(value.extraction_state_contract, [
    "stored_states", "unavailable_states", "unavailable_reason",
  ], "$.extraction_state_contract");
  assertExactStringArray(
    value.extraction_state_contract.stored_states,
    ["native", "ocr", "ocr_partial", "unreadable"],
    "$.extraction_state_contract.stored_states",
  );
  assertExactStringArray(
    value.extraction_state_contract.unavailable_states,
    ["scan_only", "empty"],
    "$.extraction_state_contract.unavailable_states",
  );
  if (value.extraction_state_contract.unavailable_reason !==
      "rejected scan-only or empty documents have no durable financial evidence row in the current schema") {
    fail("$.extraction_state_contract.unavailable_reason", "wrong extraction evidence warning");
  }
  assertKeys(value.freshness_state_contract, [
    "verdict", "available_evidence", "unavailable_fields",
  ], "$.freshness_state_contract");
  if (value.freshness_state_contract.verdict !== "not_computed") {
    fail("$.freshness_state_contract.verdict", "freshness cannot be inferred by inventory");
  }
  assertExactStringArray(value.freshness_state_contract.available_evidence, [
    "source_status", "source_last_ingest_at", "corpus_ingested_at_ms",
    "evidence_recorded_at", "expected_cadence", "source_coverage_dimensions",
    "latest_source_run_outcome_counts", "confirmed_and_target_source_ranges",
  ], "$.freshness_state_contract.available_evidence");
  assertCodeArray(value.freshness_state_contract.unavailable_fields, "$.freshness_state_contract.unavailable_fields");
  if (value.recovery_mode !== "planning_only_no_ocr_reingest_or_write") {
    fail("$.recovery_mode", "wrong read-only recovery mode");
  }
  assertKeys(value.sections, FINANCIAL_PICTURE_SECTIONS, "$.sections");
  for (const name of FINANCIAL_PICTURE_SECTIONS) {
    assertSection(name, value.sections[name], `$.sections.${name}`);
  }
  const unavailableSections = FINANCIAL_PICTURE_SECTIONS.filter((name) =>
    value.sections[name].unavailable && value.sections[name].unavailable_reason !== "not_requested");
  if (value.sections_unavailable.length !== unavailableSections.length ||
      value.sections_unavailable.some((name, index) => name !== unavailableSections[index]) ||
      value.unavailable !== (unavailableSections.length > 0)) {
    fail("$", "root unavailable summary disagrees with section envelopes");
  }
  assertBoolean(value.unavailable, "$.unavailable");
  const requestedUnavailable = value.sections_requested.filter((name) =>
    value.sections[name].unavailable === true);
  assertProvenanceDebtGate(
    value.provenance_debt_gate,
    "$.provenance_debt_gate",
    value.provenance_baseline,
    requestedUnavailable,
  );
  assertKeys(value.snapshot, [
    "captured_at", "as_of", "consistency", "database_version_ref",
    "database_bookmark_state", "content_sha256",
  ], "$.snapshot");
  assertStoredTimestampOrNull(value.snapshot.captured_at, "$.snapshot.captured_at");
  assertStoredTimestampOrNull(value.snapshot.as_of, "$.snapshot.as_of");
  if (value.snapshot.captured_at === null || value.snapshot.as_of !== value.snapshot.captured_at) {
    fail("$.snapshot", "snapshot capture and as-of boundary must be one exact instant");
  }
  assertEnum(value.snapshot.consistency, new Set(["single_d1_batch", "unavailable"]), "$.snapshot.consistency");
  assertEnum(value.snapshot.database_bookmark_state, new Set(["available", "unavailable"]), "$.snapshot.database_bookmark_state");
  assertReference(value.snapshot.database_version_ref, "$.snapshot.database_version_ref");
  if ((value.snapshot.database_bookmark_state === "available") !==
      (value.snapshot.database_version_ref !== null)) {
    fail("$.snapshot", "database bookmark state and reference disagree");
  }
  if (value.snapshot.consistency === "unavailable" &&
      value.snapshot.database_bookmark_state !== "unavailable") {
    fail("$.snapshot", "an unavailable snapshot cannot carry a database bookmark");
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.snapshot.content_sha256 || ""))) {
    fail("$.snapshot.content_sha256", "invalid public receipt digest");
  }
  return value;
}
