import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { encryptAccessReference } from "../src/lib/bank-feed.js";
import { syncPlaidItem, runPlaidFeedSlice } from "../src/lib/plaid-bank-feed.js";
import { discoverPlaidAccountAssignments, assignPlaidAccountEntity } from "../src/lib/plaid-account-entities.js";
import {
  claimPlaidSyncLease, ownsPlaidSyncLease, renewPlaidSyncLease,
  releasePlaidSyncLease, runPlaidSyncBatch, PLAID_SYNC_LEASE_SECONDS, PLAID_SYNC_HARD_DEADLINE_SECONDS,
} from "../src/lib/plaid-sync-lease.js";

const stamp = "2026-09-06T00:00:00.000Z";
const deferred = () => {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
};
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic interleaving timed out")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture() {
  const value = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox", BANK_FEED_CLIENT_ID: "fixture-client",
    BANK_FEED_SECRET: "fixture-secret", BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  } });
  seedOwnedEntity(value, "fixture-entity", "Synthetic entity");
  return value;
}
async function seedItem(f, index, assigned = true) {
  const itemRef = `custody-item-${index}`;
  const access = `synthetic-reference-${index}`;
  const sealed = await encryptAccessReference(f.env, access);
  const account = {
    account_id: `custody-account-${index}`, name: "Synthetic account", type: "depository", subtype: "checking",
    balances: { current: 10, available: null, iso_currency_code: "USD", unofficial_currency_code: null },
  };
  f.raw(`INSERT INTO bank_feed_items
    (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at,cursor)
    VALUES ('primary',?,?,?,?,'sandbox','connected',?,'origin')`,
  itemRef, sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp);
  await discoverPlaidAccountAssignments(f.env, { itemRef, accounts: [{ providerAccountId: account.account_id }], at: stamp });
  if (assigned) f.raw("UPDATE plaid_account_entity_assignments SET entity_slug='fixture-entity',assigned_at=? WHERE item_ref=?", stamp, itemRef);
  return { itemRef, access, account };
}
const page = (added, cursor, more = false) => ({
  added, modified: [], removed: [], next_cursor: cursor, has_more: more,
  transactions_update_status: more ? "INITIAL_UPDATE_COMPLETE" : "HISTORICAL_UPDATE_COMPLETE",
});
const transaction = (account, id) => ({
  transaction_id: id, account_id: account.account_id, amount: "1.00", iso_currency_code: "USD",
  date: "2026-08-30", name: "Synthetic transaction", pending: false,
});
function savedProgress(f) {
  return Object.fromEntries([
    "bank_feed_items", "bank_feed_backfill", "plaid_sync_windows", "plaid_sync_stage_accounts",
    "plaid_sync_stage_transactions", "plaid_reconciliation", "plaid_account_entity_assignments",
    "fin_accounts", "fin_transactions", "fin_account_coverage", "fin_balance_snapshots",
  ].map(table => [table, f.rows(`SELECT * FROM ${table} ORDER BY rowid`)]));
}
function expire(f, itemRef, hardDeadline = false) {
  if (hardDeadline) {
    f.raw("UPDATE plaid_sync_leases SET expires_at=unixepoch('now')-1,hard_deadline_at=unixepoch('now')-1 WHERE item_ref=?", itemRef);
    return;
  }
  f.raw("UPDATE plaid_sync_leases SET expires_at=unixepoch('now')-1 WHERE item_ref=?", itemRef);
}
function onePageFetch(item, { added = [], cursor = "complete" } = {}) {
  return async (url) => {
    const path = new URL(url).pathname;
    assert.ok(["/accounts/get", "/transactions/sync"].includes(path));
    return Response.json(path === "/accounts/get" ? { accounts: [item.account] } : page(added, cursor));
  };
}

test("one Item has one bounded D1-clock lease; expiry cannot be renewed by the stale owner", async () => {
  const f = await fixture();
  try {
    const item = await seedItem(f, 1);
    const first = await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: item.itemRef });
    assert.ok(first);
    assert.equal(await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: item.itemRef }), null);
    const ttl = f.first("SELECT expires_at-unixepoch('now') AS seconds FROM plaid_sync_leases").seconds;
    assert.ok(ttl > 0 && ttl <= PLAID_SYNC_LEASE_SECONDS);
    expire(f, item.itemRef);
    await assert.rejects(() => renewPlaidSyncLease(f.env, first), { code: "PLAID_SYNC_LEASE_LOST" });
    const successor = await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: item.itemRef });
    assert.notEqual(successor.ownerToken, first.ownerToken);
    await releasePlaidSyncLease(f.env, first);
    assert.equal(await ownsPlaidSyncLease(f.env, successor), true);
    await releasePlaidSyncLease(f.env, successor);
    assert.equal(f.first("SELECT COUNT(*) AS n FROM plaid_sync_leases").n, 0);
  } finally { f.close(); }
});

