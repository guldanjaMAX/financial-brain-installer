import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fixture, account, transaction, NOW } from './fixtures/money-fix/fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { readEffectiveAccounts } from '../src/lib/ledger-reader.js';
import { createProductFixture } from './product-contract-fixture.mjs';

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
  f.env.VECTORIZE.query = async () => ({ matches: f.rows('SELECT chunk_uid AS id FROM chunks') });
  const response = await f.post('/api/rag/think', { q: 'What did card ending 4242 charge in the last 60 days?' }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(response.status, 200); const body = await response.json();
  assert.ok(body.results.length); assert.equal(drafts, 1); assert.equal(verifiers, 1);
  assert.equal(body.evidence_gate.error, undefined);
  return body;
}


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

const question = 'How much money came in and went out in September 2026?';
const ask = (f, q = question, next = async gap => new Response(JSON.stringify({ answer: null, gaps: [gap] }))) =>
  withLedgerAnswer({ env: f.env, question: q, grantScope: { all: true }, scopePrincipalKind: 'owner', now: NOW }, next).then(r => r.json());
const total = (accounts, field) => accounts.reduce((sum, row) => sum + row[field], 0);
function add(f, { description = 'Ordinary posting', payee = null, category = null, ...args }) {
  transaction(f, args);
  f.raw('UPDATE fin_transactions SET description=?,payee=?,category=?,category_basis_state=? WHERE txn_uid=?',
    description, payee, category, category ? 'confirmed' : null, args.uid);
}
function setup(t) {
  const f = fixture(); t.after(f.close);
  account(f, { from: '2026-08-01' }); account(f, { slug: 'second-account', mask: '8765', from: '2026-08-01' });
  return f;
}

test('N01 conditional cents, signs and account/window edges retain primary postings', async t => {
  for (const [outDay, inDay] of [
    ['2026-09-15', '2026-09-15'], ['2026-08-31', '2026-09-02'], ['2026-09-30', '2026-10-02'],
  ]) {
    const f = setup(t);
    add(f, { uid: 'out', amount: 12345, day: outDay, direction: 'outflow', description: 'Transfer to account 8765' });
    add(f, { uid: 'in', slug: 'second-account', amount: 12345, day: inDay, direction: 'inflow' });
    add(f, { uid: 'expense', amount: 19, direction: 'outflow' });
    add(f, { uid: 'income', slug: 'second-account', amount: 23, direction: 'inflow' });
    for (const mask of [null, '4321', '8765']) {
      const q = question.replace('?', mask ? ` for account ending ${mask}?` : '?');
      const before = f.seen.length, b = await ask(f, q);
      assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
      assert.equal(b.evidence_gate.complete, true);
      const outSelected = mask !== '8765', inSelected = mask !== '4321';
      assert.equal(total(b.ledger.accounts, 'debits_minor'), outSelected ? 19 + (outDay.startsWith('2026-09') ? 12345 : 0) : 0);
      assert.equal(total(b.ledger.accounts, 'credits_minor'), inSelected ? 23 + (inDay.startsWith('2026-09') ? 12345 : 0) : 0);
      assert.equal(total(b.ledger.if_own_transfers.accounts, 'debits_minor'), outSelected ? 19 : 0);
      assert.equal(total(b.ledger.if_own_transfers.accounts, 'credits_minor'), inSelected ? 23 : 0);
      assert.equal(b.ledger.matched_transfer_count, 0);
      const ids = b.ledger.transfers.flatMap(pair => [pair.outgoing.ref, pair.incoming.ref]);
      assert.equal(new Set(ids).size, ids.length);
    }
  }
});

test('N01 candidate and ordinary postings survive largest, category and merchant views', async t => {
  const f = setup(t);
  add(f, { uid: 'out', amount: 12345, direction: 'outflow', description: 'Transfer to account 8765', payee: 'Tools Shop', category: 'SOFTWARE' });
  add(f, { uid: 'in', slug: 'second-account', amount: 12345, direction: 'inflow' });
  add(f, { uid: 'expense', amount: 19, direction: 'outflow', payee: 'Tools Shop', category: 'SOFTWARE' });
  for (const q of ['Show my 3 largest expenses in September 2026?', 'How much did I spend by category in September 2026?',
    'How much did I spend at Tools Shop in September 2026?']) {
    const before = f.seen.length, b = await ask(f, q);
    assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
    assert.equal(b.ledger.candidate_transfer_count, 1);
    assert.equal(b.ledger.if_own_transfers.total_minor, 19);
    assert.equal(total(b.ledger.rows || b.ledger.groups, b.ledger.rows ? 'amount_minor' : 'total_minor'), 12364);
    assert.equal(b.ledger.rows ? b.ledger.rows.filter(r => r.possible_own_transfer).length : b.ledger.groups[0].possible_transfer_citations.length, 1);
  }
});

