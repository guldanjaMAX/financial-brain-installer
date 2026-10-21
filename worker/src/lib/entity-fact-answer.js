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
  !unsafeScalarFact(value) && /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '&.,-]*$/u.test(value) &&
  !/\b(?:and|or|former|previous|old|not|unknown|my|our|the|their|this|that)\b/i.test(value);

function questionFact(question, owner) {
  const text = String(question || "").replace(/’/g, "'").trim();
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

// The digits of a cited value with every joining separator removed, read per
// raw code point: modifier letters, marks and default-ignorable code points
// are dropped (they join), every other non-letter is a separator (it joins),
// and a run of letters is kept as a splitting word unless it is one letter
// that is either not an ASCII letter in the cited value or directly between
// two digits. Only digit runs matter to the caller.
function codePointRunText(value) {
  const tokens = [];
  for (const char of value) {
    if (/\p{Lm}|\p{M}|\p{Default_Ignorable_Code_Point}/u.test(char)) continue;
    for (const piece of char.normalize('NFKC')) {
      if (/[0-9]/.test(piece)) tokens.push({ kind: 'digit', text: piece });
      else if (/\p{L}/u.test(piece) && !/\p{Lm}/u.test(piece)) tokens.push({ kind: 'letter', ascii: /^[A-Za-z]$/.test(char) });
      else if (!/\p{M}|\p{Lm}/u.test(piece)) tokens.push({ kind: 'separator' });
    }
  }
  let out = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'digit') { out += token.text; continue; }
    if (token.kind === 'separator') continue;
    let end = index;
    while (tokens[end + 1]?.kind === 'letter') end++;
    const lone = end === index;
    const touching = tokens[index - 1]?.kind === 'digit' && tokens[end + 1]?.kind === 'digit';
    if (!(lone && (!token.ascii || touching))) out += ' ';
    index = end;
  }
  return out;
}

