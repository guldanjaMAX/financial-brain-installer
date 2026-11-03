import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { Acceptance, answerUnavailableDiagnostic } = await import(
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

test("the real update acceptance command returns on warnings and throws on an answer error", () => {
  const lane = fileURLToPath(new URL("../lane-evidence/hotfix-0422/", import.meta.url));
  mkdirSync(lane, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(lane, "update-acceptance-")));
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    ...configured, client: { slug: "fixture" },
    brain: { domain: "fixture.invalid" }, testing: { probe_questions: probes },
  }));
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
    assert.equal(thinkCalls, errorArm ? 1 : 3, "the configured answer decision was reached");
    assert.equal(threw, errorArm);
    assert.equal(output.some((line) => line.includes("configured answer model ran")), !errorArm);
    assert.equal(output.some((line) => line.includes("automated acceptance checks passed")), !errorArm);
    print(JSON.stringify({ arm: process.env.FIXTURE_ARM, thinkCalls, safetyCalls, threw }));
  `;
  try {
    for (const arm of ["refusal", "error"]) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
        input: script, encoding: "utf8", timeout: 10_000,
        env: {
          HOME: home, USERPROFILE: home, BRAIN_NO_WRANGLER_LOGIN: "1",
          PATH: [bin, dirname(process.execPath)].join(process.platform === "win32" ? ";" : ":"),
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
          FIXTURE_ARM: arm, FIXTURE_MANIFEST: manifestPath,
        },
      });
      assert.equal(child.status, 0, `the ${arm} update acceptance arm must complete locally`);
      const receipt = JSON.parse(child.stdout);
      assert.equal(receipt.arm, arm);
      assert.equal(receipt.thinkCalls, arm === "error" ? 1 : 3);
      assert.equal(receipt.safetyCalls, 1);
      assert.equal(receipt.threw, arm === "error");
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
