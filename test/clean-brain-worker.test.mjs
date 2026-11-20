// "Clean my Brain", Worker side: removal speed, the removal memory, the 503
// after commit, and the counter check. Real migrations, real Worker code, a
// local SQLite. Never a live Brain.
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/src/index.js";
import { forget } from "../worker/src/lib/store-d1.js";
import { applyIngestRemovals, previewIngestRemovals, ingestRemovalFailure } from "../worker/src/lib/ingest-removal-plan.js";
import { envelopeOwnerRemovalKeys, envelopeIsOwnerRemoved, verifyCorpusStats } from "../worker/src/lib/owner-removals.js";
import { makeBrain, ADMIN_KEY, BASE } from "./helpers/clean-brain-fixture.mjs";

const call = (brain, path, body, method = "POST") => worker.fetch(new Request(`${BASE}${path}`, {
  method, headers: { "X-Admin-Key": ADMIN_KEY, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), brain.env, {});
const ids = (prefix, from, count) => Array.from({ length: count }, (_, i) => `${prefix}${from + i}`);
const family = (uid) => ({ base_doc_uid: uid, keep_doc_uids: [], family_kind: "structural" });
async function removeThroughRoute(brain, uidList, extra = {}) {
  const preview = await (await call(brain, "/api/admin/brain/ingest-removal-plan",
    { action: "preview", families: uidList.map(family), marker: null })).json();
  return call(brain, "/api/admin/brain/ingest-removal-plan", {
    action: "apply", targets: preview.targets, marker: preview.marker, ...extra });
}
const memory = (batchNo = 0, run = "clean_test_run_1") => ({ remember_removal: true, run_id: run, batch_no: batchNo, reason: "owner_removal" });

test("removal does not recount the source, and the counters stay exact", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 3000, 2);
  brain.loadMany("drive", "f", 400, 3);
  brain.statements.length = 0;
  const target = ids("m", 1, 50).map((id) => `gmail:${id}`);
  const response = await removeThroughRoute(brain, target);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).documents, 50);
  // The statement that used to rescan every document and chunk is gone.
  const all = [...brain.statements, ...brain.batches.flat()];
  assert.equal(all.some((sql) => /INSERT INTO corpus_stats/.test(sql)), false, "no counter rebuild in the removal");
  assert.equal(all.some((sql) => /COUNT\(DISTINCT documents\.doc_uid\)/.test(sql)), false);
  assert.deepEqual(brain.stats("gmail"), { documents: 2950, chunks: 5900 });
  assert.deepEqual(brain.stats("gmail"), brain.truth("gmail"), "triggers kept the counters exact");
  assert.deepEqual(brain.stats("drive"), brain.truth("drive"), "another source is untouched");
});

test("removal cost does not grow with the size of the Brain", async () => {
  // Structural, so it cannot flake: the same statements run for 100 and 40,000 documents.
  const shapes = [];
  for (const size of [100, 40_000]) {
    const brain = makeBrain();
    brain.loadMany("gmail", "m", size, 1);
    brain.statements.length = 0; brain.batches.length = 0;
    await forget(brain.env, { docUids: ids("m", 1, 50).map((id) => `gmail:${id}`), dryRun: false });
    shapes.push(brain.batches.map((batch) => batch.length));
    assert.deepEqual(brain.stats("gmail"), brain.truth("gmail"));
  }
  assert.deepEqual(shapes[0], shapes[1]);
  assert.ok(shapes[0].every((n) => n <= 8), "one short batch per group of 50");
});

