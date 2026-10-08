// Invented provider rows, fixed clocks. The encoder/validator is the real bridge.
import { encodeQbdFrame, qbdPlan, qbdRequests, validateQbdResult } from '../../operations/quickbooks-desktop-bridge.mjs';
import { SNAPSHOT } from './quickbooks-records.mjs';
export { SNAPSHOT };
export const STAMP = '2026-10-07T04:00:00-07:00';
const base = { TimeCreated: '2020-01-01T00:00:00-07:00', TimeModified: STAMP, TxnDate: '2026-07-23', RefNumber: '1016',
  'CurrencyRef.ListID': 'FF-17', IsPending: 'false' };
export function desktopFixture() {
  return {
    HostRet: [{ Country: 'US', ProductName: 'QuickBooks Pro', SupportedQBXMLVersion: ['13.0'] }],
    CompanyRet: [{ IsSampleCompanyFile: 'false' }],
    PreferencesRet: [{ 'CurrentAppAccessRights.IsAutomaticLoginAllowed': 'false', 'CurrentAppAccessRights.IsReadOnly': 'true',
      'CurrentAppAccessRights.IsPersonalDataAccessAllowed': 'false', 'MultiCurrencyPreferences.IsMultiCurrencyOn': 'false',
      'MultiCurrencyPreferences.HomeCurrencyRef.ListID': 'FF-17' }],
    CurrencyRet: [{ ListID: 'FF-17', CurrencyCode: 'USD' }],
    AccountRet: [{ ...base, ListID: 'AA-12', Name: 'Checking', AccountType: 'Bank', Balance: '1201.00', TotalBalance: '1201.00' }],
    CustomerRet: [{ ...base, ListID: 'BB-13', Name: 'Customer One', Sublevel: '0', Balance: '75.00', TotalBalance: '75.00' }],
    VendorRet: [{ ...base, ListID: 'BC-13', Name: 'Vendor One', Balance: '75.00' }],
    InvoiceRet: [{ ...base, TxnID: 'CC-14', Subtotal: '75.00', SalesTaxTotal: '0.00', BalanceRemaining: '75.00', AppliedAmount: '0.00',
      IsPaid: 'false', 'CustomerRef.FullName': 'Customer One', 'CustomerRef.ListID': 'BB-13', 'TermsRef.FullName': 'Net 30', DueDate: '2026-08-22' }],
    TransactionRet: [{ TxnID: 'CC-14', Amount: '75.00', 'CurrencyRef.ListID': 'FF-17' }],
    BillRet: [{ ...base, TxnID: 'DD-15', AmountDue: '75.00', OpenAmount: '25.00', 'VendorRef.FullName': 'Vendor One', DueDate: '2026-08-22' }],
    CreditMemoRet: [{ ...base, TxnID: 'EE-16', TotalAmount: '75.00', Subtotal: '70.00', SalesTaxTotal: '5.00', CreditRemaining: '25.00', 'CustomerRef.FullName': 'Customer One' }],
    BillPaymentCreditCardRet: [{ ...base, TxnID: 'AC-19', Amount: '75.00', 'PayeeEntityRef.FullName': 'Vendor One', 'CreditCardAccountRef.FullName': 'Company Card',
      AppliedToTxnRet: [{ TxnID: 'DD-15', TxnType: 'Bill', Amount: '75.00' }] }],
    BillPaymentCheckRet: [{ ...base, TxnID: 'AB-18', Amount: '75.00', 'PayeeEntityRef.FullName': 'Vendor One', 'BankAccountRef.FullName': 'Checking',
      AppliedToTxnRet: [{ TxnID: 'DD-15', TxnType: 'Bill', Amount: '75.00' }] }],
    ReceivePaymentRet: [{ ...base, TxnID: 'AD-20', TotalAmount: '75.00', 'CustomerRef.ListID': 'BB-13' }],
  };
}
export function desktopBridge(rows = desktopFixture(), { mutateFrames = frames => frames, matchedCount = 0, calls = [] } = {}) {
  return async input => {
    calls.push(input);
    const plan = qbdPlan(input, new Date(SNAPSHOT)); const requests = qbdRequests(input.operation, plan);
    const frames = requests.filter(request => request.mode !== 'postdated').map(request => ({ protocol: 1, type: 'batch',
      request: request.id, entity: request.ret, rows: rows[request.ret] || [] }));
    frames.push({ protocol: 1, type: 'terminal', requests: requests.map(request => ({ id: request.id, statusCode: 0,
      statusSeverity: 'Info', iteratorRemainingCount: 0, requestCount: 1, rowCount: request.mode === 'postdated' ? 0 : (rows[request.ret] || []).length,
      ...(request.mode === 'postdated' ? { matchedCount } : {}) })) });
    return validateQbdResult(Buffer.concat(mutateFrames(frames, input).map(frame => encodeQbdFrame(frame))), input.operation, plan);
  };
}
