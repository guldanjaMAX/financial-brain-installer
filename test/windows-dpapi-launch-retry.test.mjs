/**
 * Field evidence: on a Windows machine with Smart App Control on, Code
 * Integrity intermittently refuses to launch the freshly compiled, unsigned
 * DPAPI helper. A refused FILE stays refused, but a new compile in a new folder
 * usually runs. One shared retry therefore recompiles into a fresh private
 * folder, and only for a launch refusal, never for a definite DPAPI answer.
 *
 * These tests drive the real session module (private folder, compile, capture,
 * dispose) against a synthetic Windows runtime, so they run on any host.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { probeWindowsDpapi, readAdminKeyFile } from "../operations/admin-key-file.mjs";
import { loadTokens, saveTokens } from "../connectors/google-auth.mjs";
import {
  disposeWindowsDpapiSession,
  readWindowsDpapiSessionMetrics,
  resetWindowsDpapiSessionMetrics,
} from "../operations/windows-dpapi-session.mjs";

const bridgeFile = fileURLToPath(new URL("../operations/windows-dpapi-bridge.mjs", import.meta.url));

function fakeWindows() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-dpapi-retry-")));
  const systemRoot = join(root, "Windows");
  const compiler = join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const temp = join(root, "Temp");
  mkdirSync(dirname(compiler), { recursive: true });
  mkdirSync(temp);
  writeFileSync(compiler, "synthetic compiler");
  const environment = { SystemRoot: systemRoot, TEMP: temp, TMP: temp, USERNAME: "fixture-user" };
  const compiled = [];
  let compileFails = false;
  const spawnSyncFake = (command, args) => {
    if (command.endsWith("icacls.exe")) return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (command === compiler) {
      if (compileFails) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const helper = args.find((arg) => arg.startsWith("/out:")).slice(5);
      writeFileSync(helper, `synthetic helper ${compiled.length + 1}`);
      compiled.push(helper);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    throw new Error("unexpected helper command");
  };
  return {
    root,
    environment,
    compiled,
    failCompile() { compileFails = true; },
    dpapiSessionOptions: { spawnSync: spawnSyncFake },
    cleanup() {
      disposeWindowsDpapiSession();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const refusedBySpawn = () => ({
  status: null,
  error: Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN", errno: -4094 }),
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
});
const refusedAtLaunchStage = () => ({
  status: 1,
  stdout: Buffer.alloc(0),
  stderr: Buffer.from("BRAIN_DPAPI_STAGE:launch\n", "ascii"),
});

/**
 * A bridge fake whose answer depends on which compiled helper it was handed.
 * `refuse(helperIndex, operation)` returns a refusal result or null to run.
 */
function fakeBridge(windows, refuse, { decryptFails = false } = {}) {
  const calls = [];
  const runDpapiBridge = (command, args, details) => {
    const helper = args[args.indexOf("--helper") + 1];
    const operation = args[args.indexOf("--operation") + 1];
    const helperIndex = windows.compiled.indexOf(helper);
    calls.push({ helperIndex, operation });
    assert.ok(helperIndex >= 0, "the bridge receives only a helper the session compiled");
    assert.ok(existsSync(helper), "the bridge never receives a disposed helper");
    const refusal = refuse(helperIndex, operation);
    if (refusal) return refusal;
    if (operation === "unprotect" && decryptFails) {
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("BRAIN_DPAPI_STAGE:unprotect\n", "ascii") };
    }
    const stdout = operation === "protect"
      ? Buffer.from(`sealed:${details.input.toString("base64")}`, "ascii")
      : Buffer.from(details.input.toString("ascii").slice("sealed:".length), "base64");
    return { status: 0, stdout, stderr: Buffer.alloc(0) };
  };
  return { calls, runDpapiBridge };
}

function probe(windows, bridge) {
  return probeWindowsDpapi({
    platform: "win32",
    rounds: 2,
    environment: windows.environment,
    dpapiSessionOptions: windows.dpapiSessionOptions,
    runDpapiBridge: bridge.runDpapiBridge,
  });
}

const googleRecord = Object.freeze({
  client_id: "fixture-client",
  client_secret: "fixture-secret-value",
  refresh_token: "fixture-refresh-value",
});

const adminSecret = "fixture-admin-secret-for-dpapi-retry-tests";

function adminEnvelope(windows) {
  const directory = mkdtempSync(join(windows.root, "install-"));
  const path = join(directory, ".brain-admin-key");
  const sealed = Buffer.from(`sealed:${Buffer.from(adminSecret, "utf8").toString("base64")}`, "ascii");
  writeFileSync(path, `BRAIN-ADMIN-KEY-DPAPI-V1\n${sealed.toString("base64")}\n`, "ascii");
  return path;
}

function adminReadOptions(windows, bridge) {
  return {
    platform: "win32",
    environment: windows.environment,
    dpapiSessionOptions: windows.dpapiSessionOptions,
    runDpapiBridge: bridge.runDpapiBridge,
  };
}

