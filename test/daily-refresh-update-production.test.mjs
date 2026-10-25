import { createUpgradeBookmarkWriter } from "./fixtures/upgrade-bookmark-writer.mjs";
import assert from "node:assert/strict";
import { createHash as boundaryHash } from "node:crypto";
import { createWindowsUpdateBridgeGuard as boundaryGuard } from "../operations/windows-update-bridge.mjs";
import fs, { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { cmdDaily, cmdDrain, cmdHealth, cmdRollback, cmdUpdate } from "../brain.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import {
  buildDailyRefreshDefinition,
  clearDailyRefreshUpdateTransaction,
  dailyRefreshUpdateTransactionPath,
  readDailyRefreshUpdateTransaction,
  writeDailyRefreshUpdateTransaction,
} from "../operations/daily-refresh-scheduler.mjs";
import { clearBrainRecoveryFence, readBrainRecoveryFence } from "../operations/brain-lifecycle-lock.mjs";

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
    remove: () => {
      events.push("schedule:remove");
      state = { exists: false, owned: true, enabled: false, definition: null };
    },
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
  const bookmarkWriter = createUpgradeBookmarkWriter();
  const upgradeOptions = {
    saveUpgradeBookmark: bookmarkWriter.saveUpgradeBookmark,
    resolveAccount: async () => ({ id: "1".repeat(32) }),
    d1Query: async (_account, _database, sql, params = []) => {
      if (sql === "ALTER TABLE fixture_records ADD COLUMN migrated INTEGER") {
        events.push("migration:statement-dispatched");
        if (failStage() === "migration") throw new Error("fixture migration failure");
        return { results: [] };
      }
      if (/sqlite_master/iu.test(sql)) return { results: [{ name: "install_state" }] };
      if (/SELECT \* FROM install_state/iu.test(sql)) {
        events.push("install-state-preflight");
        if (failStage() === "preflight") throw new Error("fixture preflight refusal");
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
      if (failStage() === `deploy:${stage}`) throw new Error(`fixture ${stage} deployment failure`);
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
      await upgradeOptions.d1Query("1".repeat(32), "11111111-2222-4333-8444-555555555555",
        "ALTER TABLE fixture_records ADD COLUMN migrated INTEGER");
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
    bookmarkWriter,
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
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-production-update-")));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifestFixture(), null, 2)}\n`);
  try {
    return await run({ directory, manifestPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedUpdateReceipt(harness, manifestPath, state, inputOverrides = {}) {
  // Receipt recovery exercises the real lifecycle lock, with native ACL work
  // injected separately so the fixture is independent of the test user's SID.
  harness.options.lifecycleLockOptions.restrictWindowsDirectory = () => {};
  const options = {
    home: dirname(manifestPath), manifestPath, platform: harness.options.dailyRefreshOptions.platform, machineLockRoot: harness.machineLockRoot,
  };
  const input = {
    plan: harness.plan,
    snapshot: { ...harness.state(), identity: harness.plan.identity },
    phase: "paused",
    remoteMutationMayHaveStarted: true,
    ...inputOverrides,
  };
  let receipt = null;
  if (state !== "absent") {
    receipt = writeDailyRefreshUpdateTransaction(input, { ...options, expectedPredecessor: null });
    if (state === "fenceless") {
      assert.equal(clearBrainRecoveryFence({ ...options, transactionId: receipt.transaction_id }), true);
      assert.equal(readBrainRecoveryFence(options), null);
    }
  }
  return { input, options, receipt };
}

for (const state of ["absent", "fenced", "fenceless"]) {
  test(`production daily receipt ${state} permits two verified updates`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const { options, receipt } = seedUpdateReceipt(harness, manifestPath, state);
      const deploy = harness.options.upgradeOptions.cmdDeploy;
      let dispatchChecks = 0;
      harness.options.upgradeOptions.cmdDeploy = async (...args) => {
        const active = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
        const fence = readBrainRecoveryFence(options);
        assert.equal(active.fenceless, false, "a current fence exists before deployment");
        assert.equal(fence.transaction_id, active.transaction_id);
        const locks = readdirSync(harness.machineLockRoot).filter(name => /^brain-lifecycle-.*\.lock$/u.test(name));
        assert.equal(locks.length, 1, "the update lifecycle lock encloses receipt and fence creation");
        const ownerPath = readdirSync(join(harness.machineLockRoot, locks[0])).find(name => /^owner-/u.test(name));
        assert.equal(JSON.parse(readFileSync(join(harness.machineLockRoot, locks[0], ownerPath), "utf8")).operation, "update");
        if (dispatchChecks === 0 && receipt) {
          assert.equal(active.transaction_id === receipt.transaction_id, state === "fenced",
            "only a fenced receipt continues the previous transaction");
        }
        dispatchChecks++;
        return deploy(...args);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        await cmdUpdate(manifestPath, harness.options);
        assert.equal(harness.state().enabled, true);
        assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, options), null,
          "a completed update removes the exact receipt it published");
        assert.equal(readBrainRecoveryFence(options), null);
        assert.equal(harness.finish.length, attempt + 1);
      }
      assert.ok(harness.events.includes("health:active-final"));
      assert.ok(dispatchChecks >= 2, "both verified updates reached the fenced dispatch boundary");
    });
  });
}

for (const state of ["absent", "fenceless"]) {
  test(`production daily receipt ${state} without managed schedules completes recovery`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.operations.daily_refresh;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const harness = productionHarness(manifestPath);
      harness.adapter.remove();
      const { options } = seedUpdateReceipt(harness, manifestPath, state);
      await cmdUpdate(manifestPath, harness.options);
      assert.equal(harness.state().exists, false, "an obsolete receipt must not authorize creating a task");
      assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, options), null);
      assert.equal(readBrainRecoveryFence(options), null);
      assert.equal(harness.finish.length, 1);
    });
  });
}

for (const bridgeEvidence of [false, true]) {
  test(`fenceless receipt archives prior bridge evidence: ${bridgeEvidence ? "retained evidence" : "no bridge control"}`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const { options, receipt } = seedUpdateReceipt(harness, manifestPath, "fenceless", {
        bridgeSnapshots: bridgeEvidence ? [{ id: "synthetic-retired-bridge", state: "retired", prior_enabled: false }] : [],
      });
      const priorPath = dailyRefreshUpdateTransactionPath(harness.plan.identity, options);
      const priorBytes = readFileSync(priorPath);
      await cmdUpdate(manifestPath, harness.options);
      const historyPath = join(dirname(priorPath), "history", `${receipt.transaction_id}.json`);
      if (bridgeEvidence) assert.deepEqual(readFileSync(historyPath), priorBytes,
        "old bridge evidence survives exact fresh replacement without supplying schedule authority");
      else assert.throws(() => lstatSync(historyPath), { code: "ENOENT" });
      assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, options), null);
      assert.equal(harness.state().enabled, true);
    });
  });
}

for (const operation of ["fresh replacement", "clear"]) {
  for (const mode of ["control", "corrupt bytes", "replace inode"]) {
    test(`fenceless receipt archive readback ${operation}: ${mode}`, async () => {
      await withFixture(async ({ manifestPath }) => {
        const harness = productionHarness(manifestPath);
        const { options, input, receipt } = seedUpdateReceipt(harness, manifestPath, "fenceless", {
          bridgeSnapshots: [{ id: "synthetic-retired-bridge", state: "retired", prior_enabled: false }],
        });
        const priorPath = dailyRefreshUpdateTransactionPath(harness.plan.identity, options);
        const priorBytes = readFileSync(priorPath), priorIdentity = lstatSync(priorPath, { bigint: true });
        const expected = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
        const archive = join(dirname(priorPath), "history", `${receipt.transaction_id}.json`);
        const nativeRename = fs.renameSync;
        let published = false, archiveIdentity, archiveBytes;
        fs.renameSync = (from, to) => {
          const result = nativeRename(from, to);
          if (to === archive) {
            published = true;
            if (mode === "corrupt bytes") {
              const corrupted = Buffer.from(priorBytes);
              corrupted[0] ^= 1;
              writeFileSync(archive, corrupted);
            } else if (mode === "replace inode") {
              nativeRename(archive, `${archive}.displaced`);
              writeFileSync(archive, priorBytes, { flag: "wx", mode: 0o600 });
            }
            archiveIdentity = lstatSync(archive, { bigint: true });
            archiveBytes = readFileSync(archive);
          }
          return result;
        };
        syncBuiltinESMExports();
        const run = () => operation === "clear"
          ? clearDailyRefreshUpdateTransaction(harness.plan.identity, { ...options, expected })
          : writeDailyRefreshUpdateTransaction(input, { ...options, expectedPredecessor: expected });
        try {
          if (mode === "control") run();
          else assert.throws(run, /daily update history is unsafe/);
        } finally {
          fs.renameSync = nativeRename;
          syncBuiltinESMExports();
        }
        assert.equal(published, true, "the test reaches publication before injecting the archive fault");
        if (mode === "control") {
          assert.deepEqual(readFileSync(archive), priorBytes);
          if (operation === "clear") assert.throws(() => lstatSync(priorPath), { code: "ENOENT" });
          else assert.notEqual(readDailyRefreshUpdateTransaction(harness.plan.identity, options).transaction_id, receipt.transaction_id);
        } else {
          assert.equal(lstatSync(priorPath, { bigint: true }).ino, priorIdentity.ino);
          assert.deepEqual(readFileSync(priorPath), priorBytes,
            "unverified archive publication must preserve the active recovery evidence");
          assert.equal(lstatSync(archive, { bigint: true }).ino, archiveIdentity.ino);
          assert.deepEqual(readFileSync(archive), archiveBytes, "refusal must not remove a foreign or modified archive");
          assert.equal(readBrainRecoveryFence(options), null);
        }
      });
    });
  }
}

