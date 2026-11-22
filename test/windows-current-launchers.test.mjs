import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const cases = {
  "brain.cmd": '@echo off\r\nset "dp0=%~dp0"\r\nnode "%dp0%\\node_modules\\brain-installer\\brain.mjs" %*\r\n',
  "brain.ps1": '& node "$PSScriptRoot/node_modules/brain-installer/brain.mjs" @args\nexit $LASTEXITCODE\n',
  brain: '#!/bin/sh\nexec node "$(dirname "$0")/node_modules/brain-installer/brain.mjs" "$@"\n',
};

function fixture(t) {
  const localAppData = mkdtempSync(join(tmpdir(), "brain tools "));
  t.after(() => rmSync(localAppData, { recursive: true, force: true }));
  const prefix = join(localAppData, "FinancialBrain");
  function install(folder, version) {
    const root = join(localAppData, folder, "node_modules", "brain-installer");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "brain-installer", version, bin: { brain: "./brain.mjs" },
    }));
    const scriptPath = join(root, "brain.mjs");
    writeFileSync(scriptPath, `console.log(JSON.stringify({
      version: ${JSON.stringify(version)}, cli: process.argv[1], args: process.argv.slice(2)
    }));`);
    return scriptPath;
  }
  const prior = install("FinancialBrain", "0.4.28");
  const scriptPath = install("FinancialBrain-v0.4.33", "0.4.33");
  for (const [name, bytes] of Object.entries(cases)) writeFileSync(join(prefix, name), bytes);
  return { prefix, prior, scriptPath, localAppData, version: "0.4.33" };
}

test("the Windows PATH launchers switch to the verified runtime and retain the prior package", async t => {
  const { activateWindowsCurrentLaunchers } = await import("../operations/windows-current-launchers.mjs");
  const paths = fixture(t);
  activateWindowsCurrentLaunchers({ ...paths, platform: "win32" });
  for (const name of Object.keys(cases)) {
    assert.match(readFileSync(join(paths.prefix, name), "utf8"), /FinancialBrain-v0\.4\.33/);
  }
  assert.ok(existsSync(paths.prior));
  assert.match(readFileSync(paths.prior, "utf8"), /0\.4\.28/);
  activateWindowsCurrentLaunchers({ ...paths, platform: "win32" });
  if (process.platform === "win32") {
    const { SystemRoot, ComSpec } = process.env;
    const env = { SystemRoot, ComSpec, PATHEXT: ".CMD;.EXE",
      PATH: `${paths.prefix};${dirname(process.execPath)}` };
    for (const args of ["--version", 'daily on "test manifest.json"', 'mcp-config "test manifest.json"']) {
      const run = spawnSync(ComSpec, ["/d", "/c", `brain ${args}`], { env, encoding: "utf8",
        windowsVerbatimArguments: true });
      assert.equal(run.status, 0, run.stderr);
      const invoked = JSON.parse(run.stdout);
      assert.equal(invoked.version, "0.4.33");
      assert.equal(invoked.cli, paths.scriptPath);
      assert.deepEqual(invoked.args, args === "--version" ? [args] :
        [...args.split(' "')[0].split(" "), "test manifest.json"]);
    }
    const powershell = join(SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = spawnSync(powershell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(paths.prefix, "brain.ps1"), "--version"],
      { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).version, "0.4.33");
  }
  const rollback = spawnSync(process.execPath, [paths.prior, "--version"], {
    env: {}, encoding: "utf8",
  });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(JSON.parse(rollback.stdout).version, "0.4.28");
});

test("Mac and a version-mismatched Windows runtime leave the launchers unchanged", async t => {
  const { activateWindowsCurrentLaunchers } = await import("../operations/windows-current-launchers.mjs");
  const paths = fixture(t);
  activateWindowsCurrentLaunchers({ ...paths, platform: "darwin" });
  assert.equal(readFileSync(join(paths.prefix, "brain.cmd"), "utf8"), cases["brain.cmd"]);
  assert.throws(() => activateWindowsCurrentLaunchers({
    ...paths, platform: "win32", version: "0.4.32",
  }), /version/i);
  assert.equal(readFileSync(join(paths.prefix, "brain.cmd"), "utf8"), cases["brain.cmd"]);
  const packagePath = join(dirname(paths.scriptPath), "package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  writeFileSync(packagePath, JSON.stringify({ ...metadata, version: "0.4.32" }));
  assert.throws(() => activateWindowsCurrentLaunchers({
    ...paths, platform: "win32",
  }), /package identity/i);
  assert.equal(readFileSync(join(paths.prefix, "brain.cmd"), "utf8"), cases["brain.cmd"]);
});
