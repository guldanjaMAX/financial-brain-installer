import assert from "node:assert/strict";
import {
  mkdtempSync as makeTempDirectory,
  readFileSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDailyRefreshDefinition } from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefresh, runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { acquireBrainLifecycleLock } from "../operations/brain-lifecycle-lock.mjs";
import { DriveRemovalReviewRequired } from "../operations/drive-removal-plan.mjs";

const mkdtempSync = (...args) => realpathSync.native(makeTempDirectory(...args));

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

test("macOS daily refresh waits for a live lifecycle holder, then acquires and runs", async () => {
  const receipts = [];
  let acquireCalls = 0;
  let sourceCalls = 0;
  let freshnessReads = 0;
  let elapsed = 0;
  const busy = Object.assign(new Error("busy"), { code: "brain_lifecycle_busy" });
  const result = await runDailyRefresh({
    plan,
    platform: "darwin",
    acquireLock: () => {
      acquireCalls += 1;
      if (elapsed < 5_000) throw busy;
      return { assertOwned() {}, release() {} };
    },
    sleep: async (milliseconds) => { elapsed += milliseconds; },
    lockNow: () => elapsed,
    runSource: async () => { sourceCalls += 1; return { status: "complete" }; },
    readFreshness: async () => ({
      drive: { last_successful_run_at: ++freshnessReads === 1
        ? "2026-10-29T12:00:00.000Z"
        : "2026-10-30T12:00:00.000Z" },
    }),
    writeReceipt: (receipt) => receipts.push(receipt),
    now: () => new Date("2026-10-30T12:00:00.000Z"),
  });
  assert.equal(acquireCalls, 4, "the lock decision was retried at 0, 2, 4, and 6 seconds");
  assert.equal(sourceCalls, 1, "the source ran only after the daily acquired the lock");
  assert.equal(freshnessReads, 2, "both source evidence decisions were reached");
  assert.equal(elapsed, 6_000);
  assert.equal(result.status, "complete");
  assert.equal(result.lock_wait_ms, 6_000);
  assert.equal(receipts.at(-1).lock_wait_ms, 6_000);
});

test("macOS daily refresh makes the final lock decision when a holder releases inside the last interval", async () => {
  const receipts = [];
  let acquireCalls = 0;
  let sourceCalls = 0;
  let freshnessReads = 0;
  let elapsed = 0;
  let holderReleased = false;
  const busy = Object.assign(new Error("busy"), { code: "brain_lifecycle_busy" });
  const result = await runDailyRefresh({
    plan,
    platform: "darwin",
    acquireLock: () => {
      acquireCalls += 1;
      if (!holderReleased) throw busy;
      return { assertOwned() {}, release() {} };
    },
    sleep: async (milliseconds) => {
      if (elapsed < 54_500 && elapsed + milliseconds >= 54_500) holderReleased = true;
      elapsed += milliseconds;
    },
    lockNow: () => elapsed,
    runSource: async () => { sourceCalls += 1; return { status: "complete" }; },
    readFreshness: async () => ({
      drive: { last_successful_run_at: ++freshnessReads === 1
        ? "2026-10-29T12:00:00.000Z"
        : "2026-10-30T12:00:00.000Z" },
    }),
    writeReceipt: (receipt) => receipts.push(receipt),
    now: () => new Date("2026-10-30T12:00:00.000Z"),
  });
  assert.equal(acquireCalls, 29, "the final acquisition decision was reached at 55 seconds");
  assert.equal(sourceCalls, 1, "the source ran after the holder released inside the final interval");
  assert.equal(freshnessReads, 2, "both source evidence decisions were reached");
  assert.equal(elapsed, 55_000);
  assert.equal(result.status, "complete");
  assert.equal(result.lock_wait_ms, 55_000);
  assert.equal(receipts.at(-1).status, "complete", "the terminal receipt is not deferred");
  assert.equal(receipts.at(-1).lock_wait_ms, 55_000);
});

test("macOS daily refresh defers after the fixed 55-second lifecycle wait", async () => {
  const receipts = [];
  let acquireCalls = 0;
  let sourceCalls = 0;
  let elapsed = 0;
  const busy = Object.assign(new Error("busy"), { code: "brain_lifecycle_busy" });
  const result = await runDailyRefresh({
    plan,
    platform: "darwin",
    acquireLock: () => { acquireCalls += 1; throw busy; },
    sleep: async (milliseconds) => { elapsed += milliseconds; },
    lockNow: () => elapsed,
    runSource: async () => { sourceCalls += 1; },
    readFreshness: async () => ({}),
    writeReceipt: (receipt) => receipts.push(receipt),
    now: () => new Date("2026-10-30T12:00:00.000Z"),
  });
  assert.equal(acquireCalls, 29, "the initial decision and the final decision at 55 seconds were reached");
  assert.equal(sourceCalls, 0, "the bounded refusal stopped before source execution");
  assert.equal(elapsed, 55_000, "the final partial interval reaches the fixed total bound");
  assert.equal(result.status, "deferred");
  assert.equal(result.lock_wait_ms, 55_000);
  assert.equal(receipts.at(-1).status, "deferred");
  assert.equal(receipts.at(-1).lock_wait_ms, result.lock_wait_ms);
});

