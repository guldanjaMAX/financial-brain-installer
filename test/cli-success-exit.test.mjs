import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-cli-success-exit-")));
const fixture = fileURLToPath(new URL("./fixtures/cli-success-exit-child.mjs", import.meta.url));
const ptyFixture = fileURLToPath(new URL("./fixtures/cli-success-exit-pty.py", import.meta.url));

// One budget for both timers: the macOS pseudo-terminal helper gets it through
// CLI_EXIT_PTY_SECONDS, and this process falls back a few seconds later.
const ARM_BUDGET_SECONDS = 20;

function runArm(mode, extraEnv = {}) {
  return new Promise((resolve) => {
    const home = join(root, `home-${mode}`);
    const childArgs = [process.execPath, fixture, mode];
    // macOS forkpty gives the child a real pseudo-terminal without relying on
    // the test runner itself owning a terminal. Windows exercises the same
    // live-stdin lifetime through a held-open PowerShell-style pipe.
    const usePty = process.platform === "darwin" && extraEnv.CLI_EXIT_FIXTURE_PLATFORM !== "win32" &&
      process.env.CLI_EXIT_FORCE_PIPE !== "1";
    const command = usePty ? "/usr/bin/python3" : process.execPath;
    const args = usePty
      ? [ptyFixture, ...childArgs]
      : [fixture, mode];
    const operatingSystemEnvironment = {};
    for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
      if (process.env[name]) operatingSystemEnvironment[name] = process.env[name];
    }
    const child = spawn(command, args, {
      cwd: dirname(dirname(fixture)),
      env: {
        HOME: home,
        TMPDIR: process.env.TMPDIR || root,
        TEMP: process.env.TEMP || root,
        TMP: process.env.TMP || root,
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        BRAIN_NO_WRANGLER_LOGIN: "1",
        BRAIN_LIFECYCLE_LOCK_ROOT: join(root, `locks-${mode}`),
        BRAIN_TEST_LAUNCHCTL: join(root, "launchctl-unavailable"),
        BRAIN_ADMIN_KEY_FILE: join(home, ".brain-admin-key"),
        CLI_EXIT_PTY_SECONDS: String(ARM_BUDGET_SECONDS),
        ...operatingSystemEnvironment,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      timedOut = true;
      // This process was created by this test. Closing its input first lets an
      // unfixed readline unwind; SIGTERM is only a bounded cleanup fallback.
      // A loaded CI runner can take several seconds just to start Node under a
      // pseudo-terminal, which is not the hang under test.
      child.stdin.end();
      child.kill("SIGTERM");
    }, (ARM_BUDGET_SECONDS + 5) * 1_000);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ mode, code, signal, stdout, stderr, timedOut });
    });
  });
}

try {
  const results = [];
  for (const mode of ["control", "update", "update-warning", "update-daily-attention", "update-daily-restored", "deploy", "deploy-warning"]) {
    results.push(await runArm(mode));
  }
  const [control, ...commandArms] = results;

  // Slow green control: a child that starts 3 s late must still pass, which
  // proves neither timer is tighter than the budget above.
  const slowControl = await runArm("control", { CLI_EXIT_FIXTURE_DELAY_MS: "3000" });
  assert.equal(slowControl.timedOut, false, JSON.stringify(slowControl));
  assert.equal(slowControl.code, 0, JSON.stringify(slowControl));
  assert.match(slowControl.stdout, /DECISION control completed opened=false prompt_open=false/);

  assert.equal(control.timedOut, false, JSON.stringify(control));
  assert.equal(control.code, 0, JSON.stringify(control));
  assert.match(control.stdout, /DECISION control completed opened=false prompt_open=false/);

  for (const arm of commandArms) {
    assert.match(
      arm.stdout,
      new RegExp(`DECISION ${arm.mode} completed opened=true`),
      `${arm.mode} never reached its successful command decision point: ${JSON.stringify(arm)}`,
    );
    assert.equal(
      arm.timedOut,
      false,
      `${arm.mode} succeeded but retained its TTY-like stdin handle: ${JSON.stringify(arm)}`,
    );
    assert.equal(arm.code, 0, JSON.stringify(arm));
    assert.match(arm.stdout, new RegExp(`DECISION ${arm.mode} completed opened=true prompt_open=false`));
  }

  const dailyAttention = commandArms.find((arm) => arm.mode === "update-daily-attention");
  assert.equal(dailyAttention.code, 0, "verified daily-off state with an owner action is a successful update");
  assert.match(dailyAttention.stdout, /still needs attention/);
  assert.ok(dailyAttention.stdout.includes(renderCliCommands(
    "The old daily task was paused; run brain daily on <manifest> to turn on permanent daily imports.",
  )), "the command boundary explains the pending owner decision");
  assert.match(dailyAttention.stdout, /DECISION daily recovery=false enabled=false upgrades=1/);
  assert.match(dailyAttention.stdout, /DECISION bridge enabled=false pauses=1/,
    "the successful attention arm actually paused its bridge and did not silently enable it");

  // Exercise the Windows owner message on every host through the real update
  // dispatcher. Scheduler and transport boundaries remain fixture-controlled.
  const windowsAttention = await runArm("update-daily-attention", { CLI_EXIT_FIXTURE_PLATFORM: "win32" });
  assert.equal(windowsAttention.timedOut, false, JSON.stringify(windowsAttention));
  assert.equal(windowsAttention.code, 0, JSON.stringify(windowsAttention));
  assert.match(windowsAttention.stdout, /DECISION update-daily-attention completed opened=true prompt_open=false/);
  assert.match(windowsAttention.stdout, /DECISION daily recovery=false enabled=false upgrades=1/);
  assert.match(windowsAttention.stdout, /DECISION bridge enabled=false pauses=1/);
  const windowsGuidance = renderCliCommands(
    "The old daily task was paused; run brain daily on <manifest> to turn on permanent daily imports.",
    { platform: "win32", env: { PATH: "" } },
  );
  assert.ok(windowsAttention.stdout.includes(windowsGuidance),
    "the Windows command boundary renders runnable PowerShell guidance after the verified pause");

  const restored = commandArms.find((arm) => arm.mode === "update-daily-restored");
  assert.match(restored.stdout, /DECISION daily recovery=false enabled=true upgrades=1 restore_attempts=[1-9]/,
    "the enabled-daily green control reached verified restoration and cleared recovery");

  // A required restore failure is intentionally no longer a success warning.
  // It must still close readline, keep recovery, and exit nonzero without Done.
  const failed = await runArm("update-daily-recovery-failure");
  assert.equal(failed.timedOut, false, JSON.stringify(failed));
  assert.equal(failed.code, 1, JSON.stringify(failed));
  assert.match(failed.stdout, /DECISION update-daily-recovery-failure refused opened=true prompt_open=false/);
  assert.match(failed.stdout, /DECISION daily recovery=true enabled=false upgrades=1 restore_attempts=[1-9]/);
  assert.match(failed.stdout + failed.stderr, /this update is incomplete: daily imports remain paused or unverified/);
  assert.match(failed.stdout + failed.stderr, /Daily recovery receipt:/);
  assert.doesNotMatch(failed.stdout, /Done\. Your Brain/);

  assert.notEqual(
    control.stdout.includes("opened=true"),
    commandArms[0].stdout.includes("opened=true"),
    "the green control and prompt arm must not be uniform",
  );
  console.log("CLI success exit: pseudo-TTY/live-stdin control, update, and deploy passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
