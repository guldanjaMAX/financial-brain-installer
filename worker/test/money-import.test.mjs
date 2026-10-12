import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { readBankExport } from "../../ingest/bank-export.mjs";
import { importBankExport, prepareBankExportImport, balanceRoleFor } from "../src/lib/fin-import.js";
import { accountKindFor, normaliseFeedPage } from "../src/lib/bank-feed.js";
import { ledgerAccounts, ledgerObligations, ledgerUnsortedSpending } from "../src/lib/fin-d1.js";
import { handleFinApi } from "../src/lib/fin-api.js";
import { createPlaidLinkToken, completePlaidLink, syncPlaidItem } from "../src/lib/plaid-bank-feed.js";
import { assignPlaidAccountEntity, reassignPlaidAccountEntity, plaidOwnerAccountStatus } from "../src/lib/plaid-account-entities.js";

const NOW = "2026-10-07T12:00:00.000Z";
const importOptions = { entitySlug: "owner-business", now: NOW };
const csv = (lines) => readBankExport(`Date,Description,Debit,Credit\n${lines.join("\n")}\n`, {
  name: "synthetic.csv", accountHint: { accountKey: "owner-checking", accountKind: "checking" },
});
const purchase = "2026-10-06,Office supplies,12.00,";
const refund = "2026-10-05,Refund,,4.00";

async function legacyFixture() {
  const f = await createProductFixture();
  await importBankExport(f.env, csv([purchase, purchase, refund]), importOptions);
  f.raw("UPDATE fin_transactions SET txn_uid=account_slug||':line:legacy:'||id");
  return f;
}

test("M4: legacy identities block import, preview without writes, and re-key once with exact approval", async () => {
  const f = await legacyFixture();
  try {
    const { rekeyBankExportTransactions } = await import("../src/lib/fin-ledger-maintenance.js");
    const options = { tenantId: "primary", accountSlug: "owner-checking" };
    const before = f.rows("SELECT * FROM fin_transactions ORDER BY id");
    const refused = await importBankExport(f.env, csv([refund, purchase, purchase]), importOptions);
    assert.equal(refused.code, "bank_export_identity_review_required");
    assert.ok(f.seen.sql.some(sql => sql.includes("SELECT id FROM fin_transactions")), "identity decision reached");
    const preview = await rekeyBankExportTransactions(f.env, options);
    assert.equal(preview.candidate_count, 3);
    assert.equal(preview.mutation_count, 0);
    assert.deepEqual(f.rows("SELECT * FROM fin_transactions ORDER BY id"), before);
    await assert.rejects(rekeyBankExportTransactions(f.env, { ...options, dryRun: false }), /approval/);
    const result = await rekeyBankExportTransactions(f.env, {
      ...options, dryRun: false, confirm: true, expectedPlanHash: preview.plan_hash,
    });
    assert.equal(result.mutation_count, 3);
    const after = f.rows("SELECT * FROM fin_transactions ORDER BY id");
    assert.deepEqual(after.map(({ txn_uid, ...rest }) => rest), before.map(({ txn_uid, ...rest }) => rest));
    const again = await rekeyBankExportTransactions(f.env, {
      ...options, dryRun: false, confirm: true, expectedPlanHash: preview.plan_hash,
    });
    assert.equal(again.mutation_count, 0);
    const accepted = await importBankExport(f.env, csv([refund, purchase, purchase]), importOptions);
    assert.equal(accepted.imported, true);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions").n, 3);
  } finally { f.close(); }
});

