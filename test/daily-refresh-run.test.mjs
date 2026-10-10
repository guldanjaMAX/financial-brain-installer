import assert from "node:assert/strict";
import { mkdtempSync as makeTempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDailyRefreshDefinition } from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefresh, runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";

const mkdtempSync = prefix => realpathSync.native(makeTempSync(prefix));

const plan = Object.freeze({
  ready: true,
  enabled: true,
  identity: { id: "v1-run" },
  manifest_path: "/fixtures/brain.manifest.json",
  manifest_content_hash: "sha256:content",
  source_plan_hash: "sha256:sources",
  max_runtime_minutes: 45,
  sources: [
    { key: "drive", class: "machine-pull", owner: "daily-task", status: "ready", run_key: "google_drive" },
    { key: "folder", class: "machine-pull", owner: "existing-local-scheduler", status: "ready", run_key: "local_folder" },
    { key: "server", class: "server-managed", owner: "worker-cron", status: "skipped", run_key: null },
  ],
});

test("daily refresh runs ready owned legs sequentially and requires freshness to advance", async () => {
  const events = [];
  const receipts = [];
  let freshnessReads = 0;
  const result = await runDailyRefresh({
    plan,
    acquireLock: () => ({ assertOwned: () => true, release: () => events.push("release") }),
    runSource: async (source) => { events.push(`run:${source.key}`); return { status: "complete" }; },
    readFreshness: async () => {
      freshnessReads += 1;
      return { drive: { last_successful_run_at: freshnessReads === 1 ? "2026-10-06T15:00:00.000Z" : "2026-10-06T15:01:00.000Z" } };
    },
    writeReceipt: (receipt) => receipts.push(receipt),
    now: (() => {
      let n = 0;
      return () => new Date(1_700_000_000_000 + n++ * 1000);
    })(),
  });
  assert.deepEqual(events, ["run:drive", "release"], "only the daily-owned leg ran and the lock enclosed it");
  assert.equal(result.status, "complete");
  assert.equal(result.sources[0].freshness_advanced, true);
  assert.ok(receipts.some((receipt) => receipt.source === "drive"), "per-source receipt was written");
});

test("busy lifecycle lock records a non-vacuous deferred outcome", async () => {
  const receipts = [];
  let acquireCalls = 0;
  const busy = Object.assign(new Error("busy"), { code: "brain_lifecycle_busy" });
  const result = await runDailyRefresh({
    plan,
    acquireLock: () => { acquireCalls += 1; throw busy; },
    runSource: async () => assert.fail("a deferred run must not reach a source"),
    readFreshness: async () => ({}),
    writeReceipt: (receipt) => receipts.push(receipt),
  });
  assert.equal(acquireCalls, 1, "lock decision point was reached");
  assert.equal(result.status, "deferred");
  assert.equal(receipts.at(-1).status, "deferred");
});

test("claimed source success without advanced freshness fails honestly", async () => {
  const receipts = [];
  let runCalls = 0;
  const result = await runDailyRefresh({
    plan,
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => { runCalls += 1; return { status: "complete" }; },
    readFreshness: async () => ({ drive: { last_successful_run_at: "2026-10-06T15:00:00.000Z" } }),
    writeReceipt: (receipt) => receipts.push(receipt),
  });
  assert.equal(runCalls, 1, "source decision point was reached");
  assert.equal(result.status, "failed");
  assert.equal(result.sources[0].freshness_advanced, false);
  assert.match(result.sources[0].reason, /did not advance/i);
});

