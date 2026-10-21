import { hasUnsupportedPayerPunctuation, normalizePayerCommas, normalizePayerQuestion, payerMentionsCoverQuestion } from './ledger-question.js';

// One request-local identity registry and one attribution decision per inflow.
// Bank metadata never registers an identity. Every spelling uses this same key.
export const normalizeMerchantText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+|&/gu) || []).join(" ");

// Punctuation-insensitive lookup alone would turn a dangling comma into a
// name. Keep comma positions from actual registry spellings for that grammar
// production; the private index has exactly the registry's request lifetime.
const companyCommaSpellings = Symbol('company comma spellings');
const questionSpellings = Symbol('question spellings');
const questionPhrases = Symbol('question phrases');
const damagedRegistry = Symbol('damaged registry');
const damagedSpellings = Symbol('damaged spellings');
export const payerRegistryHasDamage = registry => Boolean(registry[damagedRegistry]);
// A damaged spelling never enters lookup, but its visible text (the whole
// returned string, or the prefix a truncating driver returns) may equal a
// registered name of a different entity. Uniqueness of that name is then
// unproven: it is at least as ambiguous as the same collision undamaged.
export function payerKeyDamaged(registry, label) {
  const key = normalizeMerchantText(label);
  const damaged = registry[damagedSpellings]?.get(key);
  if (!damaged) return false;
  const slugs = registry.get(key);
  return [...damaged].some(slug => !slugs?.has(slug));
}
// The normalized visible texts (whole string and pre-NUL prefix) of one
// entity's own NUL-damaged registered spellings. A bank field equal to one of
// them, or a name variant of one, can be that entity's own row: it is never a
// known other (round 6, R6-MONEY-2).
export function damagedSpellingsOf(registry, slug) {
  if (!slug || typeof slug === 'symbol') return [];
  return [...(registry[damagedSpellings] || [])].filter(([, slugs]) => slugs.has(slug)).map(([key]) => key);
}
function phraseCommaMatches(left, right) {
  const valid = value => {
    const text = normalizePayerCommas(value);
    // Unregistered punctuation must not disappear into apparent authority.
    // Registered names keep their independently established spelling rules.
    if (hasUnsupportedPayerPunctuation(text)) return false;
    const parts = text.normalize('NFKC').split(',');
    return parts.length === 1 || (parts.length === 2 && normalizeMerchantText(parts[0]) &&
      statementGrammar.companySuffix.test(parts[1].trim().replaceAll('.', '')));
  };
  return valid(left) && valid(right) && companyCommaKey(left) === companyCommaKey(right);
}
export function exactPayerFieldAdmitted(selector, field) {
  if (hasUnsupportedPayerPunctuation(selector) || hasUnsupportedPayerPunctuation(field)) return false;
  // A grouped number inside a literal name has numeric commas, not a second
  // payer clause. Keep the original comma positions equal on both sides; this
  // admission check never changes the selector or its exact-match key.
  const numericCommas = value => normalizePayerCommas(value).normalize('NFKC')
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, number => number.replaceAll(',', ''));
  return companyCommaKey(selector) === companyCommaKey(field) &&
    phraseCommaMatches(numericCommas(selector), numericCommas(field));
}
const companyCommaKey = value => normalizePayerCommas(value).normalize('NFKC').split(',').map(normalizeMerchantText).join(',');

export function payerRegistry(identities) {
  const index = new Map();
  index[companyCommaSpellings] = new Set();
  index[questionSpellings] = new Map();
  index[damagedSpellings] = new Map();
  for (const identity of identities) for (const column of ['legal_name', 'display_label']) {
    const label = identity[column];
    // Reject only the damaged spelling, keeping the entity's valid aliases.
    // SQL flags preserve this decision even when a driver truncates at NUL.
    if (identity[`${column}_has_nul`] || String(label || '').includes('\0')) {
      index[damagedRegistry] = true;
      // Keep its visible text out of lookup, but remember it so it can never
      // leave a colliding registered name looking unique.
      for (const visible of new Set([String(label || ''), String(label || '').split('\0')[0]])) {
        const key = normalizeMerchantText(visible);
        if (!key) continue;
        if (!index[damagedSpellings].has(key)) index[damagedSpellings].set(key, new Set());
        index[damagedSpellings].get(key).add(identity.entity_slug);
      }
      continue;
    }
    const key = normalizeMerchantText(label);
    if (!key) continue;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(identity.entity_slug);
    const spelling = normalizePayerQuestion(label);
    if (!index[questionSpellings].has(spelling)) index[questionSpellings].set(spelling, new Set());
    index[questionSpellings].get(spelling).add(identity.entity_slug);
    if (normalizePayerCommas(label).normalize('NFKC').includes(',')) index[companyCommaSpellings].add(companyCommaKey(label));
  }
  return index;
}

export function lookupPayer(label, registry) {
  const slugs = registry.get(normalizeMerchantText(label));
  if (!slugs) {
    const phrase = registry[questionPhrases]?.get(normalizeMerchantText(label));
    return phrase && phraseCommaMatches(label, phrase.label) ? { state: 'unique', slug: phrase.slug, query_only: true } : { state: 'missing' };
  }
  return slugs.size === 1 && !payerKeyDamaged(registry, label) ? { state: 'unique', slug: slugs.values().next().value }
    : { state: 'ambiguous' };
}

// Match the same normalized tokens as bank rows, retaining source offsets for
// clause coverage. Punctuation cannot change identity or erase a clause tail.
export function requestedPayerMentions(question, registry) {
  const text = normalizePayerQuestion(question), mentions = [];
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+|&/gu)];
  for (const [label, slugs] of registry[questionSpellings] || []) {
    const words = normalizeMerchantText(label).split(' ');
    for (let i = 0; i + words.length <= tokens.length; i++) {
      if (!words.every((word, j) => tokens[i + j][0] === word)) continue;
      const last = tokens[i + words.length - 1];
      let start = tokens[i].index, end = last.index + last[0].length;
      // Literal names can begin with punctuation, including a currency sign.
      // Keep that registered boundary just as we keep trailing punctuation.
      const leading = label.match(/^[^\p{L}\p{N}&]+/u)?.[0];
      if (leading && text.slice(0, start).endsWith(leading)) start -= leading.length;
      const trailing = label.match(/[^\p{L}\p{N}&]+$/u)?.[0];
      if (trailing && text.slice(end).startsWith(trailing)) end += trailing.length;
      // Combining marks and underscores remain word boundaries that cannot
      // disappear into a normalized mention of a different complete spelling.
      if (/[\p{L}\p{N}\p{M}_]/u.test(text[start - 1] || '') ||
          /[\p{L}\p{N}\p{M}_]/u.test(text[end] || '')) continue;
      mentions.push({ start, end, label, slugs });
    }
  }
  // Strict containment removes only a smaller complete registered spelling.
  // Equal spans retain every slug; disjoint and partial overlaps all survive.
  mentions.sort((a, b) => a.start - b.start || b.end - a.end);
  let furthest = -1, containingStart = -1;
  return mentions.filter(mention => {
    if (mention.end < furthest || (mention.end === furthest && mention.start > containingStart)) return false;
    if (mention.end > furthest) { furthest = mention.end; containingStart = mention.start; }
    return true;
  });
}

