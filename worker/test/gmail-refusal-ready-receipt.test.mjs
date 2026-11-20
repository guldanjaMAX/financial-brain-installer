import assert from "node:assert/strict";
import { test } from "node:test";

import { gmailRefusalReadyReceipt } from "../../test/fixtures/gmail-refusal-receipt.mjs";
import { coverageGapReport } from "../src/lib/store-d1.js";
import { createProductFixture } from "./product-contract-fixture.mjs";

const STARTED_AT = "2026-09-29T00:00:00.000Z";
const COMPLETED_AT = "2026-09-29T01:00:00.000Z";
const REPORT_NOW = Date.parse("2026-09-30T12:00:00.000Z");
const headers = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });

async function post(fixture, path, body) {
  const response = await fixture.post(path, body, headers(fixture));
  assert.equal(response.status, 200, await response.text());
}

async function expectGmail(fixture) {
  await post(fixture, "/api/admin/brain/source-expectation", {
    source: "gmail",
    kind: "gmail",
    expected_refresh_seconds: 86400,
  });
}

async function openRun(fixture, runId) {
  await post(fixture, "/api/admin/brain/source-receipt", {
    source: "gmail",
    kind: "gmail",
    status: "indexing",
    run_id: runId,
    lane: "incremental",
    started_at: STARTED_AT,
  });
}

async function reportFor(fixture) {
  const report = await coverageGapReport(fixture.env, {
    now: REPORT_NOW,
    allowedSources: ["gmail"],
  });
  assert.equal(report.unavailable, false);
  assert.ok(report.gaps.some((gap) => gap.source === "gmail" && gap.type === "history_unproven"),
    JSON.stringify(report.gaps));
  return report;
}

async function closeOldError(fixture, runId) {
  await post(fixture, "/api/admin/brain/source-receipt", {
    source: "gmail",
    kind: "gmail",
    status: "error",
    run_id: runId,
    lane: "incremental",
    started_at: STARTED_AT,
    completed_at: COMPLETED_AT,
    complete_sweep: false,
    walk_complete: true,
    files_seen: 2,
    docs_added: 0,
    docs_updated: 0,
    docs_unchanged: 0,
    docs_refused: 2,
    docs_failed: 0,
    issue_code: "INPUT_REFUSED",
  });
}

async function closeReady(fixture, runId, completedAt = COMPLETED_AT, accepted = 0) {
  await post(fixture, "/api/admin/brain/source-receipt", { ...gmailRefusalReadyReceipt({
    runId,
    startedAt: STARTED_AT,
    completedAt,
  }), docs_added: accepted, files_seen: 2 + accepted });
}

test("a completed all-refused Gmail check proves freshness without inventing accepted work", async (t) => {
  const control = await createProductFixture();
  t.after(() => control.close());
  await expectGmail(control);
  await openRun(control, "run_gmail_refusal_control");
  await closeOldError(control, "run_gmail_refusal_control");

  const controlReport = await reportFor(control);
  const controlTypes = controlReport.gaps.map((gap) => gap.type);
  assert.ok(controlTypes.includes("sync_broken"), JSON.stringify(controlReport.gaps));
  assert.ok(controlTypes.includes("never_synced"), JSON.stringify(controlReport.gaps));

  const ready = await createProductFixture();
  t.after(() => ready.close());
  await expectGmail(ready);
  await openRun(ready, "run_gmail_refusal_ready");
  await closeReady(ready, "run_gmail_refusal_ready");

  const readyReport = await reportFor(ready);
  const readyTypes = readyReport.gaps.map((gap) => gap.type);
  assert.equal(readyTypes.includes("sync_broken"), false, JSON.stringify(readyReport.gaps));
  assert.equal(readyTypes.includes("never_synced"), false, JSON.stringify(readyReport.gaps));
  assert.equal(readyTypes.includes("sync_review"), false, JSON.stringify(readyReport.gaps));
  const source = ready.first("SELECT last_ingest_at,last_complete_sweep_at FROM sources WHERE name=?", "gmail");
  assert.equal(source.last_ingest_at, COMPLETED_AT, "completed provider check records freshness");
  assert.equal(source.last_complete_sweep_at, null, "refused content never earns complete history");
  const readyRun = ready.first("SELECT docs_refused,docs_failed FROM sync_runs WHERE run_id=?",
    "run_gmail_refusal_ready");
  assert.deepEqual({ ...readyRun }, { docs_refused: 2, docs_failed: 0 });

  await openRun(control, "run_gmail_refusal_recovery");
  await closeReady(control, "run_gmail_refusal_recovery", "2026-09-29T02:00:00.000Z", 1);
  const recoveryReport = await reportFor(control);
  const recoveryTypes = recoveryReport.gaps.map((gap) => gap.type);
  assert.equal(recoveryTypes.includes("sync_broken"), false, JSON.stringify(recoveryReport.gaps));
  assert.equal(recoveryTypes.includes("never_synced"), false, JSON.stringify(recoveryReport.gaps));
  assert.equal(recoveryTypes.includes("sync_review"), false, JSON.stringify(recoveryReport.gaps));
  const recoveryRun = control.first("SELECT docs_refused,docs_failed FROM sync_runs WHERE run_id=?",
    "run_gmail_refusal_recovery");
  assert.deepEqual({ ...recoveryRun }, { docs_refused: 2, docs_failed: 0 });
});

for (const control of ["missing_boundary", "failed_read", "unknown_reason"]) {
  test(`a Gmail refusal cannot hide ${control}`, async t => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    await expectGmail(fixture);
    const runId = `run_control_${control}`;
    await openRun(fixture, runId);
    const receipt = gmailRefusalReadyReceipt({ runId, startedAt: STARTED_AT, completedAt: COMPLETED_AT });
    if (control === "missing_boundary") delete receipt.provider_check_complete;
    if (control === "failed_read") receipt.docs_failed = 1;
    if (control === "unknown_reason") receipt.refusal_reason = "unrecognized";
    await post(fixture, "/api/admin/brain/source-receipt", receipt);
    const saved = fixture.first("SELECT docs_refused,docs_failed FROM sync_runs WHERE run_id=?", runId);
    assert.equal(saved.docs_refused, 2, "measured refusal decision reached");
    const source = fixture.first("SELECT last_ingest_at,last_complete_sweep_at FROM sources WHERE name=?", "gmail");
    assert.equal(source.last_ingest_at, null, "uncertified or failed reads never become fresh");
    assert.equal(source.last_complete_sweep_at, null);
  });
}
