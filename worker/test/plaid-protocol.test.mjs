import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLAID_PROFILE, bankFeedProfile } from "../src/lib/bank-feed-profiles.js";
import { bankFeedConfig, bankFeedEnabled, connectPageHtml, encryptAccessReference } from "../src/lib/bank-feed.js";
import {
  PLAID_HISTORY_STATE,
  PLAID_SYNC_MAX_WINDOW_PAGES,
  PlaidProtocolError,
  buildPlaidLinkTokenRequest,
  plaidExchangeDecision,
  plaidLinkCompletion,
  plaidLinkTokenDecision,
  mergePlaidHistoryState,
  normalisePlaidHistoryState,
  plaidRevocationTransition,
  plaidWebhookDisposition,
  stagePlaidSyncWindow,
  validatePlaidSyncCursorHistory,
  verifyPlaidWebhook,
} from "../src/lib/plaid-protocol.js";
import { runPlaidLiveSandbox, runPlaidSandboxRehearsal } from "../../operations/plaid-sandbox-runner.mjs";

import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { syncPlaidItem } from "../src/lib/plaid-bank-feed.js";
import { discoverPlaidAccountAssignments } from "../src/lib/plaid-account-entities.js";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(name);
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL  ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push(name);
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL  ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

check("Plaid profile pins public sandbox and production endpoints", () => {
  assert.deepEqual(PLAID_PROFILE.apiBases, {
    sandbox: "https://sandbox.plaid.com",
    production: "https://production.plaid.com",
  });
});

check("Plaid profile supplies no credential", () => {
  const profile = bankFeedProfile({ BANK_FEED_PROVIDER: "plaid" }, "sandbox");
  assert.equal(profile.provider, "plaid");
  assert.equal(profile.apiBase, "https://sandbox.plaid.com");
  assert.equal(JSON.stringify(profile).includes("secret"), false);
});