test("macOS daily refresh acquires a free lifecycle lock immediately", async () => {
  let acquireCalls = 0;
  let sourceCalls = 0;
  let freshnessReads = 0;
  let sleepCalls = 0;
  const result = await runDailyRefresh({
    plan,
    platform: "darwin",
    acquireLock: () => { acquireCalls += 1; return { assertOwned() {}, release() {} }; },
    sleep: async () => { sleepCalls += 1; },
    lockNow: () => 0,
    runSource: async () => { sourceCalls += 1; return { status: "complete" }; },
    readFreshness: async () => ({
      drive: { last_successful_run_at: ++freshnessReads === 1
        ? "2026-10-29T12:00:00.000Z"
        : "2026-10-30T12:00:00.000Z" },
    }),
    now: () => new Date("2026-10-30T12:00:00.000Z"),
  });
  assert.equal(acquireCalls, 1, "the free-lock control reached exactly one acquisition decision");
  assert.equal(sourceCalls, 1, "the free-lock control ran its source");
  assert.equal(sleepCalls, 0);
  assert.equal(result.status, "complete");
  assert.equal(result.lock_wait_ms, 0);
});

test("Windows daily refresh keeps one immediate lifecycle-lock attempt", async () => {
  let acquireCalls = 0;
  let sleepCalls = 0;
  const busy = Object.assign(new Error("busy"), { code: "brain_lifecycle_busy" });
  const result = await runDailyRefresh({
    plan,
    platform: "win32",
    acquireLock: () => { acquireCalls += 1; throw busy; },
    sleep: async () => { sleepCalls += 1; },
    lockNow: () => 0,
    runSource: async () => assert.fail("Windows lock busy must stop before source execution"),
    readFreshness: async () => ({}),
  });
  assert.equal(acquireCalls, 1, "the Windows negative sibling reached one lock decision");
  assert.equal(sleepCalls, 0, "Windows did not enter the macOS wait path");
  assert.equal(result.status, "deferred");
  assert.equal(result.lock_wait_ms, 0);
});

test("Linux daily refresh keeps one immediate lifecycle-lock attempt", async () => {
  let acquireCalls = 0;
  let sleepCalls = 0;
  const busy = Object.assign(new Error("busy"), { code: "brain_lifecycle_busy" });
  const result = await runDailyRefresh({
    plan,
    platform: "linux",
    acquireLock: () => { acquireCalls += 1; throw busy; },
    sleep: async () => { sleepCalls += 1; },
    lockNow: () => 0,
    runSource: async () => assert.fail("Linux lock busy must stop before source execution"),
    readFreshness: async () => ({}),
  });
  assert.equal(acquireCalls, 1, "the Linux sibling reached one lock decision");
  assert.equal(sleepCalls, 0, "Linux did not enter the macOS wait path");
  assert.equal(result.status, "deferred");
  assert.equal(result.lock_wait_ms, 0);
});

test("daily refresh still reclaims a stale dead lifecycle owner under the existing rules", async () => {
  const home = mkdtempSync(join(process.env.HOME, "daily-stale-owner-"));
  const manifestPath = join(home, "brain.manifest.json");
  const machineLockRoot = join(home, "lifecycle-locks");
  const observedAt = new Date("2026-10-30T12:00:00.000Z");
  writeFileSync(manifestPath, "{}\n");
  const holder = acquireBrainLifecycleLock({
    manifestPath,
    operation: "fixture-holder",
    home,
    // The real lock checks the host's permission model; only the runner simulates macOS.
    platform: process.platform,
    machineLockRoot,
    now: () => observedAt,
  });
  const ownerPath = join(holder.path, readdirSync(holder.path)[0]);
  const staleAt = new Date(observedAt.getTime() - 60_001);
  utimesSync(ownerPath, staleAt, staleAt);
  let acquireCalls = 0;
  let sourceCalls = 0;
  let freshnessReads = 0;
  try {
    const result = await runDailyRefresh({
      plan: { ...plan, manifest_path: manifestPath },
      home,
      platform: "darwin",
      acquireLock: (options) => {
        acquireCalls += 1;
        return acquireBrainLifecycleLock({
          ...options,
          platform: process.platform,
          machineLockRoot,
          staleMs: 60_000,
          isOwnerAlive: () => false,
          now: () => observedAt,
        });
      },
      sleep: async () => assert.fail("stale-owner reclaim must complete inside the existing acquire call"),
      lockNow: () => observedAt.getTime(),
      runSource: async () => { sourceCalls += 1; return { status: "complete" }; },
      readFreshness: async () => ({
        drive: { last_successful_run_at: ++freshnessReads === 1
          ? "2026-10-29T12:00:00.000Z"
          : "2026-10-30T12:00:00.000Z" },
      }),
      now: () => observedAt,
    });
    assert.equal(acquireCalls, 1, "the daily reached the real lock acquisition decision once");
    assert.equal(sourceCalls, 1, "reclaim allowed the daily source to run");
    assert.equal(result.status, "complete");
    assert.equal(result.lock_wait_ms, 0);
  } finally {
    holder.release();
  }
});

