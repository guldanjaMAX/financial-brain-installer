import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/index.js";
import { computeAnswerConfidence } from "../src/lib/confidence.js";
import {
  answerUsesOperativeValue,
  answerUsesSupersededValue,
  agreementVerdict,
  authorityFor,
  bestTier,
  operativeSectionForQuery,
  ownerConfirmedRecord,
  tierOf,
} from "../src/lib/evidence-authority.js";
import { hasExplicitCurrentIntent, queryEntityAnchors } from "../src/lib/query-intent.js";
import { SEARCH_UNAVAILABLE } from "../src/lib/retrieval-status.js";
import { search, unchunkedTaxDocumentCandidates } from "../src/lib/store-d1.js";
import { taxQuestionScope } from "../src/lib/tax-evidence-scope.js";

const ownerRow = ({
  day = "2026-09-01",
  id = "confirmation-1",
  value = "100 New Avenue",
  supersedes = "50 Old Road",
  fact = "Mailing address",
} = {}) => ({
  chunk_uid: `curated:owner-confirmed/${day}/${id}#0`,
  doc_uid: `curated:owner-confirmed/${day}/${id}`,
  source: "curated",
  source_id: `owner-confirmed/${day}/${id}`,
  title: `Confirmed by the owner, ${day}`,
  category: "owner-confirmed",
  client: "Taylor",
  document_date: Date.parse(`${day}T12:00:00.000Z`),
  date_source: "owner_confirmation",
  date_reliable: 1,
  text_source: "native",
  text_reliable: 1,
  authority_meta: JSON.stringify({
    authority: "T1", operative: true, subject: "Taylor", client_name: "Taylor",
  }),
  text: [
    `# Confirmed by the owner, ${day}`,
    "",
    "Subject: Taylor",
    "",
    `## ${fact}`,
    `Operative value: ${value}`,
    `As of: ${day}, confirmed by the owner`,
    `Supersedes: ${supersedes}`,
  ].join("\n"),
});

test("the complete D1 tuple identifies one section-specific owner operative record", () => {
  const row = ownerRow();
  assert.deepEqual(ownerConfirmedRecord(row), { valid: true, day: "2026-09-01" });
  assert.deepEqual(operativeSectionForQuery(row, "What is Taylor's current mailing address?"), {
    name: "Mailing address",
    value: "100 New Avenue",
    as_of: "2026-09-01",
    supersedes: ["50 Old Road"],
  });
  const authority = authorityFor(row, {
    query: "What is Taylor's current mailing address?",
    current: true,
  });
  assert.equal(authority.tier, "T1");
  assert.equal(authority.operative, true);
  assert.equal(authority.authoritative, true);

  const unrelated = authorityFor(row, {
    query: "What is Taylor's current phone number?",
    current: true,
  });
  assert.equal(unrelated.operative, false);
  assert.equal(unrelated.operative_section, undefined);
  assert.equal(unrelated.eligible, false);
  assert.equal(unrelated.authoritative, false);

  for (const mutation of [
    { authority_meta: JSON.stringify({ authority: "T1", operative: false }) },
    { authority_meta: JSON.stringify({ authority: "T1", operative: true, subject: "Taylor", client_name: "Other" }) },
    { authority_meta: JSON.stringify({ authority: "T1", operative: true, subject: "Other", client_name: "Taylor" }) },
    { client: "Other" },
    { authority_document_head: row.text.replace("Subject: Taylor", "Subject: Other") },
    { authority_document_head: row.text.replace("Subject: Taylor\n\n", "") },
    { date_source: "file_mtime" },
    { date_reliable: 0 },
    { text_source: "ocr", text_reliable: 0 },
    { source_id: "owner-confirmed/2026-09-01" },
  ]) {
    assert.equal(ownerConfirmedRecord({ ...row, ...mutation }).valid, false);
  }

  const laterChunk = {
    ...row,
    client: "  TAYLOR  ",
    authority_meta: JSON.stringify({
      authority: "T1", operative: true, subject: "Taylor", client_name: "taylor",
    }),
    authority_document_head: row.text.replace("Subject: Taylor", "Subject: TAYLOR"),
    text: row.text.slice(row.text.indexOf("## Mailing address")),
  };
  assert.equal(ownerConfirmedRecord(laterChunk).valid, true);
});

test("a multi-section owner record receives operative authority only for an unambiguous matching section", () => {
  const row = ownerRow();
  row.text += [
    "",
    "## Mobile number",
    "Operative value: (555) 123-4567",
    "As of: 2026-09-01, confirmed by the owner",
    "Supersedes: (555) 765-4321",
  ].join("\n");
  assert.equal(operativeSectionForQuery(row, "What is the current value?") , null);
  assert.equal(
    operativeSectionForQuery(row, "What is Taylor's current phone number?")?.value,
    "(555) 123-4567",
  );

  const taxId = ownerRow({ fact: "Tax identification number" });
  assert.equal(operativeSectionForQuery(taxId, "What is Taylor's current phone number?"), null);
});

