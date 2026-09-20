/**
 * A bounded, evidence-only inventory for Optimize's Financial Picture gate.
 *
 * This module does not search prose, infer ownership, judge correctness, or
 * write anything. Every available row comes from exact structured D1 columns;
 * schema gaps stay explicit in the response.
 */

import { DEFAULT_TENANT } from "./fin-d1.js";
import { storedProvenanceAssessment } from "./provenance-receipt.js";
import { sourceCoverageFromEvidence } from "./source-coverage.js";
import {
  assertFinancialPicturePublicReceipt,
  FINANCIAL_PICTURE_SECTIONS,
} from "./financial-picture-contract.js";

export const FINANCIAL_PICTURE_PATH = "/api/fin/financial-picture";
export { assertFinancialPicturePublicReceipt, FINANCIAL_PICTURE_SECTIONS };

const SECTION_SET = new Set(FINANCIAL_PICTURE_SECTIONS);
const FILTER_KEYS = Object.freeze(["entity_slug", "tax_year", "period_start", "period_end"]);
const FILTER_SET = new Set(FILTER_KEYS);
const BODY_SET = new Set(["sections", "filters", "limit", "cursor", "provenance_baseline"]);
const BASELINE_SET = new Set(["recorded_at"]);
const ENTITY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLIC_SOURCE_KINDS = new Set([
  "drive", "gmail", "imap", "calendar", "imessage", "whatsapp", "zoom",
  "quickbooks", "slack", "notion", "microsoft", "dropbox", "hubspot",
  "plaid", "iphone-backup", "upload",
]);
const PUBLIC_CLAIM_TARGET_KINDS = Object.freeze({
  fin_documents: "document",
  fin_statements: "statement",
  fin_transactions: "transaction",
  fin_balance_snapshots: "balance_snapshot_without_stable_identifier_contract",
});
const HEX_64 = /^[a-f0-9]{64}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_CURSOR = 2048;
const MAX_DERIVATION_ROOTS = 50;
const MAX_QBO_PROVENANCE_ROWS = 50;

function corpusProvenanceExpression(documentAlias) {
  return `(CASE WHEN ${documentAlias}.doc_uid IS NULL THEN NULL ELSE json_object(
    'doc_uid', ${documentAlias}.doc_uid,
    'source', ${documentAlias}.source,
    'source_id', ${documentAlias}.source_id,
    'text_source', ${documentAlias}.text_source,
    'text_reliable', ${documentAlias}.text_reliable,
    'authority_meta', ${documentAlias}.meta
  ) END)`;
}

function corpusProvenanceSql(documentAlias, outputAlias = "corpus_provenance_json") {
  return `${corpusProvenanceExpression(documentAlias)} AS ${outputAlias}`;
}

/**
 * Select one source registry row and one exact latest sync run together. The
 * public projection is still built by H17's canonical helper; this SQL only
 * carries the helper's evidence through the same D1 snapshot as the financial
 * row. Raw source names and run IDs never enter the public object.
 */
function sourceCoverageExpression(sourceNameExpression) {
  return `(SELECT json_object(
    'kind', coverage_source.kind,
    'status', coverage_source.status,
    'last_ingest_at', coverage_source.last_ingest_at,
    'last_complete_sweep_at', coverage_source.last_complete_sweep_at,
    'indexing_started_at', (SELECT MIN(active_run.started_at)
                              FROM sync_runs active_run
                             WHERE active_run.source = coverage_source.name
                               AND active_run.finished_at IS NULL),
    'expected_refresh_seconds', coverage_source.expected_refresh_seconds,
    'documents', (SELECT COUNT(*) FROM documents coverage_document
                   WHERE coverage_document.source = coverage_source.name
                     AND coverage_document.deleted_at IS NULL),
    'run_started_at', coverage_run.started_at,
    'run_finished_at', coverage_run.finished_at,
    'run_walk_complete', coverage_run.walk_complete,
    'run_files_seen', coverage_run.files_seen,
    'run_docs_added', coverage_run.docs_added,
    'run_docs_updated', coverage_run.docs_updated,
    'run_docs_unchanged', coverage_run.docs_unchanged,
    'run_docs_refused', coverage_run.docs_refused,
    'run_docs_failed', coverage_run.docs_failed,
    'run_metrics_version', coverage_run.metrics_version,
    'run_confirmed_from', coverage_run.confirmed_from,
    'run_confirmed_through', coverage_run.confirmed_through,
    'run_target_from', coverage_run.target_from,
    'run_target_through', coverage_run.target_through,
    'run_refusal_present', coverage_run.refusal_reason IS NOT NULL,
    'run_error_present', coverage_run.error IS NOT NULL
  )
    FROM sources coverage_source
    LEFT JOIN sync_runs coverage_run
      ON coverage_run.run_id = (
        SELECT candidate.run_id FROM sync_runs candidate
         WHERE candidate.source = coverage_source.name
         ORDER BY candidate.started_at DESC, candidate.run_id DESC
         LIMIT 1
      )
   WHERE coverage_source.name = ${sourceNameExpression})`;
}

function sourceCoverageSql(sourceNameExpression, outputAlias = "source_coverage_json") {
  return `${sourceCoverageExpression(sourceNameExpression)} AS ${outputAlias}`;
}
const FRESHNESS_UNAVAILABLE_FIELDS = Object.freeze([
  "freshness_applicability", "freshness_evaluation_policy",
]);
const PAYROLL_UNAVAILABLE_FIELDS = Object.freeze([
  "payroll_system_identity", "applicability", "evidence_periods",
  "provenance", "readability_extraction_state", ...FRESHNESS_UNAVAILABLE_FIELDS,
]);

export class FinancialPictureInputError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "FinancialPictureInputError";
    this.code = code;
    this.status = status;
  }
}

function inputError(code, message) {
  throw new FinancialPictureInputError(code, message);
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function normalizeRecordedAtBaseline(value) {
  const text = typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    inputError(
      "invalid_provenance_baseline",
      "provenance_baseline.recorded_at must be an exact UTC timestamp from a prior snapshot.as_of",
    );
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time)) {
    inputError("invalid_provenance_baseline", "the provenance baseline timestamp is not a real instant");
  }
  if (time > Date.now()) {
    inputError("future_provenance_baseline", "the provenance baseline must come from an earlier snapshot");
  }
  return new Date(time).toISOString();
}

function normalizeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    inputError("invalid_request", "the inventory request must be a JSON object");
  }
  const input = body;
  const unknownBody = Object.keys(input).filter((key) => !BODY_SET.has(key));
  if (unknownBody.length) inputError("invalid_request_field", "the inventory request contains an unknown field");

  let selected = [...FINANCIAL_PICTURE_SECTIONS];
  if (input.sections !== undefined) {
    if (!Array.isArray(input.sections) || input.sections.length === 0 ||
        input.sections.some((value) => typeof value !== "string" || !value)) {
      inputError("invalid_sections", "sections must be a non-empty list of exact section names");
    }
    const unknown = input.sections.filter((value) => !SECTION_SET.has(value));
    if (unknown.length) inputError("unknown_section", "the inventory request names an unknown section");
    selected = [...new Set(input.sections)];
  }

  const rawFilters = input.filters === undefined ? {} : input.filters;
  if (!rawFilters || typeof rawFilters !== "object" || Array.isArray(rawFilters)) {
    inputError("invalid_filters", "filters must be an object");
  }
  const unknownFilters = Object.keys(rawFilters).filter((key) => !FILTER_SET.has(key));
  if (unknownFilters.length) inputError("invalid_filter_field", "the inventory request contains an unknown filter");

  const entitySlug = rawFilters.entity_slug === undefined || rawFilters.entity_slug === null || rawFilters.entity_slug === ""
    ? null
    : String(rawFilters.entity_slug);
  if (entitySlug !== null && !ENTITY.test(entitySlug)) {
    inputError("invalid_entity_filter", "entity_slug is not a valid exact entity id");
  }
  const taxYear = rawFilters.tax_year === undefined || rawFilters.tax_year === null || rawFilters.tax_year === ""
    ? null
    : Number(rawFilters.tax_year);
  if (taxYear !== null && (!Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 2200)) {
    inputError("invalid_tax_year_filter", "tax_year must be an integer from 1900 through 2200");
  }
  const periodStart = rawFilters.period_start === undefined || rawFilters.period_start === null || rawFilters.period_start === ""
    ? null
    : String(rawFilters.period_start);
  const periodEnd = rawFilters.period_end === undefined || rawFilters.period_end === null || rawFilters.period_end === ""
    ? null
    : String(rawFilters.period_end);
  if (periodStart !== null && !validCalendarDate(periodStart)) {
    inputError("invalid_period_start_filter", "period_start must be a real YYYY-MM-DD calendar date");
  }
  if (periodEnd !== null && !validCalendarDate(periodEnd)) {
    inputError("invalid_period_end_filter", "period_end must be a real YYYY-MM-DD calendar date");
  }
  if (periodStart && periodEnd && periodEnd < periodStart) {
    inputError("invalid_period_range", "period_end cannot be before period_start");
  }

  const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    inputError("invalid_limit", `limit must be an integer from 1 through ${MAX_LIMIT}`);
  }
  const cursor = input.cursor === undefined || input.cursor === null ? null : String(input.cursor);
  if (cursor !== null && (!cursor || cursor.length > MAX_CURSOR)) {
    inputError("invalid_cursor", "cursor is invalid");
  }
  if (cursor && selected.length !== 1) {
    inputError("cursor_requires_one_section", "cursor requires exactly one requested section");
  }

  let provenanceBaseline = null;
  if (input.provenance_baseline !== undefined && input.provenance_baseline !== null) {
    const rawBaseline = input.provenance_baseline;
    if (!rawBaseline || typeof rawBaseline !== "object" || Array.isArray(rawBaseline)) {
      inputError("invalid_provenance_baseline", "provenance_baseline must be an object");
    }
    const unknownBaseline = Object.keys(rawBaseline).filter((key) => !BASELINE_SET.has(key));
    if (unknownBaseline.length || Object.keys(rawBaseline).length !== 1) {
      inputError(
        "invalid_provenance_baseline",
        "provenance_baseline accepts only recorded_at from a prior snapshot.as_of",
      );
    }
    provenanceBaseline = Object.freeze({
      recorded_at: normalizeRecordedAtBaseline(rawBaseline.recorded_at),
    });
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    filters: Object.freeze({
      entity_slug: entitySlug,
      tax_year: taxYear,
      period_start: periodStart,
      period_end: periodEnd,
    }),
    limit,
    cursor,
    provenanceBaseline,
  });
}

/** Validate one public request without reading D1 or resolving any credential. */
export function validateFinancialPictureRequest(body = {}) {
  normalizeRequest(body);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function referenceContext(env) {
  const secret = typeof env?.SESSION_SIGNING_KEY === "string"
    ? env.SESSION_SIGNING_KEY
    : "";
  if (!secret) throw new Error("financial picture reference signing is unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = async (purpose, value) => {
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `financial-picture-v2:${DEFAULT_TENANT}:${purpose}:${String(value)}`,
      ),
    );
    return [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };
  return Object.freeze({
    digest,
    ref: async (kind, value) => `${kind}_v2_${await digest(`reference:${kind}`, value)}`,
  });
}

async function withSafeSourceReferences(row, references) {
  if (!row || typeof row !== "object") return row;
  const sourceDocumentPresent = Boolean(row.source_doc_uid);
  const sourceFeedPresent = Boolean(row.source_feed);
  const linkedCorpusSourcePresent = Boolean(row.linked_corpus_source);
  const sourceKindCandidate = String(row.source_kind || "").trim().toLowerCase();
  const linkedKindCandidate = String(row.linked_corpus_source_kind || "").trim().toLowerCase();
  const publicSourceKind = PUBLIC_SOURCE_KINDS.has(sourceKindCandidate)
    ? sourceKindCandidate
    : null;
  const publicLinkedCorpusSourceKind = PUBLIC_SOURCE_KINDS.has(linkedKindCandidate)
    ? linkedKindCandidate
    : null;
  return {
    ...row,
    source_document_ref: sourceDocumentPresent
      ? await references.ref("source_document", row.source_doc_uid)
      : null,
    source_document_present: sourceDocumentPresent,
    source_document_reference_state: !sourceDocumentPresent
      ? "absent"
      : row.source_reference_present === null || row.source_reference_present === undefined
        ? "resolution_unavailable"
        : Boolean(row.source_reference_present) ? "resolved" : "unresolved",
    source_locator_ref: row.source_locator
      ? await references.ref("source_locator", row.source_locator)
      : null,
    source_feed_ref: sourceFeedPresent
      ? await references.ref("source_feed", row.source_feed)
      : null,
    source_feed_present: sourceFeedPresent,
    source_feed_kind: publicSourceKind,
    source_feed_kind_state: !sourceFeedPresent
      ? "absent"
      : publicSourceKind ? "known_public_kind" : "unavailable_or_unrecognized",
    source_feed_registry_state: !sourceFeedPresent
      ? "absent"
      : row.source_status ? "resolved" : "unresolved",
    linked_corpus_source_ref: linkedCorpusSourcePresent
      ? await references.ref("corpus_source", row.linked_corpus_source)
      : null,
    linked_corpus_source_present: linkedCorpusSourcePresent,
    linked_corpus_source_kind: publicLinkedCorpusSourceKind,
    linked_corpus_source_state: !linkedCorpusSourcePresent
      ? "absent"
      : publicLinkedCorpusSourceKind ? "known_public_kind" : "stable_hash_only",
  };
}

function parsedJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsedJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function groupProvenanceAssessment(value, evidenceCount = null) {
  const storedRows = parsedJsonArray(value) || [];
  const exactEvidenceCount = Number(evidenceCount);
  const groupTotal = Number.isSafeInteger(exactEvidenceCount) && exactEvidenceCount >= 0
    ? Math.max(exactEvidenceCount, storedRows.length)
    : storedRows.length;
  const uninspected = groupTotal - storedRows.length;
  if (!storedRows.length) {
    return {
      provenance_assessed: false,
      provenance_status: "unavailable",
      provenance_reason: groupTotal > 0
        ? "provenance_group_incomplete_or_bounded"
        : "provenance_receipt_missing_or_invalid",
      text_source: "unknown",
      text_reliable: false,
      group_total: groupTotal,
      group_assessed: 0,
      group_missing_text_source: groupTotal,
      group_missing_text_reliable: groupTotal,
    };
  }
  const assessments = storedRows.map((stored) =>
    storedProvenanceAssessment(parsedJsonObject(stored) || {}));
  const assessed = assessments.filter((item) => item.provenance_assessed === true);
  const allAssessed = assessed.length === groupTotal;
  const statuses = new Set(assessed.map((item) => item.provenance_status));
  const reasons = new Set(assessed.map((item) => item.provenance_reason));
  const textSources = new Set(assessed.map((item) => item.text_source));
  return {
    provenance_assessed: allAssessed,
    provenance_status: allAssessed && statuses.size === 1
      ? assessed[0].provenance_status
      : "unavailable",
    provenance_reason: allAssessed && reasons.size === 1
      ? assessed[0].provenance_reason
      : allAssessed
        ? "mixed_provenance_receipts"
        : uninspected > 0
          ? "provenance_group_incomplete_or_bounded"
          : "provenance_receipt_missing_or_invalid",
    text_source: allAssessed && textSources.size === 1 ? assessed[0].text_source : "unknown",
    text_reliable: allAssessed && assessed.every((item) => item.text_reliable === true),
    group_total: groupTotal,
    group_assessed: assessed.length,
    group_missing_text_source: uninspected + assessments.filter((item) =>
      item.provenance_assessed !== true ||
      !["native", "ocr", "ocr_partial"].includes(item.text_source)).length,
    group_missing_text_reliable: uninspected + assessments.filter((item) =>
      item.provenance_assessed !== true).length,
  };
}

function rowProvenanceAssessment(row) {
  if (Object.hasOwn(row || {}, "corpus_provenance_group_json")) {
    return groupProvenanceAssessment(row.corpus_provenance_group_json, row.evidence_count);
  }
  return storedProvenanceAssessment(parsedJsonObject(row?.corpus_provenance_json) || {});
}

function unavailableSourceCoverage(row, state, missingFields) {
  const basis = row?.source_feed
    ? "source_feed_registry"
    : row?.linked_corpus_source ? "linked_corpus_registry" : "not_applicable";
  return {
    state,
    basis,
    starter_context_state: null,
    live_updates_state: null,
    history_state: null,
    meaning_search_state: null,
    confirmed_range: { from: null, through: null },
    target_range: { from: null, through: null },
    current_window: null,
    counts: { seen: null, accepted: null, refused: null, failed: null },
    last_progress_at: null,
    projection_pending: null,
    waiting_on_owner_machine: null,
    missing_fields: [...missingFields],
  };
}

/**
 * Project exact registry and latest-run evidence with H17's canonical helper.
 * This deliberately does not reproduce store-d1's time-based freshness
 * adjudication: a raw `ready` status is mapped to unknown so this
 * inventory cannot turn it into a current verdict on its own.
 */
function sourceCoverageRecord(row) {
  const expectsSource = Boolean(row?.source_feed || row?.linked_corpus_source);
  if (!expectsSource) return unavailableSourceCoverage(row, "not_applicable", []);
  const stored = parsedJsonObject(row.source_coverage_json);
  if (!stored) {
    return unavailableSourceCoverage(row, "unavailable", ["source_registry_coverage"]);
  }
  const expectedSeconds = Number(stored.expected_refresh_seconds);
  const latestRun = stored.run_started_at === null || stored.run_started_at === undefined
    ? null
    : {
      started_at: stored.run_started_at,
      finished_at: stored.run_finished_at,
      walk_complete: stored.run_walk_complete,
      files_seen: stored.run_files_seen,
      docs_added: stored.run_docs_added,
      docs_updated: stored.run_docs_updated,
      docs_unchanged: stored.run_docs_unchanged,
      docs_refused: stored.run_docs_refused,
      docs_failed: stored.run_docs_failed,
      metrics_version: stored.run_metrics_version,
      confirmed_from: stored.run_confirmed_from,
      confirmed_through: stored.run_confirmed_through,
      target_from: stored.run_target_from,
      target_through: stored.run_target_through,
      refusal_reason: stored.run_refusal_present ? "present" : null,
      error: stored.run_error_present ? "present" : null,
    };
  const coverage = sourceCoverageFromEvidence({
    kind: stored.kind || null,
    // Operational source state requires H17's freshness adjudication inputs.
    // Raw registry labels alone cannot safely establish catching-up/current.
    state: "unknown",
    documents: stored.documents,
    last_complete_sweep_at: stored.last_complete_sweep_at || null,
    indexing_started_at: stored.indexing_started_at,
    last_ingest_at: stored.last_ingest_at || null,
    expected_every_days: Number.isFinite(expectedSeconds) && expectedSeconds > 0
      ? Math.max(1, Math.round(expectedSeconds / 86400))
      : null,
  }, { latestRun, projectionPending: null });
  const missing = [];
  if (!latestRun) missing.push("latest_source_run");
  if (Object.values(coverage.counts).some((value) => value === null)) {
    missing.push("source_run_outcome_counts");
  }
  if (coverage.confirmed_range.from === null && coverage.confirmed_range.through === null) {
    missing.push("confirmed_source_range");
  }
  if (coverage.history.state !== "complete") missing.push("complete_source_history");
  if (coverage.live_updates.state === "unavailable") missing.push("live_update_freshness");
  missing.push("owner_machine_wait_state");
  if (coverage.meaning_search.state === "unknown") missing.push("meaning_search_projection");
  if (coverage.current_window === null) missing.push("current_source_window");
  return {
    state: "available",
    basis: row.source_feed ? "source_feed_registry" : "linked_corpus_registry",
    starter_context_state: coverage.starter_context.state,
    live_updates_state: coverage.live_updates.state,
    history_state: coverage.history.state,
    meaning_search_state: coverage.meaning_search.state,
    confirmed_range: { ...coverage.confirmed_range },
    target_range: { ...coverage.target_range },
    current_window: coverage.current_window,
    counts: { ...coverage.counts },
    last_progress_at: coverage.last_progress_at,
    projection_pending: coverage.projection_pending,
    waiting_on_owner_machine: null,
    missing_fields: missing,
  };
}

async function prepareFinancialRow(row, references) {
  const safe = await withSafeSourceReferences(row, references);
  return {
    ...safe,
    stored_provenance_assessment: rowProvenanceAssessment(safe),
    source_coverage: sourceCoverageRecord(safe),
  };
}

