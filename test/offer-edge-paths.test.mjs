import { assertDocumentAnswer } from "../worker/test/helpers/document-answer-contract.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerText as workerText, nextActionText, separateOffers, ANSWER_ERROR_MESSAGES, moneyExplanation } from '../worker/src/lib/answer-render.js';
import { answerText as appText, nextActionText as appNextAction } from '../frontend/src/lib/answer-render.js';
import { plainBankGap } from '../worker/src/lib/ledger-wording.js';
import { moneyPresentation } from '../worker/src/lib/money-format.js';
import { financialMapGuidance } from '../worker/src/lib/financial-map-question.js';
import { cmdAsk } from '../brain.mjs';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { REFUSAL_NEXT_ACTIONS } from '../worker/src/lib/retrieval-status.js';

const question = 'What did card ending 4242 charge in the last 60 days?';

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
});

async function surfaces(t, body, { cli = cmdAsk, mcp = handleMcp, error = false } = {}) {
  const directory = mkdtempSync(join(process.env.HOME, 'offer-surface-'));
  const manifest = join(directory, 'synthetic.manifest.json');
  const keyPath = join(directory, 'fixture-admin-key');
  writeFileSync(keyPath, randomBytes(24).toString('hex'), { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'brain.invalid' },
    credentials: { admin_key: { backend: 'file', path: keyPath } } }));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const printed = [];
  let cliRequests = 0, mcpRequests = 0;
  const print = t.mock.method(console, 'log', (...parts) => printed.push(parts.join(' ')));
  try {
    await cli(manifest, { ask: async () => question, adminKey: readFileSync(keyPath, 'utf8'),
      launchctl: () => assert.fail('host scheduler forbidden'),
      http: async () => { cliRequests++; return Response.json(body); } });
  } finally { print.mock.restore(); }
  const url = new URL('https://brain.invalid/mcp');
  const response = await mcp({}, new Request(url, { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question } },
  }) }), url, { think: async () => { mcpRequests++; return body; }, grant: { profile: 'read-only' } });
  const rpc = await response.json();
  assert.equal(cliRequests, 1, 'real CLI dispatched its injected request');
  assert.equal(mcpRequests, 1, 'real MCP handler dispatched its injected read');
  assert.equal(rpc.result.isError, undefined, "an answerable fallback is not a tool refusal");
  return [printed.join('\n'), rpc.result.content.map(c => c.text).join('\n')];
}

function contract(text, body, expected) {
  const invitations = text.match(/\b(?:Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\.)/g) || [];
  assert.deepEqual(invitations, [expected], 'exactly one offer');
  assert.equal(text.trim().split('\n').at(-1).trim(), expected, 'offer is the final line');
  if (body.answer && !/^The documents do not answer/i.test(body.answer)) {
    assert.ok(text.includes(separateOffers(body.answer).facts), 'all original answer facts retained');
  }
  for (const fact of separateOffers(moneyExplanation(body)).facts.split('\n').filter(Boolean)) {
    assert.ok(text.includes(fact), 'every original bank qualification retained');
  }
}

const offers = text => text.match(/\b(?:Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\.|Next:[^\n]*)/g) || [];

