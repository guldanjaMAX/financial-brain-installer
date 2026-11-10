import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from './business-scope-review-loader.mjs';
import { headLedgerAnswer } from './business-scope-role-only-loader.mjs';
import { readEffectiveAccounts, readUncertainScopeAccounts } from '../src/lib/ledger-reader.js';

const evidence = [];
const record = (id, body, counters) => {
  evidence.push({ id, answer: body.answer, ledger: body.ledger, gaps: body.gaps, evidence_gate: body.evidence_gate, counters });
};
function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t); f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  for (const table of ['fin_transactions','fin_balance_snapshots','fin_account_coverage','fin_accounts','fin_entities']) f.raw(`DELETE FROM ${table}`);
  const accounts = [
    ['operating', 'business', '8101', 100, 'Business checking'],
    ['reserve', 'business', '8102', 200, 'Reserve'],
    ['private', 'person', '8103', 400, 'Private'],
    ['uncertain', 'investment', '8104', 800, 'Unassigned'],
  ];
  for (const [id, kind, mask, cents, label] of accounts) {
    f.owner(id); f.raw('UPDATE fin_entities SET kind=? WHERE entity_slug=?', kind, id);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,'checking','asset',?,?,'manual','owner_stated','confirmed',?)`, id, id, mask, label, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, id, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, id, cents, NOW);
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
      VALUES (?,?,'2026-09-20',?,'outflow','Office supplies','owner_stated','confirmed',?)`, id, id, cents, NOW);
  }
  const counters = { model: 0, inventory: 0, fallback: 0, reads: 0 };
  const intent = (kind, hint) => ({ kind, direction: kind === 'balance' ? null : 'outflow', count: null, vendor_text: null,
    account_hint: hint, amount_text: null, date_text: null, period: { type: kind === 'balance' ? 'none' : 'last_month' } });
  const ask = async (question, kind = 'balance', hint = null, intents = [intent(kind, hint)], headEqual = false) => {
    const modelBefore = counters.model, fallbackBefore = counters.fallback;
    const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    const body = await (await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => { counters.model++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents }) }] }; },
    }, async gap => { counters.fallback++; return Response.json({ answer: null, gaps: gap ? [gap] : [] }); })).json();
    const sql = f.calls.slice(before);
    const inventoryReached = sql.some(q => q.startsWith('SELECT a.id,a.account_slug'));
    if (headEqual) assert.ok(inventoryReached || counters.model > modelBefore && counters.fallback > fallbackBefore, 'mixed reading reaches inventory or admitted refusal');
    else assert.ok(inventoryReached, 'negative outcome reached confirmed account inventory');
    if (inventoryReached) counters.inventory++;
    counters.reads += sql.length;
    assert.equal(f.first('SELECT total_changes() n').n, changes);
    if (headEqual) {
      const headBefore = f.calls.length;
      let headProvider = 0, headFallback = 0;
      const expected = await (await headLedgerAnswer({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
        callLLM: async () => { headProvider++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents }) }] }; },
      }, async gap => { headFallback++; return Response.json({ answer: null, gaps: gap ? [gap] : [] }); })).json();
      assert.equal(f.calls.slice(headBefore).some(q => q.startsWith('SELECT a.id,a.account_slug')), inventoryReached, 'same HEAD inventory decision');
      assert.equal(headProvider, counters.model - modelBefore, 'same provider decision');
      assert.equal(headFallback, counters.fallback - fallbackBefore, 'same refusal decision');
      assert.equal(f.first('SELECT total_changes() n').n, changes);
      assert.deepEqual(body, expected, 'mixed restrictions preserve exact HEAD response');
    }
    return body;
  };
  return { ...f, ask, intent, counters, headEqual: (question, kind = 'expense_summary', hint = null, intents = [intent(kind, hint)]) => ask(question, kind, hint, intents, true) };
}

test('green control: canonical business role ignores contradictory labels', async t => {
  const f = fixture(t);
  const body = await f.ask('what did the business spend last month', 'expense_summary', 'business');
  assert.equal(body.ledger.expense_total_minor, 300);
  assert.match(body.answer, /8104[^\n]*not counted: scope unknown/);
  record('canonical-control', body, f.counters);
});

