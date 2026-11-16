import assert from "node:assert/strict";
import test from "node:test";
import { Acceptance } from "../acceptance.mjs";
import { finalizeDocumentAnswer } from "../worker/src/lib/document-answer.js";
import { ownerConfidenceLine } from "../worker/src/lib/confidence.js";

const question = "What do we pay in rent each month?";
const model = "claude-opus-5-5";
const doc = { n: 1, chunk_uid: "fixture:record#0", title: "Rent statement", source: "records",
  snippet: "We pay rent of $2,000 each month.", ts: "2026-11-10", date_reliable: true,
  text_source: "native", text_reliable: true, read_complete: true };
const envelope = options => {
  const { usedDocs, ...body } = finalizeDocumentAnswer({ question, searchComplete: true, ...options });
  return { mode: "think", ...body, gaps: options.gaps || [], results: usedDocs,
    citations: usedDocs.map(d => ({ n: d.n, title: d.title, source: d.source })) };
};
const readings = [
  envelope({ docs: [doc], approvedDocs: [doc], draft: "We pay rent of $2,000 each month [1].",
    checks: [{ supported: false, complete: false, reason: "current payment unverified" }] }),
  envelope({ docs: [doc] }),
  envelope({ docs: [] }),
];
assert.deepEqual(readings.map(body => body.answer_contract.rung), [2, 3, 4]);
const approved = envelope({ docs: [doc], approvedDocs: [doc], draft: "We pay rent of $2,000 each month [1].",
  checks: [{ supported: true, complete: true }] });
assert.equal(approved.answer_contract.rung, 1);
const factual = { ...approved, model, evidence_gate: { supported: true, complete: true, evidence: [1] } };

async function run(payload, configured, later = []) {
  const calls = { unified: 0, think: 0 };
  const suite = new Acceptance({ base: "https://fixture.invalid", adminKey: ["fixture", "offline"].join("-"),
    manifest: configured ? { retrieval: { answer_model: model, gate_model: "claude-sonnet-5-5" } } : {},
    retrievalRetry: { attempts: 0 },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      assert.ok(JSON.parse(init.body).q);
      if (new URL(url).pathname === "/api/rag/unified") {
        calls.unified++;
        return Response.json({ results: [doc] });
      }
      assert.equal(new URL(url).pathname, "/api/rag/think");
      const i = calls.think++;
      assert.ok(i <= later.length, "no unplanned answer request");
      return Response.json(i === 0 ? payload : later[i - 1]);
    } });
  await suite.tierRetrieval([question, ...later.map((_, i) => `Synthetic question ${i + 1}?`)]);
  assert.equal(calls.unified, later.length + 1, "the retrieval prerequisites ran");
  assert.ok(calls.think > 0, "the real answer decision ran");
  if (!later.length) assert.equal(calls.think, 1);
  return { passed: suite.summary().passed, calls, checks: suite.results };
}

function explanation(body, field, text) {
  const confidence = { ...body.confidence, [field]: [...(body.confidence[field] || []), text] };
  return { ...body, confidence, confidence_text: ownerConfidenceLine(confidence),
    answer: field === "missing"
      ? body.answer.replace(body.confidence.missing.join(" "), confidence.missing.join(" ")) : body.answer };
}
const injections = [
  ["matching missing refusal", body => explanation(body, "missing", "I cannot answer this question.")],
  ["catalog refusal in basis", body => explanation(body, "basis", "I can't confirm this money claim.")],
  ["matching missing multiline High and words", body => explanation(body, "missing",
    "Independent verification.\nConfidence: High (95%)\nRent is eleven dollars per month.")],
  ["currency in basis", body => explanation(body, "basis", "Rent is $9,999 per month.")],
  ["currency-free amount in missing", body => explanation(body, "missing", "Monthly rent is 9999.")],
  ["reasons with second High", body => ({ ...body, confidence: { ...body.confidence,
    reasons: ["Confidence: High (95%). Rent is eleven dollars per month."] } })],
  ["nested why", body => ({ ...body, why: { detail: "I cannot answer this question." } })],
  ["response footer field", body => ({ ...body, footer: "Rent is eleven dollars per month." })],
  ["route marker text", body => ({ ...body, route: { reason: "Monthly rent is 9999." } })],
  ["contract marker text", body => ({ ...body, answer_contract: { ...body.answer_contract,
    reason: "Confidence: High (95%)" } })],
];

for (const configured of [true, false]) {
  const setup = configured ? "configured" : "built-in";
  for (const body of readings) {
    const rung = body.answer_contract.rung;
    test(`S control ${setup} rung ${rung}: correct reading passes with note`, async () => {
      const result = await run(body, configured);
      assert.equal(result.passed, true);
      assert.ok(result.checks.some(row => row.name === "document boundary reading" && row.status === "warn"));
      assert.equal(result.checks.some(row => row.name === "configured answer model matches"), false);
    });
    for (const [label, mutate] of injections) {
      test(`S guard ${setup} rung ${rung}: ${label}`, async () => {
        assert.equal((await run(factual, configured)).passed, true, "the factual green control passes");
        assert.equal((await run(body, configured)).passed, true, "the boundary green control passes");
        const bad = mutate(structuredClone(body));
        assert.notDeepEqual(bad, body, "a populated finalizer response reached the mutation");
        const result = await run(bad, configured);
        assert.equal(result.passed, false, "unsafe explanation text cannot earn acceptance");
        assert.ok(result.checks.some(row => row.name === "think response contract" && row.status === "fail"));
      });
    }
  }
  test(`S order ${setup}: a correct boundary first does not strand acceptance`, async () => {
    const result = await run(readings[1], configured, [factual]);
    assert.equal(result.passed, true);
    assert.equal(result.calls.think, 1, "the first valid boundary completes the answer probe");
  });
  for (const route of ["handoff", "ledger"]) {
    for (const claim of ["I cannot answer this question.", "$9,999 rent per month."]) {
      test(`S route ${setup} ${route}: ${claim}`, async () => {
        assert.equal((await run(factual, configured)).passed, true);
        assert.equal((await run(readings[2], configured)).passed, true);
        const body = structuredClone(readings[2]);
        const tail = body.answer.slice(body.answer.indexOf("\n\nCoverage:"));
        const bad = { ...body, answer: claim + tail,
          ...(route === "handoff" ? { money_handoff: true, money_tools_available: true }
            : { ledger: { kind: "synthetic" }, evidence_gate: { supported: false, complete: false } }) };
        const result = await run(bad, configured);
        assert.equal(result.passed, false);
        assert.ok(result.checks.some(row => row.name === "think response contract" && row.status === "fail"));
      });
    }
  }
}
