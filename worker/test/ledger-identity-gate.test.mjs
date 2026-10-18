import { explicitStatements, originatorWords, originatorFormats } from './ledger-attribution-cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { maskLedgerCandidateField } from '../src/lib/ledger-answer.js';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { attributeInflow } from '../src/lib/ledger-attribution.js';

const payment = 'Did the payment from Payer One arrive in October 2026?';
const income = 'How much income came from Payer One in October 2026?';
const amountOnly = 'Did the payment of $25.00 arrive in October 2026?';
function identity(f, name, slug = 'payer-one', state = 'confirmed') {
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,'business','counterparty','owner_stated',?,?)`, slug, name, state, NOW);
}
function reached(f, body) {
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'transaction decision reached');
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0, 'snapshot is nonempty');
  assert.ok(body.ledger, 'ledger answer reached');
  assert.equal(f.documentCalls, 0, 'no fallback hides a gate failure');
}
function unknown(f, body) {
  reached(f, body);
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.gaps[0].reason, 'sender_attribution_unknown');
  assert.equal(body.ledger.unattributed_count, 1);
  assert.equal(body.citations.length, 1, 'unknown receipt is still visible');
  assert.equal(body.citations[0].amount_minor, 2500);
  assert.doesNotMatch(body.answer, /no matching|\$0\.00/i);
  if (body.ledger.kind === 'merchant') {
    assert.equal(body.ledger.total_minor, null);
    assert.equal(body.ledger.lead_total_minor, null);
    assert.equal(body.ledger.if_own_transfers, undefined);
  }
}
function random(seed) {
  let value = seed;
  return () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function shorthandNote(body, { label = 'Payer One', suffix = 'payment', count = 1, amount = 2500 } = {}) {
  const assumption = body.assumptions?.find(a => a.type === 'payer_shorthand' && a.suffix === suffix);
  assert.ok(assumption, 'shorthand presence requires a structured assumption');
  assert.equal(assumption.identity, maskLedgerCandidateField(label));
  assert.equal(assumption.count, count);
  assert.equal(assumption.amount_minor, amount);
  assert.equal(assumption.citations.length, count);
  assert.ok(assumption.citations.every(n => body.citations.some(c => c.n === n)));
  assert.ok(body.ledger.flip.includes('exact names only'));
  const note = body.notes.find(note => note.includes(`"${assumption.identity} + ${suffix}"`));
  assert.ok(note, 'the owner sees the exact masked reading');
  assert.ok(note.includes(`${count} ${count === 1 ? 'row' : 'rows'}`));
  assert.match(note, /say "exact names only" to leave these out/);
  assert.ok(body.answer.includes(`Note: ${body.notes.join('; ')}.`), 'final response cannot omit its assumption note');
}

test('shorthand premise: identical bare bytes answer only with an explicit assumption', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One');
  f.add('receipt', 'Payer One payment', null);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE legal_name='Payer One payment'").n, 0);
  const control = await f.ask(amountOnly); reached(f, control); assert.equal(control.ledger.found, true);
  for (const q of [payment, income]) {
    const body = await f.ask(q); reached(f, body);
    assert.equal(body.evidence_gate.complete, true);
    assert.equal(q === payment ? body.ledger.found : body.ledger.total_minor, q === payment ? true : 2500);
    shorthandNote(body);
  }
  for (const q of [payment, income]) {
    // The same bytes might name an unregistered longer payer. Accepting the
    // shorter reading must never disprove that queried longer name.
    unknown(f, await f.ask(q.replace('Payer One', 'Payer One payment')));
  }
  // A known longer name removes permission to choose either interpretation.
  identity(f, 'Payer One payment', 'longer');
  f.raw("UPDATE fin_entities SET display_label='Long Supplier' WHERE entity_slug='longer'");
  for (const label of ['Payer One', 'Long Supplier']) for (const q of [payment, income]) {
    const body = await f.ask(q.replace('Payer One', label)); unknown(f, body);
    assert.match(body.answer, /ambiguous|more than one/i);
    assert.deepEqual(body.ledger.payer_candidates, ['Payer One', 'Payer One payment'].map(maskLedgerCandidateField));
    for (const candidate of body.ledger.payer_candidates) assert.ok(body.answer.includes(candidate));
  }
});

test('noun-first payer names starting with a transaction word remain answerable', async t => {
  const f = ledgerFixture(t); identity(f, 'Payment Services');
  f.add('receipt', 'FROM: Payment Services', null);
  const control = await f.ask(payment.replace('Payer One', 'Payment Services')); reached(f, control);
  assert.equal(control.ledger.found, true);
  const body = await f.ask('Did Payment Services payment arrive in October 2026?'); reached(f, body);
  assert.equal(body.ledger.found, true); assert.equal(body.evidence_gate.complete, true);
});

test('shorthand cannot certify absence or zero for any payer and exact names only is a working flip', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One'); identity(f, 'Payer Two', 'payer-two');
  f.add('receipt', 'Payer One payment', null);
  const green = await f.ask(payment); reached(f, green); assert.equal(green.ledger.found, true);
  for (const q of [payment, income]) {
    unknown(f, await f.ask(q.replace('?', ', exact names only?')));
    unknown(f, await f.ask(q.replace('Payer One', 'Payer Two')));
  }
  unknown(f, await f.ask('Did the payment of $26.00 from Payer One arrive in October 2026?'));
  for (const description of ['Payer One payment Services', 'Payer One payment payment', 'Payer One mystery', 'FROM: Payer One payment']) {
    f.raw('UPDATE fin_transactions SET description=?', description);
    for (const q of [payment, income]) unknown(f, await f.ask(q));
    const amount = await f.ask(amountOnly); reached(f, amount); assert.equal(amount.ledger.found, true);
  }
  f.raw("UPDATE fin_transactions SET description='Payer One payment',amount_minor=0");
  const zero = await f.ask(income); reached(f, zero);
  assert.equal(zero.ledger.total_minor, null); assert.equal(zero.evidence_gate.complete, false);
  f.raw("UPDATE fin_transactions SET description='FROM: Payer One',amount_minor=2500");
  for (const q of [payment, income]) {
    const exact = await f.ask(q.replace('?', ', exact names only?')); reached(f, exact);
    assert.equal(exact.evidence_gate.complete, true); assert.equal(exact.assumptions, undefined);
  }
});

test('shorthand render paths aggregate only dependent rows and mask all dynamic note fields', async t => {
  const f = ledgerFixture(t), label = 'Supplier AB48CD26EF17GH03'; identity(f, label);
  f.raw("UPDATE fin_entities SET display_label='Payer One' WHERE entity_slug='payer-one'");
  f.add('one', `${label} payment`, null);
  f.add('two', `${label} payment`, null, { cents: 3500 });
  f.add('exact', 'FROM: Payer One', null, { cents: 500 });
  for (const partial of [false, true]) {
    if (partial) f.add('unknown', 'Unregistered Sender', null);
    for (const q of [payment, income]) {
      const body = await f.ask(q); reached(f, body);
      assert.equal(body.ledger.found, true);
      assert.equal(body.evidence_gate.complete, !partial);
      if (q === income) assert.equal(partial ? body.ledger.attributed_subtotal_minor : body.ledger.total_minor, 6500);
      if (partial && q === income) {
        assert.equal(body.ledger.confirmed_subtotal_minor, 500);
        assert.equal(body.ledger.confirmed_citations.length, 1);
      }
      shorthandNote(body, { label, count: 2, amount: 6000 });
      assert.match(body.answer, /2 rows totaling \$60\.00/);
      assert.ok(!JSON.stringify(body).includes('AB48CD26EF17GH03'));
    }
  }
});

test('shorthand notes coexist with transfer notes without certifying a zero for the payer', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One');
  f.add('receipt', 'Payer One payment', null);
  const green = await f.ask(income); reached(f, green); assert.equal(green.ledger.total_minor, 2500);
  f.raw("UPDATE fin_transactions SET category='TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',category_basis_state='proposed'");
  const body = await f.ask(income); reached(f, body);
  assert.equal(body.ledger.total_minor, 2500);
  assert.equal(body.ledger.lead_total_minor, null, 'shorthand cannot certify a zero lead total for its payer');
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /including withdrawals/);
  assert.doesNotMatch(body.answer, /for [^;\n]+: \$0\.00/);
  shorthandNote(body);
  const included = await f.ask(income.replace('?', ', including withdrawals?')); reached(f, included);
  assert.equal(included.ledger.lead_total_minor, 2500); assert.equal(included.evidence_gate.complete, true);
  shorthandNote(included);
  f.raw('UPDATE fin_transactions SET category=NULL,category_basis_state=NULL');
  f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('reserve','owner','savings','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('reserve','complete','2024-01-01','2026-10-12',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.add('outgoing', 'Transfer to account 1234', null, { direction: 'outflow' });
  f.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='outgoing'");
  const conditional = await f.ask(income); reached(f, conditional);
  assert.equal(conditional.ledger.candidate_transfer_count, 1, 'conditional exclusion decision reached');
  assert.equal(conditional.ledger.total_minor, 2500);
  assert.equal(conditional.ledger.if_own_transfers.total_minor, null);
  assert.equal(conditional.ledger.groups[0].if_own_transfers_total_minor, null);
  assert.equal(conditional.evidence_gate.complete, false);
  shorthandNote(conditional);
});

for (const format of ['bare', 'labelled', 'payee']) test(`generated shorthand premise format ${format}`, async t => {
  const f = ledgerFixture(t); identity(f, 'Unrelated Supplier', 'unrelated');
  f.add('receipt', 'Receipt', null);
  const stats = { format, generated: 0, answered: 0, answered_with_assumption: 0, unknown: 0 };
  for (const suffix of ['payment', 'ACH deposit', 'payroll']) for (const registration of ['shorter', 'both', 'longer']) {
    const shorter = 'Payer One', longer = `${shorter} ${suffix}`;
    f.raw("DELETE FROM fin_entities WHERE entity_slug IN ('shorter','longer')");
    if (registration !== 'longer') identity(f, shorter, 'shorter');
    if (registration !== 'shorter') identity(f, longer, 'longer');
    f.raw('UPDATE fin_transactions SET description=?,payee=?', format === 'labelled' ? `FROM: ${longer}` : longer,
      format === 'payee' ? longer : null);
    for (const label of [shorter, longer, 'Unrelated Supplier']) for (const q of [payment, income]) {
      const before = f.calls.length;
      const body = await f.ask(q.replace('Payer One', label)); reached(f, body);
      assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
      stats.generated++;
      if (body.evidence_gate.complete) stats.answered++; else stats.unknown++;
      if (body.assumptions?.length) stats.answered_with_assumption++;
      const assumed = format === 'bare' && registration === 'shorter' && label === shorter;
      const uncertain = format === 'bare' ? registration === 'both' || (registration === 'shorter' && label !== shorter)
        : registration === 'shorter';
      if (uncertain) unknown(f, body);
      else {
        const present = assumed || (registration !== 'shorter' && label === longer);
        assert.equal(body.evidence_gate.complete, true);
        assert.equal(q === payment ? body.ledger.found : body.ledger.total_minor, q === payment ? present : present ? 2500 : 0);
        if (assumed) shorthandNote(body, { suffix: suffix.toLowerCase() });
        else assert.equal(body.assumptions, undefined);
      }
    }
    const control = await f.ask(amountOnly); reached(f, control); assert.equal(control.ledger.found, true);
  }
  assert.ok(stats.answered > 0 && stats.unknown > 0, 'uniform outcomes invalidate the premise harness');
  t.diagnostic(JSON.stringify({ shorthand_property: stats }));
});

test('unregistered labels stay unknown; independently confirmed exact identities permit presence and absence', async t => {
  const f = ledgerFixture(t);
  identity(f, 'Payer One'); identity(f, 'Payer Two', 'payer-two');
  f.add('receipt', 'Receipt', 'Payer One');
  const present = await f.ask(payment); reached(f, present);
  assert.equal(present.ledger.found, true);
  assert.equal((await f.ask(income)).ledger.total_minor, 2500);
  f.raw("UPDATE fin_transactions SET payee='Payer Two'");
  const absent = await f.ask(payment); reached(f, absent);
  assert.equal(absent.ledger.found, false);
  assert.equal((await f.ask(income)).ledger.total_minor, 0);
  f.raw("UPDATE fin_transactions SET payee='Unregistered Supplier'");
  unknown(f, await f.ask(payment)); unknown(f, await f.ask(income));
});

test('seeded arbitrary metadata cannot authorize absence or zero in either sender field', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One'); identity(f, 'Payer Two', 'payer-two');
  f.add('receipt', 'Receipt', 'Payer Two');
  const control = await f.ask(payment); reached(f, control);
  assert.equal(control.ledger.found, false);
  const next = random(418), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let i = 0; i < 128; i++) {
    const token = Array.from({ length: 5 + Math.floor(next() * 35) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
    const text = [token, `CCD reference ${token}`, `ACH credit from Unknown Payer One ${token}`, `Unknown from Payer One ${token}`][i % 4];
    f.raw('UPDATE fin_transactions SET payee=?,description=?', i % 2 ? text : null, text);
    unknown(f, await f.ask(payment)); unknown(f, await f.ask(income));
    const amount = await f.ask(amountOnly); reached(f, amount);
    assert.equal(amount.ledger.found, true, 'same receipt remains an amount-only positive control');
  }
});

test('proposed, superseded, cross-tenant and ambiguous identities never establish a payer', async t => {
  for (const arm of ['proposed', 'superseded', 'tenant', 'ambiguous']) {
    const f = ledgerFixture(t); identity(f, 'Payer One');
    f.add('receipt', 'Receipt', 'Payer One');
    const green = await f.ask(payment); reached(f, green);
    assert.equal(green.ledger.found, true);
    if (arm === 'proposed') f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='payer-one'");
    if (arm === 'superseded') f.raw("UPDATE fin_entities SET superseded_by_id=999 WHERE entity_slug='payer-one'");
    if (arm === 'tenant') f.raw("UPDATE fin_entities SET tenant_id='other' WHERE entity_slug='payer-one'");
    if (arm === 'ambiguous') identity(f, 'PAYER ONE', 'duplicate-payer');
    unknown(f, await f.ask(payment)); unknown(f, await f.ask(income));
  }
});

test('seeded mixed windows certify absence only after every payer resolves', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer Two', 'payer-two');
  const next = random(420);
  for (let round = 0; round < 32; round++) {
    f.raw('DELETE FROM fin_transactions');
    const count = 2 + Math.floor(next() * 6);
    for (let i = 0; i < count; i++) f.add(`receipt-${i}`, 'Receipt', 'Payer Two');
    const known = await f.ask(payment); reached(f, known);
    assert.equal(known.ledger.found, false); assert.equal(known.evidence_gate.complete, true);
    assert.equal((await f.ask(income)).ledger.total_minor, 0);
    const unknownCount = 1 + Math.floor(next() * count);
    for (let i = 0; i < unknownCount; i++) f.raw('UPDATE fin_transactions SET payee=? WHERE txn_uid=?',
      `Bank metadata ${Math.floor(next() * 2 ** 32).toString(36)}`, `receipt-${i}`);
    for (const question of [payment, income]) {
      const body = await f.ask(question); reached(f, body);
      assert.equal(body.ledger.found, null); assert.equal(body.evidence_gate.complete, false);
      assert.equal(body.ledger.unattributed_count, unknownCount);
      assert.equal(body.citations.length, unknownCount);
      assert.doesNotMatch(body.answer, /no matching|\$0\.00/i);
      if (question === income) assert.equal(body.ledger.total_minor, null);
    }
  }
});

test('identity read failure and overflow refuse after the real snapshot decision', async t => {
  for (const arm of ['read-failure', 'overflow']) {
    const f = ledgerFixture(t); identity(f, 'Payer One'); f.add('receipt', 'Receipt', 'Payer One');
    const green = await f.ask(payment); reached(f, green); assert.equal(green.ledger.found, true);
    const original = f.env.DB.batch;
    let attempts = 0;
    f.env.DB.batch = async statements => {
      const results = await original(statements);
      if (statements.some(statement => /SELECT entity_slug,legal_name,display_label/.test(statement.sql))) {
        attempts++;
        if (arm === 'read-failure') throw new Error('synthetic identity read failure');
      }
      return results;
    };
    if (arm === 'overflow') f.raw(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5001)
      INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
      SELECT 'extra-'||i,'Extra '||i,'business','counterparty','owner_stated','confirmed',? FROM n`, NOW);
    const refused = await f.ask(payment);
    assert.equal(attempts, 1, 'identity query executed alongside a nonempty receipt snapshot');
    assert.equal(refused.ledger, undefined);
    assert.equal(refused.gaps[0].reason, 'ledger_unavailable');
    assert.equal(f.documentCalls, 1);
  }
});

