import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { attributeInflow, payerRegistry } from '../src/lib/ledger-attribution.js';
import { boundaryReadingCases } from './ledger-attribution-cases.mjs';

for (const family of ['channel-prefix', 'company-comma', 'line-separator', 'expanded-label', 'registered-whole', 'unknown-prose']) {
  test(`generated boundary readings: ${family}`, () => {
    let cases = 0;
    for (const arm of boundaryReadingCases()) {
      if (arm.family !== family) continue;
      const registry = payerRegistry(arm.identities);
      const green = attributeInflow({ payee: arm.identities[0].legal_name }, registry);
      assert.equal(green.state, 'confirmed', 'independent identity has a positive control');
      const result = attributeInflow({ description: arm.description }, registry);
      assert.ok(result.evidence.parser.steps > 0, 'the complete-parser decision ran, including alphabet/value refusals');
      assert.equal(result.state, arm.state, JSON.stringify(arm));
      if (arm.state === 'confirmed') assert.equal(result.entity_slug, arm.slug || 'shorter');
      if (family === 'channel-prefix' && arm.state === 'assumed') assert.equal(result.reading.prefix, arm.prefix);
      for (const candidate of arm.candidates || []) assert.ok(result.evidence.candidates.includes(candidate), JSON.stringify(arm));
      cases++;
    }
    assert.ok(cases > 0);
  });
}

test('a bare sender clause and a whole registered name agree only when they resolve to the same entity', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('payer-one','Payer One','From Payer One','business','counterparty','owner_stated','confirmed',?)`, NOW);
  f.add('receipt', 'From Payer One', null);
  const questions = ['Did the payment from Payer One arrive in October 2026?',
    'How much income came from Payer One in October 2026?', 'Show income by merchant in October 2026?'];
  async function ask(q) {
    const before = f.calls.length, body = await f.ask(q);
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
    assert.equal(f.documentCalls, 0); assert.ok(body.ledger);
    return body;
  }
  for (const q of questions) {
    const green = await ask(q); assert.equal(green.evidence_gate.complete, true);
    assert.equal(green.ledger.kind === 'payment' ? green.ledger.found : green.ledger.total_minor, green.ledger.kind === 'payment' ? true : 2500);
  }
  f.raw("UPDATE fin_entities SET display_label=NULL WHERE entity_slug='payer-one'");
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('payer-two','From Payer One','business','counterparty','owner_stated','confirmed',?)`, NOW);
  for (const [i, q] of questions.entries()) {
    const body = await ask(q);
    if (i < 2) {
      assert.equal(body.ledger.found, null);
      assert.equal(body.evidence_gate.complete, false);
      if (i === 1) assert.equal(body.ledger.total_minor, null);
      assert.equal(body.ledger.payer_candidates.length, 2);
    } else {
      assert.equal(body.ledger.total_minor, 2500);
      assert.equal(body.ledger.groups[0].attribution_state, 'unknown');
      assert.equal(body.ledger.groups[0].payer_candidates.length, 1, 'masked labels can coincide without exposing the originals');
    }
  }
});