check("named Plaid profile reaches the bank-feed runtime only with credentials", () => {
  const uncredentialed = { BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox" };
  assert.equal(bankFeedEnabled(uncredentialed), false);
  const configured = {
    ...uncredentialed,
    BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  };
  assert.equal(bankFeedEnabled(configured), true);
  const runtime = bankFeedConfig(configured);
  assert.equal(runtime.provider, "plaid");
  assert.equal(runtime.apiBase, "https://sandbox.plaid.com");
  assert.equal(runtime.linkGlobal, "Plaid");
});

check("Plaid Link CSP permits only the selected environment API origin", () => {
  const base = {
    BANK_FEED_PROVIDER: "plaid",
    BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  };
  const sandbox = connectPageHtml(bankFeedConfig({ ...base, BANK_FEED_ENV: "sandbox" })).csp;
  const production = connectPageHtml(bankFeedConfig({ ...base, BANK_FEED_ENV: "production" })).csp;
  assert.match(sandbox, /connect-src 'self' https:\/\/sandbox\.plaid\.com https:\/\/cdn\.plaid\.com/);
  assert.doesNotMatch(sandbox, /production\.plaid\.com/);
  assert.match(production, /connect-src 'self' https:\/\/production\.plaid\.com https:\/\/cdn\.plaid\.com/);
  assert.doesNotMatch(production, /sandbox\.plaid\.com/);
});

check("an explicit custom endpoint remains explicit", () => {
  const profile = bankFeedProfile({
    BANK_FEED_PROVIDER: "custom",
    BANK_FEED_API_BASE: "https://provider.example",
    BANK_FEED_LINK_SDK_URL: "https://provider.example/link.js",
    BANK_FEED_LINK_GLOBAL: "ProviderLink",
  }, "sandbox");
  assert.equal(profile.provider, "custom");
  assert.equal(profile.apiBase, "https://provider.example");
});

check("manifest schema names Plaid without accepting Plaid endpoint overrides", () => {
  const schema = JSON.parse(readFileSync(new URL("../../manifest.schema.json", import.meta.url), "utf8"));
  const feed = schema.properties.corpora.properties.bank_feed;
  assert.deepEqual(feed.properties.provider.enum, ["plaid", "custom"]);
  assert.equal(feed.properties.provider.default, "plaid");
  assert.equal(JSON.stringify(feed.allOf).includes("api_base"), true);
});

check("public manifest template keeps Plaid disabled and contains no credential", () => {
  const template = JSON.parse(readFileSync(new URL("../../templates/brain.manifest.json", import.meta.url), "utf8"));
  const feed = template.corpora.bank_feed;
  const runtimeFeed = Object.fromEntries(
    Object.entries(feed).filter(([key]) => !key.startsWith("_")),
  );
  assert.equal(feed.enabled, false);
  assert.equal(feed.provider, "plaid");
  assert.equal(feed.environment, "sandbox");
  assert.equal(/client_id|secret/i.test(JSON.stringify(runtimeFeed)), false);
});

check("connect mode asks only for read-only Transactions", () => {
  const request = buildPlaidLinkTokenRequest({
    mode: "connect",
    clientName: "Fixture Brain",
    endUserRef: "install:fixture",
    redirectUri: "https://fixture.example/app/connect/bank",
    webhookUri: "https://fixture.example/api/webhooks/plaid",
  });
  assert.deepEqual(request.products, ["transactions"]);
  assert.equal(request.transactions.days_requested, 730);
});

check("update mode supplies access_token and omits product parameters", () => {
  const request = buildPlaidLinkTokenRequest({
    mode: "reauthorise",
    clientName: "Fixture Brain",
    endUserRef: "install:fixture",
    redirectUri: "https://fixture.example/app/connect/bank",
    accessToken: "access-fixture",
  });
  assert.equal(request.access_token, "access-fixture");
  assert.equal(Object.hasOwn(request, "products"), false);
  assert.equal(Object.hasOwn(request, "transactions"), false);
  assert.equal(Object.hasOwn(request, "webhook"), false);
});

check("update completion never exchanges a public token", () => {
  assert.deepEqual(plaidLinkCompletion({ mode: "reauthorise" }), {
    action: "keep_existing_access_token",
    exchangeRequired: false,
  });
});

check("completed Link-token creation replays the same unexpired durable receipt", () => {
  const receipt = { linkToken: "link-fixture", expiresAt: "2026-08-30T20:00:00.000Z" };
  assert.deepEqual(
    plaidLinkTokenDecision(
      { state: "link_ready", requestFingerprint: "fp", receipt },
      "fp",
      { now: Date.parse("2026-08-30T19:00:00.000Z") },
    ),
    { action: "return_link_receipt", receipt },
  );
});

check("ambiguous Link-token creation is replaceable before Item authorization", () => {
  assert.deepEqual(
    plaidLinkTokenDecision({ state: "link_create_started", requestFingerprint: "fp" }, "fp"),
    { action: "create_replacement", reason: "provider_outcome_unknown" },
  );
});

check("completed Link exchange replays its durable receipt", () => {
  const receipt = { itemRef: "fixture-item", status: "queued" };
  assert.deepEqual(
    plaidExchangeDecision({ state: "completed", requestFingerprint: "fp", receipt }, "fp"),
    { action: "return_receipt", receipt },
  );
});

check("ambiguous provider exchange fails closed instead of reusing a one-time token", () => {
  const decision = plaidExchangeDecision({ state: "exchange_started", requestFingerprint: "fp" }, "fp");
  assert.equal(decision.action, "manual_recovery");
  assert.equal(decision.code, "PLAID_EXCHANGE_OUTCOME_UNKNOWN");
});

check("link completion refuses a mismatched session fingerprint", () => {
  assert.throws(
    () => plaidExchangeDecision({ state: "link_completed", requestFingerprint: "a" }, "b"),
    (error) => error instanceof PlaidProtocolError && error.code === "LINK_SESSION_MISMATCH",
  );
});

check("revocation never erases a token before provider confirmation", () => {
  const knownNegative = plaidRevocationTransition({ state: "pending", providerResult: { removed: false } });
  const unknown = plaidRevocationTransition({
    state: "pending",
    providerResult: { removed: false, outcomeUnknown: true },
  });
  assert.equal(knownNegative.eraseAccessToken, false);
  assert.equal(knownNegative.outcomeState, "not_removed");
  assert.equal(knownNegative.retrySafe, true);
  assert.equal(unknown.eraseAccessToken, false);
  assert.equal(unknown.outcomeState, "unknown");
  assert.equal(unknown.retrySafe, false);
  assert.equal(plaidRevocationTransition({ state: "pending", providerResult: { removed: true } }).eraseAccessToken, true);
});

check("replay and out-of-order webhook states are explicit", () => {
  const replay = plaidWebhookDisposition({
    deliverySeen: true,
    payload: {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      initial_update_complete: true,
    },
  });
  assert.equal(replay.state, "replay");
  assert.equal(replay.scheduleReconciliation, true);
  assert.equal(replay.historyState, PLAID_HISTORY_STATE.INITIAL);
  assert.deepEqual(
    plaidWebhookDisposition({
      issuedAt: 10,
      lastIssuedAt: 20,
      payload: { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" },
    }).state,
    "out_of_order",
  );
});

check("Plaid history evidence is monotonic and unknown values never imply completion", () => {
  assert.equal(normalisePlaidHistoryState("made_up"), PLAID_HISTORY_STATE.UNKNOWN);
  assert.equal(
    mergePlaidHistoryState(PLAID_HISTORY_STATE.NOT_READY, PLAID_HISTORY_STATE.INITIAL),
    PLAID_HISTORY_STATE.INITIAL,
  );
  assert.equal(
    mergePlaidHistoryState(PLAID_HISTORY_STATE.HISTORICAL, PLAID_HISTORY_STATE.NOT_READY),
    PLAID_HISTORY_STATE.HISTORICAL,
  );
});

await checkAsync("an empty initial sync remains partial without historical provider evidence", async () => {
  let staged = null;
  const receipt = await stagePlaidSyncWindow({
    requestPage: async () => ({
      added: [], modified: [], removed: [], next_cursor: "empty-initial", has_more: false,
      transactions_update_status: "NOT_READY",
    }),
    resetWindow: async () => {},
    stagePage: async (page) => { staged = page; },
    promoteWindow: async (promotion) => promotion,
  });
  assert.equal(staged.historyState, PLAID_HISTORY_STATE.NOT_READY);
  assert.equal(receipt.historyState, PLAID_HISTORY_STATE.NOT_READY);
  assert.deepEqual(receipt.counts, { added: 0, modified: 0, removed: 0 });
});

await checkAsync("sync refuses to run without durable staging callbacks", async () => {
  await assert.rejects(
    () => stagePlaidSyncWindow({}),
    (error) => error instanceof PlaidProtocolError && error.code === "INVALID_SYNC_CALLBACKS",
  );
});

await checkAsync("sync resumes a durably staged window without committing an intermediate cursor", async () => {
  const staged = new Map([[0, { pageIndex: 0, nextCursor: "resume-page-2" }]]);
  let committedCursor = null;
  const receipt = await stagePlaidSyncWindow({
    originalCursor: null,
    resumeCursor: "resume-page-2",
    resumePageIndex: 1,
    resumeCounts: { added: 1, modified: 0, removed: 0 },
    resumeCursorDigests: await cursorHistory(null, "resume-page-2"),
    requestPage: async ({ cursor }) => {
      assert.equal(cursor, "resume-page-2");
      return {
        added: [{
          transaction_id: "resumed-posted",
          pending_transaction_id: "resumed-pending",
          account_id: "resume-account",
          amount: "1.23",
          iso_currency_code: "USD",
          date: "2026-08-30",
          pending: false,
          name: "Resumed fixture",
        }],
        modified: [],
        removed: [],
        next_cursor: "resume-complete",
        has_more: false,
        transactions_update_status: "INITIAL_UPDATE_COMPLETE",
      };
    },
    resetWindow: async () => assert.fail("a valid durable resume must not reset its staged first page"),
    stagePage: async (page) => staged.set(page.pageIndex, page),
    promoteWindow: async (promotion) => {
      assert.equal(committedCursor, null);
      committedCursor = promotion.finalCursor;
      return promotion;
    },
  });
  assert.equal(staged.size, 2);
  assert.equal(committedCursor, "resume-complete");
  assert.deepEqual(receipt.counts, { added: 2, modified: 0, removed: 0 });
  assert.equal(receipt.historyState, PLAID_HISTORY_STATE.INITIAL);
});

function syncTransaction(overrides = {}) {
  return {
    transaction_id: "protocol-transaction", account_id: "protocol-account", amount: "1.23",
    date: "2026-08-30", pending: false, name: "Synthetic purchase",
    merchant_name: null, pending_transaction_id: null, authorized_date: null,
    iso_currency_code: "USD", unofficial_currency_code: null, personal_finance_category: null,
    ...overrides,
  };
}

function syncPage(overrides = {}) {
  return {
    added: [syncTransaction()], modified: [], removed: [], next_cursor: "protocol-final",
    has_more: false, transactions_update_status: PLAID_HISTORY_STATE.HISTORICAL, ...overrides,
  };
}

async function cursorHistory(...cursors) {
  return Promise.all(cursors.map(async (cursor) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(cursor)));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
  }));
}

