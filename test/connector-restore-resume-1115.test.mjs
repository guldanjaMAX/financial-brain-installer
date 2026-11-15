import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/gmail-batch-fixture.mjs';
import { ingestPlanStore } from './helpers/ingest-plan-store.mjs';
import { storeFor } from '../worker/src/lib/store.js';
import { splitOversized, batchStream } from '../ingest/run.mjs';
import { driveIncrementalCommand } from '../operations/drive-incremental.mjs';
import { handleIngestPartProof } from '../worker/src/lib/ingest-part-proof.js';
import { readCurrentIngestParts, revalidateIngestProgress } from '../operations/ingest-part-proof.mjs';
import worker from '../worker/src/index.js';
import { randomBytes } from 'node:crypto';

globalThis.fetch = async () => { throw new Error('Unexpected network attempt'); };

const content = 'Synthetic correspondence with a qualification in every physical part. '.repeat(8).slice(0, 384);

function databaseCut(store) {
  return { documents:store.db.prepare('SELECT * FROM documents').all(),
    chunks:store.db.prepare('SELECT * FROM chunks').all(),
    marker:store.db.prepare('SELECT * FROM ingest_removal_generation').get() };
}
function restoreCut(store, cut) {
  store.db.exec('DELETE FROM chunks; DELETE FROM documents;');
  for (const table of ['documents','chunks']) for (const row of cut[table]) {
    const keys=Object.keys(row);
    store.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
  }
  const m=cut.marker;
  store.db.prepare('UPDATE ingest_removal_generation SET instance=?,nonce=?,generation=? WHERE id=1').run(m.instance,m.nonce,m.generation);
}
function gmailStorage(f, store) {
  const writer=storeFor(store.env);
  f.ingestOverrides={splitOversized:e=>splitOversized(e,128),
    batchStream:(files,prepare,opts)=>batchStream(files,prepare,{...opts,maxDocs:1})};
  f.inventory=async args=>new Set([...(await store.inventory({source:'gmail'}))].filter(uid=>args.uids.includes(uid)));
  f.partProof=(url,options)=>handleIngestPartProof(store.env,new Request(url,options));
  f.respond=async docs=>{
    const results=[];
    for(const doc of docs){const r=await writer.ingest(store.env,doc);results.push({source_id:doc.source_id,status:r.action,chunks:r.chunks});f.afterWrite?.();}
    return Response.json({results});
  };
  f.history=async (_token,from)=>({ids:from==='prior'?f.ids:[],deletedIds:[],historyId:'next',hasMore:false});
}

for(const restore of [true,false]) test(`R2 F1 Gmail accepted prefix outside inventory slice: ${restore?'restore':'control'}`,async()=>fixture(async f=>{
  const store=ingestPlanStore(); gmailStorage(f,store);
  f.ids=Array.from({length:98},(_,i)=>`entry-${String(i).padStart(3,'0')}`);
  f.content=id=>id===f.ids[0]?content:'Synthetic complete record.';
  let cut,clock=0;
  f.afterWrite=()=>{cut ||= databaseCut(store);};
  const inventory=f.inventory;
  f.inventory=async args=>{const found=await inventory(args);clock+=110;return found;};
  f.options={deferGmailRemovals:true,ingestNowMs:()=>clock,ingestDeadlineAt:300};
  try {
    const first=await f.once(); assert.equal(first.error,null,first.error?.message);
    assert.equal(Object.keys(first.state.gmail_accepted_parts).length,97,'prefix acceptance earned through the real writer');
    assert.deepEqual(first.state.gmail_batch_window.remaining_ids,[f.ids[97]]);
    assert.equal(first.state.gmail_batch_window.inventory.next,97,'saved inventory suffix is real');
    if(restore) restoreCut(store,cut);
    const before=f.calls.length;clock=0;
    const resumed=await f.once();assert.equal(resumed.error,null,resumed.error?.message);
    assert.ok(f.calls.slice(before).flat().includes(f.ids[97]),'last original pending identity reached the writer');
    if(restore && store.uids().length<100) {
      assert.ok(resumed.state.gmail_batch_window?.remaining_ids.includes(f.ids[0]) || resumed.state.gmail_retry?.[`gmail:${f.ids[0]}`],
        'unconfirmed prefix must survive as durable recovery debt');
      assert.notEqual(resumed.receipt.status,'ready','suffix proof cannot certify restored prefix');
    }
    for(let run=0;run<8 && (f.state().gmail_batch_window || f.state().gmail_retry);run++){clock=0;const r=await f.once();assert.equal(r.error,null,r.error?.message);}
    assert.equal(store.uids().length,100,'all current physical parts repaired before recovery finishes');
    assert.equal(f.state().history_id,'next');
    if(!restore) assert.deepEqual(f.calls.slice(before).flat(),[f.ids[97]],'no-restore prefix is never resent');
    assert.equal(f.forgotten,0);
  } finally {store.db.close();}
}));

