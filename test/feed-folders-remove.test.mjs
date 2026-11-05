import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildConfiguredDailyPlan, cmdFolder, renderCliCommands, writeManifestAtomically } from "../brain.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { buildDailyRefreshDefinition } from "../operations/daily-refresh-scheduler.mjs";
import { acquireSourceIngestLock, probeSourceIngestLock } from "../operations/source-ingest-lock.mjs";
import { quotePosixArgument, quotePowerShellArgument } from "../operations/command-display.mjs";

const FIXED_NOW = new Date("2026-11-02T18:05:06.789Z");
const bytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "feed-remove-")));
  const home = join(root, "home");
  const first = join(root, "first");
  const second = join(root, "second");
  const watched = join(root, "watched");
  for (const path of [home, first, second, watched]) mkdirSync(path, { mode: 0o700 });
  const manifestPath = join(root, "brain.manifest.json");
  const manifest = {
    client: { slug: "fixture-brain", timezone: "UTC" },
    brain: { domain: "brain.example.invalid" },
    corpora: {
      local_folder: { enabled: true, path: watched, source: "watched", keep: "same" },
      upload: {
        enabled: true,
        folders: [
          { path: first, source: "first", feed: true, keep: "first" },
          { path: second, source: "second", feed: true, keep: "second" },
        ],
        exclude: ["excluded"],
        keep: { policy: "same" },
      },
    },
    operations: { daily_refresh: { enabled: true, timezone: "UTC" } },
  };
  writeFileSync(manifestPath, bytes(manifest), { mode: 0o600 });
  writeFileSync(join(root, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  const statePath = join(root, ".brain-ingest-first.json");
  writeFileSync(statePath, bytes({ version: 1, done: { "note.txt": "fixture-hash" } }), { mode: 0o600 });
  const documentPath = join(first, "note.txt");
  writeFileSync(documentPath, "Synthetic stored document.\n");
  return { root, home, first, second, manifestPath, manifest, statePath, documentPath };
}

const readManifest = (f) => JSON.parse(readFileSync(f.manifestPath, "utf8"));
const save = (f) => writeFileSync(f.manifestPath, bytes(f.manifest));
const lockOptions = (f) => ({ manifestPath: f.manifestPath, sourceName: "first", home: f.home });

async function capture(task) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = console.error = (...parts) => lines.push(parts.join(" "));
  try { return { result: await task(), text: lines.join("\n"), error: null }; }
  catch (error) { return { result: null, text: lines.join("\n"), error }; }
  finally { console.log = originalLog; console.error = originalError; }
}

function remove(f, source = "first", options = {}, argv = ["remove", "--source", source]) {
  return capture(() => cmdFolder(f.manifestPath, argv, {
    platform: process.platform,
    home: f.home,
    sourceIngestLockOptions: { home: f.home },
    schedulerOptions: { home: f.home, launchctl: () => { throw new Error("unexpected scheduler call"); } },
    now: () => new Date(FIXED_NOW),
    ...options,
  }));
}

async function assertControl() {
  const f = fixture();
  const control = await remove(f);
  assert.ifError(control.error);
  assert.equal(control.result.changed, true);
  assert.deepEqual(readManifest(f).corpora.upload.folders.map((entry) => entry.source), ["second"]);
}

test("remove one feed preserves other settings, local files, stored state, and the exact backup", async () => {
  const f = fixture();
  const original = readFileSync(f.manifestPath);
  const state = readFileSync(f.statePath);
  const document = readFileSync(f.documentPath);
  let writes = 0;
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { remoteCalls += 1; throw new Error("unexpected remote operation"); };
  let removed;
  try {
    removed = await remove(f, "first", {
      writeManifestAtomically(path, intended, options) {
        writes += 1;
        assert.equal(probeSourceIngestLock(lockOptions(f)).busy, true, "the source lease covers the write");
        return writeManifestAtomically(path, intended, options);
      },
    });
  } finally { globalThis.fetch = originalFetch; }
  assert.ifError(removed.error);
  assert.equal(writes, 1);
  assert.equal(remoteCalls, 0, "the completed removal never contacts a Brain");
  const expected = structuredClone(f.manifest);
  expected.corpora.upload.folders.splice(0, 1);
  assert.deepEqual(readManifest(f), expected);
  assert.deepEqual(readFileSync(removed.result.backupPath), original);
  assert.match(removed.text, /Removed feed first\. Documents already in your Brain stay\. Nothing on disk was deleted\./);
  assert.deepEqual(readFileSync(f.statePath), state);
  assert.deepEqual(readFileSync(f.documentPath), document);
  assert.equal(probeSourceIngestLock(lockOptions(f)).busy, false, "the source lease is released");
});

