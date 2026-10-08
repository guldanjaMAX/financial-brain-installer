import assert from "node:assert/strict";
import test from "node:test";

import { fieldRecoveryMsBound } from "./source-inventory-scale-bound.mjs";

test("the recovery liveness ceiling is independent of host scheduling metadata", () => {
  const arms = [
    { name: "ordinary macOS", platform: "darwin", env: {}, expected: 30_000 },
    {
      name: "GitHub-hosted macOS",
      platform: "darwin",
      env: { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
      expected: 30_000,
    },
    {
      name: "hosted macOS runner environment",
      platform: "darwin",
      env: { RUNNER_ENVIRONMENT: "github-hosted" },
      expected: 30_000,
    },
    {
      name: "GitHub-hosted Linux",
      platform: "linux",
      env: {
        GITHUB_ACTIONS: "true",
        RUNNER_OS: "Linux",
        RUNNER_ENVIRONMENT: "github-hosted",
      },
      expected: 30_000,
    },
    {
      name: "self-hosted macOS",
      platform: "darwin",
      env: {
        GITHUB_ACTIONS: "true",
        RUNNER_OS: "macOS",
        RUNNER_ENVIRONMENT: "self-hosted",
      },
      expected: 30_000,
    },
  ];

  let reached = 0;
  const observed = arms.map(({ name, platform, env, expected }) => {
    reached += 1;
    const actual = fieldRecoveryMsBound({ platform, env });
    assert.equal(actual, expected, `${name} selected the wrong recovery bound`);
    return actual;
  });

  assert.equal(reached, arms.length, "every environment arm must reach the decision point");
  assert.deepEqual([...new Set(observed)], [30_000], "host metadata cannot change the work proof");
});


test("recovery liveness tolerates scheduling delays but still rejects a stuck statement", () => {
  const outcomes = [];
  for (const elapsed of [1_000, 8_000, 30_001]) {
    const bound = fieldRecoveryMsBound({ platform: "darwin", env: {} });
    outcomes.push(elapsed < bound);
  }
  assert.equal(outcomes.length, 3, "all completed, delayed, and stuck decisions were reached");
  assert.deepEqual(outcomes, [true, true, false],
    "host scheduling delay must not substitute for a SQL work bound");
});
