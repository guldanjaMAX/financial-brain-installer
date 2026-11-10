import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { headLedgerAnswer } from './business-scope-role-only-loader.mjs';
import { withLedgerAnswer } from './business-scope-r2-loader.mjs';

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
  const ask = async (question, kind = 'balance', hint = null, intents = [intent(kind, hint)], requireInventory = true) => {
    const modelBefore = counters.model;
    const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    const body = await (await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => { counters.model++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents }) }] }; },
    }, async gap => { counters.fallback++; return Response.json({ answer: null, gaps: gap ? [gap] : [] }); })).json();
    const sql = f.calls.slice(before);
    const reached = sql.some(q => q.includes('fin_accounts'));
    if (requireInventory) assert.ok(reached, 'negative outcome reached account inventory');
    else assert.ok(reached || counters.model > modelBefore, 'safe refusal reached parser or account inventory');
    if (reached) counters.inventory++; counters.reads += sql.length;
    assert.equal(f.first('SELECT total_changes() n').n, changes);
    return body;
  };
  const headEqual = async (question, kind = 'balance', hint = null, intents = [intent(kind, hint)]) => {
    const before = { ...counters }, sqlBefore = f.calls.length;
    const body = await ask(question, kind, hint, intents, false);
    const candidateInventory = f.calls.slice(sqlBefore).some(q => q.includes('fin_accounts'));
    const writes = f.first('SELECT total_changes() n').n, headBefore = f.calls.length;
    let provider = 0, fallback = 0;
    const expected = await (await headLedgerAnswer({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => { provider++; return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents }) }] }; },
    }, async gap => { fallback++; return Response.json({ answer: null, gaps: gap ? [gap] : [] }); })).json();
    assert.equal(f.first('SELECT total_changes() n').n, writes);
    assert.equal(f.calls.slice(headBefore).some(q => q.includes('fin_accounts')), candidateInventory, 'HEAD inventory decision reached equally');
    assert.equal(provider, counters.model - before.model, 'HEAD provider decision reached equally');
    assert.equal(fallback, counters.fallback - before.fallback, 'HEAD refusal decision reached equally');
    assert.deepEqual(body, expected, 'non-pure question retains exact HEAD response');
    return body;
  };
  return { ...f, ask, headEqual, intent, counters };
}


for (const hint of ['work', 'LLC', 'Owner Workshop']) test(`noncanonical hint ${hint} retains HEAD`, async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_entities SET display_label='Owner Workshop' WHERE entity_slug='operating'");
  const green = await f.ask('what did the company spend last month', 'expense_summary', 'the company');
  assert.equal(green.ledger.expense_total_minor, 300);
  const body = await f.headEqual(`what did ${hint} spend last month`, 'expense_summary', hint);
  assert.equal(f.counters.model, 2); assert.equal(f.counters.inventory, 2);
  record(`alias-${hint}`, body, f.counters);
  assert.ok(body.ledger, 'HEAD control remains populated');
});

test('a named Personal account retains S5 ordinary owner scope', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_accounts SET label='Personal' WHERE account_slug='operating'");
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  const body = await f.headEqual('Could you retrieve balances for the account named Personal?', 'balance', 'Personal');
  assert.equal(f.counters.inventory, 2); assert.equal(f.counters.model, 2);
  record('explicit-personal-label', body, f.counters);
  assert.deepEqual(body.ledger?.accounts.map(a => a.account_mask), ['8103'], 'S5 Personal ownership decision');
});

test('a proposed business membership makes the pure spending answer partial', async t => {
  const f = fixture(t);
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='reserve'");
  const body = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(f.counters.inventory, 2); assert.equal(f.counters.model, 2);
  assert.deepEqual(body.citations.map(a => a.account_mask), ['8101']);
  assert.match(body.answer, /8102[^\n]*not counted/);
  assert.equal(body.ledger.total_minor, 100);
  record('partial-membership', body, f.counters);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
  await f.headEqual('show my business account balances');
});