function encodeBase64Url(value) {
  const binary = String.fromCharCode(...new TextEncoder().encode(value));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function makeCursor(section, offset, requestHash) {
  return encodeBase64Url(JSON.stringify({ v: 1, section, offset, request_sha256: requestHash }));
}

function parseCursor(value, selectedSection, requestHash) {
  if (!value) return 0;
  let decoded;
  try {
    decoded = JSON.parse(decodeBase64Url(value));
  } catch {
    inputError("invalid_cursor", "cursor is invalid");
  }
  if (!decoded || decoded.v !== 1 || decoded.section !== selectedSection ||
      !Number.isSafeInteger(decoded.offset) || decoded.offset < 1 || decoded.offset > 10_000_000) {
    inputError("invalid_cursor", "cursor is invalid");
  }
  if (decoded.request_sha256 !== requestHash) {
    inputError("cursor_request_mismatch", "cursor does not match the requested filters and provenance baseline");
  }
  return decoded.offset;
}

function sectionFilterInfo(filters, applicable) {
  const applied = {};
  const notApplicable = [];
  for (const key of FILTER_KEYS) {
    if (applicable.includes(key)) applied[key] = filters[key];
    else if (filters[key] !== null) notApplicable.push(key);
  }
  return { applied_filters: applied, not_applicable_filters: notApplicable };
}

function whereFor(filters, applicable) {
  const clauses = [];
  const binds = [];
  for (const key of applicable) {
    if (filters[key] === null) continue;
    clauses.push(`rows.${key} = ?`);
    binds.push(filters[key]);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

const ENTITY_SQL = `
  SELECT e.id AS internal_id, e.entity_slug, e.legal_name, e.display_label, e.kind, e.status,
         e.relationship, e.holds, e.parent_entity_slug, e.ownership_bp, e.tax_class,
         CASE WHEN e.parent_entity_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_entities pe
            WHERE pe.tenant_id = e.tenant_id AND pe.entity_slug = e.parent_entity_slug
              AND pe.superseded_by_id IS NULL
         ) END AS parent_entity_reference_present,
         e.provenance, e.source_doc_uid, e.source_locator, e.source_feed,
         sd.source AS linked_corpus_source,
         (SELECT kind FROM sources WHERE name = sd.source) AS linked_corpus_source_kind,
         e.confidence_bp, e.basis_state, e.unparsed_reason, e.recorded_at, sf.readable,
         sd.doc_uid IS NOT NULL AS corpus_document_present,
         sd.text_source, sd.text_reliable, sd.ingested_at AS corpus_ingested_at_ms,
         ${corpusProvenanceSql("sd")},
         ss.status AS source_status, ss.kind AS source_kind,
         ss.last_ingest_at AS source_last_ingest_at,
         ${sourceCoverageSql("COALESCE(e.source_feed, sd.source)")},
         NULL AS expected_cadence,
         (sd.doc_uid IS NOT NULL AND
          (sf.fin_doc_uid IS NULL OR
           (sf.content_hash IS NOT NULL AND sd.content_hash IS NOT NULL
            AND sf.content_hash = sd.content_hash))) AS source_reference_present
    FROM fin_entities e
    LEFT JOIN fin_documents sf
      ON sf.tenant_id = e.tenant_id AND sf.fin_doc_uid = e.source_doc_uid
     AND sf.superseded_by_id IS NULL
    LEFT JOIN documents sd
      ON sd.doc_uid = CASE WHEN sf.fin_doc_uid IS NOT NULL
                           THEN sf.corpus_doc_uid ELSE e.source_doc_uid END
     AND sd.deleted_at IS NULL
    LEFT JOIN sources ss ON ss.name = e.source_feed
   WHERE e.tenant_id = '${DEFAULT_TENANT}' AND e.superseded_by_id IS NULL`;

const PERIOD_SQL = `
  SELECT entity_slug, account_slug, account_reference_present,
         covered_via_account_slug, covered_via_account_reference_present, origin_ref,
         period_kind, tax_year, period_start, period_end, evidence_kind,
         provenance, source_doc_uid, source_locator, source_feed, linked_corpus_source,
         linked_corpus_source_kind, basis_state,
         unparsed_reason, recorded_at,
         readable, corpus_document_present, text_source, text_reliable,
         corpus_ingested_at_ms, corpus_provenance_json,
         source_status, source_kind, source_last_ingest_at, source_coverage_json,
         expected_cadence,
         source_reference_present, entity_mapping_provenance, entity_mapping_basis_state,
         entity_reference_present, entity_account_mapping_consistent,
         corpus_content_binding_state
    FROM (
      SELECT f.entity_slug, f.account_slug,
             CASE WHEN f.account_slug IS NULL THEN NULL ELSE EXISTS (
               SELECT 1 FROM fin_accounts ma
                WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
                  AND ma.superseded_by_id IS NULL
             ) END AS account_reference_present,
             NULL AS covered_via_account_slug,
             NULL AS covered_via_account_reference_present,
             'fin_document:' || f.fin_doc_uid AS origin_ref,
             'tax_year' AS period_kind, f.tax_year,
             NULL AS period_start, NULL AS period_end,
             f.doc_kind AS evidence_kind, f.provenance, f.source_doc_uid, f.source_locator,
             f.source_feed,
             CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END
               AS linked_corpus_source,
             (SELECT kind FROM sources
               WHERE name = CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END)
               AS linked_corpus_source_kind,
             f.basis_state,
             f.unparsed_reason, f.recorded_at, f.readable,
             d.doc_uid IS NOT NULL AS corpus_document_present,
             d.text_source, d.text_reliable, d.ingested_at AS corpus_ingested_at_ms,
             ${corpusProvenanceSql("d")},
             ss.status AS source_status, ss.kind AS source_kind,
             ss.last_ingest_at AS source_last_ingest_at,
             ${sourceCoverageSql("COALESCE(f.source_feed, pd.source, d.source)")},
             NULL AS expected_cadence,
             CASE WHEN f.source_doc_uid IS NULL THEN NULL ELSE
               (f.source_doc_uid <> f.fin_doc_uid
                AND pd.doc_uid IS NOT NULL
                AND (pf.fin_doc_uid IS NULL OR
                     (pf.source_doc_uid IS NULL OR pf.source_doc_uid <> f.fin_doc_uid))
                AND (pf.fin_doc_uid IS NULL OR
                     (pf.content_hash IS NOT NULL AND pd.content_hash IS NOT NULL
                      AND pf.content_hash = pd.content_hash))) END
             AS source_reference_present,
             f.provenance AS entity_mapping_provenance,
             f.basis_state AS entity_mapping_basis_state,
             EXISTS (SELECT 1 FROM fin_entities me
               WHERE me.tenant_id = f.tenant_id AND me.entity_slug = f.entity_slug
                 AND me.superseded_by_id IS NULL) AS entity_reference_present
             ,(SELECT ma.entity_slug = f.entity_slug FROM fin_accounts ma
                 WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
                   AND ma.superseded_by_id IS NULL LIMIT 1)
               AS entity_account_mapping_consistent,
             CASE WHEN f.corpus_doc_uid IS NULL THEN 'not_applicable'
                  WHEN d.doc_uid IS NULL THEN 'corpus_document_unresolved'
                  WHEN f.content_hash IS NULL THEN 'expected_content_hash_unavailable'
                  WHEN d.content_hash IS NULL THEN 'corpus_content_hash_unavailable'
                  WHEN f.content_hash = d.content_hash THEN 'matched'
                  ELSE 'mismatched' END AS corpus_content_binding_state
        FROM fin_documents f
        LEFT JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
        LEFT JOIN fin_documents pf
          ON pf.tenant_id = f.tenant_id AND pf.fin_doc_uid = f.source_doc_uid
         AND pf.superseded_by_id IS NULL AND pf.id <> f.id
        LEFT JOIN documents pd
          ON pd.doc_uid = CASE WHEN pf.fin_doc_uid IS NOT NULL
                               THEN pf.corpus_doc_uid ELSE f.source_doc_uid END
         AND pd.deleted_at IS NULL
        LEFT JOIN sources ss ON ss.name = f.source_feed
       WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
         AND f.tax_year IS NOT NULL
      UNION ALL
      SELECT f.entity_slug, f.account_slug,
             CASE WHEN f.account_slug IS NULL THEN NULL ELSE EXISTS (
               SELECT 1 FROM fin_accounts ma
                WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
                  AND ma.superseded_by_id IS NULL
             ) END,
             NULL, NULL, 'fin_document:' || f.fin_doc_uid,
             'document_period', f.tax_year, f.period_start, f.period_end, f.doc_kind,
             f.provenance, f.source_doc_uid, f.source_locator, f.source_feed,
             CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END,
             (SELECT kind FROM sources
               WHERE name = CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END),
             f.basis_state,
             f.unparsed_reason, f.recorded_at, f.readable, d.doc_uid IS NOT NULL,
             d.text_source, d.text_reliable,
             d.ingested_at, ${corpusProvenanceExpression("d")},
             ss.status, ss.kind, ss.last_ingest_at,
             ${sourceCoverageExpression("COALESCE(f.source_feed, pd.source, d.source)")}, NULL,
             CASE WHEN f.source_doc_uid IS NULL THEN NULL ELSE
               (f.source_doc_uid <> f.fin_doc_uid
                AND pd.doc_uid IS NOT NULL
                AND (pf.fin_doc_uid IS NULL OR
                     (pf.source_doc_uid IS NULL OR pf.source_doc_uid <> f.fin_doc_uid))
                AND (pf.fin_doc_uid IS NULL OR
                     (pf.content_hash IS NOT NULL AND pd.content_hash IS NOT NULL
                      AND pf.content_hash = pd.content_hash))) END,
             f.provenance, f.basis_state,
             EXISTS (SELECT 1 FROM fin_entities me
               WHERE me.tenant_id = f.tenant_id AND me.entity_slug = f.entity_slug
                 AND me.superseded_by_id IS NULL),
             (SELECT ma.entity_slug = f.entity_slug FROM fin_accounts ma
                WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
                  AND ma.superseded_by_id IS NULL LIMIT 1),
             CASE WHEN f.corpus_doc_uid IS NULL THEN 'not_applicable'
                  WHEN d.doc_uid IS NULL THEN 'corpus_document_unresolved'
                  WHEN f.content_hash IS NULL THEN 'expected_content_hash_unavailable'
                  WHEN d.content_hash IS NULL THEN 'corpus_content_hash_unavailable'
                  WHEN f.content_hash = d.content_hash THEN 'matched'
                  ELSE 'mismatched' END
        FROM fin_documents f
        LEFT JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
        LEFT JOIN fin_documents pf
          ON pf.tenant_id = f.tenant_id AND pf.fin_doc_uid = f.source_doc_uid
         AND pf.superseded_by_id IS NULL AND pf.id <> f.id
        LEFT JOIN documents pd
          ON pd.doc_uid = CASE WHEN pf.fin_doc_uid IS NOT NULL
                               THEN pf.corpus_doc_uid ELSE f.source_doc_uid END
         AND pd.deleted_at IS NULL
        LEFT JOIN sources ss ON ss.name = f.source_feed
       WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
         AND (f.period_start IS NOT NULL OR f.period_end IS NOT NULL)
      UNION ALL
      SELECT a.entity_slug, c.account_slug, (a.id IS NOT NULL),
             c.covered_via_account_slug,
             CASE WHEN c.covered_via_account_slug IS NULL THEN NULL ELSE EXISTS (
               SELECT 1 FROM fin_accounts ca
                WHERE ca.tenant_id = c.tenant_id
                  AND ca.account_slug = c.covered_via_account_slug
                  AND ca.superseded_by_id IS NULL
             ) END,
             'account_coverage:' || c.id,
             'account_coverage', NULL, c.covered_from, c.covered_to,
             c.coverage_status, c.provenance, c.source_doc_uid, c.source_locator,
             c.source_feed, sd.source,
             (SELECT kind FROM sources WHERE name = sd.source),
             c.basis_state, c.unparsed_reason, c.recorded_at, sf.readable,
             sd.doc_uid IS NOT NULL, sd.text_source, sd.text_reliable,
             sd.ingested_at, ${corpusProvenanceExpression("sd")},
             ss.status, ss.kind, ss.last_ingest_at,
             ${sourceCoverageExpression("COALESCE(c.source_feed, sd.source)")}, a.expected_cadence,
             (sd.doc_uid IS NOT NULL AND
              (sf.fin_doc_uid IS NULL OR
               (sf.content_hash IS NOT NULL AND sd.content_hash IS NOT NULL
                AND sf.content_hash = sd.content_hash))),
             a.provenance, a.basis_state,
             CASE WHEN a.id IS NULL THEN NULL ELSE EXISTS (
               SELECT 1 FROM fin_entities me
                WHERE me.tenant_id = a.tenant_id AND me.entity_slug = a.entity_slug
                  AND me.superseded_by_id IS NULL
             ) END,
             CASE WHEN a.id IS NULL THEN NULL ELSE 1 END,
             'not_applicable'
        FROM fin_account_coverage c
        LEFT JOIN fin_accounts a ON a.tenant_id = c.tenant_id AND a.account_slug = c.account_slug
                                AND a.superseded_by_id IS NULL
        LEFT JOIN fin_documents sf
          ON sf.tenant_id = c.tenant_id AND sf.fin_doc_uid = c.source_doc_uid
         AND sf.superseded_by_id IS NULL
        LEFT JOIN documents sd
          ON sd.doc_uid = CASE WHEN sf.fin_doc_uid IS NOT NULL
                               THEN sf.corpus_doc_uid ELSE c.source_doc_uid END
         AND sd.deleted_at IS NULL
        LEFT JOIN sources ss ON ss.name = c.source_feed
       WHERE c.tenant_id = '${DEFAULT_TENANT}' AND c.superseded_by_id IS NULL
      UNION ALL
      SELECT a.entity_slug, s.account_slug, (a.id IS NOT NULL), NULL, NULL,
             'statement:' || s.statement_uid,
             'statement_period', NULL, s.period_start, s.period_end,
             s.parse_state, s.provenance, s.source_doc_uid, s.source_locator,
             s.source_feed, sd.source,
             (SELECT kind FROM sources WHERE name = sd.source),
             s.basis_state, s.unparsed_reason, s.recorded_at, sf.readable,
             sd.doc_uid IS NOT NULL, sd.text_source, sd.text_reliable,
             sd.ingested_at, ${corpusProvenanceExpression("sd")},
             ss.status, ss.kind, ss.last_ingest_at,
             ${sourceCoverageExpression("COALESCE(s.source_feed, sd.source)")}, a.expected_cadence,
             (sd.doc_uid IS NOT NULL AND
              (sf.fin_doc_uid IS NULL OR
               (sf.content_hash IS NOT NULL AND sd.content_hash IS NOT NULL
                AND sf.content_hash = sd.content_hash))),
             a.provenance, a.basis_state,
             CASE WHEN a.id IS NULL THEN NULL ELSE EXISTS (
               SELECT 1 FROM fin_entities me
                WHERE me.tenant_id = a.tenant_id AND me.entity_slug = a.entity_slug
                  AND me.superseded_by_id IS NULL
             ) END,
             CASE WHEN a.id IS NULL THEN NULL ELSE 1 END,
             'not_applicable'
        FROM fin_statements s
        LEFT JOIN fin_accounts a ON a.tenant_id = s.tenant_id AND a.account_slug = s.account_slug
                                AND a.superseded_by_id IS NULL
        LEFT JOIN fin_documents sf
          ON sf.tenant_id = s.tenant_id AND sf.fin_doc_uid = s.source_doc_uid
         AND sf.superseded_by_id IS NULL
        LEFT JOIN documents sd
          ON sd.doc_uid = CASE WHEN sf.fin_doc_uid IS NOT NULL
                               THEN sf.corpus_doc_uid ELSE s.source_doc_uid END
         AND sd.deleted_at IS NULL
       LEFT JOIN sources ss ON ss.name = s.source_feed
       WHERE s.tenant_id = '${DEFAULT_TENANT}' AND s.superseded_by_id IS NULL
      UNION ALL
      SELECT entity_slug, NULL, NULL, NULL, NULL,
             'period_close:' || entity_slug || ':' || period_start || ':' || period_end,
             'period_close', NULL, period_start, period_end, evidence_state,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, updated_at, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             EXISTS (SELECT 1 FROM fin_entities me
               WHERE me.tenant_id = fin_period_closes.tenant_id
                 AND me.entity_slug = fin_period_closes.entity_slug
                 AND me.superseded_by_id IS NULL),
             NULL, 'not_applicable'
        FROM fin_period_closes
       WHERE tenant_id = '${DEFAULT_TENANT}'
    )`;

const REFERENCE_INTEGRITY_SQL = `
  SELECT
    (SELECT COUNT(*) FROM fin_entities e
      WHERE e.tenant_id = '${DEFAULT_TENANT}' AND e.superseded_by_id IS NULL
        AND e.parent_entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities p
          WHERE p.tenant_id = e.tenant_id AND p.entity_slug = e.parent_entity_slug
            AND p.superseded_by_id IS NULL)) AS entity_parent,
    (SELECT COUNT(*) FROM fin_accounts a
      WHERE a.tenant_id = '${DEFAULT_TENANT}' AND a.superseded_by_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = a.tenant_id AND e.entity_slug = a.entity_slug
            AND e.superseded_by_id IS NULL)) AS account_entity,
    (SELECT COUNT(*) FROM fin_account_coverage c
      WHERE c.tenant_id = '${DEFAULT_TENANT}' AND c.superseded_by_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = c.tenant_id AND a.account_slug = c.account_slug
            AND a.superseded_by_id IS NULL)) AS coverage_account,
    (SELECT COUNT(*) FROM fin_statements s
      WHERE s.tenant_id = '${DEFAULT_TENANT}' AND s.superseded_by_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = s.tenant_id AND a.account_slug = s.account_slug
            AND a.superseded_by_id IS NULL)) AS statement_account,
    (SELECT COUNT(*) FROM fin_account_coverage c
      WHERE c.tenant_id = '${DEFAULT_TENANT}' AND c.superseded_by_id IS NULL
        AND c.coverage_status = 'indirect'
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = c.tenant_id AND a.account_slug = c.covered_via_account_slug
            AND a.superseded_by_id IS NULL)) AS indirect_coverage_target,
    (SELECT COUNT(*) FROM (
       SELECT c.id FROM fin_account_coverage c
       JOIN fin_accounts a ON a.tenant_id = c.tenant_id AND a.account_slug = c.account_slug
                          AND a.superseded_by_id IS NULL
       WHERE c.tenant_id = '${DEFAULT_TENANT}' AND c.superseded_by_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM fin_entities e
           WHERE e.tenant_id = a.tenant_id AND e.entity_slug = a.entity_slug
             AND e.superseded_by_id IS NULL)
       UNION ALL
       SELECT s.id FROM fin_statements s
       JOIN fin_accounts a ON a.tenant_id = s.tenant_id AND a.account_slug = s.account_slug
                          AND a.superseded_by_id IS NULL
       WHERE s.tenant_id = '${DEFAULT_TENANT}' AND s.superseded_by_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM fin_entities e
           WHERE e.tenant_id = a.tenant_id AND e.entity_slug = a.entity_slug
             AND e.superseded_by_id IS NULL)
     )) AS period_account_entity,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND (f.tax_year IS NOT NULL OR f.period_start IS NOT NULL OR f.period_end IS NOT NULL)
        AND f.entity_slug IS NULL) AS period_document_entity_missing,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND (f.tax_year IS NOT NULL OR f.period_start IS NOT NULL OR f.period_end IS NOT NULL)
        AND f.entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = f.tenant_id AND e.entity_slug = f.entity_slug
            AND e.superseded_by_id IS NULL)) AS period_document_entity_unresolved,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.account_slug IS NOT NULL
        AND (f.tax_year IS NOT NULL OR f.period_start IS NOT NULL OR f.period_end IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = f.tenant_id AND a.account_slug = f.account_slug
            AND a.superseded_by_id IS NULL)) AS period_document_account,
    (SELECT COUNT(*) FROM fin_period_closes c
      WHERE c.tenant_id = '${DEFAULT_TENANT}'
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = c.tenant_id AND e.entity_slug = c.entity_slug
            AND e.superseded_by_id IS NULL)) AS period_close_entity,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.doc_kind IN ('profit_and_loss', 'balance_sheet', 'general_ledger',
                           'trial_balance', 'chart_of_accounts')
        AND f.entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = f.tenant_id AND e.entity_slug = f.entity_slug
            AND e.superseded_by_id IS NULL)) AS books_document_entity,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.doc_kind IN ('profit_and_loss', 'balance_sheet', 'general_ledger',
                           'trial_balance', 'chart_of_accounts')
        AND f.account_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = f.tenant_id AND a.account_slug = f.account_slug
            AND a.superseded_by_id IS NULL)) AS books_document_account,
    (SELECT COUNT(*) FROM documents d
      WHERE d.deleted_at IS NULL AND d.entity_slug IS NOT NULL
        AND length(lower(CASE WHEN json_valid(d.meta)
          THEN json_extract(d.meta, '$.qbo_company_fingerprint') END)) = 64
        AND lower(CASE WHEN json_valid(d.meta)
          THEN json_extract(d.meta, '$.qbo_company_fingerprint') END) NOT GLOB '*[^0-9a-f]*'
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = '${DEFAULT_TENANT}' AND e.entity_slug = d.entity_slug
            AND e.superseded_by_id IS NULL)) AS qbo_document_entity,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.doc_kind IN ('tax_return', 'k1', 'tax_transcript')
        AND f.entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = f.tenant_id AND e.entity_slug = f.entity_slug
            AND e.superseded_by_id IS NULL)) AS tax_document_entity,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.doc_kind IN ('tax_return', 'k1', 'tax_transcript')
        AND f.account_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = f.tenant_id AND a.account_slug = f.account_slug
            AND a.superseded_by_id IS NULL)) AS tax_document_account,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND (f.doc_kind IN ('tax_notice', 'estimated_payment_receipt')
             OR (f.doc_kind = 'tax_return' AND f.filed_at IS NOT NULL))
        AND f.entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = f.tenant_id AND e.entity_slug = f.entity_slug
            AND e.superseded_by_id IS NULL)) AS filing_document_entity,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND (f.doc_kind IN ('tax_notice', 'estimated_payment_receipt')
             OR (f.doc_kind = 'tax_return' AND f.filed_at IS NOT NULL))
        AND f.account_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = f.tenant_id AND a.account_slug = f.account_slug
            AND a.superseded_by_id IS NULL)) AS filing_document_account,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = f.tenant_id AND e.entity_slug = f.entity_slug
            AND e.superseded_by_id IS NULL)) AS evidence_document_entity,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.account_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = f.tenant_id AND a.account_slug = f.account_slug
            AND a.superseded_by_id IS NULL)) AS evidence_document_account,
    (SELECT COUNT(*) FROM fin_documents f
      JOIN fin_accounts a ON a.tenant_id = f.tenant_id
                         AND a.account_slug = f.account_slug
                         AND a.superseded_by_id IS NULL
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.entity_slug IS NOT NULL
        AND (f.tax_year IS NOT NULL OR f.period_start IS NOT NULL OR f.period_end IS NOT NULL)
        AND a.entity_slug <> f.entity_slug) AS period_document_entity_account_conflict,
    (SELECT COUNT(*) FROM fin_documents f
      JOIN fin_accounts a ON a.tenant_id = f.tenant_id
                         AND a.account_slug = f.account_slug
                         AND a.superseded_by_id IS NULL
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.entity_slug IS NOT NULL
        AND f.doc_kind IN ('profit_and_loss', 'balance_sheet', 'general_ledger',
                           'trial_balance', 'chart_of_accounts')
        AND a.entity_slug <> f.entity_slug) AS books_document_entity_account_conflict,
    (SELECT COUNT(*) FROM fin_documents f
      JOIN fin_accounts a ON a.tenant_id = f.tenant_id
                         AND a.account_slug = f.account_slug
                         AND a.superseded_by_id IS NULL
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.entity_slug IS NOT NULL
        AND f.doc_kind IN ('tax_return', 'k1', 'tax_transcript')
        AND a.entity_slug <> f.entity_slug) AS tax_document_entity_account_conflict,
    (SELECT COUNT(*) FROM fin_documents f
      JOIN fin_accounts a ON a.tenant_id = f.tenant_id
                         AND a.account_slug = f.account_slug
                         AND a.superseded_by_id IS NULL
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.entity_slug IS NOT NULL
        AND (f.doc_kind IN ('tax_notice', 'estimated_payment_receipt')
             OR (f.doc_kind = 'tax_return' AND f.filed_at IS NOT NULL))
        AND a.entity_slug <> f.entity_slug) AS filing_document_entity_account_conflict,
    (SELECT COUNT(*) FROM fin_documents f
      JOIN fin_accounts a ON a.tenant_id = f.tenant_id
                         AND a.account_slug = f.account_slug
                         AND a.superseded_by_id IS NULL
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.entity_slug IS NOT NULL
        AND a.entity_slug <> f.entity_slug) AS evidence_document_entity_account_conflict,
    (SELECT COUNT(*) FROM fin_reconciliations r
      WHERE r.tenant_id = '${DEFAULT_TENANT}'
        AND r.state IN ('open', 'mismatched', 'insufficient_evidence')
        AND r.entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = r.tenant_id AND e.entity_slug = r.entity_slug
            AND e.superseded_by_id IS NULL)) AS reconciliation_entity,
    (SELECT COUNT(*) FROM fin_reconciliations r
      WHERE r.tenant_id = '${DEFAULT_TENANT}'
        AND r.state IN ('open', 'mismatched', 'insufficient_evidence')
        AND r.account_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = r.tenant_id AND a.account_slug = r.account_slug
            AND a.superseded_by_id IS NULL)) AS reconciliation_account,
    (SELECT COUNT(*) FROM fin_reconciliations r
      JOIN fin_accounts a ON a.tenant_id = r.tenant_id
                         AND a.account_slug = r.account_slug
                         AND a.superseded_by_id IS NULL
      WHERE r.tenant_id = '${DEFAULT_TENANT}'
        AND r.state IN ('open', 'mismatched', 'insufficient_evidence')
        AND r.entity_slug IS NOT NULL
        AND a.entity_slug <> r.entity_slug) AS reconciliation_entity_account_conflict,
    (SELECT COUNT(*) FROM fin_exceptions x
      WHERE x.tenant_id = '${DEFAULT_TENANT}' AND x.resolved_at IS NULL
        AND x.entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities e
          WHERE e.tenant_id = x.tenant_id AND e.entity_slug = x.entity_slug
            AND e.superseded_by_id IS NULL)) AS exception_entity,
    (SELECT COUNT(*) FROM fin_exceptions x
      WHERE x.tenant_id = '${DEFAULT_TENANT}' AND x.resolved_at IS NULL
        AND x.txn_account_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts a
          WHERE a.tenant_id = x.tenant_id AND a.account_slug = x.txn_account_slug
            AND a.superseded_by_id IS NULL)) AS exception_account,
    (SELECT COUNT(*) FROM fin_exceptions x
      JOIN fin_accounts a ON a.tenant_id = x.tenant_id
                         AND a.account_slug = x.txn_account_slug
                         AND a.superseded_by_id IS NULL
      WHERE x.tenant_id = '${DEFAULT_TENANT}' AND x.resolved_at IS NULL
        AND x.entity_slug IS NOT NULL
        AND a.entity_slug <> x.entity_slug) AS exception_entity_account_conflict,
    (SELECT COUNT(*) FROM fin_reconciliation_claims c
      WHERE c.tenant_id = '${DEFAULT_TENANT}'
        AND NOT EXISTS (SELECT 1 FROM fin_reconciliations r
          WHERE r.tenant_id = c.tenant_id
            AND r.reconciliation_uid = c.reconciliation_uid)) AS reconciliation_claim_parent,
    (SELECT COUNT(*) FROM fin_reconciliation_claims c
      JOIN fin_reconciliations r
        ON r.tenant_id = c.tenant_id AND r.reconciliation_uid = c.reconciliation_uid
      WHERE c.tenant_id = '${DEFAULT_TENANT}'
        AND ((c.claim_ref_table = 'fin_documents' AND NOT EXISTS (
               SELECT 1 FROM fin_documents target
                WHERE target.tenant_id = c.tenant_id
                  AND target.fin_doc_uid = c.claim_ref_uid
                  AND target.superseded_by_id IS NULL
                  AND (r.account_slug IS NULL OR target.account_slug = r.account_slug)
                  AND (r.entity_slug IS NULL OR (
                    (target.entity_slug = r.entity_slug OR
                     (target.entity_slug IS NULL AND target.account_slug IS NOT NULL))
                    AND (target.account_slug IS NULL OR EXISTS (
                      SELECT 1 FROM fin_accounts target_account
                       WHERE target_account.tenant_id = target.tenant_id
                         AND target_account.account_slug = target.account_slug
                         AND target_account.superseded_by_id IS NULL
                         AND target_account.entity_slug = r.entity_slug))))))
          OR (c.claim_ref_table = 'fin_statements' AND NOT EXISTS (
               SELECT 1 FROM fin_statements target
                WHERE target.tenant_id = c.tenant_id
                  AND target.statement_uid = c.claim_ref_uid
                  AND target.superseded_by_id IS NULL
                  AND (r.account_slug IS NULL OR target.account_slug = r.account_slug)
                  AND (r.entity_slug IS NULL OR EXISTS (
                    SELECT 1 FROM fin_accounts target_account
                     WHERE target_account.tenant_id = target.tenant_id
                       AND target_account.account_slug = target.account_slug
                       AND target_account.superseded_by_id IS NULL
                       AND target_account.entity_slug = r.entity_slug))))
          OR (c.claim_ref_table = 'fin_transactions' AND NOT EXISTS (
               SELECT 1 FROM fin_transactions target
                WHERE target.tenant_id = c.tenant_id
                  AND target.txn_uid = c.claim_ref_uid
                  AND target.superseded_by_id IS NULL
                  AND target.removed_at IS NULL
                  AND (r.account_slug IS NULL OR target.account_slug = r.account_slug)
                  AND (r.entity_slug IS NULL OR EXISTS (
                    SELECT 1 FROM fin_accounts target_account
                     WHERE target_account.tenant_id = target.tenant_id
                       AND target_account.account_slug = target.account_slug
                       AND target_account.superseded_by_id IS NULL
                       AND target_account.entity_slug = r.entity_slug))))))
      AS reconciliation_claim_target,
    (SELECT COUNT(*) FROM fin_reconciliation_claims c
      WHERE c.tenant_id = '${DEFAULT_TENANT}'
        AND (c.claim_ref_table = 'fin_balance_snapshots'
          OR (c.claim_ref_table IS NULL AND c.claim_ref_uid IS NOT NULL)
          OR (c.claim_ref_table IS NOT NULL AND c.claim_ref_uid IS NULL)))
      AS reconciliation_claim_target_identifier_unavailable,
    (SELECT COUNT(*) FROM fin_documents f
      JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.corpus_doc_uid IS NOT NULL
        AND f.content_hash IS NOT NULL AND d.content_hash IS NOT NULL
        AND f.content_hash <> d.content_hash) AS document_corpus_binding_mismatch,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.corpus_doc_uid IS NOT NULL AND f.content_hash IS NULL)
      AS document_corpus_expected_hash_missing,
    (SELECT COUNT(*) FROM fin_documents f
      JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.corpus_doc_uid IS NOT NULL AND d.content_hash IS NULL)
      AS document_corpus_hash_missing,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.corpus_doc_uid IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM documents d
          WHERE d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL))
      AS document_corpus_reference_missing,
    (SELECT COUNT(*) FROM fin_documents f
      WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
        AND f.provenance = 'extracted'
        AND (f.source_locator IS NULL OR f.source_doc_uid = f.fin_doc_uid OR NOT (
          EXISTS (SELECT 1 FROM documents direct
            WHERE direct.doc_uid = f.source_doc_uid AND direct.deleted_at IS NULL)
          OR EXISTS (
            SELECT 1 FROM fin_documents cited
            JOIN documents grounded
              ON grounded.doc_uid = cited.corpus_doc_uid AND grounded.deleted_at IS NULL
             AND cited.content_hash IS NOT NULL AND grounded.content_hash IS NOT NULL
             AND cited.content_hash = grounded.content_hash
           WHERE cited.tenant_id = f.tenant_id
             AND cited.fin_doc_uid = f.source_doc_uid
             AND cited.superseded_by_id IS NULL
             AND cited.id <> f.id
             AND (cited.source_doc_uid IS NULL OR cited.source_doc_uid <> f.fin_doc_uid)
          )
        ))) AS document_source_lineage_unresolved,
    (SELECT COUNT(*) FROM fin_exceptions x
      WHERE x.tenant_id = '${DEFAULT_TENANT}' AND x.resolved_at IS NULL
        AND x.txn_uid IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_transactions target
          WHERE target.tenant_id = x.tenant_id
            AND target.txn_uid = x.txn_uid
            AND target.superseded_by_id IS NULL
            AND target.removed_at IS NULL)) AS exception_transaction,
    (SELECT COUNT(*) FROM fin_exceptions x
      JOIN fin_transactions target ON target.tenant_id = x.tenant_id
                                  AND target.txn_uid = x.txn_uid
                                  AND target.superseded_by_id IS NULL
                                  AND target.removed_at IS NULL
      WHERE x.tenant_id = '${DEFAULT_TENANT}' AND x.resolved_at IS NULL
        AND x.txn_account_slug IS NOT NULL
        AND target.account_slug <> x.txn_account_slug) AS exception_transaction_account_conflict,
    (SELECT COUNT(*) FROM fin_exceptions x
      JOIN fin_transactions target ON target.tenant_id = x.tenant_id
                                  AND target.txn_uid = x.txn_uid
                                  AND target.superseded_by_id IS NULL
                                  AND target.removed_at IS NULL
      JOIN fin_accounts target_account ON target_account.tenant_id = target.tenant_id
                                      AND target_account.account_slug = target.account_slug
                                      AND target_account.superseded_by_id IS NULL
      WHERE x.tenant_id = '${DEFAULT_TENANT}' AND x.resolved_at IS NULL
        AND x.entity_slug IS NOT NULL
        AND target_account.entity_slug <> x.entity_slug)
      AS exception_transaction_entity_conflict,
    (SELECT COUNT(*) FROM fin_exceptions x
      JOIN fin_transactions target ON target.tenant_id = x.tenant_id
                                  AND target.txn_uid = x.txn_uid
                                  AND target.superseded_by_id IS NULL
                                  AND target.removed_at IS NULL
      WHERE x.tenant_id = '${DEFAULT_TENANT}' AND x.resolved_at IS NULL
        AND x.entity_slug IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM fin_accounts target_account
           WHERE target_account.tenant_id = target.tenant_id
             AND target_account.account_slug = target.account_slug
             AND target_account.superseded_by_id IS NULL))
      AS exception_transaction_scope_unavailable,
    (SELECT COUNT(*) FROM fin_entities old
      WHERE old.tenant_id = '${DEFAULT_TENANT}' AND old.superseded_by_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_entities replacement
          WHERE replacement.id = old.superseded_by_id
            AND replacement.id > old.id
            AND replacement.tenant_id = old.tenant_id
            AND replacement.entity_slug = old.entity_slug)) AS entity_supersession_target,
    (SELECT COUNT(*) FROM fin_accounts old
      WHERE old.tenant_id = '${DEFAULT_TENANT}' AND old.superseded_by_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_accounts replacement
          WHERE replacement.id = old.superseded_by_id
            AND replacement.id > old.id
            AND replacement.tenant_id = old.tenant_id
            AND replacement.account_slug = old.account_slug)) AS account_supersession_target,
    (SELECT COUNT(*) FROM fin_account_coverage old
      WHERE old.tenant_id = '${DEFAULT_TENANT}' AND old.superseded_by_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_account_coverage replacement
          WHERE replacement.id = old.superseded_by_id
            AND replacement.id > old.id
            AND replacement.tenant_id = old.tenant_id
            AND replacement.account_slug = old.account_slug)) AS coverage_supersession_target,
    (SELECT COUNT(*) FROM fin_documents old
      WHERE old.tenant_id = '${DEFAULT_TENANT}' AND old.superseded_by_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_documents replacement
          WHERE replacement.id = old.superseded_by_id
            AND replacement.id > old.id
            AND replacement.tenant_id = old.tenant_id
            AND replacement.fin_doc_uid = old.fin_doc_uid)) AS document_supersession_target,
    (SELECT COUNT(*) FROM fin_statements old
      WHERE old.tenant_id = '${DEFAULT_TENANT}' AND old.superseded_by_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_statements replacement
          WHERE replacement.id = old.superseded_by_id
            AND replacement.id > old.id
            AND replacement.tenant_id = old.tenant_id
            AND replacement.statement_uid = old.statement_uid)) AS statement_supersession_target`;

const ACCOUNT_SQL = `
  SELECT a.id AS internal_id, a.account_slug, a.entity_slug, a.institution,
         a.account_kind, a.balance_role, a.mask, a.currency, a.feed_mode,
         a.expected_cadence, a.status, a.opened_on, a.closed_on, a.provenance,
         a.source_doc_uid, a.source_locator, a.source_feed,
         EXISTS (SELECT 1 FROM fin_entities ae
           WHERE ae.tenant_id = a.tenant_id AND ae.entity_slug = a.entity_slug
             AND ae.superseded_by_id IS NULL) AS entity_reference_present,
         sd.source AS linked_corpus_source,
         (SELECT kind FROM sources WHERE name = sd.source) AS linked_corpus_source_kind,
         a.confidence_bp, a.basis_state, a.unparsed_reason, a.recorded_at,
         c.coverage_status, c.covered_from AS period_start, c.covered_to AS period_end,
         c.covered_via_account_slug,
         CASE WHEN c.covered_via_account_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_accounts ca
            WHERE ca.tenant_id = c.tenant_id
              AND ca.account_slug = c.covered_via_account_slug
              AND ca.superseded_by_id IS NULL
         ) END AS covered_via_account_reference_present,
         c.computed_at AS coverage_computed_at,
         c.provenance AS coverage_provenance,
         c.source_doc_uid AS coverage_source_doc_uid,
         c.source_locator AS coverage_source_locator,
         c.source_feed AS coverage_source_feed,
         c.basis_state AS coverage_basis_state,
         c.unparsed_reason AS coverage_unparsed_reason,
         c.recorded_at AS coverage_recorded_at,
         csf.readable AS coverage_readable,
         csd.doc_uid IS NOT NULL AS coverage_corpus_document_present,
         csd.text_source AS coverage_text_source,
         csd.text_reliable AS coverage_text_reliable,
         csd.ingested_at AS coverage_corpus_ingested_at_ms,
         ${corpusProvenanceSql("csd", "coverage_corpus_provenance_json")},
         css.status AS coverage_source_status,
         css.kind AS coverage_source_kind,
         css.last_ingest_at AS coverage_source_last_ingest_at,
         ${sourceCoverageSql(
           "COALESCE(c.source_feed, csd.source)",
           "coverage_source_coverage_json",
         )},
         csd.source AS coverage_linked_corpus_source,
         (SELECT kind FROM sources WHERE name = csd.source)
           AS coverage_linked_corpus_source_kind,
         (csd.doc_uid IS NOT NULL AND
          (csf.fin_doc_uid IS NULL OR
           (csf.content_hash IS NOT NULL AND csd.content_hash IS NOT NULL
            AND csf.content_hash = csd.content_hash)))
           AS coverage_source_reference_present,
         sf.readable, sd.doc_uid IS NOT NULL AS corpus_document_present,
         sd.text_source, sd.text_reliable, sd.ingested_at AS corpus_ingested_at_ms,
         ${corpusProvenanceSql("sd")},
         ss.status AS source_status, ss.kind AS source_kind,
         ss.last_ingest_at AS source_last_ingest_at,
         ${sourceCoverageSql("COALESCE(a.source_feed, sd.source)")},
         NULL AS tax_year,
         (sd.doc_uid IS NOT NULL AND
          (sf.fin_doc_uid IS NULL OR
           (sf.content_hash IS NOT NULL AND sd.content_hash IS NOT NULL
            AND sf.content_hash = sd.content_hash))) AS source_reference_present
    FROM fin_accounts a
    LEFT JOIN fin_account_coverage c
      ON c.tenant_id = a.tenant_id AND c.account_slug = a.account_slug
     AND c.superseded_by_id IS NULL
    LEFT JOIN fin_documents sf
      ON sf.tenant_id = a.tenant_id AND sf.fin_doc_uid = a.source_doc_uid
     AND sf.superseded_by_id IS NULL
    LEFT JOIN documents sd
      ON sd.doc_uid = CASE WHEN sf.fin_doc_uid IS NOT NULL
                           THEN sf.corpus_doc_uid ELSE a.source_doc_uid END
     AND sd.deleted_at IS NULL
    LEFT JOIN sources ss ON ss.name = a.source_feed
    LEFT JOIN fin_documents csf
      ON csf.tenant_id = c.tenant_id AND csf.fin_doc_uid = c.source_doc_uid
     AND csf.superseded_by_id IS NULL
    LEFT JOIN documents csd
      ON csd.doc_uid = CASE WHEN csf.fin_doc_uid IS NOT NULL
                            THEN csf.corpus_doc_uid ELSE c.source_doc_uid END
     AND csd.deleted_at IS NULL
    LEFT JOIN sources css ON css.name = c.source_feed
   WHERE a.tenant_id = '${DEFAULT_TENANT}' AND a.superseded_by_id IS NULL`;

const BOOK_SQL = `
  SELECT * FROM (
    SELECT 'quickbooks_company_observation' AS record_type,
           'qbo:' || q.qbo_fingerprint || ':' || COALESCE(q.entity_slug, '') || ':' || q.source_name AS internal_key,
           q.entity_slug, NULL AS account_slug, NULL AS account_reference_present,
           NULL AS doc_kind, NULL AS tax_year,
           MIN(q.evidence_date) AS period_start, MAX(q.evidence_date) AS period_end,
           q.qbo_fingerprint, COUNT(*) AS evidence_count,
           MIN(q.evidence_date) AS first_evidence_date,
           MAX(q.evidence_date) AS last_evidence_date,
           MAX(q.ingested_at) AS last_ingested_at_ms,
           q.source_name AS source_feed, q.source_name AS linked_corpus_source,
           s.kind AS linked_corpus_source_kind,
           s.status AS source_status,
           s.kind AS source_kind,
           s.last_ingest_at AS source_last_ingest_at,
           ${sourceCoverageSql("q.source_name")},
           'feed' AS provenance, 'confirmed' AS basis_state,
           NULL AS unparsed_reason,
           NULL AS source_doc_uid, NULL AS source_locator,
           NULL AS availability, NULL AS readable, NULL AS restricted,
           NULL AS recorded_at, 1 AS corpus_document_present,
           CASE WHEN SUM(CASE WHEN q.text_source IS NULL OR
                                      q.text_source NOT IN ('native', 'ocr', 'ocr_partial')
                                  THEN 1 ELSE 0 END) > 0 THEN NULL
                WHEN SUM(q.text_source = 'ocr_partial') > 0 THEN 'ocr_partial'
                WHEN SUM(q.text_source = 'ocr') > 0 THEN 'ocr'
                WHEN SUM(q.text_source = 'native') > 0 THEN 'native' END AS text_source,
           CASE WHEN SUM(CASE WHEN q.text_reliable IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
                ELSE MIN(q.text_reliable) END AS text_reliable,
           json_group_array(json_object(
             'doc_uid', q.doc_uid,
             'source', q.source_name,
             'source_id', q.source_id,
             'text_source', q.text_source,
             'text_reliable', q.text_reliable,
             'authority_meta', q.authority_meta
           )) FILTER (WHERE q.provenance_rank <= ${MAX_QBO_PROVENANCE_ROWS})
             AS corpus_provenance_group_json,
           SUM(CASE WHEN q.text_source IS NULL OR
                              q.text_source NOT IN ('native', 'ocr', 'ocr_partial')
                         THEN 1 ELSE 0 END) AS missing_text_source_count,
           SUM(CASE WHEN q.text_reliable IS NULL THEN 1 ELSE 0 END)
             AS missing_text_reliable_count,
           NULL AS source_reference_present,
           MIN(q.entity_reference_present) AS entity_reference_present,
           NULL AS entity_account_mapping_consistent,
           'not_applicable_direct_corpus' AS corpus_content_binding_state
      FROM (
        SELECT doc_uid, source_id, meta AS authority_meta,
               entity_slug, source AS source_name, ingested_at, text_source, text_reliable,
               ROW_NUMBER() OVER (
                 PARTITION BY lower(CASE WHEN json_valid(meta)
                   THEN json_extract(meta, '$.qbo_company_fingerprint') END),
                   entity_slug, source
                 ORDER BY doc_uid
               ) AS provenance_rank,
               CASE WHEN entity_slug IS NULL THEN NULL ELSE EXISTS (
                 SELECT 1 FROM fin_entities me
                  WHERE me.tenant_id = '${DEFAULT_TENANT}'
                    AND me.entity_slug = documents.entity_slug
                    AND me.superseded_by_id IS NULL
               ) END AS entity_reference_present,
               CASE WHEN document_date IS NULL THEN NULL
                    ELSE date(document_date / 1000, 'unixepoch') END AS evidence_date,
               lower(CASE WHEN json_valid(meta)
                          THEN json_extract(meta, '$.qbo_company_fingerprint') END) AS qbo_fingerprint
          FROM documents
         WHERE deleted_at IS NULL
      ) q
      LEFT JOIN sources s ON s.name = q.source_name
     WHERE length(q.qbo_fingerprint) = 64
       AND q.qbo_fingerprint NOT GLOB '*[^0-9a-f]*'
     GROUP BY q.qbo_fingerprint, q.entity_slug, q.source_name, s.kind
    UNION ALL
    SELECT 'books_document_evidence', 'fin-document:' || CAST(f.id AS TEXT),
           f.entity_slug, f.account_slug,
           CASE WHEN f.account_slug IS NULL THEN NULL ELSE EXISTS (
             SELECT 1 FROM fin_accounts ma
              WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
                AND ma.superseded_by_id IS NULL
           ) END,
           f.doc_kind, f.tax_year, f.period_start, f.period_end,
           lower(CASE WHEN json_valid(d.meta)
                      THEN json_extract(d.meta, '$.qbo_company_fingerprint') END),
           1, f.period_start, f.period_end, d.ingested_at,
           f.source_feed,
           CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END,
           (SELECT kind FROM sources
             WHERE name = CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END),
           s.status, s.kind, s.last_ingest_at,
           ${sourceCoverageExpression("COALESCE(f.source_feed, pd.source, d.source)")},
           f.provenance, f.basis_state, f.unparsed_reason, f.source_doc_uid, f.source_locator,
           f.availability, f.readable, f.restricted, f.recorded_at,
           d.doc_uid IS NOT NULL, d.text_source, d.text_reliable,
           CASE WHEN d.doc_uid IS NULL THEN NULL ELSE json_array(
             ${corpusProvenanceExpression("d")}
           ) END,
           CASE WHEN d.text_source IS NULL THEN 1 ELSE 0 END,
           CASE WHEN d.text_reliable IS NULL THEN 1 ELSE 0 END,
           CASE WHEN f.source_doc_uid IS NULL THEN NULL ELSE
             (f.source_doc_uid <> f.fin_doc_uid
              AND pd.doc_uid IS NOT NULL
              AND (pf.fin_doc_uid IS NULL OR
                   (pf.source_doc_uid IS NULL OR pf.source_doc_uid <> f.fin_doc_uid))
              AND (pf.fin_doc_uid IS NULL OR
                   (pf.content_hash IS NOT NULL AND pd.content_hash IS NOT NULL
                    AND pf.content_hash = pd.content_hash))) END,
           CASE WHEN f.entity_slug IS NULL THEN NULL ELSE EXISTS (
             SELECT 1 FROM fin_entities me
              WHERE me.tenant_id = f.tenant_id AND me.entity_slug = f.entity_slug
                AND me.superseded_by_id IS NULL
           ) END,
           (SELECT ma.entity_slug = f.entity_slug FROM fin_accounts ma
              WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
                AND ma.superseded_by_id IS NULL LIMIT 1),
           CASE WHEN f.corpus_doc_uid IS NULL THEN 'not_applicable'
                WHEN d.doc_uid IS NULL THEN 'corpus_document_unresolved'
                WHEN f.content_hash IS NULL THEN 'expected_content_hash_unavailable'
                WHEN d.content_hash IS NULL THEN 'corpus_content_hash_unavailable'
                WHEN f.content_hash = d.content_hash THEN 'matched'
                ELSE 'mismatched' END
      FROM fin_documents f
      LEFT JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
      LEFT JOIN fin_documents pf
        ON pf.tenant_id = f.tenant_id AND pf.fin_doc_uid = f.source_doc_uid
       AND pf.superseded_by_id IS NULL AND pf.id <> f.id
      LEFT JOIN documents pd
        ON pd.doc_uid = CASE WHEN pf.fin_doc_uid IS NOT NULL
                             THEN pf.corpus_doc_uid ELSE f.source_doc_uid END
       AND pd.deleted_at IS NULL
      LEFT JOIN sources s ON s.name = f.source_feed
     WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
       AND f.doc_kind IN ('profit_and_loss', 'balance_sheet', 'general_ledger',
                          'trial_balance', 'chart_of_accounts')
  )`;

const TAX_SQL = `
  SELECT f.id AS internal_id, f.entity_slug, f.account_slug,
         f.doc_kind, f.tax_year, f.period_start, f.period_end,
         f.custody_class, f.availability, f.filed_at, f.received_from, f.received_at, f.readable,
         f.restricted, f.provenance, f.source_doc_uid, f.source_locator, f.source_feed,
         CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END
           AS linked_corpus_source,
         (SELECT kind FROM sources
           WHERE name = CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END)
           AS linked_corpus_source_kind,
         f.confidence_bp, f.basis_state, f.unparsed_reason, f.recorded_at,
         d.doc_uid IS NOT NULL AS corpus_document_present, d.text_source, d.text_reliable,
         d.ingested_at AS corpus_ingested_at_ms,
         ${corpusProvenanceSql("d")},
         s.status AS source_status, s.kind AS source_kind,
         s.last_ingest_at AS source_last_ingest_at,
         ${sourceCoverageSql("COALESCE(f.source_feed, pd.source, d.source)")},
         NULL AS expected_cadence,
         CASE WHEN f.source_doc_uid IS NULL THEN NULL ELSE
           (f.source_doc_uid <> f.fin_doc_uid
            AND pd.doc_uid IS NOT NULL
            AND (pf.fin_doc_uid IS NULL OR
                 (pf.source_doc_uid IS NULL OR pf.source_doc_uid <> f.fin_doc_uid))
            AND (pf.fin_doc_uid IS NULL OR
                 (pf.content_hash IS NOT NULL AND pd.content_hash IS NOT NULL
                  AND pf.content_hash = pd.content_hash))) END
           AS source_reference_present,
         CASE WHEN f.entity_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_entities me
            WHERE me.tenant_id = f.tenant_id AND me.entity_slug = f.entity_slug
              AND me.superseded_by_id IS NULL
         ) END AS entity_reference_present,
         CASE WHEN f.account_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_accounts ma
            WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
              AND ma.superseded_by_id IS NULL
         ) END AS account_reference_present,
         (SELECT ma.entity_slug = f.entity_slug FROM fin_accounts ma
            WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
              AND ma.superseded_by_id IS NULL LIMIT 1)
           AS entity_account_mapping_consistent,
         CASE WHEN f.corpus_doc_uid IS NULL THEN 'not_applicable'
              WHEN d.doc_uid IS NULL THEN 'corpus_document_unresolved'
              WHEN f.content_hash IS NULL THEN 'expected_content_hash_unavailable'
              WHEN d.content_hash IS NULL THEN 'corpus_content_hash_unavailable'
              WHEN f.content_hash = d.content_hash THEN 'matched'
              ELSE 'mismatched' END AS corpus_content_binding_state
    FROM fin_documents f
    LEFT JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
    LEFT JOIN fin_documents pf
      ON pf.tenant_id = f.tenant_id AND pf.fin_doc_uid = f.source_doc_uid
     AND pf.superseded_by_id IS NULL AND pf.id <> f.id
    LEFT JOIN documents pd
      ON pd.doc_uid = CASE WHEN pf.fin_doc_uid IS NOT NULL
                           THEN pf.corpus_doc_uid ELSE f.source_doc_uid END
     AND pd.deleted_at IS NULL
    LEFT JOIN sources s ON s.name = f.source_feed
   WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
     AND f.doc_kind IN ('tax_return', 'k1', 'tax_transcript')`;

const FILING_SQL = `
  SELECT f.id AS internal_id, f.entity_slug, f.account_slug,
         CASE WHEN f.doc_kind = 'tax_return' AND f.filed_at IS NOT NULL
              THEN 'filed_tax_return' ELSE f.doc_kind END AS evidence_kind,
         f.tax_year, f.period_start, f.period_end, f.custody_class, f.availability, f.filed_at,
         f.received_from, f.received_at, f.readable, f.restricted, f.provenance,
         f.source_doc_uid, f.source_locator, f.source_feed,
         CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END
           AS linked_corpus_source,
         (SELECT kind FROM sources
           WHERE name = CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END)
           AS linked_corpus_source_kind,
         f.confidence_bp, f.basis_state, f.unparsed_reason, f.recorded_at,
         d.doc_uid IS NOT NULL AS corpus_document_present, d.text_source, d.text_reliable,
         d.ingested_at AS corpus_ingested_at_ms,
         ${corpusProvenanceSql("d")},
         s.status AS source_status, s.kind AS source_kind,
         s.last_ingest_at AS source_last_ingest_at,
         ${sourceCoverageSql("COALESCE(f.source_feed, pd.source, d.source)")},
         NULL AS expected_cadence,
         CASE WHEN f.source_doc_uid IS NULL THEN NULL ELSE
           (f.source_doc_uid <> f.fin_doc_uid
            AND pd.doc_uid IS NOT NULL
            AND (pf.fin_doc_uid IS NULL OR
                 (pf.source_doc_uid IS NULL OR pf.source_doc_uid <> f.fin_doc_uid))
            AND (pf.fin_doc_uid IS NULL OR
                 (pf.content_hash IS NOT NULL AND pd.content_hash IS NOT NULL
                  AND pf.content_hash = pd.content_hash))) END
           AS source_reference_present,
         CASE WHEN f.entity_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_entities me
            WHERE me.tenant_id = f.tenant_id AND me.entity_slug = f.entity_slug
              AND me.superseded_by_id IS NULL
         ) END AS entity_reference_present,
         CASE WHEN f.account_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_accounts ma
            WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
              AND ma.superseded_by_id IS NULL
         ) END AS account_reference_present,
         (SELECT ma.entity_slug = f.entity_slug FROM fin_accounts ma
            WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
              AND ma.superseded_by_id IS NULL LIMIT 1)
           AS entity_account_mapping_consistent,
         CASE WHEN f.corpus_doc_uid IS NULL THEN 'not_applicable'
              WHEN d.doc_uid IS NULL THEN 'corpus_document_unresolved'
              WHEN f.content_hash IS NULL THEN 'expected_content_hash_unavailable'
              WHEN d.content_hash IS NULL THEN 'corpus_content_hash_unavailable'
              WHEN f.content_hash = d.content_hash THEN 'matched'
              ELSE 'mismatched' END AS corpus_content_binding_state
    FROM fin_documents f
    LEFT JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
    LEFT JOIN fin_documents pf
      ON pf.tenant_id = f.tenant_id AND pf.fin_doc_uid = f.source_doc_uid
     AND pf.superseded_by_id IS NULL AND pf.id <> f.id
    LEFT JOIN documents pd
      ON pd.doc_uid = CASE WHEN pf.fin_doc_uid IS NOT NULL
                           THEN pf.corpus_doc_uid ELSE f.source_doc_uid END
     AND pd.deleted_at IS NULL
    LEFT JOIN sources s ON s.name = f.source_feed
   WHERE f.tenant_id = '${DEFAULT_TENANT}' AND f.superseded_by_id IS NULL
     AND (f.doc_kind IN ('tax_notice', 'estimated_payment_receipt')
          OR (f.doc_kind = 'tax_return' AND f.filed_at IS NOT NULL))`;

const EVIDENCE_SQL = `
  SELECT f.id AS internal_id, f.superseded_by_id, f.entity_slug, f.account_slug,
         CASE WHEN f.superseded_by_id IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_documents replacement
            WHERE replacement.id = f.superseded_by_id
              AND replacement.id > f.id
              AND replacement.tenant_id = f.tenant_id
              AND replacement.fin_doc_uid = f.fin_doc_uid
         ) END AS superseded_by_reference_present,
         f.doc_kind AS evidence_kind, f.tax_year, f.period_start, f.period_end,
         f.custody_class, f.availability, f.available_from, f.available_within_days,
         f.filed_at, f.reconciled_through, f.received_from, f.received_at,
         f.readable, f.unreadable_reason IS NOT NULL AS has_unreadable_reason,
         f.restricted, f.provenance, f.source_doc_uid, f.source_locator,
         f.source_feed,
         CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END
           AS linked_corpus_source,
         (SELECT kind FROM sources
           WHERE name = CASE WHEN f.source_doc_uid IS NOT NULL THEN pd.source ELSE d.source END)
           AS linked_corpus_source_kind,
         f.confidence_bp,
         f.basis_state, f.unparsed_reason, f.recorded_at,
         d.doc_uid IS NOT NULL AS corpus_document_present,
         d.ingested_at AS corpus_ingested_at_ms, d.text_source, d.text_reliable,
         ${corpusProvenanceSql("d")},
         s.status AS source_status,
         s.kind AS source_kind,
         s.last_ingest_at AS source_last_ingest_at,
         ${sourceCoverageSql("COALESCE(f.source_feed, pd.source, d.source)")},
         CASE WHEN f.source_doc_uid IS NULL THEN NULL ELSE
           (f.source_doc_uid <> f.fin_doc_uid
            AND pd.doc_uid IS NOT NULL
            AND (pf.fin_doc_uid IS NULL OR
                 (pf.source_doc_uid IS NULL OR pf.source_doc_uid <> f.fin_doc_uid))
            AND (pf.fin_doc_uid IS NULL OR
                 (pf.content_hash IS NOT NULL AND pd.content_hash IS NOT NULL
                  AND pf.content_hash = pd.content_hash))) END
           AS source_reference_present,
         CASE WHEN f.entity_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_entities me
            WHERE me.tenant_id = f.tenant_id AND me.entity_slug = f.entity_slug
              AND me.superseded_by_id IS NULL
         ) END AS entity_reference_present,
         CASE WHEN f.account_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_accounts ma
            WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
              AND ma.superseded_by_id IS NULL
         ) END AS account_reference_present,
         (SELECT ma.entity_slug = f.entity_slug FROM fin_accounts ma
            WHERE ma.tenant_id = f.tenant_id AND ma.account_slug = f.account_slug
              AND ma.superseded_by_id IS NULL LIMIT 1)
           AS entity_account_mapping_consistent,
         CASE WHEN f.corpus_doc_uid IS NULL THEN 'not_applicable'
              WHEN d.doc_uid IS NULL THEN 'corpus_document_unresolved'
              WHEN f.content_hash IS NULL THEN 'expected_content_hash_unavailable'
              WHEN d.content_hash IS NULL THEN 'corpus_content_hash_unavailable'
              WHEN f.content_hash = d.content_hash THEN 'matched'
              ELSE 'mismatched' END AS corpus_content_binding_state
    FROM fin_documents f
    LEFT JOIN documents d ON d.doc_uid = f.corpus_doc_uid AND d.deleted_at IS NULL
    LEFT JOIN fin_documents pf
      ON pf.tenant_id = f.tenant_id AND pf.fin_doc_uid = f.source_doc_uid
     AND pf.superseded_by_id IS NULL AND pf.id <> f.id
    LEFT JOIN documents pd
      ON pd.doc_uid = CASE WHEN pf.fin_doc_uid IS NOT NULL
                           THEN pf.corpus_doc_uid ELSE f.source_doc_uid END
     AND pd.deleted_at IS NULL
    LEFT JOIN sources s ON s.name = f.source_feed
   WHERE f.tenant_id = '${DEFAULT_TENANT}'`;

const CONFLICT_SQL = `
  SELECT 'reconciliation' AS conflict_type, reconciliation_uid AS internal_key,
         entity_slug, account_slug, period_start, period_end, NULL AS tax_year,
         r.state AS conflict_state, r.measure AS conflict_kind, r.computed_at AS observed_at,
         'derived' AS provenance, NULL AS source_doc_uid, NULL AS source_locator,
         NULL AS source_feed, NULL AS linked_corpus_source,
         NULL AS linked_corpus_source_kind,
         NULL AS basis_state, NULL AS unparsed_reason, r.recorded_at,
         (SELECT json_group_array(json_object(
             'claim_uid', roots.claim_uid,
             'claim_ref_table', roots.claim_ref_table,
             'claim_ref_uid', roots.claim_ref_uid,
             'claim_record_reference_state', roots.claim_record_reference_state,
             'provenance', roots.provenance,
             'source_doc_uid', roots.source_doc_uid,
             'source_locator', roots.source_locator,
             'source_feed', roots.source_feed,
             'linked_corpus_source', roots.linked_corpus_source,
             'linked_corpus_source_kind', roots.linked_corpus_source_kind,
             'basis_state', roots.basis_state,
             'unparsed_reason', roots.unparsed_reason,
             'recorded_at', roots.recorded_at,
             'source_status', roots.source_status,
             'source_kind', roots.source_kind,
             'source_last_ingest_at', roots.source_last_ingest_at,
             'source_coverage_json', json(roots.source_coverage_json),
             'source_reference_present', roots.source_reference_present,
             'readable', roots.readable,
             'corpus_document_present', roots.corpus_document_present,
             'text_source', roots.text_source,
             'text_reliable', roots.text_reliable,
             'corpus_provenance_json', json(roots.corpus_provenance_json),
             'corpus_ingested_at_ms', roots.corpus_ingested_at_ms
           ))
            FROM (SELECT c.*, rd.source AS linked_corpus_source,
                         (SELECT kind FROM sources WHERE name = rd.source)
                           AS linked_corpus_source_kind,
                         rs.status AS source_status,
                         rs.kind AS source_kind,
                         rs.last_ingest_at AS source_last_ingest_at,
                         ${sourceCoverageSql("COALESCE(c.source_feed, rd.source)")},
                         CASE WHEN c.source_doc_uid IS NULL THEN NULL
                              ELSE (rd.doc_uid IS NOT NULL AND
                                    (rf.fin_doc_uid IS NULL OR
                                     (rf.content_hash IS NOT NULL
                                      AND rd.content_hash IS NOT NULL
                                      AND rf.content_hash = rd.content_hash))) END
                           AS source_reference_present,
                         rf.readable, rd.doc_uid IS NOT NULL AS corpus_document_present,
                         rd.text_source, rd.text_reliable,
                         ${corpusProvenanceSql("rd")},
                         rd.ingested_at AS corpus_ingested_at_ms,
                         CASE
                           WHEN c.claim_ref_table IS NULL AND c.claim_ref_uid IS NULL
                             THEN 'not_applicable'
                           WHEN c.claim_ref_table IS NULL
                             THEN 'unavailable_reference_table_missing'
                           WHEN c.claim_ref_uid IS NULL
                             THEN 'unavailable_reference_uid_missing'
                           WHEN c.claim_ref_table = 'fin_documents' THEN
                             CASE
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_documents target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.fin_doc_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                                    AND (r.account_slug IS NULL OR target.account_slug = r.account_slug)
                                    AND (r.entity_slug IS NULL OR (
                                      (target.entity_slug = r.entity_slug OR
                                       (target.entity_slug IS NULL AND target.account_slug IS NOT NULL))
                                      AND (target.account_slug IS NULL OR EXISTS (
                                        SELECT 1 FROM fin_accounts target_account
                                         WHERE target_account.tenant_id = target.tenant_id
                                           AND target_account.account_slug = target.account_slug
                                           AND target_account.superseded_by_id IS NULL
                                           AND target_account.entity_slug = r.entity_slug))))
                               ) THEN 'current_record_resolved'
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_documents target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.fin_doc_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                                    AND ((r.account_slug IS NOT NULL
                                          AND target.account_slug IS NOT NULL
                                          AND target.account_slug <> r.account_slug)
                                      OR (r.entity_slug IS NOT NULL
                                          AND target.entity_slug IS NOT NULL
                                          AND target.entity_slug <> r.entity_slug)
                                      OR (r.entity_slug IS NOT NULL
                                          AND target.account_slug IS NOT NULL
                                          AND EXISTS (
                                            SELECT 1 FROM fin_accounts target_account
                                             WHERE target_account.tenant_id = target.tenant_id
                                               AND target_account.account_slug = target.account_slug
                                               AND target_account.superseded_by_id IS NULL
                                               AND target_account.entity_slug <> r.entity_slug)))
                               ) THEN 'scope_mapping_conflict'
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_documents target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.fin_doc_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                               ) THEN 'scope_mapping_unavailable'
                               ELSE 'unresolved'
                             END
                           WHEN c.claim_ref_table = 'fin_statements' THEN
                             CASE
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_statements target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.statement_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                                    AND (r.account_slug IS NULL OR target.account_slug = r.account_slug)
                                    AND (r.entity_slug IS NULL OR EXISTS (
                                      SELECT 1 FROM fin_accounts target_account
                                       WHERE target_account.tenant_id = target.tenant_id
                                         AND target_account.account_slug = target.account_slug
                                         AND target_account.superseded_by_id IS NULL
                                         AND target_account.entity_slug = r.entity_slug))
                               ) THEN 'current_record_resolved'
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_statements target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.statement_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                                    AND ((r.account_slug IS NOT NULL
                                          AND target.account_slug <> r.account_slug)
                                      OR (r.entity_slug IS NOT NULL AND EXISTS (
                                        SELECT 1 FROM fin_accounts target_account
                                         WHERE target_account.tenant_id = target.tenant_id
                                           AND target_account.account_slug = target.account_slug
                                           AND target_account.superseded_by_id IS NULL
                                           AND target_account.entity_slug <> r.entity_slug)))
                               ) THEN 'scope_mapping_conflict'
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_statements target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.statement_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                               ) THEN 'scope_mapping_unavailable'
                               ELSE 'unresolved'
                             END
                           WHEN c.claim_ref_table = 'fin_transactions' THEN
                             CASE
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_transactions target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.txn_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                                    AND target.removed_at IS NULL
                                    AND (r.account_slug IS NULL OR target.account_slug = r.account_slug)
                                    AND (r.entity_slug IS NULL OR EXISTS (
                                      SELECT 1 FROM fin_accounts target_account
                                       WHERE target_account.tenant_id = target.tenant_id
                                         AND target_account.account_slug = target.account_slug
                                         AND target_account.superseded_by_id IS NULL
                                         AND target_account.entity_slug = r.entity_slug))
                               ) THEN 'current_record_resolved'
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_transactions target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.txn_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                                    AND target.removed_at IS NULL
                                    AND ((r.account_slug IS NOT NULL
                                          AND target.account_slug <> r.account_slug)
                                      OR (r.entity_slug IS NOT NULL AND EXISTS (
                                        SELECT 1 FROM fin_accounts target_account
                                         WHERE target_account.tenant_id = target.tenant_id
                                           AND target_account.account_slug = target.account_slug
                                           AND target_account.superseded_by_id IS NULL
                                           AND target_account.entity_slug <> r.entity_slug)))
                               ) THEN 'scope_mapping_conflict'
                               WHEN EXISTS (
                                 SELECT 1 FROM fin_transactions target
                                  WHERE target.tenant_id = c.tenant_id
                                    AND target.txn_uid = c.claim_ref_uid
                                    AND target.superseded_by_id IS NULL
                                    AND target.removed_at IS NULL
                               ) THEN 'scope_mapping_unavailable'
                               ELSE 'unresolved'
                             END
                           WHEN c.claim_ref_table = 'fin_balance_snapshots'
                             THEN 'unavailable_no_stable_identifier_contract'
                           ELSE 'unavailable_unsupported_reference_table'
                         END AS claim_record_reference_state
                    FROM fin_reconciliation_claims c
                    LEFT JOIN fin_documents rf
                      ON rf.tenant_id = c.tenant_id AND rf.fin_doc_uid = c.source_doc_uid
                     AND rf.superseded_by_id IS NULL
                    LEFT JOIN documents rd
                      ON rd.doc_uid = CASE WHEN rf.fin_doc_uid IS NOT NULL
                                           THEN rf.corpus_doc_uid ELSE c.source_doc_uid END
                     AND rd.deleted_at IS NULL
                    LEFT JOIN sources rs ON rs.name = c.source_feed
                   WHERE c.tenant_id = r.tenant_id
                     AND c.reconciliation_uid = r.reconciliation_uid
                   ORDER BY c.claim_uid
                   LIMIT ${MAX_DERIVATION_ROOTS + 1}) roots) AS derivation_roots_json,
         (SELECT COUNT(*) FROM fin_reconciliation_claims c
           WHERE c.tenant_id = r.tenant_id
             AND c.reconciliation_uid = r.reconciliation_uid) AS derivation_roots_total,
         NULL AS source_status, NULL AS source_kind, NULL AS source_last_ingest_at,
         NULL AS source_coverage_json,
         NULL AS corpus_ingested_at_ms, NULL AS expected_cadence,
         NULL AS source_reference_present, NULL AS readable,
         NULL AS corpus_document_present, NULL AS text_source, NULL AS text_reliable,
         NULL AS corpus_provenance_json,
         CASE WHEN r.entity_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_entities me
            WHERE me.tenant_id = r.tenant_id AND me.entity_slug = r.entity_slug
              AND me.superseded_by_id IS NULL
         ) END AS entity_reference_present,
         CASE WHEN r.account_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_accounts ma
            WHERE ma.tenant_id = r.tenant_id AND ma.account_slug = r.account_slug
              AND ma.superseded_by_id IS NULL
         ) END AS account_reference_present,
         (SELECT ma.entity_slug = r.entity_slug FROM fin_accounts ma
            WHERE ma.tenant_id = r.tenant_id AND ma.account_slug = r.account_slug
              AND ma.superseded_by_id IS NULL LIMIT 1)
           AS entity_account_mapping_consistent,
         NULL AS transaction_reference_state
   FROM fin_reconciliations r
   WHERE r.tenant_id = '${DEFAULT_TENANT}'
     AND r.state IN ('open', 'mismatched', 'insufficient_evidence')
  UNION ALL
  SELECT 'exception', e.exception_uid, e.entity_slug, e.txn_account_slug,
         e.txn_date, e.txn_date, NULL, 'open', e.kind, e.first_seen,
         e.provenance, e.source_doc_uid, e.source_locator, e.source_feed, ed.source,
         (SELECT kind FROM sources WHERE name = ed.source),
         e.basis_state, e.unparsed_reason, e.recorded_at, NULL, NULL,
         ss.status, ss.kind, ss.last_ingest_at,
         ${sourceCoverageExpression("COALESCE(e.source_feed, ed.source)")},
         ed.ingested_at, NULL,
         CASE WHEN e.source_doc_uid IS NULL THEN NULL
              ELSE (ed.doc_uid IS NOT NULL AND
                    (ef.fin_doc_uid IS NULL OR
                     (ef.content_hash IS NOT NULL AND ed.content_hash IS NOT NULL
                      AND ef.content_hash = ed.content_hash))) END,
         ef.readable, ed.doc_uid IS NOT NULL, ed.text_source, ed.text_reliable,
         ${corpusProvenanceExpression("ed")},
         CASE WHEN e.entity_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_entities me
            WHERE me.tenant_id = e.tenant_id AND me.entity_slug = e.entity_slug
              AND me.superseded_by_id IS NULL
         ) END,
         CASE WHEN e.txn_account_slug IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM fin_accounts ma
            WHERE ma.tenant_id = e.tenant_id AND ma.account_slug = e.txn_account_slug
              AND ma.superseded_by_id IS NULL
         ) END,
         (SELECT ma.entity_slug = e.entity_slug FROM fin_accounts ma
            WHERE ma.tenant_id = e.tenant_id AND ma.account_slug = e.txn_account_slug
              AND ma.superseded_by_id IS NULL LIMIT 1),
         CASE WHEN e.txn_uid IS NULL THEN 'not_applicable'
              WHEN EXISTS (
                SELECT 1 FROM fin_transactions target
                 WHERE target.tenant_id = e.tenant_id
                   AND target.txn_uid = e.txn_uid
                   AND target.superseded_by_id IS NULL
                   AND target.removed_at IS NULL
                   AND (e.txn_account_slug IS NULL OR target.account_slug = e.txn_account_slug)
                   AND (e.entity_slug IS NULL OR EXISTS (
                     SELECT 1 FROM fin_accounts target_account
                      WHERE target_account.tenant_id = target.tenant_id
                        AND target_account.account_slug = target.account_slug
                        AND target_account.superseded_by_id IS NULL
                        AND target_account.entity_slug = e.entity_slug))
              ) THEN 'current_record_resolved'
              WHEN EXISTS (
                SELECT 1 FROM fin_transactions target
                 WHERE target.tenant_id = e.tenant_id
                   AND target.txn_uid = e.txn_uid
                   AND target.superseded_by_id IS NULL
                   AND target.removed_at IS NULL
                   AND e.txn_account_slug IS NOT NULL
                   AND target.account_slug <> e.txn_account_slug
              ) THEN 'account_mapping_conflict'
              WHEN EXISTS (
                SELECT 1 FROM fin_transactions target
                JOIN fin_accounts target_account
                  ON target_account.tenant_id = target.tenant_id
                 AND target_account.account_slug = target.account_slug
                 AND target_account.superseded_by_id IS NULL
                 WHERE target.tenant_id = e.tenant_id
                   AND target.txn_uid = e.txn_uid
                   AND target.superseded_by_id IS NULL
                   AND target.removed_at IS NULL
                   AND e.entity_slug IS NOT NULL
                   AND target_account.entity_slug <> e.entity_slug
              ) THEN 'entity_mapping_conflict'
              WHEN EXISTS (
                SELECT 1 FROM fin_transactions target
                 WHERE target.tenant_id = e.tenant_id
                   AND target.txn_uid = e.txn_uid
                   AND target.superseded_by_id IS NULL
                   AND target.removed_at IS NULL
              ) THEN 'scope_mapping_unavailable'
              ELSE 'unresolved' END
    FROM fin_exceptions e
    LEFT JOIN fin_documents ef
      ON ef.tenant_id = e.tenant_id AND ef.fin_doc_uid = e.source_doc_uid
     AND ef.superseded_by_id IS NULL
    LEFT JOIN documents ed
      ON ed.doc_uid = CASE WHEN ef.fin_doc_uid IS NOT NULL
                           THEN ef.corpus_doc_uid ELSE e.source_doc_uid END
     AND ed.deleted_at IS NULL
    LEFT JOIN sources ss ON ss.name = e.source_feed
   WHERE e.tenant_id = '${DEFAULT_TENANT}' AND e.resolved_at IS NULL`;

function categoryFor(kind) {
  if (["checking", "savings", "escrow"].includes(kind)) return "bank";
  if (kind === "card") return "credit_card";
  if (["loan", "line_of_credit"].includes(kind)) return "loan";
  if (["investment", "retirement"].includes(kind)) return "investment";
  if (["merchant", "point_of_sale"].includes(kind)) return "payment_processor";
  return "unclassified";
}

function safeInstitution(value) {
  if (!value) return null;
  // `institution` is unconstrained free text and has held account numbers in
  // field imports. Only the separately constrained account mask may contribute
  // digits to a rendered identity.
  return String(value).slice(0, 120).replace(/\p{Decimal_Number}/gu, "X");
}

function provenanceState(row, roots = []) {
  if (row.provenance === "owner_stated") return "owner_stated";
  if (row.provenance === "extracted") {
    return row.source_doc_uid && row.source_locator && Boolean(row.source_reference_present)
      ? "document_cited"
      : row.source_doc_uid && row.source_locator ? "document_reference_unresolved" : "incomplete";
  }
  if (row.provenance === "feed") {
    return row.source_feed && row.source_status ? "feed_registry_cited" : "feed_registry_unresolved";
  }
  if (row.provenance === "derived") return roots.length ? "derived_roots_cited" : "derived_roots_unavailable";
  return "unavailable";
}

function provenanceRecord(row, roots = []) {
  const missing = [];
  const storedAssessment = row.stored_provenance_assessment;
  const corpusProvenanceExpected = Boolean(row.corpus_document_present) ||
    (row.provenance === "extracted" && Boolean(row.source_document_present));
  const supersessionClaimed = row.superseded_by_id !== null && row.superseded_by_id !== undefined;
  if (!row.provenance) missing.push("provenance");
  if (!row.basis_state) missing.push("basis_state");
  if (!row.recorded_at) missing.push("recorded_at");
  // A stored `owner_stated` label is not a durable receipt proving which
  // actor confirmed it. Until the schema carries that ceremony, the assertion
  // is provenance debt even when its legacy basis_state says "confirmed".
  if (row.provenance === "owner_stated") missing.push("owner_actor_receipt");
  if (corpusProvenanceExpected && storedAssessment?.provenance_assessed !== true) {
    missing.push("stored_provenance_receipt");
  } else if (corpusProvenanceExpected && storedAssessment?.provenance_status !== "complete") {
    missing.push("stored_provenance_receipt_complete");
  }
  if (supersessionClaimed && !Boolean(row.superseded_by_reference_present)) {
    missing.push("superseded_by_reference_resolution");
  }
  if (row.claim_record_reference_state === "unresolved") {
    missing.push("claim_record_reference_resolution");
  } else if (row.claim_record_reference_state === "scope_mapping_conflict") {
    missing.push("claim_record_scope_mapping_conflict");
  } else if (row.claim_record_reference_state === "scope_mapping_unavailable") {
    missing.push("claim_record_scope_mapping_resolution");
  } else if (String(row.claim_record_reference_state || "").startsWith("unavailable_")) {
    missing.push("claim_record_identifier_contract");
  }
  if (row.transaction_reference_state === "unresolved") {
    missing.push("exception_transaction_reference_resolution");
  } else if (row.transaction_reference_state === "account_mapping_conflict") {
    missing.push("exception_transaction_account_mapping");
  } else if (row.transaction_reference_state === "entity_mapping_conflict") {
    missing.push("exception_transaction_entity_mapping");
  } else if (row.transaction_reference_state === "scope_mapping_unavailable") {
    missing.push("exception_transaction_scope_mapping_resolution");
  }
  if (row.corpus_content_binding_state === "mismatched") {
    missing.push("corpus_content_hash_match");
  } else if (row.corpus_content_binding_state === "expected_content_hash_unavailable") {
    missing.push("financial_document_content_hash");
  } else if (row.corpus_content_binding_state === "corpus_content_hash_unavailable") {
    missing.push("corpus_content_hash");
  } else if (row.corpus_content_binding_state === "corpus_document_unresolved") {
    missing.push("corpus_document_resolution");
  }
  if (row.provenance === "extracted") {
    if (!row.source_doc_uid) missing.push("source_document_reference");
    if (!row.source_locator) missing.push("source_locator");
    if (!Boolean(row.source_reference_present)) {
      missing.push("source_document_reference_resolution");
    }
  }
  if (row.provenance === "feed") {
    if (!row.source_feed) missing.push("source_feed_reference");
    if (!row.source_status) missing.push("source_feed_registry");
  }
  if (row.provenance === "derived" && roots.length === 0) missing.push("derivation_roots");
  if (row.derivation_roots_truncated) missing.push("derivation_roots_complete");
  if (row.basis_state === "unparsed" && !row.unparsed_reason) missing.push("unparsed_reason");
  const rootsWithDebt = roots.filter((root) =>
    root.provenance_status_code === "incomplete" ||
    (Array.isArray(root.missing_provenance_fields) && root.missing_provenance_fields.length > 0));
  if (rootsWithDebt.length) missing.push("derivation_root_provenance");
  const reasonCodes = [
    ...missing.map((field) => `missing_${field}`),
    ...(row.source_feed && row.linked_corpus_source && row.source_feed !== row.linked_corpus_source
      ? ["source_feed_corpus_source_conflict"] : []),
    ...(row.provenance === "owner_stated" ? ["stored_owner_assertion_unconfirmed"] : []),
    ...(row.basis_state === "proposed" ? ["basis_proposed"] : []),
    ...(row.basis_state === "unparsed" ? ["basis_unparsed"] : []),
    ...(row.unparsed_reason ? ["stored_unparsed_reason"] : []),
  ];
  const missingFields = [...new Set(missing)];
  return {
    state: provenanceState(row, roots),
    status_code: reasonCodes.length ? "incomplete" : "complete",
    reason_codes: [...new Set(reasonCodes)],
    missing_fields: missingFields,
    provenance: row.provenance || null,
    basis_state: row.basis_state || null,
    unparsed_reason: row.unparsed_reason || null,
    confidence_basis_points: Number.isInteger(row.confidence_bp) ? row.confidence_bp : null,
    source_document_ref: row.source_document_ref || null,
    source_document_present: Boolean(row.source_document_present),
    source_document_reference_state: row.source_document_reference_state || "absent",
    source_locator_present: Boolean(row.source_locator),
    source_locator_ref: row.source_locator_ref || null,
    source_locator_state: row.source_locator ? "stable_hash_only" : "absent",
    source_feed_ref: row.source_feed_ref || null,
    source_feed_present: Boolean(row.source_feed_present),
    source_feed_kind: row.source_feed_kind || null,
    source_feed_kind_state: row.source_feed_kind_state || "absent",
    source_feed_registry_state: row.source_feed_registry_state || "absent",
    linked_corpus_source_ref: row.linked_corpus_source_ref || null,
    linked_corpus_source_present: Boolean(row.linked_corpus_source_present),
    linked_corpus_source_kind: row.linked_corpus_source_kind || null,
    linked_corpus_source_state: row.linked_corpus_source_state || "absent",
    supersession_claimed: supersessionClaimed,
    superseded_by_reference_present: !supersessionClaimed
      ? null
      : Boolean(row.superseded_by_reference_present),
    claim_record_reference_state: row.claim_record_reference_state || null,
    transaction_reference_state: row.transaction_reference_state || null,
    corpus_content_binding_state: row.corpus_content_binding_state || "not_applicable",
    recorded_at: row.recorded_at || null,
    derivation_roots: roots,
  };
}

function publicLineageReferences(lineage) {
  return {
    source_document_ref: lineage.source_document_ref,
    source_document_present: lineage.source_document_present,
    source_document_reference_state: lineage.source_document_reference_state,
    source_locator_present: lineage.source_locator_present,
    source_locator_ref: lineage.source_locator_ref,
    source_locator_state: lineage.source_locator_state,
    source_feed_ref: lineage.source_feed_ref,
    source_feed_present: lineage.source_feed_present,
    source_feed_kind: lineage.source_feed_kind,
    source_feed_kind_state: lineage.source_feed_kind_state,
    source_feed_registry_state: lineage.source_feed_registry_state,
    linked_corpus_source_ref: lineage.linked_corpus_source_ref,
    linked_corpus_source_present: lineage.linked_corpus_source_present,
    linked_corpus_source_kind: lineage.linked_corpus_source_kind,
    linked_corpus_source_state: lineage.linked_corpus_source_state,
  };
}

function extractionRecord(row) {
  const corpusPresent = row.corpus_document_present === undefined || row.corpus_document_present === null
    ? null
    : Boolean(row.corpus_document_present);
  const readable = row.readable === undefined || row.readable === null
    ? null
    : Boolean(row.readable);
  const assessment = row.stored_provenance_assessment || {
    provenance_assessed: false,
    provenance_status: "unavailable",
    provenance_reason: "provenance_receipt_missing_or_invalid",
    text_source: "unknown",
    text_reliable: false,
  };
  const assessed = assessment.provenance_assessed === true;
  const provenanceStatus = assessed ? assessment.provenance_status : "unavailable";
  const provenanceReason = !assessed &&
    assessment.provenance_reason === "provenance_group_incomplete_or_bounded"
    ? assessment.provenance_reason
    : assessed
      ? assessment.provenance_reason
      : "provenance_receipt_missing_or_invalid";
  if (!assessed) {
    return {
      state: readable === false ? "unreadable" : "unavailable",
      readable,
      text_source: null,
      text_reliable: null,
      provenance_assessed: false,
      provenance_status: provenanceStatus,
      provenance_reason: provenanceReason,
      corpus_document_present: corpusPresent,
      corpus_content_binding_state: row.corpus_content_binding_state || "not_applicable",
      unavailable_fields: [
        "stored_provenance_receipt", "text_source", "text_reliable",
        "scan_only_or_empty_distinction",
      ],
    };
  }
  const source = ["native", "ocr", "ocr_partial"].includes(assessment.text_source)
    ? assessment.text_source
    : null;
  if (readable === false) {
    return {
      state: "unreadable",
      readable: false,
      text_source: source,
      text_reliable: Boolean(assessment.text_reliable),
      provenance_assessed: true,
      provenance_status: provenanceStatus,
      provenance_reason: provenanceReason,
      corpus_document_present: corpusPresent,
      corpus_content_binding_state: row.corpus_content_binding_state || "not_applicable",
      unavailable_fields: source ? [] : ["text_source", "scan_only_or_empty_distinction"],
    };
  }
  if (source) {
    return {
      state: source,
      readable,
      text_source: source,
      text_reliable: Boolean(assessment.text_reliable),
      provenance_assessed: true,
      provenance_status: provenanceStatus,
      provenance_reason: provenanceReason,
      corpus_document_present: corpusPresent,
      corpus_content_binding_state: row.corpus_content_binding_state || "not_applicable",
      unavailable_fields: [],
    };
  }
  return {
    state: "unavailable",
    readable,
    text_source: null,
    text_reliable: Boolean(assessment.text_reliable),
    provenance_assessed: true,
    provenance_status: provenanceStatus,
    provenance_reason: provenanceReason,
    corpus_document_present: corpusPresent,
    corpus_content_binding_state: row.corpus_content_binding_state || "not_applicable",
    unavailable_fields: ["text_source", "scan_only_or_empty_distinction"],
  };
}

/**
 * Surface the timestamps D1 actually stores without turning age into a
 * current/stale verdict. The present schema has no durable applicability or
 * evaluation policy for most financial evidence, so those exact gaps remain
 * blocking inputs for Optimize to resolve with the owner.
 */
function freshnessRecord(row) {
  const sourceLastIngestAt = row.source_last_ingest_at || null;
  const corpusIngestedAtMs = row.corpus_ingested_at_ms === null ||
    row.corpus_ingested_at_ms === undefined
    ? (row.last_ingested_at_ms === null || row.last_ingested_at_ms === undefined
      ? null
      : Number(row.last_ingested_at_ms))
    : Number(row.corpus_ingested_at_ms);
  const sourceCoverage = row.source_coverage ||
    unavailableSourceCoverage(row, "unavailable", ["source_registry_coverage"]);
  const missing = [
    "freshness_applicability", "freshness_evaluation_policy",
    ...sourceCoverage.missing_fields,
  ];
  if (row.source_feed && !row.source_status) missing.push("source_status");
  if (row.source_feed && !sourceLastIngestAt) missing.push("source_last_ingest_at");
  return {
    state: sourceLastIngestAt || corpusIngestedAtMs !== null || row.recorded_at
      ? "timestamps_available_assessment_not_computed"
      : "unavailable",
    current_or_stale: null,
    source_status: row.source_status || null,
    source_last_ingest_at: sourceLastIngestAt,
    corpus_ingested_at_ms: Number.isFinite(corpusIngestedAtMs) ? corpusIngestedAtMs : null,
    evidence_recorded_at: row.recorded_at || null,
    expected_cadence: row.expected_cadence || null,
    source_coverage: sourceCoverage,
    missing_fields: [...new Set(missing)],
  };
}

function verificationRecord(row, {
  roots = [],
  documentEvidenceExpected = false,
  extraMissingFields = [],
  extraBlockingReasons = [],
} = {}) {
  const provenance = provenanceRecord(row, roots);
  const extraction = extractionRecord(row);
  const freshness = freshnessRecord(row);
  const missingExtractionFields = documentEvidenceExpected ? extraction.unavailable_fields : [];
  const missingFields = [...new Set([
    ...provenance.missing_fields, ...missingExtractionFields,
    ...freshness.missing_fields, ...extraMissingFields,
  ])];
  const blockingReasons = [...extraBlockingReasons];
  if (provenance.missing_fields.length) blockingReasons.push("provenance_fields_missing");
  if (provenance.status_code === "incomplete" || provenance.state === "incomplete" ||
      provenance.state === "unavailable" ||
      provenance.state === "derived_roots_unavailable") {
    blockingReasons.push("provenance_incomplete");
  }
  if (documentEvidenceExpected && ["unavailable", "unreadable", "ocr", "ocr_partial"].includes(extraction.state)) {
    blockingReasons.push(`extraction_${extraction.state}`);
  }
  if (documentEvidenceExpected && extraction.text_reliable === false &&
      !blockingReasons.includes(`extraction_${extraction.state}`)) {
    blockingReasons.push("extraction_text_unreliable");
  }
  if (documentEvidenceExpected && extraction.text_reliable === null) {
    blockingReasons.push("extraction_reliability_unavailable");
  }
  if (freshness.missing_fields.length) blockingReasons.push("freshness_not_verifiable");
  return {
    provenance_state: provenance.state,
    provenance_status_code: provenance.status_code,
    provenance_reason_codes: provenance.reason_codes,
    provenance_debt: provenance.status_code === "incomplete",
    missing_provenance_fields: provenance.missing_fields,
    missing_extraction_fields: missingExtractionFields,
    freshness_state: freshness.state,
    missing_freshness_fields: freshness.missing_fields,
    missing_verification_fields: missingFields,
    extraction,
    freshness,
    extraction_relevant: documentEvidenceExpected,
    blocks_financial_verification: blockingReasons.length > 0,
    blocking_reasons: [...new Set(blockingReasons)],
    gap_state: blockingReasons.length > 0 ? "blocking" : "clear",
    gap_reason_codes: [...new Set(blockingReasons)],
  };
}

function verificationUnits(record) {
  const units = [];
  if (record?.verification) units.push(record.verification);
  if (record?.coverage?.verification) units.push(record.coverage.verification);
  for (const root of record?.source_lineage?.derivation_roots || []) {
    if (root?.verification) units.push(root.verification);
  }
  return units;
}

function hasTruncatedNestedProvenance(records) {
  return records.some((record) => record?.derivation_root_page?.truncated === true);
}

function provenanceDebtSinceBaseline(records, coversAllMatchingRecords, baseline) {
  const unitsExamined = records.reduce((count, record) => count + verificationUnits(record).length, 0);
  if (!baseline) {
    return {
      state: "not_requested",
      baseline_recorded_at: null,
      count_scope: "returned_page",
      count_unit: "provenance_record_occurrences",
      covers_all_matching_records: coversAllMatchingRecords,
      new_records: null,
      new_records_with_provenance_debt: null,
      unclassifiable_recorded_at: null,
      debt_reason_codes: {},
    };
  }
  const baselineMs = Date.parse(baseline.recorded_at);
  let newRecords = 0;
  let debt = 0;
  let unclassifiable = 0;
  const debtReasonCodes = {};
  for (const record of records) {
    for (const verification of verificationUnits(record)) {
      const recordedAt = verification.freshness?.evidence_recorded_at || null;
      const recordedAtMs = Date.parse(recordedAt || "");
      if (!Number.isFinite(recordedAtMs)) {
        unclassifiable += 1;
        continue;
      }
      if (recordedAtMs <= baselineMs) continue;
      newRecords += 1;
      if (verification.provenance_debt !== true) continue;
      debt += 1;
      for (const code of verification.provenance_reason_codes || []) {
        debtReasonCodes[code] = (debtReasonCodes[code] || 0) + 1;
      }
    }
  }
  const sufficient = coversAllMatchingRecords && unitsExamined > 0 && unclassifiable === 0;
  return {
    state: !sufficient
      ? "insufficient_scope"
      : debt > 0 ? "failed_new_provenance_debt" : "passed_no_new_provenance_debt",
    baseline_recorded_at: baseline.recorded_at,
    comparison: "durable_recorded_at_strictly_after_baseline",
    count_scope: "returned_page",
    count_unit: "provenance_record_occurrences",
    covers_all_matching_records: coversAllMatchingRecords,
    new_records: newRecords,
    new_records_with_provenance_debt: debt,
    unclassifiable_recorded_at: unclassifiable,
    debt_reason_codes: debtReasonCodes,
  };
}

function verificationGapSummary(records, coversAllMatchingRecords, baseline) {
  const nestedProvenanceTruncated = hasTruncatedNestedProvenance(records);
  const coversAllProvenanceRecords = coversAllMatchingRecords && !nestedProvenanceTruncated;
  const missingFields = {};
  const provenanceStates = {};
  const extractionStates = {};
  const freshnessStates = {};
  let affected = 0;
  let blocking = 0;
  let provenanceRecordsExamined = 0;
  for (const record of records) {
    const units = verificationUnits(record);
    provenanceRecordsExamined += units.length;
    let recordAffected = false;
    let recordBlocking = false;
    for (const verification of units) {
      const provenance = verification.provenance_state || "unavailable";
      provenanceStates[provenance] = (provenanceStates[provenance] || 0) + 1;
      const extraction = verification.extraction?.state || "unavailable";
      extractionStates[extraction] = (extractionStates[extraction] || 0) + 1;
      const freshness = verification.freshness?.state || "unavailable";
      freshnessStates[freshness] = (freshnessStates[freshness] || 0) + 1;
      const fields = Array.isArray(verification.missing_verification_fields)
        ? verification.missing_verification_fields
        : [];
      for (const field of fields) missingFields[field] = (missingFields[field] || 0) + 1;
      const extractionGap = verification.extraction_relevant === true && extraction !== "native";
      if (fields.length || extractionGap || verification.blocks_financial_verification === true) {
        recordAffected = true;
      }
      if (verification.blocks_financial_verification === true) recordBlocking = true;
    }
    if (recordAffected) affected += 1;
    if (recordBlocking) blocking += 1;
  }
  return {
    count_scope: "returned_page",
    bounded_by_page_limit: true,
    covers_all_matching_records: coversAllProvenanceRecords,
    scope_reason_codes: nestedProvenanceTruncated ? ["nested_provenance_truncated"] : [],
    examined: records.length,
    provenance_records_examined: provenanceRecordsExamined,
    affected,
    blocking,
    missing_fields: missingFields,
    by_provenance_state: provenanceStates,
    by_extraction_state: extractionStates,
    by_freshness_state: freshnessStates,
    provenance_debt_since_baseline: provenanceDebtSinceBaseline(
      records,
      coversAllProvenanceRecords,
      baseline,
    ),
    recovery_mode: "planning_only_no_ocr_reingest_or_write",
  };
}

function aggregateProvenanceDebtGate(request, sections) {
  if (!request.provenanceBaseline) {
    return {
      state: "not_requested",
      baseline_recorded_at: null,
      gate_scope: "requested_sections_with_available_record_registry",
      count_unit: "section_provenance_record_occurrences_may_overlap",
      real_world_completeness: "not_proven",
    };
  }
  const evaluated = [];
  const excluded = [];
  let newRecords = 0;
  let debt = 0;
  let unclassifiable = 0;
  let insufficient = false;
  const debtReasonCodes = {};
  for (const name of request.selected) {
    const section = sections[name];
    if (!section || section.unavailable) {
      excluded.push(name);
      insufficient = true;
      continue;
    }
    evaluated.push(name);
    const metric = section.verification_gap_summary?.provenance_debt_since_baseline;
    if (!metric || metric.state === "insufficient_scope") insufficient = true;
    newRecords += Number(metric?.new_records || 0);
    debt += Number(metric?.new_records_with_provenance_debt || 0);
    unclassifiable += Number(metric?.unclassifiable_recorded_at || 0);
    for (const [code, count] of Object.entries(metric?.debt_reason_codes || {})) {
      debtReasonCodes[code] = (debtReasonCodes[code] || 0) + Number(count || 0);
    }
  }
  const state = insufficient
    ? "insufficient_scope"
      : debt > 0 ? "failed_new_provenance_debt" : "passed_no_new_provenance_debt";
  return {
    state,
    baseline_recorded_at: request.provenanceBaseline.recorded_at,
    comparison: "durable_recorded_at_strictly_after_baseline",
    gate_scope: "requested_sections_with_available_record_registry",
    count_unit: "section_provenance_record_occurrences_may_overlap",
    sections_evaluated: evaluated,
    sections_excluded_as_unavailable: excluded,
    scope_reason_codes: excluded.length
      ? ["requested_sections_unavailable"]
      : [],
    new_records: newRecords,
    new_records_with_provenance_debt: debt,
    unclassifiable_recorded_at: unclassifiable,
    debt_reason_codes: debtReasonCodes,
    covers_all_evaluated_matching_records: !insufficient,
    real_world_completeness: "not_proven",
  };
}

function ownerMappingConfirmation(row, fieldValues, {
  unavailableFields = [],
  fieldEvidence = {},
  fieldResolution = {},
  fieldConflicts = {},
} = {}) {
  const unavailable = new Set(unavailableFields);
  const fields = Object.keys(fieldValues);
  const evidenceFor = (field) => fieldEvidence[field] || row;
  const hasResolution = (field) => Object.hasOwn(fieldResolution, field);
  const isResolved = (field) => !hasResolution(field) || fieldResolution[field] === true;
  const hasConflict = (field) => fieldConflicts[field] === true;
  // `owner_stated` is a claim about the stored provenance, not an actor
  // receipt. The current schema does not retain a signed/session-bound owner
  // confirmation ceremony for these mappings, so it must never be promoted to
  // an authoritative owner-confirmed state. An agent can write the same tuple.
  const hasValue = (field) => fieldValues[field] !== null && fieldValues[field] !== undefined &&
    fieldValues[field] !== "" && fieldValues[field] !== false;
  const isStoredOwnerAssertion = (field) => {
    const evidence = evidenceFor(field);
    return hasValue(field) && isResolved(field) && !hasConflict(field) &&
      evidence?.provenance === "owner_stated" &&
      evidence?.basis_state === "confirmed";
  };
  const storedOwnerAssertionFields = fields.filter((field) =>
    isStoredOwnerAssertion(field) && !unavailable.has(field) && hasValue(field));
  const missing = fields.flatMap((field) => {
    if (unavailable.has(field)) return [`${field}_unavailable`];
    if (!hasValue(field)) return [`${field}_stored_value_missing`];
    if (!isResolved(field)) return [`${field}_reference_unresolved`];
    if (hasConflict(field)) return [`${field}_mapping_conflict`];
    return [`${field}_current_owner_confirmation`];
  });
  const fieldStates = Object.fromEntries(fields.map((field) => {
    let state = "not_owner_confirmed";
    if (unavailable.has(field)) state = "unavailable";
    else if (!hasValue(field)) state = "stored_value_missing";
    else if (!isResolved(field)) state = "stored_reference_unresolved";
    else if (hasConflict(field)) state = "stored_mapping_conflict";
    else if (isStoredOwnerAssertion(field)) state = "stored_owner_assertion_unconfirmed";
    return [field, state];
  }));
  const fieldBasis = Object.fromEntries(fields.map((field) => {
    const evidence = evidenceFor(field);
    return [field, {
      provenance: evidence?.provenance || null,
      basis_state: evidence?.basis_state || null,
      stored_owner_assertion: isStoredOwnerAssertion(field),
      owner_actor_receipt_present: false,
      ...(hasResolution(field) ? { reference_present: fieldResolution[field] === true } : {}),
      ...(Object.hasOwn(fieldConflicts, field) ? { mapping_conflict: hasConflict(field) } : {}),
      ...(evidence?.stored_field ? { stored_field: evidence.stored_field } : {}),
    }];
  }));
  return {
    state: storedOwnerAssertionFields.length
      ? "stored_owner_assertions_unconfirmed"
      : "current_owner_confirmation_required",
    confirmed_by_owner: null,
    field_states: fieldStates,
    field_basis: fieldBasis,
    confirmed_fields: [],
    stored_owner_assertion_fields: storedOwnerAssertionFields,
    missing_fields: missing,
    reason_codes: [
      ...(missing.some((field) => field.endsWith("_stored_value_missing"))
        ? ["stored_mapping_value_missing"] : []),
      ...(missing.some((field) => field.endsWith("_unavailable"))
        ? ["mapping_field_unavailable_in_schema"] : []),
      ...(missing.some((field) => field.endsWith("_current_owner_confirmation"))
        ? ["current_owner_confirmation_required", "owner_actor_receipt_unavailable"] : []),
      ...(missing.some((field) => field.endsWith("_reference_unresolved"))
        ? ["stored_mapping_reference_unresolved"] : []),
      ...(missing.some((field) => field.endsWith("_mapping_conflict"))
        ? ["stored_entity_account_mapping_conflict"] : []),
    ],
  };
}

function mappingVerificationGaps(mapping) {
  return Array.isArray(mapping?.missing_fields) ? mapping.missing_fields : [];
}

function materialEntityFields(values, confirmation) {
  return Object.fromEntries(Object.entries(values).map(([field, storedValue]) => [field, {
    stored_value: storedValue === undefined ? null : storedValue,
    confirmation_state: confirmation.field_states[field],
    confirmed_by_owner: null,
    owner_actor_receipt_present: false,
    stored_owner_assertion: confirmation.field_basis[field]?.stored_owner_assertion === true,
    provenance: confirmation.field_basis[field]?.provenance || null,
    basis_state: confirmation.field_basis[field]?.basis_state || null,
    missing_fields: confirmation.missing_fields.filter((item) => item.startsWith(`${field}_`)),
  }]));
}

async function entityRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  const storedOwnerAssertion = row.relationship === "owned" &&
    row.provenance === "owner_stated" && row.basis_state === "confirmed";
  const counterparty = row.relationship === "counterparty";
  const scopeState = counterparty
    ? "stored_counterparty_assertion_unconfirmed"
    : storedOwnerAssertion ? "stored_owner_assertion_unconfirmed" : "possible_mention";
  const sourceLineage = provenanceRecord(row);
  const materialValues = {
    kind: row.kind || null,
    status: row.status || null,
    holds: row.holds || null,
    ownership_basis_points: Number.isInteger(row.ownership_bp) ? row.ownership_bp : null,
    tax_class: row.tax_class || null,
    relationship: row.relationship || null,
  };
  const materialConfirmation = ownerMappingConfirmation(row, materialValues);
  const parentMapping = row.parent_entity_slug ? ownerMappingConfirmation(
    row,
    { parent_entity: row.parent_entity_slug },
    { fieldResolution: { parent_entity: Boolean(row.parent_entity_reference_present) } },
  ) : null;
  return {
    entity_ref: await references.ref("entity", row.entity_slug),
    stored_name: { legal_name: row.legal_name, display_label: row.display_label || null },
    material_fields: materialEntityFields(materialValues, materialConfirmation),
    scope_state: scopeState,
    ownership_confirmed: null,
    parent_entity_ref: row.parent_entity_slug
      ? await references.ref("entity", row.parent_entity_slug)
      : null,
    parent_entity_reference_state: row.parent_entity_slug
      ? row.parent_entity_reference_present ? "current_entity_resolved" : "unresolved"
      : "not_applicable",
    parent_mapping_confirmation: parentMapping,
    scope_confirmation: {
      state: scopeState,
      ownership_confirmed: null,
      relationship_confirmed_by_owner: null,
      relationship_confirmation_state: materialConfirmation.field_states.relationship,
      stored_owner_assertion: storedOwnerAssertion,
      owner_actor_receipt_present: false,
      missing_fields: materialConfirmation.missing_fields.filter(
        (field) => field.startsWith("relationship_"),
      ),
      reason_codes: ["current_owner_confirmation_required", "owner_actor_receipt_unavailable"],
    },
    source_lineage: sourceLineage,
    entity_mapping_basis: sourceLineage,
    verification: verificationRecord(row, {
      documentEvidenceExpected: row.provenance === "extracted",
      extraMissingFields: [
        ...mappingVerificationGaps(materialConfirmation),
        ...mappingVerificationGaps(parentMapping),
      ],
      extraBlockingReasons: [
        "entity_scope_not_owner_confirmed",
        ...(parentMapping?.missing_fields.length ? ["parent_entity_mapping_incomplete"] : []),
      ],
    }),
  };
}

async function periodRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  const sourceLineage = provenanceRecord(row);
  const accountDependent = ["account_coverage", "statement_period"].includes(row.period_kind);
  const hasAccountMapping = Boolean(row.account_slug);
  const indirectCoverage = row.period_kind === "account_coverage" && row.evidence_kind === "indirect";
  const fieldValues = {
    entity: row.entity_slug,
    period: Boolean(row.tax_year || row.period_start || row.period_end),
    ...(hasAccountMapping ? { account: row.account_slug } : {}),
    ...(indirectCoverage ? { covered_via_account: row.covered_via_account_slug } : {}),
  };
  const mapping = ownerMappingConfirmation(row, fieldValues, {
    fieldEvidence: {
      entity: {
        provenance: row.entity_mapping_provenance,
        basis_state: row.entity_mapping_basis_state,
      },
      period: row,
      ...(hasAccountMapping ? { account: row } : {}),
      ...(indirectCoverage ? { covered_via_account: row } : {}),
    },
    fieldResolution: {
      entity: Boolean(row.entity_reference_present),
      ...(hasAccountMapping ? { account: Boolean(row.account_reference_present) } : {}),
      ...(indirectCoverage
        ? { covered_via_account: Boolean(row.covered_via_account_reference_present) }
        : {}),
    },
    fieldConflicts: hasAccountMapping ? {
      account: row.entity_account_mapping_consistent === 0,
    } : {},
  });
  const accountReferenceUnresolved = hasAccountMapping && !Boolean(row.account_reference_present);
  const coveredViaReferenceUnresolved = indirectCoverage &&
    !Boolean(row.covered_via_account_reference_present);
  const mappingGaps = mappingVerificationGaps(mapping);
  return {
    period_ref: await references.ref("period", [
      row.origin_ref, row.entity_slug, row.account_slug, row.period_kind, row.tax_year,
      row.period_start, row.period_end, row.evidence_kind,
    ].join(":")),
    entity_ref: row.entity_slug ? await references.ref("entity", row.entity_slug) : null,
    account_ref: row.account_slug ? await references.ref("acct", row.account_slug) : null,
    account_reference_state: hasAccountMapping
      ? accountReferenceUnresolved ? "unresolved" : "current_account_resolved"
      : "not_applicable",
    entity_reference_state: row.entity_slug
      ? row.entity_reference_present ? "current_entity_resolved" : "unresolved"
      : "stored_value_missing",
    entity_account_mapping_state: !hasAccountMapping || !row.entity_slug
      ? "not_applicable"
      : row.entity_account_mapping_consistent === null ||
          row.entity_account_mapping_consistent === undefined
        ? "unavailable_due_to_unresolved_reference"
        : Boolean(row.entity_account_mapping_consistent) ? "consistent" : "conflict",
    covered_via_account_ref: row.covered_via_account_slug
      ? await references.ref("acct", row.covered_via_account_slug)
      : null,
    covered_via_account_reference_state: indirectCoverage
      ? coveredViaReferenceUnresolved ? "unresolved" : "current_account_resolved"
      : "not_applicable",
    period_kind: row.period_kind,
    tax_year: row.tax_year === null ? null : Number(row.tax_year),
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    evidence_kind: row.evidence_kind || null,
    mapping_confirmation: mapping,
    source_lineage: sourceLineage,
    entity_period_mapping_basis: mapping.field_basis,
    verification: verificationRecord(row, {
      documentEvidenceExpected: row.provenance === "extracted",
      extraMissingFields: mappingGaps,
      extraBlockingReasons: [
        ...(mapping.missing_fields.length ? ["mapping_confirmation_incomplete"] : []),
        ...(accountReferenceUnresolved ? ["account_reference_unresolved"] : []),
        ...(coveredViaReferenceUnresolved ? ["covered_via_account_reference_unresolved"] : []),
      ],
    }),
  };
}

async function accountRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  const category = categoryFor(row.account_kind);
  const institution = safeInstitution(row.institution);
  const ending = row.mask ? `ending ${String(row.mask).slice(-4).padStart(4, "X")}` : "ending unknown";
  const sourceLineage = provenanceRecord(row);
  let coverageRow = row.coverage_status ? {
    provenance: row.coverage_provenance,
    source_doc_uid: row.coverage_source_doc_uid,
    source_locator: row.coverage_source_locator,
    source_feed: row.coverage_source_feed,
    source_kind: row.coverage_source_kind,
    linked_corpus_source: row.coverage_linked_corpus_source,
    linked_corpus_source_kind: row.coverage_linked_corpus_source_kind,
    source_reference_present: row.coverage_source_reference_present,
    basis_state: row.coverage_basis_state,
    unparsed_reason: row.coverage_unparsed_reason,
    recorded_at: row.coverage_recorded_at,
    readable: row.coverage_readable,
    corpus_document_present: row.coverage_corpus_document_present,
    text_source: row.coverage_text_source,
    text_reliable: row.coverage_text_reliable,
    corpus_provenance_json: row.coverage_corpus_provenance_json,
    corpus_ingested_at_ms: row.coverage_corpus_ingested_at_ms,
    source_status: row.coverage_source_status,
    source_last_ingest_at: row.coverage_source_last_ingest_at,
    source_coverage_json: row.coverage_source_coverage_json,
    expected_cadence: row.expected_cadence,
  } : null;
  if (coverageRow) coverageRow = await prepareFinancialRow(coverageRow, references);
  const coverageLineage = coverageRow ? provenanceRecord(coverageRow) : null;
  const coverageMapping = coverageRow ? ownerMappingConfirmation(coverageRow, {
    account: row.account_slug,
    entity: row.entity_slug,
    period: Boolean(row.period_start || row.period_end),
    ...(row.coverage_status === "indirect"
      ? { covered_via_account: row.covered_via_account_slug }
      : {}),
  }, {
    fieldEvidence: {
      account: coverageRow,
      entity: row,
      period: coverageRow,
      ...(row.coverage_status === "indirect" ? { covered_via_account: coverageRow } : {}),
    },
    fieldResolution: {
      account: true,
      entity: Boolean(row.entity_reference_present),
      ...(row.coverage_status === "indirect"
        ? { covered_via_account: Boolean(row.covered_via_account_reference_present) }
        : {}),
    },
  }) : null;
  const mapping = ownerMappingConfirmation(row, {
    account: row.account_slug,
    entity: row.entity_slug,
  }, { fieldResolution: { entity: Boolean(row.entity_reference_present) } });
  return {
    account_ref: await references.ref("acct", row.account_slug),
    masked_identity: [institution || "financial account", category, ending].join(" · "),
    institution,
    category,
    stored_account_kind: row.account_kind,
    entity_ref: await references.ref("entity", row.entity_slug),
    entity_reference_state: row.entity_reference_present
      ? "current_entity_resolved"
      : "unresolved",
    balance_role: row.balance_role,
    currency: row.currency,
    feed_mode: row.feed_mode,
    expected_cadence: row.expected_cadence || null,
    status: row.status,
    opened_on: row.opened_on || null,
    closed_on: row.closed_on || null,
    coverage: row.coverage_status ? {
      status: row.coverage_status,
      covered_from: row.period_start || null,
      covered_to: row.period_end || null,
      covered_via_account_ref: row.covered_via_account_slug
        ? await references.ref("acct", row.covered_via_account_slug)
        : null,
      covered_via_account_reference_state: row.coverage_status === "indirect"
        ? row.covered_via_account_reference_present
          ? "current_account_resolved"
          : "unresolved"
        : "not_applicable",
      computed_at: row.coverage_computed_at || null,
      mapping_confirmation: coverageMapping,
      source_lineage: coverageLineage,
      verification: verificationRecord(coverageRow, {
        documentEvidenceExpected: coverageRow.provenance === "extracted",
        extraMissingFields: mappingVerificationGaps(coverageMapping),
        extraBlockingReasons: coverageMapping.missing_fields.length
          ? ["mapping_confirmation_incomplete"]
          : [],
      }),
    } : null,
    mapping_confirmation: mapping,
    source_lineage: sourceLineage,
    account_entity_mapping_basis: mapping.field_basis,
    verification: verificationRecord(row, {
      documentEvidenceExpected: row.provenance === "extracted",
      extraMissingFields: [
        ...(row.coverage_status ? [] : ["account_coverage_period"]),
        ...mappingVerificationGaps(mapping),
      ],
      extraBlockingReasons: [
        ...(row.coverage_status ? [] : ["account_coverage_unassessed"]),
        ...(mapping.missing_fields.length ? ["mapping_confirmation_incomplete"] : []),
      ],
    }),
  };
}

