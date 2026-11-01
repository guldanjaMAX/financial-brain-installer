// All analysis is ephemeral over the deduplicated, bounded reader snapshot.
// Neither a transfer hint nor a detected cadence changes stored owner truth.
export const normalizeLedgerText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
// Keep literal conjunctions distinct: "A & B", "A and B" and "A B" are
// different selectors. A displayed label must use the same normalization.
export const normalizeMerchantText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+|&/gu) || []).join(" ");
export function senderFor(row) {
  if (row.payee) return normalizeMerchantText(row.payee);
  const text = normalizeMerchantText(row.description);
  const directed = text.match(/\b(?:from|by) (.+)/);
  // A subject after "for" is never the sender, even without an explicit
  // payee. Preserve the opening-sender form used by plain bank descriptions.
  return (directed ? directed[1] : text).split(/\b(?:for|invoice|memo|reference|ref)\b/)[0].trim()
    .replace(/\s+(?:deposit|payment|receipt|payroll|settlement)$/, "");
}
export const merchantFor = row => row.direction === "inflow" ? senderFor(row) : normalizeMerchantText(row.payee || row.description);
const containsTokens = (haystack, needle) => Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
// An explicit payee controls attribution. A memo about another merchant cannot
// turn a payment to this payee into that merchant's income or spend.
export function merchantMatchBasis(row, query) {
  const merchant = merchantFor(row), wanted = normalizeMerchantText(query);
  if (!merchant || !wanted) return "none";
  // A structured merchant/payee can prove exact identity after normalization.
  // Existing inflow sender parsing remains only an attributed, incomplete
  // subtotal in ledger-answer. Outflow description text is never exact.
  if ((row.payee || row.direction === "inflow") && merchant === wanted) return "exact";
  return containsTokens(merchant, wanted) ? "possible" : "none";
}
export const matchesMerchant = (row, query) => merchantMatchBasis(row, query) === "exact";
export function matchesSender(row, wanted) {
  if (!wanted.length) return true;
  const sender = normalizeLedgerText(senderFor(row));
  if (row.payee) {
    const words = new Set(sender.split(" "));
    return wanted.every(word => words.has(word));
  }
  return sender === wanted.join(" ") || sender.startsWith(`${wanted.join(" ")} `);
}
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
function conflictsWithAccountKind(row, account) {
  const text = `${row.description || ""} ${row.payee || ""}`;
  for (const member of account?.members || []) {
    // A card reference cannot identify an owned checking account that happens
    // to have the same mask. Even advisory candidates must honor this conflict.
    if (/^\d{1,4}$/.test(member.mask || '')) {
      const kinds = [...text.toLowerCase().matchAll(new RegExp(`\\b(card|checking|savings|loan|investment|retirement|escrow)(?:\\s+account)?\\s+(?:ending(?:\\s+in)?\\s+)?[x*•]*${member.mask}(?![\\p{L}\\p{N}])`, 'gu'))];
      if (kinds.some(match => match[1] !== member.account_kind)) return true;
    }
  }
  return false;
}
function namesOwnedAccount(row, account, accounts) {
  const text = `${row.description || ""} ${row.payee || ""}`;
  for (const member of account?.members || []) {
    const label = normalizeLedgerText(member.label);
    if (label && containsTokens(normalizeLedgerText(text), label) &&
        [...accounts.values()].filter(a => a.members.some(m => normalizeLedgerText(m.label) === label)).length === 1) return 'one leg names the other account label';
    if (!/^\d{1,4}$/.test(member.mask || "")) continue;
    if ([...accounts.values()].filter(a => a.members.some(m => m.mask === member.mask)).length !== 1) continue;
    // A bare amount or year is not an account reference. Require a mask marker
    // or account/destination wording, with literal digit boundaries.
    if (new RegExp(`(?:\\b(?:account|acct|card|checking|savings|ending|to|from)\\s+(?:ending\\s+)?|(?:^|[^\\p{L}\\p{N}])[x*•]+)${member.mask}(?![\\p{L}\\p{N}])`, "u").test(text.toLowerCase())) return 'one leg names the other account mask';
  }
  return null;
}

