import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateIncidents, releaseBlockers, runRegressions, regressionEnvironment, verifiedNpmCliPath } from "../scripts/audit-updates.mjs";

const cases = JSON.parse(readFileSync(new URL("../docs/update-incidents.json", import.meta.url), "utf8"));
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