function clausePayerMentions(intent, registry) {
  const clauses = [...(intent.payerReadings || []).filter(r => r.complete), ...(intent.payerClauseSets || []).flat()];
  return requestedPayerMentions(intent.payerQuestion?.text, registry).filter(m =>
    clauses.some(r => m.start < r.end && m.end > r.start));
}

// The extra lookup is a hypothesis for this answer, never a registered entity.
// It has no authority until a structured field or a complete sender parse
// equals it. Keep it separate from the Map so ordinary row/group attribution
// and registered-name conflicts retain their original authority boundary.
export function payerQuestionRegistry(intent, registry) {
  // A driver may hide the entire damaged spelling, so we cannot prove which
  // phrase conflicts with it. Valid registered aliases still work normally.
  if (registry[damagedRegistry]) return registry;
  if (clausePayerMentions(intent, registry).length) return registry;
  if (intent.payerQuestion?.unsupportedPunctuation) return registry;
  const phrases = new Map();
  for (const reading of intent.payerReadings || []) {
    const key = normalizeMerchantText(reading.label);
    if (key && !phrases.has(key)) phrases.set(key, { slug: Symbol(key), label: reading.label });
  }
  if (!phrases.size) return registry;
  const scoped = new Map(registry);
  scoped[questionPhrases] = phrases;
  scoped[questionSpellings] = registry[questionSpellings];
  scoped[companyCommaSpellings] = new Set(registry[companyCommaSpellings]);
  for (const reading of intent.payerReadings) if (normalizePayerCommas(reading.label).includes(','))
    scoped[companyCommaSpellings].add(companyCommaKey(reading.label));
  return scoped;
}

export function resolveRequestedPayer(intent, registry, attributions = []) {
  const mentions = clausePayerMentions(intent, registry);
  const slugs = new Set(mentions.flatMap(mention => [...mention.slugs]));
  const candidates = [...new Set(mentions.map(mention => mention.label))];
  if (slugs.size > 1 || mentions.some(mention => payerKeyDamaged(registry, mention.label))) return { state: 'ambiguous', candidates };
  if (!slugs.size) {
    const supported = new Map();
    for (const attribution of attributions) for (const phrase of attribution.evidence.query_phrases || [])
      supported.set(normalizeMerchantText(phrase.identity), phrase);
    if (supported.size > 1) return { state: 'ambiguous', candidates: [...supported.values()].map(p => p.identity) };
    if (supported.size === 1) {
      const [key, phrase] = supported.entries().next().value;
      const spans = (intent.payerReadings || []).filter(r => Number.isInteger(r.start) && normalizeMerchantText(r.label) === key);
      if (payerMentionsCoverQuestion(intent, spans)) return { state: 'unique', slug: phrase.slug,
        registered: false, candidates: [phrase.identity] };
    }
  }
  // No known name, or an uncovered remainder, cannot prove presence, absence
  // or zero even when all stored receipts have independently confirmed payers.
  if (!slugs.size || !payerMentionsCoverQuestion(intent, mentions)) return { state: 'unresolved',
    candidates: candidates.length ? candidates : [intent.match || intent.counterparty].filter(Boolean) };
  return { state: 'unique', slug: slugs.values().next().value, candidates };
}

