import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { driveIncrementalCommand, readDriveSingleFamily } from '../operations/drive-incremental.mjs';
import { batchStream } from '../ingest/run.mjs';

// Exhaust every fallible call at the entry boundary, including synchronous
// hooks and explicit validation throws. The real CLI/connector/OCR/store suite
// separately expands the three delegated boundaries (scope, prepare, send).
export const ENTRY_FAULT_POINTS = [
  'metadata', 'metadata-validation', 'scope', 'scope-version', 'folder-path',
  'exclusion', 'version', 'prepare', 'missing-outcome', 'skip-version',
  'sanitize', 'admission', 'split', 'batch-next', 'send', 'part-result',
  'writer-outcome', 'acknowledge', 'remember-family', 'remember-accepted',
  'family-read', 'cached-family-read', 'current-proof-read', 'cached-proof-read', 'proof-validation',
  'family-request', 'family-json', 'family-http', 'batch-end',
];
const stamp = Date.parse('2026-11-01T00:00:00.000Z');
function harness(point, { globalFailure = false, enabled = true } = {}) {
  let armed = enabled, reached = 0, saved;
  const calls = [], receipts = [];
  const files = ['first','second'].map(id => ({ id, name:`${id}.txt`, parents:['reviewed'], mimeType:'text/plain' }));
  let current = null, prepared = false;
  const state = { version:1, sync_token:'before', done:{ 'drive:first':'prior-version' }, skipped:{},
    drive_incremental_started_at:new Date(stamp).toISOString(), credential_scanner_fingerprint:'scanner' };
  if (['cached-family-read','cached-proof-read'].includes(point)) {
    state.done['drive:first']='next-version';
    state.drive_accepted_parts={'drive:first':{revision:'next-version',policy_fingerprint:'policy',parts:[{source_id:'first'}]}};
    state.drive_pending_removals={ 'drive:first':{ id:'first', reason:'replacement_family_needs_review' } };
    // Exercise cached readback on the feed rather than spending a retry first.
    state.drive_retry_feed_pending=true;
  }
  function hit(name) {
    calls.push([current,name]);
    if (!armed || current !== 'first' || name !== point) return;
    reached++; armed=false;
    if (['metadata-validation','missing-outcome','writer-outcome','proof-validation'].includes(point)) return true;
    throw Object.assign(new Error('Synthetic entry fault'), globalFailure ? { status:401, needsReauth:true } : {});
  }
  const drive = {
    FOLDER_MIME:'folder', isPermanentFileFailure:()=>false,
    getFileMetadata:async (_get,id) => {
      current=id; prepared=false; hit('metadata'); const file=files.find(f=>f.id===id);
      return hit('metadata-validation') ? { ...file,parents:null } : file;
    },
    changeScope:async () => {
      hit('scope');
      return point==='scope-version'&&current==='first' ? { unresolved:{ code:'ancestor_unavailable',reason:'Scope unresolved.' } }
        : { inScope:true,folders:{},rootIds:['reviewed'] };
    },
    folderPathFor:()=>{ hit('folder-path'); return ''; },
    exclusionReason:()=>{ hit('exclusion'); return null; },
    driveVersion:()=>{ if(point!=='skip-version'||prepared) hit(point==='scope-version'?'scope-version':point==='skip-version'?'skip-version':'version'); return 'next-version'; },
    toEnvelope:async (_get,file) => {
      hit('prepare'); prepared=true; if(hit('missing-outcome')) return null;
      if(enabled&&point==='skip-version'&&current==='first') return { skip:{ code:'ocr_page_timeout',reason:'A page is pending.',retryable:true } };
      return { envelope:{ source_type:'drive',source_id:file.id,content:'Synthetic accepted evidence.',metadata:{} },version:'next-version' };
    },
    listChangePage:async()=>({ changes:files.map(file=>({fileId:file.id,file})),nextToken:'after',terminal:true }),
    startPageToken:async()=>{ throw new Error('Reseed forbidden'); },
  };
  const args = {
    drive,getToken:async()=>undefined,state,sourceName:'drive',policy:{},policyFingerprint:'policy',
    scannerOn:true,scannerFingerprint:'scanner',now:()=>stamp,flags:{},write:()=>{},display:String,
    save:()=>{ hit('checkpoint'); saved=structuredClone(state); },
    sanitize:e=>{ hit('sanitize'); return e; },refusalOf:()=>{ hit('admission'); return null; },
    splitOversized:e=>{ hit('split'); return [e]; },
    batchStream:async function* (...params) { hit('batch-next'); yield* batchStream(...params); hit('batch-end'); },
    sendBatches:async ({groups,onResult,saveState})=>{
      hit('send'); const bad=hit('writer-outcome');
      for(const item of groups.flat()) {
        hit('part-result'); onResult(item,{status:bad?'failed':'created'});
      }
      saveState();
      return bad?{failed:1}:{created:1};
    },
    acknowledgeOcr:async()=>{ hit('acknowledge'); },
    readCurrentParts:async ({envelopes,proof})=>{
      hit(proof?'cached-proof-read':'current-proof-read');
      return {parts:hit('proof-validation')?[]:envelopes || proof.parts,
        database:{instance:'1'.repeat(32),nonce:'2'.repeat(32),generation:1}};
    },
    rememberFamily:()=>{ hit('remember-family'); },
    rememberAccepted:(_state,{stateKey,hash})=>{ hit('remember-accepted'); state.done[stateKey]=hash; },
    readDriveFamily:async input=>{
      hit(point==='cached-family-read'?'cached-family-read':'family-read');
      if(!['family-request','family-json','family-http'].includes(point)) return true;
      return readDriveSingleFamily({...input,request:async()=>{
        hit('family-request');
        if(point==='family-http'&&armed&&current==='first') {
          reached++;armed=false;return {ok:false,status:globalFailure?401:503};
        }
        return {ok:true,json:async()=>{
          hit('family-json');return {source:'drive',file_id:current,base_doc_uid:`drive:${current}`,same_identity_single_part:true};
        }};
      }});
    },
    receipt:async r=>{receipts.push(r);},
  };
  return { args,state,calls,receipts,reached:()=>reached,saved:()=>saved,
    run:()=>driveIncrementalCommand(args), repair:()=>{armed=false;}, arm:()=>{armed=true;} };
}

