// Partner review round 3, round 3, lens: leaks and allowlist. Synthetic
// fixtures only; every name is a role word and every number below is made up.
//
// Expected on e6f1ca2: the "repro" test fails and the "control" test passes.
//   R3-LEAK-3-1  fast-path digit-run guard keeps letter-category separators,
//                so invisible or punctuation-shaped letters between digit
//                groups carry a 16-digit value verbatim into the answer
import test from 'node:test';
import assert from 'node:assert/strict';
import { address, card, plainAddress } from './partner-r2-helpers.mjs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

globalThis.fetch = () => { throw new Error('network forbidden'); };

// ----------------------------------------------------------- R3-LEAK-3-1 --
// entity-fact-answer.js:50-52 (unsafeScalarFact). The digit-run check strips
// everything that is not a letter or an ASCII digit before looking for six
// contiguous digits, so ASCII separators (space, dash, apostrophe, slash,
// period) correctly JOIN the groups of a separated identifier and refuse it.
// A separator that Unicode classifies as a letter is kept and therefore
// SPLITS the run. Four such letters render as blank: the Hangul fillers
// U+115F, U+1160, U+3164 and U+FFA0 (category Lo, every one of them a
// Default_Ignorable_Code_Point, which the ledger parser on this same branch
// refuses outright in ledger-attribution.js bounded()). Two more render as
// punctuation: U+0640 ARABIC TATWEEL (a horizontal line) and U+02BC MODIFIER
// LETTER APOSTROPHE (an apostrophe). "4111<filler>1111<filler>1111<filler>1111"
// therefore passes unsafeScalarFact, the company/role/address shape regexes
// (all admit \p{L}) and safeSubject, and the fast path echoes a visually
// contiguous 16-digit value from a company, a role, an address, a dated owner
// address email, and the rendered subject label, with the verifier hard-coded
// to supported=true for a fact answer (index.js:1395-1396).
// Not R3-LEAK-1-1 (phone digit bound), R3-LEAK-1-2 (five-digit threshold) or
// R3-LEAK-2-1 (email validator order): those fields and guards are unchanged
// here; this is the separator class the K1 generator does not enumerate
// (it covers \p{N} codepoints and ASCII punctuation/symbols only).
const INVISIBLE_LETTERS = ['ㅤ', 'ᅠ', 'ᅟ', 'ﾠ'];
const PUNCTUATION_SHAPED_LETTERS = ['ـ', 'ʼ'];
const separated = sep => `4111${sep}1111${sep}1111${sep}1111`;
const visibleDigits = text => String(text).normalize('NFKC')
  .replace(/\p{Default_Ignorable_Code_Point}|\p{Lm}/gu, '').match(/[0-9]+/g) || [];
const now = Date.parse('2034-10-20');

function subjectCard(subject, field = 'company', value = 'Synthetic Services') {
  return entityFactAnswer({ question: `What is ${subject}'s ${field}?`, owner: subject, now,
    results: [{ client: subject, title: 'Contact record', snippet: `Name: ${subject}\n${field}: ${value}` }],
    docs: [{ n: 1, ref: 'fixture-card', client: subject, title: 'Contact record', source_kind: 'curated',
      date_source: 'record:updated', date_reliable: true, ts: '2034-10-16', text_source: 'native', text_reliable: true,
      lineage: { status: 'known', kind: 'source_record' }, authority: {} }] });
}

test('R3-LEAK-3-1 repro: invisible and punctuation-shaped letters between digit groups carry a 16-digit value through every fast-path surface', () => {
  for (const sep of [...INVISIBLE_LETTERS, ...PUNCTUATION_SHAPED_LETTERS]) {
    const value = separated(sep);
    const label = `U+${sep.codePointAt(0).toString(16).padStart(4, '0')}`;
    for (const operative of [false, true]) {
      for (const field of ['company', 'role']) {
        const result = card(field, `Synthetic Services ${value}`, entityFactAnswer, operative);
        assert.equal(result, null, `${field} (${operative ? 'operative' : 'card'}) echoed a ${label}-separated identifier: ${JSON.stringify(result?.answer)}`);
      }
      // Away from the ZIP so the five-digit ZIP cannot join the run and mask the defect.
      const result = card('address', `12 Synthetic Road ${value}, Fixture City, AZ 85001`, entityFactAnswer, operative);
      assert.equal(result, null, `address (${operative ? 'operative' : 'card'}) echoed a ${label}-separated identifier: ${JSON.stringify(result?.answer)}`);
    }
    const dated = address(`12 Synthetic Road ${value}, Fixture City, AZ 85001`);
    assert.equal(dated, null, `dated owner address echoed a ${label}-separated identifier: ${JSON.stringify(dated?.answer)}`);
    const subject = subjectCard(`Record Owner ${value}`);
    assert.equal(subject, null, `subject label echoed a ${label}-separated identifier: ${JSON.stringify(subject?.answer)}`);
  }
});

test('R3-LEAK-3-1 control: ASCII-separated identifiers are refused everywhere and plain values, including real Hangul, are answered exactly', () => {
  // The same groups with any ASCII separator the allowlist admits join into
  // one run and leave the fast path on every surface.
  for (const sep of [' ', '-', "'", '/', '.']) {
    const value = separated(sep);
    for (const operative of [false, true]) {
      for (const field of ['company', 'role'])
        assert.equal(card(field, `Synthetic Services ${value}`, entityFactAnswer, operative), null, `${field} ${JSON.stringify(sep)}`);
      assert.equal(card('address', `12 Synthetic Road ${value}, Fixture City, AZ 85001`, entityFactAnswer, operative), null, `address ${JSON.stringify(sep)}`);
    }
    assert.equal(address(`12 Synthetic Road ${value}, Fixture City, AZ 85001`), null, `dated address ${JSON.stringify(sep)}`);
    assert.equal(subjectCard(`Record Owner ${value}`), null, `subject ${JSON.stringify(sep)}`);
  }
  // Ordinary values reach the fact decision and carry no run longer than four
  // digits once invisible and modifier letters are discounted. Real Hangul
  // syllables are letters a fix must keep answering; only fillers are blank.
  // (The operative path declines non-ASCII-word values for an unrelated
  // reason in evidence-authority.js, outside this range, so Hangul is pinned
  // on the card path only.)
  for (const operative of [false, true]) {
    for (const [field, value] of [['company', 'Synthetic Services'], ['role', 'Operations Lead'],
      ['address', plainAddress], ...(operative ? [] : [['company', '신세토틱 서비스']])]) {
      const result = card(field, value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `${field} ${value} reaches the fact decision`);
      assert.ok(result.answer.includes(value));
      assert.ok(visibleDigits(result.answer).every(run => run.length <= 5), result.answer);
    }
  }
  const dated = address(plainAddress);
  assert.equal(dated?.method, 'dated_owner_address');
  assert.ok(visibleDigits(dated.answer).every(run => run.length <= 5), dated.answer);
  const subject = subjectCard('Record Owner');
  assert.ok(subject?.fact_span);
  assert.ok(subject.answer.includes("Record Owner's company as Synthetic Services"));
});
