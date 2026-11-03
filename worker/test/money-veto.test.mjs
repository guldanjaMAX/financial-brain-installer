import assert from "node:assert/strict";
import { test } from "node:test";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { demoteScaffolding } from "../src/index.js";
import { evidenceLineageFor } from "../src/lib/evidence-lineage.js";
import { applyMoneyVeto, isMoneyAnswer, isMoneyQuestion } from "../src/lib/money-veto.js";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";
import { applyTemporalVeto } from "../src/lib/temporal-guard.js";
import { tierOf } from "../src/lib/evidence-authority.js";
import { assembleOcr } from "../../ingest/ocr.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const CONTENT = "Card ending 4242 charged USD 120.00 on 2026-10-10. Statement months: January, February, March.";
const ANSWER = "Card ending 4242 charged USD 120.00 [1].";

async function run(t, {
  question = "What did card ending 4242 charge in the last 60 days?",
  answer = ANSWER, content = CONTENT, date = "2026-10-10", reliable = true,
  title = "Card statement", lineage = "source_record", kind = "bank", verdict = {}, expectedVerifiers = 1,
  textSource = "native", zeroChunkDocuments = 0, additionalDocuments = [],
} = {}) {
  t.mock.method(Date, "now", () => NOW);
  let drafts = 0, verifiers = 0, network = 0;
  t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("network forbidden"); });
  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
      verifiers++;
      return { response: { supported: true, complete: true, evidence: [1], reason: "injected approval", ...verdict } };
    }
    drafts++;
    return { response: answer };
  } } } });
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records',?,'ready',?)", kind, "2026-10-10");
    for (let index = 0; index < zeroChunkDocuments; index++) {
      fixture.raw(`INSERT INTO documents
        (doc_uid,source,source_id,title,ingested_at,content_hash,meta,text_source,text_reliable)
        VALUES (?, 'records', ?, ?, ?, ?, '{}', 'native', 1)`,
      `zero-chunk-${index}`, `zero-chunk-${index}`, `Unrelated archive ${index}`, NOW, `hash-${index}`);
    }
    const documents = [{
      source_type: "records", source_id: "record-one", title, content,
      occurred_at: date, date_reliable: reliable, date_source: "fixture:record_date",
      text_source: textSource, text_reliable: true,
      metadata: lineage ? { evidence_lineage: { version: 1, kind: lineage } } : {},
    }, ...additionalDocuments];
    const response = await fixture.post("/api/admin/brain/ingest/batch", { docs: documents },
      { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).results.map((row) => row.status),
      documents.map(() => "created"));
    fixture.env.VECTORIZE.query = async () => ({ matches: fixture.rows("SELECT chunk_uid AS id FROM chunks") });
    const result = await fixture.post("/api/rag/think", { q: question }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.ok(body.results.length, "real retrieval reached stored evidence");
    assert.equal(drafts, 1, "real draft path was reached");
    assert.equal(verifiers, expectedVerifiers, "the expected verifier decision path was reached");
    assert.equal(body.evidence_gate.error, undefined, "a thrown verifier is not a veto");
    assert.equal(network, 0);
    return body;
  } finally { fixture.close(); }
}

test("money: a dated primary record passes unchanged", async (t) => {
  const body = await run(t);
  assert.equal(body.answer, ANSWER);
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.evidence_gate.complete, true);
});

for (const topic of ["a statement", "statements", "desire statements"]) {
  test(`money topic: generic ${topic} stays outside the money contract`, () => {
    const question = `What did the founder say about ${topic} on our last call?`;
    assert.equal(isMoneyQuestion("What did the bank statement say?"), true, "financial control reaches the classifier");
    assert.equal(isMoneyQuestion(question), false);
    assert.equal(isMoneyAnswer(question, `The founder discussed ${topic} [1].`), false);
  });
}

test("money topic: native call transcript answers a desire-statements question", async (t) => {
  const answer = "The founder suggested writing three desire statements before the next call [1].";
  const body = await run(t, {
    question: "What did the founder say about desire statements on our last call?",
    answer, content: "The founder suggested writing three desire statements before the next call.",
    title: "Founder call transcript", kind: "zoom",
  });
  assert.equal(body.results[0].authority.tier, "T4", "the native transcript reaches its real authority decision");
  assert.equal(body.results[0].text_source, "native");
  assert.equal(body.answer, answer, body.evidence_gate.reason);
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.gaps.some(gap => gap.type === "money_veto"), false);
});

