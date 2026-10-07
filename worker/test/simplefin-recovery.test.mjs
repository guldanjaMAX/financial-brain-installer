import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { runRestartSafeMigrationStatements, splitStatements } from "../../brain.mjs";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import {
  claimSimpleFinAccess, runSimpleFinMaintenance, assignSimpleFinAccountEntity,
  promoteSimpleFinWindows,
} from "../src/lib/simplefin-bank-feed.js";

const NOW = "2026-10-07T12:00:00.000Z";
const response = (value) => Response.json(value);
function payload(count = 1, partial = false) {
  return { errlist: partial ? ["temporary provider gap"] : [], accounts: [{
    id: "fixture-account", name: "Fixture account", currency: "USD", balance: "20.00",
    "balance-date": 1791374400,
    transactions: Array.from({ length: count }, (_, n) => ({
      id: `fixture-transaction-${n}`, posted: Date.parse("2024-10-10T12:00:00.000Z") / 1000,
      amount: "-1.00", description: "Fixture transaction",
    })),
  }] };
}
async function fixture() {
  return createProductFixture({ env: { BANK_FEED_PROVIDER: "simplefin", BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${randomBytes(32).toString("base64url")}` } });
}
function accessUrl() {
  const url = new URL("https://provider.invalid/feed");
  url.username = randomBytes(8).toString("hex");
  url.password = randomBytes(8).toString("hex");
  return url;
}
async function connected(f) {
  let claims = 0;
  const claim = await claimSimpleFinAccess(f.env, {
    requestId: "offline-claim-request-0001", now: NOW,
    setupToken: btoa("https://provider.invalid/claim"),
    fetchImpl: async () => { claims++; return new Response(accessUrl().href); },
  });
  assert.equal(claim.status, 201);
  assert.equal(claims, 1);
  return claim.body.item_ref;
}
async function assign(f) {
  if (!f.first("SELECT 1 AS present FROM fin_entities WHERE entity_slug='owner-business'")) {
    seedOwnedEntity(f, "owner-business", "Owner business");
  }
  return assignSimpleFinAccountEntity(f.env, {
    request_id: "offline-assignment-0001",
    account_ref: f.first("SELECT account_ref FROM simplefin_account_assignments").account_ref,
    entity_slug: "owner-business",
  }, { now: NOW });
}
function due(f) { f.raw("UPDATE simplefin_connections SET next_pull_at='2000-01-01'"); }
function ledger(f, count) {
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions").n, count, "exact ledger row count");
  assert.equal(f.first("SELECT COUNT(DISTINCT txn_uid) n FROM fin_transactions").n, count, "zero duplicates");
}
function pull(f, value, fetchImpl = null) {
  return runSimpleFinMaintenance(f.env, { now: NOW, maxRequestsPerItem: 1,
    fetchImpl: fetchImpl || (async () => response(value)) });
}

test("RR-01: claim and pull construct native Requests with explicit Basic auth and manual redirects", async () => {
  const f = await fixture();
  const claimUrl = accessUrl(); claimUrl.pathname = "/claim";
  const access = accessUrl();
  const calls = [];
  try {
    const fetchImpl = async (input, init) => {
      // Construct exactly what the runtime would receive, before simulating the provider.
      const request = new Request(input, init);
      calls.push(request.method);
      const url = new URL(request.url);
      assert.equal(url.username, ""); assert.equal(url.password, "");
      assert.equal(request.redirect, "manual");
      const source = request.method === "POST" ? claimUrl : access;
      assert.ok(request.headers.get("Authorization") === `Basic ${btoa(`${source.username}:${source.password}`)}`,
        "authorization matches without exposing its value in assertion output");
      return request.method === "POST" ? new Response(access.href) : response(payload());
    };
    const result = await claimSimpleFinAccess(f.env, { requestId: "native-request-claim-0001",
      setupToken: btoa(claimUrl.href), now: NOW, fetchImpl });
    assert.equal(result.status, 201);
    assert.equal((await pull(f, null, fetchImpl)).items[0].ok, true);
    assert.deepEqual(calls, ["POST", "GET"]);
  } finally { f.close(); }
});

test("RR-01: deterministic construction failure never consumes a claim; transport loss remains unknown", async () => {
  const f = await fixture();
  const NativeRequest = globalThis.Request;
  let constructions = 0, dispatches = 0;
  const options = { requestId: "construction-claim-0001", now: NOW,
    setupToken: btoa("https://provider.invalid/claim"),
    fetchImpl: async () => { dispatches++; return new Response(accessUrl().href); } };
  try {
    globalThis.Request = class { constructor() { constructions++; throw new TypeError("fixture construction failure"); } };
    await assert.rejects(claimSimpleFinAccess(f.env, options), { code: "simplefin_claim_request_invalid" });
    assert.equal(constructions, 1, "request construction decision reached");
    assert.equal(dispatches, 0);
    assert.equal(f.first("SELECT COUNT(*) n FROM simplefin_claim_operations").n, 0);
    globalThis.Request = NativeRequest;
    assert.equal((await claimSimpleFinAccess(f.env, options)).status, 201, "green control: same request remains usable");
    let attempts = 0;
    const lost = { ...options, requestId: "transport-loss-claim-0001",
      setupToken: btoa("https://provider.invalid/another-claim"),
      fetchImpl: async () => { attempts++; throw new Error("fixture transport lost"); } };
    await assert.rejects(claimSimpleFinAccess(f.env, lost), { code: "simplefin_claim_outcome_unknown" });
    await assert.rejects(claimSimpleFinAccess(f.env, lost), { code: "simplefin_claim_outcome_unknown" });
    assert.equal(attempts, 1, "unknown remote outcome is not retried");
  } finally { globalThis.Request = NativeRequest; f.close(); }
});

test("RR-01: redirect responses are explicit refusals and never followed or re-claimed", async () => {
  const f = await fixture();
  let calls = 0;
  const redirect = async () => { calls++; return new Response(null, { status: 302,
    headers: { Location: "https://redirect.invalid/refused" } }); };
  const options = { requestId: "redirect-claim-request-0001", now: NOW,
    setupToken: btoa("https://provider.invalid/redirect-claim"), fetchImpl: redirect };
  try {
    await assert.rejects(claimSimpleFinAccess(f.env, options), { code: "simplefin_claim_refused" });
    await assert.rejects(claimSimpleFinAccess(f.env, options), { code: "simplefin_claim_refused" });
    assert.equal(calls, 1, "provider redirect reached exactly once");
    await connected(f);
    const result = await pull(f, null, redirect);
    assert.equal(calls, 2, "pull redirect reached");
    assert.equal(result.items[0].code, "simplefin_pull_refused");
    due(f);
    assert.equal((await pull(f, payload())).items[0].ok, true, "green control: normal response stages");
  } finally { f.close(); }
});

test("RR-02 control: complete first response promotes both historical transactions", async () => {
  const f = await fixture();
  try {
    await connected(f);
    const start = f.first("SELECT backfill_next FROM simplefin_connections").backfill_next;
    assert.equal((await pull(f, payload(2))).items[0].ok, true);
    assert.equal(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next, start,
      "a fully staged response alone does not advance history");
    await assign(f);
    ledger(f, 2);
    assert.ok(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next > start);
  } finally { f.close(); }
});

test("RR-02: a competing maintenance revision fences stale staging and stale ledger writers", async () => {
  for (const boundary of ["staging", "ledger"]) {
    const f = await fixture();
    const originalBatch = f.env.DB.batch.bind(f.env.DB);
    let raced = 0;
    try {
      await connected(f);
      await pull(f, payload(1, true)); await assign(f); ledger(f, 1);
      const before = f.first("SELECT revision FROM simplefin_sync_windows").revision;
      const newer = payload(125);
      newer.accounts[0].transactions[0].amount = "-2.00";
      due(f);
      f.env.DB.batch = async (statements) => {
        const matches = boundary === "staging"
          ? statements.some((s) => /INSERT INTO simplefin_stage_transactions/.test(s.sql))
          : statements.some((s) => /INSERT INTO fin_transactions/.test(s.sql));
        if (!raced && matches) {
          raced++;
          // The newer response wins publication and promotion while the older
          // invocation still holds its captured data and prepared statements.
          const winner = await pull(f, newer);
          assert.equal(winner.items[0].ok, true);
          ledger(f, 125);
        }
        return originalBatch(statements);
      };
      const loser = await pull(f, payload(123));
      assert.equal(raced, 1, `${boundary} race decision reached`);
      assert.equal(loser.items[0].ok, false, "superseded writes fail closed");
      ledger(f, 125);
      assert.equal(f.first("SELECT raw_amount_minor FROM fin_transactions WHERE external_id='fixture-transaction-0'").raw_amount_minor, -200,
        "stale import cannot overwrite the winning revision");
      const window = f.first("SELECT * FROM simplefin_sync_windows");
      assert.notEqual(window.revision, before);
      assert.equal(window.revision, window.staging_revision);
      assert.equal(window.state, "promoted");
      assert.ok(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next > window.window_end);
    } finally { f.env.DB.batch = originalBatch; f.close(); }
  }
});

test("RR-02: a late older provider response cannot replace newer history awaiting assignment", async () => {
  const f = await fixture(); let olderCalls = 0, newerCalls = 0;
  try {
    await connected(f);
    const start = f.first("SELECT backfill_next FROM simplefin_connections").backfill_next;
    const older = await pull(f, null, async () => {
      olderCalls++;
      const newer = await pull(f, null, async () => { newerCalls++; return response(payload(125)); });
      assert.equal(newer.items[0].ok, true, "newer response is fully staged");
      assert.equal(f.first("SELECT COUNT(*) n FROM simplefin_stage_transactions").n, 125);
      ledger(f, 0); // No owner assignment yet, so staging is the only durable history.
      return response(payload(123));
    });
    assert.equal(olderCalls, 1); assert.equal(newerCalls, 1);
    assert.equal(older.items[0].ok, false, "an older in-flight response cannot supersede newer staged history");
    assert.equal(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next, start);
    await assign(f); ledger(f, 125);
    assert.ok(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next > start);
  } finally { f.close(); }
});

test("RR-02: missing promotion receipt rolls back cursor advance and replay repairs exactly", async () => {
  const f = await fixture();
  const originalBatch = f.env.DB.batch.bind(f.env.DB);
  let receiptWrites = 0;
  try {
    await connected(f); await pull(f, payload(1, true)); await assign(f); ledger(f, 1);
    const start = f.first("SELECT backfill_next FROM simplefin_connections").backfill_next;
    due(f);
    f.env.DB.batch = async (statements) => originalBatch(statements.map((statement) => {
      if (/UPDATE simplefin_sync_windows SET state='promoted'/.test(statement.sql)) {
        receiptWrites++;
        return f.env.DB.prepare("SELECT 1 AS fixture_suppressed_write");
      }
      return statement;
    }));
    assert.equal((await pull(f, payload(123))).items[0].ok, false);
    assert.equal(receiptWrites, 1, "the real promotion decision was reached");
    assert.equal(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next, start);
    assert.equal(f.first("SELECT state FROM simplefin_sync_windows").state, "staged");
    ledger(f, 123);
    f.env.DB.batch = originalBatch; due(f);
    assert.equal((await pull(f, payload(123))).items[0].ok, true, "green control: receipt permits progress");
    ledger(f, 123);
    assert.ok(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next > start);
  } finally { f.env.DB.batch = originalBatch; f.close(); }
});

test("RR-02: concurrent assignment promotion cannot double-count its window receipt", async () => {
  const f = await fixture();
  const originalBatch = f.env.DB.batch.bind(f.env.DB);
  let raced = 0;
  try {
    await connected(f); await pull(f, payload(123));
    f.env.DB.batch = async (statements) => {
      if (!raced && statements.some((s) => /UPDATE simplefin_sync_windows SET state='promoted'/.test(s.sql))) {
        raced++;
        await promoteSimpleFinWindows(f.env, { now: NOW });
      }
      return originalBatch(statements);
    };
    await assert.rejects(assign(f));
    assert.equal(raced, 1, "two real promoters reached the same receipt");
    ledger(f, 123);
    assert.equal(f.first("SELECT pages_done FROM bank_feed_backfill").pages_done, 1);
    f.env.DB.batch = originalBatch;
    await assign(f); // Exact assignment replay returns its durable response.
    await promoteSimpleFinWindows(f.env, { now: NOW }); ledger(f, 123);
    assert.equal(f.first("SELECT pages_done FROM bank_feed_backfill").pages_done, 1);
  } finally { f.env.DB.batch = originalBatch; f.close(); }
});

test("0051 resumes at every boundary and recovers legacy cursors without removing history", async () => {
  const statements = splitStatements(readFileSync(new URL("../../migrations/d1/0051_simplefin_window_revisions.sql", import.meta.url), "utf8"));
  assert.ok(statements.length > 4, "migration has both schema and recovery decisions");
  for (let boundary = 0; boundary < statements.length; boundary++) {
    const f = await fixture();
    try {
      await connected(f); await pull(f, payload(1, true)); await assign(f); ledger(f, 1);
      const start = f.first("SELECT backfill_start FROM simplefin_connections").backfill_start;
      // Model a pre-fix cursor that advanced after a partial window had already
      // been promoted. Remove only the four new columns from this synthetic DB.
      f.raw("UPDATE simplefin_connections SET backfill_next='2027-01-01'");
      f.raw("UPDATE bank_feed_backfill SET state='complete',finished_at='2026-10-07'");
      f.raw("ALTER TABLE simplefin_sync_windows DROP COLUMN revision");
      f.raw("ALTER TABLE simplefin_sync_windows DROP COLUMN staging_revision");
      f.raw("ALTER TABLE simplefin_stage_accounts DROP COLUMN revision");
      f.raw("ALTER TABLE simplefin_stage_transactions DROP COLUMN revision");
      const query = async (sql) => {
        if (/^\s*PRAGMA/i.test(sql)) return { results: f.rows(sql) };
        f.raw(sql); return { results: [] };
      };
      let reached = 0;
      await assert.rejects(runRestartSafeMigrationStatements(statements, query, {
        afterStatement: ({ index }) => { if (index === boundary) { reached++; throw new Error("fixture migration interruption"); } },
      }), /fixture migration interruption/);
      assert.equal(reached, 1);
      await runRestartSafeMigrationStatements(statements, query);
      assert.equal(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next, start);
      assert.equal(f.first("SELECT state FROM bank_feed_backfill").state, "queued");
      ledger(f, 1);
      assert.equal(f.first("SELECT COUNT(*) n FROM simplefin_stage_transactions").n, 1);
      await promoteSimpleFinWindows(f.env, { now: NOW }); ledger(f, 1);
      assert.equal(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next, start,
        "legacy data cannot certify a new promotion before re-fetch");
      due(f); assert.equal((await pull(f, payload(2))).items[0].ok, true);
      ledger(f, 2);
      assert.ok(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next > start);
    } finally { f.close(); }
  }
});

test("RR-02: concurrent incomplete staging cannot race a backfill completion marker", async () => {
  const f = await fixture();
  const originalPrepare = f.env.DB.prepare.bind(f.env.DB);
  const originalBatch = f.env.DB.batch.bind(f.env.DB);
  let completionReached = 0, chunks = 0;
  try {
    await connected(f);
    f.raw("UPDATE simplefin_connections SET backfill_end='2024-12-31'");
    await pull(f, payload(2));
    f.env.DB.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (!/UPDATE bank_feed_backfill SET state='complete'/.test(sql)) return statement;
      return { ...statement, bind: (...params) => {
        const bound = statement.bind(...params);
        return { ...bound, run: async () => {
          if (!completionReached) {
            completionReached++;
            due(f);
            f.env.DB.batch = async (statements) => {
              if (statements.some((s) => /INSERT INTO simplefin_stage_transactions/.test(s.sql)) && ++chunks === 2) {
                throw new Error("fixture interrupted concurrent response");
              }
              return originalBatch(statements);
            };
            assert.equal((await pull(f, payload(123))).items[0].ok, false);
          }
          return bound.run();
        } };
      } };
    };
    await assign(f);
    assert.equal(completionReached, 1); assert.equal(chunks, 2);
    assert.equal(f.first("SELECT COUNT(*) n FROM simplefin_sync_windows WHERE revision<>staging_revision").n, 1);
    assert.notEqual(f.first("SELECT state FROM bank_feed_backfill").state, "complete",
      "completion must recheck pending revisions in its write transaction");
    ledger(f, 2);
    f.env.DB.prepare = originalPrepare; f.env.DB.batch = originalBatch; due(f);
    assert.equal((await pull(f, payload(123))).items[0].ok, true);
    ledger(f, 123);
    assert.equal(f.first("SELECT state FROM bank_feed_backfill").state, "complete");
  } finally { f.env.DB.prepare = originalPrepare; f.env.DB.batch = originalBatch; f.close(); }
});

// Reproduces the release review's partial-then-complete historical window.
test("RR-02: corrected partial history reaches the ledger before its cursor advances", async () => {
  const f = await fixture(); let calls = 0;
  try {
    await connected(f);
    const first = await pull(f, null, async () => { calls++; return response(payload(1, true)); });
    assert.equal(first.items[0].partial, true);
    await assign(f); ledger(f, 1);
    const before = f.first("SELECT backfill_next FROM simplefin_connections").backfill_next;
    due(f);
    const retry = await pull(f, null, async () => { calls++; return response(payload(2)); });
    assert.equal(calls, 2, "both provider decision points reached");
    assert.equal(retry.items[0].ok, true);
    assert.equal(f.first("SELECT COUNT(*) n FROM simplefin_stage_transactions").n, 2,
      "recovered transaction reached staging");
    const window = f.first("SELECT * FROM simplefin_sync_windows");
    assert.equal(window.state, "promoted");
    assert.ok(window.window_start <= "2024-10-10" && window.window_end >= "2024-10-10");
    ledger(f, 2);
    assert.ok(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next > before);
    await promoteSimpleFinWindows(f.env, { now: NOW }); ledger(f, 2);
  } finally { f.close(); }
});

test("RR-02: interrupted chunk staging cannot be promoted by assignment and replay has no duplicates", async () => {
  const f = await fixture();
  const originalBatch = f.env.DB.batch.bind(f.env.DB);
  let chunks = 0, assignmentReached = 0;
  try {
    await connected(f);
    f.env.DB.batch = async (statements) => {
      if (statements.some((s) => /INSERT INTO simplefin_stage_transactions/.test(s.sql))) {
        chunks++;
        if (chunks === 2) {
          assignmentReached++;
          await assign(f);
          ledger(f, 0);
          throw new Error("fixture interrupted staging");
        }
      }
      return originalBatch(statements);
    };
    const start = f.first("SELECT backfill_next FROM simplefin_connections").backfill_next;
    assert.equal((await pull(f, payload(123))).items[0].ok, false);
    assert.equal(chunks, 2, "failure reached the second real staging chunk");
    assert.equal(assignmentReached, 1);
    assert.equal(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next, start);
    ledger(f, 0);
    f.env.DB.batch = originalBatch; due(f);
    assert.equal((await pull(f, payload(123))).items[0].ok, true);
    ledger(f, 123);
    await promoteSimpleFinWindows(f.env, { now: NOW }); ledger(f, 123);
    assert.ok(f.first("SELECT backfill_next FROM simplefin_connections").backfill_next > start);
  } finally { f.env.DB.batch = originalBatch; f.close(); }
});
