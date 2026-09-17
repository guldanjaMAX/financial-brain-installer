// Owner-authored questions extend acceptance with optional private regression
// checks. An empty list is normal and must never become onboarding homework.
// The runtime still names the optional skip and points to the separate handoff
// gate: one real item proved accepted, stored with provenance, projected, and
// query-visible with a citation. Legacy summaries that truly mark retrieval as
// untested remain qualified without telling the owner to prepare questions.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Acceptance, acceptanceVerdict, answerUnavailableDiagnostic,
  RETRIEVAL_RETRY_DEFAULTS, retrievalRetryBudget, workerDegradationDetail,
  DEGRADED_CLASSIFICATION, RETRIEVAL_FAILURE_DEGRADED, EXPECTED_DEGRADED,
  isRetrievalFailureDegradation,
} from "../acceptance.mjs";
import { computeVerdict } from "../report-html.mjs";
import { optionalProbeQuestionsNotice } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

/* ------------------------------------------------ 1. summary honesty */

{
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  await suite.tierRetrieval([]);
  const out = suite.summary();
  check("an empty probe list is recorded as a tier-3 skip",
    out.results.some((r) => r.tier === 3 && r.status === "skip" && /optional owner-question/i.test(r.name)),
    JSON.stringify(out.results));
  check("the summary names only optional owner questions as untested",
    Array.isArray(out.untested) && out.untested.includes("optional_owner_questions") && !out.untested.includes("retrieval"),
    JSON.stringify(out.untested));
  check("an optional question skip is not a failed tier",
    out.passed === true, JSON.stringify(out));
  check("the actual skip output says zero prepared questions are required",
    out.results.some((r) => /zero are required.*setup.*adaptive acceptance.*handoff/i.test(r.detail)),
    JSON.stringify(out.results));
}

{
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  await suite.tierRetrieval(["   "]);
  const out = suite.summary();
  check("a whitespace-only saved question is treated as no optional question",
    out.untested.includes("optional_owner_questions") &&
      out.results.some((r) => r.name === "optional owner-question checks" && r.status === "skip"),
    JSON.stringify(out));
}

{
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.record(3, "probe: what did we agree", "pass", "3 result(s)");
  const out = suite.summary();
  check("a tested retrieval tier leaves untested empty",
    Array.isArray(out.untested) && out.untested.length === 0,
    JSON.stringify(out.untested));
}

/* ------------------------------------------- 2. the terminal verdict */

{
  const tested = acceptanceVerdict({ passed: true, untested: [], counts: { pass: 5, fail: 0, warn: 0, skip: 0 } });
  check("a fully tested pass keeps the plain headline",
    tested.headline === "automated acceptance checks passed", JSON.stringify(tested));
  check("a fully tested pass carries no warnings",
    Array.isArray(tested.warnings) && tested.warnings.length === 0, JSON.stringify(tested));
  check("a fully tested pass needs no optional note",
    Array.isArray(tested.notes) && tested.notes.length === 0, JSON.stringify(tested));
}

{
  const optional = acceptanceVerdict({ passed: true, untested: ["optional_owner_questions"], counts: { pass: 5, fail: 0, warn: 0, skip: 1 } });
  check("no saved owner questions keep the automated pass headline",
    optional.headline === "automated acceptance checks passed", JSON.stringify(optional.headline));
  check("no saved owner questions produce no warning",
    Array.isArray(optional.warnings) && optional.warnings.length === 0,
    JSON.stringify(optional.warnings));
  const note = (optional.notes || []).join(" ");
  check("the optional note requires no owner question homework",
    /zero are required.*setup.*adaptive acceptance.*handoff/i.test(note) &&
      /later only if.*useful/i.test(note), note);
  check("the optional note preserves the separate same-item evidence gate",
    /accepted.*stored with provenance.*projected.*query-visible with a citation/i.test(note), note);
  check("the optional note never exposes manifest internals or intake homework",
    !/probe_questions|fill|from the intake/i.test(note), note);
}

{
  const legacyRetrieval = acceptanceVerdict({ passed: true, untested: ["retrieval"], counts: { pass: 5, fail: 0, warn: 0, skip: 1 } });
  check("a legacy result with retrieval untested stays qualified",
    legacyRetrieval.headline !== "automated acceptance checks passed" && /retrieval.*evidence/i.test(legacyRetrieval.headline),
    JSON.stringify(legacyRetrieval.headline));
  const warning = legacyRetrieval.warnings.join(" ");
  check("legacy remediation uses the real same-item evidence gate",
    /accepted.*stored with provenance.*projected.*query-visible with a citation/i.test(warning), warning);
  check("legacy remediation does not assign owner question homework",
    !/probe_questions|fill|write.*questions|from the intake/i.test(warning), warning);
}

{
  const failed = acceptanceVerdict({ passed: false, untested: ["retrieval"], counts: { pass: 3, fail: 2, warn: 0, skip: 1 } });
  check("a failed suite stays FAILED whatever else is untested",
    failed.headline === "acceptance suite FAILED", JSON.stringify(failed));
}

{
  const legacy = acceptanceVerdict({ passed: true, counts: { pass: 5, fail: 0, warn: 0, skip: 0 } });
  check("a summary without the untested field still gets a verdict",
    legacy.headline === "automated acceptance checks passed", JSON.stringify(legacy));
}

/* --------------------------------------------- 3. the HTML report */

const reportAcceptance = (untested) => ({
  counts: { pass: 12, fail: 0, warn: 0, skip: untested.length ? 1 : 0 },
  passed: true,
  stoppedAtTier: null,
  untested,
  results: [
    { tier: 1, name: "health responds", status: "pass", detail: "version 0.2.0" },
    ...(untested.length
      ? [{ tier: 3, name: "optional owner-question checks", status: "skip", detail: "none saved; zero are required for setup, adaptive acceptance, or handoff" }]
      : [{ tier: 3, name: "probe coverage", status: "pass", detail: "2/2 probes returned sources" }]),
  ],
});

{
  const verdict = computeVerdict({ acceptance: reportAcceptance(["optional_owner_questions"]), acceptanceError: null, seeds: [] });
  check("no saved owner questions remain ready for adaptive acceptance",
    verdict.state === "ready" && /ready for adaptive acceptance/i.test(verdict.line), JSON.stringify(verdict));
}

