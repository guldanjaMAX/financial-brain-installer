import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { moneyQuestionHandoff } from "../worker/src/lib/money-handoff.js";
import { finalizeDocumentAnswer } from "../worker/src/lib/document-answer.js";
import { ownerConfidenceLine } from "../worker/src/lib/confidence.js";
import { ledgerFixture, NOW } from "../worker/test/ledger-review-fixture.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";
// Keep the boundary text regressions in the existing offline acceptance gate.
import "./acceptance-boundary-text.test.mjs";

const { Acceptance, answerUnavailableDiagnostic, answerResponseContractDiagnostic } = await import(
  process.env.ACCEPTANCE_TEST_MODULE || "../acceptance.mjs"
);

const expectedModel = "claude-opus-5-5";
const configured = { retrieval: { answer_model: expectedModel, gate_model: "claude-sonnet-5-5" } };
const probes = ["What changed?", "When does the agreement end?", "What is recorded?", "What else changed?"];

const candidate = Object.freeze({
  title: "Synthetic record",
  source: "fixture",
  chunk_uid: "fixture:record#0",
});

const factualAnswer = (model = expectedModel) => ({
  mode: "think",
  answer: "The synthetic agreement ends in June [1].",
  model,
  citations: [{ n: 1, title: candidate.title, source: candidate.source }],
  results: [candidate],
  gaps: [],
  evidence_gate: { supported: true, complete: true, evidence: [1] },
});

const withheld = (overrides = {}) => ({
  mode: "think",
  answer: null,
  model: expectedModel,
  citations: [],
  results: [candidate],
  status: "coverage_incomplete",
  gaps: [{ type: "coverage_stale" }],
  evidence_gate: { supported: false, complete: true, evidence: [] },
  ...overrides,
});

async function runThink(responses, { manifest = configured, questions = probes, retry = {} } = {}) {
  const calls = [];
  const waits = [];
  const suite = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-key-label",
    manifest,
    retrievalRetry: { attempts: 0, ...retry },
    sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      const body = JSON.parse(init.body);
      if (new URL(url).pathname === "/api/rag/unified") {
        return Response.json({ results: [candidate] });
      }
      assert.equal(new URL(url).pathname, "/api/rag/think");
      assert.equal(body.limit, 5);
      calls.push(body.q);
      assert.ok(calls.length <= responses.length, "no unplanned answer request");
      const response = responses[calls.length - 1];
      return Response.json(response.payload ?? response, { status: response.httpStatus ?? 200 });
    },
  });
  await suite.tierRetrieval(questions);
  assert.ok(calls.length > 0, "the real HTTP answer-model decision point was reached");
  return { suite, results: suite.results, summary: suite.summary(), calls, waits };
}

const configuredFailure = (results) => results.some((result) =>
  result.status === "fail" && (result.name.startsWith("configured answer model") ||
    result.name === "think endpoint" || result.name === "think response contract"));

const moneyProbe = "What do we pay in rent each month?";

// Since the docs boundary (deep review MF1) the Worker answers a saved bank
// question for the admin key itself, so acceptance never receives a hand-off
// from the deployed route. Acceptance still accepts the exact product
// hand-off shape that both MCP layers build (moneyQuestionHandoff) as a
// warning, and the broken-probe path still runs the real Worker's auth.
// Document retrieval and model output stay injected; no provider,
// credential store, or network is reachable.
async function runMoneyProbes(questions, {
  manifest = configured, broken = false, mutate = (body) => body, documentResponse = null,
} = {}) {
  const calls = [], routed = [];
  const fixtureKey = ["fixture", "offline", "acceptance"].join("-");
  const suite = new Acceptance({
    base: "https://fixture.invalid", adminKey: fixtureKey, manifest,
    retrievalRetry: { attempts: 0 },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      const path = new URL(url).pathname;
      const { q } = JSON.parse(init.body);
      if (path === "/api/rag/unified") return Response.json({ results: [candidate] });
      assert.equal(path, "/api/rag/think");
      calls.push(q);
      if (q === moneyProbe) {
        const body = moneyQuestionHandoff(q);
        routed.push({ status: 200, handoff: body?.money_handoff === true });
        return Response.json(mutate(body), { status: 200 });
      }
      if (broken) {
        const headers = new Headers(init.headers);
        if (q !== moneyProbe) headers.delete("X-Admin-Key");
        const response = await worker.fetch(new Request(url, { ...init, headers }), {
          ADMIN_KEY: fixtureKey, STORAGE: "d1",
          DB: { prepare() { assert.fail("routing and auth must finish before database access"); } },
        }, { waitUntil() {}, passThroughOnException() {} });
        const body = await response.json();
        routed.push({ status: response.status, handoff: body.money_handoff === true });
        return Response.json(mutate(body), { status: response.status });
      }
      return Response.json(documentResponse ?? factualAnswer(manifest.retrieval?.answer_model));
    },
  });
  await suite.tierRetrieval(questions);
  assert.ok(routed.length > 0, "the product hand-off or the real Worker auth decision was reached");
  return { suite, calls, routed, summary: suite.summary() };
}