for (const enabled of [true, false]) {
  test(`removing the only feed keeps upload enabled=${enabled} and every other upload setting`, async () => {
    const f = fixture();
    f.manifest.corpora.upload.enabled = enabled;
    f.manifest.corpora.upload.folders.splice(1, 1);
    save(f);
    const removed = await remove(f);
    assert.ifError(removed.error);
    assert.deepEqual(readManifest(f).corpora.upload, { ...f.manifest.corpora.upload, folders: [] });
    assert.deepEqual(readManifest(f).corpora.local_folder, f.manifest.corpora.local_folder);
  });
}

test("removal keeps manual upload entries and matches source identities exactly", async () => {
  const f = fixture();
  const manual = { path: join(f.root, "manual"), source: "first", feed: false };
  f.manifest.corpora.upload.folders.push(manual, join(f.root, "legacy"));
  f.manifest.corpora.upload.folders[1].source = "first-extra";
  save(f);
  let accepted = 0;
  const removed = await remove(f, "first", {
    onFeedDecision(event) { if (event.outcome === "accepted") accepted += 1; },
  });
  assert.ifError(removed.error);
  assert.equal(accepted, 1);
  assert.equal(removed.result.changed, true);
  assert.deepEqual(readManifest(f).corpora.upload.folders, f.manifest.corpora.upload.folders.slice(1));
});

for (const mode of ["unknown", "duplicate", "manual-only"]) {
  test(`${mode} source refuses at the feed decision and keeps the manifest byte-identical`, async () => {
    const f = fixture();
    if (mode === "duplicate") f.manifest.corpora.upload.folders[1].source = "first";
    if (mode === "manual-only") f.manifest.corpora.upload.folders[0].feed = false;
    save(f);
    const before = readFileSync(f.manifestPath);
    const entries = readdirSync(dirname(f.manifestPath));
    const events = [];
    let writes = 0;
    const refused = await remove(f, mode === "unknown" ? "absent" : "first", {
      onFeedDecision: (event) => events.push(event),
      writeManifestAtomically() { writes += 1; throw new Error("unexpected write"); },
    });
    assert.match(refused.error?.message || "", mode === "duplicate" ? /more than one feed.*first/i : /no feed.*(?:absent|first)/i);
    if (mode === "duplicate") assert.match(refused.error.message, /entries 1, 2/);
    assert.equal(events.length, 1, "the refusal reaches the feed decision");
    assert.equal(events[0].outcome, "refused");
    assert.equal(writes, 0);
    assert.deepEqual(readFileSync(f.manifestPath), before);
    assert.deepEqual(readdirSync(dirname(f.manifestPath)), entries);
    await assertControl();
  });
}

test("a busy reader refuses before writing, and releasing it permits removal", async () => {
  const f = fixture();
  const reader = acquireSourceIngestLock(lockOptions(f));
  const before = readFileSync(f.manifestPath);
  let attempts = 0;
  let writes = 0;
  try {
    const refused = await remove(f, "first", {
      acquireSourceIngestLock(options) { attempts += 1; return acquireSourceIngestLock(options); },
      writeManifestAtomically() { writes += 1; throw new Error("unexpected write"); },
    });
    assert.match(refused.error?.message || "", /folder read is running now.*Nothing changed/s);
    assert.equal(attempts, 1, "the busy arm reaches the source lease decision");
    assert.equal(writes, 0);
    assert.deepEqual(readFileSync(f.manifestPath), before);
    reader.assertOwned();
  } finally { reader.release(); }
  const control = await remove(f);
  assert.ifError(control.error);
  assert.equal(control.result.changed, true);
});

test("removing the second feed keeps the first feed and its active reader untouched", async () => {
  const f = fixture();
  const reader = acquireSourceIngestLock(lockOptions(f));
  try {
    const removed = await remove(f, "second");
    assert.ifError(removed.error);
    assert.deepEqual(readManifest(f).corpora.upload.folders, [f.manifest.corpora.upload.folders[0]]);
    assert.equal(probeSourceIngestLock(lockOptions(f)).busy, true);
    reader.assertOwned();
  } finally { reader.release(); }
});