{
  const verdict = computeVerdict({ acceptance: reportAcceptance([]), acceptanceError: null, seeds: [] });
  check("a tested install with no seed section still reads ready",
    verdict.state === "ready", JSON.stringify(verdict));
}

{
  const verdict = computeVerdict({ acceptance: reportAcceptance(["retrieval"]), acceptanceError: null, seeds: [] });
  check("a legacy summary with retrieval untested still needs attention",
    verdict.state === "attention" && /query-visible retrieval proof/i.test(verdict.line), JSON.stringify(verdict));
  check("legacy report remediation names the real gate, not owner homework",
    /accepted.*stored with provenance.*projected.*query-visible with a citation/i.test(verdict.detail) &&
      !/probe_questions|fill|intake questions/i.test(verdict.detail), verdict.detail);
}

/* -------------------------------------------------- 4. setup notice */

{
  const quiet = optionalProbeQuestionsNotice(
    { testing: { probe_questions: ["why did we stop using those guys"] } },
  );
  check("a populated optional question list needs no notice", quiet === null, JSON.stringify(quiet));
}

for (const [label, manifest] of [
  ["an empty probe list", { testing: { probe_questions: [] } }],
  ["a missing testing block", {}],
  ["whitespace-only probes", { testing: { probe_questions: ["   "] } }],
]) {
  const lines = optionalProbeQuestionsNotice(manifest);
  const notice = (lines || []).join(" ");
  check(`${label} gets a calm informational notice`, Array.isArray(lines) && lines.length > 0, JSON.stringify(lines));
  check(`${label} requires zero prepared owner questions`,
    /zero are required.*setup.*adaptive acceptance.*handoff/i.test(notice), notice);
  check(`${label} names the actual handoff evidence gate`,
    /accepted.*stored.*provenance.*projected.*query-visible.*citation/i.test(notice), notice);
  check(`${label} does not expose fields, paths, or homework`,
    !/testing\.probe_questions|clients\/|fill|write.*questions|from the intake|EMPTY/.test(notice), notice);
}

/* ------------------------------------- 5. null-answer stage diagnostics */

const validCandidate = (overrides = {}) => ({
  title: "Candidate",
  source: "drive",
  chunk_uid: "drive:candidate#0",
  ...overrides,
});

const validNullAnswer = (overrides = {}) => ({
  mode: "think",
  answer: null,
  citations: [],
  results: [],
  gaps: [],
  ...overrides,
});

for (const [label, body, expectedStage, detailPattern] of [
  [
    "a retrieval outage",
    { status: "search_unavailable", degraded: "vector", notice: "The vector index is still building.", results: [] },
    "retrieval",
    /search was incomplete/i,
  ],
  [
    "incomplete source coverage",
    { status: "coverage_incomplete", notice: "One source is still loading.", results: [validCandidate()] },
    "source_coverage",
    /not yet proven complete/i,
  ],
  [
    "an evidence refusal",
    { results: [validCandidate()], model: "@cf/example", evidence_gate: { supported: false, complete: false, evidence: [], reason: "private-payload-canary\nfrom the draft" } },
    "answer_verification",
    /not accepted because its cited evidence did not support it/i,
  ],
  [
    "a sanitized model error",
    { results: [validCandidate()], answer_error: "Answer generation is unavailable right now. Try again in a moment." },
    "answer_model",
    /unavailable right now/i,
  ],
  [
    "an empty model response",
    { results: [validCandidate()], model: "claude-example" },
    "answer_model",
    /returned no answer text/i,
  ],
  [
    "a completed search with no evidence",
    { results: [], gaps: [{ type: "no_results" }] },
    "retrieval",
    /no candidate evidence/i,
  ],
  [
    "an impossible dispatch state",
    { results: [validCandidate()] },
    "answer_model_dispatch",
    /neither a model nor an answer error/i,
  ],
]) {
  const diagnostic = answerUnavailableDiagnostic(validNullAnswer(body));
  check(`${label} names ${expectedStage}`, diagnostic.stage === expectedStage, JSON.stringify(diagnostic));
  check(`${label} carries an actionable reason`, detailPattern.test(diagnostic.detail), JSON.stringify(diagnostic));
  check(`${label} never falls back to unknown`, !/reason:\s*unknown|no answer produced/i.test(diagnostic.detail), JSON.stringify(diagnostic));
  check(`${label} exposes no private verifier text`, !/private-payload-canary/i.test(diagnostic.detail), JSON.stringify(diagnostic));
}

{
  const diagnostic = answerUnavailableDiagnostic(validNullAnswer({
    results: [validCandidate()],
    answer_error: "The evidence check could not verify support, so no answer was shown. Try again in a moment.",
    evidence_gate: { supported: false, complete: false, error: "verification unavailable" },
  }));
  check("the Worker's verification-failure shape names answer verification, not the answer model",
    diagnostic.stage === "answer_verification", JSON.stringify(diagnostic));
}

{
  const diagnostic = answerUnavailableDiagnostic(validNullAnswer({
    results: [validCandidate()],
    evidence_gate: {
      supported: false,
      complete: false,
      error: "verifier failed with private-payload-canary",
    },
  }));
  check("an older Worker's raw verifier error is replaced with reviewed public copy",
    /evidence verifier was unavailable/i.test(diagnostic.detail) &&
      !/private-payload-canary/i.test(diagnostic.detail), JSON.stringify(diagnostic));
}

{
  const diagnostic = answerUnavailableDiagnostic(validNullAnswer({
    results: [validCandidate()],
    answer_error: "provider failed with private-payload-canary",
  }));
  check("an older Worker's raw model error is replaced with reviewed public copy",
    /Answer generation is unavailable right now/i.test(diagnostic.detail) &&
      !/private-payload-canary/i.test(diagnostic.detail), JSON.stringify(diagnostic));
}

