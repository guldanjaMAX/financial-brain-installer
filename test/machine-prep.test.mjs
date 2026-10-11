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
// npm 11.8.0 and 11.9.0 ship this same standard shim. Keep a real vendor
// fixture so a synthetic forwarding shim cannot accidentally be the control.
const STANDARD_NPM_SHIM = readFileSync(join(FIXTURES, 'npm-standard.cmd'), 'utf8');
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
    timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS,
    ...options,
  });
}

function runWindowsInstallOrchestration({ scenario, script = WINDOWS, kitSizeOffset = 0, kitShaOverride = null, diagnostic = null, logBlocked = false }) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-install-")));
  const home = join(directory, "home");
  const local = join(home, "local");
  const temp = join(home, "temp");
  const kit = join(directory, "kit.tgz");
  const npm = join(directory, "npm.cmd");
  const prefix = join(local, "FinancialBrain");
  const lock = `${prefix}.install.lock`;
  const stage = `${prefix}.test-stage`;
  mkdirSync(temp, { recursive: true });
  if (logBlocked) {
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "FinancialBrainMachinePrep"), "synthetic log blocker\n");
  }
  writeFileSync(kit, "synthetic reviewed kit\n");
  const kitBytes = readFileSync(kit);
  const kitSha = createHash("sha256").update(kitBytes).digest("hex");
  writeWindowsNpmFixture(directory, npm, `
    ${scenario === 'install-failure' ? 'process.exit(7);' : ''}
    ${scenario === 'destination-race' ? `mkdirSync(${JSON.stringify(prefix)}, { recursive: true }); writeFileSync(${JSON.stringify(join(prefix, 'foreign.txt'))}, 'foreign');` : ''}
    const target = process.argv[process.argv.indexOf('--prefix') + 1];
    mkdirSync(join(target, 'node_modules', 'brain-installer'), { recursive: true });
    writeFileSync(join(target, 'node_modules', 'brain-installer', 'package.json'), JSON.stringify({ version: '0.4.10' }));
    writeFileSync(join(target, 'brain.cmd'), '@echo off\\r\\n');
  `, diagnostic);
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
    directory, home, temp, prefix, lock, stage, result,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function combined(result) {
  return `${result.stdout || ""}${result.stderr || ""}`.replaceAll("\r\n", "\n");
}

// Only synthetic values go through the real npm failure path. Versions are
// separate calls so diagnostics cannot silently repeat the install.
const NPM_PRIVATE_LINES = [
  "fetch https://registry.invalid/pkg?probe=fixture-query-value#fixture-fragment-value",
  // Built at runtime so no committed line has the credential-URL shape.
  "fetch https://" + ["fixture-user", "fixture-url-value"].join(":") + "@registry.invalid/pkg",
  "npm config _authToken=fixture-auth-value",
  'npm verbose argv "--token" "fixture-argv-value"',
  'Authorization: Bearer fixture-bearer-value',
  'password="fixture-password-value with spaces"',
  '{"access_token":"fixture-json-value"}',
  'npm_fixturebaretokenvalue0123456789',
];
const NPM_PRIVATE_VALUES = ["fixture-query-value", "fixture-fragment-value", "fixture-url-value", "fixture-user",
  "fixture-auth-value", "fixture-argv-value", "fixture-bearer-value", "fixture-password-value", "fixture-json-value", "npm_fixturebaretokenvalue0123456789"];

