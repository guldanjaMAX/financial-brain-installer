import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ledgerFixture } from "./ledger-review-fixture.mjs";
import { reachedAnswer } from "./ledger-production-fixture.mjs";
import { replay } from "../../eval/fast-loop/money-replay.mjs";
import { cases as familyCases, snapshotFor as familySnapshot } from "../../eval/fast-loop/vendor-family-cases.mjs";
import { reviewVendorFamily } from "../../eval/fast-loop/vendor-family-key.mjs";

import { MONEY_JARGON } from "./fixtures/plain-copy-expectations.mjs";

const PERIOD = "in October 2026";
const amountFields = value => {
  const found = [];
  const visit = (candidate, path = []) => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) return candidate.forEach((entry, index) => visit(entry, [...path, index]));
    for (const [key, entry] of Object.entries(candidate)) {
      const nextPath = [...path, key];
      if (/(?:amount|total|subtotal)_minor$/.test(key)) found.push(nextPath.join("."));
      visit(entry, nextPath);
    }
  };
  visit(value);
  return found;
};

const variants = [
  {
    label: "case-preserving suffix",
    query: "Cloudflare",
    candidate: { description: "Card purchase", payee: "CloudFlare HQ" },
    negative: { description: "Cloud Kitchen order", payee: null },
    negativeText: "Cloud Kitchen order",
    exactPayee: "CLOUDFLARE",
  },
  {
    label: "bank suffix with a description-only candidate",
    query: "OpenAI",
    candidate: { description: "OPENAI *CHATGPT SUBSCR", payee: null },
    negative: { description: "Kitchen purchase", payee: "ChatGPT Kitchen" },
    negativeText: "ChatGPT Kitchen",
    exactPayee: "OPENAI",
  },
  {
    label: "punctuation and spacing",
    query: "North-Star Media",
    candidate: { description: "Media purchase", payee: "NORTH / STAR MEDIA ONLINE" },
    negative: { description: "NORTH STAR CAFE", payee: null },
    negativeText: "NORTH STAR CAFE",
    exactPayee: "North / Star Media",
  },
];