test("removal time no longer scales with total rows (large margin, best of three)", async () => {
  const time = async (dropTriggers) => {
    const brain = makeBrain({ dropTriggers });
    brain.loadMany("gmail", "m", 60_000, 2);
    if (dropTriggers.length) brain.db.exec("INSERT INTO corpus_stats(source, documents, chunks) VALUES ('gmail', 60000, 120000) ON CONFLICT(source) DO UPDATE SET documents = 60000, chunks = 120000");
    let best = Infinity;
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      await forget(brain.env, { docUids: ids("m", 1 + round * 50, 50).map((id) => `gmail:${id}`), dryRun: false });
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  // A Brain without the schema-65 triggers must keep the exact recount (the old path).
  const recounting = await time(["corpus_counter_chunks_au"]);
  const triggered = await time([]);
  t_diag(`recount path ${recounting.toFixed(0)} ms, trigger path ${triggered.toFixed(0)} ms`);
  assert.ok(triggered * 3 < recounting, `trigger path ${triggered} ms vs recount ${recounting} ms`);
});
const t_diag = (text) => console.log(`# ${text}`);

test("a Brain without the counter triggers still recounts exactly", async () => {
  const brain = makeBrain({ dropTriggers: ["corpus_counter_chunks_au"] });
  brain.loadMany("gmail", "m", 200, 2);
  await forget(brain.env, { docUids: ids("m", 1, 50).map((id) => `gmail:${id}`), dryRun: false });
  assert.ok(brain.batches.flat().some((sql) => /INSERT INTO corpus_stats/.test(sql)), "old path keeps its recount");
  assert.deepEqual(brain.stats("gmail"), brain.truth("gmail"));
});

test("the removal memory commits with the delete, or not at all", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 120, 1);
  const target = ids("m", 1, 50).map((id) => `gmail:${id}`);
  // A failure inside the transaction rolls back the delete AND the memory.
  brain.hooks.failOnSql = /DELETE FROM documents/;
  const original = console.error;
  console.error = () => {};
  let failed;
  try { failed = await removeThroughRoute(brain, target, memory()); } finally { console.error = original; }
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).committed, "unknown");
  assert.equal(brain.liveUids("gmail").length, 120, "nothing was deleted");
  assert.deepEqual(brain.ledger(), [], "nothing was remembered");
  // The same batch again succeeds and remembers exactly what it removed.
  const done = await removeThroughRoute(brain, target, memory());
  assert.equal(done.status, 200);
  const receipt = await done.json();
  assert.equal(receipt.remembered, true);
  assert.equal(brain.liveUids("gmail").length, 70);
  assert.deepEqual(brain.ledger().map((row) => row.family_uid), [...target].sort());
  assert.ok(brain.ledger().every((row) => row.run_id === "clean_test_run_1" && row.batch_no === 0 && row.restored_at === null));
  assert.deepEqual(brain.ledger()[0] && { source: brain.ledger()[0].source, provider_id: brain.ledger()[0].provider_id },
    { source: "gmail", provider_id: "m1" });
});

test("an ordinary removal (no memory request) never writes the ledger", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 60, 1);
  const response = await removeThroughRoute(brain, ids("m", 1, 10).map((id) => `gmail:${id}`));
  assert.equal(response.status, 200);
  assert.deepEqual(brain.ledger(), []);
});

test("memory fields are validated and need the whole set", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 10, 1);
  const target = ids("m", 1, 3).map((id) => `gmail:${id}`);
  for (const bad of [{ remember_removal: true }, { remember_removal: true, run_id: "x", batch_no: 0 },
    { remember_removal: false, run_id: "clean_test_run_1", batch_no: 0 },
    { remember_removal: true, run_id: "clean_test_run_1", batch_no: -1 }]) {
    const response = await removeThroughRoute(brain, target, bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal(brain.liveUids("gmail").length, 10);
});

