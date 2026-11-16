import { assertDocumentAnswer } from '../worker/test/helpers/document-answer-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceModuleHarness } from './helpers/source-module-harness.mjs';
const localMcp = await sourceModuleHarness(new URL('../components/brain-mcp.mjs',import.meta.url));
import { verifyMcpRuntime } from '../brain.mjs';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import * as moneyContract from '../worker/src/lib/money-query-contract.js';

import worker from '../worker/src/index.js';
import { ledgerFixture, NOW } from '../worker/test/ledger-review-fixture.mjs';
import { accountKindIdentity } from '../worker/src/lib/fin-account-kinds.js';
import { MONEY_ANSWER_INSTRUCTIONS, MONEY_GUIDE } from '../worker/src/lib/money-query-contract.js';
import { moneyQuestionHandoff } from '../worker/src/lib/money-handoff.js';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';

// Replay the retired reader's refusal inputs through the product entry points.
// Account confirmation, currency, sync and payment ambiguity must not determine
// whether an assistant receives the money-tool hand-off.
const handoffReplays = [
  ['refusals-B1-loan', 'How much did I pay on my loan last month?'],
  ['refusals-B1-mortgage', 'What were my mortgage payments this year?'],
  ['refusals-B1-no-loan', 'How much did I spend on my loan account last month?'],
  ['refusals-B2', 'What was my cash flow last month?'],
  ['refusals-M1', 'How much did I spend last month?'],
  ['refusals-M2', 'What are my balances?'],
  ['refusals-M3', "What's my balance?"],
  ['money-path-B1', 'How much money came in and went out in October 2026?'],
  ['money-path-B1-out', 'How much money went out in October 2026?'],
  ['review-M1', 'How much came in and went out in October 2026?'],
  ['review-M2', 'How much did I pay in taxes in October 2026?'],
  ['review-R1-M1', 'What is in each account?'],
  ['review-R1-M2', 'How much did I spend on taxes in October 2026?'],
];
const additionalMoneyQuestions = [
  'What recurring subscriptions am I paying for, and how much per month?',
  'What were my ten largest expenses in the last 60 days?',
  'What deposits came in over the last 14 days?',
  'How much did I transfer between my own accounts last month?',
  'How much did I spend at Policy Unit in September 2026?',
  'How much income do I expect next month?',
  'Did the payment of $120.01 arrive on September 15, 2026?',
  'What is my net worth?',
  'What bills are due this month?',
  'How much was my rent this year?',
  'How much does my salary add up to?',
  'How much is in my bank account?',
  'How much did I pay in fees in October 2026?',
  'How much did I receive in tax refunds in October 2026?',
  'Show my spending in October 2026 with receipts.',
  'How much do I have?',
  'How much did the store owner send me in October 2026?',
  'How much came in during October 2026?',
  'What were my credits and debits in October 2026?',
  'How much was $25 worth after the fee?',
  'What is in each account right now?',
  "What's in my account?",
  'What do I have in each account?',
  'What is in our accounts?',
  'What is in my accounts?',
  'What is in my business accounts?',
  'What is in my personal checking account?',
  'What is in my reserve account?',
  'What is the balance in my reserve account?',
  'How much went out for taxes in October 2026?',
  'What did I spend on taxes in October 2026?',
  'Show my tax spending in October 2026 with receipts.',
];
const moneyQuestions = [...handoffReplays, ...additionalMoneyQuestions.map((q, index) => [`money-${index}`, q])];
const documentControls = [
  'What does the loan agreement say about payments?',
  'Summarize the cash flow memo.',
  'Can you summarize the cash flow memo?',
  'What savings in time would this change give us?',
  'Find the bank statement.',
  'What is our expense reimbursement policy?',
  'What does current balance mean?',
  'What did the meeting say about the budget?',
  'When does the lease renew?',
  'How much time should I allow for the meeting?',
  'How can I balance work and life?',
  'What recurring meetings are on the calendar?',
  'How do I charge my laptop?',
  'How do I transfer a file?',
  'What is cash flow?',
  'What ordinary business income did Owner Entity report on its 2023 Form 1065?',
  'What ordinary business income did Owner Entity report?',
  'How much did Owner Entity owe on Form 1065?',
  'How much tax did I pay according to my 2023 Form 1040?',
  'Is the storage subscription still active?',
  'What do the March income and expense ledgers say, including the net?',
  'Show the loan agreement.',
  'Show the loan agreement with payment terms.',
  'Show the bank statement with charges.',
  'List the tax receipts with payment dates.',
];
const assertHandoff = value => {
  assert.match(value, /brain_money_guide.*brain_money_query/s, 'the hand-off decision names the guide before the query');
  assert.doesNotMatch(value, /withheld|cannot|can.t confirm|unconfirmed|cash flow gets tricky|documents do not answer/i);
};

test('the shared answer contract and hand-off require amounts, uncertainty and a check step', () => {
  for (const instructions of [MONEY_ANSWER_INSTRUCTIONS, MONEY_GUIDE, moneyQuestionHandoff("What's my balance?").answer]) {
    assert.match(instructions, /Lead with the amount and period/);
    assert.match(instructions, /account last four digits and covered dates/);
    assert.match(instructions, /missing or possibly double-counted money with its dollar impact/);
    assert.match(instructions, /impact is unknown/);
    assert.match(instructions, /Label each estimate and explain its assumptions and missing data/);
    assert.match(instructions, /concrete way to check/);
  }
});

test('remote ask replays money refusals as hand-offs before think, with document controls', async t => {
  let thinkCalls = 0;
  const ask = async question => {
    const url = new URL('https://brain.invalid/mcp');
    const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({ id: 1,
      method: 'tools/call', params: { name: 'ask', arguments: { question } } }) }), url, {
      think: async ({ q }) => {
        thinkCalls++;
        return { answer: documentControls.includes(q) ? 'Synthetic document answer.' : 'Money out is withheld.', citations: [] };
      },
    });
    const reply = await response.json();
    assert.equal(reply.id, 1, 'the real MCP dispatcher replied');
    assert.notEqual(reply.result.isError, true);
    return reply.result.content[0].text;
  };
  for (const [id, question] of moneyQuestions) await t.test(id, async () => {
    const before = thinkCalls;
    assertHandoff(await ask(question));
    assert.equal(thinkCalls, before, 'money never reaches the old backend');
  });
  for (const question of documentControls) await t.test(question, async () => {
    const before = thinkCalls;
    assert.match(await ask(question), /Synthetic document answer/);
    assert.equal(thinkCalls, before + 1, 'the document control reaches the unchanged backend');
  });
});

test('human Worker questions reach the reader while assistant handoffs stay in MCP', async t => {
  let reads = 0, modelCalls = 0, networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('network forbidden'); });
  const env = { STORAGE: 'd1', ADMIN_KEY: randomBytes(24).toString('hex'), BRAIN_TIMEZONE: 'UTC',
    DB: { prepare() { reads++; return { bind() { return this; }, first: async () => null,
      all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }; } },
    AI: { async run() { modelCalls++; return { data: [[0.1, 0.2]], response: 'Synthetic document answer.' }; } },
    VECTORIZE: { async query() { return { matches: [] }; } },
  };
  const think = async (q, authorized = true) => {
    const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorized ? { 'X-Admin-Key': env.ADMIN_KEY } : {}) },
      body: JSON.stringify({ q }),
    }), env, { waitUntil() {} });
    return { status: response.status, body: await response.json() };
  };
  for (const [id, question] of moneyQuestions) await t.test(id, async () => {
    const before = [reads, modelCalls];
    const result = await think(question);
    assert.equal(result.status, 200, 'the authenticated Worker think route was reached');
    assert.equal(result.body.money_handoff, undefined);
    if (result.body.answer_contract?.kind === 'ledger') {
      assert.ok(result.body.answer.trim());
      assert.equal(result.body.confidence.percent, 0);
      assert.match(result.body.confidence_text,/Confidence: Low \(0%\).*Why:.*Missing:/);
      assert.match(result.body.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    } else assertDocumentAnswer(result.body, {empty:!result.body.results.length});
    assert.ok(reads > before[0], 'the authenticated human request reaches the reader');
  });
  const denied = await think(handoffReplays[0][1], false);
  assert.equal(denied.status, 401, 'the authentication decision still applies');
  assert.equal(denied.body.money_handoff, undefined);
  const before = reads;
  const document = await think('When does the lease renew?');
  assert.equal(document.status, 200);
  assert.equal(document.body.money_handoff, undefined);
  assert.ok(reads > before, 'the document control reaches retrieval');
  const taxDocument = await think('How much tax did I pay according to my 2023 Form 1040?');
  assert.equal(taxDocument.body.money_handoff, undefined);
  assert.ok(taxDocument.body.gaps.some(gap => gap.type === 'tax_question_scope_unresolved'), 'the exact tax-document scope guard is reached');
  assert.equal(networkCalls, 0);
});

