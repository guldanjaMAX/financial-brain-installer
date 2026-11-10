import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer, headOracleUrl } from './business-scope-role-only-loader.mjs';
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

test('600 distinct no-role questions preserve exact pinned HEAD bytes', async t => {
  const f = fixture(t);
  const control = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(control.body.ledger?.expense_total_minor, 300, 'populated role control');
  f.raw("UPDATE fin_entities SET display_label='Owner Unit' WHERE entity_slug='operating'");
  const shapes = [
    ['Could you retrieve balances for the account named Reserve in Motion?', 'balance', 'Reserve in Motion'],
    ['Could you retrieve balances for the account named "Reserve in Motion"?', 'balance', 'Reserve in Motion'],
    ['Could you retrieve checking balances for Owner Unit?', 'balance', null],
    ['Could you retrieve savings balances for the account named Reserve?', 'balance', 'Reserve'],
    ['transfers from Owner Unit to Private last month', 'transfers', null],
    ['transfers between Reserve and Private last month', 'transfers', null],
    ['what did my checking accounts spend last month', 'expense_summary', 'checking accounts'],
    ['what did my Absent account spend last month', 'expense_summary', 'Absent'],
    ['what did my Reserve account spend last month', 'expense_summary', null],
    ['what did Owner Unit spend last month', 'expense_summary', 'Owner Unit'],
    ['what did my work accounts spend last month', 'expense_summary', 'work'],
    ['what did the LLC spend last month', 'expense_summary', 'LLC'],
    ['Could you retrieve balances for the account called Private?', 'balance', 'Private'],
    ['what did my Reserve account spend last month', 'expense_summary', 'Reserve'],
    ['what did my savings accounts spend last month', 'expense_summary', 'savings accounts'],
    ['Could you retrieve balances for my cards?', 'balance', 'cards'],
    ['Could you retrieve balances for my savings?', 'balance', 'savings'],
    ['split Reserve vs Private spending last month', 'expense_summary', null],
    ['what did the account named Reserve spend last month', 'expense_summary', 'Reserve'],
    ['Could you retrieve balances for account ending 8101?', 'balance', null],
  ];
  const questions = new Set(), outputs = new Set(), failures = [];
  for (let i = 0; i < 600; i++) {
    let [template, kind, hint, vendor] = shapes[i % shapes.length];
    if (i % shapes.length < 2) {
      const label = ['Reserve in Motion', 'Reserve during Winter', 'Reserve last Resort', 'Reserve this Year', 'Reserve spending Pool'][Math.floor(i / shapes.length) % 5];
      template = template.replace('Reserve in Motion', label);
      hint = label;
      f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='operating'", label);
    }
    let letter = 0;
    const variant = Math.floor(i / shapes.length) + (i % shapes.length === 8 ? 32 : 0);
    const question = template.replace(/[a-z]/gi, c => {
      const index = letter++;
      return index < 6 ? (variant & (1 << index) ? c.toUpperCase() : c.toLowerCase()) : c;
    });
    assert.doesNotMatch(question, /\b(?:business|personal|biz|company|household)\b/i);
    questions.add(question);
    f.raw('UPDATE fin_balance_snapshots SET current_minor=current_minor+1');
    f.raw('UPDATE fin_transactions SET amount_minor=amount_minor+1');
    const historical = await ask(base, f, question, kind, hint, vendor);
    const candidate = await ask(withLedgerAnswer, f, question, kind, hint, vendor);
    outputs.add(historical.text);
    if (candidate.text !== historical.text) failures.push(i);
  }
  assert.equal(questions.size, 600);
  assert.ok(outputs.size >= 10, 'HEAD questions reach distinct populated output arms');
  console.log(`no_role_head_equal=${600 - failures.length}/600`);
  assert.deepEqual(failures, [], 'all output bytes equal clean HEAD 1c493880');
});

