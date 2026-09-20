import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createProductFixture,
  json,
  seedCounterparty,
  seedOwnedEntity,
} from "./product-contract-fixture.mjs";
import {
  FINANCIAL_PICTURE_SECTIONS,
  assertFinancialPicturePublicReceipt,
  financialPictureInventory,
} from "../src/lib/financial-picture.js";

const PATH = "/api/fin/financial-picture";
const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const HASH = "a".repeat(64);
const MODULE_SOURCE = readFileSync(
  new URL("../src/lib/financial-picture.js", import.meta.url),
  "utf8",
);

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function provenanceMeta(source, sourceId, extra = {}) {
  const roots = [`${source}:${sourceId}`];
  return JSON.stringify({
    ...extra,
    evidence_lineage: { version: 1, kind: "source_record", root_ids: roots },
    provenance_receipt: {
      version: 1,
      status: "complete",
      reason: "lineage_and_text_recorded",
      root_ids: roots,
    },
  });
}

function seedFinancialPicture(fixture) {
  seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
  seedCounterparty(fixture, "orchard-landlord");
  fixture.raw(
    `INSERT INTO fin_entities
       (tenant_id, entity_slug, legal_name, display_label, kind, status, relationship,
        parent_entity_slug, ownership_bp, tax_class, provenance, source_feed, basis_state, recorded_at)
     VALUES ('primary', 'owner-person', 'Pat Example', 'Pat', 'person', 'active', 'owned',
             NULL, 10000, 'individual', 'feed', 'owner-profile', 'confirmed', '2026-09-01T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_entities
       (tenant_id, entity_slug, legal_name, display_label, kind, status, relationship,
        provenance, source_doc_uid, source_locator, basis_state, unparsed_reason, recorded_at)
     VALUES ('primary', 'client-mentioned-in-a-document', 'Unrelated Client LLC',
             'Unrelated Client', 'business', 'active', 'owned', 'extracted',
             'mention-source-doc', 'page 1', 'unparsed', 'entity role was not established',
             '2026-09-01T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid, source, source_id, title, ingested_at, content_hash, meta, entity_slug)
     VALUES ('unrelated-corpus-doc', 'upload', 'unrelated-source-id',
             'A vendor and employer mentioned here are not owner entities', 1756944000000,
             'unrelated-content-hash', '{}', NULL)`,
  );
  fixture.raw(
    `INSERT INTO fin_accounts
       (tenant_id, account_slug, entity_slug, institution, label, account_kind, balance_role,
        mask, currency, feed_mode, expected_cadence, status, external_ref, provenance,
        source_feed, basis_state, recorded_at)
     VALUES ('primary', 'orchard-operating', 'orchard-cafe',
             'Fixture Bank 1234-5678-9012 fullwidth １２３４ arabic ١٢٣٤',
             'Operating 987654321', 'checking', 'asset', '4321', 'USD', 'live', 'daily',
             'open', 'raw-account-987654321', 'feed',
             'bank-feed:provider-item-sentinel-334455', 'confirmed',
             '2026-09-01T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_accounts
       (tenant_id, account_slug, entity_slug, institution, label, account_kind, balance_role,
        mask, currency, feed_mode, status, provenance, basis_state, recorded_at)
     VALUES ('primary', 'orchard-card', 'orchard-cafe', 'Fixture Card', 'Card 123456789',
             'card', 'liability', '6789', 'USD', 'manual', 'open', 'owner_stated',
             'confirmed', '2026-09-01T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_account_coverage
       (tenant_id, account_slug, coverage_status, covered_from, covered_to, computed_at,
        provenance, source_feed, basis_state, recorded_at)
     VALUES ('primary', 'orchard-operating', 'partial', '2025-01-01', '2025-12-31',
             '2026-09-01T00:00:00Z', 'feed', 'plaid-fixture', 'confirmed',
             '2026-09-01T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO sources
       (name, kind, status, created_at, last_ingest_at, document_count)
     VALUES ('quickbooks-fixture', 'quickbooks', 'ready', '2026-09-01T00:00:00Z',
             '2026-09-04T00:00:00Z', 1),
            ('plaid-fixture', 'plaid', 'ready', '2026-09-01T00:00:00Z',
             '2026-09-04T00:00:00Z', 2),
            ('tax-archive', 'upload', 'ready', '2026-09-01T00:00:00Z',
             '2026-09-04T00:00:00Z', 1),
            ('owner-profile', 'owner', 'ready', '2026-09-01T00:00:00Z',
             '2026-09-04T00:00:00Z', 0)`,
  );
  fixture.raw(
    `INSERT INTO documents
     (doc_uid, source, source_id, title, ingested_at, content_hash, meta, entity_slug,
        text_source, text_reliable)
     VALUES ('gmail:provider-message-sentinel-445566', 'quickbooks-fixture', 'resolved-source-reference',
             'Resolved provenance fixture', 1756944000000, 'source-reference-content-hash',
             ?, 'orchard-cafe', 'native', 1)`,
    provenanceMeta("quickbooks-fixture", "resolved-source-reference"),
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid, source, source_id, title, document_date, date_source, date_reliable,
        ingested_at, content_hash, meta, entity_slug, text_source, text_reliable)
     VALUES ('corpus-qbo-report', 'quickbooks-fixture', 'report-raw-system-id',
             'Private books report', 1735603200000, 'provider', 1, 1756944000000,
             'fixture-content-hash', ?, 'orchard-cafe', 'ocr_partial', 0)`,
    provenanceMeta("quickbooks-fixture", "report-raw-system-id", {
      qbo_company_fingerprint: HASH,
      raw_realm_id: "realm-must-not-leak",
    }),
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid, source, source_id, title, document_date, date_source, date_reliable,
        ingested_at, content_hash, meta, entity_slug, text_source, text_reliable)
     VALUES ('corpus-tax-return', 'tax-archive', 'tax-provider-private-id',
             'Private native tax return', 1735603200000, 'document', 1,
             1756944000000, 'tax-content-hash', ?, 'orchard-cafe', 'native', 1)`,
    provenanceMeta("tax-archive", "tax-provider-private-id"),
  );
  fixture.raw(
    `INSERT INTO fin_documents
       (tenant_id, fin_doc_uid, entity_slug, account_slug, doc_kind, title, tax_year,
        period_start, period_end, custody_class, availability, filed_at,
        reconciled_through, received_from, received_at, corpus_doc_uid, content_hash,
        readable, restricted, provenance, source_doc_uid, source_locator, source_feed,
        basis_state, recorded_at)
     VALUES ('primary', 'private-fin-doc-id', 'orchard-cafe', 'orchard-operating',
             'profit_and_loss', 'P and L with private identifier 11223344', 2024,
             '2024-01-01', '2024-12-31', 'reconcilable', 'have_it', '2026-09-02',
             '2024-12-31', 'accountant', '2026-09-02T00:00:00Z', 'corpus-qbo-report',
             'book-content-hash', 1, 0, 'extracted', 'gmail:provider-message-sentinel-445566',
             'private page and line locator', 'quickbooks-fixture', 'confirmed',
             '2026-09-02T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_documents
       (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, tax_year, period_start,
        period_end, custody_class, availability, filed_at, received_from, received_at,
        corpus_doc_uid, readable, restricted, provenance, source_feed, basis_state, recorded_at)
     VALUES ('primary', 'tax-return-private-id', 'orchard-cafe', 'tax_return',
             'Filed Form with taxpayer identifier', 2024, '2024-01-01', '2024-12-31',
             'reference', 'have_it', '2025-03-15', 'accountant',
             '2025-03-15T00:00:00Z', 'corpus-tax-return', 1, 1, 'feed', 'tax-archive', 'confirmed',
             '2025-03-15T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_documents
       (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, tax_year, period_start,
        period_end, custody_class, availability, filed_at, readable, restricted,
        provenance, source_doc_uid, source_locator, basis_state, recorded_at)
     VALUES ('primary', 'k1-private-id', 'orchard-cafe', 'k1',
             'Schedule K-1 issuer name must not become a role', 2024,
             '2024-01-01', '2024-12-31', 'reference', 'have_it', '2025-03-15',
             1, 0, 'extracted', 'k1-source-doc', 'schedule k-1 page 1', 'confirmed',
             '2025-03-15T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_documents
       (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, tax_year, custody_class,
        availability, filed_at, readable, unreadable_reason, restricted, provenance, source_feed, basis_state,
        recorded_at)
     VALUES ('primary', 'payment-private-id', 'orchard-cafe', 'estimated_payment_receipt',
             'Payment receipt with confirmation 998877', 2025, 'reference', 'have_it',
             '2025-06-15', 0, 'image could not be read', 0, 'feed', 'tax-archive', 'confirmed',
             '2025-06-15T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_reconciliations
       (tenant_id, reconciliation_uid, entity_slug, account_slug, period_start, period_end,
        measure, state, delta_minor, tolerance_minor, currency, computed_at, recorded_at)
     VALUES ('primary', 'private-reconciliation-id', 'orchard-cafe', 'orchard-operating',
             '2024-01-01', '2024-12-31', 'period_receipts', 'mismatched', 125, 0,
             'USD', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_reconciliation_claims
       (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency, as_of,
        claim_ref_table, claim_ref_uid, provenance, source_doc_uid, source_locator,
        basis_state, recorded_at)
     VALUES ('primary', 'claim-private-id', 'private-reconciliation-id', 'filed return',
             50000, 'USD', '2024-12-31', 'fin_transactions',
             'orchard-operating:id:provider-transaction-sentinel-778899',
             'extracted', 'gmail:provider-message-sentinel-445566', 'private page and line locator',
             'confirmed', '2026-09-03T00:00:00Z')`,
  );
  fixture.raw(
    `INSERT INTO fin_exceptions
       (tenant_id, exception_uid, entity_slug, kind, issue, first_seen, provenance,
        source_feed, basis_state, recorded_at)
     VALUES ('primary', 'private-exception-id', 'orchard-cafe', 'missing_statement',
             'Private issue description', '2026-09-03', 'feed', 'plaid-fixture',
             'confirmed', '2026-09-03T00:00:00Z')`,
  );
}

