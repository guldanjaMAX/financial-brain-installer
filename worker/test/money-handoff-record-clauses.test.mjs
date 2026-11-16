import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyQuestionHandoff } from '../src/lib/money-handoff.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';

// Exercise both routing boundaries with synthetic source evidence and no model.
const BANK = 'How much did I actually pay in September 2026?';
const RECORD = 'What does the statement say about rent?';
const TOOL_NAMES = ['brain_money_overview', 'brain_money_guide', 'brain_money_query'];
const rows = [
  ['original-counterexample', 'What does the statement say about rent, and how much did I actually pay in September 2026?', 'bank'],
  ['bank-control', BANK, 'bank'],
  ['record-control', RECORD, 'document'],
  ['record-amount-due', 'What amount due does the invoice state?', 'document'],
  ['record-unquoted-terms', 'What does the lease say I owe?', 'document'],
  ['record-conjoined-terms', 'What does the statement say about rent and payments?', 'document'],
  ['record-paid-holidays', 'How many paid holidays does the handbook give?', 'document'],
  ['ordinary-document', 'Find the receipt for rent.', 'document'],
  ['ordinary-bank', 'Did the invoice payment clear?', 'bank'],
  ['bank-with-evidence', 'How much did I spend with receipts?', 'bank'],
];

for (const [boundary, separator] of [
  ['comma-and', ', and '], ['comma', ', '], ['semicolon', '; '],
  ['semicolon-and', '; and '], ['question', '? '], ['conjunction', ' and '],
]) {
  rows.push([`record-first-${boundary}`, `What does the statement say about rent${separator}${BANK}`, 'bank']);
  rows.push([`bank-first-${boundary}`, `How much did I actually pay in September 2026${separator}${RECORD}`, 'bank']);
}

for (const [quote, open, close] of [
  ['double', '"', '"'], ['curly-double', '“', '”'], ['single', "'", "'"],
]) {
  const topic = `${open}How much did I pay, and how much do I still owe?${close}`;
  const record = `What does the statement say about ${topic}`;
  rows.push([`quoted-topic-${quote}`, `${record}?`, 'document']);
  rows.push([`quoted-topics-${quote}`, `${record} and ${open}Did the invoice payment clear?${close}?`, 'document']);
  for (const [boundary, separator] of [['comma', ', and '], ['semicolon', '; '], ['question', '? ']]) {
    rows.push([`quoted-record-first-${quote}-${boundary}`, `${record}${separator}${BANK}`, 'bank']);
    rows.push([`quoted-bank-first-${quote}-${boundary}`, `How much did I actually pay in September 2026${separator}${record}?`, 'bank']);
  }
}

function documentResult() {
  const doc = { n: 1, source: 'records', title: 'Statement',
    snippet: 'Rent is USD 120.00 in September 2026.', ts: '2026-10-10',
    date_reliable: true, text_reliable: true, text_source: 'native', read_complete: true };
  return { ...finalizeDocumentAnswer({ question: RECORD, draft: null,
    docs: [doc], approvedDocs: [doc], searchComplete: true,
    checks: [{ supported: false, complete: false, reason: 'Synthetic source reading only.' }] }),
    results: [doc], citations: [], gaps: [] };
}

function exerciseDirect(question, expected) {
  const directCalls = [];
  const decide = input => { directCalls.push(input); return moneyQuestionHandoff(input); };
  const direct = decide(question);
  assert.deepEqual(directCalls, [question], 'direct routing decision was reached');
  if (expected === 'bank') {
    assert.equal(direct?.money_handoff, true, 'independent bank clause selects direct handoff');
    assert.equal(direct.money_tools_available, true);
    assert.ok(direct.answer.trim(), 'direct handoff instructions are nonempty');
    for (const tool of TOOL_NAMES) assert.ok(direct.answer.includes(tool), `direct handoff includes ${tool}`);
    assert.match(direct.confidence_text, /Confidence: Low \(0%\)/, 'routing invents no bank evidence');
  } else {
    assert.equal(direct, null, 'record request selects direct document path');
  }
  return expected;
}

