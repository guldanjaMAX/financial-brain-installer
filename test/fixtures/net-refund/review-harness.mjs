import { tmpdir } from 'node:os';
import { grossCompatibility } from './comparison-compat.mjs';
export { grossCompatibility };
import { historicalCategoryBody } from './category-disclosure.mjs';
import './guards.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as React from '../../../frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../../frontend/node_modules/react-dom/server.node.js';
import { transformSync } from '../../../frontend/node_modules/rolldown/dist/utils-index.mjs';
import * as rendering from '../../../frontend/src/lib/answer-render.js';
import { answerText as workerText } from '../../../worker/src/lib/answer-render.js';
import { sourceLabel } from '../../../frontend/src/lib/words.ts';
import { cmdAsk } from '../../../brain.mjs';
import { handleMcp } from '../../../worker/src/lib/mcp-endpoint.js';
import { ledgerFixture, NOW } from '../../../worker/test/ledger-review-fixture.mjs';
import * as currentAnswer from '../../../worker/src/lib/ledger-answer.js';
import * as currentIntent from '../../../worker/src/lib/ledger-intent.js';
export { purchase, refund, reply } from './cases.mjs';
export const parts = body => body.ledger?.parts || (body.ledger ? [body.ledger] : []);
export const digest = value => createHash('sha256').update(value).digest('hex');
const baselineResponses = JSON.parse(readFileSync(new URL('./review-baseline.json', import.meta.url), 'utf8'));
// Frozen synthetic base responses keep exact-byte gross controls independent
// of Git availability. Candidate decision counters are always measured live.
export async function evaluate(c, baseline = false, injected = null) {
  if (baseline) {
    const bytes = baselineResponses.responses[digest(JSON.stringify(c))];
    assert.equal(typeof bytes, 'string', 'recorded pinned-base scenario exists');
    return { bytes, body: JSON.parse(bytes) };
  }
  const cleanups = [], f = ledgerFixture({ after: fn => cleanups.push(fn) });
  const implementation = injected || currentAnswer, validator = currentIntent;
  const raw = c.raw || { intents: c.intents };
  const trace = { validation: 0, model: 0, document: 0, inventory: 0, transactions: 0, pending: 0 };
  try {
    for (const row of c.rows) f.add(row.id, row.description, row.payee, { cents: row.cents, direction: row.direction, date: row.date });
    for (const row of c.rows) if (row.category) f.raw("UPDATE fin_transactions SET category=?,category_basis_state='confirmed' WHERE txn_uid=?", row.category, row.id);
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    const refuse = () => assert.fail('PROVIDER_BOUNDARY_REACHED');
    f.env.AI = { run: refuse }; f.env.VECTORIZE = { query: refuse, upsert: refuse, deleteByIds: refuse };
    const plan = validator.validateLedgerIntentDecision(structuredClone(raw), c.question, { now: Date.parse(NOW), timeZone: 'UTC' });
    trace.validation++;
    const response = await implementation.withLedgerAnswer({ env: f.env, question: c.question, now: Date.parse(NOW),
      grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
        trace.model++; return { content: [{ type: 'text', text: JSON.stringify(raw) }] };
      } }, async () => { trace.document++; return Response.json({ answer: 'No amount supplied by the injected document path.', ledger: null, citations: [], results: [] }); });
    const bytes = await response.text(), body = JSON.parse(bytes);
    trace.inventory = f.calls.filter(sql => /FROM fin_accounts a/.test(sql)).length;
    // Disclosure reads use pending=1 and cannot prove a posted operand.
    const transactionSql = f.calls.filter(sql => /CROSS JOIN fin_transactions/.test(sql));
    trace.transactions = transactionSql.filter(sql => /t\.pending=0\b/.test(sql)).length;
    trace.pending = transactionSql.filter(sql => /t\.pending=1\b/.test(sql)).length;
    assert.equal(trace.transactions + trace.pending, transactionSql.length, 'every transaction read has an explicit posted/pending basis');
    return { plan, trace, body, bytes, input: c };
  } finally { for (const fn of cleanups) fn(); }
}
export const historicalBytes = (o, rows) => JSON.stringify(grossCompatibility(historicalCategoryBody(o.body, rows)));
export function reached(o) {
  assert.equal(o.trace.validation, 1);
  assert.ok(o.plan.intents.length, 'nonempty validated plan');
  assert.ok(o.trace.inventory > 0 && o.trace.transactions > 0, 'real covered transactions read');
  assert.equal(o.trace.document, 0);
  assert.ok(o.body.citations.length, 'nonempty citations');
}
// C3's closed calendar refusal stays out of document synthesis and ledger SQL.
export function calendarRefusal(o) {
  assert.equal(o.trace.validation, 1);
  assert.equal(o.plan.outcome, 'fallback');
  assert.equal(o.trace.document, 0);
  assert.equal(o.trace.inventory, 0);
  assert.equal(o.trace.transactions, 0);
  assert.ok(o.body.gaps.some(g => g.scope === 'calendar'));
  assert.equal(o.body.evidence_gate.complete, false);
  assert.doesNotMatch(o.body.answer, /\$\d/);
}
export function safeBasis(o) {
  if (!o.body.ledger) {
    assert.equal(o.trace.validation, 1);
    assert.equal(o.plan.outcome, 'fallback', 'validation reached a closed refusal');
    if (o.body.gaps?.some(g => g.scope === 'calendar')) calendarRefusal(o);
    else assert.equal(o.trace.document, 1, 'actual fallback callback reached');
    assert.ok(!/\$\d/.test(o.body.answer));
    return true;
  }
  reached(o);
  for (const part of parts(o.body).filter(p => p.net_refunds_unavailable)) {
    assert.equal(part.amount_basis, 'gross_before_refunds');
    assert.equal(part.net_expense_minor, undefined);
    assert.equal(o.body.evidence_gate.complete, false);
    assert.equal(o.body.evidence_gate.partial, true);
  }
  return parts(o.body).every(p => {
    if (p.net_refunds_unavailable) return true;
    if (p.amount_basis === 'net_after_explicit_category_refunds') {
      const members = o.input.rows.filter(r => r.category === p.category_selector && r.date >= p.from && r.date <= p.to);
      const gross = members.filter(r => r.direction === 'outflow').reduce((n, r) => n + r.cents, 0);
      const refunds = members.filter(r => r.direction === 'inflow' && r.oracle === 'refund').reduce((n, r) => n + r.cents, 0);
      assert.ok(refunds > 0, 'frozen input independently identifies an explicit categorized refund');
      assert.equal(p.refund_minor, refunds);
      assert.equal(p.net_expense_minor, gross - refunds);
      assert.match(o.body.answer, /Confirmed category spending after explicit refunds:/);
      return true;
    }
    return Number.isSafeInteger(p.net_expense_minor) && /less inflows with 'refund' in the description/.test(o.body.answer);
  });
}
export function offer(text) {
  const matches = text.match(/\b(?:Want[^?\n]*\?|Which would help most\?|If you tell me[^.\n]*\.)/g) || [];
  assert.equal(matches.length, 1, 'one final offer');
  assert.ok(text.trim().endsWith(matches[0]), 'facts precede the offer');
  return matches[0];
}
const source = readFileSync(new URL('../../../frontend/src/components/Ask.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function citationDateLabel('), end = source.indexOf('export function ScopedAsk(');
assert.ok(start > 0 && end > start);
const compiled = transformSync('Ask.tsx', source.slice(start, end).replace(/\bexport /g, ''), { jsx: { runtime: 'classic' } });
assert.deepEqual(compiled.errors, []);
export function app(o, question) {
  let state = 0, textCalls = 0;
  const context = { React, Date, ...rendering, sourceLabel,
    useState: () => [[question, '', o.body, false, null, 'All accounts'][state++], () => {}],
    useFinanceScope: () => ({ activeLabel: 'All accounts', scope: null }), readAskDraft: () => '',
    FinanceScopeBar: () => null, Attention: () => null,
    TruthNote: ({ children }) => React.createElement('div', null, children),
    answerText: body => { textCalls++; return rendering.answerText(body); } };
  const Ask = runInNewContext(compiled.code + '\nAsk;', context);
  const html = renderToStaticMarkup(React.createElement(Ask));
  assert.equal(textCalls, 1, 'actual app answer renderer reached');
  const paragraph = html.match(/<p class="whitespace-pre-wrap leading-relaxed">([\s\S]*?)<\/p>/)?.[1];
  assert.ok(paragraph);
  // The app renders the answer facts, then sources and trust notes, then the one offer last.
  const offerPattern = /Want[^?<]*\?|Which would help most\?|If you tell me[^.<]*\./g;
  assert.equal((paragraph.match(offerPattern) || []).length, 0, 'answer paragraph holds the facts, not the offer');
  const after = html.slice(html.indexOf(paragraph) + paragraph.length).match(offerPattern) || [];
  return { html, paragraph, text: [paragraph, ...after].join('\n') };
}
export async function surfaces(t, o, question) {
  const directory = mkdtempSync(join(tmpdir(), 'brain-net-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true })); mkdirSync(directory, { recursive: true });
  const keyPath = join(directory, 'fixture-admin-key'), manifest = join(directory, 'synthetic.manifest.json');
  const key = randomBytes(24).toString('hex');
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'brain.invalid' }, credentials: { admin_key: { backend: 'file', path: keyPath } } }));
  let cli = 0, remote = 0; const printed = [];
  const mock = t.mock.method(console, 'log', (...args) => printed.push(args.join(' ')));
  try { await cmdAsk(manifest, { ask: async () => question, adminKey: key,
    launchctl: () => assert.fail('SCHEDULER_BOUNDARY_REACHED'), http: async () => { cli++; return Response.json(o.body); } }); }
  finally { mock.mock.restore(); }
  const url = new URL('https://brain.invalid/mcp');
  const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1,
    method: 'tools/call', params: { name: 'ask', arguments: { question } } }) }), url,
    { think: async () => { remote++; return o.body; }, grant: { profile: 'read-only' } });
  const rpc = await response.json(); assert.equal(cli, 1); assert.equal(remote, 1);
  const rendered = app(o, question);
  if (parts(o.body).some(part => part.net_refunds_unavailable)) {
    const intents = o.plan.intents;
    const oneBusiness = intents[0].kind === 'merchant' && intents.every(intent => intent.kind === 'merchant' && intent.match === intents[0].match);
    const expected = oneBusiness ? 'Want to review the deposits for possible refunds from this business?'
      : 'Want to review the deposits for possible refunds?';
    for (const text of [workerText(o.body), rendering.answerText(o.body), printed.join('\n'),
      rpc.result.content.map(item => item.text).join('\n'), rendered.text]) {
      assert.equal(offer(text), expected);
    }
  }
  return { worker: workerText(o.body), renderer: rendering.answerText(o.body), cli: printed.join('\n'),
    remote: rpc.result.content.map(item => item.text).join('\n'), app: rendered.text };
}
export function save() {}
