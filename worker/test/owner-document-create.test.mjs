/**
 * documentCreate against the real D1 schema and Worker route: the concurrent-
 * insert recovery mirrored from entityCreate, and the corpus_doc_uid existence
 * check.
 *
 * The race tests fake the D1 binding the way product-contract-fixture.mjs
 * already fakes it for the rest of the suite, but one layer up: they wrap
 * `env.DB.prepare` so the very FIRST read matching a chosen query returns
 * nothing, while every later call to that same query (and the real INSERT
 * batch) hits the real in-memory SQLite. That reproduces "the pre-check saw
 * nothing, the insert then hit the unique index" without timing-dependent
 * concurrency, and it does it with the real unique index doing the real
 * conflicting work, not a fabricated throw.
 *
 * Each race test also asserts that the INSERT was actually attempted (via the
 * fixture's `seen.sql` log) before trusting the final response. Without that,
 * a broken deception wrapper could make the test pass for the wrong reason:
 * the ordinary pre-check already returns the same conflict code for a row
 * that was there from the start.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProductFixture, json } from "./product-contract-fixture.mjs";

const PATH = "/api/owner/documents/create";

const REPLAY_FOR_PATTERN = /FROM owner_action_requests WHERE tenant_id = \?1 AND request_id = \?2/;
const FIN_DOC_EXISTS_PATTERN = /FROM fin_documents\s+WHERE tenant_id=\?1 AND fin_doc_uid=\?2/;

const minimalBody = (requestId, finDocUid, overrides = {}) => ({
  request_id: requestId,
  fin_doc_uid: finDocUid,
  doc_kind: "statement",
  title: `Title ${finDocUid}`,
  custody_class: "reference",
  availability: "have_it",
  filed_at: "2026-01-31",
  ...overrides,
});

async function ownerCreate(fixture, body) {
  return fixture.post(PATH, body, await fixture.ownerHeaders());
}

/**
 * Wraps a D1 binding so the FIRST `.first()` call whose SQL text matches a
 * given pattern returns null, independently per pattern. Every other call —
 * including a second call matching the same pattern, and every `.batch()` —
 * passes straight through to the real database untouched.
 */
function deceiveFirstReads(realDB, patterns) {
  const remaining = new Set(patterns);
  return {
    ...realDB,
    prepare(sql) {
      const real = realDB.prepare(sql);
      const hit = [...remaining].find((pattern) => pattern.test(sql));
      if (!hit) return real;
      return {
        ...real,
        bind(...args) {
          const bound = real.bind(...args);
          return {
            ...bound,
            first: async () => {
              if (remaining.has(hit)) {
                remaining.delete(hit);
                return null;
              }
              return bound.first();
            },
          };
        },
      };
    },
  };
}

const insertWasAttempted = (fixture) =>
  fixture.seen.sql.some((sql) => /INSERT INTO fin_documents/.test(sql));

test("a concurrent duplicate of the SAME request replays instead of reporting unavailable", async () => {
  const fixture = await createProductFixture();
  try {
    const body = minimalBody("race_replay", "race-doc-replay");

    // The "winning" concurrent request, committed for real before the deception
    // is installed, so its stored request_hash and response_json are exactly
    // what the real route produces — not something this test has to fake.
    const winner = await json(await ownerCreate(fixture, body));
    assert.equal(winner.response.status, 201,
      `CONTROL FAILED — the winning request must succeed: ${JSON.stringify(winner.body)}`);

    // The "losing" request: byte-identical body, same request_id. Its own
    // pre-check must see nothing (as if it raced the winner and lost), forcing
    // it into the real INSERT, which the real unique index then refuses.
    fixture.env.DB = deceiveFirstReads(fixture.env.DB, [REPLAY_FOR_PATTERN, FIN_DOC_EXISTS_PATTERN]);
    const loser = await json(await ownerCreate(fixture, body));

    assert.ok(insertWasAttempted(fixture),
      "CONTROL FAILED — the insert was never attempted, so this did not test the race at all");
    assert.equal(loser.response.status, 200, JSON.stringify(loser.body));
    assert.equal(loser.body.replayed, true);
    assert.deepEqual(loser.body.document, winner.body.document);

    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM fin_documents WHERE fin_doc_uid='race-doc-replay'").n, 1,
      "the loser must not have written a second row");
    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='race_replay'").n, 1);
  } finally {
    fixture.close();
  }
});

