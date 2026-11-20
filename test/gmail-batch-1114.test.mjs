import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdIngestRemote, cmdLoad, describeLoadResult, credentialScannerFingerprint, listStoredSourceFamilies } from "../brain.mjs";
import { gmailPolicyFingerprint, listHistory, listMessages } from "../connectors/gmail.mjs";
import * as ingest from "../ingest/run.mjs";
import { api as googleApi } from "../connectors/google-drive.mjs";
import { createTokenProvider } from "../connectors/google-auth.mjs";
import worker from "../worker/src/index.js";
import { runDailyRefresh } from "../operations/daily-refresh-run.mjs";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { forgetFamilies, searchKeyword, listSourceFamilies, sourceInventory } from "../worker/src/lib/store-d1.js";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";
import { backfillSourceFamilyIndex } from "../worker/src/lib/source-family-index.js";
import { keywordFixture, oldKeyword } from "../worker/test/fixtures/keyword-search.mjs";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

import { fixture, dailyFixture } from "./helpers/gmail-batch-fixture.mjs";

test("R5 GMAIL-05: slow body waves checkpoint accepted mail before the daily deadline", async () => fixture(async f => {
  const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
  f.ids = Array.from({ length: 32 }, (_, i) => `body-${i}`);
  f.options = { ingestNowMs: () => clock.now };
  let deadline;
  f.inventory = ({ uids, deadlineAt }) => {
    deadline = deadlineAt; clock.now += 6000;
    return new Set(uids.filter(uid => f.stored.has(uid)));
  };
  const pending = [];
  let pumping = false, expired = 0, completed = 0;
  const pump = () => {
    pumping = true;
    setImmediate(() => {
      const at = Math.min(...pending.map(item => item.at));
      clock.now = at;
      for (const item of pending.splice(0).sort((a, b) => a.at - b.at)) {
        if (item.at !== at) { pending.push(item); continue; }
        if (at >= deadline) { expired++; item.reject(Object.assign(new Error("synthetic read deadline"), { reason: "requestDeadline" })); }
        else { completed++; item.resolve({ version: "revision", envelope: { source_type: "gmail", source_id: item.id,
          title: "Synthetic correspondence", content: "Ordinary synthetic mail for the bounded body progress probe." } }); }
      }
      pumping = false;
      if (pending.length) pump();
    });
  };
  f.customEnvelope = id => new Promise((resolve, reject) => {
    pending.push({ id, at: Math.min(deadline, clock.now + 15000), resolve, reject });
    if (!pumping) pump();
  });
  let previous = 0;
  for (let attempt = 0; attempt < 4 && f.state().history_id !== "next"; attempt++) {
    await dailyFixture(f, clock);
    assert.ok(completed > 0 && f.inventoryCalls.length > 0, "real preflight and successful slow-body decisions reached");
    assert.ok(f.stored.size > previous, "each daily run durably accepts a healthy body prefix");
    previous = f.stored.size;
    if (f.state().gmail_batch_window) assert.equal(f.state().history_id, "prior");
  }
  assert.ok(expired > 0, "deadline branch actually reached");
  assert.equal(f.stored.size, 32);
  assert.equal(f.state().history_id, "next");
  assert.equal(f.forgotten, 0);
}));

for (const slow of [true, false]) for (const present of [true, false]) {
  test(`R5 GMAIL-10: ${slow ? "partial" : "full"} inventory preserves an unvisited ${present ? "stored" : "absent"} deleted tail`, async () => fixture(async f => {
    const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
    const deleted = Array.from({ length: 999 }, (_, i) => `deleted-${i}`);
    const tail = `gmail:${deleted.at(-1)}`;
    f.ids = ["healthy-control"];
    f.options = { ingestNowMs: () => clock.now };
    f.history = () => ({ ids: f.ids, deletedIds: deleted, historyId: "next", hasMore: false,
      removal_causes: Object.fromEntries(deleted.map(id => [id, "explicit_deletion"])) });
    if (present) f.stored.add(tail);
    f.setState({ ...f.state(), done: { [tail]: "prior-copy" } });
    f.inventory = ({ uids }) => {
      if (slow) clock.now += 6000;
      return new Set(uids.filter(uid => f.stored.has(uid)));
    };
    const run = await f.once({}, { flags: { only: "gmail" }, deferGmailRemovals: true,
      allowPartialRefresh: true, ingestDeadlineAt: clock.now + 60000 });
    assert.equal(run.error, null);
    const visited = f.inventoryCalls.some(call => call.uids.includes(tail));
    assert.equal(visited, !slow, "bounded inventory decision reached with the exact tail position");
    assert.ok(f.stored.has("gmail:healthy-control"), "healthy addition actually accepted");
    assert.equal(run.state.history_id, "next");
    if (slow || present) {
      assert.equal(run.state.gmail_owner_removals?.[tail], "explicit_deletion", "absence needs exact current-run evidence");
      assert.equal(run.state.done[tail], "prior-copy");
      // Retaining a copy is an owner decision, not missing provider work.
      assert.equal(run.receipt.status, "ready");
      assert.equal(run.receipt.provider_check_complete, true);
      assert.ok(run.result.pending_removals > 0, "retained decision stays visible");
      assert.equal(run.receipt.complete_sweep, false);
    } else {
      assert.equal(run.state.gmail_owner_removals?.[tail], undefined, "proved absent control clears the decision");
      assert.equal(run.state.done[tail], undefined);
      assert.equal(run.receipt.status, "ready", "proved-absent control completes too");
      assert.equal(run.result.pending_removals, 0);
    }
    if (slow) {
      const calls = f.inventoryCalls.length;
      f.ids = ["later-control"];
      f.history = () => ({ ids: f.ids, deletedIds: [], historyId: "later", hasMore: false });
      const restarted = await f.once({}, { flags: { only: "gmail" }, deferGmailRemovals: true,
        allowPartialRefresh: true, ingestDeadlineAt: clock.now + 60000 });
      assert.equal(restarted.error, null);
      assert.ok(!f.inventoryCalls.slice(calls).some(call => call.uids.includes(tail)), "restart also leaves this tail unvisited");
      assert.equal(restarted.state.gmail_owner_removals?.[tail], "explicit_deletion");
      assert.equal(restarted.state.done[tail], "prior-copy");
      assert.ok(f.stored.has("gmail:later-control"), "new history passes the retained owner decision");
      assert.equal(restarted.state.history_id, "later");
      assert.equal(restarted.receipt.status, "ready");
      assert.ok(restarted.result.pending_removals > 0);
    }
    assert.equal(f.forgotten, 0);
  }));
}

test("R5 GMAIL-05 fast-body control completes the same 32-message window", async () => fixture(async f => {
  f.ids = Array.from({ length: 32 }, (_, i) => `fast-${i}`);
  const run = await f.once();
  assert.equal(run.error, null);
  assert.equal(f.reads.length, 32);
  assert.equal(f.stored.size, 32);
  assert.equal(run.state.history_id, "next");
  assert.equal(f.forgotten, 0);
}));

for (const outcome of ["policy", "deleted", "accepted"]) test(`R5 GMAIL-10: reconstructed ${outcome} outcome retains an unvisited decision`, async () => fixture(async f => {
  const { openGmailBatchWindow } = await import("../operations/gmail-batch-window.mjs");
  const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
  const priorIds = Array.from({ length: 999 }, (_, i) => `saved-${i}`);
  const tail = `gmail:${priorIds.at(-1)}`;
  const state = f.state();
  state.done[tail] = "prior-copy";
  state.gmail_owner_removals = { [tail]: "explicit_deletion" };
  const window = openGmailBatchWindow(state, { ids: ["healthy-control", ...priorIds], deletedIds: [],
    historyId: "next", hasMore: false }, state.gmail_policy_fingerprint);
  window.remaining_ids = ["healthy-control"];
  window.skip_outcomes = Object.fromEntries(priorIds.filter(id => outcome !== "accepted" || `gmail:${id}` !== tail)
    .map(id => [id, outcome === "accepted" ? "policy" : outcome]));
  for (const id of Object.keys(window.skip_outcomes)) state.skipped[`gmail:${id}`] = "synthetic saved source decision";
  f.setState(state); f.stored.add(tail);
  f.options = { deferGmailRemovals: true, ingestNowMs: () => clock.now, ingestDeadlineAt: clock.now + 60000 };
  f.inventory = ({ uids }) => { clock.now += 6000; return new Set(uids.filter(uid => f.stored.has(uid))); };
  const run = await f.once();
  assert.equal(run.error, null);
  assert.ok(f.inventoryCalls.length > 0 && !f.inventoryCalls.some(call => call.uids.includes(tail)), "reconstructed tail is not checked");
  assert.ok(f.stored.has("gmail:healthy-control"), "remaining healthy entry accepted");
  assert.equal(run.state.gmail_owner_removals[tail], "explicit_deletion");
  assert.equal(run.state.done[tail], "prior-copy");
  if (outcome !== "accepted") assert.equal(run.state.skipped[tail], "synthetic saved source decision");
  assert.equal(run.state.history_id, "next");
  // The accepted arm still has an unverified accepted-document gap. Policy
  // and deletion arms have completed provider work and keep only owner review.
  assert.equal(run.receipt.status, outcome === "accepted" ? "error" : "ready");
  if (outcome !== "accepted") assert.equal(run.receipt.provider_check_complete, true);
  assert.equal(run.receipt.complete_sweep, false);
  assert.ok(run.result.pending_removals > 0);
  assert.equal(f.forgotten, 0);
}));

