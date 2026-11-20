import { handleMcp } from '../src/lib/mcp-endpoint.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as worker from '../src/lib/answer-render.js';
import * as app from '../../frontend/src/lib/answer-render.js';
import { documentResponseConfidence } from '../src/lib/confidence.js';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';

for (const surface of [worker, app]) for (const supplied of [null, 99]) {
  test(`legacy coverage has a scored provisional answer (${surface === worker ? 'worker' : 'app'}, ${supplied})`, () => {
    const green = { answer: 'The stated amount is $125.00 [1].', results: [{ title: 'Record' }],
      confidence: { percent: 75, basis: ['one supported record'] } };
    assert.match(surface.answerText(green), /\$125\.00/);
    assert.match(surface.confidenceText(green), /Confidence: Medium \(75%\)/);
    const body = { status: 'coverage_incomplete', notice: 'Source coverage is incomplete. This result is provisional.',
      answer: 'The documents do not answer the question.', results: [{ title: 'Candidate' }],
      ...(supplied === null ? {} : { confidence: { percent: supplied, basis: ['legacy'] } }) };
    const reference = finalizeDocumentAnswer({ draft: body.answer, docs: body.results, searchComplete: false });
    assert.ok(surface.answerText(body).trim());
    assert.match(surface.answerText(body), /provisional/);
    assert.doesNotMatch(surface.answerText(body), /The documents do not answer/);
    assert.match(surface.answerText(body), /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    assert.match(surface.confidenceText(body), /Confidence: Low \(10%\).*Why:.*Missing:/s);
    assert.equal(documentResponseConfidence(body).percent, reference.confidence.percent, 'MCP uses the same evidence ceiling');
    assert.doesNotMatch(surface.confidenceText(body), /High/);
    const positive = { ...body, answer: 'Possible matches are provisional.', confidence: { percent: 99, basis: ['legacy'] } };
    assert.ok(documentResponseConfidence(positive).percent <= reference.confidence.percent, 'a noncategorical legacy draft cannot retain High');
    const gapped = { ...positive, status: undefined, gaps: [{ type: 'history_unproven', detail: 'History is still loading.' }] };
    assert.ok(documentResponseConfidence(gapped).percent <= reference.confidence.percent, 'missing legacy status cannot hide declared gaps');
  });
}

for (const percent of [null, 99]) test(`remote document renderer scores a raw compatibility body (${percent})`, async () => {
  let reads = 0;
  const url = new URL('https://brain.invalid/mcp');
  const request = new Request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1,
    method: 'tools/call', params: { name: 'ask', arguments: { question: 'What do the policy documents say?' } } }) });
  const response = await handleMcp({}, request, url, { grant: { profile: 'read-only' }, think: async () => {
    reads++;
    return { status: 'coverage_incomplete', notice: 'Source coverage is incomplete. This result is provisional.',
      answer: 'The documents do not answer the question.', results: [{ title: 'Candidate' }],
      ...(percent === null ? {} : { confidence: { percent, basis: ['legacy'] } }) };
  } });
  assert.equal(reads, 1, 'real document rendering decision reached');
  const rpc = await response.json();
  assert.equal(rpc.result.isError, undefined);
  const text = rpc.result.content.map(item => item.text).join('\n');
  assert.doesNotMatch(text, /Confidence:|\b(?:High|Medium|Low)\s*\(?\d+%/);
  assert.match(text, /may be incomplete/);
  assert.match(text, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.doesNotMatch(text, /High|The documents do not answer/);
});
