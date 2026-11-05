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
  assert.equal(rpc.result.isError, error ? true : undefined);
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

test('statusless unavailable bank fallback retains bounds and one final repair offer', async t => {
  const detail = plainBankGap('ledger_wording_unsupported', [], { presentation: moneyPresentation({}) });
  const body = { answer: null, degraded: 'vector', gaps: [{ type: 'ledger_not_consulted', detail }], citations: [] };
  assert.ok(separateOffers(detail).facts && separateOffers(detail).offers.length, 'real bank explanation reached');
  const control = { ...body, status: 'search_unavailable' };
  const green = await surfaces(t, control);
  for (const text of green) {
    assert.equal(offers(text).length, 1, 'typed-status control has one final reviewed action');
    assert.ok(text.includes(separateOffers(detail).facts), 'control reaches bank bounds');
  }
  const renderControls = [workerText, appText].map((render, i) => [render(control), [nextActionText, appNextAction][i](control)].filter(Boolean).join('\n'));
  for (const text of renderControls) assert.equal(offers(text).length, 1, 'typed renderer control has one reviewed action');
  const renderLegacy = [workerText, appText].map((render, i) => [render(body), [nextActionText, appNextAction][i](body)].filter(Boolean).join('\n'));
  const outputs = await surfaces(t, body);
  const counts = outputs.map(text => offers(text).length);
  for (const text of outputs) assert.ok(text.includes(separateOffers(detail).facts), 'legacy path reaches factual bank decision');
  const expected = REFUSAL_NEXT_ACTIONS.search_unavailable;
  for (const text of [...renderLegacy, ...renderControls, ...outputs, ...green]) {
    assert.deepEqual(offers(text), [expected], 'each surface selects the same reviewed unavailable action');
    assert.equal(text.trim().split('\n').at(-1).trim(), expected, 'action follows all facts');
    assert.ok(text.includes('search could not be completed'), 'unavailable-search notice retained');
  }
  for (const text of [...outputs, ...green]) {
    assert.ok(text.indexOf(separateOffers(detail).facts) < text.lastIndexOf(expected), 'bank bounds precede the action');
  }
  assert.deepEqual(counts, [1, 1], 'statusless bank fallback needs one invitation on each handler');
});

test('legacy fallback preserves explicit actions, errors and answered controls', () => {
  const legacy = { answer: null, degraded: 'vector', citations: [], gaps: [] };
  for (const [render, next] of [[workerText, nextActionText], [appText, appNextAction]]) {
    assert.ok(render(legacy).includes('search could not be completed'), 'legacy unavailable decision reached');
    for (const body of [legacy, { ...legacy, results: [] }]) {
      assert.equal(next(body), REFUSAL_NEXT_ACTIONS.search_unavailable);
    }
    const explicit = { ...legacy, next_action: REFUSAL_NEXT_ACTIONS.no_results };
    assert.equal(next(explicit), explicit.next_action, 'explicit reviewed action takes precedence');
    for (const next_action of [null, 'unreviewed remote instruction']) {
      const body = { ...legacy, next_action };
      assert.ok(render(body).includes('search could not be completed'), 'explicit-action arm still reaches notice');
      assert.equal(next(body), null, 'explicit unavailable action cannot be replaced');
    }
    const error = { answer: null, answer_error: ANSWER_ERROR_MESSAGES.unavailable, gaps: [] };
    assert.ok(render(error).includes('Want to try again in a moment?'), 'reviewed error decision reached');
    assert.equal(next({ ...legacy, ...error }), null, 'error rule precedes legacy fallback');
    const answered = { ...legacy, answer: 'The notebook cover is blue [1].', results: [{}] };
    assert.ok(render(answered).includes(answered.answer), 'supported answer decision reached');
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
