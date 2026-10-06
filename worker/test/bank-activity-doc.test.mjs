import test from "node:test";
import assert from "node:assert/strict";

import { renderBankActivityDocument } from "../src/lib/bank-activity-doc.js";

const ACCOUNT_REF = `acct_${"a".repeat(32)}`;

function transaction(overrides = {}) {
  return {
    id: 1,
    posted_on: "2026-09-18",
    amount_minor: 1250,
    direction: "outflow",
    currency: "USD",
    description: "Fixture activity",
    payee: "Fixture Bakery Supply",
    pending: 0,
    removed_at: null,
    basis_state: "confirmed",
    source_locator: "plaid/transactions/private-provider-transaction",
    superseded_by_id: null,
    external_id: "private-provider-transaction",
    ...overrides,
  };
}

const account = {
  public_ref: ACCOUNT_REF,
  entity_slug: "mesa-coffee",
  entity_label: "Primary fixture entity",
  label: "Everyday checking",
  mask: "0042",
  currency: "USD",
  institution: "Synthetic Fixture Bank",
  account_slug: "plaid-private-item-private-account",
  item_ref: "private-item",
  provider_account_id: "private-account",
};

test("the bank activity renderer filters honestly, keeps currencies separate, and is deterministic", () => {
  const rows = [];
  for (let index = 0; index < 28; index += 1) {
    rows.push(transaction({
      id: index + 1,
      posted_on: `2026-09-${String(28 - index).padStart(2, "0")}`,
      amount_minor: 100 + index,
      direction: index % 4 === 0 ? "inflow" : "outflow",
      payee: `Fixture Payee ${String(index % 6).padStart(2, "0")}`,
      source_locator: index === 3 ? "plaid/transactions/opaque#minor_rounded" : "plaid/transactions/opaque",
    }));
  }
  rows.push(transaction({ id: 101, currency: "EUR", amount_minor: 500, direction: "inflow", payee: "Sample Utility Co" }));
  rows.push(transaction({ id: 102, currency: "EUR", amount_minor: 275, direction: "outflow", payee: "Fixture Bakery Supply" }));
  rows.push(transaction({ id: 201, pending: 1, amount_minor: 999999 }));
  rows.push(transaction({ id: 202, removed_at: "2026-09-19T00:00:00.000Z", amount_minor: 888888 }));
  rows.push(transaction({ id: 203, superseded_by_id: 9001, amount_minor: 777777 }));
  rows.push(transaction({ id: 204, basis_state: "unparsed", amount_minor: null, direction: null }));
  rows.push(transaction({ id: 205, posted_on: "2026-10-01", amount_minor: 666666 }));

  const first = renderBankActivityDocument({
    account,
    month: "2026-09",
    transactions: rows,
    now: "2026-10-01T00:00:00.000Z",
  });
  const second = renderBankActivityDocument({
    account,
    month: "2026-09",
    transactions: rows,
    now: "2026-10-03T00:00:00.000Z",
  });

  assert.deepEqual(first, second, "a clock moved by two days must not alter ledger-derived output");
  assert.deepEqual(first.stats, {
    settled: 30,
    pending: 1,
    removed: 1,
    superseded: 1,
    unreadable: 1,
    rounded: 1,
    currencies: ["EUR", "USD"],
    latest_date: "2026-09-28",
  });
  assert.equal(first.envelope.title,
    "Bank activity, September 2026: Everyday checking ending 0042 (Synthetic Fixture Bank)");
  assert.equal(first.envelope.source_type, "bank_activity");
  assert.equal(first.envelope.source_id, `${ACCOUNT_REF}:2026-09`);
  assert.equal(first.envelope.occurred_at, "2026-09-28");
  assert.equal(first.envelope.date_source, "bank_feed:latest_posted_on");
  assert.equal(first.envelope.date_reliable, true);
  assert.equal(first.envelope.text_source, "native");
  assert.equal(first.envelope.text_reliable, true);
  assert.equal(first.envelope.metadata.entity_slug, "mesa-coffee");
  assert.deepEqual(first.envelope.metadata.evidence_lineage, {
    version: 1,
    kind: "derived_record",
    root_ids: [`financial-ledger:${ACCOUNT_REF}:2026-09`],
  });

  const content = first.envelope.content;
  assert.match(content, /1 pending line was left out/);
  assert.match(content, /1 line could not be read/);
  assert.match(content, /1 included amount was rounded from finer bank precision/);
  assert.match(content, /1 removed line was left out/);
  assert.match(content, /1 superseded line was left out/);
  assert.match(content, /Transfers between the owner's own accounts and card payments are included and are not netted out/);
  assert.match(content, /## EUR[\s\S]*Money in: EUR 5\.00[\s\S]*Money out: EUR 2\.75[\s\S]*Net: EUR 2\.25/);
  assert.match(content, /## USD/);
  assert.match(content, /3 more not listed\./);
  assert.doesNotMatch(content, /999,999|888,888|777,777|666,666/);
  assert.doesNotMatch(content, /\b(?:income|spend|profit|revenue)\b/i);

  const serialized = JSON.stringify(first.envelope);
  for (const privateValue of [
    account.account_slug,
    account.item_ref,
    account.provider_account_id,
    "private-provider-transaction",
  ]) assert.equal(serialized.includes(privateValue), false, `private identity leaked: ${privateValue}`);
});

test("a month whose settled rows disappeared becomes an explicit zero document", () => {
  const result = renderBankActivityDocument({
    account,
    month: "2026-02",
    transactions: [
      transaction({ posted_on: "2026-02-14", removed_at: "2026-03-01T00:00:00.000Z" }),
      transaction({ posted_on: "2026-02-15", pending: 1 }),
    ],
  });
  assert.equal(result.stats.settled, 0);
  assert.equal(result.envelope.occurred_at, "2026-02-28");
  assert.equal(result.envelope.date_source, "bank_feed:month_end_no_settled_rows");
  assert.match(result.envelope.content, /This month includes 0 settled transactions/);
  assert.match(result.envelope.content, /Settled transaction count: 0/);
});

test("an ordinary settled row remains a green rendering control", () => {
  const result = renderBankActivityDocument({
    account,
    month: "2026-09",
    transactions: [transaction({ amount_minor: 4321, direction: "inflow" })],
  });
  assert.equal(result.stats.settled, 1);
  assert.equal(result.stats.pending, 0);
  assert.equal(result.stats.removed, 0);
  assert.match(result.envelope.content, /Money in: USD 43\.21/);
});
