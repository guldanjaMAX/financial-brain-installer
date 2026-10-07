import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { cmdDrain, cmdHealth, cmdRollback, cmdUpdate } from "../brain.mjs";
import {
  buildDailyRefreshDefinition,
  readDailyRefreshUpdateTransaction,
} from "../operations/daily-refresh-scheduler.mjs";

const PRODUCT_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

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
      bridgeOptions: bridgeNativeHarness().options,
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
          version: PRODUCT_VERSION,
          vector_writer_protocol: "lease-v1",
          vector_drain_mode: mode,
        });
      }
      assert.equal(path, "/api/admin/brain/documents");
      return response(readyDocumentsReceipt(PRODUCT_VERSION, mode));
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
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, PRODUCT_VERSION,
      "the schedule failure happened after the real upgrade stages committed");
  });
});

test("unavailable native schedule inspection does not abort a verified Brain update", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    let inspectionCalls = 0;
    harness.adapter.read = () => {
      inspectionCalls += 1;
      const error = new Error("the Windows daily refresh task could not be inspected");
      error.code = "DAILY_REFRESH_INSPECTION_UNKNOWN";
      throw error;
    };

    await cmdUpdate(manifestPath, harness.options);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, PRODUCT_VERSION,
      "the real update path reached its committed version decision");
    assert.equal(inspectionCalls, 1, "the attention arm reached native schedule inspection exactly once");
    assert.ok(harness.events.includes("deploy:paused"), "the update crossed its first deployment decision");
    assert.equal(harness.events.includes("schedule:false"), false,
      "an unknown native schedule was neither assumed present nor mutated");
    assert.equal(harness.finish.length, 1);
    assert.match(harness.finish[0], /Daily imports.*need attention/i);
  });
});


const BRIDGE_NAME = String.raw`\Financial Brain\daily-refresh-0123456789abcdef`;
const BRIDGE_SID = "S-1-5-21-100-200-300-1001";
const BRIDGE_TIME = "2026-10-07T15:00:00.000Z";

function bridgeNativeHarness({ tasks = [], failDisable = false, ignoreDisable = false, onDisable = () => {}, onDelete = () => {}, failRestore = false, failDelete = false } = {}) {
  const calls = [];
  const rows = new Map(tasks.map((entry) => [entry.name || BRIDGE_NAME, {
    sid: BRIDGE_SID, enabled: true, action: "brain load fixture.json --only google_drive", ...entry,
  }]));
  const options = {
    environment: { SystemRoot: String.raw`C:\Windows`, PRIVATE_SENTINEL: "must-not-inherit" },
    now: () => new Date(BRIDGE_TIME),
    spawn: (command, args, child) => {
      assert.equal(child.env.PRIVATE_SENTINEL, undefined);
      assert.equal(child.env.PATH, undefined);
      calls.push({ command, args });
      if (command.endsWith("whoami.exe")) {
        assert.equal(command, String.raw`C:\Windows\System32\whoami.exe`);
        assert.deepEqual(args, ["/user", "/fo", "csv", "/nh"]);
        return { status: 0, stdout: `"fixture\\owner","${BRIDGE_SID}"\r\n` };
      }
      assert.equal(command, String.raw`C:\Windows\System32\schtasks.exe`);
      if (args.includes("/FO")) {
        return { status: 0, stdout: [...rows.keys(), String.raw`\Unrelated\Control`]
          .map((name) => `"${name}","N/A","Ready"`).join("\r\n") };
      }
      const name = args[args.indexOf("/TN") + 1];
      const row = rows.get(name);
      if (args[0] === "/Query") {
        return row ? { status: 0, stdout: `<Task><Principals><Principal id="Owner"><UserId>${row.sid}</UserId></Principal></Principals><Settings><Enabled>${row.enabled}</Enabled></Settings><Actions><Exec><Command>powershell.exe</Command><Arguments>-EncodedCommand ${Buffer.from(row.action, "utf16le").toString("base64")}</Arguments></Exec></Actions></Task>` }
          : { status: 1, stdout: "" };
      }
      assert.ok(row, "mutation addresses an inventoried task");
      if (args[0] === "/Change") {
        if (args.includes("/DISABLE")) {
          onDisable();
          if (failDisable) return { status: 1 };
          if (!ignoreDisable) row.enabled = false;
        } else {
          if (failRestore) return { status: 1 };
          row.enabled = true;
        }
        return { status: 0 };
      }
      if (args[0] === "/Delete") {
        onDelete();
        if (failDelete) return { status: 1 };
        rows.delete(name); return { status: 0 };
      }
      assert.fail("unexpected native operation");
    },
  };
  return { calls, rows, options, mutations: () => calls.filter(({ args }) => ["/Change", "/Delete"].includes(args[0])) };
}