test('review R1-M1 keeps a recorded balance queryable when another account has no observation', async t => {
  const f = ledgerFixture(t);
  const now = '2026-11-12T12:00:00.000Z';
  t.mock.method(Date, 'now', () => Date.parse(now));
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.env.VECTORIZE.query = async () => ({ matches: [] });
  f.raw("UPDATE fin_accounts SET mask='1111' WHERE account_slug='fixture-account'");
  f.raw('UPDATE bank_feed_items SET last_synced_at=?', now);
  f.raw(`UPDATE fin_balance_snapshots SET as_of_date='2026-11-11',current_minor=12345,recorded_at=?`, now);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('second-account','owner','checking','asset','2222','manual','owner_stated','confirmed',?)`, now);
  f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
    VALUES ('second-account','2026-11-11',67890,'owner_stated','confirmed',?)`, now);
  const question = 'What is in each account?';
  let documentCalls = 0;
  const legacyAsk = async () => (await withLedgerAnswer({ env: f.env, question, now: Date.parse(now),
    grantScope: { all: true }, scopePrincipalKind: 'owner' }, async () => {
    documentCalls++;
    return Response.json({ answer: null, citations: [], results: [], gaps: [] });
  })).json();
  const green = await legacyAsk();
  assert.deepEqual(green.ledger.accounts.map(a => [a.account_mask, a.current_minor, a.as_of]),
    [['1111', 12345, '2026-11-11'], ['2222', 67890, '2026-11-11']], 'both recorded balances are read in the green control');
  assert.equal(documentCalls, 0);
  f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='second-account'");
  const beforeLegacy = f.calls.length;
  const legacy = await legacyAsk();
  assert.ok(f.calls.length > beforeLegacy, 'the partial-balance decision reads the actual ledger');
  assert.equal(documentCalls, 0, 'a missing second observation does not discard the first recorded balance');
  assert.deepEqual(legacy.ledger.accounts.map(a => [a.account_mask,a.current_minor,a.as_of]), [['1111',12345,'2026-11-11']]);
  assert.equal(legacy.ledger.complete,false);
  assert.deepEqual(legacy.ledger.excluded_accounts,[{account_mask:'2222',reason:'balance_unavailable'}]);
  assert.match(legacy.answer,/123\.45/);
  assert.match(legacy.answer,/2222/);
  const before = f.calls.length;
  const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY }, body: JSON.stringify({ q: question }),
  }), f.env, { waitUntil() {} });
  assert.equal(response.status, 200, 'the authenticated Worker decision was reached');
  const body = await response.json();
  assert.equal(body.money_handoff, undefined);
  assert.equal(body.answer_contract.kind,'ledger');
  assert.match(body.answer,/123\.45/);
  assert.match(body.answer,/2222/);
  assert.equal(body.confidence.percent,0);
  assert.equal(body.ledger.complete,false);
  assert.match(body.confidence.missing.join(' '),/2222/);
  assert.match(body.answer,/Recorded snapshot dates:.*2026-11-11/);
  assert.ok(f.calls.length > before, 'the human request reads the partial ledger');
  const beforeRemote = f.calls.length;
  let thinkCalls = 0;
  const url = new URL('https://brain.invalid/mcp');
  const remote = await handleMcp(f.env, new Request(url, { method: 'POST', body: JSON.stringify({ id: 1,
    method: 'tools/call', params: { name: 'ask', arguments: { question } } }) }), url, {
      think: async () => { thinkCalls++; return legacyAsk(); },
    });
  assertHandoff((await remote.json()).result.content[0].text);
  assert.equal(thinkCalls, 0, 'the reached remote hand-off also avoids the partial-balance reader');
  assert.equal(f.calls.length, beforeRemote);
  const query = await worker.fetch(new Request('https://brain.invalid/api/admin/brain/money-query', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY }, body: JSON.stringify({ sql:
      'SELECT a.mask, b.current_minor, b.as_of_date FROM fin_accounts a LEFT JOIN fin_balance_snapshots b ON a.tenant_id=b.tenant_id AND a.account_slug=b.account_slug ORDER BY a.mask' }),
  }), f.env, { waitUntil() {} });
  assert.equal(query.status, 200);
  assert.deepEqual((await query.json()).rows.map(r => [r.mask, r.current_minor, r.as_of_date]),
    [['1111', 12345, '2026-11-11'], ['2222', null, null]], 'money SQL retains the known amount and explicit missing observation');
});

test('review R1-m1 distinguishes a requested agreement from receipts supporting spending on the Worker', async t => {
  const f = ledgerFixture(t);
  let documentCalls = 0;
  f.env.VECTORIZE.query = async () => { documentCalls++; return { matches: [] }; };
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const q of ['Show the loan agreement.', 'Show the loan agreement with payment terms.',
    'Show my spending in October 2026 with receipts.']) {
    const before = documentCalls;
    const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY }, body: JSON.stringify({ q }),
    }), f.env, { waitUntil() {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (q.startsWith('Show my spending')) {
      assert.equal(body.money_handoff, undefined);
      if (body.ledger) {
        assert.equal(body.ledger.kind, 'expense_summary');
        assert.equal(body.ledger.total_minor, 0);
      } else {
        assertDocumentAnswer(body, {empty:!body.results.length});
        assert.ok(documentCalls > before, 'an unsupported wording reaches document retrieval');
      }
    } else {
      assert.equal(body.money_handoff, undefined);
      assert.equal(documentCalls, before + 1, 'the requested agreement positively reaches document retrieval');
    }
  }
});

