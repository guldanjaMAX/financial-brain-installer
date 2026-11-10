import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callLLM } from '../src/lib/core.js';
import * as ledger from '../src/lib/ledger-intent.js';
import { RECORDED_REPLIES } from './fixtures/ledger-intent-recorded.mjs';

const context = { now: Date.parse('2026-11-04T12:00:00.000Z'), timeZone: 'UTC' };
const question = 'Could you retrieve expenses this month?';
const intent = (overrides = {}) => ({ kind: 'expense_summary', direction: 'outflow', count: null,
  vendor_text: null, account_hint: null, amount_text: null, date_text: null,
  period: { type: 'this_month' }, ...overrides });
const reply = (value = intent()) => ({ ambiguous: false, unanswered_part: null, intents: [value] });
const db = () => ({ prepare: () => ({ run: async () => {}, first: async () => ({ m: 0 }),
  bind: () => ({ run: async () => {}, first: async () => ({ m: 0 }) }) }) });
const environment = () => ({ DB: db(), ANTHROPIC_API_KEY: 'fixture-not-a-key' });
const format = () => ({ type: 'json_schema', schema: ledger.LEDGER_INTENT_WIRE_SCHEMA });
const removed = new Set(['maxLength', 'minLength', 'minimum', 'maximum', 'maxItems', 'minItems']);

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => context.now);
});

function provider(t, text = JSON.stringify(reply())) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body), bytes: init.body });
    return Response.json({ content: [{ type: 'text', text }], usage: {}, stop_reason: 'end_turn' });
  });
  return calls;
}

async function extract(t, { model, text, invoke = callLLM, module = ledger, q = question } = {}) {
  const calls = provider(t, text);
  const options = [];
  const decision = await module.extractLedgerIntentDecision({ env: { ...environment(), ...(model ? { RERANK_MODEL: model } : {}) },
    question: q, ...context, callLLM: (env, input) => { options.push(input); return invoke(env, input); } });
  assert.equal(options.length, 1, 'extractor reached the model decision');
  assert.equal(calls.length, 1, 'real callLLM reached the injected provider');
  return { decision, options: options[0], ...calls[0] };
}

function assertWireSchema(actual, original) {
  assert.notEqual(actual, undefined, 'wire schema value exists');
  if (Array.isArray(original)) {
    assert.equal(actual.length, original.length);
    original.forEach((value, index) => assertWireSchema(actual[index], value));
  } else if (original && typeof original === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(original).filter(key => !removed.has(key))
      .map(key => key === 'oneOf' ? 'anyOf' : key).sort());
    for (const [key, value] of Object.entries(original)) {
      if (!removed.has(key)) assertWireSchema(actual[key === 'oneOf' ? 'anyOf' : key], value);
    }
  } else assert.deepEqual(actual, original);
}

