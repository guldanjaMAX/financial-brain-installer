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