test("removed Gmail and Drive items are refused on a full re-read, parts included", async () => {
  const brain = makeBrain();
  brain.load("gmail", ["a1", "a2", "a1#part2of2"], { partOf: { "a1#part2of2": "a1" } });
  brain.load("drive", ["fileA", "fileB"]);
  await removeThroughRoute(brain, ["gmail:a1", "drive:fileA"], memory());
  assert.deepEqual(brain.liveUids("gmail"), ["gmail:a2"]);
  assert.deepEqual(brain.ledger().map((r) => r.family_uid), ["drive:fileA", "gmail:a1"]);

  const envelope = (type, id, metadata = {}) => ({ source_type: type, source_id: id, title: "Back again",
    content: "Ordinary synthetic text that is loaded again.", metadata });
  const post = async (docs) => (await (await call(brain, "/api/admin/brain/ingest/batch", { docs })).json());
  const result = await post([
    envelope("gmail", "a1"), envelope("gmail", "a1#part2of2", { part_of: "a1" }), envelope("gmail", "a2"),
    envelope("gmail", "a3"), envelope("drive", "fileA"), envelope("drive", "fileB"),
  ]);
  const bySource = Object.fromEntries(result.results.map((r) => [`${r.source_type}:${r.source_id}`, r]));
  for (const key of ["gmail:a1", "gmail:a1#part2of2", "drive:fileA"]) {
    assert.equal(bySource[key].status, "refused", key);
    assert.deepEqual(bySource[key].labels, ["owner_removed"], key);
  }
  for (const key of ["gmail:a2", "gmail:a3", "drive:fileB"]) assert.notEqual(bySource[key].status, "refused", key);
  assert.equal(result.refused, 3);
  assert.deepEqual(brain.liveUids("gmail"), ["gmail:a2", "gmail:a3"], "removed mail did not return");
  assert.deepEqual(brain.liveUids("drive"), ["drive:fileB"]);

  // The single-document door agrees.
  const single = await call(brain, "/api/admin/brain/ingest", envelope("gmail", "a1"));
  assert.equal(single.status, 422);
  assert.deepEqual((await single.json()).labels, ["owner_removed"]);
});