function driveStorage(store) {
  const writer=storeFor(store.env),sent=[],saves=[],receipts=[];
  const files=['first','second'].map(id=>({id,name:'Synthetic record',parents:['reviewed'],mimeType:'text/plain'}));
  const state={done:{},skipped:{},sync_token:'before',credential_scanner_fingerprint:'scanner'};
  const args={state,sourceName:'drive',policy:{},policyFingerprint:'policy',scannerOn:true,scannerFingerprint:'scanner',
    base:'https://fixture.invalid',save:()=>saves.push({state:structuredClone(state),cut:databaseCut(store)}),getToken:async()=>undefined,
    request:(url,options)=>handleIngestPartProof(store.env,new Request(url,options)),
    drive:{FOLDER_MIME:'folder',getFileMetadata:async(_get,id)=>files.find(f=>f.id===id),isPermanentFileFailure:()=>false,
      changeScope:async()=>({inScope:true,folders:{},rootIds:['reviewed']}),folderPathFor:()=>'',exclusionReason:()=>null,
      driveVersion:()=> 'revision-b',toEnvelope:async(_get,file)=>({version:'revision-b',envelope:{source_type:'drive',source_id:file.id,content,metadata:{}}}),
      listChangePage:async(_get,token)=>({changes:token==='before'?files.map(file=>({fileId:file.id,file})):[],nextToken:'after',terminal:true})},
    now:()=>Date.parse('2026-11-01T00:00:00Z'),flags:{},write:()=>{},display:String,
    sanitize:e=>e,refusalOf:()=>null,splitOversized:e=>[e],batchStream,
    sendBatches:async({groups,onResult,saveState})=>{
      for(const {envelope} of groups.flat()){sent.push(envelope.source_id);const r=await writer.ingest(store.env,envelope);onResult({envelope},{status:r.action});}
      saveState();return {created:groups.flat().length};
    },rememberAccepted:(_state,plan)=>{state.done[plan.stateKey]=plan.hash;},
    rememberFamily:plans=>{state.ingest_pending_families ||= {};for(const p of plans) state.ingest_pending_families[p.stateKey]={stateKey:p.stateKey,hash:p.hash,family:p};},
    acknowledgeOcr:async()=>{},receipt:async r=>{receipts.push(r);},readDriveFamily:async()=>true};
  return {args,state,sent,saves,receipts,writer};
}