test('every inflow in the selected window gates named absence, including other exact amounts', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer Two', 'payer-two');
  f.add('receipt', 'Receipt', 'Payer Two');
  const question = 'Did the payment of $26.00 from Payer One arrive in October 2026?';
  const green = await f.ask(question); reached(f, green);
  assert.equal(green.ledger.found, false);
  f.raw("UPDATE fin_transactions SET payee='Unregistered Supplier'");
  unknown(f, await f.ask(question));
  const amount = await f.ask(amountOnly); reached(f, amount);
  assert.equal(amount.ledger.found, true);
});

test('exact identity comparison preserves conjunctions and rejects token and prefix matches', async t => {
  const f = ledgerFixture(t);
  identity(f, 'Tools & Supply'); identity(f, 'Tools Supply', 'plain-payer');
  f.add('receipt', 'Receipt', 'Tools & Supply');
  const exact = await f.ask('Did the payment from Tools & Supply arrive in October 2026?'); reached(f, exact);
  assert.equal(exact.ledger.found, true);
  const other = await f.ask('Did the payment from Tools Supply arrive in October 2026?'); reached(f, other);
  assert.equal(other.ledger.found, false);
  f.raw("UPDATE fin_transactions SET payee='Tools & Supply Extra'");
  unknown(f, await f.ask('Did the payment from Tools & Supply arrive in October 2026?'));
});

