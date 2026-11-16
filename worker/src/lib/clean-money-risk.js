import { platformCategory } from './money-platform.js';
import { normalizeLedgerText as norm } from './money-analysis.js';

// Preserve the existing final category veto alongside positive recognition.
// It is not used by the early reader: gross cash and unrelated selections
// retain their established scores when a category needs operating allocation.
const balanceSheet=Object.freeze(/\b(?:(?:owners?|members?|partners?|shareholders?)(?: s)? (?:draws?|distributions?|contributions?|investments?|equity|capital|pay)\b|capital (?:contributions?|investments?|equity)\b|loan (?:payable|principal|payments?|proceeds|disbursements?)\b|line of credit advances?\b|notes? payable\b|liabilit(?:y|ies)\b|receivables?\b|payables?\b|(?:security |customer |tenant |refundable )?deposits?\b|fixed assets?\b|investments?\b|treasury bills?\b|securities\b|brokerage\b|holdings\b|funds (?:held )?for others\b|(?:client|customer|tenant|trust|custodial|third party) (?:funds|proceeds|payables?|liabilit(?:y|ies)|remittances?)\b|(?:agency|beneficiary|landlord|owner) (?:funds|proceeds|payables?|remittances?|disbursements?)\b|trust\b|escrow\b|transfers?\b|personal expenses?\b|income tax\b|estimated tax\b|distributions?\b)/);
const operatingCategory=Object.freeze(['charitable contributions','personal care','401k employer contributions','freight distribution','partner marketing','sales deposits']);
export function isNonOperatingMoneyCategory(category) {
  const value=norm(category);
  return !operatingCategory.includes(value) && balanceSheet.test(value);
}