{
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.post = async (path) => path === "/api/rag/unified"
    ? { ok: true, status: 200, json: { results: [{ title: "candidate" }] } }
    : {
        ok: true,
        status: 200,
        json: {
          mode: "think",
          answer: null,
          citations: [],
          status: "coverage_incomplete",
          notice: "One source is still loading.",
          gaps: [{ type: "coverage_stale" }],
          results: [validCandidate()],
        },
      };
  await suite.tierRetrieval(["What changed?"]);
  const warning = suite.results.find((result) => result.status === "warn" && /answer unavailable/.test(result.name));
  check("the acceptance result names the stage in its visible check name",
    warning?.name === "answer unavailable at source_coverage", JSON.stringify(suite.results));
  check("the acceptance result retains the stage-specific reason",
    /not yet proven complete/i.test(warning?.detail || ""), JSON.stringify(warning));
  check("the old unknown diagnostic is gone from the acceptance result",
    !suite.results.some((result) => /reason:\s*unknown|no answer produced/i.test(`${result.name} ${result.detail}`)),
    JSON.stringify(suite.results));
}

{
  const malformed = { results: [], gaps: [] };
  const diagnostic = answerUnavailableDiagnostic(malformed);
  check("a malformed 200 answer response is a response-contract failure",
    diagnostic.stage === "response_contract", JSON.stringify(diagnostic));

  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.post = async (path) => path === "/api/rag/unified"
    ? { ok: true, status: 200, json: { results: [{ title: "candidate" }] } }
    : { ok: true, status: 200, json: malformed };
  await suite.tierRetrieval(["What changed?"]);
  check("a malformed 200 cannot pass as a clean degradation",
    suite.results.some((result) => result.status === "fail" && result.name === "think response contract") &&
      !suite.results.some((result) => result.status === "pass" && result.name === "think degrades cleanly"),
    JSON.stringify(suite.results));
}

{
  const malformed = {
    mode: "think",
    answer: "Invented answer [1]",
    citations: [],
    results: [],
    gaps: [],
  };
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.post = async (path) => path === "/api/rag/unified"
    ? { ok: true, status: 200, json: { results: [{ title: "candidate" }] } }
    : { ok: true, status: 200, json: malformed };
  await suite.tierRetrieval(["What changed?"]);
  check("answer text in a malformed 200 cannot bypass the response contract",
    suite.results.some((result) => result.status === "fail" && result.name === "think response contract") &&
      !suite.results.some((result) => result.status === "pass" && result.name === "think returns an answer"),
    JSON.stringify(suite.results));
}

const validFactualAnswer = {
  mode: "think",
  answer: "The agreement ends in June [1].",
  citations: [{ n: 1, title: "Agreement", source: "drive" }],
  results: [{ title: "Agreement", source: "drive", chunk_uid: "drive:agreement#0" }],
  gaps: [],
  evidence_gate: { supported: true, complete: true, evidence: [1] },
};

const validRefusal = {
  mode: "think",
  answer: "The documents do not answer the question.",
  citations: [],
  results: [{ title: "Candidate", source: "drive", chunk_uid: "drive:candidate#0" }],
  gaps: [],
  evidence_gate: {
    supported: false, complete: false, evidence: [], reason: "answer model found no direct support",
  },
};

async function suiteForThink(response) {
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.post = async (path) => path === "/api/rag/unified"
    ? { ok: true, status: 200, json: { results: [{ title: "candidate" }] } }
    : { ok: true, status: 200, json: response };
  await suite.tierRetrieval(["What changed?"]);
  return suite;
}

