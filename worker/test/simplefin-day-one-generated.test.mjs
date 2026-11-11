import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
const { withLedgerAnswer } = await import(process.env.SIMPLEFIN_DAY_ONE_ANSWER_MODULE || '../src/lib/ledger-answer.js');
import { total, formatMinor, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';

// Deterministic finder and regression gate. The business-role wording group
// remains diagnostic because that separate integration lane owns its grammar.
const NOW = '2026-11-06T12:00:00.000Z';
const SEEDS = [1106, 427, 20261106];
function random(seed) { let n = seed >>> 0; return max => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n % max; }; }
function generate() {
  const books = [];
  for (const seed of SEEDS) {
    const next = random(seed);
    for (let index = 0; index < 36; index++) {
      const days = index === 0 ? 0 : index === 1 ? 90 : next(91);
      const complete = index % 3 !== 0;
      const unknown = index % 4 === 0;
      const error = index % 5 === 0;
      const accounts = [
        { id: 'business', label: 'Business account', entity: 'business', kind: unknown ? 'other' : 'checking', mask: '1101' },
        { id: 'personal', label: 'Personal account', entity: 'personal', kind: 'checking', mask: '2202' },
        { id: 'card', label: 'Card account', entity: 'business', kind: 'card', mask: '3303' },
        { id: 'loan', label: 'Loan account', entity: 'business', kind: 'loan', mask: '4404' },
      ].map((a, i) => ({ ...a, balance: String(10001 + next(900000)), missing: index % 7 === 0 && i === 1,
        error: error && i === 1 }));
      const rows = [];
      for (const a of accounts) for (let j = 0; j < (days ? 5 : 0); j++) rows.push({
        id: `${a.id}-${j}`, account: a.id, cents: String(101 + next(100000)),
        direction: j === 0 ? 'inflow' : 'outflow', pending: j === 4,
        day: new Date(Date.parse('2026-11-06T00:00:00Z') - next(days) * 86400000).toISOString().slice(0, 10),
      });
      books.push({ seed, index, days, complete, unknown, accounts, rows });
    }
  }
  return books;
}
let modelCalls = 0;
let sharedFixture;
let closeFixture;
test.after(() => closeFixture?.());
async function fixture(book) {
  if (!sharedFixture) {
    // Reuse the migrated schema across shrink probes, leaving transaction
    // ownership with the real D1 batch adapter used by ledger reads.
    sharedFixture = await createProductFixture({ env: { BANK_FEED_PROVIDER: 'simplefin', BRAIN_TIMEZONE: 'UTC',
    AI: { async run() { modelCalls++; throw Error('generated ledger answers must not call a model'); } } } });
    closeFixture = sharedFixture.close;
    sharedFixture.close = () => {
      for (const table of ['fin_transactions', 'fin_balance_snapshots', 'fin_account_coverage',
        'simplefin_sync_windows', 'simplefin_account_assignments', 'fin_accounts', 'fin_entities',
        'bank_feed_backfill', 'simplefin_connections', 'bank_feed_items']) sharedFixture.raw(`DELETE FROM ${table}`);
    };
  }
  const f = sharedFixture;
  f.seen.sql.length = 0; f.seen.binds.length = 0;
  seedOwnedEntity(f, 'business', 'Business unit');
  seedOwnedEntity(f, 'personal', 'Personal unit');
  f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='personal'");
  for (const a of book.accounts) {
    const item = `feed-${a.id}`;
    f.raw(`INSERT INTO bank_feed_items (item_ref,institution_label,access_ciphertext,access_iv,environment,connected_at,last_synced_at,status,status_detail)
      VALUES (?,'Institution unit',?,?,'sandbox',?,?,?,?)`, item, 'A'.repeat(24), 'B'.repeat(12), NOW, NOW, a.error ? 'error' : 'connected', a.error ? 'institution unavailable' : null);
    const start = new Date(Date.parse('2026-11-06T00:00:00Z') - Math.max(0, book.days - 1) * 86400000).toISOString().slice(0, 10);
    f.raw(`INSERT INTO simplefin_connections (item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,last_errlist_json,last_pull_partial,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`, item, start, book.complete ? '2026-11-07' : start, '2026-11-06', NOW,
      a.error ? '[{"code":"institution_error"}]' : '[]', Number(a.error), NOW);
    f.raw(`INSERT INTO bank_feed_backfill (item_ref,requested_days,state,queued_at,finished_at)
      VALUES (?,?,?,?,?)`, item, Math.max(1, book.days), book.complete ? 'complete' : 'running', NOW, book.complete ? NOW : null);
    const ref = 'sfa_' + String(['business','personal','card','loan'].indexOf(a.id) + 1).padStart(32, '0');
    f.raw(`INSERT INTO simplefin_account_assignments (item_ref,provider_account_id,account_ref,account_label,institution_label,currency,entity_slug,first_seen_at,last_seen_at,assigned_at) VALUES (?,?,?,?,'Institution unit','USD',?,?,?,?)`, item, a.id, ref, a.label, a.entity, NOW, NOW, NOW);
    f.raw(`INSERT INTO simplefin_sync_windows (item_ref,window_start,window_end,state,errlist_json,fetched_at,promoted_at,revision,staging_revision) VALUES (?,?,?,'promoted','[]',?,?,'posted-history-2:fixture','posted-history-2:fixture')`, item, start, '2026-11-07', NOW, NOW);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,label,institution,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,'Institution unit',?,?,?,'live','feed',?,'confirmed',?)`, a.id, a.entity, a.label, a.kind,
      ['card','loan'].includes(a.kind) ? 'liability' : a.kind === 'other' ? 'neither' : 'asset', a.mask, `bank-feed:${item}`, NOW);
    // Vary bounded bank coverage separately from the backfill cursor. The
    // finished cohort supplies useful positive controls; fresh partial links
    // must never acquire that cohort's completeness.
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,'feed',?,'confirmed',?)`, a.id, book.complete && book.days >= 6 && !a.error ? 'complete' : 'partial',
      start, '2026-11-06', NOW, `bank-feed:${item}`, NOW);
    f.raw('UPDATE fin_accounts SET external_ref=? WHERE account_slug=?', ref, a.id);
    if (!a.missing) f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'2026-11-06',?,'feed',?,'confirmed',?)`, a.id, Number(a.balance), `bank-feed:${item}`, NOW);
  }
  for (const r of book.rows) f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,pending,payee,description,provenance,source_feed,source_provider,basis_state,recorded_at)
    VALUES (?,?,?,?,?,?,'Outside vendor','Outside purchase','feed',?,'simplefin','confirmed',?)`, r.id, r.account, r.day, Number(r.cents), r.direction, Number(r.pending), `bank-feed:feed-${r.account}`, NOW);
  return f;
}
const questions = book => [
  ['balance', 'What is my current balance?'],
  ['in', 'How much money came in this month?'],
  ['spend', 'How much did I spend this month?'],
  ['largest', 'What were my largest expenses this month?'],
  ['payment', `Did a payment of ${formatMinor(book.rows.find(r => r.direction === 'inflow')?.cents || '12345')} arrive this month?`],
  ['business', 'How much did my business spend this month?'],
];
async function ask(f, question) {
  return (await withLedgerAnswer({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner' },
    async gap => Response.json({ answer: null, gaps: gap ? [gap] : [] }))).json();
}
function violations(book, kind, body) {
  const failures = [];
  const check = (ok, group, expected, actual) => { if (!ok) failures.push({ group, expected, actual }); };
  const ledger = body.ledger;
  const displayed = displayFigures(body.answer).map(f => f.cents);
  const text = [body.answer, ...(body.gaps || []).map(g => g.detail)].join('\n');
  const accounts = book.accounts.filter(a => kind !== 'business' || a.entity === 'business');
  for (const a of accounts.filter(a => a.error)) {
    const row = ledger?.accounts?.find(r => r.account_mask === a.mask);
    const zero = row && ['current_minor','credits_minor','debits_minor'].some(key => row[key] === 0);
    check(text.includes(a.label) && /institution|unavailable|could not.*read|couldn't.*read|error/i.test(text) && !zero,
      'institution-disclosure', `${a.label}: institution unavailable, no zero substitution`, text);
  }
  if (!ledger) {
    if (kind === 'business' && book.accounts.some(a => a.entity === 'business' && a.kind === 'checking') && book.complete && book.days >= 6 && !book.accounts.some(a => a.error || a.missing || a.kind === 'other'))
      failures.push({ group: 'business-wording', expected: 'business ledger answer', actual: body.gaps?.[0]?.reason });
    return failures;
  }
  // Card purchases are expenses; liability repayments are movements, and
  // liability balances are never cash. Omitted history cannot supply a subtotal.
  const expectedKind = { balance: 'balance', in: 'totals', spend: 'expense_summary', largest: 'largest', payment: 'payment', business: 'expense_summary' }[kind];
  check(ledger.kind === expectedKind, 'answer-kind', expectedKind, ledger.kind);
  const eligible = accounts.filter(a => ['checking','savings','card'].includes(a.kind) && book.complete && book.days >= 6 && !a.error);
  const posted = book.rows.filter(r => !r.pending && r.day >= '2026-11-01' && r.day <= '2026-11-06');
  const sum = rows => total(rows.map(r => r.cents));
  if (kind === 'balance') {
    for (const a of accounts) {
      const row = ledger.accounts?.find(r => r.account_mask === a.mask);
      if (row) {
        check(String(row.current_minor) === a.balance, 'balance-figure', a.balance, row.current_minor);
        check(displayed.includes(String(row.current_minor)), 'answer-figure', String(row.current_minor), displayed);
      }
      if (row && ['card','loan'].includes(a.kind)) check(row.balance_group !== 'cash', 'liability-cash', 'separate liability', row.balance_group);
    }
  }
  if (['spend','business'].includes(kind) && ledger.expense_total_minor != null) {
    const gold = sum(posted.filter(r => r.direction === 'outflow' && eligible.some(a => a.id === r.account)));
    check(displayed.includes(String(ledger.expense_total_minor)), 'answer-figure', String(ledger.expense_total_minor), displayed);
    check(String(ledger.expense_total_minor) === gold, 'liability-expense-membership', gold, ledger.expense_total_minor);
  }
  if (kind === 'in' && ledger.accounts) for (const row of ledger.accounts) {
    const a = accounts.find(a => a.mask === row.account_mask);
    if (a) check(String(row.credits_minor) === sum(posted.filter(r => r.account === a.id && r.direction === 'inflow')),
      'inflow-figure', sum(posted.filter(r => r.account === a.id && r.direction === 'inflow')), row.credits_minor);
  }
  if (kind === 'largest') {
    const rows = ledger.lead_rows || ledger.rows || [];
    const gold = posted.filter(r => r.direction === 'outflow' && eligible.some(a => a.id === r.account)).sort((a,b) => Number(b.cents)-Number(a.cents)).slice(0, 10);
    check(JSON.stringify(rows.map(r => String(r.amount_minor))) === JSON.stringify(gold.map(r => r.cents)),
      'liability-expense-membership', gold.map(r => r.cents), rows.map(r => String(r.amount_minor)));
  }
  if (kind === 'payment' && typeof ledger.found === 'boolean') {
    const target = book.rows.find(r => r.direction === 'inflow')?.cents || '12345';
    check(ledger.found === posted.some(r => r.direction === 'inflow' && r.cents === target), 'payment-figure',
      posted.some(r => r.direction === 'inflow' && r.cents === target), ledger.found);
  }
  if (!book.complete) check(/partial|incomplete|missing|backfill|not.*confirm|unavailable/i.test(text), 'backfill-disclosure', 'incomplete history notice', text);
  if (book.accounts.some(a => a.kind === 'other')) check(/account types?[^.\n]*(?:unconfirmed|not.*confirm|unknown)|(?:unknown|unconfirmed) account types?|excluded from cash|type.*review/i.test(text), 'kind-disclosure', 'unconfirmed kind notice', text);
  return failures;
}
const KNOWN = new Set(['business-wording']);
const FIGURES = new Set(['balance-figure','inflow-figure','payment-figure','liability-expense-membership','liability-cash','answer-figure']);

// Delta debugging removes rows then accounts while preserving this exact
// property's failure, followed by reducing every amount to one cent.
async function shrink(book, kind, group) {
  let current = structuredClone(book);
  const persists = async candidate => {
    const f = await fixture(candidate);
    try { return violations(candidate, kind, await ask(f, questions(candidate).find(([k]) => k === kind)[1])).some(v => v.group === group); }
    finally { f.close(); }
  };
  for (const row of [...current.rows]) {
    const candidate = { ...current, rows: current.rows.filter(r => r.id !== row.id) };
    if (await persists(candidate)) current = candidate;
  }
  for (const a of [...current.accounts]) {
    const candidate = { ...current, accounts: current.accounts.filter(b => b.id !== a.id), rows: current.rows.filter(r => r.account !== a.id) };
    if (candidate.accounts.length && await persists(candidate)) current = candidate;
  }
  const small = { ...current, accounts: current.accounts.map(a => ({ ...a, balance: '1' })), rows: current.rows.map(r => ({ ...r, cents: '1' })) };
  if (await persists(small)) current = small;
  return current;
}
test('648 seeded first-day questions retain every property failure in a reproducible root-cause group', async t => {
  const observations = [], groups = new Map();
  let overRefusals = 0, ledgerAnswers = 0;
  const books = generate();
  assert.ok(books.some(b => b.days === 0) && books.some(b => b.days === 90));
  assert.ok(books.some(b => b.complete) && books.some(b => !b.complete));
  assert.ok(books.some(b => b.accounts.some(a => a.kind === 'other')));
  assert.ok(books.some(b => b.accounts.some(a => a.missing || a.error)));
  assert.ok(books.some(b => b.rows.some(r => r.pending)));
  for (const book of books) {
    const f = await fixture(book);
    try {
      for (const [kind, question] of questions(book)) {
        const body = await ask(f, question);
        if (body.ledger) ledgerAnswers++;
        const failures = violations(book, kind, body);
        const safe = book.complete && book.days >= 6 && !book.unknown && !book.accounts.some(a => a.error || a.missing);
        if (safe && !body.ledger) overRefusals++;
        observations.push({ seed: book.seed, index: book.index, kind, failures });
        for (const failure of failures) {
          if (!groups.has(failure.group)) groups.set(failure.group, { group: failure.group, count: 0, kind, book, failure });
          groups.get(failure.group).count++;
        }
      }
    } finally { f.close(); }
  }
  const shrunk = [];
  for (const g of groups.values()) {
    const minimal = await shrink(g.book, g.kind, g.group);
    shrunk.push({ group: g.group, count: g.count, kind: g.kind, minimal });
  }
  const receipt = { cases: observations.length, wrong_figures: observations.filter(o => o.failures.some(v => FIGURES.has(v.group))).length,
    groups: shrunk, over_refusals: overRefusals, observations };
  if (process.env.SIMPLEFIN_DAY_ONE_RECEIPT) writeFileSync(process.env.SIMPLEFIN_DAY_ONE_RECEIPT, JSON.stringify(receipt, null, 2));
  t.diagnostic(JSON.stringify({ cases: receipt.cases, wrong_figures: receipt.wrong_figures, groups: shrunk.map(g => ({ group: g.group, count: g.count, kind: g.kind, minimal: g.minimal })), over_refusals: overRefusals }));
  assert.equal(observations.length, 648);
  assert.equal(modelCalls, 0, 'every generated answer used deterministic ledger functions');
  assert.ok(ledgerAnswers >= 100, 'positive ledger controls prevent uniform refusals');
  assert.ok(observations.some(o => !o.failures.length), 'nonempty passing controls');
  assert.deepEqual([...groups.keys()].filter(g => !KNOWN.has(g)), [], 'ungrouped or new numerical failure');
  if (process.env.SIMPLEFIN_DAY_ONE_REJECT_GROUP) assert.equal(observations.filter(o => o.failures.some(v => process.env.SIMPLEFIN_DAY_ONE_REJECT_GROUP.split(',').includes(v.group))).length, 0, 'targeted property gate');
  // Business-role wording belongs to its separate integration lane.
  if (process.env.SIMPLEFIN_DAY_ONE_STRICT === '1') assert.equal(observations.filter(o => o.failures.some(v => v.group !== 'business-wording')).length, 0, 'strict property gate');
});


// These positive controls must stay green even while the finder records known
// failures in the mixed account inventory. They kill blanket refusal patches.
test('complete checking-only controls satisfy figures and pending exclusion', async () => {
  const book = structuredClone(generate().find(b => b.seed === 1106 && b.index === 1));
  book.accounts = book.accounts.filter(a => a.id === 'business');
  book.rows = book.rows.filter(r => r.account === 'business').map(r => ({ ...r, day: '2026-11-05' }));
  const f = await fixture(book);
  try {
    for (const [kind, question] of questions(book).filter(([kind]) => kind !== 'business')) {
      const body = await ask(f, question);
      assert.ok(body.ledger, kind + ': positive ledger decision');
      assert.deepEqual(violations(book, kind, body), [], kind + ': independent cents properties');
    }
  } finally { f.close(); }
});

test('card purchases count, confirmed bank repayment categories never count as spending', async () => {
  const book = structuredClone(generate().find(b => b.seed === 1106 && b.index === 1));
  book.rows = [
    { id: 'purchase', account: 'card', cents: '1234', direction: 'outflow', pending: false, day: '2026-11-05' },
    { id: 'repayment', account: 'business', cents: '5000', direction: 'outflow', pending: false, day: '2026-11-05' },
  ];
  const f = await fixture(book);
  try {
    for (const category of ['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT']) {
      f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid='repayment'", category);
      const summary = await ask(f, 'How much did I spend this month?');
      assert.equal(summary.ledger?.expense_total_minor, 1234);
      const ranked = await ask(f, 'What were my largest expenses this month?');
      assert.deepEqual(ranked.ledger?.lead_rows.map(r => r.amount_minor), [1234]);
    }
    f.raw("UPDATE fin_transactions SET category_basis_state=NULL WHERE txn_uid='repayment'");
    const bankCode = await ask(f, 'How much did I spend this month?');
    assert.equal(bankCode.ledger?.expense_total_minor, 1234,
      'a bank repayment code proves movement without owner category review');
    assert.equal(bankCode.ledger.payment_exclusions.total_minor, 5000);
    assert.equal(bankCode.ledger.payment_exclusions.count, 1);
    f.raw("UPDATE fin_transactions SET category='SHOPPING' WHERE txn_uid='repayment'");
    assert.equal((await ask(f, 'How much did I spend this month?')).ledger?.expense_total_minor, 6234,
      'an arbitrary unconfirmed spending category cannot subtract a purchase');
  } finally { f.close(); }
});

test('loading history and unknown kind notices name the account even on a refused total', async () => {
  const book = structuredClone(generate()[0]);
  book.accounts = book.accounts.filter(a => a.id === 'business');
  const f = await fixture(book);
  try {
    for (const [, question] of questions(book).filter(([k]) => k !== 'business')) {
      const body = await ask(f, question);
      const text = [body.answer, ...(body.gaps || []).map(g => g.detail)].join('\n');
      assert.match(text, /Business account: history is still loading.*History complete through:/);
      assert.match(text, /Business account: not counted.*kind not confirmed/);
    }
    f.raw("UPDATE fin_account_coverage SET coverage_status='complete'");
    const balance = await ask(f, 'What is my current balance?');
    assert.match(balance.answer, /History complete through: 2026-11-06/);
    assert.equal(balance.ledger.history_loading, true);
  } finally { f.close(); }
});