test("owner/admin financial inventory is bounded, private, read-only, and honest about gaps", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    const before = JSON.stringify({
      entities: fixture.rows("SELECT * FROM fin_entities ORDER BY id"),
      accounts: fixture.rows("SELECT * FROM fin_accounts ORDER BY id"),
      documents: fixture.rows("SELECT * FROM fin_documents ORDER BY id"),
      reconciliations: fixture.rows("SELECT * FROM fin_reconciliations ORDER BY id"),
      exceptions: fixture.rows("SELECT * FROM fin_exceptions ORDER BY id"),
    });
    fixture.seen.sql.length = 0;
    fixture.seen.binds.length = 0;

    const { response, body } = await json(await fixture.post(PATH, { limit: 25 }, ADMIN));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /private.*no-store/);
    assert.equal(body.schema_version, 2);
    assert.equal(body.operation, "financial_picture.inventory");
    assert.equal(body.read_only, true);
    assert.equal(body.mutation_count, 0);
    assert.equal(body.completeness_verdict, "not_computed");
    assert.equal(body.correctness_verdict, "not_computed");
    assert.equal(body.snapshot.consistency, "single_d1_batch");
    assert.match(body.snapshot.content_sha256, /^[a-f0-9]{64}$/);
    assert.match(body.snapshot.captured_at, /^2026-|^20\d\d-/);
    assert.equal(body.snapshot.as_of, body.snapshot.captured_at);
    assert.deepEqual(body.filters, {
      entity_slug: null, tax_year: null, period_start: null, period_end: null,
    });
    assert.equal(body.recovery_mode, "planning_only_no_ocr_reingest_or_write");
    assert.equal(body.freshness_state_contract.verdict, "not_computed");
    assert.deepEqual(body.extraction_state_contract.unavailable_states, ["scan_only", "empty"]);

    for (const name of [
      "entities", "periods", "accounts", "books", "payroll", "tax_returns",
      "filing_payments", "evidence", "conflicts",
    ]) {
      const section = body.sections[name];
      assert.ok(section, `${name} must always have an explicit section envelope`);
      for (const field of ["total", "returned", "truncated", "cursor", "next_cursor", "unavailable", "unavailable_reason"]) {
        assert.ok(Object.hasOwn(section, field), `${name} must name ${field}`);
      }
      assert.equal(section.real_world_completeness, "not_proven");
      assert.ok(section.applied_filters && Array.isArray(section.not_applicable_filters));
      assert.ok(section.verification_gap_summary, `${name} must carry a bounded gap summary`);
      assert.equal(section.verification_gap_summary.bounded_by_page_limit, true);
    }
    assert.equal(body.sections.payroll.unavailable, true);
    assert.equal(body.sections.payroll.state, "unavailable");
    assert.equal(body.sections.payroll.unavailable_reason, "payroll_registry_unavailable");
    assert.equal(Object.hasOwn(body.sections.payroll, "records"), false);
    assert.equal(body.sections.entities.state, "partial");
    assert.ok(body.sections.entities.unavailable_fields.includes("filing_unit_designation"));
    assert.ok(body.sections.tax_returns.unavailable_fields.includes("tax_form"));
    assert.ok(body.sections.tax_returns.unavailable_fields.includes("k1_issuer_or_recipient_role"));
    for (const name of [
      "entities", "periods", "accounts", "books", "tax_returns",
      "filing_payments", "evidence", "conflicts",
    ]) {
      const fields = body.sections[name].provenance_fields;
      assert.ok(fields.includes("source_document_ref"));
      assert.ok(fields.includes("source_document_reference_state"));
      assert.ok(fields.includes("source_feed_ref"));
      assert.ok(fields.includes("source_feed_registry_state"));
      assert.ok(fields.includes("linked_corpus_source_ref"));
      assert.ok(fields.includes("linked_corpus_source_kind"));
      assert.equal(fields.includes("source_doc_uid"), false);
      assert.equal(fields.includes("source_feed"), false);
      assert.equal(fields.includes("linked_corpus_source"), false);
    }

    const entity = body.sections.entities.records.find(
      (row) => row.stored_name.legal_name === "Orchard Cafe LLC",
    );
    assert.equal(entity.stored_name.legal_name, "Orchard Cafe LLC");
    assert.equal(entity.material_fields.relationship.stored_value, "owned");
    assert.deepEqual(Object.keys(entity.material_fields).sort(), [
      "holds", "kind", "ownership_basis_points", "relationship", "status", "tax_class",
    ]);
    for (const [field, assessment] of Object.entries(entity.material_fields)) {
      assert.equal(assessment.confirmed_by_owner, null, field);
      assert.equal(assessment.owner_actor_receipt_present, false, field);
      assert.notEqual(assessment.confirmation_state, "owner_confirmed", field);
      assert.ok(assessment.missing_fields.length > 0, field);
    }
    assert.equal(entity.ownership_confirmed, null);
    assert.equal(entity.scope_state, "stored_owner_assertion_unconfirmed");
    assert.equal(entity.scope_confirmation.relationship_confirmed_by_owner, null);
    assert.equal(entity.scope_confirmation.stored_owner_assertion, true);
    assert.equal(entity.scope_confirmation.owner_actor_receipt_present, false);
    assert.ok(entity.scope_confirmation.missing_fields.includes("relationship_current_owner_confirmation"));
    const ownerProfileEntity = body.sections.entities.records.find(
      (row) => row.stored_name.legal_name === "Pat Example",
    );
    assert.match(ownerProfileEntity.source_lineage.source_feed_ref,
      /^source_feed_v2_[a-f0-9]{64}$/);
    assert.equal(ownerProfileEntity.source_lineage.source_feed_kind, null);
    assert.equal(ownerProfileEntity.source_lineage.source_feed_kind_state,
      "unavailable_or_unrecognized");
    assert.equal(ownerProfileEntity.source_lineage.source_feed_registry_state, "resolved");
    const documentMention = body.sections.entities.records.find(
      (row) => row.stored_name.legal_name === "Unrelated Client LLC",
    );
    assert.equal(documentMention.ownership_confirmed, null);
    assert.equal(documentMention.scope_state, "possible_mention");
    assert.equal(documentMention.source_lineage.status_code, "incomplete");
    assert.ok(documentMention.source_lineage.reason_codes.includes("basis_unparsed"));
    assert.equal(documentMention.source_lineage.unparsed_reason, "entity role was not established");
    assert.equal(documentMention.scope_confirmation.ownership_confirmed, null);
    assert.equal(
      body.sections.entities.records.some((row) => /vendor|employer/i.test(row.stored_name?.legal_name || "")),
      false,
      "an unstructured document mention must never become an owner entity",
    );
    const account = body.sections.accounts.records.find((row) => row.masked_identity.endsWith("4321"));
    assert.match(account.account_ref, /^acct_v2_[a-f0-9]{64}$/);
    assert.equal(account.category, "bank");
    assert.equal(/[0-9]/.test(account.institution), false, "free-form institution text must expose no digits");
    assert.equal(/\p{Decimal_Number}/u.test(account.institution), false,
      "free-form institution text must expose no Unicode decimal digits");
    assert.equal(account.entity_ref, entity.entity_ref);
    assert.equal(account.coverage.covered_from, "2025-01-01");
    assert.equal(account.coverage.covered_to, "2025-12-31");
    const qbo = body.sections.books.records.find((row) => row.record_type === "quickbooks_company_observation");
    assert.equal(qbo.system_identity.kind, "quickbooks_company_reference");
    assert.match(qbo.system_identity.ref, /^quickbooks_company_v2_[a-f0-9]{64}$/);
    assert.notEqual(qbo.system_identity.ref, HASH);
    assert.equal(qbo.entity_ref, entity.entity_ref);
    assert.equal(qbo.verification.extraction.state, "ocr_partial");
    assert.equal(qbo.verification.blocks_financial_verification, true);
    assert.equal(qbo.verification.freshness.current_or_stale, null);
    assert.equal(qbo.verification.freshness.source_status, "ready");
    assert.equal(qbo.verification.freshness.source_last_ingest_at, "2026-09-04T00:00:00Z");
    assert.ok(qbo.verification.missing_freshness_fields.includes("freshness_evaluation_policy"));
    const exactEntityPeriod = body.sections.periods.records.find((row) =>
      row.entity_ref === entity.entity_ref && row.tax_year === 2024 &&
      row.period_start === "2024-01-01" && row.period_end === "2024-12-31");
    assert.ok(exactEntityPeriod, "stored entity and period mapping must remain exact");
    assert.equal(exactEntityPeriod.verification.blocks_financial_verification, true);
    assert.ok(exactEntityPeriod.verification.missing_verification_fields.includes("freshness_applicability"));
    const yearOnly = body.sections.periods.records.find((row) =>
      row.entity_ref === entity.entity_ref && row.tax_year === 2024 &&
      row.period_kind === "tax_year");
    assert.equal(yearOnly.period_start, null);
    assert.equal(yearOnly.period_end, null, "a stored tax year must not invent a calendar accounting period");
    assert.equal(body.sections.tax_returns.records[0].tax_year, 2024);
    assert.equal(
      body.sections.tax_returns.records.find((row) => row.evidence_kind === "k1")
        .k1_issuer_or_recipient_role,
      null,
      "a K-1 title must not be used to infer issuer or recipient role",
    );
    assert.equal(
      body.sections.tax_returns.records.find((row) => row.evidence_kind === "tax_return")
        .verification.extraction.state,
      "native",
    );
    assert.equal(
      body.sections.filing_payments.records.find((row) => row.evidence_kind === "estimated_payment_receipt")
        .verification.extraction.state,
      "unreadable",
    );
    assert.equal(body.sections.books.verification_gap_summary.by_extraction_state.ocr_partial > 0, true);
    assert.equal(body.sections.books.verification_gap_summary.affected > 0, true);
    assert.equal(body.sections.books.verification_gap_summary.blocking > 0, true);
    assert.equal(
      body.sections.books.verification_gap_summary.by_freshness_state
        .timestamps_available_assessment_not_computed > 0,
      true,
    );
    assert.equal(body.sections.filing_payments.records.some((row) => row.evidence_kind === "estimated_payment_receipt"), true);
    assert.equal(body.sections.evidence.records.some((row) => row.current_state === "current"), true);
    assert.equal(body.sections.conflicts.records.some((row) => row.conflict_type === "reconciliation"), true);
    const reconciliation = body.sections.conflicts.records.find(
      (row) => row.conflict_type === "reconciliation",
    );
    const derivationRoot = reconciliation.conflict_derivation_basis.derivation_roots[0];
    assert.match(derivationRoot.source_document_ref, /^source_document_v2_[a-f0-9]{64}$/);
    assert.equal(derivationRoot.source_document_present, true);
    assert.equal(derivationRoot.source_document_reference_state, "resolved");
    assert.equal(
      derivationRoot.claim_target_kind,
      "transaction",
    );
    assert.match(
      derivationRoot.claim_record_ref,
      /^claim_record_v2_[a-f0-9]{64}$/,
    );
    assert.deepEqual(
      body.sections.conflicts.records.find((row) => row.conflict_type === "reconciliation")
        .derivation_root_page,
      { total: 1, returned: 1, truncated: false, cursor: null, unavailable_reason: null },
    );

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "raw-account-987654321", "Operating 987654321", "Card 123456789",
      "1234-5678-9012",
      "１２３４", "١٢٣٤",
      "realm-must-not-leak", "report-raw-system-id",
      "gmail:provider-message-sentinel-445566",
      "bank-feed:provider-item-sentinel-334455",
      "quickbooks-fixture", "plaid-fixture", "tax-archive", "owner-profile",
      "mention-source-doc", "k1-source-doc",
      "provider-transaction-sentinel-778899",
      "orchard-operating:id:provider-transaction-sentinel-778899",
      "tax-return-private-id",
      "payment-private-id", "private-reconciliation-id", "private-exception-id",
      "Private issue description", "taxpayer identifier", "confirmation 998877",
      "private page and line locator",
    ]) assert.equal(serialized.includes(forbidden), false, `must not expose ${forbidden}`);
    assert.doesNotMatch(serialized, /"(?:source_doc_uid|source_feed|linked_corpus_source)":/);
    const booksEvidence = body.sections.books.records.find(
      (row) => row.record_type === "books_document_evidence",
    );
    assert.match(booksEvidence.source_provenance.source_document_ref,
      /^source_document_v2_[a-f0-9]{64}$/);
    assert.equal(booksEvidence.source_provenance.source_document_present, true);
    assert.equal(booksEvidence.source_provenance.source_document_reference_state, "resolved");
    assert.equal(booksEvidence.source_provenance.source_locator_present, true);
    assert.match(booksEvidence.source_provenance.source_locator_ref,
      /^source_locator_v2_[a-f0-9]{64}$/);
    assert.equal(booksEvidence.source_provenance.provenance_state, "document_cited");
    assert.equal(
      booksEvidence.source_provenance.source_document_ref,
      derivationRoot.source_document_ref,
      "one private document id must produce the same stable non-disclosing reference",
    );
    assert.match(account.source_lineage.source_feed_ref, /^source_feed_v2_[a-f0-9]{64}$/);
    assert.equal(account.source_lineage.source_feed_present, true);
    assert.equal(account.source_lineage.source_feed_kind, null);
    assert.equal(account.source_lineage.source_feed_registry_state, "unresolved");
    assert.equal(qbo.source_lineage.source_feed_kind, "quickbooks");
    assert.equal(qbo.source_lineage.source_feed_registry_state, "resolved");

    assert.equal(JSON.stringify({
      entities: fixture.rows("SELECT * FROM fin_entities ORDER BY id"),
      accounts: fixture.rows("SELECT * FROM fin_accounts ORDER BY id"),
      documents: fixture.rows("SELECT * FROM fin_documents ORDER BY id"),
      reconciliations: fixture.rows("SELECT * FROM fin_reconciliations ORDER BY id"),
      exceptions: fixture.rows("SELECT * FROM fin_exceptions ORDER BY id"),
    }), before, "the inventory must not mutate the ledger");
    assert.equal(
      fixture.seen.sql.some((sql) => /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)),
      false,
      "the route may issue only read statements",
    );
  } finally {
    fixture.close();
  }
});

test("the public receipt contract recursively rejects unknown and raw identifier fields", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    const result = await financialPictureInventory(fixture.env, { limit: 100 });
    assert.equal(result.status, 200);
    assert.equal(assertFinancialPicturePublicReceipt(result.body), result.body);

    const adversarialFields = [
      ["source_doc_uid", "gmail:private-provider-id"],
      ["source_locator", "page 4 account 998877"],
      ["internal_id", 42],
      ["provider_account_id", "provider-private-id"],
      ["raw_id", "raw-private-id"],
    ];
    for (const [field, value] of adversarialFields) {
      const poisoned = structuredClone(result.body);
      poisoned.sections.entities.records[0].source_lineage[field] = value;
      assert.throws(
        () => assertFinancialPicturePublicReceipt(poisoned),
        /raw, internal, provider, UID, slug, feed, or locator fields are forbidden/i,
        field,
      );
    }
    const unknown = structuredClone(result.body);
    unknown.sections.entities.records[0].verification.secret_payload = "must-not-serialize";
    assert.throws(
      () => assertFinancialPicturePublicReceipt(unknown),
      /unknown field secret_payload/i,
    );
    const badCoverageRange = structuredClone(result.body);
    badCoverageRange.sections.accounts.records[0]
      .verification.freshness.source_coverage.target_range.from = "provider-record-id-4455";
    assert.throws(
      () => assertFinancialPicturePublicReceipt(badCoverageRange),
      /expected an exact UTC timestamp or null/i,
    );
    const badLegacyText = structuredClone(result.body);
    badLegacyText.sections.books.records[0].verification.extraction.text_source =
      "provider_native_field_4455";
    assert.throws(
      () => assertFinancialPicturePublicReceipt(badLegacyText),
      /unknown assessed text source/i,
    );

    const identifierCode = structuredClone(result.body);
    identifierCode.sections.entities.verification_gap_summary.missing_fields = {
      source_run_id_4455: 1,
    };
    assert.throws(
      () => assertFinancialPicturePublicReceipt(identifierCode),
      /diagnostic|identifier-shaped/i,
    );

    const scalarPoisons = [
      ["captured_at", (receipt) => { receipt.snapshot.captured_at = { raw: "provider-id" }; }],
      ["page_limit", (receipt) => { receipt.page_limit = "100"; }],
      ["completeness_verdict", (receipt) => { receipt.completeness_verdict = {}; }],
      ["tax_year", (receipt) => { receipt.filters.tax_year = [2024]; }],
    ];
    for (const [label, mutate] of scalarPoisons) {
      const poisoned = structuredClone(result.body);
      mutate(poisoned);
      assert.throws(() => assertFinancialPicturePublicReceipt(poisoned), undefined, label);
    }

    const qbo = result.body.sections.books.records.find(
      (record) => record.record_type === "quickbooks_company_observation",
    );
    assert.ok(qbo);
    const groupPoisons = [
      ["string count", (group) => { group.evidence_records = "1"; }],
      ["negative count", (group) => { group.provenance_assessed_records = -1; }],
      ["arithmetic mismatch", (group) => { group.provenance_unassessed_records += 1; }],
    ];
    for (const [label, mutate] of groupPoisons) {
      const poisoned = structuredClone(result.body);
      const group = poisoned.sections.books.records.find(
        (record) => record.record_type === "quickbooks_company_observation",
      ).extraction_group_evidence;
      mutate(group);
      assert.throws(
        () => assertFinancialPicturePublicReceipt(poisoned),
        /bounded integer|arithmetically inconsistent/i,
        label,
      );
    }

    const unassessedNative = structuredClone(result.body);
    const extraction = unassessedNative.sections.books.records.find(
      (record) => record.record_type === "quickbooks_company_observation",
    ).verification.extraction;
    extraction.provenance_assessed = false;
    extraction.provenance_status = "unavailable";
    extraction.provenance_reason = "provenance_receipt_missing_or_invalid";
    assert.throws(
      () => assertFinancialPicturePublicReceipt(unassessedNative),
      /unassessed provenance cannot expose or confirm extraction fields/i,
    );

    const refusedConfirmed = structuredClone(result.body);
    const coverage = refusedConfirmed.sections.books.records.find(
      (record) => record.record_type === "quickbooks_company_observation",
    ).verification.freshness.source_coverage;
    coverage.confirmed_range.from = "2026-01-01T00:00:00.000Z";
    coverage.counts = { seen: 1, accepted: 1, refused: 1, failed: 0 };
    assert.throws(
      () => assertFinancialPicturePublicReceipt(refusedConfirmed),
      /confirmed range requires one measured clean run/i,
    );

    const falseNotApplicable = structuredClone(result.body);
    const falseCoverage = falseNotApplicable.sections.books.records.find(
      (record) => record.record_type === "quickbooks_company_observation",
    ).verification.freshness.source_coverage;
    falseCoverage.state = "not_applicable";
    falseCoverage.basis = "not_applicable";
    assert.throws(
      () => assertFinancialPicturePublicReceipt(falseNotApplicable),
      /not-applicable source coverage must contain no source evidence/i,
    );
  } finally {
    fixture.close();
  }
});