test("a failed write after replacement restores the original bytes and releases the lease", async () => {
  const f = fixture();
  const before = readFileSync(f.manifestPath);
  let replacements = 0;
  const refused = await remove(f, "first", {
    manifestWriteOptions: {
      filesystemPlatform: "linux",
      syncDirectory() {
        replacements += 1;
        assert.deepEqual(readManifest(f).corpora.upload.folders.map((entry) => entry.source), ["second"]);
        throw new Error("injected directory sync failure");
      },
    },
  });
  assert.match(refused.error?.message || "", /injected directory sync failure/);
  assert.ok(replacements >= 1, "the failure follows the manifest replacement");
  assert.deepEqual(readFileSync(f.manifestPath), before);
  assert.equal(probeSourceIngestLock(lockOptions(f)).busy, false);
  assert.equal(readdirSync(f.root).some((name) => /before-folder-feed|\.tmp$/u.test(name)), false);
  const control = await remove(f);
  assert.ifError(control.error);
  assert.equal(control.result.changed, true);
});

test("a concurrent manifest edit refuses replacement and preserves the newer settings", async () => {
  const f = fixture();
  const concurrent = { ...f.manifest, keep: "newer" };
  let writes = 0;
  const refused = await remove(f, "first", {
    writeManifestAtomically(path, intended, options) {
      writes += 1;
      writeFileSync(path, bytes(concurrent));
      return writeManifestAtomically(path, intended, options);
    },
  });
  assert.equal(writes, 1);
  assert.equal(refused.error?.code, "FOLDER_MANIFEST_CHANGED");
  assert.deepEqual(readManifest(f), concurrent);
  const control = await remove(f);
  assert.ifError(control.error);
  assert.equal(readManifest(f).keep, "newer");
});

test("the rebuilt daily plan drops the removed feed's ingest leg", async () => {
  const f = fixture();
  const planOptions = { platform: "darwin", principal: "uid:501", localTimezone: "UTC", existingSchedulerOwners: ["local_folder"] };
  const before = await buildConfiguredDailyPlan(f.manifest, f.manifestPath, planOptions);
  assert.equal(before.ready, true);
  assert.deepEqual(before.sources.find((entry) => entry.key === "upload").source_names, ["first", "second"]);
  const removed = await remove(f);
  assert.ifError(removed.error);
  const after = await buildConfiguredDailyPlan(readManifest(f), f.manifestPath, planOptions);
  assert.equal(after.ready, true);
  assert.deepEqual(after.sources.find((entry) => entry.key === "upload").source_names, ["second"]);
  assert.notEqual(after.source_plan_hash, before.source_plan_hash);
});

for (const mode of ["registration", "plan", "definition", "empty"]) {
  test(`obsolete daily definition (${mode}) prints the concrete next command before any source runs`, async () => {
    const f = fixture();
    const planOptions = { platform: "darwin", principal: "uid:501", localTimezone: "UTC", existingSchedulerOwners: ["local_folder"] };
    const before = await buildConfiguredDailyPlan(f.manifest, f.manifestPath, planOptions);
    assert.equal(before.ready, true);
    const definitionOptions = { platform: "darwin", nodePath: process.execPath };
    const registered = buildDailyRefreshDefinition(before, definitionOptions);
    f.manifest.corpora.upload.folders.splice(0, mode === "empty" ? 2 : 1);
    save(f);
    const after = await buildConfiguredDailyPlan(f.manifest, f.manifestPath, planOptions);
    let inspections = 0;
    let runs = 0;
    const runOptions = {
      home: f.home,
      platform: "darwin",
      principal: "uid:501",
      brainModule: {},
      buildPlan: async () => after,
      expectedDefinitionHash: registered.definition_hash,
      definitionOptions,
      inspectSchedule: () => {
        inspections += 1;
        return {
          installed: mode !== "registration", enabled: true, state: { definition: registered },
          plan_matches_registered_definition: mode === "definition",
        };
      },
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      readUpdateTransaction: () => null,
      runSource: async () => { runs += 1; return { status: "complete" }; },
      readFreshness: async () => ({ second: { last_successful_run_at: FIXED_NOW.toISOString() } }),
      writeReceipt() {},
      now: () => new Date(FIXED_NOW),
      silent: true,
    };
    const refused = await capture(() => runDailyRefreshCli(f.manifestPath, runOptions));
    assert.equal(inspections, 1, "the stale arm reaches the registered definition decision");
    assert.equal(runs, 0);
    // The executable prefix depends on how the CLI is installed on the host
    // ("brain" on PATH or the full node command), so assert the concrete
    // command with the platform-quoted manifest path.
    const quoted = (process.platform === "win32" ? quotePowerShellArgument : quotePosixArgument)(f.manifestPath);
    assert.match(refused.error?.message || "", /next run: \S/);
    assert.ok(refused.error.message.includes(`daily on ${quoted}`), refused.error.message);
    if (mode === "empty") {
      assert.equal(after.ready, false, "the final removal leaves enabled upload visibly unavailable");
      f.manifest.corpora.upload.folders = [{
        path: f.second, source: "second", feed: true,
      }];
      save(f);
    }
    const controlPlan = await buildConfiguredDailyPlan(f.manifest, f.manifestPath, planOptions);
    const current = buildDailyRefreshDefinition(controlPlan, definitionOptions);
    const control = await runDailyRefreshCli(f.manifestPath, {
      ...runOptions,
      buildPlan: async () => controlPlan,
      expectedDefinitionHash: current.definition_hash,
      inspectSchedule: () => ({ installed: true, enabled: true, state: { definition: current }, plan_matches_registered_definition: true }),
      readFreshness: async () => ({ second: { last_successful_run_at: ++inspections === 2
        ? "2026-11-01T18:05:06.789Z" : FIXED_NOW.toISOString() } }),
    });
    assert.equal(control.status, "complete");
    assert.equal(runs, 1, "the rebuilt definition executes only the remaining source");
  });
}

