import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { cases } from './fixtures/plain-refusals-cases.mjs';

const ownerMessages = [];
export { MONEY_JARGON as jargon } from "./fixtures/plain-copy-expectations.mjs";
import { MONEY_JARGON as jargon } from "./fixtures/plain-copy-expectations.mjs";
for (const c of cases) test(`plain refusal: ${c.id}`, async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('expense', 'Store One charge', 'Store One', { direction: 'outflow' });
  // Each negative has a real positive peer before its fixture is constrained.
  const green = await f.ask('What are my account balances?');
  assert.equal(green.ledger?.kind, 'balance');
  assert.ok(f.calls.some(sql => /JOIN fin_balance_snapshots/.test(sql)));
  c.setup?.(f);
  f.calls.length = 0;
  let fallbacks = 0;
  const before = f.first('SELECT total_changes() n').n;
  const body = await (await withLedgerAnswer({ env: f.env, question: c.question,
    now: '2026-10-12T12:00:00Z', grantScope: { all: true }, scopePrincipalKind: 'owner', ...c.options }, async gap => {
    fallbacks++;
    return Response.json({ answer: c.documentAnswer || null, citations: [], gaps: gap ? [gap] : [] });
  })).json();
  if (['wording','timezone','restricted','unsupported','documents'].includes(c.id)) {
    assert.equal(fallbacks, ['timezone','unsupported'].includes(c.id) ? 0 : 1, 'pre-read decision reached');
    assert.equal(body.gaps[0].reason, c.reason, 'refusal code proves the guard ran');
    if (c.id !== 'timezone') {
      assert.equal(Object.hasOwn(body.gaps[0], 'from'), false, 'format context cannot add a machine period');
      assert.equal(Object.hasOwn(body.gaps[0], 'to'), false, 'format context cannot add a machine period');
    }
    assert.equal(f.calls.length, 0, 'pre-read guard remains closed');
  } else assert.ok(f.calls.some(sql => /FROM fin_accounts/.test(sql)), 'inventory decision reached');
  if (c.reason) assert.equal(body.gaps[0].reason, c.reason);
  if (c.id === 'timezone') assert.ok((await f.ask('How much money came in and went out in October 2026?')).ledger, 'explicit historical alternative answers with the same invalid zone');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'answer cannot write');
  const text = [body.answer, ...(body.gaps || []).map(g => g.detail)].filter(Boolean).join('\n');
  if (c.id === 'vendor-owned-only') assert.equal(body.ledger.candidate_transfer_count, 1, 'proved owned-movement decision reached');
  ownerMessages.push(text);
  const lines = text.split('\n');
  const expectedOffer = c.expected.match(/Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\./)?.[0];
  const expectedFacts = body.ledger && expectedOffer
    ? c.expected.replace('\n' + expectedOffer, '').replace(' ' + expectedOffer, '') : c.expected;
  const expectedLines = expectedFacts.split('\n');
  const start = lines.findIndex((line, index) => line === expectedLines[0] &&
    expectedLines.every((expected, offset) => lines[index + offset] === expected));
  assert.notEqual(start, -1, `${c.id}: exact independent lines missing`);
  if (body.ledger) {
    assert.ok(body.answer.endsWith(expectedOffer), 'the reviewed offer follows all factual lines');
    assert.deepEqual(body.answer.match(/Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\./g),
      [expectedOffer], 'exactly one reviewed invitation survives composition');
  }
  if (c.contextExpected) assert.ok(text.includes(c.contextExpected), 'original amount and period display assertions retained');
  assert.doesNotMatch(text, jargon);
  assert.doesNotMatch(c.expected, /(?:^|[.!?]\s+)I (?:can't|cannot|couldn't|am unable)/i);
  const explanation = c.expected.split('\n').filter(line => !/^Your account ending \d+ has records /.test(line)).join('\n').replace(/\$[\d,.]+/g, 'amount');
  assert.ok((explanation.match(/[.!?](?:\s|$)/g) || []).length <= 3, 'at most three refusal sentences');
  assert.match(text, /\b(?:Want |Which would help most\?|If you tell me)/, 'one easy next step is offered');
  const questions = text.includes('Want me to show your account balances?') ? ['What are my account balances?'] : [];
  for (const match of text.matchAll(/Want me to check spending at ([^\n]+) in ([^\n?]+)\?/g)) {
    questions.push(`How much did I spend at ${match[1]} in ${match[2]}?`);
  }
  if (c.id === 'cash-flow') questions.push('How much money came in and went out in October 2026?');
  for (const question of questions) {
    const answer = await f.ask(question);
    assert.ok(answer.ledger, 'suggested question reaches the bank answer in the same fixture');
    if (question.startsWith('How much did I spend at')) { assert.equal(answer.ledger.match_basis, 'exact'); assert.notEqual(answer.ledger.total_minor, null); }
  }
});

