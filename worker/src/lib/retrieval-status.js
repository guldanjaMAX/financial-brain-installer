/**
 * retrieval-status — what an empty result set is allowed to mean.
 *
 * Retrieval can return nothing for two completely different reasons, and until
 * this module existed both produced the same sentence:
 *
 *   1. The corpus genuinely holds nothing on the question. Saying so plainly is
 *      the product working. That path is untouched here.
 *   2. Part of the search never ran. The vector index is still building right
 *      after an install, the embedding model did not answer, keyword search is
 *      down. Nothing is known about the corpus, because the corpus was not
 *      fully read.
 *
 * Case 2 wearing case 1's sentence is the worst error this product can make: a
 * confident absence claim about the owner's own records, produced by the exact
 * discipline the brain is built on, and indistinguishable to the reader from a
 * correct answer. It is at its most likely on install day, when the index is
 * still projecting and the owner is asking their first questions.
 *
 * So the two cases get different statuses, different gap types, and different
 * sentences, and every surface derives them from here rather than writing its
 * own. `degraded` is the signal that separates them; it has ridden the wire
 * since before this module, which is why the clients can defend themselves with
 * `retrievalUnavailable` even against a worker deployed before this change.
 */

/** Wire value for `status` when the search did not complete. */
export const SEARCH_UNAVAILABLE = "search_unavailable";

/** Wire value when retrieval ran but declared source coverage is not complete. */
export const COVERAGE_INCOMPLETE = "coverage_incomplete";

/** Wire value when retrieval found records but an answer gate withheld the draft. */
export const ANSWER_WITHHELD = "answer_withheld";

/** Wire value for `status` when the search completed and matched nothing. */
export const NO_RESULTS = "no_results";

/** Coverage policy shared by Worker answers and both MCP renderers. */
export const COVERAGE_FINE = "fine";
export const COVERAGE_STALE_BUT_COVERING = "stale_but_covering";
export const COVERAGE_CATASTROPHIC = "catastrophic";

const QUESTION_PRIMARY_SOURCES = Object.freeze({
  money: new Set(["ledger", "plaid", "bank", "bank-feed", "payment", "stripe", "square"]),
  email: new Set(["gmail"]),
  documents: new Set(["drive", "upload"]),
  meetings: new Set(["zoom", "calendar"]),
  store: new Set(["custom-api", "store", "shopify", "square"]),
  quickbooks: new Set(["quickbooks"]),
});
const CONTACT_FIELDS = new Map([
  ["address", "address"], ["mailing address", "mailing address"],
  ["home address", "home address"], ["business address", "business address"],
  ["email", "email"], ["email address", "email"],
  ["phone", "phone"], ["phone number", "phone"],
  ["mobile", "mobile"], ["mobile number", "mobile"],
  ["company", "company"], ["organization", "company"],
  ["role", "role"], ["job title", "role"],
  ["addresses", "address"], ["mailing addresses", "mailing address"],
  ["home addresses", "home address"], ["business addresses", "business address"],
  ["emails", "email"], ["email addresses", "email"],
  ["phones", "phone"], ["phone numbers", "phone"],
  ["mobiles", "mobile"], ["mobile numbers", "mobile"],
  ["companies", "company"], ["organizations", "company"],
  ["roles", "role"], ["job titles", "role"],
]);
const CONTACT_FIELD_PATTERN = [...CONTACT_FIELDS.keys()].sort((left, right) => right.length - left.length).join("|");
const CONTACT_SUBJECT_PATTERN = "([\\p{L}\\p{N}][\\p{L}\\p{N} '&.,-]{0,119}?)";
const CONTACT_FIELD_LOOKUPS = [
  new RegExp(`(?:^|\\s)(?:the\\s+)?(?:current\\s+)?(${CONTACT_FIELD_PATTERN})\\s+(?:of|for)\\s+${CONTACT_SUBJECT_PATTERN}[.?!]*$`, "iu"),
  new RegExp(`(?:^|\\s)(my|our)\\s+(?:current\\s+)?(${CONTACT_FIELD_PATTERN})[.?!]*$`, "iu"),
  new RegExp(`${CONTACT_SUBJECT_PATTERN}['’]s?\\s+(?:current\\s+)?(${CONTACT_FIELD_PATTERN})[.?!]*$`, "iu"),
];

