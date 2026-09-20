/**
 * "Which of my entities are still open and which are closed?"
 *
 * The most fundamental question an owner asks a financial brain, and the one a
 * client judges the product by. Asked on a brain whose owner financial map has
 * never been activated, /api/rag/think refused it: the documents hold formation
 * paperwork and state filing forms, none of which states any entity's CURRENT
 * status, so the evidence gate said "answer model found no direct support" and
 * returned nothing. Honest, and useless — because the product already holds the
 * structure built for exactly this question, and it knew it was not set up.
 *
 * What is pinned here:
 *   (a) the intent detector fires on the question and stays silent on ordinary
 *       ones, and silence means the map is never even read;
 *   (b) the map state is read beside retrieval, and a read that throws leaves
 *       the response exactly as it was — the added key is the ONLY difference;
 *   (c) the guidance names the map state, the one step, and what the brain has
 *       seen WITHOUT confirming it, and never states a candidate as a fact or
 *       prints a ledger value;
 *   (d) a `current` map produces no guidance here, because answering FROM the
 *       sealed snapshot is a separate change that is deliberately not built;
 *   (e) the MCP surfaces carry it, and the incomplete-search path that must
 *       never render an absence claim is untouched.
 *
 * Every fixture name, label and figure below is invented for this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createProductFixture, json } from "./product-contract-fixture.mjs";
import { makeCredential, signAssertion } from "./webauthn-fixtures.mjs";
import {
  CANDIDATE_NOTICE,
  financialMapGuidance,
  financialMapGuidanceLines,
  hasFinancialMapStatusIntent,
} from "../src/lib/financial-map-question.js";

const ORIGIN = "https://brain.invalid";
const RP_ID = "brain.invalid";
const MAP_PREFIX = "/api/admin/brain/financial-map/";
const APP_PREFIX = "/api/owner/financial-map/";
const MAP_READ_MARKER = /owner_financial_map_key_state/;

/* The flagship question, in the owner's own words. */
const FLAGSHIP = "Which of my entities are still open and which are closed?";

/* Ledger values that must never reach an answer surface. Each one is a string
   or number no other part of the fixture produces, so "it did not leak" is a
   claim this file can actually check rather than assume. */
const LEDGER_MARKERS = Object.freeze({
  holds: "SyntheticHoldsMarker",
  taxClass: "SyntheticTaxClassMarker",
  institution: "SyntheticInstitutionMarker",
  ownershipBp: 7350,
});

const ENTITY_LABEL = "Synthetic Holdings";
const SECOND_ENTITY_LABEL = "Synthetic Studio";
const ACCOUNT_LABEL = "Synthetic Operating";

const MAP_IDS = Object.freeze({
  filingUnit: `ofmf_${"1".repeat(32)}`,
  federalReturn: `ofmr_${"2".repeat(32)}`,
  bookkeeper: `ofmb_${"4".repeat(32)}`,
  bankSource: `ofms_${"5".repeat(32)}`,
});

const ownerKey = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });

/**
 * A brain whose answer model refuses in the exact shape the evidence gate
 * recognises, so the route under test reaches the real refusal branch rather
 * than a hand-written body.
 */
async function refusingBrain() {
  return createProductFixture({
    env: {
      AI: {
        async run(model) {
          if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return { response: "The documents do not answer the question." };
        },
      },
    },
  });
}

function seedEntity(fixture, slug, label, { status = "active" } = {}) {
  fixture.raw(
    `INSERT INTO fin_entities
       (tenant_id,entity_slug,legal_name,display_label,kind,status,relationship,holds,
        ownership_bp,tax_class,provenance,basis_state,recorded_at)
     VALUES ('primary',?,?,?,'business',?,'owned',?,?,?,'owner_stated','confirmed','2026-09-10T00:00:00Z')`,
    slug, `${label} LLC`, label, status,
    LEDGER_MARKERS.holds, LEDGER_MARKERS.ownershipBp, LEDGER_MARKERS.taxClass,
  );
}

function seedAccount(fixture, slug, entitySlug, label) {
  fixture.raw(
    `INSERT INTO fin_accounts
       (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,
        currency,status,provenance,basis_state,recorded_at)
     VALUES ('primary',?,?,?,?,'checking','asset','USD','open','owner_stated','confirmed','2026-09-10T00:00:00Z')`,
    slug, entitySlug, LEDGER_MARKERS.institution, label,
  );
}

