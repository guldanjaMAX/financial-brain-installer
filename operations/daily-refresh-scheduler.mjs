/** Cross-platform owned scheduler definitions and update pause/restore rules. */
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix as posixPath, resolve, win32 as win32Path } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  clearBrainRecoveryFence,
  readBrainRecoveryFence,
  writeBrainRecoveryFence,
} from "./brain-lifecycle-lock.mjs";

const OWNER_MARKER = "financial-brain-daily-refresh-v1";

export class DailyRefreshInspectionError extends Error {
  constructor(message = "the Windows daily refresh task could not be inspected", options = {}) {
    super(message, options);
    this.name = "DailyRefreshInspectionError";
    this.code = "DAILY_REFRESH_INSPECTION_UNKNOWN";
  }
}

const hash = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function immutableNativeContract(platform, contract) {
  if (platform !== "win32") return contract;
  const { task_enabled: _mutableEnabledState, ...immutable } = contract;
  return immutable;
}

function dailyClock(cron) {
  const match = String(cron || "").trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/u);
  if (!match) throw new Error("operations.daily_refresh.cron must be one daily numeric minute/hour schedule");
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error("operations.daily_refresh.cron contains an invalid daily time");
  return { minute, hour, hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00` };
}

function observedRealpath(path, options = {}) {
  const resolveRealpath = options.nodeRealpath || realpathSync.native || realpathSync;
  try {
    return String(resolveRealpath(path));
  } catch {
    return null;
  }
}

function sameExecutablePath(left, right, platform) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return platform === "win32"
    ? left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase()
    : left === right;
}

function nodeLauncherDetails(path, platform, options = {}) {
  const exists = options.nodePathExists || existsSync;
  let present = false;
  try { present = Boolean(path && exists(path) === true); } catch { present = false; }
  if (!present) return Object.freeze({ path, present: false, usable: false, realpath: null });

  const realpath = observedRealpath(path, options);
  if (!realpath) return Object.freeze({ path, present: true, usable: false, realpath: null });
  const stat = options.nodePathStat || statSync;
  const access = options.nodePathAccess || accessSync;
  try {
    if (stat(realpath).isFile() !== true) {
      return Object.freeze({ path, present: true, usable: false, realpath });
    }
    access(realpath, fsConstants.X_OK);
    return Object.freeze({ path, present: true, usable: true, realpath });
  } catch {
    return Object.freeze({ path, present: true, usable: false, realpath });
  }
}

function nodeRuntimePaths(platform, executablePath, options = {}) {
  const explicit = options.nodePath ? executablePath(options.nodePath) : null;
  const execPath = executablePath(options.execPath || process.execPath);
  const execRealpath = observedRealpath(execPath, options) || execPath;
  if (explicit) {
    return Object.freeze({ nodePath: explicit, nodeRealpath: observedRealpath(explicit, options) || explicit });
  }

  const pathApi = platform === "win32" ? win32Path : posixPath;
  const candidates = [];
  const pathValue = options.pathValue ?? process.env.PATH ?? process.env.Path ?? "";
  for (const directory of String(pathValue).split(platform === "win32" ? ";" : ":")) {
    if (!directory || !pathApi.isAbsolute(directory)) continue;
    candidates.push(pathApi.join(directory, platform === "win32" ? "node.exe" : "node"));
  }
  const argv0 = String(options.argv0 ?? process.argv0 ?? "");
  if (pathApi.isAbsolute(argv0)) candidates.push(argv0);
  for (const candidate of candidates) {
    const details = nodeLauncherDetails(candidate, platform, options);
    if (!details.usable) continue;
    return Object.freeze({
      nodePath: executablePath(candidate),
      nodeRealpath: details.realpath,
    });
  }
  const fallback = nodeLauncherDetails(execPath, platform, options);
  if (!fallback.usable) throw new Error("the current Node runtime is not a regular executable file");
  return Object.freeze({ nodePath: execPath, nodeRealpath: fallback.realpath || execRealpath });
}

export function buildDailyRefreshDefinition(plan, options = {}) {
  if (!plan?.identity?.id) throw new Error("a daily plan identity is required");
  const platform = options.platform ?? process.platform;
  if (!new Set(["darwin", "win32"]).has(platform)) throw new Error(`daily refresh scheduling is not supported on ${platform}`);
  const clock = dailyClock(plan.cron);
  const name = platform === "darwin"
    ? `com.financialbrain.daily.${plan.identity.id}`
    : `\\Financial Brain\\Daily ${plan.identity.id}`;
  const pathApi = platform === "win32" ? win32Path : posixPath;
  const executablePath = (value) => pathApi.resolve(String(value));
  const { nodePath, nodeRealpath } = nodeRuntimePaths(platform, executablePath, options);
  const urlPath = (value) => fileURLToPath(value, {
    windows: platform === "win32" && /^\/[A-Za-z]:\//u.test(new URL(value).pathname),
  });
  const brainPath = executablePath(options.brainPath || urlPath(options.brainUrl || new URL("../brain.mjs", import.meta.url)));
  const runnerPath = executablePath(options.runnerPath || urlPath(options.runnerUrl || new URL("./daily-refresh-run.mjs", import.meta.url)));
  const payload = {
    contract_version: 1,
    owner_marker: OWNER_MARKER,
    identity: plan.identity,
    name,
    platform,
    node_path: nodePath,
    brain_path: brainPath,
    runner_path: runnerPath,
    manifest_path: plan.manifest_path,
    manifest_path_hash: plan.manifest_path_hash,
    manifest_content_hash: plan.manifest_content_hash,
    source_plan_hash: plan.source_plan_hash,
    cron: plan.cron,
    timezone: plan.timezone,
    max_runtime_minutes: plan.max_runtime_minutes,
  };
  const definitionHash = hash(JSON.stringify(payload));
  const marker = `${OWNER_MARKER}:${plan.identity.id}:${definitionHash}`;
  const args = [runnerPath, "run", plan.manifest_path, "--definition-hash", definitionHash];
  const windowsSid = String(plan.identity.principal || "").startsWith("sid:")
    ? String(plan.identity.principal).slice(4)
    : null;
  const nativeContract = platform === "darwin"
    ? {
        label: name,
        arguments: [nodePath, ...args],
        hour: clock.hour,
        minute: clock.minute,
        run_at_load: true,
        process_type: "Background",
      }
    : {
        command: nodePath,
        arguments: args.map((arg) => `"${arg}"`).join(" "),
        start_boundary: `2000-01-01T${clock.hhmm}`,
        trigger_enabled: true,
        days_interval: 1,
        user_id: windowsSid,
        logon_type: "InteractiveToken",
        run_level: "LeastPrivilege",
        start_when_available: true,
        multiple_instances_policy: "IgnoreNew",
        execution_time_limit: `PT${plan.max_runtime_minutes}M`,
        task_enabled: true,
        disallow_start_on_batteries: false,
        stop_on_batteries: false,
        allow_hard_terminate: true,
        run_only_if_network_available: false,
        stop_on_idle_end: true,
        restart_on_idle: false,
        allow_start_on_demand: true,
        hidden: false,
        run_only_if_idle: false,
        wake_to_run: true,
        priority: 7,
      };
  // Task Scheduler persists Enabled inside the task XML. Pausing is allowed to
  // change that one field, so it is verified separately from the immutable
  // executable, trigger, principal, and safety contract.
  const nativeDefinitionHash = hash(JSON.stringify(immutableNativeContract(platform, nativeContract)));
  const serialized = platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(name)}</string>\n<key>ProgramArguments</key><array><string>${xml(nodePath)}</string>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${clock.hour}</integer><key>Minute</key><integer>${clock.minute}</integer></dict>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Background</string>\n<!-- ${marker} -->\n</dict></plist>\n`
    : `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${xml(marker)}</Description></RegistrationInfo><Triggers><CalendarTrigger><StartBoundary>2000-01-01T${clock.hhmm}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="Owner">${windowsSid ? `<UserId>${xml(windowsSid)}</UserId>` : ""}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>true</WakeToRun><ExecutionTimeLimit>PT${plan.max_runtime_minutes}M</ExecutionTimeLimit><Priority>7</Priority></Settings><Actions Context="Owner"><Exec><Command>${xml(nodePath)}</Command><Arguments>${xml(args.map((arg) => `"${arg}"`).join(" "))}</Arguments></Exec></Actions></Task>\n`;
  return Object.freeze({
    ...payload,
    // The resolved binary is diagnostic evidence only. The stable launcher is
    // the native contract, so a package-manager retarget does not create drift.
    node_realpath: nodeRealpath,
    definition_hash: definitionHash,
    native_contract: Object.freeze(nativeContract),
    native_definition_hash: nativeDefinitionHash,
    serialized,
    receipt: Object.freeze({
      schema_version: 1,
      owner_marker: OWNER_MARKER,
      identity: plan.identity,
      manifest_path_hash: plan.manifest_path_hash,
      manifest_content_hash: plan.manifest_content_hash,
      source_plan_hash: plan.source_plan_hash,
      definition_hash: definitionHash,
      node_path: nodePath,
      node_realpath: nodeRealpath,
      cadence: plan.cron,
      timezone: plan.timezone,
      last_verified_state: "enabled",
    }),
  });
}