for (const variant of variants) test(`named vendor ${variant.label} distinguishes structured family from bank text`, async t => {
  const f = ledgerFixture(t);
  // Bank-feed production rows map merchant_name to payee and leave it null
  // when only the provider description is available. Across this matrix,
  // three of the six pre-control rows are deliberately description-only.
  f.add("candidate", variant.candidate.description, variant.candidate.payee,
    { cents: 1234, direction: "outflow" });
  f.add("negative", variant.negative.description, variant.negative.payee,
    { cents: 9900, direction: "outflow" });

  const possible = await reachedAnswer(f, `How much did I spend at ${variant.query} ${PERIOD}?`);
  f.add("exact-control", "Exact structured merchant", variant.exactPayee,
    { cents: 5678, direction: "outflow" });
  const exact = await reachedAnswer(f, `How much did I spend at ${variant.query} ${PERIOD}?`);

  // Structured prefix payees now prove a family member; description-only
  // rows still exercise every original possible-only assertion below.
  if (variant.candidate.payee) {
    assert.equal(possible.ledger.match_basis, "family", "structured family decision reached");
    assert.equal(possible.ledger.total_minor, 1234);
    assert.equal(possible.evidence_gate.complete, true);
    assert.equal(possible.citations.length, 1);
    assert.equal(exact.ledger.match_basis, "family");
    assert.equal(exact.ledger.total_minor, 6912);
    assert.equal(exact.ledger.exact_match_count, 1);
    assert.equal(exact.ledger.family_match_count, 1);
    assert.equal(exact.evidence_gate.complete, true);
    assert.equal(exact.citations.length, 2);
    assert.ok(exact.answer.includes(`also includes: ${variant.candidate.payee}.`));
    assert.ok(!possible.answer.includes(variant.negativeText));
    return;
  }

  assert.equal(possible.ledger.match_basis, "possible", "possible-match decision reached");
  assert.equal(possible.ledger.found, null);
  assert.equal(possible.ledger.complete, false);
  assert.equal(possible.evidence_gate.complete, false);
  assert.equal(possible.evidence_gate.partial, true);
  assert.equal(possible.answer.split("\n")[0], `I found 1 transaction mentioning "${variant.query}", but the bank did not name it as the payee, so no store total is confirmed.`);
  assert.match(possible.answer, /the bank did not name it as the payee/i);
  assert.ok(!possible.answer.includes(variant.negativeText), "different vendor sharing only part of the selector stayed out");
  assert.doesNotMatch(possible.answer, /\$\d[\d,]*\.\d{2}/i);
  assert.deepEqual(amountFields(possible.ledger), [], "possible matches expose no amount-shaped field");
  assert.equal(possible.citations.length, 0, "possible matches expose no amount-bearing citation");

  assert.equal(exact.ledger.match_basis, "exact_and_possible", "mixed exact-plus-possible decision reached");
  assert.equal(exact.ledger.found, true);
  assert.equal(exact.ledger.total_minor, null, "mixed evidence cannot claim a complete vendor total");
  assert.equal(exact.ledger.exact_subtotal_minor, 5678);
  assert.equal(exact.ledger.possible_subtotal_minor, 1234);
  assert.equal(exact.ledger.exact_match_count, 1);
  assert.equal(exact.ledger.possible_match_count, 1);
  assert.equal(exact.ledger.complete, false);
  assert.equal(exact.evidence_gate.complete, false);
  assert.equal(exact.evidence_gate.partial, true);
  assert.equal(exact.citations.length, 1);
  assert.equal(exact.citations[0].amount_minor, 5678, "exact subtotal retains its cited row");
  assert.match(exact.answer, /bank names it on charges totaling \$56\.78/i);
  assert.match(exact.answer, /another \$12\.34 only mentions it/i);
  assert.match(exact.answer, /These amounts stay separate, with no complete store total confirmed \[1\]\.$/m);
});

test("an unmatched vendor names the covered window and a pure exact green control stays complete", async t => {
  const f = ledgerFixture(t);
  f.add("closest", "Card purchase", "Cloud Kitchen", { cents: 4321, direction: "outflow" });
  f.add("description-only", "Cloud Tools purchase", null, { cents: 8765, direction: "outflow" });

  const absent = await reachedAnswer(f, `How much did I spend at Cloudflare ${PERIOD}?`);
  f.add("exact-control", "Exact structured merchant", "Cloudflare", { cents: 2468, direction: "outflow" });
  const exact = await reachedAnswer(f, `How much did I spend at Cloudflare ${PERIOD}?`);

  assert.equal(absent.ledger.match_basis, "none", "no-match decision reached after a nonempty transaction read");
  assert.equal(absent.ledger.found, false);
  assert.equal(absent.ledger.total_minor, null);
  assert.equal(absent.ledger.complete, false);
  assert.equal(absent.evidence_gate.complete, false);
  assert.equal(absent.evidence_gate.partial, true);
  assert.deepEqual(absent.ledger.closest_payees, ["Cloud Kitchen"]);
  assert.equal(absent.answer.split("\n")[0], 'I checked October, but no payee exactly matched "Cloudflare", so no store total is confirmed. Closest payee names: Cloud Kitchen.');
  assert.match(absent.answer, /no payee exactly matched "Cloudflare", so no store total is confirmed\./);
  assert.match(absent.answer, /October/);
  assert.match(absent.answer, /Closest payee names.*Cloud Kitchen/i);
  assert.doesNotMatch(absent.answer, /\$0\.00|total spend/i);
  assert.equal(absent.citations.length, 0);

  assert.equal(exact.ledger.match_basis, "exact", "exact spelling stays complete");
  assert.equal(exact.ledger.total_minor, 2468);
  assert.equal(exact.ledger.complete, true);
  assert.equal(exact.evidence_gate.complete, true);
});

