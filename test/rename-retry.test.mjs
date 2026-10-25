import assert from "node:assert/strict";
import fs, { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { renameWithRetry, renameWithRetrySync } from "../operations/rename-retry.mjs";
import * as renameHelpers from "../operations/rename-retry.mjs";
import { rewriteStagingInPlace, STAGING_MTIME_SECONDS } from "./fixtures/rename-retry-staging.mjs";

const fault = code => Object.assign(new Error("synthetic rename failure"), { code });
const source = "staged";
const destination = "destination";

test("identity proof accepts the original file and expected absence, and refuses replacement", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "proof.json");
  const other = join(root, "other.json");
  const absent = renameHelpers.captureRenameIdentity(path);
  assert.equal(absent, null);
  assert.equal(renameHelpers.renameIdentityMatches(path, absent), true);
  writeFileSync(path, "first");
  const identity = renameHelpers.captureRenameIdentity(path);
  assert.equal(renameHelpers.renameIdentityMatches(path, identity), true);
  assert.equal(renameHelpers.renameIdentityMatches(path, absent), false);
  writeFileSync(other, "other");
  renameSync(other, path);
  assert.equal(renameHelpers.renameIdentityMatches(path, identity), false);
  assert.equal(renameHelpers.renameIdentityMatches(other, identity), false);
});

test("identity proof rejects metadata drift, unsafe types, and unreadable observations", () => {
  const identity = {
    dev: 1, ino: 2, nlink: 1, size: 3, mtimeMs: 4, ctimeMs: 5, mode: 0o100600,
    isFile: () => true, isSymbolicLink: () => false,
  };
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => identity }), true);
  for (const field of ["dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs", "mode"]) {
    assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => ({ ...identity, [field]: identity[field] + 1 }) }), false, field);
  }
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => ({ ...identity, isFile: () => false }) }), false);
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => ({ ...identity, isSymbolicLink: () => true }) }), false);
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => { throw fault("EACCES"); } }), false);
  assert.equal(renameHelpers.renameIdentityMatches(source, null, { lstat: () => { throw fault("EACCES"); } }), false);
  const unreadable = fault("EACCES");
  assert.throws(() => renameHelpers.captureRenameIdentity(source, { lstat: () => { throw unreadable; } }), error => error === unreadable);
});

test("byte proof checks bounded exact bytes even when every identity observation is unchanged", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-bytes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const intended = Buffer.from("intended bytes");
  writeFileSync(path, intended);
  const identity = lstatSync(path, { bigint: true });
  for (const [label, bytes, accepted] of [
    ["unchanged", intended, true],
    ["staging-in-place", intended.map(byte => byte ^ 0xff), false],
    ["shorter", intended.subarray(1), false],
    ["longer", Buffer.concat([intended, Buffer.from("x")]), false],
  ]) {
    writeFileSync(path, bytes);
    let opened = 0, closed = 0, read = 0;
    const io = {
      lstatSync: () => identity, fstatSync: () => identity,
      openSync(...args) { opened++; return fs.openSync(...args); },
      closeSync(fd) { closed++; return fs.closeSync(fd); },
      readSync(fd, buffer, offset, length, position) {
        // Deliberate short reads exercise the bounded loop, not readFileSync.
        const count = fs.readSync(fd, buffer, offset, Math.min(length, 3), position);
        read += count;
        return count;
      },
    };
    assert.equal(renameHelpers.stagedBytesMatch(path, identity, intended, { fs: io }), accepted, label);
    assert.equal(opened, 1, label);
    assert.equal(closed, opened, label);
    assert.ok(read <= intended.length + 1, "the descriptor read is bounded by intended bytes plus one EOF byte");
  }
});

test("staged proof refuses descriptor or pathname drift and close failures", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-bracket-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const intended = Buffer.from("intended bytes");
  writeFileSync(path, intended);
  const identity = lstatSync(path, { bigint: true });
  const changed = { ...identity, ino: identity.ino + 1n };
  // Spreading a Stats object does not carry prototype predicates.
  changed.isFile = () => true;
  changed.isSymbolicLink = () => false;
  for (const mode of ["control", "first-path", "first-descriptor", "last-descriptor", "last-path", "close"]) {
    let pathChecks = 0, descriptorChecks = 0, opened = 0, closed = 0;
    const io = {
      lstatSync() {
        pathChecks++;
        return (mode === "first-path" && pathChecks === 1) || (mode === "last-path" && pathChecks === 2) ? changed : identity;
      },
      fstatSync() {
        descriptorChecks++;
        return (mode === "first-descriptor" && descriptorChecks === 1) || (mode === "last-descriptor" && descriptorChecks === 2) ? changed : identity;
      },
      openSync(...args) { opened++; return fs.openSync(...args); },
      closeSync(fd) { closed++; fs.closeSync(fd); if (mode === "close") throw fault("EIO"); },
    };
    assert.equal(renameHelpers.stagedBytesMatch(path, identity, intended, { fs: io }), mode === "control", mode);
    assert.ok(closed >= opened, `every opened descriptor is closed: ${mode}`);
  }
});

