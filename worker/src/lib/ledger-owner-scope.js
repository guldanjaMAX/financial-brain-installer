const businessWords = /\b(?:business|biz|company|corporate|shops?)\b/;
const personalWords = /\b(?:personal|own|household)\b/;

// Only the confirmed owned-entity join supplies ownership. A trust without a
// declared purpose, or linked members with conflicting purposes, stays unknown.
export function resolveOwnershipScope(inventory, selector) {
  const words = String(selector || '').normalize('NFKC').toLowerCase()
    .replace(/[’']/g, '').replace(/\b(?:accounts?|accts?)\b/g, '')
    .replace(/\s+/g, ' ').trim().replace(/^(?:my|our|the) /, '');
  // Ownership is an independent constraint, not a whole nickname. Remaining
  // account-type or label words must never turn this boundary into a broad
  // inventory fallback. Conflicting ownership words cannot authorize either.
  const business = businessWords.test(words);
  const personal = personalWords.test(words);
  const kind = business && personal ? 'unresolved' : business ? 'business' : personal ? 'personal' : null;
  if (!kind) return null;
  const ownership = account => {
    const kinds = (account.members || [account]).map(member => member.entity_kind === 'business' ? 'business'
      : ['person', 'household'].includes(member.entity_kind) ? 'personal' : null);
    return kinds.length && kinds.every(value => value && value === kinds[0]) ? kinds[0] : null;
  };
  const accounts = inventory.filter(account => ownership(account) === kind);
  // Account-type nouns describe the ownership reading used by existing callers.
  // Any other residual words are a separate nickname restriction, never permission
  // to answer for every account sharing the same owner.
  const residual = words.replace(new RegExp(businessWords.source, 'g'), ' ')
    .replace(new RegExp(personalWords.source, 'g'), ' ')
    .replace(/\b(?:my|our|the|checking|savings|card|loan)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return { kind, selector: words, residual, accounts, unknown: inventory.filter(account => ownership(account) === null), empty: accounts.length === 0 };
}
