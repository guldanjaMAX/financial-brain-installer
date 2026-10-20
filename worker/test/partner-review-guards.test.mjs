// Guard mutations use only synthetic values and in-memory module copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';
import { attributeInflow, createInflowAttributor, payerRegistry, payerQuestionRegistry,
  ledgerAttributionLimits } from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

async function mutatedModule(file, before, after) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  let source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'exactly one guard is mutated');
  source = source.replace(before, after).replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function address(answer, value) {
  const day = '2034-10-16', title = 'Address change';
  const snippet = `[${title}] From: Record Owner <owner@example.invalid>\nTo: service@example.invalid\nDate: ${day}\nSubject: ${title}\n\nMy mailing address is ${value}.`;
  return answer({ question: 'What is my mailing address?', owner: 'Record Owner', now: Date.parse('2034-10-20'),
    results: [{ title, snippet }], docs: [{ n: 1, ref: 'fixture-mail', source_kind: 'gmail', date_source: 'email_header',
      date_reliable: true, ts: day, text_source: 'native', text_reliable: true,
      lineage: { status: 'known', kind: 'source_record' }, authority: {} }] });
}

test('K1 exact address guard mutation flips the refusal and leaves a plain address usable', async () => {
  const mutant = await mutatedModule('entity-fact-answer.js',
    'if (unsafeScalarFact(value, field)) return false;', 'if (false) return false;');
  const plain = '12 Synthetic Road, Fixture City, AZ 85001';
  assert.equal(address(entityFactAnswer, plain)?.method, 'dated_owner_address', 'same envelope reaches the fact decision');
  for (const tail of ['Account 1234', 'acct 1234', 'routing 1234', 'card 1234', 'IBAN 1234',
    '123456', '１２３４５６', '12 34 56', '12-34-56', '12\u201334\u201356']) {
    const value = `${plain}, ${tail}`;
    assert.equal(address(entityFactAnswer, value), null, tail);
    // Non-ASCII punctuation is independently excluded by the scalar alphabet.
    if (!tail.includes('\u2013')) assert.equal(address(mutant.entityFactAnswer, value)?.method, 'dated_owner_address', tail);
  }
});

test('M1 sender disagreement guard mutation restores the shorter false positive', async () => {
  const mutant = await mutatedModule('ledger-attribution.js', 'if (senderKeys.size > 1)', 'if (false)');
  for (const api of [{ attributeInflow, payerRegistry, payerQuestionRegistry }, mutant]) {
    const intent = classifyLedgerQuestion('Did a payment from Acme arrive in October 2026?', { now: Date.parse(NOW) });
    const registry = api.payerQuestionRegistry(intent, api.payerRegistry([]));
    const control = api.attributeInflow({ description: 'Orig Co Name: Acme Orig ID: 1234 Co Entry Descr: Payment SEC: CCD' }, registry);
    assert.equal(control.state, 'observed');
    const result = api.attributeInflow({ description: 'Orig Co Name: Acme Co Entry Descr: Payment SEC: CCD' }, registry);
    assert.equal(result.evidence.parser.complete, true, 'competing complete readings reached');
    assert.equal(result.state, api === mutant ? 'observed' : 'unknown');
    assert.equal(Boolean(result.evidence.query_phrases?.length), api === mutant);
  }
});

test('G2 comma guard mutation restores a mid-name false positive', async () => {
  const mutant = await mutatedModule('ledger-attribution.js',
    'return valid(left) && valid(right) && companyCommaKey(left) === companyCommaKey(right);',
    'return normalizeMerchantText(left) === normalizeMerchantText(right);');
  for (const api of [{ attributeInflow, payerRegistry, payerQuestionRegistry }, mutant]) {
    const intent = classifyLedgerQuestion('Did a payment from Payer Contact arrive in October 2026?', { now: Date.parse(NOW) });
    const registry = api.payerQuestionRegistry(intent, api.payerRegistry([]));
    assert.equal(api.attributeInflow({ description: 'FROM: Payer Contact' }, registry).state, 'observed');
    const result = api.attributeInflow({ description: 'FROM: Payer, Contact' }, registry);
    assert.equal(result.evidence.parser.complete, true, 'comma reading reaches identity decision');
    assert.equal(result.state, api === mutant ? 'observed' : 'unknown');
  }
});

test('G2 phrase commas agree in both fields and are confined to company suffixes', () => {
  for (const questionName of ['Payer, Contact', 'Payer Contact', 'Supplier, LLC', 'Supplier LLC']) {
    const intent = classifyLedgerQuestion(`Did a payment from ${questionName} arrive in October 2026?`, { now: Date.parse(NOW) });
    const registry = payerQuestionRegistry(intent, payerRegistry([]));
    for (const fieldName of ['Payer, Contact', 'Payer Contact', 'Supplier, LLC', 'Supplier LLC']) {
      const expected = questionName === fieldName && questionName !== 'Payer, Contact' ? 'observed' : 'unknown';
      for (const row of [{ description: `FROM: ${fieldName}` }, { payee: fieldName }]) {
        const result = attributeInflow(row, registry);
        assert.ok(result.evidence.source, 'field attribution reached');
        assert.equal(result.state, expected, `${questionName} / ${fieldName}`);
      }
    }
  }
});

