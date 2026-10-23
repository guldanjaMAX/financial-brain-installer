import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cmdConnectAnthropic,
  cmdDisconnectAnthropic,
  reconcileDailyDefinitionAfterManifestEdit,
} from "../brain.mjs";

import {
  BUILT_IN_ANSWER_MODEL,
  RECOMMENDED_ANSWER_SETUP,
  RECOMMENDED_CLAUDE_DAILY_CAP_USD,
  REVIEWED_CLAUDE_ANSWER_MODELS,
  answerSetupOf,
  assertReviewedAnswerModels,
  classifyAnthropicResponse,
  displayResetTime,
  nextUtcResetIso,
  parseAnthropicConnectFlags,
  preflightAnthropicKey,
  runAnthropicAnswerSetup,
  validAnthropicKeyShape,
} from "../operations/answer-setup.mjs";
import {
  BILLING,
  BUSY,
  CHECK_FAILED,
  CHECK_PENDING,
  DASHBOARD_STEPS,
  HALF_RUN,
  KEY_REJECTED,
  KEY_SHAPE,
  KEY_KEPT_FOR_RERANK,
  LIMIT_ALREADY_REACHED,
  MODEL_UNAVAILABLE,
  ROLLBACK_INCOMPLETE,
  UNREACHABLE,
} from "../operations/answer-setup-copy.mjs";

const fixtureKey = () => ["sk", "ant", "api03", "fixture-value"].join("-");
const manifest = (extra = {}) => ({
  client: { slug: "fixture", display_name: "Owner", timezone: "America/Phoenix" },
  brain: { worker_name: "fixture-brain", domain: "fixture.invalid" },
  infrastructure: { cloudflare: { storage: "d1", d1_database_id: "fixture-db" } },
  retrieval: { answer_model: BUILT_IN_ANSWER_MODEL, gate_model: BUILT_IN_ANSWER_MODEL },
  safety: { daily_llm_spend_cap_usd: 10 },
  ...extra,
});

test("answer setup classification resolves defaults before selecting a label", () => {
  const template = JSON.parse(readFileSync(new URL("../templates/brain.manifest.json", import.meta.url), "utf8"));
  assert.equal(answerSetupOf(template), "built-in");
  assert.equal(answerSetupOf({}), "built-in");
  assert.equal(answerSetupOf({ retrieval: { ...RECOMMENDED_ANSWER_SETUP } }), "opus-sonnet");
  assert.equal(answerSetupOf({ retrieval: { answer_model: REVIEWED_CLAUDE_ANSWER_MODELS[0] } }), "custom");
});

test("unreviewed answer and gate ids fail with the stable support code", () => {
  for (const [field, id] of [
    ["answer_model", "claude-opus-5.5"],
    ["gate_model", "claude-sonnet-4-5"],
  ]) {
    assert.throws(
      () => assertReviewedAnswerModels({ retrieval: { [field]: id } }, { manifestPath: "/fixture/brain.manifest.json" }),
      (error) => error?.supportCode === "ANSWER_MODEL_NOT_REVIEWED" && error?.field === field,
    );
  }
});

test("key shape rejects unsafe and non-owner API key classes", () => {
  assert.equal(validAnthropicKeyShape(fixtureKey()), true);
  for (const value of [
    "",
    `${fixtureKey()}\nsecond`,
    `${fixtureKey()} space`,
    ["sk", "ant", "admin01", "fixture"].join("-"),
    ["sk", "ant", "oat01", "fixture"].join("-"),
    "wrong-prefix",
  ]) assert.equal(validAnthropicKeyShape(value), false, value ? KEY_SHAPE : "empty");
});

test("Anthropic preflight response classes are closed and billing recognizes credit text", () => {
  const rows = [
    [{ status: 200 }, "ok"],
    [{ status: 401 }, "key_rejected", KEY_REJECTED],
    [{ status: 403 }, "key_rejected", KEY_REJECTED],
    [{ status: 402 }, "billing", BILLING],
    [{ status: 400, body: { error: { message: "Credit balance is too low" } } }, "billing", BILLING],
    [{ status: 400, body: { error: { message: "invalid request" } } }, "error", CHECK_FAILED],
    [{ status: 404 }, "model_unavailable", MODEL_UNAVAILABLE],
    [{ status: 429 }, "busy", BUSY],
    [{ status: 529 }, "busy", BUSY],
    [{ status: 500 }, "busy", BUSY],
    [{ networkError: true }, "unreachable", UNREACHABLE],
  ];
  for (const [input, expected] of rows) assert.equal(classifyAnthropicResponse(input), expected);
});

