import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { format } from "node:util";

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

// Observe all public console methods as well as direct stream writes. Restore
// even on rejection so neither the test runner nor a later test loses output.
async function captureOutput(task) {
  const output = [];
  const methods = Object.getOwnPropertyNames(console).filter(name =>
    !name.startsWith("_") && name !== "Console" && typeof console[name] === "function");
  const saved = methods.map(name => [name, console[name]]);
  const streams = [process.stdout, process.stderr].map(stream => [stream, stream.write]);
  for (const name of methods) console[name] = (...args) => {
    output.push({ channel: `console.${name}`, text: format(...args) });
  };
  for (const [stream] of streams) stream.write = (chunk, encoding, callback) => {
    output.push({ channel: stream === process.stdout ? "stdout" : "stderr", text: String(chunk) });
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) done();
    return true;
  };
  try { return { value: await task(methods), output }; }
  finally {
    for (const [name, method] of saved) console[name] = method;
    for (const [stream, write] of streams) stream.write = write;
  }
}

test("daily load output capture control observes every console method and both streams", async () => {
  const marker = randomUUID();
  const { value: methods, output } = await captureOutput(async names => {
    for (const name of names) console[name](marker);
    process.stdout.write(marker);
    process.stderr.write(Buffer.from(marker));
    return names;
  });
  assert.deepEqual(output.map(entry => entry.channel), [...methods.map(name => `console.${name}`), "stdout", "stderr"]);
  assert.equal(output.every(entry => entry.text.includes(marker)), true);
});

for (const mode of ["failed", "partial", "clean"]) {
test(`daily load default adapter ${mode} source keeps raw leg diagnostics off every output channel`, async (t) => {
  const marker = randomUUID();
  const review = new DriveRemovalReviewRequired(`approval pending for https://${marker}.invalid/private`);
  review.removal_review = Object.freeze({
    stored_documents_to_remove: 2, source_removals: 1, replacement_family_reviews: 1,
    source_cleanup_percentage: 5, fingerprint: "b".repeat(64),
  });
  const f = fixture(t, mode === "clean" ? [accepted] : [
    () => { throw review; }, ...(mode === "partial" ? [accepted] : []),
  ]);
  const plan = {
    ready: true, enabled: true, identity: { id: "v1-load" }, manifest_path: f.manifestPath,
    sources: ["gmail", "google_drive"].map(key => ({
      key, run_key: key, class: "machine-pull", owner: "daily-task", status: "ready",
    })),
  };
  const forwarded = [];
  let caught;
  let reads = 0;
  const { value: result, output } = await captureOutput(() => runDailyRefreshCli(f.manifestPath, {
    // Only provider-free dependencies are injected here. Output policy must
    // come from the default adapter; a fixture logger would hide its absence.
    brainModule: { cmdLoad: async (path, options) => {
      forwarded.push(options);
      try {
        return await cmdLoad(path, { registry: f.options.registry, probes: f.options.probes, ...options });
      } catch (error) { caught = error; throw error; }
    } },
    buildPlan: async () => plan,
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    readFreshness: async () => {
      const at = reads++ === 0 ? "2026-10-22T18:00:00.000Z" : "2026-10-23T17:59:00.000Z";
      return Object.fromEntries(["gmail", "google_drive"].map(key => [key, { last_successful_run_at: at }]));
    },
    readUpdateTransaction: () => null,
    home: f.home, platform: "linux",
    now: () => new Date("2026-10-23T18:00:00.000Z"),
  }));
  assert.deepEqual(f.events, mode === "partial" ? ["mail-1", "mail-2", "files"] : ["mail-1", "files"],
    "the default adapter reaches the failing leg and later clean work within the selected scope");
  assert.deepEqual(forwarded.map(options => options.flags.only), ["gmail", "google_drive"]);
  assert.equal(result.sources[1].status, "complete", "later clean work still verifies");
  assert.equal(result.sources[1].freshness_advanced, true);
  assert.equal(output.length > 0, true, "the observation includes actual runner output");
  for (const { channel, text } of output) {
    assert.equal(text.includes(marker), false, `raw leg diagnostic escaped through ${channel}`);
  }
  const receiptText = readFileSync(join(f.home, ".brain", "daily-receipts", `${plan.identity.id}.json`), "utf8");
  assert.deepEqual(JSON.parse(receiptText), result);
  const logText = readFileSync(join(f.home, ".brain", "logs", plan.identity.id, "daily.log"), "utf8");
  for (const text of [receiptText, logText]) assert.equal(text.includes(marker), false);
  const records = logText
    .trim().split("\n").map(line => JSON.parse(line));
  const failure = records.find(record => record.kind === "source_failure");
  if (mode === "clean") {
    assert.equal(result.status, "complete");
    assert.equal(result.sources[0].freshness_advanced, true);
    assert.equal(result.sources[0].issue_code, undefined);
    assert.equal(failure, undefined);
    assert.equal(caught, undefined);
  } else {
    assert.equal(result.status, "failed");
    assert.equal(result.sources[0].freshness_advanced, false);
    assert.equal(result.sources[0].issue_code, "SAFETY_REVIEW_REQUIRED");
    assert.equal(result.sources[0].reason_code, "removal_review_required");
    assert.match(result.sources[0].detail, /^approval pending for \[REDACTED:url\]$/);
    assert.equal(failure?.issue_code, "SAFETY_REVIEW_REQUIRED");
    assert.equal(failure?.detail, result.sources[0].detail);
    assert.equal(caught?.cause === review, true, "the typed cause remains available in memory");
    assert.equal(JSON.stringify(caught), "{}", "raw causes are not serializable summary fields");
  }
});
}

test("daily load interactive output control retains the default failure report", async (t) => {
  const marker = randomUUID();
  const f = fixture(t, [() => { throw new Error(marker); }]);
  let caught;
  const { output } = await captureOutput(async () => {
    try {
      await cmdLoad(f.manifestPath, {
        flags: {}, lifecycleLockHeld: true, registry: f.options.registry, probes: f.options.probes,
      });
    } catch (error) { caught = error; }
  });
  assert.deepEqual(f.events, ["mail-1", "files"]);
  assert.equal(caught?.cause?.message === marker, true);
  assert.equal(output.filter(entry => entry.text.includes(marker)).length, 2,
    "interactive callers still receive both the immediate failure and consolidated report");
});