for (const [label, manifest] of [["configured", configured], ["built-in", {}]]) {
  test(`money hand-off: ${label} acceptance moves on to a document probe`, async () => {
    const run = await runMoneyProbes([moneyProbe, probes[0]], { manifest });
    assert.deepEqual(run.routed, [{ status: 200, handoff: true }]);
    assert.equal(run.summary.passed, true);
    assert.deepEqual(run.calls, [moneyProbe, probes[0]], "routing guidance cannot consume the answer-probe budget");
    assert.ok(run.suite.results.some((row) => row.status === "warn" && /money hand-off/.test(row.name)));
    assert.ok(run.suite.results.some((row) => row.status === "pass" && row.name === "think returns an answer"));
  });
}

test("money hand-off: three initial money questions cannot hide a later broken probe", async () => {
  const questions = [moneyProbe, moneyProbe, moneyProbe, probes[0], probes[1]];
  const control = await runMoneyProbes(questions);
  assert.deepEqual(control.calls, questions.slice(0, 4));
  assert.equal(control.summary.passed, true);
  const bad = await runMoneyProbes(questions, { broken: true });
  assert.deepEqual(bad.calls, questions.slice(0, 4), "the broken document probe stops before the later control");
  assert.deepEqual(bad.routed.at(-1), { status: 401, handoff: false }, "the real Worker rejected the broken probe");
  assert.equal(bad.summary.passed, false);
  assert.ok(bad.suite.results.some((row) => row.status === "fail" && row.name === "think endpoint"));
});

test("money hand-off: an all-money list warns without claiming answer-model proof", async () => {
  const run = await runMoneyProbes([moneyProbe, moneyProbe, moneyProbe]);
  assert.equal(run.routed.length, 3, "every saved routing decision was reached");
  assert.equal(run.summary.passed, true);
  assert.equal(run.summary.counts.warn, 3);
  assert.equal(run.suite.results.some((row) => /configured answer model|think returns an answer|inline citations/.test(row.name)), false);
  assert.ok(run.suite.results.filter((row) => row.status === "warn").every((row) => /not verified/.test(row.detail)));
});

test("money hand-off: a final hand-off preserves the earlier document-model receipt", async () => {
  const run = await runMoneyProbes([moneyProbe, probes[0], moneyProbe], { documentResponse: withheld() });
  assert.deepEqual(run.calls, [moneyProbe, probes[0], moneyProbe]);
  assert.equal(run.routed.length, 2);
  assert.equal(run.summary.passed, true);
  assert.ok(run.suite.results.some((row) => row.name === "configured answer model ran" && row.status === "warn"));
  assert.equal(run.suite.results.some((row) => row.name === "think returns an answer"), false);
});

test("money hand-off: configured document probes retain their three-question limit", async () => {
  const questions = [moneyProbe, ...probes];
  const run = await runMoneyProbes(questions, { documentResponse: withheld() });
  assert.deepEqual(run.calls, questions.slice(0, 4));
  assert.equal(run.summary.passed, true);
  assert.ok(run.suite.results.some((row) => row.name === "configured answer model ran" && row.status === "warn"));
});

