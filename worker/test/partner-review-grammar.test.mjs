// Partner review repros for the bank-description grammar (made-up data only).
// Each PR-G test fails on HEAD 07420ce; each "control" test passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeInflow, payerRegistry, payerQuestionRegistry, createInflowAttributor,
  resolveRequestedPayer, selectAttributedInflows } from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

const codepoints = text => [...text].length;

// ---------------------------------------------------------------------------
// PR-G1: the undocumented 32768-step budget refuses a description that is
// inside every published cap (512 code points, 12 fields, 64 parses).
const longName = 'Acme Widget Holdings International Distribution Services Corp';
const achFields = [
  `ORIG CO NAME:${longName}`, 'ORIG ID:1234567890', 'DESC DATE:251015', 'CO ENTRY DESCR:PAYROLL',
  'SEC:CCD', 'TRACE#:123456789012345', 'EFF DATE:251015', 'INDIVIDUAL ID:A1234',
  'INDIVIDUAL NAME:Recipient Example Household Operating Account', 'REF:INV-2025-0001', 'MEMO:OCT',
];
const longRegistry = () => payerRegistry([{ entity_slug: 'acme', legal_name: longName }]);

test('PR-G1 control: same ACH fields joined by semicolons, and a shorter space-joined form, confirm', () => {
  const semis = attributeInflow({ description: achFields.join('; ') }, longRegistry());
  assert.equal(semis.state, 'confirmed');
  const shorter = attributeInflow({ description: achFields.slice(0, 6).join(' ') }, longRegistry());
  assert.equal(shorter.state, 'confirmed');
});

test('PR-G1 step budget refuses a space-joined ACH description inside all published caps', async t => {
  const description = achFields.join(' ');
  assert.ok(codepoints(description) <= 512, 'inside the 512 code point cap');
  assert.equal(achFields.length, 11, 'inside the 12 field cap');
  // Deterministic scaling: parser steps per prefix of the same field list.
  const scaling = [];
  for (let n = 4; n <= achFields.length; n++) {
    const r = attributeInflow({ description: achFields.slice(0, n).join(' ') }, longRegistry());
    scaling.push({ fields: n, codepoints: codepoints(achFields.slice(0, n).join(' ')), steps: r.evidence.parser.steps, refusal: r.evidence.parser.refusal });
  }
  t.diagnostic(JSON.stringify({ scaling }));
  const result = attributeInflow({ description }, longRegistry());
  assert.equal(result.evidence.parser.refusal, null, `refused by ${result.evidence.parser.refusal} at ${result.evidence.parser.steps} steps`);
  assert.equal(result.state, 'confirmed');
});

// ---------------------------------------------------------------------------
// PR-G2: an unregistered question phrase accepts a comma at ANY position in a
// labelled sender, so the reversed "Payer, Contact" spelling counts as
// "Payer Contact". The registered spelling refuses the identical text.
const now = Date.parse('2026-10-19T12:00:00Z');
const incomeQuestion = 'How much did I receive from Payer Contact in September?';
function phraseDecision(description, identities = []) {
  const intent = classifyLedgerQuestion(incomeQuestion, { now });
  const ids = payerRegistry(identities);
  const attribution = createInflowAttributor(payerQuestionRegistry(intent, ids));
  const row = { id: 1, description, amount_minor: 50000, direction: 'inflow' };
  const a = attribution(row);
  const wanted = resolveRequestedPayer(intent, ids, [a]);
  return { a, wanted, ...selectAttributedInflows([row], new Map([[1, a]]), { wanted, amountMinor: null }) };
}

test('PR-G2 control: exact labelled phrase matches; registered name refuses a mid-name comma', () => {
  const exact = phraseDecision('From: Payer Contact');
  assert.equal(exact.a.state, 'observed');
  assert.equal(exact.matched.length, 1);
  const registered = phraseDecision('From: Payer, Contact', [{ entity_slug: 'payer', legal_name: 'Payer Contact' }]);
  assert.equal(registered.a.state, 'unknown');
  assert.equal(registered.matched.length, 0);
});