async function bookRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  const qboFingerprint = HEX_64.test(String(row.qbo_fingerprint || ""))
    ? String(row.qbo_fingerprint)
    : null;
  const mapping = ownerMappingConfirmation(row, {
    books_company: qboFingerprint,
    entity: row.entity_slug,
    period: Boolean(row.tax_year || row.period_start || row.period_end),
    ...(row.account_slug ? { account: row.account_slug } : {}),
  }, {
    fieldEvidence: {
      books_company: {
        provenance: null,
        basis_state: null,
        stored_field: "documents.meta.qbo_company_fingerprint",
      },
      entity: row,
      period: row,
      ...(row.account_slug ? { account: row } : {}),
    },
    fieldResolution: {
      entity: Boolean(row.entity_reference_present),
      ...(row.account_slug ? { account: Boolean(row.account_reference_present) } : {}),
    },
    fieldConflicts: row.account_slug ? {
      account: row.entity_account_mapping_consistent === 0,
    } : {},
  });
  const verification = verificationRecord(row, {
    documentEvidenceExpected: true,
    extraMissingFields: [
      ...(row.entity_slug ? [] : ["entity_mapping"]),
      ...(qboFingerprint ? [] : ["quickbooks_company_fingerprint"]),
      ...mappingVerificationGaps(mapping),
    ],
    extraBlockingReasons: [
      ...(row.entity_slug ? [] : ["books_entity_mapping_unavailable"]),
      ...(mapping.missing_fields.length ? ["mapping_confirmation_incomplete"] : []),
    ],
  });
  const sourceLineage = provenanceRecord(row);
  return {
    books_ref: await references.ref("books", row.internal_key),
    record_type: row.record_type,
    system_identity: qboFingerprint ? {
      kind: "quickbooks_company_reference",
      ref: await references.ref("quickbooks_company", qboFingerprint),
    } : null,
    entity_ref: row.entity_slug ? await references.ref("entity", row.entity_slug) : null,
    entity_reference_state: row.entity_slug
      ? row.entity_reference_present ? "current_entity_resolved" : "unresolved"
      : "stored_value_missing",
    account_ref: row.account_slug ? await references.ref("acct", row.account_slug) : null,
    account_reference_state: row.account_slug
      ? row.account_reference_present ? "current_account_resolved" : "unresolved"
      : "not_applicable",
    entity_account_mapping_state: !row.entity_slug || !row.account_slug
      ? "not_applicable"
      : row.entity_account_mapping_consistent === null ||
          row.entity_account_mapping_consistent === undefined
        ? "unavailable_due_to_unresolved_reference"
        : Boolean(row.entity_account_mapping_consistent) ? "consistent" : "conflict",
    document_kind: row.doc_kind || null,
    tax_year: row.tax_year === null ? null : Number(row.tax_year),
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    evidence_count: Number(row.evidence_count || 0),
    observed_record_from: row.first_evidence_date || null,
    observed_record_to: row.last_evidence_date || null,
    last_ingested_at_ms: row.last_ingested_at_ms === null ? null : Number(row.last_ingested_at_ms),
    extraction_group_evidence: {
      evidence_records: Number(row.evidence_count || 0),
      provenance_assessed_records: Number(row.stored_provenance_assessment?.group_assessed || 0),
      provenance_unassessed_records: Math.max(
        0,
        Number(row.stored_provenance_assessment?.group_total || row.evidence_count || 0) -
          Number(row.stored_provenance_assessment?.group_assessed || 0),
      ),
      missing_text_source: Number(
        row.stored_provenance_assessment?.group_missing_text_source || 0,
      ),
      missing_text_reliable: Number(
        row.stored_provenance_assessment?.group_missing_text_reliable || 0,
      ),
    },
    mapping_confirmation: mapping,
    source_lineage: sourceLineage,
    source_provenance: {
      ...publicLineageReferences(sourceLineage),
      source_status: row.source_status || null,
      source_last_ingest_at: row.source_last_ingest_at || null,
      provenance: row.provenance,
      basis_state: row.basis_state,
      unparsed_reason: row.unparsed_reason || null,
      provenance_state: sourceLineage.state,
      provenance_status_code: sourceLineage.status_code,
      provenance_reason_codes: sourceLineage.reason_codes,
      availability: row.availability || null,
      readable: row.readable === null ? null : Boolean(row.readable),
      restricted: row.restricted === null ? null : Boolean(row.restricted),
      recorded_at: row.recorded_at || null,
    },
    verification,
  };
}