test("preflight uses the measured fixed-host request shape and bounded transient retries", async () => {
  const requests = [];
  const result = await preflightAnthropicKey(fixtureKey(), {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { status: 200, text: async () => "{}" };
    },
    sleep: async () => { throw new Error("a successful preflight must not sleep"); },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(requests.map((entry) => entry.url), [
    "https://api.anthropic.com/v1/models",
    "https://api.anthropic.com/v1/messages",
    "https://api.anthropic.com/v1/messages",
  ]);
  for (const entry of requests.slice(1)) {
    const body = JSON.parse(entry.init.body);
    assert.equal(body.max_tokens, 128);
    assert.deepEqual(body.output_config, { effort: "low" });
    assert.deepEqual(body.messages, [{ role: "user", content: "Reply with OK." }]);
  }

  const sleeps = [];
  let attempts = 0;
  const busy = await preflightAnthropicKey(fixtureKey(), {
    fetchImpl: async () => { attempts++; return { status: 529, text: async () => "" }; },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(busy.status, "busy");
  assert.equal(attempts, 3, "the transient decision point was reached three times");
  assert.deepEqual(sleeps, [5_000, 10_000]);
});

test("every preflight refusal clears the clipboard and stops before setup writes", async () => {
  for (const status of ["key_rejected", "billing", "error", "model_unavailable", "busy", "unreachable"]) {
    const calls = [];
    await assert.rejects(
      runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, {
        loadManifest: () => manifest(),
        acquireLock: async (_input, action) => action(),
        journalExists: () => false,
        verifyVersion: async () => calls.push("version"),
        readClipboard: async () => fixtureKey(),
        clearClipboard: async () => calls.push("clear"),
        preflight: async () => { calls.push(`preflight:${status}`); return { status }; },
        listSecretNames: async () => { calls.push("secret-list"); return []; },
        writeJournal: () => calls.push("journal"),
        saveManifestAtomically: () => calls.push("manifest"),
      }),
      (error) => error.message === ({
        key_rejected: KEY_REJECTED,
        billing: BILLING,
        error: CHECK_FAILED,
        model_unavailable: MODEL_UNAVAILABLE,
        busy: BUSY,
        unreachable: UNREACHABLE,
      })[status],
    );
    assert.deepEqual(calls, ["version", `preflight:${status}`, "clear"], `${status} reached its refusal without a write`);
  }
});

test("an invalid clipboard value is refused before provider inventory or preflight", async () => {
  const calls = [];
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, {
      loadManifest: () => manifest(),
      acquireLock: async (_input, action) => action(),
      journalExists: () => false,
      verifyVersion: async () => calls.push("version"),
      readClipboard: async () => "not-a-key",
      clearClipboard: async () => calls.push("clear"),
      preflight: async () => calls.push("preflight"),
      listSecretNames: async () => { calls.push("secret-list"); return []; },
    }),
    (error) => error.message === KEY_SHAPE,
  );
  assert.deepEqual(calls, ["version", "clear"]);
});

test("connect flags enforce exclusive key modes and cap bounds before work", () => {
  assert.equal(parseAnthropicConnectFlags({})?.dailyCap, undefined);
  assert.equal(parseAnthropicConnectFlags({ "daily-cap": "5" }).dailyCap, 5);
  assert.throws(() => parseAnthropicConnectFlags({ "daily-cap": "0.1" }));
  assert.throws(() => parseAnthropicConnectFlags({ "from-clipboard": true, "keep-key": true }));
  assert.equal(RECOMMENDED_CLAUDE_DAILY_CAP_USD, 5);
});

test("next reset is the next UTC midnight", () => {
  const reset = nextUtcResetIso(new Date("2026-10-22T12:34:56.000Z"));
  assert.equal(reset, "2026-10-23T00:00:00.000Z");
  assert.match(displayResetTime(reset, "America/Phoenix"), /America\/Phoenix/);
});