function writeWindowsNpmFixture(directory, npm, body, diagnostic = null, onInvocation = '') {
  mkdirSync(join(directory, 'node_modules', 'npm', 'bin'), { recursive: true });
  cpSync(process.execPath, join(directory, 'node.exe'));
  writeFileSync(join(directory, 'node_modules', 'npm', 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(npm, STANDARD_NPM_SHIM);
  const reason = { cache: 'npm error code ENOTCACHED', node: "'node' is not recognized as an internal or external command",
    permission: 'npm error code EACCES', unknown: 'npm error unexpected install failure', success: 'npm success control' }[diagnostic];
  const prelude = diagnostic ? `
    appendFileSync(join(process.env.HOME, 'npm-calls.txt'), 'install\\n');
    writeFileSync(join(process.env.HOME, 'npm-cache-path.txt'), process.env.npm_config_cache);
    const logs = join(process.env.npm_config_cache, '_logs'); mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'older.log'), 'older-debug\\n');
    writeFileSync(join(logs, 'newest.log'), ${JSON.stringify(['newest-debug', ...NPM_PRIVATE_LINES].join('\n'))});
    utimesSync(join(logs, 'older.log'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    utimesSync(join(logs, 'newest.log'), new Date('2020-01-02T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));
    console.log(${JSON.stringify([...Array.from({ length: 45 }, (_, i) => `stdout-line-${i + 1}`), ...NPM_PRIVATE_LINES].join('\n'))});
    console.error(${JSON.stringify([...Array.from({ length: 45 }, (_, i) => `stderr-line-${i + 1}`), ...NPM_PRIVATE_LINES, reason].join('\n'))});
  ` : '';
  writeFileSync(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), `
    const { appendFileSync, writeFileSync, mkdirSync, utimesSync, rmSync, symlinkSync } = require('node:fs');
    const { join } = require('node:path');
    ${onInvocation}
    if (process.argv[2] === '--version') { console.log('11.19.0'); process.exit(0); }
    ${prelude}
    ${body}
    process.exit(${diagnostic && diagnostic !== 'success' ? 1 : 0});
  `);
}

function writeNpmDiagnosticFixture(directory, npm, diagnostic) {
  const original = readFileSync(npm, "utf8");
  const reason = {
    cache: "npm error code ENOTCACHED",
    node: "'node' is not recognized as an internal or external command",
    permission: "npm error code EACCES",
    unknown: "npm error unexpected install failure",
    success: "npm success control",
  }[diagnostic];
  assert.ok(reason, "known injected npm scenario");
  const output = [...Array.from({ length: 45 }, (_, i) => `stdout-line-${i + 1}`), ...NPM_PRIVATE_LINES];
  const errors = [...Array.from({ length: 45 }, (_, i) => `stderr-line-${i + 1}`), ...NPM_PRIVATE_LINES, reason];
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const prelude = `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then printf '%s\\n' 11.19.0; exit 0; fi
printf 'install\\n' >> "$HOME/npm-calls.txt"
printf '%s\\n' "$npm_config_cache" > "$HOME/npm-cache-path.txt"
mkdir -p "$npm_config_cache/_logs"
printf 'older-debug\\n' > "$npm_config_cache/_logs/older.log"
touch -t 202001010000 "$npm_config_cache/_logs/older.log"
printf '%s\\n' ${["newest-debug", ...NPM_PRIVATE_LINES].map(quote).join(" ")} > "$npm_config_cache/_logs/newest.log"
touch -t 202001020000 "$npm_config_cache/_logs/newest.log"
printf '%s\\n' ${output.map(quote).join(" ")}
printf '%s\\n' ${errors.map(quote).join(" ")} >&2
`;
  const script = `${prelude}${original}\nexit ${diagnostic === "success" ? 0 : 1}\n`;
  writeFileSync(npm, script);
  writeFileSync(join(directory, "npm"), script, { mode: 0o755 });
  writeFileSync(join(directory, "node"), "#!/bin/sh\nprintf 'v24.13.1\\n'\n", { mode: 0o755 });
}

function assertNpmDiagnostics(probe, diagnostic, platform = "mac") {
  assert.equal(readFileSync(join(probe.home, "npm-calls.txt"), "utf8").trim(), "install", "real isolated npm called exactly once");
  const out = combined(probe.result);
  assert.match(out, /INSTALL_STARTED=1/);
  const logDir = platform === "windows" ? join(probe.home, "local", "FinancialBrainMachinePrep")
    : join(probe.home, ".local", "state", "financial-brain-machine-prep");
  const logPath = join(logDir, "prep.log");
  const cachePath = readFileSync(join(probe.home, "npm-cache-path.txt"), "utf8").trim();
  assert.equal(existsSync(cachePath), false, "npm cache is cleaned after evidence retention");
  assert.equal(existsSync(probe.stage), false);
  assert.equal(existsSync(probe.lock), false);
  if (diagnostic === "success") {
    assert.equal(probe.result.status, 0, "successful fake reaches publication");
    assert.match(out, /BRAIN_INSTALL_VERIFIED=1/);
    assert.equal(existsSync(logPath), false, "success does not create a failure receipt");
    assert.equal(existsSync(join(logDir, "npm-debug.log")), false);
  } else {
    assert.notEqual(probe.result.status, 0);
    assert.equal(existsSync(probe.prefix), false);
    assert.ok(existsSync(logPath), "npm failure must leave prep.log");
    const log = readFileSync(logPath, "utf8");
    const debugName = log.match(/npm_debug_log=saved file=(npm-debug-[a-zA-Z0-9_-]+\.log)/)?.[1];
    assert.ok(debugName, 'unique debug filename recorded');
    if (platform === "mac") {
      assert.equal(lstatSync(logPath).mode & 0o777, 0o600);
      assert.equal(lstatSync(join(logDir, debugName)).mode & 0o777, 0o600);
    }
    assert.match(log, /npm_exit_code=1/);
    if (platform === 'windows') {
      assert.ok(log.includes(`npm_selected=${join(probe.directory, 'npm.cmd')}`));
      assert.ok(log.includes(`npm_entry_point=${join(probe.directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')}`));
    } else {
      assert.match(log, /npm_selected=.*npm-fixture/);
    }
    assert.match(log, /npm_path=.*npm/);
    assert.match(log, /node_path=.*node/);
    assert.match(log, platform === 'windows' ? new RegExp(`node_version=${process.version.replaceAll('.', '\\.')}\\b`) : /node_version=v24\.13\.1/);
    assert.match(log, /npm_version=11\.19\.0/);
    // There are 53 stdout and 54 stderr lines. Tail exactly 40 of each.
    assert.equal((log.match(/^stdout: /gm) || []).length, 40);
    assert.equal((log.match(/^stderr: /gm) || []).length, 40);
    assert.match(log, /stdout: stdout-line-14\b/);
    assert.doesNotMatch(log, /stdout-line-13\b/);
    assert.match(log, /stderr: stderr-line-15\b/);
    assert.doesNotMatch(log, /stderr-line-14\b/);
    const debug = readFileSync(join(logDir, debugName), "utf8");
    assert.match(debug, /newest-debug/);
    assert.doesNotMatch(debug, /older-debug/);
    assert.match(log, /npm_debug_log=saved/);
    const category = { cache: /a package was not in the offline cache/, node: /npm could not find Node\.js/,
      permission: /network or permission error/, unknown: /unclassified npm error/ }[diagnostic];
    assert.match(out, category);
    assert.ok(out.includes(logPath), "owner gets the actual prep log path");
    assert.match(log, /\[REDACTED\]/);
    for (const value of NPM_PRIVATE_VALUES) {
      assert.equal(`${out}${log}${debug}`.includes(value), false, "synthetic private value escaped diagnostics");
    }
  }
}

test("Mac npm diagnostics retain redacted failure evidence and preserve a success control", macInstallOrchestrationOptions(), () => {
  for (const diagnostic of ["cache", "node", "permission", "unknown", "success"]) {
    const probe = runMacInstallOrchestration({ scenario: "success", diagnostic });
    try { assertNpmDiagnostics(probe, diagnostic); } finally { probe.cleanup(); }
  }
});

test("Windows npm diagnostics retain redacted failure evidence and preserve a success control", { skip: process.platform !== "win32" }, () => {
  for (const diagnostic of ["cache", "node", "permission", "unknown", "success"]) {
    const probe = runWindowsInstallOrchestration({ scenario: "success", diagnostic });
    try { assertNpmDiagnostics(probe, diagnostic, "windows"); } finally { probe.cleanup(); }
  }
});

for (const platform of ["mac", "windows"]) {
  test(`${platform} npm diagnostics tolerate missing debug logs and cannot prevent failed-install cleanup`, {
    skip: platform === "mac" ? process.platform !== "darwin" : process.platform !== "win32",
  }, () => {
    const run = platform === "mac" ? runMacInstallOrchestration : runWindowsInstallOrchestration;
    const missing = run({ scenario: "install-failure" });
    try {
      const logDir = platform === "mac" ? join(missing.home, ".local", "state", "financial-brain-machine-prep")
        : join(missing.home, "local", "FinancialBrainMachinePrep");
      assert.notEqual(missing.result.status, 0);
      assert.match(combined(missing.result), /INSTALL_STARTED=1/);
      const log = readFileSync(join(logDir, "prep.log"), "utf8");
      assert.match(log, /npm_exit_code=7/);
      assert.match(log, /npm_debug_log=unavailable/);
      assert.equal(existsSync(join(logDir, "npm-debug.log")), false);
      assert.equal(existsSync(missing.prefix), false);
      assert.equal(existsSync(missing.stage), false);
      assert.equal(existsSync(missing.lock), false);
    } finally { missing.cleanup(); }
    const blocked = run({ scenario: "success", diagnostic: "cache", logBlocked: true });
    try {
      assert.equal(readFileSync(join(blocked.home, "npm-calls.txt"), "utf8").trim(), "install");
      assert.notEqual(blocked.result.status, 0);
      assert.match(combined(blocked.result), /could not save all npm diagnostics/);
      assert.match(combined(blocked.result), /a package was not in the offline cache/);
      assert.equal(existsSync(blocked.prefix), false);
      assert.equal(existsSync(blocked.stage), false);
      assert.equal(existsSync(blocked.lock), false);
      assert.equal(existsSync(readFileSync(join(blocked.home, "npm-cache-path.txt"), "utf8").trim()), false);
    } finally { blocked.cleanup(); }
    const control = run({ scenario: "success", diagnostic: "success" });
    try { assertNpmDiagnostics(control, "success", platform); } finally { control.cleanup(); }
  });
}

test("Mac npm diagnostics mutations are caught at each capture, privacy, retention and category guard", macInstallOrchestrationOptions(), (context) => {
  const source = readFileSync(MAC, "utf8");
  context.diagnostic(`copied_source_sha256=${createHash("sha256").update(source).digest("hex")}`);
  const mutations = [
    ['exit capture', '|| npm_exit=$?', '|| npm_exit=0', 'cache'],
    ['failure guard', 'if [ "$npm_exit" -ne 0 ]; then', 'if [ "$npm_exit" -eq 0 ]; then', 'cache'],
    ['stdout capture', '> "$temp/npm-stdout" 2>', '> /dev/null 2>', 'cache'],
    ['stderr capture', '2> "$temp/npm-stderr" ||', '2> /dev/null ||', 'cache'],
    ['failure logging', 'if ! record_npm_failure;', 'if ! true;', 'cache'],
    ['exit receipt', 'log_event "npm_exit_code=$npm_exit"', 'log_event "npm_exit_code=0"', 'cache'],
    ['tail bound', 'tail -n 40', 'tail -n 41', 'cache'],
    ['tail redaction', '| redact_npm_output |', '| /bin/cat |', 'cache'],
    ['URL userinfo redaction', 'gsub(/\\/\\/[^\\/[:space:]]*@/', 'gsub(/never-userinfo/', 'cache'],
    ['URL query redaction', 'gsub(/[?#][^[:space:]"<>]*/', 'gsub(/never-query/', 'cache'],
    ['secret line redaction', 'line = "[REDACTED]"', 'line = line', 'cache'],
    ['newest debug selection', '$s[9] > $mtime', '$s[9] < $mtime', 'cache'],
    ['debug redaction', '2>/dev/null | redact_npm_output', '2>/dev/null | /bin/cat', 'cache'],
    ['debug retention', 'safe_npm_io unique "$LOG_DIR"', 'safe_npm_io unique "$temp"', 'cache'],
    ['isolated environment summary', 'run_isolated_npm /bin/sh -c', '/usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c', 'cache'],
    ['node category', 'node.*(not recognized|not found|no such file)|cannot find.*node', 'never-node-error', 'node'],
    ['cache category', "'ENOTCACHED'", "'NEVERCACHED'", 'cache'],
    ['permission category', 'EACCES|EPERM|EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|network|permission', 'never-permission-error', 'permission'],
    ['owner log path', '"$reason" "$LOG_FILE" >&2', '"$reason" "missing-log" >&2', 'cache'],
  ];
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-npm-mutants-")));
  try {
    // The same full assertion is green on unmodified source before any mutant.
    const control = runMacInstallOrchestration({ scenario: "success", diagnostic: "cache" });
    try { assertNpmDiagnostics(control, "cache"); } finally { control.cleanup(); }
    for (const [name, from, to, diagnostic] of mutations) {
      assert.ok(source.includes(from), `mutation target reached: ${name}`);
      const script = join(directory, "prep-mutant.sh");
      writeFileSync(script, source.replace(from, to));
      const probe = runMacInstallOrchestration({ scenario: "success", diagnostic, script });
      try {
        assert.match(combined(probe.result), /INSTALL_STARTED=1/, `${name}: real install reached`);
        assert.equal(readFileSync(join(probe.home, "npm-calls.txt"), "utf8").trim(), "install");
        assert.throws(() => assertNpmDiagnostics(probe, diagnostic), undefined, `${name} mutation survived`);
      } finally { probe.cleanup(); }
    }
    context.diagnostic(`npm_diagnostics_mutations_killed=${mutations.length}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function assertWindowsNpmDiagnosticContract(source) {
  const wait = functionBody(source, 'function Wait-RedirectedProcess(', '\n}\n');
  assert.match(wait, /return \[pscustomobject\]@\{ ExitCode = \[int\]\$Process.ExitCode; Output = \$stdoutTask.Result; Errors = \$stderrTask.Result \}/);
  const invoke = functionBody(source, 'function Invoke-IsolatedNpm(', '\n}\n');
  assert.match(invoke, /\$result = Wait-RedirectedProcess \$process\s+}\s+if \(\$result.ExitCode -ne 0\) \{\s+try \{ Write-NpmFailure \$result \$info \$Npm \$Temp \$runtime \} catch/);
  assert.match(invoke, /Show-NpmFailure \$result/);
  assert.match(invoke, /return \[int\]\$result.ExitCode/);
  const writer = functionBody(source, 'function Write-NpmFailure(', '\n}\n');
  for (const line of [
    'Write-Log "npm_exit_code=$($Result.ExitCode)"',
    "@{ Name = 'stdout'; Text = $Result.Output }", "@{ Name = 'stderr'; Text = $Result.Errors }",
    'Select-Object -Last 40', '$safe = Protect-NpmOutput $line',
    '[MachinePrepLogIO]::Append($LogDir, "$($stream.Name): $safe`r`n")',
    '[MachinePrepLogIO]::ReadNewest($Temp)',
    '$safe = Protect-NpmOutput $debug',
    "[MachinePrepLogIO]::WriteNew($LogDir, $safe)",
    "Write-Log 'npm_debug_log=unavailable'", 'Write-Log (Protect-NpmOutput "npm_selected=$Npm")',
    "Name = 'npm_path'; File = $where; Arguments = 'npm.cmd'", "Name = 'node_path'; File = $where; Arguments = 'node.exe'",
    "Name = 'node_version'; File = $installExecutable; Arguments = '--version'", "Name = 'npm_version'; File = $installExecutable; Arguments = ((ConvertTo-NativeArgument $npmCli)",
    '$child = [Diagnostics.Process]::Start($Info)', 'Write-Log (Protect-NpmOutput "$($probe.Name)=$value")',
    '$Info.Arguments = $installArguments',
  ]) assert.ok(writer.includes(line), `Windows diagnostics contract: ${line}`);
  assert.ok(writer.indexOf('[MachinePrepLogIO]::ReadNewest') < writer.indexOf('foreach ($probe'), 'debug retained before version probes');
  const redact = functionBody(source, 'function Protect-NpmOutput(', '\n}\n');
  for (const line of [
    "-replace '//[^/\\s]*@', '//[REDACTED]@'", "-replace '[?#][^\\s\"<>]*', '[REDACTED]'",
    "auth|token|password|passwd|secret|credential|bearer|api[ _-]?key|npm_[a-z0-9]{16,}|gh[pousr]_[a-z0-9]+|github_pat_|eyj[a-z0-9_-]+\\.",
    "$safe = '[REDACTED]'",
  ]) assert.ok(redact.includes(line), 'Windows redaction contract');
  const show = functionBody(source, 'function Show-NpmFailure(', '\n}\n');
  for (const message of show.matchAll(/\[Console\]::Error.WriteLine\(([^\n]+)\)/g)) {
    assert.ok(message[1].includes('this log: $LogFile'), 'each failure category carries the log path');
  }
  for (const line of [
    'node.*(not recognized|not found|no such file)|cannot find.*node', "-match 'ENOTCACHED'",
    'EACCES|EPERM|EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|network|permission',
    'npm could not find Node.js', 'a package was not in the offline cache', 'a network or permission error',
    'an unclassified npm error', 'this log: $LogFile',
  ]) assert.ok(show.includes(line), 'Windows owner category contract');
}

test("Windows npm diagnostics static contracts detect a mutation at every guarded line", (context) => {
  const source = readFileSync(WINDOWS, "utf8").replaceAll("\r\n", "\n");
  assertWindowsNpmDiagnosticContract(source);
  const targets = [
    'return [pscustomobject]@{ ExitCode = [int]$Process.ExitCode;',
    '$result.ExitCode -ne 0', 'Write-NpmFailure $result $info $Npm $Temp $runtime', 'Show-NpmFailure $result', 'return [int]$result.ExitCode',
    'Write-Log "npm_exit_code=$($Result.ExitCode)"', "Name = 'stdout'; Text = $Result.Output", "Name = 'stderr'; Text = $Result.Errors",
    'Select-Object -Last 40', '$safe = Protect-NpmOutput $line', '[MachinePrepLogIO]::Append($LogDir, "$($stream.Name): $safe`r`n")',
    '[MachinePrepLogIO]::ReadNewest($Temp)', 'Protect-NpmOutput $debug',
    "[MachinePrepLogIO]::WriteNew($LogDir, $safe)", "Write-Log 'npm_debug_log=unavailable'",
    'Write-Log (Protect-NpmOutput "npm_selected=$Npm")',
    "Name = 'npm_path'; File = $where; Arguments = 'npm.cmd'", "Name = 'node_path'; File = $where; Arguments = 'node.exe'", "Name = 'node_version'; File = $installExecutable; Arguments = '--version'", "Name = 'npm_version'; File = $installExecutable; Arguments = ((ConvertTo-NativeArgument $npmCli)",
    '[Diagnostics.Process]::Start($Info)', 'Write-Log (Protect-NpmOutput "$($probe.Name)=$value")', '$Info.Arguments = $installArguments',
    "-replace '//[^/\\s]*@', '//[REDACTED]@'", "-replace '[?#][^\\s\"<>]*', '[REDACTED]'", "$safe = '[REDACTED]'",
    'auth|token|password', 'node.*(not recognized|not found|no such file)|cannot find.*node', "-match 'ENOTCACHED'",
    'EACCES|EPERM|EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|network|permission',
    'npm could not find Node.js', 'a package was not in the offline cache', 'a network or permission error', 'an unclassified npm error', 'this log: $LogFile',
  ];
  for (const target of targets) {
    assert.ok(source.includes(target), 'Windows mutation decision reached');
    assert.throws(() => assertWindowsNpmDiagnosticContract(source.replace(target, 'MUTATED')), undefined, `mutation survived: ${target}`);
  }
  context.diagnostic(`windows_static_diagnostics_mutations_killed=${targets.length}`);
});

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

function runMacInstallOrchestration({ scenario, script = MAC, kitSizeOffset = 0, kitShaOverride = null, diagnostic = null, logBlocked = false, evidenceCase = null }) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-install-test-")));
  const home = join(directory, "home");
  const kit = join(directory, "kit.tgz");
  const npm = join(directory, "npm-fixture");
  const stage = join(home, ".financial-brain.test-stage");
  const lock = join(home, ".financial-brain.install.lock");
  const prefix = join(home, ".financial-brain");
  mkdirSync(home, { recursive: true });
  if (logBlocked) {
    mkdirSync(join(home, ".local", "state"), { recursive: true });
    writeFileSync(join(home, ".local", "state", "financial-brain-machine-prep"), "synthetic log blocker\n");
  }
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
printf '%s\\n' '{' '  "version": "0.4.10"' '}' > "$prefix/lib/node_modules/brain-installer/package.json"
printf '%s\\n' '#!/usr/bin/env node' > "$prefix/lib/node_modules/brain-installer/brain.mjs"
ln -s ../lib/node_modules/brain-installer/brain.mjs "$prefix/bin/brain"
`);
  chmodSync(npm, 0o755);
  if (diagnostic) writeNpmDiagnosticFixture(directory, npm, diagnostic);
  if (evidenceCase) {
    const foreign = join(directory, 'foreign');
    const logDir = join(home, '.local', 'state', 'financial-brain-machine-prep');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'foreign.log'), 'foreign-preservation-marker\n', { mode: 0o644 });
    mkdirSync(logDir, { recursive: true });
    if (evidenceCase === 'destination-link') symlinkSync(join(foreign, 'foreign.log'), join(logDir, 'npm-debug.log'));
    if (evidenceCase === 'destination-existing') writeFileSync(join(logDir, 'npm-debug.log'), 'existing-debug-marker\n');
    if (evidenceCase === 'log-dir-link') {
      rmSync(logDir, { recursive: true });
      symlinkSync(foreign, logDir);
    }
    if (evidenceCase === 'log-parent-link') {
      rmSync(join(home, '.local', 'state'), { recursive: true });
      mkdirSync(join(foreign, 'financial-brain-machine-prep'));
      symlinkSync(foreign, join(home, '.local', 'state'));
    }
    const injections = {
      'hardlink': 'rm "$npm_config_cache/_logs/"*.log; ln "$HOME/../foreign/foreign.log" "$npm_config_cache/_logs/newest.log"',
      'nonregular': 'rm "$npm_config_cache/_logs/"*.log; mkfifo "$npm_config_cache/_logs/newest.log"',
      'logs-link': 'rm -rf "$npm_config_cache/_logs"; ln -s "$HOME/../foreign" "$npm_config_cache/_logs"',
      'cache-link': 'rm -rf "$npm_config_cache"; mkdir -p "$HOME/../foreign/_logs"; cp "$HOME/../foreign/foreign.log" "$HOME/../foreign/_logs/foreign.log"; ln -s "$HOME/../foreign" "$npm_config_cache"',
      'leaf-link': 'rm "$npm_config_cache/_logs/"*.log; ln -s "$HOME/../foreign/foreign.log" "$npm_config_cache/_logs/newest.log"',
    };
    if (injections[evidenceCase]) writeFileSync(npm, readFileSync(npm, 'utf8').replace("printf '%s\\n' 'stdout-line-1'", `${injections[evidenceCase]}\nprintf '%s\\n' 'stdout-line-1'`));
  }
  const temp = join(directory, "temp");
  mkdirSync(temp);

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
      TMPDIR: process.env.TMPDIR || temp,
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
    temp,
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
    writeFileSync(join(prefix, "lib", "node_modules", "brain-installer", "package.json"), '{\n  "version": "0.4.10"\n}\n');
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
    for (const mutant of ["0.4.100", "0.4.10-modified"]) {
      writeFileSync(join(directory, "brain.version"), `${mutant}\n`);
      const result = runMac(["--check"], directory);
      assert.equal(result.status, 1, combined(result));
      assert.match(combined(result), /WRONG_VERSION\s+Financial Brain CLI/);
      assert.match(combined(result), /CHECKS_REACHED=10/);
    }
    writeFileSync(join(directory, "brain.version"), "0.4.10\n");
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

test("Windows Claude version reads the canonical copy's metadata and runs nothing", () => {
  const source = readFileSync(WINDOWS, "utf8").replaceAll("\r\n", "\n");
  const version = functionBody(source, "function Get-ToolVersion(", "\n}\n");
  const claude = version.slice(0, version.indexOf('\n  if ($FixtureDir) {\n    $value = Read-Fixture "$Name.version"'));
  assert.match(claude, /if \(\$Name -eq "claude"\)/, "Claude branch reached");
  assert.match(claude, /VersionInfo\.ProductVersion/, "production metadata decision reached");
  assert.match(claude, /Read-Fixture "claude\.product-version"/);
  const canonicalGuard = claude.indexOf("[StringComparison]::OrdinalIgnoreCase");
  assert.ok(canonicalGuard >= 0 && canonicalGuard < claude.indexOf("VersionInfo.ProductVersion"), "only the canonical copy is read");
  // Four-part X.Y.Z.0 (seen in the field as 2.1.295.0) and three-part X.Y.Z are the only accepted shapes.
  assert.ok(claude.includes(String.raw`$fileVersion -cmatch '\A([0-9]+\.[0-9]+\.[0-9]+)(?:\.0)?\z'`));
  // Nothing is executed to read the version: no process, no call operator, no --version,
  // and the branch ends in its own refusal instead of falling through to the generic probe.
  assert.doesNotMatch(claude, /Diagnostics\.Process|Start-Process|Start-Job|Invoke-Command|Invoke-Expression|cmd(\.exe)?\b|powershell|pwsh|--version|Invoke-ClaudeVersion|& |\. \$/i);
  assert.match(claude, /\n    return \$null\n  \}$/, "the Claude branch ends in its own refusal");
  assert.doesNotMatch(source, /function Invoke-ClaudeVersion/);
});

test("Windows Claude metadata fixtures reach the real readiness decisions", { skip: process.platform !== "win32" }, () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-claude-version-")));
  const state = join(directory, "state");
  const home = join(directory, "home");
  const probe = join(directory, "probe.ps1");
  mkdirSync(join(home, "temp"), { recursive: true });
  cpSync(join(FIXTURES, "windows-ready"), state, { recursive: true });
  const cases = [
    { name: "metadata", product: "2.1.295", state: "READY" },
    { name: "metadata-zero-revision", product: "2.1.295.0", state: "READY" },
    { name: "metadata-old", product: "2.1.260", state: "WRONG_VERSION" },
    { name: "metadata-old-zero-revision", product: "2.1.260.0", state: "WRONG_VERSION" },
    ...["", "garbage", "2.1.295.1", "2.1.295-beta", "2.1.295 ", " 2.1.295", "2.1", "2.1.295.0.0", "2.1.295 (Claude Code)"].map((product, index) => ({
      name: `unreadable-${index}`, product, state: "MISSING",
    })),
    { name: "shadowed", product: "2.1.295.0", paths: "C:\\other\\claude.exe\nC:\\Users\\Fixture\\.local\\bin\\claude.exe", state: "SHADOWED" },
    { name: "unused-copy", product: "2.1.295.0", paths: "C:\\Users\\Fixture\\.local\\bin\\claude.exe\nC:\\other\\claude.exe", state: "READY" },
  ];
  writeFileSync(probe, `param([string]$Source, [string]$State)
$ErrorActionPreference = 'Stop'
$sourceText = [IO.File]::ReadAllText($Source)
. ([scriptblock]::Create($sourceText.Substring(0, $sourceText.IndexOf('switch ($Mode)'))))
$FixtureDir = $State
$PrepHome = 'C:\\Users\\Fixture'
$LocalRoot = Join-Path $PrepHome 'AppData\\Local'
$BrainPrefix = Join-Path $LocalRoot 'FinancialBrain'
$cases = @'
${JSON.stringify(cases)}
'@ | ConvertFrom-Json
foreach ($case in $cases) {
  $paths = if ($case.PSObject.Properties['paths']) { $case.paths } else { 'C:\\Users\\Fixture\\.local\\bin\\claude.exe' }
  [IO.File]::WriteAllText((Join-Path $State 'claude.paths'), $paths)
  [IO.File]::WriteAllText((Join-Path $State 'claude.product-version'), $case.product)
  $rows = @(Invoke-Checks)
  if (@($rows | Where-Object { $_ -match 'Claude Code' }).Count -ne 1) { throw 'Claude decision not reached' }
  if ($script:ClaudeState -cne $case.state) { throw ('wrong version decision: ' + $case.name) }
  if ($case.state -ceq 'READY') {
    if ($script:CheckFailures -ne 0 -or $script:OwnerSteps.Count -ne 0) { throw 'green control failed' }
    if (($rows -join '\n') -notmatch '2.1.295 \\(Claude Code\\)') { throw 'version not normalized' }
  } else {
    if ($script:CheckFailures -ne 1 -or $script:OwnerSteps.Count -ne 1) { throw 'refusal not reached' }
    if ($case.state -ceq 'MISSING' -and $script:OwnerSteps[0] -notmatch 'a copy was found, but its version could not be read') { throw 'wrong unreadable owner step' }
  }
  Write-Output ('CLAUDE_VERSION_ARM_VERIFIED=' + $case.name)
}
`);
  try {
    const result = runWindowsScratch(probe, [WINDOWS, state], home, { timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS });
    assert.equal(result.status, 0, combined(result));
    assert.equal(result.stdout.match(/^CLAUDE_VERSION_ARM_VERIFIED=/gm)?.length, cases.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows Claude version is read from a real executable's metadata without running it", { skip: process.platform !== "win32", timeout: 150_000 }, () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-claude-native-")));
  const home = join(directory, "home");
  const probe = join(directory, "probe.ps1");
  mkdirSync(join(home, "temp"), { recursive: true });
  // product: the ProductVersion stamped into the synthetic claude.exe; null = no file at all.
  const arms = [
    { name: "four-part", product: "2.1.295.0", expected: "2.1.295 (Claude Code)" },
    { name: "three-part", product: "2.1.295", expected: "2.1.295 (Claude Code)" },
    { name: "nonzero-revision", product: "2.1.295.1", expected: null },
    { name: "unavailable", product: "unavailable", expected: null },
    { name: "missing-file", product: null, expected: null },
  ];
  writeFileSync(probe, `param([string]$Source, [string]$Root)
$ErrorActionPreference = 'Stop'
$sourceText = [IO.File]::ReadAllText($Source)
. ([scriptblock]::Create($sourceText.Substring(0, $sourceText.IndexOf('switch ($Mode)'))))
$FixtureDir = ''
function Get-ToolPaths([string]$Name) { return @(Join-Path $PrepHome '.local\\bin\\claude.exe') }
$arms = @'
${JSON.stringify(arms)}
'@ | ConvertFrom-Json
$index = 0
foreach ($arm in $arms) {
  $index++
  $PrepHome = Join-Path $Root $arm.name
  $canonical = Join-Path $PrepHome '.local\\bin\\claude.exe'
  $bin = Split-Path -Parent $canonical
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $started = Join-Path $bin 'started'
  if ($null -ne $arm.product) {
    Add-Type -OutputAssembly $canonical -OutputType ConsoleApplication -TypeDefinition (@'
using System;
using System.IO;
[assembly: System.Reflection.AssemblyInformationalVersion("PRODUCT")]
public static class SyntheticClaudeINDEX {
  public static int Main(string[] args) {
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "started"), "ran");
    Console.WriteLine("2.1.295 (Claude Code)");
    return 0;
  }
}
'@).Replace('PRODUCT', $arm.product).Replace('INDEX', [string]$index)
    # The decision must see the stamped metadata, or the arm proves nothing.
    if ((Get-Item -LiteralPath $canonical).VersionInfo.ProductVersion -cne $arm.product) { throw ('synthetic metadata not stamped: ' + $arm.name) }
  } elseif (Test-Path -LiteralPath $canonical) { throw 'missing-file arm has a file' }
  $version = Get-ToolVersion 'claude'
  if (Test-Path -LiteralPath $started) { throw ('claude.exe was executed: ' + $arm.name) }
  if ($null -eq $arm.expected) {
    if ($null -ne $version) { throw ('unreadable metadata accepted: ' + $arm.name) }
  } elseif ($version -cne $arm.expected) { throw ('metadata not accepted: ' + $arm.name) }
  Write-Output ('CLAUDE_NATIVE_ARM_VERIFIED=' + $arm.name)
}
`);
  try {
    const result = runWindowsScratch(probe, [WINDOWS, directory], home, { timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS });
    assert.equal(result.status, 0, combined(result));
    assert.equal(result.stdout.match(/^CLAUDE_NATIVE_ARM_VERIFIED=/gm)?.length, arms.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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
    writeFileSync(join(prefix, "node_modules", "brain-installer", "package.json"), '{"version":"0.4.10"}\n');
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

const NATIVE_NPM_ARGUMENTS = "$info.Arguments = (@($npmCli, 'install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', $Prefix, $Archive) |";

// Exercise the production shim grammar on hosts without PowerShell. The native
// test below separately proves parsing, file checks, process gating and logs.
function standardShimRecognizer(source) {
  const body = functionBody(source, 'function Test-StandardNpmShim(', '\n}\n');
  const block = body.match(/\$patterns = @\(([\s\S]*?)\n  \)/);
  assert.ok(block, 'production standard-shim grammar reached');
  const patterns = [...block[1].matchAll(/^\s*'([^']+)'[,]?$/gm)].map(match => new RegExp(match[1], 'i'));
  assert.ok(patterns.length > 10, 'whole shim grammar, not a target substring');
  const comment = body.match(/\$_ -notmatch '([^']+)'/);
  assert.ok(comment, 'production comment filter reached');
  const ignore = new RegExp(comment[1], 'i');
  return (shim) => {
    const lines = shim.split(/\r?\n/).map(line => line.trim()).filter(line => line && !ignore.test(line));
    return lines.length === patterns.length && lines.every((line, i) => patterns[i].test(line));
  };
}

test('Windows standard npm layout rejects forwarding shims and accepts vendor structure', () => {
  const source = readFileSync(WINDOWS, 'utf8').replaceAll('\r\n', '\n');
  const accepts = standardShimRecognizer(source);
  assert.equal(accepts(STANDARD_NPM_SHIM), true);
  assert.equal(accepts(STANDARD_NPM_SHIM.toLowerCase().replaceAll('\r\n', '\n').replaceAll('\n', '\n  ') + '\nREM fixture comment\n'), true);
  for (const shim of [
    '@echo off\n"C:\\other npm\\node.exe" "C:\\other npm\\npm-cli.js" %*\n',
    STANDARD_NPM_SHIM.replace('%~dp0\\node_modules\\npm\\bin\\npm-cli.js', 'C:\\other npm\\npm-cli.js'),
    STANDARD_NPM_SHIM + '\ncall "C:\\other npm\\npm.cmd" %*\n',
    STANDARD_NPM_SHIM.replace('SETLOCAL', 'SETLOCAL & call other.cmd'),
    STANDARD_NPM_SHIM.replace('"%NODE_EXE%" "%NPM_CLI_JS%" %*', '"%NODE_EXE%" "elsewhere.js" %*'),
    STANDARD_NPM_SHIM + '\nREM comment & call elsewhere.cmd\n',
    STANDARD_NPM_SHIM.replace('SETLOCAL', 'REM comment ^\nSETLOCAL'),
  ]) assert.equal(accepts(shim), false, 'forwarding or modified shim refused');
  const resolveRuntime = functionBody(source, 'function Resolve-StandardNpmRuntime(', '\n}\n');
  assert.match(resolveRuntime, /Test-StandardNpmShim/);
  assert.match(resolveRuntime, /ReparsePoint/);
  const invoke = functionBody(source, 'function Invoke-IsolatedNpm(', '\n}\n');
  assert.match(invoke, /if \(-not \$runtime.Supported\)/);
  assert.ok(invoke.indexOf('if (-not $runtime.Supported)') < invoke.indexOf('[Diagnostics.Process]::Start'));
  const writer = functionBody(source, 'function Write-NpmFailure(', '\n}\n');
  assert.ok(writer.includes('npm_entry_point=$npmCli'));
  assert.ok(writer.includes('if (-not $Runtime.Supported) { return }'), 'no guessed version probe on refusal');
});

function assertWindowsNpmLayoutContract(source) {
  const shim = functionBody(source, 'function Test-StandardNpmShim(', '\n}\n');
  const resolver = functionBody(source, 'function Resolve-StandardNpmRuntime(', '\n}\n');
  const invoke = functionBody(source, 'function Invoke-IsolatedNpm(', '\n}\n');
  const writer = functionBody(source, 'function Write-NpmFailure(', '\n}\n');
  const targets = [];
  for (const [body, lines] of [
    [shim, ["$_ -notmatch '^(::|REM(?:\\s|$))[^&|<>^%!\\x00-\\x1f]*$'",
      'if ($lines.Count -ne $patterns.Count) { return $false }', 'if ($lines[$i] -notmatch $patterns[$i]) { return $false }']],
    [resolver, [
      "Node = Join-Path $directory 'node.exe'", "NpmCli = Join-Path $directory 'node_modules\\npm\\bin\\npm-cli.js'",
      "if ([IO.Path]::GetFileName($Npm) -ine 'npm.cmd') { return $runtime }",
      'foreach ($path in @($Npm, $runtime.Node, $runtime.NpmCli))',
      '$item = Get-Item -LiteralPath $path -Force -ErrorAction Stop',
      'if ($item -isnot [IO.FileInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $runtime }',
      'if (-not (Test-StandardNpmShim ([IO.File]::ReadAllText($Npm)))) { return $runtime }',
      'Supported = $false', '$runtime.Supported = $true', '} catch { return $runtime }',
    ]],
    [invoke, ['$runtime = Resolve-StandardNpmRuntime $Npm', '$node = $runtime.Node', '$npmCli = $runtime.NpmCli',
      "[Console]::Out.WriteLine('NPM_LAYOUT_DECISION_REACHED=1')", 'if (-not $runtime.Supported)',
      "Errors = 'unsupported npm layout'", 'Write-NpmFailure $result $info $Npm $Temp $runtime']],
    [writer, [
      'Write-Log (Protect-NpmOutput "npm_candidate_node=$($Runtime.Node)")',
      'Write-Log (Protect-NpmOutput "npm_candidate_entry_point=$($Runtime.NpmCli)")',
      "$npmCli = if ($Runtime.Supported) { $Runtime.NpmCli } else { 'unavailable' }",
      'Write-Log (Protect-NpmOutput "npm_entry_point=$npmCli")', 'if (-not $Runtime.Supported) { return }',
    ]],
  ]) for (const line of lines) {
    assert.ok(body.includes(line), `layout contract: ${line}`);
    targets.push(line);
  }
  assert.ok(invoke.indexOf('if (-not $runtime.Supported)') < invoke.indexOf('[Diagnostics.Process]::Start'));
  assert.ok(writer.indexOf('if (-not $Runtime.Supported) { return }') < writer.indexOf('[Diagnostics.Process]::Start'));
  return targets;
}

test('Windows standard npm layout kills each guarded-line mutation', (context) => {
  const source = readFileSync(WINDOWS, 'utf8').replaceAll('\r\n', '\n');
  const targets = assertWindowsNpmLayoutContract(source);
  for (const target of targets) {
    assert.throws(() => assertWindowsNpmLayoutContract(source.replace(target, 'MUTATED')), undefined, `layout mutation survived: ${target}`);
  }
  const accepts = standardShimRecognizer(source);
  assert.equal(accepts(STANDARD_NPM_SHIM), true);
  const grammar = functionBody(source, 'function Test-StandardNpmShim(', '\n}\n').match(/\$patterns = @\(([\s\S]*?)\n  \)/)[1];
  const patterns = [...grammar.matchAll(/^\s*'([^']+)'[,]?$/gm)].map(match => match[1]);
  for (const pattern of new Set(patterns)) {
    const changed = source.replace(`'${pattern}'`, "'^MUTATED$'");
    assert.equal(standardShimRecognizer(changed)(STANDARD_NPM_SHIM), false, 'vendor control kills grammar mutation');
  }
  context.diagnostic(`npm_layout_static_mutations_killed=${targets.length + new Set(patterns).size}`);
});

test('Windows standard npm layout refuses a forwarding shim before install or diagnostics execute it', { skip: process.platform !== 'win32', timeout: 300_000 }, (context) => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-npm-layout-')));
  const home = join(directory, 'home'); const temp = join(home, 'temp');
  const bin = join(directory, 'node js %USERNAME%'); const npm = join(bin, 'npm.cmd');
  const marker = join(temp, 'entry-calls.txt');
  mkdirSync(temp, { recursive: true });
  writeWindowsNpmFixture(bin, npm, '', null, "appendFileSync(join(process.env.TEMP, 'entry-calls.txt'), process.argv[2] + '\\n');");
  writeFileSync(npm, STANDARD_NPM_SHIM);
  const source = readFileSync(WINDOWS, 'utf8').replaceAll('\r\n', '\n');
  context.diagnostic(`copied_source_sha256=${createHash('sha256').update(readFileSync(WINDOWS)).digest('hex')}`);
  try {
    const run = script => runWindowsScratch(script, ['--test-isolated-npm', npm, join(directory, 'prefix'), join(directory, 'kit.tgz'), temp], home);
    const control = run(WINDOWS);
    assert.equal(control.status, 0, combined(control));
    assert.match(combined(control), /NPM_LAYOUT_DECISION_REACHED=1/);
    assert.equal(readFileSync(marker, 'utf8'), 'install\n');
    rmSync(marker);
    // Keep the adjacent runtime intact; change only the selected shim's target.
    writeFileSync(npm, '@echo off\r\n"%~dp0\\other-node.exe" "%~dp0\\other-cli.js" %*\r\n');
    const assertRefused = result => {
      assert.notEqual(result.status, 0, combined(result));
      assert.match(combined(result), /NPM_LAYOUT_DECISION_REACHED=1/);
      assert.match(combined(result), /needs the standard Node.js install/);
      assert.match(combined(result), /REDIRECTED_PROCESS_DECISION_REACHED=1 exit=1/);
      assert.equal(existsSync(marker), false, 'neither install nor npm version probe ran');
    };
    assertRefused(run(WINDOWS));
    const log = readFileSync(join(home, 'local', 'FinancialBrainMachinePrep', 'prep.log'), 'utf8');
    assert.ok(log.includes(`npm_selected=${npm}`));
    assert.ok(log.includes(`npm_candidate_entry_point=${join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')}`));
    assert.match(log, /npm_entry_point=unavailable/);
    assert.doesNotMatch(log, /(?:node|npm)_version=/);
    const mutant = join(directory, 'mutant.ps1');
    const guard = 'if (-not (Test-StandardNpmShim ([IO.File]::ReadAllText($Npm)))) { return $runtime }';
    assert.ok(source.includes(guard), 'shim-validation mutation decision reached');
    writeFileSync(mutant, source.replace(guard, 'if ($false) { return $runtime }'));
    const broken = run(mutant);
    assert.equal(broken.status, 0, combined(broken));
    assert.equal(readFileSync(marker, 'utf8'), 'install\n');
    assert.throws(() => assertRefused(broken), undefined, 'shim-validation mutant killed');
    context.diagnostic('npm_layout_runtime_mutations_killed=1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const scenario of ['missing-node', 'missing-cli', 'directory-cli', 'linked-cli', 'linked-shim', 'renamed-shim', 'appended-forwarder']) {
  test(`Windows standard npm layout refuses unsupported files: ${scenario}`, { skip: process.platform !== 'win32', timeout: 300_000 }, () => {
    const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-npm-files-')));
    const home = join(directory, 'home'); const temp = join(home, 'temp');
    const bin = join(directory, 'node js'); let npm = join(bin, 'npm.cmd');
    const cli = join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const marker = join(temp, 'entry-calls.txt');
    mkdirSync(temp, { recursive: true });
    writeWindowsNpmFixture(bin, npm, '', null, "appendFileSync(join(process.env.TEMP, 'entry-calls.txt'), process.argv[2] + '\\n');");
    try {
      const run = () => runWindowsScratch(WINDOWS, ['--test-isolated-npm', npm, join(directory, 'prefix'), join(directory, 'kit.tgz'), temp], home);
      const control = run();
      assert.equal(control.status, 0, combined(control));
      assert.equal(readFileSync(marker, 'utf8'), 'install\n');
      rmSync(marker);
      if (scenario === 'missing-node') rmSync(join(bin, 'node.exe'));
      if (scenario === 'missing-cli') rmSync(cli);
      if (scenario === 'directory-cli') { rmSync(cli); mkdirSync(cli); }
      if (scenario === 'linked-cli' || scenario === 'linked-shim') {
        const leaf = scenario === 'linked-cli' ? cli : npm;
        const other = join(directory, scenario === 'linked-cli' ? 'other-cli.js' : 'other.cmd');
        cpSync(leaf, other); rmSync(leaf); symlinkSync(other, leaf, 'file');
        assert.equal(lstatSync(leaf).isSymbolicLink(), true, 'link fixture exists at the decision path');
      }
      if (scenario === 'renamed-shim') { npm = join(bin, 'custom.cmd'); cpSync(join(bin, 'npm.cmd'), npm); }
      if (scenario === 'appended-forwarder') writeFileSync(npm, STANDARD_NPM_SHIM + '\ncall elsewhere.cmd %*\n');
      const refused = run();
      assert.notEqual(refused.status, 0, combined(refused));
      assert.match(combined(refused), /NPM_LAYOUT_DECISION_REACHED=1/);
      assert.match(combined(refused), /needs the standard Node.js install/);
      assert.match(combined(refused), /REDIRECTED_PROCESS_DECISION_REACHED=1 exit=1/);
      assert.equal(existsSync(marker), false);
      const log = readFileSync(join(home, 'local', 'FinancialBrainMachinePrep', 'prep.log'), 'utf8');
      assert.ok(log.includes(`npm_selected=${npm}`));
      assert.match(log, /npm_entry_point=unavailable/);
      assert.doesNotMatch(log, /(?:node|npm)_version=/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

function assertWindowsNpmQuoting(source) {
  const invoke = functionBody(source, 'function Invoke-IsolatedNpm(', '\n}\n');
  assert.ok(invoke.includes(NATIVE_NPM_ARGUMENTS));
  assert.ok(invoke.includes("ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '"));
  assert.match(invoke, /\$info.FileName = \$node/);
  assert.doesNotMatch(invoke, /\/s \/c/);
  const quote = functionBody(source, 'function ConvertTo-NativeArgument(', '\n}\n');
  assert.match(quote, /\[regex\]::Replace\(\[regex\]::Replace/);
  assert.ok(quote.includes("'$1$1'"), 'trailing backslashes doubled before the closing quote');
}

test('Windows direct npm argv contract kills shell and unquoted argument mutations', (context) => {
  const source = readFileSync(WINDOWS, 'utf8').replaceAll('\r\n', '\n');
  assertWindowsNpmQuoting(source);
  const mutations = [
    ['$info.FileName = $node', '$info.FileName = $cmd'],
    ['ConvertTo-NativeArgument $_', '$_'],
    ["'$1$1'", "'$1'"],
    ["'--prefix', $Prefix, $Archive", "'--prefix', $Archive, $Prefix"],
  ];
  for (const [from, to] of mutations) {
    assert.ok(source.includes(from));
    assert.throws(() => assertWindowsNpmQuoting(source.replace(from, to)));
  }
  context.diagnostic(`npm_quoting_static_mutations_killed=${mutations.length}`);
});

function legacyWindowsNpmCommand(npm, prefix, archive) {
  // The field defect put an extra pair around an already quoted npm path.
  // A valid cmd wrapper may succeed with spaces or metacharacters; it is not
  // a reproduction of that defect. Preserve all the isolated install flags.
  return `/d /s /c """${npm}"" install --global --offline --ignore-scripts --no-audit --no-fund --prefix "${prefix}" "${archive}""`;
}

test('Windows legacy quoting probe reproduces the actual extra pair and complete install argv', (context) => {
  const command = legacyWindowsNpmCommand('C:\\node js\\npm.cmd', 'C:\\stage dir\\', 'C:\\kit dir\\kit.tgz');
  const assertReproduction = value => assert.equal(value,
    String.raw`/d /s /c """C:\node js\npm.cmd"" install --global --offline --ignore-scripts --no-audit --no-fund --prefix "C:\stage dir\" "C:\kit dir\kit.tgz""`);
  assertReproduction(command);
  for (const fragment of ['"""', 'npm.cmd""', '--offline']) {
    assert.ok(command.includes(fragment), 'legacy mutation reaches its target');
    assert.throws(() => assertReproduction(command.replace(fragment, 'MUTATED')));
  }
  context.diagnostic('legacy_quoting_probe_mutations_killed=3');
});

for (const label of ['node js', 'literal-%USERNAME%-%SystemRoot%', 'amp&caret^(paren)!', 'non-ascii-\u00e9']) {
  test(`Windows direct npm preserves argv: ${label}`, { skip: process.platform !== 'win32', timeout: 300_000 }, (context) => {
    const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-npm-quoting-')));
    const home = join(directory, 'home'); const temp = join(home, 'temp');
    // The historical defect requires a space; every arm retains that trigger
    // as well as its distinct character case.
    const bin = join(directory, 'node js', label); const npm = join(bin, 'npm.cmd');
    const prefix = join(directory, label, 'prefix') + '\\';
    const archive = join(directory, label, 'kit.tgz');
    mkdirSync(temp, { recursive: true });
    writeWindowsNpmFixture(bin, npm, "writeFileSync(join(process.env.TEMP, 'argv.json'), JSON.stringify(process.argv.slice(2)));" );
    const source = readFileSync(WINDOWS, 'utf8').replaceAll('\r\n', '\n');
    context.diagnostic(`copied_source_sha256=${createHash('sha256').update(readFileSync(WINDOWS)).digest('hex')}`);
    try {
      const run = (script) => runWindowsScratch(script, ['--test-isolated-npm', npm, prefix, archive, temp], home);
      const control = run(WINDOWS);
      assert.ifError(control.error);
      assert.equal(control.signal, null);
      assert.equal(control.status, 0, combined(control));
      assert.match(combined(control), /REDIRECTED_PROCESS_DECISION_REACHED=1 exit=0/);
      assert.deepEqual(JSON.parse(readFileSync(join(temp, 'argv.json'), 'utf8')), ['install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, archive]);
      rmSync(join(temp, 'argv.json'));
      const mutant = join(directory, 'mutant.ps1');
      // Restore the previous shell construction, retaining its real decision path.
      const old = source.replace('$info.FileName = $node', '$info.FileName = $cmd')
        .replace(NATIVE_NPM_ARGUMENTS + "\n    ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '",
          // Keep paths in PowerShell variables so its legacy script encoding
          // cannot corrupt non-ASCII fixture paths and cause a false refusal.
          "$info.Arguments = '" + legacyWindowsNpmCommand('{0}', '{1}', '{2}') + "' -f $Npm, $Prefix, $Archive");
      assert.notEqual(old, source); writeFileSync(mutant, old);
      const broken = run(mutant);
      assert.ifError(broken.error);
      assert.equal(broken.signal, null, 'a timeout cannot kill the quoting mutant');
      assert.match(combined(broken), /NPM_ENVIRONMENT_ISOLATED=1/);
      assert.match(combined(broken), /NPM_LAYOUT_DECISION_REACHED=1/);
      assert.match(combined(broken), /REDIRECTED_PROCESS_DECISION_REACHED=1 exit=[1-9][0-9]*/);
      assert.notEqual(broken.status, 0);
      assert.equal(existsSync(join(temp, 'argv.json')), false);
      if (label.startsWith('literal-')) {
        const shellShim = join(bin, 'shell-fixture.cmd');
        writeFileSync(shellShim, '@echo off\r\necho reached>"%TEMP%\\shell-reached.txt"\r\nexit /b 0\r\n');
        const shellTemplate = (path) => '$info.Arguments = "/d /s /c `"`"' + path + '`" install`""';
        const nativeTemplate = NATIVE_NPM_ARGUMENTS + "\n    ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '";
        const shellSource = source.replace('$info.FileName = $node', '$info.FileName = $cmd');
        // A normal shim path proves the shell and fixture can succeed.
        const plainShim = join(temp, 'control.cmd'); cpSync(shellShim, plainShim);
        writeFileSync(mutant, shellSource.replace(nativeTemplate, shellTemplate(plainShim)));
        const shellControl = run(mutant);
        assert.ifError(shellControl.error);
        assert.equal(shellControl.signal, null);
        assert.equal(shellControl.status, 0, combined(shellControl));
        assert.equal(readFileSync(join(temp, 'shell-reached.txt'), 'utf8').trim(), 'reached');
        rmSync(join(temp, 'shell-reached.txt'));
        writeFileSync(mutant, shellSource.replace(nativeTemplate, shellTemplate(shellShim)));
        const expanded = run(mutant);
        assert.ifError(expanded.error);
        assert.equal(expanded.signal, null);
        assert.notEqual(expanded.status, 0);
        assert.match(combined(expanded), /REDIRECTED_PROCESS_DECISION_REACHED=1/);
        assert.equal(existsSync(join(temp, 'shell-reached.txt')), false);
      }
      context.diagnostic('native_argv_shell_mutation_killed=1');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("Windows isolated npm drains output larger than pipe capacity without deadlock", { skip: process.platform !== "win32", timeout: 150_000 }, () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-pipes-")));
  const home = join(directory, "home");
  const temp = join(home, "temp");
  const npm = join(directory, "npm.cmd");
  mkdirSync(temp, { recursive: true });
  writeWindowsNpmFixture(directory, npm, "for (let i = 0; i < 20000; i++) { console.error('stderr-' + i); console.log('stdout-' + i); }");
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


function assertSafeEvidence(probe, scenario) {
  assert.match(combined(probe.result), /INSTALL_STARTED=1/);
  assert.equal(readFileSync(join(probe.home, 'npm-calls.txt'), 'utf8').trim(), 'install');
  assert.notEqual(probe.result.status, 0);
  const foreign = join(probe.directory, 'foreign', 'foreign.log');
  assert.equal(readFileSync(foreign, 'utf8'), 'foreign-preservation-marker\n');
  assert.equal(lstatSync(foreign).mode & 0o777, 0o644, 'foreign permissions preserved');
  const logDir = join(probe.home, '.local', 'state', 'financial-brain-machine-prep');
  const files = readdirSync(logDir).filter(name => /^npm-debug.*\.log$/.test(name) && !lstatSync(join(logDir, name)).isSymbolicLink());
  if (['logs-link', 'cache-link', 'leaf-link', 'hardlink', 'nonregular'].includes(scenario)) {
    assert.match(readFileSync(join(logDir, 'prep.log'), 'utf8'), /npm_debug_log=unavailable/);
    assert.equal(files.length, 0, 'no file outside the attempt may become evidence');
  } else if (scenario === 'log-parent-link') {
    assert.deepEqual(readdirSync(logDir), []);
    assert.match(combined(probe.result), /could not save all npm diagnostics/);
  } else if (scenario === 'log-dir-link') {
    assert.match(combined(probe.result), /could not save all npm diagnostics/);
    assert.deepEqual(readdirSync(logDir), ['foreign.log']);
  } else {
    const retained = files.filter(name => name !== 'npm-debug.log');
    assert.equal(retained.length, 1, 'fresh unique debug evidence created');
    assert.match(readFileSync(join(logDir, retained[0]), 'utf8'), /newest-debug/);
    if (scenario === 'destination-existing') assert.equal(readFileSync(join(logDir, 'npm-debug.log'), 'utf8'), 'existing-debug-marker\n');
  }
  assert.equal(existsSync(probe.stage), false);
  assert.equal(existsSync(probe.lock), false);
}

for (const scenario of ['logs-link', 'cache-link', 'leaf-link', 'hardlink', 'nonregular', 'destination-link', 'destination-existing', 'log-dir-link', 'log-parent-link', 'regular']) {
  test(`Mac npm evidence boundary: ${scenario}`, macInstallOrchestrationOptions(), () => {
    const probe = runMacInstallOrchestration({ scenario: 'success', diagnostic: 'cache', evidenceCase: scenario });
    try { assertSafeEvidence(probe, scenario); } finally { probe.cleanup(); }
  });
}

test('Windows npm uses direct Node execution for literal percent paths, including version probes', () => {
  const source = readFileSync(WINDOWS, 'utf8').replaceAll('\r\n', '\n');
  const invoke = functionBody(source, 'function Invoke-IsolatedNpm(', '\n}\n');
  const writer = functionBody(source, 'function Write-NpmFailure(', '\n}\n');
  assert.match(invoke, /\$info.FileName = \$node/);
  assert.match(invoke, /Resolve-StandardNpmRuntime \$Npm/);
  assert.match(functionBody(source, 'function Resolve-StandardNpmRuntime(', '\n}\n'), /node_modules\\npm\\bin\\npm-cli\.js/);
  assert.doesNotMatch(invoke + writer, /\/s \/c|Command = \('call/);
});


test('Mac evidence mutations expose parent links, leaf links, and destination overwrite', macInstallOrchestrationOptions(), (context) => {
  const source = readFileSync(MAC, 'utf8');
  context.diagnostic(`copied_source_sha256=${createHash('sha256').update(source).digest('hex')}`);
  const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-evidence-mutants-')));
  const mutations = [
    ['parent nofollow', 'O_RDONLY | O_DIRECTORY | O_NOFOLLOW', 'O_RDONLY | O_DIRECTORY', 'logs-link'],
    ['cache nofollow', 'O_RDONLY | O_DIRECTORY | O_NOFOLLOW', 'O_RDONLY | O_DIRECTORY', 'cache-link'],
    ['leaf nofollow', 'O_RDONLY | O_NONBLOCK | O_NOFOLLOW', 'O_RDONLY | O_NONBLOCK', 'leaf-link'],
    ['exclusive destination', '($out, $name) = tempfile("npm-debug-XXXXXXXX", SUFFIX => ".log", DIR => ".", UNLINK => 0);',
      '$name = "npm-debug.log"; open($out, ">", $name) or die "open failed";', 'destination-link'],
  ];
  try {
    for (const [name, from, to, scenario] of mutations) {
      const control = runMacInstallOrchestration({ scenario: 'success', diagnostic: 'cache', evidenceCase: scenario });
      try { assertSafeEvidence(control, scenario); } finally { control.cleanup(); }
      assert.ok(source.includes(from), name);
      const script = join(directory, 'mutant.sh'); writeFileSync(script, source.replace(from, to));
      const probe = runMacInstallOrchestration({ scenario: 'success', diagnostic: 'cache', evidenceCase: scenario, script });
      try {
        assert.match(combined(probe.result), /INSTALL_STARTED=1/);
        assert.equal(readFileSync(join(probe.home, 'npm-calls.txt'), 'utf8').trim(), 'install');
        assert.throws(() => assertSafeEvidence(probe, scenario), undefined, `${name} mutation survived`);
      } finally { probe.cleanup(); }
    }
    context.diagnostic(`evidence_runtime_mutations_killed=${mutations.length}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function assertEvidenceIOContract(source, platform) {
  const lines = platform === 'mac' ? [
    'O_RDONLY | O_DIRECTORY | O_NOFOLLOW', 'chdir($dir)', '$root[4] == $<',
    '"$root[0]:$root[1]" eq $identity', 'enter_dir("npm-cache", 0)', 'enter_dir("_logs", 0)',
    'O_RDONLY | O_NONBLOCK | O_NOFOLLOW', 'S_ISREG($s[2]) && $s[3] == 1 && $s[4] == $<',
    'tempfile("npm-debug-XXXXXXXX", SUFFIX => ".log", DIR => ".", UNLINK => 0)',
    'chmod(0600, $out)',
  ] : [
    'directory ? 3u : 1u', '0x00200000u | (directory ? 0x02000000u : 0u)',
    '(i.Attributes & 0x400) != 0', '((i.Attributes & 0x10) != 0) != directory',
    'GetFileType(h) != 1 || i.Links != 1',
    'held.Add(Open(current, true, false))',
    'owner && !Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Equals(WindowsIdentity.GetCurrent().User)',
    'new Directories(Path.Combine(attempt, "npm-cache", "_logs"), false, false)',
    'new FileStream(Open(name, false, false), FileAccess.Read)',
    'new Directories(directory, true, true)',
    'Guid.NewGuid().ToString("N")', 'FileMode.CreateNew, FileAccess.Write, FileShare.None',
    'if (newest == null || time > stamp)',
    'using (var writer = new StreamWriter(file)) { writer.Write(text); }',
    '[MachinePrepLogIO]::WriteNew($LogDir, $safe)',
  ];
  for (const line of lines) assert.ok(source.includes(line), `evidence I/O guard: ${line}`);
  return lines;
}

for (const [platform, path] of [['mac', MAC], ['windows', WINDOWS]]) {
  test(`${platform} evidence I/O contract kills each guard mutation`, (context) => {
    const source = readFileSync(path, 'utf8');
    const lines = assertEvidenceIOContract(source, platform);
    for (const line of lines) assert.throws(() => assertEvidenceIOContract(source.replaceAll(line, 'MUTATED'), platform));
    context.diagnostic(`evidence_static_mutations_killed=${lines.length}`);
  });
}


function windowsLogCreation(source, kind) {
  const start = kind === 'directory' ? 'var security = new DirectorySecurity();' : 'var security = new FileSecurity();';
  const end = kind === 'directory' ? 'Directory.CreateDirectory(current, security);' : 'FileOptions.None, security)) { }';
  const offset = source.indexOf(start);
  assert.notEqual(offset, -1, `${kind} security descriptor reached`);
  const finish = source.indexOf(end, offset);
  assert.ok(finish > offset, `${kind} creation with the descriptor reached`);
  return source.slice(offset, finish + end.length);
}

function assertWindowsLogAccess(source, kind) {
  const block = windowsLogCreation(source, kind);
  assert.match(block, /security\.SetOwner\(WindowsIdentity\.GetCurrent\(\)\.User\)/);
  const inheritance = kind === 'directory'
    ? String.raw`InheritanceFlags\.ContainerInherit \| InheritanceFlags\.ObjectInherit,\s*PropagationFlags\.None,\s*` : '';
  assert.match(block, new RegExp(String.raw`security\.AddAccessRule\(new FileSystemAccessRule\(WindowsIdentity\.GetCurrent\(\)\.User,\s*FileSystemRights\.FullControl,\s*${inheritance}AccessControlType\.Allow\)\)`),
    `${kind} owner needs an explicit grant; setting ownership alone leaves an empty DACL`);
  assert.match(block, /security\.SetAccessRuleProtection\(true, false\)/);
}

for (const kind of ['directory', 'file']) {
  test(`Windows diagnostic ACL grants the owner access before creating a ${kind}`, () => {
    assertWindowsLogAccess(readFileSync(WINDOWS, 'utf8'), kind);
  });

  test(`Windows diagnostic ACL ${kind} mutations cannot remove owner access`, (context) => {
    const source = readFileSync(WINDOWS, 'utf8');
    assertWindowsLogAccess(source, kind);
    const block = windowsLogCreation(source, kind);
    const targets = ['security.SetOwner(WindowsIdentity.GetCurrent().User)',
      'security.SetAccessRuleProtection(true, false)', 'security.AddAccessRule',
      'FileSystemRights.FullControl', 'AccessControlType.Allow'];
    if (kind === 'directory') targets.push('InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit', 'PropagationFlags.None');
    for (const target of targets) {
      assert.ok(block.includes(target), 'mutation reaches the actual creation descriptor');
      const mutant = source.replace(block, block.replace(target, 'MUTATED'));
      assert.throws(() => assertWindowsLogAccess(mutant, kind), undefined, `${kind}: mutation survived`);
    }
    context.diagnostic(`log_acl_static_mutations_killed=${targets.length}`);
  });
}

function assertWindowsLogCleanup(local) {
  // PowerShell may create LOCALAPPDATA/Microsoft during startup. Only the
  // directories created/renamed by the production I/O probe belong to it.
  const remaining = readdirSync(local).filter(name => /^FinancialBrainMachinePrep(?:-|$)/i.test(name));
  assert.deepEqual(remaining, [], 'cleanup completed inside the running child');
}

test('Windows log cleanup probe permits a host cache but rejects either remaining log directory', (context) => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-cleanup-probe-')));
  try {
    assertWindowsLogCleanup(directory);
    mkdirSync(join(directory, 'Microsoft'));
    assertWindowsLogCleanup(directory);
    for (const name of ['FinancialBrainMachinePrep', 'FinancialBrainMachinePrep-moved']) {
      mkdirSync(join(directory, name));
      assert.throws(() => assertWindowsLogCleanup(directory), undefined, 'remaining owned directory must fail');
      rmSync(join(directory, name), { recursive: true });
    }
    assertWindowsLogCleanup(directory);
    context.diagnostic('log_cleanup_probe_mutations_killed=2');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows diagnostic ACL permits repeated I/O and immediate cleanup while PowerShell is still running',
  { skip: process.platform !== 'win32', timeout: 300_000 }, (context) => {
    const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-log-access-')));
    const home = join(directory, 'home');
    mkdirSync(join(home, 'temp'), { recursive: true });
    const wrapper = join(directory, 'probe.ps1');
    const source = readFileSync(WINDOWS, 'utf8').replaceAll('\r\n', '\n');
    context.diagnostic(`copied_source_sha256=${createHash('sha256').update(readFileSync(WINDOWS)).digest('hex')}`);
    writeFileSync(wrapper, `
      $ErrorActionPreference = 'Stop'
      ${functionBody(source, 'function Initialize-NpmLogIO', '\n# Windows PowerShell 5.1')}
      Initialize-NpmLogIO
      $directory = Join-Path $env:LOCALAPPDATA 'FinancialBrainMachinePrep'
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
      function Assert-OwnerAccess([string]$Path, [bool]$Inherited) {
        $acl = Get-Acl -LiteralPath $Path
        # Default file ownership can be the Administrators group on hosted CI;
        # directories and prep.log explicitly bind their owner even there.
        if (-not $Inherited -and -not $acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($user)) { throw 'Owner mismatch' }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 1 -or -not $rules[0].IdentityReference.Equals($user) -or
            $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or
            $rules[0].IsInherited -ne $Inherited) { throw 'Owner access rule mismatch' }
      }
      # WriteNew exercises directory creation independently of prep.log creation.
      Write-Output 'LOG_DIRECTORY_CREATE_REACHED=1'
      $first = [MachinePrepLogIO]::WriteNew($directory, 'first-debug')
      Assert-OwnerAccess $directory $false
      Assert-OwnerAccess (Join-Path $directory $first) $true
      Write-Output 'LOG_FILE_CREATE_REACHED=1'
      [MachinePrepLogIO]::Append($directory, 'first-line;')
      [MachinePrepLogIO]::Append($directory, 'second-line')
      Assert-OwnerAccess (Join-Path $directory 'prep.log') $false
      $second = [MachinePrepLogIO]::WriteNew($directory, 'second-debug')
      if ($first -eq $second) { throw 'Debug file overwritten' }
      if ([IO.File]::ReadAllText((Join-Path $directory 'prep.log')) -ne 'first-line;second-line') { throw 'Append failed' }
      if ([IO.File]::ReadAllText((Join-Path $directory $first)) -ne 'first-debug') { throw 'First debug file changed' }
      if ([IO.File]::ReadAllText((Join-Path $directory $second)) -ne 'second-debug') { throw 'Second debug file missing' }
      if ([IO.Directory]::GetFiles($directory).Length -ne 3) { throw 'Unexpected file count' }
      # No GC, sleep, ACL repair or process exit may be needed to release handles.
      [IO.Directory]::Move($directory, ($directory + '-moved'))
      [IO.Directory]::Delete(($directory + '-moved'), $true)
      Write-Output 'LOG_OWNER_IO_AND_CLEANUP=1'
    `);
    try {
      const result = runWindowsScratch(wrapper, [], home, { timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS });
      assert.ifError(result.error);
      assert.equal(result.signal, null, 'PowerShell exited without being killed');
      assert.equal(result.status, 0, combined(result));
      assert.match(combined(result), /LOG_DIRECTORY_CREATE_REACHED=1/);
      assert.match(combined(result), /LOG_FILE_CREATE_REACHED=1/);
      assert.match(combined(result), /LOG_OWNER_IO_AND_CLEANUP=1/);
      assertWindowsLogCleanup(join(home, 'local'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

function windowsEvidenceWrapper(logDir, script) {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  // Hosted Windows CI can be elevated. Bind the synthetic log directory to
  // its current user, matching the ordinary per-user installer.
  return `
      $ErrorActionPreference = 'Stop'
      $dir = ${quote(logDir)}
      $security = [Security.AccessControl.DirectorySecurity]::new()
      $security.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
      $security.SetAccessRuleProtection($true, $false)
      $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
      [IO.Directory]::CreateDirectory($dir, $security) | Out-Null
      & ${quote(script)} @args
      exit $LASTEXITCODE
    `;
}

test('Windows evidence wrapper probe propagates the child exit code immediately', (context) => {
  const wrapper = windowsEvidenceWrapper('C:\\fixture\\logs', 'C:\\fixture\\prep.ps1');
  const assertPropagation = value => assert.match(value, /& 'C:\\fixture\\prep\.ps1' @args\s+exit \$LASTEXITCODE\s*$/);
  assertPropagation(wrapper);
  for (const replacement of ['', 'exit 0']) {
    assert.throws(() => assertPropagation(wrapper.replace('exit $LASTEXITCODE', replacement)));
  }
  context.diagnostic('evidence_wrapper_static_mutations_killed=2');
});

test('Windows evidence wrapper preserves child failure and success with a lost-exit mutation',
  { skip: process.platform !== 'win32', timeout: 420_000 }, (context) => {
    const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-wrapper-exit-')));
    const home = join(directory, 'home');
    mkdirSync(join(home, 'temp'), { recursive: true });
    const child = join(directory, 'child.ps1');
    const wrapper = join(directory, 'wrapper.ps1');
    writeFileSync(child, "Write-Output ('CHILD_EXIT_DECISION_REACHED=' + $args[0])\nexit ([int]$args[0])\n");
    const source = windowsEvidenceWrapper(join(home, 'local', 'FinancialBrainMachinePrep'), child);
    writeFileSync(wrapper, source);
    const assertExit = (result, code) => {
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.match(combined(result), new RegExp(`CHILD_EXIT_DECISION_REACHED=${code}`));
      assert.equal(result.status, code, combined(result));
    };
    try {
      for (const code of [0, 1]) assertExit(runWindowsScratch(wrapper, [String(code)], home), code);
      writeFileSync(wrapper, source.replace('exit $LASTEXITCODE', ''));
      const broken = runWindowsScratch(wrapper, ['1'], home);
      assert.ifError(broken.error);
      assert.equal(broken.signal, null);
      assert.match(combined(broken), /CHILD_EXIT_DECISION_REACHED=1/);
      assert.equal(broken.status, 0, 'the old wrapper hides a completed child failure');
      assert.throws(() => assertExit(broken, 1));
      context.diagnostic('evidence_wrapper_runtime_mutations_killed=1');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

for (const scenario of ['logs-link', 'cache-link', 'leaf-link', 'destination-link', 'destination-existing', 'log-dir-link', 'regular']) {
  test(`Windows npm evidence boundary: ${scenario}`, { skip: process.platform !== 'win32', timeout: 300_000 }, () => {
    const directory = realpathSync.native(mkdtempSync(join(ROOT, '.machine-prep-win-evidence-')));
    const home = join(directory, 'home'); const temp = join(home, 'temp');
    const npm = join(directory, 'npm.cmd'); const foreign = join(directory, 'foreign');
    const logDir = join(home, 'local', 'FinancialBrainMachinePrep');
    mkdirSync(temp, { recursive: true }); mkdirSync(foreign);
    writeFileSync(join(foreign, 'foreign.log'), 'foreign-preservation-marker\n');
    writeWindowsNpmFixture(directory, npm, `
      const foreign = ${JSON.stringify(foreign)}; const logDir = ${JSON.stringify(logDir)};
      const scenario = ${JSON.stringify(scenario)};
      if (scenario === 'logs-link') { rmSync(logs, { recursive: true }); symlinkSync(foreign, logs, 'junction'); }
      if (scenario === 'cache-link') {
        rmSync(process.env.npm_config_cache, { recursive: true });
        mkdirSync(join(foreign, '_logs')); writeFileSync(join(foreign, '_logs', 'foreign.log'), 'foreign-preservation-marker');
        symlinkSync(foreign, process.env.npm_config_cache, 'junction');
      }
      if (scenario === 'leaf-link') {
        rmSync(logs, { recursive: true }); mkdirSync(logs); symlinkSync(join(foreign, 'foreign.log'), join(logs, 'newest.log'), 'file');
      }
      if (scenario === 'destination-link') symlinkSync(join(foreign, 'foreign.log'), join(logDir, 'npm-debug.log'), 'file');
      if (scenario === 'destination-existing') writeFileSync(join(logDir, 'npm-debug.log'), 'existing-debug-marker');
      if (scenario === 'log-dir-link') { rmSync(logDir, { recursive: true }); symlinkSync(foreign, logDir, 'junction'); }
    `, 'cache');
    const wrapper = join(directory, 'probe.ps1');
    writeFileSync(wrapper, windowsEvidenceWrapper(logDir, WINDOWS));
    try {
      const result = runWindowsScratch(wrapper, ['--test-isolated-npm', npm, join(directory, 'prefix'), join(directory, 'kit.tgz'), temp], home);
      assert.ifError(result.error);
      assert.equal(result.signal, null, 'evidence checks require a normally exited child');
      assert.equal(result.status, 1, combined(result));
      assert.match(combined(result), /NPM_LAYOUT_DECISION_REACHED=1/);
      assert.match(combined(result), /REDIRECTED_PROCESS_DECISION_REACHED=1 exit=1/);
      assert.equal(readFileSync(join(home, 'npm-calls.txt'), 'utf8').trim(), 'install');
      assert.equal(readFileSync(join(foreign, 'foreign.log'), 'utf8'), 'foreign-preservation-marker\n');
      const saved = readdirSync(logDir).filter(name => /^npm-debug-.*\.log$/.test(name));
      if (scenario.endsWith('s-link') || scenario === 'cache-link' || scenario === 'leaf-link') {
        assert.equal(saved.length, 0);
        assert.match(readFileSync(join(logDir, 'prep.log'), 'utf8'), /npm_debug_log=unavailable/);
      } else if (scenario === 'log-dir-link') {
        assert.deepEqual(readdirSync(logDir), ['foreign.log']);
        assert.match(combined(result), /could not save all npm diagnostics/);
      } else {
        assert.equal(saved.length, 1);
        assert.match(readFileSync(join(logDir, saved[0]), 'utf8'), /newest-debug/);
        if (scenario === 'destination-existing') assert.equal(readFileSync(join(logDir, 'npm-debug.log'), 'utf8'), 'existing-debug-marker');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
