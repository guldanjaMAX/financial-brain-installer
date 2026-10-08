import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const TRIPWIRE = new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href;
// Wrap the existing adapter seam. CLI dispatch, provider selection, status
// inspection and rendering remain real; no native scheduler process can run.
const SCHEDULER_PRELOAD = `
import { registerHooks } from "node:module";
const scheduler = ${JSON.stringify(new URL("../operations/provider-scheduler.mjs", import.meta.url).href)};
const original = scheduler + "?fixture-scheduler-original";
registerHooks({
  load(url, context, nextLoad) {
    if (url !== scheduler) return nextLoad(url, context);
    return {
      format: "module", shortCircuit: true,
      source: \`export * from \${JSON.stringify(original)};
        import assert from "node:assert/strict";
        import { statusProviderScheduler as originalStatus } from \${JSON.stringify(original)};
        export function statusProviderScheduler(provider, manifestPath, options = {}) {
          assert.equal(provider, "slack");
          console.log("TEST_SCHEDULER_STAGE:provider");
          return originalStatus(provider, manifestPath, {
            ...options, home: process.env.HOME, uid: 501,
            launchctl(args) {
              assert.equal(args[0], "print");
              assert.equal(args.length, 2);
              assert.match(args[1], /^gui\\\\/501\\\\/.*\\\\.slack-ingest$/);
              console.log("TEST_SCHEDULER_STAGE:inspect");
              return process.env.SYNTHETIC_SCHEDULER_LOADED === "1"
                ? { status: 0, stdout: "state = waiting\\\\nruns = 1\\\\nlast exit code = 0\\\\n", stderr: "" }
                : { status: 113, stdout: "", stderr: "fixture service not loaded" };
            },
          });
        }\`,
    };
  },
});
`;

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-provider-scheduler-")));
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
  const publicCliEnvironment = cliTestEnvironment(folder);
  publicCliEnvironment.BRAIN_ADMIN_KEY_FILE = join(folder, ".brain-admin-key");
  writeFileSync(publicCliEnvironment.BRAIN_ADMIN_KEY_FILE, "synthetic-admin-key-fixture-only", { mode: 0o600 });
  const schedulerPreload = join(folder, "scheduler-preload.mjs");
  writeFileSync(schedulerPreload, SCHEDULER_PRELOAD);
  const statusArguments = [
    "--import", TRIPWIRE, "--import", pathToFileURL(schedulerPreload).href,
    brainCli, "schedule", manifestPath, "--provider", "slack", "--status",
  ];
  const publicStatus = spawnSync(
    process.execPath,
    statusArguments,
    { cwd: folder, encoding: "utf8", env: publicCliEnvironment, timeout: 30_000 },
  );
  const publicStatusOutput = `${publicStatus.stdout || ""}${publicStatus.stderr || ""}`;
  check("public provider status never attempts an uninjected native or network action",
    publicStatus.status !== 86 && !/TEST_SIDE_EFFECT_BLOCKED|INTEGRATION_BOUNDARY_BLOCKED/.test(publicStatusOutput));
  const stageCount = (output, name) => output.split(`TEST_SCHEDULER_STAGE:${name}\n`).length - 1;
  check("public provider status reaches the injected scheduler on supported platforms",
    stageCount(publicStatusOutput, "provider") === (process.platform === "darwin" ? 1 : 0) &&
      stageCount(publicStatusOutput, "inspect") === (process.platform === "darwin" ? 1 : 0));
  const renderedDailyOn = renderCliCommands(`brain daily on "${manifestPath}"`);
  check("the public schedule CLI preserves its provider selection",
    !/Drive refresh/.test(publicStatusOutput) &&
      (process.platform === "darwin"
        ? publicStatus.status === 0 && /slack refresh/i.test(publicStatusOutput)
        : process.platform === "win32"
          ? publicStatus.status === 1 && /owned per-Brain, per-user daily contract/.test(publicStatusOutput) &&
            new RegExp(escapeForRegExp(renderedDailyOn), "i").test(publicStatusOutput) &&
            !/--from slack/.test(publicStatusOutput)
          : publicStatus.status === 1 && /slack refresh.*not scheduled by the installer/is.test(publicStatusOutput)),
    publicStatusOutput);

  if (process.platform === "darwin") {
    const loadedStatus = spawnSync(process.execPath, statusArguments, {
      cwd: folder, encoding: "utf8", timeout: 30_000,
      env: { ...publicCliEnvironment, SYNTHETIC_SCHEDULER_LOADED: "1" },
    });
    const loadedOutput = `${loadedStatus.stdout || ""}${loadedStatus.stderr || ""}`;
    check("the loaded scheduler control reaches the adapter and renders its successful run",
      loadedStatus.status === 0 &&
        stageCount(loadedOutput, "provider") === 1 && stageCount(loadedOutput, "inspect") === 1 &&
        /last scheduled run succeeded/.test(loadedOutput) &&
        !/last scheduled run succeeded/.test(publicStatusOutput) &&
        !/TEST_SIDE_EFFECT_BLOCKED|INTEGRATION_BOUNDARY_BLOCKED/.test(loadedOutput), loadedOutput);
  }

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
  const cliEnvironment = cliTestEnvironment(cliRoot);
  cliEnvironment.BRAIN_ADMIN_KEY_FILE = join(cliRoot, ".brain-admin-key");
  writeFileSync(cliEnvironment.BRAIN_ADMIN_KEY_FILE, "synthetic-admin-key-fixture-only", { mode: 0o600 });
  const missingManifest = join(folder, "RAW_SCHEDULE_MANIFEST_SENTINEL.json");
  const schedulerCli = fileURLToPath(new URL("../operations/provider-scheduler.mjs", import.meta.url));
  const cliFailure = spawnSync(process.execPath, ["--import", TRIPWIRE, schedulerCli, "slack", "install", missingManifest], {
    cwd: cliRoot,
    encoding: "utf8",
    env: cliEnvironment,
    timeout: 30_000,
  });
  const cliOutput = `${cliFailure.stdout || ""}${cliFailure.stderr || ""}`;
  check("the scheduler refusal never attempts a native or network action",
    cliFailure.status !== 86 && !/TEST_SIDE_EFFECT_BLOCKED|INTEGRATION_BOUNDARY_BLOCKED/.test(cliOutput));
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
