import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdWhatsnew } from "../brain.mjs";
import { LOCKED_WRANGLER_LOCK_ROOT_VERSION } from "../operations/locked-wrangler-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const json = (path) => JSON.parse(read(path));

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const manifestTemplate = json("templates/brain.manifest.json");
const changelog = read("CHANGELOG.md");
const readme = read("README.md");
const version = packageJson.version;
const escapedVersion = version.replaceAll(".", "\\.");
const currentEvidencePlan = read(`docs/release-evidence/v${version}-candidate-release-evidence-plan.md`);
const retiredEvidencePlan = read("docs/release-evidence/v0.4.7-candidate-release-evidence-plan.md");
const ciWorkflow = read(".github/workflows/ci.yml");
const windowsRehearsalWorkflow = read(".github/workflows/windows-rehearsal.yml");

assert.match(version, /^\d+\.\d+\.\d+$/, "package version must be a stable semantic version");
assert.equal(packageLock.version, version, "package-lock top-level version drifted");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock root package version drifted");
assert.equal(manifestTemplate.brain?.version, version, "manifest template version drifted");
// The locked Wrangler runtime refuses any product lockfile whose root version
// differs from this reviewed constant, so a bump that leaves it behind makes
// field-prepare refuse the tree's own lockfile.
assert.equal(LOCKED_WRANGLER_LOCK_ROOT_VERSION, version,
  "locked Wrangler runtime lockfile root version drifted from the package");

// The worker carries its own version so health cannot report a number the
// deployed code does not have. That constant is only trustworthy while it
// matches the package, so it is pinned here with everything else.
const workerVersion = read("worker/src/lib/version.js").match(/WORKER_VERSION = "([^"]+)"/)?.[1];
assert.equal(workerVersion, version, "worker source version drifted from the package");
assert.match(changelog, new RegExp(`^## ${escapedVersion}$`, "m"), "changelog has no current-version heading");
assert.match(currentEvidencePlan, new RegExp(`^# v${escapedVersion} candidate release evidence plan$`, "m"),
  "current candidate has no version-matched evidence plan");
assert.match(currentEvidencePlan, /Candidate source commit: unbound[\s\S]*?Field execution: none/,
  "the current plan must not imply final-SHA or field proof before either exists");
const ciTestJob = ciWorkflow.slice(
  ciWorkflow.indexOf("  test:"),
  ciWorkflow.indexOf("  preflight-traps:"),
);
const windowsRehearsalTestJob = windowsRehearsalWorkflow.slice(
  windowsRehearsalWorkflow.indexOf("  test:"),
  windowsRehearsalWorkflow.indexOf("  preflight-traps:"),
);
for (const [label, job] of [
  ["main CI", ciTestJob],
  ["Windows rehearsal", windowsRehearsalTestJob],
]) {
  assert.match(job,
    /actions\/checkout@[0-9a-f]+[\s\S]*?ref: \$\{\{ github\.sha \}\}[\s\S]*?fetch-depth: 2[\s\S]*?persist-credentials: false/,
    `${label} must fetch the candidate parent for the evidence-anchor shape check`);
  for (const output of [
    "package_version", "package_bytes", "package_file_count",
  ]) {
    assert.match(job, new RegExp(
      `EXPECTED_PACKAGE_${output.slice("package_".length).toUpperCase()}: \\$\\{\\{ needs\\.package\\.outputs\\.${output} \\}\\}`,
    ), `${label} must consume the producer's ${output} output`);
  }
  for (const [environmentName, output] of [
    ["EXPECTED_RUNTIME_IDENTITY_ARTIFACT_SHA256", "runtime_identity_artifact_sha256"],
    ["EXPECTED_RUNTIME_IDENTITY_ARTIFACT_BYTES", "runtime_identity_artifact_bytes"],
    ["EXPECTED_IDENTITY_SCHEME", "identity_scheme"],
    ["EXPECTED_RUNTIME_PAYLOAD_SHA256", "runtime_payload_sha256"],
  ]) {
    assert.match(job, new RegExp(
      `${environmentName}: \\$\\{\\{ needs\\.package\\.outputs\\.${output} \\}\\}`,
    ), `${label} must consume the producer's ${output} output`);
  }
  for (const name of [
    "FILENAME", "VERSION", "BYTES", "FILE_COUNT", "SHA256",
  ]) {
    assert.match(job, new RegExp(
      `echo "BRAIN_TESTED_PACKAGE_${name}=\\$[^"\\n]+" >> "\\$GITHUB_ENV"`,
    ), `${label} must expose ${name.toLowerCase()} to the evidence-anchor test`);
  }
  assert.match(job,
    /echo "BRAIN_TESTED_RUNTIME_IDENTITY_SCHEME=\$EXPECTED_IDENTITY_SCHEME" >> "\$GITHUB_ENV"/,
    `${label} must expose the runtime identity scheme to the evidence-anchor test`);
  assert.match(job,
    /echo "BRAIN_TESTED_RUNTIME_PAYLOAD_SHA256=\$EXPECTED_RUNTIME_PAYLOAD_SHA256" >> "\$GITHUB_ENV"/,
    `${label} must expose the runtime payload SHA-256 to the evidence-anchor test`);
}
assert.match(retiredEvidencePlan, /Status: superseded planning record; no field execution occurred/,
  "the consumed 0.4.7 planning identity must remain explicitly superseded and unexecuted");
