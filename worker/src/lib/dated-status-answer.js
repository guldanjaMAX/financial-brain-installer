import { hasExplicitCurrentIntent, reliableDocumentTime } from './query-intent.js';
import { answerSentences } from './answer-sentences.js';
import { evidenceTextBasis } from './evidence-authority.js';

// Relationship and financial claims retain their dedicated gates. This lane
// qualifies ordinary owner state lists without declaring that an old record
// proves the present. The full evidence verifier still decides claim support.
const SPECIALIZED = /\b(?:addresses|address|phone|email|clients?|customers?|relationships?|engagements?|contracts?|subscriptions?|accounts?|invoices?|payments?|balances?|revenue|income|expenses|profit|tax|owe|owed|dollars?|usd)\b|[$€£]/i;
export function datedStatusPrompt(question, docs, now = Date.now()) {
  if (!hasExplicitCurrentIntent(question) || !/\b(?:current|currently|latest|now|today)\b/i.test(question) || SPECIALIZED.test(question)) return '';
  const candidates = docs.filter(doc => evidenceTextBasis(doc) !== null &&
    doc.authority?.eligible !== false && (doc.authority?.owner_confirmed === true || doc.authority?.tier === 'T1') &&
    reliableDocumentTime(doc) !== null && reliableDocumentTime(doc) <= now);
  return candidates.length ? 'When the newest relevant primary or owner-confirmed list is older than today, answer what it records using its exact as-of date. Do not refuse solely because the record is old. Keep the freshness gap and disclose any newer contradiction. This establishes dated history only, never an unqualified present state.' : '';
}
export function qualifyDatedStatus({ question, answer, docs, now = Date.now() }) {
  if (!hasExplicitCurrentIntent(question) || !/\b(?:current|currently|latest|now|today)\b/i.test(question) || SPECIALIZED.test(`${question} ${answer}`)) return { answer, evidence: [] };
  const evidence = new Set();
  const sentences = answerSentences(answer);
  const qualified = sentences.map(sentence => {
    if (/\b(?:cannot|unknown|unclear)\b/i.test(sentence)) return sentence;
    const numbers = [...sentence.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
    const cited = docs.filter(doc => numbers.includes(doc.n));
    if (!cited.length || cited.length !== new Set(numbers).size) return sentence;
    const times = cited.map(reliableDocumentTime);
    if (times.some(time => time === null || time > now) || !cited.every(doc =>
      evidenceTextBasis(doc) !== null && doc.authority?.eligible !== false &&
      (doc.authority?.owner_confirmed === true || doc.authority?.tier === 'T1'))) return sentence;
    // Mixed dates need per-item qualification, not one invented observation day.
    const days = [...new Set(times.map(time => new Date(time).toISOString().slice(0, 10)))];
    if (days.length !== 1) return sentence;
    const hasQualifier = /\b(?:as of|through)\b/i.test(sentence);
    if (hasQualifier && !sentence.includes(days[0])) return sentence;
    for (const n of numbers) evidence.add(n);
    const age = Math.floor((now - Date.parse(days[0])) / 86400000);
    if (hasQualifier) return sentence.replace(new RegExp(`${days[0]}(?: \\(\\d+ days old\\))?`), `${days[0]} (${age} days old)`);
    const marker = /^((?:[-*]|\d+[.)])\s+)/.exec(sentence)?.[1] || '';
    const body = sentence.slice(marker.length).replace(/^(The|This|These)\b/, word => word.toLowerCase());
    return `${marker}As of ${days[0]} (${age} days old), ${body}`;
  });
  return { answer: evidence.size ? qualified.join('\n') : answer, evidence: [...evidence] };
}

export function datedStatusInstruction(evidence) {
  return evidence.length ? [
    'The draft reports dated history, not an unqualified present fact. A primary or owner-confirmed record can support that exact as-of statement even when newer activity is unrelated.',
    'Also return "conflicts": an array of {"n":document number,"quote":"exact conflicting span"} for every newer supplied record contradicting a dated item. Return [] only when there is none.',
    'Never silently select a side of contradictory records.',
  ].join('\n') : '';
}

export function datedStatusConflicts(verdict, docs, qualified) {
  if (!qualified.evidence.length) return [];
  if (!Array.isArray(verdict?.conflicts)) return null;
  const conflicts = [];
  for (const span of verdict.conflicts) {
    const doc = docs.find(row => row.n === span?.n);
    const quote = String(span?.quote || '').replace(/\s+/g, ' ').trim();
    if (!doc || quote.length < 8 || !doc.snippet.includes(quote)) return null;
    conflicts.push(doc);
  }
  return conflicts;
}