/** One retrievable document, so the question reaches the evidence gate rather
    than the empty-retrieval branch. Formation paperwork is exactly what a real
    brain surfaces for this question and exactly what cannot answer it. */
function seedFormationDocument(fixture) {
  const docUid = "upload:synthetic-formation-packet";
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
     VALUES (?,'upload',?,?,?,?,'{}')`,
    docUid, "synthetic-formation-packet", "Synthetic formation packet",
    Date.parse("2026-01-05T00:00:00.000Z"), "b".repeat(64),
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES (?, ?, 0, ?, 'upload', ?)`,
    `${docUid}#0`, docUid,
    "Articles of organization for two synthetic entities, filed with the state. " +
      "The filing records formation only and says nothing about whether the entities " +
      "are open or closed today.",
    "Synthetic formation packet",
  );
}

async function think(fixture, q) {
  const from = fixture.seen.sql.length;
  const response = await fixture.post("/api/rag/think", { q }, ownerKey(fixture));
  const sqlSeen = fixture.seen.sql.slice(from);
  assert.equal(response.status, 200, `think returned ${response.status}`);
  return {
    body: await response.json(),
    mapWasRead: sqlSeen.some((sql) => MAP_READ_MARKER.test(String(sql))),
  };
}

/* ------------------------------------------------------------------ (a) */

test("the intent detector fires on entity and account status questions and stays silent on ordinary ones", () => {
  const fires = [
    FLAGSHIP,
    "which of my entities are open?",
    "Which of my LLCs are still active and which ones did I dissolve?",
    "Are any of my companies dissolved?",
    "What is the status of my businesses?",
    "What entities do I have?",
    "What accounts do I have and which are closed?",
    "which of my accounts are still open",
    "Is my consulting company still in business?",
    "Tell me which entities I still own.",
    "how many entities do I have",
    "Are our LLCs in good standing?",
  ];
  for (const q of fires) {
    assert.equal(hasFinancialMapStatusIntent(q), true, `should fire: ${q}`);
  }

  // Precision is the whole contract. A false negative costs nothing — the
  // response is exactly today's. A false positive puts financial-map copy
  // under an ordinary question, which is the product's worst face.
  const silent = [
    "what did I pay Acme in March",
    "how much is in my checking account",
    "when did I open my business checking account",
    "when is my next quarterly tax payment due",
    "who is my bookkeeper",
    "what is my business address",
    "summarize my last meeting with the accountant",
    "what invoices are still unpaid",
    "how much did my company spend on software last year",
    "which vendors did I pay last quarter",
    "is the Redstone project still active",
    "what did the bank charge my account in August",
    "what are my open loops this week",
    "should I close my LLC this year",
    "how do I open a business savings account",
    "what is my company phone number",
    "send me the latest statements for my accounts",
    "what is my current mailing address",
  ];
  for (const q of silent) {
    assert.equal(hasFinancialMapStatusIntent(q), false, `should stay silent: ${q}`);
  }

  assert.equal(hasFinancialMapStatusIntent(""), false);
  assert.equal(hasFinancialMapStatusIntent(null), false);
  assert.equal(hasFinancialMapStatusIntent(`${FLAGSHIP} ${"padding ".repeat(80)}`), false,
    "an unbounded question is not a crisp status question");
});

/* --------------------------------------------------------------- (a)(c) */

