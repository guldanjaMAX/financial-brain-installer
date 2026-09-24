import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "test", "fixtures", "machine-prep");
const MAC = join(ROOT, "machine-prep", "prep-mac.sh");
const WINDOWS = join(ROOT, "machine-prep", "prep-windows.ps1");

function cleanEnv(fixture) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    HOME: "/fixture/home",
    USERPROFILE: "C:\\Users\\Fixture",
    LOCALAPPDATA: "C:\\Users\\Fixture\\AppData\\Local",
    APPDATA: "C:\\Users\\Fixture\\AppData\\Roaming",
    MACHINE_PREP_HOME: "/fixture/home",
    MACHINE_PREP_FIXTURE_DIR: fixture,
    MACHINE_PREP_TEST_MODE: "1",
  };
}

function runMac(args, fixture = "mac-not-ready") {
  return spawnSync("bash", [MAC, ...args], {
    cwd: ROOT,
    env: cleanEnv(join(FIXTURES, fixture)),
    encoding: "utf8",
  });
}

function windowsPowerShell() {
  if (process.platform !== "win32") return null;
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function runWindows(args, fixture = "windows-not-ready") {
  return spawnSync(windowsPowerShell(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS, ...args,
  ], {
    cwd: ROOT,
    env: cleanEnv(join(FIXTURES, fixture)),
    encoding: "utf8",
  });
}

function combined(result) {
  return `${result.stdout || ""}${result.stderr || ""}`.replaceAll("\r\n", "\n");
}

test("Mac check reaches every tool and reports missing, old, and shadowed states", () => {
  const result = runMac(["--check"]);
  const out = combined(result);
  assert.equal(result.status, 1, out);
  assert.match(out, /CHECKS_REACHED=10/);
  assert.match(out, /WRONG_VERSION  Node\.js/);
  assert.match(out, /MISSING        Claude Code/);
  assert.match(out, /WRONG_VERSION  Codex CLI/);
  assert.match(out, /SHADOWED       Financial Brain CLI/);
  assert.match(out, /MISSING        Xcode Command Line Tools/);
  assert.match(out, /READY          Wrangler/);
  assert.match(out, /READY          Python 3/);
});

test("Mac ready fixture is green and read-only", () => {
  const result = runMac(["--check"], "mac-ready");
  const out = combined(result);
  assert.equal(result.status, 0, out);
  assert.match(out, /READINESS GREEN/);
  assert.match(out, /CHECKS_REACHED=10/);
});

test("Mac dry-run output matches the reviewed snapshot and is idempotent", () => {
  const first = runMac(["--dry-run"]);
  const second = runMac(["--dry-run"]);
  const expected = readFileSync(join(FIXTURES, "mac-dry-run.txt"), "utf8");
  assert.equal(first.status, 0, combined(first));
  assert.equal(combined(first), expected);
  assert.equal(combined(second), expected);
});

test("Mac checksum mismatch reaches verification and refuses before action", () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-checksum-"));
  try {
    const artifact = join(directory, "artifact.bin");
    writeFileSync(artifact, "fixture artifact\n");
    const wrong = "0".repeat(64);
    const result = runMac(["--verify-checksum", artifact, wrong]);
    const out = combined(result);
    assert.equal(result.status, 2, out);
    assert.match(out, /CHECKSUM_DECISION_REACHED=1/);
    assert.match(out, /REFUSED checksum mismatch/);
    assert.doesNotMatch(out, /ACTION_EXECUTED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac checksum match is accepted only after the decision point", () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-checksum-"));
  try {
    const artifact = join(directory, "artifact.bin");
    const bytes = "fixture artifact\n";
    writeFileSync(artifact, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const result = runMac(["--verify-checksum", artifact, expected]);
    const out = combined(result);
    assert.equal(result.status, 0, out);
    assert.match(out, /CHECKSUM_DECISION_REACHED=1/);
    assert.match(out, /VERIFIED checksum/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac real mode refuses fixtures before any action", () => {
  const result = runMac(["--real"]);
  const out = combined(result);
  assert.equal(result.status, 2, out);
  assert.match(out, /REFUSED real mode while fixture\/test mode is active/);
  assert.doesNotMatch(out, /ACTION_EXECUTED|MODE real/);
});

test("both prototypes expose check, dry-run, real mode, and checksum gates", () => {
  const mac = readFileSync(MAC, "utf8");
  const windows = readFileSync(WINDOWS, "utf8");
  for (const source of [mac, windows]) {
    assert.match(source, /--check/);
    assert.match(source, /--dry-run/);
    assert.match(source, /CHECKSUM_DECISION_REACHED/);
    assert.match(source, /24\.13\.1/);
    assert.match(source, /2\.1\.261/);
    assert.match(source, /0\.155\.0-alpha\.16/);
    assert.doesNotMatch(source, /CLOUDFLARE_API_TOKEN|ADMIN_KEY|curl[^\n]*\|[^\n]*(?:sh|bash)/);
  }
});

test("Windows fixture coverage runs on the Windows CI lane", { skip: process.platform !== "win32" }, () => {
  const check = runWindows(["--check"]);
  const checkOut = combined(check);
  assert.equal(check.status, 1, checkOut);
  assert.match(checkOut, /CHECKS_REACHED=9/);
  assert.match(checkOut, /WRONG_VERSION  Node\.js/);
  assert.match(checkOut, /MISSING        Claude Code/);
  assert.match(checkOut, /WRONG_VERSION  Codex CLI/);
  assert.match(checkOut, /SHADOWED       Financial Brain CLI/);
  assert.match(checkOut, /READY          Wrangler/);

  const ready = runWindows(["--check"], "windows-ready");
  assert.equal(ready.status, 0, combined(ready));
  assert.match(combined(ready), /READINESS GREEN/);

  const first = runWindows(["--dry-run"]);
  const second = runWindows(["--dry-run"]);
  const expected = readFileSync(join(FIXTURES, "windows-dry-run.txt"), "utf8");
  assert.equal(first.status, 0, combined(first));
  assert.equal(combined(first), expected);
  assert.equal(combined(second), expected);

  const refused = runWindows(["--real"]);
  assert.equal(refused.status, 2, combined(refused));
  assert.match(combined(refused), /REFUSED real mode while fixture\/test mode is active/);
  assert.doesNotMatch(combined(refused), /ACTION_EXECUTED|MODE real/);
});

test("Windows checksum mismatch reaches verification and refuses before action", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-checksum-"));
  try {
    const artifact = join(directory, "artifact.bin");
    writeFileSync(artifact, "fixture artifact\n");
    const result = runWindows(["--verify-checksum", artifact, "0".repeat(64)]);
    const out = combined(result);
    assert.equal(result.status, 2, out);
    assert.match(out, /CHECKSUM_DECISION_REACHED=1/);
    assert.match(out, /REFUSED checksum mismatch/);
    assert.doesNotMatch(out, /ACTION_EXECUTED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