async function rejectSyncPage(page, options = {}) {
  let staged = 0;
  let promoted = 0;
  let requested = 0;
  await assert.rejects(() => stagePlaidSyncWindow({
    originalCursor: "protocol-committed",
    ...options,
    requestPage: async () => { assert.equal(++requested, 1); return page; },
    resetWindow: async () => {},
    stagePage: async () => { staged += 1; },
    promoteWindow: async () => { promoted += 1; },
  }), (error) => {
    assert.ok(error instanceof PlaidProtocolError);
    assert.ok(["INVALID_SYNC_PAGE", "INVALID_AMOUNT"].includes(error.code));
    assert.doesNotMatch(error.message, /protocol-transaction|Synthetic purchase|private-payload-canary/);
    return true;
  });
  assert.equal(staged, 0, "the whole malformed page must be rejected before durable staging");
  assert.equal(promoted, 0, "a malformed page must not promote a committed cursor");
}

for (const value of [undefined, null, 0, 1, "false", "true", {}, []]) {
  await checkAsync(`sync refuses a nonboolean completion flag: ${JSON.stringify(value)}`, () =>
    rejectSyncPage(syncPage({ has_more: value })));
}
for (const field of ["added", "modified", "removed"]) {
  for (const value of [undefined, null, {}, "private-payload-canary", 0]) {
    await checkAsync(`sync refuses a non-array ${field}: ${JSON.stringify(value)}`, () =>
      rejectSyncPage(syncPage({ [field]: value })));
  }
  await checkAsync(`sync refuses sparse ${field} without dropping its missing record`, () =>
    rejectSyncPage(syncPage({ [field]: Array(1) })));
}
for (const value of [undefined, null, false, 7, {}, [], " ", " padded-cursor ", "x".repeat(257)]) {
  await checkAsync(`sync refuses a malformed cursor: ${JSON.stringify(value)}`, () =>
    rejectSyncPage(syncPage({ next_cursor: value })));
}
for (const value of [null, [], "private-payload-canary", 7]) {
  await checkAsync(`sync refuses a non-object page: ${JSON.stringify(value)}`, () => rejectSyncPage(value));
}
const invalidTransactionFields = [
  ["transaction_id", {}], ["transaction_id", 7], ["transaction_id", " padded-id "],
  ["account_id", []], ["account_id", true], ["pending", undefined], ["pending", "false"],
  ["pending", null], ["date", undefined], ["date", null], ["date", "2026-02-30"],
  ["date", "2026-08-30T00:00:00Z"], ["authorized_date", "not-a-date"],
  ["name", {}], ["merchant_name", {}], ["pending_transaction_id", []],
  ["iso_currency_code", {}], ["unofficial_currency_code", false],
  ["personal_finance_category", "private-payload-canary"],
  ["personal_finance_category", { primary: "FOOD" }],
  ["personal_finance_category", { primary: {}, detailed: "MEAL" }],
  ["amount", null], ["amount", "not-money"],
];
for (const collection of ["added", "modified"]) {
  for (const [field, value] of invalidTransactionFields) {
    await checkAsync(`sync rejects malformed ${collection} transaction ${field}: ${JSON.stringify(value)}`, () =>
      rejectSyncPage(syncPage({ [collection]: [syncTransaction({ transaction_id: "valid-before-invalid" }), syncTransaction({ [field]: value })] })));
  }
  for (const record of [null, [], "private-payload-canary"]) {
    await checkAsync(`sync rejects a malformed ${collection} record: ${JSON.stringify(record)}`, () =>
      rejectSyncPage(syncPage({ [collection]: [record] })));
  }
}
for (const record of [null, [], {}, { transaction_id: {} }, { transaction_id: 9 }, { transaction_id: " padded-id " }]) {
  await checkAsync(`sync rejects a malformed removal: ${JSON.stringify(record)}`, () =>
    rejectSyncPage(syncPage({ removed: [record] })));
}