test("every claimed source leg must have a valid advancing freshness receipt", async () => {
  const multiLegPlan = {
    ...plan,
    sources: [{
      key: "mail-and-files",
      class: "machine-pull",
      owner: "daily-task",
      status: "ready",
      run_key: "provider",
      source_names: ["mail", "files"],
    }],
  };
  let reads = 0;
  let runs = 0;
  const missingLeg = await runDailyRefresh({
    plan: multiLegPlan,
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => { runs += 1; return { status: "complete" }; },
    readFreshness: async () => ++reads === 1
      ? { mail: { last_successful_run_at: "2026-10-06T10:00:00.000Z" } }
      : { mail: { last_successful_run_at: "2026-10-06T11:00:00.000Z" } },
    writeReceipt: () => {},
  });
  assert.equal(runs, 1, "the multi-leg source execution decision was reached");
  assert.equal(missingLeg.status, "failed");
  assert.deepEqual(missingLeg.sources[0].missing_freshness_sources, ["files"]);

  reads = 0;
  const invalidFirstReceipt = await runDailyRefresh({
    plan: { ...multiLegPlan, sources: [{ ...multiLegPlan.sources[0], source_names: ["mail"] }] },
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => ({ status: "complete" }),
    readFreshness: async () => ++reads === 1
      ? {}
      : { mail: { last_successful_run_at: "not-a-timestamp" } },
    writeReceipt: () => {},
  });
  assert.equal(invalidFirstReceipt.status, "failed");

  reads = 0;
  const control = await runDailyRefresh({
    plan: multiLegPlan,
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => ({ status: "complete" }),
    readFreshness: async () => ++reads === 1
      ? {
          mail: { last_successful_run_at: "2026-10-06T10:00:00.000Z" },
          files: { last_successful_run_at: "2026-10-06T10:00:00.000Z" },
        }
      : {
          mail: { last_successful_run_at: "2026-10-06T11:00:00.000Z" },
          files: { last_successful_run_at: "2026-10-06T11:00:00.000Z" },
        },
    writeReceipt: () => {},
  });
  assert.equal(control.status, "complete", "all advancing legs remain a green control");
});

test("unavailable daily-owned work is retained as a failed source outcome", async () => {
  let runCalls = 0;
  const result = await runDailyRefresh({
    plan: {
      ...plan,
      sources: [{
        key: "configured-source", class: "machine-pull", owner: "daily-task",
        status: "unavailable", run_key: "configured-source", source_names: ["configured-source"],
      }],
    },
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => { runCalls += 1; },
    readFreshness: async () => ({}),
    writeReceipt: () => {},
  });
  assert.equal(runCalls, 0, "unavailable work was classified before execution");
  assert.equal(result.status, "failed");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].status, "unavailable");
});

test("source exceptions cross receipt boundaries only as allowlisted codes", async () => {
  const privateSentinel = ["SYNTHETIC", "PRIVATE", "VALUE"].join("_");
  const receipts = [];
  let runCalls = 0;
  const result = await runDailyRefresh({
    plan,
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => { runCalls += 1; throw new Error(`fixture ${privateSentinel}`); },
    readFreshness: async () => ({}),
    writeReceipt: (receipt) => receipts.push(receipt),
  });
  assert.equal(runCalls, 1, "the exception boundary was reached");
  assert.equal(result.status, "failed");
  assert.equal(result.sources[0].reason_code, "source_execution_failed");
  assert.doesNotMatch(JSON.stringify(receipts), new RegExp(privateSentinel));
});

test("a restarted scheduled runner honors an update recovery-required receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-run-recovery-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  let runs = 0;
  let transactionReads = 0;
  const receipts = [];
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => ({ ...plan, manifest_path: manifestPath }),
    readUpdateTransaction: () => {
      transactionReads += 1;
      return { phase: "recovery_required" };
    },
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => { runs += 1; return { status: "complete" }; },
    readFreshness: async () => ({ drive: { last_successful_run_at: "2026-10-06T12:00:00.000Z" } }),
    writeReceipt: (receipt) => receipts.push(receipt),
    silent: true,
  });
  assert.equal(transactionReads, 1, "the durable recovery boundary was read after restart");
  assert.equal(runs, 0);
  assert.equal(result.status, "deferred");
  assert.equal(result.reason_code, "update_recovery_required");
  assert.equal(receipts.at(-1).status, "deferred");
});

test("a recovery fence created while the runner acquires its lease still defers all sources", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-run-recovery-race-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  let recovering = false;
  let runs = 0;
  let transactionReads = 0;
  let releases = 0;
  const receipts = [];
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => ({ ...plan, manifest_path: manifestPath }),
    readUpdateTransaction: () => {
      transactionReads += 1;
      return recovering ? { phase: "recovery_required" } : null;
    },
    acquireLock: () => {
      recovering = true;
      return { assertOwned: () => true, release: () => { releases += 1; } };
    },
    runSource: async () => { runs += 1; return { status: "complete" }; },
    readFreshness: async () => ({ drive: { last_successful_run_at: "2026-10-06T12:00:00.000Z" } }),
    writeReceipt: (receipt) => receipts.push(receipt),
    silent: true,
  });
  assert.equal(transactionReads, 1, "the recovery boundary was inspected after lease acquisition");
  assert.equal(runs, 0);
  assert.equal(releases, 1);
  assert.equal(result.status, "deferred");
  assert.equal(result.reason_code, "update_recovery_required");
  assert.equal(receipts.at(-1).status, "deferred");
});