test("connect writes the manifest before the secret and preserves the selected cap rule", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-answer-setup-")));
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
  const calls = [];
  let saved = null;
  const result = await runAnthropicAnswerSetup({ manifestPath, flags: { "from-clipboard": true } }, {
    loadManifest: () => manifest(),
    saveManifestAtomically: (_path, value) => { calls.push("manifest"); saved = value; },
    journalExists: () => false,
    writeJournal: () => calls.push("journal"),
    removeJournal: () => calls.push("journal-remove"),
    acquireLock: async (_input, action) => { calls.push("lock"); try { return await action(); } finally { calls.push("unlock"); } },
    verifyVersion: async () => calls.push("version"),
    readClipboard: async () => fixtureKey(),
    clearClipboard: async () => calls.push("clear"),
    preflight: async () => { calls.push("preflight"); return { status: "ok" }; },
    listSecretNames: async () => (calls.includes("put-secret") ? ["ANTHROPIC_API_KEY"] : []),
    putSecret: async () => calls.push("put-secret"),
    reconcileDaily: async () => calls.push("daily"),
    deploy: async () => calls.push("deploy"),
    checkWorker: async () => {
      calls.push("answer-check");
      return {
        answer: { model: RECOMMENDED_ANSWER_SETUP.answer_model, status: "ok" },
        check: { model: RECOMMENDED_ANSWER_SETUP.gate_model, status: "ok" },
      };
    },
    now: () => new Date("2026-10-22T12:00:00.000Z"),
    sleep: async () => {},
    log: () => {},
  });
  assert.ok(calls.indexOf("manifest") < calls.indexOf("put-secret"));
  assert.deepEqual(calls, [
    "lock", "version", "preflight", "journal", "manifest", "daily", "put-secret",
    "deploy", "answer-check", "clear", "journal-remove", "unlock",
  ]);
  assert.equal(saved.safety.daily_llm_spend_cap_usd, RECOMMENDED_CLAUDE_DAILY_CAP_USD);
  assert.deepEqual(saved.retrieval, RECOMMENDED_ANSWER_SETUP);
  assert.equal(result.rolled_back, false);
});

test("daily definition reconciliation reinstalls only the recomputed non-source definition", async () => {
  const beforePlan = { source_plan_hash: "source-hash", ready: true, identity: { id: "fixture" } };
  const afterPlan = { ...beforePlan, definition_hash: "new-definition" };
  let installs = 0;
  const receipt = await reconcileDailyDefinitionAfterManifestEdit("/fixture/brain.manifest.json", {
    previousManifest: manifest(),
    beforePlan,
    afterPlan,
    beforeStatus: { installed: true, enabled: true },
    installDailyRefreshSchedule: (plan) => {
      installs++;
      assert.equal(plan, afterPlan, "the recomputed plan reached the scheduler decision point");
      return { verified: true, changed: true };
    },
  });
  assert.equal(installs, 1);
  assert.deepEqual(receipt, { installed: true, enabled: true, changed: true, verified: true });

  await assert.rejects(
    reconcileDailyDefinitionAfterManifestEdit("/fixture/brain.manifest.json", {
      previousManifest: manifest(),
      beforePlan,
      afterPlan: { ...afterPlan, source_plan_hash: "changed-source" },
      beforeStatus: { installed: true, enabled: true },
      installDailyRefreshSchedule: () => { throw new Error("must stop before scheduler write"); },
    }),
    /DAILY_RECONCILE_FAILED.*source plan changed/,
  );
});

