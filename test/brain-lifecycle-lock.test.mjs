import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrainLifecycleLockError,
  acquireBrainLifecycleLock,
  clearBrainRecoveryFence,
  readBrainRecoveryFence,
  withBrainLifecycleLock,
  writeBrainRecoveryFence,
} from "../operations/brain-lifecycle-lock.mjs";

function fixture({ machineLockRoot: sharedMachineLockRoot } = {}) {
  const root = mkdtempSync(join(tmpdir(), "daily-lock-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database" } },
  }), { mode: 0o600 });
  return { home, manifestPath, machineLockRoot: sharedMachineLockRoot || join(root, "machine-locks") };
}

test("a canonical Brain recovery fence blocks writers but permits the verified update recovery lane", () => {
  const { home, manifestPath, machineLockRoot } = fixture();
  const transactionId = "a".repeat(32);
  const update = acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "update" });
  writeBrainRecoveryFence({ manifestPath, machineLockRoot, transactionId });
  update.release();
  assert.equal(readBrainRecoveryFence({ manifestPath, machineLockRoot }).transaction_id, transactionId);

  let blocked = 0;
  assert.throws(
    () => acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "load" }),
    (error) => {
      blocked += 1;
      return error instanceof BrainLifecycleLockError && error.code === "brain_lifecycle_recovery_required";
    },
  );
  assert.equal(blocked, 1, "the writer reached the machine-wide recovery decision point");

  const recovery = acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "update" });
  assert.equal(recovery.assertOwned(), true, "the update recovery control reacquired the canonical Brain lease");
  assert.equal(clearBrainRecoveryFence({ manifestPath, machineLockRoot, transactionId }), true);
  recovery.release();
  const control = acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "load" });
  assert.equal(control.assertOwned(), true);
  control.release();
});

test("manifest lifecycle lock excludes update, load, and scheduled refresh", async () => {
  const { home, manifestPath, machineLockRoot } = fixture();
  const first = acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "update" });
  let contentionReached = 0;
  await assert.rejects(
    async () => withBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "daily-refresh" }, async () => {}),
    (error) => {
      contentionReached += 1;
      return error instanceof BrainLifecycleLockError && error.code === "brain_lifecycle_busy";
    },
  );
  assert.equal(contentionReached, 1, "the busy decision point was reached");
  assert.equal(first.assertOwned(), true);
  first.release();

  let ran = 0;
  await withBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "load" }, async ({ assertOwned }) => {
    assert.equal(assertOwned(), true);
    ran += 1;
  });
  assert.equal(ran, 1, "green control acquires after release");
});

test("the lifecycle lock is keyed by Brain identity across manifest aliases and homes", () => {
  const firstFixture = fixture();
  const secondFixture = fixture({ machineLockRoot: firstFixture.machineLockRoot });
  writeFileSync(secondFixture.manifestPath, readFileSync(firstFixture.manifestPath));
  const first = acquireBrainLifecycleLock({
    manifestPath: firstFixture.manifestPath,
    home: firstFixture.home,
    machineLockRoot: firstFixture.machineLockRoot,
    operation: "update",
  });
  let contentionReached = 0;
  assert.throws(
    () => acquireBrainLifecycleLock({
      manifestPath: secondFixture.manifestPath,
      home: secondFixture.home,
      machineLockRoot: secondFixture.machineLockRoot,
      operation: "load",
    }),
    (error) => {
      contentionReached += 1;
      return error?.code === "brain_lifecycle_busy";
    },
  );
  assert.equal(contentionReached, 1, "the copied-manifest cross-user contention decision was reached");
  first.release();

  const otherManifest = JSON.parse(readFileSync(secondFixture.manifestPath, "utf8"));
  otherManifest.infrastructure.cloudflare.d1_database_id = "fixture-other-database";
  writeFileSync(secondFixture.manifestPath, JSON.stringify(otherManifest));
  const other = acquireBrainLifecycleLock({
    manifestPath: secondFixture.manifestPath,
    home: secondFixture.home,
    machineLockRoot: secondFixture.machineLockRoot,
    operation: "load",
  });
  assert.notEqual(first.path, other.path, "a distinct Brain remains an independent green control");
  other.release();
});

test("old empty crash locks recover without adopting unexpected contents", () => {
  const { home, manifestPath, machineLockRoot } = fixture();
  const first = acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "update" });
  const lockPath = first.path;
  first.release();
  mkdirSync(lockPath, { mode: 0o700 });
  const old = new Date("2026-10-06T10:00:00.000Z");
  utimesSync(lockPath, old, old);
  const recovered = acquireBrainLifecycleLock({
    manifestPath,
    home,
    machineLockRoot,
    operation: "load",
    staleMs: 60_000,
    now: () => new Date("2026-10-06T12:00:00.000Z"),
  });
  assert.equal(recovered.assertOwned(), true, "the abandoned empty-directory decision recovered ownership");
  recovered.release();
});

test("a stale owner whose pid was reused cannot block the Brain forever", () => {
  const { home, manifestPath, machineLockRoot } = fixture();
  const first = acquireBrainLifecycleLock({
    manifestPath, home, machineLockRoot, operation: "update", processInstance: () => "old-process-instance",
  });
  const ownerPath = join(first.path, readdirSync(first.path)[0]);
  const old = new Date("2026-10-06T10:00:00.000Z");
  utimesSync(ownerPath, old, old);
  const replacement = acquireBrainLifecycleLock({
    manifestPath,
    home,
    machineLockRoot,
    operation: "load",
    staleMs: 60_000,
    now: () => new Date("2026-10-06T12:00:00.000Z"),
    isOwnerAlive: () => true,
    processInstance: () => "reused-pid-instance",
  });
  assert.equal(replacement.assertOwned(), true, "pid-reuse identity reached the stale recovery decision");
  assert.equal(first.release(), false, "the prior process token cannot release its replacement");
  replacement.release();
});

test("unsafe lifecycle lock contents fail closed instead of being adopted", () => {
  const { home, manifestPath, machineLockRoot } = fixture();
  const first = acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "update" });
  first.release();
  mkdirSync(first.path, { mode: 0o700 });
  writeFileSync(join(first.path, "foreign.txt"), "not an owner receipt", { mode: 0o600 });
  let decisionReached = 0;
  assert.throws(
    () => acquireBrainLifecycleLock({ manifestPath, home, machineLockRoot, operation: "load" }),
    (error) => {
      decisionReached += 1;
      return error instanceof BrainLifecycleLockError && error.code === "brain_lifecycle_unsafe";
    },
  );
  assert.equal(decisionReached, 1);
});
