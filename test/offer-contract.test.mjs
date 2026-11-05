import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductFixture } from '../worker/test/product-contract-fixture.mjs';
import { answerText as workerText, separateOffers, moneyExplanation, nextActionText, ANSWER_ERROR_MESSAGES } from '../worker/src/lib/answer-render.js';
import { answerText as appText, nextActionText as appNextAction } from '../frontend/src/lib/answer-render.js';
import { applyMoneyVeto } from '../worker/src/lib/money-veto.js';
import { plainBankGap } from '../worker/src/lib/ledger-wording.js';
import { checks, evidenceInput } from '../worker/test/fixtures/plain-money-check-cases.mjs';
import { moneyPresentation } from '../worker/src/lib/money-format.js';
import { cmdAsk } from '../brain.mjs';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { ledgerFixture, NOW } from '../worker/test/ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { recordedIntent } from '../worker/test/fixtures/ledger-intent-cases.mjs';
import { financialMapGuidance } from '../worker/src/lib/financial-map-question.js';
import { join } from 'node:path';

async function fixture(t, money = true) {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-11T12:00:00Z'));
  const state = { drafts: 0, checks: 0, retrievals: 0, supported: true, money, partial: false };
  const f = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes('verify a proposed answer')) {
      state.checks++;
      return { response: { supported: state.supported, complete: state.supported, evidence: state.supported ? [1] : [], reason: 'fixture evidence decision' } };
    }
    state.drafts++;
    return { response: money ? 'Card ending 4242 charged USD 120.00 [1].' + (state.partial ? ' Other payments are unconfirmed.' : '') : 'The notebook cover is blue [1].' };
  } } } });
  t.after(() => f.close());
  if (money) f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','bank','ready','2026-10-10')");
  const result = await f.post('/api/admin/brain/ingest/batch', { docs: [{
    source_type: 'records', source_id: 'record-one', title: 'Fixture record',
    content: money ? 'Card ending 4242 charged USD 120.00 on 2026-10-10.' : 'The notebook cover is blue.',
    occurred_at: '2026-10-10', date_reliable: true, date_source: 'fixture:record_date',
    text_source: 'native', text_reliable: true,
    metadata: { evidence_lineage: { version: 1, kind: 'source_record' } },
  }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).results[0].status, 'created');
  f.env.VECTORIZE.query = async () => {
    state.retrievals++;
    return { matches: f.rows('SELECT chunk_uid AS id FROM chunks') };
  };
  const ask = async () => {
    const response = await f.post('/api/rag/think', {
      q: money ? 'What did card ending 4242 charge in the last 60 days?' : 'What color is the notebook cover?',
    }, { 'X-Admin-Key': f.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.results.length > 0, 'stored evidence reached retrieval');
    assert.ok(state.drafts > 0 && state.checks > 0 && state.retrievals > 0, 'draft, verification and retrieval decision points reached');
    assert.equal(body.evidence_gate.supported, state.supported);
    return body;
  };
  return { state, ask };
}

const DEFAULT_OFFER = 'Want to check the original record?';
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

async function check(t, body, expected) {
  for (const render of [workerText, appText]) contract(render(body), body, expected);
  for (const text of await surfaces(t, body)) {
    contract(text, body, expected);
    for (const citation of body.citations || []) {
      assert.ok(text.includes(`[${citation.n}]`), 'numeric citation retained');
      assert.ok(text.includes(citation.title), 'citation title retained');
    }
  }
}

test('complete document answer ends with one offer through CLI, MCP and both renderers', async t => {
  t.diagnostic(`Runtime ${process.version}; offline; fixed fixture clock`);
  const f = await fixture(t);
  const body = await f.ask();
  assert.equal(body.evidence_gate.complete, true);
  assert.ok(body.gaps.some(g => g.type === 'ledger_not_consulted'), 'bank limitation reached');
  assert.equal(body.citations.length, 1);
  await check(t, body, 'Which would help most?');
});

test('partial document answer ends with one offer through CLI, MCP and both renderers', async t => {
  const f = await fixture(t);
  const green = await f.ask();
  f.state.partial = true;
  const body = await f.ask();
  assert.equal(body.evidence_gate.complete, false);
  assert.ok(body.gaps.some(g => g.type === 'money_veto' && g.rule === 'incomplete_claim'), 'partial decision reached');
  await check(t, green, 'Which would help most?');
  await check(t, body, DEFAULT_OFFER);
});

test('supported cited document with no offer receives the reviewed default on every surface', async t => {
  const f = await fixture(t, false);
  const body = await f.ask();
  assert.equal(body.ledger, undefined);
  assert.equal(body.clarification, undefined);
  assert.equal(body.citations.length, 1);
  assert.equal(separateOffers(body.answer).offers.length, 0, 'real draft has no invitation');
  await check(t, { ...body, answer: `${body.answer}\n${DEFAULT_OFFER}` }, DEFAULT_OFFER);
  await check(t, body, DEFAULT_OFFER);
});

test('statusless refusal with two limitations keeps all facts and one offer on every surface', async t => {
  const green = evidenceInput();
  assert.equal(applyMoneyVeto(green).answer, green.answer, 'cited control passes the real money decision');
  const input = evidenceInput();
  checks.find(c => c.rule === 'span_mismatch').mutate(input);
  const veto = applyMoneyVeto(input);
  assert.equal(veto.gap.rule, 'span_mismatch', 'real veto decision reached');
  assert.equal(veto.answer, null);
  const bank = { type: 'ledger_not_consulted', detail: plainBankGap('ledger_wording_unsupported', [], { presentation: moneyPresentation({}) }) };
  const body = { answer: null, results: [{ title: 'Fixture record' }], gaps: [bank, veto.gap] };
  assert.equal(separateOffers(body.gaps.map(g => g.detail).join('\n')).offers.length, 2, 'two distinct limitations reached');
  await check(t, { ...body, gaps: [veto.gap] }, DEFAULT_OFFER);
  await check(t, body, DEFAULT_OFFER);
});

test('ledger answer keeps its existing final offer on every surface', async t => {
  const f = ledgerFixture(t);
  f.add('deposit', 'Store Unit', 'Store Unit', { cents: 12000 });
  let extracts = 0, fallbacks = 0;
  const before = f.calls.length;
  const response = await withLedgerAnswer({ env: f.env, question: 'Show my account balances.', now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
      extracts++;
      return { content: [{ type: 'text', text: JSON.stringify({ intents: [recordedIntent('balance')] }) }] };
    } }, async () => { fallbacks++; return Response.json({ answer: null, gaps: [] }); });
  const body = await response.json();
  assert.ok(f.calls.length > before, 'real ledger reader reached');
  assert.equal(fallbacks, 0);
  assert.equal(body.ledger.kind, 'balance');
  assert.equal(body.citations.length, 1);
  const [expected] = separateOffers(body.answer).offers;
  assert.ok(expected, 'ledger selected its own invitation');
  await check(t, body, expected);
});

