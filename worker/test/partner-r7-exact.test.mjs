import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { payerQuestionGrammar } from '../src/lib/ledger-question.js';
import { productionCases } from './ledger-production-fixture.mjs';

// Independent amount grammar inventory: prefix/suffix, precision and grouping.
const amounts = ['400', '400.0', '400.00', '4,000', '4,000.0', '4,000.00']
  .flatMap(value => [`$${value}`, `USD ${value}`, `${value} dollar`, `${value} dollars`]);
const identity = (f, slug, name) => f.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES (?,?,'business','owned','owner_stated','confirmed',?)", slug, name, NOW);
async function reached(f, q) {
  const start = f.calls.length, writes = f.first('SELECT total_changes() n').n, docs = f.documentCalls;
  const b = await f.ask(q);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), q);
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0);
  assert.equal(f.first('SELECT total_changes() n').n, writes);
  assert.equal(f.documentCalls, docs);
  assert.ok(b.ledger, q);
  return b;
}
function possible(b) {
  assert.equal(b.evidence_gate.complete, false);
  assert.equal(b.ledger.total_is_exact, false);
  assert.equal(b.ledger.found, null);
  assert.equal(b.ledger.total_minor, null);
  assert.equal(b.ledger.subtotal_is_partial, true);
  assert.match(b.answer, /matched by name similarity, not an exact merchant\/payer name/);
  assert.match(b.answer, /exact names only/);
  assert.doesNotMatch(b.answer, /Found a deposit|No matching deposit|Total (?:spend|income)/i);
}
function shuffle(values, seed) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
// Partner ruling 10 (round 7, R5-MONEY-4): a shorter payee that is a
// trailing or inner whole-word run of the requested name ("May" beside
// "please May") is a possible match that blocks completeness. On the inflow
// side it is listed beside the exact receipt, whatever its amount, unless
// it is registered to an entity other than the one the question resolves
// to (both names registered). On the outflow side a $0 row cannot change the
// spend total (partner-r6-literals), so the exact answer stays complete.
// "Unit TOKEN Supply" has no contiguous shorter run ("Unit Supply").
for (const seed of [7, 41]) test(`R7 seeded exact selection invariant ${seed}`, async t => {
  const stats = { complete: 0, run: 0, possible: 0, refused: 0 };
  const f = ledgerFixture(t, { knownPayers: false });
  for (const token of shuffle([...payerQuestionGrammar.filler, ...amounts], seed)) {
    for (const boundary of ['Unit TOKEN Supply', 'TOKEN May', 'TOKEN Today', 'TOKEN From', 'TOKEN 2026-10-01', '(TOKEN Supply)', 'TOKEN Supply/']) {
      const full = boundary.replace('TOKEN', token), short = boundary.replace('TOKEN', '').replace(/\s+/g, ' ').trim();
      for (const registered of ['short', 'long', 'both', 'neither']) for (const direction of ['inflow', 'outflow']) {
        f.raw('DELETE FROM fin_transactions');
        f.raw("DELETE FROM fin_entities WHERE entity_slug IN ('short','long')");
        f.calls.length = 0;
        if (['short', 'both'].includes(registered)) identity(f, 'short', short);
        if (['long', 'both'].includes(registered)) identity(f, 'long', full);
        f.add('short', 'Opaque', short, { direction, cents: 0 });
        f.add('long', 'Opaque', full, { direction, cents: 53123 });
        f.add('control', 'Opaque', 'Control Unit', { direction, cents: 731 });
        const q = name => direction === 'inflow' ? `Did the payment from ${name} arrive in October 2026?`
          : `How much did I spend at ${name} in October 2026?`;
        const control = await reached(f, q('Control Unit'));
        assert.equal(control.ledger.found, true, q('Control Unit'));
        assert.equal(control.evidence_gate.complete, true);
        const exact = await reached(f, q(full));
        const run = direction === 'inflow' && boundary !== 'Unit TOKEN Supply' && registered !== 'both';
        assert.equal(exact.evidence_gate.complete, !run, q(full));
        assert.equal(exact.ledger.found, true);
        assert.deepEqual(exact.citations.map(c => c.amount_minor), run ? [53123, 0] : [53123]);
        if (run) {
          assert.equal(exact.ledger.unattributed_count, 1, q(full));
          assert.match(exact.answer, /\nUnattributed deposit: \$0\.00 posted [^\n]*\[2\]\./, q(full));
          stats.run++;
        } else {
          if (direction === 'outflow') assert.equal(exact.ledger.total_minor, 53123);
          stats.complete++;
        }
        // Removing the only exact field cannot promote cleanup or its zero.
        f.raw("UPDATE fin_transactions SET payee=NULL,description=? WHERE txn_uid='long'", `Other ${full} Outlet`);
        f.raw("DELETE FROM fin_entities WHERE entity_slug='long'");
        const weak = await reached(f, q(full));
        assert.equal(weak.evidence_gate.complete, false);
        assert.notEqual(weak.ledger.found, true);
        assert.equal(weak.ledger.total_minor, null);
        if (weak.ledger.subtotal_is_partial) { possible(weak); stats.possible++; }
        else stats.refused++;
        const missing = await reached(f, q('Missing Unit'));
        assert.equal(missing.evidence_gate.complete, false);
        assert.notEqual(missing.ledger.found, true);
        assert.equal(missing.ledger.total_minor ?? null, null);
        stats.refused++;
      }
    }
  }
  assert.equal(stats.complete + stats.run, 1736);
  assert.equal(stats.run, 558);
  assert.ok(stats.possible > 0 && stats.refused > 0, 'distinct evidence arms exercise different decisions');
  t.diagnostic(JSON.stringify(stats));
});

