import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';
import { facts, disclosed, comparisonSetup, aligned } from './date-word-review-fixture.mjs';

async function moduleCopy(file, changes = [], links = {}) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  let source = readFileSync(url, 'utf8');
  for (const [before, after] of changes) {
    assert.equal(source.split(before).length - 1, 1, 'unique mutation decision reached');
    source = source.replace(before, after);
  }
  source = source.replace(/from (["'])(\.\/[^"']+)\1/g,
    (_, quote, path) => `from ${quote}${links[path] || new URL(path, url).href}${quote}`);
  const href = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return { api: await import(href), href };
}
async function reader(calendarChanges = [], compilerChanges = [], answerChanges = []) {
  const calendar = await moduleCopy('ledger-intent-calendar.js', calendarChanges);
  const compiler = await moduleCopy('ledger-intent.js', compilerChanges, { './ledger-intent-calendar.js': calendar.href });
  return (await moduleCopy('ledger-answer.js', answerChanges, { './ledger-intent.js': compiler.href })).api.withLedgerAnswer;
}

for (const [word, before, after, question] of [
  ['late', '(?:early|late|mid)', '(?:early|mid)', 'Show expenses late October 2026'],
  ['early', '(?:early|late|mid)', '(?:late|mid)', 'Show expenses early October 2026'],
  ['outside', '|outside|', '|', 'Show expenses outside October 2026'],
  ['before 10:00', String.raw`\\d{1,2}:\\d{2}(?:\\s*[ap]m)?|`, '', 'Show expenses October 2026 before 10:00'],
]) test(`R1 mutant killed: dropped ${word} limit`, async t => {
  const f = setup(t);
  disclosed(await ask(f, question, raw(intent())), word);
  const api = await reader([[before, after]]);
  const bad = await ask(f, question, raw(intent()), api);
  facts(bad); assert.equal(bad.body.ledger.total_minor, 1700);
  assert.throws(() => disclosed(bad, word), assert.AssertionError);
  const peer = await ask(f, 'Show expenses from 2026-10-20 to 2026-10-31', raw(intent()), api);
  facts(peer); assert.equal(peer.body.ledger.total_minor, 0);
});

test('R1 mutant killed: unused words retained in metadata but omitted from prose', async t => {
  const f = setup(t), q = 'Show expenses late October 2026';
  disclosed(await ask(f, q, raw(intent())), 'late');
  const api = await reader([], [["${unusedLimits}`;", "`;" ]]);
  const bad = await ask(f, q, raw(intent()), api);
  facts(bad); assert.equal(bad.body.ledger.total_minor, 1700);
  assert.throws(() => disclosed(bad, 'late'), assert.AssertionError);
  const peer = await ask(f, 'Show expenses from 2026-10-01 to 2026-10-31', raw(intent()), api);
  facts(peer); assert.equal(peer.body.ledger.total_minor, 1700);
});

for (const reverse of [false, true]) test(`R2 mutant killed: ${reverse ? 'question-order reads' : 'uncapped dependent window'}`, async t => {
  const f = comparisonSetup(t);
  const q = reverse ? 'Compare expenses the same days last month versus this month so far'
    : 'Compare expenses this month so far versus the same days last month';
  aligned(await ask(f, q, raw(intent(), intent())), reverse);
  const change = reverse
    ? ['.sort((a, b) => Number(Boolean(a.intent.comparisonWindow)) - Number(Boolean(b.intent.comparisonWindow)))', '.sort((a, b) => a.index - b.index)']
    : ['if (intent.comparisonWindow) {', 'if (false) {'];
  const api = await reader([], [], [change]);
  const bad = await ask(f, q, raw(intent(), intent()), api);
  facts(bad); assert.ok(bad.body.ledger.parts.some(p => p.expense_total_minor === 4500));
  assert.equal(bad.body.ledger.comparison, undefined, 'alignment guard also contains the wrong range');
  assert.equal(bad.body.ledger.comparison_unavailable.reason, 'period_alignment');
  assert.throws(() => aligned(bad, reverse), assert.AssertionError);
  const peer = await ask(f, 'Show expenses from 2026-10-01 to 2026-10-02', raw(intent()), api);
  facts(peer); assert.equal(peer.body.ledger.total_minor, 500);
});

test('R3 mutant killed: outer clarification uses the pre-coverage interpretation', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-11-02'");
  f.add('main', '2026-11-02', 731, 'inflow');
  const q = 'how much money came in this month so far, by payer';
  const oracle = r => {
    facts(r); assert.equal(r.body.ledger.combined_inflow_minor, 731);
    assert.equal(r.body.ledger.to, '2026-11-02');
    assert.match(r.body.answer.split('\n')[0], /for November 1 to 2/);
    assert.doesNotMatch(r.body.clarification.best_reading, /for November 1 to 3/);
  };
  oracle(await ask(f, q, raw(intent('totals'))));
  const api = await reader([], [], [[
    '({ ...intent, interpretation: ledgerIntentInterpretation(intent, intent.presentation, records[index]?.amount_basis) })', 'intent',
  ]]);
  const bad = await ask(f, q, raw(intent('totals')), api);
  facts(bad); assert.equal(bad.body.ledger.to, '2026-11-02');
  assert.throws(() => oracle(bad), assert.AssertionError);
  const peer = await ask(f, 'Show money in from 2026-11-01 to 2026-11-02', raw(intent('totals')), api);
  oracle(peer);
});

test('R2 mutant killed: different month lengths still emit an exact difference', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-03-30'");
  f.add('main', '2026-03-02', 900); f.add('main', '2026-03-30', 8000);
  f.add('main', '2026-02-02', 500);
  const clock = { now: Date.parse('2026-03-31T12:00:00Z') };
  const q = 'Compare expenses this month so far versus the same days last month';
  const oracle = r => {
    facts(r); assert.deepEqual(r.body.ledger.parts.map(p => p.expense_total_minor), [8900, 500]);
    assert.equal(r.body.ledger.comparison, undefined);
    assert.equal(r.body.ledger.comparison_unavailable.reason, 'period_alignment');
    assert.match(r.body.answer, /same number of days/);
  };
  oracle(await ask(f, q, raw(intent(), intent()), undefined, clock));
  const api = await reader([], [], [['const aligned = extracted.every(', 'const aligned = true || extracted.every(']]);
  const bad = await ask(f, q, raw(intent(), intent()), api, clock);
  facts(bad); assert.equal(bad.body.ledger.comparison.difference_minor, 8400);
  assert.throws(() => oracle(bad), assert.AssertionError);
  const peer = await ask(f, 'Show expenses from 2026-02-01 to 2026-02-28', raw(intent()), api, clock);
  facts(peer); assert.equal(peer.body.ledger.total_minor, 500);
});
