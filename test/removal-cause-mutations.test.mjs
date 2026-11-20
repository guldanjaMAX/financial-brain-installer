import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const [mode, group, markers] of [["good", "gmail", 0], ["f1", "gmail", 1],
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
    // Provider tombstones stay kept for Calendar/Microsoft; Gmail retains an
    // exact nonblocking owner plan. Each mutant must first pass its true control.
    assert.match(output, new RegExp(group === "gmail"
      ? "PASS gmail-deleted:.*planned=1.*apply=0.*outcome=reviewed"
      : "PASS microsoft-deleted:.*planned=0.*apply=0.*outcome=retained"));
    if (mode === "good") {
      assert.equal(result.status, 0, output);
      assert.match(output, /TOTAL .* safety probes passed/);
    } else {
      if (mode === "f1") assert.match(output, /REMOVAL_CAUSE_MUTANT_DECISION/, "unsafe policy removal reached the mutated gate");
      assert.notEqual(result.status, 0);
      assert.match(output, /AssertionError/);
      assert.doesNotMatch(output, /TOTAL .* safety probes passed/);
    }
  });
}
