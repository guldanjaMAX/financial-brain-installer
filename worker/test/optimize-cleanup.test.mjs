import assert from "node:assert/strict";
import test from "node:test";

import { createProductFixture } from "./product-contract-fixture.mjs";
import { storeFor } from "../src/lib/store.js";
import {
  CLEANUP_CONTENT_PAGE_SQL,
  CLEANUP_DOCUMENT_PAGE_SQL,
  applyCleanupPlan,
  cleanupAuditPage,
  prepareCleanupPlan,
} from "../src/lib/optimize-cleanup.js";
import {
  applyCleanupSourceSetting, cleanupRuleSourceSetting, prepareCleanupSourceSetting,
} from "../../operations/cleanup-source-setting.mjs";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function seedSource(fixture, name = "drive-reviewed") {
  fixture.raw(
    `INSERT INTO sources (name, kind, status, created_at, scope)
     VALUES (?, 'drive', 'ready', '2026-09-01T00:00:00Z', ?)`,
    name,
    JSON.stringify({ roots: ["Reviewed"] }),
  );
}

function seedDocument(fixture, {
  uid,
  source = "drive-reviewed",
  sourceId = uid,
  title = "Synthetic record",
  uri = `https://invalid.example/${uid}`,
  hash = "shared-content-hash",
  date = Date.parse("2026-09-01T00:00:00Z"),
  topFolder = "Reviewed",
  text = "Useful synthetic content for the cleanup contract.",
} = {}) {
  fixture.raw(
    `INSERT INTO documents
       (doc_uid, source, source_id, title, uri, document_date, date_source,
        date_reliable, ingested_at, content_hash, meta, top_folder)
     VALUES (?, ?, ?, ?, ?, ?, 'source:created', 1, ?, ?, '{}', ?)`,
    uid, source, sourceId, title, uri, date, NOW, hash, topFolder,
  );
  fixture.raw(
    `INSERT INTO chunks
       (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, top_folder)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
    `${uid}#0`, uid, text, source, title, date, topFolder,
  );
}

test("exact duplicate collapse keeps every location reference on the canonical document", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:canonical", sourceId: "canonical" });
  seedDocument(fixture, { uid: "drive-reviewed:copy", sourceId: "copy", title: "Synthetic copy" });

  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, now: NOW,
  });
  const applied = await applyCleanupPlan(fixture.env, {
    plan,
    approvalFingerprint: plan.fingerprint,
    confirm: true,
    now: NOW,
  });

  assert.equal(applied.applied, true);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, 1);
  const canonical = fixture.first("SELECT meta FROM documents WHERE doc_uid=?", "drive-reviewed:canonical");
  const references = JSON.parse(canonical.meta).cleanup_location_references;
  assert.deepEqual(references.map((item) => item.source_id).sort(), ["canonical", "copy"]);
  const search = await storeFor(fixture.env).search(fixture.env, {
    query: "Useful synthetic content", limit: 5,
  });
  assert.deepEqual(search.results[0].location_references.map((item) => item.source_id).sort(),
    ["canonical", "copy"]);
});

test("an unapproved plan proves the forget decision point and changes nothing", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:canonical", sourceId: "canonical" });
  seedDocument(fixture, { uid: "drive-reviewed:copy", sourceId: "copy" });

  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, now: NOW,
  });
  const before = fixture.first("SELECT COUNT(*) AS n FROM documents").n;
  const outcome = await applyCleanupPlan(fixture.env, { plan, confirm: false, now: NOW });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.approval_required, true);
  assert.equal(outcome.dry_run.documents, 1);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, before);
  assert.ok(fixture.seen.sql.some((sql) => /FROM chunks WHERE doc_uid IN/.test(sql)),
    "the existing forget dry-run must be reached");
});

test("approval for a stale fingerprint is refused before mutation", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:canonical", sourceId: "canonical" });
  seedDocument(fixture, { uid: "drive-reviewed:copy", sourceId: "copy" });
  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, now: NOW,
  });

  seedDocument(fixture, { uid: "drive-reviewed:later-copy", sourceId: "later-copy" });
  await assert.rejects(
    applyCleanupPlan(fixture.env, {
      plan,
      approvalFingerprint: plan.fingerprint,
      confirm: true,
      now: NOW,
    }),
    (error) => error?.code === "cleanup_plan_changed",
  );
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, 3);
});

