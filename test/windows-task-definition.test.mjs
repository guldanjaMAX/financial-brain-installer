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
const statusRunner = (installedXml, { listing = [taskName], calls = [] } = {}) => (command, args) => {
  calls.push(args);
  if (args[0] === "/Query" && args.includes("/XML")) return { status: 0, stdout: installedXml, stderr: "" };
  if (args[0] === "/Query") return { status: 0, stdout: csvListing(listing), stderr: "" };
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
await check("W6 status on a German Windows proves absence from the task listing", () => {
  const calls = [];
  const result = statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner: statusRunner("", { listing: ["Microsoft\\Office\\Andere Aufgabe", `${taskName}.old`], calls }),
  }));
  assert.equal(result.installed, false);
  assert.equal(result.output, "");
  assert.deepEqual(calls, [["/Query", "/FO", "CSV", "/NH"]], "absence came from the listing, not from an error string");
});

await check("W6 status of a present task reads the stored XML, not localized LIST labels", () => {
  const calls = [];
  const result = statusWindowsScheduler(manifestPath, options({
    provider: "slack", processRunner: statusRunner(providerPlan.taskXml, { calls }),
  }));
  assert.equal(result.installed, true);
  assert.equal(result.definitionDrift, false);
  assert.deepEqual(calls, [["/Query", "/FO", "CSV", "/NH"], ["/Query", "/TN", taskName, "/XML"]]);
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

await check("W6 a failed task listing is an error, never a quiet absence", () => {
  assert.throws(() => statusWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner() { return { status: 1, stdout: "", stderr: "FEHLER: Zugriff verweigert" }; },
  })), /could not list/);
});

await check("W6 remove of an already-deleted task on a French Windows is a quiet success", () => {
  const calls = [];
  const result = removeWindowsScheduler(manifestPath, options({
    provider: "slack",
    processRunner(command, args) {
      calls.push(args);
      if (args[0] === "/Delete") return { status: 1, stdout: "", stderr: "ERREUR : Le fichier spécifié est introuvable." };
      return { status: 0, stdout: csvListing(["Autre tâche"], "Prêt"), stderr: "" };
    },
  }));
  assert.equal(result.removed, false);
  assert.equal(result.installed, false);
  assert.deepEqual(calls, [["/Delete", "/TN", taskName, "/F"], ["/Query", "/FO", "CSV", "/NH"]]);
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

assert.deepEqual(schedulerRunnerAttempts, [], "no check reached a real schtasks");

console.log(`windows task definition: ${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.error(`  failed: ${name}`);
  process.exitCode = 1;
}