test("a not-established map turns a bare refusal into the reason, the candidates, and the one step", async (t) => {
  const fixture = await refusingBrain();
  t.after(() => fixture.close());
  seedEntity(fixture, "synthetic-holdings", ENTITY_LABEL);
  seedEntity(fixture, "synthetic-studio", SECOND_ENTITY_LABEL);
  seedAccount(fixture, "synthetic-operating", "synthetic-holdings", ACCOUNT_LABEL);
  seedFormationDocument(fixture);

  const { body, mapWasRead } = await think(fixture, FLAGSHIP);

  // The decision point was reached, so nothing below can pass vacuously.
  assert.equal(mapWasRead, true, "the map state must actually be read for this question");
  assert.ok(body.results.length > 0, "the formation document must be retrieved");
  assert.equal(body.evidence_gate?.reason, "answer model found no direct support",
    "the refusal itself is unchanged; this change only adds a field beside it");
  assert.equal(body.evidence_gate?.supported, false);
  assert.deepEqual(body.citations, [], "no document is promoted to a citation by this change");

  const guidance = body.map_guidance;
  assert.ok(guidance, "an entity-status question on an unset map must not end as a bare refusal");
  assert.equal(guidance.map_status, "not_established");
  assert.match(guidance.message, /financial map isn't set up yet/i);
  assert.match(guidance.one_step, /guided owner interview/i);
  assert.match(guidance.one_step, /owner app/i);

  const seen = guidance.what_the_brain_sees;
  assert.equal(seen.unconfirmed, true);
  assert.equal(seen.candidate_notice, CANDIDATE_NOTICE);
  assert.match(seen.candidate_notice, /not confirmed facts/i);
  assert.deepEqual(
    seen.entities,
    [
      { label: ENTITY_LABEL, candidate_state: "possible_mention" },
      { label: SECOND_ENTITY_LABEL, candidate_state: "possible_mention" },
    ],
    "every candidate carries its possible-mention state, and nothing else",
  );
  assert.deepEqual(seen.accounts, [{ label: ACCOUNT_LABEL, candidate_state: "possible_mention" }]);

  // A candidate is never presented as a fact: no status word is attached to any
  // row, and no row claims to be open, closed, active or dissolved.
  const seenJson = JSON.stringify(seen);
  for (const forbidden of ["\"status\"", "fields", "row_hash", "entity_ref", "account_ref", "suggested_map_id"]) {
    assert.equal(seenJson.includes(forbidden), false, `${forbidden} must not ride in the guidance`);
  }
  assert.equal(/\bactive\b|\bdissolved\b|\bclosed\b/i.test(seenJson), false,
    "no candidate row may carry a status of its own");

  // No ledger value anywhere in the response.
  const bodyJson = JSON.stringify(body);
  for (const marker of Object.values(LEDGER_MARKERS)) {
    assert.equal(bodyJson.includes(String(marker)), false, `${marker} is ledger content, not answer copy`);
  }
  // …and the labels ARE there, so the check above is not passing on an empty
  // object.
  assert.ok(bodyJson.includes(ENTITY_LABEL));
});

/* ------------------------------------------------------------------ (a) */

test("ordinary questions never read the map and never carry guidance", async (t) => {
  const fixture = await refusingBrain();
  t.after(() => fixture.close());
  seedEntity(fixture, "synthetic-holdings", ENTITY_LABEL);
  seedAccount(fixture, "synthetic-operating", "synthetic-holdings", ACCOUNT_LABEL);
  seedFormationDocument(fixture);

  const ordinary = [
    "what did I pay Acme in March",
    "how much is in my checking account",
    "when did I open my business checking account",
    "when is my next quarterly tax payment due",
    "who is my bookkeeper",
    "what is my business address",
    "summarize my last meeting with the accountant",
    "what invoices are still unpaid",
    "how much did my company spend on software last year",
    "which vendors did I pay last quarter",
    "is the Redstone project still active",
    "what are my open loops this week",
  ];
  assert.ok(ordinary.length >= 10, "the precision test needs at least ten ordinary questions");

  for (const q of ordinary) {
    const { body, mapWasRead } = await think(fixture, q);
    assert.equal(mapWasRead, false, `the map was read for an ordinary question: ${q}`);
    assert.equal(Object.hasOwn(body, "map_guidance"), false, `guidance appeared on: ${q}`);
  }

  // The same fixture, the same route, one question apart: proof that the
  // twelve silences above are the detector working and not the wiring broken.
  const flagship = await think(fixture, FLAGSHIP);
  assert.equal(flagship.mapWasRead, true);
  assert.ok(flagship.body.map_guidance);
});

/* ------------------------------------------------------------------ (b) */

test("a map read that throws leaves the think response exactly as it is without this change", async (t) => {
  const fixture = await refusingBrain();
  t.after(() => fixture.close());
  seedEntity(fixture, "synthetic-holdings", ENTITY_LABEL);
  seedAccount(fixture, "synthetic-operating", "synthetic-holdings", ACCOUNT_LABEL);
  seedFormationDocument(fixture);

  fixture.control.failOn = new RegExp(MAP_READ_MARKER.source, "g");
  const broken = await think(fixture, FLAGSHIP);
  fixture.control.failOn = null;
  const working = await think(fixture, FLAGSHIP);

  // The failure path was reached: the map read was attempted and threw.
  assert.equal(broken.mapWasRead, true, "the broken run must still attempt the read");
  assert.equal(Object.hasOwn(broken.body, "map_guidance"), false,
    "a map that could not be read is not a map that is not set up");
  assert.equal(JSON.stringify(broken.body).includes("map_guidance"), false);

  // The added key is the ONLY difference between a working read and a broken
  // one, which is the same as saying a broken read gives today's response.
  assert.ok(working.body.map_guidance, "the comparison is worthless if the working run added nothing");
  const { map_guidance: _added, ...withoutGuidance } = working.body;
  assert.deepEqual(broken.body, withoutGuidance);
});

/* --------------------------------------------------------------- (c)(d) */

test("an activated map answers through its own surface, and a stale one falls back to guidance", async (t) => {
  const fixture = await refusingBrain();
  t.after(() => fixture.close());
  seedEntity(fixture, "synthetic-holdings", ENTITY_LABEL);
  seedAccount(fixture, "synthetic-operating", "synthetic-holdings", ACCOUNT_LABEL);
  seedFormationDocument(fixture);

  const credential = await makeCredential({ rpId: RP_ID });
  const jwk = await crypto.subtle.exportKey("jwk", credential.pair.publicKey);
  fixture.raw(
    `INSERT INTO owner_passkeys
       (credential_id,public_key_jwk,alg,sign_count,nickname,created_at,grant_id,document_grant_id)
     VALUES (?,?,-7,0,'Synthetic map passkey',?,NULL,NULL)`,
    credential.credentialId, JSON.stringify(jwk), Date.now(),
  );
  const headers = await fixture.ownerHeaders({ credentialId: credential.credentialId });

  const read = await json(await fixture.post(`${MAP_PREFIX}read`, {}, ownerKey(fixture)));
  assert.equal(read.response.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.map_status, "not_established");

  const preview = await json(await fixture.post(
    `${MAP_PREFIX}preview`, { snapshot: completeSubmission(read.body) }, ownerKey(fixture),
  ));
  assert.equal(preview.response.status, 200, JSON.stringify(preview.body));

  const activate = await json(await fixture.post(
    `${APP_PREFIX}activate`,
    await activationBody(fixture, credential, headers, "synthetic-map-activation-1"),
    headers,
  ));
  assert.equal(activate.response.status, 200, JSON.stringify(activate.body));

  const current = await json(await fixture.post(`${MAP_PREFIX}read`, {}, ownerKey(fixture)));
  assert.equal(current.body.map_status, "current", JSON.stringify(current.body.unresolved_items));

  // A current map is answered FROM the sealed snapshot, through the map's own
  // tool. Doing that inside /think is a separate change with its own evidence
  // class, and this one deliberately does not attempt it: guidance for a map
  // that IS set up would be noise, and a snapshot read as prose would be a
  // second, unreviewed path to the same fact.
  const answered = await think(fixture, FLAGSHIP);
  assert.equal(answered.mapWasRead, true);
  assert.equal(Object.hasOwn(answered.body, "map_guidance"), false,
    "a current map produces no guidance here");

  // One new ledger row and the activated snapshot no longer describes the
  // inventory. The old snapshot must never be read as current fact.
  seedEntity(fixture, "synthetic-annex", "Synthetic Annex");
  const stale = await json(await fixture.post(`${MAP_PREFIX}read`, {}, ownerKey(fixture)));
  assert.equal(stale.body.map_status, "stale");

  const guided = await think(fixture, FLAGSHIP);
  assert.equal(guided.body.map_guidance?.map_status, "stale");
  assert.match(guided.body.map_guidance.message, /changed afterwards/i);
  assert.equal(guided.body.map_guidance.what_the_brain_sees.unconfirmed, true);
  assert.ok(
    guided.body.map_guidance.what_the_brain_sees.entities.some((row) => row.label === "Synthetic Annex"),
    "the stale guidance shows the current inventory, not the sealed snapshot",
  );
  const staleJson = JSON.stringify(guided.body);
  assert.equal(staleJson.includes("snapshot_id"), false, "no part of the sealed snapshot rides out");
  assert.equal(staleJson.includes("owner_value"), false, "the owner's sealed answers are not quoted as fact");
});

/* ------------------------------------------------------------------ (e) */

test("the remote MCP renders the guidance above the refusal and leaves the incomplete-search path alone", async () => {
  const { handleMcp } = await import("../src/lib/mcp-endpoint.js");
  const guidance = financialMapGuidance({
    map_status: "not_established",
    next_step: "Offer a guided owner interview, one short question at a time, then create a complete preview.",
    current_inventory: {
      entities: [{ label: ENTITY_LABEL, candidate_state: "possible_mention", fields: { status: {} } }],
      accounts: [{ label: ACCOUNT_LABEL, candidate_state: "possible_mention", fields: { status: {} } }],
    },
  });
  assert.ok(guidance);

  const refused = {
    answer: "The documents do not answer the question.",
    citations: [], results: [], gaps: [],
    evidence_gate: { supported: false, complete: false, evidence: [], reason: "answer model found no direct support" },
    map_guidance: guidance,
  };
  const call = async (thought, question = FLAGSHIP) => (await (await handleMcp(
    { BRAIN_NAME: "fixture" },
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ask", arguments: { question } },
      }),
    }),
    new URL(`${ORIGIN}/mcp`),
    { think: async () => thought, search: async () => thought },
  )).json()).result.content[0].text;

  const rendered = await call(refused);
  assert.match(rendered, /financial map isn't set up yet/i);
  assert.match(rendered, /guided owner interview/i);
  assert.match(rendered, /possible mentions/i);
  assert.match(rendered, /possible_mention/);
  assert.ok(rendered.includes(ENTITY_LABEL) && rendered.includes(ACCOUNT_LABEL));
  assert.ok(
    rendered.indexOf("financial map isn't set up") < rendered.indexOf("The documents do not answer"),
    "the guidance goes above the refusal, and the refusal still stands",
  );

  // The worst error this product can make is a confident absence claim from a
  // search that did not complete. That path renders its notice and nothing
  // else, and this change does not reach into it.
  const { emptyRetrievalDisclosure } = await import("../src/lib/retrieval-status.js");
  const { answerText, confidenceText } = await import("../src/lib/answer-render.js");
  const incomplete = {
    ...emptyRetrievalDisclosure("vector"),
    answer: null, citations: [], results: [], map_guidance: guidance,
  };
  const unchanged = await call(incomplete);
  assert.equal(unchanged, [answerText(incomplete), "", confidenceText(incomplete)].join("\n"));
  assert.ok(!/do not answer the question/i.test(unchanged));
});

