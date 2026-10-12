import assert from "node:assert/strict";
import { test } from "node:test";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { workerBindings } from "../../brain.mjs";
import { buildEnvelope } from "../../connectors/google-calendar.mjs";
import { applyTemporalVeto } from "../src/lib/temporal-guard.js";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2031-04-07T12:00:00Z");
const QUESTION = "When is my next appointment with Dr. Vexora?";
const calendar = (id, date, extra = {}) => ({
  source_type: "calendar", source_id: id, title: `Appointment Vexora ${id}`,
  content: `Appointment with Dr. Vexora on ${date}.`, occurred_at: date,
  date_source: "calendar:event_start", date_reliable: true,
  text_source: "native", text_reliable: true, ...extra,
});
const email = (id, date, content) => ({
  source_type: "email", source_id: id, title: `Care record ${id}`, content,
  occurred_at: date, date_source: "email:sent", date_reliable: true,
  text_source: "native", text_reliable: true,
});

async function run(t, { question = QUESTION, answer, docs, now = NOW, timezone = "UTC", worker } = {}) {
  t.mock.method(Date, "now", () => now);
  let drafts = 0, verifiers = 0, network = 0, rendered;
  t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("network forbidden"); });
  const fixture = await createProductFixture({ env: { BRAIN_TIMEZONE: timezone, AI: { async run(model, input) {
    if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
      verifiers++;
      const evidence = [...rendered.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
      return { response: { supported: true, complete: true, evidence, conflicts: [], reason: "injected approval" } };
    }
    drafts++;
    const prompt = input.messages.map(message => message.content).join("\n");
    rendered = answer.replace(/\{([a-z-]+)\}/g, (_, id) => {
      const doc = docs.find(item => item.source_id === id);
      const heading = prompt.split("\n").find(line => line.startsWith("[") && line.endsWith(doc.title));
      assert.ok(heading, "draft reaches the selected ingested document");
      return heading.match(/^\[\d+\]/)[0];
    });
    return { response: rendered };
  } } } });
  try {
    for (const source of new Set(docs.map(doc => doc.source_type))) {
      fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES (?,?,'ready',?)", source, source === "email" ? "gmail" : source, "2031-04-01");
    }
    const response = await fixture.post("/api/admin/brain/ingest/batch", { docs }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).results.map(result => result.status), docs.map(() => "created"));
    fixture.env.VECTORIZE.query = async () => ({ matches: fixture.rows("SELECT chunk_uid AS id FROM chunks") });
    const bodyRequest = { q: question, limit: 20 };
    const result = worker ? await worker.fetch(new Request("https://fixture.invalid/api/rag/think", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": fixture.env.ADMIN_KEY },
      body: JSON.stringify(bodyRequest),
    }), fixture.env, { waitUntil() {} }) : await fixture.post("/api/rag/think", bodyRequest, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.results.length, docs.length, "every real ingested document reached retrieval");
    assert.equal(drafts, 1, "draft decision point reached");
    assert.equal(verifiers, 1, "approving verifier reached, including an empty conflict verdict");
    assert.equal(body.evidence_gate.error, undefined, "an exception is not a temporal veto");
    assert.equal(network, 0);
    return { body, rendered };
  } finally { fixture.close(); }
}

function refused(body, reason) {
  assert.equal(body.answer, null);
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.deepEqual(body.citations, []);
  assert.match(body.evidence_gate.reason, reason);
  assert.ok(body.gaps.some(gap => gap.type === "temporal_conflict"), "veto retains an explicit gap");
}

test("temporal: owner timezone reaches the deployed binding without an invented default", () => {
  const cfg = { d1_database_id: "fixture-db" };
  const bindings = workerBindings({ client: { timezone: "Pacific/Honolulu" } }, cfg);
  assert.equal(bindings.find(binding => binding.name === "BRAIN_TIMEZONE")?.text, "Pacific/Honolulu");
  assert.equal(workerBindings({}, cfg).some(binding => binding.name === "BRAIN_TIMEZONE"), false);
});

test("temporal: the soonest future appointment passes unchanged", async (t) => {
  const { body, rendered } = await run(t, { docs: [calendar("soon", "2031-04-12"), calendar("later", "2031-06-03")],
    answer: "Your next appointment with Dr. Vexora is April 12, 2031 {soon}." });
  assert.equal(body.answer, rendered);
  assert.equal(body.evidence_gate.supported, true);
});

