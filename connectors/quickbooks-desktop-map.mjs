/** Pure qbXML projection. Arithmetic only refuses; it never supplies an amount. */
import { guardQuickBooksRecord } from './quickbooks-guard.mjs';
import { quickBooksLabelText, quickBooksLabel } from '../worker/src/lib/quickbooks-label.js';

export const QBD_US_SINGLE_CURRENCY_BINDING = false;
export const DESKTOP_ACCOUNT_TYPES = Object.freeze({
  AccountsPayable: 'Accounts Payable', AccountsReceivable: 'Accounts Receivable', Bank: 'Bank',
  CostOfGoodsSold: 'Cost of Goods Sold', CreditCard: 'Credit Card', Equity: 'Equity', Expense: 'Expense',
  FixedAsset: 'Fixed Asset', Income: 'Income', LongTermLiability: 'Long Term Liability', NonPosting: 'Non-Posting',
  OtherAsset: 'Other Asset', OtherCurrentAsset: 'Other Current Asset', OtherCurrentLiability: 'Other Current Liability',
  OtherExpense: 'Other Expense', OtherIncome: 'Other Income',
});
export const desktopEntity = ret => ({ BillPaymentCheckRet: 'BillPayment', BillPaymentCreditCardRet: 'BillPayment',
  ReceivePaymentRet: 'Payment' })[ret] || ret.replace(/Ret$/, '');

export function desktopUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const n = Date.parse(value);
  if (!Number.isFinite(n)) return null;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  const minutes = offset ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1) : 0;
  if (new Date(n + minutes * 60000).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return new Date(n).toISOString();
}
export function desktopMinorUnits(value) {
  if (typeof value !== 'string' || !/^-?\d{1,24}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return BigInt(whole + fraction.padEnd(2, '0')) * (value.startsWith('-') ? -1n : 1n);
}
// NFKC plus Unicode caseless comparison; upper then lower also folds sharp-s
// and final sigma. This errs toward withholding, never toward unique names.
export const desktopNameKey = name => typeof name === 'string' ? name.normalize('NFKC').toUpperCase().toLowerCase() : '';
export function desktopParty(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.some(part => !part.trim() || part.includes('/'))) return null;
  const label = parts.join(' / ');
  return quickBooksLabel(label) ? quickBooksLabelText(label) : null;
}
export function desktopCurrency({ preferences = {}, host = {}, currencies = [], usSingleCurrencyBinding = QBD_US_SINGLE_CURRENCY_BINDING } = {}) {
  if (preferences['MultiCurrencyPreferences.IsMultiCurrencyOn'] !== 'false') return { code: null, source: 'unverified' };
  const id = preferences['MultiCurrencyPreferences.HomeCurrencyRef.ListID'];
  const matches = currencies.filter(row => row.ListID === id);
  // FIELD-VERIFY: CurrencyCode is the provider ISO code; a user-defined name
  // or a missing/ambiguous code is not a currency binding.
  if (id) return matches.length === 1 && /^[A-Z]{3}$/.test(matches[0].CurrencyCode || '') && matches[0].IsUserDefined !== 'true'
    ? { code: matches[0].CurrencyCode, source: 'home_currency_ref' } : { code: null, source: 'unverified' };
  return host.Country === 'US' && usSingleCurrencyBinding === true
    ? { code: 'USD', source: 'us_edition_single_currency' } : { code: null, source: 'unverified' };
}

