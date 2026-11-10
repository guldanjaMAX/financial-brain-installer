import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay, ROOT, sha } from '../../eval/fast-loop/money-replay.mjs';
import { cases, snapshotFor } from './fixtures/inflow-transfer-cases.mjs';
import { contract } from './fixtures/inflow-transfer-key.mjs';
import { reviewedFinalOffer, reviewedPlainCopy, reviewedTitleFields } from './fixtures/plain-copy-expectations.mjs';
import { pairOwnTransfers } from '../src/lib/ledger-analysis.js';

// The pinned money-in implementation (commit 129c78f5) is kept beside this test, so the restoring
// check does not depend on that commit being present in the checkout's history.
const pinned = file => readFileSync(new URL(`./fixtures/historical-129c78f5/${file}.txt`, import.meta.url), 'utf8');

let run;
test.before(() => { run = replay({ cases, snapshotFor }); });
for (const c of cases) test(`${c.id} through withLedgerAnswer and real SQLite`, () => {
  contract(run.observations.find(o => o.id === 'INFLOW/clean'));
  contract(run.observations.find(o => o.id === c.id));
});

test('restoring no matched subtraction fails the same clean-pair contract', () => {
  contract(run.observations.find(o => o.id === 'INFLOW/clean'));
  const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
  const before = 'const matchedInflowPairs = pairs.filter(pair =>';
  assert.equal(source.split(before).length - 1, 1, 'one restoration site');
  const restored = source.replace(before, 'const matchedInflowPairs = [].filter(pair =>');
  const o = replay({ cases: [cases[0]], snapshotFor,
    sourceOverrides: { 'ledger-answer.js': restored } }).observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.rows_read.some(row => row.id === 101), 'restored decision received counterpart');
  assert.equal(o.body.ledger.matched_own_transfers.count, 0, 'restored behavior reached');
  assert.throws(() => contract(o), { name: 'AssertionError' });
});

test('the actual pinned money-in implementation fails the clean-pair contract', () => {
  contract(run.observations[0]);
  const source = pinned('ledger-answer.js');
  const restored = replay({ cases: [cases[0]], snapshotFor, sourceOverrides: { 'ledger-answer.js': source } });
  const o = restored.observations[0];
  assert.equal(restored.source_files['worker/src/lib/ledger-answer.js'], sha(source), 'pinned bytes actually executed');
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.rows_read.some(row => row.id === 101));
  assert.equal(o.body.ledger.candidate_transfer_count, 1, 'pinned pairing decision reached');
  assert.equal(o.body.ledger.combined_inflow_minor, 37181);
  assert.equal(o.body.ledger.outside_inflow_minor, undefined, 'pinned defect reproduced');
  assert.throws(() => contract(o), { name: 'AssertionError' });
});

test('restoring generic-payee rejection fails the reached reciprocal-pair control', () => {
  const c = cases.find(c => c.id === 'INFLOW/generic-payees');
  contract(run.observations.find(o => o.id === c.id));
  const source = readFileSync(new URL('../src/lib/ledger-analysis.js', import.meta.url), 'utf8');
  const before = '&&\n        !(directedEvidence && isDirectedOwnedTransfer({ out, in: incoming }, accounts))';
  assert.equal(source.split(before).length - 1, 1, 'one generic-payee restoration site');
  const o = replay({ cases: [c], snapshotFor,
    sourceOverrides: { 'ledger-analysis.js': source.replace(before, '') } }).observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.rows_read.some(row => row.id === 101), 'outgoing counterpart reached');
  assert.equal(o.body.ledger.matched_transfer_count, 0, 'restored admission decision reached');
  assert.throws(() => contract(o), { name: 'AssertionError' });
});

