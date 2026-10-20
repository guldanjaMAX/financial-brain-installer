/**
 * Tier 1 store shapes: what the sealed 0.4.17 Worker does on each generic
 * question shape that does not need a live model to mean something.
 *
 * Each row builds its own fresh Brain, so one row's documents can never
 * answer another row's question. Controls pin behaviour that works today.
 * Known gaps are todo rows with the reason; STORE_SHAPES_STRICT=1 turns them
 * into ordinary tests (they fail on the sealed code).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LEDGER_NOW,
  ROLE,
  STRICT,
  TIER_1_ROWS,
  TIER_2_ROWS,
  assertNoConfidentAnswer,
  citedIds,
  createStoreFixture,
  knownGap,
  ledgerAsker,
  monthDays,
  resultIds,
  seedDocument,
  seedEntity,
  seedLedgerAccount,
  seedTxn,
} from "./store-shape-fixture.mjs";

globalThis.fetch = async () => { throw new Error("network forbidden in the store shape rows"); };

/** A row whose scripted draft cites `titles` and whose scripted verifier approves them. */
function draftAndApprove(draft, ...titles) {
  return ({ kind, cite }) => kind === "answer"
    ? { answer: draft(cite) }
    : { verdict: { supported: true, complete: true, evidence: titles.map(cite), reason: "fixture approves" } };
}

async function withStore(script, body) {
  const f = await createStoreFixture({ script });
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedEntity(f, ROLE.south, "Store South");
    await body(f);
    assert.deepEqual(f.model.unscripted, [], "every model turn was scripted for this row");
  } finally {
    f.close();
  }
}

async function withLedger(body) {
  const f = await createStoreFixture();
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedEntity(f, ROLE.south, "Store South");
    await body(f, ledgerAsker(f));
    assert.deepEqual(f.model.calls, [], "ledger rows never reach a model");
  } finally {
    f.close();
  }
}

test("row inventory: Tier 1 rows are here and model-dependent rows are handed to Tier 2", (t) => {
  const tier2 = TIER_2_ROWS.map(([id]) => id);
  assert.deepEqual(tier2, ["R01", "R12", "R16", "R17", "R18", "R19", "R20"]);
  for (const id of TIER_1_ROWS) assert.equal(tier2.includes(id), false, `${id} is in one tier only`);
  assert.equal(TIER_1_ROWS.length + tier2.length, 20, "all twenty shapes are accounted for");
  for (const [id, reason] of TIER_2_ROWS) t.diagnostic(`Tier 2 ${id}: ${reason}`);
  t.diagnostic(`known gaps run as ${STRICT ? "hard tests (STORE_SHAPES_STRICT=1)" : "todo rows"}`);
});

for (const [id, reason] of TIER_2_ROWS) {
  test(`${id} is excluded from Tier 1`, { skip: `Tier 2: ${reason}` }, () => {});
}

// R02. Spend with one supplier over a period, plus a unit cost.

