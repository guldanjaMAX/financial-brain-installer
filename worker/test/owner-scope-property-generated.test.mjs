import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/money-fix/fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

test('ownership denominator uses every confirmed member, never account labels', async () => {
  const { resolveOwnershipScope } = await import('../src/lib/ledger-owner-scope.js');
  const account = (slug, kinds) => ({ account_slug: slug, label: 'Business personal',
    members: kinds.map(entity_kind => ({ entity_kind })) });
  const business = account('business', ['business']);
  const household = account('household', ['person', 'household']);
  const mixed = account('mixed', ['business', 'person']);
  const trust = account('trust', ['trust']);
  const inventory = [business, household, mixed, trust];
  assert.deepEqual(resolveOwnershipScope(inventory, 'business accounts').accounts, [business]);
  assert.deepEqual(resolveOwnershipScope(inventory, 'my own').accounts, [household]);
  assert.deepEqual(resolveOwnershipScope(inventory, 'company').unknown, [mixed, trust]);
  assert.equal(resolveOwnershipScope([trust], 'personal').empty, true);
  assert.equal(resolveOwnershipScope(inventory, 'Reserve Box'), null);
});

// Protocol replies are injected; no provider, router accuracy, or product helper
// participates in the ownership or integer-cent oracle.
const NOW = '2026-10-11T12:00:00.000Z';
const SEED = 0x11042026;
let state = SEED;
const random = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
const operations = ['balance', 'in', 'out', 'largest', 'recurring', 'comparison'];
const scopes = ['business', 'personal', 'nickname', 'none'];
const aliases = { business: ['business', 'company', "the shop's"], personal: ['personal', 'my own', 'household'], nickname: ['Reserve Box', 'Account 0'], none: [''] };
const kinds = ['checking', 'savings', 'card', 'loan'];
const ownership = ['business', 'personal', 'unknown'];
const cases = [];
for (let round = 0; round < 25; round++) for (const operation of operations) for (const scope of scopes) {
  const accounts = Array.from({ length: 1 + random(6) }, (_, i) => ({
    id: i, owner: ownership[random(3)], kind: kinds[random(4)],
    balance: 10000 + random(900000), incoming: 1000 + random(90000), charge: 100 + random(9000),
  }));
  cases.push({ id: cases.length, operation, scope, alias: aliases[scope][round % aliases[scope].length], accounts });
}