test("money topic: desire-statements questions retain ordinary retrieval windows", async (t) => {
  const body = await run(t, {
    question: "What did the founder say about desire statements in the last 2 days?",
    answer: "The founder suggested writing desire statements [1].",
    content: "The founder suggested writing desire statements.",
    title: "Founder call transcript", kind: "zoom",
  });
  assert.equal(body.time_window?.from, "2026-10-09T00:00:00.000Z");
  assert.equal(body.evidence_gate.supported, true);
  const money = await run(t, { question: "What did I pay in the last 2 days?" });
  assert.equal(money.answer, ANSWER);
  assert.equal(money.time_window, undefined, "real money keeps its verifier-only window contract");
});

// The short spend question now belongs to the deterministic ledger route.
// Keep this peer on document retrieval so it exercises the exact-span veto.
test("money topic: recorded spending stays on the document-veto path", () => {
  const options = { now: NOW, timeZone: "UTC" };
  assert.equal(classifyLedgerQuestion("What did I spend?", options).kind, "expense_summary",
    "the supported spend control reaches the ledger classifier");
  const question = "What spending amount was recorded?";
  assert.equal(isMoneyQuestion(question), true, "the replacement reaches the money classifier");
  assert.equal(classifyLedgerQuestion(question, options).kind, null);
});

for (const question of [
  "What is my balance?", "What spending amount was recorded?", "What payment was recorded?",
  "What does the invoice say?", "What does the bank statement say?",
  "What amount was recorded?", "What was the price?", "What did I pay?",
]) {
  test(`money topic: unsupported financial question stays guarded: ${question}`, async (t) => {
    const control = await run(t, { question });
    assert.equal(control.answer, ANSWER, control.evidence_gate.reason);
    const body = await run(t, { question, answer: ANSWER.replace("120.00", "121.00") });
    assert.equal(body.answer, null);
    assert.equal(body.gaps.find(gap => gap.type === "money_veto")?.rule, "span_mismatch");
  });
}

test("money topic: an explicit financial answer stays guarded when the question is generic", () => {
  const input = {
    now: NOW, question: "What did the statement say?", answer: ANSWER,
    evidenceGate: { supported: true, complete: true, evidence: [1] },
    docs: [{ n: 1, ts: "2026-10-10", date_reliable: true, snippet: CONTENT }],
  };
  assert.equal(applyMoneyVeto(input).answer, ANSWER, "supported money answer is the green control");
  input.answer = ANSWER.replace("120.00", "121.00");
  const refused = applyMoneyVeto(input);
  assert.equal(refused.answer, null);
  assert.equal(refused.gap.rule, "span_mismatch", "explicit money reaches the exact-span decision");
});

test("money topic: mixed question checks the money sentence without demanding bank authority for call prose", () => {
  const nonMoney = "The founder said desire statements express intent [1].";
  const money = "The bank statement records a charge of USD 120.00 [2].";
  const input = {
    now: NOW,
    question: "What did the founder say about desire statements, and what did the bank statement record?",
    answer: `${nonMoney} ${money}`,
    evidenceGate: { supported: true, complete: true, evidence: [1, 2] },
    docs: [
      { n: 1, ts: "2026-10-10", date_reliable: true, authority: { tier: "T4" },
        snippet: "The founder said desire statements express intent." },
      { n: 2, ts: "2026-10-10", date_reliable: true, authority: { tier: "T1" },
        snippet: "The bank statement records a charge of USD 120.00." },
    ],
  };
  assert.equal(isMoneyQuestion(input.question), true, "mixed question enters the real money decision");
  assert.deepEqual(applyMoneyVeto(input), { answer: input.answer, evidenceGate: input.evidenceGate });
  input.answer = `${nonMoney} ${money.replace("120.00", "121.00")}`;
  const refused = applyMoneyVeto(input);
  assert.equal(refused.answer, null);
  assert.equal(refused.gap.rule, "span_mismatch", "only the changed financial sentence causes refusal");
  input.answer = `${nonMoney} The documents do not confirm the charge.`;
  const partial = applyMoneyVeto(input);
  assert.equal(partial.answer, input.answer);
  assert.equal(partial.evidenceGate.complete, false);
  assert.equal(partial.gap.rule, "incomplete_claim");
});

