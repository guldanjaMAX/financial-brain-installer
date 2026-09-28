import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { handleBankFeed } from "../src/lib/bank-feed.js";
import { bankFeedWorkerVars, optionalWorkerSecretNames } from "../../brain.mjs";
import { checkBankFeedRedirect, OK } from "../../doctor.mjs";

const DEMO = JSON.parse(readFileSync(new URL("./fixtures/simplefin/demo-accounts.json", import.meta.url), "utf8"));
const WRAPPING_KEY = `v2.${"A".repeat(43)}`;
const CLAIM_URL = "https://claim-user:claim-pass@bridge.example.invalid/claim/fixture-once";
const ACCESS_URL = "https://access-user:access-pass@bridge.example.invalid/simplefin/fixture-access";
const SETUP_TOKEN = Buffer.from(CLAIM_URL, "utf8").toString("base64");

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

function provider(overrides = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const target = String(input);
    calls.push({ target, method: init.method || "GET" });
    if ((init.method || "GET") === "POST") {
      assert.equal(target, CLAIM_URL, "the decoded claim URL is the claim decision point");
      return new Response(ACCESS_URL, { status: 200 });
    }
    assert.ok(target.startsWith(`${ACCESS_URL}/accounts?`), "the encrypted access URL is opened only for a pull");
    return json(overrides.accounts || DEMO);
  };
  return { calls, fetchImpl };
}