await checkAsync("valid nullable fields, both currency forms, and decimal amounts retain their exact supported meaning", async () => {
  let staged;
  const receipt = await stagePlaidSyncWindow({
    requestPage: async () => syncPage({
      added: [syncTransaction(), syncTransaction({
        transaction_id: "nullable-transaction", amount: -2.5, iso_currency_code: null,
        unofficial_currency_code: "XBT", pending: true,
        personal_finance_category: { primary: "FOOD", detailed: "MEAL", confidence_level: null },
      })],
      modified: [syncTransaction({ transaction_id: "modified-transaction", authorized_date: "2024-02-29" })],
      removed: [{ transaction_id: "removed-transaction", account_id: null }],
    }),
    resetWindow: async () => {}, stagePage: async (page) => { staged = page; },
    promoteWindow: async (promotion) => promotion,
  });
  assert.deepEqual(receipt.counts, { added: 2, modified: 1, removed: 1 });
  assert.equal(staged.added[0].merchantName, null);
  assert.equal(staged.added[0].authorizedDate, null);
  assert.equal(staged.added[0].pendingTransactionId, null);
  assert.equal(staged.added[1].amount, "-2.5");
  assert.equal(staged.added[1].isoCurrencyCode, null);
  assert.equal(staged.added[1].unofficialCurrencyCode, "XBT");
  assert.equal(staged.added[1].pending, true);
  assert.equal(staged.modified[0].authorizedDate, "2024-02-29");
});

await checkAsync("a malformed later page preserves the exact staged prefix and resumes without cursor promotion", async () => {
  const pages = [];
  let committed = "protocol-committed";
  let requested = 0;
  const callbacks = {
    originalCursor: committed,
    resetWindow: async () => { pages.length = 0; },
    stagePage: async (page) => { pages.push(page); },
    promoteWindow: async (receipt) => { committed = receipt.finalCursor; return receipt; },
  };
  await assert.rejects(() => stagePlaidSyncWindow({ ...callbacks,
    requestPage: async () => ++requested === 1
      ? syncPage({ next_cursor: "protocol-resume", has_more: true, transactions_update_status: PLAID_HISTORY_STATE.INITIAL })
      : syncPage({ removed: null }),
  }), (error) => error.code === "INVALID_SYNC_PAGE");
  assert.equal(committed, "protocol-committed");
  assert.equal(pages.length, 1);
  const prefix = structuredClone(pages[0]);
  const receipt = await stagePlaidSyncWindow({ ...callbacks,
    resumeCursor: prefix.nextCursor, resumeHistoryState: prefix.historyState, resumePageIndex: 1,
    resumeCursorDigests: prefix.cursorDigests,
    resumeCounts: { added: 1, modified: 0, removed: 0 },
    resetWindow: async () => assert.fail("durable prefix must be preserved"),
    requestPage: async ({ cursor }) => { assert.equal(cursor, "protocol-resume"); return syncPage({ added: [], removed: [{ transaction_id: "removed-transaction" }] }); },
  });
  assert.deepEqual(pages[0], prefix);
  assert.equal(committed, "protocol-final");
  assert.deepEqual(receipt.counts, { added: 1, modified: 0, removed: 1 });
});

