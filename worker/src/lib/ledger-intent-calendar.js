import { ledgerDay, shiftLedgerDay } from './ledger-question.js';
import { refundBasisSpans } from './ledger-refund-basis.js';

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

// Lists are separate operands, never the interval between their endpoints.
// Shared trailing years stay ambiguous, just as they do for a month pair.
export function ledgerMonthList(text) {
  const matches = ledgerMonthMatches(text);
  if (matches.length < 3 || matches.length > 12) return null;
  const labels = matches.map(match => match[0]);
  if (!matches.slice(1).every((match, index) =>
    /^\s*(?:,\s*(?:(?:and|plus)\s+)?|(?:and|plus)\s+)$/i.test(
      text.slice(matches[index].index + labels[index].length, match.index)))) return null;
  const years = labels.map(label => monthYearSuffix.test(label));
  if (years.some(Boolean) && !years.every(Boolean)) return { invalid: true };
  return { labels, span: [matches[0].index, matches.at(-1).index + labels.at(-1).length] };
}

// A calendar-looking token that no admitted date grammar can consume must
// not disappear when the activity falls back to its default period.
export function ledgerCalendarResidue(text) {
  const malformedMonth = [...text.matchAll(/\b(?:in|during|for) ((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]+) \d{4}\b/gi)]
    .some(match => !months.includes(match[1].toLowerCase()) && !/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)$/i.test(match[1]));
  return malformedMonth || new RegExp(`\\b(?:${monthWords}|sept)\\.?(?=\\d)`, 'i').test(text) ||
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
  // Operators need a calendar operand; ordinary payment/direction prose is
  // not a date. Bare output counts are not calendar operands.
  const calendarOperand = `(?:${datePattern}|${dayOrdinalWords}|${calendarWeekdayWords}|${monthWords}|sept|q[1-4]|\\d{4}|(?:(?:this|current|last|previous|prior|next) (?:calendar )?)?(?:day|week|weekend|month|quarter|year)|today|yesterday)`;
  const calendarOperator = `(?:before|after|through|until|since|from|to|between)(?=\\s+(?:the\\s+)?${calendarOperand}\\b)`;
  const tokens = new RegExp(`\\b(?:${datePattern}|(?<=\\b(?:${monthWords}|before|after|through|until|since|from|to|between)(?: \\d{4})?(?: the)? )(?:${dayOrdinalWords})|(?:(?:this|current|last|previous|prior|next) (?:calendar )?(?:month|week|weekend|quarter|year)|(?:month|week|year)[ -]to[ -]date|(?:last|past) \\d{1,4} days|today|yesterday)|\\d{1,2}(?:st|nd|rd|th)|\\d{4}|${calendarOperator}|${calendarWeekdayWords}|${monthWords}|sept|q[1-4]|quarter|year)\\b|\\b\\d+(?=\\s+(?:${monthWords})\\b)|(?<=\\b(?:${monthWords})\\s+)\\d+`, 'gi');
  // These words have independently supported non-date meanings (a modal,
  // payment direction, refund basis, transfer scope, or snapshot freshness).
  // Their spans cannot cover a following day, weekday, month, or year.
  const nonCalendar = /\b(?:may (?=i|we|you)|meant to be|come through|to (?=see|check|repeat|know|find|view|review|retrieve)|(?:add(?:ed)? up|amount(?:ed)?|sum(?:med)? up) to|through the bank|up to date|(?:payments?|paid|went|billed|money in) to|after fees|(?:moves|transfers) from my other accounts|(?:moves|transfers) between (?:the )?personal and business (?:accounts?|accts?))\b/gi;
  // Output counts cannot consume day numbers or recurring-day restrictions.
  const outputCount = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,3})(?= (?:biggest|largest|highest|most expensive|newest|recent|outgoing|incoming|purchases?|expenses?|charges?|transactions?|payments?|deposits?|transfers?)\b)/gi;
  const presentation = /\b(?:so far|by this point|month[ -]by[ -]month|(?:by|per|each) month|(?:using |for |over )?(?:the )?same (?:number of days|length|period|days))\b/gi;
  const lexicalSpans = [...text.matchAll(nonCalendar), ...text.matchAll(outputCount), ...text.matchAll(presentation)].map(m => [m.index,m.index+m[0].length]).concat(refundBasisSpans(text));
  const unread = [...text.matchAll(tokens)].filter(m => ![...spans,...lexicalSpans].some(([start,end]) => m.index >= start && m.index + m[0].length <= end));
  // Only closed temporal restrictions can add calendar residue. Unknown verbs,
  // description prose and counts remain under the independent intent guards.
  // Check prefixes and tails alike so a narrower period cannot become a total.
  const restriction = new RegExp(`\\b(?:(?:not (?:in|during)|outside|except(?: in| during)?|limited to|restricted to|(?:immediately )?following|subsequent to|unrecognized_modifier|starting|ending|prior to|earlier than|later than)(?=\\s+(?:(?:the|its)\\s+)?${calendarOperand}\\b)|(?:early|late|mid)(?=[ -]+(?:the\\s+)?${calendarOperand}\\b)|(?:business |working )?days?|weeks?|months?|quarters?|years?|weekends?|weekdays?|holidays?|fortnights?|(?:first|second|latter|earlier|later|opening|closing) half|half of(?=\\s+(?:the\\s+)?${calendarOperand}\\b)|(?:custom|calendar|date|period) cutoff|(?:before|after|through|until|since) (?:\\d{1,2}:\\d{2}(?:\\s*[ap]m)?|noon|midnight|breakfast|lunch|dinner)|(?:at|near|toward|towards) (?:the |its )?(?:start|beginning|end)|end of(?=\\s+(?:the\\s+)?${calendarOperand}\\b))\\b`, 'gi');
  for (const m of text.matchAll(restriction)) {
    if (![...spans,...lexicalSpans].some(([start,end]) => m.index >= start && m.index + m[0].length <= end)) unread.push(m);
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
  // Retain the parser's unresolved decision for diagnostics. Only a valid,
  // independently grounded window may become a disclosed broader reading;
  // malformed, contradictory and future dates gain no execution authority.
  return words.length ? { ...parsed, invalid: true, consumed, unread: words,
    ...(parsed?.from && parsed?.to && !parsed.invalid && !words.some(word => new RegExp(`\\b(?:${monthWords}|sept|q[1-4]|\\d{4}|(?:this|current|last|previous|prior|next) (?:calendar )?(?:month|week|quarter|year)|tomorrow)\\b`, 'i').test(word)) ? { unusedCalendarLimits: words } : {}) }
    : parsed && { ...parsed, consumed };
}