async function taxRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  const sourceLineage = provenanceRecord(row);
  const mapping = ownerMappingConfirmation(
    row,
    {
      entity: row.entity_slug,
      tax_period: Boolean(row.tax_year || row.period_start || row.period_end),
      tax_role: null,
      ...(row.account_slug ? { account: row.account_slug } : {}),
    },
    {
      unavailableFields: ["tax_role"],
      fieldResolution: {
        entity: Boolean(row.entity_reference_present),
        ...(row.account_slug ? { account: Boolean(row.account_reference_present) } : {}),
      },
      fieldConflicts: row.account_slug ? {
        account: row.entity_account_mapping_consistent === 0,
      } : {},
    },
  );
  return {
    evidence_ref: await references.ref("tax", row.internal_id),
    entity_ref: row.entity_slug ? await references.ref("entity", row.entity_slug) : null,
    entity_reference_state: row.entity_slug
      ? row.entity_reference_present ? "current_entity_resolved" : "unresolved"
      : "stored_value_missing",
    account_ref: row.account_slug ? await references.ref("acct", row.account_slug) : null,
    account_reference_state: row.account_slug
      ? row.account_reference_present ? "current_account_resolved" : "unresolved"
      : "not_applicable",
    entity_account_mapping_state: !row.entity_slug || !row.account_slug
      ? "not_applicable"
      : row.entity_account_mapping_consistent === null ||
          row.entity_account_mapping_consistent === undefined
        ? "unavailable_due_to_unresolved_reference"
        : Boolean(row.entity_account_mapping_consistent) ? "consistent" : "conflict",
    evidence_kind: row.doc_kind,
    tax_year: row.tax_year === null ? null : Number(row.tax_year),
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    tax_form: null,
    k1_issuer_or_recipient_role: null,
    custody: {
      class: row.custody_class,
      availability: row.availability,
      filed_at: row.filed_at || null,
      received_from: row.received_from || null,
      received_at: row.received_at || null,
      readable: Boolean(row.readable),
      restricted: Boolean(row.restricted),
    },
    mapping_confirmation: mapping,
    source_lineage: sourceLineage,
    entity_tax_period_mapping_basis: sourceLineage,
    verification: verificationRecord(row, {
      documentEvidenceExpected: true,
      extraMissingFields: [
        "tax_form",
        ...(row.doc_kind === "k1" ? ["k1_issuer_or_recipient_role"] : []),
        ...(row.entity_slug ? [] : ["entity_mapping"]),
        ...(row.tax_year === null ? ["tax_year"] : []),
        ...mappingVerificationGaps(mapping),
      ],
      extraBlockingReasons: [
        "tax_classification_incomplete",
        ...(mapping.missing_fields.length ? ["mapping_confirmation_incomplete"] : []),
      ],
    }),
  };
}

