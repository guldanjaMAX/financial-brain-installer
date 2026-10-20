// Partner review round 3, round 2, lens: leaks and allowlist. Synthetic
// fixtures only; every name is a role word and every number below is made up.
//
// Expected on a299c22: the "repro" test fails and the "control" test passes.
//   R3-LEAK-2-1  email fast-path validator bypasses the identifier allowlist
import test from 'node:test';
import assert from 'node:assert/strict';
import { card } from './partner-r2-helpers.mjs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

globalThis.fetch = () => { throw new Error('network forbidden'); };

const longestDigitRun = text => Math.max(0, ...(String(text).normalize('NFKC').match(/[0-9]+/g) || []).map(run => run.length));

// ----------------------------------------------------------- R3-LEAK-2-1 --
// entity-fact-answer.js:67 returns the email regex result before the
// unsafeScalarFact guard at :71 runs, so an email value is the one scalar on
// the fast path that skips BOTH halves of the allowlist: the digit-run bound
// and the account/acct/routing/card/iban/swift/aba word list. The regex admits
// an unbounded digit run in the local part and in every domain label (value
// length 180), so a card-length local part, an "account<number>" or
// "routing<number>" local part, and a digit-only domain label are all echoed
// verbatim by the fast path, with no verifier in between (index.js:1395-1396
// hard-codes supported=true for a fact answer).
// Distinct from R3-LEAK-1-1 (phone/mobile digit bound, :68): different
// validator, and this one also bypasses the identifier word list.
// Contract decision requested: R2-K2 scoped email out as "a digit or
// identifier fact", and partner-r3-allowlist.test.mjs:30 pins
// contact123456@example.invalid as answered. The claim here is narrower: a
// local part or domain label that is itself an identifier-length digit run,
// or that is prefixed with an allowlisted identifier word, is not an email
// fact the fast path should certify.
const CARD_LENGTH = '4111111111111111';
test('R3-LEAK-2-1 repro: email fast path echoes an identifier-length digit run and an identifier-word local part', () => {
  for (const value of [`${CARD_LENGTH}@example.invalid`, `account${CARD_LENGTH}@bank.invalid`,
    'routing021000021@bank.invalid', 'acct.778899667788@example.invalid', `owner@${CARD_LENGTH}.invalid`]) {
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      assert.equal(result, null, `email (${operative ? 'operative' : 'card'}) echoed an identifier: ${JSON.stringify(result?.answer)}`);
    }
  }
});

test('R3-LEAK-2-1 control: ordinary email values are answered exactly and the same identifiers are refused in every other scalar field', () => {
  for (const value of ['contact@example.invalid', 'first.last+tag@example.invalid', 'contact1234@example.invalid', 'owner@mail2.example.invalid']) {
    for (const operative of [false, true]) {
      const result = card('email', value, entityFactAnswer, operative);
      assert.ok(result?.fact_span, `email ${value} reaches the fact decision`);
      assert.ok(result.answer.includes(value));
      assert.ok(longestDigitRun(result.answer) <= 4, result.answer);
    }
  }
  // The guard the email validator skips is live for company, role and address.
  for (const [field, plain] of [['company', 'Synthetic Services'], ['role', 'Operations Lead'], ['address', '12 Synthetic Road, Fixture City, AZ 85001']]) {
    for (const tail of [CARD_LENGTH, `account ${CARD_LENGTH}`, 'routing 021000021']) {
      for (const operative of [false, true])
        assert.equal(card(field, `${plain} ${tail}`, entityFactAnswer, operative), null, `${field} refused ${tail}`);
    }
  }
});
