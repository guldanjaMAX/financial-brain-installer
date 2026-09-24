import assert from "node:assert/strict";
import test from "node:test";

import { createProductFixture } from "./product-contract-fixture.mjs";
import { storeFor } from "../src/lib/store.js";
import {
  CLEANUP_CONTENT_PAGE_SQL,
  CLEANUP_CHUNK_PAGE_SQL,
  CLEANUP_DOCUMENT_PAGE_SQL,
  applyCleanupPlan,
  cleanupAuditPage,
  prepareCleanupPlan,
} from "../src/lib/optimize-cleanup.js";
import { cleanupLocationReferences } from "../src/lib/cleanup-location-references.js";
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
  entitySlug = null,
  client = null,
  category = null,
  platform = null,
  meta = {},
} = {}) {
  fixture.raw(
    `INSERT INTO documents
       (doc_uid, source, source_id, title, uri, document_date, date_source,
        date_reliable, ingested_at, content_hash, meta, top_folder, entity_slug,
        client, category, platform)
     VALUES (?, ?, ?, ?, ?, ?, 'source:created', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid, source, sourceId, title, uri, date, NOW, hash, JSON.stringify(meta),
    topFolder, entitySlug, client, category, platform,
  );
  fixture.raw(
    `INSERT INTO chunks
       (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date,
        top_folder, client, category, platform)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `${uid}#0`, uid, text, source, title, date, topFolder, client, category, platform,
  );
}

test("exact duplicate preview keeps every location visible while removal stays disabled", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:canonical", sourceId: "canonical" });
  seedDocument(fixture, { uid: "drive-reviewed:copy", sourceId: "copy", title: "Synthetic copy" });

  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, includeSampleTitles: true, now: NOW,
  });
  assert.deepEqual(plan.groups[0].references.map((item) => item.source_id).sort(),
    ["canonical", "copy"]);
  assert.deepEqual(plan.groups[0].references.map((item) => item.title).sort(),
    ["Synthetic copy", "Synthetic record"]);
  await assert.rejects(applyCleanupPlan(fixture.env, {
    plan, approvalFingerprint: plan.fingerprint, confirm: true, now: NOW,
  }), (error) => error?.code === "cleanup_apply_unavailable");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, 2);
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
  const chunkPlan = fixture.rows(
    `EXPLAIN QUERY PLAN ${CLEANUP_CHUNK_PAGE_SQL}`,
    "", -1, 101,
  ).map((row) => row.detail).join("\n");
  assert.match(contentPlan, /idx_documents_live_content_hash/i);
  assert.doesNotMatch(contentPlan, /USE TEMP B-TREE/i);
  assert.match(documentPlan, /sqlite_autoindex_documents_1|COVERING INDEX/i);
  assert.match(documentPlan, /idx_chunks_doc/i);
  assert.match(chunkPlan, /sqlite_autoindex_chunks_2/i);
  assert.doesNotMatch(chunkPlan, /USE TEMP B-TREE/i);

  const page = await cleanupAuditPage(fixture.env, { limit: 100, now: NOW });
  assert.ok(page.reads.every((read) => read.rows <= (read.lane === "content" ? 102 : 101)));
  assert.equal(page.resume.complete, false);
});