function setupHarness(before, { secretPresent = false, failDeploy = false, workerStatus = "ok", rerank = false } = {}) {
  const calls = [];
  const saved = [];
  const lines = [];
  let secret = secretPresent;
  let journalPresent = false;
  let deploys = 0;
  const starting = structuredClone(before);
  if (rerank) starting.retrieval.rerank = true;
  return {
    calls,
    saved,
    lines,
    secret: () => secret,
    journal: () => journalPresent,
    deps: {
      loadManifest: () => structuredClone(starting),
      saveManifestAtomically: (_path, value) => { calls.push("manifest"); saved.push(structuredClone(value)); },
      journalExists: () => false,
      writeJournal: () => { calls.push("journal"); journalPresent = true; },
      removeJournal: () => { calls.push("journal-remove"); journalPresent = false; },
      acquireLock: async (_input, action) => {
        calls.push("lock");
        try { return await action(); } finally { calls.push("unlock"); }
      },
      verifyVersion: async () => calls.push("version"),
      readClipboard: async () => fixtureKey(),
      clearClipboard: async () => calls.push("clear"),
      preflight: async () => ({ status: "ok" }),
      listSecretNames: async () => secret ? ["ANTHROPIC_API_KEY"] : [],
      putSecret: async () => { calls.push("put-secret"); secret = true; },
      deleteSecret: async () => { calls.push("delete-secret"); secret = false; },
      reconcileDaily: async (_path, options) => calls.push(options.rollback ? "daily-rollback" : "daily"),
      deploy: async () => {
        deploys++;
        calls.push(deploys === 1 ? "deploy" : "deploy-rollback");
        if (failDeploy && deploys === 1) throw new Error("synthetic deploy failure");
      },
      checkWorker: async () => {
        calls.push("answer-check");
        return {
          answer: { model: RECOMMENDED_ANSWER_SETUP.answer_model, status: workerStatus },
          check: { model: RECOMMENDED_ANSWER_SETUP.gate_model, status: workerStatus },
        };
      },
      now: () => new Date("2026-10-22T12:00:00.000Z"),
      sleep: async () => {},
      log: (line) => lines.push(line),
    },
  };
}

test("a key-class Worker failure restores built-in and deletes the newly added secret", async () => {
  const harness = setupHarness(manifest(), { workerStatus: "key_rejected" });
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, harness.deps),
    (error) => error.supportCode === "ANTHROPIC_KEY_NOT_ACCEPTED" && error.rolledBack === true,
  );
  assert.equal(answerSetupOf(harness.saved.at(-1)), "built-in");
  assert.equal(harness.secret(), false);
  assert.equal(harness.journal(), false);
  assert.ok(harness.calls.includes("answer-check"), "the negative outcome reached the Worker decision point");
  assert.ok(harness.calls.includes("delete-secret"));
  assert.ok(harness.calls.indexOf("clear") < harness.calls.indexOf("journal-remove"));
  assert.ok(harness.calls.indexOf("journal-remove") < harness.calls.indexOf("unlock"));
});

test("a replacement key rejected by the Worker does not restore the prior Claude pair", async () => {
  const before = manifest({ retrieval: { ...RECOMMENDED_ANSWER_SETUP } });
  const harness = setupHarness(before, { secretPresent: true, workerStatus: "key_rejected" });
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, harness.deps),
    (error) => error.supportCode === "ANTHROPIC_KEY_NOT_ACCEPTED" && error.rolledBack === true,
  );
  assert.equal(answerSetupOf(harness.saved.at(-1)), "built-in");
  assert.equal(harness.secret(), false);
  assert.ok(harness.calls.includes("answer-check"), "the replacement reached the Worker check");
  assert.ok(harness.calls.includes("delete-secret"));
});

test("a paused Claude manifest with no old secret falls back to built-in after deploy failure", async () => {
  const before = manifest({ retrieval: { ...RECOMMENDED_ANSWER_SETUP } });
  const harness = setupHarness(before, { failDeploy: true });
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, harness.deps),
    /synthetic deploy failure/,
  );
  assert.equal(answerSetupOf(harness.saved.at(-1)), "built-in");
  assert.equal(Object.hasOwn(harness.saved.at(-1).retrieval, "answer_model"), false);
  assert.equal(harness.secret(), false);
  assert.ok(harness.calls.includes("deploy-rollback"), "the rollback redeploy decision point was reached");
});

test("a preflight-proven replacement can restore the prior Claude pair when an old secret existed", async () => {
  const before = manifest({ retrieval: { ...RECOMMENDED_ANSWER_SETUP } });
  const harness = setupHarness(before, { secretPresent: true, failDeploy: true });
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, harness.deps),
    /synthetic deploy failure/,
  );
  assert.equal(answerSetupOf(harness.saved.at(-1)), "opus-sonnet");
  assert.equal(harness.secret(), true);
  assert.equal(harness.calls.includes("delete-secret"), false);
});

