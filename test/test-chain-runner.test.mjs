import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  RUNNER_TEST_COMMAND,
  TEST_COMMANDS,
  exitDisposition,
  isolatedTestEnvironment,
  parseRunnerOptions,
  parseTestCommand,
  runTestCommands,
  POST_LAUNCHER_TEST_COMMANDS,
} from "../scripts/run-test-chain.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = "test/fixtures/test-chain-runner";
const LEGACY_CHAIN_SHA256 = "5010400357220154be0d3b9bef514ca0cdaa61099ed46347f33ec239a4a52493";
const quietLogger = { error() {} };
const quietOutput = { stdout: { write() {} }, stderr: { write() {} } };
const command = (name) => `node ${FIXTURE}/${name}.mjs`;
const sandbox = mkdtempSync(join(tmpdir(), "brain-test-chain-runner-"));
const logPath = join(sandbox, "order.log");
const env = { ...process.env, BRAIN_TEST_CHAIN_LOG: logPath };
const readOrder = () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
const resetLog = () => writeFileSync(logPath, "", "utf8");

try {
  // Tests added after the legacy chain was frozen are projected out by name, so
  // the original 172 commands and their order stay provable byte-for-byte. The
  // projection list must never be used to hide an edit to an original command.
  assert.ok(POST_LAUNCHER_TEST_COMMANDS.includes(RUNNER_TEST_COMMAND));
  for (const added of POST_LAUNCHER_TEST_COMMANDS) {
    assert.ok(TEST_COMMANDS.includes(added), `npm test omits the added command ${added}`);
  }
  const legacyCommands = TEST_COMMANDS.filter((item) => !POST_LAUNCHER_TEST_COMMANDS.includes(item));
  assert.equal(
    legacyCommands.length + POST_LAUNCHER_TEST_COMMANDS.length,
    TEST_COMMANDS.length,
    "the projection list contains a command npm test does not run",
  );
  assert.equal(legacyCommands.length, 172);
  assert.equal(
    createHash("sha256").update(legacyCommands.join(" && ")).digest("hex"),
    LEGACY_CHAIN_SHA256,
    "the launcher must preserve the exact old 172-command graph and order",
  );
  for (const added of [
    "node --no-warnings worker/test/ready-window-webhook-regression.test.mjs",
    "node --no-warnings worker/test/plaid-refresh-debt-regression.test.mjs",
  ]) {
    assert.ok(TEST_COMMANDS.includes(added), `npm test omits the Plaid regression ${added}`);
  }

  resetLog();
  const ordered = await runTestCommands({
    commands: [command("first"), command("second")],
    cwd: ROOT,
    env,
    output: quietOutput,
    logger: quietLogger,
  });
  assert.equal(ordered.ok, true);
  assert.equal(ordered.attempted, 2);
  assert.deepEqual(readOrder(), ["first", "second"]);

  resetLog();
  const failed = await runTestCommands({
    commands: [command("first"), command("fail-seven"), command("never")],
    cwd: ROOT,
    env,
    output: quietOutput,
    logger: quietLogger,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.attempted, 2);
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.failures[0].code, 7);
  assert.deepEqual(readOrder(), ["first", "fail-seven"]);
  assert.deepEqual(exitDisposition(failed), { code: 7, signal: null });

  resetLog();
  const continuedMessages = [];
  const continued = await runTestCommands({
    commands: [command("fail-seven"), command("signal-term"), command("second")],
    continueOnFailure: true,
    cwd: ROOT,
    env,
    output: quietOutput,
    logger: { error(message) { continuedMessages.push(message); } },
  });
  assert.equal(continued.ok, false);
  assert.equal(continued.attempted, 3);
  assert.equal(continued.failures.length, 2);
  assert.equal(continued.failures[0].code, 7);
  if (process.platform === "win32") {
    assert.ok(
      continued.failures[1].signal === "SIGTERM" || continued.failures[1].code > 0,
      "Windows must surface a terminated child as a signal or nonzero exit",
    );
  } else {
    assert.equal(continued.failures[1].signal, "SIGTERM");
  }
  assert.deepEqual(readOrder(), ["fail-seven", "signal-term", "second"]);
  assert.equal(continuedMessages.length, 2);
  assert.match(continuedMessages[0], /fail-seven\.mjs/);
  assert.match(continuedMessages[1], /signal-term\.mjs/);
  assert.deepEqual(
    exitDisposition(continued, { continueOnFailure: true }),
    { code: 1, signal: null },
    "continue mode must fail the suite after reporting every child failure",
  );

  resetLog();
  const signaled = await runTestCommands({
    commands: [command("signal-term"), command("never")],
    cwd: ROOT,
    env,
    output: quietOutput,
    logger: quietLogger,
  });
  assert.equal(signaled.ok, false);
  assert.equal(signaled.attempted, 1);
  assert.deepEqual(readOrder(), ["signal-term"]);
  const signalExit = exitDisposition(signaled);
  if (process.platform === "win32") {
    assert.ok(signalExit.signal === "SIGTERM" || signalExit.code > 0);
  } else {
    assert.deepEqual(signalExit, { code: null, signal: "SIGTERM" });
  }

  resetLog();
  const output = spawnSync(process.execPath, [`${FIXTURE}/passing-driver.mjs`], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /test-chain-runner first stdout/);
  assert.match(output.stderr, /test-chain-runner second stderr/);
  assert.deepEqual(readOrder(), ["first", "second"]);

  resetLog();
  const streamedOutput = [];
  const streamed = await runTestCommands({
    commands: [command("first"), command("skip-reason"), command("fail-seven"), command("second")],
    continueOnFailure: true,
    cwd: ROOT,
    env,
    output: {
      stdout: { write(chunk) { streamedOutput.push(String(chunk)); } },
      stderr: { write(chunk) { streamedOutput.push(String(chunk)); } },
    },
    logger: quietLogger,
  });
  assert.equal(streamed.attempted, 4);
  assert.equal(streamed.failures.length, 1);
  assert.equal(streamed.failures[0].code, 7);
  assert.equal(streamed.symlinkSkips, 1, "the CLI runner must count the actual child skip line");
  assert.deepEqual(readOrder(), ["first", "skip-reason", "fail-seven", "second"]);
  assert.match(streamedOutput.join(""), /test-chain-runner first stdout/);
  assert.match(streamedOutput.join(""), /host cannot create file symlinks \(SeCreateSymbolicLinkPrivilege\); assertions did not run/);

  assert.deepEqual(parseRunnerOptions([]), { continueOnFailure: false });
  assert.deepEqual(parseRunnerOptions(["--continue-on-failure"]), { continueOnFailure: true });
  for (const args of [["--unknown"], ["--continue-on-failure", "--continue-on-failure"], ["positional"]]) {
    assert.throws(() => parseRunnerOptions(args), /unknown test-runner option/);
  }

  const developerEnvironment = { HOME: "/developer", BRAIN_NO_WRANGLER_LOGIN: "" };
  const childEnvironment = isolatedTestEnvironment(developerEnvironment);
  assert.equal(childEnvironment.BRAIN_NO_WRANGLER_LOGIN, "1");
  assert.equal(childEnvironment.HOME, "/developer");
  assert.equal(developerEnvironment.BRAIN_NO_WRANGLER_LOGIN, "",
    "test isolation must not mutate the parent process environment");

  assert.throws(() => parseTestCommand("node -e process.exit(0)"), /unsupported (?:Node test flag|test module)/);
  assert.throws(() => parseTestCommand("node test/a.test.mjs && node test/b.test.mjs"), /unsupported test module/);
  assert.throws(() => parseTestCommand("npm test"), /unsupported npm test command/);

  const syntheticNpmExecPath = join(ROOT, "test", "fixtures", "synthetic-npm-cli.js");
  const inheritedEnv = { TEST_CHAIN_SENTINEL: "inherited" };
  let npmInvocation;
  const nestedNpm = await runTestCommands({
    commands: ["npm run test:eval"],
    cwd: ROOT,
    env: inheritedEnv,
    npmExecPath: syntheticNpmExecPath,
    spawnImpl(executable, args, options) {
      npmInvocation = { executable, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
    output: quietOutput,
    logger: quietLogger,
  });
  assert.equal(nestedNpm.ok, true);
  assert.equal(npmInvocation.executable, process.execPath);
  assert.deepEqual(npmInvocation.args, [syntheticNpmExecPath, "run", "test:eval"]);
  assert.equal(npmInvocation.options.cwd, ROOT);
  assert.equal(npmInvocation.options.env, inheritedEnv);
  assert.deepEqual(npmInvocation.options.stdio, ["inherit", "pipe", "pipe"]);
  assert.equal(npmInvocation.options.shell, false);
  await assert.rejects(
    runTestCommands({
      commands: ["npm run test:eval"],
      npmExecPath: "",
      spawnImpl() { throw new Error("must not spawn"); },
      logger: quietLogger,
    }),
    /npm_execpath is required/,
  );

  // Pin the CLI entry point to the same exported function exercised above.
  const runnerSource = readFileSync(join(ROOT, "scripts", "run-test-chain.mjs"), "utf8");
  assert.match(runnerSource,
    /async function runFromCli\(\)\s*\{\s*try\s*\{\s*const options = parseRunnerOptions\(process\.argv\.slice\(2\)\);\s*const result = await runTestCommands\(/u,
    "npm test must call the exported runner that the counting test exercises");

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-test-chain.mjs");
  assert.ok(pkg.scripts.test.length < 128, "the npm test entry must stay far below Windows cmd.exe limits");
  assert.equal(pkg.scripts.test.includes("&&"), false);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("test-chain runner: exact order, real child failures/signals, continuation, output, and short npm entry verified");
