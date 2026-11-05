import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerFixture, NOW } from '../worker/test/ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { answerText as workerText, separateOffers } from '../worker/src/lib/answer-render.js';
import { answerText as appText } from '../frontend/src/lib/answer-render.js';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { cmdAsk } from '../brain.mjs';
import { finalLedgerOffer } from '../worker/src/lib/ledger-clarification.js';

const QUESTION = 'How much did I spend on materials in September 2026?';
const AMOUNTS = [750, 1250];
const originalRecordSuggestion = 'Want to check the original record?';

test('unclassified category evidence ends with the original-record offer', async t => {
  const body = await ask(fixture(t));
  assert.equal(body.ledger.unsorted_minor, 2000, 'nonempty category uncertainty reached the decision');
  assert.deepEqual(separateOffers(body.answer).offers, [originalRecordSuggestion]);
  assert.ok(body.answer.endsWith(originalRecordSuggestion));
});

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
});

function fixture(t) {
  const f = ledgerFixture(t);
  for (const [index, cents] of AMOUNTS.entries()) f.add(`description-${index}`, 'materials receipt', null,
    { cents, direction: 'outflow', date: '2026-09-05' });
  assert.equal(f.first('SELECT count(*) n FROM fin_transactions WHERE category IS NULL').n, 2,
    'two nonempty unclassified records are stored');
  return f;
}

async function ask(f, handler = withLedgerAnswer, question = QUESTION) {
  const before = f.calls.length;
  let fallbacks = 0;
  const response = await handler({ env: f.env, question, now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner' }, async () => {
    fallbacks++;
    return Response.json({ answer: null, gaps: [] });
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)),
    'the real transaction reader reached the decision');
  assert.equal(fallbacks, 0, 'the ledger handled this question');
  assert.equal(body.ledger.kind, question === QUESTION ? 'category' : 'merchant');
  assert.equal(body.evidence_gate.supported, true, 'the available rows remain supported evidence');
  return body;
}

function unconfirmed(body, unsorted = 2000) {
  assert.equal(body.ledger.total_minor, null, 'topic total is withheld');
  assert.equal(body.ledger.lead_total_minor, null, 'lead topic total is withheld');
  assert.equal(body.ledger.found, null, 'unknown membership cannot certify absence');
  assert.equal(body.ledger.if_own_transfers.total_minor, null, 'conditional topic total is withheld');
  assert.equal(body.ledger.if_own_transfers.complete, false);
  assert.equal(body.ledger.expense_total_minor, null, 'expense topic total is withheld');
  assert.equal(body.ledger.unsorted_minor, unsorted, 'the unclassified amount is retained');
  assert.deepEqual(body.citations.map(c => c.amount_minor).sort((a, b) => a - b), AMOUNTS,
    'both original row amounts are retained');
  assert.equal(body.ledger.complete, false);
  assert.equal(body.ledger.category_total_unconfirmed, true);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
}

function offerLast(text) {
  assert.doesNotMatch(text, /\$0\.00/, 'an unavailable topic total never becomes zero');
  assert.match(text, /total for materials is unconfirmed/);
  assert.match(text, /Transactions without a confirmed category: \$20\.00 \[1\] \[2\]\./);
  assert.deepEqual(separateOffers(text).offers, [originalRecordSuggestion], 'exactly one reviewed offer');
  assert.equal(text.trim().split('\n').at(-1), originalRecordSuggestion, 'all facts precede the offer');
}

async function surfaces(t, body) {
  const directory = mkdtempSync(join(process.env.HOME, 'topic-surface-'));
  const keyPath = join(directory, 'fixture-admin-key');
  const manifest = join(directory, 'synthetic.manifest.json');
  writeFileSync(keyPath, randomBytes(24).toString('hex'), { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'brain.invalid' },
    credentials: { admin_key: { backend: 'file', path: keyPath } } }));
  const printed = [];
  let cliCalls = 0, mcpCalls = 0;
  const print = t.mock.method(console, 'log', (...parts) => printed.push(parts.join(' ')));
  try {
    await cmdAsk(manifest, { ask: async () => QUESTION, adminKey: readFileSync(keyPath, 'utf8'),
      launchctl: () => assert.fail('host scheduler forbidden'),
      http: async (url, init) => {
        cliCalls++;
        assert.equal(url, 'https://brain.invalid/api/rag/think');
        assert.equal(JSON.parse(init.body).q, QUESTION);
        return Response.json(body);
      } });
  } finally { print.mock.restore(); }
  const url = new URL('https://brain.invalid/mcp');
  const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question: QUESTION } },
  }) }), url, { grant: { profile: 'read-only' }, think: async ({ q }) => {
    mcpCalls++;
    assert.equal(q, QUESTION);
    return body;
  } });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.equal(rpc.id, 1, 'the real RPC dispatcher ran');
  assert.equal(rpc.result.isError, undefined);
  assert.equal(cliCalls, 1, 'the real CLI reached its injected request');
  assert.equal(mcpCalls, 1, 'the real MCP handler reached its injected read');
  return [workerText(body), appText(body), printed.join('\n'), rpc.result.content.map(c => c.text).join('\n')];
}

test('unclassified topic rows withhold all totals and keep amounts before one final offer on every surface', async t => {
  const f = fixture(t);
  const body = await ask(f);
  unconfirmed(body);
  offerLast(body.answer);
  for (const text of await surfaces(t, body)) {
    offerLast(text);
    assert.ok(text.includes(separateOffers(body.answer).facts), 'every original fact is retained');
  }
});

function confirm(f, where = '') {
  f.raw(`UPDATE fin_transactions SET category='materials',category_basis_state='confirmed' ${where}`);
}