function requireOwned(state) {
  if (state?.exists && state.owned !== true) throw new Error("a foreign schedule collides with this Brain and user identity; nothing was changed");
}

function adapterFor(plan, options) {
  return options.adapter || createNativeDailyRefreshAdapter({
    platform: options.platform,
    home: options.home,
    uid: options.uid,
    spawn: options.spawn,
  });
}

function nodePathFromDefinition(definition, platform) {
  return platform === "win32"
    ? definition?.native_contract?.command || null
    : definition?.native_contract?.arguments?.[0] || null;
}

function registeredNodeDetails(definition, platform, options = {}) {
  const path = nodePathFromDefinition(definition, platform);
  return nodeLauncherDetails(path, platform, options);
}

function verifiedState(state, definition, { enabled = true } = {}) {
  return Boolean(state?.exists && state.owned === true && state.enabled === enabled &&
    (!enabled || state.loaded !== false) &&
    state.loaded_definition_matches !== false &&
    state.definition?.definition_hash === definition.definition_hash &&
    state.definition?.native_definition_hash === definition.native_definition_hash);
}

function sameObservedState(left, right) {
  if (!left?.exists || !right?.exists) return left?.exists === right?.exists;
  return left.owned === right.owned && left.enabled === right.enabled &&
    left.definition?.definition_hash === right.definition?.definition_hash &&
    left.definition?.native_definition_hash === right.definition?.native_definition_hash &&
    left.definition?.serialized === right.definition?.serialized &&
    left.loaded_definition_matches === right.loaded_definition_matches;
}

function sameObservedDefinition(left, right) {
  if (!left?.exists || !right?.exists) return left?.exists === right?.exists;
  return left.owned === right.owned &&
    left.definition?.definition_hash === right.definition?.definition_hash &&
    left.definition?.native_definition_hash === right.definition?.native_definition_hash &&
    left.definition?.serialized === right.definition?.serialized;
}

function requireUnchangedMutationRead(read, identity, expected, message, { definitionOnly = false } = {}) {
  const observed = read(identity);
  requireOwned(observed);
  const matches = definitionOnly
    ? sameObservedDefinition(observed, expected)
    : sameObservedState(observed, expected);
  if (!matches) throw new Error(message);
  return observed;
}

