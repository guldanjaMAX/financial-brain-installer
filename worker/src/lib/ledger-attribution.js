import { normalizePayerQuestion, payerMentionsCoverQuestion } from './ledger-question.js';

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
const companyCommaKey = value => String(value || '').normalize('NFKC').split(',').map(normalizeMerchantText).join(',');

export function payerRegistry(identities) {
  const index = new Map();
  index[companyCommaSpellings] = new Set();
  index[questionSpellings] = new Map();
  for (const identity of identities) for (const column of ['legal_name', 'display_label']) {
    const label = identity[column];
    // Reject only the damaged spelling, keeping the entity's valid aliases.
    // SQL flags preserve this decision even when a driver truncates at NUL.
    if (identity[`${column}_has_nul`] || String(label || '').includes('\0')) {
      index[damagedRegistry] = true;
      continue;
    }
    const key = normalizeMerchantText(label);
    if (!key) continue;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(identity.entity_slug);
    const spelling = normalizePayerQuestion(label);
    if (!index[questionSpellings].has(spelling)) index[questionSpellings].set(spelling, new Set());
    index[questionSpellings].get(spelling).add(identity.entity_slug);
    if (String(label).normalize('NFKC').includes(',')) index[companyCommaSpellings].add(companyCommaKey(label));
  }
  return index;
}

export function lookupPayer(label, registry) {
  const slugs = registry.get(normalizeMerchantText(label));
  if (!slugs) {
    const phrase = registry[questionPhrases]?.get(normalizeMerchantText(label));
    return phrase ? { state: 'unique', slug: phrase.slug, query_only: true } : { state: 'missing' };
  }
  return slugs.size === 1 ? { state: 'unique', slug: slugs.values().next().value }
    : { state: 'ambiguous' };
}

