import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createProductFixture, json } from "./product-contract-fixture.mjs";
import { makeCredential, signAssertion } from "./webauthn-fixtures.mjs";
import { handleOwnerFinancialMap } from "../src/lib/owner-financial-map.js";

const ORIGIN = "https://brain.invalid";
const RP_ID = "brain.invalid";
const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const PREFIX = "/api/admin/brain/financial-map/";
const APP_PREFIX = "/api/owner/financial-map/";
const MAP_IDS = Object.freeze({
  filingUnit: `ofmf_${"1".repeat(32)}`,
  federalReturn: `ofmr_${"2".repeat(32)}`,
  stateForm: `ofmx_${"3".repeat(32)}`,
  bookkeeper: `ofmb_${"4".repeat(32)}`,
  bankSource: `ofms_${"5".repeat(32)}`,
  declaredEntity: `ofme_${"6".repeat(32)}`,
  declaredAccount: `ofma_${"7".repeat(32)}`,
  futureSource: `ofms_${"8".repeat(32)}`,
});

function seedInventory(fixture) {
  fixture.raw(
    `INSERT INTO fin_entities
       (tenant_id,entity_slug,legal_name,display_label,kind,status,relationship,holds,
        ownership_bp,tax_class,provenance,basis_state,recorded_at,source_locator)
     VALUES ('primary','private-entity-8675309','Private Entity 8675309 LLC','Example 8675309',
             'business','active','owned','Operating company',10000,'S corporation',
             'owner_stated','confirmed','2026-09-10T00:00:00Z','private-entity-locator')`,
  );
  fixture.raw(
    `INSERT INTO fin_accounts
       (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,
        currency,status,external_ref,provenance,basis_state,recorded_at,source_locator)
     VALUES ('primary','private-account-4242','private-entity-8675309','Fixture Bank',
             'Operating 4242','checking','asset','4242','USD','open','private-external-account-id',
             'owner_stated','confirmed','2026-09-10T00:00:00Z','private-account-locator')`,
  );
}

async function readMap(fixture, headers = ADMIN) {
  return json(await fixture.post(`${PREFIX}read`, {}, headers));
}

function completeSubmission(read, overrides = {}) {
  const horizon = overrides.horizon || { start: 2024, end: 2026 };
  const assessment = overrides.assessment || "confirmed";
  const entityMapByLedgerRef = new Map(read.current_inventory.entities.map((entity) => [
    entity.entity_ref, entity.suggested_map_id,
  ]));
  const answer = (value, state = assessment) => ({
    assessment: state,
    owner_value: state === "confirmed" ? value : null,
  });
  const filingUnit = {
    map_id: MAP_IDS.filingUnit,
    label: "Primary filing unit",
    assessment: "confirmed",
  };
  const entityYear = (taxYear) => ({
    tax_year: taxYear,
    state: "included",
    filing_units: { assessment: "confirmed", refs: [filingUnit.map_id] },
    required_returns: {
      assessment: "confirmed",
      items: [{ map_id: MAP_IDS.federalReturn, label: "Form 1120-S", assessment: "confirmed" }],
    },
    required_forms: {
      assessment: "confirmed",
      items: [{ map_id: MAP_IDS.stateForm, label: "State filing", assessment: "confirmed" }],
    },
    k1_roles: { assessment: "not_applicable", items: [] },
    books: {
      assessment: "confirmed",
      bookkeeping_company: {
        map_id: MAP_IDS.bookkeeper, label: "Example bookkeeper", assessment: "confirmed",
      },
    },
    payroll: { assessment: "not_applicable" },
    expected_sources: {
      assessment: "confirmed",
      items: [{
        map_id: MAP_IDS.bankSource, label: "Primary bank feed",
        kind: "banking", assessment: "confirmed",
      }],
    },
  });
  return {
    version: 1,
    scope: { tenant_id: "primary", kind: "whole_owner_financial_picture" },
    tax_year_horizon: horizon,
    population_state: overrides.population_state || "owner_asserted_complete",
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
          : answer(null, "not_applicable"),
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
        entity_assignment: answer(entityMapByLedgerRef.get(account.fields.entity_assignment.current_value.entity_ref)),
        kind: answer(account.fields.kind.current_value),
        balance_role: answer(account.fields.balance_role.current_value),
        currency: answer(account.fields.currency.current_value),
        status: answer(account.fields.status.current_value),
      },
    })),
  };
}

