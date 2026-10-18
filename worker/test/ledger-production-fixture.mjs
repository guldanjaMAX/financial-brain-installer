import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { originatorFormats } from './ledger-attribution-cases.mjs';

export const productionCases = Array.from({ length: 40 }, (_, i) => {
  const payer = `Supplier Unit ${String(i + 1).padStart(2, '0')}`;
  const format = i % originatorFormats.length;
  // bank-feed maps merchant_name to payee, leaving it null when unavailable.
  const raw = { merchant_name: i % 2 ? null : payer,
    name: originatorFormats[format].replace(/Payer One|Supplier Alias/g, payer) };
  const cents = 2500 + i * 100;
  const kind = i % 4 < 2 ? 'payment' : 'merchant';
  return { payer, format, raw, cents, kind,
    question: kind === 'payment' ? `Did the payment from ${payer} arrive in October 2026?`
      : `How much income came from ${payer} in October 2026?` };
});

export function productionFixture(t, options = {}) {
  const f = ledgerFixture(t, { ...options, knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const [i, c] of productionCases.entries()) f.add(`production-${i}`, c.raw.name, c.raw.merchant_name || null, { cents: c.cents });
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE relationship!='owned'").n, 0);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_entities').n, 1);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE payee IS NULL').n, 20);
  assert.equal(new Set(productionCases.map(c => c.format)).size, 30);
  return f;
}

export async function reachedAnswer(f, question) {
  f.calls.length = 0;
  const before = f.first('SELECT total_changes() n').n;
  const body = await f.ask(question);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'real snapshot decision reached');
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 'decision has receipts');
  assert.equal(f.first('SELECT total_changes() n').n, before, 'question cannot register an identity or write');
  assert.equal(f.documentCalls, 0, 'no fallback can hide a refusal');
  assert.ok(body.ledger);
  return body;
}

export async function measureProduction(f) {
  const stats = { questions: 40, answered: 0, refused: 0, wrong: 0, rows: 40, formats: 30, empty_payees: 20 };
  for (const c of productionCases) {
    const b = await reachedAnswer(f, c.question);
    const matched = b.ledger.found === true;
    // Citations can include uncertain rows. Presence needs the exact receipt
    // and a matching positive amount; certified absence of this payer is wrong.
    const cited = b.citations.some(ref => ref.amount_minor === c.cents);
    const paymentAmounts = [...b.answer.matchAll(/^Found a deposit of \$([\d,]+\.\d{2}) posted /gm)]
      .map(m => Math.round(Number(m[1].replaceAll(',', '')) * 100));
    const amount = b.ledger.attributed_subtotal_minor ?? b.ledger.total_minor;
    if (matched && cited && (c.kind === 'payment' ? paymentAmounts.length === 1 && paymentAmounts[0] === c.cents : amount === c.cents)) stats.answered++;
    else if (b.ledger.found === null && amount == null) stats.refused++;
    else stats.wrong++;
  }
  return stats;
}
