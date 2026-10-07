// Independent Reports API traversal. It never imports the product report code.
import { createHash } from 'node:crypto';
import { decimalMinor, day } from './ledger.mjs';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const REPORT_NAMES = Object.freeze(['ProfitAndLoss','BalanceSheet','AgedReceivables','AgedReceivableDetail','AgedPayables','AgedPayableDetail','TrialBalance','CashFlow','GeneralLedger']);
const fail = () => {throw new Error('ORACLE_REPORT_INVALID');};
function displayMinor(text,exponent) {
  if(typeof text!=='string') fail();
  if(text==='') return null;
  if(!/^(?:-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\))$/.test(text)) fail();
  const normalized=text.replaceAll(',','').replace(/^\((.*)\)$/,'-$1');
  try{return String(decimalMinor(normalized,exponent));}catch{fail();}
}
export function parseReport(raw,scope) {
  if(typeof raw!=='string' || raw.length>32*1024*1024) fail();
  let data;try{data=JSON.parse(raw);}catch{fail();}
  const h=data?.Header, columns=data?.Columns?.Column;
  if(!h || data.Fault || data.partial===true || data.Partial===true || !REPORT_NAMES.includes(scope.report) || h.ReportName!==scope.report || h.StartPeriod!==scope.start || h.EndPeriod!==scope.end || h.ReportBasis!==scope.basis || h.Currency!==scope.currency) fail();
  try{day(scope.start);day(scope.end);}catch{fail();}
  if(scope.start>scope.end || !['USD','JPY','KWD'].includes(scope.currency)) fail();
  const exponent={USD:2,JPY:0,KWD:3}[scope.currency];
  if(!Array.isArray(columns)||!columns.length||columns.length>1000) fail();
  // Reviewed filter echoes are exact, including absent versus explicitly all.
  for(const [key,value] of Object.entries(scope.echo||{})) if(JSON.stringify(h[key])!==JSON.stringify(value)) fail();
  const options=h.Option||[]; if(!Array.isArray(options)) fail();
  const flags=options.filter(o=>o.Name==='NoReportData');
  if(flags.length!==1 || !['true','false'].includes(flags[0].Value)) fail();
  const no_data=flags[0].Value==='true';
  const cells=[];let rows_checked=0;
  function rowCells(row,path,kind) {
    if(!Array.isArray(row.ColData)||row.ColData.length!==columns.length) fail();
    rows_checked++;
    row.ColData.forEach((c,i)=>{
      if(!c || typeof c.value!=='string') fail();
      const type=columns[i].ColType;
      if(typeof type!=='string') fail();
      const minor=type==='Money'?displayMinor(c.value,exponent):null;
      cells.push({path:`${path}/ColData/${i}`,column_key:String(i),column_title:columns[i].ColTitle||'',row_kind:kind,row_id:row.ColData[0]?.id??null,raw:c.value,minor,currency:scope.currency,exponent});
    });
  }
  function walk(rows,path,depth=0) {
    if(depth>30||!rows||!Array.isArray(rows.Row)) fail();
    for(const [i,row] of rows.Row.entries()) {
      if(!row||!['Section','Data'].includes(row.type)) fail();
      const p=`${path}/Row/${i}`;
      if(row.type==='Data') {if(row.Rows||row.Header||row.Summary)fail();rowCells(row,p,'data');}
      else {
        rows_checked++;
        if(!row.Header&&!row.Rows&&!row.Summary) fail();
        if(row.Header) rowCells(row.Header,`${p}/Header`,'header');
        if(row.Rows) walk(row.Rows,`${p}/Rows`,depth+1);
        if(row.Summary) rowCells(row.Summary,`${p}/Summary`,'summary');
      }
    }
  }
  walk(data.Rows,'/Rows');
  const money_cells=cells.filter(c=>c.minor!==null);
  if(no_data && money_cells.some(c=>BigInt(c.minor)!==0n)) fail();
  if(!no_data && !rows_checked) fail();
  return {schema_version:1,sha256:hash(raw),scope:{...scope},no_data,rows_checked,cells,money_cells,
    completeness:'parsed_only', limitation:'Transport, storage readback, filters and a stable generation require separate evidence.'};
}
export function bindReportCells(report,bindings) {
  const seen=new Set();
  return bindings.map(b=>{
    const c=report.money_cells.find(c=>c.path===b.path);
    if(!c||seen.has(b.metric)||c.minor!==b.expected_minor) fail(); seen.add(b.metric);
    return {metric:b.metric,minor:c.minor,content_hash:report.sha256,row_path:c.path,column_key:c.column_key,scope:report.scope};
  });
}
