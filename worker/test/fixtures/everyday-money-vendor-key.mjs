export const NOW = "2026-10-29T18:00:00.000Z";
export const OWNER_TIME_ZONE = "America/Phoenix";
export const LAST_SYNCED_AT = "2026-10-29T17:00:00.000Z";

export const ACCOUNTS = Object.freeze([
  { slug: "card-unit", mask: "3303", kind: "card", role: "liability" },
]);

// These rows are the production-shaped exact inputs for the compact
// named-vendor contract. The different-supplier row is the M-VN-08 custody
// control and can never enter the requested supplier's total or citations.
export const TRANSACTIONS = Object.freeze([
  { id: "vendor-red-1", account: "card-unit", day: "2026-10-01", amount: 10000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-red-2", account: "card-unit", day: "2026-10-02", amount: 20000, direction: "outflow", description: "VENDOR UNIT RED", payee: "Vendor Unit Red" },
  { id: "vendor-red-3", account: "card-unit", day: "2026-10-03", amount: 30000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-red-4", account: "card-unit", day: "2026-10-04", amount: 40000, direction: "outflow", description: "VENDOR UNIT RED", payee: "Vendor Unit Red" },
  { id: "vendor-red-5", account: "card-unit", day: "2026-10-05", amount: 50000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-red-6", account: "card-unit", day: "2026-10-06", amount: 60000, direction: "outflow", description: "VENDOR UNIT RED", payee: "Vendor Unit Red" },
  { id: "vendor-red-7", account: "card-unit", day: "2026-10-29", amount: 70000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Red" },
  { id: "vendor-blue-1", account: "card-unit", day: "2026-10-28", amount: 5000, direction: "outflow", description: "PURCHASE", payee: "Vendor Unit Blue" },
]);

export const REQUESTED_VENDOR_ROW_REFS = Object.freeze(TRANSACTIONS.flatMap((row, index) =>
  row.payee === "Vendor Unit Red" ? [index + 1] : []));

export const ANSWER_KEY = Object.freeze({
  vendor: { selector: "Vendor Unit Red", total_minor: 280000, row_count: 7, cited_row_count: 5, omitted_row_count: 2 },
});

const account = (slug, mask, kind, coveredFrom = "2026-01-01", coveredTo = "2026-12-31") => ({
  slug, mask, kind, role: ["card", "loan", "line_of_credit"].includes(kind) ? "liability" : "asset",
  label: `${kind} unit`, coveredFrom, coveredTo,
});
const vendorRow = (id, accountSlug, day, amount, payee = "Oracle Vendor") => ({
  id, account: accountSlug, day, amount, direction: "outflow", description: "PURCHASE", payee,
});

const ownedLiabilityPayment = kind => ({
  id: `owned-${kind}`,
  selector: "Owned Liability Unit",
  accounts: [
    account("checking-unit", "1001", "checking"),
    { ...account("liability-unit", "4004", kind), label: "Owned Liability Unit" },
  ],
  rows: [
    { id: `${kind}-out`, account: "checking-unit", day: "2026-10-08", amount: 9100,
      direction: "outflow", description: "PAYMENT TO OWNED LIABILITY UNIT", payee: "Owned Liability Unit" },
    { id: `${kind}-in`, account: "liability-unit", day: "2026-10-08", amount: 9100,
      direction: "inflow", description: "TRANSFER FROM CHECKING UNIT", payee: "Checking Unit" },
  ],
  total: null, rowCount: 0, cited: 0, matchBasis: "none",
  excludedOwnMovements: 1, excludedOwnMovementMinor: 9100,
});

// One matrix owns the whole vendor-payment exclusion class: both supported
// owned-liability kinds are excluded only with bilateral evidence, while the
// adjacent external payment remains a counted green control.
export const VENDOR_PAYMENT_EXCLUSION_CASES = Object.freeze([
  ownedLiabilityPayment("loan"),
  ownedLiabilityPayment("line_of_credit"),
  {
    id: "external-payment-control",
    selector: "External Payment Unit",
    accounts: [account("checking-unit", "1001", "checking")],
    rows: [vendorRow("external-out", "checking-unit", "2026-10-08", 3700, "External Payment Unit")],
    total: 3700, rowCount: 1, cited: 1, matchBasis: "exact",
    excludedOwnMovements: 0, excludedOwnMovementMinor: 0,
  },
]);

// These cases are the vendor-only rows from the reviewed partial-coverage
// oracle. Stable transaction insertion order makes the citation ref suffix a
// direct row-id tie-break control after posted-date descending order.
export const VENDOR_ORACLE_CASES = Object.freeze([
  {
    id: "C16", selector: "Oracle Vendor", coverage: "full", total: 15000,
    accounts: [account("a1", "1001", "checking"), account("a2", "3003", "card")],
    rows: [
      vendorRow("r1", "a1", "2026-10-05", 1000),
      vendorRow("r2", "a1", "2026-10-04", 2000),
      vendorRow("r3", "a2", "2026-10-03", 3000),
      vendorRow("r4", "a2", "2026-10-02", 4500),
      vendorRow("r5", "a1", "2026-10-02", 4500),
    ],
    rowCount: 5, cited: 5, omittedRows: 0, coveredAccounts: 2, omittedAccounts: 0,
    contributingAccounts: 2, citationRefs: [1, 2, 3, 4, 5], excludedOwnMovements: 0,
  },
  {
    id: "C17", selector: "Oracle Vendor", coverage: "zero", total: null,
    accounts: [account("a1", "1001", "checking", "2026-10-15")],
    rows: [vendorRow("u1", "a1", "2026-10-20", 1000), vendorRow("u2", "a1", "2026-10-21", 2000)],
    controlTotal: 3000,
  },
  {
    id: "C18", selector: "Oracle Vendor", coverage: "partial", total: 2800,
    accounts: [account("a1", "3003", "card"), account("a2", "1001", "checking", "2026-10-15")],
    rows: [
      ...[100, 200, 300, 400, 500, 600, 700].map((amount, index) =>
        vendorRow(`r${index + 1}`, "a1", `2026-10-0${index + 1}`, amount)),
      vendorRow("u1", "a2", "2026-10-20", 5000),
    ],
    rowCount: 7, cited: 5, omittedRows: 2, coveredAccounts: 1, omittedAccounts: 1,
    contributingAccounts: 1, citationRefs: [7, 6, 5, 4, 3], excludedOwnMovements: 0,
  },
  {
    id: "C19", selector: "Oracle Vendor", coverage: "full", total: 9876,
    accounts: [account("a1", "3003", "card")],
    rows: [vendorRow("r1", "a1", "2026-10-01", 9876)],
    rowCount: 1, cited: 1, omittedRows: 0, coveredAccounts: 1, omittedAccounts: 0,
    contributingAccounts: 1, citationRefs: [1], excludedOwnMovements: 0,
  },
  {
    id: "C20", selector: "Oracle Vendor", coverage: "partial", total: 1110,
    accounts: [account("a1", "3003", "card"), account("a2", "1001", "checking"),
      account("a3", "2002", "savings", "2026-10-15")],
    rows: [vendorRow("r1", "a1", "2026-10-01", 111), vendorRow("r2", "a1", "2026-10-02", 222),
      vendorRow("r3", "a2", "2026-10-03", 333), vendorRow("r4", "a2", "2026-10-04", 444),
      vendorRow("u1", "a3", "2026-10-20", 555)],
    rowCount: 4, cited: 4, omittedRows: 0, coveredAccounts: 2, omittedAccounts: 1,
    contributingAccounts: 2, citationRefs: [4, 3, 2, 1], excludedOwnMovements: 0,
  },
  {
    id: "C21", selector: "Oracle Vendor", coverage: "full", total: 210,
    accounts: [account("a1", "3003", "card"), account("a2", "1001", "checking")],
    rows: [10, 20, 30, 40, 50, 60].map((amount, index) =>
      vendorRow(`r${index + 1}`, index < 3 ? "a1" : "a2", `2026-10-0${index + 1}`, amount)),
    rowCount: 6, cited: 5, omittedRows: 1, coveredAccounts: 2, omittedAccounts: 0,
    contributingAccounts: 2, citationRefs: [6, 5, 4, 3, 2], excludedOwnMovements: 0,
  },
  {
    id: "C22", selector: "Checking Unit", coverage: "partial", total: 6000,
    accounts: [account("a1", "3003", "card"), account("a2", "1001", "checking", "2026-10-15")],
    rows: [
      vendorRow("r1", "a1", "2026-10-01", 2500, "Checking Unit"),
      vendorRow("r2", "a1", "2026-10-02", 3500, "Checking Unit"),
      vendorRow("u1", "a2", "2026-10-20", 4500, "Checking Unit"),
      { id: "t1-out", account: "a1", day: "2026-10-20", amount: 4000, direction: "outflow",
        description: "PAYMENT TO CHECKING UNIT", payee: "Checking Unit" },
      { id: "t1-in", account: "a2", day: "2026-10-20", amount: 4000, direction: "inflow",
        description: "TRANSFER FROM CARD UNIT", payee: "Card Unit" },
    ],
    rowCount: 2, cited: 2, omittedRows: 0, coveredAccounts: 1, omittedAccounts: 1,
    contributingAccounts: 1, citationRefs: [2, 1], excludedOwnMovements: 1,
  },
]);
