export const NOW = "2026-10-29T18:00:00.000Z";
export const OWNER_TIME_ZONE = "America/Phoenix";
export const LAST_SYNCED_AT = "2026-10-29T17:00:00.000Z";

export const ACCOUNTS = Object.freeze([
  { slug: "checking-unit", mask: "1101", kind: "checking", role: "asset" },
  { slug: "savings-unit", mask: "2202", kind: "savings", role: "asset" },
  { slug: "card-unit", mask: "3303", kind: "card", role: "liability" },
  { slug: "loan-unit", mask: "4404", kind: "loan", role: "liability" },
]);

export const BALANCES = Object.freeze([
  { account: "checking-unit", day: "2026-10-29", amount: 543210 },
  { account: "savings-unit", day: "2026-10-28", amount: 210045 },
  { account: "card-unit", day: "2026-10-29", amount: 81234 },
  { account: "loan-unit", day: "2026-10-27", amount: 1200000 },
]);

export const EXTRA_BALANCE_ACCOUNTS = Object.freeze([
  { slug: "credit-line-unit-1", mask: "5505", kind: "line_of_credit", role: "liability",
    day: "2026-10-26", amount: 765432 },
  { slug: "credit-line-unit-2", mask: "6606", kind: "line_of_credit", role: "liability",
    day: "2026-10-25", amount: 65432 },
]);

export const ANSWER_KEY = Object.freeze({
  balances: BALANCES.map(row => [ACCOUNTS.find(account => account.slug === row.account).mask,
    row.amount, row.day, LAST_SYNCED_AT]),
});