async function filingRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  const sourceLineage = provenanceRecord(row);
  const mapping = ownerMappingConfirmation(
    row,
    {
      entity: row.entity_slug,
      tax_period: Boolean(row.tax_year || row.period_start || row.period_end),
      filing_or_payment_role: null,
      ...(row.account_slug ? { account: row.account_slug } : {}),
    },
    {
      unavailableFields: ["filing_or_payment_role"],
      fieldResolution: {
        entity: Boolean(row.entity_reference_present),
        ...(row.account_slug ? { account: Boolean(row.account_reference_present) } : {}),
      },
      fieldConflicts: row.account_slug ? {
        account: row.entity_account_mapping_consistent === 0,
      } : {},
    },
  );
  return {
    evidence_ref: await references.ref("filing", row.internal_id),
    entity_ref: row.entity_slug ? await references.ref("entity", row.entity_slug) : null,
    entity_reference_state: row.entity_slug
      ? row.entity_reference_present ? "current_entity_resolved" : "unresolved"
      : "stored_value_missing",
    account_ref: row.account_slug ? await references.ref("acct", row.account_slug) : null,
    account_reference_state: row.account_slug
      ? row.account_reference_present ? "current_account_resolved" : "unresolved"
      : "not_applicable",
    entity_account_mapping_state: !row.entity_slug || !row.account_slug
      ? "not_applicable"
      : row.entity_account_mapping_consistent === null ||
          row.entity_account_mapping_consistent === undefined
        ? "unavailable_due_to_unresolved_reference"
        : Boolean(row.entity_account_mapping_consistent) ? "consistent" : "conflict",
    evidence_kind: row.evidence_kind,
    tax_year: row.tax_year === null ? null : Number(row.tax_year),
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    custody: {
      class: row.custody_class,
      availability: row.availability,
      filed_at: row.filed_at || null,
      received_from: row.received_from || null,
      received_at: row.received_at || null,
      readable: Boolean(row.readable),
      restricted: Boolean(row.restricted),
    },
    mapping_confirmation: mapping,
    source_lineage: sourceLineage,
    entity_tax_period_mapping_basis: sourceLineage,
    verification: verificationRecord(row, {
      documentEvidenceExpected: true,
      extraMissingFields: [
        "tax_authority_acceptance",
        "payment_settlement_confirmation",
        ...(row.entity_slug ? [] : ["entity_mapping"]),
        ...(row.tax_year === null ? ["tax_year"] : []),
        ...mappingVerificationGaps(mapping),
      ],
      extraBlockingReasons: [
        "filing_or_payment_confirmation_unavailable",
        ...(mapping.missing_fields.length ? ["mapping_confirmation_incomplete"] : []),
      ],
    }),
  };
}