for (const [label, malformed] of [
  ["a citation marker absent from the citation receipt", {
    ...validFactualAnswer, answer: "The agreement ends in June [2].",
  }],
  ["answer text beside a model error", {
    ...validFactualAnswer, answer_error: "private-payload-canary",
  }],
  ["an appended claim after the canonical refusal", {
    ...validFactualAnswer,
    answer: "The documents do not answer the question. The invented total is $9,999.",
  }],
  ["a placeholder result and citation", {
    ...validFactualAnswer, results: [null],
  }],
  ["a candidate carrying object-shaped title and source fields", {
    ...validFactualAnswer,
    citations: [{ n: 1, title: "[object Object]", source: "[object Object]" }],
    results: [{ title: {}, source: {}, chunk_uid: "drive:agreement#0" }],
  }],
  ["answer text beside a top-level error", {
    ...validFactualAnswer, error: "private-payload-canary",
  }],
  ["an incomplete evidence gate without the partial-answer receipt", {
    ...validFactualAnswer,
    evidence_gate: { supported: true, complete: false, evidence: [1] },
  }],
  ["a factual answer carrying a non-boolean partial receipt", {
    ...validFactualAnswer,
    evidence_gate: { ...validFactualAnswer.evidence_gate, partial: "true" },
  }],
  ["a factual answer with no verifier evidence receipt", {
    ...validFactualAnswer,
    evidence_gate: { supported: true, complete: true },
  }],
  ["a citation title that disagrees with its numbered result", {
    ...validFactualAnswer,
    citations: [{ n: 1, title: "Different document", source: "drive" }],
  }],
  ["a citation source that disagrees with its numbered result", {
    ...validFactualAnswer,
    citations: [{ n: 1, title: "Agreement", source: "gmail" }],
  }],
  ["a duplicate citation receipt", {
    ...validFactualAnswer,
    citations: [
      { n: 1, title: "Agreement", source: "drive" },
      { n: 1, title: "Agreement", source: "drive" },
    ],
  }],
  ["an extra citation the answer never used", {
    ...validFactualAnswer,
    citations: [
      { n: 1, title: "Agreement", source: "drive" },
      { n: 2, title: "Extra", source: "gmail" },
    ],
    results: [
      ...validFactualAnswer.results,
      { title: "Extra", source: "gmail", chunk_uid: "gmail:extra#0" },
    ],
    evidence_gate: { supported: true, complete: true, evidence: [1, 2] },
  }],
  ["a duplicate number in the verifier evidence receipt", {
    ...validFactualAnswer,
    evidence_gate: { supported: true, complete: true, evidence: [1, 1] },
  }],
  ["a canonical refusal claiming supported evidence", {
    ...validRefusal,
    evidence_gate: { supported: true, complete: true, evidence: [] },
  }],
  ["a canonical refusal carrying a citation", {
    ...validRefusal,
    citations: [{ n: 1, title: "Candidate", source: "drive" }],
  }],
  ["a canonical refusal claiming a partial factual answer", {
    ...validRefusal,
    evidence_gate: { supported: false, complete: false, partial: true, evidence: [] },
  }],
  ["a canonical refusal carrying a non-boolean partial receipt", {
    ...validRefusal,
    evidence_gate: { supported: false, complete: false, partial: "true", evidence: [] },
  }],
  ["a canonical refusal carrying a string evidence number", {
    ...validRefusal,
    evidence_gate: { supported: false, complete: false, evidence: ["1"] },
  }],
  ["a canonical refusal carrying an out-of-range evidence number", {
    ...validRefusal,
    evidence_gate: { supported: false, complete: true, evidence: [9] },
  }],
  ["a canonical refusal carrying a placeholder candidate", {
    ...validRefusal, results: [null],
  }],
  ["a null answer carrying a top-level error", {
    ...validNullAnswer(), error: "private-payload-canary",
  }],
  ["a null answer carrying an unknown status", {
    ...validNullAnswer(), status: "future_private_failure",
  }],
  ["a null answer carrying a citation", {
    ...validNullAnswer(),
    citations: [{ n: 1, title: "Candidate", source: "drive" }],
    results: [{ title: "Candidate", source: "drive", chunk_uid: "drive:candidate#0" }],
  }],
  ["a null answer claiming supported evidence", {
    ...validNullAnswer(), evidence_gate: { supported: true, complete: true, evidence: [] },
  }],
  ["a null answer carrying an empty evidence gate", {
    ...validNullAnswer(), evidence_gate: {},
  }],
  ["a null verifier error claiming complete evidence", {
    ...validNullAnswer({ results: [validCandidate()] }),
    evidence_gate: { supported: false, complete: true, error: "verification unavailable" },
  }],
  ["a null verifier error claiming approved evidence", {
    ...validNullAnswer({ results: [validCandidate()] }),
    evidence_gate: {
      supported: false, complete: false, evidence: [1], error: "verification unavailable",
    },
  }],
  ["a null answer claiming a partial factual answer", {
    ...validNullAnswer(),
    evidence_gate: { supported: false, complete: false, partial: true, evidence: [] },
  }],
  ["a null answer carrying a non-boolean partial receipt", {
    ...validNullAnswer(),
    evidence_gate: { supported: false, complete: false, partial: "true", evidence: [] },
  }],
  ["a null answer carrying a placeholder candidate", {
    ...validNullAnswer({ results: [null] }),
  }],
  ["a factual answer carrying an unused placeholder candidate", {
    ...validFactualAnswer, results: [...validFactualAnswer.results, null],
  }],
  ["a factual answer carrying an empty verifier error", {
    ...validFactualAnswer,
    evidence_gate: { ...validFactualAnswer.evidence_gate, error: "" },
  }],
  ["empty answer text in place of null", {
    ...validNullAnswer(), answer: "   ",
  }],
]) {
  const suite = await suiteForThink(malformed);
  const contractFailure = suite.results.find((result) =>
    result.status === "fail" && result.name === "think response contract"
  );
  check(`${label} fails the response contract`, Boolean(contractFailure), JSON.stringify(suite.results));
  check(`${label} cannot false-green acceptance`, suite.summary().passed === false, JSON.stringify(suite.summary()));
  check(`${label} exposes no private diagnostic text`,
    !/private-payload-canary/i.test(contractFailure?.detail || ""), JSON.stringify(contractFailure));
}

for (const [label, valid] of [
  ["a consistent cited answer", validFactualAnswer],
  ["a supported partial answer", {
    ...validFactualAnswer,
    answer: "The records establish the first part [1].\n\nNot covered by the documents: the deadline.",
    evidence_gate: { supported: true, complete: false, partial: true, evidence: [1] },
  }],
  ["an exact evidence refusal", validRefusal],
  ["an exact evidence refusal retaining normalized rejected evidence", {
    ...validRefusal,
    evidence_gate: { supported: false, complete: true, evidence: [1] },
  }],
  ["a null no-results response", validNullAnswer()],
  ["a null verifier-error response without an evidence array", validNullAnswer({
    results: [validCandidate()],
    evidence_gate: { supported: false, complete: false, error: "verification unavailable" },
  })],
  ["a cited answer over an untitled document", {
    ...validFactualAnswer,
    citations: [{ n: 1, title: "untitled", source: "drive" }],
    results: [{ title: null, source: "drive", chunk_uid: "drive:untitled#0" }],
  }],
  ["a factual claim containing refusal-like words", {
    ...validFactualAnswer,
    answer: "There is no information missing from the signed agreement [1].",
  }],
]) {
  const suite = await suiteForThink(valid);
  check(`${label} still passes the answer contract`,
    !suite.results.some((result) => result.name === "think response contract"),
    JSON.stringify(suite.results));
}

for (const [label, response, expectedStage] of [
  ["a private retrieval notice", validNullAnswer({
    status: "search_unavailable", degraded: "vector", notice: "private-payload-canary",
  }), "retrieval"],
  ["a private source-coverage detail", validNullAnswer({
    status: "coverage_incomplete",
    gaps: [{ type: "coverage_stale", detail: "private-payload-canary" }],
  }), "source_coverage"],
]) {
  const diagnostic = answerUnavailableDiagnostic(response);
  check(`${label} keeps a fixed public ${expectedStage} diagnostic`,
    diagnostic.stage === expectedStage && !/private-payload-canary/i.test(diagnostic.detail),
    JSON.stringify(diagnostic));
}


/* ============================================================================
   The post-activation retrieval retry.

   Acceptance runs fifteen saved probes back-to-back straight after activation,
   which is the most sustained sequence a brain ever sees. On 2026-09-17 that
   produced a FAIL twice on a brain whose vector projection was verified
   complete, because D1 was momentarily saturated and the Worker fast-failed in
   246-606 ms. The probes that failed moved between runs; only their position
   at the tail of the run stayed constant.

   These tests pin the four things that make the retry honest rather than a
   cover-up: it recovers a stall, it still FAILS a real fault, it reports the
   Worker's own reason instead of an invented one, and it costs nothing on a
   healthy brain.
   ========================================================================= */

