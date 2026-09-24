import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import {
  DRIVE_SCHEDULER_SPEC,
  cronToCalendarIntervals,
  expectedRefreshSecondsForCron,
  safeIngestEnvironment,
} from "./drive-scheduler.mjs";
import { FOLDER_SCHEDULER_SPEC } from "./folder-scheduler.mjs";
import {
  isWindowsBatchValueSafe,
  publicContractChildEnvironment,
} from "./npm-cli-runtime.mjs";
import { createProviderSchedulerSpec } from "./provider-scheduler.mjs";
import { createSourceSchedulerSpec } from "./source-scheduler.mjs";

const WEEKDAYS = Object.freeze(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
const ABSENT_TASK = /cannot find|does not exist|file specified/i;

function readManifest(manifestPath, options) {
  if (options.manifest) return options.manifest;
  return JSON.parse((options.readFile || readFileSync)(manifestPath, "utf8"));
}

function schedulerSpec(options) {
  if (options.source) return createSourceSchedulerSpec(options.source);
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
  if (!isWindowsBatchValueSafe(value)) {
    const error = new Error("Windows scheduler paths cannot contain cmd.exe metacharacters or control characters");
    error.code = "WINDOWS_SCHEDULE_PATH_REFUSED";
    throw error;
  }
  if (win32.isAbsolute(value)) return win32.normalize(value);
  const cwd = options.windowsCwd || process.cwd();
  if (!win32.isAbsolute(cwd)) {
    throw new Error(`the Windows schedule needs an absolute manifest path, received "${value}"`);
  }
  return win32.resolve(cwd, value);
}

function quotedBatchPath(value) {
  if (!isWindowsBatchValueSafe(value) || !win32.isAbsolute(value)) {
    const error = new Error("Windows scheduler paths must be absolute and cannot contain cmd.exe metacharacters or control characters");
    error.code = "WINDOWS_SCHEDULE_PATH_REFUSED";
    throw error;
  }
  return `"${value}"`;
}

function taskCommand(brainPath, childArguments) {
  const runnerArguments = ["windows-scheduled-ingest", ...childArguments.slice(1)];
  const rendered = runnerArguments.map((argument, index) => {
    const value = String(argument);
    if (!isWindowsBatchValueSafe(value)) {
      const error = new Error("Windows scheduler arguments cannot contain cmd.exe metacharacters or control characters");
      error.code = "WINDOWS_SCHEDULE_PATH_REFUSED";
      throw error;
    }
    const isPath = index === 1 || runnerArguments[index - 1] === "--path";
    return isPath ? quotedBatchPath(value) : value;
  });
  // spawnSync passes this exact /TR value to schtasks. These are cmd.exe's
  // real quotes, not backslash escapes copied from an interactive shell.
  return `cmd.exe /d /s /c "${quotedBatchPath(brainPath)} ${rendered.join(" ")}"`;
}

function oneTimeBrainCommand(brainPath, childArguments) {
  const rendered = childArguments.map((argument, index) => {
    const value = String(argument);
    const isPath = index === 1 || childArguments[index - 1] === "--path";
    return isPath ? quotedBatchPath(value) : value;
  });
  return `${quotedBatchPath(brainPath)} ${rendered.join(" ")}`;
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
  const defining = installing || action === "status";
  const slug = String(manifest?.client?.slug || "");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    throw new Error("the manifest needs a valid client.slug before a Windows task can be installed");
  }
  if (defining) spec.requireEnabled(manifest);
  const cron = spec.cronOf(manifest);
  if (defining && (typeof cron !== "string" || !cron.trim())) throw new Error(spec.cronMissingError);
  const reference = {
    manifest,
    path: defining
      ? windowsAbsolute(options.windowsManifestPath || manifestPath, options)
      : String(options.windowsManifestPath || manifestPath),
    slug,
    cron,
    ...(spec.referenceExtrasOf ? spec.referenceExtrasOf(manifest) : {}),
  };
  if (defining && options.validateExtras !== false && spec.validateExtras) spec.validateExtras(reference);
  const scheduleArgs = defining ? cronToSchtasks(cron, spec.cronLabels) : [];
  const localAppData = defining
    ? windowsAbsolute(options.localAppData || options.environment?.LOCALAPPDATA, options)
    : null;
  const brainPath = defining ? win32.join(localAppData, "FinancialBrain", "brain.cmd") : null;
  const localTimeZone = options.localTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const taskName = `com.brain-installer.${slug}.${spec.kind}`;
  const childArguments = defining ? spec.childArgumentsOf(reference).map((argument, index, args) =>
    index === 1 || args[index - 1] === "--path" ? windowsAbsolute(argument, options) : String(argument)
  ) : [];
  const runCommand = defining ? taskCommand(brainPath, childArguments) : null;
  const createArgs = installing && scheduleArgs
    ? ["/Create", "/F", ...scheduleArgs, "/RL", "LIMITED", "/TN", taskName, "/TR", runCommand]
    : [];
  const plan = {
    cron,
    expectedRefreshSeconds: defining ? expectedRefreshSecondsForCron(cron, spec.cronLabels) : null,
    localTimeZone,
    manifestPath: reference.path,
    brainPath,
    taskName,
    childArguments,
    runCommand,
    scheduleArgs,
    createArgs,
    queryArgs: ["/Query", "/TN", taskName, "/XML"],
    deleteArgs: ["/Delete", "/TN", taskName, "/F"],
  };
  if (defining && !scheduleArgs) {
    const supported = "hourly at minute M, every N hours when N divides 24, daily at HH:MM, or weekly on named day(s) at HH:MM";
    const error = new Error(
      `nothing was scheduled. Windows cannot represent the cron "${cron}" exactly with one task. ` +
      `Supported schedules are ${supported}.\n` +
      `      Run once: ${oneTimeBrainCommand(brainPath, childArguments)}\n` +
      "      This cadence needs a manual trigger setup; no approximate Task Scheduler command was created."
    );
    error.code = "WINDOWS_SCHEDULE_UNREPRESENTABLE";
    throw error;
  }
  return plan;
}

