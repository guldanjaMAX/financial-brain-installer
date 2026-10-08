/** Refusal-only row slots shared by both editions before readable rendering. */
export const PROVEN_SIGN_TYPES = Object.freeze({
  online: Object.freeze([
    "Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset",
    // G4(a), reviewed Online sandbox check (2026-10-07): a liability credit-card
    // CurrentBalance of USD -157.72 correctly rendered as "owes USD 157.72".
    // This proves Online card polarity only; Desktop needs its own sign oracle.
    "Credit Card",
  ]),
  desktop: Object.freeze([]),
});

const PERMANENTLY_EXCLUDED = new Set([
  "Non-Posting", "Income", "Other Income", "Expense", "Other Expense", "Cost of Goods Sold",
]);
// Freeze arrays, not Sets: Object.freeze(new Set()) still permits .add(). A
// future reviewed sign-list edit must also fail at load for non-balance types.
for (const types of Object.values(PROVEN_SIGN_TYPES)) {
  if (types.some((type) => PERMANENTLY_EXCLUDED.has(type))) {
    throw new TypeError("QuickBooks sign list contains a permanently excluded account type");
  }
}

const exactZero = (value) => (typeof value === "number" && value === 0) ||
  (typeof value === "string" && /^-?0+(?:\.0+)?$/.test(value.trim()));

/** Edition is mandatory: a missing Desktop binding must not inherit Online proof. */
export function guardQuickBooksRecord(entity, input, { edition } = {}) {
  return guardRecord(entity, input, edition, PROVEN_SIGN_TYPES);
}

/** Synthetic conformance tests only. No CLI flag, environment variable or
 * manifest option selects this seam. Owner paths always use the export above.
 * Freshness proof here models the future field oracle, not a shipped claim.
 */
export function createQuickBooksGuardForTest({ desktopSignTypes = [], desktopFreshnessVerified = false } = {}) {
  if (!Array.isArray(desktopSignTypes) || desktopSignTypes.some(type => PERMANENTLY_EXCLUDED.has(type))) {
    throw new TypeError("QuickBooks sign list contains a permanently excluded account type");
  }
  const proof = Object.freeze({ ...PROVEN_SIGN_TYPES, desktop: Object.freeze([...desktopSignTypes]) });
  return Object.freeze(Object.assign((entity, input, { edition } = {}) => guardRecord(entity, input, edition, proof), {
    desktopFreshnessVerified: desktopFreshnessVerified === true,
  }));
}

function guardRecord(entity, input, edition, proof) {
  if (!Object.hasOwn(PROVEN_SIGN_TYPES, edition)) throw new TypeError("QuickBooks edition is required");
  const row = { ...input };
  const withheld = [];
  const omit = (field) => {
    if (Object.hasOwn(row, field)) {
      delete row[field];
      withheld.push(field);
    }
  };
  if (exactZero(row.TotalAmt)) {
    if (["Invoice", "Bill", "CreditMemo"].includes(entity)) {
      for (const field of ["TotalAmt", "Balance", "RemainingCredit"]) omit(field);
    } else if (entity === "BillPayment") omit("TotalAmt");
  }
  if (entity === "Account" && !proof[edition].includes(row.AccountType)) omit("CurrentBalance");
  return { row, withheld };
}
