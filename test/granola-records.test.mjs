import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeGranolaRecord } from "../connectors/granola-records.mjs";
import { ingestEnvelopeValidationError } from "../worker/src/lib/ingest-envelope.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/granola/${name}.json`, import.meta.url)));
const full = fixture("full");
const options = { source: "meeting-export", ownerEmail: full.owner_email };
const normalize = record => normalizeGranolaRecord(record, options);

test("full export keeps exact words, ordered segments, date and native lineage", () => {
  const doc = normalize(full);
  assert.equal(ingestEnvelopeValidationError(doc), null);
  assert.equal(doc.source_type, options.source);
  assert.equal(doc.title, full.title);
  assert.equal(doc.occurred_at, full.meeting_at);
  assert.equal(doc.date_source, "granola:meeting_at");
  assert.equal(doc.date_reliable, true);
  assert.equal(doc.text_source, "native");
  assert.equal(doc.text_reliable, true);
  let previous = -1;
  for (const segment of full.transcript) {
    const offset = doc.content.indexOf(segment.text);
    assert.ok(offset > previous);
    previous = offset;
  }
  assert.ok(doc.content.includes(full.notes));
  assert.ok(!doc.content.includes(full.summary));
  assert.equal(doc.metadata.granola.transcript_status, "available");
  assert.deepEqual(doc.metadata.granola.segments, full.transcript.map(({ text, ...segment }) => segment));
  assert.deepEqual(doc.metadata.evidence_lineage.root_ids, [`${doc.source_type}:${doc.source_id}`]);
  assert.equal(doc.metadata.provenance_receipt.status, "complete");
  assert.equal(doc.uri, null);
});

test("export attendee labels never assert attendance or identify speakers by email", () => {
  const doc = normalize(full);
  assert.deepEqual(doc.metadata.granola.attendees, full.attendees);
  assert.equal(doc.metadata.granola.attendance, "unverified");
  assert.match(doc.metadata.attendees, /attendance unverified/);
  assert.equal(doc.metadata.participant_emails, undefined);
  assert.equal(doc.metadata.granola.segments[1].speaker, "Reviewer");
});

test("missing transcript accepts private notes with a visible coverage label", () => {
  const doc = normalize(fixture("notes-only"));
  assert.equal(ingestEnvelopeValidationError(doc), null);
  assert.equal(doc.metadata.granola.artifact_kind, "notes");
  assert.equal(doc.metadata.granola.transcript_status, "missing");
  assert.equal(doc.metadata.granola.notes_only, true);
  assert.match(doc.content, /Notes only; transcript unavailable/);
  const later = normalize({ ...fixture("notes-only"), transcript: full.transcript });
  assert.equal(later.source_id, doc.source_id, "a delayed transcript revises the same meeting");
});

test("summary-only and empty exports reach content assessment and refuse", () => {
  assert.ok(normalize(full).content.length > 0, "green content control");
  for (const record of [fixture("summary-only"), { ...full, transcript: [], notes: "" }]) {
    assert.throws(() => normalize(record), error =>
      error.code === "GRANOLA_SOURCE_TEXT_REQUIRED" && error.stage === "content");
  }
});

test("identity uses exact account and meeting ID rather than title or transport time", () => {
  const original = normalize(full);
  assert.notEqual(normalize({ ...full, id: "meeting-004" }).source_id, original.source_id);
  for (const id of [` ${full.id}`, `${full.id} `, "é", "e\u0301", "x:y", "x/y"]) {
    assert.notEqual(normalize({ ...full, id }).source_id, original.source_id);
  }
  assert.notEqual(normalize({ ...full, id: "é" }).source_id, normalize({ ...full, id: "e\u0301" }).source_id);
  const other = "other-owner@example.invalid";
  assert.notEqual(normalizeGranolaRecord({ ...full, owner_email: other }, { ...options, ownerEmail: other }).source_id,
    original.source_id);
  assert.equal(normalize({ ...full, title: "Corrected session title", attendees: ["Observer"],
    exported_at: "2026-11-01T12:00:00Z" }).source_id, original.source_id);
});

test("malformed schema, missing stable identity and invalid dates refuse without inferred values", () => {
  assert.equal(normalize(full).date_reliable, true, "green date and identity control");
  for (const patch of [
    { id: undefined }, { id: "" }, { meeting_at: undefined }, { meeting_at: "2026-02-30T10:00:00Z" },
    { meeting_at: "2026-10-30T10:00:00" }, { exported_at: "tomorrow" }, { attendees: "Owner" },
    { attendees: [{ email: "observer@example.invalid", attended: true }] }, { transcript: undefined },
    { transcript: [{ ...full.transcript[0], source: "unknown" }] },
    { transcript: [{ ...full.transcript[0], start: -1 }] },
    { transcript: [{ ...full.transcript[0], text: 1 }] },
    { transcript: [{ ...full.transcript[0], invented: true }] },
    { transcript: [full.transcript[1], full.transcript[0]] },
    { extra: true }, { notes: {} },
  ]) assert.throws(() => normalize({ ...full, ...patch }), error =>
    error.code === "GRANOLA_EXPORT_INVALID" && error.stage === "schema");
});

test("wrong-account export is inspected and refused without normalization", () => {
  assert.ok(normalize(full).source_id, "green bound-account control");
  assert.throws(() => normalize({ ...full, owner_email: "other-owner@example.invalid" }), error =>
    error.code === "GRANOLA_ACCOUNT_MISMATCH" && error.stage === "account");
});