for (const explicitProof of [false, true]) {
  test(`fenceless receipt direct writer ${explicitProof ? "uses exact custody for current authority" : "refuses missing predecessor proof"}`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const { options, input, receipt } = seedUpdateReceipt(harness, manifestPath, "fenceless");
      const path = dailyRefreshUpdateTransactionPath(harness.plan.identity, options);
      const prior = lstatSync(path, { bigint: true }), bytes = readFileSync(path);
      const expected = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
      const currentDefinition = buildDailyRefreshDefinition({ ...harness.plan, cron: "30 10 * * *" }, harness.options.dailyRefreshOptions.schedulerOptions);
      const currentInput = { ...input, snapshot: { ...input.snapshot, definition: currentDefinition } };
      const write = () => writeDailyRefreshUpdateTransaction(currentInput, {
        ...options, ...(explicitProof ? { expectedPredecessor: expected } : {}),
      });
      if (explicitProof) {
        const current = write();
        assert.notEqual(current.transaction_id, receipt.transaction_id);
        assert.deepEqual(current.authorized_definition, currentDefinition);
      } else {
        assert.throws(write, /daily update transaction receipt is unsafe/);
        assert.equal(lstatSync(path, { bigint: true }).ino, prior.ino);
        assert.deepEqual(readFileSync(path), bytes);
        assert.equal(readBrainRecoveryFence(options), null);
      }
    });
  });
}

for (const refusePublication of [false, true]) {
  test(`fenceless receipt fresh publication ${refusePublication ? "refusal preserves predecessor" : "healthy control"}`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const { options, input, receipt } = seedUpdateReceipt(harness, manifestPath, "fenceless");
      const path = dailyRefreshUpdateTransactionPath(harness.plan.identity, options);
      const prior = lstatSync(path, { bigint: true }), bytes = readFileSync(path);
      const expected = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
      const nativeRename = fs.renameSync;
      let reached = false;
      fs.renameSync = (from, to) => {
        if (to === path && from.startsWith(`${path}.tmp-`)) {
          reached = true;
          if (refusePublication) throw Object.assign(new Error("fixture receipt publication refusal"), { code: "EIO" });
        }
        return nativeRename(from, to);
      };
      syncBuiltinESMExports();
      const write = () => writeDailyRefreshUpdateTransaction(input, { ...options, expectedPredecessor: expected });
      try {
        if (refusePublication) assert.throws(write, /fixture receipt publication refusal/);
        else assert.notEqual(write().transaction_id, receipt.transaction_id);
      } finally {
        fs.renameSync = nativeRename;
        syncBuiltinESMExports();
      }
      assert.equal(reached, true);
      if (refusePublication) {
        assert.equal(lstatSync(path, { bigint: true }).ino, prior.ino);
        assert.deepEqual(readFileSync(path), bytes);
        assert.equal(readBrainRecoveryFence(options), null);
      }
    });
  });
}

for (const state of ["fenced", "fenceless"]) {
  test(`production daily receipt ${state} refuses a replacement after read`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const { input, options } = seedUpdateReceipt(harness, manifestPath, state);
      const expected = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
      assert.ok(expected, "an existing receipt keeps its exact predecessor proof without requiring a fence");
      const path = dailyRefreshUpdateTransactionPath(harness.plan.identity, options);
      const bytes = readFileSync(path);
      renameSync(path, `${path}.displaced`);
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      const replacement = lstatSync(path, { bigint: true });
      assert.throws(() => writeDailyRefreshUpdateTransaction(input, {
        ...options, expectedPredecessor: expected,
      }), /the daily update transaction receipt is unsafe/);
      assert.throws(() => clearDailyRefreshUpdateTransaction(harness.plan.identity, {
        ...options, expected,
      }), /the daily update transaction receipt is unsafe/);
      assert.equal(lstatSync(path, { bigint: true }).ino, replacement.ino);
      assert.deepEqual(readFileSync(path), bytes, "the foreign content-equal receipt survives refusal");
    });
  });
}

for (const platform of ["win32", "darwin"]) {
  for (const change of ["unchanged", "removed", "newer definition"]) {
    test(`fenceless daily receipt ${platform} preserves the current ${change} schedule after update refusal`, async () => {
      await withFixture(async ({ manifestPath }) => {
        const harness = productionHarness(manifestPath, { failStage: () => "preflight" });
        const dailyOptions = harness.options.dailyRefreshOptions;
        dailyOptions.platform = platform;
        dailyOptions.driveScheduler = { statusDriveScheduler: () => ({ installed: false }) };
        harness.plan.platform = platform;
        if (platform === "darwin") {
          Object.assign(dailyOptions.schedulerOptions, {
            platform, nodePath: "/runtime/node", brainPath: "/runtime/brain.mjs",
            runnerPath: "/runtime/daily-refresh-run.mjs",
          });
          harness.adapter.install(buildDailyRefreshDefinition(harness.plan, dailyOptions.schedulerOptions));
        }
        const { options } = seedUpdateReceipt(harness, manifestPath, "fenceless", {
          remoteMutationMayHaveStarted: false,
        });
        const dailyCommandOptions = {
          ...dailyOptions,
          lifecycleLockOptions: harness.options.lifecycleLockOptions,
          quiet: true,
          readSourceInventory: async () => ({ sources: [] }),
          writeManifestAtomically: (path, manifest) => writeFileSync(path, `${JSON.stringify(manifest)}\n`),
        };
        if (change === "removed") {
          await cmdDaily(["off", manifestPath], dailyCommandOptions);
          harness.plan.enabled = false;
        } else if (change === "newer definition") {
          harness.plan.cron = "30 10 * * *";
          await cmdDaily(["on", manifestPath], dailyCommandOptions);
        }
        const current = structuredClone(harness.state());
        harness.events.length = 0;
        await assert.rejects(cmdUpdate(manifestPath, harness.options), /fixture preflight refusal/);
        assert.deepEqual(harness.state(), current,
          "refusal restores only the schedule observed after the owner's latest daily command");
        assert.ok(harness.events.includes("install-state-preflight"), "the update reached its pre-dispatch refusal");
        assert.equal(harness.events.includes("schedule:install"), false,
          "neither a removed task nor an older saved definition may be installed during refusal");
        assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, options), null,
          "the obsolete receipt is retired and the fresh pre-dispatch transaction clears");
        assert.equal(readBrainRecoveryFence(options), null);
      });
    });
  }
}

for (const remoteMutationMayHaveStarted of [false, true]) {
  test(`fenceless receipt preserves remote mutation uncertainty ${remoteMutationMayHaveStarted} with a fresh current snapshot`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath, { failStage: () => "preflight" });
      const { options, receipt } = seedUpdateReceipt(harness, manifestPath, "fenceless", { remoteMutationMayHaveStarted });
      harness.plan.cron = "30 10 * * *";
      await cmdDaily(["on", manifestPath], {
        ...harness.options.dailyRefreshOptions,
        lifecycleLockOptions: harness.options.lifecycleLockOptions,
        quiet: true, readSourceInventory: async () => ({ sources: [] }),
      });
      const current = structuredClone(harness.state());
      const query = harness.options.upgradeOptions.d1Query;
      let boundaryReached = false;
      harness.options.upgradeOptions.d1Query = async (...args) => {
        if (/SELECT \* FROM install_state/iu.test(args[2])) {
          boundaryReached = true;
          const active = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
          assert.notEqual(active.transaction_id, receipt.transaction_id);
          assert.equal(active.remote_mutation_may_have_started, remoteMutationMayHaveStarted,
            "fresh schedule authority must not erase earlier dispatch uncertainty");
          assert.deepEqual(active.snapshot.definition, current.definition);
          assert.equal(readBrainRecoveryFence(options).transaction_id, active.transaction_id);
        }
        return query(...args);
      };
      await assert.rejects(cmdUpdate(manifestPath, harness.options), /fixture preflight refusal/);
      assert.equal(boundaryReached, true);
      assert.deepEqual(harness.state().definition, current.definition);
      assert.equal(harness.state().enabled, !remoteMutationMayHaveStarted);
      const remaining = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
      if (remoteMutationMayHaveStarted) {
        assert.equal(remaining.remote_mutation_may_have_started, true);
        assert.equal(remaining.fenceless, false);
      } else assert.equal(remaining, null);
    });
  });
}

