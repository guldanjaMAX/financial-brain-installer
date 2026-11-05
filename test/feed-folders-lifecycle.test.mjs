import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cmdFolder, cmdIngestLocal, cmdLoad, credentialScannerFingerprint } from "../brain.mjs";
import { acquireBrainLifecycleLock, withBrainLifecycleLock } from "../operations/brain-lifecycle-lock.mjs";
import { acquireSourceIngestLock } from "../operations/source-ingest-lock.mjs";
import { batchStream } from "../ingest/run.mjs";

const entry = fileURLToPath(new URL("../brain.mjs", import.meta.url));
const preload = new URL("./fixtures/feed-folder-entry-preload.mjs", import.meta.url).href;
const fixed = new Date("2026-11-02T18:05:06.789Z");
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "folder-lifecycle-")));
  const home = join(root, "home");
  for (const part of ["home", "first", "second", "third"]) mkdirSync(join(root, part), { mode: 0o700 });
  const path = join(root, "owner's settings.json");
  const manifest = {
    client: { slug: "fixture-brain", timezone: "UTC" },
    brain: { domain: "fixture.invalid" },
    corpora: { upload: { enabled: true, folders: ["first", "second"].map((source) => ({ path: join(root, source), source, feed: true })) } },
  };
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  writeFileSync(join(root, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  return { root, home, path, manifest, machineLockRoot: join(root, "lifecycle-locks") };
}
const sources = (f) => JSON.parse(readFileSync(f.path, "utf8")).corpora.upload.folders.map((x) => x.source);
async function capture(run) {
  const originalLog = console.log, originalError = console.error;
  console.log = console.error = () => {};
  try { return { value: await run(), error: null }; }
  catch (error) { return { value: null, error }; }
  finally { console.log = originalLog; console.error = originalError; }
}
function folder(f, args = ["remove", "--source", "first"], extra = {}) {
  return cmdFolder(f.path, args, {
    home: f.home,
    lifecycleLockOptions: { machineLockRoot: f.machineLockRoot, restrictWindowsDirectory() {} },
    sourceIngestLockOptions: { home: f.home },
    schedulerOptions: { home: f.home, launchctl() { throw new Error("unexpected scheduler"); } },
    now: () => new Date(fixed), ...extra,
  });
}
function environment(f) {
  return {
    ...Object.fromEntries(["PATH", "SystemRoot", "WINDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    HOME: f.home, USERPROFILE: f.home, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(),
    BRAIN_TEST_USER_ROOT: f.root, BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_LIFECYCLE_LOCK_ROOT: f.machineLockRoot, NO_COLOR: "1",
  };
}
function peerAdd(f) {
  return spawnSync(process.execPath, ["--import", preload, entry, "folder", f.path, "add", "--path", join(f.root, "third"), "--source", "third"], {
    env: environment(f), encoding: "utf8", timeout: 10_000,
  });
}
function assertPeer(peer) {
  assert.ok(peer.status === 0 || (peer.status === 1 && /running|busy/iu.test(`${peer.stdout}${peer.stderr}`)), "peer succeeded or explicitly refused at the busy boundary");
}

for (const action of ["add", "remove", "create-feeds", "off"]) {
  test(`${action} takes the lifecycle lease before the manifest snapshot`, async () => {
    const f = fixture();
    if (action === "off") {
      f.manifest.corpora.local_folder = { enabled: true, path: join(f.root, "second"), source: "second" };
      writeFileSync(f.path, `${JSON.stringify(f.manifest)}\n`);
    }
    const actionOptions = action === "off" ? { platform: "linux", resolveAdminKey: () => null } : {};
    const args = action === "add" ? [action, "--path", join(f.root, "third"), "--source", "third"]
      : action === "remove" ? [action, "--source", "first"] : [action];
    let attempts = 0, reads = 0;
    const holder = acquireBrainLifecycleLock({ manifestPath: f.path, operation: "load", machineLockRoot: f.machineLockRoot, restrictWindowsDirectory() {} });
    const before = readFileSync(f.path);
    try {
      const refused = await capture(() => folder(f, args, {
        ...actionOptions,
        withBrainLifecycleLock(settings, task) { attempts++; return withBrainLifecycleLock(settings, task); },
        readManifestBytes(path) { reads++; return readFileSync(path); },
      }));
      assert.equal(attempts, 1, "the action reached lifecycle acquisition");
      assert.match(refused.error?.message || "", /A Brain job is running now.*Nothing changed/s);
      assert.equal(reads, 0);
      assert.deepEqual(readFileSync(f.path), before);
      holder.assertOwned();
    } finally { holder.release(); }
    let entered = 0;
    const control = await capture(() => folder(f, args, {
      ...actionOptions,
      withBrainLifecycleLock(settings, task) { return withBrainLifecycleLock(settings, (lease) => { entered++; return task(lease); }); },
    }));
    assert.ifError(control.error);
    assert.equal(entered, 1);
    assert.equal(control.value.action, action);
    assert.equal(control.value.changed, true);
  });
}

test("removal retains the lifecycle lease through readback and source release", async () => {
  const f = fixture(), events = [];
  let lifecycle;
  const result = await capture(() => folder(f, undefined, {
    withBrainLifecycleLock(settings, task) {
      return withBrainLifecycleLock(settings, async (lease) => {
        lifecycle = lease; events.push("lifecycle");
        try { return await task(lease); } finally { events.push("lifecycle-release"); }
      });
    },
    acquireSourceIngestLock(settings) {
      lifecycle.assertOwned(); events.push("source");
      const source = acquireSourceIngestLock(settings);
      return { assertOwned: source.assertOwned, release() {
        lifecycle.assertOwned(); events.push("source-release"); source.release();
      } };
    },
    manifestWriteOptions: { fs: { readFileSync(path, ...args) {
      if (path === resolve(f.path)) { lifecycle.assertOwned(); events.push("readback"); }
      return readFileSync(path, ...args);
    } } },
  }));
  assert.ifError(result.error);
  assert.equal(result.value.changed, true);
  assert.deepEqual(events.slice(0, 2), ["lifecycle", "source"]);
  assert.ok(events.filter((x) => x === "readback").length >= 2);
  assert.deepEqual(events.slice(-2), ["source-release", "lifecycle-release"]);
  const control = await capture(() => folder(f, ["remove", "--source", "second"], { now: () => new Date("2026-11-02T18:05:07.789Z") }));
  assert.ifError(control.error);
  assert.equal(control.value.changed, true, "both leases were released");
});

test("a real peer add at the last metadata read cannot be lost by removal", async () => {
  const f = fixture();
  let reads = 0, reached = 0, peer;
  const removed = await capture(() => folder(f, undefined, { manifestWriteOptions: { fs: {
    lstatSync(path) {
      const state = lstatSync(path);
      if (path === resolve(f.path) && ++reads === 4) { reached++; peer = peerAdd(f); }
      return state;
    },
  } } }));
  assert.equal(reached, 1, "the interleaving reached the last metadata read before rename");
  assertPeer(peer);
  assert.ifError(removed.error);
  assert.equal(removed.value.changed, true);
  assert.deepEqual(sources(f), peer.status === 0 ? ["second", "third"] : ["second"]);
  const control = peerAdd(f);
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(sources(f), ["second", "third"]);
});

for (const race of [false, true]) {
  test(`${race ? "stale" : "current"} direct feed plan reaches the source lease before walking`, async () => {
    const f = fixture();
    let acquisitions = 0, walks = 0, removal;
    const result = await capture(() => cmdIngestLocal(f.manifest, f.path, { path: join(f.root, "first"), source: "first", "dry-run": true }, {
      withSourceIngestLock: async (settings, task) => {
        acquisitions++;
        if (race) removal = await folder(f);
        const lease = acquireSourceIngestLock({ ...settings, home: f.home });
        try { return await task(lease); } finally { lease.release(); }
      },
      ingestLib: async () => ({
        walk() { walks++; return { files: [], skipped: [], complete: true }; },
        loadState: () => ({ version: 1, done: {}, skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true) }),
        saveState() { throw new Error("unexpected dry-run write"); }, batchStream,
      }),
      resolveAdminKey() { throw new Error("unexpected credential lookup"); },
    }));
    assert.equal(acquisitions, 1, "the planned reader reached source acquisition");
    if (race) {
      assert.equal(removal.changed, true);
      assert.deepEqual(sources(f), ["second"]);
      assert.match(result.error?.message || "", /feed.*changed|no longer.*feed/iu);
      assert.equal(walks, 0);
    } else { assert.ifError(result.error); assert.equal(walks, 1); }
  });
}

test("removal during real load planning refuses or leaves only current legs runnable", async () => {
  const f = fixture(), runs = [];
  let pending, reached = 0;
  const result = await capture(() => cmdLoad(f.path, {
    lifecycleLockOptions: { machineLockRoot: f.machineLockRoot, restrictWindowsDirectory() {} },
    commands: { ingestLocal: async (_m, _path, flags) => { runs.push(flags.source); return { created: 0, complete: true }; } },
    log(line) { if (!reached && String(line).includes("starting")) { reached++; pending = capture(() => folder(f)); } },
  }));
  assert.equal(reached, 1, "load reached a non-empty planned source start");
  const removal = await pending;
  assert.ifError(result.error);
  if (removal.error) {
    assert.match(removal.error.message, /running|busy/iu);
    assert.deepEqual(sources(f), ["first", "second"]);
    assert.deepEqual(runs, ["first", "second"]);
  } else {
    assert.equal(removal.value.changed, true);
    assert.deepEqual(sources(f), ["second"]);
    assert.deepEqual(runs, ["second"]);
  }
  const stopped = await capture(() => folder(f));
  if (removal.error) { assert.ifError(stopped.error); assert.equal(stopped.value.changed, true); }
  runs.length = 0;
  const control = await capture(() => cmdLoad(f.path, {
    lifecycleLockOptions: { machineLockRoot: f.machineLockRoot, restrictWindowsDirectory() {} },
    commands: { ingestLocal: async (_m, _path, flags) => { runs.push(flags.source); return { created: 0, complete: true }; } }, log() {},
  }));
  assert.ifError(control.error);
  assert.deepEqual(runs, ["second"]);
});

for (const race of [false, true]) {
  test(`${race ? "peer removal" : "control"}: actual ingest CLI at source acquisition`, () => {
    const f = fixture();
    const child = spawnSync(process.execPath, ["--import", preload, entry, "ingest", f.path,
      "--path", join(f.root, "first"), "--source", "first", "--dry-run"], {
      env: { ...environment(f), FOLDER_CASE_ROOT: f.root, FOLDER_INGEST_RACE: race ? "1" : "0" },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const events = readFileSync(join(f.root, "ingest-boundary.txt"), "utf8").trim().split("\n");
    assert.equal(events.filter((x) => x === "source-lock-decision").length, 1);
    if (!race || events.includes("remove-refused")) {
      assert.equal(events.filter((x) => x === "feed-walk").length, 1);
      assert.deepEqual(sources(f), ["first", "second"]);
    } else {
      assert.ok(events.includes("remove-success"));
      assert.deepEqual(sources(f), ["second"]);
      assert.equal(events.filter((x) => x === "feed-walk").length, 0);
    }
    if (race) assert.ok(events.includes("remove-refused") || events.includes("remove-success"));
  });
}
