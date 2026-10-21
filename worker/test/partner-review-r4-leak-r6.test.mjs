// Partner review round 6, lens: leaks and allowlist. Synthetic fixtures only;
// every name is a role word and every number below is made up.
//
// Expected on fa93db5: each "repro" test fails and each "control" passes.
//   R6-LEAK-1  a run of two or more punctuation-shaped letters that is NOT
//              directly between two digit groups (set off by a space or an
//              ASCII separator, or touching one group only) still splits the
//              digit run after the round-5 fix, so "4111 ǀǀ 1111 ǀǀ 1111 ǀǀ 1111"
//              is echoed from every fast-path surface while the lone form
//              "4111 ǀ 1111 ǀ 1111 ǀ 1111" is refused
//   R6-LEAK-2  one cited letter whose compatibility decomposition is several
//              letters (a ligature, a digraph or an Arabic presentation form)
//              is judged on its NFKC pieces, so the lone-letter rule never
//              applies to it: "4111ﷺ1111ﷺ1111ﷺ1111" is echoed touching, and
//              "4111 Ĳ 1111 Ĳ 1111 Ĳ 1111" spaced, from every surface
import test from 'node:test';
import assert from 'node:assert/strict';
import { address, card, plainAddress } from './partner-r2-helpers.mjs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

globalThis.fetch = () => { throw new Error('network forbidden'); };

