import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
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
    const request = new Request(input, init);
    const target = new URL(request.url);
    const accessUrl = overrides.accessUrl ?? ACCESS_URL;
    const expected = new URL(request.method === "POST" ? CLAIM_URL : accessUrl);
    assert.ok(request.headers.get("Authorization") === `Basic ${btoa(`${expected.username}:${expected.password}`)}`,
      "the decrypted reference supplies Basic auth without exposing it");
    expected.username = ""; expected.password = "";
    assert.equal(target.username, ""); assert.equal(target.password, "");
    assert.equal(request.redirect, "manual");
    calls.push({ method: request.method });
    if (request.method === "POST") {
      assert.ok(target.href === expected.href, "the decoded claim URL is the claim decision point");
      return new Response(accessUrl, { status: 200 });
    }
    assert.ok(target.href.startsWith(`${expected.href}/accounts?`), "the encrypted access URL is opened only for a pull");
    return json(overrides.respond?.(target) ?? overrides.accounts ?? DEMO);
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
    assert.equal(fake.calls.filter((call) => call.method === "GET").length, 1,
      "history waits on the first window until owner assignment permits verified promotion");
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
      "promoted transactions have distinct ledger identities");
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

test("a Bridge range advisory allows first sync and paged history while real errors block progress", async (t) => {
  const { runSimpleFinMaintenance, assignSimpleFinAccountEntity, simpleFinFeedStatus } =
    await import("../src/lib/simplefin-bank-feed.js");
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin",
    BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: WRAPPING_KEY,
  } });
  t.after(() => fixture.close());
  seedOwnedEntity(fixture, "owner-business", "Owner business");
  const advisory = "Requested date range exceeds recommended range of 45 days. In the future, this may be capped.";
  const daySeconds = 86400;
  const epoch = date => Date.parse(date) / 1000;
  const calls = [];
  const transactions = [
    { id: "older", posted: epoch("2026-06-18"), amount: "0.29" },
    { id: "overlap", posted: epoch("2026-09-20"), amount: "-123.47" },
  ];
  let issue = null;
  let reportAdvisory = false;
  const fake = provider({ respond(target) {
    const start = Number(target.searchParams.get("start-date"));
    const end = Number(target.searchParams.get("end-date"));
    calls.push([start, end]);
    const rangeWarning = reportAdvisory || end - start > 45 * daySeconds;
    return {
      errlist: [...(rangeWarning ? [{ code: "gen.api", msg: advisory }] : []), ...(issue ? [issue] : [])],
      errors: rangeWarning ? [advisory] : [],
      accounts: [{ id: "checking", name: "Checking", currency: "USD", balance: "200.00", "balance-date": end - 1,
        transactions: transactions.filter(row => row.posted >= start && row.posted < end) }],
    };
  } });
  const claim = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
    request_id: "simplefin-range-request-0001", setup_token: SETUP_TOKEN,
  }, fake.fetchImpl);
  assert.equal(claim.status, 201);
  fixture.raw("UPDATE simplefin_connections SET backfill_start='2026-06-15',backfill_next='2026-06-15',backfill_end='2026-09-27'");
  const pull = date => runSimpleFinMaintenance(fixture.env, { fetchImpl: fake.fetchImpl, now: `${date}T12:00:00.000Z` });

  const first = await pull("2026-09-28");
  assert.equal(first.items[0].partial, false, "the range advisory alone allows first-sync staging");
  const { account_ref } = fixture.first("SELECT account_ref FROM simplefin_account_assignments");
  await assignSimpleFinAccountEntity(fixture.env, {
    request_id: "simplefin-range-assignment-0001", account_ref, entity_slug: "owner-business",
  }, { now: "2026-09-28T12:05:00.000Z" });
  assert.equal(fixture.first("SELECT state FROM simplefin_sync_windows").state, "promoted");
  const status = await simpleFinFeedStatus(fixture.env);
  assert.ok(status.connections[0].provider_errors.includes(advisory), "the advisory remains visible");

  issue = { code: "gen.api", msg: "Requested date range exceeds recommended range of 45 days. The response was capped." };
  const failed = await pull("2026-09-29");
  assert.equal(failed.items[0].partial, true);
  assert.equal(fixture.first("SELECT backfill_next FROM simplefin_connections").backfill_next, "2026-06-15");
  assert.equal(fixture.first("SELECT last_error_code FROM bank_feed_health").last_error_code, "BANK_SYNC_PARTIAL");
  assert.deepEqual(JSON.parse(fixture.first("SELECT errlist_json FROM simplefin_sync_windows WHERE window_start='2026-06-15'").errlist_json),
    [issue.msg]);

  issue = null;
  const history = await pull("2026-09-30");
  assert.equal(history.items[0].partial, false);
  assert.deepEqual(calls, [
    [epoch("2026-07-01"), epoch("2026-09-29")],
    [epoch("2026-06-15"), epoch("2026-09-13")],
    [epoch("2026-06-15"), epoch("2026-09-13")],
    [epoch("2026-09-13"), epoch("2026-09-28")],
  ], "history pages are contiguous and overlap the first pull");
  assert.equal(fixture.first("SELECT backfill_next FROM simplefin_connections").backfill_next, "2026-09-28");
  assert.deepEqual(fixture.rows("SELECT external_id,raw_amount_minor FROM fin_transactions WHERE removed_at IS NULL ORDER BY external_id")
    .map(row => [row.external_id, row.raw_amount_minor]), [["older", 29], ["overlap", -12347]]);

  reportAdvisory = true;
  await pull("2026-10-01");
  assert.equal(fixture.first("SELECT last_successful_sync_at FROM bank_feed_health").last_successful_sync_at,
    "2026-10-01T12:00:00.000Z");
  const verifiedStatus = await simpleFinFeedStatus(fixture.env, { now: "2026-10-01T12:00:00.000Z" });
  assert.equal(verifiedStatus.connections[0].health.state, "healthy");
  assert.ok(verifiedStatus.connections[0].provider_errors.includes(advisory));
  assert.equal(verifiedStatus.needs_attention.length, 0, "a verified advisory-only pull needs no owner action");
});