function addOwnerDeclaredRows(snapshot) {
  const horizon = snapshot.tax_year_horizon;
  snapshot.entities.push({
    map_id: MAP_IDS.declaredEntity,
    ledger_ref: null,
    label: "Future consulting company",
    disposition: "included",
    fields: {
      kind: { assessment: "confirmed", owner_value: "business" },
      status: { assessment: "confirmed", owner_value: "active" },
      holds: { assessment: "confirmed", owner_value: "Consulting activity" },
      ownership: { assessment: "confirmed", owner_value: 10000 },
      tax_class: { assessment: "unknown", owner_value: null },
      relationship: { assessment: "confirmed", owner_value: "owned" },
      parent: { assessment: "not_applicable", owner_value: null },
    },
    tax_years: Array.from({ length: horizon.end - horizon.start + 1 }, (_, index) => ({
      tax_year: horizon.start + index,
      state: "included",
      filing_units: { assessment: "confirmed", refs: [snapshot.filing_units[0].map_id] },
      required_returns: { assessment: "unknown", items: [] },
      required_forms: { assessment: "unknown", items: [] },
      k1_roles: { assessment: "unknown", items: [] },
      books: { assessment: "unknown", bookkeeping_company: null },
      payroll: { assessment: "unknown" },
      expected_sources: {
        assessment: "confirmed",
        items: [{
          map_id: MAP_IDS.futureSource, label: "Future operating account",
          kind: "banking", assessment: "unavailable",
        }],
      },
    })),
  });
  snapshot.accounts.push({
    map_id: MAP_IDS.declaredAccount,
    ledger_ref: null,
    label: "Future operating account",
    disposition: "included",
    fields: {
      entity_assignment: { assessment: "confirmed", owner_value: MAP_IDS.declaredEntity },
      kind: { assessment: "confirmed", owner_value: "checking" },
      balance_role: { assessment: "confirmed", owner_value: "asset" },
      currency: { assessment: "confirmed", owner_value: "USD" },
      status: { assessment: "confirmed", owner_value: "never_connected" },
    },
  });
  return snapshot;
}

async function previewMap(fixture, snapshot, headers = ADMIN) {
  return json(await fixture.post(`${PREFIX}preview`, { snapshot }, headers));
}

async function reviewMap(fixture, headers) {
  return json(await fixture.post(`${APP_PREFIX}review`, {}, headers));
}

async function seedOwnerPasskey(fixture) {
  const credential = await makeCredential({ rpId: RP_ID });
  const jwk = await crypto.subtle.exportKey("jwk", credential.pair.publicKey);
  fixture.raw(
    `INSERT INTO owner_passkeys
       (credential_id,public_key_jwk,alg,sign_count,nickname,created_at,grant_id,document_grant_id)
     VALUES (?,?,-7,0,'Map test passkey',?,NULL,NULL)`,
    credential.credentialId, JSON.stringify(jwk), Date.now(),
  );
  const headers = await fixture.ownerHeaders({ credentialId: credential.credentialId });
  return { credential, headers };
}

async function activationBody(fixture, credential, headers, requestId, counter = 1) {
  const review = await reviewMap(fixture, headers);
  assert.equal(review.response.status, 200, JSON.stringify(review.body));
  const options = await json(await fixture.post(
    `${APP_PREFIX}passkey/options`, { review_id: review.body.review_id }, headers,
  ));
  assert.equal(options.response.status, 200, JSON.stringify(options.body));
  const challengeHash = createHash("sha256").update(options.body.challenge).digest("hex");
  const challenge = fixture.first(
    "SELECT purpose FROM auth_challenges WHERE challenge_hash = ?", challengeHash,
  );
  const receiptHash = review.body.review_id.slice("ofmp_".length);
  const preview = fixture.first(
    `SELECT map_hash,denominator_hash,expected_head_snapshot_id,expected_head_map_hash,expected_sequence_no
       FROM owner_financial_map_previews WHERE receipt_hash=?`,
    receiptHash,
  );
  assert.equal(challenge.purpose,
    `financial-map-activate:${receiptHash}:${preview.map_hash}:${preview.denominator_hash}:` +
      `${preview.expected_head_snapshot_id || "genesis"}:${preview.expected_head_map_hash || "genesis"}:` +
      `${preview.expected_sequence_no}`,
    "the fresh ceremony is bound to the map, denominator, and exact expected head",
  );
  const assertion = await signAssertion({
    pair: credential.pair,
    rpId: RP_ID,
    challenge: options.body.challenge,
    origin: ORIGIN,
    counter,
  });
  return {
    review_id: review.body.review_id,
    request_id: requestId,
    credentialId: credential.credentialId,
    ...assertion,
  };
}