for (const point of ENTRY_FAULT_POINTS) test(`R6 fault sweep: ${point} stays local and the healthy suffix settles`, async t => {
  const h=harness(point);
  let error; const result=await h.run().catch(e=>{error=e;});
  assert.equal(h.reached(),1,'fault decision reached exactly once on entry one');
  assert.equal(error,undefined,'an item failure cannot escape the one entry boundary');
  assert.ok(h.calls.some(([id,step])=>id==='second'&&step==='send'),'healthy suffix reaches the writer');
  assert.equal(h.saved().sync_token,'after'); assert.equal(h.saved().drive_change_page,undefined);
  assert.ok(h.saved().done['drive:second']); assert.equal(result.complete,false);
  const failure=h.saved().drive_failures['drive:first'];
  assert.ok(failure,'fault remains a durable visible outstanding item');
  assert.ok(failure.code); assert.ok(failure.reason); assert.ok(failure.retry_class); assert.ok(failure.version);
  assert.ok(h.receipts.at(-1).docs_failed>0); assert.equal(h.receipts.at(-1).status,'error');
  const control=harness(point,{enabled:false});
  // Explicit malformed/outcome arms are activated by hit(), so disabling them
  // returns the ordinary successful branch through the identical dependencies.
  if(point==='scope-version') control.args.drive.changeScope=async()=>({inScope:true,folders:{},rootIds:['reviewed']});
  assert.equal((await control.run()).complete,true,'same-path fault-free green control');
  assert.equal(control.reached(),0);
  t.diagnostic(JSON.stringify({ injected:h.reached(),healthyWrites:h.calls.filter(([id,s])=>id==='second'&&s==='send').length,
    checkpoints:h.calls.filter(([,s])=>s==='checkpoint').length }));
});

for(const point of ['metadata','scope','prepare','send','acknowledge','family-read','cached-family-read','current-proof-read','cached-proof-read','family-request','family-json','family-http'])
test(`R6 fault sweep global control: ${point} auth failure stops before the suffix`,async()=>{
  const h=harness(point,{globalFailure:true});
  await assert.rejects(h.run()); assert.equal(h.reached(),1,'global decision reached');
  assert.equal(h.saved().sync_token,'before'); assert.equal(h.saved().drive_change_page.offset,0);
  assert.ok(!h.calls.some(([id,s])=>id==='second'&&s==='send'));
  h.repair(); assert.equal((await h.run()).complete,true,'same-path global recovery control');
});

// Persistence is an explicitly run-wide boundary, including failure recording
// and settlement. Replaying the retained event is the successful control.
for(const stop of ['failure-checkpoint','writer-checkpoint','acceptance-checkpoint','offset-checkpoint'])
test(`R6 fault sweep global control: ${stop} cannot authorize cursor progress`,async()=>{
  const h=harness(stop==='failure-checkpoint'?'prepare':null);
  const persist=h.args.save; let stopped=0;
  h.args.save=()=>{
    const target=stop==='failure-checkpoint'?h.state.drive_failures?.['drive:first']
      :stop==='writer-checkpoint'?h.state.done['drive:first']==='prior-version'&&h.calls.some(([id,s])=>id==='first'&&s==='send')
      :stop==='acceptance-checkpoint'?h.state.done['drive:first']==='next-version'&&h.state.drive_change_page?.offset===0
      :h.state.drive_change_page?.offset===1;
    if(target&&stopped++===0) throw new Error('Synthetic checkpoint failure');
    persist();
  };
  await assert.rejects(h.run(),/checkpoint/); assert.ok(stopped>0,'uncertain persistence reached');
  assert.ok(!h.calls.some(([id,s])=>id==='second'&&s==='send'));
  assert.equal(h.saved().drive_change_page.offset,0,'uncertain entry saves stay replayable');
  h.args.save=persist; h.repair(); assert.equal((await h.run()).complete,true,'checkpoint recovery control');
});