for (const hint of [null, 'work']) test(`B1 unresolved balance restriction retains HEAD with hint ${hint}`, async t => {
  const f = fixture(t);
  const green = await f.ask('Could you retrieve balances for all my accounts?', 'balance', null);
  assert.deepEqual(green.ledger.accounts.map(a => a.account_mask).sort(), ['8101','8102','8103','8104']);
  const body = await f.headEqual('Could you retrieve balances for my work accounts?', 'balance', hint);
  assert.equal(f.counters.inventory, 2);
  assert.ok(body.ledger, 'HEAD unresolved control remains populated');
});

for (const word of ['Personal', 'Business', 'Company']) for (const hint of [null, word]) test(`B2 account called ${word} retains identity with hint ${hint}`, async t => {
  const f = fixture(t);
  f.raw('UPDATE fin_accounts SET label=? WHERE account_slug=?', word, 'operating');
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  if (hint === null && word !== 'Personal') {
    await f.headEqual(`Could you retrieve balances for the account called ${word}?`, 'balance', hint);
    assert.equal(f.counters.model, 2);
    return;
  }
  const body = await f.headEqual(`Could you retrieve balances for the account called ${word}?`, 'balance', hint);
  if (hint === null && !body.ledger) {
    assert.equal(f.counters.model, 2, 'nullable-hint refusal reached provider admission');
    assert.doesNotMatch(String(body.answer), /\$[\d,]+\.\d{2}/);
    assert.deepEqual(body.citations || [], []);
    return;
  }
  assert.equal(f.counters.inventory, 2);
  const masks = hint === null ? ['8101'] : word === 'Personal' ? ['8103'] : ['8101', '8102'];
  assert.deepEqual(body.ledger.accounts.map(a => a.account_mask), masks);
  assert.equal(body.ledger.accounts[0].current_minor, hint !== null && word === 'Personal' ? 400 : 100);
  assert.deepEqual(body.citations.map(a => a.account_mask), masks);
});

test('m1 locally admitted company role works with a nullable provider hint', async t => {
  const f = fixture(t);
  const green = await f.ask('what did the company spend last month', 'expense_summary', 'the company');
  assert.equal(green.ledger.expense_total_minor, 300);
  const body = await f.ask('what did the company spend last month', 'expense_summary', null);
  assert.equal(f.counters.model, 2); assert.equal(f.counters.inventory, 2);
  assert.equal(body.ledger.expense_total_minor, 300);
  assert.deepEqual(body.citations.map(a => a.account_mask).sort(), ['8101','8102']);
});

test('B1 entity label containing role words retains HEAD', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_entities SET display_label='Company Unit' WHERE entity_slug='operating'");
  f.raw("UPDATE fin_accounts SET label='Unit' WHERE account_slug IN ('operating','reserve')");
  const green = await f.ask('what did the company spend last month', 'expense_summary', 'the company');
  assert.equal(green.ledger.expense_total_minor, 300);
  const body = await f.headEqual('what did Company Unit spend last month', 'expense_summary', 'Company Unit');
  assert.equal(f.counters.inventory, 2);
});

test('M1 complete confirmed membership is a green control for proposed membership', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='uncertain'");
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.complete, true, 'covered confirmed membership is complete');
  assert.equal(green.evidence_gate.complete, false, 'provider reading still requires clarification');
  assert.equal(green.clarification.reason, 'model_reading');
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='reserve'");
  const body = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(f.counters.inventory, 2); assert.equal(f.counters.model, 2);
  assert.equal(body.ledger.total_minor, 100);
  assert.deepEqual(body.citations.map(a => a.account_mask), ['8101']);
  assert.match(body.answer, /8102[^\n]*not counted/);
  assert.match(body.answer, /Partial reading/);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.ledger.scope_complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
  await f.headEqual('show my business account balances');
});

