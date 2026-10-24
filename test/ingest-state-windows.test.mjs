import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { saveState } from "../ingest/run.mjs";

const nativeOptions = {
  skip: process.platform !== "win32" && "requires native Windows FileShare.Read handle semantics",
  timeout: 20_000,
};
const prior = { version: 1, done: { fixture: "prior" }, skipped: {} };
const next = { version: 1, done: { fixture: "next" }, skipped: {} };

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-state-handle-")));
  const path = join(root, "state.json");
  writeFileSync(path, JSON.stringify(prior), { mode: 0o600 });
  return { root, path };
}

function assertState(path, expected) {
  // Keep assertion output to a boolean rather than printing checkpoint bytes.
  assert.ok(JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === JSON.stringify(expected),
    "checkpoint must contain the expected complete state");
}

function assertNoTemporarySibling(root) {
  assert.equal(readdirSync(root).filter(name => name.startsWith("state.json.tmp-")).length, 0,
    "state writer must remove its temporary sibling");
}

const holderScript = `
$ErrorActionPreference = 'Stop'
$root = $env:BRAIN_STATE_HOLDER_ROOT
$statePath = [IO.Path]::Combine($root, 'state.json')
$readyPath = [IO.Path]::Combine($root, 'ready')
$attemptPath = [IO.Path]::Combine($root, 'attempted')
$stopPath = [IO.Path]::Combine($root, 'stop')
$releaseDelay = [int]$env:BRAIN_STATE_HOLDER_RELEASE_MS
$handle = $null
try {
  $handle = [IO.File]::Open($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
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
      BRAIN_STATE_HOLDER_ROOT: root,
      BRAIN_STATE_HOLDER_RELEASE_MS: String(releaseDelay),
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

test("native checkpoint replacement succeeds without a competing handle", nativeOptions, () => {
  const f = fixture();
  try {
    let calls = 0;
    saveState(f.path, next, { rename(from, to) { calls++; renameSync(from, to); } });
    assert.equal(calls, 1, "uncontended replacement must perform exactly one rename");
    assertState(f.path, next);
    assertNoTemporarySibling(f.root);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native checkpoint replacement recovers after a delayed handle release", nativeOptions, async () => {
  const f = fixture();
  const holder = startHolder(f.root, 450);
  try {
    await waitUntilReady(f.root, holder);
    let calls = 0;
    let failures = 0;
    let error;
    try {
      saveState(f.path, next, { rename(from, to) {
        calls++;
        try { renameSync(from, to); } catch (cause) {
          failures++;
          // Start the release delay only after a real refused replacement.
          if (failures === 1) writeFileSync(join(f.root, "attempted"), "attempted");
          throw cause;
        }
      } });
    } catch (cause) { error = cause; }
    assert.ok(!error, "replacement must succeed after the holder releases");
    assert.ok(failures >= 1, "a native rename must fail before the holder releases");
    assert.equal(calls, failures + 1, "the final rename must be the single successful attempt");
    assert.ok(calls <= 10, "native recovery must stay inside the attempt budget");
    assertState(f.path, next);
    assertNoTemporarySibling(f.root);
  } finally {
    try { await stopHolder(f.root, holder); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("native checkpoint replacement refuses a handle held through every attempt", nativeOptions, async () => {
  const f = fixture();
  const holder = startHolder(f.root, -1);
  try {
    await waitUntilReady(f.root, holder);
    let calls = 0;
    let lastError;
    let error;
    try {
      saveState(f.path, next, { rename(from, to) {
        calls++;
        try { renameSync(from, to); } catch (cause) { lastError = cause; throw cause; }
      } });
    } catch (cause) { error = cause; }
    assert.ok(error && ["EPERM", "EACCES", "EBUSY"].includes(error.code),
      "held destination must return a native sharing refusal");
    assert.ok(error === lastError, "give-up must preserve the original rename error object");
    assert.equal(calls, 10, "held destination must exhaust exactly ten attempts");
    assert.equal(holder.isFinished(), false, "holder must remain active through the refusal");
    assertState(f.path, prior);
    assertNoTemporarySibling(f.root);
  } finally {
    try { await stopHolder(f.root, holder); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
