// Every call carries X-Brain-App. It is the CSRF companion to the
// SameSite=Strict session cookie: the cookie proves who, this header proves
// the request came from this app rather than from a page that merely sits in
// the same browser.
const OWNER_SAFE_REQUEST_FAILURE = "Your Brain could not confirm what happened. Refresh this page to check the current state before trying again.";

function normalizedErrorBody(body: unknown, status: number): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const normalized = { ...body } as Record<string, unknown>;
  // These fields are display copy in the owner app. Keep useful structured
  // guidance verbatim, but never let a legacy bare HTTP code bypass the shared
  // presentation path when a component reads the body directly.
  for (const field of ["error", "detail", "reason", "recovery"] as const) {
    if (typeof normalized[field] !== "string") continue;
    const fallback = field === "reason" && status === 415
      ? "This file type is not supported for owner upload."
      : OWNER_SAFE_REQUEST_FAILURE;
    normalized[field] = ownerSafeMessage(normalized[field], fallback);
  }
  return normalized;
}

function ownerSafeMessage(value: unknown, fallback = OWNER_SAFE_REQUEST_FAILURE): string {
  const safeFallback = typeof fallback === "string" && fallback.trim() &&
    !/^HTTP\s+\d{3}\b/i.test(fallback.trim())
    ? fallback
    : OWNER_SAFE_REQUEST_FAILURE;
  if (typeof value !== "string" || !value.trim() || /^HTTP\s+\d{3}\b/i.test(value.trim())) {
    return safeFallback;
  }
  return value;
}

const OWNER_ACTION_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  idempotency_conflict: "This save was already used for a different choice. Nothing changed. Refresh this page, review the current information, and try again.",
  request_id_conflict: "This save was already used for a different choice. Nothing changed. Refresh this page, review the current information, and try again.",
  entity_parent_cycle: "That ownership choice would create a loop. Nothing changed. Review which financial entity owns which, then choose again.",
  entity_already_exists: "That financial entity already exists. Nothing changed. Refresh the financial list and choose the existing entry.",
  exception_already_resolved: "That item was already resolved. Nothing changed. Refresh the current records before making another decision.",
  incomplete_evidence: "This period still has missing or unresolved evidence. Nothing changed. Review the open items before accepting it.",
  period_already_accepted: "This period was already accepted. Nothing changed. Refresh the current period record before taking another action.",
  period_not_accepted: "This period is not currently accepted, so it could not be reopened. Nothing changed. Refresh the current period record.",
  owner_upload_ocr_disabled: "This scanned file needs text recognition, but OCR is not enabled. Nothing was added. Upload a searchable copy or ask your installer to enable OCR.",
  owner_upload_pdf_needs_ocr: "This PDF appears to be scanned, but text recognition is not available. Nothing was added. Upload a searchable copy or ask your installer for help.",
  unsafe_upload_archive: "This archive did not pass the Brain's file-safety checks. Nothing was added. Choose the original supported files or ask your installer for help.",
  unreadable_upload: "The Brain could not read this file. Nothing was added. Choose a supported readable copy and try again.",
  bank_export_unreadable: "The Brain could not read this bank export. Nothing was imported. Download a fresh supported export and try again.",
  bank_export_refused: "This bank export did not match the reviewed import format. Nothing was imported. Review the export type and column choices before trying again.",
});

function ownerActionMessage(body: Record<string, unknown>, fallback: string): string {
  // Conflict and validation payloads can carry private names, locators, or raw
  // diagnostics. Only stable, reviewed codes may select owner-visible copy.
  // The server-provided detail is never rendered through this shared boundary.
  const code = typeof body.code === "string" ? body.code : "";
  return Object.hasOwn(OWNER_ACTION_CODE_MESSAGES, code)
    ? OWNER_ACTION_CODE_MESSAGES[code]
    : fallback;
}

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: unknown, fallback = OWNER_SAFE_REQUEST_FAILURE) {
    const normalizedBody = normalizedErrorBody(body, status);
    const structuredMessage = typeof normalizedBody.error === "string" && normalizedBody.error.trim()
      ? normalizedBody.error
      : null;
    super(ownerSafeMessage(structuredMessage, fallback));
    this.name = "ApiError";
    this.status = status;
    this.body = normalizedBody;
  }
}

