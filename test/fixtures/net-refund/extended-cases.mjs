import { cases, purchase, refund, reply } from './cases.mjs';
const base = cases[0];
export const extended = [
  { ...base, id: 'family_purchase', rows: [purchase, { ...purchase, id: 'family_purchase', payee: 'Vendor Unit Market', cents: 3000 }, refund], expectedGross: 15000, expectedNet: 13000, family: true },
  { ...base, id: 'first_day', rows: [{ ...purchase, date: '2026-10-01' }, { ...refund, date: '2026-10-01' }], expectedGross: 12000, expectedNet: 10000 },
  { ...base, id: 'last_day', rows: [{ ...purchase, date: '2026-10-12' }, { ...refund, date: '2026-10-12' }], expectedGross: 12000, expectedNet: 10000 },
  { ...cases.find(c => c.twoPeriods), id: 'mixed_net_gross',
    question: 'Could you retrieve Vendor Unit spending this month net of refunds and gross Vendor Unit spending last month?', mixed: true },
  { ...cases.find(c => c.twoPeriods), id: 'mixed_gross_net',
    question: 'Could you retrieve gross Vendor Unit spending this month and Vendor Unit spending last month net of refunds?', mixed: true, reverse: true },
];
