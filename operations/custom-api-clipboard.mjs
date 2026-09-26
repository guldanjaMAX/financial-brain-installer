import { spawnSync } from "node:child_process";

import { localToolEnvironment } from "../doctor.mjs";

const CLIPBOARD_TIMEOUT_MS = 10_000;
const CLIPBOARD_MAX_BUFFER_BYTES = 64 * 1024;

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
      "powershell",
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

/** Clear the clipboard through the matching native no-shell process. */
export function clearCustomApiClipboard({
  platform = process.platform,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    runClipboardCommand(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $null"],
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