test("R4 GMAIL-05: slow indexed preflight makes durable daily progress across restarts", async () => fixture(async f => {
  const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
  f.ids = Array.from({ length: 1000 }, (_, i) => `slow-${i}`);
  f.captureSaves = false;
  f.options = { ingestNowMs: () => clock.now };
  f.inventory = ({ uids, deadlineAt }) => {
    assert.ok(uids.length <= 97);
    f.inventoryDeadline = deadlineAt;
    clock.now += 6000;
    return new Set(uids.filter(uid => f.stored.has(uid)));
  };
  let previous = 0;
  for (let attempt = 0; attempt < 6 && f.state().history_id !== "next"; attempt++) {
    await dailyFixture(f, clock);
    const state = f.state();
    assert.ok(f.inventoryCalls.length > 0, "slow inventory decision reached");
    assert.ok(f.stored.size > previous, "each bounded invocation accepts a durable prefix");
    previous = f.stored.size;
    if (state.gmail_batch_window) {
      assert.equal(state.history_id, "prior");
      assert.ok(state.gmail_batch_window.remaining_ids.length > 0);
    }
  }
  assert.equal(f.stored.size, 1000);
  assert.equal(f.state().history_id, "next");
  assert.ok(Number.isFinite(f.inventoryDeadline), "inventory shares the admitted daily deadline");
  assert.equal(f.forgotten, 0);
}));

test("R4 GMAIL-09: missing policy is durably held while siblings and later history advance", async () => fixture(async f => {
  const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
  f.ids = ["missing-policy", "healthy-sibling"];
  f.stored.add("gmail:missing-policy");
  f.setState({ ...f.state(), done: { "gmail:missing-policy": "prior-copy" } });
  f.policy = id => id === "missing-policy" ? { allowed: false, cursor_blocking: true,
    retain_existing: true, skip: { reason: "synthetic missing policy evidence" } } : { allowed: true };
  f.options = { ingestNowMs: () => clock.now };
  f.history = () => ({ ids: f.state().history_id === "prior" ? f.ids : ["later-healthy"],
    deletedIds: [], historyId: f.state().history_id === "prior" ? "next" : "later", hasMore: false });
  await dailyFixture(f, clock);
  assert.ok(f.policyReads.includes("missing-policy"), "missing-evidence decision reached");
  assert.ok(f.stored.has("gmail:healthy-sibling"));
  assert.ok(f.stored.has("gmail:later-healthy"));
  const state = f.state();
  assert.equal(state.history_id, "later");
  assert.equal(state.gmail_retry["gmail:missing-policy"], true);
  assert.equal(state.done["gmail:missing-policy"], "prior-copy");
  assert.match(state.skipped["gmail:missing-policy"], /policy/);
  assert.equal(f.receipts.at(-1).status, "error");
  assert.equal(f.receipts.at(-1).complete_sweep, false);
  f.policy = () => ({ allowed: true }); f.ids = [];
  const control = await f.once();
  assert.equal(control.error, null);
  assert.equal(control.state.gmail_retry, undefined, "settled policy control clears the obligation");
  assert.equal(f.forgotten, 0);
}));

test("R4 composed: per-item policy, read, preparation and Worker failures preserve healthy mail", async () => fixture(async f => {
  f.ids = ["policy-throw", "policy-gap", "body-throw", "prepare-throw", "worker-fail", "healthy-control"];
  const reached = new Set();
  f.policy = id => {
    if (id === "policy-throw") { reached.add(id); throw new Error("synthetic item policy parse failure"); }
    if (id === "policy-gap") { reached.add(id); return { allowed: false, cursor_blocking: true,
      retain_existing: true, skip: { reason: "synthetic missing policy evidence" } }; }
    return { allowed: true };
  };
  f.customEnvelope = id => {
    if (id === "body-throw") { reached.add(id); throw new Error("synthetic item extraction failure"); }
    if (id === "prepare-throw") { reached.add(id); return { version: "revision", envelope: null }; }
    return { version: "revision", envelope: { source_type: "gmail", source_id: id,
      title: "Synthetic correspondence", content: "Ordinary synthetic correspondence used for isolated item outcomes." } };
  };
  const accepted = f.respond;
  f.respond = docs => {
    accepted(docs.filter(doc => doc.source_id !== "worker-fail"));
    return json({ results: docs.map(doc => ({ source_id: doc.source_id,
      status: doc.source_id === "worker-fail" ? (reached.add("worker-fail"), "failed") : "created", chunks: 1 })) });
  };
  const run = await f.once();
  assert.equal(reached.size, 5, "every failing per-item decision reached in one run");
  assert.ok(f.stored.has("gmail:healthy-control"), "healthy suffix accepted despite every failed step");
  assert.equal(run.state.history_id, "next");
  assert.equal(Object.keys(run.state.gmail_retry).length, 5);
  assert.equal(run.receipt.status, "error");
  assert.equal(f.forgotten, 0);
}));

test("single-part accepted Gmail batches never request family reconciliation", async () => fixture(async (f) => {
  const run = await f.once();
  assert.equal(run.error, null);
  assert.ok(f.calls.length >= 3, "actual batch sender reached");
  assert.equal(Object.keys(run.state.done).length, 101, "positive acceptance control");
  assert.equal(f.selectors.length, 0, "single-part mail needs no sibling query");
}));

test("each accepted batch checkpoints progress and an interrupted window resumes only pending mail", async () => fixture(async (f) => {
  // Per-message dispatch retains the original 50-message accepted prefix.
  f.failBatch = 51;
  const first = await f.once();
  assert.ok(first.error, "interrupted second batch is visible");
  assert.equal(f.calls.length, 51, "failure decision reached after a green batch");
  assert.equal(Object.keys(first.state.done).length, 50);
  assert.equal(first.state.history_id, "prior", "no mailbox marker crosses unsent mail");
  assert.equal(first.state.gmail_batch_window.remaining_ids.length, 51);
  assert.equal(first.state.gmail_batch_window.last_processed_at, "2026-01-01T12:00:00.000Z", "accepted batch has durable progress time");
  f.failBatch = 0; f.calls.length = 0; f.reads.length = 0;
  const resumed = await f.once();
  assert.equal(resumed.error, null);
  assert.equal(f.historyReads, 1, "resume uses the saved window, without relisting history");
  assert.equal(f.reads.length, 51, "accepted bodies are not fetched again");
  assert.equal(f.calls.flat().length, 51, "only the unresolved suffix is sent");
  assert.equal(resumed.state.history_id, "next");
  assert.equal(resumed.state.gmail_batch_window, undefined);
}));

test("split Gmail families retain indexed reconciliation after every part is accepted", async () => fixture(async (f) => {
  f.ids = ["multipart"];
  f.content = "Ordinary synthetic correspondence. ".repeat(35000);
  const run = await f.once();
  assert.equal(run.error, null);
  assert.ok(f.calls.flat().length > 1, "actual splitter and batch sender reached");
  assert.equal(f.selectors.length, 1);
  assert.equal(f.selectors[0].family_kind, "structural");
  assert.ok(f.selectors[0].keep_doc_uids.length > 1, "all replacement parts are protected");
}));

test("bounded history retains the starting marker and persists the exact provider page", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return json({ historyId: "900", nextPageToken: "page-next", history: [
      { id: "110", messagesAdded: [{ message: { id: "entry-a" } }] },
      { id: "120", messagesAdded: [{ message: { id: "entry-b" } }] },
    ] });
  };
  try {
    const result = await listHistory(async () => "synthetic", "100", { windowPages: 1 });
    assert.equal(requests.length, 1, "provider pagination decision reached exactly once");
    assert.equal(result.historyId, "100");
    assert.equal(result.continuation.page_token, "page-next");
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.ids, ["entry-a", "entry-b"]);
  } finally { globalThis.fetch = original; }
});

test("a lost accepted family is repaired on resume rather than hidden by the batch checkpoint", async () => fixture(async (f) => {
  // Per-message dispatch retains the original 50-message accepted prefix.
  f.failBatch = 51;
  const first = await f.once();
  assert.ok(first.error && f.calls.length === 51, "green first batch and interruption reached");
  assert.equal(first.state.gmail_batch_window.remaining_ids.length, 51);
  assert.ok(f.stored.delete("gmail:entry-0"), "remove a previously accepted family from synthetic D1");
  f.calls.length = 0; f.reads.length = 0; f.failBatch = 0;
  const resumed = await f.once();
  assert.equal(resumed.error, null);
  assert.equal(f.reads.length, 52);
  assert.ok(f.calls.flat().includes("entry-0"), "missing accepted family was actually repaired");
  assert.equal(resumed.state.history_id, "next");
}));

test("malformed saved work stops before provider reads and leaves the cursor intact", async () => fixture(async (f) => {
  f.setState({ ...f.state(), gmail_batch_window: { version: 1 } });
  const bad = await f.once();
  assert.match(bad.error?.message || "", /saved Gmail batch window is invalid/);
  assert.equal(f.historyReads, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(bad.state.history_id, "prior");
  assert.equal(bad.receipt.status, "error", "validation decision closed an actual run receipt");
  const fixed = f.state(); delete fixed.gmail_batch_window; f.setState(fixed);
  const good = await f.once();
  assert.equal(good.error, null);
  assert.ok(f.calls.length > 0, "same runner accepts a valid window");
}));

test("a bounded continuation is partial, visible and resumes at the consumed record marker", async () => fixture(async (f) => {
  f.ids = ["entry-a"]; f.hasMore = true;
  const first = await f.once();
  assert.equal(first.error, null);
  assert.ok(f.calls.length > 0, "positive storage decision reached");
  assert.equal(first.result.complete, false);
  assert.equal(first.result.more_history, true);
  assert.equal(first.receipt.status, "error", "unread history cannot advertise a healthy fresh feed");
  assert.equal(first.receipt.issue_code, "INGEST_FAILED");
  assert.equal(first.receipt.walk_complete, false, "one bounded page is not a complete history walk");
  assert.match(first.output, /more history remains/);
  assert.equal(first.state.history_id, "next");
  f.ids = ["entry-b"]; f.marker = "later"; f.hasMore = false;
  const last = await f.once();
  assert.equal(last.error, null);
  assert.equal(last.result.complete, true);
  assert.equal(last.receipt.status, "ready", "the exhausted history control is healthy");
  assert.equal(last.state.history_id, "later");
}));

test("missing bounded record proof never advances a marker", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ historyId: "900", nextPageToken: "later", history: [
    { messagesAdded: [{ message: { id: "entry-a" } }] },
  ] }); };
  try {
    await assert.rejects(listHistory(async () => "synthetic", "100", { windowPages: 1 }), /no advancing record marker/);
    assert.equal(calls, 1, "bounded marker decision reached with a nonempty history record");
  } finally { globalThis.fetch = original; }
});

