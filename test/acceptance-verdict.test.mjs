// The acceptance verdict must not read green when retrieval was never tested.
//
// The defect this file keeps dead: with testing.probe_questions empty, the
// retrieval tier records one SKIP and the run still ended in an unqualified
// "acceptance suite passed". Reach, data, safety and operations were proven;
// nobody had asked the brain a single question. That sentence is the one a
// client reads on install day, and it is the instrument the money-back
// guarantee is judged against — so "passed" with the central capability
// untested is a false green, delivered at the worst possible moment.
//
// Three surfaces carry the verdict and all three are pinned here:
//   1. Acceptance.summary() must SAY the retrieval tier went untested.
//   2. acceptanceVerdict() must turn that into a qualified headline and loud
//      warnings for the terminal run (brain test / the upgrade stage).
//   3. The HTML report's computeVerdict must land "attention", not "ready".
// And brain setup must warn while there is still time to fix it, via
// emptyProbeQuestionsWarning.

import { Acceptance, acceptanceVerdict, answerUnavailableDiagnostic } from "../acceptance.mjs";
import { computeVerdict } from "../report-html.mjs";
import { emptyProbeQuestionsWarning } from "../brain.mjs";

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
    out.results.some((r) => r.tier === 3 && r.status === "skip" && /probe/i.test(r.name)),
    JSON.stringify(out.results));
  check("the summary names retrieval as untested",
    Array.isArray(out.untested) && out.untested.includes("retrieval"),
    JSON.stringify(out.untested));
  check("an untested tier is not a failed tier: the suite still passes",
    out.passed === true, JSON.stringify(out));
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
    tested.headline === "acceptance suite passed", JSON.stringify(tested));
  check("a fully tested pass carries no warnings",
    Array.isArray(tested.warnings) && tested.warnings.length === 0, JSON.stringify(tested));
}

{
  const hollow = acceptanceVerdict({ passed: true, untested: ["retrieval"], counts: { pass: 5, fail: 0, warn: 0, skip: 1 } });
  check("an untested retrieval tier changes the headline itself",
    hollow.headline !== "acceptance suite passed" && /NOT tested|untested/i.test(hollow.headline),
    JSON.stringify(hollow.headline));
  check("the warnings say what is missing and where it goes",
    hollow.warnings.some((l) => /probe_questions/.test(l)),
    JSON.stringify(hollow.warnings));
  check("the warnings say what was actually proven and what was not",
    hollow.warnings.some((l) => /retrieval/i.test(l) && /not/i.test(l)),
    JSON.stringify(hollow.warnings));
}

{
  const failed = acceptanceVerdict({ passed: false, untested: ["retrieval"], counts: { pass: 3, fail: 2, warn: 0, skip: 1 } });
  check("a failed suite stays FAILED whatever else is untested",
    failed.headline === "acceptance suite FAILED", JSON.stringify(failed));
}

{
  const legacy = acceptanceVerdict({ passed: true, counts: { pass: 5, fail: 0, warn: 0, skip: 0 } });
  check("a summary without the untested field still gets a verdict",
    legacy.headline === "acceptance suite passed", JSON.stringify(legacy));
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
      ? [{ tier: 3, name: "retrieval probes", status: "skip", detail: "no probe questions in the manifest (testing.probe_questions)" }]
      : [{ tier: 3, name: "probe coverage", status: "pass", detail: "2/2 probes returned sources" }]),
  ],
});

{
  const verdict = computeVerdict({ acceptance: reportAcceptance(["retrieval"]), acceptanceError: null, seeds: [] });
  check("the report verdict refuses 'ready' when retrieval went untested",
    verdict.state === "attention", JSON.stringify(verdict));
  check("the report verdict line says retrieval was not tested, in plain words",
    /retrieval|question/i.test(verdict.line) && /not|never/i.test(verdict.line),
    JSON.stringify(verdict.line));
}

{
  const verdict = computeVerdict({ acceptance: reportAcceptance([]), acceptanceError: null, seeds: [] });
  check("a tested install with no seed section still reads ready",
    verdict.state === "ready", JSON.stringify(verdict));
}

/* ------------------------------------------------- 4. setup warning */

{
  const quiet = emptyProbeQuestionsWarning(
    { testing: { probe_questions: ["why did we stop using those guys"] } },
    "brain.manifest.json",
  );
  check("a populated probe list warns about nothing", quiet === null, JSON.stringify(quiet));
}

for (const [label, manifest] of [
  ["an empty probe list", { testing: { probe_questions: [] } }],
  ["a missing testing block", {}],
  ["whitespace-only probes", { testing: { probe_questions: ["   "] } }],
]) {
  const lines = emptyProbeQuestionsWarning(manifest, "clients/brain.manifest.json");
  check(`${label} warns loudly`, Array.isArray(lines) && lines.length > 0, JSON.stringify(lines));
  check(`${label} names the manifest field`,
    (lines || []).some((l) => /testing\.probe_questions/.test(l)), JSON.stringify(lines));
  check(`${label} says what stays untested without it`,
    (lines || []).some((l) => /retrieval|acceptance/i.test(l)), JSON.stringify(lines));
}

