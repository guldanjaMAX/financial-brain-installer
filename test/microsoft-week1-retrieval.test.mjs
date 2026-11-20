// Settled D1-D4: add-only retention, mailbox-local time, counted skips, and work accounts only.
import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";
import { search } from "../worker/src/lib/store-d1.js";
import { readDocumentEvidence } from "../worker/src/lib/document-answer.js";
import { computeAnswerConfidence } from "../worker/src/lib/confidence.js";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import { runProviderConnector } from "../connectors/provider-runtime.mjs";
globalThis.fetch = async () => { throw new Error("UNSCRIPTED_NETWORK_BLOCKED"); };
const NOW = Date.parse("2026-11-17T12:00:00Z");
const G = "https://graph.microsoft.com/v1.0";
const active = { id: "review", subject: "Synthetic budget review", originalStartTimeZone: "Pacific Standard Time",
  bodyPreview: "Synthetic review of the approved invoice amount of 1200 dollars.",
  start: { dateTime: "2026-11-18T02:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-18T03:00:00", timeZone: "UTC" } };
async function setup(t, status) {
  const f = await createProductFixture(); t.after(f.close);
  const receipt = await f.post("/api/admin/brain/source-receipt", { source: "microsoft", kind: "microsoft",
    status: "indexing", run_id: "synthetic-status", started_at: new Date(NOW).toISOString() }, { "X-Admin-Key": f.env.ADMIN_KEY });
  assert.equal(receipt.status, 200);
  let graphCalls = 0; let writes = 0;
  for (const rows of [[active], status ? [{ id: "review", ...(status === "cancelled" ? { isCancelled: true } : { "@removed": { reason: "deleted" } }) }] : []]) {
    const r = await syncMicrosoftGraph({ accessToken: "synthetic-access", ownerTimeZone: "America/Los_Angeles",
      now: () => NOW, includePersonalDrive: false, mailFolderIds: [], fetchImpl: async () => {
        graphCalls++; return Response.json({ value: rows, "@odata.deltaLink": `${G}/terminal` });
      } });
    if (!r.documents.length) continue;
    const response = await f.post("/api/admin/brain/ingest/batch", { docs: r.documents }, { "X-Admin-Key": f.env.ADMIN_KEY });
    assert.equal(response.status, 200, "the real ingest route accepted synthetic evidence");
    const result = await response.json(); assert.equal(result.failed, 0); writes++;
  }
  assert.equal(graphCalls, 2); assert.equal(writes, status ? 2 : 1);
  return f;
}
for (const status of ["cancelled", "removed_from_view", null]) {
  test(`C6/F3: subject retrieval sees current retained status (${status || "active control"})`, async t => {
    const f = await setup(t, status);
    const result = await search(f.env, { query: "Synthetic budget review", embedding: null, now: NOW });
    const found = result.results.find(row => row.source_id === "outlook:event:review");
    assert.ok(found, "the retained event is still retrieved by its real subject");
    assert.match(found.text, /1200 dollars/);
    if (status) {
      assert.match(found.text, new RegExp(`Microsoft provider status: ${status}`));
      assert.match(found.text, /historical|not upcoming/i);
      const [read] = await readDocumentEvidence(f.env, [found]);
      assert.match(read.snippet, new RegExp(`Microsoft provider status: ${status}`), "full-document reading preserves provider status");
      const score = computeAnswerConfidence({ approvedDocs: [{ ...found, snippet: found.text, ts: "2026-11-17" }], claim: "The meeting is upcoming at 6 PM." });
      assert.ok(score.percent < 90, "an unqualified upcoming claim cannot use High after a provider status change");
    } else assert.doesNotMatch(found.text, /Microsoft provider status: (cancelled|removed_from_view)/);
    assert.ok(f.seen.sql.some(sql => /chunks_fts/.test(sql)), "the real keyword path ran");
  });
}

