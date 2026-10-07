// Invented, fixed-clock records. These are not copied from a provider corpus.
export const SNAPSHOT = "2026-10-07T12:00:00.000Z";
export const CHANGED = "2026-07-24T10:00:00Z";
const customer = { value: "customer-one", name: "Customer One" };
const vendor = { value: "vendor-one", name: "Vendor One" };
const bank = { value: "bank-one", name: "Checking" };
const credit = { value: "card-one", name: "Company Card" };
const transaction = {
  Id: "row-one", SyncToken: "4", domain: "QBO", sparse: false,
  MetaData: { CreateTime: "2026-07-23T10:00:00Z", LastUpdatedTime: CHANGED },
  DocNumber: "1016", TxnDate: "2026-07-23", TotalAmt: 75,
  CurrencyRef: { value: "USD" },
  PrivateNote: "Monthly service", Line: [{ Amount: 75, Description: "Telephone service" }],
};
export const FIXTURES = [
  ["Account", {
    Id: "bank-one", MetaData: transaction.MetaData, Name: "Checking", Active: true,
    AccountType: "Bank", CurrentBalance: 1201, CurrencyRef: { value: "USD" },
  }, "Bank account Checking: balance USD 1,201.00 as of 2026-10-07T12:00:00.000Z."],
  ["Customer", {
    Id: "customer-one", MetaData: transaction.MetaData, DisplayName: "Customer One",
    Balance: 75, CurrencyRef: { value: "USD" },
  }, "Customer One: open balance USD 75.00 as of 2026-10-07T12:00:00.000Z."],
  ["Vendor", {
    Id: "vendor-one", MetaData: transaction.MetaData, DisplayName: "Vendor One",
    Balance: 75, CurrencyRef: { value: "USD" },
  }, "Vendor One: open balance USD 75.00 as of 2026-10-07T12:00:00.000Z."],
  ["Invoice", {
    ...transaction, CustomerRef: customer, Balance: 75, DueDate: "2026-08-22",
    SalesTermRef: { value: "terms-one", name: "Net 30" },
  }, "Invoice 1016 to Customer One: total USD 75.00, open balance USD 75.00 (unpaid) as of 2026-10-07T12:00:00.000Z; dated 2026-07-23, due 2026-08-22, terms Net 30."],
  ["Payment", { ...transaction, CustomerRef: customer, DepositToAccountRef: bank,
    Line: [{ Amount: 75, LinkedTxn: [{ TxnId: "invoice-one", TxnType: "Invoice" }] }],
  }, "Payment from Customer One on 2026-07-23: USD 75.00 to Checking, for invoice invoice-one."],
  ["Bill", { ...transaction, VendorRef: vendor, Balance: 25, DueDate: "2026-08-22" },
    "Bill 1016 from Vendor One: total USD 75.00, open balance USD 25.00 (partially paid) as of 2026-10-07T12:00:00.000Z; dated 2026-07-23, due 2026-08-22."],
  ["Purchase", { ...transaction, EntityRef: vendor, AccountRef: credit, PaymentType: "CreditCard" },
    "Purchase from Vendor One on 2026-07-23: USD 75.00 by credit card, Company Card; Telephone service."],
  ["JournalEntry", { ...transaction, Line: [
    { Amount: 75, Description: "Telephone service", JournalEntryLineDetail: {
      PostingType: "Debit", AccountRef: { value: "expense-one", name: "Telephone Expense" },
    } },
    { Amount: 75, JournalEntryLineDetail: { PostingType: "Credit", AccountRef: bank } },
  ] }, "Journal entry 1016 on 2026-07-23: debit Telephone Expense USD 75.00; credit Checking USD 75.00."],
  ["Deposit", { ...transaction, DepositToAccountRef: bank,
    Line: [{ Amount: 75, Description: "Customer deposit", DepositLineDetail: { Entity: customer } }],
  }, "Deposit on 2026-07-23: USD 75.00 to Checking; Customer One, Customer deposit."],
  ["Transfer", { ...transaction, FromAccountRef: bank, ToAccountRef: { value: "savings-one", name: "Savings" } },
    "Transfer on 2026-07-23: USD 75.00 from Checking to Savings."],
  ["CreditMemo", { ...transaction, CustomerRef: customer, RemainingCredit: 25 },
    "Credit memo 1016 for Customer One on 2026-07-23: total USD 75.00, remaining credit USD 25.00 as of 2026-10-07T12:00:00.000Z."],
  ["BillPayment", { ...transaction, VendorRef: vendor, PayType: "CreditCard",
    CreditCardPayment: { CCAccountRef: credit },
    Line: [{ Amount: 75, LinkedTxn: [{ TxnId: "bill-one", TxnType: "Bill" }] }],
  }, "Bill payment to Vendor One on 2026-07-23: USD 75.00 by credit card (Company Card), for bill bill-one."],
  ["Estimate", { ...transaction, CustomerRef: customer, ExpirationDate: "2026-08-22", TxnStatus: "Pending" },
    "Estimate 1016 for Customer One on 2026-07-23: USD 75.00, pending, expires 2026-08-22; not an invoice or an amount owed."],
  ["SalesReceipt", { ...transaction, CustomerRef: customer, DepositToAccountRef: bank },
    "Sales receipt 1016 for Customer One on 2026-07-23: USD 75.00 to Checking; Telephone service."],
  ["RefundReceipt", { ...transaction, CustomerRef: customer, DepositToAccountRef: bank },
    "Refund receipt 1016 to Customer One on 2026-07-23: USD 75.00 from Checking; Telephone service."],
];
