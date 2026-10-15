import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { cmdSources, dailyFreshnessRows } from "../../brain.mjs";
import { coverageGapReport, freshnessReport, sourceInventory, sourceFreshnessCounts } from "../src/lib/store-d1.js";
import { providerNoChangeCheckAt } from "../src/lib/source-receipt.js";
import { createProductFixture } from "./product-contract-fixture.mjs";

const ACCEPTED = "2026-07-04T08:00:00.000Z";
const STARTED = "2026-07-07T08:00:00.000Z";
const FINISHED = "2026-07-07T08:10:00.000Z";
const NOW = Date.parse(FINISHED) + 3 * 3600000;
const quietKinds = [
  { kind: "imessage", files_seen: 5, cadence: 3600 },
  { kind: "whatsapp", files_seen: 0, cadence: 3600 },
  { kind: "whatsapp", files_seen: 4, cadence: 3600 },
  { kind: "drive" }, { kind: "gmail" }, { kind: "imap" },
  { kind: "calendar", provider_check_complete: true },
  { kind: "microsoft", provider_check_complete: true },
];

async function post(fixture, path, body) {
  const response = await fixture.post(path, body, { "X-Admin-Key": fixture.env.ADMIN_KEY });
  assert.equal(response.status, 200, `${path} reached the route decision`);
  return response.json();
}

async function scenario(t, { kind = "drive", cadence = 86400,
  reportAfterHours = cadence === 3600 ? 1 : 3, priorReview = false, ...overrides } = {}) {
  const now = Date.parse(FINISHED) + reportAfterHours * 3600000;
  t.mock.method(Date, "now", () => now);
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const source = "sample-source";
  await post(fixture, "/api/admin/brain/source-expectation", {
    source, kind, expected_refresh_seconds: cadence,
  });
  const receipt = {
    source, kind, status: "ready", lane: "incremental", walk_complete: true,
    complete_sweep: false, files_seen: 0, docs_added: 0, docs_updated: 0,
    docs_unchanged: 0, docs_refused: 0, docs_failed: 0,
    started_at: STARTED, completed_at: FINISHED,
  };
  await post(fixture, "/api/admin/brain/source-receipt", {
    ...receipt, run_id: "accepted-run", files_seen: 2, docs_added: 2,
    started_at: ACCEPTED, completed_at: ACCEPTED,
  });
  if (priorReview) {
    await post(fixture, "/api/admin/brain/source-receipt", {
      ...receipt, run_id: "prior-review", walk_complete: false,
      started_at: "2026-07-07T07:00:00.000Z", completed_at: "2026-07-07T07:01:00.000Z",
    });
    assert.equal(fixture.first("SELECT stale_reason FROM sources WHERE name=?", source).stale_reason, "NO_VERIFIED_WORK");
  }
  const before = fixture.first("SELECT * FROM sources WHERE name=?", source);
  const sent = { ...receipt, run_id: "latest-run", ...overrides };
  await post(fixture, "/api/admin/brain/source-receipt", sent);
  const run = fixture.first("SELECT * FROM sync_runs WHERE run_id=?", sent.run_id);
  assert.ok(run, "the persisted receipt decision was reached");
  assert.equal(run.metrics_version, sent.docs_refused === undefined || sent.docs_failed === undefined ? 0 : 1);
  assert.equal(run.walk_complete, sent.walk_complete ? 1 : 0);
  const row = fixture.first("SELECT * FROM sources WHERE name=?", source);
  const report = await coverageGapReport(fixture.env, { now });
  assert.equal(report.unavailable, false);
  const readsBefore = fixture.seen.sql.length;
  const unified = await post(fixture, "/api/rag/unified", { q: "synthetic notes", limit: 5, rerank: 0 });
  assert.ok(fixture.seen.sql.slice(readsBefore).some(sql => /SELECT inventory\.\*/.test(sql)),
    "unified reached the source coverage decision even when it omits an empty gaps field");
  const direct = report.gaps.filter(gap => gap.source === source);
  const routed = (unified.gaps || []).filter(gap => gap.source === source);
  assert.deepEqual(routed, direct, "the real retrieval route preserves source gaps");
  const fresh = (await freshnessReport(fixture.env, { now })).sources.find(row => row.name === source);
  const inventoryRead = await sourceInventory(fixture.env, { now });
  const inventory = { as_of: new Date(now).toISOString(), sources: inventoryRead.rows };
  const item = inventory.sources.find(row => row.name === source);
  assert.ok(fresh && item, "both owner surfaces reached this source");
  return { fixture, source, before, row, run, now, gaps: direct, fresh, item, inventory };
}