test('owner renderer uses the plain bank refusal and keeps search failure notices', async () => {
  const { answerText } = await import('../src/lib/answer-render.js');
  const detail = "I can help check the bank records for those dates. Some bank days are missing. Connect the missing bank statements.";
  const response = { answer: null, results: [], gaps: [{ type: 'ledger_out_of_coverage', reason: 'period_outside_coverage', detail }],
    evidence_gate: { supported: false, reason: 'period_outside_coverage' } };
  assert.equal(response.gaps.length, 1, 'real refusal supplied');
  assert.equal(answerText(response), detail);
  assert.equal(answerText({ ...response, status: 'coverage_incomplete', notice: 'Search is still incomplete.' }), 'Search is still incomplete.');
  assert.equal(answerText({ answer: 'Ordinary answer.', gaps: [] }), 'Ordinary answer.');
  assert.equal(answerText({ ...response, answer: 'A dated document answer.', gaps: [{ ...response.gaps[0], detail: "This answer comes from your documents; I did not match it to your bank data." }] }), "A dated document answer.\n\nThis answer comes from your documents; I did not match it to your bank data.");
});

import { applyMoneyVeto } from '../src/lib/money-veto.js';
import { checks, evidenceInput } from './fixtures/plain-money-check-cases.mjs';
for (const c of checks) test(`plain document money check: ${c.rule}`, async t => {
  const f = ledgerFixture(t);
  const green = evidenceInput();
  assert.equal(applyMoneyVeto(green).answer, green.answer, 'same nonempty evidence passes before mutation');
  const value = evidenceInput(); c.mutate(value);
  assert.ok(value.docs[0].snippet, 'nonempty supporting record reaches the decision');
  const result = applyMoneyVeto(value);
  assert.equal(result.gap?.rule, c.rule, 'specific decision reached');
  const partial = ['incomplete_claim','claim_date_unknown'].includes(c.rule);
  assert.equal(result.evidenceGate.supported, !partial ? false : true);
  assert.equal(result.evidenceGate.complete, false);
  assert.equal(result.answer, partial ? value.answer : null);
  if (!partial) assert.deepEqual(result.evidenceGate.evidence, []);
  ownerMessages.push(result.gap.detail);
  assert.equal(result.gap.detail, c.expected);
  assert.doesNotMatch(result.gap.detail, jargon);
  assert.ok((await f.ask('What are my account balances?')).ledger, 'suggestion answers in the same synthetic bank fixture');
});

