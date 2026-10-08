import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";
import { tokenStorageStatus } from "../connectors/google-auth.mjs";
import { previewSupportJournal } from "../support-journal.mjs";

const fixture = (name) => new URL(`./fixtures/${name}.mjs`, import.meta.url).href;
function child(args, environment = {}, imports = [], { hostPlatform = null, captureJournal = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-isolation-"));
  try {
    const result = spawnSync(process.execPath, [
      ...(hostPlatform ? ["--import", "data:text/javascript," + encodeURIComponent(
        `Object.defineProperty(process, "platform", { value: ${JSON.stringify(hostPlatform)} });`,
      )] : []),
      "--import", fixture("cli-side-effect-tripwire"),
      "--import", fixture("isolate-support-root"),
      "--import", fixture("support-journal-acl-preload"),
      ...imports.flatMap((name) => ["--import", fixture(name)]), ...args,
    ], { encoding: "utf8", timeout: 20_000, cwd: root, env: cliTestEnvironment(root, { USERNAME: "fixture-user", SystemRoot: "C:\\Windows", ...environment }) });
    if (captureJournal) result.journal = previewSupportJournal({ root });
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("CLI environment excludes ambient credentials, preloads and user configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-env-"));
  try {
    const environment = cliTestEnvironment(root, {}, {
      ADMIN_KEY: "ambient-sentinel", NODE_OPTIONS: "ambient-sentinel",
      BRAIN_GOOGLE_TOKEN_STORE: "keychain", HOME: "outside", PATH: "outside",
    });
    assert.equal(environment.HOME, root);
    assert.equal(environment.BRAIN_NO_WRANGLER_LOGIN, "1");
    assert.equal(environment.BRAIN_LIFECYCLE_LOCK_ROOT, join(root, "machine-locks"));
    assert.equal(environment.ADMIN_KEY, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.BRAIN_GOOGLE_TOKEN_STORE, undefined);
    assert.ok(!environment.PATH.includes("outside"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a CLI child reaches the real lifecycle resolver with a private lock root", () => {
  const module = new URL("../operations/brain-lifecycle-lock.mjs", import.meta.url).href;
  const result = child(["--input-type=module", "-e", `
    import { writeFileSync, realpathSync } from 'node:fs';
    import { join } from 'node:path';
    import { brainLifecycleCoordinates } from ${JSON.stringify(module)};
    const manifestPath = join(process.env.HOME, 'fixture.manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ brain: { domain: 'fixture.invalid' } }));
    console.log('TEST_LIFECYCLE_REACHED');
    const actual = brainLifecycleCoordinates({ manifestPath });
    console.log(actual.root === realpathSync(join(process.env.HOME, 'machine-locks'))
      ? 'TEST_LIFECYCLE_PRIVATE' : 'TEST_LIFECYCLE_SHARED');
  `]);
  assert.match(result.stdout, /TEST_LIFECYCLE_REACHED/);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TEST_LIFECYCLE_PRIVATE/);
  assert.doesNotMatch(result.stdout, /TEST_LIFECYCLE_SHARED/);
});

test("scratch HOME still selects Keychain; an explicit fixture file selects no native store", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-storage-"));
  let decisions = 0;
  const options = {
    platform: "darwin", home: root, env: {},
    runSecurity(args) {
      decisions++;
      assert.equal(args[0], "find-generic-password");
      assert.ok(!args.includes("-w"));
      return { status: 44, stdout: "", stderr: "" };
    },
  };
  try {
    assert.equal(tokenStorageStatus(options).backend, "keychain");
    assert.equal(decisions, 1, "native selection reached the injected metadata boundary");
    const file = tokenStorageStatus({ ...options, backend: "file", path: join(root, "absent-tokens.json") });
    assert.equal(file.backend, "file");
    assert.equal(file.exists, false);
    assert.equal(decisions, 1, "the explicit file control did not invoke a native helper");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const hostPlatform of [...new Set([process.platform, "win32"])])
for (const platform of ["darwin", "win32"]) {
  for (const state of ["missing", "ready"]) test(`real doctor CLI isolates ${platform} ${state} diagnostics on ${hostPlatform}`, () => {
    const result = child([fileURLToPath(new URL("../brain.mjs", import.meta.url)), "doctor"], {
      BRAIN_TEST_DOCTOR: state, BRAIN_TEST_DOCTOR_PLATFORM: platform,
    }, ["doctor-cli-preload"], { hostPlatform });
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /TEST_DOCTOR_STAGE:dispatch/);
    assert.match(output, /TEST_DOCTOR_STAGE:local/);
    assert.match(output, /TEST_DOCTOR_STAGE:network/);
    assert.doesNotMatch(output, /TEST_SIDE_EFFECT_BLOCKED/);
    if (hostPlatform === "win32" && state === "missing") assert.match(output, /TEST_SUPPORT_ACL_REACHED/);
    assert.equal(result.status, state === "ready" ? 0 : 1, output);
    const count = (stage) => output.split(`TEST_DOCTOR_STAGE:${stage}\n`).length - 1;
    assert.equal(count("google-storage"), 1);
    assert.equal(count("google-readable"), state === "ready" ? 1 : 0);
    assert.equal(count("windows-credentials"), platform === "win32" ? 1 : 0);
    assert.match(output, /Node/);
    assert.match(output, state === "ready" ? /ready to install/ : /What to do/);
    assert.doesNotMatch(output, /\bat .*\.mjs:\d+/);
  });
}

for (const [name, code, marker] of [
  ["native credential command", `import { spawnSync } from 'node:child_process'; spawnSync('security', ['find-generic-password']);`, "child_process.spawnSync"],
  ["Windows credential command", `import { execFileSync } from 'node:child_process'; execFileSync('powershell.exe', []);`, "child_process.execFileSync"],
  ["Wrangler login", `import { spawn } from 'node:child_process'; spawn('wrangler', ['login']);`, "child_process.spawn"],
  ["fetch", `await fetch('https://fixture.invalid');`, "fetch"],
  ["HTTPS", `import { get } from 'node:https'; get('https://fixture.invalid');`, "https.get"],
  ["socket", `import { Socket } from 'node:net'; new Socket().connect(443, 'fixture.invalid');`, "Socket.connect"],
  ["DNS", `import { lookup } from 'node:dns/promises'; await lookup('fixture.invalid');`, "dns"],
]) test(`tripwire terminates before ${name}, even inside a catch`, () => {
  const result = child(["--input-type=module", "-e", `console.log('TEST_ATTEMPT_REACHED'); try { ${code.replace(/import (.*?);/g, "")} } catch {} console.log('UNSAFE_CONTINUATION');\n${[...code.matchAll(/import .*?;/g)].map(([line]) => line).join("\n")}`]);
  assert.match(result.stdout, /TEST_ATTEMPT_REACHED/);
  assert.equal(result.status, 86);
  assert.equal(result.stderr.trim(), `TEST_SIDE_EFFECT_BLOCKED:${marker}`);
  assert.doesNotMatch(result.stdout, /UNSAFE_CONTINUATION/);
});

test("tripwire permits a harmless child control", () => {
  const result = child(["-e", "console.log('TEST_CONTROL_REACHED')"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /TEST_CONTROL_REACHED/);
  assert.equal(result.stderr, "");
});

for (const failAcl of [false, true]) test(`Windows support journal reaches the injected ACL, failure=${failAcl}`, () => {
  const module = new URL("../support-journal.mjs", import.meta.url).href;
  const result = child(["--input-type=module", "-e", `
    import { recordSupportEvent } from ${JSON.stringify(module)};
    console.log('TEST_JOURNAL_REACHED');
    try {
      const event = recordSupportEvent({ command: 'doctor', source: 'installer', errorCode: 'COMMAND_FAILED',
        productRelativeLocation: 'doctor.mjs' });
      console.log(/^evt_[0-9a-f]{32}$/.test(event.event_id) ? 'TEST_JOURNAL_SAVED' : 'TEST_JOURNAL_INVALID');
    } catch (error) {
      if (error.code !== 'SUPPORT_JOURNAL_UNSAFE_PATH') throw error;
      console.log('TEST_JOURNAL_REFUSED');
    }
  `], { BRAIN_TEST_SUPPORT_ACL_FAIL: failAcl ? "1" : "0" }, [], { hostPlatform: "win32" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TEST_JOURNAL_REACHED/);
  assert.match(result.stderr, /TEST_SUPPORT_ACL_REACHED/);
  assert.match(result.stdout, failAcl ? /TEST_JOURNAL_REFUSED/ : /TEST_JOURNAL_SAVED/);
  assert.doesNotMatch(result.stdout, failAcl ? /TEST_JOURNAL_SAVED/ : /TEST_JOURNAL_REFUSED/);
  assert.doesNotMatch(result.stderr, /TEST_SIDE_EFFECT_BLOCKED/);
});

test("support ACL injection does not permit unrelated Windows host actions", () => {
  const module = new URL("../operations/current-user-file.mjs", import.meta.url).href;
  const result = child(["--input-type=module", "-e", `
    import { restrictWindowsFileToCurrentUser } from ${JSON.stringify(module)};
    console.log('TEST_OTHER_ACL_REACHED');
    restrictWindowsFileToCurrentUser(process.env.HOME);
  `], {}, [], { hostPlatform: "win32" });
  assert.match(result.stdout, /TEST_OTHER_ACL_REACHED/);
  assert.equal(result.status, 86);
  assert.equal(result.stderr.trim(), "TEST_SIDE_EFFECT_BLOCKED:child_process.spawnSync");
});

test("the errors crash fixture writes its Windows support note through the injected ACL", () => {
  const result = child([fileURLToPath(new URL("../brain.mjs", import.meta.url)), "whatsnew"],
    {}, ["unexpected-crash"], { hostPlatform: "win32", captureJournal: true });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /unexpected error|bug in the installer/);
  assert.match(output, /TEST_SUPPORT_ACL_REACHED/);
  assert.match(output, /INTERNAL_ERROR/);
  assert.doesNotMatch(output, /TEST_SIDE_EFFECT_BLOCKED/);
  const events = result.journal.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].error_code, "INTERNAL_ERROR");
  assert.doesNotMatch(result.journal, /RAW_UNEXPECTED_CRASH_SENTINEL/);
});

test("owner doctor defaults still reach the real local diagnostics boundary", () => {
  const result = child([fileURLToPath(new URL("../brain.mjs", import.meta.url)), "doctor"]);
  assert.match(result.stdout, /Node/);
  assert.equal(result.status, 86);
  assert.equal(result.stderr.trim(), "TEST_SIDE_EFFECT_BLOCKED:child_process.spawnSync");
});

for (const mode of [0o600, 0o666])
test(`the errors ingest preload keeps Google file reads away from Windows DPAPI with mode ${mode.toString(8)}`, () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-storage-isolation-"));
  try {
    mkdirSync(join(root, ".brain"));
    writeFileSync(join(root, ".brain", "google-tokens.json"), JSON.stringify({ google: { scopes: ["drive"] } }), { mode: 0o600 });
    chmodSync(join(root, ".brain", "google-tokens.json"), mode);
    const keyPath = join(root, ".brain-admin-key");
    writeFileSync(keyPath, "fixture-admin", { mode: 0o600 });
    const storage = new URL("../connectors/google-auth.mjs", import.meta.url).href;
    const result = child(["--input-type=module", "-e", `
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { loadTokens, saveTokens } = await import(${JSON.stringify(storage)});
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const path = join(process.env.BRAIN_INGEST_EXIT_USER_ROOT, '.brain', 'google-tokens.json');
      const before = readFileSync(path);
      console.log('TEST_STORAGE_READ_REACHED');
      const record = loadTokens();
      console.log(record.google.scopes.length === 1 ? 'TEST_STORAGE_READ_OK' : 'TEST_STORAGE_READ_FAILED');
      console.log(before.equals(readFileSync(path)) ? 'TEST_STORAGE_READ_UNCHANGED' : 'TEST_STORAGE_READ_MUTATED');
      saveTokens({ google: { scopes: ['drive', 'gmail'] } });
      console.log(loadTokens().google.scopes.length === 2 ? 'TEST_STORAGE_WRITE_OK' : 'TEST_STORAGE_WRITE_FAILED');
    `], {
      BRAIN_INGEST_EXIT_TEST: "drive-failed", BRAIN_INGEST_EXIT_USER_ROOT: root,
      BRAIN_TEST_ADMIN_KEY_FILE: keyPath, BRAIN_GOOGLE_TOKEN_STORE: "file",
    }, ["ingest-exit-fetch"], { hostPlatform: "win32" });
    assert.match(result.stdout, /TEST_STORAGE_READ_REACHED/);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /TEST_STORAGE_READ_OK/);
    assert.match(result.stdout, /TEST_STORAGE_READ_UNCHANGED/);
    assert.match(result.stdout, /TEST_STORAGE_WRITE_OK/);
    assert.doesNotMatch(result.stderr, /TEST_SIDE_EFFECT_BLOCKED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