test("F3: unavailable status read keeps source text and a named confidence gap", async t => {
  const f = await setup(t, "cancelled");
  f.control.failOn = /microsoft-retained-status/;
  const result = await search(f.env, { query: "Synthetic budget review", embedding: null, now: NOW });
  const found = result.results.find(row => row.source_id === "outlook:event:review");
  assert.ok(found); assert.match(found.text, /1200 dollars/); assert.equal(found.microsoft_provider_status, "unavailable");
  assert.ok(f.seen.sql.some(sql => /microsoft-retained-status/.test(sql)), "the failed read decision was reached");
  const score = computeAnswerConfidence({ approvedDocs: [{ ...found, snippet: found.text }], claim: "The meeting is upcoming." });
  assert.ok(score.percent < 90); assert.ok(score.missing.some(text => /current Microsoft provider record/.test(text)));
});

test("F3 privacy: scoped original access never reads an ungranted status sibling", async () => {
  const { attachMicrosoftRetainedStatus } = await import("../worker/src/lib/microsoft-retained-status.js");
  const row = { source_kind: "microsoft", source: "microsoft", source_id: "outlook:event:review",
    doc_uid: "microsoft:outlook:event:review", content_hash: "synthetic-hash", text: "Synthetic authorized source text." };
  let reads = 0;
  const env = { DB: { prepare: () => { reads++; return { bind: () => ({ all: async () => ({ results: [
    { doc_uid: row.doc_uid, content_hash: row.content_hash, provider_status: "cancelled" },
  ] }) }) }; } } };
  const [scoped] = await attachMicrosoftRetainedStatus(env, [row], { access: { kind: "grant" } });
  assert.equal(scoped.microsoft_provider_status, "unavailable", "the scoped decision point was reached");
  assert.doesNotMatch(scoped.text, /cancelled/); assert.equal(reads, 0);
  const [owner] = await attachMicrosoftRetainedStatus(env, [row]);
  assert.equal(reads, 1, "the otherwise identical owner control reads the exact sibling");
  assert.equal(owner.microsoft_provider_status, "cancelled");
});

test("F3: an Outlook row read over budget or unreadable carries one provider-status notice", async t => {
  const { withMicrosoftStatusText } = await import("../worker/src/lib/microsoft-retained-status.js");
  const notices = text => (String(text || "").match(/\[Microsoft provider status: [a-z_]+\]/g) || []).length;
  const once = withMicrosoftStatusText("Retained source text.", "cancelled");
  assert.equal(notices(once), 1);
  assert.equal(withMicrosoftStatusText(once, "cancelled"), once, "a second overlay keeps the single notice");
  assert.equal(withMicrosoftStatusText("Retained source text.", "active"), "Retained source text.");
  const f = await setup(t, "cancelled");
  const found = (await search(f.env, { query: "Synthetic budget review", embedding: null, now: NOW })).results
    .find(row => row.source_id === "outlook:event:review");
  assert.ok(found, "the retained event was retrieved");
  assert.equal(notices(found.text), 1, "retrieval attached the notice once");
  // A long Outlook body: the first stored chunk alone is over the per-document read budget,
  // so the reading falls back to the retrieved excerpt, which already carries the notice.
  f.raw("UPDATE chunks SET text = ? WHERE doc_uid = ? AND chunk_ix = 0",
    "Synthetic review of the approved invoice amount of 1200 dollars. " + "x".repeat(170_000), found.doc_uid);
  const [plain] = await readDocumentEvidence(f.env, [found]);
  assert.equal(plain.read_complete, false, "the record was read over budget");
  assert.match(plain.snippet, /1200 dollars/);
  assert.equal(notices(plain.snippet), 1);
  const screened = await readDocumentEvidence(f.env, [found], { screening: {
    question: "What happened with the Synthetic budget review?", owner: "Fixture Owner", now: NOW } });
  assert.equal(screened.rows.length, 1, "the screened reading admitted the record");
  assert.equal(notices(screened.rows[0].snippet), 1);
  f.raw("DELETE FROM chunks WHERE doc_uid = ?", found.doc_uid);
  const [unreadable] = await readDocumentEvidence(f.env, [found]);
  assert.equal(unreadable.read_coverage.reason, "read_unavailable");
  assert.equal(notices(unreadable.snippet), 1);
});

