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
  absenceUnproven, COVERAGE_INCOMPLETE, coverageIncompleteNotice, unavailableNotice,
} from "./retrieval-status.js";

// The fallback when the worker sent no notice of its own — an older worker, or
// one that only set `degraded`. Derived from the same source as every other
// notice so the wording can never drift between surfaces.
const GENERIC_UNAVAILABLE_NOTICE = unavailableNotice("unknown");
const GENERIC_COVERAGE_NOTICE = coverageIncompleteNotice(false);

/** Reviewed messages a Worker may return instead of raw provider errors. */
export const ANSWER_ERROR_MESSAGES = Object.freeze({
  notConfigured: "Answer generation is not configured yet. Ask your installer to finish setup.",
  dailyLimit: "Answer generation has reached its daily limit. Try again after the limit resets.",
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
  return r.answer || (r.answer_error ? safeAnswerErrorText(r.answer_error) : "The documents do not answer the question.");
}

/**
 * Evidence read by OCR from a scanned copy. The same fixed words as the
 * Worker's answer-render.js, so the page never depends on a model to say it.
 */
export const SCANNED_EVIDENCE_GAP_TYPE = "scanned_evidence";
export const SCANNED_ANSWER_NOTICE =
  "Part of this answer comes from a scanned document read by OCR. Check the original for exact figures.";
export const SCANNED_CITATION_MARK = "(scanned)";

/** A complete OCR read. A partial read keeps its own "may be incomplete" label. */
export function citationIsScanned(citation) {
  return citation?.scanned === true || citation?.text_source === "ocr";
}

/** The sentence to show beside a displayed answer that rests on a scan, or null. */
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
  if (r.status === COVERAGE_INCOMPLETE) {
    return "Source coverage is incomplete. This result is provisional.";
  }
  // No rubric for a search that never ran: "how sure are we that nothing is
  // recorded" has no answer when nothing was read. A percentage here would put
  // a number on an absence nobody measured.
  if (unavailableSearch(r)) return "Search incomplete. This is not a statement about what your brain holds.";
  const conf = r.confidence;
  if (!conf) return "";
  return (r.answer && !/^The documents do not answer/.test(r.answer || "") ? "Confidence" : "Confidence nothing is recorded") +
    ": " + conf.percent + "% (" + conf.band + "). " + conf.basis.join("; ") + ".";
}
