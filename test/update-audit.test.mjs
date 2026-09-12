import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateIncidents, releaseBlockers, releaseAdjudication, runRegressions, regressionEnvironment,
  verifiedNpmCliPath, assertUndeferrableRegistered, assertEvidenceDocuments, UNDEFERRABLE_INCIDENTS,
  DEFERRAL_CAUSES, assertSourceInventoryV3ReleaseVersion,
  SOURCE_INVENTORY_V3_MINIMUM_PACKAGE_VERSION, REGRESSION_TIMEOUT_MS } from "../scripts/audit-updates.mjs";

const cases = JSON.parse(readFileSync(new URL("../docs/update-incidents.json", import.meta.url), "utf8"));
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
assert.equal(SOURCE_INVENTORY_V3_MINIMUM_PACKAGE_VERSION, "0.4.8");
assert.equal(REGRESSION_TIMEOUT_MS, 600_000,
  "slow supported runners need headroom without removing the finite per-command hang bound");
assert.equal(assertSourceInventoryV3ReleaseVersion(packageVersion), packageVersion,
  "the held candidate must use a non-colliding source-inventory identity");
assert.throws(() => assertSourceInventoryV3ReleaseVersion("0.4.6"), /already-live package 0\.4\.6/);
assert.throws(() => assertSourceInventoryV3ReleaseVersion("0.4.5"), /package version must be 0\.4\.8 or newer/);
assert.throws(() => assertSourceInventoryV3ReleaseVersion("0.4.7"),
  /retired held candidate identity 0\.4\.7; that candidate was never public or live.*0\.4\.8 or newer/,
  "changed bytes must not reuse the prior held candidate's evidence identity");
assert.equal(assertSourceInventoryV3ReleaseVersion("0.4.8"), "0.4.8");
assert.equal(assertSourceInventoryV3ReleaseVersion("0.5.0"), "0.5.0");
const auditSource = readFileSync(new URL("../scripts/audit-updates.mjs", import.meta.url), "utf8");
assert.match(auditSource, /if \(mode === "--release"\) assertSourceInventoryV3ReleaseVersion\(version\)/,
  "the package-version reuse guard must run in the enforcing release mode");