test("M4: cross-document collisions are reported for owner review and no rows are deleted or guessed away", async () => {
  const f = await legacyFixture();
  try {
    const { rekeyBankExportTransactions } = await import("../src/lib/fin-ledger-maintenance.js");
    f.raw("UPDATE fin_transactions SET source_doc_uid='another-synthetic-export' WHERE id=(SELECT MIN(id) FROM fin_transactions)");
    const before = f.rows("SELECT * FROM fin_transactions ORDER BY id");
    const options = { tenantId: "primary", accountSlug: "owner-checking" };
    const preview = await rekeyBankExportTransactions(f.env, options);
    assert.ok(preview.review_row_ids.length >= 2, "the collision group is non-empty");
    assert.equal(preview.blocked, true);
    await assert.rejects(rekeyBankExportTransactions(f.env, {
      ...options, dryRun: false, confirm: true, expectedPlanHash: preview.plan_hash,
    }), /owner review/);
    assert.deepEqual(f.rows("SELECT * FROM fin_transactions ORDER BY id"), before);
  } finally { f.close(); }
});

test("M4: an approved re-key fails closed if ledger rows change before its atomic decision", async () => {
  const f = await legacyFixture();
  try {
    const { rekeyBankExportTransactions } = await import("../src/lib/fin-ledger-maintenance.js");
    const options = { tenantId: "primary", accountSlug: "owner-checking" };
    const preview = await rekeyBankExportTransactions(f.env, options);
    assert.equal(preview.candidate_count, 3);
    const batch = f.env.DB.batch.bind(f.env.DB);
    let decisions = 0;
    f.env.DB.batch = async (statements) => {
      decisions++;
      f.raw("UPDATE fin_transactions SET description='Changed synthetic description' WHERE id=(SELECT MIN(id) FROM fin_transactions)");
      return batch(statements);
    };
    await assert.rejects(rekeyBankExportTransactions(f.env, {
      ...options, dryRun: false, confirm: true, expectedPlanHash: preview.plan_hash,
    }));
    assert.equal(decisions, 1);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE txn_uid LIKE '%:line:legacy:%'").n, 3);
  } finally { f.close(); }
});

test("M4: referenced legacy transaction identities require review instead of breaking retained links", async () => {
  const f = await legacyFixture();
  try {
    const { rekeyBankExportTransactions } = await import("../src/lib/fin-ledger-maintenance.js");
    const options = { tenantId: "primary", accountSlug: "owner-checking" };
    const control = await rekeyBankExportTransactions(f.env, options);
    assert.equal(control.blocked, false);
    const transaction = f.first("SELECT * FROM fin_transactions ORDER BY id");
    f.raw(`INSERT INTO fin_exceptions
      (tenant_id,exception_uid,kind,issue,txn_uid,txn_account_slug,first_seen,provenance,basis_state,recorded_at)
      VALUES ('primary','synthetic-review','uncategorized','Needs review',?,'owner-checking','2026-10-07','derived','proposed',?)`,
    transaction.txn_uid, NOW);
    const preview = await rekeyBankExportTransactions(f.env, options);
    assert.equal(preview.blocked, true);
    assert.ok(preview.review_row_ids.includes(transaction.id));
    await assert.rejects(rekeyBankExportTransactions(f.env, {
      ...options, dryRun: false, confirm: true, expectedPlanHash: preview.plan_hash,
    }), /owner review/);
    assert.equal(f.first("SELECT txn_uid FROM fin_transactions WHERE id=?", transaction.id).txn_uid, transaction.txn_uid);
  } finally { f.close(); }
});

test("M4: a withdrawn legacy charge cannot reappear under a new export identity", async () => {
  const f = await legacyFixture();
  try {
    const { rekeyBankExportTransactions } = await import("../src/lib/fin-ledger-maintenance.js");
    f.raw("UPDATE fin_transactions SET removed_at=?,removal_reason='Owner reviewed withdrawal'", NOW);
    const before = f.rows("SELECT * FROM fin_transactions ORDER BY id");
    const refused = await importBankExport(f.env, csv([purchase, purchase, refund]), importOptions);
    assert.ok(f.seen.sql.some(sql => sql.includes("SELECT id FROM fin_transactions")));
    assert.equal(refused.code, "bank_export_identity_review_required");
    const preview = await rekeyBankExportTransactions(f.env, { accountSlug: "owner-checking" });
    assert.equal(preview.candidate_count, 3);
    assert.equal(preview.blocked, true);
    assert.deepEqual(f.rows("SELECT * FROM fin_transactions ORDER BY id"), before);
  } finally { f.close(); }
});