/** A tier-3 suite whose probe and think responses are scripted per attempt. */
function retrySuite({ unified, think = () => ({ ok: true, status: 200, json: { mode: "think", answer: null, citations: [], results: [], gaps: [], status: "no_results" } }), retrievalRetry }) {
  const waits = [];
  // Proves the calls never overlap. A parallel retry would recreate the very
  // concurrency this is working around, so "sequential" is a test, not a note.
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  let unifiedAttempt = 0;
  let thinkAttempt = 0;
  const suite = new Acceptance({
    base: "https://brain.example",
    adminKey: "k",
    manifest: {},
    retrievalRetry,
    sleepImpl: async (ms) => { waits.push(ms); },
  });
  suite.post = async (path, body) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await null; // force at least one microtask turn inside the call
      calls.push(path);
      return path === "/api/rag/unified"
        ? unified(unifiedAttempt++, body?.q)
        : think(thinkAttempt++, body?.q);
    } finally {
      inFlight -= 1;
    }
  };
  return { suite, waits, calls, get maxInFlight() { return maxInFlight; } };
}

const ok = (json) => ({ ok: true, status: 200, json });
const healthyProbe = ok({ results: [{ title: "a" }, { title: "b" }] });
/** The exact shape measured on 2026-09-17: fast-fail, zero rows, D1 down. */
const d1FastFail = ok({
  results: [],
  degraded: "retrieval",
  degraded_reason: "keyword-and-vector-query-failed",
  status: "search_unavailable",
});
const keywordOnly = ok({
  results: [{ title: "a" }],
  degraded: "vector",
  degraded_reason: "projection-incomplete",
});

/* ---- (a) it fails twice, then recovers: PASS, and the detail says so ---- */
{
  const { suite, waits, calls } = retrySuite({
    unified: (attempt) => (attempt < 2 ? d1FastFail : healthyProbe),
  });
  await suite.tierRetrieval(["What did we agree?"]);
  const probe = suite.results.find((r) => r.name.startsWith("probe: "));
  const semantic = suite.results.find((r) => r.name === "semantic retrieval is active");
  const coverage = suite.results.find((r) => r.name === "probe coverage");
  check("a probe that fails twice and then answers is a PASS",
    probe?.status === "pass", JSON.stringify(probe));
  check("the recovered probe's detail carries the retry count",
    /2 result\(s\); recovered after 2 retries/.test(probe?.detail || ""), JSON.stringify(probe));
  check("a probe that recovered is not counted as degraded",
    semantic?.status === "pass" && /1 probe\(s\) recovered after a retry/.test(semantic?.detail || ""),
    JSON.stringify(semantic));
  check("probe coverage names the recovery too",
    coverage?.status === "pass" && /1 recovered after a retry/.test(coverage?.detail || ""),
    JSON.stringify(coverage));
  check("it waited between attempts rather than retrying immediately",
    waits.length === 2 && waits.every((ms) => ms === 15_000), JSON.stringify(waits));
  check("only the failing probe was retried",
    calls.filter((c) => c === "/api/rag/unified").length === 3, JSON.stringify(calls));
}

/* ---- (b) it never recovers: FAIL after the budget, with the real reason ---- */
{
  const { suite, waits, calls } = retrySuite({ unified: () => d1FastFail });
  await suite.tierRetrieval(["What did we agree?"]);
  const probe = suite.results.find((r) => r.name.startsWith("probe: "));
  const semantic = suite.results.find((r) => r.name === "semantic retrieval is active");
  check("a probe that never recovers still FAILS",
    probe?.status === "fail", JSON.stringify(probe));
  check("the failing probe's detail carries the Worker's own reason",
    /search_unavailable: keyword-and-vector-query-failed/.test(probe?.detail || ""),
    JSON.stringify(probe));
  check("the failing probe's detail says it stayed degraded across the retries",
    /still degraded after 4 retries/.test(probe?.detail || ""), JSON.stringify(probe));
  check("semantic retrieval is active FAILS on a probe that ended degraded",
    semantic?.status === "fail", JSON.stringify(semantic));
  check("the semantic FAIL reports the Worker's reason, not an invented cause",
    /still degraded after the retry budget/.test(semantic?.detail || "") &&
      /search_unavailable: keyword-and-vector-query-failed/.test(semantic?.detail || ""),
    JSON.stringify(semantic));
  check("it gave up after exactly the allowed retries",
    waits.length === 4 && calls.filter((c) => c === "/api/rag/unified").length === 5,
    JSON.stringify({ waits, calls }));
}

/* ---- keyword-only never recovering is still a FAIL, with its own reason ---- */
{
  const { suite } = retrySuite({ unified: () => keywordOnly });
  await suite.tierRetrieval(["What did we agree?"]);
  const probe = suite.results.find((r) => r.name.startsWith("probe: "));
  const semantic = suite.results.find((r) => r.name === "semantic retrieval is active");
  check("a keyword-only probe returning rows is still a probe PASS, as before",
    probe?.status === "pass", JSON.stringify(probe));
  check("keyword-only that never clears still FAILS semantic retrieval",
    semantic?.status === "fail" && /vector: projection-incomplete/.test(semantic?.detail || ""),
    JSON.stringify(semantic));
}

/* ---- (c) the think probe retries on the same terms ---- */
{
  const thinkDegraded = ok({
    mode: "think", answer: null, citations: [], results: [], gaps: [],
    degraded: "vector", degraded_reason: "vector-query-failed",
  });
  const thinkHealthy = ok({
    mode: "think",
    answer: "The agreement ends in June [1].",
    citations: [{ n: 1, title: "Agreement", source: "drive" }],
    results: [{ title: "Agreement", source: "drive", chunk_uid: "drive:agreement#0" }],
    gaps: [],
    evidence_gate: { supported: true, complete: true, evidence: [1] },
  });
  const recovering = retrySuite({
    unified: () => healthyProbe,
    think: (attempt) => (attempt < 1 ? thinkDegraded : thinkHealthy),
  });
  await recovering.suite.tierRetrieval(["What did we agree?"]);
  const recovered = recovering.suite.results.find((r) => r.name === "think uses semantic retrieval");
  check("a think probe that degrades once and then answers is a PASS",
    recovered?.status === "pass" && /recovered after 1 retry/.test(recovered?.detail || ""),
    JSON.stringify(recovering.suite.results));
  check("the recovered think probe waited before retrying",
    recovering.waits.length === 1 && recovering.waits[0] === 15_000, JSON.stringify(recovering.waits));

  const stuck = retrySuite({ unified: () => healthyProbe, think: () => thinkDegraded });
  await stuck.suite.tierRetrieval(["What did we agree?"]);
  const stuckResult = stuck.suite.results.find((r) => r.name === "think uses semantic retrieval");
  check("a think probe that never recovers still FAILS",
    stuckResult?.status === "fail", JSON.stringify(stuckResult));
  check("the think FAIL carries the Worker's degraded_reason and the retry count",
    /vector: vector-query-failed/.test(stuckResult?.detail || "") &&
      /still degraded after 4 retries/.test(stuckResult?.detail || ""),
    JSON.stringify(stuckResult));
  check("the think probe gave up after exactly the allowed retries",
    stuck.waits.length === 4 && stuck.calls.filter((c) => c === "/api/rag/think").length === 5,
    JSON.stringify({ waits: stuck.waits, calls: stuck.calls }));
}