test('R1a: an admitted biz hint cannot broaden the confirmed role', async t => {
  const f = fixture(t);
  const green = await f.ask('what did the business spend last month', 'expense_summary', 'business');
  assert.equal(green.ledger.expense_total_minor, 300);
  const body = await f.ask('what did the biz spend last month', 'expense_summary', 'biz');
  assert.equal(f.counters.model, 2); assert.equal(f.counters.inventory, 2);
  record('alias-hint', body, f.counters);
  assert.equal(body.ledger.expense_total_minor, 300);
});

// Account kind remains a mixed restriction under the final scope contract.
test('R1b: role plus account kind retains HEAD selection', async t => {
  const f = fixture(t);
  assert.equal((await f.ask('what did my business spend last month', 'expense_summary', 'business')).ledger.expense_total_minor, 300);
  const question = 'what did my business checking accounts spend last month';
  const body = await f.headEqual(question, 'expense_summary', 'business');
  assert.equal(body.ledger.expense_total_minor, 300, 'S5 role hint remains authoritative');
  await f.headEqual(question, 'expense_summary', 'business checking accounts');
  assert.equal(f.counters.model, 3); assert.equal(f.counters.inventory, 3);
});

test('R2: balance wording outside the closed grammar retains HEAD', async t => {
  const f = fixture(t);
  const green = await f.ask('what did my business spend last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  const body = await f.headEqual('show my business account balances', 'balance');
  record('grammar-subset-head', body, f.counters);
});

test('R3: unconfirmed entity stays visible as an excluded account', async t => {
  const f = fixture(t);
  const question = 'what did the business spend last month';
  const green = await f.ask(question, 'expense_summary', null);
  assert.equal(green.ledger.expense_total_minor, 300);
  assert.match(green.answer, /8104[^\n]*not counted: scope unknown/);
  f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='uncertain'");
  const body = await f.ask(question, 'expense_summary', null);
  assert.equal(f.counters.inventory, 2); assert.equal(body.ledger.expense_total_minor, 300);
  record('unconfirmed-entity', body, f.counters);
  assert.match(body.answer, /8104[^\n]*not counted/);
});

test('R4: comparison scope and empty-role behavior retain HEAD', async t => {
  const f = fixture(t);
  assert.equal((await f.ask('what did the business spend last month', 'expense_summary', 'business')).ledger.expense_total_minor, 300);
  const question = 'split personal vs business spending last month';
  const green = await f.headEqual(question);
  assert.deepEqual(green.ledger.parts.map(p => p.expense_total_minor), [400, 300]);
  f.raw("UPDATE fin_entities SET kind='person' WHERE kind='business'");
  await f.headEqual(question);
  assert.equal(f.counters.model, 3); assert.equal(f.counters.inventory, 3);
});

for (const hint of ['biz', 'my business', 'company', 'business checking accounts']) {
  test(`R1 admitted role alias ${hint} preserves the confirmed denominator`, async t => {
    const f = fixture(t);
    const green = await f.ask('what did the business spend last month', 'expense_summary', 'business');
    assert.equal(green.ledger.expense_total_minor, 300);
    if (hint === 'business checking accounts') {
      const body = await f.headEqual(`what did ${hint} spend last month`, 'expense_summary', hint);
      assert.equal(f.counters.model, 2); assert.equal(f.counters.inventory, 2);
      assert.equal(body.ledger.expense_total_minor, 100, 'S5 combined role and account kind remains authoritative');
      return;
    }
    const body = await f.ask(`what did ${hint} spend last month`, 'expense_summary', hint);
    assert.equal(f.counters.model, 2);
    assert.equal(body.ledger.expense_total_minor, 300);
    assert.deepEqual(body.citations.map(c => c.account_mask).sort(), ['8101', '8102']);
    assert.match(body.answer, /8104[^\n]*not counted: scope unknown/);
  });
}

test('R1 independent kinds, account literals and unresolved refinements retain HEAD', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_accounts SET account_kind='savings',label='Business checking' WHERE account_slug='reserve'");
  assert.equal((await f.ask('what did the business spend last month', 'expense_summary', 'business')).ledger.expense_total_minor, 300);
  for (const hint of ['business checking accounts', 'checking', null, 'business']) {
    await f.headEqual('what did my business checking accounts spend last month', 'expense_summary', hint);
  }
  f.raw("UPDATE fin_accounts SET label='Reserve' WHERE account_slug IN ('reserve','private','uncertain')");
  for (const hint of ['business Reserve', 'Reserve']) {
    await f.headEqual('what did my business Reserve account spend last month', 'expense_summary', hint);
  }
  for (const hint of ['business absent', 'absent']) {
    await f.headEqual('what did my business absent account spend last month', 'expense_summary', hint);
  }
  assert.equal(f.counters.model, 9, 'all mixed decisions plus the numeric control reached extraction');
  assert.ok(f.counters.inventory > 1, 'populated mixed readings remain active');
});