test("temporal: a later future appointment cannot be called next", async (t) => {
  const { body } = await run(t, { docs: [calendar("soon", "2031-04-12"), calendar("later", "2031-06-03")],
    answer: "Your next appointment with Dr. Vexora is June 3, 2031 {later}." });
  refused(body, /earlier upcoming/i);
});

test("temporal: a past email appointment cannot be called next", async (t) => {
  const { body } = await run(t, { question: "Who handles my sleep care and when do I see her next?",
    docs: [email("past", "2029-03-01", "Dr. Vexora handles sleep care. Your appointment with Dr. Vexora is on 2029-03-14.")],
    answer: "Dr. Vexora handles your sleep care; your next appointment is March 14, 2029 {past}." });
  refused(body, /past appointment/i);
});

test("temporal: a newer stopped item vetoes stale support despite model approval", async (t) => {
  const { body } = await run(t, { question: "What medications am I on right now?",
    docs: [email("old", "2031-02-02", "Fixture Owner takes Luminexol for sleep."),
      email("new", "2031-04-02", "Fixture Owner stopped Luminexol. It is no longer taken.")],
    answer: "You take Luminexol {old}." });
  refused(body, /newer.*(?:stopped|supersede)/i);
});

for (const question of ["When is my upcoming appointment with Dr. Vexora?", "When do I see Vexora?",
  "When is my appointment with Vexora?", "What meeting with Vexora is coming up?"]) {
  test(`temporal intent: ${question}`, async (t) => {
    const { body } = await run(t, { question, docs: [calendar("past", "2030-04-12")],
      answer: "The appointment is on 2030-04-12 {past}." });
    refused(body, /past appointment/i);
  });
}

for (const [label, timezone, now, date, pass] of [
  ["today", "UTC", NOW, "2031-04-07", true],
  ["yesterday", "UTC", NOW, "2031-04-06", false],
  ["west of UTC before local midnight", "Pacific/Honolulu", Date.parse("2031-04-08T05:00:00Z"), "2031-04-07", true],
  ["east of UTC after local midnight", "Pacific/Auckland", Date.parse("2031-04-07T20:00:00Z"), "2031-04-07", false],
  ["local year boundary", "Pacific/Honolulu", Date.parse("2032-01-01T04:00:00Z"), "2031-12-31", true],
  ["DST spring day", "America/New_York", Date.parse("2031-03-09T07:01:00Z"), "2031-03-09", true],
  ["DST autumn day", "America/New_York", Date.parse("2031-11-02T06:01:00Z"), "2031-11-02", true],
]) {
  test(`temporal day boundary: ${label}`, async (t) => {
    const { body, rendered } = await run(t, { timezone, now, docs: [calendar("event", date)],
      answer: `Your next appointment is ${date} {event}.` });
    if (pass) { assert.equal(body.answer, rendered); assert.equal(body.evidence_gate.supported, true); }
    else refused(body, /past appointment/i);
  });
}

test("temporal: literal today passes without reformatting", async (t) => {
  const { body, rendered } = await run(t, { docs: [calendar("event", "2031-04-07")], answer: "Your next appointment is today {event}." });
  assert.equal(body.answer, rendered);
});

for (const timezone of ["", "Invalid/Zone"]) {
  test(`temporal: ${timezone || "missing"} timezone leaves an explicit gap`, async (t) => {
    const { body } = await run(t, { timezone, docs: [calendar("event", "2031-04-12")], answer: "Your next appointment is 2031-04-12 {event}." });
    refused(body, /timezone/i);
  });
}

test("temporal: future appointments listed in order pass unchanged", async (t) => {
  const { body, rendered } = await run(t, { docs: [calendar("soon", "2031-04-12"), calendar("later", "2031-06-03")],
    answer: "Your next appointment with Dr. Vexora is 2031-04-12 {soon}. Another appointment with Dr. Vexora follows on 2031-06-03 {later}." });
  assert.equal(body.answer, rendered);
});

test("temporal: an earlier email event beats a later calendar appointment, not its sent date", async (t) => {
  const { body } = await run(t, { docs: [calendar("later", "2031-06-03"),
    email("soon", "2031-04-01", "Your appointment with Dr. Vexora is on 2031-04-12.")],
    answer: "Your next appointment with Dr. Vexora is 2031-06-03 {later}." });
  refused(body, /earlier upcoming/i);
});

