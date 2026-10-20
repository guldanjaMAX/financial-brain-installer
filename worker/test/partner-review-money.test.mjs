// Independent partner review (money lens). Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');

function account(slug, mask, overrides = {}) {
  return { id: mask, account_slug: slug, entity_slug: 'owner-household', mask, account_kind: 'checking',
    institution: 'Example Bank', label: `Checking ${mask}`, external_ref: null, source_feed: null, currency: 'USD',
    feed_mode: 'manual', balance_role: 'asset', basis_state: 'confirmed', coverage_status: 'complete',
    covered_from: '2026-01-01', covered_to: '2026-10-14', coverage_basis: 'confirmed', last_synced_at: null,
    coverage_review_required: 0, empty_provider_from: null, link_manual: null, link_live: null, link_identity: null,
    ...overrides };
}

let nextId = 1;
function txn(accountSlug, posted_on, amount_minor, direction, fields = {}) {
  return { id: nextId++, account_slug: accountSlug, posted_on, amount_minor, direction, currency: 'USD',
    description: null, payee: null, category: null, category_basis_state: null, basis_state: 'confirmed',
    description_has_nul: 0, payee_has_nul: 0, export_overlap_review: 0, ...fields };
}

function mockEnv({ accounts, transactions, entities }) {
  const resultsFor = (sql, binds) => {
    if (sql.includes('FROM fin_accounts a')) return accounts;
    if (sql.includes('FROM fin_entities') && sql.includes('legal_name')) return entities.map(e => ({
      legal_name_has_nul: 0, display_label_has_nul: 0, display_label: null, ...e }));
    if (sql.includes('json_each(?1)')) {
      const mapping = JSON.parse(binds[0]);
      const [from, to, amount] = [binds[2], binds[3], binds[4]];
      return transactions.flatMap(t => {
        const m = mapping.find(x => x.slug === t.account_slug);
        if (!m) return [];
        if (t.posted_on && (t.posted_on < from || t.posted_on > to)) return [];
        if (amount !== null && !(t.amount_minor === amount && t.direction === 'inflow') && t.basis_state === 'confirmed' && t.posted_on) return [];
        return [{ ...t, source_account_slug: t.account_slug, effective_account_slug: m.effective, last_synced_at: m.last_synced_at }];
      });
    }
    throw new Error(`unexpected sql ${sql.slice(0, 80)}`);
  };
  const statement = sql => ({ sql, binds: [], bind(...binds) { return { ...this, binds }; },
    async all() { return { results: resultsFor(this.sql, this.binds) }; } });
  return { DB: { prepare: statement, batch: async list => list.map(s => ({ results: resultsFor(s.sql, s.binds) })) } };
}

async function ask(question, data) {
  let usedDocuments = false;
  const response = await withLedgerAnswer({ env: mockEnv(data), question, grantScope: { all: true },
    scopePrincipalKind: 'owner', now: NOW }, async () => {
    usedDocuments = true;
    return new Response(JSON.stringify({ mode: 'documents', answer: 'docs', gaps: [] }));
  });
  const body = await response.json();
  return { ...body, usedDocuments };
}

export { account, txn, mockEnv, ask, NOW };

const ACCOUNTS = [account('chk-1', '4321', { covered_to: '2026-10-15' })];
const deposit = fields => [txn('chk-1', '2026-09-20', 125000, 'inflow', fields)];
const lastThirty = name => `Did a payment from ${name} arrive in the last 30 days?`;
const september = name => `How much income from ${name} in September 2026?`;

// PR-M1: "Co Entry Descr" and "Entry Descr" are both grammar labels, so
// "Acme Co Entry Descr: ..." has two complete parses with different sender
// values ("Acme" and "Acme Co"). The phrase path keeps "Acme" and reports it
// as the sender with a complete evidence gate; the alternative is dropped.
test('PR-M1 ambiguous field boundary marks a shorter payer present', async () => {
  const body = await ask(lastThirty('Acme'), { accounts: ACCOUNTS, entities: [],
    transactions: deposit({ description: 'Orig Co Name: Acme Co Entry Descr: Payment SEC: CCD' }) });
  assert.equal(body.ledger.kind, 'payment', 'real payer decision reached');
  assert.equal(body.ledger.inflow_total_minor, 125000, 'nonempty receipt snapshot');
  assert.notEqual(body.ledger.found, true, 'sender could be "Acme Co"; presence of "Acme" is not proved');
  assert.equal(body.evidence_gate.complete, false);
});

test('PR-M1 control: unambiguous labelled sender is found', async () => {
  const body = await ask(lastThirty('Acme'), { accounts: ACCOUNTS, entities: [],
    transactions: deposit({ description: 'Orig Co Name: Acme Orig ID: 1234 Co Entry Descr: Payment SEC: CCD' }) });
  assert.equal(body.ledger.found, true);
  assert.equal(body.evidence_gate.complete, true);
});

