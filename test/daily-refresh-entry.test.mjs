import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildConfiguredDailyPlan } from "../brain.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { buildDailyRefreshDefinition } from "../operations/daily-refresh-scheduler.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { quotePosixArgument, quotePowerShellArgument } from "../operations/command-display.mjs";

const fixed = new Date("2026-11-02T18:05:06.789Z");
async function fixture(platform = process.platform === "win32" ? "win32" : "darwin") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-entry-")));
  const home = join(root, "home");
  for (const part of ["home", "first", "second"]) mkdirSync(join(root, part), { mode: 0o700 });
  const path = join(root, "owner's settings.json");
  const manifest = {
    client: { slug: "fixture-brain", timezone: "UTC" }, brain: { domain: "fixture.invalid" },
    corpora: { upload: { enabled: true, folders: ["first", "second"].map((source) => ({ path: join(root, source), source, feed: true })) } },
    operations: { daily_refresh: { enabled: true, timezone: "UTC" } },
  };
  writeFileSync(join(root, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  const options = { platform, principal: "fixture-principal", localTimezone: "UTC", existingSchedulerOwners: [] };
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const before = await buildConfiguredDailyPlan(manifest, path, options);
  manifest.corpora.upload.folders.shift();
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const plan = await buildConfiguredDailyPlan(manifest, path, options);
  assert.equal(before.ready, true);
  assert.equal(plan.ready, true);
  const definitionOptions = { platform: options.platform, nodePath: process.execPath };
  return { root, home, path, plan, definitionOptions,
    old: buildDailyRefreshDefinition(before, definitionOptions), current: buildDailyRefreshDefinition(plan, definitionOptions) };
}
function subprocess(f, mode) {
  const events = join(f.root, `${mode}-events.txt`);
  const config = join(f.root, `${mode}-fixture.json`);
  const registered = mode === "stale" ? f.old : f.current;
  writeFileSync(config, JSON.stringify({ plan: f.plan, registered, events, mode, privateError: "private-marker: brain daily on arbitrary-input" }));
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const child = spawnSync(process.execPath, [
    "--import", new URL("./fixtures/daily-refresh-entry-preload.mjs", import.meta.url).href,
    fileURLToPath(new URL("../operations/daily-refresh-run.mjs", import.meta.url)),
    "run", f.path, "--definition-hash", registered.definition_hash,
  ], { env: { ...env, HOME: f.home, USERPROFILE: f.home, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(),
    BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_LIFECYCLE_LOCK_ROOT: join(f.root, "lifecycle-locks"), DAILY_ENTRY_FIXTURE: config, DAILY_ENTRY_PLATFORM: f.plan.platform,
    SystemRoot: process.env.SystemRoot || "C:/Windows",
  }, encoding: "utf8", timeout: 15_000 });
  return { child, events: readFileSync(events, "utf8").trim().split("\n") };
}

test("scheduled entry prints the concrete recovery command for an obsolete definition", async () => {
  const f = await fixture();
  const { child, events } = subprocess(f, "stale");
  assert.equal(child.status, 1);
  assert.deepEqual(events, ["schedule-read"], "the real entry reached inspection and ran no source");
  const quote = process.platform === "win32" ? quotePowerShellArgument : quotePosixArgument;
  assert.ok(`${child.stdout}${child.stderr}`.includes(renderCliCommands(`brain daily on ${quote(f.path)}`)));
  const logRoot = join(f.home, ".brain", "logs");
  const rows = readFileSync(join(logRoot, readdirSync(logRoot)[0], "daily.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.result), ["running", "failed"]);
  assert.ok(rows.every((row) => !JSON.stringify(row).includes(f.path)), "observation stays bounded");
  const control = subprocess(f, "current");
  assert.equal(control.child.status, 0, control.child.stderr);
  assert.deepEqual(control.events, ["schedule-read", "schedule-read", "source-run"]);
  assert.match(control.child.stdout, /daily refresh complete/);
});

test("scheduled entry keeps arbitrary failures generic even when their message contains a command", async () => {
  const f = await fixture();
  const { child, events } = subprocess(f, "generic");
  assert.equal(child.status, 1);
  assert.deepEqual(events, ["schedule-read"]);
  assert.match(child.stderr, /Daily refresh failed: daily_refresh_failed/);
  assert.doesNotMatch(`${child.stdout}${child.stderr}`, /private-marker|arbitrary-input/);
  assert.ok(!`${child.stdout}${child.stderr}`.includes(renderCliCommands(`brain daily on ${quotePosixArgument(f.path)}`)));
  const control = subprocess(f, "current");
  assert.equal(control.child.status, 0, control.child.stderr);
  assert.deepEqual(control.events, ["schedule-read", "schedule-read", "source-run"]);
});

for (const platform of ["darwin", "win32"]) {
  test(`obsolete daily definition has a stable code and quotes the concrete path on ${platform}`, async () => {
    const f = await fixture();
    let inspections = 0;
    const definitionOptions = { platform, nodePath: process.execPath };
    const definition = buildDailyRefreshDefinition(f.plan, definitionOptions);
    const settings = {
      platform, home: f.home, principal: "fixture-principal", brainModule: {}, buildPlan: async () => f.plan, definitionOptions,
      expectedDefinitionHash: definition.definition_hash,
      inspectSchedule() { inspections++; return { installed: false }; },
      appendObservation() {}, silent: true,
    };
    await assert.rejects(runDailyRefreshCli(f.path, settings), (error) => {
      assert.equal(inspections, 1);
      assert.equal(error.code, "daily_schedule_definition_obsolete");
      const quote = platform === "win32" ? quotePowerShellArgument : quotePosixArgument;
      const expected = renderCliCommands(`brain daily on ${quote(f.path)}`, { platform });
      assert.ok(error.message.includes(expected));
      if (platform === "win32") assert.doesNotMatch(error.message, /\bbrain daily on\b/u);
      return true;
    });
    let runs = 0, reads = 0;
    const result = await runDailyRefreshCli(f.path, {
      ...settings,
      inspectSchedule: () => ({ installed: true, enabled: true, state: { definition }, plan_matches_registered_definition: true }),
      acquireLock: () => ({ assertOwned() {}, release() {} }), readUpdateTransaction: () => null, writeReceipt() {},
      runSource: async () => { runs++; return { status: "complete" }; },
      readFreshness: async () => ({ second: { last_successful_run_at: ++reads === 1 ? "2026-11-01T18:05:06.789Z" : fixed.toISOString() } }),
      now: () => new Date(fixed),
    });
    assert.equal(result.status, "complete");
    assert.equal(runs, 1);
  });
}


test("scheduled Windows entry renders the executable and quotes the actual manifest", async () => {
  const f = await fixture("win32");
  const { child, events } = subprocess(f, "stale");
  assert.equal(child.status, 1);
  assert.deepEqual(events, ["schedule-read"]);
  const expected = renderCliCommands(`brain daily on ${quotePowerShellArgument(f.path)}`, { platform: "win32" });
  assert.ok(`${child.stdout}${child.stderr}`.includes(expected));
  assert.doesNotMatch(child.stderr, /\bbrain daily on\b/u);
  const control = subprocess(f, "current");
  assert.equal(control.child.status, 0, control.child.stderr);
  assert.deepEqual(control.events, ["schedule-read", "schedule-read", "source-run"]);
});