for (const role of ['business', 'personal']) for (const renderer of ['grammar', 'model']) {
  for (const labels of [['Unit', 'Reserve', 'Private'], ['Personal', 'Personal', 'Business'], ['Same', 'Same', 'Same']]) {
    test(`R2 ${renderer} ${role} balances retain HEAD under labels ${labels.join('/')}`, async t => {
      const f = fixture(t);
      for (const [id, label] of ['operating', 'reserve', 'private'].map((id, i) => [id, labels[i]])) {
        f.raw('UPDATE fin_accounts SET label=? WHERE account_slug=?', label, id);
      }
      const green = await f.ask(`${role} spending last month`, 'expense_summary', role);
      const expected = role === 'business' ? ['8101', '8102'] : ['8103'];
      assert.deepEqual(green.citations.map(a => a.account_mask).sort(), expected, 'fully consumed role still ignores labels');
      assert.equal(green.ledger.total_minor, role === 'business' ? 300 : 400);
      assert.match(green.answer, /8104[^\n]*not counted: scope unknown/);
      const question = renderer === 'grammar' ? `show my ${role} account balances` : `Could you retrieve ${role} balances?`;
      await f.headEqual(question, 'balance', role);
      if (role === 'business') {
        f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='reserve'");
        await f.headEqual(question, 'balance', role);
      }
    });
  }
}

for (const state of ['proposed', 'missing']) test(`R3 ${state} membership is disclosure-only even with a business kind`, async t => {
  const f = fixture(t);
  const question = 'what did the business spend last month';
  const green = await f.ask(question, 'expense_summary', 'business');
  assert.equal(green.ledger.expense_total_minor, 300);
  f.raw("UPDATE fin_entities SET kind='business',basis_state='proposed' WHERE entity_slug='uncertain'");
  if (state === 'missing') f.raw("DELETE FROM fin_entities WHERE entity_slug='uncertain'");
  const body = await f.ask(question, 'expense_summary', 'business');
  assert.equal(body.ledger.expense_total_minor, 300);
  assert.deepEqual(body.citations.map(c => c.account_mask).sort(), ['8101', '8102']);
  assert.match(body.answer, /8104[^\n]*not counted: scope unknown/);
  assert.equal(body.answer.match(/8104/g)?.length, 1);
  const { operation_scope, ...arithmetic } = body.ledger;
  assert.equal(operation_scope.excluded_accounts[0].account_mask, '8104');
  assert.doesNotMatch(JSON.stringify(arithmetic), /8104/);
  assert.equal(f.counters.inventory, 2);
});