for(const restore of [true,false]) test(`R2 F2 Drive saved page prefix: ${restore?'restore':'control'}`,async()=>{
  const store=ingestPlanStore(),h=driveStorage(store);
  try {
    await h.writer.ingest(store.env,{source_type:'drive',source_id:'first',content:'Synthetic older revision.',metadata:{}});
    const cut=databaseCut(store);
    await driveIncrementalCommand({...h.args,limits:{maxFiles:1}});
    assert.equal(h.state.drive_change_page.offset,1,'real prefix checkpoint reached');
    assert.equal(h.state.done['drive:first'],'revision-b');
    assert.deepEqual(h.state.drive_pending_removals,{},'single-family proof cleared its hold');
    if(restore) restoreCut(store,cut);
    const before=h.sent.length;
    const result=await driveIncrementalCommand(h.args);
    assert.ok(h.sent.slice(before).includes('second'),'saved suffix reached the real writer');
    assert.equal(result.complete,true);
    const text=store.db.prepare("SELECT text FROM chunks WHERE doc_uid='drive:first'").get().text;
    assert.ok(text.endsWith(content),'page settlement must prove revision B in the current database');
    assert.equal(h.sent.filter(id=>id==='first').length,restore?2:1,'control never replays accepted prefix');
  } finally {store.db.close();}
});

test('R2 Gmail restore sweep covers every actual checkpoint and its no-restore control',async t=>{
  const checkpoints=[];
  let empty;
  await fixture(async f=>{
    const store=ingestPlanStore();gmailStorage(f,store);
    f.ids=['first','second'];f.content=id=>id==='first'?content:'Synthetic complete record.';
    let clock=0;
    f.options={deferGmailRemovals:true,ingestNowMs:()=>clock,ingestDeadlineAt:300}; empty=databaseCut(store);
    f.afterWrite=()=>{clock+=100;};
    f.beforeSave=state=>checkpoints.push({state:structuredClone(state),cut:databaseCut(store)});
    try {
      assert.equal((await f.once()).error,null);
      assert.ok(f.state().gmail_batch_window,'injected deadline reached a real saved window');
      f.options={deferGmailRemovals:true};f.afterWrite=null;
      assert.equal((await f.once()).error,null);
      assert.equal(f.state().history_id,'next');
      assert.equal(store.uids().length,4,'green discovery reached physical acceptance and cursor settlement');
    } finally {store.db.close();}
  });
  assert.ok(checkpoints.length>10);
  let different=0,totalRestore=0,totalControl=0;
  for(let at=0;at<checkpoints.length;at++) {
    const sends=[];
    for(const restore of [true,false]) await t.test(`checkpoint ${at+1}/${checkpoints.length} ${restore?'restore':'control'}`,async()=>fixture(async f=>{
      const store=ingestPlanStore();gmailStorage(f,store);
      f.ids=['first','second'];f.content=id=>id==='first'?content:'Synthetic complete record.';
      f.options={deferGmailRemovals:true};
      f.setState(structuredClone(checkpoints[at].state));
      restoreCut(store,restore?empty:checkpoints[at].cut);
      let runs=0;
      try {
        do {
          const r=await f.once();assert.equal(r.error,null,r.error?.message);runs++;
          if(r.receipt.status==='ready') assert.equal(store.uids().length,4,'ready never precedes complete current storage');
        } while(runs<8 && (f.state().history_id!=='next' || f.state().gmail_batch_window || f.state().gmail_retry));
        assert.equal(store.uids().length,4,'all restored physical parts are recovered even after the old window closed');
        assert.equal(f.state().history_id,'next');assert.equal(f.state().gmail_retry,undefined);
        const proof=await readCurrentIngestParts({base:'https://fixture.invalid',source:'gmail',
          envelopes:splitOversized({source_type:'gmail',source_id:'first',content},128),
          request:(url,options)=>handleIngestPartProof(store.env,new Request(url,options))});
        assert.equal(proof.parts.length,3,'exact physical hashes and readable text survived');
        assert.equal(f.forgotten,0);assert.ok(store.calls.batches>0,'real current-database proof decision reached');
        sends.push(f.calls.flat().length);
      } finally {store.db.close();}
    }));
    totalRestore+=sends[0];totalControl+=sends[1];if(sends[0]!==sends[1]) different++;
  }
  assert.ok(different>0 && totalRestore>totalControl,'restore/control arms must differ after earned acceptance');
  t.diagnostic(JSON.stringify({checkpoints:checkpoints.length,arms:checkpoints.length*2,different,totalRestore,totalControl}));
});