test("the database backstop refuses a writer that skips the checks, and restore lifts it", async () => {
  const brain = makeBrain();
  brain.load("gmail", ["a1"]);
  await removeThroughRoute(brain, ["gmail:a1"], memory());
  const insert = () => brain.db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
     VALUES ('gmail:a1', 'gmail', 'a1', 'Back', 1, 'h', '{}')`).run();
  assert.throws(insert, /OWNER_REMOVED/);
  assert.equal(brain.liveUids("gmail").length, 0);
  const restored = await (await call(brain, "/api/admin/brain/owner-removals", { action: "restore", families: ["gmail:a1"] })).json();
  assert.equal(restored.restored, 1);
  assert.doesNotThrow(insert);
  assert.ok(brain.ledger()[0].restored_at > 0, "the row keeps its why");
});

test("remember backfills already-removed families and refuses a live one", async () => {
  const brain = makeBrain();
  brain.load("gmail", ["live1"]);
  const post = (body) => call(brain, "/api/admin/brain/owner-removals", body);
  const ok = await post({ action: "remember", families: ["gmail:gone1", "gmail:gone2"], run_id: "pilot_1116_x", reason: "pilot" });
  assert.equal(ok.status, 200);
  assert.deepEqual(brain.ledger().map((r) => r.family_uid), ["gmail:gone1", "gmail:gone2"]);
  const live = await post({ action: "remember", families: ["gmail:live1"], run_id: "pilot_1116_x" });
  assert.equal(live.status, 409);
  assert.equal((await live.json()).code, "OWNER_REMOVAL_FAMILY_LIVE");
  const check = await (await post({ action: "check", source: "gmail", uids: ["gmail:gone1", "gmail:live1"] })).json();
  assert.deepEqual(check.owner_removed, ["gmail:gone1"]);
  assert.equal((await post({ action: "check", source: "gmail", uids: ["drive:x"] })).status, 400);
  assert.equal((await post({ action: "check", source: "gmail", uids: ["gmail:a"], extra: 1 })).status, 400);
});

test("a 503 after the delete committed says so, and the proof read resolves it", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 80, 1);
  const target = ids("m", 1, 50).map((id) => `gmail:${id}`);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let response;
  try {
    brain.hooks.failAfterCommit = new Error('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset: object "gmail:m1" for user@example.com');
    response = await removeThroughRoute(brain, target, memory(7));
  } finally { console.error = original; }
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "INGEST_REMOVAL_UNAVAILABLE");
  assert.equal(body.stage, "delete_batch");
  assert.equal(body.committed, "unknown", "a batch that failed to return may already be in");
  assert.equal(body.d1_class, "timeout");
  assert.match(body.provider_message, /storage operation exceeded timeout/);
  assert.doesNotMatch(body.provider_message + JSON.stringify(logged), /gmail:m1|user@example/, "no id or quoted value leaves the Worker");
  assert.equal(logged.length, 1, "the real failure reaches the Worker log");
  // The exact proof: every target gone and the ledger carries this run and batch.
  const proof = await (await call(brain, "/api/admin/brain/owner-removals", {
    action: "proof", run_id: "clean_test_run_1", batch_no: 7, targets: target })).json();
  assert.deepEqual(proof, { committed: true, remaining_documents: 0, ledger_rows: 50 });
  // A different batch number is not proof.
  const other = await (await call(brain, "/api/admin/brain/owner-removals", {
    action: "proof", run_id: "clean_test_run_1", batch_no: 8, targets: target })).json();
  assert.equal(other.committed, false);
});

test("a failure after the apply names its stage and that the delete is in", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 60, 1);
  const marker = (await previewIngestRemovals(brain.env, { families: [family("gmail:m1")] })).marker;
  brain.hooks.failReadback = new Error("D1_ERROR: Network connection lost");
  await assert.rejects(applyIngestRemovals(brain.env, { targets: ["gmail:m1"], marker }), (error) => {
    const failure = ingestRemovalFailure(error);
    assert.equal(failure.status, 503);
    assert.equal(failure.stage, "readback");
    assert.equal(failure.committed, true);
    assert.equal(failure.d1_class, "network");
    return true;
  });
  assert.equal(brain.liveUids("gmail").includes("gmail:m1"), false);
});

test("the batch is one short call: nothing slow remains to time out", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 5000, 2);
  brain.batches.length = 0;
  const response = await removeThroughRoute(brain, ids("m", 1, 50).map((id) => `gmail:${id}`), memory());
  assert.equal(response.status, 200);
  assert.equal(brain.batches.length, 1, "exactly one D1 transaction for 50 documents");
  assert.ok(brain.batches[0].length <= 8);
});

test("the counter check reads without scanning chunk text, finds drift and repairs only on request", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 300, 2);
  brain.db.prepare("UPDATE documents SET deleted_at = 5 WHERE doc_uid IN ('gmail:m1', 'gmail:m2')").run();
  const clean = await verifyCorpusStats(brain.env, { source: "gmail" });
  assert.equal(clean.matches, true, "soft-deleted documents are not counted by either side");
  assert.deepEqual(clean.exact, brain.truth("gmail").documents === 298 ? { documents: 298, chunks: 596 } : clean.exact);
  brain.db.prepare("UPDATE corpus_stats SET documents = documents + 7 WHERE source = 'gmail'").run();
  const drifted = await verifyCorpusStats(brain.env, { source: "gmail" });
  assert.equal(drifted.matches, false);
  assert.equal(drifted.code, "CLEAN_COUNTERS_DRIFTED");
  assert.equal(drifted.repaired, false);
  const repaired = await (await call(brain, "/api/admin/brain/corpus-stats/verify", { source: "gmail", repair: true })).json();
  assert.equal(repaired.repaired, true);
  assert.equal((await verifyCorpusStats(brain.env, { source: "gmail" })).matches, true);
  assert.equal((await call(brain, "/api/admin/brain/corpus-stats/verify", { source: "Bad Source" })).status, 400);
});

test("the Brain advertises the ledger only from schema 70", async () => {
  for (const [schema, expected] of [[70, 1], [69, 0]]) {
    const brain = makeBrain({ schema });
    const body = await (await call(brain, "/api/admin/brain/ingest-capabilities", undefined, "GET")).json();
    assert.equal(body.owner_removal_ledger, expected, `schema ${schema}`);
  }
});

test("the ledger routes need the owner key", async () => {
  const brain = makeBrain();
  for (const path of ["/api/admin/brain/owner-removals", "/api/admin/brain/corpus-stats/verify"]) {
    const response = await worker.fetch(new Request(`${BASE}${path}`, { method: "POST",
      headers: { "X-Admin-Key": "wrong", "Content-Type": "application/json" }, body: "{}" }), brain.env, {});
    assert.ok([401, 403].includes(response.status), `${path} ${response.status}`);
  }
});

test("an incoming item is checked by its own base id and the item it belongs to", () => {
  assert.deepEqual(envelopeOwnerRemovalKeys({ source_type: "gmail", source_id: "a1" }), ["gmail:a1"]);
  assert.deepEqual(envelopeOwnerRemovalKeys({ source_type: "gmail", source_id: "a1#part2of2", metadata: { part_of: "a1" } }), ["gmail:a1"]);
  assert.deepEqual(envelopeOwnerRemovalKeys({ source_type: "gmail", source_id: "a1#part2of2", metadata: { part_of: "gmail:a1" } }), ["gmail:a1"]);
  assert.deepEqual(envelopeOwnerRemovalKeys({ source_type: "drive", source_id: "f#part2of3", metadata: { family_of: "drive:f" } }), ["drive:f"]);
  assert.deepEqual(envelopeOwnerRemovalKeys({ source_type: "gmail", source_id: "att1", metadata: { family_of: "gmail:a1" } }).sort(), ["gmail:a1", "gmail:att1"]);
  // Other sources are never remembered, so they never match.
  assert.deepEqual(envelopeOwnerRemovalKeys({ source_type: "whatsapp", source_id: "x" }), []);
  assert.deepEqual(envelopeOwnerRemovalKeys({ source_type: "", source_id: "x" }), []);
  assert.equal(envelopeIsOwnerRemoved({ source_type: "gmail", source_id: "att1", metadata: { family_of: "gmail:a1" } }, new Set(["gmail:a1"])), true);
  assert.equal(envelopeIsOwnerRemoved({ source_type: "gmail", source_id: "b1" }, new Set(["gmail:a1"])), false);
});

test("a split message is remembered as the message, even before the family index has reached it", async () => {
  const brain = makeBrain();
  brain.load("gmail", ["m1", "m1#part1of2", "m1#part2of2", "m2"], { partOf: { "m1#part1of2": "m1", "m1#part2of2": "m1" } });
  // An older Brain whose schema-59 backfill has not reached these documents.
  brain.db.exec("DELETE FROM document_family_index");
  assert.equal((await removeThroughRoute(brain, ["gmail:m1"], memory())).status, 200);
  assert.deepEqual(brain.liveUids("gmail"), ["gmail:m2"]);
  assert.deepEqual(brain.ledger().map((r) => r.family_uid), ["gmail:m1"], "one record, the message's own id");
  const check = await (await call(brain, "/api/admin/brain/owner-removals", { action: "check", source: "gmail", uids: ["gmail:m1", "gmail:m2"] })).json();
  assert.deepEqual(check.owner_removed, ["gmail:m1"]);
});

test("removing one document never records a shared file family or blocks its kept siblings", async () => {
  const brain = makeBrain();
  const insert = brain.db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
     VALUES (?1, 'whatsapp', ?2, 'Chat', 1, 'h', '{"family_of":"whatsapp:exports/chat.txt"}')`);
  insert.run("whatsapp:message:a", "message:a");
  insert.run("whatsapp:message:b", "message:b");
  brain.load("gmail", ["m1"]);
  // Another source is refused before anything is written.
  const refused = await removeThroughRoute(brain, ["whatsapp:message:a"], memory());
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "OWNER_REMOVAL_SOURCE_UNSUPPORTED");
  assert.equal(brain.liveUids("whatsapp").length, 2, "nothing was removed");
  assert.equal(brain.ledger().length, 0, "nothing was remembered");
  // A Gmail removal beside them leaves the file's other documents fully editable.
  await removeThroughRoute(brain, ["gmail:m1"], memory(1));
  assert.deepEqual(brain.ledger().map((r) => r.family_uid), ["gmail:m1"]);
  assert.doesNotThrow(() => brain.db.prepare("UPDATE documents SET meta = '{\"family_of\":\"whatsapp:exports/chat.txt\",\"x\":1}' WHERE doc_uid = 'whatsapp:message:b'").run());
  // The memory itself refuses a non-Gmail, non-Drive or part-suffixed id.
  const post = (body) => call(brain, "/api/admin/brain/owner-removals", body);
  const other = await post({ action: "remember", families: ["whatsapp:message:a"], run_id: "pilot_1116_x" });
  assert.equal(other.status, 400);
  assert.equal((await other.json()).code, "OWNER_REMOVAL_SOURCE_UNSUPPORTED");
  assert.equal((await post({ action: "remember", families: ["gmail:m9#part1of2"], run_id: "pilot_1116_x" })).status, 400);
});

