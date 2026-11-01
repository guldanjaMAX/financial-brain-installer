import assert from "node:assert/strict";
import test from "node:test";
import { ledgerFixture } from "./ledger-review-fixture.mjs";
import { reachedAnswer } from "./ledger-production-fixture.mjs";

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

for (const variant of variants) test(`named vendor ${variant.label} is possible until a structured payee is exact`, async t => {
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

  assert.equal(possible.ledger.match_basis, "possible", "possible-match decision reached");
  assert.equal(possible.ledger.found, null);
  assert.equal(possible.ledger.complete, false);
  assert.equal(possible.evidence_gate.complete, false);
  assert.equal(possible.evidence_gate.partial, true);
  assert.match(possible.answer, /^Partial:/);
  assert.match(possible.answer, /no structured payee exactly matches/i);
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
  assert.match(exact.answer, /Exact structured-payee subtotal[^\n]*\$56\.78/i);
  assert.match(exact.answer, /Possible bank-text subtotal[^\n]*\$12\.34/i);
  assert.match(exact.answer, /not a complete vendor total/i);
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
  assert.match(absent.answer, /No transactions were found for cloudflare/i);
  assert.match(absent.answer, /2026-10-01 through 2026-10-31/);
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
  assert.match(possible.answer, /^Partial:/);
  assert.match(possible.answer, /6 bank-text rows may be related/i);
  assert.doesNotMatch(possible.answer, /\$\d[\d,]*\.\d{2}/i);
});