test('generic-payee admission preserves expense and mixed-outflow facts with reviewed plain wording', () => {
  const c = cases.find(c => c.id === 'INFLOW/generic-payees');
  contract(run.observations.find(o => o.id === c.id));
  const sourceOverrides = Object.fromEntries(['ledger-answer.js', 'ledger-analysis.js'].map(file => [file,
    pinned(file)]));
  for (const question of ['How much money came in and went out in September 2026?',
    'What were my expenses in September 2026?']) {
    const inputs = [{ ...c, question }];
    const baseline = replay({ cases: inputs, snapshotFor, sourceOverrides });
    const current = replay({ cases: inputs, snapshotFor });
    const o = current.observations[0];
    assert.equal(o.execution_status, 'complete');
    assert.ok(o.trace.rows_read.some(row => row.id === 101));
    assert.ok(o.trace.rows_read.some(row => row.id === 102));
    assert.equal(o.body.ledger.candidate_transfer_count, 1, 'reciprocal directed pair admitted in every reader');
    if (o.body.ledger.kind === 'totals') {
      assert.deepEqual(o.body.ledger.accounts, baseline.observations[0].body.ledger.accounts, 'gross rows remain unchanged');
      assert.equal(o.body.ledger.lead_accounts.find(a => a.account_mask === '3131').debits_minor, 0);
    } else assert.equal(o.body.ledger.expense_total_minor, 0, 'named owned outflow is not an ordinary expense');
    for (const [file, source] of Object.entries(sourceOverrides)) {
      assert.equal(baseline.source_files[`worker/src/lib/${file}`], sha(source), 'pinned bytes executed');
    }
  }
});

for (const [label, corrupt] of [
  ['one cent', b => { b.ledger.outside_inflow_minor++; }],
  ['unsupported income', b => { b.ledger.income_established = true; }],
  ['wrong source', b => { b.ledger.matched_own_transfers.pairs[0].outgoing_citation = 999; }],
  ['unsupported wording', b => { b.answer = b.answer.replace('inflow posting date', 'outflow posting date'); }],
  ['unsupported trailing claim', b => { b.answer += '\nAll remaining credits are verified income.'; }],
  ['wrong source date', b => { b.citations[0].posted_on = '2026-09-11'; }],
]) test(`independent inflow key rejects ${label} with a green peer`, () => {
  const green = run.observations[0]; contract(green);
  const broken = structuredClone(green); corrupt(broken.body);
  assert.notDeepEqual(broken.body, green.body, 'corruption reached the real observation');
  assert.throws(() => contract(broken), { name: 'AssertionError' });
});

// The receiving account is covered and readable. A fetched competitor on an
// unselected account or outside certified coverage must still prevent proof.
const competitionCases = ['proposed-out', 'uncovered-in'].flatMap(competition =>
  ['uncertain', 'confirmed-covered', 'removed', 'inadmissible-endpoint'].map(arm => ({ ...cases[0],
    id: `R1/${competition}/${arm}`, competition, arm,
    question: 'How much came in September 2026 for account 5353?',
  })));