test('clean single-offer control stays unchanged on every surface', async t => {
  const body = { answer: `The notebook cover is blue.\n${DEFAULT_OFFER}`,
    results: [{ title: 'Fixture record' }], citations: [], gaps: [] };
  await check(t, body, DEFAULT_OFFER);
});

async function restoringMutant(url, site, replacement, exported) {
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(site).length - 1, 1, 'one restoring decision point');
  // Resolve the copied module's imports to the reviewed source tree. No
  // production file is rewritten and the real exported handler still runs.
  const mutated = source.replace(site, replacement)
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g,
      (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`)
    .replace(/import\((["'])(\.\.?\/[^"']+)\1\)/g,
      (_, quote, path) => `import(${quote}${new URL(path, url).href}${quote})`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  assert.notEqual(mutated, source, 'restoring mutation inserted');
  return (await import(`data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`))[exported];
}

test('restoring bank explanation appending fails the same real CLI and MCP contract', async t => {
  const f = await fixture(t);
  const complete = await f.ask();
  f.state.partial = true;
  const partial = await f.ask();
  const cli = await restoringMutant(new URL('../brain.mjs', import.meta.url),
    'console.log(finalAnswerText(lines.join("\\n"), nextAction));',
    'console.log(finalAnswerText(lines.join("\\n"), nextAction)); console.log(moneyExplanation(body));', 'cmdAsk');
  const mcp = await restoringMutant(new URL('../worker/src/lib/mcp-endpoint.js', import.meta.url),
    'return text(finalAnswerText(lines.join("\\n"), selectedOffer));',
    'return text(finalAnswerText(lines.join("\\n"), selectedOffer) + "\\n" + moneyExplanation(thought));', 'handleMcp');
  const clean = { answer: `The notebook cover is blue.\n${DEFAULT_OFFER}`, results: [{}], gaps: [], citations: [] };
  for (const handlers of [{ cli }, { mcp }]) {
    for (const output of await surfaces(t, clean, handlers)) contract(output, clean, DEFAULT_OFFER);
    for (const [body, expected, duplicates] of [[complete, 'Which would help most?', 2], [partial, DEFAULT_OFFER, 3]]) {
      const outputs = await surfaces(t, body, handlers);
      const index = handlers.cli ? 0 : 1;
      assert.equal((outputs[index].match(/\b(?:Want[^?\n]*\?|Which would help most\?)/g) || []).length,
        duplicates, 'restored explanation reached the duplicate-offer decision');
      assert.throws(() => contract(outputs[index], body, expected), error => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.message.split('\n')[0], 'exactly one offer');
        return true;
      });
      contract(outputs[1 - index], body, expected);
    }
  }
});


test('reviewed refusal next action is the only final invitation on every surface', async t => {
  const f = await fixture(t);
  await check(t, await f.ask(), 'Which would help most?');
  f.state.supported = false;
  const refused = await f.ask();
  assert.equal(refused.evidence_gate.supported, false, 'real refusal decision reached');
  assert.ok(refused.gaps.some(g => g.type === 'ledger_not_consulted'));
  for (const body of [refused, { answer: null, results: [], gaps: [] }]) {
    const expected = nextActionText(body);
    assert.ok(expected?.startsWith('Next:'), 'reviewed next action selected');
    for (const [render, action] of [[workerText, nextActionText], [appText, appNextAction]]) {
      const text = [render(body), action(body)].filter(Boolean).join('\n');
      assert.equal((text.match(/\bWant[^?\n]*\?/g) || []).length, 0, 'no extra repair invitation beside Next');
      assert.equal(text.split('\n').at(-1), action(body));
    }
    for (const text of await surfaces(t, body)) {
      assert.equal((text.match(/\bWant[^?\n]*\?/g) || []).length, 0, 'no extra repair invitation beside Next');
      assert.equal(text.trim().split('\n').at(-1), expected);
      assert.equal(text.split(expected).length - 1, 1, 'one reviewed next action');
    }
  }
});

test('source titles with question wording remain exact through both real handlers', async t => {
  const title = 'Fixture record. Want to inspect this title?';
  const body = { answer: `The notebook cover is blue [1].\n${DEFAULT_OFFER}`, results: [{ title }],
    citations: [{ n: 1, title, source: 'records' }], gaps: [] };
  for (const output of await surfaces(t, body)) {
    assert.ok(output.includes(title), 'citation title retained byte for byte');
    assert.equal(output.trim().split('\n').at(-1), DEFAULT_OFFER);
  }
});


test('map guidance keeps its facts with one final invitation in the MCP response', async t => {
  for (const entities of [[], [{ label: 'Fixture business', candidate_state: 'possible_mention' }]]) {
    const guidance = financialMapGuidance({ map_status: 'not_established', current_inventory: { entities, accounts: [] } });
    assert.ok(guidance, 'real map guidance decision reached');
    const body = { answer: `The notebook cover is blue.\n${DEFAULT_OFFER}`, results: [{}], citations: [], gaps: [], map_guidance: guidance };
    const outputs = await surfaces(t, body);
    contract(outputs[0], body, DEFAULT_OFFER);
    const step = separateOffers(guidance.one_step);
    contract(outputs[1], body, step.offers[0]);
    assert.ok(outputs[1].includes(guidance.message), 'map facts retained');
    if (step.facts) assert.ok(outputs[1].includes(step.facts), 'factual qualification after the map invitation retained');
    for (const entity of entities) assert.ok(outputs[1].includes(entity.label), 'possible mention retained');
  }
});

test('reviewed answer errors keep one final offer after support and reset facts', async t => {
  const body = { answer: null, answer_error: ANSWER_ERROR_MESSAGES.dailyLimit,
    answer_resumes_at: '2026-10-12T00:00:00Z', citations: [], gaps: [] };
  const expected = 'Want to search your records in the meantime?';
  for (const render of [workerText, appText]) contract(render(body), body, expected);
  for (const output of await surfaces(t, body, { error: true })) contract(output, body, expected);
});
