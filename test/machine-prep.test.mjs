import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "test", "fixtures", "machine-prep");
const MAC = join(ROOT, "machine-prep", "prep-mac.sh");
const WINDOWS = join(ROOT, "machine-prep", "prep-windows.ps1");
const WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS = 120_000;
const MAC_RUNTIME_ON_WINDOWS_SKIP_REASON =
  "requires Unix/macOS shell paths and remains active on the macOS CI lane";
const MAC_INSTALL_ORCHESTRATION_SKIP_REASON =
  "requires macOS because it exercises the production BSD stat and atomic rename path";

function macRuntimeOptions(platform = process.platform) {
  return {
    skip: platform === "win32" ? MAC_RUNTIME_ON_WINDOWS_SKIP_REASON : false,
  };
}

function macInstallOrchestrationOptions(platform = process.platform) {
  return {
    skip: platform === "darwin" ? false : MAC_INSTALL_ORCHESTRATION_SKIP_REASON,
  };
}

function cleanEnv(fixture) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    HOME: "/fixture/home",
    USERPROFILE: "C:\\Users\\Fixture",
    LOCALAPPDATA: "C:\\Users\\Fixture\\AppData\\Local",
    APPDATA: "C:\\Users\\Fixture\\AppData\\Roaming",
    MACHINE_PREP_HOME: "/fixture/home",
    MACHINE_PREP_FIXTURE_DIR: fixture,
    MACHINE_PREP_TEST_MODE: "1",
  };
}

function runMac(args, fixture = "mac-not-ready") {
  const home = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-test-home-")));
  try {
    const fixturePath = fixture.startsWith("/") ? fixture : join(FIXTURES, fixture);
    return spawnSync("bash", [MAC, ...args], {
      cwd: ROOT,
      env: {
        ...cleanEnv(fixturePath),
        HOME: home,
        BRAIN_NO_WRANGLER_LOGIN: "1",
        BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
      },
      encoding: "utf8",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function windowsPowerShell() {
  if (process.platform !== "win32") return null;
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function runWindows(args, fixture = "windows-not-ready") {
  const home = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-test-home-")));
  try {
    return spawnSync(windowsPowerShell(), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", WINDOWS, ...args,
    ], {
      cwd: ROOT,
      env: {
        ...cleanEnv(join(FIXTURES, fixture)),
        HOME: home, USERPROFILE: home,
        BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
        MACHINE_PREP_HOME: "C:\\Users\\Fixture",
      },
      encoding: "utf8",
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function runWindowsScratch(script, args, home, { extraEnv = {}, ...options } = {}) {
  return spawnSync(windowsPowerShell(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, ...args,
  ], {
    cwd: ROOT,
    env: {
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      TEMP: join(home, "temp"),
      TMP: join(home, "temp"),
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "local"),
      APPDATA: join(home, "roaming"),
      MACHINE_PREP_HOME: home,
      MACHINE_PREP_TEST_MODE: "1",
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
      ...extraEnv,
    },
    encoding: "utf8",
    ...options,
  });
}

function runWindowsInstallOrchestration({ scenario, script = WINDOWS, kitSizeOffset = 0, kitShaOverride = null }) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-install-")));
  const home = join(directory, "home");
  const local = join(home, "local");
  const temp = join(home, "temp");
  const kit = join(directory, "kit.tgz");
  const npm = join(directory, "npm-fixture.cmd");
  const prefix = join(local, "FinancialBrain");
  const lock = `${prefix}.install.lock`;
  const stage = `${prefix}.test-stage`;
  mkdirSync(temp, { recursive: true });
  writeFileSync(kit, "synthetic reviewed kit\n");
  const kitBytes = readFileSync(kit);
  const kitSha = createHash("sha256").update(kitBytes).digest("hex");
  writeFileSync(npm, `@echo off\r
set "target="\r
:parse\r
if "%~1"=="" goto ready\r
if "%~1"=="--prefix" set "target=%~2"& shift & shift & goto parse\r
shift\r
goto parse\r
:ready\r
${scenario === "install-failure" ? "exit /b 7" : ""}\r
${scenario === "destination-race" ? `mkdir "${prefix}"\r\necho foreign>"${join(prefix, "foreign.txt")}"` : ""}\r
mkdir "%target%\\node_modules\\brain-installer"\r
echo {^"version^":^"0.4.9^"}>"%target%\\node_modules\\brain-installer\\package.json"\r
echo @echo off>"%target%\\brain.cmd"\r
exit /b 0\r
`);
  if (scenario === "lock-collision") {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "foreign.txt"), "preserve\n");
  }
  if (scenario === "stage-collision") {
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "foreign.txt"), "preserve\n");
  }
  const result = runWindowsScratch(script, ["--test-install-brain"], home, {
    timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS,
    extraEnv: {
      MACHINE_PREP_TEST_KIT_SOURCE: kit,
      MACHINE_PREP_TEST_KIT_SIZE: String(kitBytes.length + kitSizeOffset),
      MACHINE_PREP_TEST_KIT_SHA256: kitShaOverride ?? kitSha,
      MACHINE_PREP_TEST_TRANSFER_SIZE: String(kitBytes.length),
      MACHINE_PREP_TEST_NPM_PATH: npm,
      MACHINE_PREP_TEST_STAGE_PATH: stage,
    },
  });
  return {
    directory, prefix, lock, stage, result,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function combined(result) {
  return `${result.stdout || ""}${result.stderr || ""}`.replaceAll("\r\n", "\n");
}

function mutateWindowsCleanupOwnership(source) {
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const guard = [
    "function Remove-OwnedInstallDirectory([string]$Directory, [string]$AttemptId) {",
    "  Write-Output \"CLEANUP_OWNERSHIP_DECISION_REACHED=1\"",
    "  if (-not (Test-InstallAttemptOwnership $Directory $AttemptId)) {",
  ].join(lineEnding);
  const disabledGuard = guard.replace(
    "if (-not (Test-InstallAttemptOwnership $Directory $AttemptId)) {",
    "if ($false) {",
  );
  const mutated = source.replace(guard, disabledGuard);
  assert.notEqual(mutated, source, "Windows ownership mutation target was not found");
  assert.equal(mutated.includes(disabledGuard), true, "Windows cleanup ownership guard was not disabled");
  return mutated;
}

function runMacInstallOrchestration({ scenario, script = MAC, kitSizeOffset = 0, kitShaOverride = null }) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-install-test-")));
  const home = join(directory, "home");
  const kit = join(directory, "kit.tgz");
  const npm = join(directory, "npm-fixture");
  const stage = join(home, ".financial-brain.test-stage");
  const lock = join(home, ".financial-brain.install.lock");
  const prefix = join(home, ".financial-brain");
  mkdirSync(home, { recursive: true });
  writeFileSync(kit, "synthetic reviewed kit\n");
  const kitSha = createHash("sha256").update(readFileSync(kit)).digest("hex");
  writeFileSync(npm, `#!/bin/sh
set -eu
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix=$2; shift 2; else shift; fi
done
[ -z "\${MACHINE_PREP_AMBIENT_SENTINEL:-}" ] || exit 91
case "${scenario}" in
  install-failure) exit 7 ;;
  destination-race)
    mkdir -p "$HOME/.financial-brain"
    printf '%s\\n' foreign > "$HOME/.financial-brain/foreign.txt"
    ;;
esac
mkdir -p "$prefix/lib/node_modules/brain-installer" "$prefix/bin"
printf '%s\\n' '{' '  "version": "0.4.9"' '}' > "$prefix/lib/node_modules/brain-installer/package.json"
printf '%s\\n' '#!/usr/bin/env node' > "$prefix/lib/node_modules/brain-installer/brain.mjs"
ln -s ../lib/node_modules/brain-installer/brain.mjs "$prefix/bin/brain"
`);
  chmodSync(npm, 0o755);

  if (scenario === "lock-collision") {
    mkdirSync(lock);
    writeFileSync(join(lock, "foreign.txt"), "preserve\n");
  }
  if (scenario === "stage-collision") {
    mkdirSync(stage);
    writeFileSync(join(stage, "foreign.txt"), "preserve\n");
  }

  const result = spawnSync("bash", [script, "--test-install-brain"], {
    cwd: ROOT,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      MACHINE_PREP_HOME: home,
      MACHINE_PREP_TEST_MODE: "1",
      MACHINE_PREP_TEST_KIT_SOURCE: kit,
      MACHINE_PREP_TEST_KIT_SIZE: String(readFileSync(kit).length + kitSizeOffset),
      MACHINE_PREP_TEST_KIT_SHA256: kitShaOverride ?? kitSha,
      MACHINE_PREP_TEST_NPM_PATH: npm,
      MACHINE_PREP_TEST_STAGE_PATH: stage,
      MACHINE_PREP_AMBIENT_SENTINEL: "must-not-reach-child",
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
    },
    encoding: "utf8",
  });
  return {
    directory,
    home,
    kit,
    npm,
    stage,
    lock,
    prefix,
    result,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("Mac check reaches every tool and reports missing, old, and shadowed states", macRuntimeOptions(), () => {
  const result = runMac(["--check"]);
  const out = combined(result);
  assert.equal(result.status, 1, out);
  assert.match(out, /CHECKS_REACHED=10/);
  assert.match(out, /WRONG_VERSION  Node\.js/);
  assert.match(out, /MISSING        Claude Code/);
  assert.match(out, /OPTIONAL       Codex CLI/);
  assert.match(out, /SHADOWED       Financial Brain CLI/);
  assert.match(out, /MISSING        Xcode Command Line Tools/);
  assert.match(out, /READY          Wrangler/);
  assert.match(out, /READY          Python 3/);
});

test("Mac ready fixture is green and read-only", macRuntimeOptions(), () => {
  const result = runMac(["--check"], "mac-ready");
  const out = combined(result);
  assert.equal(result.status, 0, out);
  assert.match(out, /READINESS GREEN/);
  assert.match(out, /CHECKS_REACHED=10/);
});

test("Mac dry-run output matches the reviewed snapshot and is idempotent", macRuntimeOptions(), () => {
  const first = runMac(["--dry-run"]);
  const second = runMac(["--dry-run"]);
  const expected = readFileSync(join(FIXTURES, "mac-dry-run.txt"), "utf8").replaceAll("\r\n", "\n");
  assert.equal(first.status, 0, combined(first));
  assert.equal(combined(first), expected);
  assert.equal(combined(second), expected);
});

test("Mac checksum mismatch reaches verification and refuses before action", macRuntimeOptions(), () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-checksum-")));
  try {
    const artifact = join(directory, "artifact.bin");
    writeFileSync(artifact, "fixture artifact\n");
    const wrong = "0".repeat(64);
    const result = runMac(["--verify-checksum", artifact, wrong]);
    const out = combined(result);
    assert.equal(result.status, 2, out);
    assert.match(out, /CHECKSUM_DECISION_REACHED=1/);
    assert.match(out, /REFUSED checksum mismatch/);
    assert.doesNotMatch(out, /ACTION_EXECUTED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac checksum match is accepted only after the decision point", macRuntimeOptions(), () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-checksum-")));
  try {
    const artifact = join(directory, "artifact.bin");
    const bytes = "fixture artifact\n";
    writeFileSync(artifact, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const result = runMac(["--verify-checksum", artifact, expected]);
    const out = combined(result);
    assert.equal(result.status, 0, out);
    assert.match(out, /CHECKSUM_DECISION_REACHED=1/);
    assert.match(out, /VERIFIED checksum/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac Brain prefix gate accepts an absent target and refuses a collision after reaching the decision", macRuntimeOptions(), () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-prefix-")));
  const prefix = join(directory, "brain-prefix");
  try {
    const available = runMac(["--verify-prefix", prefix]);
    assert.equal(available.status, 0, combined(available));
    assert.match(combined(available), /PREFIX_DECISION_REACHED=1/);
    assert.match(combined(available), /AVAILABLE prefix/);

    mkdirSync(prefix);
    const collision = runMac(["--verify-prefix", prefix]);
    const out = combined(collision);
    assert.equal(collision.status, 2, out);
    assert.match(out, /PREFIX_DECISION_REACHED=1/);
    assert.match(out, /REFUSED prefix collision/);
    assert.doesNotMatch(out, /INSTALL_STARTED|DOWNLOAD_STARTED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac existing-install decision refuses version-only, changed, and redirected installs", macRuntimeOptions(), () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-installed-brain-")));
  const prefix = join(directory, "brain-prefix");
  try {
    mkdirSync(join(prefix, "lib", "node_modules", "brain-installer"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(prefix, "lib", "node_modules", "brain-installer", "package.json"), '{\n  "version": "0.4.9"\n}\n');
    writeFileSync(join(prefix, "bin", "brain"), "#!/bin/sh\n");
    chmodSync(join(prefix, "bin", "brain"), 0o755);
    const versionOnly = runMac(["--verify-installed", prefix]);
    assert.equal(versionOnly.status, 2, combined(versionOnly));
    assert.match(combined(versionOnly), /INSTALLED_BRAIN_DECISION_REACHED=1/);
    assert.match(combined(versionOnly), /REFUSED existing prefix cannot be authenticated/);
    assert.match(combined(versionOnly), /REUSE_ATTEMPTED=0/);

    writeFileSync(join(prefix, "bin", "brain"), "#!/bin/sh\necho changed\n");
    const changed = runMac(["--verify-installed", prefix]);
    assert.equal(changed.status, 2, combined(changed));
    assert.match(combined(changed), /INSTALLED_BRAIN_DECISION_REACHED=1/);
    assert.match(combined(changed), /REUSE_ATTEMPTED=0/);

    rmSync(join(prefix, "bin", "brain"));
    symlinkSync("/bin/false", join(prefix, "bin", "brain"));
    const redirected = runMac(["--verify-installed", prefix]);
    assert.equal(redirected.status, 2, combined(redirected));
    assert.match(combined(redirected), /INSTALLED_BRAIN_DECISION_REACHED=1/);
    assert.match(combined(redirected), /REUSE_ATTEMPTED=0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac readiness requires exact Brain version equality", macRuntimeOptions(), () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-fixture-")));
  try {
    cpSync(join(FIXTURES, "mac-ready"), directory, { recursive: true });
    for (const mutant of ["0.4.90", "0.4.9-modified"]) {
      writeFileSync(join(directory, "brain.version"), `${mutant}\n`);
      const result = runMac(["--check"], directory);
      assert.equal(result.status, 1, combined(result));
      assert.match(combined(result), /WRONG_VERSION\s+Financial Brain CLI/);
      assert.match(combined(result), /CHECKS_REACHED=10/);
    }
    writeFileSync(join(directory, "brain.version"), "0.4.9\n");
    const control = runMac(["--check"], directory);
    assert.equal(control.status, 0, combined(control));
    assert.match(combined(control), /READY\s+Financial Brain CLI/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac CLI-only preparation refuses fixtures after the session decision", macInstallOrchestrationOptions(), () => {
  const control = runMac(["--help"]);
  assert.equal(control.status, 0);
  assert.match(control.stdout, /--prepare-cli/);
  const refused = runMac(["--prepare-cli"], "mac-ready");
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /CLI_PREPARATION_SESSION_DECISION_REACHED=1/);
  assert.match(refused.stderr, /REFUSED CLI preparation while fixture\/test mode is active/);
  assert.doesNotMatch(refused.stdout, /DOWNLOAD_STARTED|INSTALL_STARTED/);
  // Source the real script in help mode, then inject only its tool discovery
  // and install dependency. The same session/prerequisite body must pass.
  const home = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-cli-home-")));
  try {
    const ready = spawnSync("bash", ["-c", '. "$1" --help >/dev/null\ntool_version() { printf "v24.13.1\\n"; }\ntool_paths() { printf "/synthetic/npm\\n"; }\ninstall_brain() { printf "CLI_INSTALL_DECISION_REACHED=1\\n"; }\nprepare_cli', "probe", MAC], {
      env: { PATH: "/usr/bin:/bin", HOME: home, BRAIN_NO_WRANGLER_LOGIN: "1" }, encoding: "utf8",
    });
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /CLI_PREPARATION_SESSION_DECISION_REACHED=1/);
    assert.match(ready.stdout, /CLI_PREPARATION_PREREQUISITE_DECISION_REACHED=1/);
    assert.match(ready.stdout, /CLI_INSTALL_DECISION_REACHED=1/);
  } finally { rmSync(home, { recursive: true }); }
});

test("Windows CLI-only preparation refuses fixtures after the session decision", { skip: process.platform !== "win32" }, () => {
  const control = runWindows(["--help"]);
  assert.equal(control.status, 0);
  assert.match(control.stdout, /--prepare-cli/);
  const refused = runWindows(["--prepare-cli"], "windows-ready");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /CLI_PREPARATION_SESSION_DECISION_REACHED=1/);
  assert.match(refused.stderr, /REFUSED CLI preparation while fixture\/test mode is active/);
  assert.doesNotMatch(refused.stdout, /DOWNLOAD_STARTED|INSTALL_STARTED/);
  const home = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-cli-home-")));
  const probe = join(home, "probe.ps1");
  mkdirSync(join(home, "temp"));
  writeFileSync(probe, `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Preparation source syntax failed' }
$function = $ast.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Invoke-CliPreparation' }, $true)
if (-not $function) { throw 'Preparation function missing' }
. ([scriptblock]::Create($function.Extent.Text))
$FixtureDir = ''
$env:MACHINE_PREP_TEST_MODE = ''
function Test-StandardSession { return $true }
function Get-ToolVersion { return 'v24.13.1' }
function Get-ToolPaths { return @('synthetic-npm.cmd') }
function Install-Brain { Write-Output 'CLI_INSTALL_DECISION_REACHED=1' }
Invoke-CliPreparation
`);
  try {
    const ready = runWindowsScratch(probe, [WINDOWS], home);
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /CLI_PREPARATION_SESSION_DECISION_REACHED=1/);
    assert.match(ready.stdout, /CLI_PREPARATION_PREREQUISITE_DECISION_REACHED=1/);
    assert.match(ready.stdout, /CLI_INSTALL_DECISION_REACHED=1/);
  } finally { rmSync(home, { recursive: true }); }
});