test("large SQLite corpus proves structural and declared family seeks, with a historical scan control", async () => {
  const db = new DatabaseSync(":memory:");
  const queries = [];
  const prepare = (sql, params = []) => ({
    bind: (...values) => prepare(sql, values),
    all: async () => {
      const start = performance.now();
      const results = db.prepare(sql).all(...params).map(row => ({ ...row }));
      queries.push({ sql, params, rows: results.length, ms: performance.now() - start });
      return { results };
    },
  });
  const env = { DB: { prepare, batch: async statements => {
    db.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } } };
  try {
    db.exec(`CREATE TABLE documents(doc_uid TEXT PRIMARY KEY, source TEXT, meta TEXT, deleted_at INTEGER,
      source_original_binding_hash TEXT, document_revision_id TEXT, content_hash TEXT, provenance_receipt_digest TEXT);
      CREATE TABLE source_original_result_bindings(binding_hash TEXT PRIMARY KEY, document_revision_id TEXT,
        source TEXT, tenant_id TEXT, locator_kind TEXT, document_content_hash TEXT, provenance_receipt_digest TEXT, original_id TEXT);
      CREATE TABLE chunks(chunk_uid TEXT, vector_id TEXT, doc_uid TEXT);
      CREATE INDEX idx_chunks_doc ON chunks(doc_uid);`);
    const insert = db.prepare("INSERT INTO documents(doc_uid,source,meta) VALUES(?,?,?)");
    db.exec("BEGIN");
    for (let i = 0; i < 100_000; i++) insert.run(`gmail:bulk-${i}`, "gmail", '{"kind":"synthetic"}');
    insert.run("gmail:probe", "gmail", "{}");
    insert.run("gmail:probe#part1of2", "gmail", '{"part_of":"probe","part":1,"part_count":2}');
    insert.run("gmail:probe#part2of2", "gmail", '{"part_of":"probe","part":2,"part_count":2}');
    insert.run("message:declared", "message", '{"family_of":"gmail:probe"}');
    db.exec("COMMIT");
    const legacy = `SELECT doc_uid FROM documents WHERE doc_uid=?1 OR
      substr(doc_uid,1,length(?1||'#part'))=?1||'#part' OR
      (json_valid(meta) AND json_type(meta,'$.family_of')='text' AND json_extract(meta,'$.family_of')=?1)`;
    const beforePlan = db.prepare(`EXPLAIN QUERY PLAN ${legacy}`).all("gmail:probe").map(row => row.detail);
    const start = performance.now();
    const before = db.prepare(legacy).all("gmail:probe");
    const beforeMs = performance.now() - start;
    assert.equal(before.length, 4, "nonempty historical scan control");
    assert.ok(beforePlan.some(detail => /SCAN documents/.test(detail)));
    const families = [{ base_doc_uid: "gmail:probe", family_kind: "structural",
      keep_doc_uids: ["gmail:probe", "gmail:probe#part1of2", "gmail:probe#part2of2"] }];
    queries.length = 0;
    const structural = await forgetFamilies(env, { families });
    assert.equal(structural.documents, 0, "verified current parts were protected");
    assert.equal(queries.length, 1, "real structural lookup reached without index-state or global query");
    const structuralQuery = queries[0];
    assert.equal(structuralQuery.rows, 3, "all protected members were actually resolved");
    const structuralPlan = db.prepare(`EXPLAIN QUERY PLAN ${structuralQuery.sql}`).all(...structuralQuery.params).map(row => row.detail);
    assert.ok(structuralPlan.some(detail => /SEARCH documents.*doc_uid/.test(detail)));
    assert.ok(structuralPlan.every(detail => !/SCAN documents/.test(detail)));
    const stale = await forgetFamilies(env, { families: [{ ...families[0], keep_doc_uids: ["gmail:probe#part1of2"] }] });
    assert.deepEqual([...stale.targets].sort(), ["gmail:probe", "gmail:probe#part2of2"], "positive stale-member preview control");
    assert.equal(db.prepare("SELECT count(*) AS n FROM documents").get().n, 100004, "dry preview preserves the full corpus");
    // Apply the shipped additive migration and its real bounded owning command.
    db.exec(readFileSync(new URL("../migrations/d1/0059_document_family_index.sql", import.meta.url), "utf8"));
    let pages = 0;
    while (!(await backfillSourceFamilyIndex(env)).complete) { assert.ok(++pages < 205); }
    assert.ok(pages >= 200, "actual 500-row backfill decision reached across the large table");
    queries.length = 0;
    const declared = await forgetFamilies(env, { families: [{ base_doc_uid: "gmail:probe", family_kind: "declared", keep_doc_uids: ["message:declared"] }] });
    assert.equal(declared.documents, 0);
    const declaredQuery = queries.find(query => /JOIN documents USING/.test(query.sql));
    assert.ok(declaredQuery, "actual declared-family resolver reached");
    const declaredPlan = db.prepare(`EXPLAIN QUERY PLAN ${declaredQuery.sql}`).all(...declaredQuery.params).map(row => row.detail);
    assert.ok(declaredPlan.some(detail => /SEARCH document_family_index.*idx_document_family_declared/.test(detail)));
    assert.ok(declaredPlan.every(detail => !/SCAN (documents|document_family_index)/.test(detail)));
    console.log(JSON.stringify({ probe: "family-plan", rows: 100004, beforePlan, beforeMs,
      structuralPlan, structuralMs: structuralQuery.ms, declaredPlan, declaredMs: declaredQuery.ms }));
  } finally { db.close(); }
});