test('R6 settlement: uncertain terminal-token save preserves the replayable page',async()=>{
  const h=harness(null), persist=h.args.save; let reached=0;
  h.args.save=()=>{
    if(h.state.sync_token==='after'&&reached++===0) throw new Error('Synthetic terminal checkpoint failure');
    persist();
  };
  await assert.rejects(h.run(),/checkpoint/); assert.ok(reached>0,'terminal settlement decision reached');
  assert.equal(h.saved().sync_token,'before','uncertain token commit must remain replayable');
  assert.equal(h.saved().drive_change_page.offset,2);
  h.args.save=persist; assert.equal((await h.run()).complete,true,'terminal save recovery control');
});

// Every direct await/throw in the entry, adapter, family request and durable
// recorder must remain represented here. New points fail this census until
// they receive a reached fault arm and a healthy/global control.
test('R6 fault sweep census covers every direct entry await and throw',()=>{
  const source=readFileSync(new URL('../operations/drive-incremental.mjs',import.meta.url),'utf8');
  const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
  const regions=[section('function checkpointWriter','export function driveIncrementalStatus'),
    section('  const failure =','  const pending ='),section('  const process = async','  try {\n    if (!state.sync_token)'),
    section('  const checkSingleFamily =','  let result;'),section('export async function readDriveSingleFamily','/** Reject mixed CLI')];
  const actual=regions.flatMap(s=>s.split('\n').filter(line=>!line.trim().startsWith('//')&&/\b(?:await|throw)\b/.test(line)).map(s=>s.trim()));
  const expected=[
    ['failure-checkpoint','catch (error) { throw Object.assign(error, { checkpointFailure:true }); }'],
    ['metadata','file = await drive.getFileMetadata(getToken, id);'],
    ['metadata-validation','throw new Error("Drive current file metadata is incomplete or mismatched");'],
    ['scope','const scope = await drive.changeScope(getToken, file, { ...policy, metadata });'],
    ['prepare','const outcome = await processFile({ ...file, scope_root_ids: scope.rootIds }, folder, tally => {'],
    ['ownership/checkpoint',"if (error.checkpointFailure || error.code === 'source_ingest_lock_lost') throw error;"],
    ['global controls','if (!permanent && runWideFailure(error, recovery)) throw error;'],
    ['family-read','const verified = await readDriveFamily({ base, adminKey, source: sourceName, id: file.id, request, assertOwned });'],
    ['cached-proof-read','? await readCurrentParts({base,adminKey,source:sourceName,proof:saved,request,assertOwned}) : null;'],
    ['cached-family-read','const familyVerified = await checkSingleFamily(file, version, [uid]);'],
    // The existing prepare fault and global controls reach this redaction/rethrow.
    ['prepare','try { prepared = await drive.toEnvelope(getToken, file, { sourceName, pathOf: () => folder, ocr }); }'],
    ['prepare-error-redaction','throw error;'],
    ['missing-outcome','if (!prepared) throw new Error("Drive produced no document outcome");'],
    ['batch-next/end','for await (const group of batchStream([file], async () => ({ envelopes: parts,'],
    ['send','const part = await sendBatches({ base, adminKey, groups: [group], state, statePath, skips: [], quiet: true,'],
    ['writer-outcome','throw Object.assign(new Error(held.reason),{ driveFailure:held });'],
    ['current-proof-read','const proof = await readCurrentParts({base,adminKey,source:sourceName,envelopes:parts,request,assertOwned});'],
    ['proof-validation',"if (proof?.parts.length !== parts.length) throw new Error('Drive parts are not all readable in the current database; retry the file.');"],
    ['acknowledge','await acknowledgeOcr(prepared.ocrPageRequestIds || []);'],
    ['family-read','const familyVerified = await checkSingleFamily(file, prepared.version, keep);'],
    ['family-request','const response = await request(`${base}/api/admin/brain/drive-family`, {'],
    ['family-http',"if (!response.ok) throw Object.assign(new Error('Drive family readback failed; the accepted family remains held.'), { ...(response.status >= 500 ? { driveItemFailure:true } : {}), status:response.status });"],
    ['family-json','const body = await response.json();'],
  ];
  assert.deepEqual(actual,expected.map(([,line])=>line));
  assert.equal(actual.length,23);
});

test('R6 metadata gap: a new failed identity explicitly records unavailable source version',async()=>{
  const h=harness('metadata'); delete h.state.done['drive:first'];
  const result=await h.run(); assert.equal(h.reached(),1); assert.equal(result.created,1);
  const held=h.saved().drive_failures['drive:first'];
  assert.equal(held.version,null); assert.equal(held.version_basis,'unavailable');
  assert.equal(held.retryable,true); assert.equal(h.saved().sync_token,'after');
});
