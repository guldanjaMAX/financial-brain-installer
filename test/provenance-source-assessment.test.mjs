import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { extractPdf } from "../ingest/formats.mjs";
import {
  ORIGINAL_EXTRACTION_STATES,
  ORIGINAL_REASON_CODE_BY_STATE,
  canonicalLocalAssessmentLocator,
  localOriginalsForAssessment,
  observeLocalOriginal,
  originalObservationFromExtraction,
} from "../ingest/run.mjs";
import {
  PROVENANCE_SOURCE_ASSESSMENT_MAX_ORIGINALS,
  PROVENANCE_SOURCE_ASSESSMENT_REASON_CODE_BY_STATE,
  PROVENANCE_SOURCE_ASSESSMENT_STATES,
  assessLocalProvenanceSource,
  collectPrivateLocalProvenanceAssessment,
  formatPrivateDiscoveryObservationTarget,
} from "../operations/provenance-source-assessment.mjs";
import { SOURCE_ORIGINAL_OBSERVATION_VOCABULARY } from
  "../worker/src/lib/source-original-observation.js";

const REQUIRED_STATES = [
  "native_readable",
  "ocr_reliable",
  "ocr_partial",
  "scan_only_ocr_needed",
  "empty",
  "password_protected",
  "unsupported",
  "extraction_failed",
  "unavailable",
];
const SHA_EMPTY = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const SEALED_ORIGINAL_ID = `hmac-sha256:${"a".repeat(64)}`;

assert.deepEqual(ORIGINAL_EXTRACTION_STATES, REQUIRED_STATES);
assert.deepEqual(PROVENANCE_SOURCE_ASSESSMENT_STATES, REQUIRED_STATES);
assert.deepEqual(SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.text_states, REQUIRED_STATES);
assert.deepEqual(SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.page_count_states,
  ["authoritative", "not_applicable", "unavailable"]);
assert.equal(PROVENANCE_SOURCE_ASSESSMENT_MAX_ORIGINALS, 10);
assert.deepEqual(PROVENANCE_SOURCE_ASSESSMENT_REASON_CODE_BY_STATE, ORIGINAL_REASON_CODE_BY_STATE);
assert.deepEqual(ORIGINAL_REASON_CODE_BY_STATE, {
  native_readable: "provenance_unassessed",
  ocr_reliable: "provenance_unassessed",
  ocr_partial: "ocr_partial_review",
  scan_only_ocr_needed: "scan_only_ocr_needed",
  empty: "empty_original",
  password_protected: "password_protected",
  unsupported: "unsupported_format",
  extraction_failed: "extraction_failed",
  unavailable: "original_unavailable",
});
for (const reasonCode of Object.values(ORIGINAL_REASON_CODE_BY_STATE)) {
  assert(SOURCE_ORIGINAL_OBSERVATION_VOCABULARY.reason_codes.includes(reasonCode));
}

