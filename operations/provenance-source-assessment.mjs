/**
 * Read-only, local-upload assessment for retrospective provenance work.
 *
 * Callers supply one to ten exact source-relative locators. The complete local
 * walk resolves them by equality only; no filename or content similarity is
 * ever used. OCR is forced off. The default export path returns no locator,
 * raw path, extracted content, parser error, or content hash.
 */

import {
  MAX_LOCAL_ASSESSMENT_ORIGINALS,
  ORIGINAL_EXTRACTION_STATES,
  ORIGINAL_REASON_CODE_BY_STATE,
  canonicalLocalAssessmentLocator,
  localOriginalsForAssessment,
  observeLocalOriginal,
} from "../ingest/run.mjs";

export const PROVENANCE_SOURCE_ASSESSMENT_VERSION = 1;
export const PROVENANCE_SOURCE_ASSESSMENT_MAX_ORIGINALS = MAX_LOCAL_ASSESSMENT_ORIGINALS;
export const PROVENANCE_SOURCE_ASSESSMENT_STATES = ORIGINAL_EXTRACTION_STATES;
export const PROVENANCE_SOURCE_ASSESSMENT_REASON_CODE_BY_STATE = ORIGINAL_REASON_CODE_BY_STATE;

const STATE_SET = new Set(PROVENANCE_SOURCE_ASSESSMENT_STATES);

const safeFormat = (value) => {
  const normalized = String(value || "").toLowerCase().replace(/^\./, "");
  return /^[a-z0-9][a-z0-9+_-]{0,31}$/.test(normalized) ? normalized : "unknown";
};

function compatibleReason(state, supplied) {
  if (supplied === "source_policy_excluded" &&
      (state === "unsupported" || state === "unavailable")) {
    return supplied;
  }
  return PROVENANCE_SOURCE_ASSESSMENT_REASON_CODE_BY_STATE[state];
}

/** Allowlist the only per-original fields that may enter a public receipt. */
function publicOriginal(observation, ordinal) {
  const valid = observation && STATE_SET.has(observation.state);
  const observedState = valid ? observation.state : "extraction_failed";
  const state = observedState === "ocr_reliable" && observation?.text_reliable !== true
    ? "ocr_partial"
    : observedState;
  const format = safeFormat(observation?.format);
  const reasonCode = compatibleReason(state, observation?.reason_code);
  const outcome = state === "empty" || reasonCode === "source_policy_excluded"
    ? "adjudicated_exclusion"
    : "gap";
  const authoritativePdfPages = format === "pdf" &&
    observation?.page_count_authoritative === true &&
    Number.isInteger(observation?.page_count) &&
    observation.page_count >= 1 && observation.page_count <= 10_000;
  const pageCountState = format === "pdf"
    ? authoritativePdfPages ? "authoritative" : "unavailable"
    : "not_applicable";

  return Object.freeze({
    ordinal,
    observation_stage: "discovery",
    outcome,
    reason_code: reasonCode,
    // `text_state` is the durable table field. `state` is retained as a compact
    // read-only API alias; both are produced from the same closed value here.
    text_state: state,
    state,
    format,
    ...(typeof observation?.text_reliable === "boolean"
      ? { text_reliable: observation.text_reliable }
      : {}),
    ...(typeof observation?.extraction_complete === "boolean"
      ? { extraction_complete: observation.extraction_complete }
      : {}),
    page_count_state: pageCountState,
    ...(authoritativePdfPages
      ? { page_count: observation.page_count, page_count_authoritative: true }
      : {}),
    ...(observation?.multi_record === true ? { multi_record: true } : {}),
  });
}

const unique = (values) => Object.freeze([...new Set(values)]);

