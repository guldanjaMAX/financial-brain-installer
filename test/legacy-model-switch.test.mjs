import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as setup from "../operations/answer-setup.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { cmdDeploy, cmdUpdate, cmdUpdatePreview, workerBindings } from "../brain.mjs";
import { modelSwitchFixture, PAIR, previewOptions, REFUSAL, SHA, SWITCH_LINE, updateAdapters } from "./fixtures/legacy-model-switch.mjs";

const RETRY_LINE = "Your Brain may already be answering with the new models. Run brain update again to finish.";

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "legacy-model-switch-")));
  const f = modelSwitchFixture(root);
  t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

async function update(f, overrides = {}) {
  const run = updateAdapters(f, overrides);
  const priorFetch = globalThis.fetch, priorLog = console.log;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = ["fixture", "control"].join("-");
  globalThis.fetch = run.fetchImpl;
  console.log = (...values) => run.lines.push(values.map(String).join(" "));
  try {
    await cmdUpdate(f.manifestPath, {
      ...run.options, ...overrides.options,
      upgradeOptions: { ...run.options.upgradeOptions, ...overrides.options?.upgradeOptions },
    });
    run.error = null;
  } catch (error) { run.error = error; }
  finally {
    globalThis.fetch = priorFetch; console.log = priorLog;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
  return run;
}

test("exact legacy map and pure helper require both resolved models to be known", () => {
  assert.deepEqual(setup.LEGACY_CLAUDE_MODEL_SWITCH, { "claude-sonnet-5": PAIR });
  const manifest = { retrieval: { answer_model: "claude-sonnet-5" } };
  const before = JSON.stringify(manifest);
  assert.deepEqual(setup.legacyModelSwitchFor(manifest), {
    from: { answer_model: "claude-sonnet-5", gate_model: "claude-sonnet-5" }, to: PAIR,
    changes: {
      answer_model: { from: "claude-sonnet-5", to: PAIR.answer_model },
      gate_model: { from: "claude-sonnet-5", to: PAIR.gate_model },
    },
  });
  assert.equal(JSON.stringify(manifest), before);
  for (const reviewed of ["claude-opus-5-5", "claude-sonnet-5-5", "@cf/fixture"]) {
    const gateOnly = setup.legacyModelSwitchFor({ retrieval: { answer_model: reviewed, gate_model: "claude-sonnet-5" } });
    assert.deepEqual(gateOnly, {
      from: { answer_model: reviewed, gate_model: "claude-sonnet-5" },
      to: { gate_model: PAIR.gate_model },
      changes: { gate_model: { from: "claude-sonnet-5", to: PAIR.gate_model } },
    });
    const answerOnly = setup.legacyModelSwitchFor({ retrieval: { answer_model: "claude-sonnet-5", gate_model: reviewed } });
    assert.deepEqual(answerOnly, {
      from: { answer_model: "claude-sonnet-5", gate_model: reviewed },
      to: { answer_model: PAIR.answer_model },
      changes: { answer_model: { from: "claude-sonnet-5", to: PAIR.answer_model } },
    });
  }
  for (const unknown of ["claude-sonnet-4-9", "claude-sonnet-5-extra", " claude-sonnet-5", "toString", "__proto__"]) {
    assert.equal(setup.legacyModelSwitchFor({ retrieval: { answer_model: "claude-sonnet-5", gate_model: unknown } }), null);
    assert.equal(setup.legacyModelSwitchFor({ retrieval: { answer_model: unknown, gate_model: "claude-sonnet-5" } }), null);
  }
  assert.equal(setup.legacyModelSwitchFor({ retrieval: PAIR }), null);
  assert.equal(setup.legacyModelSwitchFor({}), null);
});

test("only missing or null inherited legacy fields gain an explicit replacement", () => {
  for (const retrieval of [
    { answer_model: "claude-sonnet-5" },
    { answer_model: "claude-sonnet-5", gate_model: null },
    { gate_model: "claude-sonnet-5" },
    { answer_model: null, gate_model: "claude-sonnet-5" },
    { answer_model: "", gate_model: "claude-sonnet-5" },
    { answer_model: "claude-sonnet-5", gate_model: "" },
  ]) {
    const before = JSON.stringify(retrieval);
    const manifest = { retrieval };
    const resolved = setup.resolvedAnswerModels(manifest);
    const change = setup.legacyModelSwitchFor(manifest);
    assert.ok(change, "the legacy decision was reached");
    const saved = { ...retrieval, ...change.to };
    for (const field of ["answer_model", "gate_model"]) {
      const replaced = retrieval[field] === "claude-sonnet-5" ||
        ((retrieval[field] == null || retrieval[field] === "") && resolved[field] === "claude-sonnet-5");
      assert.equal(Object.hasOwn(change.to, field), replaced);
      assert.equal(Object.hasOwn(change.changes, field), replaced);
      assert.equal(Object.hasOwn(saved, field), replaced || Object.hasOwn(retrieval, field));
      assert.equal(saved[field], replaced ? PAIR[field] : retrieval[field]);
    }
    assert.deepEqual(setup.assertReviewedAnswerModels({ retrieval: saved }), setup.resolvedAnswerModels({ retrieval: saved }));
    assert.equal(JSON.stringify(retrieval), before, "the helper never mutates its input");
  }
  assert.deepEqual(setup.resolvedAnswerModels({}), {
    answer_model: setup.BUILT_IN_ANSWER_MODEL, gate_model: setup.BUILT_IN_ANSWER_MODEL,
  });
});

test("preview lists the planned switch without changing the saved manifest", async (t) => {
  const f = fixture(t), lines = [], before = readFileSync(f.manifestPath);
  const receipt = await cmdUpdatePreview([f.manifestPath, "--preview", "--json", "--expect-runtime-sha256", SHA], previewOptions(f, (line) => lines.push(line)));
  assert.equal(receipt.status, "pre_update_check_complete", "the preview decision was reached");
  assert.deepEqual(receipt.planned_changes, [SWITCH_LINE]);
  assert.ok(lines[0].includes(SWITCH_LINE));
  assert.deepEqual(readFileSync(f.manifestPath), before);
});

test("update deploys both switched bindings, preserves the secret name, passes real acceptance, then commits both IDs", async (t) => {
  const f = fixture(t), run = await update(f);
  assert.equal(run.error, null, run.error?.message);
  assert.equal(run.uploads.length, 2, "both real deployment paths reached the fake transport");
  for (const upload of run.uploads) {
    for (const [field, name] of [["answer_model", "ANSWER_MODEL"], ["gate_model", "GATE_MODEL"]]) {
      assert.equal(upload.bindings.find((binding) => binding.name === name).text, PAIR[field]);
    }
    assert.deepEqual(upload.keep_bindings, ["secret_text"]);
    assert.equal(upload.bindings.some((binding) => binding.type === "secret_text"), false, "no secret value is uploaded");
    assert.equal(upload.bindings.find((binding) => binding.name === "DAILY_LLM_CAP_USD").text, "7");
  }
  assert.ok(run.calls.some((call) => call.endsWith("/secrets")), "real provider-name reconciliation ran");
  assert.deepEqual(run.secretWrites, []);
  assert.equal(run.lines.filter((line) => line === SWITCH_LINE).length, 1, "the announcement is one plain line");
  assert.ok(run.lines.findIndex((line) => line.includes(SWITCH_LINE)) < run.lines.findIndex((line) => line.includes("Updating your Brain")));
  assert.ok(run.calls.includes("POST /api/rag/think"), "the fake answerer was exercised by real cmdTest");
  assert.ok(run.lines.some((line) => /configured answer model matches/.test(line)));
  const after = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  assert.deepEqual(after, { ...f.manifest, brain: { ...f.manifest.brain, version: f.targetVersion }, retrieval: { ...f.manifest.retrieval, ...PAIR } });
});

test("interruption after deploy leaves the manifest byte-identical and retry completes", async (t) => {
  const f = fixture(t), before = readFileSync(f.manifestPath), run = await update(f, { interrupt: true });
  assert.equal(run.uploads.length, 2, "the interrupted arm reached active deploy");
  assert.ok(run.calls.includes("POST /api/rag/think"), "acceptance reached the failure injection");
  assert.match(run.error?.message || "", /update stopped during full acceptance test: fixture interruption after deploy/);
  assert.ok(renderCliCommands(run.error.message).includes(renderCliCommands(RETRY_LINE)), "the owner sees the model-specific retry instruction");
  assert.deepEqual(readFileSync(f.manifestPath), before);
  assert.deepEqual(run.secretWrites, []);
  assert.equal((await update(f)).error, null, "green retry control");
});

for (const { name, models, expected, switched } of [
  { name: "explicit legacy pair", models: { answer_model: "claude-sonnet-5", gate_model: "claude-sonnet-5" }, expected: PAIR, switched: ["answer_model", "gate_model"] },
  { name: "null gate inherits legacy answer", models: { answer_model: "claude-sonnet-5", gate_model: null }, expected: PAIR, switched: ["answer_model", "gate_model"] },
  { name: "empty gate inherits legacy answer", models: { answer_model: "claude-sonnet-5", gate_model: "" }, expected: PAIR, switched: ["answer_model", "gate_model"] },
  { name: "no legacy with empty gate", models: { answer_model: PAIR.gate_model, gate_model: "" }, expected: { answer_model: PAIR.gate_model, gate_model: "" }, switched: [] },
  { name: "chosen Sonnet answer and legacy gate", models: { answer_model: PAIR.gate_model, gate_model: "claude-sonnet-5" }, expected: { answer_model: PAIR.gate_model, gate_model: PAIR.gate_model }, switched: ["gate_model"] },
  { name: "legacy answer and chosen built-in gate", models: { answer_model: "claude-sonnet-5", gate_model: "@cf/fixture" }, expected: { answer_model: PAIR.answer_model, gate_model: "@cf/fixture" }, switched: ["answer_model"] },
  { name: "absent answer stays absent", models: { gate_model: "claude-sonnet-5" }, expected: { gate_model: PAIR.gate_model }, switched: ["gate_model"] },
  { name: "null answer stays null", models: { answer_model: null, gate_model: "claude-sonnet-5" }, expected: { answer_model: null, gate_model: PAIR.gate_model }, switched: ["gate_model"] },
  { name: "no legacy with explicit models", models: { answer_model: PAIR.gate_model, gate_model: "@cf/fixture" }, expected: { answer_model: PAIR.gate_model, gate_model: "@cf/fixture" }, switched: [] },
  { name: "no legacy with absent gate", models: { answer_model: PAIR.gate_model }, expected: { answer_model: PAIR.gate_model }, switched: [] },
  { name: "no legacy with null gate", models: { answer_model: PAIR.gate_model, gate_model: null }, expected: { answer_model: PAIR.gate_model, gate_model: null }, switched: [] },
]) {
  test(`real update preserves each saved field: ${name}`, async (t) => {
    const f = fixture(t);
    f.manifest.retrieval = { chunk_size: 900, rerank: false, ...models };
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    const beforeFields = JSON.stringify(f.manifest.retrieval);
    const run = await update(f);
    assert.equal(run.error, null, run.error?.message);
    assert.equal(run.uploads.length, 2, "both deployment decisions were reached");
    assert.ok(run.calls.includes("POST /api/rag/think"), "real acceptance ran");
    const saved = JSON.parse(readFileSync(f.manifestPath, "utf8"));
    assert.deepEqual(saved, { ...f.manifest, brain: { ...f.manifest.brain, version: f.targetVersion }, retrieval: { chunk_size: 900, rerank: false, ...expected } });
    const resolved = setup.assertReviewedAnswerModels(saved);
    for (const upload of run.uploads) {
      for (const [field, binding] of [["answer_model", "ANSWER_MODEL"], ["gate_model", "GATE_MODEL"]]) {
        assert.equal(upload.bindings.find(({ name }) => name === binding).text, resolved[field]);
      }
    }
    assert.deepEqual(run.secretWrites, []);
    assert.equal(setup.legacyModelSwitchFor(saved), null);
    const announcements = run.lines.filter(line => line.startsWith("Your Brain uses an older Claude model name"));
    assert.equal(announcements.length, switched.length ? 1 : 0);
    if (switched.length === 2) assert.equal(announcements[0], SWITCH_LINE);
    else if (switched.length === 1) {
      const field = switched[0], role = field === "answer_model" ? "answers" : "checks";
      assert.equal(announcements[0], `Your Brain uses an older Claude model name (claude-sonnet-5). This update switches ${role} to ${expected[field]}. Same key, same data.`);
      const lines = [];
      writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
      const beforePreview = readFileSync(f.manifestPath);
      const preview = await cmdUpdatePreview([f.manifestPath, "--preview", "--json", "--expect-runtime-sha256", SHA], previewOptions(f, line => lines.push(line)));
      assert.equal(preview.status, "pre_update_check_complete", "mixed-model preview reached its decision");
      assert.deepEqual(preview.planned_changes, announcements);
      assert.equal(lines.length, 1);
      assert.deepEqual(readFileSync(f.manifestPath), beforePreview);
    } else assert.equal(JSON.stringify(saved.retrieval), beforeFields, "saved model fields retain exact bytes and presence");
  });
}

test("model retry notice is absent before deployment and on an interrupted reviewed-model update", async (t) => {
  let verificationCalls = 0;
  const beforeDeploy = fixture(t), stopped = await update(beforeDeploy, { options: {
    cmdVerify: async () => { verificationCalls++; throw new Error("fixture verification stop"); },
  } });
  assert.equal(verificationCalls, 1, "the pre-deployment failure decision was reached");
  assert.match(stopped.error?.message || "", /fixture verification stop/);
  assert.deepEqual(stopped.uploads, []);
  assert.equal(stopped.error.message.includes(renderCliCommands(RETRY_LINE)), false);
  const reviewed = fixture(t);
  reviewed.manifest.retrieval = { ...reviewed.manifest.retrieval, ...PAIR };
  writeFileSync(reviewed.manifestPath, JSON.stringify(reviewed.manifest));
  const run = await update(reviewed, { interrupt: true });
  assert.equal(run.uploads.length, 2, "the reviewed-model control reached active deployment");
  assert.ok(run.calls.includes("POST /api/rag/think"));
  assert.match(run.error?.message || "", /fixture interruption after deploy/);
  assert.equal(renderCliCommands(run.error.message).includes(renderCliCommands(RETRY_LINE)), false);
});

test("failed local model commit explains the remote switch and a retry finishes", async (t) => {
  const f = fixture(t), before = readFileSync(f.manifestPath);
  let commitCalls = 0;
  const run = await update(f, { options: { upgradeOptions: {
    commitManifestVersion: () => { commitCalls++; throw new Error("fixture local commit stop"); },
  } } });
  assert.equal(commitCalls, 1, "the local commit failure decision was reached");
  assert.equal(run.uploads.length, 2);
  assert.ok(run.calls.includes("POST /api/rag/think"));
  assert.match(run.error?.message || "", /fixture local commit stop/);
  assert.equal(renderCliCommands(run.error.message).split(renderCliCommands(RETRY_LINE)).length, 2, "the retry sentence appears once");
  assert.deepEqual(readFileSync(f.manifestPath), before);
  assert.equal((await update(f)).error, null, "green retry completes the deferred local commit");
});

test("a failure after the verified local model commit needs no model retry notice", async (t) => {
  const f = fixture(t);
  let historyCalls = 0;
  const run = await update(f, { options: { upgradeOptions: {
    d1Query: async (_account, _database, sql, params = []) => {
      if (sql.includes("INSERT INTO upgrade_runs") && params[4] === "verified") {
        historyCalls++;
        throw new Error("fixture history stop");
      }
      return { results: f.db.prepare(sql).all(...params) };
    },
  } } });
  assert.equal(historyCalls, 1, "the post-commit history failure decision was reached");
  assert.equal(run.uploads.length, 2);
  assert.ok(run.calls.includes("POST /api/rag/think"));
  assert.match(run.error?.message || "", /the verified update could not be recorded in upgrade history/);
  assert.equal(run.error.message.includes(renderCliCommands(RETRY_LINE)), false);
  const saved = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  assert.deepEqual(saved.retrieval, { ...f.manifest.retrieval, ...PAIR });
  assert.equal(saved.brain.version, f.targetVersion);
  assert.equal((await update(f)).error, null, "green retry can record the verified history");
});

test("other unknown IDs reach the model refusal before any credential or deployment work", async (t) => {
  const f = fixture(t);
  f.manifest.retrieval.answer_model = "claude-sonnet-4-9";
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  const before = readFileSync(f.manifestPath), run = await update(f);
  assert.equal(run.calls[0], "discover", "the real update loaded this manifest");
  assert.equal(run.error?.supportCode, "ANSWER_MODEL_NOT_REVIEWED");
  assert.equal(run.error?.message, REFUSAL, "the model decision was reached");
  assert.deepEqual(run.calls, ["discover"]);
  assert.deepEqual(readFileSync(f.manifestPath), before);
  assert.deepEqual(run.secretWrites, []);
  f.manifest.retrieval = { ...f.manifest.retrieval, ...PAIR };
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  assert.equal((await update(f)).error, null, "reviewed-model green control");
});

test("already reviewed update and preview have no switch announcement", async (t) => {
  const f = fixture(t);
  f.manifest.retrieval = { ...f.manifest.retrieval, ...PAIR };
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  const preview = await cmdUpdatePreview([f.manifestPath, "--preview", "--json", "--expect-runtime-sha256", SHA], previewOptions(f, () => {}));
  assert.equal(Object.hasOwn(preview, "planned_changes"), false);
  const run = await update(f);
  assert.equal(run.error, null, run.error?.message);
  assert.equal(run.uploads.length, 2, "reviewed control reaches deployment");
  assert.equal(run.lines.some((line) => line.includes(SWITCH_LINE)), false);
  assert.deepEqual(run.secretWrites, []);
});

test("ordinary deploy and binding guards still refuse legacy IDs", async (t) => {
  const f = fixture(t);
  assert.throws(() => workerBindings(f.manifest, f.manifest.infrastructure.cloudflare), (error) => error.supportCode === "ANSWER_MODEL_NOT_REVIEWED");
  await assert.rejects(cmdDeploy(f.manifestPath), (error) => error.supportCode === "ANSWER_MODEL_NOT_REVIEWED");
  assert.equal((await update(f)).error, null, "only the update path enables the switch");
});

test("only plain string model IDs qualify for the switch", () => {
  const green = setup.legacyModelSwitchFor({ retrieval: { answer_model: "claude-sonnet-5" } });
  assert.ok(green, "the real legacy string still switches");
  for (const retrieval of [
    { answer_model: ["claude-sonnet-5"] },
    { answer_model: "claude-sonnet-5", gate_model: ["claude-sonnet-5-5"] },
    { answer_model: { id: "claude-sonnet-5" } },
  ]) {
    assert.equal(setup.legacyModelSwitchFor({ retrieval }), null, `non-string value never switches: ${JSON.stringify(retrieval)}`);
  }
});
