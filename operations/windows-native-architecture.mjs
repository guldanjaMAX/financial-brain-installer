/**
 * Native-Windows x64 gate for operations whose reviewed field path is x64-only.
 *
 * The gate owns no application filesystem, credential, or network capability.
 * On Windows it launches one fixed, noninteractive Windows PowerShell command
 * that reads the framework's native OSArchitecture value. It compiles no code
 * and creates no script or result file. The native result is checked before the
 * independent Node process architecture check, so x64 emulation on ARM64
 * cannot qualify.
 */

import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

export const WINDOWS_NATIVE_ARCHITECTURE_SCHEMA_VERSION = 1;
export const WINDOWS_NATIVE_ARCHITECTURE_KIND = "windows_native_architecture_gate";
export const WINDOWS_NATIVE_ARCHITECTURE_TIMEOUT_MS = 10_000;
export const WINDOWS_NATIVE_ARCHITECTURE_MAX_BUFFER_BYTES = 4_096;
export const WINDOWS_NATIVE_ARCHITECTURE_FAILURE_CODES = Object.freeze([
  "PLATFORM_UNSUPPORTED",
  "SYSTEM_POWERSHELL_UNAVAILABLE",
  "NATIVE_ARCHITECTURE_PROBE_TIMEOUT",
  "NATIVE_ARCHITECTURE_PROBE_FAILED",
  "NATIVE_ARCHITECTURE_PROBE_INVALID",
  "NATIVE_ARCHITECTURE_UNSUPPORTED",
  "NODE_ARCHITECTURE_UNSUPPORTED",
]);

const FAILURE_CODE_SET = new Set(WINDOWS_NATIVE_ARCHITECTURE_FAILURE_CODES);
const RESULT_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "status",
  "eligible",
  "intended_architecture",
  "probe_method",
  "native_windows_architecture",
  "node_process_architecture",
  "failure",
]);
const FAILURE_KEYS = Object.freeze(["code"]);
const POWERSHELL_ARGUMENTS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
]);
const NATIVE_X64 = "NATIVE_X64";
const NATIVE_NON_X64 = new Set(["NATIVE_ARM64", "NATIVE_X86", "NATIVE_OTHER"]);
const REVIEWED_WINDOWS_ROOT = "C:\\Windows";