test("the shipped keyword candidate CTE matches exact pre-fix rows and scores on a large corpus", async () => {
  const f = keywordFixture(36_000);
  try {
    const start = performance.now();
    let beforeSql;
    const before = oldKeyword({ prepare(sql) { beforeSql = sql; return f.db.prepare(sql); } }, '"payment"', { limit: 40 });
    const beforeMs = performance.now() - start;
    const beforePlan = f.db.prepare(`EXPLAIN QUERY PLAN ${beforeSql}`).all('"payment"', 40).map(row => row.detail);
    const afterStart = performance.now();
    const after = await searchKeyword(f.env, "payment", { limit: 40 });
    const afterMs = performance.now() - afterStart;
    assert.equal(before.length, 40, "positive exact-query control");
    assert.deepEqual(after, before);
    const candidate = f.calls.find(call => /keyword_candidates AS MATERIALIZED/.test(call.sql));
    assert.ok(candidate, "actual shipped keyword candidate decision reached");
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${candidate.sql}`).all(...candidate.params).map(row => row.detail);
    console.log(JSON.stringify({ probe: "keyword-plan", rows: 36000, beforeMs, afterMs, beforePlan, plan }));
  } finally { f.db.close(); }
});

test("a cleanup failure retains split proof after cursor settlement without resending accepted parts", async () => fixture(async (f) => {
  f.ids = ["multipart"]; f.content = "Ordinary synthetic correspondence. ".repeat(35000);
  f.previewFailure = true;
  const first = await f.once();
  // Provider/transport text is private; the public command exposes only its
  // fixed product failure while the exact failed preview remains observable.
  assert.match(first.error?.message || "", /Gmail refresh did not finish/);
  assert.equal(first.error?.message.includes("synthetic removal preview interruption"), false);
  assert.equal(first.error?.supportCode, "INGEST_FAILED");
  assert.match(first.error?.message || "", /Help: https:\/\/financialbrain\.ai\/help\/INGEST_FAILED/);
  assert.ok(f.previews > 0 && f.calls.flat().length > 1, "split storage and cleanup decisions reached");
  // Direct preview now follows the durable add-only checkpoint. Its failure
  // remains visible without turning already accepted mail into pending work.
  assert.equal(first.receipt.status, "error");
  assert.equal(first.state.history_id, "next");
  assert.equal(first.state.gmail_batch_window, undefined);
  assert.ok(first.state.ingest_pending_families["gmail:multipart"].family.keep_doc_uids.length > 1);
  f.calls.length = 0; f.reads.length = 0; f.previewFailure = false;
  f.ids = []; // The provider has no new changes after the completed marker.
  const second = await f.once();
  assert.equal(second.error, null);
  assert.equal(f.calls.length, 0, "accepted parts never resent");
  assert.equal(f.reads.length, 0);
  assert.equal(second.state.history_id, "next");
  assert.equal(f.historyReads, 2, "the next provider check reached its completed marker");
  assert.ok(f.previews > 1, "saved exact split plan was reviewed on resume");
  assert.equal(second.receipt.status, "ready", "successful preview control completes");
  assert.equal(second.state.ingest_pending_families, undefined);
  assert.equal(f.forgotten, 0);
}));

test("saved obsolete single-part reconciliation entries are pruned without querying members", async () => fixture(async (f) => {
  f.ids = [];
  const key = "gmail:prior-entry";
  const state = f.state(); state.done[key] = "revision";
  state.ingest_pending_families = { [key]: { stateKey: key, hash: "revision", family: {
    base_doc_uid: key, keep_doc_uids: [key], family_kind: "structural",
  } } }; f.setState(state);
  const run = await f.once();
  assert.equal(run.error, null);
  assert.equal(f.historyReads, 1, "a real incremental window was consumed");
  assert.equal(f.previews, 0);
  assert.equal(run.state.ingest_pending_families, undefined);
  assert.equal(run.state.done[key], "revision", "accepted original remains intact");
}));

test("a page exceeding its identity cap saves a lossless bounded continuation", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ historyId: "900", history: [
    { id: "110", messagesAdded: ["entry-a", "entry-b"].map(id => ({ message: { id } })) },
  ] }); };
  try {
    const partial = await listHistory(async () => "synthetic", "100", { windowPages: 1, maxWindowMessages: 1 });
    assert.deepEqual(partial.ids, ["entry-a"]);
    assert.equal(partial.historyId, "100");
    assert.equal(partial.continuation.offset, 1);
    const resumed = await listHistory(async () => "synthetic", "100", { windowPages: 1, maxWindowMessages: 1, continuation: partial.continuation });
    assert.deepEqual(resumed.ids, ["entry-b"]);
    assert.equal(resumed.historyId, "900");
    assert.equal(calls, 2, "nonempty oversized decision and exact suffix reached");
    const good = await listHistory(async () => "synthetic", "100", { windowPages: 1, maxWindowMessages: 2 });
    assert.equal(good.ids.length, 2, "same provider response succeeds within its bound");
    assert.equal(good.historyId, "900");
  } finally { globalThis.fetch = original; }
});

test("the focused regression is registered once in both chain inventories", async () => {
  const { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } = await import("../scripts/run-test-chain.mjs");
  for (const commands of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS]) {
    for (const suite of ["gmail-batch-1114", "gmail-entry-sweep"]) {
      assert.equal(commands.filter(command => command === `node --test test/${suite}.test.mjs`).length, 1);
    }
  }
});


test("GMAIL-02: the real runner verifies only bounded window identities, including a lost accepted prefix", async () => fixture(async f => {
  f.ids = Array.from({ length: 101 }, (_, i) => `bounded-${i}`);
  // Per-message dispatch retains the original 50-message accepted prefix.
  f.failBatch = 51;
  const first = await f.once();
  assert.ok(first.error && f.calls.length >= 2, "interruption decision reached after an accepted batch");
  f.stored.delete("gmail:bounded-0");
  f.failBatch = 0; f.reads.length = 0;
  const second = await f.once();
  assert.equal(second.error, null);
  assert.ok(f.inventoryCalls.length > 0, "the actual runner requested stored truth");
  assert.ok(f.inventoryCalls.every(call => call.requireIndexed === true && call.uids?.length > 0 && call.uids.length <= 97),
    "no source-wide inventory or compatibility widening is allowed");
  assert.ok(f.reads.includes("bounded-0"), "missing accepted prefix is repaired");
  assert.ok(!f.reads.includes("bounded-1"), "present accepted prefix is not fetched again");
}));

for (const mode of ["absent", "expired", "scanner", "policy"]) {
  test(`GMAIL-04: bounded durable recovery for ${mode} state`, async () => fixture(async f => {
    const state = f.state();
    if (mode === "absent") delete state.history_id;
    if (mode === "scanner") state.credential_scanner_fingerprint = "old";
    if (mode === "policy") state.gmail_policy_fingerprint = "old";
    f.setState(state);
    f.history = async () => ({ expired: true, ids: [], deletedIds: [] });
    const pages = [];
    f.messagePage = async (_token, opts) => {
      pages.push(opts.pageToken || null);
      return opts.pageToken ? { ids: ["recovery-b"], nextPageToken: null }
        : { ids: ["recovery-a"], nextPageToken: "page-b" };
    };
    const first = await f.once();
    assert.equal(first.error, null);
    assert.equal(first.result.more_history, true);
    assert.deepEqual(pages, [null], "one page, not a full mailbox walk");
    assert.equal(first.state.history_id, state.history_id, "pre-walk marker cannot pass an unfinished walk");
    const second = await f.once();
    assert.equal(second.error, null);
    assert.deepEqual(pages, [null, "page-b"], "durable page token resumes after restart");
    assert.equal(f.profileReads, 1, "pre-walk anchor is retained across invocations");
    assert.equal(f.fullLists || 0, 0, "legacy unbounded listing never reached");
    assert.deepEqual(f.reads, ["recovery-a", "recovery-b"]);
    assert.equal(f.stored.size, 2);
  }));
}

test("GMAIL-03: an oversized single record drains at the unchanged production cap", async () => {
  const original = globalThis.fetch;
  const all = Array.from({ length: 2501 }, (_, i) => ({ message: { id: `large-${i}` } }));
  let calls = 0; let start = "100"; let continuation = null;
  const seen = [];
  globalThis.fetch = async () => { calls++; return json({ historyId: "900", history: [{ id: "110", messagesAdded: all }] }); };
  try {
    for (let run = 0; run < 4; run++) {
      const page = await listHistory(async () => "synthetic", start, { windowPages: 1, maxWindowMessages: 1000, continuation });
      assert.ok(page.ids.length <= 1000);
      seen.push(...page.ids);
      if (page.hasMore) assert.equal(page.historyId, "100", "marker stays before unfinished record");
      continuation = page.continuation;
      start = page.historyId;
      if (!page.hasMore) break;
    }
    assert.equal(calls, 3, "three bounded invocations reach and settle the oversized record");
    assert.equal(start, "900");
    assert.equal(seen.length, 2501);
    assert.equal(new Set(seen).size, 2501, "nothing lost or replayed logically");
  } finally { globalThis.fetch = original; }
});


test("GMAIL-02: 1.9 million synthetic families use bounded indexed requests through the runner", async () => fixture(async f => {
  const db = new DatabaseSync(":memory:");
  const queries = [];
  const prepare = (sql, params = []) => ({ bind: (...values) => prepare(sql, values),
    all: async () => { queries.push({ sql, params }); return { results: db.prepare(sql).all(...params) }; } });
  try {
    // Use shipped DDL, including WITHOUT ROWID, partial indexes and triggers.
    for (const migration of ["0003_sources", "0004_corpus", "0006_freshness", "0059_document_family_index"]) {
      db.exec(readFileSync(new URL(`../migrations/d1/${migration}.sql`, import.meta.url), "utf8"));
    }
    // Populate only the derived table: referential enforcement is unrelated to
    // its lookup plan, and a second 1.9-million-document corpus adds no evidence.
    db.exec(`PRAGMA foreign_keys=OFF;
      UPDATE document_family_index_state SET complete=1;
      WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1899999)
      INSERT INTO document_family_index SELECT 'gmail:bulk-'||x,'gmail:bulk-'||x,NULL,1 FROM n;`);
    const shape = db.prepare("SELECT sql FROM sqlite_master WHERE name='document_family_index'").get().sql;
    assert.match(shape, /WITHOUT ROWID/i, "R3 GMAIL-08: fixture uses shipped table shape");
    const indexShape = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_document_family_live'").get().sql;
    assert.match(indexShape, /WHERE live=1/i, "R3 GMAIL-08: fixture uses shipped partial index");
    f.ids = Array.from({ length: 101 }, (_, i) => `bulk-${i}`);
    f.inventory = args => listStoredSourceFamilies(args);
    let requests = 0;
    f.providerFetch = async (url, options) => {
      assert.equal(new URL(url).pathname, "/api/admin/brain/source-families");
      const body = JSON.parse(options.body); requests++;
      assert.ok(body.require_index && body.uids.length <= 97, "actual client emits only bounded indexed reads");
      return json({ source: body.source, ...await listSourceFamilies({ DB: { prepare } }, {
        source: body.source, uids: body.uids, limit: body.limit, requireIndexed: body.require_index }) });
    };
    const run = await f.once();
    assert.equal(run.error, null);
    assert.equal(requests, 2, "request count is independent of 1.9 million stored families");
    assert.equal(f.reads.length, 101, "actual ingest decisions reached for every bounded identity");
    const inventory = queries.filter(q => /FROM document_family_index\b/.test(q.sql));
    assert.equal(inventory.length, 2);
    for (const q of inventory) {
      const plan = db.prepare("EXPLAIN QUERY PLAN " + q.sql).all(...q.params).map(row => row.detail);
      assert.ok(plan.some(p => /SEARCH document_family_index.*idx_document_family_live/.test(p)), JSON.stringify(plan));
      assert.ok(plan.some(p => /family_doc_uid=\?/.test(p)), "each identity must use an equality seek: " + JSON.stringify(plan));
      assert.ok(plan.every(p => !/SCAN (documents|document_family_index)/.test(p)), JSON.stringify(plan));
    }
    const positive = queries.length;
    db.exec("UPDATE document_family_index_state SET complete=0");
    await assert.rejects(listSourceFamilies({ DB: { prepare } }, { source: "gmail", uids: ["gmail:bulk-0"], requireIndexed: true }), /index is not ready/);
    assert.equal(queries.length, positive + 1, "readiness decision reached without a document query or fallback");
    console.log(JSON.stringify({ probe: "bounded-runner-scale", families: 1900000, requests, identities: f.reads.length }));
  } finally { db.close(); }
}));

test("GMAIL-02: an old Worker cannot widen a bounded identity request", async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return json({ error: "unknown field" }, 400); };
  try {
    await assert.rejects(listStoredSourceFamilies({ base: "https://fixture.invalid", adminKey: "fixture", source: "gmail",
      uids: ["gmail:entry"], requireIndexed: true }), /no compatibility scan/);
    assert.equal(calls.length, 1, "capability decision reached once");
    assert.deepEqual(calls[0].uids, ["gmail:entry"]);
    globalThis.fetch = async () => json({ source: "gmail", families: ["gmail:entry"], next_cursor: null, indexed: true });
    assert.deepEqual([...await listStoredSourceFamilies({ base: "https://fixture.invalid", adminKey: "fixture", source: "gmail",
      uids: ["gmail:entry"], requireIndexed: true })], ["gmail:entry"], "matching Worker control");
  } finally { globalThis.fetch = original; }
});

test("GMAIL-03: oversized history survives interruption through the real runner without losing accepted mail", async () => fixture(async f => {
  const identities = Array.from({ length: 2501 }, (_, i) => ({ message: { id: `oversized-${String(i).padStart(4, "0")}` } }));
  f.setState({ ...f.state(), history_id: "100" });
  f.history = (_token, start, options) => listHistory(async () => "fixture", start, options);
  f.providerFetch = async url => {
    assert.ok(new URL(url).pathname.endsWith("/history"), "no full-mailbox fallback");
    return json({ historyId: "900", history: [{ id: "110", messagesAdded: identities }] });
  };
  const first = await f.once();
  assert.equal(first.error, null);
  assert.equal(first.state.history_id, "100");
  assert.equal(first.state.gmail_history_continuation.offset, 1000);
  f.failBatch = f.calls.length + 51;
  const interrupted = await f.once();
  assert.ok(interrupted.error && f.stored.size === 1050, "interruption after a successful bounded prefix");
  assert.equal(interrupted.state.history_id, "100");
  assert.equal(interrupted.state.gmail_history_continuation.offset, 1000);
  f.failBatch = 0; f.reads.length = 0;
  const resumed = await f.once();
  assert.equal(resumed.error, null);
  assert.equal(f.reads.length, 950, "accepted bodies were not replayed");
  assert.equal(resumed.state.gmail_history_continuation.offset, 2000);
  const last = await f.once();
  assert.equal(last.error, null);
  assert.equal(last.state.history_id, "900");
  assert.equal(f.stored.size, 2501);
  assert.equal(f.forgotten, 0, "all original and accepted documents preserved");
}));


test("GMAIL-05: a deadline inside a window preserves its unsent suffix and resumes accepted bodies once", async () => fixture(async f => {
  f.ids = Array.from({ length: 101 }, (_, i) => `deadline-${i}`);
  let time = 0;
  f.options = { ingestDeadlineAt: 1, ingestNowMs: () => time };
  const respond = f.respond;
  f.respond = docs => { const result = respond(docs); time = 1; return result; };
  const first = await f.once();
  assert.equal(first.error, null);
  assert.equal(f.stored.size, 1, "deadline follows one accepted logical message");
  assert.equal(first.state.gmail_batch_window.remaining_ids.length, 100);
  assert.equal(first.state.history_id, "prior");
  assert.equal(first.result.more_history, true);
  assert.equal(first.receipt.walk_complete, false);
  f.options = {}; f.respond = respond; f.reads.length = 0;
  const resumed = await f.once();
  assert.equal(resumed.error, null);
  assert.equal(f.reads.length, 100);
  assert.equal(f.stored.size, 101);
  assert.equal(resumed.state.history_id, "next");
  assert.equal(f.forgotten, 0);
}));


test("GMAIL-01/05: daily resumes a real multi-window backlog while preserving pending owner removals", async t => {
  const anchor = Date.parse("2026-01-01T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: anchor });
  const product = await createProductFixture();
  t.after(() => product.close());
  await fixture(async f => {
    let elapsed = 0; let calls = 0;
    f.options = { ingestNowMs: () => anchor + elapsed };
    f.setState({ ...f.state(), history_id: "100" });
    f.stored.add("gmail:deleted-control");
    const changes = Array.from({ length: 2100 }, (_, i) => ({ message: { id: `daily-${String(i).padStart(4, "0")}` } }));
    f.history = (_token, start, options) => listHistory(async () => "fixture", start, options);
    f.providerFetch = async url => {
      assert.ok(new URL(url).pathname.endsWith("/history"));
      return json({ historyId: "900", history: [{ id: "110", messagesAdded: changes,
        messagesDeleted: [{ message: { id: "deleted-control" } }] }] });
    };
    const plan = { ready: true, enabled: true, identity: { id: "fixture-daily" }, max_runtime_minutes: 1,
      sources: [{ key: "gmail", run_key: "gmail", source_names: ["gmail"], class: "machine-pull", owner: "daily-task", status: "ready" }] };
    const daily = () => runDailyRefresh({ plan, now: () => new Date(anchor + elapsed),
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async (_source, lease) => {
        calls++;
        const offset = f.receipts.length;
        const run = await f.once({ only: "gmail" }, { allowPartialRefresh: true,
          deferGmailRemovals: true, ingestDeadlineAt: lease.deadlineAt });
        assert.equal(run.error, null);
        for (const receipt of f.receipts.slice(offset)) {
          const response = await product.post("/api/admin/brain/source-receipt", receipt, { "X-Admin-Key": product.env.ADMIN_KEY });
          assert.equal(response.status, 200, "the Worker accepts the measured run receipt");
        }
        elapsed += 40000;
        t.mock.timers.tick(40000);
        return run.result;
      },
      // A permanent stale timestamp cannot prove freshness now that owner
      // decisions no longer short-circuit daily's mandatory receipt checks.
      readFreshness: async () => {
        const inventory = await sourceInventory(product.env, { now: anchor + elapsed });
        return Object.fromEntries(inventory.rows.map(row => [row.name, { ...row.receipt, kind: row.kind }]));
      },
      writeReceipt() {},
    });
    const first = await daily();
    assert.equal(first.sources[0].status, "deferred");
    assert.equal(calls, 2);
    assert.equal(f.stored.size, 2001);
    assert.equal(f.state().history_id, "100");
    const second = await daily();
    assert.equal(calls, 3, "the next daily invocation resumes only the last window");
    assert.equal(second.status, "complete");
    assert.equal(second.sources[0].status, "complete");
    assert.equal(second.sources[0].freshness_advanced, true);
    assert.equal(second.sources[0].check_verified, true);
    assert.ok(second.sources[0].pending_removals > 0, "daily reports the retained decision");
    assert.equal(f.stored.size, 2101);
    assert.equal(f.stored.has("gmail:deleted-control"), true);
    assert.equal(f.state().gmail_owner_removals["gmail:deleted-control"], "explicit_deletion");
    assert.equal(f.state().history_id, "900", "durable owner decision preserves deletion evidence across marker advancement");
    assert.equal(new Set(f.reads).size, 2100);
    assert.equal(f.reads.length, 2100, "accepted bodies not replayed across daily budgets");
    assert.equal(f.previews, 0, "daily leaves optional removal previews for direct review");
    assert.equal(f.forgotten, 0);
  });
});


test("GMAIL-02: Worker validates the strict indexed capability and never falls back before readiness", async () => {
  const db = new DatabaseSync(":memory:");
  let reads = 0;
  const prepare = (sql, params = []) => ({ bind: (...values) => prepare(sql, values),
    all: async () => { reads++; return { results: db.prepare(sql).all(...params) }; } });
  const env = { STORAGE: "d1", ADMIN_KEY: ["fixture", "owner"].join("-"), DB: { prepare } };
  const request = requireIndex => new Request("https://fixture.invalid/api/admin/brain/source-families", {
    method: "POST", headers: { "X-Admin-Key": env.ADMIN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "gmail", uids: ["gmail:entry"], require_index: requireIndex }),
  });
  try {
    db.exec(`CREATE TABLE document_family_index_state(id INTEGER PRIMARY KEY,cursor TEXT,complete INTEGER);
      INSERT INTO document_family_index_state VALUES(1,NULL,0);
      CREATE TABLE document_family_index(doc_uid TEXT PRIMARY KEY,family_doc_uid TEXT,live INTEGER);
      CREATE INDEX idx_document_family_live ON document_family_index(live,family_doc_uid,doc_uid);
      INSERT INTO document_family_index VALUES('gmail:entry','gmail:entry',1);`);
    const held = await worker.fetch(request(true), env, {});
    assert.equal(held.status, 409);
    assert.equal((await held.json()).code, "family_index_not_ready");
    assert.equal(reads, 1, "readiness decision reached; no documents table even exists to scan");
    const invalid = await worker.fetch(request("true"), env, {});
    assert.equal(invalid.status, 400);
    assert.equal(reads, 1, "invalid capability rejected before SQL");
    db.exec("UPDATE document_family_index_state SET complete=1");
    const ready = await worker.fetch(request(true), env, {});
    assert.equal(ready.status, 200);
    const body = await ready.json();
    assert.equal(body.indexed, true);
    assert.deepEqual(body.families, ["gmail:entry"]);
  } finally { db.close(); }
});


test("GMAIL-04: completed scanner safety pages wait for owner decisions without restarting a mirror", async () => fixture(async f => {
  f.setState({ ...f.state(), credential_scanner_fingerprint: "old" });
  f.ids = ["current-control"];
  f.stored.add("gmail:prior-review");
  f.policy = id => id === "prior-review" ? { allowed: false, policy_skip: true,
    removal_cause: "scope_or_filter_change", skip: { reason: "synthetic policy exclusion" } } : { allowed: true };
  const first = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
  assert.equal(first.error, null);
  assert.equal(first.state.gmail_recovery.stage, "stored");
  const safety = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
  assert.equal(safety.error, null);
  assert.equal(safety.state.gmail_recovery.awaiting_owner, true);
  assert.ok(safety.state.gmail_owner_removals["gmail:prior-review"]);
  const pages = f.listPages;
  f.ids = [];
  const next = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
  assert.equal(next.error, null);
  assert.equal(f.listPages, pages, "pending owner decision never restarts mailbox pagination");
  assert.ok(f.historyReads > 0, "new history is still serviced");
  assert.equal(next.state.credential_scanner_fingerprint, "old", "incomplete scanner evidence cannot become current");
  assert.ok(f.stored.has("gmail:prior-review"));
  assert.ok(f.stored.has("gmail:current-control"), "new accepted mail is a positive control");
  assert.equal(f.forgotten, 0);
}));


test("GMAIL-03: new arrivals cannot invalidate an oversized page suffix or be skipped by its marker", async () => {
  const original = globalThis.fetch;
  let calls = 0; let start = "100"; let continuation = null;
  const seen = [];
  const originalMail = Array.from({ length: 2501 }, (_, i) => ({ message: { id: `growing-${i}` } }));
  globalThis.fetch = async url => {
    calls++;
    if (new URL(url).searchParams.get("startHistoryId") === "900") return json({ historyId: "999",
      history: [{ id: "920", messagesAdded: [{ message: { id: "new-arrival" } }] }] });
    return json({ historyId: calls === 1 ? "900" : "999", history: [
      { id: "110", messagesAdded: originalMail },
      ...(calls > 1 ? [{ id: "920", messagesAdded: [{ message: { id: "new-arrival" } }] }] : []),
    ] });
  };
  try {
    for (let run = 0; run < 4; run++) {
      const page = await listHistory(async () => "fixture", start, { windowPages: 1, maxWindowMessages: 1000, continuation });
      seen.push(...page.ids); start = page.historyId; continuation = page.continuation;
      if (run < 2) assert.equal(start, "100");
      if (run === 2) {
        assert.equal(start, "900", "new terminal marker cannot pass an unconsumed appended record");
        assert.equal(page.hasMore, true, "observed new arrivals keep coverage incomplete");
      }
    }
    assert.equal(start, "999");
    assert.equal(new Set(seen).size, 2502);
    assert.equal(seen.length, 2502);
    assert.equal(seen.at(-1), "new-arrival");
    assert.equal(calls, 4, "unchanged bound makes lossless forward progress under new arrivals");
  } finally { globalThis.fetch = original; }
});


test("GMAIL-04: a scanner refusal cannot certify retained old mail while daily awaits its owner decision", async () => fixture(async f => {
  f.setState({ ...f.state(), credential_scanner_fingerprint: "old", done: { "gmail:prior-sensitive": "prior" } });
  f.ids = ["prior-sensitive", "clean-control"];
  f.stored.add("gmail:prior-sensitive");
  f.content = id => id === "prior-sensitive"
    ? `Invented scanner fixture. admin_key: ${["sk", "proj", "A7".repeat(16)].join("-")}`
    : "Ordinary invented mail retained as the accepted positive control.";
  const first = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
  assert.equal(first.error, null);
  assert.equal(first.state.gmail_owner_removals["gmail:prior-sensitive"], "blank_or_quality");
  assert.ok(f.stored.has("gmail:clean-control"), "the accepting decision also reached storage");
  const safety = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
  assert.equal(safety.error, null);
  assert.equal(safety.state.credential_scanner_fingerprint, "old", "retained prior bytes remain uncertified");
  assert.equal(safety.state.gmail_recovery.awaiting_owner, true);
  assert.equal(safety.receipt.status, "error");
  assert.ok(f.stored.has("gmail:prior-sensitive"));
  assert.equal(f.forgotten, 0);
}));


test("GMAIL-01: daily retains split-family reviews and direct previews clear only zero-target decisions", async () => {
  for (const stale of [false, true]) await fixture(async f => {
    f.ids = ["multipart"]; f.content = "Ordinary synthetic correspondence. ".repeat(35000);
    f.previewTargets = stale ? ["gmail:multipart#part1of99"] : [];
    const result = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
    assert.equal(result.error, null);
    assert.ok(f.calls.flat().length > 1, "actual split storage reached");
    assert.equal(f.previews, 0, "completed split storage reaches the daily deferral decision without a preview");
    assert.equal(result.result.pending_removals, 1, "the saved split review stays visible before it is read");
    assert.ok(result.state.ingest_pending_families["gmail:multipart"].family.keep_doc_uids.length > 1);
    assert.equal(result.state.ingest_removal_plan, undefined);
    assert.equal(result.state.history_id, "next");
    assert.equal(result.receipt.status, "ready");
    assert.equal(result.receipt.complete_sweep, false);
    f.ids = [];
    const reviewed = await f.once();
    assert.equal(reviewed.error, null);
    assert.ok(f.previews > 0, "direct ingest reaches the exact read-only family decision");
    if (stale) {
      assert.deepEqual(reviewed.state.ingest_removal_plan.targets, f.previewTargets);
      assert.ok(reviewed.state.ingest_pending_families["gmail:multipart"]);
    } else {
      assert.equal(reviewed.state.ingest_removal_plan, undefined, "zero-target green control clears itself");
      assert.equal(reviewed.state.ingest_pending_families, undefined);
    }
    assert.equal(f.forgotten, 0);
  });
});


// Round 3 probes run through the same offline daily/load/ingest and store seams.
test("R3 GMAIL-04: interrupted bootstrap survives a policy change", async () => fixture(async f => {
  const initial = f.state(); delete initial.history_id; f.setState(initial);
  f.ids = Array.from({ length: 101 }, (_, i) => `policy-${i}`);
  // Per-message dispatch retains the original 50-message accepted prefix.
  f.failBatch = 51;
  const first = await f.once();
  assert.ok(first.error && f.stored.size === 50, "interrupted bootstrap decision reached after accepting a prefix");
  assert.equal(first.state.gmail_batch_window.mode, "bootstrap");
  f.setSince("2025-01-01"); f.failBatch = 0;
  const next = await f.once();
  assert.equal(next.error, null);
  assert.equal(f.profileReads, 2, "changed policy captures a fresh recovery anchor");
  assert.equal(f.stored.size, 101);
  assert.equal(f.forgotten, 0);
  const pages = f.listPages;
  const control = await f.once();
  assert.equal(control.error, null);
  assert.equal(f.listPages, pages, "unchanged recovery continues its stored stage");
}));

test("R3 GMAIL-04: expiry replaces completed recovery while retaining owner decisions", async () => fixture(async f => {
  f.setState({ ...f.state(), credential_scanner_fingerprint: "old" });
  f.ids = ["clean-control"]; f.stored.add("gmail:prior-review");
  f.policy = id => id === "prior-review" ? { allowed: false, policy_skip: true,
    removal_cause: "scope_or_filter_change", skip: { reason: "synthetic exclusion" } } : { allowed: true };
  const run = () => f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true });
  assert.equal((await run()).error, null); assert.equal((await run()).error, null);
  assert.equal(f.state().gmail_recovery.complete, true, "retained completed recovery reached");
  const oldAnchor = f.state().gmail_recovery.anchor_history_id;
  f.history = () => ({ expired: true, ids: [], deletedIds: [] });
  f.marker = "new-anchor"; f.ids = ["new-control"];
  const next = await run();
  assert.equal(next.error, null);
  assert.notEqual(next.state.gmail_recovery.anchor_history_id, oldAnchor);
  assert.equal(next.state.gmail_recovery.anchor_history_id, "new-anchor");
  assert.ok(f.stored.has("gmail:new-control"), "new mailbox work accepted");
  assert.ok(next.state.gmail_owner_removals["gmail:prior-review"]);
  assert.equal(f.forgotten, 0);
}));

for (const arm of ["policy", "unchanged", "skipped"]) test(`R3 GMAIL-05: ${arm} deadline stops new reads and resumes`, async () => fixture(async f => {
  const anchor = Date.parse("2026-01-01T12:00:00.000Z"); let elapsed = 0;
  f.ids = Array.from({ length: 101 }, (_, i) => `budget-${i}`);
  f.options = { ingestNowMs: () => anchor + elapsed };
  if (arm === "policy") f.policy = () => { elapsed += 10000; return { allowed: true }; };
  else {
    if (arm === "unchanged") {
      const state = f.state(); for (const id of f.ids) { state.done[`gmail:${id}`] = "revision"; f.stored.add(`gmail:${id}`); } f.setState(state);
    } else f.policy = () => ({ allowed: false, policy_skip: true, removal_cause: "scope_or_filter_change", skip: { reason: "synthetic policy" } });
    f.onEnvelope = () => { elapsed += 10000; };
    if (arm === "skipped") { f.policy = () => ({ allowed: true }); f.customEnvelope = () => ({ policy_skip: true, removal_cause: "scope_or_filter_change", skip: { reason: "synthetic policy" } }); }
  }
  const plan = { ready: true, enabled: true, identity: { id: "fixture-budget" }, max_runtime_minutes: 1,
    sources: [{ key: "gmail", run_key: "gmail", source_names: ["gmail"], class: "machine-pull", owner: "daily-task", status: "ready" }] };
  const first = await runDailyRefresh({ plan, now: () => new Date(anchor + elapsed),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async (_source, lease) => {
      const result = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true, ingestDeadlineAt: lease.deadlineAt });
      assert.equal(result.error, null); return result.result;
    }, readFreshness: async () => ({}), writeReceipt() {},
  });
  assert.ok(elapsed >= 60000, "deadline decision reached in actual provider work");
  assert.equal(first.sources[0].status, "deferred");
  const started = arm === "policy" ? f.policyReads.length : f.reads.length;
  assert.ok(started < 101, "no further provider reads after budget exhaustion");
  assert.equal(f.state().history_id, "prior");
  assert.ok(f.state().gmail_batch_window.remaining_ids.length > 0);
  const settledSkips = arm === "skipped" ? 101 - f.state().gmail_batch_window.remaining_ids.length : 0;
  if (arm === "skipped") assert.ok(settledSkips > 0, "skip decision checkpoint reached before deferral");
  f.options = {}; f.policy = () => ({ allowed: true }); f.onEnvelope = null; f.customEnvelope = null;
  const resumed = await f.once();
  assert.equal(resumed.error, null); assert.equal(resumed.state.history_id, "next");
  assert.equal(f.stored.size, 101 - settledSkips, "short successful continuation accepts the unresolved suffix");
  assert.equal(f.forgotten, 0);
}));

test("R3 GMAIL-07: daily restart reaches healthy retry suffix behind 100 failures", async () => fixture(async f => {
  const retryIds = Array.from({ length: 101 }, (_, i) => `held-${String(i).padStart(3, "0")}`);
  f.ids = [];
  f.setState({ ...f.state(), gmail_retry: Object.fromEntries(retryIds.map(id => [`gmail:${id}`, true])) });
  const accepted = f.respond;
  f.respond = docs => {
    const good = docs.filter(d => d.source_id === retryIds[100]); if (good.length) accepted(good);
    return json({ results: docs.map(d => ({ source_id: d.source_id,
      status: d.source_id === retryIds[100] ? "created" : "failed", error: "synthetic retryable failure" })) });
  };
  const anchor = Date.parse("2026-01-01T12:00:00.000Z"); let elapsed = 0; let lastRun;
  f.options = { ingestNowMs: () => anchor + elapsed };
  const plan = { ready: true, enabled: true, identity: { id: "fixture-retries" }, max_runtime_minutes: 1,
    sources: [{ key: "gmail", run_key: "gmail", source_names: ["gmail"], class: "machine-pull", owner: "daily-task", status: "ready" }] };
  const daily = () => runDailyRefresh({ plan, now: () => new Date(anchor + elapsed),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async (_source, lease) => {
      lastRun = await f.once({ only: "gmail" }, { allowPartialRefresh: true, deferGmailRemovals: true, ingestDeadlineAt: lease.deadlineAt });
      assert.equal(lastRun.error, null); elapsed += 60000; return lastRun.result;
    }, readFreshness: async () => ({}), writeReceipt() {},
  });
  assert.equal((await daily()).sources[0].status, "deferred");
  const first = lastRun;
  assert.equal(first.error, null);
  assert.equal(f.reads.length, 100, "failing prefix reached actual sender");
  assert.equal(first.result.more_history, true, "unvisited retry suffix contributes continuation");
  assert.equal((await daily()).sources[0].status, "deferred");
  const second = lastRun;
  assert.equal(second.error, null);
  assert.ok(f.stored.has(`gmail:${retryIds[100]}`), "healthy suffix accepted after restart");
  assert.equal(Object.keys(second.state.gmail_retry).length, 100, "failed identities remain recoverable");
  assert.equal(f.forgotten, 0);
}));

test("R3 GMAIL-03: founder-scale history body is bounded before parsing", async () => {
  const metrics = [];
  for (const total of [19000, 1900000]) {
    let produced = 0; let cancelled = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        if (produced === 0) controller.enqueue(new TextEncoder().encode('{"historyId":"900","history":[{"id":"110","messagesAdded":['));
        if (produced < total) {
          const count = Math.min(256, total - produced);
          const chunk = Array.from({ length: count }, (_, i) => `${produced + i ? "," : ""}{"message":{"id":"scale-${produced+i}"}}`).join("");
          produced += count; controller.enqueue(new TextEncoder().encode(chunk));
        } else { controller.enqueue(new TextEncoder().encode(']}]}')); controller.close(); }
      }, cancel() { cancelled++; },
    }));
    try {
      const page = await listHistory(async () => "fixture", "100", { windowPages: 1, maxWindowMessages: 1000 });
      assert.equal(page.expired, true, "oversized transport enters resumable paginated recovery");
      assert.equal(page.recovery_reason, "oversized_history");
      assert.equal(cancelled, 1, "body byte decision reached and stops transport");
      assert.ok(produced < 10000 && produced < total, "work is independent of founder-scale action count");
      metrics.push({ total_actions: total, produced_actions: produced, cancelled, body_limit_bytes: 256 * 1024 });
    } finally { globalThis.fetch = original; }
  }
  assert.equal(metrics[0].produced_actions, metrics[1].produced_actions, "100x input growth adds no transport expansion work");
  console.log(JSON.stringify({ probe: "history-transport-scale", metrics }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => json({ historyId: "900", history: [{ id: "110", messagesAdded: [{ message: { id: "small-control" } }] }] });
  try { assert.deepEqual((await listHistory(async () => "fixture", "100", { windowPages: 1 })).ids, ["small-control"]); }
  finally { globalThis.fetch = original; }
});


test("R3 founder-scale daily recovery is bounded at 1.9 million identities and resumes", async () => fixture(async f => {
  f.captureSaves = false;
  const total = 1900000; let pages = 0; const pageTokens = [];
  const state = f.state(); delete state.history_id; f.setState(state);
  f.messagePage = (_token, opts) => {
    const offset = Number(opts.pageToken || 0); pages++; pageTokens.push(offset);
    return { ids: Array.from({ length: Math.min(500, total-offset) }, (_, i) => `mailbox-${offset+i}`),
      nextPageToken: offset+500 < total ? String(offset+500) : null };
  };
  f.customEnvelope = () => ({ policy_skip: true, cursor_blocking: false,
    removal_cause: "scope_or_filter_change", skip: { reason: "synthetic current policy" } });
  const anchor = Date.parse("2026-01-01T12:00:00.000Z");
  const plan = { ready: true, enabled: true, identity: { id: "fixture-scale" }, max_runtime_minutes: 1,
    sources: [{ key: "gmail", run_key: "gmail", source_names: ["gmail"], class: "machine-pull", owner: "daily-task", status: "ready" }] };
  const daily = () => runDailyRefresh({ plan, now: () => new Date(anchor),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async (_source, lease) => {
      const run = await f.once({ only: "gmail" }, { allowPartialRefresh: true,
        deferGmailRemovals: true, ingestDeadlineAt: lease.deadlineAt });
      assert.equal(run.error, null); return run.result;
    }, readFreshness: async () => ({}), writeReceipt() {},
  });
  f.options = { ingestNowMs: () => anchor };
  const first = await daily();
  assert.equal(pages, 32, "actual daily hard window budget reached");
  assert.equal(f.reads.length, 16000, "only bounded provider work despite founder-scale mailbox");
  assert.equal(first.sources[0].status, "deferred");
  assert.equal(f.state().gmail_recovery.page_token, "16000");
  assert.equal(f.state().history_id, undefined);
  const second = await daily();
  assert.equal(pages, 64); assert.equal(pageTokens[32], 16000, "restart resumes saved mailbox suffix");
  assert.equal(second.sources[0].status, "deferred");
  assert.equal(f.profileReads, 1, "recovery anchor not restarted");
  assert.equal(new Set(f.reads).size, f.reads.length, "processed prefix is not replayed");
  assert.equal(f.forgotten, 0);
  assert.ok(f.inventoryCalls.every(call => call.uids?.length <= 97), "no full-table stored inventory");
}));


test("R3 GMAIL-05: real provider retry budget stops at the daily deadline", async () => {
  let time = 0; let reads = 0; let tokens = 0; const waits = [];
  await assert.rejects(googleApi(async () => { tokens++; return "fixture"; }, "https://fixture.invalid/read", {
    now: () => time, deadlineAt: 10, requestTimeoutMs: 60000,
    fetchImpl: async (_url, opts) => {
      reads++; assert.ok(opts.signal, "remaining request time is propagated as an abort signal");
      time = 10; throw new Error("synthetic provider timeout");
    }, sleep: async ms => { waits.push(ms); time += ms; },
  }), error => error.reason === "requestDeadline");
  assert.equal(reads, 1, "actual provider timeout decision reached");
  assert.equal(tokens, 1); assert.deepEqual(waits, [], "no backoff or retry starts after budget");
  time = 0;
  const good = await googleApi(async () => "fixture", "https://fixture.invalid/read", {
    now: () => time, deadlineAt: 10, fetchImpl: async () => json({ accepted: true }),
  });
  assert.equal(good.accepted, true);
});


test("R3 GMAIL-03: oversized transport recovers through runner interruption without repeating history", async () => fixture(async f => {
  let transportReads = 0;
  f.setState({ ...f.state(), history_id: "100" });
  f.history = (_token, start, opts) => listHistory(async () => "fixture", start, opts);
  f.providerFetch = async () => {
    transportReads++;
    return new Response(new ReadableStream({ pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    } }));
  };
  f.messagePage = (_token, opts) => {
    const offset = Number(opts.pageToken || 0);
    return { ids: Array.from({ length: offset === 0 ? 500 : 1 }, (_, i) => `fallback-${offset+i}`),
      nextPageToken: offset === 0 ? "500" : null };
  };
  f.marker = "900"; // Per-message dispatch retains the original 50-message accepted prefix.
  f.failBatch = 51;
  const first = await f.once();
  assert.ok(first.error && f.stored.size === 50, "bounded fallback reached a successful batch then interruption");
  assert.equal(transportReads, 1); assert.equal(first.state.history_id, "100");
  f.failBatch = 0; f.reads.length = 0;
  const resumed = await f.once();
  assert.equal(resumed.error, null); assert.equal(f.reads.length, 450);
  assert.equal(transportReads, 1, "saved recovery never refetches or expands oversized history");
  assert.equal((await f.once()).error, null);
  assert.equal((await f.once()).error, null);
  assert.equal(f.stored.size, 501); assert.equal(f.state().history_id, "900");
  assert.equal(f.forgotten, 0);
}));


test("R3 GMAIL-05: checkpointed slow skips retain pending owner decisions on restart", async () => fixture(async f => {
  f.ids = Array.from({ length: 101 }, (_, i) => `retain-${i}`);
  for (const id of f.ids) f.stored.add(`gmail:${id}`);
  let time = 0; f.options = { ingestDeadlineAt: 60000, ingestNowMs: () => time };
  f.onEnvelope = () => { time += 10000; };
  f.customEnvelope = () => ({ policy_skip: true, cursor_blocking: false,
    removal_cause: "scope_or_filter_change", skip: { reason: "synthetic exclusion" } });
  const run = () => f.once({ only: "gmail" }, { allowPartialRefresh: true, deferGmailRemovals: true });
  const first = await run();
  assert.equal(first.error, null);
  const decisions = Object.keys(first.state.gmail_owner_removals);
  assert.ok(decisions.length > 0 && decisions.length < 101, "resolved skip prefix and budget decision reached");
  f.options = {}; f.onEnvelope = null;
  const resumed = await run();
  assert.equal(resumed.error, null);
  assert.equal(Object.keys(resumed.state.gmail_owner_removals).length, 101, "settled skips cannot masquerade as accepted replacements");
  f.ids = ["accepted-control"]; f.customEnvelope = null;
  const next = await run();
  assert.equal(next.error, null); assert.ok(f.stored.has("gmail:accepted-control"));
  assert.equal(Object.keys(next.state.gmail_owner_removals).length, 101);
  assert.equal(f.stored.size, 102); assert.equal(f.forgotten, 0);
}));


test("R3 GMAIL-05: token refresh also inherits the remaining read budget", async () => {
  const original = AbortSignal.timeout; const limits = []; let time = 0; let requests = 0;
  AbortSignal.timeout = ms => { limits.push(ms); return AbortSignal.abort(); };
  try {
    const token = createTokenProvider({ clientId: "fixture", refreshToken: ["fixture", "refresh"].join("-"),
      fetchImpl: async () => { requests++; time = 10; throw Object.assign(new Error("synthetic deadline"), { name: "AbortError" }); } });
    await assert.rejects(googleApi(token, "https://fixture.invalid/read", { now: () => time, deadlineAt: 10,
      fetchImpl: async () => { throw new Error("message request must not start"); }, sleep: async () => {} }),
      error => error.reason === "requestDeadline");
    assert.equal(requests, 1, "token refresh decision reached");
    assert.deepEqual(limits, [10], "token request cannot keep its independent 30-second allowance");
  } finally { AbortSignal.timeout = original; }
});

test("R4 GMAIL-05: virtual founder-scale preflight is bounded independently of mailbox size", async () => {
  const metrics = [];
  for (const total of [19000, 1900000]) await fixture(async f => {
    const clock = { now: Date.parse("2026-01-01T12:00:00Z") }; let produced = 0;
    f.captureSaves = false;
    f.options = { ingestNowMs: () => clock.now };
    f.history = () => {
      const offset = f.state().history_id === "prior" ? 0 : Number(f.state().history_id);
      const end = Math.min(offset + 1000, total);
      const ids = Array.from({ length: end - offset }, (_, i) => `virtual-${offset + i}`);
      produced += ids.length;
      return { ids, deletedIds: [], historyId: String(end), hasMore: end < total };
    };
    f.inventory = ({ uids }) => { clock.now += 6000; return new Set(uids.filter(uid => f.stored.has(uid))); };
    await dailyFixture(f, clock);
    const first = f.stored.size;
    await dailyFixture(f, clock);
    assert.ok(f.inventoryCalls.length > 0 && clock.now >= Date.parse("2026-01-01T12:02:00Z"), "both daily deadline decisions reached");
    assert.ok(first > 0 && f.stored.size > first, "both invocations durably progress");
    assert.ok(produced <= 2000 && f.inventoryCalls.length <= 20, "virtual corpus is never expanded or scanned");
    assert.ok(f.inventoryCalls.every(call => call.requireIndexed && call.uids.length <= 97));
    assert.equal(f.forgotten, 0);
    metrics.push({ total, first, accepted: f.stored.size, produced, requests: f.inventoryCalls.length });
  });
  assert.deepEqual(metrics.map(({ total, ...work }) => work)[0], metrics.map(({ total, ...work }) => work)[1]);
  console.log(JSON.stringify({ probe: "bounded-inventory-preflight", metrics }));
  await fixture(async f => {
    f.ids = ["small-control"];
    const run = await f.once();
    assert.equal(run.error, null); assert.equal(run.result.complete, true);
    assert.equal(f.stored.size, 1, "small fast complete-window control differs from bounded large arms");
  });
});

for (const kind of ["auth", "transport", "item-permission"]) test(`R4 policy error scope: ${kind}`, async () => fixture(async f => {
  const error = Object.assign(new Error("synthetic scoped policy failure"), { name: "DriveError", operationClass: "gmail_policy_read",
    status: kind === "auth" ? 401 : kind === "transport" ? 503 : 403,
    providerStatus: kind === "auth" ? 401 : kind === "transport" ? 503 : 403,
    providerReason: kind === "item-permission" ? "insufficientFilePermissions" : null });
  f.ids = ["failing-item", "healthy-control"];
  f.policy = id => { if (id === "failing-item") throw error; return { allowed: true }; };
  const run = await f.once();
  assert.ok(f.policyReads.includes("failing-item"), "scoped error decision reached");
  if (kind === "item-permission") {
    assert.ok(f.stored.has("gmail:healthy-control"));
    assert.equal(run.state.gmail_retry["gmail:failing-item"], true);
    assert.equal(run.state.history_id, "next");
  } else {
    assert.ok(run.error); assert.equal(f.stored.size, 0);
    assert.equal(run.state.history_id, "prior");
    assert.equal(run.state.gmail_retry, undefined, "account outages cannot be diluted into per-item coverage");
  }
  assert.equal(f.forgotten, 0);
}));

test("R4 GMAIL-06: rollback fence closes every Worker vector writer including upgrade bootstrap", async () => {
  let reads = 0;
  const env = { STORAGE: "d1", ADMIN_KEY: ["fixture", "owner"].join("-"),
    VECTOR_DRAIN_MODE: "paused-for-upgrade", VECTOR_ROLLBACK_FENCE: "1",
    DB: { prepare() { reads++; throw new Error("unexpected writer database access"); } } };
  for (const path of ["bootstrap", "drain", "reindex", "ingest", "ingest/batch", "forget", "source-receipt"]) {
    const request = new Request(`https://fixture.invalid/api/admin/brain/${path}`, { method: "POST",
      headers: { "X-Admin-Key": env.ADMIN_KEY, "Content-Type": "application/json" }, body: "{}" });
    const response = await worker.fetch(request, env, {});
    assert.equal(response.status, 503, `${path} reached the rollback writer fence`);
    const body = await response.json();
    assert.equal(body.paused, true, `${path} returned the explicit pause decision`);
    if (path === "bootstrap") assert.equal(body.code, "corpus_writes_paused");
  }
  assert.equal(reads, 0);
  const health = await worker.fetch(new Request("https://fixture.invalid/health"), env, {});
  assert.equal((await health.json()).rollback_write_fence, true);
  delete env.VECTOR_ROLLBACK_FENCE;
  const control = await worker.fetch(new Request("https://fixture.invalid/health"), env, {});
  assert.equal((await control.json()).rollback_write_fence, false, "ordinary upgrade pause remains distinct");
});