// One closed grammar owns both the alphabet and every supported production.
// Line breaks become field separators, never spaces inside a name. Validate
// BEFORE NFKC or trimming so every other control/format character stays invalid.
// Compile the tables once; only parser state and answer caches are per request.
const statementGrammar = (() => {
  const vocabulary = new Set();
  // Every literal grammar word enters the vocabulary while its production is
  // compiled. There is no separate query-only denylist to drift from parsing.
  const words = (...phrases) => {
    for (const phrase of phrases) for (const token of normalizeMerchantText(phrase).split(' ')) vocabulary.add(token);
    return `(?:${phrases.map(phrase => phrase.replaceAll(' ', ' +')).join('|')})`;
  };
  const pattern = source => new RegExp(source, 'iu');
  const channel = words('ach', 'eft', 'wire', 'zelle', 'bank');
  const channelAction = words('credit', 'transfer', 'payment', 'deposit');
  const bareChannel = words('payment', 'deposit', 'receipt', 'transfer');
  const bareSender = words('from', 'by');
  const sender = words('from', 'by', 'orig co name', 'originator name', 'originator', 'sender name', 'sender');
  const suffixChannel = words('ach', 'eft', 'wire', 'zelle');
  const suffix = words('deposit', 'payment', 'receipt', 'payroll', 'settlement');
  const reference = words('reference', 'ref');
  const forWord = words('for'), invoice = words('invoice');
  const caps = { codepoints: 512, fields: 12, parses: 64 };
  const grammar = {
    // Each candidate end costs one bounded operation (at most 512 code
    // points). The parse cap bounds branching; the answer ceiling is the
    // field/parse product of row budgets, shared by all descriptions.
    limits: Object.freeze({ ...caps, steps: caps.codepoints * caps.parses,
      answerSteps: caps.codepoints * caps.parses * caps.fields * caps.parses }),
    alphabet: /^[\p{L}\p{N}\p{M} &'()._/:#;,|\-\r\n\u0085\u2028\u2029]*$/u,
    lineBreak: /\r\n|[\r\n\u0085\u2028\u2029]/g,
    edgeSpaces: /^[ \r\n\u0085\u2028\u2029]+|[ \r\n\u0085\u2028\u2029]+$/g,
    companySuffix: /^(?:llc|llp|lp|inc|ltd|corp|corporation|co|company|plc|pc|pa|na|sa)\.?$/i,
    spaces: / +/g,
    fieldBoundary: /[;,|]/,
    name: /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &'()._/:#,\-]*$/u,
    separator: /^[ ]*(?:[;,|][ ]*)?/,
    channel: pattern(`^(?:${channel}(?: +${channelAction})?|${bareChannel}) +`),
    sender: pattern(`^(?:${sender} *: *|${bareSender} +)`),
    suffix: pattern(`^(?:${suffixChannel} +)?${suffix}$`),
    metadata: Object.freeze([
      [pattern(`^${words('orig id', 'co id', 'company id', 'individual id', 'ind id')} *(?:# *:?|:) *`), /^[\p{L}\p{N}]+(?:[./-][\p{L}\p{N}]+)*$/u],
      [pattern(`^${words('trace number', 'trace no', 'trace', 'trn')} *(?:# *:?|:) *`), /^[0-9]{1,34}$/],
      [pattern(`^${words('desc date', 'effective date', 'eff date', 'entry date', 'settlement date')} *: *`), validStatementDate],
      [pattern(`^${words('co entry descr', 'entry descr')} *: *`), pattern(`^${words('payment', 'deposit', 'receipt', 'payroll', 'settlement', 'credit', 'transfer')}$`)],
      [pattern(`^${words('sec')} *: *`), pattern(`^${words('ACK', 'ADV', 'ARC', 'ATX', 'BOC', 'CCD', 'CIE', 'COR', 'CTX', 'DNE', 'ENR', 'IAT', 'MTE', 'POP', 'POS', 'PPD', 'RCK', 'SHR', 'TEL', 'TRC', 'WEB', 'XCK')}$`)],
      [pattern(`^${words('beneficiary', 'individual id/name', 'individual name', 'ind name')} *: *`), /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &'()._/-]*$/u],
      [pattern(`^${words('reference', 'ref', 'invoice', 'memo')} *(?:# *:?|:) *`), pattern(String.raw`^(?:${invoice} +)?[\p{L}\p{N}]+(?:[./-][\p{L}\p{N}]+)*$`)],
    ].map(Object.freeze)),
    dates: Object.freeze({ short: /^[0-9]{6}$/, compact: /^[0-9]{8}$/,
      iso: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, slash: /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/ }),
    // Legacy unlabelled reference/invoice prose is a complete terminal field,
    // available only after a bare sender label, never after a colon-labelled one.
    prose: pattern(String.raw`^(?:(?:${reference}|${forWord} +${invoice}) +[0-9]+(?:[./-][0-9]+)*|${forWord} +[\p{L}\p{N}]+(?: +[\p{L}\p{N}]+)* +${invoice})$`),
  };
  return Object.freeze({ ...grammar, vocabulary: Object.freeze([...vocabulary].sort()) });
})();

export const ledgerStatementVocabulary = statementGrammar.vocabulary;
export const ledgerAttributionLimits = statementGrammar.limits;
const statementVocabulary = new Set(ledgerStatementVocabulary);

function validStatementDate(value) {
  let year, month, day;
  if (statementGrammar.dates.short.test(value)) {
    year = 2000 + Number(value.slice(0, 2)); month = Number(value.slice(2, 4)); day = Number(value.slice(4));
  } else if (statementGrammar.dates.compact.test(value)) {
    year = Number(value.slice(0, 4)); month = Number(value.slice(4, 6)); day = Number(value.slice(6));
  } else if (statementGrammar.dates.iso.test(value)) {
    [year, month, day] = value.split('-').map(Number);
  } else if (statementGrammar.dates.slash.test(value)) {
    [month, day, year] = value.split('/').map(Number);
  } else return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function decision(readings, source) {
  const resolved = readings.filter(r => r.payer.state === 'unique');
  const slugs = new Set(resolved.map(r => r.payer.slug));
  const evidence = { source, ambiguous: slugs.size > 1 || readings.some(r => r.payer.state === 'ambiguous'),
    candidates: [...new Set(readings.map(r => r.identity))] };
  const phrases = readings.filter(r => r.payer.query_only).map(r => ({ identity: r.identity, slug: r.payer.slug }));
  if (phrases.length) evidence.query_phrases = phrases;
  if (resolved.length !== readings.length || slugs.size !== 1)
    return { state: 'unknown', entity_slug: null, reading: null, evidence };
  // Distinct aliases of a single entity do not create competing payers.
  const reading = readings.find(r => !r.suffix && !r.prefix) || readings[0];
  return { state: reading.suffix || reading.prefix ? 'assumed' : reading.payer.query_only ? 'observed' : 'confirmed', entity_slug: reading.payer.slug,
    reading: { identity: reading.identity, ...(reading.suffix ? { suffix: reading.suffix } : {}),
      ...(reading.prefix ? { prefix: reading.prefix } : {}), ...(reading.payer.query_only ? { query_only: true } : {}) }, evidence };
}

function parseStatement(description, registry, statementCache, budget) {
  const grammar = statementGrammar, limit = grammar.limits;
  const parser = { steps: 0, parses: 0, fields: 0, complete: false, refusal: null };
  let normalizedText;
  const stopped = Symbol('parser budget');
  const refuse = reason => { parser.refusal = reason; throw stopped; };
  function step(work = 1) {
    const rowLimit = budget?.stepLimit ?? limit.steps;
    if (budget && work > budget.remaining) { budget.remaining = 0; refuse('answer-operation-limit'); }
    if (budget) budget.remaining -= work;
    if (work > rowLimit - parser.steps) { parser.steps = rowLimit; refuse('operation-limit'); }
    parser.steps += work;
  }
  function bounded(text) {
    step();
    // The cheap UTF-16 bound also refuses huge strings before scanning them.
    if (text.length > limit.codepoints * 2) refuse('length-limit');
    let count = 0;
    for (const char of text) { step(); if (++count > limit.codepoints) refuse('length-limit'); }
    if (!grammar.alphabet.test(normalizePayerCommas(text)) || /\p{Default_Ignorable_Code_Point}/u.test(text)) refuse('alphabet');
  }
  try {
    bounded(description);
    const text = normalizePayerCommas(description).replace(grammar.edgeSpaces, '').replace(grammar.lineBreak, ';').normalize('NFKC');
    bounded(text);
    if (/\p{M}/u.test(text)) refuse('alphabet');
    normalizedText = text;
    // Validate the raw input on every row, including SQLite's NUL flag, before
    // reusing a normalized decision. A cache hit cannot legalize forbidden text
    // or erase an over-cap input through normalization or trimming.
    if (statementCache?.has(text)) return statementCache.get(text);
    const cache = new Map(), lookups = new Map(), fieldStarts = new Map();
    function lookup(identity) {
      if (!lookups.has(identity)) { step(); lookups.set(identity, lookupPayer(identity, registry)); }
      return lookups.get(identity);
    }
    function match(pattern, start) { step(); return pattern.exec(text.slice(start)); }
    function add(results, parse) {
      step();
      if (parse.fields > limit.fields) refuse('field-limit');
      if (results.length >= limit.parses) refuse('parse-limit');
      results.push(parse);
    }
    // Endpoints are lexical boundaries in the positive grammar. A name may
    // contain a field word or colon, so every complete segmentation survives.
    function ends(start, companyComma = false) {
      const out = [];
      for (let end = start; end <= text.length; end++) {
        step();
        if (end === text.length || grammar.fieldBoundary.test(text[end])) {
          if (end > start && text[end - 1] !== ' ') out.push(end);
          if (!companyComma || text[end] !== ',') break;
        }
        if (text[end] === ' ' && end > start && text[end - 1] !== ' ') out.push(end);
      }
      return out;
    }
    function name(start, allowSuffix, allowProse, prefix = null, labelled = false) {
      const results = [];
      for (const end of ends(start, true)) {
        const identity = text.slice(start, end);
        step();
        if (!grammar.name.test(identity)) continue;
        let boundaryOnly = false;
        // A comma can belong to a complete name, alongside its field-boundary
        // readings. A query match is only a hypothesis here; complete competing
        // segmentations below must not split it into multiple explicit fields.
        if (identity.includes(',')) {
          step();
          const parts = identity.split(',');
          const completeParts = parts.every(part => normalizeMerchantText(part));
          const phrase = registry[questionPhrases]?.get(normalizeMerchantText(identity));
          const phraseMatch = phrase && phraseCommaMatches(identity, phrase.label);
          if (!registry[companyCommaSpellings]?.has(companyCommaKey(identity)) && !phraseMatch) {
            if ((!registry[questionPhrases] && !phraseCommaMatches(identity, identity)) || !completeParts) continue;
            // A competing unknown company name still supplies a complete
            // field segmentation. Keep its boundaries without granting it
            // identity authority or requiring it to match the question first.
            boundaryOnly = true;
          }
        }
        for (const tail of rest(end, allowSuffix, allowProse)) {
          let payer = boundaryOnly ? { state: 'missing' } : lookup(identity);
          // Query-only presence needs a labelled sender or closed shorthand.
          // Shorthand remains assumed, with its note and exact-name flip; its
          // identity tokens still cannot overlap this grammar's vocabulary.
          if (payer.query_only && ((!labelled && !prefix && !tail.suffix) ||
              normalizeMerchantText(identity).split(' ').some(token => statementVocabulary.has(token))))
            payer = { state: 'missing' };
          add(results, { readings: [{ identity, payer, start, end, labelled, ...(prefix ? { prefix } : {}),
            ...(tail.suffix ? { suffix: tail.suffix } : {}) }, ...tail.readings], fields: 1 + tail.fields });
        }
      }
      return results;
    }
    function senders(start, optional, allowBare = true) {
      const results = [], openings = [start];
      const channel = match(grammar.channel, start);
      if (channel) openings.push(start + channel[0].length);
      for (const opening of openings) {
        if (optional) for (const parse of name(opening, opening === start, false,
          opening === start ? null : channel[0].trim().toLowerCase().replace(grammar.spaces, ' '))) add(results, parse);
        const label = match(grammar.sender, opening);
        if (label && !optional) fieldStarts.set(opening, opening + label[0].length);
        if (label && (allowBare || label[0].includes(':'))) for (const parse of name(opening + label[0].length, false, !label[0].includes(':'), null, true))
          add(results, parse);
      }
      return results;
    }
    function rest(start, allowSuffix = false, allowProse = false) {
      const key = `${start}:${allowSuffix}:${allowProse}`;
      if (cache.has(key)) return cache.get(key);
      step();
      const results = [];
      cache.set(key, results);
      if (start === text.length) {
        add(results, { readings: [], fields: 0 }); return results;
      }
      const separator = match(grammar.separator, start)[0];
      if (!separator.length) return results;
      const next = start + separator.length;
      // No dangling delimiter, empty value or arbitrary trailing prose.
      if (next === text.length) return results;
      const remainder = text.slice(next);
      if (separator.trim() === '') {
        if (allowSuffix && grammar.suffix.test(remainder)) add(results, { readings: [], fields: 0, suffix: remainder.toLowerCase().replace(grammar.spaces, ' ') });
        if (allowProse && grammar.prose.test(remainder)) {
          fieldStarts.set(next, next + remainder.length);
          add(results, { readings: [], fields: 1 });
        }
      }
      for (const [label, shape] of grammar.metadata) {
        const field = match(label, next);
        if (!field) continue;
        // A malformed or empty value still starts a field. It cannot become
        // part of an unregistered sender merely because validation fails.
        fieldStarts.set(next, next + field[0].length);
        const valueStart = next + field[0].length;
        for (const end of ends(valueStart)) {
          const value = text.slice(valueStart, end);
          step();
          if (!(typeof shape === 'function' ? shape(value) : shape.test(value))) continue;
          for (const tail of rest(end)) add(results, { readings: tail.readings, fields: 1 + tail.fields });
        }
      }
      for (const parse of senders(next, false, separator.trim() !== '')) add(results, parse);
      return results;
    }
    let parses = senders(0, true);
    parser.parses = parses.length;
    parser.fields = Math.max(0, ...parses.map(parse => parse.fields));
    parser.complete = parses.length > 0;
    if (!parser.complete) parser.refusal = 'incomplete';
    if (registry[questionPhrases]) {
      // Record boundaries before validating values or completing the tail.
      // Damaging a field must never increase query-only identity authority.
      // Registered whole names keep their independent authority. Structured
      // payees use their own lookup, then check these labelled senders.
      parses = parses.map(parse => {
        const resolved = parse.readings.length === 1 && parse.readings.every(reading => reading.payer.state === 'unique');
        return { ...parse, readings: parse.readings.map(reading => {
          if (!reading.payer.query_only) return reading;
          for (const start of fieldStarts.keys()) {
            step();
            if (start > reading.start && start < reading.end)
              return { ...reading, payer: { state: 'missing' } };
          }
          // The matching field needs its own fully resolved parse. Filtering
          // only at the final decision would leak rejected query evidence to
          // the requested-payer resolver, including from unresolved senders.
          return resolved ? reading : { ...reading, payer: { state: 'missing' } };
        }) };
      });
    }
    // Missing *alternative* names do not erase a registered whole name. But
    // at least one complete reading must resolve EVERY sender field. A known
    // sender followed by an unknown sender therefore cannot certify absence.
    const coherent = parses.some(parse => parse.readings.every(reading => reading.payer.state === 'unique'));
    const readings = parses.flatMap(parse => parse.readings).filter(reading => reading.payer.state !== 'missing');
    // Distinct complete labelled sender readings cannot be resolved by
    // discarding the unknown alternative. Preserve exact registered whole-name
    // authority over an unlabelled lexical alternative, but never over another
    // explicit sender field. Query evidence must obey this guard too.
    const labelledSenders = parses.flatMap(parse => parse.readings.filter(r => r.labelled &&
      // Swallowing an entire later label is not another sender value. A name
      // ending inside an overlapping label is a real alternative (Co Entry
      // Descr versus Entry Descr), and must still participate in agreement.
      ![...fieldStarts].some(([start, end]) => start > r.start && end <= r.end)));
    const senderKeys = new Set(labelledSenders.map(r => JSON.stringify(r.payer.state === 'unique' && !r.payer.query_only
        ? ['entity', r.payer.slug] : ['name', normalizeMerchantText(r.identity)])));
    const result = decision(readings, 'description');
    if (senderKeys.size > 1) {
      result.state = 'unknown'; result.entity_slug = null; result.reading = null;
      delete result.evidence.query_phrases;
    }
    if (!coherent) { result.state = 'unknown'; result.entity_slug = null; result.reading = null; }
    result.evidence.parser = parser;
    // Keep unknown complete sender fields for agreement with a structured
    // payee. Filtering them out here would turn a contradiction into absence.
    result.evidence.labelled_senders = labelledSenders.map(({ identity, payer }) => ({ identity, payer }));
    // Every reading this parser rates confirmed on its own (a unique
    // registered whole name, no shorthand affix, not a question-only phrase),
    // labelled or not. A structured payee must agree with each one; an
    // unlabelled opening name is not discarded merely because a payee exists.
    result.evidence.confirmed_readings = readings.filter(reading => reading.payer.state === 'unique' &&
      !reading.payer.query_only && !reading.suffix && !reading.prefix).map(({ identity, payer }) => ({ identity, payer }));
    // Shorthand readings (a closed channel before and/or a closed suffix after
    // a resolved name) never confirm a payer. Beside a payee, one that names
    // another registered entity joins the agreement check (R4-MONEY-3), and
    // an unknown row that names the requested payer in shorthand stays a
    // listed possible match for it (R4-MONEY-4), so neither name gets a
    // certified zero or absence.
    const shorthand = readings.filter(reading => reading.payer.state === 'unique' && (reading.suffix || reading.prefix))
      .map(({ identity, payer, prefix, suffix }) => ({ identity, payer, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) }));
    // The grammar admits a suffix only after an opening name, so the closed
    // form "<channel> <name> <suffix>" has no reading. Read it here as well.
    const head = match(grammar.channel, 0);
    if (head) for (let end = head[0].length; end < text.length; end++) {
      step();
      if (text[end] !== ' ' || !grammar.suffix.test(text.slice(end + 1))) continue;
      const identity = text.slice(head[0].length, end);
      if (!grammar.name.test(identity)) continue;
      const payer = lookup(identity);
      if (payer.state === 'unique') shorthand.push({ identity, payer, prefix: head[0].trim().toLowerCase().replace(grammar.spaces, ' '),
        suffix: text.slice(end + 1).toLowerCase().replace(grammar.spaces, ' ') });
    }
    result.evidence.shorthand_readings = shorthand;
    statementCache?.set(text, result);
    return result;
  } catch (error) {
    if (error !== stopped) throw error;
    const result = { state: 'unknown', entity_slug: null, reading: null,
      evidence: { source: 'description', ambiguous: false, candidates: [], parser } };
    if (normalizedText !== undefined && parser.refusal === 'operation-limit') statementCache?.set(normalizedText, result);
    return result;
  }
}

function attributeRow(row, registry, statementCache, budget) {
  // A damaged structured payee must not fall through to a description, even
  // if the returned payee is empty or a description cache already has a hit.
  if (row.payee_has_nul || String(row.payee || '').includes('\0'))
    return decision([], 'payee');
  // Some SQLite clients truncate TEXT at NUL. The SQL flag preserves the
  // alphabet refusal even when the returned string has lost that character.
  const statement = parseStatement(String(row.description || '') + (row.description_has_nul ? '\0' : ''), registry, statementCache, budget);
  if (!row.payee) return statement;
  const payee = { identity: row.payee, payer: lookupPayer(row.payee, registry) };
  // A description the parser refused for its own reason (length, alphabet,
  // operation, field or parse limit) may carry a labelled sender that
  // disagrees with the payee. Unread text cannot corroborate the payee, so
  // the row is unknown. A grammar nonmatch ('incomplete') means only that no
  // COMPLETE parse survived: a labelled sender followed by any field the
  // closed grammar cannot consume ("FROM: X; ID: 1") is read and then
  // discarded with its parse. So 'incomplete' lets the payee stand only when
  // no field start carries a sender label at all. So does a description that
  // is exactly the payee, optionally after one sender label: it cannot name
  // anyone else. A NUL-flagged description is never that: a truncating
  // driver may have returned only the visible prefix, and the tail is unread.
  const refusal = statement.evidence.parser?.refusal;
  // Answer 4 also reaches a bare registered name at a field start whose tail
  // the grammar cannot read ("Vendor Beta; ID: 123", "Vendor Beta REF 100000"):
  // it would be a confirmed reading had the tail parsed, so an unread tail
  // cannot let the payee stand over it (round 4, R4-MONEY-2).
  const foreignStart = (!refusal || refusal === 'incomplete') && !row.description_has_nul
    ? fieldStartReading(row.description, payee, registry) : null;
  if (refusal && (refusal !== 'incomplete' || senderLabelPresent(row.description) || foreignStart) &&
      (row.description_has_nul || !descriptionIsPayee(row.description, row.payee))) {
    const result = decision([], 'payee');
    result.state = 'unknown'; result.entity_slug = null; result.reading = null;
    result.evidence.ambiguous = false;
    result.evidence.parser = statement.evidence.parser;
    result.evidence.sender_unread = true;
    return result;
  }
  const shorthand = statement.evidence.shorthand_readings || [];
  const senders = statement.evidence.labelled_senders || [];
  // The agreement check covers every reading the parser rates confirmed,
  // labelled or not. A disagreeing confirmed reading makes the row unknown.
  // Agreement with an unlabelled reading never adds authority beyond the payee.
  // A shorthand reading (closed channel or suffix) that resolves to a
  // registered entity other than the payee's joins the check too (round 4,
  // R4-MONEY-3, option A): the statement line names another registered payer,
  // so the payee cannot stand for either name. Same-entity shorthand agrees.
  const registered = reading => reading.payer.state === 'unique' && !reading.payer.query_only;
  const fieldStart = foreignStart ? [foreignStart] : [];
  const compared = [...senders, ...(statement.evidence.confirmed_readings || []), ...fieldStart,
    ...foreignShorthandReadings(row, shorthand, payee.payer.state === 'unique' && !payee.payer.query_only ? payee.payer.slug : null)];
  const conflict = new Set([payee, ...compared].filter(registered).map(reading => reading.payer.slug)).size > 1 || compared.some(sender => {
    if ([payee, sender].some(reading => reading.payer.state === 'ambiguous')) return true;
    // Distinct registered identities cannot merge through suffix removal.
    if (registered(payee) && registered(sender)) return payee.payer.slug !== sender.payer.slug;
    const key = agreementName(payee.identity);
    return !key || key !== agreementName(sender.identity);
  });
  if (conflict) {
    const result = decision([payee, ...compared], 'payee');
    result.state = 'unknown'; result.entity_slug = null; result.reading = null;
    result.evidence.ambiguous = true;
    delete result.evidence.query_phrases;
    result.evidence.parser = statement.evidence.parser;
    result.evidence.labelled_senders = senders;
    result.evidence.confirmed_readings = statement.evidence.confirmed_readings || [];
    result.evidence.shorthand_readings = shorthand;
    if (fieldStart.length) result.evidence.field_start_readings = fieldStart;
    return result;
  }
  // Equal fields corroborate an existing registration or a question-local
  // presence hypothesis. They never create registration for an unknown name.
  const agreed = [payee, ...senders].find(registered) ||
    // A comma can also yield a shorter question reading. Prefer the complete
    // matching spelling so agreement cannot discard the rest of that clause.
    [payee, ...senders].filter(reading => reading.payer.state === 'unique')
      .sort((a, b) => normalizeMerchantText(b.identity).length - normalizeMerchantText(a.identity).length)[0] || payee;
  const result = decision([agreed], agreed === payee ? 'payee' : 'description');
  // Parsing may exhaust the answer budget even when the bank supplies a name.
  // Preserve that signal so no answer kind can certify a complete figure.
  result.evidence.parser = statement.evidence.parser;
  result.evidence.labelled_senders = senders;
  result.evidence.confirmed_readings = statement.evidence.confirmed_readings || [];
  result.evidence.shorthand_readings = shorthand;
  return result;
}

// Shorthand readings (a closed channel before and/or a closed suffix after a
// resolved name) that resolve to a registered entity other than the payee's
// (R4-MONEY-3, option A). A description that is the payee itself, or a
// shorthand whose spelled-out text is the payee's name ("Payer One payment"
// beside payee "Payer One payment"), names nobody else and is left out.
function foreignShorthandReadings(row, shorthand, payeeSlug) {
  if (!row.payee || descriptionIsPayee(row.description, row.payee)) return [];
  const payeeKey = agreementName(row.payee);
  return shorthand.filter(reading => reading.payer.state === 'unique' && !reading.payer.query_only &&
    reading.payer.slug !== payeeSlug &&
    ![[reading.prefix, reading.identity, reading.suffix], [reading.identity, reading.suffix], [reading.prefix, reading.identity]]
      .some(parts => payeeKey && agreementName(parts.filter(Boolean).join(' ')) === payeeKey));
}

// The bare registered name at a field start (the opening or the text after a
// field delimiter, optionally after a closed channel there), read whatever
// follows it: the LONGEST whole-word run from that start that is either the
// payee's own name or a registered name decides. Returns that run as a
// reading when it is ambiguous or names a registered entity other than the
// payee's, else null. A shorter registered prefix of a run that is the payee
// ("Vendor Alpha" inside "Vendor Alpha Holdings ID 1") never conflicts.
// Called only for a description the parser read within its code point cap.
function fieldStartReading(description, payee, registry) {
  const grammar = statementGrammar;
  const text = normalizePayerCommas(String(description || '')).replace(grammar.edgeSpaces, '')
    .replace(grammar.lineBreak, ';').normalize('NFKC');
  if (!text || text.length > grammar.limits.codepoints * 2) return null;
  const payeeKey = agreementName(payee.identity);
  const verdict = identity => {
    if (payeeKey && agreementName(identity) === payeeKey) return false;
    const found = lookupPayer(identity, registry);
    if (found.state === 'ambiguous') return { identity, payer: found };
    if (found.state !== 'unique' || found.query_only) return null;
    if (payee.payer.state === 'unique' && !payee.payer.query_only && payee.payer.slug === found.slug) return false;
    return { identity, payer: found };
  };
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (grammar.fieldBoundary.test(text[index])) starts.push(index + 1);
  for (const boundary of starts) {
    const start = boundary + text.slice(boundary).match(/^ */)[0].length;
    const channel = grammar.channel.exec(text.slice(start));
    for (const opening of channel ? [start, start + channel[0].length] : [start]) {
      let decided = null;
      for (let end = opening + 1; end <= text.length; end++) {
        const fieldEnd = end === text.length || grammar.fieldBoundary.test(text[end]);
        if (!fieldEnd && text[end] !== ' ') continue;
        const identity = text.slice(opening, end).replace(/ +$/, '');
        if (identity && grammar.name.test(identity)) {
          const found = verdict(identity);
          if (found !== null) decided = found;
        }
        if (fieldEnd) break;
      }
      if (decided) return decided;
    }
  }
  return null;
}

// Sticky copies of the anchored sender and channel productions, so one scan
// over the bounded text tests each field start without slicing.
const stickySender = new RegExp(statementGrammar.sender.source.replace(/^\^/, ''), 'iuy');
const stickyChannel = new RegExp(statementGrammar.channel.source.replace(/^\^/, ''), 'iuy');

// Over-approximates every position where parseStatement() tries a sender
// label: the opening (optionally after a channel) and every later field
// start. A bare label (FROM, BY) counts after a delimiter; after spaces
// alone only a colon label does, exactly as rest() allows. Called only for a
// description the parser already bounded (refusal 'incomplete'), so the
// text is at most the code point cap.
function senderLabelPresent(description) {
  const grammar = statementGrammar;
  const text = normalizePayerCommas(String(description || '')).replace(grammar.edgeSpaces, '')
    .replace(grammar.lineBreak, ';').normalize('NFKC');
  const labelAt = (position, allowBare) => {
    stickySender.lastIndex = position;
    const label = stickySender.exec(text);
    return Boolean(label) && (allowBare || label[0].includes(':'));
  };
  let delimited = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === ' ' || grammar.fieldBoundary.test(char)) {
      if (char !== ' ') delimited = true;
      continue;
    }
    const previous = index === 0 ? null : text[index - 1];
    if (index === 0 || previous === ' ' || grammar.fieldBoundary.test(previous)) {
      if (labelAt(index, delimited)) return true;
      stickyChannel.lastIndex = index;
      const channel = stickyChannel.exec(text);
      if (channel && labelAt(index + channel[0].length, delimited)) return true;
    }
    delimited = false;
  }
  return false;
}

