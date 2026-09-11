import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdWhatsnew } from "../brain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const json = (path) => JSON.parse(read(path));

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const manifestTemplate = json("templates/brain.manifest.json");
const changelog = read("CHANGELOG.md");
const readme = read("README.md");
const version = packageJson.version;

assert.match(version, /^\d+\.\d+\.\d+$/, "package version must be a stable semantic version");
assert.equal(packageLock.version, version, "package-lock top-level version drifted");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock root package version drifted");
assert.equal(manifestTemplate.brain?.version, version, "manifest template version drifted");

// The worker carries its own version so health cannot report a number the
// deployed code does not have. That constant is only trustworthy while it
// matches the package, so it is pinned here with everything else.
const workerVersion = read("worker/src/lib/version.js").match(/WORKER_VERSION = "([^"]+)"/)?.[1];
assert.equal(workerVersion, version, "worker source version drifted from the package");
assert.match(changelog, new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m"), "changelog has no current-version heading");

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
assert.match(stableOutput, new RegExp(`public stable release channel confirms this brain is current at ${version.replaceAll(".", "\\.")}`),
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
