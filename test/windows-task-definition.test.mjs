import { schedulerRunnerAttempts } from "./helpers/scheduler-runner-guard.mjs";
/**
 * The Windows Task Scheduler lane registers one reviewed XML task definition.
 * These checks pin what schtasks' command-line defaults used to get wrong:
 * missed and on-battery runs, the argv a watched drive root reaches Node with,
 * config drift the stored command line cannot show, localized schtasks output,
 * and a visible console window whose close kills the ingest.
 *
 * schtasks cannot run here. The command-line chain is proven with an
 * independent model of the MSVC argv rules Node and conhost use.
 */
import assert from "node:assert/strict";
import * as brain from "../brain.mjs";
import * as scheduler from "../operations/windows-task-scheduler.mjs";

const {
  buildWindowsSchedulerPlan,
  installWindowsScheduler,
  removeWindowsScheduler,
  runWindowsScheduledIngest,
  statusWindowsScheduler,
} = scheduler;

const failures = [];
const passes = [];
async function check(name, run) {
  try {
    await run();
    passes.push(name);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 4).join("\n  ")}`);
  }
}

const localAppData = String.raw`C:\Users\Fixture User\AppData\Local`;
const systemRoot = String.raw`C:\Windows`;
const manifestPath = String.raw`C:\Users\Fixture User\Financial Brain\brain.manifest.json`;
const nodePath = String.raw`C:\Program Files\nodejs\node.exe`;
const brainCliPath = String.raw`C:\Users\Fixture User\AppData\Local\FinancialBrain\node_modules\brain-installer\brain.mjs`;
const conhostPath = String.raw`C:\Windows\System32\conhost.exe`;

const baseManifest = {
  manifest_version: 1,
  client: { slug: "fixture-brain", display_name: "Fixture" },
  brain: { version: "0.4.8", domain: "fixture.invalid" },
  corpora: {
    google_drive: { enabled: true },
    local_folder: { enabled: true, path: String.raw`C:\Source Files`, source: "documents" },
    slack: { enabled: true, source: "team-chat", channel_ids: ["C1"] },
  },
  operations: {
    ingest_cron: "15 2 * * *",
    folder_ingest_cron: "30 6 * * 1-5",
    provider_crons: { slack: "45 */2 * * *" },
    provider_token_stores: { slack: "file" },
  },
};

const withManifest = (edit) => {
  const copy = structuredClone(baseManifest);
  edit(copy);
  return copy;
};

const options = (extra = {}) => ({
  manifest: baseManifest,
  windowsManifestPath: manifestPath,
  localAppData,
  nodePath,
  environment: { LOCALAPPDATA: localAppData, SystemRoot: systemRoot },
  now: new Date(2026, 8, 1, 12, 0, 0),
  // Fixture paths are absolute on a Windows CI host but do not exist there.
  fileExists: () => true,
  ...extra,
});

const folderOptions = (path, extra = {}) => options({
  folder: true,
  validateExtras: false,
  manifest: withManifest((m) => { m.corpora.local_folder.path = path; }),
  ...extra,
});

function xmlText(xml, element) {
  const match = new RegExp(`<${element}>([\\s\\S]*?)</${element}>`).exec(String(xml || ""));
  if (!match) return null;
  return match[1]
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

// ---------------------------------------------------------------------------
// An independent model of the Microsoft C runtime argv rules (the ones Node,
// conhost and CommandLineToArgvW apply), written from the documented rules
// rather than from the module under test.
function msvcParse(commandLine) {
  const args = [];
  let i = 0;
  const n = commandLine.length;
  // argv[0] is the program name: quotes delimit it, backslashes are literal.
  while (i < n && /[ \t]/.test(commandLine[i])) i++;
  if (commandLine[i] === '"') {
    const end = commandLine.indexOf('"', i + 1);
    args.push(commandLine.slice(i + 1, end < 0 ? n : end));
    i = end < 0 ? n : end + 1;
  } else {
    let start = i;
    while (i < n && !/[ \t]/.test(commandLine[i])) i++;
    args.push(commandLine.slice(start, i));
  }
  for (;;) {
    while (i < n && /[ \t]/.test(commandLine[i])) i++;
    if (i >= n) break;
    let argument = "";
    let quoted = false;
    while (i < n) {
      const c = commandLine[i];
      if (!quoted && /[ \t]/.test(c)) break;
      if (c === "\\") {
        let count = 0;
        while (commandLine[i] === "\\") { count++; i++; }
        if (commandLine[i] === '"') {
          argument += "\\".repeat(Math.floor(count / 2));
          if (count % 2 === 1) { argument += '"'; i++; }
        } else {
          argument += "\\".repeat(count);
        }
        continue;
      }
      if (c === '"') {
        if (quoted && commandLine[i + 1] === '"') { argument += '"'; i += 2; continue; }
        quoted = !quoted;
        i++;
        continue;
      }
      argument += c;
      i++;
    }
    args.push(argument);
  }
  return args;
}

// conhost rebuilds its client's command line from the argv it parsed. Model
// that rebuild with the standard MSVC round-trip quoting so the check holds
// whether conhost forwards the text verbatim or re-escapes it.
function msvcRequote(argument) {
  if (argument.length > 0 && !/[ \t"]/.test(argument)) return argument;
  let out = '"';
  let slashes = 0;
  for (const c of argument) {
    if (c === "\\") { slashes++; continue; }
    if (c === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + c;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/**
 * Return every argv Node could receive for this plan's scheduled action.
 * Before the XML definition existed the action was a /TR string; that path
 * models cmd.exe /s /c quote stripping and npm's brain.cmd %* forwarding, so
 * the pre-fix failure is the real one rather than "field missing".
 */
function scheduledNodeArgvVariants(plan) {
  const command = xmlText(plan.taskXml, "Command");
  const argumentsText = xmlText(plan.taskXml, "Arguments");
  if (command !== null && argumentsText !== null) {
    const hostArgv = msvcParse(`${msvcRequote(command)} ${argumentsText}`);
    assert.equal(hostArgv[1], "--headless", "the windowless host is told to stay headless");
    const verbatimClient = argumentsText.replace(/^--headless\s+/, "");
    const rebuiltClient = hostArgv.slice(2).map(msvcRequote).join(" ");
    return [msvcParse(verbatimClient), msvcParse(rebuiltClient)];
  }
  const run = String(plan.runCommand || "");
  const afterC = run.slice(run.indexOf(" /c ") + 4);
  const stripped = afterC.startsWith('"') ? afterC.slice(1, afterC.lastIndexOf('"')) : afterC;
  const firstEnd = stripped.startsWith('"') ? stripped.indexOf('"', 1) + 1 : stripped.search(/\s|$/);
  const forwarded = stripped.slice(firstEnd).replace(/^[ \t]+/, "");
  return [msvcParse(`"${nodePath}" "${brainCliPath}" ${forwarded}`)];
}

function flagsFrom(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[argv[i].slice(2)] = next; i++; }
    else flags[argv[i].slice(2)] = true;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// W1: the task is registered from an XML definition whose settings make a
// missed or on-battery run happen, not from schtasks' command-line defaults.
const providerPlan = buildWindowsSchedulerPlan(manifestPath, options({ provider: "slack" }));
const taskName = "com.brain-installer.fixture-brain.slack-ingest";

await check("W1 install registers an XML task definition instead of /TR command-line defaults", () => {
  assert.equal(typeof providerPlan.taskXml, "string");
  assert.equal(providerPlan.definitionPath,
    `${String.raw`C:\Users\Fixture User\AppData\Local\FinancialBrain\schedules`}\\${taskName}.xml`);
  assert.deepEqual(providerPlan.createArgs,
    ["/Create", "/F", "/TN", taskName, "/XML", providerPlan.definitionPath]);
  assert.equal(providerPlan.createArgs.includes("/TR"), false);
  assert.equal(providerPlan.createArgs.includes("/SC"), false);
});

await check("W1 the XML settings run a missed or on-battery trigger and never stack runs", () => {
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(providerPlan.taskXml)?.[1] ?? "";
  assert.equal(xmlText(settings, "StartWhenAvailable"), "true");
  assert.equal(xmlText(settings, "DisallowStartIfOnBatteries"), "false");
  assert.equal(xmlText(settings, "StopIfGoingOnBatteries"), "false");
  assert.equal(xmlText(settings, "MultipleInstancesPolicy"), "IgnoreNew");
  assert.equal(xmlText(settings, "RunOnlyIfIdle"), "false");
  assert.equal(xmlText(settings, "Enabled"), "true");
});

await check("W1 the XML names the task namespace, a least-privilege interactive principal and one Exec action", () => {
  const xml = providerPlan.taskXml;
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>\r?\n<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/);
  const principal = /<Principal id="Author">([\s\S]*?)<\/Principal>/.exec(xml)?.[1] ?? "";
  // DPAPI decrypts the admin key only inside the owner's logon session, so the
  // task must run with the interactive token, never S4U or a stored password.
  assert.equal(xmlText(principal, "LogonType"), "InteractiveToken");
  assert.equal(xmlText(principal, "RunLevel"), "LeastPrivilege");
  assert.doesNotMatch(xml, /S4U|<Password>|HighestAvailable/);
  assert.equal((xml.match(/<Exec>/g) || []).length, 1);
  assert.match(xml, /<Actions Context="Author">\s*<Exec>\s*<Command>[^<]+<\/Command>\s*<Arguments>[^<]+<\/Arguments>\s*<WorkingDirectory>[^<]+<\/WorkingDirectory>\s*<\/Exec>\s*<\/Actions>/);
  assert.equal(xmlText(xml, "WorkingDirectory"), String.raw`C:\Users\Fixture User\Financial Brain`);
});

await check("W1 the Exec action splits the program from its arguments", () => {
  assert.equal(xmlText(providerPlan.taskXml, "Command"), conhostPath);
  assert.equal(xmlText(providerPlan.taskXml, "Arguments"),
    `--headless "${nodePath}" "${brainCliPath}" windows-scheduled-ingest "${manifestPath}" --from slack --config-hash ${providerPlan.configHash}`);
});

await check("W1 triggers reproduce each supported cron exactly", () => {
  const hourlyEveryTwo = /<CalendarTrigger>([\s\S]*?)<\/CalendarTrigger>/.exec(providerPlan.taskXml)?.[1] ?? "";
  assert.equal(xmlText(hourlyEveryTwo, "StartBoundary"), "2026-09-01T00:45:00");
  assert.equal(xmlText(hourlyEveryTwo, "Interval"), "PT2H");
  assert.equal(xmlText(hourlyEveryTwo, "Duration"), "P1D");
  assert.equal(xmlText(hourlyEveryTwo, "StopAtDurationEnd"), "false");
  assert.equal(xmlText(hourlyEveryTwo, "DaysInterval"), "1");

  const daily = buildWindowsSchedulerPlan(manifestPath, options()).taskXml;
  assert.equal(xmlText(daily, "StartBoundary"), "2026-09-01T02:15:00");
  assert.equal(xmlText(daily, "DaysInterval"), "1");
  assert.doesNotMatch(daily, /<Repetition>/);

  const weekly = buildWindowsSchedulerPlan(manifestPath, options({ folder: true, validateExtras: false })).taskXml;
  assert.equal(xmlText(weekly, "StartBoundary"), "2026-09-01T06:30:00");
  assert.match(weekly,
    /<ScheduleByWeek>\s*<DaysOfWeek>\s*<Monday \/>\s*<Tuesday \/>\s*<Wednesday \/>\s*<Thursday \/>\s*<Friday \/>\s*<\/DaysOfWeek>\s*<WeeksInterval>1<\/WeeksInterval>\s*<\/ScheduleByWeek>/);
  assert.doesNotMatch(weekly, /<Sunday \/>|<Saturday \/>/);
});

await check("W1 install writes the definition as UTF-16LE with a BOM before schtasks reads it", () => {
  const events = [];
  const result = installWindowsScheduler(manifestPath, options({
    provider: "slack",
    writeTaskDefinition(path, bytes) { events.push(["write", path, bytes]); },
    processRunner(command, args) { events.push(["schtasks", command, args]); return { status: 0, stdout: "SUCCESS", stderr: "" }; },
  }));
  assert.equal(result.installed, true);
  assert.deepEqual(events.map((event) => event[0]), ["write", "schtasks"]);
  const [, path, bytes] = events[0];
  assert.equal(path, providerPlan.definitionPath);
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "the definition starts with the UTF-16LE BOM");
  assert.equal(bytes.subarray(2).toString("utf16le"), result.taskXml);
  assert.deepEqual(events[1][2], ["/Create", "/F", "/TN", taskName, "/XML", providerPlan.definitionPath]);
});

// ---------------------------------------------------------------------------
// W2: an unattended child receives no Cloudflare deployment token, so it can
// reach the brain only through brain.domain. macOS refuses without it.
for (const lane of [
  { name: "Drive", extra: {}, error: /brain\.domain is required for unattended Drive ingest/ },
  { name: "folder", extra: { folder: true, validateExtras: false }, error: /brain\.domain is required for unattended folder ingest/ },
  { name: "slack", extra: { provider: "slack" }, error: /brain\.domain is required for unattended Slack ingest/ },
]) {
  for (const domain of [undefined, "", "   "]) {
    await check(`W2 the ${lane.name} install refuses a ${JSON.stringify(domain ?? null)} brain.domain before schtasks`, () => {
      let schtasksCalls = 0;
      let definitionWrites = 0;
      assert.throws(() => installWindowsScheduler(manifestPath, options({
        ...lane.extra,
        manifest: withManifest((m) => { if (domain === undefined) delete m.brain.domain; else m.brain.domain = domain; }),
        writeTaskDefinition() { definitionWrites++; },
        processRunner() { schtasksCalls++; return { status: 0, stdout: "SUCCESS", stderr: "" }; },
      })), lane.error);
      assert.equal(schtasksCalls, 0);
      assert.equal(definitionWrites, 0);
    });
  }
}

// ---------------------------------------------------------------------------
// W3/W5: every path the scheduled action carries reaches Node's argv intact.
const longOneDrive = String.raw`C:\Users\Fixture User\OneDrive - Fixture Organization Name\Shared Documents\Finance Department\Monthly Close Exports\Fiscal Year Twenty Twenty Six\Reconciled Statements And Supporting Schedules\\`.slice(0, -1);
const folderScenarios = [
  { name: "a drive root", path: "D:\\" },
  { name: "a folder with a trailing separator", path: "C:\\Exports\\" },
  { name: "a spaced folder with a trailing separator", path: "C:\\My Exports\\" },
  { name: "a spaced folder", path: String.raw`C:\Source Files` },
  { name: "an ordinary OneDrive folder past the old 261-character /TR cap", path: longOneDrive },
];
for (const scenario of folderScenarios) {
  await check(`W3 ${scenario.name} reaches Node's argv exactly as the scheduled action`, async () => {
    const plan = buildWindowsSchedulerPlan(manifestPath, folderOptions(scenario.path));
    const expectedTail = [
      "windows-scheduled-ingest", manifestPath, "--path", scenario.path, "--source", "documents",
      ...(plan.configHash ? ["--config-hash", plan.configHash] : []),
    ];
    for (const argv of scheduledNodeArgvVariants(plan)) {
      assert.deepEqual(argv, [nodePath, brainCliPath, ...expectedTail]);
      // The parsed argv is what the scheduled entrypoint receives; it must
      // rebuild the same child argv the plan would run.
      const seen = [];
      await brain.cmdWindowsScheduledIngest(argv[3], {
        platform: "win32",
        flags: flagsFrom(argv.slice(4)),
        scheduler: { runWindowsScheduledIngest(path, runOptions) { seen.push(runOptions); return { status: 0 }; } },
        setExitCode() {},
      });
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].expectedChildArguments, plan.childArguments);
    }
  });
}