test('mixed restrictions and descriptor role words preserve HEAD bytes', async t => {
  const f = fixture(t);
  const green = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(green.body.ledger.expense_total_minor, 300);
  f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='reserve'");
  for (const [question, kind, hint] of [
    ['Could you retrieve balances for my business account named Reserve in Motion?', 'balance', 'Reserve in Motion'],
    ['Could you retrieve balances for the account named Personal?', 'balance', 'Personal'],
    ['Could you retrieve checking balances for Company Unit?', 'balance', null],
    ['Could you retrieve savings balances for the account named Personal?', 'balance', 'Personal'],
    ['transfers from Company Unit to personal last month', 'transfers', null],
    ['transfers between personal and business last month', 'transfers', null],
    ['what did my business checking accounts spend last month', 'expense_summary', 'business checking accounts'],
    ['what did my business Absent account spend last month', 'expense_summary', null],
    ['what did Company Unit spend last month', 'expense_summary', 'Company Unit'],
    ['Could you retrieve balances for my business cards?', 'balance', 'business cards'],
    ['split personal vs business spending last month', 'expense_summary', null],
  ]) await headEqual(f, question, kind, hint);
});

test('640 public pure-role readings count confirmed memberships without silent exclusions', async t => {
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
  const stats = { cases: 0, passes: 0, wrong_figures: 0, silent_exclusions: 0, controls: 0 };
  const failures = [];
  for (let index = 0; index < 640; index++) {
    const [question, kind, hint, personal] = variants[index % variants.length];
    const vendor = null;
    const proposed = Math.floor(index / variants.length) % 2 === 1;
    const operating = 101 + index * 17, reserve = 203 + index * 31, privateAmount = 407 + index * 37;
    f.raw('UPDATE fin_entities SET basis_state=? WHERE entity_slug=?', proposed ? 'proposed' : 'confirmed', 'reserve');
    for (const [slug, amount] of [['operating', operating], ['reserve', reserve], ['private', privateAmount]]) {
      f.raw('UPDATE fin_balance_snapshots SET current_minor=? WHERE account_slug=?', amount, slug);
      f.raw('UPDATE fin_transactions SET amount_minor=? WHERE account_slug=?', amount, slug);
    }
    const result = await ask(withLedgerAnswer, f, question, kind, hint, vendor);
    assert.ok(result.reached.inventory, 'pure role reached account decision');
    assert.ok(result.reached.disclosure, 'pure role reached uncertain-membership decision');
    assert.ok(result.reached.facts, 'populated pure role reads money');
    const expected = personal ? privateAmount : operating + (proposed ? 0 : reserve);
    const ledger = result.body.ledger;
    const got = kind === 'balance' ? (ledger.accounts || []).reduce((sum, account) => sum + account.current_minor, 0) : ledger.expense_total_minor;
    const allowed = personal ? ['8103'] : proposed ? ['8101'] : ['8101', '8102'];
    const wrong = got !== expected || (result.body.citations || []).some(citation => !allowed.includes(citation.account_mask));
    const silent = !/8104[^\n]*not counted/.test(result.body.answer) || proposed && !/8102[^\n]*not counted/.test(result.body.answer) ||
      ledger.complete !== false || ledger.scope_complete !== false || result.body.evidence_gate.complete !== false;
    if (wrong) stats.wrong_figures++;
    if (silent) stats.silent_exclusions++;
    stats.cases++;
    if (!wrong && !silent) stats.passes++;
    if (!proposed && !wrong) stats.controls++;
    if (wrong || silent) failures.push({ index, expected, got, wrong, silent });
  }
  console.log(JSON.stringify({ pure_role: stats }));
  assert.ok(stats.controls > 0, 'confirmed-membership green controls populated');
  assert.equal(stats.cases, 640);
  assert.deepEqual(failures, []);
});