test("temporal: an unrelated provider's earlier appointment does not veto", async (t) => {
  const { body, rendered } = await run(t, { docs: [calendar("later", "2031-06-03"),
    calendar("other", "2031-04-12", { title: "Appointment Ruvexa", content: "Appointment with Dr. Ruvexa on 2031-04-12." })],
    answer: "Your next appointment with Dr. Vexora is 2031-06-03 {later}." });
  assert.equal(body.answer, rendered);
});

test("temporal: a past event explicitly qualified as history passes unchanged", async (t) => {
  const { body, rendered } = await run(t, { docs: [calendar("past", "2030-04-12")],
    answer: "Last recorded appointment: 2030-04-12, which has passed {past}. No upcoming appointment is confirmed." });
  assert.equal(body.answer, rendered);
});

test("temporal: an observation date is not the upcoming appointment date", async (t) => {
  const { body, rendered } = await run(t, { docs: [email("event", "2031-04-01", "Your appointment with Dr. Vexora is on 2031-04-12.")],
    answer: "As of 2031-04-01, your next appointment with Dr. Vexora is 2031-04-12 {event}." });
  assert.equal(body.answer, rendered);
});

test("temporal: a yearless date binds to its cited occurrence without rolling the year", async (t) => {
  const good = await run(t, { docs: [calendar("event", "2031-04-12")], answer: "Your next appointment is April 12 {event}." });
  assert.equal(good.body.answer, good.rendered);
  const bad = await run(t, { docs: [calendar("event", "2030-04-12")], answer: "Your next appointment is April 12 {event}." });
  refused(bad.body, /past appointment/i);
});

test("temporal: recurring wording cannot turn an old series into a next occurrence", async (t) => {
  const { body } = await run(t, { docs: [calendar("series", "2030-04-12", { content: "Appointment with Dr. Vexora. Recurring: every Friday since 2030-04-12." })],
    answer: "You see Dr. Vexora next Friday; the appointment repeats weekly {series}." });
  refused(body, /occurrence|recurring/i);
});

test("temporal: a dated recurring instance from the real calendar connector passes", async (t) => {
  const instruction = buildEnvelope({ id: "instance", status: "confirmed", summary: "Appointment with Dr. Vexora",
    start: { dateTime: "2031-04-12T09:00:00-07:00" }, end: { dateTime: "2031-04-12T09:30:00-07:00" },
    recurringEventId: "series", originalStartTime: { dateTime: "2031-04-12T08:00:00-07:00" },
  });
  assert.equal(instruction.kind, "upsert");
  const doc = { ...instruction.envelope, source_id: "instance" };
  const { body, rendered } = await run(t, { docs: [doc],
    answer: "Your next recurring appointment with Dr. Vexora is 2031-04-12 {instance}." });
  assert.equal(body.answer, rendered);
  assert.equal(body.results[0].occurred_at, "2031-04-12T09:00:00-07:00", "real stored calendar start survived hydration");
});

for (const question of ["What medications am I on these days?", "Am I still taking Luminexol?", "What medications am I currently taking?"]) {
  for (const signal of ["stopped", "discontinued", "ended", "no longer takes"]) {
    test(`temporal status: ${question} / ${signal}`, async (t) => {
      const { body } = await run(t, { question, docs: [email("old", "2031-02-02", "Fixture Owner takes Luminexol."),
        email("new", "2031-04-02", `Fixture Owner ${signal} Luminexol.`)], answer: "You take Luminexol {old}." });
      refused(body, /newer.*(?:stopped|supersede)/i);
    });
  }
}

test("temporal status: co-citing the stopped record cannot rescue the obsolete item", async (t) => {
  const { body } = await run(t, { question: "What medications am I on right now?", docs: [email("old", "2031-02-02", "Fixture Owner takes Luminexol."),
    email("new", "2031-04-02", "Fixture Owner stopped Luminexol.")], answer: "You take Luminexol {old} {new}." });
  refused(body, /newer.*stopped/i);
});

test("temporal status: the newest item passes and an unrelated newer stop does not veto", async (t) => {
  const { body, rendered } = await run(t, { question: "What medications am I on right now?", docs: [email("old", "2031-02-02", "Fixture Owner takes Luminexol."),
    email("new", "2031-04-02", "Fixture Owner stopped Solunex.")], answer: "You take Luminexol {old}." });
  assert.equal(body.answer, rendered);
});