function possessiveSubjectCandidates(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  // A relationship phrase such as "my accountant X's" is not an identity
  // join. Keep it whole so the exact-fact path declines instead of dropping
  // the relationship words and treating X as the directly requested subject.
  if (/\b(?:my|our|their|his|her|its)\b/i.test(words.join(" "))) return [words.join(" ")];
  const candidates = [];
  for (let index = 0; index < words.length; index++) {
    const candidate = words.slice(index).join(" ").replace(/^(?:the)\s+/i, "").trim();
    if (candidate && candidate.length <= 120 && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

/** Shared field intent for coverage routing and exact contact-fact extraction. */
export function contactFieldIntent(question) {
  const text = String(question || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  let match = CONTACT_FIELD_LOOKUPS[0].exec(text);
  if (match) return { subject: match[2], subjects: [match[2]], field: CONTACT_FIELDS.get(match[1].toLowerCase()), owner: false };
  match = CONTACT_FIELD_LOOKUPS[1].exec(text);
  if (match) return { subject: null, subjects: [], field: CONTACT_FIELDS.get(match[2].toLowerCase()), owner: true };
  match = CONTACT_FIELD_LOOKUPS[2].exec(text);
  if (match) {
    const subjects = possessiveSubjectCandidates(match[1]);
    return { subject: subjects[0] || null, subjects, field: CONTACT_FIELDS.get(match[2].toLowerCase()), owner: false };
  }
  return null;
}

const NEVER_COMPLETE_GAPS = new Set(["never_synced", "source_unregistered"]);
const COVERAGE_GAP_TYPES = new Set([
  ...NEVER_COMPLETE_GAPS,
  "history_unproven",
  "sync_broken", "sync_review", "sync_in_progress", "refresh_unscheduled", "coverage_stale",
  "coverage_unavailable", "ledger_coverage_stale", "ledger_out_of_coverage", "ledger_not_consulted",
]);
const ledgerRefusal = (causeClass, catastrophic, notice, nextAction) => Object.freeze({
  cause_class: causeClass, catastrophic, notice, next_action: nextAction,
});

/** Every hard ledger stop has one stable cause class and owner remedy. */
export const LEDGER_REFUSAL_POLICIES = Object.freeze({
  retrieval_scope_restricted: ledgerRefusal("unsupported_request", false,
    "This request does not have unrestricted owner ledger scope, so the ledger cannot answer it.",
    "Next: ask again as the full owner without a source, document or entity filter."),
  unsupported_question: ledgerRefusal("unsupported_request", false,
    "This money request is outside the ledger's reviewed question types.",
    "Next: ask for a balance, deposit, money in or out, expense, merchant, category, transfer or recurring charge."),
  no_accounts: ledgerRefusal("link_required", false,
    "No authorized ledger account is available for this request.",
    "Next: connect or import the intended account, confirm its owner assignment, then ask again."),
  live_feed_never_synced: ledgerRefusal("coverage_outage", true,
    "A selected live bank feed has never completed a sync, so the ledger cannot establish current coverage.",
    "Next: finish the bank feed's first sync and verify its covered dates, then ask again."),
  ledger_account_link_required: ledgerRefusal("link_required", false,
    "Manual and live records may represent the same account, but the owner has not approved that link.",
    "Next: preview the named account link, approve it only if both records are the same account, then ask again."),
  ambiguous_account: ledgerRefusal("ambiguous_selector", false,
    "The account selector does not identify one confirmed ledger account.",
    "Next: ask with one exact displayed account mask and account kind after resolving any duplicate account records."),
  unsupported_currency: ledgerRefusal("unsupported_request", false,
    "The selected ledger account uses a currency this answer path does not support.",
    "Next: ask about a supported USD account or review the original statement for the other currency."),
  period_outside_coverage: ledgerRefusal("coverage_outage", true,
    "The ledger's proven history does not reach the start of the requested period.",
    "Next: ask for a period beginning on or after the covered-from date, or complete the missing bank history."),
  cash_flow_unsupported: ledgerRefusal("unsupported_request", false,
    "Cash flow is not supported because posted card purchases and bank movements do not establish a cash-flow statement.",
    "Next: ask for money in and money out, or for the bounded profit or net-income surplus."),
  balance_unavailable: ledgerRefusal("coverage_outage", true,
    "The selected account has no readable current balance observation.",
    "Next: refresh or import a current balance for that account, then ask again."),
  coverage_review_required: ledgerRefusal("coverage_outage", true,
    "The stored coverage interval needs review before it can support a total or zero.",
    "Next: independently review and re-establish that account's covered dates, then ask again."),
  merchant_selector_unsupported: ledgerRefusal("ambiguous_selector", false,
    "The merchant selector is redacted, shortened or unknown and cannot identify one stored merchant safely.",
    "Next: quote the exact printed merchant label with the same period and account scope."),
  bank_export_overlap_review_required: ledgerRefusal("coverage_outage", true,
    "Overlapping bank-export rows have incompatible identities, so the requested ledger rows are not readable as one total.",
    "Next: compare the original exports and statement, then use a separately approved reconciliation before asking again."),
  unreadable_transactions: ledgerRefusal("coverage_outage", true,
    "One or more required ledger transactions cannot be read safely.",
    "Next: repair or re-import the unreadable rows and verify their dates, amounts and directions, then ask again."),
  merchant_selector_ambiguous: ledgerRefusal("ambiguous_selector", false,
    "The merchant selector differs from a stored label only by its literal conjunction, so the intended merchant is ambiguous.",
    "Next: quote the exact printed merchant label, preserving and or &, then ask again."),
  ledger_unavailable: ledgerRefusal("coverage_outage", true,
    "The bank ledger could not be read for this request.",
    "Next: retry once, then check the Brain's ledger health before asking again."),
});
export const LEDGER_REFUSAL_REASONS = new Set(Object.keys(LEDGER_REFUSAL_POLICIES));

export function ledgerRefusalPolicy(reason) {
  return LEDGER_REFUSAL_POLICIES[String(reason || "")] || null;
}
const DAY_MS = 86_400_000;

function normalizedSource(value) {
  return String(value || "").trim().toLowerCase().replaceAll("_", "-");
}

function coverageQuestionSources(question, explicitType = null) {
  const q = String(question || "").normalize("NFKC").toLowerCase().trim();
  const contactFieldLookup = contactFieldIntent(q) !== null;
  const explicitEmailChannel = /\b(?:gmail|inbox|senders?|messages?|sent[- ]mail|(?:mail|email) threads?)\b/.test(q);
  const named = new Set();
  const namedTypes = [];
  const add = (type) => {
    if (!namedTypes.includes(type)) namedTypes.push(type);
    for (const source of QUESTION_PRIMARY_SOURCES[type]) named.add(source);
  };
  // Named channels identify where the owner asked us to look. They take
  // precedence over generic words such as paid, balance, or revenue.
  if (explicitEmailChannel ||
      (!contactFieldLookup && /\bemail\b/.test(q))) add("email");
  if (/\b(?:quickbooks|qbo)\b/.test(q)) named.add("quickbooks");
  if (/\b(?:drive|uploads?|folders?|pdf|spreadsheet)\b/.test(q)) add("documents");
  if (/\b(?:zoom|calendar)\b/.test(q)) add("meetings");
  if (/\b(?:store|shop|shopify|orders?|inventory|products?|units sold|store sales)\b/.test(q)) add("store");
  if (/\b(?:bank|bank feed|ledger|plaid)\b/.test(q)) add("money");
  if (named.size) {
    const types = [...namedTypes, ...(named.has("quickbooks") ? ["quickbooks"] : [])];
    return { type: types.length === 1 ? types[0] : "mixed", sources: named };
  }
  if (QUESTION_PRIMARY_SOURCES[explicitType]) {
    return { type: explicitType, sources: QUESTION_PRIMARY_SOURCES[explicitType] };
  }
  if (/\b(?:money|balance|payments?|paid|deposits?|income|spend|spent|expenses?|charges?|transactions?|credits?|debits?|transfers?|profit|revenue)\b|\$\s*\d/.test(q)) {
    return { type: "money", sources: QUESTION_PRIMARY_SOURCES.money };
  }
  if (/\b(?:meeting|appointment|scheduled call|recording)\b/.test(q)) {
    return { type: "meetings", sources: QUESTION_PRIMARY_SOURCES.meetings };
  }
  if (/\b(?:documents?|files?)\b/.test(q)) {
    return { type: "documents", sources: QUESTION_PRIMARY_SOURCES.documents };
  }
  return { type: "other", sources: null };
}

function gapSourceKind(gap) {
  const explicit = normalizedSource(gap?.source_kind);
  if (explicit && explicit !== "unregistered") return explicit;
  const source = normalizedSource(gap?.source);
  if (/\bledger\b/.test(source)) return "ledger";
  for (const kind of ["gmail", "drive", "upload", "zoom", "calendar", "plaid", "stripe", "square", "shopify", "store"]) {
    if (source === kind || source.includes(kind)) return kind;
  }
  return source;
}

function safeInstant(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const instant = Date.parse(String(value || ""));
  return Number.isFinite(instant) ? instant : null;
}

function lastGoodInstant(gap) {
  return safeInstant(gap?.last_good_sync_at ?? gap?.last_ingest_at ?? gap?.last_synced_at ?? gap?.covered_through);
}

function gapCalendarDay(gap) {
  for (const value of [gap?.coverage_calendar_date, gap?.last_good_sync_at]) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value);
  }
  return null;
}

function sourceLabel(gap) {
  const source = typeof gap?.source === "string" ? gap.source.trim() : "";
  if (source) return source;
  const kind = gapSourceKind(gap);
  return ({ gmail: "Gmail", drive: "Drive", upload: "uploads", zoom: "Zoom",
    calendar: "calendar", ledger: "bank ledger", "custom-api": "store feed" })[kind] || "source";
}

function supportedTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function dateParts(instant, timeZone, fields) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: supportedTimeZone(timeZone), ...fields,
  }).formatToParts(new Date(instant)).filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
}

