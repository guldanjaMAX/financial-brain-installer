// All analysis is ephemeral over the deduplicated, bounded reader snapshot.
// Neither a transfer hint nor a detected cadence changes stored owner truth.
export const normalizeLedgerText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
export const merchantFor = row => normalizeLedgerText(row.payee || row.description);
const containsTokens = (haystack, needle) => Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
export const matchesMerchant = (row, query) => [row.description, row.payee].some(text => containsTokens(normalizeLedgerText(text), normalizeLedgerText(query)));
export function categoryFor(row) {
  const category = normalizeLedgerText(row.category);
  return !category || !row.category_basis_state || ["unsorted", "uncategorized", "uncategorised", "unknown"].includes(category) ? null : category;
}
export function matchesCategory(row, query) {
  const category = categoryFor(row), wanted = normalizeLedgerText(query);
  if (["unsorted", "uncategorized", "uncategorised"].includes(wanted)) return !category;
  if (!category) return false;
  return ["software", "saas", "software saas"].includes(wanted)
    ? /\b(?:software|saas)\b/.test(category) : containsTokens(category, wanted);
}
export function sumMinor(rows, get = row => row.amount_minor) {
  let total = 0;
  for (const row of rows) {
    total += get(row);
    if (!Number.isSafeInteger(total)) throw new Error("ledger total overflow");
  }
  return total;
}
const dayNumber = day => Date.parse(`${day}T00:00:00Z`) / 86400000;
export function isTransferCandidate(row) {
  return /^TRANSFER_(?:IN|OUT)(?:_|$)/i.test(row.category || "") ||
    /\btransfer (?:to|from)\b/.test(normalizeLedgerText(row.description));
}
export function pairOwnTransfers(rows) {
  const candidates = rows.filter(row => row.amount_minor > 0 && isTransferCandidate(row));
  const buckets = new Map();
  const bucketKey = (row, direction, day) => JSON.stringify([row.currency, row.amount_minor, direction, day]);
  for (const row of candidates) {
    const key = bucketKey(row, row.direction, dayNumber(row.posted_on));
    if (!buckets.has(key)) buckets.set(key, new Map());
    const byAccount = buckets.get(key);
    const group = byAccount.get(row.effective_account_slug) || { count: 0, row };
    group.count++; byAccount.set(row.effective_account_slug, group);
  }
  const peers = new Map();
  for (const row of candidates) {
    let count = 0, peer;
    const opposite = row.direction === "inflow" ? "outflow" : "inflow";
    for (let offset = -3; offset <= 3 && count < 2; offset++) {
      const byAccount = buckets.get(bucketKey(row, opposite, dayNumber(row.posted_on) + offset));
      for (const [account, group] of byAccount || []) {
        if (account === row.effective_account_slug) continue;
        count += group.count; peer = group.row;
        if (count > 1) break;
      }
    }
    if (count === 1) peers.set(row.id, peer);
  }
  const pairs = [], matched = new Set();
  for (const out of candidates.filter(row => row.direction === "outflow")) {
    const incoming = peers.get(out.id);
    // A deterministic tie-break would invent an ownership match in the
    // three-account case. Require mutual uniqueness, even for equal dates.
    if (!incoming || peers.get(incoming.id)?.id !== out.id) continue;
    pairs.push({ out, in: incoming }); matched.add(out.id); matched.add(incoming.id);
  }
  return { pairs, matched, unmatched: candidates.filter(row => !matched.has(row.id)) };
}
export const excludeMatchedTransfers = (rows, matched) => rows.filter(row => !matched.has(row.id));

export function detectRecurring(rows, to) {
  const groups = new Map();
  for (const row of rows) {
    if (row.direction !== "outflow" || row.amount_minor <= 0 || isTransferCandidate(row)) continue;
    const merchant = merchantFor(row);
    if (!merchant) continue;
    if (!groups.has(merchant)) groups.set(merchant, []);
    groups.get(merchant).push(row);
  }
  const result = [];
  for (const [merchant, charges] of groups) {
    if (charges.length < 3) continue;
    charges.sort((a, b) => a.posted_on.localeCompare(b.posted_on) || a.id - b.id);
    const typical = [...charges].sort((a, b) => a.amount_minor - b.amount_minor)[Math.floor(charges.length / 2)].amount_minor;
    // Integer comparison includes exactly +/-10%, without float rounding at
    // the boundary or precision loss when a minor-unit amount is very large.
    if (charges.some(row => {
      const delta = BigInt(row.amount_minor) - BigInt(typical);
      return (delta < 0n ? -delta : delta) * 10n > BigInt(typical);
    })) continue;
    const intervals = charges.slice(1).map((row, i) => dayNumber(row.posted_on) - dayNumber(charges[i].posted_on));
    const cadence = intervals.every(days => days >= 6 && days <= 8) ? "weekly"
      : intervals.every(days => days >= 25 && days <= 35) ? "monthly" : null;
    const last = charges.at(-1);
    // An old run of regular charges does not establish a current subscription.
    if (!cadence || dayNumber(to) - dayNumber(last.posted_on) > (cadence === "weekly" ? 8 : 35)) continue;
    const monthly = cadence === "weekly" ? Number((BigInt(typical) * 52n + 6n) / 12n) : typical;
    if (!Number.isSafeInteger(monthly)) throw new Error("ledger total overflow");
    result.push({ merchant, cadence, typical_minor: typical, monthly_minor: monthly, last_charge: last.posted_on, rows: charges });
  }
  return result.sort((a, b) => a.merchant.localeCompare(b.merchant));
}
