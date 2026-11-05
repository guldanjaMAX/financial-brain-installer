import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerFixture, NOW } from '../worker/test/ledger-review-fixture.mjs';
import { recordedIntent } from '../worker/test/fixtures/ledger-intent-cases.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { isUncategorizedBucket, matchesCategory } from '../worker/src/lib/ledger-analysis.js';
import { answerText as workerText, separateOffers } from '../worker/src/lib/answer-render.js';
import { answerText as appText } from '../frontend/src/lib/answer-render.js';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { cmdAsk } from '../brain.mjs';

const month = 'September 2026';
const question = `How much did I spend on materials in ${month}?`;
const period = { type: 'between', from: '2026-09-01', to: '2026-09-30' };
const record = (kind, name) => recordedIntent(kind, {
  direction: 'outflow', vendor_text: name, period, ...(kind === 'largest' ? { count: 1 } : {}),
});
test.beforeEach(t => t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden')));

function add(f, id, cents, category = null, extra = {}) {
  f.add(id, 'synthetic purchase', 'Store Unit', { cents, direction: 'outflow', date: '2026-09-05', ...extra });
  if (category !== null) f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid=?", category, id);
}

function fixture(t, { unknown = true, cents = 750 } = {}) {
  const f = ledgerFixture(t);
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  add(f, 'confirmed', cents, 'materials');
  if (unknown) add(f, 'unknown', 1250);
  return f;
}

async function ask(f, q = question, intent = null) {
  const start = f.calls.length;
  let models = 0, fallbacks = 0;
  const response = await withLedgerAnswer({ env: f.env, question: q, now: NOW,
    grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
      models++;
      return { content: [{ type: 'text', text: JSON.stringify({ intents: [intent] }) }] };
    } }, async () => { fallbacks++; return Response.json({ answer: null, gaps: [] }); });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(models, intent ? 1 : 0, 'intended extraction decision reached');
  assert.equal(fallbacks, 0);
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'real scoped transaction read reached');
  return body;
}

function offerLast(text, expected = null) {
  const { offers } = separateOffers(text);
  assert.equal(offers.length, 1, 'one final offer');
  if (expected) assert.deepEqual(offers, [expected]);
  assert.equal(text.trim().split('\n').at(-1), offers[0], 'offer follows every fact');
}

async function surfaces(t, body, q) {
  const directory = mkdtempSync(join(process.env.HOME, 'topic-period-'));
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
    await cmdAsk(manifest, { ask: async () => q, adminKey: key,
      launchctl: () => assert.fail('host scheduler forbidden'),
      http: async (url, init) => {
        cliCalls++;
        assert.equal(url, 'https://brain.invalid/api/rag/think');
        assert.equal(JSON.parse(init.body).q, q);
        return Response.json(body);
      } });
  } finally { print.mock.restore(); }
  const url = new URL('https://brain.invalid/mcp');
  const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question: q } },
  }) }), url, { grant: { profile: 'read-only' }, think: async ({ q: actual }) => {
    mcpCalls++;
    assert.equal(actual, q);
    return body;
  } });
  const rpc = await response.json();
  assert.equal(response.status, 200);
  assert.equal(rpc.id, 1);
  assert.equal(rpc.result.isError, undefined);
  assert.equal(cliCalls, 1, 'real CLI reached its injected request');
  assert.equal(mcpCalls, 1, 'real MCP reached its injected reader');
  return [body.answer, workerText(body), appText(body), printed.join('\n'), rpc.result.content.map(c => c.text).join('\n')];
}

test('category ranking uses category membership while the merchant peer stays exact', async t => {
  const f = fixture(t, { unknown: false });
  add(f, 'other-category', 5000, 'travel');
  const category = await ask(f, `Could you retrieve the largest expense in materials in ${month}?`, record('largest', 'materials'));
  assert.equal(category.ledger.selector_type, 'category');
  assert.equal(category.ledger.found, true);
  assert.equal(category.ledger.rows.length, 1);
  assert.equal(category.ledger.rows[0].amount_minor, 750);
  assert.equal(category.ledger.complete, true, 'the ranking reading is complete inside the model clarification envelope');
  assert.equal(category.ledger.if_own_transfers.total_minor, 750);
  const merchant = await ask(f, `Could you retrieve the largest expense at Store Unit in ${month}?`, record('largest', 'Store Unit'));
  assert.equal(merchant.ledger.rows[0].amount_minor, 5000);
  assert.equal(merchant.ledger.found, true);
  for (const body of [category, merchant]) for (const render of [workerText, appText]) offerLast(render(body));
});