test("frequent renewals never extend the immutable ten-minute invocation deadline", async () => {
  const f = await fixture();
  try {
    const item = await seedItem(f, 1);
    const lease = await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: item.itemRef });
    const initial = f.first("SELECT hard_deadline_at,hard_deadline_at-unixepoch('now') AS seconds FROM plaid_sync_leases");
    assert.ok(initial.seconds > 0 && initial.seconds <= PLAID_SYNC_HARD_DEADLINE_SECONDS);
    for (let index = 0; index < 5; index++) await renewPlaidSyncLease(f.env, lease);
    assert.equal(f.first("SELECT hard_deadline_at FROM plaid_sync_leases").hard_deadline_at, initial.hard_deadline_at);
    // Move the synthetic row near its deadline without sleeping or changing the
    // machine clock. Even frequent renewals must cap at that persisted boundary.
    f.raw("UPDATE plaid_sync_leases SET expires_at=unixepoch('now')+5,hard_deadline_at=unixepoch('now')+5");
    await renewPlaidSyncLease(f.env, lease);
    const near = f.first("SELECT expires_at,hard_deadline_at FROM plaid_sync_leases");
    assert.equal(near.expires_at, near.hard_deadline_at);
    expire(f, item.itemRef, true);
    await assert.rejects(() => renewPlaidSyncLease(f.env, lease), { code: "PLAID_SYNC_LEASE_LOST" });
    assert.equal(f.first("SELECT cursor FROM bank_feed_items").cursor, "origin");
  } finally { f.close(); }
});

test("same-batch custody rejects takeover after a preflight and rolls back every data statement", async () => {
  const f = await fixture();
  try {
    const item = await seedItem(f, 1);
    const first = await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: item.itemRef });
    assert.equal(await ownsPlaidSyncLease(f.env, first), true);
    const before = savedProgress(f);
    expire(f, item.itemRef);
    const successor = await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: item.itemRef });
    await assert.rejects(() => runPlaidSyncBatch(f.env, first, [
      f.env.DB.prepare("UPDATE bank_feed_items SET cursor='must-not-commit' WHERE item_ref=?").bind(item.itemRef),
      f.env.DB.prepare("DELETE FROM plaid_account_entity_assignments WHERE item_ref=?").bind(item.itemRef),
    ]), { code: "PLAID_SYNC_LEASE_LOST" });
    assert.deepEqual(savedProgress(f), before);
    assert.equal(await ownsPlaidSyncLease(f.env, successor), true);
  } finally { f.close(); }
});

test("an overlapping refresh cannot mutation-reset another invocation's staged prefix", async () => {
  const f = await fixture();
  const waiting = deferred(), finish = deferred();
  let running;
  try {
    const item = await seedItem(f, 1);
    running = syncPlaidItem(f.env, item.itemRef, { now: stamp, fetchImpl: async (url, init) => {
      if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [item.account] });
      const { cursor } = JSON.parse(init.body);
      if (cursor === "origin") return Response.json(page([transaction(item.account, "prefix")], "page-two", true));
      assert.equal(cursor, "page-two"); waiting.resolve(); await finish.promise;
      return Response.json(page([transaction(item.account, "last")], "complete"));
    } });
    await bounded(waiting.promise);
    const prefix = savedProgress(f);
    let overlappingCalls = 0;
    const other = await syncPlaidItem(f.env, item.itemRef, { now: stamp, fetchImpl: async () => {
      overlappingCalls += 1;
      return Response.json({ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }, { status: 400 });
    } });
    assert.equal(other.busy, true);
    assert.equal(other.cursor_advanced, false);
    assert.equal(overlappingCalls, 0);
    assert.deepEqual(savedProgress(f), prefix);
    finish.resolve();
    const receipt = await bounded(running);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.counts.added, 2);
    assert.deepEqual(f.rows("SELECT external_id FROM fin_transactions ORDER BY external_id").map(row => row.external_id), ["last", "prefix"]);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items").cursor, "complete");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM plaid_sync_leases").n, 0);
  } finally { finish.resolve(); await Promise.allSettled([running].filter(Boolean)); f.close(); }
});

