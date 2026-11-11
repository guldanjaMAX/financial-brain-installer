import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { accountLinkIdentity } from '../src/lib/fin-account-links.js';
import { parseTestCommand, POST_LAUNCHER_TEST_COMMANDS, TEST_COMMANDS } from '../../scripts/run-test-chain.mjs';
import { MONEY_JARGON } from './fixtures/plain-copy-expectations.mjs';

const NOW = '2026-10-31T19:00:00Z';
const db = new DatabaseSync(':memory:');
const totals = { requests: 0, inventory_reads: 0, fact_reads: 0, candidate_rows: 0, injected_extractions: 0 };
for (const file of readdirSync(new URL('../../migrations/d1/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../../migrations/d1/${file}`, import.meta.url), 'utf8'));
}
after(() => { db.close(); console.log(`C1_RECEIPT ${JSON.stringify(totals)}`); });

const QUESTIONS = [
  'Show my three largest charges this month.',
  'List the three biggest expenses this month.',
  'What are my top three charges this month?',
  'Show me my largest three expenses this month.',
  'What were the three largest charges in October 2026?',
  'List my biggest three expenses in October 2026.',
  'Show the top three charges in October 2026.',
  'What are the largest three expenses in October 2026?',
  'My three biggest charges this month.',
  'The top three expenses this month.',
  'Show me the three largest charges this month.',
  'List three biggest expenses this month.',
];

function seed(profile) {
  db.exec('BEGIN');
  db.prepare(`INSERT INTO fin_entities (entity_slug,legal_name,display_label,kind,status,relationship,provenance,basis_state,recorded_at)
    VALUES ('owner','Synthetic owner','Synthetic owner','business','active','owned','owner_stated','confirmed',?)`).run(NOW);
  for (let index = 0; index < 41; index++) {
    const slug = `account-${index}`, mask = String(1000 + index);
    db.prepare(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner','checking','asset',?,?,'manual','owner_stated','confirmed',?)`).run(slug, mask, `Account ${mask}`, NOW);
    const from = profile === 'unknown' || index >= 33 && !['full', 'empty-full'].includes(profile) ? null : '2026-07-01';
    db.prepare(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete',?,'2026-11-07',?,'owner_stated','confirmed',?)`).run(slug, from, NOW, NOW);
  }
  if (!['empty', 'empty-full'].includes(profile)) for (const [id, slug, cents, day, payee] of [
    [1, 'account-0', 9000, '2026-10-22', 'Store One'],
    [2, 'account-0', 4000, '2026-10-20', 'Store Two'],
    [3, 'account-0', 2000, '2026-10-19', 'Store Three'],
    [900, 'account-40', 900000, '2026-10-23', 'Hidden Store'],
  ]) db.prepare(`INSERT INTO fin_transactions (id,txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,'outflow',?,?,0,'owner_stated','confirmed',?)`).run(id, `row-${id}`, slug, day, cents, payee, payee, NOW);
}

async function ask(question, profile = 'mixed', { answer = withLedgerAnswer, setup = () => {}, failRead = false, intent = null, now = NOW, expectInventory = true } = {}) {
  seed(profile);
  const trace = { inventory: 0, facts: 0, rows: [], mappings: [], fallback: 0, models: 0 };
  try {
    setup(db);
    const changes = db.prepare('SELECT total_changes() n').get().n;
    db.exec('PRAGMA query_only=ON');
    const execute = (sql, binds) => {
      assert.match(sql.trim(), /^(?:SELECT|WITH)\b/);
      const inventory = sql.includes('FROM fin_accounts a');
      if (inventory) trace.inventory++;
      else { trace.facts++; trace.mappings.push(JSON.parse(binds[0])); }
      if (failRead && !inventory) throw Error('synthetic read failure');
      const rows = db.prepare(sql).all(...binds);
      if (!inventory) trace.rows.push(...rows);
      return { results: rows };
    };
    const prepare = (sql, binds = []) => ({ sql, binds, bind: (...values) => prepare(sql, values),
      all: async () => execute(sql, binds) });
    const body = await (await answer({ question, now, grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => {
        trace.models++;
        assert.ok(intent, 'a grammar control must never request a model');
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
          intents: (Array.isArray(intent) ? intent : [intent]).map(value => ({ kind: 'merchant', direction: 'outflow',
            count: null, vendor_text: null, account_hint: null, amount_text: null, date_text: null,
            period: { type: 'none' }, ...value })) }) }] };
      },
      env: { ANTHROPIC_API_KEY: ['fixture', 'unused'].join(':'), BRAIN_TIMEZONE: 'America/Phoenix', DB: { prepare, batch: async statements =>
        statements.map(statement => execute(statement.sql, statement.binds)) } },
    }, async gap => { trace.fallback++; return Response.json({ answer: null, ledger: null, gaps: [gap] }); })).json();
    if (expectInventory) assert.ok(trace.inventory > 0, 'the real account inventory and period decision were reached');
    else assert.equal(trace.inventory, 0, 'invalid operations stop before inventory');
    assert.equal(trace.models, intent ? 1 : 0, 'the expected real admission path ran');
    assert.equal(db.prepare('SELECT total_changes() n').get().n, changes, 'the product made no database writes');
    totals.requests++; totals.inventory_reads += trace.inventory; totals.fact_reads += trace.facts;
    totals.candidate_rows += trace.rows.length; totals.injected_extractions += trace.models;
    return { body, trace };
  } finally { db.exec('PRAGMA query_only=OFF'); db.exec('ROLLBACK'); }
}

function rankAmounts(result) {
  assert.ok(result.trace.facts > 0, 'the real SQL fact reader ran');
  assert.ok(result.trace.rows.length > 0, 'a nonempty candidate pool reached the ranking');
  assert.equal(result.body.ledger?.kind, 'largest');
  return result.body.ledger.lead_rows.map(row => row.amount_minor);
}

test('SimpleFIN ranking reports the current coverage decision with full, partial and unavailable controls', async () => {
  const simplefinAnswer = (options, next) => withLedgerAnswer({
    ...options, env: { ...options.env, BANK_FEED_PROVIDER: 'simplefin' },
  }, next);
  for (const profile of ['full', 'mixed']) {
    const control = await ask(QUESTIONS[0], profile);
    const result = await ask(QUESTIONS[0], profile, { answer: simplefinAnswer });
    const expected = profile === 'full' ? [900000, 9000, 4000] : [9000, 4000, 2000];
    assert.deepEqual(rankAmounts(control), expected, 'the existing provider path is a nonempty green control');
    assert.deepEqual(rankAmounts(result), expected, 'the selected provider must reach the same real ranking');
    assert.equal(result.body.ledger.complete, profile === 'full');
    if (profile === 'mixed') {
      assert.equal(result.body.ledger.coverage.complete, false);
      assert.equal(result.body.ledger.coverage.covered_account_count, 33);
      assert.equal(result.body.ledger.coverage.candidate_account_count, 41);
    } else {
      assert.equal(Object.hasOwn(result.body.ledger, 'coverage'), false,
        'the existing full-coverage shape omits the partial-account scope');
      assert.equal(result.body.ledger.accounts.length, 41);
    }
  }
  for (const answer of [withLedgerAnswer, simplefinAnswer]) {
    const refused = await ask(QUESTIONS[0], 'unknown', { answer });
    assert.ok(refused.trace.inventory > 0, 'unavailable coverage reached the inventory decision');
    assert.equal(refused.trace.facts, 0, 'no uncovered figures reach the ranking');
    assert.equal(refused.body.ledger, null);
    assert.equal(refused.body.gaps[0].reason, 'period_outside_coverage');
  }
});

test('R2-C1-01 validated day ranking keeps exact rows and the covered denominator', async () => {
  for (const profile of ['full', 'mixed']) {
    const result = await ask('Could you retrieve my largest individual charges since October 21, 2026?', profile, {
      intent: { kind: 'largest', direction: 'outflow' },
      setup: db => db.exec('DELETE FROM fin_transactions WHERE id=900'),
    });
    assert.deepEqual(rankAmounts(result), [9000]);
    assert.equal(result.body.ledger.from, '2026-10-21');
    assert.equal(result.body.ledger.to, '2026-10-31');
    assert.equal(result.body.evidence_gate.supported, true);
    assert.equal(result.body.ledger.partial_reason === 'ledger_partial_coverage', profile === 'mixed');
    assert.deepEqual(result.body.citations.filter(row => row.ref === 'ledger:transaction:1').map(row => row.amount_minor), [9000]);
    if (profile === 'mixed') {
      assert.equal(result.body.ledger.coverage.covered_account_count, 33);
      assert.equal(result.body.ledger.coverage.candidate_account_count, 41);
      assert.match(result.body.answer, /33 of 41 accounts/);
    }
  }
});

