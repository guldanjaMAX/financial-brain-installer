import { schedulerRunnerAttempts } from "./helpers/scheduler-runner-guard.mjs";
import assert from "node:assert/strict";
import * as brain from "../brain.mjs";
import {
  buildWindowsSchedulerPlan,
  cronToSchtasks,
  installWindowsScheduler,
  removeWindowsScheduler,
  runWindowsScheduledIngest,
  statusWindowsScheduler,
} from "../operations/windows-task-scheduler.mjs";

const localAppData = String.raw`C:\Users\Fixture User\AppData\Local`;
const manifestPath = String.raw`C:\Users\Fixture User\Financial Brain\brain.manifest.json`;
const brainPath = String.raw`C:\Users\Fixture User\AppData\Local\FinancialBrain\brain.cmd`;
const brainCliPath = String.raw`C:\Users\Fixture User\AppData\Local\FinancialBrain\node_modules\brain-installer\brain.mjs`;
const nodePath = String.raw`C:\Program Files\nodejs\node.exe`;
const systemRoot = String.raw`C:\Windows`;
const definitionDirectory = String.raw`C:\Users\Fixture User\AppData\Local\FinancialBrain\schedules`;

const baseManifest = {
  manifest_version: 1,
  client: { slug: "fixture-brain", display_name: "Fixture" },
  brain: { version: "0.4.8", domain: "fixture.invalid" },
  corpora: {
    google_drive: { enabled: true },
    local_folder: { enabled: true, path: String.raw`C:\Source Files`, source: "documents" },
    slack: { enabled: true, source: "team-chat" },
  },
  operations: {
    ingest_cron: "15 * * * *",
    folder_ingest_cron: "30 6 * * 1-5",
    provider_crons: { slack: "45 */2 * * *" },
    provider_token_stores: { slack: "file" },
  },
};

const options = (extra = {}) => ({
  manifest: baseManifest,
  windowsManifestPath: manifestPath,
  localAppData,
  systemRoot,
  nodePath,
  writeTaskDefinition() {},
  ...extra,
});

const argumentsOf = (plan) => /<Arguments>([^<]*)<\/Arguments>/.exec(plan.taskXml)?.[1]
  .replaceAll("&quot;", '"').replaceAll("&amp;", "&");

assert.deepEqual(cronToSchtasks("15 * * * *"),
  ["/SC", "HOURLY", "/MO", "1", "/ST", "00:15"]);
assert.deepEqual(cronToSchtasks("45 */2 * * *"),
  ["/SC", "HOURLY", "/MO", "2", "/ST", "00:45"]);
assert.deepEqual(cronToSchtasks("5 9 * * *"),
  ["/SC", "DAILY", "/ST", "09:05"]);
assert.deepEqual(cronToSchtasks("30 6 * * 1-5"),
  ["/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", "06:30"]);

const providerPlan = buildWindowsSchedulerPlan(manifestPath, options({ provider: "slack" }));
assert.equal(providerPlan.taskName, "com.brain-installer.fixture-brain.slack-ingest");
assert.equal(providerPlan.brainPath, brainPath);
// The trigger, principal and settings live in the XML definition, which
// test/windows-task-definition.test.mjs pins element by element.
assert.deepEqual(providerPlan.createArgs, [
  "/Create", "/F",
  "/TN", "com.brain-installer.fixture-brain.slack-ingest",
  "/XML", `${definitionDirectory}\\com.brain-installer.fixture-brain.slack-ingest.xml`,
]);
assert.equal(argumentsOf(providerPlan),
  String.raw`--headless "C:\Program Files\nodejs\node.exe" "C:\Users\Fixture User\AppData\Local\FinancialBrain\node_modules\brain-installer\brain.mjs" windows-scheduled-ingest "C:\Users\Fixture User\Financial Brain\brain.manifest.json" --from slack --config-hash ` +
    providerPlan.configHash);

// The CLI passes no environment into the plan. The installed prefix must then
// come from the process environment, or every real install refuses.
const priorLocalAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = localAppData;
try {
  const ambientPlan = buildWindowsSchedulerPlan(manifestPath, {
    manifest: baseManifest, windowsManifestPath: manifestPath, provider: "slack", systemRoot, nodePath,
  });
  assert.equal(ambientPlan.brainPath, brainPath,
    "install without an injected LOCALAPPDATA reads the process environment");
} finally {
  if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = priorLocalAppData;
}