const RANGE_WARNING = "Requested date range exceeds recommended range of 45 days. In the future, this may be capped.";

function generatedRows(rows) {
  let seed = 0x7da150e3;
  const remaining = [...rows];
  return rows.map(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return remaining.splice(seed % remaining.length, 1)[0];
  });
}

async function reviewPull(t) {
  const { runSimpleFinMaintenance, assignSimpleFinAccountEntity, simpleFinFeedStatus } =
    await import("../src/lib/simplefin-bank-feed.js");
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin", BANK_FEED_ENV: "production", BANK_FEED_WRAPPING_KEY_V2: WRAPPING_KEY,
  } });
  t.after(() => fixture.close());
  seedOwnedEntity(fixture, "owner-business", "Owner business");
  const state = { currency: "USD", issues: {}, date: "2026-09-28" };
  const fake = provider({ accessUrl: ACCESS_URL.replace("fixture-access", "future"), respond(target) {
    const start = Number(target.searchParams.get("start-date"));
    const end = Number(target.searchParams.get("end-date"));
    const posted = Date.parse("2026-09-20") / 1000;
    return { ...state.issues, accounts: [{
      id: "checking", name: "Checking", currency: state.currency, balance: state.balance ?? "123.47",
      "available-balance": state.amount ?? "0.29", "balance-date": end - 1,
      transactions: posted >= start && posted < end ? [
        { id: "sample", posted, amount: state.transaction ?? "-123.47" },
        { id: "credit", posted, amount: state.amount ?? "0.29" },
      ] : [],
    }] };
  } });
  assert.equal((await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
    request_id: "simplefin-review-claim-0001", setup_token: SETUP_TOKEN,
  }, fake.fetchImpl)).status, 201);
  const now = () => state.date + "T12:00:00.000Z";
  const pull = async () => {
    const before = fake.calls.length;
    const result = await runSimpleFinMaintenance(fixture.env, {
      fetchImpl: fake.fetchImpl, now: now(), maxRequestsPerItem: 1,
    });
    assert.equal(fake.calls.length, before + 1, "the real Bridge pull reached its response decision");
    return result.items[0];
  };
  const assign = async () => {
    const { account_ref } = fixture.first("SELECT account_ref FROM simplefin_account_assignments");
    await assignSimpleFinAccountEntity(fixture.env, {
      request_id: "simplefin-review-assign-0001", account_ref, entity_slug: "owner-business",
    }, { now: now() });
  };
  return { fixture, state, pull, assign, now, status: () => simpleFinFeedStatus(fixture.env, { now: now() }) };
}

