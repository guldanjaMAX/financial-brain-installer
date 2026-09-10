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
      evidence_lineage: {
        version: 1,
        kind: "agent_derived",
        root_ids: value.derived_from,
      },
    },
  };
}

async function ingestFixtureDocument(fixture, {
  source = "upload",
  sourceId,
  title,
  content,
  evidenceLineage,
}) {
  const response = await fixture.post("/api/admin/brain/ingest", {
    source_type: source,
    source_id: sourceId,
    title,
    content,
    metadata: {
      category: "synthetic-test",
      ...(evidenceLineage ? { evidence_lineage: evidenceLineage } : {}),
    },
  }, ownerHeaders(fixture));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.doc_uid;
}

function addRemoteContributor(fixture, token = "fixture-lineage-contributor-token-123456789") {
  fixture.raw(
    `INSERT INTO oauth_tokens
       (token_hash,client_id,scope,session_generation,created_at,expires_at)
     VALUES (?,'fixture-lineage-contributor','structured-contributor',1,?,?)`,
    createHash("sha256").update(token).digest("hex"), Date.now(), Date.now() + 60_000,
  );
  return token;
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

test("local and remote owner notes inherit one private durable root across a derived chain", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  const ledgerUid = await ingestFixtureDocument(fixture, {
    source: "ledger-records",
    sourceId: "stable-ledger-entry",
    title: "Synthetic durable ledger source",
    content: "A durable synthetic ledger source records a fixed amount for the fixture.",
    evidenceLineage: { version: 1, kind: "source_record", root_ids: [] },
  });

  const noteA = await ownerEnvelope({
    title: "Constellation lineage note A",
    body: "Constellation lineage note A summarizes the durable synthetic ledger source for later review.",
    confidence: "verified",
    verification: "checked against the synthetic ledger record",
    derived_from: [ledgerUid],
  });
  const localResponse = await fixture.post(
    OWNER_NOTES_ROUTE, noteA, ownerHeaders(fixture),
  );
  const localReceipt = await localResponse.json();
  assert.equal(localResponse.status, 200, JSON.stringify(localReceipt));
  assert.equal(JSON.stringify(localReceipt).includes(ledgerUid), false,
    "the local write receipt must not expose private root ids");
  const noteAUid = localReceipt.doc_uid;

  const token = addRemoteContributor(fixture);
  const remoteReceipt = await mcp(fixture, token, "remember", {
    title: "Constellation lineage note B",
    body: "Constellation lineage note B restates note A without becoming another independent source family.",
    confidence: "verified",
    verification: "checked against note A returned by Brain search",
    derived_from: [noteAUid],
  });
  assert.equal(remoteReceipt.isError, undefined, JSON.stringify(remoteReceipt));
  assert.equal(JSON.stringify(remoteReceipt).includes(ledgerUid), false,
    "the remote MCP write receipt must not expose private root ids");

  const noteB = fixture.first(
    "SELECT doc_uid,meta FROM documents WHERE source=? AND title=?",
    OWNER_NOTES_SOURCE, "Constellation lineage note B",
  );
  assert.ok(noteB);
  const rootsA = JSON.parse(fixture.first(
    "SELECT meta FROM documents WHERE doc_uid=?", noteAUid,
  ).meta).evidence_lineage.root_ids;
  const rootsB = JSON.parse(noteB.meta).evidence_lineage.root_ids;
  assert.deepEqual(rootsA, [ledgerUid]);
  assert.deepEqual(rootsB, [ledgerUid], "B must inherit A's ultimate durable ledger root");

  const search = await mcp(fixture, token, "search", { query: "constellation lineage note" });
  const publicSearch = JSON.parse(search.content[0].text);
  const notes = publicSearch.results.filter((result) =>
    result.source === OWNER_NOTES_SOURCE && /Constellation lineage note [AB]/.test(result.title));
  assert.equal(notes.length, 2, JSON.stringify(publicSearch));
  assert.equal(notes[0].lineage.status, "known");
  assert.deepEqual(notes[0].lineage.family_tokens, notes[1].lineage.family_tokens,
    "A and B must be shown as one opaque corroboration family");
  assert.equal(JSON.stringify(publicSearch).includes(ledgerUid), false,
    "search may expose an opaque family token, never the durable root id");

  const fetched = await mcp(fixture, token, "fetch", { id: noteB.doc_uid });
  assert.equal(fetched.isError, undefined, JSON.stringify(fetched));
  assert.equal(fetched.content[0].text.includes(ledgerUid), false,
    "fetch must not expose the durable root id");
});

