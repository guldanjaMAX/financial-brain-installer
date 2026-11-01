import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrainLifecycleLockError,
  acquireBrainLifecycleLock,
  clearBrainRecoveryFence,
  processStartIdentity,
  readBrainRecoveryFence,
  readBrainRecoveryFenceReadOnly,
  withBrainLifecycleLock,
  writeBrainRecoveryFence,
} from "../operations/brain-lifecycle-lock.mjs";
import { restrictWindowsDirectoryToCurrentUser } from "../operations/current-user-file.mjs";

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

test("read-only recovery lookup neither creates nor permission-repairs the shared root", () => {
  const missing = fixture();
  assert.equal(readBrainRecoveryFenceReadOnly(missing), null);
  assert.equal(existsSync(missing.machineLockRoot), false, "a missing root stays missing");
  if (process.platform === "win32") return;

  const existing = fixture();
  mkdirSync(existing.machineLockRoot, { mode: 0o700 });
  chmodSync(existing.machineLockRoot, 0o700);
  let reached = 0;
  assert.throws(() => readBrainRecoveryFenceReadOnly(existing), (error) => {
    reached += 1;
    return error instanceof BrainLifecycleLockError && error.code === "brain_lifecycle_unsafe";
  });
  assert.equal(reached, 1, "the existing-root permission decision was reached");
  assert.equal(statSync(existing.machineLockRoot).mode & 0o7777, 0o700, "read-only lookup did not chmod");
});

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

test("update lock contention names the holder, start time, and retry action", () => {
  const { home, manifestPath, machineLockRoot } = fixture();
  const createdAt = new Date("2026-10-23T12:34:56.000Z");
  const first = acquireBrainLifecycleLock({
    manifestPath,
    home,
    machineLockRoot,
    operation: "ingest",
    now: () => createdAt,
    processInstance: () => "fixture-process-instance",
  });
  let contentionReached = 0;
  assert.throws(
    () => acquireBrainLifecycleLock({
      manifestPath,
      home,
      machineLockRoot,
      operation: "update",
      retryCommand: "the update command",
      now: () => createdAt,
      isOwnerAlive: () => true,
      processInstance: () => "fixture-process-instance",
    }),
    (error) => {
      contentionReached += 1;
      return error?.code === "brain_lifecycle_busy" &&
        /lock is held by ingest since 2026-10-23T12:34:56\.000Z/iu.test(error.message) &&
        /run the update command again/iu.test(error.message);
    },
  );
  assert.equal(contentionReached, 1, "the actionable contention decision point was reached");
  first.release();
});

test("a confirmed dead lock is recovered only after its stale boundary", () => {
  const { home, manifestPath, machineLockRoot } = fixture();
  const first = acquireBrainLifecycleLock({
    manifestPath,
    home,
    machineLockRoot,
    operation: "update",
    now: () => new Date("2026-10-23T12:34:56.000Z"),
    processInstance: () => "dead-process-instance",
  });
  const ownerPath = join(first.path, readdirSync(first.path)[0]);
  const stale = new Date("2026-10-23T12:34:56.000Z");
  utimesSync(ownerPath, stale, stale);
  let livenessChecks = 0;
  const recovered = acquireBrainLifecycleLock({
    manifestPath,
    home,
    machineLockRoot,
    operation: "update",
    staleMs: 60_000,
    now: () => new Date("2026-10-23T12:36:00.000Z"),
    isOwnerAlive: () => { livenessChecks += 1; return false; },
    processInstance: () => null,
  });
  assert.ok(livenessChecks >= 2, "dead ownership was confirmed again before recovery");
  assert.equal(recovered.assertOwned(), true);
  assert.equal(first.release(), false, "the dead owner's nonce cannot release the recovered lock");
  recovered.release();
});

test("Windows process identity uses the native process start time without PATH or inherited secrets", () => {
  let invocation = null;
  const identity = processStartIdentity(4242, {
    platform: "win32",
    environment: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\untrusted",
      ANTHROPIC_API_KEY: "must-not-inherit",
    },
    run: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "638968484960000000\r\n", stderr: "" };
    },
  });
  assert.equal(identity, "win32:638968484960000000");
  assert.match(invocation.command, /\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
  assert.ok(invocation.args.some((arg) => /Get-Process/iu.test(arg)));
  assert.equal(Object.hasOwn(invocation.options.env, "PATH"), false);
  assert.equal(Object.hasOwn(invocation.options.env, "ANTHROPIC_API_KEY"), false);
});