test('R7 description containment is possible; bounded exact fields count only equal rows', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('other', 'CARD PURCHASE AT Other Supply Outlet', null, { direction: 'outflow', cents: 40000 });
  possible(await reached(f, 'How much did I spend at Supply in October 2026?'));
  f.add('exact', 'Purchase', 'Supply', { direction: 'outflow', cents: 12300 });
  const b = await reached(f, 'How much did I spend at Supply in October 2026?');
  // Partner answer 1 (a): the containment row blocks completeness, as on the
  // inflow side. The exact row is a partial subtotal and the containment row
  // is listed as a possible match; no complete total, zero or absence.
  assert.equal(b.evidence_gate.complete, false);
  assert.equal(b.ledger.total_is_exact, false);
  assert.equal(b.ledger.total_minor, null);
  assert.equal(b.ledger.found, true);
  assert.equal(b.ledger.subtotal_is_partial, true);
  assert.equal(b.ledger.attributed_subtotal_minor, 12300);
  assert.equal(b.ledger.possible_subtotal_minor, 40000);
  assert.deepEqual(b.citations.map(c => c.amount_minor), [12300, 40000]);
  assert.match(b.answer, /Exact-name subtotal \(partial; before exclusions\): \$123\.00\./);
  assert.match(b.answer, /Exact match: \$123\.00 posted [^\n]*\[1\]\./);
  assert.match(b.answer, /Possible match: \$400\.00 posted [^\n]*\[2\]\./);
  assert.match(b.answer, /matched by name similarity, not an exact merchant\/payer name/);
  assert.doesNotMatch(b.answer, /Total (?:spend|income)|No matching/i);
  // "Exact names only" leaves the possible match out of the list, counts it,
  // and still certifies no complete total.
  const only = await reached(f, 'How much did I spend at Supply in October 2026, exact names only?');
  assert.equal(only.evidence_gate.complete, false);
  assert.equal(only.ledger.total_minor, null);
  assert.equal(only.ledger.found, true);
  assert.equal(only.ledger.attributed_subtotal_minor, 12300);
  assert.equal(only.ledger.possible_count, 1);
  assert.deepEqual(only.citations.map(c => c.amount_minor), [12300]);
  assert.match(only.answer, /Exact names only leaves out 1 possible match by name similarity, so no complete total or absence is confirmed\./);
  // Without the containment row the exact payee row alone is complete.
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='other'");
  const alone = await reached(f, 'How much did I spend at Supply in October 2026?');
  assert.equal(alone.evidence_gate.complete, true);
  assert.equal(alone.ledger.total_is_exact, true);
  assert.equal(alone.ledger.total_minor, 12300);
  assert.deepEqual(alone.citations.map(c => c.amount_minor), [12300]);
});

test('R7 exact structured payees and labelled senders retain forty complete useful answers', async t => {
  const stats = { complete: 0, possible: 0, refused: 0, wrong: 0 };
  const f = ledgerFixture(t, { knownPayers: false });
  const labelled = [];
  for (const [i, c] of productionCases.entries()) {
    // Preserve the production-shaped corpus and questions. Give its four
    // shorthand arms explicit sender fields to measure exact-only usefulness.
    const shorthand = !c.raw.merchant_name && c.raw.name.startsWith(c.payer + ' ');
    if (shorthand) labelled.push(i + 1);
    f.add(`receipt-${i}`, shorthand ? `FROM: ${c.payer}; REF: 123456` : c.raw.name,
      c.raw.merchant_name, { cents: c.cents });
  }
  assert.deepEqual(labelled, [2, 4, 32, 34]);
  for (const c of productionCases) {
    const b = await reached(f, c.question);
    if (b.evidence_gate.complete && b.ledger.found) stats.complete++;
    else if (b.ledger.subtotal_is_partial) stats.possible++;
    else stats.refused++;
    if (b.ledger.found && (!b.citations.some(ref => ref.amount_minor === c.cents) ||
      c.kind === 'merchant' && b.ledger.total_minor !== c.cents)) stats.wrong++;
  }
  t.diagnostic(JSON.stringify(stats));
  assert.deepEqual(stats, { complete: 40, possible: 0, refused: 0, wrong: 0 });
});

test('R7 possible-match notes reference only emitted citations in a bounded list', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  f.add('control', 'FROM: Control Unit', 'Control Unit', { cents: 731 });
  assert.equal((await reached(f, 'Did the payment from Control Unit arrive in October 2026?')).ledger.found, true);
  for (let i = 0; i < 12; i++) f.add(`possible-${i}`, 'Supplier Unit payment', null, { cents: 100 });
  const body = await reached(f, 'How much income came from Supplier Unit in October 2026?');
  possible(body);
  assert.equal(body.ledger.attributed_subtotal_minor, 1200);
  assert.equal(body.ledger.omitted_count, 2);
  assert.equal(body.citations.length, 10);
  assert.equal(body.assumptions[0].count, 12);
  assert.ok(body.assumptions[0].citations.every(n => Number.isInteger(n) && body.citations.some(c => c.n === n)));
  assert.equal(body.assumptions[0].citations.length, 10);
});
