import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdIngestLocal as current, credentialScannerFingerprint } from '../brain.mjs';
// Replay the exact 0.4.10 local orchestrator in the current module scope.
// This fixture is immutable; the current-orchestrator arm is the green control.
const brainUrl = new URL('../brain.mjs', import.meta.url);
const frozen = readFileSync(new URL('./fixtures/legacy-local-ingest-run.txt', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(frozen).digest('hex'), 'a4db8ba2860fac4c9483d71ef2d3449a2e97a8be2dd2006417be8f34b5713156');
const currentSource = readFileSync(brainUrl, 'utf8');
const start = currentSource.indexOf('async function cmdIngestLocalRun(');
const end = currentSource.indexOf('\nfunction validateForgetBody(', start);
assert.ok(start > 0 && end > start);
const historicalSource = (currentSource.slice(0, start) + frozen + currentSource.slice(end))
  .replace(/(["'])(\.\.?\/[^"']+\.(?:mjs|js))\1/g, (_match, _quote, path) => JSON.stringify(new URL(path, brainUrl).href))
  .replaceAll('import.meta.url', JSON.stringify(brainUrl.href));
const { cmdIngestLocal: previous, applyDriveRemovals: previousRemovals } =
  await import(`data:text/javascript;base64,${Buffer.from(historicalSource).toString('base64')}`);
import worker from '../worker/src/index.js';
import { ingestPlanStore } from './helpers/ingest-plan-store.mjs';
import { batchStream, splitOversized, prefetch, removedSinceLastRun } from '../ingest/run.mjs';
Date.now = () => Date.parse('2026-10-07T00:00:00Z');

for (const [label,run] of [['current',current],['previous',previous]]) {
 test(`R1 ${label} ordinary folder ingest against the schema-52 Worker`,async()=>{
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'ordinary-ingest-')));
  const manifestPath=join(root,'manifest.json');
  const manifest={brain:{domain:'fixture.invalid'},safety:{ocr:{enabled:false},credential_scanner:{enabled:true}}};
  writeFileSync(manifestPath,JSON.stringify(manifest));
  const adminKeyPath=join(root,'fixture-admin-key');
  writeFileSync(adminKeyPath,randomBytes(32).toString('hex'),{mode:0o600});
  const key=()=>readFileSync(adminKeyPath,'utf8');
  const store=ingestPlanStore();store.env.ADMIN_KEY=key();
  const ids=Array.from({length:20},(_,i)=>`item${i}`);
  for(const id of ids)store.put(`upload:${id}`);
  let state={version:1,done:Object.fromEntries(ids.map(id=>[id,'old-version'])),skipped:{},credential_scanner_fingerprint:credentialScannerFingerprint(true)};
  let decisionReached=0, legacyRequests=0, accepted=0, legacyStatus, legacyBody;
  const fetchImpl=async(url,init)=>{
   assert.equal(new URL(url).pathname,'/api/admin/brain/forget');legacyRequests++;
   const response = await worker.fetch(new Request(url,init),store.env,{waitUntil(){}});
   legacyStatus = response.status; legacyBody = await response.clone().json();
   return response;
  };
  const options={
   withSourceIngestLock:async(_input,task)=>task({assertOwned(){}}),
   resolveBaseUrl:async()=> 'https://fixture.invalid',resolveAdminKey:key,
   launchctl:()=>{throw new Error('injected scheduler refusal');},
   removalPlanRequest:store.request,removalPlanRuntime:()=> 'fixture-runtime',
   ingestLib:async()=>({batchStream,splitOversized,prefetch,removedSinceLastRun,
    loadState:()=>state,saveState:(_path,next)=>{state=next;},
    walk:()=>({files:ids.slice(1).map(rel=>({rel,name:rel})),skipped:[],complete:true}),
    prepare:async file=>({hash:'new-version',envelope:{source_type:'upload',source_id:file.rel,title:'Synthetic document',content:'Readable synthetic content for this offline probe.'}}),
   }),
   listStoredSourceFamilies:async input=>{decisionReached++;return store.inventory(input);},
   sendBatches:async({groups,onResult})=>{for(const item of groups.flat()){accepted++;store.put(`upload:${item.envelope.source_id}`);onResult(item,{status:'updated'});}return {updated:groups.flat().length};},
   reconcileDocumentFamilies:async()=>0,
   applyDriveRemovals:input=>previousRemovals({...input,fetchImpl}),
   postSourceReceipt:async()=>({}),reportBacklog:async()=>({}),
  };
  try{
   let error=null;try{await run(manifest,manifestPath,{source:'upload',path:root},options);}catch(e){error=e;}
   assert.ok(decisionReached>0,'authenticated inventory decision reached');
   assert.equal(accepted,19,'nonempty successful additions reached the removal boundary');
   if(label==='current'){
    assert.equal(error?.code,'SAFETY_REVIEW_REQUIRED');assert.equal(store.calls.preview,1);
    assert.deepEqual(state.ingest_removal_plan.targets,['upload:item0']);
    assert.equal(legacyRequests,0);assert.equal(store.uids().length,20);
    assert.ok(state.done.item1,'accepted state retained');
   } else {
    assert.ok(error, 'old orchestrator must stop after failed exact inventory readback');
    assert.equal(legacyRequests,1,'previous ordinary CLI reached real upgraded Worker');
    assert.equal(legacyStatus,409,'upgraded Worker refuses unplanned legacy mutation');
    assert.equal(legacyBody.code,'INGEST_REMOVAL_PLAN_REQUIRED');
    assert.match(legacyBody.error,/update.*CLI/i);
    assert.equal(store.calls.batches,0,'no delete transaction is authorized');
    assert.ok(state.done.item1,'accepted updates remain checkpointed');
    console.log(`R1 ordinary evidence: accepted=${accepted} legacy_requests=${legacyRequests} remaining=${store.uids().length} plan_requests=${store.calls.preview+store.calls.apply}`);
    assert.equal(store.uids().includes('upload:item0'),true,'upgraded Worker must refuse legacy ordinary-ingest deletion without exact apply');
   }
  }finally{store.db.close();rmSync(root,{recursive:true,force:true});}
 });
}
