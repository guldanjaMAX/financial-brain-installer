import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudflareApiRequest, cmdUpdate, cmdUpdatePreview, withCloudflareControlCredential, withUpdateKeyPreviewCloudflare } from "../brain.mjs";
import { checkUpdateAnswerKey, readUpdateAnswerKeySecretNames } from "../operations/update-key-preflight.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { supportRecovery } from "../support-recovery.mjs";
import { modelSwitchFixture, PAIR, previewOptions, SHA, updateAdapters } from "./fixtures/legacy-model-switch.mjs";

function fixture(t, models = { answer_model: "claude-sonnet-5" }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "key-preflight-")));
  const f = modelSwitchFixture(root);
  f.manifest.retrieval = { ...f.manifest.retrieval, ...models };
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

function secretReader(events, inventory) {
  return {
    cf: async (path, init) => {
      events.push("key:names");
      assert.equal(path, "/accounts/fixture-account/workers/scripts/fixture-brain/secrets");
      assert.equal(init?.method ?? "GET", "GET");
      if (inventory instanceof Error) throw inventory;
      return inventory;
    },
  };
}

async function preview(f, inventory, body = null) {
  const events = [], lines = [];
  const options = {
    ...previewOptions(f, line => lines.push(line)),
    answerKeyOptions: secretReader(events, inventory),
    withKeyPreflightCloudflare: async action => { events.push("key:access"); return action(); },
  };
  const request = options.request;
  options.request = async (...args) => {
    events.push("documents");
    return body ? Response.json(body) : request(...args);
  };
  let receipt, error;
  try { receipt = await cmdUpdatePreview([f.manifestPath, "--preview", "--json", "--expect-runtime-sha256", SHA], options); }
  catch (caught) { error = caught; receipt = caught.payload; }
  return { receipt, error, events, lines };
}