test("promoted SimpleFIN account has verified connection evidence in both money tools", async t => {
  const { fixture, pull, assign, now } = await reviewPull(t);
  assert.equal((await pull()).partial, false);
  await assign();
  const ledger = fixture.first("SELECT external_ref FROM fin_accounts");
  assert.equal(ledger.external_ref, fixture.first("SELECT account_ref FROM simplefin_account_assignments").account_ref);
  assert.equal(fixture.first("SELECT last_synced_at FROM bank_feed_items").last_synced_at, now());
  const { overviewMoney } = await import("../src/lib/money-overview.js");
  const { queryMoney } = await import("../src/lib/money-query.js");
  const options = { now: () => Date.parse(now()) };
  const overview = await overviewMoney(fixture.env, options);
  assert.equal(overview.accounts.length, 1);
  assert.equal(overview.accounts[0].connected, true);
  const result = await queryMoney(fixture.env, {
    sql: "SELECT SUM(amount_minor) AS figure FROM txn WHERE posted_on BETWEEN '2026-09-20' AND '2026-09-20'",
    from: "2026-09-20", through: "2026-09-20",
  }, options);
  assert.equal(result.rows[0].figure, 12376);
  for (const answer of [overview, result])
    assert.doesNotMatch(answer.confidence_text, /not connected|no verified successful sync time|discovered feed accounts/);
});

for (const [currency, balance, amount, currentMinor, availableMinor] of generatedRows([
  ["USD", "123.47", "0.29", 12347, 29], ["JPY", "123", "29", 123, 29],
  ...["KRW", "CLP", "VND"].map(code => [code, "123", "29", 123, 29]),
  ["KWD", "123.47", "0.29", 123470, 290],
  ...["BHD", "JOD", "OMR", "TND"].map(code => [code, "123.471", "0.291", 123471, 291]),
  ["ZZZ", "123.47", "0.29", null, null],
])) {
  test(`SimpleFIN currency decoding: ${currency}`, async t => {
    const { fixture, state, pull, assign, status } = await reviewPull(t);
    if (currentMinor === null) {
      assert.equal((await pull()).partial, false, "supported-currency control stages");
      await assign();
      const before = fixture.first("SELECT backfill_next FROM simplefin_connections");
      state.date = "2026-09-29";
      state.currency = currency;
      assert.equal((await pull()).code, "simplefin_currency_unsupported");
      assert.deepEqual(fixture.first("SELECT backfill_next FROM simplefin_connections"), before);
      assert.equal(fixture.first("SELECT currency FROM fin_transactions").currency, "USD");
      assert.equal(fixture.first("SELECT currency FROM simplefin_account_assignments").currency, "USD");
      assert.equal(fixture.first("SELECT COUNT(*) n FROM simplefin_stage_accounts WHERE currency='ZZZ'").n, 0);
      assert.match((await status()).connections[0].status_detail, /currency/);
      return;
    }
    Object.assign(state, { currency, balance, amount, transaction: "-" + balance });
    assert.equal((await pull()).partial, false);
    await assign();
    assert.ok(fixture.first("SELECT amount_decimal FROM simplefin_stage_transactions"), "the amount reached durable staging");
    assert.deepEqual(fixture.rows("SELECT raw_amount_minor FROM fin_transactions ORDER BY external_id")
      .map(row => row.raw_amount_minor), [availableMinor, -currentMinor]);
    assert.equal(fixture.first("SELECT state FROM simplefin_sync_windows").state, "promoted");
    const snapshot = fixture.first("SELECT * FROM fin_balance_snapshots");
    assert.equal(snapshot.provider_position_minor, currentMinor);
    assert.equal(snapshot.available_minor, availableMinor);
    if (currency === "KWD") {
      // Recreate a historical misdecode, then exercise the ordinary exact-window retry.
      const previous = fixture.rows("SELECT txn_uid FROM fin_transactions ORDER BY external_id").map(row => row.txn_uid);
      fixture.raw("UPDATE fin_transactions SET raw_amount_minor=-12347,amount_minor=12347 WHERE external_id='sample'");
      fixture.raw("UPDATE fin_transactions SET raw_amount_minor=29,amount_minor=29 WHERE external_id='credit'");
      fixture.raw("UPDATE fin_balance_snapshots SET provider_position_minor=12347,current_minor=12347,available_minor=29");
      fixture.raw("UPDATE simplefin_sync_windows SET state='staged'");
      state.date = "2026-09-29";
      assert.equal((await pull()).partial, false);
      assert.deepEqual(fixture.rows("SELECT txn_uid,raw_amount_minor FROM fin_transactions WHERE removed_at IS NULL ORDER BY external_id")
        .map(row => [row.txn_uid, row.raw_amount_minor]), [[previous[0], 290], [previous[1], -123470]]);
      assert.equal(fixture.first("SELECT provider_position_minor FROM fin_balance_snapshots").provider_position_minor, 123470);
    }
  });
}

