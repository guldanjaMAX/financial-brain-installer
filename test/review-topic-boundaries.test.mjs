import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerFixture, NOW } from '../worker/test/ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { answerText as workerText, separateOffers } from '../worker/src/lib/answer-render.js';
import { answerText as appText } from '../frontend/src/lib/answer-render.js';
import { balanceSuggestion } from '../worker/src/lib/ledger-wording.js';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { cmdAsk } from '../brain.mjs';

const QUESTION = 'How much did I spend on materials in September 2026?';
test.beforeEach(t => t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden')));

function add(f, uid, cents, category = null, payee = null, date = '2026-09-05') {
  f.add(uid, 'synthetic purchase', payee, { cents, direction: 'outflow', date });
  if (category) f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid=?", category, uid);
}

function secondAccount(f) {
  f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    SELECT 'second-account',entity_slug,account_kind,balance_role,'5678',feed_mode,provenance,source_feed,basis_state,recorded_at
    FROM fin_accounts WHERE account_slug='fixture-account'`);
  f.raw(`INSERT INTO fin_account_coverage
    (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    SELECT 'second-account',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at
    FROM fin_account_coverage WHERE account_slug='fixture-account'`);
  assert.equal(f.first('SELECT count(*) n FROM fin_accounts').n, 2);
}

async function ask(t, f, question = QUESTION) {
  const start = f.calls.length;
  let fallbacks = 0;
  const response = await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner' }, async () => {
    fallbacks++;
    return Response.json({ answer: null, gaps: [] });
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction reader reached');
  assert.equal(fallbacks, 0, 'the real ledger path handled the request');
  assert.ok(body.ledger, 'a ledger decision exists');
  t.diagnostic(JSON.stringify({ kind: body.ledger.kind, total: body.ledger.total_minor,
    lead: body.ledger.lead_total_minor, conditional: body.ledger.if_own_transfers?.total_minor,
    found: body.ledger.found, unsorted: body.ledger.unsorted_minor, complete: body.evidence_gate?.complete,
    accounts: body.ledger.accounts?.length, answer: body.answer }));
  return body;
}

async function surfaces(t, body, question = QUESTION) {
  const directory = mkdtempSync(join(process.env.HOME, 'review-surface-'));
  const key = randomBytes(24).toString('hex');
  const keyPath = join(directory, 'fixture-admin-key');
  const manifest = join(directory, 'synthetic.manifest.json');
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'brain.invalid' },
    credentials: { admin_key: { backend: 'file', path: keyPath } } }));
  const printed = [];
  let cliCalls = 0, mcpCalls = 0;
  const print = t.mock.method(console, 'log', (...parts) => printed.push(parts.join(' ')));
  try {
    await cmdAsk(manifest, { ask: async () => question, adminKey: key,
      launchctl: () => assert.fail('host scheduler forbidden'),
      http: async () => { cliCalls++; return Response.json(body); } });
  } finally { print.mock.restore(); }
  const url = new URL('https://brain.invalid/mcp');
  const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question } },
  }) }), url, { grant: { profile: 'read-only' }, think: async () => { mcpCalls++; return body; } });
  const rpc = await response.json();
  assert.equal(response.status, 200);
  assert.equal(rpc.result.isError, undefined);
  assert.equal(cliCalls, 1, 'actual CLI dispatched the injected transport');
  assert.equal(mcpCalls, 1, 'actual MCP dispatched the injected reader');
  const texts = { worker: workerText(body), app: appText(body), cli: printed.join('\n'),
    mcp: rpc.result.content.map(c => c.text).join('\n') };
  for (const [surface, text] of Object.entries(texts)) {
    const { offers } = separateOffers(text);
    const offer = body.ledger.category_total_unconfirmed ? 'Want to check the original record?' : balanceSuggestion;
    assert.deepEqual(offers, [offer], `${surface}: exactly one offer`);
    assert.equal(text.trim().split('\n').at(-1), offer, `${surface}: offer is last`);
    t.diagnostic(`${surface}: zero-topic-claim=${/Total spend for .*: \$0\.00/.test(text)}; nonzero-topic-claim=${/Total spend for .*: \$7\.50/.test(text)}`);
  }
  return texts;
}

function withheld(body) {
  assert.equal(body.ledger.total_minor, null, 'unknown topic total must be withheld');
  assert.equal(body.ledger.lead_total_minor, null, 'unknown lead total must be withheld');
  assert.equal(body.ledger.if_own_transfers.total_minor, null, 'unknown conditional total must be withheld');
  assert.equal(body.ledger.if_own_transfers.complete, false);
  assert.equal(body.ledger.expense_total_minor, null);
  assert.equal(body.ledger.found, null);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.ledger.category_total_unconfirmed, true);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
}

test('control: no matched categories and nonempty unclassified rows withhold all surfaces', async t => {
  const f = ledgerFixture(t);
  add(f, 'unclassified', 1250);
  const body = await ask(t, f);
  withheld(body);
  assert.equal(body.ledger.found, null);
  for (const text of Object.values(await surfaces(t, body))) assert.doesNotMatch(text, /\$0\.00/);
});

test('unknown total: confirmed category subtotal plus unclassified rows', async t => {
  const f = ledgerFixture(t);
  add(f, 'confirmed', 750, 'materials');
  add(f, 'unclassified', 1250);
  const body = await ask(t, f);
  assert.equal(body.ledger.unsorted_minor, 1250, 'unclassified decision point reached');
  await surfaces(t, body);
  withheld(body);
});

test('unknown total: confirmed zero row plus unclassified rows must not certify zero', async t => {
  const f = ledgerFixture(t);
  add(f, 'confirmed-zero', 0, 'materials');
  add(f, 'unclassified', 1250);
  assert.equal(f.first("SELECT count(*) n FROM fin_transactions WHERE category='materials'").n, 1);
  const body = await ask(t, f);
  for (const text of Object.values(await surfaces(t, body))) assert.doesNotMatch(text, /Total spend for materials: \$0\.00/);
  withheld(body);
});

test('merchant word used as a category topic does not become a merchant total', async t => {
  const f = ledgerFixture(t);
  add(f, 'unclassified', 1250, null, 'Store Unit');
  const q = 'How much did I spend on Store Unit in September 2026?';
  const body = await ask(t, f, q);
  assert.equal(body.ledger.kind, 'category');
  withheld(body);
  for (const text of Object.values(await surfaces(t, body, q))) assert.doesNotMatch(text, /\$0\.00/);
});

test('covered month with no transactions still answers true zero with coverage', async t => {
  const f = ledgerFixture(t);
  assert.equal(f.first('SELECT count(*) n FROM fin_transactions').n, 0);
  const body = await ask(t, f);
  assert.equal(body.ledger.total_minor, 0);
  assert.equal(body.evidence_gate.complete, true);
  assert.match(body.answer, /Total spend for materials: \$0\.00/);
  assert.match(body.answer, /Accounts:.*covered through/);
  await surfaces(t, body);
});

test('confirmed unrelated categories still permit true topic zero', async t => {
  const f = ledgerFixture(t);
  add(f, 'unrelated', 1250, 'travel');
  const body = await ask(t, f);
  assert.equal(body.ledger.total_minor, 0);
  assert.equal(body.ledger.unsorted_minor, 0);
  assert.equal(body.evidence_gate.complete, true);
});

test('confirmed-only category control retains its total', async t => {
  const f = ledgerFixture(t);
  add(f, 'confirmed', 750, 'materials');
  const body = await ask(t, f);
  assert.equal(body.ledger.total_minor, 750);
  assert.equal(body.evidence_gate.complete, true);
  await surfaces(t, body);
});

test('merchant control retains its total without category membership', async t => {
  const f = ledgerFixture(t);
  add(f, 'merchant', 1250, null, 'Store Unit');
  const q = 'How much did I spend at Store Unit in September 2026?';
  const body = await ask(t, f, q);
  assert.equal(body.ledger.kind, 'merchant');
  assert.equal(body.ledger.total_minor, 1250);
  assert.equal(body.evidence_gate.complete, true);
  await surfaces(t, body, q);
});

test('multiple accounts: unclassified rows in one account withhold an unmatched topic', async t => {
  const f = ledgerFixture(t);
  secondAccount(f);
  add(f, 'other', 750, 'travel');
  add(f, 'unclassified', 1250);
  f.raw("UPDATE fin_transactions SET account_slug='second-account' WHERE txn_uid='unclassified'");
  const body = await ask(t, f);
  assert.equal(body.ledger.accounts.length, 2, 'both accounts entered the real decision');
  withheld(body);
  await surfaces(t, body);
});

test('multiple accounts: confirmed category in one and unclassified in the other', async t => {
  const f = ledgerFixture(t);
  secondAccount(f);
  add(f, 'confirmed', 750, 'materials');
  add(f, 'unclassified', 1250);
  f.raw("UPDATE fin_transactions SET account_slug='second-account' WHERE txn_uid='unclassified'");
  const body = await ask(t, f);
  assert.equal(body.ledger.accounts.length, 2, 'both accounts entered the real decision');
  assert.equal(body.ledger.unsorted_minor, 1250, 'unclassified evidence entered the decision');
  await surfaces(t, body);
  withheld(body);
});

for (const boundary of ['direction', 'period', 'account']) test(`control: unclassified rows outside the selected ${boundary} keep the category total`, async t => {
  const f = ledgerFixture(t);
  add(f, 'confirmed', 750, 'materials');
  add(f, 'unclassified', 1250);
  if (boundary === 'direction') f.raw("UPDATE fin_transactions SET direction='inflow' WHERE txn_uid='unclassified'");
  if (boundary === 'period') f.raw("UPDATE fin_transactions SET posted_on='2026-08-05' WHERE txn_uid='unclassified'");
  if (boundary === 'account') {
    secondAccount(f);
    f.raw("UPDATE fin_transactions SET account_slug='second-account' WHERE txn_uid='unclassified'");
  }
  assert.equal(f.first('SELECT count(*) n FROM fin_transactions WHERE category IS NULL').n, 1,
    'the unclassified control row exists');
  const body = await ask(t, f, boundary === 'account'
    ? 'How much did I spend on materials in September 2026 in account 1234?' : QUESTION);
  assert.equal(body.ledger.kind, 'category');
  assert.equal(body.ledger.total_minor, 750);
  assert.equal(body.ledger.unsorted_minor, 0);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.citations.length, 1);
  assert.equal(body.citations[0].amount_minor, 750);
  if (boundary === 'account') assert.equal(body.ledger.accounts.length, 1, 'only the selected account was read');
});
