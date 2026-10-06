import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import {
  coverageGapReport,
  freshnessReport,
  sourceFreshnessSql,
  sourceInventory,
} from "../src/lib/store-d1.js";

const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const NOW = Date.parse("2026-10-05T12:00:00.000Z");

async function json(response) {
  return { status: response.status, body: await response.json() };
}

async function register(fixture, source, kind = "upload") {
  const result = await json(await fixture.post(
    "/api/admin/brain/source-register", { source, kind }, ADMIN,
  ));
  assert.equal(result.status, 200);
  return result.body;
}

async function receipt(fixture, source, status, extra = {}) {
  const result = await json(await fixture.post(
    "/api/admin/brain/source-receipt",
    { source, status, kind: extra.kind || "upload", issue_code: "INGEST_FAILED", ...extra },
    ADMIN,
  ));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function ingest(fixture, source, count) {
  for (let i = 0; i < count; i++) {
    const result = await json(await fixture.post("/api/admin/brain/ingest", {
      source_type: source,
      source_id: `record-${i + 1}`,
      title: `Invented record ${i + 1}`,
      content: `Invented planning content ${i + 1}.`,
    }, ADMIN));
    assert.ok(result.status === 200 || result.status === 201, JSON.stringify(result.body));
  }
}

function rowsFor(value, source) {
  return value.filter((row) => row.source === source || row.name === source || row.source_id === source);
}

async function reports(fixture) {
  const [coverage, freshness, inventory] = await Promise.all([
    coverageGapReport(fixture.env, { now: NOW }),
    freshnessReport(fixture.env, { now: NOW }),
    sourceInventory(fixture.env, { now: NOW }),
  ]);
  return { coverage, freshness, inventory };
}

function assertBrokenUpload(report) {
  const broken = report.coverage.gaps.find((gap) => gap.source === "upload" && gap.type === "sync_broken");
  assert.ok(broken, "the control must reach the sync_broken decision");
  assert.match(broken.detail, /The latest update did not finish/);
  assert.match(broken.remedy, /Re-run the whole folder/);
}

async function buildBrokenFixture() {
  const fixture = await createProductFixture();
  await register(fixture, "upload");
  await ingest(fixture, "upload", 7);
  await receipt(fixture, "upload", "error", { completed_at: "2026-09-20T12:00:00.000Z" });

  await register(fixture, "archive-2026");
  await receipt(fixture, "archive-2026", "ready", {
    completed_at: "2026-10-05T10:00:00.000Z",
  });
  await register(fixture, "planning-notes");
  await receipt(fixture, "planning-notes", "error", {
    completed_at: "2026-10-04T10:00:00.000Z",
  });
  return fixture;
}

test("retiring a broken upload keeps its records and removes only its actionable warnings", async () => {
  const fixture = await buildBrokenFixture();
  try {
    const before = await reports(fixture);
    assertBrokenUpload(before);
    const otherBefore = {
      coverage: before.coverage.gaps.filter((row) => row.source !== "upload"),
      freshness: before.freshness.sources.filter((row) => row.name !== "upload"),
      inventory: before.inventory.rows.filter((row) => row.source_id !== "upload"),
    };
    const sourceBefore = fixture.first("SELECT * FROM sources WHERE name='upload'");
    const docsBefore = fixture.rows("SELECT * FROM documents WHERE source='upload' ORDER BY doc_uid");
    const chunksBefore = fixture.rows(
      "SELECT c.* FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid WHERE d.source='upload' ORDER BY c.id",
    );
    const changesBefore = fixture.first("SELECT total_changes() AS n").n;

    const retired = await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "upload", retired: true }, ADMIN,
    ));
    assert.equal(retired.status, 200);
    assert.equal(retired.body.changed, true);
    assert.equal(retired.body.documents, 7);
    assert.match(retired.body.retired_at, /^2026-|^20\d\d-/);
    assert.equal(fixture.first("SELECT total_changes() AS n").n - changesBefore, 1);

    const after = await reports(fixture);
    assert.equal(
      after.coverage.gaps.some((gap) => gap.source === "upload" && [
        "sync_broken", "sync_review", "sync_in_progress", "never_synced",
        "coverage_stale", "refresh_unscheduled",
      ].includes(gap.type)),
      false,
    );
    const history = after.coverage.gaps.filter(
      (gap) => gap.source === "upload" && gap.type === "history_unproven",
    );
    assert.equal(history.length, 1);
    assert.equal(history[0].remedy, "No action needed.");
    assert.doesNotMatch(`${history[0].detail} ${history[0].remedy}`, /brain |--|retry|re-?run|ingest|drain|update|reconnect|sync/i);
    assert.equal(after.freshness.sources.find((row) => row.name === "upload").state, "manual");
    assert.equal(after.inventory.rows.find((row) => row.source_id === "upload").freshness.state, "manual");
    assert.deepEqual({ ...fixture.first("SELECT * FROM sources WHERE name='upload'") }, { ...sourceBefore });
    assert.deepEqual(fixture.rows("SELECT * FROM documents WHERE source='upload' ORDER BY doc_uid"), docsBefore);
    assert.deepEqual(fixture.rows(
      "SELECT c.* FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid WHERE d.source='upload' ORDER BY c.id",
    ), chunksBefore);
    assert.deepEqual(after.coverage.gaps.filter((row) => row.source !== "upload"), otherBefore.coverage);
    assert.deepEqual(after.freshness.sources.filter((row) => row.name !== "upload"), otherBefore.freshness);
    assert.deepEqual(after.inventory.rows.filter((row) => row.source_id !== "upload"), otherBefore.inventory);

    const noOpBefore = fixture.first("SELECT total_changes() AS n").n;
    const noOp = await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "upload", retired: true }, ADMIN,
    ));
    assert.equal(noOp.status, 200);
    assert.equal(noOp.body.changed, false);
    assert.equal(fixture.first("SELECT total_changes() AS n").n, noOpBefore);

    await receipt(fixture, "upload", "error", { completed_at: "2026-10-05T12:01:00.000Z" });
    assertBrokenUpload(await reports(fixture));

    await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "upload", retired: true }, ADMIN,
    ));
    const unretired = await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "upload", retired: false }, ADMIN,
    ));
    assert.equal(unretired.status, 200);
    assert.equal(unretired.body.changed, true);
    assertBrokenUpload(await reports(fixture));
  } finally {
    fixture.close();
  }
});