function googleOptions(windows, bridge) {
  return {
    backend: "file",
    platform: "win32",
    path: join(windows.root, "google-tokens.json"),
    username: "fixture-user",
    environment: windows.environment,
    runAcl: () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    dpapiSessionOptions: windows.dpapiSessionOptions,
    runDpapiBridge: bridge.runDpapiBridge,
  };
}

test("admin key: a refused first helper is disposed and a fresh helper in a new folder completes the operation", () => {
  disposeWindowsDpapiSession();
  resetWindowsDpapiSessionMetrics();
  const windows = fakeWindows();
  try {
    const bridge = fakeBridge(windows, (index) => (index === 0 ? refusedBySpawn() : null));
    const result = probe(windows, bridge);
    assert.equal(result.passed, true, `probe failed at ${result.stage}`);
    assert.equal(windows.compiled.length, 2);
    assert.notEqual(dirname(windows.compiled[0]), dirname(windows.compiled[1]));
    assert.equal(existsSync(dirname(windows.compiled[0])), false, "the refused helper folder is removed");
    assert.equal(existsSync(dirname(windows.compiled[1])), false, "the working helper is removed after use");
    assert.deepEqual(bridge.calls.map((call) => call.helperIndex), [0, 1, 1, 1, 1]);
    const metrics = readWindowsDpapiSessionMetrics();
    assert.equal(metrics.compile_count, 2);
    assert.equal(metrics.launch_refusals, 1);
    assert.equal(metrics.max_launch_attempts, 2);
    assert.equal(result.launch_refusals, 1);
  } finally {
    windows.cleanup();
  }
});

test("admin key: three refusals stop with a plain Smart App Control error after exactly three compiles", () => {
  disposeWindowsDpapiSession();
  resetWindowsDpapiSessionMetrics();
  const windows = fakeWindows();
  try {
    const bridge = fakeBridge(windows, (index) => (index % 2 ? refusedAtLaunchStage() : refusedBySpawn()));
    const result = probe(windows, bridge);
    assert.equal(result.passed, false);
    assert.equal(result.stage, "launch_refused");
    assert.equal(result.issue_code, "WINDOWS_DPAPI_LAUNCH_REFUSED");
    assert.equal(windows.compiled.length, 3);
    assert.equal(new Set(windows.compiled.map((helper) => dirname(helper))).size, 3);
    for (const helper of windows.compiled) assert.equal(existsSync(dirname(helper)), false);
    const metrics = readWindowsDpapiSessionMetrics();
    assert.equal(metrics.compile_count, 3);
    assert.equal(metrics.launch_refusals, 3);
    assert.equal(metrics.max_launch_attempts, 3);

    // The owner-facing text, through the real read path of an admin key file.
    assert.throws(
      () => readAdminKeyFile(adminEnvelope(windows), adminReadOptions(windows, fakeBridge(windows, () => refusedBySpawn()))),
      (error) => /Windows refused to run/.test(error.message) &&
        /Smart App Control/.test(error.message) &&
        /re-running the command usually works/i.test(error.message) &&
        !error.message.includes(adminSecret) &&
        error.code === "WINDOWS_DPAPI_LAUNCH_REFUSED",
    );
    assert.equal(windows.compiled.length, 6);
  } finally {
    windows.cleanup();
  }
});

test("admin key: reading the key file gets the same retry", () => {
  disposeWindowsDpapiSession();
  resetWindowsDpapiSessionMetrics();
  const windows = fakeWindows();
  try {
    const bridge = fakeBridge(windows, (index) => (index === 0 ? refusedAtLaunchStage() : null));
    assert.equal(readAdminKeyFile(adminEnvelope(windows), adminReadOptions(windows, bridge)), adminSecret);
    assert.equal(windows.compiled.length, 2);
    assert.equal(existsSync(dirname(windows.compiled[0])), false, "the refused helper folder is removed");
    assert.equal(readWindowsDpapiSessionMetrics().launch_refusals, 1);
  } finally {
    windows.cleanup();
  }
});

test("Google credential: the same retry recovers a refused helper launch", () => {
  disposeWindowsDpapiSession();
  resetWindowsDpapiSessionMetrics();
  const windows = fakeWindows();
  try {
    const bridge = fakeBridge(windows, (index) => (index === 0 ? refusedBySpawn() : null));
    const options = googleOptions(windows, bridge);
    saveTokens(googleRecord, options);
    assert.deepEqual(loadTokens(options), googleRecord);
    assert.equal(windows.compiled.length, 2);
    assert.notEqual(dirname(windows.compiled[0]), dirname(windows.compiled[1]));
    assert.equal(existsSync(dirname(windows.compiled[0])), false, "the refused helper folder is removed");
    assert.equal(readWindowsDpapiSessionMetrics().launch_refusals, 1);
  } finally {
    windows.cleanup();
  }
});

