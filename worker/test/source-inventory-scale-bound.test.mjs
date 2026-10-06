import assert from "node:assert/strict";
import test from "node:test";

import { fieldRecoveryMsBound } from "./source-inventory-scale-bound.mjs";

test("the recovery liveness bound changes only for hosted macOS CI", () => {
  const arms = [
    { name: "ordinary macOS", platform: "darwin", env: {}, expected: 3_000 },
    {
      name: "GitHub-hosted macOS",
      platform: "darwin",
      env: { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
      expected: 5_000,
    },
    {
      name: "hosted macOS runner environment",
      platform: "darwin",
      env: { RUNNER_ENVIRONMENT: "github-hosted" },
      expected: 5_000,
    },
    {
      name: "GitHub-hosted Linux",
      platform: "linux",
      env: {
        GITHUB_ACTIONS: "true",
        RUNNER_OS: "Linux",
        RUNNER_ENVIRONMENT: "github-hosted",
      },
      expected: 3_000,
    },
    {
      name: "self-hosted macOS",
      platform: "darwin",
      env: {
        GITHUB_ACTIONS: "true",
        RUNNER_OS: "macOS",
        RUNNER_ENVIRONMENT: "self-hosted",
      },
      expected: 3_000,
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
  assert.deepEqual([...new Set(observed)].sort(), [3_000, 5_000], "the arms must not be uniform");
});
