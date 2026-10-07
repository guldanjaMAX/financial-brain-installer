/**
 * A bounded, non-generative proposal for one explicitly recorded contact fact.
 * Inputs must be the authorized retrieval results and their numbered citation
 * projections. This pure module never retrieves, logs, caches, or grants access.
 * A null result means run normal generation and verification, never refuse.
 * Accepted proposals still pass the route's shared deterministic evidence gates.
 */
import { answerUsesOperativeValue, answerUsesSupersededValue, authorityFor } from "./evidence-authority.js";
import { newestCurrentEvidence, reliableDocumentTime } from "./query-intent.js";

const FIELDS = new Map([
  ["address", "address"], ["mailing address", "mailing address"],
  ["home address", "home address"], ["business address", "business address"],
  ["email", "email"], ["email address", "email"],
  ["phone", "phone"], ["phone number", "phone"],
  ["mobile", "mobile"], ["mobile number", "mobile"],
  ["company", "company"], ["organization", "company"],
  ["role", "role"], ["job title", "role"],
]);
const FIELD_PATTERN = [...FIELDS.keys()].sort((a, b) => b.length - a.length).join("|");
const POSSESSIVE_QUESTION = new RegExp(`^what(?: is|'s) (.+?)['’]s (?:current )?(${FIELD_PATTERN})\\??$`, "i");
const SUBJECT_QUESTION = new RegExp(`^what(?: is|'s) (?:the )?(?:current )?(${FIELD_PATTERN}) (?:of|for) (.+?)\\??$`, "i");
const OWNER_QUESTION = new RegExp(`^what(?: is|'s) (?:my|our) (?:current )?(${FIELD_PATTERN})\\??$`, "i");
const identity = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const QUALIFIED_FACT = /\b(?:not|no longer|old|former|previous|unknown|unconfirmed|maybe|possibly|temporary|if|unless|until|historical|superseded|instead|ignore|instructions?|must|should|please|draft|proposed|or)\b/i;
const safeSubject = (value) => typeof value === "string" && value.length <= 120 &&
  /^[\p{L}\p{N}][\p{L}\p{N} '&.,-]*$/u.test(value) &&
  !/\b(?:and|or|former|previous|old|not|unknown|my|our|the|their|this|that)\b/i.test(value);

function questionFact(question, owner) {
  const text = String(question || "").trim();
  let subject, field;
  let match = POSSESSIVE_QUESTION.exec(text);
  if (match) [, subject, field] = match;
  else if ((match = SUBJECT_QUESTION.exec(text))) [, field, subject] = match;
  else if ((match = OWNER_QUESTION.exec(text)) && owner && identity(owner) !== "the owner") {
    subject = owner;
    field = match[1];
  }
  if (!safeSubject(subject) || !field) return null;
  return { subject, field: FIELDS.get(field.toLowerCase()) };
}

function safeValue(field, value) {
  if (!value || value.length > 180 || /[\u0000-\u001f\u007f<>`\[\]{}\\]/.test(value)) return false;
  // A label containing prose or qualifications is not an exact scalar fact.
  // These shapes intentionally decline international/free-form variants that
  // need interpretation; the ordinary answer path still handles them.
  if (QUALIFIED_FACT.test(value)) return false;
  if (field === "email") return /^[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
  if (field === "phone" || field === "mobile") return /^\+?[0-9(][0-9 ()-]{6,28}$/.test(value) && value.replace(/\D/g, "").length >= 7;
  if (field.includes("address")) return /^\d{1,6}[A-Za-z]? [\p{L}\p{N} ,.'#()/-]{4,160}$/u.test(value);
  return /^[\p{L}\p{N}][\p{L}\p{N} &,'()./-]{1,119}$/u.test(value);
}

function factFromCard(text, requested) {
  // Retrieval can collapse line breaks when both modalities choose the same
  // chunk. Accept only a complete sequence of explicit card labels, never a
  // partial/composed excerpt or a label inferred from prose.
  if (/[\u2026]/.test(text)) return null;
  const labels = [...text.matchAll(new RegExp(`(?:^|\\s+)(name|contact|subject|entity|${FIELD_PATTERN}):[ \\t]*`, "gi"))];
  if (!labels.length || labels[0].index !== 0) return null;
  const fields = new Map();
  let subject = null;
  for (let index = 0; index < labels.length; index++) {
    const match = labels[index];
    const label = identity(match[1]);
    const start = match.index + match[0].length;
    const value = text.slice(start, labels[index + 1]?.index ?? text.length).trimEnd();
    if (["name", "contact", "subject", "entity"].includes(label)) {
      if (subject !== null || !safeSubject(value)) return null;
      subject = value;
      continue;
    }
    const field = FIELDS.get(label);
    if (!field || fields.has(field) || !safeValue(field, value)) return null;
    // Offsets address the original returned snippet, before prompt whitespace
    // normalization. The value bytes are never synthesized from the question.
    fields.set(field, { value, start, end: start + value.length });
  }
  if (identity(subject) !== identity(requested.subject)) return null;
  return fields.get(requested.field) || null;
}

function factFromOperative(text, doc, requested) {
  const section = doc.authority?.operative_section;
  if (!doc.authority?.owner_confirmed || !section || FIELDS.get(identity(section.name)) !== requested.field) return null;
  const subjects = [...text.matchAll(/^Subject:[ \t]*([^\r\n]+?)[ \t]*$/gm)];
  if (subjects.length !== 1 || identity(subjects[0][1]) !== identity(requested.subject)) return null;
  // Only a single complete section is eligible here. Multi-section/chunked
  // owner records retain the general path and its operative-value handling.
  const sections = [...text.matchAll(/^##[ \t]+([^\r\n]+)$/gm)];
  if (sections.length !== 1 || identity(sections[0][1]) !== identity(section.name)) return null;
  const values = [...text.matchAll(/^Operative value:[ \t]*([^\r\n]+?)[ \t]*$/gm)];
  if (values.length !== 1 || values[0][1] !== section.value || !safeValue(requested.field, section.value)) return null;
  const start = values[0].index + values[0][0].indexOf(section.value);
  return { value: section.value, start, end: start + section.value.length };
}

/**
 * Propose an exact, dated fact or return null. No new absence conclusion is
 * possible. `now` is injectable; the default is the request clock. Requiring
 * recent evidence is stricter than the general as-of path: thirty days mirrors
 * its stale-gap boundary, and cannot make an older record current by inference.
 */
export function entityFactAnswer({
  question, results, docs, owner = null, filters = {}, gaps = [], coverageGaps = [], degraded = null,
  operativeConflict = false, newerAuthoritativeEvidence = [], currentEvidence = [],
  now = Date.now(),
} = {}) {
  const requested = questionFact(question, owner);
  if (!requested || !Array.isArray(results) || !Array.isArray(docs) || !Number.isFinite(now)) return null;
  if (degraded || coverageGaps.length || operativeConflict || newerAuthoritativeEvidence.length || gaps.some((gap) =>
    /source_|coverage_unavailable|coverage_incomplete|filter_not_applied|unavailable|stale|operative_conflict|newer_/.test(gap.type || "")
  )) return null;

  // Scan the full retrieved window, including records outside the model's
  // twelve citations. A same-name record without a parseable card is still a
  // possible identity or conflicting-fact candidate, never silently ignored.
  const subject = identity(requested.subject);
  const related = results.map((row, index) => ({ row, index })).filter(({ row }) =>
    [row.client, row.title, row.snippet].some((value) => identity(value).includes(subject))
  );
  // Distinct records with an identical name do not prove identical identity.
  // Even agreeing values fall back until an explicit identity join exists.
  if (related.length !== 1) return null;
  const { row, index } = related[0];
  if (row.client && identity(row.client) !== subject) return null;
  if (QUALIFIED_FACT.test(row.title || "")) return null;
  const doc = docs[index];
  if (!doc || doc.n !== index + 1 || !doc.ref) return null;
  const text = row.snippet;
  if (typeof text !== "string" || !text.length || text.length > 1800 || text.replace(/\s+/g, " ").length > 900) return null;
  if (doc.text_source !== "native" || doc.text_reliable !== true ||
      doc.lineage?.status !== "known" || doc.lineage?.kind !== "source_record") return null;
  const time = reliableDocumentTime(doc);
  if (time === null || time > now || Math.floor((now - time) / 86400000) > 30) return null;
  const authority = authorityFor(doc, { query: question, current: true });
  if (!authority.eligible || doc.authority?.eligible === false) return null;

  const fact = doc.authority?.owner_confirmed
    ? factFromOperative(text, doc, requested)
    : factFromCard(text, requested);
  if (!fact || text.slice(fact.start, fact.end) !== fact.value) return null;
  // Reuse the same entity/date ordering as the general route. Implicit present
  // fact questions get an explicit current form solely for this evidence test.
  const newest = newestCurrentEvidence(`What is ${requested.subject}'s current ${requested.field}?`, docs, { filters, owner });
  if (!newest.some((candidate) => candidate.n === doc.n) ||
      (currentEvidence.length && !currentEvidence.some((candidate) => candidate.n === doc.n))) return null;
  const day = new Date(time).toISOString().slice(0, 10);
  // "records ... as of" describes exactly the evidence's time, even for a
  // primary source. It never asserts an unqualified current relationship.
  const answer = `As of ${day}, the record lists ${requested.subject}'s ${requested.field} as ${fact.value}. [${doc.n}]`;
  const section = doc.authority?.operative_section;
  if (section && (!answerUsesOperativeValue(answer, section) || answerUsesSupersededValue(answer, section))) return null;
  return {
    answer,
    evidence: [doc.n],
    fact_span: { n: doc.n, field: requested.field, start: fact.start, end: fact.end, as_of: day, basis: "result_snippet", offset_unit: "utf16" },
  };
}
