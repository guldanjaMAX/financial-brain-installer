// Reviewed generic bank/processor identities. Every value is a whole normalized
// token sequence, never a prefix. Product words require the separate star-root
// grammar in ledger-analysis; unlisted spellings remain review candidates.
// No snapshot co-occurrence or owner-specific merchant can extend this table.
const FAMILIES = Object.freeze([
  ['google', 'goog'],
  ['amazon', 'amzn', 'amz mktp', 'amz mktp us', 'amzn mktp', 'amzn mktp us'],
  ['microsoft', 'msft'],
  ['apple', 'apple com bill', 'apl'],
  ['adobe'],
  ['meta', 'facebook', 'fb'],
  ['intuit', 'quickbooks', 'intuit quickbooks'],
  ['zoom'],
  ['dropbox'],
  ['shopify'],
].map(family => Object.freeze(family)));
const NONE = Object.freeze([]);
// Both arguments at the selector use normalizeMerchantText. Exact lookup keeps
// a literal product request or a lookalike from becoming a family selector.
export const vendorAliasesFor = normalizedIdentity =>
  FAMILIES.find(family => family.includes(normalizedIdentity)) || NONE;
