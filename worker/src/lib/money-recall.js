/** Document-money recall aids. The model writes every answer and the evidence
 * verifier decides support. These helpers request a bounded repair, recognize
 * explicitly qualified history, or refuse. They never select or rewrite money.
 */
import { answerSentences } from './answer-sentences.js';
import { isMoneyAnswer, isMoneyQuestion } from './money-veto.js';
import { currentEvidenceCandidates, hasExplicitCurrentIntent, queryEntityAnchors,
  reliableDocumentTime } from './query-intent.js';

export const MONEY_RECALL_INSTRUCTION = [
  'For document-backed money, preserve the exact written figure, currency, payer, account and period. Put a citation on each factual sentence, not just the paragraph.',
  'For qualified history, you may use exactly: As of YYYY-MM-DD, the record states "the entire supplied excerpt, without its bracketed storage header" [n]. Current status is unknown.',
  'Do not begin a dated quotation with a negative answer to a payment premise. Cancellation or an unpaid invoice does not establish a whole-window absence or that nothing is owed.',
  'Use the record\'s reliable date. Preserve all clauses of the excerpt, including negations. Do not calculate, infer a next payment, rewrite a figure, or transfer another payer\'s figure. Prefer the newest relevant record that actually states the requested fact; newer unrelated activity alone does not contradict dated history.',
].join('\n');

const excerpt = doc => String(doc.snippet || '').replace(/^\[[^\]\r\n]*\]\s*/, '');
const normalized = text => String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const eligible = doc => doc.text_source === 'native' && doc.text_reliable === true &&
  doc.authority?.eligible !== false && doc.authority?.tier !== 'T4' && doc.lineage?.kind !== 'agent_derived';
const negativeRecord = /\b(?:cancelled|canceled|unpaid|did not pay|not paid|terminated)\b/i;

export function moneyDraftRepair({ question, answer, docs = [] }) {
  if (!answer || !isMoneyAnswer(question, answer)) return '';
  // This requests a new model draft only. The final draft still passes through
  // the ordinary verifier and both last-word vetoes, even after a repair.
  const sentences = answerSentences(answer.replace(/"[^"\n]+"/g, quote => quote.replaceAll('.', '\0')));
  const missing = sentences.some(sentence =>
    (isMoneyAnswer('', sentence) || /\d/.test(sentence)) &&
    !/\b(?:unknown|unconfirmed|cannot|can't|do(?:es)? not confirm)\b/i.test(sentence) &&
    !docs.some(doc => sentence.includes(`[${doc.n}]`)));
  const premise = /\b(?:no payments?|nothing (?:is )?due)\b/i.test(answer) &&
    docs.some(doc => eligible(doc) && negativeRecord.test(excerpt(doc)));
  return missing || premise ? `${MONEY_RECALL_INSTRUCTION}\nThe first draft ${missing ? 'omitted a sentence citation' : 'claimed a whole-window absence'}. Regenerate once from the same documents. If unsupported, refuse.` : '';
}

/** Recognition is not approval. Require the entire displayed excerpt so a
 * substring cannot remove a payer, a negation, a rate, or an adjacent clause.
 * Offsets describe the exact model-visible snippet, not the original file.
 */
export function moneyRecordQualification({ question, answer, docs = [], now = Date.now() }) {
  const unchanged = { answer, evidence: [], spans: [] };
  if (!isMoneyAnswer(question, answer)) return unchanged;
  // Leading-negative qualification is disabled for 0.4.14 until stricter
  // payer and premise binding exists. Never repair polarity by stripping No.
  const match = /^As of (\d{4}-\d{2}-\d{2}), the record states "([^"\n]+)" \[(\d+)\]\. Current status is unknown\.$/.exec(answer || '');
  if (!match) return unchanged;
  const [, day, quote, citation] = match;
  const doc = docs.find(row => row.n === Number(citation));
  if (!doc || !eligible(doc)) return unchanged;
  const time = reliableDocumentTime(doc);
  if (time === null || time > now || new Date(time).toISOString().slice(0, 10) !== day || quote !== excerpt(doc)) return unchanged;
  const anchors = queryEntityAnchors(question);
  const labels = [...String(question).matchAll(/"([^"\n]+)"/g)].map(m => m[1]);
  const body = ` ${normalized(quote).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  if (![...anchors, ...labels].every(anchor => body.includes(` ${normalized(anchor).replace(/[^\p{L}\p{N}]+/gu, ' ')} `))) return unchanged;
  const start = doc.snippet.indexOf(quote);
  return { answer, evidence: [doc.n], spans: [{ n: doc.n, start, end: start + quote.length }] };
}

export function applyMoneyRecallVeto({ question, answer, evidenceGate, docs = [], candidates = docs, now = Date.now(), owner, filters }) {
  const unchanged = { answer, evidenceGate };
  if (!answer || evidenceGate?.supported !== true || !isMoneyQuestion(question)) return unchanged;
  const refuse = reason => ({ answer: null, evidenceGate: { ...evidenceGate,
    supported: false, complete: false, evidence: [], reason },
    gap: { type: 'money_recall', detail: reason } });
  const approved = docs.filter(doc => evidenceGate.evidence?.includes(doc.n));
  const qualified = moneyRecordQualification({ question, answer, docs: approved, now });
  if (/\bthe record states\b/.test(answer) && !qualified.evidence.length) {
    return refuse('The dated money quote does not match its entire cited span, date or requested subject.');
  }
  if (hasExplicitCurrentIntent(question) && !qualified.evidence.length) {
    const current = currentEvidenceCandidates(question, candidates.filter(eligible), { owner, filters });
    const newest = current[0] && reliableDocumentTime(current[0]);
    const cited = approved.filter(doc => answer.includes(`[${doc.n}]`));
    if (newest !== undefined && cited.some(doc => {
      const time = reliableDocumentTime(doc);
      return time !== null && time < newest;
    })) return refuse('The current answer cites older money evidence; report exact dated history or cite the newer supporting record.');
  }
  return unchanged;
}
