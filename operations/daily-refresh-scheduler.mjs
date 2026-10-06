/** Cross-platform owned scheduler definitions and update pause/restore rules. */
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
  const brainPath = executablePath(options.brainPath || new URL("../brain.mjs", import.meta.url).pathname);
  const runnerPath = executablePath(options.runnerPath || new URL("./daily-refresh-run.mjs", import.meta.url).pathname);
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
  const serialized = platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(name)}</string>\n<key>ProgramArguments</key><array><string>${xml(nodePath)}</string>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${clock.hour}</integer><key>Minute</key><integer>${clock.minute}</integer></dict>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Background</string>\n<!-- ${marker} -->\n</dict></plist>\n`
    : `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${xml(marker)}</Description></RegistrationInfo><Triggers><CalendarTrigger><StartBoundary>2000-01-01T${clock.hhmm}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="Owner"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><StartWhenAvailable>true</StartWhenAvailable><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT${plan.max_runtime_minutes}M</ExecutionTimeLimit></Settings><Actions Context="Owner"><Exec><Command>${xml(nodePath)}</Command><Arguments>${xml(args.map((arg) => `"${arg}"`).join(" "))}</Arguments></Exec></Actions></Task>\n`;
  return Object.freeze({
    ...payload,
    definition_hash: definitionHash,
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
    state.definition?.definition_hash === definition.definition_hash);
}

export function reconcileDailyRefreshSchedule(plan, options = {}) {
  const desiredEnabled = options.enabled !== false;
  if (desiredEnabled && (!plan?.ready || !plan?.enabled)) throw new Error("an enabled, ready daily plan is required");
  const definition = buildDailyRefreshDefinition(plan, options);
  const adapter = adapterFor(plan, options);
  const existing = adapter.read(plan.identity);
  requireOwned(existing);
  try {
    adapter.install(definition, { replaceOwned: existing?.exists === true });
    if (!desiredEnabled) adapter.setEnabled(plan.identity, false);
    const readback = adapter.read(plan.identity);
    if (!verifiedState(readback, definition, { enabled: desiredEnabled })) {
      throw new Error("daily refresh exact readback did not match the installed definition");
    }
    return Object.freeze({ installed: true, enabled: desiredEnabled, verified: true, definition, readback });
  } catch (error) {
    try {
      const partial = adapter.read(plan.identity);
      requireOwned(partial);
      if (existing?.exists) {
        adapter.install(existing.definition, { replaceOwned: partial?.exists === true });
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
    verified: state.definition?.definition_hash === expected.definition_hash,
    definition_matches_plan: state.definition?.definition_hash === expected.definition_hash,
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
    adapter.install(snapshot.definition, { replaceOwned: state?.exists === true });
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
  adapter.remove(plan.identity);
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
    if (result?.status === "noop" || result?.status === "rolled-back") {
      scheduler.restore(snapshot);
      return result;
    }
    const final = await verifyFinal(result);
    if (final?.active !== true || final?.query_ready !== true || final?.pending !== 0) {
      throw new Error("the updated Brain is not active, query-ready, and queue zero; daily imports remain paused");
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

function macAdapter({ home, uid, spawn }) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("the macOS user id is unavailable");
  const launchctl = (args) => spawn("/bin/launchctl", args, { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  const pathOf = (identity) => join(resolve(home), "Library", "LaunchAgents", `com.financialbrain.daily.${identity.id}.plist`);
  const serviceOf = (identity) => `gui/${uid}/com.financialbrain.daily.${identity.id}`;
  const read = (identity) => {
    const path = pathOf(identity);
    if (!existsSync(path)) return null;
    const serialized = readFileSync(path, "utf8");
    const marker = markerOf(serialized);
    const status = launchctl(["print", serviceOf(identity)]);
    return {
      exists: true,
      owned: marker?.identity === identity.id,
      enabled: status?.status === 0,
      definition: { identity, definition_hash: marker?.definition_hash || null, serialized },
    };
  };
  return {
    read,
    install(definition, { replaceOwned = false } = {}) {
      const path = pathOf(definition.identity);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const staged = `${path}.tmp-${process.pid}`;
      try {
        writeFileSync(staged, definition.serialized, { mode: 0o600, flag: "wx" });
        const current = read(definition.identity);
        if (current?.exists) {
          requireOwned(current);
          if (!replaceOwned) throw new Error("the owned daily definition appeared during installation; nothing was replaced");
          launchctl(["bootout", serviceOf(definition.identity)]);
          unlinkSync(path);
        }
        linkSync(staged, path);
        unlinkSync(staged);
        const enabled = launchctl(["enable", serviceOf(definition.identity)]);
        const loaded = launchctl(["bootstrap", `gui/${uid}`, path]);
        if (enabled?.status !== 0 || loaded?.status !== 0) throw new Error("launchd refused the daily refresh definition");
      } finally {
        try { unlinkSync(staged); } catch {}
      }
    },
    setEnabled(identity, enabled) {
      requireOwned(read(identity));
      const result = enabled
        ? launchctl(["bootstrap", `gui/${uid}`, pathOf(identity)])
        : launchctl(["bootout", serviceOf(identity)]);
      if (result?.status !== 0) throw new Error(`launchd could not ${enabled ? "restore" : "pause"} daily refresh`);
    },
    remove(identity) {
      requireOwned(read(identity));
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
    if (result?.status !== 0) return null;
    const serialized = String(result.stdout || "");
    const marker = markerOf(serialized);
    const disabled = /<Enabled>\s*false\s*<\/Enabled>/iu.test(serialized);
    return {
      exists: true,
      owned: marker?.identity === identity.id,
      enabled: !disabled,
      definition: { identity, definition_hash: marker?.definition_hash || null, serialized },
    };
  };
  return {
    read,
    install(definition, { replaceOwned = false } = {}) {
      const directory = join(resolve(home), ".brain", "schedules");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `daily-${definition.identity.id}-${process.pid}.xml`);
      try {
        writeFileSync(path, `\ufeff${definition.serialized}`, { encoding: "utf16le", mode: 0o600, flag: "wx" });
        const current = read(definition.identity);
        if (current?.exists) {
          requireOwned(current);
          if (!replaceOwned) throw new Error("the owned daily definition appeared during installation; nothing was replaced");
          const removed = run(["/Delete", "/F", "/TN", taskName(definition.identity)]);
          if (removed?.status !== 0) throw new Error("Task Scheduler could not stage the owned daily refresh replacement");
        }
        const result = run(["/Create", "/TN", taskName(definition.identity), "/XML", path]);
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
    remove(identity) {
      requireOwned(read(identity));
      const result = run(["/Delete", "/F", "/TN", taskName(identity)]);
      if (result?.status !== 0) throw new Error("Task Scheduler could not remove daily refresh");
    },
  };
}
