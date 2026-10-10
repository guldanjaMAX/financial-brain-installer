import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { splitStatements } from "../../brain.mjs";
import worker from "../src/index.js";
import { mintSessionCookie } from "../src/lib/sessions.js";
import {
  normalizeIngestEnvelopeProvenance,
  provenanceAssessmentMarker,
} from "../src/lib/provenance-receipt.js";
import { sourceInventory, sourceRecoveryCandidates } from "../src/lib/store-d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const ORIGIN = "https://brain.invalid";
const OWNER_CREDENTIAL = "fixture-owner-source-inventory";
const SCOPED_CREDENTIAL = "fixture-scoped-source-inventory";
const SAFE_GMAIL_FAILURE = Object.freeze({
  version: 1,
  operation_class: "gmail_message_read",
  http_status: 400,
  provider_reason: "failed_precondition",
  checkpoint_readback: "verified",
  checkpoint_done: 55,
  checkpoint_skipped: 3,
  cursor_preservation: "absent_preserved",
});

function migratedDb(label = "fixture", { throughMigration = Infinity } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && Number(name.slice(0, 4)) <= throughMigration)
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const statement of splitStatements(sql)) db.exec(statement);
  }
  db.prepare(
    `INSERT INTO install_state (id,client_slug,product_version,installed_at)
     VALUES (1,?,'0.0.0-test','2026-01-01T00:00:00.000Z')`,
  ).run(label);
  for (const [credential, grant] of [[OWNER_CREDENTIAL, null], [SCOPED_CREDENTIAL, "g_scoped"]]) {
    db.prepare(
      `INSERT INTO owner_passkeys
         (credential_id,public_key_jwk,alg,sign_count,nickname,created_at,grant_id)
       VALUES (?,'{}',-7,0,'Fixture device',?,?)`,
    ).run(credential, Date.parse("2026-09-01T00:00:00.000Z"), grant);
  }
  db.prepare(
    `INSERT INTO grants
       (grant_id,display_name,capabilities,created_at,created_by,scope_include,scope_exclude)
     VALUES ('g_scoped','Scoped fixture','["administer"]',?,'owner','{"all":true}','[]')`,
  ).run(Date.parse("2026-09-01T00:00:00.000Z"));
  return db;
}