await check("W5 the long OneDrive action exceeds the old /TR cap and still registers", () => {
  const plan = buildWindowsSchedulerPlan(manifestPath, folderOptions(longOneDrive));
  const action = `${xmlText(plan.taskXml, "Command")} ${xmlText(plan.taskXml, "Arguments")}`;
  assert.ok(action.length > 261, `the fixture action is ${action.length} characters`);
  assert.equal(plan.createArgs.some((argument) => argument.length > 261), false,
    "schtasks receives only the task name and the definition path");
});

for (const character of ['"', "%"]) {
  await check(`W3 a watched folder carrying ${JSON.stringify(character)} is refused before any definition is written`, () => {
    let writes = 0;
    let calls = 0;
    assert.throws(() => installWindowsScheduler(manifestPath, folderOptions(`C:\\Odd${character}Folder\\`, {
      writeTaskDefinition() { writes++; },
      processRunner() { calls++; return { status: 0 }; },
    })), (error) => error.code === "WINDOWS_SCHEDULE_PATH_REFUSED");
    assert.equal(writes, 0);
    assert.equal(calls, 0);
  });
}

// ---------------------------------------------------------------------------
// W4: the run-time guard and status compare the reviewed configuration, not
// only the command line.
const hashOf = (extra) => buildWindowsSchedulerPlan(manifestPath, options(extra)).configHash;
await check("W4 the scheduled action carries a config hash bound to every reviewed field", () => {
  const slack = { provider: "slack" };
  const base = hashOf(slack);
  assert.match(String(base), /^[0-9a-f]{64}$/);
  assert.equal(hashOf(slack), base, "the hash is deterministic");
  const edits = {
    cron: (m) => { m.operations.provider_crons.slack = "45 * * * *"; },
    domain: (m) => { m.brain.domain = "other.invalid"; },
    admin_key_secret: (m) => { m.operations.admin_key_secret = "OTHER_ADMIN_KEY_NAME"; },
    token_store: (m) => { m.operations.provider_token_stores.slack = "keychain"; },
    source_configuration: (m) => { m.corpora.slack.channel_ids.push("C2"); },
  };
  for (const [field, edit] of Object.entries(edits)) {
    assert.notEqual(hashOf({ ...slack, manifest: withManifest(edit) }), base, `${field} is bound into the hash`);
  }
  const folder = { folder: true, validateExtras: false };
  assert.notEqual(
    hashOf({ ...folder, manifest: withManifest((m) => { m.corpora.local_folder.path = String.raw`C:\Other`; }) }),
    hashOf(folder), "the watched folder path is bound into the hash");
  assert.notEqual(
    hashOf({ provider: "slack", nodePath: String.raw`C:\Other\node.exe` }), base,
    "the pinned interpreter is bound into the hash");
});