for (const duplicate of [false, true]) test(`B2 missing or ambiguous named account retains HEAD: duplicate=${duplicate}`, async t => {
  const f = fixture(t);
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  if (duplicate) f.raw("UPDATE fin_accounts SET label='Absent' WHERE account_slug IN ('operating','private')");
  const body = await f.headEqual('Could you retrieve balances for the account named Absent?', 'balance', 'Absent');
  assert.equal(f.counters.inventory, 2);
});

for (const [word, kind] of [['savings', 'savings'], ['cards', 'card']]) test(`B1 account kind ${word} retains HEAD`, async t => {
  const f = fixture(t);
  f.raw('UPDATE fin_accounts SET account_kind=?,balance_role=? WHERE account_slug=?', kind, kind === 'card' ? 'liability' : 'asset', 'reserve');
  const green = await f.ask('Could you retrieve balances for all my accounts?', 'balance', null);
  assert.equal(green.ledger.accounts.length, 4, 'explicit whole-owner control includes a populated other-kind population');
  const body = await f.headEqual(`Could you retrieve ${word} balances?`, 'balance', null);
  assert.equal(f.counters.inventory, 2);
});

test('B2 explicit account spelling survives local role-alias normalization', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_accounts SET label='Biz' WHERE account_slug='operating'");
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  const body = await f.headEqual('Could you retrieve balances for the account named Biz?', 'balance', 'Biz');
  assert.equal(f.counters.inventory, 2); assert.equal(f.counters.model, 2);
  assert.deepEqual(body.ledger.accounts.map(a => a.account_mask), ['8101', '8102']);
  assert.deepEqual(body.citations.map(c => c.account_mask), ['8101', '8102']);
});

test('B1 stored entity with omitted hint retains HEAD', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_entities SET display_label='Owner Money' WHERE entity_slug='operating'");
  const green = await f.ask('what did the business spend last month', 'expense_summary', 'business');
  assert.equal(green.ledger.expense_total_minor, 300);
  const body = await f.headEqual('what did Owner Money spend last month', 'expense_summary', null);
  assert.equal(f.counters.inventory, 2);
});

for (const hint of [null, 'business']) test(`B1 balance refinement retains HEAD with hint ${hint}`, async t => {
  const f = fixture(t);
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  const body = await f.headEqual('Could you retrieve balances for my business Absent accounts?', 'balance', hint);
  assert.equal(f.counters.inventory, 2);
});

test('B1 entity subject with admitted merchant retains HEAD', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_entities SET display_label='Owner Money' WHERE entity_slug='operating'");
  f.raw("UPDATE fin_transactions SET payee='Owner Money',description='Owner Money' WHERE account_slug IN ('operating','private')");
  const green = await f.ask('what did the business spend last month', 'expense_summary', 'business');
  assert.equal(green.ledger.expense_total_minor, 300);
  const body = await f.headEqual('what did Owner Money spend last month', 'merchant', null,
    [{ ...f.intent('merchant', null), vendor_text: 'Owner Money' }]);
  assert.equal(f.counters.inventory, 2);
});

test('B1 entity selector plus account kind retains HEAD', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_entities SET display_label='Owner Money' WHERE entity_slug='operating'");
  f.raw("UPDATE fin_accounts SET account_kind='savings' WHERE account_slug='operating'");
  const green = await f.ask('business spending last month', 'expense_summary', 'business');
  assert.equal(green.ledger.total_minor, 300);
  assert.deepEqual(green.citations.map(a => a.account_mask).sort(), ['8101','8102']);
  const body = await f.headEqual('Could you retrieve checking balances for Owner Money?', 'balance', 'Owner Money');
  assert.equal(f.counters.inventory, 2);
  f.raw("UPDATE fin_accounts SET account_kind='checking' WHERE account_slug='operating'");
  await f.headEqual('Could you retrieve checking balances for Owner Money?', 'balance', 'Owner Money');
});
