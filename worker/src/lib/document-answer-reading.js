import { answerSentences } from './answer-sentences.js';
import { computeAnswerConfidence, ownerConfidence, ownerConfidenceLine } from './confidence.js';
import { quickBooksLabel } from './quickbooks-label.js';
import { documentFigureProvenance } from './document-answer-provenance.js';
import { recordObservation } from './query-intent.js';

const text = value => String(value || '').replace(/\s+/g, ' ').trim();
const dateLabel = doc => {
  const observed=recordObservation(doc);
  const calendar=/^calendar:(?:event_start|all_day_start)$/.test(doc.date_source || '');
  return (observed.ts ? `${String(observed.ts).slice(0, 10)}${observed.date_reliable ? '' : ' (date unverified)'}` : 'date unverified') + (doc.question_time ? `; ${calendar ? 'event ' : ''}${doc.question_time}` : '');
};
const citationNumbers = value => [...String(value).matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
const refusal = /\b(?:I (?:cannot|can't|must decline|am unable)|(?:documents|sources) (?:do not|don't|cannot|can't) (?:answer|provide|contain)|not (?:covered by|in) the documents|no (?:direct|supporting) evidence)\b/i;
// Acceptance screens explanation text with the same refusal detector as the
// finalizer, so its smoke-test exception cannot drift to an older sentence.
export const documentAnswerHasRefusal = value => refusal.test(String(value || ''));
const small = Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((v,i)=>[v,i]));
const tens = {twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
function figures(value) {
  const raw = String(value).replace(/\[\d+\]/g,'');
  const numeric = [...raw.matchAll(/(?:[$€£]\s*)?\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?%?/gu)].map(m=>m[0].replace(/[\s,]/g,''));
  const words = new RegExp(`\\b(?:${[...Object.keys(small),...Object.keys(tens),'hundred','thousand','million','billion','dozen','half','double','twice','triple','quarter','third'].join('|')})(?:[ -]+(?:${[...Object.keys(small),...Object.keys(tens),'hundred','thousand','million','billion','dozen','half','double','twice','triple','quarter','third','and'].join('|')}))*\\b`,'gi');
  for (const match of raw.matchAll(words)) {
    let total=0,part=0;
    for(const word of match[0].toLowerCase().split(/[ -]+/)) {
      if(word==='hundred')part=(part || 1)*100;
      else if(word==='thousand' || word==='million'){total+=(part || 1)*(word==='thousand'?1000:1000000);part=0;}
      else part+=small[word] ?? tens[word] ?? 0;
    }
    numeric.push(String(total+part));
  }
  return numeric;
}
const stop = new Set('what which when where who how does did is are was were the a an to of in on for from my our me we do it this that say says said about with have has much'.split(' '));
const terms = value => [...new Set(text(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter(t => t.length > 2 && !stop.has(t));
const sourceText = doc => text([doc.snippet || doc.text, ...(doc.retrieval_excerpts || [])].filter(Boolean).join('\n\n'));
// These contexts need interpretation, even if a checker approves a substring.
// Quote the record with its qualifiers instead of asserting the embedded claim.
const unresolvedContext = value => /\b(?:not|no|never|cannot|can['’]t|isn['’]t|wasn['’]t|doesn['’]t|don['’]t|false|untrue|incorrect|wrong|inaccurate|invalid|reject(?:ed|ion)?|refuted|disproved|denied|disputed|unless|if|conditional|hypothetical|superseded|withdrawn|obsolete|erroneous)\b/i.test(value);
function hasClaimContext(doc) {
  // Known OCR transport warnings describe extraction, not the proposition.
  // They already force the partial-reading cap. All record prose, including
  // distant rejected-claim headings, must retain its qualification.
  const body = sourceText(doc).replace('[OCR] The text below was read from a scanned image by a machine, not from a text layer in the file. It can be wrong, and figures especially can be wrong.','')
    .replace(/\[\[page \d+: could not be read[^\]]*\]\]/g,'');
  return unresolvedContext(body);
}

// ---- High-figure grounding: full consumption, not a word list ----
// A figure reaches High only when every cited record is consumed by the
// claim: each of its sentences and lines is an exact, case-sensitive claim
// clause (250 mW is not 250 MW, mL is not ML) or a heading made of the
// record's own title words, and the title itself is plain. Every other
// sentence, in any language and in any position, is unchecked context: the
// record is quoted with it and the answer stays below High. No list of doubt
// words decides this; the lexicon below only labels reasons and long quotes.
// Uncited records that are not provably older, or that name the claim's
// field or a cited record, are shown beside the answer and also cap it.
const OCR_WARNING = '[OCR] The text below was read from a scanned image by a machine, not from a text layer in the file. It can be wrong, and figures especially can be wrong.';
const withoutTransport = value => String(value || '').split(OCR_WARNING).join(' ').replace(/\[\[page \d+: could not be read[^\]]*\]\]/g, ' ');
const withoutCitations = value => String(value || '').replace(/\s*\[\d+\]/g, '');
const NUMBER_WORDS = new Set([...Object.keys(small), ...Object.keys(tens), 'hundred', 'thousand', 'million', 'billion']);
const SUBJECT_STOP = new Set([...stop, ...'and but nor not its his her their they them then than also any all can may will shall should would could been being per via into onto upon under over after before each every other such same there here which whose whom whether while within without between among also only very more most less least some than that these those this into out off was were has had have the for are its our your yours'.split(' ')]);
const DOUBT = /\b(?:not|no|never|none|nor|neither|cannot|can['’]t|isn['’]t|wasn['’]t|aren['’]t|weren['’]t|doesn['’]t|don['’]t|didn['’]t|won['’]t|false|untrue|incorrect|wrong|inaccurate|invalid|void|reject\w*|refut\w*|disprov\w*|den(?:y|ied|ies)|disput\w*|contest\w*|retract\w*|withdr[ae]w\w*|supersed\w*|replac\w*|correct(?:ed|ion|ions|s)|revis\w*|amend\w*|updat\w*|chang\w*|obsolete|outdated|erroneous|errors?|mistak\w*|fiction\w*|fictitious|fake|fabricat\w*|invent\w*|made up|satir\w*|parod\w*|jok(?:e|es|ing)|hypothetical|conditional|unless|if|whether|assum\w*|estimat\w*|approximat\w*|draft|proposed|pending|tentative|unconfirmed|unverified|alleg\w*|suppos\w*|purport\w*|doubt\w*|question\w*|uncertain|unclear|ignor\w*|disregard\w*|discard\w*|cancel\w*|rescind\w*|revok\w*|annul\w*|expir\w*|former|previous\w*|prior|earlier|longer|instead|rather|but|however|although|though|except|until)\b/iu;
const CLAIM_NOUN = '(?:claims?|figures?|numbers?|values?|amounts?|statements?|assertions?|entr(?:y|ies)|readings?|estimates?|data|information|lines?|sentences?|clauses?|items?|results?|facts?|quotes?|quotations?|totals?|specifications?|specs?|documents?|records?|pages?|sections?|paragraphs?|texts?|contents?|notes?|memos?|reports?|versions?|cop(?:y|ies))';
const CLAIM_REFERENCE = new RegExp(String.raw`\b(?:above|below|foregoing|preceding|following|aforementioned|aforesaid|herein|hereof|hereto|thereof|therein|thereto|hereby|everything|anything|nothing|everyone|nobody|ditto|ibid)\b|\b(?:the|this|that|these|those|such|said|each|every|any|all|no|both|either|neither|other|another)\s+(?:[\p{L}\p{N}-]+\s+){0,2}?${CLAIM_NOUN}\b`, 'iu');
const words = value => text(withoutCitations(value)).match(/[\p{L}\p{N}]+(?:['’.\/-][\p{L}\p{N}]+)*/gu) || [];
// The exact claim: whitespace collapsed, a trailing full stop dropped, case
// and every other character kept.
const exactClause = value => text(value).replace(/[.\s]+$/, '');
// Citations are accepted only at the end of a sentence ("units [1][2]." or
// "units. [1]"). A marker anywhere else could split a figure: 250[1]0.
function claimBody(sentence) {
  const s = text(sentence);
  const body = s.replace(/([.!?])\s*(?:\[\d+\]\s*)+$/, '$1').replace(/(?:\s*\[\d+\])+\s*([.!?]*)\s*$/, '$1');
  return { body, interiorCitation: /\[\d+\]/.test(body) };
}
// Light stemming so pumps, pump's and per-pump all name the field "pump".
function stem(word) {
  const w = word.toLowerCase().replace(/['’]s$/, '').replace(/['’]$/, '');
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}
const tokens = value => text(withoutCitations(value)).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
const contentStem = word => !/\d/.test(word) && word.length > 2 && !SUBJECT_STOP.has(word.toLowerCase()) && !NUMBER_WORDS.has(word.toLowerCase()) && !/^(?:usd|eur|gbp|cad|aud)$/i.test(word);
const allTerms = value => new Set(tokens(value).filter(contentStem).map(stem));
// The claim's field: content words, without the units and currency beside
// its figures.
function fieldTerms(value) {
  const list = tokens(value);
  const units = new Set();
  list.forEach((word, i) => { if (/\d/.test(word) || NUMBER_WORDS.has(word.toLowerCase())) { units.add(i-1); units.add(i+1); } });
  return [...new Set(list.filter((word, i) => !units.has(i) && contentStem(word)).map(stem))];
}
// The clause with every figure and its unit masked, case-folded: equal
// skeletons with different exact clauses mean the draft changed a figure,
// a unit or a case. Used only to name the reason.
function skeleton(value) {
  const list = words(value).map(word => word.toLowerCase());
  return list.map((word, i) => /\d/.test(word) || NUMBER_WORDS.has(word) || /\d/.test(list[i-1] ?? '') || NUMBER_WORDS.has(list[i-1] ?? '') ? '#' : word).join(' ');
}
// A title is plain when each of its words is a figure or date, a word the
// claim states, a question subject also present in the body, or a neutral
// record-kind word. Question wording alone cannot validate title authority.
// Anything else (WITHDRAWN, Superseded, Draft, Example, Brochure, an unknown
// word) is unchecked and keeps the title beside the quote.
const PLAIN_TITLE_WORDS = new Set(('agreement contract invoice bill receipt statement specification spec datasheet sheet memo memorandum letter ' +
  'email mail message note minute meeting call transcript report record lease policy schedule order purchase quote quotation form ' +
  'certificate summary file document doc page attachment term condition handbook manual guide notice confirmation ticket booking ' +
  'reservation itinerary calendar event review service equipment product vendor supplier customer client account company project ' +
  'sale office store owner team signed executed final official inc llc ltd corp pdf docx txt csv xlsx ' +
  're fw fwd and of for the a an to with from by on in at').split(/\s+/).map(stem));
function uncheckedTitleWords(doc, allowed) {
  return [...new Set(tokens(doc.title || '').filter(word => !/^\d+$/.test(word) && !allowed.has(stem(word)) && !PLAIN_TITLE_WORDS.has(stem(word))))];
}
const lines = value => String(value || '').split(/\r?\n+/).flatMap(line => answerSentences(line)).map(s => text(s)).filter(Boolean);
// Each record sentence is analysed once per request.
const featureCache = new WeakMap();
function recordFeatures(doc) {
  const key = `${doc.title}\u0000${sourceText(doc)}`;
  const cached = featureCache.get(doc);
  if (cached?.key === key) return cached.value;
  const titleWords = new Set(tokens(doc.title || '').map(word => word.toLowerCase()));
  const body = withoutTransport([doc.snippet || doc.text, ...(doc.retrieval_excerpts || [])].filter(Boolean).join('\n\n')).split(`[${doc.title}]`).join('\n');
  // Lines and sentences both count: a scale header on its own line is a row
  // the claim must consume, and a sentence wrapped across lines still binds.
  const byLine = lines(body);
  const bySentence = answerSentences(body).map(s => text(s)).filter(Boolean);
  const row = sentence => ({ text:sentence, exact:exactClause(withoutCitations(sentence)), skeleton:skeleton(sentence),
    doubt:DOUBT.test(sentence), terms:allTerms(sentence), names:new Set(tokens(sentence).map(stem)), values:figures(sentence),
    heading: tokens(sentence).length > 0 && tokens(sentence).every(word => titleWords.has(word.toLowerCase())) });
  const value = { rows:byLine.map(row), exact:new Set([...byLine, ...bySentence].map(s => exactClause(withoutCitations(s)))), bySentence:bySentence.map(row) };
  featureCache.set(doc, { key, value });
  return value;
}
const quoteOf = value => text(value).slice(0, 240);
const QUOTED_CONTEXT = 3;
// An uncited record names the claim when one of its sentences is not the
// claim itself and shares at least two of the claim's field words (the one
// word of a one-word field) and at least half of them ("Storage fees were
// raised" names "The monthly storage fee"; "The late fee is $50" does not),
// or carries every word of a cited record's title.
function namesField(row, field) {
  if (!field.length) return false;
  const shared = field.filter(term => row.terms.has(term)).length;
  return shared >= Math.min(2, field.length) && shared * 2 >= field.length;
}
function namesClaim(doc, anchor, citedTitles) {
  return recordFeatures(doc).rows.find(row => row.exact !== anchor.exact && (namesField(row, anchor.field) ||
    citedTitles.some(title => title.length > 1 && title.every(term => row.names.has(term)))));
}
function claimGrounding(sentence, docs, { question = '', claims = new Set(), claimText = '', verifiedClauses = new Set() } = {}) {
  const { body, interiorCitation } = claimBody(sentence);
  const anchor = { exact:exactClause(body), skeleton:skeleton(body), field:fieldTerms(body), doubt:DOUBT.test(body) };
  const said = quoteOf(withoutCitations(sentence));
  const cited = docs.filter(d => citationNumbers(sentence).includes(d.n) && sourceText(d));
  const doubts = [];
  const disputed = [];
  const doubt = (kind, reason) => { if (!doubts.some(d => d.reason === reason)) doubts.push({ kind, reason }); };
  let exact = !interiorCitation && cited.length > 0 && anchor.exact.length >= 8;
  if (interiorCitation) doubt('paraphrase', `The claim "${said}" carries a citation marker inside it; only sentence-end citations are accepted.`);
  if (anchor.exact.length < 8) doubt('paraphrase', `The claim "${said}" is too short to bind to a source clause.`);
  if (!cited.length) doubt('paraphrase', `The claim "${said}" cites no readable record.`);
  if (anchor.doubt && !verifiedClauses.has(anchor.exact)) doubt('qualified', `The claim "${said}" is itself qualified, so it is reported as what the record says.`);
  const claimWords = tokens(claimText).map(stem);
  const questionWords = tokens(question).map(stem);
  for (const d of cited) {
    const record = recordFeatures(d);
    if (!record.exact.has(anchor.exact)) {
      exact = false;
      const changed = [...record.rows, ...record.bySentence].find(row => row.skeleton === anchor.skeleton);
      if (changed) doubt('figure', `The draft changes a figure, unit or letter case that "${recordTitle(d)}" states as "${quoteOf(changed.text)}"; the source wording is used.`);
      else doubt('paraphrase', `The record "${recordTitle(d)}" has no sentence identical to the claim, with the same figures, units and letter case.`);
      continue;
    }
    // A question can name a rejected/example record while asking for an
    // operative figure. Only record-body evidence can corroborate those title
    // words; full consumption and the heading cap then retain its qualifiers.
    // Transport title wrappers are already removed from record.rows.
    const bodyWords = new Set(record.rows.flatMap(row => tokens(row.text).map(stem)));
    const allowed = new Set([...claimWords, ...questionWords.filter(word => bodyWords.has(word))]);
    const unchecked = uncheckedTitleWords(d, allowed);
    if (unchecked.length) doubt('title', `The record title "${recordTitle(d)}" contains ${unchecked.map(w => `"${w}"`).join(', ')}, which was not checked against the claim.`);
    const context = record.rows.filter(row => !claims.has(row.exact) && !row.heading);
    if (context.length) {
      const shown = context.slice(0, QUOTED_CONTEXT).map(row => `"${quoteOf(row.text)}"`).join(', ');
      const more = context.length > QUOTED_CONTEXT ? ` and ${context.length - QUOTED_CONTEXT} more sentence(s)` : '';
      doubt('context', `The record "${recordTitle(d)}" also says ${shown}${more}, which ${context.length === 1 ? 'was' : 'were'} not checked against the claim and may qualify, retract or replace it.`);
    }
  }
  // A cited record's title, figures included ("Specification 1"), names it.
  const citedTitles = cited.map(d => [...new Set(tokens(d.title || '').filter(word => !SUBJECT_STOP.has(word.toLowerCase())).map(stem))]);
  for (const d of docs.filter(d => !cited.includes(d) && sourceText(d))) {
    const row = namesClaim(d, anchor, citedTitles);
    if (!row) continue;
    disputed.push(d);
    const reason = `The record "${recordTitle(d)}" (${dateLabel(d)}) says "${quoteOf(row.text)}", which may dispute or supersede the claim.`;
    if (!doubts.some(x => x.reason === reason)) doubts.push({ kind:'dispute', reason, doc:d });
  }
  return { exact, grounded: exact && doubts.length === 0, doubts, disputed };
}

// Provider memo/detail fields are not approved financial claims. A rejected
// books draft still gets the canonical source observation, without promoting
// a claim-shaped party label or an unrelated memo amount into the answer.
function booksReading(doc) {
  if (doc.source_kind !== 'quickbooks') return null;
  const raw = sourceText(doc);
  const start = raw.search(/\b(?:Bank account |Credit Card account |Invoice \S+ (?:to|for) |Bill \S+ from |Bill payment to )/);
  if (start < 0) return null;
  const head = raw.slice(start).split(/\. QuickBooks\b/)[0];
  const parts = [...head.matchAll(/:\s+(?=(?:balance|total|open balance|remaining credit)\s+[A-Z]{3}\s|[A-Z]{3}\s+-?\d)/g)];
  if (!parts.length) return null;
  const at = parts.at(-1).index;
  const subject = head.slice(0, at).replace(/^(?:Bank|Credit Card) account |^Invoice \S+ (?:to|for) |^Bill \S+ from |^Bill payment to /, '').replace(/ on \d{4}-\d{2}-\d{2}$/, '');
  const unsafe = quickBooksLabel(subject) === null;
  return { extract:unsafe ? head.slice(at + 2) : head, unsafe };
}
const recordTitle = doc => booksReading(doc)?.unsafe ? 'QuickBooks record (party label unverified)' : doc.title || 'Untitled record';
export { recordTitle as documentRecordTitle };

// Model confidence is presentation metadata only when it is a standalone
// label. A cited sentence reporting a source's percentage remains evidence.
function cleanDraft(draft, docs) {
  let ceiling = 100;
  const body = String(draft || '').split('\n').filter(line => {
    const label = /^\s*(?:#{1,6}\s*)?\*{0,2}Confidence\s*:?\*{0,2}\s*:?\s*(?:High|Medium|Low)\s*\((\d+)%\)/i.exec(line);
    if (!label) return true;
    if (citationNumbers(line).some(n => docs.some(d => d.n === n && sourceText(d).includes(text(line.replace(/\[\d+\]/g, '')))))) return true;
    ceiling = Math.min(ceiling, Number(label[1]));
    return false;
  }).join('\n').trim();
  return { body, ceiling };
}

function supportedFigures(sentence, docs) {
  const cited = docs.filter(d => citationNumbers(sentence).includes(d.n));
  return cited.length > 0 && figures(sentence).every(value => cited.some(d => figures(sourceText(d)).includes(value)));
}

// A record short enough to read in one glance is quoted whole: no selection
// rule can then drop a qualifier, a scale header or a later correction.
// Longer records are quoted by selection and named as partly quoted.
// A leading OCR transport warning is extraction metadata with its own
// reliability cap, not record text; the rest stays one contiguous span.
const FULL_QUOTE_CHARS = 1200;
function wholeRecord(doc) {
  let body = sourceText(doc);
  while (body.startsWith(OCR_WARNING)) body = body.slice(OCR_WARNING.length).trim();
  return body;
}
const quotedWhole = doc => !booksReading(doc) && (wholeRecord(doc).length <= FULL_QUOTE_CHARS || hasClaimContext(doc));
function recordExtract(doc, question) {
  const books = booksReading(doc);
  if (books) return books.extract;
  if (quotedWhole(doc)) return wholeRecord(doc);
  const words = terms(question);
  const sentences = answerSentences(sourceText(doc));
  const scored = sentences.map((sentence, index) => ({ sentence, index,
    score: words.filter(word => sentence.toLowerCase().includes(word)).length }));
  const signatureQuestion = /\b(?:signed|signatories|signature|executed|execution)\b/i.test(question);
  const calendarWord = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i;
  const matches = scored.filter(item => item.score > 0 || figures(item.sentence).length > 0 || calendarWord.test(item.sentence) ||
    signatureQuestion && /\b(?:signed|signatories|signature|executed|execution|witness)\b/i.test(item.sentence));
  // An exact record read still has an answer when none of the query's terms
  // occur verbatim. Whole sentences preserve subjects, negations and figures.
  const selected = (matches.length ? matches : scored.slice(0,2)).map(item => item.index);
  if (!selected.length) return '';
  // A qualifier travels with the quote. Every sentence with a figure is
  // already selected, so a qualifier is any other sentence with doubt wording
  // or an explicit reference to a claim. Extraction warnings keep their cap.
  const transport = sentence => OCR_WARNING.includes(text(sentence)) || /^\[\[page \d+: could not be read/.test(text(sentence));
  const chosen = new Set(selected);
  const qualifying = sentences.map((sentence, index) => index).filter(index => !chosen.has(index) &&
    !transport(sentences[index]) && (DOUBT.test(sentences[index]) || CLAIM_REFERENCE.test(sentences[index])));
  const span = [...selected, ...qualifying];
  const first = Math.min(...span), last = Math.min(sentences.length-1, Math.max(...span)+1);
  const body = sourceText(doc);
  let cursor=0, start=0, end=body.length;
  sentences.forEach((sentence,index) => {
    const at=body.indexOf(sentence,cursor);
    if(at<0)return;
    if(index===first)start=at;
    if(index===last)end=at+sentence.length;
    cursor=at+sentence.length;
  });
  // Slice the original span rather than joining splitter output. A quote must
  // retain punctuation, filenames and the context between selected sentences.
  return body.slice(start,end);
}

function attributed(doc, question, likely = false) {
  const primary={...doc,retrieval_excerpts:[]};
  const main=`${likely ? 'Likely relevant: ' : ''}As of ${dateLabel(doc)}, the record "${recordTitle(doc)}" says: ${JSON.stringify(recordExtract(primary, question))} [${doc.n}].`;
  return [main,...(doc.retrieval_excerpts || []).map(span =>
    `An additional retrieved excerpt from the same record says: ${JSON.stringify(text(span))} [${doc.n}].`)].join('\n');
}

const missingFor = (gap, docs) => {
  if (gap.missing) return gap.missing;
  const source = gap.source || gap.source_name || '';
  if (/conflict/.test(gap.type || '')) return 'Owner confirmation reconciling the dated records that disagree.';
  if (/money|ledger/.test(gap.type || '')) return 'Matching bank rows for the requested payer, account and period; document terms alone do not prove payment.';
  if (/tax/.test(gap.type || '')) return 'The exact entity, year, filing type and a readable copy of the requested filing.';
  if (/time|date/.test(gap.type || '')) return 'A verified event date and time zone for the requested period.';
  if (/read|text|ocr|scanned/.test(gap.type || '')) return `A complete reliable reading of ${docs.map(d => d.title).join(', ') || 'the matching records'}.`;
  return `Complete relevant coverage${source ? ` for ${source}` : ''}; resolve: ${gap.detail || gap.type || 'the reported gap'}`;
};

/** The only document answer boundary. A veto changes attribution and certainty,
 * never erases a record's readable statement. Defaults are incomplete; High
 * requires affirmative evidence, and search failure is never an absence claim.
 * Authorization and credential screening must happen before this function.
 */
export function finalizeDocumentAnswer({ question = '', draft = null, docs = [], approvedDocs = [],
  checks = [], gaps = [], degraded = null, searchComplete = false, retrievedCount = docs.length,
  screenedCount = 0, coverage = null, handoff = null, deterministicDraft = null, notice = null,
  asOf = new Date(Date.now()).toISOString().slice(0,10) } = {}) {
  if (handoff) {
    const answer = typeof handoff.answer === 'string' && handoff.answer.trim() ? handoff.answer
      : 'No bank rows have been read for this question. Read the available accounts and requested period, then report the observed figure with the missing coverage.';
    return {...handoff,answer,answer_contract:{version:1,kind:'bank_handoff'}};
  }
  if (docs.some(d=>d.selection?.reason==='discovery_unavailable')) gaps=[...gaps,{
    type:'successor_discovery_incomplete',detail:'Related-record discovery did not complete; a newer applicable record remains unverified.',
    missing:'A completed authorized correction, thread and family discovery read for the cited records.'}];
  let selectionCeiling=100;
  const unresolved = docs.filter(d => d.selection?.state === 'unresolved');
  if (unresolved.length) {
    // Discovery cannot approve either side of a claim conflict. Retain both
    // dated statements and the exact reconciliation gap even if a checker
    // approves the stale draft. No bank arithmetic uses this document branch.
    gaps = [...gaps,{type:'newer_record_conflict',
      detail:'A newer related record was discovered. Its applicability to the exact claim remains unresolved.',
      missing:'Read and reconcile the newer related record against this exact claim, its effective date and operative clauses.'}];
    selectionCeiling=cleanDraft(draft,docs).ceiling;
    draft = null;
    deterministicDraft = null;
  }
  const readable = docs.filter(d => sourceText(d));
  const cleaned = cleanDraft(draft, docs);
  cleaned.ceiling=Math.min(cleaned.ceiling,selectionCeiling);
  const failures = checks.filter(check => check?.supported !== true || check?.complete !== true);
  let rung = 3, answer = '', used = [];
  const sentences = answerSentences(cleaned.body);
  const usable = cleaned.body && !documentAnswerHasRefusal(cleaned.body) && sentences.some(s => /\[\d+\]/.test(s));
  const provenance = documentFigureProvenance({question,draft:cleaned.body,docs,
    hasFigure:value=>figures(value).length>0,asOf,searchComplete,retrievedCount});
  // A checker can approve a refusal or an unsupported paraphrase. Admission
  // needs a positive source-bound statement, rather than a refusal blacklist.
  // Other prose becomes an attributed quote, preserving the actual figures.
  const groundingContext = { question, claimText:cleaned.body, verifiedClauses:provenance.verifiedClauses,
    claims:new Set(sentences.map(sentence => exactClause(claimBody(sentence).body))) };
  const grounding = sentences.map(sentence => claimGrounding(sentence, docs, groundingContext));
  // Exact: every claim is a case-sensitive clause of each record it cites.
  // Grounded: also full consumption, a plain title and no naming record.
  const exactDraft = sentences.length > 0 && grounding.every(g => g.exact) && sentences.every(s => supportedFigures(s, docs));
  const groundedDraft = exactDraft && grounding.every(g => g.grounded);
  // The books readers bind account, observation time and amount without a
  // model. Their reviewed formatting is not a verbatim document clause.
  // Only the exact internally produced draft may use this admission; all
  // shared checks must still pass before rung 1 is available.
  const safeDraft = usable && (groundedDraft || typeof deterministicDraft === 'string' && deterministicDraft === cleaned.body);
  if (safeDraft && checks.length > 0 && failures.length === 0 && approvedDocs.length) {
    rung = 1; answer = cleaned.body; used = docs.filter(d => citationNumbers(answer).includes(d.n));
  } else if (usable && (safeDraft || exactDraft) && checks.length > 0 && (failures.length || !groundedDraft) &&
      !failures.some(c => c.unreadable || c.error)) {
    rung = 2;
    // A failed subject, date or money check, or a record the claim does not
    // consume, cannot be repaired by prefixing the draft with "the record
    // says". Quote the actual cited record, with its context.
    used = readable.filter(d => citationNumbers(cleaned.body).includes(d.n));
    answer = used.map(d => attributed(d, question)).join('\n');
  }
  if (!answer && readable.length) {
    rung = 3; used = readable;
    answer = used.map(d => attributed(d, question, true)).join('\n');
  }
  if (!answer) {
    const sources = (coverage?.sources || []).map(s => s.name || s.source).filter(Boolean);
    const labels = [...new Set(sources)].join(', ') || 'the requested sources (source inventory unverified)';
    const through = (coverage?.sources || []).filter(s => s.last_ingest_at).map(s => `${s.name}: ${s.last_ingest_at}`).sort().join(', ') || 'dates unverified';
    rung = 4;
    answer = retrievedCount === 0 && searchComplete
      ? `Not found in 0 records returned by this search from ${labels}, read through ${through}.`
      : screenedCount > 0
        ? `${screenedCount} retrieved record(s) reached the sensitive-record screen. No permitted readable text was available for this question; their contents remain unverified.`
        : `The available reading contains no readable matching statement. ${retrievedCount} record(s) were returned; ${searchComplete ? 'their missing text is unverified' : 'the search is incomplete and matching records may be missing'}.`;
    // A route that read nothing says why first; it is also a named gap.
    if (typeof notice === 'string' && notice.trim()) answer = `${notice.trim()} ${answer}`;
  }

  const deductions = [];
  const add = (reason, missing, amount = 8) => {
    if (!deductions.some(d => d.reason === reason)) deductions.push({ reason, missing, amount });
  };
  for (const check of failures) {
    // Legacy ledger codes are diagnostics. Their paired owner explanation is
    // the evidence gap, so rendering confidence must not expose the code.
    // An absent diagnostic code cannot identify a gap. Matching two undefined
    // reasons hides model/verification failures behind unrelated coverage text.
    const matchingGap = check.reason && gaps.find(gap => gap.reason === check.reason && gap.detail);
    const reason = matchingGap?.detail || check.reason || check.error || 'the evidence check did not confirm every claim';
    add(`Check incomplete: ${reason}.`, `Evidence resolving this check: ${reason}.`, 12);
  }
  for (const gap of gaps) add(gap.detail || `Coverage gap: ${gap.type}.`, missingFor(gap, used));
  const partlyRead = used.filter(d => d.read_complete !== true || d.text_source === 'ocr_partial' || d.text_reliable !== true);
  for (const d of partlyRead) add(`The record "${recordTitle(d)}" was only partly read or its text is unverified.`, `The remaining readable text of "${recordTitle(d)}".`);
  // A draft that is not grounded never states its figure at High. Each doubt
  // is named; paraphrase keeps its existing single deduction below.
  // A deterministic books reading binds each provider entity and its latest
  // observation from structured fields. Other structured provider records
  // are other entities, not free text that could qualify the claim; they keep
  // the strictly-newer rule only.
  const draftCitedDocs = readable.filter(d => citationNumbers(cleaned.body).includes(d.n));
  const providerRecord = d => d.source_kind === 'quickbooks';
  const structuredAnswer = typeof deterministicDraft === 'string' && deterministicDraft === cleaned.body &&
    draftCitedDocs.length > 0 && draftCitedDocs.every(providerRecord);
  const unproved = provenance.checks.filter(check=>!check.proven);
  for (const check of unproved) add(check.reason,check.missing,0);
  const structuredOther = d => structuredAnswer && providerRecord(d);
  const doubts = usable ? grounding.flatMap(g => g.doubts).filter(d => d.kind !== 'paraphrase' && !(d.doc && structuredOther(d.doc))) : [];
  const doubtMissing = {
    figure:'The exact figure, unit and letter case as the source record states them.',
    qualified:'Confirm whether the qualified statement applies to the question.',
    context:"Confirm whether the record's other statements qualify, retract or replace the claim.",
    title:"Applicable source terms and authority establishing whether the record's title qualifies the claim.",
    dispute:'Reconcile the records that state different figures or doubts for the same field.',
  };
  for (const d of doubts) add(d.reason, doubtMissing[d.kind], 0);
  for (const d of used.filter(d => booksReading(d)?.unsafe)) add('The provider party label is unverified; only the recorded financial clause is quoted.', 'Confirm the account or party identity in the original books record.');
  // Uncited records: a record cannot be ignored unless it is provably older
  // than every cited record and names neither the claim's field nor a cited
  // record. Unknown and unreliable dates are not provably older.
  const draftCited = draftCitedDocs;
  // "Newer" reads the stated date (its label says when it is unverified);
  // "provably older" needs a reliable date.
  const day = d => { const t = Date.parse(recordObservation(d).ts || ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };
  const reliableDay = d => recordObservation(d).date_reliable === false ? null : day(d);
  const citedDays = draftCited.map(day).filter(Boolean).sort();
  const newestCited = citedDays.at(-1) ?? null;
  const isNewer = d => newestCited !== null && day(d) !== null && day(d) > newestCited;
  const notOlder = d => newestCited === null || reliableDay(d) === null || reliableDay(d) >= newestCited;
  const naming = new Set(grounding.flatMap(g => g.disputed));
  const uncited = draftCited.length ? readable.filter(d => !draftCited.includes(d)) : [];
  const newer = uncited.filter(isNewer);
  const alongside = rung === 3 ? [] : uncited.filter(d => !isNewer(d) && !structuredOther(d) && (notOlder(d) || naming.has(d)));
  const others = [...newer, ...alongside];
  if (others.length) {
    const additional = others.filter(d=>!used.includes(d));
    if (additional.length) answer = used.map(d=>attributed(d,question)).join('\n');
    const line = d => additional.includes(d) ? attributed(d,question) : `"${d.title}" (${dateLabel(d)}) [${d.n}]; its statement is included above.`;
    if (newer.length) answer += `\nNewer retrieved records were not cited in the draft:\n${newer.map(line).join('\n')}`;
    if (alongside.length) answer += `\nRetrieved records that are not provably older, or that name the same subject, were not cited in the draft:\n${alongside.map(line).join('\n')}`;
    for (const d of newer) add(`Newer retrieved record "${d.title}" (${dateLabel(d)}) was not cited by the draft.`, `Reconcile the answer with "${d.title}" (${dateLabel(d)}).`);
    for (const d of alongside) add(`Retrieved record "${d.title}" (${dateLabel(d)}) is not provably older than the cited records, or names the same subject, and was not cited by the draft.`, `Reconcile the answer with "${d.title}" (${dateLabel(d)}).`);
    used = [...new Set([...used,...others])];
  }
  // A long record quoted by selection is named: its unquoted sentences were
  // not checked against the answer.
  const attributedAnswer = rung !== 1 || others.length > 0 || unproved.length > 0;
  const partlyQuoted = attributedAnswer ? used.filter(d => sourceText(d) && !booksReading(d) && !quotedWhole(d)) : [];
  for (const d of partlyQuoted) add(`Only part of the record "${recordTitle(d)}" is quoted; its other sentences were not checked against the answer.`, `The complete text of "${recordTitle(d)}" checked against the answer.`, 0);
  const base = computeAnswerConfidence({ approvedDocs: used, claim:cleaned.body });
  let percent = base.percent - deductions.reduce((sum, d) => sum + d.amount, 0);
  const exactClaims = grounding.every((g, i) => !/\[\d+\]/.test(sentences[i]) || g.exact);
  const claimFigures = new Set(figures(cleaned.body));
  const extraFigures = used.some(d => figures(sourceText(d)).some(value => !claimFigures.has(value)));
  if (rung === 1 && extraFigures) add('The cited records contain other figures whose relationship to this claim has not been independently checked.', 'Verify each figure against its complete source clause.', 0);
  if (!exactClaims) add('The draft paraphrases the source; exact clause equivalence has not been established.', 'An exact source-span check for each paraphrased claim.', 0);
  if (failures.length || partlyRead.length || gaps.length || degraded || !exactClaims || extraFigures || doubts.length ||
      others.length || partlyQuoted.length) percent = Math.min(percent, 89);
  if (gaps.some(g => /conflict/.test(g.type || ""))) percent = Math.min(percent, 69);
  if (rung === 3) percent = Math.min(percent, 69);
  if (rung === 4) percent = Math.min(percent, 30);
  // Title/question token overlap does not consume a heading's meaning. Only
  // neutral record labels may be omitted at High; scale, units and other
  // unchecked heading context need interpretation even after checker approval.
  // Preserve existing readings already below High rather than guessing how a
  // heading applies to their figures.
  if (rung === 1 && percent >= 90) for (const doc of used) {
    const unchecked = recordFeatures(doc).rows.filter(row => row.heading && !groundingContext.claims.has(row.exact) &&
      tokens(row.text).some(word => !PLAIN_TITLE_WORDS.has(stem(word))));
    for (const row of unchecked) {
      percent = Math.min(percent, 89);
      add(`The record "${recordTitle(doc)}" has an unconsumed heading "${quoteOf(row.text)}"; its scale, units or qualifications were not carried into the answer.`,
        `Check the complete heading "${quoteOf(row.text)}" against the cited figure before interpreting its scale, units or qualifications.`, 0);
    }
  }
  // Last numerical document post-condition: citation admission, model approval
  // and agreement cannot fill a missing provenance slot. This runs for every
  // document draft, including deterministic text, and only lowers certainty.
  if (unproved.length) {
    const wasHigh = percent>=90;
    percent = Math.min(percent,89);
    if (rung===1) {
      if (wasHigh) rung=2;
      answer=used.map(doc=>attributed(doc,question)).join('\n');
    }
  }
  if (!searchComplete) {
    percent = Math.min(percent, 10);
    add('The search did not complete.', 'A completed search over the requested sources and periods.');
  }
  percent = Math.max(0, Math.min(percent, cleaned.ceiling));
  base.basis[0] = `${used.length} source record${used.length===1?'':'s'} read; ${rung===1 ? 'the draft passed citation checks' : 'the answer uses attributed record text without approving the original draft'}`;
  const basis = [...base.basis, ...deductions.map(d => d.reason), `Read ${used.length} of ${retrievedCount} retrieved records; the relevant corpus may contain additional records.`];
  const missing = [...new Set([...deductions.map(d => d.missing), 'Independent verification and a complete search of the relevant source periods.'])];
  const confidence = { ...ownerConfidence({percent}), basis, reasons: basis, missing, deductions };
  const dates = used.map(dateLabel);
  const coverageText = `Read ${used.length} of ${retrievedCount} retrieved records from ${[...new Set(used.map(d => d.source))].join(', ') || 'sources unverified'}, dated ${[...new Set(dates)].join(', ') || 'dates unverified'}.`;
  answer += `\n\nCoverage: ${coverageText}\nMissing or counted twice: ${missing.join(' ')} Any monetary impact or duplicate amount is unknown unless stated in the quoted records.\nEstimates: ${rung === 1 ? 'The cited statements are record evidence; present status and completeness remain unverified.' : 'Likely record relevance; attributed statements are not confirmation of your identity, present status or bank payment.'}\nHow to check: ${used.length ? 'Open the cited originals and reconcile their dates, subjects and figures' : 'Complete the source search and read the matching originals'}.`;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('DOCUMENT_ANSWER_EMPTY');
  return { answer, confidence, confidence_text: ownerConfidenceLine(confidence),
    answer_contract: {version:1, kind:'document', rung, read_count:used.length, retrieved_count:retrievedCount,
      read_coverage:used.filter(d=>d.read_coverage).map(d=>({n:d.n,...d.read_coverage,
        prepared_chars:sourceText(d).length,answer_clauses_checked:rung===1?'complete':'partial'})),
      ...(provenance.required ? {provenance:{version:1,complete:provenance.complete,
        checked_records:provenance.checked_records,checks:provenance.checks.map(({check,proven})=>({check,proven}))}} : {})}, usedDocs:used };
}

// Old Workers can attach confidence in rejecting a draft. Rebuild the owner
// reading from returned evidence so a stale label cannot approve that draft.
export function legacyDocumentResponse(body) {
  const completed = body.answer_contract && typeof body.answer === 'string' && body.answer.trim();
  if (completed || body.ledger || !(['coverage_incomplete', 'answer_withheld', 'search_unavailable'].includes(body.status) || body.degraded)) return body;
  const rows = body.results || [];
  const scoringGaps = (body.gaps || []).map(gap => ({ ...gap,
    ...(typeof gap.detail === 'string' ? { detail: gap.detail.replace(/\s*Want[^?]*\?/g, '') } : {}) }));
  // A legacy veto is an incomplete check, not owner-facing refusal copy.
  // Keep that gap in scoring while rebuilding the reading from returned text.
  const legacyVeto = body.status === 'answer_withheld' || /\bwithheld\b/i.test(body.notice || '');
  const notice = legacyVeto
    ? 'The evidence check is incomplete. This reading is provisional.'
    : (body.notice || 'Source coverage is incomplete. This result is provisional.');
  if (legacyVeto) scoringGaps.push({ type: 'legacy_evidence_incomplete',
    detail: 'The evidence check did not verify the answer.',
    missing: 'Readable source records and a completed evidence check for this question.' });
  const reading = finalizeDocumentAnswer({ draft: body.answer, docs: rows, gaps: scoringGaps,
    checks: body.evidence_gate ? [body.evidence_gate] : [], degraded: body.degraded,
    searchComplete: body.status !== 'search_unavailable' && !body.degraded && rows.some(row => sourceText(row)),
    notice: notice
      .replaceAll((body.gaps || []).some(gap => ['ledger_not_consulted', 'ledger_out_of_coverage'].includes(gap.type)) ? 'Source coverage' : /$^/g, 'The connected records') });
  // Candidate relevance cannot imply a verified answer to a categorical draft.
  if ((!body.answer || documentAnswerHasRefusal(body.answer)) && reading.confidence.percent > 30) {
    reading.confidence = { ...reading.confidence, ...ownerConfidence({ ...reading.confidence, percent: 30 }) };
  }
  if (Number.isFinite(body.confidence?.percent) && body.confidence.percent < reading.confidence.percent)
    reading.confidence = { ...reading.confidence, ...ownerConfidence({ ...reading.confidence, percent: body.confidence.percent }) };
  reading.confidence.missing = [...new Set([...(body.confidence?.missing || []), ...reading.confidence.missing])];
  reading.confidence_text = ownerConfidenceLine(reading.confidence);
  return { ...body, ...reading, notice, status: undefined };
}