// The real post-boundary Worker gives the admin key a deterministic bank
// reading for a saved bank question. Like a hand-off it is not a document or
// model probe: it spends none of the document-probe budget and cannot replace
// an earlier document receipt.
const ledgerProbe = "How much did I spend in October 2026?";
async function runLedgerProbes(t, questions, { manifest = configured, documentResponse = null } = {}) {
  t.mock.method(Date, "now", () => Date.parse(NOW));
  const book = ledgerFixture(t);
  book.add("purchase", "Office supplies", "Store", { cents: 12500, direction: "outflow" });
  const calls = [], readings = [];
  const suite = new Acceptance({
    base: "https://fixture.invalid", adminKey: "fixture-acceptance-label", manifest,
    retrievalRetry: { attempts: 0 },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      const path = new URL(url).pathname;
      const { q } = JSON.parse(init.body);
      if (path === "/api/rag/unified") return Response.json({ results: [candidate] });
      assert.equal(path, "/api/rag/think");
      calls.push(q);
      if (q !== ledgerProbe) return Response.json(documentResponse ?? factualAnswer(manifest.retrieval?.answer_model));
      const before = book.calls.length;
      const response = await worker.fetch(new Request(url, { method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Key": book.env.ADMIN_KEY }, body: init.body }),
      book.env, { waitUntil() {}, passThroughOnException() {} });
      const body = await response.json();
      assert.ok(book.calls.length > before, "the real Worker read the populated ledger");
      assert.equal(body.answer_contract?.kind, "ledger");
      assert.equal(body.confidence.percent, 0, "missing money-tool assessment stays Low");
      assert.match(body.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
      assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
      readings.push({ status: response.status, handoff: body.money_handoff === true, total: body.ledger?.total_minor });
      return Response.json(body, { status: response.status });
    },
  });
  await suite.tierRetrieval(questions);
  return { suite, calls, readings, summary: suite.summary() };
}

for (const [label, manifest] of [["configured", configured], ["built-in", {}]]) {
  test(`bank reading: ${label} acceptance moves on from the real Worker reading to a document probe`, async (t) => {
    const run = await runLedgerProbes(t, [ledgerProbe, probes[0]], { manifest });
    assert.deepEqual(run.readings, [{ status: 200, handoff: false, total: 12500 }]);
    assert.deepEqual(run.calls, [ledgerProbe, probes[0]]);
    assert.equal(run.summary.passed, true);
    assert.ok(run.suite.results.some((row) => row.status === "pass" && row.name === "think returns an answer"));
    assert.equal(run.suite.results.some((row) => row.name === "document answer probe"), false);
  });
}

test("bank reading: an all-bank list warns without claiming answer-model proof", async (t) => {
  const run = await runLedgerProbes(t, [ledgerProbe, ledgerProbe]);
  assert.equal(run.readings.length, 2);
  assert.equal(run.summary.passed, true);
  assert.ok(run.suite.results.some((row) => row.status === "warn" && row.name === "document answer probe"));
  assert.equal(run.suite.results.some((row) => /configured answer model|think returns an answer|inline citations/.test(row.name)), false);
});

test("bank reading: configured document probes keep their three-question limit", async (t) => {
  const questions = [ledgerProbe, ...probes];
  const run = await runLedgerProbes(t, questions, { documentResponse: withheld() });
  assert.deepEqual(run.calls, questions.slice(0, 4), "a bank reading cannot consume the document-probe budget");
  assert.equal(run.summary.passed, true);
  assert.ok(run.suite.results.some((row) => row.name === "configured answer model ran" && row.status === "warn"));
});

test("bank reading: a final bank reading preserves the earlier document-model receipt", async (t) => {
  const run = await runLedgerProbes(t, [probes[0], ledgerProbe], { documentResponse: withheld() });
  assert.deepEqual(run.calls, [probes[0], ledgerProbe]);
  assert.equal(run.readings.length, 1);
  assert.equal(run.summary.passed, true);
  assert.ok(run.suite.results.some((row) => row.name === "configured answer model ran" && row.status === "warn"));
  assert.equal(run.suite.results.some((row) => row.name === "document answer probe"), false);
});

// F1 exercises the deployed route, SQLite retrieval, full-text read and
// sensitive-record screen. Only model/embedding bindings are local fakes.
// Missing configured-model access must still yield the Worker's source
// reading, without acceptance claiming that the configured model ran.
const boundaryNow = "2026-11-12T19:00:00.000Z";
const householdText = "Tax Return 2025 / Form 1040 / We pay rent of $2,000 each month to the landlord.";
const rentText = "We pay rent of $2,000 each month to the landlord.";
const identityText = () => `SSN: ${["000", "00", "0000"].join("-")}. ${rentText}`;
async function runDocumentBoundary(t, {
  manifest = configured, question = "Who is the landlord?", content = householdText,
  noRecords = false, broken = null, mutate = (body) => body,
} = {}) {
  t.mock.method(Date, "now", () => Date.parse(boundaryNow));
  let outsideCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    outsideCalls++;
    assert.fail("no external request is permitted by the boundary fixture");
  });
  const f = await createProductFixture({ env: {
    BRAIN_TIMEZONE: "UTC",
    ...(manifest.retrieval?.answer_model ? { ANSWER_MODEL: manifest.retrieval.answer_model } : {}),
    AI: { async run(model) {
      if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
      return { response: "The documents do not answer the question." };
    } },
  } });
  const calls = [], readings = [];
  let unifiedCalls = 0;
  try {
    f.raw("INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES ('records','upload','ready',?,?,?,86400)",
      boundaryNow, boundaryNow, boundaryNow);
    if (!noRecords) {
      const saved = await f.post("/api/admin/brain/ingest/batch", { docs: [{
        source_type: "records", source_id: "household", title: "Household papers", content,
        occurred_at: "2026-11-10", date_source: "fixture:recorded_at", date_reliable: true,
        text_source: "native", text_reliable: true,
        metadata: { evidence_lineage: { version: 1, kind: "source_record" } },
      }] }, { "X-Admin-Key": f.env.ADMIN_KEY });
      assert.equal(saved.status, 200, "the synthetic record reached real Worker ingest");
    }
    // Seed a complete synthetic projection, as the acceptance prerequisite
    // requires. Pending real ingest work must remain a separate failure.
    const vectorCount = Number(f.first("SELECT count(*) AS n FROM chunks").n);
    f.raw("DELETE FROM vector_outbox");
    f.raw("UPDATE install_state SET vector_projection_status='verified', vector_projection_bootstrap_base_count=? WHERE id=1", vectorCount);
    f.env.VECTORIZE.describe = async () => ({ vectorCount, processedUpToMutation: null });
    const suite = new Acceptance({
      base: "https://fixture.invalid", adminKey: f.env.ADMIN_KEY, manifest,
      retrievalRetry: { attempts: 0 },
      fetchImpl: async (url, init) => {
        assert.equal(new URL(url).origin, "https://fixture.invalid");
        const path = new URL(url).pathname;
        if (path === "/api/rag/unified") {
          unifiedCalls++;
          // Isolate the empty-search answer from the independent nonempty
          // unified-probe prerequisite. All populated cases use real search.
          if (noRecords) return Response.json({ results: [candidate] });
          const response = await f.post(path, JSON.parse(init.body), Object.fromEntries(new Headers(init.headers)));
          const body = await response.json();
          assert.equal(response.status, 200);
          assert.equal(body.results.length, 1, "search found the populated synthetic record");
          assert.equal(body.degraded, undefined, "the synthetic search completed both retrieval paths");
          return Response.json(body);
        }
        assert.equal(path, "/api/rag/think");
        calls.push(JSON.parse(init.body).q);
        const headers = new Headers(init.headers);
        if (broken === "route") headers.delete("X-Admin-Key");
        const before = f.seen.sql.length;
        const response = await f.post(path, JSON.parse(init.body), Object.fromEntries(headers));
        const body = await response.json();
        if (broken !== "route") assert.ok(f.seen.sql.length > before, "the real Worker answer read was reached");
        readings.push({ status: response.status, body });
        if (broken === "empty") return new Response("", { status: 200 });
        return Response.json(mutate(body), { status: response.status });
      },
    });
    await suite.tierRetrieval([question]);
    assert.equal(unifiedCalls, 1, "the retrieval decision point was reached");
    assert.deepEqual(calls, [question], "the saved answer decision point was reached exactly once");
    assert.equal(outsideCalls, 0, "all Worker dependencies stayed offline");
    return { suite, summary: suite.summary(), readings };
  } finally { f.close(); }
}

