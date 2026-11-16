// The founder's 0.4.28 acceptance compares the live Worker's document answer
// with its own rebuild. After the marker and size fixes, three mismatches
// were next in line on a large real Brain:
//   (a) a stored title that is null or empty: the Worker wrote the record
//       "untitled", acceptance rebuilt "Untitled record";
//   (b) a title longer than 140 characters: the Worker sends the whole title,
//       acceptance compared the first 140;
//   (c) explanation reasons that carried a raw title or quoted the draft or a
//       source sentence. Acceptance's explanation guard reads money there as
//       a stray money figure whenever a draft is not fully approved.
// The Worker now names records in reasons by citation number and quotes no
// draft or source text there; both sides use one title rule. The guard is
// unchanged, and confidence is pinned to its value before this change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerResponseContractDiagnostic } from '../../acceptance.mjs';
import { finalizeDocumentAnswer, markerSafe } from '../src/lib/document-answer.js';
import { ownerConfidenceLine } from '../src/lib/confidence.js';
import { createProductFixture } from './product-contract-fixture.mjs';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';

const BOUNDARY_TEXT = "the Worker's document boundary explanation or routing text contained a refusal, money figure or additional confidence label";
const prose = body => body.answer.split('\n\nCoverage:')[0];
const explanation = body => JSON.stringify([body.confidence.basis, body.confidence.missing]);

// The Worker's citation candidate projection (worker/src/index.js
// citationCandidateForResult) of the fields the finalizer reads. The real
// route tests below exercise the projection itself.
const candidate = (row, index) => ({ n: index + 1, title: row.title || 'untitled', source: row.source || '?', ts: row.ts || null,
  date_reliable: row.date_reliable === true, date_source: row.date_source || null, text_source: row.text_source || 'unknown',
  text_reliable: row.text_reliable === true, snippet: (row.snippet || '').replace(/\s+/g, ' '), read_complete: row.read_complete === true,
  read_coverage: null, question_time: row.question_time });
const approve = { supported: true, complete: true, evidence: [1], reason: 'fixture approval' };
const reject = { supported: false, complete: false, evidence: [], reason: 'fixture rejection' };
function payloadFor(results, { question = 'What is the monthly storage fee?', draft = null, checks = [], gaps = [] } = {}) {
  const docs = results.map(candidate);
  const approved = checks.some(c => c.supported === true) ? docs.filter(d => d.n === 1) : [];
  const finalized = finalizeDocumentAnswer({ question, draft, docs, approvedDocs: approved, checks, gaps,
    retrievedCount: results.length, searchComplete: true, asOf: '2026-11-15' });
  return { mode: 'think', ...finalized, usedDocs: undefined, results, gaps, model: 'fixture-model',
    citations: finalized.usedDocs.map(d => ({ n: d.n, title: d.title, source: d.source })),
    evidence_gate: checks.at(-1) || { supported: false, complete: false, evidence: [], reason: 'fixture' } };
}
const row = (n, snippet, extra = {}) => ({ chunk_uid: `records:d${n}:0`, doc_uid: `records:d${n}`, title: `Record ${n}`, source: 'records',
  ts: `2026-11-${String(n).padStart(2, '0')}T00:00:00.000Z`, date_reliable: true, text_source: 'native', text_reliable: true,
  snippet, read_complete: true, ...extra });
const withBasis = (payload, extra) => {
  const confidence = { ...payload.confidence, basis: [...payload.confidence.basis, extra] };
  return { ...payload, confidence, confidence_text: ownerConfidenceLine(confidence) };
};
const FEE = 'The storage fee is $4,000 per month.';
const DRAFT = 'The storage fee is $4,000 per month [1].';
const LONG_TITLE = 'Quote for $5,000 storage renewal and balance 2025-10 statement '.padEnd(200, 'x');
const MONEY_TITLES = ['Payment 2024 receipts', 'Statement balance 2025-10.pdf', 'Quote for $5,000 project.pdf', 'Stripe payout USD export',
  'Rent 2,400 lease [3].docx', 'Total 500 dollars', 'Price list EUR 2026', '£ ledger', 'cost of 12 thousand'];