test("R02 control: exact supplier payee gives a complete spend total from covered rows", () => withLedger(async (f, { ask, asked }) => {
  seedLedgerAccount(f, "north-operating", "0310");
  for (const day of monthDays(2034, [4, 5, 6])) seedTxn(f, "north-operating", { day, cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
  seedTxn(f, "north-operating", { day: "2034-05-20", cents: 9900, description: "ACH Supplier Two", payee: "Supplier Two" });
  const body = await ask("How much did I spend at Supplier One in Q2 2034?");
  assert.equal(asked.fallbacks, 0);
  assert.equal(body.ledger.kind, "merchant");
  assert.equal(body.ledger.total_minor, 3 * 41250);
  assert.equal(body.citations.length, 3);
  assert.equal(body.evidence_gate.complete, true);
}));

test("R02 control: a unit-cost question is never answered by the bank ledger", () => withLedger(async (f, { ask, asked }) => {
  seedLedgerAccount(f, "north-operating", "0310");
  seedTxn(f, "north-operating", { day: "2034-05-12", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
  const body = await ask("What was my average unit cost from Supplier One in Q2 2034?");
  assert.equal(asked.fallbacks, 1, "handed to documents");
  assert.equal(body.ledger, undefined, "no figure is computed from cash rows");
}));

test("R02 known gap: quantity-weighted unit cost across bills and credits", knownGap(
  "bank rows carry amounts only, with no item quantities or supplier credits, so the Worker has nothing to weight a unit cost by",
), () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-operating", "0310");
  seedTxn(f, "north-operating", { day: "2034-05-12", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
  const body = await ask("What was my average unit cost from Supplier One in Q2 2034?");
  assert.equal(Number.isSafeInteger(body.ledger?.unit_cost_minor), true);
}));

// R03. A lender's prepayment terms when the governing agreement is not loaded.

const R03 = "What prepayment penalty schedule does the executed agreement with Lender One set?";

test("R03 control: a proposal alone cannot establish binding loan terms, even if the verifier approves", () => withStore({
  [R03]: draftAndApprove((cite) => `The penalty is two percent in year one and one percent in year two [${cite("Lender One loan proposal")}].`, "Lender One loan proposal"),
}, async (f) => {
  seedDocument(f, { id: "loan-proposal", title: "Lender One loan proposal", text: "Proposal from Lender One: prepayment penalty two percent in year one and one percent in year two." });
  const { status, body } = await f.think(R03);
  assert.equal(status, 200);
  assert.deepEqual(resultIds(body), ["store-files:loan-proposal"], "the proposal was retrieved and judged");
  assertNoConfidentAnswer(body, "proposal-only binding claim");
  assert.equal(body.evidence_gate.reason, "only non-final planning material was cited for a binding legal claim");
}));

test("R03 control: no lender record at all gives an empty, honest search result", () => withStore({}, async (f) => {
  seedDocument(f, { id: "lease", title: "Store North premises lease", text: "Premises lease for the Store North site." });
  const { body } = await f.think("What prepayment penalty applies to the Lender One facility?");
  assert.deepEqual(body.results, []);
  assert.equal(body.answer, null);
  assert.equal(body.gaps[0].type, "no_results");
  assert.match(body.confidence.basis.join(" "), /does not establish whole-corpus absence/);
}));

test("R03 known gap: a payment record cited for a binding term is not blocked without the model", knownGap(
  "the deterministic legal veto only recognises planning and draft wording; a bank payment record approved by a fooled verifier passes",
), () => withStore({
  [R03]: draftAndApprove((cite) => `The penalty is two percent in year one [${cite("Lender One payment confirmation")}].`, "Lender One payment confirmation"),
}, async (f) => {
  seedDocument(f, { id: "loan-payment", title: "Lender One payment confirmation", text: "Lender One scheduled payment received for the Store North facility." });
  const { body } = await f.think(R03);
  assert.deepEqual(resultIds(body), ["store-files:loan-payment"]);
  assertNoConfidentAnswer(body, "payment record as binding terms");
}));

// R04. Several policies at once: each item must stand on its own citation.

const R04 = "List the coverage limit, deductible and renewal date of every Store North insurance policy.";
const POLICY_ONE = "Store North property policy declarations";
const POLICY_TWO = "Store North liability policy declarations";

test("R04 control: a per-policy list keeps supported items and drops an item with no real quote", () => withStore({
  [R04]: ({ kind, cite }) => kind === "answer"
    ? { answer: [
      `Property policy: limit 500,000, deductible 2,500, renews 2034-09-01 [${cite(POLICY_ONE)}].`,
      `Liability policy: limit 1,000,000, deductible 1,000, renews 2034-11-15 [${cite(POLICY_TWO)}].`,
      `Vehicle policy: limit 300,000, deductible 500, renews 2034-12-01 [${cite(POLICY_TWO)}].`,
    ].join("\n") }
    : { synthesis: { items: [
      { item: 1, supported: true, evidence: [{ n: cite(POLICY_ONE), quote: "limit 500,000, deductible 2,500, renews 2034-09-01" }] },
      { item: 2, supported: true, evidence: [{ n: cite(POLICY_TWO), quote: "limit 1,000,000, deductible 1,000, renews 2034-11-15" }] },
      { item: 3, supported: true, evidence: [{ n: cite(POLICY_TWO), quote: "vehicle limit 300,000, deductible 500" }] },
    ] } },
}, async (f) => {
  seedDocument(f, { id: "policy-property", title: POLICY_ONE, text: "Property policy for Store North: limit 500,000, deductible 2,500, renews 2034-09-01." });
  seedDocument(f, { id: "policy-liability", title: POLICY_TWO, text: "Liability policy for Store North: limit 1,000,000, deductible 1,000, renews 2034-11-15." });
  const { body } = await f.think(R04);
  assert.deepEqual(resultIds(body).sort(), ["store-files:policy-liability", "store-files:policy-property"]);
  assert.match(body.answer, /Property policy/);
  assert.match(body.answer, /Liability policy/);
  assert.doesNotMatch(body.answer, /Vehicle/, "an item whose quote is absent from its citation is dropped");
  assert.equal(body.evidence_gate.complete, false, "a dropped item means the list is not complete");
  assert.ok(body.gaps.some((gap) => gap.type === "synthesis_scope"), "a bounded list never claims a full inventory");
}));

// R05. A defined term inside the loaded license agreement.

const R05 = "What does the agreement with Licensee Alpha define as net receipts?";
const LICENSE = "Licensee Alpha license agreement, executed";

test("R05 control: a defined term is answered from the cited license with its reliable date", () => withStore({
  [R05]: draftAndApprove((cite) => `Per the 2034-03-02 license, net receipts means gross receipts less customer refunds [${cite(LICENSE)}].`, LICENSE),
}, async (f) => {
  seedDocument(f, { id: "license-alpha", title: LICENSE, text: "Net receipts means gross receipts of the licensed store less customer refunds and sales tax." });
  const { body } = await f.think(R05);
  assert.equal(body.evidence_gate.supported, true);
  assert.deepEqual(citedIds(body), ["license-alpha"]);
  assert.equal(body.citations[0].date_reliable, true);
  assert.equal(body.ledger, undefined, "a contract definition is not a ledger figure");
}));

// R06. A payroll setting that only a payroll export could carry.

const R06 = "What payroll code and pay schedule does Store South use?";

test("R06 control: without a loaded payroll export, the answer is the honest no-answer shape", () => withStore({
  [R06]: { answer: "The documents do not answer the question." },
}, async (f) => {
  seedDocument(f, { id: "south-lease", title: "Store South premises lease", text: "Premises lease for Store South, signed by the operating company." });
  const { body } = await f.think(R06);
  assert.deepEqual(resultIds(body), ["store-files:south-lease"], "a nearby record was found and not used");
  assertNoConfidentAnswer(body, "payroll setting without an export");
  assert.equal(body.ledger, undefined, "payroll wording does not route to bank figures");
}));

test("R06 control: an owner-loaded payroll export answers with its citation", () => withStore({
  [R06]: draftAndApprove((cite) => `Store South payroll settings: payroll code SX4, pay schedule biweekly [${cite("Store South payroll settings export")}].`, "Store South payroll settings export"),
}, async (f) => {
  seedDocument(f, { id: "south-payroll", title: "Store South payroll settings export", text: "Store South payroll settings: payroll code SX4, pay schedule biweekly." });
  const { body } = await f.think(R06);
  assert.equal(body.evidence_gate.supported, true);
  assert.deepEqual(citedIds(body), ["south-payroll"]);
}));

// R07. Recurring charges across most of a year.

const R07 = "What are my recurring charges so far this year?";

test("R07 control: a monthly charge in every month is detected and labelled unconfirmed", () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-card", "0577", { kind: "card" });
  for (const day of monthDays(2034, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) {
    seedTxn(f, "north-card", { day, cents: 3900, description: "Workspace Tool", payee: "Workspace Tool" });
  }
  const body = await ask(R07);
  assert.equal(body.ledger.kind, "recurring");
  assert.equal(body.ledger.monthly_total_minor, 3900);
  assert.match(body.answer, /detected, not confirmed/);
}));

test("R07 known gap: a charge present in ten of twelve months is still recurring", knownGap(
  "the detector requires every interval to be monthly, so two skipped months break the series and the charge disappears",
), () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-card", "0577", { kind: "card" });
  for (const day of monthDays(2034, [1, 2, 3, 5, 6, 7, 9, 10, 11, 12])) {
    seedTxn(f, "north-card", { day, cents: 3900, description: "Workspace Tool", payee: "Workspace Tool" });
  }
  const body = await ask(R07);
  assert.equal(body.ledger?.monthly_total_minor, 3900);
}));

// R08. Lender funding against bank deposits.

test("R08 control: a deposit from the exact lender payee is confirmed", () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-operating", "0310");
  seedTxn(f, "north-operating", { day: "2034-06-18", cents: 1250000, direction: "inflow", description: "WIRE FROM Lender One", payee: "Lender One" });
  const body = await ask("Did the payment from Lender One arrive in June 2034?");
  assert.equal(body.ledger.kind, "payment");
  assert.equal(body.ledger.found, true);
  assert.equal(body.citations[0].amount_minor, 1250000);
}));

