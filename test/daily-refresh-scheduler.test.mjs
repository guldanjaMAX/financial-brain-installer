import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDailyRefreshDefinition,
  installDailyRefreshSchedule,
  pauseDailyRefreshSchedule,
  removeDailyRefreshSchedule,
  restoreDailyRefreshSchedule,
  runUpdateWithDailyRefreshPaused,
  statusDailyRefreshSchedule,
} from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { cmdScheduleAllConfigured } from "../brain.mjs";

const basePlan = Object.freeze({
  identity: { id: "v1-0123456789abcdef", principal: "uid:501" },
  manifest_path: "/fixtures/brain.manifest.json",
  manifest_path_hash: "sha256:path",
  manifest_content_hash: "sha256:content",
  source_plan_hash: "sha256:sources",
  cron: "0 9 * * *",
  timezone: "America/Phoenix",
  max_runtime_minutes: 45,
  enabled: true,
  ready: true,
  sources: [],
});

function memoryAdapter(initial = null) {
  let value = initial;
  const calls = [];
  return {
    calls,
    read(identity) { calls.push(["read", identity.id]); return value; },
    install(definition) { calls.push(["install", definition.identity.id]); value = { exists: true, owned: true, enabled: true, definition }; },
    setEnabled(identity, enabled) { calls.push(["setEnabled", identity.id, enabled]); value = { ...value, enabled }; },
    remove(identity) { calls.push(["remove", identity.id]); value = null; },
  };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform} definition binds one Brain, one user, and no secret`, () => {
    const definition = buildDailyRefreshDefinition(basePlan, {
      platform,
      nodePath: platform === "win32" ? String.raw`C:\Program Files\nodejs\node.exe` : "/usr/local/bin/node",
      brainPath: platform === "win32" ? String.raw`C:\FinancialBrain\brain.mjs` : "/opt/brain/brain.mjs",
      runnerPath: platform === "win32" ? String.raw`C:\FinancialBrain\operations\daily-refresh-run.mjs` : "/opt/brain/operations/daily-refresh-run.mjs",
    });
    assert.match(definition.name, /0123456789abcdef/);
    assert.match(definition.serialized, /daily-refresh-run\.mjs/);
    assert.doesNotMatch(definition.serialized, /admin.?key|api.?token|secret/i);
    assert.equal(definition.receipt.manifest_content_hash, "sha256:content");
    assert.equal(definition.receipt.source_plan_hash, "sha256:sources");
  });
}

test("install refuses a foreign collision and exact readback failure", () => {
  const foreign = memoryAdapter({ exists: true, owned: false, enabled: true, definition: { name: "foreign" } });
  assert.throws(
    () => installDailyRefreshSchedule(basePlan, { adapter: foreign, platform: "darwin" }),
    /foreign schedule/i,
  );
  assert.deepEqual(foreign.calls, [["read", basePlan.identity.id]], "collision decision was reached before mutation");

  const priorDefinition = buildDailyRefreshDefinition({ ...basePlan, source_plan_hash: "sha256:prior" }, { platform: "win32" });
  const drift = memoryAdapter({ exists: true, owned: true, enabled: false, definition: priorDefinition });
  drift._changed = priorDefinition;
  drift._enabled = false;
  let installCalls = 0;
  drift.install = function install(definition) {
    this.calls.push(["install", definition.identity.id]);
    installCalls += 1;
    this._changed = installCalls === 1
      ? { ...definition, definition_hash: "sha256:changed" }
      : definition;
    this._enabled = true;
  };
  drift.read = function read(identity) {
    this.calls.push(["read", identity.id]);
    return this._changed ? { exists: true, owned: true, enabled: this._enabled, definition: this._changed } : null;
  };
  drift.setEnabled = function setEnabled(identity, enabled) {
    this.calls.push(["setEnabled", identity.id, enabled]);
    this._enabled = enabled;
  };
  assert.throws(
    () => installDailyRefreshSchedule(basePlan, { adapter: drift, platform: "win32" }),
    /exact readback/i,
  );
  assert.ok(drift.calls.some(([name]) => name === "install"), "readback refusal is not vacuous");
  assert.equal(drift.read(basePlan.identity).definition.definition_hash, priorDefinition.definition_hash,
    "the prior owned definition was restored after failed readback");
  assert.equal(drift.read(basePlan.identity).enabled, false, "the prior disabled state was restored exactly");

  const clean = memoryAdapter();
  const installed = installDailyRefreshSchedule(basePlan, { adapter: clean, platform: "win32" });
  assert.equal(installed.verified, true, "green control installs and reads back exactly");
});

test("pause, restore, status, and remove operate only on the owned identity", () => {
  const adapter = memoryAdapter();
  installDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" });
  const snapshot = pauseDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" });
  assert.equal(snapshot.enabled, true);
  assert.equal(statusDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" }).enabled, false);
  restoreDailyRefreshSchedule(snapshot, { adapter });
  assert.equal(statusDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" }).enabled, true);
  removeDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" });
  assert.equal(statusDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" }).installed, false);
});

test("restoring a definition that was already paused is an exact no-op", () => {
  const definition = buildDailyRefreshDefinition(basePlan, { platform: "darwin" });
  const adapter = memoryAdapter({ exists: true, owned: true, enabled: false, definition });
  const snapshot = pauseDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" });
  const beforeRestoreMutations = adapter.calls.filter(([name]) => name === "setEnabled").length;
  const restored = restoreDailyRefreshSchedule(snapshot, { adapter });
  const afterRestoreMutations = adapter.calls.filter(([name]) => name === "setEnabled").length;
  assert.equal(snapshot.enabled, false, "the pause decision observed the already-disabled control state");
  assert.equal(restored.verified, true);
  assert.equal(afterRestoreMutations, beforeRestoreMutations, "restore did not mutate an already-matching disabled definition");
});

test("manifest source-plan drift is visible without overwriting the owned task", () => {
  const adapter = memoryAdapter();
  installDailyRefreshSchedule(basePlan, { adapter, platform: "darwin" });
  const changed = { ...basePlan, source_plan_hash: "sha256:changed" };
  const status = statusDailyRefreshSchedule(changed, { adapter, platform: "darwin" });
  assert.equal(status.installed, true);
  assert.equal(status.verified, false);
  assert.equal(adapter.calls.filter(([name]) => name === "install").length, 1,
    "status reached the drift decision without mutating the definition");
});

test("the public all-configured command installs on Windows and prints stable freshness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-cli-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "owner-brain", timezone: "America/Phoenix" },
    brain: { worker_name: "owner-brain", domain: "brain.example.invalid" },
    infrastructure: { cloudflare: { account_id: "account", d1_database_id: "database" } },
    corpora: { google_drive: { enabled: true } },
    operations: { daily_refresh: { enabled: true, cron: "0 9 * * *", max_runtime_minutes: 45 } },
  }));
  const adapter = memoryAdapter();
  const lines = [];
  const plan = {
    ...basePlan,
    platform: "win32",
    timezone_matches_machine: true,
    unsupported_sources: 0,
    sources: [{
      key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready",
      source_names: ["drive"],
    }],
  };
  const result = await cmdScheduleAllConfigured(manifestPath, "install", {
    platform: "win32",
    planDailyRefresh: async () => plan,
    schedulerAdapter: adapter,
    syncSourceExpectations: false,
    readSourceInventory: async () => ({
      sources: [{
        name: "drive",
        freshness: { state: "current" },
        receipt: { last_successful_run_at: "2026-10-06T16:00:00.000Z" },
      }],
    }),
    log: (line) => lines.push(line),
  });
  assert.equal(result.schedule.verified, true);
  assert.deepEqual(lines, [
    "google_drive | current | 2026-10-06T16:00:00.000Z | 0 9 * * * America/Phoenix | daily-task",
  ]);
  assert.ok(adapter.calls.some(([name]) => name === "install"), "the native install decision point was reached");
});

test("scheduled execution reuses the installed ownership plan before checking its hash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-shared-plan-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" }, corpora: {} }));
  let planCalls = 0;
  const definition = buildDailyRefreshDefinition(basePlan, { platform: "darwin" });
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => { planCalls += 1; return basePlan; },
    expectedDefinitionHash: definition.definition_hash,
    platform: "darwin",
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => assert.fail("the fixture has no daily-owned source"),
    readFreshness: async () => ({}),
    writeReceipt: () => {},
    silent: true,
  });
  assert.equal(planCalls, 1, "execution reached the same shared planning decision used by installation");
  assert.equal(result.status, "complete");
});

test("update restores only after active, query-ready, queue-zero verification", async () => {
  const events = [];
  const prior = { identity: basePlan.identity, enabled: true, definition: { identity: basePlan.identity } };
  const scheduler = {
    snapshotAndPause: () => { events.push("pause"); return prior; },
    reconcile: (plan) => { events.push(`reconcile:${plan.source_plan_hash}`); return { verified: true }; },
    restore: () => events.push("restore"),
    leavePaused: () => events.push("leave-paused"),
  };
  const updatedPlan = { ...basePlan, source_plan_hash: "sha256:updated" };
  await runUpdateWithDailyRefreshPaused({
    scheduler,
    plan: basePlan,
    runUpdate: async () => { events.push("update"); return { status: "updated" }; },
    verifyFinal: async () => ({ active: true, query_ready: true, pending: 0 }),
    recomputePlan: async () => updatedPlan,
  });
  assert.deepEqual(events, ["pause", "update", "reconcile:sha256:updated"]);

  events.length = 0;
  await assert.rejects(() => runUpdateWithDailyRefreshPaused({
    scheduler,
    plan: basePlan,
    runUpdate: async () => { events.push("update"); return { status: "updated" }; },
    verifyFinal: async () => ({ active: true, query_ready: false, pending: 0 }),
    recomputePlan: async () => updatedPlan,
  }), /query-ready/i);
  assert.deepEqual(events, ["pause", "update", "leave-paused"], "failed final health leaves imports paused");

  events.length = 0;
  await runUpdateWithDailyRefreshPaused({
    scheduler,
    plan: basePlan,
    runUpdate: async () => { events.push("update"); return { status: "noop" }; },
    verifyFinal: async () => assert.fail("a no-op update does not enter final verification"),
    recomputePlan: async () => assert.fail("a no-op update does not replace the schedule"),
  });
  assert.deepEqual(events, ["pause", "update", "restore"], "a verified no-op path restores the exact prior state");
});
