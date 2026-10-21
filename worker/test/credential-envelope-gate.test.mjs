import assert from "node:assert/strict";

import worker from "../src/index.js";

const secret = `sk-proj-${"A7".repeat(16)}`;
const env = { STORAGE: "d1", ADMIN_KEY: "fixture-admin" };
const context = { waitUntil() {}, passThroughOnException() {} };

function acceptingEnv() {
  const documents = new Map();
  const writes = [];
  const execute = (sql, bound) => {
    let changes = 0;
    if (/INSERT INTO documents/.test(sql)) {
      const prior = documents.get(bound[0]) || {};
      documents.set(bound[0], {
        ...prior,
        doc_uid: bound[0], source: bound[1], source_id: bound[2], title: bound[3],
        uri: bound[4], document_date: bound[5], date_source: bound[6], date_reliable: bound[7],
        client: bound[8], category: bound[9], top_folder: bound[10], platform: bound[11],
        ingested_at: bound[12], content_hash: bound[13], meta: bound[14],
        text_source: bound[21], text_reliable: bound[22], entity_slug: bound[23],
        provenance_receipt_version: bound[25], provenance_receipt_status: bound[26],
        provenance_receipt_reason: bound[27], provenance_receipt_digest: bound[28],
        document_revision_id: bound[29], source_original_binding_hash: bound[30], deleted_at: null,
      });
      writes.push(String(bound[2]));
      changes = 1;
    } else if (/INSERT INTO chunks|INSERT INTO vector_outbox/.test(sql)) {
      changes = 1;
    } else if (/UPDATE documents SET content_hash/.test(sql)) {
      const row = documents.get(bound[0]);
      if (row && row.content_hash === bound[2]) {
        row.content_hash = bound[1];
        changes = 1;
      }
    } else if (/INSERT INTO corpus_stats/.test(sql)) {
      changes = 1;
    }
    const results = /UPDATE documents SET content_hash/.test(sql) && changes
      ? [{ ...documents.get(bound[0]) }]
      : /INSERT INTO corpus_stats/.test(sql) && changes ? [{ source: bound[0] }] : [];
    return { changes, results };
  };
  const makeStatement = (sql) => {
    let bound = [];
    return {
      sql,
      get binds() { return bound; },
      bind(...values) { bound = values; return this; },
      async all() {
        if (/SELECT doc_uid,source,content_hash/.test(sql)) {
          return { results: bound.map((docUid) => documents.get(docUid)).filter(Boolean) };
        }
        const result = execute(sql, bound);
        return { results: result.results };
      },
      async first() {
        if (/SELECT content_hash, title|SELECT client, category|SELECT doc_uid,source,content_hash/.test(sql)) {
          return documents.get(bound[0]) || null;
        }
        return null;
      },
      async run() {
        const result = execute(sql, bound);
        return { success: true, meta: { changes: result.changes } };
      },
    };
  };
  return {
    writes,
    env: {
      STORAGE: "d1", ADMIN_KEY: "fixture-admin",
      VECTORIZE: { query: async () => ({ matches: [] }), upsert: async () => {} },
      AI: { run: async () => ({ data: [[0.1]] }) },
      DB: {
        prepare: makeStatement,
        batch: async (statements) => statements.map((statement) => {
          const result = execute(statement.sql, statement.binds);
          return { success: true, results: result.results, meta: { changes: result.changes } };
        }),
      },
    },
  };
}

const post = (path, body) => worker.fetch(new Request(`https://brain.invalid${path}`, {
  method: "POST",
  headers: { "X-Admin-Key": "fixture-admin", "content-type": "application/json" },
  body: JSON.stringify(body),
}), env, context);

for (const [name, envelope] of [
  ["title", {
    source_type: "note",
    source_id: "title-only",
    title: `Credentials ${secret}`,
    content: "ordinary prose",
  }],
  ["path metadata", {
    source_type: "note",
    source_id: "path-only",
    content: "ordinary prose",
    metadata: { folder: `Imports/${secret}/Notes` },
  }],
]) {
  const response = await post("/api/admin/brain/ingest", envelope);
  const text = await response.text();
  assert.equal(response.status, 422, `single ingest must refuse a credential in ${name}`);
  assert.doesNotMatch(text, new RegExp(secret), `single-ingest refusal must not echo ${name}`);
}

const batchResponse = await post("/api/admin/brain/ingest/batch", {
  docs: [{
    source_type: "note",
    source_id: "batch-path-only",
    content: "ordinary prose",
    metadata: { folder: `Imports/${secret}/Notes` },
  }],
});
const batchText = await batchResponse.text();
assert.equal(batchResponse.status, 200);
assert.doesNotMatch(batchText, new RegExp(secret), "batch refusal must not echo path metadata");
const batch = JSON.parse(batchText);
assert.equal(batch.refused, 1);
assert.equal(batch.created, 0);
assert.equal(batch.results[0]?.status, "refused");
assert.ok(batch.results[0]?.labels?.includes("openai_api_key"));

const meetingPasscode = "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6";
const meetingLink = `https://meet.example.test/j/123456789?pwd=${meetingPasscode}.1`;
const meetingEnv = acceptingEnv();
const meetingResponse = await worker.fetch(new Request("https://brain.invalid/api/admin/brain/ingest", {
  method: "POST",
  headers: { "X-Admin-Key": "fixture-admin", "content-type": "application/json" },
  body: JSON.stringify({
    source_type: "meeting", source_id: "dotted-passcode", title: "Meeting fixture",
    content: `Join the meeting: ${meetingLink}`,
  }),
}), meetingEnv.env, context);
const meetingText = await meetingResponse.text();
assert.equal(meetingResponse.status, 422, "Worker ingest refuses a dotted meeting passcode");
assert.doesNotMatch(meetingText, new RegExp(meetingPasscode), "the Worker refusal does not echo the passcode");
assert.ok(JSON.parse(meetingText).labels?.includes("url_query_secret"));
assert.deepEqual(meetingEnv.writes, [], "the refusal reached no document write");

const cleanEnv = acceptingEnv();
const cleanResponse = await worker.fetch(new Request("https://brain.invalid/api/admin/brain/ingest", {
  method: "POST",
  headers: { "X-Admin-Key": "fixture-admin", "content-type": "application/json" },
  body: JSON.stringify({
    source_type: "meeting", source_id: "token-free", title: "Meeting fixture",
    content: "Join the meeting: https://meet.example.test/j/123456789",
  }),
}), cleanEnv.env, context);
assert.equal(cleanResponse.status, 200, await cleanResponse.text());
assert.deepEqual(cleanEnv.writes, ["token-free"], "a token-free meeting link reaches the document write");

console.log("credential envelope gate: focused Worker route tests passed");
