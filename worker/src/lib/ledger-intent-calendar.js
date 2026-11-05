import { ledgerDay, shiftLedgerDay } from './ledger-question.js';

const months = 'january february march april may june july august september october november december'.split(' ');
const monthWords = months.flatMap(month => month.length > 3 ? [month, month.slice(0, 3)] : [month]).join('|');
const monthPattern = `(?:${monthWords})\\.?`;
const weekdayPattern = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
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
  const text = question.toLowerCase().replace(/\bon or after\b/g, 'since');
  const bound = (from, to) => from && to && from <= to && to <= today ? { from, to, literalAdmission: true } : null;
  const operand = `(?:${datePattern}|(?:(?:last|this) )?${weekdayPattern})`;
  const resolve = label => shortLedgerDay(label, today) || namedLedgerDay(label, today) ||
    (/^\d{4}-\d{2}-\d{2}$/.test(label) && Number.isFinite(Date.parse(label)) && ledgerDay(label) === label && label >= '2000-01-01' && label <= today ? label : null);
  const range = new RegExp(`\\b(?:from|between) (${operand}) (?:through|to|until|and) (${operand})(?![\\w/])`).exec(text);
  if (range) return bound(resolve(range[1]), resolve(range[2]));
  const since = new RegExp(`\\bsince (${operand})(?![\\w/])`).exec(text);
  if (since) return bound(resolve(since[1]), today);
  const single = new RegExp(`\\b(?:on |during )?((?:(?:last|this) )?${weekdayPattern})\\b`).exec(text);
  if (single) { const day = namedLedgerDay(single[1], today); return bound(day, day); }
  const dates = ledgerDateLiterals(text);
  if (dates.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(dates[0])) return null;
  if (dates.length === 1) { const day = resolve(dates[0]); return bound(day, day); }
  return null;
}

// Only named month/quarter labels reuse an existing period window. Arbitrary
// event text remains under the original event-anchor contract.
export function ledgerPeriodLiteral(text) {
  return typeof text === 'string' && new RegExp(`^(?:${months.join('|')})(?: \\d{4})?$|^q[1-4](?: \\d{4})?$|^(?:first|second|third|fourth|last|previous|this|current) quarter(?: \\d{4})?$`, 'i').test(text);
}
