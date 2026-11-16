import { answerSentences } from './answer-sentences.js';
import { documentRecordContext } from './document-answer-context.js';

const text = value => String(value || '').replace(/\s+/g, ' ').trim();
const clause = value => text(value).replace(/\s*\[\d+\]/g, '').replace(/[.\s]+$/, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const day = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,10) === value ? value : null;
};
const monthNames = 'January February March April May June July August September October November December'.split(' ');
const monthEnd = (year, month) => new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
const bases = new Map([['annual','annual'],['yearly','annual'],['monthly','monthly'],['weekly','weekly'],
  ['quarterly','quarterly'],['daily','daily'],['one-time','one-time']]);
const fieldLabels = new Set(['Status','Amendments checked through','Subject','Measure','Rate basis',
  'Scale','Currency','Covered dates']);

// Stored chunks repeat their title, and citation candidates collapse line
// breaks. Separate wrappers/headings BEFORE sentence splitting: punctuation
// inside a title must not change a fact's field or swallow its first clause.
// Only the record's own title is dropped. Unknown labels stay separate source
// rows, so normalizing a prefix cannot certify unconsumed provenance context.
function sourceForChecks(doc) {
  let raw = String(doc.snippet || doc.text || '');
  const boundary = '(^|[\\r\\n]|[.!?]\\s+)';
  let previous;
  // Each pass consumes markup or replaces a heading separator with a newline.
  // Repeat to handle mixed prefix order, such as "Title: [record] ...".
  do {
    previous = raw;
    if (doc.title) {
      raw = raw.replace(new RegExp(`${boundary}[ \\t]*(?:\\[${escape(String(doc.title))}\\][ \\t]*)+`,'g'),'$1\n');
    }
    // A bracket inside a fact's value is source meaning, not a prefix.
    raw = raw.replace(/(^|[\r\n]|[.!?]\s+)[ \t]*((?:\[[^\]\r\n]+\][ \t]*)+)/g,
      (whole,start,prefixes) => start + prefixes.replace(/\[([^\]\r\n]+)\][ \t]*/g,
        (wrapper,label) => label===doc.title ? '\n' : `\n${label}\n`));
    if (doc.title) {
      const title = escape(text(doc.title));
      raw = raw.replace(new RegExp(`${boundary}[ \\t]*(?:#{1,6}[ \\t]+)?${title}:[ \\t]*`,'gi'),'$1\n')
        .replace(new RegExp(`${boundary}[ \\t]*#{1,6}[ \\t]+${title}(?:[ \\t]+#+)?(?=\\s|$)`,'gi'),'$1\n');
    }
    raw = raw.replace(/(^|[\r\n]|[.!?]\s+)[ \t]*#{1,6}[ \t]+/g,'$1\n');
    raw = raw.replace(/(^|[\r\n]|[.!?]\s+)([^.!?:\r\n]+):[ \t]+/g,
      (whole,start,label) => fieldLabels.has(label.trim()) || /\b(?:is|are)\b/i.test(label)
        ? whole : `${start}${label}:\n`);
  } while (raw!==previous);
  return raw;
}

// This is a positive source grammar, not a classifier of suspicious words.
// Unrecognized prose remains useful quoted evidence but proves no slot. Each
// field must be a complete source sentence, appear once, and survive verbatim
// in the answer. Neither a model's verdict nor a question supplies a fact.
function fieldsFor(doc) {
  const rows = answerSentences(sourceForChecks(doc)).map(value=>text(value).replace(/[.\s]+$/, ''));
  const field = label => {
    const prefix = `${label}: `;
    const values = rows.filter(row => row.startsWith(prefix));
    return values.length === 1 ? { value:values[0].slice(prefix.length), row:values[0] } : null;
  };
  return { rows, status:field('Status'), amendments:field('Amendments checked through'),
    subject:field('Subject'), measure:field('Measure'), basis:field('Rate basis'),
    scale:field('Scale'), currency:field('Currency'), coverage:field('Covered dates') };
}

