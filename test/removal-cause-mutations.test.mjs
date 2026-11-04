import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const [mode, group, markers] of [["good", "gmail", 0], ["f1", "gmail", 2],
  ["good", "microsoft", 0], ["f2", "microsoft", 1]]) {
  test(`removal cause restoring control: ${mode} ${group}`, () => {
    if (process.env.BRAIN_LANE_NODE_WAIT) {
      assert.equal(spawnSync("/bin/sh", ["-c", process.env.BRAIN_LANE_NODE_WAIT]).status, 0);
    }
    const result = spawnSync(process.execPath, ["--import", "./test/fixtures/removal-cause-mutant.mjs",
      "test/removal-cause.test.mjs", group], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_REMOVAL_CAUSE_MUTANT: mode },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.signal, null);
    assert.equal((output.match(/REMOVAL_CAUSE_MUTANT_REACHED:/g) || []).length, markers);
    // Both bad arms must first complete the true-deletion control.
    assert.match(output, new RegExp(`PASS ${group}-deleted:.*planned=1`));
    if (mode === "good") {
      assert.equal(result.status, 0, output);
      assert.match(output, /TOTAL .* safety probes passed/);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(output, /AssertionError/);
      assert.doesNotMatch(output, /TOTAL .* safety probes passed/);
    }
  });
}