test("F3: inconsistent retained-source references cannot assert another event's status", async t => {
  const f = await setup(t, "cancelled");
  f.raw("UPDATE documents SET meta=json_set(meta, '$.retained_source_id', ?) WHERE source_id=?",
    "outlook:event:other", "status:outlook:event:review");
  const result = await search(f.env, { query: "Synthetic budget review", embedding: null, now: NOW });
  const found = result.results.find(row => row.source_id === "outlook:event:review");
  assert.ok(found); assert.match(found.text, /1200 dollars/);
  assert.equal(found.microsoft_provider_status, "unavailable", "a mismatched annotation is unverified");
  assert.ok(f.seen.sql.some(sql => /microsoft-retained-status/.test(sql)), "the reference decision was reached");
});

test("C6 confidence: mentioning cancellation cannot license an upcoming claim at High", () => {
  const claim = "The meeting was not cancelled and is upcoming at 6 PM.";
  const docs = Array.from({ length: 3 }, (_, index) => ({ ref: `source-${index}`, title: "Synthetic meeting record",
    snippet: claim, ts: "2026-11-17", date_reliable: true,
    lineage: { status: "known", family_tokens: [`synthetic-family-${index}`] } }));
  const control = computeAnswerConfidence({ approvedDocs: docs, claim });
  assert.ok(control.percent >= 90, "the same agreeing, dated control reaches High");
  const changed = computeAnswerConfidence({ approvedDocs: docs.map(doc => ({ ...doc,
    microsoft_provider_status: "cancelled", snippet: `[Microsoft provider status: cancelled] ${doc.snippet}` })), claim });
  assert.ok(changed.percent < 90, "the data status constrains the score regardless of model wording");
});


test("A7/C6: replacement mailbox and cancelled status stay isolated through real Worker ingest and subject retrieval", async t => {
  const f = await setup(t, null);
  const id = "e".repeat(32);
  const connection = { provider_metadata: { microsoft_account_fingerprint: "f".repeat(64) }, microsoft_binding: {
    schema_version: 1, active_binding_id: id, bindings: {
      legacy: { state: "replaced", replaced_by: id, sync_states: {} },
      [id]: { state: "active", account_fingerprint: "f".repeat(64) } } } };
  let pages = 0; let writes = 0;
  for (const value of [[{ ...active, bodyPreview: "Synthetic current invoice amount of 2400 dollars." }], [{ id: "review", isCancelled: true }]]) {
    const result = await syncMicrosoftGraph({ connection, accessToken: "synthetic-access", now: () => NOW,
      ownerTimeZone: "America/Los_Angeles", mailFolderIds: [], includePersonalDrive: false,
      fetchImpl: async () => { pages++; return Response.json({ value, "@odata.deltaLink": `${G}/terminal` }); } });
    const response = await f.post("/api/admin/brain/ingest/batch", { docs: result.documents }, { "X-Admin-Key": f.env.ADMIN_KEY });
    assert.equal(response.status, 200); assert.equal((await response.json()).failed, 0); writes++;
  }
  assert.equal(pages, 2); assert.equal(writes, 2);
  const result = await search(f.env, { query: "Synthetic budget review", embedding: null, now: NOW });
  const old = result.results.find(row => row.source_id === "outlook:event:review");
  const current = result.results.find(row => row.source_id === `outlook:event:binding:${id}:review`);
  assert.ok(old); assert.ok(current);
  assert.match(old.text, /1200 dollars/); assert.equal(old.microsoft_provider_status, "active");
  assert.match(current.text, /2400 dollars/); assert.equal(current.microsoft_provider_status, "cancelled");
  const [read] = await readDocumentEvidence(f.env, [current]); assert.match(read.snippet, /Microsoft provider status: cancelled/);
  assert.ok(computeAnswerConfidence({ approvedDocs: [{ ...current, snippet: read.snippet, ts: "2026-11-17" }],
    claim: "The meeting is upcoming." }).percent < 90);
});

