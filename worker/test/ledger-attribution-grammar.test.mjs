import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeInflow, createInflowAttributor, payerRegistry } from '../src/lib/ledger-attribution.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { lineSeparators } from './ledger-attribution-cases.mjs';

const registry = payerRegistry([
  { entity_slug: 'one', legal_name: 'Payer One' },
  { entity_slug: 'two', legal_name: 'Payer Two' },
]);

function parsed(description, identities = registry) {
  const result = attributeInflow({ description }, identities);
  assert.ok(result.evidence.parser?.steps > 0, 'the bounded parser decision ran');
  return result;
}

test('complete parsing preserves both registered By/From whole names before metadata', () => {
  for (const label of ['By', 'From']) {
    const whole = `${label} Design Services`;
    const entries = [{ entity_slug: 'whole', legal_name: whole }, { entity_slug: 'short', legal_name: 'Design Services' }];
    for (const metadata of ['; REF: 1', ' TRACE NUMBER: 1']) {
      const both = payerRegistry(entries);
      assert.equal(attributeInflow({ payee: whole }, both).state, 'confirmed');
      const result = attributeInflow({ description: whole + metadata }, both);
      assert.ok(result.evidence.candidates.length, 'whole-name lookup decision reached');
      assert.equal(result.state, 'unknown');
      assert.deepEqual(new Set(result.evidence.candidates), new Set([whole, 'Design Services']));
      assert.equal(attributeInflow({ description: whole + metadata }, payerRegistry(entries.slice(0, 1))).state, 'confirmed');
      assert.equal(attributeInflow({ description: whole + metadata }, payerRegistry(entries.map(e => ({ ...e, entity_slug: 'same' })))).state, 'confirmed');
    }
  }
});

test('unconsumed prose, unknown labels and invalid metadata values cannot confirm a sender', () => {
  assert.equal(attributeInflow({ description: 'FROM: Payer One; TRACE NUMBER: 123' }, registry).state, 'confirmed');
  for (const tail of ['TRACE NUMBER: abc', 'EFFECTIVE DATE: 991399', 'REF: 123 extra words',
    'UNLISTED FIELD: 123', 'REF: 123; unfinished', 'ORIG ID: !!', 'SEC: NOTASEC']) {
    const result = parsed(`FROM: Payer One; ${tail}`);
    assert.equal(result.state, 'unknown', tail);
    assert.equal(result.entity_slug, null);
    assert.equal(result.evidence.parser.complete, false, tail);
  }
});

test('caps refuse safely with deterministic parser work and keep the amount in the real answer', async t => {
  const green = parsed('FROM: Payer One; FROM: Payer One');
  assert.equal(green.state, 'confirmed');
  const measurements = [];
  for (const count of [13, 100, 300, 3000]) {
    const result = parsed(Array(count).fill('FROM: Payer One').join('; '));
    assert.equal(result.state, 'unknown');
    assert.equal(result.evidence.parser.complete, false);
    assert.ok(result.evidence.parser.steps <= 32768, 'hard operation ceiling, independent of timing');
    assert.match(result.evidence.parser.refusal, /limit/);
    measurements.push({ count, ...result.evidence.parser });
  }
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`, NOW);
  f.add('receipt', 'FROM: Payer One', null);
  const payment = 'Did the payment from Payer One arrive in October 2026?';
  assert.equal((await f.ask(payment)).ledger.found, true);
  f.raw('UPDATE fin_transactions SET description=?', Array(300).fill('FROM: Payer One').join('; '));
  for (const question of [payment, 'How much income came from Payer One in October 2026?']) {
    f.calls.length = 0;
    const body = await f.ask(question);
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'nonempty transaction decision reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
    assert.equal(f.documentCalls, 0);
    assert.equal(body.ledger.found, null);
    assert.equal(body.ledger.inflow_total_minor, 2500);
    assert.equal(body.ledger.unattributed_count, 1);
    assert.equal(body.evidence_gate.complete, false);
    if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null);
  }
  assert.equal((await f.ask('Did the payment of $25.00 arrive in October 2026?')).ledger.found, true);
  t.diagnostic(JSON.stringify({ bounded_work: measurements }));
});

test('Unicode line separators parse while every other control or format refuses at every insertion boundary', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one','Payer One','business','owned','owner_stated','confirmed',?)`, NOW);
  const base = 'WIRE FROM: Payer One; REF: 123';
  f.add('receipt', base, null);
  const questions = ['Did the payment from Payer One arrive in October 2026?',
    'How much income came from Payer One in October 2026?'];
  for (const question of questions) assert.equal((await f.ask(question)).ledger.found, true);
  assert.equal(parsed(base).state, 'confirmed');
  const hostile = [], allowed = [];
  // Enumerate the runtime's entire Unicode property table, not a handpicked
  // list that can forget the next invisible delimiter or normalization case.
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const char = String.fromCodePoint(cp);
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char)) {
      (lineSeparators.includes(char) ? allowed : hostile).push(char);
    }
  }
  assert.deepEqual(new Set(allowed), new Set(['\r', '\n', '\u0085', '\u2028', '\u2029']));
  let lineAnswers = 0;
  for (const separator of [...allowed, '\r\n']) for (const sender of ['Payer One', 'Unregistered Supplier']) {
    const description = `FROM: Payer One${separator}FROM: ${sender}${separator}TRACE: 123`;
    const result = parsed(description);
    assert.equal(result.evidence.parser.complete, true);
    assert.equal(result.evidence.parser.fields, 3, 'CRLF counts as one field separator');
    assert.equal(result.state, sender === 'Payer One' ? 'confirmed' : 'unknown');
    f.raw('UPDATE fin_transactions SET description=?', description);
    for (const question of questions) {
      f.calls.length = 0;
      const before = f.first('SELECT total_changes() n').n;
      const body = await f.ask(question);
      assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
      assert.equal(f.first('SELECT total_changes() n').n, before);
      assert.equal(f.documentCalls, 0);
      assert.equal(body.ledger.found, sender === 'Payer One' ? true : null);
      assert.equal(body.ledger.inflow_total_minor, 2500);
      assert.equal(body.evidence_gate.complete, sender === 'Payer One');
      if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, sender === 'Payer One' ? 2500 : null);
      lineAnswers++;
    }
    assert.equal((await f.ask('Did the payment of $25.00 arrive in October 2026?')).ledger.found, true);
  }
  let parserCases = 0, answers = 0, amountControls = 0;
  for (const char of hostile) for (let boundary = 0; boundary <= base.length; boundary++) {
    const description = base.slice(0, boundary) + char + base.slice(boundary);
    const result = parsed(description);
    assert.equal(result.state, 'unknown');
    assert.equal(result.evidence.parser.refusal, 'alphabet');
    // Even an exact registered alias cannot authorize disallowed characters.
    const named = payerRegistry([{ entity_slug: 'one', legal_name: description }]);
    assert.equal(parsed(description, named).state, 'unknown');
    parserCases += 2;
    f.raw('UPDATE fin_transactions SET description=?', description);
    for (const question of questions) {
      f.calls.length = 0;
      const before = f.first('SELECT total_changes() n').n;
      const body = await f.ask(question);
      assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
      assert.equal(f.first('SELECT total_changes() n').n, before);
      assert.equal(f.documentCalls, 0);
      assert.equal(body.ledger.found, null, `never presence or absence: U+${char.codePointAt(0).toString(16)} at ${boundary}`);
      assert.equal(body.evidence_gate.complete, false);
      assert.equal(body.ledger.inflow_total_minor, 2500);
      assert.equal(body.ledger.unattributed_count, 1);
      if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null, 'never zero');
      answers++;
    }
    const amount = await f.ask('Did the payment of $25.00 arrive in October 2026?');
    assert.equal(amount.ledger.found, true);
    amountControls++;
  }
  assert.ok(hostile.length > 200 && parserCases > 10000 && answers > 10000);
  t.diagnostic(JSON.stringify({ hostile_alphabet: { unicode: process.versions.unicode,
    codepoints: hostile.length, allowed_line_codepoints: allowed.length, line_answers: lineAnswers,
    boundaries: base.length + 1, parser_cases: parserCases,
    payment_answers: answers / 2, income_answers: answers / 2, amount_controls: amountControls } }));
});

