import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import {
  DRIVE_SCHEDULER_SPEC,
  cronToCalendarIntervals,
  expectedRefreshSecondsForCron,
} from "./drive-scheduler.mjs";
import { FOLDER_SCHEDULER_SPEC } from "./folder-scheduler.mjs";
import { createProviderSchedulerSpec } from "./provider-scheduler.mjs";

const WEEKDAYS = Object.freeze(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
const ABSENT_TASK = /cannot find|does not exist|file specified/i;

function readManifest(manifestPath, options) {
  if (options.manifest) return options.manifest;
  return JSON.parse((options.readFile || readFileSync)(manifestPath, "utf8"));
}

function schedulerSpec(options) {
  if (options.provider) return createProviderSchedulerSpec(options.provider);
  if (options.folder) return FOLDER_SCHEDULER_SPEC;
  return DRIVE_SCHEDULER_SPEC;
}

function requiredInteger(value, minimum, maximum) {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= minimum && number <= maximum ? number : null;
}

function weeklyDays(field) {
  const days = new Set();
  for (const segment of field.split(",")) {
    const bounds = segment.split("-");
    if (bounds.length > 2) return null;
    const start = requiredInteger(bounds[0], 0, 7);
    const end = requiredInteger(bounds.at(-1), 0, 7);
    if (start === null || end === null || start > end) return null;
    for (let day = start; day <= end; day++) days.add(day === 7 ? 0 : day);
  }
  return [...days].sort((a, b) => a - b).map((day) => WEEKDAYS[day]);
}

/** Translate only schedules one Task Scheduler entry can reproduce exactly. */
export function cronToSchtasks(expression, cronLabels) {
  // This first validates against the same five-field contract used by launchd.
  cronToCalendarIntervals(expression, cronLabels);
  const [minuteField, hourField, day, month, weekday] = String(expression).trim().split(/\s+/);
  const minute = requiredInteger(minuteField, 0, 59);
  if (minute !== null && day === "*" && month === "*" && weekday === "*") {
    if (hourField === "*") {
      return ["/SC", "HOURLY", "/MO", "1", "/ST", `00:${String(minute).padStart(2, "0")}`];
    }
    const everyHours = /^\*\/(\d+)$/.exec(hourField);
    if (everyHours) {
      const interval = Number(everyHours[1]);
      // A repeating Windows interval crosses midnight. Cron restarts its step
      // at hour zero, so the two are equal only when the interval divides 24.
      if (interval >= 1 && interval <= 23 && 24 % interval === 0) {
        return ["/SC", "HOURLY", "/MO", String(interval), "/ST", `00:${String(minute).padStart(2, "0")}`];
      }
    }
    const hour = requiredInteger(hourField, 0, 23);
    if (hour !== null) {
      return ["/SC", "DAILY", "/ST", `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`];
    }
  }
  if (minute !== null && day === "*" && month === "*" && weekday !== "*") {
    const hour = requiredInteger(hourField, 0, 23);
    const days = weeklyDays(weekday);
    if (hour !== null && days?.length) {
      return [
        "/SC", "WEEKLY", "/D", days.join(","),
        "/ST", `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ];
    }
  }
  return null;
}

function windowsAbsolute(path, options) {
  const value = String(path || "");
  if (!value || value === "undefined") throw new Error("LOCALAPPDATA is required to locate the installed brain.cmd");
  if (/["\u0000-\u001f]/u.test(value)) throw new Error("Windows scheduler paths cannot contain quotes or control characters");
  if (win32.isAbsolute(value)) return win32.normalize(value);
  const cwd = options.windowsCwd || process.cwd();
  if (!win32.isAbsolute(cwd)) {
    throw new Error(`the Windows schedule needs an absolute manifest path, received "${value}"`);
  }
  return win32.resolve(cwd, value);
}

function taskCommand(brainPath, childArguments) {
  const rendered = childArguments.map((argument) => {
    const value = String(argument);
    return /\s/.test(value) ? `\\"${value}\\"` : value;
  });
  // cmd.exe requires the outer escaped quote in addition to the executable's
  // quotes. Keeping this shape matches the long-standing manual recipe.
  return `cmd /c \\"\\"${brainPath}\\" ${rendered.join(" ")}\\"`;
}

function printableArgument(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
}

export function renderWindowsTaskRecipe(plan) {
  return ["schtasks", ...plan.createArgs].map(printableArgument).join(" ");
}

export function buildWindowsSchedulerPlan(manifestPath, options = {}) {
  const manifest = readManifest(manifestPath, options);
  const spec = schedulerSpec(options);
  const action = options.action || "install";
  const installing = action === "install";
  const slug = String(manifest?.client?.slug || "");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    throw new Error("the manifest needs a valid client.slug before a Windows task can be installed");
  }
  if (installing) spec.requireEnabled(manifest);
  const cron = spec.cronOf(manifest);
  if (installing && (typeof cron !== "string" || !cron.trim())) throw new Error(spec.cronMissingError);
  const reference = {
    manifest,
    path: installing
      ? windowsAbsolute(options.windowsManifestPath || manifestPath, options)
      : String(options.windowsManifestPath || manifestPath),
    slug,
    cron,
    ...(spec.referenceExtrasOf ? spec.referenceExtrasOf(manifest) : {}),
  };
  if (installing && options.validateExtras !== false && spec.validateExtras) spec.validateExtras(reference);
  const scheduleArgs = installing ? cronToSchtasks(cron, spec.cronLabels) : [];
  const localAppData = installing
    ? windowsAbsolute(options.localAppData || options.environment?.LOCALAPPDATA, options)
    : null;
  const brainPath = installing ? win32.join(localAppData, "FinancialBrain", "brain.cmd") : null;
  const taskName = `com.brain-installer.${slug}.${spec.kind}`;
  const childArguments = installing ? spec.childArgumentsOf(reference) : [];
  const runCommand = installing ? taskCommand(brainPath, childArguments) : null;
  const createArgs = installing && scheduleArgs
    ? ["/Create", "/F", ...scheduleArgs, "/RL", "LIMITED", "/TN", taskName, "/TR", runCommand]
    : [];
  const plan = {
    cron,
    expectedRefreshSeconds: installing ? expectedRefreshSecondsForCron(cron, spec.cronLabels) : null,
    manifestPath: reference.path,
    brainPath,
    taskName,
    childArguments,
    runCommand,
    createArgs,
    queryArgs: ["/Query", "/TN", taskName, "/FO", "LIST", "/V"],
    deleteArgs: ["/Delete", "/TN", taskName, "/F"],
  };
  if (installing && !scheduleArgs) {
    const supported = "hourly at minute M, every N hours when N divides 24, daily at HH:MM, or weekly on named day(s) at HH:MM";
    const manualPlan = {
      ...plan,
      createArgs: ["/Create", "/F", "/SC", "HOURLY", "/RL", "LIMITED", "/TN", taskName, "/TR", runCommand],
    };
    const error = new Error(
      `nothing was scheduled. Windows cannot represent the cron "${cron}" exactly with one task. ` +
      `Supported schedules are ${supported}.\n      Manual recipe: ${renderWindowsTaskRecipe(manualPlan)}`
    );
    error.code = "WINDOWS_SCHEDULE_UNREPRESENTABLE";
    throw error;
  }
  return plan;
}

function runSchtasks(args, options) {
  const run = options.processRunner || spawnSync;
  const sourceEnvironment = options.environment || process.env;
  const environment = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]) {
    if (sourceEnvironment[name] !== undefined) environment[name] = sourceEnvironment[name];
  }
  return run(options.schtasksPath || "schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    env: environment,
  });
}

function failureText(result) {
  return [result?.error?.message, result?.stdout, result?.stderr].filter(Boolean).join(" ").trim();
}

export function installWindowsScheduler(manifestPath, options = {}) {
  const plan = options.plan || buildWindowsSchedulerPlan(manifestPath, options);
  const result = runSchtasks(plan.createArgs, options);
  if (result?.error || result?.status !== 0) {
    const detail = failureText(result) || "Task Scheduler returned an unknown error";
    const error = new Error(
      `nothing was scheduled because schtasks could not create the per-user task: ${detail}\n` +
      `      Manual recipe: ${renderWindowsTaskRecipe(plan)}`
    );
    error.code = "WINDOWS_SCHEDULE_CREATE_FAILED";
    throw error;
  }
  return { ...plan, installed: true, output: String(result.stdout || "").trim() };
}

export function statusWindowsScheduler(manifestPath, options = {}) {
  const plan = options.plan || buildWindowsSchedulerPlan(manifestPath, { ...options, action: "status" });
  const result = runSchtasks(plan.queryArgs, options);
  if (!result?.error && result?.status === 0) {
    return { ...plan, installed: true, output: String(result.stdout || "").trim() };
  }
  const detail = failureText(result);
  if (ABSENT_TASK.test(detail)) return { ...plan, installed: false, output: detail };
  throw new Error(`schtasks could not query ${plan.taskName}: ${detail || "unknown error"}`);
}

export function removeWindowsScheduler(manifestPath, options = {}) {
  const plan = options.plan || buildWindowsSchedulerPlan(manifestPath, { ...options, action: "remove" });
  const result = runSchtasks(plan.deleteArgs, options);
  if (!result?.error && result?.status === 0) {
    return { ...plan, installed: false, removed: true, output: String(result.stdout || "").trim() };
  }
  const detail = failureText(result);
  if (ABSENT_TASK.test(detail)) return { ...plan, installed: false, removed: false, output: detail };
  throw new Error(`schtasks could not delete ${plan.taskName}: ${detail || "unknown error"}`);
}
