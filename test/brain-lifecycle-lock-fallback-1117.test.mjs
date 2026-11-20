import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acquireBrainLifecycleLock, adoptParentBrainLifecycleLock, brainLifecycleCoordinates, clearBrainRecoveryFence,
  readBrainRecoveryFence, readBrainRecoveryFenceReadOnly, writeBrainRecoveryFence,
} from "../operations/brain-lifecycle-lock.mjs";
import { previewSupportJournal } from "../support-journal.mjs";
import { supportRecovery } from "../support-recovery.mjs";
import { restrictWindowsDirectoryToCurrentUser as fixtureAcl } from "./fixtures/lifecycle-lock-acl.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "lock-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  fs.mkdirSync(home);
  const manifestPath = join(root, "brain.manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ brain: { domain: "owner.invalid" } }));
  fs.writeFileSync(join(root, ".brain-admin-key"), ["fixture", "value"].join("-"), { mode: 0o600 });
  const environment = { ProgramData: join(root, "shared"), LOCALAPPDATA: join(home, "local") };
  const shared = join(environment.ProgramData, "FinancialBrain", "locks");
  const personal = join(environment.LOCALAPPDATA, "FinancialBrain", "locks");
  const calls = [], warnings = [], events = [], acls = [];
  const restrictWindowsDirectory = (path, options) => {
    acls.push(path);
    const saved = process.env.BRAIN_TEST_USER_ROOT;
    process.env.BRAIN_TEST_USER_ROOT = root;
    try { return fixtureAcl(path, options); }
    finally {
      if (saved === undefined) delete process.env.BRAIN_TEST_USER_ROOT;
      else process.env.BRAIN_TEST_USER_ROOT = saved;
    }
  };
  const fileSystem = {};
  for (const name of ["mkdirSync", "lstatSync", "readdirSync", "realpathSync", "existsSync", "openSync", "closeSync", "unlinkSync"]) {
    fileSystem[name] = (...args) => { calls.push([name, args[0]]); return fs[name](...args); };
  }
  const options = { manifestPath, platform: "win32", home,
    lockRootOptions: { environment, fileSystem, windowsAccountHome: home, log: line => warnings.push(line),
      recordEvent: (event, options) => { events.push({ event, options }); },
      restrictWindowsDirectory,
    },
    restrictWindowsDirectory,
  };
  const deny = (folder, method = "openSync", code = "EACCES") => {
    const original = fileSystem[method];
    fileSystem[method] = (...args) => {
      if (args[0] === folder || String(args[0]).startsWith(folder + "/") || String(args[0]).startsWith(folder + "\\")) {
        calls.push([method, folder, code]);
        throw Object.assign(new Error("synthetic private detail"), { code });
      }
      return original(...args);
    };
  };
  return { root, home, manifestPath, environment, shared, personal, calls, warnings, events, acls, options, deny };
}

for (const locator of ["home", "HOME", "USERPROFILE"]) {
  test(`native Windows account slots honor the isolated ${locator} locator`, t => {
    const f = fixture(t);
    const options = { ...f.options, home: locator === "home" ? f.home : undefined,
      lockRootOptions: { ...f.options.lockRootOptions, windowsAccountHome: undefined,
        environment: { ...f.environment, [locator]: f.home } } };
    const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform");
    let escaped = 0, parent, child;
    const lstat = options.lockRootOptions.fileSystem.lstatSync;
    options.lockRootOptions.fileSystem.lstatSync = (path, ...args) => {
      // Permit ancestor inspection, but stop before even reading a host slot.
      const inside = (root, target) => {
        const suffix = relative(root, String(target));
        return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
      };
      if (!inside(f.root, path) && !inside(String(path), f.root)) {
        escaped++;
        throw Object.assign(new Error("fixture account root escaped"), { code: "EACCES" });
      }
      return lstat(path, ...args);
    };
    Object.defineProperty(process, "platform", { ...nativePlatform, value: "win32" });
    try {
      parent = acquireBrainLifecycleLock({ ...options, operation: "update" });
      const accountRoot = fs.realpathSync(join(f.home, "AppData", "Local", "FinancialBrain", "account-locks"));
      assert.equal(parent.accountPath, join(accountRoot, basename(parent.path)));
      assert.equal(escaped, 0, "the native-profile branch stayed inside the declared home");
      let decisions = 0;
      assert.throws(() => acquireBrainLifecycleLock({ ...options, operation: "load",
        machineLockRoot: join(f.root, "other-locks"),
        isOwnerAlive() { decisions++; return true; },
      }), { code: "brain_lifecycle_busy" });
      assert.equal(decisions, 1, "the contender reached the same account-slot owner");
      assert.equal(parent.assertOwned(), true, "the refused contender preserves the holder");
      child = adoptParentBrainLifecycleLock({ ...options, parentPid: process.pid,
        delegation: parent.childDelegation(), isOwnerAlive: () => true });
      assert.equal(child.accountPath, parent.accountPath, "handoff resolves the same isolated account slot");
      assert.equal(child.assertOwned(), true);
      child.release();
      const control = acquireBrainLifecycleLock({ ...options, operation: "load" });
      assert.equal(control.assertOwned(), true, "the real writer succeeds after the prior lease releases");
      control.release();
    } finally {
      child?.release(); parent?.release();
      Object.defineProperty(process, "platform", nativePlatform);
    }
  });
}