function populate(f, accounts) {
  for (const a of accounts) {
    const entity = `entity-${a.id}`, slug = `account-${a.id}`, mask = String(1000 + a.id);
    // A trust has no asserted personal/business purpose. Account type and a
    // provider label cannot fill that missing ownership fact.
    f.raw(`INSERT INTO fin_entities (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'owned','owner_stated','confirmed',?)`, entity, 'Synthetic entity',
    a.owner === 'personal' ? 'person' : a.owner === 'unknown' ? 'trust' : 'business', NOW);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,'manual','owner_stated','confirmed',?)`, slug, entity, a.kind,
    ['card', 'loan'].includes(a.kind) ? 'liability' : 'asset', mask, a.label || `Account ${a.id}`, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-08-01','2026-10-11',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-11',?,'owner_stated','confirmed',?)`, slug, a.balance, NOW);
    for (const month of ['08', '09']) {
      for (const [day, direction, cents, payee] of [['15', 'inflow', a.incoming, `Payer ${a.id}`],
        ...['03', '10', '17', '24'].map(day => [day, 'outflow', a.charge, `Service ${a.id}`])]) {
        f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
          VALUES (?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, `${slug}-${month}-${day}-${direction}`, slug,
        `2026-${month}-${day}`, cents + (month === '08' ? direction === 'outflow' ? 17 : 37 : 0), direction, payee, payee, NOW);
      }
    }
  }
}
function protocol(c) {
  const kind = c.operation === 'comparison' || c.operation === 'out' ? 'expense_summary'
    : c.operation === 'in' ? 'totals' : c.operation;
  const scopeText = c.alias ? ` for ${c.alias} accounts` : '';
  const balanceNouns = ['bank balances', 'cash held across accounts', 'recorded account balances'];
  const noun = { balance: balanceNouns[Math.floor(c.id / 24) % 3], in: 'money in', out: 'money out', largest: 'largest expenses', recurring: 'recurring charges', comparison: 'expenses' }[c.operation];
  const clause = month => `${noun}${scopeText} in ${month} 2026`;
  const question = c.operation === 'comparison' ? `Could you retrieve ${clause('September')} versus ${clause('August')}?`
    : `Could you retrieve ${noun}${scopeText}${c.operation === 'balance' ? '' : ' in September 2026'}?`;
  const record = month => ({ kind, direction: c.operation === 'balance' ? null : c.operation === 'in' ? 'inflow' : 'outflow',
    count: c.operation === 'largest' ? 100 : null, vendor_text: null, account_hint: c.alias || null,
    amount_text: null, date_text: null, period: c.operation === 'balance' ? { type: 'none' }
      : { type: 'between', from: `2026-${month}-01`, to: `2026-${month}-${month === '09' ? '30' : '31'}` } });
  return { question, reply: { ambiguous: false, unanswered_part: null,
    intents: c.operation === 'comparison' ? [record('09'), record('08')] : [record('09')] } };
}
async function answer(c, accounts, f, request = protocol(c), implementation = withLedgerAnswer) {
  try {
    populate(f, accounts);
    Object.assign(f.env, { RERANK_MODEL: 'claude-haiku-4-5-20251001', ANTHROPIC_API_KEY: 'synthetic-unused' });
    const { question, reply } = request;
    let calls = 0;
    const response = await implementation({ env: f.env, question, now: NOW,
      grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
        calls++; return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
      } }, async gap => Response.json({ answer: gap?.detail || null, ledger: null, citations: [], gaps: gap ? [gap] : [] }));
    const body = await response.json();
    assert.equal(calls, 1, `case ${c.id}: injected extractor must be reached`);
    return body;
  } finally {
    // Reader batches own their transactions, so reset between cases rather
    // than enclosing those batches inside a test savepoint.
    f.sqlite.exec("DELETE FROM fin_transactions; DELETE FROM fin_balance_snapshots; DELETE FROM fin_account_coverage; DELETE FROM fin_accounts; DELETE FROM fin_entities WHERE entity_slug <> 'owner-company';");
    f.seen.length = 0;
    f.queries.length = 0;
  }
}
const sum = (accounts, field, factor = 1) => accounts.reduce((n, a) => n + a[field] * factor, 0);
function expected(c, accounts) {
  if (c.operation === 'balance') return accounts.map(a => [String(1000 + a.id), a.balance]).sort();
  if (c.operation === 'in') return sum(accounts, 'incoming');
  // Ownership selects the denominator first. Ordinary spending then excludes
  // loan activity under the day-one contract; balances and income retain it.
  const spending = accounts.filter(a => a.kind !== 'loan');
  if (c.operation === 'out') return sum(spending, 'charge', 4);
  if (c.operation === 'largest') return accounts.flatMap(a => Array(4).fill(a.charge)).sort((a, b) => b - a);
  // Weekly series annualized to months, rounded per series in integer cents.
  if (c.operation === 'recurring') return accounts.reduce((n, a) => n + Math.floor((a.charge * 52 + 6) / 12), 0);
  return [sum(spending, 'charge', 4), sum(spending, 'charge', 4) + spending.length * 68];
}
function observed(c, body) {
  const l = body.ledger;
  if (!l) return null;
  if (c.operation === 'balance') return l.accounts?.map(a => [a.account_mask, a.current_minor]).sort();
  if (c.operation === 'in') return l.combined_inflow_minor ?? l.accounts?.reduce((n, a) => n + a.credits_minor, 0);
  if (c.operation === 'out') return l.expense_total_minor ?? l.total_minor;
  if (c.operation === 'largest') return l.rows?.map(r => r.amount_minor).sort((a, b) => b - a);
  if (c.operation === 'recurring') return l.monthly_total_minor;
  return l.parts?.map(p => p.expense_total_minor ?? p.total_minor);
}
// Each population has fresh SQLite row IDs. A citation locator is the only
// unstable field; ownership additions must preserve everything else, including
// prose, completeness, coverage, and the cited account/amount/date evidence.
function semanticAnswer(body) {
  return JSON.parse(JSON.stringify(body, (key, value) =>
    key === 'ref' && /^ledger:(?:balance|transaction):\d+$/.test(value) ? value.replace(/:\d+$/, ':row') : value));
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('ownership selection reaches payment and transaction snapshot readers', async () => {
  const f = fixture();
  const accounts = [
    { id: 0, owner: 'business', kind: 'checking', balance: 10000, incoming: 12345, charge: 100 },
    { id: 1, owner: 'personal', kind: 'checking', balance: 20000, incoming: 12345, charge: 200 },
    { id: 2, owner: 'unknown', kind: 'checking', balance: 30000, incoming: 12345, charge: 300 },
  ];
  try {
    for (const kind of ['payment', 'transactions']) for (const hint of ['business', 'business checking', 'our company savings']) {
      const record = { kind, direction: 'inflow', count: null, vendor_text: null,
        account_hint: hint, amount_text: kind === 'payment' ? '$123.45' : null,
        date_text: null, period: { type: 'between', from: '2026-09-01', to: '2026-09-30' } };
      const body = await answer({ id: kind }, accounts, f, {
        question: `Could you retrieve ${kind === 'payment' ? 'the $123.45 payment' : 'incoming transactions'} for ${hint} accounts in September 2026?`,
        reply: { ambiguous: false, unanswered_part: null, intents: [record] },
      });
      assert.equal(body.ledger?.kind, kind);
      assert.equal(body.ledger.complete, false);
      assert.equal(body.evidence_gate.complete, false);
      assert.ok(body.citations.length > 0);
      assert.ok(body.citations.every(ref => ref.account_mask === '1000'));
      assert.match(body.answer, /Ownership is unconfirmed/);
    }
  } finally { f.close(); }
});

function violations(c, body) {
  const scoped = ['business', 'personal'].includes(c.scope);
  const selected = scoped ? c.accounts.filter(a => a.owner === c.scope)
    : c.scope === 'nickname' && c.alias === 'Account 0' ? c.accounts.filter(a => a.id === 0) : c.accounts;
  if (c.operation === 'comparison' && c.scope === 'nickname' && c.alias === 'Reserve Box' &&
      body.ledger?.kind === 'scope_refused' && body.ledger.reason === 'scope_unresolved') {
    assert.deepEqual(body.ledger, { kind: 'scope_refused', complete: false, reason: 'scope_unresolved' });
    assert.deepEqual(body.citations, []);
    assert.equal(body.evidence_gate.complete, false);
    assert.match(body.answer, /unresolved.*No scoped total or difference/);
    return [];
  }
  const got = observed(c, body), want = expected(c, selected), failures = [];
  const hasFigure = got !== null && got !== undefined;
  if (scoped && !selected.length) {
    if (hasFigure) failures.push('no_match_figure');
    if (!/no .*account|cannot .*account|could not .*account|no confirmed|none .*account/i.test(body.answer || '')) failures.push('no_match_wording');
  } else if (!hasFigure) failures.push('over_refusal');
  else if (!equal(got, want)) failures.push('ownership_figure');
  const allowedMasks = new Set(selected.map(a => String(1000 + a.id)));
  if (scoped && selected.length && (body.citations || []).some(citation =>
      citation.source_kind === 'ledger' && !allowedMasks.has(citation.account_mask)) &&
      !failures.includes('ownership_figure')) failures.push('ownership_figure');
  if (c.operation === 'comparison' && body.ledger?.comparison && selected.length &&
      (!equal(body.ledger.comparison.figures_minor, want) ||
       body.ledger.comparison.difference_minor !== want[0] - want[1]) &&
      !failures.includes('ownership_figure')) failures.push('ownership_figure');
  if (scoped && c.accounts.some(a => a.owner === 'unknown') && selected.length &&
      (!/partial|incomplete|ownership.*(?:unknown|unconfirmed)|(?:unknown|unconfirmed).*ownership/i.test(body.answer || '') ||
       (body.ledger?.kind === 'multi' ? body.ledger.parts : [body.ledger]).some(part => part?.complete === true) || body.evidence_gate?.complete === true)) failures.push('unknown_complete');
  if (c.scope === 'nickname' && c.alias === 'Reserve Box' && !/all your accounts|all accounts/i.test(body.answer || '')) failures.push('nickname_note');
  return failures;
}

export async function findOwnerScope({ shrink = true, population = cases, seed = SEED } = {}) {
  const shared = fixture();
  const runAnswer = (c, accounts = c.accounts) => answer(c, accounts, shared);
  try {
    const groups = new Map();
    const roots = new Map();
    const rootFor = key => ['ownership_figure', 'no_match_figure', 'other_owner_changes_answer'].includes(key)
      ? 'ownership_selection' : key === 'unknown_complete' ? 'ownership_completeness'
        : key === 'no_match_wording' ? 'scoped_absence_wording' : key;
    let wrong = 0, refusals = 0, metamorphic = 0;
    const record = (key, c) => {
      if (!groups.has(key)) groups.set(key, { count: 0, example: c });
      groups.get(key).count++;
      const root = rootFor(key);
      if (!roots.has(root)) roots.set(root, new Set());
      roots.get(root).add(c.id);
    };
    for (const c of population) {
      const body = await runAnswer(c), failures = violations(c, body);
      if (failures.some(k => ['ownership_figure', 'no_match_figure'].includes(k))) wrong++;
      if (failures.includes('over_refusal')) refusals++;
      for (const key of failures) record(key, c);
      if (['business', 'personal'].includes(c.scope) && c.accounts.length < 6) {
        const extra = { id: 9, owner: c.scope === 'business' ? 'personal' : 'business', kind: 'checking', balance: 987654, incoming: 87654, charge: 7654 };
        const after = await runAnswer(c, [...c.accounts, extra]);
        metamorphic++;
        // Compare the whole answer after normalizing fresh citation row IDs.
        if (!equal(semanticAnswer(body), semanticAnswer(after))) record('other_owner_changes_answer', c);
      }
    }
    const details = [];
    for (const [key, group] of groups) {
      let minimal = group.example;
      if (shrink) for (let i = minimal.accounts.length - 1; i >= 0; i--) {
        if (minimal.accounts.length === 1) break;
        const candidate = { ...minimal, accounts: minimal.accounts.filter((_, index) => index !== i) };
        const b = await runAnswer(candidate);
        let persists = violations(candidate, b).includes(key);
        if (key === 'other_owner_changes_answer') {
          const extra = { id: 9, owner: candidate.scope === 'business' ? 'personal' : 'business', kind: 'checking', balance: 987654, incoming: 87654, charge: 7654 };
          persists = !equal(semanticAnswer(b), semanticAnswer(await runAnswer(candidate, [...candidate.accounts, extra])));
        }
        if (persists) minimal = candidate;
      }
      details.push({ property: key, count: group.count, minimal });
    }
    return { seed, cases: population.length, metamorphic, wrong_figures: wrong, groups: roots.size, over_refusals: refusals, roots: [...roots].map(([cause, ids]) => ({ cause, cases: ids.size })), details };
  } finally { shared.close(); }
}

test('seeded ownership properties through real ledger answers (600 cases)', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  const result = await findOwnerScope();
  console.log(JSON.stringify(result));
  assert.equal(result.cases, 600);
  assert.equal(result.metamorphic, 233);
  if (!process.argv.includes('--find-owner-scope')) assert.equal(result.groups, 0,
    `ownership properties failed: ${result.details.map(g => `${g.property}=${g.count}`).join(', ')}`);
});
// Independent seed and vocabulary; every operation includes green nickname and
// unscoped controls alongside compound ownership hints.
const compoundSeed = 0x05112026;
state = compoundSeed;
const compoundAliases = {
  business: ['our business', 'my company', 'business checking', 'corporate', 'company savings'],
  personal: ['my personal', 'our household', 'personal checking', 'my own accounts', 'personal savings'],
  nickname: aliases.nickname, none: aliases.none,
};
const compoundCases = [];
for (let round = 0; round < 25; round++) for (const operation of operations) for (const scope of scopes) {
  const accounts = Array.from({ length: 1 + random(6) }, (_, id) => ({
    id, owner: ownership[random(3)], kind: kinds[random(4)],
    balance: 10000 + random(900000), incoming: 1000 + random(90000), charge: 100 + random(9000),
  }));
  compoundCases.push({ id: compoundCases.length, operation, scope,
    alias: compoundAliases[scope][round % compoundAliases[scope].length], accounts });
}
test('compound ownership hints preserve the denominator (600 sibling cases)', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  const result = await findOwnerScope({ population: compoundCases, seed: compoundSeed });
  console.log(JSON.stringify(result));
  assert.equal(result.cases, 600);
  assert.equal(result.metamorphic, 251);
  assert.equal(result.groups, 0, JSON.stringify(result.details));
});
test('review exact compound checking inputs exclude opposite figures and citations', async t => {
  const f = fixture();
  const accounts = [
    { id: 0, owner: 'personal', kind: 'checking', balance: 12345, incoming: 100, charge: 100 },
    { id: 1, owner: 'business', kind: 'checking', balance: 67890, incoming: 200, charge: 200 },
  ];
  try {
    for (const scope of ['business', 'personal']) await t.test(scope, async () => {
      const c = { id: 0, operation: 'balance', scope, alias: `${scope} checking`, accounts };
      const request = protocol(c);
      assert.equal(request.question, `Could you retrieve bank balances for ${scope} checking accounts?`);
      const body = await answer(c, accounts, f, request);
      assert.deepEqual(violations(c, body), []);
      assert.match(body.answer, scope === 'business' ? /678[.]90/ : /123[.]45/);
      assert.doesNotMatch(body.answer, scope === 'business' ? /123[.]45/ : /678[.]90/);
      const control = { ...c, scope: 'none', alias: '' };
      assert.deepEqual(violations(control, await answer(control, accounts, f)), []);
    });
  } finally { f.close(); }
});
test('compound ownership in personal versus business comparisons stays independent per part', async () => {
  const f = fixture();
  const accounts = [
    { id: 0, owner: 'personal', kind: 'checking', balance: 12345, incoming: 100, charge: 111 },
    { id: 1, owner: 'business', kind: 'checking', balance: 67890, incoming: 200, charge: 222 },
    { id: 2, owner: 'unknown', kind: 'card', balance: 90000, incoming: 300, charge: 333 },
  ];
  try {
    const c = { id: 0, operation: 'comparison', scope: 'business', alias: 'business checking', accounts };
    const request = protocol(c);
    request.question = 'Could you retrieve expenses for business checking accounts versus personal checking accounts in September 2026?';
    request.reply.intents[1] = { ...request.reply.intents[0], account_hint: 'personal checking' };
    const body = await answer(c, accounts, f, request);
    assert.deepEqual(body.ledger.parts.map(p => p.expense_total_minor ?? p.total_minor), [888, 444]);
    assert.equal(body.ledger.comparison, undefined, 'unknown ownership forbids an exact difference');
    assert.ok(body.ledger.parts.every(p => p.complete === false));
    assert.equal(body.evidence_gate.complete, false);
    assert.ok(body.citations.every(ref => ref.account_mask !== '1002'));
    assert.match(body.answer, /Ownership is unconfirmed/);
    const complete = await answer(c, accounts.slice(0, 2), f, request);
    assert.deepEqual(complete.ledger.comparison.figures_minor, [888, 444]);
    assert.equal(complete.ledger.comparison.difference_minor, 444);
    const control = { ...c, operation: 'out', scope: 'none', alias: '' };
    assert.deepEqual(violations(control, await answer(control, accounts, f)), []);
  } finally { f.close(); }
});
test('ownership denominator remains independent of residual nickname and conflicting tokens fail closed', async () => {
  const { resolveOwnershipScope } = await import('../src/lib/ledger-owner-scope.js');
  const business = { entity_kind: 'business' }, personal = { entity_kind: 'household' };
  for (const remaining of ['checking', 'savings', 'Reserve Box', 'Account 0', 'unresolved vault']) {
    assert.deepEqual(resolveOwnershipScope([business, personal], `our business ${remaining}`).accounts, [business]);
    assert.deepEqual(resolveOwnershipScope([business, personal], `my personal ${remaining}`).accounts, [personal]);
  }
  assert.equal(resolveOwnershipScope([business, personal], 'business personal checking').empty, true);
  assert.equal(resolveOwnershipScope([business, personal], 'Reserve Box'), null);
});