async function decodeApiResponse<T>(response: Response): Promise<T> {
  // Keep successful JSON responses exactly as the route returned them. For an
  // error, ApiError accepts only an object-shaped body so HTML, plain text,
  // arrays, null, and other malformed payloads never become owner-facing copy.
  const data = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-App": "1" },
    body: JSON.stringify(body ?? {}),
  });
  return decodeApiResponse<T>(response);
}

export function requestId(prefix = "owner"): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${random}`.slice(0, 128);
}

export function ownerError(error: unknown): { status: number | null; message: string } {
  if (error instanceof ApiError) {
    if (error.status === 409) return {
      status: 409,
      message: ownerActionMessage(
        error.body,
        "That save could not be applied to the current records. Nothing changed. Refresh this page, review the current information, and try again.",
      ),
    };
    if ([400, 404, 413].includes(error.status) && typeof error.body.detail === "string") {
      return { status: error.status, message: ownerSafeMessage(error.body.detail) };
    }
    if (error.status === 415) return {
      status: 415,
      message: ownerSafeMessage(error.body.reason, "This file type is not supported for owner upload."),
    };
    if (error.status === 422) return {
      status: 422,
      message: ownerActionMessage(
        error.body,
        "The Brain could not use that information. Nothing was added or changed. Review the fields and try again.",
      ),
    };
    if (error.status === 403) return { status: 403, message: "This session is not allowed to do that." };
    if (error.status === 503) return { status: 503, message: "This part of the brain is unavailable right now. Nothing was treated as empty or saved." };
    return {
      status: error.status,
      message: ownerSafeMessage(error.message),
    };
  }
  return {
    status: null,
    message: ownerSafeMessage(error instanceof Error ? error.message : String(error)),
  };
}

export type EvidenceAuthority = {
  tier: "T0" | "T1" | "T2" | "T3" | "T4" | "T5";
  rank: number;
  name: string;
  reason: string;
  claim?: string;
  eligible?: boolean;
  authoritative?: boolean;
  current?: boolean;
  owner_confirmed?: boolean;
  operative?: boolean;
};
export type Citation = {
  n: number;
  title: string;
  source?: string;
  source_kind?: string | null;
  ref?: string | null;
  ts?: string | null;
  date_source?: string | null;
  date_reliable?: boolean;
  text_source?: string;
  text_reliable?: boolean;
  authority?: EvidenceAuthority | null;
};
export type Confidence = { percent: number; band: string; basis: string[] };
export type EntityScopeEcho = { entity_slug: string | null; applied: boolean };
export type EvidenceGate = {
  supported?: boolean;
  complete?: boolean;
  partial?: boolean;
  reason?: string;
  error?: string;
};
export type Answer = {
  answer: string | null;
  answer_error?: string;
  // Set when the search itself did not complete. Distinct from a genuine
  // no-match, and the difference decides what the page is allowed to say.
  status?: string;
  degraded?: string;
  notice?: string;
  results?: unknown[];
  confidence?: Confidence;
  evidence_authority?: Pick<EvidenceAuthority, "tier" | "name" | "reason" | "claim">;
  citations?: Citation[];
  evidence_gate?: EvidenceGate;
  entity_scope?: EntityScopeEcho;
  filter_not_applied?: boolean;
  retrieval_scope?: "owner" | "exact_document_ids" | string;
  degraded_reason?: string;
  access?: RetrievalAccess;
};
export type Device = {
  credential_id: string;
  nickname: string | null;
  created_at: number;
  last_used_at: number | null;
};
/** One app holding a live grant. Rows are per app, not per token: a connector
 *  refreshes routinely and an owner is asking about apps. */
export type Connection = {
  client_id: string;
  name: string;
  can_write: boolean;
  connected_at: number | null;
  last_used_at: number | null;
};
/** A bank the owner linked. Timestamps here are ISO strings, not epoch ms. */
export type BankConnection = {
  item_ref: string;
  institution_label: string | null;
  status: string;
  status_detail?: string | null;
  connected_at?: string | null;
  last_synced_at?: string | null;
};
export type BankStatus = {
  configured?: boolean;
  connections?: BankConnection[];
  needs_attention?: BankConnection[];
};
/** One problem the installer owns. `fix_owner` is always "installer" today:
 *  every diagnose remedy is a CLI command the owner cannot run. */
export type Problem = {
  id: string; area: string; severity: "crit" | "warn";
  count: number; title: string; detail?: string; fix_owner: string;
};
export type SourceCoverageDetail = {
  starter_context: { state: "preparing" | "ready" | "degraded" };
  live_updates: { state: "catching_up" | "current" | "stale" | "unavailable" };
  history: { state: "not_started" | "running" | "complete" | "needs_attention" | "unknown" };
  meaning_search: { state: "projecting" | "ready" | "degraded" | "unknown" };
  confirmed_range: { from: string | null; through: string | null };
  target_range: { from: string | null; through: string | null };
  current_window: { from: string | null; through: string | null } | null;
  counts: { seen: number | null; accepted: number | null; refused: number | null; failed: number | null };
  last_progress_at: string | null;
  projection_pending: number | null;
  waiting_on_owner_machine: boolean;
};
export type SourceRow = {
  label: string; kind: string; state: string; documents: number;
  days_since_ingest: number | null; reason: string | null; automatable: boolean;
  coverage?: SourceCoverageDetail;
  access_zone?: {
    state: "assigned" | "unassigned" | "unregistered" | "unknown";
    label: string | null;
  };
};
/** Keys are ABSENT when their read failed — never zero, never []. Anything
 *  optional here is optional because its absence is meaningful. */
export type SystemStatus = {
  accepting_documents: boolean | null;
  status: string | null;
  drain_mode: string | null;
  documents?: number;
  chunks?: number;
  problems?: Problem[];
  problem_counts?: { crit: number; warn: number; info: number };
  sources?: SourceRow[];
  vectors?: {
    ready: boolean; expected: number; visible: number;
    pending: number; percent_visible: number | null;
  };
  unavailable: string[];
};

export type OwnerPrincipal = { kind: "owner"; grant_id: null };
export type GrantPrincipal = {
  kind: "grant";
  grant_id: string;
  entity_slug: string | null;
  document_count: number;
  capabilities: Array<"documents:read" | "ask">;
};
export type WorkspaceAllowlist = {
  home: boolean;
  documents: boolean;
  ask: boolean;
  add_review: boolean;
  access: boolean;
  bank: boolean;
  targets: boolean;
  preferences: boolean;
};
export type RetrievalAccess = {
  principal: "owner" | "grant" | "proxy";
  scope?: "all" | "zones";
  read_only?: boolean;
  grant_id?: string;
  entity_slug?: string | null;
  document_count?: number;
};

export type Me = {
  signed_in: boolean;
  owner?: string;
  brain: string;
  principal?: OwnerPrincipal | GrantPrincipal;
  workspace?: WorkspaceAllowlist;
  devices?: Device[];
  connections?: Connection[];
};

export type GrantedDocument = {
  document_id: string;
  title: string;
  source: string;
  source_kind?: string | null;
  document_date: number | null;
  date_source: string | null;
  date_reliable: boolean;
  text_source: string;
  text_reliable: boolean;
};

export type GrantedDocumentsResponse = {
  status: "ready";
  principal: Pick<GrantPrincipal, "kind" | "grant_id" | "entity_slug">;
  scope_rule: "exact_document_ids_only";
  documents: GrantedDocument[];
};

export type DocumentGrantDocument = {
  document_id: string;
  entity_slug: string;
  granted_at: number;
  revoked_at: number | null;
};
export type DocumentGrant = {
  grant_id: string;
  subject_label: string;
  entity_slug: string;
  state: "active" | "revoked" | "expired";
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
  documents: DocumentGrantDocument[];
};
export type DocumentAccessStatus = {
  status: "ready";
  scope_rule: "exact_document_ids_only";
  default_access: "owner_only";
  grants: DocumentGrant[];
};
export type DocumentGrantReceipt = {
  status: "active" | "revoked";
  grant_id: string;
  subject_label?: string;
  entity_slug?: string;
  document_ids?: string[];
  expires_at?: number | null;
  created_at?: number;
  revoked_at?: number;
  changed?: boolean;
  replayed: boolean;
  invite_state?: "active" | "consumed" | "expired";
  enrollment_url?: string | null;
  enrollment_expires_at?: number;
  scope_rule?: "exact_document_ids_only";
};

export type PasskeyCeremony = {
  ceremony: string;
  stage: string;
  outcome: string;
  rp_id: string;
  count: number;
  last_at: number;
  timing_ms: { min: number | null; average: number | null; max: number | null };
};
export type PasskeyStatus = {
  status: "ready";
  rp_id: string;
  proof: { configured: boolean; locally_verified: boolean; live_proven: false };
  devices: { owner: number; grant: number };
  ceremonies: PasskeyCeremony[];
  privacy: string;
};

export type OwnerActivityEvent = {
  event_id: string;
  event_type: "upload_completed" | "approval_recorded" | "period_close_accepted" | "period_close_reopened" | "target_set" | "target_archived" | "preference_set"
    | "document_grant_created" | "document_grant_invite_reissued" | "document_grant_revoked"
    | "passkey_added" | "passkey_renamed" | "passkey_revoked" | "sessions_revoked";
  entity_slug: string | null;
  subject_kind: string;
  subject_id: string;
  display_label: string;
  occurred_at: string;
};

export type OwnerActivityResponse = {
  entity_scope?: { entity_slug: string | null };
  activity_events?: OwnerActivityEvent[];
  truncated?: boolean;
  next_cursor?: string | null;
  unavailable?: boolean;
  sections_unavailable?: string[];
};

export type OwnerTarget = {
  target_id: string;
  entity_slug: string;
  label: string;
  metric: "revenue" | "cash_reserve" | "spending_limit" | "debt_reduction" | "other";
  target_minor: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  note: string | null;
  archived_at?: string | null;
  updated_at?: string | null;
};

export type OwnerTargetsResponse = { entity_scope?: { entity_slug: string | null }; targets?: OwnerTarget[]; unavailable?: boolean };

export type OwnerPreference = {
  preference_key: "default_entity" | "display_currency" | "fiscal_year_start_month" | "activity_window_days";
  entity_slug: string | null;
  value: string | number;
  updated_at?: string | null;
};

export type OwnerPreferencesResponse = { entity_scope?: { entity_slug: string | null }; preferences?: OwnerPreference[]; unavailable?: boolean };

export type OwnerPeriodClose = {
  period_close_id: string;
  entity_slug: string;
  period_start: string;
  period_end: string;
  status: "accepted" | "reopened";
  evidence_state: "complete" | "owner_acknowledged_incomplete";
  acknowledged_incomplete?: boolean;
  accepted_at?: string | null;
  reopened_at?: string | null;
  updated_at?: string | null;
  note?: string | null;
};

export type OwnerPeriodCloseResponse = {
  entity_scope?: { entity_slug: string | null };
  period_closes?: OwnerPeriodClose[];
  unavailable?: boolean;
};

export type OwnerWriteReceipt = {
  request_id?: string;
  entity_scope?: { entity_slug: string | null };
  changed?: boolean;
  replayed?: boolean;
  activity_event_id?: string | null;
  uploaded?: boolean;
  document_id?: string;
  document?: Record<string, unknown>;
  upload?: Record<string, unknown>;
  approval?: Record<string, unknown>;
  period_close?: OwnerPeriodClose;
  target?: OwnerTarget;
  preference?: OwnerPreference;
};

export type OwnerUploadCapabilities = {
  supported_media_types: string[];
  supported_extensions: string[];
  media_type_extensions: Record<string, string[]>;
  max_content_bytes: number;
  content_encoding: "utf-8";
  empty_media_type_supported: false;
  normalization: string;
};

/** One financial scope. The slug is a transport identity only. Every visible
 *  surface uses `label`, and a missing label is handled without printing it. */
export type FinEntity = {
  entity_slug: string;
  legal_name: string;
  label: string;
  kind: string;
  status: string;
  relationship: string;
  counterparty: boolean;
  fixed: boolean;
};

export type FinAccount = {
  account_slug: string;
  entity_slug: string;
  institution: string | null;
  label: string;
  account_kind: string;
  balance_role: string;
  mask: string | null;
  currency: string;
  feed_mode: string;
  expected_cadence: string | null;
  status: string;
  coverage_status: string | null;
  covered_from: string | null;
  covered_to: string | null;
  coverage_note: string | null;
  coverage_computed_at: string | null;
  basis_state: string;
};

export type FinDocument = {
  fin_doc_uid: string;
  entity_slug: string | null;
  account_slug: string | null;
  doc_kind: string;
  title: string;
  tax_year: number | null;
  period_start: string | null;
  period_end: string | null;
  custody_class: string;
  availability: string;
  available_from: string | null;
  available_within_days: number | null;
  filed_at: string | null;
  reconciled_through: string | null;
  received_from: string | null;
  received_at: string | null;
  in_corpus: boolean;
  readable: boolean;
  unreadable_reason: string | null;
  restricted: boolean;
  basis_state: string;
};

export type FinStatement = {
  statement_uid: string;
  account_slug: string;
  period_start: string;
  period_end: string;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  currency: string;
  line_count_stated: number | null;
  parse_state: string;
  received_at: string | null;
  parsed_at: string | null;
  basis_state: string;
};

export type FinReconciliationClaim = {
  claim_uid: string;
  label: string;
  amount_minor: number | null;
  currency: string;
  as_of: string;
  basis_state: string;
};

export type FinReconciliation = {
  reconciliation_uid: string;
  entity_slug: string | null;
  account_slug: string | null;
  period_start: string | null;
  period_end: string | null;
  measure: string;
  state: string;
  delta_minor: number | null;
  tolerance_minor: number;
  currency: string;
  ruled_claim_uid: string | null;
  ruled_at: string | null;
  ruled_by_party: string | null;
  ruling_note: string | null;
  ruling_consumed: boolean;
  claims: FinReconciliationClaim[];
};

export type FinOpenItem = {
  code: string;
  entity_slug: string | null;
  question: string;
  routed_role: string | null;
  routed_name: string | null;
  status: string;
  due_date: string | null;
  citations: string[];
  not_included: string[];
  answer: string | null;
  answered_at: string | null;
  basis_state: string;
};

export type FinUnsortedSpending = {
  account_slug: string;
  currency: string;
  outflow_minor: number;
  counted_lines: number;
  unreadable_lines: number;
};

export type FinDeadline = {
  deadline_uid: string;
  entity_slug: string | null;
  item: string;
  due_date: string | null;
  owner_party: string;
  status: string;
  urgency: string;
  consequence: string | null;
  waiting_on: string | null;
  basis_note: string | null;
  basis_state: string;
};

export type FinException = {
  exception_uid: string;
  entity_slug: string | null;
  issue: string;
  detail: string | null;
  amount_minor: number | null;
  currency: string;
  first_seen: string;
  waiting_on: string | null;
  proposal: string | null;
  proposal_confidence_bp: number | null;
  basis_state: string;
};

export type FinObligation = {
  obligation_uid: string;
  entity_slug: string;
  kind: string;
  counterparty: string | null;
  label: string | null;
  balance_minor: number | null;
  balance_as_of: string | null;
  currency: string;
  renews_on: string | null;
  personal_guarantee: boolean;
  personal_guarantee_state: string;
};

export type FinCash = {
  as_of: string | null;
  total_minor: number | null;
  currency: string | null;
  mixed_currency?: boolean;
  covered: Array<{
    account_slug: string;
    label: string;
    amount_minor: number;
    currency: string;
    as_of: string;
  }>;
  missing: Array<{
    account_slug: string;
    reason: string;
    covered_to: string | null;
    last_confirmed_as_of: string | null;
  }>;
  excluded: Array<{
    account_slug: string;
    reason: string;
  }>;
  accounts_covered: number;
  accounts_considered: number;
  complete: boolean;
};

export type FinSnapshot = {
  ledger_installed: boolean;
  missing_tables: string[];
  unavailable: boolean;
  entity_scope: string | null;
  sections_returned?: string[];
  sections_unavailable?: string[];
  entities?: FinEntity[];
  accounts?: FinAccount[];
  documents?: FinDocument[];
  statements?: FinStatement[];
  deadlines?: FinDeadline[];
  exceptions?: FinException[];
  open_items?: FinOpenItem[];
  reconciliations?: FinReconciliation[];
  obligations?: FinObligation[];
  unsorted_spending?: FinUnsortedSpending[];
  obligation_exposure?: {
    balance_minor: number | null;
    currency: string | null;
    obligations_with_balance: number;
    obligations_total: number;
    guaranteed: number;
    guarantee_none_found: number;
    guarantee_not_examined: number;
    guarantee_unreadable: number;
    covers_all_obligations: boolean;
  };
  cash?: FinCash;
  truncated?: Record<string, boolean>;
};

export type FinDocumentsResponse = {
  ledger_installed: boolean;
  missing_tables: string[];
  unavailable: boolean;
  entity_scope: string | null;
  documents?: FinDocument[];
  truncated?: boolean;
};

/** GET companion to `api`. The bank feed answers status on GET; the same
 *  X-Brain-App header still marks the request as coming from this app. */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { "X-Brain-App": "1" } });
  return decodeApiResponse<T>(response);
}
