import { cleanFee, cleanPairEvidence, hasExplicitExpenseCategory, normalizeLedgerText, trustedCode } from './money-analysis.js';
import { platformCategory } from './money-platform.js';
import { legLocator } from './clean-money-transfers.js';

const debt = a => ['loan','line_of_credit'].includes(a?.account_kind);
const asset = a => ['checking','savings','investment','retirement','escrow'].includes(a?.account_kind);
const drawCode = r => trustedCode(r) && /^(?:loan proceeds|loan disbursements?|line of credit advance)$/.test(platformCategory(r));
const drawNominated = r => /\b(?:loan proceeds|loan disbursements?|line of credit advance)\b/.test(platformCategory(r)+' '+normalizeLedgerText(r.description));
const conflict = a => a?.account_kind_balance_conflict || a?.members?.some(m=>m.account_kind_balance_conflict);
const expense = r => hasExplicitExpenseCategory(r) || cleanFee(r);
const conflictingType = r => expense(r) || /\b(?:payments?|repayments?|refunds?|reversals?|reversed|returns?|returned|chargebacks?|interest|fees?)\b/.test(platformCategory(r)+' '+normalizeLedgerText(r.description));
const genericDrawMemo = row => {
  const memo=normalizeLedgerText(row.description),code=platformCategory(row),payee=normalizeLedgerText(row.payee);
  return !memo || memo===code || Boolean(payee && [payee+' '+code,code+' '+payee].includes(memo));
};
function locatorConflict(row,self,other,accounts,side) {
  const options={loanAdvance:true},memo=legLocator(row,self,other,accounts,side,options);
  const payee=legLocator({...row,description:row.payee},self,other,accounts,side,options);
  // Only an empty/code-only memo (with its recorded payee) establishes absence
  // of a locator. Unknown wording may name an unresolved endpoint even without
  // digits or a recognized direction. A payee locator must agree as well.
  return memo==='conflict' || payee==='conflict' || memo==='none' && !genericDrawMemo(row);
}

// A category nominates a draw; the owned liability source, owned asset endpoint
// and mutually unique opposite posting establish the movement. A same-amount
// bank credit or an outside vendor with a different payee cannot prove it.
export function refineLoanDrawPairs(snapshot, rows, accounts) {
  const locatorConflicts=new Set();
  if(snapshot.partial)return locatorConflicts;
  const byId=new Map(rows.map(r=>[r.id,r]));
  for(const p of snapshot.pairs) {
    const out=byId.get(p.out_id),into=byId.get(p.in_id);
    if(!out || !into || !p.unique_match)continue;
    const source=accounts.get(out.effective_account_slug),target=accounts.get(into.effective_account_slug);
    if(!debt(source) || !asset(target))continue;
    // Equal draw codes cannot repair a locator naming another account, kind
    // or direction. Keep the candidate unproved so its debit stays estimated.
    if(locatorConflict(out,source,target,accounts,'out') || locatorConflict(into,target,source,accounts,'in')) {
      p.proved=0;p.evidence=null;locatorConflicts.add(p);continue;
    }
    // Generic transfer categories establish only a candidate borrowing pair.
    // Preserve exact endpoint proof, but never promote that likely exclusion.
    if(p.proved && (!cleanPairEvidence({out,in:into},accounts) || [out,into].some(conflictingType))) {p.proved=0;p.evidence=null;}
    if(p.proved)continue;
    if(source===target || conflict(source) || conflict(target) ||
      out.tenant_id!==into.tenant_id || out.entity!==into.entity ||
      out.basis_state!=='confirmed' || into.basis_state!=='confirmed' ||
      out.direction!=='outflow' || into.direction!=='inflow' ||
      out.currency!==into.currency || out.amount_minor<=0 || out.amount_minor!==into.amount_minor ||
      !drawCode(out) || !drawCode(into) || conflictingType(out) || conflictingType(into) ||
      normalizeLedgerText(out.payee)!==normalizeLedgerText(into.payee))continue;
    p.proved=1;p.evidence='loan_draw_owned_accounts';
  }
  return locatorConflicts;
}

// This adapter belongs only to the clean SQL tool. The owner ledger reader's
// membership policy and historical compatibility path remain independent.
export function loanDrawReading(row, reading, accounts, pairs) {
  const pair=pairs.find(p=>p.out.id===row.id || p.in.id===row.id);
  const source=pair && accounts.get(pair.out.effective_account_slug),target=pair && accounts.get(pair.in.effective_account_slug);
  if(pair && debt(source) && asset(target) && !conflict(source) && !conflict(target) && !row.clean_transfer_reason &&
      ['ordinary','own_transfer','loan_proceeds'].includes(reading.money_kind) && ![pair.out,pair.in].some(conflictingType))
    return {...reading,classification:'own_transfer',money_kind:'loan_proceeds',estimated:false,estimate_reason:null,uncertain_kind:null};
  if(row.direction==='outflow' && (debt(row) || drawNominated(row)) && !expense(row) &&
      (reading.money_kind==='ordinary' || (!pair || row.clean_transfer_reason) && ['own_transfer','loan_proceeds'].includes(reading.money_kind)))
    return {...reading,classification:'unknown',money_kind:'ordinary',estimated:true,estimate_reason:'possible_loan_proceeds_counted',uncertain_kind:null};
  return reading;
}