async function evidenceRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  const sourceLineage = provenanceRecord(row);
  const supersessionClaimed = row.superseded_by_id !== null && row.superseded_by_id !== undefined;
  const supersessionResolved = supersessionClaimed && Boolean(row.superseded_by_reference_present);
  const supersededByStoredRef = supersessionClaimed
    ? await references.ref("evidence", row.superseded_by_id)
    : null;
  const mapping = ownerMappingConfirmation(row, {
    entity: row.entity_slug,
    period: Boolean(row.tax_year || row.period_start || row.period_end),
    evidence_role: row.evidence_kind,
    ...(row.account_slug ? { account: row.account_slug } : {}),
  }, {
    fieldResolution: {
      entity: Boolean(row.entity_reference_present),
      ...(row.account_slug ? { account: Boolean(row.account_reference_present) } : {}),
    },
    fieldConflicts: row.account_slug ? {
      account: row.entity_account_mapping_consistent === 0,
    } : {},
  });
  return {
    evidence_ref: await references.ref("evidence", row.internal_id),
    current_state: !supersessionClaimed
      ? "current"
      : supersessionResolved ? "superseded" : "supersession_unresolved",
    superseded_by_ref: supersessionResolved ? supersededByStoredRef : null,
    supersession: {
      claimed: supersessionClaimed,
      stored_target_ref: supersededByStoredRef,
      reference_state: !supersessionClaimed
        ? "not_applicable"
        : supersessionResolved
          ? "resolved_same_tenant_stable_key"
          : "unresolved_or_mismatched",
      missing_fields: supersessionClaimed && !supersessionResolved
        ? ["superseded_by_reference_resolution"]
        : [],
    },
    entity_ref: row.entity_slug ? await references.ref("entity", row.entity_slug) : null,
    entity_reference_state: row.entity_slug
      ? row.entity_reference_present ? "current_entity_resolved" : "unresolved"
      : "stored_value_missing",
    account_ref: row.account_slug ? await references.ref("acct", row.account_slug) : null,
    account_reference_state: row.account_slug
      ? row.account_reference_present ? "current_account_resolved" : "unresolved"
      : "not_applicable",
    entity_account_mapping_state: !row.entity_slug || !row.account_slug
      ? "not_applicable"
      : row.entity_account_mapping_consistent === null ||
          row.entity_account_mapping_consistent === undefined
        ? "unavailable_due_to_unresolved_reference"
        : Boolean(row.entity_account_mapping_consistent) ? "consistent" : "conflict",
    evidence_kind: row.evidence_kind,
    tax_year: row.tax_year === null ? null : Number(row.tax_year),
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    custody: {
      class: row.custody_class,
      availability: row.availability,
      available_from: row.available_from || null,
      available_within_days: row.available_within_days === null ? null : Number(row.available_within_days),
      filed_at: row.filed_at || null,
      reconciled_through: row.reconciled_through || null,
      received_from: row.received_from || null,
      received_at: row.received_at || null,
      readable: Boolean(row.readable),
      unreadable_reason_present: Boolean(row.has_unreadable_reason),
      restricted: Boolean(row.restricted),
    },
    mapping_confirmation: mapping,
    source_lineage: sourceLineage,
    provenance: {
      state: sourceLineage.state,
      status_code: sourceLineage.status_code,
      reason_codes: sourceLineage.reason_codes,
      kind: row.provenance,
      basis_state: row.basis_state,
      unparsed_reason: row.unparsed_reason || null,
      confidence_basis_points: Number.isInteger(row.confidence_bp) ? row.confidence_bp : null,
      ...publicLineageReferences(sourceLineage),
      corpus_document_present: Boolean(row.corpus_document_present),
      recorded_at: row.recorded_at,
      supersession_claimed: sourceLineage.supersession_claimed,
      superseded_by_reference_present: sourceLineage.superseded_by_reference_present,
      corpus_ingested_at_ms: row.corpus_ingested_at_ms === null ? null : Number(row.corpus_ingested_at_ms),
      source_status: row.source_status || null,
      source_last_ingest_at: row.source_last_ingest_at || null,
    },
    verification: verificationRecord(row, {
      documentEvidenceExpected: true,
      extraMissingFields: mappingVerificationGaps(mapping),
      extraBlockingReasons: mapping.missing_fields.length ? ["mapping_confirmation_incomplete"] : [],
    }),
  };
}

