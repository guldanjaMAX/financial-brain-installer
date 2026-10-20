// Partner review (gate-speed lens). Every name, amount and description here
// is made up. Each PR-S test is expected to FAIL on the reviewed HEAD; each
// paired control is expected to PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { createInflowAttributor, payerRegistry } from '../src/lib/ledger-attribution.js';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

const now = Date.parse(NOW);

function acmeLedger(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('acme','Acme Widgets LLC','Acme','business','owned','owner_stated','confirmed',?)`, NOW);
  return f;
}

function addSavings(f) {
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('fixture-savings','owner','savings','asset','5678','live','feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('fixture-savings','complete','2024-01-01','2026-10-12',?,'feed','bank-feed:fixture-feed','confirmed',?)`, NOW, NOW);
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
    VALUES ('savings-unknown','fixture-savings','2026-10-06',99900,'inflow','Interest and other',NULL,'feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
}

// ---------------------------------------------------------------- PR-S1
test('PR-S1 payer name followed by a date refuses; the selector becomes "acme on"', async t => {
  const f = acmeLedger(t);
  f.add('receipt', 'FROM: Acme', null);
  const question = 'Did the payment from Acme on October 5 arrive?';
  const body = await f.ask(question);
  assert.equal(body.ledger?.kind, 'payment', 'ledger routing reached');
  assert.equal(body.ledger.payer_selector_ambiguous, undefined, 'a registered payer must not be refused: ' + body.answer);
  assert.equal(body.ledger.found, true);
  const intent = classifyLedgerQuestion(question, { now });
  assert.equal(intent.counterparty, 'acme', 'the date preposition must not join the payer selector');
});

test('PR-S1 control: same payer and date in the other word order answers', async t => {
  const f = acmeLedger(t);
  f.add('receipt', 'FROM: Acme', null);
  const body = await f.ask('Did the payment from Acme arrive on October 5?');
  assert.equal(body.ledger.found, true);
  assert.equal(body.evidence_gate.complete, true);
});

// ---------------------------------------------------------------- PR-S2
const S2_LONG = 'How much income came from Acme in my checking account in October 2026?';
test('PR-S2 account words are swallowed into the payer slot: scope widens to every account and the answer refuses', async t => {
  const f = acmeLedger(t);
  addSavings(f);
  f.add('receipt', 'FROM: Acme', null);
  const body = await f.ask(S2_LONG);
  assert.equal(body.ledger?.kind, 'merchant', 'ledger routing reached');
  assert.deepEqual(body.ledger.accounts.map(a => a.account_mask), ['1234'], 'savings must not enter a checking question');
  assert.equal(body.ledger.total_minor, 2500);
  const intent = classifyLedgerQuestion(S2_LONG, { now });
  assert.equal(intent.accountKind, 'checking', 'the checking selector must survive');
  assert.equal(intent.match, 'acme');
});

test('PR-S2 control: the same question with "ending 1234" keeps the account and answers', async t => {
  const f = acmeLedger(t);
  addSavings(f);
  f.add('receipt', 'FROM: Acme', null);
  const body = await f.ask('How much income came from Acme in my checking account ending 1234 in October 2026?');
  assert.deepEqual(body.ledger.accounts.map(a => a.account_mask), ['1234']);
  assert.equal(body.ledger.total_minor, 2500);
  assert.equal(body.evidence_gate.complete, true);
});

// ---------------------------------------------------------------- PR-S3
const FIELDS = ['ORIG CO NAME: Acme Widgets LLC', 'ORIG ID: 1234567890', 'DESC DATE: 261005', 'CO ENTRY DESCR: PAYMENT',
  'SEC: CCD', 'TRACE NUMBER: 021000021234567', 'EFFECTIVE DATE: 2026-10-05', 'REFERENCE: INV-2026-10-05-0001',
  'MEMO: october-services', 'INDIVIDUAL ID: ABC123',
  'BENEFICIARY: Sample Holdings Group of Phoenix Arizona Family Trust Account', 'SETTLEMENT DATE: 10/05/2026'];
const COMMA_DESCRIPTION = FIELDS.join(', ');
const SEMI_DESCRIPTION = FIELDS.join('; ');
const S3_QUESTION = 'How much income came from Acme Widgets LLC in October 2026?';

test('PR-S3 a valid comma-separated sender line exhausts the parser budget and a registered payer becomes unknown', async t => {
  assert.ok([...COMMA_DESCRIPTION].length <= 512 && FIELDS.length <= 12, 'input is inside the declared grammar limits');
  const f = acmeLedger(t);
  f.add('receipt', COMMA_DESCRIPTION, null);
  const body = await f.ask(S3_QUESTION);
  assert.equal(body.ledger?.kind, 'merchant', 'ledger routing reached');
  assert.equal(body.ledger.total_minor, 2500, 'the deposit names a registered sender: ' + body.answer);
  const registry = payerRegistry([{ entity_slug: 'acme', legal_name: 'Acme Widgets LLC' }]);
  const decision = createInflowAttributor(registry)({ id: 1, direction: 'inflow', description: COMMA_DESCRIPTION });
  assert.equal(decision.evidence.parser.refusal, null, 'refusal reason: ' + decision.evidence.parser.refusal);
  assert.equal(decision.state, 'confirmed');
});

