import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const [control, pattern, failures] of [
  ["good", "1 of 1269|stays held|receipt, owner|Drive .*approval line", 0],
  ["never-apply", "1 of 1269", 2],
  ["always-apply", "stays held", 9],
  ["omit-receipt", "receipt, owner", 1],
  ["ignore-failure", "receipt, owner", 2],
  ["immediate-exit", "Drive CLI held review", 1],
  ["startup-refusal", "Drive CLI held review", 1],
  ["omit-approval", "Drive held review", 3],
]) {
  test(`real load discrimination: ${control}`, () => {
    if (process.env.BRAIN_LANE_NODE_WAIT) {
      const quiet = spawnSync("/bin/sh", ["-c", process.env.BRAIN_LANE_NODE_WAIT], { encoding: "utf8" });
      assert.equal(quiet.status, 0);
    }
    const result = spawnSync(process.execPath, ["--import", "./test/fixtures/small-removal-control.mjs",
      "--test", `--test-name-pattern=${pattern}`, "test/load-small-removals.test.mjs"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_SMALL_REMOVAL_CONTROL: control,
        ...(process.env.BRAIN_LANE_NODE_WAIT ? { BRAIN_LANE_NODE_WAIT: process.env.BRAIN_LANE_NODE_WAIT } : {}) },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.signal, null);
    assert.match(output, /(?:tests |# tests )\d+/u, "the real test suite reached its decisions");
    assert.equal(Number(output.match(/(?:ℹ |# )fail (\d+)/u)?.[1]), failures,
      "every selected decision must discriminate, including each held-plan case");
    if (control === "good") {
      assert.equal(result.status, 0, output);
      assert.match(output, /(?:fail |# fail )0\b/u);
    } else {
      assert.notEqual(result.status, 0, "a known-bad implementation must fail");
      assert.match(output, /(?:fail |# fail )[1-9]/u);
      assert.match(output, /AssertionError|TypeError/u, "the bad control failed a behavioral assertion");
      if (control === "immediate-exit") {
        assert.match(output, /Drive held review lost its exact approval line before stdout drained/u,
          "the restoring control must reach the saved plan and fail the exact output assertion");
        assert.doesNotMatch(output, /Drive CLI did not write review evidence/u);
      }
      if (control === "startup-refusal") {
        assert.match(output, /Drive CLI did not write review evidence: status=23, signal=null, error=none/u);
        assert.match(output, /stderr:[\s\S]*SMALL_REMOVAL_STARTUP_REFUSAL/u,
          "missing evidence must retain the child's stderr and exit status");
      }
    }
  });
}
