import { ledgerDay, shiftLedgerDay } from './ledger-question.js';
import { refundBasisSpans } from './ledger-refund-basis.js';

// Non-calendar request and financial words may remain around a consumed
// operand. Calendar and restriction words must belong to a parsed span.
// Admit financial idioms as complete phrases below; bare "end" can narrow dates.
const financialRemainderWords = new Set(`a according account accounts accts across after against all also an and another any are arrival arrived
at balance balances bank between biggest billed both bring business by came can card cards cash
categories category change charge charges check checking cleared client come compared completed cost costs could count counting
couple credit credits customer debt debit deposit deposits descending description did difference digits do does dollars during
each else ending escrow every everything excluding expense expenses fees fetch few find for fresh freshness
from get give grouped grouping groups has have highest hit how i in include including income
incoming inflow inflows individual into investment is it items its landed largest latest less list loan loans
materials me merchant merchants minus money more most moves much my need net newest not number
of on ones only order other our out outflow outflows outgoing over own owner paid pay
payee payees payer payers payment payments pending personal please plus posted pull receive received recent recently
recorded refund refunds request retirement retrieve returned returning returns reversed review s savings say says separate
separately show side single sort sorted spend spending spent split still subtotal such sum synced tally tell
than that the their then ties to top total totaled totalled totals transaction transactions transfer transfers
twice type types under updated us usd using versus vs was we went were what when
whether which with within without would you your gone per
acct add amount behind bills break breakdown candidate categorizable combined compare crept deposited down
expensive goes grand group had if labelled labeled likely look lumped made many match matching mind monthly once
ordinary outgoings paying payout payouts payoouts send spned point priciest purchase purchases rank ranking reached records recurring regular
result rev revenue running see sent shelled stock summary take there together too took underneath up
vendor vendors want where`.split(/\s+/));

const months = 'january february march april may june july august september october november december'.split(' ');
const monthWords = months.flatMap(month => month.length > 3 ? [month, month.slice(0, 3)] : [month]).join('|');
const monthPattern = `(?:${monthWords})\\.?`;
const weekdayPattern = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
// Recognition is deliberately broader than admission: abbreviated or recurring
// weekday filters still need a grammar, never a silent whole-month fallback.
const calendarWeekdayWords = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)s?';
const dayOrdinalWords = '(?:(?:twenty|thirty)[ -])?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth';
// Longest alternatives go first so an explicit year or invalid suffix cannot
// disappear into a valid shorter literal. Calendar validity is checked later.
const datePattern = `\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|${monthPattern} \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|(?:the )?\\d{1,2}(?:st|nd|rd|th)`;
export function ledgerDateLiterals(text) {
  return [...text.matchAll(new RegExp(`\\b(?:${datePattern})(?![\\w/])`, 'gi'))].map(match => match[0]);
}

export function shortLedgerDay(text, today) {
  if (typeof text !== 'string') return null;
  const label = text.toLowerCase();
  let year = Number(today.slice(0, 4)), month, day;
  const numeric = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(label);
  const named = new RegExp(`^(${monthPattern}) (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`).exec(label);
  const ordinal = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)$/.exec(label);
  if (numeric) { month = Number(numeric[1]); day = Number(numeric[2]); year = Number(numeric[3] || year); }
  else if (named) { month = months.findIndex(value => value.startsWith(named[1].replace(/\.$/, ''))) + 1; day = Number(named[2]); year = Number(named[3] || year); }
  else if (ordinal) { month = Number(today.slice(5, 7)); day = Number(ordinal[1]); }
  else return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return Number.isFinite(Date.parse(iso)) && ledgerDay(iso) === iso && iso >= '2000-01-01' && iso <= today ? iso : null;
}

export function ledgerDatePresentation(question, today) {
  const literals = ledgerDateLiterals(question);
  if (!literals.some(literal => /\/|(?:st|nd|rd|th)\b/i.test(literal) || new RegExp(`^(?:${months.map(month => month.slice(0, 3)).join('|')})\\.? `, 'i').test(literal))) return null;
  const month = months[Number(today.slice(5, 7)) - 1];
  return `I read dates as month/day, using ${today.slice(0, 4)} for a missing year and ${month[0].toUpperCase()}${month.slice(1)} ${today.slice(0, 4)} for a day without a month.`;
}