test("M6: category backfill preview counts only legacy feed suggestions and never updates rows", async () => {
  const f = await legacyFixture();
  try {
    const { previewFeedCategoryBackfill } = await import("../src/lib/fin-ledger-maintenance.js");
    f.raw("UPDATE fin_transactions SET category='OFFICE',provenance='feed',source_feed='synthetic-feed'");
    f.raw("UPDATE fin_transactions SET category_basis_state='confirmed' WHERE id=(SELECT MIN(id) FROM fin_transactions)");
    const before = f.rows("SELECT * FROM fin_transactions ORDER BY id");
    const result = await previewFeedCategoryBackfill(f.env, { tenantId: "primary" });
    assert.equal(result.candidate_count, 2);
    assert.equal(result.mutation_count, 0);
    assert.deepEqual(f.rows("SELECT * FROM fin_transactions ORDER BY id"), before);
    f.raw("UPDATE fin_transactions SET category_basis_state='proposed'");
    assert.equal((await previewFeedCategoryBackfill(f.env)).candidate_count, 0);
  } finally { f.close(); }
});

test("M6: shared feed writer marks inserts and updates as proposed", async () => {
  const f = await createProductFixture();
  try {
    const envelope = normaliseFeedPage({ itemRef: "synthetic-item", now: NOW,
      accounts: [{ account_id: "synthetic-account", type: "depository", subtype: "checking", balances: { iso_currency_code: "USD" } }],
      added: [{ transaction_id: "synthetic-charge", account_id: "synthetic-account", date: "2026-10-06", amount: "12.00", name: "Supplies" }],
    });
    const options = { ...importOptions, origin: { provenance: "feed", sourceFeed: "synthetic-feed" } };
    await importBankExport(f.env, envelope, options);
    assert.equal(f.first("SELECT category_basis_state FROM fin_transactions").category_basis_state, "proposed");
    f.raw("UPDATE fin_transactions SET category_basis_state=NULL");
    await importBankExport(f.env, envelope, options);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions").n, 1);
    assert.equal(f.first("SELECT category_basis_state FROM fin_transactions").category_basis_state, "proposed");
  } finally { f.close(); }
});

test("M5: the account reader caps legacy complete coverage that has no start date", async () => {
  const { f } = await feedFixture();
  try {
    f.raw("UPDATE fin_account_coverage SET coverage_status='complete',covered_from=NULL");
    let result = await ledgerAccounts(f.env);
    assert.equal(result.accounts.length, 1);
    assert.notEqual(result.accounts[0].coverage_status, "complete");
    let status = await plaidOwnerAccountStatus(f.env, { now: NOW });
    assert.equal(status.accounts.length, 1);
    assert.notEqual(status.accounts[0].coverage.state, "complete");
    const { financialPictureInventory, assertFinancialPicturePublicReceipt } = await import("../src/lib/financial-picture.js");
    const inventory = await financialPictureInventory(f.env, { sections: ["accounts"] }, { capturedAt: NOW });
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.sections.accounts.records.length, 1);
    assert.notEqual(inventory.body.sections.accounts.records[0].coverage.status, "complete");
    const overclaim = structuredClone(inventory.body);
    overclaim.sections.accounts.records[0].coverage.status = "complete";
    assert.throws(() => assertFinancialPicturePublicReceipt(overclaim), /complete coverage requires a start date/);
    f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-01'");
    result = await ledgerAccounts(f.env);
    assert.equal(result.accounts[0].coverage_status, "complete");
    status = await plaidOwnerAccountStatus(f.env, { now: NOW });
    assert.equal(status.accounts[0].coverage.state, "complete");
  } finally { f.close(); }
});

