export type MapAssessment = "confirmed" | "unknown" | "unavailable" | "not_applicable";
export type MapDisposition = "included" | "excluded" | "unavailable";

export type MapReviewField = {
  assessment: MapAssessment;
  owner_value: string | number | boolean | null;
  current_value: string | number | boolean | null;
  comparison: "matches_current" | "differs_from_current" | "not_compared";
};

export type MapReviewGroup = {
  assessment: MapAssessment;
  items: Array<{ label: string; kind?: string; assessment: MapAssessment }>;
};

export type MapReviewYear = {
  tax_year: number;
  state: MapDisposition;
  filing_units: { assessment: MapAssessment; labels: string[] };
  required_returns: MapReviewGroup;
  required_forms: MapReviewGroup;
  k1_roles: MapReviewGroup;
  books: {
    assessment: MapAssessment;
    bookkeeping_company: { label: string; assessment: MapAssessment } | null;
  };
  payroll: { assessment: MapAssessment };
  expected_sources: MapReviewGroup;
};

export type MapReviewEntity = {
  label: string;
  disposition: MapDisposition;
  evidence_state: "linked_current_record" | "owner_declared_no_current_record";
  fields: Record<string, MapReviewField>;
  tax_years: MapReviewYear[];
};

export type MapReviewAccount = {
  label: string;
  disposition: MapDisposition;
  evidence_state: "linked_current_record" | "owner_declared_no_current_record";
  fields: Record<string, MapReviewField>;
};

export type MapUnresolvedItem = {
  kind: string;
  state: string;
  label?: string;
  item_label?: string;
  field?: string;
  tax_year?: number;
  message?: string;
};

export type MapChange = {
  area: string;
  subject: string;
  field: string;
  tax_year?: number;
  before: string | null;
  after: string | null;
};

export type FinancialMapReview = {
  status: "ready";
  review_state: "pending";
  authoritative: false;
  activation_performed: false;
  complete: true;
  truncated: false;
  review_id: string;
  map_hash: string;
  denominator_hash: string;
  expected_sequence: number;
  created_at: number;
  expires_at: number;
  counts: {
    entities: number;
    accounts: number;
    entity_years: number;
    filing_units: number;
    obligation_items: number;
  };
  complete_preview: {
    population_state: "owner_asserted_complete" | "known_partial" | "unknown";
    tax_year_horizon: { start: number; end: number };
    filing_units: Array<{ label: string; assessment: MapAssessment }>;
    entities: MapReviewEntity[];
    accounts: MapReviewAccount[];
  };
  prior_comparison: {
    state: "compared" | "no_prior_confirmed_map";
    changed: boolean | null;
    change_count: number;
    changes: MapChange[];
    previous_confirmed_map: FinancialMapReview["complete_preview"] | null;
  };
  unresolved_count: number;
  unresolved_items: MapUnresolvedItem[];
  requires: "explicit_owner_passkey_confirmation";
};

export type FinancialMapPasskeyOptions = {
  challenge: string;
  rp_id: string;
  allow_credentials: string[];
  expires_at: number;
  ceremony_message: string;
};

export type FinancialMapActivation = {
  activated: true;
  replayed: boolean;
  sequence: number;
  map_hash: string;
  denominator_hash: string;
  population_state: string;
  tax_year_horizon: { start: number; end: number };
  counts: FinancialMapReview["counts"];
  request_id: string;
  activated_at: number;
  mutations: {
    owner_financial_map_snapshot: "appended";
    ledger: "none";
    sources: "none";
    taxes: "none";
    books: "none";
    payroll: "none";
    accounts: "none";
  };
};

export type FinancialMapNoPending = {
  status: "no_pending_review";
  review_state: "none";
  complete: true;
  truncated: false;
  active_map_present: boolean;
  active_map_authoritative: boolean;
  active_sequence: number | null;
  active_map_hash: string | null;
  active_denominator_hash: string | null;
  active_activated_at: number | null;
  owner_message: string;
};

