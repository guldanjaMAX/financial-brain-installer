import { schedulerRunnerAttempts } from "./helpers/scheduler-runner-guard.mjs";
/**
 * `brain schedule` off macOS must say what is and is not supported, with the
 * recipe for the platform, not crash as an installer bug. A Windows owner read
 * that crash as "this system was built for Apple products" (2026-09-03).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSchedule, schedulePlatformLimitation } from "../brain.mjs";

assert.equal(schedulePlatformLimitation("darwin", "/m.json"), null, "macOS has the LaunchAgent path");

const manifest = String.raw`C:\Users\Fixture\brain.manifest.json`;
assert.equal(schedulePlatformLimitation("win32", manifest), null,
  "Windows now dispatches to Task Scheduler instead of the old limitation recipe");

const linux = schedulePlatformLimitation("linux", "/home/fixture/brain.manifest.json");
assert.match(linux, /cron/, "linux gets a cron line");

const slackWin = schedulePlatformLimitation("win32", manifest, { provider: "slack" });
assert.equal(slackWin, null, "Windows provider scheduling uses the native task path too");

const dropboxLinux = schedulePlatformLimitation(
  "linux",
  "/home/fixture/brain.manifest.json",
  { provider: "dropbox" },
);
assert.match(dropboxLinux, /0 \* \* \* \* brain ingest "\/home\/fixture\/brain\.manifest\.json" --from dropbox/,
  "Linux gets a provider-specific cron recipe");

const controlDirectory = mkdtempSync(join(tmpdir(), "brain-windows-schedule-control-"));
try {
  const controlManifest = join(controlDirectory, "brain.manifest.json");
  writeFileSync(controlManifest, JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture-brain", display_name: "Fixture" },
    brain: { version: "0.4.8", domain: "fixture.invalid" },
    corpora: { local_folder: { enabled: true, path: String.raw`C:\Source Files`, source: "documents" } },
    operations: { folder_ingest_cron: "15 * * * *" },
  }));
  const calls = [];
  await cmdSchedule(controlManifest, {
    platform: "win32",
    flags: { folder: true, install: true },
    resolveAdminKey: () => "fixture-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
    windowsScheduler: {
      installWindowsScheduler: (...args) => {
        calls.push(args);
        return { installed: true, cron: "15 * * * *", expectedRefreshSeconds: 3600, taskName: "fixture" };
      },
    },
  });
  assert.equal(calls.length, 1,
    "Windows install reaches the injected Task Scheduler path instead of printing the old recipe");
} finally {
  rmSync(controlDirectory, { recursive: true, force: true });
}

assert.deepEqual(schedulerRunnerAttempts, [], "no check reached a real launchctl or schtasks");

console.log("schedule platform: Windows dispatches natively and other unsupported platforms get guidance");
