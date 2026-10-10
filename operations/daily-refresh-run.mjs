/** Sequential execution and per-source proof for the daily machine-pull plan. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dailyRefreshIdentity, dailyRefreshPrincipal } from "./daily-refresh-plan.mjs";
import { observeDailyRun } from "./daily-refresh-observation.mjs";
import { acquireBrainLifecycleLock } from "./brain-lifecycle-lock.mjs";
import { providerNoChangeCheckAt } from "../worker/src/lib/source-receipt.js";
import {
  buildDailyRefreshDefinition,
  readDailyRefreshUpdateTransaction,
  statusDailyRefreshSchedule,
} from "./daily-refresh-scheduler.mjs";

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("the daily refresh clock is invalid");
  return value.toISOString();
}

function validTimestamp(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function sourceFreshness(inventory, source) {
  const names = source.source_names?.length ? source.source_names : [source.key];
  return Object.fromEntries(names.map((name) => [name, validTimestamp(inventory?.[name]?.last_successful_run_at)]));
}

function compareFreshness(before, after) {
  const missing = [];
  const notAdvanced = [];
  for (const name of Object.keys(after)) {
    if (!after[name]) missing.push(name);
    else if (before[name] && Date.parse(after[name]) <= Date.parse(before[name])) notAdvanced.push(name);
  }
  return Object.freeze({
    advanced: missing.length === 0 && notAdvanced.length === 0,
    missing: Object.freeze(missing),
    notAdvanced: Object.freeze(notAdvanced),
  });
}

export async function runDailyRefresh({
  plan,
  acquireLock = (options) => acquireBrainLifecycleLock(options),
  runSource,
  readFreshness,
  writeReceipt = () => {},
  now = () => new Date(),
  home = homedir(),
  platform = process.platform,
  recoveryRequired = () => false,
  scheduleAttention = [],
} = {}) {
  if (!plan?.ready || !plan?.enabled) throw new Error("the daily refresh plan is not enabled and ready");
  if (typeof runSource !== "function" || typeof readFreshness !== "function" || typeof writeReceipt !== "function") {
    throw new TypeError("daily refresh needs source, freshness, and receipt dependencies");
  }
  const startedAt = timestamp(now);
  const runtimeMinutes = Number.isInteger(plan.max_runtime_minutes) && plan.max_runtime_minutes > 0
    ? plan.max_runtime_minutes
    : 45;
  const deadlineAt = Date.parse(startedAt) + runtimeMinutes * 60_000;
  let lock;
  try {
    lock = acquireLock({ manifestPath: plan.manifest_path, operation: "daily-refresh", home, platform });
  } catch (error) {
    if (!new Set(["brain_lifecycle_busy", "brain_lifecycle_recovery_required"]).has(error?.code)) throw error;
    const receipt = Object.freeze({
      schema_version: 1,
      kind: "daily_refresh",
      identity: plan.identity.id,
      status: "deferred",
      started_at: startedAt,
      completed_at: timestamp(now),
      reason_code: error?.code === "brain_lifecycle_recovery_required" ? "update_recovery_required" : "brain_lifecycle_busy",
      reason: error?.code === "brain_lifecycle_recovery_required"
        ? "a prior update still requires verified schedule recovery"
        : "another Brain lifecycle operation owns the manifest lock",
      schedule_attention: Object.freeze([...scheduleAttention]),
      sources: [],
    });
    await writeReceipt(receipt);
    return receipt;
  }

  const sourceResults = [];
  try {
    lock.assertOwned();
    if (await recoveryRequired()) {
      const receipt = Object.freeze({
        schema_version: 1,
        kind: "daily_refresh",
        identity: plan.identity.id,
        status: "deferred",
        started_at: startedAt,
        completed_at: timestamp(now),
        reason_code: "update_recovery_required",
        reason: "a prior update still requires verified schedule recovery",
        schedule_attention: Object.freeze([...scheduleAttention]),
        sources: [],
      });
      await writeReceipt(receipt);
      return receipt;
    }
    const baseline = await readFreshness();
    for (const source of plan.sources.filter((entry) =>
      entry.class === "machine-pull" && entry.owner === "daily-task" && entry.status !== "ready"
    )) {
      const receipt = Object.freeze({
        schema_version: 1,
        kind: "daily_refresh_source",
        identity: plan.identity.id,
        source: source.source_names?.[0] || source.key,
        status: source.status === "skipped" ? "skipped" : "unavailable",
        started_at: startedAt,
        completed_at: timestamp(now),
        freshness_advanced: false,
        reason_code: source.status === "skipped" ? "source_not_ready" : "source_unavailable",
      });
      sourceResults.push(receipt);
      await writeReceipt(receipt);
    }
    const runnable = plan.sources.filter((source) =>
      source.class === "machine-pull" && source.owner === "daily-task" && source.status === "ready"
    );
    for (const source of runnable) {
      lock.assertOwned();
      const sourceStartedAt = timestamp(now);
      if (Date.parse(sourceStartedAt) >= deadlineAt) {
        const receipt = Object.freeze({
          schema_version: 1,
          kind: "daily_refresh_source",
          identity: plan.identity.id,
          source: source.source_names?.[0] || source.key,
          status: "deferred",
          started_at: sourceStartedAt,
          completed_at: sourceStartedAt,
          freshness_advanced: false,
          reason: `the ${runtimeMinutes}-minute daily runtime budget was exhausted before this source started`,
        });
        sourceResults.push(receipt);
        await writeReceipt(receipt);
        continue;
      }
      const beforeBySource = sourceFreshness(baseline, source);
      let runResult;
      let outcome = "complete";
      let reason = null;
      try {
        runResult = await runSource(source, { assertOwned: lock.assertOwned });
        lock.assertOwned();
        const afterInventory = await readFreshness(source);
        const afterBySource = sourceFreshness(afterInventory, source);
        const freshness = compareFreshness(beforeBySource, afterBySource);
        const afterValues = Object.values(afterBySource).filter(Boolean).sort();
        const beforeValues = Object.values(beforeBySource).filter(Boolean).sort();
        const after = afterValues.at(-1) || null;
        const before = beforeValues.at(-1) || null;
        const latestRuns = Object.keys(afterBySource).map((name) => afterInventory?.[name]?.latest_run);
        const checkedAt = timestamp(now);
        const selectedEntries = Array.isArray(runResult?.entries) ? runResult.entries.filter(entry =>
          entry.key === source.run_key || entry.manifestKey === source.key) : null;
        // cmdLoad reports unselected manifest entries as skipped. Only the
        // selected leg's outcome can establish that this invocation ran.
        const selectedRan = selectedEntries ? selectedEntries.length === 1 &&
          ["loaded", "partial"].includes(selectedEntries[0].status) : !runResult?.skipped;
        const executionComplete = (runResult?.status === undefined || ["complete", "partial"].includes(runResult.status)) && selectedRan &&
          !runResult?.failed && !runResult?.unavailable;
        const noChangeBySource = Object.keys(afterBySource).map((name) => {
          const row = afterInventory?.[name];
          const check = providerNoChangeCheckAt(row?.kind, row?.latest_run);
          const prior = validTimestamp(baseline?.[name]?.latest_run?.finished_at) || beforeBySource[name];
          // A stale/replayed receipt, a future clock, or a borrowed ingest date
          // cannot certify this invocation. Every leg needs its own new proof.
          return executionComplete && (runResult?.loaded > 0 || runResult?.status === "complete") &&
            check !== null && Date.parse(row.latest_run.started_at) >= Date.parse(sourceStartedAt) &&
            Date.parse(check) <= Date.parse(checkedAt) && (!prior || Date.parse(check) > Date.parse(prior)) &&
            beforeBySource[name] === afterBySource[name];
        });
        const docsRefused = latestRuns.every((run) => Number.isSafeInteger(run?.docs_refused))
          ? latestRuns.reduce((sum, run) => sum + run.docs_refused, 0) : null;
        const failedRun = latestRuns.some((run) => ["failed", "refused"].includes(run?.outcome) || run?.docs_failed > 0);
        // Reject measured zero work even when an older server advanced its date.
        const unverifiedBySource = latestRuns.map((run) => run?.outcome === "empty" ||
          ((run?.metrics_version === 1 || (Number.isSafeInteger(run?.docs_refused) &&
            Number.isSafeInteger(run?.docs_failed))) &&
            ![run?.docs_added, run?.docs_updated, run?.docs_unchanged]
              .some((count) => Number.isSafeInteger(count) && count > 0)));
        const unverifiedRun = unverifiedBySource.some(Boolean);
        const freshnessAdvanced = executionComplete && freshness.advanced && !failedRun && !unverifiedRun;
        const checkVerified = executionComplete && !failedRun && latestRuns.every((_run, index) => {
          if (noChangeBySource[index]) return true;
          const name = Object.keys(afterBySource)[index];
          return compareFreshness({ [name]: beforeBySource[name] }, { [name]: afterBySource[name] }).advanced &&
            !unverifiedBySource[index];
        });
        const docsExcluded = Number.isSafeInteger(runResult?.excluded) ? runResult.excluded : null;
        if (checkVerified && (latestRuns.some((run) => run?.outcome === "partial") ||
            runResult?.partial > 0 || docsExcluded > 0)) outcome = "partial";
        if (!checkVerified) {
          outcome = "failed";
          reason = unverifiedRun ? "the latest source receipt verified no accepted or unchanged documents"
            : failedRun ? "the latest source receipt reports a failed or refused run"
            : freshness.missing.length
            ? "the source claimed success, but one or more freshness receipts were missing or invalid"
            : "the source claimed success, but last_successful_run_at did not advance for every source leg";
        }
        const receipt = Object.freeze({
          schema_version: 1,
          kind: "daily_refresh_source",
          identity: plan.identity.id,
          source: source.source_names?.[0] || source.key,
          status: outcome,
          started_at: sourceStartedAt,
          completed_at: timestamp(now),
          last_successful_run_at_before: before,
          last_successful_run_at_after: after,
          freshness_advanced: freshnessAdvanced,
          check_verified: checkVerified,
          no_change: checkVerified && noChangeBySource.every(Boolean),
          last_check_at_before: Object.keys(beforeBySource).map(name => baseline?.[name]?.last_check_at || beforeBySource[name])
            .filter(Boolean).sort().at(-1) || null,
          last_check_at_after: checkVerified ? Object.keys(afterBySource).map((name, index) =>
            noChangeBySource[index] ? afterInventory[name].latest_run.finished_at : afterBySource[name]).sort().at(-1) : null,
          docs_refused: docsRefused,
          docs_excluded: docsExcluded,
          missing_freshness_sources: freshness.missing,
          unadvanced_freshness_sources: freshness.notAdvanced,
          reason,
        });
        sourceResults.push(receipt);
        await writeReceipt(receipt);
      } catch (error) {
        const receipt = Object.freeze({
          schema_version: 1,
          kind: "daily_refresh_source",
          identity: plan.identity.id,
          source: source.source_names?.[0] || source.key,
          status: "failed",
          started_at: sourceStartedAt,
          completed_at: timestamp(now),
          freshness_advanced: false,
          reason_code: "source_execution_failed",
          reason: "the source refresh failed; retry this source or inspect its private local diagnostics",
        });
        sourceResults.push(receipt);
        await writeReceipt(receipt);
      }
    }
    const result = Object.freeze({
      schema_version: 1,
      kind: "daily_refresh",
      identity: plan.identity.id,
      status: sourceResults.length === 0 || sourceResults.some((entry) => !["complete", "partial"].includes(entry.status)) ? "failed"
        : sourceResults.some((entry) => entry.status === "partial") ? "partial" : "complete",
      started_at: startedAt,
      completed_at: timestamp(now),
      schedule_attention: Object.freeze([...scheduleAttention]),
      sources: Object.freeze(sourceResults),
    });
    await writeReceipt(result);
    return result;
  } finally {
    lock.release();
  }
}

function freshnessMap(inventory) {
  return Object.fromEntries((inventory?.sources || []).map((row) => [row.name, {
    kind: row.kind,
    last_check_at: row?.receipt?.last_check_at || null,
    last_successful_run_at: row?.receipt?.last_successful_run_at || null,
    state: row?.freshness?.state || null,
    latest_run: row?.receipt?.latest_run || null,
  }]));
}

function dailyReceiptWriter(plan, { home = homedir() } = {}) {
  const directory = join(resolve(home), ".brain", "daily-receipts");
  const path = join(directory, `${plan.identity.id}.json`);
  return async (receipt) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const staged = `${path}.tmp-${process.pid}`;
    writeFileSync(staged, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(staged, path);
    chmodSync(path, 0o600);
  };
}

export async function runDailyRefreshCli(manifestPath, options = {}) {
  const path = resolve(String(manifestPath || ""));
  let m;
  try { m = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error(`the daily refresh manifest could not be read: ${error.message}`);
  }
  if (m?.brain?.domain || m?.brain?.worker_name || m?.infrastructure?.cloudflare?.d1_database_id || m?.client?.slug) {
    const identity = dailyRefreshIdentity(m, options.principal ?? dailyRefreshPrincipal({
      platform: options.platform ?? process.platform, home: options.home,
    }));
    return observeDailyRun(identity, () => executeDailyRefreshCli(path, m, options, true), options);
  }
  return executeDailyRefreshCli(path, m, options, false);
}

async function executeDailyRefreshCli(path, m, options, observationStarted) {
  const brain = options.brainModule ?? await import("../brain.mjs");
  const buildPlan = options.buildPlan ?? brain.buildConfiguredDailyPlan;
  if (typeof buildPlan !== "function") throw new TypeError("the shared daily plan builder is unavailable");
  const plan = await buildPlan(m, path, {
    platform: options.platform ?? process.platform,
    ...(options.principal ? { principal: options.principal } : {}),
    ...(options.localTimezone ? { localTimezone: options.localTimezone } : {}),
    ...(options.planLoad ? { planLoad: options.planLoad } : {}),
    ...(options.existingSchedulerOwners !== undefined
      ? { existingSchedulerOwners: options.existingSchedulerOwners }
      : {}),
    ...(options.planOptions || {}),
  });
  const execute = async () => {
    if (!plan.ready) throw new Error(plan.configuration_error || "the daily refresh plan is not ready");
    const receiptWriter = options.writeReceipt ?? dailyReceiptWriter(plan, options);
    const readUpdateTransaction = options.readUpdateTransaction ?? readDailyRefreshUpdateTransaction;
    const expectedDefinitionHash = options.expectedDefinitionHash || null;
    const scheduleAttention = [];
    if (expectedDefinitionHash) {
      const definitionOptions = {
        platform: options.platform ?? process.platform,
        ...(options.definitionOptions || {}),
      };
      const inspectSchedule = options.inspectSchedule ?? statusDailyRefreshSchedule;
      const schedule = await inspectSchedule(plan, {
        ...definitionOptions,
        ...(options.schedulerAdapter ? { adapter: options.schedulerAdapter } : {}),
      });
      if (!schedule?.installed || schedule.state?.definition?.definition_hash !== expectedDefinitionHash) {
        throw new Error("the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it");
      }
      if (schedule.registered_node_usable === false) {
        const missing = schedule.registered_node_present === false;
        const error = new Error(missing
          ? "the registered Node binary is missing; run brain daily on <manifest> to repair the daily schedule"
          : "the registered Node binary is not executable; run brain daily on <manifest> to repair the daily schedule");
        error.code = missing ? "daily_schedule_node_missing" : "daily_schedule_node_unusable";
        throw error;
      }
      if (schedule.plan_matches_registered_definition !== true) {
        throw new Error("the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it");
      }
      const definition = buildDailyRefreshDefinition(plan, definitionOptions);
      if (definition.definition_hash !== expectedDefinitionHash) {
        if (schedule.node_path_changed !== true) {
          throw new Error("the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it");
        }
        scheduleAttention.push("daily schedule needs refresh (Node changed)");
      }
    }
    const readFreshness = options.readFreshness ?? (async () => freshnessMap(await brain.cmdSources(path, {
      flags: { json: true },
      silent: true,
    })));
    const result = await runDailyRefresh({
      plan,
      acquireLock: options.acquireLock,
      runSource: options.runSource ?? ((source) => brain.cmdLoad(path, {
        flags: { only: source.run_key },
        lifecycleLockHeld: true,
        allowPartialRefresh: true,
      })),
      readFreshness,
      writeReceipt: receiptWriter,
      now: options.now,
      home: options.home,
      platform: options.platform,
      scheduleAttention,
      recoveryRequired: () => Boolean(readUpdateTransaction(plan.identity, {
        home: options.home,
        manifestPath: path,
        platform: options.platform ?? process.platform,
        machineLockRoot: options.machineLockRoot,
      })),
    });
    if (!options.silent) {
      const log = options.log || console.log;
      for (const attention of result.schedule_attention) log(attention);
      log(`daily refresh ${result.status}: ${result.sources.length} source(s) attempted`);
      for (const source of result.sources) {
        log(`${source.source} | ${source.status} | ${source.last_successful_run_at_after || "never"}` +
          (source.no_change ? ` | checked ${source.last_check_at_after}; no changes` : "") +
          (source.status === "partial" ? ` | ${source.docs_refused ?? "unknown"} refused` : "") +
          (source.docs_excluded > 0 ? ` | ${source.docs_excluded} excluded by rule` : ""));
      }
    }
    return result;
  };
  return observationStarted ? execute() : observeDailyRun(plan.identity, execute, options);
}

async function main(argv = process.argv.slice(2)) {
  const [command, manifestPath, flag, expectedDefinitionHash] = argv;
  if (command !== "run" || !manifestPath || (flag !== undefined && flag !== "--definition-hash")) {
    throw new Error("usage: node operations/daily-refresh-run.mjs run <manifest> [--definition-hash <sha256>]");
  }
  return runDailyRefreshCli(manifestPath, { expectedDefinitionHash });
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_MAIN) {
  main().then((result) => {
    if (result.status === "failed") process.exitCode = 1;
  }).catch((error) => {
    console.error(new Set(["daily_schedule_node_missing", "daily_schedule_node_unusable"]).has(error?.code)
      ? `Daily refresh did not run: the registered Node binary is ${error.code === "daily_schedule_node_missing" ? "missing" : "not executable"}. Turn daily imports on again from the normal Brain terminal to repair the schedule.`
      : "Daily refresh failed: daily_refresh_failed. Inspect the private local diagnostics, then retry.");
    process.exitCode = 1;
  });
}