function publicReceipt({
  sourceKind,
  targetCount,
  traversalComplete,
  traversalGapCount,
  targetResolutionComplete,
  missingTargetCount,
  originals,
  blockers,
}) {
  const frozenOriginals = Object.freeze([...originals]);
  const frozenBlockers = unique(blockers);
  const assessmentComplete = frozenBlockers.length === 0;
  const gapCount = frozenOriginals.filter((original) => original.outcome === "gap").length;
  return Object.freeze({
    schema_version: PROVENANCE_SOURCE_ASSESSMENT_VERSION,
    operation: "provenance-source-assessment",
    mode: "read_only",
    read_only: true,
    source_kind: sourceKind,
    supported: sourceKind === "upload",
    // This lane can finish its observation without proving provenance coverage.
    complete: false,
    coverage_complete: false,
    assessment_complete: assessmentComplete,
    status: assessmentComplete ? "assessment_complete" : "blocked",
    max_originals: PROVENANCE_SOURCE_ASSESSMENT_MAX_ORIGINALS,
    target_count: Number.isInteger(targetCount) ? targetCount : null,
    assessed_original_count: frozenOriginals.length,
    gap_count: gapCount,
    adjudicated_exclusion_count: frozenOriginals.length - gapCount,
    truncated: false,
    traversal: Object.freeze({
      complete: traversalComplete === true,
      gap_count: Number.isInteger(traversalGapCount) && traversalGapCount >= 0
        ? traversalGapCount
        : null,
    }),
    target_resolution: Object.freeze({
      complete: targetResolutionComplete === true,
      missing_count: Number.isInteger(missingTargetCount) && missingTargetCount >= 0
        ? missingTargetCount
        : null,
      equality_only: true,
    }),
    ocr: Object.freeze({ enabled: false, attempted: false }),
    candidate_matching: Object.freeze({
      attempted: false,
      filename_similarity: false,
      content_similarity: false,
    }),
    accepted_repair: Object.freeze({
      attempted: false,
      available: false,
      reason_code: "complete_acceptance_chain_unavailable",
    }),
    originals: frozenOriginals,
    blockers: frozenBlockers,
    coverage_blockers: Object.freeze([
      "candidate_matching_not_attempted",
      "complete_acceptance_chain_unavailable",
    ]),
    limitations: Object.freeze([
      "local_upload_only",
      "one_to_ten_exact_relative_locators",
      "ocr_disabled",
      "no_filename_or_content_similarity_matching",
      "no_raw_paths_content_errors_or_hashes_in_public_output",
      "multi_record_originals_require_separate_identity_evidence",
      "raw_original_binding_alone_is_not_accepted_repair_evidence",
    ]),
  });
}

function privateObservation(observation, handle, ordinal, assessmentComplete) {
  const publicPart = publicOriginal(observation, ordinal);
  const contentHash = /^[a-f0-9]{64}$/.test(String(observation?.original_content_sha256 || ""))
    ? observation.original_content_sha256
    : null;
  const byteCount = Number.isSafeInteger(observation?.original_byte_count) &&
    observation.original_byte_count >= 0
    ? observation.original_byte_count
    : null;
  return Object.freeze({
    ordinal,
    position: ordinal - 1,
    assessment_complete: assessmentComplete === true,
    locator_kind: "source_relative_path",
    // PRIVATE: the public wrapper below never returns this field or this object.
    locator: typeof handle?._assessmentLocator === "string" ? handle._assessmentLocator : null,
    observation_stage: publicPart.observation_stage,
    outcome: publicPart.outcome,
    reason_code: publicPart.reason_code,
    text_state: publicPart.text_state,
    text_reliable: publicPart.text_reliable ?? null,
    original_content_sha256: contentHash,
    original_byte_count: byteCount,
    page_count: publicPart.page_count ?? null,
    page_count_state: publicPart.page_count_state,
    multi_record: publicPart.multi_record === true,
  });
}

function validatedTargets(relativeLocators) {
  if (!Array.isArray(relativeLocators) || relativeLocators.length < 1 ||
      relativeLocators.length > PROVENANCE_SOURCE_ASSESSMENT_MAX_ORIGINALS) {
    throw new TypeError(
      `provenance source assessment requires 1 to ${PROVENANCE_SOURCE_ASSESSMENT_MAX_ORIGINALS} exact relative locators`,
    );
  }
  const targets = relativeLocators.map(canonicalLocalAssessmentLocator);
  if (new Set(targets).size !== targets.length) {
    throw new TypeError("provenance source assessment locators must be unique");
  }
  return Object.freeze(targets);
}

