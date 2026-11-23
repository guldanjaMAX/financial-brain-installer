import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdIngestRemote, cmdLoad, credentialScannerFingerprint, describeLoadResult } from "../brain.mjs";
import { planDailyRefresh } from "../operations/daily-refresh-plan.mjs";
import { runDailyRefresh } from "../operations/daily-refresh-run.mjs";
import { dailyObservationStatus, observeDailyRun, renderDailyObservation } from "../operations/daily-refresh-observation.mjs";
import * as drive from "../connectors/google-drive.mjs";
import { batchStream, splitOversized, prefetch, loadState as realLoadState, saveState as realSaveState } from "../ingest/run.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };
const stamp = "2026-11-01T00:00:00.000Z";
const content = "The owner reviewed this synthetic project record and approved the next scheduled review. This document records the decision and supporting evidence for the plan.";
const file = (id, parent = "reviewed", extra = {}) => ({ id, name: `${id}.txt`,
  mimeType: "text/plain", parents: [parent], size: String(content.length), modifiedTime: stamp, ...extra });
const folder = (id, parent) => ({ id, name: id, mimeType: drive.FOLDER_MIME, parents: parent ? [parent] : [] });

function harness({ state = {}, pages = {}, entries = [], fault = null, compactSaves = false } = {}) {
  state = { version: 1, done: {}, skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true), ...state };
  const calls = [], sent = [], receipts = [], saves = [];
  const byId = new Map([folder("reviewed", "account-root"), folder("account-root"),
    ...Object.values(pages).flatMap((page) => (page.changes || []).map((change) => change.file).filter(Boolean)),
    ...entries].map((f) => [f.id, f]));
  const opts = { attempts: 1, fetchImpl: async (input) => {
    const url = new URL(input), id = decodeURIComponent(url.pathname.split("/").at(-1));
    const page = url.searchParams.get("pageToken");
    calls.push({ id, page, size: url.searchParams.get("pageSize"), media: url.searchParams.get("alt") === "media" });
    if (fault?.(url)) throw new Error("synthetic transport interruption");
    if (id === "startPageToken") return Response.json({ startPageToken: "seed-page" });
    if (id === "changes") { assert.ok(pages[page], "unexpected change page"); return Response.json(pages[page]); }
    assert.notEqual(id, "files", "incremental ingest must never list the corpus");
    if (url.searchParams.get("alt") === "media") return new Response(content);
    assert.ok(byId.has(id === "root" ? "account-root" : id), "unexpected metadata lookup");
    return Response.json(byId.get(id === "root" ? "account-root" : id));
  } };
  const connector = new Proxy(drive, { get(target, name) {
    if (["startPageToken", "getFileMetadata"].includes(name)) return (...args) => target[name](...args, opts);
    if (name === "listChanges") return (get, page) => target[name](get, page, opts);
    if (name === "listChangePage") return (get, page, config) => target[name](get, page, { ...config, ...opts });
    if (name === "changeScope") return (get, f, config) => target[name](get, f, { ...config, opts });
    if (name === "toEnvelope") return (get, f, config) => drive.toEnvelope(get, f, config, opts);
    if (name === "listRootedFiles") return async function* () { calls.push({ id: "full-walk" }); throw new Error("full walk reached"); };
    return target[name];
  } });
  const options = {
    verifyDriveIncrementalWorker: async () => {},
    readDriveFamily: async () => true,
    readCurrentIngestParts: async ({envelopes,proof}) => ({parts:envelopes || proof.parts,
      database:{instance:'1'.repeat(32),nonce:'2'.repeat(32),generation:1}}),
    drive: connector, getAccessToken: async () => randomBytes(16).toString("hex"),
    resolveBaseUrl: async () => "https://owner.invalid", resolveAdminKey: () => readFileSync(fixtureKeyPath, "utf8"),
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    ingestLib: async () => ({ batchStream, splitOversized, prefetch, loadState: () => state,
      saveState: (_path, value) => saves.push(structuredClone(compactSaves
        ? { sync_token: value.sync_token, drive_change_page: value.drive_change_page && { offset: value.drive_change_page.offset } }
        : value)) }),
    sendBatches: async ({ groups, onResult }) => {
      const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
      for (const item of groups.flat()) { sent.push(item.envelope); tally.created++; onResult?.(item, { status: "created" }); }
      return tally;
    },
    listStoredSourceFamilies: async () => { throw new Error("corpus inventory reached"); },
    applyDriveRemovals: async () => { throw new Error("automatic removal reached"); },
    reconcileDocumentFamilies: async () => { throw new Error("automatic family removal reached"); },
    postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); },
    driveNow: () => Date.parse(stamp), write: () => {},
  };
  const manifest = { brain: { domain: "owner.invalid" }, corpora: { google_drive: { enabled: true, root_folder_ids: ["reviewed"] } },
    safety: { ocr: { enabled: false }, credential_scanner: { enabled: true } } };
  const manifestPath = join(realpathSync.native(mkdtempSync(join(tmpdir(), "drive-incremental-"))), "manifest.json");
  const fixtureKeyPath = join(manifestPath, "..", ".brain-admin-key");
  const launchctl = join(manifestPath, "..", "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode:0o700 });
  options.launchctl = launchctl;
  writeFileSync(fixtureKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { state, calls, sent, receipts, saves, options, manifest, manifestPath,
    run: (flags = {}) => cmdIngestRemote(manifest, manifestPath, { from: "drive", ...flags }, options) };
}

async function dailyDrive(h, now = () => Date.parse(stamp), laterSources = []) {
  const prior = "2026-10-01T00:00:00.000Z";
  return runDailyRefresh({
    plan: { ready: true, enabled: true, identity: { id: "v1-drivecatchup" }, max_runtime_minutes: 45,
      sources: [{ key: "google_drive", source_names: ["drive"], run_key: "google_drive",
        class: "machine-pull", owner: "daily-task", status: "ready" }, ...laterSources] },
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: (source, lease) => cmdLoad(h.manifestPath, {
      flags: { only: source.run_key }, lifecycleLockHeld: true, allowPartialRefresh: true,
      ingestDeadlineAt: lease.deadlineAt, log() {},
      probes: { google_drive: async () => ({ connected: true }) },
      commands: { ingestRemote: (manifest, path, flags, options) =>
        cmdIngestRemote(manifest, path, flags, { ...options, ...h.options, driveNow: now }) },
    }),
    readFreshness: async () => {
      const receipt = h.receipts.at(-1);
      const accepted = h.receipts.findLast(row => row.status === "ready" && row.docs_added > 0);
      return { drive: { kind: "drive", last_successful_run_at: accepted?.completed_at || prior,
        latest_run: receipt && { ...receipt, metrics_version: 1, finished_at: receipt.completed_at,
          outcome: receipt.status === "error" ? "failed" : receipt.docs_added > 0 ? "complete" : "empty" } } };
    },
    now: () => new Date(now()),
  });
}

function driveBacklog(pages) {
  return { ...Object.fromEntries(Array.from({ length: pages }, (_, index) => [
    `page-${index}`,
    { changes: Array.from({ length: 50 }, (_, offset) => {
      const id = `file-${index}-${offset}`;
      return { fileId: id, file: file(id) };
    }), ...(index + 1 === pages ? { newStartPageToken: "caught-up" } : { nextPageToken: `page-${index + 1}` }) },
  ])), "caught-up": { changes: [], newStartPageToken: "caught-up" } };
}

for (const pageCount of [10, 1]) {
  test(`daily Drive finishes ${pageCount * 50} changes in one run`, async () => {
    const h = harness({ state: { sync_token: "page-0" }, pages: driveBacklog(pageCount), compactSaves: true });
    const daily = await dailyDrive(h);
    assert.equal(daily.status, "complete");
    assert.deepEqual(h.calls.filter(call => call.id === "changes" && call.page !== "caught-up")
      .map(call => call.page), Array.from({ length: pageCount }, (_, index) => `page-${index}`));
    assert.equal(h.sent.length, pageCount * 50);
    assert.equal(h.saves.at(-1).sync_token, "caught-up");
    const windows = h.receipts.filter(receipt => receipt.status === "indexing").length;
    if (pageCount === 1) assert.equal(windows, 1);
    else assert.ok(windows > pageCount / 2, "bounded D1 rechecks finish after the feed");
  });
}

test("daily Drive runtime budget saves the page and stops between files", async () => {
  const pages = driveBacklog(2);
  const expected = ["page-0", "page-1"].flatMap(page => pages[page].changes.map(change => change.fileId));
  const h = harness({ state: { sync_token: "page-0" }, pages });
  let elapsed = 0;
  const send = h.options.sendBatches;
  h.options.sendBatches = async (args) => {
    const result = await send(args);
    if (h.sent.length === 50) elapsed = 45 * 60_000 - 1000;
    if (h.sent.length === 57) elapsed = 45 * 60_000;
    return result;
  };
  const daily = await dailyDrive(h, () => Date.parse(stamp) + elapsed, [
    { key: "gmail", run_key: "gmail", class: "machine-pull", owner: "daily-task", status: "ready" },
  ]);
  assert.equal(daily.status, "partial");
  assert.equal(daily.sources[0].status, "deferred");
  assert.equal(daily.sources[0].reason_code, "drive_continuation_budget");
  assert.equal(daily.sources[1].status, "deferred");
  assert.deepEqual(h.sent.map(doc => doc.source_id), expected.slice(0, 57));
  assert.equal(h.saves.at(-1).sync_token, "page-1");
  assert.equal(h.saves.at(-1).drive_change_page.offset, 7);
  assert.equal(h.receipts.at(-1).walk_complete, false);
  assert.equal(h.receipts.at(-1).status, "ready");
  const next = harness({ state: JSON.parse(JSON.stringify(h.saves.at(-1))), pages });
  const resumed = await dailyDrive(next, () => Date.parse(stamp) + elapsed + 60_000);
  assert.equal(resumed.status, "complete");
  assert.deepEqual(next.sent.map(doc => doc.source_id), expected.slice(57));
  assert.equal(next.saves.at(-1).sync_token, "caught-up");
});

test("daily Drive with 13 of 100 changes accepted reports catching up until exact resume", async t => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const cutoff = Date.now() - 60_000;
  const post = async (path, body) => {
    const response = await fixture.post(path, body, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const record = receipt => post("/api/admin/brain/source-receipt", receipt);
  const prior = new Date(cutoff - 12 * 3600_000).toISOString();
  await post("/api/admin/brain/source-expectation", {
    source: "drive", kind: "drive", expected_refresh_seconds: 86400,
  });
  await record({ source: "drive", kind: "drive", lane: "incremental", status: "ready",
    run_id: "prior-check", started_at: prior, completed_at: prior, walk_complete: true,
    provider_check_complete: true, files_seen: 1, docs_added: 1, docs_refused: 0, docs_failed: 0 });
  const inventory = async () => (await post("/api/admin/brain/sources", {})).sources.find(row => row.name === "drive");
  const gaps = async () => (await post("/api/rag/unified", { q: "synthetic notes", limit: 5, rerank: 0 }))
    .gaps?.filter(gap => gap.source === "drive") || [];
  const pages = driveBacklog(2);
  const h = harness({ state: { sync_token: "page-0" }, pages });
  let now = cutoff - 45 * 60_000;
  const send = h.options.sendBatches;
  h.options.sendBatches = async args => {
    const result = await send(args);
    if (h.sent.length === 13) now = cutoff;
    return result;
  };
  const daily = await dailyDrive(h, () => now);
  assert.equal(daily.sources[0].status, "deferred");
  const receipt = h.receipts.at(-1);
  assert.equal(receipt.docs_added, 13);
  assert.equal(receipt.walk_complete, false);
  assert.equal(receipt.provider_check_complete, false);
  await record({ ...receipt, run_id: "cutoff-check" });
  const pending = await inventory();
  assert.equal(pending.freshness.state, "stale");
  assert.equal(pending.receipt.latest_run.docs_added, 13);
  assert.equal(pending.receipt.last_successful_run_at, new Date(cutoff).toISOString());
  assert.equal(pending.receipt.last_check_at, prior);
  const pendingGaps = await gaps();
  assert.ok(pendingGaps.some(gap => gap.type === "coverage_stale" && /checkpoint/i.test(gap.detail)));
  assert.ok(pendingGaps.every(gap => !["sync_review", "sync_broken"].includes(gap.type)));

  const saved = JSON.parse(JSON.stringify(h.saves.at(-1)));
  assert.equal(saved.sync_token, "page-0");
  assert.equal(saved.drive_change_page.offset, 13);
  await record({ source: "drive", kind: "drive", lane: "incremental", status: "indexing",
    run_id: "completed-check", started_at: new Date(cutoff + 60_000).toISOString() });
  assert.equal((await inventory()).freshness.state, "stale");
  assert.ok((await gaps()).some(gap => gap.type === "coverage_stale" && /checkpoint/i.test(gap.detail)));
  const next = harness({ state: saved, pages });
  const resumed = await dailyDrive(next, () => cutoff + 60_000);
  assert.equal(resumed.status, "complete");
  assert.equal(next.saves.at(-1).sync_token, "caught-up");
  assert.deepEqual([...h.sent, ...next.sent].map(doc => doc.source_id),
    ["page-0", "page-1"].flatMap(page => pages[page].changes.map(change => change.fileId)));
  await record({ ...next.receipts.at(-1), run_id: "completed-check" });
  const completed = await inventory();
  assert.equal(completed.freshness.state, "ok");
  assert.equal(completed.receipt.last_check_at, new Date(cutoff + 60_000).toISOString());
  assert.ok((await gaps()).every(gap => gap.type !== "coverage_stale"));
});

test("daily Drive emits a resumable receipt when the page read consumes the budget", async () => {
  const h = harness({ state: { sync_token: "page-0" }, pages: driveBacklog(1) });
  let elapsed = 0;
  const listPage = h.options.drive.listChangePage;
  h.options.drive = { ...h.options.drive, listChangePage: async (...args) => {
    const page = await listPage(...args);
    elapsed = 45 * 60_000;
    return page;
  } };
  const daily = await dailyDrive(h, () => Date.parse(stamp) + elapsed);
  assert.equal(daily.sources[0].status, "deferred");
  assert.equal(h.saves.at(-1).drive_change_page.offset, 0);
  assert.equal(h.sent.length, 0);
  const receipt = h.receipts.at(-1);
  assert.equal(receipt.checkpoint_pending, true);
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.walk_complete, false);
  assert.equal(receipt.complete_sweep, false);
  assert.equal(receipt.provider_check_complete, false);
  assert.deepEqual([receipt.docs_added, receipt.docs_updated, receipt.docs_unchanged,
    receipt.docs_failed, receipt.docs_refused], [0, 0, 0, 0, 0]);
  assert.equal(receipt.issue_code, undefined);
});

for (const kind of ["removal", "missing ID", "both", "both with a failure"]) {
  test(`daily Drive records one owner review for ${kind}`, async () => {
    const extraFailure = kind === "both with a failure";
    const changes = [
      ...(kind !== "missing ID" ? [{ fileId: "retained", removed: true }] : []),
      ...(kind !== "removal" ? [{ removed: true }] : []),
    ];
    const h = harness({
      state: { sync_token: "page-0", done: { "drive:retained": "prior-version" },
        ...(extraFailure ? { drive_failures: { "drive:failed": { id: "failed", code: "download_limit" } } } : {}) },
      pages: extraFailure ? { "page-0": { changes, newStartPageToken: "caught-up" } }
        : { "page-0": { changes, nextPageToken: "page-1" },
          "page-1": { changes: [], nextPageToken: "page-2" },
          "page-2": { changes: [{ fileId: "later", file: file("later") }], newStartPageToken: "caught-up" } },
    });
    const daily = await dailyDrive(h);
    assert.equal(daily.status, extraFailure ? "failed" : "waiting_for_owner");
    assert.equal(daily.sources.length, 1);
    if (!extraFailure) assert.equal(daily.sources[0].reason, "Google Drive needs your review.");
    assert.equal(h.receipts.at(-1).issue_code, extraFailure ? "INGEST_FAILED" : "SAFETY_REVIEW_REQUIRED");
    assert.equal(h.receipts.at(-1).docs_failed, Number(extraFailure));
    assert.equal(h.saves.at(-1).sync_token, "caught-up");
    assert.deepEqual(h.sent.map(doc => doc.source_id), extraFailure ? [] : ["later"]);
    assert.equal(h.state.done["drive:retained"], "prior-version");
    assert.equal(Object.values(h.state.drive_failures).filter(failure => failure.code === "invalid_change_identity").length,
      Number(kind !== "removal"));
  });
}

test("daily Drive observation asks for review without assuming a removal", async () => {
  const plan = { identity: { id: "v1-drivecatchup" } };
  const options = { home: mkdtempSync(join(tmpdir(), "drive-daily-observation-")) };
  await observeDailyRun(plan.identity, async () => ({
    status: "waiting_for_owner", reason_code: "drive_owner_review",
  }), options);
  const schedule = dailyObservationStatus(plan, { enabled: false }, {}, true, options);
  assert.equal(schedule.reason_code, "drive_owner_review");
  const lines = [];
  renderDailyObservation(schedule, line => lines.push(line));
  assert.deepEqual(lines.filter(line => /review|error/u.test(line)), ["Last daily result: needs your review"]);
  await observeDailyRun(plan.identity, async () => ({ status: "complete" }), options);
  assert.equal(dailyObservationStatus(plan, { enabled: false }, {}, true, options).last_error_line, null);
});

test("first run seeds a token without a mirror walk or inventory and preserves indexed documents", async () => {
  const h = harness({ state: { done: { "drive:existing": "prior-version" } } });
  const result = await h.run();
  assert.ok(h.calls.some((c) => c.id === "startPageToken"), "token seeding decision reached");
  assert.equal(h.calls.some((c) => c.id === "full-walk"), false);
  assert.equal(h.state.sync_token, "seed-page");
  assert.equal(h.state.done["drive:existing"], "prior-version");
  assert.equal(h.sent.length, 0);
  assert.equal(result.seeded, true);
  assert.equal(h.receipts.at(-1).complete_sweep, false);
});

for (const decisions of [0, 2]) {
  test(`quiet saved Drive feed is up to date with ${decisions} retained owner decisions`, async () => {
    const targets = Array.from({ length: decisions }, (_, i) => `drive:retained-${i}`);
    const h = harness({ state: { sync_token: "old-page", ingest_removal_plan: { targets },
      done: Object.fromEntries(targets.map(uid => [uid, "prior-version"])) },
      pages: { "old-page": { changes: [], newStartPageToken: "done-page" } } });
    let output = "";
    h.options.write = value => { output += value; };
    const result = await h.run();
    assert.equal(h.calls.filter(c => c.id === "changes").length, 1, "terminal feed decision reached");
    assert.equal(result.scanned, 0);
    assert.equal(result.created + result.updated + result.unchanged + result.failed + result.refused, 0);
    assert.equal(result.feed_caught_up, true);
    assert.equal(h.state.sync_token, "done-page");
    assert.ok(h.saves.some(saved => saved.sync_token === "done-page" && !saved.drive_change_page), "advanced token was persisted");
    assert.equal(result.complete, true, "retained decisions do not block the current changes check");
    assert.equal(describeLoadResult(result).refreshSucceeded, true, "load reports this check as successful");
    assert.equal(result.pending_removals, decisions);
    for (const uid of targets) {
      assert.equal(h.state.drive_pending_removals[uid].reason, "legacy_owner_review");
      assert.equal(h.state.done[uid], "prior-version", "retained text checkpoint survives");
    }
    assert.equal(h.sent.length, 0);
    assert.equal(h.receipts.at(-1).status, "ready");
    assert.equal(h.receipts.at(-1).provider_check_complete, true);
    assert.equal(h.receipts.at(-1).complete_sweep, false, "quiet check never certifies historical coverage");
    assert.match(output, decisions ? /up to date, 2 decisions waiting/ : /up to date/);
  });
}

test("a quiet feed with a real held file failure cannot borrow retained-decision success", async () => {
  const h = harness({ state: { sync_token: "old-page",
    drive_pending_removals: { "drive:retained": { id: "retained", reason: "legacy_owner_review" } },
    drive_failures: { "drive:failed": { id: "failed", code: "download_limit", reason: "File exceeds the size limit.", retryable: false } } },
    pages: { "old-page": { changes: [], newStartPageToken: "done-page" } } });
  let output = "";
  h.options.write = value => { output += value; };
  const result = await h.run();
  assert.equal(h.calls.filter(c => c.id === "changes").length, 1, "quiet feed was actually checked");
  assert.equal(result.feed_caught_up, true);
  assert.equal(result.complete, false);
  assert.equal(result.failures, 1);
  assert.equal(h.state.drive_failures["drive:failed"].code, "download_limit");
  assert.equal(h.receipts.at(-1).status, "error");
  assert.equal(h.receipts.at(-1).docs_failed, 1);
  assert.equal(describeLoadResult(result).refreshSucceeded, false);
  assert.doesNotMatch(output, /up to date/);
});

test("the real Drive receipt lets daily verify a quiet feed without certifying historical coverage", async () => {
  const outcomes = [];
  for (const fault of [false, true]) {
    const h = harness({ state: { sync_token: "old-page", ingest_removal_plan: { targets: ["drive:retained"] },
      ...(fault ? { drive_failures: { "drive:failed": { id: "failed", code: "download_limit", retryable: false } } } : {}) },
      pages: { "old-page": { changes: [], newStartPageToken: "done-page" } } });
    const prior = "2026-10-01T00:00:00.000Z";
    let reads = 0, runs = 0;
    const daily = await runDailyRefresh({
      plan: { ready: true, enabled: true, identity: { id: "v1-quiet-drive" }, max_runtime_minutes: 45,
        sources: [{ key: "google_drive", source_names: ["drive"], run_key: "google_drive",
          class: "machine-pull", owner: "daily-task", status: "ready" }] },
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => {
        runs++;
        const result = await h.run();
        const described = describeLoadResult(result);
        return { status: described.partial ? "partial" : "complete", loaded: 1, pending_removals: result.pending_removals };
      },
      readFreshness: async () => {
        reads++;
        const receipt = h.receipts.at(-1);
        // Project the producer fields into the durable inventory shape. No
        // acceptance date is invented for a measured zero-document check.
        return { drive: { kind: "drive", last_successful_run_at: prior,
          latest_run: receipt ? { ...receipt, metrics_version: 1,
            outcome: receipt.status === "error" ? "failed" : "empty", finished_at: receipt.completed_at } : { finished_at: prior } } };
      },
      now: () => new Date(stamp),
    });
    assert.equal(runs, 1);
    assert.equal(reads, 2, "both durable observations and the real source execution reached daily verification");
    assert.equal(h.calls.filter(c => c.id === "changes").length, 1);
    assert.equal(h.saves.at(-1).sync_token, "done-page");
    assert.equal(h.receipts.at(-1).complete_sweep, false);
    assert.equal(daily.sources[0].freshness_advanced, false);
    assert.equal(daily.sources[0].last_successful_run_at_after, prior);
    outcomes.push([daily.status, daily.sources[0].check_verified, daily.sources[0].no_change]);
  }
  assert.deepEqual(outcomes, [["complete", true, true], ["failed", false, false]], "held file failures remain a red control");
});

test("a stale saved token and changed policy still use scoped changes and stable document identity", async () => {
  const active = file("active"), nested = file("nested", "child");
  const h = harness({ state: { sync_token: "old-page", drive_last_full_sweep_at: "2020-01-01T00:00:00Z", drive_policy_fingerprint: "old" },
    pages: { "old-page": { changes: [active, nested].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } },
    entries: [folder("child", "reviewed")] });
  const result = await h.run();
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "feed decision reached");
  assert.equal(h.calls.some((c) => c.id === "startPageToken" || c.id === "full-walk"), false);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["active", "nested"]);
  assert.ok(h.sent.every((e) => e.source_type === "drive"));
  assert.equal(h.sent[1].metadata.folder, "reviewed/child");
  assert.ok(h.state.done["drive:active"]);
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.complete, true);
});

