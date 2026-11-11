import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } from '../../scripts/run-test-chain.mjs';

// Discovery, not a golden transcript: expectations are authored from row roles
// before product execution, using only the independent integer-cents oracle.
const SEEDS = [1105, 427, 919, 640];
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
  return total(c.rows.filter(r => r.direction === c.direction && !r.pending && (r.role !== 'movement' || includeMovement) &&
    (!account || r.account === account) && r.date >= '2026-09-01' && r.date <= '2026-09-30' && (!c.scoped || r.account === 'a') &&
    !(c.shape === 'closed' && r.account === 'b' && r.date > (c.closedOn || '2026-08-31'))).map(r => String(r.cents)));
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
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,?,?,'2026-10-31',?,'owner_stated','confirmed',?)`, slug, c.shape === 'partial' ? 'partial' : 'complete', '2026-08-01', NOW, NOW);
    }
    for (const r of c.rows) f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, r.id, r.account, r.date, r.cents, r.direction,
    r.role === 'movement' ? r.direction === 'outflow' ? 'TRANSFER TO ACCOUNT 2222' : r.account === 'a' ? 'TRANSFER FROM ACCOUNT 2222' : 'TRANSFER FROM ACCOUNT 1111' : r.id, r.pending, NOW);
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
function failureRoot(c, failure) {
  if (failure.type === 'over_refusal') return 'partial-refusal';
  if (failure.type !== 'wrong_figure') return failure.type + ':' + c.shape;
  const movement = c.rows.filter(r => r.role === 'movement');
  const paired = movement.some(r => r.direction === 'inflow') && movement.some(r => r.direction === 'outflow');
  if (['paired','card','loan','unpaired'].includes(c.shape) && !paired) return 'unpaired-owned-movement';
  if (['paired','card'].includes(c.shape)) return 'primary-inflow-membership';
  if (c.shape === 'loan') return 'liability-counterpart';
  if (c.shape === 'closed') return 'closed-account';
  return failure.type + ':' + c.shape;
}
// Exhaust all row subsets in increasing cardinality: a witness is globally
// row-minimal for this root and fixed account/coverage/query configuration.
// Paired failures retain both legs, so shrinking cannot change the root.
async function shrink(c, failure) {
  for (let size = 0; size <= c.rows.length; size++) for (let bits = 0; bits < 2 ** c.rows.length; bits++) {
    const rows = c.rows.filter((_, i) => bits & 2 ** i);
    if (rows.length !== size) continue;
    const candidate = { ...c, rows };
    const found = assess(candidate, await run(candidate));
    if (found?.type === failure.type && failureRoot(candidate, found) === failureRoot(c, failure)) {
      const unit = { ...candidate, rows: rows.map(r => ({ ...r, cents: 1 })) };
      const unitFailure = assess(unit, await run(unit));
      return unitFailure?.type === failure.type && failureRoot(unit, unitFailure) === failureRoot(c, failure) ? { ...unit, failure: unitFailure } : { ...candidate, failure: found };
    }
  }
  throw Error('failure did not reproduce');
}
test('seeded money in/out finder groups and minimizes every discovered failure', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const groups = new Map(); let cases = 0, wrong = 0, refusals = 0;
  for (const seed of SEEDS) for (let index = 0; index < 160; index++) {
    const c = generated(seed, index), failure = assess(c, await run(c)); cases++;
    if (!failure) continue;
    if (failure.type === 'over_refusal') refusals++; else if (failure.type === 'wrong_figure') wrong++;
    const key = failureRoot(c, failure);
    const witness = await shrink(c, failure);
    const sites = { 'partial-refusal': 'worker/src/lib/ledger-answer.js:570',
      'primary-inflow-membership': 'worker/src/lib/ledger-answer.js:845',
      'unpaired-owned-movement': 'worker/src/lib/ledger-answer.js:246; worker/src/lib/ledger-answer.js:790',
      'liability-counterpart': 'worker/src/lib/ledger-answer.js:219',
      'closed-account': 'worker/src/lib/ledger-reader.js:59' };
    const group = groups.get(key) ?? { key, source: sites[key] ?? 'unclassified', count: 0, witness };
    group.count++; groups.set(key, group);
  }
  const receipt = { cases, wrong_figures: wrong, groups: groups.size, over_refusals: refusals, failures: [...groups.values()] };
  console.log('FINDER_RECEIPT ' + JSON.stringify(receipt));
  assert.equal(cases, 640);
  assert.equal(wrong, 0);
  assert.equal(refusals, 0);
  assert.equal([...groups.values()].reduce((n, g) => n + g.count, 0), wrong + refusals, 'all failures classified');
  if (process.env.MONEY_FINDER_STRICT === '1') assert.equal(wrong, 0, 'wrong figures block product correctness');
});
test('finder is registered in both offline chains', () => {
  for (const commands of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS]) assert.ok(commands.some(c => c.includes('money_inout_property_finder_generated.test.mjs')));
});


test('closed account retains activity through its closing day only', async () => {
  for (const direction of ['inflow', 'outflow']) {
    const c = { ...generated(1105, 8), shape: 'closed', scoped: false, direction, closedOn: '2026-09-15',
      rows: ['2026-09-14','2026-09-15','2026-09-16'].map((date, index) => ({ id: 'closed-' + index,
        account: 'b', direction, role: 'ordinary', date, cents: 1, pending: 0 })) };
    assert.equal(assess(c, await run(c)), null);
  }
});


test('undated activity on a closed account remains an explicit evidence refusal', async () => {
  const c = { ...generated(1105, 8), shape: 'closed', scoped: false, direction: 'inflow', closedOn: '2026-09-15',
    rows: [{ id: 'undated', account: 'b', direction: 'inflow', role: 'ordinary', date: null, cents: 1, pending: 0 }] };
  const body = await run(c);
  assert.equal(body.ledger ?? null, null);
  assert.equal(body.evidence_gate?.complete, false);
});
