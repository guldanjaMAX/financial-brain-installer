import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const guide = new URL("../operations/cloudflare-subscriptions.mjs", import.meta.url).href;
const doctor = new URL("../doctor.mjs", import.meta.url).href;
const brain = new URL("../brain.mjs", import.meta.url).href;
const skill = new URL("../skills/financial-brain-technician/SKILL.md", import.meta.url).href;
const warning = '  write(`  ${WORKERS_PAID_BUNDLE_WARNING}`);';
const mutants = [
  { id: "M1", target: guide, before: 'plain_name: "Unrecognised subscription", brain_uses: "unknown"',
    after: 'plain_name: "Unrecognised subscription", brain_uses: false', pattern: "Workers Paid is used", count: 1 },
  { id: "M2", target: guide, before: '(typeof r2BucketRequested === "boolean" ? r2BucketRequested : "unknown")',
    after: "false", pattern: "R2 usage follows", count: 1 },
  { id: "M3", target: doctor, before: "checkWorkersPaidPlan(accountId, null)",
    after: "checkWorkersPaidPlan(accountId, cloudflareToken)", pattern: "real doctor machine", count: 1 },
  { id: "M4", target: brain, before: warning, after: "", pattern: "both setup confirmations", count: 2 },
  { id: "M6", target: guide, before: "$5 USD per month minimum", after: "$4 USD per month minimum",
    pattern: "official dated pricing", count: 2 },
  { id: "M7", target: guide, before: '? "the Brain does not use this" : "not sure; ask your installer"',
    after: '? "the Brain does not use this; you may cancel it yourself" : "not sure; ask your installer"',
    pattern: "unused services", count: 1 },
  { id: "M8", target: brain, before: "if (!ownerChecklist || options.subscriptions !== undefined)",
    after: "if (true)", pattern: "the existing owner checklist", count: 1 },
  { id: "M9", target: skill, read: true, suite: "test/technician-setup.test.mjs",
    pattern: "the packaged technician skill leaves headroom", count: 1 },
];

function probe(mutant) {
  // Apply one explicit edit to the module loader's in-memory source. Neither
  // reviewed files nor the shared dependency links are changed by this harness.
  const loader = mutant?.read ? `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      const loaded = original.call(this, path, ...args);
      if (String(path) !== ${JSON.stringify(mutant.target)}) return loaded;
      console.log("MUTATION_APPLIED:" + ${JSON.stringify(mutant.id)});
      return String(loaded) + " ".repeat(800);
    };
    syncBuiltinESMExports();
  ` : mutant ? `
    import { registerHooks } from "node:module";
    import assert from "node:assert/strict";
    const mutant = ${JSON.stringify(mutant)};
    registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url !== mutant.target) return loaded;
      const source = String(loaded.source);
      assert.equal(source.split(mutant.before).length - 1, mutant.count, "mutation decision reached");
      console.log("MUTATION_APPLIED:" + mutant.id);
      return { ...loaded, source: source.replaceAll(mutant.before, mutant.after) };
    }});
  ` : null;
  const args = [
    ...(loader ? ["--import", "data:text/javascript," + encodeURIComponent(loader)] : []),
    "--test", "--test-reporter=tap",
    ...(mutant ? [`--test-name-pattern=${mutant.pattern}`] : []),
    mutant?.suite ?? "test/cf-subscriptions-guide-0434.test.mjs",
  ];
  return spawnSync(process.execPath, args,
    { cwd: root, env: cliTestEnvironment(process.env.HOME), encoding: "utf8", timeout: 60_000 });
}

test("green control passes the unchanged real paths", () => {
  const result = probe(null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 11\b/);
  assert.match(result.stdout, /# fail 0\b/);
});

for (const mutant of mutants) test(`${mutant.id} is killed at its decision point`, () => {
  const result = probe(mutant);
  assert.match(result.stdout, new RegExp(`MUTATION_APPLIED:${mutant.id}`));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /# tests 1\b/);
  assert.match(result.stdout, /# fail 1\b/);
  assert.match(result.stdout, /AssertionError/);
  assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND|TEST_SIDE_EFFECT_BLOCKED/);
});
