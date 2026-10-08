import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, bindReportCells } from './reports.mjs';
const scope = {report:'ProfitAndLoss', start:'2025-01-01', end:'2025-01-31', basis:'Accrual', currency:'USD'};
const report = () => ({Header:{ReportName:'ProfitAndLoss',StartPeriod:scope.start,EndPeriod:scope.end,ReportBasis:'Accrual',Currency:'USD',Option:[{Name:'NoReportData',Value:'false'}]},Columns:{Column:[{ColTitle:'Account',ColType:'Account'},{ColTitle:'Total',ColType:'Money'}]},Rows:{Row:[{type:'Section',Header:{ColData:[{value:'Income'},{value:''}]},Rows:{Row:[{type:'Data',ColData:[{value:'Service',id:'a1'},{value:'3,700.00'}]}]},Summary:{ColData:[{value:'Total Income'},{value:'3,700.00'}]}}]}});
test('nested report retains cell paths without summing parent and child', () => {
  const result = parseReport(JSON.stringify(report()),scope);
  assert.equal(result.money_cells.length,2);
  assert.equal(result.money_cells[0].minor,'370000');
  assert.equal(result.money_cells[1].row_kind,'summary');
  assert.notEqual(result.money_cells[0].path,result.money_cells[1].path);
  const bound = bindReportCells(result,[{metric:'revenue',path:'/Rows/Row/0/Rows/Row/0/ColData/1',expected_minor:'370000'}]);
  assert.equal(bound.length,1);
  assert.equal(bound[0].content_hash,result.sha256);
});
for(const [name,basis,metric,amount,expected] of [
 ['ProfitAndLoss','Cash','profit','1675.00','167500'],
 ['CashFlow','Accrual','cash_change','2505.00','250500'],
])test(`FOR-02: ${name} ${basis} truth binding refuses and accrual bindings retain parser limits`,()=>{
 const parse=(name,basis,amount)=>{
  const source=report();source.Header.ReportName=name;source.Header.ReportBasis=basis;
  source.Rows.Row=[{type:'Data',ColData:[{value:'Synthetic row'},{value:amount}]}];
  return parseReport(JSON.stringify(source),{...scope,report:name,basis});
 };
 const binding={metric,path:'/Rows/Row/0/ColData/1',expected_minor:expected};
 const green=parse('ProfitAndLoss','Accrual','1675.00');assert.equal(green.rows_checked,1);
 const goodBinding={...binding,metric:'profit',expected_minor:'167500'};
 const bound=bindReportCells(green,[goodBinding]);assert.equal(bound.length,1);assert.equal(bound[0].minor,'167500');
 let mismatchReads=0;
 assert.throws(()=>bindReportCells(green,[{...goodBinding,get expected_minor(){mismatchReads++;return '167501';}}]),/^Error: ORACLE_REPORT_INVALID$/);
 assert.equal(mismatchReads,1,'one-cent mismatch reached equality comparison');
 const pending=parse(name,basis,amount);assert.equal(pending.rows_checked,1);assert.equal(pending.completeness,'parsed_only');
 let scopeReads=0,comparisons=0;
 const parsedScope=pending.scope;
 Object.defineProperty(pending,'scope',{get(){scopeReads++;return parsedScope;}});
 for(const minor of [expected,String(BigInt(expected)+1n)]){
  assert.throws(()=>bindReportCells(pending,[{...binding,get expected_minor(){comparisons++;return minor;}}]),{
   code:'ORACLE_BASIS_UNSUPPORTED',reason:'unsupported_basis',stage:'report_binding',
  });
 }
 assert.ok(scopeReads>0,'report scope refusal reached');assert.equal(comparisons,0,'unsupported reports never compare amounts');
 assert.equal(bound[0].completeness,green.completeness);assert.equal(bound[0].limitation,green.limitation);
 assert.equal(bound[0].completeness,'parsed_only');assert.ok(bound[0].limitation.length>0);
});
test('blank is unknown; money text may be negative or parenthesized; nonmoney is never summed', () => {
  const r = report(); r.Rows.Row[0].Rows.Row[0].ColData[1].value = '(0.01)';
  assert.equal(parseReport(JSON.stringify(r),scope).money_cells[0].minor,'-1');
  r.Rows.Row[0].Rows.Row[0].ColData[1].value = '';
  assert.equal(parseReport(JSON.stringify(r),scope).cells.find(c=>c.path==='/Rows/Row/0/Rows/Row/0/ColData/1').minor,null);
});
test('parser rejects partial, wrong scope, fault, malformed cell and unknown empty without turning it into zero', () => {
  assert.equal(parseReport(JSON.stringify(report()),scope).rows_checked,4);
  for (const change of [r=>r.Fault={}, r=>r.Header.EndPeriod='2025-02-01',r=>r.Rows.Row[0].Summary.ColData.pop(),r=>r.Rows.Row[0].Summary.ColData[1].value='1e3',r=>r.Rows={}]) {
    const r=report(); change(r); assert.throws(()=>parseReport(JSON.stringify(r),scope),/ORACLE_REPORT/);
  }
});
test('0, 1, 17 and 1001 rows preserve denominators, duplicate labels and all paths', () => {
  for (const n of [0,1,17,1001]) {
    const r=report(); r.Rows.Row=Array.from({length:n},(_,i)=>({type:'Data',ColData:[{value:'Same',id:`a${i}`},{value:'1.00'}]}));
    r.Header.Option[0].Value= n ? 'false':'true';
    const parsed=parseReport(JSON.stringify(r),scope);
    assert.equal(parsed.money_cells.length,n);
    assert.equal(parsed.no_data,n===0);
  }
});
test('JPY and KWD exact cells, percent columns, unknown precision and partial envelopes',()=>{
 assert.equal(parseReport(JSON.stringify(report()),scope).money_cells[0].minor,'370000');
 for(const [currency,value,expected] of [['JPY','123','123'],['KWD','1.234','1234']]){
  const r=report();r.Header.Currency=currency;r.Rows.Row=[{type:'Data',ColData:[{value:'Balance',id:'opaque'},{value}]}];
  assert.equal(parseReport(JSON.stringify(r),{...scope,currency}).money_cells[0].minor,expected);
 }
 const r=report();r.Columns.Column.push({ColType:'Percent',ColTitle:'Percent'});r.Rows.Row=[{type:'Data',ColData:[{value:'Same'},{value:'1.00'},{value:'50.0%'}]}];
 assert.equal(parseReport(JSON.stringify(r),scope).money_cells.length,1);
 const partial=report();partial.partial=true;assert.throws(()=>parseReport(JSON.stringify(partial),scope),/ORACLE_REPORT/);
 const nested=report();nested.Rows.Row[0].Rows.Row[0].Rows={Row:[]};assert.throws(()=>parseReport(JSON.stringify(nested),scope),/ORACLE_REPORT/);
});