// Each (c) reason, with a draft or record holding money text. `percent` is
// the confidence each reading had before this change (755e5623): the new
// wording may not move it.
const reasons = [
  ['the draft claim is itself qualified (rung 2)', 2, 75, /^The draft claim citing cited record 1 is itself qualified/,
    () => payloadFor([row(1, 'The storage fee is $4,000 per month, but payment is pending.')],
      { draft: 'The storage fee is $4,000 per month, but payment is pending [1].', checks: [approve] })],
  ['the draft changes a source figure (rung 3)', 3, 69, /^The draft changes a figure, unit or letter case that cited record 1 states; the source wording is used\.$/,
    () => payloadFor([row(1, FEE)], { draft: 'The storage fee is $4,500 per month [1].', checks: [approve] })],
  ['the record title has unchecked words (rung 2)', 2, 75, /^The title of cited record 1 has words that were not checked against the claim\.$/,
    () => payloadFor([row(1, FEE, { title: 'Storage USD lease WITHDRAWN.pdf' })], { draft: DRAFT, checks: [approve] })],
  ['the record has other unchecked sentences (rung 2)', 2, 75, /^Cited record 1 has another sentence that was not checked against the claim/,
    () => payloadFor([row(1, `${FEE} The late fee is $50.`)], { draft: DRAFT, checks: [approve] })],
  ['an uncited record names the same field (rung 2)', 2, 67, /^Cited record 2 \(2026-10-01\) has a sentence on the same subject that may dispute/,
    () => payloadFor([row(1, FEE), row(2, 'Storage fees were raised to $4,400 per month.', { title: 'Vendor letter $4,400', ts: '2026-10-01T00:00:00.000Z' })],
      { draft: DRAFT, checks: [approve] })],
  ['a newer uncited record (rung 2, draft rejected)', 2, 55, /^Cited record 2 \(2026-11-10\) is newer than the records the draft cited; the draft did not cite it\.$/,
    () => payloadFor([row(1, FEE, { ts: '2026-11-01T00:00:00.000Z' }), row(2, 'Parking is available on site.', { title: 'Rent 2,400 lease [3].docx', ts: '2026-11-10T00:00:00.000Z' })],
      { draft: DRAFT, checks: [reject] })],
  ['an uncited record not provably older (rung 2, draft rejected)', 2, 55, /^Cited record 2 \(date unverified\) is not provably older than the records the draft cited, or names the same subject; the draft did not cite it\.$/,
    () => payloadFor([row(1, FEE, { ts: '2026-11-01T00:00:00.000Z' }), row(2, 'Parking is available on site.', { title: 'Quote for $5,000 project.pdf', ts: null, date_reliable: false })],
      { draft: DRAFT, checks: [reject] })],
  ['partly read records (rung 3)', 3, 59, /^Cited record 1 was only partly read or its text is unverified\.$/,
    () => payloadFor([row(1, FEE, { title: 'Payment 2024 receipts', read_complete: false }), row(2, 'Parking is available on site.', { title: 'Statement balance 2025-10.pdf', text_reliable: false })])],
  ['a text-reading gap names its records (rung 3)', 3, 67, /^A complete reliable reading of cited record 1\.$/,
    () => payloadFor([row(1, FEE, { title: 'Quote for $5,000 project.pdf' })], { gaps: [{ type: 'text_unreliable', detail: 'At least one record has an unverified text reading.' }] })],
];

for (const [name, rung, percent, named, make] of reasons) test(`acceptance passes when a reason would hold money: ${name}`, () => {
  const payload = make();
  assert.equal(payload.answer_contract.rung, rung, 'the reading reached the intended rung');
  assert.equal(answerResponseContractDiagnostic(payload), null, 'acceptance validates the reading');
  assert.ok([...payload.confidence.basis, ...payload.confidence.missing].some(reason => named.test(reason)), `the reason names the record by number: ${explanation(payload)}`);
  assertDocumentAnswer(payload, { provisional: true });
  assert.equal(payload.confidence.percent, percent, 'the wording cannot move confidence');
  // No reason quotes a draft, a source sentence or a title; the figures stay
  // in the attributed quotes.
  assert.doesNotMatch(explanation(payload), /\$|£|USD|EUR|\bdollars\b|4,[045]00|Payment 2024|Statement balance|Rent 2,400|Vendor letter|Quote for|WITHDRAWN|pending|late fee/);
  assert.match(prose(payload), /says: "[^"]*\$4,[04]00 per month/, 'the source figure is still quoted as evidence');
  // The guard is unchanged: the same money text in explanation still fails.
  assert.equal(answerResponseContractDiagnostic(withBasis(payload, 'The record "Quote for $5,000 project.pdf" also says "The late fee is $50."')), BOUNDARY_TEXT);
  assert.equal(answerResponseContractDiagnostic(withBasis(payload, 'The balance is 5,000.')), BOUNDARY_TEXT);
  assert.equal(answerResponseContractDiagnostic(withBasis(payload, 'Confidence: High (95%)')), BOUNDARY_TEXT);
  assert.equal(answerResponseContractDiagnostic(withBasis(payload, 'I cannot answer from these documents.')), BOUNDARY_TEXT);
});