test("the runner accepts only Node-path drift and reports that the daily schedule needs refresh", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-run-node-drift-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const currentPlan = {
    ...plan,
    manifest_path: manifestPath,
    manifest_path_hash: "sha256:path",
    cron: "0 9 * * *",
    timezone: "UTC",
    sources: [{
      key: "drive", class: "machine-pull", owner: "daily-task", status: "ready",
      run_key: "google_drive", source_names: ["drive"],
    }],
  };
  const definitionOptions = {
    platform: "darwin",
    nodePath: "/new/runtime/node",
    brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/daily-refresh-run.mjs",
  };
  const registered = buildDailyRefreshDefinition(currentPlan, {
    ...definitionOptions,
    nodePath: "/old/runtime/node",
  });
  let reads = 0;
  const schedulerAdapter = {
    read: () => {
      reads += 1;
      return { exists: true, owned: true, enabled: true, definition: registered };
    },
  };
  const lines = [];
  let sourceRuns = 0;
  let freshnessReads = 0;
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => currentPlan,
    expectedDefinitionHash: registered.definition_hash,
    platform: "darwin",
    definitionOptions: {
      ...definitionOptions,
      nodePathExists: () => true,
      nodeRealpath: (path) => path,
      nodePathStat: () => ({ isFile: () => true }),
      nodePathAccess: () => {},
    },
    schedulerAdapter,
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => { sourceRuns += 1; return { status: "complete" }; },
    readFreshness: async () => ({
      drive: { last_successful_run_at: ++freshnessReads === 1
        ? "2026-10-06T15:00:00.000Z"
        : "2026-10-06T15:01:00.000Z" },
    }),
    readUpdateTransaction: () => null,
    writeReceipt: () => {},
    log: (line) => lines.push(line),
    silent: false,
  });
  assert.ok(reads > 0, "the runner inspected the registered native definition");
  assert.equal(sourceRuns, 1, "the Node-drift control executes its one ready daily source exactly once");
  assert.equal(result.status, "complete");
  assert.equal(result.sources[0].freshness_advanced, true);
  assert.deepEqual(result.schedule_attention, ["daily schedule needs refresh (Node changed)"]);
  assert.ok(lines.includes("daily schedule needs refresh (Node changed)"));

  const changedPlan = { ...currentPlan, source_plan_hash: "sha256:changed-sources" };
  let driftRuns = 0;
  await assert.rejects(() => runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => changedPlan,
    expectedDefinitionHash: registered.definition_hash,
    platform: "darwin",
    definitionOptions: {
      ...definitionOptions,
      nodePathExists: () => true,
      nodeRealpath: (path) => path,
      nodePathStat: () => ({ isFile: () => true }),
      nodePathAccess: () => {},
    },
    schedulerAdapter,
    runSource: async () => { driftRuns += 1; },
    readFreshness: async () => ({}),
    writeReceipt: () => {},
    silent: true,
  }), /manifest or source plan changed/i);
  assert.equal(driftRuns, 0, "source-plan drift reaches the schedule decision before source execution");
});

test("the runner names a missing registered Node binary before any source runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-run-node-missing-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const currentPlan = {
    ...plan,
    manifest_path: manifestPath,
    manifest_path_hash: "sha256:path",
    cron: "0 9 * * *",
    timezone: "UTC",
    sources: [{
      key: "drive", class: "machine-pull", owner: "daily-task", status: "ready",
      run_key: "google_drive", source_names: ["drive"],
    }],
  };
  const registered = buildDailyRefreshDefinition(currentPlan, {
    platform: "darwin",
    nodePath: "/missing/runtime/node",
    brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/daily-refresh-run.mjs",
  });
  let reads = 0;
  let runs = 0;
  await assert.rejects(() => runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => currentPlan,
    expectedDefinitionHash: registered.definition_hash,
    platform: "darwin",
    definitionOptions: {
      nodePath: "/current/runtime/node",
      brainPath: registered.brain_path,
      runnerPath: registered.runner_path,
      nodePathExists: () => false,
      nodePathStat: () => ({ isFile: () => true }),
      nodePathAccess: () => {},
    },
    schedulerAdapter: {
      read: () => {
        reads += 1;
        return { exists: true, owned: true, enabled: true, definition: registered };
      },
    },
    runSource: async () => { runs += 1; },
    readFreshness: async () => ({}),
    writeReceipt: () => {},
    silent: true,
  }), /registered Node binary is missing/i);
  assert.ok(reads > 0, "the missing-binary decision inspected the registered definition");
  assert.equal(runs, 0);
});

