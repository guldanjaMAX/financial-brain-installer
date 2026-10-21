import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

import { createProductFixture, QA_ROOT, seedOwnedEntity } from "./product-contract-fixture.mjs";

const NOW = Date.parse("2026-10-20T18:00:00.000Z");
const ADMIN_HEADERS = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });
const productRoot = () => resolve(process.env.PRODUCT_CONTRACT_ROOT || QA_ROOT);

async function intentModule() {
  return import(pathToFileURL(join(productRoot(), "worker/src/lib/query-intent.js")).href);
}

async function fixtureWithDocuments(t, documents, { now = NOW, timeZone = "UTC" } = {}) {
  t.mock.method(Date, "now", () => now);
  let drafts = 0;
  let verifiers = 0;
  const fixture = await createProductFixture({
    productRoot: productRoot(),
    env: {
      BRAIN_TIMEZONE: timeZone,
      AI: {
        async run(model, input) {
          if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          if (String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")) {
            verifiers++;
            return { response: { supported: true, complete: true, evidence: [1], reason: "fixture approval" } };
          }
          drafts++;
          return { response: "The in-window fixture record is current [1]." };
        },
      },
    },
  });
  fixture.raw(
    "INSERT INTO sources(name,kind,status,created_at) VALUES ('fixture-records','upload','ready',?)",
    new Date(now).toISOString(),
  );
  const response = await fixture.post("/api/admin/brain/ingest/batch", { docs: documents }, ADMIN_HEADERS(fixture));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map((row) => row.status), documents.map(() => "created"));
  fixture.env.VECTORIZE.query = async () => ({
    matches: fixture.rows("SELECT chunk_uid AS id FROM chunks ORDER BY document_date ASC"),
  });
  return { fixture, counts: { get drafts() { return drafts; }, get verifiers() { return verifiers; } } };
}

const record = (id, occurredAt, { reliable = true, content = "Fixture subject weekly update." } = {}) => ({
  source_type: "fixture-records",
  source_id: id,
  title: `Fixture record ${id}`,
  content,
  occurred_at: occurredAt,
  date_source: "fixture:recorded_at",
  date_reliable: reliable,
  text_source: "native",
  text_reliable: true,
  metadata: { evidence_lineage: { version: 1, kind: "source_record" } },
});