/* PDF facts are structured at the parser boundary, not recovered from prose. */
{
  const native = await extractPdf(Buffer.from("synthetic"), {}, {
    pdfPassImpl: async () => ({
      body: "A directly extracted native PDF sentence. ".repeat(12),
      totalPages: 3,
      perPage: 160,
    }),
  });
  assert.deepEqual(native.observation, {
    state: "native_readable",
    format: "pdf",
    page_count: 3,
    page_count_authoritative: true,
    text_reliable: true,
    extraction_complete: true,
    reason_code: "provenance_unassessed",
  });

  const scan = await extractPdf(Buffer.from("synthetic"), {}, {
    pdfPassImpl: async () => ({ body: "", totalPages: 7, perPage: 0 }),
  });
  assert.equal(scan.observation.state, "scan_only_ocr_needed");
  assert.equal(scan.observation.reason_code, "scan_only_ocr_needed");
  assert.equal(scan.observation.page_count, 7);
  assert.equal(scan.observation.page_count_authoritative, true);

  const impossiblePageCount = await extractPdf(Buffer.from("synthetic"), {}, {
    pdfPassImpl: async () => ({
      body: "A readable synthetic PDF body. ".repeat(12),
      totalPages: 0,
      perPage: 160,
    }),
  });
  assert.equal("page_count" in impossiblePageCount.observation, false);
  assert.equal("page_count_authoritative" in impossiblePageCount.observation, false);

  const passwordError = new Error("locked");
  passwordError.name = "PasswordException";
  const locked = await extractPdf(Buffer.from("synthetic"), {}, {
    pdfPassImpl: async () => { throw passwordError; },
  });
  assert.equal(locked.observation.state, "password_protected");
  assert.equal(locked.observation.reason_code, "password_protected");
  assert.equal("page_count" in locked.observation, false);

  const failed = await extractPdf(Buffer.from("synthetic"), {}, {
    pdfPassImpl: async () => ({ text: null, error: "synthetic parser refusal" }),
  });
  assert.equal(failed.observation.state, "extraction_failed");
  assert.equal(failed.observation.reason_code, "extraction_failed");
  assert.equal("page_count" in failed.observation, false);

  const ocr = async () => ({
    text: "Account statement line with date amount and description. ".repeat(8),
  });
  ocr.model = "synthetic-ocr";
  const unverifiedOcr = await extractPdf(Buffer.from("synthetic"), { ocr }, {
    pdfPassImpl: async () => ({
      body: "",
      totalPages: 1,
      perPage: 0,
      pageImages: [{ page: 1, data: "synthetic" }],
    }),
  });
  assert.equal(unverifiedOcr.observation.state, "ocr_partial");
  assert.equal(unverifiedOcr.observation.reason_code, "ocr_partial_review");
  assert.equal(unverifiedOcr.observation.text_reliable, false);
}

/* No structured or legacy OCR result can overclaim reliability. */
{
  assert.equal(originalObservationFromExtraction({
    text: "synthetic OCR text",
    provenance: { text_source: "ocr", text_reliable: false },
  }, { format: "pdf" }).state, "ocr_partial");
  assert.equal(originalObservationFromExtraction({
    text: "synthetic OCR text",
    provenance: { text_source: "ocr", text_reliable: true },
  }, { format: "pdf" }).state, "ocr_reliable");
  assert.equal(originalObservationFromExtraction({
    observation: {
      state: "ocr_reliable",
      format: "pdf",
      text_reliable: false,
      extraction_complete: true,
    },
  }).state, "ocr_partial");
}

/* Locators use the same NFC and UTF-8 byte contract as the Worker. */
{
  assert.equal(canonicalLocalAssessmentLocator("nested/é.pdf"), "nested/é.pdf");
  assert.equal(canonicalLocalAssessmentLocator("C:/report.pdf"), "C:/report.pdf");
  for (const locator of [
    "/absolute.pdf",
    "trailing/",
    "double//segment.pdf",
    "parent/../file.pdf",
    "dot/./file.pdf",
    "windows\\file.pdf",
    "line\tbreak.pdf",
    "nested/e\u0301.pdf",
    `${"é".repeat(1025)}.pdf`,
  ]) {
    assert.throws(() => canonicalLocalAssessmentLocator(locator), /local assessment target/);
  }
}