test('review M1 and M2 hand off a nonempty connected-card ledger and recorded tax payment', async t => {
  const f = ledgerFixture(t);
  f.env.BRAIN_OWNER = 'Synthetic Owner';
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw("UPDATE fin_accounts SET mask='1111' WHERE account_slug='fixture-account'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('card-unit','owner','other','liability','2222','manual','owner_stated','confirmed',?)`, NOW);
  const card = f.first("SELECT * FROM fin_accounts WHERE account_slug='card-unit'");
  f.raw(`INSERT INTO fin_account_kind_reviews (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
    VALUES (?,?,?,'card','liability','owner','owner_account_kind',?,?)`, card.tenant_id, card.id,
    accountKindIdentity(card), NOW, 'a'.repeat(64));
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('card-unit','complete','2026-10-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.add('purchase-unit', 'Purchase Unit', 'Store Unit', { cents: 10000, direction: 'outflow' });
  const question = 'How much came in and went out in October 2026?';
  const green = await f.ask(question);
  assert.equal(green.ledger.accounts.reduce((sum, account) => sum + account.debits_minor, 0), 10000,
    'nonempty ordinary-purchase control reaches the real legacy totals across both accounts');
  f.add('card-payment-unit', 'Card payment', 'Payment Unit', { cents: 2500, direction: 'outflow' });
  f.raw("UPDATE fin_transactions SET category='LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',category_basis_state='confirmed' WHERE txn_uid='card-payment-unit'");
  const beforeLegacy = f.calls.length;
  const legacy = await f.ask(question);
  assert.ok(f.calls.length > beforeLegacy, 'the compatibility control read the nonempty ledger');
  assert.equal(legacy.ledger.accounts.reduce((sum, account) => sum + account.debits_minor, 0), 12500,
    'an unproved payment stays counted alongside the purchase');
  assert.equal(legacy.ledger.lead_accounts.reduce((sum, account) => sum + account.debits_minor, 0), 12500,
    'the first displayed money-out figure retains the same observed debits');
  assert.equal(legacy.ledger.complete, false, 'observed debits do not prove the payment destination');
  assert.equal(legacy.ledger.possible_payments_included_minor, 2500);
  assert.equal(legacy.ledger.possible_payments[0].included_in_total, true);
  assert.equal(legacy.ledger.possible_payments[0].destination_unconfirmed, true);
  assert.deepEqual(legacy.ledger.possible_payments[0].connected_counterpart_masks, ['2222']);
  assert.match(legacy.answer, /included in money out above, possibly a card payment/);
  assert.doesNotMatch(legacy.answer, /withheld/i);
  f.add('tax-payment-unit', 'Tax payment', 'Tax Unit', { cents: 50000, direction: 'outflow' });
  assert.equal(f.first('SELECT count(*) n FROM fin_transactions').n, 3);
  assert.equal(f.first("SELECT amount_minor FROM fin_transactions WHERE txn_uid='tax-payment-unit'").amount_minor, 50000,
    'the exact tax-spending replay has a recorded $500 payment');
  let thinkCalls = 0;
  const think = async q => {
    thinkCalls++;
    const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY }, body: JSON.stringify({ q }),
    }), f.env, { waitUntil() {} });
    assert.equal(response.status, 200, 'the authenticated real Worker route was reached');
    return response.json();
  };
  for (const q of [question, 'How much money came in and went out in October 2026?', 'How much did I pay in taxes in October 2026?',
    'How much did I spend on taxes in October 2026?', 'How much went out for taxes in October 2026?']) {
    const before = f.calls.length;
    const body = await think(q);
    assert.equal(body.money_handoff, undefined);
    assert.equal(typeof body.answer, 'string');
    assert.ok(body.answer.trim());
    assert.ok(f.calls.length > before, 'the human request reads its populated evidence');
    if (q === question) {
      assert.equal(body.ledger.accounts.reduce((sum, account) => sum + account.debits_minor, 0), 62500);
      assert.equal(body.confidence.percent, 0, 'compatibility activity never implies assessed High confidence');
      assert.match(body.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
      assert.equal(body.answer_contract.kind, 'ledger');
      assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
      assert.doesNotMatch(body.answer, /withheld/i);
    }
    if (body.ledger) assert.match(body.answer, /\d/);
    else assertDocumentAnswer(body, {empty:!body.results.length});
    const calls = thinkCalls;
    const url = new URL('https://brain.invalid/mcp');
    const remote = await handleMcp(f.env, new Request(url, { method: 'POST', body: JSON.stringify({ id: 1,
      method: 'tools/call', params: { name: 'ask', arguments: { question: q } } }) }), url, { think: ({ q }) => think(q) });
    assertHandoff((await remote.json()).result.content[0].text);
    assert.equal(thinkCalls, calls, 'remote ask also avoids the legacy backend');
  }
  // Follow through the real read-only query endpoint, not a fabricated answer.
  const sql = "SELECT SUM(amount_minor) AS recorded_out_minor FROM txn WHERE direction='outflow' AND posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
  const response = await worker.fetch(new Request('https://brain.invalid/api/admin/brain/money-query', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY }, body: JSON.stringify({ sql }),
  }), f.env, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rows[0].recorded_out_minor, 62500, 'all three recorded debits remain queryable');
  const uncertain = await worker.fetch(new Request('https://brain.invalid/api/admin/brain/money-query', {
    method:'POST', headers:{'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY},
    body:JSON.stringify({sql:"SELECT money_kind,estimated,uncertain_kind,expense_minor FROM txn WHERE txn_uid='card-payment-unit'"}),
  }),f.env,{});
  assert.equal(uncertain.status,200);
  assert.deepEqual((await uncertain.json()).rows,[{money_kind:'ordinary',estimated:1,uncertain_kind:'card_payment',expense_minor:2500}]);
  const tax = await worker.fetch(new Request('https://brain.invalid/api/admin/brain/money-query', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
    body: JSON.stringify({ sql: "SELECT amount_minor FROM txn WHERE payee='Tax Unit' AND posted_on BETWEEN '2026-10-01' AND '2026-10-31'" }),
  }), f.env, { waitUntil() {} });
  assert.equal(tax.status, 200);
  assert.equal((await tax.json()).rows[0].amount_minor, 50000, 'the recorded tax payment needs no tax-return form');
});

test('real local brain_think replays money refusals before transport and preserves document controls', t => {
  mkdirSync(resolve('.lane-scratch/money-handoff'), { recursive: true });
  const root = mkdtempSync(resolve('.lane-scratch/money-handoff/home-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launchctl = join(root, 'launchctl');
  writeFileSync(launchctl, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ operations: {} }));
  writeFileSync(join(root, '.brain-admin-key'), randomBytes(24).toString('hex'), { mode: 0o600 });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ key_file: join(root, '.brain-admin-key') }));
  const hook = join(root, 'hook.mjs');
  writeFileSync(hook, `import {appendFileSync,readFileSync} from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{throw new Error('host child process forbidden');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name]=deny;
syncBuiltinESMExports();
const key=readFileSync(new URL('./.brain-admin-key',import.meta.url),'utf8').trim();
globalThis.fetch=async(url,options)=>{
 if(String(url)!=='https://brain.invalid/api/rag/think') throw new Error('network forbidden');
 if(new Headers(options.headers).get('X-Admin-Key')!==key) throw new Error('fixture credential mismatch');
 const q=JSON.parse(options.body).q;
 appendFileSync(new URL('./calls.jsonl',import.meta.url),JSON.stringify(q)+'\\n');
 return Response.json({answer:'Synthetic document answer.',citations:[],results:[],gaps:[]});
};`);
  for (const profile of ['owner-assistant', 'librarian']) {
    const questions = [...moneyQuestions.map(([, q]) => q), ...documentControls];
    const input = questions.map((q, id) => JSON.stringify({ jsonrpc: '2.0', id,
      method: 'tools/call', params: { name: 'brain_think', arguments: { q } } })).join('\n') + '\n';
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, resolve('components/brain-mcp.mjs')], {
      input, encoding: 'utf8', timeout: 8000,
      env: { HOME: root, USERPROFILE: root, PATH: root, BRAIN_CONFIG: config, BRAIN_MANIFEST: manifest,
        BRAIN_URL: 'https://brain.invalid', BRAIN_AGENT_PROFILE: profile,
        BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_TEST_LAUNCHCTL: launchctl },
    });
    assert.equal(child.status, 0, 'the real stdio server completed in its fixture HOME');
    const replies = child.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(replies.length, questions.length, 'every request reached the dispatcher');
    for (let id = 0; id < questions.length; id++) {
      const reply = replies.find(r => r.id === id);
      assert.notEqual(reply.result.isError, true);
      const body = JSON.parse(reply.result.content[0].text);
      if (id < moneyQuestions.length) {
        if (profile === 'owner-assistant') assertHandoff(body.answer);
        else {
          assert.equal(body.required_agent_profile, 'owner-assistant', 'the capability transition was reached');
          assert.equal(body.money_tools_available, false);
          assert.match(body.answer, /owner-assistant/);
          assert.doesNotMatch(body.answer, /brain_money_guide|brain_money_query/);
        }
        assert.equal(body.money_handoff, true);
        assert.deepEqual(body.gaps, []);
        assert.equal(body.note, undefined, 'no document-refusal note is appended');
      } else assert.equal(body.answer, 'Synthetic document answer.');
    }
  }
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [...documentControls, ...documentControls], 'only document controls reached transport in both profiles');
});

