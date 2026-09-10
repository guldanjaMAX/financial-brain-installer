import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const path = fileURLToPath(new URL("../tools/preflight.ps1", import.meta.url));
const script = readFileSync(path, "utf8");
const workflowPaths = [
  "../.github/workflows/ci.yml",
  "../.github/workflows/windows-rehearsal.yml",
];
const workflows = workflowPaths.map((relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"));

test("Windows preflight blocks unsupported OS, elevation, and low per-user disk space", () => {
  assert.match(script, /OSVersion\.Version/);
  assert.match(script, /Major -lt 10/);
  assert.match(script, /Windows 10 or newer/);
  assert.match(script, /WindowsBuiltInRole\]::Administrator/);
  assert.match(script, /running as Administrator/);
  assert.match(script, /LOCALAPPDATA drive/);
  assert.match(script, /AvailableFreeSpace -lt 2GB/);
  assert.match(script, /at least 2 GiB before download/);
});

test("Windows preflight uses native package identity and keeps path detection as defense in depth", () => {
  assert.match(script, /GetCurrentPackageFullName/);
  assert.match(script, /APPMODEL|15700/);
  assert.match(script, /ERROR_INSUFFICIENT_BUFFER|122/);
  assert.match(script, /packageContext\.Known/);
  assert.match(script, /packageContext\.Packaged/);
  assert.match(script, /APPDATA -like '\*\\Packages\\\*'/);
  assert.match(script, /LOCALAPPDATA -like '\*\\Packages\\\*'/);
  assert.match(script, /Open PowerShell from the Start menu/);
  assert.doesNotMatch(script, /else \{ Ok "not running inside an MSIX/);
});
test("the machine-only preflight does not pretend to prove account or billing state", () => {
  assert.match(script, /Cloudflare authorization is not proven here/i);
  assert.doesNotMatch(script, /Workers Paid (?:is|plan is) (?:active|verified)/i);
});

test("elevated Windows CI proves the production refusal without bypassing it", () => {
  for (const workflow of workflows) {
    assert.match(workflow, /control: the elevated CI machine is stopped for exactly that reason/);
    assert.match(workflow, /STOP\.\*running as Administrator/);
    assert.match(workflow, /expected only the Administrator STOP/);
    assert.match(workflow, /the Administrator STOP must exit 1/);
    assert.match(workflow, /packaged preflight must refuse the elevated hosted runner/);
    assert.match(workflow, /the packaged Administrator STOP must exit 1/);
    assert.match(workflow, /this process has no Windows package identity/);
    assert.match(workflow, /PowerShell 7 proves the native unpackaged-process branch/);
    assert.match(workflow, /POWERSHELL 7 NATIVE PACKAGE CHECK PASSED/);
    assert.match(workflow, /trap 2: an app-package data path remains fail-closed/);
    assert.doesNotMatch(workflow, /SKIP_(?:ADMIN|MACHINE)|ALLOW_(?:ADMIN|ELEVATED)/);
  }
});