for (const refuseCapture of [false, true]) {
  test(`fenceless receipt survives before fresh publication: ${refuseCapture ? "snapshot refusal" : "healthy control"}`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const dailyOptions = harness.options.dailyRefreshOptions;
      dailyOptions.platform = harness.plan.platform = "darwin";
      Object.assign(dailyOptions.schedulerOptions, {
        platform: "darwin", nodePath: "/runtime/node", brainPath: "/runtime/brain.mjs",
        runnerPath: "/runtime/daily-refresh-run.mjs",
      });
      harness.adapter.install(buildDailyRefreshDefinition(harness.plan, dailyOptions.schedulerOptions));
      dailyOptions.driveScheduler = { statusDriveScheduler: () => {
        if (refuseCapture) throw new Error("fixture current snapshot refusal");
        return { installed: false };
      } };
      const { options } = seedUpdateReceipt(harness, manifestPath, "fenceless", { remoteMutationMayHaveStarted: true });
      const path = dailyRefreshUpdateTransactionPath(harness.plan.identity, options);
      const prior = lstatSync(path, { bigint: true }), bytes = readFileSync(path);
      if (refuseCapture) {
        await assert.rejects(cmdUpdate(manifestPath, harness.options), /fixture current snapshot refusal/);
        assert.equal(lstatSync(path, { bigint: true }).ino, prior.ino);
        assert.deepEqual(readFileSync(path), bytes, "unpublished fresh state must leave all old uncertainty evidence intact");
        assert.equal(readBrainRecoveryFence(options), null);
      } else {
        await cmdUpdate(manifestPath, harness.options);
        assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, options), null);
        assert.equal(harness.state().enabled, true);
      }
    });
  });
}

for (const remoteMutationMayHaveStarted of [false, true]) {
  test(`fenceless receipt keeps uncertainty ${remoteMutationMayHaveStarted} when a current legacy pause fails`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const dailyOptions = harness.options.dailyRefreshOptions;
      dailyOptions.platform = harness.plan.platform = "darwin";
      Object.assign(dailyOptions.schedulerOptions, {
        platform: "darwin", nodePath: "/runtime/node", brainPath: "/runtime/brain.mjs",
        runnerPath: "/runtime/daily-refresh-run.mjs",
      });
      harness.adapter.install(buildDailyRefreshDefinition(harness.plan, dailyOptions.schedulerOptions));
      const plistPath = join(dirname(manifestPath), "synthetic-legacy.plist");
      writeFileSync(plistPath, "synthetic legacy definition\n");
      dailyOptions.driveScheduler = {
        statusDriveScheduler: () => ({ installed: true, definitionMatches: true, loaded: true, plistPath, service: "synthetic-legacy" }),
        pauseDriveScheduler: () => { throw new Error("fixture legacy pause refusal"); },
        restoreDriveScheduler: () => {},
      };
      const { options } = seedUpdateReceipt(harness, manifestPath, "fenceless", { remoteMutationMayHaveStarted });
      const current = structuredClone(harness.state());
      await assert.rejects(cmdUpdate(manifestPath, harness.options), /fixture legacy pause refusal/);
      assert.deepEqual(harness.state().definition, current.definition);
      assert.equal(harness.state().enabled, !remoteMutationMayHaveStarted);
      const remaining = readDailyRefreshUpdateTransaction(harness.plan.identity, options);
      if (remoteMutationMayHaveStarted) {
        assert.equal(remaining.remote_mutation_may_have_started, true);
        assert.equal(remaining.fenceless, false);
      } else assert.equal(remaining, null);
    });
  });
}

for (const state of ["absent", "fenced", "fenceless"]) {
  test(`daily run with ${state} receipt makes the current recovery decision twice`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const { options } = seedUpdateReceipt(harness, manifestPath, state);
      let runs = 0;
      let freshnessReads = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runDailyRefreshCli(manifestPath, {
          ...options,
          brainModule: {},
          buildPlan: async () => harness.plan,
          acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
          runSource: async () => { runs++; return { status: "complete" }; },
          readFreshness: async () => ({ drive: {
            last_successful_run_at: new Date(Date.UTC(2026, 9, 24, 12, freshnessReads++)).toISOString(),
          } }),
          writeReceipt: () => {},
          appendObservation: () => {},
          silent: true,
        });
        assert.equal(result.status, state === "fenced" ? "deferred" : "complete");
      }
      assert.equal(runs, state === "fenced" ? 0 : 2);
      if (state !== "absent") {
        assert.equal(readDailyRefreshUpdateTransaction(harness.plan.identity, options).fenceless === true,
          state === "fenceless", "the read result identifies missing fence authority without deleting evidence");
      }
    });
  });
}

test("production update proves active propagation before convergence and schedule restore", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    await cmdUpdate(manifestPath, harness.options);
    harness.bookmarkWriter.assertCalled();
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

test("an update preserves the selected answer and gate models byte for byte", async () => {
  await withFixture(async ({ manifestPath }) => {
    const before = JSON.parse(readFileSync(manifestPath, "utf8"));
    before.retrieval = {
      answer_model: "claude-opus-5-5",
      gate_model: "claude-sonnet-5-5",
    };
    writeFileSync(manifestPath, `${JSON.stringify(before, null, 2)}\n`);
    const harness = productionHarness(manifestPath);
    await cmdUpdate(manifestPath, harness.options);
    const after = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(after.retrieval, before.retrieval);
    assert.ok(harness.events.includes("deploy:active"),
      "the preservation assertion follows the real update deployment decision point");
  });
});

test("a 0.4.8-era update does not opt the owner into an answer model", async () => {
  await withFixture(async ({ manifestPath }) => {
    const before = JSON.parse(readFileSync(manifestPath, "utf8"));
    before.brain.version = "0.4.8";
    delete before.retrieval;
    writeFileSync(manifestPath, `${JSON.stringify(before, null, 2)}\n`);
    const harness = productionHarness(manifestPath);
    await cmdUpdate(manifestPath, harness.options);
    const after = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(Object.hasOwn(after, "retrieval"), false);
    assert.ok(harness.events.includes("provider-reconcile"),
      "the no-opt-in assertion follows the update's provider reconciliation decision point");
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

test("production native restore failure rejects with visible daily recovery and remains recoverable", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { failRestore: true });
    await assert.rejects(cmdUpdate(manifestPath, harness.options), error => {
      assert.match(error.message, /daily imports remain paused or unverified/i);
      assert.match(error.message, /Daily recovery receipt:/);
      return true;
    });
    assert.equal(harness.state().enabled, false);
    assert.equal(harness.finish.length, 0, "incomplete update cannot print a success footer");
    assert.ok(harness.events.includes("schedule:true"), "the native restore decision was reached");
    assert.ok(readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    }));
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, PRODUCT_VERSION,
      "the schedule failure happened after the real upgrade stages committed");
  });
});

test("unavailable native schedule inspection refuses before any remote update", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    let inspectionCalls = 0;
    harness.adapter.read = () => {
      inspectionCalls += 1;
      const error = new Error("the Windows daily refresh task could not be inspected");
      error.code = "DAILY_REFRESH_INSPECTION_UNKNOWN";
      throw error;
    };
    await assert.rejects(cmdUpdate(manifestPath, harness.options), /Daily imports could not be inspected/);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, "0.4.7");
    assert.equal(inspectionCalls, 1, "the unknown-state arm reached native inspection");
    assert.equal(harness.events.includes("deploy:paused"), false);
    assert.equal(harness.events.includes("schedule:false"), false, "unknown native state was never mutated");
    assert.equal(harness.finish.length, 0);
  });
});


const BRIDGE_NAME = boundaryBridgeName("brain.example.invalid", "S-1-5-21-100-200-300-1001");
const BRIDGE_SID = "S-1-5-21-100-200-300-1001";
const BRIDGE_TIME = "2026-10-07T15:00:00.000Z";

function bridgeNativeHarness({ manifestPath = "C:\\Fixture\\brain.manifest.json", tasks = [], failDisable = false, ignoreDisable = false, onDisable = () => {}, onDelete = () => {}, failRestore = false, failDelete = false, fieldShape = false, explicitEnabled = false } = {}) {
  const calls = [];
  const rows = new Map(tasks.map((entry) => [entry.name || BRIDGE_NAME, {
    sid: BRIDGE_SID, enabled: true, action: `brain load '${manifestPath.replaceAll("'", "''")}' --only google_drive`, ...entry,
  }]));
  const options = {
    domain: "brain.example.invalid", manifestPath,
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
        if (!row) return { status: 1, stdout: "" };
        let xml = `<Task><Principals><Principal id="Owner"><UserId>${row.sid}</UserId></Principal></Principals><Settings>${!row.enabled || explicitEnabled ? `<Enabled>${row.enabled}</Enabled>` : ""}${row.extraSettings || ""}</Settings><Actions><Exec><Command>powershell.exe</Command><Arguments>-EncodedCommand ${Buffer.from(row.action, "utf16le").toString("base64")}</Arguments></Exec></Actions></Task>`;
        if (fieldShape) {
          xml = xml.replace("<Task>", `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><URI>${name}</URI></RegistrationInfo>`)
            .replace("<Settings>", "<Settings><StartWhenAvailable>true</StartWhenAvailable>")
            .replaceAll("><", ">\r\n  <");
          return { status: 0, stdout: Buffer.from(`\ufeff<?xml version="1.0" encoding="UTF-16"?>\r\n${xml}`, "utf16le") };
        }
        return { status: 0, stdout: xml };
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
    manifestPath,
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
    assert.match(receipt.definition_hash, /^sha256:[a-f0-9]{64}$/, "restart retains the exact immutable definition proof");
    assert.match(receipt.binding_hash, /^sha256:[a-f0-9]{64}$/);
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
    // The callback receives raw copy; the terminal boundary renders commands.
    for (const platform of ["darwin", "win32"]) {
      assert.ok(renderCliCommands(harness.finish[0], { platform }).includes(
        renderCliCommands("brain daily on <manifest>", { platform }),
      ));
    }
    assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "paused");
  });
});

