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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const workdir = resolve(process.argv[2] || "./install-contract-run");
const guideArg = process.argv.includes("--guide")
  ? process.argv[process.argv.indexOf("--guide") + 1] : "windows";
const GUIDE = guideArg === "macos"
  ? "https://financialbrain.ai/install/agent-macos.md"
  : "https://financialbrain.ai/install/agent.md";

const die = (m) => { console.error(`FAIL  ${m}`); process.exit(1); };
const ok = (m) => console.log(`PASS  ${m}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function get(url, asText = false) {
  const r = await fetch(url, { headers: { "user-agent": "brain-install-matrix", "cache-control": "no-cache" } });
  if (!r.ok) die(`${url} returned ${r.status}`);
  return asText ? r.text() : Buffer.from(await r.arrayBuffer());
}

const guide = await get(GUIDE, true);
// The contract's own header block. Parsed, never assumed: a missing field is a
// failure, because the client's agent would be reading the same absent line.
const field = (name) => {
  const m = guide.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  if (!m) die(`the public install contract has no ${name}`);
  return m[1].trim();
};
const artifactUrl = field("ARTIFACT_URL");
const artifactBytes = Number(field("ARTIFACT_BYTES"));
const artifactSha = field("ARTIFACT_SHA256");
const version = field("CANDIDATE_VERSION");
const commit = field("CANDIDATE_COMMIT");
ok(`contract read from ${GUIDE}`);
console.log(`      version ${version}  commit ${commit.slice(0, 7)}  ${artifactBytes} bytes`);

const zip = await get(artifactUrl);
if (zip.length !== artifactBytes) die(`ZIP is ${zip.length} bytes, contract says ${artifactBytes}`);
ok("the published ZIP is the byte count the contract states");
if (sha256(zip) !== artifactSha) die(`ZIP sha256 ${sha256(zip)} != contract ${artifactSha}`);
ok("the published ZIP is the sha256 the contract states");

mkdirSync(workdir, { recursive: true });
const zipPath = join(workdir, "kit.zip");
writeFileSync(zipPath, zip);
execFileSync("unzip", ["-q", "-o", zipPath, "-d", workdir], { stdio: "inherit" });
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
for (const doc of ["WINDOWS-FIELD-TEST.md", "MACOS-FIELD-TEST.md"]) {
  const text = readFileSync(join(root, doc), "utf8");
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
// npm on Windows is npm.cmd. execFileSync does not apply PATHEXT, so the bare
// name is ENOENT there and nowhere else: this passed on three runners and failed
// only on the one the client actually uses. Exactly the Windows-only class this
// job exists to catch, found on its first real run, in the job itself.
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
// The GUIDE's form, not a convenient one. `npm install --prefix` is a LOCAL
// install and lands the command under <prefix>/node_modules/.bin; the guide
// tells the client `--global --prefix`, which lands it at <prefix>/bin and is
// the directory their PATH has to contain. Installing the other way here tests
// a layout no client ever produces.
execFileSync(npmCmd, ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
  "--prefix", prefix, tgzPath],
  { stdio: "inherit", env: { ...process.env, npm_config_yes: "true" } });
ok("the packaged archive installs the way the guide tells a client to");

// The trap that cost two people about two hours each, and it is a string
// comparison rather than a provisioning step. The guide says install with
// `--prefix <somewhere>`, but npm's own configured prefix is usually elsewhere,
// so `brain` is not on PATH afterwards and the reader gets `command not found`
// with a correct install sitting on disk.
//
// This does NOT install into the prefix the guide names: on a real operator's
// Mac that path holds their live CLI.
const guideName = GUIDE.includes("macos") ? "MACOS-FIELD-TEST.md" : "WINDOWS-FIELD-TEST.md";
const guideText = readFileSync(join(root, guideName), "utf8");
const declaredPrefix = guideText.match(/--prefix\s+"?([^"\s`]+)"?/)?.[1];
if (!declaredPrefix) die(`${guideName} names no install prefix, so a reader cannot follow it`);
ok(`the guide installs with --prefix ${declaredPrefix}`);

const layoutBin = process.platform === "win32" ? prefix : join(prefix, "bin");
const binName = process.platform === "win32" ? "brain.cmd" : "brain";
if (!existsSync(join(layoutBin, binName))) {
  die(`npm did not put ${binName} where a --global --prefix install implies (${layoutBin})`);
}
ok("npm puts the command where the guide's install form implies");

const reconcilesPath = /\bPATH\b/.test(guideText) ||
  new RegExp(`${declaredPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\/](bin[\\/])?brain`).test(guideText);
if (!reconcilesPath) {
  die(`${guideName} names an install prefix but never reconciles it with PATH, so following it verbatim ends in \`command not found\``);
}
ok("the guide reconciles that prefix with PATH, so the reader can actually run it");

const bin = join(layoutBin, binName);
const readback = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
if (readback !== version) die(`the installed CLI reports ${readback}, the contract declares ${version}`);
ok(`the installed CLI reports ${readback}, matching the contract`);

// doctor EXITS NONZERO on a bare machine, by design: it found blocking problems
// and said so. Reporting is not crashing, and asserting exit 0 here would have
// been a test that fails on correct behaviour. What must hold is that it
// produced its report and did not die on its own imports, which is the same
// contract ci.yml's "doctor reports rather than crashing" step enforces.
let doctorOut = "";
try {
  doctorOut = execFileSync(bin, ["doctor"], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  doctorOut = `${e.stdout || ""}${e.stderr || ""}`;
}
if (!/Node/.test(doctorOut)) die("doctor produced no report");
if (/cannot find module/i.test(doctorOut)) die("doctor crashed on its own imports");
ok("doctor reports on a machine with no brain rather than crashing");

console.log(`\ninstall contract: every published claim verified on ${process.platform}`);