await check("W4 a scheduled run refuses an edited cron before any ingest child starts", () => {
  const installed = buildWindowsSchedulerPlan(manifestPath, options({
    manifest: withManifest((m) => { m.operations.ingest_cron = "15 2 * * *"; }),
  }));
  const logLines = [];
  let children = 0;
  assert.throws(() => runWindowsScheduledIngest(manifestPath, options({
    manifest: withManifest((m) => { m.operations.ingest_cron = "0 * * * *"; }),
    brainCliPath,
    expectedConfigHash: installed.configHash,
    expectedChildArguments: installed.childArguments,
    openLog(path) { logLines.push(["open", path]); return 42; },
    appendLog(path, text) { logLines.push(["append", path, text]); },
    closeLog() {},
    ingestRunner() { children++; return { status: 0 }; },
  })), (error) => error.code === "WINDOWS_SCHEDULE_CONFIG_CHANGED");
  assert.equal(children, 0);
  assert.ok(logLines.some(([kind, , text]) => kind === "append" && /reinstall/.test(text)),
    "the refusal reaches the lane's private log, since the task has no console");
});

await check("W4 a scheduled run without a config hash is refused", () => {
  let children = 0;
  assert.throws(() => runWindowsScheduledIngest(manifestPath, options({
    provider: "slack",
    brainCliPath,
    expectedChildArguments: providerPlan.childArguments,
    openLog() { return 42; },
    appendLog() {},
    closeLog() {},
    ingestRunner() { children++; return { status: 0 }; },
  })), (error) => error.code === "WINDOWS_SCHEDULE_CONFIG_CHANGED");
  assert.equal(children, 0);
});