function assertBoundaryReading(run, { rung, screened = false } = {}) {
  const [{ status, body }] = run.readings;
  assert.equal(status, 200);
  assert.equal(body.answer_contract?.kind, "document");
  assert.equal(body.answer_contract.rung, rung);
  assert.equal(answerResponseContractDiagnostic(body), null, "the real Worker contract is valid before acceptance");
  assert.ok(body.confidence.percent < 90, "a provisional reading never claims High confidence");
  if (screened) {
    assert.equal(body.withheld_documents?.count, 1, "the populated record reached the sensitive-record decision");
    assert.deepEqual(body.results, []);
    assert.deepEqual(body.citations, []);
    assert.doesNotMatch(body.answer, /\$2,000/, "screened text does not become an owner claim");
    assert.equal(body.answer.includes(["000", "00", "0000"].join("-")), false);
  }
  assert.equal(run.summary.passed, true, JSON.stringify(run.suite.results.filter(row => row.status === "fail")));
  assert.ok(run.suite.results.some(row => row.status === "warn" && /boundary reading/.test(row.name)),
    "the limited reading remains an explicit acceptance note");
  assert.ok(run.suite.results.some(row => row.status === "pass" && row.name === "think returns an answer"));
  assert.equal(run.suite.results.some(row => row.name === "configured answer model matches"), false,
    "a source reading is not proof of configured-model execution");
}

for (const [label, manifest] of [["configured", configured], ["built-in", {}]]) {
  for (const question of ["Who is the landlord?", moneyProbe]) {
    for (const [kind, content] of [["filing header", householdText], ["identity number", identityText()]]) {
      test(`F1 ${label}: ${kind}, ${question} is a screened reading with a note`, async t => {
        const run = await runDocumentBoundary(t, { manifest, question, content });
        assertBoundaryReading(run, { rung: 4, screened: true });
      });
    }
  }
  test(`F1 ${label}: a rung-3 source extract passes with a note`, async t => {
    const run = await runDocumentBoundary(t, { manifest, content: rentText });
    assert.match(run.readings[0].body.answer, /\$2,000/);
    assertBoundaryReading(run, { rung: 3 });
  });
  test(`F1 ${label}: a real Worker no-match reading passes with a note`, async t => {
    const run = await runDocumentBoundary(t, { manifest, noRecords: true });
    assert.match(run.readings[0].body.answer, /Not found in 0 records returned by this search/);
    assertBoundaryReading(run, { rung: 4 });
  });
  for (const broken of ["route", "empty"]) {
    test(`F1 ${label}: a ${broken} failure still blocks beside a valid boundary control`, async t => {
      assert.equal((await runThink([factualAnswer()], { manifest })).summary.passed, true,
        "the same acceptance decision has a passing factual control");
      const control = await runDocumentBoundary(t, { manifest });
      assert.equal(answerResponseContractDiagnostic(control.readings[0].body), null);
      const bad = await runDocumentBoundary(t, { manifest, broken });
      assert.equal(bad.readings.length, 1, "the broken probe reached the real Worker route");
      assert.equal(bad.readings[0].status, broken === "route" ? 401 : 200);
      assert.equal(bad.summary.passed, false);
      assert.ok(bad.suite.results.some(row => row.status === "fail" &&
        row.name === (broken === "route" ? "think endpoint" : "think response contract")));
    });
  }
}

