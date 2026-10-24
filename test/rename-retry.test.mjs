import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameWithRetry, renameWithRetrySync } from "../operations/rename-retry.mjs";
import * as renameHelpers from "../operations/rename-retry.mjs";

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
    dev: 1, ino: 2, nlink: 1, size: 3, mtimeMs: 4, mode: 0o100600,
    isFile: () => true, isSymbolicLink: () => false,
  };
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => identity }), true);
  for (const field of ["dev", "ino", "nlink", "size", "mtimeMs", "mode"]) {
    assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => ({ ...identity, [field]: identity[field] + 1 }) }), false, field);
  }
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => ({ ...identity, isFile: () => false }) }), false);
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => ({ ...identity, isSymbolicLink: () => true }) }), false);
  assert.equal(renameHelpers.renameIdentityMatches(source, identity, { lstat: () => { throw fault("EACCES"); } }), false);
  assert.equal(renameHelpers.renameIdentityMatches(source, null, { lstat: () => { throw fault("EACCES"); } }), false);
  const unreadable = fault("EACCES");
  assert.throws(() => renameHelpers.captureRenameIdentity(source, { lstat: () => { throw unreadable; } }), error => error === unreadable);
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

  for (const changedPath of ["destination", "staging"]) {
    for (const replaced of [false, true]) {
      test(`${mode}: ${changedPath} ${replaced ? "replacement during backoff refuses" : "unchanged during backoff publishes"}`, async t => {
        const root = mkdtempSync(join(tmpdir(), "brain-rename-identity-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const staged = join(root, "staged.json");
        const target = join(root, "target.json");
        const replacement = join(root, "replacement.json");
        writeFileSync(staged, "staged bytes");
        writeFileSync(target, "previous bytes");
        writeFileSync(replacement, "replacement bytes");
        const stageIdentity = lstatSync(staged);
        const targetIdentity = lstatSync(target);
        const refusal = fault("EPERM");
        let calls = 0;
        let validations = 0;
        let waits = 0;
        const same = (path, expected) => {
          const actual = lstatSync(path);
          return actual.dev === expected.dev && actual.ino === expected.ino;
        };
        const result = (async () => await replace(staged, target, {
          platform: "win32",
          revalidate() {
            validations++;
            if (!same(staged, stageIdentity) || !same(target, targetIdentity)) throw refusal;
          },
          rename(from, to) {
            if (++calls === 1) throw fault("EBUSY");
            renameSync(from, to);
          },
          sleep(ms) {
            assert.equal(ms, 225);
            waits++;
            if (replaced) renameSync(replacement, changedPath === "destination" ? target : staged);
          },
        }))();
        if (replaced) {
          await assert.rejects(result, error => error === refusal);
          assert.equal(calls, 1, "replacement must be refused before a second rename");
          assert.equal(readFileSync(target, "utf8"), changedPath === "destination" ? "replacement bytes" : "previous bytes");
          assert.equal(readFileSync(staged, "utf8"), changedPath === "staging" ? "replacement bytes" : "staged bytes");
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
