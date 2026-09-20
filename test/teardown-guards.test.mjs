/**
 * Compatibility checks for the retired teardown script.
 *
 * Destructive A13-A16 behavior is covered by
 * disposable-recovery-field-teardown.test.mjs. This file proves the former
 * name-only and --v048-campaign entry points cannot become a second operator
 * path beside that broker.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEGACY_GENERIC_TEARDOWN_QUARANTINED,
  V048_DISPOSABLE_TEARDOWN_NAMES,
  looksDisposable,
  parseV048DisposableTeardownCliArguments,
  parseV048TeardownLifecycleQuiescenceCliArguments,
  protectedListMissing,
  runV048DisposableCampaignTeardown,
  teardownDecision,
} from "../scripts/teardown-test-brain.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/teardown-test-brain.mjs", import.meta.url),
);
const RETIRED_CODE = "V048_TEARDOWN_LEGACY_PATH_RETIRED";
const BROKER_HELP = "brain-v048-disposable-teardown help";

test("legacy names remain anchored but can no longer authorize a mutation", () => {
  assert.equal(LEGACY_GENERIC_TEARDOWN_QUARANTINED, true);
  assert.equal(looksDisposable("brain-test-run-1"), true);
  assert.equal(looksDisposable("my-production-testbed"), false);
  assert.equal(looksDisposable(V048_DISPOSABLE_TEARDOWN_NAMES.source), false);
  assert.equal(looksDisposable(V048_DISPOSABLE_TEARDOWN_NAMES.target), false);
  assert.equal(protectedListMissing(""), true);
  assert.equal(protectedListMissing("owner-live-brain"), false);
  assert.deepEqual(teardownDecision("brain-test-run-1", {
    protectedRaw: "owner-live-brain,client-production",
  }), {
    allowed: false,
    reason: "legacy_path_retired",
  });
});

test("imported legacy parser and runner stop before inspecting caller input", async () => {
  const unreadable = new Proxy({}, {
    get() {
      assert.fail("retired input was inspected");
    },
    ownKeys() {
      assert.fail("retired input was inspected");
    },
  });
  assert.throws(
    () => parseV048DisposableTeardownCliArguments(unreadable),
    (error) => error?.code === RETIRED_CODE && error?.message.includes(BROKER_HELP),
  );
  assert.throws(
    () => parseV048TeardownLifecycleQuiescenceCliArguments(unreadable),
    (error) => error?.code === RETIRED_CODE && error?.message.includes(BROKER_HELP),
  );
  await assert.rejects(
    runV048DisposableCampaignTeardown(unreadable, unreadable),
    (error) => error?.code === RETIRED_CODE && error?.message.includes(BROKER_HELP),
  );
});

test("every historical direct CLI form fails closed with only the fixed broker direction", async (t) => {
  const forms = [
    ["--name", "private-brain-test", "--commit"],
    ["--v048-campaign", "--role", "source", "--commit"],
    ["--v048-campaign", "--role", "target", "--commit"],
    ["derive-lifecycle-quiescence", "--source-manifest-sha256", "private-hash"],
  ];
  for (const argv of forms) {
    await t.test(argv[0] === "derive-lifecycle-quiescence" ? argv[0] : argv.join(" "), () => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, ...argv], {
        cwd: "/",
        env: Object.freeze({}),
        encoding: "utf8",
        shell: false,
        timeout: 5_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(RETIRED_CODE, "u"));
      assert.match(result.stderr, new RegExp(BROKER_HELP, "u"));
      assert.equal(result.stderr.includes("private-brain-test"), false);
      assert.equal(result.stderr.includes("private-hash"), false);
    });
  }
});

test("retired script contains no provider, token, or delete implementation", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  for (const forbidden of [
    "createCloudflareDisposableDeploymentTransport",
    "loadStoredCloudflareToken",
    "deleteWorker",
    "deleteVectorizeIndex",
    "deleteD1Database",
    'method: "DELETE"',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
