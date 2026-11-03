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
  REFUSAL_NEXT_ACTIONS, refusalNextAction, unavailableNotice,
} from "./retrieval-status.js";

// The fallback when the worker sent no notice of its own — an older worker, or
// one that only set `degraded`. Derived from the same source as every other
// notice so the wording can never drift between surfaces.
const GENERIC_UNAVAILABLE_NOTICE = unavailableNotice("unknown");
const GENERIC_COVERAGE_NOTICE = coverageIncompleteNotice(false);

/** Reviewed messages a Worker may return instead of raw provider errors. */
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

const REVIEWED_ANSWER_ERRORS = new Set(Object.values(ANSWER_ERROR_MESSAGES));

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
  const facts = text.replace(/(?:^|(?<=[.!?])\s+)(Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\.)/g,
    (_, offer) => { offers.push(offer); return ""; }).trim();
  return { facts, offers };
}

export function answerText(r) {
  if (r.status === COVERAGE_INCOMPLETE) {
    const notice = r.notice || GENERIC_COVERAGE_NOTICE;
    return moneyExplanation(r) ? notice.replaceAll("Source coverage", "The connected records") : notice;
  }
  if (unavailableSearch(r)) return r.notice || GENERIC_UNAVAILABLE_NOTICE;
  if (r.answer_error && !r.answer) {
    const message = safeAnswerErrorText(r.answer_error);
    const reset = Date.parse(r.answer_resumes_at || "");
    return message === ANSWER_ERROR_MESSAGES.dailyLimit && Number.isFinite(reset)
      ? `${message} Answers start again ${new Date(reset).toLocaleString()}.`
      : message;
  }
  if (r.answer && !/^The documents do not answer/i.test(r.answer)) {
    const explanation = moneyExplanation(r);
    if (r.ledger || r.clarification) {
      const composed = separateOffers(r.answer);
      const extra = separateOffers(explanation).facts.split("\n")
        .filter(line => line && !composed.facts.includes(line)).join("\n");
      // A composed ledger answer already chose its invitation. Missing gap
      // facts belong before it; gap invitations must never be restored here.
      return extra ? [composed.facts, extra, ...composed.offers].filter(Boolean).join("\n") : r.answer;
    }
    const extra = explanation.split("\n").filter(line => line && !r.answer.includes(line)).join("\n");
    return extra ? `${r.answer}\n\n${extra}` : r.answer;
  }
  const explanation = moneyExplanation(r);
  if (explanation) return explanation;
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
export const SCANNED_CITATION_MARK = "(scanned)";

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
  if (r.evidence_gate?.supported === false && Array.isArray(r.results) && r.results.length) {
    return refusalNextAction({ status: ANSWER_WITHHELD, withheldGate: "unsupported" });
  }
  return Array.isArray(r.results) && r.results.length === 0
    ? refusalNextAction()
    : null;
}
