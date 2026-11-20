import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const entrypoint = fileURLToPath(new URL("../brain.mjs", import.meta.url));
const tripwire = new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href;
const machineFixture = new URL("./fixtures/setup-public-preflight.mjs", import.meta.url).href;
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function runPublicSetup(extra = [], { conflict = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "setup-public-output-"));
  try {
    const target = join(root, "brain.manifest.json");
    const calls = join(root, "preflight-calls.jsonl");
    writeFileSync(calls, "");
    writeFileSync(join(root, ".brain-admin-key"), ["fixture", "setup", "value"].join("-"), { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "--import", tripwire, "--import", machineFixture,
      entrypoint, "setup", target,
      ...(conflict ? ["--cloudflare-token", "--browser-sign-in"] : [
        "--browser-sign-in", "--name", "Owner Brain", "--slug", "owner-brain",
        "--cloudflare-account", "existing", "--cloudflare-account-id", "a".repeat(32),
        "--workers-paid-confirmed",
      ]), ...extra,
    ], {
      encoding: "utf8", cwd: root, timeout: 30_000,
      env: cliTestEnvironment(root, { BRAIN_TEST_SETUP_CALLS: calls }),
    });
    assert.ifError(result.error);
    const output = strip(`${result.stdout || ""}${result.stderr || ""}`);
    assert.notEqual(result.status, 86, "setup reached an uninjected host action");
    assert.doesNotMatch(output, /TEST_SIDE_EFFECT_BLOCKED:/);
    return {
      output, status: result.status, manifestWritten: existsSync(target),
      calls: readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function assertStoppedAtPreflight(run) {
  assert.equal(run.status, 1);
  assert.deepEqual(run.calls, [{ stage: "preflight", skipCloudflare: true, requireClaudeCode: true }],
    "the real wrapper must reach exactly one local machine check before stopping");
  assert.equal(run.manifestWritten, false);
}

test("CONTROL: public setup reaches its sign-in conflict decision before machine or credential work", () => {
  const run = runPublicSetup([], { conflict: true });
  assert.equal(run.status, 1);
  assert.match(run.output, /choose either fresh browser sign-in or recovery-token access/);
  assert.deepEqual(run.calls, []);
  assert.equal(run.manifestWritten, false);
});

test("public setup accepts verbose and still reaches the same sign-in conflict decision", () => {
  const run = runPublicSetup(["--verbose"], { conflict: true });
  assert.equal(run.status, 1);
  assert.match(run.output, /choose either fresh browser sign-in or recovery-token access/);
  assert.deepEqual(run.calls, []);
  assert.equal(run.manifestWritten, false);
});

test("CONTROL: the public machine failure is reached and prevents manifest creation", () => {
  const run = runPublicSetup();
  assertStoppedAtPreflight(run);
  assert.match(run.output, /Claude Code[^\n]*not signed in/);
  assert.match(run.output, /Open Claude Code once and sign in\./);
});

test("public preflight matches the owner STEP heading, glyphs, and action directly below each check", () => {
  const run = runPublicSetup();
  assertStoppedAtPreflight(run);
  assert.match(run.output, /^  STEP 1 of 6 · checking this computer$/m);
  assert.match(run.output, /^  ✓    Node\.js · ready$/m);
  assert.match(run.output, /^  !    Install folder · needs room\n    Make room for files\./m);
  assert.match(run.output, /^  ✗    Claude Code · Needs you · not signed in\n    Open Claude Code once and sign in\.\n    Then retry setup\./m);
  assert.doesNotMatch(run.output, /FAIL|Free disk space/);
  assert.ok(run.output.includes(renderCliCommands("Fix the items above, then run brain setup again.")));
  assert.equal(run.output.includes(renderCliCommands("brain init <path>")), false);
});

test("public verbose preflight keeps technician details and the first-run hint behind the flag", () => {
  const run = runPublicSetup(["--verbose"]);
  assertStoppedAtPreflight(run);
  assert.match(run.output, /^  STEP 1 of 6 · checking this computer$/m);
  assert.match(run.output, /^  !    Free disk space · 3\.1 GiB free$/m);
  assert.ok(run.output.includes(renderCliCommands("brain init <path>")));
});

test("CONTROL: unsupported public JSON remains rejected before the machine checks", () => {
  const run = runPublicSetup(["--json"]);
  assert.equal(run.status, 1);
  assert.match(run.output, /unknown option --json/);
  assert.deepEqual(run.calls, []);
  assert.equal(run.manifestWritten, false);
});