test("daily owner copy keeps lock busy separate from a retryable network failure", async () => {
  const home = mkdtempSync(join(process.env.HOME, "daily-owner-cause-"));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const ownerPlan = {
    ...plan,
    manifest_path: manifestPath,
    sources: [{
      key: "drive", source_names: ["drive"], class: "machine-pull",
      owner: "daily-task", status: "ready", run_key: "google_drive",
    }],
  };
  let lockElapsed = 0;
  const common = {
    brainModule: {},
    buildPlan: async () => ownerPlan,
    readFreshness: async () => ({}),
    readUpdateTransaction: () => null,
    writeReceipt: () => {},
    home,
    platform: "darwin",
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    lockNow: () => lockElapsed,
    sleep: async (milliseconds) => { lockElapsed += milliseconds; },
  };

  let lockDecisions = 0;
  const lockLines = [];
  const lockResult = await runDailyRefreshCli(manifestPath, {
    ...common,
    acquireLock: () => {
      lockDecisions++;
      throw Object.assign(new Error("fixture lock busy"), { code: "brain_lifecycle_busy" });
    },
    runSource: async () => assert.fail("lock busy must stop before source execution"),
    log: (line) => lockLines.push(String(line)),
  });

  let networkDecisions = 0;
  const networkLines = [];
  const networkResult = await runDailyRefreshCli(manifestPath, {
    ...common,
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async () => {
      networkDecisions++;
      throw Object.assign(new Error("fixture retryable network failure"), { code: "ECONNRESET" });
    },
    log: (line) => networkLines.push(String(line)),
  });

  const lockCopy = lockLines.join("\n");
  const networkCopy = networkLines.join("\n");
  assert.equal(lockDecisions, 29, "the real daily lifecycle classification reached the final bounded retry decision");
  assert.equal(networkDecisions, 1, "the real daily network classification was reached");
  assert.equal(lockResult.reason_code, "brain_lifecycle_busy");
  assert.equal(lockResult.lock_wait_ms, 55_000);
  assert.equal(networkResult.lock_wait_ms, 0);
  assert.equal(networkResult.sources[0].issue_code, "NETWORK_UNREACHABLE");
  assert.match(lockCopy, /another Brain operation is running.*retry after it finishes/iu);
  assert.doesNotMatch(lockCopy, /internet connection dropped/iu);
  assert.match(networkCopy, /network unavailable.*retry this source/iu);
  assert.notEqual(lockCopy, networkCopy, "lock and network owner causes must not render uniformly");

  const { dailyObservationStatus, readDailyObservation } = await import("../operations/daily-refresh-observation.mjs");
  assert.equal(readDailyObservation(ownerPlan.identity, { home, platform: "darwin" }).record.result, "failed",
    "the observation reader ignored the additive daily receipt field after the later source failure");
  const status = dailyObservationStatus(ownerPlan, { enabled: false }, { known: true, exit_code: 0 }, true, {
    home,
    platform: "darwin",
  });
  assert.equal(status.last_result, "failed", "the status reader still parsed the observed daily outcome");
});

test("daily owner copy preserves each closed provider withholding cause", async () => {
  const home = mkdtempSync(join(process.env.HOME, "daily-withheld-cause-"));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const before = "2026-10-28T12:00:00.000Z";
  const observedAt = "2026-10-29T12:00:00.000Z";
  const ownerPlan = {
    ...plan,
    manifest_path: manifestPath,
    sources: [{
      key: "microsoft", source_names: ["microsoft"], class: "machine-pull",
      owner: "daily-task", status: "ready", run_key: "microsoft",
    }],
  };
  const causeArms = [
    {
      label: "calendar-only",
      reasons: { calendar_event_incomplete: 1 },
      ownerPattern: /calendar_event_incomplete: 1 incomplete calendar item\(s\) queued for retry/iu,
    },
    {
      label: "credential-only",
      reasons: { credential_detected: 1 },
      ownerPattern: /credential_detected: 1 item\(s\) held by the credential safety check for review/iu,
    },
    {
      label: "mixed",
      reasons: { calendar_event_incomplete: 1, credential_detected: 2 },
      ownerPattern: /calendar_event_incomplete: 1 incomplete calendar item\(s\) queued for retry; credential_detected: 2 item\(s\) held by the credential safety check for review/iu,
    },
  ];
  const ownerLines = [];

  for (const arm of causeArms) {
    const docsWithheld = Object.values(arm.reasons).reduce((sum, count) => sum + count, 0);
    const latestRun = {
      outcome: "partial",
      walk_complete: true,
      provider_check_complete: true,
      metrics_version: 1,
      started_at: observedAt,
      finished_at: observedAt,
      files_seen: docsWithheld,
      docs_added: 0,
      docs_updated: 0,
      docs_unchanged: 0,
      docs_refused: docsWithheld,
      docs_failed: 0,
      docs_withheld: docsWithheld,
      withheld_reasons: arm.reasons,
    };
    let sourceDecisions = 0;
    let inventoryDecisions = 0;
    const receipts = [];
    const lines = [];
    const result = await runDailyRefreshCli(manifestPath, {
      brainModule: {},
      buildPlan: async () => ownerPlan,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => { sourceDecisions++; return { status: "partial", partial: docsWithheld }; },
      readFreshness: async () => {
        inventoryDecisions++;
        return { microsoft: {
          kind: "microsoft",
          last_check_at: inventoryDecisions === 1 ? before : observedAt,
          last_successful_run_at: before,
          latest_run: inventoryDecisions === 1 ? { finished_at: before } : latestRun,
        } };
      },
      readUpdateTransaction: () => null,
      writeReceipt: (receipt) => receipts.push(receipt),
      log: (line) => lines.push(String(line)),
      home,
      platform: "darwin",
      now: () => new Date(observedAt),
    });
    const sourceReceipt = receipts.find((receipt) => receipt.kind === "daily_refresh_source");
    const ownerLine = lines.find((line) => line.startsWith("microsoft |"));
    assert.equal(sourceDecisions, 1, `${arm.label}: the source decision was reached`);
    assert.equal(inventoryDecisions, 2, `${arm.label}: both inventory decisions were reached`);
    assert.equal(result.status, "partial", `${arm.label}: withholding remains partial`);
    assert.equal(sourceReceipt?.docs_withheld, docsWithheld, `${arm.label}: exact count is durable`);
    assert.deepEqual(sourceReceipt?.withheld_reasons, arm.reasons, `${arm.label}: exact closed map is durable`);
    assert.match(ownerLine, arm.ownerPattern, `${arm.label}: the owner sees the cause and action`);
    ownerLines.push(ownerLine);
  }

  let successDecisions = 0;
  let successInventoryDecisions = 0;
  const successLines = [];
  const successResult = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => ownerPlan,
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async () => { successDecisions++; return { status: "complete" }; },
    readFreshness: async () => {
      successInventoryDecisions++;
      return { microsoft: {
        kind: "microsoft",
        last_successful_run_at: successInventoryDecisions === 1 ? before : observedAt,
        latest_run: successInventoryDecisions === 1 ? { finished_at: before } : {
          outcome: "completed",
          metrics_version: 1,
          files_seen: 1,
          docs_added: 1,
          docs_updated: 0,
          docs_unchanged: 0,
          docs_refused: 0,
          docs_failed: 0,
          docs_withheld: 0,
        },
      } };
    },
    readUpdateTransaction: () => null,
    writeReceipt: () => {},
    log: (line) => successLines.push(String(line)),
    home,
    platform: "darwin",
    now: () => new Date(observedAt),
  });
  const successOwnerLine = successLines.find((line) => line.startsWith("microsoft |"));
  assert.equal(successDecisions, 1, "success: the source decision was reached");
  assert.equal(successInventoryDecisions, 2, "success: both inventory decisions were reached");
  assert.equal(successResult.status, "complete", "success remains the completed green control");
  assert.equal(successOwnerLine, `microsoft | complete | ${observedAt}`);
  assert.equal(new Set(ownerLines).size, causeArms.length, "all withholding siblings render distinctly");
  assert.ok(ownerLines.every((line) => line !== successOwnerLine), "no withholding arm renders like success");
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