const drivePlan = buildWindowsSchedulerPlan(manifestPath, options());
assert.equal(drivePlan.taskName, "com.brain-installer.fixture-brain.drive-ingest");
assert.deepEqual(drivePlan.childArguments, ["ingest", manifestPath, "--from", "drive"]);

const folderPlan = buildWindowsSchedulerPlan(manifestPath, options({ folder: true, validateExtras: false }));
assert.deepEqual(folderPlan.createArgs, [
  "/Create", "/F",
  "/TN", "com.brain-installer.fixture-brain.folder-ingest",
  "/XML", `${definitionDirectory}\\com.brain-installer.fixture-brain.folder-ingest.xml`,
]);
assert.equal(argumentsOf(folderPlan),
  String.raw`--headless "C:\Program Files\nodejs\node.exe" "C:\Users\Fixture User\AppData\Local\FinancialBrain\node_modules\brain-installer\brain.mjs" windows-scheduled-ingest "C:\Users\Fixture User\Financial Brain\brain.manifest.json" --path "C:\Source Files" --source documents --config-hash ` +
    folderPlan.configHash);

const unsafeCmdCharacters = ["&", "|", "<", ">", "^", "%", "!", "\""];
const rejectedPathScenarios = unsafeCmdCharacters.flatMap((character) => [
  {
    name: `install prefix carrying ${JSON.stringify(character)}`,
    extra: { provider: "slack", localAppData: `C:\\Unsafe${character}Root` },
  },
  {
    name: `manifest path carrying ${JSON.stringify(character)}`,
    extra: { provider: "slack", windowsManifestPath: `C:\\Unsafe${character}Manifest\\brain.manifest.json` },
  },
  {
    name: `watched-folder path carrying ${JSON.stringify(character)}`,
    extra: {
      folder: true,
      validateExtras: false,
      manifest: {
        ...baseManifest,
        corpora: {
          ...baseManifest.corpora,
          local_folder: {
            ...baseManifest.corpora.local_folder,
            path: `C:\\Unsafe${character}Folder`,
          },
        },
      },
    },
  },
]);
for (const scenario of rejectedPathScenarios) {
  let rejectedPathCalls = 0;
  assert.throws(() => installWindowsScheduler(manifestPath, options({
    ...scenario.extra,
    processRunner() { rejectedPathCalls++; return { status: 0 }; },
  })), (error) => {
    assert.equal(error.code, "WINDOWS_SCHEDULE_PATH_REFUSED",
      `${scenario.name} reached the Windows batch-path refusal`);
    return true;
  });
  assert.equal(rejectedPathCalls, 0, `${scenario.name} refusal happened before schtasks`);
}

const scheduledChildCalls = [];
const scheduledChild = runWindowsScheduledIngest(manifestPath, options({
  provider: "slack",
  brainCliPath,
  expectedConfigHash: providerPlan.configHash,
  openLog() { return 7; },
  appendLog() {},
  closeLog() {},
  environment: {
    ADMIN_KEY: "must-not-pass",
    CLOUDFLARE_API_TOKEN: "must-not-pass",
    CLOUDFLARE_OAUTH_TOKEN: "must-not-pass",
    CLOUDFLARE_ACCOUNT_ID: "must-not-pass",
    LOCALAPPDATA: localAppData,
    SystemRoot: String.raw`C:\Windows`,
    PATH: String.raw`C:\Windows\System32`,
    BRAIN_SLACK_TOKEN_STORE: "file",
  },
  ingestRunner(command, args, runOptions) {
    scheduledChildCalls.push({ command, args, runOptions });
    return { status: 0 };
  },
}));
assert.equal(scheduledChild.status, 0);
assert.equal(scheduledChildCalls.length, 1, "the scheduled entrypoint reached the ingest child");
assert.deepEqual(scheduledChildCalls[0].args.slice(1), providerPlan.childArguments);
assert.equal(scheduledChildCalls[0].runOptions.shell, false);
assert.equal(scheduledChildCalls[0].runOptions.env.BRAIN_SLACK_TOKEN_STORE, "file");
assert.equal(scheduledChildCalls[0].runOptions.env.LOCALAPPDATA, localAppData);
assert.equal("ADMIN_KEY" in scheduledChildCalls[0].runOptions.env, false);
assert.equal("CLOUDFLARE_API_TOKEN" in scheduledChildCalls[0].runOptions.env, false);
assert.equal("CLOUDFLARE_OAUTH_TOKEN" in scheduledChildCalls[0].runOptions.env, false);
assert.equal("CLOUDFLARE_ACCOUNT_ID" in scheduledChildCalls[0].runOptions.env, false);