for (const expiration of ["lease", "hard_deadline"]) {
test(`${expiration} takeover resumes the durable prefix; the stale provider return cannot stage, report failure, or release its successor`, async () => {
  const f = await fixture();
  const firstWaiting = deferred(), firstFinish = deferred(), nextWaiting = deferred(), nextFinish = deferred();
  let firstRun, nextRun;
  try {
    const item = await seedItem(f, 1);
    firstRun = syncPlaidItem(f.env, item.itemRef, { now: stamp, fetchImpl: async (url, init) => {
      if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [item.account] });
      if (JSON.parse(init.body).cursor === "origin") return Response.json(page([transaction(item.account, "prefix")], "page-two", true));
      firstWaiting.resolve(); await firstFinish.promise;
      return Response.json(page([transaction(item.account, "obsolete-last")], "obsolete-cursor"));
    } });
    await bounded(firstWaiting.promise);
    expire(f, item.itemRef, expiration === "hard_deadline");
    nextRun = syncPlaidItem(f.env, item.itemRef, { now: stamp, fetchImpl: async (url, init) => {
      if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [item.account] });
      assert.equal(JSON.parse(init.body).cursor, "page-two"); nextWaiting.resolve(); await nextFinish.promise;
      return Response.json(page([transaction(item.account, "correct-last")], "complete"));
    } });
    await bounded(nextWaiting.promise);
    const before = savedProgress(f);
    const successor = f.first("SELECT owner_token FROM plaid_sync_leases").owner_token;
    firstFinish.resolve();
    const stale = await bounded(firstRun);
    assert.equal(stale.code, "PLAID_SYNC_LEASE_LOST");
    assert.equal(stale.cursor_advanced, false);
    assert.deepEqual(savedProgress(f), before);
    assert.equal(f.first("SELECT owner_token FROM plaid_sync_leases").owner_token, successor);
    nextFinish.resolve();
    const receipt = await bounded(nextRun);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.counts.added, 2);
    assert.deepEqual(f.rows("SELECT external_id FROM fin_transactions ORDER BY external_id").map(row => row.external_id), ["correct-last", "prefix"]);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items").cursor, "complete");
  } finally { firstFinish.resolve(); nextFinish.resolve(); await Promise.allSettled([firstRun, nextRun].filter(Boolean)); f.close(); }
});
}

for (const boundary of ["window", "discovery", "reset", "stage", "promotion", "error"]) {
  test(`the actual ${boundary} batch rejects ownership lost after its last awaited read`, async () => {
    const f = await fixture();
    try {
      const item = await seedItem(f, 1);
      const originalBatch = f.env.DB.batch.bind(f.env.DB);
      let successor, before, intercepted = false;
      f.env.DB.batch = async statements => {
        const sql = statements.map(statement => statement.sql).join("\n");
        const target = boundary === "window" ? /INSERT INTO plaid_sync_windows/.test(sql)
          : boundary === "discovery" ? /INSERT INTO plaid_account_entity_assignments/.test(sql)
            : boundary === "reset" ? /DELETE FROM plaid_sync_stage_transactions/.test(sql)
              : boundary === "stage" ? /INSERT OR REPLACE INTO plaid_sync_stage_transactions/.test(sql)
          : boundary === "promotion" ? /INSERT INTO fin_accounts/.test(sql)
            : /UPDATE plaid_sync_windows SET state=CASE/.test(sql);
        if (!intercepted && target) {
          intercepted = true; before = savedProgress(f); expire(f, item.itemRef);
          successor = await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: item.itemRef });
        }
        return originalBatch(statements);
      };
      const fetchImpl = boundary === "error" ? async url => Response.json(new URL(url).pathname === "/accounts/get"
        ? { accounts: [item.account] } : { added: null, modified: [], removed: [], has_more: false, next_cursor: "invalid" })
        : onePageFetch(item, { added: [transaction(item.account, "candidate")] });
      const receipt = await syncPlaidItem(f.env, item.itemRef, { fetchImpl, now: stamp });
      assert.equal(intercepted, true);
      assert.equal(receipt.code, "PLAID_SYNC_LEASE_LOST");
      assert.equal(receipt.cursor_advanced, false);
      assert.deepEqual(savedProgress(f), before);
      assert.equal(await ownsPlaidSyncLease(f.env, successor), true);
    } finally { f.close(); }
  });
}