function financialRows(fixture) {
  return JSON.stringify({
    entities: fixture.rows("SELECT * FROM fin_entities ORDER BY id").map((row) => ({ ...row })),
    accounts: fixture.rows("SELECT * FROM fin_accounts ORDER BY id").map((row) => ({ ...row })),
  });
}

test("a streaming map request without Content-Length is bounded before JSON parsing", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const chunk = new Uint8Array(600 * 1024);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request(`${ORIGIN}${PREFIX}read`, {
    method: "POST",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body,
    duplex: "half",
  });
  const result = await json(await fixture.worker.fetch(request, fixture.env, {
    waitUntil() {},
  }));
  assert.equal(result.response.status, 413);
  assert.equal(result.body.code, "owner_financial_map_request_too_large");
  assert.match(result.response.headers.get("cache-control"), /no-store/);
});

test("read and preview accept only the full admin or exact unscoped owner", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);

  const unauthenticated = await readMap(fixture, {});
  assert.equal(unauthenticated.response.status, 401);

  fixture.raw(
    `INSERT INTO grants
       (grant_id,display_name,capabilities,created_at,created_by,scope_include,scope_exclude)
     VALUES ('g_map_scoped','Scoped map reviewer','["administer"]',?,'owner','{"all":true}','[]')`,
    Date.now(),
  );
  const scopedHeaders = await fixture.ownerHeaders({
    grantId: "g_map_scoped",
    credentialId: "fixture-scoped-map-passkey",
  });
  assert.equal((await readMap(fixture, scopedHeaders)).response.status, 403,
    "a scoped passkey cannot widen into the whole-owner map");

  const ownerHeaders = await fixture.ownerHeaders({ credentialId: "fixture-map-owner-passkey" });
  const ownerRead = await readMap(fixture, ownerHeaders);
  assert.equal(ownerRead.response.status, 200, JSON.stringify(ownerRead.body));
  const ownerPreview = await previewMap(fixture, completeSubmission(ownerRead.body), ownerHeaders);
  assert.equal(ownerPreview.response.status, 200, JSON.stringify(ownerPreview.body));
  assert.equal(ownerPreview.body.authoritative, false);
  assert.equal(Object.hasOwn(ownerPreview.body, "preview_ref"), false);
  assert.equal(Object.hasOwn(ownerPreview.body, "review_id"), false,
    "MCP and admin preview output cannot carry the owner-app selector into chat");
  assert.equal(Object.hasOwn(ownerPreview.body, "map_hash"), false);
  assert.equal(Object.hasOwn(ownerPreview.body, "denominator_hash"), false);

  const ownerReview = await reviewMap(fixture, ownerHeaders);
  assert.match(ownerReview.body.review_id, /^ofmp_[a-f0-9]{64}$/);
  assert.equal((await fixture.post(
    `${APP_PREFIX}passkey/options`, { review_id: ownerReview.body.review_id }, ADMIN,
  )).status, 403, "the opaque selector cannot authorize an admin-key request");
  assert.equal((await fixture.post(
    `${APP_PREFIX}passkey/options`, { review_id: ownerReview.body.review_id }, {},
  )).status, 403, "the opaque selector cannot authorize a request without the app session boundary");

  assert.equal((await previewMap(fixture, completeSubmission(ownerRead.body), scopedHeaders)).response.status, 403);
  assert.equal((await reviewMap(fixture, scopedHeaders)).response.status, 403,
    "a scoped passkey cannot discover the whole-owner review");
  assert.equal((await reviewMap(fixture, ADMIN)).response.status, 403,
    "an admin key cannot discover the owner-app review");
  const noHeader = { Cookie: ownerHeaders.Cookie };
  assert.equal((await reviewMap(fixture, noHeader)).response.status, 403,
    "the owner cookie without the companion app header is insufficient");
});

