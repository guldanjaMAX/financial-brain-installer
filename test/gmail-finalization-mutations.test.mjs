import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mutations } from "./fixtures/gmail-finalization-mutant.mjs";

const fixture = fileURLToPath(new URL("./fixtures/gmail-finalization-mutant.mjs", import.meta.url));
const suite = fileURLToPath(new URL("./gmail-finalization.test.mjs", import.meta.url));
const environment = Object.fromEntries([
  "PATH", "SystemRoot", "WINDIR", "HOME", "TMPDIR", "TMP", "TEMP",
].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
environment.BRAIN_NO_WRANGLER_LOGIN = "1";
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