for (const role of ['Business', 'Personal', 'Company', 'Household', 'Biz']) {
  test(`B1 literal payee ${role} Expenses preserves HEAD and every matched account`, async t => {
    const f = fixture(t);
    for (const suffix of ['Expenses', 'Accounts']) {
      const vendor = `${role} ${suffix}`;
      f.raw('UPDATE fin_transactions SET description=?,payee=?', vendor, vendor);
      const green = await ask(withLedgerAnswer, f, `spending at ${vendor} last month`, 'merchant', null, vendor);
      const greenHead = await ask(base, f, `spending at ${vendor} last month`, 'merchant', null, vendor);
      assert.ok(green.body.ledger.total_minor > 0, 'populated S5 payee control');
      assert.equal(green.text, greenHead.text, 'payee control preserves S5 HEAD');
      const outputs = new Set();
      for (const prefix of ['spending for', 'expenses for', 'spending for my', 'spending for our']) {
        const question = `${prefix} ${vendor} last month`;
        const historical = await ask(base, f, question, 'merchant', null, vendor);
        const candidate = await ask(withLedgerAnswer, f, question, 'merchant', null, vendor);
        for (const result of [historical, candidate]) {
          assert.equal(result.reached.provider, 1, 'admitted selector decision reached once');
          assert.ok(result.reached.inventory && result.reached.facts, 'populated merchant reader reached');
          assert.equal(result.body.ledger.total_minor, historical.body.ledger.total_minor, 'S5 ownership remains authoritative for role words');
          assert.deepEqual(result.body.ledger.accounts, historical.body.ledger.accounts, 'exact S5 contributing accounts');
        }
        assert.equal(candidate.text, historical.text, 'exact pinned HEAD bytes');
        assert.deepEqual(candidate.reached, historical.reached, 'same provider and reader decisions');
        outputs.add(candidate.text);
      }
      assert.ok(outputs.size, 'populated payee answers returned');
    }
    console.log(`payee_role_word_head_equal=8/8 role=${role.toLowerCase()}`);
  });
}

test('B1 admitted account and category labels containing role words retain HEAD authority', async t => {
  const f = fixture(t);
  const green = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(green.body.ledger.expense_total_minor, 300, 'standalone scope green control');
  for (const role of ['Business', 'Personal', 'Company', 'Household', 'Biz']) {
    const label = `${role} Expenses`;
    f.raw('UPDATE fin_transactions SET category=?,description=?,payee=?', label, label, label);
    for (const [question, kind, hint, vendor] of [
      [`spending for ${label} last month`, 'expense_summary', label, null],
      [`spending for ${label} last month`, 'category', null, label],
      [`Could you retrieve balances for the account named "${label}"?`, 'balance', label, null],
      [`spending for "${label}" last month`, 'merchant', null, label],
    ]) {
      const result = await headEqual(f, question, kind, hint, vendor);
      assert.equal(result.reached.provider, 1, 'literal selector admitted once');
      assert.ok(result.reached.inventory, 'literal reaches owner inventory');
      assert.ok(result.reached.facts || result.body.ledger === null, 'S5 either reads facts or refuses unresolved ownership');
    }
  }
  console.log('payee_role_word_head_equal=20/20 selectors=account-category-label');
});

test('M1 unresolved non-role hints retain the populated HEAD reading', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_transactions SET description='Store Unit',payee='Store Unit'");
  const green = await ask(withLedgerAnswer, f, 'spending at Store Unit last month', 'merchant', null, 'Store Unit');
  assert.equal(green.body.ledger.total_minor, 1500);
  const result = await headEqual(f, 'Could you retrieve Store Unit charges last month for clinic?', 'merchant', 'clinic', 'Store Unit');
  assert.ok(result.reached.provider && result.reached.inventory && result.reached.facts, 'unresolved selector reaches the real reader');
  assert.equal(result.body.ledger.total_minor, 1500);
  assert.equal(result.body.ledger.selector_unresolved, true);
});

