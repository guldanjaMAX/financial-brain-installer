import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { contract } from './fixtures/inflow-transfer-key.mjs';
import assert from 'node:assert/strict';
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { cases, snapshotFor } from './fixtures/inflow-transfer-cases.mjs';
const input = cases[0];
function snapshot(c) {
  const s = snapshotFor(c);
  s.rows = [{ id: 102, uid: 'gross-witness', account: 'reserve', date: '2026-09-01', direction: 'inflow', cents: '529', description: 'TRANSFER FROM account 3131', payee: null, pending: 0 }];
  return s;
}
test('unpaired owned-looking credit stays in gross and outside with one quoted cited warning', () => {
  const b = replay({ cases: [input], snapshotFor: snapshot }).observations[0].body;
  assert.equal(b.ledger.combined_inflow_minor, 529);
  assert.equal(b.ledger.outside_inflow_minor, 529);
  assert.equal(b.ledger.matched_transfer_count, 0);
  assert.equal((b.answer.match(/Possible own transfer/g) || []).length, 1);
  assert.match(b.answer, /"TRANSFER FROM account 3131" \[1\]/);
  assert.match(b.answer, /outside.*includes.*possible own transfer/i);
});
function witnessContract(b) {
  assert.equal(b.ledger.combined_inflow_minor, 529);
  assert.equal(b.ledger.outside_inflow_minor, 529);
  assert.match(b.answer, /Possible own transfer.*"TRANSFER FROM account 3131" \[1\]/);
  assert.match(b.answer, /Combined recorded inflow: \$5\.29 gross/);
}
const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
for (const [name, before, after, paired] of [
  ['drop unpaired owned inflow', 'const ownRows = rows.filter(row => row.effective_account_slug === account.account_slug);', 'const ownRows = rows.filter(row => !membership.possible.has(row.id) && row.effective_account_slug === account.account_slug);', false],
  ['omit pair subtraction', 'const outsideInflowMinor = combined - matchedInflowMinor;', 'const outsideInflowMinor = combined;', true],
  ['suppress structural pairing', 'const matchedInflowPairs = pairs.filter(pair =>', 'const matchedInflowPairs = [].filter(pair =>', true],
  ['suppress possible transfer disclosure', '...possibleTransfers.map(row =>', '...[].map(row =>', false],
  ['gross primary off by one', 'const combined = sumMinor(totals, account => account.credits_minor);', 'const combined = 1 + sumMinor(totals, account => account.credits_minor);', false],
]) test(`gross contract kills ${name} in an isolated source override`, () => {
  const validate = o => paired ? contract(o) : witnessContract(o.body);
  const options = { cases: [input], snapshotFor: paired ? snapshotFor : snapshot };
  validate(replay(options).observations[0]);
  assert.equal(source.split(before).length - 1, 1, 'mutation site is unique');
  const mutant = source.replace(before, after);
  const observation = replay({ ...options, sourceOverrides: { 'ledger-answer.js': mutant } }).observations[0];
  assert.equal(observation.execution_status, 'complete', 'mutant reached an answer');
  assert.throws(() => validate(observation), { name: 'AssertionError' });
});
test('an unpaired named owned loan advance remains gross and visibly possible', () => {
  const o = replay({ cases: [input], snapshotFor: c => {
    const s = snapshot(c);
    s.rows[0].description = 'LOAN ADVANCE FROM ACCOUNT 4242';
    s.accounts.find(a => a.slug === 'debt').kind = 'loan';
    return s;
  } }).observations[0];
  assert.equal(o.body.ledger.combined_inflow_minor, 529);
  assert.equal(o.body.ledger.outside_inflow_minor, 529);
  assert.match(o.body.answer, /Possible own transfer.*"LOAN ADVANCE FROM ACCOUNT 4242"/);
});
test('gross money-in repair preserves ordinary mixed in/out membership', () => {
  const c = { ...input, question: 'How much money came in and went out in September 2026?' };
  const o = replay({ cases: [c], snapshotFor: snapshot }).observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.body.ledger.accounts.reduce((n,a) => n + a.credits_minor, 0), 529, 'gross alternate retained');
  assert.equal(o.body.ledger.lead_accounts.reduce((n,a) => n + a.credits_minor, 0), 529, 'possible own credit stays inside money in and net');
  assert.match(o.body.answer, /Possible moves from your own accounts, retained in money in and net/);
  assert.equal(o.body.ledger.possible_owned_credits[0].included_in_total, true);
});
