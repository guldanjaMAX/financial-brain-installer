import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  finalizeMemorySupersession, prepareMemorySupersession,
} from "../src/lib/memory-supersession.js";
import { OWNER_NOTES_ROUTE, OWNER_NOTES_SOURCE } from "../src/lib/owner-note-contract.js";
import { renderLesson, validateLesson } from "../src/lib/remember-contract.js";
import { expectedD1ContentHash, storeFor } from "../src/lib/store.js";
import { createProductFixture } from "./product-contract-fixture.mjs";

const ownerHeaders = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });
const LOCAL_IDENTITY = Object.freeze({
  source_type: OWNER_NOTES_SOURCE,
  written_by: "owner_assistant",
  agent_profile: "owner-assistant",
  recorded_via: "local_mcp",
});

async function ownerEnvelope(input) {
  const checked = await validateLesson(input, LOCAL_IDENTITY);
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
      ...(value.verification ? { verification: value.verification } : {}),
      ...(value.supersedes ? { supersedes: value.supersedes } : {}),
    },
  };
}

async function writeOwnerNote(fixture, envelope) {
  const response = await fixture.post(OWNER_NOTES_ROUTE, envelope, ownerHeaders(fixture));
  return { response, body: await response.json() };
}

async function unified(fixture, q) {
  const response = await fixture.post("/api/rag/unified", { q }, ownerHeaders(fixture));
  assert.equal(response.status, 200);
  return response.json();
}

async function think(fixture, q) {
  const response = await fixture.post("/api/rag/think", { q }, ownerHeaders(fixture));
  assert.equal(response.status, 200);
  return response.json();
}

async function connectorToken(fixture, suffix = "one") {
  const token = `fixture-memory-correction-token-${suffix}-123456789`;
  fixture.raw(
    `INSERT INTO oauth_tokens
       (token_hash,client_id,scope,session_generation,created_at,expires_at)
     VALUES (?,?,?,?,?,?)`,
    createHash("sha256").update(token).digest("hex"),
    `fixture-memory-${suffix}`,
    "structured-contributor",
    1,
    Date.now(),
    Date.now() + 60_000,
  );
  return token;
}

async function mcp(fixture, token, name, args) {
  const response = await fixture.post("/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args },
  }, { Authorization: `Bearer ${token}` });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

