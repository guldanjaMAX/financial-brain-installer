import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { pinStagingMtime, rewriteStagingInPlace, assertStagingSurvives } from "./fixtures/rename-retry-staging.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const helperUrl = new URL("../operations/rename-retry.mjs", import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== helperUrl) return result;
  const parts = String(result.source).split("platform = process.platform,");
  assert.equal(parts.length, 3, "both retry APIs must expose their platform default");
  return { ...result, source: parts.join("platform = globalThis.__brainRenameTestPlatform ?? process.platform,") };
} });
const {
  ANTHROPIC_SECRET_NAME, answerSetupJournal, answerSetupJournalPath,
  resolvedAnswerModels, runAnthropicAnswerSetup, saveManifestAtomically,
} = await import("../operations/answer-setup.mjs");
const {
  installedManifestPointerPath, readInstalledManifest, rememberInstalledManifest,
} = await import("../operations/installed-manifest.mjs");
const { persistReceiptArtifacts, renderFieldChecklist } = await import("../scripts/field-prepare.mjs");
const { saveState } = await import("../ingest/run.mjs");
const { saveDrainState } = await import("../connectors/whatsapp.mjs");
const { desktopBindingStore, makeDesktopBinding } = await import("../connectors/quickbooks-desktop-binding.mjs");
const { writeQuickBooksScheduleState } = await import("../operations/quickbooks-schedule-state.mjs");
const { writeBootstrapStatusFile } = await import("../operations/bootstrap-status.mjs");
const { writeCuratedCoverageLedger } = await import("../operations/curated-dual-sync.mjs");

