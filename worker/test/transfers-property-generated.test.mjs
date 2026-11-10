import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, transaction, NOW } from './fixtures/money-fix/fixture.mjs';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';

import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
const seeds = [0x1105, 0xc0ffee, 0x427, 0x51a7];
const questions = [
  ['spend', 'How much did I spend last month?', 'expense_summary', 'outflow'],
  ['income', 'How much money came in last month?', 'totals', 'inflow'],
  ['savings', 'How much did I move from checking to savings last month?', 'transfers', null],
  ['card', 'What did I pay on my card last month?', 'transfers', null],
  ['list', 'Show my transfers last month', 'transfers', null],
];
const row = (id, slug, direction, cents, description, movement = false) => ({ id, slug, direction, cents: String(cents), description, movement });
function generate(mode, n) {
  const pair = (dest, verb = 'Transfer') => [row('out', 'checking', 'outflow', n, `${verb} to ${dest}`, true), row('in', dest, 'inflow', n, `${verb} from checking`, true)];
  const purchase = row('purchase', 'card', 'outflow', n + 17, 'Vendor Unit purchase');
  return [
    pair('savings'), pair('checking').map((r, i) => ({ ...r, slug: i ? 'checking' : 'savings', description: i ? 'Transfer from savings' : 'Transfer to checking' })),
    [...pair('card', 'Payment'), purchase], [...pair('loan', 'Payment'), purchase],
    [{ ...row('out', 'checking', 'outflow', n, 'Transfer to account 9999'), possibleOwn: true }, purchase],
    [row('out', 'checking', 'outflow', n, 'Payment to Vendor Unit'), row('in', 'savings', 'inflow', n, 'Vendor Unit refund')],
    [row('out', 'checking', 'outflow', n, 'Transfer to savings', true), row('in', 'savings', 'inflow', n, 'Customer invoice payment')],
    [...pair('savings'), purchase],
  ][mode];
}
function oracle(rows, query) {
  if (query === 'spend') return total(rows.filter(r => r.direction === 'outflow' && !r.movement && !r.possibleOwn).map(r => r.cents));
  if (query === 'income') return total(rows.filter(r => r.direction === 'inflow').map(r => r.cents));
  // Independent event truth: count each represented movement once by its debit.
  const debits = rows.filter(r => r.movement && r.direction === 'outflow' && rows.some(peer => peer.movement && peer.direction === 'inflow' && peer.cents === r.cents));
  if (query === 'card') return total(debits.filter(r => /to card$/.test(r.description)).map(r => r.cents));
  if (query === 'savings') return total(debits.filter(r => r.slug === 'checking' && /to savings$/.test(r.description)).map(r => r.cents));
  return total(debits.map(r => r.cents));
}