// Partner ruling 9 (round 7, R5-FIDELITY-2): "The payee field still decides
// who paid. But for the OTHER payer named in full in an unlabelled
// description (Beta), never certify absence or $0: answer it as a possible
// match, not complete. Alpha's attribution is unchanged. Bare names only;
// "for <name> invoice" prose counts too." True when, beside a bounded payee,
// a description with no sender label at any field start carries a complete
// registered spelling of `slug` as whole words (prose such as "for <name>
// invoice" included), outside the payee's own name and not inside a longer
// registered name. The row's attribution is not changed here; the answer
// lists the row as a possible match for that entity only. A labelled
// description ("from <sender> for <name> invoice") names its sender, as the
// committed triage-0417-money pins C17/C18/PM02/PM03 keep, and outflow
// merchants keep money-rereview R02.
// `spellings` are the entity's registered spellings (normalized keys); a
// description holding none of them as whole words skips the full scan.
export function descriptionNamesPayer(row, registry, slug, spellings = null) {
  if (!slug || typeof slug === 'symbol' || !row.payee || row.payee_has_nul || String(row.payee).includes('\0')) return false;
  const description = String(row.description || '');
  if (!description || row.description_has_nul || description.includes('\0') ||
      description.length > statementGrammar.limits.codepoints * 2) return false;
  const descriptionKey = ` ${normalizeMerchantText(description)} `;
  const entitySpellings = spellings || [...registry].filter(([, slugs]) => slugs.has(slug)).map(([key]) => key);
  if (!entitySpellings.some(key => key && descriptionKey.includes(` ${key} `)) || senderLabelPresent(description)) return false;
  const mentions = requestedPayerMentions(description, registry).filter(mention => mention.slugs.has(slug));
  if (!mentions.length) return false;
  // Occurrences of the payee's own name: a registered name inside it is the
  // payee's name, never a second payer.
  const text = normalizePayerQuestion(description);
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+|&/gu)];
  const words = normalizeMerchantText(row.payee).split(' ').filter(Boolean);
  const own = [];
  for (let i = 0; words.length && i + words.length <= tokens.length; i++) {
    if (!words.every((word, j) => tokens[i + j][0] === word)) continue;
    const last = tokens[i + words.length - 1];
    own.push([tokens[i].index, last.index + last[0].length]);
  }
  return mentions.some(mention => !own.some(([start, end]) => start <= mention.start && mention.end <= end));
}