test("pagination is section-bound, filter-bound, and receipt-stable", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    const sessionConstraints = [];
    const session = {
      ...fixture.DB,
      getBookmark: () => "opaque-fixture-d1-bookmark",
    };
    fixture.env.DB = {
      ...fixture.DB,
      withSession: (constraint) => {
        sessionConstraints.push(constraint);
        return session;
      },
    };
    const request = {
      sections: ["accounts"],
      filters: { entity_slug: "orchard-cafe" },
      limit: 1,
    };
    const first = await json(await fixture.post(PATH, request, ADMIN));
    const same = await json(await fixture.post(PATH, request, ADMIN));
    assert.equal(first.response.status, 200);
    assert.equal(first.body.sections.accounts.total, 2);
    assert.equal(first.body.sections.accounts.returned, 1);
    assert.equal(first.body.sections.accounts.truncated, true);
    assert.equal(first.body.sections.accounts.cursor, null);
    assert.equal(typeof first.body.sections.accounts.next_cursor, "string");
    if (first.body.snapshot.captured_at !== same.body.snapshot.captured_at) {
      assert.notEqual(
        first.body.snapshot.content_sha256,
        same.body.snapshot.content_sha256,
        "the receipt hash must bind its own as-of time",
      );
    }
    assert.equal(first.body.snapshot.database_bookmark_state, "available");
    assert.match(first.body.snapshot.database_version_ref, /^database_snapshot_v2_[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(first.body).includes("opaque-fixture-d1-bookmark"), false);
    assert.deepEqual(sessionConstraints, ["first-primary", "first-primary"]);

    const second = await json(await fixture.post(PATH, { ...request, cursor: first.body.sections.accounts.next_cursor }, ADMIN));
    assert.equal(second.response.status, 200);
    assert.equal(second.body.sections.accounts.returned, 1);
    assert.equal(second.body.sections.accounts.truncated, false);
    assert.equal(second.body.sections.accounts.cursor, first.body.sections.accounts.next_cursor);
    assert.equal(second.body.snapshot.database_version_ref, first.body.snapshot.database_version_ref);
    assert.notEqual(
      first.body.sections.accounts.records[0].account_ref,
      second.body.sections.accounts.records[0].account_ref,
    );
    const completePage = await json(await fixture.post(PATH, {
      ...request,
      limit: 100,
    }, ADMIN));
    const pagedRefs = [
      first.body.sections.accounts.records[0].account_ref,
      second.body.sections.accounts.records[0].account_ref,
    ];
    assert.deepEqual(
      completePage.body.sections.accounts.records.map((record) => record.account_ref).sort(),
      pagedRefs.sort(),
      "keyed references remain joinable across page snapshots for the same Brain key",
    );
    const legacyDictionaryRef = `acct_v1_${await sha256(
      "financial-picture-v1:primary:acct:orchard-card",
    )}`;
    assert.equal(pagedRefs.includes(legacyDictionaryRef), false);

    fixture.env.SESSION_SIGNING_KEY = "rotated-fixture-session-signing-key-9876543210";
    const rotated = await json(await fixture.post(PATH, { ...request, limit: 100 }, ADMIN));
    assert.equal(rotated.response.status, 200);
    assert.notDeepEqual(
      rotated.body.sections.accounts.records.map((record) => record.account_ref).sort(),
      pagedRefs.sort(),
      "rotating the per-Brain signing key rotates every public reference",
    );
    assert.notEqual(rotated.body.snapshot.database_version_ref, first.body.snapshot.database_version_ref);
    const oldCursorAfterRotation = await json(await fixture.post(PATH, {
      ...request,
      cursor: first.body.sections.accounts.next_cursor,
    }, ADMIN));
    assert.equal(oldCursorAfterRotation.response.status, 400);
    assert.equal(oldCursorAfterRotation.body.code, "cursor_request_mismatch");

    const wrongFilter = await json(await fixture.post(PATH, {
      ...request,
      filters: { entity_slug: "owner-person" },
      cursor: first.body.sections.accounts.next_cursor,
    }, ADMIN));
    assert.equal(wrongFilter.response.status, 400);
    assert.equal(wrongFilter.body.code, "cursor_request_mismatch");

    const wrongBaseline = await json(await fixture.post(PATH, {
      ...request,
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      cursor: first.body.sections.accounts.next_cursor,
    }, ADMIN));
    assert.equal(wrongBaseline.response.status, 400);
    assert.equal(wrongBaseline.body.code, "cursor_request_mismatch");

    const multi = await json(await fixture.post(PATH, {
      sections: ["accounts", "entities"], cursor: first.body.sections.accounts.next_cursor,
    }, ADMIN));
    assert.equal(multi.response.status, 400);
    assert.equal(multi.body.code, "cursor_requires_one_section");
  } finally {
    fixture.close();
  }
});

test("period pagination has a unique durable tie-breaker", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
          feed_mode, status, provenance, basis_state, recorded_at)
       VALUES ('primary', 'tied-period-account', 'orchard-cafe', 'checking', 'asset',
               'USD', 'manual', 'open', 'owner_stated', 'confirmed',
               '2026-09-01T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_statements
         (tenant_id, statement_uid, account_slug, period_start, period_end,
          parse_state, provenance, basis_state, recorded_at)
       VALUES ('primary', 'tied-period-a', 'tied-period-account',
               '2026-01-01', '2026-01-31', 'received', 'owner_stated', 'confirmed',
               '2026-02-01T00:00:00Z'),
              ('primary', 'tied-period-b', 'tied-period-account',
               '2026-01-01', '2026-01-31', 'received', 'owner_stated', 'confirmed',
               '2026-02-01T00:00:00Z')`,
    );
    const request = { sections: ["periods"], limit: 1 };
    const first = await json(await fixture.post(PATH, request, ADMIN));
    const second = await json(await fixture.post(PATH, {
      ...request, cursor: first.body.sections.periods.next_cursor,
    }, ADMIN));
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.equal(first.body.sections.periods.total, 2);
    assert.equal(second.body.sections.periods.total, 2);
    const refs = new Set([
      first.body.sections.periods.records[0].period_ref,
      second.body.sections.periods.records[0].period_ref,
    ]);
    assert.equal(refs.size, 2);
    assert.equal(second.body.sections.periods.next_cursor, null);
  } finally {
    fixture.close();
  }
});

test("filters are exact, unknown entity filters fail closed, and auth is owner-wide only", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    const filtered = await json(await fixture.post(PATH, {
      sections: ["books", "tax_returns", "evidence"],
      filters: {
        entity_slug: "orchard-cafe", tax_year: 2024,
        period_start: "2024-01-01", period_end: "2024-12-31",
      },
      limit: 10,
    }, ADMIN));
    assert.equal(filtered.response.status, 200);
    assert.equal(filtered.body.sections.books.records.length, 1);
    assert.equal(filtered.body.sections.books.records[0].record_type, "books_document_evidence");
    assert.equal(filtered.body.sections.tax_returns.returned, 2);
    assert.equal(filtered.body.sections.evidence.returned, 3);
    assert.deepEqual(filtered.body.sections.books.applied_filters, filtered.body.filters);

    const typo = await json(await fixture.post(PATH, {
      filters: { entity_slug: "orchard-caffee" },
    }, ADMIN));
    assert.equal(typo.response.status, 404);
    assert.equal(typo.body.code, "entity_not_found");
    assert.equal(JSON.stringify(typo.body).includes("orchard-caffee"), false);

    const invalid = await json(await fixture.post(PATH, {
      filters: { period_start: "2024-02-30" }, surprise: true,
    }, ADMIN));
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.body.code, /^invalid_/);

    const unauthorised = await json(await fixture.post(PATH, {}, {}));
    assert.equal(unauthorised.response.status, 401);

    const owner = await json(await fixture.post(PATH, { sections: ["entities"] }, await fixture.ownerHeaders()));
    assert.equal(owner.response.status, 200);
    assert.equal(owner.body.sections.entities.returned, 4);

    const grant = await json(await fixture.post(PATH, { sections: ["entities"] }, await fixture.ownerHeaders({ grantId: "grant-fixture" })));
    assert.equal(grant.response.status, 403);
    assert.equal(grant.body.code, "owner_required");
  } finally {
    fixture.close();
  }
});

test("a prior as-of cutoff gates only newly recorded provenance debt", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    const baseline = { recorded_at: "2026-08-31T00:00:00.000Z" };
    const failed = await json(await fixture.post(PATH, {
      sections: ["entities"],
      provenance_baseline: baseline,
      limit: 25,
    }, ADMIN));
    assert.equal(failed.response.status, 200);
    assert.deepEqual(failed.body.provenance_baseline, baseline);
    assert.equal(failed.body.provenance_debt_gate.state, "failed_new_provenance_debt");
    assert.equal(failed.body.provenance_debt_gate.covers_all_evaluated_matching_records, true);
    assert.equal(failed.body.provenance_debt_gate.new_records, 2);
    assert.equal(failed.body.provenance_debt_gate.new_records_with_provenance_debt, 1);
    assert.equal(failed.body.provenance_debt_gate.debt_reason_codes.basis_unparsed, 1);
    assert.equal(
      failed.body.provenance_debt_gate.debt_reason_codes
        .missing_source_document_reference_resolution,
      1,
    );

    const passed = await json(await fixture.post(PATH, {
      sections: ["entities"],
      provenance_baseline: { recorded_at: "2026-09-04T00:00:00.000Z" },
      limit: 25,
    }, ADMIN));
    assert.equal(passed.body.provenance_debt_gate.state, "passed_no_new_provenance_debt");
    assert.equal(passed.body.provenance_debt_gate.new_records, 0);
    assert.equal(passed.body.provenance_debt_gate.new_records_with_provenance_debt, 0);

    const partial = await json(await fixture.post(PATH, {
      sections: ["entities"],
      provenance_baseline: baseline,
      limit: 1,
    }, ADMIN));
    assert.equal(partial.body.sections.entities.truncated, true);
    assert.equal(partial.body.provenance_debt_gate.state, "insufficient_scope");

    const invalid = await json(await fixture.post(PATH, {
      sections: ["entities"],
      provenance_baseline: { recorded_at: "yesterday" },
    }, ADMIN));
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.code, "invalid_provenance_baseline");

    const future = await json(await fixture.post(PATH, {
      sections: ["entities"],
      provenance_baseline: { recorded_at: "2126-09-30T00:00:00.000Z" },
    }, ADMIN));
    assert.equal(future.response.status, 400);
    assert.equal(future.body.code, "future_provenance_baseline");
  } finally {
    fixture.close();
  }
});

test("the snapshot receipt keeps the pre-read as-of boundary supplied by its caller", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    const capturedAt = "2026-09-05T12:34:56.789Z";
    const result = await financialPictureInventory(
      fixture.env,
      { sections: ["entities"], limit: 25 },
      { capturedAt },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.snapshot.captured_at, capturedAt);
    assert.equal(result.body.snapshot.as_of, capturedAt);
  } finally {
    fixture.close();
  }
});

test("period-bearing evidence without an entity stays visible and blocks scoped proof", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, doc_kind, title, tax_year, period_start, period_end,
          custody_class, availability, readable, restricted, provenance, basis_state,
          recorded_at)
       VALUES ('primary', 'unassigned-period-evidence', 'tax_return',
               'Unassigned period evidence', 2025, '2025-01-01', '2025-12-31',
               'reference', 'do_not_have_it', 1, 0, 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );

    const unfiltered = await json(await fixture.post(PATH, {
      sections: ["periods"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 25,
    }, ADMIN));
    assert.equal(unfiltered.response.status, 200);
    const rows = unfiltered.body.sections.periods.records.filter(
      (record) => record.tax_year === 2025 || record.period_start === "2025-01-01",
    );
    assert.equal(rows.length, 2);
    for (const record of rows) {
      assert.equal(record.entity_ref, null);
      assert.equal(record.entity_reference_state, "stored_value_missing");
      assert.equal(record.mapping_confirmation.field_states.entity, "stored_value_missing");
      assert.ok(record.verification.missing_verification_fields.includes("entity_stored_value_missing"));
      assert.equal(record.verification.blocks_financial_verification, true);
    }
    assert.equal(
      unfiltered.body.sections.periods.reference_integrity.counts.period_document_entity_missing,
      1,
    );

    const scoped = await json(await fixture.post(PATH, {
      sections: ["periods"],
      filters: { entity_slug: "orchard-cafe" },
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 25,
    }, ADMIN));
    assert.equal(scoped.response.status, 200);
    assert.equal(scoped.body.sections.periods.total, 0);
    assert.equal(scoped.body.sections.periods.reference_integrity.blocks_financial_verification, true);
    assert.equal(scoped.body.provenance_debt_gate.state, "insufficient_scope");
  } finally {
    fixture.close();
  }
});

test("superseded statements cannot satisfy current period inventory", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `INSERT INTO fin_statements
         (tenant_id, statement_uid, account_slug, period_start, period_end,
          parse_state, provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'superseded-statement', 'orchard-operating',
               '2020-01-01', '2020-01-31', 'received', 'owner_stated',
               'confirmed', '2020-02-01T00:00:00Z', 999)`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["periods"],
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);
    assert.equal(
      body.sections.periods.records.some(
        (record) => record.period_start === "2020-01-01" && record.period_end === "2020-01-31",
      ),
      false,
    );
  } finally {
    fixture.close();
  }
});

test("dangling, mismatched, and backward supersession edges cannot hide inventory gaps", async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw(
      `INSERT INTO fin_entities
         (tenant_id, entity_slug, legal_name, kind, status, relationship,
          provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'hidden-mismatched-entity', 'Hidden Entity LLC', 'business',
               'closed', 'owned', 'owner_stated', 'confirmed',
               '2026-08-01T00:00:00Z', 999)`,
    );
    const hiddenEntityId = fixture.first(
      "SELECT id FROM fin_entities WHERE entity_slug='hidden-mismatched-entity'",
    ).id;
    seedOwnedEntity(fixture, "different-live-entity", "Different Live Entity");
    const differentEntityId = fixture.first(
      "SELECT id FROM fin_entities WHERE entity_slug='different-live-entity' AND superseded_by_id IS NULL",
    ).id;
    assert.ok(differentEntityId > hiddenEntityId);
    fixture.raw(
      "UPDATE fin_entities SET superseded_by_id=? WHERE id=?",
      differentEntityId,
      hiddenEntityId,
    );
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
          feed_mode, status, provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'hidden-dangling-account', 'different-live-entity', 'checking',
               'asset', 'USD', 'manual', 'closed', 'owner_stated', 'confirmed',
               '2026-08-01T00:00:00Z', 999)`,
    );
    fixture.raw(
      `INSERT INTO fin_account_coverage
         (tenant_id, account_slug, coverage_status, computed_at, provenance, basis_state,
          recorded_at, superseded_by_id)
       VALUES ('primary', 'hidden-dangling-account', 'missing',
               '2026-08-01T00:00:00Z', 'owner_stated', 'confirmed',
               '2026-08-01T00:00:00Z', 999)`,
    );
    fixture.raw(
      `INSERT INTO fin_statements
         (tenant_id, statement_uid, account_slug, period_start, period_end, parse_state,
          provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'hidden-dangling-statement', 'hidden-dangling-account',
               '2026-07-01', '2026-07-31', 'received', 'owner_stated', 'confirmed',
               '2026-08-01T00:00:00Z', 999)`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, doc_kind, title, custody_class, availability,
          readable, restricted, provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'cyclic-document', 'receipt', 'Cycle first', 'reference',
               'do_not_have_it', 1, 0, 'owner_stated', 'confirmed',
               '2026-08-01T00:00:00Z', 999)`,
    );
    const firstDocumentId = fixture.first(
      "SELECT id FROM fin_documents WHERE fin_doc_uid='cyclic-document'",
    ).id;
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, doc_kind, title, custody_class, availability,
          readable, restricted, provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'cyclic-document', 'receipt', 'Cycle second', 'reference',
               'do_not_have_it', 1, 0, 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z', ?)`,
      firstDocumentId,
    );
    const secondDocumentId = fixture.first(
      "SELECT MAX(id) AS id FROM fin_documents WHERE fin_doc_uid='cyclic-document'",
    ).id;
    fixture.raw("UPDATE fin_documents SET superseded_by_id=? WHERE id=?", secondDocumentId, firstDocumentId);

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["entities", "accounts", "periods", "evidence"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);
    assert.equal(body.sections.entities.reference_integrity.counts.entity_supersession_target, 1);
    assert.equal(body.sections.accounts.reference_integrity.counts.account_supersession_target, 1);
    assert.equal(body.sections.accounts.reference_integrity.counts.coverage_supersession_target, 1);
    assert.equal(body.sections.accounts.reference_integrity.counts.statement_supersession_target, 1);
    assert.equal(body.sections.evidence.reference_integrity.counts.document_supersession_target, 1);
    const cycleRows = body.sections.evidence.records.filter(
      (record) => record.supersession.claimed,
    );
    assert.equal(cycleRows.length, 2);
    assert.equal(cycleRows.filter((record) => record.current_state === "superseded").length, 1);
    const broken = cycleRows.find((record) => record.current_state === "supersession_unresolved");
    assert.ok(broken);
    assert.equal(broken.superseded_by_ref, null);
    assert.match(broken.supersession.stored_target_ref, /^evidence_v2_[a-f0-9]{64}$/);
    assert.equal(broken.supersession.reference_state, "unresolved_or_mismatched");
    assert.ok(
      broken.verification.missing_provenance_fields
        .includes("superseded_by_reference_resolution"),
    );
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
  } finally {
    fixture.close();
  }
});

