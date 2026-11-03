/** Exact, account-bound records from the supervised meeting export contract. */
import { createHash } from "node:crypto";
import { withFirstPartySourceProvenance } from "../worker/src/lib/provenance-receipt.js";
import { ingestEnvelopeValidationError } from "../worker/src/lib/ingest-envelope.js";

const SOURCE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const KEYS = new Set(["id", "title", "meeting_at", "attendees", "owner_email", "notes", "summary", "transcript", "exported_at"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value, max) => typeof value === "string" && value.length <= max;
const label = (value, max) => string(value, max) && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

export function granolaError(code, stage, message) {
  return Object.assign(new Error(message), { code, stage });
}
const invalid = () => { throw granolaError("GRANOLA_EXPORT_INVALID", "schema", "Meeting export does not match the reviewed schema."); };

// Date.parse alone normalizes impossible dates. Validate the local calendar
// before accepting the offset instant; export time never supplies a meeting date.
function timestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
      (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59))) return false;
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === match[1] && Number.isFinite(Date.parse(value));
}

export function normalizeGranolaRecord(record, { source = "granola", ownerEmail } = {}) {
  if (!SOURCE.test(source) || !label(ownerEmail, 320) || !EMAIL.test(ownerEmail)) {
    throw granolaError("GRANOLA_CONFIG_INVALID", "config", "A canonical source and exact owner email binding are required.");
  }
  if (!object(record) || Object.keys(record).some(key => !KEYS.has(key)) ||
      !label(record.id, 1024) || !label(record.title, 1000) ||
      !timestamp(record.meeting_at) || !timestamp(record.exported_at) ||
      !label(record.owner_email, 320) || !EMAIL.test(record.owner_email) ||
      !Array.isArray(record.attendees) || record.attendees.length > 1000 ||
      record.attendees.some(value => !label(value, 500)) ||
      (record.notes !== undefined && !string(record.notes, 400_000)) ||
      (record.summary !== undefined && !string(record.summary, 400_000)) ||
      !(record.transcript === null || Array.isArray(record.transcript))) invalid();
  if (record.owner_email !== ownerEmail) {
    throw granolaError("GRANOLA_ACCOUNT_MISMATCH", "account", "Meeting export belongs to a different owner binding.");
  }
  const segments = record.transcript || [];
  if (segments.length > 20_000) invalid();
  let previousStart = -1;
  for (const segment of segments) {
    if (!object(segment) || Object.keys(segment).length !== 4 ||
        !["speaker", "source", "start", "text"].every(key => Object.hasOwn(segment, key)) ||
        !(segment.speaker === null || label(segment.speaker, 500)) ||
        !["microphone", "system"].includes(segment.source) ||
        !(segment.start === null || (typeof segment.start === "number" && Number.isFinite(segment.start) && segment.start >= 0)) ||
        !string(segment.text, 400_000) || !segment.text.trim()) invalid();
    if (segment.start !== null) {
      if (segment.start < previousStart) invalid();
      previousStart = segment.start;
    }
  }
  const hasTranscript = segments.length > 0;
  if (!hasTranscript && !record.notes?.trim()) {
    throw granolaError("GRANOLA_SOURCE_TEXT_REQUIRED", "content", "Source transcript or private notes are required; summaries alone are refused.");
  }

  // JSON tuple encoding preserves exact IDs, separators, whitespace and Unicode.
  // A delayed transcript replaces notes for this meeting, rather than duplicating it.
  const sourceId = `meeting-v1.${Buffer.from(JSON.stringify([ownerEmail, record.id, "meeting"])).toString("base64url")}`;
  const content = [
    hasTranscript ? "Granola meeting transcript" : "Notes only; transcript unavailable",
    `Meeting: ${record.title}`,
    `Meeting date: ${record.meeting_at}`,
    ...(hasTranscript ? ["", "Transcript:", ...segments.map(segment =>
      `[${segment.start === null ? "time unavailable" : `${segment.start}s`}; ${segment.source}] ${segment.speaker ?? "Unknown speaker"}: ${segment.text}`)] : []),
    ...(record.notes?.trim() ? ["", "Private notes (export):", record.notes] : []),
  ].join("\n");
  if (Buffer.byteLength(content) > 400_000) {
    throw granolaError("GRANOLA_EXPORT_TOO_LARGE", "content", "Meeting text exceeds the bounded single-document import limit; no text was truncated.");
  }
  const envelope = withFirstPartySourceProvenance({
    source_type: source,
    source_id: sourceId,
    title: record.title,
    content,
    occurred_at: record.meeting_at,
    date_source: "granola:meeting_at",
    date_reliable: true,
    uri: null,
    metadata: {
      category: "meeting",
      attendees: record.attendees.map(value => `${value} (attendance unverified)`).join("; "),
      granola: {
        format: "granola.meeting.v1", transport: "file-export",
        meeting_id: record.id, owner_email: ownerEmail, meeting_at: record.meeting_at,
        exported_at: record.exported_at,
        // JSON member order is a serialization detail, never a meeting edit.
        payload_sha256: createHash("sha256").update(canonical(record)).digest("hex"),
        attendees: [...record.attendees], attendance: "unverified",
        artifact_kind: hasTranscript ? "transcript" : "notes",
        transcript_status: hasTranscript ? "available" : "missing",
        notes_only: !hasTranscript, summary_available: Boolean(record.summary?.trim()),
        segments: segments.map(({ speaker, source, start }) => ({ speaker, source, start })),
      },
    },
  }, { textSource: "native", textReliable: true });
  if (ingestEnvelopeValidationError(envelope)) invalid();
  return envelope;
}
