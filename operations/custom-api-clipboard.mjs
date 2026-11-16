import { spawnSync } from "node:child_process";
import { win32 as win32Path } from "node:path";
import { isatty } from "node:tty";

import { localToolEnvironment } from "../doctor.mjs";

const CLIPBOARD_TIMEOUT_MS = 10_000;
const CLIPBOARD_MAX_BUFFER_BYTES = 64 * 1024;

function windowsPowerShellPath(environment) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  if (!win32Path.isAbsolute(String(systemRoot || ""))) {
    throw new Error("Windows system runtime directory is unavailable");
  }
  return win32Path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function runClipboardCommand(command, args, {
  input,
  output = "pipe",
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  const result = spawn(command, args, {
    encoding: "utf8",
    env: localToolEnvironment(environment),
    input,
    maxBuffer: CLIPBOARD_MAX_BUFFER_BYTES,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", output, "pipe"],
    timeout: CLIPBOARD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0 || result?.signal) {
    throw new Error("clipboard command failed");
  }
  return result;
}

/** Read clipboard text without putting the value in argv, env, files, or output. */
export function readCustomApiClipboard({
  platform = process.platform,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    const result = runClipboardCommand(
      windowsPowerShellPath(environment),
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      { spawn, environment },
    );
    if (typeof result.stdout !== "string") throw new Error("clipboard command returned invalid output");
    return result.stdout;
  }
  if (platform === "darwin") {
    const result = runClipboardCommand("pbpaste", [], { spawn, environment });
    if (typeof result.stdout !== "string") throw new Error("clipboard command returned invalid output");
    return result.stdout;
  }
  throw new Error("clipboard entry is unavailable on this platform");
}

// Windows PowerShell 5.1 rejects `Set-Clipboard -Value $null` (and an empty
// value), so the old clear threw and left a secret on the clipboard (partner
// PC reproduction, 2026-10-25). Clear through WinForms (powershell.exe is STA),
// overwrite with a harmless word only if that throws, then read back in the
// same process and exit nonzero if any other text is still there. A clear is
// reported only when the readback proves it.
export const WINDOWS_CLIPBOARD_CLEAR_SCRIPT =
  "try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear() } " +
  "catch { Set-Clipboard -Value 'cleared' }; " +
  "$fbClipboardLeft = ([string](Get-Clipboard -Raw)).Trim(); " +
  "if ($fbClipboardLeft -and $fbClipboardLeft -ne 'cleared') { exit 3 }";

// Windows console input flush. A process that never reads its console leaves
// whatever is typed or pasted into the window meanwhile in the console's input
// buffer. When it exits, the parent PowerShell reads that text as its next
// command line: shown in full, run with Enter, and saved to PSReadLine's
// plain-text history. The Google step on Windows waits up to 30 minutes
// without reading the keyboard, so it throws that input away when it ends.
// Nothing is read or printed. FlushInputBuffer empties the console the child
// shares with this process; the [Console] loop is the fallback. stdin is
// inherited on purpose: with no inherited stdio, Node's windowsHide starts the
// child with CREATE_NO_WINDOW, which gives it a new hidden console, and the
// flush would empty that one instead.
export const WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT =
  "try { $Host.UI.RawUI.FlushInputBuffer() } " +
  "catch { try { while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) } } catch { exit 3 } }";

/**
 * Best effort: discard keystrokes waiting in this Windows console. Runs only
 * when stdin is a console (a visible window); never throws.
 */
export function flushWindowsConsoleInput({
  platform = process.platform,
  spawn = spawnSync,
  environment = process.env,
  stdinIsConsole = () => isatty(0),
} = {}) {
  if (platform !== "win32") return false;
  try {
    if (!stdinIsConsole()) return false;
    const result = spawn(
      windowsPowerShellPath(environment),
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT],
      {
        env: localToolEnvironment(environment),
        shell: false,
        stdio: ["inherit", "ignore", "ignore"],
        timeout: CLIPBOARD_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return !result?.error && result?.status === 0 && !result?.signal;
  } catch {
    return false;
  }
}

/** Clear the clipboard through the matching native no-shell process. */
export function clearCustomApiClipboard({
  platform = process.platform,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    runClipboardCommand(
      windowsPowerShellPath(environment),
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CLIPBOARD_CLEAR_SCRIPT],
      { spawn, environment, output: "ignore" },
    );
    return;
  }
  if (platform === "darwin") {
    runClipboardCommand("pbcopy", [], { spawn, environment, input: "", output: "ignore" });
    return;
  }
  throw new Error("clipboard entry is unavailable on this platform");
}