// Exercise the real adapter, delivery runner and Worker storage together. A
// cursor alone cannot prove whether a family exists after a reset or rebind.
async function cancellationFixture(t) {
  const f = await createProductFixture(); t.after(f.close);
  const calls = { graph: [], batches: [], inventories: [], saves: [], reviews: 0, removes: 0 };
  let state = {};
  let run = 0;
  const ingest = async (value, { reset = false } = {}) => {
    const step = ++run;
    return runProviderConnector({
      provider: "microsoft", source: "microsoft", reset,
      now: () => new Date(NOW), runId: `synthetic-cancel-${step}`,
      resolveAccess: async () => ({ accessToken: "synthetic-access" }),
      loadState: () => state,
      saveState: next => { calls.saves.push(next); state = next; },
      sync: ({ cursor, accessToken }) => syncMicrosoftGraph({
        accessToken, cursor, now: () => NOW, ownerTimeZone: "America/Los_Angeles",
        mailFolderIds: [], includePersonalDrive: false,
        fetchImpl: async url => {
          calls.graph.push(String(url));
          return Response.json({ value, "@odata.deltaLink": `${G}/terminal?step=${step}` });
        },
      }),
      listStoredFamilies: async () => {
        const families = new Set(f.rows("SELECT doc_uid FROM documents WHERE source=? AND deleted_at IS NULL", "microsoft")
          .map(row => row.doc_uid));
        calls.inventories.push(families);
        return families;
      },
      sendBatch: async ({ docs }) => {
        calls.batches.push(docs.map(doc => doc.source_id));
        const res = await f.post("/api/admin/brain/ingest/batch", { docs }, { "X-Admin-Key": f.env.ADMIN_KEY });
        assert.equal(res.status, 200, "the real Worker ingest decision was reached");
        const body = await res.json(); assert.equal(body.failed, 0);
        return { res, body };
      },
      postReceipt: async (_base, _key, receipt) => {
        const res = await f.post("/api/admin/brain/source-receipt", receipt, { "X-Admin-Key": f.env.ADMIN_KEY });
        assert.equal(res.status, 200);
      },
      reviewRemovals: async () => { calls.reviews++; assert.fail("cancellations cannot request a removal plan"); },
      removeDocuments: async () => { calls.removes++; assert.fail("cancellations cannot remove retained history"); },
    });
  };
  const snapshot = () => ({
    hash: f.first("SELECT content_hash FROM documents WHERE doc_uid=? AND deleted_at IS NULL", "microsoft:outlook:event:review")?.content_hash,
    chunks: f.rows("SELECT chunk_ix, text FROM chunks WHERE doc_uid=? ORDER BY chunk_ix", "microsoft:outlook:event:review"),
  });
  return { f, calls, ingest, snapshot };
}

const original = { ...active, bodyPreview: undefined,
  body: { contentType: "text", content: "Approved invoice amount is 1200 dollars. Keep the approval note." } };
for (const [label, cancellation, reset] of [
  ["start and subject without body", { ...active, bodyPreview: undefined, isCancelled: true }, false],
  ["start without subject or body", { id: active.id, start: active.start, end: active.end, isCancelled: true }, false],
  ["complete cancellation with changed body", { ...active, bodyPreview: "Synthetic cancellation notice replaces no approval.", isCancelled: true }, false],
  ["no-start cancellation control", { id: active.id, isCancelled: true }, false],
  ["start and subject after cursor reset", { ...active, bodyPreview: undefined, isCancelled: true }, true],
]) {
  test(`R1/C6: ${label} keeps stored source text byte-identical`, async t => {
    const { f, calls, ingest, snapshot } = await cancellationFixture(t);
    const first = await ingest([original]);
    assert.equal(first.cursor_advanced, true);
    const before = snapshot();
    assert.ok(before.hash); assert.ok(before.chunks.length > 0);
    const bytes = Buffer.from(before.chunks.map(row => row.text).join("\n\n"));
    assert.match(bytes.toString(), /Approved invoice amount is 1200 dollars\. Keep the approval note\./);

    const result = await ingest([cancellation], { reset });
    assert.equal(calls.graph.length, 2, "both provider observations reached the real adapter");
    assert.equal(calls.batches.length, 2, "both observations reached Worker storage");
    assert.equal(calls.reviews, 0); assert.equal(calls.removes, 0);
    assert.equal(result.cursor_advanced, true); assert.equal(result.refresh_succeeded, true);
    assert.equal(calls.saves.length, 2); assert.equal(calls.saves[1].cursor.calendar.delta_link, `${G}/terminal?step=2`);
    assert.ok(reset ? calls.graph[1].includes("calendarView/delta") : calls.graph[1].endsWith("terminal?step=1"));

    const after = snapshot();
    assert.deepEqual(Buffer.from(after.chunks.map(row => row.text).join("\n\n")), bytes,
      "cancellation must preserve every original stored text byte");
    assert.deepEqual(after, before, "the original content hash and exact chunks remain unchanged");
    assert.ok(calls.batches[1].includes("status:outlook:event:review"), "the cancelled-status write decision was reached");
    assert.ok(!calls.batches[1].includes("outlook:event:review"), "the cancellation cannot send a replacement for retained text");
    const found = (await search(f.env, { query: active.subject, embedding: null, now: NOW })).results
      .find(row => row.source_id === "outlook:event:review");
    assert.ok(found); assert.equal(found.microsoft_provider_status, "cancelled");
    assert.match(found.text, /1200 dollars/); assert.match(found.text, /not upcoming/i);
    const [read] = await readDocumentEvidence(f.env, [found]);
    assert.equal(read.read_complete, true); assert.match(read.snippet, /1200 dollars/);
    assert.match(read.snippet, /Microsoft provider status: cancelled/);
    const score = computeAnswerConfidence({ approvedDocs: [{ ...found, snippet: read.snippet, ts: "2026-11-17" }],
      claim: "The meeting is upcoming at 6 PM." });
    assert.ok(score.percent < 90, "cancelled schedule evidence cannot become a wrong upcoming claim at High");
    assert.ok(score.basis.length); assert.ok(score.missing.length);
  });
}