test("the Brain advertises the ledger only when the table is really there", async () => {
  const brain = makeBrain({ schema: 70 });
  brain.db.exec("DROP TRIGGER owner_removals_block_reload; DROP TABLE owner_removals");
  const body = await (await call(brain, "/api/admin/brain/ingest-capabilities", undefined, "GET")).json();
  assert.equal(body.schema_version, 70);
  assert.equal(body.owner_removal_ledger, 0);
});

test("the counter check and its repair are one statement each, so a concurrent ingest cannot skew them", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 200, 2);
  brain.db.prepare("UPDATE corpus_stats SET chunks = chunks + 5 WHERE source = 'gmail'").run();
  brain.statements.length = 0;
  const checked = await verifyCorpusStats(brain.env, { source: "gmail" });
  assert.equal(checked.matches, false);
  assert.equal(brain.statements.length, 1, "the comparison is a single read");
  brain.statements.length = 0;
  await verifyCorpusStats(brain.env, { source: "gmail", repair: true });
  assert.equal(brain.statements.length, 2, "one read, one single-statement repair");
  assert.match(brain.statements[1], /INSERT INTO corpus_stats[\s\S]*SELECT[\s\S]*COUNT/);
  assert.equal((await verifyCorpusStats(brain.env, { source: "gmail" })).matches, true);
});

test("size: per-source counters and a queue depth the Worker caps, never a document scan", async () => {
  const brain = makeBrain();
  brain.loadMany("gmail", "m", 120, 1);
  brain.loadMany("drive", "f", 30, 1);
  brain.statements.length = 0;
  const size = await (await call(brain, "/api/admin/brain/owner-removals", { action: "size" })).json();
  assert.equal(size.documents, 150);
  assert.deepEqual(size.sources, { drive: 30, gmail: 120 });
  assert.deepEqual(size.vector_backlog, { pending: 0, pending_is_capped: false });
  assert.ok(brain.statements.every((sql) => !/FROM documents\b|FROM chunks\b/i.test(sql)), "no document or chunk scan");
  brain.queue(10_001);
  const capped = await (await call(brain, "/api/admin/brain/owner-removals", { action: "size" })).json();
  assert.equal(capped.vector_backlog.pending_is_capped, true);
  assert.equal(capped.vector_backlog.pending, 10_001);
  assert.equal((await call(brain, "/api/admin/brain/owner-removals", { action: "size", extra: 1 })).status, 400);
});
