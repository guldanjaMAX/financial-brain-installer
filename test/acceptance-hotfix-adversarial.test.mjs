import assert from "node:assert/strict";
import test from "node:test";
import { Acceptance, answerUnavailableDiagnostic } from "../acceptance.mjs";

const model = "claude-opus-5-5";
const manifest = { retrieval: { answer_model: model, gate_model: "claude-sonnet-5-5" } };
const questions = ["What changed?", "What is recorded?", "What is supported?", "What else changed?"];
const candidate = { chunk_uid: "fixture:record#0", title: "Synthetic record", source: "fixture" };
const refused = (overrides = {}) => ({
  mode: "think", answer: null, model, citations: [], results: [candidate], gaps: [],
  status: "answer_withheld",
  evidence_gate: { supported: false, complete: true, evidence: [] },
  ...overrides,
});
const answered = () => ({
  mode: "think", answer: "The synthetic record changed [1].", model,
  citations: [{ n: 1, title: candidate.title, source: candidate.source }],
  results: [candidate], gaps: [], evidence_gate: { supported: true, complete: true, evidence: [1] },
});

async function exercise(responses, { retry = {}, builtIn = false, unified = null } = {}) {
  const calls = [], waits = [];
  let unifiedCalls = 0;
  const suite = new Acceptance({
    base: "https://fixture.invalid", adminKey: "fixture-label", manifest: builtIn ? {} : manifest,
    retrievalRetry: { attempts: 0, ...retry },
    sleepImpl: async (ms) => waits.push(ms),
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      const body = JSON.parse(init.body);
      if (new URL(url).pathname === "/api/rag/unified") {
        unifiedCalls++;
        return Response.json(unified ? unified(unifiedCalls) : { results: [candidate] });
      }
      assert.equal(new URL(url).pathname, "/api/rag/think");
      assert.equal(body.limit, 5);
      calls.push(body.q);
      assert.ok(calls.length <= responses.length, "answer request count stays within the planned responses");
      return Response.json(responses[calls.length - 1]);
    },
  });
  await suite.tierRetrieval(questions);
  assert.ok(unifiedCalls >= questions.length, "the retrieval decision point ran");
  assert.ok(calls.length > 0, "the configured answer decision point ran");
  return { summary: suite.summary(), results: suite.results, calls, waits, unifiedCalls };
}

async function greenControl() {
  const control = await exercise([refused(), answered()]);
  assert.equal(control.summary.passed, true);
  assert.deepEqual(control.calls, questions.slice(0, 2));
}

test("unreadable verifier output must block configured acceptance", async () => {
  await greenControl();
  const bad = refused({ evidence_gate: {
    supported: false, complete: false, evidence: [], unreadable: true,
  } });
  const run = await exercise([bad, bad, bad]);
  assert.deepEqual(run.calls, questions.slice(0, 1), "the first unreadable verifier receipt stops the answer probes");
  assert.equal(run.summary.passed, false, "two unreadable verifier replies are not a clean evidence decision");
});

test("a forged empty-result model receipt must not certify execution", async () => {
  await greenControl();
  const bad = refused({ results: [], status: "coverage_incomplete" });
  const run = await exercise([bad, bad, bad]);
  assert.deepEqual(run.calls, questions.slice(0, 1), "the first empty-result receipt stops the answer probes");
  assert.equal(run.summary.passed, false, "the reviewed Worker returns before model dispatch when results are empty");
});

test("earlier answer-probe recovery remains in the receipt", async () => {
  const control = await exercise([refused({ degraded: "vector" }), answered()], {
    retry: { attempts: 1, spacingMs: 7, probeBudgetMs: 7, tierBudgetMs: 7 },
  });
  assert.deepEqual(control.waits, [7]);
  assert.equal(control.summary.passed, true);
  assert.ok(control.results.some((row) => row.name === "think uses semantic retrieval" && /1 retry/.test(row.detail)));
  const run = await exercise([refused({ degraded: "vector" }), refused(), answered()], {
    retry: { attempts: 1, spacingMs: 7, probeBudgetMs: 7, tierBudgetMs: 7 },
  });
  assert.deepEqual(run.calls, [questions[0], questions[0], questions[1]]);
  assert.deepEqual(run.waits, [7]);
  assert.equal(run.summary.passed, true);
  assert.ok(run.results.some((row) => row.name === "think uses semantic retrieval" && /1 retry/.test(row.detail)),
    "a later clean question must not erase the earlier recovered retry");
});