test("one duplicate approval batch stays bounded even when one family is much larger", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  fixture.raw(
    `WITH RECURSIVE n(value) AS (
       VALUES(1) UNION ALL SELECT value + 1 FROM n WHERE value < 500
     )
     INSERT INTO documents
       (doc_uid, source, source_id, title, ingested_at, content_hash, meta, top_folder)
     SELECT printf('drive-reviewed:duplicate-%04d', value), 'drive-reviewed',
            printf('duplicate-%04d', value), 'Synthetic duplicate', ?,
            'one-large-family', '{}', 'Reviewed'
       FROM n`,
    NOW,
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, top_folder)
     SELECT doc_uid || '#0', doc_uid, 0, 'Synthetic useful content', source, title, top_folder
       FROM documents`,
  );

  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, limit: 200, now: NOW,
  });
  assert.equal(plan.counts.documents, 199);
  assert.equal(plan.counts.chunks, 199);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.more_cleanup_possible, true);
});

test("exact duplicate planning refuses every distinct or unproved retrieval and access boundary", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedSource(fixture, "drive-other");
  const boundaries = [
    ["source", { source: "drive-reviewed" }, { source: "drive-other" }],
    ["entity", { entitySlug: "entity-one" }, { entitySlug: "entity-two" }],
    ["platform", { platform: "platform-one" }, { platform: "platform-two" }],
    ["client", { client: "client-one" }, { client: "client-two" }],
    ["category", { category: "category-one" }, { category: "category-two" }],
    ["folder", { topFolder: "Reviewed" }, { topFolder: "Other" }],
    ["date", { date: NOW - 1_000 }, { date: NOW }],
  ];
  for (const [label, left, right] of boundaries) {
    seedDocument(fixture, { uid: `drive-reviewed:${label}-a`, hash: `hash-${label}`, ...left });
    seedDocument(fixture, { uid: `drive-reviewed:${label}-b`, hash: `hash-${label}`, ...right });
  }
  seedDocument(fixture, { uid: "drive-reviewed:skew-a", hash: "hash-skew", platform: "document-platform" });
  seedDocument(fixture, { uid: "drive-reviewed:skew-b", hash: "hash-skew", platform: "document-platform" });
  fixture.raw("UPDATE chunks SET platform='different-chunk-platform' WHERE doc_uid='drive-reviewed:skew-b'");

  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, now: NOW,
  });

  assert.deepEqual(plan.targets, []);
  assert.ok(plan.refused_unproved_boundary_rows >= 1,
    "chunk/document boundary skew must be reached and reported");
});

test("a document grant prevents physical duplicate collapse", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:grant-a", entitySlug: "entity-one" });
  seedDocument(fixture, { uid: "drive-reviewed:grant-b", entitySlug: "entity-one" });
  fixture.raw(
    `INSERT INTO document_access_grants
       (grant_id, subject_label, entity_slug, created_at, created_by,
        create_request_id, request_fingerprint)
     VALUES ('dg_fixture', 'Synthetic reader', 'entity-one', ?, 'owner',
             'request_fixture', ?)`,
    NOW, "a".repeat(64),
  );
  fixture.raw(
    `INSERT INTO document_access_documents
       (grant_id, document_id, entity_slug, granted_at)
     VALUES ('dg_fixture', 'drive-reviewed:grant-b', 'entity-one', ?)`,
    NOW,
  );

  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, now: NOW,
  });
  assert.deepEqual(plan.targets, []);
  assert.ok(plan.refused_access_bound_rows >= 1,
    "the document-grant decision point must be reached and reported");
});

test("a duplicate family crossing the page boundary remains visible and planning is resumable", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  for (let index = 1; index <= 199; index += 1) {
    seedDocument(fixture, {
      uid: `drive-reviewed:singleton-${String(index).padStart(3, "0")}`,
      hash: `a-singleton-${String(index).padStart(3, "0")}`,
    });
  }
  seedDocument(fixture, { uid: "drive-reviewed:boundary-a", hash: "z-boundary" });
  seedDocument(fixture, { uid: "drive-reviewed:boundary-b", hash: "z-boundary" });

  const audit = await cleanupAuditPage(fixture.env, { limit: 200, now: NOW });
  assert.equal(audit.findings[0].count, 1);
  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, limit: 200, now: NOW,
  });
  assert.deepEqual(plan.targets, ["drive-reviewed:boundary-b"]);
  assert.equal(plan.resume.complete, true);
});

test("location projection returns every bounded reference and drops undeclared metadata", () => {
  const refs = Array.from({ length: 60 }, (_, index) => ({
    source: "drive-reviewed",
    source_id: `location-${index}`,
    title: `Synthetic title ${index}`,
    uri: `https://invalid.example/location-${index}`,
    secret_material: "must-not-cross",
  }));
  const projected = cleanupLocationReferences({ cleanup_location_references: refs });
  assert.equal(projected.length, 60);
  assert.deepEqual(Object.keys(projected[0]).sort(), ["source", "source_id", "title", "uri"]);
  assert.doesNotMatch(JSON.stringify(projected), /secret_material|must-not-cross/);
  assert.deepEqual(cleanupLocationReferences({
    cleanup_location_references: Array.from({ length: 1001 }, () => refs[0]),
  }), []);
});

test("retrieval exposes every preserved location beyond the old fifty-reference cap", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  const refs = Array.from({ length: 60 }, (_, index) => ({
    source: "drive-reviewed",
    source_id: `retrieval-location-${index}`,
    title: `Synthetic retrieval title ${index}`,
    uri: `https://invalid.example/retrieval-location-${index}`,
  }));
  seedDocument(fixture, {
    uid: "drive-reviewed:location-authority",
    hash: "location-authority-hash",
    meta: { cleanup_location_references: refs },
  });

  const search = await storeFor(fixture.env).search(fixture.env, {
    query: "Useful synthetic content", limit: 5,
  });
  assert.equal(search.results[0].location_references.length, 60);
});