const DAY_RANKS = [
  'Could you retrieve my largest individual charges since October 21, 2026?',
  'Please list our biggest single purchases since October 21, 2026.',
  'Fetch the highest posted payments on or after October 21, 2026.',
  'Show my top expenses from October 21, 2026 through October 30, 2026.',
  'What are the largest charges between October 21, 2026 and October 30, 2026?',
  'Get my priciest purchases since 2026-10-21.',
  'Could you pull up our most expensive transactions since Oct. 21, 2026?',
  'Which purchases cost us the most since 10/21/2026?',
  'Rank my individual charges since October 21st, 2026.',
  'Give me the biggest expenses since October 21, 2026.',
];
const datedPool = db => {
  db.exec('DELETE FROM fin_transactions WHERE id=900');
  db.exec("UPDATE fin_accounts SET label=CASE WHEN account_slug='account-0' THEN 'River Checking' ELSE 'Valley Savings' END");
  const rows = db.prepare('SELECT * FROM fin_transactions ORDER BY id DESC').all();
  db.exec('DELETE FROM fin_transactions');
  for (const row of rows) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO fin_transactions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
};
test('R2-C1-01 ten calendar paraphrases use independent cents and exact contributors', async () => {
  for (const question of DAY_RANKS) for (const profile of ['full', 'mixed']) {
    const result = await ask(question, profile, { intent: { kind: 'largest', direction: 'outflow' }, setup: datedPool });
    assert.ok(result.trace.facts > 0, question + JSON.stringify(result.body.gaps));
    assert.deepEqual(rankAmounts(result), [9000], question);
    assert.equal(result.body.ledger.from, '2026-10-21');
    assert.deepEqual(result.body.citations.map(row => row.ref), ['ledger:transaction:1']);
    assert.equal(result.trace.rows.find(row => row.id === 1).source_account_slug, 'account-0');
    assert.equal(result.body.evidence_gate.supported, true);
    assert.equal(result.body.ledger.partial_reason === 'ledger_partial_coverage', profile === 'mixed');
    assert.ok(result.trace.mappings.some(mapping => mapping.length === 41));
    assert.deepEqual(result.trace.mappings.find(mapping => mapping.length === 41).map(row => row.slug).sort(),
      Array.from({ length: 41 }, (_, index) => `account-${index}`).sort());
  }
});

test('R2-C1-01 restoring dated rejection loses the day arm and keeps the month peer', async () => {
  const answer = await answerMutant('if (intent.rankingCalendarRole) {', 'if (false && intent.rankingCalendarRole) {');
  const options = { answer, intent: { kind: 'largest', direction: 'outflow' }, setup: datedPool };
  const month = await ask('Could you retrieve my largest individual charges since October 2026?', 'mixed', options);
  assert.deepEqual(rankAmounts(month), [9000, 4000, 2000]);
  const day = await ask(DAY_RANKS[0], 'mixed', options);
  assert.equal(day.trace.models, 1);
  assert.ok(day.trace.inventory > 0);
  assert.equal(day.body.gaps[0].reason, 'unsupported_question');
  assert.throws(() => rankAmounts(day), assert.AssertionError);
});

test('R2-C1-01 dated aggregate and invented calendar roles keep honest refusals', async () => {
  const intent = { kind: 'largest', direction: 'outflow' };
  for (const question of [
    'Which account had the largest total charges since October 21, 2026?',
    'Which vendor had the largest total charges since October 21, 2026?',
    'Could you retrieve my largest charges calendar period?',
  ]) {
    assert.deepEqual(rankAmounts(await ask(DAY_RANKS[0], 'mixed', { intent, setup: datedPool })), [9000]);
    refusedUnit(await ask(question, 'mixed', { intent, setup: datedPool }));
  }
});

test('R2-C1-01 invalid and future calendar operands cannot supply ranking authority', async () => {
  const intent = { kind: 'largest', direction: 'outflow' };
  for (const date of ['October 32, 2026', 'November 2, 2026', '2026-02-30']) {
    const result = await ask(`Could you retrieve my largest individual charges since ${date}?`, 'mixed',
      { intent, setup: datedPool, expectInventory: false });
    assert.equal(result.trace.models, 1, 'schema-valid nonempty provider extraction reached calendar validation');
    assert.equal(result.body.ledger ?? null, null);
    assert.equal(result.body.gaps[0].reason, 'period_contradiction');
    assert.equal(result.body.gaps[0].scope, 'calendar');
    assert.deepEqual(rankAmounts(await ask(DAY_RANKS[0], 'mixed', { intent, setup: datedPool })), [9000]);
  }
});

test('C1 largest charges: twelve independent phrasings retain full and mixed scopes', async () => {
  for (const question of QUESTIONS) {
    assert.equal(classifyLedgerQuestion(question, { now: NOW, timeZone: 'America/Phoenix' }).kind, 'largest');
    const full = await ask(question, 'full');
    assert.deepEqual(rankAmounts(full), [900000, 9000, 4000]);
    assert.equal(full.body.evidence_gate.complete, true);
    const partial = await ask(question);
    assert.deepEqual(rankAmounts(partial), [9000, 4000, 2000]);
    assert.equal(partial.body.evidence_gate.complete, false);
    assert.equal(partial.body.ledger.complete, false);
    assert.equal(partial.body.ledger.coverage.candidate_account_count, 41);
    assert.equal(partial.body.ledger.coverage.covered_account_count, 33);
    assert.equal(partial.body.ledger.coverage.omitted_account_count, 8);
    assert.deepEqual(partial.body.ledger.coverage.excluded_accounts.map(account => account.account_mask),
      Array.from({ length: 8 }, (_, index) => String(1033 + index)));
    assert.match(partial.body.answer, /partial/i);
    assert.match(partial.body.answer, /33 of 41 accounts/);
    assert.match(partial.body.answer, /larger charges/i);
    for (let mask = 1033; mask <= 1040; mask++) assert.ok(partial.body.answer.includes(String(mask)));
    assert.ok(partial.trace.mappings.some(mapping => mapping.length === 41), 'pairing retains the entire authorized inventory');
  }
});

test('C1 totals: partial receipts retain a subtotal and withhold a complete combined figure', async () => {
  const question = 'How much money came in this month?';
  const setup = db => db.exec("UPDATE fin_transactions SET direction='inflow'");
  const full = await ask(question, 'full', { setup });
  assert.equal(full.body.ledger.combined_inflow_minor, 915000);
  assert.equal(full.body.evidence_gate.complete, true);
  const mixed = await ask(question, 'mixed', { setup });
  assert.ok(mixed.trace.facts > 0 && mixed.trace.rows.length > 0);
  assert.equal(mixed.body.ledger.kind, 'totals');
  assert.equal(mixed.body.ledger.covered_inflow_subtotal_minor, 15000);
  assert.equal(mixed.body.ledger.combined_inflow_minor, null);
  assert.equal(mixed.body.ledger.complete_total_minor, null);
  assert.equal(mixed.body.evidence_gate.complete, false);
  assert.match(mixed.body.answer, /33 of 41 accounts/);
  const unknown = await ask(question, 'unknown', { setup });
  assert.equal(unknown.body.ledger, null);
  assert.equal(unknown.body.gaps[0].reason, 'period_outside_coverage');
});

const cadence = db => {
  db.exec('DELETE FROM fin_transactions');
  for (const [id, day] of [[11, '2026-10-15'], [12, '2026-10-22'], [13, '2026-10-29']]) {
    db.prepare(`INSERT INTO fin_transactions (id,txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at)
      VALUES (?,?,'account-0',?,1200,'outflow','Store Cadence','Store Cadence',0,'owner_stated','confirmed',?)`).run(id, `row-${id}`, day, NOW);
  }
};
test('C1 recurring: detected posted cadence survives mixed coverage without a subscription census', async () => {
  const question = 'Show my recurring charges this month.';
  const full = await ask(question, 'full', { setup: cadence });
  assert.ok(full.trace.facts > 0 && full.trace.rows.length === 3);
  assert.equal(full.body.ledger.monthly_total_minor, 5200);
  const mixed = await ask(question, 'mixed', { setup: cadence });
  assert.ok(mixed.trace.facts > 0 && mixed.trace.rows.length === 3);
  assert.equal(mixed.body.ledger.recurring[0].cadence, 'weekly');
  assert.equal(mixed.body.ledger.covered_monthly_estimate_minor, 5200);
  assert.equal(mixed.body.ledger.monthly_total_minor, null);
  assert.equal(mixed.body.evidence_gate.complete, false);
  assert.match(mixed.body.answer, /33 of 41 accounts/);
  assert.match(mixed.body.answer, /future obligations/i);
  const unknown = await ask(question, 'unknown', { setup: cadence });
  assert.equal(unknown.body.ledger, null);
  assert.equal(unknown.body.gaps[0].reason, 'period_outside_coverage');
});

const MONTHLY = 'Could you retrieve Store One charges by month since August?';
const merchantIntent = { vendor_text: 'Store One' };
test('C5 monthly: reads covered subsets, keeps zero certification and separate failure reasons', async () => {
  const full = await ask(MONTHLY, 'full', { intent: merchantIntent });
  assert.deepEqual(full.body.ledger.months.map(month => month.total_minor), [0, 0, 9000]);
  const mixed = await ask(MONTHLY, 'mixed', { intent: merchantIntent });
  assert.ok(mixed.trace.facts >= 3 && mixed.trace.rows.length > 0);
  assert.deepEqual(mixed.body.ledger.months.map(month => month.subtotal_minor), [0, 0, 9000]);
  assert.ok(mixed.body.ledger.months.every(month => month.total_minor === null && month.complete === false));
  assert.ok(mixed.body.ledger.months.every(month => month.coverage.covered_account_count === 33 && month.coverage.omitted_account_count === 8));
  assert.match(mixed.body.answer, /covered-account subtotal/i);
  assert.match(mixed.body.answer, /1040/);
  const unknown = await ask(MONTHLY, 'unknown', { intent: merchantIntent });
  assert.equal(unknown.trace.facts, 0);
  assert.ok(unknown.body.ledger.months.every(month => month.reason === 'period_outside_coverage' && month.total_minor === null && month.subtotal_minor === null));
  assert.equal(unknown.body.evidence_gate.supported, false, 'no certified month supplies a figure');
  const absent = await ask('Could you retrieve Absent Store charges by month since August?', 'mixed', {
    intent: { vendor_text: 'Absent Store' },
  });
  assert.ok(absent.trace.facts >= 3 && absent.trace.rows.length > 0);
  assert.ok(absent.body.ledger.months.every(month => month.reason === 'merchant_no_exact_match' && month.subtotal_minor === null));
  const possible = await ask(MONTHLY, 'mixed', { intent: merchantIntent,
    setup: db => db.exec("UPDATE fin_transactions SET payee=NULL,description='memo Store One' WHERE id=1") });
  assert.ok(possible.trace.facts >= 3 && possible.trace.rows.length > 0);
  assert.equal(possible.body.ledger.months.at(-1).reason, 'merchant_possible_matches');
  const failed = await ask(MONTHLY, 'mixed', { intent: merchantIntent, failRead: true });
  assert.ok(failed.trace.facts >= 3);
  assert.ok(failed.body.ledger.months.every(month => month.reason === 'ledger_unavailable'));
});