test('R2 Drive restore sweep covers every actual checkpoint and its no-restore control',async t=>{
  const baseline=ingestPlanStore(),h=driveStorage(baseline),empty=databaseCut(baseline);
  let checkpoints;
  try {
    await driveIncrementalCommand({...h.args,limits:{maxFiles:1}});
    assert.equal(h.state.drive_change_page.offset,1,'green discovery reached saved prefix');
    assert.equal((await driveIncrementalCommand(h.args)).complete,true);
    checkpoints=h.saves;
    assert.equal(baseline.uids().length,2,'green discovery reached terminal physical acceptance');
  } finally {baseline.db.close();}
  assert.ok(checkpoints.length>10);
  let different=0,totalRestore=0,totalControl=0;
  for(let at=0;at<checkpoints.length;at++) {
    const sends=[];
    for(const restore of [true,false]) await t.test(`checkpoint ${at+1}/${checkpoints.length} ${restore?'restore':'control'}`,async()=>{
      const store=ingestPlanStore(),arm=driveStorage(store);
      Object.assign(arm.state,structuredClone(checkpoints[at].state));
      restoreCut(store,restore?empty:checkpoints[at].cut);
      let result;
      try {
        for(let run=0;run<8;run++) {
          result=await driveIncrementalCommand(arm.args);
          if(result.complete) {assert.equal(store.uids().length,2,'ready never precedes complete current storage');break;}
        }
        assert.equal(result.complete,true);assert.equal(arm.state.sync_token,'after');
        for(const id of ['first','second']) assert.ok(store.db.prepare('SELECT text FROM chunks WHERE doc_uid=?').get(`drive:${id}`).text.endsWith(content));
        assert.deepEqual(arm.state.drive_restore_pending,{});
        assert.ok(store.calls.batches>0,'real current-database proof decision reached');
        sends.push(arm.sent.length);
      } finally {store.db.close();}
    });
    totalRestore+=sends[0];totalControl+=sends[1];if(sends[0]!==sends[1]) different++;
  }
  assert.ok(different>0 && totalRestore>totalControl,'restore/control arms must differ after earned acceptance');
  t.diagnostic(JSON.stringify({checkpoints:checkpoints.length,arms:checkpoints.length*2,different,totalRestore,totalControl}));
});

test('R2 shared proof continuation is bounded, restarts on a fork, and repairs an unchanged feed',async()=>{
  const store=ingestPlanStore(),h=driveStorage(store);
  try {
    await driveIncrementalCommand(h.args);
    const proofs=h.state.drive_accepted_parts;
    delete h.state.drive_progress_recheck;
    const request=(url,options)=>handleIngestPartProof(store.env,new Request(url,options));
    const args={state:h.state,source:'drive',proofs,checkpointKey:'drive_progress_recheck',policyFingerprint:'policy',
      maxEntries:1,read:input=>readCurrentIngestParts({base:'https://fixture.invalid',source:'drive',request,...input}),
      save:()=>{},invalidate:uid=>{delete h.state.done[uid];h.state.drive_restore_pending[uid]={id:uid.slice(6)};}};
    assert.equal(await revalidateIngestProgress(args),false);
    assert.equal(h.state.drive_progress_recheck.after,'drive:first','real bounded prefix decision reached');
    const marker=databaseCut(store).marker;
    store.db.exec("DELETE FROM chunks WHERE doc_uid='drive:first'; DELETE FROM documents WHERE doc_uid='drive:first';");
    store.db.prepare('UPDATE ingest_removal_generation SET generation=?,nonce=? WHERE id=1').run(marker.generation,'a'.repeat(32));
    assert.equal(await revalidateIngestProgress(args),false);
    assert.ok(h.state.drive_restore_pending['drive:first'],'fork rechecks the earlier accepted prefix');
    assert.equal(await revalidateIngestProgress(args),true,'second bounded slice completes');
    const before=h.sent.length;
    const repaired=await driveIncrementalCommand(h.args);
    assert.equal(repaired.complete,true);assert.deepEqual(h.sent.slice(before),['first'],'empty feed still repairs durable debt');
    assert.equal(store.uids().length,2);
    const controlBefore=h.sent.length;
    assert.equal((await driveIncrementalCommand(h.args)).complete,true);
    assert.equal(h.sent.length,controlBefore,'intact green control sends nothing');
  } finally {store.db.close();}
});