// Scan literal registered spellings, preserving their punctuation. Row lookup
// remains punctuation-insensitive; that cannot authorize a question fragment.
// This index belongs to the same bounded, request-local registry as the rows.
export function requestedPayerMentions(question, registry) {
  const text = normalizePayerQuestion(question), mentions = [];
  const word = char => !!char && /[\p{L}\p{N}\p{M}_]/u.test(char);
  for (const [label, slugs] of registry[questionSpellings] || []) {
    // Only a registered terminal period is optional. Other punctuation stays
    // literal; sentence punctuation after the spelling is outside its span.
    const variants = label.endsWith('.') ? [label, label.slice(0, -1)] : [label];
    for (const spelling of variants) {
      if (!spelling) continue;
      let start = text.indexOf(spelling);
      while (start !== -1) {
        const end = start + spelling.length;
        const before = [...text.slice(0, start)].at(-1), after = String.fromCodePoint(text.codePointAt(end) || 0);
        if (!word(before) && !word(after)) mentions.push({ start, end, label, slugs });
        start = text.indexOf(spelling, start + 1);
      }
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

// The extra lookup is a hypothesis for this answer, never a registered entity.
// It has no authority until a structured field or a complete sender parse
// equals it. Keep it separate from the Map so ordinary row/group attribution
// and registered-name conflicts retain their original authority boundary.
export function payerQuestionRegistry(intent, registry) {
  // A driver may hide the entire damaged spelling, so we cannot prove which
  // phrase conflicts with it. Valid registered aliases still work normally.
  if (registry[damagedRegistry]) return registry;
  if (requestedPayerMentions(intent.payerQuestion?.text, registry).length) return registry;
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
  for (const reading of intent.payerReadings) if (reading.label.includes(','))
    scoped[companyCommaSpellings].add(companyCommaKey(reading.label));
  return scoped;
}

export function resolveRequestedPayer(intent, registry, attributions = []) {
  const mentions = requestedPayerMentions(intent.payerQuestion?.text, registry);
  const slugs = new Set(mentions.flatMap(mention => [...mention.slugs]));
  const candidates = [...new Set(mentions.map(mention => mention.label))];
  if (slugs.size > 1) return { state: 'ambiguous', candidates };
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
  const grammar = {
    limits: Object.freeze({ codepoints: 512, fields: 12, parses: 64, steps: 32768 }),
    alphabet: /^[\p{L}\p{N}\p{M} &'()._/:#;,|\-\r\n\u0085\u2028\u2029]*$/u,
    lineBreak: /\r\n|[\r\n\u0085\u2028\u2029]/g,
    edgeSpaces: /^ +| +$/g,
    spaces: / +/g,
    fieldBoundary: /[;,|]/,
    name: /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &'()._/:#,\-]*$/u,
    separator: /^[ ]*(?:[;,|][ ]*)?/,
    channel: pattern(`^(?:${channel}(?: +${channelAction})?|${bareChannel}) +`),
    sender: pattern(`^(?:${sender} *: *|${bareSender} +)`),
    suffix: pattern(`^(?:${suffixChannel} +)?${suffix}$`),
    metadata: Object.freeze([
      [pattern(`^${words('orig id', 'co id', 'company id', 'individual id')} *(?:# *:?|:) *`), /^[\p{L}\p{N}]+(?:[./-][\p{L}\p{N}]+)*$/u],
      [pattern(`^${words('trace number', 'trace no', 'trace')} *(?:# *:?|:) *`), /^[0-9]{1,34}$/],
      [pattern(`^${words('desc date', 'effective date', 'eff date', 'entry date', 'settlement date')} *: *`), validStatementDate],
      [pattern(`^${words('co entry descr', 'entry descr')} *: *`), pattern(`^${words('payment', 'deposit', 'receipt', 'payroll', 'settlement', 'credit', 'transfer')}$`)],
      [pattern(`^${words('sec')} *: *`), pattern(`^${words('ACK', 'ADV', 'ARC', 'ATX', 'BOC', 'CCD', 'CIE', 'COR', 'CTX', 'DNE', 'ENR', 'IAT', 'MTE', 'POP', 'POS', 'PPD', 'RCK', 'SHR', 'TEL', 'TRC', 'WEB', 'XCK')}$`)],
      [pattern(`^${words('beneficiary', 'individual id/name', 'individual name')} *: *`), /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &'()._/-]*$/u],
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

function parseStatement(description, registry, statementCache) {
  const grammar = statementGrammar, limit = grammar.limits;
  const parser = { steps: 0, parses: 0, fields: 0, complete: false, refusal: null };
  const stopped = Symbol('parser budget');
  const refuse = reason => { parser.refusal = reason; throw stopped; };
  function step(work = 1) {
    if (work > limit.steps - parser.steps) { parser.steps = limit.steps; refuse('operation-limit'); }
    parser.steps += work;
  }
  function bounded(text) {
    step();
    // The cheap UTF-16 bound also refuses huge strings before scanning them.
    if (text.length > limit.codepoints * 2) refuse('length-limit');
    let count = 0;
    for (const char of text) { step(); if (++count > limit.codepoints) refuse('length-limit'); }
    if (!grammar.alphabet.test(text)) refuse('alphabet');
  }
  try {
    bounded(description);
    const text = description.replace(grammar.lineBreak, ';').normalize('NFKC').replace(grammar.edgeSpaces, '');
    bounded(text);
    // Validate the raw input on every row, including SQLite's NUL flag, before
    // reusing a normalized decision. A cache hit cannot legalize forbidden text
    // or erase an over-cap input through normalization or trimming.
    if (statementCache?.has(text)) return statementCache.get(text);
    const cache = new Map(), lookups = new Map(), fieldStarts = new Set();
    function lookup(identity) {
      if (!lookups.has(identity)) { step(identity.length); lookups.set(identity, lookupPayer(identity, registry)); }
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
        step(identity.length);
        if (!grammar.name.test(identity)) continue;
        let boundaryOnly = false;
        // A comma can belong to a complete name, alongside its field-boundary
        // readings. A query match is only a hypothesis here; complete competing
        // segmentations below must not split it into multiple explicit fields.
        if (identity.includes(',')) {
          step(identity.length);
          const completeParts = identity.split(',').every(part => normalizeMerchantText(part));
          const phraseMatch = registry[questionPhrases]?.has(normalizeMerchantText(identity)) && completeParts;
          if (!registry[companyCommaSpellings]?.has(companyCommaKey(identity)) && !phraseMatch) {
            if (!registry[questionPhrases] || !completeParts) continue;
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
          add(results, { readings: [{ identity, payer, start, end, ...(prefix ? { prefix } : {}),
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
        if (label && !optional) fieldStarts.add(opening);
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
          fieldStarts.add(next);
          add(results, { readings: [], fields: 1 });
        }
      }
      for (const [label, shape] of grammar.metadata) {
        const field = match(label, next);
        if (!field) continue;
        // A malformed or empty value still starts a field. It cannot become
        // part of an unregistered sender merely because validation fails.
        fieldStarts.add(next);
        const valueStart = next + field[0].length;
        for (const end of ends(valueStart)) {
          const value = text.slice(valueStart, end);
          step(value.length);
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
      // Registered whole names keep their independent authority; structured
      // payees bypass this parser and its vocabulary restriction entirely.
      parses = parses.map(parse => {
        const resolved = parse.readings.length === 1 && parse.readings.every(reading => reading.payer.state === 'unique');
        return { ...parse, readings: parse.readings.map(reading => {
          if (!reading.payer.query_only) return reading;
          for (const start of fieldStarts) {
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
    const result = decision(readings, 'description');
    if (!coherent) { result.state = 'unknown'; result.entity_slug = null; result.reading = null; }
    result.evidence.parser = parser;
    statementCache?.set(text, result);
    return result;
  } catch (error) {
    if (error !== stopped) throw error;
    return { state: 'unknown', entity_slug: null, reading: null,
      evidence: { source: 'description', ambiguous: false, candidates: [], parser } };
  }
}

function attributeRow(row, registry, statementCache) {
  // A damaged structured payee must not fall through to a description, even
  // if the returned payee is empty or a description cache already has a hit.
  if (row.payee_has_nul || String(row.payee || '').includes('\0'))
    return decision([], 'payee');
  if (row.payee) return decision([{ identity: row.payee, payer: lookupPayer(row.payee, registry) }], 'payee');
  // Some SQLite clients truncate TEXT at NUL. The SQL flag preserves the
  // alphabet refusal even when the returned string has lost that character.
  return parseStatement(String(row.description || '') + (row.description_has_nul ? '\0' : ''), registry, statementCache);
}

export function attributeInflow(row, registry) {
  return attributeRow(row, registry);
}

// Bind to the immutable identity snapshot for exactly one answer. Neither the
// descriptions nor decisions survive the request; structured payees bypass the
// cache. Consumers treat the shared result as read-only and keep row data apart.
export function createInflowAttributor(registry) {
  const statementCache = new Map();
  return row => attributeRow(row, registry, statementCache);
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
