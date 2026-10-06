import test from "node:test";
import assert from "node:assert/strict";

import {
  createProductFixture,
  seedOwnedEntity,
} from "./product-contract-fixture.mjs";
import {
  completePlaidLink,
  createPlaidLinkToken,
  runPlaidFeedSlice,
} from "../src/lib/plaid-bank-feed.js";
import {
  BANK_ACTIVITY_DOCUMENT_CAP,
  writeBankActivityDocuments,
} from "../src/lib/bank-activity-doc.js";
import { coverageGapReport } from "../src/lib/store-d1.js";

const ORIGIN = "https://brain.invalid";
const PRIMARY_ENTITY = "mesa-coffee";
const SECONDARY_ENTITY = "desert-books";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

function settlingVectorize() {
  const stored = new Map();
  let mutation = 0;
  const receipt = () => ({ mutationId: `fixture-mutation-${mutation += 1}` });
  return {
    async query() { return { matches: [] }; },
    async upsert(rows) {
      for (const row of rows) stored.set(row.id, row);
      return receipt();
    },
    async deleteByIds(ids) {
      for (const id of ids) stored.delete(id);
      return receipt();
    },
    async getByIds(ids) {
      return ids.map((id) => stored.get(id)).filter(Boolean);
    },
    async describe() {
      return {
        vectorCount: stored.size,
        processedUpToMutation: mutation ? `fixture-mutation-${mutation}` : null,
      };
    },
  };
}

class BankActivityPlaidFake {
  constructor() {
    this.incremental = [];
    this.calls = [];
    this.cursor = 1;
  }

  queue(kind) {
    this.incremental.push(kind);
  }

  accounts() {
    return [
      {
        account_id: "account-checking-fixture",
        name: "Everyday checking",
        mask: "0042",
        type: "depository",
        subtype: "checking",
        balances: { current: "1200.25", available: "1100.00", iso_currency_code: "USD" },
      },
      {
        account_id: "account-card-fixture",
        name: "Everyday card",
        mask: "1177",
        type: "credit",
        subtype: "credit card",
        balances: { current: "315.20", available: "4684.80", iso_currency_code: "USD" },
      },
      {
        account_id: "account-retirement-fixture",
        name: "401k fixture",
        mask: "9001",
        type: "investment",
        subtype: "401k",
        balances: { current: "23631.9805", available: null, iso_currency_code: "USD" },
      },
    ];
  }

  initialTransactions() {
    return this.accounts().flatMap((account, accountIndex) => [
      {
        transaction_id: `september-${accountIndex}`,
        account_id: account.account_id,
        amount: accountIndex === 0 ? "-25.00" : "12.50",
        iso_currency_code: "USD",
        date: "2026-09-18",
        pending: false,
        name: accountIndex === 1 ? "Fixture card payment" : "Fixture Bakery Supply",
        merchant_name: accountIndex === 1 ? null : "Fixture Bakery Supply",
      },
      {
        transaction_id: `october-${accountIndex}`,
        account_id: account.account_id,
        amount: accountIndex === 2 ? "4.005" : "8.25",
        iso_currency_code: "USD",
        date: "2026-10-02",
        pending: false,
        name: "Sample Utility Co",
        merchant_name: "Sample Utility Co",
      },
    ]).concat({
      transaction_id: "pending-fixture",
      account_id: "account-checking-fixture",
      amount: "19.99",
      iso_currency_code: "USD",
      date: "2026-10-03",
      pending: true,
      name: "Pending fixture line",
    });
  }

  incrementalPage(kind) {
    const added = [];
    const removed = [];
    if (kind === "new") {
      added.push({
        transaction_id: `new-fixture-${this.cursor}`,
        account_id: "account-checking-fixture",
        amount: "6.75",
        iso_currency_code: "USD",
        date: "2026-10-04",
        pending: false,
        name: "Fixture Bakery Supply",
        merchant_name: "Fixture Bakery Supply",
      });
    }
    if (kind === "remove") removed.push({ transaction_id: "september-0" });
    return { added, modified: [], removed };
  }

