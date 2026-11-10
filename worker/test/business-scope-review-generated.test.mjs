import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { headLedgerAnswer } from './business-scope-role-only-loader.mjs';
import { withLedgerAnswer } from './business-scope-review-loader.mjs';

// Independent integer arithmetic: no product selector, summation or money oracle.
const seed = 0x6b90427d;
let state = seed;
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
const sum = items => items.reduce((n, a) => n + BigInt(a.cents), 0n).toString();
const money = n => { const v = BigInt(n), a = v < 0n ? -v : v; return `${v < 0n ? '-' : ''}$${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(a % 100n).padStart(2, '0')}`; };
const scenarios = [
  ['business-spend', 'what did the business spend last month', 'expense_summary', null, 'business'],
  ['personal-spend', 'personal spending only last month', 'expense_summary', 'personal', 'person'],
  ['business-cash', 'how much cash is in my business accounts', 'balance', null, 'business'],
  ['personal-balance', 'show my personal account balances', 'balance', 'personal', 'person'],
  ['alias-hint', 'what did the biz spend last month', 'expense_summary', 'biz', 'business'],
  ['qualified-hint', 'what did my business checking accounts spend last month', 'expense_summary', 'business checking accounts', 'business'],
  ['unconfirmed-entity', 'what did the business spend last month', 'expense_summary', null, 'business'],
  ['missing-snapshot', 'how much cash is in my business accounts', 'balance', 'business', 'business'],
];