for (const platform of ["darwin", "linux"]) test(`${platform} acquisition keeps its selected-root permission contract`, t => {
  const f = fixture(t), root = join(f.root, "posix-root");
  let inspected = 0;
  const fileSystem = { ...fs, lstatSync(path, ...args) {
    const state = fs.lstatSync(path, ...args);
    if (path !== root) return state;
    inspected++;
    // NTFS cannot represent the POSIX sticky bit. The released mutating path
    // required writable readback; read-only preview has its own stricter check.
    return Object.assign(Object.create(Object.getPrototypeOf(state)), state, { mode: state.mode & ~0o1000 });
  } };
  const options = { manifestPath: f.manifestPath, platform, machineLockRoot: root,
    lockRootOptions: { fileSystem } };
  const lease = acquireBrainLifecycleLock({ ...options, operation: "update" });
  try {
    assert.equal(lease.assertOwned(), true);
    assert.equal(readBrainRecoveryFence(options), null, "mutating lookup keeps the released selected-root contract");
    const before = inspected;
    assert.throws(() => readBrainRecoveryFenceReadOnly(options), { code: "brain_lifecycle_unsafe" });
    assert.ok(inspected > before, "read-only lookup still reaches and rejects the missing sticky bit");
  } finally { lease.release(); }
  const control = acquireBrainLifecycleLock({ ...options, operation: "load" });
  assert.equal(control.assertOwned(), true, "an ordinary writer retains the same selected-root contract");
  control.release();
});

// Patch the existing fs boundary for this first probe as well as supplying the
// new dependency seam: the released path must really encounter EACCES.
test("Windows shared-root creation permission failure uses the per-user root", t => {
  const f = fixture(t);
  const original = fs.mkdirSync;
  const saved = Object.fromEntries(["ProgramData", "LOCALAPPDATA", "BRAIN_LIFECYCLE_LOCK_ROOT"].map(k => [k, process.env[k]]));
  let reached = 0;
  fs.mkdirSync = (path, ...args) => {
    if (path === f.shared) { reached++; throw Object.assign(new Error("synthetic"), { code: "EACCES" }); }
    return original(path, ...args);
  };
  Object.assign(process.env, f.environment);
  delete process.env.BRAIN_LIFECYCLE_LOCK_ROOT;
  syncBuiltinESMExports();
  try {
    const result = brainLifecycleCoordinates(f.options);
    assert.equal(result.root, fs.realpathSync(f.personal));
    assert.equal(result.rootKind, "per-user");
    assert.equal(reached, 1, "real shared-root mkdir permission decision reached");
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /BRAIN_LOCK_FOLDER_PER_USER/);
    assert.equal(f.events[0].event.errorCode, "BRAIN_LOCK_FOLDER_PER_USER");
  } finally {
    fs.mkdirSync = original; syncBuiltinESMExports();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

for (const method of ["mkdirSync", "lstatSync", "readdirSync", "openSync"]) for (const code of ["EACCES", "EPERM"]) {
  test(`Windows ${method} ${code} falls back with one warning and a metadata-only journal event`, t => {
    const f = fixture(t); f.deny(f.shared, method, code);
    const first = brainLifecycleCoordinates(f.options);
    const second = brainLifecycleCoordinates(f.options);
    assert.equal(first.root, fs.realpathSync(f.personal));
    assert.equal(second.root, first.root);
    assert.equal(first.identity, second.identity);
    assert.ok(f.calls.some(call => call[2] === code), "permission decision reached");
    assert.equal(f.warnings.length, 1, "one plain warning per selected root per process");
    assert.match(f.warnings[0], /https:\/\/financialbrain\.ai\/help\/BRAIN_LOCK_FOLDER_PER_USER/);
    assert.match(f.warnings[0], /another Windows account/i);
    assert.ok(!f.warnings[0].includes(f.root));
    assert.equal(f.events.length, 1);
    assert.deepEqual(f.events[0].event, { command: "update", source: "installer", errorCode: "BRAIN_LOCK_FOLDER_PER_USER" });
    assert.ok(f.acls.includes(f.personal), "fallback root receives a current-user ACL");
  });
}

test("working shared root wins, leaves no probe residue and emits no warning", t => {
  const f = fixture(t);
  const result = brainLifecycleCoordinates(f.options);
  assert.equal(result.root, fs.realpathSync(f.shared));
  assert.equal(result.rootKind, "shared");
  assert.ok(f.calls.some(([method]) => method === "openSync"), "shared write probe reached");
  assert.deepEqual(fs.readdirSync(f.shared), []);
  assert.equal(fs.existsSync(f.personal), false);
  assert.deepEqual(f.warnings, []); assert.deepEqual(f.events, []);
});

for (const kind of ["symlink", "file", "parent-link"]) test(`unsafe ${kind} shared root selects a safe private root without following links`, t => {
  const f = fixture(t);
  fs.mkdirSync(join(f.environment.ProgramData, "FinancialBrain"), { recursive: true });
  const target = join(f.root, "target"); fs.mkdirSync(target);
  if (kind === "file") fs.writeFileSync(f.shared, "fixture");
  else if (kind === "parent-link") {
    fs.rmdirSync(join(f.environment.ProgramData, "FinancialBrain"));
    fs.symlinkSync(target, join(f.environment.ProgramData, "FinancialBrain"), "junction");
  } else fs.symlinkSync(target, f.shared, "junction");
  assert.equal(brainLifecycleCoordinates(f.options).rootKind, "per-user");
  assert.ok(f.calls.some(([method]) => method === "lstatSync"), "unsafe root inspection reached");
  assert.deepEqual(fs.readdirSync(target), [], "unsafe shared target is never followed or changed");
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /Do not run an older Brain tool at the same time/);
  if (kind === "parent-link") fs.unlinkSync(join(f.environment.ProgramData, "FinancialBrain"));
  else fs.unlinkSync(f.shared);
  const control = brainLifecycleCoordinates(f.options);
  assert.equal(control.rootKind, "shared");
});

test("explicit environment override wins and is never silently replaced", t => {
  const f = fixture(t), override = join(f.root, "override");
  f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = override;
  f.deny(f.shared);
  assert.equal(brainLifecycleCoordinates(f.options).root, fs.realpathSync(override));
  assert.ok(f.calls.some(([, path]) => path === override), "override was inspected");
  assert.equal(fs.existsSync(f.shared), false);
  f.deny(override);
  assert.throws(() => brainLifecycleCoordinates(f.options), { code: "BRAIN_LOCK_FOLDER_UNUSABLE" });
  assert.equal(fs.existsSync(f.personal), false);
  assert.equal(f.warnings.length, 0);
});

test("two unusable folders stop with both placeholders and the fix link", t => {
  const f = fixture(t); f.deny(f.shared); f.deny(f.personal);
  assert.throws(() => brainLifecycleCoordinates(f.options), error => {
    assert.equal(error.code, "BRAIN_LOCK_FOLDER_UNUSABLE");
    assert.ok(error.message.includes("%ProgramData%\\FinancialBrain\\locks"));
    assert.ok(error.message.includes("%LOCALAPPDATA%\\FinancialBrain\\locks"));
    assert.match(error.message, /https:\/\/financialbrain\.ai\/help\/BRAIN_LOCK_FOLDER_UNUSABLE/);
    assert.ok(!error.message.includes(f.root));
    assert.ok(!error.message.includes("synthetic private detail"));
    return true;
  });
  assert.ok(f.calls.some(call => call[1] === f.shared && call[2]), "shared denial reached");
  assert.ok(f.calls.some(call => call[1] === f.personal && call[2]), "per-user denial reached");
  assert.equal(f.warnings.length, 0);
  f.options.lockRootOptions.fileSystem = fs;
  assert.equal(brainLifecycleCoordinates(f.options).rootKind, "shared", "working shared folder is the green control");
});

for (const platform of ["darwin", "linux"]) test(`${platform} never falls back on a permission error`, t => {
  const f = fixture(t); f.options.platform = platform; f.options.machineLockRoot = f.shared;
  f.deny(f.shared, "mkdirSync");
  assert.throws(() => brainLifecycleCoordinates(f.options), { code: "EACCES" });
  assert.ok(f.calls.some(call => call[2] === "EACCES"), "non-Windows permission decision reached");
  assert.equal(fs.existsSync(f.personal), false); assert.equal(f.warnings.length, 0);
  f.options.lockRootOptions.fileSystem = fs;
  assert.equal(brainLifecycleCoordinates(f.options).root, fs.realpathSync(f.shared));
});

test("same Brain uses the same lock and recovery names across roots and retains writer exclusion", t => {
  const f = fixture(t);
  const shared = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  const sharedName = basename(shared.path); assert.equal(shared.release(), true);
  f.deny(f.shared);
  const first = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  try {
    assert.equal(basename(first.path), sharedName);
    assert.equal(first.rootKind, "per-user");
    assert.equal(first.root, fs.realpathSync(f.personal));
    let reached = 0;
    assert.throws(() => acquireBrainLifecycleLock({ ...f.options, operation: "load", isOwnerAlive() { reached++; return true; } }), { code: "brain_lifecycle_busy" });
    assert.equal(reached, 1, "same-root owner contention decision reached");
    const transactionId = "a".repeat(32);
    const fence = writeBrainRecoveryFence({ ...f.options, transactionId });
    const identity = brainLifecycleCoordinates(f.options).identity;
    assert.equal(basename(fence.path), `brain-update-recovery-${identity}.json`);
    assert.equal(readBrainRecoveryFence(f.options).transaction_id, transactionId);
    const before = f.calls.length;
    assert.equal(readBrainRecoveryFenceReadOnly(f.options).transaction_id, transactionId);
    assert.ok(f.calls.slice(before).every(([method]) => !["mkdirSync", "openSync", "unlinkSync"].includes(method)), "preview never writes or probes");
    assert.equal(clearBrainRecoveryFence({ ...f.options, transactionId }), true);
  } finally { first.release(); }
  const next = acquireBrainLifecycleLock({ ...f.options, operation: "load" });
  assert.equal(basename(next.path), sharedName); assert.equal(next.release(), true);
  assert.equal(f.warnings.length, 1);
});

test("fallback warning is really persisted by the support journal without paths", t => {
  const f = fixture(t); f.deny(f.shared);
  delete f.options.lockRootOptions.recordEvent;
  brainLifecycleCoordinates(f.options);
  const journal = previewSupportJournal({ root: f.home }).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].error_code, "BRAIN_LOCK_FOLDER_PER_USER");
  assert.ok(!JSON.stringify(journal).includes(f.root));
  for (const code of ["BRAIN_LOCK_FOLDER_PER_USER", "BRAIN_LOCK_FOLDER_UNUSABLE"]) {
    assert.equal(supportRecovery(code).code, code);
  }
});