for (const [name, field, warning, blocker] of generatedRows([
  ["code and msg", "errlist", { code: "gen.api", msg: RANGE_WARNING }, { code: "other", msg: RANGE_WARNING }],
  ["code and text", "errlist", { code: "gen.api", text: RANGE_WARNING }, { code: "gen.api", msg: 7, text: RANGE_WARNING }],
  ["conflicting fields", "errlist", { code: "gen.api", msg: RANGE_WARNING, text: RANGE_WARNING },
    { code: "gen.api", msg: RANGE_WARNING, text: "The response was capped." }],
  ["legacy string", "errors", RANGE_WARNING, RANGE_WARNING + " "],
  ["same-list cap", "errlist", RANGE_WARNING, { kind: "advisory", text: "The response was capped." }],
  ["cross-list cap", "errors", RANGE_WARNING, "The response was capped."],
])) {
  test(`SimpleFIN issue types survive redaction and the display bound: ${name}`, async t => {
    const { fixture, state, pull, assign, status } = await reviewPull(t);
    const repeated = Array(25).fill(warning);
    fixture.raw("UPDATE simplefin_connections SET backfill_start='2026-09-26',backfill_next='2026-09-26',backfill_end='2026-09-27'");
    state.issues = { [field]: repeated };
    assert.equal((await pull()).partial, false);
    await assign();
    state.date = "2026-09-29";
    assert.equal((await pull()).partial, false);
    state.date = "2026-09-30";
    assert.equal((await pull()).partial, false);
    const clean = await status();
    assert.equal(clean.connections[0].health.state, "healthy");
    assert.ok(clean.connections[0].provider_errors.some(text => text.includes("[access reference removed]")));
    await t.test("verified advisory needs no owner action", () => {
      assert.equal(clean.needs_attention.length, 0);
    });

    const pagePath = "/app/connect/bank";
    const headers = await fixture.ownerHeaders();
    const route = (path, init = {}) => {
      const request = new Request("https://brain.invalid" + path, { ...init, headers: { ...headers, ...init.headers } });
      return handleBankFeed(fixture.env, request, new URL(request.url), path, { bankFeedNow: state.date + "T12:00:00.000Z" });
    };
    const page = await route(pagePath);
    assert.equal(page.status, 200);
    const html = await page.text();
    const elements = new Map();
    const element = () => ({
      children: [], append(...entries) { this.children.push(...entries); },
      replaceChildren(...entries) { this.children = entries; },
    });
    const context = createContext({
      URLSearchParams, window: { location: { search: "" } },
      document: { createElement: element, getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      } },
      fetch: (path, init) => path === "/api/bank-feed/status" ? route(path, init) : json({}),
    });
    runInContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], context, { timeout: 1000 });
    const renderedCard = async () => {
      await runInContext("loadConnections()", context);
      const paragraphs = elements.get("connections").children[0].children;
      assert.ok(paragraphs, "the real status route populated a connection card");
      return paragraphs;
    };
    const rendered = async () => {
      return (await renderedCard()).filter(node => clean.connections[0].provider_errors.includes(node.textContent) ||
        node.textContent === "The response was capped.");
    };
    await t.test("the account page renders the advisory as a note", async () => {
      const messages = await rendered();
      assert.ok(messages.length > 0, "the rendered provider message reached the style decision");
      assert.ok(messages.every(message => message.className === "note"));
    });

    fixture.raw("UPDATE simplefin_connections SET backfill_next='2026-06-15',backfill_end='2026-09-27'");
    state.date = "2026-10-01";
    state.issues = name === "cross-list cap"
      ? { errlist: repeated, errors: [blocker] } : { [field]: [...repeated, blocker] };
    assert.equal((await pull()).partial, true);
    assert.equal(fixture.first("SELECT backfill_next FROM simplefin_connections").backfill_next, "2026-06-15");
    assert.equal((await status()).needs_attention.length, 1);
    await t.test("the account page retains blocking guidance ahead of duplicate advisories", async () => {
      const messages = await rendered();
      assert.equal(messages[0].className, "err", "blocking guidance has priority");
      if (name.endsWith("list cap") || name === "conflicting fields") {
        assert.equal(messages[0].textContent, "The response was capped.");
        assert.deepEqual(messages.map(message => message.className), ["err", "note"]);
      } else {
        assert.equal(messages.length, 1, "a blocking issue wins when both sanitized texts match");
      }
    });
    if (name === "cross-list cap") await t.test("the account page displays the current currency rejection after a successful pull", async () => {
      state.date = "2026-10-02";
      state.issues = {};
      state.currency = "ZZZ";
      assert.equal((await pull()).code, "simplefin_currency_unsupported");
      const { status_detail, last_synced_at } = (await status()).connections[0];
      assert.ok(last_synced_at);
      assert.match(status_detail, /currency.*does not support/);
      const current = (await renderedCard()).find(message => message.textContent === status_detail);
      assert.equal(current?.className, "err", "the current sanitized rejection is visible on the connection card");
    });
  });
}