test('C1 controls: unknown is refused, certified empty is distinct, explicit covered account is full', async () => {
  const question = QUESTIONS[0];
  const unknown = await ask(question, 'unknown');
  assert.equal(unknown.trace.facts, 0, 'the period gate refused before facts, after inventory');
  assert.equal(unknown.body.ledger, null);
  assert.equal(unknown.body.gaps[0].reason, 'period_outside_coverage');
  const empty = await ask(question, 'empty');
  assert.ok(empty.trace.facts > 0, 'empty rows come from certified selected accounts');
  assert.equal(empty.body.ledger.kind, 'largest');
  assert.deepEqual(empty.body.ledger.lead_rows, []);
  assert.equal(empty.body.ledger.complete, false);
  const explicit = await ask('Show my three largest charges this month for account 1000.');
  assert.deepEqual(rankAmounts(explicit), [9000, 4000, 2000]);
  assert.equal(explicit.body.evidence_gate.complete, true);
  assert.doesNotMatch(explicit.body.answer, /omitted|partial view/i);
});

function addRow(db, id, slug, cents, direction, description, payee = null) {
  db.prepare(`INSERT INTO fin_transactions (id,txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at)
    VALUES (?,?,?,'2026-10-22',?,?,?,?,0,'owner_stated','confirmed',?)`).run(id, `row-${id}`, slug, cents, direction, description, payee, NOW);
}
const transferPool = db => {
  db.exec("UPDATE fin_transactions SET description='transfer to account 1001',payee=NULL WHERE id=1");
  addRow(db, 901, 'account-1', 9000, 'inflow', 'transfer from account 1000');
};
test('C1 pairing: an omitted competitor cannot manufacture a unique owned transfer', async () => {
  const unique = await ask(QUESTIONS[0], 'mixed', { setup: transferPool });
  assert.ok(unique.trace.rows.some(row => row.id === 901));
  assert.deepEqual(rankAmounts(unique), [4000, 2000]);
  assert.equal(unique.body.ledger.default_exclusions.own_transfer_minor, 9000);
  const setup = db => { transferPool(db); addRow(db, 902, 'account-40', 9000, 'inflow', 'transfer from account 1000'); };
  const covered = await ask(QUESTIONS[0], 'full', { setup });
  assert.deepEqual(rankAmounts(covered), [900000, 4000, 2000]);
  assert.equal(covered.body.ledger.default_exclusions.own_transfer_minor, 0, 'an unproved endpoint is not a matched transfer');
  assert.ok(covered.body.ledger.possible_payments.some(row => row.amount_minor === 9000), 'possible endpoint remains explicitly disclosed');
  const mixed = await ask(QUESTIONS[0], 'mixed', { setup });
  assert.ok(mixed.trace.rows.some(row => row.id === 902), 'the uncovered competitor was actually read');
  assert.deepEqual(rankAmounts(mixed), [4000, 2000]);
  assert.equal(mixed.body.ledger.default_exclusions.own_transfer_minor, 0, 'an unproved endpoint is not a matched transfer');
  assert.ok(mixed.body.ledger.possible_payments.some(row => row.amount_minor === 9000), 'possible endpoint remains explicitly disclosed');
  assert.equal(mixed.body.evidence_gate.complete, false);
});

test('C1 scope labels retain account identities even when ending digits are absent', async () => {
  const result = await ask(QUESTIONS[0], 'mixed', { setup: db => db.exec('UPDATE fin_accounts SET mask=NULL') });
  assert.deepEqual(rankAmounts(result), [9000, 4000, 2000]);
  assert.match(result.body.answer, /Account 1040 \(your account \(ending unavailable\)\)/);
  assert.equal(result.body.ledger.coverage.excluded_accounts.at(-1).account_label, 'Account 1040 (your account (ending unavailable))');
});

test('C1 controls: ordering, unrelated uncovered rows, missing counterpart and account-type gate', async () => {
  const baseline = await ask(QUESTIONS[0]);
  const reordered = await ask(QUESTIONS[0], 'mixed', { setup: db => {
    const rows = db.prepare('SELECT * FROM fin_transactions ORDER BY id DESC').all();
    db.exec('DELETE FROM fin_transactions');
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO fin_transactions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    }
  } });
  assert.deepEqual(reordered.body.ledger.lead_rows, baseline.body.ledger.lead_rows);
  const unrelated = await ask(QUESTIONS[0], 'mixed', { setup: db => db.exec('UPDATE fin_transactions SET amount_minor=999999 WHERE id=900') });
  assert.deepEqual(rankAmounts(unrelated), [9000, 4000, 2000]);
  const missing = await ask(QUESTIONS[0], 'mixed', { setup: db =>
    db.exec("UPDATE fin_transactions SET description='transfer to account 1040',payee=NULL WHERE id=1") });
  assert.ok(missing.trace.rows.some(row => row.id === 1));
  assert.deepEqual(rankAmounts(missing), [4000, 2000]);
  assert.equal(missing.body.ledger.default_exclusions.own_transfer_minor, 0, 'an unproved endpoint is not a matched transfer');
  assert.ok(missing.body.ledger.possible_payments.some(row => row.amount_minor === 9000), 'possible endpoint remains explicitly disclosed');
  assert.equal(missing.body.evidence_gate.complete, false, 'the missing counterpart cannot certify a complete expense answer');
  const review = await ask(QUESTIONS[0], 'mixed', { setup: db => {
    db.exec("UPDATE fin_accounts SET account_kind='other',balance_role='neither' WHERE account_slug='account-40'");
    db.exec("UPDATE fin_transactions SET description='payment to account 1040',payee=NULL WHERE id=1");
  } });
  assert.ok(review.trace.facts > 0 && review.trace.rows.some(row => row.id === 1));
  assert.equal(review.body.ledger ?? null, null);
  assert.equal(review.body.gaps[0].reason, 'ledger_account_kind_review_required');
});

function linkedTwin(db, approved) {
  db.exec("UPDATE fin_accounts SET feed_mode='live',mask='1000' WHERE account_slug='account-1'");
  addRow(db, 903, 'account-1', 9000, 'outflow', 'Store One', 'Store One');
  if (approved) {
    const accounts = ['account-0', 'account-1'].map(slug => db.prepare('SELECT * FROM fin_accounts WHERE account_slug=?').get(slug));
    db.prepare(`INSERT INTO fin_account_links (tenant_id,manual_account_slug,live_account_slug,identity_json,link_plan_hash,linked_at)
      VALUES ('primary','account-0','account-1',?,?,?)`).run(JSON.stringify(accounts.map(accountLinkIdentity)), '0'.repeat(64), NOW);
  }
}
test('C1 live/manual twins: unresolved overlap refuses and approved precedence remains intact', async () => {
  const disputed = await ask(QUESTIONS[0], 'mixed', { setup: db => linkedTwin(db, false) });
  assert.equal(disputed.trace.facts, 0);
  assert.equal(disputed.body.ledger ?? null, null);
  assert.equal(disputed.body.gaps[0].reason, 'ledger_account_link_required');
  const approved = await ask(QUESTIONS[0], 'mixed', { setup: db => linkedTwin(db, true) });
  assert.deepEqual(rankAmounts(approved), [9000]);
  assert.equal(approved.body.ledger.coverage.candidate_account_count, 40);
  assert.equal(approved.body.ledger.coverage.covered_account_count, 32);
  const unknownTwin = await ask(QUESTIONS[0], 'mixed', { setup: db => {
    linkedTwin(db, true);
    db.exec("UPDATE fin_account_coverage SET covered_from=NULL WHERE account_slug='account-1'");
  } });
  assert.equal(unknownTwin.body.ledger, null);
  assert.equal(unknownTwin.body.gaps[0].reason, 'ledger_unavailable');
});

// The period reader now injects nomination collection before the shared
// renderer. These restoring mutants still act immediately after that read.
const periodAnswerRead = [
  '  const result = await ledgerPeriodAnswer(env, intent, accounts, inventory, scope, evidence, (rows, accountMap) => {',
  '    candidates = rows; bySlug = accountMap;',
  '  });',
].join('\n');
const moduleSource = (source, base) => `data:text/javascript;base64,${Buffer.from(source.replace(/from (["'])(\.\/[^"']+)\1/g,
  (_, quote, path) => `from ${quote}${new URL(path, base).href}${quote}`)).toString('base64')}`;
test('C1 restoring mutant: whole-selection refusal is caught with an unchanged full-coverage peer', async () => {
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const site = periodAnswerRead;
  assert.equal(source.split(site).length - 1, 1);
  const { withLedgerAnswer: restored } = await import(moduleSource(source.replace(site,
    "  if (scope?.omitted.length && ['totals', 'largest', 'recurring'].includes(intent.kind)) return { reason: 'period_outside_coverage' };\n" + site), url));
  const green = await ask(QUESTIONS[0], 'full', { answer: restored });
  assert.deepEqual(rankAmounts(green), [900000, 9000, 4000]);
  const red = await ask(QUESTIONS[0], 'mixed', { answer: restored });
  assert.equal(red.body.gaps[0].reason, 'period_outside_coverage');
  assert.throws(() => rankAmounts(red), assert.AssertionError, 'the actual mixed-case oracle rejects the restoring mutant');
});