test("byte proof bounds requested reads even when frozen metadata hides a much larger file", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-read-bound-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const intended = Buffer.from("intended bytes");
  writeFileSync(path, intended);
  const expected = lstatSync(path, { bigint: true });
  for (const extra of [0, 64 * 1024]) {
    writeFileSync(path, Buffer.concat([intended, Buffer.alloc(extra)]));
    let requested = 0;
    const matches = renameHelpers.stagedBytesMatch(path, expected, intended, { fs: {
      lstatSync: () => expected, fstatSync: () => expected,
      readSync(fd, buffer, offset, length, position) {
        requested += length;
        return fs.readSync(fd, buffer, offset, length, position);
      },
    } });
    assert.equal(matches, extra === 0);
    assert.ok(requested <= intended.length + 1, "requested bytes, including EOF, must stay bounded");
  }
});

test("staged proof and removal refuse mixed stat kinds and unsafe link counts", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-kind-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  writeFileSync(path, "bytes");
  const ordinary = lstatSync(path);
  const large = lstatSync(path, { bigint: true });
  assert.equal(renameHelpers.sameRenameIdentity(ordinary, large), false);
  assert.equal(renameHelpers.sameRenameIdentity(large, ordinary), false);
  assert.equal(renameHelpers.sameRenameIdentity(large, large), true);
  assert.equal(renameHelpers.stagedBytesMatch(path, large, Buffer.from("bytes")), true);
  assert.equal(renameHelpers.stagedBytesMatch(path, large, Buffer.from("bytes"), { fs: { lstatSync: () => ordinary } }), false);
  assert.equal(renameHelpers.removeOwnedStaging(path, large, { fs: { lstatSync: () => ordinary } }), false);
  const linked = { ...large, nlink: 2n, isFile: () => true, isSymbolicLink: () => false };
  assert.equal(renameHelpers.stagedBytesMatch(path, linked, Buffer.from("bytes")), false);
  assert.equal(renameHelpers.removeOwnedStaging(path, large, { fs: { lstatSync: () => linked } }), false);
  assert.equal(readFileSync(path, "utf8"), "bytes");
});

test("owned cleanup removes only its original exclusive-create inode and never masks a primary error", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const descriptor = openSync(path, "wx", 0o600);
  const created = fstatSync(descriptor, { bigint: true });
  writeFileSync(descriptor, "same bytes");
  closeSync(descriptor);
  const primary = fault("EPERM");
  assert.throws(() => {
    try { throw primary; }
    finally {
      assert.equal(renameHelpers.removeOwnedStaging(path, created, { fs: { unlinkSync() { throw fault("EIO"); } } }), false);
    }
  }, error => error === primary);
  renameSync(path, `${path}.displaced`);
  writeFileSync(path, "same bytes");
  const replacement = lstatSync(path, { bigint: true });
  assert.notEqual(replacement.ino, created.ino);
  assert.equal(renameHelpers.removeOwnedStaging(path, created), false);
  assert.equal(lstatSync(path, { bigint: true }).ino, replacement.ino);
  assert.equal(readFileSync(path, "utf8"), "same bytes");
  assert.equal(renameHelpers.removeOwnedStaging(`${path}.displaced`, created), true);
  assert.equal(renameHelpers.removeOwnedStaging(`${path}.displaced`, created), false);
  assert.equal(renameHelpers.removeOwnedStaging(root, created), false);
  assert.equal(renameHelpers.removeOwnedStaging(path, null), false);
});

test("capture staged proof binds post-close bytes to the original exclusive-create inode", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-capture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const bytes = Buffer.from("staged bytes");
  const descriptor = openSync(path, "wx", 0o600);
  const created = fstatSync(descriptor, { bigint: true });
  writeFileSync(descriptor, bytes);
  closeSync(descriptor);
  const proof = renameHelpers.captureStagedProof(path, bytes, created);
  assert.ok(proof);
  assert.equal(typeof proof.ino, "bigint");
  assert.ok(Object.isFrozen(proof));
  assert.equal(renameHelpers.stagedBytesMatch(path, proof, bytes), true);
  assert.equal(renameHelpers.captureStagedProof(path, Buffer.from("wrong bytes"), created), null);
  renameSync(path, `${path}.displaced`);
  writeFileSync(path, bytes);
  assert.equal(renameHelpers.captureStagedProof(path, bytes, created), null);
});

test("change-time-only drift preserves staged bytes but still refuses metadata-only identity proof", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-ctime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const bytes = Buffer.from("staged bytes");
  writeFileSync(path, bytes);
  utimesSync(path, STAGING_MTIME_SECONDS, STAGING_MTIME_SECONDS);
  const before = lstatSync(path, { bigint: true });
  assert.equal(renameHelpers.stagedBytesMatch(path, before, bytes), true);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  fs.chmodSync(path, 0o400);
  fs.chmodSync(path, Number(before.mode & 0o777n));
  const after = lstatSync(path, { bigint: true });
  for (const key of ["dev", "ino", "nlink", "size", "mtimeNs", "mode"]) {
    assert.equal(after[key], before[key], `ctime-only fixture must preserve ${key}`);
  }
  assert.notEqual(after.ctimeNs, before.ctimeNs, "ctime-only fixture must actually move change time");
  assert.equal(renameHelpers.sameRenameIdentity(after, before), false);
  assert.equal(renameHelpers.renameIdentityMatches(path, before), false);
  assert.equal(renameHelpers.stagedBytesMatch(path, before, bytes), true);
});