test("M4: row shifts and description whitespace do not duplicate CSV charges; identical-charge ordinals survive", async () => {
  const f = await createProductFixture();
  try {
    const original = csv([purchase, refund]);
    assert.equal(original.ok, true);
    assert.ok(prepareBankExportImport(original, importOptions).statements.length > 0);
    await importBankExport(f.env, original, importOptions);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions").n, 2);
    const shifted = csv([refund, "2026-10-06,  OFFICE   supplies  ,12.00,"]);
    const writesBefore = f.seen.sql.length;
    await importBankExport(f.env, shifted, importOptions);
    assert.ok(f.seen.sql.slice(writesBefore).some(sql => sql.includes("INSERT INTO fin_transactions")));
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions").n, 2, "shifted export adds zero rows");
    assert.match(f.first("SELECT source_locator FROM fin_transactions WHERE direction='outflow'").source_locator, /row 3$/);
    await importBankExport(f.env, csv([refund, purchase, purchase]), importOptions);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE direction='outflow'").n, 2);
    await importBankExport(f.env, csv([purchase, refund, purchase]), importOptions);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions").n, 3);
  } finally { f.close(); }
});

// The fake is injected at the actual Plaid protocol boundary. An accidental
// ambient fetch fails instead of ever contacting a provider.
const ambientFetch = globalThis.fetch;
let ambientCalls = 0;
test.before(() => { globalThis.fetch = async () => { ambientCalls++; throw new Error("ambient fetch forbidden"); }; });
test.after(() => { globalThis.fetch = ambientFetch; assert.equal(ambientCalls, 0); });

async function feedFixture({ type = "loan", subtype = "unknown" } = {}) {
  const f = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client", BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  } });
  seedOwnedEntity(f, "owner-business", "Owner business");
  const state = { calls: [], now: NOW, current: "250.00", type, subtype, page: {
    added: [], modified: [], removed: [], next_cursor: "cursor-1", has_more: false,
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
  } };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    state.calls.push(path);
    const responses = {
      "/link/token/create": { link_token: "fixture-link", expiration: "2099-10-07T13:00:00.000Z" },
      "/item/public_token/exchange": { item_id: "fixture-item", access_token: "fixture-access" },
      "/item/get": { item: { item_id: "fixture-item", error: null } },
      "/accounts/get": { accounts: [{ account_id: "fixture-account", name: "Owner account", type: state.type,
        subtype: state.subtype, balances: { current: state.current, iso_currency_code: "USD" } }] },
      "/transactions/sync": state.page,
    };
    assert.ok(Object.hasOwn(responses, path), "only the declared synthetic protocol is used");
    return new Response(JSON.stringify(responses[path]), { headers: { "Content-Type": "application/json" } });
  };
  const link = await createPlaidLinkToken(f.env, {
    url: "https://brain.invalid/app/connect/bank", sessionRef: "money-import-fixture-0001", fetchImpl, now: NOW,
  });
  await completePlaidLink(f.env, { sessionRef: link.session_ref, publicToken: "fixture-public", fetchImpl, now: NOW });
  const run = () => syncPlaidItem(f.env, "fixture-item", { fetchImpl, now: state.now });
  await run();
  const assignment = f.first("SELECT account_ref FROM plaid_account_entity_assignments");
  assert.ok(assignment, "sync reached account assignment");
  await assignPlaidAccountEntity(f.env, {
    request_id: "money-import-assignment-0001", account_ref: assignment.account_ref, entity_slug: "owner-business",
  }, { now: NOW });
  await run();
  return { f, state, run };
}

const transaction = (overrides = {}) => ({
  transaction_id: "fixture-charge", account_id: "fixture-account", amount: "12.00",
  iso_currency_code: "USD", date: "2026-10-06", pending: false, name: "Office supplies",
  personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OFFICE_SUPPLIES" },
  ...overrides,
});