test("non-temporal and money prose stays byte-identical", async (t) => {
  for (const [question, content, answer] of [
    ["What did Vexora recommend?", "Dr. Vexora recommended a sleep journal.", "Dr. Vexora recommended a sleep journal {record}."],
    ["When is my next payment due?", "Payment due on 2030-04-12: USD 15.00.", "Payment due on 2030-04-12: USD 15.00 {record}."],
  ]) {
    const { body, rendered } = await run(t, { question, docs: [email("record", "2031-04-02", content)], answer });
    assert.equal(body.answer, rendered);
    assert.equal(body.evidence_gate.supported, true);
    assert.equal(body.gaps.some(gap => gap.type === "temporal_conflict"), false);
  }
});

test("temporal: same-day later event cannot hide an earlier calendar instant", async (t) => {
  const docs = ["09:00:00", "15:00:00"].map((time, index) => ({ ...buildEnvelope({ id: `event-${index}`,
    summary: "Appointment with Dr. Vexora", status: "confirmed",
    start: { dateTime: `2031-04-12T${time}-07:00` },
  }).envelope, source_id: index ? "later" : "soon" }));
  const { body } = await run(t, { docs, timezone: "America/Phoenix", answer: "Your next appointment is 2031-04-12 at 3 pm {later}." });
  refused(body, /earlier upcoming/i);
});

test("temporal: unrelated earlier event inside the same email is not a match", async (t) => {
  const { body, rendered } = await run(t, { docs: [email("events", "2031-04-01",
    "Appointment with Dr. Ruvexa is 2031-04-12. Appointment with Dr. Vexora is 2031-06-03.")],
    answer: "Your next appointment with Dr. Vexora is 2031-06-03 {events}." });
  assert.equal(body.answer, rendered);
});

function statusInput(answer = "You take Luminexol [1].") {
  return { question: "What medications am I on right now?", answer, now: NOW,
    owner: "Fixture Owner", evidenceGate: { supported: true, complete: true, evidence: [1, 2] },
    docs: [{ n: 1, ts: "2031-02-02", date_reliable: true, text_reliable: true, snippet: "Fixture Owner takes Luminexol and stopped Solunex." },
      { n: 2, ts: "2031-04-02", date_reliable: true, text_reliable: true, snippet: "Fixture Owner stopped Luminexol." }] };
}

// The existing general status gate already refuses these negative-worded
// email drafts before this veto. Exercise the new decision directly as well,
// so that an upstream refusal cannot masquerade as coverage of this guard.
test("temporal: another stopped item in the answer cannot hide an obsolete item", () => {
  const input = statusInput("You take Luminexol but stopped Solunex [1] [2].");
  assert.equal(input.evidenceGate.supported, true);
  assert.equal(input.docs.length, 2);
  const result = applyTemporalVeto(input);
  assert.equal(result.answer, null);
  assert.match(result.evidenceGate.reason, /newer.*stopped/i);
  const control = statusInput("You stopped Luminexol [2].");
  assert.deepEqual(applyTemporalVeto(control), { answer: control.answer, evidenceGate: control.evidenceGate });
});