test("refresh-never does not retire, while an owner upload clears broken state but keeps its command remedy", async () => {
  const fixture = await buildBrokenFixture();
  try {
    const expectation = await fixture.post(
      "/api/admin/brain/source-expectation",
      { source: "upload", expected_refresh_seconds: null },
      ADMIN,
    );
    assert.equal(expectation.status, 200);
    assertBrokenUpload(await reports(fixture));

    seedOwnedEntity(fixture, "team-photos", "Team Photos");
    const owner = await fixture.ownerHeaders();
    const uploaded = await json(await fixture.post("/api/owner/uploads", {
      request_id: "source-retire-owner-upload",
      document_id: "planning-note",
      entity_slug: "team-photos",
      media_type: "text/plain",
      file_name: "planning-note.txt",
      envelope: {
        title: "Planning note",
        content: "Invented planning content.",
        metadata: { channel: "owner_workspace" },
      },
    }, owner));
    assert.ok(uploaded.status === 200 || uploaded.status === 201, JSON.stringify(uploaded.body));
    const after = await reports(fixture);
    assert.equal(after.coverage.gaps.some((gap) => gap.source === "upload" && gap.type === "sync_broken"), false);
    const history = after.coverage.gaps.find((gap) => gap.source === "upload" && gap.type === "history_unproven");
    assert.ok(history, "owner upload reaches the history_unproven decision");
    assert.match(history.remedy, /Re-run the whole folder/);
    assert.equal(after.inventory.rows.find((row) => row.source_id === "upload").storage.logical_documents, 8);
  } finally {
    fixture.close();
  }
});

test("a retired source with a proven complete sweep has no coverage gap", async () => {
  const fixture = await createProductFixture();
  try {
    await register(fixture, "archive-2026");
    await receipt(fixture, "archive-2026", "ready", {
      run_id: "complete-sweep", lane: "sweep", walk_complete: true,
      complete_sweep: true, docs_refused: 0, docs_failed: 0,
      completed_at: "2026-10-05T10:00:00.000Z",
    });
    const retired = await fixture.post(
      "/api/admin/brain/source-retire", { source: "archive-2026", retired: true }, ADMIN,
    );
    assert.equal(retired.status, 200, await retired.text());
    const coverage = await coverageGapReport(fixture.env, { now: NOW });
    assert.deepEqual(rowsFor(coverage.gaps, "archive-2026"), []);
  } finally {
    fixture.close();
  }
});

