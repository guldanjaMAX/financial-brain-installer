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
const filingHeader = /^(?:\[[^\]]+\]\s*)?(?:(?:department of the treasury|internal revenue service)[\s.,:;-]*)*(?:(?:19|20)\d{2}\s+)?(?:form[ -]+(?:1040|1065|1120|1099|941|940)\b|(?:schedule[ -]+)?k[ -]?1\b|w[ -]?2\b)/i;
// A filing header can follow any preamble: an OCR or transport warning, a
// page marker, a bracketed upload tag, a cover line or agency text. Read the
// opening lines and sentences before normalization flattens them, and treat
// any opening segment that begins with a form identifier as a header. An
// incidental mention inside a sentence never begins a segment.
const FILING_HEADER_SEGMENTS = 12;
const filingSegment = /^(?:\[\[?[^\]]*\]\]?\s*)*(?:(?:department of the treasury|internal revenue service)[\s.,:;-]*)*(?:(?:19|20)\d{2}\s+)?(?:form[ -]+(?:1040|1065|1120|1099|941|940)\b|(?:form[ -]+|schedule[ -]+)?k[ -]?1\b|(?:form[ -]+)?w[ -]?2\b)/i;
function hasFilingHeader(value) {
  const raw = String(value || '').normalize('NFKC');
  if (filingHeader.test(normalized(raw))) return true;
  return raw.split(/\r?\n|(?<=[.!?;])\s+/).map(normalized).filter(Boolean)
    .slice(0, FILING_HEADER_SEGMENTS).some(segment => filingSegment.test(segment));
}