export function formatCoverageDate(instant, timeZone = "UTC") {
  const parts = dateParts(instant, timeZone, { weekday: "short", month: "short", day: "numeric" });
  return `${parts.weekday} ${parts.month} ${parts.day}`;
}

function coverageCalendarDate(instant, timeZone) {
  const parts = dateParts(instant, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function coverageCalendarDayEnd(day, timeZone = "UTC") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), dayOfMonth = Number(dayText);
  const representedDay = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (representedDay.getUTCFullYear() !== year || representedDay.getUTCMonth() + 1 !== month ||
      representedDay.getUTCDate() !== dayOfMonth) return null;
  const nextDay = Date.UTC(year, month - 1, dayOfMonth + 1);
  const zone = supportedTimeZone(timeZone);
  let instant = nextDay;
  // A calendar-only ledger observation covers the whole owner-local day. Find
  // the next local midnight so freshness does not start early in UTC.
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = dateParts(instant, zone, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const adjustment = nextDay - represented;
    if (adjustment === 0) return instant - 1;
    instant += adjustment;
  }
  return null;
}

function formatCoverageGapDate(gap, instant, timeZone) {
  const day = gapCalendarDay(gap);
  return day ? formatCoverageDate(Date.parse(`${day}T12:00:00.000Z`), "UTC")
    : formatCoverageDate(instant, timeZone);
}

function shortLedgerDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!match) return String(day || "unknown date");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1];
  return `${month} ${Number(match[3])}`;
}

function renderCoverageSideNote(gaps, nowMs, timeZone) {
  const clauses = [];
  const seen = new Set();
  const ordered = [...gaps].sort((left, right) =>
    Number(Boolean(right?.type === "ledger_coverage_stale" && right?.missing_from && right?.requested_through)) -
    Number(Boolean(left?.type === "ledger_coverage_stale" && left?.missing_from && left?.requested_through)));
  for (const gap of ordered) {
    const label = sourceLabel(gap);
    if (seen.has(label)) continue;
    seen.add(label);
    if (gap?.type === "ledger_coverage_stale" && gap?.missing_from && gap?.requested_through) {
      clauses.push(`${label} is covered through ${shortLedgerDay(gap.covered_through)}, so activity from ${shortLedgerDay(gap.missing_from)} through ${shortLedgerDay(gap.requested_through)} may be missing.`);
      continue;
    }
    const lastGood = lastGoodInstant(gap);
    if (lastGood === null || nowMs - lastGood < 2 * DAY_MS) continue;
    const paused = gap?.type === "sync_review" || gap?.held_for_review === true;
    clauses.push(`${label} ${paused ? "has been paused" : "has not refreshed"} since ${formatCoverageGapDate(gap, lastGood, timeZone)}, so anything only in ${label} after that date may be missing.`);
  }
  return clauses.length ? `Side note: ${clauses.join(" ")}` : null;
}

