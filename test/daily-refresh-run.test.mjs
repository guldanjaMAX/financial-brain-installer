import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDailyRefreshDefinition } from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefresh, runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";

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
        latest_run: { outcome: failed ? "failed" : "partial", docs_refused: 228, docs_failed: failed },
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
      latest_run: { outcome: "completed", docs_refused: 0, docs_failed: 0 },
    } }),
    now: () => new Date("2026-10-07T12:00:00.000Z"),
  });
  assert.equal(runs, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].docs_excluded, 12);
  assert.equal(result.sources[0].freshness_advanced, true);
});

test("daily CLI carries partial loader permission and durable refusal evidence through its default adapters", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-partial-adapters-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const calls = [];
  let reads = 0;
  const result = await runDailyRefreshCli(manifestPath, {
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
        latest_run: { outcome: "partial", docs_refused: 228, docs_failed: 0 },
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