test('partly read records that share a title are counted once, as before, and named together', () => {
  const twins = [row(1, FEE, { title: 'Payment 2024 receipts', read_complete: false }),
    row(2, 'The storage fee covers unit 12.', { title: 'Payment 2024 receipts', read_complete: false, ts: '2026-11-01T00:00:00.000Z' })];
  const payload = payloadFor(twins);
  assert.equal(answerResponseContractDiagnostic(payload), null, 'acceptance validates the reading');
  assert.ok(payload.confidence.basis.includes('Cited records 1 and 2 were only partly read or their text is unverified.'), explanation(payload));
  assert.ok(payload.confidence.missing.includes('The remaining readable text of cited records 1 and 2.'));
  assert.equal(payload.confidence.deductions.filter(d => /partly read/.test(d.reason)).length, 1, 'one deduction for one title, as before');
  assert.equal(payload.confidence.percent, 67, 'pinned on 755e5623');
  assertDocumentAnswer(payload, { provisional: true });
  // Different titles are still separate deductions.
  const pair = payloadFor([twins[0], { ...twins[1], title: 'Statement balance 2025-10.pdf' }]);
  assert.equal(pair.confidence.deductions.filter(d => /partly read/.test(d.reason)).length, 2);
  assert.equal(pair.confidence.percent, 59, 'pinned on 755e5623');
  assert.equal(answerResponseContractDiagnostic(pair), null);
});

// (a) and (b) on their own, with no money anywhere, so each fails on its
// own check before this change.
const UNIT = 'The storage unit is 12 by 20 feet.';
test('(a) a null or empty stored title reads as "untitled" on both sides', () => {
  const results = [row(1, UNIT, { title: null }), row(2, 'The storage unit has a roll-up door.', { title: '' }),
    ...Array.from({ length: 10 }, (_, i) => row(i + 3, `Record ${i + 3} lists the storage contact.`))];
  const arms = [
    // Model failure: every record is quoted with its attribution line.
    ['model failure', payloadFor(results, { question: 'How large is the storage unit?' }), 3, 69],
    // A draft that changes a figure cites record 1 only; the newer untitled
    // record 2 is named on its own line ("its statement is included above").
    ['draft citing one record', payloadFor([row(1, UNIT, { title: null, ts: '2026-11-01T00:00:00.000Z' }), row(2, 'The storage unit has a roll-up door.', { title: null, ts: '2026-11-10T00:00:00.000Z' })],
      { question: 'How large is the storage unit?', draft: 'The storage unit is 12 by 25 feet [1].', checks: [approve] }), 3, 67],
  ];
  for (const [arm, payload, rung, percent] of arms) {
    assert.equal(payload.answer_contract.rung, rung, `${arm}: rung`);
    assert.equal(answerResponseContractDiagnostic(payload), null, `${arm}: acceptance validates the reading`);
    assert.equal(payload.confidence.percent, percent, `${arm}: pinned on 755e5623`);
    assert.match(prose(payload), /the record "untitled" says: /, `${arm}: the untitled decision was reached`);
    assertDocumentAnswer(payload, { provisional: true });
    const relabelled = { ...payload, answer: payload.answer.replace('the record "untitled"', 'the record "Untitled record"') };
    assert.equal(answerResponseContractDiagnostic(relabelled), "the Worker returned prose outside the finalized source-reading shapes", `${arm}: another label fails`);
  }
  assert.match(prose(arms[1][1]), /^"untitled" \(2026-11-10\) \[2\]; its statement is included above\.$/m, 'the uncited-record line decision was reached');
});

test('(b) a 200-character title is cited and attributed whole on both sides', () => {
  const title = 'Storage agreement for the north warehouse units '.padEnd(200, 'x');
  const payload = payloadFor([row(1, UNIT, { title }), ...Array.from({ length: 11 }, (_, i) => row(i + 2, `Record ${i + 2} lists the storage contact.`))],
    { question: 'How large is the storage unit?' });
  assert.equal(payload.answer_contract.rung, 3);
  assert.equal(answerResponseContractDiagnostic(payload), null, 'acceptance validates the reading');
  assert.equal(payload.confidence.percent, 69, 'pinned on 755e5623');
  assert.equal(payload.citations[0].title, title, 'the whole title is cited');
  assert.ok(prose(payload).includes(`the record "${title}" says: `), 'the whole title is attributed');
  assertDocumentAnswer(payload, { provisional: true });
  // Equality stays exact: the old 140-character cut, or any other title, fails.
  for (const other of [title.slice(0, 140), `${title}y`]) {
    const cited = { ...payload, citations: payload.citations.map(c => c.n === 1 ? { ...c, title: other } : c) };
    assert.equal(answerResponseContractDiagnostic(cited), "the Worker's document citation did not identify its numbered result");
  }
  const attributed = { ...payload, answer: payload.answer.replace(`the record "${title}"`, `the record "${title.slice(0, 140)}"`) };
  assert.equal(answerResponseContractDiagnostic(attributed), "the Worker returned prose outside the finalized source-reading shapes");
});