export function coverageWindowStart(timeWindow) {
  const start = timeWindow?.start;
  const instant = typeof start === "number" ? start : Date.parse(String(start || ""));
  if (!Number.isFinite(instant)) return null;
  return new Date(instant).toISOString();
}

export function coveragePeriodStart(explicitFrom, timeWindow) {
  const start = explicitFrom ?? timeWindow?.start;
  return coverageWindowStart({ start });
}

/**
 * Decide whether source gaps can stop this answer. A gap outside the question's
 * primary source can qualify the answer, but cannot turn supported evidence
 * into a refusal. Missing primary history and a primary source that stopped
 * before the requested period remain hard stops.
 */
export function classifyQuestionCoverage({
  question,
  questionType = null,
  periodStart = null,
  gaps = [],
  evidenceSources = [],
  now = Date.now(),
  timeZone = "UTC",
} = {}) {
  const questionSources = coverageQuestionSources(question, questionType);
  const type = questionSources.type;
  const evidenceKinds = new Set((Array.isArray(evidenceSources) ? evidenceSources : [])
    .map((source) => normalizedSource(source)).filter(Boolean));
  // Retrieved evidence is always primary for the answer that relies on it.
  // Genuine channel wording may add another required family, but can never
  // replace the source of the supporting record. Contact-field nouns such as
  // "email address" are not channel instructions.
  const primarySourceKinds = new Set(evidenceKinds);
  for (const source of questionSources.sources || []) primarySourceKinds.add(source);
  const nowMs = safeInstant(now) ?? Date.now();
  const periodStartMs = safeInstant(periodStart);
  const coverageGaps = (Array.isArray(gaps) ? gaps : []).filter((gap) =>
    COVERAGE_GAP_TYPES.has(gap?.type) &&
    (gap.type !== "ledger_not_consulted" || LEDGER_REFUSAL_REASONS.has(gap.reason)));
  const catastrophicGaps = [];
  const notable = [];
  let oldestCoveringPrimary = null;

  for (const gap of coverageGaps) {
    const kind = gapSourceKind(gap);
    const primary = primarySourceKinds.has(kind);
    const lastGood = lastGoodInstant(gap);
    // `history_unproven` can accompany usable records from a completed ingest
    // whose full declared history has not yet been certified. That is a
    // qualification, not the same fact as a source that has never synced.
    const neverComplete = NEVER_COMPLETE_GAPS.has(gap.type) ||
      (gap.type === "history_unproven" && lastGood === null);
    const outsidePeriod = periodStartMs !== null && (lastGood === null || lastGood < periodStartMs);
    const explicitlyUnreadable = gap.type === "ledger_out_of_coverage" ||
      (gap.type === "ledger_not_consulted" && ledgerRefusalPolicy(gap.reason)?.catastrophic === true) ||
      (gap.type === "coverage_unavailable" && gap.primary_source === true);
    if (primary && (neverComplete || outsidePeriod || explicitlyUnreadable)) {
      catastrophicGaps.push(gap);
      continue;
    }
    const partialLedger = gap.type === "ledger_coverage_stale" && gap?.missing_from && gap?.requested_through;
    if (partialLedger || (lastGood !== null && nowMs - lastGood >= 2 * DAY_MS)) {
      notable.push(gap);
      if (primary && nowMs - lastGood > 14 * DAY_MS &&
          (oldestCoveringPrimary === null || lastGood < oldestCoveringPrimary.instant)) {
        oldestCoveringPrimary = { instant: lastGood, calendarDay: gapCalendarDay(gap) };
      }
    }
  }

  const classification = catastrophicGaps.length
    ? COVERAGE_CATASTROPHIC
    : notable.length
      ? COVERAGE_STALE_BUT_COVERING
      : COVERAGE_FINE;
  return {
    question_type: type,
    primary_sources: [...primarySourceKinds],
    classification,
    refuse: classification === COVERAGE_CATASTROPHIC,
    catastrophic_gaps: catastrophicGaps,
    side_note: renderCoverageSideNote(notable, nowMs, timeZone),
    answer_prefix: oldestCoveringPrimary === null
      ? null
      : `As of ${oldestCoveringPrimary.calendarDay || coverageCalendarDate(oldestCoveringPrimary.instant, timeZone)},`,
  };
}