test("a verified correction becomes current, preserves fetchable history, chains, retries, and rejects stale targets", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  const oldEnvelope = await ownerEnvelope({
    title: "The owner's recap marker is cobalt",
    body: "The old recap instruction used the unique cobaltwrongmarker token and should later become history.",
    confidence: "verified",
    verification: "stated directly by the owner in this conversation",
  });
  const oldWrite = await writeOwnerNote(fixture, oldEnvelope);
  assert.equal(oldWrite.response.status, 200, JSON.stringify(oldWrite.body));
  const oldId = oldWrite.body.doc_uid;
  assert.ok((await unified(fixture, "cobaltwrongmarker")).results.some((row) => row.doc_uid === oldId));

  const correctionEnvelope = await ownerEnvelope({
    title: "The owner's recap marker is emerald",
    body: "The current recap instruction uses the unique emeraldcurrentmarker token, replacing the prior memory.",
    confidence: "verified",
    verification: "the owner corrected it directly in this conversation",
    supersedes: oldId,
  });
  const correction = await writeOwnerNote(fixture, correctionEnvelope);
  assert.equal(correction.response.status, 200, JSON.stringify(correction.body));
  const correctionId = correction.body.doc_uid;
  assert.deepEqual(correction.body.correction, {
    predecessor_doc_uid: oldId,
    successor_doc_uid: correctionId,
    status: "current",
    history_preserved: true,
    action: "linked",
  });
  assert.equal((await unified(fixture, "cobaltwrongmarker")).results.some((row) => row.doc_uid === oldId), false);
  assert.ok((await unified(fixture, "emeraldcurrentmarker")).results.some((row) => row.doc_uid === correctionId));
  const historicalAnswer = await think(fixture, "cobaltwrongmarker");
  assert.equal(historicalAnswer.results.some((row) => row.doc_uid === oldId), false);
  assert.equal(historicalAnswer.answer, null);
  const currentAnswer = await think(fixture, "emeraldcurrentmarker");
  assert.ok(currentAnswer.results.some((row) => row.doc_uid === correctionId));

  const token = await connectorToken(fixture);
  const oldFetch = JSON.parse((await mcp(fixture, token, "fetch", { id: oldId })).content[0].text);
  assert.deepEqual(oldFetch.metadata.memory_history, {
    status: "superseded",
    current: false,
    visible_in_search: false,
    superseded_by: correctionId,
    changed_at: oldFetch.metadata.memory_history.changed_at,
  });
  assert.match(oldFetch.text, /cobaltwrongmarker/);
  const currentFetch = JSON.parse((await mcp(fixture, token, "fetch", { id: correctionId })).content[0].text);
  assert.equal(currentFetch.metadata.memory_history.status, "current_correction");
  assert.equal(currentFetch.metadata.memory_history.corrects, oldId);

  const retry = await writeOwnerNote(fixture, correctionEnvelope);
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.action, "unchanged");
  assert.equal(retry.body.correction.action, "unchanged");
  assert.equal(fixture.first("SELECT count(*) AS n FROM memory_supersessions").n, 1);

  const beforeStale = fixture.first("SELECT count(*) AS n FROM documents").n;
  const staleEnvelope = await ownerEnvelope({
    title: "A different attempted correction of the stale cobalt memory",
    body: "This different correction uses stalecorrectionmarker and must be refused before it is stored anywhere.",
    confidence: "verified",
    verification: "synthetic stale-target regression",
    supersedes: oldId,
  });
  const stale = await writeOwnerNote(fixture, staleEnvelope);
  assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "memory_supersession_target_stale");
  assert.match(stale.body.error, /Search again/i);
  assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, beforeStale);

  const chainedEnvelope = await ownerEnvelope({
    title: "The owner's recap marker is topaz",
    body: "The newest recap instruction uses the unique topazcurrentmarker token and replaces emerald.",
    confidence: "verified",
    verification: "the owner corrected the current memory directly",
    supersedes: correctionId,
  });
  const chained = await writeOwnerNote(fixture, chainedEnvelope);
  assert.equal(chained.response.status, 200, JSON.stringify(chained.body));
  assert.equal((await unified(fixture, "emeraldcurrentmarker")).results.some((row) => row.doc_uid === correctionId), false);
  assert.ok((await unified(fixture, "topazcurrentmarker")).results.some((row) => row.doc_uid === chained.body.doc_uid));
  const middleFetch = JSON.parse((await mcp(fixture, token, "fetch", { id: correctionId })).content[0].text);
  assert.equal(middleFetch.metadata.memory_history.status, "superseded");
  assert.equal(middleFetch.metadata.memory_history.corrects, oldId);
  assert.equal(middleFetch.metadata.memory_history.superseded_by, chained.body.doc_uid);

  const retryAfterChain = await writeOwnerNote(fixture, correctionEnvelope);
  assert.equal(retryAfterChain.response.status, 409, JSON.stringify(retryAfterChain.body));
  assert.equal(retryAfterChain.body.code, "memory_supersession_target_stale");
  assert.match(retryAfterChain.body.error, /current memory/i);
  assert.doesNotMatch(retryAfterChain.body.error, /is current|status.?current/i);
  assert.equal(fixture.first("SELECT count(*) AS n FROM memory_supersessions").n, 2);
});

