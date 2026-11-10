import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';

// Finder, not golden answers: expected cents and membership never call product code.
const SEEDS = [1105, 427, 2604, 7301];
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
}
function generate() {
  const cases = [];
  for (const seed of SEEDS) {
    const next = random(seed);
    for (let i = 0; i < 160; i++) {
      const shape = i % 10, category = ['groceries', 'supplies', 'repairs', 'software'][(next() >>> 16) % 4];
      const row = (role, extra = {}) => ({ role, cents: String(1 + next() % 90000), category,
        state: 'confirmed', direction: 'outflow', description: 'Store purchase', payee: 'Store One', ...extra });
      const rows = [row('expense'), row('other', { category: 'travel', payee: category })];
      if (shape === 1) rows.push(row('unknown', { category: null, state: null }));
      if (shape === 2) rows.push(row('refund', { direction: 'inflow', description: 'Store refund' }));
      if (shape === 3) rows.push(row('deposit', { direction: 'inflow', description: 'Store deposit' }));
      if (shape === 4) rows.push(row('card', { description: 'Transfer to card 9876', payee: null }));
      if (shape === 5) rows.push(row('loan', { description: 'Transfer to loan 8765', payee: null }));
      if (shape === 6) rows[0].rename = 'household';
      if (shape === 7) rows.push(row('unknown', { state: 'proposed' }));
      if (shape === 8) rows.splice(0, 1); // category-looking merchant is not category evidence
      if (shape === 9) rows.push(row('unknown', { category: 'Uncategorized' }));
      cases.push({ seed, i, shape, category, rows, top: i % 4 === 0, net: shape === 2 || shape === 3 });
    }
  }
  return cases;
}

function expected(c) {
  const expenses = c.rows.filter(r => ['expense', 'other', 'unknown'].includes(r.role));
  const selected = expenses.filter(r => (r.rename || r.category) === c.category && r.state === 'confirmed');
  const refunds = c.rows.filter(r => r.role === 'refund' && r.direction === 'inflow' &&
    (r.rename || r.category) === c.category && r.state === 'confirmed');
  return { subtotal: total(selected.map(r => r.cents)),
    net: total([...selected.map(r => r.cents), ...refunds.map(r => `-${r.cents}`)]),
    gross: total(expenses.map(r => r.cents)),
    unknown: expenses.some(r => r.role === 'unknown'),
    groups: Object.fromEntries([...new Set(expenses.map(r => r.rename || r.category).filter(Boolean))]
      .map(label => [label, total(expenses.filter(r => (r.rename || r.category) === label).map(r => r.cents))])) };
}