test('C1 largest per account: omitted accounts do not discard certified per-account lists', async () => {
  const question = 'Could you retrieve my three biggest charges per account this month?';
  const intent = { kind: 'largest', direction: 'outflow', count: 3, period: { type: 'this_month' } };
  const full = await ask(question, 'full', { intent });
  assert.equal(full.body.ledger.per_account.length, 41);
  const mixed = await ask(question, 'mixed', { intent });
  assert.ok(mixed.trace.facts > 0 && mixed.trace.rows.length > 0);
  assert.equal(mixed.body.ledger.kind, 'largest');
  assert.equal(mixed.body.ledger.per_account.length, 33);
  assert.equal(mixed.body.ledger.coverage.omitted_account_count, 8);
  assert.deepEqual(mixed.body.ledger.per_account.find(account => account.account_mask === '1000').lead_rows.map(row => row.amount_minor), [9000, 4000, 2000]);
});

test('C5 monthly controls: totals, expenses, certified empty and partial calendar dates', async () => {
  for (const kind of ['totals', 'expense_summary']) {
    const text = kind === 'totals' ? 'money in' : 'expenses';
    const intent = { kind, direction: kind === 'totals' ? 'inflow' : 'outflow' };
    const setup = db => { if (kind === 'totals') db.exec("UPDATE fin_transactions SET direction='inflow'"); };
    const question = `Could you retrieve ${text} by month since August?`;
    const full = await ask(question, 'full', { intent, setup });
    assert.deepEqual(full.body.ledger.months.map(month => month.total_minor), [0, 0, 915000]);
    const mixed = await ask(question, 'mixed', { intent, setup });
    assert.ok(mixed.trace.facts >= 3 && mixed.trace.rows.length > 0);
    assert.deepEqual(mixed.body.ledger.months.map(month => month.subtotal_minor), [0, 0, 15000]);
    assert.ok(mixed.body.ledger.months.every(month => month.total_minor === null));
    const empty = await ask(question, 'empty-full', { intent });
    assert.ok(empty.trace.facts >= 3);
    assert.deepEqual(empty.body.ledger.months.map(month => month.total_minor), [0, 0, 0]);
    assert.equal(empty.body.ledger.complete, true);
  }
  const scoped = await ask('Could you retrieve money in by month between 2026-08-05 and 2026-10-30?', 'mixed', {
    intent: { kind: 'totals', direction: 'inflow', period: { type: 'between', from: '2026-08-05', to: '2026-10-30' } },
    setup: db => db.exec("UPDATE fin_transactions SET direction='inflow'"),
  });
  assert.ok(scoped.trace.facts >= 3);
  assert.deepEqual(scoped.body.ledger.months.map(month => month.subtotal_minor), [0, 0, 15000]);
  assert.equal(scoped.body.ledger.months[0].from, '2026-08-05');
  assert.equal(scoped.body.ledger.months.at(-1).to, '2026-10-30');
});

test('C1 comparison: partial operands cannot certify a period difference', async () => {
  const question = 'Could you compare money in this month versus last month?';
  const intent = ['this_month', 'last_month'].map(type => ({ kind: 'totals', direction: 'inflow', period: { type } }));
  const setup = db => db.exec("UPDATE fin_transactions SET direction='inflow'");
  const full = await ask(question, 'full', { intent, setup });
  assert.equal(full.body.ledger.comparison.difference_minor, 915000);
  const mixed = await ask(question, 'mixed', { intent, setup });
  assert.ok(mixed.trace.facts >= 2 && mixed.trace.rows.length > 0);
  assert.equal(mixed.body.ledger.kind, 'multi');
  assert.equal(mixed.body.ledger.comparison, undefined);
  assert.ok(mixed.body.ledger.parts.every(part => part.combined_inflow_minor === null));
  assert.match(mixed.body.answer, /exact difference is unconfirmed/i);
});

test('C1 denominator: an explicitly covered account keeps its subtotal when an unknown account is selected too', async () => {
  const setup = db => db.exec("UPDATE fin_accounts SET account_kind=CASE WHEN account_slug IN ('account-0','account-40') THEN 'checking' ELSE 'savings' END");
  const explicit = await ask('How much money came in this month for account 1000?', 'mixed', {
    setup: db => { setup(db); db.exec("UPDATE fin_transactions SET direction='inflow'"); },
  });
  assert.equal(explicit.body.ledger.combined_inflow_minor, 15000);
  assert.equal(explicit.body.evidence_gate.complete, true);
  const selected = await ask('How much money came in this month for checking accounts?', 'mixed', {
    setup: db => { setup(db); db.exec("UPDATE fin_transactions SET direction='inflow'"); },
  });
  assert.ok(selected.trace.facts > 0 && selected.trace.rows.length > 0);
  assert.equal(selected.body.ledger.coverage.candidate_account_count, 2);
  assert.equal(selected.body.ledger.coverage.omitted_account_count, 1);
  assert.equal(selected.body.ledger.covered_inflow_subtotal_minor, 15000);
  assert.equal(selected.body.ledger.combined_inflow_minor, null);
  assert.equal(selected.body.evidence_gate.complete, false);
});

test('C1 measure control: a vendor-total ranking cannot use the single-charge reader', async () => {
  const control = await ask(QUESTIONS[0]);
  assert.deepEqual(rankAmounts(control), [9000, 4000, 2000]);
  for (const profile of ['full', 'mixed']) {
    const result = await ask('Which vendors had the largest total charges this month?', profile, {
      intent: { kind: 'largest', direction: 'outflow', count: 3, period: { type: 'this_month' } },
    });
    assert.equal(result.trace.models, 1, 'the supplied nonempty ranking plan reached local validation');
    assert.equal(result.body.ledger ?? null, null);
    assert.equal(result.body.gaps[0].reason, 'unsupported_question');
    assert.equal(result.trace.facts, 0, 'the requested aggregation unit is checked before reading transaction ranks');
  }
});

test('C1 restoring mutant: removing omitted competitors fails the same cents oracle', async () => {
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const site = 'const pairingRows = allRows;';
  assert.equal(source.split(site).length - 1, 1);
  const { withLedgerAnswer: restored } = await import(moduleSource(source.replace(site,
    'const pairingRows = allRows.filter(eligible);'), url));
  const setup = db => { transferPool(db); addRow(db, 902, 'account-40', 9000, 'inflow', 'transfer from account 1000'); };
  const green = await ask(QUESTIONS[0], 'full', { setup, answer: restored });
  assert.deepEqual(rankAmounts(green), [900000, 4000, 2000]);
  const red = await ask(QUESTIONS[0], 'mixed', { setup, answer: restored });
  assert.ok(red.trace.rows.some(row => row.id === 902));
  assert.deepEqual(rankAmounts(red), [4000, 2000]);
  assert.throws(() => assert.equal(red.body.ledger.candidate_transfer_count, 0), assert.AssertionError);
});

test('C5 restoring mutant: the monthly whole-selection pre-gate loses supported subtotals', async () => {
  const monthUrl = new URL('../src/lib/ledger-monthly.js', import.meta.url);
  const source = readFileSync(monthUrl, 'utf8');
  const site = 'scope.available ? await readMonth';
  assert.equal(source.split(site).length - 1, 1);
  const monthModule = moduleSource(source.replace(site, 'covered ? await readMonth'), monthUrl);
  const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const answerSource = readFileSync(answerUrl, 'utf8').replace('"./ledger-monthly.js"', JSON.stringify(monthModule));
  const { withLedgerAnswer: restored } = await import(moduleSource(answerSource, answerUrl));
  const green = await ask(MONTHLY, 'full', { intent: merchantIntent, answer: restored });
  assert.deepEqual(green.body.ledger.months.map(month => month.total_minor), [0, 0, 9000]);
  const red = await ask(MONTHLY, 'mixed', { intent: merchantIntent, answer: restored });
  assert.ok(red.body.ledger.months.every(month => month.coverage.covered_account_count === 33));
  assert.throws(() => assert.deepEqual(red.body.ledger.months.map(month => month.subtotal_minor), [0, 0, 9000]), assert.AssertionError);
});

test('C1 no-covered-account control includes dated partial feed history', async () => {
  const green = await ask(QUESTIONS[0], 'full');
  assert.deepEqual(rankAmounts(green), [900000, 9000, 4000]);
  const refused = await ask(QUESTIONS[0], 'full', { setup: db => db.exec("UPDATE fin_account_coverage SET coverage_status='partial'") });
  assert.equal(refused.trace.facts, 0);
  assert.equal(refused.body.ledger, null);
  assert.equal(refused.body.gaps[0].reason, 'period_outside_coverage');
});

test('C1 regression is registered in both exported offline command lists', () => {
  const file = 'worker/test/ledger-partial-coverage.test.mjs';
  for (const commands of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS]) {
    assert.ok(commands.length > 0, 'the actual runner graph was reached');
    assert.equal(commands.filter(command => parseTestCommand(command).args.includes(file)).length, 1);
  }
});

test('C1 partial and unavailable explanations retain the existing plain-language contract', async () => {
  const green = await ask(QUESTIONS[0], 'full');
  assert.doesNotMatch(green.body.answer, MONEY_JARGON);
  for (const [question, profile, options] of [
    [QUESTIONS[0], 'mixed', {}],
    ['Show my recurring charges this month.', 'mixed', { setup: cadence }],
    [MONTHLY, 'mixed', { intent: merchantIntent }],
    [MONTHLY, 'unknown', { intent: merchantIntent }],
  ]) {
    const result = await ask(question, profile, options);
    assert.doesNotMatch([result.body.answer, ...result.body.gaps.map(gap => gap.detail)].join('\n'), MONEY_JARGON);
  }
});


