import test from 'node:test';
import assert from 'node:assert/strict';
import * as attribution from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';
import { address, card, plainAddress, mutatedModule } from './partner-r2-helpers.mjs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

globalThis.fetch = () => { throw new Error('network forbidden'); };
const question = name => `Did the payment from ${name} arrive in October 2026?`;
const commas = ['\u060c', '\u3001', '\uff0c', '\uff64', '\ufe50', '\ufe51', '\u2e41',
  '\u1802', '\u1808', '\ua4fe', '\ua60d', '\u07f8', '\u055d'];
function registry(name, api = attribution) {
  const intent = classifyLedgerQuestion(question(name), { now: Date.parse(NOW) });
  assert.equal(intent.kind, 'payment', 'payer question reaches its real selector decision');
  assert.ok(intent.payerReadings.length, 'nonempty payer readings');
  return api.payerQuestionRegistry(intent, api.payerRegistry([]));
}

test('F1 every scalar card and operative value shares the identifier refusal; contact controls answer', () => {
  for (const operative of [false, true]) {
    for (const field of ['address', 'mailing address', 'home address', 'business address', 'company', 'role']) {
      const plain = field.includes('address') ? plainAddress : 'Synthetic Services';
      assert.ok(card(field, plain, entityFactAnswer, operative)?.fact_span, 'identical envelope reaches fact decision');
      for (const digits of ['123456', '１２３４５６', '١٢٣٤٥٦']) {
        for (const separator of [' ', '-', '.', '/', '_', '·', '\u00a0', '\u2011', '．', '／', '＿', '･']) {
          const tail = [...digits].join(separator);
          assert.equal(card(field, `${plain} ${tail}`, entityFactAnswer, operative), null, `${field}: ${tail}`);
        }
      }
      for (const word of ['account', 'acct', 'routing', 'card', 'iban', 'swift', 'aba']) {
        const wide = [...word.toUpperCase()].map(c => String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join('');
        for (const tail of [word, word.toUpperCase(), wide])
          assert.equal(card(field, `${plain} ${tail} 1234`, entityFactAnswer, operative), null, `${field}: ${tail}`);
      }
    }
    for (const [field, value] of [['phone', '+1 (202) 555-0123'], ['mobile', '202-555-0123'], ['email', 'contact123456@example.invalid']])
      assert.ok(card(field, value, entityFactAnswer, operative)?.answer.includes(value), 'phone and email retain their own validators');
  }
});

test('F2 all approved commas preserve positions on both question and bank sides', () => {
  for (const comma of commas) for (const [asked, bank, expected] of [
    ['Payer Contact', `Payer${comma} Contact`, 'unknown'],
    [`Payer${comma} Contact`, 'Payer Contact', 'unknown'],
    [`Payer${comma} Contact`, `Payer${comma} Contact`, 'unknown'],
    ['Supplier, LLC', `Supplier${comma} LLC`, 'observed'],
    [`Supplier${comma} LLC`, 'Supplier, LLC', 'observed'],
    [`Supplier${comma} LLC`, `Supplier${comma} LLC`, 'observed'],
  ]) {
    const index = registry(asked);
    for (const row of [{ payee: bank }, { description: `FROM: ${bank}` }]) {
      const result = attribution.attributeInflow(row, index);
      assert.ok(result.evidence.source, 'bank field decision reached');
      assert.equal(result.state, expected, `${comma.codePointAt(0).toString(16)} / ${asked} / ${bank}`);
    }
  }
});

test('F2 residual other punctuation cannot grant query authority; exceptions remain useful', () => {
  const index = registry('Payer Contact');
  assert.equal(attribution.attributeInflow({ payee: 'Payer Contact' }, index).state, 'observed');
  for (const mark of [':', ';', '!', '?', '…', '、', '،', '፣', '፥', '⸴', '᠄', '꘎', '⸲']) {
    const result = attribution.attributeInflow({ payee: `Payer${mark} Contact` }, index);
    assert.equal(result.evidence.source, 'payee');
    assert.equal(result.state, 'unknown', mark);
  }
  for (const mark of ['.', "'", '&', '-', '/', '#']) {
    const name = `Supplier${mark} Services`, index = registry(name);
    for (const row of [{ payee: name }, { description: `FROM: ${name}` }])
      assert.equal(attribution.attributeInflow(row, index).state, 'observed', mark);
  }
  // Colons previously fitted the sender grammar but cannot give a query-only
  // phrase authority. The same registered spelling retains independent proof.
  const name = 'Supplier: Services';
  for (const row of [{ payee: name }, { description: `FROM: ${name}` }]) {
    assert.equal(attribution.attributeInflow(row, registry(name)).state, 'unknown');
    assert.equal(attribution.attributeInflow(row, attribution.payerRegistry([{ entity_slug: 'supplier', legal_name: name }])).state, 'confirmed');
  }
});

test('F2 registered company comma spellings use the same mapping through the real answer', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('supplier','Supplier, Services','business','owned','owner_stated','confirmed',?)`, NOW);
  f.add('receipt', 'FROM: Supplier, Services', null);
  for (const comma of commas) {
    f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', `Supplier${comma} Services`, 'supplier');
    f.raw('UPDATE fin_transactions SET description=?', `FROM: Supplier${comma} Services`);
    const before = f.calls.length, writes = f.first('SELECT total_changes() n').n;
    const body = await f.ask(question(`Supplier${comma} Services`));
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real nonempty snapshot reached');
    assert.equal(f.first('SELECT total_changes() n').n, writes);
    assert.equal(body.ledger?.found, true);
  }
});

test('F1 new canonical guard mutation restores unsafe scalar output and preserves controls', async () => {
  const mutant = await mutatedModule('entity-fact-answer.js',
    'if (unsafeScalarFact(value)) return false;', 'if (false) return false;');
  for (const api of [entityFactAnswer, mutant.entityFactAnswer]) {
    assert.equal(address(plainAddress, api)?.method, 'dated_owner_address');
    assert.ok(card('company', 'Synthetic Services', api)?.fact_span);
    for (const value of [`${plainAddress}, 123.456`, `${plainAddress}, ＳＷＩＦＴ 1234`])
      assert.equal(Boolean(address(value, api)), api === mutant.entityFactAnswer);
    assert.equal(Boolean(card('role', 'Account 123456789', api)), api === mutant.entityFactAnswer);
    assert.ok(card('phone', '+1 (202) 555-0123', api));
    assert.ok(card('email', 'contact123456@example.invalid', api));
  }
});

test('F2 comma and residual-punctuation guard mutation restores unsafe payee authority', async () => {
  const mutant = await mutatedModule('ledger-attribution.js',
    'return valid(left) && valid(right) && companyCommaKey(left) === companyCommaKey(right);',
    'return normalizeMerchantText(left) === normalizeMerchantText(right);');
  for (const api of [attribution, mutant]) {
    const index = registry('Payer Contact', api);
    assert.equal(api.attributeInflow({ payee: 'Payer Contact' }, index).state, 'observed');
    for (const mark of [...commas, ':', '፣']) {
      const result = api.attributeInflow({ payee: `Payer${mark} Contact` }, index);
      assert.equal(result.evidence.source, 'payee', 'structured authority decision reached');
      assert.equal(result.state, api === mutant ? 'observed' : 'unknown');
    }
    assert.equal(api.attributeInflow({ payee: 'Supplier, LLC' }, registry('Supplier, LLC', api)).state, 'observed');
  }
});

test('F2 restoring only the R1 punctuation check reopens Unicode bypasses while ASCII inversion still refuses', async () => {
  const mutant = await mutatedModule('ledger-attribution.js',
    'return valid(left) && valid(right) && companyCommaKey(left) === companyCommaKey(right);',
    `const legacyValid = value => {
      const parts = String(value).normalize('NFKC').split(',');
      return parts.length === 1 || (parts.length === 2 && normalizeMerchantText(parts[0]) &&
        statementGrammar.companySuffix.test(parts[1].trim().replaceAll('.', '')));
    };
    const legacyKey = value => String(value).normalize('NFKC').split(',').map(normalizeMerchantText).join(',');
    return legacyValid(left) && legacyValid(right) && legacyKey(left) === legacyKey(right);`);
  for (const api of [attribution, mutant]) {
    const index = registry('Payer Contact', api);
    assert.equal(api.attributeInflow({ payee: 'Payer Contact' }, index).state, 'observed');
    assert.equal(api.attributeInflow({ payee: 'Payer, Contact' }, index).state, 'unknown', 'the original ASCII guard stays active');
    for (const mark of ['\u060c', '\u3001', '\uff64', ':', '፣']) {
      const result = api.attributeInflow({ payee: `Payer${mark} Contact` }, index);
      assert.equal(result.evidence.source, 'payee');
      assert.equal(result.state, api === mutant ? 'observed' : 'unknown');
    }
    assert.equal(api.attributeInflow({ payee: 'Supplier, LLC' }, registry('Supplier, LLC', api)).state, 'observed');
  }
});
