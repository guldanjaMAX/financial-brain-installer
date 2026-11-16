/** A separate current-user console owns only the Windows sign-in ceremony. */
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_SIGNIN_EXIT = Object.freeze({
  keyring: 20, workdir: 21, unfinished: 22, unavailable: 23, noConsole: 24,
});

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
// Start-Process joins ArgumentList into one Windows command line. Quote for
// Node's argv parser, then encode that whole line as a PowerShell literal.
const argument = value => `"${String(value).replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;

export function launchWindowsCloudflareSignIn({
  profile, workingDirectory, environment, processRunner, nodePath = process.execPath,
  timeoutMs = 13 * 60_000,
} = {}) {
  if (!processRunner && (environment?.BRAIN_TEST_CHAIN === "1" || process.env.BRAIN_TEST_CHAIN === "1")) {
    throw new Error("BRAIN_TEST_CHAIN refused a real sign-in window without an injected process runner");
  }
  const systemRoot = environment?.SystemRoot || environment?.SYSTEMROOT || environment?.WINDIR;
  const helper = fileURLToPath(new URL("./windows-update-signin-cli.mjs", import.meta.url));
  if (!/^financial-brain-[a-f0-9]{24}$/u.test(profile || "") ||
      !win32.isAbsolute(systemRoot || "") ||
      [systemRoot, workingDirectory, nodePath, helper].some(value =>
        typeof value !== "string" || !value || /[\0\r\n]/u.test(value))) {
    return { status: WINDOWS_SIGNIN_EXIT.unavailable };
  }
  const argv = [helper, profile].map(argument).join(" ");
  const script = `$ErrorActionPreference = 'Stop'
try {
  $child = Start-Process -FilePath ${literal(nodePath)} -ArgumentList ${literal(argv)} -WorkingDirectory ${literal(workingDirectory)} -WindowStyle Normal -PassThru -Wait
  if ($null -eq $child.ExitCode) { exit ${WINDOWS_SIGNIN_EXIT.unavailable} }
  exit $child.ExitCode
} catch { exit ${WINDOWS_SIGNIN_EXIT.unavailable} }`;
  const run = processRunner ?? spawnSync;
  try {
    // Start-Process creates a new console. Inheriting the updater's redirected
    // handles, windowsHide:false alone, or detached:true cannot establish one.
    // No sign-in URL or credential output flows back to the assistant process.
    return run(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ], { env: environment, cwd: workingDirectory, shell: false, stdio: "ignore",
      windowsHide: true, timeout: timeoutMs });
  } catch {
    return { status: WINDOWS_SIGNIN_EXIT.unavailable };
  }
}

export function windowsUpdatePlatform(options = {}) {
  return options.platform ?? options.oauthOptions?.platformName ?? process.platform;
}

/** Fixed owner copy never turns a stopped background task into CLI homework. */
export function windowsUpdateStopMessage(error) {
  const code = error?.code || error?.supportCode;
  let reason;
  if (code === "CLOUDFLARE_KEYRING_UNAVAILABLE") {
    reason = "Windows could not enable protected storage for Cloudflare sign-in.";
  } else if (code === "AUTH_EXPIRED" || code === "CLOUDFLARE_OAUTH_REAUTH_REQUIRED") {
    reason = "Cloudflare sign-in did not finish for this Brain.";
  } else if (code === "AUTH_REQUIRED") {
    reason = "Cloudflare access could not be verified for this Brain.";
  } else if (code === "REMOTE_PERMISSION_DENIED") {
    reason = "Cloudflare did not grant the required account access. Windows token recovery remains unavailable.";
    if (/cannot request the Vectorize permission/u.test(error?.message || "")) {
      reason += " Pinned Wrangler 4.131.1 browser sign-in cannot request Vectorize permission.";
    }
  } else if (error?.name === "WindowsDailyTaskRepairRequired" || /Task Scheduler/u.test(error?.message || "")) {
    reason = "The Task Scheduler daily task needs review before the assistant can retry the update.";
  } else if (code === "UPDATE_BRAIN_BUSY") {
    reason = "The Brain still has work in progress, so this update could not continue safely.";
  } else if (code === "NETWORK_UNREACHABLE") {
    reason = "This computer could not verify its connection to the Brain or Cloudflare.";
  } else if (code === "CONFIG_INVALID") {
    reason = "This Brain's saved settings or Cloudflare account binding need review.";
  } else {
    reason = "The update stopped before all required checks passed.";
  }
  return `${reason} The update is incomplete. Keep any saved checkpoint. ` +
    "Click back into this assistant conversation for the assistant to review the stopped update.";
}