test("stored owner-stated assertions cannot confirm mappings without an owner actor receipt", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `UPDATE fin_account_coverage
          SET provenance = 'owner_stated', source_feed = NULL, basis_state = 'confirmed'
        WHERE account_slug = 'orchard-operating' AND superseded_by_id IS NULL`,
    );
    fixture.raw(
      `INSERT INTO fin_statements
         (tenant_id, statement_uid, account_slug, period_start, period_end,
          parse_state, provenance, basis_state, recorded_at)
       VALUES ('primary', 'owner-stated-statement', 'orchard-operating',
               '2025-02-01', '2025-02-28', 'received', 'owner_stated',
               'confirmed', '2025-03-01T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["accounts", "periods"],
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);

    const account = body.sections.accounts.records.find(
      (record) => record.category === "bank",
    );
    assert.equal(account.coverage.mapping_confirmation.field_states.account, "stored_owner_assertion_unconfirmed");
    assert.equal(account.coverage.mapping_confirmation.field_states.period, "stored_owner_assertion_unconfirmed");
    assert.equal(account.coverage.mapping_confirmation.field_states.entity, "not_owner_confirmed");
    assert.equal(account.coverage.mapping_confirmation.confirmed_by_owner, null);
    assert.deepEqual(account.coverage.mapping_confirmation.confirmed_fields, []);
    assert.deepEqual(account.coverage.mapping_confirmation.field_basis.entity, {
      provenance: "feed",
      basis_state: "confirmed",
      stored_owner_assertion: false,
      owner_actor_receipt_present: false,
      reference_present: true,
    });

    for (const kind of ["account_coverage", "statement_period"]) {
      const period = body.sections.periods.records.find(
        (record) => record.period_kind === kind,
      );
      assert.equal(period.mapping_confirmation.field_states.period, "stored_owner_assertion_unconfirmed");
      assert.equal(period.mapping_confirmation.field_states.entity, "not_owner_confirmed");
      assert.deepEqual(period.mapping_confirmation.field_basis.entity, {
        provenance: "feed",
        basis_state: "confirmed",
        stored_owner_assertion: false,
        owner_actor_receipt_present: false,
        reference_present: true,
      });
      assert.deepEqual(period.mapping_confirmation.field_basis.period, {
        provenance: "owner_stated",
        basis_state: "confirmed",
        stored_owner_assertion: true,
        owner_actor_receipt_present: false,
      });
    }
  } finally {
    fixture.close();
  }
});

test("an agent-authored wrong-entity tuple cannot impersonate an owner confirmation ceremony", async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw(
      `INSERT INTO fin_entities
         (tenant_id, entity_slug, legal_name, kind, status, relationship,
          provenance, basis_state, recorded_at)
       VALUES ('primary', 'agent-wrong-entity', 'Agent Misclassified LLC', 'business',
               'active', 'owned', 'owner_stated', 'confirmed', '2026-09-09T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
          feed_mode, status, provenance, basis_state, recorded_at)
       VALUES ('primary', 'agent-wrong-account', 'agent-wrong-entity', 'checking',
               'asset', 'USD', 'manual', 'open', 'owner_stated', 'confirmed',
               '2026-09-09T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["entities", "accounts"],
      filters: { entity_slug: "agent-wrong-entity" },
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);

    const entity = body.sections.entities.records[0];
    assert.equal(entity.scope_state, "stored_owner_assertion_unconfirmed");
    assert.equal(entity.ownership_confirmed, null);
    assert.equal(entity.scope_confirmation.relationship_confirmed_by_owner, null);
    assert.equal(entity.scope_confirmation.stored_owner_assertion, true);
    assert.equal(entity.scope_confirmation.owner_actor_receipt_present, false);
    assert.deepEqual(
      entity.scope_confirmation.missing_fields,
      ["relationship_current_owner_confirmation"],
    );
    for (const field of [
      "kind", "status", "holds", "ownership_basis_points", "tax_class", "relationship",
    ]) {
      assert.equal(entity.material_fields[field].confirmed_by_owner, null, field);
      assert.equal(entity.material_fields[field].owner_actor_receipt_present, false, field);
      assert.notEqual(entity.material_fields[field].confirmation_state, "owner_confirmed", field);
    }
    assert.equal(entity.verification.provenance_debt, true);
    assert.ok(entity.verification.provenance_reason_codes.includes(
      "stored_owner_assertion_unconfirmed",
    ));

    const mapping = body.sections.accounts.records[0].mapping_confirmation;
    assert.equal(mapping.state, "stored_owner_assertions_unconfirmed");
    assert.equal(mapping.confirmed_by_owner, null);
    assert.deepEqual(mapping.confirmed_fields, []);
    assert.deepEqual(mapping.stored_owner_assertion_fields.sort(), ["account", "entity"]);
    assert.equal(mapping.field_states.account, "stored_owner_assertion_unconfirmed");
    assert.equal(mapping.field_states.entity, "stored_owner_assertion_unconfirmed");
    assert.ok(mapping.missing_fields.includes("account_current_owner_confirmation"));
    assert.ok(mapping.missing_fields.includes("entity_current_owner_confirmation"));
    assert.ok(mapping.reason_codes.includes("owner_actor_receipt_unavailable"));
    assert.equal(
      /:"owner_confirmed"/.test(JSON.stringify({ entity, mapping })),
      false,
      "a stored provenance label must never become an authoritative confirmation value",
    );
  } finally {
    fixture.close();
  }
});

test("an owner-stated books document cannot confirm a fingerprint derived from corpus metadata", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, tax_year,
          period_start, period_end, custody_class, availability, filed_at,
          corpus_doc_uid, readable, restricted, provenance, basis_state, recorded_at)
       VALUES ('primary', 'owner-stated-books-doc', 'orchard-cafe', 'balance_sheet',
               'owner-stated books fixture', 2024, '2024-01-01', '2024-12-31',
               'reference', 'have_it', '2026-09-05', 'corpus-qbo-report', 1, 0,
               'owner_stated', 'confirmed', '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["books"],
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);
    const document = body.sections.books.records.find(
      (record) => record.record_type === "books_document_evidence" &&
        record.source_lineage.provenance === "owner_stated",
    );
    assert.equal(document.mapping_confirmation.field_states.entity, "stored_owner_assertion_unconfirmed");
    assert.equal(document.mapping_confirmation.field_states.period, "stored_owner_assertion_unconfirmed");
    assert.equal(document.mapping_confirmation.field_states.books_company, "not_owner_confirmed");
    assert.deepEqual(document.mapping_confirmation.field_basis.books_company, {
      provenance: null,
      basis_state: null,
      stored_owner_assertion: false,
      owner_actor_receipt_present: false,
      stored_field: "documents.meta.qbo_company_fingerprint",
    });
  } finally {
    fixture.close();
  }
});

test("an empty record registry cannot pass the provenance-debt gate", async () => {
  const fixture = await createProductFixture();
  try {
    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["accounts"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
    }, ADMIN));
    assert.equal(response.status, 200);
    assert.equal(body.sections.accounts.total, 0);
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(body.provenance_debt_gate.covers_all_evaluated_matching_records, false);
  } finally {
    fixture.close();
  }
});

test("orphaned coverage and statements remain visible and block account verification", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO fin_account_coverage
         (tenant_id, account_slug, coverage_status, covered_from, covered_to,
          computed_at, provenance, basis_state, recorded_at)
       VALUES ('primary', 'orphan-provider-account-sentinel-445566', 'partial',
               '2026-01-01', '2026-01-31', '2026-09-05T00:00:00Z',
               'owner_stated', 'confirmed', '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_statements
         (tenant_id, statement_uid, account_slug, period_start, period_end,
          parse_state, provenance, basis_state, unparsed_reason, recorded_at)
       VALUES ('primary', 'orphan-statement-private-id',
               'orphan-provider-account-sentinel-445566', '2026-01-01', '2026-01-31',
               'unparsed', 'owner_stated', 'unparsed', 'account registry row is missing',
               '2026-09-05T00:00:00Z')`,
    );

    const request = {
      sections: ["accounts", "periods"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 100,
    };
    const { response, body } = await json(await fixture.post(PATH, request, ADMIN));
    assert.equal(response.status, 200);
    assert.deepEqual(body.sections.accounts.reference_integrity.counts, {
      account_entity: 0,
      coverage_account: 1,
      statement_account: 1,
      indirect_coverage_target: 0,
      entity_supersession_target: 0,
      account_supersession_target: 0,
      coverage_supersession_target: 0,
      document_supersession_target: 0,
      statement_supersession_target: 0,
    });
    assert.equal(body.sections.accounts.reference_integrity.total, 2);
    assert.equal(body.sections.accounts.reference_integrity.blocks_financial_verification, true);
    assert.equal(
      body.sections.accounts.verification_gap_summary.provenance_debt_since_baseline.state,
      "insufficient_scope",
    );
    assert.ok(
      body.sections.accounts.verification_gap_summary.scope_reason_codes
        .includes("unresolved_stable_references"),
    );

    const orphanPeriods = body.sections.periods.records.filter(
      (record) => record.account_reference_state === "unresolved",
    );
    assert.equal(orphanPeriods.length, 2);
    for (const record of orphanPeriods) {
      assert.equal(record.entity_ref, null);
      assert.match(record.account_ref, /^acct_v2_[a-f0-9]{64}$/);
      assert.equal(record.mapping_confirmation.field_states.entity, "stored_value_missing");
      assert.ok(record.verification.missing_verification_fields.includes("account_reference_unresolved"));
      assert.ok(record.verification.blocking_reasons.includes("account_reference_unresolved"));
    }
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(JSON.stringify(body).includes("orphan-provider-account-sentinel-445566"), false);

    const accountsOnly = await json(await fixture.post(PATH, {
      sections: ["accounts"],
      provenance_baseline: request.provenance_baseline,
    }, ADMIN));
    assert.equal(accountsOnly.body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(accountsOnly.body.sections.accounts.reference_integrity.total, 2);

    const scopedPeriodsOnly = await json(await fixture.post(PATH, {
      sections: ["periods"],
      filters: { entity_slug: "orchard-cafe" },
      provenance_baseline: request.provenance_baseline,
    }, ADMIN));
    assert.equal(scopedPeriodsOnly.response.status, 200);
    assert.equal(scopedPeriodsOnly.body.sections.periods.total, 0);
    assert.equal(scopedPeriodsOnly.body.sections.periods.reference_integrity.total, 2);
    assert.equal(
      scopedPeriodsOnly.body.sections.periods.reference_integrity.filter_scope,
      "tenant_wide_integrity_edges_cannot_be_safely_attributed_to_exact_entity_filter",
    );
    assert.equal(scopedPeriodsOnly.body.provenance_debt_gate.state, "insufficient_scope");
  } finally {
    fixture.close();
  }
});

test("indirect coverage cannot cite a missing or superseded covering account", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
          feed_mode, status, provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'superseded-indirect-target-778899', 'orchard-cafe',
               'checking', 'asset', 'USD', 'manual', 'closed', 'owner_stated',
               'confirmed', '2026-08-01T00:00:00Z', 999)`,
    );
    fixture.raw(
      `UPDATE fin_account_coverage
          SET coverage_status = 'indirect',
              covered_via_account_slug = 'superseded-indirect-target-778899',
              provenance = 'owner_stated', source_feed = NULL,
              basis_state = 'confirmed', recorded_at = '2026-09-05T00:00:00Z'
        WHERE account_slug = 'orchard-operating' AND superseded_by_id IS NULL`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["accounts", "periods"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);
    assert.equal(body.sections.accounts.reference_integrity.counts.indirect_coverage_target, 1);
    const account = body.sections.accounts.records.find(
      (record) => record.category === "bank" && record.coverage?.status === "indirect",
    );
    assert.equal(account.coverage.covered_via_account_reference_state, "unresolved");
    assert.match(account.coverage.covered_via_account_ref, /^acct_v2_[a-f0-9]{64}$/);
    assert.equal(
      account.coverage.mapping_confirmation.field_states.covered_via_account,
      "stored_reference_unresolved",
    );
    assert.ok(
      account.coverage.verification.missing_verification_fields
        .includes("covered_via_account_reference_unresolved"),
    );
    const period = body.sections.periods.records.find(
      (record) => record.period_kind === "account_coverage" && record.evidence_kind === "indirect",
    );
    assert.equal(period.covered_via_account_reference_state, "unresolved");
    assert.equal(
      period.mapping_confirmation.field_states.covered_via_account,
      "stored_reference_unresolved",
    );
    assert.ok(
      period.verification.blocking_reasons.includes("covered_via_account_reference_unresolved"),
    );
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(JSON.stringify(body).includes("superseded-indirect-target-778899"), false);
  } finally {
    fixture.close();
  }
});