export function reconcileDailyRefreshSchedule(plan, options = {}) {
  const desiredEnabled = options.enabled !== false;
  if (desiredEnabled && (!plan?.ready || !plan?.enabled)) throw new Error("an enabled, ready daily plan is required");
  const definition = buildDailyRefreshDefinition(plan, options);
  const adapter = adapterFor(plan, options);
  const existing = adapter.read(plan.identity);
  requireOwned(existing);
  if (verifiedState(existing, definition, { enabled: desiredEnabled })) {
    return Object.freeze({ installed: true, enabled: desiredEnabled, verified: true, definition, readback: existing, changed: false });
  }
  const definitionMatches = existing?.exists === true && existing.owned === true &&
    existing.definition?.definition_hash === definition.definition_hash &&
    existing.definition?.native_definition_hash === definition.native_definition_hash;
  if (definitionMatches && existing.enabled !== desiredEnabled) {
    adapter.setEnabled(plan.identity, desiredEnabled);
    const readback = adapter.read(plan.identity);
    if (!verifiedState(readback, definition, { enabled: desiredEnabled })) {
      throw new Error("daily refresh exact readback did not match the requested enabled state");
    }
    return Object.freeze({ installed: true, enabled: desiredEnabled, verified: true, definition, readback, changed: true });
  }
  try {
    adapter.install(definition, { replaceOwned: existing?.exists === true, expected: existing });
    if (!desiredEnabled) adapter.setEnabled(plan.identity, false);
    const readback = adapter.read(plan.identity);
    if (!verifiedState(readback, definition, { enabled: desiredEnabled })) {
      throw new Error("daily refresh exact readback did not match the installed definition");
    }
    return Object.freeze({ installed: true, enabled: desiredEnabled, verified: true, definition, readback, changed: true });
  } catch (error) {
    try {
      const partial = adapter.read(plan.identity);
      requireOwned(partial);
      if (existing?.exists) {
        adapter.install(existing.definition, { replaceOwned: partial?.exists === true, expected: partial });
        if (existing.enabled !== true) adapter.setEnabled(plan.identity, false);
        const restored = adapter.read(plan.identity);
        if (!verifiedState(restored, existing.definition, { enabled: existing.enabled === true })) {
          throw new Error("the prior definition did not read back exactly");
        }
      } else if (partial?.exists) {
        adapter.remove(plan.identity);
        if (adapter.read(plan.identity)?.exists) throw new Error("the partial definition still exists");
      }
    } catch (rollbackError) {
      throw new Error(`${error.message}; rollback also failed: ${rollbackError.message}`, { cause: error });
    }
    throw error;
  }
}

export function installDailyRefreshSchedule(plan, options = {}) {
  return reconcileDailyRefreshSchedule(plan, { ...options, enabled: true });
}

export function statusDailyRefreshSchedule(plan, options = {}) {
  const platform = options.platform ?? process.platform;
  const adapter = adapterFor(plan, options);
  const state = adapter.read(plan.identity);
  requireOwned(state);
  if (!state?.exists) return Object.freeze({ installed: false, enabled: false, verified: true, identity: plan.identity });
  const expected = buildDailyRefreshDefinition(plan, options);
  const registeredNode = registeredNodeDetails(state.definition, platform, options);
  const registeredPlanDefinition = registeredNode.usable
    ? buildDailyRefreshDefinition(plan, { ...options, nodePath: registeredNode.path })
    : null;
  const registeredPlanMatches = Boolean(registeredPlanDefinition &&
    state.loaded_definition_matches !== false &&
    state.definition?.definition_hash === registeredPlanDefinition.definition_hash &&
    state.definition?.native_definition_hash === registeredPlanDefinition.native_definition_hash);
  const nodePathChanged = registeredPlanMatches &&
    !sameExecutablePath(registeredNode.path, expected.node_path, platform);
  const attention = !registeredNode.present
    ? "daily schedule Node binary is missing; run brain daily on <manifest> to repair it"
    : !registeredNode.usable
      ? "daily schedule Node binary is not executable; run brain daily on <manifest> to repair it"
    : nodePathChanged
      ? "daily schedule needs refresh (Node changed)"
      : null;
  return Object.freeze({
    installed: true,
    enabled: state.enabled === true,
    verified: verifiedState(state, expected, { enabled: state.enabled === true }),
    definition_matches_plan: state.definition?.definition_hash === expected.definition_hash &&
      state.definition?.native_definition_hash === expected.native_definition_hash,
    plan_matches_registered_definition: registeredPlanMatches,
    registered_node_path: registeredNode.path,
    registered_node_realpath: registeredNode.realpath,
    registered_node_present: registeredNode.present,
    registered_node_usable: registeredNode.usable,
    node_path_changed: nodePathChanged,
    needs_refresh: attention !== null,
    attention,
    identity: plan.identity,
    state,
  });
}

export function pauseDailyRefreshSchedule(plan, options = {}) {
  const adapter = adapterFor(plan, options);
  const state = adapter.read(plan.identity);
  requireOwned(state);
  if (!state?.exists) return Object.freeze({ identity: plan.identity, exists: false, enabled: false, definition: null });
  const snapshot = Object.freeze({ identity: plan.identity, exists: true, enabled: state.enabled === true, definition: state.definition });
  if (state.enabled) adapter.setEnabled(plan.identity, false);
  const readback = adapter.read(plan.identity);
  if (!readback?.exists || readback.owned !== true || readback.enabled !== false ||
      readback.definition?.definition_hash !== state.definition?.definition_hash) {
    throw new Error("daily refresh pause exact readback failed");
  }
  return snapshot;
}

export function restoreDailyRefreshSchedule(snapshot, options = {}) {
  const adapter = options.adapter || createNativeDailyRefreshAdapter(options);
  if (!snapshot?.exists) return Object.freeze({ restored: false, verified: true });
  const state = adapter.read(snapshot.identity);
  requireOwned(state);
  if (!state?.exists || state.definition?.definition_hash !== snapshot.definition?.definition_hash) {
    adapter.install(snapshot.definition, { replaceOwned: state?.exists === true, expected: state });
  }
  const current = adapter.read(snapshot.identity);
  if (current?.enabled !== (snapshot.enabled === true)) {
    adapter.setEnabled(snapshot.identity, snapshot.enabled === true);
  }
  const readback = adapter.read(snapshot.identity);
  if (!verifiedState(readback, snapshot.definition, { enabled: snapshot.enabled === true })) {
    throw new Error("daily refresh restore exact readback failed");
  }
  return Object.freeze({ restored: true, verified: true, enabled: snapshot.enabled === true });
}