function competitionSnapshot(c) {
  const s = snapshotFor(cases.find(input => input.id ===
    (c.competition === 'proposed-out' ? 'INFLOW/clean' : 'INFLOW/boundary-competition')));
  if (c.competition === 'proposed-out') {
    s.rows.push({ ...s.rows[0], id: 104, uid: 'competing-out',
      basis_state: c.arm === 'uncertain' ? 'proposed' : 'confirmed' });
  } else if (c.arm === 'uncertain') s.accounts[1].from = '2026-09-01';
  if (['removed', 'inadmissible-endpoint'].includes(c.arm)) s.rows = s.rows.filter(row => row.id !== 104);
  if (c.arm === 'inadmissible-endpoint') {
    if (c.competition === 'proposed-out') s.rows[0].basis_state = 'proposed';
    else s.accounts[0].from = '2026-09-01';
  }
  return s;
}
function competitionDecision(o) {
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.trace.product_writes, 0);
  assert.equal(o.trace.fallback_calls, 0);
  assert.equal(o.trace.parsed_intents[0].inflowOnly, true);
  assert.ok(o.trace.dependencies.includes('transactions'), 'real SQL decision reached');
  assert.ok(o.trace.rows_read.some(row => row.id === 101), 'outgoing leg fetched');
  assert.ok(o.trace.rows_read.some(row => row.id === 102), 'incoming leg fetched');
  const accounts = new Map(o.trace.sql.find(call => call.kind === 'inventory').rows.map(a =>
    [a.account_slug, { ...a, members: [a] }]));
  assert.equal(pairOwnTransfers(o.trace.rows_read.filter(row => row.id !== 104), accounts,
    { directedEvidence: true }).pairs.length, 1, 'nonempty pairing decision without the competitor');
  assert.equal(o.body.ledger.combined_inflow_minor, 12500, 'recorded inflow stays gross independently of pairing');
  assert.equal(o.body.ledger.income_established, false);
  assert.equal(o.body.evidence_gate.complete, true);
  return accounts;
}
function competitionContract(o) {
  const accounts = competitionDecision(o);
  const competitor = o.trace.rows_read.find(row => row.id === 104);
  assert.ok(competitor, 'competing posted row reached the real reader');
  if (o.id === 'R1/proposed-out/uncertain') assert.equal(competitor.basis_state, 'proposed');
  if (o.id === 'R1/uncovered-in/uncertain') assert.equal(competitor.posted_on, '2026-08-26');
  assert.equal(pairOwnTransfers(o.trace.rows_read, accounts, { directedEvidence: true }).pairs.length, 0,
    'all fetched candidates are ambiguous');
  const l = o.body.ledger;
  assert.equal(l.matched_own_transfers.total_minor, 0, 'ambiguity cannot support subtraction');
  assert.equal(l.matched_own_transfers.count, 0);
  assert.deepEqual(l.matched_own_transfers.pairs, [], 'neither competing leg becomes a proven pair');
  assert.equal(l.candidate_transfer_count, 0);
  assert.equal(l.outside_inflow_minor, 12500, 'an unpaired credit stays in the remainder');
  assert.deepEqual(l.transfer_related_credit_citations, [1]);
  assert.deepEqual(o.body.citations.map(c => c.ref), ['ledger:transaction:102']);
  assert.match(o.body.answer, /Matched transfers between your own accounts: \$0\.00 across 0 pairs/);
  assert.match(o.body.answer, /Inflow from outside your covered accounts: \$125\.00/);
}
let competitionRun;
test.before(() => { competitionRun = replay({ cases: competitionCases, snapshotFor: competitionSnapshot }); });
for (const competition of ['proposed-out', 'uncovered-in']) {
  const observation = arm => competitionRun.observations.find(o => o.id === `R1/${competition}/${arm}`);
  test(`R1 ${competition} retains the competitor before uniqueness with reached controls`, () => {
    const green = observation('removed');
    competitionDecision(green);
    assert.equal(green.body.ledger.matched_own_transfers.total_minor, 12500);
    assert.equal(green.body.ledger.matched_own_transfers.count, 1);
    assert.equal(green.body.ledger.outside_inflow_minor, 0);
    competitionContract(observation('confirmed-covered'));
    competitionContract(observation('uncertain'));
  });
  test(`R1 ${competition} still requires admissible endpoints after unique pairing`, () => {
    const green = observation('removed');
    competitionDecision(green);
    assert.equal(green.body.ledger.matched_own_transfers.total_minor, 12500);
    const o = observation('inadmissible-endpoint');
    const accounts = competitionDecision(o);
    assert.equal(pairOwnTransfers(o.trace.rows_read, accounts, { directedEvidence: true }).pairs.length, 1,
      'unique pair reaches endpoint admission');
    if (competition === 'proposed-out') assert.equal(o.trace.rows_read.find(row => row.id === 101).basis_state, 'proposed');
    else assert.equal(o.trace.rows_read.find(row => row.id === 101).posted_on, '2026-08-29');
    assert.equal(o.body.ledger.matched_own_transfers.total_minor, 0);
    assert.deepEqual(o.body.ledger.matched_own_transfers.pairs, []);
    assert.equal(o.body.ledger.outside_inflow_minor, 12500);
  });
  test(`R1 restoring early eligibility filtering fails the ${competition} contract`, () => {
    competitionContract(observation('uncertain'));
    const c = competitionCases.find(c => c.competition === competition && c.arm === 'uncertain');
    const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
    const before = 'const pairingRows = allRows;';
    assert.equal(source.split(before).length - 1, 1, 'one early-filter restoration site');
    const restored = source.replace(before, 'const pairingRows = allRows.filter(eligible);');
    const result = replay({ cases: [c], snapshotFor: competitionSnapshot,
      sourceOverrides: { 'ledger-answer.js': restored } });
    assert.equal(result.source_files['worker/src/lib/ledger-answer.js'], sha(restored), 'restored bytes executed');
    const o = result.observations[0];
    competitionDecision(o);
    assert.ok(o.trace.rows_read.some(row => row.id === 104), 'competitor reached restored decision');
    assert.equal(o.body.ledger.candidate_transfer_count, 1);
    assert.equal(o.body.ledger.matched_own_transfers.total_minor, 12500, 'original unsupported subtraction reproduced');
    assert.equal(o.body.ledger.outside_inflow_minor, 0);
    assert.throws(() => competitionContract(o), { name: 'AssertionError' });
  });
}