async function exerciseRemote(question, expected) {
  const thinkCalls = [];
  let bankReads = 0;
  const env = { get DB() { bankReads++; throw new Error('Bank SQL is outside this routing probe'); } };
  const url = new URL('https://fixture.invalid/mcp');
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ask', arguments: { question } } }) });
  const response = await handleMcp(env, request, url, { grant: { profile: 'librarian' },
    think: async args => { thinkCalls.push(args); return documentResult(); } });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.equal(rpc.id, 1, 'real remote ask dispatcher was reached');
  assert.equal(rpc.error, undefined);
  assert.notEqual(rpc.result?.isError, true);
  assert.ok(rpc.result?.content?.length, 'real MCP ask returned content');
  const text = rpc.result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  assert.ok(text.trim(), 'remote answer or handoff is nonempty');
  assert.equal(bankReads, 0, 'routing probe reads no bank rows');
  if (expected === 'bank') {
    for (const tool of TOOL_NAMES) assert.ok(text.includes(tool), `remote handoff includes ${tool}`);
    assert.equal(thinkCalls.length, 0, 'bank handoff bypasses injected Think');
    assert.match(text, /Confidence: Low \(0%\)/);
  } else {
    assert.equal(thinkCalls.length, 1, 'document decision reached injected Think exactly once');
    assert.deepEqual(thinkCalls[0], { q: question, limit: 12 }, 'document request retains its exact quoted topic');
    assert.match(text, /USD 120\.00/, 'populated document green control reached the answer');
    for (const tool of TOOL_NAMES) assert.equal(text.includes(tool), false, 'record topic does not select bank tools');
  }
  return expected;
}

async function exercise(question, expected) {
  exerciseDirect(question, expected);
  return exerciseRemote(question, expected);
}

test('F3-R1: independent bank clauses and record topics stay distinct at both real routing decisions', async t => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden'); };
  try {
    // Paired nonuniform controls precede all negative rows in this matrix.
    const controls = [await exercise(BANK, 'bank'), await exercise(RECORD, 'document')];
    assert.deepEqual(controls, ['bank', 'document'], 'uniform control outcomes invalidate this probe');
    const observed = new Set();
    for (const [label, question, expected] of rows) {
      await t.test(label, async () => { observed.add(await exercise(question, expected)); });
    }
    assert.equal(observed.size, 2, 'uniform matrix outcomes invalidate this probe');
  } finally {
    globalThis.fetch = originalFetch;
    assert.equal(networkCalls, 0);
  }
});

test('F3-R1: word-internal apostrophes preserve quoted topics through direct routing and MCP', async t => {
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('Network forbidden'); });
  t.after(() => assert.equal(networkCalls, 0));
  const exactReviewInput = 'What does the statement say about ‘How much did I pay, and how much did I spend on the owner’s card?’?';
  const cases = [['exact-review-input', exactReviewInput, 'document']];
  for (const [quote, open, close] of [
    ['single', "'", "'"], ['curly-single', '‘', '’'],
    ['double', '"', '"'], ['curly-double', '“', '”'],
  ]) {
    for (const [possessive, owner] of [
      ['without-apostrophe', 'owners'], ['straight-apostrophe', "owner's"], ['curly-apostrophe', 'owner’s'],
    ]) {
      const record = `What does the statement say about ${open}How much did I pay, and how much did I spend on the ${owner} card?${close}?`;
      cases.push([`${quote}-${possessive}-record`, record, 'document']);
      cases.push([`${quote}-${possessive}-record-first-bank`, `${record} And ${BANK}`, 'bank']);
      cases.push([`${quote}-${possessive}-bank-first-record`, `${BANK} And ${record}`, 'bank']);
    }
  }
  for (const [surface, route] of [['direct', exerciseDirect], ['mcp', exerciseRemote]]) {
    const controls = [await route(BANK, 'bank'), await route(RECORD, 'document')];
    assert.deepEqual(controls, ['bank', 'document'], `${surface}: paired decisions must differ`);
    const observed = new Set();
    for (const [label, question, expected] of cases) {
      await t.test(`${surface}-${label}`, async () => { observed.add(await route(question, expected)); });
    }
    assert.equal(observed.size, 2, `${surface}: uniform matrix outcomes invalidate this probe`);
  }
});