async function conflictRecord(row, references) {
  row = await prepareFinancialRow(row, references);
  let rawRoots = [];
  try {
    const parsed = JSON.parse(row.derivation_roots_json || "[]");
    if (Array.isArray(parsed)) rawRoots = parsed;
  } catch { /* explicit empty roots below */ }
  const rootsTotal = Number.isSafeInteger(Number(row.derivation_roots_total))
    ? Number(row.derivation_roots_total)
    : rawRoots.length;
  const rootsTruncated = rootsTotal > MAX_DERIVATION_ROOTS || rawRoots.length > MAX_DERIVATION_ROOTS;
  const roots = await Promise.all(rawRoots.slice(0, MAX_DERIVATION_ROOTS).map(async (root) => {
    root = await prepareFinancialRow(root, references);
    const provenance = provenanceRecord(root);
    const verification = verificationRecord(root, {
      documentEvidenceExpected: root.provenance === "extracted",
    });
    return {
      claim_ref: await references.ref("claim", root.claim_uid),
      claim_target_kind: root.claim_ref_table
        ? PUBLIC_CLAIM_TARGET_KINDS[root.claim_ref_table] || "unsupported"
        : null,
      claim_record_ref: root.claim_ref_uid
        ? await references.ref("claim_record", `${root.claim_ref_table || "unknown"}:${root.claim_ref_uid}`)
        : null,
      claim_record_reference_state: root.claim_record_reference_state || "unavailable",
      provenance: root.provenance || null,
      provenance_state: provenance.state,
      provenance_status_code: provenance.status_code,
      provenance_reason_codes: provenance.reason_codes,
      missing_provenance_fields: provenance.missing_fields,
      ...publicLineageReferences(provenance),
      basis_state: root.basis_state || null,
      recorded_at: root.recorded_at || null,
      freshness: freshnessRecord(root),
      verification,
    };
  }));
  const rowWithRootState = { ...row, derivation_roots_truncated: rootsTruncated };
  const sourceLineage = provenanceRecord(rowWithRootState, roots);
  const mapping = ownerMappingConfirmation(row, {
    entity: row.entity_slug,
    account: row.account_slug,
    period: Boolean(row.tax_year || row.period_start || row.period_end),
  }, {
    fieldResolution: {
      entity: row.entity_slug ? Boolean(row.entity_reference_present) : true,
      account: row.account_slug ? Boolean(row.account_reference_present) : true,
    },
    fieldConflicts: row.account_slug ? {
      account: row.entity_account_mapping_consistent === 0,
    } : {},
  });
  return {
    conflict_ref: await references.ref("conflict", `${row.conflict_type}:${row.internal_key}`),
    conflict_type: row.conflict_type,
    conflict_state: row.conflict_state,
    conflict_kind: row.conflict_kind,
    entity_ref: row.entity_slug ? await references.ref("entity", row.entity_slug) : null,
    entity_reference_state: row.entity_slug
      ? row.entity_reference_present ? "current_entity_resolved" : "unresolved"
      : "not_applicable",
    account_ref: row.account_slug ? await references.ref("acct", row.account_slug) : null,
    account_reference_state: row.account_slug
      ? row.account_reference_present ? "current_account_resolved" : "unresolved"
      : "not_applicable",
    entity_account_mapping_state: !row.entity_slug || !row.account_slug
      ? "not_applicable"
      : row.entity_account_mapping_consistent === null ||
          row.entity_account_mapping_consistent === undefined
        ? "unavailable_due_to_unresolved_reference"
        : Boolean(row.entity_account_mapping_consistent) ? "consistent" : "conflict",
    transaction_reference_state: row.transaction_reference_state || "not_applicable",
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    observed_at: row.observed_at,
    mapping_confirmation: mapping,
    source_lineage: sourceLineage,
    conflict_derivation_basis: sourceLineage,
    derivation_root_page: {
      total: rootsTotal,
      returned: roots.length,
      truncated: rootsTruncated,
      cursor: null,
      unavailable_reason: rootsTruncated
        ? `only the first ${MAX_DERIVATION_ROOTS} ordered roots are returned by this bounded inventory`
        : null,
    },
    verification: verificationRecord(rowWithRootState, {
      roots,
      documentEvidenceExpected: row.conflict_type === "exception" && row.provenance === "extracted",
      extraMissingFields: mappingVerificationGaps(mapping),
      extraBlockingReasons: mapping.missing_fields.length ? ["mapping_confirmation_incomplete"] : [],
    }),
  };
}

