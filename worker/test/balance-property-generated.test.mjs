import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { total, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';
import { randomBytes } from 'node:crypto';
import { sumMinor } from '../src/lib/ledger-analysis.js';

// Fixed synthetic protocol replies exercise the real parser, account resolver,
// SQLite readers and renderer. The oracle never imports product arithmetic.
const diagnostic = process.argv.includes('--find-balances');
const seeds = [0x11052026, 0x427cafe];
const kinds = ['checking', 'checking', 'savings', 'card', 'loan', 'checking', 'savings'];
const labels = ['operating', 'household', 'reserve', 'charge', 'advance', 'retired', 'reserve plus'];
function generate() {
  const cases = [];
  for (const seed of seeds) {
    let state = seed;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let i = 0; i < 320; i++) {
      const accounts = kinds.map((kind, j) => ({ id: `account-${j}`, mask: String(1100 + j), kind,
        label: labels[j], personal: j === 1, closed: j === 5, history: true,
        cents: String(100 + random() % 900000), date: i % 4 === 0 && j === 0 ? '2026-09-01' : '2026-10-12',
        missing: i % 8 === 1 && j === 0, partial: i % 8 === 2 && j === 0 }));
      const mode = i % 10;
      const ambiguous = i % 20 === 6;
      if (ambiguous) accounts[6].mask = '1100';
      const questions = ["what's my operating balance", 'how much is in operating', 'how much cash do I have',
        "what's in my business accounts", 'total in checking', 'what do I owe on my card',
        "what's my account ending 1100 balance", "what's my reserve balance", "what's my loan balance", "what's my checking balance"];
      const hints = ['operating', 'operating', null, 'business accounts', 'checking', 'card', '1100', 'reserve', 'loan', 'checking'];
      if (i % 20 === 2) questions[2] += ' without card debt';
      const selected = mode === 2 ? accounts.filter(a => !a.closed) : mode === 3 ? accounts.filter(a => !a.closed && !a.personal)
        : mode === 4 || mode === 9 ? accounts.filter(a => !a.closed && a.kind === 'checking')
        : accounts.filter(a => !a.closed && (mode === 5 ? a.kind === 'card' : mode === 8 ? a.kind === 'loan' : mode === 7 ? a.label === 'reserve' : a.mask === '1100'));
      cases.push({ seed, i, mode, ambiguous, question: questions[mode], hint: hints[mode], accounts,
        expected: selected.map(a => a.mask), rows: accounts.filter(a => !a.closed).flatMap(a => [
          { account: a.id, pending: 0, cents: String(1 + random() % 9000) },
          { account: a.id, pending: 1, cents: String(1 + random() % 9000) }]) });
    }
  }
  return cases;
}