await check("W4 the scheduled entrypoint requires and forwards --config-hash", async () => {
  const seen = [];
  const scheduled = { runWindowsScheduledIngest(path, runOptions) { seen.push(runOptions); return { status: 0 }; } };
  await brain.cmdWindowsScheduledIngest(manifestPath, {
    platform: "win32", flags: { from: "slack", "config-hash": "a".repeat(64) }, scheduler: scheduled, setExitCode() {},
  });
  assert.equal(seen[0]?.expectedConfigHash, "a".repeat(64));
  await assert.rejects(brain.cmdWindowsScheduledIngest(manifestPath, {
    platform: "win32", flags: { from: "slack" }, scheduler: scheduled, setExitCode() {},
  }), /config-hash/);
  assert.equal(seen.length, 1, "the hashless entry never reached the runner");
});

const csvListing = (names, status = "Bereit") =>
  names.map((name) => `"\\${name}","N/V","${status}"`).join("\r\n");
// The German display language's rendering of ERROR_FILE_NOT_FOUND, as both
// schtasks and `net helpmsg 2` print it from the same message table.
const germanNotFound = "Das System kann die angegebene Datei nicht finden.";
const statusRunner = (installedXml, { listing = [taskName], calls = [] } = {}) => (command, args) => {
  calls.push(args);
  if (/net(\.exe)?$/i.test(command)) return { status: 0, stdout: `\r\n${germanNotFound}\r\n\r\n`, stderr: "" };
  if (args[0] === "/Query" && args.includes("/XML")) return { status: 0, stdout: installedXml, stderr: "" };
  // A targeted query answers for the named task only: its row, or not found.
  if (args[0] === "/Query" && args.includes("/TN")) {
    return listing.includes(args[args.indexOf("/TN") + 1])
      ? { status: 0, stdout: csvListing(listing), stderr: "" }
      : { status: 1, stdout: "", stderr: `FEHLER: ${germanNotFound}` };
  }
  return { status: 1, stdout: "", stderr: "unexpected" };
};

await check("W4 status reports a cron edit as drift even though the command line is unchanged", () => {
  const dailyManifest = withManifest((m) => { m.operations.provider_crons.slack = "15 2 * * *"; });
  const hourlyManifest = withManifest((m) => { m.operations.provider_crons.slack = "15 * * * *"; });
  const installed = buildWindowsSchedulerPlan(manifestPath, options({ provider: "slack", manifest: dailyManifest }));
  const same = statusWindowsScheduler(manifestPath, options({
    provider: "slack", manifest: dailyManifest, processRunner: statusRunner(installed.taskXml),
  }));
  assert.equal(same.installed, true);
  assert.equal(same.definitionDrift, false);
  const drifted = statusWindowsScheduler(manifestPath, options({
    provider: "slack", manifest: hourlyManifest, processRunner: statusRunner(installed.taskXml),
  }));
  assert.equal(drifted.installed, true);
  assert.equal(drifted.definitionDrift, true, "a changed cron is drift");
});