test('the length, field and parse limits have successful boundary controls', t => {
  const one = payerRegistry([{ entity_slug: 'one', legal_name: 'A' }]);
  const name = 'A'.repeat(512), longRegistry = payerRegistry([{ entity_slug: 'one', legal_name: name }]);
  assert.equal(parsed(name, longRegistry).state, 'confirmed');
  assert.equal(parsed(name + 'A', longRegistry).evidence.parser.refusal, 'length-limit');
  const twelve = parsed(Array(12).fill('FROM: A').join('; '), one);
  assert.equal(twelve.state, 'confirmed'); assert.equal(twelve.evidence.parser.fields, 12);
  assert.equal(parsed(Array(13).fill('FROM: A').join('; '), one).evidence.parser.refusal, 'field-limit');
  const sixtyFour = parsed(Array(6).fill('FROM: A').join(' '), one);
  assert.equal(sixtyFour.state, 'confirmed'); assert.equal(sixtyFour.evidence.parser.parses, 64);
  assert.equal(parsed(Array(7).fill('FROM: A').join(' '), one).evidence.parser.refusal, 'parse-limit');
  // Candidate-end accounting removes the old artificial quadratic charge.
  // Exercise exhaustion with an injected cap, independently of input density.
  const dense = createInflowAttributor(one, { stepLimit: 1024 })({ description: Array(250).fill('A').join(' ') });
  assert.equal(dense.state, 'unknown');
  assert.equal(dense.evidence.parser.refusal, 'operation-limit');
  assert.equal(dense.evidence.parser.steps, 1024);
  t.diagnostic(JSON.stringify({ budget_controls: { length: 512, fields: twelve.evidence.parser,
    parses: sixtyFour.evidence.parser, operations: dense.evidence.parser } }));
});

test('all sender fields must resolve and complete metadata alternatives retain entity conflicts', () => {
  for (const delimiter of [';', ',', '|', '']) {
    const repeated = `FROM: Payer One ${delimiter} FROM: Payer One`;
    assert.equal(parsed(repeated).state, 'confirmed');
    for (const sender of ['Payer Two', 'Unregistered Supplier']) {
      const result = parsed(`FROM: Payer One ${delimiter} FROM: ${sender}`);
      assert.equal(result.evidence.parser.complete, true, 'whole syntax consumed before lookup refusal');
      assert.equal(result.state, 'unknown');
    }
  }
  for (const value of ['261005', '20261005', '2026-10-05', '10/05/2026', '2024-02-29'])
    assert.equal(parsed(`FROM: Payer One; EFFECTIVE DATE: ${value}`).state, 'confirmed');
  for (const value of ['261332', '20260229', '2026-02-29', '00/01/2026', 'Services']) {
    const result = parsed(`FROM: Payer One; EFFECTIVE DATE: ${value}`);
    assert.equal(result.state, 'unknown'); assert.equal(result.evidence.parser.complete, false);
  }
  for (const char of ['=', '$', '\u00a0', '\ud800', '\uffff', '\u{1f600}']) {
    const result = parsed(`FROM: Payer One${char}`);
    assert.equal(result.state, 'unknown'); assert.equal(result.evidence.parser.refusal, 'alphabet');
  }
});