test("money topic: desire-statements wording no longer bypasses the temporal guard", () => {
  const input = {
    question: "When is my next call with the founder about desire statements?",
    answer: "Your next call with the founder is October 12, 2026 [1].",
    evidenceGate: { supported: true, complete: true, evidence: [1] },
    docs: [{ n: 1, title: "Founder call", snippet: "Call with the founder on October 12, 2026.",
      ts: "2026-10-12", occurred_at: "2026-10-12", date_source: "calendar:all_day_start",
      date_reliable: true, text_reliable: true }],
    now: NOW, timeZone: "UTC",
  };
  assert.equal(applyTemporalVeto(input).answer, input.answer, "future call is the green control");
  const refused = applyTemporalVeto({ ...input, now: Date.parse("2026-10-13T12:00:00Z") });
  assert.equal(refused.answer, null);
  assert.equal(refused.gap.type, "temporal_conflict", "approved cited event reached the date decision");
});

for (const kind of ["gmail", "imessage", "upload", "calendar", "gdrive"]) {
  test(`money: dated unknown-lineage ${kind} supports its cited figure`, async (t) => {
    const body = await run(t, { lineage: null, kind });
    assert.equal(body.results[0].lineage.status, "unknown", "stored legacy lineage remains unknown");
    assert.equal(body.results[0].lineage.kind, "unclassified");
    assert.equal(body.answer, ANSWER);
    assert.equal(body.evidence_gate.supported, true);
    assert.equal(body.evidence_gate.complete, true);
    assert.equal(body.citations[0].lineage.status, "unknown", "acceptance grants no corroboration credit");
  });
}

for (const [label, mutation, reason] of [
  ["unreliable date without a claim date", { reliable: false, content: CONTENT.replace(" on 2026-10-10", "") }, /reliable date/i],
  ["outside window", { date: "2026-07-01" }, /window/i],
  ["agent-derived email", { lineage: "agent_derived" }, /primary|agent/i],
  ["agent instruction file", { title: "AGENTS.md" }, /primary|agent/i],
  ["AI brief", { title: "AI financial brief" }, /primary|agent/i],
  ["AI assistant notes", { title: "AI assistant notes" }, /primary|agent/i],
  ["wrong figure", { answer: ANSWER.replace("120.00", "121.00") }, /span/i],
  ["absence claim", { answer: "Nothing is due [1].", content: "Nothing is due for card ending 4242." }, /ledger|whole window/i],
]) {
  test(`money: legacy support still refuses ${label}`, async (t) => {
    const body = await run(t, { lineage: null, kind: "gmail", ...mutation });
    assert.equal(body.results[0].lineage.status, "unknown", "the legacy evidence was actually retrieved");
    assert.equal(body.answer, null);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.evidence_gate.complete, false);
    assert.match(body.evidence_gate.reason, reason);
    assert.ok(body.gaps.length, "retrieval gaps survive the veto");
  });
}