const now = Date.parse('2034-10-20');
const label = text => [...text].map(char => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
const separated = sep => `4111${sep}1111${sep}1111${sep}1111`;
const plainLetter = char => /^\p{L}$/u.test(char) && !/\p{Lm}|\p{Default_Ignorable_Code_Point}/u.test(char);

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

// ----------------------------------------------------------- R6-LEAK-1 --
// entity-fact-answer.js:53-76 (codePointRunText) decides, per run of letters,
// whether the run splits two digit groups. After the round-5 fix a run of
// two or more letters joins the groups only when it has no ASCII letter AND
// is `touching`, i.e. the token directly before the run and the token
// directly after it are both digits (:71-72). A separator token (a space or
// ASCII punctuation, :60) between the digits and the run breaks `touching`,
// so the run is emitted as a splitting word (:72). A LONE non-ASCII letter
// joins regardless of touching (:72, `lone && !token.ascii`), which is why
// "4111 ǀ 1111" is refused. Doubling the same punctuation-shaped letter and
// setting it off by a space ("4111 ǀǀ 1111"), by ASCII punctuation
// ("4111-ǀǀ-1111", "4111.ǀǀ.1111"), or touching one group only
// ("4111ǀǀ 1111", "4111 ǀǀ1111", "4111ǀǀ-1111") therefore passes the second
// check at :103; the first check at :103 keeps every letter. The value then
// passes the company, role, address and subject shape regexes (:27, :137,
// :138, every one admits \p{L}) and safeSubject (:26-28), so the 16-digit
// value is echoed verbatim from a company, a role, an address, a dated owner
// address and the rendered subject label, with the verifier hard-coded to
// supported=true for a fact answer (index.js:1396).
// Not R5-LEAK-1: that repro and the round-5 fix cover a doubled letter run
// DIRECTLY between two digits ("4111ǀǀ1111"), which is now refused; here the
// run is separated from at least one digit group by a space or ASCII
// punctuation, the placement the fix's own rule text leaves open ("a run
// with no ASCII letter directly between two digits"). Not R4-LEAK-1: that
// covers one letter, which joins in every placement.
const SET_OFF_DOUBLED_LETTERS = [' ǀǀ ', 'ǀǀ ', ' ǀǀ', '-ǀǀ-', '.ǀǀ.', 'ǀǀ-', ' ǀǀǀ ', ' ǀꞏ ', ' ǀ́ǀ ',
  ' ǁǁ ', ' ǃǃ ', ' ꞏꞏ ', ' ºº ', ' ªª ', ' 〆〆 '];

test('R6-LEAK-1 repro: two punctuation-shaped letters set off by a space or ASCII punctuation carry a 16-digit value through every fast-path surface', t => {
  for (const sep of SET_OFF_DOUBLED_LETTERS) {
    const letters = [...sep].filter(char => !/^[ .-]$/.test(char));
    assert.ok(letters.length >= 2, `${label(sep)} holds at least two letters`);
    for (const char of letters) assert.ok(plainLetter(char) || /^\p{M}$/u.test(char), `${label(char)} is a non-modifier, non-ignorable letter or a mark`);
    assert.ok(/^[ .-]|[ .-]$/.test(sep), `${label(sep)} is set off from at least one digit group`);
  }
  const leaked = echoes(SET_OFF_DOUBLED_LETTERS);
  t.diagnostic(JSON.stringify({ separators: SET_OFF_DOUBLED_LETTERS.length, surfaces: surfaces('').length, echoes: leaked.length }));
  assert.equal(leaked.length, 0, summarize(leaked));
});

test('R6-LEAK-1 control: the same letters alone or directly between the groups stay refused everywhere, ASCII separators stay refused, and ordinary words answer', () => {
  // The round-4 rule holds for one punctuation-shaped letter in every
  // placement, and the round-5 fix holds for a doubled run directly between
  // two digit groups; ASCII, modifier-letter and filler separators stay
  // closed on every surface.
  for (const sep of [' ǀ ', '-ǀ-', '.ǀ.', 'ǀ ', ' ǀ', ' º ', ' é ', 'ǀǀ', 'ǀꞏ', 'ǀ́ǀ', 'ǀ', ' ', '-', '.', 'ʼ', 'ㅤ']) refusedEverywhere(sep);
  // Real words from the same scripts, including a non-ASCII word set off by
  // spaces beside ONE digit group and a click-letter language name, reach
  // the fact decision and are rendered exactly. A fix must keep answering
  // them, so it cannot refuse these code points or every spaced non-ASCII
  // word outright.
  for (const value of ['〆切 Services', 'ǀXam Services', 'Synthetic Services 日本 1234', 'Société Synthétique Services',
    'Synthetic Services 1234', 'Synthetic Servicesᵀᴹ'])
    answersExactly('company', value);
  assert.ok(subjectCard('Record Owner')?.answer.includes("Record Owner's company as Synthetic Services"));
  assert.equal(address(plainAddress)?.method, 'dated_owner_address');
  // Triage decided (R4-LEAK-1 control): grid addresses with a lone ASCII
  // direction letter between numbers keep answering.
  for (const value of ['1234 N 56th St, Fixture City, AZ 85001', '20000 N 59th Ave, Fixture City, AZ 85001']) {
    for (const operative of [false, true]) answersExactly('address', value, operative);
    assert.equal(address(value)?.method, 'dated_owner_address', `dated owner address ${value}`);
  }
});

// ----------------------------------------------------------- R6-LEAK-2 --
// entity-fact-answer.js:55-62 tokenizes the cited value per raw code point
// but pushes one token per NFKC PIECE of that code point (:57-60), while
// `ascii` is read from the raw code point (:59). `lone` and `touching` are
// then computed over the piece tokens (:70-71). A single cited letter whose
// compatibility decomposition is two or more letters therefore never counts
// as a lone letter: U+0132 Ĳ ("IJ"), U+01C4 Ǆ ("DŽ"), U+01C8 ǈ ("Lj"), U+FB01 ﬁ,
// U+FB03 ﬃ, U+FB13 ﬓ, U+FEFB ﻻ and U+FDF2 ﷲ become a two-to-four letter run
// with no ASCII letter, which joins only when touching (:72), so set off by a
// space ("4111 Ĳ 1111") the run splits the digit groups although the lone
// non-ASCII rule refuses "4111 ǀ 1111" and "4111 é 1111" in the same place.
// U+FDFA ﷺ and U+FDFB ﷻ decompose to several WORDS with spaces, so their
// piece runs are never touching at all and the value leaks even with the
// glyph directly between the digits ("4111ﷺ1111ﷺ1111ﷺ1111"). The first
// check at :103 keeps every letter. Every such value passes the shape
// regexes (:27, :137, :138) and safeSubject (:26-28), and is echoed from a
// company, a role, an address, a dated owner address and the rendered
// subject label, with the verifier hard-coded to supported=true for a fact
// answer (index.js:1396). The enumeration below covers every letter in the
// runtime's Unicode table whose NFKC form is two or more code points.
// Not R4-LEAK-2: these are not modifier letters; they are Lu/Ll/Lt/Lo code
// points, and the gap is that lone-ness is judged after decomposition.
// Not R6-LEAK-1: the cited value holds ONE letter between the groups.
const MULTI_WORD_LETTERS = ['ﷺ', 'ﷻ'];
const LIGATURE_LETTERS = ['Ĳ', 'Ǆ', 'ǅ', 'ǈ', 'ﬁ', 'ﬃ', 'ﬓ', 'ﻻ', 'ﷲ'];

function expandingLetters() {
  const found = [];
  for (let codepoint = 0x80; codepoint <= 0x10ffff; codepoint++) {
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
    const glyph = String.fromCodePoint(codepoint);
    if (!plainLetter(glyph)) continue;
    if ([...glyph.normalize('NFKC')].length >= 2) found.push(glyph);
  }
  return found;
}

test('R6-LEAK-2 repro: one letter whose compatibility decomposition is several letters escapes the lone-letter rule and carries a 16-digit value through every fast-path surface', t => {
  for (const char of [...MULTI_WORD_LETTERS, ...LIGATURE_LETTERS]) {
    assert.equal([...char].length, 1, `${label(char)} is one code point`);
    assert.ok(plainLetter(char), `${label(char)} is a non-modifier, non-ignorable letter`);
    assert.ok((char.normalize('NFKC').match(/\p{L}/gu) || []).length >= 2, `${label(char)} decomposes to two or more letters`);
  }
  for (const char of MULTI_WORD_LETTERS) assert.ok(/ /.test(char.normalize('NFKC')), `${label(char)} decomposes to several words`);
  // Directly between the groups for the multi-word letters, set off by
  // spaces for the ligatures; then the company card surface for every
  // expanding letter in the runtime's table, set off by spaces.
  const leaked = echoes([...MULTI_WORD_LETTERS, ...LIGATURE_LETTERS.map(char => ` ${char} `)]);
  const letters = expandingLetters();
  assert.ok(letters.length > 100, 'nonempty enumeration of letters with a multi-code-point NFKC form');
  const survivors = letters.filter(char => card('company', `Synthetic Services ${separated(` ${char} `)}`) !== null);
  t.diagnostic(JSON.stringify({ runtime: process.version, unicode: process.versions.unicode, representatives: MULTI_WORD_LETTERS.length + LIGATURE_LETTERS.length,
    surfaces: surfaces('').length, representativeEchoes: leaked.length, expanding: letters.length, survivors: survivors.length }));
  assert.equal(leaked.length, 0, summarize(leaked));
  assert.equal(survivors.length, 0, `${survivors.length} of ${letters.length} expanding letters carry a 16-digit value through the company fast path when set off by spaces: ${survivors.slice(0, 8).map(label).join(' ')}`);
});

test('R6-LEAK-2 control: a lone letter with a one-piece or separator-bearing decomposition stays refused in both placements, and the same ligatures in ordinary text answer', () => {
  // The round-4 lone-letter rule holds for a letter NFKC leaves as one
  // piece, touching or spaced.
  for (const char of ['ǀ', 'é', 'º']) {
    assert.equal([...char.normalize('NFKC')].length, 1, `${label(char)} stays one code point`);
    refusedEverywhere(char);
    refusedEverywhere(` ${char} `);
  }
  // A decomposition whose letter pieces are each lone (a middle dot, a
  // modifier apostrophe or a nukta between or after them) is refused too:
  // the gap is specific to a decomposition that yields an unbroken run.
  for (const char of ['Ŀ', 'ŉ', 'क़']) {
    assert.ok([...char.normalize('NFKC')].length >= 2, `${label(char)} decomposes`);
    refusedEverywhere(char);
    refusedEverywhere(` ${char} `);
  }
  // Ligatures and presentation forms inside ordinary words, or beside one
  // digit group, are text the fast path keeps answering exactly.
  for (const value of ['Ĳsselmeer Services', 'Ǆungla Services', 'ﬁnance Services 1234', 'Synthetic Servicesﷺ', 'ﷲ Services'])
    answersExactly('company', value);
  assert.ok(subjectCard('Record Ownerﷺ')?.answer.includes("Record Ownerﷺ's company as Synthetic Services"));
});
