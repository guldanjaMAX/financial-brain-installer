import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WINDOWS_NATIVE_ARCHITECTURE_FAILURE_CODES,
  WINDOWS_NATIVE_ARCHITECTURE_KIND,
  WINDOWS_NATIVE_ARCHITECTURE_MAX_BUFFER_BYTES,
  WINDOWS_NATIVE_ARCHITECTURE_SCHEMA_VERSION,
  WINDOWS_NATIVE_ARCHITECTURE_TIMEOUT_MS,
  assertWindowsNativeArchitectureResult,
  probeWindowsNativeArchitecture,
} from "../operations/windows-native-architecture.mjs";

const SYSTEM_ROOT = "C:\\Windows";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const successChild = Object.freeze({
  status: 0,
  signal: null,
  error: undefined,
  stdout: "NATIVE_X64",
  stderr: "",
});

function runWithChild(child, { arch = "x64", spawn: providedSpawn } = {}) {
  const calls = [];
  const spawn = providedSpawn ?? ((command, args, options) => {
    calls.push({ command, args, options });
    return child;
  });
  const result = probeWindowsNativeArchitecture({
    platform: "win32",
    arch,
    systemRoot: SYSTEM_ROOT,
    spawn,
  });
  return { calls, result };
}

function failureCode(result) {
  assert.equal(result.status, "blocked");
  assert.equal(result.eligible, false);
  assert.equal(result.native_windows_architecture, null);
  assert.equal(result.node_process_architecture, null);
  return result.failure.code;
}

/* The accepted result is exact, frozen, and produced by one bounded child. */
{
  const { calls, result } = runWithChild(successChild);
  assert.deepEqual(result, {
    schema_version: WINDOWS_NATIVE_ARCHITECTURE_SCHEMA_VERSION,
    kind: WINDOWS_NATIVE_ARCHITECTURE_KIND,
    status: "verified",
    eligible: true,
    intended_architecture: "x64",
    probe_method: "runtime_information_os_architecture",
    native_windows_architecture: "x64",
    node_process_architecture: "x64",
    failure: null,
  });
  assert.equal(assertWindowsNativeArchitectureResult(result), result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);

  const [{ command, args, options }] = calls;
  assert.equal(command, POWERSHELL);
  assert.deepEqual(args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  assert.equal(args.length, 5);
  const script = Buffer.from(args[4], "base64").toString("utf16le");
  assert.match(script, /RuntimeInformation/);
  assert.match(script, /OSArchitecture/);
  assert.match(script, /NATIVE_X64/);
  assert.match(script, /NATIVE_ARM64/);
  assert.match(script, /NATIVE_X86/);
  assert.doesNotMatch(script, /Add-Type|DllImport|\.ps1|New-TemporaryFile|\[IO\.Path\]::GetTemp/i);

  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.encoding, "utf8");
  assert.equal(options.timeout, WINDOWS_NATIVE_ARCHITECTURE_TIMEOUT_MS);
  assert.equal(options.timeout, 10_000);
  assert.equal(options.maxBuffer, WINDOWS_NATIVE_ARCHITECTURE_MAX_BUFFER_BYTES);
  assert.equal(options.maxBuffer, 4_096);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(options.env, { SystemRoot: SYSTEM_ROOT, WINDIR: SYSTEM_ROOT });
  assert.equal("cwd" in options, false);
  assert.equal("input" in options, false);
}

/* Non-Windows and an ambiguous system PowerShell path stop before spawn. */
{
  for (const platform of ["darwin", "linux", "freebsd"]) {
    let spawned = false;
    const result = probeWindowsNativeArchitecture({
      platform,
      arch: "x64",
      systemRoot: SYSTEM_ROOT,
      spawn: () => { spawned = true; throw new Error("must not run"); },
    });
    assert.equal(failureCode(result), "PLATFORM_UNSUPPORTED");
    assert.equal(spawned, false);
  }

  for (const systemRoot of [
    undefined,
    "",
    "Windows",
    "\\\\server\\Windows",
    "C:/Windows",
    "C:\\Windows\\..\\Other",
    "C:\\Windows\\.",
    "D:\\Windows",
    "C:\\SyntheticWindows",
    " C:\\Windows",
    "C:\\Windows ",
  ]) {
    let spawned = false;
    const result = probeWindowsNativeArchitecture({
      platform: "win32",
      arch: "x64",
      systemRoot,
      spawn: () => { spawned = true; throw new Error("must not run"); },
    });
    assert.equal(failureCode(result), "SYSTEM_POWERSHELL_UNAVAILABLE");
    assert.equal(spawned, false);
  }
}

/* Native ARM64 and x86 are refused even when the Node process says x64. */
{
  for (const stdout of ["NATIVE_ARM64", "NATIVE_X86", "NATIVE_OTHER"]) {
    const { result } = runWithChild({ ...successChild, stdout }, { arch: "x64" });
    assert.equal(failureCode(result), "NATIVE_ARCHITECTURE_UNSUPPORTED");
  }
}

/* The Node architecture is read only after the native OS proof passes. */
{
  const events = [];
  const options = {
    platform: "win32",
    systemRoot: SYSTEM_ROOT,
    spawn: () => {
      events.push("native_probe");
      return successChild;
    },
    get arch() {
      events.push("node_arch");
      return "x64";
    },
  };
  assert.equal(probeWindowsNativeArchitecture(options).eligible, true);
  assert.deepEqual(events, ["native_probe", "node_arch"]);

  for (const arch of ["arm64", "ia32", "x32", "unknown", null]) {
    const { calls, result } = runWithChild(successChild, { arch });
    assert.equal(calls.length, 1);
    assert.equal(failureCode(result), "NODE_ARCHITECTURE_UNSUPPORTED");
  }
}