test("an expired owner review fails before a passkey challenge exists", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);
  const read = (await readMap(fixture)).body;
  await previewMap(fixture, completeSubmission(read));
  const pending = fixture.first(
    "SELECT receipt_hash,created_at FROM owner_financial_map_previews WHERE state='previewed'",
  );
  const headers = await fixture.ownerHeaders({ credentialId: "fixture-expired-map-passkey" });
  const expiredNow = Number(pending.created_at) + 24 * 60 * 60 * 1000 + 1;
  const request = (path, body) => new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const review = await json(await handleOwnerFinancialMap(
    fixture.env, request(`${APP_PREFIX}review`, {}), `${APP_PREFIX}review`, { now: expiredNow },
  ));
  assert.equal(review.response.status, 410);
  assert.equal(review.body.code, "owner_financial_map_preview_expired");
  const options = await json(await handleOwnerFinancialMap(
    fixture.env,
    request(`${APP_PREFIX}passkey/options`, { review_id: `ofmp_${pending.receipt_hash}` }),
    `${APP_PREFIX}passkey/options`,
    { now: expiredNow },
  ));
  assert.equal(options.response.status, 410);
  assert.equal(fixture.first("SELECT count(*) AS n FROM auth_challenges").n, 0,
    "expiry is checked before the server begins a WebAuthn ceremony");
});

test("read and preview are closed, complete, private, and non-authoritative", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);
  const before = financialRows(fixture);

  const read = await readMap(fixture);
  assert.equal(read.response.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.map_status, "not_established");
  assert.equal(read.body.population_state, "unknown");
  assert.equal(read.body.current_inventory.entities[0].candidate_state, "possible_mention");
  assert.match(read.body.current_inventory.entities[0].entity_ref, /^[a-f0-9]{64}$/);
  assert.match(read.body.current_inventory.accounts[0].account_ref, /^[a-f0-9]{64}$/);
  assert.match(read.body.current_inventory.entities[0].suggested_map_id, /^ofme_[a-f0-9]{32}$/);
  assert.match(read.body.current_inventory.accounts[0].suggested_map_id, /^ofma_[a-f0-9]{32}$/);
  assert.equal(read.body.current_inventory.entities[0].label, "Example 8675309");
  assert.equal(read.body.current_inventory.accounts[0].label, "Operating 4242");
  const serializedRead = JSON.stringify(read.body);
  for (const privateValue of [
    "private-entity-8675309", "private-account-4242", "private-external-account-id",
    "private-entity-locator", "private-account-locator", '"mask":"4242"',
  ]) assert.equal(serializedRead.includes(privateValue), false, privateValue);

  const snapshot = completeSubmission(read.body, { assessment: "unknown", population_state: "known_partial" });
  const preview = await previewMap(fixture, snapshot);
  assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.authoritative, false);
  assert.equal(preview.body.activation_performed, false);
  assert.equal(preview.body.unresolved_count, 12);
  assert.equal(preview.body.review_available_in_owner_app, true);
  assert.equal(Object.hasOwn(preview.body, "complete_preview"), false,
    "admin and MCP preview output stays compact and cannot disclose the private map");
  assert.equal(Object.hasOwn(preview.body, "unresolved_items"), false);
  assert.equal(Object.hasOwn(preview.body, "preview_ref"), false);
  assert.equal(Object.hasOwn(preview.body, "review_id"), false);
  const serializedPreview = JSON.stringify(preview.body);
  for (const privateLabel of ["Example 8675309", "Operating 4242", "Form 1120-S"]) {
    assert.equal(serializedPreview.includes(privateLabel), false, `compact preview leaked ${privateLabel}`);
  }
  const storedPreview = fixture.first("SELECT snapshot_json FROM owner_financial_map_previews").snapshot_json;
  for (const privateValue of [
    "private-entity-8675309", "private-account-4242", "private-external-account-id",
    "private-entity-locator", "private-account-locator", '"mask":"4242"',
  ]) {
    assert.equal(serializedPreview.includes(privateValue), false, `preview leaked ${privateValue}`);
    assert.equal(storedPreview.includes(privateValue), false, `stored preview leaked ${privateValue}`);
  }
  assert.equal(financialRows(fixture), before);
  assert.equal(fixture.first("SELECT count(*) AS n FROM owner_financial_map_snapshots").n, 0);

  const ownerHeaders = await fixture.ownerHeaders({ credentialId: "fixture-map-review-passkey" });
  const review = await reviewMap(fixture, ownerHeaders);
  assert.equal(review.response.status, 200, JSON.stringify(review.body));
  assert.match(review.body.review_id, /^ofmp_[a-f0-9]{64}$/);
  assert.equal(review.body.complete_preview.entities.length, 1);
  assert.equal(review.body.complete_preview.entities[0].tax_years.length, 3);
  assert.equal(review.body.complete_preview.entities[0].evidence_state, "linked_current_record");
  assert.equal(review.body.complete_preview.entities[0].tax_years[0].required_returns.items.length, 1);
  assert.equal(review.body.complete_preview.entities[0].tax_years[0].required_returns.items[0].label,
    "Form 1120-S");
  assert.equal(review.body.complete_preview.accounts[0].label, "Operating 4242");
  assert.equal(review.body.unresolved_items.length, review.body.unresolved_count);
  assert.equal(review.body.requires, "explicit_owner_passkey_confirmation");
  assert.equal(review.body.expires_at - review.body.created_at, 24 * 60 * 60 * 1000);
  assert.deepEqual(review.body.prior_comparison, {
    state: "no_prior_confirmed_map", changed: null, change_count: 0, changes: [],
    previous_confirmed_map: null,
  });
  const serializedReview = JSON.stringify(review.body);
  for (const forbidden of [
    '"map_id"', '"ledger_ref"', '"entity_ref"', '"account_ref"', '"source_locator"',
    '"external_ref"', '"mask"', '"row_hash"', '"value_hash"',
    "private-entity-8675309", "private-account-4242", "private-external-account-id",
    "private-entity-locator", "private-account-locator",
  ]) assert.equal(serializedReview.includes(forbidden), false, `owner review leaked ${forbidden}`);

  const declared = await previewMap(fixture, addOwnerDeclaredRows(completeSubmission(read.body)));
  assert.equal(declared.response.status, 200, JSON.stringify(declared.body));
  assert.equal(Object.hasOwn(declared.body, "complete_preview"), false);
  const declaredReview = await reviewMap(fixture, ownerHeaders);
  assert.equal(declaredReview.response.status, 200, JSON.stringify(declaredReview.body));
  assert.equal(declaredReview.body.complete_preview.entities.length, 2);
  assert.equal(declaredReview.body.complete_preview.accounts.length, 2);
  const declaredEntity = declaredReview.body.complete_preview.entities.find((row) => row.label === "Future consulting company");
  const declaredAccount = declaredReview.body.complete_preview.accounts.find((row) => row.label === "Future operating account");
  assert.equal(declaredEntity.evidence_state, "owner_declared_no_current_record");
  assert.equal(declaredEntity.fields.kind.owner_value, "business");
  assert.equal(declaredEntity.fields.kind.current_value, null);
  assert.equal(declaredAccount.evidence_state, "owner_declared_no_current_record");
  assert.equal(declaredReview.body.unresolved_items.some((item) => item.kind === "entity_evidence"), true);
  assert.equal(declaredReview.body.unresolved_items.some((item) => item.kind === "expected_sources"), true);
  assert.equal(financialRows(fixture), before, "owner-declared denominator rows never create ledger rows");

  const adminOptions = await fixture.post(
    `${PREFIX}passkey/options`, { preview_ref: "retired-raw-reference" }, ADMIN,
  );
  assert.equal(adminOptions.status, 410, "the raw-reference options route is retired for every principal");
  const adminActivate = await fixture.post(
    `${PREFIX}activate`, { preview_ref: "retired-raw-reference", request_id: "admin-no-authority" }, ADMIN,
  );
  assert.equal(adminActivate.status, 410, "the raw-reference activation route is retired for every principal");
  assert.equal(fixture.first("SELECT count(*) AS n FROM auth_challenges").n, 0);
  assert.equal(financialRows(fixture), before);
});