test("Mac real mode refuses fixtures before any action", macRuntimeOptions(), () => {
  const result = runMac(["--real"]);
  const out = combined(result);
  assert.equal(result.status, 2, out);
  assert.match(out, /REFUSED real mode while fixture\/test mode is active/);
  assert.doesNotMatch(out, /ACTION_EXECUTED|MODE real/);
});

// Owner-facing copy for the real-mode prerequisite block. Each page was
// checked as an official page answering HTTP 200 on 2026-10-08; the named
// buttons and sections were read from those pages the same day. Codex is
// optional, and native Claude updates are accepted at or above the floor.
const OWNER_SOURCES = {
  node: "https://nodejs.org/en/download",
  macGit: "https://developer.apple.com/documentation/xcode/installing-the-command-line-tools",
  windowsGit: "https://git-scm.com/install/windows",
  claude: "https://code.claude.com/docs/en/setup#install-claude-code",
};
const OWNER_HEADER = [
  "Financial Brain setup cannot start yet. Nothing was downloaded or installed.",
  "What you need to do:",
];
const MAC_REOPEN_LINE = "When everything above is done, open Run Financial Brain Machine Prep again.";
const WINDOWS_REOPEN_LINE = "When everything above is done, open Run Financial Brain Machine Prep again from the Start menu.";
const NODE_HOW_MAC = `At the top of the page, choose a version that starts with v24 (marked LTS). Then, under "Or get a prebuilt Node.js", click "macOS Installer (.pkg)" and open the downloaded file. Download page: ${OWNER_SOURCES.node}`;
const NODE_HOW_WINDOWS = NODE_HOW_MAC.replace('"macOS Installer (.pkg)"', '"Windows Installer (.msi)"');
const GIT_HOW_MAC = `Follow the section "Install the Command Line Tools package in Terminal". Apple's guide: ${OWNER_SOURCES.macGit}`;
const GIT_HOW_WINDOWS = `Use the "Click here to download" link at the top of the page and open the downloaded file. Download page: ${OWNER_SOURCES.windowsGit}`;
const CLAUDE_HOW = `Under "Install Claude Code" on the setup page, choose "Native Install (Recommended)" and run the default command for your system. Setup page: ${OWNER_SOURCES.claude}`;
const CLAUDE_UPDATE_HOW = renderCliCommands("Open a new terminal and run claude update.");
const CLAUDE_CONFLICT_HOW = renderCliCommands("Open a new terminal and run claude doctor. Follow its installation warning to select the Native Install copy.");
const NODE_NEED = `Needs version 24 or 22. ${NODE_HOW_MAC}`;
const GIT_NEED = `Needs Apple's Command Line Tools, any version. ${GIT_HOW_MAC}`;
const CLAUDE_NEED = `Needs version 2.1.261 or newer. ${CLAUDE_HOW}`;
const CLAUDE_UPDATE_NEED = `Needs version 2.1.261 or newer. ${CLAUDE_UPDATE_HOW}`;
const CLAUDE_CONFLICT_NEED = `Needs version 2.1.261 or newer from Native Install. ${CLAUDE_CONFLICT_HOW}`;
const CLAUDE_ELSEWHERE = "another install is selected instead of the Native Install copy";
// Words a non-technical owner should never have to decode on the real-mode screen.
const OWNER_JARGON = /OWNER ACTION|prerequisite|run --real|\bPATH\b|SHADOWED|WRONG_VERSION|MISSING|turned off|Get it from|learn\.chatgpt\.com|\/fixture\/home|executed/;

