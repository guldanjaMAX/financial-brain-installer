import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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

function assertNoUpdateCompletion(arm) {
  const restartInstructions = /(?:One last step: quit Claude Code|In Claude Code type \/exit|Then ask: check my Brain\.)/u;
  // Streams have independent line boundaries, and a prefix must not hide a
  // completion claim after a failed update.
  for (const stream of ["stdout", "stderr"]) {
    assert.doesNotMatch(arm[stream], /Done\. Your Brain is now on version /u,
      `${arm.mode} printed Done on ${stream} after failure`);
    assert.doesNotMatch(arm[stream], restartInstructions,
      `${arm.mode} printed restart instructions on ${stream} after failure`);
  }
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
  const pausedDailyGuidance = "The old daily task is paused. Ask your installer to run brain daily on <manifest> to turn on daily updates.";
  assert.equal(dailyAttention.code, 0, "verified daily-off state with an owner action is a successful update");
  assert.doesNotMatch(dailyAttention.stdout, /Daily update is off\./);
  assert.equal(dailyAttention.stdout.split("\n").filter(line => line.includes(renderCliCommands(pausedDailyGuidance))).length, 1);
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
    pausedDailyGuidance,
    { platform: "win32", env: { PATH: "" } },
  );
  assert.ok(windowsAttention.stdout.includes(windowsGuidance),
    "the Windows command boundary renders runnable PowerShell guidance after the verified pause");

  const restored = commandArms.find((arm) => arm.mode === "update-daily-restored");
  assert.match(restored.stdout, /DECISION daily recovery=false enabled=true upgrades=1 restore_attempts=[1-9]/,
    "the enabled-daily green control reached verified restoration and cleared recovery");

  // A required restore failure is intentionally no longer a success warning.
  // It must still close readline, keep recovery, and exit nonzero.
  const failed = await runArm("update-daily-recovery-failure");
  assert.equal(failed.timedOut, false, JSON.stringify(failed));
  assert.equal(failed.code, 1, JSON.stringify(failed));
  assert.match(failed.stdout, /DECISION update-daily-recovery-failure refused opened=true prompt_open=false/);
  assert.match(failed.stdout, /DECISION daily recovery=true enabled=false upgrades=1 restore_attempts=[1-9]/);
  assert.match(failed.stdout + failed.stderr, /this update is incomplete: daily imports remain paused or unverified/);
  assert.match(failed.stdout + failed.stderr, /Daily recovery receipt:/);
  assert.doesNotMatch(failed.stdout, /✔ Version /u);

  const checkFailure = await runArm("update-required-check-failure");
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const done = `Done. Your Brain is now on version ${version} and passed its checks.`;
  const cleanLines = commandArms[0].stdout.split(/\r?\n/u);
  const assertCompleted = lines => {
    assert.equal(lines.filter(line => line === done).length, 1);
    return lines.indexOf(done);
  };
  await test("clean update prints Done once after its checks", () => {
    const check = cleanLines.findIndex(line => line.includes("Brain is online"));
    assert.ok(check >= 0);
    assert.ok(assertCompleted(cleanLines) > check);
  });
  await test("source attention lines are unchanged and precede Done", () => {
    const lines = commandArms[1].stdout.split(/\r?\n/u);
    const sources = [
      "Google Drive could not finish updating. Ask your installer to check it.",
      "Gmail could not finish updating. Ask your installer to check it.",
    ];
    assert.deepEqual(lines.filter(line => sources.includes(line)), sources);
    assert.ok(assertCompleted(lines) > lines.indexOf(sources[1]));
  });
  // The clean control rules out an implementation that never reports completion.
  await test("daily recovery failure exits 1 without Done or restart instructions", () => {
    assert.equal(failed.code, 1);
    assertNoUpdateCompletion(failed);
    assertCompleted(cleanLines);
  });
  await test("failed version verification exits 1 without Done or restart instructions", () => {
    assert.equal(checkFailure.timedOut, false);
    assert.equal(checkFailure.code, 1);
    const output = checkFailure.stdout + checkFailure.stderr;
    assert.match(output, /fixture exact-version verification failed/);
    assertNoUpdateCompletion(checkFailure);
    assertCompleted(cleanLines);
  });
  for (const arm of [failed, checkFailure]) {
    await test(`${arm.mode} rejects stderr Done after partial stdout`, () => {
      assertNoUpdateCompletion(arm);
      const mutant = { ...arm, stdout: `${arm.stdout}partial stdout`, stderr: `${done}\n${arm.stderr}` };
      assert.ok(mutant.stdout.endsWith("partial stdout"));
      assert.equal(mutant.stderr.split(/\r?\n/u)[0], done);
      assert.throws(() => assertNoUpdateCompletion(mutant), {
        code: "ERR_ASSERTION", message: `${arm.mode} printed Done on stderr after failure`,
      });
    });
    await test(`${arm.mode} rejects Done hidden in stdout's last line`, () => {
      assertNoUpdateCompletion(arm);
      const mutant = { ...arm, stdout: `${arm.stdout}\npartial stdout✔ ${done}` };
      assert.equal(mutant.stdout.split(/\r?\n/u).at(-1), `partial stdout✔ ${done}`);
      assert.throws(() => assertNoUpdateCompletion(mutant), {
        code: "ERR_ASSERTION", message: `${arm.mode} printed Done on stdout after failure`,
      });
    });
  }
  await test("normal update prints the restart instructions once after Done", () => {
    const restart = "One last step: quit Claude Code (and Codex, if you use it) and open it again, so it connects to the updated Brain.";
    assert.equal(cleanLines.filter(line => line === restart).length, 1);
    assert.ok(cleanLines.indexOf(restart) > assertCompleted(cleanLines));
    assert.equal(cleanLines[cleanLines.indexOf(restart) + 1], "In Claude Code type /exit, then claude --continue.");
    assert.equal(cleanLines[cleanLines.indexOf(restart) + 2], "Then ask: check my Brain.");
  });

  assert.notEqual(
    control.stdout.includes("opened=true"),
    commandArms[0].stdout.includes("opened=true"),
    "the green control and prompt arm must not be uniform",
  );
  console.log("CLI success exit: pseudo-TTY/live-stdin control, update, and deploy passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
