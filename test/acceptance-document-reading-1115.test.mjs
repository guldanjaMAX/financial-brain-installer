// Acceptance reads the Worker's source reading with the Worker's own title,
// date and excerpt shapes. On the large real Brain it failed with "did not
// agree" because a source "[0]" read as a citation; once that was fixed the
// out-of-page excerpt line and calendar date label were the next mismatches.
// The marker-equality and quote-binding guards stay as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerResponseContractDiagnostic } from '../acceptance.mjs';
import { finalizeDocumentAnswer } from '../worker/src/lib/document-answer.js';
import { ownerConfidenceLine } from '../worker/src/lib/confidence.js';

const unavailable = { supported: false, complete: false, error: 'Answer model or evidence check unavailable.' };
// The Worker's citation candidate projection (worker/src/index.js
// citationCandidateForResult) of the fields the finalizer reads.
const candidate = (row, index) => ({ n: index + 1, title: row.title || 'untitled', source: row.source || '?',
  ts: row.ts || null, ...(row.record_observation ? { record_observation: row.record_observation } : {}),
  date_reliable: row.date_reliable === true, date_source: row.date_source || null,
  text_source: row.text_source || 'unknown', text_reliable: row.text_reliable === true,
  snippet: (row.snippet || '').replace(/\s+/g, ' '), ...(row.retrieval_excerpts ? { retrieval_excerpts: row.retrieval_excerpts } : {}),
  read_complete: row.read_complete === true, read_coverage: row.read_coverage || null, question_time: row.question_time });
function payloadFor(results, question = 'When does the vendor renew?') {
  const finalized = finalizeDocumentAnswer({ question, draft: null, docs: results.map(candidate), approvedDocs: [], checks: [unavailable],
    gaps: [], retrievedCount: results.length, searchComplete: true, asOf: '2026-11-15' });
  return { mode: 'think', ...finalized, usedDocs: undefined, results, gaps: [],
    citations: finalized.usedDocs.map(d => ({ n: d.n, title: d.title, source: d.source })),
    evidence_gate: { supported: false, complete: false, evidence: [], reason: 'fixture' } };
}
const row = (n, snippet, extra = {}) => ({ chunk_uid: `records:d${n}:0`, doc_uid: `records:d${n}`, title: `Record ${n}`, source: 'records',
  ts: `2026-11-${String(n).padStart(2, '0')}T00:00:00.000Z`, date_reliable: true, text_source: 'native', text_reliable: true,
  snippet, retrieval_excerpts: [], read_complete: true, ...extra });
const withProse = (payload, edit) => {
  const at = payload.answer.indexOf('\n\nCoverage:');
  return { ...payload, answer: edit(payload.answer.slice(0, at)) + payload.answer.slice(at) };
};

test('acceptance passes a 12-record reading whose source text and title contain bracketed digits', () => {
  const results = Array.from({ length: 12 }, (_, i) => i === 0
    ? row(1, 'The vendor renews on 2026-12-01 [0]. See item [13] and row[0].', { title: 'Scan [2].pdf' })
    : row(i + 1, `Record ${i + 1} lists the vendor contact for renewal questions.`));
  const payload = payloadFor(results);
  assert.equal(payload.answer_contract.rung, 3);
  assert.equal(answerResponseContractDiagnostic(payload), null);
  // The marker guard is unchanged: a stray [13] in the prose still fails.
  assert.equal(answerResponseContractDiagnostic(withProse(payload, prose => `${prose} [13]`)),
    "the Worker's document answer and citations did not agree");
  // The quote binding is unchanged: an altered quote still fails.
  assert.equal(answerResponseContractDiagnostic(withProse(payload, prose => prose.replace('lists the vendor contact', 'lists the vendor ALTERED'))),
    "the Worker's provisional document answer was not bound to its source text");
});

test('acceptance admits an out-of-page excerpt line only as that record\'s own retrieval span', () => {
  const tail = 'Final qualification beyond chunk 500: renewal is pending.';
  const results = [row(1, 'Opening clause of record 1.', { retrieval_excerpts: [tail], read_complete: false }),
    row(2, 'Opening clause of record 2.'), row(3, 'Opening clause of record 3.')];
  const payload = payloadFor(results);
  assert.match(payload.answer, /An additional retrieved excerpt from the same record says: /, 'the excerpt decision was reached');
  assert.equal(answerResponseContractDiagnostic(payload), null);
  assert.equal(answerResponseContractDiagnostic(withProse(payload, prose => prose.replace('renewal is pending', 'renewal is approved'))),
    "the Worker returned prose outside the finalized source-reading shapes");
});