function macRealBlock(...steps) {
  return [...OWNER_HEADER, ...steps, MAC_REOPEN_LINE, ""].join("\n");
}

// Source the real script in help mode, then replace only tool discovery and the
// Brain install. run_real, collect_checks and the prerequisite gate run as shipped.
const MAC_REAL_PROBE = [
  '. "$1" --help >/dev/null',
  'tool_paths() { v=$(/bin/cat "$PROBE_DIR/$1.paths" 2>/dev/null || true); [ "$v" != MISSING ] || return 0; printf \'%s\\n\' "$v" | /usr/bin/awk \'NF && !seen[$0]++\'; }',
  'tool_version() { v=$(/bin/cat "$PROBE_DIR/$1.version" 2>/dev/null || true); { [ -n "$v" ] && [ "$v" != MISSING ]; } || return 1; printf \'%s\\n\' "$v"; }',
  "install_brain() { printf 'PROBE_INSTALL_BRAIN_REACHED=1\\n'; }",
  "run_real",
].join("\n");

function runMacRealProbe(changes = {}, { mergeStreams = false } = {}) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-real-probe-")));
  const state = join(directory, "state");
  const home = join(directory, "home");
  cpSync(join(FIXTURES, "mac-ready"), state, { recursive: true });
  // Keep the host's Command Line Tools out of the decision: /usr/bin/git is
  // only trusted after xcode-select, which a fixture cannot replace.
  writeFileSync(join(state, "git.paths"), "/opt/homebrew/bin/git\n");
  for (const [name, value] of Object.entries(changes)) writeFileSync(join(state, name), `${value}\n`);
  mkdirSync(home);
  try {
    return spawnSync("bash", ["-c", mergeStreams ? MAC_REAL_PROBE.replace(/\nrun_real$/, "\nrun_real 2>&1") : MAC_REAL_PROBE, "probe", MAC], {
      cwd: ROOT,
      env: { PATH: "/usr/bin:/bin", HOME: home, MACHINE_PREP_HOME: "/fixture/home", PROBE_DIR: state, BRAIN_NO_WRANGLER_LOGIN: "1" },
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const FRESH_MAC = {
  "node.paths": "MISSING", "node.version": "MISSING", "npm.paths": "MISSING", "npm.version": "MISSING",
  "git.paths": "/usr/bin/git", "git.version": "MISSING", "xcode.status": "missing",
  "claude.paths": "MISSING", "claude.version": "MISSING", "codex.paths": "MISSING", "codex.version": "MISSING",
  "brain.paths": "MISSING", "brain.version": "MISSING",
};

test("Mac real mode names every missing prerequisite with its version and the exact official step, then says to reopen", macInstallOrchestrationOptions(), () => {
  const fresh = runMacRealProbe(FRESH_MAC);
  assert.equal(fresh.status, 2, `${fresh.stdout}${fresh.stderr}`);
  assert.equal(fresh.stdout, "Machine Prep for macOS\nMODE real\nPREREQUISITE_DECISION_REACHED=1\nCodex CLI (optional): not found. Setup can continue without it.\n");
  assert.equal(fresh.stderr, macRealBlock(
    `- Node.js: not found. ${NODE_NEED}`,
    `- Git: not found. ${GIT_NEED}`,
    `- Claude Code: not found. ${CLAUDE_NEED}`,
  ));
  assert.doesNotMatch(fresh.stderr, OWNER_JARGON);
  assert.doesNotMatch(fresh.stderr, /\.machine-prep-real-probe-/);

  const control = runMacRealProbe();
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
  assert.match(control.stdout, /PREREQUISITE_DECISION_REACHED=1\nCodex CLI \(optional\): [^\n]+\nPROBE_INSTALL_BRAIN_REACHED=1\nFinancial Brain CLI preparation completed\n$/);
  assert.equal(control.stderr, "");
});

test("Mac real mode lists only the tool that needs action, with a concrete step for wrong and duplicate copies", macInstallOrchestrationOptions(), () => {
  const cases = [
    ["node-v26", { "node.version": "v26.1.0" }, `- Node.js: version v26.1.0 is installed. ${NODE_NEED}`],
    ["git-stub-only", { "git.paths": "/usr/bin/git", "git.version": "MISSING", "xcode.status": "missing" }, `- Git: not found. ${GIT_NEED}`],
    ["claude-older", { "claude.version": "2.1.260 (Claude Code)" }, `- Claude Code: version 2.1.260 is installed. ${CLAUDE_UPDATE_NEED}`],
    ["claude-unreadable", { "claude.version": "MISSING" }, `- Claude Code: a copy was found, but its version could not be read. ${CLAUDE_NEED}`],
    ["claude-elsewhere", { "claude.paths": "/opt/homebrew/bin/claude" }, `- Claude Code: ${CLAUDE_ELSEWHERE}. ${CLAUDE_CONFLICT_NEED}`],
    ["claude-several-conflicting-first", { "claude.paths": "/usr/local/bin/claude\n/fixture/home/.local/bin/claude" }, `- Claude Code: ${CLAUDE_ELSEWHERE}. ${CLAUDE_CONFLICT_NEED}`],
  ];
  for (const [name, changes, line] of cases) {
    const result = runMacRealProbe(changes);
    assert.equal(result.status, 2, `${name}\n${result.stdout}${result.stderr}`);
    assert.equal(result.stderr, macRealBlock(line), name);
    assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/, name);
    assert.doesNotMatch(result.stderr, OWNER_JARGON, name);
    assert.doesNotMatch(result.stdout, /PROBE_INSTALL_BRAIN_REACHED/, name);
  }
});

// Same shipped run_real, but tool discovery and version reads are the real
// ones, against install layouts the official pages actually produce. Only the
// Brain install is replaced. Scratch folders stand in for /usr/local/bin
// (npm's default global folder with the Node .pkg) and /opt/homebrew/bin.
const MAC_REAL_DISCOVERY_PROBE = [
  '. "$1" --help >/dev/null',
  "install_brain() { printf 'PROBE_INSTALL_BRAIN_REACHED=1\\n'; }",
  "run_real",
].join("\n");

function runMacRealDiscovery(layout) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-real-discovery-")));
  const home = join(directory, "home");
  const bin = join(home, ".local", "bin");
  const npmGlobal = join(directory, "npm-global-bin");
  const homebrew = join(directory, "homebrew-bin");
  const tools = join(directory, "tools-bin");
  const script = (path, body) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  for (const folder of [bin, npmGlobal, homebrew, tools]) mkdirSync(folder, { recursive: true });
  script(join(tools, "node"), "echo v24.21.0");
  script(join(tools, "npm"), "echo 11.19.0");
  script(join(tools, "git"), "echo git version 2.50.1");
  const nativeClaude = (version) => {
    const target = join(home, ".local", "share", "claude", "versions", version);
    script(target, `echo "${version} (Claude Code)"`);
    symlinkSync(target, join(bin, "claude"));
  };
  const npmPrefixCodex = (version) => {
    const packageDir = join(home, ".local", "lib", "node_modules", "@openai", "codex");
    script(join(packageDir, "bin", "codex.js"), `echo "codex-cli ${version}"`);
    writeFileSync(join(packageDir, "package.json"), `{\n  "name": "@openai/codex",\n  "version": "${version}"\n}\n`);
    symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(bin, "codex"));
  };
  layout({ home, bin, npmGlobal, homebrew, script, nativeClaude, npmPrefixCodex });
  try {
    const result = spawnSync("bash", ["-c", MAC_REAL_DISCOVERY_PROBE, "probe", MAC], {
      cwd: ROOT,
      env: {
        PATH: [join(home, ".financial-brain", "bin"), bin, npmGlobal, homebrew, tools, "/usr/bin", "/bin"].join(":"),
        HOME: home,
        MACHINE_PREP_HOME: home,
        BRAIN_NO_WRANGLER_LOGIN: "1",
      },
      encoding: "utf8",
    });
    return { ...result, directory };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Mac real discovery accepts native Claude updates and every optional Codex layout", macInstallOrchestrationOptions(), () => {
  const cases = [
    ["native-floor", ({ nativeClaude }) => nativeClaude("2.1.261")],
    ["native-latest", ({ nativeClaude }) => nativeClaude("2.1.294")],
    ["codex-old-package", ({ nativeClaude, npmPrefixCodex }) => {
      nativeClaude("2.1.261"); npmPrefixCodex("0.1.0");
    }],
    ["codex-new-package", ({ nativeClaude, npmPrefixCodex }) => {
      nativeClaude("2.1.261"); npmPrefixCodex("9.0.0");
    }],
    ["codex-standalone", ({ home, bin, script, nativeClaude }) => {
      nativeClaude("2.1.261");
      const target = join(home, ".codex", "packages", "standalone", "current", "codex");
      script(target, "exit 91 # optional assistant must never be launched");
      symlinkSync(target, join(bin, "codex"));
    }],
    ["codex-npm-default", ({ npmGlobal, script, nativeClaude }) => {
      nativeClaude("2.1.261"); script(join(npmGlobal, "codex"), "exit 91");
    }],
    ["codex-homebrew", ({ homebrew, script, nativeClaude }) => {
      nativeClaude("2.1.261"); script(join(homebrew, "codex"), "exit 91");
    }],
    ["unused-claude-copy", ({ homebrew, script, nativeClaude }) => {
      nativeClaude("2.1.294"); script(join(homebrew, "claude"), "exit 91");
    }],
  ];
  for (const [name, layout] of cases) {
    const result = runMacRealDiscovery(layout);
    assert.equal(result.status, 0, `${name}\n${combined(result)}`);
    assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/);
    assert.match(result.stdout, /Codex CLI \(optional\): /);
    assert.match(result.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/);
    assert.equal(result.stderr, "");
    assert.ok(!combined(result).includes(result.directory), "private path on screen");
  }
  for (const [layout, step] of [
    [({ nativeClaude }) => nativeClaude("2.1.260"), `- Claude Code: version 2.1.260 is installed. ${CLAUDE_UPDATE_NEED}`],
    [({ homebrew, script }) => script(join(homebrew, "claude"), "exit 91"), `- Claude Code: ${CLAUDE_ELSEWHERE}. ${CLAUDE_CONFLICT_NEED}`],
  ]) {
    const result = runMacRealDiscovery(layout);
    assert.equal(result.status, 2, combined(result));
    assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/);
    assert.doesNotMatch(result.stdout, /PROBE_INSTALL_BRAIN_REACHED/);
    assert.equal(result.stderr, macRealBlock(step));
    assert.doesNotMatch(result.stderr, OWNER_JARGON);
  }
});

