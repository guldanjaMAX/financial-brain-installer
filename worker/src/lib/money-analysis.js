// The assistant money tools keep the candidate classification rules. Human
// asks use ledger-analysis.js at the shipped reader boundary; do not couple
// their counting to changes in the clean SQL snapshot.
import { vendorAliasesFor } from "./vendor-aliases.js";
import { platformIdentity, payoutAnnotation, platformTransaction, platformCategory, accountProcessor } from './money-platform.js';
export { platformIdentity, accountProcessor } from './money-platform.js';

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

export function resolvesExactAccount(locator, other, accounts, allowUnknownKind = false, allowLabel = true) {
  return Boolean(other) && resolveExactAccount(locator, accounts, allowUnknownKind, allowLabel) === other;
}

// Exact stored labels can identify an owner-reviewed liability, including a
// linked member with no mask. Provider labels alone do not establish review.
// Expense categories are checked separately before identity can exclude money.
const resolvesPaymentAccount = (locator, account, accounts) =>
  resolvesExactAccount(locator, account, accounts, false,
    [account, ...(account?.members || [])].some(member =>
      member?.account_kind_review?.state === 'current' && member.balance_role === 'liability'));

export const EXPENSE_CATEGORY_WORDS = Object.freeze(['fee','fees','interest','purchase','purchases','merchandise','service','services',
  'food','drink','entertainment','home improvement','medical','personal care','government','transportation','travel','rent','utilities']);
const expenseCategoryPattern = new RegExp('\\b(?:' + EXPENSE_CATEGORY_WORDS.join('|') + ')\\b');
export const hasExplicitExpenseCategory = row => expenseCategoryPattern.test(platformCategory(row));

export function transferEndpoints(description, { loanAdvance = false } = {}) {
  const text = normalizeLedgerText(description);
  const channel = "(?:(?:online|automatic|mobile|internet) )?";
  const transfer = `${channel}transfer`;
  const movement = loanAdvance
    ? `(?:${transfer}|(?:(?:loan|credit|line of credit) )?(?:advance|disbursements?|proceeds))`
    : transfer;
  const bilateral = text.match(new RegExp(`^${movement} from (.+?) to (.+)$`));
  if (bilateral) return { form: "bilateral", source: bilateral[1], destination: bilateral[2] };
  const verb = loanAdvance
    ? movement
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
  return classifyMoneyMovement(row, accounts) === 'card_or_loan_payment' && account
    ? account.account_kind === "card" ? "card" : "loan" : null;
}

// A bank payment code nominates a repayment type, never an owned destination.
// Outgoing repayment exclusions require an exact owned liability or a proved
// pair. Interest, fees and purchases remain spending in every reader.
export const PAYMENT_CATEGORY_PREFIXES = Object.freeze(['loan payment', 'loan payments', 'credit card payment', 'credit card payments']);
function bankRepaymentKind(row) {
  const category = normalizeLedgerText(row.category);
  return PAYMENT_CATEGORY_PREFIXES.some(prefix => category === prefix || category.startsWith(prefix + ' '))
    ? /\bcredit card\b/.test(category) ? "card" : "loan" : null;
}
function repaymentKind(row, accounts) {
  if (hasExplicitExpenseCategory(row)) return null;
  const bankKind = bankRepaymentKind(row);
  if (bankKind && row.direction !== 'outflow') return bankKind;
  const account = accounts.has(row.effective_account_slug) ? loanCardPaymentAccount(row, accounts) : null;
  return account ? account.account_kind === 'card' ? 'card' : 'loan' : null;
}

// Missing ownership confirmation cannot turn a known liability into an asset.
// The fallback describes the posting account; it grants no endpoint authority.
const postingAccountKind = (row, accounts) => accounts.get(row.effective_account_slug)?.account_kind ?? row.account_kind;

// One closed-evidence decision for SQL and product readers. A lender identity
// alone cannot prove repayment: banks also pay bonuses, interest and cashback.
// Unknown rows stay counted and carry an estimate flag in the clean view.
export function classifyMoneyMovement(row, accounts, approvedMovements = []) {
  if (row.direction === 'outflow' && hasExplicitExpenseCategory(row)) return 'spending';
  const pair = approvedMovements.find(p => p.out?.id === row.id || p.in?.id === row.id);
  if (pair) {
    const movement = classifyOwnedMovement(pair, accounts);
    if (movement?.kind === 'owned_liability_payment') return 'card_or_loan_payment';
    if (movement) return 'own_transfer';
    // Internal bank-category proof from the bounded clean snapshot, never memo text.
    if (pair.proved === true) return ['card','loan','line_of_credit'].includes(accounts.get(pair.in.effective_account_slug)?.account_kind)
      ? 'card_or_loan_payment' : 'own_transfer';
  }
  const text = normalizeLedgerText((row.description || '') + ' ' + (row.category || ''));
  if (row.direction === 'inflow' && /\b(?:refunds?|refunded|reversals?)\b/.test(text)) return 'refund';
  if (repaymentKind(row, accounts)) return 'card_or_loan_payment';
  const endpoint = possibleOwnedMovement(row, accounts);
  if (accounts.has(row.effective_account_slug) && endpoint?.counterpart && !hasIndependentOutsidePayee(row, accounts)) return 'own_transfer';
  // Even an earnings label on a liability credit describes a debt adjustment,
  // not received income. Keep its uncertain meaning visible and separate.
  if (row.direction === 'inflow' && !['card','loan','line_of_credit'].includes(postingAccountKind(row, accounts)) && /\b(?:income|bonus|interest|cashback|client|customer|revenue|sales|payroll)\b/.test(text)) return 'income';
  return 'unknown';
}

// Compatibility counting for uncertain rows is explicit and shared too. These
// are estimates, not closed repayment proof; the row and its gross amount stay
// available, and estimated=1 tells the answer to qualify the total.
const liabilityKinds = ['card', 'loan', 'line_of_credit'];
const debtKinds = ['loan', 'line_of_credit'];
const proceedsCategory = /^(?:loan disbursements?|line of credit advance|transfer in cash advances and loans)(?: |$)/;
const returnedMoney = /\b(?:refunds?|refunded|reversals?|reversed|chargebacks?|dispute (?:credit|won)|provisional credit|(?:purchase|merchandise) returns?|returned purchases?|return credit)\b/;

