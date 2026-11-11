import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';

// The SQL/extractor adapter and row shapes come from the finder; this review
// adds a fresh seed and uncovered/payment/lifecycle cases with a BigInt key.
const SHAPES = ['ordinary', 'paired', 'unpaired', 'card', 'loan', 'refund', 'reversal', 'partial', 'closed', 'pending'];
function generated(seed, index) {
  let state = (seed ^ Math.imul(index + 1, 2654435761)) >>> 0;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const shape = SHAPES[index % 10], direction = Math.floor(index / 10) % 2 ? 'outflow' : 'inflow';
  const amount = () => 1 + next() % 999999;
  const row = (id, account, direction, role, date = '2026-09-15', cents = amount(), pending = 0) =>
    ({ id, account, direction, role, date, cents, pending });
  const rows = [row('ordinary-in', 'a', 'inflow', 'ordinary'), row('ordinary-out', 'a', 'outflow', 'ordinary'),
    row('before', 'a', direction, 'ordinary', '2026-08-31'), row('after', 'a', direction, 'ordinary', '2026-10-01'),
    row('first', 'a', direction, 'ordinary', '2026-09-01'), row('last', 'a', direction, 'ordinary', '2026-09-30')];
  if (['paired', 'unpaired', 'card', 'loan'].includes(shape)) {
    const cents = amount(); rows.push(shape === 'unpaired' && direction === 'inflow'
      ? row('move-in', 'a', 'inflow', 'movement', '2026-09-15', cents)
      : row('move-out', 'a', 'outflow', 'movement', '2026-09-15', cents));
    if (shape !== 'unpaired') rows.push(row('move-in', 'b', 'inflow', 'movement', '2026-09-15', cents));
  }
  if (shape === 'refund') rows.push(row('refund', 'a', 'inflow', 'ordinary'));
  if (shape === 'reversal') { const cents = amount(); rows.push(row('charge', 'a', 'outflow', 'ordinary', '2026-09-15', cents), row('reversal', 'a', 'inflow', 'ordinary', '2026-09-16', cents)); }
  if (shape === 'pending') rows.push(row('pending', 'a', direction, 'ordinary', '2026-09-15', amount(), 1));
  if (shape === 'closed') rows.push(row('closed', 'b', direction, 'ordinary'));
  return { seed, index, shape, direction, scoped: Math.floor(index / 20) % 2 === 0, zone: Math.floor(index / 40) % 2 === 0 ? 'America/Phoenix' : 'Pacific/Kiritimati', rows };
}
// Flow totals retain unpaired movements; only reciprocal proved movements
// leave the ordinary lead. Money in also exposes its unchanged gross subtotal.
function oracle(c, account = null, basis = 'gross') {
  const includeMovement = basis === 'gross-account' || c.shape === 'unpaired' ||
    c.direction === 'inflow' && basis === 'gross';
  return c.rows.filter(r => r.direction === c.direction && !r.pending && (r.role !== 'movement' || includeMovement) &&
    (!account || r.account === account) && r.date >= '2026-09-01' && r.date <= '2026-09-30' && (!c.scoped || r.account === 'a') &&
    !(c.shape === 'closed' && r.account === 'b' && r.date > (c.closedOn || '2026-08-31'))).reduce((sum, r) => sum + BigInt(r.cents), 0n).toString();
}
const shared = fixture({ after: fn => test.after(fn) });
// The case transaction supplies the read snapshot; batch must not nest BEGIN.
shared.env.DB.batch = async statements => Promise.all(statements.map(s => s.all()));
async function run(c, answerPath = withLedgerAnswer) {
  const f = shared; f.calls.length = 0; f.raw('BEGIN'); f.owner();
  try {
    f.env.BRAIN_TIMEZONE = c.zone;
    f.env.ANTHROPIC_API_KEY = 'synthetic-unused';
    for (const [slug, mask] of [['a', '1111'], ['b', '2222']]) {
      const kind = slug === 'b' && ['card', 'loan'].includes(c.shape) ? c.shape : 'checking';
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,status,closed_on,feed_mode,provenance,basis_state,recorded_at)
        VALUES (?,'owner',?,?,?,?,?,'manual','owner_stated','confirmed',?)`, slug, kind, ['card','loan'].includes(kind) ? 'liability' : 'asset', mask,
      c.shape === 'closed' && slug === 'b' ? 'closed' : 'open', c.shape === 'closed' && slug === 'b' ? (c.closedOn || '2026-08-31') : null, NOW);
      if (!(c.uncovered && slug === 'b')) f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,?,?,'2026-10-31',?,'owner_stated','confirmed',?)`, slug, c.shape === 'partial' ? 'partial' : 'complete', '2026-08-01', NOW, NOW);
    }
    for (const r of c.rows) f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, r.id, r.account, r.date, r.cents, r.direction,
    r.description ?? (r.role === 'movement' ? r.direction === 'outflow' ? 'TRANSFER TO ACCOUNT 2222' : r.account === 'a' ? 'TRANSFER FROM ACCOUNT 2222' : 'TRANSFER FROM ACCOUNT 1111' : r.id), r.pending, NOW);
    let calls = 0;
    const period = c.index < 80 ? 'last month' : 'during September 2026';
    const question = `Could you retrieve money ${c.direction === 'inflow' ? 'in' : 'out'} ${period}${c.scoped ? ' for account ending 1111' : ''}?`;
    const body = await (await answerPath({ env: f.env, question,
      // Both instants are October 1 locally, on opposite UTC sides of midnight.
      now: Date.parse(c.zone === 'America/Phoenix' ? '2026-10-01T07:01:00Z' : '2026-09-30T10:01:00Z'),
      grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
        calls++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
          intents: [{ kind: 'totals', direction: c.direction, count: null, vendor_text: null, account_hint: c.scoped ? '1111' : null,
            amount_text: null, date_text: null, period: { type: 'last_month' } }] }) }] };
      } }, async () => Response.json({}))).json();
    assert.equal(calls, 1, 'injected reply passes through real extractor');
    assert.ok(f.calls.some(sql => sql.includes('FROM fin_accounts')), 'real inventory read');
    return body;
  } finally { f.raw('ROLLBACK'); }
}
function assess(c, body) {
  const l = body.ledger;
  // Missing receiving history cannot prove that this outflow left owned
  // accounts. A populated, cited ownership hold is the required decision.
  if (c.shape === 'unpaired' && c.uncovered && c.direction === 'outflow') {
    const movement = c.rows.find(row => row.role === 'movement');
    assert.ok(movement, 'uncovered destination decision has a real outflow');
    if (l?.reason !== 'money_out_destination_unconfirmed' || l.total_minor !== null || body.evidence_gate?.complete !== false)
      return { type: 'uncertified_destination', actual: l?.total_minor };
    const candidate = l.possible_payments?.find(row => row.amount_minor === movement.cents && row.destination_unconfirmed);
    if (!candidate || !body.citations?.some(row => row.n === candidate.n && row.amount_minor === movement.cents))
      return { type: 'missing_destination_disclosure' };
    return null;
  }
  if (!l) {
    // Partial evidence permits an explicit refusal; it cannot establish zero.
    if (c.shape === 'partial' && body.evidence_gate?.complete === false) return null;
    return { type: 'over_refusal', expected: oracle(c), actual: null };
  }
  const key = c.direction === 'inflow' ? 'credits_minor' : 'debits_minor';
  // The primary displayed inflow is combined_inflow_minor. Checking only
  // lead_accounts would miss a correct alternate subtotal beside a wrong lead.
  const actual = l.combined_inflow_minor !== undefined ? String(l.combined_inflow_minor) :
    l.lead_accounts ? total(l.lead_accounts.map(a => String(a[key]))) : String(l.expense_total_minor ?? l.total_minor);
  if (actual !== oracle(c)) return { type: 'wrong_figure', expected: oracle(c), actual };
  const displayed = displayFigures(body.answer)[0]?.cents;
  if (displayed !== oracle(c)) return { type: 'wrong_figure', field: 'primary_display', expected: oracle(c), actual: displayed ?? null };
  if (l.outside_inflow_minor !== undefined && String(l.outside_inflow_minor) !== oracle(c, null, 'outside'))
    return { type: 'wrong_figure', field: 'outside_inflow_minor', expected: oracle(c, null, 'outside'), actual: String(l.outside_inflow_minor) };
  if (l.lead_accounts) {
    const masks = l.lead_accounts.map(a => a.account_mask);
    if (new Set(masks).size !== masks.length || masks.some(m => !['1111', ...(c.scoped ? [] : ['2222'])].includes(m)))
      return { type: 'account_scope', actual: masks };
    for (const a of l.lead_accounts) {
      const expected = oracle(c, a.account_mask === '1111' ? 'a' : 'b', 'ordinary');
      if (String(a[key]) !== expected) return { type: 'wrong_figure', account: a.account_mask, expected, actual: String(a[key]) };
    }
  }
  if (l.from !== '2026-09-01' || l.to !== '2026-09-30') return { type: 'period', expected: 'September', actual: `${l.from}/${l.to}` };
  if (c.shape === 'partial' && body.evidence_gate?.complete === true) return { type: 'partial_complete' };
  if (c.shape === 'pending' && !/pending\b.*(?:not included|excluded)/i.test(body.answer)) return { type: 'pending_silent' };
  return null;
}
// Fresh population; retain the real extractor/SQL/rendering adapter above.
test('review fresh 480 cases: uncovered endpoints, interest, lifecycle and zones', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  let wrong = 0, refusals = 0;
  const failures = [];
  for (let index = 0; index < 480; index++) {
    const c = generated(20261106, index);
    if (c.shape === 'unpaired') {
      c.scoped = true; c.uncovered = true;
      c.rows = c.rows.filter(r => r.account === 'a');
    }
    if (c.shape === 'card' || c.shape === 'loan') for (const r of c.rows.filter(r => r.role === 'movement')) r.description = r.direction === 'outflow' ? 'PAYMENT TO ACCOUNT 2222' : 'TRANSFER FROM ACCOUNT 1111';
    if (c.shape === 'loan') c.rows.push({ id: 'interest', description: 'LOAN INTEREST', account: 'a', direction: 'outflow', role: 'ordinary', date: '2026-09-15', cents: 1 + index * 17, pending: 0 });
    for (const r of c.rows) {
      if (r.id === 'refund') r.description = 'REFUND FROM ACCOUNT 2222';
      if (r.id === 'reversal') r.description = 'REVERSAL OF PAYMENT TO ACCOUNT 2222';
    }
    if (c.shape === 'closed') {
      c.scoped = false; c.closedOn = '2026-09-15';
      for (const [i,date] of ['2026-09-14','2026-09-15','2026-09-16'].entries()) c.rows.push({id:'lifecycle'+i,account:'b',direction:c.direction,role:'ordinary',date,cents:1+index*13+i,pending:0});
    }
    const body = await run(c);
    let failure = assess(c, body);
    for (const group of [body.ledger?.accounts, body.ledger?.lead_accounts]) {
      for (const account of group || []) for (const [key, direction] of [['credits_minor', 'inflow'], ['debits_minor', 'outflow']]) {
        if (account[key] === undefined) continue;
        const expected = oracle({ ...c, direction }, account.account_mask === '1111' ? 'a' : 'b', group === body.ledger?.accounts && c.direction === 'inflow' ? 'gross-account' : 'ordinary');
        if (String(account[key]) !== expected) failure ||= { type: 'wrong_figure', field: key, account: account.account_mask, expected, actual: String(account[key]) };
      }
    }
    if (failure) {
      if (failure.type === 'over_refusal') refusals++; else wrong++;
      failures.push({index,shape:c.shape,direction:c.direction,zone:c.zone,...failure});
    }
  }
  console.log('REVIEW_RECEIPT '+JSON.stringify({seed:20261106,cases:480,wrong_figures:wrong,over_refusals:refusals,failures}));
  assert.equal(wrong,0); assert.equal(refusals,0);
});
