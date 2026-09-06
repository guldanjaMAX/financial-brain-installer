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
assert.match(win, /not scheduled by the installer on Windows yet/, "names the platform and the limit");
assert.match(win, /the brain itself, the install, the update and the checkup all work here/, "says what does work");
assert.match(win, /schtasks \/Create/, "gives the Task Scheduler recipe");
assert.match(win, /where\.exe brain/, "tells them how to find the command");
assert.ok(win.includes(`brain load "${manifest}" --only drive,calendar,upload`), "uses their manifest path in the by-hand line");
assert.ok(win.includes(String.raw`/TR "cmd /c \"\"<path to brain.cmd>\" load \"` + manifest + String.raw`\" --only drive,calendar,upload\""`), "schtasks inner quotes are escaped for /TR");
assert.doesNotMatch(win, /bug in the installer|unexpected error/i, "never reads as a crash");

const linux = schedulePlatformLimitation("linux", "/home/robin/brain.manifest.json");
assert.match(linux, /cron/, "linux gets a cron line");

const slackWin = schedulePlatformLimitation("win32", manifest, { provider: "slack" });
assert.match(slackWin, /slack refresh is not scheduled by the installer on Windows yet/,
  "the provider lane names its own platform limitation");
assert.ok(slackWin.includes(`brain ingest "${manifest}" --from slack`),
  "the provider lane gives the exact manual connector command");
assert.ok(slackWin.includes(String.raw`/TN "Financial Brain slack refresh"`),
  "the Windows task has a provider-specific name");
assert.doesNotMatch(slackWin, /--only drive,calendar,upload/,
  "the provider recipe never points an owner at the unrelated Drive refresh lane");

const dropboxLinux = schedulePlatformLimitation(
  "linux",
  "/home/robin/brain.manifest.json",
  { provider: "dropbox" },
);
assert.match(dropboxLinux, /0 \* \* \* \* brain ingest "\/home\/robin\/brain\.manifest\.json" --from dropbox/,
  "Linux gets a provider-specific cron recipe");

console.log("schedule platform: off macOS the scheduler explains itself and hands over a recipe");