test("provider issues retain safe guidance without persisting access-credential fragments", async () => {
  const shortAccessUrl = "https://u7:p8@bridge.example.invalid/data/private-reference";
  const encodedAccessUrl = encodeURIComponent(shortAccessUrl);
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin",
    BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: WRAPPING_KEY,
  } });
  let providerPulls = 0;
  const fetchImpl = async (input, init = {}) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      return new Response(shortAccessUrl, { status: 200 });
    }
    providerPulls++;
    const expected = new URL(shortAccessUrl); expected.username = ""; expected.password = "";
    assert.ok(request.url.startsWith(`${expected.href}/accounts?`),
      "the pull decision point decrypted the stored access reference");
    return json({
      accounts: [],
      errlist: [
        "The connection named u7 was refused with p8.",
        `The encoded access address was ${encodedAccessUrl}.`,
        `The full access address was ${shortAccessUrl}.`,
        "The institution is refreshing. Try again later.",
      ],
    });
  };
  try {
    const claim = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-redaction-claim-0001",
      setup_token: SETUP_TOKEN,
    }, fetchImpl);
    assert.equal(claim.status, 201, "green control: the real claim path created a connection");
    fixture.raw("UPDATE simplefin_connections SET next_pull_at='2000-01-01T00:00:00.000Z'");

    const { runSimpleFinMaintenance, simpleFinFeedStatus } =
      await import("../src/lib/simplefin-bank-feed.js");
    const result = await runSimpleFinMaintenance(fixture.env, {
      fetchImpl,
      now: "2026-09-29T12:00:00.000Z",
      maxRequestsPerItem: 1,
    });
    assert.equal(providerPulls, 1, "the provider issue-text decision point ran once");
    assert.equal(result.items[0].partial, true,
      "green control: provider issues remain visible as a partial pull");

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
    const surfaces = JSON.stringify({
      stored: fixture.first("SELECT last_errlist_json FROM simplefin_connections"),
      status: await simpleFinFeedStatus(fixture.env),
      page: await page.text(),
    });
    assert.match(surfaces, /institution is refreshing/i,
      "safe provider guidance remains available to the owner");
    for (const forbidden of [shortAccessUrl, encodedAccessUrl, "u7", "p8", "private-reference"]) {
      assert.equal(surfaces.includes(forbidden), false,
        "access-reference values and components never cross the storage or owner boundary");
    }
  } finally {
    fixture.close();
  }
});