test("Mac check uses the Claude floor and reports Codex without blocking", macRuntimeOptions(), () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-fixture-")));
  try {
    cpSync(join(FIXTURES, "mac-ready"), directory, { recursive: true });
    for (const version of ["2.1.261", "2.1.300", "2.1.1000", "2.10.0", "3.0.0"]) {
      writeFileSync(join(directory, "claude.version"), `${version} (Claude Code)\n`);
      writeFileSync(join(directory, "codex.paths"), "MISSING\n");
      writeFileSync(join(directory, "codex.version"), "MISSING\n");
      const control = runMac(["--check"], directory);
      assert.equal(control.status, 0, combined(control));
      assert.match(control.stdout, /CHECKS_REACHED=10/);
      assert.match(control.stdout, /READY\s+Claude Code/);
      assert.match(control.stdout, /OPTIONAL\s+Codex CLI\s+not found/);
    }
    for (const version of ["1.99.999", "2.0.999", "2.1.260", "2.1.9", "2.1.261-beta.1", "2.1.261 extra"]) {
      writeFileSync(join(directory, "claude.version"), `${version} (Claude Code)\n`);
      const refused = runMac(["--check"], directory);
      assert.equal(refused.status, 1, combined(refused));
      assert.match(refused.stdout, /CHECKS_REACHED=10/);
      assert.match(refused.stdout, /(?:WRONG_VERSION|MISSING)\s+Claude Code/);
      assert.doesNotMatch(refused.stdout, /replace it with pinned|exactly version/);
    }
    writeFileSync(join(directory, "claude.version"), "2.1.261 (Claude Code)\n");
    writeFileSync(join(directory, "claude.paths"), "/opt/homebrew/bin/claude\n");
    const shadowed = runMac(["--check"], directory);
    assert.equal(shadowed.status, 1, combined(shadowed));
    assert.match(shadowed.stdout, /SHADOWED\s+Claude Code/);
    assert.ok(shadowed.stdout.includes(CLAUDE_CONFLICT_HOW));
    assert.match(shadowed.stdout, /CHECKS_REACHED=10/);
    assert.doesNotMatch(shadowed.stdout, /\/opt\/homebrew|\/fixture\/home/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function functionBody(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `function ${start} not found`);
  return source.slice(from, to);
}

const MAC_OWNER_NAMES = ["NODE_SOURCE", "GIT_SOURCE", "CLAUDE_SOURCE", "NODE_HOW", "GIT_HOW", "CLAUDE_HOW", "CLAUDE_UPDATE_HOW", "CLAUDE_CONFLICT_HOW"];

// The Mac constants as written in the shipped script: one double-quoted line
// each, with \" escapes and earlier $NAME references expanded.
function macOwnerConstantsFromSource(source) {
  const variables = {};
  for (const name of ["CLAUDE_MIN_VERSION", ...MAC_OWNER_NAMES]) {
    const match = source.match(new RegExp(`^${name}="((?:\\\\.|[^"\\\\])*)"$`, "m"));
    assert.ok(match, `${name} must be one double-quoted line`);
    variables[name] = match[1].replaceAll('\\"', '"').replace(/\$([A-Z_]+)/g, (whole, variable) => {
      assert.ok(variable in variables, `${name} uses ${whole} before it is defined`);
      return variables[variable];
    });
  }
  return Object.fromEntries(MAC_OWNER_NAMES.map((name) => [name, variables[name]]));
}

// Mac values come from the shipped script itself. Where bash runs (macOS,
// Linux), the script is sourced and must agree with the source reading;
// Windows runners have no usable /usr/bin/bash, so only the source is read.
function macOwnerConstants() {
  const fromSource = macOwnerConstantsFromSource(readFileSync(MAC, "utf8").replaceAll("\r\n", "\n"));
  if (process.platform === "win32") return fromSource;
  const result = spawnSync("bash", ["-c", `. "$1" --help >/dev/null; printf '%s\\n' ${MAC_OWNER_NAMES.map((name) => `"$${name}"`).join(" ")}`, "constants", MAC], {
    cwd: ROOT, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, BRAIN_NO_WRANGLER_LOGIN: "1" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const values = result.stdout.split("\n");
  const sourced = Object.fromEntries(MAC_OWNER_NAMES.map((name, index) => [name, values[index]]));
  assert.deepEqual(fromSource, sourced, "the source reading must match what bash produces");
  return sourced;
}

function windowsOwnerConstants(source) {
  const variables = { ClaudeMinVersion: "2.1.261" };
  const names = ["NodeSource", "GitSource", "ClaudeSource", "NodeHow", "GitHow", "ClaudeHow", "ClaudeUpdateHow", "ClaudeConflictHow"];
  for (const name of names) {
    const match = source.match(new RegExp(`^\\$${name} = "((?:[^"]|"")*)"$`, "m"));
    assert.ok(match, `$${name} must be one double-quoted line`);
    variables[name] = match[1].replaceAll('""', '"').replace(/\$([A-Za-z]+)/g, (whole, variable) => {
      assert.ok(variable in variables, `$${name} uses ${whole} before it is defined`);
      return variables[variable];
    });
  }
  return variables;
}

// Arguments may be "double-quoted" (bash \" or PowerShell "" escapes),
// 'single-quoted', or a bare PowerShell variable.
function ownerStepCalls(source, name) {
  const placeholders = [
    ["CLAUDE_MIN_VERSION", "ClaudeMinVersion", "{claude}"],
    ["NODE_HOW", "NodeHow", "{node-how}"], ["GIT_HOW", "GitHow", "{git-how}"],
    ["CLAUDE_HOW", "ClaudeHow", "{claude-how}"],
    ["CLAUDE_UPDATE_HOW", "ClaudeUpdateHow", "{claude-update-how}"],
    ["CLAUDE_CONFLICT_HOW", "ClaudeConflictHow", "{claude-conflict-how}"],
  ];
  return source.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${name} `))
    .map((line) => [...line.slice(name.length).matchAll(/"((?:\\.|""|[^"\\])*)"|'([^']*)'|(\$[A-Za-z_]+)/g)].map((match) => {
      let value = match[1] !== undefined ? match[1].replaceAll('\\"', '"').replaceAll('""', '"') : (match[2] ?? match[3]);
      for (const [macName, windowsName, placeholder] of placeholders) {
        value = value.replaceAll(`$${macName}`, placeholder).replaceAll(`$${windowsName}`, placeholder);
      }
      return value;
    }));
}

test("Windows prerequisite rows and owner steps mirror the Mac source line for line", () => {
  const mac = readFileSync(MAC, "utf8").replaceAll("\r\n", "\n");
  const windows = readFileSync(WINDOWS, "utf8").replaceAll("\r\n", "\n");
  const macCopy = macOwnerConstants();
  const windowsCopy = windowsOwnerConstants(windows);
  assert.equal(macCopy.NODE_SOURCE, OWNER_SOURCES.node);
  assert.equal(macCopy.GIT_SOURCE, OWNER_SOURCES.macGit);
  assert.equal(macCopy.CLAUDE_SOURCE, OWNER_SOURCES.claude);
  assert.equal(macCopy.NODE_HOW, NODE_HOW_MAC);
  assert.equal(macCopy.GIT_HOW, GIT_HOW_MAC);
  assert.equal(macCopy.CLAUDE_HOW, CLAUDE_HOW);
  assert.equal(macCopy.CLAUDE_UPDATE_HOW, CLAUDE_UPDATE_HOW);
  assert.equal(macCopy.CLAUDE_CONFLICT_HOW, CLAUDE_CONFLICT_HOW);
  assert.equal(windowsCopy.NodeSource, OWNER_SOURCES.node);
  assert.equal(windowsCopy.GitSource, OWNER_SOURCES.windowsGit);
  assert.equal(windowsCopy.ClaudeSource, OWNER_SOURCES.claude);
  assert.equal(windowsCopy.NodeHow, NODE_HOW_WINDOWS);
  assert.equal(windowsCopy.GitHow, GIT_HOW_WINDOWS);
  assert.equal(windowsCopy.ClaudeHow, CLAUDE_HOW);
  assert.equal(windowsCopy.ClaudeUpdateHow, CLAUDE_UPDATE_HOW);
  assert.equal(windowsCopy.ClaudeConflictHow, CLAUDE_CONFLICT_HOW);
  // No Codex pin, support step, or installer URL remains.
  for (const source of [mac, windows]) assert.doesNotMatch(source, /learn\.chatgpt\.com|CODEX_(?:SOURCE|VERSION|HOW)|\$Codex(?:Source|Version|How)/);

  const macChecks = functionBody(mac, "collect_checks() {", "\n}\n");
  const windowsChecks = functionBody(windows, "function Invoke-Checks {", "\n}\n");
  const macSteps = ownerStepCalls(macChecks, "owner_step");
  const windowsSteps = ownerStepCalls(windowsChecks, "Add-OwnerStep");
  assert.equal(macSteps.length, 7, JSON.stringify(macSteps));
  assert.equal(windowsSteps.length, 6, JSON.stringify(windowsSteps));
  for (const steps of [macSteps, windowsSteps]) {
    for (const args of steps) assert.equal(args.length, 4, `owner step needs tool, problem, need and next step: ${JSON.stringify(args)}`);
  }
  const isGit = (args) => args[0] === "Git";
  assert.deepEqual(macSteps.filter(isGit), [["Git", "not found", "Apple's Command Line Tools, any version", "{git-how}"]]);
  assert.deepEqual(windowsSteps.filter(isGit), [["Git", "not found", "Git for Windows, any version", "{git-how}"]]);
  assert.deepEqual(macSteps.filter((args) => args[0] === "macOS session"), [[
    "macOS session", "this launcher was started with administrator rights (sudo)", "your own normal account",
    "Close this window and double-click the launcher again.",
  ]]);
  assert.deepEqual(
    macSteps.filter((args) => !isGit(args) && args[0] !== "macOS session"),
    windowsSteps.filter((args) => !isGit(args)),
  );
  assert.equal(macSteps.filter((args) => args[0] === "Codex CLI").length, 0);
  for (const literal of [CLAUDE_ELSEWHERE, "version {claude} or newer", "{claude-update-how}"]) {
    assert.ok(JSON.stringify(macSteps).includes(literal), literal);
  }
  for (const body of [macChecks, windowsChecks]) {
    assert.equal(body.split('"not found"').length - 1, 3, "Node, Git, and missing Claude");
    assert.equal(body.split('"a copy was found, but its version could not be read"').length - 1, 1);
    assert.match(body, /OPTIONAL/);
  }
  assert.equal(macSteps.filter((args) => args[1] === "$problem").length, 1);
  assert.equal(windowsSteps.filter((args) => args[1] === "$problem").length, 1);

  // Every failing prerequisite branch records exactly one owner step.
  for (const [body, pattern, call] of [
    [macChecks, /^\s*(?:NODE|GIT|CLAUDE|CODEX|SESSION)_STATE="(?:MISSING|WRONG_VERSION|SHADOWED)"$/, "owner_step "],
    [windowsChecks, /^\s*\$script:(?:Node|Git|Claude|Codex)State = "(?:MISSING|WRONG_VERSION|SHADOWED)"$/, "Add-OwnerStep "],
  ]) {
    const lines = body.split("\n");
    const branches = lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
    assert.equal(branches.length, call === "owner_step " ? 7 : 6);
    for (const index of branches) {
      const window = lines.slice(index + 1, index + 5).join("\n");
      assert.equal(window.split(call).length - 1, 1, `${lines[index]} must record one owner step`);
    }
  }

  // Rows: no prerequisite tells the owner to rerun real mode or edit PATH, and
  // no row promises an update setting the check never reads.
  for (const source of [mac, windows]) {
    const assistantRows = source.split("\n").filter((line) => /(?:status_line|Write-Status) .*"(?:Claude Code|Codex CLI)"/.test(line));
    assert.equal(assistantRows.length, 5);
    for (const row of assistantRows) assert.doesNotMatch(row, /run --real|first on PATH|\$BIN_DIR|\$canonical|automatic updates/, row);
    assert.equal(source.match(/fix: run --real/g).length, 1, "only the Financial Brain CLI row may point at real mode");
  }
  assert.doesNotMatch(windows, /Git for Windows 2\.54\.0/);

  // Real mode prints a plain header, the recorded steps, then the reopen line.
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const macReal = functionBody(mac, "run_real() {", "\n}\n");
  assert.match(macReal, new RegExp([
    "collect_checks >/dev/null",
    "printf 'PREREQUISITE_DECISION_REACHED=1\\\\n'",
    ...OWNER_HEADER.map((line) => `printf '${escape(line)}\\\\n' >&2`),
    "printf '%s' \"\\$OWNER_STEPS\" >&2",
    `printf '${escape(MAC_REOPEN_LINE)}\\\\n' >&2`,
    "return 2",
  ].join("[\\s\\S]*?")));
  assert.match(macReal, /install_brain \|\| return 1/);
  const windowsReal = functionBody(windows, "function Invoke-Real {", "\n}\n");
  assert.match(windowsReal, new RegExp([
    "Invoke-Checks \\| Out-Null",
    'Write-Output "PREREQUISITE_DECISION_REACHED=1"',
    ...OWNER_HEADER.map((line) => `\\[Console\\]::Error\\.WriteLine\\("${escape(line)}"\\)`),
    "foreach \\(\\$step in \\$script:OwnerSteps\\) \\{ \\[Console\\]::Error\\.WriteLine\\(\\$step\\) \\}",
    `\\[Console\\]::Error\\.WriteLine\\("${escape(WINDOWS_REOPEN_LINE)}"\\)`,
    "\\$script:RealExitCode = 2",
  ].join("[\\s\\S]*?")));
  for (const body of [macReal, windowsReal]) {
    assert.doesNotMatch(body, /OWNER ACTION|prerequisite was downloaded|CODEX_STATE|CodexState/);
    assert.match(body, /Codex CLI \(optional\): /);
  }
  assert.match(macChecks, /elif claude_meets_floor/);
  assert.match(windowsChecks, /elseif \(Test-ClaudeFloor/);
  assert.doesNotMatch(macChecks, /claude_count/);
  assert.doesNotMatch(windowsChecks, /\$claudePaths\.Count -gt 1/);
  assert.match(mac, /a\[i\] \+ 0 > f\[i\] \+ 0/);
  assert.match(windows, /\[double\]\$actualParts\[\$i\] -gt \[double\]\$floorParts\[\$i\]/);
  for (const detail of ["not found. Setup can continue without it.", "found; version unavailable. Setup can continue without it."]) {
    assert.ok(mac.includes(detail)); assert.ok(windows.includes(detail));
  }
  // Mirror install_brain || return 1: report the reason without PowerShell's
  // script-path trailer, which would put the owner's profile path on screen.
  assert.match(windowsReal, /try \{ Install-Brain \} catch \{\s*\[Console\]::Error\.WriteLine\(\[string\]\$_\.Exception\.Message\)\s*\$script:RealExitCode = 1\s*return\s*\}/);
});

test("Mac install orchestration platform guard keeps Darwin coverage active", () => {
  assert.deepEqual(macRuntimeOptions("darwin"), { skip: false });
  assert.deepEqual(macRuntimeOptions("linux"), { skip: false });
  assert.deepEqual(macRuntimeOptions("win32"), { skip: MAC_RUNTIME_ON_WINDOWS_SKIP_REASON });
  assert.deepEqual(macInstallOrchestrationOptions("darwin"), { skip: false });
  assert.deepEqual(macInstallOrchestrationOptions("linux"), { skip: MAC_INSTALL_ORCHESTRATION_SKIP_REASON });
  assert.deepEqual(macInstallOrchestrationOptions("win32"), { skip: MAC_INSTALL_ORCHESTRATION_SKIP_REASON });
});

test("Mac install orchestration preserves every foreign collision and cleans only owned material", macInstallOrchestrationOptions(), () => {
  for (const scenario of ["lock-collision", "stage-collision", "destination-race"]) {
    const probe = runMacInstallOrchestration({ scenario });
    try {
      const out = combined(probe.result);
      assert.notEqual(probe.result.status, 0, `${scenario}\n${out}`);
      assert.match(out, /INSTALL_LOCK_DECISION_REACHED=1/);
      if (scenario !== "lock-collision") assert.match(out, /STAGE_ALLOCATION_DECISION_REACHED=1/);
      if (scenario === "lock-collision") {
        assert.equal(readFileSync(join(probe.lock, "foreign.txt"), "utf8"), "preserve\n");
      } else if (scenario === "stage-collision") {
        assert.equal(readFileSync(join(probe.stage, "foreign.txt"), "utf8"), "preserve\n");
      } else {
        assert.equal(readFileSync(join(probe.prefix, "foreign.txt"), "utf8"), "foreign\n");
        assert.deepEqual(readdirSync(probe.prefix), ["foreign.txt"]);
      }
      assert.match(out, /CLEANUP_(?:OWNERSHIP_DECISION_REACHED|STOP_UNOWNED)=1/);
    } finally {
      probe.cleanup();
    }
  }
});

test("Mac install orchestration removes its failed attempt and atomically publishes a passing control", macInstallOrchestrationOptions(), () => {
  const failed = runMacInstallOrchestration({ scenario: "install-failure" });
  try {
    const out = combined(failed.result);
    assert.notEqual(failed.result.status, 0, out);
    assert.match(out, /INSTALL_STARTED=1/);
    assert.equal(existsSync(failed.stage), false, "owned failed stage must be removed");
    assert.equal(existsSync(failed.lock), false, "owned failed lock must be removed");
    assert.equal(existsSync(failed.prefix), false, "failed install must not publish a prefix");
  } finally {
    failed.cleanup();
  }

  const control = runMacInstallOrchestration({ scenario: "success" });
  try {
    const out = combined(control.result);
    assert.equal(control.result.status, 0, out);
    assert.match(out, /NPM_ENVIRONMENT_ISOLATED=1/);
    assert.match(out, /STAGED_PREFIX_VERIFIED=1/);
    assert.match(out, /ATOMIC_PROMOTION_DECISION_REACHED=1/);
    assert.match(out, /ATOMIC_PROMOTION_VERIFIED=1/);
    assert.equal(lstatSync(control.prefix).isDirectory(), true);
    assert.equal(existsSync(control.stage), false);
    assert.equal(existsSync(join(control.prefix, "bin", "brain")), true);
    assert.equal(existsSync(control.lock), false);
  } finally {
    control.cleanup();
  }
});

function assertInstallVerificationRefusal(probe, decisionPattern) {
  const out = combined(probe.result);
  assert.notEqual(probe.result.status, 0, out);
  assert.match(out, /DOWNLOAD_STARTED=1/);
  assert.match(out, decisionPattern);
  assert.doesNotMatch(out, /INSTALL_STARTED=1|ATOMIC_PROMOTION_DECISION_REACHED=1/);
  assert.equal(existsSync(probe.prefix), false, "verification refusal must not publish the prefix");
  assert.equal(existsSync(probe.stage), false, "verification refusal must not start npm staging");
}

test("Mac actual install refuses bad kit size and digest before npm or promotion, with a matching control", macInstallOrchestrationOptions(), () => {
  const cases = [
    { name: "bad-size", options: { kitSizeOffset: 1 }, decision: /KIT_SIZE_DECISION_REACHED=1/ },
    { name: "bad-digest", options: { kitShaOverride: "0".repeat(64) }, decision: /CHECKSUM_DECISION_REACHED=1/ },
  ];
  for (const item of cases) {
    const probe = runMacInstallOrchestration({ scenario: "success", ...item.options });
    try {
      assertInstallVerificationRefusal(probe, item.decision);
    } finally {
      probe.cleanup();
    }
  }

  const control = runMacInstallOrchestration({ scenario: "success" });
  try {
    assert.equal(control.result.status, 0, combined(control.result));
    assert.match(combined(control.result), /KIT_SIZE_DECISION_REACHED=1[\s\S]*CHECKSUM_DECISION_REACHED=1[\s\S]*ATOMIC_PROMOTION_VERIFIED=1/);
  } finally {
    control.cleanup();
  }
});

test("Mac install verification-call mutation turns both bad-kit controls red", macInstallOrchestrationOptions(), () => {
  const source = readFileSync(MAC, "utf8");
  const from = '  verify_brain_kit "$archive" || return 1\n';
  assert.equal(source.includes(from), true, "missing Mac install verification decision");
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-verify-mutant-")));
  const script = join(directory, "prep-mac.sh");
  writeFileSync(script, source.replace(from, ""));
  chmodSync(script, 0o755);
  try {
    for (const options of [{ kitSizeOffset: 1 }, { kitShaOverride: "0".repeat(64) }]) {
      const probe = runMacInstallOrchestration({ scenario: "success", script, ...options });
      try {
        assert.throws(() => assertInstallVerificationRefusal(probe, /(?:KIT_SIZE|CHECKSUM)_DECISION_REACHED=1/), undefined,
          "removing verify_brain_kit survived an actual install control");
      } finally {
        probe.cleanup();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac installer mutations disable real ownership, promotion, and environment protections", macInstallOrchestrationOptions(), () => {
  const source = readFileSync(MAC, "utf8");
  const cases = [
    {
      name: "ownership marker check",
      from: 'if ! owns_attempt_dir "$owned_path"; then',
      to: "if false; then",
      scenario: "lock-collision",
      assertSafe(probe) {
        assert.notEqual(probe.result.status, 0);
        assert.equal(readFileSync(join(probe.lock, "foreign.txt"), "utf8"), "preserve\n");
      },
    },
    {
      name: "atomic no-replace publication",
      from: `/usr/bin/osascript -l JavaScript -e \\
    'ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]); function run(argv) { if (Number($.renamex_np(argv[0], argv[1], 4)) !== 0) throw new Error("exclusive rename failed"); return "promoted"; }' \\
    "$stage" "$BRAIN_PREFIX" >/dev/null 2>&1`,
      to: `/bin/mv "$stage" "$BRAIN_PREFIX" 2>/dev/null`,
      scenario: "destination-race",
      assertSafe(probe) {
        assert.notEqual(probe.result.status, 0);
        assert.deepEqual(readdirSync(probe.prefix), ["foreign.txt"]);
      },
    },
    {
      name: "isolated npm environment",
      from: "/usr/bin/env -i HOME=",
      to: "/usr/bin/env HOME=",
      scenario: "success",
      assertSafe(probe) {
        assert.equal(probe.result.status, 0, combined(probe.result));
        assert.match(combined(probe.result), /ATOMIC_PROMOTION_VERIFIED=1/);
      },
    },
  ];

  for (const item of cases) {
    assert.equal(source.includes(item.from), true, `missing mutation target: ${item.name}`);
    const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-mutant-")));
    const script = join(directory, "prep-mac.sh");
    writeFileSync(script, source.replace(item.from, item.to));
    chmodSync(script, 0o755);
    const probe = runMacInstallOrchestration({ scenario: item.scenario, script });
    try {
      assert.throws(() => item.assertSafe(probe), undefined, `${item.name} mutation survived`);
    } finally {
      probe.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("both prototypes expose check, dry-run, real mode, and checksum gates", () => {
  const mac = readFileSync(MAC, "utf8");
  const windows = readFileSync(WINDOWS, "utf8");
  for (const source of [mac, windows]) {
    assert.match(source, /--check/);
    assert.match(source, /--dry-run/);
    assert.match(source, /CHECKSUM_DECISION_REACHED/);
    assert.match(source, /24\.13\.1/);
    assert.match(source, /2\.1\.261/);
    assert.match(source, /OPTIONAL/);
    assert.doesNotMatch(source, /CODEX_VERSION|\$CodexVersion/);
    assert.doesNotMatch(source, /CLOUDFLARE_API_TOKEN|ADMIN_KEY|curl[^\n]*\|[^\n]*(?:sh|bash)/);
  }
});

test("Windows fixture coverage runs on the Windows CI lane", { skip: process.platform !== "win32" }, () => {
  const check = runWindows(["--check"]);
  const checkOut = combined(check);
  assert.equal(check.status, 1, checkOut);
  assert.match(checkOut, /CHECKS_REACHED=9/);
  assert.match(checkOut, /WRONG_VERSION  Node\.js/);
  assert.match(checkOut, /MISSING        Claude Code/);
  assert.match(checkOut, /OPTIONAL       Codex CLI/);
  assert.match(checkOut, /SHADOWED       Financial Brain CLI/);
  assert.match(checkOut, /READY          Wrangler/);

  const ready = runWindows(["--check"], "windows-ready");
  assert.equal(ready.status, 0, combined(ready));
  assert.match(combined(ready), /READINESS GREEN/);

  const first = runWindows(["--dry-run"]);
  const second = runWindows(["--dry-run"]);
  const expected = readFileSync(join(FIXTURES, "windows-dry-run.txt"), "utf8").replaceAll("\r\n", "\n");
  assert.equal(first.status, 0, combined(first));
  assert.equal(combined(first), expected);
  assert.equal(combined(second), expected);

  const refused = runWindows(["--real"]);
  assert.equal(refused.status, 2, combined(refused));
  assert.match(combined(refused), /REFUSED real mode while fixture\/test mode is active/);
  assert.doesNotMatch(combined(refused), /ACTION_EXECUTED|MODE real/);
});

test("Windows checksum mismatch reaches verification and refuses before action", { skip: process.platform !== "win32" }, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-checksum-")));
  try {
    const artifact = join(directory, "artifact.bin");
    writeFileSync(artifact, "fixture artifact\n");
    const result = runWindows(["--verify-checksum", artifact, "0".repeat(64)]);
    const out = combined(result);
    assert.equal(result.status, 2, out);
    assert.match(out, /CHECKSUM_DECISION_REACHED=1/);
    assert.match(out, /REFUSED checksum mismatch/);
    assert.doesNotMatch(out, /ACTION_EXECUTED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows Brain prefix gate accepts an absent target and refuses a collision", { skip: process.platform !== "win32" }, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-prefix-")));
  const prefix = join(directory, "brain-prefix");
  try {
    const available = runWindows(["--verify-prefix", prefix]);
    assert.equal(available.status, 0, combined(available));
    assert.match(combined(available), /PREFIX_DECISION_REACHED=1/);
    assert.match(combined(available), /AVAILABLE prefix/);

    mkdirSync(prefix);
    const collision = runWindows(["--verify-prefix", prefix]);
    const out = combined(collision);
    assert.equal(collision.status, 2, out);
    assert.match(out, /PREFIX_DECISION_REACHED=1/);
    assert.match(out, /REFUSED prefix collision/);
    assert.doesNotMatch(out, /INSTALL_STARTED|DOWNLOAD_STARTED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows installed-Brain readback recognizes an exact existing install without relying on PATH", { skip: process.platform !== "win32" }, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-installed-brain-")));
  const prefix = join(directory, "brain-prefix");
  try {
    mkdirSync(join(prefix, "node_modules", "brain-installer"), { recursive: true });
    writeFileSync(join(prefix, "node_modules", "brain-installer", "package.json"), '{"version":"0.4.9"}\n');
    writeFileSync(join(prefix, "brain.cmd"), "@echo off\r\n");
    const ready = runWindows(["--verify-installed", prefix]);
    assert.equal(ready.status, 2, combined(ready));
    assert.match(combined(ready), /INSTALLED_BRAIN_DECISION_REACHED=1/);
    assert.match(combined(ready), /REUSE_ATTEMPTED=0/);

    writeFileSync(join(prefix, "node_modules", "brain-installer", "package.json"), '{"version":"0.4.8"}\n');
    const wrong = runWindows(["--verify-installed", prefix]);
    assert.equal(wrong.status, 2, combined(wrong));
    assert.match(combined(wrong), /INSTALLED_BRAIN_DECISION_REACHED=1/);
    assert.match(combined(wrong), /REUSE_ATTEMPTED=0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows pinned stream writer succeeds through File.Open CreateNew and preserves collisions", { skip: process.platform !== "win32" }, () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-download-")));
  const home = join(directory, "home");
  const source = join(directory, "source.bin");
  mkdirSync(join(home, "temp"), { recursive: true });
  writeFileSync(source, "synthetic-kit-bytes");
  try {
    const destination = join(directory, "download.bin");
    const success = runWindowsScratch(WINDOWS, ["--test-copy-pinned-kit", source, destination, String(readFileSync(source).length)], home);
    assert.equal(success.status, 0, combined(success));
    assert.match(combined(success), /DOWNLOAD_WRITE_DECISION_REACHED=1/);
    assert.match(combined(success), /DOWNLOAD_WRITE_VERIFIED=1/);
    assert.equal(readFileSync(destination, "utf8"), "synthetic-kit-bytes");

    const collision = runWindowsScratch(WINDOWS, ["--test-copy-pinned-kit", source, destination, String(readFileSync(source).length)], home);
    assert.notEqual(collision.status, 0);
    assert.match(combined(collision), /DOWNLOAD_WRITE_DECISION_REACHED=1/);
    assert.equal(readFileSync(destination, "utf8"), "synthetic-kit-bytes");

    for (const [name, expected] of [["truncated", readFileSync(source).length + 1], ["oversized", readFileSync(source).length - 1]]) {
      const target = join(directory, `${name}.bin`);
      const refused = runWindowsScratch(WINDOWS, ["--test-copy-pinned-kit", source, target, String(expected)], home);
      assert.notEqual(refused.status, 0);
      assert.match(combined(refused), /DOWNLOAD_WRITE_DECISION_REACHED=1/);
      assert.equal(existsSync(target), false, `${name} output created by this attempt must be cleaned`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows actual install refuses bad kit size and digest before npm or promotion, with a matching control", { skip: process.platform !== "win32", timeout: 300_000 }, () => {
  const cases = [
    { name: "bad-size", options: { kitSizeOffset: 1 }, decision: /KIT_SIZE_DECISION_REACHED=1/ },
    { name: "bad-digest", options: { kitShaOverride: "0".repeat(64) }, decision: /CHECKSUM_DECISION_REACHED=1/ },
  ];
  for (const item of cases) {
    const probe = runWindowsInstallOrchestration({ scenario: "success", ...item.options });
    try {
      assertInstallVerificationRefusal(probe, item.decision);
    } finally {
      probe.cleanup();
    }
  }

  const control = runWindowsInstallOrchestration({ scenario: "success" });
  try {
    assert.equal(control.result.status, 0, combined(control.result));
    assert.match(combined(control.result), /KIT_SIZE_DECISION_REACHED=1[\s\S]*CHECKSUM_DECISION_REACHED=1[\s\S]*ATOMIC_PROMOTION_VERIFIED=1/);
  } finally {
    control.cleanup();
  }
});

test("Windows install verification-call mutation turns both bad-kit controls red", { skip: process.platform !== "win32", timeout: 300_000 }, () => {
  const source = readFileSync(WINDOWS, "utf8").replaceAll("\r\n", "\n");
  const from = "    Test-BrainKit $archive\n";
  assert.equal(source.includes(from), true, "missing Windows install verification decision");
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-verify-mutant-")));
  const script = join(directory, "prep-windows.ps1");
  writeFileSync(script, source.replace(from, ""));
  try {
    for (const options of [{ kitSizeOffset: 1 }, { kitShaOverride: "0".repeat(64) }]) {
      const probe = runWindowsInstallOrchestration({ scenario: "success", script, ...options });
      try {
        assert.throws(() => assertInstallVerificationRefusal(probe, /(?:KIT_SIZE|CHECKSUM)_DECISION_REACHED=1/), undefined,
          "removing Test-BrainKit survived an actual install control");
      } finally {
        probe.cleanup();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows isolated npm drains output larger than pipe capacity without deadlock", { skip: process.platform !== "win32", timeout: 150_000 }, () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-pipes-")));
  const home = join(directory, "home");
  const temp = join(home, "temp");
  const npm = join(directory, "npm-fixture.cmd");
  mkdirSync(temp, { recursive: true });
  writeFileSync(npm, "@echo off\r\nfor /L %%i in (1,1,20000) do @echo stderr-%%i 1>&2\r\nfor /L %%i in (1,1,20000) do @echo stdout-%%i\r\nexit /b 0\r\n");
  try {
    const result = runWindowsScratch(WINDOWS, ["--test-isolated-npm", npm, join(directory, "prefix"), join(directory, "archive.tgz"), temp], home, { timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, combined(result));
    assert.match(combined(result), /REDIRECTED_PROCESS_DECISION_REACHED=1 exit=0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows install orchestration preserves collisions, cleans failures, and passes its control", { skip: process.platform !== "win32", timeout: 600_000 }, () => {
  for (const scenario of ["lock-collision", "stage-collision", "destination-race"]) {
    const probe = runWindowsInstallOrchestration({ scenario });
    try {
      const out = combined(probe.result);
      assert.notEqual(probe.result.status, 0, `${scenario}\n${out}`);
      assert.match(out, /INSTALL_LOCK_DECISION_REACHED=1/);
      if (scenario === "lock-collision") assert.equal(readFileSync(join(probe.lock, "foreign.txt"), "utf8"), "preserve\n");
      if (scenario === "stage-collision") assert.equal(readFileSync(join(probe.stage, "foreign.txt"), "utf8"), "preserve\n");
      if (scenario === "destination-race") assert.deepEqual(readdirSync(probe.prefix), ["foreign.txt"]);
      assert.match(out, /CLEANUP_(?:OWNERSHIP_DECISION_REACHED|STOP_UNOWNED)=1/);
    } finally {
      probe.cleanup();
    }
  }

  const failed = runWindowsInstallOrchestration({ scenario: "install-failure" });
  try {
    assert.notEqual(failed.result.status, 0);
    assert.match(combined(failed.result), /INSTALL_STARTED=1/);
    assert.equal(existsSync(failed.stage), false);
    assert.equal(existsSync(failed.lock), false);
    assert.equal(existsSync(failed.prefix), false);
  } finally {
    failed.cleanup();
  }

  const control = runWindowsInstallOrchestration({ scenario: "success" });
  try {
    assert.equal(control.result.status, 0, combined(control.result));
    assert.match(combined(control.result), /ATOMIC_PROMOTION_DECISION_REACHED=1/);
    assert.match(combined(control.result), /ATOMIC_PROMOTION_VERIFIED=1/);
    assert.equal(existsSync(join(control.prefix, "brain.cmd")), true);
    assert.equal(existsSync(control.stage), false);
    assert.equal(existsSync(control.lock), false);
  } finally {
    control.cleanup();
  }
});

test("Windows ownership mutation targets the cleanup guard with LF and CRLF", () => {
  const lfSource = readFileSync(WINDOWS, "utf8").replaceAll("\r\n", "\n");
  for (const source of [lfSource, lfSource.replaceAll("\n", "\r\n")]) {
    const mutated = mutateWindowsCleanupOwnership(source);
    const normalized = mutated.replaceAll("\r\n", "\n");
    const markerFunction = normalized.slice(
      normalized.indexOf("function Set-InstallAttemptMarker"),
      normalized.indexOf("function Test-InstallAttemptOwnership"),
    );
    const cleanupFunction = normalized.slice(
      normalized.indexOf("function Remove-OwnedInstallDirectory"),
      normalized.indexOf("function Install-Brain"),
    );
    assert.match(markerFunction, /if \(-not \(Test-InstallAttemptOwnership \$Directory \$AttemptId\)\) \{/);
    assert.match(cleanupFunction, /if \(\$false\) \{/);
  }
  assert.throws(
    () => mutateWindowsCleanupOwnership(lfSource.replace("function Remove-OwnedInstallDirectory", "function Removed-InstallDirectory")),
    /Windows ownership mutation target was not found/,
  );
});

test("Windows ownership mutation turns the collision preservation control red", { skip: process.platform !== "win32", timeout: 180_000 }, () => {
  const source = readFileSync(WINDOWS, "utf8");
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-mutant-")));
  const mutant = join(directory, "prep-windows.ps1");
  writeFileSync(mutant, mutateWindowsCleanupOwnership(source));
  const probe = runWindowsInstallOrchestration({ scenario: "lock-collision", script: mutant });
  try {
    assert.throws(() => {
      assert.notEqual(probe.result.status, 0);
      assert.equal(readFileSync(join(probe.lock, "foreign.txt"), "utf8"), "preserve\n");
    }, undefined, "Windows ownership mutation survived");
  } finally {
    probe.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

// These probes reach the shipped real-mode decision; only discovery and the
// Brain download/install dependency are injected. The ready arm must install.
for (const version of ["2.1.261", "2.1.294", "2.2.0", "3.0.0"]) {
  test(`Claude floor accepts ${version} through the real gate`, macInstallOrchestrationOptions(), () => {
    const result = runMacRealProbe({ "claude.version": `${version} (Claude Code)` });
    assert.equal(result.status, 0, combined(result));
    assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/);
    assert.match(result.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/);
    assert.equal(result.stderr, "");
  });
}

test("Claude floor refuses an older native release with one update step", macInstallOrchestrationOptions(), () => {
  const result = runMacRealProbe({ "claude.version": "2.1.260 (Claude Code)" });
  assert.equal(result.status, 2, combined(result));
  assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/);
  assert.doesNotMatch(result.stdout, /PROBE_INSTALL_BRAIN_REACHED/);
  assert.ok(result.stderr.includes(CLAUDE_UPDATE_NEED), result.stderr);
  assert.doesNotMatch(result.stderr, /specific version|support|exactly/);
  const control = runMacRealProbe();
  assert.equal(control.status, 0, combined(control));
  assert.match(control.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/);
});

test("Claude floor missing uses the default native install", macInstallOrchestrationOptions(), () => {
  const result = runMacRealProbe({ "claude.paths": "MISSING", "claude.version": "MISSING" });
  assert.equal(result.status, 2, combined(result));
  assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/);
  assert.doesNotMatch(result.stdout, /PROBE_INSTALL_BRAIN_REACHED/);
  assert.match(result.stderr, /Native Install \(Recommended\).*default command/);
  assert.doesNotMatch(result.stderr, /install-a-specific-version|exactly/);
  const control = runMacRealProbe();
  assert.equal(control.status, 0, combined(control));
  assert.match(control.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/);
});

for (const [label, changes, expected] of [
  ["missing", { "codex.paths": "MISSING", "codex.version": "MISSING" }, /Codex CLI \(optional\): not found/],
  ["older", { "codex.version": "codex-cli 0.1.0" }, /Codex CLI \(optional\): found, version 0\.1\.0/],
  ["newer", { "codex.version": "codex-cli 9.0.0" }, /Codex CLI \(optional\): found, version 9\.0\.0/],
  ["elsewhere", { "codex.paths": "/opt/homebrew/bin/codex" }, /Codex CLI \(optional\): found/],
  ["multiple", { "codex.paths": "/fixture/home/.local/bin/codex\n/usr/local/bin/codex" }, /Codex CLI \(optional\): found/],
  ["unreadable", { "codex.version": "MISSING" }, /Codex CLI \(optional\): found; version unavailable/],
]) {
  test(`Codex optional ${label} passes the real gate and is shown`, macInstallOrchestrationOptions(), () => {
    const result = runMacRealProbe(changes);
    assert.equal(result.status, 0, combined(result));
    assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/);
    assert.match(result.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/);
    assert.match(result.stdout, expected);
    assert.equal(result.stderr, "");
  });
}

test("Claude floor ignores a later unused copy but refuses a conflicting first copy", macInstallOrchestrationOptions(), () => {
  const control = runMacRealProbe({ "claude.paths": "/fixture/home/.local/bin/claude\n/usr/local/bin/claude" });
  assert.equal(control.status, 0, combined(control));
  assert.match(control.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/);
  const refused = runMacRealProbe({ "claude.paths": "/usr/local/bin/claude\n/fixture/home/.local/bin/claude" });
  assert.equal(refused.status, 2, combined(refused));
  assert.match(refused.stdout, /PREREQUISITE_DECISION_REACHED=1/);
  assert.doesNotMatch(refused.stdout, /PROBE_INSTALL_BRAIN_REACHED/);
  assert.ok(refused.stderr.includes(CLAUDE_CONFLICT_HOW), refused.stderr);
  assert.doesNotMatch(refused.stderr, OWNER_JARGON);
});

// Windows executes these same shipped functions in CI. The parser loads the
// definitions without dispatching --real; only discovery, session checking,
// and the Brain install dependency are replaced with synthetic controls.
function runWindowsRealProbe(changes = {}) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-real-probe-")));
  const state = join(directory, "state");
  const home = join(directory, "home");
  const probe = join(directory, "probe.ps1");
  cpSync(join(FIXTURES, "windows-ready"), state, { recursive: true });
  mkdirSync(join(home, "temp"), { recursive: true });
  for (const [name, value] of Object.entries(changes)) writeFileSync(join(state, name), `${value}\n`);
  writeFileSync(probe, `
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($args[0])
. ([scriptblock]::Create($source.Substring(0, $source.IndexOf('$Mode = if'))))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Preparation source syntax failed' }
$functions = @($ast.FindAll({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] }, $false))
foreach ($definition in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$PrepHome = 'C:\\Users\\Fixture'
$LocalRoot = Join-Path $PrepHome 'AppData\\Local'
$BrainPrefix = Join-Path $env:HOME 'absent-brain'
$FixtureDir = ''
function Test-StandardSession { return $true }
function Get-ToolPaths([string]$Name) {
  $value = [IO.File]::ReadAllText((Join-Path $env:PROBE_DIR "$Name.paths")).TrimEnd([char]13, [char]10)
  if ($value -eq 'MISSING') { return @() }
  return @($value -split '\\r?\\n' | Where-Object { $_ } | Select-Object -Unique)
}
function Get-ToolVersion([string]$Name) {
  $value = [IO.File]::ReadAllText((Join-Path $env:PROBE_DIR "$Name.version")).TrimEnd([char]13, [char]10)
  if ($value -eq 'MISSING') { return $null }
  if ($value -eq 'THROW') { throw 'synthetic unreadable metadata' }
  return $value
}
function Install-Brain { Write-Output 'PROBE_INSTALL_BRAIN_REACHED=1' }
Invoke-Real
exit $script:RealExitCode
`);
  try {
    return runWindowsScratch(probe, [WINDOWS], home, {
      extraEnv: { MACHINE_PREP_TEST_MODE: "", PROBE_DIR: state },
      timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("Windows real gate accepts the Claude floor and optional Codex with refusal controls", { skip: process.platform !== "win32", timeout: 300_000 }, () => {
  const cases = [
    ["floor", {}, 0],
    ["newer-patch", { "claude.version": "2.1.294 (Claude Code)" }, 0],
    ["numeric-patch", { "claude.version": "2.1.1000 (Claude Code)" }, 0],
    ["newer-minor", { "claude.version": "2.10.0 (Claude Code)" }, 0],
    ["newer-major", { "claude.version": "3.0.0 (Claude Code)" }, 0],
    ["older", { "claude.version": "2.1.260 (Claude Code)" }, 2, CLAUDE_UPDATE_NEED],
    ["older-minor", { "claude.version": "2.0.999 (Claude Code)" }, 2, CLAUDE_UPDATE_NEED],
    ["missing", { "claude.paths": "MISSING", "claude.version": "MISSING" }, 2, CLAUDE_NEED],
    ["unreadable", { "claude.version": "MISSING" }, 2, CLAUDE_NEED],
    ["prerelease", { "claude.version": "2.1.261-beta.1 (Claude Code)" }, 2, CLAUDE_NEED],
    ["unused-copy", { "claude.paths": "C:\\Users\\Fixture\\.local\\bin\\claude.exe\nC:\\other\\claude.exe" }, 0],
    ["conflict", { "claude.paths": "C:\\other\\claude.exe\nC:\\Users\\Fixture\\.local\\bin\\claude.exe" }, 2, CLAUDE_CONFLICT_NEED],
    ["codex-missing", { "codex.paths": "MISSING", "codex.version": "MISSING" }, 0, "not found"],
    ["codex-old", { "codex.version": "codex-cli 0.1.0" }, 0, "found, version 0.1.0"],
    ["codex-new", { "codex.version": "codex-cli 9.0.0" }, 0, "found, version 9.0.0"],
    ["codex-unknown", { "codex.paths": "C:\\other\\codex.exe", "codex.version": "MISSING" }, 0, "found; version unavailable"],
    ["codex-error", { "codex.version": "THROW" }, 0, "found; version unavailable"],
    ["codex-copies", { "codex.paths": "C:\\other\\codex.exe\nC:\\another\\codex.exe" }, 0, "found"],
  ];
  for (const [name, changes, status, text] of cases) {
    const result = runWindowsRealProbe(changes);
    assert.equal(result.status, status, `${name}\n${combined(result)}`);
    assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/, name);
    assert.match(result.stdout, /Codex CLI \(optional\): /, name);
    if (status === 0) {
      assert.match(result.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/, name);
      assert.equal(result.stderr, "", name);
      if (text) assert.ok(result.stdout.includes(text), name);
    } else {
      assert.doesNotMatch(result.stdout, /PROBE_INSTALL_BRAIN_REACHED/, name);
      assert.ok(result.stderr.includes(text), name);
      assert.doesNotMatch(result.stderr, OWNER_JARGON, name);
      assert.match(result.stderr, /Nothing was downloaded or installed/, name);
    }
  }
});


test("Mac optional status cannot interrupt the required-action block", macInstallOrchestrationOptions(), () => {
  const result = runMacRealProbe(FRESH_MAC, { mergeStreams: true });
  assert.equal(result.status, 2, combined(result));
  assert.match(result.stdout, /PREREQUISITE_DECISION_REACHED=1/);
  assert.doesNotMatch(result.stdout, /PROBE_INSTALL_BRAIN_REACHED/);
  const reopen = result.stdout.indexOf(MAC_REOPEN_LINE);
  const optional = result.stdout.indexOf("Codex CLI (optional):");
  assert.ok(reopen > 0 && optional > reopen, result.stdout);
  const control = runMacRealProbe({}, { mergeStreams: true });
  assert.equal(control.status, 0, combined(control));
  assert.match(control.stdout, /PROBE_INSTALL_BRAIN_REACHED=1/);
  assert.ok(control.stdout.indexOf("Codex CLI (optional):") < control.stdout.indexOf("PROBE_INSTALL_BRAIN_REACHED=1"));
});
