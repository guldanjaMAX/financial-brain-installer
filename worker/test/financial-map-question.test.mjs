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
 *   (e) the MCP surfaces carry it — including above the incomplete-search
 *       notice, whose own text stays byte-identical and is pinned verbatim
 *       here, so a confident absence claim stays impossible on that path;
 *   (f) only the whole owner gets it: a proxy key, a zone-scoped grant, an
 *       all-minus-exclusions grant and an entity-scoped question are refused
 *       outright rather than served a partial list;
 *   (g) beside an answer the documents DID support, the wording understates
 *       instead of contradicting it, and no candidate list rides along.
 *
 * The owner-facing sentences are spelled out in COPY below rather than
 * imported, so a wording change has to be approved rather than absorbed.
 *
 * Every fixture name, label and figure below is invented for this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

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

/**
 * The owner-facing copy, SPELLED OUT rather than imported.
 *
 * This is the sentence a client judges the product by, and leadership set it
 * word for word. Importing the constant would let a later edit rewrite both
 * the product and the test in one move and stay green; writing it here means a
 * wording change fails until a human approves the new words. Same reason
 * degraded-absence.test.mjs spells out the refusal sentence.
 */
const COPY = Object.freeze({
  not_established: Object.freeze({
    unsupported:
      "Your financial map isn't set up yet, so your Brain can't say which entities are open or closed.",
    supported:
      "This comes from your documents, not from a financial map you confirmed — your map isn't set up yet.",
    one_step:
      "Open Financial Map in your private owner app and answer its short questions, one at a time — which businesses you own or have owned, and whether each one is still open — then save the map it builds. From then on your Financial Map shows every entity with its status.",
  }),
  stale: Object.freeze({
    unsupported:
      "Your financial map is out of date: an entity or account was added or changed after you set it up, so your Brain won't answer this from the old map.",
    supported:
      "This comes from your documents, not from a financial map you confirmed — your map is out of date.",
    one_step:
      "Open Financial Map in your private owner app, review what changed, and save the updated map. Then your Financial Map shows every entity with its current status.",
  }),
});
const CANDIDATES_FOLLOW =
  " The questions start from what your Brain has already seen, listed below as possible mentions.";

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

/** The exact ledger content, so "the answer path wrote nothing" is a claim
    about rows rather than about intent. */
function ledgerRows(fixture) {
  return JSON.stringify({
    entities: fixture.rows("SELECT * FROM fin_entities ORDER BY id").map((row) => ({ ...row })),
    accounts: fixture.rows("SELECT * FROM fin_accounts ORDER BY id").map((row) => ({ ...row })),
  });
}