test('600 distinct mixed questions preserve exact pinned HEAD bytes', async t => {
  const f = fixture(t);
  const shapes = [
    ['what did my business checking accounts spend last month', 'expense_summary', 'business checking accounts'],
    ['what did my personal savings accounts spend last month', 'expense_summary', 'personal savings accounts'],
    ['what did my business Absent account spend last month', 'expense_summary', null],
    ['what did my business Absent account spend last month', 'expense_summary', 'business'],
    ['what did my business Reserve account spend last month', 'expense_summary', 'Reserve'],
    ['Could you retrieve balances for my business Absent accounts?', 'balance', null],
    ['Could you retrieve balances for my business cards?', 'balance', 'business cards'],
    ['Could you retrieve balances for my personal checking?', 'balance', 'personal checking'],
    ['Could you retrieve balances for the account named Personal?', 'balance', 'Personal'],
    ['Could you retrieve balances for the account called Biz?', 'balance', 'Biz'],
    ['Could you retrieve savings balances for the account named Personal?', 'balance', 'Personal'],
    ['Could you retrieve checking balances for Company Unit?', 'balance', null],
    ['what did Company Unit spend last month', 'expense_summary', 'Company Unit'],
    ['what did Business Unit spend last month', 'expense_summary', 'Business Unit'],
    ['transfers from Company Unit to personal last month', 'transfers', null],
    ['transfers from Business Unit to personal last month', 'transfers', null],
    ['transfers between personal and business last month', 'transfers', null],
    ['split personal vs business spending last month', 'expense_summary', null],
    ['Could you retrieve personal and business balances side by side?', 'balance', null],
    ['Could you retrieve balances for my business account named Reserve in Motion?', 'balance', 'Reserve in Motion'],
    ['what did I spend at My Business last month', 'merchant', null, 'My Business'],
    ['what did I spend at Personal Office last month', 'merchant', null, 'Personal Office'],
    ['deposits from the company last month', 'deposits', null, 'company'],
    ['Could you retrieve balances for the account named \"business\"?', 'balance', 'business'],
  ];
  const questions = new Set(), outputs = new Set(), failures = [];
  const control = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(control.body.ledger.expense_total_minor, 300, 'populated pure-role green control');
  for (let index = 0; index < 600; index++) {
    const [template, kind, hint, vendor] = shapes[index % shapes.length];
    let letter = 0;
    const variant = index;
    const question = template.replace(/[a-z]/gi, character => {
      const bit = letter++;
      return bit < 10 && (variant & (1 << bit)) ? character.toUpperCase() : character.toLowerCase();
    });
    questions.add(question);
    f.raw('UPDATE fin_entities SET basis_state=? WHERE entity_slug=?', index % 3 ? 'proposed' : 'confirmed', 'reserve');
    f.raw('UPDATE fin_balance_snapshots SET current_minor=current_minor+1');
    f.raw('UPDATE fin_transactions SET amount_minor=amount_minor+1');
    const historical = await ask(base, f, question, kind, hint, vendor);
    const candidate = await ask(withLedgerAnswer, f, question, kind, hint, vendor);
    outputs.add(historical.text);
    if (historical.text !== candidate.text || JSON.stringify(historical.reached) !== JSON.stringify(candidate.reached)) failures.push(index);
  }
  assert.equal(questions.size, 600, 'distinct mixed questions');
  assert.ok(outputs.size >= 10, 'mixed HEAD questions reach distinct output arms');
  console.log(`mixed_head_equal=${600 - failures.length}/600`);
  assert.deepEqual(failures, []);
});