for (const [label, mutation, reason] of [
  ["unreliable date without a claim date", { reliable: false, content: CONTENT.replace(" on 2026-10-10", "") }, /reliable date/i],
  ["before the window", { date: "2026-07-01" }, /window/i],
  ["agent lineage", { lineage: "agent_derived" }, /primary|agent|lineage/i],
  ["agent filename", { title: "SKILL.md" }, /primary|agent|lineage/i],
  ["AI brief", { title: "AI financial brief" }, /primary|agent|lineage/i],
  ["wrong figure", { answer: ANSWER.replace("120.00", "121.00") }, /span/i],
  ["wrong account", { answer: ANSWER.replace("4242", "4343") }, /span/i],
  ["wrong month list", { answer: "Card ending 4242 statement months: January, April [1]." }, /span/i],
  ["wrong question account", { question: "Which statement months are recorded for card ending 4343?", answer: "January, February, March [1]." }, /span/i],
  ["document absence", { answer: "There are no duplicate charges [1].", content: "There are no duplicate charges for card ending 4242 over the last 60 days." }, /ledger|whole window/i],
  ["all statements", { question: "Do I have every 2025 bank statement?", answer: "All 2025 statements are present [1].", content: "All 2025 statements are present." }, /ledger|whole window/i],
  ["nothing due", { answer: "Nothing is due [1].", content: "Nothing is due for card ending 4242." }, /ledger|whole window/i],
  ["short absence", { question: "Any duplicate or unusual charges in the last 60 days?", answer: "No [1].", content: "No duplicate charges." }, /ledger|whole window/i],
  ["short completeness", { question: "Do I have every 2025 bank statement?", answer: "Yes [1].", content: "All 2025 statements are present." }, /ledger|whole window/i],
  ["title-only figure", { title: "Card ending 4242 USD 120.00", content: "Card ending 4242 statement has no amount printed." }, /span/i],
  ["wrong currency", { answer: ANSWER.replace("USD", "CAD") }, /span/i],
  ["wrong magnitude", { answer: ANSWER.replace("120.00", "120.00 million") }, /span/i],
  ["uncertainty followed by invented money", { answer: "The documents do not confirm the total, but card ending 4242 charged USD 999.00 [1]." }, /span/i],
  ["bare question account", { question: "Which statement months are recorded for account 4343?", answer: "January, February, March [1]." }, /span/i],
  ["alphanumeric question account", { question: "Which statement months are recorded for account AC4343?", answer: "January, February, March [1]." }, /span/i],
  ["currency from a different figure", { answer: ANSWER.replace("USD", "CAD"), content: `${CONTENT} A different charge was CAD 300.00.` }, /span/i],
  ["word figure with agent support", { question: "How much was charged?", answer: "One hundred dollars [1].", content: "One hundred dollars.", lineage: "agent_derived" }, /primary|agent|lineage/i],
  ["word figure mismatch", { question: "How much was charged?", answer: "Two hundred dollars [1].", content: "One hundred dollars." }, /span/i],
]) {
  test(`money veto: ${label} despite model approval`, async (t) => {
    const body = await run(t, mutation);
    assert.equal(body.answer, null);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.evidence_gate.complete, false);
    assert.match(body.evidence_gate.reason, reason);
    assert.ok(body.gaps.length, "retrieval gaps survive the veto");
  });
}

test("money: explicit unconfirmed core remains partial despite complete model verdict", async (t) => {
  const answer = `${ANSWER} The documents do not confirm whether all statements are present.`;
  const body = await run(t, { question: "What was charged and do I have all statements?", answer });
  assert.equal(body.answer, answer);
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
});

test("money: a subject-first uncertainty sentence stays partial", async (t) => {
  const answer = `${ANSWER} Payment status is unconfirmed.`;
  const body = await run(t, { answer });
  assert.equal(body.answer, answer);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
});

test("money: a rejected verifier can never be promoted", async (t) => {
  const body = await run(t, { verdict: { supported: false, complete: false } });
  assert.equal(body.answer, null);
  assert.equal(body.evidence_gate.supported, false);
});

test("non-money: response prose and verdict remain byte-identical", async (t) => {
  const answer = "The workshop has 12 chairs [1].";
  const body = await run(t, { question: "How many chairs are in the workshop?", answer, content: answer, reliable: false, lineage: "agent_derived" });
  assert.equal(body.answer, answer);
  assert.equal(JSON.stringify(body.evidence_gate), JSON.stringify({ supported: true, complete: true, evidence: [1], reason: "injected approval" }));
});

test("agent filename and AI brief are one-way lineage and authority demotions", () => {
  const base = { source_kind: "bank", source: "records", ref_key: "one", title: "Bank statement", text: CONTENT };
  assert.equal(evidenceLineageFor(base).lineage.kind, "source_record");
  assert.equal(tierOf(base).tier, "T1");
  for (const title of ["SKILL.md", "folder/SKILL.md", "AGENTS.md", "AI financial brief", "AI agent-written financial summary", "AI assistant notes", "AI assistant-written financial summary"]) {
    const row = { ...base, title };
    assert.equal(evidenceLineageFor(row).lineage.kind, "agent_derived", title);
    assert.equal(tierOf(row).tier, "T4", title);
  }
  const skill = { title: "folder/SKILL.md" };
  assert.deepEqual(demoteScaffolding([skill, base]), [base, skill]);
  assert.deepEqual(demoteScaffolding([base, { title: "record.txt" }]), [base, { title: "record.txt" }]);
});

