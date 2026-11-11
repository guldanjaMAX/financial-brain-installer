import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { validateLedgerIntentDecision } from '../src/lib/ledger-intent-role.js';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { headLedgerAnswer } from './business-scope-role-only-loader.mjs';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';

// Expose the real reader in memory, as the period finder does; no LLM/router.
const url = new URL('../src/lib/ledger-answer-role.js', import.meta.url);
const moduleUrl = (source, base) => `data:text/javascript;base64,${Buffer.from(source
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, base).href}${q}`)).toString('base64')}`;
let source = readFileSync(url, 'utf8').replace('async function withParsedLedgerAnswer(', 'export async function withParsedLedgerAnswer(');
// Mutation modes change the loaded product module only; never the disk source.
const mutant = process.env.BUSINESS_SCOPE_MUTANT;
const scopeMutations = {
  'drop-business-filter': ['const accounts = resolveLedgerScope(inventory, role);', 'const accounts = inventory;'],
  'bare-role-all': ["const roleSelector = cardRoles.length === 1 ? cardRoles[0] : intent.requestedRole || typed?.role;", "if (intent.unresolvedAccountRole) return { role: null, accounts: inventory, excludedAccounts: [] }; const roleSelector = cardRoles.length === 1 ? cardRoles[0] : intent.requestedRole || typed?.role;"],
  'unknown-counted': ['const accounts = resolveLedgerScope(inventory, role);', "const accounts = inventory.filter(account => resolveLedgerScope(inventory, role).includes(account) || account.members.some(member => !['business', 'person', 'household'].includes(member.entity_kind)));"],
  'unknown-silent': ['const excludedAccounts = ledgerUnknownScopeAccounts(inventory, uncertainAccounts);', 'const excludedAccounts = [];'],
};
if (scopeMutations[mutant]) {
  const scopeUrl = new URL('./ledger-intent-scope-role.js', url);
  const scope = readFileSync(scopeUrl, 'utf8');
  const [before, after] = scopeMutations[mutant];
  assert.equal(scope.split(before).length - 1, 1, 'one reached scope mutation site');
  source = source.replace('"./ledger-intent-scope-role.js"', JSON.stringify(moduleUrl(scope.replace(before, after), scopeUrl)));
} else if (mutant === 'balance-cent') {
  const before = 'current_minor: row.current_minor, as_of:';
  assert.equal(source.split(before).length - 1, 1, 'one balance mutation site');
  source = source.replace(before, 'current_minor: row.current_minor + 1, as_of:');
} else assert.ok(!mutant, 'unknown mutation mode');
const { withParsedLedgerAnswer } = await import(moduleUrl(source, url));
const seeds = [0x1105, 0x427, 0xc0ffee, 0x7654321];
const questions = ['how much cash is in my business accounts', 'what did the business spend last month', 'business income this quarter', 'personal spending only'];
function rng(seed) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }; }

test('seeded business/personal scope finder: independently checked cents and minimized witnesses', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  f.raw('DELETE FROM fin_balance_snapshots'); f.raw('DELETE FROM fin_account_coverage'); f.raw('DELETE FROM fin_accounts');
  for (const [slug, kind] of [['personal', 'person'], ['unknown', 'investment']]) {
    f.owner(slug); f.raw('UPDATE fin_entities SET kind=? WHERE entity_slug=?', kind, slug);
  }
  const stats = { cases: 0, wrong_figures: 0, silent_exclusions: 0, over_refusals: 0, shrunk: 0, groups: {} };
  const witnesses = {};
  async function run(c, accounts) {
    f.raw('DELETE FROM fin_transactions'); f.raw('DELETE FROM fin_balance_snapshots');
    f.raw('DELETE FROM fin_account_coverage'); f.raw('DELETE FROM fin_accounts');
    for (const a of accounts) {
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at,label)
        VALUES (?,?,?,?,?,'live','feed','bank-feed:fixture-feed','confirmed',?,?)`, a.id, a.entity, a.kind, a.kind === 'card' ? 'liability' : 'asset', a.mask, NOW, a.label);
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,'complete',?,? ,?,'owner_stated','confirmed',?)`, a.id, a.partial ? '2026-09-15' : '2024-01-01', '2026-10-31', NOW, NOW);
      if (!a.missing) f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, a.id, a.cents, NOW);
      f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
        VALUES (?,?,?, ?,?,'Business supplies','owner_stated','confirmed',?)`, a.id, a.id, c.family === 1 ? '2026-09-20' : '2026-10-05', a.cents, c.family === 2 ? 'inflow' : 'outflow', NOW);
    }
    const kind = c.family === 0 ? 'balance' : c.family === 2 ? 'totals' : 'expense_summary';
    const raw = { ambiguous: false, unanswered_part: null, intents: [{ kind, direction: c.family === 0 ? null : c.family === 2 ? 'inflow' : 'outflow', count: null, vendor_text: null, account_hint: null, amount_text: null, date_text: null, period: { type: c.family === 1 ? 'last_month' : 'none' } }] };
    const decision = validateLedgerIntentDecision(raw, questions[c.family], { now: Date.parse(NOW), timeZone: 'UTC' });
    if (!decision.intents?.[0]) return { issues: ['over-refusal'], body: { reason: decision.reason } };
    const before = f.first('SELECT total_changes() n').n;
    const sqlBefore = f.calls.length;
    const body = await (await withParsedLedgerAnswer({ env: f.env, question: questions[c.family], now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner' }, async () => Response.json({}), decision.intents[0])).json();
    assert.equal(f.first('SELECT total_changes() n').n, before, 'answer is read-only');
    assert.ok(f.calls.slice(sqlBefore).some(sql => sql.includes('fin_accounts')), 'real account inventory reached');
    const wanted = accounts.filter(a => a.entity === (c.family === 3 ? 'personal' : 'owner'));
    const figures = displayFigures(body.answer);
    if (!figures.length) return { issues: ['over-refusal'], body };
    const issues = [];
    const wrong = accounts.filter(a => !wanted.includes(a));
    // Account-level money is still a scoped figure; labels do not excuse a
    // personal receipt in a business answer. Match masks, not accidental cents.
    // Excluded identities are disclosure records. Keep every contribution and
    // citation in the membership oracle, independently of that bookkeeping.
    const { operation_scope, ...reading } = body.ledger || {};
    const used = JSON.stringify(reading) + JSON.stringify(body.citations || []);
    if (wrong.some(a => used.includes(`"account_mask":"${a.mask}"`))) issues.push('scope-contamination');
    if (wanted.some(a => !(c.family === 0 && a.missing) && !String(body.answer).includes(a.mask))) issues.push('used-account-not-named');
    if (accounts.some(a => a.entity === 'unknown' &&
        !(String(body.answer).match(new RegExp(a.mask, 'g'))?.length === 1 &&
          new RegExp(`${a.mask}[^\\n]*not counted: scope unknown`).test(body.answer)))) issues.push('unknown-scope-silent');
    if (c.family === 0 && wanted.some(a => a.missing) &&
        (body.ledger?.complete !== false || body.evidence_gate?.complete !== false ||
          !/partial/i.test(body.answer) || wanted.some(a => a.missing &&
            !String(body.answer).includes(a.mask)))) issues.push('missing-snapshot-silent');
    if (c.family === 0 && body.ledger?.cash_only?.total_minor != null) {
      const expected = total(wanted.filter(a => !a.missing && ['checking', 'savings'].includes(a.kind)).map(a => String(a.cents)));
      if (String(body.ledger.cash_only.total_minor) !== expected && !issues.includes('scope-contamination')) issues.push('wrong-cents');
    }
    if (c.family === 0 && body.ledger?.accounts?.some(row => {
      const a = wanted.find(a => a.mask === row.account_mask);
      return a && String(row.current_minor) !== total([String(a.cents)]);
    }) && !issues.includes('scope-contamination')) issues.push('wrong-cents');
    if (c.family === 0 && JSON.stringify((body.ledger?.accounts || []).map(row => row.account_mask).sort()) !==
        JSON.stringify(wanted.filter(a => !a.missing).map(a => a.mask).sort()) &&
        !issues.includes('scope-contamination') && !issues.includes('wrong-cents')) issues.push('wrong-cents');
    if (c.family !== 0) {
      const amount = body.ledger?.expense_total_minor ?? body.ledger?.retained_outflow_minor ?? body.ledger?.combined_inflow_minor;
      const expected = total(wanted.filter(a => !(c.family === 1 && a.partial)).map(a => String(a.cents)));
      if (String(amount) !== expected && !issues.includes('scope-contamination')) issues.push('wrong-cents');
    }
    return { issues, body };
  }
  for (const seed of seeds) {
    const next = rng(seed);
    for (let i = 0; i < 160; i++) {
      const c = { seed, index: i, family: i % 4 };
      const accounts = [
        { id: 'operating', entity: 'owner', kind: 'checking', mask: '1101', label: 'Operating', cents: 100 + next() % 900000 },
        { id: 'personal', entity: 'personal', kind: 'checking', mask: '1102', label: 'Operating personal', cents: 100 + next() % 900000 },
        { id: 'card', entity: 'personal', kind: 'card', mask: '1103', label: 'Business card', cents: 100 + next() % 900000 },
        { id: 'reserve', entity: 'owner', kind: 'savings', mask: '1104', label: 'Operating reserve', cents: 100 + next() % 900000, missing: i % 8 < 4, partial: i % 16 < 8 },
        { id: 'unknown', entity: 'unknown', kind: 'other', mask: '1105', label: 'Operating other', cents: 100 + next() % 900000 },
      ];
      const result = await run(c, accounts); stats.cases++;
      if (result.issues.includes('scope-contamination') || result.issues.includes('wrong-cents')) stats.wrong_figures++;
      if (result.issues.includes('over-refusal')) stats.over_refusals++;
      if (result.issues.includes('unknown-scope-silent') || result.issues.includes('missing-snapshot-silent')) stats.silent_exclusions++;
      for (const issue of result.issues) {
        stats.groups[issue] = (stats.groups[issue] || 0) + 1;
        let minimal = accounts;
        // Every failure is reduced, preserving a nonempty requested denominator.
        for (const a of [...minimal]) {
          const candidate = minimal.filter(x => x !== a);
          if (!candidate.some(x => x.entity === (c.family === 3 ? 'personal' : 'owner') && !(c.family === 0 && x.missing))) continue;
          if ((await run(c, candidate)).issues.includes(issue)) minimal = candidate;
        }
        for (const a of [...minimal]) {
          const candidate = minimal.map(x => x === a ? { ...x, cents: 1, label: 'Unit' } : x);
          if ((await run(c, candidate)).issues.includes(issue)) minimal = candidate;
        }
        for (const a of minimal) {
          const candidate = minimal.filter(x => x !== a);
          if (candidate.some(x => x.entity === (c.family === 3 ? 'personal' : 'owner') && !(c.family === 0 && x.missing))) assert.ok(!(await run(c, candidate)).issues.includes(issue), 'deletion-minimal witness');
        }
        stats.shrunk++;
        witnesses[issue] ??= { ...c, accounts: minimal, answer: (await run(c, minimal)).body.answer };
      }
    }
  }
  console.log(JSON.stringify({ stats, witnesses }, null, 2));
  assert.equal(stats.cases, 640);
  assert.equal(f.documentCalls, 0);
  assert.deepEqual(stats.groups, {});
});

