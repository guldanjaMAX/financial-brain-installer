import { lstatSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { readStableRegularFile } from "./package-bundle-verifier.mjs";
import { createWindowsUpdateBridgeGuard } from "./windows-update-bridge.mjs";
import { captureAdditionalUpdateSchedulers, pauseAdditionalUpdateScheduler, restoreAdditionalUpdateScheduler,
  validateUpdateSchedulerSnapshot, releaseUpdateSchedulerReservations } from "./update-scheduler-inventory.mjs";
import { dailyRefreshIdentity, dailyRefreshPrincipal } from "./daily-refresh-plan.mjs";
import { createNativeDailyRefreshAdapter, pauseDailyRefreshSchedule, restoreDailyRefreshSchedule,
  readDailyRefreshUpdateTransaction, writeDailyRefreshUpdateTransaction,
  clearDailyRefreshUpdateTransaction } from "./daily-refresh-scheduler.mjs";
import { readBrainRecoveryFence } from "./brain-lifecycle-lock.mjs";

export const PRIVATE_UPDATE_OUTCOME_ENV = "BRAIN_PRIVATE_UPDATE_OUTCOME";

// Only bounded dispatch evidence crosses the process boundary. An absent or
// interrupted receipt can never authorize restoring a pre-migration runtime.
export function writePrivateUpdateOutcome(environment, remote) {
  const path = environment[PRIVATE_UPDATE_OUTCOME_ENV];
  if (path === undefined) return;
  if (!isAbsolute(path) || !["not_started", "unknown", "verified"].includes(remote)) throw new Error("invalid private update outcome");
  const parsed = JSON.parse(environment.BRAIN_PRIVATE_UPDATE_BINDING);
  if (!/^[a-f0-9]{64}$/u.test(parsed?.target) || !/^[a-f0-9]{64}$/u.test(parsed?.fingerprint)) {
    throw new Error("invalid private update outcome binding");
  }
  const binding = { target: parsed.target, fingerprint: parsed.fingerprint };
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid()))) {
    throw new Error("unsafe private update outcome directory");
  }
  writeFileSync(path, JSON.stringify({ schema_version: 1, binding, remote }) + "\n", { flag: "wx", mode: 0o600 });
}

export function readPrivateUpdateOutcome(path, binding) {
  try {
    const value = JSON.parse(readStableRegularFile(path, { maxBytes: 2048 }).toString("utf8"));
    return value.schema_version === 1 && value.binding?.target === binding.target &&
      value.binding?.fingerprint === binding.fingerprint && ["not_started", "unknown", "verified"].includes(value.remote)
      ? value.remote : null;
  } catch { return null; }
}

export { privateRuntimeInventory } from "./private-update-runtime.mjs";

/** Capture every owned task before package mutation. The durable originals, not
 * the child's deliberately paused observations, govern all local recovery. */