const ORIGINAL_ID_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const CONTENT_SHA_RE = /^[a-f0-9]{64}$/;
const DISCOVERY_TRIPLES = new Set([
  "gap|provenance_unassessed|native_readable",
  "gap|provenance_unassessed|ocr_reliable",
  "gap|ocr_partial_review|ocr_partial",
  "gap|scan_only_ocr_needed|scan_only_ocr_needed",
  "gap|password_protected|password_protected",
  "gap|unsupported_format|unsupported",
  "gap|extraction_failed|extraction_failed",
  "gap|original_unavailable|unavailable",
  "adjudicated_exclusion|empty_original|empty",
  "adjudicated_exclusion|source_policy_excluded|unsupported",
  "adjudicated_exclusion|source_policy_excluded|unavailable",
]);

/**
 * Turn private local evidence plus a Worker-sealed identity into exactly one
 * record-mode discovery target. This is a pure shape/measurement fence only:
 * it never sends or records anything, and can never emit accepted/repair.
 */
export function formatPrivateDiscoveryObservationTarget(observation, sealedIdentity) {
  const locator = canonicalLocalAssessmentLocator(observation?.locator);
  const sealedLocator = canonicalLocalAssessmentLocator(sealedIdentity?.locator);
  if (observation?.locator_kind !== "source_relative_path" ||
      sealedIdentity?.locator_kind !== "source_relative_path" ||
      sealedLocator !== locator || sealedIdentity?.position !== observation?.position ||
      !Number.isSafeInteger(observation?.position) || observation.position < 0 ||
      !ORIGINAL_ID_RE.test(String(sealedIdentity?.original_id || ""))) {
    throw new TypeError("sealed original identity does not exactly match the assessed locator");
  }
  if (observation?.multi_record === true) {
    throw new TypeError("multi-record original evidence is ambiguous and cannot be formatted");
  }
  if (observation?.assessment_complete !== true) {
    throw new TypeError("blocked source assessment cannot be formatted for recording");
  }
  const triple = `${observation?.outcome}|${observation?.reason_code}|${observation?.text_state}`;
  if (observation?.observation_stage !== "discovery" || !DISCOVERY_TRIPLES.has(triple)) {
    throw new TypeError("assessment evidence is not a closed discovery outcome");
  }
  if (observation.text_state === "ocr_reliable" && observation.text_reliable !== true) {
    throw new TypeError("reliable OCR evidence requires an explicit reliability assertion");
  }

  const unavailable = observation.text_state === "unavailable";
  const contentHash = observation.original_content_sha256;
  const byteCount = observation.original_byte_count;
  if (unavailable) {
    if (contentHash !== null || byteCount !== null) {
      throw new TypeError("unavailable original evidence must use null content measurements");
    }
  } else if (!CONTENT_SHA_RE.test(String(contentHash || "")) ||
      !Number.isSafeInteger(byteCount) || byteCount < 0) {
    throw new TypeError("observed original evidence requires exact content measurements");
  }

  const pageCountState = observation.page_count_state;
  const pageCount = observation.page_count;
  if (pageCountState === "authoritative") {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10_000) {
      throw new TypeError("authoritative page evidence requires a bounded page count");
    }
  } else if (!["not_applicable", "unavailable"].includes(pageCountState) || pageCount !== null) {
    throw new TypeError("page count state and measurement do not agree");
  }

  return Object.freeze({
    locator_kind: "source_relative_path",
    locator,
    original_id: sealedIdentity.original_id,
    observation_stage: "discovery",
    outcome: observation.outcome,
    reason_code: observation.reason_code,
    text_state: observation.text_state,
    original_content_sha256: contentHash,
    original_byte_count: byteCount,
    page_count: pageCount,
    page_count_state: pageCountState,
    resolves_observation_hash: null,
  });
}

/**
 * PRIVATE/INTERNAL handoff. Never print or JSON-serialize the returned
 * `private_observations`; they contain exact source-relative locators for the
 * authenticated Worker sealing boundary. They never contain extracted text or
 * parser error prose.
 */