test("the runner refuses a present non-executable registered Node before any source runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-run-node-unusable-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const currentPlan = {
    ...plan,
    manifest_path: manifestPath,
    manifest_path_hash: "sha256:path",
    cron: "0 9 * * *",
    timezone: "UTC",
    sources: [{
      key: "drive", class: "machine-pull", owner: "daily-task", status: "ready",
      run_key: "google_drive", source_names: ["drive"],
    }],
  };
  const registeredPath = "/registered/runtime/node";
  const currentPath = "/current/runtime/node";
  const registered = buildDailyRefreshDefinition(currentPlan, {
    platform: "darwin",
    nodePath: registeredPath,
    brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/daily-refresh-run.mjs",
  });
  let reads = 0;
  let runs = 0;
  await assert.rejects(() => runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => currentPlan,
    expectedDefinitionHash: registered.definition_hash,
    platform: "darwin",
    definitionOptions: {
      nodePath: currentPath,
      brainPath: registered.brain_path,
      runnerPath: registered.runner_path,
      nodePathExists: () => true,
      nodeRealpath: (path) => path,
      nodePathStat: () => ({ isFile: () => true }),
      nodePathAccess: (path) => {
        if (path === registeredPath) throw Object.assign(new Error("not executable"), { code: "EACCES" });
      },
    },
    schedulerAdapter: {
      read: () => {
        reads += 1;
        return { exists: true, owned: true, enabled: true, definition: registered };
      },
    },
    runSource: async () => { runs += 1; },
    readFreshness: async () => ({}),
    writeReceipt: () => {},
    silent: true,
  }), /registered Node binary is not executable/i);
  assert.ok(reads > 0, "the unusable-binary decision inspected the registered definition");
  assert.equal(runs, 0, "an unusable registered launcher stops before source execution");
});

test("runtime exhaustion reaches the decision point and defers remaining sources", async () => {
  let runCalls = 0;
  const boundedPlan = {
    ...plan,
    max_runtime_minutes: 1,
    sources: [
      ...plan.sources,
      { key: "mail", class: "machine-pull", owner: "daily-task", status: "ready", run_key: "gmail" },
    ],
  };
  const times = [
    "2026-10-06T15:00:00.000Z",
    "2026-10-06T15:01:00.000Z",
    "2026-10-06T15:01:01.000Z",
    "2026-10-06T15:01:02.000Z",
  ];
  const result = await runDailyRefresh({
    plan: boundedPlan,
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => { runCalls += 1; return { status: "complete" }; },
    readFreshness: async () => ({}),
    writeReceipt: () => {},
    now: () => new Date(times.shift() || "2026-10-06T15:01:03.000Z"),
  });
  assert.equal(runCalls, 0, "no source starts after the runner reaches its runtime decision point");
  assert.equal(result.status, "failed");
  assert.deepEqual(result.sources.map((source) => source.status), ["deferred", "deferred"]);
  assert.ok(result.sources.every((source) => /runtime budget/i.test(source.reason)));
});

test("daily CLI journals successful, refused, and failed runs without raw diagnostics", async () => {
  const { readFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "daily-observation-"));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  let decisions = 0;
  const options = {
    home, platform: "darwin", brainModule: {},
    buildPlan: async () => ({ ...plan, manifest_path: manifestPath }),
    now: () => new Date("2026-10-07T16:00:00.000Z"),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    readUpdateTransaction: () => null,
    readFreshness: async () => ({}), writeReceipt: () => {}, silent: true,
    runSource: async () => { decisions += 1; throw new Error("private diagnostic must not be retained"); },
  };
  const failed = await runDailyRefreshCli(manifestPath, options);
  assert.equal(decisions, 1, "the failed source was actually attempted");
  assert.equal(failed.status, "failed");
  const logPath = join(home, ".brain", "logs", plan.identity.id, "daily.log");
  let rows = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).result, "failed");
  assert.equal(rows.at(-1).started_at, "2026-10-07T16:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(rows), /private diagnostic|google_drive|fixtures/);
  let reads = 0;
  const complete = await runDailyRefreshCli(manifestPath, {
    ...options,
    runSource: async () => { decisions += 1; },
    readFreshness: async () => ({ drive: { last_successful_run_at: ++reads === 1
      ? "2026-10-06T16:00:00.000Z" : "2026-10-07T16:00:00.000Z" } }),
  });
  assert.equal(complete.status, "complete", "the same CLI path has a green control");
  assert.equal(decisions, 2);
  let authorizationReads = 0;
  await assert.rejects(runDailyRefreshCli(manifestPath, {
    ...options, expectedDefinitionHash: "sha256:expected",
    inspectSchedule: () => { authorizationReads += 1; throw new Error("authorization denied"); },
  }), /authorization denied/);
  assert.equal(authorizationReads, 1, "the refusal reached schedule authorization");
  rows = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.filter((row) => row.result !== "running").map((row) => row.result), ["failed", "complete", "failed"]);
  assert.equal(rows.at(-1).error, "Daily refresh failed before completion. Inspect the schedule and source authorization.");
});