// In-memory source variants exercise the real provider and validator paths.
// No production module, clock, environment setting or API version is mutable.
async function variant(path, replacements) {
  const url = new URL(path, import.meta.url);
  let source = readFileSync(url, 'utf8');
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length - 1, 1, 'one source mutation site');
    source = source.replace(before, after);
  }
  source = source.replace(/from (["'])(\.[^"']+)\1/g,
    (_match, quote, relative) => `from ${quote}${new URL(relative, url).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function assertEffortMerged(t, invoke = callLLM) {
  const calls = provider(t);
  for (const [model, effort] of [['claude-opus-5-5', 'medium'], ['claude-sonnet-5-5-20261001', 'high']]) {
    await invoke(environment(), { model, label: 'fixture', system: 'fixture', messages: [],
      max_tokens: 128, output_format: ledger.LEDGER_INTENT_WIRE_SCHEMA });
    assert.equal(calls.length, effort === 'medium' ? 1 : 2, 'provider decision reached');
    assert.deepEqual(calls.at(-1).body.output_config, { effort, format: format() }, 'structured output must retain model effort');
  }
}

async function assertFutureVersion(t, invoke) {
  const result = await extract(t, { invoke });
  assert.equal(result.decision.outcome, 'ready', 'green extraction control');
  assert.equal(result.headers['anthropic-version'], '2026-10-21');
  assert.deepEqual(result.body.output_config.format, format());
  assert.equal(Object.hasOwn(result.body, 'temperature'), false, 'sampling must be omitted after a version change');
  assert.equal(Object.hasOwn(result.body, 'top_p'), false);
  assert.equal(Object.hasOwn(result.body, 'top_k'), false);
}

async function assertLengthRefused(t, module = ledger) {
  for (const length of [160, 161]) {
    const vendor = 'v'.repeat(length);
    const raw = reply(intent({ kind: 'merchant', vendor_text: vendor }));
    const q = `Could you retrieve spending at ${vendor} this month?`;
    const result = await extract(t, { module, q, text: JSON.stringify(raw) });
    assert.equal(result.decision.outcome, length === 160 ? 'ready' : 'fallback',
      length === 160 ? 'length boundary green control' : 'overlong selector must be refused locally');
    if (length === 161) assert.equal(result.decision.reason, 'schema');
  }
}

test('extractor opts into the wire schema and deterministic sampling for both supported Haiku families', async t => {
  for (const model of [undefined, 'claude-haiku-5-5', 'claude-haiku-5-5-20261001']) {
    const result = await extract(t, { model });
    assert.equal(result.decision.outcome, 'ready');
    assert.equal(result.options.output_format, ledger.LEDGER_INTENT_WIRE_SCHEMA);
    assert.ok(result.options.output_format, 'extractor explicitly supplies the schema');
    assert.equal(result.headers['anthropic-version'], '2023-06-01');
    assert.equal(result.body.temperature, 0);
    assert.deepEqual(result.body.output_config, { format: format() });
    assert.equal(Object.hasOwn(result.body, 'top_p'), false);
    assert.equal(Object.hasOwn(result.body, 'top_k'), false);
  }
});

test('structured output preserves effort for models that already use it', assertEffortMerged);

test('a different API version automatically omits every sampling field', async t => {
  const future = await variant('../src/lib/core.js', [
    ['const ANTHROPIC_API_VERSION = "2023-06-01";', 'const ANTHROPIC_API_VERSION = "2026-10-21";'],
  ]);
  await assertFutureVersion(t, future.callLLM);
});

test('wire conversion is pure and preserves every other keyword, required field and enum', () => {
  const before = JSON.stringify(ledger.LEDGER_INTENT_SCHEMA);
  assertWireSchema(ledger.LEDGER_INTENT_WIRE_SCHEMA, ledger.LEDGER_INTENT_SCHEMA);
  assert.equal(typeof ledger.ledgerIntentWireSchema, 'function');
  const synthetic = { type: 'array', minItems: 1, maxItems: 2, items: { oneOf: [
    { type: 'string', minLength: 1, maxLength: 160 },
    { type: 'number', minimum: 1, maximum: 4 },
  ] } };
  assertWireSchema(ledger.ledgerIntentWireSchema(synthetic), synthetic);
  const copy = ledger.ledgerIntentWireSchema(ledger.LEDGER_INTENT_SCHEMA);
  assert.deepEqual(copy, ledger.LEDGER_INTENT_WIRE_SCHEMA);
  copy.required.pop();
  copy.properties.intents.items.properties.kind.enum.pop();
  assert.equal(JSON.stringify(ledger.LEDGER_INTENT_SCHEMA), before, 'conversion and output mutation leave local schema intact');
  assertWireSchema(ledger.LEDGER_INTENT_WIRE_SCHEMA, ledger.LEDGER_INTENT_SCHEMA);
});

test('local string limits remain authoritative after structured output', assertLengthRefused);

test('local numeric limits refuse out-of-range structured replies with in-range controls', async t => {
  for (const [period, ready] of [
    [{ type: 'last_n_days', n: 1 }, true], [{ type: 'last_n_days', n: 3660 }, true],
    [{ type: 'last_n_days', n: 0 }, false], [{ type: 'last_n_days', n: 3661 }, false],
    [{ type: 'quarter', q: 1, year: 2026 }, true], [{ type: 'quarter', q: 4, year: 2026 }, true],
    [{ type: 'quarter', q: 0, year: 2026 }, false], [{ type: 'quarter', q: 5, year: 2026 }, false],
  ]) {
    const result = await extract(t, { text: JSON.stringify(reply(intent({ period }))) });
    assert.equal(result.decision.outcome, ready ? 'ready' : 'fallback', JSON.stringify(period));
    if (!ready) assert.equal(result.decision.reason, 'period_contradiction');
  }
});

test('recorded fenced and bare replies retain their exact parse and extraction decisions', async t => {
  for (const recorded of RECORDED_REPLIES) {
    const bare = recorded.text.replace(/^```json\n/, '').replace(/\n```$/, '');
    const raw = JSON.parse(bare);
    const expected = ledger.validateLedgerIntentDecision(structuredClone(raw), recorded.question, context);
    assert.equal(expected.outcome, 'ready', 'recorded reply control reaches a ledger decision');
    for (const text of [recorded.text, bare, `${bare}\nExplanation follows.`, `${recorded.text}\nExplanation follows.`]) {
      assert.deepEqual(ledger.parseLedgerIntentReply(text), raw);
      const result = await extract(t, { q: recorded.question, text });
      assert.deepEqual(result.decision, expected);
    }
  }
});

test('rerank request bytes remain unchanged for models with and without effort', async t => {
  const calls = provider(t, '[]');
  for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']) {
    await callLLM(environment(), { model, system: 'Rank these synthetic excerpts.',
      messages: [{ role: 'user', content: 'fixture' }], max_tokens: 128, label: 'rag-rerank' });
    assert.equal(calls.length, model.includes('haiku') ? 1 : 2, 'rerank reached the provider');
    const expected = `{"model":"${model}","max_tokens":128,"system":"Rank these synthetic excerpts.","messages":[{"role":"user","content":"fixture"}]${model.includes('sonnet') ? ',"output_config":{"effort":"high"}' : ''}}`;
    assert.equal(calls.at(-1).bytes, expected);
  }
});

test('Workers AI ignores the structured-output opt-in and keeps its existing input', async () => {
  const calls = [];
  const env = { ...environment(), AI: { run: async (model, input) => {
    calls.push({ model, input }); return { response: 'fixture' };
  } } };
  const options = { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', system: 'fixture',
    messages: [{ role: 'user', content: 'fixture' }], max_tokens: 128, label: 'ledger_intent' };
  await callLLM(env, options);
  await callLLM(env, { ...options, output_format: ledger.LEDGER_INTENT_WIRE_SCHEMA });
  assert.equal(calls.length, 2, 'both Workers AI controls reached the binding');
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[1].input, { messages: [{ role: 'system', content: 'fixture' }, ...options.messages],
    max_tokens: 128, temperature: 0 });
});

test('kills mutant: wire schema keeps maxLength', async () => {
  const mutant = await variant('../src/lib/ledger-intent.js', [["'maxLength', ", '']]);
  assert.equal(mutant.LEDGER_INTENT_WIRE_SCHEMA.properties.unanswered_part.maxLength, 120, 'mutant retained the rejected keyword');
  assert.throws(() => assertWireSchema(mutant.LEDGER_INTENT_WIRE_SCHEMA, ledger.LEDGER_INTENT_SCHEMA), assert.AssertionError);
});

test('kills mutant: temperature sent on any API version', async t => {
  const mutant = await variant('../src/lib/core.js', [
    ['const ANTHROPIC_API_VERSION = "2023-06-01";', 'const ANTHROPIC_API_VERSION = "2026-10-21";'],
    ['label === "ledger_intent" && ANTHROPIC_API_VERSION === "2023-06-01"', 'label === "ledger_intent"'],
  ]);
  await assert.rejects(assertFutureVersion(t, mutant.callLLM), error =>
    error instanceof assert.AssertionError && error.message.includes('sampling must be omitted after a version change'));
});

test('kills mutant: structured output overwrites effort', async t => {
  const mutant = await variant('../src/lib/core.js', [
    ['{ output_config: outputConfig }', '{ output_config: output_format ? { format: outputConfig.format } : outputConfig }'],
  ]);
  await assert.rejects(assertEffortMerged(t, mutant.callLLM), error =>
    error instanceof assert.AssertionError && error.message.includes('structured output must retain model effort'));
});

test('kills mutant: local length limit dropped', async t => {
  const mutant = await variant('../src/lib/ledger-intent.js', [
    ['value.length <= 160 &&', ''], ['value[field].length > 160', 'false'],
  ]);
  await assert.rejects(assertLengthRefused(t, mutant), error =>
    error instanceof assert.AssertionError && error.message.includes('overlong selector must be refused locally'));
});