let f;
async function evaluate(c) {
  try {
    f.owner();
    f.raw(`INSERT INTO fin_entities (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
      VALUES ('household','Synthetic household','household','owned','owner_stated','confirmed',?)`, NOW);
    for (const a of c.accounts) {
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,label,account_kind,balance_role,mask,status,feed_mode,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,?,'manual','owner_stated','confirmed',?)`, a.id, a.personal ? 'household' : 'owner', a.label, a.kind,
      ['card', 'loan'].includes(a.kind) ? 'liability' : 'asset', a.mask, a.closed ? 'closed' : 'open', NOW);
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,?,'2026-01-01','2026-10-12',?,'owner_stated','confirmed',?)`, a.id, a.partial ? 'partial' : 'complete', NOW, NOW);
      if (!a.missing) {
        if (a.history) f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
          VALUES (?,'2026-08-01',?,'owner_stated','confirmed',?)`, a.id, Number(a.cents) - 1, NOW);
        f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
          VALUES (?,?,?,'owner_stated','confirmed',?)`, a.id, a.date, Number(a.cents), NOW);
      }
    }
    for (const [i, row] of c.rows.entries()) f.raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,'owner_stated','confirmed',?)`, `row-${i}`, row.account, row.date || '2026-10-12', Number(row.cents), row.direction || 'outflow', row.pending, NOW);
    const response = await withLedgerAnswer({ env: f.env, question: c.question, now: Date.parse(NOW),
      grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => ({ content: [{ type: 'text', text: JSON.stringify({
        intents: [{ kind: 'balance', account_hint: c.hint, direction: null, count: null, vendor_text: null,
          amount_text: null, date_text: null, period: { type: 'none' } }] }) }] }) },
    async gap => Response.json({ gaps: gap ? [gap] : [], answer: null }));
    const body = await response.json(), ledger = body.ledger;
    const issues = [];
    const expected = c.accounts.filter(a => c.expected.includes(a.mask));
    const figures = displayFigures(body.answer);
    // ROUTE-GAPS owns the nickname gate; retain these cases as expected refusals.
    if (c.mode === 1) { assert.notEqual(ledger?.kind, 'balance'); return { issues: [], body }; }
    const refused = ledger?.kind !== 'balance';
    if (refused) {
      if (!c.ambiguous && expected.length && expected.every(a => !a.missing)) issues.push('over-refusal');
      return { issues, body };
    }
    if (c.ambiguous && expected.length > 1 && figures.length && body.evidence_gate?.complete !== false &&
        (ledger.accounts.length === 1 || ledger.cash_only?.total_minor != null))
      issues.push('ambiguous-confident');
    if (!c.closedLookup && ledger.accounts.some(row => c.accounts.some(a => a.closed && a.mask === row.account_mask)))
      issues.push('current-account-denominator');
    // Business ownership selection is already owned by the owner-scope lane.
    if (c.mode !== 3) {
      const actual = ledger.accounts.map(a => a.account_mask).sort();
      const wanted = expected.map(a => a.mask).sort();
      const openActual = actual.filter(mask => !c.accounts.some(a => a.closed && a.mask === mask));
      if (JSON.stringify(c.closedLookup ? actual : openActual) !== JSON.stringify(wanted)) issues.push('selector-scope');
    }
    for (const row of ledger.accounts) {
      const candidates = c.accounts.filter(a => a.mask === row.account_mask);
      if (row.balance_group === 'cash' && candidates.every(a => ['card', 'loan'].includes(a.kind))) issues.push('liability-in-cash');
      if (!candidates.some(a => String(row.current_minor) === a.cents)) issues.push('snapshot-value');
      if (!candidates.some(a => row.as_of === a.date) || !/as of/i.test(body.answer)) issues.push('snapshot-date');
    }
    if (ledger.cash_only?.total_minor != null) {
      const cash = expected.filter(a => ['checking', 'savings'].includes(a.kind));
      if (String(ledger.cash_only.total_minor) !== total(cash.map(a => a.cents))) issues.push('current-account-denominator');
    }
    const allowed = new Set(ledger.accounts.map(a => String(a.current_minor)));
    const pendingRows = c.rows.filter(r => r.pending && c.accounts.some(a => a.id === r.account && (r.date || '2026-10-12') >= a.date && ledger.accounts.some(row => row.account_mask === a.mask)));
    const pendingOutflow = total(pendingRows.filter(r => r.direction !== 'inflow').map(r => r.cents));
    const pendingInflow = total(pendingRows.filter(r => r.direction === 'inflow').map(r => r.cents));
    if (pendingRows.length) {
      assert.equal(String(ledger.observation?.pending?.outflow_minor), pendingOutflow);
      assert.equal(String(ledger.observation?.pending?.inflow_minor), pendingInflow);
      assert.equal(ledger.observation?.pending?.treatment, 'not_included');
      assert.match(body.answer, /not yet included/);
    }
    allowed.add(pendingOutflow);
    allowed.add(pendingInflow);
    if (ledger.cash_only?.total_minor != null) allowed.add(String(ledger.cash_only.total_minor));
    if (figures.some(figure => !allowed.has(figure.cents))) issues.push('rendered-value');
    const selectedPending = c.rows.some(r => r.pending && expected.some(a => a.id === r.account));
    if (selectedPending && figures.length && !/pending/i.test(body.answer)) issues.push('pending-silent');
    // A dated per-account historical observation is safe with partial history;
    // a complete combined figure requires a complete denominator.
    if (expected.some(a => a.partial) && ledger.cash_only?.total_minor != null && body.evidence_gate?.complete !== false)
      issues.push('partial-confident-total');
    if (expected.some(a => a.missing) && figures.length) issues.push('missing-confident');
    return { issues: [...new Set(issues)], body };
  } finally {
    for (const table of ['fin_transactions', 'fin_balance_snapshots', 'fin_account_coverage', 'fin_accounts', 'fin_entities'])
      f.raw(`DELETE FROM ${table}`);
  }
}

// Deletion minimization runs for EVERY failing case, retaining the same cause.
// An irreducible witness is relative to account and transaction deletion, not
// a claim of globally minimal natural-language wording.
async function shrink(c, cause) {
  let small = structuredClone(c);
  for (const field of ['accounts', 'rows']) {
    for (let i = small[field].length - 1; i >= 0; i--) {
      const candidate = structuredClone(small);
      const removed = candidate[field].splice(i, 1)[0];
      if (field === 'accounts') {
        candidate.rows = candidate.rows.filter(r => r.account !== removed.id);
        candidate.expected = candidate.expected.filter(mask => mask !== removed.mask);
      }
      if ((await evaluate(candidate)).issues.includes(cause)) small = candidate;
    }
  }
  for (let i = 0; i < small.accounts.length; i++) {
    const candidate = structuredClone(small);
    candidate.accounts[i].history = false;
    if ((await evaluate(candidate)).issues.includes(cause)) small = candidate;
  }
  return small;
}

test('seeded balance properties: independent cents and explicit uncertainty', async t => {
  f = fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.env.AI = { run: async () => assert.fail('model binding forbidden') };
  const cases = generate(), groups = {}, wrong = new Set(), refusals = new Set(), violations = new Set();
  for (const c of cases) {
    const result = await evaluate(c);
    if (process.argv.includes('--sample') && c.i === 11) console.log(JSON.stringify(result.body));
    if (process.argv.includes('--mutant') || process.env.BRAIN_BALANCE_MUTANT === '1') assert.deepEqual(result.issues, []);
    for (const cause of result.issues) {
      const key = `${c.seed}:${c.i}`;
      violations.add(key);
      if (cause === 'over-refusal') refusals.add(key);
      else if (!['pending-silent', 'snapshot-date', 'partial-confident-total'].includes(cause)) wrong.add(key);
      const witness = await shrink(c, cause);
      const group = groups[cause] ||= { count: 0, witness };
      group.count++;
      if (witness.accounts.length + witness.rows.length < group.witness.accounts.length + group.witness.rows.length) group.witness = witness;
    }
  }
  const summary = { pending_disclosure_failures: groups['pending-silent']?.count || 0, cases: cases.length, wrong_figures: wrong.size, groups: Object.keys(groups).length,
    over_refusals: refusals.size, violating_cases: violations.size, failures: groups };
  console.log(JSON.stringify(summary));
  assert.equal(cases.length, 640);
  if (!diagnostic) assert.equal(violations.size, 0, 'generated balance violations; use --find-balances for a grouped inventory');
});


// Targeted boundaries complement the generated current-account denominator.
test('closed account is excluded once from current totals but directly readable', async t => {
  f = fixture(t);
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  const c = generate()[0];
  c.accounts = c.accounts.filter(a => [0, 5].includes(Number(a.id.split('-')[1])));
  c.rows = [];
  c.mode = 2; c.question = 'how much cash do I have'; c.hint = null; c.expected = ['1100'];
  const current = await evaluate(c);
  assert.deepEqual(current.issues, []);
  assert.equal((current.body.answer.match(/closed, not counted/g) || []).length, 1);
  c.mode = 0; c.question = "what's my retired balance"; c.hint = 'retired'; c.expected = ['1105']; c.closedLookup = true;
  const direct = await evaluate(c);
  assert.deepEqual(direct.issues, []);
  assert.equal(direct.body.ledger?.kind, 'balance');
  assert.equal(direct.body.ledger.accounts.length, 1);
  assert.equal(String(direct.body.ledger.accounts[0].current_minor), c.accounts[1].cents);
  assert.match(direct.body.answer, /closed; its last recorded balance/);
  assert.match(direct.body.answer, /as of/);
});

test('pending movements after each snapshot stay separate, with inflows and outflows explicit', async t => {
  f = fixture(t);
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  const c = generate()[0];
  c.accounts = c.accounts.filter(a => [0, 5].includes(Number(a.id.split('-')[1])));
  c.mode = 2; c.question = 'how much cash do I have without card debt'; c.hint = null; c.expected = ['1100'];
  c.rows = [
    { account: 'account-0', pending: 1, cents: '1100', date: '2026-08-31' },
    { account: 'account-0', pending: 1, cents: '7209', date: '2026-10-12' },
    { account: 'account-0', pending: 1, cents: '900', direction: 'inflow', date: '2026-10-12' },
    { account: 'account-5', pending: 1, cents: '99999', date: '2026-10-12' },
  ];
  const result = await evaluate(c);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.body.ledger.observation.pending,
    { count: 2, outflow_minor: 7209, inflow_minor: 900, treatment: 'not_included' });
  assert.equal(String(result.body.ledger.cash_only.total_minor), c.accounts[0].cents);
  assert.match(result.body.answer, /outflows \$72\.09; inflows \$9\.00/);
});

// R1: seed 0x6b0427a2 crosses every persisted status pair with identity forms,
// including exact-versus-kind-stripped ranks in both inventory orders.
// The control uses the identical request before its competing account exists.
function balanceIdentityRows() {
  let state = 0x6b0427a2;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const rows = [];
  for (const left of ['open', 'closed', 'never_connected']) for (const right of ['open', 'closed', 'never_connected']) {
    for (const selector of ['mask', 'label', 'normalized label', 'kind-stripped label', 'mixed-rank label', 'reversed mixed-rank label', 'normalized mixed-rank label']) for (const renderer of ['direct', 'clarification']) {
      // The extractor's existing four-digit calendar gate refuses before the
      // ledger. Exercise those masks through the direct parser; keep every
      // clarification row admitted so its negative cannot pass vacuously.
      const index = rows.length, width = 1 + Math.floor(index / 8) % (renderer === 'direct' ? 4 : 3);
      rows.push({ left, right, selector, renderer, mask: String(random() % 10 ** width).padStart(width, '0'),
        kind: ['checking', 'savings', 'card', 'loan', 'line_of_credit'][index % 5],
        cents: 100 + random() % 900000, otherCents: 1000000 + random() % 900000 });
    }
  }
  return rows;
}

function addIdentityAccount(f, { slug, mask, label, kind = 'checking', status = 'open', cents }) {
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,label,account_kind,balance_role,mask,status,closed_on,feed_mode,provenance,basis_state,recorded_at)
    VALUES (?,'owner',?,?,?,?,?,?,'manual','owner_stated','confirmed',?)`, slug, label, kind,
  ['card', 'loan', 'line_of_credit'].includes(kind) ? 'liability' : 'asset', mask, status, status === 'closed' ? '2026-09-15' : null, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES (?,'complete','2026-01-01','2026-10-12',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
  f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
    VALUES (?,'2026-10-11',?,'owner_stated','confirmed',?)`, slug, cents, NOW);
}

async function askIdentity(f, question, hint, renderer) {
  const start = f.calls.length;
  let modelCalls = 0;
  const response = await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
      modelCalls++;
      return { content: [{ type: 'text', text: JSON.stringify({ intents: [{ kind: 'balance', account_hint: hint,
        direction: null, count: null, vendor_text: null, amount_text: null, date_text: null, period: { type: 'none' } }] }) }] };
    } }, async gap => Response.json({ answer: null, gaps: gap ? [gap] : [] }));
  const body = await response.json();
  assert.equal(modelCalls, renderer === 'clarification' ? 1 : 0, 'the intended parser/renderer ran');
  assert.ok(f.calls.slice(start).some(sql => /FROM fin_accounts a/.test(sql)), 'real inventory decision reached');
  return { body, calls: f.calls.slice(start) };
}

for (const [index, row] of balanceIdentityRows().entries()) {
  test(`balance identity ${index}: ${row.left}/${row.right}, ${row.selector}, ${row.renderer}`, async t => {
    const f = fixture(t); f.owner();
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    const label = ['normalized label', 'normalized mixed-rank label'].includes(row.selector) ? 'Ｒｅｓｅｒｖｅ   Ｐｌｕｓ'
      : ['kind-stripped label', 'reversed mixed-rank label'].includes(row.selector) ? 'Reserve Plus checking' : 'Reserve Plus';
    const hint = row.selector === 'mask' ? row.mask : 'reserve plus';
    const question = row.renderer === 'direct'
      ? row.selector === 'mask' ? `What is my balance for account ${row.mask}?` : 'What is my reserve plus balance?'
      : row.selector === 'mask' ? `Could you retrieve the balance for account ending ${row.mask}?` : 'Could you retrieve my reserve plus balance?';
    addIdentityAccount(f, { slug: 'first', mask: row.mask, label, kind: row.kind, cents: row.cents });
    const green = await askIdentity(f, question, hint, row.renderer);
    assert.equal(green.body.ledger?.kind, 'balance', 'unique selector control resolves');
    assert.deepEqual(green.body.ledger.accounts.map(a => a.current_minor), [row.cents]);
    assert.equal(green.body.ledger.accounts[0].as_of, '2026-10-11');
    assert.equal(green.body.ledger.complete, true, 'unique selector has complete recorded evidence');
    f.raw('UPDATE fin_accounts SET status=?,closed_on=? WHERE account_slug=?', row.left,
      row.left === 'closed' ? '2026-09-15' : null, 'first');
    addIdentityAccount(f, { slug: 'second', mask: row.selector === 'mask' ? row.mask : '9900',
      label: row.selector === 'mask' ? 'Other reserve' : row.selector === 'kind-stripped label'
        ? 'reserve plus savings' : ['mixed-rank label', 'normalized mixed-rank label'].includes(row.selector)
          ? 'reserve plus checking' : 'reserve plus', kind: row.kind, status: row.right, cents: row.otherCents });
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_accounts').n, 2, 'competing inventory is nonempty');
    const bad = await askIdentity(f, question, hint, row.renderer);
    const listed = row.left === 'open' && row.right === 'open' &&
      (row.selector !== 'mask' || row.renderer === 'clarification');
    if (listed) {
      assert.equal(bad.body.ledger?.kind, 'balance', 'existing named-selector lists retain every open candidate');
      assert.deepEqual(bad.body.ledger.accounts.map(a => a.current_minor).sort((a, b) => a - b),
        [row.cents, row.otherCents].sort((a, b) => a - b));
      assert.equal(bad.body.ledger.accounts.length, 2);
      assert.equal(bad.body.ledger.selector_ambiguous, true);
      assert.equal(bad.body.ledger.observation.selection_complete, false);
      assert.equal(bad.body.ledger.complete, false);
      assert.equal(bad.body.evidence_gate.complete, false, 'separate observations cannot certify one account choice');
      assert.equal(bad.body.ledger.cash_only?.total_minor ?? null, null);
      assert.ok(bad.calls.some(sql => /WITH observations/.test(sql)), 'both candidate observations were read');
      assert.match(bad.body.answer, /separate candidates/);
    } else {
      assert.equal(bad.body.gaps?.[0]?.reason, 'ambiguous_account', 'identity resolved before status exclusion');
      assert.equal(bad.body.gaps[0].accounts.length, 2, 'both candidates reached the identity gate');
      assert.notEqual(bad.body.ledger?.kind, 'balance');
      assert.equal(displayFigures(bad.body.answer).length, 0, 'ambiguous selector cannot certify a figure');
      assert.equal(bad.calls.some(sql => /WITH observations/.test(sql)), false, 'ambiguity refuses before balance facts');
    }
    if (row.left === 'closed' && !['kind-stripped label', 'reversed mixed-rank label'].includes(row.selector)) {
      f.raw('UPDATE fin_accounts SET mask=?,label=? WHERE account_slug=?', '8800', 'Different account', 'second');
      const historical = await askIdentity(f, question, hint, row.renderer);
      assert.deepEqual(historical.body.ledger?.accounts.map(a => a.current_minor), [row.cents]);
      assert.match(historical.body.answer, /closed; its last recorded balance/);
      assert.match(historical.body.answer, /as of/);
    }
  });
}

for (const count of [1, 2, 7]) for (const renderer of ['direct', 'clarification']) {
  test(`all-closed balance denominator: ${count} accounts, ${renderer}`, async t => {
    const f = fixture(t); f.owner();
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    const question = renderer === 'direct' ? 'How much cash do I have?' : 'Could you retrieve my account balances?';
    for (let i = 0; i < count; i++) addIdentityAccount(f, { slug: `closed-${i}`, mask: String(7700 + i),
      label: `Retired reserve ${i}`, kind: i % 2 ? 'savings' : 'checking', cents: 10017 + i });
    const green = await askIdentity(f, question, null, renderer);
    assert.equal(green.body.ledger?.accounts.length, count, 'same denominator with open accounts answers');
    f.raw("UPDATE fin_accounts SET status='closed',closed_on='2026-09-15'");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_accounts WHERE status='closed'").n, count);
    const bad = await askIdentity(f, question, null, renderer);
    assert.equal(bad.body.gaps?.[0]?.reason, 'no_accounts');
    const text = [bad.body.answer, ...(bad.body.gaps || []).map(gap => gap.detail)].filter(Boolean).join('\n');
    // Clarification also renders the gap in its answer; check each surface separately.
    for (const surface of [bad.body.answer, bad.body.gaps[0].detail].filter(Boolean)) {
      assert.equal((surface.match(/closed, not counted/g) || []).length, count, 'every exclusion named once');
      for (let i = 0; i < count; i++) assert.ok(surface.includes(`Retired reserve ${i}`));
    }
    assert.match(text, /closed, not counted/);
    assert.equal(displayFigures(text).length, 0);
    assert.equal(bad.calls.some(sql => /WITH observations/.test(sql)), false, 'empty open subset avoids balance facts');
  });
}

for (const status of ['open', 'closed', 'never_connected']) test(`duplicate ending retains the more specific unapproved-twin review: ${status}`, async t => {
  const f = fixture(t); f.owner();
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  addIdentityAccount(f, { slug: 'manual', mask: '321', label: 'Statement reserve', cents: 12345 });
  const question = 'What is my balance for account 321?';
  const green = await askIdentity(f, question, '321', 'direct');
  assert.deepEqual(green.body.ledger?.accounts.map(a => a.current_minor), [12345]);
  f.raw('UPDATE fin_accounts SET status=?,closed_on=? WHERE account_slug=?', status,
    status === 'closed' ? '2026-09-15' : null, 'manual');
  addIdentityAccount(f, { slug: 'live', mask: '321', label: 'Feed reserve', cents: 98765 });
  f.raw("UPDATE fin_accounts SET feed_mode='live' WHERE account_slug='live'");
  assert.deepEqual(f.rows('SELECT feed_mode,status,mask FROM fin_accounts ORDER BY account_slug')
    .map(account => [account.feed_mode, account.status, account.mask]),
  [['live', 'open', '321'], ['manual', status, '321']], 'both unapproved endpoints exist');
  const bad = await askIdentity(f, question, '321', 'direct');
  assert.equal(bad.body.gaps?.[0]?.reason, 'ledger_account_link_required');
  assert.ok(bad.calls.some(sql => /LEFT JOIN fin_account_links/.test(sql)), 'real inventory reached link approval review');
  assert.equal(bad.body.evidence_gate?.supported, false);
  assert.equal(bad.body.evidence_gate?.complete, false);
  assert.equal(bad.body.ledger, undefined);
  assert.equal(bad.calls.some(sql => /WITH observations/.test(sql)), false);
});

test('an ambiguous open-account selector cannot authorize a combined cash figure', async t => {
  const f = fixture(t); f.owner();
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  const question = 'Could you retrieve my reserve plus balance without card debt?';
  addIdentityAccount(f, { slug: 'first', mask: '311', label: 'Reserve Plus', cents: 11111 });
  const green = await askIdentity(f, question, 'reserve plus', 'clarification');
  assert.equal(green.body.ledger?.cash_only?.total_minor, 11111, 'same-request unique cash control');
  addIdentityAccount(f, { slug: 'second', mask: '322', label: 'Reserve Plus', cents: 22222 });
  const bad = await askIdentity(f, question, 'reserve plus', 'clarification');
  assert.equal(bad.body.gaps?.[0]?.reason, 'ambiguous_account');
  assert.equal(bad.body.gaps[0].accounts.length, 2, 'nonempty candidate decision reached');
  assert.notEqual(bad.body.ledger?.kind, 'balance');
  assert.equal(bad.calls.some(sql => /WITH observations/.test(sql)), false);
});

// R2/R3: status changes cannot erase an exclusion when another reader refuses.
// Each row first proves the identical request on a fully open inventory.
for (const status of ['closed', 'never_connected']) for (const renderer of ['direct', 'clarification']) {
  for (const outcome of ['numeric', 'all excluded', 'missing', 'proposed', 'foreign', 'unconfirmed', 'pending unreadable', 'reader failure']) {
    test(`R2/R3 exclusion survives ${outcome}: ${status}, ${renderer}`, async t => {
      const f = fixture(t); f.owner();
      t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
      f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
      f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
      const question = renderer === 'direct' ? 'How much cash do I have?' : 'Could you retrieve my account balances without card debt?';
      addIdentityAccount(f, { slug: 'first', mask: '310', label: 'Operating reserve', cents: 100 });
      addIdentityAccount(f, { slug: 'second', mask: '311', label: 'Excluded reserve', cents: 200 });
      addIdentityAccount(f, { slug: 'third', mask: '312', label: 'Other excluded reserve', cents: 300 });
      const green = await askIdentity(f, question, null, renderer);
      assert.deepEqual(green.body.ledger?.accounts.map(a => a.current_minor), [100, 200, 300]);
      assert.ok(green.calls.some(sql => /WITH observations/.test(sql)), 'green snapshot reader reached');
      f.raw("UPDATE fin_accounts SET status=? WHERE account_slug!='first'", status);
      const expected = { numeric: null, 'all excluded': 'no_accounts', missing: 'balance_unavailable',
        proposed: 'balance_unavailable', foreign: 'unsupported_currency', unconfirmed: 'ambiguous_account',
        'pending unreadable': 'ledger_unavailable', 'reader failure': 'ledger_unavailable' }[outcome];
      if (outcome === 'all excluded') f.raw('UPDATE fin_accounts SET status=?', status);
      if (outcome === 'missing') f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='first'");
      if (outcome === 'proposed') f.raw("UPDATE fin_balance_snapshots SET basis_state='proposed' WHERE account_slug='first'");
      if (outcome === 'foreign') f.raw("UPDATE fin_accounts SET currency='EUR' WHERE account_slug='first'");
      if (outcome === 'unconfirmed') f.raw("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='first'");
      if (outcome === 'pending unreadable') f.raw(`INSERT INTO fin_transactions
        (txn_uid,account_slug,posted_on,pending,provenance,basis_state,unparsed_reason,recorded_at)
        VALUES ('unknown-pending','first','2026-10-12',1,'owner_stated','unparsed','fixture unknown amount',?)`, NOW);
      let refusedReads = 0;
      if (outcome === 'reader failure') {
        const prepare = f.env.DB.prepare;
        f.env.DB.prepare = sql => {
          if (/WITH observations/.test(sql)) { refusedReads++; throw new Error('synthetic reader refusal'); }
          return prepare(sql);
        };
      }
      const result = await askIdentity(f, question, null, renderer);
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n, 3, 'exact nonempty decision inventory');
      if (outcome === 'reader failure') assert.equal(refusedReads, 1, 'failed read reached');
      if (['missing', 'proposed', 'pending unreadable'].includes(outcome))
        assert.ok(result.calls.some(sql => /WITH observations/.test(sql)), 'refusing snapshot decision reached');
      const excluded = outcome === 'all excluded' ? ['310', '311', '312'] : ['311', '312'];
      if (expected) {
        assert.equal(result.body.gaps?.[0]?.reason, expected);
        assert.notEqual(result.body.ledger?.kind, 'balance');
        assert.equal(displayFigures(result.body.answer).length, 0, 'refusal has no figure');
      } else {
        assert.deepEqual(result.body.ledger?.accounts.map(a => a.current_minor), [100]);
        if (renderer === 'clarification') assert.equal(result.body.ledger.cash_only.total_minor, 100);
        assert.deepEqual(result.body.ledger.observation.exclusions, excluded.map(mask => ({ account_mask: mask, reason: status })));
        assert.equal(result.body.ledger.complete, status === 'closed', 'never-connected uncertainty remains visible');
        if (status === 'never_connected') assert.equal(result.body.evidence_gate.complete, false);
      }
      const surfaces = [result.body.answer, ...(result.body.gaps || []).map(gap => gap.detail)].filter(Boolean);
      assert.ok(surfaces.length > 0, 'numeric or refusal surface exists');
      for (const surface of surfaces) {
        const phrase = status === 'closed' ? 'closed, not counted' : 'never connected, not counted';
        assert.equal(surface.split(phrase).length - 1, excluded.length, 'one reason per excluded account on every surface');
        for (const mask of excluded) assert.match(surface, new RegExp(`ending ${mask}.*${phrase}`));
        assert.match(surface, /Excluded reserve/);
        assert.match(surface, /Other excluded reserve/);
      }
    });
  }
}

// R4: an independent BigInt oracle checks every permutation at both bounds.
const permutations = values => values.length ? values.flatMap((value, index) =>
  permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];
for (const sign of [1, -1]) for (const [index, values] of permutations([sign * (Number.MAX_SAFE_INTEGER - 100), -200, 200]).entries()) {
  test(`R4 safe final cents order ${sign}/${index}`, async t => {
    const f = fixture(t); f.owner();
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    const question = 'Could you retrieve my account balances without card debt?';
    values.forEach((_, i) => addIdentityAccount(f, { slug: `account-${i}`, mask: String(310 + i), label: `Reserve ${i}`, cents: i + 1 }));
    const green = await askIdentity(f, question, null, 'clarification');
    assert.equal(green.body.ledger?.cash_only?.total_minor, 6);
    values.forEach((value, i) => f.raw('UPDATE fin_balance_snapshots SET current_minor=? WHERE account_slug=?', value, `account-${i}`));
    const result = await askIdentity(f, question, null, 'clarification');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n, 3);
    assert.ok(result.calls.some(sql => /WITH observations/.test(sql)), 'real sorted balance reader reached');
    const expected = values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
    assert.equal(String(result.body.ledger?.cash_only?.total_minor), expected);
    assert.equal(String(sumMinor(values, value => value)), expected);
  });
}

for (const sign of [1, -1]) test(`R4 genuinely unsafe final balance refuses: ${sign}`, async t => {
  const f = fixture(t); f.owner();
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  const question = 'Could you retrieve my account balances without card debt?';
  addIdentityAccount(f, { slug: 'first', mask: '310', label: 'Operating reserve', cents: sign * Number.MAX_SAFE_INTEGER });
  addIdentityAccount(f, { slug: 'second', mask: '311', label: 'Other reserve', cents: 0 });
  const green = await askIdentity(f, question, null, 'clarification');
  assert.equal(green.body.ledger?.cash_only?.total_minor, sign * Number.MAX_SAFE_INTEGER);
  f.raw("UPDATE fin_balance_snapshots SET current_minor=? WHERE account_slug='second'", sign);
  const result = await askIdentity(f, question, null, 'clarification');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n, 2);
  assert.ok(result.calls.some(sql => /WITH observations/.test(sql)), 'overflow decision reached');
  assert.equal(result.body.gaps?.[0]?.reason, 'ledger_unavailable');
  assert.notEqual(result.body.ledger?.kind, 'balance');
  assert.equal(displayFigures(result.body.answer).length, 0);
});

// B1: an admitted compound balance refusal must survive operand composition.
// The same request first proves two complete standalone readings, then changes one fact.
// The safe subset intentionally refuses even the healthy compound request.
async function askCompoundBalance(f, hints, fallbackAnswer) {
  const start = f.calls.length;
  let modelCalls = 0, fallbackCalls = 0;
  const question = `Could you compare balances in ${hints[0]} versus ${hints[1]}?`;
  const response = await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
      modelCalls++;
      return { content: [{ type: 'text', text: JSON.stringify({ intents: hints.map(account_hint => ({
        kind: 'balance', account_hint, direction: null, count: null, vendor_text: null,
        amount_text: null, date_text: null, period: { type: 'none' },
      })) }) }] };
    } }, async gap => {
    fallbackCalls++;
    return Response.json({ answer: fallbackAnswer, citations: [], results: [], gaps: gap ? [gap] : [],
      evidence_gate: { supported: true, complete: true, partial: false } });
  });
  const body = await response.json(), calls = f.calls.slice(start);
  assert.equal(modelCalls, 1, 'grounded compound extractor decision reached');
  assert.ok(calls.some(sql => /FROM fin_accounts a/.test(sql)), 'real inventory decision reached');
  return { body, calls, fallbackCalls };
}

const compoundFaults = [
  ['missing', 'balance_unavailable', /missing or unreadable/],
  ['never_connected', 'no_accounts', /Reserve account.*ending 411.*never connected, not counted/],
  ['closed sibling', 'ambiguous_account', /details are still unconfirmed/],
];
for (const [fault, reason, disclosure] of compoundFaults) for (const reverse of [false, true]) {
  for (const fallbackAnswer of ['Synthetic document fallback.', null]) {
    test(`B1 compound refusal: ${fault}, reverse=${reverse}, fallback=${fallbackAnswer === null ? 'null' : 'supported'}`, async t => {
      const f = fixture(t); f.owner();
      t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
      f.env.AI.run = async () => assert.fail('external model forbidden');
      f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
      f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
      const hints = reverse ? ['reserve account', 'operating account'] : ['operating account', 'reserve account'];
      addIdentityAccount(f, { slug: 'operating', mask: '410', label: 'Operating account', cents: 300 });
      addIdentityAccount(f, { slug: 'reserve', mask: '411', label: 'Reserve account', cents: 200 });
      const green = await askCompoundBalance(f, hints, fallbackAnswer);
      assert.deepEqual(green.body.ledger.parts.map(part => part.accounts[0].current_minor), reverse ? [200, 300] : [300, 200]);
      assert.equal(green.body.ledger.compound_refused, true);
      assert.equal(green.body.evidence_gate.complete, false);
      assert.equal(green.body.ledger.comparison, undefined);
      assert.equal(green.fallbackCalls, 0);
      assert.equal(green.body.evidence_gate.supported, false);
      assert.equal(green.calls.filter(sql => /WITH observations/.test(sql)).length, 2);
      if (fault === 'missing') f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='reserve'");
      if (fault === 'never_connected') f.raw("UPDATE fin_accounts SET status='never_connected' WHERE account_slug='reserve'");
      if (fault === 'closed sibling') addIdentityAccount(f, {
        slug: 'sibling', mask: '412', label: 'Reserve checking', status: 'closed', cents: 400,
      });
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n, fault === 'closed sibling' ? 3 : 2);
      const bad = await askCompoundBalance(f, hints, fallbackAnswer);
      if (fault === 'missing') assert.ok(bad.calls.some(sql => /WITH observations/.test(sql)), 'missing snapshot decision reached');
      assert.equal(bad.body.evidence_gate?.complete, false, 'known balance refusal cannot certify the compound request');
      assert.equal(bad.body.evidence_gate.supported, false);
      assert.equal(bad.body.evidence_gate.partial, true);
      const gap = bad.body.gaps.find(gap => gap.reason === reason);
      assert.ok(gap, 'typed operand refusal retained');
      assert.match(gap.detail, disclosure);
      assert.match(bad.body.answer, disclosure, 'visible operand disclosure retained');
      if (fault === 'closed sibling') assert.equal(gap.accounts.length, 2, 'both status candidates reached identity decision');
      assert.equal(bad.fallbackCalls, 0, 'reached balance refusal is terminal before document synthesis');
      assert.equal(bad.body.ledger?.comparison, undefined);
      assert.deepEqual([...new Set(displayFigures(bad.body.answer).map(row => row.cents))], ['300'], 'only the complete operating operand can show a figure');
      assert.deepEqual(bad.body.ledger.operands.map(part => part.complete), reverse ? [false, true] : [true, false]);
      assert.equal(bad.body.citations.length, 1);
      assert.equal(bad.body.citations[0].amount_minor, 300);
    });
  }
}

// The refusal wins even if an earlier operand could trigger ordinary fallback.
for (const reverse of [false, true]) for (const fault of ['both missing', 'missing plus excluded']) {
  test(`B1 compound full disclosure: ${fault}, reverse=${reverse}`, async t => {
    const f = fixture(t); f.owner();
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    f.env.AI.run = async () => assert.fail('external model forbidden');
    f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    const hints = reverse ? ['reserve account', 'operating account'] : ['operating account', 'reserve account'];
    addIdentityAccount(f, { slug: 'operating', mask: '410', label: 'Operating account', cents: 300 });
    addIdentityAccount(f, { slug: 'reserve', mask: '411', label: 'Reserve account', cents: 200 });
    const green = await askCompoundBalance(f, hints, 'Synthetic document fallback.');
    assert.deepEqual(green.body.ledger.parts.map(part => part.accounts[0].current_minor), reverse ? [200, 300] : [300, 200]);
      assert.equal(green.body.ledger.compound_refused, true);
      assert.equal(green.body.evidence_gate.complete, false);
    assert.equal(green.fallbackCalls, 0);
    f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='operating'");
    if (fault === 'both missing') f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='reserve'");
    else f.raw("UPDATE fin_accounts SET status='never_connected' WHERE account_slug='reserve'");
    const bad = await askCompoundBalance(f, hints, 'Synthetic document fallback.');
    assert.equal(bad.calls.filter(sql => /FROM fin_accounts a/.test(sql)).length, fault === 'both missing' ? 5 : 4,
      'both operand inventories plus missing-snapshot reader rechecks reached');
    assert.ok(bad.calls.some(sql => /WITH observations/.test(sql)), 'missing snapshot reader reached');
    assert.equal(bad.body.gaps.length, 2, 'neither operand refusal lost');
    assert.deepEqual(bad.body.gaps.map(gap => gap.reason).sort(), fault === 'both missing'
      ? ['balance_unavailable', 'balance_unavailable'] : ['balance_unavailable', 'no_accounts']);
    for (const gap of bad.body.gaps) assert.ok(bad.body.answer.includes(gap.detail.split('\n')[0]));
    if (fault === 'missing plus excluded') assert.match(bad.body.answer, /Reserve account.*ending 411.*never connected, not counted/);
    assert.equal(bad.fallbackCalls, 0);
    assert.equal(bad.body.evidence_gate.complete, false);
    assert.equal(bad.body.evidence_gate.supported, false);
    assert.equal(displayFigures(bad.body.answer).length, 0);
  });
}

for (const reverse of [false, true]) for (const missing of ['operating', 'reserve']) {
  test(`B1 compound broad exclusions: missing=${missing}, reverse=${reverse}`, async t => {
    const f = fixture(t); f.owner();
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    f.env.AI.run = async () => assert.fail('external model forbidden');
    f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    const hints = reverse ? ['reserve account', 'checking'] : ['checking', 'reserve account'];
    addIdentityAccount(f, { slug: 'operating', mask: '410', label: 'Operating account', cents: 300 });
    addIdentityAccount(f, { slug: 'reserve', mask: '411', label: 'Reserve account', kind: 'savings', cents: 200 });
    const green = await askCompoundBalance(f, hints, null);
    assert.deepEqual(green.body.ledger.parts.map(part => part.accounts[0].current_minor), reverse ? [200, 300] : [300, 200]);
      assert.equal(green.body.ledger.compound_refused, true);
      assert.equal(green.body.evidence_gate.complete, false);
    assert.equal(green.fallbackCalls, 0);
    addIdentityAccount(f, { slug: 'retired', mask: '412', label: 'Retired deposit', status: 'closed', cents: 400 });
    addIdentityAccount(f, { slug: 'unconnected', mask: '413', label: 'Unconnected deposit', status: 'never_connected', cents: 500 });
    f.raw('DELETE FROM fin_balance_snapshots WHERE account_slug=?', missing);
    const bad = await askCompoundBalance(f, hints, null);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_accounts').n, 4);
    assert.ok(bad.calls.filter(sql => /WITH observations/.test(sql)).length >= 2, 'both balance readers reached');
    assert.equal(bad.body.gaps[0].reason, 'balance_unavailable');
    assert.match(bad.body.answer, /Retired deposit.*ending 412.*closed, not counted/);
    assert.match(bad.body.answer, /Unconnected deposit.*ending 413.*never connected, not counted/);
    assert.equal(bad.body.answer.split('closed, not counted').length - 1, 1);
    assert.equal(bad.body.answer.split('never connected, not counted').length - 1, 1);
    assert.equal(bad.fallbackCalls, 0);
    assert.equal(bad.body.evidence_gate.supported, false);
    assert.equal(bad.body.evidence_gate.complete, false);
    assert.equal(bad.body.evidence_gate.partial, true);
    assert.deepEqual([...new Set(displayFigures(bad.body.answer).map(row => row.cents))], missing === 'operating' ? ['200'] : []);
    assert.deepEqual(bad.body.ledger.operands.map(part => part.complete), reverse
      ? [missing === 'operating', false] : [false, missing === 'operating']);
  });
}