test("the durable request budget is monotonic across UTC rollback and later-day reset", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin",
    BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: WRAPPING_KEY,
  } });
  const fake = provider({ accounts: { accounts: [], errlist: [] } });
  try {
    const claim = await ownerRequest(fixture, "/api/bank-feed/simplefin/claim", {
      request_id: "simplefin-budget-claim-0001",
      setup_token: SETUP_TOKEN,
    }, fake.fetchImpl);
    assert.equal(claim.status, 201, "green control: the real claim path created a connection");
    fixture.raw(
      "UPDATE simplefin_connections SET request_day='2026-09-29',requests_today=24,next_pull_at='2000-01-01T00:00:00.000Z'",
    );

    const { runSimpleFinMaintenance } = await import("../src/lib/simplefin-bank-feed.js");
    const rolledBack = await runSimpleFinMaintenance(fixture.env, {
      fetchImpl: fake.fetchImpl,
      now: "2026-09-28T12:00:00.000Z",
      maxRequestsPerItem: 1,
    });
    assert.equal(rolledBack.items[0].code, "simplefin_daily_request_limit");
    assert.equal(fake.calls.filter((call) => call.method === "GET").length, 0,
      "the rollback decision point refuses before provider transport");
    const rollbackBudget = fixture.first(
      "SELECT request_day,requests_today FROM simplefin_connections",
    );
    assert.equal(rollbackBudget.request_day, "2026-09-29",
      "a backward clock cannot lower the durable day watermark");
    assert.equal(rollbackBudget.requests_today, 24,
      "a backward clock cannot lower the durable request count");

    fixture.raw("UPDATE simplefin_connections SET next_pull_at='2000-01-01T00:00:00.000Z'");
    const laterDay = await runSimpleFinMaintenance(fixture.env, {
      fetchImpl: fake.fetchImpl,
      now: "2026-09-30T12:00:00.000Z",
      maxRequestsPerItem: 1,
    });
    assert.equal(laterDay.items[0].ok, true,
      "green control: a strictly later UTC day starts a new budget bucket");
    assert.equal(fake.calls.filter((call) => call.method === "GET").length, 1);
    const resetBudget = fixture.first(
      "SELECT request_day,requests_today FROM simplefin_connections",
    );
    assert.equal(resetBudget.request_day, "2026-09-30");
    assert.equal(resetBudget.requests_today, 1);
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
    assert.equal(fake.calls.filter((call) => call.method === "GET").length, 1);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM simplefin_sync_windows").n, 1);
  } finally {
    globalThis.fetch = previousFetch;
    fixture.close();
  }
});

