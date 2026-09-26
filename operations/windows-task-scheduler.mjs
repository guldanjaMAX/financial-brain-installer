import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute as isHostAbsolute, win32 } from "node:path";
import {
  DRIVE_LOG_HISTORY_FILES,
  DRIVE_LOG_MAX_BYTES,
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

const WEEKDAYS = Object.freeze(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);

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

function windowsAbsolute(path, options, label = "LOCALAPPDATA is required to locate the installed brain") {
  const value = String(path || "");
  if (!value || value === "undefined") throw new Error(label);
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

/**
 * Quote one argument by the Microsoft C runtime rules Node, conhost and
 * CommandLineToArgvW parse with. Backslashes are literal except before a
 * quote, so a quoted value ending in a separator ("D:\", "C:\Exports\") must
 * double its trailing backslashes; otherwise the closing quote is escaped and
 * every later argument is swallowed into the path. The same quoting survives
 * conhost rebuilding its client's command line from the argv it parsed.
 */
export function quoteWindowsArgument(value, { always = false } = {}) {
  const text = String(value);
  if (!always && text.length > 0 && !/[ \t"]/.test(text)) return text;
  let quoted = '"';
  let slashes = 0;
  for (const character of text) {
    if (character === "\\") { slashes++; continue; }
    if (character === '"') {
      quoted += `${"\\".repeat(slashes * 2 + 1)}"`;
    } else {
      quoted += `${"\\".repeat(slashes)}${character}`;
    }
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

function refusedArgument(message) {
  const error = new Error(message);
  error.code = "WINDOWS_SCHEDULE_PATH_REFUSED";
  return error;
}

// Task Scheduler expands %NAME% inside an action's arguments and the refused
// set stays the one every Windows batch boundary in this package enforces, so
// a value that would be reinterpreted is refused rather than escaped.
function scheduledArgument(value, isPath, quoting = {}) {
  const text = String(value);
  if (!isWindowsBatchValueSafe(text)) {
    throw refusedArgument("Windows scheduler arguments cannot contain cmd.exe metacharacters or control characters");
  }
  if (isPath && !win32.isAbsolute(text)) {
    throw refusedArgument("Windows scheduler paths must be absolute and cannot contain cmd.exe metacharacters or control characters");
  }
  return quoteWindowsArgument(text, quoting);
}

function oneTimeBrainCommand(brainPath, childArguments) {
  const rendered = childArguments.map((argument, index) => {
    const isPath = index === 1 || childArguments[index - 1] === "--path";
    // A pasted command quotes every path, still by the MSVC trailing-backslash rule.
    return scheduledArgument(argument, isPath, { always: isPath });
  });
  return `${quoteWindowsArgument(brainPath, { always: true })} ${rendered.join(" ")}`;
}

function printableArgument(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
}

export function renderWindowsTaskRecipe(plan) {
  return ["schtasks", ...plan.createArgs].map(printableArgument).join(" ");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const DAY_ELEMENTS = Object.freeze({
  SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday",
});

const pad2 = (number) => String(number).padStart(2, "0");

/**
 * Render the one CalendarTrigger that reproduces the schtasks-equivalent
 * schedule cronToSchtasks accepted. StartBoundary has no offset, so it is
 * local wall-clock time like cron and launchd, and it starts on the install
 * date as schtasks' own /SD default does. Element order follows what Task
 * Scheduler itself exports.
 */
function calendarTriggerXml(scheduleArgs, now) {
  const value = (flag) => scheduleArgs[scheduleArgs.indexOf(flag) + 1];
  const kind = value("/SC");
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const lines = ["    <CalendarTrigger>"];
  if (kind === "HOURLY") {
    lines.push(
      "      <Repetition>",
      `        <Interval>PT${value("/MO")}H</Interval>`,
      "        <Duration>P1D</Duration>",
      "        <StopAtDurationEnd>false</StopAtDurationEnd>",
      "      </Repetition>",
    );
  }
  lines.push(
    `      <StartBoundary>${date}T${value("/ST")}:00</StartBoundary>`,
    "      <Enabled>true</Enabled>",
  );
  if (kind === "WEEKLY") {
    const days = new Set(value("/D").split(","));
    lines.push(
      "      <ScheduleByWeek>",
      "        <DaysOfWeek>",
      ...Object.keys(DAY_ELEMENTS).filter((day) => days.has(day)).map((day) => `          <${DAY_ELEMENTS[day]} />`),
      "        </DaysOfWeek>",
      "        <WeeksInterval>1</WeeksInterval>",
      "      </ScheduleByWeek>",
    );
  } else {
    lines.push("      <ScheduleByDay>", "        <DaysInterval>1</DaysInterval>", "      </ScheduleByDay>");
  }
  lines.push("    </CalendarTrigger>");
  return lines;
}

/**
 * The settings schtasks' command line cannot set. Its defaults skip a run the
 * laptop slept through and refuse or kill a run on battery, so a daily 02:15
 * refresh on a closed laptop never happened. Status compares exactly these.
 */
// Task Scheduler's schema defaults, used when a stored definition omits one.
const TASK_SETTING_DEFAULTS = Object.freeze({
  MultipleInstancesPolicy: "IgnoreNew",
  DisallowStartIfOnBatteries: "true",
  StopIfGoingOnBatteries: "true",
  StartWhenAvailable: "false",
  RunOnlyIfIdle: "false",
  Enabled: "true",
});

export const WINDOWS_TASK_SETTINGS = Object.freeze({
  MultipleInstancesPolicy: "IgnoreNew",
  DisallowStartIfOnBatteries: "false",
  StopIfGoingOnBatteries: "false",
  StartWhenAvailable: "true",
  RunOnlyIfIdle: "false",
  Enabled: "true",
});

export function renderWindowsTaskXml(plan, scheduleArgs, now) {
  const settings = WINDOWS_TASK_SETTINGS;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEscape(`Financial Brain ${plan.kind} refresh for ${plan.slug}`)}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    ...calendarTriggerXml(scheduleArgs, now),
    "  </Triggers>",
    "  <Principals>",
    // No UserId: the registering owner is the principal. InteractiveToken runs
    // only inside that owner's logon session, which is where DPAPI can decrypt
    // the admin key; S4U or a stored password would run without it.
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    `    <MultipleInstancesPolicy>${settings.MultipleInstancesPolicy}</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>${settings.DisallowStartIfOnBatteries}</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>${settings.StopIfGoingOnBatteries}</StopIfGoingOnBatteries>`,
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    `    <StartWhenAvailable>${settings.StartWhenAvailable}</StartWhenAvailable>`,
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    `    <Enabled>${settings.Enabled}</Enabled>`,
    "    <Hidden>false</Hidden>",
    `    <RunOnlyIfIdle>${settings.RunOnlyIfIdle}</RunOnlyIfIdle>`,
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(plan.hostPath)}</Command>`,
    `      <Arguments>${xmlEscape(plan.hostArguments)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(win32.dirname(plan.manifestPath))}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** schtasks /XML reads a UTF-16 document; the declaration and the BOM agree. */
export function encodeTaskDefinition(xml) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(xml), "utf16le")]);
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
  // The scheduled child receives no Cloudflare deployment token, so it can
  // reach the brain only through its domain; the LaunchAgent lanes refuse the
  // same way before anything is registered.
  if (installing && (typeof manifest?.brain?.domain !== "string" || !manifest.brain.domain.trim())) {
    throw new Error(spec.domainMissingError);
  }
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
  const environment = options.environment || process.env;
  // The CLI passes no environment of its own, so the installed prefix comes
  // from the same process environment schtasks and the scheduled child read.
  // Without this default every real install refused as "LOCALAPPDATA is required".
  const localAppData = installing
    ? windowsAbsolute(options.localAppData || environment.LOCALAPPDATA, options)
    : null;
  const taskName = `com.brain-installer.${slug}.${spec.kind}`;
  const installRoot = installing ? win32.join(localAppData, "FinancialBrain") : null;
  const brainPath = installing ? win32.join(installRoot, "brain.cmd") : null;
  const childArguments = installing ? spec.childArgumentsOf(reference).map((argument, index, args) =>
    index === 1 || args[index - 1] === "--path" ? windowsAbsolute(argument, options) : String(argument)
  ) : [];
  const plan = {
    kind: spec.kind,
    slug,
    cron,
    expectedRefreshSeconds: installing ? expectedRefreshSecondsForCron(cron, spec.cronLabels) : null,
    manifestPath: reference.path,
    brainPath,
    taskName,
    childArguments,
    createArgs: [],
    // Only this lane's task is ever queried. An unfiltered listing fails as a
    // whole when any unrelated task in the owner's library is corrupt.
    presenceArgs: ["/Query", "/TN", taskName, "/FO", "CSV", "/V", "/NH"],
    queryArgs: ["/Query", "/TN", taskName, "/XML"],
    deleteArgs: ["/Delete", "/TN", taskName, "/F"],
  };
  if (!installing) return plan;
  if (!scheduleArgs) {
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
  // The action runs the pinned interpreter on the installed package directly,
  // as the LaunchAgent does. No cmd.exe layer sits between Task Scheduler and
  // Node, so the only command-line rules in play are the MSVC ones above.
  plan.nodePath = windowsAbsolute(options.nodePath || process.execPath, options,
    "the Node.js interpreter path is required for the Windows task");
  plan.brainCliPath = windowsAbsolute(
    options.brainCliPath || win32.join(installRoot, "node_modules", "brain-installer", "brain.mjs"), options);
  // conhost.exe --headless (Windows 10 1809 and later, so every supported
  // Windows 10/11 build) hosts the console-subsystem node.exe without a window.
  // A cmd.exe action opened a visible console, and closing it killed the ingest.
  plan.hostPath = win32.join(
    windowsAbsolute(options.systemRoot || environment.SystemRoot, options,
      "SystemRoot is required to locate conhost.exe for the Windows task"),
    "System32", "conhost.exe");
  plan.definitionPath = win32.join(installRoot, "schedules", `${taskName}.xml`);
  plan.logPath = win32.join(installRoot, "logs", `${taskName}.log`);
  // Bound into the action's argv like the LaunchAgent's: every run recomputes
  // it and refuses to read credentials when the reviewed configuration moved.
  plan.configHash = createHash("sha256").update(JSON.stringify({
    version: 1,
    platform: "win32",
    task_name: taskName,
    node_path: plan.nodePath,
    host_path: plan.hostPath,
    log_path: plan.logPath,
    lane: spec.configHashPayloadOf({ ...reference, brainPath: plan.brainCliPath }),
  })).digest("hex");
  const runnerArguments = [
    plan.nodePath, plan.brainCliPath, "windows-scheduled-ingest", ...childArguments.slice(1),
    "--config-hash", plan.configHash,
  ];
  plan.hostArguments = ["--headless", ...runnerArguments.map((argument, index) =>
    scheduledArgument(argument, index < 2 || index === 3 || runnerArguments[index - 1] === "--path"))].join(" ");
  plan.taskXml = renderWindowsTaskXml(plan, scheduleArgs, options.now || new Date());
  plan.createArgs = ["/Create", "/F", "/TN", taskName, "/XML", plan.definitionPath];
  return plan;
}

export function safeWindowsScheduledEnvironment(environment = process.env) {
  return Object.freeze({
    ...publicContractChildEnvironment(environment),
    ...safeIngestEnvironment(environment),
  });
}

/**
 * Only a real Windows path may be written. On another host a win32 path is
 * relative, and a missing injection in a test would otherwise create
 * "C:\..." files in the working directory. %LOCALAPPDATA% inherits the owner's
 * profile ACL, which is what keeps the definition and the log private.
 */
function hostWindowsPath(path) {
  if (!isHostAbsolute(path) || !win32.isAbsolute(path)) {
    throw new Error("the Windows task files can be written only on the Windows machine that owns them");
  }
  return path;
}

function writePrivateTaskDefinition(path, bytes) {
  mkdirSync(dirname(hostWindowsPath(path)), { recursive: true });
  writeFileSync(path, bytes);
}

function rotateLaneLog(path) {
  let size = 0;
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("the Windows scheduled ingest log must be a regular file");
    size = stats.size;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (size <= DRIVE_LOG_MAX_BYTES) return;
  for (let index = DRIVE_LOG_HISTORY_FILES; index >= 1; index--) {
    const from = index === 1 ? path : `${path}.${index - 1}`;
    try {
      renameSync(from, `${path}.${index}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function openLaneLog(path) {
  mkdirSync(dirname(hostWindowsPath(path)), { recursive: true });
  rotateLaneLog(path);
  return openSync(path, "a");
}

/**
 * The lane log's path from the task name alone, for the moments no full plan
 * exists: status of a lane whose manifest no longer builds, and a run that
 * failed before its plan did.
 */
export function windowsLaneLogPath(taskName, options = {}) {
  const environment = options.environment || process.env;
  const localAppData = options.localAppData || environment.LOCALAPPDATA;
  if (!localAppData || !win32.isAbsolute(String(localAppData))) return null;
  const root = win32.join(win32.normalize(String(localAppData)), "FinancialBrain", "logs");
  return win32.join(root, taskName ? `${taskName}.log` : "windows-scheduled-ingest.log");
}

/**
 * One metadata line for the lane log. The owner's own paths and the runner's
 * refusal wording are fine there; a manifest parse error is not, because newer
 * Node versions quote a slice of the offending JSON text.
 */
function laneFailureSummary(error) {
  if (error instanceof SyntaxError) return "the manifest is not valid JSON";
  const message = String(error?.message || error || "unknown error").split(/\r?\n/)[0];
  const code = typeof error?.code === "string" && !message.includes(error.code) ? ` (${error.code})` : "";
  return `${message}${code}`.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400);
}

function laneFailureLine(error) {
  return `${new Date().toISOString()} scheduled ingest failed: ${laneFailureSummary(error)}\n`;
}

function laneLog(options) {
  return {
    open: options.openLog || openLaneLog,
    // Recording a failure must never replace it with a logging error.
    record(path, error) {
      if (!path) return false;
      try {
        this.append(path, laneFailureLine(error));
        return true;
      } catch {
        return false;
      }
    },
    append: options.appendLog || ((path, text) => {
      mkdirSync(dirname(hostWindowsPath(path)), { recursive: true });
      appendFileSync(path, text);
    }),
    close: options.closeLog || closeSync,
  };
}

function scheduleRefusal(message, code = "WINDOWS_SCHEDULE_CONFIG_CHANGED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Start the ordinary ingest command only after the reviewed configuration and
 * argv are proven unchanged, with the inherited task environment replaced.
 * The task has no console, so the child's output and every refusal here land
 * in the lane's private log.
 */
// Marks an error already written to the lane log, so the entrypoint's outer
// recorder does not write the same failure twice.
function markLogged(error, recorded) {
  if (recorded && error && typeof error === "object") {
    try { error.windowsLaneLogged = true; } catch { /* a frozen error is still reported */ }
  }
  return error;
}

/**
 * Record a failure of the scheduled entry in the log its lane would use. The
 * task runs under a headless console host that discards stdout and stderr, so
 * without this a die(), a spawn error or a rotation error left no trace but
 * Task Scheduler's numeric last result. When the manifest cannot name the lane
 * the line goes to the shared runner log beside the lane logs instead.
 */
export function recordWindowsScheduledFailure(manifestPath, error, options = {}) {
  if (error?.windowsLaneLogged) return true;
  const log = laneLog(options);
  let taskName = null;
  if (!options.laneUnknown) {
    try {
      ({ taskName } = buildWindowsSchedulerPlan(manifestPath, { ...options, plan: undefined, action: "status" }));
    } catch {
      // The lane is unknown; the shared runner log below still records the run.
    }
  }
  const recorded = log.record(windowsLaneLogPath(taskName, options), error);
  markLogged(error, recorded);
  return recorded;
}

function defaultHostFileExists(path) {
  // Only a real Windows host can check a Windows path; elsewhere it is unknown.
  if (!isHostAbsolute(path) || !win32.isAbsolute(path)) return true;
  return existsSync(path);
}

export function runWindowsScheduledIngest(manifestPath, options = {}) {
  const log = laneLog(options);
  let plan;
  try {
    plan = options.plan || buildWindowsSchedulerPlan(manifestPath, options);
  } catch (error) {
    // A manifest that no longer builds (lane disabled, domain removed) is
    // still recorded in the log this lane would have used, when it is known.
    recordWindowsScheduledFailure(manifestPath, error, options);
    throw error;
  }
  const refuse = (message) => {
    let recorded = false;
    try {
      log.append(plan.logPath, `${new Date().toISOString()} scheduled ingest refused: ${message}\n`);
      recorded = true;
    } catch {
      // An unwritable log must not turn a refusal into a run.
    }
    return markLogged(scheduleRefusal(message), recorded);
  };
  if (typeof options.expectedConfigHash !== "string" || !/^[0-9a-f]{64}$/.test(options.expectedConfigHash)) {
    throw refuse("the scheduled task carries no configuration hash; reinstall it with brain schedule --install");
  }
  if (options.expectedConfigHash !== plan.configHash) {
    throw refuse("the manifest's scheduled configuration changed after this task was installed; reinstall it with brain schedule --install before it may read credentials");
  }
  if (options.expectedChildArguments &&
      JSON.stringify(options.expectedChildArguments) !== JSON.stringify(plan.childArguments)) {
    throw refuse("the scheduled ingest action no longer matches this manifest; reinstall the task");
  }
  const fail = (error) => markLogged(error, log.record(plan.logPath, error));
  // A child started on a missing brain.mjs would print its module error into
  // the log too, but this names the cause and the reinstall directly.
  if (!(options.fileExists || defaultHostFileExists)(plan.brainCliPath)) {
    throw fail(scheduleRefusal(
      `the installed brain.mjs is missing at ${plan.brainCliPath}; reinstall the package, then run brain schedule --install`,
      "WINDOWS_SCHEDULE_RUNNER_MISSING"));
  }
  const run = options.ingestRunner || spawnSync;
  let fd;
  try {
    fd = log.open(plan.logPath);
  } catch (error) {
    const wrapped = new Error(`could not open or rotate the lane log: ${error?.message || error}`, { cause: error });
    if (typeof error?.code === "string") wrapped.code = error.code;
    throw fail(wrapped);
  }
  let result;
  try {
    result = run(plan.nodePath, [plan.brainCliPath, ...plan.childArguments], {
      cwd: win32.dirname(plan.manifestPath),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      stdio: ["ignore", fd, fd],
      env: safeWindowsScheduledEnvironment(options.environment || process.env),
    });
  } catch (error) {
    throw fail(error);
  } finally {
    log.close(fd);
  }
  if (result?.error) throw fail(result.error);
  const status = Number.isInteger(result?.status) ? result.status : 1;
  if (status !== 0) {
    try {
      log.append(plan.logPath, `${new Date().toISOString()} scheduled ingest child exited with status ${status}\n`);
    } catch {
      // The exit status still reaches Task Scheduler's last result.
    }
  }
  return { ...plan, status };
}

function runSchtasks(args, options, program = options.schtasksPath || "schtasks.exe") {
  const run = options.processRunner || spawnSync;
  const sourceEnvironment = options.environment || process.env;
  const environment = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]) {
    if (sourceEnvironment[name] !== undefined) environment[name] = sourceEnvironment[name];
  }
  // Bytes, not "utf8": schtasks writes in the console code page or UTF-16
  // depending on build and redirection, and decodeSchtasksOutput decides.
  return run(program, args, {
    windowsHide: true,
    shell: false,
    env: environment,
  });
}

/** Decode schtasks output whether it arrived as UTF-16LE, UTF-8 or text. */
export function decodeSchtasksOutput(output) {
  if (output === undefined || output === null) return "";
  if (!Buffer.isBuffer(output) && !(output instanceof Uint8Array)) {
    return String(output).replace(/^\uFEFF/, "");
  }
  const bytes = Buffer.from(output);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) return bytes.toString("utf16le");
  return bytes.toString("utf8").replace(/^\uFEFF/, "");
}

function failureText(result) {
  return [result?.error?.message, decodeSchtasksOutput(result?.stdout), decodeSchtasksOutput(result?.stderr)]
    .filter(Boolean).join(" ").trim();
}

export function installWindowsScheduler(manifestPath, options = {}) {
  const plan = options.plan || buildWindowsSchedulerPlan(manifestPath, options);
  (options.writeTaskDefinition || writePrivateTaskDefinition)(plan.definitionPath, encodeTaskDefinition(plan.taskXml));
  const result = runSchtasks(plan.createArgs, options);
  if (result?.error || result?.status !== 0) {
    const detail = failureText(result) || "Task Scheduler returned an unknown error";
    const error = new Error(
      `nothing was scheduled because schtasks could not create the per-user task: ${detail}\n` +
      `      The reviewed task definition is saved at ${plan.definitionPath}\n` +
      `      Manual recipe: ${renderWindowsTaskRecipe(plan)}\n` +
      `      Run once by hand: ${oneTimeBrainCommand(plan.brainPath, plan.childArguments)}`
    );
    error.code = "WINDOWS_SCHEDULE_CREATE_FAILED";
    throw error;
  }
  return { ...plan, installed: true, output: decodeSchtasksOutput(result.stdout).trim() };
}

/** Parse schtasks CSV: quoted fields, doubled quotes, one record per line. */
export function parseSchtasksCsv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = [];
    const pattern = /\s*(?:"((?:[^"]|"")*)"|([^,]*))\s*(,|$)/gy;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      fields.push(match[1] !== undefined ? match[1].replaceAll('""', '"') : match[2]);
      if (match[3] === "" ) break;
    }
    rows.push(fields);
  }
  return rows;
}

const normalizedText = (text) => String(text || "").replace(/\s+/g, " ").trim();

function netCommand(options) {
  if (options.netPath) return options.netPath;
  const systemRoot = (options.environment || process.env).SystemRoot || options.systemRoot;
  return systemRoot && win32.isAbsolute(String(systemRoot))
    ? win32.join(String(systemRoot), "System32", "net.exe")
    : "net.exe";
}

function unprovenTask(plan, detail) {
  const error = new Error(
    `schtasks could not read ${plan.taskName}, so it cannot be proven present or absent: ${detail || "unknown error"}`);
  error.code = "WINDOWS_SCHEDULE_TASK_UNPROVEN";
  return error;
}

/**
 * Decide presence from a query of this lane's task name only.
 *
 * Present: the targeted query succeeds and a row carries the exact task path
 * (`\name`). Paths are never localized, so this match reads no language.
 *
 * Absent: schtasks exits nonzero for every error, so the exit code alone
 * cannot tell "no such task" from "this task is unreadable" or "the service is
 * unavailable". Its error line is the system message for the failure in the
 * display language, so instead of reading English text the answer is compared
 * with the system's own rendering of ERROR_FILE_NOT_FOUND (Win32 error 2, the
 * error Task Scheduler returns for a missing task), which `net helpmsg 2`
 * prints from the same localized message table. Both conditions are required:
 * a nonzero exit AND that exact message. Access denied, a corrupt copy of this
 * task, or a stopped service each produce a different message and fail closed,
 * as does an unreadable not-found message. The unfiltered listing is never
 * used, because one corrupt unrelated task makes it fail for everyone.
 */
function queryNamedTask(plan, options) {
  const result = runSchtasks(plan.presenceArgs, options);
  if (result?.error) throw unprovenTask(plan, failureText(result));
  if (result?.status === 0) {
    const wanted = `\\${plan.taskName}`.toLowerCase();
    const row = parseSchtasksCsv(decodeSchtasksOutput(result.stdout))
      .find((fields) => fields.some((field) => field.trim().toLowerCase() === wanted));
    if (!row) throw unprovenTask(plan, "the targeted query succeeded without naming the task");
    return { present: true, row };
  }
  const detail = failureText(result);
  const help = runSchtasks(["helpmsg", "2"], options, netCommand(options));
  const notFound = help?.error ? "" : normalizedText(decodeSchtasksOutput(help?.stdout));
  // net's exit code is not relied on; the exact message match is the evidence.
  if (notFound.length >= 8 && normalizedText(detail).includes(notFound)) return { present: false, row: null };
  throw unprovenTask(plan, detail);
}

// Task Scheduler result codes that are not failures of the refresh itself.
const TASK_RESULT_MEANINGS = Object.freeze({
  0: "success",
  0x41300: "ready",
  0x41301: "running now",
  0x41302: "disabled",
  0x41303: "has not run yet",
  0x41306: "terminated by the owner",
  0x8004131f: "skipped, the previous run was still running",
  0x800710e0: "refused to start by Task Scheduler",
});
const NON_FAILURE_RESULTS = new Set([0, 0x41300, 0x41301, 0x41303]);

/** Render schtasks' decimal Last Result the way an owner can act on it. */
export function describeWindowsTaskResult(value) {
  if (!Number.isInteger(value)) return { text: "unknown", failed: false };
  const unsigned = value >>> 0;
  const meaning = TASK_RESULT_MEANINGS[unsigned];
  // Small values are the ingest's own exit code; the rest are HRESULTs.
  const shown = unsigned < 0x10000 ? String(unsigned) : `0x${unsigned.toString(16).padStart(8, "0").toUpperCase()}`;
  const failed = !NON_FAILURE_RESULTS.has(unsigned);
  return { text: `${shown} (${meaning || (failed ? "failed; see the log" : "unknown")})`, failed };
}

/**
 * The verbose CSV columns keep a fixed order in every display language:
 * HostName, TaskName, Next Run Time, Status, Logon Mode, Last Run Time,
 * Last Result. The time stays in the owner's locale format; the result is a
 * decimal number and is only accepted as one.
 */
function lastRunOf(row) {
  const time = typeof row?.[5] === "string" && row[5].trim() ? row[5].trim() : null;
  const raw = typeof row?.[6] === "string" ? row[6].trim() : "";
  return { lastRunTime: time, lastResult: /^-?\d+$/.test(raw) ? Number(raw) : null };
}

function storedElement(xml, element) {
  const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml);
  return match ? match[1].trim() : null;
}

/**
 * Compare the registered definition with what install would write now. The
 * config hash carries every reviewed field (cron, domain, admin key name,
 * token store, source configuration, folder, interpreter), and the settings
 * are the ones a manual edit in Task Scheduler could weaken. Only ASCII
 * values are compared, so the code page schtasks answers in cannot fake drift.
 */
function storedDefinitionDrift(storedXml, expected) {
  const storedArguments = storedElement(storedXml, "Arguments") || "";
  const storedHash = /(?:^|\s)--config-hash\s+([0-9a-f]{64})(?:\s|$)/.exec(storedArguments)?.[1] || null;
  if (storedHash !== expected.configHash) return true;
  if (String(storedElement(storedXml, "Command") || "").toLowerCase() !== expected.hostPath.toLowerCase()) return true;
  if (!/^--headless\s/.test(storedArguments)) return true;
  const settings = (/<Settings>([\s\S]*?)<\/Settings>/.exec(storedXml)?.[1] ?? "")
    .replace(/<IdleSettings>[\s\S]*?<\/IdleSettings>/, "");
  return Object.entries(WINDOWS_TASK_SETTINGS).some(([element, value]) =>
    (storedElement(settings, element) ?? TASK_SETTING_DEFAULTS[element]).toLowerCase() !== value.toLowerCase());
}

export function statusWindowsScheduler(manifestPath, options = {}) {
  const plan = options.plan || buildWindowsSchedulerPlan(manifestPath, { ...options, action: "status" });
  const logPath = plan.logPath || windowsLaneLogPath(plan.taskName, options);
  const presence = queryNamedTask(plan, options);
  if (!presence.present) {
    return {
      ...plan, installed: false, definitionDrift: null, scheduleError: null, output: "",
      logPath, lastRunTime: null, lastResult: null, runnerMissing: null,
    };
  }
  const { lastRunTime, lastResult } = lastRunOf(presence.row);
  const result = runSchtasks(plan.queryArgs, options);
  if (result?.error || result?.status !== 0) {
    throw new Error(`schtasks could not read the definition of ${plan.taskName}: ${failureText(result) || "unknown error"}`);
  }
  const output = decodeSchtasksOutput(result.stdout).trim();
  // Status reports drift against what install would write now, as the
  // LaunchAgent status does, while staying reachable when the lane has since
  // been disabled or its cron can no longer be represented.
  let scheduleError = null;
  let definitionDrift = null;
  let expected = null;
  try {
    expected = buildWindowsSchedulerPlan(manifestPath, { ...options, plan: undefined, action: "install" });
    definitionDrift = storedDefinitionDrift(output, expected);
  } catch (error) {
    scheduleError = error?.message || String(error);
  }
  // When the task's own brain.mjs is gone, node fails before any code of ours
  // runs and the headless host discards its error, so the lane log cannot say
  // so. Status is the one place that can.
  const runnerMissing = expected?.brainCliPath
    ? !(options.fileExists || defaultHostFileExists)(expected.brainCliPath)
    : null;
  return {
    ...plan, installed: true, definitionDrift, scheduleError, output,
    logPath: expected?.logPath || logPath, lastRunTime, lastResult, runnerMissing,
  };
}

export function removeWindowsScheduler(manifestPath, options = {}) {
  const plan = options.plan || buildWindowsSchedulerPlan(manifestPath, { ...options, action: "remove" });
  const result = runSchtasks(plan.deleteArgs, options);
  if (!result?.error && result?.status === 0) {
    return { ...plan, installed: false, removed: true, output: decodeSchtasksOutput(result.stdout).trim() };
  }
  const detail = failureText(result);
  // A failed delete is success only when the targeted query proves the task
  // is gone; an unprovable answer is reported as the delete failure it is.
  let presence;
  try {
    presence = queryNamedTask(plan, options);
  } catch (error) {
    throw new Error(`schtasks could not delete ${plan.taskName}: ${detail || "unknown error"}; ${error.message}`);
  }
  if (!presence.present) return { ...plan, installed: false, removed: false, output: "" };
  throw new Error(`schtasks could not delete ${plan.taskName}: ${detail || "unknown error"}`);
}
