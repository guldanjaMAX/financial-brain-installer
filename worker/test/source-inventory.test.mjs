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

function migratedDb(label = "fixture") {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
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

async function addInventoryFixture(db, prefix = "") {
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
  db.prepare(
    `INSERT INTO sync_runs
       (run_id,source,lane,started_at,finished_at,walk_complete,files_seen,
        docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
        proposed_deletes,delete_action,refusal_reason,error,failure_evidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `${source("beta")}-run`, source("beta"), "incremental",
    Date.parse("2026-09-01T00:00:00.000Z"), Date.parse("2026-09-01T00:01:00.000Z"),
    0, 1, 0, 0, 0, 0, 1, 1, 0, null, null,
    "private provider failure for secret-account@example.invalid",
    JSON.stringify(SAFE_GMAIL_FAILURE),
  );
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

const post = (body = {}, headers = {}) => new Request(`${ORIGIN}/api/admin/brain/sources`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const call = (env, request) => worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });

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