test("R08 control: a funded-versus-received question gets no invented reconciliation", () => withLedger(async (f, { ask, asked }) => {
  seedLedgerAccount(f, "north-operating", "0310");
  seedTxn(f, "north-operating", { day: "2034-06-18", cents: 1250000, direction: "inflow", description: "WIRE FROM Lender One", payee: "Lender One" });
  const body = await ask("Which funded tickets from Lender One are missing from the bank in June 2034?");
  assert.equal(asked.fallbacks, 1);
  assert.equal(body.ledger, undefined);
}));

test("R08 known gap: funded tickets joined to bank deposits with the variance", knownGap(
  "there is no record of expected funding events to join against, so missing tickets and the shortfall cannot be computed",
), () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-operating", "0310");
  seedTxn(f, "north-operating", { day: "2034-06-18", cents: 1250000, direction: "inflow", description: "WIRE FROM Lender One", payee: "Lender One" });
  const body = await ask("Which funded tickets from Lender One are missing from the bank in June 2034?");
  assert.equal(body.ledger?.kind, "reconciliation");
}));

// R09. What one entity owes another, with age.

const R09 = "What balance does Store South owe the parent company?";

test("R09 control: a dated intercompany statement is answered as of its date", () => withStore({
  [R09]: draftAndApprove((cite) => `As of 2034-05-31, Store South owed the parent company 1,250.00 [${cite("Store South intercompany statement")}].`, "Store South intercompany statement"),
}, async (f) => {
  seedDocument(f, { id: "south-interco", title: "Store South intercompany statement", day: "2034-05-31", text: "Store South owes the parent company 1,250.00 as of 2034-05-31." });
  const { body } = await f.think(R09);
  assert.equal(body.evidence_gate.supported, true);
  assert.deepEqual(citedIds(body), ["south-interco"]);
  assert.equal(body.ledger, undefined, "a balance between entities is not a bank balance");
}));

