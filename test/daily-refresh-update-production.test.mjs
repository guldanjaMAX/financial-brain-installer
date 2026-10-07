import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cmdDrain, cmdHealth, cmdRollback, cmdUpdate } from "../brain.mjs";
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

function productionHarness(manifestPath, {
  failStage = () => null,
  failRestore = false,
  registeredDefinitionDrift = false,
} = {}) {
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
    definition: buildDailyRefreshDefinition(registeredDefinitionDrift
      ? { ...plan, source_plan_hash: "sha256:registered-sources" }
      : plan, registeredDefinitionDrift
      ? { ...nativeOptions, nodePath: String.raw`C:\OldRuntime\node.exe` }
      : nativeOptions),
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

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readyDocumentsReceipt(version, drainMode) {
  return {
    backend: "d1",
    version,
    vector_drain_mode: drainMode,
    rows: [],
    summary: {
      status: "informational",
      complete: false,
      exact_counts_available_from: "brain report",
    },
    vector_backlog: {
      pending: 0,
      pending_is_capped: false,
      pending_display: "0",
      upserts: 0,
      deletes: 0,
      submitted: 0,
      component_counts_exact: true,
      oldest_queued_at: null,
    },
    vector_readiness: {
      ready: true,
      reason: null,
      expected_vectors: 0,
      actual_vectors: 0,
      pending: 0,
      pending_is_capped: false,
      submitted: 0,
      submitted_counts_exact: true,
      oldest_queued_at: null,
    },
  };
}

function useRealPropagationDecisions(harness, { exhaustDrain = false } = {}) {
  let clock = 0;
  let delayedActiveHealth = false;
  let health503s = 0;
  let drainCalls = 0;
  harness.options.upgradeOptions.cmdHealth = async (manifestPath, options) => cmdHealth(manifestPath, {
    ...options,
    resolveKey: () => "fixture-admin-key-label",
    wait: async (milliseconds) => { clock += milliseconds; },
    request: async (url) => {
      const path = new URL(String(url)).pathname;
      const mode = options.expectDrainMode || "active";
      if (path === "/health") {
        if (mode === "active" && options.reachOnly === true && !delayedActiveHealth) {
          delayedActiveHealth = true;
          health503s += 1;
          return response({ error: "fixture paused generation", paused: true }, 503);
        }
        return response({
          ok: mode === "active",
          status: mode === "active" ? "ok" : "paused-for-upgrade",
          accepting_documents: mode === "active",
          version: "0.4.9",
          vector_writer_protocol: "lease-v1",
          vector_drain_mode: mode,
        });
      }
      assert.equal(path, "/api/admin/brain/documents");
      return response(readyDocumentsReceipt("0.4.9", mode));
    },
  });
  harness.options.upgradeOptions.cmdDrain = async (manifestPath, options) => cmdDrain(manifestPath, {
    ...options,
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-admin-key-label",
    sleep: async (milliseconds) => { clock += milliseconds; },
    now: () => clock,
    maxDurationMs: 130_000,
    http: async () => {
      drainCalls += 1;
      if (exhaustDrain || drainCalls === 1) {
        return response({
          error: "brain corpus writes are paused for a verified upgrade or rollback",
          paused: true,
        }, 503);
      }
      return response({
        drained: 0,
        submitted: 0,
        waiting: 0,
        remaining: 0,
        vector_ready: true,
        expected_vectors: 0,
        actual_vectors: 0,
      });
    },
  });
  return {
    health503s: () => health503s,
    drainCalls: () => drainCalls,
    clock: () => clock,
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

test("production update pauses an identity-owned drifted definition before deployment and reconciles it after proof", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { registeredDefinitionDrift: true });
    await cmdUpdate(manifestPath, harness.options);
    const pause = harness.events.indexOf("schedule:false");
    const deploy = harness.events.indexOf("deploy:paused");
    const reconcile = harness.events.lastIndexOf("schedule:install");
    const finalHealth = harness.events.indexOf("health:active-final");
    assert.ok(pause >= 0 && pause < deploy,
      "the production update reached owned-drift pause before its first deployment mutation");
    assert.ok(reconcile > finalHealth,
      "the drifted definition was replaced only after active, query-ready, queue-zero proof");
    assert.equal(harness.state().enabled, true);
    assert.equal(harness.state().definition.source_plan_hash, harness.plan.source_plan_hash,
      "the reconciled definition is the current manifest-derived control");
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

test("real rollback leaves daily imports paused, reports recovery, and a healthy update restores them", async () => {
  await withFixture(async ({ manifestPath }) => {
    let failedStage = "migration";
    const harness = productionHarness(manifestPath, { failStage: () => failedStage });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture migration failure/);
    assert.equal(harness.state().enabled, false);

    const lines = [];
    const priorLog = console.log;
    console.log = (...values) => lines.push(values.map(String).join(" "));
    let rollback;
    try {
      rollback = await cmdRollback(manifestPath, "fixture-bookmark", {
        confirmed: true,
        resolveAccount: async () => ({ id: "1".repeat(32) }),
        cf: async () => ({ restored: true }),
        cmdDeploy: async () => {},
        cmdHealth: async () => {},
        waitForVectorDrainQuiescence: async () => {},
        d1Query: async (_account, _database, sql) => {
          if (/SELECT schema_version/iu.test(sql)) return { results: [{ schema_version: 48 }] };
          if (/SELECT vector_projection_status/iu.test(sql)) {
            return { results: [{
              status: "bootstrap_required",
              lease_owner: null,
              lease_expires_at: null,
              mutation_id: null,
              mutation_submitted_at: null,
              cursor: null,
              high_water: null,
              chunk_high_water: null,
              submitted_rows: 0,
              bootstrap_protocol: null,
              bootstrap_base_count: 0,
              bootstrap_batch_count: 0,
              tagged_rows: 0,
            }] };
          }
          return { results: [] };
        },
        dailyRefreshOptions: harness.options.dailyRefreshOptions,
      });
    } finally {
      console.log = priorLog;
    }
    assert.equal(rollback.daily_imports_recovery_required, true,
      "the real rollback result exposes the daily recovery decision");
    assert.ok(lines.some((line) => /Daily imports remain paused.*recovery/i.test(line)),
      "the rollback path visibly reports the retained daily recovery");
    assert.equal(harness.state().enabled, false);
    assert.ok(readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    }), "rollback retained the update transaction instead of silently enabling imports");

    failedStage = null;
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(harness.state().enabled, true, "the next healthy update is the restore control");
    assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    }), null);
  });
});