test("Windows update keeps the folder code and placeholders in its owner message", async t => {
  const f = fixture(t);
  const { cmdUpdate, supportErrorCode } = await import("../brain.mjs");
  let reached = 0;
  f.deny(f.shared); f.deny(f.personal);
  await assert.rejects(cmdUpdate(f.manifestPath, { platform: "win32",
    withBrainLifecycleLockWait(options) {
      reached++;
      return acquireBrainLifecycleLock({ ...options, ...f.options });
    },
  }), error => {
    assert.equal(supportErrorCode(error, { command: "update" }), "BRAIN_LOCK_FOLDER_UNUSABLE");
    assert.match(error.ownerMessage, /BRAIN_LOCK_FOLDER_UNUSABLE/);
    assert.match(error.ownerMessage, /%ProgramData%/);
    assert.match(error.ownerMessage, /%LOCALAPPDATA%/);
    return true;
  });
  assert.equal(reached, 1, "real update wrapper reached the failing lock resolver");
  f.options.lockRootOptions.fileSystem = fs;
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.assertOwned(), true); control.release();
});


test("a repaired shared root cannot bypass this user's active fallback lease", t => {
  const f = fixture(t); f.deny(f.shared);
  const holder = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  f.options.lockRootOptions.fileSystem = fs;
  let refused = 0, contender;
  try {
    assert.throws(() => { contender = acquireBrainLifecycleLock({ ...f.options, operation: "load" }); }, error => {
      refused++;
      return error.code === "brain_lifecycle_busy";
    });
    assert.equal(refused, 1, "alternate-root lease decision reached");
    assert.equal(holder.assertOwned(), true);
  } finally { contender?.release(); holder.release(); }
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "load" });
  assert.equal(control.rootKind, "shared"); control.release();
});