for (const acl of [false, true]) {
  test(`native Windows ACL before baseline ${acl ? "delayed change time still publishes" : "unchanged control publishes"}`, {
    skip: process.platform !== "win32", timeout: 15_000,
  }, async t => {
    const root = mkdtempSync(join(tmpdir(), "brain-rename-acl-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bytes = Buffer.from("synthetic staged bytes");
    let sid;
    const systemRoot = process.env.SystemRoot;
    const options = { windowsHide: true, encoding: "utf8", env: { SystemRoot: systemRoot } };
    let observedDelayedChange = !acl;
    if (acl) {
      assert.ok(systemRoot, "native ACL test requires SystemRoot");
      const identity = spawnSync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], options);
      assert.equal(identity.status, 0, "native identity lookup must succeed");
      sid = identity.stdout.match(/S-1-[0-9-]+/)?.[0];
      assert.ok(sid, "native identity lookup must return a SID");
    }
    const samples = [];
    // Multiple independent files cover hosts that coalesce ACL timestamp work.
    // Each proof is pinned immediately; none is captured after a settling wait.
    for (let index = 0; index < (acl ? 16 : 1); index++) {
      const path = join(root, `staged-${index}`);
      const target = join(root, `target-${index}`);
      const fd = openSync(path, "wx", 0o600);
      const created = fstatSync(fd, { bigint: true });
      fs.fsyncSync(fd);
      closeSync(fd);
      if (acl) {
        const applied = spawnSync(join(systemRoot, "System32", "icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`], options);
        assert.equal(applied.status, 0, "native owner ACL must be applied before the baseline");
      }
      const secured = openSync(path, "r+");
      writeFileSync(secured, bytes);
      fs.fsyncSync(secured);
      closeSync(secured);
      const proof = renameHelpers.captureStagedProof(path, bytes, created);
      assert.ok(proof, "baseline immediately after native ACL must capture the owned file");
      samples.push({ path, target, proof });
    }
    if (acl) {
      // Poll only after the baseline and never replace it. Waiting before the
      // baseline would hide the delayed NTFS change-time defect being tested.
      const deadline = Date.now() + 3_000;
      const drifted = () => samples.some(({ path, proof }) => lstatSync(path, { bigint: true }).ctimeNs !== proof.ctimeNs);
      while (!drifted() && Date.now() < deadline) await delay(10);
      observedDelayedChange = drifted();
    }
    for (const { path, target, proof } of samples) {
      renameWithRetrySync(path, target, {
        revalidate() { assert.equal(renameHelpers.renameIdentityMatches(target, null), true); },
        staged: { expected: proof, bytes, refuse() { assert.fail("native ACL drift must not refuse the owned bytes"); } },
      });
      assert.deepEqual(readFileSync(target), bytes);
    }
    if (!observedDelayedChange) {
      // Some Windows identities/volumes complete the timestamp update before
      // the baseline. Publication still ran, but this host observation cannot
      // claim coverage of the delayed-change regression on this invocation.
      t.skip("no delayed ACL change time observed in 16 files within the bounded poll");
    }
  });
}

test("POSIX chmod after baseline preserves staged publication", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-chmod-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const target = join(root, "target");
  const bytes = Buffer.from("synthetic staged bytes");
  writeFileSync(path, bytes, { mode: 0o600 });
  const proof = renameHelpers.captureStagedProof(path, bytes, lstatSync(path, { bigint: true }));
  assert.ok(proof);
  assert.equal(renameHelpers.stagedBytesMatch(path, proof, bytes), true, "unchanged passing control");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  fs.chmodSync(path, 0o400);
  fs.chmodSync(path, 0o600);
  assert.notEqual(lstatSync(path, { bigint: true }).ctimeNs, proof.ctimeNs);
  renameWithRetrySync(path, target, {
    revalidate() { assert.equal(renameHelpers.renameIdentityMatches(target, null), true); },
    staged: { expected: proof, bytes, refuse() { assert.fail("chmod must not refuse unchanged owned bytes"); } },
  });
  assert.deepEqual(readFileSync(target), bytes);
});

test("owned cleanup refuses symlinks and preserves their targets", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const target = join(root, "target");
  writeFileSync(target, "target bytes");
  const identity = lstatSync(target, { bigint: true });
  try { fs.symlinkSync(target, path); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows symlink creation requires host support"); return; }
    throw error;
  }
  assert.equal(renameHelpers.removeOwnedStaging(path, identity), false);
  assert.ok(lstatSync(path).isSymbolicLink());
  assert.equal(readFileSync(target, "utf8"), "target bytes");
});