/* ---- (d) a healthy brain pays nothing, and its results are unchanged ---- */
{
  const thinkHealthy = ok({
    mode: "think",
    answer: "The agreement ends in June [1].",
    citations: [{ n: 1, title: "Agreement", source: "drive" }],
    results: [{ title: "Agreement", source: "drive", chunk_uid: "drive:agreement#0" }],
    gaps: [],
    evidence_gate: { supported: true, complete: true, evidence: [1] },
  });
  const { suite, waits, calls } = retrySuite({ unified: () => healthyProbe, think: () => thinkHealthy });
  await suite.tierRetrieval(["one", "two", "three"]);
  check("a healthy run never sleeps",
    waits.length === 0, JSON.stringify(waits));
  check("a healthy run makes exactly one call per probe plus one think",
    calls.length === 4, JSON.stringify(calls));
  check("a healthy probe detail is exactly what it was before the retry existed",
    suite.results.filter((r) => r.name.startsWith("probe: ")).every((r) => r.detail === "2 result(s)"),
    JSON.stringify(suite.results));
  check("a healthy run records no think-recovery line",
    !suite.results.some((r) => r.name === "think uses semantic retrieval"),
    JSON.stringify(suite.results));
  check("a healthy run's semantic detail is unchanged",
    suite.results.find((r) => r.name === "semantic retrieval is active")?.detail ===
      "no probe degraded to keyword-only retrieval",
    JSON.stringify(suite.results));
  check("a healthy run's probe coverage detail is unchanged",
    suite.results.find((r) => r.name === "probe coverage")?.detail === "3/3 probes returned sources",
    JSON.stringify(suite.results));
}

/* ---- (e) the budgets hold, and the calls never overlap ---- */
{
  // 4 x 15 s is not a round number chosen for looks. A301BB4-DECISION §4
  // condition 1 measured exactly one recovery interval -- "60 s is empirically
  // sufficient (r2 tail -> r3 fully clean)" -- and a per-probe ceiling below
  // that gives up before the only evidence the retry was built on.
  check("the shipped policy is 4 retries, 15 s apart, 60 s per probe, 4 min per tier",
    RETRIEVAL_RETRY_DEFAULTS.attempts === 4 &&
      RETRIEVAL_RETRY_DEFAULTS.spacingMs === 15_000 &&
      RETRIEVAL_RETRY_DEFAULTS.probeBudgetMs === 60_000 &&
      RETRIEVAL_RETRY_DEFAULTS.tierBudgetMs === 240_000,
    JSON.stringify(RETRIEVAL_RETRY_DEFAULTS));
  check("the per-probe ceiling spans the one measured recovery interval",
    RETRIEVAL_RETRY_DEFAULTS.attempts * RETRIEVAL_RETRY_DEFAULTS.spacingMs >= 60_000 &&
      RETRIEVAL_RETRY_DEFAULTS.probeBudgetMs >= 60_000,
    JSON.stringify(RETRIEVAL_RETRY_DEFAULTS));
  check("a retry is still spaced well clear of the tight-loop failure mode",
    RETRIEVAL_RETRY_DEFAULTS.spacingMs >= 10_000, JSON.stringify(RETRIEVAL_RETRY_DEFAULTS));
  // The worst case is two bounded things, not one. Sleeping is capped by the
  // tier budget; extra REQUESTS are capped at tierBudget/spacing, and each one
  // can cost as much as the measured healthy-latency max of 17.3 s.
  {
    const extraRequests = RETRIEVAL_RETRY_DEFAULTS.tierBudgetMs / RETRIEVAL_RETRY_DEFAULTS.spacingMs;
    check("at most 16 extra requests can be made across the tier",
      extraRequests === 16, `${extraRequests}`);
    const worstMs = RETRIEVAL_RETRY_DEFAULTS.tierBudgetMs + extraRequests * 17_300;
    check("the true worst case is ~8.6 minutes, not the 3 minutes of sleeping alone",
      Math.round(worstMs / 1000) === 517, `${worstMs}`);
    const realisticMs = RETRIEVAL_RETRY_DEFAULTS.tierBudgetMs + extraRequests * 606;
    check("the realistic D1-fast-fail case is a little over 4 minutes",
      Math.round(realisticMs / 1000) === 250, `${realisticMs}`);
  }

  // Fifteen probes, every one of them down for good. Per-probe that would be
  // 15 x 60 s = 900 s; the tier ceiling has to bind first.
  const fifteen = Array.from({ length: 15 }, (_, i) => `probe ${i}`);
  // Held as one object, not destructured: maxInFlight is a live getter.
  const run = retrySuite({ unified: () => d1FastFail });
  const { suite, waits } = run;
  await suite.tierRetrieval(fifteen);
  const waited = waits.reduce((a, b) => a + b, 0);
  check("the tier's added wait is capped at four minutes",
    waited === RETRIEVAL_RETRY_DEFAULTS.tierBudgetMs && waited === 240_000, `${waited}`);
  check("the tier cap binds before the per-probe cap could be spent fifteen times",
    waited < 15 * RETRIEVAL_RETRY_DEFAULTS.probeBudgetMs, `${waited}`);
  check("probes after the tier budget is spent are still run, just not retried",
    suite.results.filter((r) => r.name.startsWith("probe: ")).length === 15,
    JSON.stringify(suite.results.length));
  check("every probe still FAILS once the budget is gone",
    suite.results.filter((r) => r.name.startsWith("probe: ")).every((r) => r.status === "fail"),
    JSON.stringify(suite.results));
  check("no two retrieval calls were ever in flight at once",
    run.maxInFlight === 1, `${run.maxInFlight}`);

  // Per-probe ceiling, in isolation from the tier ceiling.
  const probeSpend = retrievalRetryBudget(RETRIEVAL_RETRY_DEFAULTS).probe();
  let allowed = 0;
  while (probeSpend.allows(15_000)) { probeSpend.take(15_000); allowed += 1; }
  check("one probe can spend at most 60 s of waiting",
    allowed === 4 && probeSpend.spentMs === 60_000, `${allowed}/${probeSpend.spentMs}`);
}

