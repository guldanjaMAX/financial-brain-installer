// 0.4.28 reads whole stored records (up to 500 chunks each). On a large
// Brain the source reading pasted every record whole (one answer ran past a
// million characters), and bracketed digits copied from source text read as
// citation markers, so acceptance failed with "the Worker's document answer
// and citations did not agree". Each quote is now bounded, a long record is
// named as partly quoted, and source "[n]" text cannot read as a citation.
// None of this may raise confidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeDocumentAnswer, documentPromptWindow, documentRecordSentences, markerSafe } from '../src/lib/document-answer.js';
import { answerSentences } from '../src/lib/answer-sentences.js';
import { chunkText } from '../src/lib/store.js';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';

// A reading of 12 records quotes each within 4,000 characters; the 12
// records share 48,000, so a reading of fewer records keeps longer spans.
const QUOTE_MAX_CHARS = 4000;
const READING_QUOTE_CHARS = 48000;
const flat = value => String(value).replace(/\s+/g, ' ').trim();
const prose = body => body.answer.split('\n\nCoverage:')[0];
const markers = value => [...new Set([...String(value).matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
const quotes = value => [...String(value).matchAll(/says: ("(?:\\.|[^"\\])*") \[(\d+)\]/g)].map(m => ({ text: JSON.parse(m[1]), n: Number(m[2]) }));
const range = n => Array.from({ length: n }, (_, i) => i + 1);
const unavailable = [{ supported: false, complete: false, error: 'Answer model or evidence check unavailable.' }];
const record = (n, snippet, extra = {}) => ({ n, title: `Record ${n}`, source: 'records',
  ts: `2026-11-${String(n).padStart(2, '0')}T00:00:00.000Z`, date_reliable: true, text_source: 'native', text_reliable: true,
  read_complete: true, snippet, ...extra });
// The stored read joins chunks that each start with the "[title]" label.
const stored = (title, body) => chunkText(body, { header: `[${title}]` }).join('\n\n').replace(/\s+/g, ' ');
// Eleven short companions make a 12-record reading (the 4,000 bound).
const withCompanions = first => [first, ...range(11).map(i => record(i + 2, `Record ${i + 2} lists a contact.`))];
const read = (docs, extra = {}) => finalizeDocumentAnswer({ question: 'When does the vendor renew?', draft: null, docs,
  approvedDocs: [], checks: unavailable, gaps: [], retrievedCount: docs.length, searchComplete: true, asOf: '2026-11-15', ...extra });

test('a rung-3 reading of 12 large qualified records is bounded and cannot gain confidence', () => {
  // Every sentence carries "if" and "not", so each record was quoted whole.
  const clause = (i, r) => `Clause ${i} of record ${r} applies if the parties agree and is not changed.`;
  const docs = range(12).map(n => record(n, range(3000).map(i => clause(i, n)).join(' ')));
  assert.ok(docs.every(d => d.snippet.length >= 200_000), 'each record is at least 200K characters');
  const body = read(docs);
  assert.equal(body.answer_contract.rung, 3, 'the model-null path reached the source reading');
  const footer = body.answer.length - prose(body).length;
  assert.ok(body.answer.length <= 12 * (QUOTE_MAX_CHARS + 600) + footer, `bounded reading: ${body.answer.length}`);
  const quoted = quotes(prose(body));
  assert.equal(quoted.length, 12, 'every readable record is quoted');
  for (const quote of quoted) {
    assert.ok(quote.text.length <= QUOTE_MAX_CHARS, `quote of record ${quote.n} is bounded`);
    assert.ok(flat(docs[quote.n - 1].snippet).includes(quote.text), `quote of record ${quote.n} is one source span`);
  }
  assert.deepEqual(markers(prose(body)), range(12), 'every marker is a citation');
  for (const n of range(12)) {
    assert.ok(body.confidence.basis.includes(`Only part of cited record ${n} is quoted; its other sentences were not checked against the answer.`),
      `record ${n} is named as partly quoted`);
  }
  // Pinned on ac6a7368 (the unbounded reading) for this exact fixture.
  assert.equal(body.confidence.percent, 63, 'the bound cannot raise confidence');
  assert.ok(body.confidence.percent <= 69);
});

test('bracketed digits in source text and titles never read as citation markers', () => {
  const source = 'The vendor renews on 2026-12-01 [0]. See item [13] and row[0].';
  const docs = range(12).map(n => n === 1
    ? record(1, source, { title: 'Scan [2].pdf' })
    : record(n, `Record ${n} lists the vendor contact for renewal questions.`));
  const body = read(docs);
  const reading = prose(body);
  assert.equal(body.answer_contract.rung, 3);
  assert.deepEqual(markers(reading), body.usedDocs.map(d => d.n).sort((a, b) => a - b), 'prose markers are the citations');
  assert.doesNotMatch(reading, /\[(?:0|13)\]/, 'no source bracket survives as a marker before Coverage');
  assert.ok(!reading.includes('Scan [2]'), 'the title bracket is not a marker either');
  const first = /^Likely relevant: As of [^,]+, the record ("(?:\\.|[^"\\])*") says: ("(?:\\.|[^"\\])*") \[1\]\.$/m.exec(reading);
  assert.ok(first, 'record 1 has its attribution line');
  assert.equal(JSON.parse(first[1]), 'Scan [2].pdf', 'the title slot decodes to the exact source title');
  assert.equal(JSON.parse(first[2]), flat(source), 'the quote decodes to the exact source text');
  assert.equal(first[1], `"${markerSafe('Scan [2].pdf')}"`);
});

test('an uncited newer record line carries its escaped title and markers stay citations', () => {
  const docs = [record(1, 'The vendor renews on 2026-12-01.', { ts: '2026-11-01T00:00:00.000Z' }),
    ...[2, 3].map(n => record(n, `Record ${n} reports the vendor renewal on 2026-12-0${n}.`, { title: `Record [13] part ${n}`, ts: '2026-11-10T00:00:00.000Z' }))];
  // A verifier error rules out rung 2, so every readable record is quoted and
  // the newer uncited records are listed as already included above.
  const body = read(docs, { draft: 'The vendor renews on 2026-12-01 [1].', checks: [{ supported: false, complete: false, error: 'verification unavailable' }] });
  const reading = prose(body);
  assert.equal(body.answer_contract.rung, 3);
  for (const n of [2, 3]) {
    assert.ok(reading.includes(`"${markerSafe(`Record [13] part ${n}`)}" (2026-11-10) [${n}]; its statement is included above.`),
      `record ${n} is listed with its escaped title`);
  }
  assert.deepEqual(markers(reading), [1, 2, 3], 'prose markers are the citations');
});

for (const [label, title, question] of [
  ['the plan fixture', 'Review memo', 'What is the review code in the memo?'],
  // Here the label matches three question words and the answer sentence two:
  // without removing the label the window would sit on the first chunk.
  ['a title that names more question words', 'Vendor review memo', 'What is the review code in the vendor review memo?'],
]) test(`the quote window anchors on the answer sentence, not on chunk labels: ${label}`, () => {
  const snippet = stored(title, 'Background. '.repeat(1000) + 'The review code is 125000.');
  assert.ok(snippet.length > QUOTE_MAX_CHARS && snippet.includes(`[${title}]`));
  const body = read(withCompanions(record(1, snippet, { title })), { question });
  const [quote] = quotes(prose(body));
  assert.match(quote.text, /The review code is 125000\./, 'the anchored sentence is quoted');
  assert.ok(quote.text.length <= QUOTE_MAX_CHARS);
  assert.ok(flat(snippet).includes(quote.text), 'the window is one contiguous source span');
  assert.ok(body.confidence.basis.includes('Only part of cited record 1 is quoted; its other sentences were not checked against the answer.'));
});

test('a reading of one record shares the whole budget: a signing date past 4,000 characters stays quoted', () => {
  // The cross-source red-team case (RT-13): who signed and when, with the
  // date at the end of a record longer than 4,000 characters.
  const filler = range(40).map(i => `Section ${i}. General obligations of the parties regarding scheduling and routine notices are set out here.`).join('\n');
  const snippet = `Supplier agreement. Signed by the owner and by the director of the supplier.\n${filler}\nSignature page. Executed on the fourth day of March by both parties.`;
  assert.ok(snippet.length > QUOTE_MAX_CHARS && snippet.length < READING_QUOTE_CHARS);
  const one = read([record(1, snippet, { title: 'Supplier agreement' })], { question: 'Who signed the supplier agreement and when?' });
  const [quote] = quotes(prose(one));
  assert.match(quote.text, /Signed by the owner/);
  assert.match(quote.text, /fourth day of March/, 'the signing date stays in a one-record reading');
  // The same record among 12 is bounded to 4,000 characters and named partial.
  const twelve = read(withCompanions(record(1, snippet, { title: 'Supplier agreement' })), { question: 'Who signed the supplier agreement and when?' });
  const [bounded] = quotes(prose(twelve));
  assert.ok(bounded.text.length <= QUOTE_MAX_CHARS && flat(snippet).includes(bounded.text));
  assert.ok(twelve.confidence.basis.includes('Only part of cited record 1 is quoted; its other sentences were not checked against the answer.'));
  assert.ok(twelve.confidence.percent <= one.confidence.percent, 'the bound never raises confidence');
});

test('control: a record under the bound with a qualifier is still quoted whole', () => {
  const snippet = range(68).map(i => `Paragraph ${i} explains the lease terms unless amended.`).join(' ');
  assert.ok(snippet.length > 3500 && snippet.length <= QUOTE_MAX_CHARS, `control length ${snippet.length}`);
  const body = read([record(1, snippet, { title: 'Lease memo' })], { question: 'What are the lease terms?' });
  const [quote] = quotes(prose(body));
  assert.equal(quote.text, snippet, 'the whole record is the quote');
  assert.ok(!body.confidence.basis.some(reason => /^Only part of /.test(reason)), 'a whole quote is not named partial');
});

test('control: a small grounded rung-1 draft keeps its exact answer and High', () => {
  const docs = [1, 2, 3].map(n => ({ n, title: `Specification ${n}`, source: `records-${n}`, snippet: 'The hazard class is Co.',
    ts: '2026-11-11', date_reliable: true, text_source: 'native', text_reliable: true, read_complete: true,
    authority: { tier: 'T1', rank: 1, eligible: true, authoritative: true }, lineage: { status: 'known', family_tokens: [`independent-${n}`] } }));
  const draft = 'The hazard class is Co [1][2][3].';
  const body = finalizeDocumentAnswer({ question: 'What hazard class does the specification state?', draft, docs, approvedDocs: docs,
    checks: [{ supported: true, complete: true, evidence: [1, 2, 3], reason: 'synthetic approval' }], searchComplete: true });
  assert.equal(body.answer_contract.rung, 1);
  assert.equal(prose(body), draft, 'the admitted draft is unchanged');
  assert.ok(body.confidence.percent >= 90, body.confidence_text);
});

test('control: an over-limit record with no usable sentence edge returns a bounded contiguous slice', () => {
  for (const snippet of ['word '.repeat(2400).trim(), 'x'.repeat(10_000)]) {
    let body;
    assert.doesNotThrow(() => { body = read(withCompanions(record(1, snippet))); });
    const [quote] = quotes(prose(body));
    assert.ok(quote.text.length > 0 && quote.text.length <= QUOTE_MAX_CHARS, `bounded: ${quote.text.length}`);
    assert.ok(flat(snippet).includes(quote.text), 'one contiguous source span');
  }
});

test('the prompt window of a long record keeps the matching late sentence within the bound', () => {
  const body = stored('Vendor file', range(900).map(i => `Line ${i} is routine filler about storage.`).join(' ') +
    ' The vendor renewal date is 2026-12-01. ' + range(300).map(i => `Tail ${i} is routine filler.`).join(' '));
  const window = documentPromptWindow({ title: 'Vendor file', snippet: body }, 'When is the vendor renewal date?');
  assert.ok(window && window.text.length <= 8000, 'the window is bounded');
  assert.match(window.text, /The vendor renewal date is 2026-12-01\./);
  assert.equal(flat(body).slice(window.start, window.end), window.text, 'the window is one contiguous span');
  assert.equal(documentPromptWindow({ title: 'Short', snippet: 'A short record.' }, 'When?'), null, 'a short record is sent whole');
});

// Round 2. A partly quoted record was named by its raw title in the
// confidence reasons and the footer's Missing line, and acceptance reads a
// money-like title there ("Payment 2024 receipts", "Quote for $5,000") as a
// money figure. Explanation text now names the record by its citation number.
const qualified = range(120).map(i => `Clause ${i} of this statement applies if the parties agree and is not changed by the bank.`).join(' ');
const MONEY_TITLES = ['Statement balance 2025-10.pdf', 'Quote for $5,000 project.pdf', 'Payment 2024 receipts', 'Stripe payout USD export'];
const STATEMENT_QUESTION = 'What does the statement say about the vendor?';
// Records numbered 1-12 in result order, so citation n is results[n - 1].
const twelveWith = first => [first, ...range(11).map(i => record(i + 1, `Record ${i + 1} lists a contact.`))];
const routeBody = (body, docs) => ({ ...body, results: docs, gaps: [],
  citations: body.usedDocs.map(d => ({ n: d.n, title: d.title, source: d.source })) });

test('a partly quoted record is named by its citation number, never by its title', () => {
  assert.ok(qualified.length > QUOTE_MAX_CHARS, 'the qualified record is longer than the bound');
  const plain = read(twelveWith(record(1, qualified, { title: 'Vendor statement October.pdf' })), { question: STATEMENT_QUESTION });
  for (const title of MONEY_TITLES) {
    const docs = twelveWith(record(1, qualified, { title }));
    const body = read(docs, { question: STATEMENT_QUESTION });
    assert.equal(body.answer_contract.rung, 3, 'the model-null source reading was reached');
    assert.ok(body.confidence.basis.includes('Only part of cited record 1 is quoted; its other sentences were not checked against the answer.'));
    assert.ok(body.confidence.missing.includes('The complete text of cited record 1 checked against the answer.'));
    const explanation = [...body.confidence.basis, ...body.confidence.missing, body.confidence_text, body.answer.slice(prose(body).length)];
    assert.ok(explanation.every(value => !value.includes(title)), `no explanation text carries the title "${title}"`);
    // The reference changes wording only: the same reading with a plain
    // title has the same confidence.
    assert.equal(body.confidence.percent, plain.confidence.percent, 'the title cannot change confidence');
    assert.ok(body.confidence.percent <= 69);
    // The test oracle reads "cited record 1" as this body's own citation.
    assertDocumentAnswer(routeBody(body, docs), { provisional: true });
  }
});

test('control: the test oracle still rejects a reference to a record this body does not cite', () => {
  const docs = twelveWith(record(1, qualified, { title: 'Payment 2024 receipts' }));
  const body = routeBody(read(docs, { question: STATEMENT_QUESTION }), docs);
  assertDocumentAnswer(body, { provisional: true });
  const from = 'The complete text of cited record 1 checked', to = 'The complete text of cited record 8642 checked';
  const tampered = { ...body, answer: body.answer.replace(from, to),
    confidence: { ...body.confidence, missing: body.confidence.missing.map(value => value.replace(from, to)) } };
  assert.notEqual(tampered.answer, body.answer, 'the tampered reference reached the footer');
  assert.throws(() => assertDocumentAnswer(tampered, { provisional: true }), /a figure in the missing line comes from this body's metadata: 8642/);
});

// A long record with no full stops (a spreadsheet, a CSV export, an OCR form)
// was cut every 8,000 characters at any character, so a quote could start
// inside a figure and the Low reading often left out the row the question
// asked about. Pieces are now cut at whitespace, never inside a figure.
const FIGURE_CHAR = /[\d$.,]/;
const splitsFigure = (value, at) => at > 0 && at < value.length && FIGURE_CHAR.test(value[at - 1]) && FIGURE_CHAR.test(value[at]) &&
  (/\d/.test(value[at - 1]) || /\d/.test(value[at]));
function ledger(row, pos, figureFirst) {
  const rows = range(3000).map(i => {
    const date = `2026-01-${String(i % 28 + 1).padStart(2, '0')}`;
    const amount = `$1,${String(i % 1000).padStart(3, '0')}.${String(i % 100).padStart(2, '0')}`;
    return figureFirst ? `${date} | ${amount} | Vendor ${i} | Office supplies` : `${date} | Vendor ${i} | Office supplies | ${amount}`;
  });
  rows[pos] = row;
  return rows.join(' ; ');
}

for (const figureFirst of [false, true]) test(`a 170k-character table quotes the asked row whole and no edge splits a figure (${figureFirst ? 'figure first' : 'figure last'})`, () => {
  const question = 'How much was the Zephyr Logistics freight retainer?';
  const row = figureFirst ? '2026-07-04 | $48,250.00 | Zephyr Logistics | Freight retainer' : '2026-07-04 | Zephyr Logistics | Freight retainer | $48,250.00';
  const percents = new Set();
  // Positions 101 rows apart move the row across many piece boundaries.
  for (let pos = 7; pos < 3000; pos += 101) {
    const table = ledger(row, pos, figureFirst);
    assert.ok(table.length >= 165_000 && !table.includes('. '), 'a long table with no full stops');
    const body = read(withCompanions(record(1, table, { title: 'Ledger sheet' })), { question });
    assert.equal(body.answer_contract.rung, 3);
    const [quote] = quotes(prose(body));
    assert.ok(quote.text.length <= QUOTE_MAX_CHARS, `bounded quote at row ${pos}`);
    assert.ok(quote.text.includes(row), `the asked row is quoted whole at row ${pos}`);
    const at = table.indexOf(quote.text);
    assert.ok(at >= 0, 'the quote is one contiguous source span');
    assert.ok(!splitsFigure(table, at) && !splitsFigure(table, at + quote.text.length), `the quote edges keep every figure whole at row ${pos}`);
    const window = documentPromptWindow({ title: 'Ledger sheet', snippet: table }, question);
    assert.ok(window.text.length <= 8000 && window.text.includes(row), `the prompt window holds the row at row ${pos}`);
    assert.equal(table.slice(window.start, window.end), window.text);
    assert.ok(!splitsFigure(table, window.start) && !splitsFigure(table, window.end), `the prompt window edges keep every figure whole at row ${pos}`);
    percents.add(body.confidence.percent);
  }
  assert.deepEqual([...percents], [63], 'the Low reading keeps its confidence wherever the row sits');
});

test('a rent roll quote and prompt window never start or end inside a figure', () => {
  const question = 'What is the Harbor lease deposit?';
  for (let pad = 0; pad < 20; pad++) {
    const rows = range(1500).map(i => `Unit ${i} rent $12,345,678.90`);
    rows[700] = 'Unit 700 Harbor lease deposit $98,765,432.10';
    const table = 'x'.repeat(pad) + ' ' + rows.join(' ; ');
    const docs = withCompanions(record(1, table, { title: 'Rent roll' }));
    for (const reading of [docs, docs.slice(0, 1)]) {
      const [quote] = quotes(prose(read(reading, { question })));
      const at = table.indexOf(quote.text);
      assert.ok(at >= 0 && quote.text.includes('Unit 700 Harbor lease deposit $98,765,432.10'), `the asked row is quoted (pad ${pad})`);
      assert.ok(!splitsFigure(table, at) && !splitsFigure(table, at + quote.text.length), `quote edges (pad ${pad}): ${quote.text.slice(0, 24)}`);
    }
    const window = documentPromptWindow({ title: 'Rent roll', snippet: table }, question);
    assert.ok(window.text.includes('Harbor lease deposit $98,765,432.10'));
    assert.ok(!splitsFigure(table, window.start) && !splitsFigure(table, window.end), `prompt window edges (pad ${pad}): ${window.text.slice(0, 24)}`);
  }
});

test('a long record whose sentences fit a block splits exactly as the shared splitter does', () => {
  const pool = ['Acme Inc. paid the deposit of $1,234.56 on time.', 'The U.S. Bank statement lists the transfer.', 'Dr. Smith signed the lease on 2026-03-04.',
    'Payment terms are net 30 unless amended.', 'The fee was $5,000.00. [1] It rose later.', 'Section 4.2 applies to every unit.',
    `${'A long clause about routine storage terms '.repeat(30).trim()}.`];
  const body = range(300).map(i => pool[(i * 5) % pool.length]).join(" ");
  assert.ok(body.length > 50_000);
  assert.deepEqual(documentRecordSentences(body), answerSentences(body), 'every sentence matches the shared splitter');
  // A record with no whitespace and no sentence end is still cut, but never
  // inside a figure.
  const csv = range(4000).map(i => `v${i}|$${i},${String(i % 1000).padStart(3, '0')}.${String(i % 100).padStart(2, '0')}`).join(';');
  const pieces = documentRecordSentences(csv);
  assert.equal(pieces.join(''), csv, 'the pieces cover the record in order');
  let at = 0;
  for (const piece of pieces.slice(0, -1)) {
    at += piece.length;
    assert.ok(piece.length <= 1600 && !splitsFigure(csv, at), `piece edge at ${at} keeps every figure whole`);
  }
});
