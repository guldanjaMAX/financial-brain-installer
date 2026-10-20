/**
 * Money invariants for the store rows, read from covered synthetic bank rows
 * through the Worker's own ledger integration point.
 *
 * The contract these rows hold the Worker to: only an exact name match (a
 * registered name or alias, or a bounded payee, merchant or labelled-sender
 * field) can give a complete total, a confirmed deposit, an absence or a zero.
 * Anything looser must come back as a labelled possible match.
 *
 * Controls pin the sealed 0.4.17 behaviour that already meets the contract.
 * Known gaps are the places it does not, as todo rows with the reason;
 * STORE_SHAPES_STRICT=1 runs them as ordinary tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ROLE,
  createStoreFixture,
  knownGap,
  ledgerAsker,
  seedEntity,
  seedLedgerAccount,
  seedTxn,
} from "./store-shape-fixture.mjs";

globalThis.fetch = async () => { throw new Error("network forbidden in the money rows"); };

async function withBooks(body) {
  const f = await createStoreFixture();
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedLedgerAccount(f, "north-operating", "0310", { from: "2034-03-01", to: "2034-07-31" });
    const asker = ledgerAsker(f);
    await body(f, asker);
    assert.deepEqual(f.model.calls, [], "money rows never reach a model");
  } finally {
    f.close();
  }
}

const reachedLedger = (f, asked, body, kind) => {
  assert.equal(asked.fallbacks, 0, "answered from the ledger, not documents");
  assert.equal(body.ledger?.kind, kind);
};

// Exact names.

test("money control: an exact payee gives a complete spend total", () => withBooks(async (f, { ask, asked }) => {
  seedTxn(f, "north-operating", { day: "2034-05-03", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
  seedTxn(f, "north-operating", { day: "2034-05-17", cents: 38800, description: "ACH Supplier One", payee: "Supplier One" });
  seedTxn(f, "north-operating", { day: "2034-05-20", cents: 9900, description: "ACH Supplier Two", payee: "Supplier Two" });
  const body = await ask("How much did I spend at Supplier One in May 2034?");
  reachedLedger(f, asked, body, "merchant");
  assert.equal(body.ledger.total_minor, 41250 + 38800);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.citations.length, 2);
}));

test("money control: an exact payee gives a confirmed deposit", () => withBooks(async (f, { ask, asked }) => {
  seedTxn(f, "north-operating", { day: "2034-05-09", cents: 260000, direction: "inflow", description: "WIRE FROM Payer One", payee: "Payer One" });
  const body = await ask("Did the payment from Payer One arrive in May 2034?");
  reachedLedger(f, asked, body, "payment");
  assert.equal(body.ledger.found, true);
  assert.equal(body.citations[0].amount_minor, 260000);
}));

test("money control: an exact-amount payment from the exact payee is confirmed once", () => withBooks(async (f, { ask, asked }) => {
  seedTxn(f, "north-operating", { day: "2034-05-09", cents: 260000, direction: "inflow", description: "WIRE FROM Payer One", payee: "Payer One" });
  seedTxn(f, "north-operating", { day: "2034-05-23", cents: 125000, direction: "inflow", description: "WIRE FROM Payer One", payee: "Payer One" });
  const body = await ask("Did the payment of $1,250.00 from Payer One arrive in May 2034?");
  reachedLedger(f, asked, body, "payment");
  assert.equal(body.ledger.found, true);
  assert.deepEqual(body.citations.map((c) => c.amount_minor), [125000]);
}));

// Looser than an exact name: labelled, never complete.

test("money control: a payer named only in a memo is a possible match, never a confirmed deposit", () => withBooks(async (f, { ask, asked }) => {
  seedTxn(f, "north-operating", { day: "2034-05-09", cents: 260000, direction: "inflow", description: "Transfer from Payer Two for Payer One invoice", payee: "Payer Two" });
  const body = await ask("Did the payment from Payer One arrive in May 2034?");
  reachedLedger(f, asked, body, "payment");
  assert.equal(body.ledger.found, null);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /can't confirm/);
}));

test("money control: income from a named payer is a labelled subtotal, never a complete total", () => withBooks(async (f, { ask, asked }) => {
  seedTxn(f, "north-operating", { day: "2034-05-09", cents: 260000, direction: "inflow", description: "WIRE FROM Payer One", payee: "Payer One" });
  seedTxn(f, "north-operating", { day: "2034-05-11", cents: 31000, direction: "inflow", description: "Card settlement batch" });
  const body = await ask("How much income came from Payer One in May 2034?");
  reachedLedger(f, asked, body, "merchant");
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.attributed_subtotal_minor, 260000);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /matched subtotal, not complete/);
}));

// Absence and zero.

test("money control: absence is stated only for a covered window with no deposits at all", () => withBooks(async (f, { ask, asked }) => {
  seedTxn(f, "north-operating", { day: "2034-05-20", cents: 9900, description: "ACH Supplier Two", payee: "Supplier Two" });
  const body = await ask("Did the payment from Payer One arrive in May 2034?");
  reachedLedger(f, asked, body, "payment");
  assert.equal(body.ledger.found, false);
  assert.match(body.answer, /No deposits at all in this period/);
}));

test("money control: a period outside the covered window gives no figure and no zero", () => withBooks(async (f, { ask, asked }) => {
  seedTxn(f, "north-operating", { day: "2034-05-03", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
  const body = await ask("How much did I spend at Supplier One in September 2034?");
  assert.equal(asked.fallbacks, 1);
  assert.equal(body.ledger, undefined);
  assert.equal(asked.gaps[0].reason, "period_outside_coverage");
}));

test("money control: a printed unknown-merchant label refuses rather than reading as zero", () => withBooks(async (f, { ask }) => {
  seedTxn(f, "north-operating", { day: "2034-05-09", cents: 260000, direction: "inflow", description: "Invoice for Store North" });
  const body = await ask("How much income came from unknown merchant in May 2034?");
  assert.equal(body.ledger, undefined);
  assert.equal(body.gaps[0].reason, "merchant_selector_unsupported");
  assert.equal(body.evidence_gate.supported, false);
}));

test("money control: an and-versus-ampersand spelling refuses rather than merging merchants", () => withBooks(async (f, { ask }) => {
  seedTxn(f, "north-operating", { day: "2034-05-03", cents: 12000, description: "Tile and Grout", payee: "Tile and Grout" });
  const body = await ask("How much did I spend at Tile & Grout in May 2034?");
  assert.equal(body.ledger, undefined);
  assert.equal(body.gaps[0].reason, "merchant_selector_ambiguous");
}));

test("money control: cash flow is refused with no figure", () => withBooks(async (f, { ask }) => {
  seedTxn(f, "north-operating", { day: "2034-05-03", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
  const body = await ask("What was my cash flow in May 2034?");
  assert.equal(body.ledger, undefined);
  assert.equal(body.gaps[0].reason, "cash_flow_unsupported");
  assert.doesNotMatch(JSON.stringify(body), /412\.50/);
}));

// Known gaps against the exact-name contract.

test("money known gap: a description word match is labelled possible, not counted in a complete total", knownGap(
  "spend rows with no payee match by words inside the description, so a different merchant whose label contains the asked name is summed into a complete total",
), () => withBooks(async (f, { ask }) => {
  seedTxn(f, "north-operating", { day: "2034-05-03", cents: 5000, description: "POS Supplier One" });
  seedTxn(f, "north-operating", { day: "2034-05-04", cents: 5500, description: "POS Supplier One Annex" });
  const body = await ask("How much did I spend at Supplier One in May 2034?");
  assert.notEqual(body.evidence_gate?.complete, true, "no complete total from description words");
}));

test("money known gap: an unmatched name never certifies a zero", knownGap(
  "when no row matches the asked spelling, the spend answer is a complete zero even though the period holds spend under a differently printed label",
), () => withBooks(async (f, { ask }) => {
  seedTxn(f, "north-operating", { day: "2034-05-03", cents: 5000, description: "SUPPLIERONE ONLINE" });
  const body = await ask("How much did I spend at Supplier One in May 2034?");
  assert.ok(!(body.ledger?.total_minor === 0 && body.evidence_gate?.complete === true), "a zero needs an exact name match");
}));

test("money known gap: a longer payee that contains the asked words is a possible match, not a confirmed deposit", knownGap(
  "payment matching accepts any payee containing every asked word, so a different payer whose name extends the asked one confirms the deposit",
), () => withBooks(async (f, { ask }) => {
  seedTxn(f, "north-operating", { day: "2034-05-09", cents: 260000, direction: "inflow", description: "WIRE FROM Payer One Escrow", payee: "Payer One Escrow" });
  const body = await ask("Did the payment from Payer One arrive in May 2034?");
  assert.notEqual(body.ledger?.found, true);
}));
