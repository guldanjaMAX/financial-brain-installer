import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSourceSchedulerPlan,
  createSourceSchedulerSpec,
  SCHEDULED_SOURCE_IDS,
} from "../operations/source-scheduler.mjs";
import { buildWindowsSchedulerPlan } from "../operations/windows-task-scheduler.mjs";
import { cmdSchedule } from "../brain.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "brain-source-scheduler-"));
try {
  const manifestPath = join(root, "brain.manifest.json");
  const manifest = {
    manifest_version: 1,
    client: { slug: "fixture-owner", display_name: "Fixture Owner", timezone: "UTC" },
    brain: { version: "0.4.8", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    corpora: {
      gmail: { enabled: true, source: "mail" },
      calendar: { enabled: true, source: "appointments" },
      imap: { enabled: true, source: "mailbox", host: "imap.example.invalid", username: "owner@example.invalid" },
    },
    operations: {
      admin_key_secret: "keychain://fixture-owner/brain-admin",
      google_token_store: "file",
      imap_credential_store: "file",
      source_crons: {
        gmail: "5 * * * *",
        calendar: "10 * * * *",
        imap: "20 * * * *",
      },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  check("the packaged source scheduler covers exactly Gmail, Calendar, and IMAP",
    JSON.stringify(SCHEDULED_SOURCE_IDS) === JSON.stringify(["gmail", "calendar", "imap"]));

  for (const source of SCHEDULED_SOURCE_IDS) {
    const plan = buildSourceSchedulerPlan(source, manifestPath, {
      platform: "darwin",
      uid: 501,
      home: root,
      nodePath: "/usr/bin/node",
      brainPath: "/opt/brain/brain.mjs",
    });
    check(`${source} has its own LaunchAgent identity and configured cadence`,
      plan.label.endsWith(`.${source}-ingest`) && plan.cron === manifest.operations.source_crons[source]);
    check(`${source} scheduled child enters the ordinary ingest path with scheduled proof enabled`,
      plan.spec.childArgumentsOf(plan).join(" ") ===
        `ingest ${plan.path} --from ${source} --source ${manifest.corpora[source].source} --scheduled-run`);
    const child = plan.spec.childEnvironmentOf(plan, {
      HOME: root,
      BRAIN_GOOGLE_TOKEN_STORE: "keychain",
      BRAIN_IMAP_CREDENTIAL_STORE: "keychain",
      ADMIN_KEY: "must-not-pass",
      CLOUDFLARE_API_TOKEN: "must-not-pass",
    });
    const expectedStore = source === "imap" ? "BRAIN_IMAP_CREDENTIAL_STORE" : "BRAIN_GOOGLE_TOKEN_STORE";
    check(`${source} carries only its declared credential-store selector`,
      child[expectedStore] === "file" && !("ADMIN_KEY" in child) && !("CLOUDFLARE_API_TOKEN" in child));

    const windows = buildWindowsSchedulerPlan(manifestPath, {
      source,
      manifest,
      windowsManifestPath: String.raw`C:\Brain\brain.manifest.json`,
      windowsCwd: String.raw`C:\Brain`,
      localAppData: String.raw`C:\Users\Owner\AppData\Local`,
      environment: { LOCALAPPDATA: String.raw`C:\Users\Owner\AppData\Local` },
    });
    check(`${source} uses the C2 Windows adapter with the same exact ingest action`,
      windows.taskName.endsWith(`.${source}-ingest`) &&
        windows.childArguments.join(" ") ===
          `ingest C:\\Brain\\brain.manifest.json --from ${source} --source ${manifest.corpora[source].source} --scheduled-run`);
  }

  const scheduleCalls = [];
  const expectationCalls = [];
  const result = await cmdSchedule(manifestPath, {
    platform: "darwin",
    flags: { source: "gmail", install: true },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async (...args) => { expectationCalls.push(args); },
    sourceScheduler: {
      installSourceScheduler: (...args) => {
        scheduleCalls.push(args);
        return {
          cron: "5 * * * *",
          expectedRefreshSeconds: 3_600,
          localTimeZone: "UTC",
          plistPath: "/fixture/gmail.plist",
          stdoutPath: "/fixture/out",
          stderrPath: "/fixture/err",
          warnings: [],
        };
      },
    },
  });
  check("brain schedule dispatches a source install through the packaged source lane",
    result.cron === "5 * * * *" && scheduleCalls.length === 1 &&
      scheduleCalls[0][0] === "gmail" && scheduleCalls[0][1] === manifestPath);
  check("source install records cadence against the configured source name",
    expectationCalls.length === 1 && JSON.stringify(expectationCalls[0][2]) === JSON.stringify({
      source: "mail", kind: "gmail", expected_refresh_seconds: 3_600,
      schedule_cron: "5 * * * *", schedule_timezone: "UTC",
    }));

  let invalidCalls = 0;
  await assert.rejects(cmdSchedule(manifestPath, {
    platform: "darwin",
    flags: { source: "drive", install: true },
    resolveAdminKey: () => { invalidCalls++; return "must-not-read"; },
    sourceScheduler: { installSourceScheduler: () => { invalidCalls++; } },
  }), /--source must be one of gmail, calendar, imap/);
  check("an unsupported source refuses before credentials or scheduler mutation", invalidCalls === 0);

  assert.throws(() => createSourceSchedulerSpec("drive"), /unsupported scheduled source/);
  check("the source lane cannot shadow the existing Drive scheduler", true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nsource scheduler: all ${ran} checks passed`);