/* Timeouts, process failures, output ambiguity, and stderr all fail closed. */
{
  for (const child of [
    null,
    { ...successChild, status: 1 },
    { ...successChild, signal: "SIGTERM" },
    { ...successChild, error: { code: "EACCES" } },
  ]) {
    const { result } = runWithChild(child);
    assert.equal(failureCode(result), "NATIVE_ARCHITECTURE_PROBE_FAILED");
  }
  for (const child of [
    { ...successChild, stdout: "" },
    { ...successChild, stdout: "NATIVE_X64\r\n" },
    { ...successChild, stdout: "NATIVE_X64 NATIVE_ARM64" },
    { ...successChild, stdout: Buffer.from("NATIVE_X64") },
    { ...successChild, stderr: "warning" },
  ]) {
    const { result } = runWithChild(child);
    assert.equal(failureCode(result), "NATIVE_ARCHITECTURE_PROBE_INVALID");
  }

  assert.equal(failureCode(runWithChild({
    ...successChild,
    status: null,
    error: { code: "ETIMEDOUT" },
  }).result), "NATIVE_ARCHITECTURE_PROBE_TIMEOUT");
  assert.equal(failureCode(runWithChild(successChild, {
    spawn: () => {
      const error = new Error("synthetic private process failure");
      error.code = "ETIMEDOUT";
      throw error;
    },
  }).result), "NATIVE_ARCHITECTURE_PROBE_TIMEOUT");
  assert.equal(failureCode(runWithChild(successChild, {
    spawn: () => { throw new Error("synthetic private process failure"); },
  }).result), "NATIVE_ARCHITECTURE_PROBE_FAILED");

  const hostileChild = { ...successChild };
  Object.defineProperty(hostileChild, "stdout", {
    enumerable: true,
    get() { throw new Error("synthetic private child getter"); },
  });
  assert.equal(
    failureCode(runWithChild(hostileChild).result),
    "NATIVE_ARCHITECTURE_PROBE_FAILED",
  );
}

/* Ambient architecture hints and PATH cannot influence the fixed invocation. */
{
  const names = ["PATH", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432"];
  const prior = new Map(names.map((name) => [name, {
    present: Object.hasOwn(process.env, name),
    value: process.env[name],
  }]));
  try {
    process.env.PATH = "C:\\synthetic-untrusted-path";
    process.env.PROCESSOR_ARCHITECTURE = "ARM64";
    process.env.PROCESSOR_ARCHITEW6432 = "AMD64";
    const { calls, result } = runWithChild(successChild);
    assert.equal(result.eligible, true);
    assert.equal(calls[0].command, POWERSHELL);
    assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["SystemRoot", "WINDIR"]);
  } finally {
    for (const [name, saved] of prior) {
      if (saved.present) process.env[name] = saved.value;
      else delete process.env[name];
    }
  }
}

/* Malformed result objects fail with one identity-free validator error. */
{
  assert.deepEqual(WINDOWS_NATIVE_ARCHITECTURE_FAILURE_CODES, [
    "PLATFORM_UNSUPPORTED",
    "SYSTEM_POWERSHELL_UNAVAILABLE",
    "NATIVE_ARCHITECTURE_PROBE_TIMEOUT",
    "NATIVE_ARCHITECTURE_PROBE_FAILED",
    "NATIVE_ARCHITECTURE_PROBE_INVALID",
    "NATIVE_ARCHITECTURE_UNSUPPORTED",
    "NODE_ARCHITECTURE_UNSUPPORTED",
  ]);
  const privateValue = "synthetic-private-identity";
  const validFailure = probeWindowsNativeArchitecture({ platform: "linux" });
  assert.equal(assertWindowsNativeArchitectureResult(validFailure), validFailure);
  assert.equal(Object.isFrozen(validFailure), true);
  assert.equal(Object.isFrozen(validFailure.failure), true);

  for (const value of [
    null,
    {},
    { ...validFailure, private_value: privateValue },
    { ...validFailure, status: "verified" },
    { ...validFailure, native_windows_architecture: "arm64" },
    { ...validFailure, failure: { code: privateValue } },
    { ...validFailure, failure: { code: "PLATFORM_UNSUPPORTED", detail: privateValue } },
  ]) {
    let thrown;
    try {
      assertWindowsNativeArchitectureResult(value);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof TypeError);
    assert.equal(thrown.message.includes(privateValue), false);
  }

  const hostileResult = new Proxy(validFailure, {
    ownKeys() { throw new Error(privateValue); },
  });
  let hostileError;
  try {
    assertWindowsNativeArchitectureResult(hostileResult);
  } catch (error) {
    hostileError = error;
  }
  assert(hostileError instanceof TypeError);
  assert.equal(hostileError.message.includes(privateValue), false);
}

/* The module has no application filesystem, credential, or network import. */
{
  const source = readFileSync(
    new URL("../operations/windows-native-architecture.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from ["']node:(?:fs|http|https|net|tls)["']/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /from ["'][^"']*(?:keychain|credential)[^"']*["']/i);
}

console.log("windows native architecture gate tests passed");
