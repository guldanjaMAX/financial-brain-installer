import assert from "node:assert/strict";
import {
  buildWindowsSchedulerPlan,
  cronToSchtasks,
  installWindowsScheduler,
  removeWindowsScheduler,
  statusWindowsScheduler,
} from "../operations/windows-task-scheduler.mjs";

const localAppData = String.raw`C:\Users\Fixture User\AppData\Local`;
const manifestPath = String.raw`C:\Users\Fixture User\Financial Brain\brain.manifest.json`;
const brainPath = String.raw`C:\Users\Fixture User\AppData\Local\FinancialBrain\brain.cmd`;

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
  ...extra,
});

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
assert.deepEqual(providerPlan.createArgs, [
  "/Create", "/F", "/SC", "HOURLY", "/MO", "2", "/ST", "00:45",
  "/RL", "LIMITED",
  "/TN", "com.brain-installer.fixture-brain.slack-ingest",
  "/TR", String.raw`cmd /c \"\"C:\Users\Fixture User\AppData\Local\FinancialBrain\brain.cmd\" ingest \"C:\Users\Fixture User\Financial Brain\brain.manifest.json\" --from slack\"`,
]);

const drivePlan = buildWindowsSchedulerPlan(manifestPath, options());
assert.equal(drivePlan.taskName, "com.brain-installer.fixture-brain.drive-ingest");
assert.deepEqual(drivePlan.childArguments, ["ingest", manifestPath, "--from", "drive"]);

const folderPlan = buildWindowsSchedulerPlan(manifestPath, options({ folder: true, validateExtras: false }));
assert.deepEqual(folderPlan.createArgs, [
  "/Create", "/F", "/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", "06:30",
  "/RL", "LIMITED",
  "/TN", "com.brain-installer.fixture-brain.folder-ingest",
  "/TR", String.raw`cmd /c \"\"C:\Users\Fixture User\AppData\Local\FinancialBrain\brain.cmd\" ingest \"C:\Users\Fixture User\Financial Brain\brain.manifest.json\" --path \"C:\Source Files\" --source documents\"`,
]);

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
assert.equal(calls[0].runOptions.env.LOCALAPPDATA, localAppData);
assert.equal("PRIVATE_VALUE" in calls[0].runOptions.env, false,
  "schtasks receives an allowlisted environment rather than the desktop environment");
assert.deepEqual(calls[1].args, providerPlan.createArgs,
  "/Create /F makes a reinstall replace the same stable task");

const statusCalls = [];
const present = statusWindowsScheduler(manifestPath, options({
  provider: "slack",
  processRunner(command, args) {
    statusCalls.push([command, args]);
    return { status: 0, stdout: "TaskName: fixture", stderr: "" };
  },
}));
assert.equal(present.installed, true);
assert.deepEqual(statusCalls, [["schtasks.exe", [
  "/Query", "/TN", "com.brain-installer.fixture-brain.slack-ingest", "/FO", "LIST", "/V",
]]]);

let absentStatusCalls = 0;
const missingStatus = statusWindowsScheduler(manifestPath, options({
  provider: "slack",
  processRunner() {
    absentStatusCalls++;
    return { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
  },
}));
assert.equal(absentStatusCalls, 1, "the absent status reached schtasks /Query");
assert.equal(missingStatus.installed, false);

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
  processRunner() {
    absentDeleteCalls++;
    return { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
  },
}));
assert.equal(absentDeleteCalls, 1, "the absent-task success reached schtasks /Delete");
assert.equal(absent.removed, false);

let driftedRemoveCalls = 0;
const driftedRemove = removeWindowsScheduler(manifestPath, options({
  manifest: {
    ...baseManifest,
    corpora: { ...baseManifest.corpora, local_folder: { enabled: false, path: String.raw`C:\Gone` } },
    operations: { ...baseManifest.operations, folder_ingest_cron: null },
  },
  folder: true,
  processRunner() {
    driftedRemoveCalls++;
    return { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
  },
}));
assert.equal(driftedRemoveCalls, 1,
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
  return true;
});
assert.equal(unsupportedCalls, 0, "an inexact cadence refuses before schtasks is called");

console.log("windows task scheduler: exact cadence, argv, identity, symmetry, idempotency, and fallback verified");