assert.match(retiredEvidencePlan, /Superseded by: \[v0\.4\.8 candidate release evidence plan\]/,
  "the retired candidate must point to the current evidence lineage");

assert.match(readme, new RegExp(
  `This checkout is the unreleased ${escapedVersion} candidate\\.[\\s\\S]*?` +
  `No ${escapedVersion} customer release or\\s+immutable release asset exists\\.[\\s\\S]*?` +
  "intentionally unavailable placeholders[\\s\\S]*?Do not\\s+run or share those commands",
  "i",
), "README must dynamically warn that the current-version candidate URLs are unavailable and must not be shared");
assert.match(readme,
  /earlier held 0\.4\.7 candidate was never[\s\S]*?tagged, published, or offered as a customer update; its identity is retired/i,
  "README must distinguish a retired held candidate identity from a public release");

const releaseLinks = [...readme.matchAll(
  /releases\/download\/v(\d+\.\d+\.\d+)\/brain-installer-(\d+\.\d+\.\d+)\.tgz/g,
)];
assert.ok(releaseLinks.length >= 2, "README must show the pinned POSIX and Windows release commands");
for (const [, tagVersion, assetVersion] of releaseLinks) {
  assert.equal(tagVersion, version, "README release tag version drifted");
  assert.equal(assetVersion, version, "README release asset version drifted");
}

async function whatsnewStatusOutput(readStatus, options = {}) {
  const manifestPath = Object.prototype.hasOwnProperty.call(options, "manifestPath")
    ? options.manifestPath
    : resolve(ROOT, "templates/brain.manifest.json");
  const { discoverManifest } = options;
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(" "));
  try {
    await cmdWhatsnew(manifestPath, { readStatus, discoverManifest });
  } finally {
    console.log = originalLog;
  }
  return output.join("\n").split("# What's new")[0];
}

let checkedInstalledVersion = null;
const heldOutput = await whatsnewStatusOutput(async ({ installedVersion }) => {
  checkedInstalledVersion = installedVersion;
  return { status: "release_held", installed_version: installedVersion };
});
assert.equal(checkedInstalledVersion, version, "whatsnew did not check the manifest's installed version");
assert.match(heldOutput, /public release channel is held/i,
  "whatsnew must name a held public channel");
assert.doesNotMatch(heldOutput, /up to date/i,
  "a held public channel cannot be reported as up to date");

const unavailableOutput = await whatsnewStatusOutput(async () => ({ status: "unavailable" }));
assert.match(unavailableOutput, /Unavailable is not current/i,
  "an unavailable release check must not become current");
assert.doesNotMatch(unavailableOutput, /up to date/i,
  "an unavailable release check cannot be reported as up to date");

const stableOutput = await whatsnewStatusOutput(async () => ({
  status: "up_to_date", latest_version: version,
}));
assert.match(stableOutput, new RegExp(`public stable release channel confirms this brain is current at ${escapedVersion}`),
  "only exact stable-channel evidence may call the installed version current");

let discoveredWithoutArgument = false;
let noArgumentCheckedVersion = null;
const noArgumentOutput = await whatsnewStatusOutput(async ({ installedVersion }) => {
  noArgumentCheckedVersion = installedVersion;
  return { status: "release_held", installed_version: installedVersion };
}, {
  manifestPath: undefined,
  discoverManifest: (explicitPath) => {
    assert.equal(explicitPath, undefined, "the documented no-argument path must use install discovery");
    discoveredWithoutArgument = true;
    return { path: resolve(ROOT, "templates/brain.manifest.json"), source: "remembered" };
  },
});
assert.equal(discoveredWithoutArgument, true,
  "brain whatsnew without a manifest argument did not discover the installed Brain");
assert.equal(noArgumentCheckedVersion, version,
  "brain whatsnew without a manifest argument did not check the discovered installed version");
assert.match(noArgumentOutput, /public release channel is held/i,
  "the documented no-argument path must report the public release state");
assert.doesNotMatch(noArgumentOutput, /up to date/i,
  "the documented no-argument path cannot call a held release up to date");

let checkedWithoutManifest = false;
const missingManifestOutput = await whatsnewStatusOutput(async () => {
  checkedWithoutManifest = true;
  return { status: "up_to_date", latest_version: version };
}, {
  manifestPath: undefined,
  discoverManifest: () => null,
});
assert.equal(checkedWithoutManifest, false,
  "whatsnew cannot query release status without an installed version to compare");
assert.match(missingManifestOutput, /no installed Brain manifest could be read/i,
  "whatsnew must explain why no current-version claim can be made");

console.log(`current version alignment: package, lockfile, template, changelog, and ${releaseLinks.length} install links all use ${version}`);
