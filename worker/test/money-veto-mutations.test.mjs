import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyMoneyVeto } from "../src/lib/money-veto.js";
import { evidenceLineageFor } from "../src/lib/evidence-lineage.js";

const moduleURL = new URL("../src/lib/money-veto.js", import.meta.url);
const now = Date.parse("2026-10-11T12:00:00Z");
function input() {
  return {
    now, question: "What was charged in the last 60 days?",
    answer: "Card ending 4242 charged USD 120.00 [1].",
    evidenceGate: { supported: true, complete: true, evidence: [1], reason: "approved upstream" },
    docs: [{ n: 1, ts: "2026-10-10", date_reliable: true, title: "Card record",
      authority: { tier: "T1", eligible: true }, lineage: { status: "known", kind: "source_record" },
      snippet: "Card ending 4242 charged USD 120.00. January, February, March." }],
  };
}

async function mutatedModule(url, from, to) {
  const source = readFileSync(url, "utf8");
  assert.equal(source.split(from).length - 1, 1, "mutation reaches exactly one real guard");
  const changed = source.replace(from, to).replace(/from "(\.\.?\/[^"\n]+)"/g,
    (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  assert.notEqual(changed, source);
  return import(`data:text/javascript,${encodeURIComponent(changed)}`);
}

for (const [guard, from, to, mutate] of [
  ["date reliability", "if (cited.some((doc) => times.get(doc) === null))", "if (false)", (value) => {
    value.question = "What was charged?"; value.docs[0].date_reliable = false;
  }],
  ["period membership", "if (cited.some(doc => times.get(doc) < window.start", "if (false && cited.some(doc => times.get(doc) < window.start", (value) => { value.docs[0].ts = "2026-07-01"; }],
  ["lineage and T4", "cited.filter(primary)", "cited", (value) => { value.docs[0].lineage.kind = "agent_derived"; }],
  ["T4 with unknown lineage", "cited.filter(primary)", "cited", (value) => {
    value.docs[0].lineage = { status: "unknown", kind: "unclassified" };
    value.docs[0].authority.tier = "T4";
  }],
  ["ineligible unknown lineage", "cited.filter(primary)", "cited", (value) => {
    value.docs[0].lineage = { status: "unknown", kind: "unclassified" };
    value.docs[0].authority.eligible = false;
  }],
  ["absence", "if (ABSENCE.test(claim) ||", "if (false && ABSENCE.test(claim) ||", (value) => {
    value.question = "Any duplicate charges?"; value.answer = "There are no duplicate charges [1].";
    value.docs[0].snippet = "There are no duplicate charges.";
  }],
  ["span binding", "if (!supporting.length || !monthsIn(claim).every(month => spanMonths.has(month)))", "if (false)", (value) => { value.answer = value.answer.replace("120.00", "121.00"); }],
  ["currency binding", "currencyInSpan(claim, span)", "true", (value) => { value.answer = value.answer.replace("USD", "CAD"); }],
  ["month binding", "monthsIn(claim).every(month => spanMonths.has(month))", "true", (value) => { value.answer = "Card ending 4242 statement months: January, April [1]."; }],
  ["question account binding", "ids.every((id) => tokens.has(id))", "true", (value) => { value.question = "What did card ending 4343 charge?"; }],
  ["quoted account binding", "quotedValues(claim).every((quote) => span.includes(quote))", "true", (value) => { value.answer = 'Account "Reserve" charged USD 120.00 [1].'; }],
]) {
  test(`source mutation is killed: ${guard}`, async () => {
    const control = input();
    assert.deepEqual(applyMoneyVeto(control), { answer: control.answer, evidenceGate: control.evidenceGate });
    const adversarial = input();
    mutate(adversarial);
    assert.equal(adversarial.evidenceGate.supported, true);
    assert.equal(adversarial.docs[0].n, 1, "nonempty cited evidence reaches the guard");
    assert.equal(applyMoneyVeto(adversarial).answer, null, "real guard catches the defect");
    const mutant = await mutatedModule(moduleURL, from, to);
    assert.equal(mutant.applyMoneyVeto(adversarial).answer, adversarial.answer,
      "removing this guard admits the exact unsafe fixture, so the negative test is not vacuous");
  });
}

test("source mutation is killed: incomplete answer cannot be complete", async () => {
  const value = input();
  const control = applyMoneyVeto(value);
  assert.equal(control.evidenceGate.complete, true);
  value.answer += " The documents do not confirm the requested total.";
  assert.equal(applyMoneyVeto(value).evidenceGate.complete, false);
  assert.equal(applyMoneyVeto(value).evidenceGate.partial, true);
  const mutant = await mutatedModule(moduleURL, "if (incomplete) return", "if (false) return");
  assert.equal(mutant.applyMoneyVeto(value).evidenceGate.complete, true);
});

test("source mutation is killed: agent artifact demotion", async () => {
  const row = { source: "records", source_kind: "bank", ref_key: "one", title: "Statement" };
  assert.equal(evidenceLineageFor(row).lineage.kind, "source_record");
  const mutant = await mutatedModule(new URL("../src/lib/evidence-lineage.js", import.meta.url),
    "if (agentMarked || isAgentDerivedArtifact(row))", "if (agentMarked)");
  for (const title of ["SKILL.md", "AI financial brief", "AI assistant notes"]) {
    assert.equal(evidenceLineageFor({ ...row, title }).lineage.kind, "agent_derived");
    assert.equal(mutant.evidenceLineageFor({ ...row, title }).lineage.kind, "source_record");
  }
});

test("money guard never promotes upstream verdicts or changes non-money output", () => {
  for (const supported of [false, undefined]) {
    const value = input(); value.evidenceGate.supported = supported;
    assert.equal(applyMoneyVeto(value).evidenceGate, value.evidenceGate);
  }
  const value = input();
  value.question = "How many chairs?";
  value.answer = "12 chairs [1]. The documents do not confirm their color.";
  value.docs[0].date_reliable = false;
  assert.equal(JSON.stringify(applyMoneyVeto(value)), JSON.stringify({ answer: value.answer, evidenceGate: value.evidenceGate }));
});

// These mutations exercise the widened equivalences through the same veto.
for (const [label, from, to, answer, snippet] of [
  ["expanded range interior", "months.push(MONTH_ORDER[i]);", "", "Statement months: Jul–Sep [1].", "Statement months: July, September"],
  ["monthly rate binding", "candidate.rate === fact.rate", "true", "$5,000 per month charged [1].", "$5k per year charged"],
  ["fallback date locality", ".filter(snippet => inSpan(claim, question, { ...doc, snippet, ts: \"\" }))\n    .flatMap(snippet => [...snippet.matchAll", ".filter(() => true)\n    .flatMap(snippet => [...snippet.matchAll", "Card ending 4242 charged USD 120.00 [1].", "Card ending 4242 charged USD 120.00. An appointment was on 2026-10-10."],
]) {
  test(`calibration mutation killed: ${label}`, async () => {
    const control = input();
    assert.equal(applyMoneyVeto(control).answer, control.answer);
    const value = input();
    value.question = "What does the money record say?";
    value.answer = answer; value.docs[0].snippet = snippet;
    if (label === "fallback date locality") value.docs[0].date_reliable = false;
    assert.equal(value.evidenceGate.supported, true);
    assert.equal(value.docs[0].n, value.evidenceGate.evidence[0]);
    assert.equal(applyMoneyVeto(value).answer, null);
    const mutant = await mutatedModule(moduleURL, from, to);
    assert.equal(mutant.applyMoneyVeto(value).answer, value.answer);
  });
}