for (const confirmed of [true, false]) test(`unknown category membership withholds a largest result; confirmed candidate ${confirmed}`, async t => {
  const f = fixture(t);
  if (!confirmed) f.raw("UPDATE fin_transactions SET category='travel' WHERE txn_uid='confirmed'");
  const q = `Could you retrieve the largest expense in materials in ${month}?`;
  const body = await ask(f, q, record('largest', 'materials'));
  assert.equal(body.ledger.selector_type, 'category');
  assert.equal(body.ledger.category_ranking_unconfirmed, true, 'nonempty unknown-membership decision reached');
  assert.equal(body.ledger.unsorted_minor, 1250);
  assert.equal(body.ledger.found, null);
  assert.equal(body.ledger.if_own_transfers.total_minor, null);
  assert.equal(body.ledger.if_own_transfers.complete, false);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.partial, true);
  assert.deepEqual(body.ledger.rows, [], 'no certified ranked rows');
  assert.deepEqual(body.ledger.lead_rows, []);
  assert.deepEqual(body.ledger.confirmed_candidates.map(row => row.amount_minor), confirmed ? [750] : []);
  assert.ok(body.citations.some(row => row.amount_minor === 1250), 'unknown evidence is retained');
  for (const text of await surfaces(t, body, q)) {
    assert.match(text, /ranking for materials is unconfirmed/);
    assert.doesNotMatch(text, /No expenses found|largest completed expenses|\$0\.00/);
    if (confirmed) assert.match(text, /Confirmed category candidates \(incomplete ranking\)/);
    offerLast(text, 'Want to check the original record?');
  }
  const green = await ask(fixture(t, { unknown: false }), q, record('largest', 'materials'));
  assert.equal(green.ledger.found, true);
  assert.equal(green.ledger.rows[0].amount_minor, 750);
  const merchant = await ask(f, `Could you retrieve the largest expense at Store Unit in ${month}?`, record('largest', 'Store Unit'));
  assert.equal(merchant.ledger.rows[0].amount_minor, 1250, 'unknown categories do not alter merchant ranking');
});

for (const boundary of ['direction', 'period', 'account']) test(`category ranking ignores unknown membership outside the selected ${boundary}`, async t => {
  const f = fixture(t);
  if (boundary === 'direction') f.raw("UPDATE fin_transactions SET direction='inflow' WHERE txn_uid='unknown'");
  if (boundary === 'period') f.raw("UPDATE fin_transactions SET posted_on='2026-08-05' WHERE txn_uid='unknown'");
  if (boundary === 'account') {
    f.raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      SELECT 'second-account',entity_slug,account_kind,balance_role,'5678',feed_mode,provenance,source_feed,basis_state,recorded_at
      FROM fin_accounts WHERE account_slug='fixture-account'`);
    f.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      SELECT 'second-account',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at
      FROM fin_account_coverage WHERE account_slug='fixture-account'`);
    f.raw("UPDATE fin_transactions SET account_slug='second-account' WHERE txn_uid='unknown'");
  }
  assert.equal(f.first('SELECT count(*) n FROM fin_transactions WHERE category IS NULL').n, 1);
  const q = `Could you retrieve the largest expense in materials in ${month}${boundary === 'account' ? ' in account 1234' : ''}?`;
  const intent = record('largest', 'materials');
  if (boundary === 'account') intent.account_hint = '1234';
  const body = await ask(f, q, intent);
  assert.equal(body.ledger.found, true);
  assert.equal(body.ledger.rows[0].amount_minor, 750);
  assert.equal(body.ledger.complete, true);
  assert.equal(body.ledger.category_ranking_unconfirmed, undefined);
  const uncertain = await ask(fixture(t), q, intent);
  assert.equal(uncertain.ledger.category_ranking_unconfirmed, true, 'relevant unknown control reaches the withholding decision');
  assert.equal(uncertain.ledger.found, null);
});