function attachBridge(harness, manifestPath, fixture = {}) {
  const native = bridgeNativeHarness({
    ...fixture,
    onDelete: () => {
      assert.equal(harness.state().enabled, true, "permanent task is enabled before bridge deletion");
      assert.ok(harness.events.includes("health:active-final"), "final health precedes bridge deletion");
      assert.ok(harness.events.includes("schedule:true"), "permanent schedule readback precedes deletion");
    },
    onDisable: () => {
      const receipt = readDailyRefreshUpdateTransaction(harness.plan.identity, {
        home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
      });
      assert.ok(receipt.bridge_snapshots.some((entry) => entry.task_name === BRIDGE_NAME),
        "durable bridge intent exists before disable");
      harness.events.push("bridge:disable");
    },
  });
  harness.options.dailyRefreshOptions.bridgeOptions = native.options;
  return native;
}

function bridgeArchive(manifestPath) {
  const root = join(dirname(manifestPath), ".brain", "daily-update-transactions", "history");
  const names = readdirSync(root);
  assert.equal(names.length, 1);
  return JSON.parse(readFileSync(join(root, names[0]), "utf8"));
}

test("Windows bridge is journaled, disabled before update, and deleted only after permanent readback", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    await cmdUpdate(manifestPath, harness.options);
    assert.ok(harness.events.indexOf("bridge:disable") >= 0);
    assert.ok(harness.events.indexOf("bridge:disable") < harness.events.indexOf("deploy:paused"));
    assert.equal(native.rows.size, 0);
    assert.equal(native.mutations().filter(({ args }) => args[0] === "/Delete").length, 1);
    assert.equal(harness.state().enabled, true, "permanent task passed native readback");
    const receipt = bridgeArchive(manifestPath).bridge_snapshots[0];
    assert.equal(Object.hasOwn(receipt, "definition_hash"), false, "bridge ownership does not depend on a recomputed hash");
    assert.equal(Object.hasOwn(receipt, "definition"), false, "raw task actions remain outside the durable journal");
    assert.equal(receipt.prior_enabled, true);
    assert.equal(receipt.recorded_at, BRIDGE_TIME);
    assert.equal(receipt.action_mentions_brain, true);
    assert.equal(receipt.action_mentions_load, true);
    assert.equal(receipt.state, "retired");
  });
});

test("Windows bridge stays disabled with owner guidance when permanent daily imports are off", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    harness.plan.enabled = false;
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    await cmdUpdate(manifestPath, harness.options);
    assert.ok(harness.events.includes("deploy:active"), "the off arm reached successful update");
    assert.ok(native.calls.some(({ args }) => args.includes("/DISABLE")));
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    assert.equal(native.mutations().some(({ args }) => args[0] === "/Delete"), false);
    assert.match(harness.finish[0], /old.*task.*paused/i);
    assert.ok(harness.finish[0].includes(renderCliCommands("brain daily on <manifest>")));
    assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "paused");
  });
});

test("Windows update failure restores only the bridge tasks it disabled", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { failStage: () => "migration" });
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture migration failure/);
    assert.ok(harness.events.includes("migration"), "failure reached the update mutation");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE", "/ENABLE"]);
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
    const receipt = readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    });
    assert.equal(receipt.bridge_snapshots[0].state, "restored");
  });
});