async function mutate(url, from, to) {
  const source = readFileSync(url, "utf8");
  assert.equal(source.split(from).length - 1, 1, "mutation reaches exactly one product decision");
  const changed = source.replace(from, to).replace(/from (["'])(\.\.?\/[^"'\n]+)\1/g,
    (_, quote, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  assert.notEqual(changed, source);
  return import(`data:text/javascript,${encodeURIComponent(changed)}`);
}

test("temporal mutation: removing the route veto admits each original failure", async (t) => {
  const mutant = await mutate(new URL("../src/index.js", import.meta.url),
    "const temporal = applyTemporalVeto({", "const temporal = (input => ({ answer: input.answer, evidenceGate: input.evidenceGate }))({");
  const fixtures = [
    { docs: [calendar("soon", "2031-04-12"), calendar("later", "2031-06-03")], answer: "Your next appointment is 2031-06-03 {later}." },
    { docs: [email("past", "2029-03-01", "Appointment with Dr. Vexora on 2029-03-14.")], answer: "Your next appointment is 2029-03-14 {past}." },
    { question: "What medications am I on right now?", docs: [email("old", "2031-02-02", "Fixture Owner takes Luminexol."),
      email("new", "2031-04-02", "Fixture Owner stopped Luminexol.")], answer: "You take Luminexol {old}." },
  ];
  for (const fixture of fixtures) {
    const good = await run(t, fixture);
    refused(good.body, /earlier upcoming|past appointment|newer.*stopped/i);
    const bad = await run(t, { ...fixture, worker: mutant.default });
    assert.equal(bad.body.answer, bad.rendered, "bypassing the actual route integration admits the unsafe draft");
    assert.equal(bad.body.evidence_gate.supported, true);
  }
  const control = { docs: [calendar("soon", "2031-04-12")], answer: "Your next appointment is 2031-04-12 {soon}." };
  for (const worker of [undefined, mutant.default]) {
    const result = await run(t, { ...control, worker });
    assert.equal(result.body.answer, result.rendered, "both mutation arms retain the green control");
  }
});

test("temporal veto never promotes an upstream refusal", () => {
  const input = statusInput();
  input.evidenceGate.supported = false;
  assert.deepEqual(applyTemporalVeto(input), { answer: input.answer, evidenceGate: input.evidenceGate });
});

test("temporal: recurring history cannot support an invented future occurrence", async (t) => {
  const { body } = await run(t, { docs: [calendar("series", "2030-04-12", { content: "Appointment with Dr. Vexora. Recurring: every Friday since 2030-04-12." })],
    answer: "Your next recurring appointment is 2031-04-11 {series}." });
  refused(body, /occurrence/i);
});

test("temporal: three upcoming dates in order pass unchanged", async (t) => {
  const { body, rendered } = await run(t, { docs: [calendar("first", "2031-04-12"), calendar("second", "2031-05-02"), calendar("third", "2031-06-03")],
    answer: "Your next appointment is 2031-04-12 {first}. Another appointment is 2031-05-02 {second}. The final appointment is 2031-06-03 {third}." });
  assert.equal(body.answer, rendered);
});

test("temporal: a retrieved contradiction beyond the model excerpt still vetoes", async (t) => {
  const { body } = await run(t, { question: "What medications am I on right now?",
    docs: [email("old", "2031-02-02", "Fixture Owner takes Luminexol."),
      email("new", "2031-04-02", `${"Routine context. ".repeat(59)}Fixture Owner stopped Luminexol.`)],
    answer: "You take Luminexol {old}." });
  assert.ok(body.results.some(doc => doc.snippet.indexOf("stopped Luminexol") >= 900), "contradiction was retrieved beyond the model excerpt");
  refused(body, /newer.*stopped/i);
});

test("temporal: a different attendee declining cannot hide an earlier appointment", async (t) => {
  const { body } = await run(t, { docs: [calendar("soon", "2031-04-12", {
    content: "Appointment with Dr. Vexora on 2031-04-12. Declined: optional observer.",
  }), calendar("later", "2031-06-03")], answer: "Your next appointment with Dr. Vexora is 2031-06-03 {later}." });
  refused(body, /earlier upcoming/i);
});

test("temporal: an old email's tomorrow cannot float forward to tomorrow now", async (t) => {
  const { body } = await run(t, { docs: [email("record", "2029-03-01", "Your appointment with Dr. Vexora is tomorrow.")],
    answer: "Your next appointment with Dr. Vexora is tomorrow {record}." });
  refused(body, /occurrence/i);
});

test("historical next means sequence, not an upcoming appointment", async (t) => {
  const { body, rendered } = await run(t, { question: "What was my next appointment after the 2029-03-01 visit?",
    docs: [calendar("event", "2029-03-14")], answer: "Your next appointment after that visit was 2029-03-14 {event}." });
  assert.equal(body.answer, rendered);
});

test("temporal: all-day today and an offset instant retain their actual owner day", async (t) => {
  const allDay = await run(t, { docs: [calendar("event", "2031-04-07", { date_source: "calendar:all_day_start" })],
    answer: "Your next appointment is today {event}." });
  assert.equal(allDay.body.answer, allDay.rendered);
  const doc = { ...buildEnvelope({ id: "offset-event", summary: "Appointment with Dr. Vexora", status: "confirmed",
    start: { dateTime: "2031-04-08T09:30:00Z" },
  }).envelope, source_id: "event" };
  const offset = await run(t, { docs: [doc], timezone: "Pacific/Honolulu", now: Date.parse("2031-04-08T05:00:00Z"),
    answer: "Your next appointment is 2031-04-07T23:30:00-10:00 {event}." });
  assert.equal(offset.body.answer, offset.rendered);
});