async function addInventoryFixture(db, prefix = "", { includeFailureEvidence = true } = {}) {
  const source = (name) => `${prefix}${name}`;
  db.prepare(
    `INSERT INTO sources
       (name,kind,status,created_at,last_ingest_at,document_count,
        sync_cursor,cursor_updated_at,scope,
        expected_refresh_seconds,last_complete_sweep_at,stale_reason,zone)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    source("alpha"), "drive", "ready", "2026-08-01T00:00:00.000Z",
    "2026-09-09T00:00:00.000Z", 2,
    "private-cursor-123", "2026-09-09T00:01:00.000Z",
    JSON.stringify({ root_folder_ids: ["private-root-one", "private-root-two"], private_label: "secret scope label" }),
    86400, "2026-09-09T00:00:00.000Z", null, "books",
  );
  db.prepare(
    `INSERT INTO sources
       (name,kind,status,created_at,last_ingest_at,document_count,
        expected_refresh_seconds,last_complete_sweep_at,stale_reason,zone)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    source("beta"), "gmail", "error", "2026-08-02T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z", 2, 86400, null, "AUTH_EXPIRED", null,
  );

  const insertDocument = db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,uri,document_date,date_source,date_reliable,
        client,category,ingested_at,content_hash,meta,text_source,text_reliable,
        provenance_receipt_version,provenance_receipt_status,
        provenance_receipt_reason,provenance_receipt_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const provenance = async (sourceType, sourceId, textSource, textReliable, metadata = {}) => {
    const envelope = normalizeIngestEnvelopeProvenance({
      source_type: sourceType,
      source_id: sourceId,
      content: "fixture",
      text_source: textSource,
      text_reliable: textReliable,
      metadata,
    });
    return {
      meta: JSON.stringify(envelope.metadata),
      marker: await provenanceAssessmentMarker(envelope),
    };
  };
  const alphaOneRoot = `${source("alpha")}:one`;
  const alphaOne = await provenance(source("alpha"), "one", "native", true, {
    evidence_lineage: { version: 1, kind: "source_record", root_ids: [alphaOneRoot] },
  });
  const alphaTwoRoot = `${source("alpha")}:two`;
  const alphaTwo = await provenance(source("alpha"), "two", "ocr_partial", false, {
    family_of: alphaTwoRoot,
    evidence_lineage: { version: 1, kind: "source_record", root_ids: [alphaTwoRoot] },
  });
  const betaOne = await provenance(source("beta"), "one", "ocr", false);
  insertDocument.run(
    `${source("alpha")}:one`, source("alpha"), "one", "Invented alpha one", null,
    Date.parse("2026-08-01T00:00:00.000Z"), "fixture", 1, null, null,
    Date.parse("2026-09-09T00:00:00.000Z"), "hash-alpha-one",
    alphaOne.meta,
    "native", 1,
    alphaOne.marker.provenance_receipt_version,
    alphaOne.marker.provenance_receipt_status,
    alphaOne.marker.provenance_receipt_reason,
    alphaOne.marker.provenance_receipt_digest,
  );
  insertDocument.run(
    `${source("alpha")}:two`, source("alpha"), "two", "Invented alpha two", null,
    Date.parse("2026-08-02T00:00:00.000Z"), "fixture", 1, null, null,
    Date.parse("2026-09-09T00:00:00.000Z"), "hash-alpha-two",
    alphaTwo.meta, "ocr_partial", 0,
    alphaTwo.marker.provenance_receipt_version,
    alphaTwo.marker.provenance_receipt_status,
    alphaTwo.marker.provenance_receipt_reason,
    alphaTwo.marker.provenance_receipt_digest,
  );
  insertDocument.run(
    `${source("beta")}:one`, source("beta"), "one", "Invented beta", null,
    Date.parse("2026-08-03T00:00:00.000Z"), "fixture", 1, null, null,
    Date.parse("2026-09-01T00:00:00.000Z"), "hash-beta-one", betaOne.meta, "ocr", 0,
    betaOne.marker.provenance_receipt_version,
    betaOne.marker.provenance_receipt_status,
    betaOne.marker.provenance_receipt_reason,
    betaOne.marker.provenance_receipt_digest,
  );
  insertDocument.run(
    `${source("orphan")}:one`, source("orphan"), "one", "Invented orphan", null,
    Date.parse("2026-08-04T00:00:00.000Z"), "fixture", 1, null, null,
    Date.parse("2026-09-01T00:00:00.000Z"), "hash-orphan-one",
    JSON.stringify({
      family_of: `${source("orphan")}:one`,
      evidence_lineage: { version: 99, kind: "source_record", root_ids: [] },
    }), "native", 1, null, null, null, null,
  );

  const insertChunk = db.prepare(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,client,category)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  insertChunk.run(`${source("alpha")}:one#0`, `${source("alpha")}:one`, 0, "fixture alpha", source("alpha"), "Alpha", 1, null, null);
  insertChunk.run(`${source("beta")}:one#0`, `${source("beta")}:one`, 0, "fixture beta", source("beta"), "Beta", 1, null, null);
  insertChunk.run(`${source("orphan")}:one#0`, `${source("orphan")}:one`, 0, "fixture orphan", source("orphan"), "Orphan", 1, null, null);

  db.prepare(
    `INSERT INTO sync_runs
       (run_id,source,lane,started_at,finished_at,walk_complete,files_seen,
        docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
        confirmed_from,confirmed_through,target_from,target_through,
        proposed_deletes,delete_action,refusal_reason,error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `${source("alpha")}-run`, source("alpha"), "sweep",
    Date.parse("2026-09-09T00:00:00.000Z"), Date.parse("2026-09-09T00:01:00.000Z"),
    1, 2, 1, 0, 1, 0, 0, 1,
    "2020-01-01T00:00:00.000Z", "2026-09-09T00:00:00.000Z",
    "2020-01-01T00:00:00.000Z", "2026-09-09T00:00:00.000Z",
    0, "applied", null, null,
  );
  const betaRunValues = [
    `${source("beta")}-run`, source("beta"), "incremental",
    Date.parse("2026-09-01T00:00:00.000Z"), Date.parse("2026-09-01T00:01:00.000Z"),
    0, 1, 0, 0, 0, 0, 1, 1, 0, null, null,
    "private provider failure for secret-account@example.invalid",
  ];
  if (includeFailureEvidence) {
    db.prepare(
      `INSERT INTO sync_runs
         (run_id,source,lane,started_at,finished_at,walk_complete,files_seen,
          docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
          proposed_deletes,delete_action,refusal_reason,error,failure_evidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(...betaRunValues, JSON.stringify(SAFE_GMAIL_FAILURE));
  } else {
    db.prepare(
      `INSERT INTO sync_runs
         (run_id,source,lane,started_at,finished_at,walk_complete,files_seen,
          docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
          proposed_deletes,delete_action,refusal_reason,error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(...betaRunValues);
  }
}

function d1Env(db, label = "fixture") {
  const seen = { prepared: [], runs: 0, batches: 0 };
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "test-admin-key",
    RAG_PROXY_KEY: "test-proxy-key",
    SESSION_SIGNING_KEY: "test-session-signing-key-0123456789",
    BRAIN_NAME: label,
    DB: {
      prepare(sql) {
        seen.prepared.push(sql);
        const shape = (parameters = []) => ({
          bind: (...next) => shape(next),
          all: async () => ({ results: db.prepare(sql).all(...parameters) }),
          first: async () => db.prepare(sql).get(...parameters) ?? null,
          run: async () => {
            seen.runs++;
            throw new Error("source inventory must never execute a write statement");
          },
        });
        return shape();
      },
      async batch() {
        seen.batches++;
        throw new Error("source inventory must never execute a write batch");
      },
    },
  };
  return { env, seen };
}

test("source recovery pages summaries beyond 250 source groups", async () => {
  const db = migratedDb("many-source-groups");
  const insert = db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let index = 0; index < 260; index++) {
    const source = `source_${String(index).padStart(3, "0")}`;
    insert.run(
      `${source}:record`, source, "record", `Synthetic ${index}`,
      Date.parse("2026-09-01T00:00:00.000Z"), `hash-${index}`,
    );
  }
  const { env, seen } = d1Env(db, "many-source-groups");
  const first = await sourceRecoveryCandidates(env, { limit: 1 });
  assert.equal(first.total, 260);
  assert.equal(first.summary.candidate_source_groups, 260);
  assert.equal(first.summary.source_groups_returned, 250);
  assert.equal(first.summary.source_groups_truncated, true);
  assert.equal(first.summary.source_groups_cursor, "source_249");
  assert.deepEqual(
    first.summary.source_groups.map((group) => group.source_id),
    Array.from({ length: 250 }, (_, index) => `source_${String(index).padStart(3, "0")}`),
  );

  const second = await sourceRecoveryCandidates(env, {
    afterSourceId: first.summary.source_groups_cursor,
    limit: 1,
  });
  assert.equal(second.total, 260);
  assert.equal(second.summary.candidate_source_groups, 260);
  assert.equal(second.summary.source_groups_returned, 10);
  assert.equal(second.summary.source_groups_truncated, false);
  assert.equal(second.summary.source_groups_cursor, null);
  assert.deepEqual(
    second.summary.source_groups.map((group) => group.source_id),
    Array.from({ length: 10 }, (_, index) => `source_${index + 250}`),
  );

  const pastEnd = await sourceRecoveryCandidates(env, {
    afterRowId: 9_999_999,
    afterSourceId: "zzzzzz",
    limit: 1,
  });
  assert.equal(pastEnd.rows.length, 0);
  assert.equal(pastEnd.summary.source_groups_returned, 0);
  assert.equal(pastEnd.total, first.total,
    "an empty page must not collapse the snapshot-wide candidate total");
  assert.equal(pastEnd.summary.candidate_source_groups, first.summary.candidate_source_groups,
    "an empty source-group page must not collapse the snapshot-wide group total");
  assert.deepEqual(pastEnd.summary.reason_counts, first.summary.reason_counts,
    "an empty page must preserve the snapshot-wide reason totals");

  const firstResponse = await call(env, post(
    { mode: "recovery", limit: 1 },
    { "X-Admin-Key": "test-admin-key" },
  ));
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const firstReceipt = await firstResponse.json();
  assert.equal(firstReceipt.recovery_plan_summary.source_groups_truncated, true);
  assert.equal(firstReceipt.recovery_plan_summary.source_groups_cursor, "source_249");
  const secondResponse = await call(env, post(
    {
      mode: "recovery",
      limit: 1,
      source_group_cursor: firstReceipt.recovery_plan_summary.source_groups_cursor,
    },
    { "X-Admin-Key": "test-admin-key" },
  ));
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  const secondReceipt = await secondResponse.json();
  assert.equal(secondReceipt.recovery_plan_summary.source_groups_returned, 10);
  assert.equal(secondReceipt.recovery_plan_summary.source_groups_truncated, false);
  assert.equal(secondReceipt.recovery_plan_summary.source_groups_cursor, null);
  assert.equal(seen.runs, 0);
  assert.equal(seen.batches, 0);
  db.close();
});

const post = (body = {}, headers = {}) => new Request(`${ORIGIN}/api/admin/brain/sources`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const call = (env, request) => worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });

function cursorWithVersion(value, version) {
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  return Buffer.from(JSON.stringify({ ...decoded, v: version }), "utf8").toString("base64url");
}

async function ownerHeaders(env, credential = OWNER_CREDENTIAL, grantId = null) {
  const cookie = await mintSessionCookie(env, 1, { credentialId: credential, grantId });
  return { Cookie: cookie.split(";")[0], "X-Brain-App": "1" };
}

test("source inventory auth is owner-only and private", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const { env } = d1Env(db);

  const anonymous = await call(env, post());
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control") || "", /private.*no-store/);

  const proxy = await call(env, post({}, { "X-Admin-Key": "test-proxy-key" }));
  assert.equal(proxy.status, 401, "the retrieval proxy key is not owner authority");

  const admin = await call(env, post({}, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(admin.status, 200, await admin.clone().text());

  const owner = await call(env, post({}, await ownerHeaders(env)));
  assert.equal(owner.status, 200, await owner.clone().text());

  const ownerNoCsrf = await call(env, post({}, {
    Cookie: (await ownerHeaders(env)).Cookie,
  }));
  assert.equal(ownerNoCsrf.status, 401, "an owner cookie still needs the companion app header");

  const scoped = await call(env, post({}, await ownerHeaders(env, SCOPED_CREDENTIAL, "g_scoped")));
  assert.equal(scoped.status, 403, "even an administer-capable scoped passkey is not the owner");
  assert.equal((await scoped.json()).code, "owner_required");

  const queryCredential = await call(env, post({}, {}));
  assert.equal(queryCredential.status, 401, "a key cannot move into a URL or body");

  const wrongMethod = await call(env, new Request(`${ORIGIN}/api/admin/brain/sources`, {
    headers: { "X-Admin-Key": "test-admin-key" },
  }));
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get("cache-control") || "", /private.*no-store/);
});

test("source inventory pages are complete, stable, supported, and read-only", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const { env, seen } = d1Env(db);
  const changesBefore = db.prepare("SELECT total_changes() AS n").get().n;
  const passkeysBefore = db.prepare("SELECT COUNT(*) AS n FROM owner_passkeys").get().n;
  const eventsBefore = db.prepare("SELECT COUNT(*) AS n FROM source_events").get().n;

  const firstResponse = await call(env, post({ limit: 1 }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const first = await firstResponse.json();
  assert.equal(first.contract_version, 3);
  assert.equal(first.total, 3);
  assert.equal(first.returned, 1);
  assert.equal(first.truncated, true);
  assert.equal(first.complete, false);
  assert.ok(first.cursor);
  assert.equal(first.snapshot.total, 3);
  assert.equal(first.snapshot.as_of, first.as_of);
  assert.equal(first.sources[0].source_id, "alpha");
  assert.equal(first.recovery_plan_summary.status, "review_needed");
  assert.equal(first.recovery_plan_summary.candidate_documents, 3);
  assert.equal(first.recovery_plan_summary.candidate_source_groups, 3);
  assert.equal(first.recovery_plan_summary.source_groups_returned, 3);
  assert.equal(first.recovery_plan_summary.source_groups_truncated, false);
  assert.equal(first.recovery_plan_summary.priority, "high");
  assert.deepEqual(
    first.recovery_plan_summary.source_groups.map((group) => group.source_id),
    ["alpha", "beta", "orphan"],
  );
  assert.equal(first.recovery_plan_summary.reason_counts.no_stored_chunks, 1);
  assert.equal(first.recovery_plan_summary.reason_counts.provenance_receipt_unassessed, 1);
  assert.equal(first.recovery_plan_summary.reason_counts.derivation_lineage_missing, 2);
  assert.equal(first.recovery_plan_summary.reason_counts.lineage_contract_unrecognized, 0);
  assert.equal(first.sources[0].zone, "books");
  assert.deepEqual(first.sources[0].connector, {
    kind: "drive",
    provider: "google",
    provider_identity_status: "supported",
  });
  assert.deepEqual(first.sources[0].configuration.scope, {
    status: "supported",
    masked: true,
    format: "json_object",
    recorded_fields: ["root_folder_ids"],
    configured_root_count: 2,
  });
  assert.deepEqual(first.sources[0].configuration.cursor, {
    status: "present",
    masked: true,
    updated_at: "2026-09-09T00:01:00.000Z",
  });
  assert.deepEqual(first.sources[0].storage, {
    physical_documents: 2,
    logical_documents: 2,
    chunks: 1,
    readable_documents: 1,
    unreadable_documents: 1,
    basis: "document rows are attributed by a validated family_of or part_of receipt when present, otherwise by doc_uid; readable means at least one nonblank stored chunk",
  });
  assert.equal(first.sources[0].readability.status, "partial");
  assert.equal(first.sources[0].readability.empty_documents, 1);
  assert.equal(first.sources[0].readability.scan_only_documents, null);
  assert.equal(first.sources[0].readability.scan_only_status, "unavailable");
  assert.equal(first.sources[0].readability.likely_ocr_candidates, 0);
  assert.equal(first.sources[0].readability.ocr_retry_candidates, 1);
  assert.equal(first.sources[0].readability.ocr_partial_documents, 1);
  assert.equal(first.sources[0].provenance.status, "complete");
  assert.deepEqual(first.sources[0].provenance.missing_subfields, []);
  assert.equal(first.sources[0].provenance.lineage.recognized_contract_documents, 2);
  assert.equal(first.sources[0].provenance.lineage.family_marker_documents, 1);
  assert.equal(first.sources[0].recovery_plan.candidate_documents, 1);
  assert.equal(first.sources[0].receipt.reported_logical_documents, 2);
  assert.equal(first.sources[0].receipt.logical_matches_reported, true);
  assert.equal(first.sources[0].receipt.first_ingest_observed_at, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(first.sources[0].receipt.first_ingest_evidence, ["stored_document", "sync_run"]);
  assert.equal(first.sources[0].receipt.last_successful_run_at, "2026-09-09T00:01:00.000Z");
  assert.equal(first.sources[0].receipt.complete_history_through, "2026-09-09T00:00:00.000Z");
  assert.equal(first.sources[0].receipt.latest_run.outcome, "completed");
  assert.equal(first.sources[0].receipt.latest_run.metrics_version, 1);
  assert.equal(first.sources[0].receipt.latest_run.docs_refused, 0);
  assert.equal(first.sources[0].receipt.latest_run.docs_failed, 0);
  assert.equal(first.sources[0].last_failure, null);
  assert.equal(first.sources[0].freshness.coverage.history.state, "complete");
  assert.deepEqual(first.sources[0].freshness.coverage.confirmed_range, {
    from: "2020-01-01T00:00:00.000Z",
    through: "2026-09-09T00:00:00.000Z",
  });
  assert.deepEqual(first.sources[0].freshness.coverage.counts, {
    seen: 2,
    accepted: 2,
    refused: 0,
    failed: 0,
  });

  const secondResponse = await call(env, post({ limit: 1, cursor: first.cursor }, { "X-Admin-Key": "test-admin-key" }));
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200, JSON.stringify(second));
  assert.equal(second.sources[0].source_id, "beta");
  assert.equal(second.sources[0].receipt.logical_matches_reported, false);
  assert.equal(second.sources[0].provenance.status, "partial");
  assert.deepEqual(second.sources[0].provenance.missing_subfields, ["derivation_lineage"]);
  assert.equal(second.sources[0].freshness.state, "broken");
  assert.deepEqual(second.sources[0].last_failure, SAFE_GMAIL_FAILURE);
  assert.doesNotMatch(
    JSON.stringify({ first, second }),
    /secret-account|private provider failure|private-cursor|private-root|secret scope label/i,
  );
  assert.equal(second.snapshot.id, first.snapshot.id);
  assert.equal(second.as_of, first.as_of);

  const thirdResponse = await call(env, post({ limit: 1, cursor: second.cursor }, { "X-Admin-Key": "test-admin-key" }));
  const third = await thirdResponse.json();
  assert.equal(thirdResponse.status, 200, JSON.stringify(third));
  assert.equal(third.sources[0].source_id, "orphan");
  assert.equal(third.sources[0].registered, false);
  assert.equal(third.sources[0].receipt, null);
  assert.equal(third.sources[0].connector.provider, null);
  assert.equal(third.sources[0].configuration.status, "unavailable");
  assert.equal(third.sources[0].freshness.state, "unregistered");
  assert.equal(third.sources[0].last_failure, null);
  assert.equal(third.truncated, false);
  assert.equal(third.cursor, null);
  assert.equal(third.complete, true);

  for (const page of [first, second, third]) {
    assert.equal(page.limitations.entity_year_coverage, "not_available");
    for (const row of page.sources) {
      for (const forbidden of ["entity", "entity_slug", "year", "tax_year", "admin_key", "token", "secret", "credential"]) {
        assert.equal(forbidden in row, false, `source rows must not invent or expose ${forbidden}`);
      }
    }
  }

  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changesBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM owner_passkeys").get().n, passkeysBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_events").get().n, eventsBefore);
  assert.equal(seen.runs, 0);
  assert.equal(seen.batches, 0);
  assert.ok(seen.prepared.every((sql) => !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql)));
});

test("source inventory counts only the current mapped custom-source document", async () => {
  const db = migratedDb("custom-current");
  db.prepare(
    `INSERT INTO sources (name,kind,status,created_at,last_ingest_at,document_count)
     VALUES ('custom-source','custom_api','ready','2026-09-24T00:00:00.000Z','2026-09-24T00:00:00.000Z',1)`,
  ).run();
  const jobHash = "a".repeat(64);
  const insertJob = db.prepare(
    `INSERT INTO custom_api_jobs
       (job_id,source,fetched_at,status,next_slice,total_slices,job_hash,response_hashes_json,stats_json,created_at,verified_at)
     VALUES (?,?,?,?,0,0,?,'{}','{}',?,?)`,
  );
  insertJob.run("job-current", "custom-source", "2026-09-24T00:00:00.000Z", "verified", jobHash,
    "2026-09-24T00:00:00.000Z", "2026-09-24T00:00:00.000Z");
  insertJob.run("job-staged", "custom-source", "2026-09-25T00:00:00.000Z", "staged", jobHash,
    "2026-09-25T00:00:00.000Z", null);
  db.prepare(
    "INSERT INTO custom_api_current_jobs (source,job_id,promoted_at) VALUES ('custom-source','job-current','2026-09-24T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO custom_api_document_versions (source,job_id,logical_source_id,document_source_id) VALUES ('custom-source','job-current','logical','current')",
  ).run();
  const insertDocument = db.prepare(
    `INSERT INTO documents (doc_uid,source,source_id,title,content_hash,ingested_at,meta,text_source,text_reliable)
     VALUES (?1,'custom-source',?2,?2,?3,?4,?5,'native',1)`,
  );
  const insertChunk = db.prepare(
    "INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source) VALUES (?1,?2,0,'fixture','custom-source')",
  );
  for (const [id, jobId] of [["current", "job-current"], ["staged", "job-staged"], ["superseded", "job-old"]]) {
    insertDocument.run(`custom-source:${id}`, id, `hash-${id}`, Date.parse("2026-09-24T00:00:00.000Z"), JSON.stringify({
      connector: "custom_api",
      custom_api_job_id: jobId,
      custom_api_source_id: "logical",
    }));
    insertChunk.run(`custom-source:${id}#0`, `custom-source:${id}`);
  }
  const { env, seen } = d1Env(db, "custom-current");
  const inventory = await sourceInventory(env, { now: Date.parse("2026-09-24T01:00:00.000Z") });
  const custom = inventory.rows.find((row) => row.source_id === "custom-source");
  assert.ok(custom, "the custom source reached the inventory rollup decision point");
  assert.deepEqual(custom.storage, {
    physical_documents: 1,
    logical_documents: 1,
    chunks: 1,
    readable_documents: 1,
    unreadable_documents: 0,
    basis: "document rows are attributed by a validated family_of or part_of receipt when present, otherwise by doc_uid; readable means at least one nonblank stored chunk",
  });
  assert.equal(seen.runs, 0);
  assert.equal(seen.batches, 0);
});

test("latest run truth keeps bounded ingest success separate from whole-source completeness", async () => {
  const db = migratedDb("run-truth");
  const privateSentinel = "SYNTHETIC_PRIVATE_OLD_RUN /private/source/path secret-account@example.invalid";
  const lastComplete = "2026-09-07T00:01:00.000Z";
  const latestFinished = "2026-09-09T00:01:00.000Z";
  const cases = [
    {
      source: "bounded_clean", kind: "upload", lane: "manual", walkComplete: 0, refused: 0, failed: 0,
      outcome: "partial", lastSuccessful: latestFinished, completeThrough: lastComplete,
      history: "needs_attention",
    },
    {
      source: "refused_gap", kind: "gmail", lane: "sweep", walkComplete: 1, refused: 1, failed: 0,
      outcome: "partial", lastSuccessful: latestFinished, completeThrough: lastComplete,
      history: "needs_attention",
    },
    {
      source: "failed_gap", kind: "drive", lane: "sweep", walkComplete: 1, refused: 0, failed: 1,
      outcome: "failed", lastSuccessful: lastComplete, completeThrough: lastComplete,
      history: "needs_attention",
    },
    {
      source: "incremental_clean", kind: "drive", lane: "incremental", walkComplete: 1, refused: 0, failed: 0,
      outcome: "completed", lastSuccessful: latestFinished, completeThrough: lastComplete,
      history: "complete",
    },
    {
      source: "full_clean", kind: "drive", lane: "sweep", walkComplete: 1, refused: 0, failed: 0,
      outcome: "completed", lastSuccessful: latestFinished, completeThrough: latestFinished,
      history: "complete", confirmedFrom: "2020-01-01T00:00:00.000Z", confirmedThrough: latestFinished,
    },
  ];
  const insertSource = db.prepare(
    `INSERT INTO sources
       (name,kind,status,created_at,last_ingest_at,document_count,last_complete_sweep_at)
     VALUES (?,?,'ready','2026-09-01T00:00:00.000Z',?,0,?)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO sync_runs
       (run_id,source,lane,started_at,finished_at,walk_complete,files_seen,
        docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
        confirmed_from,confirmed_through,error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  for (const shape of cases) {
    insertSource.run(shape.source, shape.kind, latestFinished, shape.completeThrough);
    insertRun.run(
      `${shape.source}-private-old-failure`, shape.source, "sweep",
      Date.parse("2026-09-06T00:00:00.000Z"), Date.parse("2026-09-06T00:01:00.000Z"),
      0, 0, 0, 0, 0, 0, 0, 1, null, null, privateSentinel,
    );
    insertRun.run(
      `${shape.source}-clean`, shape.source, "sweep",
      Date.parse("2026-09-07T00:00:00.000Z"), Date.parse(lastComplete),
      1, 2, 1, 0, 1, 0, 0, 1,
      "2020-01-01T00:00:00.000Z", lastComplete, null,
    );
    insertRun.run(
      `${shape.source}-latest`, shape.source, shape.lane,
      Date.parse("2026-09-09T00:00:00.000Z"), Date.parse(latestFinished),
      shape.walkComplete, 3, 1, 0, 1, shape.refused, shape.failed, 1,
      shape.confirmedFrom || null, shape.confirmedThrough || null, null,
    );
  }

  const { env, seen } = d1Env(db, "run-truth");
  const changesBefore = db.prepare("SELECT total_changes() AS n").get().n;
  const response = await call(env, post({ limit: 10 }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(response.status, 200, await response.clone().text());
  const inventory = await response.json();
  assert.deepEqual(
    inventory.sources.map((source) => source.source_id),
    ["bounded_clean", "failed_gap", "full_clean", "incremental_clean", "refused_gap"],
  );

  for (const shape of cases) {
    const source = inventory.sources.find((candidate) => candidate.source_id === shape.source);
    assert.equal(source.receipt.latest_run.outcome, shape.outcome, shape.source);
    assert.equal(source.receipt.last_successful_run_at, shape.lastSuccessful, shape.source);
    assert.equal(source.receipt.complete_history_through, shape.completeThrough, shape.source);
    assert.equal(source.freshness.coverage.history.state, shape.history, shape.source);
    assert.deepEqual(source.freshness.coverage.confirmed_range, {
      from: shape.confirmedFrom || null,
      through: shape.confirmedThrough || null,
    }, shape.source);
    assert.equal(source.receipt.latest_run.docs_refused, shape.refused, shape.source);
    assert.equal(source.receipt.latest_run.docs_failed, shape.failed, shape.source);
  }
  assert.equal(
    inventory.sources.find((source) => source.source_id === "bounded_clean")
      .freshness.coverage.counts.seen,
    null,
    "a bounded successful ingest must not expose its counters as a measured whole-source walk",
  );
  assert.doesNotMatch(
    JSON.stringify(inventory),
    /SYNTHETIC_PRIVATE_OLD_RUN|private\/source\/path|secret-account/i,
  );
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changesBefore);
  assert.equal(seen.runs, 0);
  assert.equal(seen.batches, 0);
});

test("source inventory suppresses stored Gmail failure evidence that fails the closed privacy contract", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const privateSentinel = "SYNTHETIC_PRIVATE_PROVIDER_MESSAGE /private/message-id cursor-value secret";
  db.prepare("UPDATE sync_runs SET failure_evidence=? WHERE source='beta'").run(JSON.stringify({
    ...SAFE_GMAIL_FAILURE,
    provider_message: privateSentinel,
  }));
  const { env } = d1Env(db);
  const response = await call(env, post({ limit: 10 }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(response.status, 200, await response.clone().text());
  const inventory = await response.json();
  const beta = inventory.sources.find((source) => source.source_id === "beta");
  assert.equal(beta.last_failure, null);
  assert.doesNotMatch(JSON.stringify(inventory), /SYNTHETIC_PRIVATE_PROVIDER_MESSAGE|message-id|cursor-value|secret/i);
});

test("source inventory reads schema 39 with unknown failure evidence and rethrows non-schema failures", async () => {
  const db = migratedDb("schema39", { throughMigration: 39 });
  await addInventoryFixture(db, "", { includeFailureEvidence: false });
  const { env, seen } = d1Env(db, "schema39");
  const response = await call(env, post({ limit: 10 }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(response.status, 200, await response.clone().text());
  const inventory = await response.json();
  assert.equal(inventory.contract_version, 3);
  const beta = inventory.sources.find((source) => source.source_id === "beta");
  assert.equal(beta.last_failure, null);
  assert.equal(beta.receipt.latest_run.metrics_version, 1);
  assert.equal(beta.receipt.latest_run.docs_failed, 1);
  assert.ok(seen.prepared.some((sql) => /NULL AS failure_evidence/.test(sql)));
  assert.doesNotMatch(JSON.stringify(inventory), /private provider failure|secret-account/i);

  let attempts = 0;
  await assert.rejects(
    sourceInventory({
      DB: {
        prepare() {
          attempts++;
          throw new Error("D1 transport timeout");
        },
      },
    }),
    /D1 transport timeout/,
  );
  assert.equal(attempts, 1, "non-schema failures must not enter the compatibility retry");
});

test("source recovery preview is exhaustive through stable opaque pages and performs no repair", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const { env, seen } = d1Env(db);
  const changesBefore = db.prepare("SELECT total_changes() AS n").get().n;

  const pages = [];
  let cursor = null;
  do {
    const response = await call(env, post({
      mode: "recovery",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    }, { "X-Admin-Key": "test-admin-key" }));
    assert.equal(response.status, 200, await response.clone().text());
    const page = await response.json();
    pages.push(page);
    cursor = page.cursor;
  } while (cursor);

  assert.equal(pages.length, 3);
  assert.ok(pages.every((page) => page.total === 3));
  assert.ok(pages.every((page) => page.returned === 1));
  assert.ok(pages.slice(0, -1).every((page) => page.truncated && !page.complete));
  assert.equal(pages.at(-1).truncated, false);
  assert.equal(pages.at(-1).complete, true);
  assert.equal(pages.at(-1).cursor, null);
  assert.ok(pages.every((page) => page.snapshot.id === pages[0].snapshot.id));
  assert.ok(pages.every((page) => page.as_of === pages[0].as_of));
  assert.ok(pages.every((page) => page.recovery_plan_summary.candidate_documents === 3));
  assert.ok(pages.every((page) => page.recovery_plan_summary.candidate_pages_at_requested_size === 3));
  assert.ok(pages.every((page) => page.recovery_plan_summary.source_groups.length === 3));
  assert.ok(pages.every((page) => page.recovery_plan_summary.source_groups_truncated === false));
  assert.deepEqual(
    pages[0].recovery_plan_summary.source_groups.map((group) => group.source_id),
    ["alpha", "beta", "orphan"],
  );

  const candidates = pages.flatMap((page) => page.candidates);
  assert.deepEqual(candidates.map((candidate) => candidate.source_id), ["alpha", "beta", "orphan"]);
  assert.ok(candidates.every((candidate) => /^hmac-sha256:[a-f0-9]{64}$/.test(candidate.record_id)));
  assert.ok(candidates.every((candidate) => candidate.locator.value === candidate.record_id));
  assert.ok(candidates.every((candidate) => candidate.locator.reversible === false));
  assert.equal(candidates[0].text.content_state, "empty");
  assert.equal(candidates[0].text.extraction_method, "ocr_partial");
  assert.equal(candidates[0].ocr.retry_candidate, true);
  assert.equal(candidates[0].ocr.partial_review, true);
  assert.deepEqual(candidates[0].provenance.missing_subfields, []);
  assert.deepEqual(candidates[1].provenance.missing_subfields, ["derivation_lineage"]);
  assert.deepEqual(candidates[2].provenance.missing_subfields, [
    "validated_provenance_receipt",
    "source_record_id",
    "extraction_method",
    "text_reliability",
    "derivation_lineage",
  ]);
  assert.deepEqual(candidates[2].reasons, [
    "provenance_receipt_unassessed",
    "extraction_method_missing",
    "text_reliability_missing",
    "source_record_id_missing",
    "derivation_lineage_missing",
  ]);
  assert.equal(candidates[1].plan.mode, "preview_only");

  const filteredResponse = await call(env, post({
    mode: "recovery",
    source: "alpha",
    limit: 10,
  }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(filteredResponse.status, 200, await filteredResponse.clone().text());
  const filtered = await filteredResponse.json();
  assert.equal(filtered.source_filter, "alpha");
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.candidates.map((candidate) => candidate.source_id), ["alpha"]);

  const serialized = JSON.stringify({ pages, filtered });
  assert.doesNotMatch(
    serialized,
    /Invented alpha|Invented beta|Invented orphan|alpha:two|private-cursor|private-root|secret-account|private provider failure/i,
  );
  for (const forbidden of ["title", "uri", "doc_uid", "raw_source_id", "provider_record_id"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, `${forbidden} must not cross the recovery boundary`);
  }

  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changesBefore);
  assert.equal(seen.runs, 0);
  assert.equal(seen.batches, 0);
});

test("source inventory refuses mixed snapshots and owner selection", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const { env } = d1Env(db);
  const first = await (await call(env, post({ limit: 1 }, { "X-Admin-Key": "test-admin-key" }))).json();

  const oldContractResponse = await call(env, post({
    limit: 1,
    cursor: cursorWithVersion(first.cursor, 2),
  }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(oldContractResponse.status, 400);
  assert.match(await oldContractResponse.text(), /cursor is not valid/);

  db.prepare(
    `INSERT INTO sources (name,kind,status,created_at,document_count)
     VALUES ('gamma','upload','pending','2026-09-10T00:00:00.000Z',0)`,
  ).run();
  const changedResponse = await call(env, post({ limit: 1, cursor: first.cursor }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(changedResponse.status, 409);
  assert.equal((await changedResponse.json()).code, "source_inventory_changed");

  const recoveryFirst = await (await call(env, post({
    mode: "recovery",
    limit: 1,
  }, { "X-Admin-Key": "test-admin-key" }))).json();
  db.prepare(
    `UPDATE documents
        SET text_source=CASE doc_uid
          WHEN 'alpha:two' THEN 'ocr'
          WHEN 'beta:one' THEN 'ocr_partial'
          ELSE text_source
        END
      WHERE doc_uid IN ('alpha:two','beta:one')`,
  ).run();
  const changedRecovery = await call(env, post({
    mode: "recovery",
    limit: 1,
    cursor: recoveryFirst.cursor,
  }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(changedRecovery.status, 409);
  assert.equal((await changedRecovery.json()).code, "source_inventory_changed");

  const ownerSelector = await call(env, post({ owner_id: "somebody-else" }, { "X-Admin-Key": "test-admin-key" }));
  assert.equal(ownerSelector.status, 400, "the caller cannot select another owner or database");
  assert.doesNotMatch(await ownerSelector.text(), /alpha|beta|orphan|gamma/);

  const otherDb = migratedDb("other-owner");
  otherDb.prepare(
    `INSERT INTO sources (name,kind,status,created_at,document_count)
     VALUES ('zeta','upload','pending','2026-09-10T00:00:00.000Z',0)`,
  ).run();
  const { env: otherEnv } = d1Env(otherDb, "other-owner");
  const other = await (await call(otherEnv, post({}, { "X-Admin-Key": "test-admin-key" }))).json();
  assert.deepEqual(other.sources.map((row) => row.source_id), ["zeta"]);
  assert.doesNotMatch(JSON.stringify(other), /alpha|beta|orphan|gamma/);
});

/**
 * Replace the store boundary with one that refuses the source statements.
 *
 * Only the two whole-corpus statements fail; the marker read and every other
 * prepare still works, so the route reaches the same catch it reaches in the
 * field instead of failing earlier for an unrelated reason.
 */
function refusingEnv(db, error) {
  const { env } = d1Env(db);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB = {
    prepare(sql) {
      if (/live_documents AS MATERIALIZED/.test(sql)) throw error;
      return prepare(sql);
    },
    async batch() { throw new Error("source inventory must never execute a write batch"); },
  };
  return env;
}

/** Collect the route's own warnings instead of letting them reach the runner. */
async function withCapturedWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return { value: await run(), warnings }; } finally { console.warn = original; }
}

test("a refused inventory names its cause without carrying the statement or the corpus", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const failure = new RangeError(
    "D1_ERROR: query exceeded the memory limit while reading 'SELECT d.meta FROM documents'"
    + " for \"SYNTHETIC_PRIVATE_DOCUMENT secret-account@example.invalid\"\nstack frame omitted",
  );
  failure.code = "d1_resource_exhausted";

  const { value: [inventory, recovery], warnings } = await withCapturedWarnings(async () => {
    const env = refusingEnv(db, failure);
    return [
      await call(env, post({ limit: 1 }, { "X-Admin-Key": "test-admin-key" })),
      await call(env, post({ mode: "recovery", limit: 1 }, { "X-Admin-Key": "test-admin-key" })),
    ];
  });

  assert.equal(inventory.status, 503);
  const inventoryBody = await inventory.json();
  assert.equal(inventoryBody.code, "source_inventory_unavailable");
  assert.equal(inventoryBody.detail.error_class, "RangeError");
  assert.equal(inventoryBody.detail.failure_code, "d1_resource_exhausted");
  assert.equal(inventoryBody.detail.redacted, true);
  assert.match(inventoryBody.detail.reason, /query exceeded the memory limit/);
  assert.ok(inventoryBody.detail.reason.length <= 160);

  assert.equal(recovery.status, 503);
  const recoveryBody = await recovery.json();
  assert.equal(recoveryBody.code, "source_inventory_unavailable");
  assert.equal(recoveryBody.detail.error_class, "RangeError");

  const serialized = JSON.stringify({ inventoryBody, recoveryBody });
  for (const forbidden of [
    "SELECT", "documents", "d.meta", "SYNTHETIC_PRIVATE_DOCUMENT", "secret-account", "stack frame",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `the detail must not carry ${forbidden}`);
  }
  assert.equal(warnings.length, 2, "each refusal is recorded once for the owner's logs");
  for (const warning of warnings) {
    assert.match(warning, /^\[source-inventory\] .* refused: RangeError \(d1_resource_exhausted\): /);
    assert.doesNotMatch(warning, /SELECT|SYNTHETIC_PRIVATE_DOCUMENT|secret-account/);
  }
});

test("the too-large and changed refusals keep their codes while gaining a detail", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);

  const oversized = new Error("source inventory exceeds the safe row limit");
  oversized.code = "source_inventory_too_large";
  const { value: tooLarge } = await withCapturedWarnings(
    () => call(refusingEnv(db, oversized), post({}, { "X-Admin-Key": "test-admin-key" })),
  );
  assert.equal(tooLarge.status, 503);
  const tooLargeBody = await tooLarge.json();
  assert.equal(tooLargeBody.code, "source_inventory_too_large");
  assert.equal(tooLargeBody.detail.failure_code, "source_inventory_too_large");

  const changed = new Error("source recovery inventory changed during the read");
  changed.code = "source_recovery_changed";
  const { value: changedResponse } = await withCapturedWarnings(
    () => call(refusingEnv(db, changed), post({
      mode: "recovery",
      limit: 1,
    }, { "X-Admin-Key": "test-admin-key" })),
  );
  assert.equal(changedResponse.status, 409);
  const changedBody = await changedResponse.json();
  assert.equal(changedBody.code, "source_inventory_changed");
  assert.equal(changedBody.detail.failure_code, "source_recovery_changed");

  const { value: anonymous } = await withCapturedWarnings(
    () => call(refusingEnv(db, oversized), post()),
  );
  assert.equal(anonymous.status, 401, "a refused statement never reaches an unauthorized caller");
  assert.equal("detail" in await anonymous.json(), false);
});

test("an unnamed store failure still returns a usable, bounded detail", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const failure = new Error(`${"private-".repeat(60)}detail`);
  failure.name = "not a valid class";
  failure.code = "NOT_A_VALID_CODE";
  const { value: response } = await withCapturedWarnings(
    () => call(refusingEnv(db, failure), post({}, { "X-Admin-Key": "test-admin-key" })),
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.detail.error_class, "Error", "an unusable class falls back to the generic one");
  assert.equal(body.detail.failure_code, null, "an unusable code is dropped rather than echoed");
  assert.equal(body.detail.reason.length, 160, "the reason is truncated, not omitted");

  const empty = new Error("");
  const { value: emptyResponse } = await withCapturedWarnings(
    () => call(refusingEnv(db, empty), post({}, { "X-Admin-Key": "test-admin-key" })),
  );
  assert.equal((await emptyResponse.json()).detail.reason, null);
});

// Exercise the real receipt route, SQLite rollup, daily status, and public count.
test("mixed accepted and refused refresh advances success while failures and missing history remain distinct", async () => {
  const { sourceFreshnessCounts, freshnessReport } = await import("../src/lib/store-d1.js");
  const { dailyFreshnessRows, localReceiptCoverage } = await import("../../brain.mjs");
  const refusedFiles = Array.from({ length: 228 }, (_, index) => ({
    path: `unsupported-${String(index).padStart(3, "0")}.blob`, reason: "unsupported format",
  }));
  const measured = localReceiptCoverage({ created: 9, updated: 22, refused: 0 }, refusedFiles);
  assert.equal(measured.docsRefused, 228, "the real local receipt classifier reached every invented file");
  const excluded = localReceiptCoverage({}, Array.from({ length: 3 }, (_, index) => ({
    path: `excluded-${index}.txt`, adjudication: "source_policy", coverage_gap: false,
  })));
  assert.equal(excluded.adjudicatedSkips, 3);
  assert.equal(excluded.coverageGaps, 0, "policy decisions retain their deletion-safety classification");
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const before = "2026-10-06T12:00:00.000Z";
  const after = "2026-10-07T11:00:00.000Z";
  for (const shape of [
    { name: "clean", refused: 0, failed: 0, outcome: "completed", advances: true },
    { name: "unsupported", refused: measured.docsRefused, failed: 0, outcome: "partial", advances: true },
    { name: "policy-excluded", refused: excluded.docsRefused, failed: 0, outcome: "partial", advances: true },
    { name: "transient", refused: 228, failed: 1, outcome: "failed", advances: false },
  ]) {
    const db = migratedDb("freshness-fixture");
    const { env, seen } = d1Env(db);
    // Only this route test supplies writes; ordinary inventory tests stay read-only.
    env.DB.prepare = (sql) => {
      const shape = (args = []) => ({
        bind: (...values) => shape(values),
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => { seen.runs++; return db.prepare(sql).run(...args); },
      });
      return shape();
    };
    env.DB.batch = async (statements) => { seen.batches++; return Promise.all(statements.map((s) => s.run())); };
    const send = async (run_id, completed_at, refused, failed) => {
      const response = await call(env, new Request(`${ORIGIN}/api/admin/brain/source-receipt`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": "test-admin-key" },
        body: JSON.stringify({ source: "folder", kind: "upload", status: "ready", run_id,
          started_at: completed_at, completed_at, walk_complete: true, complete_sweep: true,
          files_seen: 31 + refused + failed, docs_added: 9, docs_updated: 22,
          docs_unchanged: 0, docs_refused: refused, docs_failed: failed }),
      }));
      assert.equal(response.status, 200);
    };
    await send("prior", before, 0, 0);
    db.prepare("UPDATE sources SET expected_refresh_seconds=86400 WHERE name='folder'").run();
    await send("latest", after, shape.refused, shape.failed);
    assert.ok(seen.batches >= 2 && seen.runs > 0, "both receipt decisions reached durable writes");
    const inventory = await sourceInventory(env, { now });
    assert.equal(inventory.rows.length, 1);
    const source = inventory.rows[0];
    assert.equal(source.receipt.latest_run.outcome, shape.outcome, shape.name);
    assert.equal(source.receipt.last_successful_run_at, shape.advances ? after : before, shape.name);
    assert.equal(source.receipt.latest_run.docs_refused, shape.refused);
    assert.equal(source.receipt.complete_history_through, shape.refused ? before : after);
    const counts = await sourceFreshnessCounts(env, { now });
    assert.equal(counts.total, 1);
    assert.equal(counts.stale, shape.advances ? 0 : 1, shape.name);
    const detailed = await freshnessReport(env, { now });
    assert.equal(detailed.sources[0].state, shape.advances ? "ok" : "broken");
    const [daily] = dailyFreshnessRows({ sources: [{ key: "folder", source_names: ["folder"] }] },
      { sources: [{ ...source, name: "folder" }] });
    assert.equal(daily.last_run_outcome, shape.outcome);
    assert.equal(daily.docs_refused, shape.refused);
    assert.equal(daily.current_state, shape.advances ? "ok" : "broken");
    db.close();
  }
  const [missing] = dailyFreshnessRows({ sources: [{ key: "folder" }] }, { sources: [] });
  assert.equal(missing.last_run_outcome, "missing_history");
  assert.equal(missing.current_state, "unknown");
});

for (const arm of [
  {name:'accepted-control', added:1, refused:2, failed:0, advances:true},
  {name:'verified-unchanged-control', added:0, unchanged:3, refused:0, failed:0, advances:true},
  {name:'all-refused', added:0, refused:3, failed:0, advances:false},
  {name:'empty-measured', added:0, refused:0, failed:0, advances:false},
  {name:'real-failure-control', added:1, refused:0, failed:1, advances:false},
]) {
  test(`BOUNDARY freshness ${arm.name}`, async () => {
    const db=migratedDb('boundary-fixture');
    try {
      const {env,seen}=d1Env(db);
      env.DB.prepare=(sql)=>{
        const bound=(args=[])=>({bind:(...values)=>bound(values),
          all:async()=>({results:db.prepare(sql).all(...args)}),
          first:async()=>db.prepare(sql).get(...args)??null,
          run:async()=>{seen.runs++;return db.prepare(sql).run(...args);}});
        return bound();
      };
      env.DB.batch=async(statements)=>{seen.batches++;return Promise.all(statements.map(s=>s.run()));};
      const before='2026-10-06T12:00:00.000Z';
      const after='2026-10-07T11:00:00.000Z';
      for (const [id,at,counts] of [['prior',before,{added:1,refused:0,failed:0}],['latest',after,arm]]) {
        const response=await call(env,new Request(`${ORIGIN}/api/admin/brain/source-receipt`,{
          method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':env.ADMIN_KEY},
          body:JSON.stringify({source:'folder',kind:'upload',status:'ready',run_id:id,
            started_at:at,completed_at:at,walk_complete:true,complete_sweep:true,
            files_seen:counts.added+(counts.unchanged||0)+counts.refused+counts.failed,
            docs_added:counts.added,docs_updated:0,docs_unchanged:counts.unchanged||0,
            docs_refused:counts.refused,docs_failed:counts.failed})}));
        assert.equal(response.status,200);
      }
      assert.equal(seen.batches,2,'both decisions reached the real receipt writes');
      assert.ok(seen.runs>0);
      const inventory=await sourceInventory(env,{now:Date.parse('2026-10-07T12:00:00.000Z')});
      assert.equal(inventory.rows.length,1);
      const source = inventory.rows[0];
      const receipt=source.receipt;
      console.log(JSON.stringify({probe:arm.name,batches:seen.batches,outcome:receipt.latest_run.outcome,advanced:receipt.last_successful_run_at===after}));
      assert.equal(receipt.last_successful_run_at,arm.advances?after:before,
        'zero accepted/unchanged documents must not advance success');
      assert.equal(receipt.last_ingest_receipt_at, arm.advances ? after : before);
      assert.equal(receipt.latest_run.outcome, arm.failed ? 'failed' : arm.advances
        ? (arm.refused ? 'partial' : 'completed') : arm.refused ? 'refused' : 'empty');
      assert.equal(receipt.latest_run.docs_added, arm.added);
      assert.equal(receipt.latest_run.docs_unchanged, arm.unchanged || 0);
      if (!arm.advances) {
        assert.equal(source.freshness.coverage.history.state, 'needs_attention');
        assert.equal(source.freshness.coverage.counts.accepted, arm.added + (arm.unchanged || 0));
      }
      assert.equal(receipt.complete_history_through, arm.advances && !arm.refused ? after : before);
      const { sourceFreshnessCounts, freshnessReport } = await import('../src/lib/store-d1.js');
      const { dailyFreshnessRows } = await import('../../brain.mjs');
      db.prepare("UPDATE sources SET expected_refresh_seconds=86400 WHERE name='folder'").run();
      const counts = await sourceFreshnessCounts(env, { now: Date.parse('2026-10-07T12:00:00.000Z') });
      assert.equal(counts.total, 1, 'public freshness reached the registered source');
      assert.equal(counts.stale, arm.advances ? 0 : 1);
      const detail = await freshnessReport(env, { now: Date.parse('2026-10-07T12:00:00.000Z') });
      assert.equal(detail.sources[0].state, arm.failed ? 'broken' : arm.advances ? 'ok' : 'review');
      const daily = dailyFreshnessRows({ sources: [{ key: 'folder' }] }, { sources: [source] });
      assert.equal(daily.length, 1);
      assert.equal(daily[0].last_run_outcome, receipt.latest_run.outcome);
      assert.equal(daily[0].current_state, arm.failed ? 'broken' : arm.advances ? 'manual' : 'review');
    } finally {db.close();}
  });
}

test("bounded inventory transport reaches indexed pages and matches the complete control", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const { env, seen } = d1Env(db);
  const response = await call(env, post({ mode: "bounded", limit: 2 }, { "X-Admin-Key": env.ADMIN_KEY }));
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.kind, "source_inventory_scan");
  assert.equal(page.scan.scanned, 2);
  assert.equal(page.truncated, true);
  assert.ok(seen.prepared.some((sql) => sql.includes("inventory_document_page AS MATERIALIZED")), "bounded decision reached");
  assert.equal(seen.runs, 0);
  db.close();
});

test("bounded transport and CLI preserve exact family counts across pages and detect mutation", async () => {
  const { collectSourceInventoryPages } = await import("../../brain.mjs");
  const { sourceInventorySlice } = await import("../src/lib/store-d1.js");
  const db = migratedDb();
  await addInventoryFixture(db);
  // An assessed family member on a later page must not count a second family.
  db.exec(`INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta,
    text_source,text_reliable,provenance_receipt_version,provenance_receipt_status,
    provenance_receipt_reason,provenance_receipt_digest)
    SELECT 'alpha:two#part2',source,source_id||'#part2',title,ingested_at,content_hash,meta,text_source,
    text_reliable,provenance_receipt_version,provenance_receipt_status,provenance_receipt_reason,
    provenance_receipt_digest FROM documents WHERE doc_uid='alpha:two'`);
  const { env } = d1Env(db);
  let reached = 0; const progress = [];
  const request = async (body) => { reached++; return call(env, post({ ...body, limit: 2 }, { "X-Admin-Key": env.ADMIN_KEY })); };
  const result = await collectSourceInventoryPages(request, { bounded: true, onProgress: (p) => progress.push(p) });
  const control = await sourceInventorySlice(env, { now: Date.parse(result.as_of), documentPage: { after: 0, limit: 5000 } });
  assert.deepEqual(result.sources, control.rows);
  assert.equal(result.sources.find((row) => row.name === "alpha").storage.logical_documents, 2);
  assert.equal(result.sources.find((row) => row.name === "alpha").storage.physical_documents, 3);
  assert.equal(reached, 3, "every work page reached the real Worker");
  assert.equal(progress.at(-1).scanned, 5);
  assert.doesNotMatch(JSON.stringify(result), /hmac-sha256|alpha:two|part2/);
  const first = await (await request({ mode: "bounded" })).json();
  db.exec("UPDATE documents SET text_reliable=0 WHERE doc_uid='alpha:one'");
  const changed = await request({ mode: "bounded", cursor: first.cursor });
  assert.equal(changed.status, 409, "same-count mutation refuses the next page");
  assert.equal(reached, 5, "mutation decision reached after the green control");
  db.close();
});

test("large fake D1 rejects whole-corpus JSON work but executes indexed bounded pages", async () => {
  const { collectSourceInventoryPages } = await import("../../brain.mjs");
  const { sourceInventorySql } = await import("../src/lib/store-d1.js");
  const db = migratedDb();
  db.exec(`INSERT INTO sources (name,kind,status,created_at) VALUES ('archive','drive','ready','2026-01-01');
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<200001)
    INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
      SELECT 'archive:'||i,'archive',CAST(i AS TEXT),'Synthetic',1,'fixture','{}' FROM n`);
  const { env, seen } = d1Env(db);
  const prepare = env.DB.prepare;
  let decision = 0, rejected = 0, bounded = 0;
  env.DB.prepare = (sql) => {
    if (sql.includes("live_documents AS MATERIALIZED")) {
      decision++;
      if (!sql.includes("inventory_document_page AS MATERIALIZED")) {
        rejected++;
        throw new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset");
      }
      bounded++;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(10001, 0, 5000);
      assert.ok(plan.some((row) => /SEARCH documents USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(row.detail)), "document range uses the rowid B-tree");
      assert.ok(plan.some((row) => /SEARCH chunks USING INDEX idx_chunks_doc/.test(row.detail)), "chunks use document index seeks");
    }
    return prepare(sql);
  };
  assert.throws(() => env.DB.prepare(sourceInventorySql()), /CPU time limit/);
  assert.equal(rejected, 1, "whole-corpus mutation reached CPU refusal");
  let requests = 0;
  const result = await collectSourceInventoryPages(async (body) => {
    requests++;
    return call(env, post(body, { "X-Admin-Key": env.ADMIN_KEY }));
  }, { bounded: true });
  assert.equal(result.sources[0].storage.physical_documents, 200001);
  assert.equal(result.sources[0].storage.logical_documents, 200001);
  assert.equal(requests, 41);
  assert.equal(bounded, 41);
  assert.equal(decision, 42, "control and every page reached the CPU decision");
  assert.equal(seen.runs, 0);
  assert.equal(seen.batches, 0);
  db.close();
});

test("daily freshness reads receipts without visiting corpus rows", async () => {
  const db = migratedDb();
  await addInventoryFixture(db);
  const { env, seen } = d1Env(db);
  const prepare = env.DB.prepare; const documentBounds = [];
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.includes("live_documents AS MATERIALIZED")) return statement;
    return { ...statement, bind: (...args) => {
      documentBounds.push(args[2]); return statement.bind(...args);
    } };
  };
  const response = await call(env, post({ mode: "freshness" }, { "X-Admin-Key": env.ADMIN_KEY }));
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.kind, "source_freshness");
  assert.equal(receipt.sources.length, 2, "both registered source decisions reached");
  assert.equal(receipt.sources.find((row) => row.name === "alpha").receipt.latest_run.outcome, "completed");
  assert.equal(receipt.sources.find((row) => row.name === "beta").receipt.latest_run.outcome, "failed");
  assert.ok(seen.prepared.some((sql) => /inventory_document_page AS MATERIALIZED/.test(sql)), "bounded reader reached");
  assert.ok(receipt.sources.every((row) => !('storage' in row)), "receipt-only mode cannot misrepresent zero storage");
  assert.deepEqual(documentBounds, [0], "the actual SQL bind visits zero corpus rows");
  assert.equal(seen.runs, 0);
  db.close();
});

test("bounded inventory shrinks dense pages and refuses a receipt-only mutation", async () => {
  const { sourceInventoryScanPage } = await import("../src/lib/source-inventory-scan.js");
  const db = migratedDb(); await addInventoryFixture(db);
  const { env } = d1Env(db); const prepare = env.DB.prepare;
  let limits = [];
  env.DB.prepare = (sql) => {
    if (sql.includes("LIMIT 50001")) return { bind: (_after, limit) => ({ first: async () => {
      limits.push(limit); return { n: limit > 2 ? 50001 : 2 };
    } }) };
    return prepare(sql);
  };
  const page = await sourceInventoryScanPage(env, { limit: 4, now: Date.parse("2026-10-01T00:00:00Z") });
  assert.deepEqual(limits, [4, 2], "the chunk budget decision reduced the page");
  assert.equal(page.scan.scanned, 2);
  assert.equal(page.scan.limit, 2);
  const before = db.prepare("SELECT source_original_retrieval_generation AS n FROM install_state").get().n;
  db.exec("UPDATE sync_runs SET docs_added=7 WHERE source='alpha'");
  assert.equal(db.prepare("SELECT source_original_retrieval_generation AS n FROM install_state").get().n, before,
    "this mutation must exercise the receipt fence independently of the document fence");
  await assert.rejects(() => sourceInventoryScanPage(env, { after: page.scan.through, snapshot: page.snapshot }),
    { code: "source_inventory_changed" });
  assert.equal(limits.length, 2, "changed receipt refused before another document scan");
  db.close();
});
