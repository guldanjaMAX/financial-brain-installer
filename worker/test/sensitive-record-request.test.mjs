import test from 'node:test';
import assert from 'node:assert/strict';
import { filterThinkCandidates } from '../src/lib/think-candidate-policy.js';
import { taxQuestionScopeAssessment } from '../src/lib/tax-evidence-scope.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const options = { owner: 'Fixture Owner', now: NOW, timeZone: 'UTC' };
const benign = { title: 'Cabinet note', snippet: 'The cabinet is blue.' };
const filings = [
  ['1065', 'partnership return'],
  ['1120-S', 'corporate return'],
  ['1040', 'individual tax return'],
  ['K-1', 'partner allocation statement'],
  ['W-2', 'annual wage statement'],
  ['1099', 'annual income statement'],
];

function candidateOptions(question) {
  const taxQuestion = taxQuestionScopeAssessment(question, options);
  return { ...options, question, taxQuestion, deferTaxScope: taxQuestion.applicable && taxQuestion.resolved };
}

function decide(row, question) {
  return filterThinkCandidates([row, benign], candidateOptions(question));
}

function assertPair(row, question, control) {
  const requested = decide(row, question);
  const taxQuestion = taxQuestionScopeAssessment(question, options);
  if (taxQuestion.applicable && !taxQuestion.resolved) {
    assert.equal(requested.withheld?.examined_count, 2, 'unresolved production scope cannot defer the candidate guard');
    assert.deepEqual(requested.rows, [benign], 'description alone does not grant tax scope');
    const form = /Form ([0-9]+(?:-S)?)/.exec(row.title)?.[1];
    assert.ok(form, 'unresolved row has a concrete explicit-form control');
    assert.deepEqual(decide(row, `What amount is on our 2023 Form ${form}?`).rows, [row, benign],
      'adding the missing form gives the same row a real resolved guard');
  } else {
    assert.deepEqual(requested.rows, [row, benign], 'requested record and benign control both reach the evidence decision');
    assert.equal(requested.withheld, undefined);
  }
  const unsolicited = decide(row, control);
  assert.equal(unsolicited.withheld?.examined_count, 2, 'unsolicited control reached the nonempty candidate decision');
  assert.equal(unsolicited.withheld.count, 1);
  assert.deepEqual(unsolicited.withheld.reasons, ['unsolicited_sensitive_record']);
  assert.deepEqual(unsolicited.rows, [benign], 'unsolicited sensitive record is withheld beside a green control');
}

for (const [form, description] of filings) {
  const label = form === 'K-1' ? 'Schedule K-1' : `Form ${form}`;
  const row = {
    title: `Store Entity 2023 ${label} ${description}`,
    snippet: `${label}. ${description}. Synthetic filing contents.`,
  };
  const controls = ['What did the business spend in 2023?', 'What is the current card balance?'];
  for (const [wording, question] of [
    ['form', `What amount is on our 2023 Form ${form}?`],
    ['description', `What amount is on our ${description} for 2023?`],
    ['direct description', `What does my ${description} for 2023 report?`],
    ['entity and year', `What amount is on Store Entity's 2023 ${description}?`],
    ['bare identifier', `What amount is on our 2023 ${form}?`],
  ]) test(`${form}: solicited by ${wording}, unsolicited spending and balance controls`, () => {
    for (const control of controls) assertPair(row, question, control);
  });
}

for (const [label, row, question, control] of [
  ['account statement', {
    title: 'Reserve account statement 2023',
    snippet: 'Statement contents.', metadata: { date_of_birth: '2000-01-01' },
  }, 'What balance is on the reserve account statement for 2023?', 'What is my current balance?'],
  ['identity record', {
    title: 'Passport', snippet: 'Passport number: SYNTHETIC_RECORD_ID',
  }, 'What expiry date is on my passport?', 'How much did I spend on passport fees?'],
]) test(`${label}: the record subject rule also applies outside tax`, () => assertPair(row, question, control));