function resolvesExactAccount(locator, other, accounts) {
  // NFKC/token normalization removes star and bullet mask decorations. X is a
  // letter, so remove only a bounded X run immediately before the final mask.
  // The account scan below still enforces uniqueness after normalization.
  const text = normalizeLedgerText(locator).replace(/\bx{1,4}(?=\d{1,4}$)/, "");
  const candidates = [...accounts.values()].filter(account => (account.members || []).some(member =>
    (normalizeLedgerText(member.label) && text === normalizeLedgerText(member.label)) ||
    (/^\d{1,4}$/.test(member.mask || "") &&
      new RegExp(`^(?:(?:account|acct|card|checking|savings|loan|line of credit|investment|retirement)(?: account| acct)? )?(?:ending (?:in )?)?(?:x)?${member.mask}$`).test(text))));
  return candidates.length === 1 && candidates[0] === other;
}

export function transferEndpoints(description, { loanAdvance = false } = {}) {
  const text = normalizeLedgerText(description);
  const channel = "(?:(?:online|automatic|mobile|internet) )?";
  const transfer = `${channel}transfer`;
  const bilateral = text.match(new RegExp(`^${transfer} from (.+?) to (.+)$`));
  if (bilateral) return { form: "bilateral", source: bilateral[1], destination: bilateral[2] };
  const verb = loanAdvance
    ? `(?:${transfer}|(?:loan |credit )?(?:advance|disbursement|proceeds))`
    : `(?:${transfer}|${channel}payment)`;
  const unary = text.match(new RegExp(`^(${verb}) (to|from) (.+)$`));
  return unary ? { form: "unary", verb: unary[1], direction: unary[2], locator: unary[3] } : null;
}

// Some feeds copy a channel label into payee rather than naming a counterparty.
// Keep the allowance bounded to the same payment and transfer channels accepted
// by the directed-description grammar. Every other nonempty payee must resolve
// the connected account or it is positive evidence of an external party.
const genericOwnedMovementPayee = payee =>
  /^(?:(?:automatic|internet|mobile|online) )?(?:payment|transfer)$/.test(normalizeLedgerText(payee));
const payeeSupportsOwnedCounterparty = (payee, account, accounts) => {
  const text = normalizeLedgerText(payee);
  return !text || genericOwnedMovementPayee(text) || resolvesExactAccount(text, account, accounts);
};

export function ownedLiabilityPaymentKind(row, accounts) {
  if (row.direction !== "outflow" || row.amount_minor <= 0) return null;
  const source = accounts.get(row.effective_account_slug);
  if (!["checking", "savings"].includes(source?.account_kind)) return null;
  const endpoint = transferEndpoints(row.description);
  if (endpoint?.form !== "unary" || endpoint.direction !== "to") return null;
  const liabilities = [...accounts.values()].filter(account =>
    ["card", "loan", "line_of_credit"].includes(account.account_kind) &&
    resolvesExactAccount(endpoint.locator, account, accounts) && !conflictsWithAccountKind(row, account));
  if (liabilities.length !== 1) return null;
  if (!payeeSupportsOwnedCounterparty(row.payee, liabilities[0], accounts)) return null;
  return liabilities[0].account_kind === "card" ? "card" : "loan";
}