test("owned cleanup confirms disappearance and preserves exact-byte rollback replacements", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-remove-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const bytes = Buffer.from("staged bytes");
  writeFileSync(path, bytes);
  const identity = lstatSync(path, { bigint: true });
  assert.equal(renameHelpers.removeOwnedStaging(path, identity, { fs: { unlinkSync() {} } }), false);
  assert.equal(renameHelpers.removeOwnedStaging(path, identity, { proof: identity, bytes: Buffer.from("wrong bytes!") }), false);
  assert.equal(readFileSync(path, "utf8"), "staged bytes");
  assert.equal(renameHelpers.removeOwnedStaging(path, identity, { proof: identity, bytes }), true);
});

test("owned cleanup distinguishes omitted proof from an explicitly refused rollback proof", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-null-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const bytes = Buffer.from("staged bytes");
  writeFileSync(path, bytes);
  const first = lstatSync(path, { bigint: true });
  assert.equal(renameHelpers.removeOwnedStaging(path, first), true, "ordinary owned staging cleanup needs only creation identity");
  writeFileSync(path, bytes);
  const current = lstatSync(path, { bigint: true });
  assert.equal(renameHelpers.removeOwnedStaging(path, current, { proof: null, bytes }), false,
    "a refused post-publication proof cannot authorize rollback deletion");
  assert.equal(lstatSync(path, { bigint: true }).ino, current.ino);
  assert.deepEqual(readFileSync(path), bytes);
});

test("injected filesystem initialization failure never masks the caller error or escapes proof refusal", t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-io-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "staged");
  const bytes = Buffer.from("staged bytes");
  writeFileSync(path, bytes);
  const identity = lstatSync(path, { bigint: true });
  assert.equal(renameHelpers.stagedBytesMatch(path, identity, bytes), true);
  assert.ok(renameHelpers.captureStagedProof(path, bytes, identity));
  const brokenFs = Object.defineProperty({}, "lstatSync", { enumerable: true,
    get() { throw fault("EIO"); },
  });
  const primary = fault("EPERM");
  assert.throws(() => {
    try { throw primary; }
    finally { assert.equal(renameHelpers.removeOwnedStaging(path, identity, { fs: brokenFs }), false); }
  }, error => error === primary);
  assert.equal(renameHelpers.stagedBytesMatch(path, identity, bytes, { fs: brokenFs }), false);
  assert.equal(renameHelpers.captureStagedProof(path, bytes, identity, { fs: brokenFs }), null);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(renameHelpers.removeOwnedStaging(path, identity), true);
});