/* The public receipt preserves states while allowlisting away private data. */
{
  let observedCalls = 0;
  const locators = REQUIRED_STATES.map((_, index) => `original-${index}.txt`);
  const handles = REQUIRED_STATES.map((state, index) => ({
    state,
    _assessmentLocator: locators[index],
    private_path: `/synthetic/private/original-${index}`,
    raw_content: `synthetic private body ${index}`,
  }));
  const result = await assessLocalProvenanceSource({
    sourceKind: "upload",
    root: "/synthetic/private/root",
    relativeLocators: locators,
  }, {
    listOriginals: async (_root, options) => {
      assert.deepEqual(options.relativeLocators, locators);
      return {
        originals: handles,
        target_count: handles.length,
        traversal_complete: true,
        traversal_gap_count: 0,
        target_resolution_complete: true,
        missing_target_count: 0,
      };
    },
    observeOriginal: async function observe(handle) {
      observedCalls++;
      assert.equal(arguments.length, 1, "no OCR/options argument may reach observation");
      return {
        state: handle.state,
        format: handle.state === "scan_only_ocr_needed" ? "pdf" : "txt",
        reason_code: "not_a_closed_reason",
        text_reliable: handle.state === "ocr_reliable",
        extraction_complete: handle.state === "native_readable" || handle.state === "ocr_reliable",
        ...(handle.state === "scan_only_ocr_needed"
          ? { page_count: 4, page_count_authoritative: true }
          : { page_count: 999, page_count_authoritative: false }),
        original_content_sha256: "b".repeat(64),
        original_byte_count: 123,
        private_path: handle.private_path,
        content: handle.raw_content,
        error: handle.raw_content,
      };
    },
  });

  assert.equal(observedCalls, REQUIRED_STATES.length);
  assert.deepEqual(result.originals.map((item) => item.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(result.originals.map((item) => item.state), REQUIRED_STATES);
  assert.deepEqual(result.originals.map((item) => item.text_state), REQUIRED_STATES);
  assert.deepEqual(result.originals.map((item) => item.reason_code),
    REQUIRED_STATES.map((state) => ORIGINAL_REASON_CODE_BY_STATE[state]));
  assert.equal(result.ocr.enabled, false);
  assert.equal(result.ocr.attempted, false);
  assert.equal(result.candidate_matching.attempted, false);
  assert.equal(result.accepted_repair.available, false);
  assert.equal(result.accepted_repair.reason_code, "durable_original_byte_binding_unverified");
  assert(result.coverage_blockers.includes("durable_original_byte_binding_unverified"));
  assert.equal(result.originals.find((item) => item.format === "pdf").page_count, 4);
  assert.equal(result.originals.find((item) => item.format === "pdf").page_count_state, "authoritative");
  assert.equal(result.originals.some((item) => item.page_count === 999), false);
  assert.equal(result.complete, false);
  assert.equal(result.assessment_complete, false);
  assert.equal(result.coverage_complete, false);
  assert(result.blockers.includes("original_unavailable"));
  const publicJson = JSON.stringify(result);
  assert.equal(publicJson.includes("/synthetic/private"), false);
  assert.equal(publicJson.includes("synthetic private body"), false);
  assert.equal(publicJson.includes("private_path"), false);
  assert.equal(publicJson.includes("original_content_sha256"), false);
  assert.equal(publicJson.includes('"content"'), false);
  assert.equal(publicJson.includes('"error"'), false);
}

/* Non-upload kinds stop before touching any source. */
{
  let listed = false;
  const result = await assessLocalProvenanceSource({
    sourceKind: "drive",
    root: "/must/not/be/read",
  }, {
    listOriginals: () => { listed = true; throw new Error("must not run"); },
  });
  assert.equal(listed, false);
  assert.equal(result.supported, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.blockers, ["source_kind_not_local_upload"]);
}

/* Incomplete traversal and handle mismatches stop before any original opens. */
{
  let observedCalls = 0;
  const result = await assessLocalProvenanceSource({
    root: "/synthetic",
    relativeLocators: ["one.md"],
  }, {
    listOriginals: () => ({
      originals: [{ _assessmentLocator: "one.md" }],
      traversal_complete: false,
      traversal_gap_count: 1,
      target_resolution_complete: true,
      missing_target_count: 0,
    }),
    observeOriginal: () => { observedCalls++; throw new Error("must not run"); },
  });
  assert.equal(observedCalls, 0);
  assert.equal(result.traversal.complete, false);
  assert.equal(result.target_resolution.complete, false);
  assert.equal(result.target_resolution.missing_count, null);
  assert(result.blockers.includes("source_traversal_incomplete"));
  assert(result.blockers.includes("exact_target_resolution_incomplete"));
  assert.equal(JSON.stringify(result).includes("one.md"), false);
}

{
  let observedCalls = 0;
  const result = await assessLocalProvenanceSource({
    root: "/synthetic",
    relativeLocators: ["exact.md"],
  }, {
    listOriginals: () => ({
      originals: [{ _assessmentLocator: "near-match.md" }],
      traversal_complete: true,
      traversal_gap_count: 0,
      target_resolution_complete: true,
      missing_target_count: 0,
    }),
    observeOriginal: () => { observedCalls++; throw new Error("must not run"); },
  });
  assert.equal(observedCalls, 0);
  assert.equal(result.target_resolution.complete, false);
  assert.equal(result.target_resolution.missing_count, 1);
  assert(result.blockers.includes("exact_target_resolution_incomplete"));
}

const makeRoot = (label) => mkdtempSync(join(tmpdir(), `brain-${label}-`));
const put = (root, rel, content) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/* Real files use exact target resolution and the safe descriptor read path. */
{
  const root = makeRoot("source-assessment");
  try {
    const locators = ["docs/readable.md", "docs/empty.txt", "docs/unsupported.bin"];
    put(root, locators[0], "This synthetic document has enough ordinary native text to pass the extraction quality floor.");
    put(root, locators[1], "");
    put(root, locators[2], Buffer.from("synthetic unsupported bytes"));

    const internal = await collectPrivateLocalProvenanceAssessment({ root, relativeLocators: locators });
    const result = internal.assessment;
    assert.equal(result.supported, true);
    assert.equal(result.complete, false, "assessment never claims provenance completeness");
    assert.equal(result.assessment_complete, true);
    assert.equal(result.coverage_complete, false);
    assert.equal(result.target_count, 3);
    assert.equal(result.assessed_original_count, 3);
    assert.equal(result.originals.find((item) => item.format === "md")?.state, "native_readable");
    assert.equal(result.originals.find((item) => item.format === "txt")?.state, "empty");
    assert.equal(result.originals.find((item) => item.format === "bin")?.state, "unsupported");
    assert.equal(result.gap_count, 2);
    assert.equal(result.adjudicated_exclusion_count, 1);
    assert.equal(result.ocr.attempted, false);

    const publicJson = JSON.stringify(result);
    assert.equal(publicJson.includes(root), false);
    assert.equal(publicJson.includes("docs/readable.md"), false);
    assert.equal(publicJson.includes("ordinary native text"), false);
    assert.equal(publicJson.includes("original_content_sha256"), false);

    assert.equal(internal.private_observations.length, 3);
    const privateReadable = internal.private_observations[0];
    assert.equal(privateReadable.locator, locators[0]);
    assert.match(privateReadable.original_content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(privateReadable.original_byte_count > 0, true);

    const recordTarget = formatPrivateDiscoveryObservationTarget(privateReadable, {
      position: 0,
      locator_kind: "source_relative_path",
      locator: locators[0],
      original_id: SEALED_ORIGINAL_ID,
    });
    assert.deepEqual(Object.keys(recordTarget), [
      "locator_kind", "locator", "original_id", "observation_stage", "outcome",
      "reason_code", "text_state", "original_content_sha256", "original_byte_count",
      "page_count", "page_count_state", "resolves_observation_hash",
    ]);
    assert.equal(recordTarget.observation_stage, "discovery");
    assert.equal(recordTarget.outcome, "gap");
    assert.equal(recordTarget.resolves_observation_hash, null);
    assert.equal(recordTarget.page_count, null);
    assert.equal(recordTarget.page_count_state, "not_applicable");

    assert.throws(() => formatPrivateDiscoveryObservationTarget(privateReadable, {
      position: 0,
      locator_kind: "source_relative_path",
      locator: "docs/near-match.md",
      original_id: SEALED_ORIGINAL_ID,
    }), /does not exactly match/);
    assert.throws(() => formatPrivateDiscoveryObservationTarget({
      ...privateReadable,
      original_content_sha256: null,
    }, {
      position: 0,
      locator_kind: "source_relative_path",
      locator: locators[0],
      original_id: SEALED_ORIGINAL_ID,
    }), /requires exact content measurements/);

    const privateEmpty = internal.private_observations[1];
    assert.equal(privateEmpty.original_content_sha256, SHA_EMPTY);
    assert.equal(privateEmpty.original_byte_count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* Missing targets cannot be replaced by a same-name or same-content file. */
{
  const root = makeRoot("source-exact");
  try {
    put(root, "elsewhere/report.md", "Identical synthetic content does not establish original identity.");
    const listed = localOriginalsForAssessment(root, { relativeLocators: ["missing/report.md"] });
    assert.equal(listed.traversal_complete, true);
    assert.equal(listed.target_resolution_complete, false);
    assert.equal(listed.missing_target_count, 1);
    assert.equal(listed.originals[0]._assessmentLocator, "missing/report.md");

    const result = await assessLocalProvenanceSource({ root, relativeLocators: ["missing/report.md"] });
    assert.equal(result.target_resolution.complete, false);
    assert.equal(result.originals[0].state, "unavailable");
    assert.equal(result.candidate_matching.filename_similarity, false);
    assert.equal(result.candidate_matching.content_similarity, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* A path outside the canonical locator domain makes traversal incomplete. */
{
  const root = makeRoot("source-noncanonical");
  try {
    put(root, "good.md", "This ordinary synthetic record is long enough for native extraction.");
    put(root, "bad\\name.txt", "This path cannot be represented in the sealed locator contract.");
    const listed = localOriginalsForAssessment(root, { relativeLocators: ["good.md"] });
    assert.equal(listed.traversal_complete, false);
    assert.equal(listed.traversal_gap_count, 1);
    assert.equal(listed.target_resolution_complete, false);
    assert.equal(listed.originals[0]._assessmentObservation.state, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* A file seen empty by traversal is descriptor-read before it is classified. */
{
  const root = makeRoot("source-empty-race");
  try {
    put(root, "empty.txt", "");
    const listed = localOriginalsForAssessment(root, { relativeLocators: ["empty.txt"] });
    put(root, "empty.txt", "The file changed after traversal, so the empty receipt is no longer valid.");
    const observation = await observeLocalOriginal(listed.originals[0]);
    assert.equal(observation.state, "native_readable");
    assert.match(observation.original_content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(observation.original_byte_count > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* Source-policy exclusions are explicit exclusions, not guessed absence. */
{
  const root = makeRoot("source-policy");
  try {
    put(root, "restricted/item.txt", "Synthetic policy-excluded content.");
    const internal = await collectPrivateLocalProvenanceAssessment({
      root,
      relativeLocators: ["restricted/item.txt"],
      privatePrefixes: ["restricted"],
    });
    assert.equal(internal.assessment.assessment_complete, true);
    assert.deepEqual(internal.assessment.blockers, []);
    assert.equal(internal.assessment.originals[0].outcome, "adjudicated_exclusion");
    assert.equal(internal.assessment.originals[0].reason_code, "source_policy_excluded");

    const target = formatPrivateDiscoveryObservationTarget(internal.private_observations[0], {
      position: 0,
      locator_kind: "source_relative_path",
      locator: "restricted/item.txt",
      original_id: SEALED_ORIGINAL_ID,
    });
    assert.equal(target.outcome, "adjudicated_exclusion");
    assert.equal(target.reason_code, "source_policy_excluded");
    assert.equal(target.original_content_sha256, null);
    assert.equal(target.original_byte_count, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* Archives may produce many records and therefore block the bounded lane. */
{
  const root = makeRoot("source-archive");
  try {
    const locators = ["mail.mbox", "records.zip"];
    put(root, locators[0], "From sender@example.test Sat Jan 01 00:00:00 2022\nSubject: Synthetic\n\nBody\n");
    put(root, locators[1], Buffer.from("synthetic archive bytes"));
    const internal = await collectPrivateLocalProvenanceAssessment({ root, relativeLocators: locators });
    assert(internal.assessment.blockers.includes("multi_record_ambiguity"));
    assert.equal(internal.assessment.originals.length, 2);
    assert(internal.assessment.originals.every((item) =>
      item.state === "unsupported" && item.multi_record === true &&
      item.reason_code === "unsupported_format"));
    assert.equal(JSON.stringify(internal.assessment).includes("mail.mbox"), false);
    assert.throws(() => formatPrivateDiscoveryObservationTarget(
      internal.private_observations[0],
      {
        position: 0,
        locator_kind: "source_relative_path",
        locator: locators[0],
        original_id: SEALED_ORIGINAL_ID,
      },
    ), /multi-record original evidence is ambiguous/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* The caller must name exactly one to ten unique canonical targets. */
{
  let listed = false;
  const dependencies = {
    listOriginals: () => { listed = true; throw new Error("must not run"); },
  };
  await assert.rejects(
    assessLocalProvenanceSource({
      root: "/synthetic",
      relativeLocators: Array.from({ length: 11 }, (_, index) => `${index}.md`),
    }, dependencies),
    /1 to 10/,
  );
  await assert.rejects(
    assessLocalProvenanceSource({
      root: "/synthetic",
      relativeLocators: ["same.md", "same.md"],
    }, dependencies),
    /must be unique/,
  );
  assert.equal(listed, false);
}

console.log("provenance-source-assessment: all tests passed");