test('G1/S3 a description simultaneously reaches all published caps inside the step budget', t => {
  const fields = [...Array(6).fill('FROM: A'), ...Array(5).fill('REF: 1'), 'BENEFICIARY: A'];
  let description = fields.slice(0, 6).join(' ') + '; ' + fields.slice(6).join('; ');
  // Saturate the remaining value with one-character words, maximizing its
  // candidate ends instead of padding a single cheap token.
  const padding = 512 - [...description].length;
  description += ' A'.repeat(Math.floor(padding / 2)) + (padding % 2 ? 'A' : '');
  assert.equal([...description].length, 512);
  const result = attributeInflow({ description }, payerRegistry([{ entity_slug: 'one', legal_name: 'A' }]));
  assert.equal(result.state, 'confirmed');
  assert.equal(result.evidence.parser.fields, 12);
  assert.equal(result.evidence.parser.parses, 64);
  assert.equal(result.evidence.parser.refusal, null);
  assert.ok(result.evidence.parser.steps < ledgerAttributionLimits.steps);
  t.diagnostic(JSON.stringify({ at_caps: result.evidence.parser, limits: ledgerAttributionLimits }));
});

test('S4 answer budget refuses explicitly after real work, and a fresh answer remains usable', () => {
  const registry = payerRegistry([{ entity_slug: 'one', legal_name: 'Payer One' }]);
  const decide = createInflowAttributor(registry, { answerStepLimit: 2000 });
  let refused;
  for (let i = 0; i < 100; i++) {
    const result = decide({ description: `FROM: Payer One; REF: ${i}` });
    if (!i) assert.equal(result.state, 'confirmed', 'a real parse precedes exhaustion');
    if (result.evidence.parser.refusal === 'answer-operation-limit') { refused = result; break; }
  }
  assert.equal(refused?.state, 'unknown');
  assert.equal(createInflowAttributor(registry)({ description: 'FROM: Payer One; REF: 0' }).state, 'confirmed');
});

test('M4 all abbreviated metadata labels share the labelled sender path', () => {
  const registry = payerRegistry([{ entity_slug: 'one', legal_name: 'Payer One' }]);
  for (const field of ['Ind ID: A123', 'Ind Name: Recipient Role', 'TRN: 1234567']) {
    const result = attributeInflow({ description: `FROM: Payer One; ${field}` }, registry);
    assert.equal(result.evidence.parser.fields, 2);
    assert.equal(result.state, 'confirmed');
  }
});

test('S4 real answer exposes exhausted work as a gap and keeps every deposit amount', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`, NOW);
  const fields = ['ORIG CO NAME: Payer One', 'ORIG ID: 1234567890', 'DESC DATE: 261005', 'CO ENTRY DESCR: PAYMENT',
    'SEC: CCD', 'TRACE NUMBER: 021000021234567', 'EFFECTIVE DATE: 2026-10-05', 'REFERENCE: 1234',
    'MEMO: october-services', 'INDIVIDUAL ID: ABC123',
    `BENEFICIARY: ${Array(17).fill('Recipient').join(' ')}`, 'SETTLEMENT DATE: 10/05/2026'];
  const description = fields.join(' ');
  assert.ok([...description].length <= 512);
  const green = attributeInflow({ description }, payerRegistry([{ entity_slug: 'one', legal_name: 'Payer One' }]));
  assert.equal(green.state, 'confirmed', 'each ordinary row is valid before the answer budget');
  assert.ok(green.evidence.parser.steps * 5000 > ledgerAttributionLimits.answerSteps, 'fixture reaches the answer limit');
  for (let i = 0; i < 5000; i++) f.add(`receipt-${i}`, description.replace('REFERENCE: 1234', `REFERENCE: ${i}`), null);
  const body = await f.ask('How much income came from Payer One in October 2026?');
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(body.ledger.inflow_total_minor, 12500000);
  assert.equal(body.ledger.total_minor, null);
  assert.ok(body.ledger.unattributed_count > 0);
  assert.ok(body.ledger.attributed_subtotal_minor > 0, 'successful early rows are preserved');
  assert.ok(body.gaps.some(gap => gap.type === 'ledger_attribution_budget' && gap.reason === 'answer_operation_limit'));
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /sender parsing work limit/);
  t.diagnostic(JSON.stringify({ answer_budget: ledgerAttributionLimits.answerSteps,
    one_row_steps: green.evidence.parser.steps, unattributed: body.ledger.unattributed_count }));
});


test('S2 original selectors and exact mode survive receive wording without a money keyword', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('receipt', 'FROM: Supplier One', 'Supplier One');
  for (const prefix of ['How much income came', 'How much did I receive']) {
    const question = `${prefix} from Supplier One in my account ending 1234 in October 2026, exact names only?`;
    const intent = classifyLedgerQuestion(question, { now: Date.parse(NOW) });
    assert.equal(intent.kind, 'merchant');
    assert.equal(intent.mask, '1234');
    assert.equal(intent.exactNamesOnly, true);
    assert.equal(intent.match, 'supplier one');
    const body = await f.ask(question);
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
    assert.equal(body.ledger.found, true);
    assert.equal(body.ledger.total_minor, 2500);
    assert.equal(body.evidence_gate.complete, true);
    assert.equal(body.citations.length, 1);
  }
});

test('S1 a dangling connector before arrival cannot shorten a requested payer', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`, NOW);
  f.add('receipt', 'FROM: Payer One', 'Payer One');
  const green = await f.ask('Did the payment from Payer One in October 2026 arrive?');
  assert.equal(green.ledger.found, true, 'the complete date clause remains usable');
  const questions = ['Payer One in', 'Payer One, in', 'Payer One of']
    .map(name => `Did the payment from ${name} arrive in October 2026?`);
  questions.push('Has my payment arrived from Payer One in in October 2026?');
  for (const question of questions) {
    const before = f.documentCalls, reads = f.calls.length;
    const body = await f.ask(question);
    assert.equal(f.documentCalls, before + 1, 'unsupported full spelling reaches fallback');
    assert.equal(f.calls.length, reads, 'a shortened name cannot select the ledger');
    assert.equal(body.ledger, undefined);
  }
});