// Calibration uses only invented document prose and the real Think fixture above.
const equivalences = [
  ["savings ratio", "$0 of $80,000 saved", "0 / 80k saved"],
  ["uppercase thousands", "$80,000 saved", "$80K saved"],
  ["fractional millions", "USD 1,200,000 saved", "$1.2m saved"],
  ["uppercase millions", "$1,200,000 saved", "1.2M USD saved"],
  ["suffix currency", "$4,997 charged", "4997.00 USD charged"],
  ["reverse currency", "4997.00 USD charged", "$4,997 charged"],
  ["simple words", "$80,000 saved", "eighty thousand dollars saved"],
  ["reverse words", "eighty thousand dollars saved", "$80,000 saved"],
  ["negative suffix", "-$80,000 charged", "-80k USD charged"],
  ["monthly words", "$5,000/month charged", "5k a month charged"],
  ["monthly slash", "$5,000 per month charged", "USD 5k/mo charged"],
  ["monthly suffix", "$5,000 monthly charged", "5000.00 USD per month charged"],
  ["monthly prefix", "$5,000/month charged", "monthly charge of USD 5k"],
  ["month range", "Statement months: Jul–Sep", "Statement months: July, August, September"],
  ["month through", "Statement months: July through September", "Statement months: July, August, September"],
  ["quarter", "Statement months: Q3", "Statement months: July, August, September"],
  ["reverse quarter", "Statement months: July, August, September", "Statement months: Q3"],
  ...["x1234", "•1234", "****1234"].map(mask => ["account " + mask,
    "Card ending 1234 charged $80", `Card ${mask} charged USD 80.00`]),
];
for (const [label, claim, span] of equivalences) {
  test(`calibration Think control: ${label}`, async t => {
    const answer = `${claim} [1].`;
    const body = await run(t, { question: "What does the money record say?", answer, content: span });
    assert.equal(body.answer, answer, body.evidence_gate.reason);
    assert.equal(body.evidence_gate.supported, true);
    assert.equal(body.gaps.some(gap => gap.type === "money_veto"), false);
  });
}

for (const [label, claim, span] of [
  ["magnitude", "$80 charged", "80k charged"],
  ["currency", "$80,000 charged", "80k CAD charged"],
  ["currency pair", "CAD 80,000 charged", "USD 80k charged; CAD 90k charged"],
  ["sign", "-$80,000 charged", "80k USD charged"],
  ["suffix sign", "$80,000 charged", "-80k USD charged"],
  ["month outside", "Statement months: Jul–Oct", "Statement months: July, August, September"],
  ["range hole", "Statement months: Jul–Sep", "Statement months: July, September"],
  ["quarter hole", "Statement months: Q3", "Statement months: July, September"],
  ["different mask", "Card ending 1234 charged $80", "Card x5678 charged USD 80"],
  ["long identifier", "Card ending 1234 charged $80", "Card 991234 charged USD 80"],
  ["rate unit", "$5,000/month charged", "$5k per year charged"],
  ["rate different amount", "$5,000/month charged", "$5k charged; $7k a month charged"],
]) {
  test(`calibration Think refusal: ${label}`, async t => {
    const body = await run(t, { question: "What does the money record say?", answer: `${claim} [1].`, content: span });
    assert.equal(body.answer, null);
    assert.equal(body.evidence_gate.supported, false);
    const diagnostic = body.gaps.filter(gap => gap.type === "money_veto");
    assert.deepEqual(diagnostic, [{ type: "money_veto", rule: "span_mismatch", count: 1,
      detail: "I can help review the source, but this money claim is unconfirmed. The amount, account, or month does not match the cited words.\nWant to check the original record?" }]);
  });
}