for (const fault of ["failDisable", "ignoreDisable"]) {
  test(`Windows bridge ${fault} refuses update before deployment`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const native = attachBridge(harness, manifestPath, { tasks: [{}], [fault]: true });
      await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler.*retry.*update/i);
      assert.ok(native.calls.some(({ args }) => args.includes("/DISABLE")), "refusal reached disable");
      assert.equal(harness.events.includes("deploy:paused"), false);
      assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
      assert.equal(native.mutations().some(({ args }) => args[0] === "/Delete"), false);
    });
  });
}

test("Windows foreign-user and nonmatching tasks stay untouched; no-bridge control still updates", async () => {
  for (const tasks of [[{ sid: "S-1-5-21-100-200-300-1002" }, { name: String.raw`\Financial Brain\daily-refresh-other` }], []]) {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const native = attachBridge(harness, manifestPath, { tasks });
      await cmdUpdate(manifestPath, harness.options);
      assert.ok(native.calls.some(({ args }) => args.includes("/FO")), "inventory decision was reached");
      assert.equal(native.mutations().length, 0);
      assert.ok(harness.events.includes("deploy:active"), "the green control completed update");
      assert.equal(native.rows.size, tasks.length);
    });
  }
});


test("Windows older manifest without a permanent task keeps the paused bridge and permits daily on later", async () => {
  await withFixture(async ({ manifestPath }) => {
    const manifest = manifestFixture();
    delete manifest.operations;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const harness = productionHarness(manifestPath);
    harness.adapter.read = () => null;
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    await cmdUpdate(manifestPath, harness.options);
    assert.ok(harness.events.includes("deploy:active"));
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    assert.equal(native.mutations().length, 1);
    assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    }), null, "completion removes the fence that would block a later daily on");
    assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "paused");
    assert.ok(harness.finish[0].includes(renderCliCommands("brain daily on <manifest>")));
  });
});

test("Windows pre-disabled bridge is never enabled or deleted, and action recognition is diagnostic only", async () => {
  for (const action of ["brain load fixture.json", "opaque fixture runner"]) {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const otherName = String.raw`\Financial Brain\daily-refresh-fedcba9876543210`;
      const native = attachBridge(harness, manifestPath, { tasks: [{ action }, { name: otherName, enabled: false }] });
      await cmdUpdate(manifestPath, harness.options);
      assert.equal(native.rows.get(otherName).enabled, false);
      assert.equal(native.rows.has(BRIDGE_NAME), false, "the enabled green control was replaced");
      assert.ok(native.mutations().every(({ args }) => args[args.indexOf("/TN") + 1] === BRIDGE_NAME));
      const receipts = bridgeArchive(manifestPath).bridge_snapshots;
      assert.equal(receipts.find((entry) => entry.task_name === otherName).state, "observed");
      assert.equal(receipts.find((entry) => entry.task_name === BRIDGE_NAME).action_mentions_load, action.includes("load"));
    });
  }
});

test("Windows failed update retries from durable restored bridge receipts", async () => {
  await withFixture(async ({ manifestPath }) => {
    let fail = true;
    const harness = productionHarness(manifestPath, { failStage: () => fail ? "migration" : null });
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture migration failure/);
    assert.ok(harness.events.includes("migration"));
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
    fail = false;
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(native.rows.has(BRIDGE_NAME), false, "healthy retry is the restore control");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE", "/ENABLE", "/DISABLE", BRIDGE_NAME]);
    assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "retired");
  });
});

test("Windows restore failure remains journaled and never claims a successful update", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { failStage: () => "migration" });
    const native = attachBridge(harness, manifestPath, { tasks: [{}], failRestore: true });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Restore the old daily task in Task Scheduler/);
    assert.ok(native.calls.some(({ args }) => args.includes("/ENABLE")), "restore decision reached native mutation");
    assert.equal(harness.finish.length, 0);
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    const receipt = readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    });
    assert.equal(receipt.bridge_snapshots[0].state, "paused");
  });
});

