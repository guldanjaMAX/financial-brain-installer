import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
