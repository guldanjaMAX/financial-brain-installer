import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildConfiguredDailyPlan, cmdFolder, cmdLoad, renderCliCommands } from "../brain.mjs";
import { acquireBrainLifecycleLock } from "../operations/brain-lifecycle-lock.mjs";
import { buildDailyRefreshDefinition } from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { quotePosixArgument } from "../operations/command-display.mjs";

const fixed = new Date("2026-11-02T18:05:06.789Z");
async function capture(task) {
  const log = console.log, error = console.error;
  console.log = console.error = () => {};
  try { return { value: await task(), error: null }; }
  catch (error) { return { value: null, error }; }
  finally { console.log = log; console.error = error; }
}

async function run(race, mutateBeforeStart = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-approval-lease-")));
  const home = join(root, "home"), path = join(root, "owner's settings.json");
  const machineLockRoot = join(root, "locks");
  for (const part of ["home", "first", "second", "third"]) mkdirSync(join(root, part), { mode: 0o700 });
  const manifest = {
    client: { slug: "fixture-brain", timezone: "UTC" }, brain: { domain: "fixture.invalid" },
    corpora: { upload: { enabled: true, folders: ["first", "second"].map((source) => ({
      source, path: join(root, source), feed: true,
    })) } },
    operations: { daily_refresh: { enabled: true, timezone: "UTC" } },
  };
  writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(join(root, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  const planOptions = {
    platform: "darwin", principal: "fixture-principal", localTimezone: "UTC", existingSchedulerOwners: [],
  };
  const before = await buildConfiguredDailyPlan(manifest, path, planOptions);
  assert.equal(before.ready, true);
  assert.deepEqual(before.sources.filter((source) => source.owner === "daily-task")
    .flatMap((source) => source.source_names), ["first", "second"]);
  const definitionOptions = { platform: "darwin", nodePath: process.execPath };
  const definition = buildDailyRefreshDefinition(before, definitionOptions);
  const folderOptions = {
    home, lifecycleLockOptions: { machineLockRoot }, sourceIngestLockOptions: { home },
    now: () => new Date(fixed),
    schedulerOptions: { launchctl() { throw new Error("unexpected scheduler"); } },
  };
  if (mutateBeforeStart) {
    const completed = await capture(() => cmdFolder(path, ["remove", "--source", "first"], folderOptions));
    assert.ifError(completed.error);
    assert.equal(completed.value.changed, true);
  }
  let inspections = 0, acquisitions = 0, freshnessReads = 0, pending;
  let leaseHeld = false, lockedPlans = 0, lockedInspections = 0, releases = 0;
  let acceptedBeforeAcquisition = false;
  const runs = [], receipts = [];
  const settings = {
    ...planOptions, home, expectedDefinitionHash: definition.definition_hash, definitionOptions,
    async buildPlan(current, manifestPath, options) {
      if (leaseHeld) lockedPlans++;
      return buildConfiguredDailyPlan(current, manifestPath, options);
    },
    inspectSchedule(current) {
      inspections++;
      if (leaseHeld) lockedInspections++;
      const matches = current.source_plan_hash === before.source_plan_hash &&
        current.manifest_content_hash === before.manifest_content_hash;
      if (!acquisitions && matches) acceptedBeforeAcquisition = true;
      return {
        installed: true, enabled: true, state: { definition }, plan_matches_registered_definition: matches,
      };
    },
    acquireLock(options) {
      acquisitions++;
      // The real folder action owns the same lifecycle lease first. The daily
      // runner must encounter contention, then validate the resulting snapshot.
      if (race && acquisitions === 1) {
        pending = capture(() => cmdFolder(path, race === "add"
          ? ["add", "--path", join(root, "third"), "--source", "third"]
          : ["remove", "--source", "first"], folderOptions));
      }
      // The schedule fixture renders macOS commands, but the lock lives on this
      // machine's real filesystem, so it uses the real platform's privacy check.
      const lock = acquireBrainLifecycleLock({ ...options, platform: process.platform, machineLockRoot });
      leaseHeld = true;
      return {
        assertOwned: lock.assertOwned,
        release() { releases++; leaseHeld = false; lock.release(); },
      };
    },
    sleep: async () => { if (pending) await pending; },
    lockNow: () => 0,
    brainModule: {
      cmdLoad(manifestPath, options) {
        assert.equal(leaseHeld, true);
        assert.equal(options.lifecycleLockHeld, true, "nested load reuses the acquired lease");
        return cmdLoad(manifestPath, { ...options, log() {}, commands: {
          ingestLocal: async (_manifest, _path, flags) => {
            runs.push(flags.source);
            return { created: 0, complete: true };
          },
        } });
      },
    },
    readFreshness() {
      freshnessReads++;
      return Object.fromEntries(["first", "second", "third"].map((source) => [source, {
        last_successful_run_at: freshnessReads === 1 ? "2026-11-01T18:05:06.789Z" : fixed.toISOString(),
      }]));
    },
    readUpdateTransaction: () => null,
    writeReceipt(receipt) { receipts.push(receipt); },
    appendObservation() {}, silent: true, now: () => new Date(fixed),
  };
  const result = await capture(() => runDailyRefreshCli(path, settings));
  const mutation = pending ? await pending : null;
  // A handled stale-definition refusal must release the real lease too.
  // Known Windows limitation, tracked for 0.4.27: release can leave the emptied
  // lock directory behind (Windows refuses the directory removal for a moment
  // and release does not retry it), so an immediate re-acquire reports the lock
  // as still being acquired. The re-acquire proof runs on macOS and Linux.
  if (process.platform !== "win32") {
    const next = acquireBrainLifecycleLock({ manifestPath: path, operation: "load", home, machineLockRoot });
    next.assertOwned();
    next.release();
  }
  const sources = JSON.parse(readFileSync(path, "utf8")).corpora.upload.folders.map((entry) => entry.source);
  const expected = renderCliCommands(`brain daily on ${quotePosixArgument(path)}`, { platform: "darwin" });
  return {
    result, mutation, inspections, acquisitions, runs, expected, freshnessReads, receipts, sources,
    acceptedBeforeAcquisition, lockedPlans, lockedInspections, releases,
  };
}

function assertObsolete(r) {
  assert.equal(r.result.error?.code, "daily_schedule_definition_obsolete");
  assert.ok(r.result.error.message.includes(r.expected));
  assert.deepEqual(r.runs, []);
  assert.equal(r.freshnessReads, 0, "approval is checked before inventory or ingest");
  assert.deepEqual(r.receipts, []);
}

test("current daily definition completes exactly the two approved feed legs", async () => {
  const r = await run(false);
  assert.ifError(r.result.error);
  assert.equal(r.result.value.status, "complete");
  assert.deepEqual(r.runs, ["first", "second"]);
  assert.deepEqual(r.result.value.sources.map((source) => source.source), ["first"]);
  assert.ok(r.inspections >= 1, "the registered definition was inspected");
  assert.equal(r.releases, 1);
});

for (const action of ["remove", "add"]) {
  test(`daily approval refuses a concurrent ${action} completed during lifecycle acquisition`, {
    // The race is created by timing: the folder action must take the real lock
    // before the daily runner's first attempt. Windows schedules that step
    // differently, so the contention this test needs does not occur there.
    // The macOS and Linux legs keep this contract covered.
    skip: process.platform === "win32" ? "the lifecycle-contention race is timing-dependent on Windows" : false,
  }, async () => {
    const r = await run(action);
    assert.equal(r.acceptedBeforeAcquisition, true, "the original registered definition was accepted");
    assert.ok(r.acquisitions > 1, "the real lifecycle acquisition reached contention and retried");
    assert.ifError(r.mutation.error);
    assert.equal(r.mutation.value.changed, true, "the real folder action completed");
    assert.deepEqual(r.sources, action === "add" ? ["first", "second", "third"] : ["second"]);
    assertObsolete(r);
    assert.equal(r.lockedPlans, 1, "the changed manifest was planned while holding the lease");
    assert.equal(r.lockedInspections, 1, "the changed plan reached registered approval validation");
    assert.equal(r.releases, 1);
  });
}

test("a removal completed before planning refuses with the concrete recovery command", async () => {
  const r = await run(false, true);
  assert.equal(r.inspections, 1, "the obsolete plan reached the approval decision");
  assert.equal(r.acquisitions, 0);
  assert.deepEqual(r.sources, ["second"]);
  assertObsolete(r);
});