test('N01 duplicate peer control never subtracts one row as two candidate pairs', async t => {
  const f = setup(t); account(f, { slug: 'third-account', mask: '2468', from: '2026-08-01' });
  add(f, { uid: 'out', amount: 12345, direction: 'outflow', description: 'Transfer to account 8765' });
  add(f, { uid: 'in', slug: 'second-account', amount: 12345, direction: 'inflow' });
  const control = await ask(f); assert.equal(control.ledger.candidate_transfer_count, 1);
  add(f, { uid: 'competitor', slug: 'third-account', amount: 12345, direction: 'inflow' });
  const before = f.seen.length, b = await ask(f);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(b.ledger.candidate_transfer_count, 0);
  assert.equal(total(b.ledger.accounts, 'debits_minor'), 12345);
  assert.equal(total(b.ledger.accounts, 'credits_minor'), 24690);
  assert.deepEqual(b.ledger.if_own_transfers.accounts, b.ledger.accounts);
});

test('N02 common explicit body/title disclosures refuse and template discussion remains human', async t => {
  const human = await documentAnswer(t, { content: "I created an invoice using ChatGPT's template. Card ending 4242 charged USD 120.00." });
  assert.equal(human.evidence_gate.supported, true);
  for (const input of [
    { content: 'Produced via ChatGPT. Card ending 4242 charged USD 120.00.' },
    { title: 'Created using an AI assistant' },
  ]) {
    const b = await documentAnswer(t, input);
    assert.equal(b.results[0].lineage.kind, 'agent_derived');
    assert.equal(b.answer, null); assert.equal(b.evidence_gate.supported, false);
  }
});

test('P01: a human payment action by an agent is not an AI authorship disclosure', async t => {
  const control = await documentAnswer(t, { content: 'The payment was made by a bank employee at the branch. Card ending 4242 charged USD 120.00.' });
  assert.equal(control.evidence_gate.supported, true);
  const content = 'The payment was made by an agent at the bank branch. Card ending 4242 charged USD 120.00.';
  const b = await documentAnswer(t, { content });
  t.diagnostic(JSON.stringify({ lineage: b.results[0].lineage.kind, supported: b.evidence_gate.supported, answer: b.answer }));
  assert.equal(b.answer, control.answer, 'a human bank agent making a payment does not author this email with AI');
  assert.equal(b.evidence_gate.supported, true);
});

test('P01 variant: a human assistant creating the invoice is not explicit AI authorship', async t => {
  const control = await documentAnswer(t, { content: 'The invoice was created by an employee in accounts payable. Card ending 4242 charged USD 120.00.' });
  assert.equal(control.evidence_gate.supported, true);
  const content = 'The invoice was created by an assistant in accounts payable. Card ending 4242 charged USD 120.00.';
  const b = await documentAnswer(t, { content });
  assert.equal(b.answer, control.answer);
});

test('P01 human role titles stay primary; explicitly AI-qualified roles still demote', async t => {
  const control = await documentAnswer(t);
  assert.equal(control.evidence_gate.supported, true);
  for (const title of ['Assistant notes', 'Agent summary', 'Assistant-written memo', 'Agent-written report']) {
    const b = await documentAnswer(t, { title });
    assert.equal(b.answer, control.answer, title);
    assert.equal(b.evidence_gate.supported, true);
    assert.equal(b.results[0].lineage.status, 'unknown');
  }
  for (const title of ['AI assistant notes', 'AI agent summary', 'ChatGPT memo', 'Chatbot draft']) {
    const b = await documentAnswer(t, { title });
    assert.equal(b.results[0].lineage.kind, 'agent_derived', title);
    assert.equal(b.answer, null); assert.equal(b.evidence_gate.supported, false);
  }
});

