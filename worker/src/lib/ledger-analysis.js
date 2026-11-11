import { vendorAliasesFor } from "./vendor-aliases.js";

// All analysis is ephemeral over the deduplicated, bounded reader snapshot.
// Neither a transfer hint nor a detected cadence changes stored owner truth.
export const normalizeLedgerText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
// Keep literal conjunctions distinct: "A & B", "A and B" and "A B" are
// different selectors. A displayed label must use the same normalization.
export const normalizeMerchantText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+|&/gu) || []).join(" ");
export const REFUND_MATCH_DAYS = 90;
// For 0.4.28, only a documented provider refund/reversal type could authorize
// subtraction. No current adapter supplies one. Matches only nominate candidates
// for disclosure; there is deliberately no refund certification or capacity here.
export function refundCandidateIds(charges, credits) {
  return new Set(credits.filter(credit => {
    const text = normalizeLedgerText(`${credit.description || ''} ${credit.payee || ''}`);
    if (/\b(?:refunds?|refunded|reversals?|reversed|reimbursements?|chargebacks?|dispute|returned purchase)\b/.test(text)) return true;
    const identity = normalizeMerchantText(credit.payee);
    return charges.some(charge => charge.currency === credit.currency &&
      Math.abs(Date.parse(credit.posted_on) - Date.parse(charge.posted_on)) <= REFUND_MATCH_DAYS * 86400000 &&
      (identity && normalizeMerchantText(charge.payee) === identity || charge.amount_minor === credit.amount_minor));
  }).map(row => row.id));
}