// Balance prose no longer belongs to the closed public grammar. The strict
// reader population above retains its balance/missing-snapshot arithmetic.
test('legacy partial balances and comparisons preserve the public HEAD contract', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t); f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  let provider = 0;
  const options = question => ({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => {
      provider++;
      return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
        kind: 'balance', direction: null, count: null, vendor_text: null, account_hint: 'business', amount_text: null, date_text: null, period: { type: 'none' },
      }] }) }] };
    } });
  for (const state of ['complete', 'missing-snapshot', 'empty-role']) {
    if (state === 'missing-snapshot') f.raw('DELETE FROM fin_balance_snapshots');
    if (state === 'empty-role') f.raw("UPDATE fin_entities SET kind='person'");
    for (const question of ['Could you retrieve balances for my business accounts?', 'Could you retrieve personal and business balances side by side?']) {
      const before = f.calls.length, changes = f.first('SELECT total_changes() n').n, calls = provider;
      const got = await withLedgerAnswer(options(question), async () => Response.json({}));
      assert.ok(f.calls.slice(before).some(sql => sql.includes('fin_accounts')), 'ordinary account decision reached');
      const head = await headLedgerAnswer(options(question), async () => Response.json({}));
      assert.equal(await got.text(), await head.text(), `${state}: exact HEAD bytes`);
      assert.equal(provider - calls, 2, 'both provider admissions reached');
      assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer is read-only');
    }
  }
});