test("possible matches expose bounded counts but no amounts or citations", async t => {
  const f = ledgerFixture(t);
  for (const [index, amount] of [100, 200, 300, 400, 500, 600].entries()) {
    f.add(`possible-${index}`, `Cloudflare item ${index}`, null,
      { date: `2026-10-0${index + 1}`, cents: amount, direction: "outflow" });
  }

  const possible = await reachedAnswer(f, `How much did I spend at Cloudflare ${PERIOD}?`);

  assert.equal(possible.ledger.match_basis, "possible", "possible decision reached");
  assert.equal(possible.ledger.row_count, 6);
  assert.equal(possible.citations.length, 0);
  assert.deepEqual(amountFields(possible.ledger), []);
  assert.equal(possible.answer.split("\n")[0], 'I found 6 transactions mentioning "Cloudflare", but the bank did not name it as the payee, so no store total is confirmed.');
  assert.match(possible.answer, /^I found 6 transactions mentioning "Cloudflare", but the bank did not name it as the payee, so no store total is confirmed\.$/m);
  assert.doesNotMatch(possible.answer, /\$\d[\d,]*\.\d{2}/i);
});

test("vendor family includes three structured products with cited integer-cent breakdowns", async t => {
  const f = ledgerFixture(t);
  for (const [index, payee] of ["Vendorwave Cloud", "VENDORWAVE *WORKSPACE", "Vendorwave / Media"].entries())
    f.add(`product-${index}`, "Card purchase", payee, { cents: [1234, 2501, 765][index], direction: "outflow" });
  f.add("repeat", "Card purchase", "Vendorwave Cloud", { cents: 500, direction: "outflow" });
  const body = await reachedAnswer(f, `How much did I spend at Vendorwave ${PERIOD}?`);
  assert.equal(body.ledger.match_basis, "family", "family decision reached");
  assert.equal(body.ledger.total_minor, 5000);
  assert.equal(body.ledger.row_count, 4);
  assert.equal(body.evidence_gate.complete, true);
  assert.deepEqual(body.ledger.groups.map(g => [g.merchant, g.total_minor, g.count]), [
    ["Vendorwave Cloud", 1734, 2], ["VENDORWAVE *WORKSPACE", 2501, 1], ["Vendorwave / Media", 765, 1],
  ]);
  for (const group of body.ledger.groups) {
    assert.equal(group.citations.length, group.count);
    assert.equal(group.citations.reduce((total, n) => total + body.citations[n - 1].amount_minor, 0), group.total_minor);
  }
  assert.match(body.answer, /Included payees: Vendorwave Cloud; VENDORWAVE \*WORKSPACE; Vendorwave \/ Media\./);
  assert.match(body.answer, /Vendorwave Cloud: \$17\.34 across 2 rows \[\d+\]/);
  assert.match(body.answer, /Bank history: requested October/);
});

test("exact vendor has a green control and explicitly discloses added family members", async t => {
  const f = ledgerFixture(t);
  f.add("exact", "Card purchase", "Vendorwave", { cents: 1001, direction: "outflow" });
  const exact = await reachedAnswer(f, `How much did I spend at Vendorwave ${PERIOD}?`);
  assert.equal(exact.ledger.match_basis, "exact");
  assert.equal(exact.ledger.total_minor, 1001);
  assert.doesNotMatch(exact.answer, /also includes:/);
  f.add("product", "Card purchase", "Vendorwave Cloud", { cents: 2002, direction: "outflow" });
  const family = await reachedAnswer(f, `How much did I spend at Vendorwave ${PERIOD}?`);
  assert.equal(family.ledger.total_minor, 3003);
  assert.equal(family.ledger.exact_match_count, 1);
  assert.equal(family.ledger.family_match_count, 1);
  assert.match(family.answer, /^You spent \$30\.03 at Vendorwave/);
  assert.match(family.answer, /^also includes: Vendorwave Cloud\.$/m);
});