test('R2 completed proof sweep cannot survive changed policy or legacy empty proof at the same database cut',async()=>{
  const store=ingestPlanStore(),h=driveStorage(store);
  try {
    await driveIncrementalCommand(h.args);
    assert.equal((await driveIncrementalCommand(h.args)).complete,true,'green control earns a complete audit');
    const before=h.sent.length;
    h.args.policyFingerprint='new-policy';
    assert.equal((await driveIncrementalCommand(h.args)).complete,true);
    assert.equal(h.sent.length-before,2,'policy change reached revalidation and replayed both identities');
    h.state.drive_accepted_parts['drive:first'].parts=[];
    const again=h.sent.length;
    assert.equal((await driveIncrementalCommand(h.args)).complete,true);
    assert.deepEqual(h.sent.slice(again),['first'],'legacy empty proof becomes retry work rather than a permanent audit stall');
    const control=h.sent.length;
    assert.equal((await driveIncrementalCommand(h.args)).complete,true);
    assert.equal(h.sent.length,control,'intact control reuses both versions');
  } finally {store.db.close();}
});

for (const restore of [true, false]) test(`F2 Gmail restore/resume: ${restore ? 'restored prefix' : 'no-restore control'}`, async () => fixture(async f => {
  const store = ingestPlanStore();
  const writer = storeFor(store.env);
  f.ids = ['split-entry'];
  f.content = content;
  f.captureSaves = false;
  f.ingestOverrides = { splitOversized: e => splitOversized(e, 128),
    batchStream: (files, prepare, opts) => batchStream(files, prepare, { ...opts, maxDocs: 1 }) };
  let clock = 0, checkpoint;
  f.options = { deferGmailRemovals: true, ingestNowMs: () => clock, ingestDeadlineAt: 200 };
  f.inventory = async args => {
    const present = await store.inventory({ source: 'gmail' });
    return new Set([...present].filter(uid => args.uids.includes(uid)));
  };
  f.partProof = (url,options) => handleIngestPartProof(store.env,new Request(url,options));
  f.respond = async docs => {
    const results = [];
    for (const doc of docs) {
      const result = await writer.ingest(store.env, doc);
      results.push({ source_id: doc.source_id, status: result.action, chunks: result.chunks });
      if (!checkpoint) checkpoint = {
        documents: store.db.prepare('SELECT * FROM documents').all(),
        chunks: store.db.prepare('SELECT * FROM chunks').all(),
        marker: store.db.prepare('SELECT * FROM ingest_removal_generation').get(),
      };
      clock += 100;
    }
    return Response.json({ results });
  };
  try {
    const first = await f.once();
    assert.equal(first.error, null, first.error?.message);
    assert.equal(f.calls.length, 2, 'two real Worker storage acceptances reached the local checkpoint');
    assert.equal(Object.keys(first.state.gmail_part_progress['gmail:split-entry'].parts).length, 2);
    assert.equal(first.state.done['gmail:split-entry'], undefined);
    if (restore) {
      // Restore authoritative text and its exact pre-second-part generation.
      // Local connector state deliberately remains newer than this recovery cut.
      store.db.exec('DELETE FROM chunks; DELETE FROM documents;');
      for (const table of ['documents', 'chunks']) for (const row of checkpoint[table]) {
        const keys = Object.keys(row);
        store.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
      }
      const m = checkpoint.marker;
      store.db.prepare('UPDATE ingest_removal_generation SET instance=?,nonce=?,generation=? WHERE id=1').run(m.instance,m.nonce,m.generation);
    }
    assert.deepEqual(await f.inventory({uids:['gmail:split-entry']}), new Set(['gmail:split-entry']), 'nonempty actual D1 family inventory reaches the vulnerable decision');
    f.options.ingestDeadlineAt = 1000;
    const second = await f.once();
    assert.equal(second.error, null, second.error?.message);
    assert.ok(f.calls.slice(2).flat().includes('split-entry#part3of3'), 'new pending part was dispatched');
    assert.deepEqual(f.calls.slice(2).flat(), restore ? ['split-entry#part2of3','split-entry#part3of3'] : ['split-entry#part3of3']);
    assert.deepEqual(store.uids(), [1,2,3].map(i=>`gmail:split-entry#part${i}of3`), 'settlement requires every physical identity in current D1');
    for (const part of splitOversized({source_type:'gmail',source_id:'split-entry',content},128)) {
      const row = store.db.prepare('SELECT text FROM chunks WHERE doc_uid=?').get(`gmail:${part.source_id}`);
      assert.ok(row.text.endsWith(part.content.trim()), 'current D1 contains exact source part text');
    }
    assert.equal(second.state.done['gmail:split-entry'], 'revision');
    assert.equal(second.state.history_id, 'next');
    const proof=second.state.gmail_accepted_parts['gmail:split-entry'];
    const marker=store.db.prepare('SELECT instance,nonce,generation FROM ingest_removal_generation').get();
    assert.deepEqual({...proof.database},{...marker},'settled receipt binds to the current database cut');
    if(restore) store.db.exec("DELETE FROM chunks WHERE doc_uid='gmail:split-entry#part2of3'; DELETE FROM documents WHERE doc_uid='gmail:split-entry#part2of3';");
    const before=f.calls.length;
    f.options.ingestDeadlineAt=2000;
    const third=await f.once();assert.equal(third.error,null,third.error?.message);
    assert.equal(f.calls.length>before,restore,'same-revision done shortcut also requires current part proof');
    assert.equal(store.uids().length,3);
    assert.equal(third.state.done['gmail:split-entry'],'revision');
    assert.equal(f.forgotten, 0);
  } finally { store.db.close(); }
}));