test('PR-S3 control: the same fields separated by semicolons confirm and total', async t => {
  const registry = payerRegistry([{ entity_slug: 'acme', legal_name: 'Acme Widgets LLC' }]);
  const decision = createInflowAttributor(registry)({ id: 1, direction: 'inflow', description: SEMI_DESCRIPTION });
  assert.equal(decision.state, 'confirmed');
  assert.ok(decision.evidence.parser.steps < 4000);
  const f = acmeLedger(t);
  f.add('receipt', SEMI_DESCRIPTION, null);
  const body = await f.ask(S3_QUESTION);
  assert.equal(body.ledger.total_minor, 2500);
});

// ---------------------------------------------------------------- PR-S4
function stepsFor(description, rows, options) {
  const registry = payerRegistry([{ entity_slug: 'acme', legal_name: 'Acme Widgets LLC' }]);
  const decide = createInflowAttributor(registry, options);
  const seen = new Set();
  let first, hits = 0, steps = 0;
  for (let i = 0; i < rows; i++) {
    const result = decide({ id: i, direction: 'inflow', description });
    if (i === 0) first = result; else if (result === first) hits++;
    if (!seen.has(result)) { seen.add(result); steps += result.evidence.parser.steps; }
  }
  return { first, hits, steps };
}

test('PR-S4 a budget-exhausted parse is never cached: identical rows each spend the full step budget', () => {
  // S3 now requires this line to complete at the normal limit. Inject a
  // smaller row budget to keep the exhaustion/cache decision under test.
  const run = stepsFor(COMMA_DESCRIPTION, 20, { stepLimit: 1024 });
  assert.equal(run.first.evidence.parser.refusal, 'operation-limit', 'budget-exhaustion decision reached');
  assert.equal(run.hits, 19, 'identical normalized descriptions should share one decision');
  assert.ok(run.steps <= 32768, `answer-level parser work grew with row count: ${run.steps} steps for 20 identical rows`);
});

test('PR-S4 control: a complete parse of an identical description is cached once', () => {
  const run = stepsFor(SEMI_DESCRIPTION, 20);
  assert.equal(run.first.state, 'confirmed');
  assert.equal(run.hits, 19);
  assert.ok(run.steps <= 32768);
});

// ---------------------------------------------------------------- PR-S5
const ADDRESS = '100 Example Road, Example City, AZ 85001';
function addressFact(question) {
  const results = [{ title: 'Address change', snippet: `[Address change] From: Example Contact <owner@example.invalid>\nTo: service@example.invalid\nDate: 2026-03-12\nSubject: Address change\n\nI have moved to ${ADDRESS}.` }];
  const docs = [{ n: 1, ref: 'gmail:move', source_kind: 'gmail', date_source: 'email_header', document_date: Date.parse('2026-03-12'),
    date_reliable: true, text_source: 'native', text_reliable: true, lineage: { status: 'known', kind: 'source_record' },
    authority: { eligible: true, tier: 'T1' } }];
  return entityFactAnswer({ question, results, docs, owner: 'Example Contact', now: Date.parse('2026-10-12T00:00:00Z') });
}

test('PR-S5 a typographic apostrophe misses the no-LLM owner-address answer', () => {
  const fact = addressFact('What’s my current home address?');
  assert.equal(fact?.method, 'dated_owner_address', 'iOS-style apostrophe falls to answer + verifier LLM stages');
});

test('PR-S5 control: the ASCII apostrophe takes the no-LLM owner-address answer', () => {
  const fact = addressFact("What's my current home address?");
  assert.equal(fact?.method, 'dated_owner_address');
  assert.ok(fact.answer.includes(ADDRESS));
});

test('registry hardening: a confirmed non-owned row cannot register a payer', async t => {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('outside','Outside Supplier','business','counterparty','owner_stated','confirmed',?)`, NOW);
  f.add('outside-receipt', 'FROM: Outside Supplier', null);
  const question = 'How much income came from Outside Supplier in October 2026?';
  const observed = await f.ask(question);
  assert.ok(f.calls.some(sql => /SELECT entity_slug,legal_name,display_label/.test(sql)), 'identity snapshot reached');
  assert.equal(observed.ledger.inflow_total_minor, 2500, 'nonempty receipt snapshot reached');
  assert.equal(observed.ledger.total_minor, 2500);
  assert.equal(observed.payer_evidence[0].type, 'statement_sender');
  assert.equal(observed.evidence_gate.complete, true);
  f.raw("UPDATE fin_entities SET relationship='owned' WHERE entity_slug='outside'");
  const registered = await f.ask(question);
  assert.equal(registered.ledger.total_minor, 2500);
  assert.equal(registered.evidence_gate.complete, true);
});