test("unsafe, missing, cross-category, and ambiguous targets are refused before an owner-note document is written", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  const seed = async (source_type, source_id, category, metadata = {}) => {
    const response = await fixture.post("/api/admin/brain/ingest", {
      source_type, source_id, category,
      title: `${source_type} target`,
      content: `Synthetic ${source_type} record with enough text for the correction safety regression.`,
      metadata: { category, ...metadata },
    }, ownerHeaders(fixture));
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    return `${source_type}:${source_id}`;
  };
  const drive = await seed("drive", "lesson/drive-target", "lesson", { written_by: "connector" });
  const gmail = await seed("gmail", "lesson/gmail-target", "lesson", { written_by: "connector" });
  const ownerConfirmed = await seed("curated", "lesson/owner-confirmed", "lesson", {
    written_by: "owner", owner_confirmed: true,
  });
  const crossCategory = await seed("curated", "lesson/decision", "decision", { written_by: "connector" });

  const attempt = async (target, marker) => writeOwnerNote(fixture, await ownerEnvelope({
    title: `Attempted correction ${marker}`,
    body: `This attempted correction carries ${marker} and must not suppress an unsafe Brain record.`,
    confidence: "verified",
    verification: "synthetic correction-boundary regression",
    supersedes: target,
  }));
  for (const target of [drive, gmail, ownerConfirmed]) {
    const before = fixture.first("SELECT count(*) AS n FROM documents").n;
    const refused = await attempt(target, `unsafe${before}`);
    assert.equal(refused.response.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.code, /unsafe|cross_category/);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, before);
    assert.equal(fixture.first("SELECT count(*) AS n FROM memory_supersessions").n, 0);
  }
  const crossed = await attempt(crossCategory, "crosscategorymarker");
  assert.equal(crossed.response.status, 409, JSON.stringify(crossed.body));
  assert.equal(crossed.body.code, "memory_supersession_cross_category");
  const missing = await attempt("owner-notes:lesson/not-present", "missingmarker");
  assert.equal(missing.response.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "memory_supersession_target_not_found");

  const ordinary = await ownerEnvelope({
    title: "An ambiguity fixture",
    body: "This live owner memory has the unique ambiguityfixturemarker needed for the short-id test.",
    confidence: "inferred",
  });
  const ordinaryWrite = await writeOwnerNote(fixture, ordinary);
  assert.equal(ordinaryWrite.response.status, 200, JSON.stringify(ordinaryWrite.body));
  await seed("curated", ordinary.source_id, "lesson", { written_by: "connector" });
  const beforeAmbiguous = fixture.first("SELECT count(*) AS n FROM documents").n;
  const ambiguous = await attempt(ordinary.source_id, "ambiguoustargetmarker");
  assert.equal(ambiguous.response.status, 409, JSON.stringify(ambiguous.body));
  assert.equal(ambiguous.body.code, "memory_supersession_target_ambiguous");
  assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, beforeAmbiguous);
});

test("an unambiguous legacy remote-MCP lesson can be corrected without trusting arbitrary curated data", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const legacyId = "curated:lesson/legacy-remote-note";
  const legacy = await fixture.post("/api/admin/brain/ingest", {
    source_type: "curated",
    source_id: "lesson/legacy-remote-note",
    title: "Legacy remote MCP memory",
    content: "The old legacy memory contains the unique legacywrongmarker token and is known to be wrong.",
    category: "lesson",
    metadata: { category: "lesson", written_by: "connector", confidence: "verified" },
  }, ownerHeaders(fixture));
  assert.equal(legacy.status, 200, JSON.stringify(await legacy.json()));

  const correctedEnvelope = await ownerEnvelope({
    title: "Corrected legacy remote MCP memory",
    body: "The corrected memory contains the unique legacycurrentmarker token and replaces the old connector note.",
    confidence: "verified",
    verification: "the owner corrected this legacy connector memory directly",
    supersedes: legacyId,
  });
  const corrected = await writeOwnerNote(fixture, correctedEnvelope);
  assert.equal(corrected.response.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.correction.predecessor_doc_uid, legacyId);
  assert.equal((await unified(fixture, "legacywrongmarker")).results.some((row) => row.doc_uid === legacyId), false);
  assert.ok((await unified(fixture, "legacycurrentmarker")).results.some((row) => row.doc_uid === corrected.body.doc_uid));

  // The ledger is authority over the exact historical hash, not over a source
  // identity forever. If an owner-controlled source later writes a new,
  // owner-confirmed revision at that id, the conversational correction must
  // not suppress the new primary record.
  const primaryRevision = await fixture.post("/api/admin/brain/ingest", {
    source_type: "curated",
    source_id: "lesson/legacy-remote-note",
    title: "Owner-confirmed replacement at the legacy identity",
    content: "The source now contains legacyownerconfirmedmarker as an independently confirmed primary revision.",
    category: "lesson",
    metadata: { category: "lesson", written_by: "owner", owner_confirmed: true },
  }, ownerHeaders(fixture));
  assert.equal(primaryRevision.status, 200, JSON.stringify(await primaryRevision.json()));
  assert.ok((await unified(fixture, "legacyownerconfirmedmarker")).results.some((row) => row.doc_uid === legacyId));
  const token = await connectorToken(fixture, "legacy-primary");
  const fetched = JSON.parse((await mcp(fixture, token, "fetch", { id: legacyId })).content[0].text);
  assert.equal(Object.hasOwn(fetched.metadata, "memory_history"), false);
  assert.equal(fixture.first("SELECT count(*) AS n FROM memory_supersessions").n, 1);
});