test("the CLI dispatch removes a feed and help exposes the action in both command groups", () => {
  const f = fixture();
  const entry = fileURLToPath(new URL("../brain.mjs", import.meta.url));
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: f.home, USERPROFILE: f.home, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_USER_ROOT: f.root, BRAIN_LIFECYCLE_LOCK_ROOT: join(f.root, "lifecycle-locks"), NO_COLOR: "1" });
  const preload = new URL("./fixtures/feed-folder-entry-preload.mjs", import.meta.url).href;
  const removed = spawnSync(process.execPath, ["--import", preload, entry, "folder", f.manifestPath, "remove", "--source", "first"], { env, encoding: "utf8" });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Removed feed first\. Documents already in your Brain stay\. Nothing on disk was deleted\./);
  assert.deepEqual(readManifest(f).corpora.upload.folders.map((folder) => folder.source), ["second"]);
  const help = spawnSync(process.execPath, ["--import", preload, entry, "--help"], { env, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.equal((help.stdout.match(/folder\s+<manifest> remove --source <name>/gu) || []).length, 2);
});

test("remove guidance renders the current Windows executable and quotes the manifest path", () => {
  const windows = { platform: "win32", nodePath: "C:\\Runtime\\node.exe", scriptPath: "C:\\Runtime\\brain.mjs", env: {}, existsSync: () => false };
  const path = "C:\\Owner's files\\brain.manifest.json";
  const command = renderCliCommands(`brain folder ${quotePowerShellArgument(path)} remove --source first`, windows);
  assert.match(command, /Owner''s files/);
  assert.match(command, /'C:\\Runtime\\node\.exe' 'C:\\Runtime\\brain\.mjs'/);
  assert.match(command, /remove --source first$/);
});


test("one accepted feed removal preserves manual roots with the same source and distinct spellings", async () => {
  const f = fixture();
  const manual = { path: join(f.root, "manual"), source: "first", feed: false };
  f.manifest.corpora.upload.folders.push(manual,
    ...["First", "f\u0456rst", "first "].map((source) => ({ path: join(f.root, "missing"), source, feed: true })),
  );
  save(f);
  let accepted = 0;
  const removed = await remove(f, "first", {
    onFeedDecision(event) { if (event.outcome === "accepted") accepted += 1; },
  });
  assert.ifError(removed.error);
  assert.equal(accepted, 1, "the real command accepted one declared feed");
  assert.equal(removed.result.changed, true);
  assert.deepEqual(readManifest(f).corpora.upload.folders, f.manifest.corpora.upload.folders.slice(1));
});

for (const source of ["First", "f\u0456rst", "first "]) {
  test(`source spelling ${JSON.stringify(source)} refuses without normalization`, async () => {
    const f = fixture();
    const before = readFileSync(f.manifestPath);
    let reads = 0;
    let writes = 0;
    const refused = await remove(f, source, {
      readManifestBytes(path) { reads += 1; return readFileSync(path); },
      writeManifestAtomically() { writes += 1; throw new Error("unexpected write"); },
    });
    assert.match(refused.error?.message || "", /not a usable source name/);
    assert.equal(reads, 1, "source validation was reached with the manifest snapshot");
    assert.equal(writes, 0);
    assert.deepEqual(readFileSync(f.manifestPath), before);
    await assertControl();
  });
}
