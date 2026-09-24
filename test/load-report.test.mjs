import assert from "node:assert/strict";
import { buildLoadQualityReport, renderLoadQualityReport } from "../ingest/load-report.mjs";
import { cmdLoadReport, readDiagnosis } from "../brain.mjs";
import { loadQualityAggregate } from "../worker/src/lib/store-d1.js";
import worker from "../worker/src/index.js";
import { DatabaseSync } from "node:sqlite";

{
  const sql = [];
  const aggregate = await loadQualityAggregate({ DB: { prepare(statement) {
    sql.push(statement);
    return { first: async () => ({
      duplicate_groups: 3,
      duplicate_extra_documents: 7,
      largest_document_chunks: 41,
      total_chunks: 120,
    }) };
  } } });
  assert.equal(sql.length, 1, "the aggregate contract issued more than one D1 statement");
  assert.match(sql[0], /INDEXED BY idx_documents_live_content_hash/);
  assert.match(sql[0], /INDEXED BY idx_chunks_doc/);
  assert.doesNotMatch(sql[0], /\b(?:title|uri|text)\b/i);
  assert.deepEqual(aggregate.duplicates, { observable: true, groups: 3, extra_documents: 7 });
  assert.deepEqual(aggregate.chunk_outliers, {
    observable: true, largest_document_chunks: 41, total_chunks: 120,
  });
}

