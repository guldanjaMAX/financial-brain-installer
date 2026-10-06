import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const HANDOFF = join(ROOT, "machine-prep", "handoff");
const MAC_INSTALLER = join(ROOT, "machine-prep", "installers", "macos");
const WINDOWS_INSTALLER = join(ROOT, "machine-prep", "installers", "windows");
const KIT_URL = "https://financialbrain.ai/kit/brain-installer-0.4.9-0555ad1972d7f8d6.tgz";
const KIT_SHA256 = "0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2";
const KIT_SIZE = "6668013";

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8").replaceAll("\r\n", "\n");
}

test("Claude handoff messages are local notes with no remote instructions", () => {
  const mac = read("machine-prep/handoff/message-macos.txt");
  const windows = read("machine-prep/handoff/message-windows.txt");
  assert.match(mac, /^The Financial Brain installer installed the verified CLI and opened setup/);
  assert.match(windows, /^The Financial Brain installer installed the verified CLI and opened setup/);
  for (const message of [mac, windows]) {
    assert.match(message, /Want me to do this for you\?/);
    assert.match(message, /Wait for my answer before taking that step\./);
    assert.match(message, /Never ask me to paste a command\./);
    assert.doesNotMatch(message, /https?:\/\/|curl|Invoke-WebRequest|download/i);
  }
});

test("both prep scripts pin, verify, and locally install the published 0.4.9 kit", () => {
  for (const source of [read("machine-prep/prep-mac.sh"), read("machine-prep/prep-windows.ps1")]) {
    assert.match(source, new RegExp(KIT_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(source, new RegExp(KIT_SHA256));
    assert.match(source, new RegExp(KIT_SIZE));
    assert.match(source, /CHECKSUM_DECISION_REACHED/);
    assert.match(source, /PREFIX_DECISION_REACHED/);
    assert.match(source, /--ignore-scripts/);
    assert.match(source, /--no-audit/);
    assert.match(source, /--no-fund/);
    assert.doesNotMatch(source, /npm(?:\.cmd)?[^\n]*install[^\n]*https:\/\//,
      "npm installs only the already verified local archive");
  }
});

test("handoff URL renderer produces the documented Claude Desktop Code deep link", () => {
  const renderer = join(HANDOFF, "render-url.mjs");
  const prompt = join(HANDOFF, "message-macos.txt");
  const result = spawnSync(process.execPath, [renderer, prompt], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^claude:\/\/code\/new\?q=/);
  const decoded = decodeURIComponent(result.stdout.trim().split("?q=")[1]);
  assert.equal(`${decoded}\n`, readFileSync(prompt, "utf8"));
});

test("both OS handoff launchers expose a no-side-effect decision probe and CLI fallback", () => {
  const mac = read("machine-prep/handoff/handoff-mac.sh");
  const windows = read("machine-prep/handoff/handoff-windows.ps1");
  for (const source of [mac, windows]) {
    assert.match(source, /HANDOFF_DECISION_REACHED=1/);
    assert.match(source, /claude:\/\/code\/new/);
    assert.match(source, /HANDOFF_FALLBACK_CLI/);
  }
});

test("macOS installer refuses an unsupported release after reaching its OS gate", () => {
  const preinstall = join(MAC_INSTALLER, "scripts", "preinstall");
  const result = spawnSync("bash", [preinstall], {
    cwd: ROOT,
    env: {
      ...process.env,
      MACHINE_PREP_OS_VERSION_OVERRIDE: "12.6.9",
      MACHINE_PREP_INSTALLER_TEST_MODE: "1",
    },
    encoding: "utf8",
  });
  const out = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2, out);
  assert.match(out, /OS_DECISION_REACHED=1/);
  assert.match(out, /REFUSED macOS 13\.5 or newer is required/);
  assert.doesNotMatch(out, /PREP_STARTED/);

  const control = spawnSync("bash", [preinstall], {
    cwd: ROOT,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: join(ROOT, ".installers-fix-test-home"),
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: join(ROOT, ".installers-fix-test-home", "injected-launchctl"),
      MACHINE_PREP_OS_VERSION_OVERRIDE: "13.5",
      MACHINE_PREP_INSTALLER_TEST_MODE: "1",
    },
    encoding: "utf8",
  });
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
  assert.match(control.stdout, /OS_DECISION_REACHED=1/);
  assert.match(control.stdout, /OS_SUPPORTED=1/);
});