test("full snapshots reject unknown fields, unknown enums, and missing current rows", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);
  const read = (await readMap(fixture)).body;

  const extra = completeSubmission(read);
  extra.surprise = true;
  const extraResult = await previewMap(fixture, extra);
  assert.equal(extraResult.response.status, 400);

  const unknown = completeSubmission(read);
  unknown.entities[0].fields.kind.assessment = "probably";
  const unknownResult = await previewMap(fixture, unknown);
  assert.equal(unknownResult.response.status, 400);

  const unknownField = completeSubmission(read);
  unknownField.accounts[0].fields.private_guess = "confirmed";
  const unknownFieldResult = await previewMap(fixture, unknownField);
  assert.equal(unknownFieldResult.response.status, 400);

  const unknownSource = completeSubmission(read);
  unknownSource.entities[0].tax_years[0].expected_sources.items[0].kind = "browser_magic";
  const unknownSourceResult = await previewMap(fixture, unknownSource);
  assert.equal(unknownSourceResult.response.status, 400);

  const semanticId = completeSubmission(read);
  semanticId.entities[0].map_id = "ofme_private_company_name_1234567890";
  const semanticIdResult = await previewMap(fixture, semanticId);
  assert.equal(semanticIdResult.response.status, 400, "local IDs must be opaque, not private labels");

  const conflictingStableId = completeSubmission(read);
  conflictingStableId.entities[0].tax_years[1].expected_sources.items[0].label = "Different source";
  const conflictingStableIdResult = await previewMap(fixture, conflictingStableId);
  assert.equal(conflictingStableIdResult.response.status, 400);
  assert.equal(conflictingStableIdResult.body.code, "owner_financial_map_obligation_identity_conflict");

  const unreferencedFilingUnit = completeSubmission(read);
  unreferencedFilingUnit.filing_units.push({
    map_id: `ofmf_${"a".repeat(32)}`, label: "Unassigned filing unit", assessment: "unknown",
  });
  const unreferencedResult = await previewMap(fixture, unreferencedFilingUnit);
  assert.equal(unreferencedResult.response.status, 400);
  assert.equal(unreferencedResult.body.code, "owner_financial_map_filing_unit_unreferenced");

  const missingEntity = completeSubmission(read);
  missingEntity.entities = [];
  const missingResult = await previewMap(fixture, missingEntity);
  assert.equal(missingResult.response.status, 409);
  assert.equal(missingResult.body.code, "owner_financial_map_inventory_changed");

  const missingAccount = completeSubmission(read);
  missingAccount.accounts = [];
  const missingAccountResult = await previewMap(fixture, missingAccount);
  assert.equal(missingAccountResult.response.status, 409);

  const missingYear = completeSubmission(read);
  missingYear.entities[0].tax_years.pop();
  const yearResult = await previewMap(fixture, missingYear);
  assert.equal(yearResult.response.status, 400);
  assert.equal(fixture.first("SELECT count(*) AS n FROM owner_financial_map_previews").n, 0);
});