test("R09 known gap: aged balances owed between every entity and the parent", knownGap(
  "the ledger has no due-to and due-from records, so it cannot net, match or age balances between owned entities",
), () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-operating", "0310");
  seedLedgerAccount(f, "south-operating", "0422", { entity: ROLE.south });
  const body = await ask("What balance does Store South owe the parent company?");
  assert.equal(body.ledger?.kind, "intercompany");
}));

// R10. A renamed region code and the entity that runs it.

const R10 = "Which entity operates the NW2 locations?";

test("R10 control: a loaded record that bridges the old code is found and cited", () => withStore({
  [R10]: draftAndApprove((cite) => `The NW2 locations, now called Valley District, are run by Store North [${cite("Region rename notice")}].`, "Region rename notice"),
}, async (f) => {
  seedDocument(f, { id: "region-rename", title: "Region rename notice", text: "Code NW2 is now called Valley District. Valley District stores are run by Store North." });
  const { body } = await f.think(R10);
  assert.deepEqual(citedIds(body), ["region-rename"]);
  assert.equal(body.evidence_gate.supported, true);
}));

test("R10 control: with no bridging record, the old code finds nothing and nothing is guessed", () => withStore({}, async (f) => {
  seedDocument(f, { id: "district-note", title: "Valley District note", text: "Valley District stores are run by Store North." });
  const { body } = await f.think(R10);
  assert.deepEqual(body.results, []);
  assert.equal(body.answer, null);
}));

test("R10 known gap: an owner-registered alias resolves the old code to the new label", knownGap(
  "there is no store alias registry, so a renamed code reaches its records only through a loaded bridging document",
), () => withStore({}, async (f) => {
  seedDocument(f, { id: "district-note", title: "Valley District note", text: "Valley District stores are run by Store North." });
  const { body } = await f.think(R10);
  assert.deepEqual(resultIds(body), ["store-files:district-note"]);
}));

// R11. An old and new pay rate with the date the change took effect.

const R11 = "What were the old and new pay rates for associate Kappa, and when did the change take effect?";
const PAY_CHANGE = "Payroll change record Kappa";
const PAY_TEXT = "Associate Kappa pay change: old rate 18.00, new rate 19.50 per hour, effective 2034-04-01.";
const payDraft = (sentence) => draftAndApprove((cite) => `${sentence} [${cite(PAY_CHANGE)}].`, PAY_CHANGE);