function isolatedRunTool(profile) {
  const source = readFileSync(new URL('../components/brain-mcp.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function runTool(');
  const end = source.indexOf('/* MCP plumbing', start);
  const errorStart = source.indexOf('class McpToolError ');
  const errorEnd = source.indexOf('const REVIEWED_CREDENTIAL_ERRORS', errorStart);
  assert.ok(start >= 0 && end > start && errorStart >= 0 && errorEnd > errorStart, 'production spans exist');
  const calls = [];
  const guide = { marker: 'synthetic schema guide' };
  const {result:runTool} = localMcp({
    PROFILE: profile, withMoneyConfidence: moneyContract.withMoneyConfidence, moneyGuideFor: ({timeZone}) => { assert.equal(timeZone,'UTC'); return guide; }, localAsOf: () => ({time_zone:'UTC'}),
    callMoneyQuery: async body => { calls.push({path:'/api/admin/brain/money-query',method:'POST',moneyErrors:true,body});return {rows:[{value:7}]}; },
    call: async (path, request) => { calls.push({ path, ...request }); return { rows: [{ value: 7 }] }; },
  },'runTool');
  return { runTool, calls, guide };
}

test('isolated owner money dispatch reaches the guide and query without imported inventory globals', async () => {
  const fixture = isolatedRunTool('owner-assistant');
  assert.equal(await fixture.runTool('brain_money_guide'), fixture.guide, 'the guide decision returns the injected schema');
  const result = await fixture.runTool('brain_money_query', { sql: 'SELECT 7 AS value', max_rows: 1, from:'2026-02-01', through:'2026-02-28',period_from:'2026-09-01',period_to:'2026-09-30',account_slugs:['operating'],measure:'posted_spending',rank_limit:5 });
  assert.equal(result.rows[0].value, 7);
  assert.equal(result.confidence.percent, 0, 'an older transport without evidence cannot return an unscored answer');
  assert.match(result.confidence_text, /Confidence: Low \(0%\)/);
  assert.equal(fixture.calls.length, 1, 'the owner query reaches transport exactly once');
  assert.equal(fixture.calls[0].path, '/api/admin/brain/money-query');
  assert.equal(fixture.calls[0].method, 'POST');
  assert.equal(fixture.calls[0].body.sql, 'SELECT 7 AS value');
  assert.equal(fixture.calls[0].body.max_rows, 1);
  assert.equal(fixture.calls[0].body.from,'2026-02-01');
  assert.equal(fixture.calls[0].body.through,'2026-02-28');
  assert.equal(fixture.calls[0].body.measure,'posted_spending');
  assert.equal(fixture.calls[0].body.rank_limit,5);
  assert.equal(moneyContract.MONEY_TOOLS[0].inputSchema.properties.rank_limit.type,'integer');
  assert.equal(fixture.calls[0].moneyErrors,true);assert.equal(fixture.calls[0].body.period_from,'2026-09-01');assert.equal(fixture.calls[0].body.period_to,'2026-09-30');assert.deepEqual([...fixture.calls[0].body.account_slugs],['operating']);
});

test('isolated limited money dispatch reaches both profile refusals before guide or transport', async () => {
  for (const profile of [undefined, 'librarian', 'structured-contributor', 'technician', 'break-glass']) {
    const fixture = isolatedRunTool(profile);
    for (const name of ['brain_money_guide', 'brain_money_query', 'brain_money_overview']) {
      await assert.rejects(fixture.runTool(name), /MCP_PROFILE_REFUSED/, 'the reviewed profile refusal decision was reached');
    }
    assert.equal(fixture.calls.length, 0, 'profile refusals prevent transport');
  }
});

test('isolated owner query forwards document payment facts without changing their source or amount', async () => {
  const fixture = isolatedRunTool('owner-assistant');
  const payment_evidence = [{ source_ref: 'payment-email-fixture', paid_on: '2025-03-14', amount_minor: 73500,
    currency: 'USD', direction: 'outflow', account_last4: '6789', account_name: 'Prior card' }];
  const result = await fixture.runTool('brain_money_query', { sql: 'SELECT 7 AS value', payment_evidence });
  assert.equal(result.rows[0].value, 7, 'the real dispatch reached the injected transport');
  assert.equal(fixture.calls.length, 1);
  assert.equal(JSON.stringify(fixture.calls[0].body.payment_evidence), JSON.stringify(payment_evidence));
});
test('isolated owner query forwards the complete headline support reference unchanged',async()=>{
  const fixture=isolatedRunTool('owner-assistant');
  const supports={id:'a'.repeat(64),query:{sql:'SELECT 7 AS value'},parts:Object.fromEntries(['figures','population','assessment'].map(k=>[k,'b'.repeat(64)]))};
  const r=await fixture.runTool('brain_money_query',{sql:'SELECT 7 AS value',supports});
  assert.equal(r.rows[0].value,7);assert.equal(fixture.calls.length,1,'the real dispatcher reached its transport');
  assert.equal(JSON.stringify(fixture.calls[0].body.supports),JSON.stringify(supports));
  assert.equal(moneyContract.MONEY_TOOLS[0].inputSchema.properties.supports.type,'object');
});

test('isolated unknown dispatch reaches the reviewed unknown-tool error without inventory globals', async () => {
  const fixture = isolatedRunTool('librarian');
  await assert.rejects(fixture.runTool('brain_unknown'), /MCP_UNKNOWN_TOOL/);
  assert.equal(fixture.calls.length, 0);
});

function local(t, profile, setup = 'built-in', overviewFailure = false, { bookRows = 0, drive, queryFailure = false } = {}) {
  const hookReply = overviewFailure && typeof overviewFailure === 'object' ? overviewFailure : null;
  if (hookReply) overviewFailure = false;
  const followQuestion = typeof overviewFailure === 'string' ? overviewFailure : null;
  if (followQuestion) overviewFailure = false;
  mkdirSync(resolve('.lane-scratch/money-query'), { recursive: true });
  const root = mkdtempSync(resolve('.lane-scratch/money-query/home-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  const launchctl = join(root, 'bin', 'launchctl');
  writeFileSync(launchctl, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ brain: { domain: 'brain.invalid' }, operations: {}, retrieval: setup === 'opus-sonnet'
    ? { answer_model: 'claude-opus-5-5', gate_model: 'claude-sonnet-5-5' } : {} }));
  writeFileSync(join(root, '.brain-admin-key'), randomBytes(24).toString('hex'), { mode: 0o600 });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ key_file: join(root, '.brain-admin-key') }));
  const hook = join(root, 'hook.mjs');
  const calls = join(root, 'calls.json');
  writeFileSync(calls, '0');
  writeFileSync(hook, `import {readFileSync,writeFileSync} from 'node:fs';
import * as cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{throw new Error('host child process forbidden');};
cp.default.spawn=deny;cp.default.spawnSync=deny;cp.default.execFile=deny;cp.default.execFileSync=deny;cp.default.execSync=deny;cp.default.exec=deny;
syncBuiltinESMExports();
const key=readFileSync(new URL('./.brain-admin-key',import.meta.url),'utf8').trim();
const stats={overflow_decisions:0,requests:[]};
const save=()=>writeFileSync(new URL('./stats.json',import.meta.url),JSON.stringify(stats));
let book,worker;
if(${bookRows}>0){
 const {overviewFixture}=await import('../../../worker/test/helpers/money-overview-fixture.mjs');
 worker=(await import('../../../worker/src/index.js')).default;
 book=overviewFixture({after(){}});book.env.ADMIN_KEY=key;
 Date.now=()=>Date.parse('2026-01-01T02:00:00Z');
 book.account('present');book.row('readable','present','2025-06-01',83);
 book.db.exec('BEGIN');
 for(let i=1;i<${bookRows};i++)book.row('history-'+i,'present','2025-05-01',1);
 book.db.exec('COMMIT');
 const prepare=book.env.DB.prepare;
 book.env.DB.prepare=sql=>{
  const statement=prepare(sql);
  if(!sql.startsWith('SELECT count(*) AS n FROM (SELECT * FROM main.fin_transactions'))return statement;
  return {...statement,all:async()=>{const result=await statement.all();
   if(result.results[0].n>10000){stats.overflow_decisions++;save();}return result;}};
 };
}


save();
globalThis.fetch=async (url,options)=>{
 const log=new URL('./calls.json',import.meta.url);
 writeFileSync(log,String(Number(readFileSync(log,'utf8'))+1));
 if(!['https://brain.invalid/api/admin/brain/money-query','https://brain.invalid/api/admin/brain/money-overview'].includes(String(url))) throw new Error('network forbidden');
 const headers=new Headers(options.headers);
 if(headers.get('X-Admin-Key')!==key) throw new Error('fixture credential mismatch');
 const body=JSON.parse(options.body);
 stats.requests.push(String(url).endsWith('/money-overview')?'overview':'query');save();
 if(${queryFailure} && String(url).endsWith('/money-query'))return new Response('Synthetic private query detail',{status:503});
 if(book)return worker.fetch(new Request(url,options),book.env,{});
 if(String(url).endsWith('/money-overview')) {
  if(options.method!=='POST'||Object.keys(body).length) throw new Error('overview request shape mismatch');
  if(${overviewFailure}) return new Response('Synthetic private overflow detail',{status:400});
  return new Response(JSON.stringify({today:'2025-12-31',coverage_text:'Synthetic coverage',months:[]}),{headers:{'Content-Type':'application/json'}});
 }
 if(options.method!=='POST'||body.sql!=='SELECT 7 AS value'||body.max_rows!==1) throw new Error('request shape mismatch');
 const reply=${JSON.stringify(hookReply)};
 return new Response(reply ? reply.body.replaceAll('SYNTHETIC_KEY',key) : JSON.stringify({rows:[{value:7}],row_count:1,truncated:false,ms:0}),{status:reply?.status??200,headers:{'Content-Type':'application/json'}});
};`);
  const initial = [
    { id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list' },
  ];
  const moneyCalls = [
    { id: 3, method: 'tools/call', params: { name: 'brain_money_guide', arguments: {} } },
    { id: 4, method: 'tools/call', params: { name: 'brain_money_query', arguments: { sql: 'SELECT 7 AS value', max_rows: 1 } } },
    { id: 5, method: 'tools/call', params: { name: 'brain_money_overview', arguments: {} } },
  ];
  const childArgs = ['--import', pathToFileURL(hook).href, process.env.MONEY_LOCAL_TEST_SOURCE || resolve('components/brain-mcp.mjs')];
  const environment = { HOME: root, PATH: join(root, 'bin'), BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_MANIFEST: manifest,
    BRAIN_CONFIG: config, BRAIN_URL: 'https://brain.invalid', ...(profile === undefined ? {} : { BRAIN_AGENT_PROFILE: profile }), BRAIN_TEST_LAUNCHCTL: launchctl };
  if (drive) return drive({ root, childArgs, environment });
  const exchange = messages => {
    const child = spawnSync(process.execPath, childArgs, {
      input: messages.map(m => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n', encoding: 'utf8', timeout: 8000, env: environment,
    });
    assert.equal(child.status, 0, 'local MCP process exited successfully');
    const received = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(received.map(r => r.id).sort(), messages.map(m => m.id).sort(), 'all real stdio decisions reached');
    return received;
  };
  const replies = exchange([...initial, ...(followQuestion ? [
    { id: 5, method: 'tools/call', params: { name: 'brain_think', arguments: { q: followQuestion } } },
  ] : moneyCalls)]);
  if (followQuestion) {
    const handoff = JSON.parse(replies.find(r => r.id === 5).result.content[0].text);
    if (handoff.money_handoff && handoff.money_tools_available) {
      const tools = replies.find(r => r.id === 2).result.tools;
      assert.ok(moneyCalls.slice(0, 2).every(call => tools.some(tool => tool.name === call.params.name)), 'every suggested tool is listed before following the hand-off');
      const guideReplies = exchange(moneyCalls.slice(0, 1));
      assert.notEqual(guideReplies[0].result.isError, true, 'read the guide before querying');
      replies.push(...guideReplies, ...exchange(moneyCalls.slice(1, 2)));
    }
  }
  return { replies, calls: Number(readFileSync(calls, 'utf8')) };
}

test('review M3 follows a balance hand-off only through available local capabilities', async t => {
  for (const setup of ['built-in', 'opus-sonnet']) for (const profile of ['owner-assistant', undefined, 'librarian']) await t.test(`${setup} ${profile ?? 'unprofiled'}`, t => {
    const { replies, calls } = local(t, profile, setup, "What's my balance?");
    const body = JSON.parse(replies.find(r => r.id === 5).result.content[0].text);
    const tools = replies.find(r => r.id === 2).result.tools;
    assert.equal(body.money_handoff, true, 'the exact balance input reaches the hand-off decision');
    if (profile === 'owner-assistant') {
      assertHandoff(body.answer);
      assert.equal(body.money_tools_available, true);
      assert.match(replies.find(r => r.id === 3).result.content[0].text, /txn columns/);
      const result = replies.find(r => r.id === 4).result;
      assert.notEqual(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).rows[0].value, 7);
      assert.equal(calls, 1, 'the authorized control follows the guide through query transport');
    } else {
      assert.equal(body.required_agent_profile, 'owner-assistant');
      assert.equal(body.money_tools_available, false);
      assert.match(body.answer, /reconnect.*owner-assistant/i);
      assert.doesNotMatch(body.answer, /brain_money_guide|brain_money_query/);
      const instructions = replies.find(r => r.id === 1).result.instructions;
      assert.doesNotMatch(instructions, /For money questions, read brain_money_guide/);
      assert.doesNotMatch(instructions + JSON.stringify(tools), /use brain_money_query/i);
      assert.doesNotMatch(instructions, /For money calculations use txn/);
      assert.match(instructions, /reconnect.*owner-assistant/i);
      assert.equal(tools.some(tool => tool.name === 'brain_money_query'), false);
      assert.equal(calls, 0, 'a reached capability transition dispatches no unavailable tool');
    }
  });
});