/* ------------------------------------- 5. null-answer stage diagnostics */

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
    /vector index is still building/i,
  ],
  [
    "incomplete source coverage",
    { status: "coverage_incomplete", notice: "One source is still loading.", results: [{ n: 1 }] },
    "source_coverage",
    /still loading/i,
  ],
  [
    "an evidence refusal",
    { results: [{ n: 1 }], model: "@cf/example", evidence_gate: { supported: false, complete: false, reason: "private-payload-canary\nfrom the draft" } },
    "answer_verification",
    /not accepted because its cited evidence did not support it/i,
  ],
  [
    "a sanitized model error",
    { results: [{ n: 1 }], answer_error: "Answer generation is unavailable right now. Try again in a moment." },
    "answer_model",
    /unavailable right now/i,
  ],
  [
    "an empty model response",
    { results: [{ n: 1 }], model: "claude-example" },
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
    { results: [{ n: 1 }] },
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
    results: [{ n: 1 }],
    answer_error: "The evidence check could not verify support, so no answer was shown. Try again in a moment.",
    evidence_gate: { supported: false, complete: false, error: "verification unavailable" },
  }));
  check("the Worker's verification-failure shape names answer verification, not the answer model",
    diagnostic.stage === "answer_verification", JSON.stringify(diagnostic));
}

{
  const diagnostic = answerUnavailableDiagnostic(validNullAnswer({
    results: [{ n: 1 }],
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
    results: [{ n: 1 }],
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
          results: [{ title: "candidate" }],
        },
      };
  await suite.tierRetrieval(["What changed?"]);
  const warning = suite.results.find((result) => result.status === "warn" && /answer unavailable/.test(result.name));
  check("the acceptance result names the stage in its visible check name",
    warning?.name === "answer unavailable at source_coverage", JSON.stringify(suite.results));
  check("the acceptance result retains the stage-specific reason",
    /still loading/i.test(warning?.detail || ""), JSON.stringify(warning));
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

for (const [label, malformed] of [
  [
    "a citation marker absent from the citation receipt",
    {
      mode: "think",
      answer: "Invented answer [2]",
      citations: [{ n: 1 }],
      results: [{ title: "candidate" }],
      gaps: [],
    },
  ],
  [
    "answer text beside a model error",
    {
      mode: "think",
      answer: "Invented answer [1]",
      answer_error: "private-payload-canary",
      citations: [{ n: 1 }],
      results: [{ title: "candidate" }],
      gaps: [],
    },
  ],
  [
    "a factual claim that merely contains refusal-like words",
    {
      mode: "think",
      answer: "There is no information missing, so the invented total is $9,999.",
      citations: [],
      results: [{ title: "candidate" }],
      gaps: [],
    },
  ],
  [
    "an appended claim after the canonical refusal",
    {
      mode: "think",
      answer: "The documents do not answer the question. The invented total is $9,999.",
      citations: [],
      results: [{ title: "candidate" }],
      gaps: [],
    },
  ],
  [
    "a placeholder result and citation",
    {
      mode: "think",
      answer: "Invented answer [1]",
      citations: [{ n: 1 }],
      results: [null],
      gaps: [],
    },
  ],
  [
    "answer text beside a top-level error",
    {
      mode: "think",
      answer: "Invented answer [1]",
      error: "private-payload-canary",
      citations: [{ n: 1, title: "Candidate", source: "drive" }],
      results: [{ title: "Candidate", source: "drive", chunk_uid: "drive:1#0" }],
      gaps: [],
      evidence_gate: { supported: true, complete: true },
    },
  ],
  [
    "an incomplete evidence gate without the partial-answer receipt",
    {
      mode: "think",
      answer: "Invented answer [1]",
      citations: [{ n: 1, title: "Candidate", source: "drive" }],
      results: [{ title: "Candidate", source: "drive", chunk_uid: "drive:1#0" }],
      gaps: [],
      evidence_gate: { supported: true, complete: false },
    },
  ],
]) {
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.post = async (path) => path === "/api/rag/unified"
    ? { ok: true, status: 200, json: { results: [{ title: "candidate" }] } }
    : { ok: true, status: 200, json: malformed };
  await suite.tierRetrieval(["What changed?"]);
  const contractFailure = suite.results.find((result) =>
    result.status === "fail" && result.name === "think response contract"
  );
  check(`${label} fails the response contract`, Boolean(contractFailure), JSON.stringify(suite.results));
  check(`${label} cannot false-green acceptance`, suite.summary().passed === false, JSON.stringify(suite.summary()));
  check(`${label} exposes no private diagnostic text`,
    !/private-payload-canary/i.test(contractFailure?.detail || ""), JSON.stringify(contractFailure));
}

{
  const valid = {
    mode: "think",
    answer: "The agreement ends in June [1].",
    citations: [{ n: 1, title: "Agreement", source: "drive" }],
    results: [{ title: "Agreement", source: "drive", chunk_uid: "drive:agreement#0" }],
    gaps: [],
    evidence_gate: { supported: true, complete: true },
  };
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.post = async (path) => path === "/api/rag/unified"
    ? { ok: true, status: 200, json: { results: [{ title: "candidate" }] } }
    : { ok: true, status: 200, json: valid };
  await suite.tierRetrieval(["When does it end?"]);
  check("a consistent cited answer still passes the answer contract",
    suite.results.some((result) => result.status === "pass" && result.name === "think returns an answer") &&
      !suite.results.some((result) => result.name === "think response contract"),
    JSON.stringify(suite.results));
}

console.log(`\nacceptance verdict: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