for (const dateText of ["2026-10-10", "October 10, 2026"]) {
  test(`calibration Think explicit span date: ${dateText}`, async t => {
    const body = await run(t, { reliable: false, content: `Card ending 4242 charged USD 120.00 on ${dateText}.` });
    assert.equal(body.answer, ANSWER, body.evidence_gate.reason);
    assert.equal(body.citations[0].date_reliable, false, "metadata is not promoted by a claim-specific date");
  });
}
for (const [label, content, rule] of [
  ["undated", "Card ending 4242 charged USD 120.00.", "unreliable_date"],
  ["unrelated date", "Card ending 4242 charged USD 120.00. An appointment was on 2026-10-10.", "unreliable_date"],
  ["invalid day", "Card ending 4242 charged USD 120.00 on 2026-02-30.", "unreliable_date"],
  ["ambiguous dates", "Card ending 4242 charged USD 120.00 on 2026-10-09 or 2026-10-10.", "unreliable_date"],
  ["old claim", "Card ending 4242 charged USD 120.00 on 2026-01-10.", "citation_outside_window"],
]) {
  test(`calibration Think date refusal: ${label}`, async t => {
    const body = await run(t, { reliable: false, content });
    assert.equal(body.answer, null);
    assert.equal(body.gaps.find(gap => gap.type === "money_veto")?.rule, rule);
  });
}

test("calibration model refusal has no veto diagnostic", async t => {
  const body = await run(t, { verdict: { supported: false, complete: false } });
  assert.equal(body.answer, null);
  assert.equal(body.gaps.some(gap => gap.type === "money_veto"), false);
});

function calibrationInput(answer, spans) {
  return { now: NOW, question: "What does the money record say?", answer,
    evidenceGate: { supported: true, complete: true, evidence: spans.map((_, i) => i + 1) },
    docs: spans.map((snippet, i) => ({ n: i + 1, snippet, ts: "2026-10-10", date_reliable: true })) };
}
test("calibration months can use multiple exact cited spans without filling a hole", () => {
  const input = calibrationInput("Statement months: Jul–Sep [1][2][3].", ["July", "August", "September"]);
  assert.equal(applyMoneyVeto(input).answer, input.answer);
  input.docs[1].snippet = "October";
  assert.equal(input.docs.length, 3, "all cited records reach the month decision");
  assert.equal(applyMoneyVeto(input).answer, null);
});
test("calibration cannot assemble an amount from separate cited records", () => {
  const input = calibrationInput("Card ending 1234 charged $80,000 [1][2].", ["Card x1234 charged $80k", "Other card charged $90k"]);
  assert.equal(applyMoneyVeto(input).answer, input.answer);
  input.docs[0].snippet = "Card x1234 charged $70k";
  input.docs[1].snippet = "Other card charged $80k";
  assert.equal(input.docs.length, 2);
  assert.equal(applyMoneyVeto(input).answer, null);
});

for (const [label, claim, span, supported] of [
  ["numeric scale words", "$1,200,000 saved [1].", "USD 1.2 million saved", true],
  ["scale without coefficient", "$0 saved [1].", "thousand dollars saved", false],
  ["same quoted label", 'Account "One" charged $80 [1].', 'Account "One" charged $80', true],
  ["different quoted label", 'Account "One" charged $80 [1].', 'Account "1" charged $80', false],
  ["header cannot fill month hole", "Statement months: Jul–Sep [1].", "[August] Statement months: July, September", false],
]) {
  test(`calibration exact binding: ${label}`, () => {
    const control = calibrationInput("Statement months: Jul–Sep [1].", ["July, August, September"]);
    assert.equal(applyMoneyVeto(control).answer, control.answer);
    const input = calibrationInput(claim, [span]);
    assert.equal(input.evidenceGate.supported, true);
    assert.equal(input.docs.length, 1);
    const result = applyMoneyVeto(input);
    assert.equal(result.answer, supported ? input.answer : null);
  });
}

for (const [label, claim, span, supported] of [
  ["reverse numeric scale", "USD 1.2 million saved [1].", "$1,200,000 saved", true],
  ["qualified dollar symbol", "$80 charged [1].", "CAD $80 charged", false],
  ["dollar cents", "$80 charged [1].", "80 cents charged", false],
  ["exact large decimal", "USD 9007199254740993 charged [1].", "$9007199254740.993k charged", true],
  ["large decimal neighbor", "USD 9007199254740992 charged [1].", "$9007199254740.993k charged", false],
  ["masked question control", "Card ending 1234 charged USD 80 [1].", "Card x1234 charged $80", true],
]) {
  test(`calibration scalar boundary: ${label}`, () => {
    const control = calibrationInput("$80 charged [1].", ["USD 80 charged"]);
    assert.equal(applyMoneyVeto(control).answer, control.answer);
    const input = calibrationInput(claim, [span]);
    assert.equal(input.docs[0].n, input.evidenceGate.evidence[0]);
    assert.equal(applyMoneyVeto(input).answer, supported ? claim : null);
  });
}

