import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrainLifecycleLockError,
  acquireBrainLifecycleLock,
  withBrainLifecycleLock,
} from "../operations/brain-lifecycle-lock.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "daily-lock-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, "{}\n", { mode: 0o600 });
  return { home, manifestPath };
}

test("manifest lifecycle lock excludes update, load, and scheduled refresh", async () => {
  const { home, manifestPath } = fixture();
  const first = acquireBrainLifecycleLock({ manifestPath, home, operation: "update" });
  let contentionReached = 0;
  await assert.rejects(
    async () => withBrainLifecycleLock({ manifestPath, home, operation: "daily-refresh" }, async () => {}),
    (error) => {
      contentionReached += 1;
      return error instanceof BrainLifecycleLockError && error.code === "brain_lifecycle_busy";
    },
  );
  assert.equal(contentionReached, 1, "the busy decision point was reached");
  assert.equal(first.assertOwned(), true);
  first.release();

  let ran = 0;
  await withBrainLifecycleLock({ manifestPath, home, operation: "load" }, async ({ assertOwned }) => {
    assert.equal(assertOwned(), true);
    ran += 1;
  });
  assert.equal(ran, 1, "green control acquires after release");
});

test("unsafe lifecycle lock contents fail closed instead of being adopted", () => {
  const { home, manifestPath } = fixture();
  const first = acquireBrainLifecycleLock({ manifestPath, home, operation: "update" });
  first.release();
  mkdirSync(first.path, { mode: 0o700 });
  writeFileSync(join(first.path, "foreign.txt"), "not an owner receipt", { mode: 0o600 });
  let decisionReached = 0;
  assert.throws(
    () => acquireBrainLifecycleLock({ manifestPath, home, operation: "load" }),
    (error) => {
      decisionReached += 1;
      return error instanceof BrainLifecycleLockError && error.code === "brain_lifecycle_unsafe";
    },
  );
  assert.equal(decisionReached, 1);
});

