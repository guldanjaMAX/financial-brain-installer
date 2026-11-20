import assert from 'node:assert/strict';

// The owner keeps the evidence, while canonical score fields stay testable in
// the response object. Compare words so punctuation changes cannot hide a gap.
const words = text => String(text).replace(/\x1b\[[0-9;]*m/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ownerWording = new Map([
  ['The compatibility ledger reading has no money-tool confidence assessment.',
    'The older money reading has not been checked against connected accounts, synced dates, missing periods and uncertain movements.'],
  ['Other query shapes need their own reviewed proof before High confidence.',
    'Other query shapes still need their own reviewed evidence checks.'],
  ['the SQL is outside the explicit High-confidence allow-list.',
    'this query has not passed the required evidence checks.'],
  ['Resolve each contributing party, verify its SQL grouping, and read and reconcile its complete history before using High confidence.',
    'Resolve each contributing party, verify its SQL grouping, and read and reconcile its complete history before treating these figures as verified.'],
]);
export function assertOwnerEvidence(text, confidence) {
  assert.equal(typeof text, 'string');
  assert.ok(text.trim(), 'owner output is populated');
  assert.doesNotMatch(text, /\bConfidence:\s*(?:High|Medium|Low)\b|\b(?:High|Medium|Low)\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/i,
    'computed confidence labels and percentages stay internal');
  if (!confidence || confidence.percent === 100 && !confidence.missing?.length) return;
  const details = [...(confidence.basis || []), ...(confidence.reasons || []), ...(confidence.missing || [])];
  assert.ok(details.length, 'the expected evidence decision is populated');
  for (const detail of details) {
    let expected = detail;
    for (const [internal, owner] of ownerWording) expected = expected.replaceAll(internal, owner);
    assert.ok(` ${words(text)} `.includes(` ${words(expected)} `), 'each computed reason and missing record stays in the owner answer');
  }
}