await check("W4 status reports a weakened power setting as drift", () => {
  const weakened = providerPlan.taskXml.replace(
    "<StartWhenAvailable>true</StartWhenAvailable>", "<StartWhenAvailable>false</StartWhenAvailable>");
  const result = statusWindowsScheduler(manifestPath, options({ provider: "slack", processRunner: statusRunner(weakened) }));
  assert.equal(result.definitionDrift, true);
});

await check("W4 a stored definition that omits a battery setting is judged by the schema default", () => {
  const omitted = providerPlan.taskXml.replace(/\s*<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/, "");
  const result = statusWindowsScheduler(manifestPath, options({ provider: "slack", processRunner: statusRunner(omitted) }));
  assert.equal(result.definitionDrift, true, "an omitted DisallowStartIfOnBatteries means true, which is drift");
  const defaultOnly = providerPlan.taskXml.replace(/\s*<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/, "");
  const same = statusWindowsScheduler(manifestPath, options({ provider: "slack", processRunner: statusRunner(defaultOnly) }));
  assert.equal(same.definitionDrift, false, "an omitted IgnoreNew is the schema default, not drift");
});

// ---------------------------------------------------------------------------
// W6: absence and drift are decided without reading localized text.
await check("W6 status on a German Windows proves absence from the targeted query", () => {
  const calls = [];
  const result = statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner: statusRunner("", { listing: ["Microsoft\\Office\\Andere Aufgabe", `${taskName}.old`], calls }),
  }));
  assert.equal(result.installed, false);
  assert.equal(result.output, "");
  assert.deepEqual(calls, [["/Query", "/TN", taskName, "/FO", "CSV", "/V", "/NH"], ["helpmsg", "2"]],
    "absence came from the targeted query and the system's own not-found message, not from an English string");
});

await check("W6 status of a present task reads the stored XML, not localized LIST labels", () => {
  const calls = [];
  const result = statusWindowsScheduler(manifestPath, options({
    provider: "slack", processRunner: statusRunner(providerPlan.taskXml, { calls }),
  }));
  assert.equal(result.installed, true);
  assert.equal(result.definitionDrift, false);
  assert.deepEqual(calls, [["/Query", "/TN", taskName, "/FO", "CSV", "/V", "/NH"], ["/Query", "/TN", taskName, "/XML"]]);
});

await check("W6 UTF-16 schtasks output is decoded before the exact task-name match", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csvListing([taskName]), "utf16le")]);
  const xml16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(providerPlan.taskXml, "utf16le")]);
  const result = statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner(command, args) {
      return { status: 0, stdout: args.includes("/XML") ? xml16 : utf16, stderr: "" };
    },
  }));
  assert.equal(result.installed, true);
  assert.equal(result.definitionDrift, false);
});

await check("W6 a failed task query is an error, never a quiet absence", () => {
  assert.throws(() => statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner() { return { status: 1, stdout: "", stderr: "FEHLER: Zugriff verweigert" }; },
  })), /could not read .* cannot be proven present or absent: FEHLER: Zugriff verweigert/);
});

await check("W6 remove of an already-deleted task on a French Windows is a quiet success", () => {
  const calls = [];
  const result = removeWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner(command, args) {
      calls.push(args);
      if (/net(\.exe)?$/i.test(command)) return { status: 0, stdout: "\r\nLe fichier spécifié est introuvable.\r\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "ERREUR : Le fichier spécifié est introuvable." };
    },
  }));
  assert.equal(result.removed, false);
  assert.equal(result.installed, false);
  assert.deepEqual(calls, [
    ["/Delete", "/TN", taskName, "/F"], ["/Query", "/TN", taskName, "/FO", "CSV", "/V", "/NH"], ["helpmsg", "2"],
  ]);
});

await check("W6 a failed delete of a task that is still listed is an error", () => {
  assert.throws(() => removeWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner(command, args) {
      if (args[0] === "/Delete") return { status: 1, stdout: "", stderr: "FEHLER: Zugriff verweigert" };
      return { status: 0, stdout: csvListing([taskName]), stderr: "" };
    },
  })), /could not delete/);
});

// ---------------------------------------------------------------------------
// W7: no console window, and the run's output lands in a private per-lane log.
await check("W7 the action starts through a headless console host, never a visible cmd.exe window", () => {
  assert.equal(xmlText(providerPlan.taskXml, "Command"), conhostPath);
  const argumentsText = xmlText(providerPlan.taskXml, "Arguments") || "";
  assert.match(argumentsText, /^--headless /);
  assert.doesNotMatch(argumentsText, /cmd\.exe|\/c /i);
});

await check("W7 the scheduled child writes to a private per-lane log", () => {
  assert.equal(providerPlan.logPath,
    `${String.raw`C:\Users\Fixture User\AppData\Local\FinancialBrain\logs`}\\${taskName}.log`);
  const opened = [];
  const calls = [];
  const result = runWindowsScheduledIngest(manifestPath, options({
    provider: "slack",
    brainCliPath,
    expectedConfigHash: providerPlan.configHash,
    expectedChildArguments: providerPlan.childArguments,
    openLog(path) { opened.push(path); return 42; },
    appendLog() {},
    closeLog(fd) { opened.push(["closed", fd]); },
    ingestRunner(command, args, runOptions) { calls.push({ command, args, runOptions }); return { status: 0 }; },
  }));
  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(opened, [providerPlan.logPath, ["closed", 42]]);
  assert.deepEqual(calls[0].runOptions.stdio, ["ignore", 42, 42]);
  assert.equal(calls[0].runOptions.windowsHide, true);
  assert.equal(calls[0].command, nodePath);
  assert.deepEqual(calls[0].args, [brainCliPath, ...providerPlan.childArguments]);
});