validateIncidents(cases);
assert.ok(cases.some((c) => c.id === "UPDATE-002"), "the frozen-fence incident must not disappear from the registry");
for (let n = 17; n <= 22; n++) {
  assert.ok(cases.some((c) => c.id === `UPDATE-${String(n).padStart(3, "0")}`),
    "Plaid configuration, money, account boundaries and owner acceptance remain release gates");
}
for (const id of ["UPDATE-023", "UPDATE-024"]) {
  assert.ok(cases.some((c) => c.id === id), "Windows credential and owner scope regressions must retain a release gate");
}
for (const id of ["UPDATE-025", "UPDATE-026"]) {
  assert.ok(cases.some((c) => c.id === id),
    "bank freshness honesty and verified-package Windows evidence must retain a release gate");
}
const findings = new Set(cases.flatMap((c) => c.findings));
for (const id of [...Array.from({ length: 16 }, (_, i) => `F${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `N${i + 1}`)]) {
  assert.ok(findings.has(id), `original audit finding ${id} must retain an adjudication`);
}
for (const id of ["PLAID-READY-WINDOW-FRESHNESS", "PLAID-REFRESH-DEBT-SCHEDULED-RETRYABLE",
  "WINDOWS-NPM-CHAIN-LENGTH", "WINDOWS-PACKAGE-BARRIER", "WINDOWS-NODE22-INSTALL-TIMEOUT"]) {
  assert.ok(findings.has(id), `0.4.0 audit finding ${id} must retain an adjudication`);
}
const fixture = { id: "UPDATE-999", title: "fixture", acceptance: "fixture proof", scopes: ["upgrade"], status: "open", tests: ["test/fixture.mjs"] };
assert.throws(() => validateIncidents([], () => true), /empty/);
assert.throws(() => validateIncidents([fixture, fixture], () => true), /duplicate/);
assert.throws(() => validateIncidents([{ ...fixture, status: "verified" }], () => true), /evidence/);
assert.throws(() => validateIncidents([{ ...fixture, tests: ["test/../../private.mjs"] }], () => true), /unsafe/);
assert.doesNotThrow(() => validateIncidents([{ ...fixture, tests: ["frontend/test/browser/owner-upload.browser.mjs"] }], () => true));
assert.throws(() => validateIncidents([{ ...fixture, tests: ["frontend/src/private.mjs"] }], () => true), /unsafe/);
assert.throws(() => validateIncidents([{ ...fixture, tests: ["frontend/test/browser/../private.browser.mjs"] }], () => true), /unsafe/);
assert.throws(() => validateIncidents([fixture], () => false), /missing/);
assert.equal(releaseBlockers([{ ...fixture, status: "local-only" }]).length, 1);
assert.equal(releaseBlockers([{ ...fixture, status: "verified", evidence: ["docs/fixture.md"] }]).length, 0);

// ---------------------------------------------------------------------------
// VERSION-SCOPED DEFERRAL. Six constraints, each pinned here, because the
// failure mode this mechanism has to survive is someone quietly widening it to
// turn a red gate green.
const deferral = {
  version: packageVersion,
  blocked_on: "physical_hardware_unavailable",
  reason: "Fixture reason long enough to be reviewable prose rather than a bare identifier, naming a physical blocker that no amount of hosted CI can remove.",
  unproven: "Fixture statement of exactly what ships without field proof.",
};
const deferred = { ...fixture, deferral };

// CONSTRAINT 5: the safe direction is the default. A newly added incident with
// no deferral blocks, and so does a valid deferral when no version is supplied.
assert.equal(releaseBlockers([{ ...fixture, status: "open" }], packageVersion).length, 1,
  "a new incident must block until someone deliberately defers it");
assert.equal(releaseBlockers([deferred]).length, 1,
  "with no version supplied no deferral is honoured; an older gate can never be unblocked by a newer registry");
assert.equal(releaseBlockers([deferred], packageVersion).length, 0);

// CONSTRAINT 3: deferred incidents stay visible, labelled, never dropped.
const adjudication = releaseAdjudication([deferred, { ...fixture, id: "UPDATE-998" }], packageVersion);
assert.equal(adjudication.held.length, 1);
assert.deepEqual(adjudication.deferred.map((i) => i.id), ["UPDATE-999"],
  "a deferred incident must be reported, not filtered out of the output");

// CONSTRAINT 1: scope expires. It is tied to package.json and disagreement FAILS.
assert.throws(() => validateIncidents([{ ...deferred, deferral: { ...deferral, version: "0.9.9" } }], () => true, packageVersion),
  /deferral names 0\.9\.9 but package\.json is/, "a deferral for another version must fail, not silently carry");
assert.equal(releaseBlockers([{ ...deferred, deferral: { ...deferral, version: "0.9.9" } }], packageVersion).length, 1,
  "a deferral naming another version must not suppress the blocker either");
assert.throws(() => validateIncidents([{ ...deferred, deferral: { ...deferral, version: "0.4" } }], () => true),
  /exact release version/);

// CONSTRAINT 2: every deferral carries a written reason and a reviewed cause.
assert.throws(() => validateIncidents([{ ...deferred, deferral: { version: packageVersion, blocked_on: deferral.blocked_on, unproven: deferral.unproven } }], () => true),
  /written reason/, "a bare list of ids is not reviewable");
assert.throws(() => validateIncidents([{ ...deferred, deferral: { ...deferral, reason: "hardware" } }], () => true), /written reason/);
assert.throws(() => validateIncidents([{ ...deferred, deferral: { ...deferral, unproven: "later" } }], () => true), /ships unproven/);
assert.throws(() => validateIncidents([{ ...deferred, deferral: { ...deferral, blocked_on: "we_ran_out_of_time" } }], () => true),
  /reviewed cause/, "the cause enum is closed; there is no value meaning no time or low risk");
assert.ok(!DEFERRAL_CAUSES.has("we_ran_out_of_time") && !DEFERRAL_CAUSES.has("low_risk"),
  "every deferral cause must name a reason the evidence CANNOT YET EXIST");
// A mistyped `versoin` must not degrade into "no expiry".
assert.throws(() => validateIncidents([{ ...deferred, deferral: { ...deferral, versoin: "0.9.9" } }], () => true), /unknown deferral field/);
assert.equal(releaseBlockers([{ ...deferred, deferral: { ...deferral, versoin: "0.9.9" } }], packageVersion).length, 1);
assert.throws(() => validateIncidents([{ ...deferred, deferral: "UPDATE-999" }], () => true), /deferral must be an object/);

// CONSTRAINT 4: a deferral that no longer describes reality FAILS rather than
// being ignored, mirroring evaluateStrictRelease's stale-disposition handling.
// Because a deferral lives on the row it excuses it cannot name a missing id,
// so the stale classes that remain are a wrong version (above) and this one.
assert.throws(() => validateIncidents([{ ...deferred, status: "verified", evidence: ["docs/fixture.md"] }], () => true),
  /must not carry a deferral/, "evidence arrived and the excuse was left behind");

// CONSTRAINT 6: some incidents are undeferrable, and the set is pinned here so
// that widening it takes a reviewed change to two files with a stated reason.
assert.deepEqual(UNDEFERRABLE_INCIDENTS, ["UPDATE-010", "UPDATE-014", "UPDATE-026"],
  "UPDATE-010 governs what gets published, UPDATE-026 governs whether the published bytes are the tested bytes, " +
  "and UPDATE-014 governs whether a brain reports its own versions honestly. Deferring any of them defers the " +
  "ability to trust every other deferral and every receipt, so a release may never scope them out.");
assert.throws(() => validateIncidents([{ ...deferred, id: "UPDATE-010" }], () => true),
  /cannot be deferred/, "an undeferrable id carrying a deferral must fail the audit");
assert.equal(releaseBlockers([{ ...deferred, id: "UPDATE-014" }], packageVersion).length, 1,
  "an undeferrable incident blocks even when a deferral is present and otherwise well formed");
assert.throws(() => assertUndeferrableRegistered([fixture]), /missing from the registry/,
  "deleting an undeferrable incident must not silently empty its own protection");
assert.doesNotThrow(() => assertUndeferrableRegistered(cases));

// THE OTHER WAY OUT. `verified` is the second route past the gate and it used
// to be the cheap one: one word plus any existing path. Both of these exited 0
// with every incident "closed", including the three that may never be deferred.
assert.throws(() => validateIncidents([{ ...fixture, status: "verified", evidence: ["test/update-audit.test.mjs"] }], () => true),
  /evidence must be a reviewed document under docs\//,
  "a local test can never be the field evidence for a gate whose own receipt says local tests are not proof");
for (const rulebook of ["docs/RELEASE-GATE.md", "docs/UPDATE-AUDIT.md", "docs/PLAID-RELEASE-GATE.md",
  "docs/MAINTAINER.md", "docs/update-incidents.json", "docs/decisions/004-version-scoped-release-scope.md"]) {
  assert.throws(() => validateIncidents([{ ...fixture, status: "verified", evidence: [rulebook] }], () => true),
    /defines the gate and cannot be evidence/,
    `${rulebook} states what must be proven, so it cannot record that it was proven`);
  assert.throws(() => validateIncidents([{ ...fixture, id: "UPDATE-010", status: "verified", evidence: [rulebook] }], () => true),
    /defines the gate and cannot be evidence/, "an undeferrable incident must not be closable by citing the rulebook");
}
assert.doesNotThrow(() => validateIncidents([{ ...fixture, status: "verified", evidence: ["docs/fixture.md"] }], () => true),
  "a reviewed evidence document under docs/ still closes an incident");

// An evidence path that exists proved nothing about what is in the file. The
// document must name its own incident and carry a tested package digest, which
// is what docs/UPDATE-AUDIT.md step 8 has always required in prose.
const digest = "a".repeat(64);
const goodEvidence = { ...fixture, status: "verified", evidence: ["docs/fixture.md"] };
assert.doesNotThrow(() => assertEvidenceDocuments([goodEvidence], () => `UPDATE-999 closed at sha256 ${digest}`));
assert.throws(() => assertEvidenceDocuments([goodEvidence], () => `an unrelated architecture document, sha256 ${digest}`),
  /never names UPDATE-999/, "an existing docs file that was never about this incident must not close it");
assert.throws(() => assertEvidenceDocuments([goodEvidence], () => "UPDATE-999 was fine, trust me"),
  /no tested package SHA-256/);
assert.throws(() => assertEvidenceDocuments([goodEvidence], () => { throw new Error("gone"); }), /could not be read/);
assert.doesNotThrow(() => assertEvidenceDocuments([fixture], () => { throw new Error("must not read anything"); }),
  "an incident with no evidence reads no files");
assertEvidenceDocuments(cases);

// CONSTRAINT 3, second half: a `verified` row must not vanish from the receipt
// either. Whichever way an incident stops blocking, it is named in the output.
const closedFixture = { ...fixture, id: "UPDATE-997", status: "verified", evidence: ["docs/fixture.md"] };
const threeWay = releaseAdjudication([deferred, { ...fixture, id: "UPDATE-998" }, closedFixture], packageVersion);
assert.deepEqual(threeWay.closed.map((i) => i.id), ["UPDATE-997"], "a verified incident must be reported with its evidence, not silently dropped");
assert.equal(threeWay.held.length + threeWay.deferred.length + threeWay.closed.length, 3, "every incident lands in exactly one printed bucket");

// CONSTRAINT 6, second half: the protection is bound to an ID, so pin what
// those three IDs actually say. Hollowing out an acceptance text while keeping
// its number would leave the set nominally intact and mean nothing. Changing a
// digest here is the reviewed moment to ask whether the set still holds.
for (const [id, digest] of [["UPDATE-010", "078fe99b6913fe02"], ["UPDATE-014", "bbd5f637e0c7ef61"], ["UPDATE-026", "54b7e12566f46302"]]) {
  const item = cases.find((i) => i.id === id);
  assert.equal(createHash("sha256").update(item.acceptance, "utf8").digest("hex").slice(0, 16), digest,
    `${id} is undeferrable because of what its acceptance says; re-review the undeferrable set before changing that text`);
}

// The declared 0.4.0 scope itself, checked against the live registry.
validateIncidents(cases, undefined, packageVersion);
for (const item of cases.filter((i) => i.deferral)) {
  assert.equal(item.deferral.version, packageVersion, `${item.id} defers for a version nobody is cutting`);
  assert.ok(!UNDEFERRABLE_INCIDENTS.includes(item.id));
}
assert.ok(releaseBlockers(cases, packageVersion).length > 0,
  "0.4.0 still has real blockers; scoping the gate must not be mistaken for clearing it");
const calls = [];
const results = runRegressions([{ tests: ["test/first.mjs", "test/second.mjs", "test/first.mjs"] }], (path) => {
  calls.push(path);
  return { status: path.includes("first") ? 1 : 0 };
});
assert.equal(calls.length, 2, "failure must not skip the next independent test; shared tests run once");
assert.deepEqual(results.map((r) => r.passed), [false, true]);
assert.equal(runRegressions([{ tests: ["test/fixture.mjs"] }], () => ({ status: null, signal: "SIGTERM" }))[0].passed, false);
assert.equal(runRegressions([{ tests: ["test/fixture.mjs"], testPlatform: "win32" }], () => { throw new Error("must not run on this host"); }, "darwin")[0].skipped, true);
assert.equal(runRegressions([{ tests: ["test/fixture.mjs"] }], () => ({ status: 0, error: new Error("synthetic timeout") }))[0].passed, false);
assert.deepEqual(regressionEnvironment({ PATH: "/synthetic-bin", CLOUDFLARE_API_TOKEN: "fixture", UNRELATED_PRIVATE_VALUE: "fixture" }), { PATH: "/synthetic-bin" });
const windowsRuntime = { USERNAME: "fixture", USERDOMAIN: "LOCAL", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\fixture", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
assert.deepEqual(regressionEnvironment({ ...windowsRuntime, NPM_TOKEN: "fixture" }), windowsRuntime);
const npmFixture = mkdtempSync(join(tmpdir(), "brain-audit-npm-"));
try {
  mkdirSync(join(npmFixture, "bin"));
  const cli = join(npmFixture, "bin", "npm-cli.js");
  writeFileSync(cli, "// fixture only; never executed\n");
  writeFileSync(join(npmFixture, "package.json"), JSON.stringify({ name: "npm", version: "11.0.0" }));
  assert.equal(verifiedNpmCliPath(cli), realpathSync(cli));
  assert.deepEqual(regressionEnvironment({ npm_execpath: cli, NPM_TOKEN: "fixture" }), { npm_execpath: realpathSync(cli) });
  assert.equal(verifiedNpmCliPath(join(npmFixture, "missing.js")), null);
  assert.equal(verifiedNpmCliPath(join(npmFixture, "bin")), null);
  writeFileSync(join(npmFixture, "package.json"), JSON.stringify({ name: "other", version: "11.0.0" }));
  assert.deepEqual(regressionEnvironment({ npm_execpath: cli }), {});
  writeFileSync(join(npmFixture, "package.json"), JSON.stringify({ name: "npm", version: "11.0.0invalid" }));
  assert.equal(verifiedNpmCliPath(cli), null);
} finally { rmSync(npmFixture, { recursive: true, force: true }); }

const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.ok(release.indexOf("node scripts/audit-updates.mjs --release") < release.indexOf("- name: require immutable releases"));
assert.match(release, /run: node scripts\/audit-updates\.mjs --release/);
console.log("update audit: incomplete evidence blocks release, all regression commands retain their own exit status");