/* ------------------------------------------------------------------ unit */

test("the guidance renders as sentences that keep every candidate a candidate", () => {
  assert.deepEqual(financialMapGuidanceLines(null), []);
  assert.deepEqual(financialMapGuidanceLines(undefined), []);

  const empty = financialMapGuidance({
    map_status: "not_established",
    next_step: "Offer a guided owner interview, one short question at a time, then create a complete preview.",
    current_inventory: { entities: [], accounts: [] },
  });
  const emptyText = financialMapGuidanceLines(empty).join("\n");
  assert.match(emptyText, /no confirmed entities or accounts on file/i);

  // A map that IS current is not this module's business.
  assert.equal(financialMapGuidance({ map_status: "current", current_inventory: { entities: [], accounts: [] } }), null);
  assert.equal(financialMapGuidance(null), null);
  assert.equal(financialMapGuidance({ map_status: "something_else" }), null);

  // More candidates than the guidance lists: the count is stated rather than
  // the list silently cut.
  const many = financialMapGuidance({
    map_status: "not_established",
    next_step: "Offer a guided owner interview, one short question at a time, then create a complete preview.",
    current_inventory: {
      entities: Array.from({ length: 30 }, (_, i) => ({
        label: `Synthetic Entity ${i}`, candidate_state: "possible_mention",
      })),
      accounts: [],
    },
  });
  assert.equal(many.what_the_brain_sees.entities.length, 25);
  assert.equal(many.what_the_brain_sees.entities_not_listed, 5);
  assert.match(financialMapGuidanceLines(many).join("\n"), /5 more possible mentions are not listed/);
});