/** guardRecord is an internal test dependency, never read from owner config. */
export function mapQuickBooksDesktopRecord(ret, input, context = {}, { guardRecord = guardQuickBooksRecord } = {}) {
  const entity = desktopEntity(ret);
  const row = {}; const fieldMap = {}; const withheld = []; const refusalReasons = [];
  const set = (slot, field, source = input, prefix = ret) => {
    if (source?.[field] !== undefined) { row[slot] = source[field]; fieldMap[slot] = `${prefix}.${field}`; }
  };
  const omit = (slots, reason) => { refusalReasons.push(reason); for (const slot of slots) {
    if (Object.hasOwn(row, slot)) { delete row[slot]; withheld.push(slot); }
  } };
  const amounts = ['CurrentBalance', 'TotalAmt', 'Balance', 'RemainingCredit'];
  const equal = (a, b) => desktopMinorUnits(a) !== null && desktopMinorUnits(a) === desktopMinorUnits(b);
  const party = (slot, field) => {
    const name = desktopParty(input[field]);
    if (name) { row[slot] = { name }; fieldMap[`${slot}.name`] = `${ret}.${field}`; }
    else refusalReasons.push('QB_PARTY_UNVERIFIED');
  };
  set('Id', input.ListID !== undefined ? 'ListID' : 'TxnID');
  set('DocNumber', 'RefNumber'); set('TxnDate', 'TxnDate'); set('DueDate', 'DueDate');
  const changed = desktopUtc(input.TimeModified);
  row.MetaData = { LastUpdatedTime: changed };
  fieldMap['MetaData.LastUpdatedTime'] = `${ret}.TimeModified`;
  const currency = desktopCurrency(context);
  if (currency.code) { row.CurrencyRef = { value: currency.code }; fieldMap['CurrencyRef.value'] = currency.source; }
  else refusalReasons.push('QB_CURRENCY_UNVERIFIED');
  switch (entity) {
    case 'Account': {
      set('Name', 'Name');
      if (Object.hasOwn(DESKTOP_ACCOUNT_TYPES, input.AccountType)) {
        row.AccountType = DESKTOP_ACCOUNT_TYPES[input.AccountType]; fieldMap.AccountType = 'AccountRet.AccountType';
      } else refusalReasons.push('QB_ACCOUNT_TYPE_UNVERIFIED');
      set('CurrentBalance', 'Balance');
      if (!equal(input.Balance, input.TotalBalance)) omit(['CurrentBalance'], 'QB_ACCOUNT_ROLLUP');
      if (context.postdatedCount !== 0) omit(['CurrentBalance'], 'QB_POSTDATED');
      const key = desktopNameKey(input.Name);
      if (!key || (context.accounts || []).filter(account => desktopNameKey(account.Name) === key).length !== 1)
        omit(['CurrentBalance'], 'QB_ACCOUNT_NAME_COLLISION');
      break;
    }
    case 'Customer':
      set('DisplayName', 'Name'); set('Balance', 'Balance');
      if (input.Sublevel !== '0' || !equal(input.Balance, input.TotalBalance)) omit(['Balance'], 'QB_CUSTOMER_ROLLUP');
      break;
    case 'Vendor': set('DisplayName', 'Name'); set('Balance', 'Balance'); break;
    case 'Invoice': {
      party('CustomerRef', 'CustomerRef.FullName');
      if (input['TermsRef.FullName']) party('SalesTermRef', 'TermsRef.FullName');
      const transaction = context.transaction;
      set('TotalAmt', 'Amount', transaction, 'TransactionRet'); set('Balance', 'BalanceRemaining');
      const [subtotal, tax, amount, remaining, applied] = [input.Subtotal, input.SalesTaxTotal, transaction?.Amount,
        input.BalanceRemaining, input.AppliedAmount].map(desktopMinorUnits);
      const currencyId = input['CurrencyRef.ListID'];
      if ([subtotal, tax, amount, remaining, applied].some(value => value === null) ||
          subtotal + tax !== amount || amount !== remaining + (applied < 0n ? -applied : applied) ||
          !['true', 'false'].includes(input.IsPaid) || (input.IsPaid === 'true') !== (remaining === 0n) ||
          !currencyId || currencyId !== transaction?.['CurrencyRef.ListID']) omit(['TotalAmt', 'Balance'], 'QB_INVOICE_CROSSCHECK');
      break;
    }
    case 'Bill':
      party('VendorRef', 'VendorRef.FullName'); set('TotalAmt', 'AmountDue'); set('Balance', 'OpenAmount');
      if (input.OpenAmount === undefined) refusalReasons.push('QB_BILL_OPEN_UNVERIFIED');
      break;
    case 'CreditMemo': {
      party('CustomerRef', 'CustomerRef.FullName'); set('TotalAmt', 'TotalAmount'); set('RemainingCredit', 'CreditRemaining');
      const [total, subtotal, tax] = [input.TotalAmount, input.Subtotal, input.SalesTaxTotal].map(desktopMinorUnits);
      if ([total, subtotal, tax].some(value => value === null) || total !== subtotal + tax)
        omit(['TotalAmt', 'RemainingCredit'], 'QB_CREDIT_CROSSCHECK');
      break;
    }
    case 'BillPayment': {
      party('VendorRef', 'PayeeEntityRef.FullName'); set('TotalAmt', 'Amount');
      const check = ret === 'BillPaymentCheckRet'; row.PayType = check ? 'Check' : 'CreditCard';
      const field = check ? 'BankAccountRef.FullName' : 'CreditCardAccountRef.FullName';
      const fullName = input[field]; const name = typeof fullName === 'string' ? desktopParty(fullName.split(':').at(-1)) : null;
      if (name) row[check ? 'CheckPayment' : 'CreditCardPayment'] = { [check ? 'BankAccountRef' : 'CCAccountRef']: { name } };
      else refusalReasons.push('QB_PARTY_UNVERIFIED');
      fieldMap[check ? 'CheckPayment.BankAccountRef.name' : 'CreditCardPayment.CCAccountRef.name'] = `${ret}.${field}`;
      row.LinkedTxn = (input.AppliedToTxnRet || []).filter(link => link.TxnType === 'Bill').map(link => ({ TxnId: link.TxnID, TxnType: 'Bill' }));
      fieldMap.LinkedTxn = `${ret}.AppliedToTxnRet`;
      break;
    }
    case 'Payment':
      set('TotalAmt', 'TotalAmount');
      if (context.customerName) row.CustomerRef = { name: desktopParty(context.customerName) || 'not provided' };
      break;
    default: throw new TypeError('QB_ENTITY_UNSUPPORTED');
  }
  if (input.IsPending === 'true') omit(amounts, 'QB_PENDING');
  if (desktopMinorUnits(row.TotalAmt) === 0n) omit(amounts, 'QB_ZERO_TOTAL');
  if (refusalReasons.includes('QB_PARTY_UNVERIFIED')) omit(amounts, 'QB_PARTY_UNVERIFIED');
  for (const field of amounts) if (Object.hasOwn(row, field) && desktopMinorUnits(row[field]) === null) omit([field], 'QB_AMOUNT_UNVERIFIED');
  const guarded = guardRecord(entity, row, { edition: 'desktop' });
  if (guarded.withheld.length) refusalReasons.push('QB_SHARED_GUARD');
  return { row: guarded.row, withheld: [...new Set([...withheld, ...guarded.withheld])], refusalReasons: [...new Set(refusalReasons)],
    desktop_field_map: fieldMap, currency_source: currency.source };
}
