export const NOW = "2026-10-29T18:00:00.000Z";
export const OWNER_TIME_ZONE = "America/Phoenix";
export const LAST_SYNCED_AT = "2026-10-29T17:00:00.000Z";

export const ACCOUNTS = Object.freeze([
  { slug: "checking-unit", mask: "1101", kind: "checking", role: "asset" },
  { slug: "savings-unit", mask: "2202", kind: "savings", role: "asset" },
  { slug: "card-unit", mask: "3303", kind: "card", role: "liability" },
  { slug: "loan-unit", mask: "4404", kind: "loan", role: "liability" },
]);

// These minimum rows retain every expense partition in the reviewed EA-R2
// case: ordinary purchases, cash, external P2P, an own-account movement, and
// connected card and loan payments.
export const TRANSACTIONS = Object.freeze([
  { id: "vendor-red-1", account: "card-unit", day: "2026-10-01", amount: 10000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-red-2", account: "card-unit", day: "2026-10-02", amount: 20000, direction: "outflow", description: "VENDOR UNIT RED", payee: null },
  { id: "vendor-red-3", account: "card-unit", day: "2026-10-03", amount: 30000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-red-4", account: "card-unit", day: "2026-10-04", amount: 40000, direction: "outflow", description: "VENDOR UNIT RED", payee: null },
  { id: "vendor-red-5", account: "card-unit", day: "2026-10-05", amount: 50000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-red-6", account: "card-unit", day: "2026-10-06", amount: 60000, direction: "outflow", description: "VENDOR UNIT RED", payee: null },
  { id: "vendor-red-7", account: "card-unit", day: "2026-10-29", amount: 70000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-blue", account: "checking-unit", day: "2026-10-12", amount: 5000, direction: "outflow", description: "VENDOR UNIT BLUE", payee: null },
  { id: "atm-out", account: "checking-unit", day: "2026-10-13", amount: 7500, direction: "outflow", description: "ATM WITHDRAWAL", payee: null },
  { id: "zelle-out", account: "checking-unit", day: "2026-10-14", amount: 4000, direction: "outflow", description: "ZELLE TO OUTSIDE PAYEE", payee: null },
  { id: "vendor-orange", account: "checking-unit", day: "2026-10-15", amount: 6500, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Orange" },
  { id: "p2p-out", account: "checking-unit", day: "2026-10-16", amount: 3500, direction: "outflow", description: "P2P PAYMENT OUTSIDE PAYEE", payee: null },
  { id: "vendor-purple", account: "checking-unit", day: "2026-10-17", amount: 9000, direction: "outflow", description: "VENDOR UNIT PURPLE", payee: null },
  { id: "utility", account: "checking-unit", day: "2026-10-18", amount: 11000, direction: "outflow", description: "AUTOMATIC PAYMENT", payee: "Utility Unit" },
  { id: "own-move-out", account: "checking-unit", day: "2026-10-20", amount: 33333, direction: "outflow", description: "TRANSFER FROM X1101 TO X2202", payee: null },
  { id: "own-move-in", account: "savings-unit", day: "2026-10-20", amount: 33333, direction: "inflow", description: "TRANSFER FROM X1101 TO X2202", payee: null },
  { id: "loan-payment-out", account: "checking-unit", day: "2026-10-21", amount: 45678, direction: "outflow", description: "TRANSFER TO LOAN ACCT 4404", payee: "AUTOMATIC PAYMENT" },
  { id: "loan-payment-in", account: "loan-unit", day: "2026-10-21", amount: 45678, direction: "inflow", description: "TRANSFER FROM ACCOUNT 1101", payee: null },
  { id: "card-payment-out", account: "checking-unit", day: "2026-10-22", amount: 51234, direction: "outflow", description: "PAYMENT TO CARD ENDING 3303", payee: null },
  { id: "card-payment-in", account: "card-unit", day: "2026-10-22", amount: 51234, direction: "inflow", description: "PAYMENT THANK YOU", payee: null },
]);

export const ANSWER_KEY = Object.freeze({
  expenses: {
    total_minor: 326500,
    row_count: 14,
    groups: [
      ["vendor unit red", 280000, 7],
      ["utility unit", 11000, 1],
      ["vendor unit purple", 9000, 1],
      ["atm withdrawal", 7500, 1],
      ["vendor unit orange", 6500, 1],
      ["vendor unit blue", 5000, 1],
      ["zelle to outside payee", 4000, 1],
      ["p2p payment outside payee", 3500, 1],
    ],
    excluded_own_transfer_minor: 33333,
    own_account_payments: { total_minor: 96912, count: 2, card_minor: 51234, loan_minor: 45678 },
  },
});
