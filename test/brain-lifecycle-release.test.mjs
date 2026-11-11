import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmdirSync, mkdirSync, utimesSync, readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { acquireBrainLifecycleLock } from "../operations/brain-lifecycle-lock.mjs";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lock-release-"));
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, "{}");
  return { manifestPath, machineLockRoot: join(root, "locks"), operation: "update", platform: "win32", restrictWindowsDirectory() {} };
}

// Fixed seed 0x427b1 varies writer operations across the complete suspension/
// replacement-state table; every refusal has its own acquisition control.
let tableSeed = 0x427b1;
for (const phase of ["acl", "clock", "publication"]) for (const occupied of [true, false]) {
  tableSeed = (Math.imul(tableSeed, 1664525) + 1013904223) >>> 0;
  const operation = ["update", "load", "ingest", "daily-refresh"][tableSeed % 4];
  test(`publication identity table ${tableSeed}: ${phase}, occupied=${occupied}, ${operation}`, () => {
    const options = { ...fixture(), operation };
    let reached = 0, holder, published = 0, replacementPath;
    const replace = () => {
      reached++;
      const path = readdirSync(options.machineLockRoot).find(name => name.endsWith(".lock"));
      replacementPath = join(options.machineLockRoot, path);
      rmdirSync(join(options.machineLockRoot, path));
      holder = acquireBrainLifecycleLock(options);
      if (!occupied) { holder.release(); holder = null; mkdirSync(join(options.machineLockRoot, path)); }
    };
    try {
      assert.throws(() => acquireBrainLifecycleLock({ ...options,
        restrictWindowsDirectory() { if (phase === "acl") replace(); },
        now() { if (phase === "clock") replace(); return new Date(); },
        publishOwner(path, ...args) {
          if (phase === "publication") replace();
          writeFileSync(path, ...args); published++;
        },
      }), error => ["brain_lifecycle_lost", "brain_lifecycle_busy"].includes(error.code));
      assert.equal(reached, 1, "publication suspension decision reached");
      assert.equal(published, phase === "publication" && !occupied ? 1 : 0,
        "the empty replacement reaches the post-publication identity decision");
      if (holder) { assert.equal(holder.assertOwned(), true); assert.equal(holder.release(), true); holder = null; }
      else {
        if (published) {
          assert.equal(existsSync(replacementPath), false,
            "a rejected publication must not strand its own claim before the green control");
        } else rmdirSync(replacementPath);
      }
      const control = acquireBrainLifecycleLock(options);
      assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
    } finally { holder?.release(); }
  });
}

test("legacy named owner stays exclusive and can release before the new claim format", () => {
  const options = fixture();
  const holder = acquireBrainLifecycleLock(options);
  const ownerPath = join(holder.path, readdirSync(holder.path)[0]);
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  renameSync(ownerPath, join(holder.path, `owner-${owner.pid}-${owner.token}.json`));
  try {
    let reached = 0;
    assert.throws(() => acquireBrainLifecycleLock({ ...options, isOwnerAlive() { reached++; return true; } }),
      { code: "brain_lifecycle_busy" });
    assert.equal(reached, 1, "legacy ownership decision reached");
    assert.equal(holder.assertOwned(), true);
  } finally { assert.equal(holder.release(), true); }
  const control = acquireBrainLifecycleLock(options);
  assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
});