test('record-kind solicitation hands related tax candidates to the existing evidence guard', () => {
  const question = 'What ordinary business income did Store Entity report on its 2023 Form 1065?';
  const row = {
    title: 'Other Entity 2023 Schedule K-1',
    snippet: 'Schedule K-1 (Form 1065). Ordinary business income.',
    authority: { tax_scope: { applicable: true, matched: false } },
  };
  assert.equal(taxQuestionScopeAssessment(question, options).resolved, true, 'real tax scope decision resolves the question');
  assertPair(row, question, 'What did the business spend in 2023?');
  const strict = filterThinkCandidates([row, benign], {
    ...options, deferTaxScope: false, question, taxQuestion: taxQuestionScopeAssessment(question, options),
  });
  assert.equal(strict.withheld?.examined_count, 2, 'unguarded policy reached the strict scope decision');
  assert.deepEqual(strict.rows, [benign], 'without the downstream guard, mismatched scope stays withheld');
});

test('a date or incidental subject mention cannot request sensitive record contents', () => {
  const row = { title: 'Passport', snippet: 'Passport number: SYNTHETIC_RECORD_ID' };
  assertPair(row, 'What expiry date is on my passport?', 'What did I spend on passport?');
  assertPair(row, 'What expiry date is on my passport?', 'What is my spending in 2023?');
});

test('an incidental kind mention in retrieved text cannot solicit a different sensitive record', () => {
  const row = {
    title: 'Passport',
    snippet: 'Passport number: SYNTHETIC_RECORD_ID. Correspondence also mentions Form 1065.',
    query_variant: { matched: 'Form 1065' },
  };
  assertPair(row, 'What expiry date is on my passport?',
    'What ordinary business income did Store Entity report on its 2023 Form 1065?');
});

test('without a resolved downstream scope guard, one record kind cannot solicit another', () => {
  const question = 'What amount is shown on the 2023 Form 1099?';
  const requested = { title: '2023 Form 1099', snippet: 'Annual income statement.' };
  const unrelated = { title: '2023 Form 1040', snippet: 'Individual tax return.' };
  const taxQuestion = taxQuestionScopeAssessment(question, options);
  assert.equal(taxQuestion.resolved, false, 'this request has no resolved deterministic tax scope');
  const result = filterThinkCandidates([requested, unrelated, benign], { question, taxQuestion });
  assert.equal(result.withheld?.examined_count, 3, 'all three candidates reached the decision');
  assert.deepEqual(result.rows, [requested, benign], 'exact requested kind and benign control remain');
  assert.equal(result.withheld.count, 1);
});


test('the policy table grants only the production resolved-scope capability', () => {
  const question = 'What amount is on our partnership return for 2023?';
  const taxQuestion = taxQuestionScopeAssessment(question, options);
  assert.equal(taxQuestion.applicable, true);
  assert.equal(taxQuestion.resolved, false, 'production cannot resolve a form from this description');
  const row = { title: 'Store Entity 2023 Form 1065 partnership return', snippet: 'Synthetic filing contents.' };
  assert.equal(candidateOptions(question).deferTaxScope, false, 'the table cannot grant an unavailable downstream guard');
  assert.equal(candidateOptions('What amount is on our 2023 Form 1065?').deferTaxScope, true, 'resolved control has the production guard');
  const result = decide(row, question);
  assert.equal(result.withheld?.examined_count, 2, 'unresolved scope reaches the strict candidate decision');
  assert.deepEqual(result.rows, [benign]);
  const green = decide(row, 'What amount is on our 2023 Form 1065?');
  assert.deepEqual(green.rows, [row, benign], 'explicit form control uses the real resolved scope capability');
});

for (const prefix of ['My ', 'The ', 'Our ', '']) {
  for (const suffix of ['scan', 'edition alpha']) test(`exact title words survive request parsing: ${prefix || 'plain'}${suffix}`, () => {
    const row = { title: `${prefix}Passport ${suffix}`, snippet: 'Private identity contents.' };
    for (const question of [`Show my ${row.title}`, `Open the ${row.title}`, `What does my ${row.title} say?`,
      `Show me the document titled "${row.title}".`]) {
      const green = decide(row, question);
      assert.deepEqual(green.rows, [row, benign], 'exact title is data even when it starts with an article or possessive');
      const refused = decide(row, 'What balance is on my card?');
      assert.equal(refused.withheld?.examined_count, 2);
      assert.deepEqual(refused.rows, [benign], 'same records retain the unrelated green control');
    }
  });
}