for (const restore of [true, false]) test(`F2 Drive accepted version: ${restore ? 'restored part' : 'no-restore control'}`, async () => {
  const store = ingestPlanStore(), writer = storeFor(store.env);
  const state = { done:{}, skipped:{}, sync_token:'prior', credential_scanner_fingerprint:'scanner' };
  const sent = [], file = {id:'entry',name:'Synthetic record',parents:['reviewed'],mimeType:'text/plain'};
  const args = {
    state, sourceName:'drive', policy:{}, policyFingerprint:'policy', scannerOn:true, scannerFingerprint:'scanner',
    base:'https://fixture.invalid', save:()=>{}, getToken:async()=>undefined,
    request:(url,options)=>handleIngestPartProof(store.env,new Request(url,options)),
    drive:{ FOLDER_MIME:'folder', getFileMetadata:async()=>file, isPermanentFileFailure:()=>false,
      changeScope:async()=>({inScope:true,folders:{},rootIds:['reviewed']}), folderPathFor:()=>'', exclusionReason:()=>null,
      driveVersion:()=> 'revision', toEnvelope:async()=>({version:'revision',envelope:{source_type:'drive',source_id:'entry',content,metadata:{}}}),
      listChangePage:async()=>({changes:[{fileId:'entry',file}],nextToken:state.sync_token+'-next',terminal:true}) },
    now:()=>Date.parse('2026-11-01T00:00:00Z'), flags:{}, write:()=>{}, display:String,
    sanitize:e=>e, refusalOf:()=>null, splitOversized:e=>splitOversized(e,128), batchStream,
    sendBatches:async({groups,onResult})=>{
      let created=0;
      for(const {envelope} of groups.flat()) {
        sent.push(envelope.source_id);
        const result=await writer.ingest(store.env,envelope);
        onResult({envelope},{status:result.action}); created++;
      }
      return {created};
    },
    rememberAccepted:(_state,plan)=>{state.done[plan.stateKey]=plan.hash;}, rememberFamily:()=>{},
    acknowledgeOcr:async()=>{}, receipt:async()=>{}, readDriveFamily:async()=>false,
  };
  try {
    await driveIncrementalCommand(args);
    assert.equal(sent.length,3,'accepted version was earned through actual Worker storage');
    assert.equal(state.done['drive:entry'],'revision');
    if(restore) store.db.exec("DELETE FROM chunks WHERE doc_uid='drive:entry#part2of3'; DELETE FROM documents WHERE doc_uid='drive:entry#part2of3';");
    const before=sent.length;
    await driveIncrementalCommand(args);
    assert.equal(sent.length>before,restore,'accepted-version decision must repair a missing current part and reuse the intact control');
    assert.deepEqual(store.uids(),[1,2,3].map(i=>`drive:entry#part${i}of3`));
  } finally {store.db.close();}
});