function protectWithMetadataChange(path) {
  const before = fs.lstatSync(path, { bigint: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  fs.chmodSync(path, 0o400);
  fs.chmodSync(path, Number(before.mode & 0o777n));
  assert.notEqual(fs.lstatSync(path, { bigint: true }).ctimeNs, before.ctimeNs,
    "the protection fixture must change staging metadata");
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const modes = ["control", "transient", "terminal"];
const expectedCalls = mode => process.platform !== "win32" || mode === "control"
  ? 1 : mode === "transient" ? 2 : 10;
const expectedRefusal = mode => mode === "terminal" || (mode === "transient" && process.platform !== "win32");

const identityCases = [
  {
    name: "answer manifest", refusal: /the JSON file changed before it could be replaced/,
    prepare(root) {
      const path = join(root, "manifest.json");
      fs.writeFileSync(path, json({ generation: 1 }));
      return { path, write: () => saveManifestAtomically(path, { generation: 2 }) };
    },
  },
  {
    name: "ingest checkpoint", refusal: /the ingest state changed before it could be replaced/,
    prepare(root) {
      const path = join(root, "state.json");
      fs.writeFileSync(path, json({ version: 1, done: {}, skipped: {} }));
      return { path, write: () => saveState(path, { version: 1, done: { fixture: "next" }, skipped: {} }) };
    },
  },
  {
    name: "drain checkpoint", refusal: /the WhatsApp drain state identity changed before its payload was written/,
    prepare(root) {
      const path = join(root, "drain.json");
      fs.writeFileSync(path, json({ version: 1, last_seq: 1 }));
      return { path, write: () => saveDrainState(path, { version: 1, last_seq: 2 }, {
        platform: "win32", username: "fixture", environment: { SystemRoot: "C:\\Windows" },
        runAcl: () => ({ status: 0 }),
      }) };
    },
  },
  {
    name: "bootstrap receipt", refusal: /the bootstrap status destination is not a safe regular file/,
    prepare(root) {
      const path = join(root, "bootstrap.json");
      fs.writeFileSync(path, json({ status: "prior" }));
      return { path, write: () => writeBootstrapStatusFile(path, { status: "next" }, { path }) };
    },
  },
  {
    name: "coverage ledger", refusal: /coverage ledger destination is not a safe regular file/,
    prepare(root) {
      const path = join(root, "ledger.json");
      return { path, write: () => writeCuratedCoverageLedger(path, { schema_version: 1 }) };
    },
  },
  {
    name: "field checklist", refusal: /field_prepare_failed/,
    prepare(root) {
      const path = join(root, "checklist.md");
      fs.writeFileSync(path, "prior checklist\n");
      return { path, write: () => persistReceiptArtifacts({ status: "running" }, {
        receiptPath: join(root, "receipt.json"), checklistPath: path,
      }, { final: true }) };
    },
  },
  {
    name: "installed pointer", refusal: { code: "INSTALLED_MANIFEST_POINTER_CHANGED" },
    prepare(root) {
      const options = { home: root, stateDirectory: join(root, "state") };
      const manifest = join(root, "manifest.json");
      fs.writeFileSync(manifest, json({ generation: 1 }));
      rememberInstalledManifest(manifest, options);
      return { path: installedManifestPointerPath(options), write: () => rememberInstalledManifest(manifest, options) };
    },
  },
  {
    name: "desktop binding", refusal: { code: "QB_BINDING_INVALID" },
    prepare(root, { protectFile = protectWithMetadataChange } = {}) {
      const store = desktopBindingStore({ home: root, platform: "win32", protectFile, protectDirectory() {} });
      const value = makeDesktopBinding({ country: "US", accounts: [{ ListID: "80000001-1234567890", TimeCreated: "2026-01-01T00:00:00Z" }] });
      store.write(value);
      return { path: join(root, ".brain", "quickbooks-desktop.json"), write: () => store.write(value) };
    },
  },
  {
    name: "schedule evidence", refusal: { code: "QB_SCHEDULE_STATE_INVALID" },
    prepare(root, { protectFile = protectWithMetadataChange } = {}) {
      const plan = { identity: { id: "v1-0123456789abcdef" } };
      const source = { key: "quickbooks", configuration_hash: `sha256:${"a".repeat(64)}` };
      const options = { home: root, platform: "win32", protectFile, protectDirectory() {} };
      const value = { last_complete_snapshot_at: null, last_run_failed: false };
      writeQuickBooksScheduleState(plan, source, value, options);
      return { path: join(root, ".brain", "quickbooks-schedule", plan.identity.id, "quickbooks.json"),
        write: () => writeQuickBooksScheduleState(plan, source, { ...value, last_run_failed: true }, options) };
    },
  },
];

for (const site of identityCases) for (const replacement of ["none", "destination", "staging", "staging-in-place", "squat-after-success"]) {
  test(`${site.name} retry identity: ${replacement}`, t => {
    const root = fixture(t);
    const restorePin = pinStagingMtime(root);
    t.after(restorePin);
    let fixtureError;
    const runFixture = action => {
      try { return action(); }
      catch (error) { fixtureError = error; throw error; }
    };
    const { path, write } = site.prepare(root, {
      protectFile: path => runFixture(() => protectWithMetadataChange(path)),
    });
    const before = fs.existsSync(path) ? fs.readFileSync(path) : null;
    const originalRename = fs.renameSync;
    const substitute = join(root, "substitute.json");
    const substituteBytes = Buffer.from("synthetic concurrent replacement\n");
    fs.writeFileSync(substitute, substituteBytes, { mode: 0o600 });
    let substituteIdentity = fs.lstatSync(substitute, { bigint: true });
    let calls = 0;
    let staged;
    globalThis.__brainRenameTestPlatform = "win32";
    fs.renameSync = (from, to) => {
      if (to !== path) return originalRename(from, to);
      calls++;
      staged = from;
      if (calls === 1) {
        if (replacement === "staging-in-place") runFixture(() => rewriteStagingInPlace(from));
        else if (["destination", "staging"].includes(replacement)) {
          const changed = replacement === "destination" ? to : from;
          if (fs.existsSync(changed)) originalRename(changed, `${from}.displaced`);
          originalRename(substitute, changed);
          substituteIdentity = fs.lstatSync(changed, { bigint: true });
        }
        throw Object.assign(new Error("synthetic rename refusal"), { code: "EPERM" });
      }
      const result = originalRename(from, to);
      if (replacement === "squat-after-success") {
        originalRename(substitute, from);
        substituteIdentity = fs.lstatSync(from, { bigint: true });
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      if (["none", "squat-after-success"].includes(replacement)) {
        write();
        assert.equal(calls, 2, "unchanged identities permit the retry");
        assert.ok(fs.existsSync(path));
        if (replacement === "squat-after-success") assertStagingSurvives(staged, substituteIdentity, substituteBytes);
        else assert.ok(!fs.existsSync(staged));
      } else {
        assert.throws(write, site.refusal);
        assert.equal(calls, 1, "identity drift must refuse before a second rename");
        if (replacement === "destination") assert.deepEqual(fs.readFileSync(path), substituteBytes);
        else if (before) assert.deepEqual(fs.readFileSync(path), before);
        else assert.ok(!fs.existsSync(path));
        if (replacement === "staging") assertStagingSurvives(staged, substituteIdentity, substituteBytes);
      }
    } finally {
      delete globalThis.__brainRenameTestPlatform;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
      // Product refusal wrappers must never turn a failed fixture precondition
      // into a passing negative case.
      if (fixtureError) throw fixtureError;
    }
  });
}

for (const site of identityCases.filter(site => ["answer manifest", "ingest checkpoint", "field checklist", "desktop binding", "schedule evidence"].includes(site.name))) {
  for (const failStat of [false, true]) test(`${site.name} create identity fstat: ${failStat ? "failure closes descriptor" : "control closes descriptor"}`, t => {
    const root = fixture(t);
    const { write } = site.prepare(root);
    const nativeOpen = fs.openSync, nativeStat = fs.fstatSync, nativeClose = fs.closeSync;
    let descriptor, injected = false, closed = 0;
    fs.openSync = (path, flags, ...args) => {
      const fd = nativeOpen(path, flags, ...args);
      const exclusive = typeof flags === "string" ? flags.includes("x")
        : (flags & fs.constants.O_EXCL) !== 0 && (flags & fs.constants.O_CREAT) !== 0;
      if (descriptor === undefined && exclusive && typeof path === "string" && path.startsWith(root)) descriptor = fd;
      return fd;
    };
    fs.fstatSync = (fd, ...args) => {
      if (failStat && fd === descriptor && !injected) {
        injected = true;
        throw Object.assign(new Error("synthetic staging stat refusal"), { code: "EIO" });
      }
      return nativeStat(fd, ...args);
    };
    fs.closeSync = fd => {
      if (fd === descriptor) closed++;
      return nativeClose(fd);
    };
    syncBuiltinESMExports();
    try {
      if (failStat) assert.throws(write);
      else write();
      assert.ok(descriptor !== undefined, "the fixture must create the staged descriptor");
      assert.equal(injected, failStat);
      assert.ok(closed >= 1, "a failed create-identity observation must still close its descriptor");
    } finally {
      fs.openSync = nativeOpen; fs.fstatSync = nativeStat; fs.closeSync = nativeClose;
      syncBuiltinESMExports();
      if (descriptor !== undefined && closed === 0) nativeClose(descriptor);
    }
  });
}

for (const site of identityCases) {
  test(`${site.name} exclusive-create refusal preserves the existing staging file`, t => {
    const root = fixture(t);
    const { write } = site.prepare(root);
    const nativeOpen = fs.openSync;
    const bytes = Buffer.from("synthetic existing staging file");
    let contested, identity;
    fs.openSync = (path, flags, ...args) => {
      const exclusive = typeof flags === "string" ? flags.includes("x")
        : (flags & fs.constants.O_EXCL) !== 0 && (flags & fs.constants.O_CREAT) !== 0;
      if (!contested && exclusive && typeof path === "string" && path.startsWith(root)) {
        contested = path;
        fs.writeFileSync(path, bytes);
        identity = fs.lstatSync(path, { bigint: true });
      }
      return nativeOpen(path, flags, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(write);
      assert.ok(contested, "the fixture must reach exclusive staging creation");
      assertStagingSurvives(contested, identity, bytes);
    } finally {
      fs.openSync = nativeOpen;
      syncBuiltinESMExports();
    }
  });
}

for (const replace of [false, true]) {
  test(`coverage ledger post-publish readback failure preserves ${replace ? "replacement" : "absence"} at staging path`, t => {
    const root = fixture(t);
    const path = join(root, "ledger.json");
    const nativeRename = fs.renameSync;
    const nativeRead = fs.readFileSync;
    const bytes = Buffer.from("synthetic next staging owner");
    let staged, identity, published = false;
    fs.renameSync = (from, to) => {
      const result = nativeRename(from, to);
      if (to === path) {
        published = true; staged = from;
        if (replace) { fs.writeFileSync(from, bytes); identity = fs.lstatSync(from, { bigint: true }); }
      }
      return result;
    };
    fs.readFileSync = (file, ...args) => {
      if (published && file === path) throw new Error("synthetic readback refusal");
      return nativeRead(file, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeCuratedCoverageLedger(path, { schema_version: 1 }), /coverage ledger could not be replaced safely/);
      if (replace) assertStagingSurvives(staged, identity, bytes);
      else assert.ok(!fs.existsSync(staged));
    } finally {
      fs.renameSync = nativeRename; fs.readFileSync = nativeRead;
      syncBuiltinESMExports();
    }
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "brain-rename-writers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function withRenameFault(targets, mode, action) {
  const originalRename = fs.renameSync;
  const entries = new Map(targets.map(path => [path, { calls: 0, errors: [] }]));
  fs.renameSync = (from, to) => {
    const entry = entries.get(to);
    if (!entry) return originalRename(from, to);
    entry.calls++;
    entry.staged ??= from;
    entry.bytes ??= fs.readFileSync(from);
    entry.inode ??= fs.statSync(from).ino;
    assert.ok(from === entry.staged, "retry must reuse the same staged path");
    assert.ok(entry.bytes.equals(fs.readFileSync(from)), "retry must reuse the same staged bytes");
    assert.equal(fs.statSync(from).ino, entry.inode, "retry must reuse the staged inode");
    if (mode === "terminal" || (mode === "transient" && entry.calls === 1)) {
      assert.ok(entry.calls <= 10, "writer retry must remain bounded");
      const error = Object.assign(new Error("synthetic rename refusal"), { code: "EPERM" });
      entry.errors.push(error);
      throw error;
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  let error;
  try { await action(); } catch (cause) { error = cause; }
  finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  return { entries, error };
}

function assertOutcome(result, path, mode, expected) {
  const entry = result.entries.get(path);
  assert.equal(entry.calls, expectedCalls(mode));
  assert.ok(entry.bytes.equals(Buffer.from(expected)), "staged bytes must match the complete intended value");
  if (expectedRefusal(mode)) {
    assert.ok(result.error === entry.errors.at(-1), "writer must preserve the final rename error object");
    assert.ok(fs.existsSync(entry.staged), "this writer retains its staged file on terminal failure");
  } else {
    assert.ok(!result.error, "writer must complete after any brief refusal");
    assert.equal(fs.readFileSync(path, "utf8"), expected);
    assert.ok(!fs.existsSync(entry.staged), "successful replacement consumes its staged file");
  }
}

for (const mode of modes) {
  test(`answer manifest writer: ${mode}`, async t => {
    const root = fixture(t);
    const path = join(root, "manifest.json");
    const before = json({ generation: 1 });
    const value = { generation: 2 };
    fs.writeFileSync(path, before);
    const result = await withRenameFault([path], mode, () => saveManifestAtomically(path, value));
    assertOutcome(result, path, mode, json(value));
    if (expectedRefusal(mode)) assert.equal(fs.readFileSync(path, "utf8"), before);
  });

  test(`answer setup journal writer: ${mode}`, async t => {
    const root = fixture(t);
    const manifestPath = join(root, "manifest.json");
    const manifest = { retrieval: {}, safety: {} };
    const before = json(manifest);
    fs.writeFileSync(manifestPath, before);
    const path = answerSetupJournalPath(manifestPath);
    const expected = answerSetupJournal(manifest, { mode: "dashboard", secretExisted: true });
    const result = await withRenameFault([path], mode, () => runAnthropicAnswerSetup({
      manifestPath, flags: { "key-set-in-dashboard": true },
    }, {
      platform: process.platform,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      listSecretNames: async () => [ANTHROPIC_SECRET_NAME],
      verifyVersion: async () => {},
      prepareDaily: async () => {},
      reconcileDaily: async () => {},
      verifyDeploy: async () => {},
      deploy: async () => {},
      // Keep the real journal available for exact readback in this fixture.
      removeJournal: () => {},
      checkWorker: async current => {
        const models = resolvedAnswerModels(current);
        return {
          answer: { model: models.answer_model, status: "ok" },
          check: { model: models.gate_model, status: "ok" },
        };
      },
      preflight: async () => { assert.fail("dashboard fixture must not call a provider"); },
      readClipboard: async () => { assert.fail("dashboard fixture must not read credentials"); },
    }));
    assertOutcome(result, path, mode, json(expected));
    if (expectedRefusal(mode)) {
      assert.ok(!fs.existsSync(path), "failed journal publication must not create a journal");
      assert.equal(fs.readFileSync(manifestPath, "utf8"), before, "rollback preserves the prior manifest");
    }
  });

  test(`field receipt and checklist default writers: ${mode}`, async t => {
    const root = fixture(t);
    const receiptPath = join(root, "receipt.json");
    const checklistPath = join(root, "checklist.md");
    const receipt = { generated_at: "2026-01-01T00:00:00.000Z", status: "running" };
    fs.writeFileSync(receiptPath, "prior receipt\n");
    fs.writeFileSync(checklistPath, "prior checklist\n");
    const result = await withRenameFault([receiptPath, checklistPath], mode, () =>
      persistReceiptArtifacts(receipt, { receiptPath, checklistPath }, { final: true }));
    assertOutcome(result, checklistPath, mode, `${renderFieldChecklist(receipt)}\n`);
    if (expectedRefusal(mode)) {
      assert.equal(result.entries.get(receiptPath).calls, 0, "failed checklist must prevent authoritative receipt replacement");
      assert.equal(fs.readFileSync(receiptPath, "utf8"), "prior receipt\n");
      assert.equal(fs.readFileSync(checklistPath, "utf8"), "prior checklist\n");
    } else {
      assertOutcome(result, receiptPath, mode, json(receipt));
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
        assert.equal(fs.statSync(checklistPath).mode & 0o777, 0o600);
      }
    }
  });
}

function answerSetupDependencies(checkWorker) {
  return {
    platform: process.platform,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    listSecretNames: async () => [ANTHROPIC_SECRET_NAME],
    verifyVersion: async () => {}, prepareDaily: async () => {}, reconcileDaily: async () => {},
    verifyDeploy: async () => {}, deploy: async () => {},
    checkWorker: checkWorker ?? (async current => {
      const models = resolvedAnswerModels(current);
      return { answer: { model: models.answer_model, status: "ok" }, check: { model: models.gate_model, status: "ok" } };
    }),
    preflight: async () => { assert.fail("dashboard fixture must not call a provider"); },
    readClipboard: async () => { assert.fail("dashboard fixture must not read credentials"); },
  };
}

for (const change of ["none", "journal-refused", "manifest-refused", "manifest-owned-rollback", "manifest-replaced", "journal-replaced"]) {
  test(`answer setup published ownership: ${change}`, async t => {
    const root = fixture(t);
    const manifestPath = join(root, "manifest.json");
    const journalPath = answerSetupJournalPath(manifestPath);
    fs.writeFileSync(manifestPath, json({ retrieval: {}, safety: {} }));
    const originalManifest = fs.readFileSync(manifestPath);
    const restorePin = pinStagingMtime(root);
    t.after(restorePin);
    const nativeRename = fs.renameSync;
    let replacement, replacementIdentity, replacementBytes, renameCalls = 0;
    const substitute = (path, bytes) => {
      const candidate = join(root, "other-writer.json");
      fs.writeFileSync(candidate, bytes, { flag: "wx" });
      if (fs.existsSync(path)) nativeRename(path, path + ".displaced");
      nativeRename(candidate, path);
      replacement = path; replacementIdentity = fs.lstatSync(path, { bigint: true }); replacementBytes = bytes;
    };
    globalThis.__brainRenameTestPlatform = "win32";
    fs.renameSync = (from, to) => {
      if ((change === "journal-refused" && to === journalPath) || (change === "manifest-refused" && to === manifestPath)) {
        if (++renameCalls === 1) {
          substitute(to, fs.readFileSync(from));
          throw Object.assign(new Error("synthetic rename refusal"), { code: "EPERM" });
        }
      }
      return nativeRename(from, to);
    };
    syncBuiltinESMExports();
    const deps = answerSetupDependencies(async current => {
      if (["manifest-owned-rollback", "manifest-replaced"].includes(change)) {
        if (change === "manifest-replaced") substitute(manifestPath, fs.readFileSync(manifestPath));
        throw new Error("synthetic check refusal");
      }
      if (change === "journal-replaced") substitute(journalPath, fs.readFileSync(journalPath));
      const models = resolvedAnswerModels(current);
      return { answer: { model: models.answer_model, status: "ok" }, check: { model: models.gate_model, status: "ok" } };
    });
    try {
      const result = runAnthropicAnswerSetup({ manifestPath, flags: { "key-set-in-dashboard": true } }, deps);
      if (change === "none") {
        await result;
        assert.ok(!fs.existsSync(journalPath), "successful setup removes its own journal");
      } else if (change === "manifest-owned-rollback") {
        await assert.rejects(result, error => error.rolledBack === true);
        assert.deepEqual(fs.readFileSync(manifestPath), originalManifest);
        assert.ok(!fs.existsSync(journalPath));
      } else {
        await assert.rejects(result);
        assertStagingSurvives(replacement, replacementIdentity, replacementBytes);
        if (change === "journal-refused") assert.deepEqual(fs.readFileSync(manifestPath), originalManifest);
        if (change === "manifest-refused") assert.equal(renameCalls, 1, "an unpublished manifest must not be rolled back");
      }
    } finally {
      delete globalThis.__brainRenameTestPlatform;
      fs.renameSync = nativeRename;
      syncBuiltinESMExports();
    }
  });
}

function inheritedImports() {
  const imports = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index];
    if (argument === "--import") imports.push(argument, process.execArgv[++index]);
    else if (argument.startsWith("--import=")) imports.push(argument);
  }
  return imports;
}

for (const mode of [...modes, "fstat-refusal"]) {
  test(`bundle manifest CLI generation writer: ${mode}`, t => {
    const root = fixture(t);
    const expected = {
      schema_version: 1,
      root_package: { name: "fixture-package", version: "1.0.0" },
      bundles: [{ name: "fixture-bundle", version: "1.0.0" }],
    };
    const inputPath = join(root, "generation-input.json");
    fs.writeFileSync(inputPath, json(expected));
    const target = join(root, "reviewed.json");
    const eventsPath = join(root, "events.json");
    fs.writeFileSync(target, "prior manifest\n");
    const child = spawnSync(process.execPath, [
      ...inheritedImports(),
      "--import", new URL("./fixtures/rename-retry-cli.mjs", import.meta.url).href,
      join(ROOT, "scripts/verify-package-bundles.mjs"),
      "--generate", "--root", root, "--cache-content-root", join(root, "cache"),
      "--output", target, "--replace",
    ], {
      cwd: ROOT, encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
        BRAIN_RENAME_WRITER_TARGET: target,
        BRAIN_RENAME_WRITER_EVENTS: eventsPath,
        BRAIN_RENAME_WRITER_MODE: mode,
        BRAIN_RENAME_WRITER_INPUT: inputPath,
        ...(process.env.BRAIN_RENAME_MUTANT ? { BRAIN_RENAME_MUTANT: process.env.BRAIN_RENAME_MUTANT } : {}),
      },
    });
    assert.ok(!child.error, "synthetic generation process must finish within its deadline");
    const events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
    if (mode === "fstat-refusal") {
      assert.equal(child.status, 1);
      assert.equal(events.createFstatFailed, true);
      assert.equal(events.createdDescriptorClosed, true, "a failed create-identity observation must still close its descriptor");
      assert.equal(events.calls, 0);
      assert.equal(fs.readFileSync(target, "utf8"), "prior manifest\n");
      return;
    }
    assert.equal(child.status, expectedRefusal(mode) ? 1 : 0, "CLI must reflect publication success or failure");
    assert.deepEqual(events, {
      calls: expectedCalls(mode),
      samePath: true, sameBytes: true, sameInode: true,
    });
    if (expectedRefusal(mode)) {
      assert.equal(fs.readFileSync(target, "utf8"), "prior manifest\n");
      assert.equal(fs.readFileSync(`${target}.tmp`, "utf8"), json(expected), "terminal refusal keeps the staged manifest");
      assert.match(child.stderr, /Package bundle verification failed: synthetic_rename_refusal/);
    } else {
      assert.equal(fs.readFileSync(target, "utf8"), json(expected));
      assert.ok(!fs.existsSync(`${target}.tmp`));
    }
  });
}

for (const mode of modes) {
  test(`installed manifest pointer writer: ${mode}`, async t => {
    const root = fixture(t);
    const options = { home: root, stateDirectory: join(root, "state") };
    const priorManifest = join(root, "prior.manifest.json");
    const nextManifest = join(root, "next.manifest.json");
    fs.writeFileSync(priorManifest, json({ generation: 1 }), { mode: 0o600 });
    fs.writeFileSync(nextManifest, json({ generation: 2 }), { mode: 0o600 });
    const priorCanonical = fs.realpathSync.native(priorManifest);
    const nextCanonical = fs.realpathSync.native(nextManifest);
    rememberInstalledManifest(priorManifest, options);
    assert.ok(readInstalledManifest(options) === priorCanonical, "fixture must remember its prior manifest");
    const path = installedManifestPointerPath(options);
    const priorBytes = fs.readFileSync(path);
    let remembered;
    const result = await withRenameFault([path], mode, () => {
      remembered = rememberInstalledManifest(nextManifest, options);
    });
    const entry = result.entries.get(path);
    assert.equal(entry.calls, expectedCalls(mode));
    assert.ok(entry.bytes.equals(Buffer.from(json({
      schema_version: 1, manifest_path: nextCanonical,
    }))), "staged pointer must name the canonical next manifest");
    assert.ok(!fs.existsSync(entry.staged), "pointer writer removes its staged file after success or refusal");
    assert.deepEqual(fs.readdirSync(options.stateDirectory), ["installed-manifest.json"]);
    if (expectedRefusal(mode)) {
      assert.ok(result.error === entry.errors.at(-1), "pointer writer preserves the last rename error");
      assert.ok(priorBytes.equals(fs.readFileSync(path)), "terminal refusal preserves the complete prior pointer");
      assert.ok(readInstalledManifest(options) === priorCanonical, "prior manifest remains selected after refusal");
    } else {
      assert.ok(!result.error, "pointer replacement must finish after any brief refusal");
      assert.ok(remembered.manifestPath === nextCanonical && remembered.replaced === true);
      assert.ok(readInstalledManifest(options) === nextCanonical, "durable readback must select the next manifest");
    }
  });
}

for (const mode of ["race-destination", "race-staging", "race-staging-in-place"]) {
  test(`bundle manifest CLI retry identity: ${mode}`, t => {
    const root = fixture(t);
    const inputPath = join(root, "generation-input.json");
    fs.writeFileSync(inputPath, json({ schema_version: 1, bundles: [] }));
    const target = join(root, "reviewed.json");
    const eventsPath = join(root, "events.json");
    fs.writeFileSync(target, "prior manifest\n");
    const child = spawnSync(process.execPath, [
      ...inheritedImports(), "--import", new URL("./fixtures/rename-retry-cli.mjs", import.meta.url).href,
      join(ROOT, "scripts/verify-package-bundles.mjs"), "--generate", "--root", root,
      "--cache-content-root", join(root, "cache"), "--output", target, "--replace",
    ], {
      cwd: ROOT, encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
        BRAIN_RENAME_WRITER_TARGET: target, BRAIN_RENAME_WRITER_EVENTS: eventsPath,
        BRAIN_RENAME_WRITER_MODE: mode, BRAIN_RENAME_WRITER_INPUT: inputPath,
        BRAIN_RENAME_TEST_PLATFORM: "win32",
        ...(process.env.BRAIN_RENAME_MUTANT ? { BRAIN_RENAME_MUTANT: process.env.BRAIN_RENAME_MUTANT } : {}),
      },
    });
    assert.ok(!child.error);
    assert.equal(child.status, 1);
    const events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
    assert.equal(events.calls, 1, "identity drift must prevent the next rename");
    assert.equal(fs.readFileSync(target, "utf8"), mode === "race-destination"
      ? "synthetic concurrent replacement\n" : "prior manifest\n");
    assert.match(child.stderr, /package_bundle_verification_failed/);
    if (mode === "race-staging-in-place") assert.equal(events.inPlaceInvisible, true);
    if (mode === "race-staging") {
      assert.equal(fs.lstatSync(`${target}.tmp`, { bigint: true }).ino.toString(), events.replacementInode);
      assert.equal(fs.readFileSync(`${target}.tmp`, "utf8"), "synthetic concurrent replacement\n");
    }
  });
}
