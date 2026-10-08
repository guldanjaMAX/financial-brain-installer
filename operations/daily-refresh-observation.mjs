/** Bounded local run evidence. Never retain source output or raw exceptions. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { restrictWindowsDirectoryToCurrentUser, restrictWindowsFileToCurrentUser } from "./current-user-file.mjs";

export const DAILY_LOG_MAX_BYTES = 64 * 1024;
const RESULTS = new Set(["running", "complete", "partial", "failed", "deferred"]);
export const DAILY_RUN_ERROR = "Daily refresh failed before completion. Inspect the schedule and source authorization.";
const ERRORS = new Set([DAILY_RUN_ERROR, "One or more daily sources failed or did not prove freshness.", "Daily refresh was deferred by another operation or recovery."]);

export function dailyLogPaths(identity, { home = homedir() } = {}) {
  if (!/^v1-[a-z0-9]+$/u.test(String(identity?.id || ""))) throw new Error("the daily log identity is invalid");
  const directory = join(resolve(home), ".brain", "logs", identity.id);
  return { directory, log_path: join(directory, "daily.log"), history_path: join(directory, "daily.log.1") };
}

function statIfPresent(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function assertOwner(info, platform) {
  if (info.isSymbolicLink() || (platform !== "win32" && typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("the daily log path is not owned safely");
  }
}

function assertFile(path, options) {
  const info = statIfPresent(path);
  if (info) {
    assertOwner(info, options.platform);
    if (!info.isFile() || info.nlink !== 1) throw new Error("the daily log must be a regular unlinked file");
  }
  return info;
}

function prepare(identity, options) {
  const paths = dailyLogPaths(identity, options);
  const home = resolve(options.home || homedir());
  for (const directory of [join(home, ".brain"), join(home, ".brain", "logs"), paths.directory]) {
    const prior = statIfPresent(directory);
    if (!prior) mkdirSync(directory, { mode: 0o700 });
    const info = lstatSync(directory);
    assertOwner(info, options.platform);
    if (!info.isDirectory()) throw new Error("the daily log directory is unsafe");
    // Only tighten this Brain's directory. Shared log parents may serve other
    // local schedulers, but no descendant may resolve through a symbolic link.
    if (directory === paths.directory) {
      if (options.platform === "win32") restrictWindowsDirectoryToCurrentUser(directory, options);
      else chmodSync(directory, 0o700);
    }
  }
  return paths;
}

function withLogAppendLock(directory, options, append) {
  const path = join(directory, "daily.lock");
  const prior = assertFile(path, options);
  if (prior) {
    if (prior.size > 32) throw new Error("the daily log lock is invalid");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let pid;
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== prior.dev || opened.ino !== prior.ino || opened.size !== prior.size) throw new Error("the daily log lock changed");
      const bytes = Buffer.alloc(33);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, count).toString("ascii");
      if (!/^[1-9][0-9]{0,9}\n$/u.test(value)) throw new Error("the daily log lock is invalid");
      pid = Number(value.trim());
    } finally { closeSync(fd); }
    const alive = options.processAlive || ((ownerPid) => {
      try { process.kill(ownerPid, 0); return true; }
      catch (error) { return error.code !== "ESRCH"; }
    });
    if (alive(pid) !== false) throw new Error("another writer owns the daily log");
    const current = lstatSync(path);
    if (current.dev !== prior.dev || current.ino !== prior.ino || current.mtimeMs !== prior.mtimeMs || current.size !== prior.size) {
      throw new Error("the daily log lock changed");
    }
    unlinkSync(path);
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  const owned = fstatSync(fd);
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    return append();
  } finally {
    closeSync(fd);
    const current = statIfPresent(path);
    if (current?.dev === owned.dev && current?.ino === owned.ino) unlinkSync(path);
  }
}

export function appendDailyObservation(identity, record, options = {}) {
  const settings = { ...options, platform: options.platform ?? process.platform };
  if (!RESULTS.has(record.result) || !validTime(record.started_at) ||
      (record.completed_at !== null && !validTime(record.completed_at)) ||
      (record.error !== null && !ERRORS.has(record.error))) throw new Error("invalid daily observation");
  const bytes = Buffer.from(`${JSON.stringify({ schema_version: 1, started_at: record.started_at,
    completed_at: record.completed_at, result: record.result, error: record.error })}\n`);
  const paths = prepare(identity, settings);
  return withLogAppendLock(paths.directory, settings, () => {
    const prior = assertFile(paths.log_path, settings);
    const history = assertFile(paths.history_path, settings);
    if (history && history.size > DAILY_LOG_MAX_BYTES) throw new Error("the daily log history exceeded its size contract");
    if (history) {
      if (settings.platform === "win32") restrictWindowsFileToCurrentUser(paths.history_path, settings);
      else chmodSync(paths.history_path, 0o600);
    }
    if (prior && prior.size + bytes.length > DAILY_LOG_MAX_BYTES) {
      // A fixed active file and one fixed history file bound retention. No glob
      // or source-provided path can participate in rotation.
      if (prior.size > DAILY_LOG_MAX_BYTES) throw new Error("the daily log exceeded its size contract");
      renameSync(paths.log_path, paths.history_path);
    }
    const fd = openSync(paths.log_path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const info = fstatSync(fd);
      assertOwner(info, settings.platform);
      if (!info.isFile() || info.nlink !== 1 || info.size + bytes.length > DAILY_LOG_MAX_BYTES) throw new Error("the daily log changed before append");
      if (settings.platform === "win32") restrictWindowsFileToCurrentUser(paths.log_path, settings);
      else fchmodSync(fd, 0o600);
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return paths;
  });
}

function validTime(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

export function readDailyObservation(identity, options = {}) {
  const paths = dailyLogPaths(identity, options);
  try {
    // A status request must neither create a log nor follow a planted link.
    const directory = statIfPresent(paths.directory);
    if (!directory) return { ...paths, record: null, last_error: null };
    for (const path of [join(resolve(options.home || homedir()), ".brain"), join(resolve(options.home || homedir()), ".brain", "logs"), paths.directory]) {
      const info = lstatSync(path);
      assertOwner(info, options.platform ?? process.platform);
      if (!info.isDirectory()) throw new Error("unsafe log directory");
    }
    const records = [];
    for (const path of [paths.history_path, paths.log_path]) {
      const info = assertFile(path, { platform: options.platform ?? process.platform });
      if (!info) continue;
      if (info.size > DAILY_LOG_MAX_BYTES) throw new Error("oversized log");
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let text;
      try {
        const opened = fstatSync(fd);
        assertOwner(opened, options.platform ?? process.platform);
        if (!opened.isFile() || opened.nlink !== 1 || opened.size > DAILY_LOG_MAX_BYTES) throw new Error("unsafe log file");
        const bytes = Buffer.alloc(DAILY_LOG_MAX_BYTES + 1);
        const count = readSync(fd, bytes, 0, bytes.length, 0);
        if (count > DAILY_LOG_MAX_BYTES) throw new Error("oversized log");
        text = bytes.subarray(0, count).toString("utf8");
      } finally { closeSync(fd); }
      for (const line of text.trim().split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.schema_version !== 1 || !RESULTS.has(record.result) || !validTime(record.started_at) ||
            (record.completed_at !== null && !validTime(record.completed_at)) ||
            (record.error !== null && !ERRORS.has(record.error))) throw new Error("invalid log record");
        records.push({ started_at: record.started_at, completed_at: record.completed_at, result: record.result, error: record.error });
      }
    }
    return { ...paths, record: records.at(-1) || null, last_error: records.findLast((row) => row.error)?.error || null };
  } catch {
    return { ...paths, record: null, last_error: "Daily run diagnostics could not be read safely.", unreadable: true };
  }
}

export async function observeDailyRun(identity, run, options = {}) {
  const now = options.now || (() => new Date());
  const started_at = now().toISOString();
  const write = options.appendObservation || appendDailyObservation;
  write(identity, { started_at, completed_at: null, result: "running", error: null }, options);
  try {
    const result = await run();
    const status = RESULTS.has(result?.status) && result.status !== "running" ? result.status : "failed";
    write(identity, { started_at, completed_at: now().toISOString(), result: status,
      // Verified partial coverage is an outcome, not a process failure.
      error: status === "complete" || status === "partial" ? null : status === "deferred"
        ? "Daily refresh was deferred by another operation or recovery."
        : "One or more daily sources failed or did not prove freshness." }, options);
    return result;
  } catch (error) {
    write(identity, { started_at, completed_at: now().toISOString(), result: "failed", error: DAILY_RUN_ERROR }, options);
    throw error;
  }
}

export function dailyObservationStatus(plan, schedule, runtime, runnerUsable, options = {}) {
  const observed = readDailyObservation(plan.identity, options);
  const row = observed.record;
  const nativeTime = validTime(runtime?.last_run_at) ? runtime.last_run_at : null;
  const newerNativeRun = nativeTime && (!row || Date.parse(nativeTime) > Date.parse(row.completed_at || row.started_at));
  let result = newerNativeRun ? "unknown" : row?.result || (Number.isInteger(runtime?.exit_code) ? "unknown" : "never");
  let error = observed.last_error;
  if (result === "running" && runtime?.running !== true) result = "unknown";
  if (runtime?.running === true) result = "running";
  else if (runtime?.known === false) { result = "unknown"; error = "Native daily run information could not be inspected."; }
  else if (Number.isInteger(runtime?.signal) && runtime.signal > 0) {
    result = "failed"; error = `Daily process terminated with signal ${runtime.signal}.`;
  }
  else if (Number.isInteger(runtime?.exit_code) && runtime.exit_code !== 0) {
    result = "failed"; error = `Daily process exited with code ${runtime.exit_code}.`;
  }
  if (observed.unreadable && result !== "failed") result = "unknown";
  if (runnerUsable === false || schedule.registered_node_usable === false) {
    result = "failed"; error = runnerUsable === false ? "The registered daily runner is missing or unreadable." : "The registered Node binary is missing or not executable.";
  }
  // This is the next planned local clock slot. Native Windows task info can
  // supply a more exact time; powered-off/logged-out machines cannot promise it.
  let next = validTime(runtime?.next_run_at) ? runtime.next_run_at : null;
  if (!next && schedule.enabled && schedule.plan_matches_registered_definition && plan.timezone === (options.localTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone)) {
    const [minute, hour] = plan.cron.split(" ").map(Number);
    const now = (options.now || (() => new Date()))();
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    next = date.toISOString();
  }
  return { log_path: observed.log_path, last_run_at: newerNativeRun ? nativeTime : row?.started_at || nativeTime,
    last_result: result, next_run_at: schedule.enabled ? next : null,
    next_run: !schedule.enabled ? "not scheduled" : next || (schedule.plan_matches_registered_definition
      ? `${plan.cron} ${plan.timezone} (planned)` : "unknown (schedule needs repair)"),
    last_error_line: error, registered_runner_usable: runnerUsable };
}

export function renderDailyObservation(schedule, log) {
  log(`Last daily run: ${schedule.last_run_at || "unknown or never"}`);
  log(`Last daily result: ${schedule.last_result === "partial" ? "partial (coverage omissions)" : schedule.last_result || "unknown"}`);
  log(`Next daily run: ${schedule.next_run || "not scheduled"}`);
  log(`Last daily error: ${schedule.last_error_line || "none recorded"}`);
  if (schedule.log_path) log(`Daily log: ${schedule.log_path}`);
}
