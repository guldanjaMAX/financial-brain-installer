import test from 'node:test';
import assert from 'node:assert/strict';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';
import { address, card, plainAddress, mutatedModule } from './partner-r2-helpers.mjs';

globalThis.fetch = () => { throw new Error('network forbidden'); };

function subjectFact(subject, field = 'company', operative = false, ownerQuestion = false, api = entityFactAnswer) {
  const values = { company: 'Synthetic Services', role: 'Operations Lead',
    phone: '202-555-0123', mobile: '202-555-0123', email: 'contact@example.invalid' };
  let calls = 0;
  const result = card(field, values[field], args => {
    calls++;
    args.owner = subject;
    args.question = ownerQuestion ? `What is my ${field}?` : `What is ${subject}'s ${field}?`;
    args.results[0].client = subject;
    args.results[0].snippet = args.results[0].snippet.replace('Record Owner', subject);
    args.docs[0].client = subject;
    return api(args);
  }, operative);
  assert.equal(calls, 1, 'real entity fact entry point invoked');
  return result;
}

function controls(api = entityFactAnswer) {
  assert.equal(address(plainAddress, api)?.method, 'dated_owner_address');
  for (const operative of [false, true]) {
    for (const [field, value] of [['company', 'Synthetic Services'], ['role', 'Operations Lead'],
      ['address', plainAddress], ['phone', '202-555-0123'], ['mobile', '+1 (202) 555-0123'],
      ['email', 'contact123456@example.invalid']]) {
      assert.ok(card(field, value, api, operative)?.fact_span, 'same scalar envelope reaches its decision');
      if (!field.includes('address')) for (const ownerQuestion of [false, true])
        assert.ok(subjectFact('Record Owner', field, operative, ownerQuestion, api)?.fact_span);
    }
  }
}

function refusedEverywhere(tail) {
  assert.equal(address(`${plainAddress}, ${tail}`), null, 'dated scalar');
  for (const operative of [false, true]) {
    for (const [field, plain] of [['address', plainAddress], ['company', 'Synthetic Services'], ['role', 'Operations Lead']])
      assert.equal(card(field, `${plain} ${tail}`, entityFactAnswer, operative), null, `${field} scalar`);
    // Contact exemptions belong only to values, never to their subject labels.
    for (const field of ['company', 'role', 'phone', 'mobile', 'email'])
      for (const ownerQuestion of [false, true])
        assert.equal(subjectFact(`Record Owner ${tail}`, field, operative, ownerQuestion), null, `${field} subject`);
  }
}

test('K1 generator covers every runtime No, Nl and Nd codepoint through real fact paths', t => {
  controls();
  const categories = { No: /\p{No}/u, Nl: /\p{Nl}/u, Nd: /\p{Nd}/u };
  const counts = { No: 0, Nl: 0, Nd: 0 };
  for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
    const glyph = String.fromCodePoint(codepoint);
    for (const [category, pattern] of Object.entries(categories)) if (pattern.test(glyph)) {
      counts[category]++;
      // Repeating the same numeric glyph exercises nondecimal numerals too.
      // The cited text is not rewritten, so these must not escape as letters
      // merely because compatibility normalization spells a numeral that way.
      refusedEverywhere(glyph.repeat(6));
    }
  }
  for (const count of Object.values(counts)) assert.ok(count > 100, 'nonempty Unicode category enumeration');
  t.diagnostic(JSON.stringify({ runtime: process.version, unicode: process.versions.unicode, counts,
    factArms: Object.values(counts).reduce((a, b) => a + b, 0) * 27 }));
});

test('K1 generator covers every ASCII punctuation and symbol separator, plus full-width keywords', t => {
  controls();
  let separators = 0;
  for (let codepoint = 0x21; codepoint <= 0x7e; codepoint++) {
    const glyph = String.fromCodePoint(codepoint);
    if (!/[\p{P}\p{S}]/u.test(glyph)) continue;
    refusedEverywhere(`123${glyph}456`);
    separators++;
  }
  assert.equal(separators, 32);
  refusedEverywhere('123 456');
  for (const word of ['account', 'acct', 'routing', 'card', 'iban', 'swift', 'aba']) {
    const wide = [...word.toUpperCase()].map(c => String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join('');
    for (const spelling of [word, word.toUpperCase(), wide]) refusedEverywhere(`${spelling} 1234`);
  }
  t.diagnostic(JSON.stringify({ separators, keywordSpellings: 21, factArms: (33 + 21) * 27 }));
});

test('K1 attached combining marks and ordinary text answer; marks on numbers or separators refuse', () => {
  controls();
  for (const operative of [false, true]) {
    for (const value of ['Cafe\u0301 Services', 'q\u0301 Services', 'Synthetic Services & Co. (West)', 'Route 12/34'])
      assert.ok(card('company', value, entityFactAnswer, operative)?.fact_span, value);
    assert.ok(subjectFact('Record q\u0301', 'company', operative)?.fact_span);
  }
  for (const tail of ['123\u0301456', '123 \u0301456', '123-\u0301456', '\u0301', '123❶456']) refusedEverywhere(tail);
});

test('K1 disabling the one allowlist restores R2 value and subject disclosures', async () => {
  const mutant = await mutatedModule('entity-fact-answer.js',
    'function unsafeScalarFact(value) {', 'function unsafeScalarFact(value) { return false;');
  controls(mutant.entityFactAnswer);
  for (const tail of ["123'456", '123,456', '123(456)', '123#456', '❶❷❸❹❺❻']) {
    assert.equal(address(`${plainAddress}, ${tail}`), null);
    assert.ok(address(`${plainAddress}, ${tail}`, mutant.entityFactAnswer)?.answer.includes(tail));
  }
  for (const operative of [false, true]) for (const field of ['company', 'role']) {
    for (const tail of ["123'456", '123,456', '123(456)', '123&456', '❶❷❸❹❺❻']) {
      assert.equal(card(field, `Synthetic Services ${tail}`, entityFactAnswer, operative), null);
      assert.ok(card(field, `Synthetic Services ${tail}`, mutant.entityFactAnswer, operative)?.answer.includes(tail));
    }
    for (const ownerQuestion of [false, true]) for (const subject of ['Account 123456789', 'Record Owner 123456789']) {
      assert.equal(subjectFact(subject, field, operative, ownerQuestion), null);
      const result = subjectFact(subject, field, operative, ownerQuestion, mutant.entityFactAnswer);
      assert.ok(result?.fact_span);
      assert.ok(result.answer.includes('123456789'));
    }
  }
});
