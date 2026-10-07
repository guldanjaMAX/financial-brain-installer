import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, privateJournal, captureAnswers, captureReports } from './cli.mjs';
import { configuration, makeFake, emptyReport, response } from './fake-intuit.mjs';
import { hash, REPORT_NAMES } from './reports.mjs';
import { planSeed } from './seeder.mjs';
import { buildCases } from './evaluator.mjs';
import { recordedControl } from './response-fixtures.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/golden-company.json',import.meta.url)));
const templates=JSON.parse(readFileSync(new URL('./fixtures/seed-requests.json',import.meta.url)));
const area=()=>mkdtempSync(join(tmpdir(),'oracle-cli-'));
const save=(p,v)=>writeFileSync(p,JSON.stringify(v),{mode:0o600});
test('real CLI entry path dry-runs without credential use and writes exclusive private plan',async()=>{
 const dir=area(),config=configuration();save(join(dir,'config.json'),config);let loads=0;
 const code=await main(['seed','--config',join(dir,'config.json'),'--out',join(dir,'plan.json')],{loadConnection:()=>{loads++;throw Error();}});
 assert.equal(code,0);assert.equal(loads,0);assert.equal(JSON.parse(readFileSync(join(dir,'plan.json'))).steps.length,42);
 await assert.rejects(main(['seed','--config',join(dir,'config.json'),'--out',join(dir,'plan.json')]),/ORACLE/);
});
test('real CLI apply uses injected credential loader, API and private idempotency file',async()=>{
 const dir=area(),config=configuration();config.plan_sha256=planSeed(fixture,templates,config).sha256;save(join(dir,'config.json'),config);const fake=makeFake(config);
 const args=['seed','--apply','--config',join(dir,'config.json'),'--journal',join(dir,'journal.json'),'--out',join(dir,'receipt.json')];
 assert.equal(await main(args,fake.deps),0);assert.equal(fake.loads(),1);assert.equal(fake.calls.filter(c=>c.method==='POST').length,42);
 assert.equal(JSON.parse(readFileSync(join(dir,'journal.json'))).steps.S19.state,'verified');
});
test('real evaluate command emits a failure receipt and nonzero code for a wrong total',async()=>{
 const dir=area();const c=recordedControl(buildCases(fixture,{repeats:3,paraphrases:4}));c.responses[0].annotation.claims[0].minor='1';save(join(dir,'input.json'),c);
 assert.equal(await main(['evaluate','--input',join(dir,'input.json'),'--out',join(dir,'result.json')]),1);
 const r=JSON.parse(readFileSync(join(dir,'result.json')));assert.equal(r.wrong_money,1);assert.ok(r.claims_checked>0);
});
test('journal lock prevents overlapping writers and refuses stale unknown locks',async()=>{
 const path=join(area(),'journal.json');const store=privateJournal(path);await store.writeJournal({first:true});assert.deepEqual(await store.readJournal(),{first:true});
 assert.throws(()=>privateJournal(path),/ORACLE/);store.close();const second=privateJournal(path);assert.deepEqual(await second.readJournal(),{first:true});second.close();
});
test('unsafe or missing arguments stop before credentials, and help is offline',async()=>{
 assert.equal(await main(['help'],{log:()=>{}}),0);
 for(const args of [['seed','--apply'],['seed','--access-token','unused'],['unknown'],['ask','--config','missing']])await assert.rejects(main(args,{loadConnection:()=>{throw Error('must not reach');}}),/ORACLE/);
});
test('ask captures raw responses without inventing annotations and readiness refusal has a green control',async()=>{
 const config={test_brain:true,synthetic_only:true,brain_base:'https://brain.invalid',implementation_sha:'a'.repeat(40),admin_key_file:'fixture-key-file'};
 const readiness={test_only:true,base_sha256:hash(config.brain_base),implementation_sha:config.implementation_sha,outbox_pending:0,sources_complete:true};
 let reads=0,calls=0;const deps={readAdminKey:()=>{reads++;return 'synthetic-file-key';},fetchImpl:async(url,init)=>{calls++;assert.equal(init.redirect,'error');assert.equal(new URL(url).pathname,'/api/rag/think');return {ok:true,text:async()=>JSON.stringify({answer:'A report is required.',citations:[]})};},now:()=>Date.parse('2026-01-01T00:00:00Z')};
 const cases=buildCases(fixture);const captured=await captureAnswers(config,cases,readiness,deps);assert.equal(captured.responses.length,12);assert.equal(calls,12);assert.equal(reads,1);assert.equal(captured.responses[0].annotation,null);
 await assert.rejects(captureAnswers(config,cases,{...readiness,outbox_pending:1},deps),/ORACLE/);assert.equal(calls,12);assert.equal(reads,1);
});
test('all nine variants, annual and monthly, plus empty and cash controls are captured offline',async()=>{
 const config=configuration();config.plan_sha256=planSeed(fixture,templates,config).sha256;
 config.report_requests=['month','year'].flatMap(phase=>REPORT_NAMES.map(report=>({phase,scope:{report,start:'2025-01-01',end:phase==='year'?'2025-12-31':'2025-01-31',basis:'Accrual',currency:'USD'},parameters:{}})));
 config.report_requests.push({phase:'empty-february',scope:{report:'ProfitAndLoss',start:'2025-02-01',end:'2025-02-28',basis:'Accrual',currency:'USD'},parameters:{}},{phase:'cash-basis',scope:{report:'ProfitAndLoss',start:'2025-01-01',end:'2025-01-31',basis:'Cash',currency:'USD'},parameters:{}});
 for(const request of config.report_requests)request.parameters={start_date:request.scope.start,end_date:request.scope.end,accounting_method:request.scope.basis};
 let calls=0;const fake=makeFake(config);fake.deps.api=async()=>async()=>{const req=config.report_requests[calls++];const r=emptyReport(req.scope.report);r.Header.StartPeriod=req.scope.start;r.Header.EndPeriod=req.scope.end;r.Header.ReportBasis=req.scope.basis;return response(r);};
 const journal={state:'readback_verified',company_fingerprint:config.company_fingerprint,plan_sha256:config.plan_sha256,steps:Object.fromEntries(Array.from({length:42},(_,i)=>[i,{state:'verified'}]))};
 assert.equal((await captureReports(config,journal,fake.deps)).snapshots.length,20);assert.equal(calls,20);
 await assert.rejects(captureReports(config,{...journal,state:'pending'},fake.deps),/ORACLE/);assert.equal(calls,20);
 config.report_requests[0].parameters.end_date='2025-02-28';
 await assert.rejects(captureReports(config,journal,fake.deps),/ORACLE_CLI_REPORT_PARAMETERS/);assert.equal(calls,20);
});
test('evaluation CLI recomputes the canonical denominator instead of trusting capture-supplied truth',async()=>{
 const dir=area();const good=recordedControl(buildCases(fixture,{repeats:3,paraphrases:4}));save(join(dir,'good.json'),good);
 assert.equal(await main(['evaluate','--input',join(dir,'good.json'),'--out',join(dir,'good-result.json')]),0);
 const counterfeit=structuredClone(good);counterfeit.cases=counterfeit.cases.slice(0,1);counterfeit.responses=counterfeit.responses.slice(0,1);save(join(dir,'counterfeit.json'),counterfeit);
 assert.equal(await main(['evaluate','--input',join(dir,'counterfeit.json'),'--out',join(dir,'counterfeit-result.json')]),1);
});
test('apply reads an explicit synthetic file through the real product credential loader without copying or refreshing it',async()=>{
 const dir=area(),config=configuration();config.plan_sha256=planSeed(fixture,templates,config).sha256;
 const fake=makeFake(config);const store=join(dir,'fixture-credential-store.json');save(store,{connection:fake.connection});
 const before=hash(readFileSync(store));config.storage={backend:'file',path:store};save(join(dir,'config.json'),config);
 const deps={api:fake.deps.api,now:fake.deps.now};
 assert.equal(await main(['seed','--apply','--config',join(dir,'config.json'),'--journal',join(dir,'journal.json'),'--out',join(dir,'readback.json')],deps),0);
 assert.equal(hash(readFileSync(store)),before);assert.equal(fake.calls.filter(c=>c.method==='POST').length,42);
 assert.equal(existsSync(join(dir,'.brain')),false);
});
