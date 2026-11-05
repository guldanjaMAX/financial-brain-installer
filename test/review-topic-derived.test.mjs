import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from '../worker/test/ledger-review-fixture.mjs';
import { recordedIntent } from '../worker/test/fixtures/ledger-intent-cases.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { separateOffers } from '../worker/src/lib/answer-render.js';

test.beforeEach(t => t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden')));

function fixture(t, { unclassified = false } = {}) {
  const f = ledgerFixture(t);
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.add('september', 'synthetic materials', null, { cents: 750, direction: 'outflow', date: '2026-09-05' });
  f.add('august', 'synthetic materials', null, { cents: 500, direction: 'outflow', date: '2026-08-05' });
  f.raw("UPDATE fin_transactions SET category='materials',category_basis_state='confirmed'");
  if (unclassified) f.add('unknown', 'synthetic purchase', null, { cents: 1250, direction: 'outflow', date: '2026-09-06' });
  assert.equal(f.first("SELECT count(*) n FROM fin_transactions WHERE category_basis_state='confirmed'").n, 2);
  return f;
}

async function ask(t, f, question, intents, handler = withLedgerAnswer) {
  let models = 0, fallbacks = 0;
  const start = f.calls.length;
  const response = await handler({ env: f.env, question, now: NOW, timeZone: 'UTC',
    grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
      models++;
      return { content: [{ type: 'text', text: JSON.stringify({ intents }) }] };
    } }, async () => { fallbacks++; return Response.json({ route: 'documents', answer: null, gaps: [] }); });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(models, 1, 'real model intent extraction reached its injected dependency');
  assert.equal(fallbacks, 0, 'real validated ledger route handled the request');
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction reader reached');
  t.diagnostic(JSON.stringify({ ledger: body.ledger, evidence: body.evidence_gate, answer: body.answer }));
  return body;
}

const category = month => recordedIntent('category', { direction: 'outflow', vendor_text: 'materials',
  period: { type: 'between', from: `2026-${month}-01`, to: `2026-${month}-${month === '09' ? '30' : '31'}` } });

function withheld(body, reading = body.ledger) {
  for (const key of ['total_minor', 'expense_total_minor', 'lead_total_minor', 'found'])
    assert.equal(reading[key], null, `${key} is unknown`);
  assert.equal(reading.if_own_transfers.total_minor, null);
  assert.equal(reading.if_own_transfers.complete, false);
  assert.equal(reading.complete, false);
  assert.equal(reading.category_total_unconfirmed, true);
  assert.equal(reading.unsorted_minor, 1250);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
  assert.deepEqual(body.citations.filter(c => c.posted_on?.startsWith('2026-09')).map(c => c.amount_minor).sort((a, b) => a - b),
    [750, 1250], 'both confirmed and unclassified September evidence is retained');
  assert.doesNotMatch(body.answer, /Category 'materials': \$7\.50|separate from the requested category/);
  assert.deepEqual(separateOffers(body.answer).offers, ['Want to check the original record?']);
  assert.ok(body.answer.endsWith('Want to check the original record?'));
}

test('control: model category route retains a confirmed-only category total', async t => {
  const f = fixture(t);
  const body = await ask(t, f, 'Could you retrieve materials spending in September 2026?', [category('09')]);
  assert.equal(body.ledger.total_minor, 750);
  assert.equal(body.ledger.complete, true, 'the confirmed category reading is complete');
  assert.equal(body.intent_outcome, 'clarify', 'the model wording still needs clarification');
  assert.equal(body.evidence_gate.complete, false, 'the clarification envelope is independently partial');
});

test('model category route must not certify a topic total after filtering away unclassified rows', async t => {
  const f = fixture(t, { unclassified: true });
  assert.equal(f.first('SELECT count(*) n FROM fin_transactions WHERE category IS NULL').n, 1);
  const body = await ask(t, f, 'Could you retrieve materials spending in September 2026?', [category('09')]);
  assert.equal(body.ledger.total_minor, null, 'unknown topic total must be withheld on the model category route');
  withheld(body);
});

test('control: complete topic periods still produce an exact comparison', async t => {
  const f = fixture(t);
  const body = await ask(t, f, 'Could you compare materials spending in September 2026 against materials spending in August 2026?',
    [category('09'), category('08')]);
  assert.equal(body.ledger.kind, 'multi');
  assert.equal(body.ledger.parts.length, 2, 'both real period decisions reached');
  assert.deepEqual(body.ledger.comparison, { figures_minor: [750, 500], difference_minor: 250 });
});

test('a category comparison must be withheld when one topic total is unknown', async t => {
  const f = fixture(t, { unclassified: true });
  const body = await ask(t, f, 'Could you compare materials spending in September 2026 against materials spending in August 2026?',
    [category('09'), category('08')]);
  assert.equal(body.ledger.kind, 'multi');
  assert.equal(body.ledger.parts.length, 2, 'both real period decisions reached');
  assert.equal(body.ledger.comparison, undefined, 'unknown topic membership cannot certify a difference');
  assert.doesNotMatch(body.answer, /first minus second/);
  withheld(body, body.ledger.parts[0]);
  assert.equal(body.ledger.parts[1].total_minor, 500, 'the other period remains confirmed');
});

test('restoring model category filtering fails withholding and comparison beside a green control', async t => {
  const url = new URL('../worker/src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const site = 'if (intent.categorySelector && !categoryTotalUnconfirmed) {';
  assert.equal(source.split(site).length - 1, 1, 'one real model category branch');
  const restored = source.replace(site, 'if (intent.categorySelector) {')
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g,
      (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  const mutant = (await import(`data:text/javascript;base64,${Buffer.from(restored).toString('base64')}`)).withLedgerAnswer;
  const f = fixture(t, { unclassified: true });
  const question = 'Could you compare materials spending in September 2026 against materials spending in August 2026?';
  const intents = [category('09'), category('08')];
  const good = await ask(t, f, question, intents);
  withheld(good, good.ledger.parts[0]);
  const bad = await ask(t, f, question, intents, mutant);
  assert.equal(bad.ledger.parts.length, 2);
  assert.equal(bad.ledger.parts[0].total_minor, 750, 'restored filter reached its subtotal certification');
  assert.deepEqual(bad.ledger.comparison, { figures_minor: [750, 500], difference_minor: 250 });
  assert.throws(() => withheld(bad, bad.ledger.parts[0]), assert.AssertionError);
  const control = await ask(t, fixture(t), question, intents, mutant);
  assert.deepEqual(control.ledger.comparison, { figures_minor: [750, 500], difference_minor: 250 });
});
