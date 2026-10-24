import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveState } from "../ingest/run.mjs";

const before = { version: 1, done: { fixture: "prior" }, skipped: {} };
const after = { version: 1, done: { fixture: "next" }, skipped: {} };
const fault = (code) => Object.assign(new Error("synthetic state failure"), { code });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "brain-state-retry-"));
  const path = join(directory, "state.json");
  writeFileSync(path, JSON.stringify(before), { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    path,
    verify(expected) {
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
      assert.deepEqual(readdirSync(directory), ["state.json"], "no temporary sibling remains");
    },
  };
}

test("no contention performs one rename with no backoff", (t) => {
  const f = fixture(t);
  let calls = 0;
  const result = saveState(f.path, after, {
    rename(from, to) { calls++; renameSync(from, to); },
    sleep() { assert.fail("an uncontended rename must not sleep"); },
  });
  assert.equal(result, undefined, "state persistence stays synchronous");
  assert.equal(calls, 1);
  f.verify(after);
  if (process.platform !== "win32") assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test("default dependencies replace a checkpoint without contention", (t) => {
  const f = fixture(t);
  saveState(f.path, after);
  f.verify(after);
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`${code} succeeds after three failures with a backoff between attempts`, (t) => {
    const f = fixture(t);
    const events = [];
    let calls = 0;
    let sibling;
    saveState(f.path, after, {
      rename(from, to) {
        events.push("rename");
        sibling ??= from;
        assert.equal(from, sibling, "retry the same staged checkpoint");
        assert.equal(to, f.path);
        assert.deepEqual(JSON.parse(readFileSync(from, "utf8")), after);
        assert.deepEqual(JSON.parse(readFileSync(to, "utf8")), before);
        if (++calls <= 3) throw fault(code);
        renameSync(from, to);
      },
      sleep(ms) { events.push(ms); },
    });
    assert.equal(calls, 4);
    assert.deepEqual(events, ["rename", 225, "rename", 225, "rename", 225, "rename"]);
    f.verify(after);
  });

  test(`${code} gives up at ten tries and preserves the original error and checkpoint`, (t) => {
    const f = fixture(t);
    const waits = [];
    const errors = Array.from({ length: 10 }, () => fault(code));
    let calls = 0;
    assert.throws(() => saveState(f.path, after, {
      rename() {
        calls++;
        // A broken unbounded loop is stopped by this test, without hanging CI.
        assert.ok(calls <= 10, "rename attempts must be bounded");
        throw errors[calls - 1];
      },
      sleep(ms) { waits.push(ms); },
    }), (error) => error === errors[9] && error.code === code);
    assert.equal(calls, 10);
    assert.deepEqual(waits, Array(9).fill(225), "no wait after the last failed attempt");
    f.verify(before);
  });
}

test("the tenth rename can still succeed", (t) => {
  const f = fixture(t);
  let calls = 0;
  const waits = [];
  saveState(f.path, after, {
    rename(from, to) {
      if (++calls < 10) throw fault("EPERM");
      renameSync(from, to);
    },
    sleep(ms) { waits.push(ms); },
  });
  assert.equal(calls, 10);
  assert.deepEqual(waits, Array(9).fill(225));
  f.verify(after);
});

for (const code of ["ENOSPC", "EIO", undefined]) {
  test(`${code ?? "uncoded failure"} is not retried and leaves no temporary sibling`, (t) => {
    const f = fixture(t);
    const original = fault(code);
    let calls = 0;
    let waits = 0;
    assert.throws(() => saveState(f.path, after, {
      rename() { calls++; throw original; },
      sleep() { waits++; },
    }), (error) => error === original);
    assert.equal(calls, 1);
    assert.equal(waits, 0);
    f.verify(before);
  });
}

test("chmod failure is thrown once without retrying rename or chmod", (t) => {
  const f = fixture(t);
  const original = fault("EPERM");
  const realChmod = fs.chmodSync;
  let renames = 0;
  let chmods = 0;
  let waits = 0;
  fs.chmodSync = () => { chmods++; throw original; };
  syncBuiltinESMExports();
  try {
    assert.throws(() => saveState(f.path, after, {
      rename(from, to) { renames++; renameSync(from, to); },
      sleep() { waits++; },
    }), (error) => error === original);
  } finally {
    fs.chmodSync = realChmod;
    syncBuiltinESMExports();
  }
  assert.equal(renames, 1);
  assert.equal(chmods, 1);
  assert.equal(waits, 0);
  f.verify(after);
});