{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE documents (doc_uid TEXT PRIMARY KEY, content_hash TEXT, deleted_at TEXT);
    CREATE INDEX idx_documents_live_content_hash ON documents(content_hash)
      WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash != '';
    CREATE TABLE chunks (chunk_uid TEXT PRIMARY KEY, doc_uid TEXT NOT NULL);
    CREATE INDEX idx_chunks_doc ON chunks(doc_uid);
    CREATE TABLE corpus_stats (source TEXT PRIMARY KEY, chunks INTEGER NOT NULL);
    INSERT INTO documents VALUES
      ('doc-1','same',NULL),('doc-2','same',NULL),('doc-3','same',NULL),
      ('doc-4','unique',NULL),('doc-5','same','2026-01-01');
    INSERT INTO chunks VALUES
      ('c1','doc-1'),('c2','doc-1'),('c3','doc-1'),('c4','doc-2');
    INSERT INTO corpus_stats VALUES ('upload',4);
  `);
  try {
    const aggregate = await loadQualityAggregate({ DB: { prepare(statement) {
      return { first: async () => db.prepare(statement).get() };
    } } });
    assert.deepEqual(aggregate.duplicates, { observable: true, groups: 1, extra_documents: 2 });
    assert.deepEqual(aggregate.chunk_outliers, {
      observable: true, largest_document_chunks: 3, total_chunks: 4,
    });
  } finally {
    db.close();
  }
}

{
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.map(String).join(" "));
  try {
    const result = await readDiagnosis("fixture.manifest.json", {
      diagnosis: {
        complete: false,
        verdict: "incomplete",
        unavailable_checks: ["chunks"],
        findings: [{ title: "PRIVATE_SENTINEL_TITLE", samples: ["PRIVATE_SENTINEL_SAMPLE"] }],
      },
      renderIncomplete: false,
      returnIncomplete: true,
    });
    assert.deepEqual(result, {
      kind: "diagnosis_incomplete",
      complete: false,
      reason: "one or more diagnostic checks could not run",
    });
    assert.doesNotMatch(output.join("\n"), /PRIVATE_SENTINEL/);
  } finally {
    console.log = originalLog;
  }
}

{
  const aggregate = await loadQualityAggregate({ DB: { prepare() {
    return { first: async () => { throw new Error("PRIVATE_SENTINEL_DATABASE_DETAIL"); } };
  } } });
  assert.equal(aggregate.complete, false);
  assert.deepEqual(aggregate.unavailable_categories, ["indexed_quality_aggregates"]);
  assert.doesNotMatch(JSON.stringify(aggregate), /PRIVATE_SENTINEL/);
}

{
  const statements = [];
  const response = await worker.fetch(new Request("https://fixture.invalid/api/admin/brain/load-quality", {
    method: "GET",
    headers: { "X-Admin-Key": "fixture-admin" },
  }), {
    STORAGE: "d1",
    ADMIN_KEY: "fixture-admin",
    DB: { prepare(statement) {
      statements.push(statement);
      return { first: async () => ({
        duplicate_groups: 1,
        duplicate_extra_documents: 2,
        largest_document_chunks: 9,
        total_chunks: 40,
      }) };
    } },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(body.kind, "load_quality_aggregate");
  assert.equal(body.duplicates.extra_documents, 2);
  assert.equal(statements.length, 1, "the HTTP aggregate route invoked a broader diagnostic path");
}

const report = buildLoadQualityReport({
  inventory: {
    complete: true,
    as_of: "2026-09-24T20:00:00.000Z",
    sources: [
      {
        name: "drive",
        receipt: {
          latest_run: {
            outcome: "completed",
            finished_at: "2026-09-24T20:00:00.000Z",
            walk_complete: true,
            metrics_version: 1,
            files_seen: 20,
            docs_added: 12,
            docs_updated: 2,
            docs_unchanged: 4,
            docs_refused: 1,
            docs_failed: 1,
          },
        },
      },
    ],
  },
  quality: {
    contract_version: 1,
    kind: "load_quality_aggregate",
    complete: true,
    duplicates: { observable: true, groups: 3, extra_documents: 7 },
    chunk_outliers: { observable: false, largest_document_chunks: null, total_chunks: 120 },
  },
  checkpointSkips: {
    drive: {
      "opaque-1": "the extraction is mostly symbols with too little readable text",
      "opaque-2": "file is 9.0MB, over the 8MB limit",
      "opaque-3": "failed: private-folder/private-file.txt could not be opened",
    },
  },
});

assert.equal(report.contract_version, 1);
assert.equal(report.sources[0].accepted, 18);
assert.equal(report.sources[0].refused, 1);
assert.equal(report.sources[0].failed, 1);
assert.equal(report.duplicates.extra_documents, 7);
assert.equal(report.too_large, 1);
assert.equal(report.refusal_reasons["mostly symbols with too little readable text"], 1);
assert.equal(report.refusal_reasons["ingest failed"], 1);
assert.equal(report.chunk_outliers.observable, false);

const active = buildLoadQualityReport({
  inventory: {
    complete: true,
    sources: [
      { name: "drive", receipt: { latest_run: {
        outcome: "in_progress", finished_at: null, walk_complete: false,
        metrics_version: 1, files_seen: null, docs_added: null, docs_updated: null,
        docs_unchanged: null, docs_refused: null, docs_failed: null,
      } } },
      { name: "upload", receipt: { latest_run: {
        outcome: "completed", finished_at: "2026-09-24T20:00:00.000Z", walk_complete: true,
        metrics_version: 1, files_seen: 2, docs_added: "", docs_updated: 1,
        docs_unchanged: 0, docs_refused: "", docs_failed: 0,
      } } },
    ],
  },
  quality: {
    contract_version: 1, kind: "load_quality_aggregate", complete: true,
    duplicates: { observable: true, groups: 0, extra_documents: 0 },
    chunk_outliers: { observable: true, largest_document_chunks: 0, total_chunks: 0 },
  },
});
assert.equal(active.sources[0].files_seen, null);
assert.equal(active.sources[0].accepted, null);
assert.equal(active.sources[0].refused, null);
assert.equal(active.sources[0].failed, null);
assert.equal(active.sources[1].accepted, null);
assert.equal(active.sources[1].refused, null);
assert.equal(active.complete, false, "an open walk reached the report-complete decision");

const rendered = renderLoadQualityReport(report);
assert.match(rendered, /AFTER-LOAD QUALITY REPORT/);
assert.match(rendered, /drive.*18 accepted.*1 refused.*1 failed/i);
assert.match(rendered, /7 duplicate document/i);
assert.match(rendered, /1 too large/i);
assert.doesNotMatch(rendered, /opaque-1|opaque-2/);
assert.doesNotMatch(rendered, /private-folder|private-file/);

const lines = [];
const originalLog = console.log;
console.log = (...args) => lines.push(args.map(String).join(" "));
try {
  const commandOptions = {
    inventory: {
      complete: true,
      as_of: "2026-09-24T20:00:00.000Z",
      sources: [{ name: "upload", receipt: { latest_run: {
        outcome: "completed", finished_at: "2026-09-24T20:00:00.000Z", walk_complete: true,
        metrics_version: 1, files_seen: 4,
        docs_added: 3, docs_updated: 0, docs_unchanged: 0, docs_refused: 1, docs_failed: 0,
      } } }],
    },
    aggregate: {
      contract_version: 1, kind: "load_quality_aggregate", complete: true,
      duplicates: { observable: true, groups: 0, extra_documents: 0 },
      chunk_outliers: { observable: true, largest_document_chunks: 3, total_chunks: 4 },
    },
    diagnosis: {
      complete: false,
      verdict: "incomplete",
      findings: [{ title: "PRIVATE_SENTINEL_TITLE", detail: "PRIVATE_SENTINEL_DETAIL", samples: ["PRIVATE_SENTINEL_SAMPLE"] }],
    },
    checkpointSkips: { upload: { "private-file-id": "file is 9.0MB, over the 8MB limit" } },
  };
  const commandReport = await cmdLoadReport("fixture.manifest.json", {
    ...commandOptions,
    flags: {},
  });
  assert.equal(commandReport.sources[0].accepted, 3);
  assert.match(lines.join("\n"), /AFTER-LOAD QUALITY REPORT/);
  assert.doesNotMatch(lines.join("\n"), /private-file-id/);
  assert.doesNotMatch(lines.join("\n"), /PRIVATE_SENTINEL/,
    "load-report rendered diagnosis samples on an aggregate path");
  lines.length = 0;
  await cmdLoadReport("fixture.manifest.json", { ...commandOptions, flags: { json: true } });
  assert.match(lines.join("\n"), /"kind": "after_load_quality_report"/);
  assert.doesNotMatch(lines.join("\n"), /PRIVATE_SENTINEL|private-file-id/,
    "JSON load-report emitted private diagnostic or checkpoint identities");
} finally {
  console.log = originalLog;
}

console.log("load-report: all 46 assertions passed");
