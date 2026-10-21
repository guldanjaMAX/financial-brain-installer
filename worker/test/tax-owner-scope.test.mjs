import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createProductFixture, QA_ROOT } from "./product-contract-fixture.mjs";

const NOW = Date.parse("2026-10-20T18:00:00.000Z");
const OWNER = "Fixture Owner";
const productRoot = () => resolve(process.env.PRODUCT_CONTRACT_ROOT || QA_ROOT);
const moduleAt = (path) => import(pathToFileURL(join(productRoot(), path)).href);
const headers = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });

const ownerQuestions = [
  ["Who prepared my 2025 federal income tax return (Form 1040)?", "1040"],
  ["How much did I owe on my 2025 tax return?", "1040"],
  ["What wages are on my 2025 W-2?", "w-2"],
];

test("AR-07 assessment resolves owner tax questions without widening named-entity grammar", async () => {
  const { taxQuestionScope, taxQuestionScopeAssessment } = await moduleAt("worker/src/lib/tax-evidence-scope.js");
  for (const [question, form] of ownerQuestions) {
    const assessment = taxQuestionScopeAssessment(question, { owner: OWNER, now: NOW, timeZone: "UTC" });
    assert.equal(assessment.applicable, true, question);
    assert.equal(assessment.resolved, true, question);
    assert.deepEqual(assessment.scope, {
      form, year: "2025", entity: ["fixture", "owner"], kind: "owner",
    }, question);
  }

  assert.deepEqual(
    taxQuestionScope("What did Example Holdings LLC's 2025 Form 1065 report on my return?", { owner: OWNER, now: NOW }),
    { form: "1065", year: "2025", entity: ["example", "holdings", "llc"] },
    "an exact named entity wins over an owner pronoun elsewhere",
  );
  assert.equal(
    taxQuestionScope("What did Example Holdings LLC's 2025 partnership return report?", { owner: OWNER, now: NOW }),
    null,
    "named entities retain the existing adjacent exact-form rule",
  );
  assert.equal(
    taxQuestionScope("What did Example Holdings LLC's 2025 filing say about Form 1065?", { owner: OWNER, now: NOW }),
    null,
    "a named form elsewhere in a named-entity question does not remove adjacency",
  );
  assert.equal(
    taxQuestionScopeAssessment("How much were my taxes?", { owner: OWNER, now: NOW }).applicable,
    false,
    "generic owner tax wording does not enter the return-evidence gate",
  );
});

test("AR-07 relative years and unresolved owner pieces fail closed with a specific notice", async () => {
  const { taxQuestionScopeAssessment } = await moduleAt("worker/src/lib/tax-evidence-scope.js");
  const relative = taxQuestionScopeAssessment("What wages were on my last year's W-2?", {
    owner: OWNER, now: NOW, timeZone: "Etc/GMT+7",
  });
  assert.equal(relative.resolved, true);
  assert.equal(relative.scope.year, "2025");

  for (const [question, missing] of [
    ["What wages are on my this year's W-2?", "year"],
    ["Compare my 2024 and 2025 tax returns.", "year"],
    ["What income is on my 2025 filing?", "form"],
    ["Compare my 2025 Form 1040 and W-2.", "form"],
  ]) {
    const assessment = taxQuestionScopeAssessment(question, { owner: OWNER, now: NOW, timeZone: "UTC" });
    assert.equal(assessment.applicable, true, question);
    assert.equal(assessment.resolved, false, question);
    assert.equal(assessment.missing, missing, question);
    assert.match(assessment.notice, new RegExp(missing, "i"), question);
  }
  for (const owner of ["", "owner", "the owner"]) {
    const assessment = taxQuestionScopeAssessment(ownerQuestions[0][0], { owner, now: NOW });
    assert.equal(assessment.resolved, false, owner || "empty owner");
    assert.equal(assessment.missing, "owner_name");
    assert.match(assessment.notice, /owner.+name.+unknown/i);
  }
});