// A separately posted payment fee is spending even on an uncategorized feed.
// Do not split a combined principal/interest posting based on memo amounts.
export const PAYMENT_EXPENSE_DESCRIPTIONS = Object.freeze(['','credit card ','card ','loan ','mortgage '].flatMap(prefix =>
  ['fee','fees','interest'].flatMap(component => [prefix+'payment '+component,prefix+'payment '+component+' charge'])));
export const separatePaymentExpense = row => row.direction === 'outflow' &&
  PAYMENT_EXPENSE_DESCRIPTIONS.includes(normalizeLedgerText(row.description));

// Processor identity is a whole recorded label or a bounded payout descriptor.
// Sharing this rule avoids promoting refund/recovery credits merely because
// their payee is also a processor.
export const moneyProcessor = platformIdentity;

export function moneyMovementReading(row, accounts, approvedMovements = [], options = {}) {
  if (options.clean) return cleanMoneyMovementReading(row, accounts, approvedMovements, options);
  let classification = classifyMoneyMovement(row, accounts, approvedMovements);
  const pair = approvedMovements.find(p => p.out?.id === row.id || p.in?.id === row.id);
  const source = accounts.get(row.effective_account_slug) || {account_kind:postingAccountKind(row, accounts)};
  let uncertain_kind = classification === 'unknown' && row.direction === 'inflow' && liabilityKinds.includes(source.account_kind)
    ? source.account_kind === 'card' ? 'card_payment' : 'loan_payment' : null;
  const text = normalizeLedgerText(row.description), category = normalizeLedgerText(row.category);
  const evidenceText = normalizeLedgerText(`${row.description || ''} ${row.category || ''} ${row.payee || ''}`);
  if (separatePaymentExpense(row)) classification = 'spending';
  const read = (money_kind, estimate_reason = null) => ({classification,money_kind,
    estimated:classification === 'unknown' || Boolean(estimate_reason),paymentKind:null,uncertain_kind,
    estimate_reason:estimate_reason || (classification === 'unknown' ? 'unresolved_membership' : null)});
  // Liability credits can reduce debt, but can never earn income. Rewards have
  // their own bucket so they do not inflate the amount paid toward the card.
  if (row.direction === 'inflow' && liabilityKinds.includes(source?.account_kind) &&
      (classification === 'income' || /\b(?:rewards?|cashback|bonus)\b/.test(evidenceText))) return read('liability_credit');
  const other = pair ? (pair.out.id === row.id ? pair.in : pair.out).effective_account_slug
    : possibleOwnedMovement(row, accounts)?.counterpart;
  const [from, to] = row.direction === 'outflow'
    ? [source?.account_kind, accounts.get(other)?.account_kind]
    : [accounts.get(other)?.account_kind, source?.account_kind];
  const proceedsLeg = row.direction === 'inflow' ? ['checking','savings'].includes(source?.account_kind)
    : debtKinds.includes(source?.account_kind) && !hasIndependentOutsidePayee(row, accounts);
  if (classification === 'own_transfer' && debtKinds.includes(from) && ['checking','savings','card'].includes(to) ||
      proceedsLeg && (row.category_basis_state === 'confirmed' || row.provenance === 'feed') &&
      proceedsCategory.test(category) && !hasExplicitExpenseCategory(row) &&
      !/\b(?:client|customer|invoice|refund|income|revenue|sales)\b/.test(evidenceText)) return read('loan_proceeds');
  const payoutAdjustment = row.direction === 'inflow' && moneyProcessor(row) &&
    /^(?:stripe|square|paypal|shopify) payout (?:sales|gross sales)\b/.test(text) &&
    /^(?:gross )?sales$/.test(category);
  if (payoutAdjustment && classification === 'refund') classification = 'income';
  // Refunds remain separate contributions: callers explicitly subtract them
  // when asking for net spending. Fees on a chargeback remain expenses.
  if (!payoutAdjustment && (row.direction === 'inflow' && returnedMoney.test(evidenceText) ||
      row.direction === 'outflow' && !hasExplicitExpenseCategory(row) &&
      /\b(?:customer refunds?|client refunds?|refunds? to (?:customer|client)|chargebacks?|payout reversal)\b/.test(evidenceText))) {
    classification = 'refund';
    return read('refund');
  }
  let paymentKind = classification === 'card_or_loan_payment'
    ? pair ? accounts.get(pair.in.effective_account_slug)?.account_kind === 'card' ? 'card' : 'loan' : repaymentKind(row, accounts) : null;
  if (classification === 'unknown') {
    if (row.direction === 'inflow' && ['card','loan','line_of_credit'].includes(source?.account_kind))
      paymentKind = source.account_kind === 'card' ? 'card' : 'loan';
    const text = normalizeLedgerText(row.description), payee = normalizeLedgerText(row.payee);
    const channel = /^(?:(?:online|automatic|mobile|internet) )?(credit card payment|card payment|payment to (?:credit )?card|card autopay|cardpay|(?:loan|mortgage) (?:payment|pmt|repayment|autopay)|(?:repayment|payment|autopay) (?:of|to) (?:a )?(?:loan|mortgage))(?: |$)/.exec(text);
    const bankKind = bankRepaymentKind(row);
    if ((channel || bankKind) && !hasExplicitExpenseCategory(row) && !separatePaymentExpense(row)) {
      const kind = bankKind || (/card/.test(channel[1]) ? 'card' : 'loan');
      const lender = [...accounts.values()].some(a => (kind === 'card' ? a.account_kind === 'card' : ['loan','line_of_credit'].includes(a.account_kind)) &&
        payee && [a.label,a.institution].some(v => normalizeLedgerText(v) === payee));
      if (bankKind || !payee || payee === text || isOwnedMovementChannel(payee) || lender || kind === 'loan' && row.direction === 'outflow') {
        uncertain_kind = kind + '_payment';
        // Nomination cannot erase an outgoing posting. Only the classifier's
        // exact owned endpoint or proved pair above can exclude it.
        if (row.direction === 'inflow') paymentKind = kind;
      }
    }
  }
  const money_kind = paymentKind ? paymentKind + '_payment' : ['own_transfer','refund'].includes(classification) ? classification : 'ordinary';
  const possibleProceeds = money_kind === 'ordinary' && row.direction === 'inflow' &&
    /\b(?:loan|credit line|line of credit|loc) (?:proceeds|disbursements?|advances?|draw)\b/.test(text);
  return {...read(money_kind,possibleProceeds ? 'possible_loan_proceeds_counted' : null),paymentKind};
}