test("R1/C6 green control: an ordinary active update still replaces the current source text", async t => {
  const { f, calls, ingest, snapshot } = await cancellationFixture(t);
  await ingest([original]);
  const before = snapshot();
  const result = await ingest([{ ...active, bodyPreview: "Synthetic revised approved invoice amount is 2400 dollars." }]);
  assert.equal(calls.graph.length, 2); assert.equal(calls.batches.length, 2);
  assert.ok(calls.batches[1].includes("outlook:event:review"), "the active-update write decision was reached");
  assert.notEqual(snapshot().hash, before.hash);
  const found = (await search(f.env, { query: active.subject, embedding: null, now: NOW })).results
    .find(row => row.source_id === "outlook:event:review");
  assert.ok(found); assert.match(found.text, /2400 dollars/); assert.doesNotMatch(found.text, /1200 dollars/);
  assert.equal(found.microsoft_provider_status, "active");
  assert.equal(calls.saves.length, 2); assert.equal(result.cursor_advanced, true);
  assert.equal(calls.reviews, 0); assert.equal(calls.removes, 0);
});

test("R1/C6: a first-seen complete cancellation keeps its body and later cancellation cannot replace it", async t => {
  const { f, calls, ingest, snapshot } = await cancellationFixture(t);
  const first = await ingest([{ ...original, isCancelled: true }]);
  assert.equal(first.cursor_advanced, true); assert.equal(calls.graph.length, 1);
  assert.ok(calls.batches[0].includes("outlook:event:review"), "first-seen complete cancellation evidence was stored");
  const before = snapshot();
  assert.ok(before.hash); assert.match(before.chunks.map(row => row.text).join("\n\n"), /1200 dollars/);
  const result = await ingest([{ ...active, isCancelled: true, bodyPreview: undefined }], { reset: true });
  assert.equal(calls.graph.length, 2); assert.equal(calls.batches.length, 2);
  assert.ok(calls.inventories.some(ids => ids.has("microsoft:outlook:event:review")), "stored-family reconciliation saw the original");
  assert.ok(calls.batches[1].includes("status:outlook:event:review"));
  assert.ok(!calls.batches[1].includes("outlook:event:review"), "repeat cancellations only update status");
  assert.deepEqual(snapshot(), before, "repeat cancellations keep the first complete evidence byte-identical");
  const found = (await search(f.env, { query: active.subject, embedding: null, now: NOW })).results
    .find(row => row.source_id === "outlook:event:review");
  assert.ok(found); assert.equal(found.microsoft_provider_status, "cancelled");
  assert.match(found.text, /1200 dollars/);
  assert.equal(result.cursor_advanced, true); assert.equal(calls.saves.length, 2);
  assert.equal(calls.reviews, 0); assert.equal(calls.removes, 0);
});
