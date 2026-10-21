// Partner review round 5, lens: leaks and allowlist. Synthetic fixtures only;
// every name is a role word and every number below is made up.
//
// Expected on e847233: the "repro" test fails and the "control" test passes.
//   R5-LEAK-1  two or more adjacent punctuation-shaped letters between digit
//              groups still split the digit run after the round-4 fix, so a
//              16-digit value separated by "ǀǀ", "ǃǃ", "ꞏꞏ" or "ºº" is echoed
//              from every fast-path surface
import test from 'node:test';
import assert from 'node:assert/strict';
import { address, card, plainAddress } from './partner-r2-helpers.mjs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

globalThis.fetch = () => { throw new Error('network forbidden'); };

const now = Date.parse('2034-10-20');
const label = text => [...text].map(char => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
const separated = sep => `4111${sep}1111${sep}1111${sep}1111`;

function subjectCard(subject, field = 'company', value = 'Synthetic Services') {
  return entityFactAnswer({ question: `What is ${subject}'s ${field}?`, owner: subject, now,
    results: [{ client: subject, title: 'Contact record', snippet: `Name: ${subject}\n${field}: ${value}` }],
    docs: [{ n: 1, ref: 'fixture-card', client: subject, title: 'Contact record', source_kind: 'curated',
      date_source: 'record:updated', date_reliable: true, ts: '2034-10-16', text_source: 'native', text_reliable: true,
      lineage: { status: 'known', kind: 'source_record' }, authority: {} }] });
}

// Every fast-path surface that renders a free-text value or the subject label.
function surfaces(value) {
  const out = [];
  for (const operative of [false, true]) {
    for (const field of ['company', 'role'])
      out.push([`${field}${operative ? ' (operative)' : ''}`, card(field, `Synthetic Services ${value}`, entityFactAnswer, operative)]);
    // Away from the ZIP so the five-digit ZIP cannot join the run and mask the defect.
    out.push([`address${operative ? ' (operative)' : ''}`, card('address', `12 Synthetic Road ${value}, Fixture City, AZ 85001`, entityFactAnswer, operative)]);
  }
  out.push(['dated owner address', address(`12 Synthetic Road ${value}, Fixture City, AZ 85001`)]);
  out.push(['subject', subjectCard(`Record Owner ${value}`)]);
  return out;
}

function refusedEverywhere(sep) {
  for (const [surface, result] of surfaces(separated(sep)))
    assert.equal(result, null, `${surface} echoed a ${label(sep)}-separated 16-digit value: ${JSON.stringify(result?.answer)}`);
}

// A repro collects every echo before asserting, so one failure names every
// separator and surface that leaks instead of stopping at the first.
function echoes(separators) {
  const leaked = [];
  for (const sep of separators)
    for (const [surface, result] of surfaces(separated(sep)))
      if (result !== null) leaked.push({ separator: label(sep), surface, answer: result.answer });
  return leaked;
}
const summarize = leaked => `${leaked.length} echoes across ${new Set(leaked.map(l => l.separator)).size} separators and ` +
  `${new Set(leaked.map(l => l.surface)).size} surfaces, e.g. ${JSON.stringify(leaked[0])}`;

// ----------------------------------------------------------- R5-LEAK-1 --
// entity-fact-answer.js:50-73 (codePointRunText) decides, per run of letters,
// whether the run splits two digit groups: a LONE letter joins the groups
// when it is not an ASCII letter or when it touches a digit on both sides
// (:67-69), but a run of two or more letters is always kept as a splitting
// word (:69, "every word of two or more letters still split the run", :97).
// The first strip at :100 keeps every letter as well. So the round-4 class
// (R4-LEAK-1: punctuation-shaped letters outside the modifier and ignorable
// classes, U+01C0 ǀ, U+01C1 ǁ, U+01C2 ǂ, U+01C3 ǃ, U+A78F ꞏ, U+00AA ª,
// U+00BA º, U+3006 〆, U+16C1 ᛁ, U+2D4F ⵏ) is closed only when ONE such letter
// stands between two digit groups. Doubling it ("4111ǀǀ1111ǀǀ1111ǀǀ1111",
// which renders as 4111||1111||1111||1111; "ǃǃ" as !!, "ꞏꞏ" as ··, "ºº" as °°),
// mixing two of them ("ǀꞏ"), tripling it, or placing a combining mark or a
// modifier apostrophe between two of them ("ǀ́ǀ", "ǀʼǀ": marks and modifier
// letters are dropped at :53, leaving a two-letter run) makes the run a
// "word", and the value passes unsafeScalarFact, the company, role, address
// and subject shape regexes (every one admits \p{L}) and safeSubject. The
// 16-digit value is echoed verbatim from a company, a role, an address, a
// dated owner address and the rendered subject label, with the verifier
// hard-coded to supported=true for a fact answer (index.js:1396).
// Not R4-LEAK-1: that test (and the round-4 fix) covers one letter between
// groups; here every separator is a run of two or more of the same class.
// Not R4-LEAK-2 / R3-LEAK-3-1: no modifier or ignorable letter is the
// separator; where one appears ("ǀʼǀ") it is already dropped by the fix and
// the leak comes from the two letters that remain.
const DOUBLED_PUNCTUATION_SHAPED_LETTERS = ['ǀǀ', 'ǁǀ', 'ǂǂ', 'ǃǃ', 'ꞏꞏ', 'ǀꞏ', 'ºº', 'ªª', '〆〆', 'ᛁᛁ', 'ⵏⵏ', 'ǀǀǀ'];
const INTERRUPTED_PAIRS = ['ǀ́ǀ', 'ǀʼǀ'];

test('R5-LEAK-1 repro: two adjacent punctuation-shaped letters carry a 16-digit value through every fast-path surface', t => {
  for (const sep of DOUBLED_PUNCTUATION_SHAPED_LETTERS)
    for (const char of sep)
      assert.ok(/^\p{L}$/u.test(char) && !/\p{Lm}|\p{Default_Ignorable_Code_Point}/u.test(char), `${label(char)} is a non-modifier, non-ignorable letter`);
  for (const sep of INTERRUPTED_PAIRS)
    assert.ok(/^\p{L}(?:\p{M}|\p{Lm})\p{L}$/u.test(sep), `${label(sep)} is two letters around a mark or modifier letter`);
  const leaked = echoes([...DOUBLED_PUNCTUATION_SHAPED_LETTERS, ...INTERRUPTED_PAIRS]);
  // ASCII letter pairs that render like bars ("II", "ll") echo the same way;
  // recorded as a diagnostic only, since the contract counts them as words.
  const asciiPairs = ['II', 'll'].filter(sep => card('company', `Synthetic Services ${separated(sep)}`) !== null);
  t.diagnostic(JSON.stringify({ separators: DOUBLED_PUNCTUATION_SHAPED_LETTERS.length + INTERRUPTED_PAIRS.length,
    surfaces: surfaces('').length, echoes: leaked.length, asciiPairsEchoed: asciiPairs }));
  assert.equal(leaked.length, 0, summarize(leaked));
});

test('R5-LEAK-1 control: one punctuation-shaped letter, ASCII, modifier-letter and filler separators stay refused everywhere, and ordinary words of the same scripts answer', () => {
  // The round-4 fix holds for a single punctuation-shaped letter between
  // groups, and the earlier rounds hold for ASCII, modifier and filler
  // separators, on every surface.
  for (const sep of ['ǀ', 'ǃ', 'ꞏ', 'º', ' ', '-', '.', 'ـ', 'ʼ', 'ㅤ']) refusedEverywhere(sep);
  // Real words from the same scripts, including a doubled-letter word and a
  // click-letter language name, with no digit on both sides of the letters,
  // reach the fact decision and are rendered exactly. A fix must keep
  // answering them, so it cannot refuse these code points outright.
  for (const value of ['〆切 Services', 'ǀXam Services', 'Synthetic Services 1234', 'Synthetic Servicesᵀᴹ', '2ⁿᵈ Street Services']) {
    const result = card('company', value);
    assert.ok(result?.fact_span, `company ${value} reaches the fact decision`);
    assert.ok(result.answer.includes(value));
  }
  assert.ok(subjectCard('Record Owner')?.answer.includes("Record Owner's company as Synthetic Services"));
  assert.equal(address(plainAddress)?.method, 'dated_owner_address');
  // Triage decided (R4-LEAK-1 control): grid addresses with a lone direction
  // letter between numbers keep answering.
  for (const value of ['1234 N 56th St, Fixture City, AZ 85001', '20000 N 59th Ave, Fixture City, AZ 85001']) {
    for (const operative of [false, true]) {
      const result = card('address', value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `address ${value}${operative ? ' (operative)' : ''} reaches the fact decision`);
      assert.ok(result.answer.includes(value));
    }
    assert.equal(address(value)?.method, 'dated_owner_address', `dated owner address ${value}`);
  }
});