test("Windows pre-change refusal restores only the bridge tasks it disabled", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { failStage: () => "preflight" });
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture preflight refusal/);
    assert.ok(harness.events.includes("install-state-preflight"), "refusal reached the remote read preflight");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE", "/ENABLE"]);
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
    const receipt = readDailyRefreshUpdateTransaction(harness.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
    });
    assert.equal(receipt.bridge_snapshots[0].state, "restored");
    assert.equal(receipt.remote_mutation_may_have_started, false);
    assert.equal(harness.events.includes("deploy:paused"), false);
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
    for (const platform of ["darwin", "win32"]) {
      assert.ok(renderCliCommands(harness.finish[0], { platform }).includes(
        renderCliCommands("brain daily on <manifest>", { platform }),
      ));
    }
  });
});

test("Windows pre-disabled bridge is never enabled or deleted, with an enabled control", async () => {
  for (const enabled of [false, true]) {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const native = attachBridge(harness, manifestPath, { tasks: [{ enabled }] });
      await cmdUpdate(manifestPath, harness.options);
      assert.ok(native.calls.some(({ args }) => args.includes("/XML")), "ownership decision reached");
      assert.ok(harness.events.includes("deploy:active"));
      if (enabled) {
        assert.equal(native.rows.has(BRIDGE_NAME), false, "enabled control is replaced");
        assert.equal(native.mutations().length, 2);
      } else {
        assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
        assert.equal(native.mutations().length, 0);
        assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "observed");
      }
    });
  }
});

test("Windows pre-change refusal retries from durable restored bridge receipts", async () => {
  await withFixture(async ({ manifestPath }) => {
    let fail = true;
    const harness = productionHarness(manifestPath, { failStage: () => fail ? "preflight" : null });
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture preflight refusal/);
    assert.ok(harness.events.includes("install-state-preflight"));
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
    fail = false;
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(native.rows.has(BRIDGE_NAME), false, "healthy retry is the restore control");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE", "/ENABLE", "/DISABLE", BRIDGE_NAME]);
    assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "retired");
  });
});

test("Windows pre-change restore failure remains journaled and never claims a successful update", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath, { failStage: () => "preflight" });
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
    await assert.rejects(cmdUpdate(manifestPath, harness.options), /daily.*recovery|recovery.*daily/i);
    assert.ok(native.calls.some(({ args }) => args[0] === "/Delete"), "retirement decision reached native mutation");
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    assert.equal(harness.finish.length, 0);
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
    await assert.rejects(cmdUpdate(manifestPath, harness.options), /daily.*recovery|recovery.*daily/i);
    assert.equal(replacements, 1, "the replacement reached the retirement boundary");
    assert.equal(native.rows.get(BRIDGE_NAME).action, "replacement fixture action");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE"]);
    assert.equal(harness.finish.length, 0);
  });
});

test("Windows permanent pause failure restores only this Brain's bridge", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const other = boundaryBridgeName("other.example.invalid");
    const native = attachBridge(harness, manifestPath, { tasks: [{}, { name: other, action: "other fixture runner" }] });
    let refused = 0;
    harness.adapter.setEnabled = () => { refused += 1; throw new Error("fixture permanent pause failure"); };
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture permanent pause failure/);
    assert.equal(refused, 1, "permanent pause reached its failure decision");
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE", "/ENABLE"]);
    assert.ok(native.mutations().every(({ args }) => args[args.indexOf("/TN") + 1] === BRIDGE_NAME));
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

function boundaryBridgeName(domain, sid=BRIDGE_SID) {
  const fields=['daily-refresh-v1',domain,sid];
  const payload=fields.map(value=>`${Buffer.byteLength(value,'utf8')}:${value},`).join('');
  return String.raw`\Financial Brain\daily-refresh-`+boundaryHash('sha256').update(payload,'utf8').digest('hex').slice(0,16);
}
for (const arm of ['own-control','two-brains','unbound','rollback-two-brains']) {
  test(`BOUNDARY bridge ${arm}`,async()=>withFixture(async({manifestPath})=>{
    const owner=boundaryBridgeName('brain.example.invalid');
    const other=boundaryBridgeName('other.example.invalid');
    const unbound=String.raw`\Financial Brain\daily-refresh-0000000000000000`;
    const fail=arm==='rollback-two-brains';
    const harness=productionHarness(manifestPath,{failStage:()=>fail?'migration':null});
    const tasks=[{name:owner}];
    if (arm.includes('two-brains'))tasks.push({name:other,action:'brain load other-fixture.json'});
    if (arm==='unbound')tasks.push({name:unbound,action:'unrelated fixture runner'});
    const native=bridgeNativeHarness({manifestPath,tasks});
    harness.options.dailyRefreshOptions.bridgeOptions=native.options;
    if(fail) await assert.rejects(()=>cmdUpdate(manifestPath,harness.options),/fixture migration failure/);
    else await cmdUpdate(manifestPath,harness.options);
    assert.ok(native.calls.some(({args})=>args.includes('/FO')),'native inventory decision reached');
    assert.ok(harness.events.includes('migration'),'the real update reached migration');
    const mutations=native.mutations().map(({args})=>({verb:args[0],name:args[args.indexOf('/TN')+1],enabled:args.at(-1)}));
    assert.ok(mutations.some(entry=>entry.name===owner),'own bridge green control reached native mutation');
    console.log(JSON.stringify({probe:arm,ownMutations:mutations.filter(m=>m.name===owner).length,otherMutations:mutations.filter(m=>m.name!==owner).length,remaining:native.rows.size}));
    if(fail) {
      assert.equal(native.rows.get(owner).enabled,false,'own bridge stays paused after migration failure');
      assert.deepEqual(mutations.filter(m=>m.name===owner).map(m=>m.enabled),['/DISABLE']);
    } else assert.equal(native.rows.has(owner),false,'own bridge retired after verified replacement');
    assert.equal(mutations.filter(m=>m.name!==owner).length,0,'another Brain or an unbound task must never be disabled, enabled, or deleted');
    for(const task of tasks.slice(1))assert.equal(native.rows.get(task.name)?.enabled,true);
  }));
}
test('BOUNDARY bridge changed task after restart must not inherit rollback authority',()=>{
  const native=bridgeNativeHarness({tasks:[{}]});
  const first=boundaryGuard(native.options);
  const receipts=first.capture(first.inventory());
  let writes=0;
  first.pause(receipts,()=>writes++);
  assert.equal(native.rows.get(BRIDGE_NAME).enabled,false);
  assert.ok(writes>=2 && native.mutations().length===1,'original disable and durable decision reached');
  native.rows.get(BRIDGE_NAME).action='unrelated replacement runner';
  const resumed=boundaryGuard(native.options);
  const before=native.mutations().length;
  let refused=false;
  try {
    const hydrated=resumed.capture(resumed.inventory(),JSON.parse(JSON.stringify(receipts)));
    resumed.restore(hydrated,()=>writes++);
  }catch{refused=true;}
  console.log(JSON.stringify({probe:'replacement-after-restart',restoreRefused:refused,newMutations:native.mutations().length-before}));
  assert.equal(refused,true,'changed recovery definition requires explicit repair');
  assert.equal(native.mutations().length,before,'a changed task must not be enabled using the previous definition receipt');
});