for (const arm of quietKinds) {
  test(`quiet ${arm.kind} walk with ${arm.files_seen || 0} rows is current without invented work`, async t => {
    const f = await scenario(t, arm);
    assert.equal(f.gaps.some(g => ["sync_review", "coverage_stale", "never_synced"].includes(g.type)), false,
      JSON.stringify(f.gaps));
    assert.equal(f.row.stale_reason, null);
    assert.equal(f.row.last_ingest_at, FINISHED);
    assert.equal(f.row.document_count, f.before.document_count);
    assert.equal(f.row.last_complete_sweep_at, f.before.last_complete_sweep_at);
    assert.equal(f.fresh.state, "ok");
    assert.equal(f.item.freshness.state, "ok");
    assert.match(f.item.freshness.reason, /checked, no changes/i);
    assert.equal(f.item.receipt.last_check_at, FINISHED);
    assert.equal(f.item.receipt.last_successful_run_at, ACCEPTED);
    assert.equal(f.item.receipt.latest_run.outcome, "empty", "run outcome remains measured zero work");
    assert.notEqual(f.fresh.coverage.history.state, "needs_attention");
    assert.notEqual(f.item.freshness.coverage.history.state, "needs_attention");
    const daily = dailyFreshnessRows({ sources: [{ key: f.source }] }, f.inventory);
    assert.equal(daily.length, 1);
    assert.equal(daily[0].last_run_outcome, "no_change");
    assert.equal(daily[0].current_state, "checked");
    f.fixture.seen.sql.length = 0;
    assert.deepEqual(await sourceFreshnessCounts(f.fixture.env, { now: f.now }), { total: 1, stale: 0, unscheduled: 0 });
    assert.equal(f.fixture.seen.sql.length, 1, "health counts retain one D1 statement");
  });
}

const negativeArms = [
  { label: "bounded", kind: "imessage", walk_complete: false },
  { label: "all refused", kind: "gmail", files_seen: 3, docs_refused: 3 },
  { label: "failed", kind: "imessage", docs_failed: 1, expected: "broken" },
  { label: "export folder", kind: "upload" },
  { label: "calendar without boundary", kind: "calendar" },
  { label: "microsoft without boundary", kind: "microsoft" },
  { label: "unsupported kind", kind: "slack" },
  { label: "provider saw rows", kind: "drive", files_seen: 1 },
  { label: "refusal reason", kind: "gmail", refusal_reason: "synthetic refusal" },
  { label: "reversed clock", kind: "imessage", started_at: "2026-07-07T09:00:00.000Z" },
];
for (const { label, expected = "review", ...arm } of negativeArms) {
  test(`${label} retains its existing flagged state`, async t => {
    const f = await scenario(t, arm);
    assert.equal(f.fresh.state, expected);
    assert.equal(f.item.freshness.state, expected);
    assert.ok(f.gaps.some(g => g.type === (expected === "broken" ? "sync_broken" : "sync_review")));
    assert.equal(f.row.last_ingest_at, ACCEPTED);
    assert.equal(providerNoChangeCheckAt(arm.kind, f.item.receipt.latest_run), null);
  });
}

test("legacy unmeasured receipt retains its existing success behavior", async t => {
  const f = await scenario(t, { docs_refused: undefined, docs_failed: undefined });
  assert.equal(f.run.metrics_version, 0);
  assert.equal(f.fresh.state, "ok");
  assert.equal(f.row.last_ingest_at, FINISHED);
  assert.equal(f.item.receipt.last_successful_run_at, FINISHED);
  assert.equal(providerNoChangeCheckAt("drive", f.item.receipt.latest_run), null);
});

