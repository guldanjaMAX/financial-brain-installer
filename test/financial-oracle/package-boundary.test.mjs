import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { TEST_COMMANDS,POST_LAUNCHER_TEST_COMMANDS } from '../../scripts/run-test-chain.mjs';
import { hash } from './reports.mjs';
const root=new URL('../../',import.meta.url);
test('every oracle test and the unchanged original self-test join both explicit chain lists',()=>{
 assert.ok(TEST_COMMANDS.includes('node --test test/quickbooks-answers.test.mjs'));
 const names=readdirSync(new URL('./',import.meta.url)).filter(n=>n.endsWith('.test.mjs'));
 for(const name of [...names,'fixtures/golden-selftest.mjs']){
   const command=`node --test test/financial-oracle/${name}`;
   assert.ok(TEST_COMMANDS.includes(command),`Missing chain entry: ${name}`);
   assert.ok(POST_LAUNCHER_TEST_COMMANDS.includes(command),`Missing graph projection: ${name}`);
 }
 assert.ok(names.length>=7);
});
test('fixtures and all test-only tooling stay outside publication allowlist',()=>{
 const pkg=JSON.parse(readFileSync(new URL('package.json',root)));
 assert.ok(pkg.files.includes('scripts/'));
 const paths=['test/financial-oracle/cli.mjs','test/financial-oracle/fixtures/golden-company.json','test/financial-oracle/README.md'];
 for(const path of paths)assert.equal(pkg.files.some(entry=>path===entry||path.startsWith(entry.endsWith('/')?entry:`${entry}/`)),false);
 assert.equal(hash(readFileSync(new URL('./fixtures/golden-company.json',import.meta.url))),'6898f6d137b19983b8cf789f8d84d5066725a64a788713a155e3213c165e1237');
 assert.equal(hash(readFileSync(new URL('./fixtures/seed-requests.json',import.meta.url))),'f49e09eaf413cc511e92428178393c0812d8de13201ad2e9eb83703756ed5daa');
 assert.equal(hash(readFileSync(new URL('./fixtures/golden-selftest.mjs',import.meta.url))),'3975ea85a8bcf3316b42cd7a787a55aaafc4f3ebe17cf4d299be35149c3a0fda');
});