test('300 role plus category questions equal confirmed-account cents oracle', async t => {
  const f = fixture(t);
  const roles = ['business', 'personal', 'company', 'household', 'biz'];
  const categories = ['materials', 'software', 'dining', 'office supplies', 'equipment', 'travel'];
  const frames = [
    (r, c) => `${r} spending in ${c} last month`,
    (r, c) => `${r} ${c} spending last month`,
    (r, c) => `${r} spending on ${c} last month`,
    (r, c) => `${r} expenses in ${c} last month`,
    (r, c) => `my ${r} expenses on ${c} last month`,
    (r, c) => `${r} spending for ${c} last month`,
    (r, c) => `what did my ${r} spend on ${c} last month`,
    (r, c) => `how much did the ${r} spend in ${c} last month`,
    (r, c) => `${r} spending at ${c} last month`,
    (r, c) => `Could you retrieve ${r} ${c} spending last month`,
  ];
  const failures = [], questions = new Set();
  let passes = 0;
  for (const role of roles) for (const category of categories) for (const frame of frames) {
    const index = questions.size, question = frame(role, category);
    questions.add(question);
    const personal = ['personal', 'household'].includes(role);
    const proposed = index % 2 === 1;
    f.raw("UPDATE fin_accounts SET basis_state=? WHERE account_slug='reserve'", proposed ? 'proposed' : 'confirmed');
    const amounts = [101 + index * 17, 203 + index * 31, 407 + index * 37, 809 + index * 41];
    for (const [i, slug] of ['operating', 'reserve', 'private', 'unknown'].entries()) {
      f.raw("UPDATE fin_transactions SET amount_minor=?,category=?,category_basis_state='confirmed',description='Store Unit',payee='Store Unit' WHERE account_slug=? AND txn_uid=?", amounts[i], category, slug, slug);
      // A same-account nonmatching category proves the category filter survived.
      f.raw(`INSERT OR REPLACE INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,category,category_basis_state,provenance,basis_state,recorded_at)
        VALUES (?,?,'2026-09-20',999999,'outflow','Other Unit','other category','confirmed','owner_stated','confirmed',?)`, `other-${slug}`, slug, NOW);
    }
    const green = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
    assert.ok(green.reached.inventory && green.reached.facts, 'populated role control reaches reader');
    assert.equal(green.body.ledger.expense_total_minor, amounts[0] + 999999 + (proposed ? 0 : amounts[1] + 999999));
    const result = await ask(withLedgerAnswer, f, question, 'category', role, category);
    const expected = personal ? BigInt(amounts[2]) : BigInt(amounts[0]) + (proposed ? 0n : BigInt(amounts[1]));
    const masks = personal ? ['8103'] : proposed ? ['8101'] : ['8101', '8102'];
    const correct = String(result.body.ledger?.total_minor) === String(expected) &&
      JSON.stringify([...new Set((result.body.citations || []).map(c => c.account_mask))].sort()) === JSON.stringify(masks);
    const disclosed = /8104[^\n]*not counted/.test(result.body.answer) && (!proposed || /8102[^\n]*not counted/.test(result.body.answer));
    const reached = result.reached.provider === 1 && result.reached.inventory > 0 && result.reached.disclosure > 0 && result.reached.facts > 0;
    if (correct && disclosed && reached && result.body.evidence_gate.complete === false) passes++;
    else failures.push({ index, question, expected: String(expected), got: result.body.ledger?.total_minor, reached: result.reached });
  }
  console.log(`role_category=${passes}/300 wrong_figures=${300 - passes}`);
  assert.equal(questions.size, 300);
  assert.deepEqual(failures, []);
});

test('a pure role cannot absorb another payee or account restriction', async t => {
  const f = fixture(t);
  const control = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(control.body.ledger.expense_total_minor, 300);
  for (const [question, kind, vendor] of [
    ['what did my business spend at Office supplies last month', 'merchant', 'Office supplies'],
    ['business spending for my Supply Unit last month', 'merchant', 'Supply Unit'],
    ['how much did my business pay Payer Unit last month', 'payment', 'Payer Unit'],
    ['Could you retrieve deposits from my company last month', 'deposits', 'company'],
    ['Could you retrieve balances for my business accounts at Absent Unit?', 'balance', null],
    ['what did my business spend with my Reserve account last month', 'expense_summary', null],
  ]) await headEqual(f, question, kind, null, vendor);
});