export function namedLedgerDay(text, today) {
  const match = new RegExp(`^(?:(last|this) )?(${weekdayPattern})$`, 'i').exec(text);
  if (!match) return null;
  const index = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(match[2].toLowerCase());
  const current = new Date(`${today}T00:00:00Z`).getUTCDay();
  let delta = (current - index + 7) % 7;
  if (match[1]?.toLowerCase() === 'last' && delta === 0) delta = 7;
  if (match[1]?.toLowerCase() === 'this') delta = (current + 6) % 7 - (index + 6) % 7;
  const day = shiftLedgerDay(today, -delta);
  return day <= today ? day : null;
}

export function supplementalLedgerWindow(question, today) {
  const parsed = parseSupplementalLedgerWindow(question, today);
  const admitted = calendarConsumption(question, parsed);
  if (parsed?.calendarRole && admitted?.consumed?.length) {
    const [start, end] = admitted.consumed[0];
    admitted.calendarRole = question.slice(start, end);
  }
  return admitted;
}
function parseSupplementalLedgerWindow(question, today) {
  const text = expandLedgerCalendarWords(question.toLowerCase()).replace(/\bon or after\b/g, 'since');
  let consumed = [];
  const use = match => { consumed = [[match.index, match.index + match[0].length]]; };
  const bound = (from, to, calendarRole) => from && to && from <= to && to <= today ? { from, to, literalAdmission: true, consumed, calendarRole } : null;
  const operand = `(?:${datePattern}|(?:(?:last|this) )?${weekdayPattern})`;
  const resolve = label => shortLedgerDay(label, today) || namedLedgerDay(label, today) ||
    (/^\d{4}-\d{2}-\d{2}$/.test(label) && Number.isFinite(Date.parse(label)) && ledgerDay(label) === label && label >= '2000-01-01' && label <= today ? label : null);
  const range = new RegExp(`\\b(?:from|between) (${operand}) (?:through|to|until|and) (${operand})(?![\\w/])`).exec(text);
  if (range) { use(range); return bound(resolve(range[1]), resolve(range[2]), range[0]); }
  const since = new RegExp(`\\bsince (${operand})(?![\\w/])`).exec(text);
  if (since) { use(since); return bound(resolve(since[1]), today, since[0]); }
  const single = new RegExp(`\\b(?:on |during )?((?:(?:last|this) )?${weekdayPattern})\\b`).exec(text);
  if (single) { use(single); const day = namedLedgerDay(single[1], today); return bound(day, day, single[0]); }
  const dates = ledgerDateLiterals(text);
  if (dates.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(dates[0])) {
    use({ index: text.indexOf(dates[0]), 0: dates[0] });
    return { consumed }; // The existing ISO/model grounding path commits this day.
  }
  if (dates.length === 1) { use({ index: text.indexOf(dates[0]), 0: dates[0] }); const day = resolve(dates[0]); return bound(day, day, dates[0]) || { invalid: true }; }
  return null;
}

// Only named month/quarter labels reuse an existing period window. Arbitrary
// event text remains under the original event-anchor contract.
export function ledgerPeriodLiteral(text) {
  return typeof text === 'string' && new RegExp(`^(?:${months.join('|')})(?: \\d{4})?$|^q[1-4](?: \\d{4})?$|^(?:first|second|third|fourth|last|previous|this|current) quarter(?: \\d{4})?$`, 'i').test(expandLedgerCalendarWords(text));
}