async function update(f, inventory, extra = {}) {
  const run = updateAdapters(f), events = [], priorFetch = globalThis.fetch, priorLog = console.log;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = ["fixture", "control"].join("-");
  globalThis.fetch = async (url, init = {}) => {
    if (new URL(url).pathname.endsWith("/secrets") && (init.method ?? "GET") === "GET") {
      run.calls.push("GET secrets");
      return Response.json({ success: true, result: inventory });
    }
    return run.fetchImpl(url, init);
  };
  console.log = (...values) => run.lines.push(values.map(String).join(" "));
  try {
    await cmdUpdate(f.manifestPath, {
      ...run.options, answerKeyOptions: secretReader(events, inventory), ...extra,
    });
  } catch (error) { run.error = error; }
  finally {
    globalThis.fetch = priorFetch; console.log = priorLog;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
  return { ...run, events };
}

test("legacy preview blocks a missing Worker key before promising the same key", async t => {
  const f = fixture(t), before = readFileSync(f.manifestPath), run = await preview(f, []);
  assert.ok(run.events.includes("documents"), "the real preview reached the readiness decision");
  console.log(`preview decision: status=${run.receipt.status}; same-key-promise=${JSON.stringify(run.receipt).includes("Same key, same data")}`);
  assert.equal(run.receipt.status, "failed");
  assert.equal(run.receipt.error_code, "UPDATE_PREVIEW_ANTHROPIC_KEY_MISSING");
  assert.match(run.receipt.blocking_prerequisite, /Anthropic key.*missing/);
  assert.match(run.receipt.next_step, /Cloudflare.*Worker.*Secret.*ANTHROPIC_API_KEY.*rerun/i);
  assert.doesNotMatch(JSON.stringify(run.receipt), /Same key, same data|connect anthropic/);
  assert.ok(run.events.includes("key:names"), "secret-name decision was reached");
  assert.deepEqual(readFileSync(f.manifestPath), before);
});

for (const [label, models] of [
  ["legacy", { answer_model: "claude-sonnet-5" }],
  ["kept", PAIR],
  ["Claude checks", { answer_model: "@cf/fixture", gate_model: PAIR.gate_model }],
]) {
  test(`${label} update stops before deploy, migration or any scheduler inspection`, async t => {
    const f = fixture(t, models), before = readFileSync(f.manifestPath), scheduler = [];
    const run = await update(f, [], {
      dailyRefreshOptions: {
        platform: "darwin", home: f.root,
        planDailyRefresh: () => { scheduler.push("inspect"); throw new Error("scheduler decision reached"); },
        schedulerOptions: { home: f.root, launchctl: () => { scheduler.push("native"); throw new Error("injected launchctl"); } },
      },
    });
    assert.ok(run.calls.includes("discover"), "the update reached the installed manifest");
    console.log(`update decision (${label}): uploads=${run.uploads.length}; scheduler=${scheduler.length}; key-list=${run.events.length}`);
    assert.match(run.error?.message ?? "", /Anthropic key.*missing/);
    assert.ok(run.events.includes("key:names"), "secret-name decision was reached");
    assert.equal(run.uploads.length, 0);
    assert.equal(run.calls.includes("migrate"), false);
    assert.equal(run.calls.includes("verify"), false);
    assert.ok(run.calls.includes("adopt"), "authentication preparation was reached before the key gate");
    assert.deepEqual(scheduler, []);
    assert.deepEqual(run.secretWrites, []);
    assert.deepEqual(readFileSync(f.manifestPath), before);
    assert.doesNotMatch(run.lines.join("\n"), /Same key, same data|imports are paused/);
  });
}

test("missing legacy key reaches deployment on the old path only", async t => {
  const f = fixture(t), run = await update(f, []);
  assert.ok(run.calls.includes("discover"), "real update discovery decision was reached");
  console.log(`deploy decision: uploads=${run.uploads.length}; migration=${run.calls.includes("migrate")}`);
  assert.equal(run.uploads.length, 0);
  assert.match(run.error?.message ?? "", /Anthropic key.*missing/);
});

for (const [label, models, secrets] of [
  ["legacy with key", { answer_model: "claude-sonnet-5" }, [{ name: "ANTHROPIC_API_KEY", type: "secret_text" }]],
  ["kept with key", PAIR, [{ name: "ANTHROPIC_API_KEY", type: "secret_text" }]],
  ["built-in without key", { answer_model: "@cf/fixture" }, []],
]) {
  test(`green control: ${label} keeps preview and real acceptance working`, async t => {
    const f = fixture(t, models), p = await preview(f, secrets);
    assert.equal(p.error, undefined, p.error?.message);
    assert.equal(p.receipt.status, "pre_update_check_complete");
    const run = await update(f, secrets);
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.uploads.length, 2, "both real deployment decisions were reached");
    assert.ok(run.calls.includes("POST /api/rag/think"), "unchanged acceptance ran");
    assert.deepEqual(run.secretWrites, []);
    assert.equal(run.events.includes("key:names"), label !== "built-in without key");
  });
}

test("update recovery describes repeating checks and stages", () => {
  const recovery = supportRecovery("UPGRADE_FAILED");
  assert.equal(recovery.code, "UPGRADE_FAILED", "the recovery decision was reached");
  const text = renderCliCommands(recovery.next_steps.join("\n"));
  assert.ok(text.includes(renderCliCommands("Run brain update once more; it repeats the checks and update stages, keeping completed migrations.")));
  assert.doesNotMatch(text, /picks up where it stopped/);
});