// An unknown account number remains a possible own movement, not spending.
// Its cash-flow reading and exact posting disclosure stay separate from spending. The
// synthetic extractor is injected: no question or row reaches a model/provider.
test('seeded transfer properties: independent cents, minimized witnesses and grouped causes', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = fixture(); t.after(() => f.close());
  for (const [i, kind] of ['checking', 'savings', 'card', 'loan'].entries()) {
    account(f, { slug: kind, mask: String(1100 + i), mode: 'manual' });
    f.raw('UPDATE fin_accounts SET label=?, account_kind=?, balance_role=? WHERE account_slug=?', kind, kind, i > 1 ? 'liability' : 'asset', kind);
  }
  async function run(c, rows) {
    f.raw('DELETE FROM fin_transactions');
    f.raw("UPDATE fin_account_coverage SET coverage_status='complete', covered_from='2026-09-01'");
    if (c.mode === 7) f.raw("UPDATE fin_account_coverage SET coverage_status='partial', covered_from='2026-09-10' WHERE account_slug='savings'");
    rows.forEach(r => { transaction(f, { uid: r.id, slug: r.slug, amount: Number(r.cents), direction: r.direction }); f.raw('UPDATE fin_transactions SET description=? WHERE txn_uid=?', r.description, r.id); });
    const [query, question, kind, direction] = c.q;
    const raw = { ambiguous: false, unanswered_part: null, intents: [{ kind, direction, count: null, vendor_text: null, account_hint: query === 'card' && !question.startsWith('Show') ? 'card' : null, amount_text: null, date_text: null, period: { type: 'last_month' } }] };
    f.env.ANTHROPIC_API_KEY = 'synthetic-test-placeholder';
    const response = await withLedgerAnswer({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => ({ content: [{ type: 'text', text: JSON.stringify(raw) }] }) }, async () => Response.json({}));
    const body = await response.json(), ledger = body.ledger;
    const actual = query === 'income' ? ledger?.combined_inflow_minor : ledger?.total_minor;
    const expected = oracle(rows, query);
    if (query === 'spend') {
      const possible = rows.filter(r => r.possibleOwn && r.direction === 'outflow');
      if (possible.length) {
        assert.ok(Array.isArray(ledger.possible_payments), "possible own postings retained");
        assert.deepEqual(ledger.possible_payments.map(r => r.amount_minor).sort((a,b) => a-b),
          possible.map(r => Number(r.cents)).sort((a,b) => a-b));
        for (const r of ledger.possible_payments) {
          assert.equal(r.payment_kind, 'own_account');
          assert.equal(r.included_in_total, undefined);
          assert.ok(body.citations.some(c => c.n === r.n && c.amount_minor === r.amount_minor));
        }
      }
    }
    if (actual == null) return { status: ['ledger_partial_coverage', 'period_outside_coverage'].includes(body.gaps?.[0]?.reason) ? 'safe-refusal' : 'refusal', reason: body.gaps?.[0]?.reason };
    if (rows.some(r => /9999/.test(r.description) && (query !== 'spend' || r.direction === 'outflow')) && !/unmatched|unproved|unconfirmed|outside|possible transfer/i.test(body.answer)) return { status: String(actual) === expected ? 'disclosure' : 'wrong', disclosure: true, actual, expected }; 
    assert.ok(Number.isSafeInteger(actual));
    const figures = displayFigures(body.answer);
    if (actual !== 0) assert.ok(figures.some(v => v.cents === String(actual)), 'ledger figure must occur in answer');
    return { status: String(actual) === expected ? 'correct' : 'wrong', actual, expected, kind: ledger.kind };
  }
  const groups = new Map(); let cases = 0, wrong = 0, refusals = 0, safeRefusals = 0, disclosures = 0;
  for (const seed of seeds) {
    let state = seed;
    for (let i = 0; i < 160; i++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const c = { seed, index: i, mode: Math.floor(i / 5) % 8, q: questions[i % 5] };
      if (Math.floor(i / 40) % 2) {
        if (c.q[0] === 'savings') c.q = ['savings', 'Show transfers from checking to savings last month', 'transfers', null];
        if (c.q[0] === 'card') c.q = ['card', 'Show transfers from checking to card last month', 'transfers', null];
      }
      const rows = generate(c.mode, 1 + (state >>> 0) % 99000);
      if (c.mode === 4 && Math.floor(i / 40) % 2) Object.assign(rows[0], { direction: 'inflow', description: 'Transfer from account 9999' });
      const result = await run(c, rows); cases++;
      if (result.status === 'correct') continue;
      if (result.status === 'safe-refusal') { safeRefusals++; continue; }
      if (result.disclosure) disclosures++;
      if (result.status === 'wrong') wrong++; else if (result.status !== 'disclosure') refusals++;
      let small = rows;
      // Exhaust all subsets (at most three rows), preserving failure class.
      for (let mask = 0; mask < 1 << rows.length; mask++) {
        const subset = rows.filter((_, j) => mask & 1 << j);
        if (subset.length < small.length && (await run(c, subset)).status === result.status) small = subset;
      }
      const unit = small.map(r => ({ ...r, cents: '1' }));
      if ((await run(c, unit)).status === result.status) small = unit;
      const witness = await run(c, small);
      const known = ['wrong','disclosure'].includes(result.status) && ['income','spend'].includes(c.q[0]);
      const key = result.disclosure ? 'uncovered-transfer-silently-spent' : known ? (c.q[0] === 'income' ? 'known-gross-inflow' : 'known-unpaired-movement') : result.status === 'refusal' ? (c.q[0] === 'savings' ? 'movement-direction-calendar-refusal' : 'card-payment-wording-refusal:' + (result.reason || 'no-ledger') + ':' + (c.q[1].startsWith('Show') ? 'directed' : 'everyday')) : 'advisory-pair-listed-as-transfer';
      const group = groups.get(key) || { count: 0, known, seed, index: i, query: c.q[1], rows: small, result: witness };
      group.count++; groups.set(key, group);
    }
  }
  const newWrong = [...groups.values()].filter(g => !g.known && g.result.status === 'wrong').reduce((n, g) => n + g.count, 0);
  console.log(JSON.stringify({ new_wrong_figures: newWrong, new_groups: [...groups.values()].filter(g => !g.known).length, cases, wrong_figures: wrong, over_refusals: refusals, safe_refusals: safeRefusals, disclosure_failures: disclosures, groups: Object.fromEntries(groups) }));
  assert.equal(cases, 640);
  assert.equal(refusals, 0, 'movement directions must not become calendar residue');
  if (process.env.TRANSFERS_TRIAL !== '1' && process.env.TRANSFERS_STRICT !== '1') assert.deepEqual([wrong, refusals, disclosures, safeRefusals, newWrong], [0, 0, 0, 48, 0], 'ordinary in/out membership is corrected; possible own endpoints stay disclosed outside spending');
  assert.equal(newWrong, 0, 'new transfer total defects');
  if (process.env.TRANSFERS_STRICT === '1') { assert.equal(wrong, 0); assert.equal(refusals, 0); }
});