await checkAsync("only a valid initial empty sync can complete with an empty cursor and incomplete history", async () => {
  for (const history of [PLAID_HISTORY_STATE.UNKNOWN, PLAID_HISTORY_STATE.NOT_READY]) {
    let staged;
    const receipt = await stagePlaidSyncWindow({
      requestPage: async () => syncPage({ added: [], next_cursor: "", transactions_update_status: history }),
      resetWindow: async () => {}, stagePage: async (page) => { staged = page; },
      promoteWindow: async (promotion) => promotion,
    });
    assert.equal(receipt.finalCursor, "");
    assert.equal(receipt.historyState, history);
    assert.deepEqual(receipt.counts, { added: 0, modified: 0, removed: 0 });
    assert.equal(staged.hasMore, false);
  }
  for (const overrides of [{ has_more: true }, { added: [syncTransaction()] },
    { transactions_update_status: PLAID_HISTORY_STATE.INITIAL },
    { transactions_update_status: PLAID_HISTORY_STATE.HISTORICAL }]) {
    await rejectSyncPage(syncPage({ added: [], next_cursor: "", transactions_update_status: PLAID_HISTORY_STATE.NOT_READY, ...overrides }), { originalCursor: null });
  }
});

await checkAsync("empty and non-advancing cursors never reset existing history or continue pagination", async () => {
  await rejectSyncPage(syncPage({ added: [], next_cursor: "", transactions_update_status: PLAID_HISTORY_STATE.NOT_READY }));
  await rejectSyncPage(syncPage({ next_cursor: "protocol-committed", has_more: true }));
  await rejectSyncPage(syncPage({ added: [], next_cursor: "", transactions_update_status: PLAID_HISTORY_STATE.NOT_READY }), {
    originalCursor: null, originalHistoryState: PLAID_HISTORY_STATE.HISTORICAL,
  });
  await rejectSyncPage(syncPage({ transactions_update_status: { state: "HISTORICAL_UPDATE_COMPLETE" } }));
});

for (const terminalCycle of [false, true]) {
  await checkAsync(`a multi-page cursor cycle is refused before staging its repeated page (terminal=${terminalCycle})`, async () => {
    const staged = [];
    let requested = 0, promoted = 0;
    await assert.rejects(() => stagePlaidSyncWindow({
      originalCursor: "private-cycle-origin",
      requestPage: async () => {
        requested += 1;
        assert.ok(requested <= 3, "the cycle must be rejected without another provider request");
        return syncPage({ added: [], next_cursor: ["private-cycle-A", "private-cycle-B", "private-cycle-A"][requested - 1], has_more: !(terminalCycle && requested === 3) });
      },
      resetWindow: async () => {},
      stagePage: async (page) => staged.push(page),
      promoteWindow: async () => { promoted += 1; },
    }), (error) => error instanceof PlaidProtocolError && error.code === "INVALID_SYNC_PAGE" && !/private-cycle/.test(error.message));
    assert.equal(requested, 3);
    assert.deepEqual(staged.map(page => page.nextCursor), ["private-cycle-A", "private-cycle-B"]);
    assert.equal(promoted, 0);
  });
}

await checkAsync("a resumed window cannot return to its original committed cursor", async () => {
  await rejectSyncPage(syncPage({ added: [], next_cursor: "protocol-committed" }), {
    resumeCursor: "protocol-resume", resumePageIndex: 1, resumeCounts: { added: 1, modified: 0, removed: 0 },
    resumeCursorDigests: await cursorHistory("protocol-committed", "protocol-resume"),
  });
});

await checkAsync("terminal no-change responses and documented 256-character cursors remain valid", async () => {
  for (const cursor of ["protocol-committed", "A".repeat(256)]) {
    let staged;
    const receipt = await stagePlaidSyncWindow({
      originalCursor: cursor,
      requestPage: async () => syncPage({ added: [], next_cursor: cursor }),
      resetWindow: async () => {}, stagePage: async (page) => { staged = page; }, promoteWindow: async (r) => r,
    });
    assert.equal(receipt.finalCursor, cursor);
    assert.equal(receipt.pageCount, 1);
    assert.deepEqual(await validatePlaidSyncCursorHistory({ originalCursor: cursor, resumeCursor: cursor,
      pageIndex: 1, cursorDigests: staged.cursorDigests, complete: true }), staged.cursorDigests);
  }
});

await checkAsync("a provider mutation restart clears the cursor-cycle set with the staged prefix", async () => {
  let requested = 0;
  const staged = [];
  const receipt = await stagePlaidSyncWindow({
    originalCursor: "mutation-original",
    requestPage: async () => {
      requested += 1;
      if (requested === 2) throw new PlaidProtocolError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "synthetic mutation");
      return syncPage({ added: [], next_cursor: requested === 4 ? "mutation-final" : "mutation-first", has_more: requested !== 4 });
    },
    resetWindow: async () => { staged.length = 0; },
    stagePage: async (page) => { staged.push(page.nextCursor); },
    promoteWindow: async (r) => r,
  });
  assert.equal(receipt.pageCount, 2);
  assert.equal(receipt.mutationRestarts, 1);
  assert.deepEqual(staged, ["mutation-first", "mutation-final"]);
});

