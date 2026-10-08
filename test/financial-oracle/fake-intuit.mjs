// Invented recorded fake, never a recording of a real company or credential.
import { hash } from './reports.mjs';
import { quickBooksCompanyFingerprint } from '../../connectors/quickbooks-online.mjs';
const realm='sandbox_fixture';
const names={account:'Account',customer:'Customer',vendor:'Vendor',item:'Item',invoice:'Invoice',payment:'Payment',bill:'Bill',billpayment:'BillPayment',deposit:'Deposit',transfer:'Transfer',journalentry:'JournalEntry',purchase:'Purchase',creditmemo:'CreditMemo',salesreceipt:'SalesReceipt',companyinfo:'CompanyInfo',preferences:'Preferences',taxcode:'TaxCode'};
export function emptyReport(report,nonzero=false){return {Header:{ReportName:report,StartPeriod:'2025-01-01',EndPeriod:'2025-01-31',ReportBasis:'Accrual',Currency:'USD',Option:[{Name:'NoReportData',Value:nonzero?'false':'true'}]},Columns:{Column:[{ColTitle:'Account',ColType:'Account'},{ColTitle:'Total',ColType:'Money'}]},Rows:{Row:nonzero?[{type:'Data',ColData:[{value:'Baseline'},{value:'1.00'}]}]:[]}};}
export const response=data=>{const raw=JSON.stringify(data);return {data,raw,sha256:hash(raw)};};
export function configuration(){return {implementation_sha:'a'.repeat(40),synthetic_only:true,environment:'sandbox',api_base:'https://sandbox-quickbooks.api.intuit.com',run_tag:'synthetic_oracle',company_fingerprint:quickBooksCompanyFingerprint(realm),minor_version:'75',source:'quickbooks',schema_review_sha256:'a'.repeat(64),writers_frozen:true,
 company_info_sha256:response({Id:realm,Country:'US'}).sha256,preferences_sha256:response({CurrencyPrefs:{HomeCurrency:{value:'USD'}}}).sha256,
 control_accounts:{ar:{Id:'control-ar',AccountType:'Accounts Receivable'},ap:{Id:'control-ap',AccountType:'Accounts Payable'},undeposited:{Id:'control-uf',AccountType:'Other Current Asset',AccountSubType:'UndepositedFunds'}},non_taxable:{Id:'tax-code',Taxable:false},
 baseline_reports:['BalanceSheet','TrialBalance','ProfitAndLoss'].map(report=>({scope:{report,start:'2025-01-01',end:'2025-01-31',basis:'Accrual',currency:'USD'},parameters:{start_date:'2025-01-01',end_date:'2025-01-31',accounting_method:'Accrual'},sha256:response(emptyReport(report)).sha256}))};}
export function makeFake(config,options={}){
 const calls=[];const records=new Map();let journal=null,serial=0,postCount=0,loads=0;
 for(const value of Object.values(config.control_accounts))records.set(`account/${value.Id}`,structuredClone(value));
 records.set(`companyinfo/${realm}`,{Id:realm,Country:'US'});records.set(`preferences/${realm}`,{CurrencyPrefs:{HomeCurrency:{value:'USD'}}});records.set('taxcode/tax-code',{Id:'tax-code',Taxable:false});
 const connection={provider_metadata:{realm_id:realm},access_token:'synthetic-access',expires_at:Date.parse('2030-01-01T00:00:00Z'),quickbooks_binding:{active_source:'quickbooks',active_environment:'sandbox',active_company_fingerprint:quickBooksCompanyFingerprint(realm),sources:{quickbooks:{qbo_company_fingerprint:quickBooksCompanyFingerprint(realm),environment:'sandbox'}}}};
 const api=async(method,path,body,query)=>{
  calls.push({method,path,...(body?{body:structuredClone(body)}:{}),...(query?{query}:{})});
  if(method==='POST'){
   postCount++;const id=`record-${++serial}`;const row={...structuredClone(body),Id:id,SyncToken:'0'};
   if(options.losePost===postCount&&options.noCreate)throw Error('synthetic timeout');
   records.set(`${path}/${id}`,row);
   if(options.losePost===postCount)throw Error('synthetic timeout');
   return response({[names[path]]:row});
  }
  if(path.startsWith('reports/'))return response(emptyReport(path.split('/')[1],options.nonzeroBaseline));
  if(path==='query'){
    const [,entity,start]=query.query.match(/^select \* from (\w+) STARTPOSITION (\d+) MAXRESULTS 1000$/);
    const key=Object.keys(names).find(k=>names[k]===entity);const rows=[...records.entries()].filter(([p])=>p.startsWith(`${key}/`)).map(([,r])=>r).slice(Number(start)-1,Number(start)+999);
    return response({QueryResponse:{[entity]:rows,maxResults:rows.length}});
  }
  const row=structuredClone(records.get(path==='preferences'?`preferences/${realm}`:path));if(!row)throw Error('synthetic missing');
  const entity=path.split('/')[0];
  if(options.badReadback&&row.PrivateNote)row.TxnDate='2025-02-01';
  if(['invoice','bill'].includes(entity)){
    const seed=row.PrivateNote.split(':').at(-1);
    row.Balance=options.badBalance?'99.00':({S01:'400.00',S02:'800.00',S03:'0.00',S09:'350.00',S10:'200.00'})[seed];
  }
  if(entity==='creditmemo')row.RemainingCredit='0.00';
  return response({[names[entity]]:row});
 };
 return {calls,records,connection,loads:()=>loads,deps:{now:()=>Date.parse('2026-01-01T00:00:00Z'),loadConnection:async()=>{loads++;return connection;},api:async()=>api,readJournal:async()=>structuredClone(journal),writeJournal:async j=>{journal=structuredClone(j);}}};
}