export const PROJECTION_CATCHING_UP = "projection-catching-up";
const PROJECTION_PENDING_REASONS = new Set([PROJECTION_CATCHING_UP, "projection-incomplete"]);

export function projectionPending(degraded, reason) {
  return degraded === "vector" && PROJECTION_PENDING_REASONS.has(reason);
}

const nonNegativeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Owner-facing progress uses the two measured counts, never a percentage. */
export function meaningSearchLine({ visible, total } = {}) {
  const visibleCount = nonNegativeCount(visible);
  const totalCount = nonNegativeCount(total);
  if (visibleCount !== null && totalCount !== null && visibleCount === totalCount) return null;
  if (visibleCount === null || totalCount === null) {
    return "Meaning search is still counting chunks; keyword search covers all";
  }
  return `Meaning search covers ${visibleCount.toLocaleString("en-US")} of ${totalCount.toLocaleString("en-US")} chunks; keyword search covers all`;
}

/**
 * The genuine no-match gap, verbatim.
 *
 * Frozen and exported because several tests pin this string: it is the honest
 * refusal, and no change in this file is allowed to soften it.
 */
export const NO_RESULTS_GAP = Object.freeze({
  type: "no_results",
  detail: "The brain has nothing on this query. Say so plainly rather than inferring.",
});

/**
 * Cause and remedy per degradation, in the owner's language.
 *
 * `cause` completes the sentence "The search could not be completed: ...".
 */
const CAUSES = {
  vector: {
    cause: "the vector index is still building, so meaning-based search could not cover all stored records",
    // It finishes on its own: a scheduled background drain runs on every cron
    // cycle. A looped manual `brain drain` measured 31/min against 61/min
    // sustained idle, because it competes for the server's own drain lease
    // instead of helping it, so the remedy must actively steer the reader away
    // from that command rather than merely omit encouraging it.
    remedy: "It finishes on its own in the background. Running `brain drain` by hand does not speed it up. Try again shortly.",
  },
  "no-embedding": {
    cause: "the embedding model did not answer, so only keyword search ran and anything phrased differently to the source text was never reachable",
    remedy: "Try again in a moment. Run `brain health` if it keeps happening.",
  },
  fts: {
    cause: "keyword search is unavailable, so exact word matching did not run",
    remedy: "Run `brain health` to see which subsystem is down.",
  },
  retrieval: {
    cause: "both keyword search and meaning-based search failed, so no stored records were searched",
    remedy: "Try again in a moment. Run `brain health` if it keeps happening.",
  },
  "scoped-vector": {
    cause: "exact document authorization was applied in D1, so the unscoped semantic index was deliberately not queried",
    remedy: "Keyword evidence is authoritative for this scoped request. Semantic recall remains intentionally unavailable until Vectorize supports an exact document prefilter.",
  },
};

// Preserve the long-standing `degraded` wire values while using the explicit
// store outcome to distinguish a query failure from an incomplete projection.
// Only known token/reason pairs select copy, so an arbitrary provider message
// can never enter an owner-facing response through this path.
const CAUSES_BY_REASON = {
  "vector:projection-count-mismatch": {
    cause: "the provider and database vector counts differ, so meaning-based search cannot be certified complete",
    remedy: "Run `brain health` to inspect the count mismatch before attempting recovery.",
  },
  "vector:vector-query-failed": {
    cause: "meaning-based search failed, so only keyword search completed",
    remedy: "Try again in a moment. Run `brain health` if it keeps happening.",
  },
  "fts:keyword-query-failed": {
    cause: "keyword search failed, so exact word matching did not run",
    remedy: "Try again in a moment. Run `brain health` if it keeps happening.",
  },
  "retrieval:keyword-and-vector-query-failed": {
    cause: "both keyword search and meaning-based search failed, so no stored records were searched",
    remedy: "Try again in a moment. Run `brain health` if it keeps happening.",
  },
};

const UNKNOWN_REMEDY = "Run `brain health` to see which subsystem is down.";