test('R3 disclosure inventory is bounded, tenant-bound and separate from confirmed contributors', async t => {
  const f = fixture(t);
  assert.equal((await readEffectiveAccounts(f.env)).length, 4, 'populated confirmed reader control');
  assert.deepEqual(await readUncertainScopeAccounts(f.env), [], 'confirmed membership has no uncertain disclosure');
  f.raw("UPDATE fin_entities SET basis_state='proposed',kind='business' WHERE entity_slug='uncertain'");
  const uncertain = await readUncertainScopeAccounts(f.env);
  assert.deepEqual(uncertain.map(a => a.account_slug), ['uncertain']);
  assert.deepEqual(Object.keys(uncertain[0]).sort(), ['account_slug', 'label', 'mask']);
  assert.deepEqual((await readEffectiveAccounts(f.env)).map(a => a.mask).sort(), ['8101', '8102', '8103']);
  const sql = f.calls.at(-2);
  assert.match(sql, /a\.tenant_id=\?/);
  assert.match(sql, /LIMIT \?/);
  f.raw("UPDATE fin_accounts SET tenant_id='other-tenant' WHERE account_slug='uncertain'");
  assert.deepEqual(await readUncertainScopeAccounts(f.env), [], 'another tenant cannot enter disclosure');
  f.raw("UPDATE fin_accounts SET tenant_id='primary' WHERE account_slug='uncertain'");
  f.raw("UPDATE fin_entities SET relationship='counterparty' WHERE entity_slug='uncertain'");
  assert.deepEqual(await readUncertainScopeAccounts(f.env), [], 'explicit unowned membership cannot enter disclosure');
  f.raw("UPDATE fin_entities SET relationship='owned' WHERE entity_slug='uncertain'");
  f.raw("UPDATE fin_accounts SET superseded_by_id=1 WHERE account_slug='uncertain'");
  assert.deepEqual(await readUncertainScopeAccounts(f.env), [], 'superseded accounts cannot enter disclosure');
  f.raw("UPDATE fin_accounts SET superseded_by_id=NULL WHERE account_slug='uncertain'");
  assert.equal((await readUncertainScopeAccounts(f.env)).length, 1, 'negative arms have a restored green control');
  for (let i = 0; i < 200; i++) f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
    VALUES (?,'uncertain','checking','asset','8999','Unit','manual','owner_stated','confirmed',?)`, `uncertain-${i}`, NOW);
  const before = f.calls.length;
  await assert.rejects(() => readUncertainScopeAccounts(f.env), /ledger disclosure account limit/);
  assert.equal(f.calls.length, before + 1, 'overflow decision reached the bounded query');
  f.raw("DELETE FROM fin_accounts WHERE account_slug='uncertain-199'");
  assert.equal((await readUncertainScopeAccounts(f.env)).length, 200, 'exact-limit green peer');
});

for (const state of ['proposed', 'missing']) test(`R4 mixed comparison retains HEAD with ${state} membership`, async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_entities SET basis_state='proposed',kind='business' WHERE entity_slug='uncertain'");
  if (state === 'missing') f.raw("DELETE FROM fin_entities WHERE entity_slug='uncertain'");
  assert.equal((await f.ask('what did the business spend last month', 'expense_summary', 'business')).ledger.expense_total_minor, 300);
  const question = 'split personal vs business spending last month';
  const green = await f.headEqual(question);
  assert.deepEqual(green.ledger.parts.map(p => p.expense_total_minor), [400, 300]);
  f.raw("UPDATE fin_entities SET kind='person' WHERE basis_state='confirmed' AND kind='business'");
  await f.headEqual(question);
  assert.equal(f.counters.model, 3); assert.equal(f.counters.inventory, 3);
});

test('R3 unavailable disclosure inventory fails closed after a numeric control', async t => {
  const f = fixture(t);
  const question = 'what did the business spend last month';
  assert.equal((await f.ask(question, 'expense_summary', 'business')).ledger.expense_total_minor, 300);
  const prepare = f.env.DB.prepare;
  let attempts = 0;
  f.env.DB.prepare = sql => {
    if (sql.startsWith('SELECT a.account_slug,a.mask,a.label')) { attempts++; throw Error('synthetic disclosure unavailable'); }
    return prepare(sql);
  };
  const refused = await f.ask(question, 'expense_summary', 'business');
  assert.equal(attempts, 1, 'failed disclosure decision reached');
  assert.equal(refused.ledger, null);
  assert.ok(refused.gaps.some(gap => gap.reason === 'ledger_unavailable'));
  assert.doesNotMatch(refused.answer, /\$[\d,]+\.\d{2}/);
});

test('R1 omitted hints in legacy balance prose retain HEAD for both roles', async t => {
  const f = fixture(t);
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  for (const role of ['business', 'personal']) {
    const question = `Could you retrieve ${role} balances?`;
    await f.headEqual(question, 'balance', role);
    await f.headEqual(question, 'balance', null);
  }
});
