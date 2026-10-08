import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as scheduler from "../operations/daily-refresh-scheduler.mjs";
import { planDailyRefresh } from "../operations/daily-refresh-plan.mjs";

const fixture = {
  client: { slug: "owner", timezone: "America/Phoenix" },
  brain: { domain: "brain.example.invalid" },
  corpora: { google_drive: { enabled: true }, gmail: { enabled: true } },
};
const options = {
  platform: "win32", nodePath: String.raw`C:\Runtime\node.exe`,
  brainPath: String.raw`C:\Runtime\brain.mjs`,
  runnerPath: String.raw`C:\Runtime\operations\daily-refresh-run.mjs`,
  nodeRealpath: (path) => path,
};
async function dailyDefinition(m) {
  let decisions = 0;
  const plan = await planDailyRefresh({
    m, manifestPath: "/fixtures/brain.manifest.json", platform: "win32",
    principal: "sid:S-1-5-21-100", localTimezone: "America/Phoenix",
    planLoadFn: async () => {
      decisions++;
      return Object.keys(m.corpora).map((key) => ({ key, status: "ready" }));
    },
  });
  assert.equal(decisions, 1, "the real planning decision point was reached");
  // Keep this cross-platform golden independent of path.resolve on the host.
  const path = "/fixtures/brain.manifest.json";
  return scheduler.buildDailyRefreshDefinition({ ...plan, manifest_path: path,
    manifest_path_hash: `sha256:${createHash("sha256").update(path).digest("hex")}`,
  }, options);
}

test("the no-QuickBooks daily definition retains the golden captured at the pinned commit", async () => {
  const definition = await dailyDefinition(fixture);
  assert.equal(definition.definition_hash, "sha256:49eba2ee9abe5ac491226d1fdfd274f7cc8c67356fb6eed52a1da6174abf86ba");
  assert.equal(definition.native_definition_hash, "sha256:a8b37b65878f83b57edfa1ea8893e2a1055e82c664c5c3a358761704bdd93b0e");
});

test("one-shot task carries a bounded visible interactive invocation", () => {
  assert.equal(typeof scheduler.buildOneShotTask, "function", "the packet needs a new one-shot builder");
  const task = scheduler.buildOneShotTask({
    name: "Connect fixture", args: [String.raw`C:\Runtime\probe.mjs`, "/fixtures/brain.manifest.json"],
    startNow: true, expiresMinutes: 15,
  }, { now: new Date("2026-07-01T14:00:00.000Z"), nodePath: options.nodePath, principal: "sid:S-1-5-21-100" });
  assert.equal(task.name, String.raw`\Financial Brain\Connect fixture`);
  assert.match(task.serialized, /<TimeTrigger>/u);
  assert.match(task.serialized, /<StartBoundary>2026-07-01T14:00:00.000Z<\/StartBoundary>/u);
  assert.match(task.serialized, /<EndBoundary>2026-07-01T14:15:00.000Z<\/EndBoundary>/u);
  assert.match(task.serialized, /<DeleteExpiredTaskAfter>PT0S<\/DeleteExpiredTaskAfter>/u);
  assert.match(task.serialized, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(task.serialized, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(task.serialized, /<Hidden>false<\/Hidden>/u);
  assert.match(task.serialized, /<WakeToRun>false<\/WakeToRun>/u);
  assert.doesNotMatch(task.arguments.join(" "), /token|key|secret/iu);
});

test("one-shot rejects unsafe invocation data at argument validation with a green control", () => {
  let decisions = 0;
  const build = (args) => scheduler.buildOneShotTask({
    name: "Connect fixture", get args() { decisions++; return args; }, startNow: true, expiresMinutes: 15,
  }, { now: new Date("2026-07-01T14:00:00.000Z"), nodePath: options.nodePath });
  const runner = String.raw`C:\Runtime\probe.mjs`;
  const refused = [
    [runner, "--admin-key-file", String.raw`C:\Private\.brain-admin-key`],
    [runner, "--access-token=synthetic"],
    [runner, "--api-key-file", String.raw`C:\Private\material.json`],
    [runner, "https://example.invalid/connect?code=synthetic"],
    [runner, "keychain://fixture/item"],
    [runner, "line\nfeed"], ["--eval", "process.exit(0)"], [],
  ];
  for (const args of refused) {
    const before = decisions;
    assert.throws(() => build(args), { code: "ONE_SHOT_TASK_INVALID" });
    assert.equal(decisions, before + 1, "the builder read the rejected argument list");
  }
  const task = build([runner, String.raw`C:\Fixtures\brain.manifest.json`]);
  assert.equal(decisions, refused.length + 1, "the same decision point admits safe arguments");
  assert.equal(task.arguments.length, 2);
});

test("one-shot expiry and identity reject malformed values without defaulting them", () => {
  let decisions = 0;
  const base = { name: "Connect fixture", args: [String.raw`C:\Runtime\probe.mjs`], startNow: true, expiresMinutes: 15 };
  const run = (input, extra = {}) => scheduler.buildOneShotTask({
    ...input, get name() { decisions++; return input.name; },
  }, { now: new Date("2026-07-01T14:00:00.000Z"), nodePath: options.nodePath, ...extra });
  for (const changes of [
    { name: "..\\Foreign" }, { name: "Connect fixture " }, { startNow: false },
    { expiresMinutes: 0 }, { expiresMinutes: 16 }, { expiresMinutes: 1.5 },
  ]) {
    const before = decisions;
    assert.throws(() => run({ ...base, ...changes }), { code: "ONE_SHOT_TASK_INVALID" });
    assert.equal(decisions, before + 1);
  }
  for (const extra of [{ now: "invalid" }, { principal: "uid:501" }, { nodePath: "node.exe" }]) {
    const before = decisions;
    assert.throws(() => run(base, extra), { code: "ONE_SHOT_TASK_INVALID" });
    assert.equal(decisions, before + 1);
  }
  assert.match(run(base).serialized, /<EndBoundary>/u, "a bounded valid task is the green control");
});

test("one-shot preserves argv quoting and escapes XML without a shell", () => {
  const runner = String.raw`C:\Program Files\Runtime\probe.mjs`;
  const trailing = "C:\\Fixtures\\trailing\\";
  const args = [runner, trailing, 'a"b', "<&>", ""];
  const task = scheduler.buildOneShotTask({ name: "Connect fixture", args }, {
    now: new Date("2026-07-01T14:00:00.000Z"), nodePath: options.nodePath,
  });
  assert.equal(scheduler.quoteWindowsTaskArgument(trailing), '"C:\\Fixtures\\trailing\\\\"');
  assert.equal(scheduler.quoteWindowsTaskArgument('a"b'), '"a\\"b"');
  assert.match(task.serialized, /&lt;&amp;&gt;/u);
  assert.equal(task.command, options.nodePath);
  assert.deepEqual(task.arguments, args);
  assert.ok(Object.isFrozen(task.arguments));
});