const PER_ACCOUNT = 'Could you retrieve my three biggest charges per account this month?';
const RANK_INTENT = { kind: 'largest', direction: 'outflow', count: 3, period: { type: 'this_month' } };
const COVERAGE_GAPS = [
  "covered_from=NULL", "covered_from='2026-10-23'", "covered_to='2026-10-21'",
  "coverage_status='indirect',covered_via_account_slug='account-0'", "basis_state='proposed'",
  ...['partial', 'missing', 'not_applicable', 'closed'].map(status => `coverage_status='${status}'`),
];
const competingPool = db => {
  transferPool(db);
  db.exec('UPDATE fin_transactions SET amount_minor=1 WHERE id=900');
  addRow(db, 902, 'account-40', 9000, 'inflow', 'transfer from account 1000');
};
function transferDecision(result, perAccount, expected, movementMinor, candidateCount = 0) {
  assert.ok(result.trace.rows.some(row => row.id === 901), 'the owned counterpart reached the fact reader');
  assert.equal(result.body.ledger.candidate_transfer_count, candidateCount);
  assert.deepEqual(rankAmounts(result), expected);
  assert.equal(result.body.ledger.default_exclusions.own_transfer_minor, candidateCount ? movementMinor : 0);
  if (!candidateCount) {
    const row = result.body.ledger.possible_payments.find(row => row.amount_minor === movementMinor);
    assert.ok(row, 'unproved endpoint nomination reached');
    assert.ok(result.body.citations.some(ref => ref.n === row.n && ref.amount_minor === movementMinor));
    assert.match(result.body.answer, /possible transfer.*not counted as spending/);
  }
  if (perAccount) {
    const part = result.body.ledger.per_account.find(part => part.account_mask === '1000');
    assert.ok(part, 'the actual per-account decision was composed');
    assert.deepEqual(part.lead_rows.map(row => row.amount_minor), expected.filter(cents => cents !== 1));
    assert.equal(part.default_exclusions.own_transfer_minor, candidateCount ? movementMinor : 0);
  }
}
test('R1-C1-01 transfer competition is independent of coverage state and display subset', async () => {
  for (const gap of COVERAGE_GAPS) for (const [question, perAccount, intent] of [
    [QUESTIONS[0], false, null], [PER_ACCOUNT, true, RANK_INTENT],
    ['Show my three largest charges this month for account 1000.', false, null],
  ]) {
    transferDecision(await ask(question, 'full', { setup: competingPool, intent }), perAccount, question.includes('account 1000') ? [4000, 2000] : [4000, 2000, 1], 9000);
    const setup = db => { competingPool(db); db.exec(`UPDATE fin_account_coverage SET ${gap} WHERE account_slug='account-40'`); };
    const mixed = await ask(question, 'mixed', { intent, setup });
    assert.ok(mixed.trace.rows.some(row => row.id === 902), 'the uncovered competitor reached the real reader');
    transferDecision(mixed, perAccount, [4000, 2000], 9000);
    const unique = await ask(question, 'mixed', { intent, setup: db => { setup(db); db.exec('DELETE FROM fin_transactions WHERE id=902'); } });
    transferDecision(unique, perAccount, [4000, 2000], 9000, 1);
  }
});

function netFixture(db, kind, role, gap, empty = false, contributorKind = 'checking') {
  db.exec("DELETE FROM fin_transactions; DELETE FROM fin_account_coverage WHERE account_slug NOT IN ('account-0','account-40'); DELETE FROM fin_accounts WHERE account_slug NOT IN ('account-0','account-40')");
  db.prepare("UPDATE fin_accounts SET account_kind=?,balance_role=? WHERE account_slug='account-0'").run(kind, role);
  db.exec(`UPDATE fin_account_coverage SET ${gap} WHERE account_slug='account-40'`);
  db.prepare("UPDATE fin_accounts SET account_kind=?,balance_role=? WHERE account_slug='account-40'").run(contributorKind, contributorKind === 'card' ? 'liability' : 'asset');
  addRow(db, 920, 'account-0', 5000, 'outflow', 'Store One', 'Store One');
  if (!empty) addRow(db, 921, 'account-40', 10000, 'inflow', 'Payer Unit', 'Payer Unit');
}
function netUnavailable(result) {
  assert.ok(result.trace.inventory > 0, 'inventory and the coverage/measure decision were reached');
  assert.equal(result.body.evidence_gate.supported, false);
  assert.equal(result.body.ledger.covered_net_minor, null);
  assert.equal(result.body.ledger.measure_scope.contributing_account_count, 0);
  assert.equal(result.body.ledger.measure_scope.requested_account_count, 2);
  assert.equal(result.body.ledger.coverage.candidate_account_count, 2);
  assert.equal(result.body.ledger.covered_net_minor, null);
  assert.equal(result.body.ledger.net_minor, null);
  assert.equal(result.body.evidence_gate.supported, false);
  assert.equal(result.body.evidence_gate.complete, false);
  assert.equal(result.trace.facts, 0, 'an unavailable measure must not read a numeric subtotal');
  assert.doesNotMatch(result.body.answer, /\$0\.00/);
  assert.match(result.body.answer, /checking, savings and card/);
  assert.deepEqual(result.body.ledger.measure_scope.excluded_accounts.map(account => account.reasons),
    [['account_kind_unsupported'], ['period_outside_coverage']]);
}
test('R1-C1-02 net measures recheck actual contributors after coverage selection', async () => {
  for (const measure of ['net income', 'profit']) for (const [kind, role] of [
    ['loan', 'liability'], ['line_of_credit', 'liability'], ['investment', 'asset'],
    ['retirement', 'asset'], ['escrow', 'asset'], ['merchant', 'asset'], ['point_of_sale', 'asset'], ['other', 'neither'],
  ]) for (const contributorKind of ['checking', 'savings', 'card']) for (const gap of COVERAGE_GAPS) {
    const question = `What was my ${measure} this month?`;
    assert.equal(classifyLedgerQuestion(question, { now: NOW, timeZone: 'America/Phoenix' }).measure, measure.replace(' ', '_'));
    const certified = await ask(question, 'full', { setup: db => netFixture(db, kind, role, "covered_from='2026-07-01'", false, contributorKind) });
    assert.ok(certified.trace.rows.some(row => row.id === 921), 'the eligible inflow was read');
    assert.equal(certified.body.ledger.net_minor, 10000);
    assert.equal(certified.body.evidence_gate.supported, true);
    netUnavailable(await ask(question, 'full', { setup: db => netFixture(db, kind, role, gap, false, contributorKind) }));
    const empty = await ask(question, 'full', { setup: db => netFixture(db, kind, role, "covered_from='2026-07-01'", true, contributorKind) });
    assert.ok(empty.trace.facts > 0, 'certified empty eligible activity was checked');
    assert.equal(empty.body.ledger.net_minor, 0);
    assert.equal(empty.body.evidence_gate.supported, true);
  }
});

const unitRows = db => {
  db.exec('DELETE FROM fin_transactions');
  for (const [id, cents, payee] of [[930, 6000, 'Store One'], [931, 6000, 'Store One'], [932, 10000, 'Store Two']])
    addRow(db, id, 'account-0', cents, 'outflow', payee, payee);
};
const UNIT_QUESTIONS = [
  ...['vendor', 'merchant', 'payee', 'store', 'supplier', 'category', 'account', 'unrecognized group'].flatMap(unit => [
    `Which ${unit} had the largest total charges this month?`,
    `Which ${unit}s had the largest total charges this month?`,
    `Could you rank total charges by ${unit} this month?`,
    ...(unit === 'account' ? [] : [`Could you retrieve the biggest charges for each ${unit} this month?`]),
  ]),
  'Could you retrieve the largest combined charges this month?',
  'Could you retrieve the largest charges grouped together this month?',
];
function refusedUnit(result) {
  assert.equal(result.trace.models, 1, 'a nonempty extracted ranking plan reached local unit admission');
  assert.ok(result.trace.inventory > 0, 'the actual inventory/unit decision was reached');
  assert.equal(result.body.ledger ?? null, null);
  assert.equal(result.body.gaps[0].reason, 'unsupported_question');
  assert.equal(result.trace.facts, 0, 'unsupported units refuse before transaction ranking');
}
test('R1-C1-03 only a proved individual transaction unit enters ranking', async () => {
  for (const question of UNIT_QUESTIONS) for (const profile of ['full', 'mixed']) {
    const intent = { ...RANK_INTENT, count: 1 };
    assert.deepEqual(rankAmounts(await ask('Could you retrieve my largest individual charge this month?', profile, { intent, setup: unitRows })), [10000]);
    if (/\b(?:stores?|suppliers?|categorys|unrecognized)\b/.test(question)) {
      const refused = await ask(question, profile, { intent, setup: unitRows, expectInventory: false });
      assert.equal(refused.body.gaps[0].reason, 'period_contradiction');
      assert.equal(refused.body.gaps[0].scope, 'calendar');
      assert.equal(refused.trace.facts, 0);
      assert.equal(refused.body.ledger ?? null, null);
    } else refusedUnit(await ask(question, profile, { intent, setup: unitRows }));
  }
  for (const literal of ['Largest Total Vendors', 'Merchant Ranking', 'Combined Charges']) for (const field of ['vendor_text', 'account_hint']) {
    const intent = { ...RANK_INTENT, count: 1, [field]: literal };
    const question = `Could you retrieve the largest charge ${field === 'vendor_text' ? 'at' : 'for'} ${literal} this month?`;
    const result = await ask(question, 'mixed', { intent, setup: db => {
      unitRows(db);
      if (field === 'vendor_text') db.prepare('UPDATE fin_transactions SET payee=?,description=? WHERE id=932').run(literal, literal);
      else db.prepare("UPDATE fin_accounts SET label=? WHERE account_slug='account-0'").run(literal);
    } });
    assert.deepEqual(rankAmounts(result), [10000]);
    assert.equal(result.body.ledger.kind, 'largest');
  }
});

