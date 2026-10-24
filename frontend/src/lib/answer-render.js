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
  notConfigured: "Answer generation is not configured yet. Ask your installer to finish setup.",
  keyMissing: "Answers are paused: this Brain is set to answer with Claude, but its Anthropic key is missing. Search still works.",
  providerAccount: "Answers are paused: your Anthropic account needs attention (its key or its credit balance). Search still works.",
  dailyLimit: "Answers have reached today's spending limit. They start again at midnight UTC, or sooner if the limit is raised. Search still works.",
  dailyLimitLegacy: "Answer generation has reached its daily limit. Try again after the limit resets.",
  spendCheckPaused: "Answers are paused for a few minutes while your Brain rechecks its spending record. Try again shortly. Search still works.",
  verificationUnavailable: "The evidence check could not verify support, so no answer was shown. Try again in a moment.",
  unavailable: "Answer generation is unavailable right now. Try again in a moment.",
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

export function answerText(r) {
  if (r.status === COVERAGE_INCOMPLETE) return r.notice || GENERIC_COVERAGE_NOTICE;
  if (unavailableSearch(r)) return r.notice || GENERIC_UNAVAILABLE_NOTICE;
  if (r.answer_error && !r.answer) {
    const message = safeAnswerErrorText(r.answer_error);
    const reset = Date.parse(r.answer_resumes_at || "");
    return message === ANSWER_ERROR_MESSAGES.dailyLimit && Number.isFinite(reset)
      ? `${message} Answers start again ${new Date(reset).toLocaleString()}.`
      : message;
  }
  if (r.answer && !/^The documents do not answer/i.test(r.answer)) return r.answer;
  // A refusal is about the records checked, even when retrieval was healthy.
  // Missing result metadata must not become a fabricated zero count.
  if (!Array.isArray(r.results)) return "The records checked did not support an answer to this question.";
  const count = r.results.length;
  return count
    ? `I found ${count} ${count === 1 ? "record" : "records"} in this search, but none supported an answer to this question.`
    : "I didn't find a matching record in this search.";
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
    return "Answer withheld by an evidence check. No confidence percentage is shown.";
  }
  if (r.status === COVERAGE_INCOMPLETE) {
    return "Source coverage is incomplete. This result is provisional.";
  }
  // No rubric for a search that never ran: "how sure are we that nothing is
  // recorded" has no answer when nothing was read. A percentage here would put
  // a number on an absence nobody measured.
  if (unavailableSearch(r)) return "Search incomplete. This is not a statement about what your brain holds.";
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