assert.equal(typeof brain.cmdWindowsScheduledIngest, "function",
  "the /TR action reaches a dedicated brain.cmd entrypoint before ingest");
const entrypointCalls = [];
const entrypointExitCodes = [];
await brain.cmdWindowsScheduledIngest(manifestPath, {
  platform: "win32",
  flags: { from: "slack", "config-hash": providerPlan.configHash },
  scheduler: {
    runWindowsScheduledIngest(path, runOptions) {
      entrypointCalls.push({ path, runOptions });
      return { status: 0 };
    },
  },
  setExitCode(code) { entrypointExitCodes.push(code); },
});
assert.equal(entrypointCalls.length, 1, "the dedicated entrypoint reached its scrubbed runner");
assert.equal(entrypointCalls[0].runOptions.provider, "slack");
assert.deepEqual(entrypointCalls[0].runOptions.expectedChildArguments,
  ["ingest", manifestPath, "--from", "slack"]);
assert.deepEqual(entrypointExitCodes, [0]);
let wranglerBoundaryCalls = 0;
await brain.runCliCommandWithCredentialBoundary("windows-scheduled-ingest", () => "ran", {
  withWranglerSession() { wranglerBoundaryCalls++; throw new Error("must not load Wrangler credentials"); },
});
assert.equal(wranglerBoundaryCalls, 0,
  "the scheduled entrypoint does not cross the ambient Wrangler credential boundary");

const calls = [];
const processRunner = (command, args, runOptions) => {
  calls.push({ command, args, runOptions });
  return { status: 0, stdout: "SUCCESS", stderr: "" };
};
const installedOnce = installWindowsScheduler(manifestPath, options({
  provider: "slack", processRunner, environment: { LOCALAPPDATA: localAppData, PRIVATE_VALUE: "must-not-pass" },
}));
const installedTwice = installWindowsScheduler(manifestPath, options({
  provider: "slack", processRunner,
}));
assert.equal(installedOnce.installed, true);
assert.equal(installedTwice.installed, true);
assert.equal(calls.length, 2, "both idempotent installs reached the decision point");
assert.deepEqual(calls[0].args, providerPlan.createArgs);
assert.equal(calls[0].runOptions.shell, false,
  "schtasks receives the pinned /TR bytes through argv with no shell escape layer");
assert.equal(calls[0].runOptions.env.LOCALAPPDATA, localAppData);
assert.equal("PRIVATE_VALUE" in calls[0].runOptions.env, false,
  "schtasks receives an allowlisted environment rather than the desktop environment");
assert.deepEqual(calls[1].args, providerPlan.createArgs,
  "/Create /F makes a reinstall replace the same stable task");

const listing = (...names) => names.map((name) => `"\\${name}","N/A","Ready"`).join("\r\n");
const statusCalls = [];
const present = statusWindowsScheduler(manifestPath, options({
  provider: "slack",
  processRunner(command, args) {
    statusCalls.push([command, args]);
    return args.includes("/XML")
      ? { status: 0, stdout: providerPlan.taskXml, stderr: "" }
      : { status: 0, stdout: listing("com.brain-installer.fixture-brain.slack-ingest"), stderr: "" };
  },
}));
assert.equal(present.installed, true);
assert.equal(present.definitionDrift, false);
assert.deepEqual(statusCalls, [
  ["schtasks.exe", ["/Query", "/FO", "CSV", "/NH"]],
  ["schtasks.exe", ["/Query", "/TN", "com.brain-installer.fixture-brain.slack-ingest", "/XML"]],
]);