for (const [label, claim, span, supported] of [
  ["suffix currency monthly", "$5,000/month charged [1].", "5000.00 USD monthly charged", true],
  ["bare quarter control", "Q3 [1].", "July, August, September", true],
  ["bare quarter hole", "Q3 [1].", "July, September", false],
  ["bare mask control", "x1234 [1].", "Card ending 1234", true],
  ["bare mask mismatch", "x1234 [1].", "Card ending 5678", false],
]) {
  test(`calibration compact answer: ${label}`, async t => {
    const body = await run(t, { question: "What does the money record say?", answer: claim, content: span });
    assert.equal(body.answer, supported ? claim : null);
  });
}

test("calibration answer-model refusal remains distinguishable from a money veto", async t => {
  const body = await run(t, { answer: "The documents do not answer the question.", expectedVerifiers: 0 });
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.evidence_gate.reason, "answer model found no direct support");
  assert.equal(body.gaps.some(gap => gap.type === "money_veto"), false);
});

test("calibration qualification reports only a fixed rule and count", async t => {
  const body = await run(t, { answer: `${ANSWER} Payment status is unconfirmed.` });
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.evidence_gate.complete, false);
  assert.deepEqual(body.gaps.filter(gap => gap.type === "money_veto"), [{ type: "money_veto",
    rule: "incomplete_claim", count: 1, detail: "I can help review the source, but some money details are still unconfirmed. Some payment details are still unknown in the records checked.\nWant to check the original record?" }]);
});

test("a money veto and a later scanned-tax gap both survive the real think route", async t => {
  const scan = assembleOcr([{
    page: 1,
    text: "Taxpayer: Fixture Owner\n2025 Form 1040\nThis complete scanned filing page contains general synthetic filing notes and enough legible text for a complete OCR receipt.",
  }], { totalPages: 1, model: "fixture-ocr-model" });
  assert.equal(scan.ok, true, "the scan control carries a real complete OCR receipt");
  const body = await run(t, {
    question: "What income is on my 2025 tax return?",
    title: "Fixture Owner 2025 Form 1040",
    content: "Taxpayer: Fixture Owner\n2025 Form 1040\nIncome was USD 120.00.",
    answer: "Income was USD 121.00 [1].",
    kind: "upload",
    zeroChunkDocuments: 21,
    additionalDocuments: [{
      source_type: "records",
      source_id: "record-scan",
      title: "Fixture Owner 2025 Form 1040 scanned copy",
      content: scan.text,
      occurred_at: "2026-10-10",
      date_reliable: true,
      date_source: "fixture:record_date",
      text_source: "ocr",
      text_reliable: false,
      metadata: {
        evidence_lineage: { version: 1, kind: "source_record" },
        ocr: scan.provenance,
      },
    }],
  });
  assert.equal(body.answer, null, "the mismatched money figure was refused");
  assert.ok(body.gaps.some((gap) => gap.type === "money_veto"),
    `the money-veto decision remains visible: ${JSON.stringify(body)}`);
  assert.ok(body.gaps.some((gap) => gap.type === "tax_evidence_unreadable"), "the scanned-tax gap remains visible");
  assert.equal(body.gaps.some((gap) => gap.type === "tax_document_inventory_unverified"), false,
    "the unreadable scanned filing replaces only the earlier tax-inventory gap");
});

test("calibration an amount cannot stand in for an account identifier", () => {
  for (const claim of ["Card ending 1234 charged $1,234 [1].", "x1234 [1]."]) {
    const input = calibrationInput(claim, ["Card x1234 charged USD 1234"]);
    assert.equal(applyMoneyVeto(input).answer, claim);
    input.docs[0].snippet = "Card x5678 charged USD 1234";
    assert.equal(input.docs[0].n, input.evidenceGate.evidence[0]);
    assert.equal(applyMoneyVeto(input).answer, null);
  }
});
