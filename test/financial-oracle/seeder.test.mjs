import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSeed, runSeed, createSandboxApi } from './seeder.mjs';
import { makeFake, configuration } from './fake-intuit.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/golden-company.json',import.meta.url)));
const templates=JSON.parse(readFileSync(new URL('./fixtures/seed-requests.json',import.meta.url)));
const setup=()=>{const config=configuration();const plan=planSeed(fixture,templates,config);config.plan_sha256=plan.sha256;return {config,plan};};
test('dry run validates nonempty dependency plan and never loads credentials or calls API',async()=>{
 const {config}=setup();let calls=0;
 const r=await runSeed({fixture,templates,config},{loadConnection:()=>{calls++;throw Error('forbidden');}});
 assert.equal(r.mode,'dry-run');assert.equal(r.steps.length,42);assert.equal(calls,0);
});
test('fake Intuit records creates in order, reads back all writes, resumes with no duplicate create',async()=>{
 const {config}=setup();const fake=makeFake(config);const r=await runSeed({fixture,templates,config,apply:true},fake.deps);
 assert.equal(r.state,'readback_verified'); assert.equal(r.steps.length,42);
 assert.equal(fake.calls.filter(c=>c.method==='POST').length,42);
 assert.equal(r.open_items_checked,5);
 const second=await runSeed({fixture,templates,config,apply:true},fake.deps);
 assert.equal(second.steps.length,42);assert.equal(fake.calls.filter(c=>c.method==='POST').length,42);
 assert.ok(fake.calls.some(c=>c.method==='GET' && c.path===`invoice/${r.steps.find(s=>s.seed_id==='S01').id}`));
});
test('sandbox, company, schema and synthetic guards are reached with green control and no writes',async()=>{
 const {config}=setup();assert.equal(planSeed(fixture,templates,config).steps.length,42);
 for(const change of [c=>c.environment='production',c=>c.api_base='https://quickbooks.api.intuit.com',c=>c.synthetic_only=false,c=>c.plan_sha256='0'.repeat(64)]){
   const c=structuredClone(config);change(c);const fake=makeFake(c);
   await assert.rejects(runSeed({fixture,templates,config:c,apply:true},fake.deps),/ORACLE_SEED/);
   assert.equal(fake.calls.filter(c=>c.method==='POST').length,0);
 }
 const fake=makeFake(config);fake.connection.quickbooks_binding.active_environment='production';
 await assert.rejects(runSeed({fixture,templates,config,apply:true},fake.deps),/ORACLE_SEED/);
 assert.equal(fake.loads(),1);assert.equal(fake.calls.length,0);
});
test('unknown POST result leaves pending intent and never blindly retries',async()=>{
 const {config}=setup();const fake=makeFake(config,{losePost:2});
 await assert.rejects(runSeed({fixture,templates,config,apply:true},fake.deps),/ORACLE_SEED/);
 assert.equal(fake.calls.filter(c=>c.method==='POST').length,2);
 const receipt=await runSeed({fixture,templates,config,apply:true},fake.deps);
 assert.equal(receipt.state,'readback_verified');assert.equal(fake.calls.filter(c=>c.method==='POST').length,42);
});
test('unresolved pending create, changed readback, nonzero baseline and bad balances refuse after decision',async()=>{
 const {config}=setup();
 for(const option of [{losePost:1,noCreate:true},{badReadback:true},{nonzeroBaseline:true},{badBalance:true}]){
   const fake=makeFake(config,option);
   await assert.rejects(runSeed({fixture,templates,config,apply:true},fake.deps),/ORACLE_SEED/);
   assert.ok(fake.calls.length>0);
   if(option.noCreate){const posts=fake.calls.filter(c=>c.method==='POST').length;await assert.rejects(runSeed({fixture,templates,config,apply:true},fake.deps),/ORACLE_SEED/);assert.equal(fake.calls.filter(c=>c.method==='POST').length,posts);}
 }
});
test('transport pins sandbox origin, never follows redirect, serializes exact numeric tokens and sanitizes errors',async()=>{
 let call;const api=createSandboxApi({realm_id:'sandbox_fixture',access_token:'fixture-token',minor_version:'75',fetchImpl:async(url,init)=>{call={url,init};return {ok:true,redirected:false,text:async()=>'{"Invoice":{"Id":"1","Amount":9007199254740993.01}}'};}});
 const r=await api('POST','invoice',{Amount:'9007199254740993.01'});
 assert.match(call.init.body,/"Amount":9007199254740993.01/);assert.equal(call.init.redirect,'error');assert.equal(r.data.Invoice.Amount,'9007199254740993.01');
 const bad=createSandboxApi({realm_id:'sandbox_fixture',access_token:'fixture-token',minor_version:'75',fetchImpl:async()=>{throw Error('private response');}});
 await assert.rejects(bad('GET','invoice/1'),e=>e.message==='ORACLE_SEED_TRANSPORT');
});