test('P02: adding out-of-window collisions cannot hide a relevant existing collision', async t => {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-a', mode: 'manual' }); account(f, { slug: 'live-a' });
  transaction(f, { slug: 'manual-a', uid: 'manual-copy' }); transaction(f, { slug: 'live-a', uid: 'live-copy' });
  let documents = 0;
  const next = async gap => { documents++; return new Response(JSON.stringify({ answer: 'Document fallback reached.', gaps: [gap] })); };
  const control = await ask(f, question, next);
  assert.equal(control.code, 'ledger_account_link_required'); assert.equal(documents, 0);
  account(f, { slug: 'manual-z', mode: 'manual', from: '2020-01-01', to: '2020-01-31' });
  account(f, { slug: 'live-z', from: '2020-01-01', to: '2020-01-31' });
  const inventory = await readEffectiveAccounts(f.env);
  assert.equal(inventory.length, 4); assert.equal(inventory.filter(a => a.linkRequired).length, 4);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
  const before = f.seen.length, b = await ask(f, question, next);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  t.diagnostic(JSON.stringify({ code: b.code, gap: b.gaps[0].reason, documents }));
  assert.equal(b.code, 'ledger_account_link_required', 'the original selected September collision still exists');
  assert.equal(documents, 0);
  assert.equal(b.gaps.length, 1);
  assert.match(b.gaps[0].detail, /--manual manual-a --live live-a --preview/);
});

test('P02 all collision edges are checked, including an earlier edge with unknown coverage', async t => {
  const f = fixture(); t.after(f.close);
  for (const mode of ['manual', 'live']) for (const suffix of ['a', 'z']) {
    account(f, { slug: `${mode}-${suffix}`, mode, from: '2020-01-01', to: '2020-01-31' });
  }
  account(f, { slug: 'unrelated-account', mask: '2468' });
  transaction(f, { slug: 'unrelated-account' });
  let documents = 0;
  const next = async gap => { documents++; return new Response(JSON.stringify({ answer: 'Document record.', gaps: [gap] })); };
  assert.equal((await ask(f, question, next)).code, undefined);
  assert.equal(documents, 1, 'all collisions outside the window allow retrieval');
  f.raw("UPDATE fin_account_coverage SET covered_from=NULL,covered_to=NULL,coverage_status='missing' WHERE account_slug IN ('manual-a','live-a')");
  const before = f.seen.length, blocked = await ask(f, question, next);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  assert.equal(blocked.code, 'ledger_account_link_required'); assert.equal(documents, 1);
  assert.match(blocked.gaps[0].detail, /--manual manual-a --live live-a --preview/);
  const selected = await ask(f, 'How much money came in September 2026 for account ending 2468?', next);
  assert.equal(selected.ledger.accounts[0].credits_minor, 123450);
  assert.equal(documents, 1);
  const raw = '{"answer":"Human record", "gaps":[]}';
  const response = new Response(raw);
  const readCount = f.seen.length;
  assert.equal(await withLedgerAnswer({ env: f.env, question: 'How do I balance work and rest?', now: NOW }, async gap => {
    documents++; assert.equal(gap, null); return response;
  }), response);
  assert.equal(await response.text(), raw); assert.equal(documents, 2);
  assert.equal(f.seen.length, readCount, 'non-ledger questions perform no ledger reads');
});

test('N03 coverage controls keep overlapping and unknown collisions closed, outside windows open', async t => {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual' }); account(f);
  let documents = 0;
  const next = async gap => { documents++; return new Response(JSON.stringify({ answer: 'Document record.', gaps: [gap] })); };
  assert.equal((await ask(f, question, next)).code, 'ledger_account_link_required');
  assert.equal(documents, 0);
  f.raw("UPDATE fin_account_coverage SET covered_from=NULL,covered_to=NULL,coverage_status='missing' WHERE account_slug='manual-account'");
  assert.equal((await ask(f, question, next)).code, 'ledger_account_link_required');
  assert.equal(documents, 0);
  const outside = await ask(f, 'How much money came in January 2020?', next);
  assert.equal(outside.code, undefined); assert.equal(documents, 1);
  assert.equal(outside.gaps[0].reason, 'period_outside_coverage');
});