test("financial authority is claim-specific and cannot establish a relationship", () => {
  const stripe = {
    source: "stripe", title: "Taylor active subscription", text_source: "native", text_reliable: true,
    ts: "2026-09-01T00:00:00.000Z", date_reliable: true,
  };
  assert.equal(tierOf(stripe).tier, "T1", "the feed is primary for its own facts");
  const relationship = authorityFor(stripe, {
    query: "Is Taylor a client?", claimText: "Taylor is an active client.", current: true,
  });
  assert.equal(relationship.eligible, false);
  assert.equal(relationship.authoritative, false);
  assert.match(relationship.reason, /not a relationship/);

  const subscription = authorityFor(stripe, {
    query: "Is Taylor's subscription active?", claimText: "Taylor's subscription is active.", current: true,
  });
  assert.equal(subscription.eligible, true);
  assert.equal(subscription.authoritative, true);

  for (const query of ["Is Taylor my vendor?", "Is Taylor still my partner?"]) {
    const relationshipRole = authorityFor(stripe, { query, current: true });
    assert.equal(relationshipRole.claim, "relationship_status");
    assert.equal(relationshipRole.eligible, false);
    assert.equal(relationshipRole.authoritative, false);
  }
});

test("a named tax form claim requires the same entity, tax year, and form", () => {
  const question = "What ordinary business income did Example Orchard LLC's 2023 Form 1065 report?";
  const base = {
    source: "drive",
    source_kind: "upload",
    text_source: "native",
    text_reliable: true,
  };
  const wrongEntityAndForm = authorityFor({
    ...base,
    title: "Example Timber Partners 2023 Schedule K-1",
    client: "Example Timber Partners",
    text: "Schedule K-1 (Form 1065), ordinary business income (loss).",
  }, { query: question });
  assert.equal(wrongEntityAndForm.tier, "T1", "the legacy title heuristic still recognizes a K-1 record type");
  assert.equal(wrongEntityAndForm.eligible, false,
    "recognizing a record type must not grant it authority over another entity's return");
  assert.equal(wrongEntityAndForm.authoritative, false);
  assert.equal(wrongEntityAndForm.tax_scope?.entity_matched, false);
  assert.equal(wrongEntityAndForm.tax_scope?.form_matched, false,
    "a Schedule K-1 is not the partnership's Form 1065 return even when its header mentions Form 1065");

  const wrongEntity = authorityFor({
    ...base,
    title: "Example Timber Partners 2023 tax return Form 1065",
    text: "Example Timber Partners, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(wrongEntity.eligible, false);
  assert.equal(wrongEntity.tax_scope?.entity_matched, false);
  assert.equal(wrongEntity.tax_scope?.year_matched, true);
  assert.equal(wrongEntity.tax_scope?.form_matched, true);

  const wrongLegalEntity = authorityFor({
    ...base,
    title: "Example Orchard LP 2023 tax return Form 1065",
    text: "Example Orchard LP, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(wrongLegalEntity.eligible, false,
    "a shared name stem must not conflate entities with different legal suffixes");
  assert.equal(wrongLegalEntity.tax_scope?.entity_matched, false);

  const wrongForm = authorityFor({
    ...base,
    title: "Example Orchard LLC 2023 Schedule K-1",
    text: "Example Orchard LLC, Schedule K-1 (Form 1065), tax year 2023.",
  }, { query: question });
  assert.equal(wrongForm.eligible, false);
  assert.equal(wrongForm.tax_scope?.entity_matched, true);
  assert.equal(wrongForm.tax_scope?.year_matched, true);
  assert.equal(wrongForm.tax_scope?.form_matched, false);

  const contradictoryStoredScope = authorityFor({
    ...base,
    entity_slug: "example-timber-partners",
    title: "Example Orchard LLC 2023 tax return Form 1065",
    text: "Example Orchard LLC, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(contradictoryStoredScope.eligible, false,
    "the exact D1 entity scope must win over a suggestive title or excerpt");
  assert.equal(contradictoryStoredScope.tax_scope?.entity_matched, false);

  const contradictorySlugAndHeader = authorityFor({
    ...base,
    entity_slug: "example-orchard-llc",
    title: "Example Orchard LLC 2023 tax return Form 1065",
    authority_document_head: "Taxpayer: Example Timber Partners. 2023 Form 1065 partnership return.",
    text: "Example Orchard LLC, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(contradictorySlugAndHeader.eligible, false,
    "a correct-looking structured entity scope must not override a different native taxpayer header");
  assert.equal(contradictorySlugAndHeader.tax_scope?.entity_matched, false);

  const secondaryPartyMention = authorityFor({
    ...base,
    title: "Example Orchard LLC 2023 tax return Form 1065",
    authority_document_head: "Taxpayer: Example Timber Partners. Partner: Example Orchard LLC. 2023 Form 1065.",
    text: "Example Orchard LLC appears as a partner.",
  }, { query: question });
  assert.equal(secondaryPartyMention.eligible, false,
    "mentioning the requested entity as a secondary party cannot make it the return's taxpayer");
  assert.equal(secondaryPartyMention.tax_scope?.entity_matched, false);

  const expandedStructuredEntity = authorityFor({
    ...base,
    entity_slug: "example-orchard-llc-holdings",
    title: "Example Orchard LLC 2023 tax return Form 1065",
    authority_document_head: "Example Orchard LLC. 2023 Form 1065 partnership return.",
    text: "Example Orchard LLC, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(expandedStructuredEntity.eligible, false,
    "a requested name cannot match only a prefix of a different structured legal entity");
  assert.equal(expandedStructuredEntity.tax_scope?.entity_matched, false);

  const misleadingFilename = authorityFor({
    ...base,
    title: "Example Orchard LLC 2023 tax return Form 1065",
    authority_document_head: "[Example Orchard LLC 2023 tax return Form 1065]\n\nExample Timber Partners. 2023 Form 1065 partnership return.",
    text: "Example Orchard LLC, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(misleadingFilename.eligible, false,
    "the title prepended to a real D1 chunk must not override a different taxpayer in the native header");
  assert.equal(misleadingFilename.tax_scope?.entity_matched, false);

  const misleadingTaxFilename = authorityFor({
    ...base,
    title: "Example Orchard LLC 2023 tax return Form 1065",
    authority_document_head: "[Example Orchard LLC 2023 tax return Form 1065]\n\nExample Orchard LLC. 2022 Form 1120-S corporate return.",
    text: "Example Orchard LLC, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(misleadingTaxFilename.eligible, false,
    "the title prepended to a real D1 chunk must not override a different year and form in the native header");
  assert.equal(misleadingTaxFilename.tax_scope?.entity_matched, true);
  assert.equal(misleadingTaxFilename.tax_scope?.year_matched, false);
  assert.equal(misleadingTaxFilename.tax_scope?.form_matched, false);
  assert.equal(misleadingTaxFilename.tax_scope?.title_candidate_matched, true,
    "the weaker title signal remains available only to block false absence for unreadable files");

  const contradictoryMetadataYear = authorityFor({
    ...base,
    title: "Example Orchard LLC 2023 tax return Form 1065",
    authority_meta: JSON.stringify({ tax_year: 2023 }),
    authority_document_head: "Example Orchard LLC. Tax year 2022 Form 1065 partnership return.",
    text: "Example Orchard LLC, Form 1065, tax year 2023.",
  }, { query: question });
  assert.equal(contradictoryMetadataYear.eligible, false,
    "a matching structured tax year must not override a different year in the native header");
  assert.equal(contradictoryMetadataYear.tax_scope?.entity_matched, true);
  assert.equal(contradictoryMetadataYear.tax_scope?.year_matched, false);

  const wrongYear = authorityFor({
    ...base,
    title: "Example Orchard LLC 2022 Form 1065",
    text: "Example Orchard LLC, Form 1065, tax year 2022.",
  }, { query: question });
  assert.equal(wrongYear.eligible, false);
  assert.equal(wrongYear.tax_scope?.entity_matched, true);
  assert.equal(wrongYear.tax_scope?.year_matched, false);
  assert.equal(wrongYear.tax_scope?.form_matched, true);

  const exactReturn = authorityFor({
    ...base,
    title: "Example Orchard LLC 2023 tax return Form 1065",
    authority_document_head: "Example Orchard LLC. Form 1065, tax year 2023.",
    text: "Example Orchard LLC, Form 1065, tax year 2023. Ordinary business income is zero.",
  }, { query: question });
  assert.equal(exactReturn.eligible, true);
  assert.equal(exactReturn.authoritative, true);
  assert.equal(exactReturn.tax_scope?.matched, true);
});

test("the tax scope parser activates only for one exact named year and form", () => {
  assert.deepEqual(
    taxQuestionScope("What ordinary business income did example orchard llc's 2023 Form 1065 report?"),
    { form: "1065", year: "2023", entity: ["example", "orchard", "llc"] },
  );
  for (const [label, canonical] of [
    ["Form 1040-X", "1040-x"],
    ["Form 1120-S", "1120-s"],
    ["Form 1120-H", "1120-h"],
    ["Form 1099-INT", "1099-int"],
    ["Form 1099-NEC", "1099-nec"],
    ["Form 1099-MISC", "1099-misc"],
    ["Form 1099-DIV", "1099-div"],
    ["Form 1099-K", "1099-k"],
    ["Form 1099-R", "1099-r"],
    ["Form 1099-B", "1099-b"],
    ["Form 1099-S", "1099-s"],
    ["Form 941", "941"],
    ["Form 940", "940"],
    ["W-2", "w-2"],
    ["Schedule K-1", "schedule-k-1"],
    ["Form 1040", "1040"],
    ["Form 1065", "1065"],
    ["Form 1120", "1120"],
  ]) {
    assert.equal(
      taxQuestionScope(`What did Example Orchard LLC's 2023 ${label} report?`)?.form,
      canonical,
      label,
    );
  }

  assert.equal(taxQuestionScope("What did Example Orchard LLC's 2023 1065 report?"), null,
    "a bare number is not an exact supported form token");
  assert.equal(taxQuestionScope("What did Example Orchard LLC's 2023 partnership return report?"), null,
    "a generic return type is outside the deterministic guard");
  assert.equal(taxQuestionScope("Compare Example Orchard's 2022 and 2023 Form 1065 returns."), null);
  assert.equal(
    taxQuestionScope("How much did Example Orchard LLC pay in 2023 for Form 1065 preparation?"),
    null,
    "a preparation invoice must not turn predicate words into a taxpayer identity",
  );
  assert.equal(
    taxQuestionScope("How much did Example Orchard LLC's 2023 Form 1065 preparation cost?"),
    null,
    "even adjacent entity-year-form wording remains outside the guard in service-fee context",
  );
  assert.equal(
    taxQuestionScope("What did Example Orchard LLC's 2023 Form 1099-INT and Form 1099-NEC report?"),
    null,
    "two supported form types cannot activate one exact-form guard",
  );
  for (const question of [
    "What 2023 Form 1065 amount was reported?",
    "Who 2023 Form 1065?",
    "Which 2023 Form 1065?",
    "How 2023 Form 1065?",
    "What did 2023 Form 1065 report for Example Orchard LLC?",
  ]) {
    assert.equal(taxQuestionScope(question), null,
      `question words or a postfix entity cannot become the named entity: ${question}`);
  }
});

test("tax form variants are exact canonical tokens, not base-form or subtype aliases", () => {
  const base = {
    source: "drive",
    source_kind: "upload",
    text_source: "native",
    text_reliable: true,
  };
  const scopedAuthority = (questionForm, documentForm) => authorityFor({
    ...base,
    title: `Example Orchard LLC 2023 ${documentForm}`,
    authority_document_head: `Taxpayer: Example Orchard LLC. 2023 ${documentForm}.`,
    text: `Taxpayer: Example Orchard LLC. 2023 ${documentForm}.`,
  }, {
    query: `What amount did Example Orchard LLC's 2023 ${questionForm} report?`,
  });

  for (const [questionForm, documentForm] of [
    ["Form 1040-X", "Form 1040"],
    ["Form 1120-S", "Form 1120"],
    ["Form 1120-H", "Form 1120"],
  ]) {
    const authority = scopedAuthority(questionForm, documentForm);
    assert.equal(authority.eligible, false, `${questionForm} must not match ${documentForm}`);
    assert.equal(authority.tax_scope?.form_matched, false);
  }

  const subtypes = ["INT", "NEC", "MISC", "DIV", "K", "R", "B", "S"];
  for (let index = 0; index < subtypes.length; index++) {
    const requested = `Form 1099-${subtypes[index]}`;
    const different = `Form 1099-${subtypes[(index + 1) % subtypes.length]}`;
    const authority = scopedAuthority(requested, different);
    assert.equal(authority.eligible, false, `${requested} must not match ${different}`);
    assert.equal(authority.tax_scope?.form_matched, false);
  }

  const exact = scopedAuthority("Form 1099-INT", "Form 1099-INT");
  assert.equal(exact.eligible, true);
  assert.equal(exact.tax_scope?.form_matched, true);
  assert.equal(exact.tax_scope?.requested_form, "1099-int");

  const laterSubtypeMention = authorityFor({
    ...base,
    title: "Example Orchard LLC 2023 Form 1099-NEC",
    authority_document_head: "Taxpayer: Example Orchard LLC. 2023 Form 1099-NEC. See Form 1099-INT instructions for comparison.",
    text: "The primary filing is Form 1099-NEC.",
  }, {
    query: "What amount did Example Orchard LLC's 2023 Form 1099-INT report?",
  });
  assert.equal(laterSubtypeMention.eligible, false,
    "a later reference to the requested subtype cannot override the primary form token");
  assert.equal(laterSubtypeMention.tax_scope?.form_matched, false);
});

test("the bounded D1 zero-chunk lookup covers legacy rows and repeats privacy scope", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE sources (name TEXT PRIMARY KEY, kind TEXT, zone TEXT);
      CREATE TABLE documents (
        doc_uid TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT, uri TEXT, document_date INTEGER, date_source TEXT, date_reliable INTEGER,
        entity_slug TEXT, client TEXT, category TEXT, top_folder TEXT, platform TEXT,
        text_source TEXT, text_reliable INTEGER, meta TEXT, ingested_at INTEGER NOT NULL,
        content_hash TEXT, deleted_at INTEGER
      );
      CREATE INDEX idx_documents_entity_slug ON documents(entity_slug);
      CREATE INDEX idx_documents_ingested_at ON documents(ingested_at DESC);
      CREATE TABLE chunks (doc_uid TEXT NOT NULL);
      CREATE INDEX idx_chunks_doc ON chunks(doc_uid);
      CREATE TABLE document_access_documents (
        grant_id TEXT, document_id TEXT, entity_slug TEXT, revoked_at INTEGER
      );
    `);
    const insertDocument = sqlite.prepare(`
      INSERT INTO documents
        (doc_uid,source,source_id,title,entity_slug,meta,text_source,text_reliable,
         ingested_at,content_hash,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL)
    `);
    sqlite.prepare("INSERT INTO sources(name,kind,zone) VALUES (?,?,?)")
      .run("drive-books", "upload", "books");
    sqlite.prepare("INSERT INTO sources(name,kind,zone) VALUES (?,?,?)")
      .run("drive-medical", "upload", "medical");
    insertDocument.run(
      "legacy-zero", "drive-books", "legacy-zero", "Example Orchard LLC 2023 Form 1065",
      null, JSON.stringify({ taxpayer_name: "Example Orchard LLC", tax_year: 2023 }),
      "native", 1, 1, "legacy-nonempty-hash",
    );
    insertDocument.run(
      "chunked", "drive-books", "chunked", "Example Orchard LLC 2023 Form 1065",
      null, "{}", "native", 1, 2, "different-hash",
    );
    sqlite.prepare("INSERT INTO chunks(doc_uid) VALUES (?)").run("chunked");

    const preparedSql = [];
    const env = {
      DB: {
        prepare(sql) {
          preparedSql.push(sql);
          const statement = sqlite.prepare(sql);
          let binds = [];
          return {
            bind(...values) { binds = values; return this; },
            async all() { return { results: statement.all(...binds) }; },
          };
        },
      },
    };
    const legacy = await unchunkedTaxDocumentCandidates(env, {
      limit: 20, filters: {}, scope: { all: true },
    });
    assert.equal(legacy.complete, true);
    assert.deepEqual(legacy.results.map((row) => row.doc_uid), ["legacy-zero"]);
    assert.equal(legacy.results[0].entity_slug, null,
      "the fallback must not depend on a modern entity mapping");
    assert.equal(legacy.results[0].content_hash, undefined,
      "the fallback neither selects nor depends on a current empty-content hash");
    const lookupSql = preparedSql.find((sql) => /unchunked-tax-document-candidates/.test(sql));
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${lookupSql}`).all(21)
      .map((row) => String(row.detail || "")).join("\n");
    assert.match(plan, /idx_documents_ingested_at/,
      "the bounded fallback walks the ingest-order index instead of materializing an unbounded sort");
    assert.match(plan, /idx_chunks_doc/,
      "the zero-chunk anti-join must use the document-key chunk index");

    for (const [uid, source] of [
      ["scoped-books-zero", "drive-books"],
      ["scoped-medical-zero", "drive-medical"],
    ]) {
      insertDocument.run(
        uid, source, uid, "Example Orchard LLC 2023 Form 1065", "example-orchard-llc",
        "{}", "native", 1, 10, `${uid}-hash`,
      );
    }
    const zoned = await unchunkedTaxDocumentCandidates(env, {
      entitySlug: "example-orchard-llc",
      limit: 20,
      filters: {},
      scope: { all: false, zones: ["books"], exclude: [] },
    });
    assert.deepEqual(zoned.results.map((row) => row.doc_uid), ["scoped-books-zero"],
      "a title candidate outside the principal's zone must be invisible");

    sqlite.prepare(
      "INSERT INTO document_access_documents(grant_id,document_id,entity_slug,revoked_at) VALUES (?,?,?,NULL)",
    ).run("grant-books", "scoped-books-zero", "example-orchard-llc");
    const granted = await unchunkedTaxDocumentCandidates(env, {
      entitySlug: "example-orchard-llc",
      limit: 20,
      filters: {},
      access: { kind: "grant", grantId: "grant-books", entitySlug: "example-orchard-llc" },
      scope: { all: true },
    });
    assert.deepEqual(granted.results.map((row) => row.doc_uid), ["scoped-books-zero"],
      "a document-only candidate outside the exact grant must be invisible");

    for (let index = 0; index < 21; index++) {
      insertDocument.run(
        `overflow-${index}`, "drive-books", `overflow-${index}`, `Archive ${index}`,
        null, "{}", "native", 1, 100 + index, `overflow-hash-${index}`,
      );
    }
    const truncated = await unchunkedTaxDocumentCandidates(env, {
      limit: 20, filters: {}, scope: { all: true },
    });
    assert.equal(truncated.results.length, 20);
    assert.equal(truncated.complete, false,
      "the lookahead row must turn a truncated inventory into unknown coverage");
  } finally {
    sqlite.close();
  }
});

test("connector kind, not a customer-chosen source name, controls authority", () => {
  assert.equal(tierOf({
    source: "plaid", source_kind: "upload", title: "Synthetic memo",
  }).tier, "T3", "an upload named plaid must not inherit machine-feed authority");
  assert.equal(tierOf({
    source: "client-calls", source_kind: "zoom", title: "Weekly sync",
  }).tier, "T4", "a custom source name keeps Zoom recollection authority");
  assert.equal(tierOf({
    source: "client-mail", source_kind: "gmail", title: "Project update",
  }).tier, "T3", "a custom source name keeps correspondence authority");
  assert.equal(tierOf({
    source: "zoom", source_kind: "unregistered", title: "Project update",
  }).tier, "T3", "unregistered provenance cannot borrow authority from a familiar source slug");

  const collision = authorityFor({
    source: "plaid", source_kind: "upload", title: "Synthetic memo",
    text_source: "native", text_reliable: true,
    ts: "2026-09-01T00:00:00.000Z", date_reliable: true,
  }, {
    query: "Is Taylor a client?", claimText: "Taylor is an active client.", current: true,
  });
  assert.equal(collision.eligible, true,
    "a nonfinancial upload must not be blocked as transactional because its scope name is plaid");
});

test("operative-value matching respects numeric and phone boundaries", () => {
  assert.equal(answerUsesOperativeValue("The amount is $100.", { value: "$100" }), true);
  assert.equal(answerUsesOperativeValue("The amount is $1000.", { value: "$100" }), false);
  assert.equal(answerUsesOperativeValue("The amount is 11 000.", { value: "1 000" }), false);
  assert.equal(answerUsesOperativeValue("Call 555-123-4567.", { value: "(555) 123-4567" }), true);

  assert.equal(answerUsesSupersededValue("The amount is $1000.", { supersedes: ["$100"] }), false);
  assert.equal(answerUsesSupersededValue("The old amount was $100.", { supersedes: ["$100"] }), false);
  assert.equal(answerUsesSupersededValue(
    "The old amount was $100. The current amount is $100.",
    { supersedes: ["$100"] },
  ), true);
  assert.equal(answerUsesSupersededValue("The amount is $100.", { supersedes: ["$100"] }), true);
  assert.equal(answerUsesSupersededValue("Call 555.765.4321.", { supersedes: ["(555) 765-4321"] }), true);
});

test("plain present relationship and owner-fact questions activate current intent", () => {
  assert.equal(hasExplicitCurrentIntent("Is Taylor a client?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Acme an active customer?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Taylor my vendor?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Taylor still my partner?"), true);
  assert.equal(hasExplicitCurrentIntent("What is my mailing address?"), true);
  assert.equal(hasExplicitCurrentIntent("What is our phone number?"), true);
  assert.equal(hasExplicitCurrentIntent("What is my email address?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Taylor a client in May 2025?"), false);
  assert.equal(hasExplicitCurrentIntent("Is Taylor a former client?"), false);
  assert.equal(hasExplicitCurrentIntent("Was Taylor a client?"), false);
  assert.equal(hasExplicitCurrentIntent("What was our mailing address during 2024?"), false);
  assert.deepEqual(queryEntityAnchors("Is ACME Holdings a customer?"), ["acme holdings"]);
});

test("confidence rewards only claim-authoritative agreement and names the strongest tier", () => {
  const base = { ts: "2026-09-01T00:00:00.000Z", date_reliable: true };
  const recollections = ["a", "b", "c"].map((ref) => ({
    ...base,
    ref,
    authority: {
      tier: "T4", rank: 4, name: "recollection", reason: "a meeting note",
      claim: "relationship_status", eligible: true, authoritative: false, current: true,
    },
  }));
  const primary = ["p1", "p2"].map((ref) => ({
    ...base,
    ref,
    authority: {
      tier: "T1", rank: 1, name: "primary", reason: "an owner confirmation",
      claim: "relationship_status", eligible: true, authoritative: true, current: true,
    },
  }));
  const low = computeAnswerConfidence({ approvedDocs: recollections });
  const historical = computeAnswerConfidence({
    approvedDocs: recollections.map((doc) => ({
      ...doc, authority: { ...doc.authority, current: false },
    })),
  });
  const high = computeAnswerConfidence({ approvedDocs: primary });
  assert.ok(high.percent > low.percent);
  assert.ok(historical.percent > low.percent, "T4-only evidence is penalized only for a current claim");
  assert.ok(low.basis.some((line) => /no high-authority agreement bonus/.test(line)));
  assert.ok(low.basis.some((line) => /historical recollection/.test(line)));
  assert.ok(high.basis.some((line) => /strongest evidence is T1 primary/.test(line)));
});

test("a changing fact does not become confident from an undated T1 record", () => {
  const undatedPrimary = {
    source: "drive", title: "Taylor signed agreement.pdf",
    text_source: "native", text_reliable: true,
  };
  const best = bestTier([undatedPrimary], {
    query: "What is Taylor's current mailing address?", current: true,
  });
  assert.equal(best.tier, "T1");
  assert.equal(best.authoritative, false);
  assert.match(best.reason, /no reliable as-of date/);

  const verdict = agreementVerdict([undatedPrimary], {
    query: "What is Taylor's current mailing address?", changes: true,
  });
  assert.equal(verdict.confident, false);
  assert.equal(verdict.caution, true);
  assert.match(verdict.line, /nothing authoritative/);

  const malformedDate = authorityFor({
    ...undatedPrimary,
    ts: "September 1, 2026",
    date_reliable: true,
  }, { query: "What is Taylor's current mailing address?", current: true });
  assert.equal(malformedDate.authoritative, false);
  assert.match(malformedDate.reason, /no reliable as-of date/);
});

test("a current owner operative value outranks a newer soft record", async () => {
  const operative = ownerRow();
  const newerSoft = {
    chunk_uid: "message:newer#0", doc_uid: "message:newer", source: "message", source_id: "newer",
    title: "Taylor address note", client: "Taylor", category: "message",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "message_timestamp", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor may still receive mail at 50 Old Road.",
  };
  const rows = [newerSoft, operative];
  const env = {
    BRAIN_OWNER: "Taylor",
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
  };
  const result = await search(env, {
    query: "What is Taylor's current mailing address?", embedding: null, limit: 5,
  });
  assert.equal(result.results[0].source_id, operative.source_id);
  assert.equal(result.results[0].authority.operative, true);
  assert.equal(Object.hasOwn(result.results[0], "authority_meta"), false);
  assert.equal(Object.hasOwn(result.results[0], "authority_document_head"), false);
});

test("an unrelated single owner section receives no operative retrieval boost", async () => {
  const unrelatedOwnerRecord = ownerRow();
  const currentPhone = {
    chunk_uid: "message:phone#0", doc_uid: "message:phone", source: "message", source_id: "phone",
    title: "Taylor phone number", client: "Taylor", category: "message",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "message_timestamp", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor's phone number is (555) 123-4567.",
  };
  const env = {
    BRAIN_OWNER: "Taylor",
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [currentPhone, unrelatedOwnerRecord] }) }) }) },
  };
  const result = await search(env, {
    query: "What is Taylor's current phone number?", embedding: null, limit: 5,
  });
  assert.equal(result.results[0].source_id, currentPhone.source_id);
  const returnedOwnerRecord = result.results.find((row) => row.source_id === unrelatedOwnerRecord.source_id);
  assert.equal(returnedOwnerRecord?.authority?.operative, false);
});

