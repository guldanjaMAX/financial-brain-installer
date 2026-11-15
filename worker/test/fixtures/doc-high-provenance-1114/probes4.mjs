// Round 4: folder-marker controls for the Drafts finding.
const FRESH = '2026-11-10T19:00:00Z';
const filler = k => ({ key: `f${k}`, source: `records-${k}`, title: 'Office Supplies Receipt', content: 'Pens and paper were bought.', occurred_at: FRESH, retrieve: false });
const fillers = ['a', 'b', 'c', 'd'].map(filler);
const drafts = folder => [
  ...['a', 'b', 'c'].map(k => ({ key: k, source: `records-${k}`, title: 'Lease', content: 'The monthly rent is $2,300.',
    occurred_at: FRESH, uri: `drive://${folder}/Lease renewal ${k}.docx`, top_folder: folder })),
  { key: 'd', source: 'records-d', title: 'Signed Lease', content: 'Rent: $2,000 per month.', occurred_at: '2025-01-05T17:00:00Z' },
  ...fillers];
export const probes = [
  { id: 'G01', kind: 'control', area: 'singular Draft folder in the uri (word boundary matches DRAFT_TITLE)', question: 'What is the monthly rent under the lease?',
    docs: drafts('Draft'), draft: 'The monthly rent is $2,300 {a}{b}{c}.', oracle: '$2,000 signed; must not be High', wrong_if_high: true },
  { id: 'G02', kind: 'probe', area: 'Unsigned folder in the uri', question: 'What is the monthly rent under the lease?',
    docs: drafts('Unsigned Renewals'), draft: 'The monthly rent is $2,300 {a}{b}{c}.', oracle: '$2,000 signed', wrong_if_high: true },
  { id: 'G03', kind: 'probe', area: 'Rejected Offers folder in the uri', question: 'What is the monthly rent under the lease?',
    docs: drafts('Rejected Offers'), draft: 'The monthly rent is $2,300 {a}{b}{c}.', oracle: '$2,000 signed', wrong_if_high: true },
];
