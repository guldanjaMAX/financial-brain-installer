// Partner review round 3, lens: leaks and allowlist. Synthetic fixtures only;
// every name is a role word and every number below is made up.
//
// Expected on 2f5e9ad5: each "repro" test fails and each "control" passes.
//   R3-LEAK-1-1  phone/mobile fast-path allowlist has no upper digit bound
//   R3-LEAK-1-2  company/role fast-path allowlist admits five-digit runs
//   R3-LEAK-1-3  ledger masker redacts its own synthesized placeholder
import test from 'node:test';
import assert from 'node:assert/strict';
import { card } from './partner-r2-helpers.mjs';
import { ledgerFixture } from './ledger-review-fixture.mjs';

globalThis.fetch = () => { throw new Error('network forbidden'); };

// Digit run after NFKC and digit normalization (Arabic-Indic, extended
// Arabic-Indic and Devanagari digits folded to ASCII). Separators are kept so
// a "run" is literal contiguity, matching the lens definition.
const normalizeDigits = text => String(text).normalize('NFKC')
  .replace(/[٠-٩]/g, c => String(c.codePointAt(0) - 0x0660))
  .replace(/[۰-۹]/g, c => String(c.codePointAt(0) - 0x06F0))
  .replace(/[०-९]/g, c => String(c.codePointAt(0) - 0x0966));
const longestDigitRun = text => Math.max(0, ...(normalizeDigits(text).match(/[0-9]+/g) || []).map(run => run.length));

// ----------------------------------------------------------- R3-LEAK-1-1 --
// entity-fact-answer.js:68 admits any 7-29 character string of digits,
// spaces, parentheses and dashes as a phone or mobile value, with no upper
// bound on the digit count. E.164 caps a phone number at 15 digits, so a
// 16-digit card-length value, or a phone followed by a 12-digit account
// number inside the same field, is not a phone number yet is echoed verbatim.
// R2-K2 scoped phone/mobile out as "digit facts"; this is the narrower claim
// that the label alone is the allowlist. Contract decision requested.
const CARD_LENGTH = '4111111111111111';
test('R3-LEAK-1-1 repro: phone and mobile fast path echoes a 16-digit card-length value and a phone followed by an account number', () => {
  for (const [field, value] of [['phone', CARD_LENGTH], ['mobile', '4111 1111 1111 1111'],
    ['phone', '2025550123 123456789012'], ['mobile', '(202) 555-0123 1234-5678-9012']]) {
    const result = card(field, value);
    assert.equal(result, null, `${field} value with more than 15 digits must leave the fast path: ${JSON.stringify(result?.answer)}`);
  }
});

test('R3-LEAK-1-1 control: phone and mobile values within the E.164 digit bound are answered exactly', () => {
  for (const [field, value] of [['phone', '2025550123'], ['mobile', '+1 (202) 555-0123'], ['phone', '202-555-0123'],
    ['mobile', '123456789012345']]) {
    const result = card(field, value);
    assert.ok(result?.fact_span, `${field} ${value} reaches the fact decision`);
    assert.ok(result.answer.includes(value));
    assert.ok(longestDigitRun(value) <= 15);
  }
});

// ----------------------------------------------------------- R3-LEAK-1-2 --
// entity-fact-answer.js:52 masks only a run of six or more digits (after
// stripping separators). The address field needs five-digit ZIP codes and the
// partner's control pins "AZ 85001". Company and role carry no such shape, yet
// the same six-digit threshold applies to them, so a five-digit run, and two
// five-digit runs split by a word, are echoed from those fields. The lens
// threshold is any run longer than four digits. Contract decision requested:
// keep five digits for address only, or keep six everywhere.
test('R3-LEAK-1-2 repro: company and role fast path echoes five-digit runs', () => {
  for (const [field, value] of [['company', 'Synthetic Services 12345'], ['role', 'Operations Lead 12345'],
    ['company', 'Synthetic 12345 Services 67890'], ['role', 'Lead 1-2345']]) {
    for (const operative of [false, true]) {
      const result = card(field, value, undefined, operative);
      assert.equal(result, null, `${field} (${operative ? 'operative' : 'card'}) echoed a five-digit run: ${JSON.stringify(result?.answer)}`);
    }
  }
});