test('PR-G2 phrase-only payer accepts a mid-name comma that the registered path refuses', async t => {
  const problems = [];
  const comma = phraseDecision('From: Payer, Contact');
  if (comma.a.state !== 'unknown') problems.push(`attribution ${comma.a.state} for reading "${comma.a.reading?.identity}"`);
  if (comma.matched.length) problems.push('a Last, First sender counted as the asked payer');
  // End to end through the real answer path. The displayed sender is masked,
  // so the comma inversion is not visible to the reader.
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('receipt', 'FROM: Payer, Contact', null);
  const body = await f.ask('Did the payment from Payer Contact arrive in October 2026?');
  assert.equal(body.ledger.kind, 'payment', 'real ledger decision reached');
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
  if (body.ledger.found === true) problems.push(`answer found=true: ${body.answer.split('\n')[0]}`);
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// PR-G3: default-ignorable code points with General_Category Mn pass the
// alphabet. At a token end they are erased, so the payer is confirmed.
const one = () => payerRegistry([{ entity_slug: 'one', legal_name: 'Payer One' }]);

test('PR-G3 control: zero-width space (Cf) is refused by the alphabet', () => {
  const r = attributeInflow({ description: 'FROM: Payer One​' }, one());
  assert.equal(r.state, 'unknown');
  assert.equal(r.evidence.parser.refusal, 'alphabet');
});

test('PR-G3 default-ignorable marks (CGJ, variation selectors, Mongolian FVS) pass the alphabet', () => {
  assert.equal(attributeInflow({ description: 'FROM: Payer One' }, one()).state, 'confirmed');
  const slipped = [];
  for (const char of ['͏', '️', '\u{E0100}', '᠋']) {
    const r = attributeInflow({ description: `FROM: Payer One${char}` }, one());
    if (r.state !== 'unknown' || r.evidence.parser.refusal !== 'alphabet')
      slipped.push(`U+${char.codePointAt(0).toString(16).toUpperCase()} -> ${r.state}/${r.evidence.parser.refusal}`);
  }
  assert.deepEqual(slipped, []);
});

// ---------------------------------------------------------------------------
// PR-G4: a combining mark with no precomposed form is dropped at a token end,
// so a differently spelled name matches the registry exactly. A mark that does
// precompose keeps the names distinct.
test('PR-G4 control: a precomposing tone mark keeps a distinct name distinct', () => {
  const r = attributeInflow({ description: 'FROM: Adè Foods' }, payerRegistry([{ entity_slug: 'ade', legal_name: 'Ade Foods' }]));
  assert.equal(r.state, 'unknown');
});

test('PR-G4 non-composing tone mark is erased and a distinct name matches the registry', () => {
  assert.equal(attributeInflow({ description: 'FROM: Adẹ Foods' },
    payerRegistry([{ entity_slug: 'ade', legal_name: 'Adẹ Foods' }])).state, 'confirmed');
  const r = attributeInflow({ description: 'FROM: Adẹ̀ Foods' },
    payerRegistry([{ entity_slug: 'ade', legal_name: 'Adẹ Foods' }]));
  assert.ok(r.evidence.parser.steps > 0, 'normalization decision reached');
  assert.equal(r.state, 'unknown', `got ${r.state}`);
});

// ---------------------------------------------------------------------------
// PR-G5: a trailing or leading line break becomes a dangling field separator,
// while a trailing space is trimmed.
test('PR-G5 control: a trailing space is trimmed and the payer confirms', () => {
  assert.equal(attributeInflow({ description: 'FROM: Payer One ' }, one()).state, 'confirmed');
});

test('PR-G5 a trailing or leading line break refuses a registered sender', () => {
  const refused = [];
  for (const description of ['FROM: Payer One\n', 'FROM: Payer One\r\n', 'FROM: Payer One ', '\nFROM: Payer One']) {
    const r = attributeInflow({ description }, one());
    if (r.state !== 'confirmed') refused.push(`${JSON.stringify(description)} -> ${r.state}/${r.evidence.parser.refusal}`);
  }
  assert.deepEqual(refused, []);
});
