/** Sequential execution and per-source proof for the daily machine-pull plan. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBrainLifecycleLock } from "./brain-lifecycle-lock.mjs";
import { buildDailyRefreshDefinition } from "./daily-refresh-scheduler.mjs";

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("the daily refresh clock is invalid");
  return value.toISOString();
}

function lastSuccess(inventory, source) {
  const names = source.source_names?.length ? source.source_names : [source.key];
  const values = names.map((name) => inventory?.[name]?.last_successful_run_at).filter(Boolean).sort();
  return values.at(-1) || null;
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
    if (error?.code !== "brain_lifecycle_busy") throw error;
    const receipt = Object.freeze({
      schema_version: 1,
      kind: "daily_refresh",
      identity: plan.identity.id,
      status: "deferred",
      started_at: startedAt,
      completed_at: timestamp(now),
      reason: "another Brain lifecycle operation owns the manifest lock",
      sources: [],
    });
    await writeReceipt(receipt);
    return receipt;
  }

  const sourceResults = [];
  try {
    lock.assertOwned();
    const baseline = await readFreshness();
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
      const before = lastSuccess(baseline, source);
      let runResult;
      let outcome = "complete";
      let reason = null;
      try {
        runResult = await runSource(source, { assertOwned: lock.assertOwned });
        lock.assertOwned();
        const afterInventory = await readFreshness(source);
        const after = lastSuccess(afterInventory, source);
        const freshnessAdvanced = Boolean(after && (!before || Date.parse(after) > Date.parse(before)));
        if (!freshnessAdvanced && runResult?.status !== "skipped") {
          outcome = "failed";
          reason = "the source claimed success, but last_successful_run_at did not advance";
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
          reason: String(error?.message || error).replace(/\s+/gu, " ").slice(0, 240),
        });
        sourceResults.push(receipt);
        await writeReceipt(receipt);
      }
    }
    const result = Object.freeze({
      schema_version: 1,
      kind: "daily_refresh",
      identity: plan.identity.id,
      status: sourceResults.some((entry) => entry.status !== "complete") ? "failed" : "complete",
      started_at: startedAt,
      completed_at: timestamp(now),
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
    last_successful_run_at: row?.receipt?.last_successful_run_at || null,
    state: row?.freshness?.state || null,
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
  if (!plan.ready) throw new Error(plan.configuration_error || "the daily refresh plan is not ready");
  const expectedDefinitionHash = options.expectedDefinitionHash || null;
  if (expectedDefinitionHash) {
    const definition = buildDailyRefreshDefinition(plan, {
      platform: options.platform ?? process.platform,
      ...(options.definitionOptions || {}),
    });
    if (definition.definition_hash !== expectedDefinitionHash) {
      throw new Error("the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it");
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
    })),
    readFreshness,
    writeReceipt: options.writeReceipt ?? dailyReceiptWriter(plan, options),
    now: options.now,
    home: options.home,
    platform: options.platform,
  });
  if (!options.silent) {
    console.log(`daily refresh ${result.status}: ${result.sources.length} source(s) attempted`);
    for (const source of result.sources) {
      console.log(`${source.source} | ${source.status} | ${source.last_successful_run_at_after || "never"}`);
    }
  }
  return result;
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
    console.error(`Daily refresh failed: ${String(error?.message || error).replace(/\s+/gu, " ").slice(0, 300)}`);
    process.exitCode = 1;
  });
}