test("stable entity and account mappings resolve current targets or block every scoped view", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO fin_entities
         (tenant_id, entity_slug, legal_name, kind, status, relationship,
          provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'superseded-entity-target', 'Superseded Entity LLC',
               'business', 'closed', 'owned', 'owner_stated', 'confirmed',
               '2026-08-01T00:00:00Z', 999)`,
    );
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
          feed_mode, status, provenance, basis_state, recorded_at, superseded_by_id)
       VALUES ('primary', 'superseded-account-target', 'orchard-cafe', 'checking',
               'asset', 'USD', 'manual', 'closed', 'owner_stated', 'confirmed',
               '2026-08-01T00:00:00Z', 999),
              ('primary', 'orphan-entity-account', 'superseded-entity-target', 'checking',
               'asset', 'USD', 'manual', 'open', 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z', NULL)`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, account_slug, doc_kind, title,
          custody_class, availability, readable, restricted, provenance, basis_state,
          recorded_at)
       VALUES ('primary', 'orphan-mapping-document', 'superseded-entity-target',
               'superseded-account-target', 'receipt', 'Orphan mapping fixture',
               'reference', 'do_not_have_it', 1, 0, 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_entities
         (tenant_id, entity_slug, legal_name, kind, status, relationship,
          parent_entity_slug, provenance, basis_state, recorded_at)
       VALUES ('primary', 'child-with-orphan-parent', 'Child Entity LLC', 'business',
               'active', 'owned', 'superseded-entity-target', 'owner_stated',
               'confirmed', '2026-09-05T00:00:00Z')`,
    );

    const global = await json(await fixture.post(PATH, {
      sections: ["entities", "accounts", "evidence"], limit: 100,
    }, ADMIN));
    assert.equal(global.response.status, 200);
    const child = global.body.sections.entities.records.find(
      (record) => record.stored_name.legal_name === "Child Entity LLC",
    );
    assert.equal(child.parent_entity_reference_state, "unresolved");
    assert.equal(
      child.parent_mapping_confirmation.field_states.parent_entity,
      "stored_reference_unresolved",
    );
    const account = global.body.sections.accounts.records.find(
      (record) => record.account_ref && record.entity_reference_state === "unresolved",
    );
    assert.equal(account.entity_reference_state, "unresolved");
    assert.equal(account.mapping_confirmation.field_states.entity, "stored_reference_unresolved");
    assert.ok(account.verification.missing_verification_fields.includes("entity_reference_unresolved"));
    const evidence = global.body.sections.evidence.records.find(
      (record) => record.evidence_kind === "receipt",
    );
    assert.equal(evidence.entity_reference_state, "unresolved");
    assert.equal(evidence.account_reference_state, "unresolved");
    assert.equal(evidence.mapping_confirmation.field_states.entity, "stored_reference_unresolved");
    assert.equal(evidence.mapping_confirmation.field_states.account, "stored_reference_unresolved");

    const scoped = await json(await fixture.post(PATH, {
      sections: ["accounts", "evidence"],
      filters: { entity_slug: "orchard-cafe" },
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 100,
    }, ADMIN));
    assert.equal(scoped.response.status, 200);
    assert.equal(scoped.body.sections.accounts.reference_integrity.counts.account_entity, 1);
    assert.equal(
      scoped.body.sections.evidence.reference_integrity.counts.evidence_document_entity,
      1,
    );
    assert.equal(
      scoped.body.sections.evidence.reference_integrity.counts.evidence_document_account,
      1,
    );
    assert.equal(scoped.body.provenance_debt_gate.state, "insufficient_scope");
  } finally {
    fixture.close();
  }
});

test("entity and account references cannot jointly confirm a cross-entity contradiction", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "entity-a", "Entity A");
    seedOwnedEntity(fixture, "entity-b", "Entity B");
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
          feed_mode, status, provenance, basis_state, recorded_at)
       VALUES ('primary', 'entity-b-account', 'entity-b', 'checking', 'asset', 'USD',
               'manual', 'open', 'owner_stated', 'confirmed', '2026-09-01T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, account_slug, doc_kind, title, tax_year,
          custody_class, availability, readable, restricted, provenance, basis_state,
          recorded_at)
       VALUES ('primary', 'cross-entity-document', 'entity-a', 'entity-b-account',
               'tax_return', 'Cross entity fixture', 2025, 'reference',
               'do_not_have_it', 1, 0, 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_reconciliations
         (tenant_id, reconciliation_uid, entity_slug, account_slug, period_start,
          period_end, measure, state, delta_minor, computed_at, recorded_at)
       VALUES ('primary', 'cross-entity-reconciliation', 'entity-a', 'entity-b-account',
               '2025-01-01', '2025-12-31', 'period_receipts', 'insufficient_evidence',
               NULL, '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_exceptions
         (tenant_id, exception_uid, entity_slug, kind, issue, txn_account_slug,
          first_seen, provenance, basis_state, recorded_at)
       VALUES ('primary', 'cross-entity-exception', 'entity-a', 'other',
               'Cross entity fixture', 'entity-b-account', '2026-09-05',
               'owner_stated', 'confirmed', '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["periods", "tax_returns", "evidence", "conflicts"],
      filters: { entity_slug: "entity-a" },
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);
    for (const sectionName of ["periods", "tax_returns", "evidence"]) {
      const record = body.sections[sectionName].records.find(
        (row) => row.account_ref,
      );
      assert.ok(record, `${sectionName} must retain the contradictory record`);
      assert.equal(record.entity_reference_state, "current_entity_resolved");
      assert.equal(record.account_reference_state, "current_account_resolved");
      assert.equal(record.entity_account_mapping_state, "conflict");
      assert.equal(record.mapping_confirmation.field_states.account, "stored_mapping_conflict");
      assert.ok(record.mapping_confirmation.missing_fields.includes("account_mapping_conflict"));
      assert.equal(record.verification.blocks_financial_verification, true);
    }
    for (const conflict of body.sections.conflicts.records) {
      assert.equal(conflict.entity_account_mapping_state, "conflict");
      assert.equal(conflict.mapping_confirmation.field_states.account, "stored_mapping_conflict");
    }
    assert.equal(
      body.sections.evidence.reference_integrity.counts.evidence_document_entity_account_conflict,
      1,
    );
    assert.equal(
      body.sections.conflicts.reference_integrity.counts.reconciliation_entity_account_conflict,
      1,
    );
    assert.equal(
      body.sections.conflicts.reference_integrity.counts.exception_entity_account_conflict,
      1,
    );
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
  } finally {
    fixture.close();
  }
});

test("source lineage follows the cited source while extraction follows the evidence corpus", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO documents
         (doc_uid, source, source_id, title, ingested_at, content_hash, meta,
          entity_slug, text_source, text_reliable)
       VALUES ('lineage-own-corpus', 'own-corpus-source', 'private-own-id',
               'Evidence corpus', 1756944000000, 'own-content-hash', ?,
               'orchard-cafe', 'ocr_partial', 0),
              ('lineage-cited-corpus', 'customer-bank-source-provider-id-667788', 'private-cited-id',
               'Cited source', 1756857600000, 'cited-content-hash', ?,
               'orchard-cafe', 'native', 1)`,
      provenanceMeta("own-corpus-source", "private-own-id"),
      provenanceMeta("customer-bank-source-provider-id-667788", "private-cited-id"),
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, custody_class,
          availability, filed_at, corpus_doc_uid, readable, restricted, provenance,
          source_doc_uid, source_locator, basis_state, recorded_at)
       VALUES ('primary', 'lineage-evidence-private-id', 'orchard-cafe', 'receipt',
               'Lineage separation fixture', 'reference', 'have_it', '2026-09-05',
               'lineage-own-corpus', 1, 0, 'extracted', 'lineage-cited-corpus',
               'page 1', 'confirmed', '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["evidence"], limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);
    const [evidence] = body.sections.evidence.records;
    assert.match(evidence.source_lineage.source_document_ref,
      /^source_document_v2_[a-f0-9]{64}$/);
    assert.equal(evidence.source_lineage.source_document_present, true);
    assert.equal(evidence.source_lineage.source_document_reference_state, "resolved");
    assert.match(evidence.source_lineage.linked_corpus_source_ref,
      /^corpus_source_v2_[a-f0-9]{64}$/);
    assert.equal(evidence.source_lineage.linked_corpus_source_present, true);
    assert.equal(evidence.source_lineage.linked_corpus_source_kind, null);
    assert.equal(evidence.source_lineage.linked_corpus_source_state, "stable_hash_only");
    assert.equal(evidence.verification.extraction.state, "ocr_partial");
    assert.equal(evidence.verification.extraction.text_reliable, false);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("lineage-cited-corpus"), false);
    assert.equal(serialized.includes("customer-bank-source-provider-id-667788"), false);
  } finally {
    fixture.close();
  }
});

test("self-referential and circular financial-document source lineage stays unresolved", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, custody_class,
          availability, readable, restricted, provenance, source_doc_uid,
          source_locator, basis_state, recorded_at)
       VALUES ('primary', 'self-source', 'orchard-cafe', 'receipt', 'Self source',
               'reference', 'do_not_have_it', 1, 0, 'extracted', 'self-source',
               'page 1', 'confirmed', '2026-09-05T00:00:00Z'),
              ('primary', 'cycle-source-a', 'orchard-cafe', 'receipt', 'Cycle A',
               'reference', 'do_not_have_it', 1, 0, 'extracted', 'cycle-source-b',
               'page 1', 'confirmed', '2026-09-05T00:00:00Z'),
              ('primary', 'cycle-source-b', 'orchard-cafe', 'receipt', 'Cycle B',
               'reference', 'do_not_have_it', 1, 0, 'extracted', 'cycle-source-a',
               'page 1', 'confirmed', '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["evidence"],
      filters: { entity_slug: "orchard-cafe" },
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);
    assert.equal(body.sections.evidence.records.length, 3);
    for (const record of body.sections.evidence.records) {
      assert.equal(record.source_lineage.source_document_reference_state, "unresolved");
      assert.equal(record.source_lineage.state, "document_reference_unresolved");
      assert.ok(
        record.source_lineage.reason_codes.includes(
          "missing_source_document_reference_resolution",
        ),
      );
      assert.equal(record.verification.provenance_debt, true);
    }
    assert.equal(
      body.sections.evidence.reference_integrity.counts.document_source_lineage_unresolved,
      3,
    );
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
  } finally {
    fixture.close();
  }
});

