/**
 * An identical-content re-send rebinds provenance without re-embedding.
 *
 * WHY THIS EXISTS. Measured live on 2026-09-23: a document loaded by an older
 * CLI has no source-original binding, so the first 0.4.8 re-send rewrites it
 * even though its content_hash is identical. That rewrite is the provenance
 * backfill and is wanted. But it also queued one outbox upsert per chunk, and
 * the drain re-embedded byte-identical text at 50 to 100 chunks a minute: days
 * of "degraded" answers for one owner, about eleven for another.
 *
 * Everything here runs against real SQLite with every shipped migration and
 * trigger, through the real ingest routes, a real leased drain, and a fake
 * Vectorize that only confirms what getByIds can see. A vector counts as
 * projected only after that drain proved it, never because a fixture said so.
 *
 * The control is the code before this change (99a8327). There, every
 * no-re-embed case fails: test (a) sees one queued upsert per chunk (4, and 66
 * on the resumable path), and test (e) is refused with
 * source_original_result_family_vector_unready. Tests (b) to (d) and the
 * unconfirmed-projection case pass on both versions, which is the point: every
 * change the vector could see still queues exactly the upserts it always did.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createProductFixture } from "./product-contract-fixture.mjs";
import { chunkGeometry, chunkText, expectedD1ContentHash, storeFor } from "../src/lib/store.js";
import {
  drainOutbox, vectorIdFor, vectorMetadataFor, vectorReadiness,
} from "../src/lib/store-d1.js";
import { withFirstPartySourceProvenance } from "../src/lib/provenance-receipt.js";
import { sourceOriginalChunkReceiptHash } from "../src/lib/source-original-chunk.js";
import { SOURCE_ORIGINAL_OBSERVATION_PATH } from "../src/lib/source-original-observation.js";

const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const SOURCE = "localdocs";
const TITLE = "Synthetic fixture ledger";
const RAW_SHA = "7".repeat(64);
const RAW_BYTES = 4096;
// No word of this query appears in any fixture document, so FTS finds nothing
// and a hit can only come from Vectorize. That is the path a re-projection
// would have taken away if old vectors had not kept serving.
const VECTOR_ONLY_QUERY = "quiet paraphrase without shared vocabulary";

// Fictional text only. The default 36 lines are four chunks at the 1,500/300
// geometry, so every arm exercises more than one chunk id; 700 lines exceed
// the 48-chunk atomic stage and take the resumable path.
function syntheticLedger(label, lines = 36) {
  return Array.from({ length: lines }, (_, index) =>
    `Fixture ${label} entry ${String(index + 1).padStart(3, "0")}: synthetic reconciliation ` +
    `note for an invented account, balance ${1000 + index * 7} fixture units.`).join("\n");
}

const embeddingFor = (text) => {
  const digest = createHash("sha256").update(String(text)).digest();
  return [0, 1, 2, 3].map((index) => digest[index] / 255);
};

// Exact-match Vectorize prefilter semantics for the string and date fields the
// product indexes. Enough to prove a skipped chunk is still filterable.
function metadataMatches(metadata = {}, filter = {}) {
  return Object.entries(filter || {}).every(([key, condition]) => {
    const value = metadata[key];
    if (condition && typeof condition === "object") {
      if (Object.hasOwn(condition, "$eq") && value !== condition.$eq) return false;
      if (Object.hasOwn(condition, "$gte") && !(value >= condition.$gte)) return false;
      if (Object.hasOwn(condition, "$lte") && !(value <= condition.$lte)) return false;
      return true;
    }
    return value === condition;
  });
}

// D1 reports meta.changes as a total_changes() delta, so trigger writes count,
// and so do the FTS5 shadow-table writes a statement's savepoint flushes for an
// earlier chunk write. node:sqlite's run().changes counts neither. That gap hid
// a receipt bug in this change during development: a skipped upsert reported
// up to 66 changes under D1's counting, so it is now proved by RETURNING. The
// shared fixture's schema, routes and SQL log stay; only the change count is
// replaced, the same way test/d1-batch-ingest.test.mjs models D1.
function useD1ChangeSemantics(fixture) {
  const { sqlite, seen } = fixture;
  const writes = [];
  // A test may reject one D1 batch outright, the way a D1 CPU reset does,
  // to leave a revision interrupted part-way through its resumable writes.
  const control = { rejectBatch: null };
  const totalChanges = () => sqlite.prepare("SELECT total_changes() AS n").get().n;
  const execute = (sql, params, mode) => {
    seen.sql.push(sql);
    seen.binds.push(params);
    const statement = sqlite.prepare(sql);
    if (mode === "all") return { results: statement.all(...params) };
    if (mode === "first") return statement.get(...params) ?? null;
    const before = totalChanges();
    const results = statement.all(...params);
    const changes = totalChanges() - before;
    writes.push({ sql, changes, returned: results.length });
    return { success: true, results, meta: { changes } };
  };
  const prepared = (sql, params = []) => ({
    sql,
    params,
    bind: (...next) => prepared(sql, next),
    all: async () => execute(sql, params, "all"),
    first: async () => execute(sql, params, "first"),
    run: async () => execute(sql, params, "run"),
  });
  fixture.env.DB = {
    prepare: (sql) => prepared(sql),
    async exec(sql) {
      seen.sql.push(sql);
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async batch(statements) {
      if (control.rejectBatch?.(statements)) throw new Error("fixture D1 batch rejected");
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          const readOnly = /^\s*(SELECT|PRAGMA)\b/i.test(statement.sql) ||
            (/^\s*WITH\b/i.test(statement.sql) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(statement.sql));
          return execute(statement.sql, statement.params || [], readOnly ? "all" : "run");
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { writes, control };
}

const isReuseDecision = (sql) => /FROM chunks AS stored/.test(sql) && /RETURNING chunk_uid/.test(sql);

async function createBrain() {
  const fixture = await createProductFixture();
  const { writes, control } = useD1ChangeSemantics(fixture);
  fixture.raw(
    "INSERT INTO sources (name,kind,status,created_at) VALUES (?,?,?,?)",
    SOURCE, "upload", "ready", "2026-09-23T00:00:00Z",
  );
  fixture.raw(
    "INSERT INTO source_original_id_key_state (tenant_id,signing_salt) VALUES ('primary',?)",
    "a".repeat(64),
  );

  const visible = new Map();
  const log = { upserted: [], deleted: [], embedded: 0 };
  let sequence = 0;
  let processedUpToMutation = null;
  const accept = (apply) => {
    apply();
    processedUpToMutation = `fixture-mutation-${++sequence}`;
    return { mutationId: processedUpToMutation };
  };
  fixture.env.VECTORIZE = {
    async upsert(vectors) {
      return accept(() => {
        for (const vector of vectors) {
          log.upserted.push(vector.id);
          visible.set(vector.id, structuredClone(vector));
        }
      });
    },
    async deleteByIds(ids) {
      return accept(() => {
        for (const id of ids) {
          log.deleted.push(id);
          visible.delete(id);
        }
      });
    },
    async getByIds(ids) {
      if (ids.length > 20) throw new Error("fixture getByIds accepts at most 20 ids");
      return ids.map((id) => visible.get(id)).filter(Boolean).map((vector) => structuredClone(vector));
    },
    async describe() {
      return { vectorCount: visible.size, processedUpToMutation };
    },
    async query(_embedding, options = {}) {
      fixture.seen.vectorQueries.push(options);
      const matches = [...visible.values()]
        .filter((vector) => metadataMatches(vector.metadata, options.filter))
        .map((vector, index) => ({ id: vector.id, score: 0.99 - index / 1000 }));
      return { matches: matches.slice(0, options.topK || 100) };
    },
  };
  const embedder = {
    embed: async (text) => {
      log.embedded += 1;
      return embeddingFor(text);
    },
    embedBatch: async (texts) => {
      log.embedded += texts.length;
      return texts.map(embeddingFor);
    },
  };
  return { fixture, env: fixture.env, visible, log, embedder, writes, control };
}

const projectionState = (brain) => ({
  ...brain.fixture.first(
    `SELECT vector_projection_status AS status, outbox_generation AS generation
       FROM install_state WHERE id = 1`,
  ),
});
const outboxRows = (brain, docUid) => brain.fixture.rows(
  `SELECT chunk_uid, vector_id, op, attempts, last_error FROM vector_outbox
    WHERE chunk_uid LIKE ? ORDER BY chunk_uid`,
  `${docUid}#%`,
).map((row) => ({ ...row }));
const outboxCount = (brain) => brain.fixture.first("SELECT COUNT(*) AS n FROM vector_outbox").n;
// Every enqueue gets a fresh database-owned generation, so a changed generation
// is the observable difference between "re-queued" and "left alone".
const outboxGenerations = (brain, docUid) => new Map(brain.fixture.rows(
  "SELECT chunk_uid, generation FROM vector_outbox WHERE chunk_uid LIKE ?",
  `${docUid}#%`,
).map((row) => [row.chunk_uid, Number(row.generation)]));
const documentRow = (brain, docUid) => ({
  ...brain.fixture.first(
    `SELECT content_hash, text_source, text_reliable, provenance_receipt_status,
            document_revision_id, source_original_binding_hash, client, category,
            top_folder, platform, title
       FROM documents WHERE doc_uid = ?`,
    docUid,
  ),
});
const chunkRows = (brain, docUid) => brain.fixture.rows(
  `SELECT chunk_uid, chunk_ix, text, source, title, document_date, client, category,
          top_folder, platform, vector_id, bound_document_revision_id, result_chunk_receipt_hash
     FROM chunks WHERE doc_uid = ? ORDER BY chunk_ix`,
  docUid,
).map((row) => ({ ...row }));

// Drain to an exact, verified projection: every outbox row confirmed through
// getByIds and the install marked verified by markProjectionVerifiedIfExact.
async function drainToVerified(brain) {
  for (let round = 0; round < 10; round++) {
    await drainOutbox(brain.env, { ...brain.embedder, maxBatches: 10 });
    const state = projectionState(brain);
    if (outboxCount(brain) === 0 && state.status === "verified") return;
  }
  throw new Error(`fixture drain did not verify: ${JSON.stringify(projectionState(brain))}`);
}

async function ingestBatch(brain, envelope) {
  const response = await brain.fixture.post("/api/admin/brain/ingest/batch", { docs: [envelope] }, ADMIN);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.failed, 0, JSON.stringify(body));
  return { action: body.results[0].status, chunks: body.results[0].chunks };
}

async function ingestSingle(brain, envelope) {
  const response = await brain.fixture.post("/api/admin/brain/ingest", envelope, ADMIN);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { action: body.action, chunks: body.chunks, queued: body.queued };
}

// The shape an older CLI sent: no text_source, no lineage, no byte receipt.
// It is stored as text_source "unknown", provenance "unavailable", unbound.
function olderCliEnvelope(sourceId, content, patch = {}) {
  return {
    source_type: SOURCE,
    source_id: sourceId,
    title: TITLE,
    content,
    metadata: {
      category: "fixture-banking",
      client_name: "Fixture Client A",
      top_folder: "Fixture Ledgers",
      platform: "fixture-drive",
    },
    ...patch,
  };
}

// The same document as 0.4.8 sends it: native text, a source-record lineage and
// a source-original byte receipt, which is what makes the Worker rewrite it.
function currentCliEnvelope(older, patch = {}) {
  const { metadata: metadataPatch = {}, ...rest } = patch;
  return withFirstPartySourceProvenance({
    ...older,
    ...rest,
    metadata: { ...older.metadata, ...metadataPatch },
    source_original_receipt: {
      version: 1,
      locator_kind: "source_relative_path",
      original_content_sha256: RAW_SHA,
      original_byte_count: RAW_BYTES,
    },
  }, { textSource: "native", textReliable: true });
}

async function loadProjectedOlderDocument(brain, sourceId, content, ingest = ingestBatch) {
  const older = olderCliEnvelope(sourceId, content);
  const loaded = await ingest(brain, older);
  assert.equal(loaded.action, "created");
  await drainToVerified(brain);
  const docUid = `${SOURCE}:${sourceId}`;
  const before = documentRow(brain, docUid);
  assert.equal(before.text_source, "unknown");
  assert.equal(before.provenance_receipt_status, "unavailable");
  assert.equal(before.source_original_binding_hash, null);
  assert.ok(chunkRows(brain, docUid).every((chunk) => chunk.bound_document_revision_id === null));
  return { older, docUid, before };
}

// Proves the vector Vectorize already holds for every chunk is exactly what a
// fresh drain would send now: the embedding of the stored text, and the stored
// row's projected metadata. Only the per-enqueue confirmation token may differ.
async function assertProjectionMatchesStoredChunks(brain, docUid) {
  for (const chunk of chunkRows(brain, docUid)) {
    const vector = brain.visible.get(await vectorIdFor(chunk.chunk_uid));
    assert.ok(vector, `a vector is visible for ${chunk.chunk_uid}`);
    assert.deepEqual(vector.values, embeddingFor(chunk.text));
    const { outbox_generation: _stored, ...projected } = vector.metadata;
    const { outbox_generation: _next, ...expected } = await vectorMetadataFor(chunk);
    assert.deepEqual(projected, expected);
  }
}

async function assertBoundAndComplete(brain, docUid, before) {
  const after = documentRow(brain, docUid);
  assert.equal(after.content_hash, before.content_hash, "content is identical");
  assert.notEqual(after.document_revision_id, before.document_revision_id, "a new revision was written");
  assert.match(after.source_original_binding_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(after.text_source, "native");
  assert.equal(after.provenance_receipt_status, "complete");
  const chunks = chunkRows(brain, docUid);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(chunk.bound_document_revision_id, after.document_revision_id);
    assert.equal(chunk.result_chunk_receipt_hash, await sourceOriginalChunkReceiptHash({
      document_revision_id: after.document_revision_id,
      chunk_ix: chunk.chunk_ix,
      title: chunk.title,
      text: chunk.text,
    }));
  }
  return { after, chunks };
}

// Today's exact queue state for a rewritten chunk: one fresh upsert per chunk,
// attempts reset, no error, under the id the drain will write.
const expectedUpserts = async (docUid, count) => Promise.all(
  Array.from({ length: count }, async (_, index) => ({
    chunk_uid: `${docUid}#${index}`,
    vector_id: await vectorIdFor(`${docUid}#${index}`),
    op: "upsert",
    attempts: 0,
    last_error: null,
  })),
);

async function assertEveryChunkQueuedAndReprojected(brain, docUid) {
  const chunks = chunkRows(brain, docUid);
  assert.deepEqual(outboxRows(brain, docUid), await expectedUpserts(docUid, chunks.length));
  const embeddedBefore = brain.log.embedded;
  await drainToVerified(brain);
  assert.equal(brain.log.embedded - embeddedBefore, chunks.length);
  await assertProjectionMatchesStoredChunks(brain, docUid);
}

async function assertVectorSearchStillFinds(brain, docUid) {
  const store = storeFor(brain.env);
  const search = await store.search(brain.env, { query: VECTOR_ONLY_QUERY, limit: 5 });
  assert.equal(search.degraded, null, JSON.stringify({ degraded: search.degraded, reason: search.degraded_reason }));
  assert.equal(search.counts.keyword, 0, "the query shares no word with the document");
  assert.ok(search.counts.vector >= 1);
  assert.ok(search.results.some((row) => row.doc_uid === docUid), JSON.stringify(search.results));

  // The kept vectors still carry exactly the filter metadata D1 holds, so a
  // Vectorize prefilter on the stored category selects them and a different
  // category excludes them before D1 ever re-applies the filter.
  const matching = await store.search(brain.env, {
    query: VECTOR_ONLY_QUERY, limit: 5, filters: { category: "fixture-banking" },
  });
  assert.deepEqual(brain.fixture.seen.vectorQueries.at(-1).filter, { category: { $eq: "fixture-banking" } });
  assert.ok(matching.counts.vector >= 1);
  assert.ok(matching.results.some((row) => row.doc_uid === docUid));
  const other = await store.search(brain.env, {
    query: VECTOR_ONLY_QUERY, limit: 5, filters: { category: "fixture-other" },
  });
  assert.equal(other.counts.vector, 0);
  assert.ok(!other.results.some((row) => row.doc_uid === docUid));
}

for (const arm of [
  { name: "atomic batch stage", ingest: ingestBatch, lines: 36 },
  { name: "resumable path for a document over the 48-chunk stage", ingest: ingestBatch, lines: 700 },
  { name: "single-document route", ingest: ingestSingle, lines: 36 },
]) {
  test(`(a) ${arm.name}: an identical re-send onto an older unbound row binds it and queues zero upserts`, async (t) => {
    const brain = await createBrain();
    t.after(() => brain.fixture.close());
    const sourceId = `statements/identical-${arm.lines}.pdf`;
    const { older, docUid, before } = await loadProjectedOlderDocument(
      brain, sourceId, syntheticLedger("identical", arm.lines), arm.ingest,
    );
    const chunkCount = chunkRows(brain, docUid).length;
    assert.ok(arm.lines < 100 ? chunkCount > 1 && chunkCount <= 48 : chunkCount > 48, String(chunkCount));
    const projectedBefore = projectionState(brain);
    const upsertsBefore = brain.log.upserted.length;
    const embeddedBefore = brain.log.embedded;

    const resent = await arm.ingest(brain, currentCliEnvelope(older));
    assert.equal(resent.action, "updated");
    if (resent.queued !== undefined) assert.equal(resent.queued, 0, "the receipt reports no queued vectors");

    await assertBoundAndComplete(brain, docUid, before);
    assert.equal(outboxCount(brain), 0, "an identical re-send queues no vector work at all");
    assert.deepEqual(projectionState(brain), projectedBefore,
      "the verified projection and its outbox generation are untouched");
    const readiness = await vectorReadiness(brain.env);
    assert.equal(readiness.ready, true, JSON.stringify(readiness));
    await assertProjectionMatchesStoredChunks(brain, docUid);
    await assertVectorSearchStillFinds(brain, docUid);

    await drainToVerified(brain);
    assert.equal(brain.log.upserted.length, upsertsBefore, "no vector is rewritten");
    assert.equal(brain.log.embedded, embeddedBefore, "no embedding model call is made");

    // The rebind is complete, so the next identical re-send is the ordinary
    // no-op, exactly as it was before this change.
    assert.equal((await arm.ingest(brain, currentCliEnvelope(older))).action, "unchanged");
  });
}

// Her rows were copied in with NULL provenance columns and no revision id, not
// written by today's Worker. Seed that exact shape, projected as the drain
// would have left it, instead of asking the current code to produce it.
// `driftChunk` stores one chunk's text as an older chunker might have: under
// the same content hash and title, but not byte-identical to today's chunkText
// output. Its vector embeds the stored text, as the old drain would have.
async function seedProjectedLegacyDocument(brain, sourceId, content, { driftChunk = null } = {}) {
  const docUid = `${SOURCE}:${sourceId}`;
  const older = olderCliEnvelope(sourceId, content);
  const hash = await expectedD1ContentHash(brain.env, older);
  brain.fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,client,category,
        top_folder,platform,text_source,text_reliable)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    docUid, SOURCE, sourceId, TITLE, 1, hash,
    JSON.stringify({ category: "fixture-banking", client_name: "Fixture Client A",
      top_folder: "Fixture Ledgers", platform: "fixture-drive" }),
    "Fixture Client A", "fixture-banking", "Fixture Ledgers", "fixture-drive", "unknown", 0,
  );
  const pieces = chunkText(older.content, { header: `[${TITLE}]`, ...chunkGeometry(brain.env) });
  for (const [index, current] of pieces.entries()) {
    const text = index === driftChunk ? `${current} ` : current;
    const chunk = {
      chunk_uid: `${docUid}#${index}`, doc_uid: docUid, chunk_ix: index, text, source: SOURCE,
      title: TITLE, document_date: null, client: "Fixture Client A", category: "fixture-banking",
      top_folder: "Fixture Ledgers", platform: "fixture-drive",
    };
    chunk.vector_id = await vectorIdFor(chunk.chunk_uid);
    brain.fixture.raw(
      `INSERT INTO chunks
         (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date,client,category,
          top_folder,platform,vector_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      chunk.chunk_uid, docUid, index, text, SOURCE, TITLE, null, chunk.client, chunk.category,
      chunk.top_folder, chunk.platform, chunk.vector_id,
    );
    brain.visible.set(chunk.vector_id, {
      id: chunk.vector_id,
      values: embeddingFor(text),
      metadata: await vectorMetadataFor({ ...chunk, generation: index + 1 }),
    });
  }
  assert.equal(documentRow(brain, docUid).provenance_receipt_status, null);
  assert.equal((await vectorReadiness(brain.env)).ready, true);
  return { older, docUid, hash, chunkCount: pieces.length };
}

test("(a) a row migrated before provenance columns existed also rebinds without re-embedding", async (t) => {
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const { older, docUid, hash } = await seedProjectedLegacyDocument(
    brain, "statements/migrated-null-provenance.pdf", syntheticLedger("migrated"),
  );

  const resent = await ingestBatch(brain, currentCliEnvelope(older));
  assert.equal(resent.action, "updated");
  await assertBoundAndComplete(brain, docUid, { content_hash: hash, document_revision_id: null });
  assert.equal(outboxCount(brain), 0);
  assert.equal(projectionState(brain).status, "verified");
  await assertProjectionMatchesStoredChunks(brain, docUid);
  await assertVectorSearchStillFinds(brain, docUid);
});

for (const arm of [
  { name: "atomic batch stage", ingest: ingestBatch, lines: 36, drift: 1 },
  { name: "resumable path for a document over the 48-chunk stage", ingest: ingestBatch, lines: 700, drift: 57 },
  { name: "single-document route", ingest: ingestSingle, lines: 36, drift: 2 },
]) {
  test(`${arm.name}: a stored chunk whose text differs under the same hash is re-queued, alone`, async (t) => {
    // Same hash, same title, same filters, nothing queued: the kept-row check
    // accepts this chunk, so only the byte comparison of its text can refuse
    // the skip. Without it the drifted chunk would take today's text in D1
    // while Vectorize kept serving the old embedding, with nothing queued to
    // ever fix it.
    const brain = await createBrain();
    t.after(() => brain.fixture.close());
    const { older, docUid, chunkCount } = await seedProjectedLegacyDocument(
      brain, `statements/drifted-${arm.lines}.pdf`, syntheticLedger("drift", arm.lines),
      { driftChunk: arm.drift },
    );
    assert.ok(arm.drift < chunkCount && (arm.lines < 100 || chunkCount > 48), String(chunkCount));
    const driftedUid = `${docUid}#${arm.drift}`;
    const staleValues = brain.visible.get(await vectorIdFor(driftedUid)).values;

    assert.equal((await arm.ingest(brain, currentCliEnvelope(older))).action, "updated");
    assert.deepEqual(outboxRows(brain, docUid), [{
      chunk_uid: driftedUid,
      vector_id: await vectorIdFor(driftedUid),
      op: "upsert",
      attempts: 0,
      last_error: null,
    }]);
    const embeddedBefore = brain.log.embedded;
    await drainToVerified(brain);
    assert.equal(brain.log.embedded - embeddedBefore, 1, "only the drifted chunk is re-embedded");
    assert.notDeepEqual(brain.visible.get(await vectorIdFor(driftedUid)).values, staleValues);
    await assertProjectionMatchesStoredChunks(brain, docUid);
  });
}

test("a later identical re-send that drops the byte receipt unbinds D1 in place without re-embedding", async (t) => {
  // The kept rows are UPDATEd rather than re-inserted, so the schema-44 receipt
  // triggers see a bound row move to NULL/NULL under a new unbound revision.
  // That direction must be as writable as the bind in test (a).
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const sourceId = "statements/unbind-in-place.pdf";
  const { older, docUid, before } = await loadProjectedOlderDocument(brain, sourceId, syntheticLedger("unbind"));
  await ingestBatch(brain, currentCliEnvelope(older));
  const { after: bound } = await assertBoundAndComplete(brain, docUid, before);
  const embeddedBefore = brain.log.embedded;

  const { source_original_receipt: _receipt, ...unbound } = currentCliEnvelope(older);
  assert.equal((await ingestBatch(brain, unbound)).action, "updated");
  const document = documentRow(brain, docUid);
  assert.equal(document.source_original_binding_hash, null);
  assert.notEqual(document.document_revision_id, bound.document_revision_id);
  assert.equal(document.provenance_receipt_status, "complete");
  assert.ok(chunkRows(brain, docUid).every((chunk) =>
    chunk.bound_document_revision_id === null && chunk.result_chunk_receipt_hash === null));
  assert.equal(outboxCount(brain), 0);
  await drainToVerified(brain);
  assert.equal(brain.log.embedded, embeddedBefore);
});

test("a text_source-only transition, the first check d1RevisionUnchanged makes, rewrites without re-embedding", async (t) => {
  // d1RevisionUnchanged returns false on its first line when d1MetadataChanged
  // sees text_source move from unknown to native, before any binding or
  // schema-44 check runs. No byte receipt is sent here, so that is the only
  // reason for the rewrite. The row must still be rewritten, and the chunks,
  // whose text and filter metadata did not change, must not be re-embedded.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const { older, docUid, before } = await loadProjectedOlderDocument(
    brain, "statements/text-source-only.pdf", syntheticLedger("native"),
  );
  const vectorsBefore = structuredClone([...brain.visible.entries()]);
  const nativeOnly = withFirstPartySourceProvenance(older, { textSource: "native", textReliable: true });
  assert.equal(Object.hasOwn(nativeOnly, "source_original_receipt"), false);

  assert.equal((await ingestBatch(brain, nativeOnly)).action, "updated");
  const after = documentRow(brain, docUid);
  assert.equal(after.text_source, "native");
  assert.equal(after.provenance_receipt_status, "complete");
  assert.equal(after.content_hash, before.content_hash);
  assert.notEqual(after.document_revision_id, before.document_revision_id, "the row was rewritten");
  assert.equal(after.source_original_binding_hash, null);
  assert.equal(outboxCount(brain), 0);
  assert.deepEqual([...brain.visible.entries()], vectorsBefore, "every vector is untouched");
});

test("no outbox row is left waiting for a confirmation nobody will send", async (t) => {
  // confirmSubmittedVectors confirms a queued row only when Vectorize returns
  // metadata.outbox_generation equal to that row's generation. A rewrite that
  // advanced a generation without a real upsert behind it would leave a row
  // that can never confirm: a permanently pending outbox. So an unchanged
  // chunk must leave its vector, including that confirmation token, and the
  // install generation exactly as they were, and a changed chunk must get a
  // real upsert that the drain then confirms.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const install = () => ({
    ...brain.fixture.first(
      `SELECT outbox_generation, vector_projection_status, vector_projection_mutation_id
         FROM install_state WHERE id = 1`,
    ),
  });
  const retryRows = () => brain.fixture.first("SELECT COUNT(*) AS n FROM vector_outbox_retry_state").n;

  // Unchanged: nothing is queued, nothing advances, nothing is written.
  const { older } = await loadProjectedOlderDocument(
    brain, "statements/no-orphan-generation.pdf", syntheticLedger("confirm", 700),
  );
  const installBefore = install();
  const vectorsBefore = structuredClone([...brain.visible.entries()]);
  const writesBefore = { upserted: brain.log.upserted.length, deleted: brain.log.deleted.length };
  assert.equal((await ingestBatch(brain, currentCliEnvelope(older))).action, "updated");
  assert.equal(outboxCount(brain), 0);
  assert.equal(retryRows(), 0);
  assert.deepEqual(install(), installBefore, "no generation advanced and the verified state is intact");
  assert.deepEqual([...brain.visible.entries()], vectorsBefore,
    "every vector, including its outbox_generation token, is byte-for-byte untouched");
  await drainOutbox(brain.env, { ...brain.embedder, maxBatches: 10 });
  assert.deepEqual({ upserted: brain.log.upserted.length, deleted: brain.log.deleted.length }, writesBefore);
  assert.deepEqual(install(), installBefore);

  // Changed: the one drifted chunk gets a real upsert under a fresh
  // generation, and the drain confirms exactly that generation.
  const drifted = await seedProjectedLegacyDocument(
    brain, "statements/one-real-upsert.pdf", syntheticLedger("confirm-drift"), { driftChunk: 1 },
  );
  const driftedUid = `${drifted.docUid}#1`;
  const untouchedBefore = structuredClone([...brain.visible.entries()]
    .filter(([id]) => id !== driftedUid));
  assert.equal((await ingestBatch(brain, currentCliEnvelope(drifted.older))).action, "updated");
  const queued = brain.fixture.rows("SELECT chunk_uid, op, generation FROM vector_outbox")
    .map((row) => ({ ...row }));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].chunk_uid, driftedUid);
  assert.equal(queued[0].op, "upsert");
  assert.equal(Number(install().outbox_generation), Number(queued[0].generation));
  await drainToVerified(brain);
  assert.equal(outboxCount(brain), 0, "the real upsert was confirmed");
  assert.equal(retryRows(), 0);
  assert.equal(brain.visible.get(await vectorIdFor(driftedUid)).metadata.outbox_generation,
    String(queued[0].generation));
  assert.deepEqual([...brain.visible.entries()].filter(([id]) => id !== driftedUid), untouchedBefore);
});

test("the reuse decisions use keyed lookups only, never a corpus scan", async (t) => {
  // They run once per chunk on corpora of hundreds of thousands of chunks, so
  // a planner regression to a table scan would turn the fix into a new outage.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const { older } = await loadProjectedOlderDocument(brain, "statements/query-plan.pdf", syntheticLedger("plan"));
  const mark = brain.fixture.seen.sql.length;
  await ingestBatch(brain, currentCliEnvelope(older));
  await ingestSingle(brain, currentCliEnvelope(older, { uri: "https://example.invalid/fixture-ledger" }));
  const reuseStatements = [...new Set(brain.fixture.seen.sql.slice(mark)
    .filter((sql) => /NOT \(EXISTS \(/.test(sql)))];
  // Two paths, each with its retaining delete, retaining DELETE and per-chunk
  // conditional upsert. The resumable path binds its filters, the stage copies.
  assert.equal(reuseStatements.length, 6, reuseStatements.map((sql) => sql.slice(0, 60)).join("\n"));
  for (const sql of reuseStatements) {
    const parameters = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])));
    const plan = brain.fixture.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array(parameters).fill(null)).map((row) => row.detail);
    assert.ok(plan.length > 0);
    // Some SQLite builds, including older Node releases, print "SCAN CONSTANT
    // ROW" for the literal SELECT ?1,?2,... row. That is one row, not a table.
    // Every other SCAN is a real table walk and fails the check.
    assert.ok(plan.every((detail) => !/\bSCAN\b/.test(detail) || /^SCAN CONSTANT ROW$/.test(detail.trim())),
      `${sql.slice(0, 80)}\n${plan.join("\n")}`);
  }
});

test("the ingest receipt counts queued upserts exactly under D1's change counting", async (t) => {
  // meta.changes cannot carry this receipt under D1 (see useD1ChangeSemantics),
  // so the count comes from each decision's RETURNING rows. All three write
  // paths are driven directly, because the batch route does not echo `queued`.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const store = storeFor(brain.env);
  for (const [label, lines, deferFinalize] of [
    ["staged", 36, true],
    ["resumable", 700, true],
    ["direct", 36, false],
  ]) {
    const older = olderCliEnvelope(`statements/receipt-${label}.pdf`, syntheticLedger(label, lines));
    const commit = async (envelope) => {
      const out = await store.ingest(brain.env, envelope, { deferFinalize });
      if (out.deferred_revision) {
        assert.equal((await store.finalizeIngestBatch(brain.env, [out.deferred_revision]))[0].ok, true);
      }
      return out;
    };
    await commit(older);
    await drainToVerified(brain);

    const mark = brain.writes.length;
    const identical = await commit(currentCliEnvelope(older));
    const decisions = brain.writes.slice(mark).filter((write) => isReuseDecision(write.sql));
    assert.equal(decisions.length, identical.chunks, label);
    assert.ok(decisions.every((write) => write.returned === 0), label);
    assert.equal(identical.queued, 0, label);
    assert.equal(outboxCount(brain), 0, label);

    const renamed = await commit(currentCliEnvelope(older, { title: `Synthetic ${label} ledger, renamed` }));
    assert.equal(renamed.queued, renamed.chunks, label);
    assert.equal(outboxCount(brain), renamed.chunks, label);
    await drainToVerified(brain);
  }
  // Non-vacuity: this harness really reproduces D1's inflated counts, so the
  // assertions above would have failed on a receipt built from meta.changes.
  assert.ok(brain.writes.some((write) =>
    isReuseDecision(write.sql) && write.returned === 0 && write.changes > 0));
});

test("an identical re-send before the first projection is confirmed still queues every chunk", async (t) => {
  // "Already projected" is the whole license to skip. A chunk whose upsert is
  // still queued may not be in Vectorize yet, so it keeps today's behaviour.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const sourceId = "statements/not-yet-projected.pdf";
  const docUid = `${SOURCE}:${sourceId}`;
  const older = olderCliEnvelope(sourceId, syntheticLedger("pending"));
  await ingestBatch(brain, older);
  const queuedBefore = outboxRows(brain, docUid);
  const chunkCount = chunkRows(brain, docUid).length;
  assert.ok(chunkCount > 1);
  assert.deepEqual(queuedBefore, await expectedUpserts(docUid, chunkCount));
  const generationsBefore = outboxGenerations(brain, docUid);

  assert.equal((await ingestBatch(brain, currentCliEnvelope(older))).action, "updated");
  assert.deepEqual(outboxRows(brain, docUid), queuedBefore);
  // The rows alone look the same whether they were re-queued or left alone;
  // only a fresh generation proves the re-send re-queued every chunk.
  const generationsAfter = outboxGenerations(brain, docUid);
  assert.equal(generationsAfter.size, chunkCount);
  for (const [chunkUid, generation] of generationsAfter) {
    assert.ok(generation > generationsBefore.get(chunkUid), `${chunkUid} keeps a stale generation`);
  }
  const embeddedBefore = brain.log.embedded;
  await drainToVerified(brain);
  assert.equal(brain.log.embedded - embeddedBefore, chunkCount);
  await assertProjectionMatchesStoredChunks(brain, docUid);
});

test("an identical re-send whose batch never finalized is retried without re-embedding", async (t) => {
  // A D1 reset between staging and finalization (the P-13 class of failure)
  // leaves the document under a pending marker for the same content. Its
  // retry must still reuse the projected vectors, or every interrupted batch
  // re-embeds all of its documents.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const { older, docUid, before } = await loadProjectedOlderDocument(
    brain, "statements/interrupted-finalize.pdf", syntheticLedger("interrupted"),
  );
  const staged = await storeFor(brain.env).ingest(brain.env, currentCliEnvelope(older), { deferFinalize: true });
  assert.ok(staged.deferred_revision, "the staged revision was never finalized");
  assert.match(documentRow(brain, docUid).content_hash, /^pending:/);
  assert.equal(outboxCount(brain), 0);
  const embeddedBefore = brain.log.embedded;

  assert.equal((await ingestBatch(brain, currentCliEnvelope(older))).action, "updated");
  await assertBoundAndComplete(brain, docUid, before);
  assert.equal(outboxCount(brain), 0);
  await drainToVerified(brain);
  assert.equal(brain.log.embedded, embeddedBefore);
  await assertProjectionMatchesStoredChunks(brain, docUid);
});

test("an identical re-send interrupted part-way through its resumable writes is retried without re-embedding", async (t) => {
  // D1 rejects the second chunk slice of a 66-chunk rewrite. The first 50
  // chunks are already updated in place under the interrupted revision and
  // the rest are untouched, so every stored row still matches Vectorize and
  // the retry has nothing to queue.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const { older, docUid, before } = await loadProjectedOlderDocument(
    brain, "statements/interrupted-slices.pdf", syntheticLedger("slices", 700),
  );
  let slices = 0;
  brain.control.rejectBatch = (statements) =>
    statements.some((statement) => isReuseDecision(statement.sql)) && ++slices === 2;
  const response = await brain.fixture.post(
    "/api/admin/brain/ingest/batch", { docs: [currentCliEnvelope(older)] }, ADMIN,
  );
  const interrupted = await response.json();
  brain.control.rejectBatch = null;
  assert.equal(interrupted.failed, 1, JSON.stringify(interrupted));
  assert.equal(slices, 2);
  const partial = documentRow(brain, docUid);
  assert.match(partial.content_hash, /^pending:/);
  assert.equal(chunkRows(brain, docUid).filter((chunk) =>
    chunk.bound_document_revision_id === partial.document_revision_id).length, 50,
  "the first slice committed under the interrupted revision");
  assert.equal(outboxCount(brain), 0);
  const embeddedBefore = brain.log.embedded;

  assert.equal((await ingestBatch(brain, currentCliEnvelope(older))).action, "updated");
  await assertBoundAndComplete(brain, docUid, before);
  assert.equal(outboxCount(brain), 0);
  await drainToVerified(brain);
  assert.equal(brain.log.embedded, embeddedBefore);
  await assertProjectionMatchesStoredChunks(brain, docUid);
});

for (const arm of [
  { name: "atomic batch stage", ingest: ingestBatch },
  { name: "single-document route", ingest: ingestSingle },
]) {
  test(`(b) ${arm.name}: changed content queues every chunk exactly as before`, async (t) => {
    const brain = await createBrain();
    t.after(() => brain.fixture.close());
    const { older, docUid } = await loadProjectedOlderDocument(
      brain, "statements/changed-content.pdf", syntheticLedger("original"), arm.ingest,
    );
    const changed = currentCliEnvelope(older, { content: syntheticLedger("revised") });
    assert.equal((await arm.ingest(brain, changed)).action, "updated");
    await assertEveryChunkQueuedAndReprojected(brain, docUid);
  });

  test(`(c) ${arm.name}: a changed title changes every chunk header and queues every chunk`, async (t) => {
    const brain = await createBrain();
    t.after(() => brain.fixture.close());
    const { older, docUid } = await loadProjectedOlderDocument(
      brain, "statements/changed-title.pdf", syntheticLedger("titled"), arm.ingest,
    );
    const retitled = currentCliEnvelope(older, { title: "Synthetic fixture ledger, renamed" });
    assert.equal((await arm.ingest(brain, retitled)).action, "updated");
    assert.ok(chunkRows(brain, docUid).every((chunk) =>
      chunk.text.startsWith("[Synthetic fixture ledger, renamed]\n\n")));
    await assertEveryChunkQueuedAndReprojected(brain, docUid);
  });

  for (const [field, patch] of [
    ["client", { metadata: { client_name: "Fixture Client B" } }],
    ["category", { metadata: { category: "fixture-taxes" } }],
    ["top_folder", { metadata: { top_folder: "Fixture Archive" } }],
    ["platform", { metadata: { platform: "fixture-dropbox" } }],
    ["document_date", { occurred_at: "2026-03-31" }],
  ]) {
    test(`(d) ${arm.name}: a changed ${field} changes vector metadata and queues every chunk`, async (t) => {
      const brain = await createBrain();
      t.after(() => brain.fixture.close());
      const { older, docUid } = await loadProjectedOlderDocument(
        brain, `statements/changed-${field}.pdf`, syntheticLedger(field), arm.ingest,
      );
      const before = chunkRows(brain, docUid);
      assert.equal((await arm.ingest(brain, currentCliEnvelope(older, patch))).action, "updated");
      const after = chunkRows(brain, docUid);
      assert.ok(after.every((chunk, index) => chunk.text === before[index].text),
        "the embedded text is identical, so only the metadata changed");
      assert.ok(after.every((chunk, index) => chunk[field] !== before[index][field]), field);
      await assertEveryChunkQueuedAndReprojected(brain, docUid);
    });
  }
}

test("(d) the same content under a different source is a new document and queues every chunk", async (t) => {
  // Source is part of document identity (doc_uid is "<source>:<id>"), so
  // there is no stored chunk to reuse and nothing about the first copy moves.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const { older, docUid } = await loadProjectedOlderDocument(
    brain, "statements/changed-source.pdf", syntheticLedger("source"),
  );
  const firstCopyVectors = chunkRows(brain, docUid).length;
  const moved = currentCliEnvelope(older, { source_type: "fixturedocs" });
  assert.equal((await ingestBatch(brain, moved)).action, "created");
  const movedUid = "fixturedocs:statements/changed-source.pdf";
  assert.deepEqual(outboxRows(brain, docUid), []);
  await assertEveryChunkQueuedAndReprojected(brain, movedUid);
  assert.equal(brain.visible.size, firstCopyVectors * 2);
});

test("(e) the result-family seal records immediately after a no-re-embed rebind", async (t) => {
  // The seal needs a verified projection, an empty queue, count parity, and a
  // production retrieval that cites the exact bound family. An unqueued rebind
  // keeps all four, so the gate passes with no drain and no embedding call.
  // Before this change the same re-send left the family's chunks queued and the
  // seal refused with source_original_result_family_vector_unready.
  const brain = await createBrain();
  t.after(() => brain.fixture.close());
  const sourceId = "statements/family-proof.pdf";
  const { older, docUid } = await loadProjectedOlderDocument(brain, sourceId, syntheticLedger("family"));
  const upsertsBefore = brain.log.upserted.length;
  const embeddedBefore = brain.log.embedded;

  assert.equal((await ingestBatch(brain, currentCliEnvelope(older))).action, "updated");
  assert.equal(outboxCount(brain), 0);

  const response = await brain.fixture.post(SOURCE_ORIGINAL_OBSERVATION_PATH, {
    contract_version: 1,
    mode: "result_family",
    source: SOURCE,
    locator_kind: "source_relative_path",
    locator: sourceId,
    original_content_sha256: RAW_SHA,
    original_byte_count: RAW_BYTES,
    retrieval_query: "fixture family entry reconciliation",
  }, ADMIN);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.recorded, true);
  assert.equal(body.document_count, 1);
  assert.equal(body.chunk_count, chunkRows(brain, docUid).length);
  const verification = brain.fixture.first(
    `SELECT vector_projection_status, expected_vector_count, actual_vector_count,
            target_outbox_count, global_outbox_count
       FROM source_original_result_family_verifications`,
  );
  assert.deepEqual({ ...verification }, {
    vector_projection_status: "verified",
    expected_vector_count: brain.visible.size,
    actual_vector_count: brain.visible.size,
    target_outbox_count: 0,
    global_outbox_count: 0,
  });
  assert.equal(brain.log.upserted.length, upsertsBefore);
  assert.equal(brain.log.embedded, embeddedBefore);
});
