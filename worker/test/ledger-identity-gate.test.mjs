import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { maskLedgerCandidateField } from '../src/lib/ledger-answer.js';

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
