import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveState } from "../ingest/run.mjs";

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`state replacement retries a transient Windows ${code} without deleting the old checkpoint`, t => {
    const root = mkdtempSync(join(tmpdir(), "ingest-state-retry-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "state.json");
    const previous = '{"version":1,"done":{"prior":"revision"}}';
    writeFileSync(path, previous);
    const next = { version: 1, done: { current: "revision" } };
    let calls = 0;
    const sleeps = [];
    saveState(path, next, { platform: "win32", sleep: ms => sleeps.push(ms), rename: (from, to) => {
      calls++;
      assert.equal(readFileSync(path, "utf8"), previous);
      if (calls < 3) throw Object.assign(new Error("synthetic sharing violation"), { code });
      renameSync(from, to);
    } });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [10, 20]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), next);
    assert.deepEqual(readdirSync(root), ["state.json"]);
  });
}

for (const [platform, code, attempts] of [["win32", "EPERM", 6], ["win32", "ENOSPC", 1], ["linux", "EPERM", 1]]) {
  test(`state replacement preserves the prior checkpoint on exhausted ${platform} ${code}`, t => {
    const root = mkdtempSync(join(tmpdir(), "ingest-state-failure-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "state.json");
    const previous = '{"version":1,"done":{}}';
    writeFileSync(path, previous);
    const fault = Object.assign(new Error("synthetic write failure"), { code });
    let calls = 0;
    const sleeps = [];
    assert.throws(() => saveState(path, { version: 1, done: { next: "revision" } }, {
      platform, sleep: ms => sleeps.push(ms), rename: () => { calls++; throw fault; },
    }), error => error === fault);
    assert.equal(calls, attempts);
    assert.equal(sleeps.length, attempts - 1);
    assert.equal(readFileSync(path, "utf8"), previous);
    assert.deepEqual(readdirSync(root), ["state.json"]);
  });
}