test("short ambiguous vendor lists candidates and retains an exact green control", async t => {
  const f = ledgerFixture(t);
  f.add("cafe", "Card purchase", "Cloud Cafe", { cents: 1700, direction: "outflow" });
  f.add("parts", "Card purchase", "Cloud Parts", { cents: 2300, direction: "outflow" });
  const refused = await reachedAnswer(f, `How much did I spend at Cloud ${PERIOD}?`);
  assert.equal(refused.ledger.match_basis, "possible", "ambiguous prefix decision reached");
  assert.equal(refused.ledger.family_ambiguous, true);
  assert.deepEqual(refused.ledger.family_candidates, ["Cloud Cafe", "Cloud Parts"]);
  assert.equal(refused.ledger.total_minor, undefined);
  assert.equal(refused.citations.length, 0);
  assert.match(refused.answer, /Ambiguous vendor family.*Cloud Cafe; Cloud Parts/);
  f.add("exact", "Card purchase", "Cloud", { cents: 900, direction: "outflow" });
  const exact = await reachedAnswer(f, `How much did I spend at Cloud ${PERIOD}?`);
  assert.equal(exact.ledger.exact_subtotal_minor, 900);
  assert.equal(exact.ledger.family_ambiguous, true);
  assert.match(exact.answer, /Ambiguous vendor family.*Cloud Cafe; Cloud Parts/);
  assert.doesNotMatch(exact.answer, /also includes:/);
});

test("vendor word inside another word cannot match, with a family green control", async t => {
  const f = ledgerFixture(t);
  f.add("embedded", "Card purchase", "Supervendorwave Cloud", { cents: 9900, direction: "outflow" });
  f.add("extended", "Card purchase", "Vendorwaveworks", { cents: 8800, direction: "outflow" });
  const absent = await reachedAnswer(f, `How much did I spend at Vendorwave ${PERIOD}?`);
  assert.equal(absent.ledger.match_basis, "none", "nonempty unmatched decision reached");
  assert.equal(absent.ledger.total_minor, null);
  f.add("family", "Card purchase", "Vendorwave Cloud", { cents: 1234, direction: "outflow" });
  const green = await reachedAnswer(f, `How much did I spend at Vendorwave ${PERIOD}?`);
  assert.equal(green.ledger.total_minor, 1234);
  assert.equal(green.ledger.row_count, 1);
});

test("bounded descriptor aliases require a structured payee and literal descriptor separator", async t => {
  const f = ledgerFixture(t);
  f.add("alias", "Card purchase", "GOOG *CLOUD", { cents: 1234, direction: "outflow" });
  f.add("unlisted", "Card purchase", "Goog Kitchen", { cents: 9900, direction: "outflow" });
  f.add("longer", "Card purchase", "Googlet *Cloud", { cents: 8800, direction: "outflow" });
  const green = await reachedAnswer(f, `How much did I spend at Google ${PERIOD}?`);
  assert.equal(green.ledger.match_basis, "family");
  assert.equal(green.ledger.total_minor, 1234);
  assert.equal(green.ledger.row_count, 1);
  assert.match(green.answer, /Included payees: GOOG \*CLOUD\./);
  f.add("bank-only", "GOOGLE *WORKSPACE", null, { cents: 3300, direction: "outflow" });
  const mixed = await reachedAnswer(f, `How much did I spend at Google ${PERIOD}?`);
  assert.equal(mixed.ledger.total_minor, null);
  assert.equal(mixed.ledger.family_subtotal_minor, 1234);
  assert.equal(mixed.ledger.possible_match_count, 1);
  assert.equal(mixed.citations.length, 1);
  assert.equal(mixed.citations[0].amount_minor, 1234);
});

