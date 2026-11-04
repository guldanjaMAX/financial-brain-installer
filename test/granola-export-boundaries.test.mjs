import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import child from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";
import { readGranolaExportAtCwd } from "../connectors/granola-export-reader.mjs";

const implementation = process.env.GRANOLA_EXPORT_MODULE
  ? pathToFileURL(resolve(process.env.GRANOLA_EXPORT_MODULE)).href
  : new URL("../connectors/granola-export.mjs", import.meta.url).href;
const { importGranolaExport, planGranolaExport, validateGranolaConfig } = await import(implementation);
const full = JSON.parse(readFileSync(new URL("./fixtures/granola/full.json", import.meta.url)));
const linkType = process.platform === "win32" ? "junction" : "dir";

function inputs(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "granola-boundary-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "reviewed", "exports");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "record.json");
  writeFileSync(file, JSON.stringify(full));
  return { parent, config: { enabled: true, source: "meeting-export", owner_email: full.owner_email,
    transport: "file-export", format: "granola.meeting.v1", export_path: root }, files: [file] };
}

function link(t, target, path) {
  try { symlinkSync(target, path, linkType); }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Directory link creation is unavailable on this host.");
      return false;
    }
    throw error;
  }
  assert.equal(lstatSync(path).isSymbolicLink(), true, "the ancestor link exists");
  return true;
}

function intercept(t, method, wrapper) {
  const original = fs[method];
  fs[method] = (...args) => wrapper(original, ...args);
  syncBuiltinESMExports();
  t.after(() => { fs[method] = original; syncBuiltinESMExports(); });
}

