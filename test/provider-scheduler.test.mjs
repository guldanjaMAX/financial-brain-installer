import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const publicCliEnvironment = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) publicCliEnvironment[key] = process.env[key];
  }
  publicCliEnvironment.HOME = folder;
  publicCliEnvironment.USERPROFILE = folder;
  const publicStatus = spawnSync(
    process.execPath,
    [brainCli, "schedule", manifestPath, "--provider", "slack", "--status"],
    { encoding: "utf8", env: publicCliEnvironment, timeout: 30_000 },
  );
  const publicStatusOutput = `${publicStatus.stdout || ""}${publicStatus.stderr || ""}`;
  check("the public schedule CLI preserves its provider selection",
    /slack refresh/i.test(publicStatusOutput) && !/Drive refresh/.test(publicStatusOutput) &&
      (process.platform === "darwin"
        ? publicStatus.status === 0
        : publicStatus.status === 1 && /not scheduled by the installer/.test(publicStatusOutput)),
    publicStatusOutput);

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
