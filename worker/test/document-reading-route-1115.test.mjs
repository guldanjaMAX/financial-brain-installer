// The real /api/rag/think route over records longer than the 500-chunk read
// page. The reading must stay bounded, keep every [n] a citation, pass the
// Worker's own acceptance contract, and send the models a bounded window of
// each long record that still holds the matching sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerResponseContractDiagnostic } from '../../acceptance.mjs';
import { createProductFixture } from './product-contract-fixture.mjs';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const QUOTE_MAX_CHARS = 4000;
const PROMPT_WINDOW = '(This is a window of a longer record; the rest of the record is not shown.)';
// Small chunks keep a 600-chunk record cheap to store; the 500-chunk read
// page and every boundary rule are the same as with the default geometry.
// One ingest call stays under the D1 statement budget, so a record is stored
// with its first STORED chunks and its remaining chunks are added in SQLite
// (the FTS triggers index them like any stored chunk).
const CHUNK = 256;
const STORED = 300;
const TOTAL = 600;
const QUESTION = 'What does the vendor renewal schedule say?';
const markers = value => [...new Set([...String(value).matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
const prose = body => body.answer.split('\n\nCoverage:')[0];
// One sentence per chunk, padded to exactly one chunk, so chunk i holds line i.
const chunkLine = text => text.padEnd(CHUNK - 1, '.') + ' ';
const lineAt = (lines, n, i) => chunkLine(lines[i] ?? `Archive item ${n}-${i} is routine filler text`);
const longRecord = (lines, n) => Array.from({ length: STORED }, (_, i) => lineAt(lines, n, i)).join('');
function extend(f, docUid, lines, n) {
  const template = f.first('SELECT * FROM chunks WHERE doc_uid=? AND chunk_ix=0', docUid);
  assert.ok(template, 'the stored record has its first chunk');
  assert.equal(f.first('SELECT COUNT(*) AS n FROM chunks WHERE doc_uid=?', docUid).n, STORED, 'one stored line per chunk');
  const header = template.text.slice(0, template.text.indexOf('\n\n') + 2);
  const columns = Object.keys(template).filter(column => column !== 'id');
  const insert = f.sqlite.prepare(`INSERT INTO chunks (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (let ix = STORED; ix < TOTAL; ix++) {
    const row = { ...template, chunk_uid: `${docUid}#${ix}`, chunk_ix: ix, text: header + lineAt(lines, n, ix).trim(), vector_id: null };
    insert.run(...columns.map(column => row[column]));
  }
}
const doc = (id, title, content) => ({ source_type: 'records', source_id: id, title, content, occurred_at: '2026-11-10',
  date_source: 'fixture:recorded_at', date_reliable: true, text_source: 'native', text_reliable: true,
  metadata: { evidence_lineage: { version: 1, kind: 'source_record' } } });

async function fixture(t, run) {
  t.mock.method(Date, 'now', () => NOW);
  const prompts = { answer: [], verify: [] };
  const f = await createProductFixture({ env: { BRAIN_OWNER: 'Owner Example', BRAIN_TIMEZONE: 'UTC', CHUNK_SIZE: String(CHUNK), CHUNK_OVERLAP: '0',
    AI: { async run(model, input) {
      if (String(model).includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      const text = (input.messages || []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      if (text.includes('verify a proposed answer')) { prompts.verify.push(text); return { response: { supported: true, complete: true, evidence: [1], reason: 'fixture' } }; }
      prompts.answer.push(text);
      return { response: run(text) };
    } } } });
  f.raw("INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES ('records','upload','ready',?,?,?,86400)",
    new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString());
  const ingest = async docs => {
    const saved = await f.post('/api/admin/brain/ingest/batch', { docs }, { 'X-Admin-Key': f.env.ADMIN_KEY });
    assert.equal(saved.status, 200, await saved.clone().text());
  };
  return { f, prompts, ingest };
}

async function think(f) {
  const response = await f.post('/api/rag/think', { q: QUESTION, limit: 12 }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(response.status, 200);
  return response.json();
}

for (const arm of ['model failure', 'draft cites [0]']) test(`a 600-chunk record with bracketed digits passes acceptance: ${arm}`, async t => {
  const { f, ingest } = await fixture(t, () => {
    if (arm === 'model failure') throw new Error('fixture model failure');
    return 'The vendor renewal schedule is attached [1]. Row [0] is the first entry.';
  });
  try {
    // Bracketed digits sit inside the 500-chunk page; the only query hit is
    // chunk 550, past the page, so it returns as a separate retrieval excerpt.
    const lines = { 3: 'The ledger note says see item [13] and row[0] for the archive', 550: 'The vendor renewal schedule is set for the first of December' };
    await ingest([doc('archive', 'Archive ledger notes', longRecord(lines, 0))]);
    extend(f, 'records:archive', lines, 0);
    await ingest(Array.from({ length: 11 }, (_, i) => doc(`note-${i + 1}`, `Contact note ${i + 1}`,
      `Contact note ${i + 1} says the vendor renewal schedule is handled by team ${i + 1}.`)));
    const body = await think(f);
    if (arm === 'model failure') assert.equal(body.model, undefined, 'the answer model failed');
    assert.equal(body.answer_contract?.kind, 'document');
    assert.equal(body.answer_contract.rung, 3);
    if (arm !== 'model failure') assert.equal(body.evidence_gate?.reason, 'draft cited an unavailable document');
    const archive = body.results.findIndex(row => row.title === 'Archive ledger notes');
    assert.ok(archive >= 0, 'the long record was retrieved');
    const read = body.results[archive];
    assert.equal(read.read_complete, false, 'the read page stopped at 500 chunks');
    assert.ok(read.snippet.includes('row[0]') && !read.snippet.includes('first of December'), 'the bracketed text is inside the page, the hit is not');
    assert.ok((read.retrieval_excerpts || []).some(span => span.includes('first of December')), 'the out-of-page hit is a retrieval excerpt');
    assert.match(prose(body), /An additional retrieved excerpt from the same record says: /);
    const cited = body.citations.map(c => c.n).sort((a, b) => a - b);
    assert.deepEqual(markers(prose(body)), cited, 'every marker is a citation');
    assert.ok(cited.length >= 12, 'every retrieved record is read');
    const footer = body.answer.length - prose(body).length;
    assert.ok(body.answer.length <= cited.length * (QUOTE_MAX_CHARS + 600) + 2 * CHUNK * 2 + footer, `bounded reading: ${body.answer.length}`);
    assertDocumentAnswer(body, { provisional: true });
    assert.equal(answerResponseContractDiagnostic(body), null, 'acceptance validates the real owner response');
  } finally { f.close(); }
});

test('the answer and verifier prompts carry a bounded window of each long record', async t => {
  const late = n => `The vendor renewal schedule for archive ${n} is code ZQ${n}`;
  const { f, prompts, ingest } = await fixture(t, () => 'The schedule is recorded [1].');
  try {
    for (let n = 1; n <= 12; n++) {
      await ingest([doc(`archive-${n}`, `Archive ${n}`, longRecord({ 450: late(n) }, n))]);
      extend(f, `records:archive-${n}`, { 450: late(n) }, n);
    }
    const body = await think(f);
    assert.equal(prompts.answer.length > 0 && prompts.verify.length > 0, true, 'the answer and verifier decisions were reached');
    assert.equal(body.results.length >= 12, true);
    const [answerPrompt] = prompts.answer;
    for (let n = 1; n <= 12; n++) assert.ok(answerPrompt.includes(late(n)), `record ${n} keeps its matching late sentence`);
    for (const prompt of [answerPrompt, prompts.verify[0]]) {
      const windows = prompt.split(`${PROMPT_WINDOW}\n`).slice(1).map(part => part.split('\n')[0]);
      assert.ok(windows.length >= 1, 'long records are sent as windows');
      for (const window of windows) assert.ok(window.length <= 8000, `window within the bound: ${window.length}`);
    }
    assert.equal(answerPrompt.split(PROMPT_WINDOW).length - 1, 12, 'all 12 long records are windowed');
    // Unbounded, the 12 records alone were 12 x 153,600 characters.
    assert.ok(answerPrompt.length < 12 * 9000 + 20_000, `answer prompt is bounded: ${answerPrompt.length}`);
    assert.ok(prompts.verify[0].length < 12 * 9000 + 20_000, `verifier prompt is bounded: ${prompts.verify[0].length}`);
    // The finalizer still reads the whole stored record: no High from a window.
    assert.ok(body.confidence.percent < 90, body.confidence_text);
    assert.equal(answerResponseContractDiagnostic(body), null);
  } finally { f.close(); }
});