const ANSWER_WITHHELD_NOTICES = Object.freeze({
  uncited_draft: "The answer was withheld because the draft did not cite its supporting records.",
  money_check: "The answer was withheld because it did not pass the money evidence check.",
  date_check: "The answer was withheld because it did not pass the date evidence check.",
  conflicting_records: "The answer was withheld because retrieved records conflict and require review.",
  unreadable_check_reply: "The answer was withheld because the evidence check reply could not be read twice.",
  unsupported: "The answer was withheld because the evidence check did not support the draft.",
});

export function answerWithheldNotice(gate = "unsupported") {
  return ANSWER_WITHHELD_NOTICES[gate] || ANSWER_WITHHELD_NOTICES.unsupported;
}

/** Closed, reviewed actions for every refusal state a /think response emits. */
export const REFUSAL_NEXT_ACTIONS = Object.freeze({
  no_results: "Next: ask again with a name, date or exact phrase the record would contain.",
  coverage_incomplete: 'Next: say "check my Brain" to see which source is still loading, then ask again.',
  search_unavailable: 'Next: ask again in a minute; if it fails twice, say "check my Brain".',
  "answer_withheld:uncited_draft": "Next: ask about one record at a time, naming its title or date.",
  "answer_withheld:unsupported": "Next: ask about one record at a time, naming its title or date.",
  "answer_withheld:money_check": "Next: ask for one amount with its payer, payee and date.",
  "answer_withheld:date_check": "Next: ask again with the exact date range you mean.",
  "answer_withheld:conflicting_records": "Next: ask which record is newest on this; the records found disagree.",
  "answer_withheld:unreadable_check_reply": "Next: ask the same question again in a minute.",
  ...Object.fromEntries(Object.entries(LEDGER_REFUSAL_POLICIES)
    .map(([reason, policy]) => [`ledger:${reason}`, policy.next_action])),
});

export function refusalNextAction({ status, withheldGate, ledgerReason } = {}) {
  const ledgerAction = ledgerRefusalPolicy(ledgerReason)?.next_action;
  if (ledgerAction) return ledgerAction;
  const key = status === ANSWER_WITHHELD
    ? `${ANSWER_WITHHELD}:${withheldGate || "unsupported"}`
    : status || NO_RESULTS;
  return REFUSAL_NEXT_ACTIONS[key] || null;
}

/** Normalise whatever the store reported into a short, safe token. */
function degradedToken(degraded) {
  if (degraded === null || degraded === undefined || degraded === false) return null;
  const token = String(degraded).trim().slice(0, 40);
  return token ? token : null;
}

/**
 * Why a search was incomplete, as a clause, or null when it was complete.
 *
 * An unrecognised value still yields a cause. A future degradation mode that
 * this module has never heard of must not fall through to "the brain has
 * nothing", which is precisely the failure being fixed.
 */
function degradationDetails(degraded, degradedReason = null) {
  const token = degradedToken(degraded);
  if (!token) return null;
  const reason = typeof degradedReason === "string" ? degradedReason.trim().slice(0, 80) : "";
  return CAUSES_BY_REASON[`${token}:${reason}`] || CAUSES[token] || null;
}

export function degradedCause(degraded, degradedReason = null) {
  const token = degradedToken(degraded);
  if (!token) return null;
  return degradationDetails(token, degradedReason)?.cause ||
    `a retrieval subsystem reported "${token}" and did not answer`;
}

/** What the owner can do about it. */
export function degradedRemedy(degraded, degradedReason = null) {
  const token = degradedToken(degraded);
  if (!token) return null;
  return degradationDetails(token, degradedReason)?.remedy || UNKNOWN_REMEDY;
}

/**
 * The sentence a human reads in place of an answer.
 *
 * Deliberately contains no clause that reads as "there is no record". The eval
 * refusal scorer is a regex over exactly that family of phrasings, and
 * `worker/test/degraded-absence.test.mjs` asserts this string does not match
 * it, because a sentence that scores as a refusal will be read as one.
 */
export function unavailableNotice(degraded, degradedReason = null) {
  return [
    "The search could not be completed, so this is not an answer about what your brain holds.",
    `Cause: ${degradedCause(degraded, degradedReason)}.`,
    "This does not mean your brain is empty on this question.",
    degradedRemedy(degraded, degradedReason),
  ].join(" ");
}

/**
 * A healthy zero-match search still cannot support a complete-corpus absence
 * when source history is partial or its coverage read failed.
 */
