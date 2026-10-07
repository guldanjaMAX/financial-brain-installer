import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cmdUpdate } from "../brain.mjs";
import {
  buildDailyRefreshDefinition,
  readDailyRefreshUpdateTransaction,
} from "../operations/daily-refresh-scheduler.mjs";

function manifestFixture() {
  return {
    client: { slug: "fixture", timezone: "UTC" },
    brain: { version: "0.4.7", domain: "brain.example.invalid", worker_name: "fixture-brain" },
    infrastructure: {
      cloudflare: {
        account_id: "1".repeat(32),
        auth_profile: `financial-brain-${"2".repeat(24)}`,
        storage: "d1",
        d1_database_id: "11111111-2222-4333-8444-555555555555",
      },
    },
    corpora: { google_drive: { enabled: true } },
    operations: { daily_refresh: { enabled: true, timezone: "UTC" } },
  };
}

function dailyPlan(manifestPath) {
  return {
    schema_version: 1,
    identity: { id: "v1-0123456789abcdef", principal: "sid:S-1-5-21-fixture" },
    manifest_path: manifestPath,
    manifest_path_hash: "sha256:path",
    manifest_content_hash: "sha256:content",
    source_plan_hash: "sha256:sources",
    platform: "win32",
    enabled: true,
    ready: true,
    timezone_matches_machine: true,
    unsupported_sources: 0,
    cron: "0 9 * * *",
    timezone: "UTC",
    max_runtime_minutes: 45,
    sources: [{
      key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready",
      run_key: "google_drive", source_names: ["drive"],
    }],
  };
}

function productionHarness(manifestPath, { failStage = () => null, failRestore = false } = {}) {
  const events = [];
  const finish = [];
  const home = dirname(manifestPath);
  const machineLockRoot = join(home, "machine-locks");
  const plan = dailyPlan(manifestPath);
  const nativeOptions = {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  };
  let state = {
    exists: true,
    owned: true,
    enabled: true,
    definition: buildDailyRefreshDefinition(plan, nativeOptions),
  };
  let d1Version = "0.4.7";
  const adapter = {
    read: () => state,
    setEnabled: (_identity, enabled) => {
      events.push(`schedule:${enabled}`);
      if (enabled && failRestore) throw new Error("fixture native restore failed");
      state = { ...state, enabled };
    },
    install: (definition) => {
      events.push("schedule:install");
      state = { exists: true, owned: true, enabled: true, definition };
    },
  };
  const upgradeOptions = {
    resolveAccount: async () => ({ id: "1".repeat(32) }),
    d1Query: async (_account, _database, sql, params = []) => {
      if (/sqlite_master/iu.test(sql)) return { results: [{ name: "install_state" }] };
      if (/SELECT \* FROM install_state/iu.test(sql)) {
        return { results: [{ client_slug: "fixture", product_version: d1Version, schema_version: 0 }] };
      }
      if (/UPDATE install_state/iu.test(sql)) {
        d1Version = params[1];
        events.push("d1-version");
        return { results: [] };
      }
      if (/SELECT product_version/iu.test(sql)) return { results: [{ product_version: d1Version }] };
      if (/INSERT INTO upgrade_runs/iu.test(sql)) events.push(`history:${params[4]}`);
      return { results: [] };
    },
    cf: async () => ({ bookmark: "fixture-production-bookmark" }),
    readUpdateBacklog: async () => ({ pending: 0 }),
    cmdDeploy: async (_path, options) => {
      const stage = options.pauseVectorDrainForUpgrade ? "paused" : "active";
      events.push(`deploy:${stage}`);
    },
    cmdHealth: async (_path, options) => {
      const stage = options.expectDrainMode === "paused-for-upgrade"
        ? "paused"
        : options.reachOnly ? "active-cutover" : "active-final";
      events.push(`health:${stage}`);
      if (failStage() === `health:${stage}`) throw new Error(`fixture ${stage} health failure`);
    },
    waitForVectorDrainQuiescence: async () => { events.push("writer-wait"); },
    cmdMigrate: async () => {
      events.push("migration");
      if (failStage() === "migration") throw new Error("fixture migration failure");
    },
    cmdBootstrap: async () => {
      events.push("bootstrap");
      return { epoch: 1, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true };
    },
    reconcileWorkerProviderSecrets: async () => { events.push("provider-reconcile"); },
    cmdDrain: async (_path, options) => {
      assert.equal(options.retryPausedCorpusPropagation, true);
      events.push("convergence");
      if (failStage() === "convergence") throw new Error("fixture convergence failure");
    },
    cmdTest: async () => { events.push("acceptance"); },
  };
  const options = {
    discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
    readUpdateBacklog: async () => ({ pending: 0 }),
    adoptCloudflareAuthProfile: async () => {},
    withCloudflareControl: async (action) => action(),
    cmdVerify: async () => { events.push("verification"); },
    upgradeOptions,
    reconcileExistingOwnerAgents: null,
    writeClaudeWorkspaceGuideAfterUpdate: null,
    installTechnicianSkills: () => [{ root: ".codex", status: "verified" }],
    reportSkillRefreshOk: () => {},
    reportSkillRefreshWarning: () => {},
    reportUpdateFinish: (message) => finish.push(message),
    lifecycleLockOptions: { platform: "win32", machineLockRoot },
    dailyRefreshOptions: {
      platform: "win32",
      existingSchedulerOwners: [],
      planDailyRefresh: async () => plan,
      schedulerAdapter: adapter,
      schedulerOptions: { ...nativeOptions, home, machineLockRoot },
      syncSourceExpectations: false,
    },
  };
  return {
    adapter,
    events,
    finish,
    machineLockRoot,
    options,
    plan,
    state: () => state,
  };
}