for (const arm of ["unchanged", "action", "trigger", "missing-proof", "other-brain"]) {
  for (const recovery of ["restore", "retire"]) {
    test(`bridge restart ${recovery}: ${arm}`, () => {
      const native = bridgeNativeHarness({ tasks: [{}] });
      const run = native.options.spawn;
      let triggerEnabled = true;
      let reads = 0;
      native.options.spawn = (command, args, child) => {
        const result = run(command, args, child);
        if (args.includes("/XML")) {
          reads += 1;
          result.stdout = result.stdout.replace("<Principals>", `<Triggers><CalendarTrigger><Enabled>${triggerEnabled}</Enabled></CalendarTrigger></Triggers><Principals>`);
          result.stdout = result.stdout.replace("</Settings>", "<Hidden>false</Hidden></Settings>");
        }
        return result;
      };
      const first = boundaryGuard(native.options);
      const receipts = first.capture(first.inventory());
      let persisted;
      first.pause(receipts, () => { persisted = JSON.parse(JSON.stringify(receipts)); });
      assert.equal(native.mutations().length, 1, "original verified disable reached");
      assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
      assert.equal(JSON.stringify(persisted).includes(native.rows.get(BRIDGE_NAME).action), false);
      if (arm === "action") native.rows.get(BRIDGE_NAME).action += " --changed";
      if (arm === "trigger") triggerEnabled = false;
      if (arm === "missing-proof") delete persisted[0].definition_hash;
      const resumed = boundaryGuard({ ...native.options, ...(arm === "other-brain" ? { domain: "other.example.invalid" } : {}) });
      const beforeReads = reads;
      const recover = () => {
        const hydrated = resumed.capture(resumed.inventory(), persisted);
        resumed[recovery](hydrated, () => {});
      };
      if (arm === "unchanged") {
        recover();
        assert.equal(native.mutations().length, 2, "unchanged restart green control mutates once");
        assert.equal(native.rows.has(BRIDGE_NAME), recovery !== "retire");
        if (recovery === "restore") assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
      } else {
        assert.throws(recover, /Task Scheduler/);
        assert.equal(native.mutations().length, 1, "no new mutation from stale or missing proof");
        assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
      }
      assert.ok(reads > beforeReads, "restarted native inventory decision reached");
    });
  }
}

for (const arm of ["wrong-manifest", "unrelated", "comment", "extra-command", "noncanonical-domain"]) {
  test(`bridge unbound target refuses before update: ${arm}`, async () => withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    const row = native.rows.get(BRIDGE_NAME);
    if (arm === "wrong-manifest") row.action = "brain load 'C:\\Other\\brain.manifest.json' --only google_drive";
    if (arm === "unrelated") row.action = "unrelated runner";
    if (arm === "comment") row.action = `# ${row.action}`;
    if (arm === "extra-command") row.action += "; unrelated runner";
    if (arm === "noncanonical-domain") {
      const manifest = manifestFixture();
      manifest.brain.domain = "HTTPS://BRAIN.EXAMPLE.INVALID/";
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler/);
    assert.ok(native.calls.some(({ args }) => args.includes("/FO")), "native inventory decision reached");
    assert.equal(native.mutations().length, 0);
    assert.equal(harness.events.includes("deploy:paused"), false);
    assert.equal(row.enabled, true);
  }));
}

test("bridge fingerprint excludes only the task enabled field when the trigger has identical contents", () => {
  const native = bridgeNativeHarness({ tasks: [{}] });
  const run = native.options.spawn;
  native.options.spawn = (command, args, child) => {
    const result = run(command, args, child);
    if (args.includes("/XML")) result.stdout = result.stdout.replace("<Principals>",
      "<Triggers><CalendarTrigger><Enabled>true</Enabled></CalendarTrigger></Triggers><Principals>");
    return result;
  };
  const guard = boundaryGuard(native.options);
  const receipts = guard.capture(guard.inventory());
  const original = receipts[0].definition_hash;
  let writes = 0;
  guard.pause(receipts, () => { writes += 1; });
  assert.ok(writes >= 2);
  assert.equal(native.mutations().length, 1);
  assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
  assert.equal(receipts[0].definition_hash, original);
  guard.restore(receipts, () => { writes += 1; });
  assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
});

for (const arm of ["exact-control", "directory-alias", "different-file", "missing-file"]) {
  test(`bridge manifest file identity: ${arm}`, async () => withFixture(async ({ directory, manifestPath }) => {
    const aliasDirectory = join(directory, "manifest-alias");
    symlinkSync(realpathSync.native(directory), aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    const otherDirectory = join(directory, "other");
    mkdirSync(otherDirectory);
    const otherManifest = join(otherDirectory, "brain.manifest.json");
    writeFileSync(otherManifest, readFileSync(manifestPath));
    const taskPath = arm === "directory-alias" ? join(aliasDirectory, "brain.manifest.json")
      : arm === "different-file" ? otherManifest
        : arm === "missing-file" ? join(directory, "missing", "brain.manifest.json") : realpathSync.native(manifestPath);
    if (arm === "directory-alias") {
      assert.notEqual(taskPath, realpathSync.native(manifestPath), "fixture exercises a different directory spelling");
      assert.equal(realpathSync.native(taskPath), realpathSync.native(manifestPath));
    }
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, {
      tasks: [{ action: `brain load '${taskPath.replaceAll("'", "''")}' --only google_drive` }],
    });
    if (["exact-control", "directory-alias"].includes(arm)) {
      await cmdUpdate(manifestPath, harness.options);
      assert.ok(harness.events.includes("migration"), "bound task permits the real update");
      assert.deepEqual(native.mutations().map(({ args }) => args[0]), ["/Change", "/Delete"]);
      assert.equal(native.rows.size, 0, "verified permanent task replaces the bridge");
    } else {
      await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler/);
      assert.equal(native.mutations().length, 0);
      assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
      assert.equal(harness.events.includes("deploy:paused"), false);
    }
    assert.ok(native.calls.some(({ args }) => args.includes("/XML")), "binding decision read the native action");
  }));
}

for (const arm of ["same-file", "different-file"]) {
  test(`bridge differently named manifest alias: ${arm}`, async () => withFixture(async ({ directory, manifestPath }) => {
    const targetDirectory = arm === "same-file" ? directory : join(directory, "other");
    if (arm === "different-file") {
      mkdirSync(targetDirectory);
      writeFileSync(join(targetDirectory, "brain.manifest.json"), readFileSync(manifestPath));
    }
    const aliasDirectory = join(directory, "task-alias");
    symlinkSync(realpathSync.native(targetDirectory), aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    const taskPath = join(aliasDirectory, "brain.manifest.json");
    const name = String.raw`\Financial Brain\daily-refresh-0000000000000000`;
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, {
      tasks: [{ name, action: `brain load '${taskPath.replaceAll("'", "''")}' --only google_drive` }],
    });
    assert.equal(native.rows.get(name).action.includes(realpathSync.native(manifestPath)), false,
      "fixture cannot be detected by the old manifest substring check");
    if (arm === "same-file") {
      await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler/);
      assert.equal(harness.events.includes("deploy:paused"), false);
    } else {
      await cmdUpdate(manifestPath, harness.options);
      assert.ok(harness.events.includes("migration"), "different-file control reaches update");
    }
    assert.ok(native.calls.some(({ args }) => args.includes("/XML")), "unbound-task decision read the action");
    assert.equal(native.mutations().length, 0, "a differently named task is never adopted");
    assert.equal(native.rows.get(name).enabled, true);
  }));
}

test("bridge manifest comparison resolves both paths before applying platform case semantics", async () => {
  const { sameManifestFile } = await import("../operations/windows-update-bridge.mjs");
  const taskPath = String.raw`C:\Fixture\BRAIN.manifest.json`;
  const manifestPath = String.raw`c:\fixture\brain.manifest.json`;
  for (const platform of ["win32", "darwin", "linux"]) {
    const reads = [];
    assert.equal(sameManifestFile(taskPath, manifestPath, {
      platform, realpath: (path) => { reads.push(path); return path; },
    }), platform === "win32");
    assert.deepEqual(reads, [taskPath, manifestPath], "case comparison requires both successful resolutions");
    for (const missing of [taskPath, manifestPath]) {
      const attempts = [];
      assert.equal(sameManifestFile(taskPath, manifestPath, {
        platform, realpath: (path) => {
          attempts.push(path);
          if (path === missing) throw new Error("fixture path unavailable");
          return path;
        },
      }), false, "unresolvable case-only spelling does not bind");
      assert.ok(attempts.includes(missing), "negative arm reached the failed resolution");
    }
  }
});


function bridgeTransaction(harness, manifestPath) {
  return readDailyRefreshUpdateTransaction(harness.plan.identity, {
    home: dirname(manifestPath), manifestPath, machineLockRoot: harness.machineLockRoot,
  });
}

// RR-03 reviewer probe: exercise cmdUpdate/cmdUpgrade, not a stand-in catch.
for (const failure of ["convergence", "health:active-final", "health:paused", "deploy:paused", "migration"]) {
  test(`Windows post-boundary ${failure} failure keeps the old bridge paused`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath, { failStage: () => failure });
      const native = attachBridge(harness, manifestPath, { tasks: [{}] });
      await assert.rejects(() => cmdUpdate(manifestPath, harness.options), (error) => {
        assert.match(error.message, /fixture .*failure/);
        assert.match(error.message, /daily imports stay paused until the update is retried and completes/i);
        return true;
      });
      const decision = failure === "migration" ? "migration:statement-dispatched" : failure;
      assert.ok(harness.events.includes(decision), "injected failure reached its remote decision point");
      if (failure === "convergence") {
        assert.ok(harness.events.includes("migration:statement-dispatched"));
        assert.ok(harness.events.includes("deploy:active"));
        assert.ok(harness.events.includes("health:active-cutover"));
      }
      assert.equal(harness.finish.length, 0);
      assert.equal(native.rows.get(BRIDGE_NAME).enabled, false, "old runner cannot resume against changed remote state");
      assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE"]);
      const receipt = bridgeTransaction(harness, manifestPath);
      assert.equal(receipt.bridge_snapshots[0].state, "paused");
      assert.equal(receipt.remote_mutation_may_have_started, true);
    });
  });
}

