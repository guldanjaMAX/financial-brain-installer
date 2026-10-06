import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
});

test("macOS staging contains the real prep, handoff, support log wrapper, and uninstall notes", () => {
  const staging = mkdtempSync(join(tmpdir(), "machine-prep-pkg-stage-"));
  try {
    const build = spawnSync("bash", [join(MAC_INSTALLER, "build-pkg.sh"), "--staging-only", staging], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const installed = join(staging, "payload", "Library", "Application Support", "FinancialBrainMachinePrep");
    const expected = [
      "prep-mac.sh",
      "run-machine-prep-mac.sh",
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
    const wrapper = readFileSync(join(installed, "run-machine-prep-mac.sh"), "utf8");
    assert.match(wrapper, /prep-mac\.sh" --real/);
    assert.match(wrapper, /installer\.log/);
    assert.match(wrapper, /handoff-mac\.sh/);
    assert.match(wrapper, /start-brain-setup\.command/);
    assert.match(wrapper, /SETUP_LAUNCH_DECISION_REACHED=1/);
    assert.match(wrapper, /set -o pipefail/);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("macOS package scripts keep root plumbing separate from the console user prep", () => {
  const postinstall = read("machine-prep/installers/macos/scripts/postinstall");
  assert.match(postinstall, /\/dev\/console/);
  assert.match(postinstall, /launchctl asuser/);
  assert.match(postinstall, /sudo -u/);
  assert.match(postinstall, /run-machine-prep-mac\.sh/);
  assert.doesNotMatch(postinstall, /prep-mac\.sh[^\n]*--real/);
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
    assert.match(contents.stdout, /FinancialBrainMachinePrep\/prep-mac\.sh/);
    // PackageKit can serialize protected host provenance xattrs as AppleDouble
    // entries. Ignore those metadata carriers and pin every functional path.
    const functionalPaths = contents.stdout.trim().split("\n")
      .filter((path) => !path.split("/").some((part) => part.startsWith("._")))
      .sort();
    assert.deepEqual(functionalPaths, [
      ".",
      "./Library",
      "./Library/Application Support",
      "./Library/Application Support/FinancialBrainMachinePrep",
      "./Library/Application Support/FinancialBrainMachinePrep/UNINSTALL.md",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/continue-in-claude.command",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/handoff-mac.sh",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/handoff-macos.url",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/message-macos.txt",
      "./Library/Application Support/FinancialBrainMachinePrep/prep-mac.sh",
      "./Library/Application Support/FinancialBrainMachinePrep/run-machine-prep-mac.sh",
      "./Library/Application Support/FinancialBrainMachinePrep/start-brain-setup.command",
    ].sort());
    const signature = spawnSync("pkgutil", ["--check-signature", pkg], { encoding: "utf8" });
    assert.equal(signature.status, 1, `${signature.stdout}${signature.stderr}`);
    assert.match(signature.stdout, /Status: no signature/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("Windows MSI is per-machine, Windows 10+, one-prompt plumbing with process-only policy bypass", () => {
  const project = read("machine-prep/installers/windows/FinancialBrainMachinePrep.wixproj");
  const wix = read("machine-prep/installers/windows/Package.wxs");
  assert.match(project, /WixToolset\.Sdk\/7\.0\.0/);
  assert.match(wix, /Scope="perMachine"/);
  assert.match(wix, /VersionNT64 &gt;= 1000/);
  assert.match(wix, /macOS 13\.5 and Windows 10 are the supported minimums|Windows 10 or newer is required/);
  assert.match(wix, /ExecutionPolicy Bypass/);
  assert.match(wix, /Impersonate="yes"/);
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