function routeEnv(answerText, { rows: suppliedRows = null, verifierEvidence = [1] } = {}) {
  const operative = ownerRow();
  const newerSoft = {
    chunk_uid: "message:newer#0", doc_uid: "message:newer", source: "message", source_id: "newer",
    title: "Taylor address note", client: "Taylor", category: "message",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "message_timestamp", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor may still receive mail at 50 Old Road.",
  };
  const rows = suppliedRows || [newerSoft, operative];
  return {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    BRAIN_OWNER: "Taylor",
    DB: {
      exec: async () => {},
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => ({ results: /FROM chunks_fts/.test(sql) ? rows : [] }),
          first: async () => {
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 33, mutation_id: null, mutation_submitted_at: null,
                projection_status: "verified", bootstrap_epoch: 0, bootstrap_cursor: null,
                bootstrap_high_water: null, expected_vectors: 0, pending: 0, submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/SUM\(est_cost_usd_micros\)/.test(sql)) return { m: 0 };
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch: async () => [],
    },
    VECTORIZE: {
      query: async () => ({ matches: [] }),
      describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
    },
    AI: {
      run: async (model, input) => {
        if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
        const system = String(input?.messages?.[0]?.content || "");
        if (/verify a proposed answer/.test(system)) {
          return { response: { supported: true, complete: true, evidence: verifierEvidence, reason: "owner operative value" }, usage: {} };
        }
        return { response: answerText, usage: {} };
      },
    },
  };
}