test("unknown source exceptions retain only a safe diagnostic detail", async () => {
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
  assert.equal(result.sources[0].issue_code, "UNKNOWN");
  assert.equal(typeof result.sources[0].detail, "string");
  assert.ok(result.sources[0].detail.length > 0 && result.sources[0].detail.length <= 200);
  assert.doesNotMatch(JSON.stringify(receipts), new RegExp(privateSentinel));
});

test("removal review failures retain safe cause, attention, status, and daily-log evidence", async () => {
  const home = mkdtempSync(join(tmpdir(), "daily-removal-review-"));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const fingerprint = "a".repeat(64);
  const reviewPlan = {
    ...plan,
    manifest_path: manifestPath,
    sources: [{
      key: "archive", class: "machine-pull", owner: "daily-task", status: "ready",
      run_key: "archive", source_names: ["archive"],
    }],
  };
  let sourceCalls = 0;
  const error = new DriveRemovalReviewRequired(
    `2 stored document(s) would be removed across 0 source removal(s) and 9 replacement family review(s). ` +
      `Source cleanup would remove 0 of 861 stored documents (0.0%). --apply-removals ${fingerprint}`,
  );
  error.removal_review = Object.freeze({
    stored_documents_to_remove: 2,
    source_removals: 0,
    replacement_family_reviews: 9,
    source_cleanup_percentage: 0,
    fingerprint,
  });
  const now = () => new Date("2026-10-21T16:00:00.000Z");
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => reviewPlan,
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async () => { sourceCalls += 1; throw error; },
    readFreshness: async () => ({}),
    readUpdateTransaction: () => null,
    home,
    platform: "darwin",
    now,
    silent: true,
  });

  assert.equal(sourceCalls, 1, "the removal-review decision point was reached");
  assert.equal(result.status, "failed");
  assert.equal(result.sources[0].status, "failed");
  assert.equal(result.sources[0].issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(result.sources[0].reason_code, "removal_review_required");
  assert.equal(result.sources[0].reason,
    `a removal review is waiting: 2 stored documents would be removed across 0 source removals and 9 replacement family reviews; ` +
      `source cleanup is 0.0% of stored documents; plan fingerprint ${fingerprint}. Nothing was removed.`);
  assert.ok(result.sources[0].detail.length > 0 && result.sources[0].detail.length <= 200);
  assert.doesNotMatch(result.sources[0].detail, /[\r\n]/u);
  assert.deepEqual(result.schedule_attention, [
    "archive: a removal review is waiting (2 stored parts, 0 source removals). Nothing was removed.",
  ]);
  assert.doesNotMatch(result.schedule_attention[0], /--apply-removals|then run|re-run/iu);

  const logPath = join(home, ".brain", "logs", reviewPlan.identity.id, "daily.log");
  const logRecords = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const failures = logRecords.filter((record) => record.kind === "source_failure");
  assert.equal(failures.length, 1, "the failed source wrote exactly one diagnostic log record");
  assert.equal(failures[0].source, "archive");
  assert.equal(failures[0].issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(failures[0].detail, result.sources[0].detail);

  const { dailyObservationStatus, renderDailyObservation } = await import("../operations/daily-refresh-observation.mjs");
  const schedule = dailyObservationStatus(reviewPlan, {
    enabled: true, plan_matches_registered_definition: true, registered_node_usable: true,
  }, { known: true, running: false, exit_code: 0 }, true, { home, platform: "darwin", now });
  assert.deepEqual(schedule.schedule_attention, result.schedule_attention,
    "daily status reads the persisted removal-review attention");
  assert.deepEqual(schedule.source_issues, [{
    source: "archive", issue_code: "SAFETY_REVIEW_REQUIRED", detail: result.sources[0].detail,
  }]);
  assert.equal(JSON.parse(JSON.stringify(schedule)).source_issues[0].issue_code, "SAFETY_REVIEW_REQUIRED",
    "daily status JSON carries the source issue code");
  const lines = [];
  renderDailyObservation(schedule, (line) => lines.push(line));
  assert.ok(lines.includes(`Daily attention: ${result.schedule_attention[0]}`));
  assert.ok(lines.includes(`Daily source issue: archive | SAFETY_REVIEW_REQUIRED | ${result.sources[0].detail}`));
});