test("daily logs rotate at a fixed bound, stay private, and refuse links or failed ACLs", async () => {
  const fs = await import("node:fs");
  const { appendDailyObservation, readDailyObservation, DAILY_LOG_MAX_BYTES } = await import("../operations/daily-refresh-observation.mjs");
  const home = mkdtempSync(join(tmpdir(), "daily-log-retention-"));
  const identity = { id: "v1-fixture" };
  const row = { started_at: "2026-10-07T16:00:00.000Z", completed_at: "2026-10-07T16:01:00.000Z", result: "complete", error: null };
  let paths;
  for (let i = 0; i < 600; i += 1) paths = appendDailyObservation(identity, row, { home, platform: "darwin" });
  assert.ok(fs.statSync(paths.history_path).size > 0, "the rotation threshold was reached");
  for (const path of [paths.log_path, paths.history_path]) {
    assert.ok(fs.statSync(path).size <= DAILY_LOG_MAX_BYTES);
    if (process.platform !== "win32") assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  }
  if (process.platform !== "win32") assert.equal(fs.statSync(paths.directory).mode & 0o777, 0o700);
  assert.equal(readDailyObservation(identity, { home }).record.result, "complete");
  fs.renameSync(paths.log_path, join(home, "retained.log"));
  fs.linkSync(join(home, "retained.log"), paths.log_path);
  assert.throws(() => appendDailyObservation(identity, row, { home }), /regular unlinked/);
  assert.equal(readDailyObservation(identity, { home }).unreadable, true);
  let aclCalls = 0;
  const windowsHome = mkdtempSync(join(tmpdir(), "daily-log-acl-"));
  const options = { home: windowsHome, platform: "win32", username: "fixture", environment: { SystemRoot: String.raw`C:\Windows` },
    runAcl: () => { aclCalls += 1; return { status: 5 }; } };
  assert.throws(() => appendDailyObservation(identity, row, options), /could not restrict/);
  assert.equal(aclCalls, 1, "the denied ACL reached the permissions boundary before writing");
  assert.equal(fs.existsSync(join(windowsHome, ".brain", "logs", identity.id, "daily.log")), false);
  appendDailyObservation(identity, row, { ...options, runAcl: () => { aclCalls += 1; return { status: 0 }; } });
  assert.equal(aclCalls, 3, "the green control restricts both directory and file");
});

