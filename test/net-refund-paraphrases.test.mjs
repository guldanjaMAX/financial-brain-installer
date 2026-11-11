import { tmpdir } from 'node:os';
import { grossCompatibility } from './fixtures/net-refund/comparison-compat.mjs';
import { historicalCategoryBody } from './fixtures/net-refund/category-disclosure.mjs';
import './fixtures/net-refund/guards.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execute } from './fixtures/net-refund/execute.mjs';
import { cases, purchase, refund, reply } from './fixtures/net-refund/cases.mjs';
import { answerText as workerText } from '../worker/src/lib/answer-render.js';
import { answerText as appText } from '../frontend/src/lib/answer-render.js';
import { cmdAsk } from '../brain.mjs';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { createHash } from 'node:crypto';
import { phraseCases, grossPeer } from './fixtures/net-refund/review-cases.mjs';
const baseline = JSON.parse(readFileSync(new URL('./fixtures/net-refund/baseline.json', import.meta.url), 'utf8'));
const digest = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
import { withLedgerAnswer as candidateAnswer } from '../worker/src/lib/ledger-answer.js';
import { ledgerFixture } from '../worker/test/ledger-review-fixture.mjs';
import { join } from 'node:path';

const parts = body => body.ledger?.parts || [body.ledger];
const valid = o => {
  assert.equal(o.trace.model, 1);
  assert.ok(o.plan.intents.length);
  assert.ok(o.trace.inventory > 0);
  assert.ok(o.trace.transactions > 0);
  assert.equal(o.trace.document, 0);
  assert.ok(o.body.citations.length);
};
function offer(text) {
  const offers = text.match(/\b(?:Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\.)/g) || [];
  assert.equal(offers.length, 1);
  assert.ok(text.trim().endsWith(offers[0]), 'offer follows all facts');
}

async function surfaces(t, o, c) {
  const directory = mkdtempSync(join(tmpdir(), 'brain-net-surfaces-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(directory, { recursive: true });
  const keyPath = join(directory, 'fixture-admin-key');
  const manifest = join(directory, 'synthetic.manifest.json');
  writeFileSync(keyPath, randomBytes(24).toString('hex'), { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'brain.invalid' },
    credentials: { admin_key: { backend: 'file', path: keyPath } } }));
  let cliCalls = 0, remoteCalls = 0;
  const printed = [];
  const mock = t.mock.method(console, 'log', (...args) => printed.push(args.join(' ')));
  try {
    await cmdAsk(manifest, { ask: async () => c.question, adminKey: readFileSync(keyPath, 'utf8'),
      launchctl: () => assert.fail('scheduler forbidden'),
      http: async () => { cliCalls++; return Response.json(o.body); } });
  } finally { mock.mock.restore(); }
  const url = new URL('https://brain.invalid/mcp');
  const remote = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question: c.question } },
  }) }), url, { think: async () => { remoteCalls++; return o.body; }, grant: { profile: 'read-only' } });
  const rpc = await remote.json();
  assert.equal(cliCalls, 1);
  assert.equal(remoteCalls, 1);
  const outputs = { worker: workerText(o.body), app: appText(o.body), cli: printed.join('\n'),
    remote: rpc.result.content.map(item => item.text).join('\n') };
  for (const text of Object.values(outputs)) {
    offer(text);
    assert.ok(text.includes('$120.00'), 'gross figure is actually displayed');
  }
  return outputs;
}

for (const c of phraseCases) test(`${c.id}: requested net basis with a reached gross control`, async t => {
  const grossInput = grossPeer(c);
  const gross = await execute(grossInput);
  valid(gross);
  const originalView = grossCompatibility(historicalCategoryBody(gross.body, grossInput.rows));
  assert.equal(digest(originalView), baseline.responses[c.id], 'gross peer retains pinned bytes except verified account names and category references');
  assert.ok(parts(gross.body).every(p => !p.net_refunds_unavailable));
  if (c.twoPeriods) assert.equal(gross.body.ledger.comparison.difference_minor, 3000);
  else assert.equal(gross.body.ledger.total_minor, 12000);
  await surfaces(t, gross, grossInput);
  const net = await execute(c);
  valid(net);
  const outputs = await surfaces(t, net, c);
  const qualified = Object.values(outputs).every(text => /before subtracting refunds|Refunds have not been subtracted|net.*unavailable/i.test(text));
  const unavailable = parts(net.body).every(p => p.net_refunds_unavailable || p.net_refunds_unconfirmed);
  assert.equal(unavailable, true, 'every requested net operand is withheld');
  assert.equal(net.body.evidence_gate.complete, false);
  assert.equal(net.body.evidence_gate.partial, true);
  assert.equal(qualified, true, 'requested net figure must disclose the gross basis');
  if (c.twoPeriods) assert.equal(net.body.ledger.comparison, undefined, 'unavailable net cannot certify arithmetic');
});