// Role plus category was previously pinned to the all-account widening bug.
// Category is a filter, per the business-scope finder, rather than account scope.
test('retained category assertion uses confirmed scope before the filter', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_transactions SET category='supplies',category_basis_state='confirmed'");
  const control = await ask(base, f, 'my business expenses on supplies last month', 'category', null, 'supplies');
  assert.equal(control.body.ledger.total_minor, 300, 'S5 ordinary category scope already selects business accounts');
  const result = await ask(withLedgerAnswer, f, 'my business expenses on supplies last month', 'category', null, 'supplies');
  assert.ok(result.reached.provider && result.reached.inventory && result.reached.facts && result.reached.disclosure);
  assert.equal(result.body.ledger.total_minor, 300, 'widening bug per the business-scope finder');
  assert.deepEqual([...new Set(result.body.citations.map(c => c.account_mask))].sort(), ['8101', '8102']);
  assert.match(result.body.answer, /8104[^\n]*not counted/);
  f.raw("UPDATE fin_transactions SET description='supplies',payee='supplies'");
  const merchant = await headEqual(f, 'business spending at supplies last month', 'merchant', null, 'supplies');
  assert.equal(merchant.body.ledger.total_minor, 300, 'admitted merchant retains S5 ordinary business ownership');
  const category = await ask(withLedgerAnswer, f, 'business spending at supplies last month', 'category', null, 'supplies');
  assert.equal(category.body.ledger.total_minor, 300, 'admitted category filters confirmed role accounts');
  assert.ok(category.reached.inventory && category.reached.disclosure && category.reached.facts);
});

test('category filters keep independent account restrictions and the HEAD provider prompt', async t => {
  const f = fixture(t);
  f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
  const green = await ask(withLedgerAnswer, f, 'business software spending last month', 'category', 'business', 'software');
  assert.equal(green.body.ledger.total_minor, 300);
  for (const [question, hint] of [
    ['what did my business checking accounts spend on software last month', 'checking accounts'],
    ['what did my business Reserve account spend on software last month', 'Reserve'],
    ['business software spending from Reserve last month', 'Reserve'],
    ['business software spending for Company Unit last month', 'Company Unit'],
  ]) await headEqual(f, question, 'category', hint, 'software');
  const question = 'business software spending from Reserve last month';
  const requests = [];
  for (const reader of [base, withLedgerAnswer]) {
    let calls = 0;
    await reader({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async (...args) => {
        calls++; requests.push(args);
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
          kind: 'category', direction: 'outflow', count: null, vendor_text: 'software', account_hint: 'Reserve',
          amount_text: null, date_text: null, period: { type: 'last_month' },
        }] }) }] };
      },
    }, async () => Response.json({ answer: null }));
    assert.equal(calls, 1, 'mixed category reaches exactly one provider call');
  }
  // A failed prompt check must not dump the fixture environment or its keys.
  assert.ok(isDeepStrictEqual(requests[1], requests[0]), 'non-pure category keeps the exact HEAD provider arguments');
});

test('a generic company sender retains HEAD output and read decisions', async t => {
  const f = fixture(t);
  const control = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(control.body.ledger.expense_total_minor, 300);
  for (const question of ['Did the company payment arrive?', 'Did the my company payment arrive?']) {
    await headEqual(f, question, 'payment', null, 'company');
  }
});

test('invalid role extraction reaches rejection before any account inventory read', async t => {
  const f = fixture(t);
  const control = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(control.body.ledger.expense_total_minor, 300);
  const result = await headEqual(f, 'Could you retrieve personal account spending?', 'expense_summary', 'invented nickname');
  assert.equal(result.reached.provider, 1, 'invalid literal reached the real extraction decision');
  assert.equal(result.reached.fallback, 1, 'rejection reached the existing fallback');
  assert.equal(result.reached.inventory + result.reached.disclosure + result.reached.facts, 0);
});

test('trailing role slots outside the closed subject grammar retain HEAD', async t => {
  const f = fixture(t);
  const control = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(control.body.ledger.expense_total_minor, 300);
  for (const [question, kind] of [
    ['Could you retrieve balances for my business?', 'balance'],
    ['Show balances for the company', 'balance'],
    ['Could you retrieve balances for my biz?', 'balance'],
    ['Could you retrieve spending for my household last month?', 'expense_summary'],
  ]) await headEqual(f, question, kind);
});