test("cleanup plan closes legacy location metadata before the private JSON response", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  const legacy = {
    cleanup_location_references: [{
      source: "drive-reviewed",
      source_id: "legacy-location",
      title: "Legacy synthetic title",
      uri: "https://invalid.example/legacy-location",
      token_like: "must-not-cross",
    }],
  };
  seedDocument(fixture, { uid: "drive-reviewed:legacy-a", meta: legacy });
  seedDocument(fixture, { uid: "drive-reviewed:legacy-b" });
  const response = await fixture.post("/api/admin/brain/cleanup/plan", {
    rule: { kind: "exact_duplicates" },
  }, { "X-Admin-Key": "fixture-admin-key" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.doesNotMatch(JSON.stringify(body), /token_like|must-not-cross|Legacy synthetic title/);
});

test("confirmed cleanup is fail-closed until atomic guarded removal exists", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:safe-a", title: "First synthetic title" });
  seedDocument(fixture, { uid: "drive-reviewed:safe-b", title: "Second synthetic title" });
  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, now: NOW,
  });
  fixture.seen.sql.length = 0;

  await assert.rejects(applyCleanupPlan(fixture.env, {
    plan, approvalFingerprint: plan.fingerprint, confirm: true, now: NOW,
  }), (error) => error?.code === "cleanup_apply_unavailable");
  assert.ok(fixture.seen.sql.some((sql) => /plan target counts|bounded savings estimate/.test(sql)),
    "the exact nonempty plan must be rebuilt before refusal");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, 2);
  assert.deepEqual(fixture.rows("SELECT title FROM documents ORDER BY doc_uid").map((row) => row.title),
    ["First synthetic title", "Second synthetic title"]);
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
  assert.equal(report.before.actual_vectors, null);
  assert.equal(report.before.vector_count_observed, false);
  assert.ok(Object.hasOwn(report.before, "expected_vectors"));
  assert.ok(!Object.hasOwn(report.before, "vectors"));
  assert.ok(Object.hasOwn(report.findings[0], "estimated_projected_vectors_saved"));
  assert.ok(Object.hasOwn(report.findings[0], "estimated_text_characters_saved"));
  assert.doesNotMatch(JSON.stringify(report), /Private synthetic title/);

  const planResponse = await fixture.post("/api/admin/brain/cleanup/plan", {
    rule: { kind: "exact_duplicates" },
  }, headers);
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  assert.doesNotMatch(JSON.stringify(plan), /Private synthetic title/);
  assert.equal(plan.approval_required, true);
  assert.equal(plan.dry_run.documents, 1);
  assert.equal(plan.dry_run.expected_vector_deletes, 1);
  assert.ok(!Object.hasOwn(plan.dry_run, "vectors"));
  assert.equal(plan.apply_available, false);
  const previewResponse = await fixture.post("/api/admin/brain/cleanup/apply", {
    plan, confirm: false,
  }, headers);
  const preview = await previewResponse.json();
  assert.equal(preview.applied, false);
  assert.equal(preview.dry_run.documents, 1);
  const refusedResponse = await fixture.post("/api/admin/brain/cleanup/apply", {
    plan,
    approval_fingerprint: plan.fingerprint,
    confirm: true,
  }, headers);
  assert.equal(refusedResponse.status, 409);
  assert.equal((await refusedResponse.json()).code, "cleanup_apply_unavailable");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, 2);
});

test("cleanup apply refuses at the ingest, drain, and update decision points", async (t) => {
  const fixture = await createProductFixture();
  t.after(fixture.close);
  seedSource(fixture);
  seedDocument(fixture, { uid: "drive-reviewed:active-a" });
  seedDocument(fixture, { uid: "drive-reviewed:active-b" });
  const plan = await prepareCleanupPlan(fixture.env, {
    rule: { kind: "exact_duplicates" }, now: NOW,
  });
  const apply = () => applyCleanupPlan(fixture.env, {
    plan, approvalFingerprint: plan.fingerprint, confirm: true, now: NOW,
  });

  fixture.raw("UPDATE sources SET status='indexing' WHERE name='drive-reviewed'");
  fixture.seen.sql.length = 0;
  await assert.rejects(apply(),
    (error) => error?.code === "cleanup_ingest_active");
  assert.ok(fixture.seen.sql.some((sql) => /activity guard/.test(sql)));
  assert.ok(!fixture.seen.sql.some((sql) => /preserve aliases|DELETE FROM documents/.test(sql)));

  fixture.raw("UPDATE sources SET status='ready' WHERE name='drive-reviewed'");
  fixture.raw(
    "UPDATE install_state SET vector_drain_lease_owner='fixture', vector_drain_lease_expires_at=? WHERE id=1",
    NOW + 60_000,
  );
  fixture.seen.sql.length = 0;
  await assert.rejects(apply(),
    (error) => error?.code === "cleanup_drain_active");
  assert.ok(fixture.seen.sql.some((sql) => /activity guard/.test(sql)));
  assert.ok(!fixture.seen.sql.some((sql) => /preserve aliases|DELETE FROM documents/.test(sql)));

  fixture.raw(
    "UPDATE install_state SET vector_drain_lease_owner=NULL, vector_drain_lease_expires_at=NULL WHERE id=1",
  );
  fixture.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  fixture.seen.sql.length = 0;
  await assert.rejects(apply(),
    (error) => error?.code === "cleanup_update_active");
  assert.equal(fixture.seen.sql.length, 0,
    "the update barrier is reached before any D1 preservation or forget call");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents").n, 2);
});
