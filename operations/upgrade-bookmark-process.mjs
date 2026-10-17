import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsFileChildEnvironment } from "./current-user-file.mjs";
import { WINDOWS_UPGRADE_BOOKMARK_ACL_TIMEOUT_MS } from "./upgrade-bookmark.mjs";

// Four independent Windows ACL checks retain their startup allowance. The
// extra minute covers local I/O and startup. A timer in the synchronous writer
// cannot interrupt fsync, open, readback, or a blocked native process wait.
export const UPGRADE_BOOKMARK_TIMEOUT_MS = 4 * WINDOWS_UPGRADE_BOOKMARK_ACL_TIMEOUT_MS + 60_000;
const childPath = fileURLToPath(new URL("./upgrade-bookmark-child.mjs", import.meta.url));
const childCodes = new Set(["UPGRADE_BOOKMARK_ACL_TIMEOUT", "UPGRADE_BOOKMARK_MAC_ACL_TIMEOUT"]);
const failure = (code = "UPGRADE_BOOKMARK_FAILED") => Object.assign(
  new Error(code === "UPGRADE_BOOKMARK_TIMEOUT"
    ? "recovery bookmark persistence timed out; no deployment or migration was started"
    : "recovery bookmark could not be saved and verified"), { code });

export function saveUpgradeBookmarkBounded(record, {
  directory = join(homedir(), ".brain", "upgrade-bookmarks"),
  now = () => new Date(),
  run = spawn,
  environment = process.env,
  platform = process.platform,
  timeoutMs = UPGRADE_BOOKMARK_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > UPGRADE_BOOKMARK_TIMEOUT_MS) {
    throw failure();
  }
  const env = windowsFileChildEnvironment(environment);
  for (const name of ["HOME", "TMPDIR"]) {
    if (typeof environment[name] === "string") env[name] = environment[name];
  }
  // No record, path, token, or desktop Node options enter argv or logs.
  const input = Buffer.from(JSON.stringify({ record, directory, capturedAt: now().toISOString() }));
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const stop = () => {
      if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return;
      const kill = () => { try { child.kill("SIGKILL"); } catch {} };
      if (platform === "win32" && child.pid && win32.isAbsolute(env.SystemRoot || "")) {
        // Killing Node alone can leave its PowerShell child alive. The bounded
        // tree kill runs independently of the blocked receipt process.
        try {
          const killer = run(win32.join(env.SystemRoot, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"], {
              env, shell: false, stdio: "ignore", windowsHide: true,
              timeout: 5_000, killSignal: "SIGKILL",
            });
          const fallback = setTimeout(() => {
            try { killer.kill("SIGKILL"); } catch {}
            killer.unref();
            kill();
          }, 5_000);
          const done = () => { clearTimeout(fallback); kill(); };
          killer.on("error", done);
          killer.once("close", done);
          return;
        } catch { kill(); }
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      kill();
    };
    const finish = (error, path) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) stop();
      input.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      // Do not wait forever for close, or for a descendant holding a pipe.
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.unref();
      if (error) reject(error); else resolve(path);
    };
    timer = setTimeout(() => finish(failure("UPGRADE_BOOKMARK_TIMEOUT")), timeoutMs);
    try {
      child = run(process.execPath, [childPath], {
        env, shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        detached: platform !== "win32",
      });
      child.on("error", () => finish(failure()));
      child.stdin.on("error", () => finish(failure()));
      child.stdout.on("data", chunk => {
        if (settled) { chunk.fill(0); return; }
        size += chunk.length;
        chunks.push(chunk);
        if (size > 16_384) finish(failure());
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        const bytes = Buffer.concat(chunks);
        try {
          const result = JSON.parse(bytes.toString("utf8"));
          if (code === 0 && !signal && typeof result.path === "string" && result.path.length) finish(null, result.path);
          else finish(failure(childCodes.has(result.code) ? result.code : undefined));
        } catch { finish(failure()); }
        finally { bytes.fill(0); }
      });
      child.stdin.end(input);
    } catch { finish(failure()); }
  });
}