test("R11 control: a reliably dated pay change record answers with both rates and its date", () => withStore({
  [R11]: payDraft("Associate Kappa pay change effective 2034-04-01: old rate 18.00, new rate 19.50 per hour"),
}, async (f) => {
  seedDocument(f, { id: "pay-change", title: PAY_CHANGE, day: "2034-04-01", text: PAY_TEXT });
  const { body } = await f.think(R11);
  assert.equal(body.evidence_gate.supported, true);
  assert.deepEqual(citedIds(body), ["pay-change"]);
  assert.match(body.answer, /18\.00.*19\.50/);
}));

test("R11 control: a pay record with no date anywhere cannot carry a money claim", () => withStore({
  [R11]: payDraft("Associate Kappa pay change: old rate 18.00, new rate 19.50 per hour"),
}, async (f) => {
  seedDocument(f, { id: "pay-change", title: PAY_CHANGE, day: null, text: "Associate Kappa pay change: old rate 18.00, new rate 19.50 per hour." });
  const { body } = await f.think(R11);
  assertNoConfidentAnswer(body, "undated pay figures");
  assert.ok(body.gaps.some((gap) => gap.type === "money_veto" && gap.rule === "unreliable_date"));
}));

test("R11 control: a rate that is not in the cited record is refused", () => withStore({
  [R11]: payDraft("Associate Kappa pay change effective 2034-04-01: old rate 18.00, new rate 19.75 per hour"),
}, async (f) => {
  seedDocument(f, { id: "pay-change", title: PAY_CHANGE, day: "2034-04-01", text: PAY_TEXT });
  const { body } = await f.think(R11);
  assertNoConfidentAnswer(body, "rate not in the record");
  assert.ok(body.gaps.some((gap) => gap.type === "money_veto" && gap.rule === "span_mismatch"));
}));

test("R11 known gap: the record's own sentence, ending in its effective date, can be restated", knownGap(
  "the money span check refuses a verbatim per-hour rate sentence when the effective date follows the rate, a false refusal of exact evidence",
), () => withStore({
  [R11]: payDraft(PAY_TEXT.slice(0, -1)),
}, async (f) => {
  seedDocument(f, { id: "pay-change", title: PAY_CHANGE, day: "2034-04-01", text: PAY_TEXT });
  const { body } = await f.think(R11);
  assert.equal(body.evidence_gate.supported, true);
}));

// R13. Who signed which version, and when.

const R13 = "Who signed the executed agreement with Licensee Alpha, and on what date?";

test("R13 control: the signed copy answers the signer and date", () => withStore({
  [R13]: draftAndApprove((cite) => `The managing member of Licensee Alpha signed version 3 on 2034-02-14 [${cite("Licensee Alpha agreement v3, signed")}].`, "Licensee Alpha agreement v3, signed"),
}, async (f) => {
  seedDocument(f, { id: "alpha-signed", title: "Licensee Alpha agreement v3, signed", day: "2034-02-14", text: "Version 3. Signed 2034-02-14 by the managing member of Licensee Alpha and by Store North." });
  const { body } = await f.think(R13);
  assert.equal(body.evidence_gate.supported, true);
  assert.deepEqual(citedIds(body), ["alpha-signed"]);
}));

test("R13 control: an unsigned draft cannot establish execution, even if the verifier approves", () => withStore({
  [R13]: draftAndApprove((cite) => `The managing member signed on 2034-02-14 [${cite("Licensee Alpha agreement v3 draft for signature")}].`, "Licensee Alpha agreement v3 draft for signature"),
}, async (f) => {
  seedDocument(f, { id: "alpha-draft", title: "Licensee Alpha agreement v3 draft for signature", day: "2034-02-10", text: "Version 3 draft. Signature block for the managing member of Licensee Alpha, dated 2034-02-14." });
  const { body } = await f.think(R13);
  assertNoConfidentAnswer(body, "draft as executed");
  assert.equal(body.evidence_gate.reason, "only non-final planning material was cited for a binding legal claim");
}));

// R14. Which cardholder made a purchase.

test("R14 control: card spend is cited by account mask, never by a person", () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-card", "0577", { kind: "card" });
  seedTxn(f, "north-card", { day: "2034-06-15", cents: 18450, description: "Supplier Two", payee: "Supplier Two" });
  const body = await ask("How much did I spend at Supplier Two in June 2034?");
  assert.equal(body.ledger.total_minor, 18450);
  assert.equal(body.citations[0].account_mask, "0577");
  assert.equal(Object.hasOwn(body.citations[0], "cardholder"), false);
}));

