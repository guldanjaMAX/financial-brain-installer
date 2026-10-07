/** Cross-platform owned scheduler definitions and update pause/restore rules. */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OWNER_MARKER = "financial-brain-daily-refresh-v1";

const hash = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function dailyClock(cron) {
  const match = String(cron || "").trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/u);
  if (!match) throw new Error("operations.daily_refresh.cron must be one daily numeric minute/hour schedule");
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error("operations.daily_refresh.cron contains an invalid daily time");
  return { minute, hour, hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00` };
}

export function buildDailyRefreshDefinition(plan, options = {}) {
  if (!plan?.identity?.id) throw new Error("a daily plan identity is required");
  const platform = options.platform ?? process.platform;
  if (!new Set(["darwin", "win32"]).has(platform)) throw new Error(`daily refresh scheduling is not supported on ${platform}`);
  const clock = dailyClock(plan.cron);
  const name = platform === "darwin"
    ? `com.financialbrain.daily.${plan.identity.id}`
    : `\\Financial Brain\\Daily ${plan.identity.id}`;
  const executablePath = (value) => platform === "win32" && /^[A-Za-z]:[\\/]/u.test(String(value))
    ? String(value)
    : resolve(String(value));
  const nodePath = executablePath(options.nodePath || process.execPath);
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
      };
  const nativeDefinitionHash = hash(JSON.stringify(nativeContract));
  const serialized = platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(name)}</string>\n<key>ProgramArguments</key><array><string>${xml(nodePath)}</string>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${clock.hour}</integer><key>Minute</key><integer>${clock.minute}</integer></dict>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Background</string>\n<!-- ${marker} -->\n</dict></plist>\n`
    : `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${xml(marker)}</Description></RegistrationInfo><Triggers><CalendarTrigger><StartBoundary>2000-01-01T${clock.hhmm}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="Owner">${windowsSid ? `<UserId>${xml(windowsSid)}</UserId>` : ""}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><StartWhenAvailable>true</StartWhenAvailable><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT${plan.max_runtime_minutes}M</ExecutionTimeLimit></Settings><Actions Context="Owner"><Exec><Command>${xml(nodePath)}</Command><Arguments>${xml(args.map((arg) => `"${arg}"`).join(" "))}</Arguments></Exec></Actions></Task>\n`;
  return Object.freeze({
    ...payload,
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

function verifiedState(state, definition, { enabled = true } = {}) {
  return Boolean(state?.exists && state.owned === true && state.enabled === enabled &&
    (!enabled || state.loaded !== false) &&
    state.definition?.definition_hash === definition.definition_hash &&
    state.definition?.native_definition_hash === definition.native_definition_hash);
}

function sameObservedState(left, right) {
  if (!left?.exists || !right?.exists) return left?.exists === right?.exists;
  return left.owned === right.owned && left.enabled === right.enabled &&
    left.definition?.definition_hash === right.definition?.definition_hash &&
    left.definition?.native_definition_hash === right.definition?.native_definition_hash &&
    left.definition?.serialized === right.definition?.serialized;
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
  const adapter = adapterFor(plan, options);
  const state = adapter.read(plan.identity);
  requireOwned(state);
  if (!state?.exists) return Object.freeze({ installed: false, enabled: false, verified: true, identity: plan.identity });
  const expected = buildDailyRefreshDefinition(plan, options);
  return Object.freeze({
    installed: true,
    enabled: state.enabled === true,
    verified: verifiedState(state, expected, { enabled: state.enabled === true }),
    definition_matches_plan: state.definition?.definition_hash === expected.definition_hash &&
      state.definition?.native_definition_hash === expected.native_definition_hash,
    identity: plan.identity,
    state,
  });
}

export function pauseDailyRefreshSchedule(plan, options = {}) {
  const adapter = adapterFor(plan, options);
  const state = adapter.read(plan.identity);
  requireOwned(state);
  if (!state?.exists) return Object.freeze({ identity: plan.identity, exists: false, enabled: false, definition: null });
  const authorized = options.authorizedDefinition || buildDailyRefreshDefinition(plan, options);
  if (state.definition?.definition_hash !== authorized.definition_hash ||
      state.definition?.native_definition_hash !== authorized.native_definition_hash) {
    throw new Error("the owned daily refresh definition does not match the authorized plan; nothing was paused");
  }
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
  const authorized = options.authorizedDefinition || buildDailyRefreshDefinition(plan, options);
  if (state.definition?.definition_hash !== authorized.definition_hash ||
      state.definition?.native_definition_hash !== authorized.native_definition_hash) {
    throw new Error("the owned daily refresh definition does not match the authorized plan; nothing was removed");
  }
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
} = {}) {
  if (platform === "darwin") return macAdapter({ home, uid, spawn });
  if (platform === "win32") return windowsAdapter({ home, spawn });
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

export function writeDailyRefreshUpdateTransaction({ plan, snapshot, phase } = {}, options = {}) {
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
  const receipt = Object.freeze({
    schema_version: 1,
    kind: "daily_refresh_update_transaction",
    identity: plan.identity,
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
  });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
  return receipt;
}

export function readDailyRefreshUpdateTransaction(identity, options = {}) {
  const path = updateTransactionPath(identity, options);
  if (!existsSync(path)) return null;
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
      !new Set(["preparing", "paused", "recovery_required"]).has(value?.phase)) {
    throw new Error("the daily update transaction receipt is malformed");
  }
  return Object.freeze(value);
}

export function clearDailyRefreshUpdateTransaction(identity, options = {}) {
  const path = updateTransactionPath(identity, options);
  if (!existsSync(path)) return false;
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new Error("the daily update transaction receipt is unsafe");
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

function observedWindowsContract(serialized) {
  return {
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
  };
}

function observedMacContract(serialized) {
  const argumentsBlock = String(serialized).match(/<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/iu)?.[1] || "";
  const argumentsList = [...argumentsBlock.matchAll(/<string>([\s\S]*?)<\/string>/giu)].map((match) => decodeXml(match[1]));
  const calendar = String(serialized).match(/<key>StartCalendarInterval<\/key><dict>([\s\S]*?)<\/dict>/iu)?.[1] || "";
  const integerAfter = (key) => Number(calendar.match(new RegExp(`<key>${key}<\\/key><integer>(\\d+)<\\/integer>`, "iu"))?.[1]);
  return {
    label: String(serialized).match(/<key>Label<\/key><string>([\s\S]*?)<\/string>/iu) ?
      decodeXml(String(serialized).match(/<key>Label<\/key><string>([\s\S]*?)<\/string>/iu)[1]) : null,
    arguments: argumentsList,
    hour: integerAfter("Hour"),
    minute: integerAfter("Minute"),
    run_at_load: /<key>RunAtLoad<\/key><true\s*\/>/iu.test(serialized),
    process_type: String(serialized).match(/<key>ProcessType<\/key><string>([\s\S]*?)<\/string>/iu) ?
      decodeXml(String(serialized).match(/<key>ProcessType<\/key><string>([\s\S]*?)<\/string>/iu)[1]) : null,
  };
}

function definitionFromNative(identity, serialized, platform) {
  const marker = markerOf(serialized);
  const nativeContract = platform === "win32"
    ? observedWindowsContract(serialized)
    : observedMacContract(serialized);
  return {
    identity,
    definition_hash: marker?.definition_hash || null,
    native_contract: nativeContract,
    native_definition_hash: hash(JSON.stringify(nativeContract)),
    serialized,
  };
}

function macAdapter({ home, uid, spawn }) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("the macOS user id is unavailable");
  const launchctl = (args) => spawn("/bin/launchctl", args, { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  const pathOf = (identity) => join(resolve(home), "Library", "LaunchAgents", `com.financialbrain.daily.${identity.id}.plist`);
  const serviceOf = (identity) => `gui/${uid}/com.financialbrain.daily.${identity.id}`;
  const read = (identity) => {
    const path = pathOf(identity);
    if (!existsSync(path)) return null;
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
      definition,
    };
  };
  return {
    read,
    install(definition, { replaceOwned = false, expected = null } = {}) {
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
          launchctl(["bootout", serviceOf(definition.identity)]);
        }
        renameSync(staged, path);
        const enabled = launchctl(["enable", serviceOf(definition.identity)]);
        const loaded = launchctl(["bootstrap", `gui/${uid}`, path]);
        if (enabled?.status !== 0 || loaded?.status !== 0) throw new Error("launchd refused the daily refresh definition");
      } finally {
        try { unlinkSync(staged); } catch {}
      }
    },
    setEnabled(identity, enabled) {
      requireOwned(read(identity));
      if (enabled) {
        const enabledResult = launchctl(["enable", serviceOf(identity)]);
        if (enabledResult?.status !== 0) throw new Error("launchd could not persistently enable daily refresh");
        const loaded = launchctl(["bootstrap", `gui/${uid}`, pathOf(identity)]);
        if (loaded?.status !== 0) throw new Error("launchd could not restore daily refresh");
      } else {
        const stopped = launchctl(["bootout", serviceOf(identity)]);
        if (stopped?.status !== 0 && stopped?.status !== 1 && stopped?.status !== 113) {
          throw new Error("launchd could not pause daily refresh");
        }
        const disabled = launchctl(["disable", serviceOf(identity)]);
        if (disabled?.status !== 0) throw new Error("launchd could not persistently disable daily refresh");
      }
    },
    remove(identity, { expected = null } = {}) {
      const current = read(identity);
      requireOwned(current);
      if (!sameObservedState(current, expected)) throw new Error("the daily definition changed before removal; nothing was removed");
      launchctl(["bootout", serviceOf(identity)]);
      unlinkSync(pathOf(identity));
    },
  };
}

function windowsAdapter({ home, spawn }) {
  const taskName = (identity) => `\\Financial Brain\\Daily ${identity.id}`;
  const run = (args) => spawn("schtasks.exe", args, { encoding: "utf8", windowsHide: true, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
  const read = (identity) => {
    const result = run(["/Query", "/TN", taskName(identity), "/XML"]);
    if (result?.status !== 0) {
      const inventory = run(["/Query", "/FO", "CSV", "/NH"]);
      if (inventory?.status === 0) {
        const names = String(inventory.stdout || "").split(/\r?\n/u).map((line) => {
          const match = line.match(/^"((?:[^"]|"")*)"(?:,|$)/u);
          return match ? match[1].replaceAll('""', '"') : null;
        }).filter(Boolean);
        if (!names.includes(taskName(identity))) return null;
      }
      throw new Error("the Windows daily refresh task could not be inspected");
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
        const result = run(["/Create", ...(current?.exists ? ["/F"] : []), "/TN", taskName(definition.identity), "/XML", path]);
        if (result?.status !== 0) throw new Error("Task Scheduler refused the daily refresh definition");
      } finally {
        try { unlinkSync(path); } catch {}
      }
    },
    setEnabled(identity, enabled) {
      requireOwned(read(identity));
      const result = run(["/Change", "/TN", taskName(identity), enabled ? "/ENABLE" : "/DISABLE"]);
      if (result?.status !== 0) throw new Error(`Task Scheduler could not ${enabled ? "restore" : "pause"} daily refresh`);
    },
    remove(identity, { expected = null } = {}) {
      const current = read(identity);
      requireOwned(current);
      if (!sameObservedState(current, expected)) throw new Error("the daily definition changed before removal; nothing was removed");
      const result = run(["/Delete", "/F", "/TN", taskName(identity)]);
      if (result?.status !== 0) throw new Error("Task Scheduler could not remove daily refresh");
    },
  };
}