test('R3-LEAK-1-2 control: four-digit company and role values and a ZIP-bearing address are answered exactly', () => {
  for (const [field, value] of [['company', 'Synthetic Services 1234'], ['role', 'Operations Lead 1234'],
    ['company', 'Route 12/34 Services'], ['address', '12 Synthetic Road, Fixture City, AZ 85001']]) {
    for (const operative of [false, true]) {
      const result = card(field, value, undefined, operative);
      assert.ok(result?.fact_span, `${field} ${value} reaches the fact decision`);
      assert.ok(result.answer.includes(value));
      if (field !== 'address') assert.ok(longestDigitRun(result.answer) <= 4, result.answer);
    }
  }
});

// ----------------------------------------------------------- R3-LEAK-1-3 --
// ledger-answer.js:19 substitutes "Deposit" for a blank description and
// ledger-answer.js:550/556 substitute "Transaction" for a blank description
// and payee, and then run the placeholder through the five-character masker.
// A row with no bank text therefore renders "[redacted] ****osit" or
// "[redacted] ****tion": a redaction tail that claims an identifier was hidden
// where none existed. The placeholder is synthesized by the renderer, not read
// from a bank field, so it is not identifier-bearing text.
function blankRowFixture(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('blank', null, null, { date: '2026-10-05', cents: 2500 });
  f.add('named', 'ACH CREDIT', 'Payer One', { date: '2026-10-06', cents: 3100 });
  return f;
}

test('R3-LEAK-1-3 repro: a row with no description renders a fabricated redaction tail', async t => {
  const f = blankRowFixture(t);
  const payment = await f.ask('Did the $25.00 payment arrive on 2026-10-05?');
  assert.ok(payment.ledger, 'ledger answered');
  assert.match(payment.answer, /Found a deposit of \$25\.00 posted 2026-10-05/);
  assert.ok(!/\[redacted\] \*\*\*\*osit/.test(payment.answer), `placeholder was masked: ${payment.answer}`);
  const deposits = await f.ask('What deposits came in during October 2026?');
  assert.ok(deposits.ledger, 'ledger answered');
  const blank = deposits.ledger.rows.find(row => row.amount_minor === 2500);
  assert.ok(blank, 'blank row listed');
  assert.ok(!/^\[redacted\] \*\*\*\*/.test(blank.description), `placeholder was masked: ${blank.description}`);
  assert.ok(!/\[redacted\] \*\*\*\*tion/.test(deposits.answer), `placeholder was masked: ${deposits.answer}`);
});

test('R3-LEAK-1-3 control: real bank text on the neighbouring row is still masked and the figures are unchanged', async t => {
  const f = blankRowFixture(t);
  const deposits = await f.ask('What deposits came in during October 2026?');
  assert.ok(deposits.ledger, 'ledger answered');
  assert.equal(deposits.ledger.rows.length, 2);
  const named = deposits.ledger.rows.find(row => row.amount_minor === 3100);
  assert.equal(named.description, '[redacted] ****EDIT', 'read bank text keeps the render-boundary mask');
  assert.ok(!deposits.answer.includes('ACH CREDIT'));
  assert.ok(!deposits.answer.includes('Payer One'));
  for (const text of [deposits.answer, JSON.stringify(deposits.ledger), JSON.stringify(deposits.citations)])
    assert.ok(longestDigitRun(text) <= 4, text);
  const totals = await f.ask('How much money came in during October 2026?');
  assert.equal(totals.ledger.accounts[0].credits_minor, 5600);
});
