import { hasSensitiveTransportIdentity, scanEnvelope } from './secret-scan.js';
import { taxEvidenceScope } from './tax-evidence-scope.js';

export const SENSITIVE_DOCUMENTS_WITHHELD = Object.freeze({
  type: 'sensitive_documents_withheld',
  detail: 'Some retrieved material was withheld because it contains credentials or unsolicited sensitive records. This is not evidence that no matching record exists.',
});
export const SENSITIVE_DOCUMENTS_NOTICE = 'Retrieved material was withheld by the sensitive-record check. The permitted evidence does not support an answer. This does not establish that no matching record exists.';

const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_]+/g, ' ').trim();
const recordType = /\b(?:tax[\s_-]+returns?|credit[\s_-]+reports?|consumer[\s_-]+reports?|passport|driver['’]?s?[\s_-]+licen[cs]e|identity[\s_-]+(?:card|document)|national[\s_-]+id|social[\s_-]+security[\s_-]+card|birth[\s_-]+certificate)\b/i;
const taxForm = /\b(?:form[\s_-]+(?:1040|1065|1120|1099|941|940)\b|(?:schedule[\s_-]+)?k[\s_-]?1\b|w[\s_-]?2\b)/i;
const identityField = /\b(?:(?:ssn|social[\s_-]+security(?:[\s_-]+(?:number|no))?|taxpayer[\s_-]+(?:id|identification)(?:[\s_-]+number)?)\s*[:#=]?\s*(?:\d{3}[ -]?\d{2}[ -]?\d{4}|[x*]{3}[ -]?[x*]{2}[ -]?\d{4})|(?:passport|driver['’]?s?[\s_-]+licen[cs]e|national[\s_-]+id)\s*(?:number|no\.?|#)\s*[:#=]?\s*[a-z0-9][a-z0-9 -]{4,}|(?:date[\s_-]+of[\s_-]+birth|dob)\s*[:=]\s*\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\b/i;
const identityKey = /^(?:ssn|social[\s_-]+security(?:[\s_-]+number)?|passport[\s_-]+(?:number|no)|driver['’]?s?[\s_-]+licen[cs]e[\s_-]+(?:number|no)|national[\s_-]+id|taxpayer[\s_-]+(?:id|identification)[\s_-]+number|date[\s_-]+of[\s_-]+birth|dob)$/i;

function stringsIn(value, seen = new Set()) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item, seen)]);
}

function hasIdentityField(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) =>
    (identityKey.test(key) && item !== null && item !== undefined && item !== '') || hasIdentityField(item, seen));
}