test('seeded category spending finder: independent cents oracle and minimal witnesses', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.env.ANTHROPIC_API_KEY = 'fixture-not-a-key';
  for (const [kind, mask] of [['card', '9876'], ['loan', '8765']]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,'liability',?,'manual','owner_stated','confirmed',?)`, kind, kind, mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, kind, NOW, NOW);
  }
  let injected = 0;
  async function run(c) {
    f.raw('DELETE FROM fin_transactions');
    for (const [i, r] of c.rows.entries()) {
      f.add(`row-${i}`, r.description, r.payee, { cents: Number(r.cents), direction: r.direction });
      f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', r.category, r.state, `row-${i}`);
      if (r.rename) f.raw('UPDATE fin_transactions SET category=? WHERE txn_uid=?', r.rename, `row-${i}`);
    }
    const question = c.top ? 'Could you retrieve my top spending categories for October 2026?'
      : `Could you retrieve spending in the category ${c.category} for October 2026${c.net ? ' after refunds' : ''}?`;
    const before = injected;
    const changes = f.first('SELECT total_changes() AS n').n;
    const reads = f.calls.length;
    const response = await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW),
      grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
        injected++;
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
          kind: 'category', direction: 'outflow', count: null, vendor_text: c.top ? null : c.category,
          account_hint: null, amount_text: null, date_text: null, period: { type: 'between', from: '2026-10-01', to: '2026-10-31' },
        }] }) }] };
      } }, () => assert.fail('document fallback cannot answer money'));
    assert.equal(injected, before + 1, 'real extractor consumes injected reply');
    const body = await response.json();
    assert.ok(f.calls.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)), 'real ledger reader reached');
    assert.equal(f.first('SELECT total_changes() AS n').n, changes, 'answer is read-only');
    assert.ok(body.ledger, 'complete synthetic coverage reaches a ledger answer');
    return body;
  }
  function failures(c, b) {
    const e = expected(c), l = b.ledger || {}, result = [];
    const add = key => result.push(key);
    const amount = l.confirmed_category_subtotal_minor ?? l.total_minor;
    if (!c.top && e.unknown) {
      if (l.total_minor != null && !l.selector_unresolved) add('unknown-membership-total');
      const unknown = c.rows.filter(r => r.role === 'unknown');
      if (l.unconfirmed_category_count !== unknown.length || String(l.unsorted_minor) !== total(unknown.map(r => r.cents)) || !/left out/i.test(b.answer)) add('unconfirmed-rows-silently-dropped');
      if (l.confirmed_category_subtotal_minor != null && String(l.confirmed_category_subtotal_minor) !== e.subtotal) add('confirmed-subtotal');
    } else if (!c.top && !l.selector_unresolved && amount != null && String(amount) !== e.subtotal) add('category-membership');
    if (!c.top) for (const [pattern, fullTotal] of [
      [/^Category '[^']+': ([^\n]*)/m, true],
      [/^Confirmed in .+ \(subtotal\): ([^\n]*)/m, false],
    ]) {
      const claim = pattern.exec(b.answer || '');
      if (!claim) continue;
      if (fullTotal && e.unknown) add('unknown-membership-total');
      else if (displayFigures(claim[1])[0]?.cents !== e.subtotal) add('confirmed-subtotal');
    }
    for (const g of l.category_groups || []) {
      const want = e.groups[g.category];
      if (want !== undefined && String(g.total_minor) !== want) add('category-group-subtotal');
    }
    if (c.top) {
      if (l.total_minor != null && String(l.total_minor) !== e.gross) add('payment-in-spending');
    }
    if (c.net && !c.top && (l.net_expense_minor != null || !l.net_refunds_unavailable)) add('unproven-refund-netting');
    if (!c.top && e.unknown && /(?:Category '[^']+':|Total money out[^\n]*:) \$0\.00/.test(b.answer || '')) add('unknown-zero');
    return [...new Set(result)];
  }
  function overFailure(c, b) {
    if (failures(c, b).length) return null;
    if (!c.top && !expected(c).unknown) {
      if (!c.net && expected(c).subtotal !== '0' &&
        (b.ledger?.total_minor == null || b.ledger?.selector_unresolved)) return 'category-total-refusal';
    } else if (c.top && c.rows.length && !b.ledger?.category_groups?.length) return 'category-breakdown-refusal';
    return null;
  }
  async function shrink(c, predicate) {
    // Exhaustive subsets, cardinality first, establish minimum row count for
    // every failing input, including over-refusals, with fixed account inventory.
    let minimal;
    const subsets = Array.from({ length: 1 << c.rows.length }, (_, mask) => c.rows.filter((_, i) => mask & (1 << i)))
      .sort((a, b) => a.length - b.length);
    for (const rows of subsets) {
      const candidate = { ...c, rows };
      if (predicate(candidate, await run(candidate))) { minimal = candidate; break; }
    }
    assert.ok(minimal, 'the original case remains a witness');
    for (let i = 0; i < minimal.rows.length; i++) {
      const candidate = { ...minimal, rows: minimal.rows.map((r, j) => j === i ? { ...r, cents: '1' } : r) };
      if (predicate(candidate, await run(candidate))) minimal = candidate;
    }
    return minimal;
  }
  async function record(map, key, c, predicate) {
    if (!map.has(key)) map.set(key, { count: 0, shrunk: 0, witness: null });
    const group = map.get(key); group.count++;
    const minimal = await shrink(c, predicate);
    group.shrunk++;
    group.witness ??= minimal;
  }
  const cases = generate(), groups = new Map(), overGroups = new Map();
  let wrong = 0, over = 0;
  for (const c of cases) {
    const b = await run(c), errors = failures(c, b), refusal = overFailure(c, b);
    if (errors.length) wrong++;
    if (refusal) {
      over++;
      await record(overGroups, refusal, c, (candidate, body) => overFailure(candidate, body) === refusal);
    }
    for (const key of errors) await record(groups, key, c, (candidate, body) => failures(candidate, body).includes(key));
  }
  const summary = { cases: cases.length, wrong_figures: wrong, groups: Object.fromEntries(groups),
    over_refusals: over, over_refusal_groups: Object.fromEntries(overGroups) };
  console.log('CATEGORY_FINDER ' + JSON.stringify(summary));
  assert.equal(cases.length, 640);
  assert.equal([...groups.values()].reduce((n, g) => n + g.count, 0) >= wrong, true, 'every wrong figure grouped');
  assert.equal(wrong, 0, 'wrong figures block product release');
  assert.equal(over, 0, 'covered gross controls must remain answerable');
});
