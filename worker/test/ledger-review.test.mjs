import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLedgerQuestion as classify } from '../src/lib/ledger-question.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

let forbiddenFetches = 0;
globalThis.fetch = async () => { forbiddenFetches++; throw new Error('Network disabled in review'); };
test.after(() => assert.equal(forbiddenFetches, 0));

test('control: exact payer, absent payer, partial word and outflow exercise real transaction reads', async t => {
  const f = ledgerFixture(t);
  f.add('exact', 'Settlement', 'Fixture Payer');
  f.add('partial', 'Settlement', 'Fixture Payerplus');
  f.add('outgoing', 'Settlement', 'Fixture Payer', { direction: 'outflow' });
  const body = await f.ask('Did the Fixture Payer payment arrive?');
  assert.equal(body.ledger?.found, true);
  assert.equal(body.citations.length, 1);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
  const start = f.calls.length;
  // Unknown question labels refuse; only a registered identity can prove absence.
  const unregistered = await f.ask('Did the Absent Payer payment arrive?');
  assert.equal(unregistered.ledger.found, null);
  assert.equal(unregistered.evidence_gate.complete, false);
  assert.doesNotMatch(unregistered.answer, /No matching|\$0\.00/);
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('known-absent','Absent Payer','business','counterparty','owner_stated','confirmed',?)`, NOW);
  const absent = await f.ask('Did the Absent Payer payment arrive?');
  assert.equal(absent.ledger?.found, false);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)));
});

for (const adjective of ['budgeted', 'budget', 'approved', 'planned', 'projected', 'expected', 'estimated', 'forecast', 'target', 'allowed']) test(`F1 document scope: ${adjective} spending must stay on documents`, async t => {
  const f = ledgerFixture(t);
  const control = await f.ask('Show my software spending this month.');
  assert.equal(control.ledger?.kind, 'category');
  const question = `What is my ${adjective} spending this month?`;
  const start = f.calls.length;
  const body = await f.ask(question);
  assert.ok(f.calls.length > start || f.documentCalls > 0, 'a real routing decision was reached');
  assert.equal(body.ledger, undefined, `document qualifier became ${body.ledger?.kind}: ${body.answer}`);
  assert.deepEqual(body, { route: 'documents', gaps: [] });
  assert.equal(f.calls.length, start, 'planning qualifiers cannot read the ledger');
  assert.equal(classify(question, { now: Date.parse(NOW) }).kind, null);
});

const genericSenders = ['bank', 'payment', 'payments', 'deposit', 'transfer', 'money', 'the', 'my', 'a', 'an', 'account', 'company', 'client', 'customer', 'someone', 'them', 'the bank', 'my company'];
const senderForms = [
  party => `Did the ${party} payment arrive?`,
  party => `Did the payment from ${party} arrive?`,
  party => `Has my payment arrived from ${party}?`,
  party => `Did the payment via ${party} arrive?`,
];
for (const party of genericSenders) for (const [form, questionFor] of senderForms.entries()) test(`F2 generic sender form ${form}: ${party}`, async t => {
  const f = ledgerFixture(t);
  f.add('other', 'Payment processed by the bank for my company client customer someone them', 'Unrelated Payer');
  assert.equal((await f.ask('Did the Unrelated Payer payment arrive?')).ledger?.found, true);
  const start = f.calls.length, documents = f.documentCalls;
  const body = await f.ask(questionFor(party));
  assert.ok(f.calls.length > start || f.documentCalls > documents, 'real routing decision reached');
  assert.deepEqual(body, { route: 'documents', gaps: [] }, 'generic sender must preserve document fallback');
  assert.equal(f.documentCalls, documents + 1);
  assert.equal(f.calls.length, start, 'generic sender cannot read unrelated deposits');
});

test('F3 payer substring: description mention must not override a different explicit payee', async t => {
  const f = ledgerFixture(t);
  f.add('unrelated', 'Transfer from Unrelated Payer for Fixture Payer invoice', 'Unrelated Payer');
  assert.equal((await f.ask('Did the Unrelated Payer payment arrive?')).ledger?.found, true);
  const start = f.calls.length;
  const body = await f.ask('Did the Fixture Payer payment arrive?');
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'payment matcher reached');
  assert.equal(body.ledger?.found, false, 'mentioned invoice payer is not the sender');
  assert.deepEqual(body.citations, []);
});

for (const [now, period, from, to] of [
  ['2026-01-01T00:00:00.000Z', 'last month', '2025-12-01', '2025-12-31'],
  ['2024-03-01T00:00:00.000Z', 'last month', '2024-02-01', '2024-02-29'],
  ['2026-03-01T00:00:00.000Z', 'last month', '2026-02-01', '2026-02-28'],
  ['2026-10-01T00:00:00.000Z', 'this month', '2026-10-01', '2026-10-01'],
  ['2026-10-01T00:00:00.000Z', 'recent', '2026-09-18', '2026-10-01'],
  [NOW, 'Q3', '2026-07-01', '2026-09-30'],
  [NOW, 'so far this year', '2026-01-01', '2026-10-12'],
  [NOW, '2026 so far', '2026-01-01', '2026-10-12'],
]) test(`control: bounded window ${period} at ${now}`, () => {
  const intent = classify(`Show my deposits ${period}`, { now: Date.parse(now) });
  assert.equal(intent.kind, 'deposits');
  assert.deepEqual([intent.from, intent.to], [from, to]);
});

for (const [label, change] of [
  ['historical activity', f => f.add('old', 'Old activity', 'Synthetic payer', { date: '2025-01-01' })],
  ['incomplete provider', f => f.raw("UPDATE bank_feed_backfill SET provider_history_state='INITIAL_UPDATE_COMPLETE'")],
  ['missing provider', f => f.raw('DELETE FROM bank_feed_backfill')],
  ['nonzero balance', f => f.raw('UPDATE fin_balance_snapshots SET current_minor=1')],
  ['unread provider', f => f.raw('UPDATE bank_feed_backfill SET unread_lines=1')],
  ['staged work', f => f.raw("INSERT INTO plaid_sync_windows (item_ref,window_ref,state,started_at,updated_at) VALUES ('fixture-feed','fixture-window','staging',?,?)", NOW, NOW)],
]) test(`control: empty recovery refuses ${label}`, async t => {
  const f = ledgerFixture(t, { legacy: true });
  const question = 'How much money came in last month?';
  assert.equal((await f.ask(question)).ledger?.kind, 'totals', 'green completed empty history');
  change(f);
  const start = f.calls.length;
  const body = await f.ask(question);
  assert.ok(f.calls.slice(start).some(sql => /FROM fin_accounts/.test(sql)), 'coverage decision reached');
  assert.equal(body.ledger, undefined);
  assert.equal(body.gaps[0]?.reason, 'period_outside_coverage');
});

for (const question of ['Did the Fixture Bank payment arrive?', 'Did the payment from Fixture Bank arrive?', 'Did the payment via Fixture Bank arrive?']) test(`F2 specific mixed sender control: ${question}`, async t => {
  const f = ledgerFixture(t);
  f.add('exact', 'Settlement', 'Fixture Bank');
  f.add('different', 'Bank settlement', 'Fixture');
  const body = await f.ask(question);
  assert.equal(body.ledger?.found, true);
  assert.equal(body.citations.length, 1, 'generic words in a specific name remain matching constraints');
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
});

for (const name of ['!!!', '123', 'one two three four five six seven eight nine', 'very much']) test(`F1 bounded merchant shorthand: ${name}`, async t => {
  const f = ledgerFixture(t);
  assert.equal((await f.ask('Show my software spending this month.')).ledger?.kind, 'category');
  const documents = f.documentCalls;
  const body = await f.ask(`Show my ${name} spending this month.`);
  assert.equal(body.route, 'documents');
  assert.equal(f.documentCalls, documents + 1, 'document routing decision reached');
});

test('F3 description is sender evidence only when no payee is present', async t => {
  const f = ledgerFixture(t);
  f.add('fallback', 'Payment from Fixture Payer', null, { cents: 1357 });
  f.add('explicit', 'Other narration', 'Fixture Payer', { cents: 2468 });
  f.add('conflict', 'Payment from Fixture Payer', 'Unrelated Payer', { cents: 3690 });
  const body = await f.ask('Did the Fixture Payer payment arrive?');
  assert.equal(body.ledger?.found, true);
  assert.deepEqual(body.citations.map(row => row.amount_minor), [1357, 2468]);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)));
});

for (const qualifier of ['first', 'second', 'third', 'another', 'bank']) test(`named generic or ordinal sender cannot become payment evidence: ${qualifier}`, async t => {
  const f = ledgerFixture(t);
  f.add('exact', 'Settlement', 'Fixture Payer', { cents: 3750 });
  assert.equal((await f.ask('Did a payment of $37.50 arrive?')).ledger?.found, true);
  const documents = f.documentCalls;
  const body = await f.ask(`Did the ${qualifier} payment of $37.50 arrive?`);
  assert.deepEqual(body, { route: 'documents', gaps: [] });
  assert.equal(f.documentCalls, documents + 1, 'ambiguous sender reached document routing');
});

test('closure: a lone past-participle qualifier such as "authorized" stays a document question', async t => {
  const f = ledgerFixture(t);
  assert.equal((await f.ask('Show my software spending this month.')).ledger?.kind, 'category');
  for (const question of ['What is my authorized spending this month?', 'What is my allocated spending this month?']) {
    const documents = f.documentCalls;
    const body = await f.ask(question);
    assert.deepEqual(body, { route: 'documents', gaps: [] }, question);
    assert.equal(f.documentCalls, documents + 1, question);
  }
});

test('closure: without a payee, only the description sender clause can name the payer', async t => {
  const f = ledgerFixture(t);
  f.add('unrelated', 'Transfer from Unrelated Payer for Fixture Payer invoice', null);
  f.add('opening', 'Fixture Sender ACH deposit', null);
  assert.equal((await f.ask('Did the Unrelated Payer payment arrive?')).ledger?.found, true);
  assert.equal((await f.ask('Did the Fixture Sender payment arrive?')).ledger?.found, true);
  const start = f.calls.length;
  const body = await f.ask('Did the Fixture Payer payment arrive?');
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'sender match decision reached');
  assert.notEqual(body.ledger?.found, true, 'an invoice-party mention cannot confirm arrival from that party');
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.citations.length, 1, 'assumed other payer remains a candidate');
  assert.equal(body.ledger.unattributed_count, 1);
});