test("owner labels and field text follow the advertised bounds without silent truncation", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);
  const read = (await readMap(fixture)).body;

  const longLabel = completeSubmission(read);
  longLabel.entities[0].label = "x".repeat(161);
  assert.equal((await previewMap(fixture, longLabel)).response.status, 400);

  const longField = completeSubmission(read);
  longField.entities[0].fields.holds = { assessment: "confirmed", owner_value: "y".repeat(241) };
  assert.equal((await previewMap(fixture, longField)).response.status, 400);

  const exactField = completeSubmission(read);
  exactField.entities[0].fields.holds = { assessment: "confirmed", owner_value: "z".repeat(240) };
  const accepted = await previewMap(fixture, exactField);
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  assert.equal(Object.hasOwn(accepted.body, "complete_preview"), false);
  const headers = await fixture.ownerHeaders({ credentialId: "fixture-long-field-passkey" });
  const review = await reviewMap(fixture, headers);
  assert.equal(review.body.complete_preview.entities[0].fields.holds.owner_value, "z".repeat(240));

  fixture.raw("UPDATE fin_accounts SET label=? WHERE account_slug='private-account-4242'", "q".repeat(161));
  const overlongCurrentLabel = await readMap(fixture);
  assert.equal(overlongCurrentLabel.response.status, 503,
    "an overlong current label fails closed instead of showing a truncated owner review");
});