function descriptionIsPayee(description, payee) {
  const text = String(description || ''), name = String(payee || '');
  // The comparison is linear, but stays inside the same order of size as the
  // parser cap so refused huge inputs are not rescanned.
  if (!text || !name || text.length > statementGrammar.limits.codepoints * 4) return false;
  const trimmed = text.trim();
  const unlabelled = trimmed.replace(statementGrammar.sender, '');
  const key = normalizeMerchantText(name);
  return Boolean(key) && [trimmed, unlabelled].some(value => normalizeMerchantText(value) === key);
}

// EXACT agreement between two bounded payer fields: equal normalized names
// after one closed trailing company suffix is removed (R4B). A name that is
// only a suffix agrees with nothing.
export function payerFieldsAgree(left, right) {
  const key = agreementName(left);
  return Boolean(key) && key === agreementName(right);
}

// A bounded field that shares a requested name without equalling it: the two
// agree only after one closed company suffix is removed, the field extends
// the requested name with whole words (trailing, leading or around it), or
// the field is a shorter whole-word run of it, leading, trailing or inner
// (each read with and without the requested name's own closed suffix). Each
// is a shortened-name or substring match, so a possible match, never EXACT
// and never proof that the row is someone else (R4-MONEY-5). `labels` are
// every spelling of the requested entity, so all of its aliases decide alike.
// `longer: false` leaves out the field that only extends the name: on the
// outflow side an explicit longer payee is a different merchant identity
// (money-rereview R02), while a suffix or a shortened payee stays possible.
// Partner ruling 10 (round 7, R5-MONEY-4): a trailing or inner whole-word
// run ("Payer One" for "Acme Payer One", "Supply" for "Again Supply") is a
// possible match that blocks completeness, per the contract's "a shortened
// name, a substring", exactly like a leading one.
// Round 7 review (R7-MONEY-1, R7-QUESTION-1, R7-FIDELITY-1): on the inflow
// side the longer field is read by position-free whole-word containment, so
// "ACH Payer One", "Acme Payer One" and "Acme Payer One Holdings" are the
// same substring match for "Payer One" as "Payer One Holdings" (R4-MONEY-5):
// beside an exact row they stay listed and block completeness, as they
// already did alone.
export function payerNameVariant(field, labels, { longer = true } = {}) {
  const fieldKey = normalizeMerchantText(field), fieldBase = agreementName(field);
  if (!fieldKey) return false;
  return labels.some(label => {
    const key = normalizeMerchantText(label), base = agreementName(label);
    if (!key || fieldKey === key) return false;
    return Boolean(fieldBase && fieldBase === base) ||
      [key, base].some(name => name && ((longer && ` ${fieldKey} `.includes(` ${name} `)) ||
        ` ${name} `.includes(` ${fieldKey} `)));
  });
}

