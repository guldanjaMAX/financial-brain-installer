import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import worker from "../src/index.js";
import { diagnose, forget } from "../src/lib/store-d1.js";
import { renderLesson, validateLesson } from "../src/lib/remember-contract.js";
import {
  OWNER_NOTES_KIND, OWNER_NOTES_ROUTE, OWNER_NOTES_SOURCE,
} from "../src/lib/owner-note-contract.js";
import { createProductFixture } from "./product-contract-fixture.mjs";

const ORIGIN = "https://brain.invalid";
const ownerHeaders = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });

async function ownerEnvelope(input = {}) {
  const checked = await validateLesson({
    title: "The owner prefers violet lantern recaps",
    body: "The owner directly asked for a concise violet lantern recap every Friday afternoon.",
    confidence: "verified",
    verification: "stated directly by the owner in this conversation",
    ...input,
  }, {
    source_type: OWNER_NOTES_SOURCE,
    written_by: "owner_assistant",
    agent_profile: "owner-assistant",
    recorded_via: "local_mcp",
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  const value = checked.value;
  return {
    source_type: OWNER_NOTES_SOURCE,
    source_id: value.source_id,
    title: value.title,
    content: renderLesson(value),
    metadata: {
      category: "lesson",
      written_by: "owner_assistant",
      agent_profile: "owner-assistant",
      recorded_via: "local_mcp",
      confidence: value.confidence,
      verification: value.verification,
    },
  };
}

async function mcp(fixture, token, name, args) {
  const response = await fixture.post("/mcp", {
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name, arguments: args },
  }, { Authorization: `Bearer ${token}` });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result;
}

test("fresh owner notes are registered, attributable, reversible recollections across both MCP paths", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  const localEnvelope = await ownerEnvelope();
  const localResponse = await fixture.post(
    OWNER_NOTES_ROUTE, localEnvelope, ownerHeaders(fixture),
  );
  const local = await localResponse.json();
  assert.equal(localResponse.status, 200, JSON.stringify(local));
  assert.match(localResponse.headers.get("cache-control") || "", /no-store/i);
  assert.deepEqual({
    doc_uid: local.doc_uid,
    action: local.action,
    confirmed: local.confirmed,
    source: local.source.name,
    kind: local.source.kind,
    status: local.source.status,
    history: local.source.complete_history_through,
    zone: local.source.zone,
    provenance: local.provenance.label,
  }, {
    doc_uid: `${OWNER_NOTES_SOURCE}:${localEnvelope.source_id}`,
    action: "created",
    confirmed: true,
    source: OWNER_NOTES_SOURCE,
    kind: OWNER_NOTES_KIND,
    status: "ready",
    history: null,
    zone: null,
    provenance: "Owner assistant on this computer",
  });

  const storedLocal = fixture.first(
    "SELECT source,source_id,title,content_hash,meta FROM documents WHERE doc_uid=?",
    local.doc_uid,
  );
  assert.equal(storedLocal.source, OWNER_NOTES_SOURCE);
  assert.equal(storedLocal.source_id, localEnvelope.source_id);
  assert.equal(storedLocal.title, localEnvelope.title);
  assert.match(storedLocal.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(storedLocal.meta).recorded_via, "local_mcp");

  const token = "fixture-owner-notes-connector-token-123456789";
  fixture.raw(
    `INSERT INTO oauth_tokens
       (token_hash,client_id,scope,session_generation,created_at,expires_at)
     VALUES (?,'fixture-owner-notes','structured-contributor',1,?,?)`,
    createHash("sha256").update(token).digest("hex"), Date.now(), Date.now() + 60_000,
  );
  const remote = await mcp(fixture, token, "remember", {
    title: "The owner prefers amber compass summaries",
    body: "The owner directly asked for an amber compass summary after each monthly planning call.",
    confidence: "verified",
    verification: "stated directly by the owner in this conversation",
  });
  assert.equal(remote.isError, undefined, JSON.stringify(remote));
  assert.match(remote.content[0].text, /Source: owner-notes \(ready\); Approved remote Brain connector\./);

  const source = fixture.first(
    "SELECT name,kind,status,document_count,last_complete_sweep_at,zone FROM sources WHERE name=?",
    OWNER_NOTES_SOURCE,
  );
  assert.deepEqual({ ...source }, {
    name: OWNER_NOTES_SOURCE,
    kind: OWNER_NOTES_KIND,
    status: "ready",
    document_count: 2,
    last_complete_sweep_at: null,
    zone: null,
  });

  const search = await mcp(fixture, token, "search", { query: "amber compass" });
  const searchPayload = JSON.parse(search.content[0].text);
  const hit = searchPayload.results.find((result) => result.source === OWNER_NOTES_SOURCE);
  assert.ok(hit, JSON.stringify(searchPayload));
  assert.deepEqual(hit.write_provenance, {
    type: "conversational_owner_note",
    channel: "remote_mcp",
    actor: "connector",
    agent_profile: "structured-contributor",
    label: "Approved remote Brain connector",
  });
  const fetched = JSON.parse((await mcp(fixture, token, "fetch", { id: hit.id })).content[0].text);
  assert.deepEqual(fetched.metadata.write_provenance, hit.write_provenance);
  assert.equal(fetched.metadata.source_kind, OWNER_NOTES_KIND);

  const unifiedResponse = await fixture.post(
    "/api/rag/unified", { q: "violet lantern" }, ownerHeaders(fixture),
  );
  const unified = await unifiedResponse.json();
  const localHit = unified.results.find((result) => result.doc_uid === local.doc_uid);
  assert.ok(localHit, JSON.stringify(unified));
  assert.equal(localHit.authority.tier, "T4");
  assert.equal(localHit.authority.authoritative, false);
  assert.equal(localHit.write_provenance.label, "Owner assistant on this computer");

  const freshnessResponse = await worker.fetch(new Request(`${ORIGIN}/api/admin/brain/freshness`, {
    headers: ownerHeaders(fixture),
  }), fixture.env);
  const freshness = await freshnessResponse.json();
  const ownerNotes = freshness.sources.find((item) => item.name === OWNER_NOTES_SOURCE);
  assert.deepEqual({
    state: ownerNotes.state,
    status: ownerNotes.source_status,
    zone: ownerNotes.zone,
    automatable: ownerNotes.automatable,
    complete: ownerNotes.last_complete_sweep_at,
  }, { state: "manual", status: "ready", zone: null, automatable: false, complete: null });
  assert.equal(ownerNotes.coverage.history.state, "unknown");

  const inventoryResponse = await fixture.post(
    "/api/admin/brain/source-families", { source: OWNER_NOTES_SOURCE }, ownerHeaders(fixture),
  );
  const inventory = await inventoryResponse.json();
  assert.equal(inventory.families.length, 2);
  assert.ok(inventory.families.every((uid) => uid.startsWith(`${OWNER_NOTES_SOURCE}:lesson/`)));
  const preview = await forget(fixture.env, { source: OWNER_NOTES_SOURCE, dryRun: true });
  assert.equal(preview.documents, 2);

  const report = await diagnose(fixture.env);
  assert.equal(report.findings.some((finding) =>
    finding.id === "unregistered_source" && finding.title.includes(OWNER_NOTES_SOURCE)), false);

  const reserved = await fixture.post(
    "/api/admin/brain/ingest", localEnvelope, ownerHeaders(fixture),
  );
  assert.equal(reserved.status, 409);
  assert.equal((await reserved.json()).code, "owner_note_route_required");
  assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 2);
});