test('transport accepts actual mixed-case Reports API names and rejects malformed paths before fetch',async()=>{
 let reached=0;const api=createSandboxApi({realm_id:'sandbox_fixture',access_token:'fixture-token',minor_version:'75',fetchImpl:async()=>{reached++;return {ok:true,text:async()=>'{"Header":{}}'};}});
 await api('GET','reports/ProfitAndLoss');assert.equal(reached,1);
 await assert.rejects(api('GET','https://untrusted.invalid'),/ORACLE_SEED/);assert.equal(reached,1);
});
test('volatile provider envelope timestamps do not change company or preference identity',async()=>{
 const {config}=setup();const fake=makeFake(config);const factory=fake.deps.api;
 fake.deps.api=async connection=>{const call=await factory(connection);return async(...args)=>{const r=await call(...args);r.raw=JSON.stringify({...r.data,time:'2026-01-01T00:00:00Z'});r.sha256='f'.repeat(64);return r;};};
 const result=await runSeed({fixture,templates,config,apply:true},fake.deps);
 assert.equal(result.state,'readback_verified');assert.equal(fake.calls.filter(c=>c.method==='POST').length,42);
});
test('changed company fingerprint reaches connection boundary and unresolved symbols fail in planning',async()=>{
 const {config}=setup();const fake=makeFake(config);const bad={...config,company_fingerprint:'b'.repeat(64)};bad.plan_sha256=planSeed(fixture,templates,bad).sha256;
 await assert.rejects(runSeed({fixture,templates,config:bad,apply:true},fake.deps),/ORACLE_SEED_COMPANY/);assert.equal(fake.loads(),1);assert.equal(fake.calls.length,0);
 const broken=structuredClone(templates);broken.requests[1].body.CustomerRef.value.$ref='unknown';
 assert.throws(()=>planSeed(fixture,broken,config),/ORACLE_SEED_REF_ORDER/);assert.equal(planSeed(fixture,templates,config).steps.length,42);
});
test('journal persistence failure before create prevents any POST and keeps baseline reads visible',async()=>{
 const {config}=setup();const fake=makeFake(config);let saves=0;fake.deps.writeJournal=async()=>{saves++;throw Error('synthetic disk failure');};
 await assert.rejects(runSeed({fixture,templates,config,apply:true},fake.deps),/synthetic disk failure/);
 assert.equal(saves,1);assert.ok(fake.calls.some(c=>c.path==='query'));assert.equal(fake.calls.filter(c=>c.method==='POST').length,0);
});
test('HTTP fault and redirects are refused after a real transport attempt without provider error leakage',async()=>{
 for(const bad of [{ok:true,redirected:true,text:async()=>'{"Invoice":{}}'},{ok:true,text:async()=>'{"Fault":{"Error":[{"Detail":"synthetic-private"}]}}'}]){
  let attempts=0;const api=createSandboxApi({realm_id:'sandbox_fixture',access_token:'fixture-token',minor_version:'75',fetchImpl:async()=>{attempts++;return bad;}});
  await assert.rejects(api('GET','invoice/1'),e=>e.message==='ORACLE_SEED_TRANSPORT');assert.equal(attempts,1);
 }
});
test('Preferences uses the singleton read path; company metadata Id is not assumed to equal the realm',async()=>{
 const {config}=setup();const fake=makeFake(config);const factory=fake.deps.api;
 fake.deps.api=async connection=>{const api=await factory(connection);return async(method,path,...rest)=>{if(path==='preferences/sandbox_fixture')throw Error('wrong singleton path');return api(method,path,...rest);};};
 const receipt=await runSeed({fixture,templates,config,apply:true},fake.deps);assert.equal(receipt.state,'readback_verified');assert.ok(fake.calls.some(c=>c.path==='preferences'));
});
test('readback receipt binds implementation and an append-only transition history across resume',async()=>{
 const {config}=setup();const fake=makeFake(config);
 const first=await runSeed({fixture,templates,config,apply:true},fake.deps);const journal=await fake.deps.readJournal();
 assert.equal(first.implementation_sha,config.implementation_sha);assert.ok(journal.events.length>42);
 assert.ok(journal.events.some(e=>e.seed_id==='S00'&&e.state==='pending'));
 const prefix=structuredClone(journal.events);await runSeed({fixture,templates,config,apply:true},fake.deps);
 const resumed=await fake.deps.readJournal();assert.deepEqual(resumed.events.slice(0,prefix.length),prefix);assert.ok(resumed.events.length>prefix.length);
});
test('competing recovery tags and edited journal history refuse without another create',async()=>{
 const {config}=setup();const fake=makeFake(config,{losePost:1});
 await assert.rejects(runSeed({fixture,templates,config,apply:true},fake.deps),/ORACLE_SEED_CREATE_UNCERTAIN/);
 const original=[...fake.records.values()].find(r=>r.Description?.startsWith(config.run_tag));assert.ok(original);
 fake.records.set('account/competing',{...original,Id:'competing'});
 await assert.rejects(runSeed({fixture,templates,config,apply:true},fake.deps),/ORACLE_SEED_PENDING_UNRESOLVED/);
 assert.equal(fake.calls.filter(c=>c.method==='POST').length,1);
 const clean=makeFake(config);await runSeed({fixture,templates,config,apply:true},clean.deps);const journal=await clean.deps.readJournal();journal.events[0].state='edited';await clean.deps.writeJournal(journal);
 const before=clean.calls.filter(c=>c.method==='POST').length;
 await assert.rejects(runSeed({fixture,templates,config,apply:true},clean.deps),/ORACLE_SEED_JOURNAL_HISTORY/);assert.equal(clean.calls.filter(c=>c.method==='POST').length,before);
});