test('bare roles bind recent transactions and exact-payment readers to the confirmed inventory', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  f.add('receipt', 'Payer Unit', 'Payer Unit', { cents: 2500 });
  f.owner('personal');
  f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='personal'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('private','personal','checking','asset','3302','Business','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('private','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,payee,provenance,basis_state,recorded_at)
    VALUES ('private-receipt','private','2026-10-05',2500,'inflow','Payer Unit','owner_stated','confirmed',?)`, NOW);
  for (const kind of ['transactions', 'payment']) {
    const before = f.calls.length;
    const body = await (await withParsedLedgerAnswer({ env: f.env, question: 'business account reading',
      now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner' },
    async () => Response.json({}), { broad: true, kind, direction: 'inflow', limit: 10,
      modelAccountScope: 'business', unresolvedAccountRole: true, counterpartyWords: [], amountMinor: 2500,
      from: '2026-10-01', to: '2026-10-12' })).json();
    assert.ok(f.calls.slice(before).some(sql => sql.includes('fin_transactions')), 'transaction reader reached');
    assert.equal(body.ledger?.kind, kind, 'the selected reader remains available');
    assert.deepEqual(body.citations.map(ref => ref.account_mask), ['1234']);
    assert.doesNotMatch(body.answer, /3302/);
    assert.match(body.answer, /across confirmed owned business accounts/);
  }
});