test('fresh independent generated population, 256 public-route readings', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  const stats = { seed, cases: 0, passes: 0, wrong_figures: 0, silent_exclusions: 0, over_refusals: 0, inventory_reached: 0, model_calls: 0, fallback_calls: 0, by_scenario: {} };
  const witnesses = {}, records = [];
  for (let index = 0; index < 256; index++) {
    const arm = index % scenarios.length;
    const [name, question, kind, hint, role] = scenarios[arm];
    const bucket = stats.by_scenario[name] ||= { cases: 0, passes: 0, wrong_figures: 0, silent_exclusions: 0, over_refusals: 0 };
    for (const table of ['fin_transactions', 'fin_balance_snapshots', 'fin_account_coverage', 'fin_accounts', 'fin_entities']) f.raw(`DELETE FROM ${table}`);
    const accounts = [];
    const count = 5 + next() % 5;
    for (let j = 0; j < count; j++) {
      const entityKind = j === 0 || j === 1 ? role : j === 2 ? (role === 'business' ? 'person' : 'business') : j === 3 ? 'investment' : ['business','person','household'][next() % 3];
      const entityState = arm === 6 && j === 3 ? 'proposed' : 'confirmed';
      const id = `account-${j}`, entity = `entity-${j}`, mask = String(7000 + j);
      const accountKind = arm === 5 ? 'checking' : ['checking','savings'][next() % 2];
      const cents = 1 + next() % 850000;
      const label = arm === 4 ? `Biz unit ${j}` : arm === 5 ? `Business checking unit ${j}` : `Unit ${j}`;
      const missing = arm === 7 && j === 1;
      const partial = arm < 2 && j === 1 && index % 16 < 8;
      accounts.push({ id, entityKind, entityState, accountKind, cents, mask, label, missing, partial });
      f.owner(entity);
      f.raw('UPDATE fin_entities SET kind=?,basis_state=? WHERE entity_slug=?', entityKind, entityState, entity);
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
        VALUES (?,?,?,'asset',?,?,'manual','owner_stated','confirmed',?)`, id, entity, accountKind, mask, label, NOW);
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,'complete',?,'2026-10-31',?,'owner_stated','confirmed',?)`, id, partial ? '2026-09-15' : '2024-01-01', NOW, NOW);
      if (!missing) f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
        VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, id, cents, NOW);
      f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
        VALUES (?,?,'2026-09-20',?,'outflow','Office supplies','owner_stated','confirmed',?)`, id, id, cents, NOW);
    }
    const wanted = accounts.filter(a => a.entityState === 'confirmed' && (role === 'business' ? a.entityKind === 'business' : ['person','household'].includes(a.entityKind)));
    const contributors = wanted.filter(a => kind === 'balance' ? !a.missing : !a.partial);
    assert.ok(contributors.length > 0, 'oracle denominator reached and nonempty');
    const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    const options = { env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => {
        stats.model_calls++;
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
          kind, direction: kind === 'balance' ? null : 'outflow', count: null, vendor_text: null, account_hint: hint,
          amount_text: null, date_text: null, period: { type: kind === 'balance' ? 'none' : 'last_month' },
        }] }) }] };
      },
    };
    const fallback = async gap => { stats.fallback_calls++; return Response.json({ answer: null, gaps: gap ? [gap] : [] }); };
    const body = await (await withLedgerAnswer(options, fallback)).json();
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'public answer does not write');
    const reached = f.calls.slice(before).some(sql => sql.startsWith('SELECT a.id,a.account_slug'));
    if (reached) stats.inventory_reached++;
    // Account kind is a mixed restriction. Compare its whole response to HEAD,
    // rather than applying the superseded role-intersection oracle.
    if (arm === 5 || kind === 'balance' || question.includes(' only ')) {
      const expected = await (await headLedgerAnswer(options, fallback)).json();
      assert.deepEqual(body, expected, 'question outside the closed grammar remains HEAD-equal');
      assert.ok(reached, 'mixed kind reaches populated inventory');
      assert.equal(f.first('SELECT total_changes() n').n, changes);
      stats.cases++; stats.passes++; bucket.cases++; bucket.passes++;
      records.push({ index, scenario: name, issues: [], reached, oracle: 'HEAD' });
      continue;
    }
    const issues = [];
    const figures = [...String(body.answer || '').matchAll(/-?\$[\d,]+\.\d{2}/g)];
    if (!figures.length) issues.push('over_refusals');
    else {
      assert.ok(reached, 'numeric reading reached inventory');
      const expected = sum(contributors);
      if (kind === 'balance') {
        if (body.ledger?.cash_only && String(body.ledger.cash_only.total_minor) !== expected) issues.push('wrong_figures');
        const got = body.ledger?.accounts || [];
        if (JSON.stringify(got.map(a => a.account_mask).sort()) !== JSON.stringify(contributors.map(a => a.mask).sort()) ||
            got.some(a => String(a.current_minor) !== String(contributors.find(c => c.mask === a.account_mask)?.cents))) issues.push('wrong_figures');
      } else if (String(body.ledger?.expense_total_minor ?? body.ledger?.retained_outflow_minor) !== expected || !String(body.answer).includes(money(expected))) issues.push('wrong_figures');
      const omitted = accounts.filter(a => a.entityState !== 'confirmed' || !['business','person','household'].includes(a.entityKind));
      if (omitted.some(a => !String(body.answer).includes(a.mask) || !new RegExp(`${a.mask}[^\\n]*not counted`).test(body.answer))) issues.push('silent_exclusions');
      if (wanted.some(a => a.missing || a.partial) && (!/partial/i.test(body.answer) || body.evidence_gate?.complete !== false ||
          wanted.filter(a => a.missing || a.partial).some(a => !String(body.answer).includes(a.mask)))) issues.push('silent_exclusions');
    }
    const unique = [...new Set(issues)];
    stats.cases++; bucket.cases++;
    if (!unique.length) { stats.passes++; bucket.passes++; }
    for (const issue of unique) { stats[issue]++; bucket[issue]++; witnesses[`${name}:${issue}`] ||= { index, question, hint, expected_minor: sum(contributors), accounts, answer: body.answer, ledger: body.ledger, gaps: body.gaps, reached }; }
    records.push({ index, scenario: name, issues: unique, reached, expected_minor: sum(contributors) });
  }
  console.log(JSON.stringify(stats, null, 2));
  assert.equal(stats.cases, 256);
  assert.equal(stats.inventory_reached, 256, 'all negative outcomes reached the same inventory decision');
  assert.ok(stats.by_scenario['business-spend'].passes > 0, 'green scoped spending controls');
  assert.ok(stats.by_scenario['business-cash'].passes > 0, 'green scoped balance controls');
  assert.equal(stats.wrong_figures + stats.silent_exclusions + stats.over_refusals, 0);
});
