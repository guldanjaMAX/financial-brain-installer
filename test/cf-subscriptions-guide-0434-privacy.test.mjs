import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const root = new URL("../", import.meta.url);
const privacySource = readFileSync(new URL("test/package-privacy.test.mjs", root), "utf8");
const begin = "const RULES = [";
const end = "const packageJson = ";
assert.equal(privacySource.split(begin).length, 2, "exact matcher start exists once");
assert.equal(privacySource.split(end).length, 2, "exact matcher end exists once");
// Execute the existing gate's unchanged rules, normalizer, matcher and canaries.
// Stop before package/Git inventory: those host operations are outside this lane.
const matcher = runInNewContext(
  privacySource.slice(privacySource.indexOf(begin), privacySource.indexOf(end)) +
    "\n({ scanText, index, canaryFailures, buildIndex, compileRule });",
  { createHash, process: { argv: [] } },
  { timeout: 10_000 },
);
const labels = (text) => [...matcher.scanText(text, matcher.index)];
// A portable mutation must also fail on hosts whose path contains no identity
// from the real denylist. Use the original matcher with one synthetic rule.
const syntheticPath = "/synthetic/fixture-owner-private/MAC-QUIET";
const syntheticIndex = matcher.buildIndex([
  matcher.compileRule("synthetic source path canary", "any", false, syntheticPath),
]);
const pathCanaries = (text) => [...matcher.scanText(text, syntheticIndex)];
const paths = [
  "brain.mjs", "doctor.mjs", "operations/cloudflare-subscriptions.mjs",
  "test/cf-subscriptions-guide-0434.test.mjs",
  "test/cf-subscriptions-guide-0434-mutants.test.mjs",
  "test/cf-subscriptions-guide-0434-privacy.test.mjs",
  "test/cf-subscriptions-guide-0434-portability.test.mjs",
  "test/package-privacy.test.mjs",
  "scripts/run-test-chain.mjs",
  "skills/financial-brain-technician/SKILL.md",
  "onboarding/08-provisioning-prerequisites.md", "CHANGELOG.md",
];

test("the original identity matcher runs all its canaries", () => {
  assert.equal(matcher.canaryFailures.length, 0);
  assert.deepEqual(labels("ordinary role words and synthetic fixtures"), []);
  assert.equal(pathCanaries(JSON.stringify(syntheticPath)).length, 1);
});

test("lane candidate files have no identity matches", () => {
  let scanned = 0;
  for (const path of paths) {
    let source = readFileSync(new URL(path, root), "utf8");
    if (process.env.BRAIN_TEST_SUBSCRIPTION_PATH_LEAK === "1" &&
        path === "test/cf-subscriptions-guide-0434-mutants.test.mjs") {
      const safe = 'fileURLToPath(new URL("../", import.meta.url))';
      assert.equal(source.split(safe).length, 2, "M5 reaches the corrected path decision");
      // Recreate the previous absolute-path leak only in memory, using a
      // synthetic identity so the mutant also works on an unrelated host.
      source = source.replace(safe, JSON.stringify(syntheticPath));
      console.log("MUTATION_APPLIED:M5");
    }
    assert.deepEqual(labels(path), [], `private identity in candidate path: ${path}`);
    assert.deepEqual(labels(source), [], `private identity in candidate text: ${path}`);
    // This rule applies only to the mutant harness; the self-test necessarily
    // declares its synthetic control above. The real denylist scans all files.
    if (path === "test/cf-subscriptions-guide-0434-mutants.test.mjs") {
      assert.deepEqual(pathCanaries(source), [], `private identity in candidate text: ${path}`);
    }
    scanned++;
  }
  assert.equal(scanned, 12, "every declared candidate reaches the real matcher");
});

test("M5 absolute-path leak is killed by the original matcher", () => {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    "--test-name-pattern=lane candidate files", fileURLToPath(import.meta.url),
  ], {
    cwd: fileURLToPath(root),
    env: cliTestEnvironment(process.env.HOME, { BRAIN_TEST_SUBSCRIPTION_PATH_LEAK: "1" }),
    encoding: "utf8", timeout: 60_000,
  });
  assert.match(result.stdout, /MUTATION_APPLIED:M5/);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /private identity in candidate text: test\/cf-subscriptions-guide-0434-mutants\.test\.mjs/);
  assert.match(result.stdout, /# tests 1\b/);
  assert.match(result.stdout, /# fail 1\b/);
  assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND|TEST_SIDE_EFFECT_BLOCKED/);
});