test("macOS staging contains the real prep, handoff, support log wrapper, and uninstall notes", () => {
  const staging = mkdtempSync(join(tmpdir(), "machine-prep-pkg-stage-"));
  try {
    const build = spawnSync("bash", [join(MAC_INSTALLER, "build-pkg.sh"), "--staging-only", staging], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const installed = join(staging, "payload", "Applications", "Financial Brain Machine Prep");
    const expected = [
      "prep-mac.sh",
      "Run Financial Brain Machine Prep.command",
      "handoff/handoff-mac.sh",
      "handoff/handoff-macos.url",
      "handoff/message-macos.txt",
      "start-brain-setup.command",
      "UNINSTALL.md",
    ];
    for (const relativePath of expected) {
      assert.equal(existsSync(join(installed, relativePath)), true, `missing ${relativePath}`);
    }
    assert.notEqual(statSync(join(installed, "prep-mac.sh")).mode & 0o111, 0);
    const wrapper = readFileSync(join(installed, "Run Financial Brain Machine Prep.command"), "utf8");
    assert.match(wrapper, /"\$PREP_RUNNER" --real/);
    assert.match(wrapper, /installer\.log/);
    assert.match(wrapper, /handoff-mac\.sh/);
    assert.match(wrapper, /start-brain-setup\.command/);
    assert.match(wrapper, /SETUP_LAUNCH_DECISION_REACHED=1/);
    assert.match(wrapper, /LOG_SCHEMA_DECISION_REACHED=1/);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("macOS package has no privileged script phase and targets only the current user", () => {
  const build = read("machine-prep/installers/macos/build-pkg.sh");
  const distribution = read("machine-prep/installers/macos/Distribution.xml");
  assert.doesNotMatch(build, /--scripts|scripts\/postinstall/);
  assert.match(distribution, /enable_currentUserHome="true"/);
  assert.match(distribution, /enable_localSystem="false"/);
  assert.match(distribution, /require-scripts="false"/);
});

test("macOS native tools build the reviewed unsigned package contents", { skip: process.platform !== "darwin" }, () => {
  const output = mkdtempSync(join(tmpdir(), "machine-prep-pkg-build-"));
  try {
    const pkg = join(output, "FinancialBrainMachinePrep-unsigned.pkg");
    const build = spawnSync("bash", [join(MAC_INSTALLER, "build-pkg.sh"), pkg], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const contents = spawnSync("pkgutil", ["--payload-files", pkg], { encoding: "utf8" });
    assert.equal(contents.status, 0, `${contents.stdout}${contents.stderr}`);
    assert.match(contents.stdout, /Financial Brain Machine Prep\/prep-mac\.sh/);
    // PackageKit can serialize protected host provenance xattrs as AppleDouble
    // entries. Ignore those metadata carriers and pin every functional path.
    const functionalPaths = contents.stdout.trim().split("\n")
      .filter((path) => !path.split("/").some((part) => part.startsWith("._")))
      .sort();
    assert.deepEqual(functionalPaths, [
      ".",
      "./Applications",
      "./Applications/Financial Brain Machine Prep",
      "./Applications/Financial Brain Machine Prep/UNINSTALL.md",
      "./Applications/Financial Brain Machine Prep/handoff",
      "./Applications/Financial Brain Machine Prep/handoff/continue-in-claude.command",
      "./Applications/Financial Brain Machine Prep/handoff/handoff-mac.sh",
      "./Applications/Financial Brain Machine Prep/handoff/handoff-macos.url",
      "./Applications/Financial Brain Machine Prep/handoff/message-macos.txt",
      "./Applications/Financial Brain Machine Prep/prep-mac.sh",
      "./Applications/Financial Brain Machine Prep/Run Financial Brain Machine Prep.command",
      "./Applications/Financial Brain Machine Prep/start-brain-setup.command",
    ].sort());
    const signature = spawnSync("pkgutil", ["--check-signature", pkg], { encoding: "utf8" });
    assert.equal(signature.status, 1, `${signature.stdout}${signature.stderr}`);
    assert.match(signature.stdout, /Status: no signature/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("Windows MSI is per-user, Windows 10+, and uses process-only policy bypass", () => {
  const project = read("machine-prep/installers/windows/FinancialBrainMachinePrep.wixproj");
  const wix = read("machine-prep/installers/windows/Package.wxs");
  assert.match(project, /WixToolset\.Sdk\/7\.0\.0/);
  assert.match(wix, /Scope="perUser"/);
  assert.match(wix, /LocalAppDataFolder/);
  assert.match(wix, /<Shortcut/);
  assert.doesNotMatch(wix, /<CustomAction|InstallExecuteSequence/);
  assert.doesNotMatch(wix, /ProgramFiles64Folder|UAC prompt/);
  assert.match(wix, /VersionNT64 &gt;= 1000/);
  assert.match(wix, /macOS 13\.5 and Windows 10 are the supported minimums|Windows 10 or newer is required/);
  assert.match(wix, /ExecutionPolicy Bypass/);
  assert.match(wix, /ProgramMenuFolder/);
  assert.match(wix, /<Shortcut/);
  assert.doesNotMatch(wix, /<CustomAction|InstallExecuteSequence/);
  assert.match(wix, /prep-windows\.ps1/);
  assert.match(wix, /run-machine-prep\.ps1/);
  assert.match(wix, /message-windows\.txt/);
  assert.match(wix, /handoff-windows\.url/);
  assert.doesNotMatch(wix, /Set-ExecutionPolicy|MSIX/);
});

test("Windows wrapper has an unsupported-OS decision gate, shareable log, real prep, and Claude handoff", () => {
  const wrapper = read("machine-prep/installers/windows/run-machine-prep.ps1");
  assert.match(wrapper, /OS_DECISION_REACHED=1/);
  assert.match(wrapper, /REFUSED Windows 10 or newer is required/);
  assert.match(wrapper, /prep-windows\.ps1/);
  assert.match(wrapper, /Invoke-EmbeddedPowerShell \$prep @\("--real"\)/);
  assert.match(wrapper, /installer\.log/);
  assert.match(wrapper, /handoff-windows\.ps1/);
  assert.match(wrapper, /start-brain-setup\.ps1/);
  assert.match(wrapper, /SETUP_LAUNCH_DECISION_REACHED=1/);
  assert.doesNotMatch(wrapper, /Set-ExecutionPolicy/);
});

test("Windows pinned download and child processes use PowerShell 5.1-compatible bounded primitives", () => {
  const prep = read("machine-prep/prep-windows.ps1");
  const wrapper = read("machine-prep/installers/windows/run-machine-prep.ps1");
  const assertPrimitives = ({ prepSource, wrapperSource }) => {
    assert.match(prepSource, /\[IO\.File\]::Open\(\$Destination, \[IO\.FileMode\]::CreateNew, \[IO\.FileAccess\]::Write, \[IO\.FileShare\]::None\)/);
    assert.doesNotMatch(prepSource, /\[IO\.File\]::OpenNew/);
    for (const source of [prepSource, wrapperSource]) {
      assert.match(source, /StandardOutput\.ReadToEndAsync\(\)/);
      assert.match(source, /StandardError\.ReadToEndAsync\(\)/);
      assert.match(source, /\[Threading\.Tasks\.Task\]::WaitAll/);
    }
  };
  assert.doesNotThrow(() => assertPrimitives({ prepSource: prep, wrapperSource: wrapper }));
  const mutants = [
    { prepSource: prep.replace("[IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)", "[IO.File]::OpenNew($Destination)"), wrapperSource: wrapper },
    { prepSource: prep.replace("StandardOutput.ReadToEndAsync()", "StandardOutput.ReadToEnd()"), wrapperSource: wrapper },
    { prepSource: prep, wrapperSource: wrapper.replace("StandardError.ReadToEndAsync()", "StandardError.ReadToEnd()") },
  ];
  for (const mutant of mutants) assert.throws(() => assertPrimitives(mutant));
});

test("visible setup launchers use the installed CLI and the standard fresh manifest path", () => {
  const mac = read("machine-prep/installers/macos/start-brain-setup.command");
  assert.match(mac, /\.financial-brain\/bin\/brain/);
  assert.match(mac, /Financial Brain\/brain\.manifest\.json/);
  assert.match(mac, /"\$BRAIN" setup "\$MANIFEST"/);

  const windows = read("machine-prep/installers/windows/start-brain-setup.ps1");
  assert.match(windows, /FinancialBrain\\brain\.cmd/);
  assert.match(windows, /Financial Brain\\brain\.manifest\.json/);
  assert.match(windows, /& \$brain setup \$manifest/);
});

test("Windows package project names every reviewed payload file", () => {
  const expected = [
    "FinancialBrainMachinePrep.wixproj",
    "Package.wxs",
    "run-machine-prep.ps1",
    "start-brain-setup.ps1",
    "verify-msi.ps1",
    "UNINSTALL.txt",
  ];
  for (const name of expected) {
    assert.equal(existsSync(join(WINDOWS_INSTALLER, name)), true, `missing ${name}`);
  }
  const verifier = read("machine-prep/installers/windows/verify-msi.ps1");
  assert.match(verifier, /LocalAppDataFolder/);
  assert.match(verifier, /MSI_SCOPE_VERIFIED=per_user/);
  assert.match(verifier, /MSI_VISIBLE_LAUNCHER_VERIFIED=1/);
});

test("Windows wrapper refuses an unsupported release before prep", { skip: process.platform !== "win32" }, () => {
  const powerShell = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const result = spawnSync(powerShell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(WINDOWS_INSTALLER, "run-machine-prep.ps1"),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      MACHINE_PREP_OS_VERSION_OVERRIDE: "6.3",
      MACHINE_PREP_INSTALLER_TEST_MODE: "1",
    },
    encoding: "utf8",
  });
  const out = `${result.stdout}${result.stderr}`.replaceAll("\r\n", "\n");
  assert.equal(result.status, 2, out);
  assert.match(out, /OS_DECISION_REACHED=1/);
  assert.match(out, /REFUSED Windows 10 or newer is required/);
  assert.doesNotMatch(out, /INSTALLER_TEST_GATE_REACHED|INSTALLER_PROGRESS/);
});

test("machine-prep CI still builds review artifacts with pinned actions and no release path", () => {
  const workflow = read(".github/workflows/machine-prep-installers.yml");
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /wix_osmf_confirmed:/);
  assert.match(workflow, /if: inputs\.wix_osmf_confirmed/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /FinancialBrainMachinePrep-unsigned\.pkg/);
  assert.match(workflow, /FinancialBrainMachinePrep-unsigned\.msi/);
  assert.equal([...workflow.matchAll(/actions\/upload-artifact@[0-9a-f]{40}/g)].length, 2);
  for (const match of workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gm)) {
    if (match[1].startsWith("./")) continue;
    assert.match(match[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(workflow, /gh release|release:|contents:\s*write|id-token:\s*write|notarytool|signtool/i);
});

const WINDOWS_SIGNING_VARIABLES = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "ARTIFACT_SIGNING_ENDPOINT",
  "ARTIFACT_SIGNING_ACCOUNT",
  "ARTIFACT_SIGNING_PROFILE",
];

const MAC_SIGNING_SECRETS = [
  "APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64",
  "APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD",
  "APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64",
  "APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD",
  "APPLE_NOTARY_KEY_ID",
  "APPLE_NOTARY_ISSUER_ID",
  "APPLE_NOTARY_KEY_P8_BASE64",
];

function assertCleanSigningSkipContract(workflow) {
  assert.match(workflow, /macos_configured=false/);
  assert.match(workflow, /windows_configured=false/);
  assert.match(workflow, /if: needs\.configuration\.outputs\.macos_configured == 'true'/);
  assert.match(workflow, /if: needs\.configuration\.outputs\.windows_configured == 'true'/);
  assert.match(workflow, /Signing skipped cleanly/);
}

test("signing workflow skips cleanly when unsigned and detects a skip-gate mutation", () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  assert.doesNotThrow(() => assertCleanSigningSkipContract(workflow));
  const mutant = workflow.replace("macos_configured=false", "macos_configured=true");
  assert.throws(() => assertCleanSigningSkipContract(mutant));
});

test("signing workflow performs the required Apple and Artifact Signing ceremonies", () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /environment: artifact-signing/);
  assert.match(workflow, /wix_osmf_confirmed:/);
  assert.match(workflow, /pkgbuild/);
  assert.match(workflow, /productbuild/);
  assert.match(workflow, /codesign/);
  assert.match(workflow, /productsign/);
  assert.match(workflow, /xcrun notarytool submit[\s\S]*--wait/);
  assert.match(workflow, /xcrun stapler staple/);
  assert.match(workflow, /azure\/login@[0-9a-f]{40}/);
  assert.match(workflow, /azure\/artifact-signing-action@[0-9a-f]{40}/);
  for (const name of WINDOWS_SIGNING_VARIABLES) assert.match(workflow, new RegExp(`vars\\.${name}\\b`));
  for (const name of MAC_SIGNING_SECRETS) assert.match(workflow, new RegExp(`secrets\\.${name}\\b`));
  assert.match(workflow, /vars\.APPLE_TEAM_ID\b/);
  for (const match of workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gm)) {
    if (match[1].startsWith("./")) continue;
    assert.match(match[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(workflow, /contents:\s*write|gh release|releases:/i);
});

function runSigningCleanup({ owned, deleteFails = false, scriptPath = join(MAC_INSTALLER, "cleanup-signing-material.sh") }) {
  const directory = mkdtempSync(join(ROOT, ".signing-cleanup-test-"));
  const keychain = join(directory, "installer-signing.keychain-db");
  const marker = join(directory, "installer-signing.keychain-owner");
  const calls = join(directory, "security-calls.log");
  const security = join(directory, "security-fixture");
  const attempt = "synthetic-attempt-1";
  writeFileSync(keychain, "synthetic keychain\n");
  if (owned) writeFileSync(marker, `${attempt}\n`);
  for (const name of ["application.p12", "application.pem", "installer.p12", "installer.pem", "notary-key.p8"]) {
    writeFileSync(join(directory, name), "synthetic material\n");
  }
  writeFileSync(security, `#!/bin/sh
printf '%s\\n' "$1" >> "${calls}"
case "$1" in
  delete-keychain)
    ${deleteFails ? "exit 9" : "rm -f \"$2\"; exit 0"}
    ;;
  show-keychain-info) exit 7 ;;
  *) exit 8 ;;
esac
`);
  chmodSync(security, 0o755);
  const result = spawnSync("bash", [scriptPath], {
    cwd: ROOT,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      RUNNER_TEMP: directory,
      SIGNING_KEYCHAIN: keychain,
      SIGNING_KEYCHAIN_MARKER: marker,
      SIGNING_ATTEMPT_ID: attempt,
      SIGNING_SECURITY_COMMAND: security,
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
    },
    encoding: "utf8",
  });
  return {
    directory,
    keychain,
    marker,
    calls,
    result,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("signing cleanup deletes only its marked keychain and fails loudly when deletion is unproven", () => {
  const owned = runSigningCleanup({ owned: true });
  try {
    assert.equal(owned.result.status, 0, `${owned.result.stdout}${owned.result.stderr}`);
    assert.match(owned.result.stdout, /KEYCHAIN_CLEANUP_DECISION_REACHED=1/);
    assert.match(readFileSync(owned.calls, "utf8"), /^delete-keychain$/m);
    assert.equal(existsSync(owned.keychain), false);
    assert.equal(existsSync(owned.marker), false);
  } finally {
    owned.cleanup();
  }

  const failed = runSigningCleanup({ owned: true, deleteFails: true });
  try {
    assert.notEqual(failed.result.status, 0);
    assert.match(`${failed.result.stdout}${failed.result.stderr}`, /KEYCHAIN_CLEANUP_FAILED=1/);
    assert.equal(existsSync(failed.keychain), true);
  } finally {
    failed.cleanup();
  }

  const foreign = runSigningCleanup({ owned: false });
  try {
    assert.notEqual(foreign.result.status, 0);
    assert.match(`${foreign.result.stdout}${foreign.result.stderr}`, /KEYCHAIN_CLEANUP_STOP_UNOWNED=1/);
    assert.equal(existsSync(foreign.keychain), true);
    assert.equal(existsSync(foreign.calls), false, "foreign keychain must not reach delete");
  } finally {
    foreign.cleanup();
  }
});

test("signing cleanup ownership mutation turns the foreign-keychain control red", () => {
  const sourcePath = join(MAC_INSTALLER, "cleanup-signing-material.sh");
  const source = readFileSync(sourcePath, "utf8");
  const from = 'if [ "$marker_value" != "$attempt_id" ]; then';
  assert.equal(source.includes(from), true, "missing cleanup ownership decision");
  const directory = mkdtempSync(join(ROOT, ".signing-cleanup-mutant-"));
  const mutant = join(directory, "cleanup-signing-material.sh");
  writeFileSync(mutant, source.replace(from, "if false; then"));
  const probe = runSigningCleanup({ owned: false, scriptPath: mutant });
  try {
    assert.throws(() => {
      assert.notEqual(probe.result.status, 0);
      assert.equal(existsSync(probe.keychain), true);
      assert.equal(existsSync(probe.calls), false);
    }, undefined, "cleanup ownership mutation survived");
  } finally {
    probe.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installer signing guide names the exact owner ceremonies and settings", () => {
  const guide = read("docs/INSTALLERS-SIGNING.md");
  assert.match(guide, /Keychain Access/);
  assert.match(guide, /Developer ID Application/);
  assert.match(guide, /Developer ID Installer/);
  assert.match(guide, /\.p12/);
  assert.match(guide, /Team Keys/);
  assert.match(guide, /Developer role/);
  assert.match(guide, /Team ID/);
  for (const name of [...MAC_SIGNING_SECRETS, ...WINDOWS_SIGNING_VARIABLES, "APPLE_TEAM_ID"]) {
    assert.match(guide, new RegExp(`\\b${name}\\b`));
  }
  assert.match(guide, /docs\/WINDOWS-SIGNING\.md/);
});

test("signing plan names owner purchases, warning behavior, and secretless repository boundaries", () => {
  const plan = read("machine-prep/SIGNING.md");
  assert.match(plan, /2026-09-24/);
  assert.match(plan, /\$99 per year/);
  assert.match(plan, /Developer ID Installer/);
  assert.match(plan, /notarytool/);
  assert.match(plan, /\$9\.99 per month/);
  assert.match(plan, /\$99\.99 per month/);
  assert.match(plan, /OV.*\$696/s);
  assert.match(plan, /EV.*\$972/s);
  assert.match(plan, /SmartScreen/);
  assert.match(plan, /Open Source Maintenance Fee/);
  assert.match(plan, /GitHub OIDC/);
  assert.match(plan, /No signing credential belongs in the repository/);
});

function assertSecurityContracts({ macPrep, windowsPrep, distribution, buildPkg, wix, macRunner, windowsRunner, signing, signingCleanup }) {
  for (const source of [macPrep, windowsPrep]) {
    assert.doesNotMatch(source, /claude\.ai\/install|nodejs\.org\/dist|winget(?:\.Source)?\s+install|@openai\/codex@/i);
    assert.match(source, /PREREQUISITE_DECISION_REACHED/);
    assert.match(source, /OWNER ACTION/);
    assert.match(source, /REUSE_ATTEMPTED=0/);
    assert.match(source, /INSTALL_LOCK_ACQUIRED/);
    assert.match(source, /STAGED_PREFIX_VERIFIED/);
    assert.match(source, /ATOMIC_PROMOTION_VERIFIED/);
    assert.match(source, /NO_REDIRECTS/);
    assert.match(source, /NPM_ENVIRONMENT_ISOLATED/);
  }
  assert.doesNotMatch(macPrep, /grep -Fq "\$BRAIN_VERSION"/);
  assert.doesNotMatch(windowsPrep, /\.Contains\(\$BrainVersion\)/);
  assert.match(macPrep, /if ! \/bin\/mkdir "\$lock"/);
  assert.match(macPrep, /if ! owns_attempt_dir "\$owned_path"/);
  assert.match(macPrep, /renamex_np[\s\S]*renamex_np\(argv\[0\], argv\[1\], 4\)/);
  assert.match(macPrep, /\/usr\/bin\/env -i HOME=/);
  assert.match(windowsPrep, /\$handler\.AllowAutoRedirect = \$false/);
  assert.match(windowsPrep, /\[IO\.Directory\]::Move\(\$stage, \$BrainPrefix\)/);
  assert.match(windowsPrep, /Test-InstallAttemptOwnership \$Directory \$AttemptId/);
  assert.match(windowsPrep, /StandardOutput\.ReadToEndAsync\(\)/);
  assert.match(windowsPrep, /StandardError\.ReadToEndAsync\(\)/);
  assert.match(windowsPrep, /\[Console\]::Out\.WriteLine\("NPM_ENVIRONMENT_ISOLATED=1"\)/);
  assert.match(distribution, /enable_currentUserHome="true"/);
  assert.match(distribution, /enable_localSystem="false"/);
  assert.match(buildPkg, /Applications\/Financial Brain Machine Prep/);
  assert.doesNotMatch(buildPkg, /--scripts|scripts\/postinstall/);
  assert.match(wix, /Scope="perUser"/);
  assert.match(wix, /LocalAppDataFolder/);
  assert.doesNotMatch(wix, /ProgramFiles64Folder|UAC prompt/);
  assert.match(wix, /<Shortcut/);
  assert.doesNotMatch(wix, /<CustomAction|InstallExecuteSequence/);
  assert.match(macRunner, /LOG_SCHEMA_DECISION_REACHED/);
  assert.doesNotMatch(macRunner, /sanitize_log|2>&1\s*\|/);
  assert.match(macRunner, /\/usr\/bin\/env -i/);
  assert.match(macRunner, /exit "\$prep_status"/);
  assert.match(macRunner, /exit "\$setup_status"/);
  assert.match(windowsRunner, /\[IO\.File\]::AppendAllText/);
  assert.match(windowsRunner, /\.ExitCode/);
  assert.match(windowsRunner, /EnvironmentVariables\.Clear\(\)/);
  assert.match(windowsRunner, /StandardOutput\.ReadToEndAsync\(\)/);
  assert.match(windowsRunner, /StandardError\.ReadToEndAsync\(\)/);
  assert.match(windowsRunner, /\[Threading\.Tasks\.Task\]::WaitAll/);
  assert.match(windowsRunner, /exit \$prepResult\.ExitCode/);
  assert.doesNotMatch(windowsRunner, /Tee-Object|RedirectStandardOutput\s+\$stdout/);
  assert.match(signing, /github\.event_name == 'workflow_dispatch'/);
  assert.match(signing, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(signing, /vars\.SIGNING_REPOSITORY != ''/);
  assert.ok(signing.indexOf("SIGNING_KEYCHAIN=$keychain") < signing.indexOf("security create-keychain"));
  assert.match(signing, /trap cleanup_signing_material EXIT/);
  assert.match(signing, /if \[ "\$mac_missing" -eq 0 \]; then/);
  assert.doesNotMatch(signing, /security delete-keychain[^\n]*\|\| true/);
  assert.match(signingCleanup, /if \[ "\$marker_value" != "\$attempt_id" \]; then/);
  assert.match(signingCleanup, /"\$security_command" delete-keychain "\$keychain"/);
}

test("installer security contracts detect one mutation per reviewed boundary", () => {
  const sources = {
    macPrep: read("machine-prep/prep-mac.sh"),
    windowsPrep: read("machine-prep/prep-windows.ps1"),
    distribution: read("machine-prep/installers/macos/Distribution.xml"),
    buildPkg: read("machine-prep/installers/macos/build-pkg.sh"),
    wix: read("machine-prep/installers/windows/Package.wxs"),
    macRunner: read("machine-prep/installers/macos/run-machine-prep-mac.sh"),
    windowsRunner: read("machine-prep/installers/windows/run-machine-prep.ps1"),
    signing: read(".github/workflows/installer-signing.yml"),
    signingCleanup: read("machine-prep/installers/macos/cleanup-signing-material.sh"),
  };
  assert.doesNotThrow(() => assertSecurityContracts(sources));
  const mutations = [
    ["macPrep", 'if ! /bin/mkdir "$lock"', "if false"],
    ["macPrep", "/usr/bin/env -i HOME=", "/usr/bin/env HOME="],
    ["windowsPrep", "$handler.AllowAutoRedirect = $false", "$handler.AllowAutoRedirect = $true"],
    ["windowsPrep", ".StandardOutput.ReadToEndAsync()", ".StandardOutput.ReadToEnd()"],
    ["signing", 'if [ "$mac_missing" -eq 0 ]; then', 'if [ "$mac_missing" -ne 0 ]; then'],
    ["signingCleanup", 'if [ "$marker_value" != "$attempt_id" ]; then', "if false; then"],
    ["distribution", 'enable_localSystem="false"', 'enable_localSystem="true"'],
    ["buildPkg", "Applications/Financial Brain Machine Prep", "Library/Application Support/FinancialBrainMachinePrep"],
    ["wix", 'Scope="perUser"', 'Scope="perMachine"'],
    ["wix", "<Shortcut", "<CustomAction"],
    ["macRunner", 'exit "$setup_status"', 'exit 0 # setup failure swallowed'],
    ["windowsRunner", ".StandardError.ReadToEndAsync()", ".StandardError.ReadToEnd()"],
    ["signing", "vars.SIGNING_REPOSITORY != ''", "github.repository != ''"],
  ];
  for (const [key, from, to] of mutations) {
    const mutant = { ...sources, [key]: sources[key].replaceAll(from, to) };
    assert.throws(() => assertSecurityContracts(mutant), `mutation survived for ${key}: ${from}`);
  }
});

function runMacWrapper({ prepExit, openExit, handoffExit }) {
  const directory = mkdtempSync(join(ROOT, ".machine-prep-wrapper-test-"));
  const counter = join(directory, "counter.log");
  const helper = (name, exitCode) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${name} >> "${counter}"\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const result = spawnSync("bash", [join(MAC_INSTALLER, "run-machine-prep-mac.sh")], {
    cwd: ROOT,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
      MACHINE_PREP_RUNNER: helper("prep", prepExit),
      MACHINE_PREP_OPEN: helper("open", openExit),
      MACHINE_PREP_HANDOFF: helper("handoff", handoffExit),
      MACHINE_PREP_LOG_DIR: join(directory, "log"),
    },
    encoding: "utf8",
  });
  const calls = existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean) : [];
  rmSync(directory, { recursive: true, force: true });
  return { ...result, calls };
}

test("Mac launcher reaches prep and setup decisions, propagates failures, and hands off only after success", () => {
  const prepFailure = runMacWrapper({ prepExit: 7, openExit: 0, handoffExit: 0 });
  assert.equal(prepFailure.status, 7, prepFailure.stderr);
  assert.deepEqual(prepFailure.calls, ["prep"]);
  assert.match(prepFailure.stdout, /SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed/);

  const launchFailure = runMacWrapper({ prepExit: 0, openExit: 9, handoffExit: 0 });
  assert.equal(launchFailure.status, 9, launchFailure.stderr);
  assert.deepEqual(launchFailure.calls, ["prep", "open"]);
  assert.match(launchFailure.stdout, /SETUP_WINDOW_STARTED=0/);

  const control = runMacWrapper({ prepExit: 0, openExit: 0, handoffExit: 0 });
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(control.calls, ["prep", "open", "handoff"]);
  assert.match(control.stdout, /INSTALLER_HANDOFF_STARTED=1/);
});

test("Windows launcher reaches one typed exit decision and starts setup only after prep succeeds", { skip: process.platform !== "win32" }, () => {
  const powerShell = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const run = ({ prep, setup, handoff }) => {
    const home = mkdtempSync(join(ROOT, ".machine-prep-windows-wrapper-"));
    try {
      return spawnSync(powerShell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", join(WINDOWS_INSTALLER, "run-machine-prep.ps1"),
      ], {
        cwd: ROOT,
        env: {
          SystemRoot: process.env.SystemRoot,
          SYSTEMROOT: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          COMSPEC: process.env.COMSPEC,
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          TEMP: join(home, "temp"), TMP: join(home, "temp"), HOME: home,
          USERPROFILE: home, LOCALAPPDATA: join(home, "local"), APPDATA: join(home, "roaming"),
          BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
          MACHINE_PREP_OS_VERSION_OVERRIDE: "10.0",
          MACHINE_PREP_INSTALLER_TEST_MODE: "1",
          MACHINE_PREP_TEST_PREP_EXIT: String(prep),
          MACHINE_PREP_TEST_SETUP_EXIT: String(setup),
          MACHINE_PREP_TEST_HANDOFF_EXIT: String(handoff),
        },
        encoding: "utf8",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  const refused = run({ prep: 7, setup: 0, handoff: 0 });
  assert.equal(refused.status, 7, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stdout, /PREP_EXIT_CODE=7/);
  assert.match(refused.stdout, /TEST_SETUP_ATTEMPTS=0/);
  assert.match(refused.stdout, /OWNER ACTION: install any missing prerequisite/);

  const setupFailure = run({ prep: 0, setup: 9, handoff: 0 });
  assert.equal(setupFailure.status, 9, `${setupFailure.stdout}${setupFailure.stderr}`);
  assert.match(setupFailure.stdout, /TEST_SETUP_ATTEMPTS=1/);
  assert.match(setupFailure.stdout, /SETUP_WINDOW_STARTED=0/);

  const control = run({ prep: 0, setup: 0, handoff: 0 });
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
  assert.match(control.stdout, /PREP_EXIT_CODE=0/);
  assert.match(control.stdout, /SETUP_WINDOW_STARTED=1/);
  assert.match(control.stdout, /INSTALLER_HANDOFF_STARTED=1/);
});

test("Windows launcher concurrently drains oversized child output for zero and nonzero exits", { skip: process.platform !== "win32", timeout: 30_000 }, () => {
  const powerShell = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  for (const exitCode of [0, 7]) {
    const directory = mkdtempSync(join(ROOT, ".machine-prep-windows-runner-pipes-"));
    const child = join(directory, "large-output.ps1");
    mkdirSync(join(directory, "temp"), { recursive: true });
    writeFileSync(child, `$chunk = "x" * 1024\n1..256 | ForEach-Object { [Console]::Error.WriteLine($chunk) }\n1..256 | ForEach-Object { [Console]::Out.WriteLine($chunk) }\nexit ${exitCode}\n`);
    try {
      const result = spawnSync(powerShell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", join(WINDOWS_INSTALLER, "run-machine-prep.ps1"), "-TestChildPath", child,
      ], {
        cwd: ROOT,
        env: {
          SystemRoot: process.env.SystemRoot,
          SYSTEMROOT: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          COMSPEC: process.env.COMSPEC,
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          TEMP: join(directory, "temp"), TMP: join(directory, "temp"), HOME: directory,
          USERPROFILE: directory, LOCALAPPDATA: join(directory, "local"), APPDATA: join(directory, "roaming"),
          BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
          MACHINE_PREP_OS_VERSION_OVERRIDE: "10.0",
          MACHINE_PREP_INSTALLER_TEST_MODE: "1",
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, exitCode, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, new RegExp(`REDIRECTED_PROCESS_DECISION_REACHED=1 exit=${exitCode}`));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