test("a repaired shared root cannot hide this user's fallback recovery fence", t => {
  const f = fixture(t); f.deny(f.shared);
  const transactionId = "b".repeat(32);
  const fallback = writeBrainRecoveryFence({ ...f.options, transactionId });
  f.options.lockRootOptions.fileSystem = fs;
  assert.equal(readBrainRecoveryFenceReadOnly(f.options).path, fallback.path);
  let refused = 0;
  assert.throws(() => acquireBrainLifecycleLock({ ...f.options, operation: "load" }), error => {
    refused++;
    return error.code === "brain_lifecycle_recovery_required";
  });
  assert.equal(refused, 1, "alternate-root recovery decision reached");
  assert.equal(clearBrainRecoveryFence({ ...f.options, transactionId }), true);
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "load" });
  assert.equal(control.assertOwned(), true); control.release();
});


test("an unsafe shared parent is never followed when selecting the private root", t => {
  const f = fixture(t);
  fs.mkdirSync(f.environment.ProgramData, { recursive: true });
  const target = join(f.root, "target"); fs.mkdirSync(target);
  fs.symlinkSync(target, join(f.environment.ProgramData, "FinancialBrain"), "junction");
  f.deny(f.shared, "lstatSync");
  assert.equal(brainLifecycleCoordinates(f.options).rootKind, "per-user");
  assert.ok(f.calls.some(([method, path]) => method === "lstatSync" && path === join(f.environment.ProgramData, "FinancialBrain")), "parent safety decision reached");
  assert.deepEqual(fs.readdirSync(target), [], "unsafe parent target stays untouched");
  assert.ok(!f.calls.some(([method, path]) => method === "mkdirSync" && path === f.shared), "unsafe shared path is never created through the link");
  assert.equal(f.warnings.length, 1);
  fs.unlinkSync(join(f.environment.ProgramData, "FinancialBrain"));
  f.options.lockRootOptions.fileSystem = fs;
  assert.equal(brainLifecycleCoordinates(f.options).rootKind, "shared");
});


for (const platform of ["darwin", "linux"]) test(`${platform} keeps the existing read-only absent-root decision`, t => {
  const f = fixture(t); f.options.platform = platform; f.options.machineLockRoot = f.shared;
  let reached = 0;
  f.options.lockRootOptions.fileSystem.existsSync = () => { reached++; return false; };
  f.deny(f.shared, "lstatSync");
  assert.equal(readBrainRecoveryFenceReadOnly(f.options), null);
  assert.equal(reached, 1, "released POSIX existence decision reached");
  f.options.lockRootOptions.fileSystem = fs;
  brainLifecycleCoordinates(f.options);
  assert.equal(readBrainRecoveryFenceReadOnly(f.options), null, "a readable empty root is the green control");
});


test("an unsafe private fallback also stops with the unusable-folder code", t => {
  const f = fixture(t); f.deny(f.shared);
  fs.mkdirSync(join(f.environment.LOCALAPPDATA, "FinancialBrain"), { recursive: true });
  const target = join(f.root, "target"); fs.mkdirSync(target);
  fs.symlinkSync(target, f.personal, "junction");
  assert.throws(() => brainLifecycleCoordinates(f.options), { code: "BRAIN_LOCK_FOLDER_UNUSABLE" });
  assert.ok(f.calls.some(([method, path]) => method === "lstatSync" && path === f.personal), "private-folder safety decision reached");
  assert.equal(f.warnings.length, 0);
  fs.unlinkSync(f.personal);
  assert.equal(brainLifecycleCoordinates(f.options).rootKind, "per-user", "a safe private folder is the green control");
});


// Keep the shared lease alive while the same account loses shared-root access.
// The callback count distinguishes contention from an unrelated preflight stop.
test("one Windows account cannot enter a second update after shared access is revoked", async t => {
  const f = fixture(t);
  const { cmdUpdate, supportErrorCode } = await import("../brain.mjs");
  const holder = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  f.deny(f.shared, "lstatSync");
  let decisions = 0, entered = 0, contender;
  try {
    await assert.rejects(cmdUpdate(f.manifestPath, { platform: "win32",
      async withBrainLifecycleLockWait(options, task) {
        contender = acquireBrainLifecycleLock({ ...options, ...f.options,
          isOwnerAlive() { decisions++; return true; } });
        entered++;
        throw Object.assign(new Error("synthetic update callback entered"), { code: "UNEXPECTED_UPDATE_CALLBACK" });
      },
    }), error => {
      assert.equal(supportErrorCode(error, { command: "update" }), "UPDATE_BRAIN_BUSY");
      assert.match(error.ownerMessage, /UPDATE_BRAIN_BUSY/);
      assert.match(error.ownerMessage, /https:\/\/financialbrain\.ai\/help\/UPDATE_BRAIN_BUSY/);
      return true;
    });
    assert.ok(f.calls.some(([method, path, code]) => method === "lstatSync" && path === f.shared && code === "EACCES"), "revoked shared-access boundary reached");
    assert.equal(decisions, 1, "common account-holder decision reached");
    assert.equal(entered, 0, "second update callback never started");
    assert.equal(holder.assertOwned(), true);
  } finally { contender?.release(); holder.release(); }
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.rootKind, "per-user"); assert.equal(control.release(), true);
});

