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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

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
  const home = mkdtempSync(join(ROOT, ".machine-prep-test-home-"));
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
  return spawnSync(windowsPowerShell(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS, ...args,
  ], {
    cwd: ROOT,
    env: {
      ...cleanEnv(join(FIXTURES, fixture)),
      MACHINE_PREP_HOME: "C:\\Users\\Fixture",
    },
    encoding: "utf8",
  });
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-windows-install-"));
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-install-test-"));
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
  assert.match(out, /WRONG_VERSION  Codex CLI/);
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
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-checksum-"));
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
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-checksum-"));
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
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-prefix-"));
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
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-installed-brain-"));
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-fixture-"));
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

test("Mac real mode refuses fixtures before any action", macRuntimeOptions(), () => {
  const result = runMac(["--real"]);
  const out = combined(result);
  assert.equal(result.status, 2, out);
  assert.match(out, /REFUSED real mode while fixture\/test mode is active/);
  assert.doesNotMatch(out, /ACTION_EXECUTED|MODE real/);
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-verify-mutant-"));
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
    const directory = mkdtempSync(join(ROOT, ".machine-prep-mutant-"));
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
    assert.match(source, /0\.155\.0-alpha\.16/);
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
  assert.match(checkOut, /WRONG_VERSION  Codex CLI/);
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
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-checksum-"));
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
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-prefix-"));
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
  const directory = mkdtempSync(join(tmpdir(), "machine-prep-installed-brain-"));
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-windows-download-"));
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-windows-verify-mutant-"));
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-windows-pipes-"));
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
  const directory = mkdtempSync(join(ROOT, ".machine-prep-windows-mutant-"));
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