test("AR-05 retrieval windows use owner-local calendar boundaries and exclude non-retrieval periods", async () => {
  const { retrievalTimeWindow } = await intentModule();
  assert.equal(typeof retrievalTimeWindow, "function", "the retrieval-window decision point exists");
  const cases = [
    ["this week", "2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"],
    ["last week", "2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z"],
    ["this month", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    ["last month", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["past 10 days", "2026-10-10T00:00:00.000Z", "2026-10-21T00:00:00.000Z"],
    ["last 2 weeks", "2026-10-06T00:00:00.000Z", "2026-10-21T00:00:00.000Z"],
    ["last 1 month", "2026-09-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"],
  ];
  for (const [query, start, end] of cases) {
    const window = retrievalTimeWindow(query, { now: NOW, timeZone: "UTC" });
    assert.equal(new Date(window.start).toISOString(), start, query);
    assert.equal(new Date(window.end).toISOString(), end, query);
    assert.equal(window.timeZone, "UTC", query);
  }
  for (const query of ["every 2025 statement", "this quarter", "next 10 days", "my 2025 W-2"]) {
    assert.equal(retrievalTimeWindow(query, { now: NOW, timeZone: "UTC" }), null, query);
  }
  assert.equal(
    retrievalTimeWindow("this week", { now: NOW, timeZone: "Not/AZone" }).timeZone,
    "UTC",
    "an invalid IANA zone fails to UTC",
  );
});

test("AR-05 this week removes older and unreliably dated candidates after the real SQLite search", async (t) => {
  const { fixture, counts } = await fixtureWithDocuments(t, [
    record("older", "2026-10-01T12:00:00.000Z"),
    record("in-window", "2026-10-20T12:00:00.000Z"),
    record("unreliable", "2026-10-20T13:00:00.000Z", { reliable: false }),
  ]);
  try {
    const response = await fixture.post("/api/rag/think", {
      q: "What did the fixture subject say this week?",
      limit: 20,
    }, ADMIN_HEADERS(fixture));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.results.map((row) => row.source_id), ["in-window"]);
    assert.deepEqual(body.time_window, {
      from: "2026-10-19T00:00:00.000Z",
      to: "2026-10-25T23:59:59.999Z",
      time_zone: "UTC",
      basis: "question",
    });
    const disclosure = body.gaps.find((gap) => gap.type === "question_time_window");
    assert.equal(disclosure?.unreliable_records_dropped, 1);
    assert.match(disclosure?.detail || "", /only reliably dated records/i);
    assert.equal(counts.drafts, 1, "the filtered evidence reached answer generation");
    assert.equal(counts.verifiers, 1, "the filtered evidence reached verification");
  } finally {
    fixture.close();
  }
});

test("AR-05 an empty inferred window refuses instead of citing an older record", async (t) => {
  const { fixture, counts } = await fixtureWithDocuments(t, [
    record("older", "2026-10-01T12:00:00.000Z"),
  ]);
  try {
    const response = await fixture.post("/api/rag/think", {
      q: "What did the fixture subject say this week?",
    }, ADMIN_HEADERS(fixture));
    const body = await response.json();
    assert.equal(body.answer, null);
    assert.deepEqual(body.citations, []);
    assert.deepEqual(body.results, []);
    const gap = body.gaps.find((entry) => entry.type === "time_window_empty");
    assert.equal(gap?.from, "2026-10-19T00:00:00.000Z");
    assert.equal(gap?.to, "2026-10-25T23:59:59.999Z");
    assert.match(gap?.detail || "", /2026-10-19.*2026-10-25/);
    assert.equal(counts.drafts, 0, "out-of-window evidence never reached the answer model");
  } finally {
    fixture.close();
  }
});

test("AR-05 owner-local days can differ from UTC and caller ranges retain precedence", async (t) => {
  const localNow = Date.parse("2026-10-19T04:00:00.000Z");
  const { fixture } = await fixtureWithDocuments(t, [
    record("local-sunday", "2026-10-19T03:00:00.000Z"),
    record("local-monday", "2026-10-19T08:00:00.000Z"),
  ], { now: localNow, timeZone: "Etc/GMT+7" });
  try {
    const local = await fixture.post("/api/rag/unified", {
      q: "fixture subject this week",
      limit: 20,
    }, ADMIN_HEADERS(fixture));
    const localBody = await local.json();
    assert.deepEqual(localBody.results.map((row) => row.source_id), ["local-sunday"]);
    assert.deepEqual(localBody.time_window, {
      from: "2026-10-12T07:00:00.000Z",
      to: "2026-10-19T06:59:59.999Z",
      time_zone: "Etc/GMT+7",
      basis: "question",
    });

    const caller = await fixture.post("/api/rag/unified", {
      q: "fixture subject this week",
      from: "2026-10-19T07:00:00.000Z",
      to: "2026-10-20T06:59:59.999Z",
      limit: 20,
    }, ADMIN_HEADERS(fixture));
    const callerBody = await caller.json();
    assert.deepEqual(callerBody.results.map((row) => row.source_id), ["local-monday"]);
    assert.equal(callerBody.time_window, undefined, "the question does not replace a caller range");
    assert.equal(callerBody.gaps.some((gap) => gap.type === "question_time_window"), false);
  } finally {
    fixture.close();
  }
});

test("AR-05 questions without a retrieval time phrase keep the healthy no-match contract", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fixture = await createProductFixture({ productRoot: productRoot(), env: { BRAIN_TIMEZONE: "UTC" } });
  try {
    const response = await fixture.post("/api/rag/think", {
      q: "What does the fixture corpus say about an absent subject?",
    }, ADMIN_HEADERS(fixture));
    const body = await response.json();
    assert.equal(body.answer, null);
    assert.equal(body.time_window, undefined);
    assert.deepEqual(body.gaps.map((gap) => gap.type), ["no_results"]);

    const yearControl = await fixture.post("/api/rag/unified", {
      q: "every 2025 statement",
    }, ADMIN_HEADERS(fixture));
    const yearBody = await yearControl.json();
    assert.equal(yearBody.time_window, undefined);
  } finally {
    fixture.close();
  }
});

test("AR-05 ledger period questions are answered before prose adds retrieval filters", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fixture = await createProductFixture({ productRoot: productRoot(), env: { BRAIN_TIMEZONE: "UTC" } });
  try {
    seedOwnedEntity(fixture, "fixture-owner", "Fixture Owner");
    fixture.raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at,institution)
      VALUES ('fixture-checking','fixture-owner','checking','asset','0100','manual','owner_stated','confirmed',?,'Fixture Bank')`, new Date(NOW).toISOString());
    fixture.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('fixture-checking','complete','2026-09-01','2026-10-20',?,'owner_stated','confirmed',?)`,
    new Date(NOW).toISOString(), new Date(NOW).toISOString());
    fixture.raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
      VALUES ('fixture-deposit','fixture-checking','2026-09-15',12345,'inflow','Fixture deposit','owner_stated','confirmed',?)`,
    new Date(NOW).toISOString());
    const response = await fixture.post("/api/rag/think", {
      q: "How much money came in last month?",
    }, ADMIN_HEADERS(fixture));
    const body = await response.json();
    assert.equal(body.ledger?.kind, "totals", "the ledger decision point answered the period question");
    assert.equal(body.ledger.accounts[0].credits_minor, 12345);
    assert.equal(body.time_window, undefined, "document retrieval did not pre-fill ledger filters");
    assert.ok(fixture.seen.sql.some((sql) => /JOIN fin_transactions/.test(sql)), "the ledger read ran");
  } finally {
    fixture.close();
  }
});