await checkAsync("a bounded page invocation leaves a valid staged prefix for the next invocation", async () => {
  const staged = [];
  let requested = 0, promoted = 0;
  await assert.rejects(() => stagePlaidSyncWindow({
    originalCursor: "budget-original", maxPagesPerInvocation: 2,
    requestPage: async () => {
      requested += 1;
      assert.ok(requested <= 2, "the page budget must stop before a third request");
      return syncPage({ added: [], next_cursor: `budget-${requested}`, has_more: true });
    },
    resetWindow: async () => {}, stagePage: async (page) => staged.push(page),
    promoteWindow: async () => { promoted += 1; },
  }), (error) => error instanceof PlaidProtocolError && error.code === "SYNC_PAGE_BUDGET_EXCEEDED");
  assert.equal(staged.length, 2);
  assert.equal(promoted, 0);
  const receipt = await stagePlaidSyncWindow({
    originalCursor: "budget-original", resumeCursor: staged[1].nextCursor, resumePageIndex: 2,
    resumeCursorDigests: staged[1].cursorDigests,
    maxPagesPerInvocation: 2,
    requestPage: async ({ cursor }) => { assert.equal(cursor, "budget-2"); return syncPage({ added: [], next_cursor: "budget-final" }); },
    resetWindow: async () => assert.fail("resume must preserve its prefix"),
    stagePage: async () => {}, promoteWindow: async (r) => r,
  });
  assert.equal(receipt.finalCursor, "budget-final");
  assert.equal(receipt.pageCount, 3);
});

await checkAsync("durable cursor history refuses omissions, duplicates, wrong endpoints, and malformed hashes", async () => {
  const valid = await cursorHistory("history-original", "history-middle", "history-resume");
  for (const invalid of [null, {}, valid.slice(1), [...valid, valid[2]], [valid[0], valid[0], valid[2]],
    [valid[2], valid[1], valid[0]], [valid[0], "x".repeat(64), valid[2]], [valid[0], , valid[2]]]) {
    await assert.rejects(() => validatePlaidSyncCursorHistory({ originalCursor: "history-original",
      resumeCursor: "history-resume", pageIndex: 2, cursorDigests: invalid }),
    (error) => error instanceof PlaidProtocolError && error.code === "INVALID_SYNC_CURSOR_HISTORY");
  }
  assert.equal(await validatePlaidSyncCursorHistory({ originalCursor: "history-original", resumeCursor: "history-resume", pageIndex: 2, cursorDigests: [] }), null);
});

await checkAsync("the accumulated window bound refuses another page without resetting or promoting progress", async () => {
  const originalCursor = "limit-original", resumeCursor = "limit-resume";
  const endpoints = await cursorHistory(originalCursor, resumeCursor);
  const history = [endpoints[0], ...Array.from({ length: PLAID_SYNC_MAX_WINDOW_PAGES - 1 }, (_, index) => (index + 1).toString(16).padStart(64, "0")), endpoints[1]];
  await assert.rejects(() => stagePlaidSyncWindow({
    originalCursor, resumeCursor, resumePageIndex: PLAID_SYNC_MAX_WINDOW_PAGES, resumeCursorDigests: history,
    requestPage: async () => assert.fail("no further page may be requested"),
    resetWindow: async () => assert.fail("the durable prefix must stay intact"),
    stagePage: async () => assert.fail("the durable prefix must stay intact"),
    promoteWindow: async () => assert.fail("the incomplete window cannot be promoted"),
  }), (error) => error instanceof PlaidProtocolError && error.code === "SYNC_WINDOW_PAGE_LIMIT");
});