async function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "daily-production-update-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifestFixture(), null, 2)}\n`);
  try {
    return await run({ directory, manifestPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("production update proves active propagation before convergence and schedule restore", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    await cmdUpdate(manifestPath, harness.options);
    const index = (event) => harness.events.indexOf(event);
    assert.ok(index("schedule:false") < index("deploy:paused"), "native pause precedes the deployment stages");
    assert.ok(index("deploy:active") < index("health:active-cutover"));
    assert.ok(index("health:active-cutover") < index("provider-reconcile"));
    assert.ok(index("provider-reconcile") < index("convergence"));
    assert.ok(index("convergence") < index("health:active-final"));
    assert.ok(index("health:active-final") < index("schedule:true"));
    assert.equal(harness.state().enabled, true);
    assert.equal(harness.finish.length, 1, "the green production control renders one completion message");
    assert.match(harness.finish[0], /passed its checks/i);
  });
});

test("production stage failure persists recovery and a healthy retry completes it", async () => {
  await withFixture(async ({ manifestPath }) => {
    let failedStage = "migration";
    const harness = productionHarness(manifestPath, { failStage: () => failedStage });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture migration failure/);
    assert.equal(harness.state().enabled, false);
    assert.equal(harness.finish.length, 0, "a failed update never renders the success footer");
    const receipt = readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    });
    assert.equal(receipt.phase, "recovery_required");
    assert.ok(harness.events.includes("migration"), "the mutation arm reached the production migration decision");
    assert.equal(harness.events.includes("deploy:active"), false);

    failedStage = null;
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(harness.state().enabled, true, "the healthy retry is the green control");
    assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    }), null);
    assert.equal(harness.finish.length, 1);
  });
});

test("production convergence failure occurs after active cutover and has a healthy control", async () => {
  await withFixture(async ({ manifestPath }) => {
    const mutation = productionHarness(manifestPath, { failStage: () => "convergence" });
    await assert.rejects(() => cmdUpdate(manifestPath, mutation.options), /fixture convergence failure/);
    const index = (event) => mutation.events.indexOf(event);
    assert.ok(index("deploy:active") < index("health:active-cutover"));
    assert.ok(index("health:active-cutover") < index("provider-reconcile"));
    assert.ok(index("provider-reconcile") < index("convergence"));
    assert.equal(mutation.events.includes("health:active-final"), false,
      "the failed convergence decision stops before final health");
    assert.equal(mutation.events.includes("schedule:true"), false);
    assert.equal(mutation.state().enabled, false);
    assert.equal(mutation.finish.length, 0);
    assert.ok(readDailyRefreshUpdateTransaction(mutation.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: mutation.machineLockRoot,
    }), "the convergence refusal retained recovery");
  });

  await withFixture(async ({ manifestPath }) => {
    const control = productionHarness(manifestPath);
    await cmdUpdate(manifestPath, control.options);
    const index = (event) => control.events.indexOf(event);
    assert.ok(index("convergence") < index("health:active-final"),
      "the healthy control crossed convergence and final health");
    assert.ok(index("health:active-final") < index("schedule:true"));
    assert.equal(control.state().enabled, true);
    assert.equal(control.finish.length, 1);
  });
});

test("production native restore failure is non-success and remains recoverable", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { failRestore: true });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture native restore failed/);
    assert.equal(harness.state().enabled, false);
    assert.equal(harness.finish.length, 0, "restore failure cannot be hidden behind exit-zero copy");
    assert.ok(harness.events.includes("schedule:true"), "the native restore decision was reached");
    assert.ok(readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    }));
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, "0.4.9",
      "the schedule failure happened after the real upgrade stages committed");
  });
});