// Seeded row order and clock. Cross every owner-liveness/recovery state with
// both permission directions, rather than accepting uniformly busy outcomes.
let accountSeed = 0x111708;
for (const state of ["live", "stale-live", "fresh-dead", "stale-dead"])
for (const firstPrivate of [false, true]) {
  accountSeed = (Math.imul(accountSeed, 1664525) + 1013904223) >>> 0;
  const row = accountSeed;
  test(`account lease table ${row}: ${state}, private-first=${firstPrivate}`, t => {
    const f = fixture(t), clock = new Date("2035-01-01T00:00:00.000Z");
    const denialCode = row & 1 ? "EACCES" : "EPERM";
    if (firstPrivate) f.deny(f.shared, "lstatSync", denialCode);
    const holder = acquireBrainLifecycleLock({ ...f.options, operation: "update", now: () => clock });
    const age = (state.startsWith("stale") ? 120000 : 1000) + row % 1000;
    for (const path of new Set([holder.path, holder.accountPath].filter(Boolean))) {
      fs.utimesSync(join(path, "owner.json"), new Date(clock.getTime() - age), new Date(clock.getTime() - age));
    }
    if (firstPrivate) f.options.lockRootOptions.fileSystem = fs;
    else f.deny(f.shared, "lstatSync", denialCode);
    let decisions = 0, next;
    const attempt = () => { next = acquireBrainLifecycleLock({ ...f.options, operation: "update",
      staleMs: 60000, now: () => clock, isOwnerAlive() { decisions++; return !state.endsWith("dead"); } }); };
    try {
      if (state === "stale-dead") {
        attempt(); assert.equal(next.assertOwned(), true);
        assert.throws(() => holder.assertOwned(), { code: "brain_lifecycle_lost" });
      } else {
        assert.throws(attempt, { code: "brain_lifecycle_busy" });
        assert.equal(holder.assertOwned(), true);
      }
      assert.ok(decisions >= 1, "account owner liveness/recovery decision reached");
    } finally { next?.release(); holder.release(); }
    const control = acquireBrainLifecycleLock({ ...f.options, operation: "update", now: () => clock });
    assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
  });
}

test("two Windows accounts retain independent fallback boundaries and shared exclusion", t => {
  const first = fixture(t), second = fixture(t);
  // Both manifests identify the same Brain, but OS profiles are distinct.
  second.environment.ProgramData = first.environment.ProgramData;
  second.shared = first.shared;
  first.deny(first.shared, "lstatSync"); second.deny(second.shared, "lstatSync");
  const a = acquireBrainLifecycleLock({ ...first.options, operation: "update" });
  const b = acquireBrainLifecycleLock({ ...second.options, operation: "update" });
  try {
    assert.notEqual(a.accountPath, b.accountPath);
    assert.equal(a.assertOwned(), true); assert.equal(b.assertOwned(), true);
  } finally { a.release(); b.release(); }
  first.options.lockRootOptions.fileSystem = fs; second.options.lockRootOptions.fileSystem = fs;
  const shared = acquireBrainLifecycleLock({ ...first.options, operation: "update" });
  let reached = 0;
  try {
    assert.throws(() => acquireBrainLifecycleLock({ ...second.options, operation: "update",
      isOwnerAlive() { reached++; return true; } }), { code: "brain_lifecycle_busy" });
    assert.equal(reached, 1, "cross-account shared-slot decision reached");
  } finally { shared.release(); }
  const privateAcl = second.options.restrictWindowsDirectory;
  second.options.restrictWindowsDirectory = (path, options) => path.startsWith(first.shared)
    ? first.options.restrictWindowsDirectory(path, options) : privateAcl(path, options);
  const control = acquireBrainLifecycleLock({ ...second.options, operation: "update" });
  assert.equal(control.release(), true);
});

function childArm(f, denyShared) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/brain-account-lock-child.mjs", import.meta.url)),
    JSON.stringify({ manifestPath: f.manifestPath, home: f.home, environment: f.environment, denyShared })],
  { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { HOME: f.home, BRAIN_NO_WRANGLER_LOGIN: "1" } });
  const queue = [], waiters = [];
  child.on("message", value => { if (waiters.length) waiters.shift()(value); else queue.push(value); });
  child.on("error", () => { for (const resolve of waiters.splice(0)) resolve({ kind: "child-error" }); });
  return { child, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)) };
}

for (const denied of [false, true]) test(`racing same-account updates publish one lease, split-access=${denied}`, { timeout: 15000 }, async t => {
  const f = fixture(t), a = childArm(f, false), b = childArm(f, denied);
  t.after(() => { a.child.kill(); b.child.kill(); });
  assert.equal((await a.next()).kind, "ready"); assert.equal((await b.next()).kind, "ready");
  a.child.send("acquire"); b.child.send("acquire");
  const results = await Promise.all([a.next(), b.next()]);
  assert.deepEqual(results.map(result => result.kind).sort(), ["acquired", "busy"]);
  const loser = results.find(result => result.kind === "busy");
  assert.ok(loser.decisions + loser.collisions > 0, "contender reached the exclusive account slot");
  assert.match(loser.message, /https:\/\/financialbrain\.ai\/help\/UPDATE_BRAIN_BUSY/);
  const winner = results[0].kind === "acquired" ? a : b;
  winner.child.send("release"); assert.equal((await winner.next()).kind, "released");
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.assertOwned(), true); control.release();
});

test("unsafe explicit override keeps a provider-free folder code in real update rendering", async t => {
  const f = fixture(t);
  const { cmdUpdate, supportErrorCode } = await import("../brain.mjs");
  fs.mkdirSync(f.environment.ProgramData, { recursive: true });
  const target = join(f.root, "target"); fs.mkdirSync(target);
  const parent = join(f.environment.ProgramData, "FinancialBrain");
  fs.symlinkSync(target, parent, "junction");
  // R3 permits an unusable default shared boundary to continue privately.
  // An unsafe explicit selected folder still stops with its exact guidance.
  f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = parent;
  let reached = 0, entered = 0;
  await assert.rejects(cmdUpdate(f.manifestPath, { platform: "win32",
    async withBrainLifecycleLockWait(options, task) {
      reached++;
      const lock = acquireBrainLifecycleLock({ ...options, ...f.options });
      try { entered++; return await task(); } finally { lock.release(); }
    },
  }), error => {
    assert.equal(supportErrorCode(error, { command: "update" }), "BRAIN_LOCK_FOLDER_UNUSABLE");
    assert.match(error.ownerMessage, /BRAIN_LOCK_FOLDER_UNUSABLE/);
    assert.match(error.ownerMessage, /https:\/\/financialbrain\.ai\/help\/BRAIN_LOCK_FOLDER_UNUSABLE/);
    assert.match(error.ownerMessage, /links|junctions|real directory/);
    assert.doesNotMatch(error.ownerMessage, /Cloudflare|Google|provider|synthetic|target|home/);
    assert.ok(!error.ownerMessage.includes(f.root));
    return true;
  });
  assert.equal(reached, 1); assert.equal(entered, 0);
  assert.ok(f.calls.some(([method, path]) => method === "lstatSync" && path === parent), "unsafe ancestor decision reached");
  assert.equal(fs.existsSync(f.personal), false, "no private fallback was attempted");
  fs.unlinkSync(parent);
  delete f.environment.BRAIN_LIFECYCLE_LOCK_ROOT;
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.rootKind, "shared"); control.release();
});