export async function collectPrivateLocalProvenanceAssessment({
  sourceKind = "upload",
  root,
  relativeLocators,
  privatePrefixes = [],
} = {}, {
  listOriginals = localOriginalsForAssessment,
  observeOriginal = observeLocalOriginal,
} = {}) {
  const normalizedKind = String(sourceKind || "").toLowerCase();
  if (normalizedKind !== "upload") {
    return Object.freeze({
      assessment: publicReceipt({
        sourceKind: "unsupported",
        targetCount: Array.isArray(relativeLocators) ? relativeLocators.length : null,
        traversalComplete: false,
        traversalGapCount: null,
        targetResolutionComplete: false,
        missingTargetCount: null,
        originals: [],
        blockers: ["source_kind_not_local_upload"],
      }),
      private_observations: Object.freeze([]),
    });
  }
  const targets = validatedTargets(relativeLocators);

  let listed;
  try {
    listed = await listOriginals(root, { privatePrefixes, relativeLocators: targets });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return Object.freeze({
      assessment: publicReceipt({
        sourceKind: normalizedKind,
        targetCount: targets.length,
        traversalComplete: false,
        traversalGapCount: null,
        targetResolutionComplete: false,
        missingTargetCount: null,
        originals: [],
        blockers: ["source_traversal_unavailable"],
      }),
      private_observations: Object.freeze([]),
    });
  }

  const handles = Array.isArray(listed?.originals) ? listed.originals : [];
  const locatorMismatchCount = targets.filter((target, index) =>
    handles[index]?._assessmentLocator !== target).length;
  const targetResolutionComplete = listed?.traversal_complete === true &&
    listed?.target_resolution_complete === true &&
    handles.length === targets.length && locatorMismatchCount === 0;
  const missingTargetCount = listed?.traversal_complete !== true
    ? null
    : targetResolutionComplete
      ? 0
      : Math.max(
          Number.isInteger(listed?.missing_target_count) ? listed.missing_target_count : 0,
          locatorMismatchCount,
          Math.abs(handles.length - targets.length),
        );
  const validResolution = targetResolutionComplete;
  const observations = [];
  if (validResolution) {
    for (const handle of handles) {
      let observed;
      try {
        // One argument on purpose. No OCR callback or mutating client can enter.
        observed = await observeOriginal(handle);
      } catch {
        observed = {
          state: "unavailable",
          format: "unknown",
          reason_code: "original_unavailable",
          extraction_complete: false,
        };
      }
      observations.push(observed);
    }
  } else {
    // Fail closed before target observation. The run-layer resolver returns only
    // markers in this case, but do not depend on that implementation detail.
    for (let index = 0; index < targets.length; index++) {
      observations.push({
        state: "unavailable",
        format: safeFormat(targets[index].split(".").pop()),
        reason_code: "original_unavailable",
        extraction_complete: false,
      });
    }
  }

  const publicOriginals = observations.map((observation, index) =>
    publicOriginal(observation, index + 1));
  const blockers = [];
  if (listed?.traversal_complete !== true) blockers.push("source_traversal_incomplete");
  if (!targetResolutionComplete) blockers.push("exact_target_resolution_incomplete");
  if (publicOriginals.some((original) => original.multi_record === true)) {
    blockers.push("multi_record_ambiguity");
  }
  if (publicOriginals.some((original) =>
    original.state === "unavailable" && original.outcome !== "adjudicated_exclusion")) {
    blockers.push("original_unavailable");
  }

  const assessment = publicReceipt({
    sourceKind: normalizedKind,
    targetCount: targets.length,
    traversalComplete: listed?.traversal_complete === true,
    traversalGapCount: listed?.traversal_gap_count,
    targetResolutionComplete,
    missingTargetCount,
    originals: publicOriginals,
    blockers,
  });
  const privateObservations = validResolution
    ? observations.map((observation, index) =>
        privateObservation(observation, handles[index], index + 1, assessment.assessment_complete))
    : [];
  return Object.freeze({
    assessment,
    private_observations: Object.freeze(privateObservations),
  });
}

/** Public/default lane. Exact locators and content receipts are never returned. */
export async function assessLocalProvenanceSource(input = {}, dependencies = {}) {
  return (await collectPrivateLocalProvenanceAssessment(input, dependencies)).assessment;
}