import { applyMoneyRecallVeto } from '../src/lib/money-recall.js';
for (const kind of ['quote', 'older']) test(`plain document recall: ${kind}`, async t => {
  const f = ledgerFixture(t);
  const value = evidenceInput();
  value.question = kind === 'older' ? 'What is the current charge for Payer Unit?' : 'What was charged?';
  if (kind === 'older') { value.answer = 'Payer Unit charged USD 120.00 [1].'; value.docs[0].snippet = 'Payer Unit charged USD 120.00.'; }
  if (kind === 'quote') value.answer = 'As of 2026-10-10, the record states "Card ending 4242 charged USD 120.00." [1]. Current status is unknown.';
  assert.equal(applyMoneyRecallVeto(value).answer, value.answer, 'positive recall control');
  if (kind === 'quote') value.answer = value.answer.replace('120.00', '121.00');
  else value.candidates = [...value.docs, { ...value.docs[0], n: 2, ts: '2026-10-11' }];
  const result = applyMoneyRecallVeto(value);
  assert.equal(result.answer, null, 'recall decision reached');
  assert.equal(result.gap.type, 'money_recall');
  const expected = kind === 'quote'
    ? `I can help review the original record, but this money quote differs in its text, date, or subject, so the quoted detail is unconfirmed.\nWant to check the original record?`
    : `I found a newer matching record, but this answer uses an older one, so the current amount is unconfirmed.\nWant to review the newest record?`;
  ownerMessages.push(result.gap.detail);
  assert.equal(result.gap.detail, expected);
  assert.doesNotMatch(result.gap.detail, jargon);
  assert.ok((await f.ask('What are my account balances?')).ledger);
});

test('older bank replies with codes only still explain the missing records', async () => {
  const renderers = await Promise.all([import('../src/lib/answer-render.js'), import('../../frontend/src/lib/answer-render.js')]);
  const body = { answer: null, results: [], gaps: [{ type: 'ledger_not_consulted', reason: 'no_accounts' }] };
  assert.ok(body.gaps.length);
  for (const { answerText } of renderers) {
    ownerMessages.push(answerText(body));
    assert.equal(answerText(body), "I can help check the bank connection, but the bank records needed for this answer are unavailable.\nWant help connecting or refreshing the bank account?");
  }
});

test('CLI and MCP preserve the bank explanation without printing decision codes', async t => {
  const { cmdAsk } = await import('../../brain.mjs');
  const { handleMcp } = await import('../src/lib/mcp-endpoint.js');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { randomBytes } = await import('node:crypto');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'money-copy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = join(directory, 'synthetic.manifest.json'), keyPath = join(directory, 'admin-key');
  writeFileSync(keyPath, randomBytes(24).toString('hex'), { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'brain.invalid' }, operations: { admin_key_file: keyPath } }));
  const detail = "I can help find the right account, but no connected account matches this request.\nWant help connecting the account you want to ask about?";
  const body = { answer: null, citations: [], results: [], gaps: [{ type: 'ledger_not_consulted', reason: 'no_accounts', detail }],
    evidence_gate: { supported: false, complete: false, reason: 'no_accounts' } };
  let reads = 0;
  const printed = [];
  t.mock.method(console, 'log', (...parts) => printed.push(parts.join(' ')));
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  await cmdAsk(manifest, { ask: async () => 'What are my account balances?', adminKey: readFileSync(keyPath, 'utf8'),
    launchctl: () => assert.fail('host tool forbidden'), http: async () => { reads++; return Response.json(body); } });
  const url = new URL('https://brain.invalid/mcp');
  const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1,
    method: 'tools/call', params: { name: 'ask', arguments: { question: 'What are my account balances?' } } }) }), url,
    { think: async () => { reads++; return body; }, grant: { profile: 'read-only' } });
  const rpc = await response.json();
  assert.equal(reads, 2, 'both real renderers reached their injected read');
  for (const text of [printed.join('\n'), rpc.result.content.map(c => c.text).join('\n')]) {
    ownerMessages.push(text);
    assert.ok(text.includes(detail));
    assert.doesNotMatch(text, /no_accounts|Ledger gap|\bcoverage\b/i);
  }
});

test('jargon lint checks every emitted owner money message', () => {
  assert.equal(ownerMessages.length, cases.length + checks.length + 6, 'every bank, document check, recall and CLI/MCP arm was collected');
  for (const message of ownerMessages) assert.doesNotMatch(message, jargon);
});

