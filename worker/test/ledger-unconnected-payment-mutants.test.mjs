import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const mutations=[
  ['nomination removed','ledger-analysis.js',"  if (!loan && !card) return null;","  return null;",'candidate excluded'],
  ['mixed withholding removed','ledger-answer.js','if (mixedLoanPayments.length || categoryConflict) {','if (false) {','mixed loan withholds'],
  ['candidate partition removed','ledger-answer.js','(!possiblePaymentIdsInScope.has(row.id) || recurringOwnMovementIds.has(row.id)) && ','','candidate excluded'],
  ['line omitted','ledger-answer.js','possible ${candidate.kind} payment, not counted as spending:', 'possible ${candidate.kind} payment:', 'candidate excluded'],
  ['monthly metadata lost','ledger-monthly.js','possible_payments: possibleRepayments.map','lost_possible_payments: possibleRepayments.map','monthly and comparison'],
];
test('possible-repayment mutants reach their decision after green controls',()=>{
  const folder=realpathSync.native(mkdtempSync(join(tmpdir(),'possible-payment-mutants-')));
  const files=['worker/src','migrations/d1','package.json','worker/test/ledger-review-fixture.mjs','worker/test/ledger-unconnected-payment.test.mjs'];
  try {
    for(const path of files){mkdirSync(dirname(join(folder,path)),{recursive:true});cpSync(join(root,path),join(folder,path),{recursive:true});}
    const env=Object.fromEntries(['PATH','TMPDIR','NODE_COMPILE_CACHE','HOME','BRAIN_NO_WRANGLER_LOGIN'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const run=pattern=>spawnSync(process.execPath,['--test','--test-name-pattern',pattern,'worker/test/ledger-unconnected-payment.test.mjs'],{cwd:folder,env,encoding:'utf8',timeout:120000});
    const green=run('.');assert.equal(green.status,0,green.stdout+green.stderr);assert.match(green.stdout,/pass 39\b/);
    for(const [name,file,from,to,pattern]of mutations){
      const path=join(folder,'worker/src/lib',file),source=readFileSync(path,'utf8'),before=createHash('sha256').update(source).digest('hex');
      assert.equal(source.split(from).length-1,1,name+': exact decision reached');
      try{writeFileSync(path,source.replace(from,to));const red=run(pattern);assert.equal(red.error,undefined);assert.equal(red.signal,null);assert.equal(red.status,1,name+red.stdout+red.stderr);assert.match(red.stdout,/AssertionError|TypeError/);}
      finally{writeFileSync(path,source);}
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),before,name+': restored');
    }
    console.log(JSON.stringify({mutants_killed:mutations.length,restored:mutations.length}));
  } finally{rmSync(folder,{recursive:true,force:true});}
});