/* ---- (f) the misattributed Vectorize cause is gone from the tree ---- */
{
  const source = readFileSync(fileURLToPath(new URL("../acceptance.mjs", import.meta.url)), "utf8");
  check("acceptance no longer blames Vectorize for a degradation it never read",
    !/Vectorize returned no candidates/i.test(source), "found the old sentence");
  check("the semantic check derives its detail from degraded_reason",
    /degraded_reason/.test(source), "no degraded_reason read");

  check("a fast-fail is described in the Worker's own words",
    workerDegradationDetail({
      degraded: "retrieval",
      degraded_reason: "keyword-and-vector-query-failed",
      status: "search_unavailable",
    }) === "search_unavailable: keyword-and-vector-query-failed",
    workerDegradationDetail({ degraded: "retrieval", degraded_reason: "keyword-and-vector-query-failed", status: "search_unavailable" }));
  check("a degradation with no status falls back to the degraded token",
    workerDegradationDetail({ degraded: "vector", degraded_reason: "projection-incomplete" }) ===
      "vector: projection-incomplete");
  check("a healthy response describes no degradation at all",
    workerDegradationDetail({ results: [] }) === null);
  check("an over-long provider string cannot become the check detail",
    (workerDegradationDetail({ degraded: "x".repeat(200), degraded_reason: "y".repeat(200) }) || "").length <= 122,
    String(workerDegradationDetail({ degraded: "x".repeat(200), degraded_reason: "y".repeat(200) })?.length));
}


/* ============================================================================
   Which degradations are failures, and which are ordinary states.

   The retry's first version treated EVERY non-null `degraded` as a failure to
   be retried and then failed on. The Worker emits six distinct tokens and most
   of them are not faults: `scoped-vector` means an exact-document scope was
   applied on purpose, `fts` means the keyword side is down while the semantic
   side ran. Retrying those buys a minute of install time and fails a brain for
   behaving correctly.

   These tests pin the classification against the Worker source itself, so a
   seventh token cannot silently join either side of the table.
   ========================================================================= */

/** Every `degraded` string literal the Worker can put on the wire. */
function workerDegradedTokens() {
  const files = ["../worker/src/lib/store-d1.js", "../worker/src/lib/store.js"];
  const tokens = new Set();
  for (const rel of files) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    for (const m of src.matchAll(/(?<!_)\bdegraded\s*[:=]\s*"([^"]+)"/g)) tokens.add(m[1]);
  }
  return tokens;
}

{
  const emitted = workerDegradedTokens();
  const classified = new Set(Object.keys(DEGRADED_CLASSIFICATION));

  check("the Worker source still emits the six tokens this table was built from",
    [...emitted].sort().join(",") ===
      "document-access-unavailable,fts,no-embedding,retrieval,scoped-vector,vector",
    [...emitted].sort().join(","));
  const unclassified = [...emitted].filter((token) => !classified.has(token));
  check("every degraded token the Worker emits is classified",
    unclassified.length === 0, `unclassified: ${unclassified.join(", ")}`);
  const ghosts = [...classified].filter((token) => !emitted.has(token));
  check("the table invents no token the Worker cannot emit",
    ghosts.length === 0, `not emitted: ${ghosts.join(", ")}`);

  // The floor: exactly what a301bb4 counted, plus the one token added since to
  // name the worse case. Widening beyond this is the false-FAIL source; not
  // reaching it would let a real degradation pass.
  check("the failure set is exactly vector (what a301bb4 counted) and retrieval",
    Object.keys(RETRIEVAL_FAILURE_DEGRADED).sort().join(",") === "retrieval,vector",
    Object.keys(RETRIEVAL_FAILURE_DEGRADED).join(","));
  check("the expected states are the four the Worker reports as ordinary",
    Object.keys(EXPECTED_DEGRADED).sort().join(",") ===
      "document-access-unavailable,fts,no-embedding,scoped-vector",
    Object.keys(EXPECTED_DEGRADED).join(","));
  for (const token of ["vector", "retrieval"]) {
    check(`${token} is counted as a retrieval failure`,
      isRetrievalFailureDegradation(token) === true, token);
  }
  for (const token of ["fts", "scoped-vector", "no-embedding", "document-access-unavailable"]) {
    check(`${token} is an expected state and fails nothing`,
      isRetrievalFailureDegradation(token) === false, token);
  }
  // An unrecognised token answers "not a failure". A Worker change is caught by
  // the pin above, in development, rather than by a FAIL during an install.
  check("an unknown token is not turned into a FAIL in front of a customer",
    isRetrievalFailureDegradation("some-future-token") === false);
  check("no degradation at all is not a failure",
    isRetrievalFailureDegradation(null) === false &&
      isRetrievalFailureDegradation(undefined) === false &&
      isRetrievalFailureDegradation(false) === false);
}

/* ---- an expected degradation is recorded, never retried, never failed ---- */
{
  const scoped = ok({
    results: [{ title: "a" }, { title: "b" }],
    degraded: "scoped-vector",
    degraded_reason: "zone-scope-keyword-only",
    status: "coverage_incomplete",
  });
  const { suite, waits, calls } = retrySuite({ unified: () => scoped });
  await suite.tierRetrieval(["What did we agree?"]);
  const probe = suite.results.find((r) => r.name.startsWith("probe: "));
  const semantic = suite.results.find((r) => r.name === "semantic retrieval is active");
  check("a deliberately scoped request is not retried",
    waits.length === 0 && calls.filter((c) => c === "/api/rag/unified").length === 1,
    JSON.stringify({ waits, calls }));
  check("a deliberately scoped request is a probe PASS",
    probe?.status === "pass", JSON.stringify(probe));
  check("the expected state is still recorded in the probe detail, and named as expected",
    probe?.detail === "2 result(s); the Worker reported the expected state " +
      "coverage_incomplete: zone-scope-keyword-only, not a retrieval failure",
    JSON.stringify(probe));
  check("an expected state does not fail semantic retrieval",
    semantic?.status === "pass", JSON.stringify(semantic));
  check("but it is reported there rather than dropped",
    /expected states reported, none of them a retrieval failure: coverage_incomplete: zone-scope-keyword-only/
      .test(semantic?.detail || ""), JSON.stringify(semantic));
}