test("a fresh owner passkey activates once without changing financial records", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);
  const before = financialRows(fixture);
  const read = (await readMap(fixture)).body;
  await previewMap(fixture, addOwnerDeclaredRows(completeSubmission(read)));
  const { credential, headers } = await seedOwnerPasskey(fixture);
  const body = await activationBody(fixture, credential, headers, "map-activation-1");

  const activated = await json(await fixture.post(`${APP_PREFIX}activate`, body, headers));
  assert.equal(activated.response.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.activated, true);
  assert.equal(activated.body.replayed, false);
  assert.equal(activated.body.sequence, 1);
  assert.deepEqual(activated.body.counts, {
    entities: 2, accounts: 2, entity_years: 6, filing_units: 1, obligation_items: 15,
  });
  assert.deepEqual(activated.body.mutations, {
    owner_financial_map_snapshot: "appended",
    ledger: "none", sources: "none", taxes: "none", books: "none",
    payroll: "none", accounts: "none",
  });
  assert.equal(activated.body.request_id, body.request_id);
  const reviewed = fixture.first(
    "SELECT map_hash,denominator_hash,expected_sequence_no FROM owner_financial_map_previews WHERE receipt_hash=?",
    body.review_id.slice("ofmp_".length),
  );
  assert.equal(activated.body.map_hash, reviewed.map_hash);
  assert.equal(activated.body.denominator_hash, reviewed.denominator_hash);
  assert.equal(activated.body.sequence, reviewed.expected_sequence_no);
  assert.equal(financialRows(fixture), before);
  assert.equal(fixture.first("SELECT count(*) AS n FROM owner_financial_map_snapshots").n, 1);
  assert.equal(fixture.first("SELECT count(*) AS n FROM auth_challenges").n, 0);

  const replay = await json(await fixture.post(`${APP_PREFIX}activate`, body, headers));
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body, { ...activated.body, replayed: true });
  assert.equal(JSON.stringify(activated.body).includes("ofm_"), false,
    "the owner receipt contains no snapshot or review identifier");
  assert.equal(fixture.first("SELECT count(*) AS n FROM owner_financial_map_snapshots").n, 1);

  const altered = await fixture.post(`${APP_PREFIX}activate`, { ...body, request_id: "map-activation-2" }, headers);
  assert.equal(altered.status, 409);
  const current = await readMap(fixture);
  assert.equal(current.body.map_status, "current");
  assert.equal(current.body.population_state, "owner_asserted_complete");

  const remapped = completeSubmission(current.body);
  remapped.accounts[0].map_id = `ofma_${"9".repeat(32)}`;
  const remappedResult = await previewMap(fixture, remapped);
  assert.equal(remappedResult.response.status, 409);
  assert.equal(remappedResult.body.code, "owner_financial_map_local_id_changed");

  fixture.env.SESSION_SIGNING_KEY = "rotated-session-key-only-invalidates-sessions";
  const afterSessionRotation = await readMap(fixture);
  assert.equal(afterSessionRotation.response.status, 200, JSON.stringify(afterSessionRotation.body));
  assert.match(afterSessionRotation.body.current_head.snapshot_ref, /^ofm_/,
    "session-key rotation cannot destroy durable map verification");
});

test("inventory and head changes invalidate stale previews", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);
  const read = (await readMap(fixture)).body;
  const snapshot = completeSubmission(read);
  await previewMap(fixture, snapshot);
  const firstReceipt = fixture.first("SELECT receipt_hash FROM owner_financial_map_previews WHERE state='previewed'").receipt_hash;
  await previewMap(fixture, snapshot);
  assert.equal(fixture.first("SELECT state FROM owner_financial_map_previews WHERE receipt_hash=?", firstReceipt).state, "invalidated");
  assert.equal(fixture.first("SELECT count(*) AS n FROM owner_financial_map_previews WHERE state='previewed'").n, 1,
    "the newest preview supersedes the earlier pending preview");
  const { credential, headers } = await seedOwnerPasskey(fixture);
  const bodyA = await activationBody(fixture, credential, headers, "map-head-a", 1);
  const activated = await fixture.post(`${APP_PREFIX}activate`, bodyA, headers);
  assert.equal(activated.status, 200);

  const noPending = await reviewMap(fixture, headers);
  assert.equal(noPending.response.status, 200);
  assert.equal(noPending.body.status, "no_pending_review");
  assert.equal(noPending.body.active_map_present, true);
  assert.equal(noPending.body.active_map_authoritative, true);
  assert.equal(noPending.body.active_sequence, 1);
  assert.equal(noPending.body.active_map_hash, fixture.first(
    "SELECT map_hash FROM owner_financial_map_snapshots WHERE sequence_no=1",
  ).map_hash);

  const currentRead = (await readMap(fixture)).body;
  const changedMap = completeSubmission(currentRead);
  changedMap.entities[0].fields.tax_class.owner_value = "C corporation";
  await previewMap(fixture, changedMap);
  const changedReview = await reviewMap(fixture, headers);
  assert.equal(changedReview.body.prior_comparison.state, "compared");
  assert.equal(changedReview.body.prior_comparison.changed, true);
  assert.equal(changedReview.body.prior_comparison.changes.some((change) =>
    change.subject === "Example 8675309" && change.field === "tax class" &&
    change.before.includes("S corporation") && change.after.includes("C corporation")), true,
  "the app compares the pending map with the last owner-confirmed map");
  assert.equal(changedReview.body.prior_comparison.previous_confirmed_map.accounts[0].label,
    "Operating 4242");
  assert.equal(JSON.stringify(changedReview.body.prior_comparison).includes("ofm_"), false);

  await previewMap(fixture, completeSubmission(currentRead));
  const inventoryReview = (await reviewMap(fixture, headers)).body;
  fixture.raw("UPDATE fin_accounts SET status='closed' WHERE superseded_by_id IS NULL");
  const staleInventory = await json(await fixture.post(
    `${APP_PREFIX}passkey/options`, { review_id: inventoryReview.review_id }, headers,
  ));
  assert.equal(staleInventory.response.status, 409);
  assert.equal(staleInventory.body.code, "owner_financial_map_preview_stale");
  assert.equal(fixture.first(
    "SELECT state FROM owner_financial_map_previews WHERE receipt_hash = (SELECT receipt_hash FROM owner_financial_map_previews ORDER BY created_at DESC LIMIT 1)",
  ).state, "invalidated");
});

