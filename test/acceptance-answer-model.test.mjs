import assert from "node:assert/strict";
import test from "node:test";

import { Acceptance } from "../acceptance.mjs";

const candidate = Object.freeze({
  title: "Synthetic record",
  source: "fixture",
  chunk_uid: "fixture:record#0",
});

const factualAnswer = (model) => ({
  mode: "think",
  answer: "The synthetic agreement ends in June [1].",
  model,
  citations: [{ n: 1, title: candidate.title, source: candidate.source }],
  results: [candidate],
  gaps: [],
  evidence_gate: { supported: true, complete: true, evidence: [1] },
});

const nullAnswer = (model) => ({
  mode: "think",
  answer: null,
  model,
  citations: [],
  results: [candidate],
  gaps: [],
  evidence_gate: { supported: false, complete: false, evidence: [] },
});

async function runThink(manifest, response) {
  const suite = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-key-label",
    manifest,
    retrievalRetry: { attempts: 0 },
  });
  let thinkCalls = 0;
  suite.post = async (path) => {
    if (path === "/api/rag/unified") {
      return { ok: true, status: 200, json: { results: [candidate] } };
    }
    thinkCalls += 1;
    return { ok: true, status: 200, json: response };
  };
  await suite.tierRetrieval(["What changed?"]);
  assert.equal(thinkCalls, 1, "the answer-model decision point was reached");
  return suite.results;
}

test("a configured Claude answer model cannot pass acceptance with a null answer", async () => {
  const results = await runThink(
    { retrieval: { answer_model: "claude-opus-5-5", gate_model: "claude-sonnet-5-5" } },
    nullAnswer("claude-opus-5-5"),
  );
  assert.ok(results.some((result) =>
    result.status === "fail" && result.name === "configured answer model returned an answer" &&
    /claude-opus-5-5/iu.test(result.detail)));
});

test("a configured Claude answer model cannot pass acceptance under another model", async () => {
  const results = await runThink(
    { retrieval: { answer_model: "claude-opus-5-5", gate_model: "claude-sonnet-5-5" } },
    factualAnswer("claude-sonnet-5-5"),
  );
  assert.ok(results.some((result) =>
    result.status === "fail" && result.name === "configured answer model matches" &&
    /expected claude-opus-5-5[\s\S]*received claude-sonnet-5-5/iu.test(result.detail)));
});

test("the configured Claude answer model passes only with answer text and an exact model receipt", async () => {
  const results = await runThink(
    { retrieval: { answer_model: "claude-opus-5-5", gate_model: "claude-sonnet-5-5" } },
    factualAnswer("claude-opus-5-5"),
  );
  assert.ok(results.some((result) =>
    result.status === "pass" && result.name === "configured answer model returned an answer"));
  assert.ok(results.some((result) =>
    result.status === "pass" && result.name === "configured answer model matches"));
});

test("the built-in model keeps the existing clean-degradation verdict", async () => {
  const results = await runThink({}, nullAnswer("@cf/meta/llama-3.3-70b-instruct-fp8-fast"));
  assert.ok(results.some((result) =>
    result.status === "pass" && result.name === "think degrades cleanly"));
  assert.equal(results.some((result) => result.name.startsWith("configured answer model")), false);
});