test("Windows deletion failure keeps bridge disabled and recovers on the next verified update", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}], failDelete: true });
    await cmdUpdate(manifestPath, harness.options);
    assert.ok(native.calls.some(({ args }) => args[0] === "/Delete"), "retirement decision reached native mutation");
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    assert.match(harness.finish[0], /Daily imports need attention/);
    const healthy = attachBridge(harness, manifestPath, { tasks: [{ enabled: false }] });
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(healthy.rows.size, 0, "retry retires only the recorded bridge");
    assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "retired");
  });
});

test("Windows bridge inventory failure is a refusal before deployment with no task mutations", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    const run = native.options.spawn;
    let inventories = 0;
    native.options.spawn = (command, args, child) => {
      if (args.includes("/FO")) { inventories += 1; return { status: 1 }; }
      return run(command, args, child);
    };
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler.*retry.*update/);
    assert.equal(inventories, 1);
    assert.equal(harness.events.includes("deploy:paused"), false);
    assert.equal(native.mutations().length, 0);
  });
});

test("Windows bridge replacement after update is never deleted or re-enabled", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    const restore = harness.adapter.setEnabled;
    let replacements = 0;
    harness.adapter.setEnabled = (identity, enabled) => {
      restore(identity, enabled);
      if (enabled) {
        replacements += 1;
        native.rows.get(BRIDGE_NAME).action = "replacement fixture action";
      }
    };
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(replacements, 1, "the replacement reached the retirement boundary");
    assert.equal(native.rows.get(BRIDGE_NAME).action, "replacement fixture action");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE"]);
    assert.match(harness.finish[0], /Daily imports need attention/);
  });
});

test("Windows partial bridge pause failure restores the first task and never changes the refused second task", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const second = String.raw`\Financial Brain\daily-refresh-fedcba9876543210`;
    const native = attachBridge(harness, manifestPath, { tasks: [{}, { name: second }] });
    const run = native.options.spawn;
    let refused = 0;
    native.options.spawn = (command, args, child) => {
      if (args.includes(second) && args.includes("/DISABLE")) { refused += 1; return { status: 1 }; }
      return run(command, args, child);
    };
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler.*retry.*update/);
    assert.equal(refused, 1, "second pause reached its failure decision");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE", "/ENABLE"]);
    assert.ok([...native.rows.values()].every((row) => row.enabled));
    assert.equal(harness.events.includes("deploy:paused"), false);
  });
});

test("Windows bridge paused by another actor before our disable decision is never adopted for deletion", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    const run = native.options.spawn;
    let queries = 0;
    native.options.spawn = (command, args, child) => {
      if (args.includes("/XML") && ++queries === 2) native.rows.get(BRIDGE_NAME).enabled = false;
      return run(command, args, child);
    };
    await cmdUpdate(manifestPath, harness.options);
    assert.ok(queries >= 2, "the concurrent pause reached our final ownership read");
    assert.equal(native.mutations().length, 0, "update must not delete a task it did not disable");
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    assert.ok(harness.events.includes("deploy:active"), "the already-disabled control permits update");
  });
});

test("Windows foreign principal needs no bridge execution schema, while an owned task needs readable enabled state", async () => {
  for (const owned of [false, true]) {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const native = attachBridge(harness, manifestPath, {
        tasks: [{ sid: owned ? BRIDGE_SID : "S-1-5-21-100-200-300-1002" }],
      });
      const run = native.options.spawn;
      let observations = 0;
      native.options.spawn = (command, args, child) => {
        const result = run(command, args, child);
        if (args.includes("/XML")) {
          observations += 1;
          return { ...result, stdout: result.stdout.replace(/<Settings>[\s\S]*?<\/Settings>/u, "") };
        }
        return result;
      };
      if (owned) {
        await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler.*retry.*update/);
        assert.equal(harness.events.includes("deploy:paused"), false);
      } else {
        await cmdUpdate(manifestPath, harness.options);
        assert.ok(harness.events.includes("deploy:active"), "foreign-task control still updates");
      }
      assert.equal(observations, 1, "both arms reached principal and state inspection");
      assert.equal(native.mutations().length, 0);
    });
  }
});