test("real health and drain propagation retries restore only after bounded success", async () => {
  await withFixture(async ({ manifestPath }) => {
    const control = productionHarness(manifestPath);
    const decisions = useRealPropagationDecisions(control);
    await cmdUpdate(manifestPath, control.options);
    assert.equal(decisions.health503s(), 1, "the control reached the real cmdHealth 503 retry");
    assert.equal(decisions.drainCalls(), 2, "the control reached the real cmdDrain paused-generation retry");
    assert.ok(decisions.clock() >= 10_000, "both bounded retry waits were observed by the injected clock");
    assert.equal(control.state().enabled, true);
    assert.equal(readDailyRefreshUpdateTransaction(control.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: control.machineLockRoot,
    }), null);
  });

  await withFixture(async ({ manifestPath }) => {
    const mutation = productionHarness(manifestPath);
    const decisions = useRealPropagationDecisions(mutation, { exhaustDrain: true });
    await assert.rejects(() => cmdUpdate(manifestPath, mutation.options), /drain failed \(503\)/i);
    assert.equal(decisions.drainCalls(), 25, "the exhausted arm reached every bounded cmdDrain retry decision");
    assert.equal(mutation.state().enabled, false, "an exhausted propagation retry never restores daily imports");
    assert.equal(mutation.finish.length, 0, "the nonzero arm prints no success footer");
    assert.ok(readDailyRefreshUpdateTransaction(mutation.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: mutation.machineLockRoot,
    }), "the exhausted arm retained recoverable daily state");
  });
});

test("production native restore failure completes with visible daily attention and remains recoverable", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { failRestore: true });
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(harness.state().enabled, false);
    assert.equal(harness.finish.length, 1, "the verified Brain update reaches the attention footer");
    assert.match(harness.finish[0], /Daily imports.*need attention/i);
    assert.match(harness.finish[0], /remain paused|could not be verified/i);
    assert.ok(harness.events.includes("schedule:true"), "the native restore decision was reached");
    assert.ok(readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    }));
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, "0.4.9",
      "the schedule failure happened after the real upgrade stages committed");
  });
});