test("removal, trash and moves become decisions while a prior mass-removal pause cannot block additions", async () => {
  const active = file("active"), trashed = file("trashed", "reviewed", { trashed: true }), outside = file("outside", "elsewhere");
  const h = harness({ state: { sync_token: "old-page", done: { "drive:removed": "prior", "drive:outside": "prior" },
    drive_removal_review: { issue_code: "SAFETY_REVIEW_REQUIRED", uids: ["drive:prior-review"] }, removed: { "drive:prior-review": true } },
    entries: [folder("elsewhere", "account-root")], pages: { "old-page": { changes: [
      { fileId: "removed", removed: true }, ...[trashed, outside, active].map((f) => ({ fileId: f.id, file: f })) ], newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.equal(result.scanned, 4, "all decision points reached");
  assert.equal(result.pending_removals, 4);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["active"], "green addition control");
  assert.equal(h.state.done["drive:removed"], "prior");
  assert.equal(h.state.done["drive:outside"], "prior");
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.feed_caught_up, true);
  assert.equal(result.complete, false, "retained removal evidence must not become fresh complete coverage");
});

test("fresh ancestors override stale folder membership and preserve path exclusions", async () => {
  const outside = file("moved", "child"), included = file("control");
  const h = harness({ state: { sync_token: "old-page", done: { "drive:moved": "prior" },
    drive_folders: { child: { name: "child", parents: ["reviewed"] } } },
    entries: [folder("child", "elsewhere"), folder("elsewhere", "account-root")],
    pages: { "old-page": { changes: [outside, included].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.ok(h.calls.some((c) => c.id === "child" && !c.media), "live ancestor decision reached");
  assert.equal(h.calls.some((c) => c.id === "moved" && c.media), false);
  assert.equal(h.state.drive_pending_removals["drive:moved"].reason, "left_configured_roots");
  assert.equal(result.created, 1);
});

test("large feeds stop after bounded pages and resume from the next saved page", async () => {
  const pages = {};
  for (let p = 0; p < 3; p++) pages[`page-${p}`] = {
    changes: Array.from({ length: 50 }, (_, i) => { const f = file(`item-${p}-${i}`); return { fileId: f.id, file: f }; }),
    ...(p === 2 ? { newStartPageToken: "done-page" } : { nextPageToken: `page-${p + 1}` }),
  };
  const h = harness({ state: { sync_token: "page-0" }, pages });
  const first = await h.run();
  assert.equal(first.scanned, 100);
  assert.equal(first.complete, false);
  assert.equal(h.state.sync_token, "page-2");
  assert.deepEqual(h.calls.filter((c) => c.id === "changes").map((c) => c.size), ["50", "50"]);
  const second = await h.run();
  assert.equal(second.scanned, 50);
  assert.equal(second.complete, true);
  assert.equal(h.sent.length, 150);
  assert.equal(h.state.sync_token, "done-page");
});

test("mid-file transport failure keeps the exact page and offset; resume keeps accepted work", async () => {
  let broken = true;
  const files = [file("first"), file("retry"), file("last")];
  const h = harness({ state: { sync_token: "old-page" }, fault: (url) => broken && url.pathname.endsWith("/retry") && url.searchParams.get("alt") === "media",
    pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  await assert.rejects(h.run());
  assert.ok(h.calls.some((c) => c.id === "retry" && c.media), "failed content decision reached");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["first"], "accepted green control survived");
  assert.equal(h.state.sync_token, "old-page");
  assert.equal(h.state.drive_change_page.offset, 1);
  assert.equal(h.state.drive_failures["drive:retry"].id, "retry");
  broken = false;
  const resumed = await h.run();
  assert.equal(resumed.complete, true);
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "resume consumes durable page metadata");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["first", "retry", "last"]);
  assert.equal(h.state.sync_token, "done-page");
  assert.deepEqual(h.state.drive_failures, {});
});

test("a time bound checkpoints within a page without claiming caught-up status", async () => {
  const files = [file("first"), file("second")];
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  let clock = Date.parse(stamp);
  h.options.driveNow = () => clock;
  h.options.driveLimits = { timeBudgetMs: 10 };
  const send = h.options.sendBatches;
  h.options.sendBatches = async (args) => { const result = await send(args); clock += 11; return result; };
  const first = await h.run();
  assert.equal(h.sent.length, 1, "green control reached writer");
  assert.equal(first.complete, false);
  assert.equal(h.state.sync_token, "old-page");
  assert.equal(h.state.drive_change_page.offset, 1);
  const second = await h.run();
  assert.equal(second.complete, true);
  assert.equal(h.sent.length, 2);
});

test("over-limit files have exact durable reasons and do not hold later additions", async () => {
  const files = [file("oversize", "reviewed", { size: String(drive.DOWNLOAD_LIMIT + 1) }), file("control")];
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.equal(result.scanned, 2, "size and green control decisions reached");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
  assert.equal(h.calls.some((c) => c.id === "oversize" && c.media), false);
  assert.equal(h.state.drive_failures["drive:oversize"].code, "download_limit");
  assert.match(h.state.drive_failures["drive:oversize"].reason, /over the 8MB limit/);
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.complete, false);
});

test("expired change tokens fail visibly and preserve the token without walk or reseed", async () => {
  const h = harness({ state: { sync_token: "expired-page" } });
  let reached = 0;
  h.options.drive = { ...drive, listChangePage: async () => { reached++; throw new drive.DriveError("expired", 410, "expired"); } };
  await assert.rejects(h.run(), (error) => error.status === 410);
  assert.equal(reached, 1);
  assert.equal(h.state.sync_token, "expired-page");
  assert.match(h.state.drive_incremental_error, /No full walk or reseed/);
  assert.equal(h.receipts.at(-1).walk_complete, false);
  assert.equal(h.calls.length, 0);
});

test("local Drive status reads no credential or provider and names exact failed file and reason", async () => {
  const h = harness({ state: { sync_token: "saved-page", drive_change_token_at: stamp,
    drive_pending_removals: { "drive:removed": { id: "removed" } },
    drive_failures: { "drive:oversize": { id: "oversize", name: "oversize.txt", reason: "over the 8MB limit" } } } });
  let output = "";
  h.options.write = (value) => { output += value; };
  h.options.resolveAdminKey = () => { throw new Error("credential path reached"); };
  await h.run({ status: true });
  assert.match(output, /Pending owner removal decisions: 1/);
  assert.match(output, /oversize.txt \[oversize\]: over the 8MB limit/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
});

test("explicit file limits resume within the persisted page and remain partial in load", async () => {
  const files = [file("first"), file("last")];
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const first = await h.run({ limit: "1" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.state.drive_change_page.offset, 1);
  assert.equal(describeLoadResult(first).refreshSucceeded, false);
  const last = await h.run({ limit: "1" });
  assert.equal(last.complete, true);
  assert.equal(describeLoadResult(last).refreshSucceeded, true);
  assert.equal(h.sent.length, 2);
});

test("a split-document rejection keeps its file checkpoint unaccepted and retries every part", async () => {
  const f = file("split"), h = harness({ state: { sync_token: "old-page" },
    pages: { "old-page": { changes: [{ fileId: f.id, file: f }], newStartPageToken: "done-page" },
      "done-page": { changes:[],newStartPageToken:"done-page" } } });
  const lib = h.options.ingestLib;
  h.options.ingestLib = async () => ({ ...await lib(), splitOversized: (e) => [e, { ...e, source_id: `${e.source_id}:part:2` }] });
  let reject = true, reached = 0;
  const send = h.options.sendBatches;
  h.options.sendBatches = async (args) => {
    reached++;
    if (!reject) return send(args);
    for (const item of args.groups.flat()) args.onResult(item, { status: item.envelope.source_id.includes(":part:") ? "failed" : "created" });
    return { created: 1, failed: 1 };
  };
  // R6 settles the feed independently from this durable retry. Logical
  // acceptance still requires every part, and an ordinary pass retries it.
  const failed = await h.run();
  assert.equal(failed.complete, false);
  assert.equal(h.state.drive_failures['drive:split'].code, 'ingest_write_failed');
  assert.equal(reached, 1, "real writer decision reached");
  assert.equal(h.state.done["drive:split"], undefined);
  assert.equal(h.state.sync_token, "done-page");
  reject = false;
  const resumed = await h.run();
  assert.equal(resumed.feed_caught_up, true);
  assert.equal(resumed.complete, false, "obsolete representation review stays visible");
  assert.equal(resumed.pending_removals, 1);
  assert.equal(resumed.created, 1, "file count must not count physical parts twice");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["split", "split:part:2"]);
});

for (const [label, outcome] of [
  ['unsupported', { skip:{ code:'unsupported_type',reason:'No supported text extractor.' } }],
  ['unreadable', { skip:{ code:'extraction_refused',reason:'The source could not be read.' } }],
  ['too large', { skip:{ code:'oversize',reason:'Over the bounded download limit.' } }],
]) test(`R3 fail-safe: ${label} remains visible while the token and later changes advance`, async()=>{
  const h=harness({ state:{ sync_token:'old-page' },pages:{ 'old-page':{
    changes:[file('held'),file('control')].map(f=>({ fileId:f.id,file:f })),newStartPageToken:'done-page' } } });
  const connector=h.options.drive;
  let decisions=0;
  h.options.drive={ ...connector,toEnvelope:async(get,f,config)=>{
    if(f.id==='held'){ decisions++; return outcome; } return connector.toEnvelope(get,f,config);
  } };
  const result=await h.run();
  assert.equal(decisions,1,'permanent extraction decision reached');
  assert.equal(result.skipped,1); assert.equal(result.complete,false); assert.equal(result.feed_caught_up,true);
  assert.equal(h.state.sync_token,'done-page'); assert.deepEqual(h.sent.map(e=>e.source_id),['control']);
  assert.equal(h.state.drive_failures['drive:held'].reason,outcome.skip.reason);
  assert.equal(h.state.drive_failures['drive:held'].retryable,false);
});

for(const [label,first,second,settles] of [
  ['known admission', { code:'retained_prior_revision_limit',retryable:false,retry_class:'owner_recovery' },null,true],
  ['unknown nonretryable code', { code:'unknown_failure',retryable:false,retry_class:'owner_recovery' },null,false],
  ['contradictory retry flag', { code:'retained_prior_revision_limit',retryable:true,retry_class:'retry' },null,false],
  ['mixed transient and admission', { code:'retained_prior_revision_limit',retryable:false,retry_class:'owner_recovery' },
    { code:'ingest_write_failed',retryable:true,retry_class:'retry' },false],
]) test(`R3 split receipts: ${label} has an explicit cursor decision and an accepted control`, async()=>{
  const h=harness({state:{sync_token:'old-page'},pages:{'old-page':{
    changes:[file('held'),file('control')].map(f=>({fileId:f.id,file:f})),newStartPageToken:'done-page'}}});
  const lib=h.options.ingestLib;
  h.options.ingestLib=async()=>({...await lib(),splitOversized:e=>e.source_id==='held'&&second
    ? [e,{...e,source_id:`${e.source_id}:part:2`}]:[e]});
  const send=h.options.sendBatches; let decisions=0;
  h.options.sendBatches=async args=>{
    if(args.groups[0][0].envelope.source_id==='control') return send(args);
    for(const [i,item] of args.groups.flat().entries()){
      decisions++; args.onResult(item,{status:'failed',...(i===0?first:second),error:'Untrusted storage text is not a recovery explanation.'});
    }
    return {failed:second?2:1};
  };
  await h.run();
  assert.equal(decisions,second?2:1,'all failed-part decisions reached');
  assert.equal(h.state.sync_token,'done-page');
  assert.equal(h.sent.length,1,'durable retry gaps permit the healthy later control');
  assert.equal(h.state.drive_failures['drive:held'].retryable,!settles);
  assert.equal(h.state.drive_failures['drive:held'].parts.length,second?2:1);
  assert.doesNotMatch(h.state.drive_failures['drive:held'].reason,/Untrusted storage/);
  if(!settles){
    h.options.drive={...h.options.drive,listChangePage:async()=>({changes:[],nextToken:'done-page',terminal:true})};
    h.options.sendBatches=send; assert.equal((await h.run()).created,1,'ordinary retry repairs only the failed identity');
    assert.equal(h.state.drive_failures['drive:held'],undefined);
  }
});

test("reset retries held failures without discarding accepted versions or reseeding the feed", async () => {
  const h = harness({ state: { sync_token: "saved-page", done: { "drive:existing": "prior-version" },
    drive_failures: { "drive:held": { id: "held", name: "held.txt", reason: "prior failure" } } },
    entries: [file("held")], pages: { "saved-page": { changes: [], newStartPageToken: "done-page" } } });
  const result = await h.run({ reset: true });
  assert.ok(h.calls.some((c) => c.id === "held" && c.media), "retry decision reached");
  assert.equal(h.state.done["drive:existing"], "prior-version");
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(h.calls.some((c) => c.id === "startPageToken"), false);
  assert.equal(result.complete, true);
});

test("path exclusions use the selected root path and hold the old copy without downloading", async () => {
  const h = harness({ state: { sync_token: "old-page", done: { "drive:excluded": "prior" } }, entries: [folder("sealed", "reviewed")],
    pages: { "old-page": { changes: [file("excluded", "sealed"), file("control")].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  h.manifest.corpora.google_drive.exclude_paths = ["reviewed/sealed"];
  const result = await h.run();
  assert.equal(result.scanned, 2);
  assert.equal(h.state.drive_pending_removals["drive:excluded"].reason, "source_policy");
  assert.equal(h.state.done["drive:excluded"], "prior");
  assert.equal(h.calls.some((c) => c.id === "excluded" && c.media), false);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
});

test("direct My Drive files are scoped without following unselected child folders", async () => {
  const h = harness({ state: { sync_token: "old-page" }, entries: [folder("unselected", "account-root")],
    pages: { "old-page": { changes: [file("loose", "account-root"), file("outside", "unselected")].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  h.manifest.corpora.google_drive.root_folder_ids = [];
  h.manifest.corpora.google_drive.include_my_drive_root_files = true;
  const result = await h.run();
  assert.equal(result.scanned, 2);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["loose"]);
  assert.equal(h.sent[0].metadata.folder, null);
  assert.equal(h.calls.some((c) => c.id === "outside" && c.media), false);
});

for (const invalid of [
  { changes: [], nextPageToken: "old-page" },
  { changes: [], newStartPageToken: " spaced " },
  { changes: [{ fileId: "wrong", file: file("other") }], nextPageToken: "next", newStartPageToken: "done-page" },
  { changes: [ { fileId: "missing-metadata" } ], newStartPageToken: "old-page" },
]) test("invalid feed evidence cannot advance the checkpoint or enter the writer", async () => {
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": invalid } });
  await assert.rejects(h.run());
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "validation decision reached");
  assert.equal(h.state.sync_token, "old-page");
  assert.equal(h.sent.length, 0);
  const control = harness({ state: { sync_token: "old-page" }, pages: { "old-page": {
    changes: [{ fileId: "control", file: file("control") }], newStartPageToken: "done-page" } } });
  assert.equal((await control.run()).created, 1, "green feed control");
});

test("daily plan declares the same add/update-only Drive mode", async () => {
  const h = harness();
  const plan = await planDailyRefresh({ m: h.manifest, manifestPath: "manifest.json", principal: "fixture-principal",
    localTimezone: "UTC", planLoadFn: async () => [{ key: "google_drive", status: "ready", legs: [{ source: "drive" }] }] });
  assert.equal(plan.sources[0].key, "google_drive");
  assert.equal(plan.sources[0].sync_mode, "incremental_add_update_only");
  assert.equal(plan.sources[0].automatic_removals, false);
});

test("an empty terminal page may retain its token and still prove a no-change check", async () => {
  const h = harness({ state: { sync_token: "same-page" }, pages: { "same-page": { changes: [], newStartPageToken: "same-page" } } });
  const result = await h.run();
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "no-change decision reached");
  assert.equal(result.complete, true);
  assert.equal(result.feed_caught_up, true);
  assert.equal(h.state.sync_token, "same-page");
  assert.equal(h.state.drive_change_token_at, stamp);
  const control = harness({ state: { sync_token: "same-page" }, pages: { "same-page": {
    changes: [{ fileId: "control", file: file("control") }], newStartPageToken: "next-page" } } });
  assert.equal((await control.run()).created, 1);
});

test("a resumed page cannot download a file that has since moved out of scope", async () => {
  const h = harness({ state: { sync_token: "old-page", done: { "drive:moved": "prior" } },
    entries: [file("moved", "outside"), folder("outside", "account-root")],
    pages: { "old-page": { changes: [file("moved"), file("control")].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.equal(result.scanned, 2, "both current scope decisions reached");
  assert.equal(h.calls.some((c) => c.id === "moved" && c.media), false);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
  assert.equal(h.state.drive_pending_removals["drive:moved"].reason, "left_configured_roots");
});

test("a file no longer returned by metadata lookup is retained for review without holding later additions", async () => {
  const h = harness({ state: { sync_token: "old-page", done: { "drive:missing": "prior-version" } }, pages: { "old-page": {
    changes: [{ fileId: "missing", file: file("missing") }], nextPageToken: "next-page" },
  "next-page": { changes: [], nextPageToken: "last-page" },
  "last-page": { changes: [{ fileId: "control", file: file("control") }], newStartPageToken: "done-page" } } });
  const connector = h.options.drive;
  let reached = 0;
  h.options.drive = { ...connector, getFileMetadata: async (get, id) => {
    if (id === "missing") { reached++; throw new drive.DriveError("file not returned", 404, "notFound"); }
    return connector.getFileMetadata(get, id);
  } };
  const daily = await dailyDrive(h);
  const result = h.state.drive_incremental_last_run;
  assert.equal(reached, 1, "current metadata decision reached");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
  assert.equal(h.state.done["drive:missing"], "prior-version");
  assert.equal(h.state.drive_failures["drive:missing"].code, "file_unavailable");
  assert.equal(h.state.drive_pending_removals["drive:missing"].reason, "removed_or_access_lost");
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.feed_caught_up, true);
  assert.equal(result.complete, false);
  assert.deepEqual(daily.sources.map(source => [source.status, source.reason]), [
    ["waiting_for_owner", "Google Drive needs your review."],
  ]);
  assert.equal(h.receipts.at(-1).issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(h.receipts.at(-1).docs_failed, 0);
});

for (const [label, bytes] of [["malformed JSON", "{"], ["missing done", JSON.stringify({ sync_token: "prior-page" })],
  ["invalid cursor", JSON.stringify({ done: {}, sync_token: 42 })]]) {
  test(`DRIVE-R3: existing ${label} is preserved by the real loader and command`, async () => {
    const h = harness();
    const checkpoint = join(h.manifestPath, "..", ".brain-ingest-drive.json");
    writeFileSync(checkpoint, bytes);
    let decisions = 0;
    h.options.ingestLib = async () => ({ batchStream, splitOversized, prefetch,
      loadState: (path, options) => { decisions++; return realLoadState(path, options); }, saveState: realSaveState });
    await assert.rejects(h.run(), /checkpoint.*recovery|checkpoint.*invalid/i);
    assert.equal(decisions, 1, "real checkpoint recovery decision reached");
    assert.equal(readFileSync(checkpoint, "utf8"), bytes, "failed checkpoint never overwritten");
    assert.equal(h.calls.length, 0, "no token reseed or provider request");
    assert.equal(h.receipts.length, 0, "no false source receipt");
  });
}

test("DRIVE-R3: real loader distinguishes a missing checkpoint seed from a valid cursor resume", async () => {
  for (const prior of [null, { version:1, done:{}, skipped:{}, sync_token:"prior-page" }]) {
    const h = harness({ pages: { "prior-page": { changes:[], newStartPageToken:"next-page" } } });
    const checkpoint = join(h.manifestPath, "..", ".brain-ingest-drive.json");
    if (prior) writeFileSync(checkpoint, JSON.stringify(prior));
    h.options.ingestLib = async () => ({ batchStream, splitOversized, prefetch, loadState:realLoadState, saveState:realSaveState });
    await h.run();
    assert.equal(h.calls.some(c => c.id === "startPageToken"), !prior);
    assert.equal(realLoadState(checkpoint).sync_token, prior ? "next-page" : "seed-page");
  }
});

test('an older or interrupted Worker update is rejected before checkpoint or source writes', async () => {
  const h = harness();
  let compatibility = 0;
  h.options.verifyDriveIncrementalWorker = async () => { compatibility++; throw new Error('retained revision protocol unavailable'); };
  await assert.rejects(h.run(), /retained revision protocol/);
  assert.equal(compatibility, 1, 'paired-runtime decision reached');
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
  assert.equal(h.saves.length, 0);
  const control = harness();
  control.options.verifyDriveIncrementalWorker = async () => { compatibility++; };
  assert.equal((await control.run()).seeded, true, 'compatible Worker green control');
  assert.equal(compatibility, 2);
});


test("DRIVE-R3: an existing broken checkpoint link is a recovery condition, never first use", async () => {
  const h = harness();
  const checkpoint = join(h.manifestPath, "..", ".brain-ingest-drive.json");
  symlinkSync(join(h.manifestPath, "..", "absent-target"), checkpoint, process.platform === 'win32' ? 'junction' : 'file');
  let reads = 0;
  h.options.ingestLib = async () => ({ batchStream, splitOversized, prefetch,
    loadState: (path, options) => { reads++; return realLoadState(path, options); }, saveState: realSaveState });
  await assert.rejects(h.run(), /checkpoint.*recovery/i);
  assert.equal(reads, 1, "checkpoint artifact decision reached");
  assert.equal(lstatSync(checkpoint).isSymbolicLink(), true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
});

test('mutating full-walk review cannot reopen an unbounded legacy writer', async () => {
  const h = harness();
  let credentials = 0;
  h.options.resolveAdminKey = () => { credentials++; return 'unreachable'; };
  await assert.rejects(h.run({ 'full-walk-review':true }), error =>
    error.supportCode === 'CONFIG_INVALID' && /full-walk.*read-only/i.test(error.message));
  assert.equal(credentials, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
  assert.equal(h.saves.length, 0);
  const control = harness();
  assert.equal((await control.run()).seeded, true, 'bounded incremental writer control');
});