const cleanPaymentChannel = /^(?:(?:online|automatic|mobile|internet) )?(credit card payment|card payment|payment to (?:credit )?card|card autopay|cardpay|(?:loan|mortgage) (?:payment|pmt|repayment|autopay)|(?:repayment|payment|autopay) (?:of|to) (?:a )?(?:loan|mortgage))(?: |$)/;
export const cleanFee = row => row.direction === 'outflow' && !/\bcharge card\b/.test(normalizeLedgerText(row.description)) &&
  /\b(?:fees?|(?:service|monthly|maintenance|overdraft|nsf|returned item|wire|late|finance|annual|interest|bank|account) charges?)\b/.test(normalizeLedgerText(row.description));
const mixedFeeMovement = row => /\b(?:payments?|pymt|pmt|epay|e pay|crcardpmt|autopay|payoff|transfer|xfer|xfr)\b/.test(normalizeLedgerText(row.description));
export const unresolvedMovementFee = row => cleanFee(row) && mixedFeeMovement(row) &&
  !/^(?:(?:balance|wire|bank|international) transfer|(?:late|returned|card|loan) payment) fees?$/.test(normalizeLedgerText(row.description)) && !separatePaymentExpense(row) && !hasExplicitExpenseCategory(row);
export const trustedCode = row => row.category_basis_state === 'confirmed' || row.provenance === 'feed';

// The feed stores COALESCE(category_detailed,category_primary) as category.
// Prefer that typed evidence to memo grammar; proposed imports can only flag.
export const moneyEvidenceCategory = row => normalizeLedgerText(row.category_detailed || row.category_primary || row.category);
const processorAdvance = /\b(?:stripe|square|sq|paypal|shopify)\b.*\b(?:capital|loans?|lending|advance|financing)\b|\b(?:capital|loans?|lending|advance|financing)\b.*\b(?:stripe|square|sq|paypal|shopify)\b/;
const ownerMoney = /\b(?:owners?|shareholders?|founders?) (?:s )?(?:loan|investment|injection|infusion|funding|funds|money|deposit|capital|equity|contrib(?:ution)?s?)\b|\b(?:members?|partners?) (?:s )?(?:loan|investment|injection|infusion|capital|equity|contributions?)\b|\b(?:capital|equity) (?:injection|infusion|investment|call)\b|\b(?:deposit|funds|loan|investment|contribution) from (?:the )?(?:owners?|shareholder|founder|member|partner)\b|\bpaid in capital\b/;
const borrowingText = /\b(?:loans?|lending|lenders?|eidl|ppp|sba|sbad|heloc|financing|factoring|merchant cash advance|mca|working capital|line of credit|credit line)\b|\b(?:business|capital) (?:funding|advance)\b/;
const rewardsRedemption = /\b(?:rewards?|points|miles|cash back|cashback)(?: bonus)? (?:redemption|redeemed|redeem|deposit|credit|payout)\b|\bredemption (?:credit|deposit)\b|\b(?:credit card|card|cardmember|cardholder) (?:rewards?|cash back|cashback|bonus)\b/;
// Open-world deposits that are not earned income. Each only flags: the dollars
// stay counted (founder option (b)) and the answer drops below High.
const rewardsCredit = /\b(?:rewards?|cash back|cashback)$/;
const taxRefundText = /(?<!sales )\btax (?:refunds?|ref|rfd)\b|\b(?:state|fed|federal) (?:tax )?(?:refunds?|ref|rfd)\b/;
const taxAuthority = /\b(?:franchise tax board|ftb|dept of revenue|department of revenue|department of taxation|tax commission|state treasurer)\b/;
const lenderDrawText = /\b(?:draws?|drawdown|funding|funded)\b/;
const investmentMoveText = /\b(?:brokerage|moneylink|ira|401k|roth|retirement)\b|\b(?:sell|sale of|redeem|redemption of) (?:investments?|securities|shares|stocks?|funds?)\b|\binvest(?:ment)? (?:account|acct|transfer|withdrawal|sweep)\b/;
const cashOutText = /\bcash ?out\b/;
export function incomeContraryEvidence(row, legacy, options = {}) {
  if (row.direction !== 'inflow') return null;
  const text=normalizeLedgerText(row.description),payee=normalizeLedgerText(row.payee),category=moneyEvidenceCategory(row);
  if (processorAdvance.test(text+' '+payee)) return 'possible_processor_advance_counted';
  if (ownerMoney.test(text) || /^(?:owner|capital|shareholder|member|partner) contributions?$/.test(category) || /^owners?$/.test(payee)) return 'possible_owner_money_counted';
  if (borrowingText.test(text) && (row.payee || legacy.classification==='income') || proceedsCategory.test(category) ||
      /\b(?:loans?|lending|lenders?|financing|factoring)\b/.test(payee) && legacy.classification!=='income') return 'possible_loan_proceeds_counted';
  if (rewardsRedemption.test(text)) return 'possible_rewards_redemption_counted';
  // A trusted bank income category outranks these memo forms (classifier
  // control C4); a bank "tax refund" category never does.
  const incomeCode=trustedCode(row) && /\bincome\b/.test(category) && !/\btax refunds?\b/.test(category);
  if (/\btax refunds?\b/.test(category) || !incomeCode && (taxRefundText.test(text) || taxAuthority.test(text+' '+payee))) return 'possible_tax_refund_counted';
  if (!incomeCode && rewardsCredit.test(text)) return 'possible_rewards_redemption_counted';
  if (!incomeCode && lenderDrawText.test(text)) return 'possible_loan_proceeds_counted';
  if (!incomeCode && (investmentMoveText.test(text) || cashOutText.test(text))) return 'possible_own_transfer_counted';
  // Income keywords (sales, customer, client ...) do not prove income: a
  // vendor's SALES RETURN or CUSTOMER CREDIT is money back on a purchase.
  const flow=payee && !isOwnedMovementChannel(payee) && !moneyProcessor(row)
    ? options.payeeFlow?.get(JSON.stringify([row.currency,normalizeMerchantText(row.payee)])) : null;
  return flow && flow.out_minor>0 && flow.out_minor>=flow.in_minor ? 'possible_vendor_credit_counted' : null;
}