test("reranking keeps the secret on rollback and an incomplete rollback keeps the journal", async () => {
  const rerank = setupHarness(manifest(), { rerank: true, workerStatus: "key_rejected" });
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, rerank.deps),
    /did not accept this key/,
  );
  assert.equal(rerank.secret(), true);
  assert.equal(rerank.calls.includes("delete-secret"), false);
  assert.ok(rerank.lines.includes(KEY_KEPT_FOR_RERANK));

  const incomplete = setupHarness(manifest(), { failDeploy: true });
  incomplete.deps.deploy = async () => { incomplete.calls.push("deploy-failed"); throw new Error("synthetic deploy failure"); };
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, incomplete.deps),
    (error) => error.supportCode === "ANTHROPIC_ROLLBACK_INCOMPLETE" && error.message.includes(ROLLBACK_INCOMPLETE("/fixture/brain.manifest.json")),
  );
  assert.equal(incomplete.journal(), true);
  assert.ok(incomplete.calls.filter((call) => call === "deploy-failed").length >= 2, "rollback redeploy was attempted");
});

test("transient and daily-limit Worker checks keep the proven setup", async () => {
  const transient = setupHarness(manifest(), { workerStatus: "busy" });
  const pending = await runAnthropicAnswerSetup({
    manifestPath: "/fixture/brain.manifest.json",
    flags: { "from-clipboard": true },
  }, transient.deps);
  assert.equal(pending.rolled_back, false);
  assert.ok(transient.lines.includes(CHECK_PENDING("/fixture/brain.manifest.json")));
  assert.equal(transient.calls.includes("deploy-rollback"), false);

  const limited = setupHarness(manifest(), { workerStatus: "daily_limit" });
  const limitReceipt = await runAnthropicAnswerSetup({
    manifestPath: "/fixture/brain.manifest.json",
    flags: { "from-clipboard": true },
  }, limited.deps);
  assert.equal(limitReceipt.rolled_back, false);
  assert.ok(limited.lines.some((line) => line.startsWith(LIMIT_ALREADY_REACHED("/fixture/brain.manifest.json", "").split("so answers start again at ")[0])));
  assert.equal(limited.calls.includes("deploy-rollback"), false);
});

test("a stale isolate may catch up inside the retry window", async () => {
  const harness = setupHarness(manifest());
  let checks = 0;
  harness.deps.checkWorker = async () => {
    checks++;
    return checks === 1
      ? { answer: { model: "stale", status: "ok" }, check: { model: "stale", status: "ok" } }
      : {
          answer: { model: RECOMMENDED_ANSWER_SETUP.answer_model, status: "ok" },
          check: { model: RECOMMENDED_ANSWER_SETUP.gate_model, status: "ok" },
        };
  };
  const receipt = await runAnthropicAnswerSetup({
    manifestPath: "/fixture/brain.manifest.json",
    flags: { "from-clipboard": true },
  }, harness.deps);
  assert.equal(receipt.rolled_back, false);
  assert.equal(checks, 2, "the stale echo decision point was reached before the green control");
});

test("dashboard, half-run, version, and Darwin input modes stop at their intended boundary", async () => {
  const dashboardCalls = [];
  const dashboardLines = [];
  const dashboard = await runAnthropicAnswerSetup({
    manifestPath: "/fixture/brain.manifest.json",
    flags: { "key-set-in-dashboard": true },
  }, {
    loadManifest: () => manifest(),
    acquireLock: async (_input, action) => action(),
    journalExists: () => false,
    verifyVersion: async () => dashboardCalls.push("version"),
    listSecretNames: async () => { dashboardCalls.push("secret-list"); return []; },
    preflight: async () => dashboardCalls.push("preflight"),
    putSecret: async () => dashboardCalls.push("put"),
    log: (line) => dashboardLines.push(line),
  });
  assert.equal(dashboard.status, "nothing_changed");
  assert.deepEqual(dashboardCalls, ["version", "secret-list"]);
  assert.deepEqual(dashboardLines, [DASHBOARD_STEPS]);

  const halfCalls = [];
  await assert.rejects(runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json" }, {
    acquireLock: async (_input, action) => action(),
    journalExists: () => true,
    clearClipboard: async () => halfCalls.push("clear"),
    verifyVersion: async () => halfCalls.push("version"),
  }), (error) => error.message === HALF_RUN("/fixture/brain.manifest.json"));
  assert.deepEqual(halfCalls, ["clear"]);

  const modes = [];
  for (const stdinIsTTY of [false, true]) {
    const harness = setupHarness(manifest());
    harness.deps.platform = "darwin";
    harness.deps.stdinIsTTY = stdinIsTTY;
    harness.deps.readClipboard = async () => { modes.push("clipboard"); return fixtureKey(); };
    harness.deps.readSecret = async () => { modes.push("prompt"); return fixtureKey(); };
    await runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json" }, harness.deps);
  }
  assert.deepEqual(modes, ["clipboard", "prompt"]);
});