test("a recorded durable family root is inherited without requiring a matching document row", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  const externalFamily = "external-family:abc";
  const derivedUid = await ingestFixtureDocument(fixture, {
    source: "derived-records",
    sourceId: "external-family-summary",
    title: "Synthetic externally rooted summary",
    content: "This synthetic summary records a durable source family managed outside the document table.",
    evidenceLineage: { version: 1, kind: "derived_record", root_ids: [externalFamily] },
  });
  assert.equal(fixture.first(
    "SELECT count(*) AS n FROM documents WHERE doc_uid=?", externalFamily,
  ).n, 0, "the durable family id is intentionally not a document uid");

  const envelope = await ownerEnvelope({
    title: "External family recollection",
    body: "This agent recollection is derived from a synthetic summary with an external durable family.",
    confidence: "verified",
    verification: "checked against the synthetic summary returned by Brain search",
    derived_from: [derivedUid],
  });
  const response = await fixture.post(OWNER_NOTES_ROUTE, envelope, ownerHeaders(fixture));
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(JSON.stringify(receipt).includes(externalFamily), false,
    "the write receipt must not expose the terminal durable family id");
  const stored = JSON.parse(fixture.first(
    "SELECT meta FROM documents WHERE doc_uid=?", receipt.doc_uid,
  ).meta);
  assert.deepEqual(stored.evidence_lineage.root_ids, [externalFamily]);
});

test("missing, deleted, and out-of-scope derived_from references refuse before any write", async (t) => {
  await t.test("missing", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const envelope = await ownerEnvelope({ derived_from: ["upload:not-present"] });
    const response = await fixture.post(OWNER_NOTES_ROUTE, envelope, ownerHeaders(fixture));
    const body = await response.json();
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.code, "owner_note_lineage_reference_unavailable");
    assert.equal(fixture.first("SELECT count(*) AS n FROM sources").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM source_events").n, 0);
  });

  await t.test("deleted", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const deletedUid = await ingestFixtureDocument(fixture, {
      sourceId: "deleted-source",
      title: "Synthetic deleted source",
      content: "This synthetic source is long enough to be indexed before deletion.",
      evidenceLineage: { version: 1, kind: "source_record", root_ids: [] },
    });
    fixture.raw("UPDATE documents SET deleted_at=? WHERE doc_uid=?", Date.now(), deletedUid);
    const before = fixture.first("SELECT count(*) AS n FROM documents").n;
    const envelope = await ownerEnvelope({ derived_from: [deletedUid] });
    const response = await fixture.post(OWNER_NOTES_ROUTE, envelope, ownerHeaders(fixture));
    const body = await response.json();
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.code, "owner_note_lineage_reference_unavailable");
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, before);
    assert.equal(fixture.first("SELECT count(*) AS n FROM sources WHERE name=?", OWNER_NOTES_SOURCE).n, 0);
    assert.equal(JSON.stringify(body).includes(deletedUid), false);
  });

  await t.test("out of scope", async (t) => {
    const fixture = await createProductFixture();
    t.after(() => fixture.close());
    const now = new Date().toISOString();
    fixture.raw(
      "INSERT INTO sources (name,kind,status,created_at,zone) VALUES (?,?,?,?,?)",
      OWNER_NOTES_SOURCE, OWNER_NOTES_KIND, "pending", now, "books",
    );
    fixture.raw(
      "INSERT INTO sources (name,kind,status,created_at,zone) VALUES (?,?,?,?,?)",
      "private-medical", "upload", "ready", now, "medical",
    );
    const privateUid = await ingestFixtureDocument(fixture, {
      source: "private-medical",
      sourceId: "private-record",
      title: "Synthetic private record",
      content: "This is synthetic private evidence that the books-scoped caller cannot read.",
      evidenceLineage: { version: 1, kind: "source_record", root_ids: [] },
    });
    const token = "fixture-books-admin-token";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    fixture.raw(
      `INSERT INTO grants
         (grant_id,display_name,capabilities,created_at,created_by,scope_include,scope_exclude)
       VALUES ('fixture-books-admin','Fixture books admin','["administer"]',?,'owner','{"zones":["books"]}','[]')`,
      Date.now(),
    );
    fixture.raw(
      "INSERT INTO grant_credentials (token_hash,grant_id,created_at) VALUES (?,?,?)",
      tokenHash, "fixture-books-admin", Date.now(),
    );

    const envelope = await ownerEnvelope({ derived_from: [privateUid] });
    const before = {
      documents: fixture.first("SELECT count(*) AS n FROM documents").n,
      chunks: fixture.first("SELECT count(*) AS n FROM chunks").n,
      outbox: fixture.first("SELECT count(*) AS n FROM vector_outbox").n,
      events: fixture.first("SELECT count(*) AS n FROM source_events").n,
      sourceStatus: fixture.first("SELECT status FROM sources WHERE name=?", OWNER_NOTES_SOURCE).status,
    };
    const response = await fixture.post(
      OWNER_NOTES_ROUTE, envelope, { "X-Admin-Key": token },
    );
    const body = await response.json();
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.code, "owner_note_lineage_reference_unavailable");
    assert.equal(JSON.stringify(body).includes(privateUid), false,
      "the refusal must not disclose which private id exists");
    assert.deepEqual({
      documents: fixture.first("SELECT count(*) AS n FROM documents").n,
      chunks: fixture.first("SELECT count(*) AS n FROM chunks").n,
      outbox: fixture.first("SELECT count(*) AS n FROM vector_outbox").n,
      events: fixture.first("SELECT count(*) AS n FROM source_events").n,
      sourceStatus: fixture.first("SELECT status FROM sources WHERE name=?", OWNER_NOTES_SOURCE).status,
    }, before, "authorization failure must leave every owner-note write surface unchanged");
  });
});