// Wording can nominate risk, never prove safety. Allow intervening words in
// deposit/bond descriptions: the liability does not depend on bank phrasing.
export function moneyTypeRisk(row) {
  const text=norm([row.description,row.payee,platformCategory(row)].filter(Boolean).join(' '));
  // A party-only label contains no purchase purpose. Historic sales to that
  // party cannot certify a new remittance, adjustment or allocation either.
  if(norm(row.description) && norm(row.description)===norm(row.payee) && !platformCategory(row))return 'kind_not_proved';
  if(/\b(?:investments?|treasury bills?|securities|brokerage|holdings)\b/.test(text))return 'financial_counterparty_type_unproved';
  if(/\b(?:allocations?|remittances?|order adjustments?)\b/.test(text) && !/\b(?:processor|stripe|paypal|square)\b/.test(text))return 'kind_not_proved';
  // Incoming rent can be earned receipts, advance occupancy or another owner's
  // cash. That ambiguity does not turn ordinary outgoing rent into principal.
  // Explicit bonds, prepayments and returns retain their independent checks.
  if(row.direction==='inflow' && /\b(?:rent|tenancy)\b/.test(text) || /\breserves?\b/.test(text) ||
    /\b(?:tenant|customer|client)\b.{0,45}\b(?:held|paid back|money back)\b/.test(text))return 'entrusted_principal_unproved';
  if(row.direction==='inflow' && /\b(?:bank|credit union)\b/.test(norm(row.payee)))return 'financial_counterparty_type_unproved';
  if(/\b(?:financial|finance|capital|credit corp|borrower|employee advances?|due (?:to|from) officer)\b/.test(text) &&
      !/^(?:finance|bank|account|service|interest) charges?$/.test(norm(row.description)))return 'financial_counterparty_type_unproved';

  if(/\b(?:affirm|klarna|afterpay)\b/.test(text) || /\b(?:paypal|venmo|cash app) (?:cashout|cash out|withdrawal|transfer|inst xfer|add (?:funds|cash|money)|load (?:funds|cash|money)|top up)\b/.test(text))return 'financial_counterparty_type_unproved';
  if(/\b(?:non business|not business|due (?:to|from) (?:owner|shareholder|partner))\b/.test(text))return 'category_names_nonoperating_account';
  if(row.direction==='inflow' && /\b(?:proration|prorated|cancellation|dues|account) credits?\b/.test(norm(row.description)))return 'return_membership_unproved';

  if(!row.payee && /^(?:(?:online|automatic|recurring|mobile) )?(?:ach (?:debit|credit)|payments?|wire|transfer|deposit|withdrawal|check|draft|debit|credit)(?: \d+)?$/.test(norm(row.description)) && (!row.category || row.category_basis_state!=='confirmed'))return 'rail_only_counterparty_unrecorded';
  if(/\b(?:not|non|no) (?:income|sales|revenue)\b/.test(platformCategory(row)))return 'kind_not_proved';
  if(/\b(?:refundable|held as liability|collected for (?:the )?landlord)\b/.test(text))return 'entrusted_principal_unproved';
  if(/\b(?:unpaid|dishonou?red|bounced?) (?:deposited )?(?:items?|checks?|cheques?)\b/.test(text))return 'return_membership_unproved';
  if(/\b(?:atm|cash) (?:cash )?withdrawal|promotional balance|balance advance\b/.test(text))return 'financial_counterparty_type_unproved';
  if (/\b(?:sales|use|excise) taxes?\b|\b(?:vat|gst|hst|taxes? (?:collected|payable|withheld))\b/.test(text) && row.direction==='inflow') return 'tax_collected_not_income';
  if (['escrow','trust'].includes(row.account_kind) || /\b(?:escrow|trust)\b/.test(norm((row.description||'')+' '+platformCategory(row))) ||
      /\b(?:security|refundable|tenant|pet|rental|damage|key|utility|holding)\b.{0,60}\b(?:deposits?|bonds?)\b|\b(?:deposits?|bonds?)\b.{0,60}\b(?:security|refundable|tenant|held|returnable)\b/.test(text) ||
      /\b(?:trust funds|custodial|custody|client funds|tenant funds|beneficiar(?:y|ies)|third party|agency remittances?|landlord remittances?|rent remittances?|payable settlement|money held|funds held|held for|as agent)\b/.test(text) ||
      /\b(?:remittances?|distributions?|disbursements?)\b.{0,45}\b(?:owners?|landlords?|beneficiar(?:y|ies)|principal|tenant)\b|\b(?:owner|landlord|agency|beneficiary|third party)\b.{0,45}\b(?:remittances?|distributions?|disbursements?)\b/.test(text)) return 'entrusted_principal_unproved';
  if (/\b(?:loans?|lenders?|lending|financing|credit card payment|card repayment|mortgage|principal|capital advance|cash advance|financing|borrowed|bnpl|installments?|instalments?|notes? payable|receivables?|payables?|refinanc\w*|payoff)\b/.test(text)) return 'financial_counterparty_type_unproved';
  if (/^(?:to|from) (?:savings|checking|reserve|vault|share|personal|account)\b/.test(norm(row.description)))return 'rail_only_counterparty_unrecorded';
  if (/\b(?:deposit|credit|transfer) from\b.{0,70}\b(?:bank|credit union)\b/.test(text))return 'financial_counterparty_type_unproved';
  if (/\b(?:owners?|shareholders?|members?|partners?)\b.{0,35}\b(?:funding|money|draws?|contributions?|distributions?|equity|capital|investments?|pay|reimbursements?)\b|\b(?:personal(?! care(?: |$))(?: expenses?)?|household|wallet|top up|topup|moved? to|moved? from|add money|book entry|pocket allocation|funds moved)\b/.test(text)) return 'category_names_nonoperating_account';
  if (/\b(?:refunds?|refunded|reversals?|reversed|returned|return of|bounced?|dishonou?red|reimbursements?|chargebacks?|disputes?|provisional)\b/.test(norm((row.description||'')+' '+platformCategory(row))) && !/\b(?:fee|fees|protection|insurance|service)\b/.test(norm(row.description))) return 'return_membership_unproved';
  if (row.direction==='outflow' && /\b(?:income tax|estimated tax|1040\w*|usataxpymt|eftps|franchise tax b(?:oa)?[rd]|department of revenue|tax authority)\b/.test(text) || /^tax(?:es)?$/.test(platformCategory(row))) return 'tax_payment_type_unproved';
  return null;
}
