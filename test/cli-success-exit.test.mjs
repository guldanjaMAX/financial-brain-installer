import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "brain-cli-success-exit-"));
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
    const usePty = process.platform === "darwin" && process.env.CLI_EXIT_FORCE_PIPE !== "1";
    const command = usePty ? "/usr/bin/python3" : process.execPath;
    const args = usePty
      ? [ptyFixture, ...childArgs]
      : [fixture, mode];
    const child = spawn(command, args, {
      cwd: dirname(dirname(fixture)),
      env: {
        HOME: home,
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        BRAIN_NO_WRANGLER_LOGIN: "1",
        BRAIN_TEST_LAUNCHCTL: join(root, "launchctl-unavailable"),
        BRAIN_ADMIN_KEY_FILE: join(home, ".brain-admin-key"),
        CLI_EXIT_PTY_SECONDS: String(ARM_BUDGET_SECONDS),
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
  for (const mode of ["control", "update", "update-warning", "update-daily-attention", "deploy", "deploy-warning"]) {
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
  assert.equal(dailyAttention.code, 0, "a verified Brain update with retained daily recovery uses the documented success exit");
  assert.match(dailyAttention.stdout, /Daily imports.*need attention/i,
    "the command boundary prints a visible daily-import attention line");
  assert.match(dailyAttention.stdout, /DECISION daily-attention recovery=true enabled=false/,
    "the CLI arm reached the retained-recovery decision instead of silently enabling imports");

  assert.notEqual(
    control.stdout.includes("opened=true"),
    commandArms[0].stdout.includes("opened=true"),
    "the green control and prompt arm must not be uniform",
  );
  console.log("CLI success exit: pseudo-TTY/live-stdin control, update, and deploy passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