test("the eight-minute bound rolls a manifest edit back", async () => {
  const harness = setupHarness(manifest());
  let instant = Date.parse("2026-10-22T12:00:00.000Z");
  harness.deps.now = () => new Date(instant);
  harness.deps.reconcileDaily = async (_path, options) => {
    harness.calls.push(options.rollback ? "daily-rollback" : "daily");
    if (!options.rollback) instant += 8 * 60 * 1000 + 1;
  };
  await assert.rejects(
    runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "from-clipboard": true } }, harness.deps),
    /eight-minute safety limit/,
  );
  assert.equal(answerSetupOf(harness.saved.at(-1)), "built-in");
  assert.ok(harness.calls.includes("daily-rollback"), "the elapsed-time refusal reached rollback reconciliation");
});

test("a secret-write failure cannot echo a key-shaped sentinel", async () => {
  const sentinel = fixtureKey();
  const harness = setupHarness(manifest());
  let journal = null;
  harness.deps.writeJournal = (value) => { journal = structuredClone(value); };
  harness.deps.putSecret = async (_name, value) => { throw new Error(`write failed: ${value}`); };
  const error = await runAnthropicAnswerSetup({
    manifestPath: "/fixture/brain.manifest.json",
    flags: { "from-clipboard": true },
  }, harness.deps).then(() => null, (caught) => caught);
  assert.ok(error);
  for (const output of [error.message, JSON.stringify(journal), JSON.stringify(harness.saved), harness.lines.join("\n")]) {
    assert.equal(output.includes(sentinel), false);
  }
});

test("keep-key without a cap only checks, while a cap edit writes, reconciles, and deploys", async () => {
  const before = manifest({ retrieval: { ...RECOMMENDED_ANSWER_SETUP } });
  const checkOnly = setupHarness(before, { secretPresent: true });
  await runAnthropicAnswerSetup({ manifestPath: "/fixture/brain.manifest.json", flags: { "keep-key": true } }, checkOnly.deps);
  assert.ok(checkOnly.calls.includes("answer-check"));
  assert.equal(checkOnly.calls.includes("manifest"), false);
  assert.equal(checkOnly.calls.includes("deploy"), false);

  const capEdit = setupHarness(before, { secretPresent: true });
  const receipt = await runAnthropicAnswerSetup({
    manifestPath: "/fixture/brain.manifest.json",
    flags: { "keep-key": true, "daily-cap": "8" },
  }, capEdit.deps);
  assert.equal(receipt.daily_cap_usd, 8);
  for (const call of ["manifest", "daily", "deploy", "answer-check"]) assert.ok(capEdit.calls.includes(call));
  assert.equal(capEdit.calls.includes("put-secret"), false);
});

test("disconnect clears both models, preserves the cap, reconciles, removes the secret, and is idempotent", async () => {
  let current = manifest({
    retrieval: { ...RECOMMENDED_ANSWER_SETUP },
    safety: { daily_llm_spend_cap_usd: 7 },
  });
  let secret = true;
  let journal = true;
  const calls = [];
  const lines = [];
  const options = {
    loadManifest: () => ({ m: structuredClone(current) }),
    saveManifestAtomically: async (_path, value) => { calls.push("manifest"); current = structuredClone(value); },
    acquireLock: async (_input, action) => { calls.push("lock"); try { return await action(); } finally { calls.push("unlock"); } },
    reconcileDaily: async () => calls.push("daily"),
    deploy: async () => calls.push("deploy"),
    resolveAccount: async () => ({ id: "fixture-account" }),
    listSecretNames: async () => secret ? ["ANTHROPIC_API_KEY"] : [],
    deleteSecret: async () => { calls.push("delete-secret"); secret = false; },
    journalExists: () => journal,
    removeJournal: async () => { calls.push("journal-remove"); journal = false; },
    log: (line) => lines.push(line),
  };
  const first = await cmdDisconnectAnthropic("/fixture/brain.manifest.json", {}, options);
  assert.equal(first.secret_deleted, true);
  assert.equal(Object.hasOwn(current.retrieval, "answer_model"), false);
  assert.equal(Object.hasOwn(current.retrieval, "gate_model"), false);
  assert.equal(current.safety.daily_llm_spend_cap_usd, 7);
  assert.equal(secret, false);
  assert.equal(journal, false);
  for (const call of ["manifest", "daily", "deploy", "delete-secret", "journal-remove"]) {
    assert.ok(calls.includes(call), `${call} decision point was reached`);
  }
  assert.ok(lines.some((line) => /built-in Cloudflare model/.test(line)));
  assert.ok(lines.some((line) => /removed from your Brain/.test(line)));

  calls.length = 0;
  lines.length = 0;
  const second = await cmdDisconnectAnthropic("/fixture/brain.manifest.json", {}, options);
  assert.equal(second.secret_deleted, false);
  assert.equal(calls.includes("delete-secret"), false);
  assert.ok(calls.includes("deploy"), "the idempotent control still verifies the deployed built-in setup");
});

