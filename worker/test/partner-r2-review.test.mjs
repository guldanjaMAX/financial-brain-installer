import test from 'node:test';
import assert from 'node:assert/strict';
import { address, card, plainAddress, answerWithBudget } from './partner-r2-helpers.mjs';
import { attributeInflow, createInflowAttributor, payerRegistry, payerQuestionRegistry,
  ledgerAttributionLimits } from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { productionFixture, measureProduction } from './ledger-production-fixture.mjs';
globalThis.fetch = () => { throw new Error('network forbidden'); };
const question = name => `Did the payment from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
function registryFor(name) {
  return payerQuestionRegistry(classifyLedgerQuestion(question(name), { now: Date.parse(NOW) }), payerRegistry([]));
}
async function reached(f, q) {
  const before = f.calls.length;
  const changes = f.first('SELECT total_changes() n').n;
  const b = await f.ask(q);
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction query reached');
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0, 'nonempty snapshot');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'read-only answer');
  assert.ok(b.ledger, 'ledger answer reached');
  return b;
}
function register(f, name = 'Payer One', relationship = 'owned') {
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('one',?,'business',?,'owner_stated','confirmed',?)`, name, relationship, NOW);
}

test('F1 green: plain address answers; contiguous identifiers and ASCII keywords refuse', () => {
  assert.equal(address(plainAddress)?.method, 'dated_owner_address');
  for (const tail of ['123456', '１２３４５６', '١٢٣٤٥٦', '12 34 56', '12-34-56', 'account 1234', 'acct 1234', 'routing 1234', 'card 1234', 'IBAN 1234'])
    assert.equal(address(`${plainAddress}, ${tail}`), null);
});

test('F1 repro: separated decimal identifiers must not enter the dated answer', () => {
  assert.equal(address(plainAddress)?.method, 'dated_owner_address', 'fact decision reached');
  const slipped = [];
  for (const tail of ['123.456', '123/456', '１２３.４５６', '١٢٣/٤٥٦']) {
    const result = address(`${plainAddress}, ${tail}`);
    if (result?.answer.includes(tail)) slipped.push(tail);
  }
  assert.deepEqual(slipped, [], 'six-digit identifiers reached answer text');
});

test('F1 repro: compatibility-form account vocabulary must be refused', () => {
  assert.equal(address(plainAddress)?.method, 'dated_owner_address', 'fact decision reached');
  assert.equal(address(`${plainAddress}, account 1234`), null, 'ASCII guard reached');
  const slipped = [];
  for (const tail of ['ａｃｃｏｕｎｔ 1234', 'ＡＣＣＴ 1234', 'ｒｏｕｔｉｎｇ 1234', 'ｃａｒｄ 1234', 'ｉｂａｎ 1234']) {
    const result = address(`${plainAddress}, ${tail}`);
    if (result?.answer.includes(tail)) slipped.push(tail);
  }
  assert.deepEqual(slipped, [], 'account vocabulary reached answer text');
});

test('F1 other-fact probe: company and role scalar answers cannot echo financial identifiers', () => {
  const slipped = [];
  for (const field of ['company', 'role']) {
    assert.ok(card(field, 'Synthetic Services')?.answer.includes('Synthetic Services'), 'same card decision reached');
    const unsafe = card(field, 'Account 123456789');
    if (unsafe?.answer.includes('123456789')) slipped.push(field);
  }
  assert.deepEqual(slipped, [], 'financial identifier must fall through to masked generation');
});

test('G2 green: exact and suffix-comma phrases remain useful; ASCII inversion refuses', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'FROM: Payer Contact', null);
  assert.equal((await reached(f, question('Payer Contact'))).ledger.found, true);
  f.raw("UPDATE fin_transactions SET description='FROM: Payer, Contact'");
  assert.equal((await reached(f, question('Payer Contact'))).ledger.found, null);
  for (const name of ['Supplier, LLC', 'Supplier LLC']) {
    f.raw('UPDATE fin_transactions SET description=?,payee=?', `FROM: ${name}`, name);
    assert.equal((await reached(f, question(name))).ledger.found, true);
  }
});