test("Windows remote mutation intent is durable before the first deployment dispatch", async () => {
  await withFixture(async ({ manifestPath }) => {
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    const deploy = harness.options.upgradeOptions.cmdDeploy;
    let deployments = 0;
    harness.options.upgradeOptions.cmdDeploy = async (...args) => {
      deployments += 1;
      const receipt = bridgeTransaction(harness, manifestPath);
      assert.equal(receipt.remote_mutation_may_have_started, true, "intent is persisted before invoking deploy");
      assert.equal(receipt.bridge_snapshots[0].state, "paused");
      return deploy(...args);
    };
    await cmdUpdate(manifestPath, harness.options);
    assert.equal(deployments, 2);
    assert.equal(native.rows.size, 0, "verified successful update is the retirement control");
    assert.equal(bridgeArchive(manifestPath).remote_mutation_may_have_started, true);
  });
});

test("Windows restart retains the mutation boundary through preflight refusal until verified retirement", async () => {
  await withFixture(async ({ manifestPath }) => {
    const first = productionHarness(manifestPath, { failStage: () => "convergence" });
    const original = attachBridge(first, manifestPath, { tasks: [{}] });
    await assert.rejects(() => cmdUpdate(manifestPath, first.options), /convergence/);
    assert.ok(first.events.includes("convergence"));
    const transaction = bridgeTransaction(first, manifestPath);
    assert.equal(transaction.remote_mutation_may_have_started, true);
    assert.equal(original.rows.get(BRIDGE_NAME).enabled, false);

    // Fresh orchestration and native adapters retain only durable receipt and task state.
    const retry = productionHarness(manifestPath, { failStage: () => "preflight" });
    const resumed = attachBridge(retry, manifestPath, { tasks: [...original.rows.values()] });
    await assert.rejects(() => cmdUpdate(manifestPath, retry.options), (error) => {
      assert.match(error.message, /fixture preflight refusal/);
      assert.match(error.message, /daily imports stay paused until the update is retried and completes/i);
      return true;
    });
    assert.ok(retry.events.includes("install-state-preflight"));
    assert.equal(retry.events.includes("deploy:paused"), false);
    assert.equal(resumed.mutations().length, 0, "restart must not reset the persisted boundary to pre-change");
    assert.equal(resumed.rows.get(BRIDGE_NAME).enabled, false);
    assert.equal(bridgeTransaction(retry, manifestPath).bridge_snapshots[0].state, "paused");
    assert.equal(bridgeTransaction(retry, manifestPath).transaction_id, transaction.transaction_id);

    const completed = productionHarness(manifestPath);
    const final = attachBridge(completed, manifestPath, { tasks: [...resumed.rows.values()] });
    await cmdUpdate(manifestPath, completed.options);
    assert.ok(completed.events.includes("health:active-final"));
    assert.equal(completed.state().enabled, true);
    assert.deepEqual(final.mutations().map(({ args }) => args[0]), ["/Delete"]);
    assert.equal(final.rows.size, 0);
    assert.equal(bridgeTransaction(completed, manifestPath), null);
    assert.equal(bridgeArchive(manifestPath).bridge_snapshots[0].state, "retired");
  });
});


for (const failure of ["disable-response", "disable-readback"]) {
  test(`Windows pre-change ${failure} failure restores an ambiguously disabled bridge`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const harness = productionHarness(manifestPath);
      const native = attachBridge(harness, manifestPath, { tasks: [{}] });
      const spawn = native.options.spawn;
      let refuseReadback = false;
      let refusals = 0;
      native.options.spawn = (command, args, child) => {
        const result = spawn(command, args, child);
        if (args.includes("/DISABLE")) {
          assert.equal(native.rows.get(BRIDGE_NAME).enabled, false, "disable took effect before the ambiguous response");
          if (failure === "disable-response") { refusals += 1; return { status: 1 }; }
          refuseReadback = true;
        } else if (args.includes("/XML") && refuseReadback) {
          refuseReadback = false;
          refusals += 1;
          return { status: 1 };
        }
        return result;
      };
      await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /Task Scheduler/);
      assert.equal(refusals, 1, "the native refusal decision was reached once");
      assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE", "/ENABLE"]);
      assert.equal(native.rows.get(BRIDGE_NAME).enabled, true);
      assert.equal(harness.events.includes("deploy:paused"), false);
      const receipt = bridgeTransaction(harness, manifestPath);
      assert.equal(receipt.remote_mutation_may_have_started, false);
      assert.equal(receipt.bridge_snapshots[0].state, "restored");
    });
  });
}

test("Windows non-outbox compatibility path records intent before invoking migration", async () => {
  await withFixture(async ({ manifestPath }) => {
    const manifest = manifestFixture();
    manifest.infrastructure.cloudflare.storage = "supabase";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const harness = productionHarness(manifestPath);
    const native = attachBridge(harness, manifestPath, { tasks: [{}] });
    let migrations = 0;
    harness.options.upgradeOptions.cmdMigrate = async () => {
      migrations += 1;
      assert.equal(bridgeTransaction(harness, manifestPath).remote_mutation_may_have_started, true);
      throw new Error("fixture migration statement failure");
    };
    await assert.rejects(() => cmdUpdate(manifestPath, harness.options), /fixture migration statement failure/);
    assert.equal(migrations, 1);
    assert.equal(harness.events.some((event) => event.startsWith("deploy:")), false, "migration is the first mutation in this path");
    assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    assert.deepEqual(native.mutations().map(({ args }) => args.at(-1)), ["/DISABLE"]);
    assert.equal(bridgeTransaction(harness, manifestPath).bridge_snapshots[0].state, "paused");
  });
});

// An opaque task under the expected bridge name binds this Brain, but has no
// installer ownership proof. Refusal must name the exact task and safe remedy.
test("unrecognized bridge refusal explains the exact task and recovery", () => {
  for (const recognized of [true, false]) {
    const native = bridgeNativeHarness({ tasks: [{ ...(recognized ? {} : { action: "Write-Output 'brain.example.invalid'" }) }] });
    const guard = boundaryGuard(native.options);
    if (recognized) assert.equal(guard.capture(guard.inventory()).length, 1, "recognized green control reaches capture");
    else assert.throws(() => guard.capture(guard.inventory()), error => {
      assert.equal(error.name, "WindowsDailyTaskRepairRequired");
      assert.ok(error.message.includes(BRIDGE_NAME));
      assert.match(error.message, /not created by the installer/i);
      assert.match(error.message, /back up.*XML.*remove only this task.*rerun the update/is);
      assert.doesNotMatch(error.message, /unexpected error|bug in the installer/i);
      return true;
    });
    assert.ok(native.calls.some(({ args }) => args.includes("/XML")), "refusal reached real native adapter observation");
    assert.equal(native.mutations().length, 0);
  }
});


for (const recovery of ["restore", "retire"]) {
  test(`FIX-2 bridge omitted Enabled survives field-shaped ${recovery} and refuses edits`, () => {
    for (const changed of [false, true]) {
      const native = bridgeNativeHarness({ tasks: [{}], fieldShape: true });
      const first = boundaryGuard(native.options);
      const inventory = first.inventory();
      assert.equal(inventory.entries.length, 1, "inventory found the bound enabled task");
      assert.equal(inventory.entries[0].enabled, true);
      const receipts = first.capture(inventory);
      first.pause(receipts, () => {});
      assert.equal(receipts[0].state, "paused");
      assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
      assert.equal(native.mutations().length, 1, "pause reached disable and readback");
      if (changed) native.rows.get(BRIDGE_NAME).extraSettings = "<Priority>4</Priority>";
      const before = native.calls.length;
      const resumed = boundaryGuard(native.options);
      const recover = () => resumed[recovery](JSON.parse(JSON.stringify(receipts)), () => {});
      if (changed) assert.throws(recover, /Task Scheduler/);
      else recover();
      assert.ok(native.calls.slice(before).some(({ args }) => args.includes("/XML")), "recovery checked the saved definition");
      assert.equal(native.mutations().length, changed ? 1 : 2, "foreign edit causes zero recovery mutations");
      if (changed) assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
      else assert.equal(native.rows.has(BRIDGE_NAME), recovery === "restore");
    }
  });
}


