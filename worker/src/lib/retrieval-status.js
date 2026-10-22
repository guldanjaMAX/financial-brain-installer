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
});

export function refusalNextAction({ status, withheldGate } = {}) {
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