// Seed 0x6b051127: same-owner additions must not replace a residual label.
test('residual nickname intersection generated readers and green controls', async () => {
  const f = fixture();
  let seed = 0x6b051127;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  try {
    for (const operation of operations) for (const scope of ['business', 'personal']) for (const suffix of ['Reserve', 'Operating', 'Vault', 'Checking']) {
      const prefix = scope === 'business' ? 'Business' : 'Personal';
      const accounts = [0, 1, 2].map(id => ({ id, owner: id === 0 ? (scope === 'business' ? 'personal' : 'business') : scope,
        kind: id === 2 ? 'savings' : 'checking', label: `${id === 0 ? 'Private' : prefix} ${id === 2 ? 'Operating' : suffix}`,
        balance: 10000 + next() % 50000, incoming: 1000 + next() % 5000, charge: 111 * (id + 1) }));
      // Distinct labels even when the generated target is Operating.
      accounts[2].label = `${prefix} Other`;
      const c = { id: 0, operation, scope, alias: `${prefix} ${suffix}`, accounts };
      const body = await answer(c, accounts, f);
      assert.deepEqual(observed(c, body), expected(c, [accounts[1]]), `${operation}/${c.alias}: exact intersection`);
      assert.ok(body.citations.length > 0);
      assert.ok(body.citations.every(ref => ref.account_mask === '1001'));
      const prefixed = { ...c, alias: `our ${c.alias}` };
      assert.deepEqual(observed(prefixed, await answer(prefixed, accounts, f)), expected(c, [accounts[1]]), 'normalized nickname');
      const literalAccounts = accounts.map(a => a.id === 1 ? { ...a, label: prefixed.alias } : a);
      assert.deepEqual(observed(prefixed, await answer(prefixed, literalAccounts, f)), expected(c, [accounts[1]]), 'literal nickname before normalized wording');
      const residualAccounts = accounts.map(a => a.id === 1 ? { ...a, label: suffix } : a);
      // Without an exact full label, Checking retains the existing generic type reading.
      assert.deepEqual(observed(c, await answer(c, residualAccounts, f)), expected(c, suffix === 'Checking' ? accounts.slice(1) : [accounts[1]]), 'residual-only nickname or generic type control');
      const control = { ...c, alias: scope };
      assert.deepEqual(observed(control, await answer(control, accounts, f)), expected(control, accounts.slice(1)), 'bare ownership control');
      const partial = await answer(c, [...accounts, { ...accounts[2], id: 3, owner: 'unknown', label: 'Unclassified' }], f);
      assert.deepEqual(observed(c, partial), expected(c, [accounts[1]]), 'unknown addition preserves selected figures');
      assert.equal(partial.evidence_gate.complete, false);
      assert.ok((operation === 'comparison' ? partial.ledger.parts : [partial.ledger]).every(part => part.complete === false));
      assert.ok(partial.citations.every(ref => ref.account_mask === '1001'));
      const missing = { ...c, alias: `${prefix} Missing` };
      const refused = await answer(missing, accounts, f);
      assert.equal(refused.ledger, null, 'unresolved residual must not produce a figure');
      assert.equal(refused.ownership_scope_empty, true, 'residual selection decision was reached');
      assert.deepEqual(refused.citations, []);
      assert.match(refused.answer, /matching the requested account name/);
    }
  } finally { f.close(); }
});