// RuntimeInformation reports the operating-system architecture rather than the
// architecture of an emulated PowerShell process. Unlike Add-Type/PInvoke, the
// fixed probe cannot invoke a compiler or create compiler-temporary files.
const POWERSHELL_SOURCE = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$nativeArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($nativeArchitecture) {
  'X64' { [Console]::Out.Write('NATIVE_X64') }
  'Arm64' { [Console]::Out.Write('NATIVE_ARM64') }
  'X86' { [Console]::Out.Write('NATIVE_X86') }
  default { [Console]::Out.Write('NATIVE_OTHER') }
}`;
const POWERSHELL_ENCODED_COMMAND = Buffer.from(POWERSHELL_SOURCE, "utf16le").toString("base64");

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

/** Pure validator for the complete public result contract. */
export function assertWindowsNativeArchitectureResult(result) {
  try {
    if (!exactKeys(result, RESULT_KEYS) ||
        result.schema_version !== WINDOWS_NATIVE_ARCHITECTURE_SCHEMA_VERSION ||
        result.kind !== WINDOWS_NATIVE_ARCHITECTURE_KIND ||
        result.intended_architecture !== "x64" ||
        result.probe_method !== "runtime_information_os_architecture") {
      throw new TypeError("Windows native architecture result is outside the fixed contract");
    }

    if (result.status === "verified") {
      if (result.eligible !== true || result.native_windows_architecture !== "x64" ||
          result.node_process_architecture !== "x64" || result.failure !== null) {
        throw new TypeError("Windows native architecture result is outside the fixed contract");
      }
      return result;
    }

    if (result.status !== "blocked" || result.eligible !== false ||
        result.native_windows_architecture !== null ||
        result.node_process_architecture !== null ||
        !exactKeys(result.failure, FAILURE_KEYS) ||
        !FAILURE_CODE_SET.has(result.failure.code)) {
      throw new TypeError("Windows native architecture result is outside the fixed contract");
    }
    return result;
  } catch {
    throw new TypeError("Windows native architecture result is outside the fixed contract");
  }
}

function fixedResult(failureCode = null) {
  const verified = failureCode === null;
  const result = {
    schema_version: WINDOWS_NATIVE_ARCHITECTURE_SCHEMA_VERSION,
    kind: WINDOWS_NATIVE_ARCHITECTURE_KIND,
    status: verified ? "verified" : "blocked",
    eligible: verified,
    intended_architecture: "x64",
    probe_method: "runtime_information_os_architecture",
    native_windows_architecture: verified ? "x64" : null,
    node_process_architecture: verified ? "x64" : null,
    failure: verified ? null : Object.freeze({ code: failureCode }),
  };
  assertWindowsNativeArchitectureResult(result);
  return Object.freeze(result);
}

// The held field route supports the standard C:\Windows installation only.
// Treating an arbitrary ambient SystemRoot as executable authority would let a
// parent process substitute its own powershell.exe and forge the native result.
// A nonstandard Windows root therefore stops instead of weakening this gate.
function systemPowerShell(systemRoot) {
  if (typeof systemRoot !== "string" || systemRoot.length < 4 || systemRoot.length > 200 ||
      systemRoot !== systemRoot.trim() || systemRoot.includes("/") ||
      !/^[A-Za-z]:\\[^<>:"|?*\u0000-\u001f]+$/u.test(systemRoot)) {
    return null;
  }
  const root = systemRoot.endsWith("\\") ? systemRoot.slice(0, -1) : systemRoot;
  const segments = root.slice(3).split("\\");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." ||
      /[. ]$/u.test(segment)) || win32.normalize(root) !== root ||
      root.toLowerCase() !== REVIEWED_WINDOWS_ROOT.toLowerCase()) {
    return null;
  }
  return Object.freeze({
    root,
    command: win32.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  });
}

function timedOut(error) {
  return error?.code === "ETIMEDOUT" || error?.errno === "ETIMEDOUT";
}

/**
 * Probe the native Windows architecture, then independently require x64 Node.
 * Every dependency is resolved before any application IO can be introduced.
 */
export function probeWindowsNativeArchitecture(options = {}) {
  if (!plainObject(options)) return fixedResult("NATIVE_ARCHITECTURE_PROBE_FAILED");

  let platform;
  try {
    platform = Object.hasOwn(options, "platform") ? options.platform : process.platform;
  } catch {
    return fixedResult("NATIVE_ARCHITECTURE_PROBE_FAILED");
  }
  if (platform !== "win32") return fixedResult("PLATFORM_UNSUPPORTED");

  let spawn;
  let configuredSystemRoot;
  try {
    spawn = Object.hasOwn(options, "spawn") ? options.spawn : spawnSync;
    configuredSystemRoot = Object.hasOwn(options, "systemRoot")
      ? options.systemRoot
      : process.env.SystemRoot ?? process.env.WINDIR;
  } catch {
    return fixedResult("NATIVE_ARCHITECTURE_PROBE_FAILED");
  }
  const powershell = systemPowerShell(configuredSystemRoot);
  if (!powershell) return fixedResult("SYSTEM_POWERSHELL_UNAVAILABLE");
  if (typeof spawn !== "function") return fixedResult("NATIVE_ARCHITECTURE_PROBE_FAILED");

  let child;
  try {
    child = spawn(
      powershell.command,
      [...POWERSHELL_ARGUMENTS, POWERSHELL_ENCODED_COMMAND],
      {
        encoding: "utf8",
        env: {
          SystemRoot: powershell.root,
          WINDIR: powershell.root,
        },
        maxBuffer: WINDOWS_NATIVE_ARCHITECTURE_MAX_BUFFER_BYTES,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: WINDOWS_NATIVE_ARCHITECTURE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (error) {
    return fixedResult(timedOut(error)
      ? "NATIVE_ARCHITECTURE_PROBE_TIMEOUT"
      : "NATIVE_ARCHITECTURE_PROBE_FAILED");
  }

  try {
    if (!plainObject(child)) return fixedResult("NATIVE_ARCHITECTURE_PROBE_FAILED");
    if (timedOut(child.error)) return fixedResult("NATIVE_ARCHITECTURE_PROBE_TIMEOUT");
    if (child.error != null || child.status !== 0 || child.signal !== null) {
      return fixedResult("NATIVE_ARCHITECTURE_PROBE_FAILED");
    }
    if (typeof child.stdout !== "string" || typeof child.stderr !== "string" ||
        child.stderr !== "") {
      return fixedResult("NATIVE_ARCHITECTURE_PROBE_INVALID");
    }
    if (NATIVE_NON_X64.has(child.stdout)) {
      return fixedResult("NATIVE_ARCHITECTURE_UNSUPPORTED");
    }
    if (child.stdout !== NATIVE_X64) {
      return fixedResult("NATIVE_ARCHITECTURE_PROBE_INVALID");
    }
  } catch {
    return fixedResult("NATIVE_ARCHITECTURE_PROBE_FAILED");
  }

  let arch;
  try {
    // Deliberately read only after the independent native-machine probe passes.
    arch = Object.hasOwn(options, "arch") ? options.arch : process.arch;
  } catch {
    return fixedResult("NODE_ARCHITECTURE_UNSUPPORTED");
  }
  if (arch !== "x64") return fixedResult("NODE_ARCHITECTURE_UNSUPPORTED");
  return fixedResult();
}