test("financial evidence cannot borrow extraction reliability from a mismatched corpus hash", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO documents
         (doc_uid, source, source_id, title, ingested_at, content_hash, meta,
          entity_slug, text_source, text_reliable)
       VALUES ('binding-corpus', 'upload', 'binding-source', 'Binding corpus',
               1756944000000, 'actual-corpus-hash', ?, 'orchard-cafe', 'native', 1)`,
      provenanceMeta("upload", "binding-source"),
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, custody_class,
          availability, filed_at, corpus_doc_uid, content_hash, readable, restricted,
          provenance, basis_state, recorded_at)
       VALUES ('primary', 'binding-evidence', 'orchard-cafe', 'receipt',
               'Binding evidence', 'reference', 'have_it', '2026-09-05',
               'binding-corpus', 'different-financial-hash', 1, 0, 'owner_stated',
               'confirmed', '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["evidence"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);
    const record = body.sections.evidence.records[0];
    assert.equal(record.verification.extraction.state, "native");
    assert.equal(record.verification.extraction.corpus_content_binding_state, "mismatched");
    assert.equal(record.source_lineage.corpus_content_binding_state, "mismatched");
    assert.equal(record.source_lineage.status_code, "incomplete");
    assert.ok(record.source_lineage.reason_codes.includes("missing_corpus_content_hash_match"));
    assert.equal(record.verification.provenance_debt, true);
    assert.equal(record.verification.blocks_financial_verification, true);
    assert.equal(
      body.sections.evidence.reference_integrity.counts.document_corpus_binding_mismatch,
      1,
    );
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(JSON.stringify(body).includes("actual-corpus-hash"), false);
    assert.equal(JSON.stringify(body).includes("different-financial-hash"), false);
  } finally {
    fixture.close();
  }
});

test("legacy text columns without a canonical stored receipt remain unavailable provenance debt", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO sources (name, kind, status, created_at, last_ingest_at)
       VALUES ('legacy-upload-private-source', 'upload', 'ready',
               '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO documents
         (doc_uid, source, source_id, title, ingested_at, content_hash, meta,
          entity_slug, text_source, text_reliable)
       VALUES ('legacy:provider-record-id-991177', 'legacy-upload-private-source',
               'provider-record-id-991177', 'Legacy defaulted extraction columns',
               1756944000000, 'matched-content-hash', '{}', 'orchard-cafe', 'native', 1)`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, custody_class,
          availability, filed_at, corpus_doc_uid, content_hash, readable, restricted,
          provenance, source_feed, basis_state, recorded_at)
       VALUES ('primary', 'legacy-financial-evidence-id', 'orchard-cafe', 'receipt',
               'Legacy receipt', 'reference', 'have_it', '2026-09-05',
               'legacy:provider-record-id-991177', 'matched-content-hash', 1, 0,
               'feed', 'legacy-upload-private-source', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["evidence"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);
    const record = body.sections.evidence.records[0];
    assert.equal(record.verification.extraction.provenance_assessed, false);
    assert.equal(record.verification.extraction.provenance_status, "unavailable");
    assert.equal(record.verification.extraction.provenance_reason,
      "provenance_receipt_missing_or_invalid");
    assert.equal(record.verification.extraction.state, "unavailable");
    assert.equal(record.verification.extraction.text_source, null);
    assert.equal(record.verification.extraction.text_reliable, null);
    assert.ok(record.source_lineage.missing_fields.includes("stored_provenance_receipt"));
    assert.ok(record.verification.missing_extraction_fields.includes("stored_provenance_receipt"));
    assert.equal(record.verification.provenance_debt, true);
    assert.equal(body.provenance_debt_gate.state, "failed_new_provenance_debt");
    assert.equal(JSON.stringify(body).includes("provider-record-id-991177"), false);
  } finally {
    fixture.close();
  }
});

test("source coverage uses one exact latest run and never combines a clean prior range", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO sources
         (name, kind, status, created_at, last_ingest_at, last_complete_sweep_at,
          expected_refresh_seconds)
       VALUES ('plaid-private-coverage-source-4488', 'plaid', 'ready',
               '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z',
               '2026-09-05T00:00:00Z', 86400)`,
    );
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, institution, account_kind, balance_role,
          currency, feed_mode, status, provenance, source_feed, basis_state, recorded_at)
       VALUES ('primary', 'coverage-account', 'orchard-cafe', 'Coverage Bank',
               'checking', 'asset', 'USD', 'live', 'open', 'feed',
               'plaid-private-coverage-source-4488', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO sync_runs
         (run_id, source, lane, started_at, finished_at, walk_complete, files_seen,
          docs_added, docs_updated, docs_unchanged, docs_refused, docs_failed,
          metrics_version, confirmed_from, confirmed_through, target_from, target_through)
       VALUES ('older-clean-private-run', 'plaid-private-coverage-source-4488', 'sweep',
               1000, 1100, 1, 10, 10, 0, 0, 0, 0, 1,
               '2024-01-01T00:00:00Z', '2024-12-31T23:59:59Z',
               '2024-01-01T00:00:00Z', '2024-12-31T23:59:59Z'),
              ('latest-pre-metrics-private-run', 'plaid-private-coverage-source-4488', 'sweep',
               2000, 2100, 1, 5, 4, 0, 0, 0, 0, 0,
               '2025-01-01T00:00:00Z', '2025-12-31T23:59:59Z',
               '2025-01-01T00:00:00Z', '2025-12-31T23:59:59Z')`,
    );
    fixture.seen.sql.length = 0;

    const first = await json(await fixture.post(PATH, {
      sections: ["accounts"], limit: 25,
    }, ADMIN));
    assert.equal(first.response.status, 200);
    const firstCoverage = first.body.sections.accounts.records[0]
      .verification.freshness.source_coverage;
    assert.equal(firstCoverage.state, "available");
    assert.equal(firstCoverage.basis, "source_feed_registry");
    assert.deepEqual(firstCoverage.counts, { seen: 5, accepted: 4, refused: null, failed: null });
    assert.deepEqual(firstCoverage.confirmed_range, { from: null, through: null });
    assert.deepEqual(firstCoverage.target_range, {
      from: "2025-01-01T00:00:00.000Z",
      through: "2025-12-31T23:59:59.000Z",
    });
    assert.ok(firstCoverage.missing_fields.includes("confirmed_source_range"));
    assert.ok(firstCoverage.missing_fields.includes("source_run_outcome_counts"));
    const inventorySql = fixture.seen.sql.find((sql) => sql.includes("coverage_run.run_confirmed_from") ||
      sql.includes("'run_confirmed_from', coverage_run.confirmed_from"));
    assert.ok(inventorySql, "coverage evidence must travel through the financial snapshot query");
    assert.match(inventorySql, /ORDER BY candidate\.started_at DESC, candidate\.run_id DESC/);

    fixture.raw(
      `INSERT INTO sync_runs
         (run_id, source, lane, started_at, finished_at, walk_complete, files_seen,
          docs_added, docs_updated, docs_unchanged, docs_refused, docs_failed,
          metrics_version, confirmed_from, confirmed_through, target_from, target_through,
          refusal_reason)
       VALUES ('latest-refused-private-run', 'plaid-private-coverage-source-4488', 'sweep',
               2500, 2600, 1, 5, 4, 0, 0, 1, 0, 1,
               '2025-01-01T00:00:00Z', '2025-12-31T23:59:59Z',
               '2025-01-01T00:00:00Z', '2025-12-31T23:59:59Z',
               'private provider refusal detail')`,
    );
    const refused = await json(await fixture.post(PATH, {
      sections: ["accounts"], limit: 25,
    }, ADMIN));
    assert.equal(refused.response.status, 200);
    const refusedCoverage = refused.body.sections.accounts.records[0]
      .verification.freshness.source_coverage;
    assert.deepEqual(refusedCoverage.counts, { seen: 5, accepted: 4, refused: 1, failed: 0 });
    assert.deepEqual(refusedCoverage.confirmed_range, { from: null, through: null });

    fixture.raw(
      `INSERT INTO sync_runs
         (run_id, source, lane, started_at, finished_at, walk_complete, files_seen,
          docs_added, docs_updated, docs_unchanged, docs_refused, docs_failed,
          metrics_version, confirmed_from, confirmed_through, target_from, target_through)
       VALUES ('new-clean-private-run', 'plaid-private-coverage-source-4488', 'sweep',
               3000, 3100, 1, 7, 5, 1, 1, 0, 0, 1,
               '2026-01-01T00:00:00Z', '2026-06-30T23:59:59Z',
               '2026-01-01T00:00:00Z', '2026-06-30T23:59:59Z')`,
    );
    const second = await json(await fixture.post(PATH, {
      sections: ["accounts"], limit: 25,
    }, ADMIN));
    assert.equal(second.response.status, 200);
    const secondCoverage = second.body.sections.accounts.records[0]
      .verification.freshness.source_coverage;
    assert.deepEqual(secondCoverage.counts, { seen: 7, accepted: 7, refused: 0, failed: 0 });
    assert.deepEqual(secondCoverage.confirmed_range, {
      from: "2026-01-01T00:00:00.000Z",
      through: "2026-06-30T23:59:59.000Z",
    });
    const serialized = JSON.stringify(second.body);
    assert.equal(serialized.includes("plaid-private-coverage-source-4488"), false);
    assert.equal(serialized.includes("new-clean-private-run"), false);
    assert.equal(serialized.includes("private provider refusal detail"), false);
  } finally {
    fixture.close();
  }
});

test("raw indexing status cannot become an operational freshness verdict", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO sources
         (name, kind, status, created_at, last_ingest_at, expected_refresh_seconds)
       VALUES ('stuck-private-source-4488', 'plaid', 'indexing',
               '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 86400)`,
    );
    fixture.raw(
      `INSERT INTO sync_runs (run_id, source, lane, started_at, finished_at)
       VALUES ('stuck-private-run-9911', 'stuck-private-source-4488', 'sweep',
               1000, NULL)`,
    );
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, institution, account_kind, balance_role,
          currency, feed_mode, status, provenance, source_feed, basis_state, recorded_at)
       VALUES ('primary', 'stuck-account', 'orchard-cafe', 'Stuck Bank', 'checking',
               'asset', 'USD', 'live', 'open', 'feed', 'stuck-private-source-4488',
               'confirmed', '2026-09-01T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["accounts"], limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);
    const coverage = body.sections.accounts.records[0]
      .verification.freshness.source_coverage;
    assert.equal(coverage.live_updates_state, "unavailable");
    assert.equal(coverage.history_state, "running");
    assert.equal(coverage.waiting_on_owner_machine, null);
    assert.ok(coverage.missing_fields.includes("live_update_freshness"));
    assert.ok(coverage.missing_fields.includes("owner_machine_wait_state"));
    assert.doesNotMatch(
      JSON.stringify(coverage),
      /"live_updates_state":"(?:catching_up|current|stale)"/,
    );
    assert.equal(JSON.stringify(body).includes("stuck-private-run-9911"), false);
    assert.equal(JSON.stringify(body).includes("stuck-private-source-4488"), false);
  } finally {
    fixture.close();
  }
});

test("missing corpus evidence remains counted as unassessed group debt", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, custody_class,
          availability, filed_at, corpus_doc_uid, readable, restricted, provenance,
          source_doc_uid, source_locator, basis_state, recorded_at)
       VALUES ('primary', 'missing-corpus-fin-doc', 'orchard-cafe', 'profit_and_loss',
               'Missing corpus fixture', 'reconcilable', 'have_it',
               '2026-09-05', 'missing-private-corpus-document', 1, 0, 'extracted',
               'missing-private-corpus-document', 'private-locator', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["books"], limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);
    const record = body.sections.books.records.find(
      (item) => item.record_type === "books_document_evidence",
    );
    assert.deepEqual(record.extraction_group_evidence, {
      evidence_records: 1,
      provenance_assessed_records: 0,
      provenance_unassessed_records: 1,
      missing_text_source: 1,
      missing_text_reliable: 1,
    });
    assert.equal(record.verification.extraction.provenance_assessed, false);
    assert.equal(record.verification.extraction.provenance_reason,
      "provenance_group_incomplete_or_bounded");
    assert.equal(record.verification.blocks_financial_verification, true);
    assert.equal(JSON.stringify(body).includes("missing-private-corpus-document"), false);
  } finally {
    fixture.close();
  }
});

test("QBO group provenance is bounded and omitted rows stay explicit debt", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    fixture.raw(
      `INSERT INTO sources (name, kind, status, created_at)
       VALUES ('bounded-qbo-private-source', 'quickbooks', 'ready',
               '2026-09-01T00:00:00Z')`,
    );
    const fingerprint = "b".repeat(64);
    for (let index = 0; index < 55; index += 1) {
      const suffix = String(index).padStart(2, "0");
      fixture.raw(
        `INSERT INTO documents
           (doc_uid, source, source_id, title, ingested_at, meta, entity_slug,
            text_source, text_reliable, content_hash)
         VALUES (?, 'bounded-qbo-private-source', ?, 'Bounded books fixture',
                 1757030400000, ?, 'orchard-cafe', 'native', 1, ?)`,
        `bounded-private-document-${suffix}`,
        `bounded-private-provider-id-${suffix}`,
        provenanceMeta("bounded-qbo-private-source", `bounded-private-provider-id-${suffix}`, {
          qbo_company_fingerprint: fingerprint,
        }),
        `bounded-private-content-hash-${suffix}`,
      );
    }

    fixture.seen.sql.length = 0;
    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["books"], limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);
    const record = body.sections.books.records.find((item) => item.evidence_count === 55);
    assert.ok(record);
    assert.deepEqual(record.extraction_group_evidence, {
      evidence_records: 55,
      provenance_assessed_records: 50,
      provenance_unassessed_records: 5,
      missing_text_source: 5,
      missing_text_reliable: 5,
    });
    assert.equal(record.verification.extraction.provenance_assessed, false);
    assert.equal(record.verification.extraction.provenance_reason,
      "provenance_group_incomplete_or_bounded");
    assert.ok(record.source_lineage.missing_fields.includes("stored_provenance_receipt"));
    assert.equal(record.verification.blocks_financial_verification, true);
    assert.equal(
      fixture.seen.sql.some((sql) =>
        /FILTER \(WHERE q\.provenance_rank <= 50\)/.test(sql) &&
        /ROW_NUMBER\(\) OVER/.test(sql)),
      true,
      "the D1 snapshot query must bound raw grouped provenance before materialization",
    );
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("bounded-private-provider-id"), false);
    assert.equal(serialized.includes("bounded-private-document"), false);
  } finally {
    fixture.close();
  }
});

