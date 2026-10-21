// Partner review round 7, lens: leaks and allowlist. Synthetic fixtures only;
// every name is a role word and every number below is made up.
//
// Expected on 979477c: each "repro" test fails and each "control" passes.
//   R7-LEAK-1  a decomposed accented letter (an ASCII base letter followed by
//              a combining mark) between digit groups splits the digit run
//              when it is set off by a space or ASCII punctuation, or touches
//              one digit group only, while its canonically equivalent
//              precomposed letter is refused in the same placements
import test from 'node:test';
import assert from 'node:assert/strict';
import { address, card, plainAddress } from './partner-r2-helpers.mjs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

globalThis.fetch = () => { throw new Error('network forbidden'); };

const now = Date.parse('2034-10-20');
const label = text => [...text].map(char => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
const separated = sep => `4111${sep}1111${sep}1111${sep}1111`;
const asciiLetter = char => /^[A-Za-z]$/.test(char);
const precomposedLetter = char => [...char].length === 1 && /^\p{L}$/u.test(char) && !asciiLetter(char) &&
  !/\p{Lm}|\p{Default_Ignorable_Code_Point}/u.test(char);

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

function answersExactly(field, value, operative = false) {
  const result = card(field, value, entityFactAnswer, operative);
  assert.ok(result?.fact_span, `${field} ${value}${operative ? ' (operative)' : ''} reaches the fact decision`);
  assert.ok(result.answer.includes(value), `${field} ${value} is rendered exactly`);
}

// Every ASCII letter followed by one combining mark whose canonical (NFC)
// composition is a single precomposed letter: the same letter in two
// encodings. Enumerated over the runtime's Unicode table.
function composingPairs() {
  const marks = [];
  for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
    const glyph = String.fromCodePoint(codepoint);
    if (/^\p{M}$/u.test(glyph)) marks.push(glyph);
  }
  const pairs = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
    for (const mark of marks) {
      const pair = letter + mark;
      if (precomposedLetter(pair.normalize('NFC'))) pairs.push(pair);
    }
  return pairs;
}

// ----------------------------------------------------------- R7-LEAK-1 --
// entity-fact-answer.js:57-80 (codePointRunText) reads `ascii` from the raw
// cited code point (:63) and drops every combining mark (:60), so "e" + U+0301
// COMBINING ACUTE ACCENT is one lone ASCII letter: set off by a space or ASCII
// punctuation, or touching one digit group only, it is not `touching` (:75)
// and splits the run (:76). The first check at :109 runs on the NFKC form,
// where the pair has composed to "é", a letter it keeps, so "4111é1111" has no
// five-digit run either. The precomposed letter U+00E9 in the same placement
// is a lone NON-ASCII letter, which joins the groups and is refused on every
// surface (partner-review-r4-leak-r6.test.mjs pins " é " refused). The two
// spellings are canonically equivalent (NFC), render identically, and give
// opposite verdicts. "4111 é 1111 é 1111 é 1111" therefore
// passes unsafeScalarFact, the company, role, address and subject shape
// regexes (:27, :149, :150 all admit \p{M}) and safeSubject, and the 16-digit
// value is echoed verbatim from a company, a role, an address, a dated owner
// address and the rendered subject label, with the verifier hard-coded to
// supported=true for a fact answer (index.js:1400).
// Not R6-LEAK-2: that is one cited letter whose NFKC form is several letters
// (judged after decomposition); this is two cited code points whose NFC form
// is one letter (judged before composition). Not R4-LEAK-1 / R5-LEAK-1 /
// R6-LEAK-1: those separators are non-ASCII letters, all of which now join.
// A bare ASCII letter set off by spaces ("1234 N 56th St") splits by the
// triage decision and is not the claim here: the claim is the decomposed
// encoding of a letter the branch refuses when precomposed.
// Fixed in the round-7 fix pass: codePointRunText judges a cited letter that
// carries a combining mark as the accented letter it renders, so the
// decomposed and the precomposed spellings get the same verdict.
const DECOMPOSED_PLACEMENTS = [' é ', 'é ', ' é', '-é-', '.é.',
  ' à ', ' ö ', ' ñ ', ' ç ', ' ů ', ' ž ', ' ý ', ' É '];
const decomposedLetter = sep => [...sep].filter(char => !/^[ .-]$/.test(char)).join('');
const precomposedOf = sep => sep.replace(decomposedLetter(sep), decomposedLetter(sep).normalize('NFC'));

test('R7-LEAK-1 repro: a decomposed accented letter between digit groups carries a 16-digit value through every fast-path surface while its precomposed form is refused', t => {
  for (const sep of DECOMPOSED_PLACEMENTS) {
    const pair = decomposedLetter(sep);
    assert.equal([...pair].length, 2, `${label(sep)} holds one ASCII letter and one mark`);
    assert.ok(asciiLetter(pair[0]) && /^\p{M}$/u.test(pair[1]), `${label(sep)} is an ASCII letter followed by a combining mark`);
    assert.ok(precomposedLetter(pair.normalize('NFC')), `${label(sep)} composes to one precomposed non-ASCII letter`);
    assert.equal(pair.normalize('NFC'), precomposedOf(sep).replace(/[ .-]/g, ''), 'the precomposed twin is the NFC form');
  }
  const leaked = echoes(DECOMPOSED_PLACEMENTS);
  t.diagnostic(JSON.stringify({ separators: DECOMPOSED_PLACEMENTS.length, surfaces: surfaces('').length, echoes: leaked.length }));
  assert.equal(leaked.length, 0, summarize(leaked));
});