// Movement membership is independent of pair uniqueness. A same-amount
// collision must never promote a payment acknowledgement into a refund candidate.
// A bare owned-label collision alone does not prove movement membership.
export function refundCreditMembership(rows, pairs, accounts) {
  const membership = ordinaryMoneyMembership(rows, pairs, accounts);
  const possibleMovement = row => isTransferCandidate(row) || Boolean(transferEndpoints(row.description) || transferEndpoints(row.description, { loanAdvance: true })) ||
    /^(?:LOAN_PAYMENTS|LOAN_DISBURSEMENTS|TRANSFER_IN|TRANSFER_OUT)(?:_|$)/i.test(row.category || '') ||
    (['card', 'loan', 'line_of_credit'].includes(accounts.get(row.effective_account_slug)?.account_kind) &&
      /\b(?:payment|repayment|autopay)\b/.test(normalizeLedgerText(row.description))) ||
    /\b(?:loan (?:disbursement|advance)|(?:card|loan) payment|payment (?:thank you|received|from|to)|transfer (?:to|from))\b/.test(normalizeLedgerText(row.description)) ||
    // Naming the posting account describes where a merchant credit landed.
    // Only a different effective owned account can be a movement counterparty.
    [...accounts.values()].some(account => account.account_slug !== row.effective_account_slug && (account.members || [account]).some(member =>
      /^\d{1,4}$/.test(member.mask || '') && new RegExp(`\\b(?:account|acct|card|checking|savings|loan|ending) (?:ending (?:in )?)?[x*•]*${member.mask}(?![\\p{L}\\p{N}])`, 'u')
        .test(normalizeLedgerText(row.description))));
  return membership.ordinary.filter(row => row.direction === 'inflow' &&
    !possibleMovement(row));
}
export function senderFor(row) {
  if (row.payee) return normalizeMerchantText(row.payee);
  const text = normalizeMerchantText(row.description);
  const directed = text.match(/\b(?:from|by) (.+)/);
  // A subject after "for" is never the sender, even without an explicit
  // payee. Preserve the opening-sender form used by plain bank descriptions.
  return (directed ? directed[1] : text).split(/\b(?:for|invoice|memo|reference|ref)\b/)[0].trim()
    .replace(/\s+(?:deposit|payment|receipt|payroll|settlement)$/, "");
}
// Description-only identity can support a positive conditional figure, never
// payer absence or zero income. Every payer selector shares this basis.
export const payerAttributionBasis = row => row.payee ? 'structured'
  : row.amount_minor > 0 ? 'description_assumption' : 'unconfirmed';
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
  if ((row.payee || row.direction === "inflow" && payerAttributionBasis(row) === "description_assumption") && merchant === wanted) return "exact";
  return containsTokens(merchant, wanted) ? "possible" : "none";
}
export const matchesMerchant = (row, query) => merchantMatchBasis(row, query) === "exact";
// Descriptor decoration is not a product suffix. Only explicit processor and
// terminal store-number syntax is stripped; words after it have no proven
// location field and remain identity. A brand prefix never certifies identity.
export const vendorIdentity = value => normalizeMerchantText(String(value || '').normalize('NFKC')
  .replace(/^\s*(?:processor|paypal|sq|tst)\s*\*\s*/i, '')
  .replace(/\s+#\d+$/u, ''));
export function selectVendorFamily(rows, query, { allowProductFamily = true } = {}) {
  // The owner's selector is an identity, not a bank descriptor to shorten.
  const wanted = normalizeMerchantText(query);
  const aliases = vendorAliasesFor(wanted);
  const exact = [], family = [], possible = [], descriptors = [], possibleIdentity = [];
  // A star maps a recorded product to its exact vendor root. Snapshot
  // uniqueness cannot prove that a shorter root names the same business.
  const descriptorRoot = value => {
    const text = String(value || '').normalize('NFKC')
      .replace(/^\s*(?:processor|paypal|sq|tst)\s*\*\s*/i, '');
    const parts = text.match(/^\s*([^*]+?)\s*\*\s*[\p{L}\p{N}]/u);
    return parts ? normalizeMerchantText(parts[1]) : '';
  };
  for (const row of rows) {
    const identity = vendorIdentity(row.payee);
    if (wanted && (normalizeMerchantText(row.payee) === wanted || identity === wanted)) { exact.push(row); continue; }
    const root = descriptorRoot(row.payee);
    if (allowProductFamily && wanted && root === wanted) { descriptors.push(row); continue; }
    // Only a reviewed whole alias can certify a different root or plain payee.
    // Protected literal payees disable this expansion with product families.
    if (allowProductFamily && wanted && root !== wanted && aliases.includes(root || identity)) { descriptors.push(row); continue; }
    // Shared characters suggest review only, including shortened descriptor
    // roots, suffixes and embedded names. Never promote them by co-occurrence.
    const candidate = root || identity;
    if (wanted && candidate && candidate !== wanted &&
        (candidate.includes(wanted) || wanted.includes(candidate) ||
          aliases.some(alias => candidate.includes(alias) || alias.includes(candidate))) &&
        (root || !containsTokens(identity, wanted))) {
      possibleIdentity.push(row); continue;
    }
    if (wanted && identity.startsWith(wanted + ' ')) { family.push(row); continue; }
    if (merchantMatchBasis(row, query) === "possible") possible.push(row);
  }
  // Plain name prefixes remain candidates, separate from product descriptors.
  return { exact, family: [...family, ...descriptors], nameOnly: family,
    matched: [...exact, ...family, ...descriptors], possible, possibleIdentity,
    ambiguous: false, candidates: [] };
}
export function matchesSender(row, wanted) {
  if (!wanted.length) return true;
  if (payerAttributionBasis(row) === "unconfirmed") return false;
  const sender = normalizeLedgerText(senderFor(row));
  if (row.payee) {
    // Shared words and suffixes do not establish a structured payer's identity.
    return sender === wanted.join(" ");
  }
  return sender === wanted.join(" ") || sender.startsWith(`${wanted.join(" ")} `);
}
export const isUncategorizedBucket = query => ["unsorted", "uncategorized", "uncategorised"].includes(normalizeLedgerText(query));
// A proposed label is a review candidate, never membership evidence for a figure.
// Both renderers keep rows returning null visible as unconfirmed membership.
export function categoryFor(row) {
  const category = normalizeLedgerText(row.category);
  return !category || row.category_basis_state !== "confirmed" || isUncategorizedBucket(category) || category === "unknown" ? null : category;
}
export function matchesCategory(row, query) {
  const category = categoryFor(row), wanted = normalizeLedgerText(query);
  if (isUncategorizedBucket(wanted)) return !category;
  if (!category) return false;
  return category === wanted;
}
export function sumMinor(rows, get = row => row.amount_minor) {
  // Signed balances can cancel after an intermediate sum leaves the safe
  // Number range. Preserve exact cents regardless of reader/display ordering.
  let total = 0n;
  for (const row of rows) {
    const value = get(row);
    if (!Number.isSafeInteger(value)) throw new Error("ledger total overflow");
    total += BigInt(value);
  }
  const result = Number(total);
  if (!Number.isSafeInteger(result)) throw new Error("ledger total overflow");
  return result;
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

const hasAccountKindConflict = account => Boolean(account?.account_kind_balance_conflict ||
  account?.members?.some(member => member.account_kind_balance_conflict));

function resolveExactAccount(locator, accounts, allowUnknownKind = false, allowLabel = true) {
  // NFKC/token normalization removes star and bullet mask decorations. X is a
  // letter, so remove only a bounded X run immediately before the final mask.
  // The account scan below still enforces uniqueness after normalization.
  const text = normalizeLedgerText(locator).replace(/\bx{1,4}(?=\d{1,4}$)/, "");
  // A number marker is locator syntax, never account-type evidence. Keep the
  // whole locator anchored and reject a stated kind that conflicts with the
  // stored type, including when a provider inserts "acct no." before the mask.
  const statedKind = /^(card|checking|savings|loan|line of credit|investment|retirement)\b/.exec(text)?.[1]?.replaceAll(" ", "_");
  const candidates = [...accounts.values()].filter(account => (account.members || []).some(member =>
    (allowLabel && normalizeLedgerText(member.label) && text === normalizeLedgerText(member.label)) ||
    (/^\d{1,4}$/.test(member.mask || "") &&
      new RegExp(`^(?:(?:account|acct|card|checking|savings|loan|line of credit|investment|retirement)(?: account| acct)? (?:number |no )?)?(?:ending (?:in )?)?(?:x)?${member.mask}$`).test(text))));
  // A stated type is a consistency check after identity is unique across the
  // whole inventory. It cannot distinguish two accounts sharing one mask.
  const other = candidates.length === 1 ? candidates[0] : null;
  return other && (!statedKind || statedKind === other.account_kind ||
    allowUnknownKind && (other.account_kind === 'other' || hasAccountKindConflict(other))) ? other : null;
}

function resolvesExactAccount(locator, other, accounts, allowUnknownKind = false, allowLabel = true) {
  return Boolean(other) && resolveExactAccount(locator, accounts, allowUnknownKind, allowLabel) === other;
}

// Exact stored labels can identify an owner-reviewed liability, including a
// linked member with no mask. Provider labels alone do not establish review.
// Expense categories are checked separately before identity can exclude money.
const resolvesPaymentAccount = (locator, account, accounts) =>
  resolvesExactAccount(locator, account, accounts, false,
    [account, ...(account?.members || [])].some(member =>
      member?.account_kind_review?.state === 'current' && member.balance_role === 'liability'));

const hasExplicitExpenseCategory = row =>
  /\b(?:fees?|interest|purchases?|merchandise|services?|food|drink|entertainment|home improvement|medical|personal care|government|transportation|travel|rent|utilities)\b/.test(normalizeLedgerText(row.category));

export function transferEndpoints(description, { loanAdvance = false } = {}) {
  const text = normalizeLedgerText(description);
  const channel = "(?:(?:online|automatic|mobile|internet) )?";
  const transfer = `${channel}transfer`;
  const bilateral = text.match(new RegExp(`^${transfer} from (.+?) to (.+)$`));
  if (bilateral) return { form: "bilateral", source: bilateral[1], destination: bilateral[2] };
  const verb = loanAdvance
    ? `(?:${transfer}|(?:loan |credit )?(?:advance|disbursement|proceeds))`
    : `(?:${transfer}|${channel}(?:loan )?payment)`;
  const unary = text.match(new RegExp(`^(${verb}) (to|from) (.+)$`));
  return unary ? { form: "unary", verb: unary[1], direction: unary[2], locator: unary[3] } : null;
}

// Some feeds copy a channel label into payee rather than naming a counterparty.
// Recognition and unresolved-component guards share this closed channel grammar.
// Keep the allowance bounded to the same payment and transfer channels accepted
// by the directed-description grammar. Every other nonempty payee must resolve
// the connected account or it is positive evidence of an external party.
export const isOwnedMovementChannel = (payee, { liabilityOnly = false, cardOnly = false } = {}) => {
  const match = /^(?:(?:automatic|internet|mobile|online) )?((?:(?:(?:credit card|card|loan) )?payment|transfer))$/.exec(normalizeLedgerText(payee));
  // Reader policies may select a typed channel, but never re-parse prefixes or
  // case. Unqualified payment/transfer labels retain their advisory meaning.
  return Boolean(match && (!liabilityOnly || ['credit card payment', 'card payment', 'loan payment'].includes(match[1])) &&
    (!cardOnly || ['credit card payment', 'card payment'].includes(match[1])));
};

// Disclosure candidates have unresolved ownership and cannot prove exclusions.
// Reuse the whole bounded locator grammar, including kind syntax, to distinguish
// a recorded uncertain account from outside payees or malformed endpoint text.
export function uncertainOwnedMovementEndpoint(row, uncertainAccounts) {
  const endpoint = transferEndpoints(row.description);
  if (endpoint?.form !== 'unary' || endpoint.direction !== (row.direction === 'outflow' ? 'to' : 'from')) return false;
  return uncertainAccounts.some(account => {
    if (account.account_slug === row.effective_account_slug) return false;
    const candidate = { ...account, account_kind: 'other', members: [account] };
    return resolvesExactAccount(endpoint.locator, candidate, new Map([[candidate.account_slug, candidate]]), true);
  });
}
const payeeSupportsOwnedCounterparty = (payee, account, accounts) => {
  const text = normalizeLedgerText(payee);
  // Some feeds repeat the directed movement memo as the payee. Resolve its
  // whole endpoint, never a substring or an outside party's account mention.
  const endpoint = transferEndpoints(text);
  return !text || isOwnedMovementChannel(text) || resolvesExactAccount(text, account, accounts) ||
    endpoint?.form === 'unary' && resolvesExactAccount(endpoint.locator, account, accounts);
};

// A distinct outside party is stronger evidence than a generic movement memo.
// Feed labels and fully resolved owned endpoints do not assert an outside party.
export function hasIndependentOutsidePayee(row, accounts) {
  const payee = normalizeLedgerText(row.payee);
  return Boolean(payee && payee !== normalizeLedgerText(row.description) && !isOwnedMovementChannel(payee) &&
    ![...accounts.values()].some(account => payeeSupportsOwnedCounterparty(payee, account, accounts)));
}

function ownedLiabilityPaymentAccount(row, accounts) {
  if (row.direction !== "outflow" || row.amount_minor <= 0 || hasExplicitExpenseCategory(row)) return null;
  const source = accounts.get(row.effective_account_slug);
  if (!["checking", "savings"].includes(source?.account_kind)) return null;
  const endpoint = transferEndpoints(row.description);
  if (endpoint?.form !== "unary" || endpoint.direction !== "to") return null;
  const liabilities = [...accounts.values()].filter(account =>
    ["card", "loan", "line_of_credit"].includes(account.account_kind) &&
    resolvesPaymentAccount(endpoint.locator, account, accounts) && !conflictsWithAccountKind(row, account));
  if (liabilities.length !== 1) return null;
  if (!payeeSupportsOwnedCounterparty(row.payee, liabilities[0], accounts)) return null;
  return liabilities[0];
}

export function ownedLiabilityPaymentKind(row, accounts) {
  const account = ownedLiabilityPaymentAccount(row, accounts);
  return account ? account.account_kind === "card" ? "card" : "loan" : null;
}

// Payment membership is independent of connectivity and category review. A
// bank payment code is evidence about the movement, not an owner spending
// category. Interest, fees, purchases and a payee merely mentioning a loan
// are still ordinary activity. Every monetary reader uses this same rule.
export function loanCardPaymentKind(row, accounts) {
  const category = normalizeLedgerText(row.category);
  const bankKind = /^(?:loan payments?|credit card payments?)(?: |$)/.test(category)
    ? /\bcredit card\b/.test(category) ? "card" : "loan" : null;
  if (bankKind) return bankKind;
  const account = loanCardPaymentAccount(row, accounts);
  return account ? account.account_kind === 'card' ? 'card' : 'loan' : null;
}

// Own-account destination roles, in priority order. Each is a bounded word in
// the destination of a directed movement, a contribution code or an owner
// draw/contribution, never a free-standing substring of a merchant memo.
const ownDestinationRoles = [
  ['personal account (owner draw)', /\bowners? (?:s )?(?:draw|distribution)s?\b/],
  ['business account (owner contribution)', /\b(?:owners? (?:s )?|capital )contributions?\b/],
  ['account (sent to yourself)', /\b(?:self|myself|yourself)\b/],
  ['personal account', /\bpersonal (?:account|acct|checking|savings)\b/],
  ['business account', /\bbusiness (?:account|acct|checking|savings)\b/],
  ['retirement account', /\b(?:retirement|ira|roth|401k|403b)\b/],
  ['investment account', /\b(?:brokerage|investments?|invest)\b/],
  ['savings account', /\b(?:savings?|money market)\b/],
  ['escrow account', /\bescrow\b/],
  ['checking account', /\b(?:checking|chk)\b/],
];
// A second account mask: an explicit x-run mask or an account/ending marker
// before 2-4 digits. A bare amount, year or reference number is not a mask.
const ownMaskPattern = /\bx{1,4}\d{2,4}\b|\b(?:account|acct|ending)(?: (?:number|no))?(?: ending)?(?: in)? x{0,4}\d{2,4}\b/;
// A whole destination that is only an owner's account word, optionally with an
// account noun, a mask and a closed tail of component words or amounts (the
// mixed-component refusal reads that tail). Any other following name is a party.
const ownMaskTail = '(?: (?:ending )?(?:in )?x{0,4}\\d{2,4})?';
// SELF and retirement bank codes may end with a closed account locator.
// Keep party names outside this suffix; a locator nominates, never proves ownership.
const ownAccountLocatorTail = '(?: (?:(?:account|acct)(?: (?:number|no))? )?(?:ending )?(?:in )?x{0,4}\\d{2,4})?';
const ownComponentTail = '(?: (?:principal|interest|fees?|charges?|penalt(?:y|ies)|plus|and|usd|\\d+))*';
const wholeOwnDestination = words => new RegExp(`^(?:(?:my|own|the|a) )?(${words})(?: (?:account|acct))?${ownMaskTail}${ownComponentTail}$`);
const bareOwnDestination = wholeOwnDestination('personal|business');
// A destination names a connected account by a digit token equal to another
// account's mask or by containing its stored label as whole tokens.
const namesConnectedAccount = (destination, row, accounts) => {
  const source = accounts.get(row.effective_account_slug);
  const others = [...accounts.values()].filter(account => account !== source).flatMap(account => [account, ...(account.members || [])]);
  const numbers = [...destination.matchAll(/(?:^|\s)x{0,4}(\d{2,4})(?=\s|$)/g)].map(match => match[1]);
  return others.some(member => numbers.includes(member.mask) ||
    normalizeLedgerText(member.label) && containsTokens(destination, normalizeLedgerText(member.label)));
};
// Match the complete locator. An account word inside a supplier's identity is
// never ownership evidence, even when its last digits resemble an owned mask.
const ownDestinationRole = destination => ownDestinationRoles.find(([, pattern]) =>
  wholeOwnDestination(pattern.source.replaceAll('\\b', '')).test(destination))?.[0] ||
  bareOwnDestination.exec(destination)?.[1].concat(' account') ||
  (wholeOwnDestination('account|acct').test(destination) ? 'account' : null) ||
  (/^(?:(?:my|own|another|other|external|linked) )?(?:account|acct)$/.test(destination) ||
    /^(?:x{1,4}\d{2,4}|(?:account|acct|ending)(?: (?:number|no))?(?: ending)?(?: in)? x{0,4}\d{2,4})$/.test(destination) ? 'account' : null);

// The movement grammar: directed transfer/wire verbs (unilateral or bilateral),
// person-to-person to self, contribution codes, and owner draws/contributions.
function ownMovementDestination(text) {
  const directed = text.match(/\b(?:transfer|xfer|trf|wire)(?: (?:out|funds))? (?:to|into) (.+)$/) ||
    text.match(/\b(?:transfer|xfer|trf|wire) from .+? (?:to|into) (.+)$/);
  if (directed) return { destination: directed[1], role: ownDestinationRole(directed[1]) };
  const p2p = text.match(new RegExp(`\\b(?:zelle|venmo|cash app|paypal|apple cash)\\b.*?\\b(?:to|for|from) (self|myself|yourself)${ownAccountLocatorTail}(?: (?:ref|reference) \\d{2,12})?$`));
  if (p2p) return { destination: p2p[1], role: ownDestinationRole(p2p[1]) };
  const roles = ownDestinationRoles.slice(0, 2).find(([, pattern]) => pattern.test(text));
  if (roles) return { destination: text, role: roles[0] };
  // Remittance is the retirement contribution channel's sibling, not a new
  // keyword search over vendor memos. The entire bank code must fit.
  if (new RegExp(`^(?:ach (?:debit |dr |pmt |withdrawal )?)?(?:owner )?(?:retirement|ira|roth(?: ira)?|401k|403b)(?: account)? remittances?${ownAccountLocatorTail}${ownComponentTail}$`).test(text))
    return { destination: text, role: 'retirement account' };
  if (/\bcontrib(?:ution)?s?\b/.test(text)) {
    const role = ownDestinationRoles.find(([, pattern]) => pattern.test(text))?.[0];
    if (role || /\bach\b/.test(text)) return { destination: text, role: role || 'account' };
  }
  return null;
}

// The same closed movement grammar read on any posting's own text: the role
// it names (an owner contribution or draw, a transfer to an own account), or
// null. It never resolves or proves an endpoint.
export const ownMovementRole = row => ownMovementDestination(normalizeLedgerText(row.description))?.role || null;

// An owner-confirmed category that is not itself a movement code is the
// owner's expense classification. It vetoes the own-movement exclusion.
const ownerConfirmedExpenseCategory = row => {
  const category = categoryFor(row);
  return category && !/^(?:(?:internal )?transfers?|loan (?:payments?|disbursements?)|credit card payments?|owners? (?:s )?(?:draw|distribution|contribution|equity)s?|savings|investments?|retirement contributions?|escrow)(?: |$)/.test(category)
    ? category : null;
};

// Only proof leaves a nominated row to the existing ownership readers: a
// resolved owned endpoint, a payment code, or an account-type review hold.
// Naming a connected account's mask or label is not proof; when no reader
// resolves that endpoint, the row is a POSSIBLE own movement like any other.
function possibleOwnAccountMovement(row, accounts, text) {
  const found = ownMovementDestination(text);
  if (!found) return null;
  // A separate structured party vetoes nomination with or without a connected
  // endpoint. Only a copied memo, a channel, or an exact owned locator has no
  // independent outside-party identity. Account-role substrings do not count.
  const payee = normalizeLedgerText(row.payee);
  const separatePayee = payee && payee !== text && !isOwnedMovementChannel(payee);
  // Matching an owned locator and proving one unique endpoint are different
  // decisions. A collision between owned labels or masks is not evidence of
  // an outside party; keep the identity unresolved instead of certifying spend.
  const ownedLocatorAccounts = locator => [...accounts.values()].filter(account =>
    resolveExactAccount(locator, new Map([[account.account_slug, account]]), true));
  const ownedPayeeAccounts = separatePayee ? ownedLocatorAccounts(payee) : [];
  if (separatePayee && !ownedPayeeAccounts.length) return null;
  const ownedDestinationAccounts = ownedLocatorAccounts(found.destination);
  const endpoint = resolveExactAccount(found.destination, accounts, true);
  if (!found.role && endpoint && endpoint.account_slug !== row.effective_account_slug) found.role = 'account';
  // A role plus an unexplained identity tail can be a supplier or an account.
  // Retain the posting and withhold spending rather than silently excluding it.
  if (!found.role || ownedPayeeAccounts.length > 1 || ownedDestinationAccounts.length > 1) {
    // Normalization drops stars. Retain a bounded decorated mask only as
    // destination ambiguity evidence, after the outside-payee veto. It cannot
    // assign an owned role, prove a pair, or subtract an outside payment.
    const decoratedText = normalizeLedgerText(String(row.description || '').replace(/(^|\s)\*{1,4}(\d{2,4})(?=\s|$)/g, '$1xxxx$2'));
    const decoratedDestination = ownMovementDestination(decoratedText)?.destination;
    const rawMaskEvidence = Boolean(decoratedDestination && ownMaskPattern.test(decoratedDestination));
    if (!ownedPayeeAccounts.length && !ownedDestinationAccounts.length && !ownDestinationRoles.some(([, pattern]) => pattern.test(found.destination)) && !ownMaskPattern.test(found.destination) && !rawMaskEvidence) return null;
    const category = ownerConfirmedExpenseCategory(row);
    return { kind: 'own_account', identityAmbiguous: true,
      ...(Math.max(ownedPayeeAccounts.length, ownedDestinationAccounts.length) > 1 ? { ownedLocatorAmbiguous: true } : {}),
      ...(category ? { categoryConflict: category } : {}) };
  }
  if (ordinaryMoneyMembership([row], [], accounts).excluded.has(row.id) || loanCardPaymentKind(row, accounts) ||
      accountKindReviewRequired(row, accounts)) return null;
  const category = ownerConfirmedExpenseCategory(row);
  if (category) return { kind: 'own_account', destination: found.role, mixed: false, categoryConflict: category };
  // A fee, charge or interest component, or two monetary amounts, mixes the
  // movement with an expense. Never parse or split its values.
  const amounts = String(row.description || '').match(/(?:[$€£]\s*\d[\d,]*(?:\.\d{2})?|\b(?:USD|EUR|GBP)\s*\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\b)/gi) || [];
  const mixed = /\b(?:fees?|charges?|interest|penalt(?:y|ies))\b/.test(text) || amounts.length > 1;
  return { kind: 'own_account', destination: found.role, mixed };
}

// Bank text can nominate an unconnected repayment or own-account movement,
// never prove its principal, charge components or ownership. One predicate
// serves every spending, ranking and cadence reader.
export function possibleUnconnectedPayment(row, accounts) {
  if (row.direction !== 'outflow' || row.amount_minor <= 0) return null;
  const text = normalizeLedgerText(row.description);
  const prefix = '(?:(?:online|automatic|mobile|internet) )?';
  const loanChannel = `${prefix}(?:(?:loan|mortgage) (?:payment|pmt|repayment|autopay)|repayment (?:of|to) (?:a )?loan|(?:payment|repayment|autopay) to (?:a )?(?:loan|mortgage))`;
  const cardChannel = `${prefix}(?:credit card payment|card payment|payment to (?:credit )?card|card autopay|cardpay)`;
  // An ACH debit code may name up to four originator words before a closed
  // repayment phrase that ends the memo (a mask, and for a loan a component
  // tail, may follow). A directed transfer may name only the liability.
  const processor = '(?:ach (?:debit |dr |pmt |withdrawal )?(?:\\S+ ){0,4}?)';
  const transferTo = liability => `${prefix}(?:transfer|xfer|trf) to ${wholeOwnDestination(liability).source.slice(1)}`;
  const loan = new RegExp(`^${loanChannel}(?: |$)|^${processor}(?:loan|mortgage) (?:payment|pmt|repayment|autopay)${ownMaskTail}${ownComponentTail}$|^${transferTo('loan|mortgage')}`).test(text);
  const card = new RegExp(`^${cardChannel}(?: |$)|^${processor}credit card (?:payment|pmt|autopay)${ownMaskTail}$|^${transferTo('credit card')}`).test(text);
  if (!loan && !card && ownMovementDestination(text)) return possibleOwnAccountMovement(row, accounts, text);
  if (!loan && !card) return null;
  // Existing review conflicts must withhold before any possible-payment
  // partition can hide their transaction from the classification guard.
  if (accountKindReviewRequired(row, accounts)) return null;
  const kind = loan ? 'loan' : 'card';
  const payee = normalizeLedgerText(row.payee);
  // A copied channel has no merchant identity. Reuse this exact grammar for
  // both text nomination and payee evidence, rather than accepting siblings
  // on one side of the decision only.
  const channelPayee = new RegExp(`^(?:${loanChannel}|${cardChannel})$`).test(payee);
  // An external structured payee vetoes a connected transfer-shaped loan
  // nomination; an unconnected lender's repayment channel remains eligible.
  if (loan && new RegExp('^' + transferTo('loan|mortgage')).test(text) &&
      payee && payee !== text && !channelPayee && !isOwnedMovementChannel(payee) &&
      namesConnectedAccount(text, row, accounts)) return null;
  // This identity-only check can reject an unconnected nomination. Clearing
  // the category cannot authorize an exclusion: the unchanged expense and
  // ownership readers still decide membership, including the accepted B2 hold.
  // Keep the whole locator and require the existing exact-account resolver.
  const directed = text.match(new RegExp(`^(?:${loanChannel}|${cardChannel}) to (.+)$`));
  const identityDescription = directed ? 'payment to ' + directed[1] : text;
  const identityRow = { ...row, category: null, description: identityDescription,
    payee: payee === text ? identityDescription : channelPayee ? 'payment' : row.payee };
  if (loanCardPaymentAccount(row, accounts) ||
      hasExplicitExpenseCategory(row) && loanCardPaymentAccount(identityRow, accounts)) return null;
  // A structured store is positive attribution. Loan-repayment words still
  // nominate a lender row, even when the bank supplies a lender name.
  if (kind === 'card' && payee && payee !== text && !channelPayee && !isOwnedMovementChannel(payee)) return null;
  // Dates, account endings and reference numbers are not monetary components.
  // Count explicit monetary notation only; never parse or split its values.
  const amounts = String(row.description || '').match(/(?:[$€£]\s*\d[\d,]*(?:\.\d{2})?|\b(?:USD|EUR|GBP)\s*\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\b)/gi) || [];
  // A directed transfer to a card that also names a component or a second
  // amount is mixed like a loan payment; payment-code card forms are unchanged.
  const cardTransfer = kind === 'card' && new RegExp(`^${transferTo('credit card')}`).test(text);
  const mixed = (kind === 'loan' || cardTransfer) && (/(?:^| )(?:fees?|interest|principal|capital|charges?)(?: |$)/.test(text) || amounts.length > 1);
  // A payment code proves membership, never a repayment/charge split.
  if (loanCardPaymentKind(row, accounts) && !mixed) return null;
  return { kind, mixed, categoryConflict: Boolean(categoryFor(row)) };
}

// A bank payment code proves membership, but only an exact owned endpoint can
// justify an ownership label or destination ending in the disclosure.
export function loanCardPaymentAccount(row, accounts) {
  // A payment code wins directly. Otherwise fees, purchases and services stay
  // expenses even when their counterparty exactly names an owned liability.
  if (hasExplicitExpenseCategory(row)) return null;
  // A known destination cannot resolve an unknown source role or a conflict.
  // An observed asset role may support an explicitly uncertain money-out view;
  // the existing summary guard still withholds its ordinary-spending total.
  const source = accounts.get(row.effective_account_slug);
  if (row.direction === 'outflow' && source &&
      (source.account_kind === 'other' && source.balance_role !== 'asset' || hasAccountKindConflict(source))) return null;
  const owned = ownedLiabilityPaymentAccount(row, accounts);
  if (owned) return owned;
  if (row.amount_minor <= 0) return null;
  const liability = account => ['card', 'loan', 'line_of_credit'].includes(account?.account_kind) ||
    account?.account_kind_review?.state === 'current' && account.balance_role === 'liability';
  const endpoint = transferEndpoints(row.description);
  const paymentLocator = normalizeLedgerText(row.description).match(
    /^(?:(?:online|automatic|mobile|internet) )?(?:(?:loan|credit card|card|mortgage) )?(?:payment|repayment|autopay) to (.+)$/)?.[1];
  // A mask or reviewed exact label identifies a liability even when a feed
  // uses a different movement verb. An outside payee vetoes description evidence.
  if (row.direction === "outflow") {
    const liabilities = [...accounts.values()].filter(account =>
      account !== accounts.get(row.effective_account_slug) &&
      liability(account) &&
      !hasAccountKindConflict(account) && !conflictsWithAccountKind(row, account) &&
      (resolvesPaymentAccount(row.payee, account, accounts) ||
        payeeSupportsOwnedCounterparty(row.payee, account, accounts) && (
          endpoint?.form === 'unary' && endpoint.direction === 'to' && resolvesPaymentAccount(endpoint.locator, account, accounts) ||
          endpoint?.form === 'bilateral' && resolvesPaymentAccount(endpoint.source, accounts.get(row.effective_account_slug), accounts) &&
            resolvesPaymentAccount(endpoint.destination, account, accounts) ||
          paymentLocator && resolvesPaymentAccount(paymentLocator, account, accounts))));
    if (liabilities.length === 1) return liabilities[0];
  }
  // The receiving liability leg is a repayment too, never income. Advances
  // travel in the other direction and keep their separate proceeds policy.
  const destination = accounts.get(row.effective_account_slug);
  if (row.direction !== 'inflow' || !liability(destination) || hasAccountKindConflict(destination)) return null;
  if (destination.account_kind === 'card' && !row.payee && normalizeLedgerText(row.description) === 'payment thank you') return destination;
  const locator = endpoint?.form === 'unary' && endpoint.direction === 'from' ? endpoint.locator
    : endpoint?.form === 'bilateral' && resolvesPaymentAccount(endpoint.destination, destination, accounts) ? endpoint.source : null;
  if (!locator) return null;
  const sources = [...accounts.values()].filter(account => ['checking', 'savings', 'card'].includes(account.account_kind) &&
    account !== destination && resolvesPaymentAccount(locator, account, accounts) &&
    !conflictsWithAccountKind(row, account) && payeeSupportsOwnedCounterparty(row.payee, account, accounts));
  return sources.length === 1 ? destination : null;
}

// A directed payment to an owned but untyped account cannot establish ordinary
// expense membership. The shared payment rule can first prove an exclusion
// using a current liability review and an exact account locator. Otherwise
// an unknown subtype or a conflicting saved deposit review still withholds
// the headline, including when the provider role alone says liability.
// No type is inferred, including from a stated kind in the payment locator.
export function accountKindReviewRequired(row, accounts) {
  if (row.direction !== 'outflow' || row.amount_minor <= 0) return false;
  const endpoint = transferEndpoints(row.description);
  if (endpoint?.form !== 'unary' || endpoint.direction !== 'to') return false;
  const source = accounts.get(row.effective_account_slug);
  const destinations = [...accounts.values()].filter(account => account !== source &&
    resolvesExactAccount(endpoint.locator, account, accounts, true));
  return destinations.length === 1 &&
    (!row.payee || isOwnedMovementChannel(row.payee) || resolvesExactAccount(row.payee, destinations[0], accounts, true)) &&
    [source, destinations[0]].some(account => account?.account_kind === 'other' || hasAccountKindConflict(account));
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

// A complete endpoint can nominate an own movement; it cannot prove that the
// money reached that account. Income/spending readers exclude and disclose the
// nomination; money out and net retain it until a reciprocal unique pair exists.
export function possibleOwnedMovement(row, accounts) {
  if (row.amount_minor <= 0) return null;
  const endpoint = transferEndpoints(row.description) || transferEndpoints(row.description, { loanAdvance: true });
  if (!endpoint) return null;
  let locator;
  if (endpoint.form === 'unary') {
    if (endpoint.direction !== (row.direction === 'outflow' ? 'to' : 'from')) return null;
    locator = endpoint.locator;
  } else {
    const posting = row.direction === 'outflow' ? endpoint.source : endpoint.destination;
    if (resolveExactAccount(posting, accounts, true) !== accounts.get(row.effective_account_slug)) return null;
    locator = row.direction === 'outflow' ? endpoint.destination : endpoint.source;
  }
  const other = resolveExactAccount(locator, accounts, true);
  // An independent outside payee vetoes an outgoing nomination. An incoming
  // bank label alone cannot establish the source of an own-looking credit.
  if (row.direction === 'outflow' && hasIndependentOutsidePayee(row, accounts)) return null;
  if (row.direction === 'outflow' && other && conflictsWithAccountKind(row, other)) return null;
  if (other && other.account_slug !== row.effective_account_slug)
    return { kind: 'own_account', destination: 'account', counterpart: other.account_slug };
  // An explicitly self-directed credit is still possible own money when the
  // provider also supplies a sender label. That label does not prove income.
  const own = /^(?:(?:my|our|your|own|unconnected|external|linked|another|other) )+(?:(?:own|unconnected) )*(?:account|acct)$/.test(locator) ||
    ownDestinationRole(locator) || ownMaskPattern.test(locator) || /^\d{1,4}(?: |$)/.test(locator);
  return own ? { kind: 'own_account', destination: ownDestinationRole(locator) || 'account' } : null;
}

// Both answer renderers share the same proof-versus-possibility decision.
export function ordinaryMoneyMembership(rows, pairs, accounts, { loanProceeds, withdrawals } = {}) {
  const excluded = new Map(), possible = new Map();
  for (const row of rows) {
    const nomination = possibleOwnedMovement(row, accounts);
    if (nomination) possible.set(row.id, nomination);
  }
  for (const pair of pairs) {
    const from = accounts.get(pair.out.effective_account_slug), to = accounts.get(pair.in.effective_account_slug);
    const directed = isDirectedOwnedTransfer(pair, accounts);
    const assetKinds = ['checking', 'savings', 'card', 'loan', 'line_of_credit', 'investment', 'retirement', 'escrow'];
    // The broader asset rule cannot infer a missing subtype or override a
    // conflicting saved role. Those postings stay possible and disclosed.
    const confirmedAssetPair = assetKinds.includes(from?.account_kind) && assetKinds.includes(to?.account_kind) &&
      !hasAccountKindConflict(from) && !hasAccountKindConflict(to);
    const advance = isLoanAdvance(pair, accounts);
    const withdrawal = directed && ['investment', 'retirement'].includes(from?.account_kind) &&
      ['checking', 'savings', 'card'].includes(to?.account_kind);
    if (advance && loanProceeds === 'include' || withdrawal && withdrawals === 'include') continue;
    // Kind changes do not erase independently proved asset movements. Expense
    // categories still veto liability repayment, and the requested inclusion
    // policies remain independent of endpoint proof.
    const conflictingLiabilityExpense = ['checking', 'savings'].includes(from?.account_kind) &&
      ['card', 'loan', 'line_of_credit'].includes(to?.account_kind) && hasExplicitExpenseCategory(pair.out);
    const movement = classifyOwnedMovement(pair, accounts) || (advance ? { kind: 'loan_proceeds' } :
      directed && confirmedAssetPair && !conflictingLiabilityExpense ? { kind: withdrawal ? 'withdrawal' : 'owned_movement' } : null);
    if (movement) for (const row of [pair.out, pair.in]) { excluded.set(row.id, movement); possible.delete(row.id); }
  }
  return { excluded, possible, ordinary: rows.filter(row => !excluded.has(row.id)) };
}

export function classifyOwnedMovement(pair, accounts) {
  if (!isDirectedOwnedTransfer(pair, accounts)) return null;
  const outKind = accounts.get(pair.out.effective_account_slug)?.account_kind;
  const inKind = accounts.get(pair.in.effective_account_slug)?.account_kind;
  if (["checking", "savings"].includes(outKind) && ["card", "loan", "line_of_credit"].includes(inKind)) {
    // Reciprocal account identity cannot turn an explicitly categorized fee
    // or purchase into principal repayment.
    if (hasExplicitExpenseCategory(pair.out)) return null;
    return { kind: "owned_liability_payment", liabilityKind: inKind === "card" ? "card" : "loan" };
  }
  if (["checking", "savings", "card"].includes(outKind) && ["checking", "savings", "card"].includes(inKind)) {
    return { kind: "own_transfer" };
  }
  return null;
}
export function pairOwnTransfers(rows, accounts = new Map(), { directedEvidence = false } = {}) {
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
    // Generic channel payees can be accepted for the money-in breakdown only
    // after both directed endpoints prove ownership and reject outside payees.
    // The existing advisory/outflow path keeps its original admission rule.
    if (outsidePayee(out, inAccount) && outsidePayee(incoming, outAccount) &&
        !(directedEvidence && isDirectedOwnedTransfer({ out, in: incoming }, accounts))) continue;
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

// Partition before cadence detection: a proved movement cannot seed either
// charge list, and text-only account identity never proves an external payee.
export function recurringReading(rows, to, accounts, provedRows = new Set(), possibleRows = new Set()) {
  const proved = row => provedRows.has(row.id) ||
    /^(?:TRANSFER_(?:IN|OUT)(?:_|$)|LOAN_PAYMENTS(?:_|$))/i.test(row.category || '');
  const available = rows.filter(row => !proved(row));
  const unresolved = available.filter(row => possibleRows.has(row.id) || isOwnedMovement(row, accounts));
  const unresolvedIds = new Set(unresolved.map(row => row.id));
  // Detect the full series before partitioning. Splitting its postings first
  // could erase a three-charge pattern when only one memo names an account.
  const groups = detectRecurring(available, to);
  const uncertain = group => group.rows.some(row => unresolvedIds.has(row.id));
  // Separate series can share one recorded payee. When their combined dates
  // or prices fail cadence detection, neither membership partition may erase
  // a pattern in the other. Rows in a whole-series reading stay disjoint.
  const coveredIds = new Set(groups.flatMap(group => group.rows.map(row => row.id)));
  const remaining = available.filter(row => !coveredIds.has(row.id));
  return {
    confirmed: [...groups.filter(group => !uncertain(group)),
      ...detectRecurring(remaining.filter(row => !unresolvedIds.has(row.id)), to)],
    setAside: [...groups.filter(uncertain),
      ...detectRecurring(remaining.filter(row => unresolvedIds.has(row.id)), to)],
    unresolved,
  };
}

// Text-only identity is advisory: exclude it from charge membership but keep
// every unresolved posting visible. Only a proved counterpart resolves it.
const ownedAccountNouns = {
  checking: 'checking|deposit(?: account)?',
  savings: 'savings|deposit(?: account)?|money market',
  card: '(?:credit )?card|liability(?: account)?',
  loan: 'loan|mortgage|installment(?: account)?|liability(?: account)?',
  line_of_credit: 'line of credit|credit line|liability(?: account)?',
};
export function isOwnedMovement(row, accounts, provedRows = new Set()) {
  if (provedRows.has(row.id)) return true;
  // Receipts are not charge candidates. Keep proved counterpart identity above,
  // but never turn a customer deposit into an unresolved outgoing movement.
  if (row.direction === "inflow") return false;
  const inventory = [...accounts.values()];
  // Separate fields and clauses before assigning roles. Service identity must
  // not erase an account target elsewhere in the memo or payee.
  const clauses = [row.description, row.payee].flatMap(value => String(value || '').split(/[;|]/))
    .map(text => normalizeLedgerText(text.replace(/[*\u2022]+(?=\s*\d)/g, 'x')));
  return clauses.some(text => {
    // Explicit kind-aware locators resolve before invoice/service exceptions.
    // Any remaining owned mask is checked by the fail-closed guard below.
    const references = [...text.matchAll(new RegExp('\\b(?:(' + Object.values(ownedAccountNouns).join('|') + ') (?:account |acct )?|(?:account|acct|ending|payment|pay|pmt|transfer|xfer) (?:to |from |in )?|(?=x{1,4}\\d))(?:number |no )?(?:ending (?:in )?)?(?:x{1,4})?(\\d{1,4})(?![\\p{L}\\p{N}])', 'gu'))];
    if (references.some(([, noun, mask]) => inventory.some(account =>
      (!noun || new RegExp('^(?:' + (ownedAccountNouns[account.account_kind] || '(?!)') + ')$').test(noun)) &&
      (account.members || [account]).some(member => member.mask === mask)))) return true;
    const payee = normalizeLedgerText(row.payee || '');
    const allNouns = Object.values(ownedAccountNouns).join('|');
    const externalPayee = payee && !new RegExp('\\b(?:' + allNouns + ')\\b').test(payee) &&
      !inventory.some(account => (account.members || [account]).some(member => member.mask && payee.includes(member.mask)));
    // A bare owned mask is still account identity. Only an invoice/reference
    // role together with an external payee can establish a coincidental number.
    const masks = new Set(inventory.flatMap(account => (account.members || [account]).map(member => member.mask)));
    const numbers = [...text.matchAll(/(?<![\p{L}\p{N}])(?:x{1,4})?(\d{1,4})(?![\p{L}\p{N}])/gu)];
    if (numbers.some(match => masks.has(match[1]) && !(externalPayee &&
      /\b(?:invoice|reference|ref)(?: number| no)? $/.test(text.slice(0, match.index))))) return true;
    return inventory.some(account => {
      const noun = ownedAccountNouns[account.account_kind];
      if (!noun) return false;
      // A separate external payee plus an explicit service subject establishes
      // charge identity. Remove only that subject, never other account targets
      // in the same memo. Locators have already failed closed above.
      const targetText = externalPayee ? text.replace(new RegExp('\\b(?:' + noun + ')\\s+(?:(?!(?:account|acct|payment|repayment|transfer|pay|pmt|autopay)\\b)[a-z]+\\s+)+(?:subscription|membership)\\b', 'g'), '') : text;
      // Account identity is enough: unfamiliar action words and possessives
      // must not turn an unresolved owned target into a recurring charge.
      return new RegExp('\\b(?:' + noun + ')\\b').test(targetText);
    });
  });
}