test("a concurrent duplicate that lost a DIFFERENT request's race returns the same conflict the pre-check returns", async () => {
  const fixture = await createProductFixture();
  try {
    // Simulate a different request having already won the race for this
    // fin_doc_uid: insert its row directly, bypassing the route entirely (so
    // there is deliberately no owner_action_requests receipt for it either).
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, doc_kind, title, custody_class, availability,
          filed_at, readable, restricted, provenance, basis_state, recorded_at)
       VALUES ('primary','race-doc-conflict','statement','Winner Title','reference','have_it',
               '2026-01-31',1,0,'owner_stated','confirmed','2026-09-23T00:00:00Z')`,
    );

    const body = minimalBody("race_conflict", "race-doc-conflict", { title: "Loser Title" });
    fixture.env.DB = deceiveFirstReads(fixture.env.DB, [FIN_DOC_EXISTS_PATTERN]);
    const result = await json(await ownerCreate(fixture, body));

    assert.ok(insertWasAttempted(fixture),
      "CONTROL FAILED — the insert was never attempted, so this did not test the race at all");
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.deepEqual(result.body, { error: "conflict", code: "document_already_exists" });

    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM fin_documents WHERE fin_doc_uid='race-doc-conflict'").n, 1,
      "the loser must not have written a duplicate row");
    assert.equal(
      fixture.first("SELECT title FROM fin_documents WHERE fin_doc_uid='race-doc-conflict'").title,
      "Winner Title", "the winner's row must be untouched");
    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='race_conflict'").n, 0,
      "the loser must not have written a receipt");
    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events WHERE request_id='race_conflict'").n, 0,
      "the loser must not have written an activity event");
  } finally {
    fixture.close();
  }
});

test("an unknown corpus_doc_uid is rejected and no row is written", async () => {
  const fixture = await createProductFixture();
  try {
    const body = minimalBody("corpus_missing", "doc-corpus-missing", {
      corpus_doc_uid: "drive:does-not-exist",
    });
    const result = await json(await ownerCreate(fixture, body));
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
    assert.deepEqual(result.body, {
      error: "invalid_request", code: "corpus_document_not_found", field: "corpus_doc_uid",
    });
    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM fin_documents WHERE fin_doc_uid='doc-corpus-missing'").n, 0);
    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='corpus_missing'").n, 0);
  } finally {
    fixture.close();
  }
});

test("a soft-deleted corpus document is rejected the same as one that never existed", async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, deleted_at)
       VALUES ('drive:soft-deleted-1', 'google-drive', 'file-999', 'Removed Doc', 1700000000, 'deadbeef', 1700000500)`,
    );
    const body = minimalBody("corpus_deleted", "doc-corpus-deleted", {
      corpus_doc_uid: "drive:soft-deleted-1",
    });
    const result = await json(await ownerCreate(fixture, body));
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, "corpus_document_not_found");
    assert.equal(
      fixture.first("SELECT COUNT(*) AS n FROM fin_documents WHERE fin_doc_uid='doc-corpus-deleted'").n, 0);
  } finally {
    fixture.close();
  }
});

test("an existing, live corpus_doc_uid is accepted", async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
       VALUES ('drive:exists-123', 'google-drive', 'file-123', 'Existing Corpus Doc', 1700000000, 'deadbeef')`,
    );
    const body = minimalBody("corpus_present", "doc-corpus-present", {
      corpus_doc_uid: "drive:exists-123",
    });
    const result = await json(await ownerCreate(fixture, body));
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.document.corpus_doc_uid, "drive:exists-123");
    assert.equal(
      fixture.first("SELECT corpus_doc_uid FROM fin_documents WHERE fin_doc_uid='doc-corpus-present'").corpus_doc_uid,
      "drive:exists-123");
  } finally {
    fixture.close();
  }
});