async function think(fixture, q) {
  const from = fixture.seen.sql.length;
  const ledgerBefore = ledgerRows(fixture);
  const response = await fixture.post("/api/rag/think", { q }, ownerKey(fixture));
  const sqlSeen = fixture.seen.sql.slice(from).map(String);
  assert.equal(response.status, 200, `think returned ${response.status}`);
  assert.ok(sqlSeen.length > 0, "no statement was recorded, so the checks below would pass vacuously");
  // Answering a question must never create or change a ledger row. Checked on
  // EVERY call in this file, both as content and as statements, because an
  // entity the brain proposed and then quietly recorded would be exactly the
  // unconfirmed-candidate-becomes-fact failure this whole change exists to
  // avoid.
  assert.equal(ledgerRows(fixture), ledgerBefore, `the ledger changed while answering: ${q}`);
  assert.equal(
    sqlSeen.some((sql) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql) && /\bfin_(?:entities|accounts)\b/i.test(sql)),
    false,
    `a ledger write statement was issued while answering: ${q}`,
  );
  return {
    body: await response.json(),
    sqlSeen,
    mapWasRead: sqlSeen.some((sql) => MAP_READ_MARKER.test(sql)),
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
    // A financial account in the sense the map actually means, and the past
    // tense. These guard the exclusions below from being written so widely
    // that the real question stops working.
    "is my business closed?",
    "Is my LLC still active?",
    "which of my bank accounts are still open",
    "are any of my checking accounts closed",
    "what companies do I still own",
    "which businesses have I dissolved",
    "list my entities and whether they are open",
    "how many LLCs do I have",
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
    // THE ACCOUNTING SENSES OF "ACCOUNT". Every one of these fired before the
    // exclusion existed, and each would have put "Your financial map isn't set
    // up yet" plus the owner's whole entity and account list above an answer
    // about their books. The first eight are the strings the independent
    // review reproduced; the rest are the same family.
    "what accounts payable do I have outstanding",
    "what accounts receivable do I have",
    "which chart of accounts do I have",
    "what expense accounts do I have",
    "which vendor accounts do I still have",
    "what login accounts do I have",
    "what revenue accounts do I have",
    "which asset accounts are still active",
    "what ledger accounts do I have",
    "which accounts payable have I closed",
    "what expense accounts have I closed",
    "which customer accounts are still active",
    "what subscription accounts do I have",
    "which utility accounts are open",
    // THE LOGIN SENSES.
    "what email accounts do I have",
    "which software accounts do I still have",
    "what user accounts do we have",
    "which online accounts do I still have",
    // STATEMENTS, NOT QUESTIONS. The owner is telling the brain a status they
    // already know. Answering "your financial map isn't set up, so your Brain
    // can't say which entities are open or closed" is useless to them.
    "my company closed last year",
    "my business is closed, what do I do",
    "my LLC is dissolved",
    "our company is inactive now",
    "my business closed in March and I need help",
    "what should I do now that my company is closed",
  ];
  for (const q of silent) {
    assert.equal(hasFinancialMapStatusIntent(q), false, `should stay silent: ${q}`);
  }
  assert.ok(silent.length >= 40, `the precision corpus is the test: ${silent.length} strings`);

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
  assert.equal(guidance.message, COPY.not_established.unsupported);
  assert.equal(guidance.one_step, COPY.not_established.one_step + CANDIDATES_FOLLOW,
    "candidates are listed below, so the sentence that points at them is appended");
  assert.equal(/guided owner interview|complete preview/i.test(JSON.stringify(guidance)), false,
    "the map read's operator-facing next_step must never reach owner copy");

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
    // Through the real route, not only against the exported function: the
    // accounting and login senses of "account", and a status the owner is
    // stating rather than asking about.
    "what accounts payable do I have outstanding",
    "what accounts receivable do I have",
    "which chart of accounts do I have",
    "what expense accounts do I have",
    "which vendor accounts do I still have",
    "what login accounts do I have",
    "my company closed last year",
    "my business is closed, what do I do",
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
  assert.equal(guided.body.map_guidance.message, COPY.stale.unsupported);
  assert.equal(guided.body.map_guidance.one_step, COPY.stale.one_step + CANDIDATES_FOLLOW);
  assert.equal(guided.body.map_guidance.what_the_brain_sees.unconfirmed, true);
  assert.ok(
    guided.body.map_guidance.what_the_brain_sees.entities.some((row) => row.label === "Synthetic Annex"),
    "the stale guidance shows the current inventory, not the sealed snapshot",
  );
  const staleJson = JSON.stringify(guided.body);
  assert.equal(staleJson.includes("snapshot_id"), false, "no part of the sealed snapshot rides out");
  assert.equal(staleJson.includes("owner_value"), false, "the owner's sealed answers are not quoted as fact");
});

/* ----------------------------------------------------- the scope guard */

