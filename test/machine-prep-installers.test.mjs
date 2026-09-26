import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// Shared with the signing workflow test so both see every YAML key spelling.
import { triggerNames, workflowJobs } from "./helpers/workflow-yaml.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HANDOFF = join(ROOT, "machine-prep", "handoff");
const MAC_INSTALLER = join(ROOT, "machine-prep", "installers", "macos");
const WINDOWS_INSTALLER = join(ROOT, "machine-prep", "installers", "windows");

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8").replaceAll("\r\n", "\n");
}

test("Claude handoff messages use the public OS guide and preserve owner approval", () => {
  const mac = read("machine-prep/handoff/message-macos.txt");
  const windows = read("machine-prep/handoff/message-windows.txt");
  assert.match(mac, /^Please start the Financial Brain guided setup\./);
  assert.match(mac, /curl -fsSL https:\/\/financialbrain\.ai\/install\/agent-macos\.md/);
  assert.match(windows, /curl -fsSL https:\/\/financialbrain\.ai\/install\/agent\.md/);
  for (const message of [mac, windows]) {
    assert.match(message, /Want me to do this for you\?/);
    assert.match(message, /Wait for my answer before taking that step\./);
    assert.match(message, /Never ask me to paste a command\./);
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
  assert.doesNotMatch(wrapper, /Set-ExecutionPolicy/);
});

test("Windows package project names every reviewed payload file", () => {
  const expected = [
    "FinancialBrainMachinePrep.wixproj",
    "Package.wxs",
    "run-machine-prep.ps1",
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

test("machine-prep CI builds only unsigned artifacts with pinned actions and no release path", () => {
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

// The publisher the owner plans to validate for both signing identities. One
// constant, so the MSI metadata cannot drift from the signed identity.
const PLANNED_PUBLISHER = "Financial Brain LLC";
const SIGNING_ENVIRONMENT = "installer-signing";
const MAC_SIGNING_SECRETS = [
  "APPLE_DEVID_INSTALLER_P12_BASE64",
  "APPLE_DEVID_INSTALLER_P12_PASSWORD",
  "APPLE_NOTARY_KEY_P8",
  "APPLE_NOTARY_KEY_ID",
  "APPLE_NOTARY_ISSUER_ID",
];
// Not a secret: the Apple Developer Team ID that the one accepted Developer ID
// Installer identity must carry.
const MAC_SIGNING_VARIABLES = ["APPLE_TEAM_ID"];
const WINDOWS_SIGNING_VARIABLES = [
  "ARTIFACT_SIGNING_ENDPOINT",
  "ARTIFACT_SIGNING_ACCOUNT_NAME",
  "ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
];


/** Each step's text, in order, so gates can be checked for position. */
function workflowSteps(job) {
  return job.split(/^      - /m).slice(1);
}

/** The literal script of every `run:` block, where expressions would be interpolated into a shell. */
function runScripts(workflow) {
  const scripts = [];
  const lines = workflow.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const body = [match[2]];
    while (index + 1 < lines.length &&
      (lines[index + 1].trim() === "" || /^\s*/.exec(lines[index + 1])[0].length > indent)) {
      body.push(lines[++index]);
    }
    scripts.push(body.join("\n"));
  }
  return scripts;
}

/** The signing workflow's trigger, token, environment and action policy; throws on any drift. */
function assertSigningWorkflowShape(workflow) {
  const triggers = triggerNames(workflow);
  assert.ok(triggers.includes("workflow_dispatch"));
  assert.deepEqual(triggers, ["workflow_dispatch"],
    "signing must never start from a push, pull request, schedule, tag, or another workflow");
  assert.match(workflow, /^permissions: \{\}$/m, "no job inherits a default token scope");
  const jobs = workflowJobs(workflow);
  assert.deepEqual([...jobs.keys()].sort(), ["macos-sign", "windows-sign"]);
  for (const [name, job] of jobs) {
    assert.match(job, new RegExp(`^    environment: ${SIGNING_ENVIRONMENT}$`, "m"), `${name} runs in the protected environment`);
    assert.doesNotMatch(job, /contents:\s*write|packages:\s*write|gh release|releases/i, `${name} cannot publish`);
  }
  assert.doesNotMatch(jobs.get("macos-sign"), /id-token/, "only the Windows job may request an OIDC token");
  assert.match(jobs.get("windows-sign"), /^      id-token: write$/m);
  const references = [...workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(references.length >= 5);
  for (const reference of references) {
    assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${reference} is pinned to a full commit`);
  }
  assert.ok(references.some((reference) => /^azure\/(?:artifact|trusted)-signing-action@[0-9a-f]{40}$/.test(reference)),
    "Windows signing uses the official Artifact Signing action");
  assert.ok(references.some((reference) => /^azure\/login@[0-9a-f]{40}$/.test(reference)));
  assert.match(workflow, /unsigned_run_id:/);
  assert.match(workflow, /FinancialBrainMachinePrep-macOS-unsigned/);
  assert.match(workflow, /FinancialBrainMachinePrep-Windows-unsigned/);
}

/** The unsigned build's exact trigger and job set; throws on any drift. */
function assertUnsignedWorkflowShape(workflow) {
  assert.deepEqual(triggerNames(workflow), ["workflow_dispatch"], "the unsigned build starts only by hand");
  assert.deepEqual([...workflowJobs(workflow).keys()].sort(), ["macos-unsigned", "windows-unsigned"]);
}

test("installer signing runs only by hand, in the protected environment, with every action pinned", () => {
  assertSigningWorkflowShape(read(".github/workflows/installer-signing.yml"));
});

test("the unsigned build has exactly its two jobs and a dispatch-only trigger", () => {
  assertUnsignedWorkflowShape(read(".github/workflows/machine-prep-installers.yml"));
});

// Job and trigger keys in every spelling YAML accepts must be seen: an extra
// job or trigger that only the parser misses is a policy hole.
// No permissions block, so only the job-key parser can notice the job.
const extraJob = (key) => `  ${key}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n`;
const shapeMutations = [
  ["an appended Extra_Job key with a trailing comment", (text) => `${text}${extraJob("Extra_Job:  # comment")}`],
  ["an appended double-quoted job key", (text) => `${text}${extraJob('"quoted-job":')}`],
  ["an appended single-quoted job key", (text) => `${text}${extraJob("'quoted-job':")}`],
  ["an appended uppercase job key", (text) => `${text}${extraJob("PUBLISH:")}`],
  ["a single-quoted pull_request_target trigger", (text) => text.replace(/^on:\n/m, "on:\n  'pull_request_target':\n")],
  ["a double-quoted push trigger with a comment", (text) => text.replace(/^on:\n/m, 'on:\n  "push":  # comment\n    branches: [main]\n')],
  ["a schedule trigger with a comment", (text) => text.replace(/^on:\n/m, "on:\n  schedule:  # nightly\n    - cron: '0 0 * * *'\n")],
  ["a quoted workflow_dispatch beside an added workflow_run", (text) => text.replace(/^  workflow_dispatch:$/m, "  'workflow_dispatch':\n  \"workflow_run\":\n    workflows: [ci]")],
];
const equivalentRewrites = [
  ["a single-quoted workflow_dispatch key", (text) => text.replace(/^  workflow_dispatch:$/m, "  'workflow_dispatch':")],
  ["a double-quoted workflow_dispatch key with a comment", (text) => text.replace(/^  workflow_dispatch:$/m, '  "workflow_dispatch":  # by hand only')],
  ["job keys with trailing comments", (text) => text.replace(/^  ([a-z-]+-(?:sign|unsigned)):$/gm, "  $1:  # reviewed job")],
  ["double-quoted job keys", (text) => text.replace(/^  ([a-z-]+-(?:sign|unsigned)):$/gm, '  "$1":')],
];
for (const [path, assertShape] of [
  [".github/workflows/installer-signing.yml", assertSigningWorkflowShape],
  [".github/workflows/machine-prep-installers.yml", assertUnsignedWorkflowShape],
]) {
  for (const [name, mutate] of shapeMutations) {
    test(`${path} mutation "${name}" is detected`, () => {
      const original = read(path);
      assertShape(original);
      const mutated = mutate(original);
      assert.notEqual(mutated, original, "the mutation applied to the current workflow");
      assert.throws(() => assertShape(mutated), assert.AssertionError);
    });
  }
  for (const [name, rewrite] of equivalentRewrites) {
    test(`${path} with ${name} still passes its shape check`, () => {
      const original = read(path);
      const rewritten = rewrite(original);
      assert.notEqual(rewritten, original, "the rewrite applied to the current workflow");
      assertShape(rewritten);
    });
  }
}

test("installer signing carries only secret and variable names, never a value", () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  const secrets = new Set([...workflow.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]));
  assert.deepEqual([...secrets].sort(), [...MAC_SIGNING_SECRETS].sort(), "only the declared Apple secrets are read");
  const variables = new Set([...workflow.matchAll(/\$\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]));
  assert.deepEqual([...variables].sort(), [...WINDOWS_SIGNING_VARIABLES, ...MAC_SIGNING_VARIABLES].sort(),
    "Windows identifiers and the Apple team come from repository or environment variables");
  const withoutPins = workflow.replace(/@[0-9a-f]{40}/g, "@PINNED");
  assert.doesNotMatch(withoutPins, /-----BEGIN|PRIVATE KEY|MII[A-Za-z0-9+/]{20}/, "no certificate or key material");
  assert.doesNotMatch(withoutPins, /[A-Za-z0-9+/]{40,}={0,2}/, "no long encoded token");
  assert.doesNotMatch(withoutPins, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    "no tenant, client, or subscription ID is written into the workflow");
  assert.doesNotMatch(withoutPins, /\.codesigning\.azure\.net/, "the signing endpoint is configuration, not source");
  assert.doesNotMatch(withoutPins, /(?:password|-p|-P)\s+["']?(?!\$)[A-Za-z0-9]{6,}/,
    "every password argument comes from a variable");
  const scripts = runScripts(workflow);
  assert.ok(scripts.length >= 8, "every run block was inspected");
  for (const script of scripts) {
    assert.doesNotMatch(script, /\$\{\{/, `run scripts read inputs and secrets through env, not interpolation:\n${script}`);
  }
});

test("each signing job refuses before touching an artifact when its configuration is missing", () => {
  const jobs = workflowJobs(read(".github/workflows/installer-signing.yml"));
  const macSteps = workflowSteps(jobs.get("macos-sign"));
  assert.match(macSteps[0], /not configured yet/);
  for (const name of MAC_SIGNING_SECRETS) assert.match(macSteps[0], new RegExp(`\\b${name}\\b`));
  for (const name of MAC_SIGNING_VARIABLES) assert.match(macSteps[0], new RegExp(`\\b${name}\\b`));
  assert.match(macSteps[0], /exit 1/);
  const windowsSteps = workflowSteps(jobs.get("windows-sign"));
  assert.match(windowsSteps[0], /not configured yet/);
  for (const name of WINDOWS_SIGNING_VARIABLES) assert.match(windowsSteps[0], new RegExp(`\\b${name}\\b`));
  assert.match(windowsSteps[0], /exit 1/);
  for (const steps of [macSteps, windowsSteps]) {
    assert.match(steps[0], /unsigned_run_id must be the numeric run ID/);
    assert.doesNotMatch(steps[0], /uses:/, "the gate is a local check, not an action");
    assert.match(steps[1], /actions\/download-artifact@[0-9a-f]{40}/, "the first action after the gate is the download");
  }
});

test("macOS signing signs, notarizes, staples, verifies, and always removes its keychain", () => {
  const job = workflowJobs(read(".github/workflows/installer-signing.yml")).get("macos-sign");
  const ordered = [
    /security create-keychain/,
    /security import [^\n]*-f pkcs12/,
    /productsign --timestamp/,
    /pkgutil --check-signature/,
    /xcrun notarytool submit[\s\S]*?--wait/,
    /xcrun notarytool log/,
    /xcrun stapler staple/,
    /xcrun stapler validate/,
    /spctl -a -vv -t install/,
    /shasum -a 256/,
  ];
  let cursor = 0;
  for (const pattern of ordered) {
    const found = job.slice(cursor).search(pattern);
    assert.notEqual(found, -1, `${pattern} appears after the previous macOS signing step`);
    cursor += found;
  }
  assert.match(job, /--key-id "\$NOTARY_KEY_ID" --issuer "\$NOTARY_ISSUER_ID"/, "notarization uses an App Store Connect API key");
  assert.match(job, /status" != "Accepted"/, "a rejected submission stops before stapling");
  const cleanup = workflowSteps(job).find((step) => /delete-keychain/.test(step));
  assert.ok(cleanup, "a keychain deletion step exists");
  assert.match(cleanup, /^\s*if: always\(\)$/m, "the keychain is deleted even when signing fails");
  assert.match(cleanup, /notary-key\.p8/);
});

test("Windows signing uses OIDC Artifact Signing with a SHA-256 timestamp and verifies the result", () => {
  const job = workflowJobs(read(".github/workflows/installer-signing.yml")).get("windows-sign");
  const signing = workflowSteps(job).find((step) => /-signing-action@/.test(step));
  assert.ok(signing);
  assert.match(signing, /endpoint: \$\{\{ vars\.ARTIFACT_SIGNING_ENDPOINT \}\}/);
  assert.match(signing, /signing-account-name: \$\{\{ vars\.ARTIFACT_SIGNING_ACCOUNT_NAME \}\}/);
  assert.match(signing, /certificate-profile-name: \$\{\{ vars\.ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME \}\}/);
  assert.match(signing, /^\s+file-digest: SHA256$/m);
  assert.match(signing, /^\s+timestamp-rfc3161: http:\/\/timestamp\.acs\.microsoft\.com$/m);
  assert.match(signing, /^\s+timestamp-digest: SHA256$/m);
  assert.doesNotMatch(job, /client-secret|azure-password|creds:/, "no long-lived Azure credential is accepted");
  assert.match(job, /Get-AuthenticodeSignature/);
  assert.match(job, /Status -ne 'Valid'/);
  assert.match(job, /verify \/pa \/v/);
  assert.match(job, /Get-FileHash -Algorithm SHA256/);
});

test("the unsigned workflow stays free of signing tools, secrets, and the signing environment", () => {
  const workflow = read(".github/workflows/machine-prep-installers.yml");
  assert.doesNotMatch(workflow,
    /notarytool|signtool|productsign|stapler|codesign|id-token|secrets\.|vars\.|environment:|azure\/|signing-action|security import/i);
});

test("the WiX v7 EULA is accepted only after the OSMF decision is confirmed", () => {
  const project = read("machine-prep/installers/windows/FinancialBrainMachinePrep.wixproj");
  assert.match(project,
    /<PropertyGroup Condition="'\$\(WixOsmfConfirmed\)' == 'true'">\s*<AcceptEula>wix7<\/AcceptEula>\s*<\/PropertyGroup>/,
    "the EULA acceptance is conditional on the confirmed decision");
  assert.equal([...project.matchAll(/AcceptEula/g)].length, 2, "there is no unconditional acceptance");
  assert.match(project,
    /<Target Name="RequireWixOsmfDecision" BeforeTargets="BeforeBuild" Condition="'\$\(WixOsmfConfirmed\)' != 'true'">\s*<Error Text="[^"]*Open Source Maintenance Fee/);
  const workflow = read(".github/workflows/machine-prep-installers.yml");
  const jobs = workflowJobs(workflow);
  const windowsSteps = workflowSteps(jobs.get("windows-unsigned"));
  assert.match(windowsSteps[0], /^\s*if: \$\{\{ !inputs\.wix_osmf_confirmed \}\}$/m,
    "an unconfirmed dispatch stops at the first step, before WiX is downloaded");
  assert.match(windowsSteps[0], /Open Source Maintenance Fee/);
  assert.match(windowsSteps[0], /exit 1/);
  const build = windowsSteps.find((step) => /dotnet build/.test(step));
  assert.match(build, /^\s*if: inputs\.wix_osmf_confirmed$/m);
  assert.match(build, /WIX_OSMF_CONFIRMED: \$\{\{ inputs\.wix_osmf_confirmed \}\}/);
  assert.match(build, /-p:WixOsmfConfirmed=true/);
  assert.equal([...workflow.matchAll(/WixOsmfConfirmed=true/g)].length, 1, "only the gated build passes the confirmation");
});

test("the MSI names the planned publisher and the macOS package runs natively on Apple silicon", () => {
  const wix = read("machine-prep/installers/windows/Package.wxs");
  const manufacturers = [...wix.matchAll(/Manufacturer="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(manufacturers, [PLANNED_PUBLISHER]);
  assert.match(read("machine-prep/SIGNING.md"), new RegExp(PLANNED_PUBLISHER));
  const distribution = read("machine-prep/installers/macos/Distribution.xml");
  assert.match(distribution, /<options [^>]*hostArchitectures="arm64,x86_64"/,
    "declaring both architectures stops Installer from asking for Rosetta");
});