test('P02 real Think route: historical collisions cannot bypass the unresolved live collision', async t => {
  let drafts = 0, verifiers = 0;
  const answer = 'Income was USD 1234.50 in September 2026 [1].';
  const f = await createProductFixture({ env: { ADMIN_KEY: randomBytes(32).toString('hex'),
    SESSION_SIGNING_KEY: randomBytes(32).toString('hex'), AI: { async run(model, input) {
      if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      if (String(input.messages?.[0]?.content).includes('verify a proposed answer')) {
        verifiers++; return { response: { supported: true, complete: true, evidence: [1], reason: 'synthetic primary record' } };
      }
      drafts++; return { response: answer };
    } } } });
  t.after(f.close);
  f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','gmail','ready','2026-09-30')");
  const ingested = await f.post('/api/admin/brain/ingest/batch', { docs: [{ source_type: 'records', source_id: 'synthetic-income',
    title: 'Income record', content: 'Income was USD 1234.50 in September 2026.', occurred_at: '2026-09-30',
    date_reliable: true, date_source: 'fixture:record_date', text_source: 'native', text_reliable: true }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(ingested.status, 200); assert.equal((await ingested.json()).results[0].status, 'created');
  f.env.VECTORIZE.query = async () => ({ matches: f.rows('SELECT chunk_uid AS id FROM chunks') });
  const read = () => f.post('/api/rag/think', { q: 'How much money came in September 2026?' }, { 'X-Admin-Key': f.env.ADMIN_KEY }).then(r => r.json());
  const ordinary = await read();
  assert.equal(ordinary.answer, answer); assert.equal(ordinary.evidence_gate.supported, true);
  assert.ok(ordinary.results.length); assert.equal(drafts, 1); assert.equal(verifiers, 1);
  drafts = 0; verifiers = 0;
  f.raw("INSERT INTO fin_entities (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('owner-company','Owner company','business','owned','owner_stated','confirmed',?)", NOW);
  account(f, { slug: 'manual-a', mode: 'manual' }); account(f, { slug: 'live-a' });
  transaction(f, { slug: 'manual-a', uid: 'manual-copy' }); transaction(f, { slug: 'live-a', uid: 'live-copy' });
  const control = await read(); assert.equal(control.code, 'ledger_account_link_required');
  assert.equal(drafts, 0); assert.equal(verifiers, 0);
  account(f, { slug: 'manual-z', mode: 'manual', from: '2020-01-01', to: '2020-01-31' });
  account(f, { slug: 'live-z', from: '2020-01-01', to: '2020-01-31' });
  const before = f.seen.sql.length, b = await read();
  assert.ok(f.seen.sql.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  // The inventory read above proves the refusal decision was reached.
  assert.equal(drafts, 0); assert.equal(verifiers, 0);
  t.diagnostic(JSON.stringify({ answer: b.answer, supported: b.evidence_gate.supported, gap: b.gaps[0]?.reason, drafts, verifiers }));
  assert.equal(b.code, 'ledger_account_link_required');
  assert.equal(b.answer, null);
});

test('Q01: a human virtual assistant is a role, not an AI authorship disclosure', async t => {
  for (const content of [
    'The invoice was prepared by a virtual assistant, a human contractor working remotely. Card ending 4242 charged USD 120.00.',
    'The invoice was drafted by a virtual assistant who is a human member of the team. Card ending 4242 charged USD 120.00.',
  ]) {
    const b = await documentAnswer(t, { content });
    assert.equal(b.results[0].lineage.status, 'unknown', content);
    assert.equal(b.evidence_gate.supported, true, content);
  }
  const b = await documentAnswer(t, { title: 'Virtual assistant memo' });
  assert.equal(b.evidence_gate.supported, true);
});

test('Q02: explicit "made with" AI disclosures still demote, a human payment made by an agent does not', async t => {
  for (const input of [
    { content: 'This report was made with ChatGPT. Card ending 4242 charged USD 120.00.' },
    { title: 'Report made with ChatGPT' },
    { title: 'AI-made invoice' },
  ]) {
    const b = await documentAnswer(t, input);
    assert.equal(b.results[0].lineage.kind, 'agent_derived', JSON.stringify(input));
    assert.equal(b.answer, null); assert.equal(b.evidence_gate.supported, false);
  }
  const human = await documentAnswer(t, { content: 'The payment was made by an agent at the bank branch. Card ending 4242 charged USD 120.00.' });
  assert.equal(human.evidence_gate.supported, true);
});
