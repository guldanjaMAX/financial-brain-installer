/**
 * `brain schedule` off macOS must say what is and is not supported, with the
 * recipe for the platform, not crash as an installer bug. A Windows owner read
 * that crash as "this system was built for Apple products" (2026-09-03).
 */
import assert from "node:assert/strict";
import { schedulePlatformLimitation } from "../brain.mjs";

assert.equal(schedulePlatformLimitation("darwin", "/m.json"), null, "macOS has the LaunchAgent path");

const manifest = String.raw`C:\Users\dana\brain.manifest.json`;
const win = schedulePlatformLimitation("win32", manifest);
assert.match(win, /brain daily on/i, "Windows routes to the owned cross-platform contract");
assert.doesNotMatch(win, /schtasks \/Create|--only drive,calendar,upload/, "the public path no longer invents a fixed Windows source list");
assert.doesNotMatch(win, /bug in the installer|unexpected error/i, "never reads as a crash");

const linux = schedulePlatformLimitation("linux", "/home/robin/brain.manifest.json");
assert.match(linux, /cron/, "linux gets a cron line");

const slackWin = schedulePlatformLimitation("win32", manifest, { provider: "slack" });
assert.match(slackWin, /brain daily on/i, "provider requests use the same manifest-derived daily contract");
assert.doesNotMatch(slackWin, /Financial Brain slack refresh|--from slack/,
  "Windows does not install a second provider-specific task beside the daily plan");

const dropboxLinux = schedulePlatformLimitation(
  "linux",
  "/home/robin/brain.manifest.json",
  { provider: "dropbox" },
);
assert.match(dropboxLinux, /0 \* \* \* \* brain ingest "\/home\/robin\/brain\.manifest\.json" --from dropbox/,
  "Linux gets a provider-specific cron recipe");

console.log("schedule platform: off macOS the scheduler explains itself and hands over a recipe");
