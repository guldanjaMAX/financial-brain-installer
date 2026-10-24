import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture, account, transaction, NOW } from './fixtures/money-fix/fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { createProductFixture } from './product-contract-fixture.mjs';

let network = 0, subprocesses = 0;
globalThis.fetch = async () => { network++; throw new Error('Network forbidden'); };
test.before(() => {
  mock.method(Date, 'now', () => Date.parse(NOW));
  for (const method of ['spawnSync', 'spawn', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    mock.method(childProcess, method, () => { subprocesses++; throw new Error('Host tools forbidden'); });
  }
  syncBuiltinESMExports();
});
test.after(() => { assert.equal(network, 0); assert.equal(subprocesses, 0); mock.restoreAll(); syncBuiltinESMExports(); });

const ask = (f, question, extra = {}) => withLedgerAnswer({ env: f.env, question,
  grantScope: { all: true }, scopePrincipalKind: 'owner', now: NOW, ...extra },
  async gap => new Response(JSON.stringify({ answer: null, gaps: [gap] }))).then(r => r.json());
const totalQuestion = 'How much money came in and went out in September 2026?';
const total = (body, key) => body.ledger.accounts.reduce((n, a) => n + a[key], 0);
function add(f, { uid, description, payee = null, category = null, categoryState = null, ...rest }) {
  transaction(f, { uid, ...rest });
  f.raw('UPDATE fin_transactions SET description=?,payee=?,category=?,category_basis_state=? WHERE txn_uid=?',
    description || 'Synthetic transaction', payee, category, categoryState, uid);
}

test('R01: equal external transfers must retain the real expense and income', async t => {
  const f = fixture(); t.after(f.close); account(f); account(f, { slug: 'second-account', mask: '8765' });
  add(f, { uid: 'vendor-payment', amount: 50000, direction: 'outflow', description: 'Transfer to outside supplier invoice', payee: 'Outside Supplier', category: 'TRANSFER_OUT_ACCOUNT_TRANSFER', categoryState: 'proposed' });
  add(f, { uid: 'customer-payment', slug: 'second-account', amount: 50001, direction: 'inflow', description: 'Transfer from outside customer invoice', payee: 'Outside Customer', category: 'TRANSFER_IN_ACCOUNT_TRANSFER', categoryState: 'proposed' });
  const control = await ask(f, totalQuestion);
  assert.equal(total(control, 'debits_minor'), 50000); assert.equal(total(control, 'credits_minor'), 50001);
  assert.equal(control.ledger.candidate_transfer_count, 0);
  f.raw("UPDATE fin_transactions SET amount_minor=50000 WHERE txn_uid='customer-payment'");
  const reads = f.seen.length;
  const body = await ask(f, totalQuestion);
  assert.ok(f.seen.slice(reads).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(body.evidence_gate.complete, true);
  t.diagnostic(JSON.stringify({ matched: body.ledger.candidate_transfer_count, expense: total(body, 'debits_minor'), income: total(body, 'credits_minor') }));
  assert.equal(total(body, 'debits_minor'), 50000, 'external supplier payment is an expense');
  assert.equal(total(body, 'credits_minor'), 50000, 'external customer receipt is income');
});

test('R02: explicit payee prevents another merchant mentioned in the description from being summed', async t => {
  const f = fixture(); t.after(f.close); account(f);
  add(f, { uid: 'wanted', amount: 1200, direction: 'outflow', description: 'Cloud Tools subscription', payee: 'Cloud Tools' });
  add(f, { uid: 'other', amount: 80000, direction: 'outflow', description: 'Outside Consultant services', payee: 'Outside Consultant' });
  const question = 'How much did I spend at Cloud Tools in September 2026?';
  assert.equal((await ask(f, question)).ledger.total_minor, 1200);
  f.raw("UPDATE fin_transactions SET description='Outside Consultant invoice for Cloud Tools migration' WHERE txn_uid='other'");
  const reads = f.seen.length;
  const body = await ask(f, question);
  assert.ok(f.seen.slice(reads).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(f.first('SELECT COUNT(DISTINCT payee) n FROM fin_transactions').n, 2, 'both payees remain in the reached reader snapshot');
  assert.equal(body.ledger.total_minor, 1200, 'memo text does not change the merchant paid');
});

test('R03: same-bank last-four collision is not a verified twin relationship', async t => {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual', mask: '1111' }); account(f);
  f.raw("UPDATE fin_accounts SET external_ref='synthetic-distinct-a' WHERE account_slug='manual-account'");
  f.raw("UPDATE fin_accounts SET external_ref='synthetic-distinct-b' WHERE account_slug='live-account'");
  transaction(f, { uid: 'separate-credit', slug: 'manual-account', amount: 10000 }); transaction(f, { amount: 20000 });
  assert.equal(total(await ask(f, totalQuestion), 'credits_minor'), 30000);
  f.raw("UPDATE fin_accounts SET mask='4321' WHERE account_slug='manual-account'");
  const reads = f.seen.length;
  const body = await ask(f, totalQuestion);
  assert.ok(f.seen.slice(reads).some(sql => sql.includes('FROM fin_accounts')));
  assert.equal(body.ledger, undefined);
  assert.equal(body.gaps.length, 1);
  assert.equal(body.gaps[0].reason, 'ledger_account_link_required');
});

async function documentAnswer(t, { title = 'Card statement', content = 'Card ending 4242 charged USD 120.00.', metadata = {} } = {}) {
  let drafts = 0, verifiers = 0;
  const answer = 'Card ending 4242 charged USD 120.00 [1].';
  const f = await createProductFixture({ env: { ADMIN_KEY: randomBytes(32).toString('hex'),
    SESSION_SIGNING_KEY: randomBytes(32).toString('hex'), AI: { async run(model, input) {
      if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      if (String(input.messages?.[0]?.content).includes('verify a proposed answer')) {
        verifiers++; return { response: { supported: true, complete: true, evidence: [1], reason: 'synthetic approval' } };
      }
      drafts++; return { response: answer };
    } } } });
  t.after(f.close);
  f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','gmail','ready','2026-10-10')");
  const ingested = await f.post('/api/admin/brain/ingest/batch', { docs: [{ source_type: 'records', source_id: 'synthetic-record',
    title, content, occurred_at: '2026-10-10', date_reliable: true, date_source: 'fixture:record_date', text_source: 'native', text_reliable: true, metadata }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(ingested.status, 200); assert.equal((await ingested.json()).results[0].status, 'created');
  f.raw('UPDATE sources SET last_ingest_at=?,last_complete_sweep_at=? WHERE name=?', NOW, NOW, 'records');
  f.env.VECTORIZE.query = async () => ({ matches: f.rows('SELECT chunk_uid AS id FROM chunks') });
  const response = await f.post('/api/rag/think', { q: 'What did card ending 4242 charge in the last 60 days?' }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(response.status, 200); const body = await response.json();
  assert.ok(body.results.length); assert.equal(drafts, 1); assert.equal(verifiers, 1);
  assert.equal(body.evidence_gate.error, undefined);
  return body;
}

test('control: unknown primary records pass; explicit agent notes, markers and metadata are refused', async t => {
  const control = await documentAnswer(t);
  assert.equal(control.answer, 'Card ending 4242 charged USD 120.00 [1].');
  assert.equal(control.results[0].lineage.status, 'unknown');
  for (const input of [{ title: 'AI-generated financial notes' }, { title: 'AI assistant notes' },
    { metadata: { evidence_lineage: { version: 1, kind: 'agent_derived' } } },
    { content: 'Evidence-Lineage: agent-derived\nCard ending 4242 charged USD 120.00.' }]) {
    const body = await documentAnswer(t, input);
    assert.equal(body.answer, null); assert.equal(body.evidence_gate.supported, false);
  }
});

test('R04: explicitly AI-generated memo must not become primary money support', async t => {
  const control = await documentAnswer(t, { title: 'AI-generated financial notes' });
  assert.equal(control.answer, null); assert.equal(control.evidence_gate.supported, false);
  const body = await documentAnswer(t, { title: 'AI-generated financial memo' });
  t.diagnostic(JSON.stringify({ lineage: body.results[0].lineage, authority: body.results[0].authority, supported: body.evidence_gate.supported }));
  assert.equal(body.answer, null, 'changing the artifact noun cannot erase explicit AI authorship');
});


for (const noun of ['memo', 'summary', 'report', 'recap', 'analysis', 'brief']) {
  test(`R04 real route: explicit AI authorship demotes ${noun} with primary controls`, async t => {
    const human = await documentAnswer(t, { title: 'Human email', content: 'Our AI tools invoice is $120. Card ending 4242 charged USD 120.00.' });
    assert.equal(human.answer, 'Card ending 4242 charged USD 120.00 [1].');
    for (const label of [`AI-generated ${noun}`, `${noun} generated by AI`, `${noun} generated by Claude`,
      `${noun} generated by ChatGPT`, `${noun} generated by GPT`, `${noun} generated by an AI assistant`,
      `${noun} generated by an AI agent`, `${noun} written by AI`, `${noun} drafted by Claude`,
      `${noun} prepared by an AI assistant`, `AI assistant-written ${noun}`]) {
      const result = await documentAnswer(t, { title: label, metadata: { evidence_lineage: { version: 1, kind: 'source_record' } } });
      assert.equal(result.answer, null, label);
      assert.equal(result.results[0].lineage.kind, 'agent_derived', label);
      assert.equal(result.results[0].authority.tier, 'T4', label);
    }
    const inBody = await documentAnswer(t, { content: `Prepared by an AI agent: ${noun}. Card ending 4242 charged USD 120.00.` });
    assert.equal(inBody.answer, null);
  });
}

test('R01 own-mask candidate keeps genuine legs in totals and phase-two lists', async t => {
  const f = fixture(); t.after(f.close); account(f); account(f, { slug: 'second-account', mask: '8765' });
  add(f, { uid: 'out', amount: 50000, direction: 'outflow', description: 'Transfer to account 8765' });
  add(f, { uid: 'in', slug: 'second-account', amount: 50000, direction: 'inflow', description: 'Bank credit' });
  const control = await ask(f, totalQuestion);
  assert.equal(control.ledger.candidate_transfer_count, 1);
  assert.equal(total(control, 'credits_minor'), 50000); assert.equal(total(control, 'debits_minor'), 50000);
  for (const [question, field] of [
    ['What were my 3 largest expenses in September 2026?', 'rows'],
    ['How much did I spend by category in September 2026?', 'total_minor'],
    ['How much did I spend at Outside Supplier in September 2026?', 'total_minor'],
  ]) {
    f.raw("UPDATE fin_transactions SET description='Transfer to account 8765',payee='Outside Supplier' WHERE txn_uid='out'");
    const linked = await ask(f, question);
    assert.equal(field === 'rows' ? linked.ledger.rows[0].amount_minor : linked.ledger[field], 50000);
    assert.equal(linked.ledger.if_own_transfers.total_minor, 0);
    assert.equal(linked.ledger.candidate_transfer_count, 1);
    f.raw("UPDATE fin_transactions SET description='Transfer to outside supplier' WHERE txn_uid='out'");
    const reads = f.seen.length;
    const unproven = await ask(f, question);
    assert.ok(f.seen.slice(reads).some(sql => sql.includes('JOIN fin_transactions')));
    assert.equal(unproven.ledger.candidate_transfer_count, 0);
    assert.equal(field === 'rows' ? unproven.ledger.rows[0].amount_minor : unproven.ledger[field], 50000);
  }
  for (const description of ['Transfer to account 87650', 'Transfer to supplier for $8765', 'Transfer to outside supplier in 8765', 'Transfer to tax8765 service']) {
    f.raw('UPDATE fin_transactions SET description=? WHERE txn_uid=\'out\'', description);
    assert.equal((await ask(f, totalQuestion)).ledger.candidate_transfer_count, 0, description);
  }
  f.raw("UPDATE fin_accounts SET label='Reserve fund' WHERE account_slug='second-account'");
  f.raw("UPDATE fin_transactions SET description='Move funds to Reserve fund' WHERE txn_uid='out'");
  assert.equal((await ask(f, totalQuestion)).ledger.candidate_transfer_count, 1);
});

test('R02 description fallback only when an explicit payee is absent', async t => {
  const f = fixture(); t.after(f.close); account(f);
  add(f, { uid: 'fallback', amount: 1200, direction: 'outflow', description: 'Cloud Tools subscription' });
  const question = 'How much did I spend at Cloud Tools in September 2026?';
  assert.equal((await ask(f, question)).ledger.total_minor, 1200);
  f.raw("UPDATE fin_transactions SET payee='Outside Consultant'");
  const before = f.seen.length;
  assert.equal((await ask(f, question)).ledger.total_minor, 0);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
});

test('R01 a mask shared by two owned accounts cannot identify the counterparty', async t => {
  const f = fixture(); t.after(f.close); account(f);
  account(f, { slug: 'second-account', mask: '8765', institution: 'Bank Two' });
  add(f, { uid: 'out', amount: 50000, direction: 'outflow', description: 'Transfer to account 8765' });
  add(f, { uid: 'in', slug: 'second-account', amount: 50000, direction: 'inflow', description: 'Bank credit' });
  assert.equal((await ask(f, totalQuestion)).ledger.candidate_transfer_count, 1);
  f.raw("UPDATE fin_accounts SET mask='4321' WHERE account_slug='second-account'");
  f.raw("UPDATE fin_transactions SET description='Transfer to account 4321' WHERE txn_uid='out'");
  const before = f.seen.length, result = await ask(f, totalQuestion);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(result.ledger.candidate_transfer_count, 0);
  assert.equal(total(result, 'debits_minor'), 50000); assert.equal(total(result, 'credits_minor'), 50000);
});

test('R02 an explicit longer payee is a different merchant identity', async t => {
  const f = fixture(); t.after(f.close); account(f);
  add(f, { uid: 'wanted', amount: 1200, direction: 'outflow', description: 'Cloud Tools', payee: 'Cloud Tools' });
  add(f, { uid: 'other', amount: 80000, direction: 'outflow', description: 'Cloud Tools', payee: 'Cloud Tools Consulting' });
  const before = f.seen.length;
  assert.equal((await ask(f, 'How much did I spend at Cloud Tools in September 2026?')).ledger.total_minor, 1200);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
});