test("cyclic and oversized owner-note lineage is rejected before source registration", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  const cycleSourceUid = "derived-records:cycle-source";
  const cycle = await ownerEnvelope({ derived_from: [cycleSourceUid] });
  const successorUid = `${OWNER_NOTES_SOURCE}:${cycle.source_id}`;
  const storedCycleSource = await ingestFixtureDocument(fixture, {
    source: "derived-records",
    sourceId: "cycle-source",
    title: "Synthetic cycle source",
    content: "This synthetic derived record points back to the exact owner note that cites it.",
    evidenceLineage: { version: 1, kind: "derived_record", root_ids: [successorUid] },
  });
  assert.equal(storedCycleSource, cycleSourceUid);
  const cycleResponse = await fixture.post(OWNER_NOTES_ROUTE, cycle, ownerHeaders(fixture));
  const cycleBody = await cycleResponse.json();
  assert.equal(cycleResponse.status, 409, JSON.stringify(cycleBody));
  assert.equal(cycleBody.code, "owner_note_lineage_cycle");
  assert.equal(fixture.first("SELECT count(*) AS n FROM sources WHERE name=?", OWNER_NOTES_SOURCE).n, 0);

  const firstRootSetUid = await ingestFixtureDocument(fixture, {
    source: "derived-records",
    sourceId: "sixteen-root-summary",
    title: "Synthetic sixteen-root summary",
    content: "This synthetic derived record has the largest accepted durable family set.",
    evidenceLineage: {
      version: 1,
      kind: "derived_record",
      root_ids: Array.from(
        { length: 16 }, (_, index) => `external-family:synthetic-${index + 1}`,
      ),
    },
  });
  const seventeenthRootUid = await ingestFixtureDocument(fixture, {
    source: "derived-records",
    sourceId: "seventeenth-root-summary",
    title: "Synthetic seventeenth-root summary",
    content: "This synthetic derived record adds one distinct durable family to the set.",
    evidenceLineage: {
      version: 1,
      kind: "derived_record",
      root_ids: ["external-family:synthetic-17"],
    },
  });
  const oversized = await ownerEnvelope({
    derived_from: [firstRootSetUid, seventeenthRootUid],
  });
  const oversizedResponse = await fixture.post(
    OWNER_NOTES_ROUTE, oversized, ownerHeaders(fixture),
  );
  const oversizedBody = await oversizedResponse.json();
  assert.equal(oversizedResponse.status, 413, JSON.stringify(oversizedBody));
  assert.equal(oversizedBody.code, "owner_note_lineage_too_large");
  assert.equal(fixture.first("SELECT count(*) AS n FROM sources WHERE name=?", OWNER_NOTES_SOURCE).n, 0);
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
