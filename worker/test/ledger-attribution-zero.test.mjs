import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

test('a zero-valued confirmed row does not certify a payer zero when another receipt is assumed', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const [slug, label] of [['one', 'Payer One'], ['two', 'Payer Two']])
    f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
      VALUES (?,?,'business','counterparty','owner_stated','confirmed',?)`, slug, label, NOW);
  f.add('zero', 'FROM: Payer One', null, { cents: 0 });
  const named = 'How much income came from Payer One in October 2026?';
  const grouped = 'Show income by merchant in October 2026?';
  async function ask(q) {
    const before = f.calls.length, body = await f.ask(q);
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
    assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n);
    assert.equal(body.ledger?.kind, 'merchant');
    assert.equal(f.documentCalls, 0);
    return body;
  }
  assert.equal((await ask(named)).ledger.total_minor, 0, 'confirmed-scope green control');
  assert.equal((await ask(grouped)).ledger.groups[0].total_minor, 0);
  f.add('other', 'Payer Two payment', null, { cents: 500 });
  const partial = await ask(named);
  assert.equal(partial.ledger.total_minor, null);
  assert.equal(partial.ledger.confirmed_subtotal_minor, null, 'a subtotal must not be mistaken for a payer zero');
  assert.equal(partial.ledger.attributed_subtotal_minor, null);
  assert.equal(partial.ledger.unattributed_count, 1);
  for (const exact of [false, true]) {
    const body = await ask(grouped.replace('?', exact ? ', exact names only?' : '?'));
    assert.equal(body.ledger.total_minor, 500, 'overall money survives');
    assert.equal(body.ledger.inflow_total_minor, 500);
    assert.equal(body.ledger.groups[0].total_minor, null, 'the confirmed zero row cannot rule out the assumed receipt');
    assert.equal(body.ledger.groups[1].total_minor, 500);
    assert.equal(body.ledger.groups[1].attribution_state, exact ? 'unknown' : 'assumed');
    assert.equal(body.evidence_gate.complete, false);
  }
  f.raw("UPDATE fin_transactions SET amount_minor=200 WHERE txn_uid='zero'");
  const positive = await ask(named);
  assert.equal(positive.ledger.confirmed_subtotal_minor, 200, 'positive partial evidence remains useful');
  f.raw("UPDATE fin_transactions SET payee='Payer Two' WHERE txn_uid='other'");
  assert.equal((await ask(named)).ledger.total_minor, 200, 'confirmed other payer restores exactness');
});