test("accepted work is green and a real safety review keeps its wording", async t => {
  const accepted = await scenario(t, { docs_added: 3, files_seen: 3, complete_sweep: true });
  assert.deepEqual(accepted.gaps, []);
  assert.equal(accepted.fresh.state, "ok");
  const safety = await scenario(t, { kind: "calendar", status: "error", issue_code: "SAFETY_REVIEW_REQUIRED" });
  assert.equal(safety.fresh.state, "review");
  assert.ok(safety.gaps.some(g => g.type === "sync_review" && /paused for safety review/.test(g.detail)));
});

test("quiet and bounded arms reach different decisions", async t => {
  const quiet = await scenario(t, { kind: "imessage" });
  const bounded = await scenario(t, { kind: "imessage", walk_complete: false });
  assert.notEqual(quiet.fresh.state, bounded.fresh.state, "uniform outcomes invalidate the harness");
  for (const f of [quiet, bounded]) assert.ok(f.gaps.every(g => !/paused|safety review/i.test(g.detail)));
});


test("only a genuine safety review uses pause wording", async t => {
  for (const { label, expected, ...arm } of negativeArms) {
    const f = await scenario(t, arm);
    assert.ok(f.gaps.length > 0, `${label} reached a coverage gap`);
    assert.ok(f.gaps.every(g => !/paused|safety review/i.test(g.detail)), label);
  }
});