test("R14 known gap: the purchase names its cardholder from a loaded card program export", knownGap(
  "ledger rows carry only the account mask; nothing links a purchase to the individual card that made it",
), () => withLedger(async (f, { ask }) => {
  seedLedgerAccount(f, "north-card", "0577", { kind: "card" });
  seedTxn(f, "north-card", { day: "2034-06-15", cents: 18450, description: "Supplier Two", payee: "Supplier Two" });
  const body = await ask("How much did I spend at Supplier Two in June 2034?");
  assert.equal(typeof body.citations[0]?.cardholder, "string");
}));

// R15. Who managed a location in a named month.

const R15 = "Who was the general manager of the Store South location in March 2034?";

test("R15 control: with only a present-day note, the answer is the honest no-answer shape", () => withStore({
  [R15]: { answer: "The documents do not answer the question." },
}, async (f) => {
  seedDocument(f, { id: "south-contact", title: "Store South contact sheet", day: "2034-11-01", text: "Store South location contact sheet: manager on duty desk extension 204." });
  const { body } = await f.think(R15);
  assert.deepEqual(resultIds(body), ["store-files:south-contact"]);
  assertNoConfidentAnswer(body, "month-specific role from a present-day note");
}));

test("R15 control: a dated assignment record answers for its month", () => withStore({
  [R15]: draftAndApprove((cite) => `Per the 2034-02-20 assignment, manager M-3 ran the Store South location from 2034-03-01 [${cite("Store South manager assignment")}].`, "Store South manager assignment"),
}, async (f) => {
  seedDocument(f, { id: "south-assignment", title: "Store South manager assignment", day: "2034-02-20", text: "Manager M-3 is assigned as general manager of the Store South location effective 2034-03-01." });
  const { body } = await f.think(R15);
  assert.equal(body.evidence_gate.supported, true);
  assert.deepEqual(citedIds(body), ["south-assignment"]);
}));

// Refusal invariants shared by every row. These hold whatever the model writes.

const RQ = "What renewal option does the Store North lease give?";
const LEASE = "Store North premises lease, executed";

for (const [label, script, reason] of [
  ["a draft with no citation", { [RQ]: { answer: "The lease gives two five-year renewal options." } }, "draft made claims without document citations"],
  ["a draft citing a number the Worker never supplied", { [RQ]: ({ cite }) => ({ answer: `Two five-year renewal options [${cite(LEASE)}] [7].` }) }, "draft cited an unavailable document"],
  ["a draft the verifier rejects", { [RQ]: ({ kind, cite }) => kind === "answer"
    ? { answer: `Two five-year renewal options [${cite(LEASE)}].` }
    : { verdict: { supported: false, complete: false, evidence: [], reason: "fixture rejects" } } }, "fixture rejects"],
  ["a model that declares no evidence", { [RQ]: { answer: "The documents do not answer the question." } }, "answer model found no direct support"],
]) {
  test(`refusal invariant: ${label} returns no approved answer`, () => withStore(script, async (f) => {
    seedDocument(f, { id: "north-lease", title: LEASE, text: "Store North premises lease. Renewal: one option of five years on written notice." });
    const { body } = await f.think(RQ);
    assertNoConfidentAnswer(body, label);
    assert.equal(body.evidence_gate.reason, reason);
  }));
}

test("refusal invariant: an empty search over an unproven source never reads as absence", async () => {
  const f = await createStoreFixture();
  try {
    f.raw("UPDATE sources SET last_complete_sweep_at = NULL");
    seedDocument(f, { id: "lease", title: "Store North premises lease", text: "Premises lease for the Store North site." });
    const { body } = await f.think("What prepayment penalty applies to the Lender One facility?");
    assert.equal(body.answer, null);
    assert.equal(body.status, "coverage_incomplete");
    assert.equal(body.confidence, undefined, "no confidence figure is put on an unproven absence");
    assert.match(body.notice, /provisional|not proof|not yet proven/i);
  } finally {
    f.close();
  }
});

test("route control: a money question through /api/rag/think reaches the ledger for the signed-in owner", async () => {
  const f = await createStoreFixture();
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedLedgerAccount(f, "north-operating", "0310");
    seedTxn(f, "north-operating", { day: "2034-05-12", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
    const { status, body } = await f.think("How much did I spend at Supplier One in May 2034?");
    assert.equal(status, 200);
    assert.equal(body.ledger?.total_minor, 41250);
    assert.deepEqual(f.model.calls, [], "no model turn for a ledger answer");
    assert.ok(Date.parse(LEDGER_NOW) > Date.parse("2034-05-31"), "fixture clock sits after the asked month");
  } finally {
    f.close();
  }
});