// Advisory equal-amount matches are not enough to remove money. Both legs
// must identify the unique owned counterparty without outside attribution.
export function isDirectedOwnedTransfer(pair, accounts, { loanAdvance = false } = {}) {
  const outAccount = accounts.get(pair.out.effective_account_slug);
  const inAccount = accounts.get(pair.in.effective_account_slug);
  if (!outAccount || !inAccount || outAccount === inAccount ||
      pair.out.direction !== "outflow" || pair.in.direction !== "inflow" ||
      pair.out.amount_minor <= 0 || pair.out.amount_minor !== pair.in.amount_minor ||
      pair.out.currency !== pair.in.currency) return false;
  const unconflicted = (row, other) => {
    const text = normalizeLedgerText(`${row.description || ""} ${row.payee || ""} ${row.category || ""}`);
    if (/\b(?:customer|client|invoice|refund|refunded|reversal|reversed|reimbursement|chargeback|income|revenue|sale|sales)\b/.test(text)) return false;
    if (!payeeSupportsOwnedCounterparty(row.payee, other, accounts)) return false;
    return !conflictsWithAccountKind(row, other);
  };
  if (!unconflicted(pair.out, inAccount) || !unconflicted(pair.in, outAccount)) return false;
  const directed = (endpoints, direction, other) => endpoints?.form === "unary" &&
    endpoints.direction === direction && resolvesExactAccount(endpoints.locator, other, accounts);
  const bilateral = endpoints => endpoints?.form === "bilateral" &&
    resolvesExactAccount(endpoints.source, outAccount, accounts) &&
    resolvesExactAccount(endpoints.destination, inAccount, accounts);
  const outgoing = transferEndpoints(pair.out.description, { loanAdvance });
  const incoming = transferEndpoints(pair.in.description, { loanAdvance });
  // Validate each memo against its posting account and unique owned
  // counterparty. A complete bilateral memo and a compatible unary memo carry
  // the same directed evidence even when a provider formats the legs differently.
  const outgoingDirected = bilateral(outgoing) || directed(outgoing, "to", inAccount);
  const incomingDirected = bilateral(incoming) || directed(incoming, "from", outAccount);
  if (!outgoingDirected) return false;
  if (incomingDirected) return true;
  // A connected card's acknowledgement is a supported payment control. It
  // still needs the uniquely directed outgoing leg and no conflicting payee.
  return !loanAdvance && inAccount.account_kind === "card" &&
    ["checking", "savings"].includes(outAccount.account_kind) &&
    outgoing?.verb?.endsWith("payment") &&
    normalizeLedgerText(pair.in.description) === "payment thank you";
}

export function isLoanAdvance(pair, accounts) {
  return ["loan", "line_of_credit"].includes(accounts.get(pair.out.effective_account_slug)?.account_kind) &&
    ["checking", "savings", "card"].includes(accounts.get(pair.in.effective_account_slug)?.account_kind) &&
    isDirectedOwnedTransfer(pair, accounts, { loanAdvance: true });
}

export function classifyOwnedMovement(pair, accounts) {
  if (!isDirectedOwnedTransfer(pair, accounts)) return null;
  const outKind = accounts.get(pair.out.effective_account_slug)?.account_kind;
  const inKind = accounts.get(pair.in.effective_account_slug)?.account_kind;
  if (["checking", "savings"].includes(outKind) && ["card", "loan", "line_of_credit"].includes(inKind)) {
    return { kind: "owned_liability_payment", liabilityKind: inKind === "card" ? "card" : "loan" };
  }
  if (["checking", "savings", "card"].includes(outKind) && ["checking", "savings", "card"].includes(inKind)) {
    return { kind: "own_transfer" };
  }
  return null;
}
export function pairOwnTransfers(rows, accounts = new Map()) {
  const candidates = rows.filter(row => row.amount_minor > 0);
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
  const pairs = [], candidateRows = new Set();
  for (const out of candidates.filter(row => row.direction === "outflow")) {
    const incoming = peers.get(out.id);
    // A deterministic tie-break would invent an ownership match in the
    // three-account case. Require mutual uniqueness, even for equal dates.
    if (!incoming || peers.get(incoming.id)?.id !== out.id) continue;
    const outAccount = accounts.get(out.effective_account_slug), inAccount = accounts.get(incoming.effective_account_slug);
    if (conflictsWithAccountKind(out, inAccount) || conflictsWithAccountKind(incoming, outAccount)) continue;
    const outsidePayee = (row, other) => normalizeLedgerText(row.payee) &&
      !namesOwnedAccount({ payee: row.payee }, other, accounts);
    if (outsidePayee(out, inAccount) && outsidePayee(incoming, outAccount)) continue;
    const reason = namesOwnedAccount(out, inAccount, accounts) || namesOwnedAccount(incoming, outAccount, accounts);
    if (!reason) continue;
    // Pairs never change stored rows. The answer may leave qualifying pairs
    // out of its lead figures, but always prints the unchanged gross figures.
    pairs.push({ out, in: incoming, reason: `equal amounts, opposite directions, dates within three days; ${reason}` });
    candidateRows.add(out.id); candidateRows.add(incoming.id);
  }
  return { pairs, candidateRows, unmatched: candidates.filter(row => isTransferCandidate(row) && !candidateRows.has(row.id)) };
}

export function detectRecurring(rows, to) {
  const groups = new Map();
  for (const row of rows) {
    if (row.direction !== "outflow" || row.amount_minor <= 0) continue;
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