test("M6: Plaid inserts and modifications propose categories; unsorted counts them until confirmed", async () => {
  const { f, state, run } = await feedFixture({ type: "depository", subtype: "checking" });
  try {
    state.page = { ...state.page, added: [transaction()] };
    await run();
    assert.ok(state.calls.filter(path => path === "/transactions/sync").length >= 2);
    let row = f.first("SELECT * FROM fin_transactions WHERE external_id='fixture-charge'");
    assert.ok(row, "promotion inserted a transaction");
    assert.equal(row.category_basis_state, "proposed");
    let unsorted = await ledgerUnsortedSpending(f.env);
    assert.equal(unsorted.by_account[0].outflow_minor, 1200);
    state.page = { ...state.page, added: [], modified: [transaction({ personal_finance_category: {
      primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANTS",
    } })] };
    await run();
    row = f.first("SELECT * FROM fin_transactions WHERE external_id='fixture-charge'");
    assert.equal(row.category, "FOOD_AND_DRINK_RESTAURANTS");
    assert.equal(row.category_basis_state, "proposed");
    f.raw("UPDATE fin_transactions SET category_basis_state='confirmed'");
    unsorted = await ledgerUnsortedSpending(f.env);
    assert.equal(unsorted.by_account.length, 0, "a confirmed category is a green control");
  } finally { f.close(); }
});

test("M5: known loan and credit types already map to liabilities, even with an unknown subtype", () => {
  for (const [type, kind] of [["loan", "loan"], ["credit", "card"]]) {
    assert.equal(accountKindFor(type, "unknown"), kind);
    assert.equal(balanceRoleFor(kind), "liability");
  }
  assert.equal(accountKindFor("loan", "line of credit"), "line_of_credit");
  assert.equal(accountKindFor("unclassified", null), "other");
});

test("M5: real Plaid credit and line-of-credit promotions retain liability classification", async () => {
  for (const [type, subtype, kind] of [["credit", "unknown", "card"], ["loan", "line of credit", "line_of_credit"]]) {
    const { f } = await feedFixture({ type, subtype });
    try {
      const account = f.first("SELECT * FROM fin_accounts");
      assert.equal(account.account_kind, kind);
      assert.equal(account.balance_role, "liability");
      const obligations = await ledgerObligations(f.env);
      assert.equal(obligations.obligations.length, kind === "line_of_credit" ? 1 : 0);
      if (kind === "line_of_credit") assert.equal(obligations.obligations[0].kind, kind);
    } finally { f.close(); }
  }
});

test("M5: feed refresh preserves owner-maintained loan terms and does not duplicate the linked obligation", async () => {
  const { f, state, run } = await feedFixture();
  try {
    f.raw(`UPDATE fin_obligations SET obligation_uid='owner-loan',provenance='owner_stated',
      balance_minor=20000,payment_minor=1000,payment_cadence='monthly'`);
    state.current = "240.00";
    state.now = "2026-10-08T12:00:00.000Z";
    const before = f.rows("SELECT * FROM fin_obligations");
    const calls = state.calls.length;
    await run();
    assert.ok(state.calls.length > calls, "fresh provider data reached promotion");
    assert.equal(f.first("SELECT current_minor FROM fin_balance_snapshots ORDER BY as_of_date DESC").current_minor, 24000);
    assert.deepEqual(f.rows("SELECT * FROM fin_obligations"), before);
  } finally { f.close(); }
});

test("M5: a loan gets one refreshed obligation without inventing payment terms or guarantee findings", async () => {
  const { f, state, run } = await feedFixture();
  try {
    const account = f.first("SELECT * FROM fin_accounts");
    assert.equal(account.account_kind, "loan");
    assert.equal(account.balance_role, "liability");
    let result = await ledgerObligations(f.env);
    assert.equal(result.obligations.length, 1);
    assert.equal(result.obligations[0].balance_minor, 25000);
    assert.equal(result.obligations[0].payment_minor, null);
    assert.equal(result.obligations[0].personal_guarantee_state, "not_examined");
    state.current = "240.00";
    state.now = "2026-10-08T12:00:00.000Z";
    await run();
    result = await ledgerObligations(f.env);
    assert.equal(result.obligations.length, 1);
    assert.equal(result.obligations[0].balance_minor, 24000);
    assert.equal(result.obligations[0].balance_as_of, "2026-10-08");
  } finally { f.close(); }
});

