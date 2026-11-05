/**
 * answer-render — how a /think response becomes the two sentences an owner
 * reads, and the one thing those sentences must never say.
 *
 * These were fenced inside the served HTML so an offline test could lift them
 * out and exercise the real shipped source. That was the right instinct with a
 * hand-written page; once the app became a bundle there was no page to lift
 * them from, and the honest fix is a module both the app and the test import
 * rather than string surgery on a document.
 *
 * Pure and DOM-free on purpose: the rule they encode is a product rule, not a
 * rendering detail, and every surface that shows an answer needs it.
 *
 * THE RULE: an incomplete search must never render as "the documents do not
 * answer the question". That sentence asserts an absence, and on this page it
 * is all the owner sees. During the first hours of a new brain the index is
 * still building, which makes a degraded empty result the likeliest empty
 * result they will ever get. Saying "nothing is recorded" then is a confident
 * false claim about their own records, produced by the very discipline the
 * brain is sold on.
 */

import {
  absenceUnproven, ANSWER_WITHHELD, COVERAGE_INCOMPLETE, coverageIncompleteNotice,
  REFUSAL_NEXT_ACTIONS, refusalNextAction, SEARCH_UNAVAILABLE, unavailableNotice,
} from "./retrieval-status.js";

// The fallback when the worker sent no notice of its own — an older worker, or
// one that only set `degraded`. Derived from the same source as every other
// notice so the wording can never drift between surfaces.
const GENERIC_UNAVAILABLE_NOTICE = unavailableNotice("unknown");
const GENERIC_COVERAGE_NOTICE = coverageIncompleteNotice(false);

/**
 * Reviewed owner-facing replacements for model and provider failures.
 *
 * Provider errors can contain request identifiers, implementation details, or
 * fragments copied from an upstream response. They are useful in protected
 * diagnostics, but they are not safe answer copy and must never ride the
 * public response into the app or CLI.
 */
export const ANSWER_ERROR_MESSAGES = Object.freeze({
  notConfigured: "Search is available, but answers still need to be set up. Want help finishing setup with your installer?",
  keyMissing: "Search still works, but answers are paused because the answer service needs to be reconnected. Want help reconnecting it?",
  providerAccount: "Search still works, but answers are paused because the answer service needs its access or credit balance checked. Want help checking it?",
  dailyLimit: "Search still works, but answers have reached today's spending limit and restart at midnight UTC, or sooner if the limit is raised. Want to search your records in the meantime?",
  dailyLimitLegacy: "Search is available, but answers have reached the daily limit. Want to search while the limit resets?",
  spendCheckPaused: "Search still works, but answers are paused for a few minutes while the spending record is checked. Want to try again shortly?",
  verificationUnavailable: "I can try the evidence check again, but no answer is confirmed yet, so none was shown. Want to try again in a moment?",
  unavailable: "I can help you try again, but answers are unavailable right now. Want to try again in a moment?",
});
export const GAP_DETAIL = "Search still works, but answers are paused until the answer service is reconnected. Want help reconnecting it?";

const REVIEWED_ANSWER_ERRORS = new Set(Object.values(ANSWER_ERROR_MESSAGES));

/** Convert a caught model failure to copy that is safe on every answer surface. */
export function answerGenerationError(error, { verification = false } = {}) {
  if (error?.no_key) return ANSWER_ERROR_MESSAGES.notConfigured;
  if (error?.no_anthropic_key) return ANSWER_ERROR_MESSAGES.keyMissing;
  if (["key_rejected", "billing", "model_unavailable"].includes(error?.provider_error_class)) {
    return ANSWER_ERROR_MESSAGES.providerAccount;
  }
  if (error?.llm_cap_exceeded && error?.spend_guard_degraded) return ANSWER_ERROR_MESSAGES.spendCheckPaused;
  if (error?.llm_cap_exceeded) return ANSWER_ERROR_MESSAGES.dailyLimit;
  return verification
    ? ANSWER_ERROR_MESSAGES.verificationUnavailable
    : ANSWER_ERROR_MESSAGES.unavailable;
}