test("architecture describes a missing Claude key without claiming built-in answers", () => {
  const doc = readFileSync(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8");
  const section = doc.split("## Retrieval and answer flow")[1]?.split("Think first")[0];
  assert.ok(section?.includes("ANSWER_MODEL"), "the documented model decision was reached");
  assert.doesNotMatch(section, /keeps the existing built-in-model fallback/);
  assert.match(section, /without a Workers AI fallback/);
});

test("green scheduler control reaches inspection only after the key is proven", async t => {
  const f = fixture(t), scheduler = [];
  const run = await update(f, [{ name: "ANTHROPIC_API_KEY" }], {
    dailyRefreshOptions: {
      platform: "darwin", home: f.root,
      planDailyRefresh: () => { scheduler.push("inspect"); throw new Error("scheduler decision reached"); },
      schedulerOptions: { home: f.root, launchctl: () => { throw new Error("injected launchctl"); } },
    },
  });
  assert.ok(run.events.includes("key:names"));
  assert.deepEqual(scheduler, ["inspect"], "green control proves the scheduler seam is reachable");
  assert.match(run.error?.message ?? "", /scheduler decision reached/);
});

test("real Cloudflare request adapter refuses an empty secret list", async t => {
  const f = fixture(t), run = await update(f, [], { answerKeyOptions: {} });
  assert.ok(run.calls.includes("GET secrets"), "real request adapter reached the names endpoint");
  assert.match(run.error?.message ?? "", /Anthropic key.*missing/);
  assert.equal(run.uploads.length, 0);
  assert.ok(run.calls.includes("adopt"), "authentication preparation was reached before the key gate");
});

for (const inventory of [
  [{ name: "ANTHROPIC_KEY" }], [{ name: "anthropic_api_key" }],
  [{ name: " ANTHROPIC_API_KEY" }], [{ name: "ANTHROPIC_API_KEY " }],
  null, {}, [{ type: "secret_text" }], new Error("private-provider-detail"),
]) {
  test(`unproven inventory refuses safely: ${inventory instanceof Error ? "request failed" : JSON.stringify(inventory)}`, async t => {
    const f = fixture(t), p = await preview(f, inventory), run = await update(f, inventory);
    assert.ok(p.events.includes("key:names"), "preview reached its names decision");
    assert.ok(run.events.includes("key:names"), "update reached its names decision");
    assert.equal(p.receipt.status, "failed");
    assert.ok(run.error);
    assert.equal(run.uploads.length, 0);
    assert.ok(run.calls.includes("adopt"), "authentication preparation was reached before the key gate");
    assert.doesNotMatch(JSON.stringify(p.receipt) + run.error.message, /private-provider-detail|Same key, same data/);
  });
}

test("typed missing-key state blocks preview without requesting Cloudflare access", async t => {
  const f = fixture(t), options = previewOptions(f, () => {});
  const body = await (await options.request()).json();
  body.anthropic_key_missing = true;
  const run = await preview(f, [{ name: "ANTHROPIC_API_KEY" }], body);
  assert.deepEqual(run.events, ["documents"], "typed state decision used the one authenticated response");
  assert.equal(run.receipt.error_code, "UPDATE_PREVIEW_ANTHROPIC_KEY_MISSING");
  assert.equal(run.receipt.effects.credential_reads, 1);
  assert.equal(run.receipt.effects.network_requests, 1);
  assert.equal(run.receipt.effects.cloudflare_control_requests, 0);
});

test("preview counts the additional names lookup and emits only checked switch copy", async t => {
  const f = fixture(t), run = await preview(f, [{ name: "ANTHROPIC_API_KEY" }]);
  assert.deepEqual(run.events, ["documents", "key:access", "key:names"]);
  assert.equal(run.receipt.effects.credential_reads, 2);
  assert.equal(run.receipt.effects.network_requests, 2);
  assert.equal(run.receipt.effects.cloudflare_control_requests, 1);
  assert.deepEqual(run.receipt.answer_key_preflight, { status: "present", source: "worker_secret_names" });
  assert.match(run.receipt.planned_changes[0], /Same key, same data/);
  for (const key of ["manifest_writes", "brain_writes", "deployments", "browser_launches", "package_installs"]) {
    assert.equal(run.receipt.effects[key], 0);
  }
});

test("failed saved access refuses before local adoption or any write", async t => {
  const f = fixture(t), access = [];
  const run = await update(f, [{ name: "ANTHROPIC_API_KEY" }], {
    withCloudflareControl: async () => { access.push("attempt"); const error = new Error("synthetic authorization remedy"); error.code = "AUTH_EXPIRED"; throw error; },
  });
  assert.deepEqual(access, ["attempt"], "the saved-access decision was reached");
  assert.equal(run.error?.code, "AUTH_EXPIRED", "typed authorization remedy survives");
  assert.doesNotMatch(run.error.message, /private-access-detail/);
  assert.ok(run.calls.includes("adopt"), "authentication preparation was reached before the key gate");
  assert.equal(run.uploads.length, 0);
});

test("a manifest replacement during the names read cannot inherit its proof", async t => {
  const f = fixture(t), events = [];
  const run = await update(f, [{ name: "ANTHROPIC_API_KEY" }], {
    answerKeyOptions: {
      cf: async () => {
        events.push("replace");
        writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, brain: { ...f.manifest.brain, worker_name: "other-brain" } }));
        return [{ name: "ANTHROPIC_API_KEY" }];
      },
    },
  });
  assert.deepEqual(events, ["replace"], "the asynchronous replacement decision was reached");
  assert.ok(run.error);
  assert.equal(run.uploads.length, 0);
  assert.ok(run.calls.includes("adopt"), "authentication preparation was reached before the key gate");
});