for (const [label, mutate] of [
  ["missing confidence", body => ({ ...body, confidence: undefined })],
  ["missing contract lines", body => ({ ...body, answer: body.answer.split("\n\nCoverage:")[0] })],
  ["false High score", body => ({ ...body, confidence: { ...body.confidence, percent: 95, band: "High" } })],
  ["unavailable state", body => ({ ...body, status: "search_unavailable" })],
  ["unbound extract", body => ({ ...body, answer: body.answer.replace("$2,000", "$9,999") })],
]) {
  test(`F1 malformed ${label} cannot use the boundary exception`, async t => {
    assert.equal((await runThink([factualAnswer()])).summary.passed, true,
      "the same acceptance decision has a passing factual control");
    const control = await runDocumentBoundary(t, { content: rentText });
    assert.equal(answerResponseContractDiagnostic(control.readings[0].body), null);
    const bad = await runDocumentBoundary(t, { content: rentText, mutate });
    assert.equal(bad.readings[0].body.answer_contract.rung, 3, "a populated source reading reached the mutation point");
    assert.equal(bad.summary.passed, false);
    assert.ok(bad.suite.results.some(row => row.name === "think response contract" && row.status === "fail"));
  });
}

// Retain the review's malformed finalizer envelopes through the real Worker
// probe. Each arm proves the source-reading decision ran before corruption,
// and has both a factual and a finalized-boundary passing control.
const boundaryFooter = body => body.answer.slice(body.answer.indexOf("\n\nCoverage:"));
const boundaryEnvelope = options => {
  const { usedDocs, ...body } = finalizeDocumentAnswer(options);
  return { mode: "think", ...body, gaps: options.gaps || [],
    results: usedDocs.map((doc, index) => ({ ...doc, chunk_uid: `fixture:record#${index}` })),
    citations: usedDocs.map(doc => ({ n: doc.n, title: doc.title, source: doc.source })) };
};
const sourceDoc = { n: 1, title: "Rent agreement", source: "records", snippet: rentText,
  ts: "2026-11-10", date_reliable: true, text_source: "native", text_reliable: true, read_complete: true };
for (const [label, options, rung] of [
  ["screened finalizer without route extras", { docs: [], retrievedCount: 1, screenedCount: 1, searchComplete: true }, 4],
  ["named source and ingestion date", { docs: [], searchComplete: true,
    coverage: { sources: [{ name: "records", last_ingest_at: boundaryNow }] } }, 4],
  ["incomplete search", { docs: [], searchComplete: false }, 4],
  ["incomplete reading with product notice", { docs: [], searchComplete: false,
    notice: "The question could not be completed, so no records were read after the failure. The search was not widened to work around it." }, 4],
  ["rung-2 source reading", { question: moneyProbe, docs: [sourceDoc], approvedDocs: [sourceDoc],
    draft: "We pay rent of $2,000 each month to the landlord [1].", searchComplete: true,
    checks: [{ supported: false, complete: false, reason: "current payment unverified" }] }, 2],
  ["escaped quote source reading", { docs: [{ ...sourceDoc, snippet: 'The record says "rent" is $2,000 per month.' }], searchComplete: true }, 3],
  ["multiline source label", { docs: [{ ...sourceDoc, title: "Rent\nagreement" }], searchComplete: true }, 3],
]) {
  test(`R2 product control: ${label} retains the boundary note`, async () => {
    const body = boundaryEnvelope(options);
    assert.equal(body.answer_contract.rung, rung, "the real finalizer produced the specified boundary shape");
    for (const manifest of [configured, {}]) {
      const run = await runThink([body], { manifest, questions: [moneyProbe] });
      assert.deepEqual(run.calls, [moneyProbe], "the acceptance decision was reached");
      assert.equal(run.summary.passed, true, JSON.stringify(run.results.filter(row => row.status === "fail")));
      assert.ok(run.results.some(row => row.name === "document boundary reading" && row.status === "warn"));
    }
  });
}

