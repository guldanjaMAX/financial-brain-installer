import { CLOCK, CONTROLS } from '../fastloop-money/input.mjs';

const check = JSON.stringify({ supported: true, complete: true, evidence: [1], reason: 'The cited passage states the fact.' });
const document = (index, text) => ({ source: 'protocol', title: 'Protocol record',
  doc_uid: 'protocol:record', chunk_uid: `protocol:record#${index}`, index,
  revision: 'synthetic-revision-1', text });
const make = (id, documents, modelOutputs) => ({ schema: 1, id, base: false,
  privacy: 'synthetic', profile: 'typed', clock: CLOCK,
  question: 'Which color is recorded for protocol release?', documents,
  vectorIds: [documents.at(-1).chunk_uid], modelOutputs });

export const DOCUMENT_CASES = [
  make('D01', [document(0, '🟣  The protocol release color is violet.\nThe release is not authorized.')],
    ['The protocol release color is violet [1].', check]),
  make('D02/repair', [document(0, 'The protocol release color is violet. The release is not authorized.')],
    ['The protocol release color is violet.', 'The protocol release color is violet [1].', check]),
  make('D03/check-retry', [document(0, 'The protocol release color is violet. The release is not authorized.')],
    ['The protocol release color is violet [1].', 'unreadable', check]),
  make('D04/composite', [document(0, 'The protocol release color is violet.'),
    document(1, 'The release is not authorized. The readiness signal is amber.')],
    ['The protocol release color is violet [1].', check]),
  make('D05/crop', [document(0, `The protocol release color is violet. ${'Background detail. '.repeat(80)}The release is not authorized.`)],
    ['The protocol release color is violet [1].', check]),
  { ...make('D06/filtered', [document(0, 'The protocol release color is violet.'),
    { ...document(1, 'The protocol release color is violet.'), source: 'other-records',
      doc_uid: 'other-records:record', chunk_uid: 'other-records:record#0' }],
  ['The protocol release color is violet [1].', check]), request: { source: 'protocol' } },
];

export const CLOCK_CASES = [
  { ...CONTROLS.find(c => c.id === 'M06/typed'), id: 'C01/previous-month',
    clock: { ...CLOCK, now_utc: '2026-10-01T01:00:00Z' } },
  { ...DOCUMENT_CASES[0], id: 'C02/window',
    question: 'Which color was recorded for protocol release this month?' },
];
