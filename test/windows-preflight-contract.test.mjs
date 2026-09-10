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
    assert.doesNotMatch(workflow, /SKIP_(?:ADMIN|MACHINE)|ALLOW_(?:ADMIN|ELEVATED)/);
  }
});