test("family spend keeps refund inflows outside the outflow figure", async t => {
  const f = ledgerFixture(t);
  f.add("purchase", "Card purchase", "Vendorwave Cloud", { cents: 5000, direction: "outflow" });
  f.add("refund", "Refund", "Vendorwave Cloud", { cents: 1200, direction: "inflow" });
  const family = await reachedAnswer(f, `How much did I spend at Vendorwave ${PERIOD}?`);
  const exact = await reachedAnswer(f, `How much did I spend at Vendorwave Cloud ${PERIOD}?`);
  assert.equal(family.ledger.total_minor, 5000, "refund cannot reduce family spend");
  assert.equal(exact.ledger.total_minor, 5000, "exact green control preserves refund rule");
  assert.equal(family.ledger.row_count, 1);
  assert.equal(family.citations.length, 1);
  assert.equal(family.citations[0].amount_minor, 5000);
});

test("restoring exact-only selection fails the independent family key and preserves green controls", () => {
  const cases = familyCases.filter(c => /\/(?:products|exact|bank-only)$/.test(c.id));
  const green = replay({ cases, snapshotFor: familySnapshot });
  for (const observation of green.observations) reviewVendorFamily(observation);
  const source = readFileSync(new URL("../src/lib/ledger-analysis.js", import.meta.url), "utf8");
  const site = "if (!ambiguous) { family.push(row); continue; }";
  assert.equal(source.split(site).length - 1, 1, "one restoring mutation site");
  const broken = replay({ cases, snapshotFor: familySnapshot,
    sourceOverrides: { "ledger-analysis.js": source.replace(site, "if (false && !ambiguous) { family.push(row); continue; }") } });
  const family = broken.observations.find(o => o.id.endsWith("/products"));
  assert.ok(family.trace.dependencies.includes("transactions"), "mutant reaches family decision");
  assert.equal(family.trace.rows_read.length, 3, "mutant sees all product receipts");
  assert.throws(() => reviewVendorFamily(family), { name: "AssertionError" });
  for (const observation of broken.observations.filter(o => !o.id.endsWith("/products"))) {
    reviewVendorFamily(observation);
    assert.deepEqual(observation.body, green.observations.find(o => o.id === observation.id).body);
  }
});

test("development family matrix rejects a wrong displayed cent and an unsupported factual line", () => {
  const run = replay({ cases: familyCases, snapshotFor: familySnapshot });
  for (const observation of run.observations) reviewVendorFamily(observation);
  assert.equal(run.observations.length, 15);
  assert.ok(new Set(run.observations.map(o => o.body.ledger.match_basis)).size >= 4,
    "family, exact, possible and no-match arms must discriminate");
  const source = run.observations.find(o => o.id.endsWith("/products"));
  const wrongCent = structuredClone(source);
  wrongCent.body.answer = wrongCent.body.answer.replace("$70.00", "$70.01");
  assert.notEqual(wrongCent.body.answer, source.body.answer, "real figure mutation reached");
  assert.throws(() => reviewVendorFamily(wrongCent), { name: "AssertionError" });
  const unsupported = structuredClone(source);
  unsupported.body.answer += "\nEvery charge is a confirmed subscription.";
  assert.throws(() => reviewVendorFamily(unsupported), { name: "AssertionError" });
  reviewVendorFamily(run.observations.find(o => o.id.endsWith("/exact")));
});

// Family replies share the exact lint used by the plain-refusal matrix.
test("family wording stays plain across complete, partial and refused answers", () => {
  const run = replay({ cases: familyCases, snapshotFor: familySnapshot });
  assert.equal(run.observations.length, 15);
  const green = run.observations.find(o => o.id.endsWith("/products"));
  assert.equal(green.body.ledger.total_minor, 7000, "nonempty family green control");
  assert.equal(green.body.ledger.match_basis, "family");
  for (const o of run.observations) {
    assert.equal(o.execution_status, "complete");
    assert.ok(o.trace.dependencies.includes("transactions"), "real transaction decision reached");
    assert.ok(o.trace.rows_read.length > 0, "refusals inspect a nonempty bank");
    assert.doesNotMatch(o.body.answer, MONEY_JARGON, o.id);
    assert.doesNotMatch(o.body.citations.map(c => c.title).join("\n"), MONEY_JARGON, "citation titles use shared dates and accounts");
  }
});