test('local query transport failures retain an answerable scored result without private upstream text', t => {
  const control = local(t, 'owner-assistant');
  assert.equal(JSON.parse(control.replies.find(r => r.id === 4).result.content[0].text).rows[0].value, 7, 'real stdio green control');
  const { replies, calls } = local(t, 'owner-assistant', 'built-in', false, { queryFailure: true });
  assert.equal(calls, 2, 'the failing query and successful overview both reached the fixture transport');
  const result = replies.find(r => r.id === 4).result;
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.rows, null); assert.equal(body.confidence.percent, 0);
  assert.match(body.confidence_text, /Confidence: Low \(0%\)/);
  assert.doesNotMatch(JSON.stringify(body), /Synthetic private query detail/);
});

test('MO-1112-02 real local overview failure hides the body and continues with an explicit partial-evidence policy', t => {
  const { replies, calls } = local(t, 'owner-assistant', 'built-in', true);
  assert.equal(calls, 2, 'failed overview and successful query each reach transport once');
  const result = replies.find(r => r.id === 5).result;
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, 'partial'); assert.equal(body.today, null);
  assert.equal(body.accounts, null); assert.equal(body.months, null);
  assert.match(body.coverage_text, /could not read/i);
  assert.match(body.next_step, /do not repeat.*overview/i);
  assert.match(body.next_step, /brain_money_guide/);
  assert.doesNotMatch(JSON.stringify(replies), /Synthetic private overflow detail|Try the read again|MCP_HTTP_ERROR/);
  assert.equal(calls, 2, 'failed overview and successful query each reach transport once');
  assert.equal(JSON.parse(replies.find(r => r.id === 4).result.content[0].text).rows[0].value, 7, 'successful evidence control remains available');
});