test('G2 alternate comma probe: comma inversion in a bank payee cannot support presence', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'ACH CREDIT', 'Payer Contact');
  assert.equal((await reached(f, question('Payer Contact'))).ledger.found, true);
  const slipped = [];
  for (const comma of ['\u060c', '\u3001', '\uff64']) {
    f.raw('UPDATE fin_transactions SET payee=?', `Payer${comma} Contact`);
    const b = await reached(f, question('Payer Contact'));
    if (b.ledger.found === true) slipped.push(comma.codePointAt(0).toString(16));
  }
  assert.deepEqual(slipped, [], 'non-company comma spellings supplied query-only presence');
});

test('M1 complete disagreement refuses; disambiguated metadata and aliases remain useful', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('receipt', 'Orig Co Name: Supplier Co Entry Descr: Payment SEC: CCD', null);
  for (const sender of ['Supplier', 'Supplier Co']) {
    const b = await reached(f, question(sender));
    assert.equal(b.ledger.found, null);
    assert.equal(b.evidence_gate.complete, false);
  }
  f.raw("UPDATE fin_transactions SET description='Orig Co Name: Supplier; Co Entry Descr: Payment SEC: CCD'");
  assert.equal((await reached(f, question('Supplier'))).ledger.found, true);
  register(f);
  f.raw("UPDATE fin_entities SET display_label='Supplier Alias' WHERE entity_slug='one'");
  f.raw("UPDATE fin_transactions SET description='FROM: Payer One; FROM: Supplier Alias'");
  assert.equal((await reached(f, question('Payer One'))).ledger.found, true);
  f.raw("UPDATE fin_transactions SET description='FROM: Payer One; FROM: Outside Supplier'");
  assert.equal((await reached(f, question('Payer One'))).ledger.found, null);
});

test('M3 disjoint narration and a registered substring retain the exact bounded field', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  register(f, 'Checking');
  f.add('receipt', 'ACH CREDIT', 'Supplier Industries');
  const q = 'How much income came from Supplier Industries in my checking account in October 2026?';
  assert.equal((await reached(f, q)).ledger.found, true);
  f.raw("UPDATE fin_entities SET display_label='Supplier' WHERE entity_slug='one'");
  const b = await reached(f, q);
  assert.equal(b.ledger.found, true, 'a registered substring cannot defeat the complete bounded field');
  assert.equal(b.ledger.total_minor, 2500);
  assert.equal(b.evidence_gate.complete, true);
  assert.equal(b.citations.length, 1);
});

test('S4 cached exhaustion stays local and raw damage cannot reuse a successful result', () => {
  const registry = payerRegistry([{ entity_slug: 'one', legal_name: 'Payer One' }]);
  let lookups = 0;
  const get = registry.get.bind(registry);
  registry.get = key => { lookups++; return get(key); };
  const description = 'FROM: Payer One; BENEFICIARY: ' + Array(75).fill('A').join(' ');
  const decide = createInflowAttributor(registry, { stepLimit: 900 });
  const first = decide({ description });
  assert.equal(first.evidence.parser.refusal, 'operation-limit');
  assert.equal(first.evidence.parser.steps, 900, 'operation decision reached');
  assert.strictEqual(decide({ description: ` ${description}\n` }), first);
  const fresh = createInflowAttributor(registry)({ description });
  assert.equal(fresh.state, 'confirmed');
  assert.ok(lookups > 0, 'identity lookup exercised');
  const other = createInflowAttributor(payerRegistry([{ entity_slug: 'other', legal_name: 'Outside Supplier' }]))({ description });
  assert.equal(other.state, 'unknown');
  const good = createInflowAttributor(registry);
  assert.equal(good({ description: 'FROM: Payer One' }).state, 'confirmed');
  const damaged = good({ description: 'FROM: Payer One\u034f' });
  assert.equal(damaged.evidence.parser.refusal, 'alphabet');
  assert.equal(damaged.state, 'unknown');
});

