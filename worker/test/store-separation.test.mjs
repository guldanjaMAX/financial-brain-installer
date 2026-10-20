/**
 * Business separation on the sealed 0.4.17 Worker, for a mixed corpus of two
 * owned stores and a household side.
 *
 * Controls pin what holds today: an explicit entity scope is the D1 document
 * authority, and a scoped read never inherits the whole-owner bank ledger.
 * Known gaps are the separations that only exist when the caller asks for
 * them: the default assistant connection and the ledger both read every
 * owned record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleMcp } from "../src/lib/mcp-endpoint.js";
import {
  ROLE,
  createStoreFixture,
  knownGap,
  ledgerAsker,
  resultIds,
  seedDocument,
  seedEntity,
  seedLedgerAccount,
  seedTxn,
} from "./store-shape-fixture.mjs";

globalThis.fetch = async () => { throw new Error("network forbidden in the separation rows"); };

const Q = "What does the cleaning contract say about the weekly visit?";
const NORTH_DOC = "Store North cleaning contract";
const SOUTH_DOC = "Store South cleaning contract";
const HOUSE_DOC = "Household cleaning arrangement";

const script = {
  [Q]: ({ kind, cite, numbers }) => {
    const titles = [...numbers.keys()];
    return kind === "answer"
      ? { answer: titles.map((title) => `${title} sets a weekly visit [${cite(title)}].`).join(" ") }
      : { verdict: { supported: true, complete: true, evidence: titles.map(cite), reason: "fixture approves" } };
  },
};

async function mixedCorpus(body) {
  const f = await createStoreFixture({ script });
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedEntity(f, ROLE.south, "Store South");
    seedEntity(f, ROLE.household, "Household Side", { kind: "household" });
    seedDocument(f, { id: "north-cleaning", entity: ROLE.north, title: NORTH_DOC, text: "Cleaning contract for Store North: one weekly visit on Mondays." });
    seedDocument(f, { id: "south-cleaning", entity: ROLE.south, title: SOUTH_DOC, text: "Cleaning contract for Store South: one weekly visit on Thursdays." });
    seedDocument(f, { id: "house-cleaning", entity: ROLE.household, title: HOUSE_DOC, text: "Household cleaning arrangement: one weekly visit, private side." });
    await body(f);
    assert.deepEqual(f.model.unscripted, []);
  } finally {
    f.close();
  }
}

for (const [entity, own] of [[ROLE.north, "store-files:north-cleaning"], [ROLE.south, "store-files:south-cleaning"]]) {
  test(`separation control: an explicit ${entity} scope reads and cites only that store`, () => mixedCorpus(async (f) => {
    const { status, body } = await f.think(Q, { entity_slug: entity });
    assert.equal(status, 200);
    assert.deepEqual(body.entity_scope, { entity_slug: entity, applied: true });
    assert.deepEqual(resultIds(body), [own]);
    assert.equal(body.citations.length, 1);
    assert.equal(body.citations[0].ref, own.slice("store-files:".length));
    const other = entity === ROLE.north ? SOUTH_DOC : NORTH_DOC;
    assert.equal(body.answer.includes(other), false, "the other store's record is never cited");
    assert.equal(body.answer.includes(HOUSE_DOC), false, "the household record is never cited");
  }));
}

test("separation control: the whole-owner read sees every owned side, including the household", () => mixedCorpus(async (f) => {
  const { body } = await f.think(Q);
  assert.deepEqual(resultIds(body).sort(), [
    "store-files:house-cleaning", "store-files:north-cleaning", "store-files:south-cleaning",
  ]);
}));

test("separation control: an entity-scoped money question never reaches the whole-owner ledger", async () => {
  const f = await createStoreFixture();
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedEntity(f, ROLE.south, "Store South");
    seedLedgerAccount(f, "north-operating", "0310");
    seedLedgerAccount(f, "south-operating", "0422", { entity: ROLE.south });
    seedTxn(f, "south-operating", { day: "2034-05-12", cents: 77700, description: "ACH Supplier One", payee: "Supplier One" });
    const { status, body } = await f.think("How much did I spend at Supplier One in May 2034?", { entity_slug: ROLE.north });
    assert.equal(status, 200);
    assert.equal(body.ledger, undefined, "no ledger figure under a business scope");
    assert.equal(body.gaps[0].type, "ledger_not_consulted");
    assert.equal(body.gaps[0].reason, "retrieval_scope_restricted");
    assert.doesNotMatch(JSON.stringify(body), /777\.00|77700/, "the other store's amount never appears");
  } finally {
    f.close();
  }
});

test("separation control: the whole-owner ledger sums every owned store and shows each account", async () => {
  const f = await createStoreFixture();
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedEntity(f, ROLE.south, "Store South");
    seedLedgerAccount(f, "north-operating", "0310");
    seedLedgerAccount(f, "south-operating", "0422", { entity: ROLE.south });
    seedTxn(f, "north-operating", { day: "2034-05-12", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
    seedTxn(f, "south-operating", { day: "2034-05-14", cents: 77700, description: "ACH Supplier One", payee: "Supplier One" });
    const { ask } = ledgerAsker(f);
    const body = await ask("How much did I spend at Supplier One in May 2034?");
    assert.equal(body.ledger.total_minor, 41250 + 77700);
    assert.deepEqual(body.citations.map((c) => c.account_mask).sort(), ["0310", "0422"]);
  } finally {
    f.close();
  }
});

test("separation known gap: a ledger question naming one store counts only that store", knownGap(
  "the bank-ledger grammar has no business clause, so naming a store hands the question to documents instead of a per-store total",
), async () => {
  const f = await createStoreFixture();
  try {
    seedEntity(f, ROLE.north, "Store North");
    seedEntity(f, ROLE.south, "Store South");
    seedLedgerAccount(f, "north-operating", "0310");
    seedLedgerAccount(f, "south-operating", "0422", { entity: ROLE.south });
    seedTxn(f, "north-operating", { day: "2034-05-12", cents: 41250, description: "ACH Supplier One", payee: "Supplier One" });
    seedTxn(f, "south-operating", { day: "2034-05-14", cents: 77700, description: "ACH Supplier One", payee: "Supplier One" });
    const { ask } = ledgerAsker(f);
    const body = await ask("How much did Store North spend at Supplier One in May 2034?");
    assert.equal(body.ledger?.total_minor, 41250);
  } finally {
    f.close();
  }
});

async function listedTools() {
  const url = new URL("https://fixture.invalid/mcp");
  const request = new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  const response = await handleMcp({}, request, url, { grant: { profile: "librarian" } });
  return (await response.json()).result.tools;
}

test("separation control: the remote assistant's read tools carry no business selector today", async () => {
  const tools = await listedTools();
  const ask = tools.find((tool) => tool.name === "ask");
  const search = tools.find((tool) => tool.name === "search");
  assert.deepEqual(Object.keys(ask.inputSchema.properties), ["question"]);
  assert.deepEqual(Object.keys(search.inputSchema.properties), ["query"]);
});

test("separation known gap: the default assistant connection can be held to business records", knownGap(
  "remote assistant reads run with whole-owner scope and expose no business selector, so household records stay reachable",
), async () => {
  const tools = await listedTools();
  const ask = tools.find((tool) => tool.name === "ask");
  assert.ok(Object.hasOwn(ask.inputSchema.properties, "entity_slug"));
});