test("disconnect keeps a reranking key and never reaches secret deletion", async () => {
  let current = manifest({ retrieval: { ...RECOMMENDED_ANSWER_SETUP, rerank: true } });
  const calls = [];
  const lines = [];
  const receipt = await cmdDisconnectAnthropic("/fixture/brain.manifest.json", {}, {
    loadManifest: () => ({ m: structuredClone(current) }),
    saveManifestAtomically: async (_path, value) => { current = structuredClone(value); },
    acquireLock: async (_input, action) => action(),
    reconcileDaily: async () => calls.push("daily"),
    deploy: async () => calls.push("deploy"),
    listSecretNames: async () => { calls.push("secret-list"); return ["ANTHROPIC_API_KEY"]; },
    deleteSecret: async () => calls.push("delete-secret"),
    journalExists: () => false,
    log: (line) => lines.push(line),
  });
  assert.equal(receipt.key_kept_for_rerank, true);
  assert.equal(calls.includes("secret-list"), false);
  assert.equal(calls.includes("delete-secret"), false);
  assert.ok(lines.includes(KEY_KEPT_FOR_RERANK));
});

test("JSON failures always carry explicit rollback fields", async () => {
  const refusal = await cmdConnectAnthropic("/fixture/brain.manifest.json", {
    "from-clipboard": true,
    json: true,
  }, {
    loadManifest: () => ({ m: manifest() }),
    acquireLock: async (_input, action) => action(),
    journalExists: () => false,
    verifyVersion: async () => {},
    readClipboard: async () => fixtureKey(),
    clearClipboard: async () => {},
    preflight: async () => ({ status: "key_rejected" }),
  }).then(() => null, (error) => error);
  assert.equal(refusal?.constructor?.name, "JsonFatal");
  assert.equal(refusal.payload.rolled_back, false);
  assert.equal(refusal.payload.rollback_target, null);

  let secret = false;
  const saved = [];
  const rollback = await cmdConnectAnthropic("/fixture/brain.manifest.json", {
    "from-clipboard": true,
    json: true,
  }, {
    loadManifest: () => ({ m: manifest() }),
    saveManifestAtomically: async (_path, value) => saved.push(structuredClone(value)),
    acquireLock: async (_input, action) => action(),
    journalExists: () => false,
    writeJournal: async () => {},
    removeJournal: async () => {},
    verifyVersion: async () => {},
    readClipboard: async () => fixtureKey(),
    clearClipboard: async () => {},
    preflight: async () => ({ status: "ok" }),
    listSecretNames: async () => secret ? ["ANTHROPIC_API_KEY"] : [],
    putSecret: async () => { secret = true; },
    deleteSecret: async () => { secret = false; },
    reconcileDaily: async () => {},
    deploy: async () => {},
    checkWorker: async () => ({
      answer: { model: RECOMMENDED_ANSWER_SETUP.answer_model, status: "key_rejected" },
      check: { model: RECOMMENDED_ANSWER_SETUP.gate_model, status: "key_rejected" },
    }),
    now: () => new Date("2026-10-22T12:00:00.000Z"),
  }).then(() => null, (error) => error);
  assert.ok(saved.length >= 2, "the completed rollback decision point was reached");
  assert.equal(rollback?.constructor?.name, "JsonFatal");
  assert.equal(rollback.payload.rolled_back, true);
  assert.equal(rollback.payload.rollback_target, "built-in");
});