for (const [setup, manifest] of [["configured", configured], ["built-in", {}]]) {
  for (const [finding, label, mutate] of [
    ["R1", "null without confidence", body => ({ ...body, answer: null, confidence: undefined, confidence_text: undefined })],
    ["R1", "null with model error", body => ({ ...body, answer: null, answer_error: "synthetic model failure" })],
    ["R1", "null with withheld status", body => ({ ...body, answer: null, status: "answer_withheld" })],
    ["R1", "empty answer", body => ({ ...body, answer: "" })],
    ["R1", "whitespace answer", body => ({ ...body, answer: " \n " })],
    ["R2", "refusal with contract footer", body => ({ ...body, answer: "I cannot answer this question." + boundaryFooter(body) })],
    ["R2", "unsupported money at displayed High", body => ({ ...body,
      answer: "$9,999 rent per month." + boundaryFooter(body),
      confidence_text: "Confidence: High (95%). Why: synthetic unsupported claim. Missing: source evidence." })],
    ["R2", "displayed score mismatch", body => ({ ...body,
      confidence_text: body.confidence_text.replace(/Confidence: Low \(\d+%\)/, "Confidence: High (95%)") })],
    ["R2", "unsupported money at computed Low", body => ({ ...body, answer: "$9,999 rent per month." + boundaryFooter(body) })],
    ["R2", "unsupported words at computed Low", body => ({ ...body, answer: "Rent is nine thousand dollars per month." + boundaryFooter(body) })],
    ["R2", "injected contract footer", body => ({ ...body, answer: body.answer.replace("How to check:", "$9,999 rent per month. How to check:") })],
    ["R2", "money claim in matching confidence and footer", body => {
      const confidence = { ...body.confidence, missing: ["Rent is $9,999 per month."] };
      return { ...body, confidence, confidence_text: ownerConfidenceLine(confidence),
        answer: body.answer.replace(body.confidence.missing.join(" "), confidence.missing.join(" ")) };
    }],
    ["R2", "contradictory read count", body => ({ ...body, answer_contract: { ...body.answer_contract, read_count: 1 } })],
    ["R2", "malformed High missing evidence", body => ({ ...body,
      confidence: { ...body.confidence, percent: 100, band: "High", missing: {} } })],
  ]) {
    test(`${finding} ${setup}: ${label} cannot use the boundary exception`, async t => {
      assert.equal((await runThink([factualAnswer()], { manifest })).summary.passed, true);
      const control = await runDocumentBoundary(t, { manifest, question: moneyProbe, noRecords: true });
      assertBoundaryReading(control, { rung: 4 });
      let mutations = 0;
      const bad = await runDocumentBoundary(t, { manifest, question: moneyProbe, noRecords: true,
        mutate(body) {
          mutations++;
          assert.equal(body.answer_contract.rung, 4, "the real finalizer reached the bounded-reading decision");
          assert.ok(body.answer.length > 0, "the mutation starts from a nonempty real answer");
          return mutate(body);
        } });
      assert.equal(mutations, 1, "the malformed response reached the acceptance decision");
      assert.equal(bad.summary.passed, false);
      assert.ok(bad.suite.results.some(row => row.name === "think response contract" && row.status === "fail"));
      assert.equal(bad.suite.results.some(row => row.name === "document boundary reading"), false);
    });
  }
  for (const claim of ["I cannot answer this question.", "$9,999 rent per month."]) {
    test(`R2 ${setup}: an appended source-reading claim stays blocking: ${claim}`, async t => {
      const control = await runDocumentBoundary(t, { manifest, content: rentText });
      assertBoundaryReading(control, { rung: 3 });
      let mutations = 0;
      const bad = await runDocumentBoundary(t, { manifest, content: rentText, mutate(body) {
        mutations++;
        assert.equal(body.answer_contract.rung, 3);
        assert.match(body.answer, /says:.*\$2,000/, "a populated attributed reading reached the mutation");
        return { ...body, answer: body.answer.replace("\n\nCoverage:", `\n${claim}\n\nCoverage:`) };
      } });
      assert.equal(mutations, 1);
      assert.equal(bad.summary.passed, false);
      assert.ok(bad.suite.results.some(row => row.name === "think response contract" && row.status === "fail"));
    });
  }
}

for (const [label, mutate] of [
  ["answer error", (body) => ({ ...body, answer_error: "synthetic failure" })],
  ["top-level error", (body) => ({ ...body, error: "synthetic failure" })],
  ["unavailable status", (body) => ({ ...body, status: "search_unavailable" })],
  ["evidence claim", (body) => ({ ...body, evidence_gate: { supported: true, complete: true, evidence: [] } })],
  ["retrieval failure", (body) => ({ ...body, degraded: "vector" })],
  ["missing routing marker", (body) => ({ ...body, money_handoff: undefined })],
  ["nonboolean routing marker", (body) => ({ ...body, money_handoff: "true" })],
  ["missing tools receipt", (body) => ({ ...body, money_tools_available: undefined })],
  ["empty guidance", (body) => ({ ...body, answer: "" })],
  ["unexpected candidate", (body) => ({ ...body, results: [candidate] })],
  ["unexpected citation", (body) => ({ ...body, citations: [{ n: 1 }] })],
  ["model claim", (body) => ({ ...body, model: expectedModel })],
]) {
  test(`money hand-off: ${label} stays blocking`, async () => {
    const control = await runMoneyProbes([moneyProbe, probes[0]]);
    assert.equal(control.summary.passed, true);
    const bad = await runMoneyProbes([moneyProbe, probes[0]], { mutate });
    assert.deepEqual(bad.routed, [{ status: 200, handoff: true }], "the real routing decision ran before corruption");
    assert.deepEqual(bad.calls, [moneyProbe], "a malformed hand-off cannot be hidden by another answer");
    assert.equal(bad.summary.passed, false);
  });
}

test("probe 0 withheld cleanly, probe 1 answers: configured acceptance passes", async () => {
  const { results, summary, calls } = await runThink([withheld(), factualAnswer()]);
  assert.deepEqual(calls, probes.slice(0, 2));
  assert.equal(summary.passed, true);
  assert.ok(results.some((r) => r.status === "pass" && r.name === "configured answer model returned an answer"));
  assert.ok(results.some((r) => r.status === "pass" && r.name === "configured answer model matches"));
});