test("a failed owner-note store is visibly unconfirmed and an exact retry repairs its source", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const envelope = await ownerEnvelope({
    title: "A retryable owner note",
    body: "This owner note proves a failed storage attempt can be retried without inventing success.",
    confidence: "inferred",
    verification: undefined,
  });

  fixture.control.failOn = /SELECT content_hash, title, uri, document_date/;
  const failedResponse = await fixture.post(
    OWNER_NOTES_ROUTE, envelope, ownerHeaders(fixture),
  );
  const failed = await failedResponse.json();
  assert.equal(failedResponse.status, 500, JSON.stringify(failed));
  assert.equal(failed.confirmed, false);
  assert.equal(failed.may_have_written, true);
  assert.match(failed.error, /Retry the exact same note/i);
  assert.match(failedResponse.headers.get("cache-control") || "", /no-store/i);
  assert.equal(fixture.first("SELECT status FROM sources WHERE name=?", OWNER_NOTES_SOURCE).status, "error");
  assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 0);
  const broken = await diagnose(fixture.env);
  assert.ok(broken.findings.some((finding) =>
    finding.id === "empty_source" && finding.title.includes(OWNER_NOTES_SOURCE)));

  fixture.control.failOn = null;
  const retryResponse = await fixture.post(
    OWNER_NOTES_ROUTE, envelope, ownerHeaders(fixture),
  );
  const retry = await retryResponse.json();
  assert.equal(retryResponse.status, 200, JSON.stringify(retry));
  assert.equal(retry.confirmed, true);
  assert.equal(retry.action, "created");
  assert.equal(fixture.first("SELECT status FROM sources WHERE name=?", OWNER_NOTES_SOURCE).status, "ready");
  assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 1);
});

test("the credential scanner runs before an owner-notes source is registered", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const envelope = await ownerEnvelope({
    title: "Unsafe credential paste",
    body: `The owner asked to store this credential, which must be refused: sk-ant-api03-${"A".repeat(95)}`,
    confidence: "unverified",
    verification: undefined,
  });
  const response = await fixture.post(OWNER_NOTES_ROUTE, envelope, ownerHeaders(fixture));
  const body = await response.json();
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.match(body.error, /credential/i);
  assert.equal(fixture.first("SELECT count(*) AS n FROM sources").n, 0);
  assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 0);
});
