import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { readFileSync } from 'node:fs';

const phrases = [
  'How much did I spend at Google this month?',
  'How much did we spend at Google this month?',
  'Show me spending at Google this month',
  'Show spend at Google this month',
  'What is my spending at Google this month?',
  'How much did I pay to Google this month?',
];
for (const question of phrases) for (const empty of [false, true]) {
  test(`covered vendor family ${empty ? 'empty' : 'Workspace/Cloud'}: ${question}`, async t => {
    const f = ledgerFixture(t);
    if (!empty) {
      f.add('workspace', 'Card purchase', 'GOOGLE *WORKSPACE', { cents: 452, direction: 'outflow' });
      f.add('cloud', 'Card purchase', 'GOOG *CLOUD', { cents: 463, direction: 'outflow' });
    }
    const b = await f.ask(question);
    assert.equal(b.ledger?.total_minor, empty ? null : 915);
    assert.equal(b.ledger.complete, !empty);
    assert.equal(b.evidence_gate.complete, !empty);
    assert.equal(b.ledger.coverage.complete, true);
    if (empty) {
      assert.match(b.answer, /^No charges found for Google from 2026-10-01 to 2026-10-12 on /);
      assert.doesNotMatch(b.answer, /\$/);
    } else assert.match(b.answer, /fully covered/);
    assert.equal(b.citations.length, empty ? 0 : 2);
    if (!empty) {
      assert.deepEqual(b.ledger.groups.map(g => g.total_minor).sort(), [452, 463]);
      assert.match(b.answer, /GOOGLE \*WORKSPACE/);
      assert.match(b.answer, /GOOG \*CLOUD/);
    }
  });
}

test('descriptor rule is generic; plain similar names, isolated abbreviations and colliding roots stay unconfirmed', async t => {
  for (const [root, short] of [['Cedarstone', 'CEDA'], ['Amberbrook', 'AMBE']]) {
    const f = ledgerFixture(t);
    f.add('full', 'Card purchase', `${root} *TOOLS`, { cents: 123, direction: 'outflow' });
    f.add('short', 'Card purchase', `${short} *MEDIA`, { cents: 234, direction: 'outflow' });
    const b = await f.ask(`How much did I spend at ${root} this month?`);
    assert.equal(b.ledger.total_minor, 123);
    f.add('similar', 'Card purchase', `${root} Cafe`, { cents: 9999, direction: 'outflow' });
    const ambiguous = await f.ask(`How much did I spend at ${root} this month?`);
    assert.equal(ambiguous.ledger.total_minor, null);
    assert.equal(ambiguous.evidence_gate.complete, false);
  }
  const f = ledgerFixture(t);
  f.add('short', 'Card purchase', 'CEDA *MEDIA', { cents: 234, direction: 'outflow' });
  assert.equal((await f.ask('How much did I spend at Cedarstone this month?')).ledger.total_minor, null);
  f.add('full', 'Card purchase', 'Cedarstone *TOOLS', { cents: 123, direction: 'outflow' });
  f.add('collision', 'Card purchase', 'Cedarforest *TOOLS', { cents: 9999, direction: 'outflow' });
  const b = await f.ask('How much did I spend at Cedarstone this month?');
  assert.equal(b.ledger.total_minor, 123);
  assert.equal(b.evidence_gate.complete, true);
});

test('uncovered family and empty coverage never manufacture a complete figure', async t => {
  for (const empty of [false, true]) {
    const f = ledgerFixture(t);
    if (!empty) f.add('full', 'Card purchase', 'Cedarstone *TOOLS', { cents: 123, direction: 'outflow' });
    f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-07'");
    const b = await f.ask('How much did I spend at Cedarstone this month?');
    assert.equal(b.ledger?.total_minor ?? null, null);
    assert.equal(b.evidence_gate.complete, false);
  }
});

// Mutations use fresh module URLs; reviewed source on disk is never changed.
const base = new URL('../src/lib/', import.meta.url);
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const absolute = source => source.replace(/from (["'])(\.\/.+?)\1/g,
  (_, quote, path) => `from ${quote}${new URL(path, base).href}${quote}`);
const analysis = readFileSync(new URL('ledger-analysis.js', base), 'utf8');
const answer = readFileSync(new URL('ledger-answer.js', base), 'utf8');
for (const [name, file, from, to, empty] of [
  ['descriptor family suppressed', 'analysis', 'root === wanted', 'false', false],
  ['reviewed alias descriptor dropped', 'analysis', 'aliases.includes(root || identity)', 'false', false],
  ['covered absence overclaims zero', 'answer', 'ledger.complete = false; ledger.found = possibleCandidates ? null : false; ledger.total_minor = null;', 'ledger.complete = false; ledger.found = possibleCandidates ? null : false; ledger.total_minor = 0;', true],
]) test(`kills ${name}`, async t => {
  const source = file === 'analysis' ? analysis : answer;
  assert.equal(source.split(from).length - 1, 1, 'one mutation site');
  const changed = file === 'analysis'
    ? answer.replace('"./ledger-analysis.js"', JSON.stringify(data(absolute(analysis.replace(from, to)))))
    : answer.replace(from, to);
  const mutant = (await import(data(absolute(changed)))).withLedgerAnswer;
  const f = ledgerFixture(t);
  if (!empty) {
    f.add('workspace', 'Card purchase', 'GOOGLE *WORKSPACE', { cents: 452, direction: 'outflow' });
    f.add('cloud', 'Card purchase', 'GOOG *CLOUD', { cents: 463, direction: 'outflow' });
  }
  const check = body => assert.equal(body.ledger.total_minor, empty ? null : 915);
  check(await f.ask(phrases[0]));
  const broken = await (await mutant({ env: f.env, question: phrases[0], now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner' },
  async () => Response.json({ route: 'documents' }))).json();
  assert.throws(() => check(broken), { name: 'AssertionError' });
  check(await f.ask(phrases[0]));
});