function agreementName(value) {
  const words = normalizeMerchantText(normalizePayerCommas(value)).split(' ');
  // Normalize punctuation before removing one closed suffix, so (Ltd.) and
  // dotted initials such as N.A. follow the same merchant key on both sides.
  for (let size = 1; size <= words.length; size++) {
    const tail = words.slice(-size);
    if (size > 1 && tail.some(word => word.length !== 1)) break;
    if (statementGrammar.companySuffix.test(tail.join(''))) {
      words.splice(-size); break;
    }
  }
  return words.join(' ');
}

export function attributeInflow(row, registry) {
  return attributeRow(row, registry);
}

// Bind to the immutable identity snapshot for exactly one answer. Neither the
// descriptions nor decisions survive the request. Payee agreement is row-local;
// consumers treat the cached statement as read-only and keep row data apart.
export function createInflowAttributionBudget({ stepLimit = ledgerAttributionLimits.steps,
  answerStepLimit = ledgerAttributionLimits.answerSteps } = {}) {
  const boundedLimit = (value, cap) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : 0;
  return { stepLimit: boundedLimit(stepLimit, ledgerAttributionLimits.steps),
    remaining: boundedLimit(answerStepLimit, ledgerAttributionLimits.answerSteps) };
}

export function createInflowAttributor(registry, { stepLimit = ledgerAttributionLimits.steps,
  answerStepLimit = ledgerAttributionLimits.answerSteps,
  budget = createInflowAttributionBudget({ stepLimit, answerStepLimit }) } = {}) {
  // Alternative selector readings have separate identity caches but spend the
  // same answer budget. Comparing names cannot multiply the parsing allowance.
  const statementCache = new Map();
  return row => attributeRow(row, registry, statementCache, budget);
}