/** Defend a newer page against an older Worker that returned a raw error. */
export function safeAnswerErrorText(error) {
  const candidate = typeof error === "string" ? error.trim() : "";
  return REVIEWED_ANSWER_ERRORS.has(candidate)
    ? candidate
    : ANSWER_ERROR_MESSAGES.unavailable;
}

/**
 * Is this empty answer unable to support a whole-corpus absence?
 *
 * The status field is the modern signal. The `degraded` fallback defends a
 * newer page talking to an older worker that sends no status: it has ridden
 * the wire since before that field existed.
 */
export function unavailableSearch(r) {
  return absenceUnproven(r);
}

// Typed bank decisions already carry their owner explanation. Keep internal
// decision reasons in JSON without repeating them as owner prose.
export function moneyExplanation(r) {
  return (Array.isArray(r?.gaps) ? r.gaps : []).filter(gap =>
    /^ledger_/.test(String(gap?.type || "")) || ["money_veto", "money_recall"].includes(gap?.type))
    .map(gap => typeof gap.detail === "string" && gap.detail ? gap.detail
      : "I can help check the bank connection, but the bank records needed for this answer are unavailable.\nWant help connecting or refreshing the bank account?").join("\n");
}
export function answerReasonText(r) {
  if (r?.ledger || moneyExplanation(r)) return null;
  return typeof r?.evidence_gate?.reason === "string"
    ? r.evidence_gate.reason.replace(/\s+/g, " ").trim().slice(0, 240) || null : null;
}

// Invitations are presentation choices, separate from factual qualifications.
// Keep account labels, numeric citations and coverage facts byte-for-byte.
export function separateOffers(text = "") {
  const offers = [];
  const facts = text.replace(/(?:^[ \t]*|(?<=[.!?])\s+)(Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\.)/gm,
    (_, offer) => { offers.push(offer); return ""; }).trim();
  return { facts, offers };
}

// Full CLI and MCP responses add sources and trust notes after answerText.
// Finalize once after those facts, retaining only the chosen invitation.
export function finalAnswerText(facts, selectedOffer) {
  return [facts.trim(), selectedOffer].filter(Boolean).join("\n");
}

export function answerText(r) {
  const text = answerBodyText(r);
  // The surface renders the reviewed Next action separately. It is already
  // the repair invitation, so another question here would duplicate it.
  if (nextActionText(r)) return separateOffers(text).facts;
  // Supported answers were composed with their qualifications below.
  if (r.answer && !/^The documents do not answer/i.test(r.answer)) return text;
  const composed = separateOffers(text);
  return finalAnswerText(composed.facts, composed.offers.at(-1));
}

function answerBodyText(r) {
  if (r.status === COVERAGE_INCOMPLETE) {
    const notice = r.notice || GENERIC_COVERAGE_NOTICE;
    return moneyExplanation(r) ? notice.replaceAll("Source coverage", "The connected records") : notice;
  }
  if (unavailableSearch(r)) return r.notice || GENERIC_UNAVAILABLE_NOTICE;
  if (r.answer_error && !r.answer) return safeAnswerErrorText(r.answer_error);
  if (r.answer && !/^The documents do not answer/i.test(r.answer)) {
    const explanation = moneyExplanation(r);
    const composed = separateOffers(r.answer);
    const gap = separateOffers(explanation);
    const extra = gap.facts.split("\n")
      .filter(line => line && !composed.facts.includes(line)).join("\n");
    // Ledger composition already selected its offer. Document gaps can carry
    // a later repair choice; keep every factual qualification before it.
    const offer = r.ledger || r.clarification ? composed.offers[0]
      : gap.offers.at(-1) || composed.offers.at(-1) || "Want to check the original record?";
    const facts = [composed.facts, extra].filter(Boolean).join(r.ledger || r.clarification ? "\n" : "\n\n");
    return [facts, offer].filter(Boolean).join("\n");
  }
  const explanation = moneyExplanation(r);
  if (explanation) {
    const gap = separateOffers(explanation);
    const fallback = r.gaps.some(g => g?.type === "ledger_out_of_coverage")
      ? "Want help connecting or refreshing the bank records for those dates?"
      : "Want help connecting or refreshing the bank account?";
    return finalAnswerText(gap.facts, gap.offers.at(-1) || fallback);
  }
  // A refusal is about the records checked, even when retrieval was healthy.
  // Missing result metadata must not become a fabricated zero count.
  if (!Array.isArray(r.results)) return "I can help narrow the search, but the records checked did not support an answer. Want to try a more specific detail?";
  const count = r.results.length;
  return count
    ? `I found ${count} ${count === 1 ? "record" : "records"} in this search, but none supported an answer to this question. Want to try a more specific detail?`
    : "I can try a more specific search, but I didn't find a matching record in this search. Want to add a detail?";
}