test("daily CLI records a planner authorization failure before source execution", async () => {
  const { readDailyObservation } = await import("../operations/daily-refresh-observation.mjs");
  const { dailyRefreshIdentity } = await import("../operations/daily-refresh-plan.mjs");
  const home = mkdtempSync(join(tmpdir(), "daily-plan-log-"));
  const manifestPath = join(home, "brain.manifest.json");
  const manifest = { client: { slug: "fixture" }, brain: { domain: "brain.example.invalid" } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let planned = 0;
  const options = { home, platform: "darwin", principal: "uid:501", brainModule: {}, silent: true,
    buildPlan: async () => { planned += 1; throw new Error("authorization denied"); } };
  await assert.rejects(runDailyRefreshCli(manifestPath, options), /authorization denied/);
  assert.equal(planned, 1);
  const identity = dailyRefreshIdentity(manifest, options.principal);
  assert.equal(readDailyObservation(identity, { home }).record?.result, "failed");
  let reads = 0;
  let runs = 0;
  await runDailyRefreshCli(manifestPath, { ...options,
    buildPlan: async () => ({ ...plan, identity, manifest_path: manifestPath }),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    readUpdateTransaction: () => null,
    readFreshness: async () => ({ drive: { last_successful_run_at: ++reads === 1 ? "2026-10-08T12:00:00.000Z" : "2026-10-10T12:00:00.000Z" } }),
    runSource: async () => { runs++; }, writeReceipt: () => {},
  });
  assert.equal(runs, 1, "the green journal control executes verified work");
  assert.equal(readDailyObservation(identity, { home }).record.result, "complete");
});

test("daily log append refuses a live writer and recovers a proven dead writer", async () => {
  const fs = await import("node:fs");
  const { appendDailyObservation } = await import("../operations/daily-refresh-observation.mjs");
  const home = mkdtempSync(join(tmpdir(), "daily-log-lock-"));
  const identity = { id: "v1-fixture" };
  const row = { started_at: "2026-10-07T16:00:00.000Z", completed_at: "2026-10-07T16:01:00.000Z", result: "complete", error: null };
  const paths = appendDailyObservation(identity, row, { home, platform: "darwin" });
  const before = fs.readFileSync(paths.log_path, "utf8");
  const lockPath = join(paths.directory, "daily.lock");
  fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
  let inspected = 0;
  assert.throws(() => appendDailyObservation(identity, row, { home, platform: "darwin",
    processAlive: (pid) => { inspected += 1; assert.equal(pid, process.pid); return true; },
  }), /another writer/);
  assert.equal(inspected, 1, "the live holder was checked before refusal");
  assert.equal(fs.readFileSync(paths.log_path, "utf8"), before);
  appendDailyObservation(identity, row, { home, platform: "darwin",
    processAlive: (pid) => { inspected += 1; assert.equal(pid, process.pid); return false; },
  });
  assert.equal(inspected, 2, "the dead-writer control reached the same decision");
  assert.equal(fs.readFileSync(paths.log_path, "utf8"), before + before);
  assert.equal(fs.existsSync(lockPath), false);
});

test("daily receipt distinguishes a measured partial refresh from a transient failure", async () => {
  for (const failed of [0, 1]) {
    let reads = 0, runs = 0;
    const result = await runDailyRefresh({
      plan,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => { runs++; return {}; },
      readFreshness: async () => ({ drive: {
        last_successful_run_at: ++reads === 1 || failed
          ? "2026-10-06T12:00:00.000Z" : "2026-10-07T11:00:00.000Z",
        latest_run: { docs_added: 9, docs_updated: 22, docs_unchanged: 0, outcome: failed ? "failed" : "partial", docs_refused: 228, docs_failed: failed },
      } }),
      now: () => new Date("2026-10-07T12:00:00.000Z"),
    });
    assert.equal(runs, 1);
    assert.equal(reads, 2, "both freshness decisions reached");
    assert.equal(result.status, failed ? "failed" : "partial");
    assert.equal(result.sources[0].docs_refused, 228);
    assert.equal(result.sources[0].freshness_advanced, !failed);
  }
});

test("daily refresh preserves intentional exclusions reported by a successful loader", async () => {
  let reads = 0, runs = 0;
  const result = await runDailyRefresh({
    plan, acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async () => { runs++; return { excluded: 12 }; },
    readFreshness: async () => ({ drive: {
      last_successful_run_at: ++reads === 1 ? "2026-10-06T12:00:00.000Z" : "2026-10-07T11:00:00.000Z",
      latest_run: { docs_added: 1, docs_updated: 0, docs_unchanged: 0, outcome: "completed", docs_refused: 0, docs_failed: 0 },
    } }),
    now: () => new Date("2026-10-07T12:00:00.000Z"),
  });
  assert.equal(runs, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].docs_excluded, 12);
  assert.equal(result.sources[0].freshness_advanced, true);
});