// One heading grammar for sensitive kinds in record text, read on every line
// and sentence, with case kept because case is the grammar.
// A form identifier (any numbered form, W-2, K-1) is a heading when every
// word before it in its line or sentence is form preamble (agency names, OMB
// numbers, copy labels, years, page and box marks: a closed list) and the
// word after it is not lowercase prose ("Form 1040 is mentioned"). Dashes,
// OMB lines and layouts cannot hide it; "Re: Form 1099-NEC Request" and "the
// advisor may request Form 1040" are mentions.
// A sensitive record type (passport, credit report, tax return, licence,
// identity card) is a heading only when it ends its line or sentence, or is
// followed only by a date or number, with no prose before it. "Bring your
// passport", "tax returns costs" and "Tax Return Preparation Engagement
// Letter" are mentions; "CONSUMER CREDIT REPORT" and "Passport" are headings.
const FORM_IN_TEXT = /\b(?:form[\s_-]+(?:\d{3,5}|w[\s_-]?2)(?:\s?-\s?[a-z0-9]{1,4}\b)?|(?:schedule[\s_-]+)?k[\s_-]?1\b|w[\s_-]?2\b)/gi;
const RECORD_TYPE_IN_TEXT = /\b(?:tax[\s_-]+returns?|credit[\s_-]+reports?|consumer[\s_-]+reports?|passports?|driver['’]?s?[\s_-]+licen[cs]es?|identity[\s_-]+(?:cards?|documents?)|national[\s_-]+ids?|social[\s_-]+security[\s_-]+cards?|birth[\s_-]+certificates?)\b/gi;
const FORM_PREAMBLE = new Set(('department of the treasury internal revenue service irs omb no copy for employee employer recipient payer ' +
  'records record state federal page void corrected and to be filed with tax return calendar year attach this form schedule us u s ' +
  'partner partnership shareholder beneficiary final amended').split(' '));
const wordsOf = value => value.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) || [];
const HEADING_FUNCTION_WORDS = new Set(['of', 'the', 'and', 'for', 'no', 'a', 'an', 'de', 'del', 'y']);
const proseWord = word => /^\p{Ll}/u.test(word) && !HEADING_FUNCTION_WORDS.has(word);
const preambleWord = word => /\d/.test(word) || word.length === 1 || FORM_PREAMBLE.has(word.toLowerCase().replace(/['’]s$/, ''));
function headingKind(value) {
  const raw = String(value || '').normalize('NFKC');
  return raw.split(/\r?\n|(?<=[.!?;])\s+/).some(segment => {
    const form = [...segment.matchAll(FORM_IN_TEXT)].some(match => {
      if (!wordsOf(segment.slice(0, match.index)).every(preambleWord)) return false;
      const after = wordsOf(segment.slice(match.index + match[0].length));
      if (!after.length) return true;
      // "Form 941 for 2025": a function word followed by a year is a heading.
      if (/^(?:for|of)$/.test(after[0])) return /^(?:19|20)\d{2}$/.test(after[1] || '');
      return !/^\p{Ll}/u.test(after[0]);
    });
    return form || [...segment.matchAll(RECORD_TYPE_IN_TEXT)].some(match => {
      if (wordsOf(segment.slice(0, match.index)).some(proseWord)) return false;
      const after = wordsOf(segment.slice(match.index + match[0].length));
      return after.length === 0 || /\d/.test(after[0]) || segment === segment.toUpperCase();
    });
  });
}
// Body text fields are read by the heading grammar; every other string on a
// row (title, file name, metadata) is a label that names what the record is.
const BODY_FIELDS = new Set(['snippet', 'text', 'content', 'body', 'excerpt', 'highlight', 'chunk_text']);
const labelsOf = row => row && typeof row === 'object' ? Object.fromEntries(Object.entries(row).filter(([key]) => !BODY_FIELDS.has(key))) : row;
const bodiesOf = row => row && typeof row === 'object' ? Object.entries(row).filter(([key, value]) => BODY_FIELDS.has(key) && typeof value === 'string').map(([, value]) => value) : [];
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

const canonicalForm = value => normalized(value).replace(/\b(?:form|schedule)\b/g,'').replace(/[^a-z0-9]/g,'');
// A form the owner names: the known filings, or any numbered form, since the
// heading grammar screens every numbered form heading.
const namedForm = /\b(?:form[\s_-]+\d{3,5}\b|(?:schedule[\s_-]+)?k[\s_-]?1\b|w[\s_-]?2\b)/i;

function namedFormRequest(row, question) {
  const otherKind=recordType.exec(normalized(row.title));
  if (otherKind && !/^tax[ -]+returns?$/i.test(otherKind[0])) return false;
  const direct = /^(?:please )?(?:what(?:'s| is) (?:on|in)|what does|show(?: me)?|open|read)\s+(?:(?:my|our|the)\s+)?(.+)$/i.exec(normalized(question).replace(/[.!?]+$/,''));
  if (!direct) return false;
  const reference=direct[1].replace(/\s+(?:say|show|report)$/i,'');
  const form=namedForm.exec(reference);
  if (!form || reference.slice(0,form.index).replace(/\b(?:19|20)\d{2}\b/g,'').trim()) return false;
  const recordText=normalized(`${row.title || ''} ${row.snippet || row.text || ''}`);
  const recordForm=namedForm.exec(recordText);
  if (!recordForm || canonicalForm(form[0])!==canonicalForm(recordForm[0])) return false;
  const tail=reference.slice(form.index+form[0].length).trim();
  if (!tail || /^(?:for )?(?:19|20)\d{2}$/.test(tail)) return true;
  // A form suffix the owner names (1099-INT) must be the record's own.
  if (/^-\s?[a-z0-9]{1,4}$/.test(tail)) return canonicalForm(recordText).includes(canonicalForm(form[0]+tail));
  const party=/^(?:from|of)\s+(.+)$/.exec(tail);
  return Boolean(party && normalized(`${row.title || ''} ${row.snippet || row.text || ''}`).includes(normalized(party[1])));
}

function explicitlyRequested(row, question, taxQuestion, options) {
  const quoted = /^(?:please\s+)?(?:show(?:\s+me)?|open|read)\s+(?:the\s+)?(?:document|record|file)\s+(?:titled|named|called)\s+["“]([^"”]+)["”][.!?]*$/i.exec(question.trim());
  if (quoted) return normalized(row.title) === normalized(quoted[1]);
  // Sensitive screening is on for every candidate. Unknown intent stays
  // withheld; neither a money cue nor word overlap activates an exception.
  if (namedFormRequest(row,question)) return true;
  if (taxQuestion?.applicable) {
    const otherKind=recordType.exec(normalized(row.title));
    if (otherKind && !/^tax[ -]+returns?$/i.test(otherKind[0])) return false;
    if (taxQuestion.resolved !== true) {
      // A form named by the owner is a solicited record read. Unknown entity
      // or year lowers answer confidence; it never turns this into your filing.
      const form = namedForm.exec(question);
      const recordForm=namedForm.exec(normalized(`${row.title || ''} ${row.snippet || row.text || ''}`));
      if (form && recordForm && canonicalForm(form[0])===canonicalForm(recordForm[0])) return true;
      return false;
    }
    // Native-header authority stays authoritative for strict callers. Only
    // the resolved production answer guard may receive related tax evidence.
    const scope = row.authority?.tax_scope ?? taxEvidenceScope(row, question, options);
    if (scope?.matched === true) return true;
    if (!options.deferTaxScope) return false;
    return scope?.form_matched === true;
  }
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
    // A label naming a sensitive kind, an identity number anywhere, or a
    // sensitive heading in the body is a sensitive record. A passing mention
    // inside body prose is not: "bring your passport" stays readable.
    const sensitive = hasIdentityField(row) || taxForm.test(normalized(row.title)) || hasFilingHeader(row.snippet || row.text) ||
      stringsIn(labelsOf(row)).some(value => {
        const text = normalized(value);
        return recordType.test(text) || identityField.test(text);
      }) || bodiesOf(row).some(value => identityField.test(normalized(value)) || headingKind(value));
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
