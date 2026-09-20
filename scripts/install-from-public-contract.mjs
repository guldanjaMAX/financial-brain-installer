#!/usr/bin/env node
/**
 * Follow the PUBLIC install contract the way a client's agent is told to, and
 * fail on the first thing that does not match.
 *
 * The point is that this reads https://financialbrain.ai/install/agent.md, not
 * the repo. Testing the repo's own idea of the install proves the repo agrees
 * with itself. Every defect that reached a client in the last week reached them
 * through the published surface: the kit whose receipt named the wrong commit,
 * the guide that told a tester to expect a byte count from two releases back.
 * A check that reads the repo cannot see any of those.
 *
 * Steps 3, 4 and 5 of the contract, mechanically:
 *   3. the sole downloadable ZIP matches the declared URL, bytes, sha256, version
 *   4. download it, verify bytes and sha256 BEFORE extraction
 *   5. extract, and verify the inner archive against SHA256SUMS.txt
 *
 * Then the part no automated check has ever done: install that package into a
 * throwaway prefix and confirm the CLI reports the version the contract claims.
 *
 *   usage: node scripts/install-from-public-contract.mjs <workdir> [--guide macos|windows]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNpmCliInvocation,
  buildWindowsBatchInvocation,
  buildWindowsNpmPowerShellInvocation,
  installedBrainPath,
  npmInstallEnvironment,
  parsePublicInstallCommand,
  publicInstallArgumentsFromGuide,
  publicContractChildEnvironment,
  resolveNpmCliPath,
  resolveWindowsNpmCommandPath,
  resolveWindowsPowerShellPath,
} from "../operations/npm-cli-runtime.mjs";
import { readSupervisedInstallContract } from "./check-install-page-version.mjs";

const workdir = resolve(process.argv[2] || "./install-contract-run");
const guideArg = process.argv.includes("--guide")
  ? process.argv[process.argv.indexOf("--guide") + 1] : "windows";
if (!["macos", "windows"].includes(guideArg)) {
  console.error("FAIL  --guide must be macos or windows");
  process.exit(1);
}
const GUIDE = guideArg === "macos"
  ? "https://financialbrain.ai/install/agent-macos.md"
  : "https://financialbrain.ai/install/agent.md";
const FIELD_GUIDE = guideArg === "macos" ? "MACOS-FIELD-TEST.md" : "WINDOWS-FIELD-TEST.md";
const PUBLIC_NPM_HELPER = fileURLToPath(new URL("./invoke-public-npm-install.ps1", import.meta.url));

const die = (m) => { console.error(`FAIL  ${m}`); process.exit(1); };
const ok = (m) => console.log(`PASS  ${m}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Use the same strict parser as the live install/update doorway checker. It
// validates owner presence, exact platform target/status, unique fields, the
// full commit, and a digest-derived bounded artifact URL before downloading it.
const publicContract = await readSupervisedInstallContract({ platform: guideArg });
const {
  artifactBytes,
  artifactSha256: artifactSha,
  candidateVersion: version,
  candidateCommit: commit,
  artifact: zip,
} = publicContract;
ok(`contract read from ${GUIDE}`);
console.log(`      version ${version}  commit ${commit.slice(0, 7)}  ${artifactBytes} bytes`);

if (publicContract.guideUrl !== GUIDE) die("strict contract reader selected the wrong platform guide");
if (zip.length !== artifactBytes) die(`ZIP is ${zip.length} bytes, contract says ${artifactBytes}`);
ok("the published ZIP is the byte count the contract states");
if (sha256(zip) !== artifactSha) die(`ZIP sha256 ${sha256(zip)} != contract ${artifactSha}`);
ok("the published ZIP is the sha256 the contract states");

mkdirSync(workdir, { recursive: true });
const zipPath = join(workdir, "kit.zip");
writeFileSync(zipPath, zip);
const childEnvironment = publicContractChildEnvironment();
execFileSync("unzip", ["-q", "-o", zipPath, "-d", workdir], {
  stdio: "inherit",
  env: childEnvironment,
});
const root = join(workdir, readdirSync(workdir).find((n) => statSync(join(workdir, n)).isDirectory()));
ok(`extracted to ${root.replace(workdir, "<workdir>")}`);

// Step 5: the inner archive against the kit's own receipt, not against ours.
const sums = readFileSync(join(root, "SHA256SUMS.txt"), "utf8").trim();
const [declaredSha, declaredName] = sums.split(/\s+/);
const tgzPath = join(root, declaredName);
const tgz = readFileSync(tgzPath);
if (sha256(tgz) !== declaredSha) die(`${declaredName} does not match the kit's own SHA256SUMS.txt`);
ok(`${declaredName} matches the kit's own SHA256SUMS.txt`);
if (!declaredName.includes(version)) die(`the kit ships ${declaredName} but the contract declares ${version}`);
ok("the packaged archive is the version the contract declares");

// The documents INSIDE the kit, against the package actually shipped beside them.
// This is the defect that reached a client on 2026-09-08: the reseal substituted
// the version string and the package digest and nothing else, so the field guide
// told a tester to expect 5,509,528 bytes for a 5,522,339 byte archive, and the
// receipt named a commit from three releases back. Both documents are the ones a
// person is told to read and compare against. Checked here because this is the
// only place that sees the PUBLISHED kit rather than the repo's idea of it.
const human = tgz.length.toLocaleString("en-US");
const fieldGuides = new Map();
for (const doc of ["WINDOWS-FIELD-TEST.md", "MACOS-FIELD-TEST.md"]) {
  const text = readFileSync(join(root, doc), "utf8");
  fieldGuides.set(doc, text);
  const stated = [...text.matchAll(/[0-9]{1,3}(?:,[0-9]{3})+/g)].map((m) => m[0]);
  const wrong = stated.filter((s) => s !== human);
  if (wrong.length) die(`${doc} states a byte count that is not this package: ${wrong.join(", ")}`);
  if (!text.includes(String(tgz.length))) die(`${doc} never states the real package size`);
}
ok("both field guides state this package's byte count and no other");

const receipt = readFileSync(join(root, "RELEASE-CANDIDATE-RECEIPT.md"), "utf8");
if (!receipt.includes(commit.slice(0, 7))) {
  die(`the receipt does not name the contract's commit ${commit.slice(0, 7)}`);
}
if (!receipt.includes(human)) die(`the receipt does not state this package's ${human} bytes`);
if (!receipt.includes(declaredSha)) die("the receipt does not state this package's sha256");
ok("the receipt names this package's commit, byte count and digest");

const macGuide = readFileSync(join(root, "MACOS-FIELD-TEST.md"), "utf8");
if (!macGuide.includes(`CANDIDATE_COMMIT: ${commit}`)) {
  die("the macOS guide pins a different commit than the public contract");
}
ok("the macOS guide pins the same commit as the public contract");

// The install itself, into a prefix that is thrown away with the runner.
const prefix = join(workdir, "prefix");
mkdirSync(prefix, { recursive: true });
const selectedFieldGuide = fieldGuides.get(FIELD_GUIDE);
const parsedInstall = parsePublicInstallCommand(selectedFieldGuide, {
  guide: guideArg,
  archiveName: declaredName,
});
const installArguments = publicInstallArgumentsFromGuide(selectedFieldGuide, {
  guide: guideArg,
  archiveName: declaredName,
  prefix,
  archive: tgzPath,
});
ok(`${FIELD_GUIDE} carries the exact reviewed npm install command`);
// On Windows, prove the guide's real surface: fixed PowerShell resolves the
// parsed npm.cmd through PATH, verifies it belongs to setup-node's runtime, and
// enters the batch shim with array-preserved arguments. Other hosts keep the
// direct verified npm CLI path; a macOS runner cannot manufacture Windows proof.
const npmCli = resolveNpmCliPath();
if (process.platform === "win32") {
  const contractDirectory = mkdtempSync(join(workdir, "npm-command-"));
  const contractPath = join(contractDirectory, "install.json");
  const npmInstall = buildWindowsNpmPowerShellInvocation({
    executable: parsedInstall.executable,
    args: installArguments,
    expectedCommand: resolveWindowsNpmCommandPath(),
    contractPath,
    helperPath: PUBLIC_NPM_HELPER,
    powershellPath: resolveWindowsPowerShellPath(),
  });
  writeFileSync(contractPath, `${npmInstall.contract}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  execFileSync(npmInstall.command, npmInstall.args, {
    cwd: workdir,
    stdio: "inherit",
    shell: npmInstall.shell,
    env: npmInstallEnvironment(),
  });
} else {
  const npmInstall = buildNpmCliInvocation(npmCli, installArguments);
  execFileSync(npmInstall.command, npmInstall.args,
    { cwd: workdir, stdio: "inherit", shell: npmInstall.shell, env: npmInstallEnvironment() });
}
ok("the packaged archive installs into a clean prefix");

const bin = installedBrainPath(prefix);
const runBrain = (args, options) => {
  if (process.platform !== "win32") return execFileSync(bin, args, { ...options, env: childEnvironment });
  const command = buildWindowsBatchInvocation(
    childEnvironment.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
    bin,
    args,
  );
  return execFileSync(command.command, command.args, {
    ...options,
    env: childEnvironment,
    shell: command.shell,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
};
const readback = runBrain(["--version"], { encoding: "utf8" }).trim();
if (readback !== version) die(`the installed CLI reports ${readback}, the contract declares ${version}`);
ok(`the installed CLI reports ${readback}, matching the contract`);

// doctor EXITS NONZERO on a bare machine, by design: it found blocking problems
// and said so. Reporting is not crashing, and asserting exit 0 here would have
// been a test that fails on correct behaviour. What must hold is that it
// produced its report and did not die on its own imports, which is the same
// contract ci.yml's "doctor reports rather than crashing" step enforces.
let doctorOut = "";
try {
  doctorOut = runBrain(["doctor"], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  doctorOut = `${e.stdout || ""}${e.stderr || ""}`;
}
if (!/Node/.test(doctorOut)) die("doctor produced no report");
if (/cannot find module/i.test(doctorOut)) die("doctor crashed on its own imports");
ok("doctor reports on a machine with no brain rather than crashing");

console.log(`\ninstall contract: every published claim verified on ${process.platform}`);