test("all three clean refusals warn without blocking acceptance", async () => {
  const { results, summary, calls } = await runThink([withheld(), withheld(), withheld()]);
  assert.deepEqual(calls, probes.slice(0, 3), "the fourth saved probe is never attempted");
  assert.equal(summary.passed, true);
  assert.equal(summary.counts.fail, 0);
  assert.equal(summary.firstFailedTier, null);
  assert.ok(results.some((r) => r.status === "warn" &&
    `${r.name}; ${r.detail}` === "configured answer model ran; answers were honestly withheld by the evidence check"));
});

test("a single saved probe can prove a clean configured refusal", async () => {
  const { summary, calls } = await runThink([withheld()], { questions: probes.slice(0, 1) });
  assert.deepEqual(calls, probes.slice(0, 1));
  assert.equal(summary.passed, true);
  assert.ok(summary.counts.warn > 0);
});

test("the first configured answer keeps exact model verification", async () => {
  const peer = await runThink([factualAnswer()]);
  assert.equal(peer.summary.passed, true);
  assert.deepEqual(peer.calls, probes.slice(0, 1));
  const bad = await runThink([factualAnswer("claude-sonnet-5-5")]);
  assert.deepEqual(bad.calls, probes.slice(0, 1));
  assert.ok(bad.results.some((r) => r.status === "fail" && r.name === "configured answer model matches"));
});

const noModel = withheld();
delete noModel.model;
for (const [label, badResponse] of [
  ["model mismatch", withheld({ model: "claude-sonnet-5-5" })],
  ["missing model", noModel],
  ["verifier error", withheld({ evidence_gate: {
    supported: false, complete: false, evidence: [], error: "verification unavailable",
  } })],
  ["answer error", withheld({ answer_error: "I can help you try again, but answers are unavailable right now. Want to try again in a moment?" })],
  ["retrieval unavailable", withheld({ status: "search_unavailable" })],
  ["empty degraded retrieval", withheld({ results: [], degraded: "scoped-vector" })],
  ["failed retrieval modality", withheld({ degraded: "vector" })],
  ["missing evidence gate", withheld({ evidence_gate: undefined })],
  ["response contract failure", withheld({ citations: [{ n: 1 }] })],
  ["HTTP failure", { httpStatus: 503, payload: withheld() }],
]) {
  test(`${label} fails and cannot be hidden by a later answer`, async () => {
    const peer = await runThink([withheld(), factualAnswer()]);
    assert.equal(peer.summary.passed, true, "passing peer reaches the same configured route");
    assert.equal(peer.calls.length, 2);
    const bad = await runThink([badResponse, factualAnswer()]);
    assert.deepEqual(bad.calls, probes.slice(0, 1), "the bad response was judged before another probe");
    assert.ok(configuredFailure(bad.results), "a configured response failure must stay blocking");
    assert.equal(bad.summary.passed, false);
  });
}

test("a later answer failure keeps the earlier refusal from becoming a warning", async () => {
  const peer = await runThink([withheld(), withheld(), factualAnswer()]);
  assert.equal(peer.summary.passed, true);
  assert.deepEqual(peer.calls, probes.slice(0, 3));
  const { summary, calls, results } = await runThink([
    withheld(), withheld({ answer_error: "I can help you try again, but answers are unavailable right now. Want to try again in a moment?" }),
    factualAnswer(),
  ]);
  assert.deepEqual(calls, probes.slice(0, 2));
  assert.ok(configuredFailure(results));
  assert.equal(summary.passed, false);
});

test("answer retries retain the existing retrieval classification and waiting budget", async () => {
  const { summary, calls, waits } = await runThink([
    withheld({ degraded: "vector" }), withheld(), factualAnswer(),
  ], { retry: { attempts: 1, spacingMs: 7, probeBudgetMs: 7, tierBudgetMs: 7 } });
  assert.deepEqual(calls, [probes[0], probes[0], probes[1]]);
  assert.deepEqual(waits, [7]);
  assert.equal(summary.passed, true);
});