test("Google credential: three refusals name Smart App Control and say a re-run usually works", () => {
  disposeWindowsDpapiSession();
  resetWindowsDpapiSessionMetrics();
  const windows = fakeWindows();
  try {
    const bridge = fakeBridge(windows, () => refusedBySpawn());
    assert.throws(
      () => saveTokens(googleRecord, googleOptions(windows, bridge)),
      (error) => /Windows refused to run/.test(error.message) &&
        /Smart App Control/.test(error.message) &&
        /re-running the command usually works/i.test(error.message) &&
        !error.message.includes(googleRecord.refresh_token),
    );
    assert.equal(windows.compiled.length, 3);
    assert.equal(existsSync(join(windows.root, "google-tokens.json")), false);
  } finally {
    windows.cleanup();
  }
});

test("a definite DPAPI decrypt error is never retried", () => {
  disposeWindowsDpapiSession();
  resetWindowsDpapiSessionMetrics();
  const windows = fakeWindows();
  try {
    const bridge = fakeBridge(windows, () => null, { decryptFails: true });
    const result = probe(windows, bridge);
    assert.equal(result.passed, false);
    assert.equal(result.stage, "unprotect");
    assert.equal(windows.compiled.length, 1);
    assert.equal(readWindowsDpapiSessionMetrics().launch_refusals, 0);

    disposeWindowsDpapiSession();
    // Save verifies by decrypting, so seal with a working helper first.
    saveTokens(googleRecord, googleOptions(windows, fakeBridge(windows, () => null)));
    const google = fakeBridge(windows, () => null, { decryptFails: true });
    const options = googleOptions(windows, google);
    const before = windows.compiled.length;
    assert.throws(() => loadTokens(options), /could not decrypt/);
    assert.equal(windows.compiled.length, before, "the Google decrypt failure did not recompile");
    assert.equal(google.calls.filter((call) => call.operation === "unprotect").length, 1);
  } finally {
    windows.cleanup();
  }
});

test("a compile failure is never retried", () => {
  disposeWindowsDpapiSession();
  resetWindowsDpapiSessionMetrics();
  const windows = fakeWindows();
  try {
    windows.failCompile();
    const bridge = fakeBridge(windows, () => null);
    const result = probe(windows, bridge);
    assert.equal(result.passed, false);
    assert.equal(result.stage, "compile");
    assert.equal(bridge.calls.length, 0);
    let compileAttempts = 0;
    const counting = {
      spawnSync(command, args, options) {
        if (!command.endsWith("icacls.exe")) compileAttempts++;
        return windows.dpapiSessionOptions.spawnSync(command, args, options);
      },
    };
    assert.throws(() => saveTokens(googleRecord, {
      ...googleOptions(windows, bridge),
      dpapiSessionOptions: counting,
    }), /could not protect/);
    assert.equal(compileAttempts, 1);
    assert.equal(bridge.calls.length, 0);
  } finally {
    windows.cleanup();
  }
});

test("the bridge reports a helper that never started as the launch stage, and a helper that ran and failed as its operation", {
  skip: process.platform === "win32" ? "POSIX execute bits model the refused and the running helper" : false,
}, () => {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-dpapi-bridge-launch-")));
  try {
    const run = (helper) => {
      const identity = lstatSync(helper);
      return spawnSync(process.execPath, [
        bridgeFile,
        "--helper", helper,
        "--sha256", createHash("sha256").update(readFileSync(helper)).digest("hex"),
        "--size", String(identity.size),
        "--dev", String(identity.dev),
        "--ino", String(identity.ino),
        "--operation", "protect",
        "--length", "4",
        "--max", "65536",
      ], {
        encoding: "utf8",
        input: Buffer.from([1, 2, 3, 4]),
        env: { SystemRoot: "/fixture/windows", USERNAME: "fixture-user" },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
    };
    const refusedDirectory = join(sandbox, "refused");
    mkdirSync(refusedDirectory);
    const refused = join(refusedDirectory, "windows-dpapi-helper.exe");
    writeFileSync(refused, "not executable here");
    chmodSync(refused, 0o600);
    const launch = run(refused);
    assert.notEqual(launch.status, 0);
    assert.match(launch.stderr, /BRAIN_DPAPI_STAGE:launch\n/);
    assert.equal(launch.stdout, "");

    const ranDirectory = join(sandbox, "ran");
    mkdirSync(ranDirectory);
    const ran = join(ranDirectory, "windows-dpapi-helper.exe");
    writeFileSync(ran, "#!/bin/sh\ncat >/dev/null\nexit 1\n");
    chmodSync(ran, 0o700);
    const definite = run(ran);
    assert.notEqual(definite.status, 0);
    assert.match(definite.stderr, /BRAIN_DPAPI_STAGE:protect\n/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