async function askRoute(env) {
  const response = await worker.fetch(new Request("https://brain.invalid/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q: "What is Taylor's current mailing address?", limit: 5 }),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  return response.json();
}

test("the answer route selects the operative value and keeps superseded history out of the answer", async () => {
  const body = await askRoute(routeEnv("Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1]."));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.doesNotMatch(body.answer || "", /50 Old Road/);
  assert.equal(body.citations[0]?.authority?.tier, "T1");
  assert.equal(body.citations[0]?.authority?.operative, true);
  assert.ok(body.confidence?.basis?.some((line) => /strongest evidence is T1 primary/.test(line)));
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_nonoperative_evidence"), true);
});

test("the answer route fails closed when a draft substitutes the superseded value", async () => {
  const body = await askRoute(routeEnv("Taylor's mailing address is 50 Old Road [1]."));
  assert.equal(body.answer, null);
  assert.equal(body.status, SEARCH_UNAVAILABLE);
  assert.match(body.notice || "", /search could not be completed/i);
  assert.match(body.evidence_gate?.reason || "", /did not use the matching owner-confirmed operative value|superseded value/);
});

test("equally newest disagreeing owner confirmations fail as an operative conflict", async () => {
  const first = ownerRow({ id: "same-time-a", value: "100 New Avenue", supersedes: "50 Old Road" });
  const second = ownerRow({ id: "same-time-b", value: "200 Other Avenue", supersedes: "50 Old Road" });
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [first, second] },
  ));
  assert.equal(body.answer, null);
  assert.equal(body.status, SEARCH_UNAVAILABLE);
  assert.match(body.notice || "", /search could not be completed/i);
  assert.equal(body.evidence_gate?.reason, "equally current owner-confirmed operative records disagree");
  assert.equal(body.gaps?.some((gap) => gap.type === "operative_conflict"), true);
});