const debtNoun='(?:loans?|mortgage|mtg|heloc|line of credit|credit line|sba|eidl|lending|lender)';
const payVerb='(?:payments?|pmt|pymt|pymnt|paymt|repayment|repmt|e payment|epayment|autopay|auto pay|payoff)';
const debtVeto=/(?:^| )(?:escrow|insurance|ins|tax|taxes|premium|fees?|penalty|penalties|charges?|refunds?|reversal|reversed|returned|proceeds|disbursements?|advance|draw|merchant|processing)(?: |$)/;
const nearDebt=noun=>new RegExp(`(?:^| )${noun}(?: \\S+){0,3} ${payVerb}(?: |$)|(?:^| )${payVerb} (?:to|for|on) (?:\\S+ ){0,2}${noun}(?: |$)`);
const loanWording=nearDebt(debtNoun),cardWording=nearDebt('(?:credit card|credit crd|cardmember|card member)');
export function debtPaymentWordingKind(text, payee='') {
  if (!text || debtVeto.test(text)) return null;
  if (/\b(?:interest|int)\b/.test(text) && !/\b(?:principal|princ|prin|prncpl)\b/.test(text)) return null;
  if (cardWording.test(text)) return 'card';
  // These payment-rail descriptors nominate only. In particular they cannot
  // remove a utility payment or prove which issuer received the money.
  if (/\b(?:epayment|e payment)\b|\bmobile pmt(?: \d+)?$|\bcreditcard$/.test(text)) return 'card';
  if (loanWording.test(text) || new RegExp(`(?:^| )note ${payVerb}(?: |$)`).test(text) ||
      /\bprincipal(?: only)? (?:payment|pmt)\b/.test(text) && /\b(?:lender|lending|loan|mortgage|finance)\b/.test(payee)) return 'loan';
  return null;
}

export const LEGACY_PAYMENT_REVERSAL = /\b(?:returned (?:payment|item) (?:card|loan)|returned payment|payment returned|(?:card|loan|mortgage) (?:payment|pmt) (?:reversal|reversed|returned))\b/;
const returnLead='(?:(?:nsf|non sufficient funds) )?';
const returnReason='(?: (?:due to |for )?(?:nsf|non sufficient funds|insufficient funds|uncollected funds|unpaid|account closed|stop payment|refer to maker))?';
const returnRef='(?: (?:check|ck|item|ref|reference|trace|id|conf|confirmation)(?: (?:no|number))?)?(?: \\d{1,15}){0,3}';
const returnTail=`(?:${returnReason}${returnRef}|${returnRef}${returnReason})`;
const liabilityWord='(?:credit card|card|loan|mortgage|auto loan|line of credit)';
const paymentWord='(?:(?:(?:online|mobile|automatic|auto|ach|electronic|e) )?(?:payment|pymt|pmt)|autopay|auto pay)';
const returnVerb='(?:returned|return|reversal|reversed|dishonored|bounced|nsf|unpaid|insufficient funds|non sufficient funds)';
const returnMask='(?: (?:ending (?:in )?)?x{0,4}\\d{4})?';
const returnGrammar=body=>new RegExp(`^${returnLead}(?:${body})${returnTail}$`);
const paymentReturn=returnGrammar(`(?:${liabilityWord} )?${paymentWord}(?: thank you)? ${returnVerb}(?: (?:to |from )?${liabilityWord})?${returnMask}|${returnVerb} (?:of )?(?:${liabilityWord} )?${paymentWord}(?: thank you)?(?: (?:to |from )?${liabilityWord})?${returnMask}|returned check payment`);
const depositReturn=returnGrammar('(?:deposited|deposit) (?:item|items|check|cheque) (?:returned|return|chargeback|charged back)|(?:returned|return) (?:of )?(?:deposited|deposit) (?:item|items|check|cheque)|(?:returned|return) item chargeback|chargeback (?:of )?(?:deposited|returned) (?:item|check|cheque)');
const possibleDepositReturn=returnGrammar('ach reversal|ach (?:credit|deposit) (?:reversal|reversed|return|returned)(?: .+)?|ach (?:return|returned)(?: .+)?|(?:reversal|return|returned) (?:of )?ach (?:credit|deposit)(?: .+)?|(?:customer |client )?(?:payment|deposit|mobile deposit|remote deposit|check deposit) (?:reversal|reversed|returned|return)|(?:reversal|return|returned) (?:of )?(?:customer |client )?(?:payment|deposit|mobile deposit)');
const feeLikeReturn=returnGrammar('(?:returned|return) (?:item|check|cheque)|(?:item|check|cheque) (?:returned|return)');
const outgoingReturn=returnGrammar('(?:returned|return|bounced|dishonored) (?:check|cheque|ck|ach debit|ach withdrawal|debit|withdrawal|bill payment|bill pay)|(?:check|cheque|ach debit|bill payment|bill pay) (?:returned|return|bounced|dishonored)');
const transferReturn=returnGrammar(`transfer ${returnVerb}|${returnVerb} (?:of )?transfer`);
export function reversalForm(row, liability) {
  const text=normalizeLedgerText(row.description);
  if (cleanFee(row) || separatePaymentExpense(row) || row.direction==='outflow' && hasExplicitExpenseCategory(row)) return null;
  if (LEGACY_PAYMENT_REVERSAL.test(text)) return null;
  if (!liability && transferReturn.test(text))return {kind:'transfer'};
  if ((liability && row.direction==='outflow' || !liability && row.direction==='inflow') && (paymentReturn.test(text) ||
      /^returned item (?:[a-z0-9]+ )*(?:credit card|credit crd|card|loan) (?:autopay|payment|pmt|pymt)$/.test(text)))
    return {kind:'payment',refund_today:!liability && /\b(?:reversals?|reversed)\b/.test(text)};
  if (!liability && row.direction==='outflow') {
    if (depositReturn.test(text)) return {kind:'deposit_a'};
    if (possibleDepositReturn.test(text)) return {kind:'deposit_b',fee_like:false};
    if (feeLikeReturn.test(text)) return {kind:'deposit_b',fee_like:true};
  }
  if (!liability && row.direction==='inflow' && outgoingReturn.test(text)) return {kind:'returned_out'};
  return null;
}