function earlyMonthAmounts(result) {
  assert.ok(result.trace.facts >= 2 && result.trace.rows.length >= 2, 'both month readers reached posted evidence');
  assert.equal(result.body.ledger.expense_total_minor, 1000);
  assert.equal(result.body.ledger.previous_month.expense_total_minor, 2000);
  const [current, previous] = result.body.answer.split('Previous complete calendar month');
  assert.match(current, /November/);
  assert.match(current, /\$10\.00/);
  assert.match(previous, /October/);
  assert.match(previous, /\$20\.00/);
}
const earlyMonthPool = db => {
      db.exec("DELETE FROM fin_transactions; DELETE FROM fin_account_coverage WHERE account_slug NOT IN ('account-0','account-40'); DELETE FROM fin_accounts WHERE account_slug NOT IN ('account-0','account-40')");
      addRow(db, 940, 'account-0', 1000, 'outflow', 'Store One', 'Store One');
      db.exec("UPDATE fin_transactions SET posted_on='2026-11-01' WHERE id=940");
      addRow(db, 941, 'account-0', 2000, 'outflow', 'Store Two', 'Store Two');
};

test('R1-C1-04 early-month composition retains current and prior amounts for every coverage gap', async () => {
  for (const day of [1, 2, 3]) for (const gap of COVERAGE_GAPS) {
    const now = `2026-11-0${day}T19:00:00Z`;
    const setup = earlyMonthPool;
    earlyMonthAmounts(await ask('What are my expenses?', 'full', { now, setup }));
    const mixed = await ask('What are my expenses?', 'full', { now, setup: db => {
      setup(db); db.exec(`UPDATE fin_account_coverage SET ${gap} WHERE account_slug='account-40'`);
    } });
    earlyMonthAmounts(mixed);
    assert.match(mixed.body.answer, /1 of 2 accounts/);
    assert.match(mixed.body.answer, /1040/);
  }
});


async function answerMutant(site, replacement) {
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(site).length - 1, 1, 'one actual mutation site');
  assert.notEqual(site, replacement, 'the mutant must change product source');
  return (await import(moduleSource(source.replace(site, replacement), url))).withLedgerAnswer;
}
test('R1-C1-01 subset pairing cannot restore an identified owned movement as spending', async () => {
  const answer = await answerMutant('const pairingRows = allRows;',
    'const pairingRows = inflowPairing || omittedAccounts.length ? allRows : allRows.filter(eligible);');
  transferDecision(await ask(PER_ACCOUNT, 'full', { intent: RANK_INTENT, setup: competingPool, answer }), true, [4000, 2000, 1], 9000);
  const red = await ask(PER_ACCOUNT, 'mixed', { intent: RANK_INTENT, setup: competingPool, answer });
  assert.ok(red.trace.rows.some(row => row.id === 902));
  transferDecision(red, true, [4000, 2000], 9000);
});
test('R1-C1-02 mutant removing post-selection measure eligibility is killed', async () => {
  const answer = await answerMutant('if (intent.measure && !accounts.some(account => moveKind(account.account_kind))) {', 'if (false) {');
  const question = 'What was my net income this month?';
  const green = await ask(question, 'full', { answer, setup: db => netFixture(db, 'loan', 'liability', "covered_from='2026-07-01'") });
  assert.equal(green.body.ledger.net_minor, 10000);
  const red = await ask(question, 'full', { answer, setup: db => netFixture(db, 'loan', 'liability', 'covered_from=NULL') });
  assert.ok(red.trace.rows.some(row => row.id === 920), 'the mutant reached the selected loan/measure decision');
  assert.equal(red.body.ledger.covered_net_minor, 0, 'the mutant restores the unsupported numeric zero');
  assert.throws(() => netUnavailable(red), assert.AssertionError);
});
test('R1-C1-03 mutant restore pattern-based activation is killed', async () => {
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf('function transactionRankingUnit('), end = source.indexOf('const accountCoverage', start);
  assert.ok(start > 0 && end > start, 'the real unit contract was found');
  const restored = `function transactionRankingUnit(question, intent) {
    const words = normalizeLedgerText(question);
    return /\\b(?:rank|ranking|top|largest|biggest|highest)\\b.*\\b(?:vendors|merchants|payees)\\b|\\b(?:vendors|merchants|payees)\\b.*\\b(?:rank|ranking|top|largest|biggest|highest|most)\\b|\\b(?:by|per|each) (?:vendor|merchant|payee)\\b/.test(words) ? null : 'transaction';
  }\n`;
  const answer = (await import(moduleSource(source.slice(0, start) + restored + source.slice(end), url))).withLedgerAnswer;
  const intent = { ...RANK_INTENT, count: 1 };
  assert.deepEqual(rankAmounts(await ask('Could you retrieve my largest individual charge this month?', 'mixed', { intent, setup: unitRows, answer })), [10000]);
  const red = await ask('Which vendor had the largest total charges this month?', 'mixed', { intent, setup: unitRows, answer });
  assert.deepEqual(rankAmounts(red), [10000], 'the mutant restores the wrong unit over a real row population');
  assert.throws(() => refusedUnit(red), assert.AssertionError);
});
test('R1-C1-04 mutant dropping the current partial amount is killed', async () => {
  const answer = await answerMutant('(?:Spending I could check:|Payments to your own loan', '(?:Payments to your own loan');
  const question = 'What are my expenses?', now = '2026-11-02T19:00:00Z';
  earlyMonthAmounts(await ask(question, 'full', { setup: earlyMonthPool, now, answer }));
  const red = await ask(question, 'mixed', { setup: earlyMonthPool, now, answer });
  assert.ok(red.trace.rows.length >= 2 && red.trace.facts >= 2);
  assert.throws(() => earlyMonthAmounts(red), assert.AssertionError);
});
test('R1-C1-03 operator words cannot masquerade as literal selectors', async () => {
  for (const literal of ['vendor', 'merchant', 'payee']) for (const field of ['vendor_text', 'account_hint']) {
    const intent = { ...RANK_INTENT, count: 1, [field]: literal };
    const setup = db => {
      unitRows(db);
      if (field === 'vendor_text') db.prepare('UPDATE fin_transactions SET payee=?,description=? WHERE id=932').run(literal, literal);
      else db.prepare("UPDATE fin_accounts SET label=? WHERE account_slug='account-0'").run(literal);
    };
    const green = await ask(`Could you retrieve the largest charge at ${literal} this month?`, 'mixed', { intent, setup });
    assert.deepEqual(rankAmounts(green), [10000]);
    refusedUnit(await ask(`Which ${literal} had the largest charges this month?`, 'mixed', { intent, setup }));
  }
});


// The ranked subject and the transaction metric differ even with identical
// vocabulary. Two smaller charges make the account ordering reverse the row
// ordering, so these probes cannot pass on a same-order population.
const splitAccountRows = db => {
  unitRows(db);
  db.exec("UPDATE fin_transactions SET account_slug='account-1' WHERE id=932");
};
const ACCOUNT_RANKINGS = [...new Set([
  'Rank my accounts by money paid for charges this month.',
  ...['account', 'accounts', 'checking accounts', 'bank accounts', 'vendor', 'vendors', 'payee', 'payees', 'category', 'categories'].flatMap(subject => [
    `Rank my ${subject} by money paid for charges this month.`,
    `Which ${subject} had the largest charges this month?`,
    `Show my ${subject} by largest individual charges this month.`,
  ]),
])];
const splitRankIntent = { ...RANK_INTENT, count: null };
const SINGLE_CHARGES = 'Could you retrieve my largest individual charges this month?';
function splitChargeOrder(result) {
  assert.deepEqual(rankAmounts(result), [10000, 6000, 6000]);
  assert.deepEqual(result.body.ledger.lead_rows.map(row => row.account_mask), ['1001', '1000', '1000']);
  assert.equal(result.trace.fallback, 0);
}
test('R2 ranked entities refuse account aggregates before facts with individual-charge peers', async () => {
  for (const profile of ['full', 'mixed']) for (const question of ACCOUNT_RANKINGS) {
    splitChargeOrder(await ask(SINGLE_CHARGES, profile, { intent: splitRankIntent, setup: splitAccountRows }));
    const earlyScopeRefusal = /checking accounts/.test(question);
    const refused = await ask(question, profile, { intent: splitRankIntent, setup: splitAccountRows, expectInventory: !earlyScopeRefusal });
    if (earlyScopeRefusal) {
      assert.equal(refused.trace.models, 1, 'typed-account scope reached local extraction validation');
      assert.equal(refused.trace.facts, 0);
      assert.equal(refused.body.ledger ?? null, null);
      assert.equal(refused.body.gaps[0].reason, 'ledger_wording_unsupported');
    } else refusedUnit(refused);
  }
});
test('R2 individual-charge grouping and literal account selectors keep their roles', async () => {
  for (const profile of ['full', 'mixed']) {
    const grouped = await ask(PER_ACCOUNT, profile, { intent: splitRankIntent, setup: splitAccountRows });
    splitChargeOrder(grouped);
    assert.deepEqual(grouped.body.ledger.per_account.find(part => part.account_mask === '1000').lead_rows.map(row => row.amount_minor), [6000, 6000]);
    assert.deepEqual(grouped.body.ledger.per_account.find(part => part.account_mask === '1001').lead_rows.map(row => row.amount_minor), [10000]);
    const selected = await ask('Could you retrieve my largest individual charges for Account 1000 this month?', profile,
      { intent: { ...splitRankIntent, account_hint: 'Account 1000' }, setup: splitAccountRows });
    assert.deepEqual(rankAmounts(selected), [6000, 6000]);
    assert.notEqual(selected.body.ledger.complete, false, 'the selected-account ledger is fully covered');
  }
});