test("source retirement refusals are closed, reached, and write-free", async () => {
  const fixture = await createProductFixture();
  try {
    await register(fixture, "archive-2026", "drive");
    await register(fixture, "upload");
    await register(fixture, "planning-notes");
    await receipt(fixture, "planning-notes", "error", {
      issue_code: "SAFETY_REVIEW_REQUIRED",
      completed_at: "2026-10-05T09:00:00.000Z",
    });
    await receipt(fixture, "upload", "indexing", {
      run_id: "open-run", started_at: "2026-10-05T10:00:00.000Z",
    });

    for (const body of [
      { source: "upload" },
      { source: "upload", retired: "yes" },
      { source: "upload", retired: true, extra: true },
    ]) {
      const before = fixture.first("SELECT total_changes() AS n").n;
      const response = await json(await fixture.post("/api/admin/brain/source-retire", body, ADMIN));
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "invalid_request", "the closed-body decision must be reached");
      assert.equal(fixture.first("SELECT total_changes() AS n").n, before);
    }

    for (const [source, status, code] of [
      ["team-photos", 404, "source_not_registered"],
      ["archive-2026", 409, "source_kind_not_retirable"],
      ["upload", 409, "source_indexing"],
      ["planning-notes", 409, "source_review_pending"],
    ]) {
      const before = fixture.first("SELECT total_changes() AS n").n;
      const response = await json(await fixture.post(
        "/api/admin/brain/source-retire", { source, retired: true }, ADMIN,
      ));
      assert.equal(response.status, status);
      assert.equal(response.body.code, code, "the named refusal decision must be reached");
      assert.equal(typeof response.body.error, "string");
      assert.equal(fixture.first("SELECT total_changes() AS n").n, before);
    }

    const pausedBefore = fixture.first("SELECT total_changes() AS n").n;
    fixture.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
    const paused = await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "archive-2026", retired: true }, ADMIN,
    ));
    assert.equal(paused.status, 503);
    assert.equal(paused.body.paused, true);
    assert.equal(Object.hasOwn(paused.body, "code"), false);
    assert.equal(fixture.first("SELECT total_changes() AS n").n, pausedBefore);
  } finally {
    fixture.close();
  }
});

test("only the unrestricted owner key can reach source retirement", async () => {
  const fixture = await createProductFixture();
  try {
    await register(fixture, "team-photos");
    const addGrant = (id, token, capabilities) => {
      fixture.raw(
        `INSERT INTO grants
           (grant_id,display_name,capabilities,created_at,created_by,scope_include,scope_exclude)
         VALUES (?,?,?,?,?,'{"zones":["planning"]}','[]')`,
        id, "Fixture grant", JSON.stringify(capabilities), NOW, "owner",
      );
      fixture.raw(
        "INSERT INTO grant_credentials (token_hash,grant_id,created_at) VALUES (?,?,?)",
        createHash("sha256").update(token).digest("hex"), id, NOW,
      );
    };
    addGrant("grant-file", "fixture-file-token", ["file"]);
    addGrant("grant-admin", "fixture-admin-token", ["administer"]);

    const before = fixture.first("SELECT total_changes() AS n").n;
    const ordinary = await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "team-photos", retired: true },
      { "X-Admin-Key": "fixture-file-token" },
    ));
    assert.equal(ordinary.status, 401);
    assert.deepEqual(ordinary.body, { error: "unauthorized" });
    assert.equal(fixture.first("SELECT total_changes() AS n").n, before);

    const scoped = await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "team-photos", retired: true },
      { "X-Admin-Key": "fixture-admin-token" },
    ));
    assert.equal(scoped.status, 403);
    assert.equal(scoped.body.code, "owner_key_required", "the scoped administer grant reached the route branch");
    assert.equal(fixture.first("SELECT total_changes() AS n").n, before);

    const owner = await json(await fixture.post(
      "/api/admin/brain/source-retire", { source: "team-photos", retired: true }, ADMIN,
    ));
    assert.equal(owner.status, 200);
    assert.equal(owner.body.changed, true, "the owner-key control reached and changed the same decision point");
  } finally {
    fixture.close();
  }
});

test("retirement queries use the source-events index", async () => {
  const fixture = await createProductFixture();
  try {
    const plan = fixture.rows(`EXPLAIN QUERY PLAN ${sourceFreshnessSql()}`);
    const eventSteps = plan.map((row) => String(row.detail || "")).filter((detail) => /source_events/.test(detail));
    assert.ok(eventSteps.length > 0, "the retirement lookup must reach source_events");
    assert.ok(eventSteps.some((detail) => /SEARCH .* USING INDEX idx_source_events_source/.test(detail)), eventSteps.join("\n"));
    assert.equal(eventSteps.some((detail) => /SCAN .*source_events/.test(detail)), false, eventSteps.join("\n"));

    await sourceInventory(fixture.env, { now: NOW });
    const inventoryRetirementSql = fixture.seen.sql.find((sql) =>
      /SELECT s\.name AS source_name/.test(sql) && /retired_at/.test(sql));
    assert.ok(inventoryRetirementSql, "the inventory retirement companion read must run");
    const inventoryPlan = fixture.rows(`EXPLAIN QUERY PLAN ${inventoryRetirementSql}`);
    const inventoryEventSteps = inventoryPlan.map((row) => String(row.detail || ""))
      .filter((detail) => /source_events/.test(detail));
    assert.ok(inventoryEventSteps.some((detail) =>
      /SEARCH .* USING INDEX idx_source_events_source/.test(detail)), inventoryEventSteps.join("\n"));
    assert.equal(inventoryEventSteps.some((detail) => /SCAN .*source_events/.test(detail)), false);
  } finally {
    fixture.close();
  }
});