export function removeDailyRefreshSchedule(plan, options = {}) {
  const adapter = adapterFor(plan, options);
  const state = adapter.read(plan.identity);
  requireOwned(state);
  if (!state?.exists) return Object.freeze({ removed: false, verified: true });
  adapter.remove(plan.identity, { expected: state });
  if (adapter.read(plan.identity)?.exists) throw new Error("daily refresh removal exact readback failed");
  return Object.freeze({ removed: true, verified: true });
}

export async function runUpdateWithDailyRefreshPaused({
  scheduler,
  plan,
  runUpdate,
  verifyFinal,
  recomputePlan,
} = {}) {
  if (!scheduler || typeof runUpdate !== "function" || typeof verifyFinal !== "function" || typeof recomputePlan !== "function") {
    throw new TypeError("the update schedule transaction dependencies are incomplete");
  }
  const snapshot = scheduler.snapshotAndPause(plan);
  try {
    const result = await runUpdate();
    const final = await verifyFinal(result);
    if (final?.active !== true || final?.query_ready !== true || final?.pending !== 0) {
      throw new Error("the updated Brain is not active, query-ready, and queue zero; daily imports remain paused");
    }
    if (result?.status === "noop" || result?.status === "rolled-back") {
      scheduler.restore(snapshot);
      return result;
    }
    const updatedPlan = await recomputePlan();
    if (!updatedPlan?.ready) throw new Error("the updated daily refresh plan is not ready; daily imports remain paused");
    const reconciled = scheduler.reconcile(updatedPlan, snapshot);
    if (reconciled?.verified !== true) throw new Error("the updated daily refresh schedule did not pass exact readback");
    return result;
  } catch (error) {
    if (error?.safe_to_restore === true) scheduler.restore(snapshot);
    else scheduler.leavePaused?.(snapshot, error);
    throw error;
  }
}

export function createNativeDailyRefreshAdapter({
  platform = process.platform,
  home = homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  if (platform === "darwin") return macAdapter({ home, uid, spawn });
  if (platform === "win32") return windowsAdapter({ home, spawn, environment });
  throw new Error(`daily refresh scheduling is not supported on ${platform}`);
}

function markerOf(serialized) {
  const match = String(serialized || "").match(/financial-brain-daily-refresh-v1:(v1-[a-f0-9]+):(sha256:[a-f0-9]{64})/u);
  return match ? { identity: match[1], definition_hash: match[2] } : null;
}

function updateTransactionPath(identity, { home = homedir() } = {}) {
  const id = String(identity?.id || "");
  if (!/^v1-[a-f0-9]{8,64}$/u.test(id)) throw new TypeError("a valid daily refresh identity is required");
  return join(resolve(home), ".brain", "daily-update-transactions", `${id}.json`);
}

function transactionContext(identityOrPlan, options = {}) {
  const identity = identityOrPlan?.identity?.id ? identityOrPlan.identity : identityOrPlan;
  const manifestPath = identityOrPlan?.manifest_path || options.manifestPath || null;
  return { identity, manifestPath };
}

function durableLegacySnapshots(entries = []) {
  return Object.freeze((entries || []).map((entry) => Object.freeze({
    kind: String(entry.kind || ""),
    sourceKey: String(entry.sourceKey || ""),
    ...(entry.provider ? { provider: String(entry.provider) } : {}),
    snapshot: entry.snapshot || null,
  })));
}

export function writeDailyRefreshUpdateTransaction(input = {}, options = {}) {
  const { plan, snapshot, phase, legacySnapshots = [] } = input;
  if (!new Set(["preparing", "paused", "recovery_required"]).has(phase)) {
    throw new TypeError("a valid daily update transaction phase is required");
  }
  if (!plan?.identity?.id || !snapshot || snapshot.identity?.id !== plan.identity.id) {
    throw new TypeError("the daily update snapshot does not match the plan identity");
  }
  const now = options.now ? options.now() : new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("the daily update transaction clock is invalid");
  const path = updateTransactionPath(plan.identity, options);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  let prior = null;
  if (existsSync(path)) {
    try { prior = JSON.parse(readFileSync(path, "utf8")); } catch {}
  }
  const transactionId = /^[a-f0-9]{32}$/u.test(String(prior?.transaction_id || ""))
    ? prior.transaction_id
    : randomBytes(16).toString("hex");
  const authorizedDefinition = Object.hasOwn(input, "authorizedDefinition")
    ? input.authorizedDefinition
    : prior?.authorized_definition ?? snapshot.definition ?? null;
  const reconciliation = Object.freeze({
    daily_definition: input.reconciliation?.daily_definition ?? prior?.reconciliation?.daily_definition ?? "pending",
    source_expectations: input.reconciliation?.source_expectations ?? prior?.reconciliation?.source_expectations ?? "pending",
  });
  if ((authorizedDefinition !== null &&
       (authorizedDefinition?.identity?.id !== plan.identity.id ||
        !/^sha256:[a-f0-9]{64}$/u.test(String(authorizedDefinition?.definition_hash || "")) ||
        !/^sha256:[a-f0-9]{64}$/u.test(String(authorizedDefinition?.native_definition_hash || "")))) ||
      !new Set(["pending", "verified"]).has(reconciliation.daily_definition) ||
      !new Set(["pending", "verified"]).has(reconciliation.source_expectations)) {
    throw new TypeError("the daily update recovery authorization is invalid");
  }
  const receipt = Object.freeze({
    schema_version: 1,
    kind: "daily_refresh_update_transaction",
    identity: plan.identity,
    transaction_id: transactionId,
    manifest_path_hash: plan.manifest_path_hash,
    manifest_content_hash: plan.manifest_content_hash,
    source_plan_hash: plan.source_plan_hash,
    phase,
    updated_at: now.toISOString(),
    snapshot: Object.freeze({
      exists: snapshot.exists === true,
      enabled: snapshot.enabled === true,
      identity: snapshot.identity,
      definition: snapshot.definition || null,
    }),
    authorized_definition: authorizedDefinition,
    reconciliation,
    legacy_snapshots: durableLegacySnapshots(legacySnapshots),
  });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    writeBrainRecoveryFence({
      manifestPath: plan.manifest_path,
      transactionId,
      platform: options.platform,
      machineLockRoot: options.machineLockRoot,
    });
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
  return receipt;
}

export function readDailyRefreshUpdateTransaction(identityOrPlan, options = {}) {
  const { identity, manifestPath } = transactionContext(identityOrPlan, options);
  const path = updateTransactionPath(identity, options);
  const fence = manifestPath ? readBrainRecoveryFence({
    manifestPath,
    platform: options.platform,
    machineLockRoot: options.machineLockRoot,
  }) : null;
  if (!existsSync(path)) {
    return fence ? Object.freeze({
      schema_version: 1,
      kind: "daily_refresh_update_transaction",
      phase: "recovery_required",
      shared_fence: true,
      transaction_id: fence.transaction_id,
      identity,
    }) : null;
  }
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 1024 * 1024) {
    throw new Error("the daily update transaction receipt is unsafe");
  }
  if (process.platform !== "win32" && (state.mode & 0o077) !== 0) {
    throw new Error("the daily update transaction receipt is not private");
  }
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("the daily update transaction receipt is malformed");
  }
  if (value?.schema_version !== 1 || value?.kind !== "daily_refresh_update_transaction" ||
      value?.identity?.id !== identity.id ||
      !/^[a-f0-9]{32}$/u.test(String(value?.transaction_id || "")) ||
      !new Set(["preparing", "paused", "recovery_required"]).has(value?.phase)) {
    throw new Error("the daily update transaction receipt is malformed");
  }
  const authorizedDefinition = value.authorized_definition ?? value.snapshot?.definition ?? null;
  const reconciliation = value.reconciliation ?? {
    daily_definition: "pending",
    source_expectations: "pending",
  };
  if ((authorizedDefinition !== null &&
       (authorizedDefinition?.identity?.id !== identity.id ||
        !/^sha256:[a-f0-9]{64}$/u.test(String(authorizedDefinition?.definition_hash || "")) ||
        !/^sha256:[a-f0-9]{64}$/u.test(String(authorizedDefinition?.native_definition_hash || "")))) ||
      !new Set(["pending", "verified"]).has(reconciliation?.daily_definition) ||
      !new Set(["pending", "verified"]).has(reconciliation?.source_expectations)) {
    throw new Error("the daily update transaction receipt is malformed");
  }
  if (fence && fence.transaction_id !== value.transaction_id) {
    throw new Error("the daily update transaction does not match the Brain recovery fence");
  }
  if (manifestPath && !fence) return null;
  return Object.freeze({
    ...value,
    authorized_definition: authorizedDefinition,
    reconciliation: Object.freeze(reconciliation),
  });
}