test('residual nickname payment and transaction readers preserve intersection', async () => {
  const f = fixture();
  const accounts = [0, 1, 2].map(id => ({ id, owner: id ? 'business' : 'personal', kind: 'checking',
    label: id === 0 ? 'Private Reserve' : id === 1 ? 'Business Reserve' : 'Business Operating',
    balance: 10000, incoming: 12345, charge: 111 * (id + 1) }));
  try {
    for (const kind of ['payment', 'transactions']) for (const hint of ['Business Reserve', 'Business Operating']) {
      const record = { kind, direction: 'inflow', count: null, vendor_text: null, account_hint: hint,
        amount_text: kind === 'payment' ? '$123.45' : null, date_text: null,
        period: { type: 'between', from: '2026-09-01', to: '2026-09-30' } };
      const request = { question: `Could you retrieve ${kind === 'payment' ? 'the $123.45 payment' : 'incoming transactions'} for ${hint} accounts in September 2026?`,
        reply: { ambiguous: false, unanswered_part: null, intents: [record] } };
      const body = await answer({ id: kind }, accounts, f, request);
      assert.equal(body.ledger?.kind, kind);
      assert.ok(body.citations.length > 0);
      assert.ok(body.citations.every(ref => ref.account_mask === (hint === 'Business Reserve' ? '1001' : '1002')));
      record.account_hint = 'business';
      request.question = request.question.replace(hint, 'business');
      const control = await answer({ id: kind }, accounts, f, request);
      assert.equal(control.ledger?.kind, kind);
      assert.deepEqual([...new Set(control.citations.map(ref => ref.account_mask))].sort(), ['1001', '1002']);
    }
  } finally { f.close(); }
});