test("R4 GMAIL-05: indexed client retry cannot spend beyond the shared deadline", async () => {
  const original = globalThis.fetch; const log = console.log; let calls = 0; let sleeps = 0;
  const origin = Date.parse("2026-01-01T12:00:00Z");
  globalThis.fetch = async () => { calls++; return json({ error: "D1_ERROR: D1 DB exceeded its CPU time limit and was reset." }, 500); };
  console.log = () => {};
  try {
    await assert.rejects(listStoredSourceFamilies({ base: "https://fixture.invalid", adminKey: ["fixture", "value"].join("-"),
      source: "gmail", uids: ["gmail:entry"], requireIndexed: true, deadlineAt: origin + 500, now: () => origin,
      sleep: async () => { sleeps++; } }), error => error.reason === "requestDeadline");
    assert.equal(calls, 1, "actual transient retry decision reached"); assert.equal(sleeps, 0);
    globalThis.fetch = async () => { calls++; return json({ source: "gmail", families: ["gmail:entry"], indexed: true, next_cursor: null }); };
    const control = await listStoredSourceFamilies({ base: "https://fixture.invalid", adminKey: ["fixture", "value"].join("-"),
      source: "gmail", uids: ["gmail:entry"], requireIndexed: true, deadlineAt: origin + 500, now: () => origin });
    assert.deepEqual([...control], ["gmail:entry"]);
  } finally { globalThis.fetch = original; console.log = log; }
});

test("R4 resolved Worker refusal cannot pin otherwise settled Gmail history", async () => fixture(async f => {
  f.ids = ["worker-refused", "healthy-control"];
  const accepted = f.respond;
  f.respond = docs => {
    accepted(docs.filter(doc => doc.source_id !== "worker-refused"));
    return json({ results: docs.map(doc => ({ source_id: doc.source_id,
      status: doc.source_id === "worker-refused" ? "refused" : "created", chunks: 1,
      reason: "synthetic credential policy" })) });
  };
  const run = await f.once();
  assert.ok(f.calls.flat().includes("worker-refused"), "actual Worker refusal decision reached");
  assert.ok(f.stored.has("gmail:healthy-control"));
  assert.equal(run.state.history_id, "next");
  assert.equal(run.state.gmail_batch_window, undefined);
  assert.equal(run.receipt.docs_refused, 1);
  assert.equal(run.receipt.complete_sweep, false);
  assert.equal(f.forgotten, 0);
}));
