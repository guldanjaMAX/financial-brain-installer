import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdDaily, planLoad } from "../brain.mjs";

const before = "2026-10-09T16:00:00.000Z";
const after = "2026-10-10T16:00:00.000Z";
const selection = () => ({
  gmail: { state: "selected" },
  calendar: { state: "selected" },
  google_drive: { state: "held", reason: "safety review pending" },
});

function harness({ sources = selection(), driveReady = true, corpora = {}, runtime = process } = {}) {
  // Match the host's path syntax; Linux exercises the Darwin scheduler offline.
  // A Darwin definition would resolve a Windows Node path as a POSIX relative path.
  const platform = runtime.platform === "win32" ? "win32" : "darwin";
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-selection-")));
  const path = join(home, "brain.manifest.json");
  writeFileSync(join(home, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  const m = {
    client: { slug: "owner-brain", timezone: "UTC" },
    brain: { domain: "brain.example.invalid" },
    corpora: { gmail: { enabled: true }, calendar: { enabled: true }, google_drive: { enabled: true }, ...corpora },
    operations: { daily_refresh: { enabled: true, timezone: "UTC", ...(sources === null ? {} : { sources }) } },
  };
  const save = () => writeFileSync(path, JSON.stringify(m));
  save();
  const calls = { plans: [], probes: [], native: [], runs: [], receipts: [], reads: 0, locks: 0, acls: 0 };
  let state = null;
  const adapter = {
    read() { calls.native.push("read"); return state; },
    install(definition) {
      calls.native.push("install");
      state = { exists: true, owned: true, enabled: true, definition };
    },
    setEnabled(_identity, enabled) { calls.native.push("enable"); state = { ...state, enabled }; },
    remove() { calls.native.push("remove"); state = null; },
  };
  const probes = Object.fromEntries(["gmail", "calendar", "google_drive", "upload"].map((key) => [key, () => {
    calls.probes.push(key);
    return { connected: key !== "google_drive" || driveReady, reason: "connection unavailable" };
  }]));
  const definitionOptions = {
    platform, home, nodePath: runtime.execPath,
    brainPath: realpathSync.native(new URL("../brain.mjs", import.meta.url)),
    runnerPath: realpathSync.native(new URL("../operations/daily-refresh-run.mjs", import.meta.url)),
    now: () => new Date(after),
  };
  const options = {
    home, platform, principal: platform === "win32" ? "sid:S-1-0-0" : "uid:501", localTimezone: "UTC",
    username: "owner", environment: { SystemRoot: String.raw`C:\Windows` },
    runAcl: () => { calls.acls++; return { status: 0 }; },
    existingSchedulerOwners: [], lifecycleLockHeld: true,
    planLoad: async (args) => {
      const entries = await planLoad({ ...args, probes });
      calls.plans.push(entries);
      return entries;
    },
    schedulerAdapter: adapter, schedulerOptions: definitionOptions, definitionOptions,
    syncSourceExpectations: false, readSourceInventory: async () => ({ sources: [] }),
    acquireLock: () => { calls.locks++; return { assertOwned() {}, release() {} }; },
    readUpdateTransaction: () => null,
    runSource: async (source) => { calls.runs.push(source.run_key); return {}; },
    readFreshness: async () => {
      calls.reads++;
      return Object.fromEntries(["gmail", "calendar", "drive", "documents"].map((key) => [key, {
        last_successful_run_at: calls.reads === 1 ? before : after,
        latest_run: { metrics_version: 1, outcome: "completed", docs_added: 0, docs_updated: 0,
          docs_unchanged: 1, docs_refused: 0, docs_failed: 0 },
      }]));
    },
    writeReceipt: (receipt) => calls.receipts.push(receipt),
    now: () => new Date(after), quiet: true, silent: true,
  };
  const command = (action, extra = [], overrides = {}) => cmdDaily([action, path, ...extra], { ...options, ...overrides });
  return { path, m, save, calls, options, command, setDriveReady: (value) => { driveReady = value; } };
}

for (const hostPlatform of ["darwin", "linux", "win32"]) {
  test(`selection fixture preserves the ${hostPlatform} Node path through registered execution`, async () => {
    const windows = hostPlatform === "win32";
    const execPath = windows ? String.raw`C:\Program Files\nodejs\node.exe` : "/fixture/runtime/node";
    const h = harness({ runtime: { platform: hostPlatform, execPath } });
    const checked = [];
    let present = true;
    Object.assign(h.options.definitionOptions, {
      brainPath: windows ? String.raw`C:\Fixture\brain.mjs` : "/fixture/runtime/brain.mjs",
      runnerPath: windows ? String.raw`C:\Fixture\daily-refresh-run.mjs` : "/fixture/runtime/daily-refresh-run.mjs",
      nodePathExists: (path) => { checked.push(path); return present && path === execPath; },
      nodeRealpath: (path) => {
        assert.equal(path, execPath, "Node resolution must preserve the injected host path");
        return realpathSync.native(process.execPath);
      },
    });
    const installed = await h.command("on");
    assert.equal(installed.schedule.verified, true);
    assert.equal(h.calls.plans.length, 1);
    assert.equal(installed.plan.sources.filter((source) => source.run_key !== null).length, 2);
    const hash = installed.schedule.definition.definition_hash;
    const result = await h.command("run", ["--definition-hash", hash]);
    assert.equal(result.status, "partial");
    assert.ok(checked.length > 0, "the real registered Node presence guard was reached");
    assert.ok(checked.every((path) => path === execPath));
    assert.equal(installed.schedule.definition.platform, windows ? "win32" : "darwin");
    assert.equal(installed.schedule.definition.identity.principal, windows ? "sid:S-1-0-0" : "uid:501");
    assert.deepEqual(h.calls.runs, ["gmail", "calendar"]);
    assert.equal(h.calls.reads, 3);
    assert.equal(h.calls.acls, windows ? 4 : 0, "Windows journal permissions use the injected ACL runner");

    present = false;
    const checksBefore = checked.length;
    await assert.rejects(h.command("run", ["--definition-hash", hash]), { code: "daily_schedule_node_missing" });
    assert.equal(h.calls.plans.length, 3, "the missing-runtime arm rebuilt the source plan");
    assert.ok(checked.length > checksBefore, "the missing-runtime arm reached the same presence guard");
    assert.equal(h.calls.locks, 1, "a missing Node cannot reach a second source-execution lease");
    assert.deepEqual(h.calls.runs, ["gmail", "calendar"], "the missing-runtime arm added no source calls");

    present = true;
    h.m.operations.daily_refresh.sources.google_drive.reason = "scope review pending";
    h.save();
    const driftChecksBefore = checked.length;
    await assert.rejects(h.command("run", ["--definition-hash", hash]), /manifest or source plan changed/);
    assert.equal(h.calls.plans.length, 4, "the drift arm rebuilt the changed source plan");
    assert.ok(checked.length > driftChecksBefore, "drift reached the registered runtime check");
    assert.equal(h.calls.locks, 1);
    assert.deepEqual(h.calls.runs, ["gmail", "calendar"], "drift added no source calls");
  });
}

for (const driveReady of [true, false]) {
  test(`selection runs two approved sources with enabled held Drive (ready=${driveReady})`, async () => {
    const h = harness({ driveReady });
    const installed = await h.command("on", ["--json"]);
    assert.equal(installed.schedule.verified, true);
    assert.equal(installed.plan.sources.filter((source) => source.run_key !== null).length, 2);
    assert.equal(h.calls.plans.length, 1, "the real shared load planner was reached");
    assert.equal(h.calls.plans[0].length, 3);
    assert.equal(h.calls.native.filter((call) => call === "install").length, 1);
    assert.deepEqual(h.calls.probes, ["gmail", "calendar", "google_drive"]);
    const held = installed.plan.sources.find((source) => source.key === "google_drive");
    assert.equal(held.enabled, true);
    assert.equal(held.selection, "held");
    assert.equal(held.hold_reason, "safety review pending");
    assert.equal(held.class, "held");
    assert.equal(held.status, "held");
    assert.equal(held.owner, "none");
    const runLines = [];
    const result = await h.command("run", ["--definition-hash", installed.schedule.definition.definition_hash],
      { silent: false, log: (line) => runLines.push(line) });
    assert.deepEqual(h.calls.runs, ["gmail", "calendar"]);
    assert.equal(h.calls.runs.filter((key) => key === "google_drive").length, 0);
    assert.equal(h.calls.locks, 1);
    assert.equal(h.calls.reads, 3, "baseline and both selected sources reached durable readback");
    assert.equal(result.status, "partial", "a held source is an explicit coverage omission");
    const receipt = result.sources.find((source) => source.status === "held");
    assert.equal(receipt.reason, held.hold_reason);
    assert.equal(receipt.freshness_advanced, false);
    assert.equal(h.calls.receipts.length, 4);
    assert.ok(runLines.includes("daily refresh partial: 2 source(s) attempted; 1 held"));
    assert.ok(runLines.some((line) => line.includes(" | held | ") && line.includes(held.hold_reason)));
    const lines = [];
    const status = await h.command("status", [], { quiet: false, log: (line) => lines.push(line) });
    const row = status.sources.find((source) => source.source === "google_drive");
    assert.equal(row.current_state, "held");
    assert.equal(row.next_run, "not scheduled");
    assert.equal(row.reason, "safety review pending");
    assert.ok(lines.some((line) => line.includes("google_drive | held") && line.includes(row.reason)));
    assert.equal(JSON.parse(readFileSync(h.path)).corpora.google_drive.enabled, true);
    await h.command("on");
    assert.equal(h.calls.native.filter((call) => call === "install").length, 1, "reconciliation is idempotent");
  });
}

test("legacy all-source control still runs all three ready sources", async () => {
  const h = harness({ sources: null });
  const installed = await h.command("on");
  const result = await h.command("run", ["--definition-hash", installed.schedule.definition.definition_hash]);
  assert.equal(h.calls.plans.length, 2);
  assert.deepEqual(h.calls.runs, ["gmail", "calendar", "google_drive"]);
  assert.equal(result.status, "complete");
});

test("approved upload folders remain eligible alongside a held source", async () => {
  const h = harness({ sources: { ...selection(), upload: { state: "selected" } },
    corpora: { upload: { enabled: true, folders: [{ path: "/fixtures/documents", source: "documents" }] } } });
  const installed = await h.command("on");
  await h.command("run", ["--definition-hash", installed.schedule.definition.definition_hash]);
  assert.deepEqual(h.calls.runs, ["gmail", "calendar", "upload"]);
  assert.equal(h.calls.reads, 4);
});

for (const driveReady of [true, false]) {
  test(`held connection readiness changes cannot block selected work (initial=${driveReady})`, async () => {
    const h = harness({ driveReady });
    const installed = await h.command("on");
    h.setDriveReady(!driveReady);
    const result = await h.command("run", ["--definition-hash", installed.schedule.definition.definition_hash]);
    assert.equal(h.calls.plans.length, 2);
    const driveStates = h.calls.plans.map((entries) => entries.find((entry) => entry.key === "google_drive").status);
    assert.deepEqual(driveStates, driveReady ? ["ready", "unavailable"] : ["unavailable", "ready"],
      "the shared planner observed a real connection-readiness transition");
    assert.equal(result.status, "partial");
    assert.deepEqual(h.calls.runs, ["gmail", "calendar"]);
    assert.equal(h.calls.native.filter((call) => call === "install").length, 1);
  });
}

const invalidSelections = [
  ["unknown key", (m) => { m.operations.daily_refresh.sources.unknown = { state: "selected" }; }],
  ["untrimmed key", (m) => { m.operations.daily_refresh.sources["gmail "] = { state: "selected" }; }],
  ["alias key", (m) => { m.operations.daily_refresh.sources.drive = { state: "held", reason: "review" }; }],
  ["missing decision", (m) => { delete m.operations.daily_refresh.sources.google_drive; }],
  ["invalid map", (m) => { m.operations.daily_refresh.sources = []; }],
  ["null map", (m) => { m.operations.daily_refresh.sources = null; }],
  ["invalid row", (m) => { m.operations.daily_refresh.sources.google_drive = null; }],
  ["array row", (m) => { m.operations.daily_refresh.sources.google_drive = []; }],
  ["unknown state", (m) => { m.operations.daily_refresh.sources.google_drive.state = "skip"; }],
  ["missing reason", (m) => { delete m.operations.daily_refresh.sources.google_drive.reason; }],
  ["blank reason", (m) => { m.operations.daily_refresh.sources.google_drive.reason = "   "; }],
  ["untrimmed reason", (m) => { m.operations.daily_refresh.sources.google_drive.reason = "review "; }],
  ["control in reason", (m) => { m.operations.daily_refresh.sources.google_drive.reason = "review\n"; }],
  ["long reason", (m) => { m.operations.daily_refresh.sources.google_drive.reason = "x".repeat(241); }],
  ["selected with reason", (m) => { m.operations.daily_refresh.sources.gmail.reason = "review"; }],
  ["unknown row property", (m) => { m.operations.daily_refresh.sources.gmail.approve = true; }],
  ["disabled selection", (m) => { m.corpora.gmail.enabled = false; }],
  ["unsupported selection", (m) => {
    m.corpora.unknown = { enabled: true };
    m.operations.daily_refresh.sources.unknown = { state: "selected" };
  }],
  ["push selection", (m) => {
    m.corpora.zoom = { enabled: true };
    m.operations.daily_refresh.sources.zoom = { state: "selected" };
  }],
];

for (const [name, mutate] of invalidSelections) {
  test(`selection refuses ${name} after real plan construction`, async () => {
    const h = harness();
    mutate(h.m); h.save();
    const status = await h.command("status", ["--json"]);
    assert.ok(status.plan.sources.length >= 3, "the refusal has a non-empty real source plan");
    assert.equal(h.calls.plans.length, 1);
    assert.equal(status.plan.ready, false);
    assert.match(status.plan.configuration_error, /daily_refresh.sources/);
    await assert.rejects(h.command("on"));
    assert.equal(h.calls.plans.length, 2, "install reached planning before refusing");
    assert.equal(h.calls.native.filter((call) => call === "install").length, 0);
    assert.equal(h.calls.runs.length, 0);
    const control = harness();
    assert.equal((await control.command("on")).schedule.verified, true);
    assert.equal(control.calls.native.filter((call) => call === "install").length, 1);
  });
}

test("an existing source scheduler cannot be relabeled as held or selected", async () => {
  const h = harness();
  const overrides = { existingSchedulerOwners: ["google_drive"] };
  const status = await h.command("status", [], overrides);
  assert.equal(h.calls.plans.length, 1);
  assert.equal(status.plan.ready, false);
  assert.match(status.plan.configuration_error, /daily_refresh.sources/);
  await assert.rejects(h.command("on", [], overrides));
  assert.equal(h.calls.native.filter((call) => call === "install").length, 0);
  assert.equal((await h.command("on")).schedule.verified, true);
});

test("a held source cannot hide a selected source failure or invent fresh quiet-day proof", async () => {
  for (const advances of [false, true]) {
    const h = harness();
    const installed = await h.command("on");
    const result = await h.command("run", ["--definition-hash", installed.schedule.definition.definition_hash], {
      readFreshness: async () => {
        h.calls.reads++;
        return Object.fromEntries(["gmail", "calendar"].map((key) => [key, {
          last_successful_run_at: advances && h.calls.reads > 1 ? after : before,
        }]));
      },
    });
    assert.equal(h.calls.runs.length, 2);
    assert.equal(h.calls.reads, 3, "both arms reached source execution and freshness decisions");
    assert.equal(result.status, advances ? "partial" : "failed");
    assert.equal(result.sources.filter((source) => source.status === "held").length, 1);
  }
});

test("selected but unavailable sources still refuse with a held source present", async () => {
  const h = harness({ driveReady: false });
  h.m.operations.daily_refresh.sources.google_drive = { state: "selected" };
  h.m.operations.daily_refresh.sources.gmail = { state: "held", reason: "review" };
  h.save();
  const status = await h.command("status");
  assert.equal(h.calls.plans.length, 1);
  assert.equal(status.plan.sources.filter((source) => source.selection === "selected").length, 2);
  assert.equal(status.plan.ready, false);
  await assert.rejects(h.command("on"));
  assert.equal(h.calls.native.filter((call) => call === "install").length, 0);
  const control = harness();
  assert.equal((await control.command("on")).schedule.verified, true);
});

test("JSON status exposes the reviewed selection through the CLI parser", async () => {
  const h = harness();
  const lines = [];
  const original = console.log;
  try {
    console.log = (line) => lines.push(line);
    await h.command("status", ["--json"], { quiet: false });
  } finally {
    console.log = original;
  }
  assert.equal(h.calls.plans.length, 1);
  const rendered = JSON.parse(lines.join("\n"));
  assert.equal(rendered.plan.sources.filter((source) => source.selection === "selected").length, 2);
  assert.equal(rendered.sources.find((source) => source.selection === "held").hold_reason, "safety review pending");
});

for (const [name, mutate, sourceHashChanges] of [
  ["selection", (m) => { m.operations.daily_refresh.sources.gmail = { state: "held", reason: "review" }; }, true],
  ["hold reason", (m) => { m.operations.daily_refresh.sources.google_drive.reason = "scope review pending"; }, true],
  ["manifest", (m) => { m.corpora.gmail.query = "newer_than:2d"; }, false],
]) {
  test(`registered selection refuses ${name} drift and requires reconciliation`, async () => {
    const h = harness();
    const first = await h.command("on");
    const oldHash = first.schedule.definition.definition_hash;
    mutate(h.m); h.save();
    const readsBefore = h.calls.native.length;
    await assert.rejects(h.command("run", ["--definition-hash", oldHash]), /manifest or source plan changed/);
    assert.equal(h.calls.plans.length, 2, "changed manifest reached real plan construction");
    assert.equal(h.calls.plans[1].length, 3);
    assert.ok(h.calls.native.length > readsBefore, "registered-definition decision was reached");
    assert.equal(h.calls.locks, 0);
    assert.equal(h.calls.runs.length, 0);
    const second = await h.command("on");
    assert.notEqual(second.schedule.definition.definition_hash, oldHash);
    assert.equal(first.plan.source_plan_hash !== second.plan.source_plan_hash, sourceHashChanges);
    const result = await h.command("run", ["--definition-hash", second.schedule.definition.definition_hash]);
    assert.equal(result.status, "partial");
    assert.equal(h.calls.runs.length, name === "selection" ? 1 : 2);
    assert.equal(h.calls.runs.includes("google_drive"), false);
  });
}