// ---------------------------------------------------------------------------
// W6-R: absence is decided from a query of the named task only. One corrupt
// task elsewhere in the owner's library made every unfiltered listing fail,
// which broke status before install and stopped --remove before the Brain's
// freshness expectation was cleared.
const corruptListingText = "ERROR: The task image is corrupt or has been tampered with.";
const notFoundText = "The system cannot find the file specified.";
const targetedQuery = ["/Query", "/TN", taskName, "/FO", "CSV", "/V", "/NH"];
const isNetCommand = (command) => /(^|[\\/])net(\.exe)?$/i.test(String(command));
const verboseRow = (name, { lastRun = "9/1/2026 2:15:00 AM", lastResult = "0" } = {}) =>
  ["FIXTURE-PC", `\\${name}`, "9/1/2026 4:45:00 AM", "Ready", "Interactive only", lastRun, lastResult,
    "FIXTURE-PC\\owner", "C:\\Windows\\System32\\conhost.exe --headless", "N/A"]
    .map((value) => `"${value.replaceAll('"', '""')}"`).join(",");
// A library holding one corrupt unrelated task: any unfiltered listing fails,
// while a query of this lane's exact name answers for that name alone.
const corruptLibraryRunner = ({ calls = [], task = null, deleteAnswer = null, targeted = null, help = null } = {}) =>
  (command, args) => {
    calls.push([isNetCommand(command) ? "net" : command, ...args]);
    if (isNetCommand(command)) return help ?? { status: 0, stdout: `\r\n${notFoundText}\r\n\r\n`, stderr: "" };
    if (args[0] === "/Query" && !args.includes("/TN")) return { status: 1, stdout: "", stderr: corruptListingText };
    if (args[0] === "/Delete") return deleteAnswer ?? { status: 1, stdout: "", stderr: `ERROR: ${notFoundText}` };
    if (args[0] === "/Query" && args.includes("/XML")) {
      return task ? { status: 0, stdout: task.xml, stderr: "" } : { status: 1, stdout: "", stderr: `ERROR: ${notFoundText}` };
    }
    if (targeted) return targeted;
    return task
      ? { status: 0, stdout: verboseRow(taskName, task), stderr: "" }
      : { status: 1, stdout: "", stderr: `ERROR: ${notFoundText}` };
  };
const unfilteredListingCalls = (calls) => calls.filter((call) => call[0] !== "net" && call[1] === "/Query" && !call.includes("/TN"));

const { mkdtempSync, rmSync, writeFileSync: writeFixtureFile } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join: joinHost } = await import("node:path");
const cliDirectory = mkdtempSync(joinHost(tmpdir(), "brain-windows-schedule-evidence-"));
const cliManifestPath = joinHost(cliDirectory, "brain.manifest.json");
writeFixtureFile(cliManifestPath, JSON.stringify(baseManifest));
const captureCli = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => { lines.push(parts.join(" ")); };
  try {
    return { result: await run(), text: lines.join("\n") };
  } catch (error) {
    return { error, text: lines.join("\n") };
  } finally {
    console.log = original;
  }
};
const cliOptions = (action, processRunner, posted, extra = {}) => ({
  platform: "win32",
  flags: { provider: "slack", [action]: true },
  resolveAdminKey: () => "fixture-admin-value",
  resolveBaseUrl: async () => "https://fixture.invalid",
  postSourceExpectation: async (base, key, body) => { posted.push(body); },
  schedulerOptions: {
    processRunner,
    environment: { LOCALAPPDATA: localAppData, SystemRoot: systemRoot },
    localAppData,
    systemRoot,
    nodePath,
    writeTaskDefinition() {},
    fileExists: () => true,
    windowsManifestPath: manifestPath,
    ...extra,
  },
});

await check("W6-R status before install survives a corrupt unrelated task and uses only the targeted query", () => {
  const calls = [];
  const result = statusWindowsScheduler(manifestPath, options({
    provider: "slack", processRunner: corruptLibraryRunner({ calls }),
  }));
  assert.equal(result.installed, false);
  assert.deepEqual(unfilteredListingCalls(calls), [], "the unfiltered task listing was never queried");
  assert.deepEqual(calls, [["schtasks.exe", ...targetedQuery], ["net", "helpmsg", "2"]],
    "absence came from the named-task query plus the system's own not-found message");
});

await check("W6-R CLI status before install prints not installed despite a corrupt unrelated task", async () => {
  const calls = [];
  const posted = [];
  const run = await captureCli(() => brain.cmdSchedule(cliManifestPath,
    cliOptions("status", corruptLibraryRunner({ calls }), posted)));
  assert.equal(run.error, undefined, String(run.error?.message || ""));
  assert.match(run.text, /slack refresh is not installed on this Windows PC/);
  assert.doesNotMatch(run.text, /corrupt|tampered/);
  assert.deepEqual(unfilteredListingCalls(calls), []);
});

await check("W6-R remove of an already-absent task clears the freshness expectation despite a corrupt unrelated task", async () => {
  const calls = [];
  const posted = [];
  const run = await captureCli(() => brain.cmdSchedule(cliManifestPath,
    cliOptions("remove", corruptLibraryRunner({ calls }), posted)));
  assert.equal(run.error, undefined, String(run.error?.message || ""));
  assert.equal(run.result.removed, false);
  assert.match(run.text, /slack refresh was not installed/);
  assert.match(run.text, /team-chat freshness expectation cleared/);
  assert.deepEqual(posted, [{ source: "team-chat", kind: "slack", expected_refresh_seconds: null }],
    "the remote expectation was cleared exactly once, to null");
  assert.deepEqual(calls, [
    ["schtasks.exe", "/Delete", "/TN", taskName, "/F"],
    ["schtasks.exe", ...targetedQuery],
    ["net", "helpmsg", "2"],
  ], "absence after the failed delete came from the targeted query, never the unfiltered listing");
});

