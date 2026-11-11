import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { headOracleUrl } from './business-scope-role-only-loader.mjs';
import { withLedgerAnswer, fallbackAnswer, boundary, bindPureRole } from './business-scope-selector-loader.mjs';
// The independent oracle is a clean checkout of the pinned current HEAD.
// Its location is injected by the offline lane, never an instance default.
const headUrl = process.env.BUSINESS_ROLE_ONLY_HEAD_URL || headOracleUrl;
assert.ok(headUrl, 'clean pinned HEAD oracle URL supplied');
const { withLedgerAnswer: base } = await import(headUrl);
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { BASE_CASES } from '../../test/fixtures/fastloop-money/input.mjs';

function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t); f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  for (const table of ['fin_transactions', 'fin_balance_snapshots', 'fin_account_coverage', 'fin_accounts', 'fin_entities']) f.raw(`DELETE FROM ${table}`);
  for (const [slug, role, mask, cents, label] of [
    ['operating', 'business', '8101', 100, 'Reserve in Motion'],
    ['reserve', 'business', '8102', 200, 'Reserve'],
    ['private', 'person', '8103', 400, 'Private'],
    ['unknown', 'investment', '8104', 800, 'Unassigned'],
  ]) {
    f.owner(slug);
    f.raw('UPDATE fin_entities SET kind=?,display_label=? WHERE entity_slug=?', role, slug === 'operating' ? 'Company Unit' : `Unit ${slug}`, slug);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,'checking','asset',?,?,'manual','owner_stated','confirmed',?)`, slug, slug, mask, label, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, slug, cents, NOW);
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
      VALUES (?,?,'2026-09-20',?,'outflow','Office supplies','owner_stated','confirmed',?)`, slug, slug, cents, NOW);
  }
  return f;
}
async function ask(reader, f, question, kind = 'balance', hint = null, vendor = null) {
  const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  let provider = 0, fallback = 0;
  const response = await reader({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => {
      provider++;
      return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
        kind, direction: kind === 'balance' || kind === 'transfers' ? null : 'outflow', count: null, vendor_text: vendor,
        account_hint: hint, amount_text: null, date_text: null, period: { type: kind === 'balance' ? 'none' : 'last_month' },
      }] }) }] };
    },
  }, async gap => { fallback++; return Response.json({ answer: null, gaps: gap ? [gap] : [] }); });
  const sql = f.calls.slice(before);
  const reached = { provider, fallback, inventory: sql.filter(q => /JOIN fin_entities e/.test(q)).length,
    disclosure: sql.filter(q => /LEFT JOIN fin_entities e/.test(q)).length,
    // Inventory checks coverage existence, but returns no money records. Count
    // only statements that project transaction or balance observations.
    facts: sql.filter(q => /(?:SELECT t\.id,t\.account_slug AS source_account_slug|WITH observations AS)/.test(q)).length };
  assert.ok(provider || reached.inventory, 'parser or account decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer is read-only');
  const text = await response.text();
  return { text, body: JSON.parse(text), reached };
}
async function headEqual(f, question, kind = 'balance', hint = null, vendor = null) {
  const historical = await ask(base, f, question, kind, hint, vendor);
  const candidate = await ask(withLedgerAnswer, f, question, kind, hint, vendor);
  assert.equal(candidate.text, historical.text, `exact HEAD bytes for ${question}`);
  assert.deepEqual(candidate.reached, historical.reached, 'same parser, inventory and fact decision points');
  return candidate;
}


const masks = r => [...new Set((r.body.citations || []).map(c => c.account_mask))].sort();
function populated(r) {
  assert.equal(r.reached.provider, 1);
  assert.ok(r.reached.inventory && r.reached.facts, 'admitted selector reached inventory and money');
}
for (const label of ['Materials', 'Expenses', 'Income']) test(`independent ${label} account retains HEAD`, async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='reserve'", label);
  f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
  const green = await ask(withLedgerAnswer, f, 'business software spending last month', 'category', 'business', 'software');
  populated(green); assert.equal(green.body.ledger.total_minor, 300);
  const result = await headEqual(f, `business spending on software in my ${label} account last month`, 'category', label, 'software');
  populated(result); assert.equal(result.body.ledger.total_minor, 200); assert.deepEqual(masks(result), ['8102']);
});