test("M5: a reviewed loan-account move transfers its feed obligation in the same batch", async () => {
  const { f } = await feedFixture();
  try {
    seedOwnedEntity(f, "owner-household", "Owner household");
    const accountRef = f.first("SELECT account_ref FROM plaid_account_entity_assignments").account_ref;
    const request = { account_ref: accountRef, from_entity_slug: "owner-business", to_entity_slug: "owner-household" };
    const preview = await reassignPlaidAccountEntity(f.env, { ...request, mode: "preview" }, { now: NOW });
    assert.equal(preview.body.can_apply, true);
    assert.equal((await ledgerObligations(f.env, { entitySlug: "owner-business" })).obligations.length, 1);
    const applied = await reassignPlaidAccountEntity(f.env, {
      ...request, mode: "apply", request_id: "money-import-move-0001",
    }, { now: NOW });
    assert.equal(applied.body.moved, true);
    assert.equal(f.first("SELECT entity_slug FROM fin_accounts").entity_slug, "owner-household");
    assert.equal((await ledgerObligations(f.env, { entitySlug: "owner-business" })).obligations.length, 0);
    assert.equal((await ledgerObligations(f.env, { entitySlug: "owner-household" })).obligations.length, 1);
  } finally { f.close(); }
});

test("M5: empty completed history needs a dated provider request to certify coverage", async () => {
  const { f, state, run } = await feedFixture();
  try {
    await run();
    const empty = f.first("SELECT * FROM fin_account_coverage");
    assert.ok(empty, "the promotion coverage decision was reached");
    assert.equal(empty.covered_from, "2024-10-08");
    assert.equal(empty.coverage_status, "complete");
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions").n, 0);
    assert.equal(f.first("SELECT state FROM bank_feed_backfill").state, "complete");
    state.page = { ...state.page, added: [transaction()] };
    await run();
    assert.equal(f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete");
    state.page = { ...state.page, added: [] };
    await run();
    assert.equal(f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "a quiet refresh keeps proven dated coverage");
    // Intentional contract change: empty history is covered by the completed
    // requested window, not by a transaction date. Preserve the old refusal
    // when the dated provider request is unavailable.
    f.raw("DELETE FROM fin_account_coverage");
    f.raw("DELETE FROM bank_feed_backfill");
    const before = state.calls.length;
    await run();
    assert.ok(state.calls.slice(before).includes("/transactions/sync"), "missing-proof decision reached");
    const unproven = f.first("SELECT * FROM fin_account_coverage");
    assert.ok(unproven);
    assert.equal(unproven.covered_from, null);
    assert.notEqual(unproven.coverage_status, "complete");
  } finally { f.close(); }
});

test("M5: unknown feed accounts prevent an all-obligations claim even if accounts were not requested", async () => {
  const { f } = await feedFixture({ type: "unclassified", subtype: null });
  try {
    assert.equal(f.first("SELECT account_kind FROM fin_accounts").account_kind, "other");
    const snapshot = async () => {
      const url = new URL("https://brain.invalid/api/fin/snapshot");
      const response = await handleFinApi(f.env, new Request(url, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": f.env.ADMIN_KEY },
        body: JSON.stringify({ sections: ["obligations"] }),
      }), url, url.pathname);
      assert.equal(response.status, 200);
      return response.json();
    };
    let result = await snapshot();
    assert.ok(result.sections_returned.includes("obligations"));
    assert.equal(result.obligation_exposure.covers_all_obligations, false);
    f.raw("UPDATE fin_accounts SET account_kind='checking',balance_role='asset'");
    result = await snapshot();
    assert.equal(result.obligation_exposure.covers_all_obligations, true, "classified green control");
  } finally { f.close(); }
});