test("POSIX process identity preserves one native ps start token without inherited environment", () => {
  const started = "Fri Oct 23 12:00:00 2026";
  for (const platform of ["darwin", "linux"]) {
    let invocation = null;
    const identity = processStartIdentity(4242, {
      platform,
      environment: { PATH: "/untrusted", ANTHROPIC_API_KEY: "must-not-inherit" },
      run: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: `${started}\n`, stderr: "" };
      },
    });
    assert.equal(identity, `posix:${Date.parse(started)}`);
    assert.equal(invocation.command, "/bin/ps");
    assert.deepEqual(invocation.args, ["-o", "lstart=", "-p", "4242"]);
    assert.deepEqual(invocation.options.env, {});
  }
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

test("Windows lifecycle locks receive a private inheritable ACL before the owner receipt", () => {
  let nativeAclCalls = 0;
  assert.equal(restrictWindowsDirectoryToCurrentUser("C:\\ProgramData\\FinancialBrain\\locks\\fixture", {
    environment: { SystemRoot: "C:\\Windows", USERNAME: "fixture-owner" },
    icaclsPath: "C:\\Windows\\System32\\icacls.exe",
    runAcl(command, args, options) {
      nativeAclCalls += 1;
      assert.equal(command, "C:\\Windows\\System32\\icacls.exe");
      assert.deepEqual(args, [
        "C:\\ProgramData\\FinancialBrain\\locks\\fixture",
        "/inheritance:r",
        "/grant:r",
        "fixture-owner:(OI)(CI)F",
      ]);
      assert.deepEqual(options.env, { SystemRoot: "C:\\Windows", USERNAME: "fixture-owner" });
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  }), true);
  assert.equal(nativeAclCalls, 1, "the inheritable icacls boundary was reached");

  const { home, manifestPath, machineLockRoot } = fixture();
  const aclCalls = [];
  const lock = acquireBrainLifecycleLock({
    manifestPath,
    home,
    machineLockRoot,
    operation: "load",
    platform: "win32",
    restrictWindowsDirectory(path) {
      aclCalls.push({ path, entries: readdirSync(path) });
      return true;
    },
  });
  try {
    assert.equal(lock.assertOwned(), true, "the restricted Windows lock remains usable as a green control");
  } finally {
    lock.release();
  }
  assert.equal(aclCalls.length, 1, "the Windows ACL decision point was reached once");
  assert.equal(aclCalls[0].path, lock.path);
  assert.deepEqual(aclCalls[0].entries, [], "the directory was restricted before its owner receipt was written");

  const refusedFixture = fixture();
  let aclFailureCalls = 0;
  let refusalDecisions = 0;
  assert.throws(
    () => acquireBrainLifecycleLock({
      ...refusedFixture,
      operation: "load",
      platform: "win32",
      restrictWindowsDirectory() {
        aclFailureCalls += 1;
        throw new Error("synthetic ACL refusal");
      },
    }),
    (error) => {
      refusalDecisions += 1;
      return error instanceof BrainLifecycleLockError && error.code === "brain_lifecycle_unsafe";
    },
  );
  assert.equal(aclFailureCalls, 1, "the refusing ACL boundary was attempted");
  assert.equal(refusalDecisions, 1, "the private-lock refusal decision point was reached");

  let recoveryAclCalls = 0;
  const recovered = acquireBrainLifecycleLock({
    ...refusedFixture,
    operation: "load",
    platform: "win32",
    restrictWindowsDirectory() {
      recoveryAclCalls += 1;
      return true;
    },
  });
  assert.equal(recovered.assertOwned(), true, "an ACL-capable retry is the green control");
  assert.equal(recoveryAclCalls, 1);
  recovered.release();
});

test("Windows lifecycle ACL refuses a missing system root before process launch", () => {
  let nativeAclCalls = 0;
  assert.throws(() => restrictWindowsDirectoryToCurrentUser(
    "C:\\ProgramData\\FinancialBrain\\locks\\fixture",
    {
      environment: { USERNAME: "fixture-owner" },
      runAcl: () => {
        nativeAclCalls += 1;
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    },
  ), /system runtime directory/i);
  assert.equal(nativeAclCalls, 0, "the refusal was reached before any PATH-based ACL launch");
});
