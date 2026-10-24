import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameWithRetry, renameWithRetrySync } from "../operations/rename-retry.mjs";

const fault = code => Object.assign(new Error("synthetic rename failure"), { code });
const source = "staged";
const destination = "destination";

for (const [mode, replace] of [["sync", renameWithRetrySync], ["async", renameWithRetry]]) {
  const run = async options => await replace(source, destination, options);

  test(`${mode}: uncontended rename runs once without backoff`, async () => {
    const calls = [];
    const result = replace(source, destination, {
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
    await replace(staged, target);
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
}

test("async: each refused rename and backoff settle before the next attempt", async () => {
  const events = [];
  let calls = 0;
  await renameWithRetry(source, destination, {
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
    "rename-start", "rename-end", "wait-start", "wait-end",
    "rename-start", "rename-end", "wait-start", "wait-end",
    "rename-start", "rename-end",
  ]);
});