test("only the whole owner gets the candidate inventory", async (t) => {
  // The one security-relevant line in this change. The candidate inventory is
  // the COMPLETE list of the owner's structured entities and accounts: it is
  // not zone-scoped, entity-scoped or document-scoped content, so there is no
  // correct way to narrow it for a narrowed caller. Each principal below must
  // get today's answer and no map read at all — refused, not filtered.
  const fixture = await createProductFixture({
    env: {
      RAG_PROXY_KEY: "fixture-rag-proxy-key",
      AI: {
        async run(model) {
          if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return { response: "The documents do not answer the question." };
        },
      },
    },
  });
  t.after(() => fixture.close());
  seedEntity(fixture, "synthetic-holdings", ENTITY_LABEL);
  seedAccount(fixture, "synthetic-operating", "synthetic-holdings", ACCOUNT_LABEL);
  seedFormationDocument(fixture);

  const ask = async (body, headers) => {
    const from = fixture.seen.sql.length;
    const response = await fixture.post("/api/rag/think", body, headers);
    const sqlSeen = fixture.seen.sql.slice(from).map(String);
    assert.equal(response.status, 200, `think returned ${response.status}`);
    return {
      body: await response.json(),
      mapWasRead: sqlSeen.some((sql) => MAP_READ_MARKER.test(sql)),
    };
  };

  // CONTROL, first: the whole owner asking the same question on the same
  // fixture does get it. Every refusal below is therefore the guard working
  // and not the feature being broken or the fixture being wrong.
  const owner = await ask({ q: FLAGSHIP }, ownerKey(fixture));
  assert.ok(owner.body.map_guidance, "the control must produce guidance");
  assert.equal(owner.mapWasRead, true);

  // A read-only proxy key. validateReadKey accepts it, so the question is
  // answered, but scopePrincipalKind is "proxy" and not the owner.
  // `access.principal` is the route's own record of who it thought it was
  // serving, so each refusal below is anchored to a real restricted principal
  // rather than to an unauthenticated or malformed request.
  const proxy = await ask({ q: FLAGSHIP }, { "X-Admin-Key": "fixture-rag-proxy-key" });
  assert.equal(proxy.body.access?.principal, "proxy", "the route must really have seen a proxy");
  assert.equal(proxy.body.access?.read_only, true);
  assert.equal(Object.hasOwn(proxy.body, "map_guidance"), false, "a proxy read key is not the owner");
  assert.equal(proxy.mapWasRead, false, "and the map must not even be read for it");

  // A zone-scoped capability grant.
  fixture.raw(
    `INSERT INTO grants (grant_id,display_name,capabilities,expires_at,created_at,created_by,
                         scope_include,scope_exclude)
     VALUES ('g_zoned','Synthetic bookkeeper','["ask"]',NULL,?,'test','{"zones":["books"]}','[]')`,
    Date.now(),
  );
  const zoned = await ask({ q: FLAGSHIP }, {
    ...(await fixture.ownerHeaders({ grantId: "g_zoned" })), "X-Brain-App": "1",
  });
  assert.equal(zoned.body.access?.principal, "grant");
  assert.equal(zoned.body.access?.scope, "zones");
  assert.equal(Object.hasOwn(zoned.body, "map_guidance"), false, "a zone-scoped grant is not the owner");
  assert.equal(zoned.mapWasRead, false);

  // An ALL-minus-exclusions grant. Its scope.all is true and it is still
  // restricted, which is why the guard asks scopeIsUnrestricted rather than
  // reading scope.all itself.
  //
  // HONESTY ABOUT WHAT THIS PROVES: a capability grant also has principal kind
  // "grant", so today the principal-kind clause refuses this request first and
  // the scopeIsUnrestricted clause is a second lock that nothing can reach on
  // its own. Verified by mutation: reverting the guard to `scope.all === true`
  // leaves this test green, while removing the principal-kind clause turns it
  // red. The assertion below is therefore that the request IS classified as
  // restricted ("zones", not "all") and IS refused — not that the scope clause
  // is what refused it.
  fixture.raw(
    `INSERT INTO grants (grant_id,display_name,capabilities,expires_at,created_at,created_by,
                         scope_include,scope_exclude)
     VALUES ('g_minus','Synthetic all-minus','["ask"]',NULL,?,'test','{"all":true}','["medical"]')`,
    Date.now(),
  );
  const allMinus = await ask({ q: FLAGSHIP }, {
    ...(await fixture.ownerHeaders({ grantId: "g_minus" })), "X-Brain-App": "1",
  });
  assert.equal(allMinus.body.access?.principal, "grant");
  assert.equal(allMinus.body.access?.scope, "zones",
    "the repo's own classifier calls all-minus-medical restricted, not 'all'");
  assert.equal(Object.hasOwn(allMinus.body, "map_guidance"), false,
    "an all-minus-medical grant has scope.all true and is still restricted");
  assert.equal(allMinus.mapWasRead, false);

  // The owner, but asking inside one entity's boundary. A narrowed question
  // gets a narrowed answer, and the whole-owner inventory is not that.
  const scoped = await ask({ q: FLAGSHIP, entity_slug: "synthetic-holdings" }, ownerKey(fixture));
  assert.equal(scoped.body.entity_scope?.applied, true, "the narrowing must actually have applied");
  assert.equal(Object.hasOwn(scoped.body, "map_guidance"), false,
    "an entity-scoped question does not reach past its own entity");
  assert.equal(scoped.mapWasRead, false);

  // The control again, last, so the guard cannot have simply broken the
  // feature partway through this test.
  const ownerAgain = await ask({ q: FLAGSHIP }, ownerKey(fixture));
  assert.ok(ownerAgain.body.map_guidance);
  assert.equal(ownerAgain.mapWasRead, true);
});