for (const recovery of ["restore", "retire"]) for (const transport of ["text", "console"]) {
  test(`FIX-2 bridge reads saved v1 receipts and captures only v2 (${recovery}, ${transport})`, () => {
    for (const changed of [false, true]) {
      const native = bridgeNativeHarness({ tasks: [{ extraSettings: transport === "console" ? "<Label>é</Label>" : "" }], explicitEnabled: true });
      let originalPipe;
      if (transport === "console") {
        const spawn = native.options.spawn;
        native.options.spawn = (command, args, child) => {
          if (command.endsWith("powershell.exe")) {
            native.calls.push({ command, args });
            const raw = spawn(String.raw`C:\Windows\System32\schtasks.exe`, ["/Query", "/TN", BRIDGE_NAME, "/XML"], child);
            return { status: 0, stdout: Buffer.from(`\ufeff${raw.stdout.replaceAll("><", ">\r\n  <")}`, "utf16le") };
          }
          const result = spawn(command, args, child);
          if (args.includes("/XML")) {
            originalPipe ??= result.stdout;
            return { ...result, stdout: Buffer.from(result.stdout, "utf8") };
          }
          return result;
        };
      }
      const guard = boundaryGuard(native.options);
      const inventory = guard.inventory();
      const receipts = guard.capture(inventory);
      const digest = (...fields) => `sha256:${boundaryHash("sha256").update(fields.map(value => `${Buffer.byteLength(value, "utf8")}:${value},`).join(""), "utf8").digest("hex")}`;
      const entry = inventory.entries[0];
      if (transport === "console") {
        assert.equal(entry.legacy_definition, originalPipe.replace(/<Enabled>(true|false)<\/Enabled>/u, "<Enabled/>"), "v1 retains the exact old console serialization despite the Unicode export");
        assert.ok(native.calls.some(({ args }) => args.includes("-EncodedCommand")), "console path reached Unicode export");
      }
      assert.equal(receipts[0].definition_hash, digest("bridge-definition-v2", receipts[0].binding_hash, BRIDGE_NAME, BRIDGE_SID, entry.definition));
      receipts[0].definition_hash = digest("bridge-definition-v1", receipts[0].binding_hash, BRIDGE_NAME, BRIDGE_SID, entry.legacy_definition);
      guard.pause(receipts, () => {});
      assert.equal(receipts[0].state, "paused", "v1 receipt authorizes the exact original pause");
      if (changed) native.rows.get(BRIDGE_NAME).extraSettings = "<Priority>4</Priority>";
      const before = native.calls.length;
      const resumed = boundaryGuard(native.options);
      const resume = () => {
        const hydrated = resumed.capture(resumed.inventory(), JSON.parse(JSON.stringify(receipts)));
        resumed[recovery](hydrated, () => {});
      };
      if (changed) assert.throws(resume, /Task Scheduler/);
      else resume();
      assert.ok(native.calls.slice(before).some(({ args }) => args.includes("/XML")), "saved v1 proof was compared to native XML");
      assert.equal(native.mutations().length, changed ? 1 : 2);
      if (changed) assert.equal(native.rows.get(BRIDGE_NAME).enabled, false);
    }
  });
}

test("FIX-2 bridge omitted default does not admit malformed enabled fields", () => {
  for (const extraSettings of ["", "<Enabled/>", "<Enabled>maybe</Enabled>", "<Enabled>true</Enabled><Enabled>false</Enabled>"]) {
    const native = bridgeNativeHarness({ tasks: [{ extraSettings }] });
    const guard = boundaryGuard(native.options);
    if (extraSettings) assert.throws(() => guard.inventory(), /Task Scheduler/);
    else assert.equal(guard.inventory().entries[0].enabled, true, "omitted enabled control");
    assert.ok(native.calls.some(({ args }) => args.includes("/XML")), "enabled-state validation reached XML readback");
    assert.equal(native.mutations().length, 0);
  }
});


for (const recovery of ["restore", "retire"]) for (const timing of ["during-com", "before-mutation"]) {
  test(`FIX-3 v1 bridge ${recovery} binds ${timing} to the same observation`, () => {
    for (const changed of [false, true]) {
      const native = bridgeNativeHarness({ tasks: [{ extraSettings: "<Label>é</Label>" }], explicitEnabled: true });
      const baseSpawn = native.options.spawn;
      let racing = false; let decisionReads = 0; let injected = false;
      const mutate = () => {
        injected = true;
        if (changed) native.rows.get(BRIDGE_NAME).extraSettings += "<Hidden>true</Hidden><Priority>4</Priority>";
      };
      native.options.spawn = (command, args, child) => {
        if (command.endsWith("powershell.exe")) {
          native.calls.push({ command, args });
          if (racing && timing === "during-com" && !injected) mutate();
          const result = baseSpawn(String.raw`C:\Windows\System32\schtasks.exe`, ["/Query", "/TN", BRIDGE_NAME, "/XML"], child);
          return { status: 0, stdout: Buffer.from(`\ufeff${result.stdout}`, "utf16le") };
        }
        if (racing && args.includes("/XML") && ++decisionReads === 3 && timing === "before-mutation") mutate();
        const result = baseSpawn(command, args, child);
        return args.includes("/XML") && result.status === 0 ? { ...result, stdout: Buffer.from(result.stdout, "latin1") } : result;
      };
      const guard = boundaryGuard(native.options);
      const inventory = guard.inventory();
      const receipts = guard.capture(inventory);
      const entry = inventory.entries[0];
      const fields = ["bridge-definition-v1", receipts[0].binding_hash, BRIDGE_NAME, BRIDGE_SID, entry.legacy_definition];
      receipts[0].definition_hash = `sha256:${boundaryHash("sha256").update(fields.map(value => `${Buffer.byteLength(value, "utf8")}:${value},`).join(""), "utf8").digest("hex")}`;
      guard.pause(receipts, () => {});
      assert.equal(receipts[0].state, "paused");
      const before = native.mutations().length;
      racing = true;
      const resume = () => guard[recovery](receipts, () => {});
      if (changed) assert.throws(resume, /Task Scheduler/);
      else resume();
      assert.equal(injected, true, "both arms reached the edit injection point");
      assert.equal(native.mutations().length - before, changed ? 0 : 1);
      if (changed) assert.equal(native.rows.get(BRIDGE_NAME).enabled, false, "edited task remains paused and present");
      else assert.equal(receipts[0].state, recovery === "restore" ? "restored" : "retired");
    }
  });
}

for (const fault of ["preflight", "bookmark-capture", "bookmark-save", "dispatch"]) {
  test(`S2 pre-mutation schedule restoration: ${fault}`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const h = productionHarness(manifestPath);
      let preflight = 0, capture = 0, persist = 0, dispatch = 0;
      const query = h.options.upgradeOptions.d1Query;
      h.options.upgradeOptions.d1Query = async (...args) => {
        if (args[2].includes("SELECT * FROM install_state")) {
          preflight++;
          if (fault === "preflight") throw new Error("fixture preflight failure");
        }
        return query(...args);
      };
      h.options.upgradeOptions.cf = async () => {
        capture++;
        if (fault === "bookmark-capture") throw new Error("fixture bookmark failure");
        return { bookmark: "fixture-bookmark" };
      };
      h.options.upgradeOptions.saveUpgradeBookmark = () => {
        persist++;
        if (fault === "bookmark-save") throw new Error("fixture persistence failure");
      };
      h.options.upgradeOptions.cmdDeploy = async () => {
        dispatch++;
        throw new Error("fixture lost dispatch reply");
      };
      await assert.rejects(cmdUpdate(manifestPath, h.options));
      assert.equal(preflight, 1, "the real install preflight was reached");
      assert.ok(h.events.includes("schedule:false"), "native pause was reached");
      assert.equal(capture, fault === "preflight" ? 0 : 1);
      assert.equal(persist, ["preflight", "bookmark-capture"].includes(fault) ? 0 : 1);
      assert.equal(dispatch, fault === "dispatch" ? 1 : 0);
      assert.equal(h.state().enabled, fault !== "dispatch", "only proven non-dispatch permits restoration");
      assert.equal(h.finish.length, 0);
      const transaction = readDailyRefreshUpdateTransaction(h.plan.identity, {
        home: dirname(manifestPath), manifestPath, machineLockRoot: h.machineLockRoot,
      });
      if (fault === "dispatch") assert.equal(transaction.remote_mutation_may_have_started, true);
      else assert.equal(transaction, null, "exact prior schedule readback clears the fence");
    });
  });
}

test("S2 daily restore failure is incomplete and preserves a recovery location", async () => {
  await withFixture(async ({ manifestPath }) => {
    const h = productionHarness(manifestPath, { failRestore: true });
    let failure;
    try { await cmdUpdate(manifestPath, h.options); } catch (error) { failure = error; }
    assert.ok(h.events.includes("acceptance"));
    assert.ok(h.events.includes("schedule:true"), "restore decision was reached after acceptance");
    assert.equal(h.state().enabled, false);
    const transaction = readDailyRefreshUpdateTransaction(h.plan.identity, {
      home: dirname(manifestPath), manifestPath, machineLockRoot: h.machineLockRoot,
    });
    assert.equal(transaction.phase, "recovery_required");
    assert.ok(failure, "incomplete local restoration must reject");
    assert.match(failure.message, /daily.*recovery|recovery.*daily/i);
    assert.equal(h.finish.length, 0, "no ordinary Done footer");
  });
});

