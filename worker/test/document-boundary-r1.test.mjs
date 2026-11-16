import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../src/index.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { createProductFixture } from './product-contract-fixture.mjs';
import { mintSessionCookie } from '../src/lib/sessions.js';
import { storePasskey, sessionGeneration } from '../src/lib/auth-store.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { moneyQuestionHandoff } from '../src/lib/money-handoff.js';
import { confidenceLine } from '../src/lib/confidence.js';
import { cmdAsk } from '../../brain.mjs';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { Acceptance, answerResponseContractDiagnostic } from '../../acceptance.mjs';

test('the full document reading is returned without cloning its response body', async t => {
  t.mock.method(Date,'now',()=>Date.parse('2026-11-12T19:00:00Z'));
  let clones = 0, drafts = 0;
  const clone = Response.prototype.clone;
  t.mock.method(Response.prototype, 'clone', function () {clones++;return clone.call(this);});
  const f = await createProductFixture({env:{AI:{async run(model,input) {
    if (model.includes('bge-')) return {data:[[0.1,0.2,0.3]]};
    if (String(input.messages?.[0]?.content).includes('verify a proposed answer')) return {response:{supported:true,complete:true,evidence:[1]}};
    drafts++;return {response:'The review code is 125000 [1].'};
  }}}});
  try {
    f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','upload','ready','2026-11-12')");
    const saved = await f.post('/api/admin/brain/ingest/batch',{docs:[{source_type:'records',source_id:'review',title:'Review memo',content:'Background. '.repeat(1000)+'The review code is 125000.',text_source:'native',text_reliable:true}]},{'X-Admin-Key':f.env.ADMIN_KEY});
    assert.equal(saved.status,200);
    const response = await f.post('/api/rag/think',{q:'What is the review code in the memo?'},{'X-Admin-Key':f.env.ADMIN_KEY});
    assert.match((await response.json()).answer,/125000/);
    assert.ok(drafts>0 && f.seen.sql.some(sql=>/FROM chunks/.test(sql)),'the full document reading decision ran');
    assert.equal(clones,0,'a document response is not duplicated to add ledger metadata');
  } finally {f.close();}
});

test('MF1: admin and owner session receive the stored ledger figure', async t => {
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  const f = ledgerFixture(t);
  f.add('purchase', 'Office supplies', 'Store', { cents: 12500, direction: 'outflow' });
  const credentialId = randomBytes(24).toString('hex');
  await storePasskey(f.env, { credentialId, jwk: {}, alg: -7, signCount: 0, nickname: 'Fixture device' });
  const cookie = (await mintSessionCookie(f.env, await sessionGeneration(f.env), { credentialId })).split(';')[0];
  for (const headers of [{ 'X-Admin-Key': f.env.ADMIN_KEY }, { Cookie: cookie, 'X-Brain-App': '1' }]) {
    const before = f.calls.length;
    const r = await worker.fetch(new Request('https://fixture.invalid/api/rag/think', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ q: 'How much did I spend in October 2026?' }) }), f.env, { waitUntil() {} });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(f.calls.length > before, 'the authorized request reads the populated ledger');
    assert.equal(body.money_handoff, undefined);
    assert.match(body.answer, /125\.00/);
    assert.equal(body.ledger.total_minor, 12500);
    assert.equal(body.confidence.percent, 0, 'an absent money-tool assessment cannot be promoted to confidence');
    assert.match(body.confidence_text,/Confidence: Low \(0%\).*Why:.*Missing:/);
    assert.match(body.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    let probes = 0;
    const acceptance = new Acceptance({base:'https://fixture.invalid',adminKey:'fixture-label',manifest:{},
      fetchImpl:async url => {
        if (new URL(url).pathname.endsWith('/unified')) return Response.json({results:[{chunk_uid:'fixture:record#0'}]});
        probes++;return Response.json(body);
      }});
    await acceptance.tierRetrieval(['How much did I spend in October 2026?']);
    assert.equal(probes, 1, 'the real acceptance answer decision was reached');
    assert.equal(acceptance.results.some(result => result.status === 'fail'), false);
    assert.ok(acceptance.results.some(result => result.status === 'warn' && result.name === 'document answer probe'));
    assert.equal(acceptance.results.some(result => result.name === 'configured answer model matches'), false);
  }
});

