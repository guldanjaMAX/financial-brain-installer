import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { maintainAccountKind } from '../src/lib/fin-account-kinds.js';
import { total, formatMinor, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';

// Finder gold is input membership plus integer arithmetic, independent of all
// product classifiers. Failures are findings, not permission to change gold.
const seeds = [1106, 427, 3131, 5353];
const roots = {
  gross: 'worker/src/lib/ledger-answer.js:934',
  vendor: 'worker/src/lib/ledger-answer.js:1254',
  repayment: 'worker/src/lib/ledger-analysis.js:169',
  recurring: 'worker/src/lib/ledger-answer.js:1296',
  shorthand: 'worker/src/lib/ledger-analysis.js:7',
  wording: 'worker/src/lib/ledger-question.js:253',
  absence: 'worker/src/lib/ledger-answer.js:1080',
};
const reviewedGroups = {
  '1/figure': 'gross', '1/display': 'gross', '8/figure': 'vendor',
  '2/figure': 'repayment', '2/display': 'repayment', '2/spending-groups': 'repayment', '2/payment-disclosure': 'repayment',
  '4/ranking': 'repayment', '4/display': 'repayment', '4/payment-disclosure': 'repayment',
  '6/payer-shorthand': 'shorthand', '7/recurring': 'recurring', '7/figure': 'recurring',
  '7/display': 'recurring', '7/payment-disclosure': 'recurring', '7/refusal': 'wording',
  '9/absent-padding': 'absence',
};
export function generateCases() {
  return seeds.flatMap(seed => {
    let state = seed;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    return Array.from({ length: 30 }, (_, index) => {
      const day = 1 + next() % 6, months = 3 + next() % 10;
      const unit = 101 + next() % 900, payment = 100000 + next() % 90000;
      const rows = [];
      const add = (month, tag, cents, payee, extra = {}) => rows.push({
        id: `${month}-${tag}`, date: `${month}-01`, cents: String(cents),
        direction: 'outflow', account: 'fixture-account', description: 'Card purchase',
        payee, tag, ...extra,
      });
      for (let offset = months - 1; offset >= 0; offset--) {
        const month = new Date(Date.UTC(2026, 9 - offset, 1)).toISOString().slice(0, 7);
        add(month, 'workspace', unit, 'GOOGLE *WORKSPACE');
        add(month, 'cloud', unit + 11, 'GOOG *CLOUD');
        add(month, 'store', unit + 22, 'Store Unit');
        add(month, 'fuel', unit + 44, 'Fuel Unit');
        add(month, 'supplies', unit + 55, 'Supplies Unit');
        add(month, 'card-payment', payment, 'Card Issuer Unit', {
          description: 'AUTOPAY CREDIT CARD PAYMENT', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        });
        add(month, 'second-card-payment', payment + 9, 'Second Card Issuer Unit', {
          account: 'reserve', description: 'AUTOPAY CREDIT CARD PAYMENT', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        });
        add(month, 'loan-payment', payment + 1, 'payment', { description: 'payment to account 4242' });
        add(month, 'zelle', unit + 33, 'Peer Unit', { description: 'ZELLE TO Peer Unit' });
        add(month, 'refund', unit + 44, 'Store Unit', { direction: 'inflow', description: 'Refund' });
        add(month, 'payer', unit + 55, null, { direction: 'inflow', description: 'ACH CREDIT ORIG CO NAME: Payer Unit' });
        add(month, 'near', unit + 56, 'Other Payer Unit', { direction: 'inflow' });
        add(month, 'transfer-out', unit + 77, null, { description: 'TRANSFER TO account 5353' });
        add(month, 'transfer-in', unit + 77, null, { account: 'reserve', direction: 'inflow', description: 'TRANSFER FROM account 1234' });
      }
      const questions = [
        'What are my account balances?', 'How much money came in last month?',
        'What did I spend this month, and on what?', 'How much did I spend at Store Unit over the last 3 months?',
        'What were my five biggest expenses last month?',
        `Did a payment of ${formatMinor(String(unit + 55))} come in around October 1, 2026?`,
        'Did the payment from Payer Unit hit account ending 1234 this month?',
        index % 2 ? 'What do I pay every month?' : 'What do I pay for every month?', 'How much did I spend at Google this month?',
        'How much did I spend at Absent Vendor this month?',
      ];
      return questions.map((question, kind) => ({ id: `${seed}-${index}-${kind}`, seed, index, day, months, unit, payment, kind, question, rows }));
    }).flat();
  });
}

function check(c, b, identities = new Map()) {
  const failures = [], l = b.ledger;
  const fail = (group, detail) => failures.push({ group, detail });
  const eq = (actual, expected, label, lead = false) => {
    if (String(actual) !== String(expected)) fail('figure', `${label}: ${actual} != ${expected}`);
    const figures = displayFigures(b.answer);
    if (actual != null && !(lead ? figures[0]?.cents === String(expected) : figures.some(f => f.cents === String(expected))))
      fail('display', `${label}: missing ${formatMinor(String(expected))}`);
  };
  if (!l) return [{ group: 'refusal', detail: b.code || 'no ledger answer' }];
  const current = c.rows.filter(r => r.date.startsWith('2026-10'));
  const previous = c.rows.filter(r => r.date.startsWith('2026-09'));
  const ordinary = rs => rs.filter(r => ['workspace', 'cloud', 'store', 'zelle', 'fuel', 'supplies'].includes(r.tag));
  const sum = rs => total(rs.map(r => r.cents));
  if (c.kind === 0) {
    const balances = { '1234': String(c.unit * 100), '5353': String(c.unit * 200), '4242': String(c.payment * 10) };
    for (const a of l.accounts || []) eq(a.current_minor, balances[a.account_mask], 'balance');
    if (l.accounts?.length !== 3) fail('balance-scope', 'expected three accounts');
  }
  if (c.kind === 1) {
    eq(l.combined_inflow_minor, sum(previous.filter(r => r.direction === 'inflow')), 'gross deposits', true);
    // Synthetic event tags establish the counterpart independently of product
    // matching. Deleting the outgoing leg leaves its credit in outside inflow.
    const credits = previous.filter(r => r.direction === 'inflow');
    const paired = credits.filter(r => r.tag === 'transfer-in' && c.rows.some(peer =>
      peer.tag === 'transfer-out' && peer.account !== r.account && peer.cents === r.cents &&
      Math.abs(Date.parse(peer.date) - Date.parse(r.date)) <= 3 * 86400000));
    eq(l.outside_inflow_minor, (BigInt(sum(credits)) - BigInt(sum(paired))).toString(), 'outside deposits');
    if (l.income_established !== false) fail('income', 'deposits must not certify income');
  }
  if (c.kind === 2) {
    eq(l.expense_total_minor, sum(ordinary(current)), 'spending', true);
    const names = { workspace: 'google workspace', cloud: 'goog cloud', store: 'store unit',
      zelle: 'peer unit', fuel: 'fuel unit', supplies: 'supplies unit' };
    const expected = new Map(ordinary(current).map(r => [names[r.tag], r.cents]));
    const groups = l.groups || [];
    if (l.group_count !== expected.size || groups.length + l.omitted_group_count !== expected.size ||
      groups.some(g => expected.get(g.merchant) !== String(g.total_minor) || g.count !== 1))
      fail('spending-groups', 'the spending breakdown contains repayments or wrong merchant figures');
  }
  if (c.kind === 3) eq(l.total_minor, sum(c.rows.filter(r => r.tag === 'store' && r.date >= `2026-07-0${c.day}`)), 'merchant', true);
  if (c.kind === 4) {
    const expected = ordinary(previous).map(r => r.cents).sort((a, b) => Number(b) - Number(a)).slice(0, 5);
    if (JSON.stringify(l.lead_rows?.map(r => String(r.amount_minor))) !== JSON.stringify(expected))
      fail('ranking', `biggest expenses contain repayments or omit purchases`);
    if (JSON.stringify(displayFigures(b.answer).slice(0, expected.length).map(r => r.cents)) !== JSON.stringify(expected))
      fail('display', 'printed biggest expenses differ from the input ranking');
  }
  if (c.kind === 5) {
    const expected = current.filter(r => r.direction === 'inflow' && r.cents === String(c.unit + 55));
    // S10 deliberately discloses nearby amounts for an amount-only lookup.
    // Prove the exact receipt separately, and independently bound every extra
    // citation so those alternatives cannot masquerade as a matching deposit.
    const nearby = current.filter(r => r.direction === 'inflow' && r.cents !== String(c.unit + 55) &&
      Math.abs(Number(r.cents) - (c.unit + 55)) <= 100 &&
      Math.abs(Date.parse(r.date) - Date.parse('2026-10-01')) <= 3 * 86400000);
    const exactRefs = (b.citations || []).filter(r => String(r.amount_minor) === String(c.unit + 55));
    const extraRefs = (b.citations || []).filter(r => String(r.amount_minor) !== String(c.unit + 55));
    if (l.found !== Boolean(expected.length) || l.match_count !== expected.length || exactRefs.length !== expected.length ||
      exactRefs.some(r => identities.get(r.ref)?.tag !== 'payer' || r.posted_on !== '2026-10-01' || r.account_mask !== '1234') ||
      extraRefs.length !== nearby.length || extraRefs.some(ref => !nearby.some(row => identities.get(ref.ref) === row)) ||
      extraRefs.some(ref => !b.answer.includes(`(different amount, not a match): ${formatMinor(String(ref.amount_minor))}`)))
      fail('exact-payment', 'exact receipt and independently bounded nearby disclosures must stay separate');
  }
  if (c.kind === 6) {
    const payer = current.filter(r => r.tag === 'payer');
    if (payer.length && (l.found !== true || !b.citations?.some(r => r.account_mask === '1234' &&
      String(r.amount_minor) === String(c.unit + 55) && r.posted_on === '2026-10-01' && identities.get(r.ref)?.tag === 'payer')))
      fail('payer-shorthand', 'named payer shorthand receipt missing');
  }
  if (c.kind === 7) {
    const names = ['GOOGLE *WORKSPACE', 'GOOG *CLOUD', 'Store Unit', 'Peer Unit', 'Fuel Unit', 'Supplies Unit'];
    const allowed = new Map(['google workspace', 'goog cloud', 'store unit', 'peer unit', 'fuel unit', 'supplies unit'].map((name, i) => [name, String(c.unit + i * 11)]));
    for (const r of l.recurring || []) if (!allowed.has(r.merchant) || String(r.monthly_minor) !== allowed.get(r.merchant))
      fail('recurring', `non-expense recurring: ${r.merchant}`);
    // These independently specified series pay a constant price on day one.
    // Require three consecutive owner-calendar months ending now or last month;
    // do not copy the product detector's interval tolerance or median algorithm.
    const series = names.map((name, i) => [name, String(c.unit + i * 11)]).filter(([name]) => {
      const months = new Set(c.rows.filter(r => r.direction === 'outflow' && r.payee === name).map(r => r.date.slice(0, 7)));
      return [0, 1].some(end => [0, 1, 2].every(back =>
        months.has(new Date(Date.UTC(2026, 9 - end - back, 1)).toISOString().slice(0, 7))));
    });
    eq(l.monthly_total_minor, total(series.map(([, cents]) => cents)), 'monthly recurring');
  }
  if (c.kind === 8) eq(l.total_minor, sum(current.filter(r => ['workspace', 'cloud'].includes(r.tag))), 'vendor family', true);
  if (c.kind === 9 && (displayFigures(b.answer).length || /closest|you spent|total money/i.test(b.answer)))
    fail('absent-padding', 'absent vendor must have no figure or unrelated padding');
  if ([2, 4, 7].includes(c.kind)) {
    const relevant = c.kind === 2 ? current : c.kind === 4 ? previous : c.rows.filter(r => r.date >= (l.from || ''));
    const payments = relevant.filter(r => /-payment$/.test(r.tag) &&
      (c.kind !== 7 || relevant.filter(other => other.tag === r.tag).length >= 3));
    if (payments.length && (String(l.own_account_payments?.total_minor) !== sum(payments) || !/payment.*(?:left out|excluded|own loan\/card)/is.test(b.answer)))
      fail('payment-disclosure', 'excluded loan/card payments need exact disclosed total');
  }
  return failures;
}

const inflowContract = process.env.OWNER_INFLOW_CONTRACT === '1' || process.argv.includes('--inflow-contract');
test(inflowContract ? 'owner ten shapes: all 120 money-in gross cases stay correct' :
  'owner ten shapes: 1,200 seeded real ledger answers, shrunk and grouped findings', async t => {
  const f = ledgerFixture(t);
  f.raw("UPDATE fin_balance_snapshots SET as_of_date='2026-10-01'");
  f.env.AI.run = async () => assert.fail('money answers must not call a model');
  t.mock.method(globalThis, 'fetch', () => assert.fail('offline finder'));
  for (const [slug, kind, role, mask] of [['reserve', 'checking', 'asset', '5353'], ['debt', 'loan', 'liability', '4242']]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,'live','feed','bank-feed:fixture-feed','confirmed',?)`, slug, kind, role, mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'complete','2025-01-01','2026-10-31',?,'feed','bank-feed:fixture-feed','confirmed',?)`, slug, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'2026-10-01',0,'feed','bank-feed:fixture-feed','confirmed',?)`, slug, NOW);
  }
  const review = { selector: 'debt', kind: 'loan', now: NOW };
  const preview = await maintainAccountKind(f.env, review);
  await maintainAccountKind(f.env, { ...review, dryRun: false, approve: preview.plan_hash });
  async function evaluate(c, answer = withLedgerAnswer) {
    // SQL tracing is evidence per invocation, not an unbounded history of
    // every shrink attempt (which otherwise dominates this generated test).
    f.calls.length = 0;
    for (const [slug, cents] of [['fixture-account', c.unit * 100], ['reserve', c.unit * 200], ['debt', c.payment * 10]])
      f.raw('UPDATE fin_balance_snapshots SET current_minor=? WHERE account_slug=?', cents, slug);
    f.raw('DELETE FROM fin_transactions');
    const identities = new Map();
    for (const r of c.rows) {
      const receipt = f.raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,category,category_basis_state,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    r.id, r.account, r.date, Number(r.cents), r.direction, r.description, r.payee, r.category || null, r.category ? 'confirmed' : null, NOW);
      // Identity comes from this fixture's insert receipt, not product matching.
      identities.set(`ledger:transaction:${receipt.lastInsertRowid}`, r);
    }
    const before = f.first('SELECT total_changes() n').n;
    const b = await (await answer({ env: f.env, question: c.question, now: `2026-10-0${c.day}T19:00:00Z`,
      timeZone: 'America/Phoenix', grantScope: { all: true }, scopePrincipalKind: 'owner' },
    async () => Response.json({ route: 'documents' }))).json();
    assert.equal(f.first('SELECT total_changes() n').n, before, 'answers cannot write');
    if (b.ledger && c.kind !== 0) assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction reader reached');
    return { b, failures: check(c, b, identities) };
  }
  const cases = generateCases().filter(c => !inflowContract || c.kind === 1), groups = {}, affected = new Map();
  const stats = { cases: cases.length, wrong_figures: 0, over_refusals: 0, groups };
  for (const c of cases) {
    const result = await evaluate(c);
    if (result.failures.some(r => ['figure', 'display', 'ranking', 'recurring', 'spending-groups'].includes(r.group))) stats.wrong_figures++;
    if (result.failures.some(r => r.group === 'refusal') ||
      result.b.ledger?.found === null && result.failures.some(r => r.group === 'payer-shorthand')) stats.over_refusals++;
    for (const failure of result.failures) {
      // Shrink every occurrence by deletion, keeping the same failed property.
      // Removed rows never change the input-derived oracle's membership rules.
      let small = c;
      const key = `${c.kind}/${failure.group}`;
      const root = reviewedGroups[key];
      assert.ok(root, `ungrouped new finding ${key}: ${failure.detail}`);
      if (!affected.has(root)) affected.set(root, new Set());
      affected.get(root).add(c.id);
      const reproduces = async candidate => {
        // Do not shrink a repayment defect into a different defect caused by
        // deleting one leg of an otherwise fully proved owned transfer.
        if (['repayment', 'recurring'].includes(root) && candidate.rows.some(r => r.tag === 'transfer-out' &&
          !candidate.rows.some(other => other.tag === 'transfer-in' && other.date === r.date && other.cents === r.cents))) return false;
        if (root === 'repayment' && !candidate.rows.some(r => /card-payment$/.test(r.tag) &&
          r.date.startsWith(c.kind === 2 ? '2026-10' : '2026-09'))) return false;
        return (await evaluate(candidate)).failures.some(r => r.group === failure.group);
      };
      // Reuse a previous witness only as a candidate projection. Re-execute
      // this case's own amounts and prove the same property still fails.
      if (groups[key]) {
        const ids = new Set(groups[key].witness.rows.map(r => r.id));
        const projected = { ...c, rows: c.rows.filter(r => ids.has(r.id)) };
        if (await reproduces(projected)) small = projected;
      }
      for (let width = Math.ceil(small.rows.length / 2); width > 1; width = Math.floor(width / 2)) {
        for (let i = 0; i < small.rows.length;) {
          const candidate = { ...small, rows: small.rows.filter((_, j) => j < i || j >= i + width) };
          if (await reproduces(candidate)) small = candidate;
          else i += width;
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < small.rows.length;) {
          const candidate = { ...small, rows: small.rows.filter((_, j) => i !== j) };
          if (await reproduces(candidate)) { small = candidate; changed = true; }
          else i++;
        }
      }
      const group = groups[key] ||= { root, location: roots[root], count: 0, witness: { id: c.id, question: c.question, rows: small.rows }, detail: failure.detail };
      group.count++;
    }
  }
  stats.root_groups = Object.fromEntries([...affected].map(([root, ids]) => [root, { location: roots[root], cases: ids.size }]));
  stats.gross_group_now = affected.get('gross')?.size || 0;
  stats.owner_g1 = affected.get('repayment')?.size || 0;
  stats.owner_g2 = affected.get('recurring')?.size || 0;
  stats.vendor_group = affected.get('vendor')?.size || 0;
  console.log('OWNER_TEN_SHAPES ' + JSON.stringify(stats));
  if (inflowContract) {
    const probe = cases[0];
    const witness = { ...probe, rows: probe.rows.filter(r => r.tag === 'transfer-in' && r.date.startsWith('2026-09')) };
    assert.equal(witness.rows.length, 1);
    assert.equal(witness.rows[0].cents, '529');
    assert.deepEqual((await evaluate(witness)).failures, [], 'single-leg replay witness retains gross and outside inflow');
    t.diagnostic('unpaired_witness gross=529 outside=529');
    assert.equal(cases.length, 120);
    assert.deepEqual(groups, {}, 'money-in gross group must remain zero');
    assert.equal(stats.wrong_figures, 0);
    return;
  }
  assert.equal(cases.length, 1200);
  assert.equal(new Set(cases.map(c => c.id)).size, 1200);
  assert.deepEqual([...new Set(cases.map(c => c.day))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...new Set(cases.map(c => c.months))].sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(new Set(cases.map(c => c.kind)).size, 10);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'real ledger readers reached');
  for (const group of Object.values(groups)) assert.ok(group.count > 0 && group.witness.id);

  // The historical finder trial expected broken repayment behavior. The
  // integration must now close its money groups and still kill those defects.
  assert.equal(stats.owner_g1, 0, 'owner G1 repayment group');
  assert.equal(stats.owner_g2, 0, 'owner G2 recurring group');
  assert.equal(stats.vendor_group, 0, 'vendor family group');
  assert.equal(stats.gross_group_now, 0, 'money-in gross contract');
  assert.equal(stats.wrong_figures, 0);
  // Direct-parser shorthand and everyday recurring wording are carried
  // finder refusals. Their model-admitted paths have separate strict suites.
  assert.deepEqual(Object.keys(groups).sort(), ['6/payer-shorthand', '7/refusal'], 'only the carried unsupported direct-parser forms remain');
  const base = new URL('../src/lib/', import.meta.url);
  const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const absolute = source => source.replace(/from (["'])(\.\/.+?)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, base).href}${quote}`);
  const analysis = readFileSync(new URL('ledger-analysis.js', base), 'utf8');
  const answer = readFileSync(new URL('ledger-answer.js', base), 'utf8');
  const site = 'export function loanCardPaymentKind(row, accounts) {';
  assert.equal(analysis.split(site).length - 1, 1, 'payment decision reached');
  const probe = cases.find(c => c.kind === 2);
  const brokenSource = analysis.replace(site, site + '\n  return null;');
  const broken = (await import(data(absolute(answer.replace('"./ledger-analysis.js"',
    JSON.stringify(data(absolute(brokenSource)))))))).withLedgerAnswer;
  assert.ok((await evaluate(probe, broken)).failures.some(r => r.group === 'figure'), 'repayment defect is killed');
  for (const kind of [2, 4, 7]) {
    const control = cases.find(c => c.kind === kind);
    assert.deepEqual((await evaluate(control)).failures, [], 'real repaired membership and disclosure control');
  }
  const overbroad = analysis.replace(site, site + "\n  if (row.description === 'Card purchase') return 'card';");
  const purchaseMutant = (await import(data(absolute(answer.replace('"./ledger-analysis.js"',
    JSON.stringify(data(absolute(overbroad)))))))).withLedgerAnswer;
  assert.ok((await evaluate(probe, purchaseMutant)).failures.some(r => r.group === 'figure'), 'card purchases remain spending');
  const green = (await evaluate(probe)).b;
  const offByOne = structuredClone(green);
  offByOne.ledger.expense_total_minor++;
  assert.ok(check(probe, offByOne).some(r => r.group === 'figure'), 'independent cents oracle kills one-cent corruption');
  const printedOffByOne = structuredClone(green);
  printedOffByOne.answer = green.answer.replace(formatMinor(String(green.ledger.expense_total_minor)),
    formatMinor(String(green.ledger.expense_total_minor + 1)));
  assert.notEqual(printedOffByOne.answer, green.answer, 'printed mutation reaches a displayed figure');
  assert.ok(check(probe, printedOffByOne).some(r => r.group === 'display'), 'printed one-cent corruption is independently rejected');
  assert.deepEqual((await evaluate(probe)).failures, [], 'green restored after four corruption controls');
  console.log('OWNER_INTEGRATION mutants_killed=4/4');
});