test('review exact Business Reserve and Business Operating expenses', async t => {
  const f = fixture();
  const accounts = [0, 1, 2].map(id => ({ id, owner: id ? 'business' : 'personal', kind: id === 2 ? 'savings' : 'checking',
    label: ['Private Reserve', 'Business Reserve', 'Business Operating'][id], balance: 10000, incoming: 12345, charge: 111 * (id + 1) }));
  try {
    for (const [alias, cents, mask] of [['Business Reserve', 888, '1001'], ['Business Operating', 1332, '1002']]) await t.test(alias, async () => {
      const c = { id: 0, operation: 'out', scope: 'business', alias, accounts };
      const request = protocol(c);
      assert.equal(request.question, `Could you retrieve money out for ${alias} accounts in September 2026?`);
      const control = { ...c, alias: 'business' };
      assert.equal((await answer(control, accounts, f)).ledger.expense_total_minor, 2220);
      const body = await answer(c, accounts, f, request);
      assert.equal(body.ledger.expense_total_minor, cents);
      assert.ok(body.citations.length > 0);
      assert.ok(body.citations.every(ref => ref.account_mask === mask));
    });
  } finally { f.close(); }
});

// Import isolated source variants: every mutant must fail the very same
// figure/citation contract that passes against the shipped implementation.
const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
const absoluteImports = (source, url) => source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
  (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
const encodedModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
for (const [name, before, after, operation, alias, special] of [
  ['ownership selection', 'resolveOwnershipScope(inventory, intent.modelAccountScope || intent.entityKind)', 'null', 'balance', 'business'],
  ['unknown completeness', 'if (ownershipScope?.unknown.length)', 'if (false)', 'balance', 'business', 'unknown'],
  ['empty denominator', 'if (intent.ownershipScope?.empty) return', 'if (false) return', 'out', 'business', 'empty'],
  ['reader inventory fence', 'readEffectiveBalances(env, inventory,', 'readEffectiveBalances(env, accounts,', 'balance', 'business'],
  ['nickname intersection', 'accounts = accountsForSelector(accounts, selector);', 'accounts = ownershipScope.accounts;', 'balance', 'Business Reserve', 'nickname'],
  ['missing nickname refusal', 'accounts = accountsForSelector(accounts, intent.accountSelector, Boolean(intent.modelAccountScope), intent.kind === \'balance\');', 'accounts = accountsForSelector(accounts, intent.accountSelector, Boolean(intent.modelAccountScope), intent.kind === \'balance\').length ? accountsForSelector(accounts, intent.accountSelector, Boolean(intent.modelAccountScope), intent.kind === \'balance\') : inventory;', 'balance', 'Business Missing', 'emptyNickname'],
  ['normalized nickname', '[intent.modelAccountScope, ownershipScope.selector, ownershipScope.residual]', '[intent.modelAccountScope, ownershipScope.residual]', 'balance', 'our Business Reserve', 'nickname'],
  ['literal nickname', '[intent.modelAccountScope, ownershipScope.selector, ownershipScope.residual]', '[ownershipScope.selector, ownershipScope.residual]', 'balance', 'our Business Reserve', 'literal'],
  ['ranking account suffix', "words = words.replace(/\\bselector accounts?\\b/g, 'selector')", 'words = words', 'largest', 'business'],
  ['single type-name intersection', 'accounts = accounts.filter(account => accountSelectorRank(account, exact) === 2);', 'accounts = ownershipScope.accounts;', 'balance', 'Business Checking', 'nickname'],
  ['single outside type-name refusal', 'else if (selectors.some(value => inventory.some(account => accountSelectorRank(account, value) === 2))) accounts = [];', 'else if (false) accounts = [];', 'balance', 'Business Checking', 'emptyType'],
  ['comparison ownership preflight', 'const ownership = resolveOwnershipScope(inventory, literal);', 'const ownership = null;', 'comparison', 'business checking', 'scopeModule'],
]) test(`S5 restoring ${name} mutant is killed`, async () => {
  const f = fixture();
  const accounts = [0, 1, 2].map(id => ({ id, owner: id ? 'business' : 'personal', kind: 'checking',
    label: id === 1 ? special === 'literal' ? alias : 'Business Reserve' : id === 2 ? 'Business Operating' : 'Private',
    balance: 10000 * (id + 1), incoming: 12345, charge: 111 * (id + 1) }));
  if (name === 'single type-name intersection') accounts[1].label = alias;
  if (special === 'emptyType') accounts[0].label = alias;
  if (name === 'ownership selection') accounts.forEach(a => { a.label = `Account ${a.id}`; });
  if (special === 'unknown') accounts.push({ ...accounts[0], id: 3, owner: 'unknown' });
  if (special === 'empty') accounts.splice(1);
  const c = { id: 0, operation, scope: 'business', alias, accounts };
  const contract = async implementation => {
    const body = await answer(c, accounts, f, protocol(c), implementation);
    if (['empty', 'emptyNickname', 'emptyType'].includes(special)) {
      assert.equal(body.ownership_scope_empty, true);
      assert.equal(body.ledger, null);
      assert.deepEqual(body.citations, []);
    } else {
      const selected = ['nickname', 'literal'].includes(special) ? [accounts[1]] : accounts.filter(a => a.owner === 'business');
      assert.deepEqual(observed(c, body), expected(c, selected));
      assert.ok(body.citations.length);
      assert.ok(body.citations.every(ref => selected.some(a => String(1000 + a.id) === ref.account_mask)));
      if (special === 'unknown') {
        assert.equal(body.ledger.ownership_incomplete, true);
        assert.equal(body.evidence_gate.complete, false);
        assert.match(body.answer, /Ownership is unconfirmed/);
      }
    }
  };
  try {
    await contract(withLedgerAnswer);
    let source = readFileSync(answerUrl, 'utf8');
    if (special === 'scopeModule') {
      const url = new URL('../src/lib/ledger-intent-scope.js', import.meta.url);
      const original = readFileSync(url, 'utf8');
      assert.ok(original.includes(before), name);
      source = source.replace('"./ledger-intent-scope.js"', `"${encodedModule(absoluteImports(original.replace(before, after), url))}"`);
    } else {
      assert.ok(source.includes(before), name);
      source = source.replace(before, after);
      // The second literal selection must also lose the intersection to restore
      // the historical ownership-replaces-nickname defect completely.
      if (name === 'nickname intersection') source = source.replace(
        'accounts = accountsForSelector(accounts, intent.accountSelector, Boolean(intent.modelAccountScope), intent.kind === \'balance\');',
        'accounts = ownershipScope.accounts;');
    }
    const mutant = await import(encodedModule(absoluteImports(source, answerUrl)));
    await assert.rejects(() => contract(mutant.withLedgerAnswer), assert.AssertionError, name);
  } finally { f.close(); }
});