await checkAsync("actual SQLite resumes an interrupted cursor cycle without staging or committing the repeated page", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox", BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret", BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  } });
  const stamp = "2026-08-30T00:00:00.000Z", itemRef = "cursor-cycle-item";
  const account = { account_id: "protocol-account", name: "Synthetic account", type: "depository", subtype: "checking", balances: { current: 0, available: null, iso_currency_code: "USD", unofficial_currency_code: null } };
  try {
    seedOwnedEntity(fixture, "cursor-entity", "Synthetic entity");
    const sealed = await encryptAccessReference(fixture.env, "synthetic-access-reference");
    fixture.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at,cursor) VALUES ('primary',?,?,?,?,'sandbox','connected',?,'cycle-origin')`, itemRef, sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp);
    await discoverPlaidAccountAssignments(fixture.env, { itemRef, accounts: [{ providerAccountId: account.account_id }], at: stamp });
    fixture.raw("UPDATE plaid_account_entity_assignments SET entity_slug='cursor-entity',assigned_at=? WHERE item_ref=?", stamp, itemRef);
    let pages = 0;
    const interrupted = await syncPlaidItem(fixture.env, itemRef, { now: stamp, fetchImpl: async (url) => {
      if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [account] });
      pages += 1;
      if (pages === 3) fixture.raw("DELETE FROM plaid_sync_leases WHERE item_ref=?", itemRef);
      return Response.json(syncPage({ next_cursor: pages === 1 ? "cycle-A" : "cycle-B", has_more: true,
        added: [syncTransaction({ transaction_id: `cycle-transaction-${pages}` })] }));
    } });
    assert.equal(interrupted.code, "PLAID_SYNC_LEASE_LOST");
    const prefix = fixture.first("SELECT resume_cursor,next_page_index,cursor_history_json FROM plaid_sync_windows WHERE item_ref=?", itemRef);
    assert.equal(prefix.resume_cursor, "cycle-B");
    assert.equal(prefix.next_page_index, 2);
    assert.deepEqual(JSON.parse(prefix.cursor_history_json), await cursorHistory("cycle-origin", "cycle-A", "cycle-B"));
    const before = fixture.rows("SELECT * FROM plaid_sync_stage_transactions ORDER BY provider_transaction_id");
    let resumedPages = 0;
    const refused = await syncPlaidItem(fixture.env, itemRef, { now: stamp, fetchImpl: async (url, options) => {
      if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [account] });
      resumedPages += 1;
      assert.equal(JSON.parse(options.body).cursor, "cycle-B");
      return Response.json(syncPage({ next_cursor: "cycle-A", has_more: false }));
    } });
    assert.equal(refused.code, "INVALID_SYNC_PAGE");
    assert.equal(resumedPages, 1);
    assert.deepEqual(fixture.first("SELECT resume_cursor,next_page_index,cursor_history_json FROM plaid_sync_windows WHERE item_ref=?", itemRef), prefix);
    assert.deepEqual(fixture.rows("SELECT * FROM plaid_sync_stage_transactions ORDER BY provider_transaction_id"), before);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", itemRef).cursor, "cycle-origin");
    assert.equal(fixture.first("SELECT COUNT(*) n FROM fin_transactions").n, 0);
    assert.doesNotMatch(JSON.stringify(refused), /cycle-origin|cycle-A|cycle-B/);
  } finally { fixture.close(); }
});

await checkAsync("an old ready window without cursor history restarts from the committed cursor and preserves owner assignments", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox", BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret", BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  } });
  const stamp = "2026-08-30T00:00:00.000Z", itemRef = "legacy-cursor-item";
  const account = { account_id: "protocol-account", name: "Synthetic account", type: "depository", subtype: "checking", balances: { current: 0, available: null, iso_currency_code: "USD", unofficial_currency_code: null } };
  try {
    seedOwnedEntity(fixture, "legacy-cursor-entity", "Synthetic entity");
    const sealed = await encryptAccessReference(fixture.env, "synthetic-access-reference");
    fixture.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at,cursor) VALUES ('primary',?,?,?,?,'sandbox','connected',?,'legacy-committed')`, itemRef, sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp);
    const first = await syncPlaidItem(fixture.env, itemRef, { now: stamp, fetchImpl: async (url) => Response.json(
      new URL(url).pathname === "/accounts/get" ? { accounts: [account] }
        : syncPage({ next_cursor: "legacy-unproven-final", added: [syncTransaction({ transaction_id: "legacy-unproven-row" })] })) });
    assert.equal(first.assignment_required, true);
    const old = fixture.first("SELECT window_ref,state,next_page_index FROM plaid_sync_windows WHERE item_ref=?", itemRef);
    assert.equal(old.state, "ready");
    assert.equal(old.next_page_index, 1);
    fixture.raw("UPDATE plaid_sync_windows SET cursor_history_json='[]' WHERE item_ref=?", itemRef);
    fixture.raw("UPDATE plaid_account_entity_assignments SET entity_slug='legacy-cursor-entity',assigned_at=? WHERE item_ref=?", stamp, itemRef);
    let requested = 0;
    const recovered = await syncPlaidItem(fixture.env, itemRef, { now: stamp, fetchImpl: async (url, options) => {
      if (new URL(url).pathname === "/accounts/get") return Response.json({ accounts: [account] });
      requested += 1;
      assert.equal(JSON.parse(options.body).cursor, "legacy-committed");
      assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", itemRef).cursor, "legacy-committed");
      assert.equal(fixture.first("SELECT COUNT(*) n FROM fin_transactions").n, 0);
      return Response.json(syncPage({ next_cursor: "legacy-reviewed-final", added: [syncTransaction({ transaction_id: "legacy-reviewed-row" })] }));
    } });
    assert.equal(requested, 1);
    assert.equal(recovered.ok, true);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", itemRef).cursor, "legacy-reviewed-final");
    assert.deepEqual(fixture.rows("SELECT external_id FROM fin_transactions").map(row => row.external_id), ["legacy-reviewed-row"]);
    assert.equal(fixture.first("SELECT COUNT(*) n FROM plaid_sync_stage_transactions WHERE window_ref=?", old.window_ref).n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) n FROM plaid_sync_stage_accounts WHERE window_ref=?", old.window_ref).n, 0);
    assert.equal(fixture.first("SELECT entity_slug FROM plaid_account_entity_assignments WHERE item_ref=?", itemRef).entity_slug, "legacy-cursor-entity");
  } finally { fixture.close(); }
});