test("historical SimpleFIN three-decimal amounts require a provider re-read", async t => {
  const { fixture, state, pull, assign, now } = await reviewPull(t);
  Object.assign(state, { currency: "KWD" });
  assert.equal((await pull()).partial, false);
  await assign();
  const { queryMoney } = await import("../src/lib/money-query.js");
  const [transactions, balances, raw] = [
    { sql: "SELECT currency,SUM(amount_minor) AS figure FROM txn WHERE posted_on BETWEEN '2026-09-20' AND '2026-09-20' GROUP BY currency",
      from: "2026-09-20", through: "2026-09-20" },
    { sql: "SELECT currency,SUM(current_minor) AS figure FROM fin_balance_snapshots GROUP BY currency" },
    { sql: "SELECT currency,SUM(amount_minor) AS figure FROM fin_transactions GROUP BY currency" },
  ];
  const ask = body => queryMoney(fixture.env, body, { now: () => Date.parse(now()) });
  for (const body of [transactions, balances, raw]) {
    const result = await ask(body);
    assert.doesNotMatch(result.confidence_text, /SimpleFIN minor-unit evidence could not be checked|SimpleFIN KWD.*unconfirmed/);
  }
  for (const [body, kind, boundary, update, restore] of [
    [raw, "transactions", "SUM(amount_minor)",
      "UPDATE fin_transactions SET amount_minor=12347,source_locator='bank-feed:legacy#transaction' WHERE direction='outflow'",
      "fin_transactions"],
    [balances, "balance observations", "WITH mq_rb AS MATERIALIZED",
      "UPDATE fin_balance_snapshots SET current_minor=12347,source_locator='bank-feed:legacy#balance'",
      "fin_balance_snapshots"],
  ]) {
    await t.test(`minor-unit evidence follows the exact ${kind} read`, async t => {
      const prepare = fixture.env.DB.prepare;
      const row = fixture.first(`SELECT source_locator,${restore === "fin_transactions" ? "amount_minor AS amount FROM fin_transactions WHERE direction='outflow'" : "current_minor AS amount FROM fin_balance_snapshots"}`);
      const amount = restore === "fin_transactions" ? "amount_minor" : "current_minor";
      const where = restore === "fin_transactions" ? " WHERE direction='outflow'" : "";
      let changed = false;
      t.mock.method(fixture.env.DB, "prepare", sql => {
        if (!changed && !sql.startsWith("EXPLAIN ") && sql.includes(boundary)) {
          fixture.raw(update);
          changed = true;
        }
        return prepare(sql);
      });
      try {
        const result = await ask(body);
        assert.equal(changed, true);
        assert.equal(result.rows[0].figure, kind === "transactions" ? 12637 : 12347);
        assert.match(result.confidence_text, new RegExp("SimpleFIN KWD " + kind + ".*unconfirmed"));
      } finally {
        fixture.raw(`UPDATE ${restore} SET source_locator=?,${amount}=?${where}`, row.source_locator, row.amount);
      }
    });
  }
  fixture.raw("UPDATE fin_transactions SET source_locator='bank-feed:legacy#simplefin/transaction/fixture', amount_minor=12347 WHERE direction='outflow'");
  fixture.raw("UPDATE fin_balance_snapshots SET source_locator='bank-feed:legacy#balance', current_minor=12347, provider_position_minor=12347");
  for (const [body, kind] of [[transactions, "transactions"], [balances, "balance observations"], [raw, "transactions"]]) {
    const result = await ask(body);
    assert.ok(result.rows.length, "the owner still gets a figure");
    assert.ok(result.confidence.percent < 90);
    assert.match(result.confidence_text, new RegExp("SimpleFIN KWD " + kind + ".*unconfirmed"));
    assert.match(result.confidence_text, /Re-read.*SimpleFIN/);
  }
  assert.equal(fixture.first("SELECT amount_minor FROM fin_transactions WHERE direction='outflow'").amount_minor, 12347);
  assert.equal(fixture.first("SELECT current_minor FROM fin_balance_snapshots").current_minor, 12347);
  // Normal maintenance leaves promoted history intact. The guard does not
  // clear just because a newer pull succeeded.
  state.date = "2026-09-29";
  await pull();
  assert.equal(fixture.first("SELECT amount_minor FROM fin_transactions WHERE direction='outflow'").amount_minor, 12347);
  assert.match((await ask(transactions)).confidence_text, /SimpleFIN KWD transactions.*unconfirmed/);
});