// Bank locator adornments are syntax only when the entire suffix is a reference
// code. Never strip arbitrary party names or let a matching amount prove identity.
export function cleanBankMemo(description) {
  return normalizeLedgerText(description).replace(/ (?:ref|reference|confirmation|conf|transaction|trn|id)(?: number| no)? \d+$/, '')
    .replace(/^(online|mobile|internet) banking /,'$1 ')
    .replace(/\bchk\b/g, 'checking').replace(/\bsav\b/g, 'savings');
}
export function cleanPairEvidence(pair, accounts) {
  const out = accounts.get(pair.out.effective_account_slug), into = accounts.get(pair.in.effective_account_slug);
  if (!out || !into || out === into || pair.out.basis_state !== 'confirmed' || pair.in.basis_state !== 'confirmed' ||
      [pair.out,pair.in].some(r => hasExplicitExpenseCategory(r) || cleanFee(r) || hasIndependentOutsidePayee(r,accounts) ||
        /\b(?:customer|client|invoice|refund|refunded|reversal|reversed|reimbursement|chargeback|income|revenue|sale|sales|reward|cashback|bonus)\b/.test(normalizeLedgerText(`${r.description || ''} ${r.category || ''}`)))) return null;
  const clean = {...pair,out:{...pair.out,description:cleanBankMemo(pair.out.description)},in:{...pair.in,description:cleanBankMemo(pair.in.description)}};
  if (isDirectedOwnedTransfer(clean,accounts) || isDirectedOwnedTransfer(clean,accounts,{loanAdvance:true})) return 'reciprocal_bank_locators';
  if(['loan','line_of_credit'].includes(into.account_kind) && ['checking','savings'].includes(out.account_kind) &&
      /^payment(?: received| thank you)?$/.test(normalizeLedgerText(clean.in.description)) && loanCardPaymentAccount(clean.out,accounts)===into)
    return 'directed_repayment_acknowledgement';
  return null;
}

function cleanMoneyMovementReading(row, accounts, pairs, options) {
  // The provider's detailed category outranks its primary one for every reader below.
  if(row.category_detailed || row.category_primary)row={...row,category:row.category_detailed || row.category_primary};
  const annotation = payoutAnnotation(row, accounts);
  const reading = cleanMoneyMovementReadingBase(annotation ? {...row,description:annotation.description} : row, accounts, pairs, options);
  const type = platformTransaction(row, accounts);
  const source = accounts.get(row.effective_account_slug);
  // A return word inside an invoice subject, or explicitly negated by the
  // memo, cannot certify a refund. Retain the cash reading until the source
  // record resolves the transaction type; neither wording proves a new type.
  const text = normalizeLedgerText(row.description), category = moneyEvidenceCategory(row);
  if (row.direction==='inflow' && returnedMoney.test(text+' '+category) &&
      /\b(?:not|never)(?: an?| the)? (?:purchase |merchant )?(?:refund|refunded|reversal|chargeback|reimbursement)\b|\b(?:no|without) (?:purchase |merchant )?(?:refund|reversal|chargeback|reimbursement)\b/.test(text))
    return {...reading,estimated:true,estimate_reason:'return_type_negated_counted'};
  if (row.direction==='inflow' && !liabilityKinds.includes(source?.account_kind) && reading.money_kind==='refund' &&
      (/\b(?:invoice (?:for|payment)|payment for)\b/.test(text) || trustedCode(row) && /^(?:income|sales|revenue)(?: |$)/.test(category)))
    return {...reading,estimated:true,estimate_reason:'return_type_conflicts_with_receipt_counted'};
  // Fees and purchases outrank guessed transaction words. Mixed fee/principal
  // memos remain counted, but cannot be certified as a plain expense.
  if (row.direction==='outflow' && /\b(?:refund|chargeback|dispute)\b/.test(normalizeLedgerText(row.description)) &&
      /\b(?:incl|including|plus)\b.*\bfee\b/.test(normalizeLedgerText(row.description)) && !hasExplicitExpenseCategory(row))
    return {...reading,estimated:true,estimate_reason:'processor_return_with_fee_unsplit_counted'};
  if (type && !hasExplicitExpenseCategory(row) && !cleanFee(row) &&
      ['ordinary','refund'].includes(reading.money_kind)) {
    if (type.type==='return') return {classification:'refund',money_kind:'refund',estimated:!type.confirmed,
      estimate_reason:type.confirmed?null:'processor_return_debit_unconfirmed',uncertain_kind:null,paymentKind:null};
    if (type.type==='recovery') return {classification:'refund',money_kind:'refund',estimated:!type.confirmed,
      estimate_reason:type.confirmed?null:'processor_return_recovery_unconfirmed',uncertain_kind:null,paymentKind:null};
    if (type.type==='reserve') return {classification:'unknown',money_kind:'processor_reserve',estimated:true,
      estimate_reason:'processor_reserve_held',uncertain_kind:null,paymentKind:null};
    if (type.type==='reserve_release') return {...reading,classification:'unknown',
      money_kind:['merchant','point_of_sale'].includes(source?.account_kind)?'processor_reserve':'ordinary',estimated:true,
      estimate_reason:['merchant','point_of_sale'].includes(source?.account_kind)?'processor_reserve_returned':'processor_reserve_release_counted'};
  }
  // Ordinary net receipts count at face value. Processor identity does not
  // prove gross sales or withheld components; the query assessment names
  // those separate missing records without doubting every ordinary payout.
  return reading;
}