let absentStatusCalls = 0;
const missingStatus = statusWindowsScheduler(manifestPath, options({
  provider: "slack",
  processRunner() {
    absentStatusCalls++;
    return { status: 0, stdout: listing("Microsoft\\Windows\\Other"), stderr: "" };
  },
}));
assert.equal(absentStatusCalls, 1, "the absent status reached the schtasks /Query listing");
assert.equal(missingStatus.installed, false);
assert.equal(missingStatus.output, "",
  "an absent task is reported as absent, not by echoing schtasks' raw error line");

const deleteCalls = [];
const removed = removeWindowsScheduler(manifestPath, options({
  folder: true,
  validateExtras: false,
  processRunner(command, args) {
    deleteCalls.push([command, args]);
    return { status: 0, stdout: "SUCCESS", stderr: "" };
  },
}));
assert.equal(removed.removed, true);
assert.deepEqual(deleteCalls, [["schtasks.exe", [
  "/Delete", "/TN", "com.brain-installer.fixture-brain.folder-ingest", "/F",
]]]);

let absentDeleteCalls = 0;
const absent = removeWindowsScheduler(manifestPath, options({
  provider: "slack",
  processRunner(command, args) {
    absentDeleteCalls++;
    return args[0] === "/Delete"
      ? { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
      : { status: 0, stdout: listing(), stderr: "" };
  },
}));
assert.equal(absentDeleteCalls, 2,
  "the absent-task success reached schtasks /Delete and then the listing that proves absence");
assert.equal(absent.removed, false);

let driftedRemoveCalls = 0;
const driftedRemove = removeWindowsScheduler(manifestPath, options({
  manifest: {
    ...baseManifest,
    corpora: { ...baseManifest.corpora, local_folder: { enabled: false, path: String.raw`C:\Gone` } },
    operations: { ...baseManifest.operations, folder_ingest_cron: null },
  },
  folder: true,
  processRunner(command, args) {
    driftedRemoveCalls++;
    return args[0] === "/Delete"
      ? { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
      : { status: 0, stdout: listing(), stderr: "" };
  },
}));
assert.equal(driftedRemoveCalls, 2,
  "remove still reaches schtasks after the lane is disabled, the folder disappears, and the cron is cleared");
assert.equal(driftedRemove.removed, false);

let failedCreateCalls = 0;
assert.throws(() => installWindowsScheduler(manifestPath, options({
  provider: "slack",
  processRunner() {
    failedCreateCalls++;
    return { status: 1, stdout: "", stderr: "ERROR: Access is denied." };
  },
})), (error) => {
  assert.equal(error.code, "WINDOWS_SCHEDULE_CREATE_FAILED");
  assert.match(error.message, /nothing was scheduled/);
  assert.match(error.message, /Access is denied/);
  assert.ok(error.message.includes(brainPath));
  assert.ok(error.message.includes(manifestPath));
  assert.doesNotMatch(error.message, /<path to brain\.cmd>|<manifest>/);
  return true;
});
assert.equal(failedCreateCalls, 1, "the fallback follows a real failed create attempt");

let unsupportedCalls = 0;
assert.throws(() => installWindowsScheduler(manifestPath, options({
  manifest: {
    ...baseManifest,
    operations: { ...baseManifest.operations, provider_crons: { slack: "0 */5 * * *" } },
  },
  provider: "slack",
  processRunner() { unsupportedCalls++; return { status: 0 }; },
})), (error) => {
  assert.equal(error.code, "WINDOWS_SCHEDULE_UNREPRESENTABLE");
  assert.match(error.message, /cron "0 \*\/5 \* \* \*"/);
  assert.match(error.message, /nothing was scheduled/);
  assert.ok(error.message.includes(brainPath));
  assert.ok(error.message.includes(manifestPath));
  assert.doesNotMatch(error.message, /schtasks(?:\.exe)?\b[^\n]*\/Create/i,
    "an unsupported cadence must not print a runnable task with a different trigger");
  assert.match(error.message, /Run once:/);
  assert.match(error.message, /manual trigger setup/i);
  return true;
});
assert.equal(unsupportedCalls, 0, "an inexact cadence refuses before schtasks is called");

assert.deepEqual(schedulerRunnerAttempts, [], "no check reached a real launchctl or schtasks");

console.log("windows task scheduler: exact cadence, argv, identity, symmetry, idempotency, and fallback verified");