test("AR-07 owner identity requires an exact structured identity or an ordered filer label", async () => {
  const { authorityFor } = await moduleAt("worker/src/lib/evidence-authority.js");
  const query = ownerQuestions[0][0];
  const base = {
    source: "drive",
    source_kind: "upload",
    title: "Fixture 2025 Form 1040",
    text_source: "native",
    text_reliable: true,
    authority_meta: JSON.stringify({ evidence_lineage: { version: 1, kind: "source_record", root_ids: [] } }),
  };
  const eligible = authorityFor({
    ...base,
    authority_document_head: "Your first name and initial: Fixture A\nLast name: Owner\n2025 Form 1040",
    text: "Tax preparer Contact A. Amount owed 123.",
  }, { query, owner: OWNER, now: NOW });
  assert.equal(eligible.tax_scope?.matched, true);
  assert.equal(eligible.eligible, true);

  const reversed = authorityFor({
    ...base,
    authority_document_head: "Taxpayer: Owner Fixture\n2025 Form 1040",
  }, { query, owner: OWNER, now: NOW });
  assert.equal(reversed.tax_scope?.entity_matched, false, "owner words cannot match in a different order");

  for (const filer of ["A Fixture Owner", "Fixture Owner A"]) {
    const misplacedInitial = authorityFor({
      ...base,
      authority_document_head: `Taxpayer: ${filer}\n2025 Form 1040`,
    }, { query, owner: OWNER, now: NOW });
    assert.equal(misplacedInitial.tax_scope?.entity_matched, false,
      "only an initial between owner name words is allowed");
  }

  const otherFiler = authorityFor({
    ...base,
    authority_document_head: "Taxpayer: Contact A\n2025 Form 1040",
  }, { query, owner: OWNER, now: NOW });
  assert.equal(otherFiler.eligible, false);
  assert.equal(otherFiler.tax_scope?.entity_matched, false);

  const unlabeled = authorityFor({
    ...base,
    authority_document_head: "Fixture Owner 2025 Form 1040",
  }, { query, owner: OWNER, now: NOW });
  assert.equal(unlabeled.tax_scope?.entity_matched, false);
  assert.match(unlabeled.tax_scope?.reason || "", /filer name could not be read/i);

  const structured = authorityFor({
    ...base,
    entity_slug: "fixture-owner",
    authority_document_head: "2025 Form 1040",
  }, { query, owner: OWNER, now: NOW });
  assert.equal(structured.tax_scope?.entity_matched, true, "an exact owner slug is authoritative identity");

  const k1 = authorityFor({
    ...base,
    authority_document_head: "Taxpayer: Fixture Owner\n2025 Schedule K-1 (Form 1065)",
  }, { query: "What ordinary business income is on my 2025 Form 1065?", owner: OWNER, now: NOW });
  assert.equal(k1.tax_scope?.form_matched, false, "a K-1 cannot satisfy the owner's Form 1065 request");
});

test("AR-07 the three owner questions reach real retrieval and an owner-labeled 1040 is eligible", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let searches = 0;
  const fixture = await createProductFixture({
    productRoot: productRoot(),
    env: {
      BRAIN_OWNER: OWNER,
      BRAIN_TIMEZONE: "UTC",
      AI: { async run(model, input) {
        if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
        if (String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")) {
          return { response: { supported: true, complete: true, evidence: [1], reason: "fixture approval" } };
        }
        return { response: "The fixture return contains the requested field [1]." };
      } },
    },
  });
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('fixture-tax','upload','ready',?)", new Date(NOW).toISOString());
    const response = await fixture.post("/api/admin/brain/ingest/batch", { docs: [
      {
        source_type: "fixture-tax", source_id: "return-1040", title: "Fixture 2025 Form 1040",
        content: "Your first name and initial: Fixture A\nLast name: Owner\n2025 Form 1040\nTax preparer Contact A. Amount owed 123.",
        occurred_at: "2026-04-01", date_reliable: true, date_source: "fixture:filing_date",
        text_source: "native", text_reliable: true,
        metadata: { evidence_lineage: { version: 1, kind: "source_record" } },
      },
      {
        source_type: "fixture-tax", source_id: "w-2", title: "Fixture 2025 W-2",
        content: "Employee's name: Fixture Owner\n2025 W-2\nWages 456.",
        occurred_at: "2026-01-31", date_reliable: true, date_source: "fixture:filing_date",
        text_source: "native", text_reliable: true,
        metadata: { evidence_lineage: { version: 1, kind: "source_record" } },
      },
    ] }, headers(fixture));
    assert.equal(response.status, 200);
    fixture.env.VECTORIZE.query = async () => {
      searches++;
      return { matches: fixture.rows("SELECT chunk_uid AS id FROM chunks ORDER BY chunk_uid") };
    };
    for (const [question] of ownerQuestions) {
      const body = await (await fixture.post("/api/rag/think", { q: question }, headers(fixture))).json();
      assert.ok(body.results.length > 0, `${question}: results prove retrieval ran`);
      assert.notEqual(body.evidence_gate?.reason, "tax question scope is unresolved", question);
    }
    assert.equal(searches, 3, "each owner question reached the real vector retrieval decision");
  } finally {
    fixture.close();
  }
});

test("AR-07 tax preparation fees remain outside the tax-return evidence gate", async () => {
  const { taxQuestionScopeAssessment } = await moduleAt("worker/src/lib/tax-evidence-scope.js");
  assert.deepEqual(
    taxQuestionScopeAssessment("How much did I pay my tax preparer for my 2025 return?", { owner: OWNER, now: NOW }),
    { applicable: false, resolved: false, scope: null },
  );
});