for (const [mode, replace] of [["sync", renameWithRetrySync], ["async", renameWithRetry]]) {
  const run = async options => await replace(source, destination, { platform: "win32", revalidate() {}, ...options });

  test(`${mode}: uncontended rename runs once without backoff`, async () => {
    const calls = [];
    const result = replace(source, destination, {
      revalidate() {},
      rename(from, to) { calls.push([from, to]); },
      sleep() { assert.fail("uncontended rename must not sleep"); },
    });
    if (mode === "sync") assert.equal(result, undefined, "synchronous callers must remain synchronous");
    else assert.ok(result instanceof Promise, "asynchronous callers receive a promise");
    assert.equal(await result, undefined);
    assert.deepEqual(calls, [[source, destination]]);
  });

  test(`${mode}: default dependencies publish a complete staged file`, async t => {
    const root = mkdtempSync(join(tmpdir(), "brain-rename-helper-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const staged = join(root, "staged.json");
    const target = join(root, "target.json");
    writeFileSync(target, '{"generation":1}', { mode: 0o600 });
    writeFileSync(staged, '{"generation":2}', { mode: 0o600 });
    await replace(staged, target, { revalidate() {} });
    assert.equal(readFileSync(target, "utf8"), '{"generation":2}');
    assert.deepEqual(readdirSync(root), ["target.json"]);
  });

  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    test(`${mode}: ${code} recovers after three refusals`, async () => {
      const events = [];
      let calls = 0;
      await run({
        rename(from, to) {
          assert.equal(from, source);
          assert.equal(to, destination);
          events.push("rename");
          if (++calls <= 3) throw fault(code);
        },
        sleep(ms) { events.push(ms); },
      });
      assert.equal(calls, 4);
      assert.deepEqual(events, ["rename", 225, "rename", 225, "rename", 225, "rename"]);
    });

    test(`${mode}: ${code} stops after ten attempts with the exact last error`, async () => {
      const errors = Array.from({ length: 10 }, () => fault(code));
      const waits = [];
      let calls = 0;
      await assert.rejects(run({
        rename() {
          calls++;
          // An unbounded retry mutant fails this check instead of hanging CI.
          assert.ok(calls <= 10, "rename attempts must be bounded");
          throw errors[calls - 1];
        },
        sleep(ms) { waits.push(ms); },
      }), error => error === errors[9]);
      assert.equal(calls, 10);
      assert.deepEqual(waits, Array(9).fill(225), "do not wait after the final refusal");
    });
  }

  test(`${mode}: the tenth rename may still succeed`, async () => {
    let calls = 0;
    const waits = [];
    await run({
      rename() { if (++calls < 10) throw fault("EPERM"); },
      sleep(ms) { waits.push(ms); },
    });
    assert.equal(calls, 10);
    assert.deepEqual(waits, Array(9).fill(225));
  });

  for (const code of ["ENOENT", "ENOSPC", "EIO", undefined]) {
    test(`${mode}: ${code ?? "uncoded error"} fails immediately`, async () => {
      const original = fault(code);
      let calls = 0;
      let waits = 0;
      await assert.rejects(run({
        rename() { calls++; throw original; },
        sleep() { waits++; },
      }), error => error === original);
      assert.equal(calls, 1);
      assert.equal(waits, 0);
    });
  }

  test(`${mode}: backoff errors are not retried`, async () => {
    const original = fault("EPERM");
    let calls = 0;
    let waits = 0;
    await assert.rejects(run({
      rename() { calls++; throw fault("EBUSY"); },
      sleep() { waits++; throw original; },
    }), error => error === original);
    assert.equal(calls, 1);
    assert.equal(waits, 1);
  });

  for (const platform of ["win32", "darwin", "linux"]) {
    test(`${mode}: ${platform} gates EPERM retries and waits`, async () => {
      const refusal = fault("EPERM");
      const events = [];
      let calls = 0;
      const result = run({
        platform,
        revalidate() { events.push("validate"); },
        rename() { events.push("rename"); if (++calls === 1) throw refusal; },
        sleep(ms) { events.push(ms); },
      });
      if (platform === "win32") {
        await result;
        assert.equal(calls, 2);
        assert.deepEqual(events, ["validate", "rename", 225, "validate", "rename"]);
      } else {
        await assert.rejects(result, error => error === refusal);
        assert.equal(calls, 1);
        assert.deepEqual(events, ["validate", "rename"]);
      }
    });
  }

  test(`${mode}: a first-attempt proof refusal preserves the exact error without rename or wait`, async () => {
    const refusal = fault("EPERM");
    let validations = 0;
    await assert.rejects(run({
      revalidate() { validations++; throw refusal; },
      rename() { assert.fail("refused proof must not rename"); },
      sleep() { assert.fail("refused proof must not wait"); },
    }), error => error === refusal);
    assert.equal(validations, 1);
  });

  for (const changedPath of ["destination", "staging", "staging-in-place"]) {
    for (const replaced of [false, true]) {
      test(`${mode}: ${changedPath} ${replaced ? "replacement during backoff refuses" : "unchanged during backoff publishes"}`, async t => {
        const root = mkdtempSync(join(tmpdir(), "brain-rename-identity-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const staged = join(root, "staged.json");
        const target = join(root, "target.json");
        const replacement = join(root, "replacement.json");
        writeFileSync(staged, "staged bytes");
        utimesSync(staged, STAGING_MTIME_SECONDS, STAGING_MTIME_SECONDS);
        writeFileSync(target, "previous bytes");
        writeFileSync(replacement, "replacement bytes");
        const stageIdentity = lstatSync(staged);
        const targetIdentity = lstatSync(target);
        const refusal = fault("EPERM");
        const stagedRefusal = new Error("synthetic staged byte refusal");
        let calls = 0;
        let validations = 0;
        let waits = 0;
        let rewritten;
        const result = (async () => await replace(staged, target, {
          platform: "win32",
          revalidate() {
            validations++;
            const current = lstatSync(staged);
            if (current.dev !== stageIdentity.dev || current.ino !== stageIdentity.ino
              || !renameHelpers.renameIdentityMatches(target, targetIdentity)) throw refusal;
          },
          staged: { expected: stageIdentity, bytes: Buffer.from("staged bytes"), refuse() { throw stagedRefusal; } },
          rename(from, to) {
            if (++calls === 1) throw fault("EBUSY");
            renameSync(from, to);
          },
          sleep(ms) {
            assert.equal(ms, 225);
            waits++;
            if (replaced && changedPath === "staging-in-place") rewritten = rewriteStagingInPlace(staged).bytes;
            else if (replaced) renameSync(replacement, changedPath === "destination" ? target : staged);
          },
        }))();
        if (replaced) {
          await assert.rejects(result, error => error === (changedPath === "staging-in-place" ? stagedRefusal : refusal));
          assert.equal(calls, 1, "replacement must be refused before a second rename");
          assert.equal(readFileSync(target, "utf8"), changedPath === "destination" ? "replacement bytes" : "previous bytes");
          if (rewritten) assert.deepEqual(readFileSync(staged), rewritten);
          else assert.equal(readFileSync(staged, "utf8"), changedPath === "staging" ? "replacement bytes" : "staged bytes");
        } else {
          await result;
          assert.equal(calls, 2);
          assert.equal(readFileSync(target, "utf8"), "staged bytes");
        }
        assert.equal(validations, 2);
        assert.equal(waits, 1);
      });
    }
  }
}

test("async: each refused rename and backoff settle before the next attempt", async () => {
  const events = [];
  let calls = 0;
  await renameWithRetry(source, destination, {
    platform: "win32",
    async revalidate() {
      events.push("validate-start");
      await Promise.resolve();
      events.push("validate-end");
    },
    async rename() {
      events.push("rename-start");
      await Promise.resolve();
      events.push("rename-end");
      if (++calls < 3) throw fault("EACCES");
    },
    async sleep(ms) {
      assert.equal(ms, 225);
      events.push("wait-start");
      await Promise.resolve();
      events.push("wait-end");
    },
  });
  assert.deepEqual(events, [
    "validate-start", "validate-end", "rename-start", "rename-end", "wait-start", "wait-end",
    "validate-start", "validate-end", "rename-start", "rename-end", "wait-start", "wait-end",
    "validate-start", "validate-end", "rename-start", "rename-end",
  ]);
});

for (const [mode, replace] of [["sync", renameWithRetrySync], ["async", renameWithRetry]]) {
  for (const operation of ["openSync", "readSync"]) {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      for (const outcome of ["control", "released", "held"]) {
        test(`${mode}: staged ${operation} ${code} ${outcome} shares the rename attempt budget`, async t => {
          const root = mkdtempSync(join(tmpdir(), "brain-proof-retry-"));
          t.after(() => rmSync(root, { recursive: true, force: true }));
          const path = join(root, "staged");
          const target = join(root, "target");
          const bytes = Buffer.from("staged bytes");
          writeFileSync(path, bytes);
          const expected = lstatSync(path, { bigint: true });
          const refusal = new Error("synthetic caller staging refusal");
          let observations = 0, validations = 0, renames = 0;
          const waits = [];
          const result = (async () => await replace(path, target, {
            platform: "win32", revalidate() { validations++; },
            staged: { expected, bytes, refuse() { throw refusal; } },
            fs: { [operation](...args) {
              observations++;
              assert.ok(observations <= 12, "proof retry must be bounded");
              if (outcome === "held" || (outcome === "released" && observations <= 2)) throw fault(code);
              return fs[operation](...args);
            } },
            rename(from, to) { renames++; return renameSync(from, to); },
            sleep(ms) { waits.push(ms); },
          }))();
          if (outcome === "held") {
            await assert.rejects(result, error => error === refusal);
            assert.equal(observations, 10);
            assert.equal(validations, 10);
            assert.equal(renames, 0);
            assert.deepEqual(waits, Array(9).fill(225));
            assert.deepEqual(readFileSync(path), bytes);
          } else {
            await result;
            assert.equal(validations, outcome === "released" ? 3 : 1);
            assert.equal(renames, 1);
            assert.deepEqual(waits, outcome === "released" ? [225, 225] : []);
            assert.deepEqual(readFileSync(target), bytes);
          }
        });
      }
    }
  }

  for (const platform of ["win32", "darwin", "linux"]) {
    for (const problem of ["mismatch", "unreadable", "io-error"]) {
      test(`${mode}: staged ${problem} on ${platform} refuses without an unproved rename`, async t => {
        const root = mkdtempSync(join(tmpdir(), "brain-proof-platform-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const path = join(root, "staged");
        const bytes = Buffer.from("staged bytes");
        writeFileSync(path, bytes);
        const expected = lstatSync(path, { bigint: true });
        const refusal = new Error("synthetic caller staging refusal");
        let attempts = 0, waits = 0;
        await assert.rejects(async () => await replace(path, join(root, "target"), {
          platform, revalidate() { attempts++; },
          staged: { expected, bytes: problem === "mismatch" ? Buffer.from("wrong bytes!") : bytes,
            refuse() { throw refusal; } },
          fs: problem === "mismatch" ? {} : { openSync() { throw fault(problem === "unreadable" ? "EBUSY" : "EIO"); } },
          rename() { assert.fail("an unproved staging file must never be renamed"); },
          sleep(ms) { assert.equal(ms, 225); waits++; assert.ok(waits <= 9); },
        }), error => error === refusal);
        const retries = platform === "win32" && problem === "unreadable";
        assert.equal(attempts, retries ? 10 : 1);
        assert.equal(waits, retries ? 9 : 0);
      });
    }
  }

  test(`${mode}: proof and rename refusals consume one shared ten-attempt budget`, async t => {
    const root = mkdtempSync(join(tmpdir(), "brain-proof-shared-budget-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "staged");
    const bytes = Buffer.from("staged bytes");
    writeFileSync(path, bytes);
    const expected = lstatSync(path, { bigint: true });
    let observations = 0, renames = 0, waits = 0;
    const refusal = fault("EPERM");
    await assert.rejects(async () => await replace(path, join(root, "target"), {
      platform: "win32", revalidate() {},
      staged: { expected, bytes, refuse() { assert.fail("final refusal came from rename"); } },
      fs: { openSync(...args) { if (++observations <= 3) throw fault("EBUSY"); return fs.openSync(...args); } },
      rename() { renames++; assert.ok(renames <= 7); throw refusal; },
      sleep(ms) { assert.equal(ms, 225); waits++; },
    }), error => error === refusal);
    assert.equal(observations, 10);
    assert.equal(renames, 7);
    assert.equal(waits, 9);
  });
}

for (const platform of ["win32", "darwin", "linux"]) {
  for (const operation of ["openSync", "readSync"]) {
    for (const outcome of ["control", "released", "held", "mismatch"]) {
      test(`baseline: ${platform} ${operation} ${outcome} keeps the proof budget and refusal`, t => {
        const root = mkdtempSync(join(tmpdir(), "brain-baseline-retry-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const path = join(root, "staged");
        const bytes = Buffer.from("staged bytes");
        writeFileSync(path, bytes);
        const created = lstatSync(path, { bigint: true });
        let observations = 0, waits = 0;
        const proof = renameHelpers.captureStagedProofWithRetry(path,
          outcome === "mismatch" ? Buffer.from("wrong bytes!") : bytes, created, {
            platform, fs: { [operation](...args) {
              observations++;
              assert.ok(observations <= 12, "baseline attempts must remain bounded");
              if (outcome === "held" || (outcome === "released" && observations <= 2)) throw fault("EBUSY");
              return fs[operation](...args);
            } },
            sleep(ms) { assert.equal(ms, 225); waits++; },
          });
        const accepted = outcome === "control" || (outcome === "released" && platform === "win32");
        assert.equal(Boolean(proof), accepted);
        if (outcome === "held") assert.equal(observations, platform === "win32" ? 10 : 1);
        if (platform !== "win32" && outcome === "released") assert.equal(observations, 1);
        assert.equal(waits, platform !== "win32" ? 0 : outcome === "held" ? 9 : outcome === "released" ? 2 : 0);
        assert.deepEqual(readFileSync(path), bytes);
      });
    }
  }
}

for (const [mode, replace] of [["sync", renameWithRetrySync], ["async", renameWithRetry]]) {
  test(`${mode}: baseline and publication spend at most nine waits together`, async t => {
    const root = mkdtempSync(join(tmpdir(), "brain-baseline-shared-budget-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "staged");
    const bytes = Buffer.from("staged bytes");
    writeFileSync(path, bytes);
    const created = lstatSync(path, { bigint: true });
    let observations = 0, waits = 0, attempts = 0;
    const sleep = ms => { assert.equal(ms, 225); waits++; };
    const proof = renameHelpers.captureStagedProofWithRetry(path, bytes, created, {
      platform: "win32", sleep,
      fs: { openSync(...args) { if (++observations < 4) throw fault("EBUSY"); return fs.openSync(...args); } },
    });
    assert.ok(proof);
    assert.equal(waits, 3);
    const refusal = fault("EPERM");
    await assert.rejects(async () => await replace(path, join(root, "target"), {
      platform: "win32", sleep, revalidate() {},
      staged: { expected: proof, bytes, refuse() { assert.fail("unchanged baseline must prove bytes"); } },
      rename() { attempts++; assert.ok(attempts <= 7); throw refusal; },
    }), error => error === refusal);
    assert.equal(attempts, 7);
    assert.equal(waits, 9);
  });
}

for (const phase of ["baseline", "sync", "async"]) {
  for (const release of [0, 450, -1]) {
    test(`native Windows staged FileShare.None ${phase} ${release === -1 ? "held" : release === 0 ? "control" : "released"}`, {
      skip: process.platform !== "win32", timeout: 20_000,
    }, async t => {
      const root = mkdtempSync(join(tmpdir(), "brain-staged-handle-"));
      const path = join(root, "staged");
      const target = join(root, "target");
      const bytes = Buffer.from("staged bytes");
      writeFileSync(path, bytes);
      const created = lstatSync(path, { bigint: true });
      let proof = phase === "baseline" ? null : renameHelpers.captureStagedProof(path, bytes, created);
      let child, exited;
      const script = `
$ErrorActionPreference = 'Stop'
$root = $env:BRAIN_STAGED_HOLDER_ROOT
$handle = [IO.File]::Open([IO.Path]::Combine($root, 'staged'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  [IO.File]::WriteAllText([IO.Path]::Combine($root, 'ready'), 'ready')
  while (-not [IO.File]::Exists([IO.Path]::Combine($root, 'attempted')) -and -not [IO.File]::Exists([IO.Path]::Combine($root, 'stop'))) { Start-Sleep -Milliseconds 10 }
  if ([int]$env:BRAIN_STAGED_HOLDER_DELAY -ge 0) { Start-Sleep -Milliseconds ([int]$env:BRAIN_STAGED_HOLDER_DELAY) }
  else { while (-not [IO.File]::Exists([IO.Path]::Combine($root, 'stop'))) { Start-Sleep -Milliseconds 10 } }
} finally { $handle.Dispose() }
`;
      try {
        if (release !== 0) {
          const systemRoot = process.env.SystemRoot;
          assert.ok(systemRoot);
          child = spawn(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
            "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
          ], { windowsHide: true, stdio: "ignore", env: {
            SystemRoot: systemRoot, BRAIN_STAGED_HOLDER_ROOT: root, BRAIN_STAGED_HOLDER_DELAY: String(release),
          } });
          exited = new Promise(resolve => { child.once("error", () => resolve(-1)); child.once("exit", code => resolve(code)); });
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(join(root, "ready")) && Date.now() < deadline && child.exitCode === null) await delay(15);
          assert.ok(fs.existsSync(join(root, "ready")), "native holder must acquire the staging file");
          writeFileSync(join(root, "attempted"), "attempted");
        }
        const refusal = new Error("synthetic caller staging refusal");
        let observations = 0, renames = 0;
        const io = { openSync(...args) {
          observations++;
          // A removed retry ceiling must fail this fixture, never strand its
          // synchronous held-handle row where the test timeout cannot interrupt.
          assert.ok(observations <= 12, "native proof observations must remain bounded");
          return openSync(...args);
        } };
        const started = Date.now();
        const publish = async () => {
          if (phase === "baseline") proof = renameHelpers.captureStagedProof(path, bytes, created, { fs: io });
          const replace = phase === "async" ? renameWithRetry : renameWithRetrySync;
          return await replace(path, target, { revalidate() {}, fs: io,
            staged: { expected: proof, bytes, refuse() { throw refusal; } },
            rename(from, to) { renames++; return renameSync(from, to); },
          });
        };
        if (release === -1) {
          await assert.rejects(publish, error => error === refusal);
          assert.equal(renames, 0);
          assert.equal(observations, 10, "held proof must spend exactly ten observations");
          assert.ok(Date.now() - started >= 1_900, "held proof must spend the backoff budget");
        } else {
          await publish();
          assert.equal(renames, 1);
          if (release === 450) assert.ok(observations >= 3, "real sharing refusals precede release");
          assert.deepEqual(readFileSync(target), bytes);
        }
      } finally {
        if (child) {
          writeFileSync(join(root, "stop"), "stop");
          const timeout = delay(3_000, -2, { ref: false });
          const code = await Promise.race([exited, timeout]);
          if (code === -2) { child.kill(); await exited; }
          assert.equal(code, 0, "native holder must release its handle and exit cleanly");
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("async: the byte proof is followed by the rename call without yielding", async t => {
  const root = mkdtempSync(join(tmpdir(), "brain-rename-no-gap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const staged = join(root, "staged");
  const target = join(root, "target");
  const bytes = Buffer.from("staged bytes");
  writeFileSync(staged, bytes);
  const expected = lstatSync(staged, { bigint: true });
  let lstatCalls = 0, yielded = false, renamed = false;
  await renameWithRetry(staged, target, {
    async revalidate() { await Promise.resolve(); },
    staged: { expected, bytes, refuse() { assert.fail("unchanged staged proof must pass"); } },
    fs: { lstatSync(...args) {
      const value = lstatSync(...args);
      if (++lstatCalls === 2) queueMicrotask(() => { yielded = true; });
      return value;
    } },
    rename(from, to) {
      assert.equal(yielded, false, "nothing can await between the final lstat and rename invocation");
      renamed = true;
      renameSync(from, to);
    },
  });
  assert.equal(lstatCalls, 2);
  assert.equal(renamed, true);
  assert.equal(yielded, true);
  assert.deepEqual(readFileSync(target), bytes);
});

for (const mode of ["baseline", "sync", "async"]) {
  for (const closeFailure of [false, true]) {
    test(`${mode}: transient proof read ${closeFailure ? "refuses when cleanup close fails" : "retries after cleanup close succeeds"}`, async t => {
      const root = mkdtempSync(join(tmpdir(), "brain-proof-close-refusal-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, "staged");
      const target = join(root, "target");
      const bytes = Buffer.from("staged bytes");
      writeFileSync(path, bytes);
      const expected = lstatSync(path, { bigint: true });
      const refusal = new Error("synthetic caller staging refusal");
      let reads = 0, closes = 0, waits = 0, renames = 0;
      const io = {
        readSync(...args) {
          if (++reads === 1) throw fault("EBUSY");
          return fs.readSync(...args);
        },
        closeSync(descriptor) {
          closes++;
          fs.closeSync(descriptor);
          if (closeFailure) throw fault("EIO");
        },
      };
      const sleep = ms => { assert.equal(ms, 225); waits++; };
      if (mode === "baseline") {
        const proof = renameHelpers.captureStagedProofWithRetry(path, bytes, expected, { fs: io, platform: "win32", sleep });
        assert.equal(Boolean(proof), !closeFailure);
      } else {
        const replace = mode === "sync" ? renameWithRetrySync : renameWithRetry;
        const publish = async () => await replace(path, target, {
          revalidate() {}, platform: "win32", fs: io, sleep,
          staged: { expected, bytes, refuse() { throw refusal; } },
          rename(from, to) { renames++; return renameSync(from, to); },
        });
        if (closeFailure) await assert.rejects(publish, error => error === refusal);
        else await publish();
        assert.equal(renames, closeFailure ? 0 : 1);
      }
      assert.equal(reads, closeFailure ? 1 : 3);
      assert.equal(closes, closeFailure ? 1 : 2);
      assert.equal(waits, closeFailure ? 0 : 1);
      assert.deepEqual(readFileSync(mode === "baseline" || closeFailure ? path : target), bytes);
    });
  }
}