test('G1/S3 simultaneous caps finish and over-cap arms refuse non-vacuously', () => {
  const registry = payerRegistry([{ entity_slug: 'one', legal_name: 'A' }]);
  let description = Array(6).fill('FROM: A').join(' ') + '; ' + Array(5).fill('REF: 1').join('; ') + '; BENEFICIARY: A';
  const pad = 512 - description.length;
  description += ' A'.repeat(Math.floor(pad / 2)) + (pad % 2 ? 'A' : '');
  const result = attributeInflow({ description }, registry);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.evidence.parser.fields, 12);
  assert.equal(result.evidence.parser.parses, 64);
  assert.equal(description.length, 512);
  assert.ok(result.evidence.parser.steps < ledgerAttributionLimits.steps);
  const overflow = attributeInflow({ description: `${description}A` }, registry);
  assert.equal(overflow.state, 'unknown');
  assert.equal(overflow.evidence.parser.refusal, 'length-limit');
  assert.ok(overflow.evidence.parser.steps > 0);
});

test('S4 green: in-scope exhaustion keeps amounts and withholds complete totals and absence', async t => {
  const f = ledgerFixture(t, { knownPayers: false, answer: await answerWithBudget(500) });
  register(f);
  f.add('first', 'FROM: Payer One', null);
  for (let i = 0; i < 8; i++) f.add(`later-${i}`, `FROM: Payer One; REF: ${i}`, null);
  const b = await reached(f, income('Payer One'));
  assert.ok(b.ledger.attributed_subtotal_minor > 0, 'green early rows survive');
  assert.ok(b.ledger.unattributed_count > 0, 'later rows reached exhaustion');
  assert.equal(b.ledger.inflow_total_minor, 22500);
  assert.equal(b.ledger.total_minor, null);
  assert.equal(b.evidence_gate.complete, false);
  assert.ok(b.gaps.some(g => g.reason === 'answer_operation_limit'));
  const absent = await reached(f, question('Payer One').replace('payment from', 'payment of $77.77 from'));
  assert.equal(absent.ledger.found, null);
  assert.doesNotMatch(absent.answer, /No matching deposit/);
});

test('S4 padding probe: exhaustion gap must not coexist with a complete payer total', async t => {
  const f = ledgerFixture(t, { knownPayers: false, answer: await answerWithBudget(500) });
  register(f);
  f.add('first', 'FROM: Payer One', null);
  for (let i = 0; i < 8; i++) f.add(`padding-${i}`, `FROM: Payer One; REF: ${i}`, null, { date: '2026-10-14' });
  const b = await reached(f, income('Payer One'));
  assert.equal(b.ledger.inflow_total_minor, 2500, 'only the selected receipt belongs to the total');
  assert.ok(b.gaps.some(g => g.reason === 'answer_operation_limit'), 'padding actually exhausted the shared budget');
  assert.equal(b.evidence_gate.complete, false);
  assert.equal(b.ledger.total_minor, null, 'the reported no-complete-total gap must agree with the result');
});

test('owned-only production usefulness remains 40 of 40 with no wrong answers', async t => {
  const f = productionFixture(t);
  const stats = await measureProduction(f);
  assert.equal(stats.answered, 40);
  assert.equal(stats.wrong, 0);
  t.diagnostic(JSON.stringify(stats));
});

test('owned registry filter preserves observed presence and upgrades only after ownership', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  register(f, 'Outside Supplier', 'counterparty');
  f.add('receipt', 'FROM: Outside Supplier', null);
  const b = await reached(f, income('Outside Supplier'));
  assert.ok(f.calls.some(sql => /relationship='owned'/.test(sql)), 'owned-filter decision reached');
  assert.equal(b.ledger.found, true);
  assert.equal(b.ledger.total_minor, 2500);
  assert.equal(b.evidence_gate.complete, true);
  assert.equal(b.payer_evidence[0].type, 'statement_sender');
  f.raw("UPDATE fin_entities SET relationship='owned' WHERE entity_slug='one'");
  assert.equal((await reached(f, income('Outside Supplier'))).ledger.total_minor, 2500);
});