test("immutable storage and integrity failures fail closed", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedInventory(fixture);
  const read = (await readMap(fixture)).body;
  await previewMap(fixture, completeSubmission(read));
  const { credential, headers } = await seedOwnerPasskey(fixture);
  const body = await activationBody(fixture, credential, headers, "map-integrity", 1);
  assert.equal((await fixture.post(`${APP_PREFIX}activate`, body, headers)).status, 200);

  assert.throws(
    () => fixture.raw("UPDATE owner_financial_map_snapshots SET snapshot_json='{}'"),
    /append-only/,
  );
  assert.throws(
    () => fixture.raw("DELETE FROM owner_financial_map_snapshots"),
    /append-only/,
  );
  assert.throws(
    () => fixture.raw("UPDATE owner_financial_map_key_state SET signing_salt=?", "0".repeat(64)),
    /immutable/,
  );

  fixture.raw(
    `INSERT INTO owner_financial_map_snapshots
       (snapshot_id,tenant_id,sequence_no,previous_snapshot_id,previous_map_hash,
        contract_version,snapshot_json,map_hash,denominator_hash,inventory_hash,
        inventory_generation,population_state,tax_year_start,tax_year_end,
        entity_count,account_count,entity_year_count,filing_unit_count,obligation_count,
        snapshot_seal,credential_ref,
        request_id,request_hash,activated_at)
     SELECT 'ofm_direct_child_aaaaaaaa','primary',2,snapshot_id,map_hash,
            contract_version,snapshot_json,map_hash,denominator_hash,inventory_hash,
            inventory_generation,population_state,tax_year_start,tax_year_end,
            entity_count,account_count,entity_year_count,filing_unit_count,obligation_count,
            snapshot_seal,credential_ref,
            'direct-child-one',request_hash,activated_at+1
       FROM owner_financial_map_snapshots WHERE sequence_no=1`,
  );
  assert.throws(
    () => fixture.raw(
      `INSERT INTO owner_financial_map_snapshots
         (snapshot_id,tenant_id,sequence_no,previous_snapshot_id,previous_map_hash,
          contract_version,snapshot_json,map_hash,denominator_hash,inventory_hash,
          inventory_generation,population_state,tax_year_start,tax_year_end,
          entity_count,account_count,entity_year_count,filing_unit_count,obligation_count,
          snapshot_seal,credential_ref,
          request_id,request_hash,activated_at)
       SELECT 'ofm_direct_fork_bbbbbbbb','primary',3,previous_snapshot_id,previous_map_hash,
              contract_version,snapshot_json,map_hash,denominator_hash,inventory_hash,
              inventory_generation,population_state,tax_year_start,tax_year_end,
              entity_count,account_count,entity_year_count,filing_unit_count,obligation_count,
              snapshot_seal,credential_ref,
              'direct-child-two',request_hash,activated_at+2
         FROM owner_financial_map_snapshots WHERE sequence_no=2`,
    ),
    /UNIQUE constraint failed/,
    "the storage contract refuses a second child of the same head",
  );
  fixture.raw("DROP TRIGGER owner_financial_map_snapshots_no_update");
  fixture.raw("UPDATE owner_financial_map_snapshots SET snapshot_json='{}'");
  const tampered = await readMap(fixture);
  assert.equal(tampered.response.status, 503);
  assert.equal(tampered.body.code, "owner_financial_map_unavailable");
});

test("missing structured state and unknown current enums fail closed", async (t) => {
  const missing = await createProductFixture();
  t.after(() => missing.close());
  missing.raw("DROP TABLE owner_financial_map_inventory_state");
  assert.equal((await readMap(missing)).response.status, 503);

  const unknown = await createProductFixture();
  t.after(() => unknown.close());
  seedInventory(unknown);
  unknown.raw("PRAGMA ignore_check_constraints=ON");
  unknown.raw("UPDATE fin_accounts SET account_kind='unknown_kind'");
  assert.equal((await readMap(unknown)).response.status, 503);
});