// Literal-field existence is independent of final registry attribution. An
// unresolved or conflicted name remains competing evidence, never an empty
// field. Consume the already bounded parse without another parser pass.
export function boundedPayerFields(row, attribution, registry) {
  const senders = attribution.evidence.labelled_senders || [];
  const payee = row.payee && !row.payee_has_nul && !String(row.payee).includes('\0') ? [row.payee] : [];
  const fields = [...payee, ...senders.map(sender => sender.identity)];
  // Beside a payee, every reading the parser rates confirmed joins the same
  // agreement comparison attributeRow() makes. It competes; it never becomes a
  // literal field the question can match exactly.
  // So does a registered shorthand reading of an entity other than the
  // payee's (R4-MONEY-3, option A), exactly as attributeRow() compares it.
  const payeeSlugs = payee.length ? registry.get(normalizeMerchantText(payee[0])) : null;
  const foreignShorthand = payee.length ? foreignShorthandReadings(row, attribution.evidence.shorthand_readings || [],
    payeeSlugs?.size === 1 ? payeeSlugs.values().next().value : null).map(reading => reading.identity) : [];
  const compared = [...fields, ...(payee.length ? (attribution.evidence.confirmed_readings || []).map(reading => reading.identity) : []),
    ...foreignShorthand, ...(payee.length ? (attribution.evidence.field_start_readings || []).map(reading => reading.identity) : [])];
  // A refused description may hold a sender that disagrees with the payee,
  // so an unread statement is competing evidence, never agreement.
  return { fields, conflict: Boolean(row.payee_has_nul || String(row.payee || '').includes('\0') ||
    attribution.evidence.sender_unread || !boundedFieldsAgree(compared, registry, payee.length > 0)) };
}