test('a 12-record reading with money-like, untitled and 200-character titles passes at rungs 2 and 3', () => {
  const results = [
    // Record 1 is dated 2026-11-11: record 11 (same day) and record 2 (names
    // the fee) sit beside a draft that cites only it, and record 12 is newer.
    row(1, 'The storage fee is $4,000 per month, but payment is pending. The late fee is $50.', { title: MONEY_TITLES[0], ts: '2026-11-11T00:00:00.000Z' }),
    row(2, 'Storage fees were raised to $4,400 per month.', { title: null }),
    row(3, 'The storage unit is 12 by 20 feet.', { title: '' }),
    row(4, 'The renewal notice for storage is sent in December.', { title: LONG_TITLE, read_complete: false, date_reliable: false }),
    ...MONEY_TITLES.slice(1).map((title, i) => row(i + 5, `Record ${i + 5} lists the storage contact; the balance was 1,${i}00 dollars.`,
      { title, text_reliable: i !== 1 })),
  ];
  assert.equal(results.length, 12);
  const arms = [
    ['model failure', {}, 3, 41],
    ['qualified draft with money', { draft: 'The storage fee is $4,000 per month, but payment is pending [1].', checks: [approve] }, 2, 25],
    ['figure-changing draft', { draft: 'The storage fee is $4,500 per month [1].', checks: [approve] }, 3, 33],
    ['rejected draft', { draft: 'The storage fee is $4,000 per month, but payment is pending [1].', checks: [reject] }, 2, 13],
  ];
  for (const [arm, options, rung, percent] of arms) {
    const payload = payloadFor(results, options);
    assert.equal(payload.answer_contract.rung, rung, `${arm}: rung`);
    assert.equal(answerResponseContractDiagnostic(payload), null, `${arm}: acceptance validates the reading`);
    assert.equal(payload.confidence.percent, percent, `${arm}: pinned on 755e5623`);
    assert.match(prose(payload), /the record "untitled" says: /, `${arm}: the untitled decision was reached`);
    assert.ok(payload.citations.some(c => c.title === LONG_TITLE), `${arm}: the whole 200-character title is cited`);
    assertDocumentAnswer(payload, { provisional: true });
    // Title and citation equality stay exact.
    const cut = { ...payload, citations: payload.citations.map(c => c.title === LONG_TITLE ? { ...c, title: LONG_TITLE.slice(0, 140) } : c) };
    assert.equal(answerResponseContractDiagnostic(cut), "the Worker's document citation did not identify its numbered result", `${arm}: a cut title fails`);
    const relabelled = { ...payload, answer: payload.answer.replace('the record "untitled"', 'the record "Untitled record"') };
    assert.equal(answerResponseContractDiagnostic(relabelled), "the Worker returned prose outside the finalized source-reading shapes", `${arm}: another label fails`);
  }
});