test('a proposed account is excluded and named while confirmed peers still contribute', async t => {
  const f = fixture(t);
  const question = 'what did the business spend last month';
  const green = await ask(withLedgerAnswer, f, question, 'expense_summary', 'business');
  assert.equal(green.body.ledger.expense_total_minor, 300);
  f.raw("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='reserve'");
  const result = await ask(withLedgerAnswer, f, question, 'expense_summary', 'business');
  assert.ok(result.reached.inventory, 'proposed-account decision reached');
  assert.equal(result.body.ledger?.expense_total_minor, 100, 'confirmed peer remains the sole contributor');
  assert.match(result.body.answer, /8102[^\n]*not counted/);
  assert.equal(result.body.ledger.scope_complete, false);
  assert.equal(result.body.evidence_gate.complete, false);
});

test('literal role names and entity endpoints retain their actual account identities', async t => {
  const f = fixture(t);
  const green = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(green.body.ledger.expense_total_minor, 300);
  for (const label of ['Personal', 'Biz', 'Business Unit']) {
    f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='operating'", label);
    const result = await ask(withLedgerAnswer, f, `Could you retrieve balances for the account named ${label}?`, 'balance', label);
    await headEqual(f, `Could you retrieve balances for the account named ${label}?`, 'balance', label);
    await headEqual(f, `Could you retrieve balances for ${label}?`, 'balance', label);
  }
  f.raw("UPDATE fin_entities SET display_label='Company Unit' WHERE entity_slug='operating'");
  f.raw("UPDATE fin_accounts SET label='Unit' WHERE account_slug='reserve'");
  f.raw("UPDATE fin_entities SET basis_state='proposed' WHERE entity_slug='reserve'");
  const result = await ask(withLedgerAnswer, f, 'transfers from Company Unit to personal last month', 'transfers');
  await headEqual(f, 'transfers from Company Unit to personal last month', 'transfers');
});

test('empty pure-role membership cannot widen after its populated green control', async t => {
  const f = fixture(t);
  const question = 'what did the business spend last month';
  const green = await ask(withLedgerAnswer, f, question, 'expense_summary', 'business');
  assert.equal(green.body.ledger.expense_total_minor, 300);
  f.raw("UPDATE fin_entities SET kind='person' WHERE kind='business'");
  const result = await ask(withLedgerAnswer, f, question, 'expense_summary', 'business');
  assert.ok(result.reached.inventory, 'empty membership decision reached inventory');
  assert.ok(result.reached.disclosure, 'empty membership decision still reads uncertainty');
  assert.equal(result.reached.facts, 0);
  assert.doesNotMatch(result.body.answer, /\$[\d,]+\.\d{2}/);
  assert.match(result.body.answer, /8104[^\n]*not counted/);
  assert.deepEqual(result.body.citations, []);
  assert.equal(result.body.evidence_gate.complete, false);
});

test('neutral balance wording outside the closed grammar retains HEAD', async t => {
  const f = fixture(t);
  const green = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(green.body.ledger.expense_total_minor, 300);
  for (const question of [
    'Could you retrieve balances for all of my business accounts?',
    'Could you retrieve balances for each of my business accounts?',
    'Could you show my business accounts and their balances?',
  ]) await headEqual(f, question, 'balance', 'business');
});

test('unavailable pure-role inventory fails closed after a populated numeric control', async t => {
  const f = fixture(t);
  const question = 'what did my business spend last month';
  assert.equal((await ask(withLedgerAnswer, f, question, 'expense_summary', 'business')).body.ledger.expense_total_minor, 300);
  const prepare = f.env.DB.prepare;
  let attempts = 0;
  f.env.DB.prepare = sql => {
    if (sql.startsWith('SELECT a.account_slug,a.mask,a.label')) { attempts++; throw new Error('synthetic unavailable inventory'); }
    return prepare(sql);
  };
  const result = await ask(withLedgerAnswer, f, question, 'expense_summary', 'business');
  assert.equal(result.reached.provider, 1, 'valid role intent was admitted');
  assert.equal(result.reached.fallback, 0, 'inventory failure cannot use document money');
  const body = result.body;
  assert.equal(attempts, 1, 'unavailable inventory decision was reached');
  assert.doesNotMatch(body.answer, /\$[\d,]+\.\d{2}/);
  assert.match(body.answer, /No total/);
  assert.deepEqual(body.citations, []);
  assert.equal(body.evidence_gate.complete, false);
});