// Round 2. A long record is quoted by a window and named as partly quoted.
// Naming it by its raw title put "Payment 2024 receipts" or "Quote for
// $5,000" into the confidence reasons and the footer, which the explanation
// guard reads as a money figure. The Worker now names it "cited record n";
// the guard itself is unchanged.
const BOUNDARY_TEXT = "the Worker's document boundary explanation or routing text contained a refusal, money figure or additional confidence label";
const qualified = Array.from({ length: 120 }, (_, i) => `Clause ${i} of this statement applies if the parties agree and is not changed by the bank.`).join(' ');
const withConfidence = (payload, edit) => {
  const confidence = { ...payload.confidence, basis: edit(payload.confidence.basis) };
  return { ...payload, confidence, confidence_text: ownerConfidenceLine(confidence) };
};

test('acceptance passes a 12-record reading whose partly quoted records carry money-like titles', () => {
  const titles = ['Statement balance 2025-10.pdf', 'Quote for $5,000 project.pdf', 'Payment 2024 receipts', 'Stripe payout USD export'];
  for (const title of titles) {
    const results = [row(1, qualified, { title }), row(2, qualified, { title: `Total ${title}` }),
      ...Array.from({ length: 10 }, (_, i) => row(i + 3, `Record ${i + 3} lists the vendor contact for renewal questions.`))];
    const payload = payloadFor(results, 'What does the statement say about the vendor?');
    assert.equal(payload.answer_contract.rung, 3);
    for (const n of [1, 2]) {
      assert.ok(payload.confidence.basis.includes(`Only part of cited record ${n} is quoted; its other sentences were not checked against the answer.`),
        `record ${n} is named as partly quoted by its citation number`);
    }
    assert.equal(answerResponseContractDiagnostic(payload), null, `a money-like title passes: ${title}`);
    // The guard is unchanged: the same title in explanation text still fails,
    // and so does a money figure outside any title.
    assert.equal(answerResponseContractDiagnostic(withConfidence(payload, basis => [...basis,
      `Only part of the record "${title}" is quoted; its other sentences were not checked against the answer.`])), BOUNDARY_TEXT);
  }
  const results = [row(1, qualified, { title: 'Vendor statement October.pdf' }),
    ...Array.from({ length: 11 }, (_, i) => row(i + 2, `Record ${i + 2} lists the vendor contact for renewal questions.`))];
  const payload = payloadFor(results, 'What does the statement say about the vendor?');
  assert.equal(answerResponseContractDiagnostic(payload), null);
  assert.equal(answerResponseContractDiagnostic(withConfidence(payload, basis => [...basis, 'The balance is 5,000.'])), BOUNDARY_TEXT);
});

test('acceptance uses the Worker date label for calendar rows and D1 integer flags', () => {
  const calendar = row(1, 'Vendor review meeting about the renewal.', { chunk_uid: 'calendar:e1:0', doc_uid: 'calendar:e1', title: 'Vendor review',
    source: 'calendar', ts: '2026-11-20T00:00:00.000Z', date_source: 'calendar:event_start', question_time: '10:00 UTC',
    record_observation: { ts: '2026-11-10T00:00:00.000Z', date_reliable: true, date_source: 'calendar:updated' } });
  const payload = payloadFor([calendar], 'When is the vendor review?');
  assert.match(payload.answer, /As of 2026-11-10; event 10:00 UTC, the record "Vendor review"/, 'the calendar label decision was reached');
  assert.equal(answerResponseContractDiagnostic(payload), null);
  // A D1 integer flag is not a reliable date to the Worker or to acceptance.
  const integer = payloadFor([row(1, 'The vendor renews on 2026-12-01.', { date_reliable: 1 })]);
  assert.match(integer.answer, /As of 2026-11-01 \(date unverified\),/);
  assert.equal(answerResponseContractDiagnostic(integer), null);
  // Numeric timestamps are labelled by the Worker's own rule.
  const numeric = payloadFor([row(1, 'The vendor renews on 2026-12-01.', { ts: Date.parse('2026-11-03T00:00:00.000Z') })]);
  assert.match(numeric.answer, /As of 2026-11-03,/);
  assert.equal(answerResponseContractDiagnostic(numeric), null);
});