/* ---------------------------------------------- beside a cited answer */

test("beside an answer the documents DID support, the guidance understates and lists no candidates", async (t) => {
  const fixture = await createProductFixture({
    env: {
      AI: {
        async run(model, input) {
          if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          const system = String(input?.messages?.[0]?.content || "");
          if (/verify a proposed answer/.test(system)) {
            return { response: { supported: true, complete: true, evidence: [1], reason: "stated in the filing" } };
          }
          return { response: `${ENTITY_LABEL} was formed in 2019 [1].` };
        },
      },
    },
  });
  t.after(() => fixture.close());
  seedEntity(fixture, "synthetic-holdings", ENTITY_LABEL);
  seedAccount(fixture, "synthetic-operating", "synthetic-holdings", ACCOUNT_LABEL);
  seedFormationDocument(fixture);

  const { body } = await think(fixture, FLAGSHIP);
  assert.equal(body.evidence_gate?.supported, true, "this test is about a SUPPORTED answer");
  assert.ok(body.answer && !/do not answer the question/i.test(body.answer));

  const guidance = body.map_guidance;
  assert.ok(guidance, "the map is still not set up, and understating that is still worth saying");
  // The unsupported sentence would contradict the answer sitting beside it.
  assert.equal(guidance.message, COPY.not_established.supported);
  assert.notEqual(guidance.message, COPY.not_established.unsupported);
  assert.equal(guidance.one_step, COPY.not_established.one_step,
    "nothing is listed below, so the sentence that points at a list is not appended");
  assert.equal(Object.hasOwn(guidance, "what_the_brain_sees"), false,
    "a candidate list beside a cited answer invites reading the two together");
  assert.equal(JSON.stringify(guidance).includes(ENTITY_LABEL), false);

  // Rendered, it is two sentences and no list.
  const lines = financialMapGuidanceLines(guidance);
  assert.deepEqual(lines, [COPY.not_established.supported, `One step: ${COPY.not_established.one_step}`]);
});

/* ------------------------------------------------------------------ (e) */