const REVIEW_ID = /^ofmp_[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const ASSESSMENTS = new Set<MapAssessment>(["confirmed", "unknown", "unavailable", "not_applicable"]);
const DISPOSITIONS = new Set<MapDisposition>(["included", "excluded", "unavailable"]);
const POPULATION_STATES = new Set(["owner_asserted_complete", "known_partial", "unknown"]);
const EVIDENCE_STATES = new Set(["linked_current_record", "owner_declared_no_current_record"]);
const COMPARISONS = new Set(["matches_current", "differs_from_current", "not_compared"]);
const ENTITY_FIELDS = ["kind", "status", "holds", "ownership", "tax_class", "relationship", "parent"];
const ACCOUNT_FIELDS = ["entity_assignment", "kind", "balance_role", "currency", "status"];
const PRIVATE_KEYS = new Set([
  "map_id", "ledger_ref", "entity_ref", "account_ref", "item_ref", "snapshot_ref",
  "row_hash", "value_hash", "map_hash", "denominator_hash", "inventory_hash",
  "credential_ref", "request_id", "source_locator", "external_ref", "mask",
  "entity_slug", "account_slug", "tenant_id",
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reject a response that would hand internal locators or hashes to the page. */
export function hasPrivateMapKey(value: unknown, root = true): boolean {
  if (Array.isArray(value)) return value.some((item) => hasPrivateMapKey(item, false));
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    ((!root || !["review_id", "map_hash", "denominator_hash", "request_id", "active_map_hash", "active_denominator_hash"].includes(key)) &&
      (PRIVATE_KEYS.has(key) || key.endsWith("_slug") || key.endsWith("_hash") || key.endsWith("_ref"))) ||
    hasPrivateMapKey(item, false));
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function displayValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function validAssessment(value: unknown): value is MapAssessment {
  return ASSESSMENTS.has(value as MapAssessment);
}

function validField(value: unknown): value is MapReviewField {
  return plainObject(value) && exactKeys(value, ["assessment", "owner_value", "current_value", "comparison"]) &&
    validAssessment(value.assessment) && displayValue(value.owner_value) && displayValue(value.current_value) &&
    COMPARISONS.has(value.comparison as MapReviewField["comparison"]);
}

function validFields(value: unknown, names: readonly string[]): value is Record<string, MapReviewField> {
  return plainObject(value) && exactKeys(value, names) && names.every((name) => validField(value[name]));
}

function validGroup(value: unknown): value is MapReviewGroup {
  return plainObject(value) && exactKeys(value, ["assessment", "items"]) && validAssessment(value.assessment) &&
    Array.isArray(value.items) && value.items.every((item) => plainObject(item) &&
      exactKeys(item, item.kind === undefined ? ["label", "assessment"] : ["label", "kind", "assessment"]) &&
      typeof item.label === "string" && item.label.length > 0 &&
      (item.kind === undefined || typeof item.kind === "string") && validAssessment(item.assessment));
}

function validYear(value: unknown): value is MapReviewYear {
  if (!plainObject(value) || !exactKeys(value, [
    "tax_year", "state", "filing_units", "required_returns", "required_forms", "k1_roles",
    "books", "payroll", "expected_sources",
  ]) || !Number.isSafeInteger(value.tax_year) || !DISPOSITIONS.has(value.state as MapDisposition) ||
      !plainObject(value.filing_units) || !exactKeys(value.filing_units, ["assessment", "labels"]) ||
      !validAssessment(value.filing_units.assessment) || !Array.isArray(value.filing_units.labels) ||
      !value.filing_units.labels.every((label) => typeof label === "string" && label.length > 0) ||
      !validGroup(value.required_returns) || !validGroup(value.required_forms) || !validGroup(value.k1_roles) ||
      !validGroup(value.expected_sources) || !plainObject(value.books) ||
      !exactKeys(value.books, ["assessment", "bookkeeping_company"]) || !validAssessment(value.books.assessment) ||
      !plainObject(value.payroll) || !exactKeys(value.payroll, ["assessment"]) ||
      !validAssessment(value.payroll.assessment)) return false;
  const company = value.books.bookkeeping_company;
  return company === null || (plainObject(company) && exactKeys(company, ["label", "assessment"]) &&
    typeof company.label === "string" && company.label.length > 0 && validAssessment(company.assessment));
}

function validPreview(value: unknown): value is FinancialMapReview["complete_preview"] {
  if (!plainObject(value) || !exactKeys(value, [
    "population_state", "tax_year_horizon", "filing_units", "entities", "accounts",
  ]) || !POPULATION_STATES.has(String(value.population_state)) || !plainObject(value.tax_year_horizon) ||
      !exactKeys(value.tax_year_horizon, ["start", "end"]) || !Number.isSafeInteger(value.tax_year_horizon.start) ||
      !Number.isSafeInteger(value.tax_year_horizon.end) || Number(value.tax_year_horizon.start) > Number(value.tax_year_horizon.end) ||
      !Array.isArray(value.filing_units) || !Array.isArray(value.entities) || !Array.isArray(value.accounts)) return false;
  if (!value.filing_units.every((unit) => plainObject(unit) && exactKeys(unit, ["label", "assessment"]) &&
      typeof unit.label === "string" && unit.label.length > 0 && validAssessment(unit.assessment))) return false;
  if (!value.entities.every((entity) => plainObject(entity) && exactKeys(entity, [
    "label", "disposition", "evidence_state", "fields", "tax_years",
  ]) && typeof entity.label === "string" && entity.label.length > 0 &&
      DISPOSITIONS.has(entity.disposition as MapDisposition) && EVIDENCE_STATES.has(String(entity.evidence_state)) &&
      validFields(entity.fields, ENTITY_FIELDS) && Array.isArray(entity.tax_years) && entity.tax_years.every(validYear))) return false;
  return value.accounts.every((account) => plainObject(account) && exactKeys(account, [
    "label", "disposition", "evidence_state", "fields",
  ]) && typeof account.label === "string" && account.label.length > 0 &&
    DISPOSITIONS.has(account.disposition as MapDisposition) && EVIDENCE_STATES.has(String(account.evidence_state)) &&
    validFields(account.fields, ACCOUNT_FIELDS));
}

function groupCount(year: MapReviewYear): number {
  return year.required_returns.items.length + year.required_forms.items.length +
    year.k1_roles.items.length + year.expected_sources.items.length +
    (year.books.bookkeeping_company ? 1 : 0);
}

/** The UI renders only a complete, closed, internally consistent receipt. */
export function validFinancialMapReview(value: unknown): value is FinancialMapReview {
  if (!plainObject(value) || value.status !== "ready" || value.review_state !== "pending" ||
      value.authoritative !== false || value.activation_performed !== false || value.complete !== true ||
      value.truncated !== false || !REVIEW_ID.test(String(value.review_id || "")) ||
      !HASH.test(String(value.map_hash || "")) || !HASH.test(String(value.denominator_hash || "")) ||
      !safeCount(value.expected_sequence) || value.expected_sequence < 1 ||
      !safeCount(value.created_at) || !safeCount(value.expires_at) ||
      !plainObject(value.counts) || !validPreview(value.complete_preview) ||
      !plainObject(value.prior_comparison) || !Array.isArray(value.prior_comparison.changes) ||
      value.prior_comparison.change_count !== value.prior_comparison.changes.length ||
      !Array.isArray(value.unresolved_items) || value.unresolved_count !== value.unresolved_items.length ||
      value.requires !== "explicit_owner_passkey_confirmation" || hasPrivateMapKey(value)) return false;
  const preview = value.complete_preview;
  const entities = preview.entities;
  const accounts = preview.accounts;
  const years = entities.flatMap((entity) => entity.tax_years);
  const comparison = value.prior_comparison;
  if (!exactKeys(comparison, ["state", "changed", "change_count", "changes", "previous_confirmed_map"]) ||
      !comparison.changes.every((change) => plainObject(change) &&
        exactKeys(change, change.tax_year === undefined
          ? ["area", "subject", "field", "before", "after"]
          : ["area", "subject", "field", "tax_year", "before", "after"]) &&
        [change.area, change.subject, change.field].every((item) => typeof item === "string" && item.length > 0) &&
        (change.tax_year === undefined || Number.isSafeInteger(change.tax_year)) &&
        (change.before === null || typeof change.before === "string") &&
        (change.after === null || typeof change.after === "string"))) return false;
  if (comparison.state === "compared") {
    if (typeof comparison.changed !== "boolean" || comparison.changed !== (comparison.change_count > 0) ||
        !validPreview(comparison.previous_confirmed_map)) return false;
  } else if (comparison.state !== "no_prior_confirmed_map" || comparison.changed !== null ||
      comparison.change_count !== 0 || comparison.previous_confirmed_map !== null) return false;
  if (!value.unresolved_items.every((item) => plainObject(item) && typeof item.kind === "string" &&
      typeof item.state === "string" && (item.label === undefined || typeof item.label === "string") &&
      (item.item_label === undefined || typeof item.item_label === "string") &&
      (item.field === undefined || typeof item.field === "string") &&
      (item.tax_year === undefined || Number.isSafeInteger(item.tax_year)) &&
      (item.message === undefined || typeof item.message === "string"))) return false;
  const counts = value.counts as Record<string, unknown>;
  return safeCount(counts.entities) && counts.entities === entities.length &&
    safeCount(counts.accounts) && counts.accounts === accounts.length &&
    safeCount(counts.entity_years) && counts.entity_years === years.length &&
    safeCount(counts.filing_units) && counts.filing_units === preview.filing_units.length &&
    safeCount(counts.obligation_items) && counts.obligation_items === years.reduce((sum, year) => sum + groupCount(year), 0);
}

export function humanMapWord(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function mapValue(field: string, value: string | number | boolean | null): string {
  if (value === null) return "Not recorded";
  if (field === "ownership" && typeof value === "number") {
    return `${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  // Only machine enums get presentation casing. Free text and resolved labels
  // must remain byte-for-byte recognizable to the owner, including legal
  // capitalization, Form 1120-S, and meaningful account suffixes.
  if (typeof value === "string") {
    return ["kind", "status", "relationship", "balance_role"].includes(field)
      ? humanMapWord(value)
      : value;
  }
  return String(value);
}

export function validFinancialMapOptions(value: unknown): value is FinancialMapPasskeyOptions {
  return plainObject(value) && typeof value.challenge === "string" && value.challenge.length > 0 &&
    typeof value.rp_id === "string" && value.rp_id.length > 0 && Array.isArray(value.allow_credentials) &&
    value.allow_credentials.every((item) => typeof item === "string" && item.length > 0) &&
    safeCount(value.expires_at) && typeof value.ceremony_message === "string";
}

export function validFinancialMapActivation(value: unknown): value is FinancialMapActivation {
  if (!plainObject(value) || value.activated !== true || typeof value.replayed !== "boolean" ||
      !safeCount(value.sequence) || !safeCount(value.activated_at) || !plainObject(value.counts) ||
      !HASH.test(String(value.map_hash || "")) || !HASH.test(String(value.denominator_hash || "")) ||
      typeof value.request_id !== "string" || value.request_id.length < 1 || value.request_id.length > 128 ||
      !plainObject(value.tax_year_horizon) || !plainObject(value.mutations) || hasPrivateMapKey(value)) return false;
  const mutations = value.mutations as Record<string, unknown>;
  return mutations.owner_financial_map_snapshot === "appended" &&
    ["ledger", "sources", "taxes", "books", "payroll", "accounts"].every((key) => mutations[key] === "none");
}

export function validFinancialMapNoPending(value: unknown): value is FinancialMapNoPending {
  if (!plainObject(value) || value.status !== "no_pending_review" || value.review_state !== "none" ||
      value.complete !== true || value.truncated !== false || typeof value.active_map_present !== "boolean" ||
      typeof value.active_map_authoritative !== "boolean" || typeof value.owner_message !== "string" ||
      hasPrivateMapKey(value)) return false;
  if (!value.active_map_present) {
    return value.active_map_authoritative === false && value.active_sequence === null && value.active_map_hash === null &&
      value.active_denominator_hash === null && value.active_activated_at === null;
  }
  return safeCount(value.active_sequence) && value.active_sequence >= 1 &&
    HASH.test(String(value.active_map_hash || "")) && HASH.test(String(value.active_denominator_hash || "")) &&
    safeCount(value.active_activated_at);
}