test("unknown failures redact planted secrets and log each failed source independently", async () => {
  const home = mkdtempSync(join(tmpdir(), "daily-failure-redaction-"));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const plantedSecret = ["sk", "abcdefghijklmnopqrstuvwxyzABCDEF"].join("-");
  const outsidePath = ["", "private", "fixture", "owner", "source.txt"].join("/");
  const failurePlan = {
    ...plan,
    manifest_path: manifestPath,
    sources: ["first", "second"].map((key) => ({
      key, class: "machine-pull", owner: "daily-task", status: "ready", run_key: key, source_names: [key],
    })),
  };
  let sourceCalls = 0;
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => failurePlan,
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async (source) => {
      sourceCalls += 1;
      throw new Error(source.key === "first"
        ? `provider rejected ${plantedSecret} while reading ${outsidePath}`
        : "second synthetic source stopped");
    },
    readFreshness: async () => ({}),
    readUpdateTransaction: () => null,
    home,
    platform: "darwin",
    now: () => new Date("2026-10-21T17:00:00.000Z"),
    silent: true,
  });

  assert.equal(sourceCalls, 2, "both source execution decision points were reached");
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources.map((source) => source.issue_code), ["UNKNOWN", "UNKNOWN"]);
  assert.deepEqual(result.sources.map((source) => source.reason_code), [
    "source_execution_failed", "source_execution_failed",
  ]);
  assert.deepEqual(result.sources.map((source) => source.source), ["first", "second"]);
  const receiptText = JSON.stringify(result);
  assert.doesNotMatch(receiptText, new RegExp(plantedSecret));
  assert.doesNotMatch(receiptText, new RegExp(outsidePath));
  assert.match(result.sources[0].detail, /\[REDACTED:openai_legacy_key\]/u);
  assert.match(result.sources[0].detail, /\[REDACTED:path\]/u);
  assert.ok(result.sources.every((source) => source.detail.length <= 200 && !/[\r\n]/u.test(source.detail)));

  const logPath = join(home, ".brain", "logs", failurePlan.identity.id, "daily.log");
  const logText = readFileSync(logPath, "utf8");
  assert.doesNotMatch(logText, new RegExp(plantedSecret));
  assert.doesNotMatch(logText, new RegExp(outsidePath));
  const failures = logText.trim().split("\n").map((line) => JSON.parse(line))
    .filter((record) => record.kind === "source_failure");
  assert.equal(failures.length, 2, "each failed source wrote its own diagnostic log record");
  assert.deepEqual(failures.map((record) => record.source), ["first", "second"]);
  assert.deepEqual(failures.map((record) => record.issue_code), ["UNKNOWN", "UNKNOWN"]);
});

test("daily failure details redact canonical credential and bounded path views before persistence", async () => {
  const pathTail = "records/private-note.txt";
  const lineWrapped = `sk-${"a".repeat(16)}\n${"b".repeat(16)}`;
  const formatSplit = `sk-${"c".repeat(16)}\u200b${"d".repeat(16)}`;
  const ordinary = `sk-${"e".repeat(32)}`;
  const arms = [
    {
      label: "absolute path containing a space",
      message: `unable to read /private/fixture/client ${pathTail}`,
      check(detail) {
        assert.equal(detail.includes(pathTail), false, "the bounded path tail must not survive");
        assert.match(detail, /\[REDACTED:path\]/u);
      },
    },
    {
      label: "line-wrapped credential",
      message: `provider returned ${lineWrapped}`,
      check(detail) {
        assert.equal(detail.replace(/\s/gu, "").includes(lineWrapped.replace(/\s/gu, "")), false,
          "joining persisted whitespace must not reconstruct the credential");
      },
    },
    {
      label: "format-control-split credential",
      message: `provider returned ${formatSplit}`,
      check(detail) {
        assert.equal(detail.replace(/\u200b/gu, "").includes(formatSplit.replace(/\u200b/gu, "")), false,
          "removing persisted format controls must not reconstruct the credential");
      },
    },
    {
      label: "ordinary credential control",
      message: `provider returned ${ordinary}`,
      check(detail) {
        assert.equal(detail.includes(ordinary), false);
        assert.match(detail, /\[REDACTED:openai_legacy_key\]/u,
          "the ordinary scanner path remains the green control");
      },
    },
  ];

  let sourceCalls = 0;
  for (const arm of arms) {
    const logged = [];
    const result = await runDailyRefresh({
      plan: {
        ...plan,
        sources: [{
          key: "fixture", class: "machine-pull", owner: "daily-task", status: "ready",
          run_key: "fixture", source_names: ["fixture"],
        }],
      },
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => { sourceCalls += 1; throw new Error(arm.message); },
      readFreshness: async () => ({}),
      writeReceipt() {},
      writeFailureLog: (record) => logged.push(record),
      now: () => new Date("2026-10-21T18:00:00.000Z"),
    });
    assert.equal(result.status, "failed", `${arm.label}: the failure decision was reached`);
    assert.equal(logged.length, 1, `${arm.label}: exactly one persisted log detail was produced`);
    assert.equal(logged[0].detail, result.sources[0].detail,
      `${arm.label}: the receipt and journal share the sanitized detail`);
    arm.check(result.sources[0].detail);
  }
  assert.equal(sourceCalls, arms.length, "all adversarial and control source decisions were reached");
});

