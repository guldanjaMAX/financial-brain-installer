import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookFor, runBook } from './store-owner-shapes.measure.mjs';
const root = new URL('../src/lib/', import.meta.url);
const source = name => readFileSync(new URL(name,root),'utf8');
const moduleURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const absoluteImports = text => text.replace(/from (["'])(\.\/[^"']+)\1/g,
 (_, quote, path) => `from ${quote}${new URL(path,root).href}${quote}`);
const original = source('ledger-answer.js');
const mutations = [
 ['closed router removed', original.replace('./ledger-question.js', moduleURL(absoluteImports(source('ledger-question.js')
   .replace('const storeShape = storeAlias && storeQuestionShape(question);','const storeShape = false;')))),
  rows => assert.equal(rows.find(r=>r.q===8).body.ledger?.kind,'recurring')],
 ['paying mask removed', original.replace('...(intent.payingAccount ? { account_mask:', '...(false ? { account_mask:'),
  rows => assert.equal(rows.find(r=>r.q===8).body.ledger.recurring[0].account_mask,'4100')],
 ['deposit evidence removed from boundary', original.replace('if (intent.financingBoundary) return','if (false) return'),
  rows => assert.ok(rows.find(r=>r.q===10).body.citations.some(c=>c.amount_minor===123456))],
];
for(const [name, text, oracle] of mutations) {
 const green = await runBook(bookFor(427),false);
 oracle(green); // Every mutant follows the same populated real-route control.
 assert.notEqual(text,original);
 const {withLedgerAnswer} = await import(moduleURL(absoluteImports(text)));
 const rows = await runBook(bookFor(427),false,undefined,withLedgerAnswer);
 assert.throws(()=>oracle(rows),{name:'AssertionError'});
 console.log(`KILLED ${name}`);
}
console.log('mutants_killed=3/3; in-memory mutations only; product source unchanged');