test("a different Worker after profile adoption cannot inherit the earlier key proof", async t => {
  const f = fixture(t), events = [];
  const run = await update(f, [{ name: "ANTHROPIC_API_KEY" }], {
    adoptCloudflareAuthProfile: async () => {
      events.push("adopt");
      writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, brain: { ...f.manifest.brain, worker_name: "other-brain" } }));
    },
  });
  assert.equal(run.events.includes("key:names"), false, "changed target cannot reach the original key inventory");
  assert.deepEqual(events, ["adopt"], "the injected adoption decision was reached");
  assert.match(run.error?.message ?? "", /manifest.*changed/i);
  assert.equal(run.uploads.length, 0);
});

test("the inventory reader touches names only and escapes each exact target segment", async () => {
  const calls = [];
  const entry = { name: "ANTHROPIC_API_KEY", get value() { throw new Error("secret values are forbidden"); } };
  const manifest = { brain: { worker_name: "fixture/brain" }, infrastructure: { cloudflare: { account_id: "fixture/account" } } };
  const names = await readUpdateAnswerKeySecretNames(manifest, {
    cf: async path => { calls.push(path); return [entry]; },
  });
  assert.deepEqual(calls, ["/accounts/fixture%2Faccount/workers/scripts/fixture%2Fbrain/secrets"]);
  assert.deepEqual(names, ["ANTHROPIC_API_KEY"]);
});

test("saved named-profile preview uses its acquired snapshot and wipes its copy", async () => {
  const calls = [], buffer = Buffer.from(["fixture", "profile", "value"].join("-"));
  const priorFetch = globalThis.fetch;
  const profile = `financial-brain-${"2".repeat(24)}`, accountId = "1".repeat(32);
  globalThis.fetch = async (_url, init) => {
    calls.push("request");
    assert.ok(init.headers.Authorization.endsWith(buffer.toString()), "request uses the exact profile snapshot");
    return Response.json({ success: true, result: [] });
  };
  try {
    await withCloudflareControlCredential(() => withUpdateKeyPreviewCloudflare(() => cloudflareApiRequest("/fixture/secrets"), {
      manifest: { infrastructure: { cloudflare: { account_id: accountId, auth_profile: profile } } },
    }), {
      accountId, authProfile: profile, interactive: false,
      withOAuthSession: async request => {
        calls.push("profile");
        return request.action({ profile, account: { id: accountId }, token: buffer });
      },
    });
  } finally { globalThis.fetch = priorFetch; }
  assert.deepEqual(calls, ["profile", "request"]);
  assert.ok(buffer.every(byte => byte === 0));
});

test("built-in models ignore a stale typed missing-key flag and need no secret lookup", async () => {
  const events = [];
  const result = await checkUpdateAnswerKey({}, {
    workerState: { anthropic_key_missing: true },
    readSecretNames: () => { events.push("unexpected"); throw new Error("no lookup"); },
  });
  assert.equal(result.status, "not_required", "built-in model decision was reached");
  assert.deepEqual(events, []);
});

test("approved token access uses an in-memory snapshot even with a saved named profile", async () => {
  const calls = [], priorToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = ["synthetic", "approved", "control"].join("-");
  let result;
  try {
    result = await withUpdateKeyPreviewCloudflare(async () => { calls.push("read"); return "checked"; }, {
      manifest: { infrastructure: { cloudflare: { account_id: "1".repeat(32), auth_profile: `financial-brain-${"2".repeat(24)}` } } },
      forceToken: true,
    });
  } finally {
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
  assert.equal(result, "checked");
  assert.deepEqual(calls, ["read"]);
});