test('current part proof detects unreadable chunks and forked/imported database identities without writes', async () => {
  const store = ingestPlanStore(), writer = storeFor(store.env);
  const envelope = {source_type:'gmail',source_id:'entry',content,metadata:{}};
  const args = {base:'https://fixture.invalid',source:'gmail',envelopes:[envelope],
    request:(url,options)=>handleIngestPartProof(store.env,new Request(url,options))};
  try {
    await writer.ingest(store.env,envelope);
    const first = await readCurrentIngestParts(args);
    assert.equal(first.parts.length,1,'green control read exact actual storage');
    const marker = store.db.prepare('SELECT * FROM ingest_removal_generation').get();
    const writes = store.db.prepare('SELECT total_changes() AS n').get().n;
    await readCurrentIngestParts(args);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,writes,'proof read makes zero database writes');
    // An imported backup gets a different instance. Equal counters on a fork
    // get a new nonce. Neither allows the old proof to bypass a current read.
    store.db.prepare('UPDATE ingest_removal_generation SET instance=?,nonce=? WHERE id=1').run('3'.repeat(32),'4'.repeat(32));
    const imported = await readCurrentIngestParts({...args,envelopes:undefined,proof:first});
    assert.equal(imported.parts.length,1,'unchanged readable import is rebound without replay');
    assert.notEqual(imported.database.instance,marker.instance);
    store.db.exec("DELETE FROM chunks WHERE doc_uid='gmail:entry'");
    store.db.prepare('UPDATE ingest_removal_generation SET instance=?,nonce=?,generation=? WHERE id=1').run(marker.instance,'5'.repeat(32),marker.generation);
    const reads = store.calls.batches;
    const missing = await readCurrentIngestParts({...args,envelopes:undefined,proof:first});
    assert.ok(store.calls.batches>reads,'missing-chunk decision reached actual D1 readback');
    assert.equal(missing.parts.length,0,'document row and unchanged counter alone cannot prove readable parts');
    await writer.ingest(store.env,envelope);
    assert.equal((await readCurrentIngestParts(args)).parts.length,1,'same-path repair control');
  } finally {store.db.close();}
});

test('part proof rejects foreign/malformed results and marker drift across bounded requests', async () => {
  const envelope = {source_type:'gmail',source_id:'entry',content,metadata:{}};
  let reads=0;
  const database={instance:'1'.repeat(32),nonce:'2'.repeat(32),generation:1};
  const args={base:'https://fixture.invalid',source:'gmail',envelopes:[envelope]};
  for (const bad of ['foreign','duplicate','marker','geometry']) {
    await assert.rejects(readCurrentIngestParts({...args,request:async()=>{
      reads++;
      const part={source_id:bad==='foreign'?'other':'entry',content_hash:'a'.repeat(64),chunk_count:1};
      return Response.json({source:'gmail',database:bad==='marker'?{}:database,
        geometry:{size:bad==='geometry'?0:1500,overlap:300},parts:bad==='duplicate'?[part,part]:[part]});
    }}),/invalid/);
  }
  assert.equal(reads,4,'all invalid decision points reached');
  const envelopes=Array.from({length:51},(_,i)=>({...envelope,source_id:`entry-${i}`}));
  let groups=0;
  await assert.rejects(readCurrentIngestParts({...args,envelopes,request:async(_url,options)=>{
    const ids=JSON.parse(options.body).source_ids; assert.ok(ids.length<=50);
    groups++;
    return Response.json({source:'gmail',database:{...database,generation:groups},geometry:{size:1500,overlap:300},parts:[]});
  }}),/changed/);
  assert.equal(groups,2,'cross-request generation comparison reached');
  const control=await readCurrentIngestParts({...args,request:async()=>Response.json({source:'gmail',database,geometry:{size:1500,overlap:300},parts:[]})});
  assert.deepEqual(control.parts,[],'well-formed absence stays repairable');
});