export function safeWindowsScheduledEnvironment(environment = process.env) {
  return Object.freeze({
    ...publicContractChildEnvironment(environment),
    ...safeIngestEnvironment(environment),
  });
}

/** Start the ordinary ingest command only after replacing the inherited task environment. */
export function runWindowsScheduledIngest(manifestPath, options = {}) {
  const plan = options.plan || buildWindowsSchedulerPlan(manifestPath, options);
  if (options.expectedChildArguments &&
      JSON.stringify(options.expectedChildArguments) !== JSON.stringify(plan.childArguments)) {
    const error = new Error("the scheduled ingest action no longer matches this manifest; reinstall the task");
    error.code = "WINDOWS_SCHEDULE_CONFIG_CHANGED";
    throw error;
  }
  const brainCliPath = windowsAbsolute(options.brainCliPath || process.argv[1], options);
  const nodePath = windowsAbsolute(options.nodePath || process.execPath, options);
  const run = options.ingestRunner || spawnSync;
  const result = run(nodePath, [brainCliPath, ...plan.childArguments], {
    cwd: win32.dirname(plan.manifestPath),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
    env: safeWindowsScheduledEnvironment(options.environment || process.env),
  });
  if (result?.error) throw result.error;
  return { ...plan, status: Number.isInteger(result?.status) ? result.status : 1 };
}

function runSchtasks(args, options) {
  const run = options.processRunner || spawnSync;
  const sourceEnvironment = options.environment || process.env;
  const environment = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]) {
    if (sourceEnvironment[name] !== undefined) environment[name] = sourceEnvironment[name];
  }
  return run(options.schtasksPath || "schtasks.exe", args, {
    encoding: options.processEncoding === undefined ? "utf8" : options.processEncoding,
    windowsHide: true,
    shell: false,
    env: environment,
  });
}

function failureText(result) {
  return [result?.error?.message, result?.stdout, result?.stderr].filter(Boolean).join(" ").trim();
}

function taskXmlText(value) {
  if (!Buffer.isBuffer(value)) return String(value || "").replaceAll("\u0000", "").replace(/^\uFEFF/, "");
  if (value[0] === 0xff && value[1] === 0xfe) return value.toString("utf16le").replace(/^\uFEFF/, "");
  if (value[0] === 0xfe && value[1] === 0xff) {
    const swapped = Buffer.from(value);
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    }
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }
  return value.toString("utf8").replace(/^\uFEFF/, "");
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function xmlBlock(document, tag) {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(document)?.[1] ?? null;
}

function xmlText(document, tag) {
  const value = xmlBlock(document, tag);
  return value === null ? null : decodeXml(value.trim());
}

function scheduleValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function windowsTriggerMatches(xmlDocument, plan) {
  const trigger = xmlBlock(xmlDocument, "CalendarTrigger");
  if (!trigger || xmlText(trigger, "Enabled") !== "true") return false;
  const start = xmlText(trigger, "StartBoundary");
  const startTime = /T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}:\d{2}|Z)?$/i.exec(start || "")?.[1] || null;
  if (startTime !== scheduleValue(plan.scheduleArgs, "/ST")) return false;

  const cadence = scheduleValue(plan.scheduleArgs, "/SC");
  const interval = scheduleValue(plan.scheduleArgs, "/MO") || "1";
  if (cadence === "HOURLY") {
    const repetition = xmlBlock(trigger, "Repetition") || "";
    return xmlText(repetition, "Interval") === `PT${interval}H` &&
      xmlText(repetition, "Duration") === "P1D" &&
      xmlText(repetition, "StopAtDurationEnd") === "false" &&
      xmlText(xmlBlock(trigger, "ScheduleByDay") || "", "DaysInterval") === "1";
  }
  if (cadence === "DAILY") {
    return xmlBlock(trigger, "Repetition") === null &&
      xmlText(xmlBlock(trigger, "ScheduleByDay") || "", "DaysInterval") === "1";
  }
  if (cadence === "WEEKLY") {
    const weekly = xmlBlock(trigger, "ScheduleByWeek") || "";
    const expectedDays = new Set(String(scheduleValue(plan.scheduleArgs, "/D") || "").split(","));
    const xmlDayNames = Object.freeze({
      SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday",
      THU: "Thursday", FRI: "Friday", SAT: "Saturday",
    });
    return xmlText(weekly, "WeeksInterval") === "1" &&
      [...expectedDays].every((day) => new RegExp(`<${xmlDayNames[day]}\\s*/>`, "i").test(weekly)) &&
      Object.entries(xmlDayNames).every(([day, tag]) => expectedDays.has(day) || !new RegExp(`<${tag}\\s*/>`, "i").test(weekly));
  }
  return false;
}

function inspectWindowsTaskDefinition(document, plan) {
  const task = String(document || "");
  const settings = xmlBlock(task, "Settings") || "";
  const trigger = xmlBlock(task, "CalendarTrigger") || "";
  const enabled = xmlText(settings, "Enabled") === "true" && xmlText(trigger, "Enabled") === "true";
  const uri = String(xmlText(xmlBlock(task, "RegistrationInfo") || "", "URI") || "").replace(/^\\+/, "");
  const exec = xmlBlock(task, "Exec") || "";
  const command = xmlText(exec, "Command");
  const argumentsText = xmlText(exec, "Arguments");
  const action = [command, argumentsText].filter((value) => value !== null && value !== "").join(" ");
  const definitionMatches = enabled && uri === plan.taskName &&
    xmlText(xmlBlock(task, "Principal") || "", "RunLevel") === "LeastPrivilege" &&
    action === plan.runCommand && windowsTriggerMatches(task, plan);
  return { enabled, definitionMatches };
}

function unhealthyWindowsStatus(plan, output, errorCode, scheduleError, state) {
  return {
    ...plan,
    installed: false,
    enabled: state !== "disabled",
    definitionMatches: false,
    definitionDrift: state === "drift",
    errorCode,
    scheduleError,
    state,
    output,
  };
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
  // /XML is UTF-16 on Windows. Keep bytes until the BOM has selected the
  // decoder; paths outside the active code page are part of the task identity.
  const result = runSchtasks(plan.queryArgs, { ...options, processEncoding: options.processEncoding ?? null });
  if (!result?.error && result?.status === 0) {
    const output = taskXmlText(result.stdout).trim();
    const observed = inspectWindowsTaskDefinition(output, plan);
    if (!observed.enabled) {
      return unhealthyWindowsStatus(
        plan, output, "WINDOWS_SCHEDULE_DISABLED", "the current Windows task is disabled", "disabled",
      );
    }
    if (!observed.definitionMatches) {
      return unhealthyWindowsStatus(
        plan, output, "WINDOWS_SCHEDULE_DRIFT",
        "the current Windows task definition does not match this manifest and schedule", "drift",
      );
    }
    return {
      ...plan,
      installed: true,
      enabled: true,
      definitionMatches: true,
      definitionDrift: false,
      errorCode: null,
      scheduleError: null,
      state: "ready",
      output,
    };
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