export function coverageIncompleteNotice(unavailable = false, candidatesFound = false) {
  const outcome = candidatesFound
    ? "The search found candidate records, but they did not support an answer."
    : "The search returned zero matches.";
  return unavailable
    ? `${outcome} Source coverage could not be checked, so treat this result as provisional until source status is available.`
    : `${outcome} One or more source histories are not yet proven complete, so treat this result as provisional while records may still be loading.`;
}

/** Copy for a completed hybrid search whose semantic projection is pending. */
export function projectionCatchupNotice(candidatesFound = false, meaningSearch = null) {
  const outcome = candidatesFound
    ? "The search completed and found candidate records, but they did not support an answer."
    : "The search completed with zero matches.";
  const line = meaningSearchLine(meaningSearch || {}) ||
    "Meaning search is still counting chunks; keyword search covers all";
  return `${outcome} ${line}, so treat this result as provisional.`;
}

export function projectionCatchupGap(meaningSearch = null) {
  const line = meaningSearchLine(meaningSearch || {}) ||
    "Meaning search is still counting chunks; keyword search covers all";
  return {
    type: "keyword_only_indexing",
    detail: `${line}. Cited answers rest on keyword evidence; a record worded differently may not be found yet, so a missing result is provisional.`,
  };
}

/**
 * The instruction a consuming model follows.
 *
 * The gap text is the part an LLM actually acts on, so the prohibition has to
 * be in the gap, not merely implied by a sibling field it may never read.
 */
export function unavailableGap(degraded, degradedReason = null) {
  const token = degradedToken(degraded);
  return {
    type: SEARCH_UNAVAILABLE,
    degraded: token,
    detail:
      `The search could not be completed: ${degradedCause(degraded, degradedReason)}. ` +
      "This is a system state, NOT a finding about the corpus. " +
      "Do NOT say or imply that the brain has nothing on this question, and do not answer from your own knowledge instead. " +
      "Say that the search could not be completed, name the cause, and offer to retry.",
  };
}

/**
 * The whole disclosure for a zero-result retrieval.
 *
 * One call decides status, gaps and sentence together so no surface can pick up
 * half of it.
 */
export function emptyRetrievalDisclosure(
  degraded,
  degradedReason = null,
  { candidatesFound = false, meaningSearch = null } = {},
) {
  const token = degradedToken(degraded);
  if (!token) {
    return {
      unavailable: false,
      incomplete: false,
      status: NO_RESULTS,
      degraded: null,
      cause: null,
      notice: null,
      gaps: [NO_RESULTS_GAP],
    };
  }
  if (projectionPending(token, degradedReason)) {
    return {
      unavailable: false,
      incomplete: true,
      status: COVERAGE_INCOMPLETE,
      degraded: token,
      cause: null,
      notice: projectionCatchupNotice(candidatesFound, meaningSearch),
      gaps: [projectionCatchupGap(meaningSearch)],
    };
  }
  return {
    unavailable: true,
    incomplete: false,
    status: SEARCH_UNAVAILABLE,
    degraded: token,
    cause: degradedCause(token, degradedReason),
    notice: unavailableNotice(token, degradedReason),
    gaps: [unavailableGap(token, degradedReason)],
  };
}

/**
 * Should a client treat this /think or /unified body as an unavailable search?
 *
 * Written to be safe against version skew. An MCP server or CLI on the client's
 * machine can be newer than the worker it is pointed at, and a worker deployed
 * before this change sends `degraded` but no `status`. The second clause is what
 * protects that client: an empty body carrying any degradation is unavailable,
 * whatever the worker called it.
 */
export function retrievalUnavailable(body) {
  if (!body || typeof body !== "object") return false;
  if (body.status === SEARCH_UNAVAILABLE) return true;
  if (body.status === ANSWER_WITHHELD) return false;
  if (body.status === COVERAGE_INCOMPLETE) return false;
  if (!degradedToken(body.degraded)) return false;
  const answered = typeof body.answer === "string" && body.answer.trim().length > 0;
  const cited = Array.isArray(body.citations) && body.citations.length > 0;
  const found = Array.isArray(body.results) && body.results.length > 0;
  return !answered && !cited && !found;
}

/** Whether an empty response is allowed to support a whole-corpus absence. */
export function absenceUnproven(body) {
  return body?.status === ANSWER_WITHHELD || body?.status === COVERAGE_INCOMPLETE || retrievalUnavailable(body);
}