test("daily CLI carries partial loader permission and durable refusal evidence through its default adapters", async () => {
  const { readDailyObservation, dailyObservationStatus } = await import("../operations/daily-refresh-observation.mjs");
  const directory = mkdtempSync(join(tmpdir(), "daily-partial-adapters-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const calls = [];
  let reads = 0;
  const result = await runDailyRefreshCli(manifestPath, {
    home: directory,
    silent: true,
    buildPlan: async () => ({ ...plan, manifest_path: manifestPath }),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    readUpdateTransaction: () => null,
    writeReceipt: () => {},
    now: () => new Date("2026-10-07T12:00:00.000Z"),
    brainModule: {
      cmdLoad: async (_path, options) => {
        calls.push(options);
        return { partial: 1, excluded: 2 };
      },
      cmdSources: async () => ({ sources: [{ name: "drive", receipt: {
        last_successful_run_at: ++reads === 1 ? "2026-10-06T12:00:00.000Z" : "2026-10-07T11:00:00.000Z",
        latest_run: { docs_added: 9, docs_updated: 22, docs_unchanged: 0, outcome: "partial", docs_refused: 228, docs_failed: 0 },
      }, freshness: { state: "ok" } }] }),
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].allowPartialRefresh, true);
  assert.equal(calls[0].lifecycleLockHeld, true);
  assert.equal(reads, 2);
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].docs_refused, 228);
  assert.equal(result.sources[0].docs_excluded, 2);
  const observation = readDailyObservation(plan.identity, { home: directory });
  assert.equal(observation.record.result, "partial", "the successful partial run survives journal readback");
  assert.equal(observation.record.error, null, "omissions do not become a process failure");
  for (const exitCode of [0, 1]) {
    const status = dailyObservationStatus(plan, { enabled: false },
      { known: true, running: false, exit_code: exitCode }, true, { home: directory });
    assert.equal(status.last_result, exitCode === 0 ? "partial" : "failed",
      "native failure still overrides a successful partial receipt");
  }
});

test("a failed first refresh stays broken even without a previous success timestamp", async () => {
  const { dailyFreshnessRows } = await import("../brain.mjs");
  for (const state of ["broken", "ok"]) {
    const rows = dailyFreshnessRows({ sources: [{ key: "folder" }] }, { sources: [{
      name: "folder", freshness: { state }, receipt: { last_successful_run_at: null,
        latest_run: state === "broken" ? { outcome: "failed", docs_refused: 0, docs_failed: 1 } : null },
    }] });
    assert.equal(rows.length, 1, "the source joined the daily status decision");
    assert.equal(rows[0].current_state, state === "broken" ? "broken" : "unknown");
    assert.equal(rows[0].last_run_outcome, state === "broken" ? "failed" : "missing_history");
  }
});

// An advanced timestamp cannot override measured zero-work evidence.
for (const arm of [
  { name: "accepted", added: 1, unchanged: 0, refused: 228, failed: 0, expected: "partial" },
  { name: "unchanged", added: 0, unchanged: 3, refused: 0, failed: 0, expected: "complete" },
  { name: "all-refused", added: 0, unchanged: 0, refused: 228, failed: 0, expected: "failed" },
  { name: "empty", added: 0, unchanged: 0, refused: 0, failed: 0, expected: "failed" },
  { name: "failure", added: 1, unchanged: 0, refused: 0, failed: 1, expected: "failed" },
]) {
  test(`BOUNDARY daily verified work ${arm.name}`, async () => {
    let reads = 0, runs = 0;
    const receipts = [];
    const result = await runDailyRefresh({
      plan, acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => { runs++; return {}; },
      readFreshness: async () => ({ drive: {
        last_successful_run_at: ++reads === 1 ? "2026-10-06T12:00:00.000Z" : "2026-10-07T11:00:00.000Z",
        latest_run: { metrics_version: 1, outcome: arm.failed ? "failed" : arm.refused ? "partial" : "completed",
          docs_added: arm.added, docs_updated: 0, docs_unchanged: arm.unchanged,
          docs_refused: arm.refused, docs_failed: arm.failed },
      } }),
      writeReceipt: receipt => receipts.push(receipt),
      now: () => new Date("2026-10-07T12:00:00.000Z"),
    });
    assert.equal(runs, 1);
    assert.equal(reads, 2, "the source and both durable freshness reads were reached");
    assert.equal(receipts.length, 2);
    assert.equal(result.status, arm.expected);
    assert.equal(result.sources[0].freshness_advanced, arm.expected !== "failed");
  });
}

for (const platform of ["darwin", "win32"]) {
  for (const status of ["complete", "partial", "failed", "unexpected"]) {
    test(`${platform} daily observation preserves ${status} without inventing a source failure`, async () => {
      const { observeDailyRun, readDailyObservation, dailyObservationStatus, renderDailyObservation } =
        await import("../operations/daily-refresh-observation.mjs");
      const home = mkdtempSync(join(tmpdir(), "daily-result-"));
      let runs = 0;
      let aclCalls = 0;
      const now = () => new Date("2026-10-07T16:00:00.000Z");
      const options = { home, platform, now, username: "fixture",
        environment: { SystemRoot: String.raw`C:\Windows` },
        runAcl: () => { aclCalls += 1; return { status: 0 }; } };
      const receipt = { status };
      const result = await observeDailyRun(plan.identity, async () => { runs += 1; return receipt; }, options);
      assert.equal(runs, 1, "the runner reached the outcome decision");
      assert.equal(result, receipt, "observation preserves the runner receipt");
      if (platform === "win32") assert.equal(aclCalls, 4, "both journal writes reached directory and file ACLs");
      const observed = readDailyObservation(plan.identity, options);
      const expected = status === "unexpected" ? "failed" : status;
      assert.equal(observed.record.result, expected, "writer and reader agree on the outcome");
      assert.equal(observed.record.completed_at, now().toISOString());
      const schedule = dailyObservationStatus(plan, { enabled: false }, { known: true, exit_code: 0 }, true, options);
      assert.equal(schedule.last_result, expected, "status preserves the journal outcome");
      const lines = [];
      renderDailyObservation(schedule, (line) => lines.push(line));
      if (["complete", "partial"].includes(status)) {
        assert.equal(observed.record.error, null, "coverage omissions are not a process failure");
        assert.equal(schedule.last_error_line, null);
        assert.ok(lines.includes("Last daily error: none recorded"));
      } else {
        assert.equal(observed.record.error, "One or more daily sources failed or did not prove freshness.");
        assert.ok(lines.includes(`Last daily error: ${observed.record.error}`));
      }
      assert.ok(lines.includes(`Last daily result: ${status === "partial" ? "partial (coverage omissions)" : expected}`));
      const failedProcess = dailyObservationStatus(plan, { enabled: false }, { known: true, exit_code: 5 }, true, options);
      assert.equal(failedProcess.last_result, "failed", "a native process failure still overrides any journal result");
      assert.equal(failedProcess.last_error_line, "Daily process exited with code 5.");
    });
  }
}

for (const status of ["complete", "partial", "failed"]) {
  test(`daily journal preserves the production receipt for ${status} source coverage`, async () => {
    const { observeDailyRun, readDailyObservation } = await import("../operations/daily-refresh-observation.mjs");
    const before = "2026-10-06T12:00:00.000Z";
    const after = "2026-10-07T12:00:00.000Z";
    const plan = {
      ready: true, enabled: true, identity: { id: "v1-composed" }, manifest_path: "/fixtures/brain.manifest.json",
      sources: [{ key: "folder", class: "machine-pull", owner: "daily-task", status: "ready",
        run_key: "folder", source_names: ["folder"] }],
    };
    const home = mkdtempSync(join(tmpdir(), "observation-combined-"));
    const options = { home, platform: "darwin", now: () => new Date(after) };
    let readCalls = 0;
    let runCalls = 0;
    let writes = 0;
    const result = await observeDailyRun(plan.identity, () => runDailyRefresh({
      plan, acquireLock: () => ({ assertOwned() {}, release() {} }), now: options.now,
      runSource: async () => { runCalls += 1; return { status: "complete", partial: status === "partial" ? 1 : 0 }; },
      readFreshness: async () => ({ folder: {
        last_successful_run_at: readCalls++ === 0 ? before : status === "failed" ? before : after,
        latest_run: { outcome: status === "complete" ? "completed" : status,
          docs_added: 1, docs_updated: 0, docs_unchanged: 0,
          docs_refused: status === "partial" ? 3 : 0, docs_failed: status === "failed" ? 1 : 0 },
      } }),
      writeReceipt: () => { writes += 1; }, home, platform: "darwin",
    }), options);
    assert.equal(runCalls, 1, "the production source execution was reached");
    assert.equal(readCalls, 2, "freshness was checked before and after execution");
    assert.equal(writes, 2, "both source and aggregate receipts were written");
    if (status === "partial") {
      assert.equal(result.sources[0].freshness_advanced, true, "omissions accompany verified advancing freshness");
      assert.equal(result.status, result.sources[0].status, "aggregate retains the source outcome");
    }
    assert.equal(result.status, status, "production freshness decision reached expected outcome");
    const observed = readDailyObservation(plan.identity, options);
    assert.equal(observed.record.result, result.status, "process log must preserve the production receipt outcome");
    if (status !== "failed") assert.equal(observed.record.error, null);
    else assert.equal(observed.record.error, "One or more daily sources failed or did not prove freshness.");
  });
}