const MODIFIER_BASE = 'What were my 2 largest expenses in September 2026';
const modifierRows = db => {
  db.exec('DELETE FROM fin_transactions');
  db.exec("UPDATE fin_accounts SET account_kind='savings' WHERE account_slug='account-1'");
  for (const [id, slug, cents, direction, description] of [
    [950, 'account-0', 2807, 'outflow', 'Fixture Store'],
    [951, 'account-0', 1903, 'outflow', 'Fixture Supplies'],
    [952, 'account-0', 23617, 'outflow', 'TRANSFER TO account 1001'],
    [953, 'account-1', 23617, 'inflow', 'TRANSFER FROM account 1000'],
  ]) addRow(db, id, slug, cents, direction, description);
  db.exec("UPDATE fin_transactions SET posted_on='2026-09-15'");
};
const MODIFIERS = [
  ...['excluding', 'without', 'not counting', 'including'].flatMap(operation =>
    ['', 'my ', 'our ', 'own ', 'my own ', 'our own '].flatMap(owner =>
      ['', ' between my accounts', ' between our own accounts'].map(group => ({
        text: `${operation} ${owner}transfers${group}`, ownTransfers: operation === 'including' ? 'include' : 'exclude',
      })))),
  { text: 'including withdrawals', withdrawals: 'include' },
  { text: 'including retirement withdrawals', withdrawals: 'include' },
  { text: 'including investment withdrawals', withdrawals: 'include' },
  { text: 'including loan proceeds', loanProceeds: 'include' },
  { text: 'including transfers including withdrawals including loan proceeds', ownTransfers: 'include', withdrawals: 'include', loanProceeds: 'include' },
];
function modifierRanks(result, include = false) {
  assert.equal(result.trace.fallback, 0, 'parsed ranking never falls through');
  assert.ok([952, 953].every(id => result.trace.rows.some(row => row.id === id)), 'actual transfer endpoints reached pairing');
  assert.equal(result.body.ledger.transfers.length, 1);
  assert.deepEqual(rankAmounts(result), include ? [23617, 2807] : [2807, 1903]);
  assert.equal(result.body.ledger.default_exclusions.own_transfer_minor, include ? 0 : 23617);
}
test('R2 parsed ranking modifiers preserve full and mixed plain/exclude/include views', async () => {
  for (const profile of ['full', 'mixed']) for (const modifier of MODIFIERS) {
    const options = { setup: modifierRows, now: '2026-10-11T12:00:00Z' };
    modifierRanks(await ask(`${MODIFIER_BASE}?`, profile, options));
    const question = `${MODIFIER_BASE} ${modifier.text}?`;
    const parsed = classifyLedgerQuestion(question, { now: options.now, timeZone: 'America/Phoenix' });
    assert.equal(parsed.kind, 'largest', 'bounded modifier grammar reached');
    for (const key of ['ownTransfers', 'withdrawals', 'loanProceeds']) assert.equal(parsed[key], modifier[key]);
    const result = await ask(question, profile, options);
    modifierRanks(result, modifier.ownTransfers === 'include');
    assert.equal(result.body.evidence_gate.complete, profile === 'full' && modifier.ownTransfers !== 'include');
    if (profile === 'mixed') assert.equal(result.body.ledger.coverage.covered_account_count, 33);
  }
});
const INVALID_MODIFIERS = [
  'including transfers excluding transfers', 'excluding transfers without transfers',
  'including transfers including transfers', 'not counting transfers not counting my own transfers',
  'including withdrawals including retirement withdrawals', 'including loan proceeds including loan proceeds',
  'including transfers and refunds', 'excluding refunds', 'including unicorn transfers',
];
test('R2 duplicate conflicting and unknown modifiers refuse with a reached green peer', async () => {
  for (const profile of ['full', 'mixed']) for (const modifier of INVALID_MODIFIERS) {
    const options = { setup: modifierRows, now: '2026-10-11T12:00:00Z' };
    modifierRanks(await ask(`${MODIFIER_BASE} including transfers?`, profile, options), true);
    const question = `${MODIFIER_BASE} ${modifier}?`;
    const parsed = classifyLedgerQuestion(question, { now: options.now, timeZone: 'America/Phoenix' });
    assert.equal(parsed.broad, true, 'invalid modifier reached the money grammar');
    assert.equal(parsed.kind, null);
    const result = await ask(question, profile, { ...options, intent: { ...splitRankIntent, count: 2, period: { type: 'none' } }, expectInventory: false });
    assert.equal(result.trace.models, 1, 'the attempted ranking extraction reached the local validator');
    assert.equal(result.trace.facts, 0);
    assert.equal(result.body.ledger ?? null, null);
  }
});


const boundaryRows = db => {
  db.exec('DELETE FROM fin_transactions');
  addRow(db, 960, 'account-0', 27653, 'outflow', 'TRANSFER TO account 1001');
  addRow(db, 961, 'account-1', 27653, 'inflow', 'TRANSFER FROM account 1000');
  db.exec("UPDATE fin_transactions SET posted_on=CASE id WHEN 960 THEN '2026-09-30' ELSE '2026-10-02' END");
};
const ENDPOINT_GAPS = [
  "UPDATE fin_account_coverage SET covered_to='2026-09-30' WHERE account_slug='account-1'",
  "UPDATE fin_account_coverage SET coverage_status='partial' WHERE account_slug='account-1'",
  "UPDATE fin_account_coverage SET covered_from=NULL WHERE account_slug='account-1'",
  "UPDATE fin_transactions SET basis_state='proposed' WHERE id=961",
];
function boundaryUnmatched(result) {
  assert.ok([960, 961].every(id => result.trace.rows.some(row => row.id === id)), 'both padded endpoints reached the eligibility decision');
  assert.equal(result.body.ledger.reason, 'money_out_destination_unconfirmed');
  assert.equal(result.body.ledger.complete, false);
  assert.equal(result.body.ledger.expense_total_minor, null);
  assert.ok(result.body.ledger.possible_payments.length > 0, 'rejected counterpart has a disclosure');
  const row = result.body.ledger.possible_payments.find(row => row.amount_minor === 27653);
  assert.ok(row); assert.ok(row.connected_counterpart_masks.length > 0);
  assert.ok(result.body.citations.some(ref => ref.n === row.n && ref.amount_minor === 27653));
  assert.match(result.body.answer, /money out.*withheld|withheld.*money out/i);
  assert.ok(!(result.body.ledger.lead_accounts || []).some(account => Number.isSafeInteger(account.credits_minor) || Number.isSafeInteger(account.debits_minor)), 'withholding admits no account-level money figure');
}
test('R2 rejected pair endpoints remain visible as unproved transfer candidates', async () => {
  for (const profile of ['full', 'mixed']) for (const gap of ENDPOINT_GAPS) {
    const question = 'How much money came in and went out in September 2026?';
    const green = await ask(question, profile, { setup: boundaryRows });
    assert.ok(green.trace.rows.some(row => row.id === 961));
    assert.equal(green.body.ledger.default_exclusions.own_transfer_minor, 27653);
    assert.equal(green.body.ledger.transfers.length, 1);
    boundaryUnmatched(await ask(question, profile, { setup: db => { boundaryRows(db); db.exec(gap); } }));
  }
});


