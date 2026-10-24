import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_SECRET_NAME, answerSetupJournal, answerSetupJournalPath,
  resolvedAnswerModels, runAnthropicAnswerSetup, saveManifestAtomically,
} from "../operations/answer-setup.mjs";
import {
  installedManifestPointerPath, readInstalledManifest, rememberInstalledManifest,
} from "../operations/installed-manifest.mjs";
import { persistReceiptArtifacts, renderFieldChecklist } from "../scripts/field-prepare.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const modes = ["control", "transient", "terminal"];

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
  assert.equal(entry.calls, mode === "terminal" ? 10 : mode === "transient" ? 2 : 1);
  assert.ok(entry.bytes.equals(Buffer.from(expected)), "staged bytes must match the complete intended value");
  if (mode === "terminal") {
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
    if (mode === "terminal") assert.equal(fs.readFileSync(path, "utf8"), before);
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
    if (mode === "terminal") {
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
    if (mode === "terminal") {
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

function inheritedImports() {
  const imports = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index];
    if (argument === "--import") imports.push(argument, process.execArgv[++index]);
    else if (argument.startsWith("--import=")) imports.push(argument);
  }
  return imports;
}

for (const mode of modes) {
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
    assert.equal(child.status, mode === "terminal" ? 1 : 0, "CLI must reflect publication success or failure");
    const events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
    assert.deepEqual(events, {
      calls: mode === "terminal" ? 10 : mode === "transient" ? 2 : 1,
      samePath: true, sameBytes: true, sameInode: true,
    });
    if (mode === "terminal") {
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
    assert.equal(entry.calls, mode === "terminal" ? 10 : mode === "transient" ? 2 : 1);
    assert.ok(entry.bytes.equals(Buffer.from(json({
      schema_version: 1, manifest_path: nextCanonical,
    }))), "staged pointer must name the canonical next manifest");
    assert.ok(!fs.existsSync(entry.staged), "pointer writer removes its staged file after success or refusal");
    assert.deepEqual(fs.readdirSync(options.stateDirectory), ["installed-manifest.json"]);
    if (mode === "terminal") {
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
