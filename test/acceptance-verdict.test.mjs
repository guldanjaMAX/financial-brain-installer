// Owner-authored questions extend acceptance with optional private regression
// checks. An empty list is normal and must never become onboarding homework.
// The runtime still names the optional skip and points to the separate handoff
// gate: one real item proved accepted, stored with provenance, projected, and
// query-visible with a citation. Legacy summaries that truly mark retrieval as
// untested remain qualified without telling the owner to prepare questions.

import { Acceptance, acceptanceVerdict, answerUnavailableDiagnostic } from "../acceptance.mjs";
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

console.log(`\nacceptance verdict: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