async function sourceOutput(t, fixture) {
  const directory = realpathSync.native(mkdtempSync(join(process.env.HOME, "sync-cli-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = join(directory, "brain.manifest.json");
  const keyFile = join(directory, "fixture-admin-key");
  writeFileSync(manifest, JSON.stringify({ brain: { domain: "source-fixture.invalid" } }));
  writeFileSync(keyFile, fixture.env.ADMIN_KEY, { mode: 0o600 });
  const lines = [];
  const original = console.log;
  let requests = 0;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    const inventory = await cmdSources(manifest, {
      flags: {}, resolveAdminKey: () => readFileSync(keyFile, "utf8"),
      fetchImpl: async (url, init) => {
        requests++;
        return fixture.worker.fetch(new Request(url, init), fixture.env, { waitUntil() {} });
      },
    });
    assert.ok(requests > 0, "the CLI read the real inventory route");
    return { inventory, output: lines.join("\n") };
  } finally { console.log = original; }
}

test("folder and historical wording survives inventory merging, CLI, and daily rows", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  await post(fixture, "/api/admin/brain/source-expectation", {
    source: "sample-archive", kind: "upload", expected_refresh_seconds: null,
  });
  await post(fixture, "/api/admin/brain/source-receipt", {
    source: "sample-archive", kind: "upload", status: "ready", run_id: "archive-load",
    started_at: ACCEPTED, completed_at: ACCEPTED, walk_complete: true,
    files_seen: 2, docs_added: 2, docs_updated: 0, docs_unchanged: 0, docs_refused: 0, docs_failed: 0,
  });
  assert.equal(fixture.first("SELECT metrics_version FROM sync_runs WHERE run_id='archive-load'").metrics_version, 1);
  for (const historical of [false, true]) {
    if (historical) {
      await post(fixture, "/api/admin/brain/source-receipt", {
        source: "sample-archive", kind: "upload", status: "error", run_id: "archive-failure",
        started_at: FINISHED, completed_at: FINISHED, walk_complete: false,
        files_seen: 1, docs_added: 0, docs_updated: 0, docs_unchanged: 0, docs_refused: 0, docs_failed: 1,
      });
      assert.equal(fixture.first("SELECT status FROM sources WHERE name='sample-archive'").status, "error");
      await post(fixture, "/api/admin/brain/source-retire", { source: "sample-archive", retired: true });
    }
    const reason = historical
      ? `historical: kept and searchable, not refreshed (retired by the owner on ${new Date(NOW).toISOString().slice(0, 10)})`
      : `updated when you add a file; last loaded ${ACCEPTED.slice(0, 10)}`;
    const read = await sourceOutput(t, fixture);
    const row = read.inventory.sources[0];
    assert.equal(row.freshness.state, "manual");
    assert.equal(row.freshness.reason, reason);
    assert.ok(read.output.includes(reason));
    assert.doesNotMatch(read.output, /manual,|stale/i);
    const daily = dailyFreshnessRows({ sources: [{ key: "sample-archive" }] }, read.inventory);
    assert.equal(daily.length, 1);
    assert.equal(daily[0].current_state, "manual");
    assert.equal(daily[0].reason, reason);
    assert.equal(daily[0].next_run, reason);
  }
});

test("quiet CLI last ingest stays the last accepted-work receipt", async t => {
  const f = await scenario(t, { kind: "drive" });
  const read = await sourceOutput(t, f.fixture);
  assert.ok(read.output.includes(`last ingest ${ACCEPTED}`));
  assert.ok(read.output.includes(`checked ${FINISHED}; no changes`));
});


for (const kind of ["imessage", "whatsapp"]) {
  test(`${kind} quiet check still becomes stale after three missed hourly intervals`, async t => {
    const f = await scenario(t, { kind, cadence: 3600, reportAfterHours: 3 });
    assert.equal(f.row.stale_reason, null, "the quiet receipt cleared the operational review");
    assert.equal(f.row.last_ingest_at, FINISHED);
    assert.equal(f.fresh.state, "stale");
    assert.equal(f.item.freshness.state, "stale");
    assert.ok(f.gaps.some(g => g.type === "coverage_stale" && /about every 1 hour/.test(g.detail)));
    assert.ok(f.gaps.every(g => g.type !== "sync_review" && !/paused|safety review/i.test(g.detail)));
  });
}


test("the next certified quiet pass clears an existing zero-work review without a backfill", async t => {
  const f = await scenario(t, { kind: "imessage", cadence: 3600, priorReview: true });
  assert.equal(f.before.stale_reason, "NO_VERIFIED_WORK");
  assert.equal(f.row.stale_reason, null);
  assert.equal(f.fresh.state, "ok");
  assert.equal(f.item.receipt.last_successful_run_at, ACCEPTED);
  assert.ok(f.gaps.every(gap => gap.type !== "sync_review"));
});

test("the named stuck Drive run is superseded when the retry opens a new run", async t => {
  t.mock.method(Date, "now", () => NOW);
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  await post(fixture, "/api/admin/brain/source-expectation", {
    source: "sample-drive", kind: "drive", expected_refresh_seconds: 86400,
  });
  const oldStart = new Date(NOW - 9 * 3600000).toISOString();
  await post(fixture, "/api/admin/brain/source-receipt", {
    source: "sample-drive", kind: "drive", status: "indexing", run_id: "stuck-run", started_at: oldStart,
  });
  assert.equal(fixture.first("SELECT started_at FROM sync_runs WHERE run_id='stuck-run'").started_at, Date.parse(oldStart));
  const before = await freshnessReport(fixture.env, { now: NOW });
  assert.equal(before.sources[0].state, "broken");
  assert.ok(before.sources[0].reason.includes(oldStart));
  await post(fixture, "/api/admin/brain/source-receipt", {
    source: "sample-drive", kind: "drive", status: "indexing", run_id: "retry-run", started_at: new Date(NOW).toISOString(),
  });
  const oldRun = fixture.first("SELECT * FROM sync_runs WHERE run_id='stuck-run'");
  assert.equal(oldRun.finished_at, NOW);
  assert.equal(oldRun.error, "superseded by a later sync attempt");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM sync_runs WHERE finished_at IS NULL").n, 1);
  const after = await freshnessReport(fixture.env, { now: NOW });
  assert.equal(after.sources[0].state, "indexing");
});