test("unreliable extraction and unreceipted QBO metadata are explicit blocking gaps", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `UPDATE documents SET text_reliable = NULL WHERE doc_uid = 'corpus-tax-return'`,
    );
    fixture.raw(
      `INSERT INTO documents
         (doc_uid, source, source_id, title, document_date, ingested_at, content_hash,
          meta, entity_slug, text_source, text_reliable)
       VALUES ('qbo-missing-extraction-metadata', 'quickbooks-fixture', 'private-source-id',
               'Missing extraction metadata fixture', 1735689600000, 1757030400000,
               'private-content-hash', ?, 'orchard-cafe', NULL, NULL)`,
      JSON.stringify({ qbo_company_fingerprint: HASH }),
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["books", "tax_returns"], limit: 50,
    }, ADMIN));
    assert.equal(response.status, 200);
    const tax = body.sections.tax_returns.records.find(
      (record) => record.evidence_kind === "tax_return",
    );
    assert.equal(tax.verification.extraction.state, "native");
    assert.equal(tax.verification.extraction.provenance_assessed, true);
    assert.equal(tax.verification.extraction.text_reliable, false);
    assert.ok(tax.verification.blocking_reasons.includes("extraction_text_unreliable"));

    const books = body.sections.books.records.find(
      (record) => record.record_type === "quickbooks_company_observation",
    );
    assert.deepEqual(books.extraction_group_evidence, {
      evidence_records: 2,
      provenance_assessed_records: 1,
      provenance_unassessed_records: 1,
      missing_text_source: 1,
      missing_text_reliable: 1,
    });
    assert.equal(books.verification.extraction.state, "unavailable");
    assert.equal(books.verification.extraction.provenance_assessed, false);
    assert.equal(books.verification.extraction.provenance_reason,
      "provenance_receipt_missing_or_invalid");
    assert.ok(books.verification.missing_extraction_fields.includes("text_source"));
    assert.ok(books.verification.missing_extraction_fields.includes("text_reliable"));
    assert.ok(books.verification.missing_extraction_fields.includes("stored_provenance_receipt"));
    assert.ok(books.verification.blocking_reasons.includes("extraction_reliability_unavailable"));
  } finally {
    fixture.close();
  }
});

test("unresolved and conflicting lineage stay debt, and absent mappings are never confirmed", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `UPDATE fin_documents SET source_feed = 'tax-archive'
        WHERE fin_doc_uid = 'private-fin-doc-id'`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, doc_kind, title, custody_class, availability,
          filed_at, readable, restricted, provenance, basis_state, recorded_at)
       VALUES ('primary', 'null-mapping-evidence', 'receipt', 'Owner supplied receipt',
               'reference', 'have_it', '2026-09-05', 1, 0, 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, custody_class,
          availability, filed_at, readable, restricted, provenance, basis_state,
          recorded_at, superseded_by_id)
       VALUES ('primary', 'superseded-only-source', 'orchard-cafe', 'receipt',
               'superseded source fixture', 'reference', 'have_it', '2026-08-01',
               1, 0, 'owner_stated', 'confirmed', '2026-08-01T00:00:00Z', 999)`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, custody_class,
          availability, filed_at, readable, restricted, provenance, source_doc_uid,
          source_locator, basis_state, recorded_at)
       VALUES ('primary', 'current-cites-superseded', 'orchard-cafe', 'receipt',
               'current row with invalidated source fixture', 'reference', 'have_it',
               '2026-09-05', 1, 0, 'extracted', 'superseded-only-source', 'page 1',
               'confirmed', '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["entities", "evidence"],
      provenance_baseline: { recorded_at: "2026-08-31T00:00:00.000Z" },
      limit: 50,
    }, ADMIN));
    assert.equal(response.status, 200);

    const unresolved = body.sections.entities.records.find(
      (row) => row.stored_name.legal_name === "Unrelated Client LLC",
    );
    assert.equal(unresolved.source_lineage.state, "document_reference_unresolved");
    assert.ok(unresolved.source_lineage.reason_codes.includes(
      "missing_source_document_reference_resolution",
    ));
    assert.equal(unresolved.verification.provenance_debt, true);

    const conflict = body.sections.evidence.records.find(
      (row) => row.evidence_kind === "profit_and_loss",
    );
    assert.match(conflict.source_lineage.source_feed_ref, /^source_feed_v2_[a-f0-9]{64}$/);
    assert.equal(conflict.source_lineage.source_feed_kind, "upload");
    assert.equal(conflict.source_lineage.source_feed_registry_state, "resolved");
    assert.equal(conflict.source_lineage.linked_corpus_source_kind, "quickbooks");
    assert.match(conflict.source_lineage.linked_corpus_source_ref,
      /^corpus_source_v2_[a-f0-9]{64}$/);
    assert.ok(conflict.source_lineage.reason_codes.includes("source_feed_corpus_source_conflict"));
    assert.equal(conflict.verification.provenance_debt, true);

    const invalidatedSource = body.sections.evidence.records.find(
      (row) => row.evidence_kind === "receipt" &&
        row.source_lineage.source_document_reference_state === "unresolved",
    );
    assert.equal(invalidatedSource.current_state, "current");
    assert.equal(invalidatedSource.source_lineage.source_document_reference_state, "unresolved");
    assert.equal(invalidatedSource.source_lineage.state, "document_reference_unresolved");
    assert.ok(
      invalidatedSource.source_lineage.reason_codes.includes(
        "missing_source_document_reference_resolution",
      ),
    );
    assert.equal(invalidatedSource.verification.provenance_debt, true);

    const danglingSupersession = body.sections.evidence.records.find(
      (row) => row.current_state === "supersession_unresolved",
    );
    assert.ok(danglingSupersession);
    assert.equal(danglingSupersession.supersession.reference_state, "unresolved_or_mismatched");
    assert.equal(danglingSupersession.superseded_by_ref, null);
    assert.ok(
      danglingSupersession.verification.missing_provenance_fields
        .includes("superseded_by_reference_resolution"),
    );
    assert.equal(
      body.sections.evidence.reference_integrity.counts.document_supersession_target,
      1,
    );

    const missing = body.sections.evidence.records.find(
      (row) => row.evidence_kind === "receipt" && row.entity_ref === null,
    );
    assert.equal(missing.mapping_confirmation.field_states.entity, "stored_value_missing");
    assert.equal(missing.mapping_confirmation.field_states.period, "stored_value_missing");
    assert.equal(missing.mapping_confirmation.field_states.evidence_role, "stored_owner_assertion_unconfirmed");
    assert.equal(missing.mapping_confirmation.state, "stored_owner_assertions_unconfirmed");
    assert.ok(missing.verification.missing_verification_fields.includes("entity_stored_value_missing"));
    assert.ok(missing.verification.missing_verification_fields.includes("period_stored_value_missing"));
    assert.ok(missing.verification.blocking_reasons.includes("mapping_confirmation_incomplete"));
  } finally {
    fixture.close();
  }
});

test("conflict claims and exceptions keep stored-feed versus cited-document source conflicts", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `INSERT INTO fin_reconciliation_claims
         (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency,
          as_of, provenance, source_doc_uid, source_locator, source_feed,
          basis_state, recorded_at)
       VALUES ('primary', 'feed-document-conflict-claim', 'private-reconciliation-id',
               'feed conflict fixture', 50001, 'USD', '2024-12-31', 'feed',
               'gmail:provider-message-sentinel-445566',
               '{"qbo_account_id":"qbo-provider-account-sentinel-556677","cited_records":1}',
               'bank-feed:conflict-item-sentinel-990011', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `UPDATE fin_exceptions
          SET source_feed = 'tax-archive',
              source_doc_uid = 'gmail:provider-message-sentinel-445566',
              source_locator =
                '{"qbo_account_id":"qbo-exception-account-sentinel-889900","cited_records":1}',
              recorded_at = '2026-09-05T00:00:00Z'
        WHERE exception_uid = 'private-exception-id'`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["conflicts"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);

    const reconciliation = body.sections.conflicts.records.find(
      (record) => record.conflict_type === "reconciliation",
    );
    const root = reconciliation.source_lineage.derivation_roots.find(
      (record) => record.source_feed_present && record.source_feed_registry_state === "unresolved",
    );
    assert.match(root.source_feed_ref, /^source_feed_v2_[a-f0-9]{64}$/);
    assert.equal(root.source_feed_kind, null);
    assert.equal(root.source_feed_kind_state, "unavailable_or_unrecognized");
    assert.equal(root.source_feed_registry_state, "unresolved");
    assert.equal(root.linked_corpus_source_kind, "quickbooks");
    assert.match(root.linked_corpus_source_ref, /^corpus_source_v2_[a-f0-9]{64}$/);
    assert.equal(root.source_locator_present, true);
    assert.match(root.source_locator_ref, /^source_locator_v2_[a-f0-9]{64}$/);
    assert.ok(root.provenance_reason_codes.includes("source_feed_corpus_source_conflict"));
    assert.equal(root.verification.provenance_debt, true);

    const exception = body.sections.conflicts.records.find(
      (record) => record.conflict_type === "exception",
    );
    assert.match(exception.source_lineage.source_feed_ref, /^source_feed_v2_[a-f0-9]{64}$/);
    assert.equal(exception.source_lineage.source_feed_kind, "upload");
    assert.equal(exception.source_lineage.source_feed_registry_state, "resolved");
    assert.equal(exception.source_lineage.linked_corpus_source_kind, "quickbooks");
    assert.equal(exception.source_lineage.source_locator_present, true);
    assert.match(
      exception.source_lineage.source_locator_ref,
      /^source_locator_v2_[a-f0-9]{64}$/,
    );
    assert.ok(
      exception.source_lineage.reason_codes.includes("source_feed_corpus_source_conflict"),
    );
    assert.equal(exception.verification.provenance_debt, true);
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(
      body.provenance_debt_gate.debt_reason_codes.source_feed_corpus_source_conflict >= 2,
      true,
    );
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("qbo-provider-account-sentinel-556677"), false);
    assert.equal(serialized.includes("qbo-exception-account-sentinel-889900"), false);
    assert.equal(serialized.includes("bank-feed:conflict-item-sentinel-990011"), false);
    assert.equal(serialized.includes("gmail:provider-message-sentinel-445566"), false);
    assert.doesNotMatch(serialized, /"(?:source_doc_uid|source_feed|linked_corpus_source)":/);
  } finally {
    fixture.close();
  }
});