test("the built-in route keeps one probe and clean degradation", async () => {
  const peer = await runThink([factualAnswer()]);
  assert.ok(peer.results.some((r) => r.name.startsWith("configured answer model")));
  const { results, summary, calls } = await runThink([
    withheld({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
  ], { manifest: {} });
  assert.deepEqual(calls, probes.slice(0, 1));
  assert.equal(summary.passed, true);
  assert.ok(results.some((r) => r.status === "pass" && r.name === "think degrades cleanly"));
  assert.equal(results.some((r) => r.name.startsWith("configured answer model")), false);
});

test("verification refusal takes diagnostic precedence over coverage without exposing its reason", () => {
  const response = withheld({ evidence_gate: {
    supported: false, complete: true, evidence: [], reason: "private-reason-canary",
  } });
  const diagnostic = answerUnavailableDiagnostic(response);
  assert.equal(diagnostic.stage, "answer_verification_refused");
  assert.doesNotMatch(diagnostic.detail, /private-reason-canary/);
  assert.equal(answerUnavailableDiagnostic(withheld({ evidence_gate: undefined })).stage, "source_coverage");
  assert.equal(answerUnavailableDiagnostic(withheld({ evidence_gate: {
    supported: false, complete: false, error: "verification unavailable",
  } })).stage, "answer_verification");
});

test("the real update acceptance command returns on warnings and throws on an answer error", async t => {
  const boundary = await runDocumentBoundary(t, { question: moneyProbe });
  assertBoundaryReading(boundary, { rung: 4, screened: true });
  const lane = fileURLToPath(new URL("../lane-evidence/hotfix-0422/", import.meta.url));
  mkdirSync(lane, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(lane, "update-acceptance-")));
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(join(home, ".brain-admin-key"),
    ["fixture", "admin", "label", "for", "offline", "acceptance"].join("-"), { mode: 0o600 });
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { cmdTest, resolveAdminKey } from ${JSON.stringify(new URL("../brain.mjs", import.meta.url).href)};
    const fixtureKey = readFileSync(join(process.env.HOME, ".brain-admin-key"), "utf8");
    assert.ok(resolveAdminKey(process.env.FIXTURE_MANIFEST) === fixtureKey,
      "the fixture key is readable through the actual file-backed resolver");
    const candidate = { title: "Synthetic record", source: "fixture", chunk_uid: "fixture:record#0" };
    const boundaryReading = ${JSON.stringify(boundary.readings[0].body)};
    let thinkCalls = 0, safetyCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      const path = new URL(url).pathname;
      if (path === "/health") return Response.json({ ok: true });
      if (new Headers(init.headers).get("X-Admin-Key") !== fixtureKey) {
        return Response.json({}, { status: 401 });
      }
      if (path === "/api/admin/brain/documents") return Response.json({
        backend: "d1", rows: [{ total: 1, embedded: 1 }],
        vector_readiness: { ready: true, expected_vectors: 1, actual_vectors: 1, pending: 0, submitted: 0 },
      });
      if (path === "/api/admin/brain/freshness") return Response.json({ sources: [] });
      if (path === "/api/rag/unified") return Response.json({ results: [candidate] });
      if (path === "/api/rag/think") {
        thinkCalls++;
        if (process.env.FIXTURE_ARM === "boundary") return Response.json(boundaryReading);
        return Response.json({
          mode: "think", answer: null, model: "claude-opus-5-5", citations: [], results: [candidate],
          gaps: [{ type: "coverage_stale" }], evidence_gate: { supported: false, complete: true, evidence: [] },
          ...(process.env.FIXTURE_ARM === "error" ? {
            answer_error: "I can help you try again, but answers are unavailable right now. Want to try again in a moment?",
          } : {}),
        });
      }
      assert.equal(path, "/api/admin/brain/ingest");
      safetyCalls++;
      return Response.json({ error: "refused: content carries live credential(s)", labels: ["cloudflare_token_new"],
        detail: "Rotate them, strip them from the source, then re-ingest. Nothing was written." }, { status: 422 });
    };
    const output = [];
    const print = console.log;
    console.log = (...values) => output.push(values.join(" "));
    let threw = false;
    try {
      await cmdTest(process.env.FIXTURE_MANIFEST, { staleSourcesAsWarnings: true });
    } catch (error) {
      assert.equal(error.message, "acceptance suite FAILED");
      threw = true;
    } finally { console.log = print; }
    assert.equal(safetyCalls, 1, "acceptance completed its independent safety tier");
    const errorArm = process.env.FIXTURE_ARM === "error";
    const boundaryArm = process.env.FIXTURE_ARM === "boundary";
    assert.equal(thinkCalls, errorArm || boundaryArm ? 1 : 3, "the configured answer decision was reached");
    assert.equal(threw, errorArm);
    assert.equal(output.some((line) => line.includes("configured answer model ran")), !errorArm && !boundaryArm);
    assert.equal(output.some((line) => line.includes("document boundary reading")), boundaryArm);
    assert.equal(output.some((line) => line.includes("automated acceptance checks passed")), !errorArm);
    print(JSON.stringify({ arm: process.env.FIXTURE_ARM, thinkCalls, safetyCalls, threw }));
  `;
  try {
    for (const arm of ["refusal", "error", "boundary"]) {
      writeFileSync(manifestPath, JSON.stringify({
        ...configured, client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
        testing: { probe_questions: arm === "boundary" ? [moneyProbe] : probes },
      }));
      const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
        input: script, encoding: "utf8", timeout: 10_000,
        env: {
          HOME: home, USERPROFILE: home, BRAIN_NO_WRANGLER_LOGIN: "1",
          TMPDIR: scratch, TMP: scratch, TEMP: scratch,
          BRAIN_TEST_LAUNCHCTL: join(bin, "launchctl"),
          PATH: [bin, dirname(process.execPath)].join(process.platform === "win32" ? ";" : ":"),
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
          FIXTURE_ARM: arm, FIXTURE_MANIFEST: manifestPath,
        },
      });
      assert.equal(child.status, 0, `the ${arm} update acceptance arm must complete locally`);
      const receipt = JSON.parse(child.stdout);
      assert.equal(receipt.arm, arm);
      assert.equal(receipt.thinkCalls, arm === "refusal" ? 3 : 1);
      assert.equal(receipt.safetyCalls, 1);
      assert.equal(receipt.threw, arm === "error");
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