function cleanMoneyMovementReadingBase(row, accounts, pairs, options) {
  if(row.category_detailed || row.category_primary)row={...row,category:row.category_detailed || row.category_primary};
  const text = normalizeLedgerText(row.description), category = moneyEvidenceCategory(row);
  const source = accounts.get(row.effective_account_slug) || {account_kind:postingAccountKind(row, accounts)};
  const liability = liabilityKinds.includes(source.account_kind);
  const pair = pairs.find(p => p.out.id === row.id || p.in.id === row.id);
  const candidate = options.candidateIds?.has(row.id);
  const nomination = moneyMovementReading(row, accounts, pairs).uncertain_kind;
  const read = (classification,money_kind,reason=null) => ({classification,money_kind,estimated:Boolean(reason),paymentKind:
    money_kind === 'card_payment' ? 'card' : money_kind === 'loan_payment' ? 'loan' : null,estimate_reason:reason,
    uncertain_kind: classification === 'unknown' ? nomination || (/card|loan|liability/.test(reason || '')
      ? /card/.test(reason || '') || source.account_kind === 'card' ? 'card_payment' : 'loan_payment' : null) : null});
  if (!pair && row.direction==='inflow' && ['checking','savings'].includes(source.account_kind) && bankRepaymentKind({...row,category:platformCategory(row)})) {
    if (/\b(?:bankcard|card|mobile|atm|direct) (?:deposit|dep)\b/.test(text))
      return read('unknown','ordinary','payment_category_on_bank_deposit_counted');
    const legacy = moneyMovementReading(row,accounts,pairs);
    return {...legacy,estimated:true,estimate_reason:'payment_category_on_bank_deposit_excluded'};
  }
  // External beneficiaries are not owned accounts. A category or memo that
  // nominates entrusted funds cannot prove an operating expense or erase its
  // cash debit: retain the dollars pending a beneficiary/payable reconciliation.
  // Payee names supply no transaction-type evidence here.
  const entrusted = /\b(?:client|customer|tenant|trust|custodial|beneficiary|third party|escrow) (?:[a-z]+ ){0,3}(?:funds?|proceeds|deposits?|payables?|liabilit(?:y|ies)|remittances?)\b/;
  if (row.direction==='outflow' && !liability && (entrusted.test(category) || entrusted.test(text)))
    return read('unknown','ordinary','possible_third_party_funds_counted');
  // Refundable asset placements and liability settlements are principal
  // candidates, not proved operating expenses/refunds. Keep their observed
  // cash contributions until the deposit ledger and original posting reconcile.
  // Both sides use source memo/category evidence; a payee alone is insufficient.
  const deposit = /\b(?:security deposit|refundable (?:[a-z]+ ){0,3}deposit|deposit (?:asset|liability|principal))\b/;
  if (!liability && (deposit.test(text) || deposit.test(category)))
    return row.direction==='inflow' && /\b(?:return(?:ed)?|refund(?:ed)?|recover(?:ed|y)|repayment)\b/.test(text+' '+category)
      ? read('refund','refund','possible_refundable_principal_counted')
      : read('unknown','ordinary','possible_refundable_principal_counted');
  if (separatePaymentExpense(row) || row.direction === 'outflow' && hasExplicitExpenseCategory(row)) return read('spending','ordinary');
  if(cleanFee(row))return unresolvedMovementFee(row)?read('unknown','ordinary','fee_wording_with_payment_or_transfer_counted'):read('spending','ordinary');
  // A closed card advance type creates borrowed cash, not a purchase. Its
  // eventual use still needs cash records; a categorized debit, bank debit or
  // open merchant descriptor cannot acquire this exclusion from "advance".
  if(source.account_kind==='card' && row.direction==='outflow' && row.basis_state==='confirmed' && !category &&
      /^(?:atm )?cash advance$/.test(text) && !hasIndependentOutsidePayee(row,accounts))
    return read('unknown','loan_proceeds','cash_advance_use_unrecorded');
  // Closed transaction types take precedence over broad refund/reward words.
  // A merchant's name or a payout's "less refunds" annotation is not a type.
  if(/\bcredit balance refund\b/.test(text))return read('own_transfer','balance_refund');
  if(LEGACY_PAYMENT_REVERSAL.test(text))
    return read('card_or_loan_payment','payment_reversal',/\bpayment returned\b/.test(text)?'payment_reversal_needs_reconciliation':null);
  if(row.direction==='outflow' && !liability && (trustedCode(row) && category==='payout reversal' ||
      /^(?:deposited item returned(?: nsf)?|ach reversal .+|(?:stripe|square|paypal|shopify|etsy|ebay|doordash) payout reversal(?: .+)?)$/.test(text)))
    return read('refund','deposit_reversal',trustedCode(row) && category==='payout reversal'?null:'deposit_reversal_needs_reconciliation');
  if(row.direction==='outflow' && /^provisional credit reversal\b/.test(text))return read('refund','refund_reversal');
  if(row.direction==='inflow' && /^(?:ach return\b|pos return\b|security deposit returned\b|irs treas \d+ tax ref\b)/.test(text))return read('refund','refund');
  if(row.direction==='outflow' && /\bchargeback (?:protection|service|insurance|alert)\b/.test(text))return read('spending','ordinary');
  const form=!pair && reversalForm(row,liability);
  if(form?.kind==='payment')return read('card_or_loan_payment','payment_reversal','payment_reversal_needs_reconciliation');
  if(form?.kind==='deposit_a' || form?.kind==='deposit_b' && options.depositOriginal?.has(row.id))
    return read('refund','deposit_reversal','deposit_reversal_needs_reconciliation');
  if(form?.kind==='returned_out')return read('refund','refund','returned_payment_needs_reconciliation');
  // Posting-account kind survives loss of endpoint authority. No memo, payout
  // label or proposed category can turn a liability credit into earned income.
  if (liability && row.direction === 'inflow') {
    if(/\b(?:fee|fees|interest|finance charge)\b/.test(text) && /\b(?:credit|credited|waived|waiver|refund|rebate)\b/.test(text))return read('refund','refund');
    if(returnedMoney.test(text+' '+category) || /\breturn$/.test(text) && row.payee && text===normalizeLedgerText(row.payee)+' return')return read('refund','refund');
    if(/^(?:(?:online|automatic|mobile|internet|autopay|auto) )*payment (?:thank you|received)(?: thank you)?$/.test(text) &&
        (!row.payee || [source.label,source.institution,...(source.members||[]).flatMap(a=>[a.label,a.institution])].some(v=>normalizeLedgerText(v)===normalizeLedgerText(row.payee))))
      return read('card_or_loan_payment',source.account_kind==='card'?'card_payment':'loan_payment');
    if(['loan','line_of_credit'].includes(source.account_kind) && text==='principal payment')return read('card_or_loan_payment','loan_payment');
    if(['loan','line_of_credit'].includes(source.account_kind) && text==='interest payment')return read('spending','loan_interest');
    if(/\bbalance transfer\b/.test(text))return read('unknown','liability_credit','balance_transfer_credit_unproved');
    if(/\b(?:statement credit|adjustment credit|fee waived)\b/.test(text))return read('unknown','liability_credit','liability_credit_without_repayment_evidence');
    const legacy = moneyMovementReading(row, accounts, pairs);
    return {...legacy, money_kind: legacy.money_kind === 'ordinary' ? 'liability_credit' : legacy.money_kind};
  }
  // Confirmed movement codes outrank a processor name or its payout wording.
  if(row.direction==='inflow' && trustedCode(row) && /^(?:loan proceeds|loan disbursements?|line of credit advance)(?: |$)/.test(category))return read('own_transfer','loan_proceeds');
  if(row.direction==='inflow' && row.category_basis_state==='confirmed' && /^(?:owner contribution|capital contribution|shareholder contribution)(?:s)?$/.test(category))return read('own_transfer','owner_money');
  if(row.direction==='outflow' && row.side==='business' && row.category_basis_state==='confirmed' &&
    /^(?:owners? draws?|owners? distributions?|shareholder distributions?)$/.test(category))return read('own_transfer','owner_money');
  const sweep = !pair && row.clean_processor_sweep;
  if (sweep?.funded) return read('unknown','own_transfer','processor_sweep_unmatched_excluded');
  if (sweep) return read('unknown','ordinary','possible_processor_sweep_counted');
  if (!pair && row.direction==='outflow' && ['merchant','point_of_sale'].includes(source.account_kind) && accountProcessor(source) &&
      /^(?:(?:stripe|square|paypal|shopify|etsy|ebay|doordash) )?payouts?(?: |$)/.test(text) && !/\b(?:refund|reversal|reversed|returned|failed)\b/.test(text))
    return read('unknown','own_transfer','processor_payout_bank_leg_missing_excluded');
  const processor=moneyProcessor(row),processorAccounts=[...accounts.values()].filter(a=>['merchant','point_of_sale'].includes(a.account_kind) &&
    (!processor || [a.label,a.institution].some(v=>moneyProcessor({payee:v})===processor) || ![a.label,a.institution].some(v=>moneyProcessor({payee:v}))));
  // A processor account's mere existence cannot erase a bank deposit. Until
  // reciprocal proof arrives, both legs stay counted with their exact dollars.
  if(!pair && processor && row.direction==='inflow' && !liability && ['checking','savings'].includes(source.account_kind) && processorAccounts.length &&
      !/\b(?:refund|reversal|reversed|chargeback)\b/.test(text))return read('unknown','ordinary',processorAccounts.some(a=>options.hasRowsNear?.(a.account_slug,row.posted_on,3))?'processor_sweep_unproved_counted':'processor_account_history_missing_counted');
  if(!pair && row.direction==='outflow' && ['merchant','point_of_sale'].includes(source.account_kind) && processor &&
      /\b(?:payout|transfer|sweep)\b/.test(text) && !/\b(?:refund|reversal|reversed|chargeback)\b/.test(text))return read('unknown','ordinary','processor_sweep_unproved_counted');
  if(processor && /\bcapital deposit\b/.test(text))return read('unknown','ordinary','possible_loan_proceeds_counted');
  if(row.direction==='inflow' && processor && !liability && !pair &&
      (/^(?:stripe|square|paypal|shopify|etsy|ebay) (?:payout|transfer|inc deposit)(?: |$)/.test(text) || /^transfer from /.test(text) || /^deposit (?:net|less) /.test(text)) &&
      !/\b(?:reversal|reversed|returned)\b/.test(text) && !/\btransfer\b/.test(category))return read('income','ordinary');
  if(row.direction==='inflow' && processor && !row.payee && /^(?:orig co name|square inc sq)/.test(text))return read('unknown','ordinary','processor_descriptor_unconfirmed_counted');
  if(row.direction==='outflow' && trustedCode(row) && /^(?:dispute|chargebacks)$/.test(category))return read('refund','refund');
  // Proposed categories cannot create exclusion proof. Keep the original row
  // for disclosure, but classify using only a trusted bank/owner movement code.
  const proposed = !trustedCode(row) && PAYMENT_CATEGORY_PREFIXES.some(p=>category===p || category.startsWith(p+' '));
  const evidence = proposed ? {...row,category:null} : row;
  let legacy = moneyMovementReading(evidence,accounts,pairs);
  const endpoint = possibleOwnedMovement(evidence,accounts);
  if (!pair && row.direction === 'inflow' && ['merchant','point_of_sale'].includes(accounts.get(endpoint?.counterpart)?.account_kind)) return read('unknown','ordinary','processor_account_history_missing_counted');
  // An unproved/contradictory pair vetoes a unilateral endpoint exclusion. It
  // must not certify one leg while the reciprocal bank evidence contradicts it.
  if (!pair && options.conflictingPairIds?.has(row.id) && legacy.money_kind === 'own_transfer') return read('unknown','ordinary','possible_own_transfer_counted');
  if (source.account_kind === 'other' && source.account_kind_review?.state !== 'current' && row.direction === 'inflow') {
    if (/^(?:(?:online|automatic|mobile|internet|autopay|auto) )*payment (?:thank you|received)(?: thank you)?$/.test(text))
      return read('unknown','card_payment','payment_credit_on_unreviewed_account');
    return read('unknown','ordinary','account_kind_unreviewed_counted');
  }
  if(options.incomplete && legacy.money_kind==='own_transfer')return read('unknown','ordinary','input_incomplete_movement_counted');
  // Payee names are identities, not refund verbs. Retain only closed generic
  // credit labels for old exports that place the bank transaction type in payee.
  const genericRefundPayee = /^(?:merchant|purchase) refund$/.test(normalizeLedgerText(row.payee));
  if (legacy.money_kind === 'refund' && !returnedMoney.test(text+' '+category) && !genericRefundPayee)
    legacy = moneyMovementReading({...evidence,payee:null},accounts,pairs);
  if (legacy.money_kind === 'refund') {
    if(row.direction==='outflow' && !category)return read('refund','refund','refund_wording_needs_reconciliation');
    if (row.direction === 'outflow' && !trustedCode(row)) return read('unknown','ordinary','possible_refund_counted');
    if (row.direction === 'outflow' && !/\b(?:refund|refunds|reversal|chargeback)\b/.test(category+' '+text)) return read('unknown','ordinary','possible_refund_counted');
    return read('refund','refund');
  }
  if(legacy.money_kind==='loan_proceeds')return read(legacy.classification,'loan_proceeds');
  if (pair && row.clean_transfer_reason && legacy.money_kind==='own_transfer')
    return {...legacy,estimated:true,estimate_reason:row.clean_transfer_reason};
  // A unilateral bank locator supplies a likely endpoint, never counter-entry
  // proof. Keep the observed figure but disclose the unmatched dollars.
  // Existing unproved candidates already disclose these exact dollars through
  // possible_transfer; retain their independent locator membership. A missing
  // counter-entry has no such pair flag and needs its own estimate reason.
  if (!pair && legacy.money_kind==='own_transfer') return candidate ? legacy :
    {...legacy,estimated:true,estimate_reason:'own_transfer_counter_entry_missing_excluded'};
  if (pair || legacy.classification === 'card_or_loan_payment') return legacy;
  if(legacy.estimated && legacy.uncertain_kind && trustedCode(row) && bankRepaymentKind(row))return {...legacy,estimate_reason:'possible_'+legacy.uncertain_kind+'_counted'};
  const possiblePayment=options.possiblePayments?.get(row.id);
  if(possiblePayment)return read('unknown','ordinary',possiblePayment);
  // A complete repayment channel plus a recorded lender nominates the
  // type of debit; it still needs an owned endpoint before exclusion. A lender alone, an empty payee or a merchant
  // suffix is insufficient; in particular never split a combined payment.
  if(row.direction==='outflow' && row.basis_state==='confirmed' && ['checking','savings'].includes(source.account_kind) &&
    /^(?:(?:online|automatic|mobile|internet) )?(?:(?:auto|sba) )?(?:loan|mortgage) (?:payment|pmt|repayment|autopay)(?: principal)?$/.test(text) &&
    /\b(?:lender|lending|loan|mortgage|finance|financial|bank|credit union)\b/.test(normalizeLedgerText(row.payee)))
    return read('unknown','ordinary','possible_loan_payment_counted');
  const channel = cleanPaymentChannel.test(text);
  if (channel) return read('unknown','ordinary',row.direction === 'inflow' ? 'payment_wording_on_deposit_credit_counted' : 'payment_wording_unresolved_party_counted');
  if (proposed) return read('unknown','ordinary','unconfirmed_payment_category_counted');
  if (legacy.estimate_reason === 'possible_loan_proceeds_counted') return legacy;
  if(row.direction==='inflow' && /\b(?:loan from owner|cash advance)\b/.test(text))return read('unknown','ordinary','possible_loan_proceeds_counted');
  if(row.direction==='outflow' && liability && (/^(?:cash advance|(?:loan |credit )?(?:advance|disbursement|draw))\b/.test(text) ||
      /\b(?:cash advance|convenience check|cash equivalent)\b/.test(text)))
    return read('unknown','ordinary','possible_loan_proceeds_counted');
  if(row.direction==='outflow' && /\b(?:epay|e pay|crcardpmt|card(?: online)? (?:pmt|payment|autopay)|cardmember services?|payment to (?:charge |credit )?card)\b/.test(text))
    return read('unknown','ordinary',/\bcredit (?:card|crd) (?:online|mobile|automatic) (?:pmt|pymt|payment)\b/.test(text)
      ?'possible_card_payment_wording_counted':'possible_card_payment_descriptor_counted');
  if(row.direction==='outflow' && /\brefund (?:order|to|customer|client)\b/.test(text))return read('unknown','ordinary','possible_refund_counted');
  if(row.direction==='outflow' && text===normalizeLedgerText(row.payee) && /^autopay .+ (?:inc|llc|ltd|corp)$/.test(text) && !/\b(?:card|loan|mortgage|bank|finance)\b/.test(text))return read('spending','ordinary');
  const role = ownMovementRole(row);
  if (role?.includes('owner contribution') && row.direction === 'inflow') return read('unknown','ordinary','possible_owner_contribution_counted');
  if (role?.includes('owner draw') && row.direction === 'outflow') return row.side==='business'
    ? read('unknown','owner_money','likely_owner_draw_left_out') : read('unknown','ordinary','possible_owner_draw_counted');
  if (candidate && !text && !row.payee || endpoint || isTransferCandidate(row) || /\b(?:transfer|xfer|xfr|trf|tfr|sweep|autopay)\b/.test(text+' '+category) && !hasIndependentOutsidePayee(row,accounts))
    return read('unknown','ordinary','possible_own_transfer_counted');
  if (legacy.classification === 'unknown' && row.direction === 'inflow' && [...accounts.values()].some(a=>liabilityKinds.includes(a.account_kind) && row.payee &&
      [a.label,a.institution].some(v=>normalizeLedgerText(v)===normalizeLedgerText(row.payee)))) return read('unknown','ordinary','lender_credit_without_payment_evidence_counted');
  if (row.direction === 'outflow') {
    if(form?.kind==='deposit_b' && !form.fee_like)return read('spending','ordinary','possible_deposit_reversal_counted');
    const debtKind=!liability && debtPaymentWordingKind(text,normalizeLedgerText(row.payee));
    if(debtKind)return read('unknown','ordinary','possible_'+debtKind+'_payment_wording_counted');
    // Money moved into a brokerage or retirement account is still the owner's.
    if(!liability && investmentContributionText.test(text))return read('unknown','ordinary','possible_investment_transfer_counted');
    return read('spending','ordinary');
  }
  const contrary=incomeContraryEvidence(row,legacy,options);
  if(contrary)return read('unknown','ordinary',contrary);
  if (legacy.classification === 'income' || row.payee && !isOwnedMovementChannel(row.payee) || moneyProcessor(row)) return read('income','ordinary');
  return read('unknown','ordinary','unidentified_deposit_counted');
}

const investmentContributionText = /\b(?:brokerage|moneylink|ira|401k|roth)\b|\b(?:buy|purchase) (?:investments?|securities|shares|stocks?|funds?)\b|\binvest(?:ment)? (?:account|acct|transfer|contribution|deposit)\b|\bretirement (?:contribution|account|acct|transfer)\b/;

export function loanCardPaymentKind(row, accounts) {
  return classifyMoneyMovement(row, accounts) === 'card_or_loan_payment' ? repaymentKind(row, accounts) : null;
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
  // Proved repayment membership never proves a repayment/charge split.
  if (loanCardPaymentKind(row, accounts) && !mixed) return null;
  return { kind, mixed, categoryConflict: Boolean(categoryFor(row)) };
}

// Only an exact owned endpoint can justify excluding an outgoing repayment or
// naming its destination. A bank payment code alone is a disclosure candidate.
export function loanCardPaymentAccount(row, accounts) {
  // Fees, purchases and services stay expenses even when their counterparty
  // exactly names an owned liability.
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
      (resolvesPaymentAccount(row.payee, account, accounts) && /\b(?:payment|repayment|autopay)\b/.test(normalizeLedgerText(row.description)) ||
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