test("equally newest matching owner confirmations select one deterministic record", async () => {
  const first = ownerRow({ id: "same-value-a" });
  const second = ownerRow({ id: "same-value-b" });
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [2].",
    { rows: [second, first], verifierEvidence: [2] },
  ));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.equal(body.citations.length, 1);
  assert.equal(body.citations[0]?.ref, first.source_id);
  assert.equal(body.gaps?.some((gap) => gap.type === "operative_conflict"), false);
});

test("newer claim-authoritative evidence fails closed against an older operative value", async () => {
  const operative = ownerRow();
  const newerPrimary = {
    chunk_uid: "drive:newer-lease#0", doc_uid: "drive:newer-lease", source: "drive", source_id: "newer-lease",
    title: "Taylor signed lease agreement", client: "Taylor", category: "contract",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "document_date", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor's mailing address is 200 Other Avenue.",
  };
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [operative, newerPrimary] },
  ));
  assert.equal(body.answer, null);
  assert.equal(body.status, SEARCH_UNAVAILABLE);
  assert.match(body.notice || "", /search could not be completed/i);
  assert.equal(body.evidence_gate?.reason, "newer authoritative evidence may supersede the older owner-confirmed operative value");
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_authoritative_evidence"), true);
  assert.equal(body.evidence_authority, undefined, "a refusal does not present retrieved authority as its approved basis");
});

test("a newer unrelated authoritative record does not create a false operative conflict", async () => {
  const operative = ownerRow();
  const unrelatedPrimary = {
    chunk_uid: "drive:newer-vendor#0", doc_uid: "drive:newer-vendor", source: "drive", source_id: "newer-vendor",
    title: "Taylor signed vendor agreement", client: "Taylor", category: "contract",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "document_date", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor is the vendor for equipment maintenance.",
  };
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [operative, unrelatedPrimary] },
  ));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_authoritative_evidence"), false);
});

test("a newer authoritative record that repeats the operative value does not create a conflict", async () => {
  const operative = ownerRow();
  const agreeingPrimary = {
    chunk_uid: "drive:newer-lease#0", doc_uid: "drive:newer-lease", source: "drive", source_id: "newer-lease-agrees",
    title: "Taylor signed lease agreement", client: "Taylor", category: "contract",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "document_date", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor's mailing address is 100 New Avenue.",
  };
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [operative, agreeingPrimary] },
  ));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_authoritative_evidence"), false);
});
