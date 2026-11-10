import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { headLedgerAnswer } from './business-scope-role-only-loader.mjs';
import { withLedgerAnswer } from './business-scope-r2-loader.mjs';

const evidence = { seed: 0x42b1706, scenarios: {}, witnesses: {} };
let state = evidence.seed;
const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
const moneyPattern = /-?\$[\d,]+\.\d{2}/;
function populate(f) {
  for (const table of ['fin_transactions', 'fin_balance_snapshots', 'fin_account_coverage', 'fin_accounts', 'fin_entities']) f.raw(`DELETE FROM ${table}`);
  const rows = [
    ['operating', 'business', '9101', 'Business checking'],
    ['reserve', 'business', '9102', 'Reserve'],
    ['private', 'person', '9103', 'Private'],
    ['uncertain', 'investment', '9104', 'Unassigned'],
  ].map(([id, role, mask, label]) => ({ id, role, mask, label, cents: 1 + random() % 900000 }));
  for (const a of rows) {
    f.owner(a.id);
    f.raw('UPDATE fin_entities SET kind=?,display_label=? WHERE entity_slug=?', a.role, a.id === 'operating' ? 'Owner Workshop' : `Unit ${a.id}`, a.id);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,'checking','asset',?,?,'manual','owner_stated','confirmed',?)`, a.id, a.id, a.mask, a.label, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, a.id, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, a.id, a.cents, NOW);
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
      VALUES (?,?,'2026-09-20',?,'outflow','Office supplies','owner_stated','confirmed',?)`, a.id, a.id, a.cents, NOW);
  }
  return rows;
}
async function ask(f, question, kind = 'expense_summary', hint = 'business', reader = withLedgerAnswer) {
  const before = f.calls.length, writes = f.first('SELECT total_changes() n').n;
  let provider = 0, fallback = 0;
  const body = await (await reader({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => {
      provider++;
      return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
        kind, direction: kind === 'balance' ? null : 'outflow', count: null, vendor_text: null, account_hint: hint,
        amount_text: null, date_text: null, period: { type: kind === 'balance' ? 'none' : 'last_month' },
      }] }) }] };
    },
  }, async gap => { fallback++; return Response.json({ answer: null, gaps: gap ? [gap] : [], evidence_gate: { supported: false, complete: false } }); })).json();
  assert.equal(f.first('SELECT total_changes() n').n, writes, 'the answer must be read-only');
  const sql = f.calls.slice(before);
  const reached = { provider, fallback, inventory: sql.filter(s => s.includes('JOIN fin_entities e') && s.includes('e.kind AS entity_kind')).length,
    disclosure: sql.filter(s => s.startsWith('SELECT a.account_slug,a.mask,a.label')).length };
  assert.ok(reached.provider || reached.inventory, 'the parser or confirmed-inventory decision was reached');
  return { body, reached };
}
const sum = rows => rows.reduce((n, a) => n + BigInt(a.cents), 0n).toString();
const expense = body => body.ledger?.expense_total_minor ?? body.ledger?.retained_outflow_minor;
function numericIssues(result, rows, { optional = false, balance = false } = {}) {
  const { body, reached } = result;
  if (!moneyPattern.test(String(body.answer))) return optional ? [] : ['over_refusal'];
  assert.ok(reached.inventory > 0, 'numeric reading reached confirmed inventory');
  if (balance) {
    const got = body.ledger?.accounts || [];
    return JSON.stringify(got.map(a => a.account_mask).sort()) === JSON.stringify(rows.map(a => a.mask).sort()) &&
      got.every(a => String(a.current_minor) === String(rows.find(r => r.mask === a.account_mask)?.cents)) ? [] : ['wrong_accounts'];
  }
  const masks = new Set((body.citations || []).map(a => a.account_mask));
  return String(expense(body)) === sum(rows) && [...masks].every(mask => rows.some(a => a.mask === mask)) ? [] : ['wrong_accounts'];
}
function exclusionIssues(body, masks) {
  return masks.some(mask => !new RegExp(`${mask}[^\\n]*not counted`).test(String(body.answer))) ? ['silent_omission'] : [];
}
const scenarios = [
  { id: 'R1-biz', q: 'what did the biz spend last month', hint: 'biz' },
  { id: 'R1-qualified', q: 'what did my business checking accounts spend last month', hint: 'business checking accounts' },
  { id: 'R2-business-balances', q: 'show my business account balances', kind: 'balance' },
  { id: 'R2-personal-balances', q: 'show my personal account balances', kind: 'balance', personal: true },
  { id: 'R3-proposed-membership', q: 'what did the business spend last month', proposed: 'uncertain' },
  { id: 'R4-empty-partition', q: 'split personal vs business spending last month', hint: null, empty: true, refusal: true },
  { id: 'work-hint', q: 'what did my work accounts spend last month', hint: 'work', optional: true },
  { id: 'work-omitted', q: 'what did my work accounts spend last month', hint: null, optional: true },
  { id: 'company-hint', q: 'what did the company spend last month', hint: 'the company' },
  { id: 'company-omitted', q: 'what did the company spend last month', hint: null },
  { id: 'llc-hint', q: 'what did the LLC spend last month', hint: 'LLC', optional: true },
  { id: 'llc-omitted', q: 'what did the LLC spend last month', hint: null, optional: true },
  { id: 'named-entity-hint', q: 'what did Owner Workshop spend last month', hint: 'Owner Workshop', entity: true, optional: true },
  { id: 'named-entity-omitted', q: 'what did Owner Workshop spend last month', hint: null, entity: true, optional: true },
  { id: 'contradictory-label', q: 'show my business account balances', kind: 'balance', label: true },
  { id: 'explicit-literal-personal', q: 'Could you retrieve balances for the account named Personal?', kind: 'balance', hint: 'Personal', label: true, literal: true, optional: true },
  { id: 'mixed-proposed-balance', q: 'show my business account balances', kind: 'balance', proposed: 'reserve', partial: true },
  { id: 'absent-refinement', q: 'what did my business Absent account spend last month', hint: 'business Absent', refusal: true },
  { id: 'absent-refinement-dropped', q: 'what did my business Absent account spend last month', hint: null, refusal: true },
  { id: 'absent-refinement-role-only', q: 'what did my business Absent account spend last month', hint: 'business', refusal: true },
  { id: 'empty-role', q: 'what did the business spend last month', empty: true, refusal: true },
];
for (const scenario of scenarios) test(`${scenario.id}: 32 seeded paired cases`, async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t); f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  const stats = evidence.scenarios[scenario.id] = { cases: 0, passes: 0, controls: 0, inventory_reached: 0, provider_reached: 0, issues: {} };
  for (let i = 0; i < 32; i++) {
    const rows = populate(f), business = rows.filter(a => a.role === 'business');
    const green = await ask(f, 'what did the business spend last month');
    assert.deepEqual(numericIssues(green, business), [], 'populated canonical green control');
    assert.ok(green.reached.inventory > 0);
    stats.controls++;
    if (scenario.proposed) f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug=?", scenario.proposed);
    if (scenario.empty) f.raw("UPDATE fin_entities SET kind='person' WHERE kind='business'");
    if (scenario.label) f.raw("UPDATE fin_accounts SET label='Personal' WHERE account_slug='operating'");
    const hint = Object.hasOwn(scenario, 'hint') ? scenario.hint : scenario.personal ? 'personal' : 'business';
    const result = await ask(f, scenario.q, scenario.kind, hint);
    const { body, reached } = result;
    // These independent restrictions are intentionally frozen to HEAD. Earlier
    // rounds incorrectly required the removed mixed-role resolver here.
    const nonPure = scenario.kind === 'balance' || scenario.id === 'R1-qualified' || scenario.id === 'R4-empty-partition' ||
      /^(?:work-|llc-|named-entity-|absent-refinement|explicit-literal)/.test(scenario.id);
    if (nonPure) {
      const historical = await ask(f, scenario.q, scenario.kind, hint, headLedgerAnswer);
      assert.deepEqual(result, historical, 'mixed/no-role bytes and decision counters equal HEAD');
      stats.cases++; stats.passes++;
      if (reached.inventory) stats.inventory_reached++;
      if (reached.provider) stats.provider_reached++;
      continue;
    }
    let wanted = rows.filter(a => (scenario.personal ? a.role === 'person' : a.role === 'business') && a.id !== scenario.proposed);
    if (scenario.entity || scenario.literal) wanted = rows.filter(a => a.id === 'operating');
    const issues = scenario.refusal ? (moneyPattern.test(String(body.answer)) ? ['wrong_accounts'] : []) : numericIssues(result, wanted, { optional: scenario.optional, balance: scenario.kind === 'balance' });
    if (scenario.refusal) {
      if (scenario.empty || moneyPattern.test(String(body.answer))) assert.ok(reached.inventory, 'empty-set or numeric refinement decision reached inventory');
      else { assert.ok(reached.provider || reached.inventory, 'safe refusal reached the parser or inventory guard'); assert.deepEqual(body.citations || [], [], 'refusal has no citations'); }
      if (body.evidence_gate?.complete === true) issues.push('partial_complete');
    }
    if (scenario.proposed || scenario.empty) issues.push(...exclusionIssues(body, scenario.proposed === 'reserve' ? ['9102', '9104'] : ['9104']));
    if (scenario.partial && (body.evidence_gate?.complete !== false || body.ledger?.complete !== false || !/partial/i.test(String(body.answer)))) issues.push('partial_complete');
    stats.cases++; if (reached.inventory) stats.inventory_reached++; if (reached.provider) stats.provider_reached++;
    if (!issues.length) stats.passes++;
    for (const issue of new Set(issues)) {
      stats.issues[issue] = (stats.issues[issue] || 0) + 1;
      evidence.witnesses[`${scenario.id}:${issue}`] ||= { index: i, question: scenario.q, hint, expected_minor: scenario.refusal ? null : sum(wanted), expected_masks: scenario.refusal ? [] : wanted.map(a => a.mask), rows, ...result };
    }
  }
  console.log(JSON.stringify({ scenario: scenario.id, ...stats }));
  assert.equal(stats.controls, 32);
  assert.equal(stats.passes, stats.cases, JSON.stringify(stats.issues));
});