// PR-M2: rows match registered names punctuation-insensitively, but question
// mentions are punctuation-literal. Leaving out the comma of a registered
// "Acme Widgets, LLC" finds no mention; the phrase fallback is then shadowed by
// the registry (the payee resolves to the registered slug, not the phrase), so
// the answer refuses although the exact bank payee is the registered company.
test('PR-M2 registered comma name asked without the comma refuses an exact payee', async () => {
  const data = { accounts: ACCOUNTS, transactions: deposit({ payee: 'ACME WIDGETS, LLC', description: 'ACH CREDIT' }),
    entities: [{ entity_slug: 'acme-widgets', legal_name: 'Acme Widgets, LLC' }] };
  const income = await ask(september('Acme Widgets LLC'), data);
  assert.equal(income.ledger.found, true, income.answer);
  assert.equal(income.ledger.total_minor, 125000);
  const payment = await ask(lastThirty('Acme Widgets LLC'), data);
  assert.equal(payment.ledger.found, true, payment.answer);
});

test('PR-M2 control: the same question with the registered comma answers', async () => {
  const data = { accounts: ACCOUNTS, transactions: deposit({ payee: 'ACME WIDGETS, LLC', description: 'ACH CREDIT' }),
    entities: [{ entity_slug: 'acme-widgets', legal_name: 'Acme Widgets, LLC' }] };
  const income = await ask(september('Acme Widgets, LLC'), data);
  assert.equal(income.ledger.found, true);
  assert.equal(income.ledger.total_minor, 125000);
  assert.equal((await ask(lastThirty('Acme Widgets, LLC'), data)).ledger.found, true);
});

// PR-M3: a short registered label cannot supply the full requested identity.
// The complete structured payee supplies its own exact evidence.
test('PR-M3 complete bounded payee outranks a registered substring', async () => {
  const body = await ask(lastThirty('Acme Industries Inc'), { accounts: ACCOUNTS,
    entities: [{ entity_slug: 'owner-co', legal_name: 'Acme Holdings LLC', display_label: 'Acme' }],
    transactions: deposit({ payee: 'Acme Industries Inc', description: 'ACH CREDIT' }) });
  // R7 allows the whole bounded field; the shorter alias is only similarity.
  assert.equal(body.ledger.kind, 'payment', 'payer decision reached');
  assert.equal(body.ledger.inflow_total_minor, 125000, 'nonempty receipt snapshot');
  assert.equal(body.ledger.found, true);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.citations.length, 1);
});

test('PR-M3 control: without the short label the exact payee is found', async () => {
  const body = await ask(lastThirty('Acme Industries Inc'), { accounts: ACCOUNTS,
    entities: [{ entity_slug: 'owner-co', legal_name: 'Acme Holdings LLC' }],
    transactions: deposit({ payee: 'Acme Industries Inc', description: 'ACH CREDIT' }) });
  assert.equal(body.ledger.found, true);
  assert.equal(body.evidence_gate.complete, true);
});

// PR-M4: the closed grammar accepts INDIVIDUAL ID / INDIVIDUAL NAME but not
// the common abbreviated IND ID / IND NAME labels, so a labelled ORIG CO NAME
// sender in that layout is unknown and the answer refuses.
const achLine = tail => `Orig Co Name: Acme Industries Orig ID: 1234 Desc Date: 260920 Co Entry Descr: Payment SEC: PPD Trace#: 5551234 ${tail}`;
test('PR-M4 abbreviated IND ID / IND NAME labels hide a labelled sender', async () => {
  const body = await ask(lastThirty('Acme Industries'), { accounts: ACCOUNTS, entities: [],
    transactions: deposit({ description: achLine('Ind ID: 55 Ind Name: Recipient Role') }) });
  assert.equal(body.ledger.found, true, body.answer);
});

test('PR-M4 control: the spelled-out labels are accepted', async () => {
  const body = await ask(lastThirty('Acme Industries'), { accounts: ACCOUNTS, entities: [],
    transactions: deposit({ description: achLine('Individual ID: 55 Individual Name: Recipient Role') }) });
  assert.equal(body.ledger.found, true);
});


test('PR-M3 disjoint registered account narration cannot disable a payer phrase', async () => {
  const body = await ask('How much income from Outside Supplier in my checking account in September 2026?', {
    accounts: ACCOUNTS, entities: [{ entity_slug: 'owner-co', legal_name: 'Checking' }],
    transactions: deposit({ payee: 'Outside Supplier', description: 'ACH CREDIT' }),
  });
  assert.equal(body.ledger?.kind, 'merchant', 'named-income decision reached');
  assert.equal(body.ledger.found, true);
  assert.equal(body.ledger.total_minor, 125000);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.payer_evidence[0].type, 'bank_payee');
});