test("S2 failed mandatory acceptance cannot claim normal operation or no loss", async () => {
  await withFixture(async ({ manifestPath }) => {
    const h = productionHarness(manifestPath);
    let acceptance = 0;
    h.options.upgradeOptions.cmdTest = async () => { acceptance++; throw new Error("fixture acceptance failure"); };
    let failure;
    try { await cmdUpdate(manifestPath, h.options); } catch (error) { failure = error; }
    assert.equal(acceptance, 1);
    assert.ok(h.events.includes("health:active-final"));
    assert.ok(h.events.includes("deploy:active"));
    assert.equal(h.state().enabled, false);
    assert.match(failure.message, /full acceptance test/);
    assert.ok(failure.message.includes(`Daily recovery receipt: ${dailyRefreshUpdateTransactionPath(h.plan.identity, { home: dirname(manifestPath) })}`));
    assert.ok(failure.message.includes("D1 recovery receipt: fixture-verified-bookmark-receipt"));
    assert.doesNotMatch(failure.message, /working normally|nothing was lost/i);
    assert.equal(h.finish.length, 0);
  });
});

for (const arm of ["empty", "after-empty-read", "during-upload", "already-paused", "interrupted", "stale-projection", "unreadable-state"]) {
  test(`S2 bounded paused queue completion: ${arm}`, async () => {
    await withFixture(async ({ manifestPath }) => {
      const h = productionHarness(manifestPath);
      let queued = arm === "already-paused" ? 1 : 0;
      let paused = arm === "already-paused", bootstrap = 0, reads = 0, preparations = 0, interrupted = false;
      let version = "0.4.7";
      const events = [];
      h.options.readUpdateBacklog = async () => ({ pending: queued, ...(paused ? { paused_for_upgrade: true } : {}) });
      h.options.upgradeOptions.readUpdateBacklog = async () => {
        reads++;
        const receipt = { pending: queued, ...(paused ? { paused_for_upgrade: true } : {}) };
        if (arm === "after-empty-read") queued = 1;
        return receipt;
      };
      h.options.upgradeOptions.d1Query = async (_account, _db, sql, params) => {
        if (sql.includes("sqlite_master")) return { results: [{ name: "install_state" }] };
        if (sql.includes("SELECT * FROM install_state")) return { results: [{ product_version: version, schema_version: 54, client_slug: "fixture" }] };
        if (sql.includes("vector_projection_status AS status")) {
          preparations++;
          if (arm === "unreadable-state") return { results: [] };
          return { results: [{ status: arm === "stale-projection" ? "bootstrap_required" : queued ? "pending" : "verified", has_outbox: queued ? 1 : 0,
            schema_version: 54, protocol: "bootstrap-v2" }] };
        }
        if (sql.includes("vector_drain_lease_owner")) return { results: [{ owner: null, expires_at: null, in_flight: 0 }] };
        if (sql.includes("expected_vectors")) return { results: [{ expected_vectors: 1 }] };
        if (sql.includes("UPDATE install_state SET last_upgraded_at")) version = params[1];
        if (sql === "SELECT product_version FROM install_state WHERE id = 1") return { results: [{ product_version: version }] };
        return { results: [] };
      };
      h.options.upgradeOptions.cmdDeploy = async (_path, opts) => {
        paused = opts.pauseVectorDrainForUpgrade;
        events.push(paused ? "pause-upload" : "active-upload");
        if (paused && ["during-upload", "interrupted", "stale-projection", "unreadable-state"].includes(arm)) queued = 1;
      };
      h.options.upgradeOptions.cmdHealth = async (_path, opts) => {
        events.push(`health:${opts.expectDrainMode}`);
        if (opts.prepareProjectionReadiness) await opts.prepareProjectionReadiness();
        if (opts.requireProjectionReady && queued) throw new Error("fixture queued projection");
      };
      h.options.upgradeOptions.cmdBootstrap = async (_path, opts) => {
        bootstrap++;
        if (queued > 0) {
          assert.equal(opts.maxDurationMs, 15 * 60_000);
          assert.equal(opts.maxRounds, 256);
          await opts.beforeRequest();
          await opts.afterRequest();
          if (arm === "interrupted" && !interrupted) {
            interrupted = true;
            throw new Error("fixture completion interrupted");
          }
        }
        assert.equal(paused, true, "completion never forces unpause");
        events.push(`bootstrap:${queued}`);
        queued = 0;
        return { epoch: 1, total: 1, confirmed: 1, remaining: 0, rounds: 1, complete: true, vector_ready: true };
      };
      let failure;
      try { await cmdUpdate(manifestPath, h.options); } catch (error) { failure = error; }
      if (arm === "interrupted") {
        assert.ok(failure);
        assert.equal(queued, 1);
        assert.equal(paused, true);
        assert.equal(h.state().enabled, false);
        assert.equal(readDailyRefreshUpdateTransaction(h.plan.identity, {
          home: dirname(manifestPath), manifestPath, machineLockRoot: h.machineLockRoot,
        }).remote_mutation_may_have_started, true);
        failure = undefined;
        try { await cmdUpdate(manifestPath, h.options); } catch (error) { failure = error; }
      }
      if (["stale-projection", "unreadable-state"].includes(arm)) {
        assert.ok(preparations > 0, "state refusal decision was reached");
        assert.ok(failure);
        assert.equal(queued, 1, "refusal retains all accepted work");
        assert.equal(bootstrap, 0);
        assert.equal(events.includes("active-upload"), false);
      } else {
        assert.equal(failure, undefined, "an accepted pause-window queue has a supported completion path");
        assert.equal(reads, arm === "interrupted" ? 2 : 1);
        assert.ok(preparations > 0);
        assert.ok(bootstrap >= 1);
        if (arm !== "empty") assert.ok(events.includes("bootstrap:1"), "completion reached the nonempty queue");
        assert.equal(queued, 0);
        assert.equal(paused, false);
        assert.equal(h.state().enabled, true);
        assert.equal(h.finish.length, 1);
      }
    });
  });
}

for (const operation of ["whoami", "/Query", "/Change", "/Delete"]) {
  for (const timeout of [false, true]) test(`S2 bounded bridge ${operation}: timeout=${timeout}`, async () => {
    await withFixture(async ({ directory, manifestPath }) => {
      const { createNativeWindowsBridgeAdapter } = await import("../operations/windows-update-bridge.mjs");
      const h = bridgeNativeHarness({ manifestPath, tasks: [{}] });
      const calls = [];
      const spawn = h.options.spawn;
      const adapter = createNativeWindowsBridgeAdapter({ ...h.options, home: directory,
        spawn: (command, args, child) => {
          const op = command.endsWith("whoami.exe") ? "whoami" : args[0];
          calls.push({ operation: op, timeout: child.timeout });
          if (op === operation && timeout) return { status: null, error: Object.assign(new Error("fixture deadline"), { code: "ETIMEDOUT" }), signal: "SIGTERM" };
          return spawn(command, args, child);
        },
      });
      let failure;
      try {
        if (operation === "whoami") adapter.currentSid();
        else {
          const observed = adapter.read(BRIDGE_NAME);
          if (operation === "/Change") adapter.setEnabled(BRIDGE_NAME, false, { expected: observed });
          if (operation === "/Delete") adapter.remove(BRIDGE_NAME, { expected: observed });
        }
      } catch (error) { failure = error; }
      assert.ok(calls.some(call => call.operation === operation));
      if (timeout) assert.ok(calls.every(call => Number.isInteger(call.timeout) && call.timeout > 0 && call.timeout <= 60_000));
      if (timeout) assert.ok(failure, "timeout retains recovery, never absent or successful");
      else assert.equal(failure, undefined);
    });
  });
}

test("S2 unknown scheduler inspection stops before remote dispatch", async () => {
  await withFixture(async ({ manifestPath }) => {
    const h = productionHarness(manifestPath);
    let reads = 0;
    h.adapter.read = () => { reads++; throw Object.assign(new Error("fixture scheduler timeout"), { code: "DAILY_REFRESH_INSPECTION_UNKNOWN" }); };
    let failure;
    try { await cmdUpdate(manifestPath, h.options); } catch (error) { failure = error; }
    assert.equal(reads, 1);
    assert.ok(h.events.includes("verification"));
    assert.ok(failure);
    assert.equal(h.events.includes("deploy:paused"), false);
    assert.equal(h.state().enabled, true);
    assert.equal(h.finish.length, 0);
  });
});

test("S2 active local ingest owns the update boundary until it releases custody", async () => {
  await withFixture(async ({ manifestPath }) => {
    const { acquireBrainLifecycleLock } = await import("../operations/brain-lifecycle-lock.mjs");
    const h = productionHarness(manifestPath);
    const lock = acquireBrainLifecycleLock({ manifestPath, operation: "ingest", platform: "win32", machineLockRoot: h.machineLockRoot });
    h.options.lifecycleLockWaitMs = 0;
    try {
      await assert.rejects(cmdUpdate(manifestPath, h.options), error => {
        assert.equal(error.code, "brain_lifecycle_busy", "the real lifecycle custody decision was reached");
        return true;
      });
      assert.equal(h.events.length, 0);
      assert.equal(h.state().enabled, true);
    } finally { lock.release(); }
    await cmdUpdate(manifestPath, h.options);
    assert.ok(h.events.includes("deploy:paused"));
    assert.ok(h.events.includes("acceptance"));
    assert.equal(h.state().enabled, true);
  });
});