test('MO-1112-02 ordered real stdio reads complete a scoped five-part answer after ordinary overflow', async t => {
  for (const bookRows of [1, 10001]) await local(t, 'owner-assistant', 'built-in', false, { bookRows,
    drive: async ({ root, childArgs, environment }) => {
      const child = spawn(process.execPath, childArgs, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill(), 12000);
      t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
      const lines = createInterface({ input: child.stdout }); let next;
      const unexpected = [], transcript = []; let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      lines.on('line', line => { if (next) { const resolve = next; next = null; resolve(JSON.parse(line)); } else unexpected.push(line); });
      const exchange = async (id, method, params = {}) => {
        const response = new Promise(resolve => { next = resolve; });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        const reply = await response; assert.equal(reply.id, id, 'ordered real stdio response reached');
        transcript.push(reply); return reply.result;
      };
      const initialized = await exchange(1, 'initialize');
      const overview = JSON.parse((await exchange(2, 'tools/call', { name: 'brain_money_overview', arguments: {} })).content[0].text);
      const guide = (await exchange(3, 'tools/call', { name: 'brain_money_guide', arguments: {} })).content[0].text;
      const slice = await exchange(4, 'tools/call', { name: 'brain_money_query', arguments: {
        sql: "SELECT id,posted_on,account_slug,amount_minor,currency,pending,removed_at,superseded_by_id FROM fin_transactions WHERE tenant_id='primary' AND account_slug='present' AND posted_on BETWEEN '2025-06-01' AND '2025-06-01'", max_rows: 2,
      } });
      assert.notEqual(slice.isError, true); const row = JSON.parse(slice.content[0].text).rows[0];
      const stats = JSON.parse(readFileSync(join(root, 'stats.json'), 'utf8'));
      assert.deepEqual(stats.requests, ['overview', 'query'], 'one overview, one raw read, no retry');
      assert.equal(stats.overflow_decisions, bookRows > 10000 ? 2 : 0, 'overview and optional raw assessment retain the real default-budget decisions');
      assert.equal(overview.status,bookRows>10000?'partial':'complete');if(bookRows<=10000)assert.equal(overview.months.reduce((n,m)=>n+m.totals.reduce((s,t)=>s+t.money_in_minor,0),0),bookRows-1+83);
      assert.equal(overview.today, '2025-12-31'); assert.equal(row.amount_minor, 83);
      assert.match(guide + initialized.instructions, /five parts in order/);
      assert.match(guide, /do not repeat.*overview/i);
      // A deterministic consumer example completes the answer from actual tool
      // evidence. It is not a claim about an unexecuted language model.
      const answer = [
        `1. Observed money in: ${(row.amount_minor / 100).toFixed(2)} ${row.currency} on ${row.posted_on}.`,
        `2. Coverage: ${row.account_slug}, ${row.posted_on} only; raw investigation, not a certified whole-book total. ${bookRows > 10000 ? 'Could not read clean coverage or monthly totals; missing dollar impact unknown.' : 'History completeness and missing dollar impact unknown.'}`,
        '3. The observed posted amount is exact for this slice. No estimate is supported for missing history.',
        `4. Supporting-row check: row ${row.id}, ${row.account_slug}, ${row.posted_on}, ${row.amount_minor} minor units ${row.currency}; pending=${row.pending}, removed=${row.removed_at}, superseded=${row.superseded_by_id}.`,
        '5. Missing: verified whole-book coverage and duplicate-feed review. Next check: compare this scoped row with its statement.',
      ].join('\n');
      assert.equal(answer.split('\n').length, 5);
      assert.match(answer, /^1\. Observed money in: 0\.83 USD on 2025-06-01\./);
      assert.match(answer, /4\. Supporting-row check: row 1, present, 2025-06-01, 83 minor units USD; pending=0, removed=null, superseded=null/);
      assert.doesNotMatch(JSON.stringify(transcript) + stderr, /Synthetic private overflow detail|host child process forbidden|fixture credential mismatch/);
      assert.deepEqual(unexpected, []);
      const closed = once(child, 'close'); child.stdin.end();
      assert.equal((await closed)[0], 0); clearTimeout(timer); lines.close();
    },
  });
});

test('owner-assistant stdio MCP advertises and calls all three money tools with file-backed fixture auth and no network', t => {
  for (const setup of ['built-in', 'opus-sonnet']) {
    const { replies, calls } = local(t, 'owner-assistant', setup);

    const instructions = replies.find(r => r.id === 1).result.instructions;
    const tools = replies.find(r => r.id === 2).result.tools;
    for (const name of ['brain_money_query', 'brain_money_overview', 'brain_money_guide']) assert.ok(tools.some(t => t.name === name));
    assert.match(instructions, /always answer/i); assert.match(instructions, /brain_money_query/);
    assert.match(instructions, /accounts by last 4.*from <date> through <date>/);
    assert.match(instructions, /what is an estimate.*likely.*why/);
    assert.match(instructions, /Do NOT state a fact about a named person/);
    assert.doesNotMatch(instructions + JSON.stringify(tools), /cash_flow_unsupported|preserve the refusal|money translation menu/i);
    assert.match(replies.find(r => r.id === 3).result.content[0].text, /txn/);
    assert.match(replies.find(r => r.id === 3).result.content[0].text, /Today is .*owner's time zone/);
    assert.match(instructions, /For questions that are not about money: Before any status/);
    assert.match(instructions,/Broad-question guard: For questions that are not about money:/);
    const called = replies.find(r => r.id === 4).result;
    assert.notEqual(called.isError, true, 'fetch hook accepted private POST and fixture key');
    assert.equal(JSON.parse(called.content[0].text).rows[0].value, 7);
    assert.equal(JSON.parse(replies.find(r => r.id === 5).result.content[0].text).coverage_text, 'Synthetic coverage');
    assert.match(instructions, /call brain_money_overview first/i);
    assert.equal(calls, 2, 'owner control reaches each money transport exactly once');
  }
});

for (const profile of [undefined, 'librarian', 'structured-contributor', 'technician', 'break-glass', 'unknown', 'technician owner-assistant']) {
  test(`${profile ?? 'unprofiled'} stdio MCP neither advertises nor executes any money tool`, t => {
    for (const setup of ['built-in', 'opus-sonnet']) {
      const { replies, calls } = local(t, profile, setup);
      const tools = replies.find(r => r.id === 2).result.tools;
      const instructions = replies.find(r => r.id === 1).result.instructions;
      assert.match(instructions,/This connection cannot read bank rows/);
      assert.doesNotMatch(instructions,/For money calculations use txn and coverage/);
      assert.ok(tools.some(tool => tool.name === 'brain_search'), 'the limited profile reaches its normal read inventory');
      for (const name of ['brain_money_query', 'brain_money_overview', 'brain_money_guide']) {
        assert.equal(tools.some(tool => tool.name === name), false, `${name} stays owner-only`);
      }
      for (const id of [3, 4, 5]) {
        const reply = replies.find(r => r.id === id).result;
        assert.equal(reply.isError, true, 'a direct money-tool call reaches the profile refusal');
        assert.match(reply.content[0].text, /MCP_PROFILE_REFUSED/);
        assert.doesNotMatch(reply.content[0].text, /txn columns|Readable money.*tables/);
      }
      assert.equal(calls, 0, 'refused calls cannot reach the money-query transport');
    }
  });
}

test('the owner descriptor verifies the exact money-tool inventory and refuses a missing money tool', t => {
  const { replies } = local(t, 'owner-assistant');
  const descriptor = { type: 'stdio', command: process.execPath, args: [resolve('components/brain-mcp.mjs')],
    env: { BRAIN_AGENT_PROFILE: 'owner-assistant', BRAIN_NAME: 'brain' } };
  let exchanges = 0;
  const verify = messages => verifyMcpRuntime(descriptor, { environment: { HOME: resolve('.lane-scratch/money-query') },
    spawn(_command, _args, options) {
      exchanges++;
      assert.deepEqual(options.input.trim().split('\n').map(line => JSON.parse(line).method),
        ['initialize', 'notifications/initialized', 'tools/list'], 'the descriptor handshake decision is reached');
      return { status: 0, stdout: messages.map(reply => JSON.stringify(reply)).join('\n') + '\n' };
    } });
  assert.equal(verify(replies), true, 'the actual owner MCP replies satisfy the exact descriptor');
  for (const missing of ['brain_money_query', 'brain_money_overview', 'brain_money_guide']) {
    const incomplete = structuredClone(replies);
    const listed = incomplete.find(reply => reply.id === 2).result;
    assert.ok(listed.tools.some(tool => tool.name === missing), 'the removed tool was in the owner control');
    listed.tools = listed.tools.filter(tool => tool.name !== missing);
    assert.equal(verify(incomplete), false, 'a missing money tool cannot be certified');
  }
  assert.equal(exchanges, 4, 'every descriptor verification reaches the injected handshake');
});

test('the owner OAuth connector answers cash-flow questions from available records instead of instructing a refusal', async () => {
  const url = new URL('https://brain.invalid/mcp');
  for (const method of ['initialize', 'tools/list']) {
    const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({ id: 1, method }) }),
      url, { grant: { profile: 'librarian' } });
    const reply = await response.json();
    assert.equal(reply.id, 1, 'the remote metadata decision is reached');
    const text = method === 'initialize' ? reply.result.instructions : reply.result.tools.find(tool => tool.name === 'ask').description;
    assert.match(text, /For money questions, call brain_money_overview first, read brain_money_guide, then go straight to brain_money_query/);
    assert.match(text, /ANSWER CONTRACT:[\s\S]*1\. Put the number first[\s\S]*2\. Say what it covers[\s\S]*3\. Say what may be missing or counted twice[\s\S]*4\. Say what is an estimate[\s\S]*5\. Say how to check/);
    assert.match(text, /from <date> through <date>/);
    assert.match(text, /\$0 quantified; amount unknown/);
    assert.doesNotMatch(text, /Cash flow is unsupported|cash_flow_unsupported/);
  }
});

