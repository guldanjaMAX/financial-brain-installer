import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildNpmCliInvocation,
  buildWindowsBatchInvocation,
  installedBrainPath,
  nodeRuntimeNpmCliPaths,
  npmInstallEnvironment,
  publicInstallArguments,
  publicContractChildEnvironment,
  resolveNpmCliPath,
  verifiedNpmCliPath,
} from "../operations/npm-cli-runtime.mjs";

function writeNpmFixture(root, relativeCli = join("lib", "node_modules", "npm", "bin", "npm-cli.js")) {
  const cli = join(root, relativeCli);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(dirname(dirname(cli)), "package.json"), JSON.stringify({ name: "npm", version: "11.0.0" }));
  return realpathSync(cli);
}

test("the public install invocation and installed binary paths exactly match both field guides", () => {
  const posixPrefix = "/tmp/Financial Brain";
  const posixArchive = "/tmp/kit/brain-installer-0.4.6.tgz";
  assert.deepEqual(publicInstallArguments(posixPrefix, posixArchive), [
    "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
    "--prefix", posixPrefix, posixArchive,
  ]);
  assert.equal(installedBrainPath(posixPrefix, "darwin"), "/tmp/Financial Brain/bin/brain");
  assert.equal(installedBrainPath("C:\\Users\\Owner\\FinancialBrain", "win32"),
    "C:\\Users\\Owner\\FinancialBrain\\brain.cmd");
  assert.throws(() => publicInstallArguments("relative-prefix", posixArchive), /paths_must_be_absolute/);

  const batch = buildWindowsBatchInvocation(
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Runner Temp\\brain.cmd",
    ["--version"],
  );
  assert.equal(batch.shell, false);
  assert.equal(batch.windowsVerbatimArguments, true);
  assert.deepEqual(batch.args, ['/d /s /c ""C:\\Runner Temp\\brain.cmd" --version"']);
  assert.deepEqual(buildWindowsBatchInvocation(
    batch.command,
    "C:\\Runner Temp\\brain.cmd",
    ["doctor"],
  ).args, ['/d /s /c ""C:\\Runner Temp\\brain.cmd" doctor"']);
  assert.throws(() => buildWindowsBatchInvocation(batch.command, "C:\\bad%path\\brain.cmd", []), /wrapper_path_refused/);
  assert.throws(() => buildWindowsBatchInvocation(batch.command, "C:\\brain.cmd", ["doctor & whoami"]), /arguments_refused/);
});

test("runtime-relative npm wins and an ambient npm locator cannot leave the Node install tree", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-runtime-"));
  try {
    const runtime = join(sandbox, "runtime");
    const node = join(runtime, "bin", "node");
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, "");
    const runtimeCli = writeNpmFixture(runtime);

    const outside = join(sandbox, "outside");
    const outsideCli = writeNpmFixture(outside, join("npm", "bin", "npm-cli.js"));
    assert.equal(resolveNpmCliPath({ environment: { npm_execpath: outsideCli }, nodeExecutable: node }), runtimeCli);

    rmSync(join(runtime, "lib"), { recursive: true, force: true });
    assert.throws(
      () => resolveNpmCliPath({ environment: { npm_execpath: outsideCli }, nodeExecutable: node }),
      /npm_cli_unavailable/,
    );

    const fallbackCli = writeNpmFixture(runtime, join("tools", "npm", "bin", "npm-cli.js"));
    assert.equal(resolveNpmCliPath({ environment: { npm_execpath: fallbackCli }, nodeExecutable: node }), fallbackCli);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a Windows-style runtime never trusts an npm package beside its Node install directory", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-windows-root-"));
  try {
    const runtime = join(sandbox, "nodejs");
    const node = join(runtime, "node.exe");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(node, "");

    const siblingCli = writeNpmFixture(join(sandbox, "sibling"), join("npm", "bin", "npm-cli.js"));
    assert.throws(
      () => resolveNpmCliPath({
        environment: { npm_execpath: siblingCli },
        nodeExecutable: node,
        platform: "win32",
      }),
      /npm_cli_unavailable/,
    );

    const insideCli = writeNpmFixture(runtime, join("tools", "npm", "bin", "npm-cli.js"));
    assert.equal(resolveNpmCliPath({
      environment: { npm_execpath: insideCli },
      nodeExecutable: node,
      platform: "win32",
    }), insideCli);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("npm runs directly with literal arguments and a credential-free allowlisted environment", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-npm-"));
  try {
    const cli = writeNpmFixture(sandbox, join("npm", "bin", "npm-cli.js"));
    const literalArgs = ["install", "path with spaces", "$HOME", "a&b", "semi;colon"];
    const direct = buildNpmCliInvocation(cli, literalArgs);
    assert.equal(direct.command, process.execPath);
    assert.equal(direct.shell, false);
    assert.deepEqual(JSON.parse(execFileSync(direct.command, direct.args, { encoding: "utf8" })), literalArgs);

    const environment = npmInstallEnvironment({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      TEMP: "/fixture/temp",
      NPM_TOKEN: "must-not-pass",
      NODE_OPTIONS: "--require=must-not-pass",
      CLOUDFLARE_API_TOKEN: "must-not-pass",
      npm_execpath: cli,
    }, "linux");
    assert.deepEqual(environment, {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      TEMP: "/fixture/temp",
      npm_config_yes: "true",
      NPM_CONFIG_USERCONFIG: "/dev/null",
    });
    assert.equal(Object.isFrozen(environment), true);
    assert.deepEqual(publicContractChildEnvironment({
      Path: "C:\\runtime",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      NPM_TOKEN: "must-not-pass",
      CLOUDFLARE_API_TOKEN: "must-not-pass",
    }), {
      PATH: "C:\\runtime",
      SYSTEMROOT: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the Windows runner resolves its default npm and executes a temporary .cmd shim", {
  skip: process.platform !== "win32",
}, () => {
  const npmCli = resolveNpmCliPath();
  const runtimeCli = nodeRuntimeNpmCliPaths().map(verifiedNpmCliPath).find(Boolean);
  if (process.env.GITHUB_ACTIONS === "true") {
    assert.equal(npmCli, runtimeCli, "setup-node npm must resolve from the selected Node runtime");
  } else {
    assert.equal(verifiedNpmCliPath(npmCli), npmCli);
  }
  const npmVersion = execFileSync(process.execPath, [npmCli, "--version"], {
    encoding: "utf8",
    env: npmInstallEnvironment(),
    shell: false,
  }).trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+(?:[-+].*)?$/);

  const sandbox = mkdtempSync(join(tmpdir(), "brain install cmd "));
  try {
    const wrapper = join(sandbox, "brain.cmd");
    writeFileSync(wrapper, [
      "@echo off",
      "if \"%~1\"==\"--version\" (",
      "  echo fixture-version",
      "  exit /b 0",
      ")",
      "exit /b 7",
      "",
    ].join("\r\n"));
    const invocation = buildWindowsBatchInvocation(
      process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
      wrapper,
      ["--version"],
    );
    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      env: npmInstallEnvironment(),
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }).trim();
    assert.equal(output, "fixture-version");
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