// The real /api/rag/think route: its citation projection, the finalizer and
// acceptance's diagnostic on the same response.
const NOW = Date.parse('2026-11-15T12:00:00Z');
const QUESTION = 'What is the monthly storage fee?';
async function route(t, draft, run) {
  t.mock.method(Date, 'now', () => NOW);
  const f = await createProductFixture({ env: { BRAIN_OWNER: 'Owner Example', BRAIN_TIMEZONE: 'UTC',
    AI: { async run(model, input) {
      if (String(model).includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      const text = (input.messages || []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      if (text.includes('verify a proposed answer')) return { response: { supported: true, complete: true, evidence: [1], reason: 'fixture approval' } };
      if (draft === null) throw new Error('fixture model failure');
      return { response: draft };
    } } } });
  try {
    f.raw("INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES ('records','upload','ready',?,?,?,86400)",
      new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const ingest = async docs => {
      const saved = await f.post('/api/admin/brain/ingest/batch', { docs }, { 'X-Admin-Key': f.env.ADMIN_KEY });
      assert.equal(saved.status, 200, await saved.clone().text());
    };
    const think = async () => {
      const response = await f.post('/api/rag/think', { q: QUESTION, limit: 12 }, { 'X-Admin-Key': f.env.ADMIN_KEY });
      assert.equal(response.status, 200);
      return response.json();
    };
    await run({ f, ingest, think });
  } finally { f.close(); }
}
const stored = (id, title, content) => ({ source_type: 'records', source_id: id, ...(title === undefined ? {} : { title }), content,
  occurred_at: '2026-11-10', date_source: 'fixture:recorded_at', date_reliable: true, text_source: 'native', text_reliable: true,
  metadata: { evidence_lineage: { version: 1, kind: 'source_record' } } });

const titleArms = [
  ['no title and an empty title', [stored('none', undefined, 'The monthly storage fee is listed in the vendor schedule.'),
    stored('empty', '', 'The storage fee schedule is kept by the vendor.'), stored('plain', 'Vendor schedule', 'The storage fee schedule has two pages.')]],
  ['a 200-character title', [stored('long', 'Storage fee schedule for the north warehouse units '.padEnd(200, 'x'), 'The storage fee renewal is due in December.'),
    stored('plain', 'Vendor schedule', 'The storage fee schedule has two pages.')]],
  ['12 records: no title, an empty title, a 200-character title and money-like titles', [
    stored('none', undefined, 'The monthly storage fee is listed in the vendor schedule.'),
    stored('empty', '', 'The storage fee schedule is kept by the vendor.'),
    stored('long', LONG_TITLE, 'The storage fee renewal is due in December.'),
    ...MONEY_TITLES.map((title, i) => stored(`money-${i}`, title, `Storage fee note ${i + 1} lists the vendor contact.`))]],
];
for (const [arm, docs] of titleArms) test(`the real route: ${arm} passes acceptance`, async t => {
  await route(t, null, async ({ f, ingest, think }) => {
    await ingest(docs);
    const body = await think();
    assert.equal(body.answer_contract?.rung, 3);
    assert.equal(body.results.length, docs.length, 'every record was retrieved');
    assert.equal(answerResponseContractDiagnostic(body), null, 'acceptance validates the real owner response');
    for (const stored of docs) {
      const result = body.results.find(r => r.doc_uid === `records:${stored.source_id}`);
      assert.equal(result.title, f.first('SELECT title FROM documents WHERE doc_uid=?', result.doc_uid).title, 'the stored title reached the reading');
      const cited = body.citations.find(c => c.n === body.results.indexOf(result) + 1);
      assert.equal(cited.title, stored.title || 'untitled', 'the citation carries the whole title, or "untitled"');
      assert.ok(prose(body).includes(`the record "${markerSafe(stored.title || 'untitled')}" says: `), 'the attribution carries the same title');
    }
    assertDocumentAnswer(body, { provisional: true });
  });
});

for (const [arm, source, draft, rung, gate, reason] of [
  // The Worker's own money-span check rejects this draft before the verifier;
  // the finalizer still reads it and names the changed figure.
  ['a draft that changes the source figure', FEE, 'The storage fee is $4,500 per month [1].', 3,
    { supported: false, reason: 'A money figure, month list or account identifier does not match the exact cited span.' },
    'The draft changes a figure, unit or letter case that cited record 1 states; the source wording is used.'],
  ['an approved qualified draft holding money', 'The storage fee is $4,000 per month, but payment is pending.',
    'The storage fee is $4,000 per month, but payment is pending [1].', 2,
    { supported: true, reason: 'fixture approval' },
    'The draft claim citing cited record 1 is itself qualified, so it is reported as what the record says.'],
]) test(`the real route: ${arm} passes acceptance with the source figure quoted`, async t => {
  await route(t, draft, async ({ ingest, think }) => {
    await ingest([stored('fee', 'Rent 2,400 lease [3].docx', source)]);
    const body = await think();
    assert.equal(body.evidence_gate?.supported, gate.supported, 'the draft check decision was reached');
    assert.equal(body.evidence_gate.reason, gate.reason);
    assert.equal(body.answer_contract?.rung, rung);
    assert.equal(answerResponseContractDiagnostic(body), null, 'acceptance validates the real owner response');
    assert.ok(body.confidence.basis.includes(reason), `the reason decision was reached: ${explanation(body)}`);
    assert.ok(prose(body).includes(`${source}" [1].`), 'the source figure is quoted as evidence');
    assert.doesNotMatch(explanation(body), /\$|Rent 2,400|4,[05]00|pending/, explanation(body));
    assertDocumentAnswer(body, { provisional: true });
  });
});
