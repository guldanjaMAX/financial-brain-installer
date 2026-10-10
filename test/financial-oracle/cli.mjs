#!/usr/bin/env node
// Test-only tooling. Live subcommands are for separately authorized MAIN work.
import { readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,lstatSync,existsSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildCampaign,bankFixtures,selectPhase,scoreCampaign } from './campaign.mjs';
import { calculate } from './ledger.mjs';
import { hash,parseReport,REPORT_NAMES } from './reports.mjs';
import { planSeed,runSeed,createSandboxApi } from './seeder.mjs';
import { buildCases,evaluate } from './evaluator.mjs';
import { loadProviderCredentials,assertQuickBooksSourceBinding } from '../../connectors/provider-oauth.mjs';
import { readAdminKeyFile } from '../../operations/admin-key-file.mjs';
import { syncDirectory } from '../../migration/state-file.mjs';
const check=(ok,code)=>{if(!ok)throw Error(`ORACLE_CLI_${code}`);};
const fixture=JSON.parse(readFileSync(new URL('./fixtures/golden-company.json',import.meta.url)));
const templates=JSON.parse(readFileSync(new URL('./fixtures/seed-requests.json',import.meta.url)));
function readJson(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('ORACLE_CLI_INPUT');}}
function privatePath(path,existing=false){
 check(typeof path==='string'&&path.length>0,'PATH');path=resolve(path);
 let parent=dirname(path);
 while(true){const st=lstatSync(parent);check(st.isDirectory()&&!st.isSymbolicLink(),'PARENT');const next=dirname(parent);if(next===parent)break;parent=next;}
 if(existing){const st=lstatSync(path);check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(process.platform==='win32'||(st.mode&0o777)===0o600&&st.uid===process.getuid()),'PRIVATE_FILE');}
 return path;
}
export function writeReceipt(path,value){
 path=privatePath(path);const fd=openSync(path,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 check(hash(readFileSync(path))===hash(JSON.stringify(value,null,2)+'\n'),'READBACK');
}
export function privateJournal(path,{platform=process.platform}={}){
 path=privatePath(path);let lock;
 try{lock=openSync(`${path}.lock`,'wx',0o600);}catch{throw Error('ORACLE_CLI_JOURNAL_LOCKED');}
 return {readJournal:async()=>existsSync(path)?readJson(privatePath(path,true)):null,
 writeJournal:async value=>{
  if(existsSync(path))privatePath(path,true);
  const temporary=`${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeReceipt(temporary,value);renameSync(temporary,path);
  syncDirectory(dirname(path),{platform});
  check(JSON.stringify(readJson(privatePath(path,true)))===JSON.stringify(value),'JOURNAL_READBACK');
 },close:()=>{closeSync(lock);unlinkSync(`${path}.lock`);}};
}
export function parseArgs(args){
 const [command,...rest]=args;check(['help','truth','cases','campaign','banks','seed','reports','ask','evaluate','score-campaign'].includes(command),'COMMAND');
 const flags={};const allowed=new Set(['config','out','journal','input','cases','readiness','apply','phase']);
 for(let i=0;i<rest.length;i++){
  const key=rest[i].replace(/^--/,'');check(rest[i]===`--${key}`&&allowed.has(key)&&!Object.hasOwn(flags,key),'ARGUMENT');
  if(key==='apply')flags[key]=true;else{check(typeof rest[i+1]==='string'&&!rest[i+1].startsWith('--'),'ARGUMENT');flags[key]=rest[++i];}
 }
 const permitted={help:[],truth:['out','phase'],cases:['out','phase'],campaign:['out'],banks:['out','phase'],seed:['config','out','journal','apply','phase'],reports:['config','out','journal'],ask:['config','out','cases','readiness'],evaluate:['input','out','phase'],'score-campaign':['input','out']};
 check(Object.keys(flags).every(k=>permitted[command].includes(k)),'ARGUMENT');
 return {command,flags};
}
function localLoader(config){
 const storage=config.storage;check(storage&&['file','keychain'].includes(storage.backend),'STORAGE');
 check(Object.keys(storage).every(k=>['backend','path','home','keychainService','keychainAccount'].includes(k)),'STORAGE');
 if(storage.backend==='file')check(typeof storage.path==='string','STORAGE');
 // Use the product read-only loader. No refresh, migration or duplicate store.
 return ()=>loadProviderCredentials('quickbooks',{...storage,migrateLegacy:false});
}
async function boundApi(config,deps){
 check(config.synthetic_only===true&&config.environment==='sandbox'&&config.api_base==='https://sandbox-quickbooks.api.intuit.com','SANDBOX');
 const connection=await (deps.loadConnection||localLoader(config))();
 let binding;try{binding=assertQuickBooksSourceBinding(connection,{source:config.source,environment:'sandbox'});}catch{throw Error('ORACLE_CLI_BINDING');}
 check(binding.qbo_company_fingerprint===config.company_fingerprint&&connection.provider_metadata.realm_id===binding.realm_id,'BINDING');
 check(!connection.quickbooks_refresh_fence&&Number.isFinite(connection.expires_at)&&connection.expires_at>(deps.now||Date.now)()+60000,'TOKEN_EXPIRED');
 return deps.api?deps.api(connection):createSandboxApi({realm_id:binding.realm_id,access_token:connection.access_token,minor_version:config.minor_version});
}
export async function captureReports(config,journal,deps={}){
 check(journal?.state==='readback_verified'&&Object.values(journal.steps||{}).length===42&&Object.values(journal.steps).every(s=>s.state==='verified'),'SEED_INCOMPLETE');
 check(journal.company_fingerprint===config.company_fingerprint&&journal.plan_sha256===config.plan_sha256&&config.writers_frozen===true,'BINDING');
 const requests=config.report_requests;check(Array.isArray(requests)&&requests.length===20&&new Set(requests.map(r=>`${r.phase}:${r.scope?.report}`)).size===20,'REPORT_REQUESTS');
 for(const r of requests)check(r.parameters?.start_date===r.scope?.start&&r.parameters?.end_date===r.scope?.end&&r.parameters?.accounting_method===r.scope?.basis,'REPORT_PARAMETERS');
 for(const period of ['month','year'])for(const report of REPORT_NAMES)check(requests.some(r=>r.phase===period&&r.scope.report===report&&r.scope.basis==='Accrual'),'REPORT_VARIANTS');
 check(requests.some(r=>r.phase==='empty-february'&&r.scope.report==='ProfitAndLoss')&&requests.some(r=>r.phase==='cash-basis'&&r.scope.report==='ProfitAndLoss'&&r.scope.basis==='Cash'),'REPORT_CONTROLS');
 const api=await boundApi(config,deps),snapshots=[];
 for(const request of requests){
  const response=await api('GET',`reports/${request.scope.report}`,null,request.parameters);
  const parsed=parseReport(response.raw,request.scope);
  if(request.phase==='empty-february')check(parsed.money_cells.every(c=>BigInt(c.minor)===0n),'FEBRUARY_NONZERO');
  snapshots.push({phase:request.phase,parameters:request.parameters,raw:response.raw,parsed});
 }
 return {schema_version:1,company_fingerprint:config.company_fingerprint,plan_sha256:config.plan_sha256,snapshots,observed_at:new Date((deps.now||Date.now)()).toISOString(),writers_frozen:true,limitation:'Native cash-basis and CashFlow classification require separate reviewed cell bindings.'};
}
export async function captureAnswers(config,cases,readiness,deps={}){
 check(config.test_brain===true&&config.synthetic_only===true,'TEST_BRAIN');
 let base;try{base=new URL(config.brain_base);}catch{throw Error('ORACLE_CLI_BASE');}
 check(base.protocol==='https:'&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','BASE');
 check(readiness?.test_only===true&&readiness.base_sha256===hash(base.origin)&&readiness.implementation_sha===config.implementation_sha&&/^[a-f0-9]{40}$/.test(config.implementation_sha)&&readiness.outbox_pending===0&&readiness.sources_complete===true,'READINESS');
 check(Array.isArray(cases)&&cases.length>0&&new Set(cases.map(c=>c.id)).size===cases.length,'CASES');
 const key=(deps.readAdminKey||readAdminKeyFile)(config.admin_key_file);
 const fetchImpl=deps.fetchImpl||fetch;const rows=[];
 for(const c of cases){
  let response;
  try{
   const raw=await fetchImpl(`${base.origin}/api/rag/think`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{'X-Admin-Key':key,'Content-Type':'application/json','User-Agent':'Mozilla/5.0'},body:JSON.stringify({q:c.question,limit:12})});
   check(raw.ok&&!raw.redirected&&(!raw.url||new URL(raw.url).origin===base.origin),'ANSWER_HTTP');
   response=JSON.parse(await raw.text());
  }catch{throw Error('ORACLE_CLI_ANSWER_REQUEST');}
  rows.push({case_id:c.id,response,response_sha256:hash(JSON.stringify(response)),annotation:null,trace:null});
 }
 return {schema_version:1,cases,responses:rows,evidence:[],run:{implementation_sha:config.implementation_sha,model:config.model||null,configuration_sha256:hash(JSON.stringify({limit:12,model:config.model||null})),observed_at:new Date((deps.now||Date.now)()).toISOString()},needs_independent_review:true};
}
export async function main(args,deps={}){
 const {command,flags}=parseArgs(args);
 if(command==='help'){(deps.log||console.log)('Test-only financial oracle: truth | cases | seed | reports | ask | evaluate. See test/financial-oracle/README.md.');return 0;}
 check(flags.out,'OUTPUT_REQUIRED');privatePath(flags.out);check(!existsSync(flags.out),'OUTPUT_EXISTS');
 let output;
 const phase=selectPhase(fixture,templates,flags.phase||'base');
 if(command==='truth')output=calculate(phase.fixture);
 if(command==='cases')output=phase.cases;
 if(command==='campaign')output=buildCampaign(fixture);
 if(command==='banks')output=bankFixtures(phase.fixture);
 if(command==='score-campaign'){check(flags.input,'INPUT_REQUIRED');output=scoreCampaign(buildCampaign(fixture),readJson(flags.input));}
 if(command==='evaluate'){check(flags.input,'INPUT_REQUIRED');output=evaluate({...readJson(flags.input),cases:phase.cases});}
 if(['seed','reports'].includes(command)){
  check(flags.config,'CONFIG_REQUIRED');const config=readJson(flags.config);
  if(command==='reports'){check(flags.journal,'JOURNAL_REQUIRED');output=await captureReports(config,readJson(privatePath(flags.journal,true)),deps);}
  else if(!flags.apply)output=planSeed(phase.fixture,phase.templates,config);
  else {
   check(flags.journal,'JOURNAL_REQUIRED');const store=privateJournal(flags.journal);
   try{output=await runSeed({fixture:phase.fixture,templates:phase.templates,config,apply:true},{...deps,...store,now:deps.now||Date.now,loadConnection:deps.loadConnection||localLoader(config),api:deps.api||(async connection=>createSandboxApi({realm_id:connection.provider_metadata.realm_id,access_token:connection.access_token,minor_version:config.minor_version}))});}
   finally{store.close();}
  }
 }
 if(command==='ask'){
  check(flags.config&&flags.cases&&flags.readiness,'INPUT_REQUIRED');output=await captureAnswers(readJson(flags.config),readJson(flags.cases),readJson(flags.readiness),deps);
 }
 writeReceipt(flags.out,output);return ['evaluate','score-campaign'].includes(command)&&!output.ready?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=await main(process.argv.slice(2));}catch(error){console.error(/^ORACLE_[A-Z_]+$/.test(error.message)?error.message:'ORACLE_CLI_FAILED');process.exitCode=1;}
}