function confirmed(body, expected) {
  assert.equal(body.ledger.total_minor, expected);
  assert.equal(body.ledger.lead_total_minor, expected);
  assert.equal(body.ledger.if_own_transfers.total_minor, expected);
  assert.equal(body.ledger.found, true);
  assert.equal(body.ledger.category_total_unconfirmed, undefined);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.evidence_gate.partial, false);
  assert.match(body.answer, new RegExp(`Total spend for materials: \\$${(expected / 100).toFixed(2).replace('.', '\\.')}`));
}

test('two confirmed category rows still answer with their total', async t => {
  const f = fixture(t);
  confirm(f);
  assert.equal(f.first("SELECT count(*) n FROM fin_transactions WHERE category_basis_state='confirmed'").n, 2);
  const body = await ask(f);
  confirmed(body, 2000);
  assert.equal(body.ledger.unsorted_minor, 0);
});

test('a confirmed category match withholds its total beside unclassified evidence', async t => {
  const f = fixture(t);
  confirm(f, "WHERE txn_uid='description-0'");
  const body = await ask(f);
  unconfirmed(body, 1250);
  assert.equal(body.ledger.confirmed_category_subtotal_minor, 750);
  assert.match(body.answer, /Confirmed in materials \(subtotal\): \$7\.50 \[1\]\./);
  assert.match(body.answer, /Transactions without a confirmed category: \$12\.50 \[2\]\./);
  assert.doesNotMatch(body.answer, /separate from the requested category|Total spend for/);
});

test('a merchant total does not require category membership', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_transactions SET payee='Store Unit'");
  const body = await ask(f, withLedgerAnswer, 'How much did I spend at Store Unit in September 2026?');
  assert.equal(body.ledger.match_basis, 'exact', 'the real merchant selector reached its exact match');
  assert.equal(body.ledger.total_minor, 2000);
  assert.equal(body.ledger.category_total_unconfirmed, undefined);
  assert.equal(body.evidence_gate.complete, true);
  for (const render of [workerText, appText]) assert.match(render(body), /You spent \$20\.00 at Store Unit/);
});

test('disabling the category guard in memory fails the same contract beside a green control', async t => {
  const url = new URL('../worker/src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const site = 'if (intent.kind === "category" && intent.match && !explicitBucket && unsorted.length) {';
  assert.equal(source.split(site).length - 1, 1, 'one real topic-total guard is selected');
  const restored = source.replace(site, 'if (false) {')
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g,
      (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  assert.notEqual(restored, source, 'the guard is disabled only in memory');
  const mutant = (await import(`data:text/javascript;base64,${Buffer.from(restored).toString('base64')}`)).withLedgerAnswer;
  const f = fixture(t);
  unconfirmed(await ask(f));
  const bad = await ask(f, mutant);
  assert.equal(bad.ledger.total_minor, 0, 'the mutant reached the erroneous zero decision');
  assert.match(bad.answer, /Total spend for materials: \$0\.00/);
  assert.throws(() => unconfirmed(bad), error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.ok(error.message.startsWith('topic total is withheld'), 'the money assertion turns red');
    return true;
  });
  for (const text of await surfaces(t, bad)) {
    assert.match(text, /Total spend for materials: \$0\.00/, 'the mutant reaches each real surface');
    assert.throws(() => offerLast(text), assert.AssertionError, 'the same surface contract rejects the mutant');
  }
  confirm(f);
  confirmed(await ask(f, mutant), 2000);
});

test('restoring the no-match restriction loses the matched-category withholding contract', async t => {
  const url = new URL('../worker/src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const site = 'if (intent.kind === "category" && intent.match && !explicitBucket && unsorted.length) {';
  assert.equal(source.split(site).length - 1, 1);
  const restored = source.replace(site, site.replace('&& unsorted.length', '&& !matched.length && unsorted.length'))
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g,
      (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  const mutant = (await import(`data:text/javascript;base64,${Buffer.from(restored).toString('base64')}`)).withLedgerAnswer;
  const f = fixture(t);
  confirm(f, "WHERE txn_uid='description-0'");
  unconfirmed(await ask(f), 1250);
  const bad = await ask(f, mutant);
  assert.equal(bad.ledger.total_minor, 750, 'restored decision certifies only the matched row');
  assert.throws(() => unconfirmed(bad, 1250), assert.AssertionError);
  confirm(f);
  confirmed(await ask(f, mutant), 2000);
});

test('restoring the generic final offer loses record review on an unknown category', async t => {
  const f = fixture(t);
  const body = await ask(f);
  unconfirmed(body);
  const url = new URL('../worker/src/lib/ledger-clarification.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const site = 'topicUnconfirmed(body.ledger) ? originalRecordSuggestion';
  assert.equal(source.split(site).length - 1, 1, 'one final offer decision');
  const restored = source.replace(site, 'false ? originalRecordSuggestion')
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g,
      (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  const mutant = (await import(`data:text/javascript;base64,${Buffer.from(restored).toString('base64')}`)).finalLedgerOffer;
  const generic = 'Want me to show your account balances?';
  offerLast(finalLedgerOffer(body, generic).answer);
  const bad = mutant(body, generic);
  assert.deepEqual(separateOffers(bad.answer).offers, [generic], 'restored final decision reached');
  assert.throws(() => offerLast(bad.answer), assert.AssertionError);
  confirm(f);
  const control = await ask(f);
  confirmed(control, 2000);
  assert.equal(mutant(control, generic).answer, finalLedgerOffer(control, generic).answer,
    'the confirmed-category offer stays green');
});
