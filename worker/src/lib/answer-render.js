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

/**
 * Reviewed owner-facing replacements for model and provider failures.
 *
 * Provider errors can contain request identifiers, implementation details, or
 * fragments copied from an upstream response. They are useful in protected
 * diagnostics, but they are not safe answer copy and must never ride the
 * public response into the app or CLI.
 */
export const ANSWER_ERROR_MESSAGES = Object.freeze({
  notConfigured: "Answer generation is not configured yet. Ask your installer to finish setup.",
  dailyLimit: "Answer generation has reached its daily limit. Try again after the limit resets.",
  verificationUnavailable: "The evidence check could not verify support, so no answer was shown. Try again in a moment.",
  unavailable: "Answer generation is unavailable right now. Try again in a moment.",
});

const REVIEWED_ANSWER_ERRORS = new Set(Object.values(ANSWER_ERROR_MESSAGES));

/** Convert a caught model failure to copy that is safe on every answer surface. */
export function answerGenerationError(error, { verification = false } = {}) {
  if (error?.no_key) return ANSWER_ERROR_MESSAGES.notConfigured;
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

export function answerText(r) {
  if (r.status === COVERAGE_INCOMPLETE) return r.notice || GENERIC_COVERAGE_NOTICE;
  if (unavailableSearch(r)) return r.notice || GENERIC_UNAVAILABLE_NOTICE;
  return r.answer || (r.answer_error ? safeAnswerErrorText(r.answer_error) : "The documents do not answer the question.");
}

/**
 * Evidence read by OCR from a scanned copy.
 *
 * A scan OCR read completely, with no unreadable page and no unreadable mark in
 * the passage relied on, can be the proof behind an answer. When it is, the
 * Worker adds one `scanned_evidence` gap and flags each such citation
 * `scanned: true`. Every surface then states this sentence and marks the
 * citation from these constants, never from a model's prose.
 */
export const SCANNED_EVIDENCE_GAP_TYPE = "scanned_evidence";
export const SCANNED_ANSWER_NOTICE =
  "Part of this answer comes from a scanned document read by OCR. Check the original for exact figures.";
export const SCANNED_RESULTS_NOTICE =
  "Some of these results come from a scanned document read by OCR. Check the original for exact figures.";
export const SCANNED_CITATION_MARK = "(scanned)";

/** The gap an answer, or a ranked result list, carries when a scan is part of its evidence. */
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

/**
 * Is this citation a scan the Worker accepted as evidence? The flag is the
 * contract, and only the Worker sets it: `text_source` "ocr" alone no longer
 * says a scan counted, because a complete read can still have an unreadable
 * mark in the passage cited. Every other OCR citation, and every citation
 * from an older Worker that never sends the flag, keeps its own OCR label
 * ("OCR text, verify key details" or "may be incomplete"), exactly as before.
 */
export function citationIsScanned(citation) {
  return citation?.scanned === true;
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
    ": " + conf.percent + "% (" + conf.band + ") — " + conf.basis.join("; ") + ".";
}