// Agreement is the attributeRow() rule. Partner ruling 12 (round 7): "A
// registered alias and a suffix variant of the same identity agree. Make
// boundedPayerFields resolve aliases through the registry the way attributeRow
// does; if it can't resolve them, the row is unknown." Beside a payee, each
// other field is compared with the payee, as attributeRow() compares each
// reading: two registered spellings agree when they name the same entity
// (aliases resolve through the registry), otherwise the normalized names must
// be equal after one closed trailing company suffix is removed, and a name
// that is only a suffix agrees with nothing. So "Alpha Unit" (a registered
// alias) and "Vendor Alpha Inc" (a suffix variant) both agree with payee
// "Vendor Alpha", although they would disagree with each other by name. A
// field registered to more than one entity, or fields naming two registered
// entities, never agree. With no payee the labelled senders keep their
// earlier rule: one normalized name after suffix removal, or one registered
// entity throughout. ledger-answer.js treats a bounded conflict as an
// unknown attribution, so a row whose fields cannot be resolved to one
// identity is never confirmed on any answer path.
function boundedFieldsAgree(compared, registry, hasPayee) {
  const slugs = new Set(compared.flatMap(field => [...(registry.get(normalizeMerchantText(field)) || [])]));
  if (slugs.size > 1) return false;
  const registered = field => registry.get(normalizeMerchantText(field))?.size === 1;
  if (!hasPayee) {
    // A name that is only a suffix keeps its own normalized key, so two
    // different bare suffixes still differ.
    const keys = new Set(compared.map(field => agreementName(field) || `\0${normalizeMerchantText(field)}`));
    return keys.size <= 1 || (compared.length > 0 && compared.every(registered));
  }
  const [payee, ...others] = compared;
  const payeeKey = agreementName(payee);
  return others.every(field => (registered(payee) && registered(field)) || (Boolean(payeeKey) && agreementName(field) === payeeKey));
}

// Only a confirmed row can eliminate a payer. An assumption supports a
// positive figure for its own entity, with a note, and no other decision.
export function selectAttributedInflows(rows, attributions, { wanted, amountMinor = null, exactNamesOnly = false }) {
  const matched = [], unattributed = [];
  for (const row of rows) {
    const attribution = attributions.get(row.id);
    const same = wanted.state === 'unique' && attribution.entity_slug === wanted.slug;
    const amountMatches = amountMinor === null || amountMinor === row.amount_minor;
    if (['ambiguous', 'unresolved'].includes(wanted.state) || attribution.state === 'unknown' ||
        (attribution.state === 'observed' && (!same || row.amount_minor <= 0 || !amountMatches)) ||
        (attribution.state === 'assumed' && (!same || exactNamesOnly || row.amount_minor <= 0 || !amountMatches)))
      unattributed.push(row);
    else if (same && amountMatches) matched.push(row);
  }
  return { matched, unattributed };
}

// True when the row's statement carries a shorthand reading of the requested
// payer: the same resolved identity, or the requested name itself.
export function shorthandNames(attribution, wanted, wantedKey = null) {
  return (attribution?.evidence?.shorthand_readings || []).some(reading =>
    (wanted?.state === 'unique' && reading.payer.slug === wanted.slug) ||
    (Boolean(wantedKey) && normalizeMerchantText(reading.identity) === wantedKey));
}

// This scope-wide proof governs every exact payer figure, including optional
// transfer totals on a group. A confirmed group does not confirm other rows.
export function inflowScopeConfirmed(rows, attributions) {
  return rows.filter(row => row.direction === 'inflow').every(row => attributions.get(row.id)?.state === 'confirmed');
}

// A displayed payer subtotal of zero is still a zero claim. Use the same
// guard for gross groups, partial subtotals, lead figures and transfer flips.
export function payerAmount(total, scopeConfirmed) {
  return total === 0 && !scopeConfirmed ? null : total;
}