test("the paused release Worker keeps schema 36 reads available before migration 0037", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const envelope = await ownerEnvelope({
    title: "Pre-migration compatibility memory",
    body: "This ordinary memory contains schemathirtysixreadmarker for the paused upgrade-window regression.",
    confidence: "inferred",
  });
  const written = await writeOwnerNote(fixture, envelope);
  assert.equal(written.response.status, 200, JSON.stringify(written.body));

  fixture.sqlite.exec("DROP TABLE memory_supersessions");
  fixture.raw("UPDATE install_state SET schema_version=36 WHERE id=1");

  assert.ok((await unified(fixture, "schemathirtysixreadmarker")).results.some((row) =>
    row.doc_uid === written.body.doc_uid));
  const token = await connectorToken(fixture, "schema-thirty-six");
  const fetched = JSON.parse((await mcp(fixture, token, "fetch", {
    id: written.body.doc_uid,
  })).content[0].text);
  assert.match(fetched.text, /schemathirtysixreadmarker/);
  assert.equal(Object.hasOwn(fetched.metadata, "memory_history"), false);
});

test("schema 37 fails the authenticated search route closed when its correction ledger is missing", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const envelope = await ownerEnvelope({
    title: "Schema 37 correction-ledger integrity fixture",
    body: "This ordinary memory contains schemathirtysevenintegritymarker and must never yield a clean absence.",
    confidence: "inferred",
  });
  const written = await writeOwnerNote(fixture, envelope);
  assert.equal(written.response.status, 200, JSON.stringify(written.body));

  fixture.sqlite.exec("DROP TABLE memory_supersessions");
  assert.equal(fixture.first("SELECT schema_version FROM install_state WHERE id=1").schema_version, 37);

  const response = await fixture.post(
    "/api/rag/unified",
    { q: "schemathirtysevenintegritymarker" },
    ownerHeaders(fixture),
  );
  const body = await response.json();
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(Object.hasOwn(body, "results"), false);
  assert.doesNotMatch(String(body.error || ""), /nothing recorded|no hits|documents do not answer/i);
});