test('part proof route requires owner authorization and returns private bounded proof', async () => {
  const store=ingestPlanStore();
  const key=randomBytes(32).toString('hex');
  const env={...store.env,ADMIN_KEY:key};
  const request=(body,authorized=true)=>new Request('https://fixture.invalid/api/admin/brain/ingest-part-proof',{
    method:'POST',headers:authorized?{'X-Admin-Key':key}:{},body:JSON.stringify(body)});
  try {
    const denied=await worker.fetch(request({source:'gmail',source_ids:['entry']},false),env,{});
    assert.equal(denied.status,401);
    const invalid=await worker.fetch(request({source:'gmail',source_ids:Array.from({length:51},(_,i)=>`entry-${i}`)}),env,{});
    assert.equal(invalid.status,400,'authenticated size decision reached');
    const control=await worker.fetch(request({source:'gmail',source_ids:['entry']}),env,{});
    assert.equal(control.status,200,'same route authorized green control');
    assert.match(control.headers.get('Cache-Control'),/no-store/);
    assert.deepEqual((await control.json()).parts,[]);
  } finally {store.db.close();}
});

for (const losePart of [true,false]) test(`Gmail final readback: ${losePart?'lost current part stays retryable':'complete control'}`, async()=>fixture(async f=>{
  const store=ingestPlanStore(),writer=storeFor(store.env);
  f.ids=['split-entry']; f.content=content;
  f.ingestOverrides={splitOversized:e=>splitOversized(e,128)};
  f.options={deferGmailRemovals:true};
  let proofs=0;
  f.inventory=async()=>new Set((await store.inventory({source:'gmail'})));
  f.respond=async docs=>{
    const results=[];
    for(const doc of docs){const r=await writer.ingest(store.env,doc);results.push({source_id:doc.source_id,status:r.action,chunks:r.chunks});}
    return Response.json({results});
  };
  f.partProof=(url,options)=>{
    if(++proofs===1&&losePart) store.db.exec("DELETE FROM chunks WHERE doc_uid='gmail:split-entry#part2of3'; DELETE FROM documents WHERE doc_uid='gmail:split-entry#part2of3';");
    return handleIngestPartProof(store.env,new Request(url,options));
  };
  try{
    const first=await f.once();
    assert.equal(first.error,null);
    assert.equal(proofs,1,'actual final-current-readback decision reached after writes');
    assert.equal(f.calls[0].length,3,'all physical parts reached the real writer');
    if(losePart){
      assert.equal(first.state.done['gmail:split-entry'],undefined);
      assert.equal(first.state.gmail_retry['gmail:split-entry'],true,'missing part remains visible recovery debt');
      assert.equal(first.receipt.complete_sweep,false);
      const second=await f.once();assert.equal(second.error,null);
      assert.deepEqual(f.calls[1],['split-entry#part2of3']);
      assert.equal(second.state.done['gmail:split-entry'],'revision');
    }else assert.equal(first.state.done['gmail:split-entry'],'revision');
    assert.equal(store.uids().length,3,'repaired and no-loss control both read all three current parts');
  }finally{store.db.close();}
}));