for (const change of ["revocation_pending", "removed", "paused"]) {
  test(`${change} during a provider read prevents every later sync write`, async () => {
    const f = await fixture();
    const waiting = deferred(), finish = deferred();
    let running;
    try {
      const item = await seedItem(f, 1);
      running = syncPlaidItem(f.env, item.itemRef, { now: stamp, fetchImpl: async url => {
        if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [item.account] });
        waiting.resolve(); await finish.promise;
        return Response.json(page([transaction(item.account, "must-not-promote")], "must-not-commit"));
      } });
      await bounded(waiting.promise);
      if (change === "revocation_pending") f.raw(`INSERT INTO plaid_revocation_outbox
        (tenant_id,item_ref,state,attempts,next_attempt_at,requested_at,updated_at)
        VALUES ('primary',?,'pending',0,?,?,?)`, item.itemRef, stamp, stamp, stamp);
      if (change === "removed") f.raw("UPDATE bank_feed_items SET status='removed',status_detail='Synthetic owner removal',removed_at=? WHERE item_ref=?", stamp, item.itemRef);
      if (change === "paused") f.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
      const before = savedProgress(f);
      finish.resolve();
      const receipt = await bounded(running);
      assert.equal(receipt.code, change === "paused" ? "PLAID_SYNC_PAUSED" : "PLAID_SYNC_LEASE_LOST");
      assert.equal(receipt.cursor_advanced, false);
      assert.deepEqual(savedProgress(f), before);
    } finally { finish.resolve(); await Promise.allSettled([running].filter(Boolean)); f.close(); }
  });
}

test("a paused invocation does not access D1, decrypt a reference, or call the provider", async () => {
  const f = await fixture();
  try {
    const item = await seedItem(f, 1);
    f.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
    f.control.failEverything = true;
    const seen = f.seen.sql.length;
    const receipt = await syncPlaidItem(f.env, item.itemRef, { fetchImpl: async () => assert.fail("provider must not run") });
    assert.equal(receipt.paused, true);
    assert.equal((await runPlaidFeedSlice(f.env)).ran, 0);
    assert.equal(f.seen.sql.length, seen);
  } finally { f.close(); }
});

test("three unassigned Items defer without pretending to sync, so the next slice reaches Item four", async () => {
  const f = await fixture();
  try {
    const items = [];
    for (let index = 1; index <= 4; index++) items.push(await seedItem(f, index, index === 4));
    const calls = [0, 0, 0, 0];
    const fetchImpl = async (url, init) => {
      const index = items.findIndex(item => item.access === JSON.parse(init.body).access_token);
      assert.ok(index >= 0); calls[index] += 1;
      return onePageFetch(items[index])(url, init);
    };
    const first = await runPlaidFeedSlice(f.env, { maxItems: 3, fetchImpl, now: stamp });
    assert.equal(first.ran, 3);
    assert.ok(first.items.every(item => item.assignment_required));
    const second = await runPlaidFeedSlice(f.env, { maxItems: 3, fetchImpl, now: "2026-09-06T00:01:00.000Z" });
    assert.equal(second.ran, 1);
    assert.equal(second.items[0].item_ref, items[3].itemRef);
    assert.equal(second.items[0].ok, true);
    assert.equal(calls[3], 2);
    for (const item of items.slice(0, 3)) {
      const row = f.first("SELECT cursor,last_synced_at FROM bank_feed_items WHERE item_ref=?", item.itemRef);
      assert.equal(row.cursor, "origin"); assert.equal(row.last_synced_at, null);
      assert.equal(f.first("SELECT state FROM plaid_sync_windows WHERE item_ref=?", item.itemRef).state, "ready");
    }
    // An owner completing assignment may immediately resume the ready window,
    // without waiting for the scheduler delay or fetching the same pages again.
    f.raw("UPDATE plaid_account_entity_assignments SET entity_slug='fixture-entity',assigned_at=? WHERE item_ref=?", stamp, items[0].itemRef);
    const resumed = await syncPlaidItem(f.env, items[0].itemRef, { now: stamp, fetchImpl: async () => assert.fail("ready resume must reuse durable work") });
    assert.equal(resumed.ok, true); assert.equal(resumed.resumed_promotion, true);
  } finally { f.close(); }
});

test("a busy Item is excluded from a bounded scheduled slice while another Item advances", async () => {
  const f = await fixture();
  try {
    const busy = await seedItem(f, 1), ready = await seedItem(f, 2);
    const lease = await claimPlaidSyncLease(f.env, { tenantId: "primary", itemRef: busy.itemRef });
    const receipt = await runPlaidFeedSlice(f.env, { maxItems: 1, now: stamp, fetchImpl: onePageFetch(ready) });
    assert.equal(receipt.ran, 1); assert.equal(receipt.items[0].item_ref, ready.itemRef); assert.equal(receipt.items[0].ok, true);
    assert.equal(await ownsPlaidSyncLease(f.env, lease), true);
  } finally { f.close(); }
});