await check("W6-R an ambiguous targeted query failure refuses rather than claiming absence", async () => {
  // The named task answered with a different error than the system's own
  // not-found message: it may exist and be unreadable, so nothing is claimed.
  const deniedCalls = [];
  assert.throws(() => statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner: corruptLibraryRunner({
      calls: deniedCalls, targeted: { status: 1, stdout: "", stderr: "ERROR: Access is denied." },
    }),
  })), /cannot be proven present or absent/);
  assert.deepEqual(deniedCalls, [["schtasks.exe", ...targetedQuery], ["net", "helpmsg", "2"]]);

  // Every call failing alike (the service itself unavailable) is not absence.
  const serviceDown = { status: 1, stdout: "", stderr: "ERROR: The Task Scheduler service is not available." };
  assert.throws(() => statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner: corruptLibraryRunner({ targeted: serviceDown, help: serviceDown }),
  })), /cannot be proven present or absent/);

  // The not-found message could not be read at all.
  assert.throws(() => statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner: corruptLibraryRunner({ help: { error: Object.assign(new Error("spawnSync net.exe ENOENT"), { code: "ENOENT" }) } }),
  })), /cannot be proven present or absent/);

  // A successful targeted query that does not name the task is not absence either.
  assert.throws(() => statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner: corruptLibraryRunner({ targeted: { status: 0, stdout: verboseRow(`${taskName}.old`), stderr: "" } }),
  })), /cannot be proven present or absent/);

  // Remove of a task whose delete and targeted query both fail ambiguously
  // stops before the remote expectation is touched.
  const calls = [];
  const posted = [];
  const run = await captureCli(() => brain.cmdSchedule(cliManifestPath, cliOptions("remove", corruptLibraryRunner({
    calls,
    deleteAnswer: { status: 1, stdout: "", stderr: "ERROR: Access is denied." },
    targeted: { status: 1, stdout: "", stderr: "ERROR: Access is denied." },
  }), posted)));
  assert.match(String(run.error?.message || ""), /could not delete/);
  assert.deepEqual(posted, [], "an unproven removal never clears the freshness expectation");
  assert.deepEqual(unfilteredListingCalls(calls), []);
});

// ---------------------------------------------------------------------------
// W7-R: status reports the last run and where its log is, and the runner's
// own failures reach that log, since a headless console host discards them.
const laneLogPath = `${localAppData}\\FinancialBrain\\logs\\${taskName}.log`;

await check("W7-R status reports the last run time, last result, and the lane log path", async () => {
  const calls = [];
  const result = statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner: corruptLibraryRunner({ calls, task: { xml: providerPlan.taskXml, lastResult: "0" } }),
  }));
  assert.equal(result.installed, true);
  assert.equal(result.definitionDrift, false);
  assert.equal(result.lastRunTime, "9/1/2026 2:15:00 AM");
  assert.equal(result.lastResult, 0);
  assert.equal(result.logPath, laneLogPath);
  assert.deepEqual(calls, [["schtasks.exe", ...targetedQuery], ["schtasks.exe", "/Query", "/TN", taskName, "/XML"]]);

  const posted = [];
  const okRun = await captureCli(() => brain.cmdSchedule(cliManifestPath, cliOptions("status",
    corruptLibraryRunner({ task: { xml: providerPlan.taskXml, lastResult: "0" } }), posted)));
  assert.equal(okRun.error, undefined, String(okRun.error?.message || ""));
  assert.match(okRun.text, /last run: 9\/1\/2026 2:15:00 AM/);
  assert.match(okRun.text, /last result: 0 \(success\)/);
  assert.ok(okRun.text.includes(`log: ${laneLogPath}`), okRun.text);

  const failedRun = await captureCli(() => brain.cmdSchedule(cliManifestPath, cliOptions("status",
    corruptLibraryRunner({ task: { xml: providerPlan.taskXml, lastResult: "1" } }), posted)));
  assert.match(failedRun.text, /last result: 1 \(failed/);
  assert.match(failedRun.text, /warn.*last slack refresh did not succeed/);

  const neverRun = await captureCli(() => brain.cmdSchedule(cliManifestPath, cliOptions("status",
    corruptLibraryRunner({ task: { xml: providerPlan.taskXml, lastRun: "N/A", lastResult: "267011" } }), posted)));
  assert.match(neverRun.text, /last result: 0x00041303 \(has not run yet\)/);
  assert.doesNotMatch(neverRun.text, /did not succeed/);
});

const recordingLog = () => {
  const appended = [];
  return { appended, appendLog(path, text) { appended.push([path, text]); } };
};

await check("W7-R a die() inside the scheduled entrypoint is appended to the lane log", async () => {
  const log = recordingLog();
  await assert.rejects(brain.cmdWindowsScheduledIngest(manifestPath, {
    platform: "win32",
    flags: { from: "slack" },
    schedulerOptions: options({ appendLog: log.appendLog }),
    setExitCode() {},
  }), /config-hash/);
  assert.equal(log.appended.length, 1, JSON.stringify(log.appended));
  assert.equal(log.appended[0][0], laneLogPath);
  assert.match(log.appended[0][1], /^\d{4}-\d{2}-\d{2}T\S+ scheduled ingest failed: .*config-hash/);
});

await check("W7-R a spawn error is appended to the lane log once", async () => {
  const log = recordingLog();
  const spawnError = Object.assign(new Error(`spawnSync ${nodePath} ENOENT`), { code: "ENOENT" });
  await assert.rejects(brain.cmdWindowsScheduledIngest(manifestPath, {
    platform: "win32",
    flags: { from: "slack", "config-hash": providerPlan.configHash },
    schedulerOptions: options({
      brainCliPath,
      fileExists: () => true,
      openLog() { return 42; },
      closeLog() {},
      appendLog: log.appendLog,
      ingestRunner() { return { error: spawnError, status: null }; },
    }),
    setExitCode() {},
  }), /ENOENT/);
  assert.equal(log.appended.length, 1, "the runner and the entrypoint did not both record it");
  assert.equal(log.appended[0][0], laneLogPath);
  assert.match(log.appended[0][1], /scheduled ingest failed: .*ENOENT/);
});