for (const drift of ["local-locator", "override"]) test(`one account boundary survives ${drift} changes`, t => {
  const f = fixture(t); f.deny(f.shared, "lstatSync");
  const holder = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  if (drift === "local-locator") f.environment.LOCALAPPDATA = join(f.home, "other-local");
  else f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = join(f.root, "explicit");
  let reached = 0;
  try {
    assert.throws(() => acquireBrainLifecycleLock({ ...f.options, operation: "update",
      isOwnerAlive() { reached++; return true; } }), { code: "brain_lifecycle_busy" });
    assert.equal(reached, 1, "OS-profile account decision reached despite locator drift");
    assert.equal(holder.assertOwned(), true);
  } finally { holder.release(); }
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.assertOwned(), true); control.release();
});

test("a crashed process keeps its account lease until the proven-dead stale window", { timeout: 15000 }, async t => {
  const f = fixture(t), arm = childArm(f, false);
  t.after(() => arm.child.kill());
  assert.equal((await arm.next()).kind, "ready");
  arm.child.send("acquire");
  const result = await arm.next(); assert.equal(result.kind, "acquired");
  const exited = new Promise(resolve => arm.child.once("exit", resolve));
  arm.child.kill("SIGKILL"); await exited;
  const clock = new Date("2035-01-01T00:00:00.000Z");
  const paths = [result.path, result.accountPath];
  for (const path of paths) fs.utimesSync(join(path, "owner.json"), clock, clock);
  let checks = 0;
  const options = { ...f.options, operation: "update", staleMs: 60000,
    now: () => clock, isOwnerAlive(pid) {
      checks++; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
    } };
  assert.throws(() => acquireBrainLifecycleLock(options), { code: "brain_lifecycle_busy" });
  assert.equal(checks, 1, "actual crashed PID was checked before refusing a fresh lease");
  const old = new Date(clock.getTime() - 120000);
  for (const path of paths) fs.utimesSync(join(path, "owner.json"), old, old);
  const control = acquireBrainLifecycleLock(options);
  assert.ok(checks >= 5, "both account and data slots needed exact dead-owner rechecks");
  assert.equal(control.assertOwned(), true); control.release();
});

test("handoff retains both occupied slots when shared access changes", t => {
  const f = fixture(t); f.deny(f.shared, "lstatSync");
  const parent = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  f.options.lockRootOptions.fileSystem = fs;
  let child, checks = 0;
  try {
    const delegation = parent.childDelegation();
    assert.ok(delegation.coordinates.root && delegation.account.coordinates.root, "both occupied coordinates were reached before the tampered-binding refusal");
    assert.throws(() => adoptParentBrainLifecycleLock({ ...f.options, parentPid: process.pid,
      delegation: { ...delegation, coordinates: { ...delegation.coordinates, identity: "0".repeat(32) } } }),
    { code: "brain_lifecycle_lost" });
    assert.equal(parent.assertOwned(), true, "invalid binding preserves the parent control");
    child = adoptParentBrainLifecycleLock({ ...f.options, parentPid: process.pid, delegation });
    assert.equal(child.path, parent.path); assert.equal(child.accountPath, parent.accountPath);
    assert.equal(parent.release(), false, "old tokens cannot release either transferred slot");
    assert.equal(child.assertOwned(), true);
    assert.throws(() => acquireBrainLifecycleLock({ ...f.options, operation: "update",
      isOwnerAlive() { checks++; return true; } }), { code: "brain_lifecycle_busy" });
    assert.equal(checks, 1, "contender reached the child's retained account slot");
  } finally { child?.release(); parent.release(); }
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.rootKind, "shared"); control.release();
});

test("an older parent without coordinate fields can transfer its exact occupied slot", t => {
  const f = fixture(t);
  const parent = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  const delegation = parent.childDelegation();
  delete delegation.coordinates; delete delegation.account;
  // Model the prior published format, which owned only the selected-root slot.
  fs.unlinkSync(join(parent.accountPath, "owner.json")); fs.rmdirSync(parent.accountPath);
  let child, reached = 0;
  try {
    const before = f.calls.length;
    assert.throws(() => adoptParentBrainLifecycleLock({ ...f.options, parentPid: process.pid,
      delegation: { ...delegation, token: "0".repeat(32) }, isOwnerAlive() { reached++; return true; } }),
    { code: "brain_lifecycle_lost" });
    assert.ok(f.calls.length > before, "legacy account-root validation reached before the wrong-token refusal");
    child = adoptParentBrainLifecycleLock({ ...f.options, parentPid: process.pid, delegation,
      isOwnerAlive() { reached++; return true; } });
    assert.ok(reached > 0, "legacy parent ownership was verified before transfer");
    assert.equal(child.assertOwned(), true);
    assert.equal(child.path, parent.path);
  } finally { child?.release(); parent.release(); }
});