test('360 seeded category plus account hints preserve HEAD bytes and identities', async t => {
  const f = fixture(t), seen = new Set(), outputs = new Set();
  const vocabulary = ['Materials', 'Expenses', 'Income', 'Cash', 'Spending', 'Money', 'Revenue', 'Software', 'Travel', 'Payments', 'Deposits', 'Transactions'];
  let seed = 0x4271106, passed = 0;
  for (let index = 0; index < 360; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const label = index < vocabulary.length ? vocabulary[index] : `${vocabulary[index % vocabulary.length]} Unit${seed.toString(16).replace(/[0-9a-f]/g, c => String.fromCharCode(107 + parseInt(c, 16)))}`;
    seen.add(label);
    f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='reserve'", label);
    f.raw("UPDATE fin_transactions SET category='equipment',category_basis_state='confirmed',amount_minor=amount_minor+1");
    const green = await ask(withLedgerAnswer, f, 'business equipment spending last month', 'category', 'business', 'equipment');
    populated(green); assert.deepEqual(masks(green), ['8101', '8102']);
    const q = `business spending on equipment in my ${label} account last month`;
    const result = await headEqual(f, q, 'category', label, 'equipment');
    assert.ok(result.reached.inventory && result.reached.facts, `account label ${label} reaches money`); assert.deepEqual(masks(result), ['8102']);
    assert.equal(result.body.ledger.total_minor, 201 + index);
    outputs.add(result.text); passed++;
  }
  assert.equal(seen.size, 360); assert.equal(outputs.size, 360);
  console.log(`account_hint_head_equal=${passed}/360`);
});

test('textual masks retain HEAD for role/category and role-only shapes', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_accounts SET mask='1234' WHERE account_slug='reserve'");
  f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
  const green = await ask(withLedgerAnswer, f, 'business software spending last month', 'category', 'business', 'software');
  populated(green); assert.equal(green.body.ledger.total_minor, 300);
  for (const q of ['business spending on software in my account ending 1234 last month',
    'business software spending ending 1234 last month', 'business spending in account ending 1234 last month']) {
    for (const hint of [null, 'business', '1234']) {
      const result = await headEqual(f, q, q.includes('software') ? 'category' : 'expense_summary', hint, q.includes('software') ? 'software' : null);
      assert.ok(result.reached.provider || result.reached.inventory, 'mask refusal or reading decision reached');
    }
  }
});

test('selector gate and binding preserve independently admitted restrictions', () => {
  const pure = { kind: 'category', match: 'software', requestedRole: 'business', modelAccountScope: 'business' };
  assert.equal(typeof boundary.ledgerPureRole, 'function');
  assert.equal(boundary.ledgerPureRole([pure]), 'business', 'admitted role/category green control');
  for (const selector of [{ modelAccountScope: 'Materials' }, { accountSelector: 'Expenses' }, { accountSelector: 'business' }, { modelAccountScope: 'business!' }, { modelAccountScope: 'business accounts and their' }, { scopeRestriction: { type: 'account', literal: 'Materials' } }, { modelAccountScope: 'software' }, { accountKind: 'checking' },
    { mask: '1234' }, { amountMinor: 0 }, { amountMinor: 100 }, { amountText: '$1.00' }, { counterpartyText: 'Unit' }, { entityLabel: 'Unit' }, { scopePlan: { type: 'transfer', source: 'Unit', destination: 'Other' } }]) {
    const intent = { ...pure, ...selector }, snapshot = structuredClone(intent);
    assert.equal(boundary.ledgerPureRole([intent]), null, 'independent selector veto reached');
    assert.equal(bindPureRole(intent, 'business'), false, 'binding guard reached');
    assert.deepEqual(intent, snapshot, 'binding never clears or replaces a selector');
  }
  assert.equal(boundary.ledgerPureRole([{ kind: 'category', match: 'software' }]), null, 'text-free selector gate requires admitted role');
  assert.equal(boundary.ledgerPureRole([{ ...pure, kind: 'merchant' }]), null);
  assert.equal(boundary.ledgerPureRole([{ kind: 'merchant', match: 'Business Expenses' }]), null, 'textual role words cannot establish purity');
  assert.equal(boundary.ledgerPureRole([{ ...pure, requestedRole: null, modelAccountScope: 'business Materials' }]), null);
});

