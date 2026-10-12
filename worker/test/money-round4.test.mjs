import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fixture, account, transaction, NOW } from './fixtures/money-fix/fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { createProductFixture } from './product-contract-fixture.mjs';
import { evidenceLineageFor, isAgentDerivedArtifact } from '../src/lib/evidence-lineage.js';

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
const total = (b, k) => b.ledger.accounts.reduce((n, a) => n + a[k], 0);
function add(f, { description, payee = null, ...args }) {
  transaction(f, args);
  f.raw('UPDATE fin_transactions SET description=?,payee=? WHERE txn_uid=?', description, payee, args.uid);
}
function pairFixture(t) {
  const f = fixture(); t.after(f.close); account(f); account(f, { slug: 'second-account', mask: '8765' });
  add(f, { uid: 'out', amount: 50000, direction: 'outflow', description: 'Transfer to account 8765' });
  add(f, { uid: 'in', slug: 'second-account', amount: 50000, direction: 'inflow', description: 'Bank credit' });
  return f;
}
function collision(f, extra = {}) {
  account(f, { slug: 'manual-account', mode: 'manual', ...extra });
  account(f, extra);
}

async function documentAnswer(t, { title = 'Card statement', content = 'Card ending 4242 charged USD 120.00.', metadata = {}, sourceKind = 'gmail', dateReliable = true } = {}) {
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
  f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records',?,'ready','2026-10-10')", sourceKind);
  const ingested = await f.post('/api/admin/brain/ingest/batch', { docs: [{ source_type: 'records', source_id: 'synthetic-record',
    title, content, occurred_at: '2026-10-10', date_reliable: dateReliable, date_source: dateReliable ? 'fixture:record_date' : 'fallback', text_source: 'native', text_reliable: true, metadata }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(ingested.status, 200); assert.equal((await ingested.json()).results[0].status, 'created');
  f.env.VECTORIZE.query = async () => ({ matches: f.rows('SELECT chunk_uid AS id FROM chunks') });
  const response = await f.post('/api/rag/think', { q: 'What did card ending 4242 charge in the last 60 days?' }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(response.status, 200); const body = await response.json();
  assert.ok(body.results.length); assert.equal(drafts, 1); assert.equal(verifiers, 1);
  assert.equal(body.evidence_gate.error, undefined);
  return body;
}

test('N01: a generic account label in an ordinary fee must not remove an expense and receipt', async t => {
  const f = pairFixture(t);
  f.raw("UPDATE fin_accounts SET label='Checking' WHERE account_slug='second-account'");
  f.raw("UPDATE fin_transactions SET amount_minor=1200,description='Monthly maintenance fee',payee='Bank One' WHERE txn_uid='out'");
  f.raw("UPDATE fin_transactions SET amount_minor=1200,description='Customer invoice receipt',payee='Outside Customer' WHERE txn_uid='in'");
  const control = await ask(f);
  assert.equal(control.ledger.candidate_transfer_count, 0);
  assert.equal(total(control, 'debits_minor'), 1200); assert.equal(total(control, 'credits_minor'), 1200);
  f.raw("UPDATE fin_transactions SET description='Checking monthly maintenance fee' WHERE txn_uid='out'");
  const before = f.seen.length, b = await ask(f);
  assert.ok(f.seen.slice(before).some(s => s.includes('JOIN fin_transactions')));
  assert.equal(b.evidence_gate.complete, true);
  t.diagnostic(JSON.stringify({ candidates: b.ledger.candidate_transfer_count, debits: total(b, 'debits_minor'), credits: total(b, 'credits_minor') }));
  assert.equal(total(b, 'debits_minor'), 1200, 'account product wording does not establish a transfer');
  assert.equal(total(b, 'credits_minor'), 1200);
  assert.equal(b.ledger.candidate_transfer_count, 0, 'both explicit outside payees rule out an own-account candidate');
});

test('N01 variant: mentioning the originating card does not identify the other account', async t => {
  const f = pairFixture(t);
  f.raw("UPDATE fin_transactions SET description='Outside supplier purchase',payee='Outside Supplier' WHERE txn_uid='out'");
  f.raw("UPDATE fin_transactions SET description='Customer invoice receipt',payee='Outside Customer' WHERE txn_uid='in'");
  assert.equal((await ask(f)).ledger.candidate_transfer_count, 0);
  f.raw("UPDATE fin_transactions SET description='Customer invoice receipt paid from card ending 4321' WHERE txn_uid='in'");
  const before = f.seen.length, b = await ask(f);
  assert.ok(f.seen.slice(before).some(s => s.includes('JOIN fin_transactions')));
  t.diagnostic(JSON.stringify({ candidates: b.ledger.candidate_transfer_count, debits: total(b, 'debits_minor'), credits: total(b, 'credits_minor') }));
  assert.equal(b.ledger.candidate_transfer_count, 0, 'a card mask cannot identify an owned checking account');
  assert.equal(total(b, 'credits_minor'), 50000); assert.equal(total(b, 'debits_minor'), 50000);
});

test('R03 control: selecting an unrelated account still reaches the covered ledger', async t => {
  const f = fixture(); t.after(f.close); collision(f);
  account(f, { slug: 'unrelated-account', mask: '2468' });
  transaction(f, { slug: 'unrelated-account' });
  const blocked = await ask(f); assert.equal(blocked.code, 'ledger_account_link_required');
  const before = f.seen.length, b = await ask(f, 'How much money came in September 2026 for account ending 2468?');
  assert.ok(f.seen.slice(before).some(s => s.includes('JOIN fin_transactions')));
  assert.equal(total(b, 'credits_minor'), 123450);
});

test('N03: unrelated document questions must not be stopped by an old account collision', async t => {
  const f = fixture(); t.after(f.close); let documents = 0;
  const q = 'What are the office expense reimbursement rules?';
  const next = async () => { documents++; return new Response(JSON.stringify({ answer: 'Receipts are required for reimbursement.', gaps: [] })); };
  const control = await ask(f, q, next);
  assert.equal(control.answer, 'Receipts are required for reimbursement.'); assert.equal(documents, 1);
  collision(f, { from: '2020-01-01', to: '2020-01-31' });
  const before = f.seen.length, b = await ask(f, q, next);
  assert.equal(f.seen.length, before, 'unsupported intent bypasses ledger reads');
  t.diagnostic(JSON.stringify({ code: b.code, documentCalls: documents, answer: b.answer }));
  assert.equal(b.answer, control.answer, 'this question does not ask for bank money');
  assert.equal(documents, 2, 'ordinary document retrieval must run');
  assert.deepEqual(b, control);
});

test('N03 variant: a document-only historical question outside feed coverage still needs fallback', async t => {
  const f = fixture(); t.after(f.close); let documents = 0;
  const q = 'What invoice was paid in January 2020?';
  const next = async () => { documents++; return new Response(JSON.stringify({ answer: 'The archived invoice is the supporting record.', gaps: [] })); };
  assert.ok((await ask(f, q, next)).answer); assert.equal(documents, 1);
  collision(f);
  const before = f.seen.length, b = await ask(f, q, next);
  assert.equal(f.seen.length, before, 'unsupported intent bypasses ledger reads');
  assert.equal(documents, 2, 'a 2026 bank collision cannot refuse 2020 document lookup');
  assert.ok(b.answer);
});

test('N03 real route: an expense policy remains answerable with an unrelated historical collision', async t => {
  let drafts = 0, verifiers = 0;
  const answer = 'Receipts are required for reimbursement [1].';
  const f = await createProductFixture({ env: { ADMIN_KEY: randomBytes(32).toString('hex'),
    SESSION_SIGNING_KEY: randomBytes(32).toString('hex'), AI: { async run(model, input) {
      if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      if (String(input.messages?.[0]?.content).includes('verify a proposed answer')) {
        verifiers++; return { response: { supported: true, complete: true, evidence: [1], reason: 'fixture policy' } };
      }
      drafts++; return { response: answer };
    } } } });
  t.after(f.close);
  f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','gmail','ready','2026-10-10')");
  const ingested = await f.post('/api/admin/brain/ingest/batch', { docs: [{ source_type: 'records', source_id: 'synthetic-policy',
    title: 'Office expense reimbursement rules', content: 'Receipts are required for reimbursement.', occurred_at: '2026-10-10',
    date_reliable: true, date_source: 'fixture:record_date', text_source: 'native', text_reliable: true }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(ingested.status, 200); assert.equal((await ingested.json()).results[0].status, 'created');
  f.env.VECTORIZE.query = async () => ({ matches: f.rows('SELECT chunk_uid AS id FROM chunks') });
  const read = () => f.post('/api/rag/think', { q: 'What are the office expense reimbursement rules?' }, { 'X-Admin-Key': f.env.ADMIN_KEY }).then(r => r.json());
  const control = await read(); assert.equal(control.answer, answer); assert.ok(control.results.length);
  assert.equal(drafts, 1); assert.equal(verifiers, 1);
  f.raw("INSERT INTO fin_entities (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('owner-company','Owner company','business','owned','owner_stated','confirmed',?)", NOW);
  collision(f, { from: '2020-01-01', to: '2020-01-31' });
  const before = f.seen.sql.length, b = await read();
  assert.equal(f.seen.sql.slice(before).filter(sql => sql.includes('FROM fin_accounts')).length, 0, 'unsupported intent bypasses ledger inventory');
  t.diagnostic(JSON.stringify({ code: b.code, drafts, verifiers, results: b.results.length }));
  assert.equal(b.answer, answer, 'unrelated ledger identity cannot block stored policy evidence');
  assert.equal(drafts, 2); assert.equal(verifiers, 2);
});

test('R04 control: Generated by ChatGPT in the body demotes while ordinary AI discussion passes', async t => {
  const human = await documentAnswer(t, { content: 'Invoice for AI tools. Card ending 4242 charged USD 120.00.' });
  assert.equal(human.evidence_gate.supported, true);
  const generated = await documentAnswer(t, { content: 'Generated by ChatGPT. Card ending 4242 charged USD 120.00.' });
  assert.equal(generated.answer, null); assert.equal(generated.evidence_gate.supported, false);
});

test('N02: Generated with ChatGPT in the body is explicit generated authorship', async t => {
  const control = await documentAnswer(t, { content: 'Generated by ChatGPT. Card ending 4242 charged USD 120.00.' });
  assert.equal(control.answer, null); assert.equal(control.evidence_gate.supported, false);
  const b = await documentAnswer(t, { content: 'Generated with ChatGPT. Card ending 4242 charged USD 120.00.' });
  t.diagnostic(JSON.stringify({ lineage: b.results[0].lineage.kind, tier: b.results[0].authority.tier, supported: b.evidence_gate.supported }));
  assert.equal(b.answer, null); assert.equal(b.evidence_gate.supported, false);
});


test('N01 genuine own-account pair is retained, marked and given a conditional figure in every view', async t => {
  const f = pairFixture(t);
  const original = f.rows('SELECT * FROM fin_transactions');
  const before = f.seen.length, body = await ask(f);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(total(body, 'debits_minor'), 50000); assert.equal(total(body, 'credits_minor'), 50000);
  assert.equal(body.ledger.includes_own_transfers, true);
  assert.equal(body.ledger.matched_transfer_count, 0); assert.equal(body.ledger.candidate_transfer_count, 1);
  const pair = body.ledger.transfers[0];
  assert.equal(pair.candidate, true); assert.equal(pair.excluded_from_totals, false);
  assert.equal(pair.amount_minor, 50000);
  assert.equal(pair.outgoing.account_mask, '4321'); assert.equal(pair.incoming.account_mask, '8765');
  assert.equal(pair.outgoing.posted_on, '2026-09-15'); assert.equal(pair.incoming.posted_on, '2026-09-15');
  assert.match(pair.reason, /equal amounts.*opposite directions.*three days.*mask/);
  assert.match(body.answer, /Possible moves between your own accounts/);
  assert.match(body.answer, /If these are transfers between your own accounts.*credits \$0\.00; debits \$0\.00/);
  assert.deepEqual(body.ledger.if_own_transfers.accounts.map(a => [a.credits_minor, a.debits_minor]), [[0, 0], [0, 0]]);
  f.raw("UPDATE fin_transactions SET category='SOFTWARE',category_basis_state='confirmed',payee='Cloud Tools' WHERE txn_uid='out'");
  for (const q of ['What were my 3 largest expenses in September 2026?',
    'Show my recent deposits in September 2026?', 'How much did I spend by category in September 2026?',
    'How much did I spend at Cloud Tools in September 2026?']) {
    const readCount = f.seen.length, b = await ask(f, q);
    assert.ok(f.seen.slice(readCount).some(sql => sql.includes('JOIN fin_transactions')));
    assert.equal(b.ledger.candidate_transfer_count, 1); assert.equal(b.ledger.if_own_transfers.total_minor, 0);
    if (b.ledger.rows) {
      assert.deepEqual(b.ledger.rows.map(row => [row.amount_minor, row.possible_own_transfer]), [[50000, true]]);
      assert.match(b.answer, /possible move between your own accounts, included/);
    } else {
      assert.equal(b.ledger.total_minor, 50000); assert.equal(b.ledger.groups[0].total_minor, 50000);
      assert.equal(b.ledger.groups[0].possible_transfer_citations.length, 1);
      assert.equal(b.ledger.groups[0].if_own_transfers_total_minor, 0);
    }
  }
  // Only fixture setup changed categories; the answers never write money rows.
  assert.deepEqual(f.rows('SELECT txn_uid,amount_minor FROM fin_transactions').map(row => ({ ...row })), original.map(({ txn_uid, amount_minor }) => ({ txn_uid, amount_minor })));
});

test('N01 conflicting card kind rejects a candidate even when the other leg names its counterpart', async t => {
  const f = pairFixture(t);
  assert.equal((await ask(f)).ledger.candidate_transfer_count, 1);
  f.raw("UPDATE fin_transactions SET amount_minor=500");
  f.raw("UPDATE fin_transactions SET description='Receipt from card ending 4321' WHERE txn_uid='in'");
  const before = f.seen.length, b = await ask(f);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(total(b, 'debits_minor'), 500); assert.equal(total(b, 'credits_minor'), 500);
  assert.equal(b.ledger.candidate_transfer_count, 0);
});

test('N01 same-cent outside-payee collision is retained and has no own-account candidate', async t => {
  const f = pairFixture(t);
  f.raw("UPDATE fin_transactions SET description='Transfer to outside supplier',payee='Outside Supplier' WHERE txn_uid='out'");
  f.raw("UPDATE fin_transactions SET amount_minor=50001,description='Transfer from outside customer',payee='Outside Customer' WHERE txn_uid='in'");
  assert.equal(total(await ask(f), 'credits_minor'), 50001);
  f.raw("UPDATE fin_transactions SET amount_minor=50000 WHERE txn_uid='in'");
  const before = f.seen.length, b = await ask(f);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(total(b, 'debits_minor'), 50000); assert.equal(total(b, 'credits_minor'), 50000);
  assert.equal(b.ledger.candidate_transfer_count, 0);
});

test('N02 explicit disclosure grammar covers verbs, prepositions, AI terms and title nouns', () => {
  const verbs = ['generated', 'created', 'written', 'drafted', 'prepared', 'produced', 'composed', 'summarised', 'summarized', 'made'];
  const prepositions = ['by', 'with', 'using', 'via', 'through', 'in', 'from'];
  const terms = ['AI', 'A.I.', 'ChatGPT', 'GPT', 'GPT-4', 'OpenAI', 'Claude', 'Anthropic', 'Gemini', 'Copilot', 'Grok', 'Perplexity', 'LLM', 'Codex', 'an assistant', 'an AI assistant', 'an agent', 'an AI agent'];
  for (const verb of verbs) for (const prep of prepositions) for (const term of terms) {
    const text = `${verb} ${prep} ${term}: financial record`;
    assert.equal(isAgentDerivedArtifact({ title: text }), true, text);
    assert.equal(isAgentDerivedArtifact({ title: 'Email', text }), true, text);
  }
  for (const term of terms) for (const noun of ['summary', 'notes', 'draft', 'memo']) {
    assert.equal(isAgentDerivedArtifact({ title: `${term} ${noun}` }), true, `${term} ${noun}`);
  }
  for (const title of ['AI-generated memo', 'AI-written statement', 'AI-drafted report', 'assistant-written memo']) {
    assert.equal(evidenceLineageFor({ title, authority_meta: { evidence_lineage: { version: 1, kind: 'source_record' } } }).lineage.kind, 'agent_derived');
  }
  for (const text of ['Our AI tools invoice is $120.', 'We use ChatGPT for drafts, invoice attached.',
    'Generated with artificial flowers.', 'Created using cardboard.']) {
    assert.equal(isAgentDerivedArtifact({ title: 'Human email', text }), false, text);
  }
  assert.equal(isAgentDerivedArtifact({ text: ' '.repeat(500) + 'Generated with ChatGPT' }), false, 'disclosure scan is bounded');
  assert.equal(isAgentDerivedArtifact({ text: ' '.repeat(470) + 'Generated with ChatGPT' }), true);
});

test('N02 common disclosures are vetoed through real ingestion and Think with ordinary-message controls', async t => {
  for (const input of [
    { content: 'Generated with ChatGPT. Card ending 4242 charged USD 120.00.' },
    { title: 'Created using Claude' },
    { content: 'Drafted by an AI assistant. Card ending 4242 charged USD 120.00.' },
    { title: 'Made via A.I.' }, { title: 'Codex memo' },
  ]) {
    const b = await documentAnswer(t, input);
    assert.equal(b.answer, null); assert.equal(b.evidence_gate.supported, false);
    assert.equal(b.results[0].lineage.kind, 'agent_derived'); assert.equal(b.results[0].authority.tier, 'T4');
  }
  for (const input of [{}, { sourceKind: 'imessage' },
    { content: 'Our AI tools invoice is $120. Card ending 4242 charged USD 120.00.' },
    { content: 'We use ChatGPT for drafts, invoice attached. Card ending 4242 charged USD 120.00.' }]) {
    const b = await documentAnswer(t, input);
    assert.equal(b.answer, 'Card ending 4242 charged USD 120.00 [1].');
    assert.equal(b.evidence_gate.supported, true); assert.equal(b.results[0].lineage.status, 'unknown');
  }
  const unreliable = await documentAnswer(t, { dateReliable: false });
  assert.equal(unreliable.answer, null); assert.equal(unreliable.evidence_gate.supported, false);
});

test('N03 a supported question outside the collision window uses document fallback with coverage guidance', async t => {
  const f = fixture(); t.after(f.close); collision(f);
  let calls = 0;
  const next = async gap => { calls++; return new Response(JSON.stringify({ answer: 'Archived record.', gaps: [gap] })); };
  const blocked = await ask(f, question, next);
  assert.equal(blocked.code, 'ledger_account_link_required'); assert.equal(calls, 0);
  const before = f.seen.length, b = await ask(f, 'How much money came in January 2020?', next);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  assert.equal(calls, 1); assert.equal(b.answer, 'Archived record.');
  assert.equal(b.gaps[0].reason, 'period_outside_coverage'); assert.equal(b.code, undefined);
});

test('N03 unsupported and non-ledger questions preserve exact response identity, bytes and headers', async t => {
  const f = fixture(); t.after(f.close); collision(f);
  assert.equal((await ask(f)).code, 'ledger_account_link_required', 'positive collision decision reached');
  for (const question of ['What are the office expense reimbursement rules?', 'How do I balance work and rest?', 'What invoice was paid in January 2020?']) {
    const raw = '{"answer":"Human record", "gaps":[]}';
    const expected = new Response(raw, { headers: { 'X-Document-Result': 'preserved' } });
    let calls = 0; const before = f.seen.length;
    const actual = await withLedgerAnswer({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner' }, async gap => {
      calls++; assert.equal(gap, null); return expected;
    });
    assert.equal(calls, 1); assert.equal(actual, expected); assert.equal(await actual.text(), raw);
    assert.equal(actual.headers.get('X-Document-Result'), 'preserved'); assert.equal(f.seen.length, before);
  }
});


test('N01 recurring candidate legs remain counted even with a proposed transfer category', async t => {
  const f = fixture(); t.after(f.close); account(f); account(f, { slug: 'second-account', mask: '8765' });
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-07-01'");
  for (const [i, day] of ['2026-07-15', '2026-08-15', '2026-09-15'].entries()) {
    add(f, { uid: `out-${i}`, day, amount: 1000, direction: 'outflow', description: 'Transfer to account 8765' });
    add(f, { uid: `in-${i}`, slug: 'second-account', day, amount: 1000, direction: 'inflow', description: 'Transfer from account 4321' });
  }
  const q = 'Show my recurring charges in Q3';
  const control = await ask(f, q);
  assert.equal(control.ledger.recurring.length, 1); assert.equal(control.ledger.monthly_total_minor, 1000);
  f.raw("UPDATE fin_transactions SET category='TRANSFER_OUT_ACCOUNT_TRANSFER',category_basis_state='proposed' WHERE direction='outflow'");
  const before = f.seen.length, b = await ask(f, q);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(b.ledger.candidate_transfer_count, 3); assert.equal(b.ledger.recurring.length, 1);
  assert.equal(b.ledger.recurring[0].possible_transfer_citations.length, 3);
  assert.equal(b.ledger.monthly_total_minor, 1000); assert.equal(b.ledger.if_own_transfers.monthly_total_minor, 0);
  assert.match(b.answer, /If these are transfers between your own accounts.*estimated monthly total: \$0\.00/);
});