for (const unsafe of [false, true]) test(`unusable account boundary fails closed, unsafe=${unsafe}`, t => {
  const f = fixture(t), root = join(f.home, "AppData", "Local", "FinancialBrain", "account-locks");
  if (unsafe) {
    fs.mkdirSync(join(root, ".."), { recursive: true });
    const target = join(f.root, "target"); fs.mkdirSync(target);
    fs.symlinkSync(target, root, "junction");
  } else f.deny(root, "lstatSync");
  let publications = 0;
  assert.throws(() => acquireBrainLifecycleLock({ ...f.options, operation: "update",
    publishOwner(...args) { publications++; return fs.writeFileSync(...args); } }), error => {
    assert.equal(error.code, "BRAIN_LOCK_FOLDER_UNUSABLE");
    assert.match(error.message, /Windows user profile/);
    assert.match(error.message, /account-locks/);
    assert.match(error.message, /https:\/\/financialbrain\.ai\/help\/BRAIN_LOCK_FOLDER_UNUSABLE/);
    assert.ok(!error.message.includes(f.root));
    return true;
  });
  assert.ok(f.calls.some(([method, path]) => method === "lstatSync" && path === root), "account-root safety/access decision reached");
  assert.equal(publications, 0, "neither slot was published after the account-root stop");
  if (unsafe) fs.unlinkSync(root); else f.options.lockRootOptions.fileSystem = fs;
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.assertOwned(), true); control.release();
});

test("the same account can update distinct Brains without a global mutex", t => {
  const f = fixture(t), secondManifest = join(f.root, "second.manifest.json");
  fs.writeFileSync(secondManifest, JSON.stringify({ brain: { domain: "second.invalid" } }));
  const first = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  const second = acquireBrainLifecycleLock({ ...f.options, manifestPath: secondManifest, operation: "update" });
  try {
    assert.notEqual(first.accountPath, second.accountPath);
    assert.equal(first.assertOwned(), true); assert.equal(second.assertOwned(), true);
  } finally { first.release(); second.release(); }
});

test("unrelated Windows readiness failures keep their existing owner rendering", async t => {
  const f = fixture(t), { cmdUpdate } = await import("../brain.mjs");
  let reached = 0;
  await assert.rejects(cmdUpdate(f.manifestPath, { platform: "win32",
    withBrainLifecycleLockWait() {
      reached++;
      throw Object.assign(new Error("synthetic readiness detail"), { supportCode: "UPDATE_BRAIN_BUSY" });
    },
  }), error => {
    assert.match(error.ownerMessage, /The Brain still has work in progress/);
    assert.doesNotMatch(error.ownerMessage, /synthetic readiness detail/);
    return true;
  });
  assert.equal(reached, 1, "the unrelated readiness failure reached the update wrapper");
  await assert.rejects(cmdUpdate(f.manifestPath, { platform: "win32",
    withBrainLifecycleLockWait() {
      reached++;
      throw Object.assign(new Error("UPDATE_BRAIN_BUSY: https://financialbrain.ai/help/UPDATE_BRAIN_BUSY"),
        { supportCode: "UPDATE_BRAIN_BUSY" });
    },
  }), error => {
    assert.match(error.ownerMessage, /https:\/\/financialbrain\.ai\/help\/UPDATE_BRAIN_BUSY/);
    return true;
  });
  assert.equal(reached, 2, "the linked lock-guidance green control reached the same wrapper");
});

for (const failure of ["EACCES", "EPERM", "unsafe-root", "unsafe-slot"]) {
  test(`unusable legacy boundary continues privately with explicit older-tool guidance: ${failure}`, t => {
    const f = fixture(t), override = join(f.root, "override");
    f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = override;
    const identity = brainLifecycleCoordinates(f.options).identity;
    const legacyPath = join(f.shared, `brain-lifecycle-${identity}.lock`);
    if (failure === "unsafe-root") {
      fs.mkdirSync(join(f.shared, ".."), { recursive: true });
      const target = join(f.root, "target"); fs.mkdirSync(target);
      fs.symlinkSync(target, f.shared, "junction");
    } else if (failure === "unsafe-slot") {
      fs.mkdirSync(legacyPath, { recursive: true });
      fs.writeFileSync(join(legacyPath, "unexpected.json"), "{}");
    } else f.deny(f.shared, "lstatSync", failure);
    const held = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
    try {
      assert.equal(held.assertOwned(), true, "private lease green control enters and stays owned");
      assert.equal(held.rootKind, "override", "explicit selected folder remains authoritative");
      assert.ok(f.calls.some(([method, path]) => method === "lstatSync" && path === f.shared), "legacy safety/access decision reached");
      assert.equal(f.warnings.length, 1);
      assert.match(f.warnings[0], /BRAIN_LOCK_FOLDER_PER_USER/);
      assert.match(f.warnings[0], /do not run an older Brain tool at the same time/i);
      assert.match(f.warnings[0], /https:\/\/financialbrain\.ai\/help\/BRAIN_LOCK_FOLDER_PER_USER/);
      assert.ok(!f.warnings[0].includes(f.root));
      assert.equal(f.events.length, 1);
      assert.deepEqual(f.events[0].event, { command: "update", source: "installer", errorCode: "BRAIN_LOCK_FOLDER_PER_USER" });
    } finally { assert.equal(held.release(), true); }
    if (failure === "unsafe-root") fs.unlinkSync(f.shared);
    else if (failure === "unsafe-slot") fs.rmSync(legacyPath, { recursive: true });
    else f.options.lockRootOptions.fileSystem = fs;
    const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
    assert.ok(fs.existsSync(legacyPath), "repaired legacy slot is retained until release");
    assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
    assert.equal(fs.existsSync(legacyPath), false, "both writer boundaries release normally");
  });
}