const SECTION_DEFINITIONS = Object.freeze({
  entities: {
    base: ENTITY_SQL,
    applicable: ["entity_slug"],
    order: "rows.entity_slug ASC, rows.internal_id ASC",
    transform: entityRecord,
    state: "partial",
    unavailableFields: [
      "filing_unit_designation", "client_vendor_employer_adviser_role",
      "k1_issuer_or_recipient_role", "rejected_source_extraction_state",
    ],
    integrityFields: ["entity_parent", "entity_supersession_target"],
  },
  periods: {
    base: PERIOD_SQL,
    applicable: FILTER_KEYS,
    order: "rows.entity_slug ASC, rows.period_start ASC, rows.period_end ASC, rows.period_kind ASC, rows.evidence_kind ASC, rows.account_slug ASC, rows.origin_ref ASC",
    transform: periodRecord,
    state: "partial",
    unavailableFields: [
      "declared_accounting_period_type", "filing_unit_period_mapping",
      "rejected_source_extraction_state",
    ],
    integrityFields: [
      "coverage_account", "statement_account", "indirect_coverage_target",
      "period_account_entity", "period_document_entity_missing",
      "period_document_entity_unresolved", "period_document_account",
      "period_document_entity_account_conflict",
      "period_close_entity", "entity_supersession_target", "account_supersession_target",
      "coverage_supersession_target", "document_supersession_target",
      "statement_supersession_target",
      "document_corpus_binding_mismatch", "document_corpus_expected_hash_missing",
      "document_corpus_hash_missing", "document_corpus_reference_missing",
      "document_source_lineage_unresolved",
    ],
  },
  accounts: {
    base: ACCOUNT_SQL,
    applicable: ["entity_slug", "period_start", "period_end"],
    order: "rows.entity_slug ASC, rows.account_slug ASC, rows.internal_id ASC",
    transform: accountRecord,
    state: "available",
    unavailableFields: [],
    integrityFields: [
      "account_entity", "coverage_account", "statement_account", "indirect_coverage_target",
      "entity_supersession_target", "account_supersession_target",
      "coverage_supersession_target", "document_supersession_target",
      "statement_supersession_target",
    ],
  },
  books: {
    base: BOOK_SQL,
    applicable: FILTER_KEYS,
    order: "rows.entity_slug ASC, rows.record_type ASC, rows.internal_key ASC",
    transform: bookRecord,
    state: "partial",
    unavailableFields: [
      "current_quickbooks_connection_state", "company_applicability",
      "accounting_period_completeness", "scan_only_or_empty_rejected_document_inventory",
    ],
    integrityFields: [
      "books_document_entity", "books_document_account", "qbo_document_entity",
      "books_document_entity_account_conflict",
      "entity_supersession_target", "account_supersession_target",
      "document_supersession_target",
      "document_corpus_binding_mismatch", "document_corpus_expected_hash_missing",
      "document_corpus_hash_missing", "document_corpus_reference_missing",
      "document_source_lineage_unresolved",
    ],
  },
  payroll: null,
  tax_returns: {
    base: TAX_SQL,
    applicable: FILTER_KEYS,
    order: "rows.entity_slug ASC, rows.tax_year ASC, rows.doc_kind ASC, rows.internal_id ASC",
    transform: taxRecord,
    state: "partial",
    unavailableFields: [
      "tax_form", "k1_issuer_or_recipient_role", "filing_unit_designation",
      "scan_only_or_empty_rejected_document_inventory",
    ],
    integrityFields: [
      "tax_document_entity", "tax_document_account", "entity_supersession_target",
      "tax_document_entity_account_conflict", "account_supersession_target",
      "document_supersession_target",
      "document_corpus_binding_mismatch", "document_corpus_expected_hash_missing",
      "document_corpus_hash_missing", "document_corpus_reference_missing",
      "document_source_lineage_unresolved",
    ],
  },
  filing_payments: {
    base: FILING_SQL,
    applicable: FILTER_KEYS,
    order: "rows.entity_slug ASC, rows.tax_year ASC, rows.evidence_kind ASC, rows.internal_id ASC",
    transform: filingRecord,
    state: "partial",
    unavailableFields: [
      "tax_authority_acceptance", "payment_settlement_confirmation",
      "scan_only_or_empty_rejected_document_inventory",
    ],
    integrityFields: [
      "filing_document_entity", "filing_document_account", "entity_supersession_target",
      "filing_document_entity_account_conflict", "account_supersession_target",
      "document_supersession_target",
      "document_corpus_binding_mismatch", "document_corpus_expected_hash_missing",
      "document_corpus_hash_missing", "document_corpus_reference_missing",
      "document_source_lineage_unresolved",
    ],
  },
  evidence: {
    base: EVIDENCE_SQL,
    applicable: FILTER_KEYS,
    order: "rows.entity_slug ASC, rows.recorded_at ASC, rows.internal_id ASC",
    transform: evidenceRecord,
    state: "partial",
    unavailableFields: ["scan_only_or_empty_rejected_document_inventory"],
    integrityFields: [
      "evidence_document_entity", "evidence_document_account", "entity_supersession_target",
      "evidence_document_entity_account_conflict", "account_supersession_target",
      "document_supersession_target",
      "document_corpus_binding_mismatch", "document_corpus_expected_hash_missing",
      "document_corpus_hash_missing", "document_corpus_reference_missing",
      "document_source_lineage_unresolved",
    ],
  },
  conflicts: {
    base: CONFLICT_SQL,
    applicable: ["entity_slug", "period_start", "period_end"],
    order: "rows.entity_slug ASC, rows.period_start ASC, rows.conflict_type ASC, rows.internal_key ASC",
    transform: conflictRecord,
    state: "available",
    unavailableFields: [],
    integrityFields: [
      "reconciliation_entity", "reconciliation_account", "exception_entity", "exception_account",
      "reconciliation_entity_account_conflict", "exception_entity_account_conflict",
      "reconciliation_claim_parent", "reconciliation_claim_target",
      "reconciliation_claim_target_identifier_unavailable", "exception_transaction",
      "exception_transaction_account_conflict", "exception_transaction_entity_conflict",
      "exception_transaction_scope_unavailable",
      "entity_supersession_target", "account_supersession_target",
      "document_supersession_target", "statement_supersession_target",
      "document_corpus_binding_mismatch", "document_corpus_expected_hash_missing",
      "document_corpus_hash_missing", "document_corpus_reference_missing",
      "document_source_lineage_unresolved",
    ],
  },
});

function unavailableSection(filters, applicable, reason, unavailableFields = [], baseline = null) {
  return {
    state: "unavailable",
    unavailable: true,
    unavailable_reason: reason,
    unavailable_fields: [...unavailableFields],
    provenance_state: reason === "not_requested" ? "not_requested" : "unavailable",
    provenance_fields: [],
    verification_gap_summary: {
      count_scope: "unavailable",
      bounded_by_page_limit: true,
      covers_all_matching_records: null,
      examined: 0,
      affected: null,
      blocking: null,
      missing_fields: Object.fromEntries(unavailableFields.map((field) => [field, null])),
      by_provenance_state: {},
      by_extraction_state: {},
      by_freshness_state: {},
      provenance_debt_since_baseline: {
        state: baseline && reason !== "not_requested"
          ? "insufficient_scope"
          : "not_requested",
        baseline_recorded_at: baseline && reason !== "not_requested"
          ? baseline.recorded_at
          : null,
        count_scope: "unavailable",
        count_unit: "provenance_record_occurrences",
        covers_all_matching_records: null,
        new_records: null,
        new_records_with_provenance_debt: null,
        unclassifiable_recorded_at: null,
        debt_reason_codes: {},
      },
      recovery_mode: "planning_only_no_ocr_reingest_or_write",
    },
    blocks_financial_verification: reason === "not_requested" ? null : true,
    total: null,
    returned: 0,
    truncated: null,
    cursor: null,
    next_cursor: null,
    ...sectionFilterInfo(filters, applicable),
    real_world_completeness: "not_proven",
  };
}

function availableSection(definition, filters, total, records, offset, requestHash, baseline) {
  const truncated = offset + records.length < total;
  const gapSummary = verificationGapSummary(records, !truncated && offset === 0, baseline);
  const unavailableFields = [...new Set([
    ...definition.unavailableFields, ...FRESHNESS_UNAVAILABLE_FIELDS,
  ])];
  return {
    state: definition.state,
    unavailable: false,
    unavailable_reason: null,
    unavailable_fields: unavailableFields,
    provenance_state: "record_level",
    provenance_fields: [
      "provenance", "basis_state", "source_document_ref", "source_document_present",
      "source_document_reference_state", "source_locator_present",
      "source_locator_ref", "source_locator_state", "source_feed_ref",
      "source_feed_present", "source_feed_kind", "source_feed_kind_state",
      "source_feed_registry_state", "linked_corpus_source_ref",
      "linked_corpus_source_present", "linked_corpus_source_kind",
      "linked_corpus_source_state", "recorded_at", "unparsed_reason", "derivation_roots",
      "provenance_status_code", "provenance_reason_codes", "source_status",
      "source_last_ingest_at", "corpus_ingested_at_ms",
    ],
    verification_gap_summary: gapSummary,
    blocks_financial_verification: definition.state === "partial" || gapSummary.blocking > 0,
    total,
    returned: records.length,
    truncated,
    cursor: offset === 0 ? null : makeCursor(definition.name, offset, requestHash),
    next_cursor: truncated ? makeCursor(definition.name, offset + records.length, requestHash) : null,
    ...sectionFilterInfo(filters, definition.applicable),
    real_world_completeness: "not_proven",
    records,
  };
}

function withReferenceIntegrity(section, row, filters, fields) {
  const counts = Object.fromEntries(fields.map((field) => [field, Number(row?.[field])]));
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("D1 did not return complete stable-reference integrity counts");
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const missingFields = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([field]) => field.endsWith("_supersession_target")
      ? `${field}_resolution`
      : `${field}_resolution`);
  const supersessionOccurrences = Object.entries(counts)
    .filter(([field]) => field.endsWith("_supersession_target"))
    .reduce((sum, [, count]) => sum + count, 0);
  const unresolvedStableReferences = total - supersessionOccurrences;
  const hasIntegrityGaps = total > 0;
  section.reference_integrity = {
    state: hasIntegrityGaps ? "blocking" : "clear",
    unavailable: false,
    unavailable_reason: null,
    total,
    returned: total,
    truncated: false,
    cursor: null,
    next_cursor: null,
    count_unit: "unresolved_or_invalid_stable_reference_occurrences",
    counts,
    unresolved_current_reference_occurrences: unresolvedStableReferences,
    unresolved_or_mismatched_supersession_occurrences: supersessionOccurrences,
    filter_scope: filters.entity_slug
      ? "tenant_wide_integrity_edges_cannot_be_safely_attributed_to_exact_entity_filter"
      : "tenant_wide_integrity_edges",
    missing_fields: missingFields,
    reason_codes: [
      ...(unresolvedStableReferences > 0 ? ["unresolved_current_stable_references"] : []),
      ...(supersessionOccurrences > 0
        ? ["unresolved_or_mismatched_supersession_targets"]
        : []),
    ],
    blocks_financial_verification: hasIntegrityGaps,
  };
  if (!hasIntegrityGaps) return section;

  const summary = section.verification_gap_summary;
  summary.covers_all_matching_records = false;
  summary.scope_reason_codes = [...new Set([
    ...(summary.scope_reason_codes || []),
    ...(unresolvedStableReferences > 0 ? ["unresolved_stable_references"] : []),
    ...(supersessionOccurrences > 0 ? ["unresolved_supersession_targets"] : []),
  ])];
  summary.additional_reference_occurrences_affected = total;
  summary.blocking_reference_occurrences = total;
  for (const [field, count] of Object.entries(counts)) {
    if (count === 0) continue;
    const missingField = `${field}_resolution`;
    summary.missing_fields[missingField] =
      (summary.missing_fields[missingField] || 0) + count;
  }
  const metric = summary.provenance_debt_since_baseline;
  if (metric && metric.state !== "not_requested") {
    metric.state = "insufficient_scope";
    metric.covers_all_matching_records = false;
    metric.scope_reason_codes = [...new Set([
      ...(metric.scope_reason_codes || []),
      ...(unresolvedStableReferences > 0 ? ["unresolved_stable_references"] : []),
      ...(supersessionOccurrences > 0 ? ["unresolved_supersession_targets"] : []),
    ])];
  }
  section.blocks_financial_verification = true;
  return section;
}

function baseEnvelope(request, sections) {
  return {
    schema_version: 2,
    operation: "financial_picture.inventory",
    read_only: true,
    mutation_count: 0,
    completeness_verdict: "not_computed",
    correctness_verdict: "not_computed",
    tenant_scope: "authenticated_brain",
    filters: { ...request.filters },
    provenance_baseline: request.provenanceBaseline
      ? { ...request.provenanceBaseline }
      : null,
    sections_requested: [...request.selected],
    page_limit: request.limit,
    request_cursor: request.cursor,
    pagination_snapshot_scope: "each response is one snapshot; compare snapshot receipts before combining pages",
    reference_token_contract: {
      scheme: "hmac_sha256_v2",
      key_scope: "per_brain_session_signing_secret",
      stability: "stable_within_one_brain_until_session_signing_key_rotation",
      pagination: "stable_across_page_receipts_from_the_same_brain_key",
      identifier_values_disclosed: false,
    },
    evidence_scope: "exact structured financial ledger and linked corpus custody metadata only",
    extraction_state_contract: {
      stored_states: ["native", "ocr", "ocr_partial", "unreadable"],
      unavailable_states: ["scan_only", "empty"],
      unavailable_reason: "rejected scan-only or empty documents have no durable financial evidence row in the current schema",
    },
    freshness_state_contract: {
      verdict: "not_computed",
      available_evidence: [
        "source_status", "source_last_ingest_at", "corpus_ingested_at_ms",
        "evidence_recorded_at", "expected_cadence", "source_coverage_dimensions",
        "latest_source_run_outcome_counts", "confirmed_and_target_source_ranges",
      ],
      unavailable_fields: [...FRESHNESS_UNAVAILABLE_FIELDS],
    },
    recovery_mode: "planning_only_no_ocr_reingest_or_write",
    sections,
  };
}

async function withReceipt(envelope, {
  capturedAt,
  bookmark = null,
  consistency = "single_d1_batch",
  references = null,
}) {
  const databaseVersionRef = bookmark && references
    ? await references.ref("database_snapshot", bookmark)
    : null;
  const snapshot = {
    captured_at: capturedAt,
    as_of: capturedAt,
    consistency,
    database_version_ref: databaseVersionRef,
    database_bookmark_state: bookmark ? "available" : "unavailable",
  };
  const receiptWithoutHash = {
    ...envelope,
    snapshot,
  };
  const contentSha256 = await sha256(JSON.stringify(receiptWithoutHash));
  return {
    ...receiptWithoutHash,
    snapshot: { ...snapshot, content_sha256: contentSha256 },
  };
}

export async function unavailableFinancialPicture(body = {}, reason = "database_read_failed", options = {}) {
  const request = normalizeRequest(body);
  const sections = {};
  for (const name of FINANCIAL_PICTURE_SECTIONS) {
    const definition = SECTION_DEFINITIONS[name];
    sections[name] = unavailableSection(
      request.filters,
      definition?.applicable || FILTER_KEYS,
      reason,
      name === "payroll"
        ? PAYROLL_UNAVAILABLE_FIELDS
        : [...(definition?.unavailableFields || []), ...FRESHNESS_UNAVAILABLE_FIELDS],
      request.provenanceBaseline,
    );
  }
  const envelope = baseEnvelope(request, sections);
  envelope.unavailable = true;
  envelope.sections_unavailable = [...FINANCIAL_PICTURE_SECTIONS];
  envelope.provenance_debt_gate = aggregateProvenanceDebtGate(request, sections);
  const receipt = await withReceipt(envelope, {
    capturedAt: options.capturedAt || new Date().toISOString(),
    consistency: "unavailable",
  });
  return assertFinancialPicturePublicReceipt(receipt);
}

function resultRows(result) {
  if (!result || result.success === false || !Array.isArray(result.results)) {
    throw new Error("D1 did not return a complete result set");
  }
  return result.results;
}

/** Run one complete inventory in a single transactional D1 batch. */
export async function financialPictureInventory(env, body = {}, options = {}) {
  const request = normalizeRequest(body);
  // The receipt's as-of boundary is captured before the database read. A row
  // committed after this instant may conservatively appear as "new" on the
  // next baseline comparison, but a concurrent row can never be hidden behind
  // an as-of time captured after this snapshot finished.
  const capturedAt = options.capturedAt || new Date().toISOString();
  const receiptOptions = { ...options, capturedAt };
  let references;
  try {
    references = await referenceContext(env);
  } catch {
    return {
      status: 503,
      body: await unavailableFinancialPicture(
        body,
        "privacy_reference_signing_unavailable",
        receiptOptions,
      ),
    };
  }
  const requestHash = await references.digest("cursor_request", JSON.stringify({
    filters: request.filters,
    provenance_baseline: request.provenanceBaseline,
  }));
  const offset = parseCursor(request.cursor, request.selected[0], requestHash);
  let database;
  try {
    database = typeof env?.DB?.withSession === "function"
      ? env.DB.withSession("first-primary")
      : env?.DB;
  } catch {
    return {
      status: 503,
      body: await unavailableFinancialPicture(body, "database_session_unavailable", receiptOptions),
    };
  }
  if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
    return {
      status: 503,
      body: await unavailableFinancialPicture(body, "database_binding_unavailable", receiptOptions),
    };
  }

  const statements = [];
  const plans = [];
  let entityIndex = null;
  let referenceIntegrityIndex = null;
  try {
    // Keep even an all-Unavailable request (for example payroll alone) tied to
    // one actual D1 snapshot, and never call batch with an empty list.
    statements.push(database.prepare(
      "SELECT schema_version FROM install_state WHERE id = 1 LIMIT 1",
    ));
    if (request.filters.entity_slug) {
      entityIndex = statements.length;
      statements.push(database.prepare(
        `SELECT 1 AS present FROM fin_entities
          WHERE tenant_id = ? AND entity_slug = ? AND superseded_by_id IS NULL
          LIMIT 1`,
      ).bind(DEFAULT_TENANT, request.filters.entity_slug));
    }
    if (request.selected.some((name) =>
      (SECTION_DEFINITIONS[name]?.integrityFields || []).length > 0)) {
      referenceIntegrityIndex = statements.length;
      statements.push(database.prepare(REFERENCE_INTEGRITY_SQL));
    }

    for (const name of request.selected) {
      const definition = SECTION_DEFINITIONS[name];
      if (!definition) continue;
      const where = whereFor(request.filters, definition.applicable);
      const countIndex = statements.length;
      statements.push(database.prepare(
        `SELECT COUNT(*) AS total FROM (${definition.base}) rows ${where.sql}`,
      ).bind(...where.binds));
      const rowsIndex = statements.length;
      statements.push(database.prepare(
        `SELECT * FROM (${definition.base}) rows ${where.sql}
          ORDER BY ${definition.order} LIMIT ? OFFSET ?`,
      ).bind(...where.binds, request.limit, offset));
      const integrityIndex = definition.integrityFields.length > 0
        ? referenceIntegrityIndex
        : null;
      plans.push({ name, definition: { ...definition, name }, countIndex, rowsIndex, integrityIndex });
    }
  } catch {
    return {
      status: 503,
      body: await unavailableFinancialPicture(body, "database_prepare_unavailable", receiptOptions),
    };
  }

  let results;
  let bookmark = null;
  try {
    results = await database.batch(statements);
    if (typeof database.getBookmark === "function") bookmark = database.getBookmark() || null;
  } catch {
    return {
      status: 503,
      body: await unavailableFinancialPicture(body, "database_read_failed", receiptOptions),
    };
  }
  try {
    if (!Array.isArray(results) || results.length !== statements.length) {
      return {
        status: 503,
        body: await unavailableFinancialPicture(body, "database_read_incomplete", receiptOptions),
      };
    }
    if (resultRows(results[0]).length !== 1) {
      return {
        status: 503,
        body: await unavailableFinancialPicture(body, "snapshot_anchor_unavailable", receiptOptions),
      };
    }
    if (entityIndex !== null && resultRows(results[entityIndex]).length !== 1) {
      throw new FinancialPictureInputError("entity_not_found", "the exact entity filter was not found", 404);
    }

    const sections = {};
    for (const name of FINANCIAL_PICTURE_SECTIONS) {
      const definition = SECTION_DEFINITIONS[name];
      if (!request.selected.includes(name)) {
        sections[name] = unavailableSection(
          request.filters,
          definition?.applicable || FILTER_KEYS,
          "not_requested",
          name === "payroll"
            ? PAYROLL_UNAVAILABLE_FIELDS
            : [...(definition?.unavailableFields || []), ...FRESHNESS_UNAVAILABLE_FIELDS],
          request.provenanceBaseline,
        );
      } else if (name === "payroll") {
        sections[name] = unavailableSection(
          request.filters,
          FILTER_KEYS,
          "payroll_registry_unavailable",
          PAYROLL_UNAVAILABLE_FIELDS,
          request.provenanceBaseline,
        );
      }
    }

    for (const plan of plans) {
      const countRows = resultRows(results[plan.countIndex]);
      const total = Number(countRows[0]?.total);
      if (!Number.isSafeInteger(total) || total < 0) {
        return {
          status: 503,
          body: await unavailableFinancialPicture(body, "database_count_unavailable", receiptOptions),
        };
      }
      if (offset > 0 && offset >= total) {
        throw new FinancialPictureInputError("invalid_cursor", "cursor is outside the current section", 400);
      }
      const rawRows = resultRows(results[plan.rowsIndex]);
      const records = await Promise.all(
        rawRows.map((row) => plan.definition.transform(row, references)),
      );
      sections[plan.name] = availableSection(
        plan.definition,
        request.filters,
        total,
        records,
        offset,
        requestHash,
        request.provenanceBaseline,
      );
      if (plan.integrityIndex !== null) {
        const integrityRows = resultRows(results[plan.integrityIndex]);
        if (integrityRows.length !== 1) throw new Error("stable-reference integrity is unavailable");
        withReferenceIntegrity(
          sections[plan.name], integrityRows[0], request.filters,
          plan.definition.integrityFields,
        );
      }
    }

    const requestedUnavailable = request.selected.filter((name) => sections[name]?.unavailable);
    const envelope = baseEnvelope(request, sections);
    envelope.unavailable = requestedUnavailable.length > 0;
    envelope.sections_unavailable = requestedUnavailable;
    envelope.provenance_debt_gate = aggregateProvenanceDebtGate(request, sections);
    const complete = await withReceipt(envelope, {
      capturedAt,
      bookmark,
      references,
    });
    return { status: 200, body: assertFinancialPicturePublicReceipt(complete) };
  } catch (error) {
    if (error instanceof FinancialPictureInputError) throw error;
    return {
      status: 503,
      body: await unavailableFinancialPicture(body, "database_result_unavailable", receiptOptions),
    };
  }
}