test('R7-LEAK-1 repro, enumeration: every ASCII letter plus combining mark pair that composes to one precomposed letter splits the run on the company card surface', t => {
  const pairs = composingPairs();
  assert.ok(pairs.length > 100, 'nonempty enumeration of composing letter and mark pairs');
  const spaced = pairs.filter(pair => card('company', `Synthetic Services ${separated(` ${pair} `)}`) !== null);
  const touchingOne = pairs.filter(pair => card('company', `Synthetic Services ${separated(`${pair} `)}`) !== null);
  t.diagnostic(JSON.stringify({ runtime: process.version, unicode: process.versions.unicode, pairs: pairs.length,
    precomposed: new Set(pairs.map(pair => pair.normalize('NFC'))).size, spacedEchoes: spaced.length, touchingOneEchoes: touchingOne.length }));
  assert.equal(spaced.length, 0, `${spaced.length} of ${pairs.length} decomposed letters carry a 16-digit value through the company fast path when set off by spaces: ${spaced.slice(0, 8).map(label).join(', ')}`);
  assert.equal(touchingOne.length, 0, `${touchingOne.length} of ${pairs.length} decomposed letters carry a 16-digit value through the company fast path when touching one digit group: ${touchingOne.slice(0, 8).map(label).join(', ')}`);
});

test('R7-LEAK-1 control: the precomposed letters stay refused in every placement, decomposed letters inside ordinary words answer, and the earlier separator decisions hold', () => {
  // The same letter precomposed is a lone non-ASCII letter, which joins the
  // digit groups wherever it stands (round 4 rule, R6-LEAK-1 control).
  for (const sep of DECOMPOSED_PLACEMENTS) refusedEverywhere(precomposedOf(sep));
  for (const sep of ['é', ' é ', 'é ', ' é', '-é-', '.é.', ' ñ ', ' ç ', ' ž ']) refusedEverywhere(sep);
  // Directly between two digit groups the decomposed pair is one ASCII
  // letter touching both sides, which joins them already.
  for (const sep of ['é', 'à', 'ñ']) refusedEverywhere(sep);
  // Every precomposed twin of the enumerated pairs is refused on the company
  // surface in both leaking placements.
  const precomposed = [...new Set(composingPairs().map(pair => pair.normalize('NFC')))];
  assert.ok(precomposed.length > 100, 'nonempty enumeration of precomposed letters');
  for (const char of precomposed) {
    assert.equal(card('company', `Synthetic Services ${separated(` ${char} `)}`), null, `${label(char)} spaced is refused`);
    assert.equal(card('company', `Synthetic Services ${separated(`${char} `)}`), null, `${label(char)} touching one group is refused`);
  }
  // A mark on a digit or on a separator is refused (K1 allowlist).
  for (const sep of ['́ ', ' ́ ', ' ́']) refusedEverywhere(sep);
  // Decomposed accented letters inside ordinary words, beside one digit
  // group, in a dated owner address and inside the subject label are text the
  // fast path keeps answering exactly (K1 pins "Café Services" and
  // "q́ Services"). A fix cannot refuse every letter that carries a mark.
  for (const operative of [false, true])
    for (const value of ['Café Services', 'Société Synthétique Services', 'q́ Services',
      'Synthetic Services 1234 Café', 'Café 1234 Services', 'Synthetic Services 1234'])
      answersExactly('company', value, operative);
  assert.equal(address('12 Café Road, Fixture City, AZ 85001')?.method, 'dated_owner_address');
  assert.equal(address(plainAddress)?.method, 'dated_owner_address');
  assert.ok(subjectCard('Record Owneŕ')?.answer.includes("Record Owneŕ's company as Synthetic Services"));
  assert.ok(subjectCard('Record Owner')?.answer.includes("Record Owner's company as Synthetic Services"));
  // Triage decided (R4-LEAK-1 control): grid addresses with a lone ASCII
  // direction letter between numbers keep answering.
  for (const value of ['1234 N 56th St, Fixture City, AZ 85001', '20000 N 59th Ave, Fixture City, AZ 85001']) {
    for (const operative of [false, true]) answersExactly('address', value, operative);
    assert.equal(address(value)?.method, 'dated_owner_address', `dated owner address ${value}`);
  }
  // The separators the earlier rounds closed stay closed on every surface.
  for (const sep of [' ', '-', '.', 'ǀ', ' ǀǀ ', ' Ĳ ', 'ʼ', 'ㅤ']) refusedEverywhere(sep);
});