  async fetch(input, init = {}) {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init.body || "{}"));
    this.calls.push(path);
    if (path === "/link/token/create") {
      return jsonResponse({
        link_token: "link-sandbox-bank-activity",
        expiration: "2099-10-05T00:00:00.000Z",
      });
    }
    if (path === "/item/public_token/exchange") {
      assert.equal(body.public_token, "public-sandbox-bank-activity");
      return jsonResponse({ item_id: "item-bank-activity", access_token: "access-bank-activity" });
    }
    if (path === "/accounts/get") return jsonResponse({ accounts: this.accounts() });
    if (path === "/transactions/sync") {
      if (!body.cursor) {
        return jsonResponse({
          added: this.initialTransactions(),
          modified: [],
          removed: [],
          next_cursor: "cursor-bank-activity-1",
          has_more: false,
          transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        });
      }
      const kind = this.incremental.shift() || "empty";
      const page = this.incrementalPage(kind);
      this.cursor += 1;
      return jsonResponse({
        ...page,
        next_cursor: `cursor-bank-activity-${this.cursor}`,
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected provider path ${path}`);
  }
}

async function newFixture() {
  const fixture = await createProductFixture({
    env: {
      VECTORIZE: settlingVectorize(),
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BANK_FEED_RECONCILE_MINUTES: "15",
      BRAIN_NAME: "Synthetic Contract Brain",
    },
  });
  seedOwnedEntity(fixture, PRIMARY_ENTITY, "Primary fixture entity");
  seedOwnedEntity(fixture, SECONDARY_ENTITY, "Secondary fixture entity");
  return fixture;
}

async function prepareBlocked(fixture, provider) {
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-10-05T12:00:00.000Z";
  const link = await createPlaidLinkToken(fixture.env, {
    url: `${ORIGIN}/app/connect/bank`,
    sessionRef: "bank-activity-link-request",
    fetchImpl,
    now: stamp,
  });
  await completePlaidLink(fixture.env, {
    sessionRef: link.session_ref,
    publicToken: "public-sandbox-bank-activity",
    institutionRef: "ins_bank_activity",
    institutionLabel: "Synthetic Fixture Bank",
    fetchImpl,
    now: stamp,
  });
  fixture.raw(
    "UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z' WHERE item_ref='item-bank-activity'",
  );
  return runPlaidFeedSlice(fixture.env, { fetchImpl, now: stamp });
}

function assignDirectly(fixture) {
  const rows = fixture.rows(
    "SELECT provider_account_id FROM plaid_account_entity_assignments ORDER BY provider_account_id",
  );
  for (const row of rows) {
    const entity = row.provider_account_id.includes("retirement") ? SECONDARY_ENTITY : PRIMARY_ENTITY;
    fixture.raw(
      `UPDATE plaid_account_entity_assignments
          SET entity_slug=?,assigned_at='2026-10-05T12:05:00.000Z',updated_at='2026-10-05T12:05:00.000Z'
        WHERE provider_account_id=?`,
      entity,
      row.provider_account_id,
    );
  }
  fixture.raw(
    "UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z' WHERE item_ref='item-bank-activity'",
  );
}

async function runScheduled(fixture) {
  let work = null;
  await fixture.worker.scheduled({}, fixture.env, {
    waitUntil(promise) { work = promise; },
  });
  assert.ok(work, "the real scheduled handler must register its work");
  await work;
}

async function ownerPost(fixture, path, body) {
  return fixture.post(path, body, await fixture.ownerHeaders());
}

async function ownerGet(fixture, path) {
  return fixture.worker.fetch(new Request(`${ORIGIN}${path}`, {
    headers: { "X-Admin-Key": fixture.env.ADMIN_KEY },
  }), fixture.env, { waitUntil() {}, passThroughOnException() {} });
}

async function search(fixture, body) {
  const response = await fixture.post(
    "/api/rag/unified",
    { limit: 20, rerank: false, ...body },
    { "X-Admin-Key": fixture.env.ADMIN_KEY },
  );
  if (response.status !== 200) assert.fail(await response.text());
  return response.json();
}

async function drain(fixture) {
  const response = await fixture.post(
    "/api/admin/brain/drain",
    {},
    { "X-Admin-Key": fixture.env.ADMIN_KEY },
  );
  if (response.status !== 200) assert.fail(await response.text());
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM vector_outbox").n, 0);
}

async function promotedFixture() {
  const fixture = await newFixture();
  const provider = new BankActivityPlaidFake();
  const control = await prepareBlocked(fixture, provider);
  assert.equal(control.bank_activity.decision, "promotion_gate_checked");
  assert.equal(control.bank_activity.outcome, "no_committed_promotion");
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents WHERE source='bank_activity'").n, 0);
  assignDirectly(fixture);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = provider.fetch.bind(provider);
  try {
    await runScheduled(fixture);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents WHERE source='bank_activity'").n, 6);
  return { fixture, provider };
}

test("cron promotion writes dated searchable account-month documents and both negative controls reach their gates", async () => {
  const fixture = await newFixture();
  const provider = new BankActivityPlaidFake();
  const previousFetch = globalThis.fetch;
  try {
    const blocked = await prepareBlocked(fixture, provider);
    assert.equal(blocked.bank_activity.decision, "promotion_gate_checked");
    assert.equal(blocked.bank_activity.outcome, "no_committed_promotion");
    assert.equal(blocked.bank_activity.ingest_calls, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents WHERE source='bank_activity'").n, 0);

    const providerValue = fixture.env.BANK_FEED_PROVIDER;
    delete fixture.env.BANK_FEED_PROVIDER;
    const notPlaid = await writeBankActivityDocuments(fixture.env, { committedPromotions: 1 });
    fixture.env.BANK_FEED_PROVIDER = providerValue;
    assert.equal(notPlaid.decision, "promotion_gate_checked");
    assert.equal(notPlaid.outcome, "not_plaid");
    assert.equal(notPlaid.ingest_calls, 0);

    assignDirectly(fixture);
    globalThis.fetch = provider.fetch.bind(provider);
    await runScheduled(fixture);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents WHERE source='bank_activity'").n, 6);

    const september = await search(fixture, {
      q: "bank activity September 2026",
      source: "bank_activity",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    assert.equal(september.results.length, 3, JSON.stringify(september));
    assert.ok(september.results.every((row) => row.source_id.endsWith(":2026-09")));
    assert.ok(september.results.every((row) => !row.source_id.endsWith(":2026-10")));

    const stored = fixture.rows(
      "SELECT source_id,title,document_date,date_source,date_reliable,entity_slug,meta FROM documents WHERE source='bank_activity'",
    );
    for (const row of stored) {
      assert.match(row.source_id, /^acct_[a-f0-9]{32}:2026-(09|10)$/);
      assert.equal(row.date_reliable, 1);
      assert.ok(["bank_feed:latest_posted_on", "bank_feed:month_end_no_settled_rows"].includes(row.date_source));
      const lineage = JSON.parse(row.meta).evidence_lineage;
      assert.equal(lineage.kind, "derived_record");
      assert.equal(lineage.root_ids.length, 1);
    }
  } finally {
    globalThis.fetch = previousFetch;
    fixture.close();
  }
});

test("the final owner assignment waitUntil path writes the same documents", async () => {
  const fixture = await newFixture();
  const provider = new BankActivityPlaidFake();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = provider.fetch.bind(provider);
  try {
    await prepareBlocked(fixture, provider);
    const assignments = fixture.rows(
      "SELECT account_ref,provider_account_id FROM plaid_account_entity_assignments ORDER BY provider_account_id",
    );
    for (const assignment of assignments) {
      const response = await ownerPost(fixture, "/api/bank-feed/accounts/assign", {
        request_id: `assignment-${assignment.account_ref}`,
        account_ref: assignment.account_ref,
        entity_slug: assignment.provider_account_id.includes("retirement") ? SECONDARY_ENTITY : PRIMARY_ENTITY,
      });
      assert.equal(response.status, 201, await response.text());
    }
    assert.equal(fixture.waitUntil.length, 1);
    await Promise.all(fixture.waitUntil);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM documents WHERE source='bank_activity'").n, 6);
  } finally {
    globalThis.fetch = previousFetch;
    fixture.close();
  }
});

test("unchanged and one-row promotions are deterministic, while a removal rewrites zero activity", async () => {
  const { fixture, provider } = await promotedFixture();
  try {
    const queuedBefore = fixture.first("SELECT COUNT(*) AS n FROM vector_outbox").n;
    provider.queue("empty");
    fixture.raw("UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z'");
    const unchanged = await runPlaidFeedSlice(fixture.env, {
      fetchImpl: provider.fetch.bind(provider),
      now: "2026-10-05T13:00:00.000Z",
    });
    assert.equal(unchanged.bank_activity.ingest_calls, 6);
    assert.equal(unchanged.bank_activity.unchanged, 6);
    assert.equal(unchanged.bank_activity.updated, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM vector_outbox").n, queuedBefore);

    provider.queue("new");
    fixture.raw("UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z'");
    const changed = await runPlaidFeedSlice(fixture.env, {
      fetchImpl: provider.fetch.bind(provider),
      now: "2026-10-05T14:00:00.000Z",
    });
    assert.equal(changed.bank_activity.updated, 1);
    assert.equal(changed.bank_activity.unchanged, 5);

    provider.queue("remove");
    fixture.raw("UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z'");
    const removed = await runPlaidFeedSlice(fixture.env, {
      fetchImpl: provider.fetch.bind(provider),
      now: "2026-10-05T15:00:00.000Z",
    });
    assert.equal(removed.bank_activity.updated, 1);
    const septemberChecking = fixture.first(
      `SELECT c.text FROM documents d JOIN chunks c ON c.doc_uid=d.doc_uid AND c.chunk_ix=0
        WHERE d.source='bank_activity' AND d.source_id LIKE '%:2026-09'
          AND d.entity_slug=? AND d.title LIKE '%Everyday checking%' LIMIT 1`,
      PRIMARY_ENTITY,
    );
    assert.match(septemberChecking.text, /This month includes 0 settled transactions/);
  } finally {
    fixture.close();
  }
});

test("writer storage failure cannot alter the committed sync result or cursor", async () => {
  const control = await promotedFixture();
  const failing = await promotedFixture();
  try {
    control.provider.queue("new");
    failing.provider.queue("new");
    control.fixture.raw("UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z'");
    failing.fixture.raw("UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z'");
    failing.fixture.control.failOn = /^\s*INSERT INTO documents\b/;
    const [good, bad] = await Promise.all([
      runPlaidFeedSlice(control.fixture.env, {
        fetchImpl: control.provider.fetch.bind(control.provider),
        now: "2026-10-05T16:00:00.000Z",
      }),
      runPlaidFeedSlice(failing.fixture.env, {
        fetchImpl: failing.provider.fetch.bind(failing.provider),
        now: "2026-10-05T16:00:00.000Z",
      }),
    ]);
    assert.equal(good.items[0].status, "complete");
    assert.equal(bad.items[0].status, good.items[0].status);
    assert.equal(bad.items[0].ok, good.items[0].ok);
    assert.equal(bad.items[0].code, good.items[0].code);
    assert.equal(bad.bank_activity.failed > 0, true);
    assert.equal(
      failing.fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-bank-activity'").cursor,
      control.fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-bank-activity'").cursor,
    );
    assert.equal(
      failing.fixture.first("SELECT status FROM bank_feed_items WHERE item_ref='item-bank-activity'").status,
      control.fixture.first("SELECT status FROM bank_feed_items WHERE item_ref='item-bank-activity'").status,
    );
  } finally {
    control.fixture.close();
    failing.fixture.close();
  }
});

test("paused mode and a settled no-promotion pass write nothing and prove their decisions", async () => {
  const { fixture } = await promotedFixture();
  try {
    fixture.seen.sql.length = 0;
    fixture.seen.binds.length = 0;
    const noPromotion = await writeBankActivityDocuments(fixture.env, { committedPromotions: 0 });
    assert.equal(noPromotion.decision, "promotion_gate_checked");
    assert.equal(noPromotion.outcome, "no_committed_promotion");
    assert.equal(noPromotion.ingest_calls, 0);
    assert.ok(fixture.seen.sql.length <= 3);
    assert.equal(fixture.seen.sql.some((sql) => /(?:INSERT|UPDATE)\s+(?:documents|chunks|vector_outbox)/i.test(sql)), false);

    fixture.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
    const paused = await writeBankActivityDocuments(fixture.env, { committedPromotions: 1 });
    assert.equal(paused.decision, "promotion_gate_checked");
    assert.equal(paused.outcome, "paused");
    assert.equal(paused.ingest_calls, 0);
  } finally {
    fixture.close();
  }
});

test("coverage, freshness, health inventory, and entity scope remain honest through backfill", async () => {
  const fixture = await newFixture();
  const provider = new BankActivityPlaidFake();
  try {
    const control = await search(fixture, { q: "bank activity September 2026", source: "bank_activity" });
    assert.notEqual(control.status, "unavailable");
    assert.equal(control.degraded, undefined);

    await prepareBlocked(fixture, provider);
    assignDirectly(fixture);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = provider.fetch.bind(provider);
    try { await runScheduled(fixture); } finally { globalThis.fetch = previousFetch; }

    const accounts = fixture.rows(
      "SELECT account_slug,source_feed FROM fin_accounts WHERE feed_mode='live' ORDER BY account_slug",
    );
    for (const [accountIndex, account] of accounts.entries()) {
      for (const [monthIndex, month] of ["2026-07", "2026-06", "2026-05"].entries()) {
        fixture.raw(
          `INSERT INTO fin_transactions
             (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,pending,
              provenance,source_locator,source_feed,basis_state,recorded_at,source_provider)
           VALUES ('primary',?,?,?,?,?,'USD',0,'feed',?,?, 'confirmed',?,'plaid')`,
          `historical-${accountIndex}-${monthIndex}`,
          account.account_slug,
          `${month}-15`,
          1000 + accountIndex + monthIndex,
          monthIndex % 2 ? "inflow" : "outflow",
          "plaid/transactions/historical-fixture",
          account.source_feed,
          "2026-10-05T17:00:00.000Z",
        );
      }
    }
    const partial = await writeBankActivityDocuments(fixture.env, {
      committedPromotions: 1,
      at: "2026-10-05T17:01:00.000Z",
    });
    assert.equal(partial.ingest_calls, BANK_ACTIVITY_DOCUMENT_CAP);
    assert.equal(partial.complete_sweep, false);
    const mid = await coverageGapReport(fixture.env);
    const midBankGaps = mid.gaps.filter((gap) => gap.source === "bank_activity");
    assert.deepEqual(midBankGaps.map((gap) => gap.type), ["history_unproven"]);

    const firstCursor = JSON.parse(fixture.first(
      "SELECT sync_cursor FROM sources WHERE name='bank_activity'",
    ).sync_cursor);
    fixture.raw(
      `UPDATE bank_feed_items SET cursor='cursor-bank-activity-concurrent',
         cursor_updated_at='2026-10-05T17:01:30.000Z' WHERE item_ref='item-bank-activity'`,
    );
    fixture.raw(
      `UPDATE fin_transactions SET amount_minor=amount_minor+1,recorded_at='2026-10-05T17:01:30.000Z'
        WHERE txn_uid='plaid:october-0'`,
    );
    const restarted = await writeBankActivityDocuments(fixture.env, {
      committedPromotions: 1,
      at: "2026-10-05T17:02:00.000Z",
    });
    assert.equal(restarted.complete_sweep, false);
    assert.equal(restarted.updated, 1);
    const restartedCursor = JSON.parse(fixture.first(
      "SELECT sync_cursor FROM sources WHERE name='bank_activity'",
    ).sync_cursor);
    assert.notEqual(restartedCursor.ledger_marker, firstCursor.ledger_marker);

    const completed = await writeBankActivityDocuments(fixture.env, {
      committedPromotions: 1,
      at: "2026-10-05T17:03:00.000Z",
    });
    assert.equal(completed.complete_sweep, true);
    await drain(fixture);
    const after = await search(fixture, { q: "bank activity September 2026", source: "bank_activity" });
    assert.equal(after.status, control.status);
    assert.equal(after.degraded, control.degraded);
    assert.equal((after.gaps || []).some((gap) => gap.source === "bank_activity"), false);

    const primary = await search(fixture, {
      q: "Fixture Bakery Supply",
      source: "bank_activity",
      entity_slug: PRIMARY_ENTITY,
    });
    const secondary = await search(fixture, {
      q: "Fixture Bakery Supply",
      source: "bank_activity",
      entity_slug: SECONDARY_ENTITY,
    });
    assert.equal(primary.degraded, "vector");
    assert.equal(primary.degraded_reason, "entity-vector-authority-unindexed");
    assert.ok(primary.results.length > 0);
    assert.ok(primary.results.every((row) => row.entity_slug === PRIMARY_ENTITY));
    assert.ok(secondary.results.length > 0);
    assert.ok(secondary.results.every((row) => row.entity_slug === SECONDARY_ENTITY));

    const freshnessResponse = await ownerGet(fixture, "/api/admin/brain/freshness");
    assert.equal(freshnessResponse.status, 200);
    const freshness = await freshnessResponse.json();
    const bankSource = freshness.sources.find((source) => source.name === "bank_activity");
    assert.equal(bankSource.documents, 15);
    assert.equal(bankSource.state, "manual");
    assert.equal(bankSource.source_status, "ready");
    assert.equal(typeof bankSource.last_complete_sweep_at, "string");

    const documentsResponse = await ownerGet(fixture, "/api/admin/brain/documents");
    assert.equal(documentsResponse.status, 200);
    const documents = await documentsResponse.json();
    assert.match(JSON.stringify(documents), /bank_activity/);
  } finally {
    fixture.close();
  }
});