for (const [label, overrides] of [
  ["wrong key", { answer_error: "Answer generation is unavailable right now. Try again in a moment." }],
  ["missing key", { answer_error: "Answer generation is unavailable right now. Try again in a moment.", gaps: [{ type: "anthropic_key_missing" }] }],
  ["daily spend limit", { answer_error: "Daily answer limit reached. Answers resume tomorrow." }],
  ["provider failure", { answer_error: "Answer generation is unavailable right now. Try again in a moment." }],
  ["missing model receipt", { model: undefined }],
  ["wrong model receipt", { model: "claude-sonnet-5-5" }],
  ["partial gate", { evidence_gate: { supported: false } }],
  ["null gate", { evidence_gate: null }],
  ["partial flag", { evidence_gate: { supported: false, complete: false, evidence: [], partial: true } }],
  ["null answer-error field", { answer_error: null }],
  ["empty verifier-error field", { evidence_gate: { supported: false, complete: false, evidence: [], error: "" } }],
]) {
  test(`${label} stays blocking with a passing peer`, async () => {
    await greenControl();
    const run = await exercise([refused(overrides), answered()]);
    assert.deepEqual(run.calls, questions.slice(0, 1));
    assert.equal(run.summary.passed, false);
  });
}

test("the shared retry budget binds across all configured questions", async () => {
  await greenControl();
  const bad = refused({ degraded: "vector" });
  const run = await exercise([bad, refused(), bad, refused(), bad], {
    retry: { attempts: 4, spacingMs: 7, probeBudgetMs: 28, tierBudgetMs: 14 },
  });
  assert.deepEqual(run.calls, [questions[0], questions[0], questions[1], questions[1], questions[2]]);
  assert.deepEqual(run.waits, [7, 7]);
  assert.equal(run.summary.passed, false);
});

test("the default retry policy caps answer traffic at fifteen requests", async () => {
  await greenControl();
  const group = () => [refused({ degraded: "vector" }), refused({ degraded: "vector" }),
    refused({ degraded: "vector" }), refused({ degraded: "vector" }), refused()];
  const run = await exercise([...group(), ...group(), ...group()], { retry: { attempts: 4 } });
  assert.equal(run.calls.length, 15);
  assert.deepEqual(run.calls, questions.slice(0, 3).flatMap((q) => Array(5).fill(q)));
  assert.equal(run.waits.length, 12);
  assert.equal(run.waits.reduce((total, ms) => total + ms, 0), 180_000);
  assert.equal(run.summary.passed, true);
});

test("retrieval retries consume the same budget before answer probes", async () => {
  await greenControl();
  const run = await exercise([refused({ degraded: "vector" })], {
    retry: { attempts: 1, spacingMs: 7, probeBudgetMs: 7, tierBudgetMs: 7 },
    unified: (count) => count === 1 ? { results: [], degraded: "vector" } : { results: [candidate] },
  });
  assert.equal(run.unifiedCalls, questions.length + 1);
  assert.deepEqual(run.waits, [7]);
  assert.deepEqual(run.calls, questions.slice(0, 1));
  assert.equal(run.summary.passed, false);
});

test("an incomplete but honest refusal remains a nonblocking warning", async () => {
  await greenControl();
  const response = refused({ evidence_gate: { supported: false, complete: false, evidence: [] } });
  const run = await exercise([response, response, response]);
  assert.deepEqual(run.calls, questions.slice(0, 3));
  assert.equal(run.summary.passed, true);
  assert.equal(run.summary.counts.fail, 0);
});

test("the built-in route retains one-probe clean-degradation behavior", async () => {
  await greenControl();
  const run = await exercise([refused({ model: undefined, evidence_gate: undefined })], { builtIn: true });
  assert.deepEqual(run.calls, questions.slice(0, 1));
  assert.equal(run.summary.passed, true);
  assert.ok(run.results.some((row) => row.name === "think degrades cleanly" && row.status === "pass"));
});

test("private verifier detail never enters the diagnostic", () => {
  const diagnostic = answerUnavailableDiagnostic(refused({ evidence_gate: {
    supported: false, complete: false, evidence: [], unreadable: true,
    reason: "synthetic-private-reason-canary", invalid_response: "synthetic-private-output-canary",
  } }));
  assert.doesNotMatch(JSON.stringify(diagnostic), /synthetic-private-/);
});
