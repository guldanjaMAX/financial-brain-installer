import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdLoad, loadSourceRegistry } from "../brain.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { DriveRemovalReviewRequired } from "../operations/drive-removal-plan.mjs";

const accepted = () => ({ created: 1, updated: 0, unchanged: 0 });

function fixture(t, producers) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-load-errors-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 1,
    corpora: { gmail: { enabled: true }, google_drive: { enabled: true } },
  }));
  const events = [];
  const registry = loadSourceRegistry();
  registry.gmail = {
    ...registry.gmail,
    legs: () => producers.map((producer, index) => ({
      source: `mail-${index + 1}`,
      run: async () => { events.push(`mail-${index + 1}`); return producer(); },
    })),
  };
  registry.google_drive = {
    ...registry.google_drive,
    legs: () => [{ source: "files", run: async () => { events.push("files"); return accepted(); } }],
  };
  const options = {
    flags: {}, lifecycleLockHeld: true, registry,
    probes: { gmail: () => ({ connected: true }), google_drive: () => ({ connected: true }) },
    log() {},
  };
  return { home, manifestPath, events, options };
}

async function quietRun(task) {
  const originalLog = console.log;
  console.log = () => {};
  try { return await task(); }
  finally { console.log = originalLog; }
}

async function caughtLoad(f) {
  try {
    await quietRun(() => cmdLoad(f.manifestPath, f.options));
    assert.fail("the failed load must still reject");
  } catch (error) {
    return error;
  }
}

test("daily load retains the original removal review after reporting a failed source", async (t) => {
  const review = new DriveRemovalReviewRequired("a removal plan is waiting for approval");
  review.removal_review = Object.freeze({
    stored_documents_to_remove: 2, source_removals: 1, replacement_family_reviews: 1,
    source_cleanup_percentage: 5, fingerprint: "a".repeat(64),
  });
  const f = fixture(t, [() => { throw review; }]);
  const error = await caughtLoad(f);
  assert.equal(error.constructor.name, "Fatal", "the public failure type stays unchanged");
  assert.match(error.message, /1 of 2 source\(s\) did not load/);
  assert.deepEqual(f.events, ["mail-1", "files"], "a later source still runs");
  assert.equal(error.cause === review, true, "the original typed removal error survives aggregation");
  assert.equal(error.cause?.removal_review === review.removal_review, true, "review metadata survives in memory");
  assert.equal(error.cause?.code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(JSON.stringify(error), "{}", "raw causes are not serializable summary fields");
});

test("daily load retains every failed leg in a non-enumerable aggregate cause", async (t) => {
  const first = Object.assign(new Error("the source lock is held"), { code: "source_ingest_already_running" });
  const second = new Error("provider connection failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) });
  const f = fixture(t, [() => { throw first; }, () => { throw second; }]);
  const error = await caughtLoad(f);
  assert.match(error.message, /1 of 2 source\(s\) did not load/);
  assert.deepEqual(f.events, ["mail-1", "mail-2", "files"]);
  assert.equal(error.cause instanceof AggregateError, true, "multiple failures remain inspectable");
  assert.equal(error.cause.errors.length, 2);
  assert.equal(error.cause.errors[0] === first && error.cause.errors[1] === second, true);
  assert.equal(JSON.stringify(error), "{}", "nested errors do not enter JSON summaries");
});

for (const failureCount of [1, 2]) {
  test(`daily load retains ${failureCount} failed leg cause(s) when the source partly loaded`, async (t) => {
    const failures = Array.from({ length: failureCount }, () =>
      Object.assign(new Error("the source needs a safety review"), { code: "SAFETY_REVIEW_REQUIRED" }));
    const f = fixture(t, [...failures.map(error => () => { throw error; }), accepted]);
    f.options.allowPartialRefresh = true;
    const error = await caughtLoad(f);
    assert.equal(error.constructor.name, "Fatal");
    assert.match(error.message, /1 partial source outcome\(s\) were not complete/);
    assert.equal(f.events.length, failureCount + 2, "later legs and the next source still run");
    assert.equal(f.events.at(-1), "files");
    if (failureCount === 1) {
      assert.equal(error.cause === failures[0], true, "a single partial failure retains its typed cause");
    } else {
      assert.equal(error.cause instanceof AggregateError, true);
      assert.equal(error.cause.errors.length, failures.length);
      assert.equal(error.cause.errors.every((cause, index) => cause === failures[index]), true);
    }
    assert.equal(JSON.stringify(error), "{}");
  });
}

test("daily load clean source control keeps its complete summary and runs all legs", async (t) => {
  const f = fixture(t, [accepted, accepted]);
  const result = await quietRun(() => cmdLoad(f.manifestPath, f.options));
  assert.deepEqual(f.events, ["mail-1", "mail-2", "files"]);
  assert.equal(result.loaded, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.partial, 0);
  assert.equal(result.entries.every(entry => entry.status === "loaded"), true);
  assert.equal(result.entries.every(entry => entry.legFailures.length === 0), true);
  assert.equal(Object.hasOwn(result, "cause"), false);
  assert.equal(JSON.stringify(result).includes('"errors"'), false);
});

test("daily load default runner preserves removal cause in its receipt and daily log", async (t) => {
  const review = new DriveRemovalReviewRequired("a removal plan is waiting for approval");
  review.removal_review = Object.freeze({
    stored_documents_to_remove: 2, source_removals: 1, replacement_family_reviews: 1,
    source_cleanup_percentage: 5, fingerprint: "b".repeat(64),
  });
  const f = fixture(t, [() => { throw review; }]);
  const plan = {
    ready: true, enabled: true, identity: { id: "v1-load" }, manifest_path: f.manifestPath,
    sources: [{ key: "gmail", run_key: "gmail", class: "machine-pull", owner: "daily-task", status: "ready" }],
  };
  const result = await quietRun(() => runDailyRefreshCli(f.manifestPath, {
    brainModule: { cmdLoad: (path, options) => cmdLoad(path, { ...f.options, ...options, log() {} }) },
    buildPlan: async () => plan,
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    readFreshness: async () => ({}), readUpdateTransaction: () => null,
    home: f.home, platform: "linux", silent: true,
    now: () => new Date("2026-10-23T18:00:00.000Z"),
  }));
  assert.deepEqual(f.events, ["mail-1"], "the default adapter keeps the selected source scope");
  assert.equal(result.status, "failed");
  assert.equal(result.sources[0].issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(result.sources[0].reason_code, "removal_review_required");
  const records = readFileSync(join(f.home, ".brain", "logs", plan.identity.id, "daily.log"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  const failure = records.find(record => record.kind === "source_failure");
  assert.equal(failure?.issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(failure?.detail, result.sources[0].detail);
});