test('offline chain registers both new money-query self-tests without changing the legacy projection', async () => {
  const { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } = await import('../scripts/run-test-chain.mjs');
  const command = 'node --test worker/test/money-query.test.mjs test/money-query-mcp.test.mjs';
  assert.equal(TEST_COMMANDS.filter(value => value === command).length, 1);
  assert.equal(POST_LAUNCHER_TEST_COMMANDS.filter(value => value === command).length, 1);
  const confidence = 'node --test worker/test/money-query-confidence.test.mjs';
  assert.equal(TEST_COMMANDS.filter(value => value === confidence).length, 1);
  assert.equal(POST_LAUNCHER_TEST_COMMANDS.filter(value => value === confidence).length, 1);
});

test('R2 M3 local money merges local date and IANA zone while preserving server UTC date', t => {
  const body = JSON.stringify({ rows: [{ value: 7 }], row_count: 1, truncated: false, ms: 0,
    as_of: { utc_date: '2026-11-12' }, confidence: null });
  const { replies } = local(t, 'owner-assistant', 'built-in', { status: 200, body });
  const result = JSON.parse(replies.find(r => r.id === 4).result.content[0].text);
  assert.equal(result.as_of.utc_date, '2026-11-12');
  assert.match(result.as_of.local_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof result.as_of.time_zone, 'string');
  assert.ok(result.as_of.time_zone.length > 0);
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: result.as_of.time_zone }));
  const instructions = replies.find(r => r.id === 1).result.instructions;
  assert.doesNotMatch(instructions, /if unknown, ask/);
  assert.match(instructions, /as_of\.local_date.*as_of\.utc_date.*say which date and zone were used, and continue/);
});

// Deep review MJ2 (local half): the Worker answers every reviewed money
// error with a bounded envelope (HTTP 400 for INVALID, WINDOW, TOO_HEAVY,
// SCAN_LIMIT and HISTORY_LIMIT; HTTP 200 for TIMEOUT, BUSY and UNAVAILABLE).
// The local owner MCP must keep that code and its repair text instead of
// relabelling the 400 bodies MONEY_QUERY_UNAVAILABLE.
async function realMoneyRouteBodies(t) {
  const { handleMoneyQuery } = await import('../worker/src/lib/money-query.js');
  const { overviewFixture } = await import('../worker/test/helpers/money-overview-fixture.mjs');
  const route = (env, body) => handleMoneyQuery(env, new Request('https://brain.invalid/api/admin/brain/money-query', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY }, body: JSON.stringify(body) }));
  const bodies = [];
  const keep = async (suffix, response, repair, before, f) => {
    assert.ok(f.calls.length > before, `${suffix}: the real route validation, budget or provider decision was reached`);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, `MONEY_QUERY_${suffix}`, `${suffix}: real route body`);
    bodies.push({ suffix, status: response.status, text, repair });
  };
  for (const [suffix, body, repair, configure] of [
    ['INVALID', { sql: 'SELECT missing_column FROM fin_accounts' }, /no such column: missing_column/, () => {}],
    ['WINDOW', { sql: 'SELECT 1', from: '2026-02-30', to: '2026-03-01' }, /from and to must both be YYYY-MM-DD/, () => {}],
    ['SCAN_LIMIT', { sql: 'SELECT SUM(amount_minor) FROM fin_transactions' }, /exceeds the scan budget.*posted_on BETWEEN/,
      f => { f.db.exec('BEGIN'); for (let i = 0; i < 10001; i++) f.row(`scan-${i}`, 'bank', '2026-10-02', 1); f.db.exec('COMMIT'); }],
    ['HISTORY_LIMIT', { sql: 'SELECT SUM(income_minor) FROM txn', from: '2026-10-01', through: '2026-10-31' }, /200,000.*posted_on BETWEEN/,
      f => {
        const prepare = f.env.DB.prepare;
        f.env.DB.prepare = sql => sql === 'SELECT count(*) AS n FROM (SELECT 1 FROM main.fin_transactions LIMIT 200001)'
          ? { all: async () => { f.calls.push(sql); return { success: true, results: [{ n: 200001 }] }; } } : prepare(sql);
      }],
    ['TOO_HEAVY', { sql: 'SELECT SUM(income_minor) FROM txn' }, /possible transfer pairs.*Narrow from\/through/,
      f => {
        f.account('other');
        f.db.exec('BEGIN');
        for (let i = 0; i < 170; i++) { f.row(`out-${i}`, 'bank', '2026-10-02', 100, 'outflow'); f.row(`in-${i}`, 'other', '2026-10-02', 100); }
        f.db.exec('COMMIT');
      }],
    ['UNAVAILABLE', { sql: 'SELECT 1' }, /could not complete.*retry a narrower query/,
      f => { f.env.DB.prepare = sql => { f.calls.push(sql); throw new Error('synthetic private provider detail'); }; }],
  ]) await t.test(`real ${suffix} route body`, async t => {
    const f = overviewFixture(t); f.account('bank');
    configure(f);
    const before = f.calls.length;
    await keep(suffix, await route(f.env, body), repair, before, f);
  });
  await t.test('real TIMEOUT and BUSY route bodies', async t => {
    const f = overviewFixture(t);
    t.mock.method(Date, 'now', () => Date.parse('2026-11-12T18:00:00Z'));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.env.DB.prepare = sql => { f.calls.push(sql); return { all: () => { entered(); return new Promise(() => {}); } }; };
    const before = f.calls.length;
    const pending = route(f.env, { sql: 'SELECT 1' });
    await started;
    t.mock.timers.tick(10001);
    await keep('TIMEOUT', await pending, /Wait 40 seconds.*narrower query/, before, f);
    f.calls.push('busy decision');
    await keep('BUSY', await route(f.env, { sql: 'SELECT 1' }), /Wait 40 seconds.*narrower query/, before, f);
  });
  assert.deepEqual(bodies.map(b => b.suffix).sort(), moneyContract.MONEY_QUERY_ERROR_CODES.map(code => code.replace('MONEY_QUERY_', '')).sort(),
    'every reviewed money error code has a real route body');
  return bodies;
}