test("a concurrent correction loser remains unconfirmed and invisible", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const old = await ownerEnvelope({
    title: "Concurrent correction target",
    body: "This memory contains concurrentoldmarker and exists only to exercise two simultaneous corrections.",
    confidence: "inferred",
  });
  const oldWrite = await writeOwnerNote(fixture, old);
  assert.equal(oldWrite.response.status, 200, JSON.stringify(oldWrite.body));

  const makeCandidate = (name, marker) => ownerEnvelope({
    title: `Concurrent candidate ${name}`,
    body: `This candidate contains ${marker} and competes to become the one current correction.`,
    confidence: "verified",
    verification: "synthetic concurrency regression",
    supersedes: oldWrite.body.doc_uid,
  });
  const winner = await makeCandidate("winner", "concurrentwinnermarker");
  const loser = await makeCandidate("loser", "concurrentlosermarker");
  const winnerHash = await expectedD1ContentHash(fixture.env, winner);
  const loserHash = await expectedD1ContentHash(fixture.env, loser);
  const winnerContext = await prepareMemorySupersession(fixture.env, {
    requestedTarget: oldWrite.body.doc_uid,
    successorDocUid: `${OWNER_NOTES_SOURCE}:${winner.source_id}`,
    successorContentHash: winnerHash,
    channel: "local_mcp",
  });
  const loserContext = await prepareMemorySupersession(fixture.env, {
    requestedTarget: oldWrite.body.doc_uid,
    successorDocUid: `${OWNER_NOTES_SOURCE}:${loser.source_id}`,
    successorContentHash: loserHash,
    channel: "local_mcp",
  });
  await storeFor(fixture.env).ingest(fixture.env, winner);
  await storeFor(fixture.env).ingest(fixture.env, loser);
  await finalizeMemorySupersession(fixture.env, winnerContext);
  await assert.rejects(
    finalizeMemorySupersession(fixture.env, loserContext),
    (error) => error?.code === "memory_supersession_commit_conflict",
  );

  assert.ok((await unified(fixture, "concurrentwinnermarker")).results.some((row) =>
    row.doc_uid === `${OWNER_NOTES_SOURCE}:${winner.source_id}`));
  assert.equal((await unified(fixture, "concurrentlosermarker")).results.length, 0);
  assert.equal((await unified(fixture, "concurrentoldmarker")).results.length, 0);
  const token = await connectorToken(fixture, "concurrent");
  const fetched = JSON.parse((await mcp(fixture, token, "fetch", {
    id: `${OWNER_NOTES_SOURCE}:${loser.source_id}`,
  })).content[0].text);
  assert.equal(fetched.metadata.memory_history.status, "unconfirmed_correction");
  assert.equal(fetched.metadata.memory_history.visible_in_search, false);
});

test("an untyped completion failure is private and an exact retry confirms the existing correction", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const old = await ownerEnvelope({
    title: "Completion failure target",
    body: "The initial memory carries completionfailureoldmarker and will be corrected in this regression.",
    confidence: "inferred",
  });
  const oldWrite = await writeOwnerNote(fixture, old);
  assert.equal(oldWrite.response.status, 200, JSON.stringify(oldWrite.body));
  const replacement = await ownerEnvelope({
    title: "Completion failure replacement",
    body: "The corrected memory carries completionfailurenewmarker and is safe to retry exactly.",
    confidence: "verified",
    verification: "synthetic post-ledger failure regression",
    supersedes: oldWrite.body.doc_uid,
  });

  fixture.control.failOn = /SELECT name,kind,status,last_ingest_at,last_complete_sweep_at/;
  const uncertain = await writeOwnerNote(fixture, replacement);
  assert.equal(uncertain.response.status, 500, JSON.stringify(uncertain.body));
  assert.match(uncertain.response.headers.get("cache-control") || "", /no-store/i);
  assert.deepEqual({
    code: uncertain.body.code,
    confirmed: uncertain.body.confirmed,
    may_have_written: uncertain.body.may_have_written,
  }, {
    code: "owner_note_completion_unconfirmed",
    confirmed: false,
    may_have_written: true,
  });
  assert.match(uncertain.body.error, /Retry the exact same note/i);
  assert.doesNotMatch(uncertain.body.error, /fixture database unavailable/i);
  assert.equal(fixture.first("SELECT count(*) AS n FROM memory_supersessions").n, 1);
  assert.equal(fixture.first("SELECT status FROM sources WHERE name=?", OWNER_NOTES_SOURCE).status, "error");

  fixture.control.failOn = null;
  const retry = await writeOwnerNote(fixture, replacement);
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.confirmed, true);
  assert.equal(retry.body.action, "unchanged");
  assert.equal(retry.body.correction.action, "unchanged");
  assert.equal(fixture.first("SELECT status FROM sources WHERE name=?", OWNER_NOTES_SOURCE).status, "ready");
});
