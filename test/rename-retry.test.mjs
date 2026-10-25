import assert from "node:assert/strict";
import fs, { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("change-time-only drift refuses while the round 2 six-field snapshot stays equal", t => {
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
  assert.equal(renameHelpers.stagedBytesMatch(path, before, bytes), false);
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
        let calls = 0;
        let validations = 0;
        let waits = 0;
        let rewritten;
        const result = (async () => await replace(staged, target, {
          platform: "win32",
          revalidate() {
            validations++;
            if (!renameHelpers.renameIdentityMatches(staged, stageIdentity)
              || !renameHelpers.renameIdentityMatches(target, targetIdentity)) throw refusal;
          },
          staged: { expected: stageIdentity, bytes: Buffer.from("staged bytes"), refuse() { throw refusal; } },
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
          await assert.rejects(result, error => error === refusal);
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
