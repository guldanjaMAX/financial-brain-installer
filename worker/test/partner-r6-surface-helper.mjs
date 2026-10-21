import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeAdminKeyFile } from '../../operations/admin-key-file.mjs';
import worker from '../src/index.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { NOW } from './ledger-review-fixture.mjs';
import { tmpdir } from 'node:os';
export async function workerBody(f,q){
 const start=f.calls.length,w=f.first('SELECT total_changes() n').n;
 const res=await worker.fetch(new Request('https://brain.invalid/api/rag/think',{
  method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY},body:JSON.stringify({q})
 }),f.env,{waitUntil(){}});
 assert.equal(res.status,200);const b=await res.json();
 assert.ok(f.calls.slice(start).some(sql=>/JOIN fin_transactions/.test(sql)),'Worker reached real ledger read');
 assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n>0,'populated ledger decision');
 assert.equal(f.first('SELECT total_changes() n').n,w,'Worker question is read only');
 assert.ok(b.ledger,'Worker returned a ledger answer');return b;
}
export async function remoteBody(q,body){
 let calls=0;
 const url=new URL('https://fixture.invalid/mcp');
 const res=await handleMcp({DB:{prepare(){assert.fail('unexpected database read')}}},new Request(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask',arguments:{question:q}}})}),url,{
 think:async args=>{calls++;assert.equal(args.q,q);return body;},search:async()=>assert.fail('unexpected search')});
 const b=await res.json();assert.equal(calls,1,'remote ask decision reached');assert.ok(!b.result.isError);
 const text=b.result.content[0].text;assert.ok(text.includes(body.answer),'remote contains actual Worker answer verbatim');return text;
}
export function localBodies(t,entries){
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'home-mcp-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const home=join(root,'home');mkdirSync(home);const manifest=join(root,'brain.manifest.json');
 writeFileSync(manifest,JSON.stringify({operations:{admin_key_secret:null}}));
 // Windows protects the fixture key with DPAPI, which needs the real system environment and account name, as in ledger-mcp.test.mjs.
 const win=process.platform==='win32';
 writeAdminKeyFile(join(root,'.brain-admin-key'),randomBytes(24).toString('hex'),win?{environment:process.env,username:process.env.USERNAME||process.env.USER}:{environment:{HOME:home}});
 const launchctl=join(root,'launchctl-fixture');writeFileSync(launchctl,'#!/bin/sh\nexit 99\n',{mode:0o700});
 writeFileSync(join(root,'bodies.json'),JSON.stringify(entries));
 const loader=join(root,'fetch-fixture.mjs');
 // On Windows the child reads that fixture key through the DPAPI bridge child process (POSIX reads a plain file).
 // Capture spawnSync before the tripwire and let only that exact bridge launch through; every other boundary stays blocked.
 if(win)writeFileSync(join(root,'dpapi-capture.mjs'),"import cp from 'node:child_process';\nexport const spawnSync=cp.spawnSync;\n");
 writeFileSync(loader,`${win?"import { spawnSync as original } from './dpapi-capture.mjs';\n":''}import ${JSON.stringify(new URL('../../test/fixtures/cli-side-effect-tripwire.mjs',import.meta.url).href)};
${win?`import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const blocked=cp.spawnSync,bridge=${JSON.stringify(fileURLToPath(new URL('../../operations/windows-dpapi-bridge.mjs',import.meta.url)))};
cp.spawnSync=(command,args,options)=>command===process.execPath&&args?.[0]===bridge?original(command,args,options):blocked();
syncBuiltinESMExports();
`:''}import { readFileSync, appendFileSync } from 'node:fs';
const entries=JSON.parse(readFileSync(new URL('./bodies.json',import.meta.url)));
globalThis.fetch=async(url,init)=>{
 if(String(url)!=='https://brain.invalid/api/rag/think')throw Error('unexpected fixture route');
 const {q}=JSON.parse(init.body);const entry=entries.find(e=>e.q===q);
 if(!entry)throw Error('unexpected fixture question');
 appendFileSync(new URL('./calls.txt',import.meta.url),q+'\\n');
 return Response.json(entry.body);
};\n`);
 const env={HOME:home,TMPDIR:root,PATH:process.env.PATH,BRAIN_URL:'https://brain.invalid',BRAIN_NAME:'fixture',BRAIN_MANIFEST:manifest,BRAIN_NO_WRANGLER_LOGIN:'1',BRAIN_TEST_LAUNCHCTL:launchctl};
 if(win)for(const name of ['SystemRoot','WINDIR','ComSpec','USERNAME','USER','LOGNAME'])if(process.env[name])env[name]=process.env[name];
 const input=entries.map((e,i)=>JSON.stringify({jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name:'brain_think',arguments:{q:e.q}}})).join('\n')+'\n';
 // Each child Node entry independently observes the exact host quiet sentinel.
 const sentinel=fileURLToPath(new URL('../../../MAC-QUIET',import.meta.url));
 const mcp=fileURLToPath(new URL('../../components/brain-mcp.mjs',import.meta.url));
 // Windows has no /bin/sh (so no MAC-QUIET wait) and needs a file URL for --import; the POSIX launch is unchanged.
 const child=win?spawnSync(process.execPath,['--import',pathToFileURL(loader).href,mcp],{env,input,encoding:'utf8',timeout:10000})
  :spawnSync('/bin/sh',['-c',`while [ -e ${sentinel} ]; do sleep 60; done\nexec "$@"`,'fixture',process.execPath,'--import',loader,mcp],{env,input,encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,'local MCP completed with fixture key and all host side effects blocked');
 assert.doesNotMatch(child.stderr,/TEST_SIDE_EFFECT_BLOCKED/,'no credential or network boundary reached');
 assert.deepEqual(readFileSync(join(root,'calls.txt'),'utf8').trim().split('\n').sort(),entries.map(e=>e.q).sort(),'every request reached injected fetch');
 const messages=child.stdout.trim().split('\n').map(JSON.parse);
 return entries.map((entry,i)=>{const out=JSON.parse(messages.find(m=>m.id===i+1).result.content[0].text);
  assert.equal(out.answer,entry.body.answer);assert.deepEqual(out.ledger,entry.body.ledger);assert.deepEqual(out.evidence_gate,entry.body.evidence_gate);assert.deepEqual(out.gaps,entry.body.gaps);return out;});
}
export function freezeClock(t){const NativeDate=Date;t.mock.property(globalThis,'Date',class extends NativeDate{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NativeDate.parse(NOW);}});t.mock.method(globalThis,'fetch',()=>assert.fail('external transport forbidden'));}