// Closed calendar spellings only. Callers remove literal account/payee spans
// first, so a display label cannot donate a month or a relative quarter.
export function expandLedgerCalendarWords(text) {
  return text.replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\.?/gi,
    word => months.find(month => month.startsWith(word.toLowerCase().replace(/\.$/, '').slice(0, 3))))
    .replace(/\b(this|current|last|previous|prior) q\b/gi, (_, relative) => `${relative === 'prior' ? 'previous' : relative} quarter`)
    .replace(/\byrs?\b/gi, 'year')
    // Consume the year with its month; leaving it behind would silently admit
    // the current-year month. Literal account/payee spans are removed first.
    .replace(new RegExp(`\\b(${months.join('|')})\\s+['\u2019](\\d{4}|\\d{2})(?![\\w\u2019'])`, 'gi'), (_, month, year) => `${month} ${year.length === 2 ? '20' : ''}${year}`)
    .replace(/\b(?:in|during|for|year) ['’](\d{2})\b/gi, (_, year) => `in 20${year}`);
}

const coordinatedMonthLabel = `(?:${monthWords}|sept)\\.?(?:\\s+(?:\\d{4}|['\u2019](?:\\d{4}|\\d{2})))?`;
const monthYearSuffix = /\s+(?:\d{4}|['\u2019](?:\d{4}|\d{2}))$/;
function ledgerMonthMatches(text) {
  return [...text.matchAll(new RegExp(`\\b${coordinatedMonthLabel}(?![\\w/])`, 'gi'))];
}

// One authority rule for either operand: spacing and optional calendar wording
// cannot make a trailing relative year disappear during pair expansion.
const relativeMonthYearAuthority = /\b(?:this|current|last|previous|prior|next)\s+(?:calendar\s+)?year\b/i;
export function sharedLedgerMonthYear(text) {
  text = expandLedgerCalendarWords(text);
  const operands = ledgerMonthMatches(text);
  if (operands.length !== 2) return false;
  const labels = operands.map(match => match[0]);
  // Day literals have their own year/default contract, not a coordinated month scope.
  if (ledgerDateLiterals(text).some(day => labels.some(label =>
    day.toLowerCase().startsWith(label.toLowerCase() + ' ')))) return false;
  const end = operands[0].index + labels[0].length;
  const bridge = text.slice(end, operands[1].index);
  const connector = /\b(?:and|plus|versus|vs|against|compared (?:with|to)|than)\b/i.exec(bridge);
  const firstContext = expandLedgerCalendarWords(text.slice(0, end + (connector?.index ?? bridge.length)));
  // An explicit first-operand year remains authoritative; local window guards
  // validate relative/future/conflicting years before any facts are read.
  if (relativeMonthYearAuthority.test(firstContext) || /\b(?:in|for|during|of|year)\s+\d{4}\b/i.test(firstContext)) return false;
  // Positions matter even for repeated names or punctuation. Refusal grants no
  // expansion authority; only combinedLedgerMonths admits the closed pair grammar.
  const trailingContext = text.slice(operands[1].index + labels[1].length);
  return !monthYearSuffix.test(labels[0]) &&
    (monthYearSuffix.test(labels[1]) || relativeMonthYearAuthority.test(trailingContext));
}

export function combinedLedgerMonths(text) {
  const pair = new RegExp(`\\b(${coordinatedMonthLabel})\\s+(?:and|plus)\\s+(${coordinatedMonthLabel})(?![\\w/])`, 'i').exec(text);
  return pair && ledgerMonthMatches(text).length === 2 ? [pair[1], pair[2]] : null;
}

// A calendar-looking token that no admitted date grammar can consume must
// not disappear when the activity falls back to its default period.
export function ledgerCalendarResidue(text) {
  return new RegExp(`\\b(?:${monthWords}|sept)\\.?(?=\\d)`, 'i').test(text) ||
    /\b(?:in|during|for|year)\s+\d{4}[\p{L}\p{N}/_-]/u.test(text) ||
    [...text.matchAll(/\b\d+[\/]\d[^\s,;?!]*/g)].some(match =>
      !/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\.?$/.test(match[0]));
}

// Parser branches supply only the spans whose operands they actually used.
// Admission checks the complement; recognizing one date never licenses a tail.
export function calendarConsumption(question, parsed) {
  const normalize = value => expandLedgerCalendarWords(value.toLowerCase()).replace(/\bon or after\b/g, 'since');
  const text = normalize(question);
  const spans = parsed?.consumed || [];
  const tokens = new RegExp(`\\b(?:${datePattern}|(?<=\\b(?:${monthWords}|before|after|through|until|since|from|to|between)(?: \\d{4})?(?: the)? )(?:${dayOrdinalWords})|(?:(?:this|current|last|previous|prior|next) (?:calendar )?(?:month|week|weekend|quarter|year)|(?:month|week|year)[ -]to[ -]date|(?:last|past) \\d{1,4} days|today|yesterday)|\\d{1,2}(?:st|nd|rd|th)|\\d{4}|before|after|through|until|since|from|to|between|${calendarWeekdayWords}|${monthWords}|sept|q[1-4]|quarter|year)\\b|\\b\\d+(?=\\s+(?:${monthWords})\\b)|(?<=\\b(?:${monthWords})\\s+)\\d+`, 'gi');
  // These words have independently supported non-date meanings (a modal,
  // payment direction, refund basis, transfer scope, or snapshot freshness).
  // Their spans cannot cover a following day, weekday, month, or year.
  const nonCalendar = /\b(?:may (?=i|we|you)|meant to be|come through|to (?=see|check|repeat|know|find|view|review|retrieve)|(?:add(?:ed)? up|amount(?:ed)?|sum(?:med)? up) to|through the bank|up to date|(?:payments?|paid|went|billed|money in) to|after fees|(?:moves|transfers) from my other accounts|(?:moves|transfers) between (?:the )?personal and business (?:accounts?|accts?))\b/gi;
  // Output counts cannot consume day numbers or recurring-day restrictions.
  const outputCount = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,3})(?= (?:biggest|largest|highest|most expensive|newest|recent|outgoing|incoming|purchases?|expenses?|charges?|transactions?|payments?|deposits?|transfers?)\b)/gi;
  const lexicalSpans = [...text.matchAll(nonCalendar), ...text.matchAll(outputCount)].map(m => [m.index,m.index+m[0].length]).concat(refundBasisSpans(text));
  const unread = [...text.matchAll(tokens)].filter(m => ![...spans,...lexicalSpans].some(([start,end]) => m.index >= start && m.index + m[0].length <= end));
  // A consumed period licenses only admitted financial complements, wherever
  // they occur; an unknown restriction must fail closed.
  // This checks the complement as text, rather than guessing every possible
  // spelling of half-periods, recurring days, or owner-defined cutoffs.
  const lastEnd = spans.length ? Math.max(...spans.map(([,end]) => end)) : null;
  if (lastEnd !== null) {
    // Selectors are removed by the caller. Check every complement, including
    // the prefix and bridges, so unknown subsets cannot become whole periods.
    const complement = text.split('').map((ch, i) => [...spans, ...lexicalSpans]
      .some(([a, b]) => i >= a && i < b) ? ' ' : ch).join('');
    const admitted = complement.replace(/\b(?:end up (?=(?:paying|spending)\b)|so far|by this point|month[ -]by[ -]month|(?:by|per|each) month|second candidate match|newest first|highest first|(?:using |for |over )?(?:the )?same (?:number of days|length|period|days))\b/g, match => ' '.repeat(match.length));
    for (const m of admitted.matchAll(/[\p{L}\p{N}]+/gu)) {
      if (!financialRemainderWords.has(m[0])) unread.push(m);
    }
    const tail = text.slice(lastEnd).trim();
    const tailStart = lastEnd + text.slice(lastEnd).indexOf(tail);
    const financialTail = /^(?:[\s,;:.?!]|(?:after (?:fees|refunds?|returns|credits)|net of refunds|once refunds are netted out|less refunds|by payee|excluding (?:own )?transfers|including (?:own )?transfers|please)\b)*$/i;

    const financialText = [...tail].map((ch,i) => lexicalSpans.some(([a,b]) => tailStart+i >= a && tailStart+i < b) ? ' ' : ch).join('');
    const financialRemainder = financialText.replace(/\b(?:end up (?=(?:paying|spending)\b)|newest first|highest first|(?:using |for |over )?(?:the )?same (?:number of days|length|period|days))\b/g, '').match(/[\p{L}\p{N}]+/gu) || [];

    if (!financialTail.test(tail) && !financialRemainder.every(word => financialRemainderWords.has(word))) {
      if (!unread.some(m => m.index >= lastEnd)) unread.push({ 0: tail, index: tailStart });
    }
  }
  // Restriction introducers before a date must not disappear into the subject.
  // Their complete suffix is unresolved until an interval grammar consumes it.
  const restriction = /\b(?:not (?:in|during)|limited|restricted|except|business days|weekends|half|fortnight|cutoff)\b/gi;
  for (const m of text.matchAll(restriction)) {
    if (!spans.some(([start,end]) => m.index >= start && m.index + m[0].length <= end)) unread.push(m);
  }
  unread.sort((a,b) => a.index - b.index);
  // Convert normalized offsets back to exact original character boundaries.
  // Boundaries are outside expanded words, so prefixes retain their meaning.
  const boundaries = new Map();
  for (let i = 0; i <= question.length; i++) {
    const offset = normalize(question.slice(0, i)).length;
    const prior = boundaries.get(offset);
    boundaries.set(offset, [prior?.[0] ?? i, i]);
  }
  const boundary = (offset, end = false) => boundaries.get(offset)?.[end ? 1 : 0] ?? question.length;
  const consumed = [...spans,...lexicalSpans].map(([start,end]) => [boundary(start),boundary(end, true)]);
  const groups = [];
  for (const token of unread) {
    const start = boundary(token.index), end = boundary(token.index + token[0].length, true);
    const prior = groups.at(-1);
    // Join date grammar glue only; never quote an already consumed operand or
    // arbitrary intervening question text as though the parser had not read it.
    if (prior && /^(?:[\s,;:.?!-]|\b(?:the|on|in|during|for|and|or)\b)*$/i.test(question.slice(prior[1], start))) prior[1] = end;
    else groups.push([start, end]);
  }
  const words = groups.map(([start,end]) => question.slice(start,end));
  return words.length ? { ...parsed, invalid: true, consumed, unread: words } : parsed && { ...parsed, consumed };
}