export function clearDailyRefreshUpdateTransaction(identityOrPlan, options = {}) {
  const { identity, manifestPath } = transactionContext(identityOrPlan, options);
  const path = updateTransactionPath(identity, options);
  if (!existsSync(path)) {
    const fence = manifestPath ? readBrainRecoveryFence({
      manifestPath,
      platform: options.platform,
      machineLockRoot: options.machineLockRoot,
    }) : null;
    if (fence) throw new Error("the Brain recovery fence has no local schedule transaction");
    return false;
  }
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new Error("the daily update transaction receipt is unsafe");
  }
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("the daily update transaction receipt is malformed");
  }
  if (manifestPath) {
    clearBrainRecoveryFence({
      manifestPath,
      transactionId: value.transaction_id,
      platform: options.platform,
      machineLockRoot: options.machineLockRoot,
    });
  }
  unlinkSync(path);
  return true;
}

function decodeXml(value) {
  return String(value || "").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function tag(serialized, name) {
  const match = String(serialized).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "iu"));
  return match ? decodeXml(match[1].trim()) : null;
}

function boolTag(serialized, name) {
  const value = tag(serialized, name);
  return value === null ? null : value.toLowerCase() === "true";
}

function tagCount(serialized, name) {
  return [...String(serialized || "").matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>`, "giu"))].length;
}

function exactlyOne(serialized, names) {
  return names.every((name) => tagCount(serialized, name) === 1);
}

function directChildNames(serialized) {
  const names = [];
  let depth = 0;
  for (const match of String(serialized || "").matchAll(/<\/?([A-Za-z][A-Za-z0-9:_-]*)(?:\s[^>]*)?\s*\/?>/gu)) {
    const token = match[0];
    if (token.startsWith("</")) {
      depth -= 1;
    } else {
      if (depth === 0) names.push(match[1]);
      if (!token.endsWith("/>") ) depth += 1;
    }
  }
  return names;
}

function sameNames(actual, expected) {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function observedWindowsContract(serialized) {
  const text = String(serialized || "");
  const actions = text.match(/<Actions(?:\s[^>]*)?>([\s\S]*?)<\/Actions>/iu)?.[1] || "";
  const triggers = text.match(/<Triggers(?:\s[^>]*)?>([\s\S]*?)<\/Triggers>/iu)?.[1] || "";
  const principals = text.match(/<Principals(?:\s[^>]*)?>([\s\S]*?)<\/Principals>/iu)?.[1] || "";
  const exec = actions.match(/<Exec(?:\s[^>]*)?>([\s\S]*?)<\/Exec>/iu)?.[1] || "";
  const calendar = triggers.match(/<CalendarTrigger(?:\s[^>]*)?>([\s\S]*?)<\/CalendarTrigger>/iu)?.[1] || "";
  const scheduleByDay = calendar.match(/<ScheduleByDay(?:\s[^>]*)?>([\s\S]*?)<\/ScheduleByDay>/iu)?.[1] || "";
  const principal = principals.match(/<Principal(?:\s[^>]*)?>([\s\S]*?)<\/Principal>/iu)?.[1] || "";
  const settings = text.match(/<Settings(?:\s[^>]*)?>([\s\S]*?)<\/Settings>/iu)?.[1] || "";
  const idleSettings = settings.match(/<IdleSettings(?:\s[^>]*)?>([\s\S]*?)<\/IdleSettings>/iu)?.[1] || "";
  const principalNames = directChildNames(principal);
  const expectedPrincipalNames = tag(principal, "UserId") === null
    ? ["LogonType", "RunLevel"]
    : ["UserId", "LogonType", "RunLevel"];
  const valid = exactlyOne(text, [
    "Actions", "Exec", "Command", "Arguments", "Triggers", "CalendarTrigger", "StartBoundary",
    "ScheduleByDay", "DaysInterval", "Principals", "Principal", "LogonType", "RunLevel", "Settings",
    "StartWhenAvailable", "MultipleInstancesPolicy", "ExecutionTimeLimit",
  ]) && tagCount(text, "Enabled") === 2 &&
    sameNames(directChildNames(actions), ["Exec"]) &&
    sameNames(directChildNames(exec), ["Command", "Arguments"]) &&
    sameNames(directChildNames(triggers), ["CalendarTrigger"]) &&
    sameNames(directChildNames(calendar), ["StartBoundary", "Enabled", "ScheduleByDay"]) &&
    sameNames(directChildNames(scheduleByDay), ["DaysInterval"]) &&
    sameNames(directChildNames(principals), ["Principal"]) &&
    sameNames(principalNames, expectedPrincipalNames) &&
    sameNames(directChildNames(settings), [
      "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries",
      "AllowHardTerminate", "StartWhenAvailable", "RunOnlyIfNetworkAvailable", "IdleSettings",
      "AllowStartOnDemand", "Enabled", "Hidden", "RunOnlyIfIdle", "WakeToRun", "ExecutionTimeLimit", "Priority",
    ]) && sameNames(directChildNames(idleSettings), ["StopOnIdleEnd", "RestartOnIdle"]);
  const contract = {
    command: tag(serialized, "Command"),
    arguments: tag(serialized, "Arguments"),
    start_boundary: tag(serialized, "StartBoundary"),
    trigger_enabled: boolTag(serialized, "Enabled"),
    days_interval: Number(tag(serialized, "DaysInterval")),
    user_id: tag(serialized, "UserId"),
    logon_type: tag(serialized, "LogonType"),
    run_level: tag(serialized, "RunLevel"),
    start_when_available: boolTag(serialized, "StartWhenAvailable"),
    multiple_instances_policy: tag(serialized, "MultipleInstancesPolicy"),
    execution_time_limit: tag(serialized, "ExecutionTimeLimit"),
    task_enabled: boolTag(settings, "Enabled"),
    disallow_start_on_batteries: boolTag(settings, "DisallowStartIfOnBatteries"),
    stop_on_batteries: boolTag(settings, "StopIfGoingOnBatteries"),
    allow_hard_terminate: boolTag(settings, "AllowHardTerminate"),
    run_only_if_network_available: boolTag(settings, "RunOnlyIfNetworkAvailable"),
    stop_on_idle_end: boolTag(idleSettings, "StopOnIdleEnd"),
    restart_on_idle: boolTag(idleSettings, "RestartOnIdle"),
    allow_start_on_demand: boolTag(settings, "AllowStartOnDemand"),
    hidden: boolTag(settings, "Hidden"),
    run_only_if_idle: boolTag(settings, "RunOnlyIfIdle"),
    wake_to_run: boolTag(settings, "WakeToRun"),
    priority: Number(tag(settings, "Priority")),
  };
  return { valid, contract };
}

function observedMacContract(serialized) {
  const argumentsBlock = String(serialized).match(/<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/iu)?.[1] || "";
  const argumentsList = [...argumentsBlock.matchAll(/<string>([\s\S]*?)<\/string>/giu)].map((match) => decodeXml(match[1]));
  const calendar = String(serialized).match(/<key>StartCalendarInterval<\/key><dict>([\s\S]*?)<\/dict>/iu)?.[1] || "";
  const integerAfter = (key) => Number(calendar.match(new RegExp(`<key>${key}<\\/key><integer>(\\d+)<\\/integer>`, "iu"))?.[1]);
  const contract = {
    label: String(serialized).match(/<key>Label<\/key><string>([\s\S]*?)<\/string>/iu) ?
      decodeXml(String(serialized).match(/<key>Label<\/key><string>([\s\S]*?)<\/string>/iu)[1]) : null,
    arguments: argumentsList,
    hour: integerAfter("Hour"),
    minute: integerAfter("Minute"),
    run_at_load: /<key>RunAtLoad<\/key><true\s*\/>/iu.test(serialized),
    process_type: String(serialized).match(/<key>ProcessType<\/key><string>([\s\S]*?)<\/string>/iu) ?
      decodeXml(String(serialized).match(/<key>ProcessType<\/key><string>([\s\S]*?)<\/string>/iu)[1]) : null,
  };
  const keys = [...String(serialized).matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);
  const valid = argumentsList.length === 6 &&
    [...String(serialized).matchAll(/<key>ProgramArguments<\/key>/giu)].length === 1 &&
    [...String(serialized).matchAll(/<key>StartCalendarInterval<\/key>/giu)].length === 1 &&
    [...String(serialized).matchAll(/<key>Label<\/key>/giu)].length === 1 &&
    sameNames(keys, ["Label", "ProgramArguments", "StartCalendarInterval", "Hour", "Minute", "RunAtLoad", "ProcessType"]);
  return { valid, contract };
}

function definitionFromNative(identity, serialized, platform) {
  const marker = markerOf(serialized);
  const observed = platform === "win32"
    ? observedWindowsContract(serialized)
    : observedMacContract(serialized);
  return {
    identity,
    definition_hash: marker?.definition_hash || null,
    native_contract: observed.contract,
    native_definition_hash: observed.valid
      ? hash(JSON.stringify(immutableNativeContract(platform, observed.contract)))
      : null,
    native_contract_valid: observed.valid,
    serialized,
  };
}

function loadedMacProgramMatches(serialized, output) {
  const expected = observedMacContract(serialized);
  if (!expected.valid) return false;
  const text = String(output || "");
  const match = text.match(/^\s*program\s*=\s*(.+?)\s*$/imu);
  const block = text.match(/^\s*arguments\s*=\s*\{([\s\S]*?)^\s*\}\s*$/imu)?.[1] || null;
  if (!match || block === null || match[1] !== expected.contract.arguments[0]) return false;
  const observedArguments = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.replace(/^\d+\s*=\s*/u, ""));
  return observedArguments.length === expected.contract.arguments.length &&
    observedArguments.every((argument, index) => argument === expected.contract.arguments[index]);
}

function withScheduleMutationLock(home, identity, task) {
  const root = join(resolve(home), ".brain", "schedule-mutations");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, `${identity.id}.lock`);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("this owned daily schedule is already being changed; no concurrent mutation was attempted");
    }
    throw error;
  }
  try {
    return task();
  } finally {
    try { rmdirSync(path); } catch {}
  }
}

function macAdapter({ home, uid, spawn }) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("the macOS user id is unavailable");
  const launchctl = (args) => spawn("/bin/launchctl", args, { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  const pathOf = (identity) => join(resolve(home), "Library", "LaunchAgents", `com.financialbrain.daily.${identity.id}.plist`);
  const serviceOf = (identity) => `gui/${uid}/com.financialbrain.daily.${identity.id}`;
  const read = (identity) => {
    const path = pathOf(identity);
    if (!existsSync(path)) return null;
    const fileState = lstatSync(path);
    if (!fileState.isFile() || fileState.isSymbolicLink() || fileState.nlink !== 1 ||
        (typeof process.getuid === "function" && fileState.uid !== process.getuid())) {
      throw new Error("the macOS daily refresh definition is unsafe");
    }
    const serialized = readFileSync(path, "utf8");
    const status = launchctl(["print", serviceOf(identity)]);
    if (status?.status !== 0 && status?.status !== 1 && status?.status !== 113) {
      throw new Error("the macOS daily refresh service could not be inspected");
    }
    const disabledState = launchctl(["print-disabled", `gui/${uid}`]);
    if (disabledState?.status !== 0) throw new Error("the macOS daily refresh disabled state could not be inspected");
    const disabled = new RegExp(`"?com\\.financialbrain\\.daily\\.${identity.id}"?\\s*=>\\s*true`, "u").test(String(disabledState.stdout || ""));
    const definition = definitionFromNative(identity, serialized, "darwin");
    return {
      exists: true,
      owned: markerOf(serialized)?.identity === identity.id,
      enabled: !disabled,
      loaded: status?.status === 0,
      loaded_definition_matches: status?.status === 0
        ? loadedMacProgramMatches(serialized, status.stdout)
        : null,
      definition,
    };
  };
  return {
    read,
    install(definition, { replaceOwned = false, expected = null } = {}) {
      return withScheduleMutationLock(home, definition.identity, () => {
        const path = pathOf(definition.identity);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const staged = `${path}.tmp-${process.pid}`;
        try {
          writeFileSync(staged, definition.serialized, { mode: 0o600, flag: "wx" });
          const current = read(definition.identity);
          if (!sameObservedState(current, expected)) throw new Error("the daily definition changed before installation; nothing was replaced");
          if (current?.exists) {
            requireOwned(current);
            if (!replaceOwned) throw new Error("the owned daily definition appeared during installation; nothing was replaced");
            requireUnchangedMutationRead(
              read,
              definition.identity,
              current,
              "the daily definition changed immediately before replacement; nothing was replaced",
            );
            launchctl(["bootout", serviceOf(definition.identity)]);
          }
          requireUnchangedMutationRead(
            read,
            definition.identity,
            current,
            "the daily definition changed immediately before installation; nothing was replaced",
            { definitionOnly: true },
          );
          renameSync(staged, path);
          const installed = read(definition.identity);
          if (!installed?.exists || installed.owned !== true ||
              installed.definition?.definition_hash !== definition.definition_hash ||
              installed.definition?.native_definition_hash !== definition.native_definition_hash) {
            throw new Error("the installed daily definition changed before launchd enable; nothing was loaded");
          }
          const enabled = launchctl(["enable", serviceOf(definition.identity)]);
          requireUnchangedMutationRead(
            read,
            definition.identity,
            installed,
            "the installed daily definition changed before launchd bootstrap; nothing was loaded",
            { definitionOnly: true },
          );
          const loaded = launchctl(["bootstrap", `gui/${uid}`, path]);
          if (enabled?.status !== 0 || loaded?.status !== 0) throw new Error("launchd refused the daily refresh definition");
        } finally {
          try { unlinkSync(staged); } catch {}
        }
      });
    },
    setEnabled(identity, enabled) {
      return withScheduleMutationLock(home, identity, () => {
        const current = read(identity);
        requireOwned(current);
        requireUnchangedMutationRead(
          read,
          identity,
          current,
          `the daily definition changed immediately before ${enabled ? "restore" : "pause"}; nothing was changed`,
        );
        if (enabled) {
          const enabledResult = launchctl(["enable", serviceOf(identity)]);
          if (enabledResult?.status !== 0) throw new Error("launchd could not persistently enable daily refresh");
          requireUnchangedMutationRead(
            read,
            identity,
            current,
            "the daily definition changed before launchd bootstrap; nothing was loaded",
            { definitionOnly: true },
          );
          const loaded = launchctl(["bootstrap", `gui/${uid}`, pathOf(identity)]);
          if (loaded?.status !== 0) throw new Error("launchd could not restore daily refresh");
        } else {
          const stopped = launchctl(["bootout", serviceOf(identity)]);
          if (stopped?.status !== 0 && stopped?.status !== 1 && stopped?.status !== 113) {
            throw new Error("launchd could not pause daily refresh");
          }
          requireUnchangedMutationRead(
            read,
            identity,
            current,
            "the daily definition changed before launchd disable; nothing else was changed",
            { definitionOnly: true },
          );
          const disabled = launchctl(["disable", serviceOf(identity)]);
          if (disabled?.status !== 0) throw new Error("launchd could not persistently disable daily refresh");
        }
      });
    },
    remove(identity, { expected = null } = {}) {
      return withScheduleMutationLock(home, identity, () => {
        const current = read(identity);
        requireOwned(current);
        if (!sameObservedState(current, expected)) throw new Error("the daily definition changed before removal; nothing was removed");
        requireUnchangedMutationRead(
          read,
          identity,
          current,
          "the daily definition changed immediately before removal; nothing was removed",
        );
        launchctl(["bootout", serviceOf(identity)]);
        requireUnchangedMutationRead(
          read,
          identity,
          current,
          "the daily definition changed before its file could be removed; nothing was removed",
          { definitionOnly: true },
        );
        unlinkSync(pathOf(identity));
      });
    },
  };
}

export function parseWindowsTaskInventory(output) {
  const rows = String(output || "")
    .replace(/^\ufeff/u, "")
    .split(/\r\n|[\r\n]/u)
    .filter((line) => !/^\s*$/u.test(line));
  if (!rows.length) throw new DailyRefreshInspectionError();
  const names = rows.map((line) => {
    const fields = [];
    let index = 0;
    while (index < line.length) {
      if (line[index] !== '"') throw new DailyRefreshInspectionError();
      index += 1;
      let field = "";
      let closed = false;
      while (index < line.length) {
        if (line[index] === '"' && line[index + 1] === '"') { field += '"'; index += 2; continue; }
        if (line[index] === '"') { index += 1; closed = true; break; }
        field += line[index++];
      }
      if (!closed || (index < line.length && line[index] !== ",")) {
        throw new DailyRefreshInspectionError();
      }
      fields.push(field);
      if (index < line.length) {
        index += 1;
        if (index === line.length) throw new DailyRefreshInspectionError();
      }
    }
    // /Query without /V has exactly these three columns. The localized next-run
    // time and status may legitimately be empty or N/A; only the task name is
    // required to prove that a complete row participates in the inventory.
    if (fields.length !== 3 || !fields[0]) throw new DailyRefreshInspectionError();
    return fields[0];
  });
  return Object.freeze(names);
}

function windowsAdapter({ home, spawn, environment }) {
  const taskName = (identity) => `\\Financial Brain\\Daily ${identity.id}`;
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  // Unit tests on another host inject the process runner. A real Windows process
  // must use the OS-owned executable directly because the allowlisted child
  // environment deliberately has no PATH.
  if (process.platform === "win32" && !win32Path.isAbsolute(String(systemRoot || ""))) {
    throw new DailyRefreshInspectionError("the Windows system runtime directory is unavailable");
  }
  const command = win32Path.isAbsolute(String(systemRoot || ""))
    ? win32Path.join(systemRoot, "System32", "schtasks.exe")
    : "fixture-windows-schtasks";
  const childEnvironment = {};
  if (systemRoot) childEnvironment.SystemRoot = systemRoot;
  if (environment.WINDIR) childEnvironment.WINDIR = environment.WINDIR;
  const run = (args) => {
    try {
      return spawn(command, args, {
        encoding: "utf8",
        windowsHide: true,
        env: childEnvironment,
      });
    } catch (cause) {
      return { status: null, error: cause };
    }
  };
  const read = (identity) => {
    const result = run(["/Query", "/TN", taskName(identity), "/XML"]);
    if (result?.status !== 0) {
      const inventory = run(["/Query", "/FO", "CSV", "/NH"]);
      if (inventory?.status === 0) {
        const names = parseWindowsTaskInventory(inventory.stdout);
        if (!names.includes(taskName(identity))) return null;
      }
      throw new DailyRefreshInspectionError();
    }
    const serialized = String(result.stdout || "");
    const marker = markerOf(serialized);
    const disabled = /<Enabled>\s*false\s*<\/Enabled>/iu.test(serialized);
    return {
      exists: true,
      owned: marker?.identity === identity.id,
      enabled: !disabled,
      definition: definitionFromNative(identity, serialized, "win32"),
    };
  };
  return {
    read,
    install(definition, { replaceOwned = false, expected = null } = {}) {
      return withScheduleMutationLock(home, definition.identity, () => {
        const directory = join(resolve(home), ".brain", "schedules");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `daily-${definition.identity.id}-${process.pid}.xml`);
        try {
          writeFileSync(path, `\ufeff${definition.serialized}`, { encoding: "utf16le", mode: 0o600, flag: "wx" });
          const current = read(definition.identity);
          if (!sameObservedState(current, expected)) throw new Error("the daily definition changed before installation; nothing was replaced");
          if (current?.exists) {
            requireOwned(current);
            if (!replaceOwned) throw new Error("the owned daily definition appeared during installation; nothing was replaced");
          }
          requireUnchangedMutationRead(
            read,
            definition.identity,
            current,
            "the daily definition changed immediately before installation; nothing was replaced",
          );
          // schtasks has no compare-and-create/replace primitive. Keep this
          // final owned-definition read immediately adjacent to the mutation.
          const result = run(["/Create", ...(current?.exists ? ["/F"] : []), "/TN", taskName(definition.identity), "/XML", path]);
          if (result?.status !== 0) throw new Error("Task Scheduler refused the daily refresh definition");
        } finally {
          try { unlinkSync(path); } catch {}
        }
      });
    },
    setEnabled(identity, enabled) {
      return withScheduleMutationLock(home, identity, () => {
        const current = read(identity);
        requireOwned(current);
        requireUnchangedMutationRead(
          read,
          identity,
          current,
          `the daily definition changed immediately before ${enabled ? "restore" : "pause"}; nothing was changed`,
        );
        // schtasks has no compare-and-change primitive. Keep this final
        // owned-definition read immediately adjacent to the mutation.
        const result = run(["/Change", "/TN", taskName(identity), enabled ? "/ENABLE" : "/DISABLE"]);
        if (result?.status !== 0) throw new Error(`Task Scheduler could not ${enabled ? "restore" : "pause"} daily refresh`);
      });
    },
    remove(identity, { expected = null } = {}) {
      return withScheduleMutationLock(home, identity, () => {
        const current = read(identity);
        requireOwned(current);
        if (!sameObservedState(current, expected)) throw new Error("the daily definition changed before removal; nothing was removed");
        requireUnchangedMutationRead(
          read,
          identity,
          current,
          "the daily definition changed immediately before removal; nothing was removed",
        );
        // schtasks has no compare-and-delete primitive. Keep this final
        // owned-definition read immediately adjacent to the mutation.
        const result = run(["/Delete", "/F", "/TN", taskName(identity)]);
        if (result?.status !== 0) throw new Error("Task Scheduler could not remove daily refresh");
      });
    },
  };
}
