import { schedulerRunnerAttempts } from "./helpers/scheduler-runner-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildProviderSchedulerPlan,
  createProviderSchedulerSpec,
  recordProviderSchedulerFailure,
} from "../operations/provider-scheduler.mjs";
import { safeIngestEnvironment } from "../operations/drive-scheduler.mjs";
import { cmdSchedule, VALUE_FLAGS } from "../brain.mjs";
import { previewSupportJournal } from "../support-journal.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const folder = mkdtempSync(join(tmpdir(), "brain-provider-scheduler-"));
try {
  const manifestPath = join(folder, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture-client", display_name: "Fixture" },
    brain: { version: "0.2.0", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    corpora: { slack: { enabled: true, source: "client-chat", channel_ids: ["C1"] } },
    operations: {
      provider_crons: { slack: "15 */2 * * *" },
      provider_token_stores: { slack: "file" },
    },
  }));
  const plan = buildProviderSchedulerPlan("slack", manifestPath, {
    platform: "darwin",
    uid: 501,
    home: folder,
    nodePath: "/usr/bin/node",
    brainPath: "/opt/brain/brain.mjs",
  });
  check("provider scheduler uses a provider-specific identity and cron",
    plan.label.endsWith(".slack-ingest") && plan.cron === "15 */2 * * *");
  check("installed scheduler argv retains the provider across a later run",
    plan.programArguments.slice(0, 4).join("|").includes("provider-scheduler.mjs|slack|run"));
  check("scheduled child invokes the ordinary provider ingest command",
    plan.spec.childArgumentsOf(plan).join(" ") === `ingest ${plan.path} --from slack`);
  const env = plan.spec.childEnvironmentOf(plan, {
    HOME: folder,
    BRAIN_SLACK_TOKEN_STORE: "keychain",
    SLACK_CLIENT_SECRET: "must-not-pass",
    CLOUDFLARE_API_TOKEN: "must-not-pass",
  });
  check("scheduled child carries only the token-store selector, never provider or Cloudflare secrets",
    env.BRAIN_SLACK_TOKEN_STORE === "file" && !("SLACK_CLIENT_SECRET" in env) && !("CLOUDFLARE_API_TOKEN" in env));

  const scheduleCalls = [];
  const expectationCalls = [];
  const schedulerOptions = { home: folder, uid: 501 };
  const installResult = await cmdSchedule(manifestPath, {
    platform: "darwin",
    flags: { provider: "slack", install: true },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async (...args) => { expectationCalls.push(args); },
    schedulerOptions,
    providerScheduler: {
      installProviderScheduler: (...args) => {
        scheduleCalls.push(["install", ...args]);
        return {
          cron: "15 */2 * * *", expectedRefreshSeconds: 7_200,
          plistPath: "/fixture/provider.plist", stdoutPath: "/fixture/out", stderrPath: "/fixture/err",
          warnings: [],
        };
      },
      statusProviderScheduler: () => { throw new Error("Drive/status fallback must not run"); },
      removeProviderScheduler: () => { throw new Error("Drive/remove fallback must not run"); },
    },
  });
  check("brain schedule dispatches --provider install to the requested provider scheduler",
    installResult.cron === "15 */2 * * *" &&
      scheduleCalls.length === 1 && scheduleCalls[0][0] === "install" &&
      scheduleCalls[0][1] === "slack" && scheduleCalls[0][2] === manifestPath &&
      scheduleCalls[0][3] === schedulerOptions,
    JSON.stringify(scheduleCalls));
  check("provider install records freshness for the manifest's provider source",
    expectationCalls.length === 1 &&
      expectationCalls[0][0] === "https://fixture.invalid" &&
      expectationCalls[0][1] === "fixture-admin-key" &&
      JSON.stringify(expectationCalls[0][2]) === JSON.stringify({
        source: "client-chat", kind: "slack", expected_refresh_seconds: 7_200,
      }),
    JSON.stringify(expectationCalls));
  check("--provider is a required-value flag, so a bare spelling cannot select a scheduler accidentally",
    VALUE_FLAGS.has("provider"));

  let invalidProviderCalls = 0;
  await assert.rejects(
    cmdSchedule(manifestPath, {
      platform: "darwin",
      flags: { provider: "slakc", install: true },
      resolveAdminKey: () => { invalidProviderCalls++; return "must-not-be-read"; },
      providerScheduler: {
        installProviderScheduler: () => { invalidProviderCalls++; },
      },
    }),
    /--provider must be one of/,
  );
  check("an unknown provider refuses before credentials or scheduler mutation",
    invalidProviderCalls === 0);

  let conflictingLaneCalls = 0;
  await assert.rejects(
    cmdSchedule(manifestPath, {
      platform: "darwin",
      flags: { provider: "slack", folder: true, install: true },
      resolveAdminKey: () => { conflictingLaneCalls++; return "must-not-be-read"; },
      providerScheduler: {
        installProviderScheduler: () => { conflictingLaneCalls++; },
      },
    }),
    /choose only one scheduler lane/,
  );
  check("provider and folder lanes cannot be installed by one ambiguous command",
    conflictingLaneCalls === 0);

  const brainCli = fileURLToPath(new URL("../brain.mjs", import.meta.url));
  const guardUrl = pathToFileURL(fileURLToPath(new URL("./helpers/scheduler-runner-guard.mjs", import.meta.url))).href;
  const publicCliEnvironment = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) publicCliEnvironment[key] = process.env[key];
  }
  publicCliEnvironment.HOME = folder;
  publicCliEnvironment.USERPROFILE = folder;
  publicCliEnvironment.LOCALAPPDATA = join(folder, "AppData", "Local");
  publicCliEnvironment.BRAIN_NO_WRANGLER_LOGIN = "1";
  // The spawned CLI runs on this host's real platform so its dispatch is the
  // one an owner gets, but its launchctl/schtasks answer is scripted as "no
  // such task" by the preloaded guard. It never reads this machine's scheduler.
  const publicStatus = spawnSync(
    process.execPath,
    ["--import", guardUrl, brainCli, "schedule", manifestPath, "--provider", "slack", "--status"],
    { encoding: "utf8", env: publicCliEnvironment, timeout: 30_000 },
  );
  const publicStatusOutput = `${publicStatus.stdout || ""}${publicStatus.stderr || ""}`;
  const publicExpectation = {
    darwin: () => publicStatus.status === 0 && /slack refresh is not installed on this Mac/.test(publicStatusOutput),
    win32: () => publicStatus.status === 0 &&
      /slack refresh is not installed on this Windows PC/.test(publicStatusOutput) &&
      /com\.brain-installer\.fixture-client\.slack-ingest/.test(publicStatusOutput),
  }[process.platform] ?? (() => publicStatus.status === 1 && /not scheduled by the installer/.test(publicStatusOutput));
  check("the public schedule CLI preserves its provider selection",
    /slack refresh/i.test(publicStatusOutput) && !/Drive refresh/.test(publicStatusOutput) &&
      !/client-chat refresh/.test(publicStatusOutput) &&
      !/ERROR:|cannot find the file/i.test(publicStatusOutput) &&
      publicExpectation(),
    publicStatusOutput);

  // Every platform branch is proven here regardless of the host, with the
  // platform and the scheduler process runner injected.
  const captureConsole = async (run) => {
    const lines = [];
    const original = console.log;
    console.log = (...parts) => { lines.push(parts.join(" ")); };
    try {
      const result = await run();
      return { result, text: lines.join("\n") };
    } finally {
      console.log = original;
    }
  };
  const windowsCalls = [];
  const windowsRunner = (answers) => (command, args) => {
    windowsCalls.push([command, args[0], args[2]]);
    return answers(args[0]);
  };
  const windowsAbsent = windowsRunner(() => ({
    status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified.",
  }));
  const windowsOptions = (action, runner, extra = {}) => ({
    platform: "win32",
    flags: { provider: "slack", [action]: true },
    resolveAdminKey: () => "fixture-admin-secret-value",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
    schedulerOptions: {
      processRunner: runner,
      environment: {},
      localAppData: String.raw`C:\Users\Fixture\AppData\Local`,
      windowsManifestPath: String.raw`C:\Users\Fixture\brain.manifest.json`,
      ...extra,
    },
  });
  const windowsStatus = await captureConsole(() => cmdSchedule(manifestPath, windowsOptions("status", windowsAbsent)));
  check("Windows status of an absent task names the provider lane and hides schtasks' raw error line",
    windowsStatus.result.installed === false &&
      /slack refresh is not installed on this Windows PC/.test(windowsStatus.text) &&
      /com\.brain-installer\.fixture-client\.slack-ingest/.test(windowsStatus.text) &&
      !/ERROR:|cannot find the file|client-chat refresh/.test(windowsStatus.text),
    windowsStatus.text);
  const windowsRemove = await captureConsole(() => cmdSchedule(manifestPath, windowsOptions("remove", windowsAbsent)));
  check("Windows remove of an absent task is a quiet success that names the same lane",
    windowsRemove.result.removed === false &&
      /slack refresh was not installed/.test(windowsRemove.text) &&
      !/ERROR:|cannot find the file/.test(windowsRemove.text),
    windowsRemove.text);
  const windowsInstall = await captureConsole(() => cmdSchedule(manifestPath, windowsOptions("install",
    windowsRunner(() => ({ status: 0, stdout: "SUCCESS", stderr: "" })))));
  check("Windows install names the same provider lane as status and remove",
    windowsInstall.result.installed === true &&
      /slack refresh installed for 15 \*\/2 \* \* \*/.test(windowsInstall.text) &&
      /client-chat freshness expectation set to 7200 seconds/.test(windowsInstall.text),
    windowsInstall.text);
  const installedCommand = windowsInstall.result.runCommand;
  const windowsPresent = await captureConsole(() => cmdSchedule(manifestPath, windowsOptions("status",
    windowsRunner(() => ({ status: 0, stdout: `TaskName: fixture\nTask To Run: ${installedCommand}\n`, stderr: "" })))));
  check("Windows status of the task install wrote reports it installed without drift",
    windowsPresent.result.installed === true && windowsPresent.result.definitionDrift === false &&
      /slack refresh is installed for 15 \*\/2 \* \* \*/.test(windowsPresent.text),
    windowsPresent.text);
  const windowsDrifted = await captureConsole(() => cmdSchedule(manifestPath, windowsOptions("status",
    windowsRunner(() => ({ status: 0, stdout: "TaskName: fixture\nTask To Run: cmd.exe /d /s /c \"older\"\n", stderr: "" })))));
  check("Windows status reports a stored action that no longer matches install as drift",
    windowsDrifted.result.definitionDrift === true &&
      /the installed slack refresh does not match the current manifest; reinstall it/.test(windowsDrifted.text),
    windowsDrifted.text);
  check("Windows install, status and remove all address one task name",
    windowsCalls.length === 5 &&
      windowsCalls.every(([command, verb, name]) => command === "schtasks.exe" &&
        (verb === "/Create" || name === "com.brain-installer.fixture-client.slack-ingest")) &&
      windowsInstall.result.createArgs.includes("com.brain-installer.fixture-client.slack-ingest"),
    JSON.stringify(windowsCalls));

  const darwinLaunchctl = [];
  const darwinStatus = await captureConsole(() => cmdSchedule(manifestPath, {
    platform: "darwin",
    flags: { provider: "slack", status: true },
    schedulerOptions: {
      platform: "darwin", uid: 501, home: folder,
      nodePath: "/usr/bin/node", brainPath: "/opt/brain/brain.mjs",
      launchctl: (args) => { darwinLaunchctl.push(args); return { status: 113, stdout: "", stderr: "not found" }; },
    },
  }));
  check("macOS status with an injected launchctl names the same provider lane",
    darwinStatus.result.installed === false && darwinLaunchctl.length === 1 &&
      /slack refresh is not installed on this Mac/.test(darwinStatus.text),
    darwinStatus.text);

  await assert.rejects(
    cmdSchedule(manifestPath, { platform: "linux", flags: { provider: "slack", status: true } }),
    /slack refresh is not scheduled by the installer on linux/,
  );
  check("an injected unsupported platform refuses with the provider-specific recipe", true);

  check("no scheduler test reached a real launchctl or schtasks",
    schedulerRunnerAttempts.length === 0, JSON.stringify(schedulerRunnerAttempts));

  const changed = JSON.parse(readFileSync(manifestPath, "utf8"));
  changed.corpora.slack.channel_ids.push("C2");
  writeFileSync(manifestPath, JSON.stringify(changed));
  const changedPlan = buildProviderSchedulerPlan("slack", manifestPath, {
    platform: "darwin", uid: 501, home: folder,
    nodePath: "/usr/bin/node", brainPath: "/opt/brain/brain.mjs",
  });
  check("provider selection changes are covered by the installed config hash",
    changedPlan.configHash !== plan.configHash);

  const supportRoot = join(folder, "scheduler-support");
  mkdirSync(supportRoot);
  const scheduledFailure = recordProviderSchedulerFailure(
    "slack",
    "run",
    new Error("RAW_SCHEDULED_PROVIDER_DETAIL"),
    { journalOptions: { root: supportRoot } },
  );
  const scheduledEvents = previewSupportJournal({ root: supportRoot });
  check("a scheduled provider failure creates one connector-specific issue note",
    scheduledFailure.errorCode === "SCHEDULE_RUN_FAILED" &&
      scheduledEvents.trim().split("\n").filter(Boolean).length === 1 &&
      scheduledEvents.includes('"source":"slack"') &&
      scheduledEvents.includes('"error_code":"SCHEDULE_RUN_FAILED"') &&
      !scheduledEvents.includes("RAW_SCHEDULED_PROVIDER_DETAIL"), scheduledEvents);

  const uncertainRoot = join(folder, "uncertain-scheduler-support");
  mkdirSync(uncertainRoot);
  const uncertainFailure = Object.assign(new Error("RAW_UNCERTAIN_PROVIDER_DETAIL"), {
    retry_safe: false,
    outcome_unknown: true,
  });
  const uncertainReceipt = recordProviderSchedulerFailure(
    "quickbooks",
    "run",
    uncertainFailure,
    { journalOptions: { root: uncertainRoot } },
  );
  const uncertainEvents = previewSupportJournal({ root: uncertainRoot });
  check("a no-retry scheduled provider boundary stays paused for safety review",
    uncertainReceipt.errorCode === "SAFETY_REVIEW_REQUIRED" &&
      uncertainEvents.includes('"source":"quickbooks"') &&
      uncertainEvents.includes('"error_code":"SAFETY_REVIEW_REQUIRED"') &&
      !uncertainEvents.includes("RAW_UNCERTAIN_PROVIDER_DETAIL"), uncertainEvents);

  const cliRoot = join(folder, "scheduler-cli-support");
  mkdirSync(cliRoot);
  const cliEnvironment = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) cliEnvironment[key] = process.env[key];
  }
  cliEnvironment.HOME = cliRoot;
  cliEnvironment.USERPROFILE = cliRoot;
  const missingManifest = join(folder, "RAW_SCHEDULE_MANIFEST_SENTINEL.json");
  const schedulerCli = fileURLToPath(new URL("../operations/provider-scheduler.mjs", import.meta.url));
  const cliFailure = spawnSync(process.execPath, [schedulerCli, "slack", "install", missingManifest], {
    encoding: "utf8",
    env: cliEnvironment,
    timeout: 30_000,
  });
  const cliOutput = `${cliFailure.stdout || ""}${cliFailure.stderr || ""}`;
  const cliEvents = previewSupportJournal({ root: cliRoot });
  check("scheduled provider CLI output keeps raw failure detail private",
    cliFailure.status === 1 && /slack scheduler stopped.*complete result/is.test(cliOutput) &&
      /Issue code: SCHEDULE_INSTALL_FAILED/.test(cliOutput) &&
      !cliOutput.includes("RAW_SCHEDULE_MANIFEST_SENTINEL") &&
      !/\bat .*\.mjs:\d+/.test(cliOutput) &&
      cliEvents.includes('"source":"slack"'), cliOutput);
} finally {
  rmSync(folder, { recursive: true, force: true });
}

{
  let error;
  try { createProviderSchedulerSpec("salesforce"); } catch (caught) { error = caught; }
  check("absent providers cannot acquire a scheduler by typo", /unsupported OAuth provider/.test(error?.message || ""));
}

{
  const env = safeIngestEnvironment({
    HOME: "/owner", BRAIN_HUBSPOT_TOKEN_STORE: "file", HUBSPOT_CLIENT_SECRET: "secret",
  });
  check("the shared sparse scheduler environment recognizes only provider storage mode",
    env.BRAIN_HUBSPOT_TOKEN_STORE === "file" && !("HUBSPOT_CLIENT_SECRET" in env));
}

console.log(`\nprovider scheduler: all ${ran} checks passed`);