test("conflict roots and exception transactions resolve their stored ledger targets", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "orchard-cafe", "Orchard Cafe");
    seedOwnedEntity(fixture, "other-entity", "Other Entity");
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
          feed_mode, status, provenance, basis_state, recorded_at)
       VALUES ('primary', 'orchard-operating', 'orchard-cafe', 'checking', 'asset',
               'USD', 'manual', 'open', 'owner_stated', 'confirmed',
               '2026-09-01T00:00:00Z'),
              ('primary', 'other-operating', 'other-entity', 'checking', 'asset',
               'USD', 'manual', 'open', 'owner_stated', 'confirmed',
               '2026-09-01T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_transactions
         (tenant_id, txn_uid, account_slug, posted_on, amount_minor, direction,
          provenance, basis_state, recorded_at)
       VALUES ('primary', 'other-account-transaction-sentinel-112233',
               'other-operating', '2025-12-15', 100, 'inflow', 'owner_stated',
               'confirmed', '2026-09-05T00:00:00Z'),
              ('primary', 'matching-account-transaction-sentinel-778811',
               'orchard-operating', '2025-12-16', 100, 'inflow', 'owner_stated',
               'confirmed', '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_documents
         (tenant_id, fin_doc_uid, doc_kind, title, custody_class, availability,
          readable, restricted, provenance, basis_state, recorded_at)
       VALUES ('primary', 'unscoped-document-target-sentinel-991122', 'receipt',
               'Unscoped target', 'reference', 'do_not_have_it', 1, 0,
               'owner_stated', 'confirmed', '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_reconciliations
         (tenant_id, reconciliation_uid, entity_slug, account_slug, period_start,
          period_end, measure, state, delta_minor, computed_at, recorded_at)
       VALUES ('primary', 'target-check', 'orchard-cafe', 'orchard-operating',
               '2025-01-01', '2025-12-31', 'period_receipts',
               'insufficient_evidence', NULL, '2026-09-05T00:00:00Z',
               '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_reconciliation_claims
         (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, as_of,
          claim_ref_table, claim_ref_uid, provenance, basis_state, recorded_at)
       VALUES ('primary', 'missing-document-claim', 'target-check', 'Missing document',
               100, '2025-12-31', 'fin_documents', 'missing-document-target',
               'owner_stated', 'confirmed', '2026-09-05T00:00:00Z'),
              ('primary', 'unsupported-balance-claim', 'target-check', 'Balance snapshot',
               100, '2025-12-31', 'fin_balance_snapshots', 'opaque-balance-target',
               'owner_stated', 'confirmed', '2026-09-05T00:00:00Z'),
              ('primary', 'wrong-account-claim', 'target-check', 'Wrong account target',
               100, '2025-12-31', 'fin_transactions',
               'other-account-transaction-sentinel-112233', 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z'),
              ('primary', 'matching-account-claim', 'target-check', 'Matching account target',
               100, '2025-12-31', 'fin_transactions',
               'matching-account-transaction-sentinel-778811', 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z'),
              ('primary', 'unscoped-document-claim', 'target-check', 'Unscoped document target',
               100, '2025-12-31', 'fin_documents',
               'unscoped-document-target-sentinel-991122', 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z'),
              ('primary', 'orphan-parent-claim', 'missing-parent', 'Orphan parent',
               100, '2025-12-31', NULL, NULL, 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z'),
              ('primary', 'partial-reference-claim', 'target-check', 'Partial reference',
               100, '2025-12-31', NULL, 'partial-claim-target-sentinel-445566',
               'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );
    fixture.raw(
      `INSERT INTO fin_exceptions
         (tenant_id, exception_uid, entity_slug, kind, issue, txn_uid,
          txn_account_slug, first_seen, provenance, basis_state, recorded_at)
       VALUES ('primary', 'missing-transaction-exception', 'orchard-cafe', 'other',
               'Missing transaction target', 'missing-transaction-target',
               'orchard-operating', '2026-09-05', 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z'),
              ('primary', 'account-conflict-exception', 'orchard-cafe', 'other',
               'Transaction belongs to a different account',
               'other-account-transaction-sentinel-112233', 'orchard-operating',
               '2026-09-05', 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z'),
              ('primary', 'entity-conflict-exception', 'orchard-cafe', 'other',
               'Transaction belongs to a different entity',
               'other-account-transaction-sentinel-112233', NULL,
               '2026-09-05', 'owner_stated', 'confirmed',
               '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["conflicts"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 200);
    const reconciliation = body.sections.conflicts.records.find(
      (record) => record.conflict_type === "reconciliation",
    );
    const missingTarget = reconciliation.source_lineage.derivation_roots.find(
      (root) => root.claim_target_kind === "document" &&
        root.claim_record_reference_state === "unresolved",
    );
    assert.equal(missingTarget.claim_record_reference_state, "unresolved");
    assert.ok(
      missingTarget.missing_provenance_fields.includes("claim_record_reference_resolution"),
    );
    assert.equal(missingTarget.verification.provenance_debt, true);
    const unsupported = reconciliation.source_lineage.derivation_roots.find(
      (root) => root.claim_target_kind === "balance_snapshot_without_stable_identifier_contract",
    );
    assert.equal(
      unsupported.claim_record_reference_state,
      "unavailable_no_stable_identifier_contract",
    );
    assert.ok(unsupported.missing_provenance_fields.includes("claim_record_identifier_contract"));
    const partialReference = reconciliation.source_lineage.derivation_roots.find(
      (root) => root.claim_target_kind === null && root.claim_record_ref !== null,
    );
    assert.equal(
      partialReference.claim_record_reference_state,
      "unavailable_reference_table_missing",
    );
    assert.ok(
      partialReference.missing_provenance_fields.includes("claim_record_identifier_contract"),
    );
    const transactionClaims = reconciliation.source_lineage.derivation_roots.filter(
      (root) => root.claim_target_kind === "transaction",
    );
    const wrongAccountClaim = transactionClaims.find(
      (root) => root.claim_record_reference_state === "scope_mapping_conflict",
    );
    assert.equal(wrongAccountClaim.claim_record_reference_state, "scope_mapping_conflict");
    assert.ok(
      wrongAccountClaim.missing_provenance_fields
        .includes("claim_record_scope_mapping_conflict"),
    );
    const matchingAccountClaim = transactionClaims.find(
      (root) => root.claim_record_reference_state === "current_record_resolved",
    );
    assert.ok(matchingAccountClaim);
    assert.deepEqual(matchingAccountClaim.missing_provenance_fields, ["owner_actor_receipt"]);
    assert.equal(matchingAccountClaim.verification.provenance_debt, true);
    const unscopedDocumentClaim = reconciliation.source_lineage.derivation_roots.find(
      (root) => root.claim_target_kind === "document" &&
        root.claim_record_reference_state === "scope_mapping_unavailable",
    );
    assert.ok(
      unscopedDocumentClaim.missing_provenance_fields
        .includes("claim_record_scope_mapping_resolution"),
    );
    const unresolvedException = body.sections.conflicts.records.find(
      (record) => record.transaction_reference_state === "unresolved",
    );
    assert.ok(
      unresolvedException.verification.missing_provenance_fields
        .includes("exception_transaction_reference_resolution"),
    );
    const accountConflictException = body.sections.conflicts.records.find(
      (record) => record.transaction_reference_state === "account_mapping_conflict",
    );
    assert.ok(
      accountConflictException.verification.missing_provenance_fields
        .includes("exception_transaction_account_mapping"),
    );
    const entityConflictException = body.sections.conflicts.records.find(
      (record) => record.transaction_reference_state === "entity_mapping_conflict",
    );
    assert.ok(
      entityConflictException.verification.missing_provenance_fields
        .includes("exception_transaction_entity_mapping"),
    );
    const counts = body.sections.conflicts.reference_integrity.counts;
    assert.equal(counts.reconciliation_claim_parent, 1);
    assert.equal(counts.reconciliation_claim_target, 3);
    assert.equal(counts.reconciliation_claim_target_identifier_unavailable, 2);
    assert.equal(counts.exception_transaction, 1);
    assert.equal(counts.exception_transaction_account_conflict, 1);
    assert.equal(counts.exception_transaction_entity_conflict, 2);
    assert.equal(counts.exception_transaction_scope_unavailable, 0);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("partial-claim-target-sentinel-445566"), false);
    assert.equal(serialized.includes("other-account-transaction-sentinel-112233"), false);
    assert.equal(serialized.includes("matching-account-transaction-sentinel-778811"), false);
    assert.equal(serialized.includes("unscoped-document-target-sentinel-991122"), false);
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
  } finally {
    fixture.close();
  }
});

test("an open zero-net reconciliation remains visible as an unresolved conflict", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `INSERT INTO fin_reconciliations
         (tenant_id, reconciliation_uid, entity_slug, account_slug, period_start,
          period_end, measure, state, delta_minor, tolerance_minor, currency,
          computed_at, recorded_at)
       VALUES ('primary', 'open-line-conflict', 'orchard-cafe', 'orchard-operating',
               '2025-01-01', '2025-01-31', 'net_activity', 'open', 0, 0, 'USD',
               '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["conflicts"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 25,
    }, ADMIN));
    assert.equal(response.status, 200);
    const open = body.sections.conflicts.records.find(
      (record) => record.conflict_state === "open" && record.conflict_kind === "net_activity",
    );
    assert.ok(open, "a zero-net reconciliation with unresolved line conflicts must remain visible");
    assert.equal(open.verification.provenance_debt, true);
    assert.ok(open.verification.provenance_reason_codes.includes("missing_derivation_roots"));
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(body.provenance_debt_gate.new_records_with_provenance_debt >= 1, true);
  } finally {
    fixture.close();
  }
});

test("nested conflict lineage is bounded and names root truncation as debt", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    for (let index = 0; index < 55; index += 1) {
      fixture.raw(
        `INSERT INTO fin_reconciliation_claims
           (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency,
            as_of, provenance, basis_state, recorded_at)
         VALUES ('primary', ?, 'private-reconciliation-id', 'bounded fixture root',
                 ?, 'USD', '2024-12-31', 'owner_stated', 'confirmed',
                 '2026-09-03T00:00:00Z')`,
        `bounded-claim-${String(index).padStart(2, "0")}`,
        50_000 + index,
      );
    }
    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["conflicts"],
      limit: 10,
    }, ADMIN));
    assert.equal(response.status, 200);
    const reconciliation = body.sections.conflicts.records.find(
      (row) => row.conflict_type === "reconciliation",
    );
    assert.equal(reconciliation.derivation_root_page.total, 56);
    assert.equal(reconciliation.derivation_root_page.returned, 50);
    assert.equal(reconciliation.derivation_root_page.truncated, true);
    assert.ok(
      reconciliation.source_lineage.missing_fields.includes("derivation_roots_complete"),
    );
    assert.equal(reconciliation.verification.provenance_debt, true);
  } finally {
    fixture.close();
  }
});

test("a baseline gate cannot pass when newer debt may be beyond the bounded root page", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.raw(
      `UPDATE fin_reconciliations
          SET recorded_at = '2026-08-01T00:00:00Z'
        WHERE reconciliation_uid = 'private-reconciliation-id'`,
    );
    fixture.raw(
      `UPDATE fin_reconciliation_claims
          SET recorded_at = '2026-08-01T00:00:00Z'
        WHERE reconciliation_uid = 'private-reconciliation-id'`,
    );
    for (let index = 0; index < 50; index += 1) {
      fixture.raw(
        `INSERT INTO fin_reconciliation_claims
           (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency,
            as_of, provenance, basis_state, recorded_at)
         VALUES ('primary', ?, 'private-reconciliation-id', 'complete newer root',
                 ?, 'USD', '2024-12-31', 'owner_stated', 'confirmed',
                 '2026-09-03T00:00:00Z')`,
        `aa-complete-root-${String(index).padStart(2, "0")}`,
        60_000 + index,
      );
    }
    fixture.raw(
      `INSERT INTO fin_reconciliation_claims
         (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency,
          as_of, provenance, basis_state, unparsed_reason, recorded_at)
       VALUES ('primary', 'zz-new-debt-beyond-page', 'private-reconciliation-id',
               'unresolved newer root', NULL, 'USD', '2024-12-31', 'owner_stated',
               'unparsed', 'fixture unresolved root', '2026-09-03T00:00:00Z')`,
    );

    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["conflicts"],
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 10,
    }, ADMIN));
    assert.equal(response.status, 200);
    const section = body.sections.conflicts;
    const reconciliation = section.records.find(
      (record) => record.conflict_type === "reconciliation",
    );
    assert.equal(section.truncated, false);
    assert.equal(reconciliation.derivation_root_page.truncated, true);
    assert.ok(
      section.verification_gap_summary.scope_reason_codes
        .includes("nested_provenance_truncated"),
    );
    assert.ok(
      section.verification_gap_summary.scope_reason_codes
        .includes("unresolved_stable_references"),
    );
    assert.equal(section.verification_gap_summary.covers_all_matching_records, false);
    assert.equal(
      section.verification_gap_summary.provenance_debt_since_baseline.state,
      "insufficient_scope",
    );
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.equal(body.provenance_debt_gate.covers_all_evaluated_matching_records, false);
  } finally {
    fixture.close();
  }
});

test("a D1 batch failure returns explicit unavailable sections without leaking the database error", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.control.failNextBatch = true;
    const { response, body } = await json(await fixture.post(PATH, { limit: 10 }, ADMIN));
    assert.equal(response.status, 503);
    assert.equal(body.unavailable, true);
    assert.equal(body.snapshot.consistency, "unavailable");
    assert.equal(JSON.stringify(body).includes("fixture database unavailable"), false);
    for (const section of Object.values(body.sections)) {
      assert.equal(section.unavailable, true);
      assert.equal(section.state, "unavailable");
      assert.equal(section.returned, 0);
      assert.equal(section.total, null);
      assert.equal(Object.hasOwn(section, "records"), false);
    }
  } finally {
    fixture.close();
  }
});

test("a D1 session failure still returns the complete Unavailable contract", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    fixture.env.DB = {
      ...fixture.DB,
      withSession() { throw new Error("fixture session detail must not escape"); },
    };
    const { response, body } = await json(await fixture.post(PATH, {}, ADMIN));
    assert.equal(response.status, 503);
    assert.equal(body.read_only, true);
    assert.equal(body.mutation_count, 0);
    assert.equal(body.snapshot.consistency, "unavailable");
    assert.deepEqual(body.sections_unavailable, [
      "entities", "periods", "accounts", "books", "payroll", "tax_returns",
      "filing_payments", "evidence", "conflicts",
    ]);
    assert.equal(JSON.stringify(body).includes("fixture session detail"), false);
    for (const section of Object.values(body.sections)) {
      assert.equal(section.unavailable, true);
      assert.equal(section.total, null);
      assert.equal(section.returned, 0);
    }
  } finally {
    fixture.close();
  }
});

test("missing per-Brain reference signing material fails closed before records are exposed", async () => {
  const fixture = await createProductFixture();
  try {
    seedFinancialPicture(fixture);
    delete fixture.env.SESSION_SIGNING_KEY;
    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["entities", "accounts"],
      limit: 100,
    }, ADMIN));
    assert.equal(response.status, 503);
    assert.deepEqual(body.sections_unavailable, [...FINANCIAL_PICTURE_SECTIONS]);
    assert.equal(body.sections.entities.unavailable_reason, "privacy_reference_signing_unavailable");
    assert.equal(Object.hasOwn(body.sections.entities, "records"), false);
    assert.equal(JSON.stringify(body).includes("orchard-cafe"), false);
  } finally {
    fixture.close();
  }
});

test("an unsupported-only request still has one read snapshot and never guesses payroll", async () => {
  const fixture = await createProductFixture();
  try {
    fixture.seen.sql.length = 0;
    const { response, body } = await json(await fixture.post(PATH, {
      sections: ["payroll"],
      filters: { entity_slug: null, tax_year: 2025 },
      provenance_baseline: { recorded_at: "2026-09-01T00:00:00.000Z" },
      limit: 5,
    }, ADMIN));
    assert.equal(response.status, 200);
    assert.equal(body.snapshot.consistency, "single_d1_batch");
    assert.deepEqual(body.sections_requested, ["payroll"]);
    assert.deepEqual(body.sections_unavailable, ["payroll"]);
    assert.equal(body.sections.payroll.unavailable, true);
    assert.equal(body.sections.payroll.total, null);
    assert.equal(
      body.sections.payroll.verification_gap_summary.provenance_debt_since_baseline.state,
      "insufficient_scope",
    );
    assert.ok(body.sections.payroll.unavailable_fields.includes("applicability"));
    assert.ok(body.sections.payroll.unavailable_fields.includes("freshness_evaluation_policy"));
    assert.equal(body.provenance_debt_gate.state, "insufficient_scope");
    assert.deepEqual(body.provenance_debt_gate.sections_excluded_as_unavailable, ["payroll"]);
    assert.deepEqual(body.provenance_debt_gate.scope_reason_codes, [
      "requested_sections_unavailable",
    ]);
    assert.equal(body.provenance_debt_gate.covers_all_evaluated_matching_records, false);
    assert.equal(
      fixture.seen.sql.filter((sql) => /SELECT schema_version FROM install_state/.test(sql)).length,
      1,
      "unsupported-only inventory still anchors one D1 batch",
    );
    assert.equal(
      fixture.seen.sql.some((sql) => /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)),
      false,
    );
  } finally {
    fixture.close();
  }
});

test("request validation precedes an unavailable schema", async () => {
  const fixture = await createProductFixture();
  try {
    const invalidShape = await json(await fixture.post(PATH, [], ADMIN));
    assert.equal(invalidShape.response.status, 400);
    assert.equal(invalidShape.body.code, "invalid_request");

    const invalidJsonResponse = await fixture.worker.fetch(new Request(
      `https://brain.invalid${PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ADMIN },
        body: "{",
      },
    ), fixture.env, { waitUntil() {}, passThroughOnException() {} });
    const invalidJson = await json(invalidJsonResponse);
    assert.equal(invalidJson.response.status, 400);
    assert.equal(invalidJson.body.code, "invalid_json");

    fixture.raw("DROP TABLE fin_accounts");
    const malformed = await json(await fixture.post(PATH, { surprise: true }, ADMIN));
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.code, "invalid_request_field");

    const unavailable = await json(await fixture.post(PATH, { sections: ["accounts"] }, ADMIN));
    assert.equal(unavailable.response.status, 200);
    assert.equal(unavailable.body.snapshot.consistency, "unavailable");
    assert.equal(unavailable.body.sections.accounts.unavailable, true);
    assert.match(unavailable.body.sections.accounts.unavailable_reason, /schema_not_installed/);
  } finally {
    fixture.close();
  }
});

test("the inventory module has no generic-search or asynchronous write path", () => {
  assert.doesNotMatch(MODULE_SOURCE, /\/api\/rag|chunks_fts|VECTORIZE|waitUntil\s*\(/);
  assert.match(MODULE_SOURCE, /database\.batch\(statements\)/);
  assert.doesNotMatch(MODULE_SOURCE, /database\.(?:exec|run)\s*\(/);
});