test('gross and refund controls retain the parent response except named conditional scope', async () => {
  const controls = [
    { id: 'gross_plain', question: 'Could you retrieve Vendor Unit spending this month?', intents: [reply()] },
    { id: 'gross_explicit', question: 'Could you retrieve gross Vendor Unit spending this month?', intents: [reply()] },
    { id: 'refund_only', question: 'Could you retrieve deposits labelled refunds this month?', intents: [reply({ kind: 'deposits', direction: 'inflow', vendor_text: 'refunds' })] },
    { id: 'refund_list', question: 'Could you retrieve deposits from refunds this month?', intents: [reply({ kind: 'deposits', direction: 'inflow', vendor_text: 'refunds' })] },
  ];
  for (const c of controls) {
    const input = { ...c, rows: [purchase, refund, { ...refund, id: 'ordinary_deposit', cents: 1700,
      payee: 'Other Unit', description: 'Refundable deposit' }] };
    const control = async implementation => {
      const cleanup = [], f = ledgerFixture({ after: fn => cleanup.push(fn) });
      let model = 0, document = 0;
      try {
        f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
        for (const r of input.rows) f.add(r.id, r.description, r.payee, { cents: r.cents, direction: r.direction, date: r.date });
        const response = await implementation({ env: f.env, question: c.question,
          now: Date.parse('2026-10-12T12:00:00.000Z'), grantScope: { all: true }, scopePrincipalKind: 'owner',
          callLLM: async () => { model++; return { content: [{ type: 'text', text: JSON.stringify({ intents: c.intents }) }] }; },
        }, async () => { document++; return Response.json({ ledger: null }); });
        const body = await response.json();
        const transactions = f.calls.filter(sql => /CROSS JOIN fin_transactions/.test(sql)).length;
        assert.ok(body.ledger, c.id + ': direct or extracted ledger decision reached');
        assert.ok(transactions > 0, 'real transactions read');
        assert.equal(document, 0);
        assert.ok(body.citations.length, 'nonempty evidence control');
        return { body, trace: { model, document, transactions } };
      } finally { for (const fn of cleanup) fn(); }
    };
    const candidate = await control(candidateAnswer);
    const comparable = structuredClone(candidate.body);
    if (c.id.startsWith('gross')) {
      // The final named-selector contract intentionally narrows this one
      // alternative. Assert its new membership before comparing every other
      // byte with the frozen parent receipt; keep that receipt unchanged.
      const selected = input.rows.filter(row => row.payee === 'Vendor Unit');
      const conditional = candidate.body.ledger.if_own_transfers.accounts[0];
      const sum = (rows, direction) => rows.filter(row => row.direction === direction).reduce((n, row) => n + row.cents, 0);
      assert.deepEqual(conditional, { account_mask: '1234', credits_minor: sum(selected, 'inflow'),
        debits_minor: sum(selected, 'outflow'), transaction_count: selected.length });
      comparable.ledger.if_own_transfers.accounts[0] = { account_mask: '1234', credits_minor: sum(input.rows, 'inflow'),
        debits_minor: sum(input.rows, 'outflow'), transaction_count: input.rows.length };
    }
    assert.equal(digest(comparable), baseline.responses[c.id], c.id + ': all other response fields unchanged from the pinned base');
    if (c.id.startsWith('refund')) {
      assert.equal(candidate.body.ledger.rows.length, 1, 'confirmed description-list membership');
      assert.equal(candidate.body.ledger.rows[0].amount_minor, 2000);
      assert.deepEqual(candidate.body.ledger.accounts.map(a => [a.account_mask, a.covered_to]),
        [['1234', '2026-10-31']], 'the selected account is covered past the requested interval');
    }
    offer(candidate.body.answer);
  }
});