await check("W7-R a runner refusal reaches the lane log once, not again from the entrypoint", async () => {
  const log = recordingLog();
  let children = 0;
  await assert.rejects(brain.cmdWindowsScheduledIngest(manifestPath, {
    platform: "win32",
    flags: { from: "slack", "config-hash": "0".repeat(64) },
    schedulerOptions: options({
      brainCliPath,
      appendLog: log.appendLog,
      openLog() { return 42; },
      closeLog() {},
      ingestRunner() { children++; return { status: 0 }; },
    }),
    setExitCode() {},
  }), (error) => error.code === "WINDOWS_SCHEDULE_CONFIG_CHANGED");
  assert.equal(children, 0);
  assert.equal(log.appended.length, 1, JSON.stringify(log.appended));
  assert.equal(log.appended[0][0], laneLogPath);
  assert.match(log.appended[0][1], /scheduled ingest refused: .*reinstall/);
});

await check("W7-R a log rotation error is appended to the lane log and nothing runs", () => {
  const log = recordingLog();
  let children = 0;
  assert.throws(() => runWindowsScheduledIngest(manifestPath, options({
    provider: "slack",
    brainCliPath,
    fileExists: () => true,
    expectedConfigHash: providerPlan.configHash,
    expectedChildArguments: providerPlan.childArguments,
    openLog() { throw Object.assign(new Error(`EPERM: operation not permitted, rename '${laneLogPath}'`), { code: "EPERM" }); },
    closeLog() {},
    appendLog: log.appendLog,
    ingestRunner() { children++; return { status: 0 }; },
  })), /EPERM/);
  assert.equal(children, 0);
  assert.equal(log.appended.length, 1);
  assert.equal(log.appended[0][0], laneLogPath);
  assert.match(log.appended[0][1], /scheduled ingest failed: .*could not open or rotate the lane log.*EPERM/);
});

await check("W7-R a missing installed brain.mjs is appended to the lane log before any child starts", () => {
  const log = recordingLog();
  const checked = [];
  let children = 0;
  assert.throws(() => runWindowsScheduledIngest(manifestPath, options({
    provider: "slack",
    brainCliPath,
    fileExists(path) { checked.push(path); return false; },
    expectedConfigHash: providerPlan.configHash,
    expectedChildArguments: providerPlan.childArguments,
    openLog() { return 42; },
    closeLog() {},
    appendLog: log.appendLog,
    ingestRunner() { children++; return { status: 0 }; },
  })), (error) => error.code === "WINDOWS_SCHEDULE_RUNNER_MISSING");
  assert.equal(children, 0);
  assert.deepEqual(checked, [brainCliPath]);
  assert.equal(log.appended.length, 1);
  assert.equal(log.appended[0][0], laneLogPath);
  assert.ok(log.appended[0][1].includes(`the installed brain.mjs is missing at ${brainCliPath}`), log.appended[0][1]);
});

await check("W7-R a nonzero ingest exit is recorded in the lane log", () => {
  const log = recordingLog();
  const result = runWindowsScheduledIngest(manifestPath, options({
    provider: "slack",
    brainCliPath,
    fileExists: () => true,
    expectedConfigHash: providerPlan.configHash,
    expectedChildArguments: providerPlan.childArguments,
    openLog() { return 42; },
    closeLog() {},
    appendLog: log.appendLog,
    ingestRunner() { return { status: 3 }; },
  }));
  assert.equal(result.status, 3);
  assert.deepEqual(log.appended.map(([path]) => path), [laneLogPath]);
  assert.match(log.appended[0][1], /scheduled ingest child exited with status 3/);
});

await check("W7-R an unreadable manifest is recorded as metadata only in the runner log", async () => {
  const log = recordingLog();
  await assert.rejects(brain.cmdWindowsScheduledIngest(manifestPath, {
    platform: "win32",
    flags: { from: "slack", "config-hash": providerPlan.configHash },
    schedulerOptions: {
      ...options({ appendLog: log.appendLog }),
      manifest: undefined,
      readFile() { return '{"client": "fixture-private-content"'; },
    },
    setExitCode() {},
  }));
  assert.equal(log.appended.length, 1, JSON.stringify(log.appended));
  assert.equal(log.appended[0][0], `${localAppData}\\FinancialBrain\\logs\\windows-scheduled-ingest.log`);
  assert.match(log.appended[0][1], /scheduled ingest failed: the manifest is not valid JSON/);
  assert.doesNotMatch(log.appended[0][1], /fixture-private-content/);
});

await check("W7-R a tampered action with no valid lane is logged to the runner log, never the Drive lane's", async () => {
  const runnerLog = `${localAppData}\\FinancialBrain\\logs\\windows-scheduled-ingest.log`;
  const driveLog = `${localAppData}\\FinancialBrain\\logs\\com.brain-installer.fixture-brain.drive-ingest.log`;
  for (const flags of [
    { from: "not-a-provider", "config-hash": "a".repeat(64) },
    { "config-hash": "a".repeat(64) },
    { from: "slack", path: String.raw`C:\Source Files`, source: "documents", "config-hash": "a".repeat(64) },
  ]) {
    const log = recordingLog();
    await assert.rejects(brain.cmdWindowsScheduledIngest(manifestPath, {
      platform: "win32", flags, schedulerOptions: options({ appendLog: log.appendLog }), setExitCode() {},
    }));
    const label = JSON.stringify(flags);
    assert.deepEqual(log.appended.map(([path]) => path), [runnerLog], `${label} was recorded in the runner log only`);
    assert.ok(!log.appended.some(([path]) => path === driveLog), `${label} never touched the Drive lane log`);
    assert.match(log.appended[0][1], /scheduled ingest failed: /);
  }
});

rmSync(cliDirectory, { recursive: true, force: true });

assert.deepEqual(schedulerRunnerAttempts, [], "no check reached a real schtasks");

console.log(`windows task definition: ${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.error(`  failed: ${name}`);
  process.exitCode = 1;
}