for (const phase of ["acl", "publication"]) test(`paused acquirer cannot publish into a replacement directory (two processes, ${phase})`, async () => {
  const options = fixture();
  const moduleUrl = new URL("../operations/brain-lifecycle-lock.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireBrainLifecycleLock } from ${JSON.stringify(moduleUrl)};
    import { writeFileSync, existsSync } from 'node:fs';
    import { dirname } from 'node:path';
    const options = JSON.parse(process.argv[1]);
    try {
      const pause = path => {
        writeFileSync(options.manifestPath + '.paused', path);
        while (!existsSync(options.manifestPath + '.resume'))
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      };
      const lock = acquireBrainLifecycleLock({ ...options,
        restrictWindowsDirectory(path) { if (process.argv[2] === 'acl') pause(path); },
        publishOwner(path, ...args) {
          if (process.argv[2] === 'publication') pause(dirname(path));
          writeFileSync(path, ...args);
        },
      });
      process.send({ acquired: true }); lock.release();
    } catch (error) { process.send({ acquired: false, code: error.code }); }
  `, JSON.stringify(options), phase], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
    env: Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP"].filter(k => process.env[k]).map(k => [k, process.env[k]])) });
  const { existsSync, readFileSync } = await import("node:fs");
  let holder;
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(options.manifestPath + ".paused")) {
      assert.ok(Date.now() < deadline, "child reached the post-mkdir pause");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const path = readFileSync(options.manifestPath + ".paused", "utf8");
    await new Promise(resolve => setTimeout(resolve, 11200));
    holder = acquireBrainLifecycleLock(options);
    assert.equal(holder.path, path);
    const result = new Promise((resolve, reject) => {
      child.once("message", resolve); child.once("error", reject);
      child.once("exit", () => reject(new Error("child exited without result")));
    });
    writeFileSync(options.manifestPath + ".resume", "resume");
    const outcome = await result;
    assert.equal(outcome.acquired, false, "resumed publication must refuse before returning a lease");
    assert.ok(["brain_lifecycle_lost", "brain_lifecycle_busy"].includes(outcome.code));
    assert.equal(readdirSync(path).length, 1);
    assert.equal(holder.assertOwned(), true);
    assert.equal(holder.release(), true); holder = null;
    const control = acquireBrainLifecycleLock(options);
    assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
  } finally { child.kill(); holder?.release(); }
});
for (const code of ["EPERM", "EBUSY", "ENOTEMPTY"]) {
  test(`release retries ${code} then immediately reacquires`, () => {
    const options = fixture();
    let attempts = 0, waited = 0;
    const lock = acquireBrainLifecycleLock({ ...options,
      removeDirectory(path) { if (++attempts <= 3) throw Object.assign(new Error("synthetic"), { code }); rmdirSync(path); },
      waitSync(ms) { waited += ms; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
    });
    assert.equal(lock.release(), true);
    assert.ok(attempts >= 4 && attempts <= 21);
    assert.ok(waited > 0 && waited <= 1000);
    const next = acquireBrainLifecycleLock(options);
    assert.equal(next.assertOwned(), true);
    assert.equal(next.release(), true);
  });
}
test("final rmdir failure is bounded and logged without raw errors", () => {
  const messages = []; let attempts = 0, waited = 0;
  const lock = acquireBrainLifecycleLock({ ...fixture(),
    removeDirectory() { attempts++; throw Object.assign(new Error("private synthetic detail"), { code: "EPERM" }); },
    waitSync(ms) { waited += ms; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }, log(message) { messages.push(message); },
  });
  assert.equal(lock.release(), false);
  assert.ok(attempts > 1 && attempts <= 21);
  assert.ok(waited > 0 && waited <= 1000);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /lifecycle lock.*release/i);
  assert.ok(!messages[0].includes("private synthetic detail"));
  rmdirSync(lock.path);
});
test("empty abandoned directory is reaped after ten seconds, fresh directory is protected", () => {
  const options = fixture();
  const first = acquireBrainLifecycleLock(options); const path = first.path;
  first.release(); mkdirSync(path);
  assert.throws(() => acquireBrainLifecycleLock(options), { code: "brain_lifecycle_busy" });
  const old = new Date(Date.now() - 11000); utimesSync(path, old, old);
  const next = acquireBrainLifecycleLock(options); next.release();
});
test("owned dead lock keeps the full stale window", () => {
  const options = fixture();
  const first = acquireBrainLifecycleLock(options);
  const old = new Date(Date.now() - 11000);
  utimesSync(join(first.path, readdirSync(first.path)[0]), old, old);
  try { assert.throws(() => acquireBrainLifecycleLock({ ...options, isOwnerAlive: () => false }), { code: "brain_lifecycle_busy" }); }
  finally { first.release(); }
});
test("native lock releases with the real bounded wait and reacquires", () => {
  const options = { ...fixture(), platform: process.platform };
  delete options.restrictWindowsDirectory;
  let attempts = 0;
  const first = acquireBrainLifecycleLock({ ...options, removeDirectory(path) {
    if (process.platform === "win32" && ++attempts === 1) {
      throw Object.assign(new Error("synthetic"), { code: "EBUSY" });
    }
    rmdirSync(path);
  } });
  assert.equal(first.release(), true);
  if (process.platform === "win32") assert.equal(attempts, 2);
  const next = acquireBrainLifecycleLock(options);
  assert.equal(next.assertOwned(), true);
  assert.equal(next.release(), true);
});
test("empty-directory recovery refuses when its exact recheck sees a change", () => {
  const options = fixture();
  const first = acquireBrainLifecycleLock(options); const path = first.path;
  first.release(); mkdirSync(path);
  const old = new Date(Date.now() - 11000); utimesSync(path, old, old);
  try {
    assert.throws(() => acquireBrainLifecycleLock({ ...options, now() {
      const changed = new Date(); utimesSync(path, changed, changed); return changed;
    } }), { code: "brain_lifecycle_busy" });
    assert.deepEqual(readdirSync(path), []);
  } finally { rmdirSync(path); }
});

// All shared lifecycle writer labels used by CLI, scheduler and connector
// entrypoints; the recovery rule itself is independent of operation names.
const writerOperations = Object.freeze([
  'update', 'load', 'ingest', 'daily-refresh', 'folder', 'daily-schedule',
  'quickbooks-desktop', 'quickbooks-refresh', 'quickbooks-schedule',
  'answer-setup', 'answer-setup-disconnect', 'bank-provider', 'curated-sync',
]);
// Seed 0x427c3 covers every writer and both observed-owner pause points.
let recoverySeed = 0x427c3;
for (const operation of writerOperations) for (const pauseAt of [1, 2]) for (const legacy of [false, true]) {
  recoverySeed = (Math.imul(recoverySeed, 1664525) + 1013904223) >>> 0;
  const rowSeed = recoverySeed;
  test(`overlapping stale recovery ${rowSeed}: ${operation}, pause ${pauseAt}, legacy=${legacy}`, () => {
    const options = { ...fixture(), operation, staleMs: 60000 };
    const abandoned = acquireBrainLifecycleLock(options);
    const old = new Date(Date.now() - 120000 - rowSeed % 10000);
    utimesSync(join(abandoned.path, 'owner.json'), old, old);
    if (legacy) {
      const owner = JSON.parse(readFileSync(join(abandoned.path, 'owner.json'), 'utf8'));
      renameSync(join(abandoned.path, 'owner.json'), join(abandoned.path, `owner-${owner.pid}-${owner.token}.json`));
    }
    let checks = 0, reached = 0, first, second, firstError, secondError;
    try {
      try { first = acquireBrainLifecycleLock({ ...options, isOwnerAlive() {
        checks++;
        if (checks === pauseAt) {
          reached++;
          try { second = acquireBrainLifecycleLock({ ...options, isOwnerAlive: () => false }); }
          catch (error) { secondError = error; }
        }
        return false;
      } }); } catch (error) { firstError = error; }
      assert.equal(reached, 1, 'stale recovery decision reached');
      assert.equal(existsSync(abandoned.path + '.recovery'), false, 'recovery guard was released');
      assert.equal(Number(Boolean(first)) + Number(Boolean(second)), 1, 'exactly one writer enters');
      assert.equal((first || second).assertOwned(), true, 'surviving holder stays owned');
      assert.equal((firstError || secondError).code, 'brain_lifecycle_busy');
    } finally { first?.release(); second?.release(); abandoned.release(); }
    const control = acquireBrainLifecycleLock(options);
    assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
  });
}

for (const operation of writerOperations) {
  test(`suspended recovery guard never expires for ${operation}`, () => {
    const options = { ...fixture(), operation, staleMs: 60000 };
    const abandoned = acquireBrainLifecycleLock(options);
    const old = new Date(Date.now() - 86400000);
    utimesSync(join(abandoned.path, 'owner.json'), old, old);
    const guard = abandoned.path + '.recovery';
    mkdirSync(guard); utimesSync(guard, old, old);
    let reached = 0;
    try {
      assert.throws(() => acquireBrainLifecycleLock({ ...options, isOwnerAlive() { reached++; return false; } }),
        { code: 'brain_lifecycle_busy' });
      assert.equal(reached, 1, 'stale owner reached the exclusive recovery decision');
      assert.equal(abandoned.assertOwned(), true);
    } finally { rmdirSync(guard); }
    const control = acquireBrainLifecycleLock({ ...options, isOwnerAlive: () => false });
    assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
    abandoned.release();
  });
}

for (const operation of writerOperations) {
  test(`stale recovery binds removal to directory identity for ${operation}`, () => {
    const options = { ...fixture(), operation, staleMs: 60000 };
    const abandoned = acquireBrainLifecycleLock(options);
    const old = new Date(Date.now() - 120000);
    utimesSync(join(abandoned.path, 'owner.json'), old, old);
    let reached = 0, holder;
    try {
      assert.throws(() => acquireBrainLifecycleLock({ ...options, isOwnerAlive() {
        if (++reached === 2) {
          // Model replacement by an older participant outside the new guard.
          renameSync(abandoned.path, abandoned.path + '.abandoned');
          holder = acquireBrainLifecycleLock(options);
        }
        return false;
      } }), { code: 'brain_lifecycle_lost' });
      assert.equal(reached, 2, 'final stale-owner decision reached');
      assert.equal(existsSync(abandoned.path + '.recovery'), false);
      assert.equal(holder.assertOwned(), true);
    } finally { holder?.release(); abandoned.release(); }
    const control = acquireBrainLifecycleLock(options);
    assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
  });
}