test('MJ2 local owner MCP keeps the Worker money code and repair text for every real route error body', async t => {
  const bodies = await realMoneyRouteBodies(t);
  for (const { suffix, status, text, repair } of bodies) await t.test(`${suffix} (HTTP ${status})`, t => {
    const { replies, calls } = local(t, 'owner-assistant', 'built-in', { status, body: text });
    assert.equal(calls, 2, 'one query and one overview reached the fixture transport');
    const result = replies.find(r => r.id === 4).result;
    assert.notEqual(result.isError, true, 'the error stays an answerable partial result');
    const partial = JSON.parse(result.content[0].text);
    assert.equal(partial.code, `MONEY_QUERY_${suffix}`, 'the Worker money code survives the local boundary');
    assert.match(partial.error, repair, 'the Worker repair text survives');
    // A 400 body crosses the HTTP error boundary as the shared reviewed text;
    // a 200 body is the Worker's own partial result and keeps its fields.
    if (status === 400) assert.match(partial.error, new RegExp(`\\(Support code: MONEY_QUERY_${suffix}\\)`));
    assert.doesNotMatch(partial.error, /MCP_HTTP_ERROR|MCP_TOOL_FAILED|Try the read again/);
    assert.equal(partial.status, 'partial'); assert.equal(partial.rows, null);
    assert.equal(partial.confidence.percent, 0);
    assert.match(partial.confidence_text, /Confidence: Low \(0%\)/);
    assert.ok(partial.confidence.reasons.length && partial.confidence.missing.length);
    assert.doesNotMatch(result.content[0].text, /synthetic private provider detail/);
  });
});

test('R1 B1 local money errors retain bounded reviewed repairs and hide arbitrary bodies', async t => {
  for (const [name, status, body, expected, absent] of [
    ['scan',400,{code:'MONEY_QUERY_SCAN_LIMIT',error:'Pass from and through to read a period.',reason:null},/Pass from and through.*MONEY_QUERY_SCAN_LIMIT/,/Try the read again/],
    ['timeout',504,{code:'MONEY_QUERY_TIMEOUT',error:'Wait 40 seconds; do not resend the same query.'},/do not resend the same query.*MONEY_QUERY_TIMEOUT/,/Try the read again/],
    ['busy',503,{code:'MONEY_QUERY_BUSY',error:'Wait 40 seconds; do not resend the same query.'},/do not resend the same query.*MONEY_QUERY_BUSY/,/Try the read again/],
    ['typo',400,{code:'MONEY_QUERY_INVALID',error:'SQLite said: no such column: amout.',reason:'sql_error'},/no such column: amout.*MONEY_QUERY_INVALID.*\(Reason: sql_error\)/,/Try the read again/],
    ['unknown',400,{code:'SOMETHING_ELSE',error:'synthetic private text'},/HTTP 400.*MCP_HTTP_ERROR/,/synthetic private text/],
    ['malformed',400,'not json',/HTTP 400.*MCP_HTTP_ERROR/,/not json/],
    ['oversized',400,JSON.stringify({code:'MONEY_QUERY_INVALID',error:'synthetic private text',padding:'x'.repeat(5000)}),/HTTP 400.*MCP_HTTP_ERROR/,/synthetic private text/],
    ['redacted',400,{code:'MONEY_QUERY_INVALID',error:'Synthetic repair SYNTHETIC_KEY',reason:'sql_error'},/Synthetic repair.*MONEY_QUERY_INVALID/,/[a-f0-9]{48}/],
  ]) await t.test(name, () => {
    const {replies,calls}=local(t,'owner-assistant','built-in',{status,body:typeof body==='string'?body:JSON.stringify(body)});
    const result=replies.find(r=>r.id===4).result;
    assert.equal(calls,2, 'one query and one overview, without retries');assert.notEqual(result.isError,true);
    const partial = JSON.parse(result.content[0].text);
    assert.equal(partial.status,'partial');assert.equal(partial.rows,null);
    assert.equal(partial.confidence.percent,0);assert.match(partial.confidence_text,/Confidence: Low \(0%\)/);
    assert.ok(partial.confidence.reasons.length && partial.confidence.missing.length);
    assert.match(result.content[0].text,expected);assert.doesNotMatch(result.content[0].text,absent);
  });
});

test('R1 B1 both MCP surfaces share a closed bounded error formatter', async () => {
  const contract=await import('../worker/src/lib/money-query-contract.js');
  assert.equal(typeof contract.moneyQueryErrorText,'function');
  assert.ok(Object.isFrozen(contract.MONEY_QUERY_ERROR_CODES));
  for(const code of ['MONEY_QUERY_INVALID','MONEY_QUERY_SCAN_LIMIT','MONEY_QUERY_HISTORY_LIMIT','MONEY_QUERY_TOO_HEAVY','MONEY_QUERY_TIMEOUT','MONEY_QUERY_BUSY','MONEY_QUERY_UNAVAILABLE']) {
    assert.ok(contract.MONEY_QUERY_ERROR_CODES.includes(code));
    assert.equal(contract.moneyQueryErrorText({code,error:'Synthetic repair',reason:'sql_error'}),`Synthetic repair (Support code: ${code}) (Reason: sql_error)`);
  }
  for(const body of [null,{}, {code:'OTHER',error:'private'}, {code:'MONEY_QUERY_INVALID',error:''}, {code:'MONEY_QUERY_INVALID',error:'x'.repeat(701)}])
    assert.equal(contract.moneyQueryErrorText(body),null);
  assert.equal(contract.moneyQueryErrorText({code:'MONEY_QUERY_INVALID',error:'Synthetic repair',reason:'private\ntext'}),'Synthetic repair (Support code: MONEY_QUERY_INVALID)');
});

test('B1: local transport preserves only bounded reviewed money codes, never upstream text', async () => {
  for (const [status, body, code] of [
    [400, '{"code":"MONEY_QUERY_SCAN_LIMIT","error":"untrusted-body-marker"}', 'MONEY_QUERY_SCAN_LIMIT'],
    [400, '{"code":"MONEY_QUERY_INVALID"}', 'MONEY_QUERY_INVALID'],
    [504, '{"code":"MONEY_QUERY_TIMEOUT"}', 'MONEY_QUERY_TIMEOUT'],
    [503, '{"code":"MONEY_QUERY_UNAVAILABLE"}', 'MONEY_QUERY_UNAVAILABLE'],
    [400, '{"code":"OTHER","error":"untrusted-body-marker"}', 'MCP_HTTP_ERROR'],
    [400, 'untrusted-body-marker', 'MCP_HTTP_ERROR'],
    [400, '{"code":"MONEY_QUERY_INVALID","padding":"'+'x'.repeat(2048)+'"}', 'MCP_HTTP_ERROR'],
  ]) {
    const {result:call} = localMcp({
      AbortController, setTimeout, clearTimeout, TextDecoder, MONEY_QUERY_ERROR_TEXT:moneyContract.MONEY_QUERY_ERROR_TEXT,
      TIMEOUT_MS:1000, BASE:'https://brain.invalid', UA:'synthetic', CREDENTIALS:{}, fetch:()=>assert.fail('network forbidden'),
      fetchWithBrainCredential:async()=>new Response(body,{status}), REVIEWED_CREDENTIAL_ERRORS:new Set(),
    },'call');
    await assert.rejects(call('/api/admin/brain/money-query',{moneyErrors:true}), error => {
      assert.match(error.message, new RegExp('Support code: '+code));
      assert.doesNotMatch(error.message,/untrusted-body-marker/);
      if (code.startsWith('MONEY_')) assert.ok(error.message.includes(moneyContract.MONEY_QUERY_ERROR_TEXT[code]));
      return true;
    });
  }
});