const subjectWords = value => normalized(value).replace(/['’]s\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const referenceWords = new Set(['my', 'our', 'the', 'its', 'for', 'of', 'in']);

const formReference = /\b(?:form \d{3,4}(?:-[a-z0-9]+)?|(?:(?:form|schedule) )?[a-z][ -]?\d)\b/gi;
const yearWord = /^(?:19|20)\d{2}$/;
const recordWords = value => subjectWords(value).filter(word => !referenceWords.has(word));

function sameRecordSubject(row, reference) {
  const requested = recordWords(reference);
  const title = recordWords(row.title);
  if (!requested.length || requested.filter(word => yearWord.test(word)).some(word => !title.includes(word))) return false;
  // Match a complete ordered subject, not an arbitrary subset of title words.
  // A form label can annotate a described statement without becoming part of
  // that statement's name; requested labels themselves must still match.
  const withoutYears = words => words.filter(word => !yearWord.test(word)).join(' ');
  const subject = withoutYears(requested);
  const containsSubject = words => subject && ` ${withoutYears(words)} `.includes(` ${subject} `);
  if (containsSubject(title)) return true;
  return !new RegExp(formReference).test(normalized(reference)) &&
    containsSubject(recordWords(normalized(row.title).replace(formReference, ' ')));
}

function isRecordReference(row, reference) {
  const object = normalized(reference).replace(/\s+(?:for|in|of)\s+(?:19|20)\d{2}$/, '');
  const kind = recordType.exec(object);
  const titleKinds = [...normalized(row.title).matchAll(new RegExp(recordType, 'gi'))];
  // When the title names a sensitive kind, the request must name that whole
  // kind too. "card" and even "security card" cannot identify an identity
  // card merely because those words occur in its title.
  if (titleKinds.some(titleKind => !kind || subjectWords(kind[0]).join(' ') !== subjectWords(titleKind[0]).join(' '))) return false;
  const namedKind = kind && kind.index + kind[0].length === object.length;
  const formIdentifier = /\b(?:form \d{3,4}(?:-[a-z0-9]+)?|(?:schedule )?[a-z][ -]?\d|(?:19|20)\d{2} \d{3,4}(?:-[a-z0-9]+)?)$/;
  // An otherwise untyped record needs its subject and record head. A bare
  // container noun supplies neither a sensitive kind nor a particular record.
  const recordNoun = /\b(?:returns?|statements?|reports?|documents?|records?|files?|certificates?|cards?)$/;
  const describedRecord = !titleKinds.length && recordNoun.test(object) &&
    recordWords(object).filter(word => !yearWord.test(word)).length > 1;
  return Boolean(namedKind || formIdentifier.test(object) || describedRecord);
}

function requestedRecord(question) {
  const text = normalized(question).replace(/[.!?]+$/, '').trim();
  const direct = /^(?:please )?(?:(?:show(?: me)?|open|read) (?:my|our|the) (.+)|what (?:does|did) (.+?) (?:say|show|report|list|state|record))$/.exec(text);
  if (direct) return { reference: direct[1] ?? direct[2].replace(/^(?:my|our|the|its) /, ''), direct: true };
  const contents = /^(?:what|which|how much)(?: .+?)? (?:is|are|was|were)(?: (?:shown|reported|listed|stated|recorded))? (?:on|in|from|according to) (.+)$/.exec(text);
  return contents ? { reference: contents[1], direct: false } : null;
}

function explicitlyRequested(row, question, taxQuestion, options) {
  // Sensitive screening is on for every candidate. Unknown intent stays
  // withheld; neither a money cue nor word overlap activates an exception.
  if (taxQuestion?.applicable) {
    if (taxQuestion.resolved !== true) return false;
    // Native-header authority stays authoritative for strict callers. Only
    // the resolved production answer guard may receive related tax evidence.
    const scope = row.authority?.tax_scope ?? taxEvidenceScope(row, question, options);
    if (scope?.matched === true) return true;
    if (!options.deferTaxScope) return false;
    return taxForm.test(normalized(row.title)) || /\btax[\s_-]+returns?\b/i.test(row.title || '');
  }
  const quoted = /^(?:please\s+)?(?:show(?:\s+me)?|open|read)\s+(?:the\s+)?(?:document|record|file)\s+(?:titled|named|called)\s+["“]([^"”]+)["”][.!?]*$/i.exec(question.trim());
  if (quoted) return normalized(row.title) === normalized(quoted[1]);
  const request = requestedRecord(question);
  if (!request) return false;
  const { reference, direct } = request;
  // Exact direct identification is independent of a title's incidental suffix.
  // Tax authority above and credential screening below remain unconditional.
  if (direct && normalized(row.title) === normalized(reference)) return true;
  return isRecordReference(row, reference) && sameRecordSubject(row, reference);
}

/** Request-aware export policy, independent of ledger admission. Old rows can
 * predate ingest screening. Inspect the complete retrieved row before prompt
 * truncation, and return counts/enums only for rejected material.
 * deferTaxScope requires the caller's resolved entity/year/form answer guard;
 * it changes solicitation only, never credential screening or answer authority.
 */
export function filterThinkCandidates(candidates, { question = '', taxQuestion = null, ...options } = {}) {
  const rows = [];
  const reasons = new Set();
  let count = 0;
  for (const row of candidates) {
    // Wrapping includes legacy identifiers too; scanEnvelope normally excludes
    // top-level transport IDs for ingest, where a separate guard owns them.
    const credential = scanEnvelope({ candidate: row });
    const capability = hasSensitiveTransportIdentity({ source_id: row });
    const requested = explicitlyRequested(row, question, taxQuestion, options);
    const sensitive = hasIdentityField(row) || stringsIn(row).some(value => {
      const text = normalized(value);
      return recordType.test(text) || taxForm.test(text) || identityField.test(text);
    });
    const reason = credential.shouldFlag || capability
      ? 'credential'
      : sensitive && !requested ? 'unsolicited_sensitive_record' : null;
    if (reason) { count++; reasons.add(reason); }
    else rows.push(row);
  }
  return { rows, withheld: count ? {
    count, examined_count: candidates.length, reasons: [...reasons].sort(),
  } : undefined };
}