test("one malformed Item stays retryable while another Item in the same slice completes", async () => {
  const f = await fixture();
  try {
    const malformed = await seedItem(f, 1), valid = await seedItem(f, 2);
    const receipt = await runPlaidFeedSlice(f.env, { maxItems: 2, now: stamp, fetchImpl: async (url, init) => {
      const item = JSON.parse(init.body).access_token === malformed.access ? malformed : valid;
      if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [item.account] });
      return Response.json(item === malformed ? { added: null, modified: [], removed: [], has_more: false, next_cursor: "invalid" } : page([], "valid-complete"));
    } });
    assert.equal(receipt.ran, 2);
    assert.equal(receipt.items[0].code, "INVALID_SYNC_PAGE");
    assert.equal(receipt.items[0].cursor_advanced, false);
    assert.equal(receipt.items[1].ok, true);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", malformed.itemRef).cursor, "origin");
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", valid.itemRef).cursor, "valid-complete");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM plaid_sync_leases").n, 0);
  } finally { f.close(); }
});


test("an expired shared invocation deadline cannot claim a later Item", async () => {
  const f = await fixture();
  try {
    const item = await seedItem(f, 1);
    const expired = f.first("SELECT unixepoch('now')-1 AS deadline").deadline;
    const before = savedProgress(f);
    const receipt = await syncPlaidItem(f.env, item.itemRef, {
      hardDeadlineAt: expired, fetchImpl: async () => assert.fail("expired invocation must not contact provider"),
    });
    assert.equal(receipt.code, "PLAID_SYNC_DEADLINE");
    assert.equal(receipt.cursor_advanced, false);
    assert.deepEqual(savedProgress(f), before);
    assert.equal(f.first("SELECT COUNT(*) AS n FROM plaid_sync_leases").n, 0);
  } finally { f.close(); }
});

test("later Items inherit the same database-clock invocation deadline instead of restarting ten minutes", async () => {
  const f = await fixture();
  try {
    const items = [await seedItem(f, 1), await seedItem(f, 2)];
    const deadlines = [];
    const receipt = await runPlaidFeedSlice(f.env, { maxItems: 2, now: stamp, fetchImpl: async (url, init) => {
      const item = items.find(value => value.access === JSON.parse(init.body).access_token);
      assert.ok(item);
      if (new URL(url).pathname === "/accounts/get") {
        deadlines.push(f.first("SELECT hard_deadline_at FROM plaid_sync_leases WHERE item_ref=?", item.itemRef).hard_deadline_at);
        // Cross a real database-clock second. Without the shared deadline the
        // second Item would obtain a later claim budget and this test fails.
        if (item === items[0]) await new Promise(resolve => setTimeout(resolve, 1_100));
      }
      return onePageFetch(item)(url, init);
    } });
    assert.equal(receipt.ran, 2); assert.ok(receipt.items.every(item => item.ok));
    assert.equal(deadlines.length, 2); assert.equal(deadlines[1], deadlines[0]);
  } finally { f.close(); }
});

test("assignment completed after a blocked readiness read keeps its due-now wakeup", async () => {
  const f = await fixture();
  try {
    const item = await seedItem(f, 1, false);
    const originalBatch = f.env.DB.batch.bind(f.env.DB);
    let assigned = false;
    f.env.DB.batch = async statements => {
      if (!assigned && statements.some(statement => statement.sql.includes("'assignment_wait'"))) {
        assigned = true;
        const accountRef = f.first("SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref=?", item.itemRef).account_ref;
        const choice = await assignPlaidAccountEntity(f.env, {
          request_id: "custody-assignment-race", account_ref: accountRef, entity_slug: "fixture-entity",
        }, { now: "2026-09-06T00:00:01.000Z" });
        assert.equal(choice.status, 201);
      }
      return originalBatch(statements);
    };
    const first = await syncPlaidItem(f.env, item.itemRef, { now: stamp, fetchImpl: onePageFetch(item) });
    assert.equal(assigned, true); assert.equal(first.assignment_required, true);
    const wakeup = f.first("SELECT reason,due_at FROM plaid_reconciliation WHERE item_ref=?", item.itemRef);
    assert.equal(wakeup.reason, "owner_assignment");
    assert.equal(wakeup.due_at, "2026-09-06T00:00:01.000Z");
    const next = await runPlaidFeedSlice(f.env, { now: "2026-09-06T00:00:02.000Z",
      fetchImpl: async () => assert.fail("ready window must resume without another provider read"),
    });
    assert.equal(next.ran, 1); assert.equal(next.items[0].ok, true);
  } finally { f.close(); }
});