await checkAsync("actual D1 sync consumer leaves the cursor and visible ledger untouched on malformed pages", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox", BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret", BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  } });
  const stamp = "2026-08-30T00:00:00.000Z";
  const account = { account_id: "protocol-account", name: "Synthetic account", type: "depository", subtype: "checking", balances: { current: 0, available: null, iso_currency_code: "USD", unofficial_currency_code: null } };
  try {
    seedOwnedEntity(fixture, "protocol-entity", "Synthetic entity");
    const sealed = await encryptAccessReference(fixture.env, "synthetic-access-reference");
    for (const [index, page] of [syncPage({ has_more: undefined }), syncPage({ removed: null }), syncPage({ added: [syncTransaction({ pending: "false" })] })].entries()) {
      const itemRef = `protocol-item-${index}`;
      fixture.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at,cursor) VALUES ('primary',?,?,?,?,'sandbox','connected',?,'protocol-committed')`, itemRef, sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp);
      await discoverPlaidAccountAssignments(fixture.env, { itemRef, accounts: [{ providerAccountId: account.account_id }], at: stamp });
      fixture.raw("UPDATE plaid_account_entity_assignments SET entity_slug='protocol-entity',assigned_at=? WHERE item_ref=?", stamp, itemRef);
      const receipt = await syncPlaidItem(fixture.env, itemRef, { now: stamp, fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        assert.ok(["/accounts/get", "/transactions/sync"].includes(path));
        return Response.json(path === "/accounts/get" ? { accounts: [account] } : page);
      } });
      assert.equal(receipt.ok, false);
      assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", itemRef).cursor, "protocol-committed");
      const window = fixture.first("SELECT state,resume_cursor,next_page_index,last_error_code FROM plaid_sync_windows WHERE item_ref=?", itemRef);
      assert.equal(window.state, "retryable");
      assert.equal(window.resume_cursor, "protocol-committed");
      assert.equal(window.next_page_index, 0);
      assert.equal(window.last_error_code, "INVALID_SYNC_PAGE", receipt.reason);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions").n, 0);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    }
    const itemRef = "protocol-empty-initial";
    fixture.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at) VALUES ('primary',?,?,?,?,'sandbox','connected',?)`, itemRef, sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp);
    await discoverPlaidAccountAssignments(fixture.env, { itemRef, accounts: [{ providerAccountId: account.account_id }], at: stamp });
    fixture.raw("UPDATE plaid_account_entity_assignments SET entity_slug='protocol-entity',assigned_at=? WHERE item_ref=?", stamp, itemRef);
    const emptyReceipt = await syncPlaidItem(fixture.env, itemRef, { now: stamp, fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      assert.ok(["/accounts/get", "/transactions/sync"].includes(path));
      return Response.json(path === "/accounts/get" ? { accounts: [account] }
        : syncPage({ added: [], next_cursor: "", transactions_update_status: PLAID_HISTORY_STATE.NOT_READY }));
    } });
    assert.equal(emptyReceipt.ok, false);
    assert.equal(emptyReceipt.partial, true);
    assert.equal(emptyReceipt.status, "partial");
    assert.equal(emptyReceipt.history_state, "running");
    assert.equal(emptyReceipt.provider_history_state, PLAID_HISTORY_STATE.NOT_READY);
    assert.equal(emptyReceipt.finalCursor, "");
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", itemRef).cursor, "");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_windows WHERE item_ref=?", itemRef).n, 0);
  } finally { fixture.close(); }
});

await checkAsync("webhook verification refuses malformed JWTs", async () => {
  await assert.rejects(
    () => verifyPlaidWebhook({ rawBody: "{}", verificationJwt: "not-a-jwt", getJwk: async () => ({}) }),
    (error) => error instanceof PlaidProtocolError && error.code === "INVALID_WEBHOOK_JWT",
  );
});

try {
  const receipt = await runPlaidSandboxRehearsal();
  check("credential-free Plaid rehearsal covers the complete protocol", () => {
    assert.equal(receipt.fieldProof, false);
    assert.equal(receipt.checkCount, 21);
    assert.equal(receipt.providerCalls.exchange, 1);
    assert.equal(receipt.providerCalls.remove, 2);
  });
} catch (error) {
  process.stderr.write(`FAIL  credential-free Plaid rehearsal covers the complete protocol\n${error.stack}\n`);
  process.exitCode = 1;
}

await checkAsync("live Sandbox runner is bounded, sanitized, and removes its disposable Item", async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const payloads = {
      "/sandbox/public_token/create": { public_token: "public-live-fixture" },
      "/item/public_token/exchange": { item_id: "item-live-fixture", access_token: "access-live-fixture" },
      "/transactions/sync": {
        added: [], modified: [], removed: [], next_cursor: "cursor-live-1", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      },
      "/sandbox/transactions/refresh": { request_id: "refresh" },
      "/sandbox/item/reset_login": { reset_login: true },
      "/link/token/create": { link_token: "link-live-fixture" },
      "/sandbox/item/fire_webhook": { request_id: "webhook" },
      "/item/remove": { request_id: "remove" },
    };
    return new Response(JSON.stringify(payloads[path]), {
      status: payloads[path] ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  };
  const receipt = await runPlaidLiveSandbox({
    clientId: "fixture-client",
    secret: "fixture-secret",
    redirectUri: "https://fixture.example/app/connect/bank",
    webhookUri: "https://fixture.example/api/webhooks/plaid",
    fetchImpl,
  });
  assert.equal(receipt.providerApiProof, true);
  assert.equal(receipt.liveSandboxProof, false);
  assert.equal(receipt.routeD1Proof, false);
  assert.equal(receipt.updateHealthProven, false);
  assert.equal(receipt.history_state, "complete");
  assert.equal(receipt.provider_history_state, "HISTORICAL_UPDATE_COMPLETE");
  assert.equal(receipt.historical_update_complete, true);
  assert.equal(receipt.providerRemovalConfirmed, true);
  assert.equal(receipt.webhookRequested, true);
  assert.equal(receipt.webhookDeliveryProven, false);
  assert.equal(JSON.stringify(receipt).includes("live-fixture"), false);
  assert.equal(paths.at(-1), "/item/remove");
});

if (!process.exitCode) process.stdout.write(`\nplaid-protocol: ${checks.length}/${checks.length} checks passed\n`);
