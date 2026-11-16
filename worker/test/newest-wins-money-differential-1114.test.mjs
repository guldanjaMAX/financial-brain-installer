import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { queryMoney } from '../src/lib/money-query.js';
import { finalizeOwnerLedgerAnswer } from '../src/lib/document-answer.js';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';
const NOW=Date.parse('2026-11-12T15:00:00Z');
const baselineUrl=new URL('./fixtures/newest-wins-money-baseline-1114.json',import.meta.url);
// Replay the existing dates/score, clean-money and compatibility-ledger arms.
test('D1: existing money answers and financial provenance are byte-identical to the pinned baseline',async t=>{
  const answers=[];
  for(const mode of ['manual','live']) for(const arm of ['complete','partial','ambiguous','currency','date-mismatch']) {
    const f=overviewFixture(t);f.env.BRAIN_TIMEZONE='UTC';
    f.account('operating',mode);f.run("UPDATE fin_accounts SET mask='1111'");
    f.coverage('operating','2026-01-01',arm==='partial'?'2026-10-15':'2026-11-12');
    if(mode==='live'){f.connection('operating');f.run('UPDATE bank_feed_items SET last_synced_at=?','2026-11-12T09:00:00Z');}
    f.row('earlier','operating','2026-09-09',61000,'outflow',{description:'SUPPLIER PURCHASE'});
    f.row('current','operating','2026-10-09',24000,'outflow',{description:'SUPPLIER PURCHASE'});
    if(arm==='ambiguous')f.row('possible','operating','2026-10-10',120000,'outflow',{description:'POSSIBLE TRANSFER'});
    if(arm==='currency'){f.account('foreign',mode,'checking','CAD');f.coverage('foreign','2026-01-01','2026-11-12');f.row('foreign','foreign','2026-10-05',30000,'outflow',{currency:'CAD',description:'SUPPLIER PURCHASE'});}
    const sql=arm==='date-mismatch'?"SELECT SUM(expense_minor) AS n FROM txn WHERE posted_on BETWEEN '2026-09-01' AND '2026-09-30'":"SELECT SUM(expense_minor) AS n FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
    const answer=await queryMoney(f.env,{sql,period_from:'2026-10-01',period_to:'2026-10-31'},{now:()=>NOW});
    assert.ok(f.calls.some(s=>/fin_transactions/.test(s)),'nonempty ledger decision reached');
    assert.ok(answer.rows?.length,'the comparison covers real amount answers');
    const {rows,columns,confidence,confidence_text,evidence,gaps}=answer;
    answers.push({id:`${mode}/${arm}`,rows,columns,confidence,confidence_text,evidence,gaps});
  }
  for(const amount of [125000,-100,0]) answers.push({id:`compatibility/${amount}`,answer:finalizeOwnerLedgerAnswer({answer:`Observed USD ${amount} minor units.`,ledger:{amount_minor:amount,from:'2026-10-01',to:'2026-10-31',accounts:[{account_mask:'1111'}]}})});
  const bytes=JSON.stringify({pin:'62a55b76c254b05e1370918b3271651da44ecc7d',answers},null,2)+'\n';
  assert.equal(bytes,readFileSync(baselineUrl,'utf8'),'all 13 answer, figure, confidence and provenance snapshots match byte for byte');
  assert.notEqual(answers[0].rows[0].n,answers[4].rows[0].n,'date mutation changes the measured amount');
  // 0.4.28 closed-world party proof caps a payee-less purchase; independent figures remain exact.
  assert.equal(answers[0].confidence.percent,89,'manual purchase has unresolved party proof');
  assert.equal(answers[5].confidence.percent,89,'live purchase has unresolved party proof');
});