// Exclusive identity is proved by the fact span, never by text before its
// operator. Citation transport can flatten an unknown heading into that text;
// adding more title/prefix patterns cannot recover the lost boundary. This
// projection is only a consistency check: it drops no context from grounding,
// labelled-field proof or quotes, and can only introduce a confidence ceiling.
function exclusiveConsistency(records, citedRecords) {
  const facts = new Map();
  const cited = new Set(citedRecords.map(doc=>doc.n)), subjects = new Set();
  const subjectKey = value => text(value).toLowerCase().replace(/^(?:the|a|an)\s+/,'')
    .replace(/\b([a-z]+)s$/, (whole,word)=>/(?:ss|us|is)$/.test(whole) ? whole : word);
  // Party spelling is case-insensitive, but a number's units are not: mW
  // and MW must still conflict. This key never changes source quotes.
  const valueKey = value => value.split(/((?:[A-Z]{3}\s+|[$€£]\s*)?\p{N}[\p{N},.]*(?:\s*[\p{L}µμ%]+)?)/u)
    .map((part,i)=>i%2 ? part : part.toLowerCase()).join('');
  for (const doc of records) {
    // Use the same whitespace on both sides of the Worker boundary. Do not
    // strip numeric brackets from source values: they can be actual labels.
    for (const row of answerSentences(text(doc.snippet || doc.text))) {
      for (const operator of row.matchAll(/\b(?:sole|single|only|exclusive|solely|exclusively)\b/gi)) {
        const before=row.slice(0,operator.index), after=row.slice(operator.index+operator[0].length);
        // The forward subject is everything between the operator and the
        // first whitespace-delimited is/are, punctuation included, as in the
        // original check: "The sole member of Acme, LLC is ...", "The sole
        // custodian (escrow agent) is ...", "The sole-source supplier is ...".
        // A narrower subject grammar here turned such contradictions into
        // High. When nothing stands between them, the words before the
        // operator name the subject, as they did originally.
        const copula=/^(.*?)\s+(?:is|are)\s+(.+)$/iu.exec(after);
        const forward=copula && [text(copula[1]) || text(before+operator[0]),copula[2]];
        // The stricter grammar only adds readings ("only" inverted, "may
        // hold"); it never decides whether a forward reading exists.
        const strict=/^\s+([\p{L}\p{N}][\p{L}\p{N}\s'’/-]*?)\s+(?:is|are)\s+(.+)$/iu.exec(after);
        // Each reading is a [subject, value] pair for this operator.
        const readings=[];
        if (/^(?:sole|single|exclusive)$/i.test(operator[0])) {
          // Adjectives never invert. Whatever precedes them (a determiner,
          // a possessive such as "The Company's", a qualifier such as
          // "designated", a flattened heading) is not part of the fact.
          if (forward) readings.push(forward);
        } else if (/^only$/i.test(operator[0])) {
          // "only" is ambiguous: the value is before the copula in "Only A
          // is the custodian" and after it in "The deposit's only custodian
          // is A". Keep both readings: a contrary record conflicts under the
          // real one, and agreeing copies agree under both.
          if (forward) readings.push(forward);
          if (strict) readings.push([strict[2],strict[1]]);
          else {
            const permission=/^\s+([\p{L}\p{N}][\p{L}\p{N}\s'’/-]*?)\s+may hold\s+(.+)$/iu.exec(after);
            if (permission) readings.push([`may hold ${permission[2]}`,permission[1]]);
          }
        } else {
          const role=/\b(?:the|a|an|its|their|our|his|her|this|that|each)\s+([\p{L}\p{N}][\p{L}\p{N}\s'’/-]*?)\s+(?:is|are)(\s+held)?\s+$/iu.exec(before);
          if (role) {
            const holder=role[2] ? /^\s+by\s+(.+)$/iu.exec(after) : /^\s+(.+)$/u.exec(after);
            if (holder) readings.push([role[1]+(role[2] ? ' held by' : ''),holder[1]]);
          }
        }
        // Titles and non-fact uses ("only by wire", "single payment")
        // produce no reading. A keyword alone cannot lower certainty.
        for (const [rawSubject,rawValue] of readings) {
          if (!rawSubject || !rawValue) continue;
          const subject=subjectKey(rawSubject.replace(/[.\s]+$/,''));
          const value=valueKey(text(rawValue).replace(/[.\s]+$/,''));
          const values=facts.get(subject) || new Map();
          const sources=values.get(value) || new Set();
          sources.add(doc.n); values.set(value,sources); facts.set(subject,values);
          if (cited.has(doc.n)) subjects.add(subject);
        }
      }
    }
  }
  const conflictingRecords=new Set([...facts].filter(([subject,values])=>subjects.has(subject) && values.size>1)
    .flatMap(([,values])=>[...values.values()].flatMap(sources=>[...sources])));
  return subjects.size ? {check:'exclusive_consistency',proven:conflictingRecords.size===0,conflictingRecords,
    reason:'The retrieved records conflict: they assert different exclusive values for the same fact.',
    missing:'The reconciled operative record identifying one exclusive value and resolving the contrary assertions.'} : null;
}

function requestedPeriod(value) {
  // An answer date checks amendments; it cannot supply an omitted request date.
  if (!value) return null;
  const v = text(value);
  if (day(v)) return {from:v,to:v};
  const range = /^(\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2})$/.exec(v);
  if (range && day(range[1]) && day(range[2]) && range[1]<=range[2]) return {from:range[1],to:range[2]};
  const month = /^(\p{L}+) (\d{4})$/u.exec(v);
  const index = month ? monthNames.findIndex(name => name.toLowerCase()===month[1].toLowerCase()) : -1;
  if (index>=0 && Number(month[2])>=1900 && Number(month[2])<=2999)
    return {from:`${month[2]}-${String(index+1).padStart(2,'0')}-01`,to:monthEnd(Number(month[2]),index+1)};
  if (/^(?:19|20|21|22|23|24|25|26|27|28|29)\d{2}$/.test(v)) return {from:`${v}-01-01`,to:`${v}-12-31`};
  return null;
}

function requestSubject(value) {
  // A determiner belongs to the clause grammar, not the source identifier.
  // Preserve all captured identifier letters, digits and unit case after it.
  return text(value).replace(/^(?:the|a) /i,'');
}

function requestAdjunct(preposition, value) {
  const period=/^(?:in|for|on)$/i.test(preposition) && requestedPeriod(value);
  if (period) return {period};
  if (/^(?:under|in|for)$/i.test(preposition)) return {subject:requestSubject(value)};
  return null;
}

// Parse request scope without source fields. Grammar words ignore case; captured
// subject and measure do not. Clauses compose independently of the question's
// interrogative spelling or whether subject/date is a leading adjunct. Unknown
// clauses, aggregation, negation and relative dates cannot prove scope equality.
function requestFor(question) {
  let rest=text(question).replace(/\?$/, '');
  const scope={subject:null,period:null};
  // Leading and trailing adjuncts use the same parser and may fill each slot
  // only once. A second clause never overwrites an explicit request scope.
  const add = adjunct => {
    if (!adjunct) return false;
    for (const [slot,value] of Object.entries(adjunct)) {
      if (scope[slot]!==null) return false;
      scope[slot]=value;
    }
    return true;
  };
  const leading=/^(under|in|for|on) (.+?), (.+)$/i.exec(rest);
  if (leading) {
    if (!add(requestAdjunct(leading[1],leading[2]))) return null;
    rest=leading[3];
  }
  const ask=/^(?:what|how much)(?: is| are)? (?:the )?(annual|yearly|monthly|weekly|quarterly|daily|one-time) (.+)$/i.exec(rest);
  if (!ask) return null;
  rest=ask[2];
  const stated=/^(.+?) does (.+?) state(?: (in|for|on) (.+))?$/i.exec(rest);
  const scoped=/^(.+?) (under|in|for|on) (.+?)(?: (in|for|on) (.+))?$/i.exec(rest);
  let measure=rest;
  if (stated) {
    measure=stated[1];
    if (!add({subject:requestSubject(stated[2])})) return null;
    if (stated[3] && !add(requestAdjunct(stated[3],stated[4]))) return null;
  } else if (scoped) {
    measure=scoped[1];
    if (!add(requestAdjunct(scoped[2],scoped[3]))) return null;
    if (scoped[4] && !add(requestAdjunct(scoped[4],scoped[5]))) return null;
  }
  return scope.subject ? {...scope,measure,basis:bases.get(ask[1].toLowerCase())} : null;
}

const descriptions = {
  governing:['The signed, current governing document and the check for later amendments are unproved.',
    'The signed or final current original, with later amendments checked through the answer date.'],
  subject:['The exact document subject and requested measure have not been proved to match.',
    'Source evidence identifying the same lease, contract, party or entity and the requested measure.'],
  basis:['The figure\'s period or rate basis has not been proved to match the question.',
    'The source\'s annual, monthly, weekly, quarterly or other rate basis matched to the requested figure.'],
  units:['The figure\'s scale and currency or units have not both been proved and carried into the answer.',
    'The source scale (such as units, thousands, millions or percent) and explicit currency or nonmonetary units beside the figure.'],
  coverage:['The source has not proved that its covered dates include the date or month asked about.',
    'The source\'s covered from-through dates, including the entire requested date, month or period.'],
};

/** Closed-world High post-condition for a document figure. This module cannot
 * raise confidence or refuse an answer. Source-title heuristics, copy dates,
 * T1 labels, agreeing copies and verifier booleans prove none of these slots.
 * Explicitly labelled source facts are one deliberately narrow proof grammar;
 * other readings retain their figures and name the unproved checks below High.
 */
export function documentFigureProvenance({ question, draft, docs, hasFigure, asOf, searchComplete, retrievedCount }) {
  const claims = new Set(answerSentences(draft).map(clause));
  const cited = new Set([...String(draft).matchAll(/\[(\d+)\]/g)].map(match=>Number(match[1])));
  const records = cited.size ? docs.filter(doc => cited.has(doc.n)) : docs;
  const sourceClauses=records.flatMap(doc=>answerSentences(sourceForChecks(doc)).map(clause));
  const relative=sourceClauses.some(row=>/\b(?:tomorrow|yesterday|today|next (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|end of (?:this|next) month|day after signing)\b/i.test(row));
  // Citation choice is model output. It cannot exclude an authorized retrieved
  // record from consistency, even when an older copy has a different heading.
  const exclusive=exclusiveConsistency(docs,records);
  // Exact repetition and an approving checker cannot reconcile mutually
  // exclusive facts or turn a source-relative day into the answer-day clock.
  // Keep source words readable while naming the missing independent proof.
  const contextChecks=[
    ...(relative?[{check:'source_clock',proven:false,reason:'The source-relative date has no verified absolute date in the answer.',missing:'Anchor the relative date to the original source clock and carry the reconciled absolute date into the answer.'}]:[]),
    ...(exclusive?[exclusive]:[]),
  ];
  const exclusiveRecords=exclusive?.conflictingRecords || new Set();
  // Non-numeric terms can also conflict with an older governing record or
  // unresolved storage context. Copy dates never settle that conflict.
  const required = hasFigure(draft) || records.some(doc=>hasFigure(doc.snippet || doc.text)) ||
    docs.some(doc=>!cited.has(doc.n)) || records.some(doc=>!documentRecordContext(doc,fieldsFor(doc)).storage.resolved);
  if (!required) return {required:contextChecks.length>0,complete:contextChecks.every(check=>check.proven),
    checked_records:exclusive ? docs.length : relative ? records.length : 0,
    checks:contextChecks,exclusiveRecords,verifiedClauses:new Set()};
  const values = [];
  const verifiedClauses = new Set();
  const request=requestFor(question);
  for (const doc of records) {
    const fields=fieldsFor(doc), context=documentRecordContext(doc,fields);
    const carried = field => field && claims.has(field.row);
    const full = doc.read_complete===true && doc.text_reliable===true;
    const status = fields.status && /^(?:signed|executed|final) and current$/.test(fields.status.value);
    const checked = day(fields.amendments?.value);
    // Unknown uncited records cannot be dismissed by a later copy's date or
    // the number of shared words. They leave the amendment check unresolved.
    const allRecordsChecked = searchComplete && docs.length===retrievedCount && docs.every(row=>cited.has(row.n));
    const proofRows = new Set(Object.values(fields).filter(field=>field?.row).map(field=>field.row));
    const numericRows = fields.rows.filter(row=>!proofRows.has(row) && hasFigure(row));
    const number='(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)(?:\\.\\d+)?';
    const namedMeasure = fields.measure && /^[\p{L}]+(?:[ -][\p{L}]+)*$/u.test(fields.measure.value);
    const amountClause = namedMeasure && fields.basis ? new RegExp(`^The ${escape(fields.basis.value)} ${escape(fields.measure.value)} is (?:[A-Z]{3} |[$€£])?${number}%?$`,'u') : null;
    const boundFigure = numericRows.length===1 && amountClause?.test(numericRows[0]) && claims.has(numericRows[0]);
    const closedRecord = fields.rows.every(row=>proofRows.has(row) || row===numericRows[0]);
    // A complete title must bind to source subject evidence, including its
    // punctuation and digits. Transport wrappers are not guaranteed in every
    // caller, so '$000' cannot disappear from a direct boundary reading.
    const governing = full && closedRecord && context.title.resolved && context.storage.resolved &&
      status && checked && asOf && checked===asOf && allRecordsChecked && carried(fields.status) && carried(fields.amendments);
    const subject = full && request && fields.subject?.value===request.subject && fields.measure?.value===request.measure &&
      boundFigure && carried(fields.subject) && carried(fields.measure);
    // A percentage also needs its denominator. The current positive grammar
    // does not prove that extra basis, so it cannot certify a percentage.
    const basis = subject && fields.scale?.value!=='percent' &&
      bases.get(fields.basis?.value)===request.basis && carried(fields.basis);
    const scale = /^(?:units|thousands|millions|percent)$/.test(fields.scale?.value || '') && carried(fields.scale);
    const currency = /^(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|CHF|not applicable)$/.test(fields.currency?.value || '') && carried(fields.currency);
    const covered = /^(\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2})$/.exec(fields.coverage?.value || '');
    const coverage = full && request?.period && covered && day(covered[1]) && day(covered[2]) &&
      covered[1]<=request.period.from && covered[2]>=request.period.to && carried(fields.coverage);
    // Units are facts carried by the source, not defaults guessed from '$'.
    // An explicit currency must also agree with every symbol in the record.
    const symbols = [...`${doc.title || ''} ${doc.snippet || doc.text || ''}`.matchAll(/[$€£%]/g)].map(m=>m[0]);
    const compatible = symbols.every(symbol => symbol==='%' ? fields.scale?.value==='percent'
      : symbol==='€' ? fields.currency?.value==='EUR' : symbol==='£' ? fields.currency?.value==='GBP'
      : /^(?:USD|CAD|AUD|NZD)$/.test(fields.currency?.value || ''));
    const codes = numericRows[0]?.match(/\b[A-Z]{3}\b/g) || [];
    // The admitted monetary clause prints an unscaled coefficient. Separate
    // thousands/millions metadata cannot qualify that leading currency figure.
    // Until a bound scaled-clause production is proved, retain it as a quote.
    const units = full && scale && fields.scale?.value==='units' && currency && compatible &&
      codes.every(code=>code===fields.currency?.value) &&
      (fields.scale?.value==='percent')===(fields.currency?.value==='not applicable');
    const checks={governing,subject,basis,units,coverage};
    values.push({record:doc.n,checks,percentage:fields.scale?.value==='percent'});
    // This one exact positive fact contains "amendments". It is not an
    // unqualified amendment claim. No other source sentence bypasses the
    // existing qualification check, even after the five slots are proved.
    if (Object.values(checks).every(Boolean)) verifiedClauses.add(fields.amendments.row);
  }
  const checks=Object.entries(descriptions).map(([check,description])=>{
    const [reason,missing]=check==='basis' && values.some(value=>value.percentage)
      ? ['The percentage base (what the percent applies to) has not been proved.',
        'Source evidence naming the amount or measure to which the percentage applies.'] : description;
    return {check,proven:values.length>0 && values.every(value=>Boolean(value.checks[check])),reason,missing};
  });
  checks.push(...contextChecks);
  return {required:true,complete:checks.every(check=>check.proven),checked_records:exclusive ? docs.length : values.length,
    checks,exclusiveRecords,verifiedClauses};
}