test('a proposed category cannot certify a category ranking', async t => {
  const f = fixture(t, { unknown: false });
  f.raw("UPDATE fin_transactions SET category_basis_state='proposed' WHERE txn_uid='confirmed'");
  const q = `Could you retrieve the largest expense in materials in ${month}?`;
  const body = await ask(f, q, record('largest', 'materials'));
  assert.equal(body.ledger.category_ranking_unconfirmed, true);
  assert.equal(body.ledger.unsorted_minor, 750, 'proposed membership reaches the unknown pool');
  assert.equal(body.ledger.found, null);
  assert.deepEqual(body.ledger.confirmed_candidates, []);
  f.raw("UPDATE fin_transactions SET category_basis_state='confirmed' WHERE txn_uid='confirmed'");
  const green = await ask(f, q, record('largest', 'materials'));
  assert.equal(green.ledger.rows[0].amount_minor, 750);
  assert.equal(green.ledger.found, true);
});

test('explicit bucket recognition and matching share Unicode and case normalization', async t => {
  for (const name of [' UNCATEGORIZED ', 'ｕｎｃａｔｅｇｏｒｉｓｅｄ', 'Unsorted']) {
    assert.equal(isUncategorizedBucket(name), true);
    assert.equal(matchesCategory({ category: null }, name), true);
    assert.equal(matchesCategory({ category: 'materials', category_basis_state: 'confirmed' }, name), false);
  }
  assert.equal(isUncategorizedBucket('materials'), false);
  const f = fixture(t);
  const q = `Could you retrieve UNCATEGORIZED spending in ${month}?`;
  const body = await ask(f, q, record('category', 'UNCATEGORIZED'));
  assert.equal(body.ledger.total_minor, 1250);
  assert.equal(body.ledger.category_bucket, 'uncategorized');
});

for (const model of [false, true]) for (const name of ['uncategorized', 'uncategorised', 'unsorted'])
  test(`${model ? 'model' : 'direct'} explicit ${name} bucket measures known membership`, async t => {
    const f = fixture(t);
    add(f, 'outside-period', 9000, null, { date: '2026-08-05' });
    add(f, 'opposite-direction', 8000, null, { direction: 'inflow' });
    const q = model ? `Could you retrieve ${name} spending in ${month}?` : `How much did I spend on ${name} in ${month}?`;
    const body = await ask(f, q, model ? record('category', name) : null);
    assert.equal(body.ledger.total_minor, 1250);
    assert.equal(body.ledger.lead_total_minor, 1250);
    assert.equal(body.ledger.if_own_transfers.total_minor, 1250);
    assert.equal(body.ledger.found, true);
    assert.equal(body.ledger.category_total_unconfirmed, undefined);
    assert.equal(body.ledger.complete, true, 'the bucket reading has complete known membership');
    assert.equal(body.evidence_gate.complete, !model, 'model readings retain the existing clarification envelope');
    for (const render of [workerText, appText]) {
      assert.match(render(body), /Total spend for the uncategorized bucket: \$12\.50/);
      offerLast(render(body));
    }
    const normal = await ask(f, model ? `Could you retrieve materials spending in ${month}?` : question,
      model ? record('category', 'materials') : null);
    assert.equal(normal.ledger.category_total_unconfirmed, true, 'normal-category uncertainty decision reached');
    assert.equal(normal.ledger.total_minor, null);
    const green = await ask(fixture(t, { unknown: false }), question);
    assert.equal(green.ledger.total_minor, 750);
  });

for (const variant of ['no-match', 'mixed', 'confirmed-zero']) test(`partial ${variant} states its period and coverage on every surface`, async t => {
  const green = await ask(fixture(t, { unknown: false }));
  assert.equal(green.ledger.total_minor, 750);
  const bounds = green.answer.split('\n').find(line => line.startsWith('Accounts:'));
  assert.match(bounds, /Accounts:.*1234.*September.*covered through/, 'confirmed control supplies the period wording');
  const f = fixture(t, { cents: variant === 'confirmed-zero' ? 0 : 750 });
  if (variant === 'no-match') f.raw("UPDATE fin_transactions SET category=NULL,category_basis_state=NULL WHERE txn_uid='confirmed'");
  const body = await ask(f);
  assert.equal(body.ledger.category_total_unconfirmed, true, 'partial-membership decision reached');
  assert.equal(body.ledger.total_minor, null);
  if (variant === 'confirmed-zero') assert.equal(body.ledger.confirmed_category_subtotal_minor, 0);
  for (const text of await surfaces(t, body, question)) {
    assert.ok(text.includes(bounds), 'exact period and coverage wording from the confirmed control');
    assert.ok(text.indexOf('Accounts:') < text.indexOf('Want to check the original record?'));
    assert.doesNotMatch(text, /Total spend for materials/);
    offerLast(text, 'Want to check the original record?');
  }
});