test("complete and partial source receipts stay byte-identical while the daily receipt adds lock wait", async () => {
  const observedAt = "2026-10-21T18:00:00.000Z";
  const before = "2026-10-20T18:00:00.000Z";
  const after = "2026-10-21T18:00:00.000Z";
  const expected = (status) => {
    const source = {
      schema_version: 1,
      kind: "daily_refresh_source",
      identity: "v1-run",
      source: "drive",
      status,
      started_at: observedAt,
      completed_at: observedAt,
      last_successful_run_at_before: before,
      last_successful_run_at_after: after,
      freshness_advanced: true,
      check_verified: true,
      no_change: false,
      last_check_at_before: before,
      last_check_at_after: after,
      docs_refused: null,
      docs_withheld: 0,
      docs_excluded: null,
      missing_freshness_sources: [],
      unadvanced_freshness_sources: [],
      reason: null,
    };
    return [source, {
      schema_version: 1,
      kind: "daily_refresh",
      identity: "v1-run",
      status,
      started_at: observedAt,
      completed_at: observedAt,
      lock_wait_ms: 0,
      schedule_attention: [],
      sources: [source],
    }];
  };

  for (const status of ["complete", "partial"]) {
    const receipts = [];
    let reads = 0;
    let sourceCalls = 0;
    await runDailyRefresh({
      plan,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => {
        sourceCalls += 1;
        return { status: "complete", ...(status === "partial" ? { partial: 1 } : {}) };
      },
      readFreshness: async () => ({
        drive: { last_successful_run_at: reads++ === 0 ? before : after },
      }),
      writeReceipt: (receipt) => receipts.push(receipt),
      now: () => new Date(observedAt),
    });
    assert.equal(sourceCalls, 1, `${status} control reached source execution`);
    assert.equal(reads, 2, `${status} control reached both freshness decisions`);
    assert.equal(JSON.stringify(receipts), JSON.stringify(expected(status)),
      `${status} receipt bytes match the pinned baseline shape`);
  }
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

test("macOS lifecycle waiting counts toward the existing daily runtime budget", async () => {
  let elapsed = 0;
  let freshnessReads = 0;
  const sourceCalls = [];
  const busy = Object.assign(new Error("busy"), { code: "brain_lifecycle_busy" });
  const baseTime = Date.parse("2026-10-30T12:00:00.000Z");
  const result = await runDailyRefresh({
    plan: {
      ...plan,
      max_runtime_minutes: 1,
      sources: [
        plan.sources[0],
        { ...plan.sources[0], key: "mail", source_names: ["mail"], run_key: "gmail" },
      ],
    },
    platform: "darwin",
    acquireLock: () => {
      if (elapsed < 54_000) throw busy;
      return { assertOwned() {}, release() {} };
    },
    sleep: async (milliseconds) => { elapsed += milliseconds; },
    lockNow: () => elapsed,
    now: () => new Date(baseTime + elapsed),
    runSource: async (source) => {
      sourceCalls.push(source.key);
      elapsed += 7_000;
      return { status: "complete" };
    },
    readFreshness: async () => ({
      drive: { last_successful_run_at: ++freshnessReads === 1
        ? "2026-10-29T12:00:00.000Z"
        : "2026-10-30T12:00:00.000Z" },
      mail: { last_successful_run_at: "2026-10-29T12:00:00.000Z" },
    }),
  });
  assert.equal(result.lock_wait_ms, 54_000);
  assert.deepEqual(sourceCalls, ["drive"], "only the source that fit inside the original deadline ran");
  assert.deepEqual(result.sources.map((source) => source.status), ["complete", "deferred"]);
  assert.match(result.sources[1].reason, /1-minute daily runtime budget was exhausted/iu);
});

test("daily CLI journals successful, refused, and failed runs with redacted source diagnostics", async () => {
  const { readFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "daily-observation-"));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n");
  const privateDiagnostic = ["SYNTHETIC", "PRIVATE", "DIAGNOSTIC"].join("_");
  let decisions = 0;
  const options = {
    home, platform: "darwin", brainModule: {},
    buildPlan: async () => ({ ...plan, manifest_path: manifestPath }),
    now: () => new Date("2026-10-07T16:00:00.000Z"),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    readUpdateTransaction: () => null,
    readFreshness: async () => ({}), writeReceipt: () => {}, silent: true,
    runSource: async () => { decisions += 1; throw new Error(`source stopped: ${privateDiagnostic}`); },
  };
  const failed = await runDailyRefreshCli(manifestPath, options);
  assert.equal(decisions, 1, "the failed source was actually attempted");
  assert.equal(failed.status, "failed");
  const logPath = join(home, ".brain", "logs", plan.identity.id, "daily.log");
  let rows = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).result, "failed");
  assert.equal(rows.at(-1).started_at, "2026-10-07T16:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${privateDiagnostic}|google_drive|fixtures`));
  assert.equal(rows.find((row) => row.kind === "source_failure")?.issue_code, "UNKNOWN");
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
  assert.deepEqual(rows.filter((row) => row.kind !== "source_failure" && row.result !== "running")
    .map((row) => row.result), ["failed", "complete", "failed"]);
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
      cmdSources: async () => assert.fail("daily must not request the complete inventory"),
      readSourceFreshness: async () => ({ sources: [{ name: "drive", receipt: {
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

for (const evidence of ["changed", "quiet"]) {
  for (const outage of ["none", "before", "after", "both"]) {
    test(`inventory evidence ${evidence} with ${outage} outage never certifies unknown freshness`, async () => {
      const before = "2026-10-01T00:00:00.000Z";
      const now = "2026-10-02T00:00:00.000Z";
      const calls = [];
      const receipts = [];
      let reads = 0;
      const result = await runDailyRefresh({
        plan,
        acquireLock: () => ({ assertOwned() {}, release: () => calls.push("release") }),
        runSource: async source => { calls.push(source.key); return { status: "complete" }; },
        readFreshness: async () => {
          reads++;
          if (outage === "both" || (outage === "before" && reads === 1) || (outage === "after" && reads === 2)) {
            throw new Error("synthetic inventory outage");
          }
          return { drive: {
            kind: "drive",
            last_successful_run_at: evidence === "quiet" ? null : reads === 1 ? before : now,
            latest_run: reads === 1 ? null : {
              outcome: evidence === "quiet" ? "empty" : "success", walk_complete: true, metrics_version: 1,
              started_at: now, finished_at: now, files_seen: evidence === "quiet" ? 0 : 1,
              docs_added: evidence === "quiet" ? 0 : 1, docs_updated: 0, docs_unchanged: 0,
              docs_refused: 0, docs_failed: 0,
            },
          } };
        },
        writeReceipt: receipt => receipts.push(receipt),
        now: () => new Date(now),
      });
      assert.equal(reads, 2, "both inventory decisions were reached");
      assert.deepEqual(calls, ["drive", "release"], "the approved source ran within its lock");
      assert.equal(result.sources.length, 1, "the real execution produced a source receipt");
      const source = result.sources[0];
      assert.equal(receipts[0], source, "the source evidence reached the durable receipt writer");
      const known = outage === "none";
      assert.equal(source.check_verified, known, "unknown freshness cannot certify a provider check");
      assert.equal(source.no_change, known && evidence === "quiet", "unknown freshness cannot certify no change");
      assert.equal(source.freshness_advanced, known && evidence === "changed");
      assert.equal(source.last_check_at_after, known ? now : null);
      if (known) {
        assert.equal(result.status, "complete", "known evidence remains a green control");
        assert.equal(source.freshness_state, undefined);
      } else {
        assert.equal(source.freshness_state, "unknown");
        assert.equal(source.reason_code, "source_inventory_unavailable");
        assert.notEqual(result.status, "complete");
      }
    });
  }
}

test("inventory outages run eligible legs, retain holds and never claim fresh", async () => {
  for (const unavailable of [false, true]) {
    const calls = []; let reads = 0;
    const result = await runDailyRefresh({
      plan: { ...plan, sources: [...plan.sources,
        { key: "held", class: "machine-pull", owner: "daily-task", status: "skipped" }] },
      acquireLock: () => ({ assertOwned() {}, release: () => calls.push("release") }),
      runSource: async (source) => { calls.push(source.key); return { status: "complete" }; },
      readFreshness: async () => {
        reads++;
        if (unavailable) throw Object.assign(new Error("private detail"), { code: "source_inventory_unavailable" });
        return { drive: { last_successful_run_at: reads === 1 ? "2026-10-01T00:00:00Z" : "2026-10-02T00:00:00Z" } };
      },
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    assert.equal(reads, 2, "both freshness decisions were reached");
    assert.deepEqual(calls, ["drive", "release"], "eligible leg runs but held leg stays held");
    const source = result.sources.find((row) => row.source === "drive");
    assert.equal(source.freshness_advanced, !unavailable);
    if (unavailable) {
      assert.equal(source.freshness_state, "unknown");
      assert.equal(source.reason_code, "source_inventory_unavailable");
      assert.notEqual(result.status, "complete");
      assert.ok(!JSON.stringify(result).includes("private detail"));
    }
  }
});

test("an inventory outage never bypasses a removal refusal and later eligible legs still run", async () => {
  const runs = []; let reads = 0;
  const result = await runDailyRefresh({
    plan: { ...plan, sources: [plan.sources[0], { ...plan.sources[0], key: "mail" }] },
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    readFreshness: async () => { reads++; throw new Error("synthetic inventory outage"); },
    runSource: async (source) => {
      runs.push(source.key);
      if (source.key === "drive") throw Object.assign(new Error("synthetic removal approval required"), { code: "removal_approval_required" });
      return { status: "complete" };
    },
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  });
  assert.deepEqual(runs, ["drive", "mail"], "both eligible execution decisions reached");
  assert.equal(reads, 2, "baseline and successful-leg freshness decisions reached");
  assert.equal(result.sources[0].status, "failed");
  assert.equal(result.sources[1].freshness_state, "unknown");
  assert.equal(result.status, "failed");
  assert.ok(result.sources.every((row) => row.freshness_advanced === false));
});

test("an explicit loader refusal cannot borrow an advancing freshness receipt", async () => {
  const outcomes = [];
  for (const status of ["complete", "refused"]) {
    let runs = 0; let reads = 0;
    const result = await runDailyRefresh({
      plan,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => { runs++; return { status }; },
      readFreshness: async () => ({ drive: { last_successful_run_at: ++reads === 1
        ? "2026-10-01T00:00:00Z" : "2026-10-02T00:00:00Z" } }),
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    assert.equal(runs, 1, "the source execution decision was reached");
    assert.equal(reads, 2, "both receipt decisions were reached");
    outcomes.push([result.status, result.sources[0].freshness_advanced]);
  }
  assert.deepEqual(outcomes, [["complete", true], ["failed", false]]);
});

for (const kind of ["microsoft", "gmail", "calendar"]) {
  test(`quiet ${kind} daily refresh requires a current completed provider check`, async () => {
    const before = "2026-10-08T12:00:00.000Z";
    const now = "2026-10-10T12:00:00.000Z";
    const quiet = { outcome: "empty", walk_complete: true, provider_check_complete: true, metrics_version: 1,
      started_at: now, finished_at: now, files_seen: 0, docs_added: 0, docs_updated: 0,
      docs_unchanged: 0, docs_refused: 0, docs_failed: 0 };
    const arms = [
      ["complete", quiet, before, "complete"],
      ["incomplete", { ...quiet, walk_complete: false }, before, "failed"],
      ["error", { ...quiet, docs_failed: 1 }, before, "failed"],
      ["stale", { ...quiet, started_at: before, finished_at: before }, before, "failed"],
      ["replay", quiet, now, "failed"],
      ["future", { ...quiet, finished_at: "2026-10-11T12:00:00.000Z" }, before, "failed"],
      ["missing boundary", { ...quiet, provider_check_complete: false }, before, kind === "gmail" ? "complete" : "failed"],
    ];
    for (const [arm, latestRun, prior, expected] of arms) {
      let runs = 0;
      let reads = 0;
      const receipts = [];
      const result = await runDailyRefresh({
        plan: { ...plan, sources: [{ key: "mailbox", source_names: ["mailbox"], run_key: kind,
          class: "machine-pull", owner: "daily-task", status: "ready" }] },
        acquireLock: () => ({ assertOwned() {}, release() {} }),
        runSource: async () => { runs++; return { status: "complete" }; },
        readFreshness: async () => ({ mailbox: { kind, last_successful_run_at: before,
          latest_run: ++reads === 1 ? { finished_at: prior } : latestRun } }),
        writeReceipt: receipt => receipts.push(receipt), now: () => new Date(now),
      });
      assert.equal(runs, 1, `${arm}: selected source reached`);
      assert.equal(reads, 2, `${arm}: both evidence decisions reached`);
      assert.equal(receipts.length, 2, `${arm}: source and daily receipts written`);
      assert.equal(result.status, expected, arm);
      assert.equal(result.sources[0].check_verified, expected === "complete", arm);
      assert.equal(result.sources[0].no_change, expected === "complete", arm);
      assert.equal(result.sources[0].freshness_advanced, false, arm);
    }
  });
}


test("iMessage quiet check proves this daily invocation without advancing accepted work", async () => {
  const { dailyFreshnessRows } = await import("../brain.mjs");
  const prior = "2026-07-06T08:00:00.000Z";
  const finished = "2026-07-07T08:01:00.000Z";
  const latest = { outcome: "empty", metrics_version: 1, walk_complete: true,
    started_at: "2026-07-07T08:00:00.000Z", finished_at: finished,
    files_seen: 4, docs_added: 0, docs_updated: 0, docs_unchanged: 0, docs_refused: 0, docs_failed: 0 };
  let reads = 0, runs = 0, ticks = 0;
  const receipts = [];
  const chatPlan = { ...plan, sources: [{ ...plan.sources[0], key: "sample-chat", run_key: "imessage" }] };
  const result = await runDailyRefresh({
    plan: chatPlan, acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async () => { runs++; return { status: "complete" }; },
    readFreshness: async () => ({ "sample-chat": { kind: "imessage", last_successful_run_at: prior,
      latest_run: ++reads === 1 ? { ...latest, started_at: prior, finished_at: prior } : latest } }),
    writeReceipt: receipt => receipts.push(receipt),
    now: () => new Date(Date.parse(latest.started_at) - 60000 + ticks++ * 60000),
  });
  assert.equal(runs, 1);
  assert.equal(reads, 2);
  assert.equal(receipts.length, 2, "execution and both durable observations reached the decision");
  assert.equal(result.status, "complete");
  assert.equal(result.sources[0].check_verified, true);
  assert.equal(result.sources[0].no_change, true);
  assert.equal(result.sources[0].freshness_advanced, false);
  assert.equal(result.sources[0].last_successful_run_at_after, prior);
  assert.equal(result.sources[0].last_check_at_after, finished);
  const rows = dailyFreshnessRows(chatPlan, { as_of: "2026-07-07T08:20:00.000Z", sources: [{
    name: "sample-chat", kind: "imessage", freshness: { state: "ok" },
    receipt: { status: "ready", last_successful_run_at: prior, last_check_at: finished, latest_run: latest },
  }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_run_outcome, "no_change");
  assert.equal(rows[0].current_state, "checked");
});