test('books fallback quotes the observation without promoting a claim-shaped party or memo', () => {
  const doc = {n:1,chunk_uid:'books:account#0',source:'books',source_kind:'quickbooks',title:'Account Party owes USD 9999',
    snippet:'Bank account Party owes USD 9999: balance USD 1,201.00 as of 2026-10-07T12:00:00.000Z. QuickBooks Account. Memo: unrelated USD 9,999.',
    ts:'2026-10-07',date_reliable:true,text_reliable:true,text_source:'native',read_complete:true};
  const body = finalizeDocumentAnswer({question:'What is the recorded QuickBooks balance?',draft:'The balance is USD 9,999 [1].',docs:[doc],checks:[{supported:false,complete:false,reason:'wrong amount'}],searchComplete:true});
  assert.match(body.answer, /1,201\.00/);
  assert.doesNotMatch(body.answer, /9999|9,999/);
  assert.ok(body.confidence.percent < 90);
  const response = {mode:'think',...body,results:[doc],citations:[{n:1,title:doc.title,source:doc.source}],gaps:[]};
  assert.equal(answerResponseContractDiagnostic(response), null, 'the populated source reading reaches acceptance');
  assert.ok(answerResponseContractDiagnostic({...response,answer:body.answer.replace('1,201.00','9,999.00')}));
  assert.ok(answerResponseContractDiagnostic({...response,confidence:{...body.confidence,percent:95,band:'High'}}));
});

test('MF4: books questions reach documents while bank questions reach assistant tools', () => {
  assert.equal(moneyQuestionHandoff('How much did I spend last month?').money_handoff, true);
  for (const q of ['What are the current QuickBooks bank account balances?', 'How much do we owe in QuickBooks open bills?', 'What are QuickBooks receivables?', 'What are the QBO bank account balances?', 'What are the Quick-Books bank account balances?']) {
    assert.equal(moneyQuestionHandoff(q), null, q);
  }
});

test('MJ3: every profile advertises only money tools it can call', async () => {
  for (const profile of ['librarian', 'structured-contributor', 'technician', 'break-glass']) {
    let reads = 0;
    const url = new URL('https://fixture.invalid/mcp');
    const invoke = async (method, params) => (await (await handleMcp({}, new Request(url, { method: 'POST',
      body: JSON.stringify({ id: 1, method, params }) }), url, { grant: { profile }, think: async () => { reads++; return {}; } })).json()).result;
    const tools = await invoke('tools/list');
    const answer = (await invoke('tools/call', { name: 'ask', arguments: { question: 'How much did I spend last month?' } })).content[0].text;
    const allowed = ['librarian', 'structured-contributor'].includes(profile);
    assert.equal(tools.tools.some(tool => tool.name === 'brain_money_query'), allowed, 'profile decision reached');
    assert.equal(reads, 0, 'assistant routing happens before think');
    if (allowed) assert.match(answer, /brain_money_query/);
    else { assert.doesNotMatch(answer, /brain_money_(?:overview|guide|query)/); assert.match(answer, /librarian|structured-contributor/); }
  }
});

test('MF2: real handoff and legacy missing basis render through cmdAsk', async () => {
  const root = mkdtempSync(join(process.env.HOME, 'handoff-cli-'));
  const manifest = join(root, 'brain.manifest.json');
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'fixture.invalid' }, infrastructure: { cloudflare: { account_id: 'unused' } } }));
  for (const legacy of [false, true]) {
    const body = moneyQuestionHandoff('How much did I spend last month?');
    assert.ok(body.confidence.band && body.confidence.basis.length, 'real handoff carries canonical confidence');
    if (legacy) delete body.confidence.basis;
    const lines = [], log = console.log;
    try {
      console.log = (...parts) => lines.push(parts.join(' '));
      await cmdAsk(manifest, { ask: async () => 'How much did I spend last month?', adminKey: randomBytes(24).toString('hex'), http: async () => Response.json(body) });
    } finally { console.log = log; }
    assert.match(lines.join('\n'), /Confidence: Low \(0%\).*Why:.*Missing:/s);
    assert.match(confidenceLine({ percent: 0 }), /Confidence: Low \(0%\).*Why:.*Missing:/);
  }
});