async function attempt(input, fixture) {
  const calls = [];
  let error, result;
  try {
    result = await importGranolaExport(input, { request: async (path, body) => {
      calls.push(path);
      return fixture.post(path, body, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    } });
  } catch (caught) { error = caught; }
  return { calls, error, result, documents: fixture.first("SELECT count(*) n FROM documents").n };
}

for (const mode of [0o700, 0o777]) {
  test(`root identity refuses an ancestor retarget after first lstat, replacement mode ${mode.toString(8)}`, async t => {
    if (process.platform === "win32" && mode === 0o777) return t.skip("POSIX permission control.");
    const input = inputs(t);
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const outside = join(input.parent, "outside", "exports");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    chmodSync(outside, mode);
    writeFileSync(join(outside, "record.json"), JSON.stringify({ ...full, id: "replacement-record" }));
    const alias = join(input.parent, "ancestor-link");
    if (!link(t, join(input.parent, "reviewed"), alias)) return;
    const root = join(alias, "exports");
    const linked = { config: { ...input.config, export_path: root }, files: [join(root, "record.json")] };
    assert.equal((await planGranolaExport(linked)).documents.length, 1, "green unchanged ancestor control");
    if (mode === 0o777) {
      const direct = await attempt({ config: { ...input.config, export_path: outside },
        files: [join(outside, "record.json")] }, fixture);
      assert.equal(direct.error?.code, "GRANOLA_FILE_UNSAFE", "replacement permissions are refused directly");
      assert.equal(direct.calls.length, 0);
    }
    let reached = 0;
    intercept(t, "lstat", async (original, path, ...options) => {
      const stat = await original(path, ...options);
      if (path === root && reached === 0) {
        reached++;
        unlinkSync(alias);
        symlinkSync(join(input.parent, "outside"), alias, linkType);
        assert.notEqual(realpathSync(root), input.config.export_path, "the real ancestor was retargeted");
      }
      return stat;
    });
    const run = await attempt(linked, fixture);
    assert.equal(reached, 1, "the real root lstat completed before retargeting");
    assert.equal(run.error?.code, "GRANOLA_FILE_UNSAFE", "changed root identity must refuse");
    assert.equal(run.error?.stage, "file");
    assert.equal(run.calls.length, 0);
    assert.equal(run.documents, 0);
  });
}

for (const boundary of ["realpath", "root-open", "member-realpath", "reader-start", "reader-finish"]) {
  test(`canonical root replacement at ${boundary} refuses before delivery`, async t => {
    if (process.platform === "win32") return t.skip("Directory rename while open requires a native host gate.");
    const input = inputs(t);
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    assert.equal((await planGranolaExport(input)).documents.length, 1, "green original-root control");
    const root = input.config.export_path;
    const replacement = join(input.parent, "replacement");
    mkdirSync(replacement, { mode: 0o700 });
    writeFileSync(join(replacement, "record.json"), JSON.stringify({ ...full, id: "replacement-record" }));
    let reached = 0;
    const replace = () => {
      reached++;
      renameSync(root, join(input.parent, "held-root"));
      renameSync(replacement, root);
    };
    if (boundary === "realpath" || boundary === "member-realpath") {
      intercept(t, "realpath", async (original, path, ...options) => {
        const canonical = await original(path, ...options);
        if (path === (boundary === "realpath" ? root : input.files[0]) && reached === 0) replace();
        return canonical;
      });
    } else if (boundary === "root-open") {
      intercept(t, "open", async (original, path, ...options) => {
        const handle = await original(path, ...options);
        if (reached === 0 && path === root) replace();
        return handle;
      });
    } else {
      const original = child.execFile;
      child.execFile = (file, args, options, callback) => {
        if (reached === 0 && options.cwd === root) {
          if (boundary === "reader-start") replace();
          else return original(file, args, options, (...result) => { replace(); callback(...result); });
        }
        return original(file, args, options, callback);
      };
      syncBuiltinESMExports();
      t.after(() => { child.execFile = original; syncBuiltinESMExports(); });
    }
    const run = await attempt(input, fixture);
    assert.equal(reached, 1, "the selected real filesystem boundary was exercised");
    assert.equal(run.error?.code, "GRANOLA_FILE_UNSAFE");
    assert.equal(run.calls.length, 0);
    assert.equal(run.documents, 0);
  });
}

test("the reader keeps member opens relative to its pinned cwd after a root rename", t => {
  if (process.platform === "win32") return t.skip("Directory rename while open requires a native host gate.");
  const input = inputs(t);
  const root = input.config.export_path;
  const replacement = join(input.parent, "replacement");
  mkdirSync(replacement, { mode: 0o700 });
  writeFileSync(join(replacement, "record.json"), JSON.stringify({ ...full, id: "replacement-record" }));
  const selected = lstatSync(input.files[0]), originalRoot = lstatSync(root);
  const previousCwd = process.cwd();
  process.chdir(root);
  const originalOpen = fsSync.openSync;
  let reached = 0;
  fsSync.openSync = (path, ...options) => {
    if (path === "record.json" && reached === 0) {
      reached++;
      renameSync(root, join(input.parent, "held-root"));
      renameSync(replacement, root);
    }
    return originalOpen(path, ...options);
  };
  try {
    const bytes = readGranolaExportAtCwd({ member: "record.json", root: originalRoot, entry: selected });
    assert.equal(reached, 1, "the root pathname was replaced immediately before the real member open");
    assert.equal(JSON.parse(bytes.toString("utf8")).id, full.id, "the original directory supplies the bytes");
    assert.notEqual(lstatSync(root).ino, originalRoot.ino, "the pathname now names the replacement");
  } finally {
    fsSync.openSync = originalOpen;
    process.chdir(previousCwd);
  }
});

for (const boundary of ["request", "registration-json", "batch-json"]) {
  test(`incoming conflict code is sanitized at ${boundary}`, async t => {
    const input = inputs(t);
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    assert.equal((await planGranolaExport(input)).documents.length, 1, "nonempty plan reaches delivery");
    const green = await attempt(input, fixture);
    assert.equal(green.result?.created, 1, "green transport control stores the planned record");
    assert.equal(green.calls.length, 2);
    for (const code of ["ORDINARY_ADAPTER_FAILURE", "GRANOLA_SOURCE_KIND_CONFLICT"]) {
      const markers = ["synthetic private note marker", "attendee@example.invalid", "synthetic transcript marker"];
      const thrown = Object.assign(new Error(markers.join(" ")), { code, stage: "untrusted", detail: markers[2] });
      let reached = 0, calls = 0, error;
      try {
        await importGranolaExport(input, { request: async (path, body) => {
          calls++;
          if (boundary === "request") { reached++; throw thrown; }
          const response = await fixture.post(path, body, { "X-Admin-Key": fixture.env.ADMIN_KEY });
          if ((boundary === "registration-json" && path.endsWith("source-register")) ||
              (boundary === "batch-json" && path.endsWith("/batch"))) {
            return { ok: true, status: 200, json: async () => { reached++; throw thrown; } };
          }
          return response;
        } });
      } catch (caught) { error = caught; }
      assert.equal(reached, 1, "the selected transport or reader exception was thrown");
      assert.equal(calls, boundary === "batch-json" ? 2 : 1);
      assert.notEqual(error, thrown, "incoming exception is never propagated");
      assert.equal(error?.code, boundary === "batch-json" ? "GRANOLA_IMPORT_INCOMPLETE" : "GRANOLA_REGISTRATION_UNVERIFIED");
      assert.equal(error.stage, "delivery");
      assert.deepEqual(Object.keys(error).sort(), ["code", "stage"]);
      for (const marker of markers) {
        assert.equal(String(error).includes(marker), false);
        assert.equal(JSON.stringify(error).includes(marker), false);
        assert.equal(error.stack.includes(marker), false);
      }
    }
  });
}

test("an actual registration conflict produces a fresh fixed registry error", async t => {
  const input = inputs(t);
  assert.equal((await planGranolaExport(input)).documents.length, 1);
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const green = await attempt(input, fixture);
  assert.equal(green.result?.created, 1);
  assert.equal(green.calls.length, 2);
  let calls = 0, reads = 0, error;
  try {
    await importGranolaExport(input, { request: async path => {
      calls++;
      assert.equal(path.endsWith("source-register"), true);
      return { status: 409, ok: false, json: async () => { reads++; throw new Error("untrusted response detail"); } };
    } });
  } catch (caught) { error = caught; }
  assert.equal(calls, 1, "the HTTP conflict reached source registration");
  assert.equal(reads, 0, "untrusted conflict details are unnecessary");
  assert.equal(error?.code, "GRANOLA_SOURCE_KIND_CONFLICT");
  assert.equal(error.stage, "registry");
  assert.equal(error.message, "Declared source is registered with an incompatible kind.");
  assert.deepEqual(Object.keys(error).sort(), ["code", "stage"]);
});

test("foreign absolute syntax cannot become a working-directory-relative export root", async t => {
  const input = inputs(t);
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const green = await attempt(input, fixture);
  assert.equal(green.result?.created, 1, "native fully bound root succeeds");
  assert.equal(green.calls.length, 2);
  const refusedFixture = await createProductFixture();
  t.after(() => refusedFixture.close());
  if (process.platform === "win32") {
    for (const path of ["C:\\review-export", "C:/review-export", "\\\\host.invalid\\share\\exports"]) {
      assert.equal(validateGranolaConfig({ ...input.config, export_path: path }).export_path, path,
        "native drive and UNC validation never contacts the named location");
    }
    for (const path of ["/review-export", "\\review-export", "C:review-export"]) {
      const run = await attempt({ ...input, config: { ...input.config, export_path: path } }, refusedFixture);
      assert.equal(run.error?.code, "GRANOLA_CONFIG_INVALID");
      assert.equal(run.calls.length, 0);
      assert.equal(run.documents, 0);
    }
    return;
  }
  // Creating this literal directory proves the old parser could import it.
  // Keep the ambiguous cwd spelling inside this test's private fixture.
  const previousCwd = process.cwd();
  process.chdir(input.parent);
  t.after(() => process.chdir(previousCwd));
  const foreign = "C:\\review-export";
  const root = resolve(foreign);
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "record.json"), JSON.stringify({ ...full, id: "foreign-record" }));
  assert.equal(lstatSync(root).isDirectory(), true, "the ambiguous root exists with valid source data");
  assert.equal((await planGranolaExport({ config: { ...input.config, export_path: root },
    files: [join(root, "record.json")] })).documents.length, 1, "native spelling of that directory is valid");
  const run = await attempt({ config: { ...input.config, export_path: foreign }, files: [join(root, "record.json")] }, refusedFixture);
  assert.equal(run.error?.code, "GRANOLA_CONFIG_INVALID", "foreign syntax must refuse at configuration");
  assert.equal(run.calls.length, 0);
  assert.equal(run.documents, 0, "refusal writes no documents");
  for (const path of ["\\\\host.invalid\\share\\exports", "C:/review-export", "\\review-export"]) {
    assert.throws(() => validateGranolaConfig({ ...input.config, export_path: path }),
      error => error.code === "GRANOLA_CONFIG_INVALID");
  }
});
