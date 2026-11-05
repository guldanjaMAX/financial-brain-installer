import { cases, purchase, refund, reply } from './cases.mjs';
export const phraseCases = ['after refunds', 'minus returns', 'less refunds', 'net of credits'].map((phrase, index) => ({
  id: `phrase_${index}`, phrase, question: `Could you retrieve Vendor Unit spending this month ${phrase}?`,
  rows: [purchase, refund], intents: [reply()],
}));
phraseCases.push({ ...cases.find(c => c.twoPeriods), id: 'net_change',
  phrase: 'net spending change', question: 'How did net spending at Vendor Unit change this month versus last month?' });
phraseCases.push({ ...cases.find(c => c.twoPeriods), id: 'all_net_change',
  phrase: 'all net spending change', question: 'How did net spending change this month versus last month?',
  intents: [reply({ kind: 'expense_summary', vendor_text: null }), reply({ kind: 'expense_summary', vendor_text: null, period: { type: 'last_month' } })] });
phraseCases.push({ ...cases.find(c => c.twoPeriods), id: 'all_net_refunds',
  phrase: 'all net of refunds comparison', question: 'Could you compare spending this month versus last month net of refunds?',
  intents: [reply({ kind: 'expense_summary', vendor_text: null }), reply({ kind: 'expense_summary', vendor_text: null, period: { type: 'last_month' } })] });


export const grossPeer = c => ({ ...c, id: c.id + '_gross', question: c.twoPeriods
  ? c.intents[0].vendor_text ? 'Could you compare gross Vendor Unit spending this month versus last month?'
    : 'Could you compare gross spending this month versus last month?'
  : 'Could you retrieve gross Vendor Unit spending this month?' });