test("the remote MCP renders the guidance above the refusal and leaves the incomplete-search path alone", async () => {
  const { handleMcp } = await import("../src/lib/mcp-endpoint.js");
  const guidance = financialMapGuidance({
    map_status: "not_established",
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
  assert.ok(rendered.includes(COPY.not_established.one_step), "the one step renders verbatim");
  assert.match(rendered, /possible mentions/i);
  assert.match(rendered, /possible_mention/);
  assert.ok(rendered.includes(ENTITY_LABEL) && rendered.includes(ACCOUNT_LABEL));
  assert.ok(
    rendered.indexOf("financial map isn't set up") < rendered.indexOf("The documents do not answer"),
    "the guidance goes above the refusal, and the refusal still stands",
  );

  // THE INCOMPLETE-SEARCH PATH. The worst error this product can make is a
  // confident absence claim from a search that did not complete, and that
  // notice is what prevents it. The guidance now rides ABOVE it — install day
  // is exactly when an owner asks this question and exactly when the index is
  // still projecting — and both sentences stay true, because the guidance is
  // derived from the MAP state rather than from the search. A half-built index
  // cannot make "your map isn't set up" provisional, and the guidance never
  // says the records lack anything.
  const { emptyRetrievalDisclosure } = await import("../src/lib/retrieval-status.js");
  const { answerText, confidenceText } = await import("../src/lib/answer-render.js");
  const incomplete = {
    ...emptyRetrievalDisclosure("vector"),
    answer: null, citations: [], results: [], map_guidance: guidance,
  };
  const withGuidance = await call(incomplete);
  const noticeBlock = [answerText(incomplete), "", confidenceText(incomplete)].join("\n");

  // The notice is byte-identical and still the last thing said.
  assert.ok(withGuidance.endsWith(noticeBlock), "the incomplete-search notice must not be reworded");
  assert.equal(withGuidance, `${financialMapGuidanceLines(guidance).join("\n")}\n\n${noticeBlock}`);
  assert.ok(
    withGuidance.indexOf(COPY.not_established.unsupported) < withGuidance.indexOf(answerText(incomplete)),
    "the guidance goes above the notice, never instead of it",
  );
  // And the absence claim is still impossible on this path.
  assert.ok(!/do not answer the question/i.test(withGuidance));
  assert.match(withGuidance, /could not be completed/i);

  // Without guidance the path is exactly what it always was, byte for byte.
  const { map_guidance: _none, ...bare } = incomplete;
  assert.equal(await call(bare), noticeBlock);
});

test("the local MCP carries the guidance to the client instead of relaying a bare refusal", async () => {
  const guidance = financialMapGuidance({
    map_status: "not_established",
    current_inventory: {
      entities: [{ label: ENTITY_LABEL, candidate_state: "possible_mention" }],
      accounts: [],
    },
  });
  const out = await localMcpThink({
    mode: "think",
    answer: null,
    status: "coverage_incomplete",
    notice: "The search found candidate records, but source history is incomplete. Treat this result as provisional.",
    gaps: [], citations: [], results: [],
    evidence_gate: { supported: false, complete: false, evidence: [], reason: "answer model found no direct support" },
    map_guidance: guidance,
  });
  assert.equal(out.map_guidance?.map_status, "not_established");
  assert.equal(out.map_guidance.what_the_brain_sees.unconfirmed, true);
  assert.deepEqual(out.map_guidance.what_the_brain_sees.entities,
    [{ label: ENTITY_LABEL, candidate_state: "possible_mention" }]);
  assert.equal(out.search_status, "coverage_incomplete", "the provisional-coverage signal still rides out");

  const without = await localMcpThink({
    mode: "think", answer: "The documents do not answer the question.",
    gaps: [], citations: [], results: [],
  });
  assert.equal(Object.hasOwn(without, "map_guidance"), false,
    "a response with no guidance gains no key");
});

/* ------------------------------------------------------------------ unit */

test("the guidance renders as sentences that keep every candidate a candidate", () => {
  assert.deepEqual(financialMapGuidanceLines(null), []);
  assert.deepEqual(financialMapGuidanceLines(undefined), []);

  const empty = financialMapGuidance({
    map_status: "not_established",
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

  // A row arriving with any other candidate_state is still rendered as a
  // possible mention. "possible_mention" is THIS module's invariant, not a
  // field to relay: "(confirmed)" underneath a notice that says nothing here is
  // confirmed would be the exact contradiction this whole change exists to
  // prevent, and the guidance must not inherit an upstream change silently.
  const hostile = financialMapGuidance({
    map_status: "not_established",
    current_inventory: {
      entities: [
        { label: "Synthetic Claimed", candidate_state: "confirmed" },
        { label: "Synthetic Asserted", candidate_state: "owner_stated" },
      ],
      accounts: [{ label: "Synthetic Account", candidate_state: "verified" }],
    },
  });
  assert.deepEqual(hostile.what_the_brain_sees.entities, [
    { label: "Synthetic Claimed", candidate_state: "possible_mention" },
    { label: "Synthetic Asserted", candidate_state: "possible_mention" },
  ]);
  assert.deepEqual(hostile.what_the_brain_sees.accounts,
    [{ label: "Synthetic Account", candidate_state: "possible_mention" }]);
  const hostileText = financialMapGuidanceLines(hostile).join("\n");
  for (const forbidden of ["confirmed)", "owner_stated", "verified"]) {
    assert.equal(hostileText.includes(forbidden), false, `${forbidden} must not render as a candidate state`);
  }
  assert.equal(hostileText.includes("Synthetic Claimed (possible_mention)"), true);
});

/* ---------------------------------------------------------------- helpers */

const LOCAL_MCP = fileURLToPath(new URL("../../components/brain-mcp.mjs", import.meta.url));

/** Drive the shipped local MCP server against one canned /think body. */
async function localMcpThink(body) {
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const child = spawn(process.execPath, [LOCAL_MCP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRAIN_URL: `http://127.0.0.1:${port}`,
        BRAIN_NAME: "fixture-brain",
        BRAIN_KEY: `fixture-${"k".repeat(40)}`,
        BRAIN_CONFIG: "",
        BRAIN_MANIFEST: "",
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "brain_think", arguments: { q: FLAGSHIP } },
    })}\n`);
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `local mcp exited ${code}`);
    const reply = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 1);
    assert.ok(reply, `no reply on stdout: ${stdout}`);
    return JSON.parse(reply.result.content[0].text);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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
