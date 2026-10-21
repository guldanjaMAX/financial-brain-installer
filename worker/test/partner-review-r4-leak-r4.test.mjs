// Partner review round 4, lens: leaks and allowlist. Synthetic fixtures only;
// every name is a role word and every number below is made up.
//
// Expected on da7a92a: each "repro" test fails and each "control" passes.
//   R4-LEAK-1  fast-path digit-run strip keeps punctuation-shaped letters
//              outside the modifier and default-ignorable classes
//   R4-LEAK-2  the modifier-letter strip runs after NFKC, so modifier letters
//              with a compatibility decomposition are never stripped
//   R4-LEAK-3  an underscore is not a boundary for the email identifier-word
//              check (contract question under partner answer 7; confirmed by
//              the partner in round 7: "_" is a boundary)
//   R4-LEAK-4  email digits are bounded per part, never in total (contract
//              question: answer 2 caps phone at 15, answer 7 says nothing;
//              round 7 ruling 2: total digits across all parts capped at 6)
import test from 'node:test';
import assert from 'node:assert/strict';
import { address, card, mutatedModule, plainAddress } from './partner-r2-helpers.mjs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

globalThis.fetch = () => { throw new Error('network forbidden'); };

const now = Date.parse('2034-10-20');
const label = sep => `U+${sep.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
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

// ----------------------------------------------------------- R4-LEAK-1 --
// entity-fact-answer.js:62 strips everything that is not a letter or an ASCII
// digit, plus modifier letters (\p{Lm}), before looking for a five-digit run
// (six for an address); :55 refuses default-ignorable code points. Round 3
// (R3-LEAK-3-1) closed the invisible and modifier-letter separators that way.
// A letter that is neither a modifier letter nor default-ignorable, but that
// renders as punctuation, is still kept and therefore SPLITS the run: the
// Latin click letters U+01C0 ǀ, U+01C1 ǁ, U+01C2 ǂ and U+01C3 ǃ (encoded as
// letters precisely because they look like | ‖ ‡ !), U+A78F ꞏ (a syllable
// separator dot), U+0B83 ஃ, U+3006 〆, U+0EAF ຯ (an ellipsis), U+0E2F ฯ,
// U+17DC ៜ, U+2D4F ⵏ and U+16C1 ᛁ (vertical bars), and the ordinal indicators
// U+00AA ª and U+00BA º. All of them pass unsafeScalarFact, the company, role,
// address and subject shape regexes (every one admits \p{L}) and safeSubject,
// so "4111ꞏ1111ꞏ1111ꞏ1111" is echoed verbatim from a company, a role, an
// address, a dated owner address and the rendered subject label, with the
// verifier hard-coded to supported=true for a fact answer (index.js:1396).
// Not R3-LEAK-3-1: that fix covers \p{Lm} and Default_Ignorable only; these
// are Lo/Ll/Lu code points with no decomposition, outside both classes, and
// outside the K1 generator (which enumerates \p{N} and ASCII separators).
const PUNCTUATION_SHAPED_LETTERS = ['ǀ', 'ǁ', 'ǂ', 'ǃ', 'ꞏ', 'ஃ', '〆', 'ຯ', 'ฯ', 'ៜ', 'ⵏ', 'ᛁ', 'ª', 'º'];

test('R4-LEAK-1 repro: punctuation-shaped letters outside the modifier and ignorable classes carry a 16-digit value through every fast-path surface', t => {
  for (const sep of PUNCTUATION_SHAPED_LETTERS)
    assert.ok(/^\p{L}$/u.test(sep) && !/\p{Lm}|\p{Default_Ignorable_Code_Point}/u.test(sep), `${label(sep)} is a non-modifier, non-ignorable letter`);
  const leaked = echoes(PUNCTUATION_SHAPED_LETTERS);
  t.diagnostic(JSON.stringify({ separators: PUNCTUATION_SHAPED_LETTERS.length, surfaces: surfaces('').length, echoes: leaked.length }));
  assert.equal(leaked.length, 0, summarize(leaked));
});

test('R4-LEAK-1 control: ordinary words of the same scripts answer, and ASCII, modifier-letter and filler separators are still refused everywhere', () => {
  // Real words from the scripts above, with no digit beside the letter, reach
  // the fact decision and are rendered exactly. A fix must keep answering them.
  for (const value of ['〆切 Services', 'தமிழ் Services', 'ພາສາລາວ Services', 'บริการ Services', 'Synthetic Services 1234']) {
    const result = card('company', value);
    assert.ok(result?.fact_span, `company ${value} reaches the fact decision`);
    assert.ok(result.answer.includes(value));
  }
  assert.ok(subjectCard('Record Owner')?.answer.includes("Record Owner's company as Synthetic Services"));
  assert.equal(address(plainAddress)?.method, 'dated_owner_address');
  // Triage decided: grid addresses with a lone direction letter between
  // numbers keep answering. With the letter removed they would read 123456
  // and 2000059, which the six-digit address rule refuses, so a fix cannot
  // treat every isolated single letter as a separator. (Synthetic city.)
  for (const value of ['1234 N 56th St, Fixture City, AZ 85001', '20000 N 59th Ave, Fixture City, AZ 85001']) {
    for (const operative of [false, true]) {
      const result = card('address', value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `address ${value}${operative ? ' (operative)' : ''} reaches the fact decision`);
      assert.ok(result.answer.includes(value));
    }
    assert.equal(address(value)?.method, 'dated_owner_address', `dated owner address ${value}`);
  }
  // The separators the earlier rounds already closed stay closed on every
  // surface: ASCII punctuation, modifier letters and a Hangul filler.
  for (const sep of [' ', '-', '.', '/', "'", 'ـ', 'ʼ', 'ー', 'ㅤ']) refusedEverywhere(sep);
});

// ----------------------------------------------------------- R4-LEAK-2 --
// entity-fact-answer.js:62 evaluates `\p{Lm}` on `normalized`, the NFKC form
// of the value (:50), not on the cited value. Every modifier letter with a
// compatibility decomposition to a base letter is therefore an ordinary
// letter by the time the strip runs and is kept, so it splits the digit run
// exactly like the fillers and modifier apostrophe did before round 3:
// U+02B0-U+02B8 and U+02E0-U+02E4 (ʰ ʲ ʳ ʷ ʸ ˠ ˡ ˢ ˣ), U+1D2C-U+1D6A and
// U+1D9B-U+1DBF (ᴬ ᴮ ᴰ ... ᵃ ᵇ ᵈ), U+2071 ⁱ, U+207F ⁿ, U+2090-U+209C (ₐ ₑ ₒ ₓ ₕ ₖ
// ₗ ₘ ₙ ₚ ₛ ₜ), U+10783-U+107BA and U+1E030-U+1E06D (modifier Cyrillic), among
// others: every such code point in the runtime's Unicode table is enumerated
// below. The round-3 rule in the comment above :62 ("modifier letters ...
// join adjacent digit groups exactly like ASCII punctuation does") is never
// applied to them, and "4111ʰ1111ʰ1111ʰ1111" is echoed from a company, a
// role, an address, a dated owner address and the rendered subject label.
// Not R4-LEAK-1: these ARE modifier letters, inside the class the round-3
// fix names; the gap is the order of the strip and the normalization.
function decomposingModifierLetters() {
  const found = [];
  for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
    const glyph = String.fromCodePoint(codepoint);
    if (!/^\p{Lm}$/u.test(glyph)) continue;
    const normalized = glyph.normalize('NFKC');
    if (normalized !== glyph && /\p{L}/u.test(normalized) && !/\p{Lm}/u.test(normalized)) found.push(glyph);
  }
  return found;
}

test('R4-LEAK-2 repro: modifier letters with a compatibility decomposition escape the strip because it runs after NFKC', t => {
  const letters = decomposingModifierLetters();
  assert.ok(letters.length > 100, 'nonempty enumeration of decomposing modifier letters');
  // Every surface for a representative of each block, then the company card
  // surface for the whole enumeration.
  const representatives = ['ʰ', 'ˡ', 'ᵃ', 'ⁱ', 'ⁿ', 'ₐ', '\u{1E030}'];
  for (const sep of representatives) assert.ok(letters.includes(sep), `${label(sep)} is in the enumeration`);
  const leaked = echoes(representatives);
  const survivors = letters.filter(sep => card('company', `Synthetic Services ${separated(sep)}`) !== null);
  t.diagnostic(JSON.stringify({ runtime: process.version, unicode: process.versions.unicode, decomposing: letters.length,
    survivors: survivors.length, representativeEchoes: leaked.length }));
  assert.equal(leaked.length, 0, summarize(leaked));
  assert.equal(survivors.length, 0, `${survivors.length} of ${letters.length} decomposing modifier letters carry a 16-digit value through the company fast path: ${survivors.slice(0, 8).map(label).join(' ')}`);
});

test('R4-LEAK-2 control: modifier letters without a decomposition are refused everywhere, and modifier letters in ordinary text answer', () => {
  // The round-3 fix holds for modifier letters NFKC leaves alone.
  for (const sep of ['ـ', 'ʼ', 'ー', '々', 'ː']) {
    assert.equal(String(sep).normalize('NFKC'), sep, `${label(sep)} has no decomposition`);
    refusedEverywhere(sep);
  }
  // Superscript and subscript modifier letters beside words, or beside one
  // digit group, are ordinary text the fast path keeps answering exactly.
  for (const value of ['Synthetic Servicesᵀᴹ', '2ⁿᵈ Street Services', 'Synthetic Services 1234']) {
    const result = card('company', value);
    assert.ok(result?.fact_span, `company ${value} reaches the fact decision`);
    assert.ok(result.answer.includes(value));
  }
  assert.ok(subjectCard('Record Ownerᵀᴹ')?.answer.includes("Record Ownerᵀᴹ's company as Synthetic Services"));
});

// ----------------------------------------------------------- R4-LEAK-3 --
// entity-fact-answer.js:83 bounds the email identifier-word check with
// (?<![a-z_]) and (?![a-z_]): every character except a letter or an
// underscore is a boundary, so digits, dots, dashes and plus signs all close
// an identifier word (partner answer 7), but an underscore does not. The
// local-part alphabet at :81 admits "_", so "acct_123456", "card_4111",
// "routing_021000", "iban_gb29nw" and "account_1" pass the word check, stay
// under the per-part seven-digit bound at :82, and are echoed verbatim by the
// card and operative fast paths with the verifier hard-coded to
// supported=true (index.js:1396). The same words beside a dash, a dot, a
// plus or a digit are refused.
// Not R3-LEAK-2-1: that round pinned digit and dot boundaries only.
// Raised as a contract question; triage decided it as a bug: answer 7 adopted
// the proposal that a local part prefixed with an identifier word is not an
// email fact, and is silent on underscore, so in doubt the fast path declines.
// Only letters continue a word for the identifier-word check.
const UNDERSCORE_IDENTIFIER_EMAILS = ['acct_123456@example.invalid', 'card_4111@bank.invalid',
  'routing_021000@bank.invalid', 'iban_gb29nw@bank.invalid', 'account_1@bank.invalid'];

test('R4-LEAK-3 repro: an underscore is not a boundary for the email identifier-word check, so acct_ and card_ local parts are echoed', t => {
  const leaked = [];
  for (const value of UNDERSCORE_IDENTIFIER_EMAILS)
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      if (result !== null) leaked.push({ surface: operative ? 'email (operative)' : 'email', value, answer: result.answer });
    }
  t.diagnostic(JSON.stringify({ values: UNDERSCORE_IDENTIFIER_EMAILS.length, echoes: leaked.length }));
  assert.equal(leaked.length, 0, `${leaked.length} echoes, e.g. ${JSON.stringify(leaked[0])}`);
});

test('R4-LEAK-3 control: the same identifier words beside a dash, dot, plus or digit are refused, and underscore names without an identifier word answer', () => {
  for (const value of ['acct-123456@example.invalid', 'acct.123456@example.invalid', 'acct+123456@example.invalid',
    'acct123456@example.invalid', 'card-4111@bank.invalid', 'routing.021000@bank.invalid'])
    for (const operative of [false, true])
      assert.equal(card('email', value, entityFactAnswer, operative), null, `email ${value} refused`);
  // An underscore between ordinary words, and an identifier word inside a
  // longer word, are ordinary email facts a fix must keep answering.
  for (const value of ['first_last@example.invalid', 'cardinal_office@example.invalid', 'contact_123@example.invalid',
    'cardinal.office@example.invalid', 'contact123456@example.invalid', 'owner@mail123456.example.invalid'])
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `email ${value} reaches the fact decision`);
      assert.ok(result.answer.includes(value));
    }
});

// Round 7, the partner's ruling: "treat "_" as a boundary in the
// identifier-word check" (email fast path; the partner's own example is
// acct_1234@bank.invalid). An underscore closes an identifier word on either
// side, in any case and next to any other separator; only a letter continues
// a word, so an identifier word inside a longer word still answers.
const UNDERSCORE_RULING_REFUSED = ['acct_1234@bank.invalid', 'ACCT_1234@bank.invalid', 'owner_acct@bank.invalid',
  'my_card_office@example.invalid', '_routing@bank.invalid', 'iban_@bank.invalid', 'swift_code@bank.invalid',
  'aba_number@bank.invalid', 'account__1@bank.invalid', 'first.card_x@example.invalid'];
const UNDERSCORE_RULING_ANSWERED = ['first_last@example.invalid', 'cardinal_office@example.invalid',
  'abacus_team@example.invalid', 'discard_box@example.invalid', 'accounts_x@example.invalid'];

test('R4-LEAK-3 round 7 ruling: an underscore is a boundary for the email identifier-word check, so acct_1234@bank.invalid is refused', () => {
  for (const value of UNDERSCORE_RULING_REFUSED)
    for (const operative of [false, true])
      assert.equal(card('email', value, entityFactAnswer, operative), null,
        `email ${value} (${operative ? 'operative' : 'card'}) is refused`);
  for (const value of UNDERSCORE_RULING_ANSWERED)
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `email ${value} (${operative ? 'operative' : 'card'}) reaches the fact decision`);
      assert.ok(result.answer.includes(value));
    }
});

test('R4-LEAK-3 round 7 ruling, mutation: if "_" continued a word, the ruling pin would catch it', async () => {
  const guard = '(?<![a-z])(?:account|acct|routing|card|iban|swift|aba)(?![a-z])';
  const mutant = await mutatedModule('entity-fact-answer.js', guard,
    '(?<![a-z_])(?:account|acct|routing|card|iban|swift|aba)(?![a-z_])');
  // The partner's example is echoed by the mutant, so the pin above is live.
  assert.ok(card('email', 'acct_1234@bank.invalid', mutant.entityFactAnswer)?.answer.includes('acct_1234@bank.invalid'));
  // A dash still closes the word in the mutant: only the underscore changed.
  assert.equal(card('email', 'acct-1234@bank.invalid', mutant.entityFactAnswer), null);
});

// ----------------------------------------------------------- R4-LEAK-4 --
// entity-fact-answer.js:82 counts digits per part (the local part and each
// domain label) and refuses a part with seven or more. There is no bound on
// the digits across parts, so a value whose "@" and "." fall every four or
// six digits carries a 16-digit, an 18-digit and a 24-digit sequence through
// the card and operative email fast paths: "4111@1111.1111.1111.invalid",
// "123456@123456.123456.invalid" and "411111@111111.111111.111111.invalid",
// each echoed verbatim with the verifier hard-coded to supported=true. The
// phone validator at :88-89 caps the TOTAL at 15 digits across every group
// (partner answer 2); the email validator caps each part at 6 and the total
// at nothing. A single seven-digit part is still refused.
// Not R3-LEAK-2-1 (one identifier-length part) and not R4-LEAK-3 (the word
// check): every part here is within the per-part bound and carries no word.
// Contract question: answer 7 decided the per-part bound and answer 2 a
// 15-digit total for phone; neither decides a total digit bound for email.
// Round 7 ruling 2 (the partner): "cap total digits across all email parts at
// 6. Above that, leave the fast path." The repro is now a normal test that
// pins the ruling; the boundary test below pins 6 answered and 7 refused.
const SPLIT_DIGIT_EMAILS = ['4111@1111.1111.1111.invalid', '123456@123456.123456.invalid', '411111@111111.111111.111111.invalid'];
const totalDigits = value => value.replace(/[^0-9]/g, '').length;

test('R4-LEAK-4 repro: digits are bounded per email part, never in total, so a 16-digit value split at the @ and dots is echoed', t => {
  for (const value of SPLIT_DIGIT_EMAILS) assert.ok(totalDigits(value) >= 16, `${value} carries 16 or more digits`);
  const leaked = [];
  for (const value of SPLIT_DIGIT_EMAILS)
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      if (result !== null) leaked.push({ surface: operative ? 'email (operative)' : 'email', value, digits: totalDigits(value), answer: result.answer });
    }
  t.diagnostic(JSON.stringify({ values: SPLIT_DIGIT_EMAILS.length, echoes: leaked.length }));
  assert.equal(leaked.length, 0, `${leaked.length} echoes, e.g. ${JSON.stringify(leaked[0])}`);
});

test('R4-LEAK-4 control: a seven-digit part is refused, six-digit parts answer, and the phone total bound holds at 15', () => {
  for (const value of ['1234567@example.invalid', 'owner@1234567.invalid', 'owner@mail.1234567.invalid'])
    for (const operative of [false, true])
      assert.equal(card('email', value, entityFactAnswer, operative), null, `email ${value} refused`);
  for (const value of ['contact123456@example.invalid', 'owner@mail123456.example.invalid', 'contact@example.invalid'])
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `email ${value} reaches the fact decision`);
      assert.ok(result.answer.includes(value));
    }
  // The phone validator is the total-bound precedent (answer 2): 15 digits
  // answer and 16 are refused, however the groups are separated.
  for (const field of ['phone', 'mobile']) {
    assert.ok(card(field, '+1 (480) 555 0100 1234')?.fact_span, `${field} with 15 digits answers`);
    assert.equal(card(field, '4111 1111 1111 1111'), null, `${field} with 16 digits is refused`);
  }
});

// Round 7 ruling 2 at the boundary: six digits in total answer however they
// are spread across the local part, the domain labels and the top-level
// label; seven in total leave the fast path even when every part holds six
// or fewer, so the per-part bound alone could not refuse any of them.
const SIX_TOTAL_EMAILS = ['123@456.example.invalid', 'owner12@mail34.example56.invalid', 'o1w2n3@m4a5i6l.invalid',
  'contact123@mail456.invalid', 'owner@mail123.example456.invalid', 'contact123456@example.invalid'];
const SEVEN_TOTAL_EMAILS = ['1234@567.example.invalid', 'owner1234@mail567.example.invalid',
  'contact123456@mail7.example.invalid', 'o1w2n3e4r@m5a6i7l.example.invalid', 'owner@mail1234.example567.invalid',
  'owner123456@example.in7', '12@34.56.7.invalid'];
const perPart = value => value.split(/[@.]/).map(part => part.replace(/[^0-9]/g, '').length);

test('R4-LEAK-4 round 7 ruling 2: six digits in total across all email parts answer and seven leave the fast path', t => {
  for (const value of SIX_TOTAL_EMAILS) {
    assert.equal(totalDigits(value), 6, `${value} carries exactly six digits`);
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `email ${value} (${operative ? 'operative' : 'card'}) reaches the fact decision`);
      assert.ok(result.answer.includes(value));
    }
  }
  const leaked = [];
  for (const value of SEVEN_TOTAL_EMAILS) {
    assert.equal(totalDigits(value), 7, `${value} carries exactly seven digits`);
    assert.ok(Math.max(...perPart(value)) <= 6, `${value} keeps every part within the per-part bound`);
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      if (result !== null) leaked.push({ surface: operative ? 'email (operative)' : 'email', value, answer: result.answer });
    }
  }
  t.diagnostic(JSON.stringify({ six: SIX_TOTAL_EMAILS.length, seven: SEVEN_TOTAL_EMAILS.length, echoes: leaked.length }));
  assert.equal(leaked.length, 0, `${leaked.length} echoes, e.g. ${JSON.stringify(leaked[0])}`);
});

test('R4-LEAK-4 round 7 ruling 2, mutation: without the total bound the seven-digit split values are echoed', async () => {
  const mutant = await mutatedModule('entity-fact-answer.js', 'value.replace(/[^0-9]/g, "").length <= 6',
    'true');
  // The per-part bound is all that is left in the mutant, and it never sees
  // more than six digits in one part, so the ruling pin above is live.
  for (const value of ['1234@567.example.invalid', '4111@1111.1111.1111.invalid'])
    assert.ok(card('email', value, mutant.entityFactAnswer)?.answer.includes(value), `mutant echoes ${value}`);
  assert.equal(card('email', '1234567@example.invalid', mutant.entityFactAnswer), null, 'mutant still refuses a seven-digit part');
});
