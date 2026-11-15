// Round 3: realistic dating for the month probe, same-title superseded version,
// totals across distinct records, and matched legitimate High controls.

const T = '2026-11-11T19:00:00Z';
const FRESH = '2026-11-10T19:00:00Z';
const filler = k => ({ key: `f${k}`, source: `records-${k}`, title: 'Office Supplies Receipt', content: 'Pens and paper were bought.',
  occurred_at: FRESH, retrieve: false });
const fillers = ['a', 'b', 'c', 'd'].map(filler);
const three = (title, content, extra = {}) => ['a', 'b', 'c'].map(k => ({ key: k, source: `records-${k}`, title, content,
  occurred_at: T, ...extra }));
const cite3 = '{a}{b}{c}';
const march = [
  { key: 'a', source: 'records-a', title: 'March Rent Statement', content: 'Rent collected was $18,400.', occurred_at: '2026-04-02T17:00:00Z' },
  { key: 'b', source: 'records-b', title: 'March Rent Statement', content: 'Rent collected was $18,400.', occurred_at: '2026-04-02T17:00:00Z' },
  { key: 'c', source: 'records-c', title: 'March Rent Statement', content: 'Rent collected was $18,400.', occurred_at: '2026-11-05T17:00:00Z' },
  ...fillers,
];

export const probes = [
  { id: 'F01', kind: 'probe', area: 'March statement (issued Apr 2, re-sent Nov 5) answers an April 2026 question',
    question: 'How much rent was collected in April 2026 according to the rent statement?',
    docs: march, draft: `Rent collected was $18,400 ${cite3}.`,
    oracle: 'not stated for April 2026; $18,400 is March', wrong_if_high: true },
  { id: 'F02', kind: 'probe', area: 'same statement, question names April without a year',
    question: 'How much rent was collected in April according to the rent statement?',
    docs: march, draft: `Rent collected was $18,400 ${cite3}.`,
    oracle: 'not stated for April; $18,400 is March', wrong_if_high: true },
  { id: 'F03', kind: 'control', area: 'same statement, question names March 2026 (legit High)',
    question: 'How much rent was collected in March 2026 according to the rent statement?',
    docs: march, draft: `Rent collected was $18,400 ${cite3}.`,
    oracle: '$18,400', wrong_if_high: false },
  { id: 'F04', kind: 'control', area: 'relative period phrase (this month) triggers the time-window gap',
    question: 'How much rent was collected this month according to the rent statement?',
    docs: three('March Rent Statement', 'Rent collected was $18,400.', { occurred_at: '2026-11-05T17:00:00Z' }),
    draft: `Rent collected was $18,400 ${cite3}.`,
    oracle: 'not stated for November; must not be High', wrong_if_high: true },
  { id: 'F05', kind: 'probe', area: 'same-title newer version (dated before a re-sent copy) in different wording is ignored',
    question: 'What is the monthly fee in the service agreement?',
    docs: [
      { key: 'a', source: 'records-a', title: 'Service Agreement', content: 'The monthly fee is $900.', occurred_at: '2025-03-01T17:00:00Z' },
      { key: 'b', source: 'records-b', title: 'Service Agreement', content: 'The monthly fee is $900.', occurred_at: '2025-03-01T17:00:00Z' },
      { key: 'c', source: 'records-c', title: 'Service Agreement', content: 'The monthly fee is $900.', occurred_at: '2026-11-02T17:00:00Z' },
      { key: 'd', source: 'records-d', title: 'Service Agreement', content: 'The monthly charge is $1,100 from September 1, 2026.', occurred_at: '2026-08-20T17:00:00Z' },
      ...fillers,
    ],
    draft: `The monthly fee is $900 ${cite3}.`,
    oracle: '$1,100 per month from September 1, 2026', wrong_if_high: true },
  { id: 'F05C', kind: 'control', area: 'same newer version stated in the same words names the field',
    question: 'What is the monthly fee in the service agreement?',
    docs: [
      { key: 'a', source: 'records-a', title: 'Service Agreement', content: 'The monthly fee is $900.', occurred_at: '2025-03-01T17:00:00Z' },
      { key: 'b', source: 'records-b', title: 'Service Agreement', content: 'The monthly fee is $900.', occurred_at: '2025-03-01T17:00:00Z' },
      { key: 'c', source: 'records-c', title: 'Service Agreement', content: 'The monthly fee is $900.', occurred_at: '2026-11-02T17:00:00Z' },
      { key: 'd', source: 'records-d', title: 'Service Agreement', content: 'The monthly fee is $1,100 from September 1, 2026.', occurred_at: '2026-08-20T17:00:00Z' },
      ...fillers,
    ],
    draft: `The monthly fee is $900 ${cite3}.`,
    oracle: '$1,100; must not be High at $900', wrong_if_high: true },
  { id: 'F06', kind: 'probe', area: 'three different unit leases with identical text, question asks the building total',
    question: 'What is the total monthly rent across the three leases?',
    docs: [
      { key: 'a', source: 'records-a', title: 'Lease', content: 'The monthly rent is $2,000.', occurred_at: '2026-11-02T17:00:00Z' },
      { key: 'b', source: 'records-b', title: 'Lease', content: 'The monthly rent is $2,000.', occurred_at: '2026-11-03T17:00:00Z' },
      { key: 'c', source: 'records-c', title: 'Lease', content: 'The monthly rent is $2,000.', occurred_at: '2026-11-04T17:00:00Z' },
    ],
    draft: `The monthly rent is $2,000 ${cite3}.`,
    oracle: '$6,000 total', wrong_if_high: true },
  { id: 'F07', kind: 'control', area: 'single cleaning invoice total question (legit High)',
    question: 'What does the cleaning invoice state as its total?',
    docs: three('Cleaning Invoice', 'The cleaning invoice total is $2,000.'),
    draft: `The cleaning invoice total is $2,000 ${cite3}.`,
    oracle: '$2,000', wrong_if_high: false },
  { id: 'F08', kind: 'control', area: 'amount in words, exact clause (legit High)',
    question: 'What security deposit does the lease require?',
    docs: three('Lease', 'The security deposit is two thousand dollars.'),
    draft: `The security deposit is two thousand dollars ${cite3}.`,
    oracle: '$2,000', wrong_if_high: false },
  { id: 'F09', kind: 'probe', area: 'scale marker glued to digits in the title (000s) when the claim repeats that figure',
    question: 'What is the 000 code repairs budget in the budget report?',
    docs: three('Budget Report 000s', 'The 000 code repairs budget is 1,250.'),
    draft: `The 000 code repairs budget is 1,250 ${cite3}.`,
    oracle: 'contrived; included to test the digit-token skip', wrong_if_high: 'contrived' },
];
