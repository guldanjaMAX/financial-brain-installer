import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs, {
  existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { saveState } from "../ingest/run.mjs";
import { writeManifestAtomically } from "../operations/folder-retirement.mjs";
import { writeBootstrapStatusFile } from "../operations/bootstrap-status.mjs";
import { CODEX_WORKSPACE_MARKER, writeCodexWorkspaceGuide } from "../operations/claude-workspace.mjs";
import { writeAdminKeyFile } from "../operations/admin-key-file.mjs";
import { saveTokens } from "../connectors/google-auth.mjs";
import { writeDailyRefreshUpdateTransaction, readDailyRefreshUpdateTransaction, clearDailyRefreshUpdateTransaction, dailyRefreshUpdateTransactionPath } from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { initializeVerifiedRecovery, writeVerifiedRecoveryState } from "../operations/verified-recovery.mjs";
import { pinStagingMtime, rewriteStagingInPlace, assertStagingSurvives } from "./fixtures/rename-retry-staging.mjs";

// Synthetic protection is an in-memory storage boundary, never an OS helper or
// provider call. Assertions below expose only outcome and identity metadata.
function syntheticProtection() {
  const saved = new Map();
  return (_command, args, options) => {
    const input = Buffer.from(options.input);
    if (args[args.indexOf("-Operation") + 1] === "protect") {
      const cipher = Buffer.from(`synthetic-protected-${saved.size}`);
      saved.set(cipher.toString("hex"), input);
      return { status: 0, stdout: cipher, stderr: Buffer.alloc(0) };
    }
    const plain = saved.get(input.toString("hex"));
    return { status: plain ? 0 : 1, stdout: plain ? Buffer.from(plain) : Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
}

const identityWriters = [
  {
    name: "manifest identity",
    filename: "manifest.json",
    prior: Buffer.from('{"version":1}\n'),
    destinationRefusal: "The Brain manifest changed after folder off began, so nothing was replaced.",
    stagingRefusal: "The Brain manifest changed after folder off began, so nothing was replaced.",
    rollbackRefusal: /the original manifest could not be restored exactly/,
    write(path, rename, rollback = false) {
      let committed = false;
      return writeManifestAtomically(path, { version: 2 }, { filesystemPlatform: "win32", fs: {
        renameSync: (from, to) => {
          const result = rename(from, to);
          if (!from.endsWith(".rollback.tmp")) committed = true;
          return result;
        },
        readFileSync: (...args) => {
          if (rollback && committed && args[0] === path) { committed = false; return Buffer.from("invalid"); }
          return fs.readFileSync(...args);
        },
      } });
    },
  },
  {
    name: "admin key identity",
    filename: ".brain-admin-key",
    prior: Buffer.from(`${"a".repeat(48)}\n`),
    destinationRefusal: "the admin key destination changed before replacement",
    stagingRefusal: "the admin key staged identity changed before verification",
    rollbackRefusal: /rollback could not be verified/,
    write(path, rename, rollback = false) {
      return writeAdminKeyFile(path, "b".repeat(48), {
        platform: "win32", username: "synthetic-owner", environment: { SystemRoot: process.env.SystemRoot || "C:\\Windows" },
        runAcl: () => ({ status: 0 }), runPowerShell: syntheticProtection(), rename,
        readFileForVerification: (_path, descriptor, phase) => rollback && phase === "persisted" ? Buffer.alloc(0) : readFileSync(descriptor),
      });
    },
  },
  {
    name: "token store identity",
    filename: "tokens.json",
    prior: Buffer.from('{"google":{"scopes":["drive"]}}\n'),
    destinationRefusal: "the Google token destination changed before replacement",
    stagingRefusal: "the Google token staged identity changed before verification",
    rollbackRefusal: /rollback could not be verified/,
    write(path, rename, rollback = false) {
      return saveTokens({ google: { scopes: ["drive", "gmail"] } }, {
        backend: "file", platform: "win32", username: "synthetic-owner", path,
        environment: { SystemRoot: process.env.SystemRoot || "C:\\Windows" },
        runAcl: () => ({ status: 0 }), runPowerShell: syntheticProtection(), renameFile: rename,
        fetchImpl: () => { throw new Error("unexpected provider request"); },
        readFileForVerification: (_path, descriptor, phase) => rollback && phase === "persisted" ? Buffer.alloc(0) : readFileSync(descriptor),
      });
    },
  },
];

for (const writer of identityWriters) {
  for (const changed of ["control", "destination", "staging", "staging-in-place", "squat-after-success"]) {
    test(`${writer.name}: ${changed} between attempts`, () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-rename-identity-")));
      const path = join(root, writer.filename);
      writeFileSync(path, writer.prior, { mode: 0o600 });
      const restorePin = pinStagingMtime(root);
      let calls = 0;
      let replaced;
      let replacement;
      let replacementIdentity;
      let refusal;
      let fixtureFailure;
      const rename = (from, to) => {
        calls++;
        if (calls === 1) {
          if (changed === "staging-in-place") {
            try { rewriteStagingInPlace(from); } catch (error) { fixtureFailure = error; throw error; }
          }
          else if (changed !== "control" && changed !== "squat-after-success") {
            replaced = changed === "destination" ? to : from;
            replacement = Buffer.from(readFileSync(replaced));
            // Keep the displaced inode alive so the filesystem cannot reuse it.
            nativeRename(replaced, join(root, "displaced"));
            writeFileSync(replaced, replacement, { mode: 0o600, flag: "wx" });
            replacementIdentity = fs.lstatSync(replaced, { bigint: true });
          }
          throw Object.assign(new Error("synthetic sharing refusal"), { code: "EPERM" });
        }
        const result = nativeRename(from, to);
        if (changed === "squat-after-success") {
          replaced = from;
          replacement = Buffer.from("synthetic replacement");
          writeFileSync(from, replacement, { flag: "wx", mode: 0o600 });
          replacementIdentity = fs.lstatSync(from, { bigint: true });
        }
        return result;
      };
      try {
        try { writer.write(path, rename); } catch (error) { refusal = error; }
        if (fixtureFailure) throw fixtureFailure;
        if (changed === "control" || changed === "squat-after-success") {
          assert.ok(!refusal, "unchanged identities permit the second attempt");
          assert.equal(calls, 2);
          assert.ok(!readFileSync(path).equals(writer.prior), "control publishes the replacement");
          if (changed === "squat-after-success") assertStagingSurvives(replaced, replacementIdentity, replacement);
        } else {
          assert.equal(calls, 1, "a changed identity must stop before the second rename");
          assert.equal(refusal?.message, changed === "destination" ? writer.destinationRefusal : writer.stagingRefusal,
            "identity drift preserves the caller's existing refusal");
          assert.ok(readFileSync(path).equals(writer.prior), "refusal preserves the destination bytes");
          if (changed === "staging") assertStagingSurvives(replaced, replacementIdentity, replacement);
        }
      } finally { restorePin(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (const writer of identityWriters) {
  for (const changed of ["control", "destination", "staging", "staging-in-place", "squat-after-success"]) {
    test(`${writer.name} rollback: ${changed} between attempts`, () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-rollback-rename-identity-")));
      const path = join(root, writer.filename);
      writeFileSync(path, writer.prior, { mode: 0o600 });
      const restorePin = pinStagingMtime(root);
      let calls = 0;
      let committedBytes;
      let refusal;
      let replaced;
      let replacement;
      let replacementIdentity;
      let fixtureFailure;
      const rename = (from, to) => {
        if (!from.endsWith(".bak") && !from.endsWith(".rollback.tmp")) {
          const result = nativeRename(from, to);
          committedBytes = readFileSync(to);
          return result;
        }
        calls++;
        if (calls === 1) {
          if (changed === "staging-in-place") {
            try { rewriteStagingInPlace(from); } catch (error) { fixtureFailure = error; throw error; }
          }
          else if (changed !== "control" && changed !== "squat-after-success") {
            const target = changed === "destination" ? to : from;
            const bytes = readFileSync(target);
            nativeRename(target, join(root, "displaced"));
            writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
            replaced = target;
            replacement = bytes;
            replacementIdentity = fs.lstatSync(target, { bigint: true });
          }
          throw Object.assign(new Error("synthetic rollback sharing refusal"), { code: "EPERM" });
        }
        const result = nativeRename(from, to);
        if (changed === "squat-after-success") {
          replaced = from;
          replacement = Buffer.from("synthetic replacement");
          writeFileSync(from, replacement, { flag: "wx", mode: 0o600 });
          replacementIdentity = fs.lstatSync(from, { bigint: true });
        }
        return result;
      };
      try {
        try { writer.write(path, rename, true); } catch (error) { refusal = error; }
        if (fixtureFailure) throw fixtureFailure;
        assert.ok(refusal, "the injected persisted verification failure remains visible");
        if (changed === "control" || changed === "squat-after-success") {
          assert.equal(calls, 2, "unchanged rollback identities permit restoration");
          if (writer.name === "manifest identity") assert.ok(readFileSync(path).equals(writer.prior));
          else assert.match(refusal.message, /prior .* restored and verified/);
          if (changed === "squat-after-success") assertStagingSurvives(replaced, replacementIdentity, replacement);
        } else {
          assert.equal(calls, 1, "rollback drift prevents another rename");
          assert.match(refusal.message, writer.rollbackRefusal);
          assert.ok(readFileSync(path).equals(committedBytes), "rollback refusal preserves the replacement bytes");
          if (changed === "staging") assertStagingSurvives(replaced, replacementIdentity, replacement);
        }
      } finally { restorePin(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (const refused of [false, true]) {
  test(`recovery first creation: ${refused ? "a refused staging proof prevents publication" : "a matching staging proof permits publication"}`, () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-recovery-create-proof-")));
    const manifests = ["source", "target"].map(role => {
      const path = join(root, `${role}.json`);
      writeFileSync(path, JSON.stringify({
        manifest_version: 1,
        client: { slug: "synthetic-brain", display_name: "Synthetic Fixture" },
        brain: { version: "0.0.1", worker_name: `synthetic-${role}`, domain: `${role}.example.invalid` },
        infrastructure: { cloudflare: { storage: "d1", account_id: "synthetic-account", d1_database_id: `synthetic-${role}`, d1_database_name: `synthetic-${role}`, vectorize_index: `synthetic-${role}` } },
      }), { mode: 0o600 });
      return path;
    });
    const planPath = join(root, "plan.json");
    const statePath = join(root, "state.json");
    const native = { open: fs.openSync, read: fs.readSync, close: fs.closeSync, link: fs.linkSync };
    const proofDescriptors = new Set();
    let proofReads = 0;
    let publications = 0;
    fs.openSync = (path, ...args) => {
      const descriptor = native.open(path, ...args);
      if (typeof path === "string" && path.startsWith(join(root, ".plan.json.")) && path.endsWith(".tmp")) {
        proofDescriptors.add(descriptor);
      }
      return descriptor;
    };
    fs.readSync = (descriptor, buffer, offset, length, position) => {
      const count = native.read(descriptor, buffer, offset, length, position);
      if (proofDescriptors.has(descriptor) && count > 0) {
        proofReads++;
        // A definite byte mismatch must refuse before the exclusive link,
        // even though the subsequent readback could see the intended bytes.
        if (refused) buffer[offset] ^= 0xff;
      }
      return count;
    };
    fs.closeSync = descriptor => {
      proofDescriptors.delete(descriptor);
      return native.close(descriptor);
    };
    fs.linkSync = (from, to) => {
      if (to === planPath || to === statePath) publications++;
      return native.link(from, to);
    };
    syncBuiltinESMExports();
    try {
      const invoke = () => initializeVerifiedRecovery(...manifests, planPath, statePath);
      if (refused) {
        assert.throws(invoke, /verified recovery control staging proof was refused/);
        assert.equal(publications, 0);
        assert.equal(existsSync(planPath), false);
        assert.equal(existsSync(statePath), false);
      } else {
        assert.ok(invoke());
        assert.equal(publications, 2);
        assert.equal(existsSync(planPath), true);
        assert.equal(existsSync(statePath), true);
      }
      assert.ok(proofReads > 0, "the first-create writer must exercise the bounded staging read");
      assert.equal(readdirSync(root).some(name => name.endsWith(".tmp")), false);
    } finally {
      fs.openSync = native.open;
      fs.readSync = native.read;
      fs.closeSync = native.close;
      fs.linkSync = native.link;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const dailyWriters = [
  {
    name: "recovery state identity",
    refusal: "verified recovery control destination changed before replacement",
    prepare(root) {
      const manifests = ["source", "target"].map(role => {
        const path = join(root, `${role}.json`);
        writeFileSync(path, JSON.stringify({
          manifest_version: 1,
          client: { slug: "synthetic-brain", display_name: "Synthetic Fixture" },
          brain: { version: "0.0.1", worker_name: `synthetic-${role}`, domain: `${role}.example.invalid` },
          infrastructure: { cloudflare: { storage: "d1", account_id: "synthetic-account", d1_database_id: `synthetic-${role}`, d1_database_name: `synthetic-${role}`, vectorize_index: `synthetic-${role}` } },
        }), { mode: 0o600 });
        return path;
      });
      const path = join(root, "state.json");
      const initialized = initializeVerifiedRecovery(...manifests, join(root, "plan.json"), path);
      return { path, write: () => writeVerifiedRecoveryState(path, initialized.state, initialized.plan, { platform: "win32" }) };
    },
  },
  {
    name: "daily transaction identity",
    refusal: "the daily update transaction receipt is unsafe",
    prepare(root, manifestPath, identity) {
      const plan = { identity, manifest_path: manifestPath };
      const options = { home: root, platform: "win32", machineLockRoot: join(root, "locks") };
      const input = { plan, snapshot: { identity }, phase: "preparing" };
      const path = dailyRefreshUpdateTransactionPath(identity, options);
      fs.mkdirSync(join(root, ".brain", "daily-update-transactions"), { recursive: true });
      writeFileSync(path, '{}\n', { mode: 0o600 });
      return { path, write: () => writeDailyRefreshUpdateTransaction(input, options) };
    },
  },
  {
    name: "daily history identity",
    refusal: "the daily update history is unsafe",
    prepare(root, _manifestPath, identity) {
      const options = { home: root, platform: "win32" };
      const path = dailyRefreshUpdateTransactionPath(identity, options);
      const transactionId = "a".repeat(32);
      const history = join(root, ".brain", "daily-update-transactions", "history");
      fs.mkdirSync(history, { recursive: true });
      writeFileSync(path, JSON.stringify({ transaction_id: transactionId, bridge_snapshots: [{}] }), { mode: 0o600 });
      const archive = join(history, `${transactionId}.json`);
      writeFileSync(archive, '{}\n', { mode: 0o600 });
      return { path: archive, write: () => clearDailyRefreshUpdateTransaction(identity, options) };
    },
  },
  {
    name: "daily receipt identity",
    refusal: "the daily refresh receipt changed before replacement",
    prepare(root, manifestPath, identity) {
      const directory = join(root, ".brain", "daily-receipts");
      fs.mkdirSync(directory, { recursive: true });
      const path = join(directory, `${identity.id}.json`);
      writeFileSync(path, '{}\n', { mode: 0o600 });
      return { path, write: () => runDailyRefreshCli(manifestPath, {
        brainModule: {}, buildPlan: async () => ({ ready: true, enabled: true, identity, manifest_path: manifestPath, sources: [] }),
        acquireLock: () => ({ assertOwned() {}, release() {} }),
        readFreshness: async () => ({}), runSource: async () => { throw new Error("unexpected source call"); },
        readUpdateTransaction: () => null, appendObservation: () => {}, home: root, platform: "win32", silent: true,
      }) };
    },
  },
];

for (const writer of dailyWriters) {
  for (const changed of ["control", "destination", "staging", "staging-in-place", "squat-after-success"]) {
    test(`${writer.name}: ${changed} between attempts`, async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-daily-rename-identity-")));
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
      const fixture = writer.prepare(root, manifestPath, { id: "v1-abcdef1234567890" });
      const prior = readFileSync(fixture.path);
      const priorIdentity = fs.lstatSync(fixture.path);
      const restorePin = pinStagingMtime(root);
      let calls = 0;
      let refusal;
      let replaced;
      let replacement;
      let replacementIdentity;
      let fixtureFailure;
      fs.renameSync = (from, to) => {
        if (to !== fixture.path) return nativeRename(from, to);
        calls++;
        if (calls === 1) {
          if (changed === "staging-in-place") {
            try { rewriteStagingInPlace(from); } catch (error) { fixtureFailure = error; throw error; }
          }
          else if (changed !== "control" && changed !== "squat-after-success") {
            const target = changed === "destination" ? to : from;
            const bytes = readFileSync(target);
            nativeRename(target, join(root, "displaced"));
            writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
            replaced = target;
            replacement = bytes;
            replacementIdentity = fs.lstatSync(target, { bigint: true });
          }
          throw Object.assign(new Error("synthetic sharing refusal"), { code: "EPERM" });
        }
        const result = nativeRename(from, to);
        if (changed === "squat-after-success") {
          replaced = from;
          replacement = Buffer.from("synthetic replacement");
          writeFileSync(from, replacement, { flag: "wx", mode: 0o600 });
          replacementIdentity = fs.lstatSync(from, { bigint: true });
        }
        return result;
      };
      syncBuiltinESMExports();
      try {
        try { await fixture.write(); } catch (error) { refusal = error; }
        if (fixtureFailure) throw fixtureFailure;
        if (changed === "control" || changed === "squat-after-success") {
          assert.ok(!refusal, "unchanged identities permit daily persistence");
          assert.equal(calls, 2);
          assert.notEqual(fs.lstatSync(fixture.path).ino, priorIdentity.ino, "control publishes the staged inode");
          if (changed === "squat-after-success") assertStagingSurvives(replaced, replacementIdentity, replacement);
        } else {
          assert.equal(calls, 1, "identity drift prevents the next daily rename");
          assert.equal(refusal?.message, writer.refusal);
          assert.ok(readFileSync(fixture.path).equals(prior), "refusal retains prior receipt bytes");
          if (changed === "staging") assertStagingSurvives(replaced, replacementIdentity, replacement);
        }
      } finally {
        fs.renameSync = nativeRename;
        syncBuiltinESMExports();
        restorePin();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const failStat of [false, true]) {
  test(`daily receipt descriptor: ${failStat ? "a create observation failure closes the handle" : "a successful observation closes the handle"}`, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-daily-descriptor-")));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
    const fixture = dailyWriters.find(writer => writer.name === "daily receipt identity")
      .prepare(root, manifestPath, { id: "v1-abcdef1234567890" });
    const native = { open: fs.openSync, stat: fs.fstatSync, close: fs.closeSync };
    let created;
    let closed = false;
    let failed = false;
    fs.openSync = (path, flags, ...args) => {
      const descriptor = native.open(path, flags, ...args);
      if (path === `${fixture.path}.tmp-${process.pid}` && flags === "wx") created = descriptor;
      return descriptor;
    };
    fs.fstatSync = (descriptor, ...args) => {
      if (failStat && descriptor === created && !failed) {
        failed = true;
        throw new Error("synthetic descriptor observation refusal");
      }
      return native.stat(descriptor, ...args);
    };
    fs.closeSync = descriptor => {
      if (descriptor === created) closed = true;
      return native.close(descriptor);
    };
    syncBuiltinESMExports();
    try {
      if (failStat) await assert.rejects(fixture.write);
      else await fixture.write();
      assert.equal(closed, true, "the exclusive-create descriptor must close even when its first observation fails");
    } finally {
      fs.openSync = native.open;
      fs.fstatSync = native.stat;
      fs.closeSync = native.close;
      syncBuiltinESMExports();
      if (created !== undefined && !closed) native.close(created);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const operation of ["clear", "persist", "read"]) {
  for (const replaced of [false, true]) {
    test(`daily receipt ownership: ${operation} ${replaced ? "refuses a same-bytes replacement" : "accepts its own publication"}`, () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-daily-ownership-")));
      const identity = { id: "v1-abcdef1234567890" };
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
      const options = { home: root, platform: "win32", machineLockRoot: join(root, "locks") };
      const input = { plan: { identity, manifest_path: manifestPath }, snapshot: { identity }, phase: "preparing" };
      try {
        const published = writeDailyRefreshUpdateTransaction(input, options);
        const path = dailyRefreshUpdateTransactionPath(identity, options);
        const bytes = readFileSync(path);
        if (replaced) {
          nativeRename(path, join(root, "displaced"));
          writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
        }
        const current = fs.lstatSync(path, { bigint: true });
        const invoke = operation === "clear"
          ? () => clearDailyRefreshUpdateTransaction(identity, { ...options, manifestPath, expected: published })
          : operation === "persist"
            ? () => writeDailyRefreshUpdateTransaction({ ...input, phase: "paused" }, { ...options, expectedPredecessor: published })
            : () => readDailyRefreshUpdateTransaction(identity, { ...options, manifestPath, expected: published });
        if (replaced) {
          assert.throws(invoke, /daily update transaction receipt is unsafe/);
          assertStagingSurvives(path, current, bytes);
        } else assert.ok(invoke(), "the original publication remains valid for its caller");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (const replaced of [false, true]) {
  test(`manifest publication rollback: ${replaced ? "refuses a same-bytes replacement" : "accepts its own publication"}`, () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-manifest-publication-")));
    const path = join(root, "manifest.json");
    writeFileSync(path, '{"version":1}\n', { mode: 0o600 });
    try {
      const published = writeManifestAtomically(path, { version: 2 }, { backupTag: "forward", filesystemPlatform: "win32" });
      const bytes = readFileSync(path);
      if (replaced) {
        nativeRename(path, join(root, "displaced"));
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      }
      const current = fs.lstatSync(path, { bigint: true });
      const rollback = () => writeManifestAtomically(path, { version: 1 }, {
        backupTag: "restore", filesystemPlatform: "win32", expectedPublication: published,
      });
      if (replaced) {
        assert.throws(rollback, { code: "FOLDER_MANIFEST_CHANGED" });
        assertStagingSurvives(path, current, bytes);
      } else {
        rollback();
        assert.equal(JSON.parse(readFileSync(path)).version, 1);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

const nativeOptions = {
  skip: process.platform !== "win32" && "requires native Windows FileShare.Read handle semantics",
  timeout: 20_000,
};
const nativeRename = fs.renameSync;
const sites = [
  {
    name: "state checkpoint",
    before: { version: 1, done: { fixture: "prior" }, skipped: {} },
    after: { version: 1, done: { fixture: "next" }, skipped: {} },
    write: (path, value) => saveState(path, value),
  },
  {
    name: "manifest",
    before: { brain: { version: "0.0.1" } },
    after: { brain: { version: "0.0.2" } },
    write: (path, value) => writeManifestAtomically(path, value),
  },
  {
    name: "bootstrap receipt",
    before: { schema_version: 1, status: "prior" },
    after: { schema_version: 1, status: "next" },
    write: (path, value) => writeBootstrapStatusFile(path, value, { path }),
    expected: (path, value) => ({ ...value, status_file: path }),
  },
];

function fixture(site) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-rename-handle-")));
  const path = join(root, "destination.json");
  const before = site.expected?.(path, site.before) ?? site.before;
  const after = site.expected?.(path, site.after) ?? site.after;
  writeFileSync(path, JSON.stringify(before), { mode: 0o600 });
  return { root, path, before, after };
}

function verify(fixture, expected, { failed = false } = {}) {
  // Never include private payload bytes or file names in assertion output.
  assert.ok(JSON.stringify(JSON.parse(readFileSync(fixture.path, "utf8"))) === JSON.stringify(expected),
    "destination must contain the complete expected JSON");
  const names = readdirSync(fixture.root);
  assert.equal(names.filter(name => /\.tmp(?:-|$)/u.test(name)).length, 0,
    "the existing writer must clean its temporary sibling");
  if (failed) assert.equal(names.filter(name => name.includes(".before-")).length, 0,
    "a refused manifest write must remove its unused backup");
}

const holderScript = `
$ErrorActionPreference = 'Stop'
$root = $env:BRAIN_RENAME_HOLDER_ROOT
$targetPath = [IO.Path]::Combine($root, 'destination.json')
$readyPath = [IO.Path]::Combine($root, 'ready')
$attemptPath = [IO.Path]::Combine($root, 'attempted')
$stopPath = [IO.Path]::Combine($root, 'stop')
$releaseDelay = [int]$env:BRAIN_RENAME_HOLDER_RELEASE_MS
$handle = $null
try {
  $handle = [IO.File]::Open($targetPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  [IO.File]::WriteAllText($readyPath, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while (-not [IO.File]::Exists($stopPath)) {
    if ([DateTime]::UtcNow -ge $deadline) { exit 3 }
    if ($releaseDelay -ge 0 -and [IO.File]::Exists($attemptPath)) {
      Start-Sleep -Milliseconds $releaseDelay
      break
    }
    Start-Sleep -Milliseconds 10
  }
} catch { exit 2 } finally {
  if ($null -ne $handle) { $handle.Dispose() }
}
`;

function startHolder(root, releaseDelay) {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, "native holder requires the Windows system directory");
  const child = spawn(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(holderScript, "utf16le").toString("base64"),
  ], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: root,
      TMP: root,
      BRAIN_RENAME_HOLDER_ROOT: root,
      BRAIN_RENAME_HOLDER_RELEASE_MS: String(releaseDelay),
    },
  });
  let finished = false;
  const exited = new Promise(resolve => {
    child.once("error", () => { finished = true; resolve({ code: null, failedToStart: true }); });
    child.once("close", code => { finished = true; resolve({ code, failedToStart: false }); });
  });
  return { child, exited, isFinished: () => finished };
}

async function waitUntilReady(root, holder) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(root, "ready")) && Date.now() < deadline && !holder.isFinished()) {
    await delay(10);
  }
  assert.ok(existsSync(join(root, "ready")) && !holder.isFinished(),
    "native holder must acquire its destination handle before the write");
}

async function waitForExit(holder, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      holder.exited,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function stopHolder(root, holder) {
  writeFileSync(join(root, "stop"), "stop");
  let result = await waitForExit(holder, 3_000);
  if (!result) {
    holder.child.kill();
    result = await waitForExit(holder, 3_000);
  }
  assert.ok(result, "native holder must exit within the cleanup deadline");
  assert.equal(result.failedToStart, false, "native holder must start successfully");
  assert.equal(result.code, 0, "native holder must release the handle and exit cleanly");
}

function observeWrite(site, fixture) {
  let calls = 0;
  let failures = 0;
  let lastError;
  let error;
  // Observe the actual native call beneath all three writers, without replacing
  // the real sharing refusal with an injected error or changing writer options.
  fs.renameSync = (from, to) => {
    calls++;
    try { return nativeRename(from, to); } catch (cause) {
      failures++;
      lastError = cause;
      if (failures === 1) writeFileSync(join(fixture.root, "attempted"), "attempted");
      throw cause;
    }
  };
  syncBuiltinESMExports();
  try { site.write(fixture.path, site.after); } catch (cause) { error = cause; }
  finally {
    fs.renameSync = nativeRename;
    syncBuiltinESMExports();
  }
  return { calls, failures, lastError, error };
}

for (const site of sites) {
  test(`${site.name}: native replacement succeeds without contention`, nativeOptions, () => {
    const f = fixture(site);
    try {
      const result = observeWrite(site, f);
      assert.ok(!result.error, "uncontended replacement must succeed");
      assert.equal(result.calls, 1, "uncontended replacement must perform exactly one rename");
      assert.equal(result.failures, 0);
      verify(f, f.after);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test(`${site.name}: native replacement recovers after delayed handle release`, nativeOptions, async () => {
    const f = fixture(site);
    const holder = startHolder(f.root, 450);
    try {
      await waitUntilReady(f.root, holder);
      const result = observeWrite(site, f);
      assert.ok(!result.error, "replacement must succeed after the holder releases");
      assert.ok(result.failures >= 1, "a native rename must fail before the holder releases");
      assert.equal(result.calls, result.failures + 1, "the final rename must be the single successful attempt");
      assert.ok(result.calls <= 10, "native recovery must stay inside the attempt budget");
      verify(f, f.after);
    } finally {
      try { await stopHolder(f.root, holder); }
      finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  test(`${site.name}: native replacement refuses a handle held through every attempt`, nativeOptions, async () => {
    const f = fixture(site);
    const holder = startHolder(f.root, -1);
    try {
      await waitUntilReady(f.root, holder);
      const result = observeWrite(site, f);
      assert.ok(result.error && ["EPERM", "EACCES", "EBUSY"].includes(result.error.code),
        "held destination must return a native sharing refusal");
      assert.ok(result.error === result.lastError, "give-up must preserve the original rename error object");
      assert.equal(result.calls, 10, "held destination must exhaust exactly ten attempts");
      assert.equal(holder.isFinished(), false, "holder must remain active through the refusal");
      verify(f, f.before, { failed: true });
    } finally {
      try { await stopHolder(f.root, holder); }
      finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });
}

for (const site of [sites[0], sites[2]]) {
  test(`${site.name}: a chmod refusal does not repeat chmod or rename`, nativeOptions, () => {
    const f = fixture(site);
    const nativeChmod = fs.chmodSync;
    const original = Object.assign(new Error("synthetic chmod refusal"), { code: "EPERM" });
    let chmods = 0;
    fs.chmodSync = () => { chmods++; throw original; };
    syncBuiltinESMExports();
    try {
      const result = observeWrite(site, f);
      assert.ok(result.error === original, "the original chmod error must leave the writer unchanged");
      assert.equal(chmods, 1, "chmod is outside the retry boundary");
      assert.equal(result.calls, 1, "a successful rename must not repeat after a chmod failure");
      assert.equal(result.failures, 0);
      verify(f, f.after);
    } finally {
      fs.chmodSync = nativeChmod;
      syncBuiltinESMExports();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

for (const mode of ["control", "transient", "terminal"]) {
  test(`workspace staging rename: ${mode}`, nativeOptions, () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-workspace-rename-")));
    const target = join(root, "AGENTS.md");
    const manifest = join(root, "manifest.json");
    let calls = 0;
    let directoryRenames = 0;
    let staged;
    let stagedBytes;
    let stagedInode;
    let result;
    fs.renameSync = (from, to) => {
      if (!from.endsWith(".tmp") || !to.includes(".financial-brain-pending-")) {
        if (fs.lstatSync(from).isDirectory()) directoryRenames++;
        return nativeRename(from, to);
      }
      calls++;
      staged ??= from;
      stagedBytes ??= readFileSync(from);
      stagedInode ??= fs.lstatSync(from).ino;
      assert.equal(from, staged, "every attempt must keep the same staged path");
      assert.ok(readFileSync(from).equals(stagedBytes), "every attempt must keep the complete staged bytes");
      assert.equal(fs.lstatSync(from).ino, stagedInode, "every attempt must keep the staged inode");
      if (mode === "terminal" || (mode === "transient" && calls === 1)) {
        throw Object.assign(new Error("synthetic staging refusal"), { code: "EPERM" });
      }
      return nativeRename(from, to);
    };
    syncBuiltinESMExports();
    try {
      result = writeCodexWorkspaceGuide(manifest, {
        brainCliPath: join(root, "brain.mjs"),
        nodePath: process.execPath,
        platformName: "win32",
        // Exercise the real writer independently of this sandbox's Windows
        // profile metadata refusal. Filesystem identities and publication stay real.
        ownership: { platform: "linux", userId: fs.lstatSync(root).uid },
      });
      assert.equal(calls, mode === "terminal" ? 10 : mode === "transient" ? 2 : 1,
        "the staging rename must use the shared bounded retry");
      assert.ok(stagedBytes?.toString("utf8").startsWith(CODEX_WORKSPACE_MARKER),
        "the real writer must stage its complete managed guide");
      assert.equal(directoryRenames, 1, "the existing retention directory move remains a single attempt");
      assert.ok(!existsSync(`${target}.lock`), "the ordinary write outcome must release its lock");
      if (mode === "terminal") {
        assert.equal(result.status, "not_written");
        assert.equal(result.changed, false);
        assert.ok(!existsSync(target), "refused staging must not publish a guide");
        assert.ok(result.pendingPath?.endsWith(".tmp"), "the refused staged file remains available for recovery");
        assert.ok(readFileSync(result.pendingPath).equals(stagedBytes), "retained recovery bytes must be exact");
      } else {
        assert.equal(result.status, "written");
        assert.equal(result.changed, true);
        assert.ok(readFileSync(target).equals(stagedBytes), "the published guide must match the complete staged bytes");
        const retained = readdirSync(root).filter(name => name.startsWith("AGENTS.md.financial-brain-retained-"));
        assert.equal(retained.length, 1, "the existing retained-copy behavior stays intact");
        const retainedFiles = readdirSync(join(root, retained[0]));
        assert.equal(retainedFiles.length, 1);
        assert.ok(!retainedFiles[0].endsWith(".tmp"));
        assert.ok(readFileSync(join(root, retained[0], retainedFiles[0])).equals(stagedBytes));
      }
    } finally {
      fs.renameSync = nativeRename;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