test('the replay observes ordinary money and providerless pure-role refusal within its capability boundary', () => {
  const c = BASE_CASES.find(item => item.id === 'M05');
  for (const question of [c.question, 'what did my business spend last month']) {
    const run = replay({ cases: [{ ...c, question }] });
    const observation = run.observations[0];
    assert.equal(observation.execution_status, 'complete');
    assert.deepEqual(observation.fatal, []);
    assert.ok(observation.trace.parsed_intents.length, 'actual classifier observed');
    if (question === c.question) {
      assert.ok(observation.trace.dependencies.includes('inventory'), 'populated ordinary account control reached');
      assert.ok(observation.trace.dependencies.includes('transactions'), 'ordinary transaction observations reached');
    } else {
      assert.equal(observation.trace.parsed_intents.at(-1).kind, null, 'pure question reaches the real classifier');
      assert.equal(observation.trace.model_calls, 0, 'replay has no model capability');
      assert.equal(observation.trace.fallback_calls, 1, 'no admitted provider selectors reaches the document continuation');
      assert.equal(observation.body.ledger, undefined);
      assert.deepEqual(observation.trace.dependencies, []);
    }
    assert.equal(observation.trace.product_writes, 0);
    assert.equal(observation.trace.host_guards.subprocess, false);
    assert.equal(observation.trace.host_guards.external_read, false);
  }
});

test('role vocabulary in a document task retains its document response', async t => {
  const f = fixture(t);
  const green = await ask(withLedgerAnswer, f, 'what did my business spend last month', 'expense_summary', 'business');
  assert.equal(green.body.ledger.expense_total_minor, 300, 'populated money decision control');
  const before = f.calls.length;
  let documents = 0, providers = 0;
  const bytes = '{"route":"documents","answer":"Policy details"}';
  const result = await withLedgerAnswer({ env: f.env, question: 'What is our policy on moves from business to personal this year?',
    now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: () => { providers++; assert.fail('document task cannot enter money provider'); } },
    () => { documents++; return new Response(bytes); });
  assert.equal(documents, 1, 'document decision reached');
  assert.equal(providers, 0);
  assert.equal(f.calls.length, before, 'no ledger reads for a document task');
  assert.equal(await result.text(), bytes);
});

// Same slice: debt-payment refusal, movement proof, pending linkage and the explicit gross view were reviewed.
// Pin the integrated reader, including the closed-world payment and category
// guards. Existing behavioral and mutation controls still exercise its decisions.
test('ordinary reader retains the reviewed integrated implementation', () => {
  const pinned = {
  "ledger-answer.js": "415e001fb9be481c7f7bb89081586d4bd908b105db1aeb978a40143793bca99b",
  "ledger-intent.js": "6852050469c4160c64d477def3893417c005a811a7d7ff37c4f753d34588e85a",
  "ledger-intent-scope.js": "daffc71b55dc59c77b53c8c378ee899a0307bcecedcf015c6f3b4a23e81a7d42"
};
  for (const [name, hash] of Object.entries(pinned)) {
    let raw = readFileSync(new URL('../src/lib/' + name, import.meta.url), 'utf8');
    if (name === 'ledger-answer.js') raw = raw.slice(raw.indexOf('import { ledgerOperandScopePlan'))
      .replace('async function withHeadLedgerAnswer(options, next) {', 'export async function withLedgerAnswer(options, next) {')
      .replace('import { canExtractLedgerIntent, extractLedgerIntentDecision,', 'import { extractLedgerIntentDecision,');
    assert.equal(createHash('sha256').update(raw).digest('hex'), hash, name);
  }
});