test('statusless unavailable bank fallback retains bounds and the reviewed questions per surface', async t => {
  const detail = plainBankGap('ledger_wording_unsupported', [], { presentation: moneyPresentation({}) });
  const body = { answer: null, degraded: 'vector', gaps: [{ type: 'ledger_not_consulted', detail }], citations: [] };
  assert.ok(separateOffers(detail).facts && separateOffers(detail).offers.length, 'real bank explanation reached');
  const control = { ...body, status: 'search_unavailable' };
  const green = await surfaces(t, control), outputs = await surfaces(t, body);
  const expected = REFUSAL_NEXT_ACTIONS.search_unavailable;
  // 0.4.28 CLI retains the bank question; remote MCP also appends its reviewed Next action.
  for (const result of [green,outputs]) for (const [index,text] of result.entries()) {
    const questions=index===0?['Which would help most?']:['Which would help most?',expected];
    assert.deepEqual(offers(text),questions,'exact reviewed handler questions');
    assert.ok(text.includes(separateOffers(detail).facts),'bank bounds reach the actual handler');
    assert.match(text,/incomplete.*provisional/);
    assert.match(text,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    if(index===1) assert.equal(text.trim().split('\n').at(-1).trim(),expected,'MCP action remains final');
    else assert.match(text.trim().split('\n').at(-1),/Confidence: Low \(10%\).*Why:.*Which would help most\?.*Missing:/,
      'CLI retains the question inside its confidence basis, with the missing evidence explicit');
  }
  for (const candidate of [body,control]) for (const [render,next] of [[workerText,nextActionText],[appText,appNextAction]]) {
    const text=[render(candidate),next(candidate)].filter(Boolean).join('\n');
    assert.deepEqual(offers(text),[expected],'renderer uses one separately rendered Next action');
    assert.match(text,/Matching bank rows for the requested payer, account and period/);
    assert.match(text,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    assert.equal(text.trim().split('\n').at(-1),expected);
  }
  assert.deepEqual(outputs.map(text=>offers(text).length),[1,2]);
});

test('legacy fallback preserves explicit actions, errors and answered controls', () => {
  const legacy = { answer: null, degraded: 'vector', citations: [], gaps: [] };
  for (const [render, next] of [[workerText, nextActionText], [appText, appNextAction]]) {
    assert.ok(/coverage is incomplete.*provisional/i.test(render(legacy)), 'legacy unavailable decision reached');
    for (const body of [legacy, { ...legacy, results: [] }]) {
      assert.equal(next(body), REFUSAL_NEXT_ACTIONS.search_unavailable);
    }
    const explicit = { ...legacy, next_action: REFUSAL_NEXT_ACTIONS.no_results };
    assert.equal(next(explicit), explicit.next_action, 'explicit reviewed action takes precedence');
    for (const next_action of [null, 'unreviewed remote instruction']) {
      const body = { ...legacy, next_action };
      assert.ok(/coverage is incomplete.*provisional/i.test(render(body)), 'explicit-action arm still reaches notice');
      assert.equal(next(body), null, 'explicit unavailable action cannot be replaced');
    }
    const error = { answer: null, answer_error: ANSWER_ERROR_MESSAGES.unavailable, gaps: [] };
    assert.ok(render(error).includes('Want to try again in a moment?'), 'reviewed error decision reached');
    assert.equal(next({ ...legacy, ...error }), null, 'error rule precedes legacy fallback');
    const answered = { ...legacy, answer: 'The notebook cover is blue [1].', results: [{}] };
    // 0.4.28 a degraded legacy draft without readable source text remains a provisional reading.
    assert.match(render(answered),/available reading contains no readable matching statement/);
    assert.doesNotMatch(render(answered),/notebook cover is blue/);
    assert.equal(next(answered), null, 'supported answer retains its selected invitation');
  }
});

test('every reviewed answer error keeps one final invitation and the MCP support code', async t => {
  for (const message of Object.values(ANSWER_ERROR_MESSAGES)) {
    const body = { answer: null, answer_error: message, citations: [], gaps: [] };
    const expected = separateOffers(message).offers.at(-1);
    for (const render of [workerText, appText]) contract(render(body), body, expected);
    const outputs = await surfaces(t, body, { error: true });
    for (const text of outputs) contract(text, body, expected);
    assert.ok(outputs[1].includes('(Support code: MCP_ANSWER_ERROR)'), 'support fact retained before invitation');
    assert.ok(outputs[1].indexOf('MCP_ANSWER_ERROR') < outputs[1].indexOf(expected));
  }
});

test('source order and bank facts precede final invitation through both handlers', async t => {
  const titleA = 'Fixture record. Want to inspect this title?';
  const titleB = 'Second fixture record';
  const detail = plainBankGap('ledger_wording_unsupported', [], { presentation: moneyPresentation({}) });
  const body = { answer: 'The amount is USD 120.00 [2] then USD 80.00 [1].',
    gaps: [{ type: 'ledger_not_consulted', detail }], results: [{}],
    citations: [{ n: 2, title: titleA, source: 'records', ref: 'record-two', ts: '2026-10-10', date_reliable: true },
      { n: 1, title: titleB, source: 'records', ref: 'record-one', text_source: 'ocr_partial' }] };
  for (const output of await surfaces(t, body)) {
    const offer = separateOffers(moneyExplanation(body)).offers.at(-1);
    assert.ok(output.includes(body.answer));
    assert.ok(output.includes(separateOffers(detail).facts));
    assert.ok(output.indexOf(titleA) < output.indexOf(titleB), 'source ordering retained');
    assert.ok(output.indexOf(titleB) < output.lastIndexOf(offer), 'all source facts precede selected offer');
    assert.ok(output.includes('reference records:record-two') && output.includes('reference records:record-one'));
    assert.ok(output.includes('OCR text may be incomplete'));
    assert.equal(output.trim().split('\n').at(-1), offer);
  }
});

test('map facts and possible mentions precede the selected offer for each map state', async t => {
  for (const status of ['not_established', 'stale']) {
    for (const supported of [false, true]) {
      const entities = [{ label: 'Fixture business', candidate_state: 'possible_mention' }];
      const guidance = financialMapGuidance({ map_status: status, current_inventory: { entities, accounts: [] } }, { answerSupported: supported });
      assert.ok(guidance, 'real map state decision reached');
      const body = { answer: supported ? 'The notebook cover is blue [1].' : null, results: [{}], citations: [], gaps: [], map_guidance: guidance };
      const outputs = await surfaces(t, body);
      const mapOffer = separateOffers(guidance.one_step).offers.at(-1);
      assert.ok(outputs[1].includes(guidance.message));
      if (!supported) for (const entity of entities) assert.ok(outputs[1].includes(entity.label));
      const stepFacts = separateOffers(guidance.one_step).facts;
      if (stepFacts) assert.ok(outputs[1].includes(stepFacts));
      assert.equal(outputs[1].trim().split('\n').at(-1), mapOffer);
      assert.equal(offers(outputs[1]).length, 1);
    }
  }
});

test('reset facts stay before the invitation where each surface supports them', async t => {
  const reset = '2026-10-12T00:00:00Z';
  const body = { answer: null, answer_error: ANSWER_ERROR_MESSAGES.dailyLimit,
    answer_resumes_at: reset, results: [], citations: [], gaps: [] };
  const outputs = await surfaces(t, body, { error: true });
  const expected = separateOffers(ANSWER_ERROR_MESSAGES.dailyLimit).offers.at(-1);
  const cliReset = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(reset));
  assert.ok(outputs[0].includes(cliReset), 'CLI retains its specific restart time');
  assert.ok(outputs[0].indexOf(cliReset) < outputs[0].lastIndexOf(expected));
  const app = appText(body);
  const appReset = new Date(reset).toLocaleString();
  assert.ok(app.includes(appReset), 'app retains its specific restart time');
  assert.ok(app.indexOf(appReset) < app.lastIndexOf(expected));
  assert.ok(workerText(body).includes('restart at midnight UTC'));
  assert.ok(outputs[1].includes('restart at midnight UTC') && outputs[1].includes('MCP_ANSWER_ERROR'));
  for (const text of [...outputs, app, workerText(body)]) contract(text, body, expected);
});


test('finalized record answers and computed confidence survive every renderer', async t => {
  const { finalizeDocumentAnswer } = await import('../worker/src/lib/document-answer.js');
  const { confidenceText: workerConfidence } = await import('../worker/src/lib/answer-render.js');
  const { confidenceText: appConfidence } = await import('../frontend/src/lib/answer-render.js');
  const doc = { n: 1, source: 'records', title: 'Statement', snippet: 'The recorded fee is USD 120.00.',
    ts: '2026-10-10', date_reliable: true, text_reliable: true, text_source: 'native', read_complete: true };
  const finalized = finalizeDocumentAnswer({ question: 'What fee does the statement say?',
    draft: 'The recorded fee is USD 999.00 [1].', docs: [doc], approvedDocs: [doc],
    checks: [{ supported: false, complete: false, reason: 'The draft amount differs from the source.' }],
    searchComplete: true });
  const body = { ...finalized, results: [doc], citations: [], gaps: [], status: 'answer_withheld' };
  assert.ok(body.answer.includes('USD 120.00'), 'the amount-mismatch decision used the original record');
  assert.ok(!body.answer.includes('USD 999.00'));
  assert.ok(body.confidence.percent < 90);
  const green = { ...body, status: undefined };
  assertDocumentAnswer(green, { provisional: true, exact: true });
  for (const mutant of [
    { ...green, answer: green.answer.replace('USD 120.00', 'USD 999.00') },
    { ...green, confidence: { ...green.confidence, percent: 95, band: 'High' } },
  ]) assert.throws(() => assertDocumentAnswer(mutant, { provisional: true, exact: true }), assert.AssertionError,
    'wrong source figures and unjustified High confidence fail the same populated oracle');
  for (const [render, confidence] of [[workerText, workerConfidence], [appText, appConfidence]]) {
    assert.equal(render(body), body.answer, 'the finalized five-part reading survives stale refusal metadata');
    assert.equal(confidence(body), body.confidence_text, 'the same data yields the same score, reason and missing evidence');
    const green = { ...body, status: undefined };
    assert.equal(render(green), green.answer);
  }
});


test('document figure oracle distinguishes a month and year from a month and day', async () => {
  const { finalizeDocumentAnswer } = await import('../worker/src/lib/document-answer.js');
  const expected = 'Income was USD 1234.50 in September 2026 [1].';
  const doc = { n: 1, source: 'records', title: 'Income record', snippet: expected.replace(' [1]', ''),
    ts: '2026-09-30', date_reliable: true, text_reliable: true, text_source: 'native', read_complete: true };
  const body = { ...finalizeDocumentAnswer({ question: 'What income does the record state?', draft: expected,
    docs: [doc], approvedDocs: [doc], checks: [{ supported: true, complete: true }], searchComplete: true }),
    results: [doc], citations: [], gaps: [] };
  assert.equal(body.answer_contract.rung, 1, 'the exact source-figure decision was reached');
  assertDocumentAnswer(body, { expected, exact: true });
  assert.throws(() => assertDocumentAnswer({ ...body, answer: body.answer.replace('September 2026', 'September 2025') },
    { expected, exact: true }), assert.AssertionError, 'a changed year fails the same populated oracle');
});