test('category consumption cannot erase an account hint even when identical to category', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_accounts SET label='software' WHERE account_slug='reserve'");
  f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
  const green = await ask(withLedgerAnswer, f, 'business software spending last month', 'category', 'business', 'software');
  populated(green); assert.equal(green.body.ledger.total_minor, 300);
  const result = await headEqual(f, 'business spending on software in my software account last month', 'category', 'software', 'software');
  populated(result); assert.equal(result.body.ledger.total_minor, 200); assert.deepEqual(masks(result), ['8102']);
});

test('fallback switch keeps 300 role/category readings HEAD-equal', async t => {
  const f = fixture(t), outputs = new Set();
  for (let i = 0; i < 300; i++) {
    const role = ['business', 'personal', 'biz', 'company', 'household'][i % 5];
    f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed',amount_minor=amount_minor+1");
    const q = `${role} software spending last month`;
    const expected = await ask(base, f, q, 'category', role, 'software');
    const got = await ask(fallbackAnswer, f, q, 'category', role, 'software');
    populated(got); assert.equal(got.text, expected.text); assert.deepEqual(got.reached, expected.reached); outputs.add(got.text);
  }
  assert.equal(outputs.size, 300); console.log('fallback_role_category=300/300');
});

test('fallback mode preserves 1280 public pure-role membership readings', async t => {
  const f = fixture(t);
  const variants = [
    ['what did my business spend last month', 'expense_summary', 'business', false],
    ['what did the biz spend last month', 'expense_summary', 'biz', false],
    ['what did the company spend last month', 'expense_summary', 'the company', false],
    ['personal spending last month', 'expense_summary', 'personal', true],
    ['show me my business accounts spending last month', 'expense_summary', null, false],
    ['show my business account spending last month', 'expense_summary', 'business', false],
    ['Could you retrieve my personal accounts spending last month?', 'expense_summary', 'personal', true],
    ['what did my household spend last month', 'expense_summary', 'household', true],
  ];
  for (let i = 0; i < 1280; i++) {
    const [q, kind, hint, personal] = variants[i % variants.length];
    const proposed = Math.floor(i / variants.length) % 2 === 1;
    f.raw("UPDATE fin_entities SET basis_state=? WHERE entity_slug='reserve'", proposed ? 'proposed' : 'confirmed');
    for (const [slug, cents] of [['operating', 101 + i], ['reserve', 203 + i * 2], ['private', 407 + i * 3]]) {
      f.raw('UPDATE fin_transactions SET amount_minor=? WHERE account_slug=?', cents, slug);
      f.raw('UPDATE fin_balance_snapshots SET current_minor=? WHERE account_slug=?', cents, slug);
    }
    const result = await ask(fallbackAnswer, f, q, kind, hint);
    assert.ok(result.reached.inventory && result.reached.disclosure && result.reached.facts, 'fallback pure role reads membership and money');
    const expected = personal ? 407 + i * 3 : 101 + i + (proposed ? 0 : 203 + i * 2);
    const got = kind === 'balance' ? result.body.ledger.accounts.reduce((sum, a) => sum + a.current_minor, 0) : result.body.ledger.expense_total_minor;
    assert.equal(got, expected);
    assert.deepEqual(masks(result), personal ? ['8103'] : proposed ? ['8101'] : ['8101', '8102']);
    assert.match(result.body.answer, /8104[^\n]*not counted/);
    if (proposed) assert.match(result.body.answer, /8102[^\n]*not counted/);
    assert.equal(result.body.evidence_gate.complete, false);
  }
  console.log('fallback_pure_role=1280/1280 wrong_figures=0');
});