export const SCANNED_EVIDENCE_GAP_TYPE = "scanned_evidence";
export const SCANNED_ANSWER_NOTICE =
  "Part of this answer comes from a scanned document read by OCR. Check the original for exact figures.";
export const SCANNED_RESULTS_NOTICE =
  "Some of these results come from a scanned document read by OCR. Check the original for exact figures.";
export const SCANNED_CITATION_MARK = "(scanned)";

export function scannedEvidenceGap(rows, { results = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const count = list.filter((row) => row?.scanned === true).length;
  if (!count) return null;
  return {
    type: SCANNED_EVIDENCE_GAP_TYPE,
    count,
    total: list.length,
    detail: results ? SCANNED_RESULTS_NOTICE : SCANNED_ANSWER_NOTICE,
  };
}

export function citationIsScanned(citation) {
  return citation?.scanned === true;
}

export function scannedEvidenceNotice(r) {
  if (!r || typeof r !== "object" || unavailableSearch(r)) return null;
  const answer = typeof r.answer === "string" ? r.answer.trim() : "";
  if (!answer || /^The documents do not answer/i.test(answer)) return null;
  const gapped = (Array.isArray(r.gaps) ? r.gaps : [])
    .some((gap) => gap?.type === SCANNED_EVIDENCE_GAP_TYPE);
  const cited = (Array.isArray(r.citations) ? r.citations : []).some(citationIsScanned);
  return gapped || cited ? SCANNED_ANSWER_NOTICE : null;
}

export function confidenceText(r) {
  if (r.status === ANSWER_WITHHELD) {
    return "The evidence check left this answer unconfirmed, so no confidence percentage is shown.";
  }
  if (r.status === COVERAGE_INCOMPLETE) {
    return moneyExplanation(r)
      ? "Some connected records may be missing or still loading. This answer is incomplete."
      : "Source coverage is incomplete. This result is provisional.";
  }
  // No rubric for a search that never ran: "how sure are we that nothing is
  // recorded" has no answer when nothing was read. A percentage here would put
  // a number on an absence nobody measured.
  if (unavailableSearch(r)) return "The search is incomplete, so what your records hold is still unconfirmed.";
  const conf = r.confidence;
  if (!conf) return "";
  return (r.answer && !/^The documents do not answer/i.test(r.answer || "") ? "Confidence" : "Confidence in this search result") +
    ": " + conf.percent + "% (" + conf.band + "). " + conf.basis.join("; ") + ".";
}

/** Render only locally reviewed actions; older Workers fall back by status. */
export function nextActionText(r) {
  if (!r || typeof r !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(r, "next_action")) {
    return Object.values(REFUSAL_NEXT_ACTIONS).includes(r.next_action) ? r.next_action : null;
  }
  if (r.answer_error || (typeof r.answer === "string" && r.answer.trim() &&
      !/^The documents do not answer/i.test(r.answer.trim()))) return null;
  if (r.status === ANSWER_WITHHELD) {
    return refusalNextAction({ status: ANSWER_WITHHELD, withheldGate: "unsupported" });
  }
  if (r.status) return refusalNextAction({ status: r.status });
  // Older Workers can omit status and result metadata while search is down.
  if (unavailableSearch(r)) return refusalNextAction({ status: SEARCH_UNAVAILABLE });
  if (r.evidence_gate?.supported === false && Array.isArray(r.results) && r.results.length) {
    return refusalNextAction({ status: ANSWER_WITHHELD, withheldGate: "unsupported" });
  }
  return Array.isArray(r.results) && r.results.length === 0
    ? refusalNextAction()
    : null;
}
