// These are choices to clarify the request, never extra reader plans. Facts
// and numeric references belong only to the one fully validated reading.
import { originalRecordSuggestion, plainRouterLimitation } from './ledger-wording.js';
import { separateOffers } from './answer-render.js';
const choices = {
  balance: ['current recorded balances', 'recent transactions', 'both'],
  totals: ['totals for money in and money out', 'individual transactions', 'both'],
  expense_summary: ['expense totals by category', 'the largest individual expenses', 'both'],
  largest: ['the largest completed expenses or deposits', 'recent completed transactions', 'completed-transaction totals'],
  transactions: ['individual recent transactions', 'totals for money in and money out', 'both'],
  merchant: ['this vendor or payer', 'totals across all accounts', 'both'],
  category: ['this bank category', 'all expense categories', 'both'],
  deposits: ['individual completed deposits', 'the total money received', 'both'],
  transfers: ['possible transfers between your accounts', 'recent completed transactions', 'both'],
  recurring: ['detected recurring charges', 'expense totals', 'both'],
  payment: ['this received-payment lookup', 'a completed-deposit list', 'both'],
};

function recordMissing(ledger) {
  return !ledger || ledger.found === false || Boolean(ledger.previous_month?.reason) ||
    ledger.kind === 'multi' && ledger.parts.some(recordMissing);
}

export function finalLedgerOffer(body, clarificationQuestion, refundBusiness = body.ledger?.kind === 'merchant') {
  const composed = separateOffers(body.answer);
  const repair = (body.gaps || []).flatMap(gap => separateOffers(gap.detail).offers)[0] || composed.offers[0];
  const topicUnconfirmed = ledger => ledger?.category_total_unconfirmed || ledger?.category_ranking_unconfirmed ||
    ledger?.kind === 'multi' && ledger.parts.some(topicUnconfirmed);
  const parts = body.ledger?.parts || (body.ledger ? [body.ledger] : []);
  const refundParts = parts.filter(part => part?.net_refunds_unavailable);
  const refundQuestion = refundParts.length ? refundBusiness
    ? 'Want to review the deposits for possible refunds from this business?'
    : 'Want to review the deposits for possible refunds?' : null;
  // A refund limitation names its own review step; otherwise an unconfirmed category points to the original record.
  const question = refundQuestion || (topicUnconfirmed(body.ledger) ? originalRecordSuggestion
    : recordMissing(body.ledger) && repair ? repair
    : clarificationQuestion || composed.offers[0] || repair);
  return { ...body, answer: [composed.facts, question].filter(Boolean).join('\n') };
}

export function ledgerClarificationAnswer(body, decision) {
  const intent = decision.intents[0];
  const period = decision.period;
  const alternatives = decision.intents.length > 1 ? ['these separate readings', 'a different period or account']
    : decision.reason === 'period_uncertain'
    ? period.type === 'this_month' ? ['the current calendar month', 'the last 30 days']
      : period.type === 'last_month' ? ['the previous calendar month', 'the last 30 days']
        : period.type === 'last_n_days' ? [`the last ${period.n} days`, 'the previous calendar month']
          : [intent.presentation.period(intent.from, intent.to), 'the last 30 days']
    : choices[intent.kind];
  const reading = decision.intents.map(part => part.interpretation.replace(/\.$/, '')).join('; ') + '.';
  const prefix = `${intent.interpretation}\n`;
  const detail = (body.answer?.startsWith(prefix) ? body.answer.slice(prefix.length) : body.answer) ||
    (body.gaps || []).map(gap => gap.detail).filter(Boolean).join('\n') || plainRouterLimitation('reading_unavailable');
  const composed = finalLedgerOffer({ ...body,
    answer: `Here's my best reading of your question: ${reading}\n${[detail, decision.unansweredPart].filter(Boolean).join('\n')}` },
  'Want to choose the dates or account that would help most?',
  intent.kind === 'merchant' && decision.intents.every(part => part.kind === 'merchant' && part.match === intent.match));
  const question = separateOffers(composed.answer).offers[0];
  // Preserve the reviewed composer, including every coverage qualification and
  // citation. Completeness here concerns the unresolved question, independent
  // of whether the selected reading happens to have complete ledger coverage.
  return { ...composed, ledger: body.ledger ?? null, intent_outcome: 'clarify',
    clarification: { reason: decision.reason, best_reading: reading, alternatives, question },
    evidence_gate: { ...body.evidence_gate, complete: false, partial: true,
      reason: `question needs clarification; ${body.evidence_gate?.reason || 'ledger reading unavailable'}` } };
}