test('generic render masking removes arbitrary long runs, including letters and separators', async t => {
  const f = ledgerFixture(t); f.add('receipt', 'A B', null);
  const control = await f.ask(amountOnly); reached(f, control);
  assert.match(control.answer, /: A B \[1\]/);
  const next = random(419), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const separators = ['', '.', '-', '/', ' ', '_', '+', '=', '\u200b'];
  for (let i = 0; i < 128; i++) {
    const raw = Array.from({ length: 5 + Math.floor(next() * 60) }, () => alphabet[Math.floor(next() * (i % 2 ? alphabet.length : 26))]).join('');
    const token = raw.match(/.{1,3}/g).join(separators[i % separators.length]);
    const description = `${['', 'A/C ', 'reference: ', 'account '][i % 4]}${token}`;
    f.raw('UPDATE fin_transactions SET description=?,payee=?', description, description);
    const body = await f.ask(amountOnly); reached(f, body);
    assert.equal(body.citations[0].amount_minor, 2500);
    assert.equal(body.citations[0].posted_on, '2026-10-05');
    assert.ok(!JSON.stringify(body).includes(token), 'the raw identifier cannot survive in any response field');
    const field = body.answer.match(/: (.*?) \[1\]/)[1];
    assert.ok(field.includes(`****${raw.slice(-4)}`), 'only the final four identifier characters remain');
    assert.doesNotMatch(field.replaceAll('[redacted]', ''), /[\p{L}\p{N}](?:[\s._/-]*[\p{L}\p{N}]){4}/u);
    const list = await f.ask('Show my deposits in October 2026'); reached(f, list);
    assert.equal(list.ledger.rows[0].description, field, 'structured and prose candidates share the boundary');
    assert.ok(!JSON.stringify(list).includes(token));
  }
});