async function ownerRequest(fixture, path, body, fetchImpl) {
  const headers = await fixture.ownerHeaders();
  const request = new Request(`https://brain.invalid${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return handleBankFeed(fixture.env, request, new URL(request.url), path, {
    bankFeedFetchImpl: fetchImpl,
    bankFeedNow: "2026-09-28T11:00:00.000Z",
    waitUntil(promise) { fixture.waitUntil.push(Promise.resolve(promise)); },
  });
}

test("SimpleFIN claim is one-time, encrypted, and replay-safe without exposing the access URL", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin",
    BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: WRAPPING_KEY,
  } });
  const fake = provider();
  const logs = [];
  const priorLog = console.log;
  const priorWarn = console.warn;
  console.log = (...values) => logs.push(values.join(" "));
  console.warn = (...values) => logs.push(values.join(" "));
  try {
    const first = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-claim-request-0001",
      setup_token: SETUP_TOKEN,
    }, fake.fetchImpl);
    const firstBody = await first.json();
    assert.equal(first.status, 201);
    assert.equal(firstBody.ok, true);
    assert.equal(fake.calls.length, 1, "the claim decision point was reached exactly once");

    const replay = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-claim-request-0001",
      setup_token: SETUP_TOKEN,
    }, fake.fetchImpl);
    const replayBody = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayBody.replayed, true);
    assert.equal(fake.calls.length, 1, "an exact replay must not POST the one-time claim URL again");

    const conflictToken = Buffer.from(`${CLAIM_URL}-different`, "utf8").toString("base64");
    const conflict = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-claim-request-0001",
      setup_token: conflictToken,
    }, fake.fetchImpl);
    assert.equal(conflict.status, 409);
    assert.equal(fake.calls.length, 1, "a conflicting retry reaches the durable decision row but never POSTs a token");

    const reusedToken = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-claim-request-0009",
      setup_token: SETUP_TOKEN,
    }, fake.fetchImpl);
    assert.equal(reusedToken.status, 409);
    assert.equal(fake.calls.length, 1, "the Setup Token fingerprint prevents a new request ID from claiming twice");

    const stored = fixture.first("SELECT access_ciphertext, access_iv, item_ref FROM bank_feed_items");
    const persisted = JSON.stringify({
      item: stored,
      claim: fixture.first("SELECT * FROM simplefin_claim_operations"),
      response: [firstBody, replayBody],
      logs,
    });
    for (const forbidden of [SETUP_TOKEN, CLAIM_URL, ACCESS_URL, "access-user", "access-pass"]) {
      assert.equal(persisted.includes(forbidden), false, "no setup or access secret leaves encrypted custody");
    }
    assert.ok(stored.access_ciphertext.length >= 16);

    const { runSimpleFinMaintenance } = await import("../src/lib/simplefin-bank-feed.js");
    const failed = await runSimpleFinMaintenance(fixture.env, {
      now: "2026-09-28T12:00:00.000Z",
      fetchImpl: async () => { throw new Error(`transport exposed ${ACCESS_URL}`); },
      maxRequestsPerItem: 1,
    });
    const failureSurface = JSON.stringify({
      failed,
      item: fixture.first("SELECT status,status_detail,last_error_at FROM bank_feed_items"),
      claim: fixture.first("SELECT * FROM simplefin_claim_operations"),
      logs,
    });
    assert.equal(failureSurface.includes(ACCESS_URL), false, "provider transport errors cannot echo the access URL");
  } finally {
    console.log = priorLog;
    console.warn = priorWarn;
    fixture.close();
  }
});

test("the demo response stages owner choices, promotes four deduplicated transactions, and surfaces errlist", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin",
    BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: WRAPPING_KEY,
  } });
  const fake = provider();
  try {
    seedOwnedEntity(fixture, "owner-business", "Owner business");
    const claim = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-claim-request-0002",
      setup_token: SETUP_TOKEN,
    }, fake.fetchImpl);
    assert.equal(claim.status, 201);

    const navigationHeaders = await fixture.ownerHeaders();
    const pageRequest = new Request("https://brain.invalid/app/connect/bank", {
      headers: { Cookie: navigationHeaders.Cookie },
    });
    const page = await handleBankFeed(
      fixture.env,
      pageRequest,
      new URL(pageRequest.url),
      "/app/connect/bank",
      {},
    );
    const pageHtml = await page.text();
    assert.equal(page.status, 200);
    assert.match(pageHtml, /Connect SimpleFIN Bridge/);
    assert.match(pageHtml, /connection\.provider_errors/,
      "the owner page renders provider errlist entries from status");

    const sync = await ownerRequest(fixture, "/api/bank-feed/sync", { max_items: 1 }, fake.fetchImpl);
    assert.equal(sync.status, 401, "owner sessions do not become operator sync authority");

    const { runSimpleFinMaintenance, simpleFinOwnerAccountStatus, assignSimpleFinAccountEntity, simpleFinFeedStatus } =
      await import("../src/lib/simplefin-bank-feed.js");
    const pulled = await runSimpleFinMaintenance(fixture.env, {
      fetchImpl: fake.fetchImpl,
      now: "2026-09-28T12:00:00.000Z",
    });
    assert.equal(pulled.ran, 1);
    assert.equal(fake.calls.filter((call) => call.method === "GET").length, 3,
      "the backfill decision point uses three bounded windows in one daily slice");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0,
      "unassigned account data remains staged");

    const inventory = await simpleFinOwnerAccountStatus(fixture.env);
    assert.equal(inventory.accounts.length, 3);
    assert.equal(inventory.summary.assignment_required, 3);
    for (const [index, account] of inventory.accounts.entries()) {
      const assigned = await assignSimpleFinAccountEntity(fixture.env, {
        request_id: `simplefin-assignment-request-000${index + 1}`,
        account_ref: account.account_ref,
        entity_slug: "owner-business",
      }, { now: "2026-09-28T12:05:00.000Z" });
      assert.equal(assigned.body.changed, true);
    }
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 4);
    assert.equal(fixture.first("SELECT COUNT(DISTINCT txn_uid) AS n FROM fin_transactions").n, 4,
      "overlapping 90-day windows deduplicate at the ledger identity boundary");
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE source_provider='simplefin'",
    ).n, 4);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 3);

    fixture.raw("UPDATE simplefin_connections SET next_pull_at='2000-01-01T00:00:00.000Z'");
    const warningFake = provider({ accounts: { ...DEMO, errlist: ["The institution is refreshing. Try again later."] } });
    const warningRun = await runSimpleFinMaintenance(fixture.env, {
      fetchImpl: warningFake.fetchImpl,
      now: "2026-09-29T12:00:00.000Z",
      maxRequestsPerItem: 1,
    });
    assert.equal(warningRun.items[0].partial, true);
    assert.equal(warningFake.calls.filter((call) => call.method === "GET").length, 1,
      "the errlist control reached a real provider pull");
    const status = await simpleFinFeedStatus(fixture.env);
    assert.deepEqual(status.connections[0].provider_errors, ["The institution is refreshing. Try again later."]);
    assert.equal(status.needs_attention.length, 1);
    assert.equal(JSON.stringify(status).includes(ACCESS_URL), false);

    fixture.raw(
      "UPDATE simplefin_connections SET request_day='2026-09-29',requests_today=24,next_pull_at='2000-01-01T00:00:00.000Z'",
    );
    const cappedFake = provider();
    const capped = await runSimpleFinMaintenance(fixture.env, {
      fetchImpl: cappedFake.fetchImpl,
      now: "2026-09-29T13:00:00.000Z",
      maxRequestsPerItem: 1,
    });
    assert.equal(capped.items[0].code, "simplefin_daily_request_limit");
    assert.equal(cappedFake.calls.length, 0, "the durable 24-request decision point refuses before provider contact");
  } finally {
    fixture.close();
  }
});

test("manifest, deploy bindings, secret custody, and doctor agree on the SimpleFIN profile", () => {
  const manifest = {
    brain: { domain: "fixture-brain.example.invalid" },
    client: { slug: "fixture", display_name: "Fixture" },
    corpora: { bank_feed: { enabled: true, provider: "simplefin", environment: "production" } },
  };
  const vars = bankFeedWorkerVars(manifest);
  const value = (name) => vars.find((entry) => entry.name === name)?.text;
  assert.equal(value("BANK_FEED_PROVIDER"), "simplefin");
  assert.equal(value("BANK_FEED_ENV"), "production");
  for (const absent of ["BANK_FEED_API_BASE", "BANK_FEED_LINK_SDK_URL", "BANK_FEED_LINK_GLOBAL",
    "BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"]) {
    assert.equal(value(absent), undefined, `${absent} does not belong to the SimpleFIN profile`);
  }
  assert.deepEqual(optionalWorkerSecretNames(manifest), ["BANK_FEED_WRAPPING_KEY_V2"]);
  const doctor = checkBankFeedRedirect(manifest);
  assert.equal(doctor.status, OK);
  assert.match(doctor.detail, /no provider redirect or webhook registration is required/i);
  assert.throws(
    () => bankFeedWorkerVars({ corpora: { bank_feed: {
      enabled: true, provider: "simplefin", environment: "production", api_base: "https://provider.invalid",
    } } }),
    /SimpleFIN.*endpoint override/i,
  );
});

test("the actual Worker cron runs a due SimpleFIN slice without exceeding three requests", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin",
    BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: WRAPPING_KEY,
  } });
  const fake = provider();
  const previousFetch = globalThis.fetch;
  try {
    const claim = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-cron-claim-0001",
      setup_token: SETUP_TOKEN,
    }, fake.fetchImpl);
    assert.equal(claim.status, 201);
    fixture.raw("UPDATE simplefin_connections SET next_pull_at='2000-01-01T00:00:00.000Z'");
    globalThis.fetch = fake.fetchImpl;
    let work = null;
    await fixture.worker.scheduled({}, fixture.env, {
      waitUntil(promise) { work = Promise.resolve(promise); },
    });
    assert.ok(work, "the scheduled decision point registers its work with waitUntil");
    await work;
    assert.equal(fake.calls.filter((call) => call.method === "GET").length, 3);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM simplefin_sync_windows").n, 3);
  } finally {
    globalThis.fetch = previousFetch;
    fixture.close();
  }
});