export async function preparePrivateUpdateSchedule(manifest, manifestPath, environment, options = {}, lockOptions = {}, resume = false) {
  const platform = options.platform ?? process.platform;
  if (!["darwin", "win32"].includes(platform)) return null;
  const principal = options.principal ?? dailyRefreshPrincipal({ platform, environment });
  const plan = { identity: dailyRefreshIdentity(manifest, principal), manifest_path: manifestPath };
  const native = { ...options, platform, adapter: options.adapter ?? createNativeDailyRefreshAdapter({ ...options, platform, environment }) };
  const transactionOptions = { home: options.home ?? environment.HOME, manifestPath, platform,
    machineLockRoot: lockOptions.machineLockRoot, now: lockOptions.now };
  const existing = readDailyRefreshUpdateTransaction(plan, transactionOptions);
  if (existing && (!resume || existing.remote_mutation_may_have_started !== false || !existing.snapshot)) {
    throw new Error("private update recovery must finish before replacing the CLI again");
  }
  if (resume && !existing) return null;
  const state = native.adapter.read(plan.identity);
  if (state?.exists && state.owned !== true) throw new Error("private update found a foreign daily task");
  const snapshot = existing?.snapshot ?? Object.freeze({ identity: plan.identity, exists: state?.exists === true,
    enabled: state?.enabled === true, definition: state?.definition ?? null });
  const additionalOptions = { ...options, platform, principal, nativeSchedulerInventory: true,
    schedulerOptions: { home: transactionOptions.home, ...options.schedulerOptions }, allowAlreadyPaused: true };
  // Windows has permanent daily, historical bridge, and separate accounting
  // tasks. Use the same inventory/ownership validators as the normal update.
  const bridge = platform === "win32" && (manifest.brain?.domain || options.bridgeOptions)
    ? createWindowsUpdateBridgeGuard({ environment, home: transactionOptions.home, ...options.bridgeOptions,
      domain: manifest.brain?.domain, manifestPath }) : null;
  let legacy = existing?.legacy_snapshots ?? (platform === "win32"
    ? await captureAdditionalUpdateSchedulers(manifest, manifestPath, additionalOptions) : []);
  let bridges = bridge ? bridge.capture(bridge.inventory(), existing?.bridge_snapshots) : [];
  let transactionId = existing?.transaction_id;
  const current = () => {
    const receipt = readDailyRefreshUpdateTransaction(plan, transactionOptions);
    if (receipt && receipt.transaction_id !== transactionId) throw new Error("the private update recovery transaction changed");
    return receipt;
  };
  const persist = (phase, remote = false) => {
    transactionId = writeDailyRefreshUpdateTransaction({ plan, snapshot, phase,
      legacySnapshots: legacy, bridgeSnapshots: bridges, remoteMutationMayHaveStarted: remote }, transactionOptions).transaction_id;
  };
  const pause = async () => {
    current();
    if (bridge) bridge.pause(bridges, () => persist("paused"));
    pauseDailyRefreshSchedule(plan, native);
    for (const entry of legacy) await pauseAdditionalUpdateScheduler(manifest, manifestPath, entry, additionalOptions);
  };
  const transaction = {
    pause,
    authorizeRuntimeRollback() {
      if (current()?.remote_mutation_may_have_started !== false) {
        throw new Error("executable rollback lacks durable pre-dispatch authorization");
      }
    },
    async hold() {
      const receipt = current();
      if (receipt) { legacy = receipt.legacy_snapshots; bridges = receipt.bridge_snapshots; }
      persist("recovery_required", true);
      await pause();
    },
    async restore() {
      const receipt = current();
      if (!receipt || receipt.remote_mutation_may_have_started !== false) throw new Error("scheduler restoration is not authorized");
      // A child can add snapshots. Never delete that intent merely because its
      // remote dispatch receipt permits restoration of executable bytes.
      legacy = receipt.legacy_snapshots;
      bridges = receipt.bridge_snapshots;
      const failures = [];
      for (const entry of [...legacy].reverse()) {
        try {
          validateUpdateSchedulerSnapshot(manifest, manifestPath, entry, additionalOptions);
          await restoreAdditionalUpdateScheduler(manifest, manifestPath, entry, additionalOptions);
        } catch { failures.push("additional"); }
      }
      try { if (bridge) bridge.restore(bridges, () => persist("recovery_required"));
        else if (bridges.length) throw new Error("missing bridge recovery adapter");
      } catch { failures.push("bridge"); }
      try { restoreDailyRefreshSchedule(snapshot, native); } catch { failures.push("daily"); }
      if (failures.length) {
        persist("recovery_required");
        try { await pause(); } catch { /* The original intent and fence remain durable. */ }
        throw new Error("private update scheduler restoration is incomplete");
      }
      current();
      clearDailyRefreshUpdateTransaction(plan, transactionOptions);
      releaseUpdateSchedulerReservations(legacy);
    },
    complete() {
      // Only the normal child's full reconciliation may clear this receipt.
      if (current()) throw new Error("private update scheduler reconciliation is incomplete");
    },
  };
  if (resume) return transaction;
  persist("preparing");
  try {
    await pause();
    persist("paused");
  } catch (error) {
    let restored = false;
    try { await transaction.restore(); restored = true; } catch { /* Keep the durable fence. */ }
    // The caller still sees the original cause, but must not treat this run
    // as having changed nothing: tasks, receipt and fence may remain.
    if (!restored) markPreparationUnrestored(error);
    throw error;
  }
  return transaction;
}

const PREPARATION_UNRESTORED = Symbol("private update preparation left recovery state");

function markPreparationUnrestored(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return;
  try { error[PREPARATION_UNRESTORED] = true; } catch { /* Readback below still decides. */ }
}

/** After preparePrivateUpdateSchedule threw, decide under the caller's held
 * lease whether that preparation provably left nothing behind: its own
 * restore completed, and this Brain has no update recovery fence (the gate
 * every later import and update obeys). Anything unreadable is not clean. */
export function privateUpdatePreparationSettled(error, manifestPath, options = {}, lockOptions = {}) {
  if (error !== null && (typeof error === "object" || typeof error === "function") && error[PREPARATION_UNRESTORED]) return false;
  try {
    return readBrainRecoveryFence({ manifestPath, platform: options.platform ?? process.platform,
      machineLockRoot: lockOptions.machineLockRoot }) === null;
  } catch { return false; }
}

/** Retry local recovery under the caller's canonical lifecycle lease. */
export async function recoverPrivateUpdateSchedule(manifest, manifestPath, environment, options = {}, lockOptions = {}) {
  const transaction = await preparePrivateUpdateSchedule(manifest, manifestPath, environment, options, lockOptions, true);
  await transaction?.restore();
}