/* ---- keyword-side outage: reported, not a semantic-retrieval FAIL ---- */
{
  const ftsDown = ok({
    results: [{ title: "a" }],
    degraded: "fts",
    degraded_reason: "keyword-query-failed",
    status: "coverage_incomplete",
  });
  const { suite, waits } = retrySuite({ unified: () => ftsDown });
  await suite.tierRetrieval(["What did we agree?"]);
  check("a keyword-side outage is not retried as if the vector path had failed",
    waits.length === 0, JSON.stringify(waits));
  check("a keyword-side outage does not fail 'semantic retrieval is active'",
    suite.results.find((r) => r.name === "semantic retrieval is active")?.status === "pass",
    JSON.stringify(suite.results));
}

/* ---- a total retrieval failure on the answer path is not "keyword-only" ---- */
{
  const thinkNothing = ok({
    mode: "think", answer: null, citations: [], results: [], gaps: [],
    degraded: "retrieval",
    degraded_reason: "keyword-and-vector-query-failed",
    status: "search_unavailable",
  });
  const { suite } = retrySuite({ unified: () => healthyProbe, think: () => thinkNothing });
  await suite.tierRetrieval(["What did we agree?"]);
  const result = suite.results.find((r) => r.name === "think uses semantic retrieval");
  check("a total retrieval failure on the answer path still FAILS",
    result?.status === "fail", JSON.stringify(result));
  check("and it is not described as a keyword-only fallback that never happened",
    /completed no retrieval at all/.test(result?.detail || "") &&
      !/keyword-only/.test(result?.detail || ""),
    JSON.stringify(result));
}

/* ---- the think path classifies the same way ---- */
{
  const thinkScoped = ok({
    mode: "think",
    answer: "The agreement ends in June [1].",
    citations: [{ n: 1, title: "Agreement", source: "drive" }],
    results: [{ title: "Agreement", source: "drive", chunk_uid: "drive:agreement#0" }],
    gaps: [],
    degraded: "scoped-vector",
    degraded_reason: "document-scope-keyword-only",
    evidence_gate: { supported: true, complete: true, evidence: [1] },
  });
  const { suite, waits } = retrySuite({ unified: () => healthyProbe, think: () => thinkScoped });
  await suite.tierRetrieval(["What did we agree?"]);
  check("the answer path is not retried on a deliberate scope",
    waits.length === 0, JSON.stringify(waits));
  check("a deliberate scope does not fail 'think uses semantic retrieval'",
    !suite.results.some((r) => r.name === "think uses semantic retrieval" && r.status === "fail"),
    JSON.stringify(suite.results));
}

/* ============================================================================
   Zero results with NO degradation reported.

   Two separate bugs live on this path. First, it is a retry trigger in its own
   right -- the measured D1 fast-fail returned zero rows, and a stall can return
   zero rows before the Worker has anything to call degraded. Delete `n === 0 ||`
   from the trigger and both tests below fail. Second, the detail must not
   borrow the vocabulary of a degradation the Worker never reported: a healthy
   `coverage_incomplete` with no `degraded` field is a real and ordinary shape.
   ========================================================================= */

/** Structurally healthy, no degradation, simply empty. */
const emptyNoDegradation = ok({
  results: [],
  status: "coverage_incomplete",
  gaps: [{ type: "coverage_incomplete" }],
});

{
  const { suite, waits, calls } = retrySuite({
    unified: (attempt) => (attempt < 1 ? emptyNoDegradation : healthyProbe),
  });
  await suite.tierRetrieval(["What did we agree?"]);
  const probe = suite.results.find((r) => r.name.startsWith("probe: "));
  check("a zero-result probe is retried even when nothing was reported degraded",
    calls.filter((c) => c === "/api/rag/unified").length === 2 && waits.length === 1,
    JSON.stringify({ waits, calls }));
  check("a zero-result probe that fills in on retry is a PASS",
    probe?.status === "pass" && /recovered after 1 retry/.test(probe?.detail || ""),
    JSON.stringify(probe));
  check("a recovered empty probe claims no degradation at all",
    !/degrad/.test(probe?.detail || ""), JSON.stringify(probe));
}

{
  const { suite, waits } = retrySuite({ unified: () => emptyNoDegradation });
  await suite.tierRetrieval(["What did we agree?"]);
  const probe = suite.results.find((r) => r.name.startsWith("probe: "));
  const semantic = suite.results.find((r) => r.name === "semantic retrieval is active");
  check("a probe that stays empty is retried the full allowance, then FAILS",
    probe?.status === "fail" && waits.length === 4, JSON.stringify({ probe, waits }));
  check("its detail reports the Worker's status and says there was no degradation",
    probe?.detail ===
      "0 result(s); the Worker reported status coverage_incomplete with no degradation; " +
      "still empty after 4 retries",
    JSON.stringify(probe));
  check("an empty-but-undegraded probe does not fail 'semantic retrieval is active'",
    semantic?.status === "pass", JSON.stringify(semantic));
  check("probe coverage still records the miss",
    suite.results.find((r) => r.name === "probe coverage")?.status === "fail",
    JSON.stringify(suite.results));
}

/* ---- zero results, no degradation, and no status either ---- */
{
  const { suite } = retrySuite({ unified: () => ok({ results: [] }) });
  await suite.tierRetrieval(["What did we agree?"]);
  const probe = suite.results.find((r) => r.name.startsWith("probe: "));
  check("with no status to report, it still refuses to invent a degradation",
    probe?.detail === "0 result(s); the Worker reported no degradation; still empty after 4 retries",
    JSON.stringify(probe));
}

console.log(`\nacceptance verdict: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
