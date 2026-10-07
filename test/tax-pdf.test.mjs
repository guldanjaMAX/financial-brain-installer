import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTaxPdf } from '../ingest/tax-pdf.mjs';
import { taxPdf, PDF_MAP } from './fixtures/tax-pdf.mjs';
import { confirmTaxLine, confirmTaxLines } from '../worker/src/lib/tax-check.js';
import { taxFixture } from './fixtures/tax-check.mjs';
import { financialHash, canonicalFinancialJson } from '../worker/src/lib/financial-snapshot-contract.js';

const extract = (options = {}, map = PDF_MAP, source = 'native') => extractTaxPdf({ bytes: taxPdf(options), formMap: map, textSource: source });
test('real fillable and flattened PDFs propose exact values with no automatic authority', async () => {
  for (const flattened of [false, true]) {
    const result = await extract({ flattened });
    assert.ok(result.trace.includes('fields'));
    assert.equal(result.fields[0].value.amount_minor, '42000');
    assert.equal(result.fields[0].state, 'candidate');
    assert.equal(result.fields[0].authoritative, false);
    assert.equal(result.fields[0].confidence, flattened ? 'native_text_candidate' : 'native_field_candidate');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(['999', '88', '7777'].join('-')));
  }
});
test('malformed map and malformed PDF fail closed without source text or parser errors', async () => {
  assert.equal((await extract()).fields[0].state, 'candidate');
  for (const map of [{ ...PDF_MAP, fields: [null] }, { ...PDF_MAP, version: 123 }, { ...PDF_MAP, page_count: 101 }]) {
    const result = await extract({}, map);
    assert.equal(result.status, 'not_checked'); assert.ok(result.trace.includes('input')); assert.deepEqual(result.fields, []);
  }
  const result = await extractTaxPdf({ bytes: new TextEncoder().encode('not a PDF'), formMap: PDF_MAP });
  assert.equal(result.reason, 'pdf_unreadable'); assert.ok(result.trace.includes('parse')); assert.deepEqual(result.fields, []);
});
test('blank, duplicate, stale field, rotation, OCR and layout refusals reach their gate', async () => {
  assert.equal((await extract()).fields[0].state, 'candidate');
  for (const [options, state] of [[{ value: '' }, 'blank'], [{ widgets: 2 }, 'conflicting'],
    [{ fieldValue: '421.00' }, 'conflicting'], [{ rotation: 90 }, 'unreadable'], [{ value: '4.2e2' }, 'unreadable']]) {
    const result = await extract(options);
    assert.ok(result.trace.includes('fields'));
    assert.equal(result.fields[0].state, state); assert.equal(result.fields[0].value, null);
  }
  for (const textSource of ['ocr', 'ocr_partial', 'unknown']) {
    const result = await extract({}, PDF_MAP, textSource);
    assert.ok(result.trace.includes('fields')); assert.equal(result.fields[0].authoritative, false);
    assert.equal(result.fields[0].confidence, 'candidate_only'); assert.equal(result.text_source, textSource);
  }
});
test('exact signed decimals, comma groups, one cent and unsafe magnitude never use floats', async () => {
  for (const [value, expected] of [['(420.50)', '-42050'], ['-0.01', '-1'], ['1,234.56', '123456'], ['9007199254740993.01', '900719925474099301']]) {
    assert.equal((await extract({ value })).fields[0].value.amount_minor, expected);
  }
  for (const value of ['1,23.00', '1.001', ['999', '88', '7777'].join('-')]) {
    const result = await extract({ value });
    assert.ok(result.trace.includes('fields')); assert.equal(result.fields[0].value, null);
  }
});

test('real PDF candidate becomes a separate hash-bound owner-stated T1 line, including OCR provenance', async () => {
  for (const textSource of ['native', 'ocr']) {
    const parsed = await extract({}, PDF_MAP, textSource);
    const f = await taxFixture({ reported: '420.00' });
    const line = { ...f.tax.tax_line, document_hash: parsed.document_hash };
    f.state.documentHash = parsed.document_hash; f.state.textSource = textSource;
    f.fieldReview.line_hash = await financialHash(canonicalFinancialJson(line));
    f.fieldReview.candidate_hash = parsed.fields[0].candidate_hash;
    const request = { tenant: f.tax.scope.tenant, extraction: parsed, candidate_index: 0, line_context: line };
    const good = await confirmTaxLine(request, f.deps);
    assert.equal(good.ok, true); assert.equal(good.line.extraction, 'owner_confirmed');
    assert.equal(good.line.value.amount_minor, '42000'); assert.equal(parsed.text_source, textSource);
    const noTenant = await confirmTaxLine({ ...request, tenant: undefined }, f.deps);
    assert.equal(noTenant.ok, false); assert.ok(noTenant.trace.includes('candidate'));
    f.fieldReview.candidate_hash = '0'.repeat(64);
    const refused = await confirmTaxLine(request, f.deps);
    assert.equal(refused.ok, false); assert.ok(refused.trace.includes('confirmation'));
    assert.equal(refused.line, null);
  }
});

test('one batch can confirm reviewed fields while leaving an unconfirmed field visibly partial', async () => {
  const f = await taxFixture(), requests = [], reviews = new Map(), hashes = new Set();
  for (let index = 0; index < 2; index++) {
    const extraction = await extract({ value: index === 0 ? '420.00' : '421.00' });
    const line = { ...f.tax.tax_line, document_hash: extraction.document_hash, value: extraction.fields[0].value,
      review_receipt_ref: `field_review_${index}` };
    reviews.set(line.review_receipt_ref, { ...f.fieldReview, receipt_ref: line.review_receipt_ref,
      candidate_hash: extraction.fields[0].candidate_hash, line_hash: await financialHash(canonicalFinancialJson(line)) });
    hashes.add(extraction.document_hash);
    requests.push({ tenant: f.tax.scope.tenant, extraction, candidate_index: 0, line_context: line });
  }
  let reads = 0;
  const deps = { now: f.deps.now,
    readReview: async ({ receipt_ref }) => { reads++; return reviews.get(receipt_ref); },
    readDocument: async ({ document_hash }) => ({ available: hashes.has(document_hash), current: true, document_hash, text_source: 'native', text_reliable: true }) };
  assert.equal((await confirmTaxLines(requests, deps)).status, 'confirmed');
  reviews.get('field_review_1').authenticated = false;
  const partial = await confirmTaxLines(requests, deps);
  assert.equal(partial.status, 'partial'); assert.equal(partial.confirmed, 1); assert.equal(partial.not_confirmed, 1);
  assert.equal(partial.results[1].line, null); assert.ok(reads >= 4);
});
