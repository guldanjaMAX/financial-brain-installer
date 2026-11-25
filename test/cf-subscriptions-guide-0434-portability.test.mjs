import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cases = [
  { suite: "mutants", pattern: "green control|M1 is killed", mutantPattern: "green control",
    passes: 2, id: "R1-MUTANT-SHELL" },
  { suite: "privacy", pattern: ".", mutantPattern: "M5 absolute-path leak",
    passes: 3, id: "R1-PRIVACY-SHELL" },
];

function probe(row, mutate = false) {
  const target = new URL(`./cf-subscriptions-guide-0434-${row.suite}.test.mjs`, import.meta.url);
  // Model native Windows' missing POSIX tools at the actual child boundary.
  // Only Node may execute; its arguments, environment and assertions stay real.
  const preload = `
    import assert from "node:assert/strict";
    import cp from "node:child_process";
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    const original = cp.spawnSync;
    cp.spawnSync = function(command, ...args) {
      console.log("R1_SPAWN_DECISION:" + (command === process.execPath ? "node" : "external"));
      if (command !== process.execPath) {
        console.log("R1_MISSING_EXECUTABLE:ENOENT");
        return { status: null, signal: null, stdout: "", stderr: "",
          error: Object.assign(new Error("fixture executable unavailable"), { code: "ENOENT" }) };
      }
      assert.equal(args[1].env.BRAIN_NO_WRANGLER_LOGIN, "1");
      assert.equal(args[1].env.HOME, process.env.HOME);
      return original.call(this, command, ...args);
    };
    syncBuiltinESMExports();
    ${mutate ? `registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url !== ${JSON.stringify(target.href)}) return loaded;
      const source = String(loaded.source);
      const before = "spawnSync(process.execPath,";
      assert.equal(source.split(before).length - 1, 1, "R1 mutation decision reached");
      console.log(${JSON.stringify(`MUTATION_APPLIED:${row.id}`)});
      return { ...loaded, source: source.replace(before, 'spawnSync("/bin/sh",') };
    }});` : ""}
  `;
  return spawnSync(process.execPath, [
    "--import", "data:text/javascript," + encodeURIComponent(preload),
    "--test", "--test-reporter=tap",
    `--test-name-pattern=${mutate ? row.mutantPattern : row.pattern}`, fileURLToPath(target),
  ], { cwd: root, env: cliTestEnvironment(process.env.HOME), encoding: "utf8", timeout: 60_000 });
}

for (const row of cases) {
  test(`R1 ${row.suite} runs its controls and mutation without POSIX tools`, () => {
    const result = probe(row);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /R1_SPAWN_DECISION:/, "the real spawn decision was reached");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /R1_SPAWN_DECISION:node/);
    assert.doesNotMatch(result.stdout, /R1_SPAWN_DECISION:external/);
    assert.match(result.stdout, new RegExp(`# pass ${row.passes}\\b`));
    assert.match(result.stdout, /# fail 0\b/);
    assert.match(result.stdout, /M[15] is killed|M5 absolute-path leak.*ok|ok.*M5 absolute-path leak/);
  });

  test(`${row.id} is killed at the real spawn decision`, () => {
    const result = probe(row, true);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, new RegExp(`MUTATION_APPLIED:${row.id}`));
    assert.match(result.stdout, /R1_SPAWN_DECISION:external/);
    assert.match(result.stdout, /R1_MISSING_EXECUTABLE:ENOENT/);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 1\b/);
    assert.match(result.stdout, /# fail 1\b/);
    assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND|TEST_SIDE_EFFECT_BLOCKED/);
  });
}