test('masking happens before truncation and treats Unicode letters and short labels conservatively', () => {
  assert.equal(maskLedgerCandidateField('AB12'), 'AB12', 'four-character control');
  for (const value of ['reference ABCD', 'A/C: ABCD', 'ABCD'.repeat(1000), 'ＡＢＣＤＥＦＧＨ', '甲乙丙丁戊己庚辛']) {
    const normalized = value.normalize('NFKC').match(/[\p{L}\p{N}]/gu);
    const masked = maskLedgerCandidateField(value);
    assert.equal(masked, `[redacted] ****${normalized.slice(-4).join('')}`);
    assert.ok(masked.length < 240);
  }
});

test('ambiguous requested aliases and complete statement labels stay unknown with candidates', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One'); identity(f, 'Payer Two', 'payer-two');
  f.add('receipt', 'Payer One payment', 'Payer One');
  f.raw("UPDATE fin_entities SET display_label='Shared Supplier' WHERE entity_slug='payer-one'");
  const questions = [payment, income].map(q => q.replace('Payer One', 'Shared Supplier'));
  for (const q of questions) {
    const green = await f.ask(q); reached(f, green); assert.equal(green.evidence_gate.complete, true);
    assert.equal(green.ledger.kind === 'payment' ? green.ledger.found : green.ledger.total_minor,
      green.ledger.kind === 'payment' ? true : 2500);
  }
  f.raw("UPDATE fin_entities SET display_label='Shared Supplier' WHERE entity_slug='payer-two'");
  for (const q of questions) { const body = await f.ask(q); unknown(f, body); assert.match(body.answer, /ambiguous|more than one/i); }
  identity(f, 'Alternate Supplier', 'third'); identity(f, 'Fourth Supplier', 'fourth');
  f.raw("UPDATE fin_entities SET display_label='Payer Two payment' WHERE entity_slug IN ('third','fourth')");
  f.raw("UPDATE fin_transactions SET payee=NULL,description='Payer Two payment'");
  for (const name of ['Alternate Supplier', 'Payer Two']) for (const q of [payment, income])
    unknown(f, await f.ask(q.replace('Payer One', name)));
  // A collision in the extracted field is also terminal, even when stripping
  // its suffix would yield a different unique legal name.
  f.raw("UPDATE fin_transactions SET description='WIRE FROM Payer Two payment'");
  for (const q of [payment, income]) unknown(f, await f.ask(q.replace('Payer One', 'Payer Two')));
  f.raw("UPDATE fin_entities SET display_label='Payer Two for invoice' WHERE entity_slug IN ('third','fourth')");
  f.raw("UPDATE fin_transactions SET description='WIRE FROM Payer Two for invoice'");
  for (const q of [payment, income]) unknown(f, await f.ask(q.replace('Payer One', 'Payer Two')));
  const amount = await f.ask(amountOnly); reached(f, amount); assert.equal(amount.ledger.found, true);
  f.raw('DELETE FROM fin_transactions');
  const before = f.calls.length;
  const empty = await f.ask(questions[0]);
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'empty snapshot inspected');
  assert.equal(empty.ledger.found, null, 'empty receipts cannot choose between colliding identities');
  assert.equal(empty.evidence_gate.complete, false);
});

