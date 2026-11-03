import assert from 'node:assert/strict';
import { reviewedFinalOffer, reviewedPlainCopy, reviewedTitleFields } from './plain-copy-expectations.mjs';
import { displayFigures } from '../../../eval/fast-loop/money-oracle.mjs';

// Independent integer answers and pair membership. Neither product code nor
// the input builder supplies this key. Unmatched does not mean earned income.
const matched = new Set(['clean', 'edge-before', 'edge-after', 'boundary-before',
  'boundary-after', 'two-pairs', 'scoped', 'investment', 'generic-payees']);
export function contract(o) {
  const id = o.id.split('/')[1], b = o.body, l = b.ledger;
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.trace.parsed_intents.length, 1, 'actual classifier reached');
  assert.equal(o.trace.parsed_intents[0].inflowOnly, true);
  assert.ok(o.trace.dependencies.includes('transactions'), 'pairing received posted rows');
  assert.ok(o.trace.rows_read.some(row => row.id === 102), 'inflow decision reached');
  assert.equal(o.trace.product_writes, 0);
  assert.equal(o.trace.fallback_calls, 0);
  assert.equal(l.kind, 'totals');
  assert.deepEqual([l.from, l.to], ['2026-09-01', '2026-09-30']);
  const scoped = ['uncovered', 'scoped'].includes(id);
  const combined = scoped ? 12500 : id === 'ambiguous-in' ? 49681 : id === 'two-pairs' ? 45181 : 37181;
  const total = id === 'two-pairs' ? 20500 : matched.has(id) ? 12500 : 0;
  const pairs = id === 'two-pairs' ? [[101, 102, 12500], [201, 202, 8000]]
    : matched.has(id) ? [[101, 102, 12500]] : [];
  assert.equal(l.combined_inflow_minor, combined);
  assert.equal(l.outside_inflow_minor, combined - total);
  assert.equal(l.matched_own_transfers.total_minor, total);
  assert.equal(l.matched_own_transfers.count, pairs.length);
  assert.equal(l.matched_own_transfers.window_days, 3);
  assert.equal(l.matched_transfer_count, pairs.length);
  assert.equal(l.income_established, false);
  assert.equal(l.includes_own_transfers, true);
  assert.equal(b.evidence_gate.complete, true);
  // These source identities and dates are bound independently of the input
  // generator. A correct subtraction cannot excuse an invented citation.
  const ids = ({ 'ambiguous-out': [101, 104, 102, 103], 'ambiguous-in': [101, 102, 104, 103],
    'edge-after': [102, 103, 101], 'boundary-before': [102, 103, 101],
    'boundary-after': [103, 102, 101], 'boundary-competition': [102, 103],
    uncovered: [102], 'unmatched-credit': [102, 103], 'two-pairs': [101, 102, 103, 201, 202],
    scoped: [102, 101], 'pending-out': [102, 103] })[id] || [101, 102, 103];
  const outDay = ({ 'outside-window': '2026-09-09', 'edge-before': '2026-09-10',
    'edge-after': '2026-09-16', 'boundary-before': '2026-08-29', 'boundary-after': '2026-10-03' })[id] || '2026-09-12';
  const inDay = ['boundary-before', 'boundary-competition'].includes(id) ? '2026-09-01'
    : id === 'boundary-after' ? '2026-09-30' : '2026-09-13';
  const facts = {
    101: ['3131', id === 'cent' ? 12501 : 12500, outDay, 'cash'],
    102: [id === 'same-account' ? '3131' : '5353', 12500, inDay, id === 'same-account' ? 'cash' : 'reserve'],
    103: ['3131', 24681, '2026-09-14', 'cash'],
    104: id === 'ambiguous-out' ? ['3131', 12500, '2026-09-12', 'cash'] : ['5353', 12500, '2026-09-13', 'reserve'],
    201: ['3131', 8000, '2026-09-20', 'cash'], 202: ['5353', 8000, '2026-09-21', 'reserve'],
  };
  const fmt = cents => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
  assert.deepEqual(b.citations, reviewedTitleFields(ids.map((rowId, i) => {
    const [mask, cents, day] = facts[rowId];
    return { n: i + 1, source: 'ledger', source_kind: 'ledger', ref: `ledger:transaction:${rowId}`,
      title: `account ****${mask}: ${fmt(cents)} on ${day}`, account_mask: mask,
      posted_on: day, amount_minor: cents, currency: 'USD', last_synced_at: null, supplied_by: 'manual',
      ts: day, date_reliable: true, text_source: 'native', text_reliable: true };
  })), 'complete source, amount, date and account binding');
  const citation = n => {
    const c = b.citations.find(c => c.n === n);
    assert.ok(c, 'pair cites a supplied source'); return c;
  };
  assert.deepEqual(l.matched_own_transfers.pairs.map(p => [
    Number(citation(p.outgoing_citation).ref.split(':').at(-1)),
    Number(citation(p.incoming_citation).ref.split(':').at(-1)), p.amount_minor,
  ]), pairs);
  const used = l.matched_own_transfers.pairs.flatMap(p => [p.outgoing_citation, p.incoming_citation]);
  assert.equal(new Set(used).size, used.length, 'each posted row used once');
  for (const p of l.matched_own_transfers.pairs) {
    const out = citation(p.outgoing_citation), incoming = citation(p.incoming_citation);
    assert.deepEqual([out.account_mask, incoming.account_mask], ['3131', '5353']);
    assert.equal(out.amount_minor, p.amount_minor); assert.equal(incoming.amount_minor, p.amount_minor);
    assert.ok(Math.abs(Date.parse(out.posted_on) - Date.parse(incoming.posted_on)) <= 3 * 86400000);
    for (const c of [out, incoming]) {
      assert.equal(c.source, 'ledger'); assert.equal(c.currency, 'USD');
      assert.match(b.answer, new RegExp(`\\[${c.n}\\]`));
    }
  }
  const amounts = displayFigures(b.answer).map(a => Number(a.cents));
  assert.deepEqual(amounts.slice(0, 3), [combined, total, combined - total], 'all three lead figures');
  const accountAmounts = scoped ? [12500, 0]
    : id === 'same-account' ? [37181, 12500, 0, 0, 0, 0]
      : [24681, ['boundary-before', 'boundary-after', 'boundary-competition', 'unmatched-credit', 'pending-out'].includes(id)
        ? 0 : id === 'ambiguous-out' ? 25000 : id === 'cent' ? 12501 : id === 'two-pairs' ? 20500 : 12500,
        0, 0, id === 'ambiguous-in' ? 25000 : id === 'two-pairs' ? 20500 : 12500, 0];
  assert.deepEqual(amounts.slice(3), accountAmounts, 'unchanged gross account figures');
  const pairRefs = used.map(n => `[${n}]`).join(' ');
  const expectedLead = [
    `Combined recorded inflow: ${fmt(combined)} across ${scoped ? 1 : 3} selected covered accounts, 2026-09-01 through 2026-09-30; not established income.`,
    `Matched transfers between your own accounts: ${fmt(total)} across ${pairs.length} ${pairs.length === 1 ? 'pair' : 'pairs'}${pairRefs ? ` ${pairRefs}` : ''}.`,
    `Inflow from outside your covered accounts: ${fmt(combined - total)} (recorded inflow minus matched transfers; unmatched credits may include unproved own-account moves).`,
    'Transfers are counted by the inflow posting date; counterpart outflows may fall up to 3 days before or after it.',
  ];
  assert.deepEqual(b.answer.split('\n').slice(0, 4), reviewedPlainCopy(expectedLead.join('\n')).split('\n'), 'closed lead prose contract');
  const periodIds = ids.filter(rowId => facts[rowId][2] >= '2026-09-01' && facts[rowId][2] <= '2026-09-30');
  const selectedAccounts = scoped ? [['reserve', '5353']] : [['cash', '3131'],
    ['debt', id === 'duplicate-mask' ? '5353' : '4242'], ['reserve', '5353']];
  const accountLines = selectedAccounts.map(([slug, mask], i) => {
    const refs = periodIds.filter(rowId => facts[rowId][3] === slug)
      .map(rowId => `[${ids.indexOf(rowId) + 1}]`).join(' ');
    return `account ****${mask}, 2026-09-01 through 2026-09-30: credits ${fmt(accountAmounts[i * 2])}; debits ${fmt(accountAmounts[i * 2 + 1])} ${refs || '(no completed income or expenses in the covered period)'}.`;
  });
  const uncertainIds = !matched.has(id) && id !== 'bare-equal'
    ? id === 'ambiguous-in' ? [102, 104] : [102] : [];
  const uncertainRefs = uncertainIds.map(rowId => ids.indexOf(rowId) + 1);
  assert.deepEqual(l.transfer_related_credit_citations, uncertainRefs);
  assert.equal(b.answer, reviewedFinalOffer(reviewedPlainCopy([...expectedLead, ...accountLines,
    'Source and own-account transfer status are not established by a payer label; uncertain credits remain included.',
    ...(uncertainRefs.length ? [`Transfer-related credits (included; ownership not assumed): ${uncertainRefs.map(n => `[${n}]`).join(' ')}.`] : []),
    `Accounts: ${selectedAccounts.map(([, mask]) => `account ****${mask}`).join(', ')}; 2026-09-01 through 2026-09-30; ${selectedAccounts.map(([, mask]) => `account ****${mask}: covered through 2026-11-07`).join('; ')}.`,
    'Figures use recorded posted rows. Pending activity is not assessed here.',
  ].join('\n'))), 'closed complete factual prose contract');
  assert.doesNotMatch(b.answer, /\bprofit\b|\brevenue\b/i);
  if (id === 'boundary-before') assert.equal(citation(l.matched_own_transfers.pairs[0].outgoing_citation).posted_on, '2026-08-29');
  if (id === 'boundary-after') assert.equal(citation(l.matched_own_transfers.pairs[0].outgoing_citation).posted_on, '2026-10-03');
  if (id === 'boundary-competition') assert.ok(o.trace.rows_read.some(row => row.id === 104 && row.posted_on === '2026-08-26'), 'six-day competing leg reached');
  if (id === 'uncovered') assert.ok(o.trace.rows_read.some(row => row.id === 101), 'uncovered counterpart reached coverage decision');
  if (id === 'pending-out') assert.ok(o.trace.sql.some(s => s.kind === 'transactions' && s.sql.includes('t.pending=0')));
}