test("override lease retains the legacy shared slot through ownership and child handoff", t => {
  const f = fixture(t); f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = join(f.root, "override");
  const parent = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  const legacyPath = join(f.shared, basename(parent.path));
  let child;
  try {
    assert.ok(fs.existsSync(legacyPath), "legacy boundary is held, rather than scanned and released");
    const owner = JSON.parse(fs.readFileSync(join(legacyPath, "owner.json"), "utf8"));
    assert.equal(owner.schema_version, 2); assert.equal(owner.operation, "update");
    const delegation = parent.childDelegation();
    assert.equal(delegation.legacy.coordinates.root, fs.realpathSync(f.shared));
    const beforeBindingCheck = f.calls.length;
    assert.throws(() => adoptParentBrainLifecycleLock({ ...f.options, parentPid: process.pid,
      delegation: { ...delegation, legacy: { ...delegation.legacy, coordinates: { ...delegation.legacy.coordinates, identity: "0".repeat(32) } } } }),
    { code: "brain_lifecycle_lost" });
    assert.ok(f.calls.slice(beforeBindingCheck).some(([method, path]) => method === "lstatSync" && path === f.shared),
      "legacy-coordinate safety decision reached before refusing the invalid identity");
    assert.ok(delegation.legacy.token, "invalid legacy-binding decision receives a real delegation");
    assert.equal(parent.assertOwned(), true, "tampered handoff keeps the parent control owned");
    child = adoptParentBrainLifecycleLock({ ...f.options, parentPid: process.pid, delegation });
    assert.equal(parent.release(), false, "old tokens cannot release transferred slots");
    assert.equal(child.assertOwned(), true);
    fs.unlinkSync(join(legacyPath, "owner.json")); fs.rmdirSync(legacyPath);
    assert.throws(() => child.assertOwned(), { code: "brain_lifecycle_lost" });
  } finally { child?.release(); parent.release(); }
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
});

for (const kind of ["file", "link"]) test(`unsafe default shared ${kind} continues with private leases and preserves the unsafe entry`, t => {
  const f = fixture(t);
  fs.mkdirSync(join(f.shared, ".."), { recursive: true });
  if (kind === "file") fs.writeFileSync(f.shared, "fixture");
  else { const target = join(f.root, "target"); fs.mkdirSync(target); fs.symlinkSync(target, f.shared, "junction"); }
  const lock = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  try {
    assert.equal(lock.rootKind, "per-user"); assert.equal(lock.assertOwned(), true);
    assert.ok(f.calls.some(([method, path]) => method === "lstatSync" && path === f.shared), "unsafe shared-root decision reached");
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /Do not run an older Brain tool at the same time/);
    assert.equal(kind === "file" ? fs.readFileSync(f.shared, "utf8") : fs.lstatSync(f.shared).isSymbolicLink(), kind === "file" ? "fixture" : true);
  } finally { lock.release(); }
  fs.unlinkSync(f.shared);
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.rootKind, "shared"); assert.equal(control.release(), true);
});

test("denied legacy owner publication cleans only its empty slot and keeps the private lease", t => {
  const f = fixture(t); let denied = 0;
  const lock = acquireBrainLifecycleLock({ ...f.options, operation: "update",
    publishOwner(path, ...args) {
      if (path.startsWith(f.shared)) { denied++; throw Object.assign(new Error("synthetic write denial"), { code: "EACCES" }); }
      return fs.writeFileSync(path, ...args);
    } });
  try {
    assert.equal(denied, 1, "legacy owner publication decision reached");
    assert.equal(lock.rootKind, "account"); assert.equal(lock.assertOwned(), true);
    assert.deepEqual(fs.readdirSync(f.shared), [], "failed publication leaves no empty phantom slot");
    assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /Do not run an older Brain tool at the same time/);
  } finally { lock.release(); }
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.rootKind, "shared"); assert.equal(control.release(), true);
});

test("a legacy recovery fence still blocks an explicit-root load after both lease boundaries are acquired", t => {
  const f = fixture(t), transactionId = "b".repeat(32);
  writeBrainRecoveryFence({ ...f.options, transactionId });
  f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = join(f.root, "override");
  let publications = 0;
  assert.throws(() => acquireBrainLifecycleLock({ ...f.options, operation: "load",
    publishOwner(...args) { publications++; return fs.writeFileSync(...args); } }), { code: "brain_lifecycle_recovery_required" });
  assert.equal(publications, 3, "account, legacy and override acquisition reached the fence decision");
  delete f.environment.BRAIN_LIFECYCLE_LOCK_ROOT;
  assert.equal(clearBrainRecoveryFence({ ...f.options, transactionId }), true);
  f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = join(f.root, "override");
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "load" });
  assert.equal(control.assertOwned(), true); assert.equal(control.release(), true);
});

test("an override naming the legacy root keeps its selected metadata through handoff", t => {
  const f = fixture(t); f.environment.BRAIN_LIFECYCLE_LOCK_ROOT = f.shared;
  const parent = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  let child;
  try {
    assert.equal(parent.rootKind, "override", "same physical slot preserves the explicit selected role");
    assert.equal(parent.path, parent.legacyPath, "one physical slot serves both selected and legacy roles");
    child = adoptParentBrainLifecycleLock({ ...f.options, parentPid: process.pid, delegation: parent.childDelegation() });
    assert.equal(child.assertOwned(), true);
    assert.equal(parent.release(), false);
  } finally { child?.release(); parent.release(); }
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.rootKind, "override"); assert.equal(control.release(), true);
});

test("unsafe default shared boundary keeps fence creation and preview on the safe private root", t => {
  const f = fixture(t), transactionId = "c".repeat(32);
  fs.mkdirSync(join(f.shared, ".."), { recursive: true });
  const target = join(f.root, "target"); fs.mkdirSync(target);
  fs.symlinkSync(target, f.shared, "junction");
  const lock = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  try {
    assert.equal(lock.rootKind, "per-user");
    const fence = writeBrainRecoveryFence({ ...f.options, transactionId });
    assert.equal(fence.path, join(lock.root, `brain-update-recovery-${lock.identity}.json`));
    assert.equal(readBrainRecoveryFenceReadOnly(f.options).transaction_id, transactionId);
    assert.equal(clearBrainRecoveryFence({ ...f.options, transactionId }), true);
    assert.deepEqual(fs.readdirSync(target), [], "unsafe shared target is never followed or changed");
  } finally { lock.release(); }
  fs.unlinkSync(f.shared);
  const control = acquireBrainLifecycleLock({ ...f.options, operation: "update" });
  assert.equal(control.rootKind, "shared"); assert.equal(control.release(), true);
});