test("an approved Drive scope rule becomes a future-load exclusion without mutating input", () => {
  const manifest = {
    corpora: {
      google_drive: {
        enabled: true,
        roots: ["Reviewed"],
        exclude_paths: ["Reviewed/Temporary"],
      },
    },
  };
  const next = cleanupRuleSourceSetting(manifest, {
    kind: "outside_drive_path",
    path: "Reviewed/Archive",
  });
  assert.deepEqual(next.corpora.google_drive.exclude_paths,
    ["Reviewed/Temporary", "Reviewed/Archive"]);
  assert.deepEqual(manifest.corpora.google_drive.exclude_paths, ["Reviewed/Temporary"]);
  const plan = prepareCleanupSourceSetting(manifest, {
    kind: "outside_drive_path", path: "Reviewed/Archive",
  });
  assert.throws(() => applyCleanupSourceSetting(manifest, plan, "0".repeat(64)),
    (error) => error?.code === "cleanup_source_setting_not_approved");
  assert.deepEqual(
    applyCleanupSourceSetting(manifest, plan, plan.fingerprint)
      .manifest.corpora.google_drive.exclude_paths,
    ["Reviewed/Temporary", "Reviewed/Archive"],
  );
});

test("cleanup pages use bounded indexed reads on a large fixture", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  fixture.raw(
    `WITH RECURSIVE n(value) AS (
       VALUES(1) UNION ALL SELECT value + 1 FROM n WHERE value < 20000
     )
     INSERT INTO documents
       (doc_uid, source, source_id, title, ingested_at, content_hash, meta, top_folder)
     SELECT printf('drive-reviewed:doc-%05d', value), 'drive-reviewed',
            printf('doc-%05d', value), 'Synthetic record', ?,
            printf('hash-%05d', CAST(value / 2 AS INTEGER)), '{}', 'Reviewed'
       FROM n`,
    NOW,
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, top_folder)
     SELECT doc_uid || '#0', doc_uid, 0, 'Synthetic useful content', source, title, top_folder
       FROM documents`,
  );

  const contentPlan = fixture.rows(
    `EXPLAIN QUERY PLAN ${CLEANUP_CONTENT_PAGE_SQL}`,
    "", "", 101,
  ).map((row) => row.detail).join("\n");
  const documentPlan = fixture.rows(
    `EXPLAIN QUERY PLAN ${CLEANUP_DOCUMENT_PAGE_SQL}`,
    "", 101,
  ).map((row) => row.detail).join("\n");
  assert.match(contentPlan, /idx_documents_live_content_hash/i);
  assert.doesNotMatch(contentPlan, /USE TEMP B-TREE/i);
  assert.match(documentPlan, /sqlite_autoindex_documents_1|COVERING INDEX/i);
  assert.match(documentPlan, /idx_chunks_doc/i);

  const page = await cleanupAuditPage(fixture.env, { limit: 100, now: NOW });
  assert.ok(page.reads.every((read) => read.rows <= 101));
  assert.equal(page.resume.complete, false);
});

test("cleanup admin routes are private, title-redacted by default, and dry-run before approval", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:canonical", sourceId: "canonical" });
  seedDocument(fixture, {
    uid: "drive-reviewed:copy", sourceId: "copy", title: "Private synthetic title",
  });
  const headers = { "X-Admin-Key": "fixture-admin-key" };
  const reportResponse = await fixture.post("/api/admin/brain/cleanup/report", {}, headers);
  assert.equal(reportResponse.status, 200);
  assert.match(reportResponse.headers.get("cache-control"), /no-store/);
  const report = await reportResponse.json();
  assert.deepEqual(report.findings.map((finding) => finding.kind), [
    "exact_duplicates", "near_duplicate_candidates", "retroactive_junk",
    "outside_declared_scope", "heavy_low_value_candidates", "stale_or_superseded",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /Private synthetic title/);

  const planResponse = await fixture.post("/api/admin/brain/cleanup/plan", {
    rule: { kind: "exact_duplicates" },
  }, headers);
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  assert.doesNotMatch(JSON.stringify(plan), /Private synthetic title/);
  const previewResponse = await fixture.post("/api/admin/brain/cleanup/apply", {
    plan, confirm: false,
  }, headers);
  const preview = await previewResponse.json();
  assert.equal(preview.applied, false);
  assert.equal(preview.dry_run.documents, 1);
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, 2);
});

test("cleanup refuses while ingest or drain work is active", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  fixture.raw("UPDATE sources SET status='indexing' WHERE name='drive-reviewed'");
  await assert.rejects(cleanupAuditPage(fixture.env, { now: NOW }),
    (error) => error?.code === "cleanup_ingest_active");
  fixture.raw("UPDATE sources SET status='ready' WHERE name='drive-reviewed'");
  fixture.raw(
    "UPDATE install_state SET vector_drain_lease_owner='fixture', vector_drain_lease_expires_at=? WHERE id=1",
    NOW + 60_000,
  );
  await assert.rejects(cleanupAuditPage(fixture.env, { now: NOW }),
    (error) => error?.code === "cleanup_drain_active");
});
