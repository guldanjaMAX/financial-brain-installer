import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startBrowserHarness, deferred, bounded, renderSettled } from './browser-harness.mjs';
const requestedOutput=process.env.BRAIN_BROWSER_OUTPUT_DIR?.trim();
const out=requestedOutput?path.join(path.resolve(requestedOutput),'owner-upload'):fs.mkdtempSync(path.join(tmpdir(),'brain-owner-upload-'));
fs.mkdirSync(out,{recursive:true});
const phase='browser';
const checks=[];
const entities=['alpha','beta'].map(name=>({entity_slug:`company-${name}`,label:`Company ${name}`,legal_name:`Company ${name}`,kind:'business',status:'active',relationship:'owned',counterparty:false}));
const capabilities={supported_media_types:['text/plain','text/markdown'],supported_extensions:['.txt','.md'],media_type_extensions:{'text/plain':['.txt'],'text/markdown':['.md']},max_content_bytes:1000000,content_encoding:'utf-8',empty_media_type_supported:false};
const syntheticFile=name=>({name:`${name}-synthetic.txt`,mimeType:'text/plain',buffer:Buffer.from(`Synthetic ${name} fixture only. The reading room has a green table and a copper lamp.`)});
const harness=await startBrowserHarness();
const allWrites=[];
const check=(name,passed)=>checks.push({name,passed:Boolean(passed)});
async function fresh(options={}){
 const page=await harness.newPage();
 await page.addInitScript(()=>sessionStorage.setItem('financial-brain:entity-scope','company-alpha'));
 const arrival=deferred(), released=deferred();
 const state={writes:[],release:released.resolve,arrived:arrival.promise};
 await page.route('**/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname;
  const body=route.request().postDataJSON()||{};
  let response;
  if(endpoint==='/api/fin/snapshot')response={ledger_installed:true,entities,sections_unavailable:[],unavailable:false};
  else if(endpoint==='/api/owner/preferences/read')response={preferences:[]};
  else if(endpoint==='/api/owner/uploads/capabilities')response=capabilities;
  else if(endpoint==='/api/owner/uploads'){
   state.writes.push(body);allWrites.push({entity:body.entity_slug,file:body.file_name});
   if(options.hold){arrival.resolve();await bounded(released.promise,'Synthetic upload was never released');}
   response={uploaded:true,request_id:body.request_id,document_id:body.document_id,entity_scope:{entity_slug:options.badReceipt?'company-wrong':body.entity_slug},media_type:body.media_type,file_name:body.file_name,document:{action:'created',doc_uid:body.document_id,chunks:1,queued:1},changed:true,activity_event_id:'synthetic-event',replayed:false};
  }else throw new Error(`Unexpected synthetic endpoint ${endpoint}`);
  try{await route.fulfill({json:response});}catch{}
 });
 await page.goto(new URL('/test/browser/fixtures/owner-upload.html',harness.origin).href);
 await page.getByRole('button',{name:'Company alpha',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('input[type=file]')?.disabled===false);
 return {page,state};
}
try{
 {
  const {page,state}=await fresh();
  await page.locator('input[type=file]').setInputFiles(syntheticFile('alpha'));
  await page.getByRole('button',{name:'Company beta',exact:true}).click();
  await page.locator('input[type=file]').waitFor();
  await renderSettled(page);
  check('A file is cleared on B selection',await page.locator('input[type=file]').evaluate(el=>el.files.length===0));
  check('B requires a fresh file before upload',await page.getByRole('button',{name:'Add text record',exact:true}).isDisabled());
  if(!await page.getByRole('button',{name:'Add text record',exact:true}).isDisabled()){
   await page.getByRole('button',{name:'Add text record',exact:true}).click();
   await page.getByText('The brain confirmed the text was stored and recorded the change.',{exact:true}).waitFor();
  }
  check('switch alone cannot submit A staged text under B',!state.writes.some(w=>w.entity_slug==='company-beta'&&w.file_name==='alpha-synthetic.txt'));
  await page.getByRole('button',{name:'Company alpha',exact:true}).click();
  await page.locator('input[type=file]').waitFor();
  await renderSettled(page);
  check('A-B-A cannot revive the old file',await page.locator('input[type=file]').evaluate(el=>el.files.length===0));
  await page.screenshot({path:path.join(out,`upload-${phase}-desktop.png`),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(out,`upload-${phase}-mobile.png`),fullPage:true});
  check('mobile has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.close();
 }
 {
  const {page,state}=await fresh({hold:true});
  await page.locator('input[type=file]').setInputFiles(syntheticFile('alpha'));
  await page.getByRole('button',{name:'Add text record',exact:true}).click();
  await bounded(state.arrived,'Synthetic upload did not arrive');
  await page.getByRole('button',{name:'Company beta',exact:true}).click();
  await page.locator('input[type=file]').waitFor();
  await renderSettled(page);
  const canSelect=await page.locator('input[type=file]').isEnabled();
  check('B editor is independent of pending A request',canSelect);
  if(canSelect)await page.locator('input[type=file]').setInputFiles(syntheticFile('beta'));
  const responseArrived=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/owner/uploads');
  state.release();
  const response=await responseArrived;
  await response.finished();
  await renderSettled(page);
  check('started request stays bound to A',state.writes.length===1&&state.writes[0].entity_slug==='company-alpha');
  check('late A completion cannot publish success in B',await page.getByText('The brain confirmed the text was stored and recorded the change.',{exact:true}).count()===0);
  check('late A completion cannot run current-page callback',await page.evaluate(()=>window.__uploadCompleted===0));
  check('late A completion cannot clear newly staged B file',canSelect&&await page.locator('input[type=file]').evaluate(el=>el.files[0]?.name==='beta-synthetic.txt'));
  await page.close();
 }
 {
  const {page,state}=await fresh({badReceipt:true});
  await page.locator('input[type=file]').setInputFiles(syntheticFile('alpha'));
  await page.getByRole('button',{name:'Add text record',exact:true}).click();
  await page.getByText(/did not return a common-ingestion receipt/).waitFor();
  check('wrong entity receipt is refused',await page.evaluate(()=>window.__uploadCompleted===0)&&await page.locator('input[type=file]').evaluate(el=>el.files.length===1));
  check('receipt refusal retains original entity-bound request',state.writes.length===1&&state.writes[0].entity_slug==='company-alpha');
  await page.close();
 }
 {
  const {page,state}=await fresh();
  await page.locator('input[type=file]').setInputFiles(syntheticFile('alpha'));
  await page.getByRole('button',{name:'Add text record',exact:true}).click();
  await page.getByText('The brain confirmed the text was stored and recorded the change.',{exact:true}).waitFor();
  check('ordinary valid upload still completes once',state.writes.length===1&&await page.evaluate(()=>window.__uploadCompleted===1));
  await page.close();
 }
 {
  const {page,state}=await fresh();
  await page.locator('input[type=file]').setInputFiles(syntheticFile('alpha'));
  await page.getByRole('button',{name:'Whole Brain',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('input[type=file]')?.disabled===true);
  await renderSettled(page);
  const wholeBrainCleared=await page.locator('input[type=file]').evaluate(el=>el.files.length===0);
  await page.getByRole('button',{name:'Company beta',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('input[type=file]')?.disabled===false);
  await renderSettled(page);
  check('A-whole-Brain-B clears file and requires fresh selection',
   wholeBrainCleared&&state.writes.length===0&&
   await page.locator('input[type=file]').evaluate(el=>el.files.length===0)&&
   await page.getByRole('button',{name:'Add text record',exact:true}).isDisabled());
  await page.close();
 }
 {
  const {page,state}=await fresh();
  // Pause the actual readOwnerTextFile path. The file is selected under A, but
  // no upload request has started when the owner changes scope. Track browser
  // fetch attempts as well as intercepted requests so absence is not a race
  // against delivery to the Node-side route handler.
  await page.evaluate(()=>{
   const read=File.prototype.arrayBuffer;
   const digest=crypto.subtle.digest.bind(crypto.subtle);
   const fetchImpl=window.fetch.bind(window);
   window.__heldReadStarted=false;
   window.__heldReadDigestComplete=false;
   window.__uploadPostAttempts=0;
   File.prototype.arrayBuffer=function(){
    if(this.name!=='alpha-synthetic.txt')return read.call(this);
    window.__heldReadStarted=true;
    return new Promise((resolve,reject)=>{
     window.__releaseFileRead=()=>read.call(this).then(resolve,reject);
    });
   };
   crypto.subtle.digest=async function(algorithm,data){
    const result=await digest(algorithm,data);
    if(new TextDecoder().decode(data)==='company-alpha\nalpha-synthetic.txt'){
     window.__heldReadDigestComplete=true;
    }
    return result;
   };
   window.fetch=function(input,options){
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.pathname==='/api/owner/uploads')window.__uploadPostAttempts++;
    return fetchImpl(input,options);
   };
  });
  await page.locator('input[type=file]').setInputFiles(syntheticFile('alpha'));
  await page.getByRole('button',{name:'Add text record',exact:true}).click();
  await page.waitForFunction(()=>window.__heldReadStarted===true);
  assert.equal(state.writes.length,0,'held file read unexpectedly started an upload');
  await page.getByRole('button',{name:'Company beta',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('input[type=file]')?.disabled===false);
  await page.locator('input[type=file]').setInputFiles(syntheticFile('beta'));
  await page.evaluate(()=>window.__releaseFileRead());
  // Observe the last awaited operation before the active-editor guard, then
  // allow its continuation/render to finish. No arbitrary network sleep.
  await page.waitForFunction(()=>window.__heldReadDigestComplete===true);
  await renderSettled(page);
  check('late A file read starts no upload and preserves B draft',
   state.writes.length===0&&
   await page.evaluate(()=>window.__uploadPostAttempts===0&&window.__uploadCompleted===0)&&
   await page.locator('input[type=file]').evaluate(el=>el.files[0]?.name==='beta-synthetic.txt')&&
   await page.getByRole('button',{name:'Add text record',exact:true}).isEnabled());
  await page.close();
 }
 fs.writeFileSync(path.join(out,`upload-${phase}.json`),JSON.stringify({local_only:true,synthetic_only:true,phase,checks,synthetic_writes:allWrites},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({phase,passed:checks.filter(x=>x.passed).length,total:checks.length,checks}));
 assert.ok(checks.every(x=>x.passed),'one or more upload scope boundaries failed');
}finally{
 try{await harness.close();}
 finally{if(!requestedOutput)fs.rmSync(out,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