test('usefulness: explicit synthetic bank originators answer both payment and income', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One'); identity(f, 'Payer Two', 'payer-two');
  f.raw("UPDATE fin_entities SET display_label='Supplier Alias' WHERE entity_slug='payer-one'");
  f.add('receipt', 'Payer One', null);
  let answered = 0, answeredWithAssumption = 0, cannotConfirm = 0;
  for (const description of explicitStatements) {
    f.raw('UPDATE fin_transactions SET description=?', description);
    for (const q of [payment, income]) {
      const body = await f.ask(q); reached(f, body);
      if (body.evidence_gate.complete && (q === payment ? body.ledger.found === true : body.ledger.total_minor === 2500)) answered++;
      else cannotConfirm++;
      if (body.assumptions?.length) {
        answeredWithAssumption++;
        shorthandNote(body, { suffix: description.slice('Payer One '.length).toLowerCase() });
      }
    }
  }
  t.diagnostic(JSON.stringify({ statements: explicitStatements.length, answered, answered_with_assumption: answeredWithAssumption, cannot_confirm: cannotConfirm }));
  // The original LF statement uses a field boundary, like the other explicit
  // forms. Only the three shorthand forms need notes in both answer kinds.
  assert.equal(answered, 48); assert.equal(cannotConfirm, 0);
  assert.equal(answeredWithAssumption, 6);
  f.raw("UPDATE fin_transactions SET description='ACH CREDIT ORIG CO NAME: Payer Two ORIG ID: 4826170392'");
  const other = await f.ask(payment); reached(f, other); assert.equal(other.ledger.found, false);
  assert.equal((await f.ask(income)).ledger.total_minor, 0);
});

test('explicit originator extraction rejects unknown, conflicting and ambiguous fields', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One'); identity(f, 'Payer Two', 'payer-two');
  f.add('receipt', 'FROM: Payer One', null);
  const green = await f.ask(payment); reached(f, green); assert.equal(green.ledger.found, true);
  for (const description of [
    'ACH CREDIT ORIG CO NAME: Unknown Payer One ORIG ID: 4826170392',
    'Memo ORIGINATOR: Payer One', 'Processor settlement for Payer One invoice',
    'WIRE ORIGINATOR: Payer Two FROM: Payer One',
    'WIRE FROM: Payer One ORIGINATOR: Payer Two',
    'WIRE ORIGINATOR: Payer One; ORIGINATOR: Payer Two',
    'ACH CREDIT ORIG CO NAME: Payer One Extra ORIG ID: 4826170392',
  ]) {
    f.raw('UPDATE fin_transactions SET description=?', description);
    for (const q of [payment, income]) unknown(f, await f.ask(q));
    const amount = await f.ask(amountOnly); reached(f, amount); assert.equal(amount.ledger.found, true);
  }
  f.raw("UPDATE fin_entities SET display_label='Shared Supplier' WHERE entity_slug IN ('payer-one','payer-two')");
  f.raw("UPDATE fin_transactions SET description='ACH CREDIT ORIG CO NAME: Shared Supplier ORIG ID: 4826170392'");
  for (const q of [payment, income]) unknown(f, await f.ask(q));
});