test('jargon lint rejects an ISO mutant beside a real green peer', async t => {
  const f = ledgerFixture(t);
  const body = await f.ask('How much did I spend at Store One in September 2023?');
  assert.ok(f.calls.some(sql => /FROM fin_accounts/.test(sql)), 'real inventory decision reached');
  assert.equal(body.gaps[0].reason, 'period_outside_coverage');
  const peer = body.gaps[0].detail;
  const mutant = peer.replace('September 2023', ['2023', '09', '01'].join('-'));
  assert.notEqual(mutant, peer, 'one real rendered date was mutated');
  assert.doesNotMatch(peer, jargon);
  assert.match(mutant, jargon);
  for (const word of ['posted', 'ledger', 'reader', 'schema', 'intent', 'provider', 'manifest', 'scope']) {
    const jargonMutant = `${peer}\n${word}`;
    assert.notEqual(jargonMutant, peer);
    assert.doesNotMatch(peer, jargon);
    assert.match(jargonMutant, jargon, `the lint rejects ${word} beside a real green peer`);
  }
});

test('the strict scorer rejects a changed cent and an extra unsupported sentence', async () => {
  const { replay } = await import('../../eval/fast-loop/money-replay.mjs');
  const { scoreObservation } = await import('../../eval/fast-loop/money-score.mjs');
  const { BASE_CASES } = await import('../../test/fixtures/fastloop-money/input.mjs');
  const input = BASE_CASES.find(c => c.id === 'M05');
  const observation = replay({ cases: [input] }).observations[0];
  assert.equal(scoreObservation(observation, input).verdict, 'correct');
  assert.ok(observation.trace.dependencies.includes('transactions'), 'nonempty real decision reached');
  for (const mutate of [
    answer => answer.replace('$610.00', '$610.01'),
    answer => answer + '\nEvery future bill is already paid.',
  ]) {
    const broken = structuredClone(observation); broken.body.answer = mutate(broken.body.answer);
    assert.notEqual(broken.body.answer, observation.body.answer);
    assert.ok(scoreObservation(broken, input).safety_failures.length, 'unsafe prose cannot enter through a wider known-line pattern');
  }
});

test('money search progress uses plain words and keeps the incomplete-search refusal', async () => {
  const worker = await import('../src/lib/answer-render.js');
  const app = await import('../../frontend/src/lib/answer-render.js');
  const body = { status: 'coverage_incomplete', answer: 'Invented $123.00.', results: [],
    notice: 'The search returned zero matches. Source coverage could not be checked, so treat this result as provisional until source status is available.',
    gaps: [{ type: 'ledger_not_consulted', reason: 'no_accounts', detail: 'Connect the bank account.' }] };
  for (const renderer of [worker, app]) {
    assert.equal(renderer.answerText(body), 'The search returned zero matches. The connected records could not be checked, so treat this result as provisional until source status is available.');
    assert.equal(renderer.confidenceText(body), 'Some connected records may be missing or still loading. This answer is incomplete.');
    assert.doesNotMatch(renderer.answerText(body) + renderer.confidenceText(body), jargon);
    assert.doesNotMatch(renderer.answerText(body), /\$/);
    assert.equal(renderer.answerText({ ...body, gaps: [] }), body.notice, 'ordinary search copy stays unchanged');
  }
});

test('real refusal uses the injected owner zone while machine timestamps stay ISO', async t => {
  const f = ledgerFixture(t);
  f.env.BRAIN_TIMEZONE = 'America/Phoenix';
  const body = await f.ask('How much did I spend at Store One in September 2023?');
  assert.ok(f.calls.some(sql => /FROM fin_accounts/.test(sql)), 'real inventory decision reached');
  assert.equal(body.gaps[0].reason, 'period_outside_coverage');
  assert.ok(body.gaps[0].detail.includes('last updated October 12 at 5:00 AM'));
  assert.doesNotMatch(body.gaps[0].detail, jargon);
  assert.equal(body.gaps[0].accounts[0].last_synced_at, '2026-10-12T12:00:00.000Z');
  assert.equal(body.gaps[0].from, '2023-09-01');
  assert.ok((await f.ask('What are my account balances?')).ledger, 'green peer in the same owner zone');
});