test('R2 mutant restoring unordered ranking words reproduces and loses the account order', async () => {
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf('function transactionRankingUnit('), end = source.indexOf('const accountCoverage', start);
  assert.ok(start > 0 && end > start);
  const restored = `function transactionRankingUnit(question) {
    const tokens = normalizeLedgerText(normalizeLedgerIntentWords(question)).split(/\\s+/);
    const units = new Set(['charge', 'charges', 'expense', 'expenses', 'deposit', 'deposits', 'transaction', 'transactions', 'payment', 'payments', 'purchase', 'purchases']);
    const grammar = new Set('could can would will you please retrieve pull fetch list show me tell find get give what which was were is are did i we us see up my our the a an of had has have largest biggest highest top rank ranking most expensive priciest one two three four five six seven eight nine ten individual single recorded completed posted outgoing incoming paid cost took money stock expense prior across made in from to at for during over between since on within by per each all account accounts bank checking savings card loan investment retirement escrow ending mask selector this last previous current month months year years quarter quarters week weeks day days today yesterday now january february march april may june july august september october november december q1 q2 q3 q4 so far it opened'.split(' '));
    return tokens.some(token => ['largest', 'biggest', 'highest', 'top', 'rank', 'ranking', 'most', 'priciest'].includes(token)) && tokens.some(token => units.has(token)) && tokens.every(token => units.has(token) || grammar.has(token) || /^[0-9]+$/.test(token)) ? 'transaction' : null;
  }\n`;
  const answer = (await import(moduleSource(source.slice(0, start) + restored + source.slice(end), url))).withLedgerAnswer;
  for (const profile of ['full', 'mixed']) {
    splitChargeOrder(await ask(SINGLE_CHARGES, profile, { intent: splitRankIntent, setup: splitAccountRows, answer }));
    const red = await ask(ACCOUNT_RANKINGS[0], profile, { intent: splitRankIntent, setup: splitAccountRows, answer });
    splitChargeOrder(red);
    const byAccount = new Map();
    for (const row of red.body.ledger.lead_rows) byAccount.set(row.account_mask, (byAccount.get(row.account_mask) || 0) + row.amount_minor);
    assert.deepEqual([...byAccount].sort((a, b) => b[1] - a[1]), [['1000', 12000], ['1001', 10000]], 'actual aggregates reverse the returned leading account');
    assert.throws(() => refusedUnit(red), assert.AssertionError);
  }
});
test('R2 mutant restoring raw-question admission loses supported parsed modifiers', async () => {
  const answer = await answerMutant('const parsed = classifyLedgerQuestion(question, { now, timeZone });',
    "const parsed = classifyLedgerQuestion(question, { now, timeZone }); if (parsed.kind === 'largest') delete parsed.rankingQuestion;");
  for (const profile of ['full', 'mixed']) {
    const options = { answer, setup: modifierRows, now: '2026-10-11T12:00:00Z' };
    modifierRanks(await ask(`${MODIFIER_BASE}?`, profile, options));
    const red = await ask(`${MODIFIER_BASE} excluding transfers?`, profile, options);
    assert.ok(red.trace.inventory > 0, 'the mutant reached actual operation admission');
    assert.equal(red.trace.facts, 0);
    assert.equal(red.body.gaps[0].reason, 'unsupported_question');
    assert.throws(() => modifierRanks(red), assert.AssertionError);
  }
});
test('R2 mutant certifying an unproved counterpart is killed with a valid-pair peer', async () => {
  const answer = await answerMutant('moneyOutReading?.unconfirmed.length && !mixedLoanPayments.length',
    'false && moneyOutReading?.unconfirmed.length && !mixedLoanPayments.length');
  const question = 'How much money came in and went out in September 2026?';
  const green = await ask(question, 'full', { answer, setup: boundaryRows });
  assert.equal(green.body.ledger.default_exclusions.own_transfer_minor, 27653);
  assert.ok(green.trace.rows.some(row => row.id === 961));
  const red = await ask(question, 'full', { answer, setup: db => { boundaryRows(db); db.exec(ENDPOINT_GAPS[0]); } });
  assert.ok(red.trace.rows.some(row => row.id === 961));
  assert.equal(red.body.ledger.default_exclusions.own_transfer_minor, 0);
  assert.ok(red.body.ledger.lead_accounts.some(account => account.debits_minor === 27653), 'the bad monetary decision was reached');
  assert.throws(() => boundaryUnmatched(red), assert.AssertionError);
});


const INDIVIDUAL_RANK_FORMS = [
  'Could you rank our expenses this month?',
  'Rank individual charges this month.',
  'Ranking my individual charges this month.',
  'Can you rank my individual charges this month?',
  'Please rank my single charges this month.',
  'Could you please rank my charges this month?',
  'Could you retrieve the most expensive individual charges this month?',
  'What are my priciest charges this month?',
  'Could you list our five biggest expenses last month?',
  'Which five purchases cost us the most last month?',
  'Give us the top five expenses from the previous month.',
  'What were our five largest outgoing charges last month?',
  'Show the five most expensive bank charges last month.',
  'Pull up our five biggest purchases from last month.',
  'Rank the five highest expenses for the prior month.',
  'Can I see the five largest charges we paid last month?',
  'Which five expenses took the most money last month?',
  'Tell me our five highest expense transactions last month.',
];
test('R2 transaction subject grammar preserves supported request and amount roles', async () => {
  for (const profile of ['full', 'mixed']) for (const question of INDIVIDUAL_RANK_FORMS) {
    const setup = db => { splitAccountRows(db); db.exec("UPDATE fin_transactions SET posted_on='2026-09-22'"); };
    const intent = { ...splitRankIntent, count: 5, period: { type: 'last_month' } };
    const dated = question.replace('this month', 'last month');
    splitChargeOrder(await ask(dated, profile, { intent, setup }));
    refusedUnit(await ask('Rank my accounts by money paid for charges last month.', profile, { intent, setup }));
  }
});

const POLICY_CASES = [
  { name: 'inflow', question: 'How much money came in this month?', inflow: true },
  { name: 'outflow', question: 'How much money went out this month?' },
  { name: 'largest expense', question: 'What were my largest expenses this month?' },
  { name: 'ranking', question: QUESTIONS[0] },
  { name: 'monthly subtotals', question: 'Could you retrieve money in by month since August?', inflow: true,
    intent: { kind: 'totals', direction: 'inflow' } },
  { name: 'comparison', question: 'Could you compare money in this month versus last month?', inflow: true,
    intent: ['this_month', 'last_month'].map(type => ({ kind: 'totals', direction: 'inflow', period: { type } })) },
];

function policyOracle(body, state, name) {
  if (state === 'unknown') {
    assert.notEqual(body.evidence_gate?.supported, true);
    const explanation = [body.answer, ...(body.gaps || []).map(gap => gap.detail)].filter(Boolean).join('\n');
    assert.doesNotMatch(explanation, /\$[\d,]+/);
    assert.match(explanation, /1000/);
    assert.match(explanation, /1040/);
    assert.match(explanation, /missing|cover|history/i);
    assert.match(explanation, /refresh|statement|connect|import/i);
    return;
  }
  assert.equal(body.evidence_gate?.supported, true);
  assert.equal(body.evidence_gate.complete, false);
  assert.notEqual(body.ledger.complete, true);
  assert.match(body.answer, /partial/i);
  assert.match(body.answer, /1000/);
  assert.match(body.answer, /1040/);
  if (state === 'empty') {
    assert.deepEqual(body.citations, []);
    if (['ranking', 'largest expense'].includes(name)) assert.deepEqual(body.ledger.lead_rows, []);
    else assert.match(body.answer, /\$0\.00/);
  }
  if (name === 'monthly subtotals') {
    assert.ok(body.ledger.months.every(month => month.complete === false));
    assert.deepEqual(body.ledger.months.map(month => month.subtotal_minor), state === 'empty' ? [0, 0, 0] : [0, 0, 15000]);
  }
  if (name === 'comparison') {
    assert.equal(body.ledger.comparison, undefined);
    assert.ok(body.ledger.parts.every(part => part.complete === false));
  }
}

for (const row of POLICY_CASES) for (const state of ['unknown', 'empty', 'mixed']) {
  test(`coverage policy: ${row.name}: ${state}`, async () => {
    const { body, trace } = await ask(row.question, state, { intent: row.intent,
      setup: db => { if (row.inflow) db.exec("UPDATE fin_transactions SET direction='inflow'"); } });
    if (state === 'unknown') assert.equal(trace.facts, 0);
    else assert.ok(trace.facts > 0);
    policyOracle(body, state, row.name);
  });
}

test('coverage policy: covered partial calendar dates authorize an honest zero', async () => {
  const { body } = await ask('Could you retrieve money in by month between 2026-08-05 and 2026-10-30?', 'empty', {
    intent: { kind: 'totals', direction: 'inflow', period: { type: 'between', from: '2026-08-05', to: '2026-10-30' } },
  });
  assert.deepEqual(body.ledger.months.map(month => month.subtotal_minor), [0, 0, 0]);
  assert.ok(body.ledger.months.every(month => month.available && !month.complete));
});

for (const missingSide of ['this_month', 'last_month']) test(`coverage policy: comparison refuses only ${missingSide}`, async () => {
  const row = POLICY_CASES.find(row => row.name === 'comparison');
  const { body } = await ask(row.question, 'mixed', { intent: row.intent, setup: db => {
    db.exec("UPDATE fin_transactions SET direction='inflow'");
    db.exec(missingSide === 'this_month'
      ? "UPDATE fin_account_coverage SET covered_to='2026-09-30' WHERE covered_from IS NOT NULL"
      : "UPDATE fin_account_coverage SET covered_from='2026-10-01' WHERE covered_from IS NOT NULL");
  } });
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.comparison, undefined);
  const index = missingSide === 'this_month' ? 0 : 1;
  assert.equal(body.ledger.parts[index].complete, false);
  assert.equal(body.ledger.parts[index].reason, 'period_outside_coverage');
  assert.equal(body.ledger.parts[index].operand_coverage.complete, false);
  assert.equal(body.ledger.parts[1 - index].complete, false);
  assert.match(body.answer, /1000/);
  assert.match(body.answer, /1040/);
  assert.match(body.answer, /import statements/);
});

const COVERAGE_MUTANTS = [
  { name: 'empty covered subset returns $0', state: 'unknown',
    site: 'accounts = scope.covered;\n    if (!scope.available)',
    replacement: 'accounts = scope.available ? scope.covered : scope.requested;\n    if (false)',
    setup: db => { db.exec('DELETE FROM fin_transactions'); db.exec('UPDATE fin_account_coverage SET covered_from=NULL'); } },
  { name: 'covered-but-zero refuses', state: 'empty',
    site: periodAnswerRead,
    replacement: periodAnswerRead + " if (result.ledger && !result.citations.length) return { reason: 'period_outside_coverage' };" },
  { name: 'partial marked complete', state: 'mixed',
    site: 'if (scope) labelPartialPeriodAnswer(result, scope, intent);',
    replacement: 'if (scope) labelPartialPeriodAnswer(result, scope, intent); if (result.ledger) result.ledger.complete = true;' },
];
for (const mutant of COVERAGE_MUTANTS) test(`coverage mutant killed: ${mutant.name}`, async () => {
  const answer = await answerMutant(mutant.site, mutant.replacement);
  const options = { answer, setup: mutant.setup };
  // The empty-subset mutant must actually publish zero, not fail elsewhere.
  const { body } = await ask('How much money came in this month?', mutant.state === 'unknown' ? 'empty' : mutant.state, options);
  if (mutant.state === 'unknown') {
    assert.equal(body.evidence_gate.supported, true);
    assert.equal(body.ledger.covered_inflow_subtotal_minor, 0);
  }
  assert.throws(() => policyOracle(body, mutant.state, 'inflow'), assert.AssertionError, mutant.name);
});
