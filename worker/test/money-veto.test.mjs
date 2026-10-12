import assert from "node:assert/strict";
import { test } from "node:test";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { demoteScaffolding } from "../src/index.js";
import { evidenceLineageFor } from "../src/lib/evidence-lineage.js";
import { tierOf } from "../src/lib/evidence-authority.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const CONTENT = "Card ending 4242 charged USD 120.00 on 2026-10-10. Statement months: January, February, March.";
const ANSWER = "Card ending 4242 charged USD 120.00 [1].";

async function run(t, {
  question = "What did card ending 4242 charge in the last 60 days?",
  answer = ANSWER, content = CONTENT, date = "2026-10-10", reliable = true,
  title = "Card statement", lineage = "source_record", kind = "bank", verdict = {},
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
    const response = await fixture.post("/api/admin/brain/ingest/batch", { docs: [{
      source_type: "records", source_id: "record-one", title, content,
      occurred_at: date, date_reliable: reliable, date_source: "fixture:record_date",
      text_source: "native", text_reliable: true,
      metadata: lineage ? { evidence_lineage: { version: 1, kind: lineage } } : {},
    }] }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].status, "created");
    fixture.env.VECTORIZE.query = async () => ({ matches: fixture.rows("SELECT chunk_uid AS id FROM chunks") });
    const result = await fixture.post("/api/rag/think", { q: question }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.ok(body.results.length, "real retrieval reached stored evidence");
    assert.equal(drafts, 1, "real draft path was reached");
    assert.equal(verifiers, 1, "injected approving verifier was reached");
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
  ["unreliable date", { reliable: false }, /reliable date/i],
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
  ["unreliable date", { reliable: false }, /reliable date/i],
  ["before the window", { date: "2026-07-01" }, /window/i],
  ["agent lineage", { lineage: "agent_derived" }, /primary|agent|lineage/i],
  ["agent filename", { title: "SKILL.md" }, /primary|agent|lineage/i],
  ["AI brief", { title: "AI financial brief" }, /primary|agent|lineage/i],
  ["wrong figure", { answer: ANSWER.replace("120.00", "121.00") }, /span/i],
  ["wrong account", { answer: ANSWER.replace("4242", "4343") }, /span/i],
  ["wrong month list", { answer: "Card ending 4242 statement months: January, April [1]." }, /span/i],
  ["wrong question account", { question: "Which statement months are recorded for card ending 4343?", answer: "January, February, March [1]." }, /span/i],
  ["document absence", { answer: "There are no duplicate charges [1].", content: "There are no duplicate charges for card ending 4242 over the last 60 days." }, /ledger|whole window/i],
  ["all statements", { question: "Do I have every 2025 statement?", answer: "All 2025 statements are present [1].", content: "All 2025 statements are present." }, /ledger|whole window/i],
  ["nothing due", { answer: "Nothing is due [1].", content: "Nothing is due for card ending 4242." }, /ledger|whole window/i],
  ["short absence", { question: "Any duplicate or unusual charges in the last 60 days?", answer: "No [1].", content: "No duplicate charges." }, /ledger|whole window/i],
  ["short completeness", { question: "Do I have every 2025 statement?", answer: "Yes [1].", content: "All 2025 statements are present." }, /ledger|whole window/i],
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