test('render inventory: every ledger answer kind and refusal keeps identifiers behind one boundary', async t => {
  const token = 'AB4826CD1703EF9258';
  const f = ledgerFixture(t); identity(f, 'Payer One');
  f.add('receipt', 'AB12', 'Payer One');
  const green = await f.ask(payment); reached(f, green); assert.match(green.answer, /AB12/);
  f.raw('UPDATE fin_transactions SET description=?', token);
  f.add('expense-one', token, token, { direction: 'outflow', date: '2026-08-05' });
  f.add('expense-two', token, token, { direction: 'outflow', date: '2026-09-05' });
  f.add('expense-three', token, token, { direction: 'outflow' });
  f.raw('UPDATE fin_transactions SET category=?,category_basis_state=\'confirmed\'', token);
  const kinds = new Set();
  for (const [kind, question] of [
    ['balance', 'What is my balance?'], ['totals', 'How much money came in October 2026?'],
    ['payment', payment], ['deposits', 'Show my deposits in October 2026'],
    ['largest', 'What were my largest expenses in October 2026?'],
    ['merchant', 'Show income by merchant in October 2026'],
    ['category', 'Show spend by category in October 2026'],
    ['recurring', 'What recurring subscriptions am I paying for, and how much per month?'],
    ['transfers', 'How much did I transfer between my own accounts in October 2026?'],
  ]) {
    const body = await f.ask(question);
    assert.equal(body.ledger?.kind, kind, `${kind} renderer reached`); kinds.add(kind);
    assert.equal(f.documentCalls, 0);
    assert.ok(!JSON.stringify(body).includes(token), `${kind} text and structured fields`);
    if (['payment','deposits','largest','merchant','category','recurring'].includes(kind)) {
      assert.ok(body.citations.length > 0); assert.match(body.answer, /\[redacted\]/);
    }
  }
  assert.equal(kinds.size, 9, 'complete classifier kind inventory');
  f.raw("UPDATE fin_transactions SET payee=NULL WHERE direction='inflow'");
  unknown(f, await f.ask(payment)); unknown(f, await f.ask(income));
  // Both successful and refused coverage/citation renderers must validate
  // structured date slots instead of trusting arbitrary stored text.
  f.raw('UPDATE bank_feed_items SET last_synced_at=?', token);
  const sync = await f.ask(amountOnly); reached(f, sync);
  assert.ok(!JSON.stringify(sync).includes(token), 'sync metadata boundary');
  f.raw("UPDATE fin_account_coverage SET coverage_status='partial',covered_to='2026-99-99'");
  const coverage = await f.ask(payment);
  assert.equal(coverage.gaps[0].reason, 'period_outside_coverage');
  assert.equal(coverage.gaps[0].accounts[0].covered_to, null);
  assert.ok(!JSON.stringify(coverage).includes(token), 'coverage refusal boundary');
  f.raw("UPDATE fin_account_coverage SET coverage_status='complete',covered_to='2026-10-12'");
  f.raw('UPDATE fin_accounts SET institution=?', token);
  f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,institution,provenance,basis_state,recorded_at)
    VALUES (?,'owner','checking','asset','1234','manual',?,'owner_stated','confirmed',?)`, token.toLowerCase(), token, NOW);
  const linked = await f.ask(payment);
  assert.equal(linked.code, 'ledger_account_link_required');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n, 2, 'link decision has a real pair');
  assert.ok(!JSON.stringify(linked).toLowerCase().includes(token.toLowerCase()), 'institution and slug refusal boundary');
  assert.match(linked.gaps[0].detail, /\[redacted\]/);
});

test('render inventory: paired, excluded, conditional and unmatched transfer rows are nonempty and masked', async t => {
  const f = ledgerFixture(t), token = 'AB4826CD1703EF9258';
  f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,label,provenance,basis_state,recorded_at)
    VALUES ('reserve','owner','savings','asset','5678','manual',?,'owner_stated','confirmed',?)`, token, NOW);
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('reserve','complete','2026-01-01','2026-10-12',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.add('outgoing', `transfer to ${token}`, null, { direction: 'outflow', cents: 3000 });
  f.raw(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
    VALUES ('incoming','reserve','2026-10-05',3000,'inflow','transfer from account 1234','owner_stated','confirmed',?)`, NOW);
  f.add('unmatched', `transfer to account 8888 ref ${token}`, null, { direction: 'outflow', cents: 4000 });
  for (const [question, excluded] of [
    ['How much money came in October 2026?', true],
    ['How much money came in October 2026 including transfers, including withdrawals?', false],
    ['How much did I transfer between my own accounts in October 2026?', false],
  ]) {
    const body = await f.ask(question); reached(f, body);
    assert.equal(body.ledger.transfers.length, 1, 'actual pair renderer reached');
    assert.equal(body.ledger.transfers[0].excluded_from_lead, excluded);
    assert.equal(body.ledger.unmatched_transfers.length, 1, 'unmatched renderer reached');
    assert.equal(body.ledger.transfers[0].outgoing.description, maskLedgerCandidateField(`transfer to ${token}`));
    assert.ok(body.citations.length >= 3);
    assert.ok(!JSON.stringify(body).includes(token));
    if (excluded) assert.match(body.answer, /left out of the first figures/);
    else assert.match(body.answer, /If these are transfers/);
  }
  f.raw('UPDATE fin_transactions SET description=? WHERE txn_uid=\'outgoing\'', `transfer to account 5678 memo ${token}`);
  const kept = await f.ask('How much money came in October 2026?'); reached(f, kept);
  assert.equal(kept.ledger.transfers.length, 1);
  assert.equal(kept.ledger.transfers[0].excluded_from_lead, false);
  assert.match(kept.answer, /Kept pairs:/);
  assert.ok(!JSON.stringify(kept).includes(token));
});

test('render inventory: fixed refusals and fallback gap paths do not echo free-text metadata', async t => {
  const token = 'AB4826CD1703EF9258';
  const arms = [
    ['cash_flow_unsupported', () => {}, 'What was my cash flow in October 2026?'],
    ['merchant_selector_unsupported', () => {}, 'How much did I spend at [redacted] in October 2026?'],
    ['merchant_selector_ambiguous', f => f.raw("UPDATE fin_transactions SET direction='outflow',payee='Tools & Supply'"), 'How much did I spend at Tools and Supply in October 2026?'],
    ['coverage_review_required', f => f.raw("UPDATE fin_account_coverage SET basis_note='Read from a bank export covering unproven days'")],
    ['bank_export_overlap_review_required', f => {
      f.raw("UPDATE fin_transactions SET provenance='extracted',source_doc_uid='synthetic-export',external_id='external-one'");
      f.add('overlap', token, null);
      f.raw("UPDATE fin_transactions SET provenance='extracted',source_doc_uid='synthetic-export' WHERE txn_uid='overlap'");
    }],
    ['period_outside_coverage', f => f.raw("UPDATE fin_account_coverage SET coverage_status='partial'")],
    ['balance_unavailable', f => f.raw("UPDATE fin_balance_snapshots SET as_of_date='2026-99-99'"), 'What is my balance?'],
    ['unreadable_transactions', f => f.raw("UPDATE fin_transactions SET currency='EUR'")],
    ['unsupported_currency', f => f.raw("UPDATE fin_accounts SET currency='EUR'")],
    ['ambiguous_account', f => f.raw("UPDATE fin_accounts SET basis_state='proposed'")],
    ['no_accounts', f => f.raw("UPDATE fin_entities SET relationship='counterparty' WHERE entity_slug='owner'")],
    ['ledger_unavailable', f => { f.env.DB.batch = async () => { throw new Error('synthetic unavailable'); }; }],
    ['retrieval_scope_restricted', () => {}, payment, { access: { fixture: true } }],
    ['unsupported_question', () => {}, payment, { ledgerEligible: false }],
  ];
  for (const [reason, mutate, question = payment, extra = {}] of arms) {
    const f = ledgerFixture(t); identity(f, 'Payer One'); f.add('receipt', token, 'Payer One');
    const green = await f.ask(payment); reached(f, green); assert.equal(green.ledger.found, true);
    f.raw('UPDATE bank_feed_items SET last_synced_at=?', token);
    f.raw('UPDATE fin_accounts SET institution=?,label=?', token, token);
    mutate(f);
    const before = f.calls.length; let fallback = 0;
    const body = await (await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW),
      grantScope: { all: true }, scopePrincipalKind: 'owner', ...extra }, async gap => {
      fallback++; assert.equal(gap.reason, reason, 'fallback received exact refusal');
      return Response.json({ answer: null, gaps: [] });
    })).json();
    assert.equal(body.gaps[0].reason, reason, 'exact refusal decision reached');
    assert.equal(body.ledger, undefined);
    assert.ok(body.code === reason || fallback === 1, 'direct refusal or fallback render path reached');
    if (!Object.keys(extra).length) assert.ok(f.calls.slice(before).some(sql => /FROM fin_accounts a/.test(sql)), 'inventory read reached');
    assert.ok(!JSON.stringify(body).includes(token), reason);
  }
  t.diagnostic(JSON.stringify({ refusal_paths: arms.length, link_refusal_in_separate_test: true }));
});

// Enumerate grammar words as identity data, independently of production parsing.
// Each format crosses both field lengths, all three registration states, and
// both questions about each identity plus a confirmed unrelated payer.
for (const [formatIndex, format] of originatorFormats.entries()) {
  test(`generated originator structure format ${formatIndex + 1}`, async t => {
    const f = ledgerFixture(t);
    let external = 0;
    t.mock.method(globalThis, 'fetch', async () => { external++; throw new Error('network forbidden'); });
    t.after(() => assert.equal(external, 0));
    identity(f, 'Unrelated Supplier', 'unrelated');
    f.add('receipt', 'Receipt', null);
    const stats = { format: formatIndex + 1, generated: 0, answered: 0, answered_with_assumption: 0, unknown: 0,
      ambiguous_shorthand: 0, descriptions: 0, fully_parsed: 0, expected_answered: 0, violations: 0 };
    const failures = [];
    const shorter = 'Synthetic Supplier';
    const identifier = ['AB48', 'CD26', 'EF17', 'GH03'].join('');
    const longerLabels = originatorWords.flatMap(word => [
      `${shorter} ${word} Services LLC`, `${word} ${shorter} LLC`, `${shorter} Services ${word} ${identifier} LLC`,
    ]);
    for (const [labelIndex, longer] of longerLabels.entries()) {
      for (const registration of ['shorter', 'both', 'longer']) {
        f.raw("DELETE FROM fin_entities WHERE entity_slug IN ('shorter','longer')");
        if (registration !== 'longer') identity(f, shorter, 'shorter');
        if (registration !== 'shorter') identity(f, longer, 'longer');
        // Query stable independent aliases so this suite measures the statement
        // parser, without invoking unrelated natural-language name ambiguities.
        f.raw("UPDATE fin_entities SET display_label=CASE entity_slug WHEN 'shorter' THEN 'Short Supplier' ELSE 'Long Supplier' END WHERE entity_slug IN ('shorter','longer')");
        for (const field of [shorter, longer]) {
          const description = format.replace(/Payer One|Supplier Alias/, field);
          stats.descriptions++;
          if (attributeInflow({ description }, new Map()).evidence.parser.complete) stats.fully_parsed++;
          f.raw('UPDATE fin_transactions SET description=?', description);
          const registered = field === shorter ? registration !== 'longer' : registration !== 'shorter';
          // Every complete reading participates. An unregistered alternative
          // does not erase a unique registered shorthand reading. LF is a
          // field boundary in the same grammar as the printable delimiters.
          const ambiguous = false;
          const known = registered;
          for (const queryName of [shorter, longer, 'Unrelated Supplier']) {
            for (const question of [payment, income]) {
              stats.generated++;
              const canAnswer = known && (!(formatIndex >= 1 && formatIndex <= 3) || queryName === field);
              if (canAnswer) stats.expected_answered++;
              if (ambiguous) stats.ambiguous_shorthand++;
              const before = f.calls.length;
              const body = await f.ask(question.replace('Payer One', queryName === shorter ? 'Short Supplier' : queryName === longer ? 'Long Supplier' : queryName));
              // A refusal must inspect this nonempty snapshot, not a prior arm.
              assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
              reached(f, body);
              if (body.evidence_gate.complete) stats.answered++; else stats.unknown++;
              if (body.assumptions?.length) stats.answered_with_assumption++;
              try {
                const serialized = JSON.stringify(body);
                assert.ok(!serialized.includes(identifier), 'identifier inside the identity must not render');
                for (const identifier of description.match(/\d{5,}/g) || [])
                  assert.ok(!serialized.includes(identifier), 'full free-text identifier must not render');
                assert.equal(body.evidence_gate.complete, canAnswer, 'whole field authority or an explicit shorthand assumption is required');
                if (!canAnswer) unknown(f, body);
                else {
                  const match = queryName === field;
                  if (question === payment) assert.equal(body.ledger.found, match);
                  else assert.equal(body.ledger.total_minor, match ? 2500 : 0);
                  if (match) {
                    assert.equal(body.citations.length, 1);
                    assert.equal(body.citations[0].amount_minor, 2500);
                    if (formatIndex >= 1 && formatIndex <= 3) {
                      shorthandNote(body, { label: field, suffix: ['payment', 'ach deposit', 'payroll'][formatIndex - 1] });
                      assert.notEqual(body.ledger.found, false);
                      if (question === income) assert.ok(body.ledger.total_minor > 0);
                    } else assert.equal(body.assumptions, undefined, 'exact whole fields need no assumption');
                  }
                }
              } catch (error) {
                stats.violations++;
                if (failures.length < 5) failures.push({ labelIndex, registration,
                  field: field === shorter ? 'shorter' : 'longer',
                  query: queryName === shorter ? 'shorter' : queryName === longer ? 'longer' : 'unrelated',
                  kind: question === payment ? 'payment' : 'income', message: error.message });
              }
            }
          }
          const control = await f.ask(amountOnly); reached(f, control);
          assert.equal(control.ledger.found, true, 'same row is a green amount control');
        }
      }
    }
    t.diagnostic(JSON.stringify({ originator_property: stats }));
    assert.ok(stats.answered > 0 && stats.unknown > 0, 'uniform arms invalidate the harness');
    assert.equal(stats.fully_parsed, stats.descriptions, 'every original format consumes the complete statement');
    assert.equal(stats.violations, 0, JSON.stringify(failures));
    assert.equal(stats.answered, stats.expected_answered);
    assert.equal(stats.unknown, stats.generated - stats.expected_answered);
  });
}

test('sender structure: real repeated fields and uncertain segments stay unknown', async t => {
  const f = ledgerFixture(t); identity(f, 'Payer One'); identity(f, 'Payer Two', 'payer-two');
  f.add('receipt', 'WIRE FROM: Payer One; REF: 48261703', null);
  for (const q of [payment, income]) {
    const green = await f.ask(q); reached(f, green);
    assert.equal(green.evidence_gate.complete, true);
    assert.equal(q === payment ? green.ledger.found : green.ledger.total_minor, q === payment ? true : 2500);
  }
  f.raw("UPDATE fin_transactions SET description='WIRE FROM: Payer One; REF: 48261703; FROM: Payer One'");
  for (const q of [payment, income]) {
    const repeated = await f.ask(q); reached(f, repeated);
    assert.equal(repeated.evidence_gate.complete, true);
    assert.equal(q === payment ? repeated.ledger.found : repeated.ledger.total_minor, q === payment ? true : 2500);
  }
  for (const description of [
    'WIRE FROM: Payer One; REF: 48261703; FROM: Payer Two',
    'WIRE FROM: Payer One; REF: 48261703; BY: Payer Two',
    'WIRE FROM: Payer One; MEMO: text; ORIG CO NAME: Payer Two',
    'WIRE FROM: Payer One; TRACE#: 48261703; SENDER NAME: Payer Two',
    'WIRE FROM: Payer One; REF: 48261703; WIRE FROM Payer Two',
    'WIRE FROM: Payer One; REF: 48261703; BY Payer Two',
    'WIRE FROM: Payer One; UNKNOWN: Payer Two',
    'WIRE FROM: Payer One; Services LLC',
    'WIRE FROM: Payer One Reference Services LLC',
    'WIRE FROM: Payer One for invoice Services LLC',
    'WIRE FROM: Payer One ORIG ID 48261703',
    'WIRE FROM: Payer One payment',
    'WIRE FROM: Payer One reference 48261703; REF: 48261703',
    'WIRE FROM: Payer One for invoice 48261703; REF: 48261703',
    'WIRE FROM: Payer One reference 48261703',
    'WIRE FROM: Payer One for invoice 48261703',
  ]) {
    f.raw('UPDATE fin_transactions SET description=?', description);
    for (const q of [payment, income]) {
      const before = f.calls.length;
      const body = await f.ask(q);
      assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
      unknown(f, body);
    }
    const amount = await f.ask(amountOnly); reached(f, amount); assert.equal(amount.ledger.found, true);
  }
});
