import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mutations } from "./fixtures/gmail-finalization-mutant.mjs";

const fixtureSpecifier = (baseUrl) => new URL("./fixtures/gmail-finalization-mutant.mjs", baseUrl).href;
const fixture = fixtureSpecifier(import.meta.url);
const suite = fileURLToPath(new URL("./gmail-finalization.test.mjs", import.meta.url));
const environment = Object.fromEntries([
  "PATH", "SystemRoot", "WINDIR", "HOME", "TMPDIR", "TMP", "TEMP",
].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
environment.BRAIN_NO_WRANGLER_LOGIN = "1";

// Node interprets a drive-letter --import argument as a URL scheme, on every
// host. Keep this exact CI failure distinct from a behavioral mutation failure.
const windowsPath = fileURLToPath(new URL("file:///D:/offline%20suite/test/fixtures/gmail-finalization-mutant.mjs"), { windows: true });
const rejectedImport = spawnSync(process.execPath, ["--import", windowsPath, "--eval", ""], {
  env: environment, encoding: "utf8", timeout: 30_000,
});
assert.equal(rejectedImport.error, undefined);
assert.equal(rejectedImport.signal, null);
assert.notEqual(rejectedImport.status, 0);
assert.match(rejectedImport.stderr, /ERR_UNSUPPORTED_ESM_URL_SCHEME/, "ESM loader decision reached");
assert.match(rejectedImport.stderr, /Received protocol 'd:'/);
console.log("PASS reproduced Windows drive-path import refusal");

for (const baseUrl of [
  "file:///D:/offline%20suite/%23probe/%C3%A9/test/harness.mjs",
  "file:///tmp/offline%20suite/%23probe/%C3%A9/test/harness.mjs",
]) {
  assert.equal(fixtureSpecifier(baseUrl), baseUrl.replace("harness.mjs", "fixtures/gmail-finalization-mutant.mjs"),
    "--import must receive an encoded file URL on Windows and POSIX");
}
console.log("PASS portable mutation import specifiers");

const acceptedImport = spawnSync(process.execPath, ["--import", fixture, "--eval", ""], {
  env: environment, encoding: "utf8", timeout: 30_000,
});
assert.equal(acceptedImport.error, undefined);
assert.equal(acceptedImport.signal, null);
assert.equal(acceptedImport.status, 0, acceptedImport.stdout + acceptedImport.stderr);
console.log("PASS mutation fixture import green control");

const probe = (mutation) => spawnSync(process.execPath, [
  "--test", ...(mutation ? ["--import", fixture] : []), suite,
], {
  env: { ...environment, ...(mutation ? { BRAIN_GMAIL_FINALIZATION_MUTANT: mutation } : {}) },
  encoding: "utf8", timeout: 30_000,
});
const control = probe(null);
assert.equal(control.error, undefined);
assert.equal(control.status, 0, control.stdout + control.stderr);
console.log("PASS finalization mutation green control");
for (const mutation of Object.keys(mutations)) {
  const result = probe(mutation);
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.match(output, new RegExp(`MUTATION_APPLIED ${mutation}\\b`), "mutation decision reached");
  assert.notEqual(result.status, 0, `survived: ${mutation}`);
  assert.match(output, /AssertionError/, `mutation must fail a behavioral assertion: ${mutation}`);
  console.log(`PASS rejected mutation ${mutation}`);
}
console.log(`finalization mutations: ${Object.keys(mutations).length} rejected, one green control`);