/* ---------------------------------------------------------------- helpers */

/** The smallest complete map submission the contract accepts for this
    inventory, so an activated map can exist without inventing a second
    contract here. */
function completeSubmission(read) {
  const horizon = { start: 2025, end: 2026 };
  const answer = (value) => ({ assessment: "confirmed", owner_value: value });
  const entityMapByLedgerRef = new Map(read.current_inventory.entities.map((entity) => [
    entity.entity_ref, entity.suggested_map_id,
  ]));
  const filingUnit = { map_id: MAP_IDS.filingUnit, label: "Synthetic filing unit", assessment: "confirmed" };
  const entityYear = (taxYear) => ({
    tax_year: taxYear,
    state: "included",
    filing_units: { assessment: "confirmed", refs: [filingUnit.map_id] },
    required_returns: {
      assessment: "confirmed",
      items: [{ map_id: MAP_IDS.federalReturn, label: "Synthetic return", assessment: "confirmed" }],
    },
    required_forms: { assessment: "not_applicable", items: [] },
    k1_roles: { assessment: "not_applicable", items: [] },
    books: {
      assessment: "confirmed",
      bookkeeping_company: { map_id: MAP_IDS.bookkeeper, label: "Synthetic bookkeeper", assessment: "confirmed" },
    },
    payroll: { assessment: "not_applicable" },
    expected_sources: {
      assessment: "confirmed",
      items: [{ map_id: MAP_IDS.bankSource, label: "Synthetic bank feed", kind: "banking", assessment: "confirmed" }],
    },
  });
  return {
    version: 1,
    scope: { tenant_id: "primary", kind: "whole_owner_financial_picture" },
    tax_year_horizon: horizon,
    population_state: "owner_asserted_complete",
    filing_units: [filingUnit],
    entities: read.current_inventory.entities.map((entity) => ({
      map_id: entity.suggested_map_id,
      ledger_ref: entity.entity_ref,
      label: entity.label,
      disposition: "included",
      fields: {
        kind: answer(entity.fields.kind.current_value),
        status: answer(entity.fields.status.current_value),
        holds: answer(entity.fields.holds.current_value),
        ownership: answer(entity.fields.ownership.current_value),
        tax_class: answer(entity.fields.tax_class.current_value),
        relationship: answer(entity.fields.relationship.current_value),
        parent: entity.fields.parent.current_value
          ? answer(entityMapByLedgerRef.get(entity.fields.parent.current_value.entity_ref))
          : { assessment: "not_applicable", owner_value: null },
      },
      tax_years: Array.from({ length: horizon.end - horizon.start + 1 }, (_, index) =>
        entityYear(horizon.start + index)),
    })),
    accounts: read.current_inventory.accounts.map((account) => ({
      map_id: account.suggested_map_id,
      ledger_ref: account.account_ref,
      label: account.label,
      disposition: "included",
      fields: {
        entity_assignment: answer(
          entityMapByLedgerRef.get(account.fields.entity_assignment.current_value.entity_ref),
        ),
        kind: answer(account.fields.kind.current_value),
        balance_role: answer(account.fields.balance_role.current_value),
        currency: answer(account.fields.currency.current_value),
        status: answer(account.fields.status.current_value),
      },
    })),
  };
}

/** The owner's fresh passkey ceremony, bound to the exact preview. */
async function activationBody(fixture, credential, headers, requestId) {
  const review = await json(await fixture.post(`${APP_PREFIX}review`, {}, headers));
  assert.equal(review.response.status, 200, JSON.stringify(review.body));
  const options = await json(await fixture.post(
    `${APP_PREFIX}passkey/options`, { review_id: review.body.review_id }, headers,
  ));
  assert.equal(options.response.status, 200, JSON.stringify(options.body));
  const assertion = await signAssertion({
    pair: credential.pair,
    rpId: RP_ID,
    challenge: options.body.challenge,
    origin: ORIGIN,
    counter: 1,
  });
  // Touched so the unused import cannot hide a change in how the challenge is
  // bound; the ceremony's own contract is pinned by the map's test file.
  assert.match(createHash("sha256").update(options.body.challenge).digest("hex"), /^[a-f0-9]{64}$/);
  return {
    review_id: review.body.review_id,
    request_id: requestId,
    credentialId: credential.credentialId,
    ...assertion,
  };
}
