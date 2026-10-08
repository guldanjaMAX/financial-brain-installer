// MAIN-only sandbox tooling. Dry-run has no credential or transport capability.
import { hash, parseReport } from './reports.mjs';
import { calculate, decimalMinor } from './ledger.mjs';
import { assertQuickBooksSourceBinding } from '../../connectors/provider-oauth.mjs';
const HOST='https://sandbox-quickbooks.api.intuit.com';
const ENTITY={account:'Account',customer:'Customer',vendor:'Vendor',item:'Item',invoice:'Invoice',payment:'Payment',bill:'Bill',billpayment:'BillPayment',deposit:'Deposit',transfer:'Transfer',journalentry:'JournalEntry',purchase:'Purchase',creditmemo:'CreditMemo',salesreceipt:'SalesReceipt'};
const MONEY=new Set(['Amount','TotalAmt','UnitPrice','ExchangeRate']);
const CONTROL=['ar','ap','undeposited'];
const check=(ok,code)=>{if(!ok)throw Error(`ORACLE_SEED_${code}`);};
const digest=value=>hash(JSON.stringify(value));
export function exactJson(value,key='') {
  if(MONEY.has(key)) { check(typeof value==='string' && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value),'DECIMAL');return value; }
  if(Array.isArray(value))return `[${value.map(v=>exactJson(v)).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).map(([k,v])=>`${JSON.stringify(k)}:${exactJson(v,k)}`).join(',')}}`;
  check(value!==undefined && (typeof value!=='number'||Number.isSafeInteger(value)),'JSON');return JSON.stringify(value);
}
// Quote number tokens before JSON.parse, while leaving quoted source strings
// untouched. This retains large decimal lexemes on Node versions without reviver context.
export function parseExactJson(raw) {
  let out='',i=0;
  while(i<raw.length){
    if(raw[i]==='"') {let j=i+1;for(;j<raw.length;j++){if(raw[j]==='\\'){j++;continue;}if(raw[j]==='"'){j++;break;}}out+=raw.slice(i,j);i=j;}
    else if(/[0-9-]/.test(raw[i])){const m=raw.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);check(m,'JSON');out+=JSON.stringify(m[0]);i+=m[0].length;}
    else out+=raw[i++];
  }
  try{return JSON.parse(out);}catch{throw Error('ORACLE_SEED_JSON');}
}
function refs(value,visit) {
  if(Array.isArray(value))return value.map(v=>refs(v,visit));
  if(value&&typeof value==='object'){
    if(Object.hasOwn(value,'$ref')){check(Object.keys(value).length===1,'REF');return visit(value.$ref);}
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,refs(v,visit)]));
  }
  return value;
}
export function planSeed(fixture,templates,config) {
  check(fixture.synthetic_only===true&&templates.synthetic_only===true&&config.synthetic_only===true,'SYNTHETIC');
  check(config.environment==='sandbox'&&config.api_base===HOST,'SANDBOX');
  check(/^synthetic_[a-z0-9_]{1,40}$/.test(config.run_tag),'RUN_TAG');
  check(/^[a-f0-9]{40}$/.test(config.implementation_sha||''),'IMPLEMENTATION');
  check(/^[a-f0-9]{64}$/.test(config.company_fingerprint)&&/^\d{1,3}$/.test(config.minor_version),'IDENTITY');
  calculate(fixture);
  const steps=[];const known=new Set(['tax.non_taxable',...CONTROL.map(k=>`account.${k}`)]);
  for(const k of CONTROL)check(typeof config.control_accounts?.[k]?.Id==='string'&&config.control_accounts[k].Id.length>0,'CONTROL_ACCOUNT');
  const add=(seed_id,entity,body)=>{
    check(!known.has(seed_id)&&ENTITY[entity],'ENTITY');
    refs(body,k=>{check(known.has(k),'REF_ORDER');return 'verified-id';});
    known.add(seed_id);
    const tag=`${config.run_tag}:${seed_id}`;
    const tag_field=['customer','vendor'].includes(entity)?'Notes':['account','item'].includes(entity)?'Description':'PrivateNote';
    steps.push({seed_id,entity,body:{...body,[tag_field]:tag},tag,tag_field});
  };
  for(const [key,a] of Object.entries(fixture.accounts))if(!CONTROL.includes(key))add(`account.${key}`,'account',{Name:`${config.run_tag} ${key}`,AccountType:a.account_type,...(a.account_subtype?{AccountSubType:a.account_subtype}:{}),CurrencyRef:{value:'USD'}});
  for(const p of ['customer_01','customer_02','customer_03'])add(p,'customer',{DisplayName:`${config.run_tag} ${p}`});
  for(const p of ['vendor_01','vendor_02'])add(p,'vendor',{DisplayName:`${config.run_tag} ${p}`});
  add('item.service','item',{Name:`${config.run_tag} service`,Type:'Service',IncomeAccountRef:{value:{$ref:'account.revenue'}}});
  check(templates.requests.length===21,'TEMPLATES');
  for(const request of templates.requests){
    check(request.method==='POST'&&/^\/v3\/company\/\{sandbox_realm\}\/[a-z]+$/.test(request.path),'PATH');
    add(request.seed_id,request.path.split('/').at(-1),request.body);
  }
  const sha256=digest({fixture,templates,steps,minor_version:config.minor_version,company_fingerprint:config.company_fingerprint,implementation_sha:config.implementation_sha});
  return {schema_version:1,mode:'dry-run',sha256,steps};
}
function subset(expected,actual,key='') {
  if(expected===null || typeof expected!=='object'){
    if(MONEY.has(key)||key==='Balance') {try{return decimalMinor(String(expected),6)===decimalMinor(String(actual),6);}catch{return false;}}
    if(typeof expected==='number')return String(expected)===String(actual);
    return expected===actual;
  }
  if(Array.isArray(expected))return Array.isArray(actual)&&expected.length===actual.length&&expected.every((e,i)=>subset(e,actual[i]));
  return actual&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>subset(v,actual[k],k));
}
export function createSandboxApi({realm_id,access_token,minor_version,fetchImpl=fetch}) {
  check(typeof realm_id==='string'&&/^[A-Za-z0-9._~-]{1,128}$/.test(realm_id),'REALM');
  check(typeof access_token==='string'&&access_token.length>0&&/^\d{1,3}$/.test(minor_version),'ACCESS');
  return async(method,path,body,query={})=>{
    check(['GET','POST'].includes(method)&&/^[a-z]+(?:\/[A-Za-z0-9._~%-]+)?$/.test(path),'PATH');
    check(method!=='POST'||Object.hasOwn(ENTITY,path),'ENTITY');
    const url=new URL(`${HOST}/v3/company/${encodeURIComponent(realm_id)}/${path}`);
    url.searchParams.set('minorversion',minor_version);
    for(const [k,v] of Object.entries(query))url.searchParams.set(k,String(v));
    try{
      const response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${access_token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:exactJson(body)}:{})});
      check(response.ok&&!response.redirected&&(!response.url||new URL(response.url).origin===HOST),'HTTP');
      const raw=await response.text();check(raw.length<=32*1024*1024,'SIZE');const data=parseExactJson(raw);check(!data.Fault,'FAULT');return {data,raw,sha256:hash(raw)};
    }catch{throw Error('ORACLE_SEED_TRANSPORT');}
  };
}
export async function runSeed({fixture,templates,config,apply=false},deps={}) {
  const plan=planSeed(fixture,templates,config);if(!apply)return plan;
  check(config.plan_sha256===plan.sha256,'PLAN_CHANGED');
  check(/^[a-f0-9]{64}$/.test(config.schema_review_sha256||''),'SCHEMA_REVIEW');
  check(config.writers_frozen===true,'WRITERS');
  for(const key of ['loadConnection','api','readJournal','writeJournal','now'])check(typeof deps[key]==='function','DEPENDENCY');
  let connection,binding;
  try{connection=await deps.loadConnection();binding=assertQuickBooksSourceBinding(connection,{source:config.source,environment:'sandbox'});}catch{throw Error('ORACLE_SEED_CONNECTION');}
  check(binding.qbo_company_fingerprint===config.company_fingerprint&&connection.provider_metadata.realm_id===binding.realm_id,'COMPANY');
  check(!connection.quickbooks_refresh_fence && typeof connection.access_token==='string' && Number.isFinite(connection.expires_at) && connection.expires_at>deps.now()+60000,'TOKEN_EXPIRED');
  const api=await deps.api(connection);
  let journal=await deps.readJournal();
  if(journal)check(journal.plan_sha256===plan.sha256&&journal.run_tag===config.run_tag&&journal.company_fingerprint===config.company_fingerprint&&journal.implementation_sha===config.implementation_sha&&Array.isArray(journal.events),'JOURNAL');
  else journal={schema_version:1,run_tag:config.run_tag,plan_sha256:plan.sha256,company_fingerprint:config.company_fingerprint,implementation_sha:config.implementation_sha,steps:{},baseline:null,events:[]};
  let previous=null;
  for(const event of journal.events){const {content_hash,...payload}=event;check(payload.previous_hash===previous&&digest(payload)===content_hash,'JOURNAL_HISTORY');previous=content_hash;}
  const save=async(seed_id=null)=>{
    const row=seed_id?journal.steps[seed_id]:null;
    const event={sequence:journal.events.length+1,recorded_at:new Date(deps.now()).toISOString(),seed_id,state:row?.state||journal.state||'baseline',request_hash:row?.request_hash||null,provider_id:row?.id||null,previous_hash:journal.events.at(-1)?.content_hash||null};
    journal.events.push({...event,content_hash:digest(event)});
    await deps.writeJournal(structuredClone(journal));
  };
  const read=async(entity,id)=>{
    const response=await api('GET',entity==='preferences'?'preferences':`${entity}/${encodeURIComponent(id)}`);const row=response.data[ENTITY[entity]||({companyinfo:'CompanyInfo',preferences:'Preferences',taxcode:'TaxCode'})[entity]];
    check(row && (['preferences','companyinfo'].includes(entity)||row.Id===id),'READBACK');return {row,sha256:response.sha256};
  };
  const company=await read('companyinfo',binding.realm_id);const preferences=await read('preferences',binding.realm_id);
  check(digest(company.row)===config.company_info_sha256&&digest(preferences.row)===config.preferences_sha256,'SETTINGS_CHANGED');
  const map={'tax.non_taxable':config.non_taxable?.Id};
  check(typeof map['tax.non_taxable']==='string'&&config.non_taxable?.Taxable===false,'TAX_CODE');
  const tax=await read('taxcode',map['tax.non_taxable']);check(subset(config.non_taxable,tax.row),'TAX_CODE');
  for(const key of CONTROL){const entry=config.control_accounts[key];const actual=await read('account',entry.Id);check(subset(entry,actual.row)&&actual.row.AccountType===fixture.accounts[key].account_type,'CONTROL_ACCOUNT');map[`account.${key}`]=entry.Id;}
  async function queryAll(entity) {
    const rows=[];const ids=new Set();
    for(let start=1;start<=100001;start+=1000){
      const response=await api('GET','query',null,{query:`select * from ${ENTITY[entity]} STARTPOSITION ${start} MAXRESULTS 1000`});
      const qr=response.data.QueryResponse;check(qr&&typeof qr==='object','QUERY');
      const page=qr[ENTITY[entity]]||[];check(Array.isArray(page)&&page.length<=1000,'QUERY');
      for(const row of page){check(typeof row.Id==='string'&&!ids.has(row.Id),'QUERY_REPEAT');ids.add(row.Id);rows.push(row);}
      if(page.length<1000)return rows;
    }
    throw Error('ORACLE_SEED_QUERY_BOUND');
  }
  if(!journal.baseline){
    check(Array.isArray(config.baseline_reports)&&config.baseline_reports.length===3,'BASELINE');
    check(new Set(config.baseline_reports.map(r=>r.scope.report)).size===3&&['BalanceSheet','TrialBalance','ProfitAndLoss'].every(n=>config.baseline_reports.some(r=>r.scope.report===n)),'BASELINE');
    const reports=[];
    for(const request of config.baseline_reports){const response=await api('GET',`reports/${request.scope.report}`,null,request.parameters);const parsed=parseReport(response.raw,request.scope);check((parsed.no_data||parsed.money_cells.length>0)&&parsed.money_cells.every(c=>BigInt(c.minor)===0n),'BASELINE');reports.push(response.sha256);}
    // An offsetting zero ledger is not an empty denominator. Every posting
    // type used by this seed must be empty; no sample records are deleted.
    for(const entity of Object.keys(ENTITY)){
      const rows=await queryAll(entity);
      if(!['account','customer','vendor','item'].includes(entity))check(rows.length===0,'BASELINE_TRANSACTIONS');
      check(!rows.some(r=>[r.PrivateNote,r.Notes,r.Description].some(s=>typeof s==='string'&&s.startsWith(`${config.run_tag}:`))),'ORPHAN_TAG');
    }
    journal.baseline={reports,company:company.sha256,preferences:preferences.sha256};await save();
  }
  const receipt=[];
  for(const step of plan.steps){
    const body=refs(step.body,k=>{check(typeof map[k]==='string'&&map[k].length>0,'REF');return map[k];});
    const request_hash=hash(exactJson(body));let record=journal.steps[step.seed_id];
    if(record)check(record.request_hash===request_hash,'REQUEST_CHANGED');
    else {record={request_hash,state:'pending',id:null};journal.steps[step.seed_id]=record;await save(step.seed_id);
      try{const response=await api('POST',step.entity,body,{requestid:hash(`${config.run_tag}:${step.seed_id}:${request_hash}`).slice(0,40)});const row=response.data[ENTITY[step.entity]];check(typeof row?.Id==='string'&&row.Id.length>0,'CREATE');record.id=row.Id;record.response_hash=response.sha256;record.state='created';await save(step.seed_id);}catch{throw Error('ORACLE_SEED_CREATE_UNCERTAIN');}
    }
    if(!record.id){
      const matches=(await queryAll(step.entity)).filter(r=>r[step.tag_field]===step.tag);
      check(matches.length===1&&subset(body,matches[0]),'PENDING_UNRESOLVED');
      record.id=matches[0].Id;record.state='recovered';await save(step.seed_id);
    }
    const actual=await read(step.entity,record.id);
    check(subset(body,actual.row)&&typeof actual.row.SyncToken==='string','READBACK');
    record.state='verified';record.readback_hash=actual.sha256;record.sync_token=actual.row.SyncToken;await save(step.seed_id);
    map[step.seed_id]=record.id;receipt.push({seed_id:step.seed_id,id:record.id,request_hash,readback_hash:record.readback_hash,sync_token:record.sync_token});
  }
  const truth=calculate(fixture);let checked=0;
  for(const e of fixture.events.filter(e=>['Invoice','Bill'].includes(e.api_entity))){
    const actual=await read(e.api_entity.toLowerCase(),map[e.id]);const expected=truth.open_items.find(i=>i.id===e.id)?.minor||'0';
    check(typeof actual.row.Balance==='string'&&decimalMinor(actual.row.Balance,2)===BigInt(expected),'OPEN_BALANCE');checked++;
  }
  const credit=await read('creditmemo',map.S05);
  check(typeof credit.row.RemainingCredit==='string'&&decimalMinor(credit.row.RemainingCredit,2)===0n,'CREDIT_APPLICATION');
  journal.state='readback_verified';journal.open_items_checked=checked;await save();
  return {schema_version:1,state:'readback_verified',implementation_sha:config.implementation_sha,journal_head:journal.events.at(-1).content_hash,run_tag:config.run_tag,plan_sha256:plan.sha256,company_fingerprint:config.company_fingerprint,baseline:journal.baseline,steps:receipt,open_items_checked:checked,completed_at:new Date(deps.now()).toISOString(),limitation:'Entity readback only. Reports, bank adapters, ingest and answer gates remain separate.'};
}