function unsafeScalarFact(value, field) {
  // Allowlist every free-text value and rendered subject. Inspect, never
  // rewrite, cited bytes. Marks must attach to a letter, not a digit or a
  // separator. A raw numeral cannot escape as a letter through NFKC (e.g.
  // Roman numerals); declining these spellings only costs the fast path.
  // `field` is the value's field; a rendered subject passes none.
  const normalized = value.normalize('NFKC');
  if (!/^(?:\p{L}\p{M}*|[0-9 .,'&/#()\-])+$/u.test(normalized) ||
      [...value].some(char => /\p{N}/u.test(char) && !/^[0-9]$/.test(char))) return true;
  // A blank (default-ignorable) letter such as a Hangul filler can hide the
  // join between digit groups; refuse it outright, as the ledger parser does.
  if (/\p{Default_Ignorable_Code_Point}/u.test(value) || /\p{Default_Ignorable_Code_Point}/u.test(normalized)) return true;
  // Modifier letters (tatweel, modifier apostrophe) read as separators, so
  // they join adjacent digit groups exactly like ASCII punctuation does.
  // Partner answer 3: company, role and the rendered subject refuse a run of
  // five or more digits once separators are stripped. An address keeps the
  // six-digit rule, so a five-digit ZIP code still answers.
  // Round 4 (R4-LEAK-1, R4-LEAK-2): the run is also read code point by code
  // point from the cited value, so a modifier letter is judged BEFORE NFKC
  // turns it into a base letter, and a lone letter between digit groups joins
  // them when it is not an ASCII letter (U+01C0, U+A78F, ª and the like read as
  // punctuation) or when it touches a digit on both sides. A lone ASCII letter
  // set off by spaces ("1234 N 56th St") and every word of two or more letters
  // still split the run, so no list of look-alike letters is needed.
  const digitRun = field?.includes("address") ? /[0-9]{6}/ : /[0-9]{5}/;
  if (digitRun.test(normalized.replace(/[^\p{L}0-9]|\p{Lm}/gu, '')) || digitRun.test(codePointRunText(value))) return true;
  // NFKC precedes default casefold;
  // dotless i stays distinct, Cherokee folds to uppercase, and sharp s expands.
  const folded = [...normalized].map(char => char === '\u0131' ? char
    : /[\u13a0-\u13ff\uab70-\uabbf]/u.test(char) ? char.toUpperCase()
      : char.toUpperCase().toLowerCase().replace(/ß/g, 'ss')).join('');
  return /\b(?:account|acct|routing|card|iban|swift|aba)\b/.test(folded);
}

function safeValue(field, value) {
  if (!value || value.length > 180 || /[\u0000-\u001f\u007f<>`\[\]{}\\]/.test(value)) return false;
  // A label containing prose or qualifications is not an exact scalar fact.
  // These shapes intentionally decline international/free-form variants that
  // need interpretation; the ordinary answer path still handles them.
  if (QUALIFIED_FACT.test(value)) return false;
  if (field === "email") {
    // Partner answer 7: an identifier is not an email fact. Refuse 7 or more
    // digits in the local part or in any domain label, and the identifier
    // words with digits and dots as boundaries (beside the non-word ones).
    // Only letters continue a word, so an underscore is a boundary too
    // ("acct_123456@"; round 4, R4-LEAK-3).
    const email = /^([A-Za-z0-9.!#$%&'*+/=?^_{|}~-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/.exec(value);
    return Boolean(email) && [email[1], ...email[2].split(".")].every(part => part.replace(/[^0-9]/g, "").length < 7) &&
      !/(?<![a-z])(?:account|acct|routing|card|iban|swift|aba)(?![a-z])/i.test(value);
  }
  if (field === "phone" || field === "mobile") {
    // Partner answer 2: at most 15 digits in total (the E.164 maximum) across
    // every digit group. Anything longer leaves the fast path.
    const digits = value.replace(/\D/g, "").length;
    return /^\+?[0-9(][0-9 ()-]{6,28}$/.test(value) && digits >= 7 && digits <= 15;
  }
  // Every other scalar can carry an identifier, including company and role.
  // Keep phone/email validators above this guard and fall back to masking.
  if (unsafeScalarFact(value, field)) return false;
  if (field.includes("address")) return /^\d{1,6}[A-Za-z]? [\p{L}\p{N}\p{M} ,.'#()/-]{4,160}$/u.test(value);
  return /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &,'()./-]{1,119}$/u.test(value);
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

// These statements establish what the owner reported, not whether a recipient
// updated a system. Keep the question grammar separate from completion requests
// so neither a request nor a postal receipt can become proof of residence.
function addressMailOffset(row) {
  // Native ingest prefixes each chunk with its exact stored title. Do not
  // remove arbitrary bracketed prose or change offsets into the cited snippet.
  const prefix = `[${row.title}] `;
  return row.snippet.startsWith(prefix) ? prefix.length : 0;
}

function addressMailSender(row, doc, statementAt) {
  if (!/^(?:gmail|imap|email)$/.test(doc?.source_kind || '') || doc.date_source !== 'email_header') return null;
  const prefix = row.snippet.slice(addressMailOffset(row), statementAt).replace(/\s+/g, ' ').trim();
  const envelope = /^From: ([^<>]+?) <[^<>\s]+@[^<>\s]+> To: [^<>\s]+@[^<>\s]+(?:, [^<>\s]+@[^<>\s]+)* Date: (.+?) Subject: (.+)$/.exec(prefix);
  if (!envelope || envelope[3] !== row.title || Date.parse(envelope[2]) !== reliableDocumentTime(doc)) return null;
  return envelope[1];
}

function ownerAddressStatement({ question, owner, results, docs, now }) {
  question = String(question || '').replace(/’/g, "'").trim();
  const addressQuestion = /^what(?: is|'s) my (?:current )?(?:home |mailing )?address\??$/i.test(question);
  const completionQuestion = /^has my (?:home |mailing )?address been updated(?: in (?:the )?[a-z ]{1,60} system)?\??$/i.test(question);
  if ((!addressQuestion && !completionQuestion) || !safeSubject(owner) || identity(owner) === 'the owner') return null;
  if (docs.some(doc => doc.authority?.operative_section)) return null;
  const candidates = [];
  for (let index = 0; index < results.length; index++) {
    const row = results[index], doc = docs[index], text = row.snippet;
    if (!doc || doc.n !== index + 1 || !doc.ref || typeof text !== 'string' || QUALIFIED_FACT.test(row.title || '') ||
        text.length > 900 || /[\u2026<>]/.test(text.replace(/<[^<>\s]+@[^<>\s]+>/g, '')) ||
        !/^(?:gmail|imap|email)$/.test(doc.source_kind || '') ||
        doc.text_source !== 'native' || doc.text_reliable !== true ||
        doc.lineage?.status !== 'known' || doc.lineage?.kind !== 'source_record' ||
        doc.authority?.eligible === false || doc.authority?.tier === 'T4') continue;
    // Bind first-person words to the rendered sender header, never to a name
    // borrowed from the question, a recipient, or quoted correspondence.
    const from = /^From:\s*([^<>\r\n]+?)\s*<[^<>\s]+@[^<>\s]+>\s/i.exec(text.slice(addressMailOffset(row)));
    if (!from || identity(from[1]) !== identity(owner) ||
        (text.match(/\bFrom:/gi) || []).length !== 1 ||
        /\b(?:forwarded|wrote|quoted|hypothetical|business|office|not|never|if|unless|until|temporary|plan|intend)\b|["“”]/i.test(text)) continue;
    const time = reliableDocumentTime(doc);
    if (time === null || time > now || doc.date_source !== 'email_header') continue;
    const movedRequest = /\b(Please update my (?:home |mailing )?address to) ([^\r\n]+?)\. I have moved there\.\s*$/i.exec(text);
    const statement = movedRequest || /\b(I have moved to|My (?:home |mailing )?address is|Please update my (?:home |mailing )?address to) ([^\r\n]+?)\.?\s*$/i.exec(text);
    if (!statement) continue;
    if (identity(addressMailSender(row, doc, statement.index)) !== identity(owner)) continue;
    const request = !movedRequest && /^Please/i.test(statement[1]);
    if (completionQuestion !== request || !safeValue('address', statement[2])) continue;
    if ((/home address/i.test(question) && /mailing address/i.test(statement[1])) ||
        (/mailing address/i.test(question) && /home address/i.test(statement[1]))) continue;
    const start = statement.index + statement[1].length + 1;
    candidates.push({ doc, value: statement[2], start, end: start + statement[2].length, time, request });
  }
  candidates.sort((a, b) => b.time - a.time);
  const chosen = candidates[0];
  if (!chosen) return null;
  const confirmations = [];
  // A different or unparseable newer owner record requires ordinary conflict
  // review. Agreement from a recipient is context, never independent proof of
  // completion. Undated and future contradictions cannot be ordered away.
  for (let index = 0; index < results.length; index++) {
    const row = results[index], doc = docs[index];
    if (doc?.n === chosen.doc.n) continue;
    const text = `${row.title || ''} ${row.snippet || ''}`;
    if (!identity(text).includes(identity(owner)) || !/\b(?:address|moved to)\b/i.test(text)) continue;
    const time = doc ? reliableDocumentTime(doc) : null;
    if (time !== null && time < chosen.time) continue;
    if (candidates.some(candidate => candidate.doc.n === doc?.n && candidate.value === chosen.value)) continue;
    const confirmation = /\bChange of address confirmed for ([^:]+): ([^\r\n]+?)\.?\s*$/i.exec(row.snippet || '');
    // A dated event receipt can qualify the request without repeating the
    // address. Bind its subject to the owner and its effective day to the
    // chosen report. This is context only, never proof of system completion.
    const event = /\bYour change-of-address request is confirmed, effective (\d{4}-\d{2}-\d{2})\.\s*$/.exec(row.snippet || '');
    const eventMatches = event && identity(row.title) === identity(`Address change for ${owner}`) &&
      event[1] === new Date(chosen.time).toISOString().slice(0, 10);
    const agreeing = confirmation && identity(confirmation[1]) === identity(owner) && confirmation[2] === chosen.value;
    const receipt = agreeing ? confirmation : eventMatches ? event : null;
    if (!chosen.request && receipt && addressMailSender(row, doc, receipt.index) &&
        time !== null && time <= now &&
        doc.ref && doc.text_source === 'native' && doc.text_reliable === true &&
        doc.lineage?.kind === 'source_record' && doc.lineage?.status === 'known' &&
        doc.authority?.eligible !== false &&
        !/\b(?:not|never|if|unless|quoted|forwarded|wrote)\b|["“”>]/i.test((row.snippet || '').replace(/<[^<>\s]+@[^<>\s]+>/g, ''))) {
      confirmations.push({ doc, time, event: !agreeing });
      continue;
    }
    return null;
  }
  const day = new Date(chosen.time).toISOString().slice(0, 10);
  const n = chosen.doc.n;
  let answer = chosen.request
    ? `Your ${day} email requests an address update to ${chosen.value}. [${n}] That message does not establish completion of the system update. [${n}]`
    : `The most recent retrieved owner email reporting an address lists ${chosen.value}, as of ${day} [${n}]`;
  const evidence = [n];
  for (const confirmation of confirmations) {
    answer += `; the ${new Date(confirmation.time).toISOString().slice(0, 10)} email records an address-change confirmation ${confirmation.event ? `effective ${day}` : 'for the same address'} [${confirmation.doc.n}]`;
    evidence.push(confirmation.doc.n);
  }
  if (!chosen.request) answer += '.';
  if (confirmations.some(confirmation => confirmation.event))
    answer += ` This does not establish completion of a recipient system update. [${n}]`;
  return { answer, evidence, method: 'dated_owner_address',
    fact_span: { n, field: 'address', start: chosen.start, end: chosen.end, as_of: day,
      basis: 'result_snippet', offset_unit: 'utf16' } };
}

/**
 * Propose an exact, dated fact or return null. No new absence conclusion is
 * possible. `now` is injectable; the default is the request clock. Contact
 * cards retain the thirty-day stale boundary. An explicit owner email may
 * report older dated history while preserving the route's freshness gaps;
 * neither path makes an old record current by inference.
 */
export function entityFactAnswer({
  question, results, docs, owner = null, filters = {}, gaps = [], coverageGaps = [], degraded = null,
  operativeConflict = false, newerAuthoritativeEvidence = [], currentEvidence = [],
  now = Date.now(),
} = {}) {
  if (Array.isArray(results) && Array.isArray(docs) && Number.isFinite(now) &&
      !degraded && !coverageGaps.length && !operativeConflict && !newerAuthoritativeEvidence.length &&
      !gaps.some(gap => /source_|coverage_|filter_not_applied|unavailable|operative_conflict|newer_/.test(gap.type || ''))) {
    const statement = ownerAddressStatement({ question, owner, results, docs, now });
    if (statement) return statement;
  }
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
