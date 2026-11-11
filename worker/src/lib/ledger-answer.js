import { callLLM } from "./core.js";
import { withRoleLedgerAnswer } from "./ledger-answer-role.js";
import { ledgerRoleQuestionShape } from "./ledger-role-boundary.js";

// All ledger renderers, including monthly and explicit operands, converge here.
// The trusted nomination plans stay request-local and never come from the model
// or from a composed candidate list. Lost metadata therefore cannot certify zero.
export async function withLedgerAnswer(options, next) {
  const refundBoundary = { requested: false, plans: [] };
  const response = await uncheckedLedgerAnswer({ ...options, refundBoundary }, next);
  if (!refundBoundary.requested || !response.ok) return response;
  const body = await response.json();
  enforceRefundDisclosure(body, refundBoundary);
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
}

function enforceRefundDisclosure(body, boundary) {
  const records = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.refund_disclosure) records.push(value);
    for (const entry of Object.values(value)) if (entry && typeof entry === 'object') visit(entry);
  };
  visit(body.ledger);
  const lines = String(body.answer || '').split('\n');
  const valid = boundary.plans.length > 0 && records.length === boundary.plans.length && boundary.plans.every(plan => {
    const matches = records.filter(record => record.refund_disclosure.scope === plan.scope);
    if (matches.length !== 1) return false;
    const record = matches[0], scope = record.refund_disclosure;
    const candidates = record.possible_refunds;
    return record.from === plan.from && record.to === plan.to && scope.from === plan.from && scope.to === plan.to && Array.isArray(candidates) &&
      candidates.length === plan.candidates.length && new Set(candidates.map(c => c.n)).size === candidates.length &&
      plan.candidates.every(expected => {
        const refs = (body.citations || []).filter(ref => ref.ref === expected.ref &&
          candidates.some(candidate => candidate.n === ref.n));
        if (refs.length !== 1) return false;
        const ref = refs[0], candidate = candidates.find(c => c.n === ref.n);
        return ['amount_minor', 'posted_on', 'account_mask'].every(key => candidate[key] === expected[key] && ref[key] === expected[key]) &&
          candidate.bank_text === expected.bank_text && candidate.label === 'possible refund, not subtracted' &&
          candidate.posted_on >= plan.from && candidate.posted_on <= plan.to &&
          lines.filter(line => line === expected.line + ` [${ref.n}]`).length === 1 &&
          (!plan.periodLabel || lines.slice(0, lines.indexOf(expected.line + ` [${ref.n}]`)).reverse()
            .find(line => /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}:/.test(line))
            ?.startsWith(plan.periodLabel + ':'));
      });
  }) && lines.filter(line => line.startsWith('possible refund, not subtracted:')).length ===
    boundary.plans.reduce((sum, plan) => sum + plan.candidates.length, 0);
  if (valid) return;
  // Never let a renderer's missing, duplicated or misbound disclosure silently
  // downgrade a nominated population. Keep the exact gross records for review.
  body.answer = 'I cannot confirm spending after refunds because the bank feed does not supply a refund or reversal type. Candidate disclosure unavailable; the requested net is withheld.\n' +
    lines.filter(line => !line.startsWith('possible refund, not subtracted:') && line !== 'Possible refunds:').join('\n');
  if (body.ledger) Object.assign(body.ledger, { net_refunds_unavailable: true,
    candidate_disclosure_unavailable: true, amount_basis: 'gross_before_refunds' });
  body.evidence_gate = { ...body.evidence_gate, complete: false, partial: true,
    reason: 'candidate disclosure unavailable; net of refunds unavailable' };
}

async function uncheckedLedgerAnswer(options, next) {
  const boundary = !options.financingBoundaryRead && storeQuestionShape(options.question) === 'financing';
  if (boundary && !options.access && options.scopePrincipalKind === 'owner' && options.grantScope &&
      scopeIsUnrestricted(options.grantScope) && !options.entityScope?.applied &&
      Object.keys(options.filters || {}).length === 0 && options.ledgerEligible !== false) {
    const response = await withLedgerAnswer({ ...options, financingBoundaryRead: true },
      async gap => Response.json({ gaps: gap ? [gap] : [] }));
    const body = await response.clone().json();
    if (body.gaps?.some(gap => gap.reason === 'financing_schedule_unavailable')) return response;
    // Missing coverage or accounts cannot establish absence of expected payouts.
    // Do not turn an unrelated document fallback into deposit evidence.
    return Response.json({ mode: 'think', answer: "No payout schedule or expected-amount source is connected, so I can't tell which financing payouts are still due. No recent deposits could be verified from the connected bank history.",
      citations: [], results: [], gaps: [...(body.gaps || []), { reason: 'financing_schedule_unavailable' }] });
  }
  // Text nominates or vetoes a candidate. Only admitted selectors authorize
  // purity; a category is an optional transaction filter under that policy.
  const context = { now: options.now, timeZone: options.env.BRAIN_TIMEZONE ?? null };
  const shape = ledgerRoleQuestionShape(options.question, context);
  const roleCategoryCandidate = shape.type !== 'candidate';
  if (roleCategoryCandidate && shape.roles.length !== 1) return withHeadLedgerAnswer(options, next);
  const { access, grantScope, scopePrincipalKind, filters = {}, entityScope, ledgerEligible = true } = options;
  const eligible = !access && Boolean(grantScope) && scopeIsUnrestricted(grantScope) &&
    scopePrincipalKind === 'owner' && !entityScope?.applied && Object.keys(filters).length === 0 && ledgerEligible;
  if (!eligible) return withHeadLedgerAnswer(options, next);
  // A role word in a document task does not authorize ledger inspection.
  if (!canExtractLedgerIntent(options.question) && !classifyLedgerQuestion(options.question,
    { now: options.now, timeZone: options.env.BRAIN_TIMEZONE ?? null }).kind) return withHeadLedgerAnswer(options, next);
  // A literal may be discovered only after provider admission. Reuse that
  // response if it sends the question back through the ordinary HEAD reader.
  const invoke = options.callLLM || callLLM;
  let providerReply;
  const invokeOnce = (...args) => {
    providerReply ??= Promise.resolve().then(() => invoke(...args));
    return providerReply;
  };
  const admitted = { ...options, callLLM: invokeOnce };
  // Scope admission stays in the role reader; every admitted scope uses the
  // same monetary partition and cited payment disclosure as the ordinary path.
  return withRoleLedgerAnswer({ ...admitted, roleOnlyScope: shape.roles[0], roleCategoryCandidate,
    roleLedgerAnswer: (env, intent, accounts, inventory) => ledgerAnswer(env,
      { ...intent, loanPaymentSubject: loanPaymentSubject(options.question, intent), refundBoundary: options.refundBoundary }, accounts, inventory) }, next,
    () => withHeadLedgerAnswer(admitted, next));
}

import { ledgerOperandScopePlan, resolvedLedgerScopePlan, resolveLedgerScope } from "./ledger-intent-scope.js";
import { moneyAccount, moneyPresentation } from "./money-format.js";
import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion, storeQuestionShape, ledgerDay, ownerLedgerDay, shiftLedgerDay } from "./ledger-question.js";
import { canExtractLedgerIntent, extractLedgerIntentDecision, ledgerIntentInterpretation, normalizeLedgerIntentWords, validateLedgerIntentDecision } from "./ledger-intent.js";
import { ledgerDescriptorTotal, ledgerClauseRefusalReason, loanPaymentSubject, loanAccountSelector } from "./ledger-intent-contract.js";
import { finalLedgerOffer, ledgerClarificationAnswer as composeLedgerClarification } from "./ledger-clarification.js";
import { refundBasisForOperand } from "./ledger-refund-basis.js";
import { resolveOwnershipScope } from "./ledger-owner-scope.js";
import { monthlyLedgerAnswer } from "./ledger-monthly.js";
import { compoundBalanceOperands, compoundBalanceAnswer } from "./ledger-balance-compound.js";
import { isBoundedVendorAbsence, labelPartialPeriodAnswer, periodAccountScope } from "./ledger-period-scope.js";
import { accountLinkRequiredInWindow, effectivePeriodCovered, readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions, readUncertainScopeAccounts } from "./ledger-reader.js";
import { accountKindReviewRequired, hasIndependentOutsidePayee, possibleUnconnectedPayment, isOwnedMovementChannel, uncertainOwnedMovementEndpoint, categoryFor, possibleOwnedMovement, recurringReading, classifyOwnedMovement, detectRecurring, isDirectedOwnedTransfer, isOwnedMovement, isLoanAdvance, isTransferCandidate, isUncategorizedBucket, matchesCategory, matchesMerchant, matchesSender, merchantFor, merchantMatchBasis, normalizeLedgerText, normalizeMerchantText, loanCardPaymentKind, loanCardPaymentAccount, ownedLiabilityPaymentKind, ordinaryMoneyMembership, payerAttributionBasis, pairOwnTransfers, selectVendorFamily, sumMinor, transferEndpoints } from "./ledger-analysis.js";

import { REFUND_MATCH_DAYS, refundCreditMembership, refundCandidateIds, ownMovementRole } from "./ledger-analysis.js";

import { recurringSetAsideText, accountEndings, balanceSuggestion, documentMoneyNotice, originalRecordSuggestion, paymentExclusionLines, pendingNotice, plainBankGap, plainRouterLimitation } from "./ledger-wording.js";

const masked = moneyAccount;
const money = cents => `${cents < 0 ? "-" : ""}$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const safeDescription = text => String(text || "Deposit").replace(/\d(?:[\s-]*\d){4,}/g, "[redacted]").slice(0, 240);
// Description-based attribution stays conditional and quotes its bank evidence.
const payerAssumptionNote = rows => rows.filter(row => payerAttributionBasis(row) === "description_assumption").map(row =>
  '\nAssuming the bank description "' + safeDescription(row.description) + '" identifies that payer; payer identity is unconfirmed.').join('');
const accountDisplay = account => moneyAccount(account, { label: true });
const normalizeAccountText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
const withoutAccountKind = value => value.replace(/\b(?:account|acct|credit|card|checking|savings|loan|investment|retirement|escrow)\b/g, "").replace(/\s+/g, " ").trim();
function ledgerClarificationAnswer(body, decision) {
  const records = body.ledger?.parts || [body.ledger];
  // Keep requested basis flags for arithmetic, but describe the returned basis
  // in every interpretation, including the clarification's best reading.
  return composeLedgerClarification(body, { ...decision, intents: decision.intents.map((intent, index) => records[index]?.amount_basis
    ? { ...intent, interpretation: ledgerIntentInterpretation(intent, intent.presentation, records[index].amount_basis) } : intent) });
}
function accountSelectorRank(account, selector, scopeWords = false) {
  const wanted = normalizeAccountText(normalizeLedgerIntentWords(selector));
  if (!wanted) return 0;
  let rank = 0;
  for (const member of account.members || [account]) {
    if (/^\d{1,4}$/.test(member.mask || "") && (wanted === member.mask ||
        new RegExp(`^(?:(?:account|acct|card|checking|savings|loan) )?(?:ending (?:in )?)?${member.mask}$`).test(wanted))) rank = 2;
    const label = normalizeAccountText(normalizeLedgerIntentWords(member.label));
    if (label && wanted === label) rank = 2;
    else if (label && withoutAccountKind(wanted) && withoutAccountKind(wanted) === withoutAccountKind(label)) {
      rank = Math.max(rank, 1);
    }
  }
  // Scope words can be contained in a feed display label. Do not infer a
  // personal/business role from an institution or a merchant description.
  const scope = withoutAccountKind(wanted).replace(/^(?:my|our|the) /, '');
  if (scopeWords && !rank) for (const member of account.members || [account]) {
    const label = normalizeAccountText(normalizeLedgerIntentWords(member.label));
    const typed = wanted.replace(/^(?:my|our|the) /, '').replace(/ (?:acct|account)$/, '');
    if ((scope && (` ${label} `).includes(` ${scope} `)) || typed === member.account_kind) rank = 1;
  }
  return rank;
}
function accountsForSelector(inventory, selector, scopeWords = false, retainEquivalent = false) {
  const ranked = inventory.map(account => ({ account, rank: accountSelectorRank(account, selector, scopeWords) }));
  const best = Math.max(0, ...ranked.map(row => row.rank));
  return best ? ranked.filter(row => scopeWords || retainEquivalent ? row.rank > 0 : row.rank === best).map(row => row.account) : [];
}
function recognizeLiteralAccount(inventory, intent, presentation = intent.presentation, protectedPayee = intent.protectedPayee) {
  if (protectedPayee || !intent.interpretation || intent.modelAccountScope || intent.kind !== 'merchant' || !intent.match ||
      !accountsForSelector(inventory, intent.match).length) return false;
  intent.modelAccountScope = intent.match;
  intent.kind = intent.direction === 'inflow' ? 'deposits' : 'expense_summary';
  if (intent.kind === 'deposits') intent.limit = 10;
  delete intent.match;
  delete intent.merchantPreposition;
  intent.interpretation = ledgerIntentInterpretation(intent, presentation);
  return true;
}
function balanceAccountScope(accounts, intent) {
  // Status describes whether a balance belongs in a current total, not which
  // account an ending or normalized label identifies. Resolve identity across
  // every candidate first, including closed and never-connected siblings.
  const exact = !intent.accountScopeUnresolved && (intent.literalAccountResolved || intent.mask || intent.accountSelector &&
    accounts.some(account => accountSelectorRank(account, intent.accountSelector, true) === 2));
  const identity = !intent.accountScopeUnresolved && (intent.mask || intent.accountSelector &&
    accounts.some(account => accountSelectorRank(account, intent.accountSelector) > 0));
  const ambiguous = Boolean((identity || intent.singleAccountBalance) && accounts.length > 1);
  // Existing named-selector lists may retain every open candidate. Status
  // cannot narrow that list, and an unresolved identity cannot authorize a sum.
  if (ambiguous && (intent.cashOnlyBalance || accounts.some(account => account.status !== 'open')))
    return { accounts, excluded: [], ambiguous, reason: 'ambiguous_account' };
  const direct = exact && accounts.length === 1 && accounts[0].status === 'closed';
  return { accounts: direct ? accounts : accounts.filter(account => account.status === 'open'),
    excluded: direct ? [] : accounts.filter(account => account.status !== 'open')
      .map(account => ({ account, reason: account.status === 'closed' ? 'closed'
        : account.status === 'never_connected' ? 'never_connected' : 'status_unconfirmed' })), ambiguous, reason: null };
}
const balanceExclusionLines = intent => (intent.balanceExclusions || []).map(({ account, reason }) =>
  accountDisplay(account) + ': ' + ({ closed: 'closed', never_connected: 'never connected',
    status_unconfirmed: 'account status unconfirmed' }[reason]) + ', not counted.');
function transactionRankingUnit(question, intent) {
  let words = ` ${normalizeLedgerText(normalizeLedgerIntentWords(question))} `;
  // This placeholder is internal authority, never a phrase the caller can add.
  if (words.includes(' calendar period ')) return null;
  if (intent.rankingCalendarRole) {
    const role = normalizeLedgerText(normalizeLedgerIntentWords(intent.rankingCalendarRole));
    words = words.replace(` ${role} `, ' calendar period ');
  }
  // Selectors are data, not operators. Mask whole normalized literals, longest
  // first, at every occurrence; a label must not mask a substring of a unit.
  const literals = [...new Set([intent.match, intent.accountSelector, intent.modelAccountScope]
    .filter(Boolean).map(value => normalizeLedgerText(normalizeLedgerIntentWords(value))))]
    .sort((a, b) => b.length - a.length);
  for (const literal of literals) words = words.replace(new RegExp(`(^| )(at|from|to|with|for|in|within|on)(?: (?:my|our|the))?(?: (?:account|bank category|category))? ${literal}(?= |$)`, 'g'), '$1$2 selector');
  for (const literal of [intent.accountSelector, intent.modelAccountScope].filter(Boolean).map(value => normalizeLedgerText(normalizeLedgerIntentWords(value))))
    words = words.replace(new RegExp(`(^| )(the|my|our) ${literal}(?= made(?: |$))`, 'g'), '$1$2 selector');
  // An explicit account selector may carry the ordinary plural account noun.
  // The ranked subject still has to be a transaction, never an account.
  if (intent.ownershipScope || intent.modelAccountScope || intent.accountSelector) words = words.replace(/\bselector accounts?\b/g, 'selector');
  if (intent.matchType === 'category') words = words.replace(/\b(?:bank )?category selector\b/g, 'selector');
  const core = words.trim();
  // Admit an operation, not a bag of known words. The ranked noun must be a
  // transaction; account selectors and per-account partitions are suffix roles.
  // In particular, "rank accounts by ... charges" never proves this reader.
  const count = '(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const entity = '(?:charges?|expenses?|deposits?|transactions?|payments?|purchases?|payouts?)';
  const qualifier = '(?:(?:individual|single|recorded|completed|posted|outgoing|incoming|stock|bank|expense) )*';
  const order = '(?:largest|biggest|highest|top|priciest|most expensive)';
  const modal = '(?:(?:could|can|would|will) you )?(?:please )?';
  const request = `(?:${modal}(?:retrieve|pull(?: up)?|fetch|list|show|tell|find|get|give)(?: me| us)? |what (?:was|were|is|are) |which (?:was|were|is|are) |can (?:i|we) see )?`;
  const subject = `(?:my |our |the )?(?:${count} )?${order}(?: ${count})? ${qualifier}${entity}`;
  const rankedRequest = `${modal}(?:rank|ranking) (?:${subject}|(?:my |our |the )?(?:${count} )?${qualifier}${entity})`;
  const costQuestion = `(?:which|what) (?:my |our |the )?(?:${count} )?${qualifier}${entity} (?:cost (?:us|me) the most|took the most money)`;
  const ranked = core.match(new RegExp(`^(${request}${subject}|${rankedRequest}|${costQuestion})(.*)$`));
  if (!ranked) return null;
  let tail = ranked[2];
  const month = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
  const period = `(?:calendar period|(?:this|last|previous|prior|current) (?:month|year|quarter|week|day)|(?:last|past) ${count} (?:days|weeks|months|years)|${month}(?: [0-9]{4})?|q[1-4](?: [0-9]{4})?|[0-9]{4}|today|yesterday|now)`;
  const selector = '(?:at|from|to|with|for|in|within|on)(?: (?:my|our|the))?(?: (?:account|bank category|category))? selector';
  const account = '(?:in|for|of|into|from|on)(?: (?:my|our|the))?(?: (?:checking|savings|card|loan|investment|retirement|escrow))? account(?: ending(?: in)?)? [0-9]{1,4}';
  const wholeScope = '(?:across|in|from) (?:all|my|our|the) accounts';
  const grouping = '(?:per|in each|for each) accounts?';
  const slots = new RegExp(`^ (?:${selector}|${account}|${wholeScope}|(?:the|my|our) selector made|(?:i|we) paid|(?:(?:in|for|from|during|over|since|on) )?(?:the )?${period}(?: so far)?|so far)`);
  const groupSlot = new RegExp(`^ ${grouping}(?= |$)`);
  let groupBy = null;
  while (tail) {
    const group = tail.match(groupSlot);
    if (group) {
      if (groupBy || !intent.perAccountLargest) return null;
      groupBy = 'account'; tail = tail.slice(group[0].length); continue;
    }
    const slot = tail.match(slots);
    if (slot && (tail.length === slot[0].length || tail[slot[0].length] === ' ')) {
      tail = tail.slice(slot[0].length); continue;
    }
    // The compiler removes an admitted event literal after replacing its
    // meaning with the earliest covered day. A raw dangling "since" has no
    // such authority and must still refuse.
    if (tail === ' since' && intent.earliestCoveredDate) { tail = ''; continue; }
    return null;
  }
  return Boolean(intent.perAccountLargest) === (groupBy === 'account') ? 'transaction' : null;
}
const accountCoverage = accounts => accounts.map(a => ({
  account_mask: /^\d{1,4}$/.test(a.mask || "") ? a.mask : null,
  covered_to: a.covered_to || null, last_synced_at: a.last_synced_at || null,
}));
const balanceKindOrder = new Map(["checking", "savings", "card", "loan", "line_of_credit"].map((kind, index) => [kind, index]));
const balanceGroup = account => ["checking", "savings"].includes(account.account_kind) && account.balance_role === "asset"
  ? "cash" : ["card", "loan", "line_of_credit"].includes(account.account_kind) && account.balance_role === "liability"
    ? "liability" : "other";
const compactPeriodLabel = intent => `in ${intent.presentation.period(intent.from, intent.to)}`;

function gapFor(reason, accounts = [], intent = {}) {
  const review = new Set(["ledger_account_kind_review_required", "ledger_wording_unsupported", "owner_timezone_unavailable", "cash_flow_unsupported",
    "merchant_selector_unsupported", "merchant_selector_ambiguous", "coverage_review_required",
    "bank_export_overlap_review_required", "ledger_partial_coverage"]);
  const baseDetail = reason === 'no_accounts' && intent.kind === 'balance' && intent.balanceExclusions?.length
    ? ['No open connected account matches this request.', 'Want help reviewing which account to use?'].join('\n')
    : plainBankGap(reason, reason === 'period_outside_coverage'
      ? periodAccountScope(accounts, intent).omitted : accounts, intent);
  // Exclusions belong to the balance decision, even if a later snapshot or
  // pending read refuses. Every refusal surface consumes this same detail.
  const detail = [baseDetail, ...(intent.kind === 'balance' ? balanceExclusionLines(intent) : [])].join('\n');
  if (review.has(reason)) return { type: reason === "ledger_partial_coverage" ? "ledger_partial_coverage" : "ledger_not_consulted", reason, code: reason,
    ...(intent.from ? { from: intent.from, to: intent.to } : {}), detail };
  if (reason === 'ledger_account_link_required') return { type: 'ledger_not_consulted', reason, code: reason,
    ...(intent.from ? { from: intent.from, to: intent.to } : {}), detail };
  return {
    type: reason === "period_outside_coverage" ? "ledger_out_of_coverage" : "ledger_not_consulted",
    reason, accounts: accountCoverage(accounts),
    ...(intent.from ? { from: intent.from, to: intent.to } : {}), detail,
  };
}

function citation(row, account, index, presentation, balance = false) {
  const amount = balance ? row.current_minor : row.amount_minor;
  const day = balance ? row.as_of_date : row.posted_on;
  const member = account.members.find(a => a.account_slug === row.source_account_slug);
  return {
    n: index + 1, source: "ledger", source_kind: "ledger",
    ref: `ledger:${balance ? "balance" : "transaction"}:${row.id}`,
    title: `${masked(account)}: ${money(amount)} on ${presentation.date(day)}`,
    account_mask: /^\d{1,4}$/.test(account.mask || "") ? account.mask : null,
    posted_on: day, amount_minor: amount, currency: row.currency,
    last_synced_at: row.last_synced_at || null,
    supplied_by: member?.feed_mode || "unknown",
    ts: day, date_reliable: true, text_source: "native", text_reliable: true,
  };
}

const readableRow = row => row.basis_state === "confirmed" && /^\d{4}-\d{2}-\d{2}$/.test(row.posted_on || "") &&
  Number.isFinite(Date.parse(row.posted_on)) && ledgerDay(row.posted_on) === row.posted_on &&
  Number.isSafeInteger(row.amount_minor) && row.amount_minor >= 0 && row.currency === "USD" && ["inflow", "outflow"].includes(row.direction);
const usableAccount = a => !a.ambiguous && !a.linkRequired && a.currency === "USD" && a.members.every(m => m.basis_state === "confirmed");
const moveKind = kind => ["checking", "savings", "card"].includes(kind);
const withdrawalKind = kind => ["investment", "retirement"].includes(kind);
// A bank code also proves payments to unconnected liabilities. Do not claim
// ownership when that code is the only evidence available to the reader.
const paymentSummaryLabel = payments => payments.some(({ row }) => loanCardPaymentKind(row, new Map()))
  ? 'Payments to loans and cards (excluded from spending and income)' : 'Payments to your own loan/card accounts';

// Amount selection and payment disclosure must read the same whole words.
const matchesDescriptionKeyword = (row, keyword) => {
  const wanted = normalizeLedgerText(keyword);
  if (!wanted) return false;
  const description = ` ${normalizeLedgerText(row.description)} `;
  const singular = /^(?:refunds?|reimbursements?)$/.test(wanted) ? wanted.replace(/s$/, '') : null;
  return singular ? [singular, `${singular}s`].some(word => description.includes(` ${word} `))
    : description.includes(` ${wanted} `);
};

// One admitted-inflow membership (closed world) serves the money-in answer's
// outside inflow and the payer listing's groups and income total. A credit is
// outside inflow unless it is the incoming leg of a structurally proved pair
// between the owner's own accounts: both legs readable, usable and covered,
// neither account of unconfirmed kind, the incoming leg selected and in the
// window, and directed reciprocal owned-account evidence. Coincident amounts,
// bank text alone or an attribution caveat never remove or admit a credit.
function provedOwnInflowPair(pair, { eligible, excludedPayments, selected, inWindow, bySlug }) {
  return [pair.out, pair.in].every(row => eligible(row) && !excludedPayments.has(row.id) &&
      bySlug.get(row.effective_account_slug).account_kind !== "other") &&
    selected.has(pair.in.effective_account_slug) && inWindow(pair.in) && isDirectedOwnedTransfer(pair, bySlug);
}

function leadExclusions(rows, pairs, selected, bySlug, intent) {
  if (intent.kind === "largest" && intent.direction === "outflow") {
    const { ownTransfers, payments } = ordinaryExpenseSelection(rows, pairs, bySlug);
    // Explicit transfer inclusion remains a requested alternate view. The
    // ordinary ranking and summary share the same proved expense membership.
    const removedTransfers = intent.ownTransfers === "include" ? [] : [...ownTransfers.values()];
    const excluded = new Map(removedTransfers.map(row => [row.id, "a matched own-account transfer"]));
    for (const [id, payment] of payments) excluded.set(id, loanCardPaymentKind(payment.row, new Map())
      ? 'a loan or card payment' : `a payment to your own ${payment.liabilityKind} account`);
    for (const row of rows) if (['loan', 'line_of_credit'].includes(bySlug.get(row.effective_account_slug)?.account_kind))
      excluded.set(row.id, 'loan account activity, not a purchase');
    for (const row of rows) {
      const account = bySlug.get(row.effective_account_slug);
      if (account?.account_kind === 'other' && account.account_kind_review?.state !== 'current')
        excluded.set(row.id, 'account kind not confirmed');
    }
    return { excluded,
      keptPairs: new Map(), knownOwnTransferRows: new Set(intent.ownTransfers === "include" ? ownTransfers.keys() : []),
      scopedKnownTransferRows: new Set(), expensePayments: payments,
      summary: { own_transfer_pairs: removedTransfers.length, own_transfer_minor: sumMinor(removedTransfers),
        withdrawal_count: 0, withdrawal_minor: 0, loan_proceeds_count: 0, loan_proceeds_minor: 0 } };
  }
  const excluded = new Map(), ownPairs = [], withdrawals = new Map(), loanProceeds = new Map(), keptPairs = new Map();
  const knownOwnTransferRows = new Set(), scopedKnownTransferRows = new Set();
  const inAnswer = new Set(rows.map(row => row.id));
  const kind = row => bySlug.get(row.effective_account_slug).account_kind;
  // Keep the decision with the row. Rendering must never guess an exclusion
  // reason from transfer-like wording or from membership alone.
  const omit = (row, reason) => { if (inAnswer.has(row.id)) excluded.set(row.id, reason); };
  // A category code is evidence; description words and institution names are
  // never withdrawal evidence. Proposed feed categories count by this rule.
  if (intent.withdrawals !== "include") for (const row of rows) {
    if (row.direction === "inflow" && moveKind(kind(row)) &&
        /^TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS$/i.test(row.category || "") &&
        ["proposed", "confirmed"].includes(row.category_basis_state)) {
      omit(row, "a retirement or investment withdrawal"); withdrawals.set(row.id, row);
    }
  }
  for (const pair of pairs) {
    if (![pair.out, pair.in].some(row => inAnswer.has(row.id))) continue;
    const outKind = kind(pair.out), inKind = kind(pair.in);
    const bothInScope = selected.has(pair.out.effective_account_slug) && selected.has(pair.in.effective_account_slug);
    const directedMove = (moveKind(outKind) || withdrawalKind(outKind)) && moveKind(inKind) &&
      isDirectedOwnedTransfer(pair, bySlug);
    if ((moveKind(outKind) || withdrawalKind(outKind)) && moveKind(inKind) && !directedMove) {
      keptPairs.set(pair, "counterparty evidence is insufficient or conflicting, kept in the figures");
      continue;
    }
    if (moveKind(outKind) && moveKind(inKind)) {
      if (intent.ownTransfers !== "include" && (bothInScope || intent.ownTransfers === "exclude")) {
        omit(pair.out, "a matched own-account transfer"); omit(pair.in, "a matched own-account transfer"); ownPairs.push(pair);
      } else if (!bothInScope && intent.ownTransfers !== "include") {
        keptPairs.set(pair, "other account is outside this question, kept in money in and money out");
        for (const row of [pair.out, pair.in]) if (inAnswer.has(row.id)) {
          knownOwnTransferRows.add(row.id); scopedKnownTransferRows.add(row.id);
        }
      } else if (intent.ownTransfers === "include") {
        for (const row of [pair.out, pair.in]) if (inAnswer.has(row.id)) knownOwnTransferRows.add(row.id);
      }
    } else if (withdrawalKind(outKind) && moveKind(inKind) && selected.has(pair.in.effective_account_slug)) {
      if (intent.withdrawals !== "include") {
        omit(pair.out, "a retirement or investment withdrawal"); omit(pair.in, "a retirement or investment withdrawal"); withdrawals.set(pair.in.id, pair.in);
      }
    } else if (isLoanAdvance(pair, bySlug) && selected.has(pair.in.effective_account_slug)) {
      if (intent.loanProceeds !== "include") {
        omit(pair.out, "loan or line-of-credit proceeds"); omit(pair.in, "loan or line-of-credit proceeds"); loanProceeds.set(pair.in.id, pair.in);
      }
    } else {
      keptPairs.set(pair, moveKind(outKind) && ["loan", "line_of_credit"].includes(inKind)
        ? "loan payment, kept in money out" : moveKind(outKind) && withdrawalKind(inKind)
          ? "sent to a retirement or investment account, kept in money out"
          : "account kind does not qualify for this exclusion, kept in the figures");
    }
  }
  return { excluded, keptPairs, knownOwnTransferRows, scopedKnownTransferRows, summary: { own_transfer_pairs: ownPairs.length,
    own_transfer_minor: sumMinor(ownPairs, pair => pair.out.amount_minor),
    withdrawal_count: withdrawals.size, withdrawal_minor: sumMinor([...withdrawals.values()]),
    loan_proceeds_count: loanProceeds.size, loan_proceeds_minor: sumMinor([...loanProceeds.values()]) } };
}

// Money out keeps every completed outflow except a PROVEN own movement (a
// reciprocal unique directed pair). Bank text or a payment code that
// nominates a repayment or transfer, with no proven owned destination, is
// money out only when no connected account could have received it. Closed
// world: a liability of the matching type, or an account whose type is
// unconfirmed, could receive a repayment; an equal amount arriving within
// three days, or a connected account with no history for those days, could be
// a transfer's other leg. Such a posting is neither provably money out nor a
// provable own movement, so the money-out figure is withheld.
const moneyOutDay = day => Date.parse(`${day}T00:00:00Z`) / 86400000;
function couldReceiveRepayment(account, kind) {
  return [account, ...(account.members || [])].some(member => member.account_kind === 'other' ||
    member.account_kind_balance_conflict || (kind === 'card' ? member.account_kind === 'card'
      : ['loan', 'line_of_credit'].includes(member.account_kind)) ||
    member.balance_role === 'liability' && !(kind === 'card' ? ['loan', 'line_of_credit'] : ['card']).includes(member.account_kind));
}
function moneyOutDestinations({ rows, allRows, possiblePayments, bySlug, transfers = true, movementMembership }) {
  const nominated = new Map(possiblePayments.map(({ row, candidate }) => [row.id, candidate]));
  const candidates = [];
  for (const row of rows) {
    if (row.direction !== 'outflow' || row.amount_minor <= 0) continue;
    const source = bySlug.get(row.effective_account_slug);
    // Loan-account activity never enters money out; its readers exclude it.
    if (!source || ['loan', 'line_of_credit'].includes(source.account_kind)) continue;
    if (movementMembership.excluded.has(row.id)) continue;
    const nomination = nominated.get(row.id) || movementMembership.possible.get(row.id) ||
      (loanCardPaymentAccount(row, bySlug) ? { kind: 'own_account', destination: 'account' } : null);
    const coded = nomination ? null : loanCardPaymentKind(row, bySlug);
    const kind = nomination?.kind || coded || (transfers && isTransferCandidate(row) && !hasIndependentOutsidePayee(row, bySlug) ? 'transfer' : null);
    if (!kind) continue;
    // A possible own-account movement could have reached any connected
    // account, so its other leg is sought exactly like a transfer's.
    const destination = nomination?.destination || null;
    const others = [...bySlug.values()].filter(account => account !== source);
    const day = moneyOutDay(row.posted_on);
    const near = shift => shiftLedgerDay(row.posted_on, shift);
    const counterparts = kind === 'transfer' || kind === 'own_account' || destination ? others.filter(account => !effectivePeriodCovered(account, near(-3), near(3)) ||
      allRows.some(peer => peer.effective_account_slug === account.account_slug && peer.direction === 'inflow' &&
        peer.amount_minor === row.amount_minor && (peer.currency || 'USD') === (row.currency || 'USD') &&
        Math.abs(moneyOutDay(peer.posted_on) - day) <= 3))
      : others.filter(account => couldReceiveRepayment(account, kind));
    candidates.push({ row, kind, basis: coded ? 'bank_code' : 'description', mixed: Boolean(nomination?.mixed), counterparts,
      ...(destination ? { destination } : {}) });
  }
  return { candidates, unconfirmed: candidates.filter(candidate => candidate.counterparts.length) };
}

function ordinaryExpenseSelection(rows, pairs, bySlug, retained = null) {
  const outflows = rows.filter(row => row.direction === "outflow");
  const inAnswer = new Set(outflows.map(row => row.id));
  const ownTransfers = new Map(), payments = new Map();
  for (const pair of pairs) {
    // Padding and a counterpart in another selected period cannot exclude a
    // row that does not contribute to this answer's outgoing expense pool.
    if (!inAnswer.has(pair.out.id)) continue;
    const movement = classifyOwnedMovement(pair, bySlug);
    if (movement?.kind === "own_transfer") ownTransfers.set(pair.out.id, pair.out);
  }
  for (const row of outflows) {
    // Money out retains a payment code whose destination is not connected.
    if (retained?.has(row.id)) continue;
    const liabilityKind = loanCardPaymentKind(row, bySlug);
    if (liabilityKind) {
      // A bank payment code remains authoritative even if equal-amount legs
      // also satisfy the advisory asset-transfer matcher. Inclusion flags
      // must never restore that payment as ordinary spending.
      ownTransfers.delete(row.id);
      payments.set(row.id, { row, liabilityKind });
    }
  }
  const membership = ordinaryMoneyMembership(rows, pairs, bySlug);
  for (const row of outflows) if (membership.excluded.has(row.id) && !payments.has(row.id)) ownTransfers.set(row.id, row);
  const ordinary = membership.ordinary.filter(row => row.direction === "outflow" && !payments.has(row.id) &&
    !['loan', 'line_of_credit'].includes(bySlug.get(row.effective_account_slug)?.account_kind));
  return { ordinary, ownTransfers, payments };
}

function refundReading(charges, history, pairs, accounts) {
  const credits = refundCreditMembership(history, pairs, accounts);
  return { candidateIds: refundCandidateIds(charges, credits), credits };
}

function refundDisclosure(result, credits, intent, bySlug) {
  // Deduplicate by ledger identity, never by amount, date or description.
  const refs = [...new Map(credits.map(row => [row.id, row])).values()].map(row => {
    let ref = result.citations.find(c => c.ref === 'ledger:transaction:' + row.id);
    if (!ref) {
      ref = citation(row, bySlug.get(row.effective_account_slug), (intent.citationOffset || 0) + result.citations.length, intent.presentation);
      result.citations.push(ref);
    }
    return { row, ref };
  });
  result.ledger.possible_refunds = refs.map(({ row, ref }) => ({ n: ref.n, amount_minor: row.amount_minor,
    posted_on: row.posted_on, account_mask: ref.account_mask, bank_text: safeDescription(row.description),
    label: 'possible refund, not subtracted' }));
  if (refs.length) result.answer += '\nPossible refunds:\n' + refs.map(({ row, ref }) =>
    `possible refund, not subtracted: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, ${masked(bySlug.get(row.effective_account_slug))}, "${safeDescription(row.description)}" [${ref.n}]`).join('\n');
}

function withholdRefundNet(result) {
  Object.assign(result.ledger, { net_refunds_unavailable: true, amount_basis: 'gross_before_refunds' });
  if (result.ledger.classification_uncertain) return;
  result.answer = 'I cannot confirm spending after refunds because the bank feed does not supply a refund or reversal type; the amounts below are before subtracting refunds.\n' + result.answer;
}

function expenseSummary({ intent, accounts, requestedAccounts, omittedAccounts, rows, pairs, pairing, bySlug, citationOffset = 0, retainedPaymentIds = null }) {
  const moneyOut = intent.outflowMeasure === true;
  const { ordinary, ownTransfers, payments } = ordinaryExpenseSelection(rows, pairs, bySlug, retainedPaymentIds);
  const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const rowOrder = (a, b) => b.amount_minor - a.amount_minor ||
    b.posted_on.localeCompare(a.posted_on) || compareText(String(a.id), String(b.id));
  const grouped = new Map();
  for (const row of ordinary) {
    const merchant = merchantFor(row) || "unknown merchant";
    if (!grouped.has(merchant)) grouped.set(merchant, []);
    grouped.get(merchant).push(row);
  }
  const orderedGroups = [...grouped].map(([merchant, groupRows]) => ({ merchant, rows: groupRows,
    total_minor: sumMinor(groupRows), count: groupRows.length }))
    .sort((a, b) => b.total_minor - a.total_minor || compareText(a.merchant, b.merchant));
  // Every displayed partition and remainder must support its whole amount.
  // A five-posting cap leaves smaller groups and multi-row sums unproved.
  const evidenceRows = [...ordinary].sort(rowOrder);
  const citations = evidenceRows.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index + citationOffset, intent.presentation));
  const citationById = new Map(evidenceRows.map((row, index) => [row.id, index + citationOffset + 1]));
  const displayedGroups = orderedGroups.slice(0, 10).map(group => ({
    merchant: safeDescription(group.merchant), total_minor: group.total_minor, count: group.count,
    citations: [...group.rows].sort(rowOrder).map(row => citationById.get(row.id)).filter(Boolean),
  }));
  const categories = new Map();
  for (const row of ordinary) {
    const category = categoryFor(row) || "Unsorted";
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(row);
  }
  const orderedCategories = [...categories].map(([category, categoryRows]) => ({
    category, rows: categoryRows, total_minor: sumMinor(categoryRows), count: categoryRows.length,
  })).sort((a, b) => b.total_minor - a.total_minor || compareText(a.category, b.category));
  const displayedCategories = orderedCategories.slice(0, intent.categoryLimit ?? 10).map(group => ({
    category: safeDescription(group.category), total_minor: group.total_minor, count: group.count,
    citations: [...group.rows].sort(rowOrder).map(row => citationById.get(row.id)).filter(Boolean),
  }));
  const paymentRows = [...payments.values()];
  const paymentTotal = sumMinor(paymentRows, item => item.row.amount_minor);
  const cardMinor = sumMinor(paymentRows.filter(item => item.liabilityKind === "card"), item => item.row.amount_minor);
  const loanMinor = sumMinor(paymentRows.filter(item => item.liabilityKind === "loan"), item => item.row.amount_minor);
  const totalMinor = sumMinor(ordinary);
  const omittedRowCount = ordinary.length - citations.length;
  // A current owner review can confirm 'other' without naming a repayment
  // subtype. Directed owned payments still stop at accountKindReviewRequired;
  // an explicit outside payee does not inherit that destination's uncertainty.
  const classificationKnown = account => account.account_kind !== "other" ||
    account.account_kind_review?.state === "current" && ["asset", "liability"].includes(account.balance_role);
  // Coverage alone cannot certify unreviewed inventory or inconsistent roles.
  const classificationUncertain = [...bySlug.values()].some(account =>
    !classificationKnown(account) || account.account_kind !== "other" && account.balance_role !==
      (["card", "loan", "line_of_credit"].includes(account.account_kind) ? "liability" : "asset"));
  const coverageComplete = omittedAccounts.length === 0;
  const complete = coverageComplete && !classificationUncertain;
  const coverage = {
    status: coverageComplete ? "full" : "partial", complete: coverageComplete,
    candidate_account_count: requestedAccounts.length,
    covered_account_count: accounts.length,
    omitted_account_count: omittedAccounts.length,
    excluded_accounts: omittedAccounts.map(account => ({
      account_mask: /^\d{1,4}$/.test(account.mask || "") ? account.mask : null,
      account_kind: account.account_kind,
    })),
  };
  // Complete bank coverage does not prove which outgoing rows are expenses.
  // Unknown inventory types can conceal a repayment destination or source;
  // retain that money without certifying an expense figure from memo words.
  const label = intent.periodLabel === "this month" ? "this month"
    : intent.periodLabel === "last month" ? "last month"
      : intent.periodLabel === "today" ? "today"
        : intent.periodLabel === "yesterday" ? "yesterday"
          : intent.periodLabel === "this week" ? "this week"
            : `in ${intent.presentation.period(intent.from, intent.to)}`;
  const classificationComplete = [...bySlug.values()].every(classificationKnown);
  if (!classificationComplete) {
    return {
      answer: `Money out I could check: ${money(totalMinor)} ${label}.\n` +
        `Period: ${intent.presentation.period(intent.from, intent.to)}.\n` +
        `Here is the money out I could check, with spending still unconfirmed. The account types for ${accountEndings([...bySlug.values()].filter(account => !classificationKnown(account)))} have not been confirmed, so some payments may be between your own accounts.\n${balanceSuggestion}\n` +
        (coverageComplete
          ? `Bank history: all ${accounts.length} accounts include ${intent.presentation.period(intent.from, intent.to)}.`
          : `Here is a partial view using ${accounts.length} of ${requestedAccounts.length} accounts for ${intent.presentation.period(intent.from, intent.to)}; ${accountEndings(omittedAccounts)} ${omittedAccounts.length === 1 ? "is" : "are"} missing some dates.\n${balanceSuggestion}`),
      citations,
      ledger: { kind: "expense_summary", from: intent.from, to: intent.to, ...(moneyOut ? { outflow_measure: "money_out" } : {}),
        accounts: accountCoverage(accounts), coverage, complete: false, classification_complete: false, classification_uncertain: true,
        total_minor: null, expense_total_minor: null, retained_outflow_minor: totalMinor,
        row_count: ordinary.length, cited_row_count: citations.length, omitted_row_count: omittedRowCount,
        own_account_payments: { total_minor: paymentTotal, count: paymentRows.length, card_minor: cardMinor, loan_minor: loanMinor } },
    };
  }
  const ledger = {
    kind: "expense_summary", from: intent.from, to: intent.to,
    accounts: accountCoverage(accounts), coverage, complete,
    classification_uncertain: classificationUncertain,
    total_minor: totalMinor, expense_total_minor: totalMinor, row_count: ordinary.length,
    cited_row_count: citations.length, omitted_row_count: omittedRowCount,
    ...(intent.paymentCitationDetails ? { amount_citations: citations.map(ref => ref.n) } : {}),
    group_count: orderedGroups.length, groups: displayedGroups,
    omitted_group_count: Math.max(0, orderedGroups.length - displayedGroups.length),
    ...(orderedGroups.length > displayedGroups.length ? { other_groups: { count: orderedGroups.length - displayedGroups.length,
      total_minor: sumMinor(orderedGroups.slice(displayedGroups.length), group => group.total_minor),
      citations: orderedGroups.slice(displayedGroups.length).flatMap(group => group.rows.map(row => citationById.get(row.id))) } } : {}),
    category_group_count: orderedCategories.length, category_groups: displayedCategories,
    omitted_category_group_count: Math.max(0, orderedCategories.length - displayedCategories.length),
    ...(orderedCategories.length > displayedCategories.length ? { other_categories: { count: orderedCategories.length - displayedCategories.length,
      total_minor: sumMinor(orderedCategories.slice(displayedCategories.length), group => group.total_minor),
      citations: orderedCategories.slice(displayedCategories.length).flatMap(group => group.rows.map(row => citationById.get(row.id))) } } : {}),
    excluded_own_transfer_minor: sumMinor([...ownTransfers.values()]),
    own_account_payments: { total_minor: paymentTotal, count: paymentRows.length,
      card_minor: cardMinor, loan_minor: loanMinor },
    includes_own_transfers: false,
    matched_transfer_count: ownTransfers.size,
    candidate_transfer_count: pairing.pairs.length,
  };
  const partial = complete ? "" : " (some accounts missing dates)";
  // A went-out question asks for money out; its lead never says "spent".
  if (moneyOut) ledger.outflow_measure = "money_out";
  let answer = classificationUncertain
    ? `Money out I could check: ${money(totalMinor)} ${label}.\nPeriod: ${intent.presentation.period(intent.from, intent.to)}.`
    : moneyOut
    ? `${complete ? "Money out" : "Money out I could check"}: ${money(totalMinor)} ${label}${partial}, not counting moves between your own accounts.\nPeriod: ${intent.presentation.period(intent.from, intent.to)}.`
    : complete
    ? `You spent ${money(totalMinor)} ${label}.\nPeriod: ${intent.presentation.period(intent.from, intent.to)}.`
    : `Spending I could check: ${money(totalMinor)} ${label}${partial}.\nPeriod: ${intent.presentation.period(intent.from, intent.to)}.`;
  if (classificationUncertain) answer += `\nHere is the money out I could check, with spending still unconfirmed. The account types for ${accountEndings([...bySlug.values()].filter(account =>
    account.account_kind === "other" || account.balance_role !==
      (["card", "loan", "line_of_credit"].includes(account.account_kind) ? "liability" : "asset")))} have not been confirmed, so some payments may be between your own accounts.\n${balanceSuggestion}`;
  if (!coverageComplete) answer += `\nHere is a partial view using ${accounts.length} of ${requestedAccounts.length} accounts for ${intent.presentation.period(intent.from, intent.to)}; ${accountEndings(omittedAccounts)} ${omittedAccounts.length === 1 ? "is" : "are"} missing some dates.\n${balanceSuggestion}`;
  if (displayedGroups.length) {
    answer += "\nMerchant groups:";
    for (const group of displayedGroups) {
      const refs = group.citations.map(n => `[${n}]`).join(" ");
      answer += `\n${group.merchant}: ${money(group.total_minor)} across ${group.count} ${group.count === 1 ? "row" : "rows"}${refs ? ` ${refs}` : ""}.`;
    }
  }
  if (ledger.omitted_group_count) answer += `\nOther (${ledger.other_groups.count} payees): ${money(ledger.other_groups.total_minor)} ${ledger.other_groups.citations.map(n => `[${n}]`).join(" ")}.`;
  if (displayedCategories.length) {
    answer += "\nCategory groups:";
    for (const group of displayedCategories) {
      const refs = group.citations.map(n => `[${n}]`).join(" ");
      answer += `\n${group.category}: ${money(group.total_minor)} across ${group.count} ${group.count === 1 ? "row" : "rows"} ${refs}.`;
    }
  }
  const unconfirmedCategories = ordinary.filter(row => !categoryFor(row));
  if (unconfirmedCategories.length) {
    ledger.unconfirmed_category_count = unconfirmedCategories.length;
    ledger.unsorted_minor = sumMinor(unconfirmedCategories);
    answer += '\nUnconfirmed categories: ' + unconfirmedCategories.length + ' rows totaling ' + money(ledger.unsorted_minor) + '; left out of confirmed category totals.';
  }
  if (ledger.omitted_category_group_count) answer += `\nOther (${ledger.other_categories.count} categories): ${money(ledger.other_categories.total_minor)} ${ledger.other_categories.citations.map(n => `[${n}]`).join(" ")}.`;
  if (intent.showExcludedTransfers || (intent.interpretation && ledger.excluded_own_transfer_minor > 0)) answer += `\nExcluded detected own-account transfers: ${money(ledger.excluded_own_transfer_minor)}.`;
  answer += `\nEvidence: ${citations.length} of ${ordinary.length} expense rows cited${omittedRowCount ? `, and ${omittedRowCount} more rows` : ""}.`;
  answer += coverageComplete
    ? `\nBank history: all ${accounts.length} accounts include ${intent.presentation.period(intent.from, intent.to)}.`
    : `\nBank history: ${accounts.length} of ${requestedAccounts.length} accounts include ${intent.presentation.period(intent.from, intent.to)}; excluded ${omittedAccounts.map(masked).join(", ")}.`;
  return { answer, citations, ledger };
}
const closestPayeeNames = (rows, query, limit = 3) => {
  const wanted = normalizeMerchantText(query), wantedTokens = new Set(wanted.split(" ").filter(Boolean));
  // Shared words and prefixes alone do not make a different business a typo.
  const editDistance = value => {
    let previous = Array.from({ length: wanted.length + 1 }, (_, i) => i);
    for (let i = 0; i < value.length; i++) {
      const current = [i + 1];
      for (let j = 0; j < wanted.length; j++) current.push(Math.min(
        current[j] + 1, previous[j + 1] + 1, previous[j] + (value[i] === wanted[j] ? 0 : 1)));
      previous = current;
    }
    return previous[wanted.length];
  };
  const choices = new Map();
  for (const row of rows) {
    const normalized = normalizeMerchantText(row.payee);
    if (!normalized || Math.abs(normalized.length - wanted.length) > 2 || editDistance(normalized) > 2) continue;
    const label = safeDescription(row.payee);
    if (!choices.has(normalized) || label.localeCompare(choices.get(normalized)) < 0) choices.set(normalized, label);
  }
  const commonPrefix = value => {
    let length = 0;
    while (length < wanted.length && length < value.length && wanted[length] === value[length]) length++;
    return length;
  };
  return [...choices].map(([normalized, label]) => ({ normalized, label,
    shared: normalized.split(" ").filter(token => wantedTokens.has(token)).length,
    prefix: commonPrefix(normalized), distance: Math.abs(normalized.length - wanted.length) }))
    .sort((a, b) => b.shared - a.shared || b.prefix - a.prefix || a.distance - b.distance ||
      a.normalized.localeCompare(b.normalized))
    .slice(0, limit).map(choice => choice.label);
};
const orderedVendorRows = rows => [...rows].sort((a, b) =>
  b.posted_on.localeCompare(a.posted_on) || a.id - b.id);

async function addPreviousExpenseMonth(env, intent, accounts, inventory, current) {
  // The intent already uses the owner's local calendar. Shifting its month
  // start, rather than the UTC clock, handles local boundaries and year turns.
  const to = shiftLedgerDay(intent.from, -1);
  const previousIntent = { ...intent, from: `${to.slice(0, 7)}-01`, to,
    defaultedPeriod: false, periodLabel: "last month", citationOffset: current.citations.length };
  let previous;
  try {
    // A link dispute can affect a different interval than the current month.
    // Recheck that admission before using the same reader and composer.
    previous = accounts.some(account => accountLinkRequiredInWindow(account, previousIntent))
      ? { reason: "ledger_account_link_required" }
      : await ledgerAnswer(env, previousIntent, accounts, inventory);
  } catch {
    previous = { reason: "ledger_unavailable" };
  }
  const lines = current.answer.split("\n");
  const refs = current.citations.map(c => `[${c.n}]`).join(" ");
  // Keep the current result on one line, including its evidence, repayment
  // and coverage qualifications. The complete prior-month breakdown follows.
  const currentDetail = lines.filter(line => /^(?:Spending I could check:|Payments to your own loan\/card accounts:|Payments to loans and cards \(excluded from spending and income\):|Evidence:|Bank history:|Here is the money out|Here is a partial view)/.test(line));
  const headline = [`Month to date (${intent.presentation.period(intent.from, intent.to)}): ${lines[0]}`, refs, ...currentDetail].filter(Boolean).join(" ");
  const currentNotes = lines.filter(line => /^(?:Your account|Want |payment to |and \d+ more:)/.test(line));
  const currentBlock = [headline, ...currentNotes].join("\n");
  const previousLabel = `Previous complete calendar month (${intent.presentation.period(previousIntent.from, to)}):`;
  if (previous.reason) {
    const gap = gapFor(previous.reason, accounts, previousIntent);
    current.answer = `${currentBlock}\n\n${previousLabel}\nUnavailable. ${gap.detail}`;
    current.ledger.previous_month = { kind: "expense_summary", from: previousIntent.from, to,
      complete: false, reason: previous.reason, time_zone: intent.timeZone };
    current.gaps = [...(current.gaps || []), gap];
  } else {
    current.answer = `${currentBlock}\n\n${previousLabel}\n${previous.answer}`;
    current.citations.push(...previous.citations);
    current.ledger.previous_month = { ...previous.ledger, time_zone: intent.timeZone };
  }
}

// Keep the requested identity outside mutable routing hints. Only this local
// evidence object crosses composition boundaries; it is never serialized.
const namedSelectorEvidence = Symbol('named selector evidence');

// All named absence text passes this renderer after composition. The typed
// scope flag is derived from the identity snapshot, independently of whether
// a ranking, payment partition or refund receipt retained the possible row.
function renderNamedScope(text, scope) {
  if (!scope.attribution_incomplete) return text;
  const sentence = "The store's own total is not confirmed.";
  const absenceClaim = /\bno (?:ordinary |recurring |matching |readable |completed )*(?:spending|charges?|expenses?|deposits?|payments?|rows?|transactions?)\b|\bfound\s*[:=]\s*false\b|\bfound no matching\b/i;
  const prefix = scope.label ? `${scope.label}: ` : '';
  const lines = text.slice(prefix.length).split('\n').map(line => line.split(/(?<=[.;])\s+(?=[A-Za-z])/));
  // Posting amounts are evidence, including a legitimate zero-valued posting.
  // Only aggregate zero/absence clauses are withheld from the named answer.
  const absenceClause = clause => !/^(?:payments? to |and \d+ more:|refunds received:|other money received:|money received:)/i.test(clause) &&
    (absenceClaim.test(clause) || /\$0\.00\b/.test(clause));
  if (!lines.some(clauses => clauses.some(absenceClause)) && scope.found !== false &&
      !(scope.complete === true && scope.total_minor === 0)) return text;
  const safe = lines.map(clauses => clauses.filter(clause => clause !== sentence && !absenceClause(clause))
    .join(' ')).join('\n').trimStart();
  return `${prefix}${sentence}${scope.label ? ' ' : '\n'}${safe}`;
}

// Apply after composition, immediately before the public answer is serialized.
// Never infer absence from a partition that dropped uncertain named evidence.
export function enforceNamedZeroPostcondition(result, evidence = result[namedSelectorEvidence]) {
  if (!evidence || !result.ledger) return result;
  const scopes = result.ledger.months || [result.ledger];
  const totalKeys = ['total_minor', 'lead_total_minor', 'subtotal_minor', 'complete_total_minor',
    'monthly_total_minor', 'lead_monthly_total_minor', 'partial_subtotal_minor', 'expense_total_minor',
    'exact_subtotal_minor', 'family_subtotal_minor', 'lead_exact_subtotal_minor', 'lead_family_subtotal_minor'];
  for (const scope of scopes) {
    const membership = scope.citations && new Set(scope.citations);
    const possibleRows = [
      ...(scope.payment_exclusions?.rows || []),
      ...(scope.refund_rows || []),
    ].filter(row => row.match_basis === 'possible');
    const possibleNumbers = new Set([...(scope.possible_citations || []), ...possibleRows.map(row => row.n)]);
    const inScope = ref => ref.posted_on >= scope.from && ref.posted_on <= scope.to;
    const possible = (evidence.possibleRows || []).some(inScope) || possibleRows.some(inScope) ||
      (result.citations || []).some(ref => (!membership || membership.has(ref.n)) && inScope(ref) &&
        (evidence.possible.has(ref.ref) || possibleNumbers.has(ref.n)));
    if (possible) scope.attribution_incomplete = true;
    const start = scope.label ? result.answer.indexOf(`${scope.label}:`) : 0;
    if (start >= 0) {
      const next = scope.label && scopes.find(month => month.from > scope.to);
      const end = next ? result.answer.indexOf(`${next.label}:`, start) : result.answer.length;
      result.answer = result.answer.slice(0, start) + renderNamedScope(result.answer.slice(start, end),
        { ...scope, attribution_incomplete: possible }) + result.answer.slice(end);
    }
    if (possible) {
      scope.complete = false;
      if (scope.found === false) scope.found = null;
      for (const key of totalKeys) if (scope[key] === 0) scope[key] = null;
      if (scope.if_own_transfers) {
        for (const key of totalKeys) if (scope.if_own_transfers[key] === 0) scope.if_own_transfers[key] = null;
        scope.if_own_transfers.complete = false;
      }
      if (scope.label) { scope.available = false; scope.reason = 'merchant_possible_matches'; }
    }
  }
  if (scopes.some(scope => scope.attribution_incomplete)) {
    result.ledger.complete = false;
    result.ledger.attribution_incomplete = true;
    if (result.ledger.months) result.ledger.available = result.ledger.months.some(month => month.available);
  }
  return result;
}

function namedSelectorText(intent) {
  if (intent.descriptionKeyword || intent.matchType === 'category' || intent.categorySelector ||
      intent.interpretation && intent.direction === 'inflow' && /^(?:refunds?|reimbursements?)$/i.test(intent.match || '')) return null;
  return intent.recurringSelector || (intent.kind === 'payment' && intent.counterpartyWords?.length
    ? intent.counterpartyWords.join(' ') : ['merchant', 'largest', 'deposits'].includes(intent.kind) ? intent.match : null);
}

async function guardNamedSelector(env, intent, result) {
  const evidence = result[namedSelectorEvidence];
  if (!evidence || !result.ledger || result.reason) return result;
  const { selector, accounts, allowed, possible } = evidence;
  // Anonymous deposit details are explicitly contextual, never a payer amount.
  // Retain that existing uncertainty receipt while guarding every attributed
  // group and subtotal. Possible vendor amounts likewise stay qualified.
  const attributed = new Set([
    ...(result.ledger.groups || []).flatMap(group => group.citations || []),
    ...(result.ledger.payment_exclusions?.rows || []).map(row => row.n),
  ]);
  const contextual = !(evidence.kind === 'payment' && Number.isSafeInteger(evidence.amountMinor)) && result.ledger.attribution_incomplete && result.ledger.total_minor == null
    ? new Set((result.citations || []).filter(ref => !attributed.has(ref.n)).map(ref => ref.n)) : new Set();
  const possiblePayments = new Set([result.ledger, ...(result.ledger.months || [])].flatMap(ledger =>
    (ledger.payment_exclusions?.rows || []).filter(row => row.match_basis === 'possible').map(row => row.n)));
  // A possible posting is admissible only inside its own qualified month.
  // Parent incompleteness alone cannot authorize an attributed store figure.
  const qualifiedMonthly = new Set((result.ledger.months || []).filter(month =>
    month.complete === false && /possible/.test(month.match_basis || '') && month.total_minor == null && month.subtotal_minor == null)
    .flatMap(month => month.possible_citations || []));
  // Character-overlap rows can explain an identity review beside a proved
  // vendor total. Their citations are never authority for any amount group.
  const reviewOnly = new Set((result.ledger.possible_identity_members || [])
    .filter(member => evidence.possibleIdentity.has(member.ref))
    .flatMap(member => member.citations || []));
  for (const scope of [result.ledger, ...(result.ledger.months || [])]) {
    for (const n of [...(scope.amount_citations || []), ...(scope.inflow_citations || []), ...(scope.outflow_citations || []),
      ...(scope.groups || []).flatMap(group => group.citations || []), ...(scope.recurring || []).flatMap(group => group.citations || [])])
      attributed.add(n);
    for (const row of [...(scope.rows || []), ...(scope.lead_rows || []), ...(scope.inflow_rows || []),
      ...(scope.refund_rows || []), ...(scope.payment_exclusions?.rows || [])])
      if (Number.isInteger(row.n)) attributed.add(row.n);
  }
  const unprovedFigure = !allowed.size && ['total_minor', 'lead_total_minor', 'monthly_total_minor',
    'lead_monthly_total_minor', 'attributed_subtotal_minor'].some(key => Number.isSafeInteger(result.ledger[key]) && result.ledger[key] > 0);
  const unconfirmedAmount = evidence.kind === 'payment' && Number.isSafeInteger(evidence.amountMinor) && !allowed.size;
  const unsafeAmountClaim = unconfirmedAmount && (result.ledger.found !== null || result.ledger.complete !== false ||
    result.ledger.total_minor !== null || !['possible', 'none'].includes(result.ledger.match_basis));
  let foreign = unsafeAmountClaim || unprovedFigure || (result.citations || []).some(ref => !contextual.has(ref.n) &&
    !allowed.has(ref.ref) && !(evidence.possibleIdentity.has(ref.ref) && reviewOnly.has(ref.n) && !attributed.has(ref.n)) && !(possible.has(ref.ref) &&
      (possiblePayments.has(ref.n) || qualifiedMonthly.has(ref.n) || result.ledger.complete === false && /possible/.test(result.ledger.match_basis || ''))));
  // A category refusal can already contain no money, but must not erase a
  // known merchant's identity merely because its rows are outside this window.
  const categoryRefusal = evidence.kind === 'merchant' && result.ledger.kind === 'category' && result.ledger.selector_unresolved;
  if (!foreign && !categoryRefusal) return result;
  // A refusal must not retain nested figures, alternate totals, payment
  // appendices or foreign citation objects from the rejected answer.
  let outsideDates = [], historyUnavailable = false;
  try {
    const starts = accounts.map(account => account.covered_from).filter(Boolean).sort();
    const ends = accounts.map(account => account.covered_to).filter(Boolean).sort();
    if (starts.length === accounts.length && ends.length === accounts.length && accounts.length) {
      const history = await readEffectiveTransactions(env, accounts, { from: starts[0], to: ends.at(-1) });
      const selected = evidence.kind === 'recurring'
        ? history.filter(row => normalizeMerchantText(row.payee) === normalizeMerchantText(selector))
        : evidence.kind === 'payment' ? history.filter(row => matchesSender(row, evidence.counterpartyWords))
        : selectVendorFamily(history, selector).matched;
      outsideDates = [...new Set(selected.filter(row => readableRow(row) && !row.export_overlap_review &&
        (row.posted_on < evidence.from || row.posted_on > evidence.to) &&
        accounts.some(account => account.account_slug === row.effective_account_slug &&
          effectivePeriodCovered(account, row.posted_on, row.posted_on))).map(row => row.posted_on))].sort();
    }
  } catch { historyUnavailable = true; }
  if (!foreign && !outsideDates.length) return result;
  foreign = true;
  const outsideLine = outsideDates.length
    ? ` (rows for ${safeDescription(selector)} exist outside this window: ${outsideDates.map(intent.presentation.date).join(', ')})`
    : historyUnavailable ? ' Rows outside this window could not be checked.' : '';
  const ledger = { kind: evidence.kind, from: evidence.from, to: evidence.to,
    accounts: accountCoverage(accounts), total_minor: null, monthly_total_minor: null,
    selector_applied: false, selector_unresolved: true, match_basis: 'none',
    complete: false, found: null, row_count: 0, recurring: [],
    named_selector_guard: { rejected: foreign, outside_window_dates: outsideDates, history_unavailable: historyUnavailable },
    coverage: result.ledger.coverage,
    ...(result.ledger.partial_reason ? { partial_reason: result.ledger.partial_reason } : {}),
    ...(result.ledger.time_zone ? { time_zone: result.ledger.time_zone } : {}) };
  const answer = (possible.size
    ? `Possible payee mentions exist for ${safeDescription(selector)} from ${intent.presentation.date(evidence.from)} to ${intent.presentation.date(evidence.to)} on ${accounts.map(masked).join(', ')}; no store total is confirmed.`
    : `No charges at ${safeDescription(selector)} from ${intent.presentation.date(evidence.from)} to ${intent.presentation.date(evidence.to)} on ${accounts.map(masked).join(', ')}.`) +
    outsideLine +
    '\nNo exact payee match; no store total is confirmed. Please choose a precise payee selector.';
  return { answer, citations: [], ledger, [namedSelectorEvidence]: { ...evidence, allowed: new Set(), possible: new Set() } };
}

function loanPaymentRefusal(intent) {
  return { answer: "I can't confirm loan payments from these records yet. Ask about the loan account directly.", citations: [],
    ledger: { kind: intent.kind, from: intent.from, to: intent.to, complete: false,
      total_minor: null, expense_total_minor: null, reason: 'loan_payments_unconfirmed' } };
}

async function ledgerAnswer(env, intent, accounts, inventory) {
  if (intent.kind !== 'balance' && (intent.loanPaymentSubject ||
      intent.accountScopeUnresolved && loanAccountSelector(intent.modelAccountScope))) return loanPaymentRefusal(intent);
  if (intent.refundsNotNetted || intent.netRefunds) intent.refundBoundary.requested = true;
  if (intent.categoryTopic && intent.kind === 'merchant' && intent.match) {
    const covered = periodAccountScope(accounts, intent).covered;
    if (covered.length) {
      // A category-topic frame is ambiguous until authorized history rules
      // out the named payee. Window-only absence cannot establish a category:
      // the named merchant may have posted yesterday or several months ago.
      let history;
      try {
        history = await readEffectiveTransactions(env, covered, {
          from: covered.map(account => account.covered_from).sort()[0],
          to: covered.map(account => account.covered_to).sort().at(-1),
        });
      } catch { return { reason: 'ledger_unavailable' }; }
      if (history.some(row => row.export_overlap_review)) return { reason: 'bank_export_overlap_review_required' };
      if (history.some(row => !readableRow(row))) return { reason: 'unreadable_transactions' };
      const identity = selectVendorFamily(history.filter(row => covered.some(account =>
        account.account_slug === row.effective_account_slug && effectivePeriodCovered(account, row.posted_on, row.posted_on))), intent.match);
      if (!identity.matched.length && !identity.possible.length) intent = { ...intent, kind: 'category' };
    }
  }
  const selector = namedSelectorText(intent);
  const evidence = selector ? { selector, kind: intent.kind, from: intent.from, to: intent.to, counterpartyWords: intent.counterpartyWords,
    accounts, amountMinor: intent.amountMinor, allowed: new Set(), possible: new Set(), possibleRows: [], possibleIdentity: new Set() } : null;
  if (intent.monthlyBreakdown) {
    const result = await monthlyLedgerAnswer(intent, accounts, async month => {
      const part = await ledgerAnswer(env, month, accounts, inventory);
      const child = part[namedSelectorEvidence];
      if (evidence && child) {
        for (const ref of child.allowed) evidence.allowed.add(ref);
        for (const ref of child.possible) evidence.possible.add(ref);
        for (const ref of child.possibleIdentity) evidence.possibleIdentity.add(ref);
        evidence.possibleRows.push(...child.possibleRows);
      }
      return part;
    });
    if (evidence) result[namedSelectorEvidence] = evidence;
    return guardNamedSelector(env, intent, result);
  }
  const scope = !['balance', 'transactions'].includes(intent.kind) ? periodAccountScope(accounts, intent) : null;
  let candidates, bySlug;
  const result = await ledgerPeriodAnswer(env, intent, accounts, inventory, scope, evidence, (rows, accountMap) => {
    candidates = rows; bySlug = accountMap;
  });
  if ((intent.refundsNotNetted || intent.netRefunds) && result.ledger) {
    if (candidates) {
      // Freeze the nomination population before the renderer creates any refs
      // or candidate metadata. A rendering omission cannot redefine this set.
      const plan = { scope: intent.refundBoundary.plans.length, from: intent.from, to: intent.to,
        periodLabel: intent.refundPeriodLabel || null,
        candidates: [...new Map(candidates.map(row => [row.id, row])).values()].map(row => {
          const account = bySlug.get(row.effective_account_slug);
          return { ref: 'ledger:transaction:' + row.id, amount_minor: row.amount_minor,
            posted_on: row.posted_on, account_mask: /^\d{1,4}$/.test(account.mask || '') ? account.mask : null,
            bank_text: safeDescription(row.description),
            line: `possible refund, not subtracted: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, ${masked(account)}, "${safeDescription(row.description)}"` };
        }) };
      intent.refundBoundary.plans.push(plan);
      result.ledger.refund_disclosure = { scope: plan.scope, from: plan.from, to: plan.to };
      refundDisclosure(result, candidates, intent, bySlug);
    }
    withholdRefundNet(result);
  }
  if (evidence) result[namedSelectorEvidence] = evidence;
  if (scope) labelPartialPeriodAnswer(result, scope, intent);
  return guardNamedSelector(env, intent, result);
}

// Shared by direct and clarification answers before either renderer runs.
// Pending transactions never change the dated snapshot arithmetic.
async function balanceObservationPlan(env, intent, ordered, inventory) {
  const from = ordered.map(({ row }) => row.as_of_date).sort()[0];
  const pending = await readEffectiveTransactions(env, inventory, { from, to: intent.observationTo || intent.to,
    effectiveAccountSlugs: ordered.map(({ account }) => account.account_slug), pendingOnly: true });
  if (pending.some(row => !readableRow(row))) throw new Error('unreadable pending records');
  const relevant = pending.filter(row => row.posted_on >= ordered.find(entry =>
    entry.account.account_slug === row.effective_account_slug).row.as_of_date);
  const outflow = sumMinor(relevant.filter(row => row.direction === 'outflow'), row => row.amount_minor);
  const inflow = sumMinor(relevant.filter(row => row.direction === 'inflow'), row => row.amount_minor);
  const coverage = ordered.every(({ account }) => account.coverage_status === 'complete' && account.coverage_basis === 'confirmed' &&
    account.members.every(member => !member.coverage_review_required));
  const record = { selector: intent.accountSelector || intent.mask || intent.accountKind || intent.entityKind || 'all open accounts',
    selection_complete: !intent.balanceSelectionAmbiguous && !(intent.balanceExclusions || []).some(entry => entry.reason !== 'closed'),
    exclusions: (intent.balanceExclusions || []).map(({ account, reason }) => ({ account_mask: account.mask, reason })),
    coverage_complete: coverage, snapshots: ordered.map(({ row, account }) => ({ account_mask: account.mask,
      as_of: row.as_of_date, status: account.status, history: { status: account.coverage_status,
        from: account.covered_from, to: account.covered_to, basis: account.coverage_basis } })),
    pending: { count: relevant.length, outflow_minor: outflow, inflow_minor: inflow, treatment: 'not_included' } };
  const lines = [coverage ? 'The saved account history is complete.' : 'The saved account history is partial; a complete current total is unconfirmed.',
    ...(intent.balanceSelectionAmbiguous ? ['This ending or label matches multiple accounts. The balances below are separate candidates.\nWant to choose which account you mean?'] : []),
    ...balanceExclusionLines(intent),
    ...((intent.balanceExclusions || []).some(entry => entry.reason !== 'closed')
      ? ['Some accounts have no confirmed current connection; a complete current total is unconfirmed.'] : []),
    ...ordered.filter(({ account }) => account.status === 'closed').map(({ account }) => accountDisplay(account) + ' is closed; its last recorded balance follows.'),
    ...(relevant.length ? ['Pending after the dated snapshots below (not yet included): outflows ' + money(outflow) + '; inflows ' + money(inflow) + '. These amounts are not added to or subtracted from the recorded balances.']
      : ['No pending transactions are recorded after these snapshots.'])];
  return { record, lines };
}

async function ledgerPeriodAnswer(env, intent, accounts, inventory, scope, evidence, onRefundCandidates) {
  if (intent.measure === "cash_flow") return { reason: "cash_flow_unsupported" };
  if (intent.measure && !accounts.some(a => moveKind(a.account_kind))) return { reason: "unsupported_question" };
  if (intent.kind === "balance") {
    const observed = await readEffectiveBalances(env, inventory, { ...intent, mask: null, accountKind: null,
      effectiveAccountSlugs: accounts.map(account => account.account_slug),
      includeAvailable: Boolean(intent.balanceMeasures || intent.pendingRequested) });
    intent.onBalanceObservations?.(observed);
    const selected = new Set(accounts.map(account => account.account_slug));
    const balances = observed.filter(row => selected.has(row.effective_account_slug));
    if (balances.length !== accounts.length || balances.some(b => b.basis_state !== "confirmed" ||
      !Number.isSafeInteger(b.current_minor) || b.currency !== "USD")) return { reason: "balance_unavailable" };
    const ordered = balances.map(row => ({ row, account: accounts.find(a => a.account_slug === row.effective_account_slug) }));
    if (ordered.some(entry => !entry.account)) return { reason: "balance_unavailable" };
    ordered.sort((a, b) => Number(b.account.account_kind === intent.preferredAccountKind) - Number(a.account.account_kind === intent.preferredAccountKind) ||
      (balanceKindOrder.get(a.account.account_kind) ?? balanceKindOrder.size) -
      (balanceKindOrder.get(b.account.account_kind) ?? balanceKindOrder.size) ||
      String(a.account.mask || "").localeCompare(String(b.account.mask || "")) ||
      a.account.account_slug.localeCompare(b.account.account_slug));
    if (intent.latestSyncedReading) {
      intent.latestSyncedDay = ordered.map(({ row }) => /^\d{4}-\d{2}-\d{2}/.exec(String(row.last_synced_at || ''))?.[0]).filter(Boolean).sort().at(-1);
      intent.interpretation = ledgerIntentInterpretation(intent);
    }
    // Every recorded balance must be visible, including inventories above five.
    const cited = ordered;
    const citations = cited.map(({ row, account }, index) => ({ ...citation(row, account, index, intent.presentation, true),
      ...(intent.balanceMeasures ? { available_minor: Number.isSafeInteger(row.available_minor) ? row.available_minor : null } : {}) }));
    const ledgerAccounts = ordered.map(({ row, account }) => ({
      account_mask: /^\d{1,4}$/.test(account.mask || "") ? account.mask : null,
      balance_group: balanceGroup(account),
      ...(intent.balancePurposeComparison ? { account_kind: account.account_kind || null } : {}),
      current_minor: row.current_minor, as_of: row.as_of_date, last_synced_at: row.last_synced_at || null,
      ...(intent.balanceMeasures ? { available_minor: Number.isSafeInteger(row.available_minor) ? row.available_minor : null } : {}),
    }));
    const plan = await balanceObservationPlan(env, intent, ordered, inventory);
    const cashAccounts = ordered.filter(({ account }) => balanceGroup(account) === 'cash' && account.status === 'open');
    const cashTotal = intent.cashOnlyBalance && cashAccounts.length ? sumMinor(cashAccounts, entry => entry.row.current_minor) : null;
    const headings = { cash: "Cash accounts (recorded balances):", liability: "Liabilities (separate from cash):",
      other: "Other or unknown account types (excluded from cash):" };
    let previousGroup;
    const answer = [...(intent.forecastRequested ? [intent.modelForecast
      ? `I can show your recorded balances, but future balances and payments are unknown.\n${balanceSuggestion}`
      : `I can show your recorded balances, but future balances and payments are unknown.\n${balanceSuggestion}`] : []),
      "Your latest synced balances are below.", ...plan.lines, "Here are your recorded balances, with the date for each account; these do not show live or available cash.\nWant help refreshing the bank connection for a newer balance?",
      ...(intent.cashOnlyBalance ? [cashTotal === null ? 'I can show the balances below, but no checking or savings balance is available to confirm a cash total. Want to review the account types?'
        : `Cash in depository accounts only: ${money(cashTotal)}. Card balances are not netted against this amount.`] : []),
      ...cited.flatMap(({ row, account }, index) => {
      const group = intent.cashOnlyBalance && account.account_kind === 'card' ? 'card' : balanceGroup(account);
      const heading = group !== previousGroup ? [group === 'card' ? 'Card balances (listed separately, not netted):' : headings[group]] : [];
      previousGroup = group;
      return [...heading, `${accountDisplay(account)}${intent.balancePurposeComparison ? ` [recorded kind: ${account.account_kind || "unknown"}]` : ""}: ${money(row.current_minor)} as of ${intent.presentation.date(row.as_of_date)}; ${intent.presentation.updated(row.last_synced_at)} [${index + 1}].`,
        ...(intent.balanceMeasures ? [`${masked(account)} available balance: ${Number.isSafeInteger(row.available_minor) ? money(row.available_minor) : 'unavailable in these records'} [${index + 1}].`] : [])];
    }), ...(ordered.length > cited.length ? [`and ${ordered.length - cited.length} more accounts`] : []),
      ...(intent.balancePurposeComparison ? ["Here is each account by its ending digits and recorded type; personal and business roles are unconfirmed, so no personal account is inferred. Want to review the account types?"] : []),
      ...(intent.unavailableBalance && !intent.balanceMeasures ? [`Current recorded balances are shown; ${intent.unavailableBalance === 'available' ? 'available' : 'pending'} balances are not in these records. Want to check the bank statement?`] : []),
      ...(intent.balanceMeasures ? intent.balanceMeasures.filter(kind => ['statement','ledger','pending'].includes(kind))
        .map(kind => `Here are the current and any recorded available balances. ${kind === 'ledger' ? 'Running account' : kind[0].toUpperCase() + kind.slice(1)} balances are not provided by this feed. Want to check the bank statement?`) : []),
      ...(intent.preferredAccountKind && !ordered.some(entry => entry.account.account_kind === intent.preferredAccountKind)
        ? [`Here are all recorded balances; no account is confirmed as ${intent.preferredAccountKind}. Want to review the account types?`] : [])].join("\n");
    return { answer, citations, ledger: { kind: "balance", accounts: ledgerAccounts, observation: plan.record,
      complete: plan.record.coverage_complete && plan.record.selection_complete,
      ...(intent.balanceSelectionAmbiguous ? { selector_ambiguous: true } : {}),
      ...(intent.answerAddOn === 'freshness' ? { freshness: ledgerAccounts.map(row => ({
        account_mask: row.account_mask, as_of: row.as_of, last_synced_at: row.last_synced_at })) } : {}),
      ...(intent.cashOnlyBalance ? { cash_only: { total_minor: cashTotal, account_masks: cashAccounts.map(({ account }) => /^\d{1,4}$/.test(account.mask || '') ? account.mask : null) } } : {}),
      ...(intent.forecastRequested ? { forecast_supported: false, complete: false } : {}) } };
  }
  if (intent.kind === "transactions") {
    const knownStarts = accounts.map(account => account.covered_from).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day || ""));
    const from = intent.interpretation && intent.from ? intent.from
      : knownStarts.length === accounts.length ? knownStarts.sort().at(-1) : shiftLedgerDay(intent.to, -3659);
    const snapshotAccounts = intent.accountSelector || intent.ownershipScope ? inventory : accounts;
    const observed = await readEffectiveTransactions(env, snapshotAccounts, {
      ...intent, from, mask: intent.accountSelector ? null : intent.mask,
      accountKind: intent.accountSelector ? null : intent.accountKind,
      effectiveAccountSlugs: intent.accountSelector || intent.ownershipScope ? accounts.map(account => account.account_slug) : null,
    });
    const selected = new Set(accounts.map(account => account.account_slug));
    const rows = observed.filter(row => selected.has(row.effective_account_slug) &&
      (!['inflow', 'outflow'].includes(intent.direction) || row.direction === intent.direction));
    if (rows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
    if (rows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
    rows.sort((a, b) => b.posted_on.localeCompare(a.posted_on) || b.id - a.id);
    const listed = rows.slice(0, intent.limit);
    const bySlug = new Map(inventory.map(account => [account.account_slug, account]));
    const citations = listed.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index, intent.presentation));
    const covered = accounts.every(account => effectivePeriodCovered(account, from, intent.to));
    const complete = (intent.interpretation ? true : listed.length === intent.limit) && covered;
    const lines = listed.map((row, index) => {
      const account = bySlug.get(row.effective_account_slug);
      const amount = row.direction === "outflow" ? -row.amount_minor : row.amount_minor;
      return `${intent.presentation.date(row.posted_on)}: ${safeDescription(row.payee || row.description || "Payee unavailable")}, ${money(amount)}, ${accountDisplay(account)} [${index + 1}].`;
    });
    const heading = complete
      ? `Newest ${listed.length} transaction${listed.length === 1 ? "" : "s"}:`
      : `I found ${listed.length} completed transaction${listed.length === 1 ? "" : "s"}; this is a partial list that may not include your latest ${intent.limit} transactions because the saved bank history may be incomplete.\n${balanceSuggestion}`;
    const showing = intent.interpretation ? `\nShowing ${listed.length} of ${rows.length} recorded transactions in ${intent.presentation.period(from, intent.to)}${covered ? '.' : '; some bank days may be missing.'}` : '';
    return { answer: `${heading}${lines.length ? `\n${lines.join("\n")}` : intent.interpretation ? " no readable transactions were found." : ""}${showing}`,
      citations, ledger: { kind: "transactions", requested_limit: intent.requestedLimit, limit: intent.limit,
        complete, partial_reason: complete ? null : "ledger_partial_coverage", from, to: intent.to,
        rows: listed.map((row, index) => ({ n: index + 1, posted_on: row.posted_on,
          payee: safeDescription(row.payee || row.description || "Payee unavailable"), amount_minor: row.amount_minor,
          direction: row.direction, account_label: accountDisplay(bySlug.get(row.effective_account_slug)),
          account_mask: citations[index].account_mask })) } };
  }
  if (accounts.some(a => a.members.some(m => m.coverage_review_required))) return { reason: "coverage_review_required" };
  const requestedAccounts = scope.requested;
  const namedOutflowRequest = intent.kind === "merchant" && intent.direction === "outflow" && Boolean(intent.match);
  const omittedAccounts = scope.omitted;
  const periodCovered = scope.coverage.complete;
  if (['expense_summary', 'largest', 'totals', 'recurring'].includes(intent.kind) || namedOutflowRequest) {
    accounts = scope.covered;
    if (!scope.available) return { reason: "period_outside_coverage" };
  } else if (!periodCovered) return { reason: "period_outside_coverage" };
  // Coverage selection can remove the only eligible account. Never let an
  // uncovered checking account authorize a zero over covered loan activity.
  if (intent.measure && !accounts.some(account => moveKind(account.account_kind))) {
    const covered = new Set(accounts.map(account => account.account_slug));
    const excluded = requestedAccounts.map(account => ({ account_mask: account.mask || null,
      account_kind: account.account_kind, reasons: [
        ...(!covered.has(account.account_slug) ? ['period_outside_coverage'] : []),
        ...(!moveKind(account.account_kind) ? ['account_kind_unsupported'] : []),
      ] }));
    return { answer: 'Money in minus money out is unavailable: no covered checking, savings and card accounts contribute.\n' +
        excluded.map(account => `${masked({ mask: account.account_mask })}: ${account.reasons.map(reason => reason === 'period_outside_coverage'
          ? 'bank history does not include every requested date' : `${account.account_kind} account, left out of this measure`).join('; ')}.`).join('\n'),
      citations: [], ledger: { kind: intent.kind, measure: intent.measure, available: false, complete: false,
        reason: 'unsupported_question', from: intent.from, to: intent.to, net_minor: null,
        accounts: accountCoverage(requestedAccounts), measure_scope: { requested_account_count: requestedAccounts.length,
          contributing_account_count: 0, excluded_accounts: excluded } } };
  }
  if (intent.kind === "merchant" && intent.match && (/\[redacted\]/i.test(intent.match) ||
      normalizeMerchantText(intent.match) === "unknown merchant" || intent.match.length >= 240))
    return { reason: "merchant_selector_unsupported" };
  // Pairing needs the other owned account even when the answer selects one
  // mask/kind. Six padding days prove mutual uniqueness: a counterpart within
  // three days may itself have a competing leg another three days away. Only
  // rows inside the requested window contribute to its income or spend.
  const payment = intent.kind === "payment";
  // A named account selection must recheck the complete authorized inventory
  // atomically, while limiting payment facts to the selected account mappings.
  // Read bounded activity first; exact cents stay local, preserving review evidence.
  const paymentIntent = payment ? { ...intent, amountMinor: null } : intent;
  const paymentRead = intent.accountSelector || intent.ownershipScope ? { ...paymentIntent, mask: null, accountKind: null,
    effectiveAccountSlugs: accounts.map(account => account.account_slug) } : paymentIntent;
  const allRows = await readEffectiveTransactions(env, payment && !intent.accountSelector && !intent.ownershipScope ? accounts : inventory, payment ? paymentRead : {
    from: shiftLedgerDay(intent.from, intent.refundsNotNetted || intent.netRefunds ? -REFUND_MATCH_DAYS : -6), to: shiftLedgerDay(intent.to, 6),
  });
  const inWindow = row => row.posted_on >= intent.from && row.posted_on <= intent.to;
  const selected = new Set(accounts.map(a => a.account_slug));
  const windowRows = allRows.filter(row => selected.has(row.effective_account_slug) && (!row.posted_on || inWindow(row)));
  if (windowRows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
  if (windowRows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
  const bySlug = new Map(inventory.map(a => [a.account_slug, a]));
  // Identity belongs to the authorized unfiltered window. A partition may
  // empty a known selection, but cannot authorize a different payee or category.
  const identityRows = windowRows;
  // Bare channel text nominates a possible repayment; it cannot prove an
  // exclusion or certify the remaining ordinary total. Every broad component
  // shares this refusal, including single-period and composite readers.
  const untypedPayments = identityRows.filter(row =>
    isOwnedMovementChannel(row.description, { liabilityOnly: true }) &&
    (!row.payee || normalizeLedgerText(row.payee) === normalizeLedgerText(row.description)) &&
    !categoryFor(row) && !loanCardPaymentKind(row, bySlug));
  let componentRefusal = null;
  if (untypedPayments.length && ['expense_summary', 'totals'].includes(intent.kind)) {
    componentRefusal = { rows: untypedPayments, reason: 'payment_membership_unconfirmed', accountComponents: true,
      message: 'This component is withheld because a possible payment or transfer has no confirmed payment code or owned-account endpoint. Confirm the payment classification before using a spending or income total.' };
  }
  // A recognized movement channel naming an unresolved account is a possible own
  // movement. Missing ownership cannot promote either leg to certified money.
  const movementCandidates = identityRows.filter(row =>
    isOwnedMovementChannel(row.payee) &&
    transferEndpoints(row.description)?.form === 'unary' &&
    !loanCardPaymentAccount(row, bySlug) &&
    (isOwnedMovementChannel(row.payee, { cardOnly: true }) || !possibleOwnedMovement(row, bySlug)?.counterpart) &&
    !ordinaryMoneyMembership([row], [], bySlug).excluded.has(row.id));
  // Card channels retain the existing conservative refusal. Other recognized
  // channels need an exact endpoint in the disclosure-only uncertain inventory;
  // an outside or ambiguous locator alone cannot invent unresolved ownership.
  const uncertainMovementAccounts = movementCandidates.some(row => !isOwnedMovementChannel(row.payee, { cardOnly: true }))
    ? await readUncertainScopeAccounts(env) : [];
  const unresolvedCardMovements = movementCandidates.filter(row => isOwnedMovementChannel(row.payee, { cardOnly: true }) ||
    uncertainOwnedMovementEndpoint(row, uncertainMovementAccounts));
  if (unresolvedCardMovements.length && ['expense_summary', 'totals', 'largest', 'category'].includes(intent.kind)) {
    componentRefusal = { rows: unresolvedCardMovements, reason: 'owned_movement_unconfirmed', accountComponents: false,
      message: 'A possible own-account movement or payment names an account whose ownership or payment role is unconfirmed. This component is withheld; confirm both accounts before using a spending or income total.' };
  }
  const vendorSelection = intent.kind === 'merchant' && intent.direction === 'outflow' && intent.match
    ? { ...selectVendorFamily(identityRows, intent.match, { allowProductFamily: !intent.protectedPayee }),
      directionRows: identityRows.filter(row => row.direction === intent.direction) } : null;
  const recordIdentityEvidence = identityRows => {
    if (!evidence) return;
    evidence.accounts = accounts;
    // A different structured payer stays foreign. Anonymous candidates must
    // share the payment's amount and direction, even beside an exact receipt.
    const paymentRows = intent.kind === 'payment' ? identityRows.filter(row =>
      (!Number.isSafeInteger(intent.amountMinor) || row.amount_minor === intent.amountMinor) &&
      (intent.direction === 'both' || row.direction === (intent.direction || 'inflow'))) : [];
    const selection = intent.kind === 'recurring'
      ? { matched: identityRows.filter(row => normalizeMerchantText(row.payee) === normalizeMerchantText(evidence.selector)),
        possible: identityRows.filter(row => merchantMatchBasis(row, evidence.selector) === 'possible') }
      : intent.kind === 'payment' ? { matched: paymentRows.filter(row => matchesSender(row, intent.counterpartyWords)),
        possible: paymentRows.filter(row => !row.payee && merchantMatchBasis(row, evidence.selector) === 'possible') }
      // Inflow readers retain the sealed sender grammar. A parsed sender can
      // support an attributed subtotal without a structured payee field.
      : intent.direction === 'inflow' ? {
        matched: identityRows.filter(row => row.direction === 'inflow' && matchesMerchant(row, evidence.selector)),
        possible: identityRows.filter(row => row.direction === 'inflow' && merchantMatchBasis(row, evidence.selector) === 'possible'),
      }
      : selectVendorFamily(identityRows, evidence.selector, { allowProductFamily: !intent.protectedPayee });
    evidence.allowed = new Set(selection.matched.map(row => `ledger:transaction:${row.id}`));
    evidence.possibleIdentity = new Set((selection.possibleIdentity || []).map(row => `ledger:transaction:${row.id}`));
    const amountCandidates = intent.kind === 'payment' && intent.direction !== 'outflow' && Number.isSafeInteger(intent.amountMinor)
      ? paymentRows.filter(row => row.direction === 'inflow' && (!selection.matched.length || !row.payee)) : [];
    evidence.possibleRows = [...selection.possible, ...amountCandidates].filter(row => !selection.matched.includes(row))
      .map(row => ({ ref: `ledger:transaction:${row.id}`, posted_on: row.posted_on }));
    evidence.possible = new Set(evidence.possibleRows.map(row => row.ref));
  };
  recordIdentityEvidence(identityRows);
  // A feed category is evidence; an arbitrary merchant-looking word is not.
  // This model-only path never replaces an exact payee with a guessed category.
  if (intent.interpretation && intent.direction === 'outflow' && ['merchant', 'category'].includes(intent.kind) && intent.match) {
    const wanted = normalizeMerchantText(intent.match);
    const exactPayee = vendorSelection && (vendorSelection.matched.length > 0 || vendorSelection.possible.length > 0);
    const categoryMatch = identityRows.some(row => (row.direction === 'outflow' ||
      intent.refundsNotNetted && row.direction === 'inflow') &&
      !loanCardPaymentKind(row, bySlug) && categoryFor(row) === wanted);
    const categoryWord = /^(?:supplies|software|materials|repairs|everyday running costs)$/.test(wanted);
    if (intent.kind === 'category' || (!exactPayee && (categoryMatch || categoryWord))) {
      // This defined bucket has known membership even without bank categories.
      // Keep it on the category reader, where its rows can be measured directly.
      if (isUncategorizedBucket(intent.match)) intent.kind = 'category';
      else {
        intent.categorySelector = intent.match;
        intent.categorySelectorResolved = categoryMatch;
      }
    }
  }
  const categorySelector = intent.categorySelector ||
    (intent.kind === 'category' || intent.kind === 'largest' && intent.matchType === 'category' ? intent.match : null);
  const categoryResolution = categorySelector && !isUncategorizedBucket(categorySelector) ? {
    selector: categorySelector,
    names: [...new Set(identityRows.filter(row => categoryFor(row)).map(row => row.category))].sort(),
    resolved: identityRows.some(row => categoryFor(row) === normalizeLedgerText(categorySelector)),
  } : null;
  const keywordSelector = intent.descriptionKeyword || (intent.interpretation && intent.direction === 'inflow' &&
    /^(?:refunds?|reimbursements?)$/i.test(intent.match || ''));
  const selectorText = intent.recurringSelector || (!keywordSelector && !intent.categorySelector &&
    ['merchant', 'largest', 'deposits'].includes(intent.kind) && intent.matchType !== 'category' ? intent.match : null);
  const selectorRows = identityRows;
  const exactRows = selectorText ? selectorRows.filter(row => intent.kind === 'recurring'
    ? normalizeMerchantText(row.payee) === normalizeMerchantText(intent.recurringSelector)
    : merchantMatchBasis(row, selectorText) === 'exact') : [];
  const namedSelection = selectorText ? {
    resolved: vendorSelection ? vendorSelection.matched.length > 0 : exactRows.length > 0,
    matched: vendorSelection ? vendorSelection.matched : exactRows,
    possible: vendorSelection ? vendorSelection.possible : selectorRows.filter(row =>
      !exactRows.includes(row) && merchantMatchBasis(row, selectorText) === 'possible'),
  } : null;
  // Compare literal conjunction spellings over the identity snapshot. Exact
  // description text is possible attribution, not a different and/& spelling.
  const conjunction = text => text.replace(/\b(and)\b|&/g, 'and');
  const wantedMerchant = normalizeMerchantText(intent.match);
  const merchantSelectorAmbiguous = intent.kind === 'merchant' && intent.match && !namedSelection?.resolved &&
    !identityRows.some(row => matchesMerchant(row, intent.match)) && identityRows.some(row => {
      const merchant = merchantFor(row);
      if (intent.direction === "inflow" && payerAttributionBasis(row) === "unconfirmed") return false;
      return merchant !== wantedMerchant && conjunction(merchant) === conjunction(wantedMerchant);
    });
  const recurringSelectorResolved = intent.kind === 'recurring' && Boolean(namedSelection?.resolved);
  const selectionCandidates = namedSelection && (intent.kind === 'recurring' && namedSelection.resolved
    ? namedSelection.matched : [...namedSelection.matched, ...namedSelection.possible]);
  const selectedRowIds = namedSelection ? new Set(selectionCandidates.map(row => row.id)) : null;
  // Recurrence consumes only its named candidates. Other readers retain the
  // full pool for absence checks and existing contextual account totals; their
  // named membership below uses the identity resolved above.
  const rows = intent.kind === 'recurring' && namedSelection
    ? windowRows.filter(row => selectedRowIds.has(row.id)) : windowRows;
  const paymentReader = ['expense_summary', 'totals', 'category', 'merchant', 'recurring', 'largest', 'deposits'].includes(intent.kind);
  // Spending exclusions must not remove raw debit lines from an inflow-only
  // activity view. A totals view with spending still needs the same guard.
  const spendingReader = paymentReader && (intent.kind === 'totals' ? !intent.inflowOnly : intent.kind !== 'deposits' && intent.direction !== 'inflow');
  const movementPairs = pairOwnTransfers(allRows, bySlug, { directedEvidence: true }).pairs.filter(pair =>
    [pair.out, pair.in].every(row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
      effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on)));
  const movementMembership = ordinaryMoneyMembership(rows, movementPairs, bySlug);
  const nominatedMovements = spendingReader ? rows.filter(row => !movementMembership.excluded.has(row.id))
    .map(row => ({ row, candidate: possibleUnconnectedPayment(row, bySlug) }))
    .filter(item => item.candidate)
    .filter(({ row }) => !namedSelection || selectedRowIds.has(row.id)) : [];
  // The measure word decides the figure. Money out ("went out", and the
  // money-out side of the money in/out totals) is every completed outflow
  // minus PROVEN own movements; spending words keep the 0.4.27 partition
  // below unchanged. Bank text or a bank payment code without a proven owned
  // destination is never a proven own movement. The totals view keeps its
  // labeled possible-transfer basis, so only repayments are decided there.
  const moneyOut = intent.outflowMeasure === true && intent.kind === 'expense_summary';
  const totalsMoneyOut = intent.kind === 'totals' && !intent.inflowOnly;
  // An owner-confirmed expense category vetoes an own-account exclusion: the
  // row stays spending, and its conflicting bank text withholds certification.
  // Money out never removes a possible movement, so the veto has nothing to
  // decide there; the row keeps the money-out destination rule below. Loan
  // and card candidates keep their own category hold.
  const ownMovementConflict = item => item.candidate.kind === 'own_account' && Boolean(item.candidate.categoryConflict);
  const movementConflicts = moneyOut || totalsMoneyOut ? [] : nominatedMovements.filter(ownMovementConflict);
  const ambiguousMovements = nominatedMovements.filter(item => item.candidate.identityAmbiguous);
  const unresolvedIdentities = ambiguousMovements.filter(item => !item.candidate.categoryConflict);
  const identityRefusal = !moneyOut && !totalsMoneyOut && unresolvedIdentities.length ? {
    rows: unresolvedIdentities.map(({ row }) => row), reason: 'own_movement_identity_unconfirmed',
    message: 'Spending is withheld because a transfer destination could name an outside party or your own account. No posting has been excluded as an own movement. Confirm the destination before using a spending total.' } : null;
  const possiblePayments = nominatedMovements.filter(item => !movementConflicts.includes(item) && !ambiguousMovements.includes(item));
  // Loan and own-account candidates share the mixed-component refusal below.
  const mixedLoanPayments = possiblePayments.filter(item => item.candidate.mixed);
  const paymentCategoryConflicts = possiblePayments.filter(item => item.candidate.categoryConflict);
  const moneyOutReading = moneyOut || totalsMoneyOut
    ? moneyOutDestinations({ rows, allRows,
      // Unresolved identity cannot exclude spending, but its wire/transfer
      // still needs the same counterpart check. Do not invent an owned role.
      // Owned locator collisions retain the existing possible-payment receipt;
      // that nomination certifies neither a destination nor an endpoint.
      possiblePayments: [...possiblePayments, ...ambiguousMovements.map(({ row, candidate }) => ({ row,
        candidate: { kind: candidate.ownedLocatorAmbiguous ? 'own_account' : 'transfer' } }))],
      bySlug, transfers: true, movementMembership }) : null;
  const possiblePaymentIdsInScope = new Set(moneyOut || totalsMoneyOut ? [] : possiblePayments.map(({ row }) => row.id));
  const moneyOutCandidateIds = new Set((moneyOutReading?.candidates || []).map(({ row }) => row.id));
  // An unproven repayment or transfer that a connected account could have
  // received is neither provably money out nor provably an own movement:
  // counting it could double the purchases it settles. Withhold, never guess.
  // A possible own-account movement has no unproved leg removed under this
  // rule, so money in minus money out never drops one leg of a movement.
  const moneyOutRefusal = moneyOutReading?.unconfirmed.length && !mixedLoanPayments.length ? {
    rows: moneyOutReading.unconfirmed.map(({ row }) => row), reason: 'money_out_destination_unconfirmed', accountComponents: false,
    message: 'Money out is withheld because a possible payment or transfer could have gone to one of your own connected accounts, ' +
      'where its amount may already be counted. Confirm where it went before using a money-out total.' } : null;
  const excludedPayments = new Map();
  if (paymentReader) for (const row of rows) {
    if (possiblePaymentIdsInScope.has(row.id) || moneyOutCandidateIds.has(row.id) ||
        totalsMoneyOut && movementMembership.possible.has(row.id)) continue;
    if (intent.kind === 'expense_summary' && row.direction !== (intent.direction || 'outflow') &&
        !(intent.netRefunds && row.direction === 'inflow' && matchesDescriptionKeyword(row, 'refund'))) continue;
    // Partitioning the receiving payment must not erase reciprocal proof for
    // its outgoing leg. The full snapshot established this pair before either
    // posting left the category, spending or income reader.
    const liabilityKind = loanCardPaymentKind(row, bySlug) || movementMembership.excluded.get(row.id)?.liabilityKind;
    if (liabilityKind) excludedPayments.set(row.id, { row, liabilityKind });
  }
  // Rankings remove payments from every alternate list and total below.
  // Other readers partition before cadence detection can hide a payment.
  // All of them receive the same cited posting disclosure after reading.
  const excludePayments = paymentReader && intent.kind !== "expense_summary" && !(intent.kind === "largest" && intent.direction === "outflow");
  // Recorded inflow needs the unpartitioned snapshot, including receiving
  // repayment legs. Its ordinary alternate and the shared payment disclosure
  // still exclude those postings from spending and income.
  const partitionPayments = excludePayments && !(intent.kind === 'totals' && intent.inflowOnly);
  // Recurring detection needs uncertain postings to retain their series and amounts.
  const recurringOwnMovementIds = new Set(intent.kind === 'recurring'
    ? possiblePayments.filter(({ candidate }) => candidate.kind === 'own_account').map(({ row }) => row.id) : []);
  const result = await ledgerActivityAnswer({ env, intent, accounts, inventory, requestedAccounts, omittedAccounts, periodCovered, onRefundCandidates,
    allRows, rows: rows.filter(row => (!possiblePaymentIdsInScope.has(row.id) || recurringOwnMovementIds.has(row.id)) && (!partitionPayments || !excludedPayments.has(row.id))),
    bySlug, selected, inWindow, paymentRead, recordIdentityEvidence, recurringSelectorResolved, namedSelection, vendorSelection, merchantSelectorAmbiguous, categoryResolution,
    componentRefusal: componentRefusal || identityRefusal || moneyOutRefusal, excludedPayments: partitionPayments ? excludedPayments : new Map(),
    retainedPaymentIds: moneyOut ? moneyOutCandidateIds : null,
    // Possible own-account movements are disclosed on their own lines in every
    // reader. Only a reader that removed them says so in its basis line.
    possibleMovementIds: new Set(possiblePayments.filter(item => possiblePaymentIdsInScope.has(item.row.id) || item.candidate.destination).map(({ row }) => row.id)),
    ownMovementCandidates: possiblePayments.some(item => item.candidate.destination && possiblePaymentIdsInScope.has(item.row.id)) });
  if (result.ledger && intent.kind === 'totals' && !intent.inflowOnly) {
    const candidates = rows.filter(row => row.direction === 'inflow' && movementMembership.possible.has(row.id));
    if (candidates.length) {
      result.ledger.possible_owned_credits = candidates.map(row => ({ amount_minor: row.amount_minor, posted_on: row.posted_on,
        account_mask: bySlug.get(row.effective_account_slug)?.mask || null, included_in_total: !result.ledger.reason }));
      result.answer += '\nPossible moves from your own accounts, retained in money in and net (counterpart unproved):\n' + candidates.map(row => {
        const refs = result.citations || (result.citations = []);
        let ref = refs.find(ref => ref.ref === 'ledger:transaction:' + row.id);
        if (!ref) { ref = citation(row, bySlug.get(row.effective_account_slug), refs.length + (intent.citationOffset || 0), intent.presentation); refs.push(ref); }
        return `${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)} ${masked(bySlug.get(row.effective_account_slug))} [${ref.n}].`;
      }).join('\n');
    }
  }
  // Resolve certification after rendering evidence. An unknown word cannot
  // erase unclassified rows, uncertain ranking evidence, or payment reasons.
  if (categoryResolution && !categoryResolution.resolved) {
    if (!result.ledger) return result;
    const { selector, names: categories } = categoryResolution;
    const notice = `The category word '${safeDescription(selector)}' was not recognized. No category figure is confirmed.\n` +
      (categories.length ? `Your categories by exact name: ${categories.map(safeDescription).join('; ')}.`
        : 'There are no confirmed category names in these records. Please confirm a category first.');
    const selectorEvidence = { selector_unresolved: true, category_selector: selector,
      known_categories: categories.map(safeDescription) };
    if (result.ledger?.category_total_unconfirmed || result.ledger?.category_ranking_unconfirmed || result.ledger?.reason) {
      result.answer = notice + '\n' + result.answer;
      Object.assign(result.ledger, selectorEvidence);
      if (Object.hasOwn(result.ledger, 'confirmed_category_subtotal_minor')) result.ledger.confirmed_category_subtotal_minor = null;
    } else {
      result.answer = notice + `\nAccounts: ${accounts.map(masked).join(', ')}; ${intent.presentation.period(intent.from, intent.to)}; ${accounts.map(account => `${masked(account)}: covered through ${intent.presentation.date(account.covered_to)}`).join('; ')}.`;
      result.citations = [];
      result.ledger = { kind: 'category', from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        ...selectorEvidence, total_minor: null, lead_total_minor: null, expense_total_minor: null, found: null, complete: false };
    }
  }
  if (result.ledger && moneyOutReading?.candidates.length && !mixedLoanPayments.length) {
    // Post-condition: a line may say "included above" only for a posting the
    // stated money-out figure counted, i.e. one its reader cited as an operand.
    // A withheld or refused answer states no figure and includes nothing.
    const refs = result.citations || (result.citations = []);
    const figureStated = moneyOut ? Number.isSafeInteger(result.ledger.expense_total_minor)
      : !result.ledger.reason && Array.isArray(result.ledger.lead_accounts) &&
        result.ledger.lead_accounts.every(account => Number.isSafeInteger(account.debits_minor));
    const operands = new Set(figureStated ? refs.map(ref => ref.ref) : []);
    const lines = [];
    const records = moneyOutReading.candidates.map(({ row, kind, basis, counterparts, destination }) => {
      let ref = refs.find(c => c.ref === `ledger:transaction:${row.id}`);
      if (!ref) { ref = citation(row, bySlug.get(row.effective_account_slug), refs.length + (intent.citationOffset || 0), intent.presentation); refs.push(ref); }
      const included = operands.has(`ledger:transaction:${row.id}`) && !counterparts.length;
      const bankText = safeDescription(row.description);
      // A possible own-account movement names its destination role, never
      // its internal kind ("a own_account payment").
      const transfer = kind === 'transfer' || kind === 'own_account';
      const what = destination ? `a transfer to your own ${destination}` : transfer ? 'a transfer' : `a ${kind} payment${basis === 'bank_code' ? ' (bank payment code)' : ''}`;
      const label = included ? `included ${moneyOut ? 'above' : 'in money out above'}, possibly ${what} (counterpart not proved)`
        : counterparts.length ? `not counted, money out withheld: possibly ${what} ${destination ? 'at' : 'to'} a connected account (${accountEndings(counterparts)})`
          : `possible ${destination ? `transfer to your own ${destination}` : transfer ? 'transfer' : `${kind} payment`}, not counted`;
      lines.push(`${label}: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, bank text quoted: "${bankText}" [${ref.n}].`);
      return { n: ref.n, payment_kind: kind, amount_minor: row.amount_minor, posted_on: row.posted_on,
        account_mask: ref.account_mask, bank_text: bankText, mixed_components: false, basis, label,
        ...(destination ? { destination } : {}),
        ...(included ? { included_in_total: true } : {}),
        ...(counterparts.length ? { destination_unconfirmed: true,
          connected_counterpart_masks: counterparts.map(account => /^\d{1,4}$/.test(account.mask || '') ? account.mask : null) } : {}) };
    });
    result.ledger.possible_payments = records.filter(record => record.payment_kind !== 'transfer');
    const transfers = records.filter(record => record.payment_kind === 'transfer');
    if (transfers.length) result.ledger.possible_transfers = transfers;
    result.ledger.possible_payments_included_minor = sumMinor(records.filter(record => record.included_in_total), record => record.amount_minor);
    result.answer += `\n${lines.join('\n')}`;
  } else if (result.ledger && possiblePayments.length) {
    const categoryConflict = paymentCategoryConflicts.length > 0 && !result.ledger.reason;
    if (mixedLoanPayments.length || categoryConflict) {
      const loanMixed = mixedLoanPayments.some(item => item.candidate.kind === 'loan');
      const reason = !mixedLoanPayments.length ? 'payment_expense_category_conflict'
        : loanMixed ? 'loan_payment_mixed_components' : 'own_movement_mixed_components';
      result.answer = !mixedLoanPayments.length
        ? 'Spending is withheld because the bank payment text conflicts with a confirmed category. Review the payment classification before using a spending total.'
        : loanMixed ? 'Spending is withheld because a loan payment mixes repayment and charges. No components have been split.'
        : 'Spending is withheld because a possible transfer to your own account also names a fee, charge or second amount. No components have been split.';
      result.citations = [];
      result.ledger = { kind: intent.kind, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        total_minor: null, expense_total_minor: null, lead_total_minor: null, monthly_total_minor: null,
        complete: false, reason };
    }
    const refs = result.citations || (result.citations = []);
    result.ledger.possible_payments = possiblePayments.map(({ row, candidate }) => {
      let ref = refs.find(c => c.ref === `ledger:transaction:${row.id}`);
      if (!ref) { ref = citation(row, bySlug.get(row.effective_account_slug), refs.length + (intent.citationOffset || 0), intent.presentation); refs.push(ref); }
      const bankText = safeDescription(row.description);
      result.answer += candidate.destination
        ? `\npossible transfer to your own ${candidate.destination}, not counted as spending: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, bank text quoted: "${bankText}" [${ref.n}].`
        : `\npossible ${candidate.kind} payment, not counted as spending: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, bank text quoted: "${bankText}" [${ref.n}].`;
      return { n: ref.n, payment_kind: candidate.kind, amount_minor: row.amount_minor, posted_on: row.posted_on,
        account_mask: ref.account_mask, bank_text: bankText, mixed_components: candidate.mixed,
        ...(candidate.destination ? { destination: candidate.destination } : {}) };
    });
  }
  if (result.ledger && movementConflicts.length) {
    // The owner's category keeps the row in every figure above. Its bank text
    // names an own-account destination, so no figure here is certified.
    const refs = result.citations || (result.citations = []);
    result.ledger.complete = false;
    if (!result.ledger.reason) result.ledger.reason = 'own_movement_category_conflict';
    result.answer = result.answer.replace(/^You spent /, 'Spending I could check: ');
    result.ledger.own_movement_conflicts = movementConflicts.map(({ row, candidate }) => {
      let ref = refs.find(c => c.ref === `ledger:transaction:${row.id}`);
      if (!ref) { ref = citation(row, bySlug.get(row.effective_account_slug), refs.length + (intent.citationOffset || 0), intent.presentation); refs.push(ref); }
      const bankText = safeDescription(row.description);
      const conflict = candidate.identityAmbiguous ? 'a transfer with an unconfirmed destination' : `a possible transfer to your own ${candidate.destination}`;
      result.answer += `\ncounted as spending because you confirmed its category as ${safeDescription(row.category)}, but the bank text names ${conflict}, so this figure is not certified: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, bank text quoted: "${bankText}" [${ref.n}].`;
      return { n: ref.n, amount_minor: row.amount_minor, posted_on: row.posted_on, account_mask: ref.account_mask,
        bank_text: bankText, ...(candidate.destination ? { destination: candidate.destination } : {}),
        ...(candidate.identityAmbiguous ? { identity_unconfirmed: true } : {}), category: safeDescription(row.category) };
    });
  }
  const withExplicitGrossActivity = () => {
    if (!result.ledger) return result;
    // An explicit gross alternate preserves posted activity without naming
    // repayments spending or liability receipts income. Cite every raw leg.
    if (intent.kind === 'totals' && intent.measure && intent.ownTransfers === 'include') {
      const citations = result.citations || (result.citations = []);
      const raw = rows.filter(row => moveKind(bySlug.get(row.effective_account_slug)?.account_kind));
      const refs = raw.map(row => {
        let ref = citations.find(item => item.ref === `ledger:transaction:${row.id}`);
        if (!ref) {
          ref = citation(row, bySlug.get(row.effective_account_slug), citations.length + (intent.citationOffset || 0), intent.presentation);
          citations.push(ref);
        }
        return ref.n;
      });
      const credits = sumMinor(raw.filter(row => row.direction === 'inflow'), row => row.amount_minor);
      const debits = sumMinor(raw.filter(row => row.direction === 'outflow'), row => row.amount_minor);
      result.ledger.gross_activity = { credits_minor: credits, debits_minor: debits,
        net_minor: credits - debits, transaction_count: raw.length, citations: refs };
      result.answer += `\nGross posted activity (including transfers and repayments; not spending or income): money in ${money(credits)}; money out ${money(debits)}; difference ${money(credits - debits)} ${refs.map(n => `[${n}]`).join(' ')}.`;
    }
    return result;
  };
  if (!result.ledger || !excludedPayments.size) return withExplicitGrossActivity();
  const familyPaymentIds = namedSelection ? selectedRowIds : null;
  // S6's similar structured payees remain advisory. Their excluded payments
  // retain the same uncertainty as description-only named candidates.
  const possiblePaymentIds = new Set([
    ...(namedSelection?.possible || []), ...(vendorSelection?.family || []),
  ].map(row => row.id));
  const descriptionKeyword = result.ledger.description_keyword || intent.descriptionKeyword;
  const paymentPostings = [...excludedPayments.values()].filter(({ row }) =>
    // Category exclusion totals retain S7's whole scoped payment pool. A
    // payment has no ordinary spending category to narrow by after exclusion.
    (intent.kind === 'category' || intent.categorySelector) && !descriptionKeyword || intent.kind === 'largest' && !namedSelection ||
    (descriptionKeyword ? row.direction === intent.direction && matchesDescriptionKeyword(row, descriptionKeyword) : !intent.match ||
      (familyPaymentIds ? familyPaymentIds.has(row.id)
      : ['merchant', 'largest'].includes(intent.kind) ? matchesMerchant(row, intent.match)
      : intent.kind === 'category' ? matchesCategory(row, intent.match) || !categoryFor(row) : true)));
  // Competition is decided over the full observed pool before eligibility or
  // selector filtering. A missing competitor would invent a unique payment.
  // Reuse the mutual pairing contract, including its three-day window.
  const pairedIncoming = new Set();
  const paymentById = new Map(paymentPostings.map(item => [item.row.id, item]));
  for (const pair of pairOwnTransfers(allRows, bySlug, { directedEvidence: true }).pairs) {
    const outgoing = paymentById.get(pair.out.id), incoming = paymentById.get(pair.in.id);
    if (!outgoing || !incoming || outgoing.liabilityKind !== incoming.liabilityKind ||
        Math.abs(Date.parse(pair.out.posted_on) - Date.parse(pair.in.posted_on)) > 3 * 86400000 ||
        ![pair.out, pair.in].every(row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
          effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on)) ||
        !isDirectedOwnedTransfer(pair, bySlug) || /^payment thank you$/i.test(pair.in.description || '')) continue;
    pairedIncoming.add(pair.in.id);
  }
  const pairingUncertain = paymentPostings.some(({ row }) => row.direction === 'inflow' && !pairedIncoming.has(row.id) &&
    allRows.some(out => out.direction === 'outflow' && out.amount_minor === row.amount_minor && out.currency === row.currency &&
      Math.abs(Date.parse(out.posted_on) - Date.parse(row.posted_on)) <= 3 * 86400000 && isDirectedOwnedTransfer({ out, in: row }, bySlug)));
  const payments = paymentPostings.filter(item => !pairedIncoming.has(item.row.id));
  if (!payments.length) return withExplicitGrossActivity();
  const namedPaymentOnly = namedSelection?.resolved && namedSelection.matched.every(row => excludedPayments.has(row.id));
  const totalMinor = sumMinor(payments, item => item.row.amount_minor);
  const citations = result.citations || (result.citations = []);
  const paymentRows = payments.map(({ row, liabilityKind }) => {
    // Gross inflow already cites these raw postings. Reuse their identities
    // rather than attaching a second receipt for the same payment leg.
    let ref = citations.find(item => item.ref === `ledger:transaction:${row.id}`);
    if (!ref) {
      ref = citation(row, bySlug.get(row.effective_account_slug), citations.length + (intent.citationOffset || 0), intent.presentation);
      citations.push(ref);
    }
    const destination = loanCardPaymentAccount(row, bySlug);
    return { n: ref.n, posted_on: row.posted_on, amount_minor: row.amount_minor, direction: row.direction, payment_kind: liabilityKind,
      account_mask: ref.account_mask,
      ...(liabilityKind === 'loan' && /^\d{1,4}$/.test(destination?.mask || '') ? { own_loan_mask: destination.mask } : {}),
      ...(possiblePaymentIds.has(row.id) ? { match_basis: 'possible' } : {}),
      ...(pairingUncertain ? { pairing_uncertain: true } : {}) };
  });
  result.ledger.payment_exclusions = { total_minor: totalMinor, count: payments.length,
    card_minor: sumMinor(payments.filter(item => item.liabilityKind === 'card'), item => item.row.amount_minor),
    loan_minor: sumMinor(payments.filter(item => item.liabilityKind === 'loan'), item => item.row.amount_minor), rows: paymentRows };
  // Readers partition payments before grouping or cadence detection. Keep the existing
  // owner summary on that same partition, alongside the new cited disclosure.
  if (['recurring', 'category'].includes(result.ledger.kind) || intent.categorySelector) {
    // The legacy spending field counts outgoing postings; the new disclosure
    // also preserves receiving liability legs without calling them income.
    const outgoing = payments.filter(item => item.row.direction === 'outflow');
    result.ledger.own_account_payments = { total_minor: sumMinor(outgoing, item => item.row.amount_minor),
      count: outgoing.length,
      card_minor: sumMinor(outgoing.filter(item => item.liabilityKind === 'card'), item => item.row.amount_minor),
      loan_minor: sumMinor(outgoing.filter(item => item.liabilityKind === 'loan'), item => item.row.amount_minor) };
  }
  const paymentDisclosure = `\n${paymentExclusionLines(result.ledger.payment_exclusions, intent.presentation, { omitTotal: namedPaymentOnly })}`;
  if (namedPaymentOnly) {
    const identified = payments.filter(({ row }) => namedSelection.matched.some(match => match.id === row.id));
    const kinds = [...new Set(identified.map(item => item.liabilityKind))];
    const kind = kinds.length === 1 ? kinds[0] : 'loan/card';
    result.ledger.selector_applied = true;
    // The itemized postings carry the amounts and dates. The identity heading
    // must not repeat a single payment as additional monetary figures.
    result.answer = `${safeDescription(selectorText)}: excluded ${kind} payments, listed separately.\n${result.answer}`;
  }
  if (result.ledger.kind === 'expense_summary' && result.answer.includes('\nEvidence:'))
    result.answer = result.answer.replace('\nEvidence:', `${paymentDisclosure}\nEvidence:`);
  else result.answer += paymentDisclosure;
  return withExplicitGrossActivity();
}

async function ledgerActivityAnswer({ env, intent, accounts, inventory, requestedAccounts, omittedAccounts, periodCovered, onRefundCandidates,
  allRows, rows, bySlug, selected, inWindow, paymentRead, recordIdentityEvidence, recurringSelectorResolved, namedSelection, vendorSelection, merchantSelectorAmbiguous, categoryResolution, componentRefusal, excludedPayments, retainedPaymentIds = null, possibleMovementIds = new Set(), ownMovementCandidates = false }) {
  if (intent.recurringSelector && !recurringSelectorResolved) {
    return { answer: `No exact payee matched "${safeDescription(intent.recurringSelector)}", so no named recurring amount is confirmed. Please choose a precise payee selector.`,
      citations: [], ledger: { kind: 'recurring', from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        selector_applied: false, selector_unresolved: true, recurring: [], monthly_total_minor: null, total_minor: null,
        complete: false, found: null } };
  }
  let inflows = rows.filter(row => row.direction === "inflow");
  const payerIncome = intent.kind === "merchant" && intent.direction === "inflow" && Boolean(intent.match);
  const incompleteNamed = payerIncome && inflows.length > 0;
  // Coverage proves the bank window, never the completeness of a payer label.
  // Keep the sealed positive matcher; only an entirely empty inflow window
  // can establish absence. Amount filters cannot establish payer absence.
  const inflowDetail = cite => {
    const listed = [...inflows].sort((a, b) => b.posted_on.localeCompare(a.posted_on) || a.id - b.id).slice(0, 10);
    const deposits = listed.map(row => {
      const ref = cite(row);
      return { n: ref.n, posted_on: row.posted_on, amount_minor: row.amount_minor, account_mask: ref.account_mask };
    });
    return { deposits, answer: `Deposits in these accounts (showing ${listed.length} of ${inflows.length}):\n${deposits.map(row =>
      `${intent.presentation.date(row.posted_on)}: ${money(row.amount_minor)} in ${masked({ mask: row.account_mask })} [${row.n}].`).join("\n")}` };
  };
  if (intent.kind === "payment") {
    const searchDirection = intent.direction || 'inflow';
    const paymentLabel = searchDirection === 'inflow' ? 'deposit' : 'transaction';
    const directionLabel = searchDirection === 'inflow' ? '' : `\nExact-amount lookup searched ${searchDirection === 'both' ? 'completed transactions in both directions' : 'completed outflow transactions'}.`;
    const nearWindow = intent.nearDate
      ? `\nLookup window: ${intent.presentation.period(intent.from, intent.to)}, inclusive (plus or minus 7 days around ${intent.presentation.date(intent.nearDate)}).` : "";
    const exactMatches = pool => pool.filter(row => {
      if ((searchDirection !== 'both' && row.direction !== searchDirection) || (intent.amountMinor !== null && row.amount_minor !== intent.amountMinor)) return false;
      // An amount narrows an attributed receipt; it cannot promote a memo
      // subject to sender or override a different explicit payee.
      return matchesSender(row, intent.counterpartyWords);
    });
    const possibleMatches = pool => pool.filter(row => row.amount_minor === intent.amountMinor &&
      (searchDirection === 'both' || row.direction === searchDirection) &&
      (searchDirection === 'inflow' || !row.payee && merchantMatchBasis(row, intent.counterpartyWords.join(' ')) === 'possible'));
    // Compare candidate identity and receipt facts, not unrelated amounts or
    // database ordering. The second snapshot supplies both facts and evidence.
    const candidateSnapshot = pool => JSON.stringify([...new Set([...exactMatches(pool), ...possibleMatches(pool)]
      .map(row => JSON.stringify([row.id, row.effective_account_slug, row.posted_on, row.amount_minor,
        row.direction, row.payee, row.description])))].sort());
    let matched = exactMatches(rows), snapshotChanged = false;
    // The first read preserves the base positive path. Before claiming an
    // empty lookup, re-read the authorized window without an amount predicate.
    // The reader revalidates account mappings before any absence is rendered.
    if (!matched.length && intent.counterpartyWords.length && intent.amountMinor !== null) {
      const windowRows = await readEffectiveTransactions(env, intent.accountSelector || intent.ownershipScope ? inventory : accounts, { ...paymentRead, amountMinor: null });
      if (windowRows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
      if (windowRows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
      const decidingRows = windowRows.filter(row => selected.has(row.effective_account_slug) && (!row.posted_on || inWindow(row)));
      snapshotChanged = candidateSnapshot(rows) !== candidateSnapshot(decidingRows);
      rows = decidingRows;
      matched = exactMatches(rows);
      inflows = rows.filter(row => row.direction === "inflow");
      recordIdentityEvidence(rows);
    }
    // Latest-payment selection follows the read that supplies the evidence.
    if (intent.latestPayment && matched.length) {
      const newest = matched.reduce((day, row) => row.posted_on > day ? row.posted_on : day, matched[0].posted_on);
      matched = matched.filter(row => row.posted_on === newest);
    }
    const snapshotNotice = snapshotChanged ? 'The account changed while answering. You can ask again.\n' : '';
    // Exact cents can support a candidate, never payer attribution. No other
    // deposit amount may enter this answer, including contextual alternatives.
    if (!matched.length && intent.counterpartyWords.length && Number.isSafeInteger(intent.amountMinor)) {
      const candidates = rows.filter(row => row.amount_minor === intent.amountMinor &&
        (searchDirection === 'both' || row.direction === searchDirection) &&
        (searchDirection === 'inflow' || !row.payee && merchantMatchBasis(row, intent.counterpartyWords.join(' ')) === 'possible'));
      const citations = candidates.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index, intent.presentation));
      const payer = safeDescription(intent.counterpartyWords.join(' '));
      const answer = candidates.length ? candidates.map((row, index) =>
        `POSSIBLE match: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)} in ${masked(bySlug.get(row.effective_account_slug))}; bank text: "${safeDescription(row.description)}" [${citations[index].n}]. Assumption: the bank text does not name ${payer}; this may be that payment.`).join('\n')
        : snapshotChanged ? 'The payment remains unconfirmed.'
        : `No ${searchDirection === 'inflow' ? 'deposit' : 'matching transaction'} of ${money(intent.amountMinor)} on ${accounts.map(masked).join(', ')} from ${intent.presentation.date(intent.from)} to ${intent.presentation.date(intent.to)}. ${searchDirection === 'inflow' ? 'Payer' : 'Payee'} identity remains unconfirmed; this does not establish that the ${searchDirection === 'inflow' ? 'payer has not paid' : 'payment did not occur outside these dates and accounts'}.` +
          ` Bank history covers through ${accounts.map(account => `${masked(account)}: ${intent.presentation.date(account.covered_to)}`).join('; ')}.`;
      return { answer: snapshotNotice + answer + nearWindow + directionLabel, citations, ledger: { kind: 'payment', found: null, total_minor: null, complete: false,
        attribution_incomplete: candidates.length > 0, match_basis: candidates.length ? 'possible' : 'none',
        amount_minor: intent.amountMinor, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        amount_candidates: candidates.map((row, index) => ({ n: citations[index].n, amount_minor: row.amount_minor,
          posted_on: row.posted_on, account_mask: citations[index].account_mask, bank_text: safeDescription(row.description), match_basis: 'possible' })) } };
    }
    const citations = matched.map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i, intent.presentation));
    // S8 named exact receipts admit only the requested cents. Amount-only
    // searches can offer nearby evidence without implying a payer identity.
    const possible = !intent.counterpartyWords.length && intent.amountMinor !== null && intent.nearDate ? rows.filter(row =>
      (searchDirection === 'both' || row.direction === searchDirection) &&
      row.amount_minor !== intent.amountMinor && Math.abs(row.amount_minor - intent.amountMinor) <= 100 &&
      Math.abs(Date.parse(row.posted_on) - Date.parse(intent.nearDate)) <= 3 * 86400000 &&
      matchesSender(row, intent.counterpartyWords)) : [];
    const possibleNote = possible.map(row => {
      const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length, intent.presentation);
      citations.push(ref);
      return '\nPossible nearby ' + paymentLabel + ' (different amount, not a match): ' + money(row.amount_minor) +
        ' dated ' + intent.presentation.date(row.posted_on) + ' in ' + masked(bySlug.get(row.effective_account_slug)) + ' [' + ref.n + '].';
    }).join('');
    // Both-direction searches include deposits too. Neither a direction union
    // nor an exact-amount filter can make unidentified inflows prove payer absence.
    if (searchDirection !== 'outflow' && !matched.length && intent.counterpartyWords.length && inflows.length) {
      const detail = inflowDetail(row => {
        const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length, intent.presentation);
        citations.push(ref); return ref;
      });
      return { answer: `I found ${inflows.length} deposit${inflows.length === 1 ? "" : "s"}, but the bank details do not identify ${inflows.length === 1 ? "it" : "them"} as that payer's payment, so payment is unconfirmed.\n${balanceSuggestion}\n${detail.answer}\nAccounts: ${accounts.map(masked).join(", ")}; ${intent.presentation.period(intent.from, intent.to)}; ${accounts.map(a => `${masked(a)}: covered through ${intent.presentation.date(a.covered_to)}`).join("; ")}.${nearWindow}`,
        citations, ledger: { kind: "payment", found: null, total_minor: null, complete: false,
          from: intent.from, to: intent.to, amount_minor: intent.amountMinor, accounts: accountCoverage(accounts),
          attribution_incomplete: true, inflow_count: inflows.length, inflows: detail.deposits } };
    }
    const ambiguous = Boolean(!intent.latestPayment && (intent.nearDate || intent.paymentCandidates) && matched.length > 1);
    // Amount-only arrival asks existence, not identification of one payment.
    const existenceLookup = searchDirection === 'inflow' && intent.amountMinor !== null && !intent.counterpartyWords.length;
    const answer = (ambiguous ? `${existenceLookup ? "Yes, I" : "I"} found ${matched.length} matching ${paymentLabel}s in ${intent.presentation.period(intent.from, intent.to)}, so no single payment is confirmed.\n${balanceSuggestion}\n` : "") + (matched.length
      ? intent.latestPayment && matched.length > 1
        ? `You made ${matched.length} payments on ${intent.presentation.date(matched[0].posted_on)}: ${matched.map((row, i) => `${money(row.amount_minor)} in ${masked(bySlug.get(row.effective_account_slug))} [${i + 1}]`).join('; ')}.`
        : matched.map((row, i) => `Found a ${paymentLabel} of ${money(row.amount_minor)}${searchDirection === 'both' ? ` (${row.direction})` : ''} dated ${intent.presentation.date(row.posted_on)} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.payee || row.description || "Payer unavailable")} [${i + 1}].`).join("\n")
      : `${searchDirection === 'inflow' && intent.counterpartyWords.length && !inflows.length ? "No deposits at all in this period" : `No matching ${paymentLabel}`}${intent.amountMinor !== null ? ` for requested amount ${money(intent.amountMinor)}` : ""} in ${accounts.map(masked).join(", ")} during ${intent.presentation.period(intent.from, intent.to)}; the bank feed covers through ${accounts.map(a => `${masked(a)}: ${a.live?.covered_to ? intent.presentation.date(a.live.covered_to) : "unknown (manual records only)"}`).join("; ")}.`) + nearWindow +
      (intent.nearDate ? `\nAccounts: ${accounts.map(masked).join(", ")}; ${accounts.map(a => `${masked(a)}: covered through ${intent.presentation.date(a.covered_to)}`).join("; ")}.` : "");
    const paymentLimit = !matched.length
      ? `\nI checked the dates and accounts shown and found no matching completed ${paymentLabel}; payment outside those dates and accounts remains unconfirmed.\n${balanceSuggestion}` : "";
    return { answer: snapshotNotice + answer + paymentLimit + directionLabel + possibleNote + (intent.counterpartyWords.length ? payerAssumptionNote(matched) : ""), citations, ledger: { kind: "payment", ...(searchDirection !== 'inflow' ? { direction: searchDirection } : {}), found: ambiguous && !existenceLookup ? null : matched.length > 0,
      ...(intent.nearDate || intent.paymentCandidates ? { ambiguous, complete: existenceLookup || !ambiguous, match_count: matched.length, ...(intent.nearDate ? { anchor_date: intent.nearDate } : {}) } : {}),
      from: intent.from, to: intent.to, amount_minor: intent.amountMinor, accounts: accountCoverage(accounts),
      ...(snapshotChanged ? { complete: false, attribution_incomplete: false } : {}) } };
  }
  // Decide on the full scoped period before category selection can discard
  // unknown membership. Model readings share the deterministic category guard
  // and its citations; an exact payee still keeps the merchant path.
  const categoryTotalUnconfirmed = Boolean(intent.categorySelector && !isUncategorizedBucket(intent.categorySelector) &&
    rows.some(row => row.direction === intent.direction && !categoryFor(row)));
  if (categoryTotalUnconfirmed) intent.kind = 'category';
  if (intent.interpretation && intent.direction === 'inflow' && intent.match && /^(?:refunds?|reimbursements?)$/i.test(intent.match)) {
    const keyword = intent.match.toLowerCase().replace(/s$/, '');
    const matched = inflows.filter(row => matchesDescriptionKeyword(row, keyword));
    const citations = matched.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index, intent.presentation));
    const total = sumMinor(matched);
    return { answer: `Deposits with description keyword '${keyword}' (whole words only): ${money(total)} for ${intent.presentation.period(intent.from, intent.to)}.` +
      (matched.length ? `\n${matched.map((row, index) => `${intent.presentation.date(row.posted_on)}: ${money(row.amount_minor)} in ${masked(bySlug.get(row.effective_account_slug))} [${index + 1}].`).join('\n')}`
        : `\nThere are no deposits with '${keyword}' in the description for this covered period.`),
      citations, ledger: { kind: 'merchant', description_keyword: keyword, total_minor: total, complete: true,
        from: intent.from, to: intent.to, accounts: accountCoverage(accounts), rows: matched.map((row, index) => ({ n: index + 1, amount_minor: row.amount_minor })) } };
  }
  let namedOutflowMerchant = null;
  if (intent.kind === "merchant" && intent.match) {
    if (intent.direction === "outflow") {
      const remaining = new Set(rows.map(row => row.id));
      namedOutflowMerchant = { ...vendorSelection,
        ...Object.fromEntries(['exact', 'family', 'matched', 'possible', 'nameOnly', 'possibleIdentity'].map(key =>
          [key, vendorSelection[key].filter(row => remaining.has(row.id) && row.direction === intent.direction)])) };
    }
    if (merchantSelectorAmbiguous) return { reason: "merchant_selector_ambiguous" };
  }
  const eligible = row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
    effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on);
  const inflowPairing = true;
  // An unresolved or uncovered posted competitor can block ownership proof.
  // Removing it before mutual uniqueness would invent a pair. Only after that
  // decision may confirmed, usable, covered endpoints support a subtraction.
  // The same competition pool applies to broad, named and derived views.
  const pairingRows = allRows;
  const pairing = pairOwnTransfers(pairingRows, bySlug, { directedEvidence: inflowPairing });
  if ((intent.kind === 'expense_summary' || intent.kind === 'largest' && intent.direction === 'outflow') &&
      rows.some(row => !loanCardPaymentKind(row, bySlug) && accountKindReviewRequired(row, bySlug))) return { reason: 'ledger_account_kind_review_required' };
  const eligiblePairs = pairing.pairs.filter(pair => [pair.out, pair.in].every(row => eligible(row) && !excludedPayments.has(row.id)));
  // Candidate row markers and conditional figures describe eligible pairs.
  // Rejected pairs remain unmatched below, without acquiring pair authority.
  pairing.candidateRows = new Set(eligiblePairs.flatMap(pair => [pair.out.id, pair.in.id]));
  const rejectedEndpoints = pairing.pairs.filter(pair => ![pair.out, pair.in].every(eligible)).flatMap(pair => [pair.out, pair.in]);
  // A named recurring answer must not acquire citations from an unrelated
  // movement elsewhere in the authorized window. Pair competition above still
  // sees every row; only the displayed scope is narrowed here.
  const recurringRowIds = intent.recurringSelector ? new Set(rows.map(row => row.id)) : null;
  const pairs = eligiblePairs.filter(pair => !recurringRowIds ||
    [pair.out, pair.in].some(row => recurringRowIds.has(row.id))).filter(pair => intent.kind === "expense_summary"
    ? selected.has(pair.out.effective_account_slug) && inWindow(pair.out)
    : [pair.out, pair.in].some(row => selected.has(row.effective_account_slug) && inWindow(row))).filter(pair => {
      if (intent.scopePlan?.type !== 'transfer') return true;
      const forward = intent.transferSourceSlugs.includes(pair.out.effective_account_slug) && intent.transferDestinationSlugs.includes(pair.in.effective_account_slug);
      const reverse = intent.transferDestinationSlugs.includes(pair.out.effective_account_slug) && intent.transferSourceSlugs.includes(pair.in.effective_account_slug);
      return forward || !intent.scopePlan.directed && reverse;
    });
  // Competition can find a pair whose endpoint cannot support an exclusion.
  // Keep the readable selected leg visible as an unproved candidate instead
  // of losing its uncertainty when the pair is rejected after competition.
  // Possible unconnected movements are already partitioned and disclosed on
  // their own lines; they are never also retained as unmatched transfers.
  // The payer listing ("who paid me") reads the same directed pairing as
  // money in, so a credit money in subtracts is never a payer either.
  const payerReading = ["merchant", "category"].includes(intent.kind) && intent.direction === "inflow";
  const payerListing = payerReading && !intent.match;
  const inflowMembership = { eligible, excludedPayments, selected, inWindow, bySlug };
  const provedOwnInflow = payerReading ? pairOwnTransfers(pairingRows, bySlug, { directedEvidence: true }).pairs
    .filter(pair => provedOwnInflowPair(pair, inflowMembership)) : [];
  const provedOwnInflowIds = new Set(provedOwnInflow.map(pair => pair.in.id));
  // Answer-boundary post-condition (closed world): a payer row, and any total
  // called income, holds only credits no existing classifier reads as money
  // that is not a payment to the owner. Own-account money of any certainty
  // (a proved pair, a named owned endpoint, a possible pair naming an owned
  // account, an own-account role such as an owner contribution) and refund or
  // reversal text go on one disclosed line. A bare transfer word with no
  // owned-account evidence cannot be told apart from an outside sender: it
  // stays listed, marked as an unmatched possible transfer, never certified.
  const notPaymentReason = row => !payerReading || row.direction !== "inflow" ? null
    : provedOwnInflowIds.has(row.id) ? "a move between your own accounts"
    : ownMovementRole(row)?.includes("sent to yourself") ? "possibly from your own account"
    : ownMovementRole(row)?.includes("owner contribution") ? "an owner contribution"
    : possibleOwnedMovement(row, bySlug) || ordinaryMoneyMembership([row], [], bySlug).excluded.has(row.id) ||
      pairing.candidateRows.has(row.id) || ownMovementRole(row) ? "a possible move from your own account"
    : payerListing && refundCandidateIds([], [row]).size ? "a refund or reversal" : null;
  const notPayments = payerReading ? rows.filter(row => notPaymentReason(row) && (!intent.match || (intent.kind === "category" ? matchesCategory : matchesMerchant)(row, intent.match))) : [];
  const notPaymentIds = new Set(notPayments.map(row => row.id));
  const unmatched = [...pairing.unmatched, ...rejectedEndpoints].filter(row =>
    eligible(row) && !excludedPayments.has(row.id) && !possibleMovementIds.has(row.id) && selected.has(row.effective_account_slug) && inWindow(row) &&
    !notPaymentIds.has(row.id) && (!recurringRowIds || recurringRowIds.has(row.id)));
  // The common period wrapper owns disclosure for every renderer below.
  const refundResult = result => result;
  if (intent.refundsNotNetted || intent.netRefunds) {
    const history = allRows.filter(row => row.posted_on <= intent.to);
    const merchantSelector = intent.kind === 'merchant' ? intent.match : null;
    const { ordinary: charges } = ordinaryExpenseSelection(history.filter(row => selected.has(row.effective_account_slug) &&
      (!merchantSelector || matchesMerchant(row, merchantSelector))), eligiblePairs, bySlug);
    const { candidateIds, credits } = refundReading(charges, history, eligiblePairs, bySlug);
    const inCandidateScope = row => {
      if (merchantSelector) return matchesMerchant(row, merchantSelector) && candidateIds.has(row.id);
      if (intent.categorySelector && !categoryTotalUnconfirmed) return (intent.categorySelectorResolved ? categoryFor(row) === normalizeMerchantText(intent.categorySelector) : true) ||
        candidateIds.has(row.id) && !categoryFor(row);
      if (intent.kind === 'category' && intent.match && categoryFor(row) &&
          categoryFor(row) !== normalizeMerchantText(intent.match)) return false;
      return candidateIds.has(row.id);
    };
    onRefundCandidates(credits.filter(row => inWindow(row) && selected.has(row.effective_account_slug) && inCandidateScope(row)), bySlug);
  }
  // Membership refusal must retain the same refund nomination and disclosure
  // boundary as an answered component. It cannot silently drop candidate rows.
  if (componentRefusal) {
    const { rows: candidates, reason, message, accountComponents } = componentRefusal;
    return { answer: message,
      citations: candidates.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index, intent.presentation)),
      ledger: { kind: intent.kind, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        ...(accountComponents ? { lead_accounts: accounts.map(account => ({ account_mask: account.mask, available: false, reason })),
          possible_payment_count: candidates.length } : { possible_own_movement_count: candidates.length }),
        total_minor: null, expense_total_minor: null, combined_inflow_minor: null, complete: false, reason } };
  }
  if (intent.categorySelector && !categoryTotalUnconfirmed) {
    const categoryRows = intent.categorySelectorResolved ? rows.filter(row => categoryFor(row) === normalizeMerchantText(intent.categorySelector)) : rows;
    const summary = expenseSummary({ intent: { ...intent, categoryLimit: Number.MAX_SAFE_INTEGER }, accounts, requestedAccounts, omittedAccounts,
      rows: categoryRows, pairs, pairing, bySlug });
    summary.ledger.category_selector = intent.categorySelector;
    summary.ledger.selector_unresolved = !intent.categorySelectorResolved;
    // Formatting null also coerces it to zero. A matched category does not
    // restore an expense figure withheld by the account-type decision.
    if (intent.categorySelectorResolved) {
      if (summary.ledger.classification_uncertain === false && Number.isSafeInteger(summary.ledger.total_minor))
        summary.answer = `Category '${safeDescription(intent.categorySelector)}': ${money(summary.ledger.total_minor)}.\n${summary.answer}`;
    } else summary.answer = `No category matched '${safeDescription(intent.categorySelector)}'. Want to check the category names?\nFull category breakdown:\n${summary.answer}`;
    if (intent.refundsNotNetted) {
      const unconfirmedCredits = rows.filter(row => row.direction === 'inflow' && !categoryFor(row));
      if (unconfirmedCredits.length) {
        summary.ledger.unconfirmed_category_count = unconfirmedCredits.length;
        summary.ledger.unsorted_minor = sumMinor(unconfirmedCredits);
        summary.answer += '\nUnconfirmed categories: ' + unconfirmedCredits.length + ' rows totaling ' + money(summary.ledger.unsorted_minor) + '; left out of confirmed category totals.';
      }
    }
    return summary;
  }
  if (intent.kind === "expense_summary") {
    const result = expenseSummary({ intent, accounts, requestedAccounts, omittedAccounts, rows, pairs, pairing, bySlug,
      citationOffset: intent.citationOffset, retainedPaymentIds });
    // Coverage may be partial, but expense membership and an integer total
    // are required before partitioning the covered ordinary spending.
    if (intent.remainderSelector && result.ledger.classification_uncertain === false && Number.isSafeInteger(result.ledger.total_minor)) {
      const { ordinary } = ordinaryExpenseSelection(rows, pairs, bySlug, retainedPaymentIds);
      const wanted = normalizeMerchantText(intent.remainderSelector);
      const categoryRows = ordinary.filter(row => categoryFor(row) === wanted);
      const payeeRows = ordinary.filter(row => merchantMatchBasis(row, intent.remainderSelector) === 'exact');
      const selectedRows = categoryRows.length ? categoryRows : payeeRows;
      if (selectedRows.length) {
        const selectedMinor = sumMinor(selectedRows), remainderMinor = result.ledger.total_minor - selectedMinor;
        if (!Number.isSafeInteger(remainderMinor)) throw new Error('ledger total overflow');
        result.ledger.remainder = { selector: intent.remainderSelector, selected_minor: selectedMinor, remainder_minor: remainderMinor };
        result.answer += `\n${safeDescription(intent.remainderSelector)} (${categoryRows.length ? 'bank category' : 'exact payee'}): ${money(selectedMinor)}; all other recorded ordinary spending: ${money(remainderMinor)}.`;
      } else result.answer += '\nThe selector did not match a recorded category or exact payee; its amount and the remainder are unavailable.';
    }

    return result;
  }
  if (intent.kind === "totals" && intent.inflowOnly) {
    // Recorded inflow is gross. Only a structurally proved pair may reduce
    // outside inflow; text alone never removes an incoming posted row.
    const membership = ordinaryMoneyMembership(rows, pairs, bySlug);
    const totals = accounts.map(account => {
      const ownRows = rows.filter(row => row.effective_account_slug === account.account_slug);
      return { account_mask: account.mask, credits_minor: sumMinor(ownRows.filter(row => row.direction === "inflow")),
        debits_minor: sumMinor(ownRows.filter(row => row.direction === "outflow")), transaction_count: ownRows.length };
    });
    const combined = sumMinor(totals, account => account.credits_minor);
    // Candidates are mutually unique over the padded read. Only reciprocal
    // owned-account identity evidence can support the subtraction; coincident
    // cents/dates, refunds and an unreviewed account kind cannot. Count by the
    // selected inflow's date, even when the covered outgoing leg is outside
    // this question's account scope or period. Other answer kinds are unchanged.
    const matchedInflowPairs = pairs.filter(pair =>
      provedOwnInflowPair(pair, inflowMembership));
    const matchedInflowMinor = sumMinor(matchedInflowPairs, pair => pair.in.amount_minor);
    const outsideInflowMinor = combined - matchedInflowMinor;
    const leadSelection = leadExclusions(rows, pairs, selected, bySlug, {
      ...intent, withdrawals: "include", loanProceeds: intent.loanProceeds === "exclude" ? "exclude" : "include",
    });
    const leadAccounts = accounts.map(account => {
      const ownRows = rows.filter(row => row.effective_account_slug === account.account_slug && !membership.excluded.has(row.id) && !leadSelection.excluded.has(row.id) && !loanCardPaymentKind(row, bySlug));
      return { account_mask: account.mask, credits_minor: sumMinor(ownRows.filter(row => row.direction === "inflow")),
        debits_minor: sumMinor(ownRows.filter(row => row.direction === "outflow")), transaction_count: ownRows.length };
    });
    const loanExcluded = intent.loanProceeds === 'exclude';
    const leadCombined = sumMinor(leadAccounts, account => account.credits_minor);
    const loanNote = loanExcluded ? `Money in with detected owned-loan advances excluded: ${money(leadCombined)}. Excluded detected loan or line-of-credit proceeds: ${money(leadSelection.summary.loan_proceeds_minor)}. Excluded detected own-account transfers: ${money(leadSelection.summary.own_transfer_minor)}. Unproved credits remain included; this does not classify every deposit.\n` : '';
    const citations = rows.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index, intent.presentation));
    const citationById = new Map(rows.map((row, index) => [row.id, citations[index]]));
    const citeTransferLeg = row => {
      if (!citationById.has(row.id)) {
        const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length, intent.presentation);
        citationById.set(row.id, ref); citations.push(ref);
      }
      return citationById.get(row.id).n;
    };
    const matchedTransfers = matchedInflowPairs.map(pair => ({ amount_minor: pair.in.amount_minor,
      outgoing_citation: citeTransferLeg(pair.out), incoming_citation: citeTransferLeg(pair.in) }));
    const matchedCreditIds = new Set(matchedInflowPairs.map(pair => pair.in.id));
    const possibleTransfers = inflows.filter(row => !matchedCreditIds.has(row.id) &&
      (isTransferCandidate(row) || pairing.candidateRows.has(row.id) || membership.excluded.has(row.id) || membership.possible.has(row.id)));
    const transferRefs = possibleTransfers.map(row => citationById.get(row.id).n);
    const matchedRefs = matchedTransfers.flatMap(pair => [pair.outgoing_citation, pair.incoming_citation])
      .map(n => `[${n}]`).join(" ");
    const lines = totals.map((total, index) => {
      const ownRefs = rows.filter(row => row.effective_account_slug === accounts[index].account_slug)
        .map(row => `[${citationById.get(row.id).n}]`).join(" ");
      return `${masked(accounts[index])}, ${intent.presentation.period(intent.from, intent.to)}: credits ${money(total.credits_minor)}; debits ${money(total.debits_minor)} ${ownRefs || "(no completed income or expenses in the covered period)"}.`;
    });
    return { answer: [loanNote + `Combined recorded inflow: ${money(combined)} gross across ${accounts.length} account${accounts.length === 1 ? "" : "s"} with records, ${intent.presentation.period(intent.from, intent.to)}; not established income.`,
      `Matched transfers between your own accounts: ${money(matchedInflowMinor)} across ${matchedTransfers.length} ${matchedTransfers.length === 1 ? "pair" : "pairs"}${matchedRefs ? ` ${matchedRefs}` : ""}.`,
      `Inflow from outside your covered accounts: ${money(outsideInflowMinor)} (recorded gross inflow minus matched own transfers; includes any possible own transfer listed below).`,
      "Transfers are counted by the inflow posting date; counterpart outflows may fall up to 3 days before or after it.",
      ...matchedTransfers.map(pair => `Matched own transfer pair: outgoing [${pair.outgoing_citation}]; incoming [${pair.incoming_citation}].`),
      ...lines, `Income is still unconfirmed; a deposit can be a transfer or another kind of credit, and the bank label alone does not prove its source.\n${balanceSuggestion}`,
      "Uncertain deposits remain included.",
      ...possibleTransfers.map(row => `Possible own transfer (included in recorded and outside inflow): "${safeDescription(row.description)}" [${citationById.get(row.id).n}].`),
      `Accounts: ${accounts.map(masked).join(", ")}; ${intent.presentation.period(intent.from, intent.to)}; ${accounts.map(a => `${masked(a)}: covered through ${intent.presentation.date(a.covered_to)}`).join("; ")}.`].join("\n"),
    citations, ledger: { kind: "totals", from: intent.from, to: intent.to, accounts: totals, lead_accounts: leadAccounts,
      combined_inflow_minor: combined, includes_own_transfers: true, income_established: false,
      ...(intent.paymentCitationDetails ? { amount_citations: inflows.map(row => citationById.get(row.id).n) } : {}),
      outside_inflow_minor: outsideInflowMinor, matched_transfer_count: matchedTransfers.length,
      matched_own_transfers: { total_minor: matchedInflowMinor, count: matchedTransfers.length, window_days: 3,
        pairs: matchedTransfers },
      candidate_transfer_count: pairs.length, default_exclusions: leadSelection.summary,
      ...(loanExcluded ? { lead_inflow_minor: leadCombined, excluded_loan_proceeds_minor: leadSelection.summary.loan_proceeds_minor } : {}),
      transfer_related_credit_citations: transferRefs } };
  }
  // Pairs never change stored rows or existing gross keys. Qualifying pairs
  // leave the lead figures; the unchanged gross figures are always printed.
  // Notes describe only rows feeding this answer, including its Unsorted line.
  // An unrelated transfer elsewhere in the window cannot change a merchant total.
  // Description phrases select recorded words, never a payer identity. Keep
  // exact phrase boundaries so a partial word or payee-only label cannot match.
  const descriptionMatches = row => {
    if (!intent.descriptionKeyword) return true;
    return matchesDescriptionKeyword(row, intent.descriptionKeyword);
  };
  let figureRows = rows;
  if (["largest", "deposits", "merchant", "category"].includes(intent.kind)) {
    figureRows = rows.filter(row => row.direction === intent.direction && descriptionMatches(row));
    if (intent.match) figureRows = namedOutflowMerchant
      ? [...namedOutflowMerchant.matched, ...namedOutflowMerchant.possible]
      : figureRows.filter(row =>
        (["merchant", "largest"].includes(intent.kind) ? matchesMerchant : matchesCategory)(row, intent.match) ||
        (intent.kind === "category" && !categoryFor(row)));
  } else if (intent.kind === "recurring") figureRows = detectRecurring(rows, intent.to).flatMap(group => group.rows);
  const { excluded: leadExcluded, keptPairs, knownOwnTransferRows, scopedKnownTransferRows, summary, expensePayments: selectedExpensePayments = new Map() } = leadExclusions(figureRows, intent.kind === "transfers" ? [] : pairs, selected, bySlug,
    intent.kind === "transfers" ? { withdrawals: "include" } : namedOutflowMerchant ? { ...intent, ownTransfers: "exclude" } : intent);
  if (intent.kind === "totals" && intent.ownTransfers !== "include") {
    for (const [id] of ordinaryMoneyMembership(figureRows, pairs, bySlug, intent).excluded) {
      leadExcluded.set(id, "an identified owned-account movement");
      knownOwnTransferRows.delete(id); scopedKnownTransferRows.delete(id);
    }
    for (const [pair] of keptPairs) {
      const contributing = [pair.out, pair.in].filter(row => figureRows.some(figure => figure.id === row.id));
      if (contributing.length && contributing.every(row => leadExcluded.has(row.id))) keptPairs.delete(pair);
    }
  }
  const expensePayments = new Map(selectedExpensePayments);
  // Conditional account subtotals still exclude payments throughout the pool.
  // A named ranking's visible summary must stay inside the named identity.
  const namedPaymentIds = namedSelection ? new Set([...namedSelection.matched, ...namedSelection.possible].map(row => row.id)) : null;
  if (intent.kind === 'largest' && intent.direction === 'outflow') for (const row of rows) {
    if (namedPaymentIds && !namedPaymentIds.has(row.id)) continue;
    const liabilityKind = loanCardPaymentKind(row, bySlug);
    if (row.direction === 'outflow' && liabilityKind) expensePayments.set(row.id, { row, liabilityKind });
  }
  // Compact vendor spend excludes only bilaterally proved own movements and
  // payments to an exactly identified owned liability. A possible transfer is
  // never enough, and the omitted account's rows never enter the subtotal.
  if (namedOutflowMerchant) for (const pair of pairs) {
    if (!isDirectedOwnedTransfer(pair, bySlug)) continue;
    const outKind = bySlug.get(pair.out.effective_account_slug)?.account_kind;
    const inKind = bySlug.get(pair.in.effective_account_slug)?.account_kind;
    if (!(moveKind(outKind) && (moveKind(inKind) || ["loan", "line_of_credit"].includes(inKind)))) continue;
    if (figureRows.some(row => row.id === pair.out.id)) leadExcluded.set(pair.out.id, "a matched own-account transfer");
    if (figureRows.some(row => row.id === pair.in.id)) leadExcluded.set(pair.in.id, "a matched own-account transfer");
  }
  let noteSummary = summary, noteExcluded = leadExcluded, unchangedLimitedList = false;
  const withoutLead = list => list.filter(row => !leadExcluded.has(row.id));
  // Raw payment evidence feeds only the payment summary. Alternate rankings,
  // conditional totals and account subtotals use the same payment-free pool.
  const activity = intent.kind === "largest" && intent.direction === "outflow"
    ? rows.filter(row => !loanCardPaymentKind(row, bySlug)) : rows;
  const withoutCandidates = list => withoutLead(list).filter(row => !pairing.candidateRows.has(row.id));
  const citations = [], references = new Map();
  const cite = row => {
    if (!references.has(row.id)) {
      const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length, intent.presentation);
      references.set(row.id, ref); citations.push(ref);
    }
    return references.get(row.id);
  };
  const refs = list => list.map(row => `[${cite(row).n}]`).join(" ");
  const candidateMark = row => scopedKnownTransferRows.has(row.id)
    ? " (known move between your own accounts, kept in money in and money out)"
    : pairing.candidateRows.has(row.id) ? " (possible move between your own accounts, included)" : "";
  const publicRow = row => ({ ...cite(row), ...(incompleteNamed ? {} : { description: safeDescription(row.description || row.payee || "Transaction") }), possible_own_transfer: pairing.candidateRows.has(row.id) });
  const rowLine = row => `${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)} in ${masked(bySlug.get(row.effective_account_slug))}${incompleteNamed ? "" : `: ${safeDescription(row.description || row.payee || "Transaction")}`}${intent.financingBoundary ? `; bank payer label: ${safeDescription(row.payee || 'unavailable')}` : ''}${candidateMark(row)} ${refs([row])}`;
  const bounded = `Accounts: ${accounts.map(masked).join(", ")}; ${intent.presentation.period(intent.from, intent.to)}; ${accounts.map(a => `${masked(a)}: covered through ${intent.presentation.date(a.covered_to)}`).join("; ")}.`;
  const vendorCoverage = contributingRows => ({
    complete: omittedAccounts.length === 0,
    candidate_account_count: requestedAccounts.length,
    covered_account_count: accounts.length,
    omitted_account_count: omittedAccounts.length,
    contributing_account_count: new Set(contributingRows.map(row => row.effective_account_slug)).size,
  });
  const vendorCoverageLine = coverage => `Bank history: requested ${intent.presentation.period(intent.from, intent.to)}; ` +
    `${coverage.contributing_account_count} contributing, ${coverage.covered_account_count} fully covered, ` +
    `${coverage.omitted_account_count} omitted account${coverage.omitted_account_count === 1 ? "" : "s"}; ` +
    accounts.map(account => `${masked(account)} covered through ${intent.presentation.date(account.covered_to)}`).join("; ") + ".";
  // These rows have a structured payee, but only character overlap with the
  // selector. Cite the bank's text for review without adding it to any total.
  const possibleIdentity = orderedVendorRows(withoutLead(namedOutflowMerchant?.possibleIdentity || []));
  const possibleIdentityMembers = () => possibleIdentity.map(row => ({
    payee: safeDescription(row.payee), ref: cite(row).ref, citations: [cite(row).n],
  }));
  const possibleIdentityLine = members => members.length
    ? '\nPossible vendor matches, not included in the confirmed total: ' +
      members.map(member => `"${member.payee}" ${member.citations.map(n => `[${n}]`).join(' ')}`).join('; ') + '.' : '';
  const familyAmbiguity = namedOutflowMerchant?.ambiguous ? {
    family_ambiguous: true, family_candidates: namedOutflowMerchant.candidates.map(safeDescription),
  } : {};
  const familyAmbiguityLine = namedOutflowMerchant?.ambiguous
    ? `\nAmbiguous vendor family; candidates seen: ${familyAmbiguity.family_candidates.join("; ")}. Only exact payees can establish a subtotal.` : "";
  const ledger = { kind: intent.kind, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
    includes_own_transfers: true, matched_transfer_count: 0, candidate_transfer_count: pairs.length,
    lead: leadExcluded.size ? "default_exclusions" : "gross", default_exclusions: summary, flip: [] };
  if (expensePayments.size) {
    const payments = [...expensePayments.values()];
    ledger.own_account_payments = { total_minor: sumMinor(payments, item => item.row.amount_minor), count: payments.length,
      card_minor: sumMinor(payments.filter(item => item.liabilityKind === "card"), item => item.row.amount_minor),
      loan_minor: sumMinor(payments.filter(item => item.liabilityKind === "loan"), item => item.row.amount_minor) };
  }
  if (knownOwnTransferRows.size) ledger.known_own_transfer_in_lead = true;
  const conditionalAccounts = accounts.map(account => {
    const ownRows = withoutCandidates(activity.filter(row => row.effective_account_slug === account.account_slug &&
      (!namedPaymentIds || namedPaymentIds.has(row.id))));
    return { account_mask: account.mask, credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
      debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
  });
  ledger.if_own_transfers = { accounts: conditionalAccounts };
  let conditionalDetail = conditionalAccounts.map((a, i) => `${masked(accounts[i])}: credits ${money(a.credits_minor)}; debits ${money(a.debits_minor)}`).join("; ");
  let answer, leadDetail;
  const categoryOwned = new Map();
  if (intent.kind === "totals") {
    ledger.accounts = accounts.map(account => {
      const ownRows = activity.filter(row => row.effective_account_slug === account.account_slug);
      return { account_mask: account.mask, credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
        debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
    });
    answer = ledger.accounts.map((total, i) => {
      const ownRows = activity.filter(row => row.effective_account_slug === accounts[i].account_slug);
      return `${masked(accounts[i])}, ${intent.presentation.period(intent.from, intent.to)}: credits ${money(total.credits_minor)}; debits ${money(total.debits_minor)} ${refs(ownRows) || "(no completed income or expenses in the covered period)"}.`;
    }).join("\n");
    ledger.lead_accounts = accounts.map(account => {
      const ownRows = withoutLead(rows.filter(row => row.effective_account_slug === account.account_slug));
      return { account_mask: account.mask, credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
        debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
    });
    if (intent.paymentCitationDetails) {
      ledger.inflow_citations = withoutLead(rows).filter(row => row.direction === 'inflow').map(row => cite(row).n);
      ledger.outflow_citations = withoutLead(rows).filter(row => row.direction === 'outflow').map(row => cite(row).n);
    }
    leadDetail = ledger.lead_accounts.map((total, i) => `${masked(accounts[i])}, ${intent.presentation.period(intent.from, intent.to)}: money in ${money(total.credits_minor)}; money out ${money(total.debits_minor)}.`).join("\n");
    if (intent.measure) {
      ledger.measure = intent.measure;
      ledger.net_minor = sumMinor(ledger.lead_accounts.filter((_, i) => moveKind(accounts[i].account_kind)), a => a.credits_minor - a.debits_minor);
      ledger.net_label = "money in minus money out, not accounting profit or cash flow";
      leadDetail = `Money in minus money out, not accounting profit or cash flow: ${money(ledger.net_minor)}.\n${leadDetail}`;
      for (const account of accounts.filter(a => !moveKind(a.account_kind)))
        leadDetail += `\n${masked(account)}: ${account.account_kind} account, left out of money in minus money out; only checking, savings and card accounts contribute.`;
    }
  } else if (["largest", "deposits"].includes(intent.kind)) {
    // The opted-in SimpleFIN profile adds explicit listing completeness.
    // Preserve the legacy response shape for other profiles. This is formatting
    // only: every profile passes the same coverage and identity gates above.
    if (env.BANK_FEED_PROVIDER === "simplefin")
      ledger.complete = periodCovered;
    const categoryRanking = intent.kind === "largest" && intent.matchType === "category";
    const selectorMatches = categoryRanking ? matchesCategory : matchesMerchant;
    if (categoryRanking) {
      ledger.selector_type = "category";
      ledger.category_selector = intent.match;
      ledger.complete = periodCovered;
      // Check the full scoped, directional pool before filtering or limiting it.
      // An unknown category could hide the largest expense, even beside a match.
      const unknown = activity.filter(row => row.direction === intent.direction &&
        (!categoryFor(row) || row.category_basis_state !== "confirmed"));
      if (!isUncategorizedBucket(intent.match) && unknown.length) {
        const candidates = withoutLead(activity).filter(row => row.direction === intent.direction &&
          row.category_basis_state === "confirmed" && matchesCategory(row, intent.match))
          .sort((a, b) => b.amount_minor - a.amount_minor || a.id - b.id);
        const shown = candidates.slice(0, intent.limit);
        ledger.found = null; ledger.complete = false;
        ledger.total_minor = null; ledger.lead_total_minor = null; ledger.expense_total_minor = null;
        ledger.category_ranking_unconfirmed = true;
        ledger.rows = []; ledger.lead_rows = [];
        ledger.confirmed_candidates = shown.map(publicRow);
        ledger.confirmed_candidate_count = candidates.length;
        ledger.unsorted_minor = sumMinor(unknown);
        ledger.if_own_transfers = { total_minor: null, complete: false };
        answer = `I found transactions without a confirmed category, so the ranking for ${safeDescription(intent.match)} is unconfirmed.`;
        if (shown.length) answer += `\nConfirmed category candidates (incomplete ranking), showing ${shown.length} of ${candidates.length}:\n${shown.map(rowLine).join("\n")}`;
        answer += `\nTransactions without a confirmed category: ${money(ledger.unsorted_minor)} ${refs(unknown)}.`;
        answer += `\n${bounded}\n${originalRecordSuggestion}`;
        return refundResult({ answer, citations, ledger });
      }
    }
    const found = activity.filter(row => row.direction === intent.direction && descriptionMatches(row) &&
      (!intent.match || selectorMatches(row, intent.match))).sort((a, b) =>
      (intent.kind === "largest" ? b.amount_minor - a.amount_minor : b.posted_on.localeCompare(a.posted_on)) || a.id - b.id);
    const listed = intent.limit ? found.slice(0, intent.limit) : found;
    if (intent.descriptionKeyword) ledger.description_keyword = intent.descriptionKeyword;
    if (intent.match && !categoryRanking) ledger.vendor_selector = intent.match;
    ledger.found = listed.length > 0; ledger.rows = listed.map(publicRow);
    ledger.if_own_transfers.total_minor = sumMinor(withoutCandidates(listed));
    conditionalDetail = `total of the listed ${intent.direction === "inflow" ? "deposits" : "expenses"}: ${money(ledger.if_own_transfers.total_minor)}`;
    answer = listed.length ? listed.map(rowLine).join("\n") : `No ${intent.direction === "inflow" ? "deposits" : "expenses"} found.`;
    // Filter before the limit so an excluded top row does not hide the next expense.
    const eligible = withoutLead(found);
    const leadListed = intent.limit ? eligible.slice(0, intent.limit) : eligible;
    ledger.lead_rows = leadListed.map(publicRow);
    leadDetail = leadListed.length ? leadListed.map(rowLine).join("\n") : `No ${intent.direction === "inflow" ? "deposits" : "expenses"} found in the first figures.`;
    if (intent.descriptionKeyword) {
      const label = safeDescription(intent.descriptionKeyword);
      const heading = `Deposits with description keyword '${label}' (whole words only; no payer identity is established).`;
      const absent = `There are no deposits with '${label}' in the description for this covered period.`;
      answer = `${heading}\n${listed.length ? answer : absent}`;
      leadDetail = `${heading}\n${leadListed.length ? leadDetail : absent}`;
    }
    if (intent.answerAddOn === 'share' && intent.kind === 'largest' && intent.direction === 'outflow') {
      // Numerator and denominator use this exact snapshot, scope, period and
      // ordinary-expense membership. Round half-up using integers throughout.
      const listedMinor = sumMinor(leadListed), totalMinor = sumMinor(eligible);
      if (!omittedAccounts.length && !ledger.classification_uncertain &&
          eligible.every(row => moveKind(bySlug.get(row.effective_account_slug)?.account_kind)) &&
          Number.isSafeInteger(listedMinor) && Number.isSafeInteger(totalMinor) && totalMinor > 0) {
        const tenths = (BigInt(listedMinor) * 2000n + BigInt(totalMinor)) / (2n * BigInt(totalMinor));
        const percent = `${tenths / 10n}.${tenths % 10n}`;
        ledger.share_of_total = { listed_minor: listedMinor, total_minor: totalMinor, percent };
      }
    }
    if (intent.limit) {
      // Pool exclusions can sit below the cutoff. Only a removed displayed
      // row justifies a removal amount or an invitation to flip this list.
      const displayed = leadExclusions(listed, pairs, selected, bySlug, intent);
      noteSummary = displayed.summary; noteExcluded = displayed.excluded;
      unchangedLimitedList = listed.length === leadListed.length && listed.every((row, i) => row.id === leadListed[i].id);
    }
  } else if (["merchant", "category"].includes(intent.kind)) {
    // Category membership never makes a liability payment an expense. Keep the
    // generic (including unconfirmed/model) reader on the summary's eligibility
    // rule before calculating subtotals, groups, or unknown-category amounts.
    const categoryExpenses = intent.kind === "category" && intent.direction === "outflow"
      ? ordinaryExpenseSelection(activity, pairs, bySlug) : null;
    const directionRows = (categoryExpenses ? categoryExpenses.ordinary : activity.filter(row => row.direction === intent.direction)).filter(row => !notPaymentIds.has(row.id));
    let categoryExclusionNote = "";
    if (categoryExpenses) {
      const payments = [...categoryExpenses.payments.values()];
      ledger.own_account_payments = {
        total_minor: sumMinor(payments, payment => payment.row.amount_minor), count: payments.length,
        card_minor: sumMinor(payments.filter(payment => payment.liabilityKind === "card"), payment => payment.row.amount_minor),
        loan_minor: sumMinor(payments.filter(payment => payment.liabilityKind === "loan"), payment => payment.row.amount_minor),
      };
      ledger.excluded_own_transfer_minor = sumMinor([...categoryExpenses.ownTransfers.values()]);
      ledger.includes_own_transfers = false;
      if (intent.kind === 'category') {
        const ordinaryIds = new Set(categoryExpenses.ordinary.map(row => row.id));
        for (const row of activity) if (row.direction === 'outflow' && !ordinaryIds.has(row.id))
          categoryOwned.set(row.id, row);
      }
      if (payments.length) categoryExclusionNote += `\nPayments to your own loan/card accounts: ${money(ledger.own_account_payments.total_minor)} across ${payments.length} ${payments.length === 1 ? "payment" : "payments"}; excluded from spending.`;
      if (categoryExpenses.ownTransfers.size) categoryExclusionNote += `\nExcluded detected own-account transfers: ${money(ledger.excluded_own_transfer_minor)}.`;
    }
    const matched = namedOutflowMerchant ? orderedVendorRows(withoutLead(namedOutflowMerchant.matched))
      : intent.match ? directionRows.filter(row => (intent.kind === "merchant" ? matchesMerchant : matchesCategory)(row, intent.match))
      : directionRows;
    if (namedOutflowMerchant && !matched.length && namedSelection?.resolved &&
        namedSelection.matched.every(row => row.direction !== intent.direction || excludedPayments.has(row.id)) &&
        !namedOutflowMerchant.possible.length && !(namedOutflowMerchant.possibleIdentity || []).length) {
      ledger.selector_applied = true;
      ledger.total_minor = 0; ledger.lead_total_minor = 0;
      ledger.if_own_transfers.total_minor = 0;
      ledger.match_basis = vendorSelection.family.length ? 'family' : 'exact';
      ledger.complete = omittedAccounts.length === 0;
      // A credit can establish the merchant even when no spending survives.
      // Payment credits stay in the outer payment appendix, never in refunds.
      const received = namedSelection.matched.filter(row => row.direction === 'inflow' && !excludedPayments.has(row.id));
      const refunds = received.filter(row => matchesDescriptionKeyword(row, 'refund') || categoryFor(row) === 'refund');
      // Preserve the compact vendor receipt when no ordinary rows survive.
      // The separate payment appendix supplies its own amount and citations.
      ledger.row_count = 0; ledger.omitted_row_count = 0;
      ledger.excluded_own_movement_count = 0; ledger.excluded_own_movement_minor = 0;
      ledger.inflows_received_minor = sumMinor(received);
      ledger.refunds_received_minor = sumMinor(refunds);
      ledger.inflow_rows = received.map(row => ({ n: cite(row).n, posted_on: row.posted_on, amount_minor: row.amount_minor }));
      ledger.refund_rows = refunds.map(row => ({ n: cite(row).n, posted_on: row.posted_on, amount_minor: row.amount_minor }));
      const receiptText = refunds.length === received.length ? 'refunds received' : 'money received';
      return { answer: received.length
        ? `No spending at ${safeDescription(intent.match)}; ${receiptText}: ${money(sumMinor(received))} ${refs(received)}.\n${bounded}`
        : 'No ordinary spending remains in this named selection; payments are listed separately.', citations, ledger };
    }
    if (namedOutflowMerchant && !matched.length) {
      const possible = orderedVendorRows(withoutLead(namedOutflowMerchant.possible));
      if (possibleIdentity.length) {
        const members = possibleIdentityMembers();
        Object.assign(ledger, { total_minor: null, lead_total_minor: null, complete: false,
          found: null, match_basis: "possible", row_count: 0, closest_payees: [],
          possible_identity_count: members.length, possible_identity_members: members,
          coverage: vendorCoverage(possibleIdentity) });
        ledger.if_own_transfers.total_minor = null;
        ledger.if_own_transfers.complete = false;
        return refundResult({ answer: `No charges found for ${safeDescription(intent.match)} from ${intent.from} to ${intent.to} on ${accounts.map(masked).join(", ")}.` +
          possibleIdentityLine(members) + '\nNo store total is confirmed.', citations, ledger });
      }

      if (possible.length) {
        // Description text can suggest review candidates, but it is not vendor
        // identity evidence. Keep counts as the default; any mixed-payment
        // description subtotal below remains separate from the named amount.
        const possibleLedger = {
          kind: intent.kind, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
          match_basis: "possible", complete: false, found: null,
          row_count: possible.length, possible_match_count: possible.length,
          ...familyAmbiguity,
          coverage: vendorCoverage(possible),
          excluded_own_movement_count: namedOutflowMerchant.possible.length - possible.length,
        };
        answer = `I found ${possible.length} transaction${possible.length === 1 ? " mentioning" : "s mentioning"} "${safeDescription(intent.match)}", but the bank did not name it as the payee, so no store total is confirmed.\n${balanceSuggestion}\n` +
          vendorCoverageLine(possibleLedger.coverage) + familyAmbiguityLine;
        // In a mixed description selection, explain both sides of the payment
        // partition without promoting a memo into a named merchant total.
        const descriptionRows = possible.filter(row => !row.payee && matchesDescriptionKeyword(row, intent.match));
        const hasDescriptionPayment = namedSelection.possible.some(row => excludedPayments.has(row.id) &&
          !row.payee && matchesDescriptionKeyword(row, intent.match));
        if (hasDescriptionPayment && descriptionRows.length) {
          possibleLedger.total_minor = null;
          possibleLedger.possible_subtotal_minor = sumMinor(descriptionRows);
          answer += `\nOrdinary outflows with description matching "${safeDescription(intent.match)}": ${money(possibleLedger.possible_subtotal_minor)} ${refs(descriptionRows)}; payee attribution remains unconfirmed.`;
        }
        return refundResult({ answer, citations, ledger: possibleLedger });
      }
      const suggestions = closestPayeeNames(namedOutflowMerchant.directionRows, intent.match);
      // Payment partitioning must not erase uncertain identity candidates.
      const possibleCandidates = namedSelection.possible.length;
      ledger.match_basis = possibleCandidates ? "possible" : "none";
      if (possibleCandidates) ledger.possible_match_count = possibleCandidates;
      ledger.complete = false; ledger.found = possibleCandidates ? null : false; ledger.total_minor = null;
      ledger.row_count = 0; ledger.closest_payees = suggestions;
      ledger.coverage = vendorCoverage([]);
      ledger.excluded_own_movement_count = namedOutflowMerchant.matched.length + namedOutflowMerchant.possible.length;
      ledger.excluded_own_movement_minor = sumMinor([...namedOutflowMerchant.matched, ...namedOutflowMerchant.possible]
        .filter(row => leadExcluded.has(row.id)));
      ledger.if_own_transfers.total_minor = null; ledger.if_own_transfers.complete = false;
      // Absence is bounded to the covered accounts, never a zero or a claim
      // about missing bank history. Suggestions carry no amounts or citations.
      answer = `No charges found for ${safeDescription(intent.match)} from ${intent.from} to ${intent.to} on ${accounts.map(masked).join(", ")}.` +
        (suggestions.length ? `\nPossible matches: ${suggestions.join("; ")}.` : "");
      Object.assign(ledger, familyAmbiguity);
      return refundResult({ answer, citations, ledger });
    }
    const unsorted = (intent.kind === "category" ? directionRows : matched).filter(row => !categoryFor(row));
    const explicitBucket = intent.kind === "category" && isUncategorizedBucket(intent.match);
    const topicLabel = explicitBucket ? "the uncategorized bucket" : safeDescription(intent.match);
    if (explicitBucket) { ledger.category_bucket = "uncategorized"; ledger.complete = true; }
    // Unclassified rows cannot prove that an arbitrary requested topic had
    // a complete topic amount, even beside confirmed category rows. Keep both
    // evidence groups and report a confirmed subtotal, even when it is zero.
    if (intent.kind === "category" && intent.match && !explicitBucket && unsorted.length) {
      ledger.total_minor = null; ledger.lead_total_minor = null; ledger.found = null;
      ledger.expense_total_minor = null;
      ledger.unsorted_minor = sumMinor(unsorted); ledger.unconfirmed_category_count = unsorted.length; ledger.complete = false;
      ledger.category_total_unconfirmed = true;
      if (intent.categorySelector) {
        ledger.category_selector = intent.categorySelector;
        ledger.selector_unresolved = !intent.categorySelectorResolved;
      }
      ledger.if_own_transfers.total_minor = null;
      ledger.if_own_transfers.complete = false;
      answer = `I found transactions without a confirmed category, so the total for ${safeDescription(intent.match)} is unconfirmed.`;
      for (const row of matched) cite(row);
      const confirmed = matched.filter(row => row.category_basis_state === "confirmed");
      // A subtotal needs a resolved category identity as well as confirmed rows.
      ledger.confirmed_category_subtotal_minor = categoryResolution && !categoryResolution.resolved ? null : sumMinor(confirmed);
      if (ledger.confirmed_category_subtotal_minor !== null)
        answer += `\nConfirmed in ${safeDescription(intent.match)} (subtotal): ${money(ledger.confirmed_category_subtotal_minor)} ${refs(confirmed)}.`;
      answer += `\nTransactions without a confirmed category: ${unsorted.length} rows totaling ${money(ledger.unsorted_minor)} ${refs(unsorted)}; left out of the confirmed category subtotal.`;
      answer += categoryExclusionNote;
      answer += `\n${bounded}\n${originalRecordSuggestion}`;
      return refundResult({ answer, citations, ledger });
    }
    ledger.total_minor = sumMinor(matched); ledger.unsorted_minor = sumMinor(unsorted); ledger.found = matched.length > 0;
    if (namedOutflowMerchant) { ledger.match_basis = "exact"; ledger.complete = omittedAccounts.length === 0; }
    ledger.lead_total_minor = sumMinor(withoutLead(matched));
    if (intent.paymentCitationDetails) ledger.amount_citations = withoutLead(matched).map(row => cite(row).n);
    leadDetail = `Total money ${intent.direction === "inflow" ? "in" : "out"}${intent.match ? ` for ${topicLabel}` : ` by ${intent.kind}`}: ${money(ledger.lead_total_minor)}; Unsorted: ${money(sumMinor(withoutLead(unsorted)))}.`;
    ledger.if_own_transfers.total_minor = sumMinor(withoutCandidates(matched));
    ledger.if_own_transfers.unsorted_minor = sumMinor(withoutCandidates(unsorted));
    conditionalDetail = `total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${topicLabel}` : ` by ${intent.kind}`}: ${money(ledger.if_own_transfers.total_minor)}; Unsorted: ${money(ledger.if_own_transfers.unsorted_minor)}`;
    const groups = new Map();
    const familyBreakdown = namedOutflowMerchant && withoutLead(namedOutflowMerchant.family).length > 0;
    for (const row of matched) {
      const label = intent.kind === "category" ? categoryFor(row) : familyBreakdown ? row.payee : merchantFor(row) || "unknown merchant";
      if (intent.kind === "category" && !label) continue;
      const state = intent.kind === "category" ? row.category_basis_state : null;
      const key = JSON.stringify([label, state]);
      if (!groups.has(key)) groups.set(key, { label, state, rows: [] });
      groups.get(key).rows.push(row);
    }
    const orderedGroups = [...groups.values()];
    if (intent.ranked) orderedGroups.sort((a, b) => sumMinor(b.rows) - sumMinor(a.rows) || a.label.localeCompare(b.label));
    if (intent.kind === "merchant" && intent.direction === "outflow" && intent.match) {
      const possible = orderedVendorRows(withoutLead(namedOutflowMerchant.possible));
      const family = withoutLead(namedOutflowMerchant.family);
      const nameOnly = withoutLead(namedOutflowMerchant.nameOnly || namedOutflowMerchant.family);
      const includesFamily = family.length > 0;
      const basis = includesFamily ? "family" : "exact";
      // Mixed subtotals and composed months need complete membership, as do
      // family breakdowns beyond the compact exact-vendor citation limit.
      const citedRows = includesFamily || possible.length || intent.paymentCitationDetails ? matched : matched.slice(0, 5);
      for (const row of citedRows) cite(row);
      Object.assign(ledger, familyAmbiguity);
      if (includesFamily) {
        ledger.match_basis = basis;
        ledger.exact_match_count = withoutLead(namedOutflowMerchant.exact).length;
        ledger.family_match_count = family.length;
      }
      ledger.row_count = matched.length;
      ledger.omitted_row_count = Math.max(0, matched.length - citedRows.length);
      ledger.coverage = vendorCoverage([...matched, ...possible]);
      ledger.excluded_own_movement_count = namedOutflowMerchant.matched.length + namedOutflowMerchant.possible.length -
        matched.length - possible.length;
      ledger.excluded_own_movement_minor = sumMinor([...namedOutflowMerchant.matched, ...namedOutflowMerchant.possible]
        .filter(row => leadExcluded.has(row.id)));
      ledger.groups = orderedGroups.map(g => ({ merchant: safeDescription(includesFamily ? g.rows[0].payee : g.label),
        ...(includesFamily ? { count: g.rows.length } : {}),
        category_basis_state: g.state, total_minor: sumMinor(g.rows),
        citations: g.rows.flatMap(row => references.has(row.id) ? [references.get(row.id).n] : []),
        possible_transfer_citations: g.rows.flatMap(row => pairing.candidateRows.has(row.id) && references.has(row.id)
          ? [references.get(row.id).n] : []),
        if_own_transfers_total_minor: sumMinor(withoutCandidates(g.rows)) }));
      const compactPublicRow = row => {
        const existing = references.get(row.id);
        const ref = existing || { ...citation(row, bySlug.get(row.effective_account_slug), 0, intent.presentation), n: null };
        return { ...ref, description: safeDescription(row.description || row.payee || "Transaction"),
          possible_own_transfer: pairing.candidateRows.has(row.id) };
      };
      ledger.transfers = pairs.map(pair => ({ candidate: true, excluded_from_totals: false, reason: pair.reason,
        amount_minor: pair.out.amount_minor, outgoing: compactPublicRow(pair.out), incoming: compactPublicRow(pair.in),
        excluded_from_lead: [pair.out, pair.in].some(row => leadExcluded.has(row.id)), kept_reason: keptPairs.get(pair) || null }));
      ledger.unmatched_transfers = unmatched.map(compactPublicRow);
      const displayVendor = matched.find(row => row.payee &&
        normalizeMerchantText(row.payee) === normalizeMerchantText(intent.match))?.payee || intent.match;
      const markers = citedRows.map(row => `[${references.get(row.id).n}]`).join(" ");
      const omitted = ledger.omitted_row_count ? `${markers ? " " : ""}and ${ledger.omitted_row_count} more rows` : "";
      const evidence = `${markers}${omitted}`.trim();
      if (nameOnly.length) {
        // Similar names are review candidates. Neither the main figure nor
        // the conditional transfer view can certify their combined amount.
        const exactRows = withoutLead(namedOutflowMerchant.exact);
        ledger.match_basis = "name_match";
        ledger.complete = false;
        ledger.exact_subtotal_minor = sumMinor(exactRows);
        ledger.name_match_subtotal_minor = sumMinor(family);
        ledger.total_minor = null;
        ledger.lead_total_minor = null;
        ledger.if_own_transfers.total_minor = null;
        ledger.if_own_transfers.complete = false;
        ledger.if_own_transfers.exact_subtotal_minor = sumMinor(withoutCandidates(exactRows));
        ledger.if_own_transfers.name_match_subtotal_minor = sumMinor(withoutCandidates(family));
        if (possible.length) {
          ledger.possible_match_count = possible.length;
          ledger.possible_subtotal_minor = sumMinor(possible);
        }
        answer = 'Exact payee subtotal for "' + safeDescription(displayVendor) + '": ' + money(ledger.exact_subtotal_minor) + '. ' +
          'Matched by name, not confirmed: ' + money(ledger.name_match_subtotal_minor) + ' combined subtotal. ' +
          'Are these payees the same company? No complete store total is confirmed.';
      } else if (possible.length) {
        ledger.match_basis = `${basis}_and_possible`;
        ledger.complete = false;
        if (!includesFamily) ledger.exact_match_count = matched.length;
        ledger.possible_match_count = possible.length;
        ledger[`${basis}_subtotal_minor`] = ledger.total_minor;
        ledger.possible_subtotal_minor = sumMinor(possible);
        ledger.possible_citations = possible.map(row => cite(row).n);
        ledger[`lead_${basis}_subtotal_minor`] = ledger.lead_total_minor;
        ledger.lead_total_minor = null;
        ledger.if_own_transfers[`${basis}_subtotal_minor`] = ledger.if_own_transfers.total_minor;
        ledger.if_own_transfers.possible_subtotal_minor = sumMinor(withoutCandidates(possible));
        ledger.if_own_transfers.total_minor = null;
        ledger.if_own_transfers.complete = false;
        ledger.total_minor = null;
        answer = `Here is a partial view for "${safeDescription(displayVendor)}": the bank names ${includesFamily ? "these payees" : "it"} on charges totaling ` +
          `${money(ledger[`${basis}_subtotal_minor`])} ${evidence}; another ${money(ledger.possible_subtotal_minor)} ${ledger.possible_citations.map(n => `[${n}]`).join(" ")} only mentions it in the transaction text. ` +
          `These amounts stay separate, with no complete store total confirmed.\n${balanceSuggestion}`;
      } else if (!ledger.coverage.complete) {
        ledger.partial_subtotal_minor = ledger.total_minor;
        ledger.total_minor = null;
        answer = `Here is a partial subtotal for "${safeDescription(displayVendor)}": the charges I can use total ` +
          `${money(ledger.partial_subtotal_minor)} ${compactPeriodLabel(intent)}; ${omittedAccounts.length} account${omittedAccounts.length === 1 ? " is" : "s are"} missing some dates: ${accountEndings(omittedAccounts)}.\n${balanceSuggestion}`;
      } else answer = `You spent ${money(ledger.total_minor)} at ${safeDescription(displayVendor)} ${compactPeriodLabel(intent)}.`;
      if (evidence && !possible.length) answer = answer.includes(`\n${balanceSuggestion}`)
        ? answer.replace(`.\n${balanceSuggestion}`, ` ${evidence}.\n${balanceSuggestion}`) : `${answer} ${evidence}.`;
      if (includesFamily) {
        ledger.included_payees = ledger.groups.map(g => g.merchant);
        for (const group of ledger.groups) answer += `\n${group.merchant}${nameOnly.length && family.some(row => safeDescription(row.payee) === group.merchant) ? " (matched by name, not confirmed)" : " (recorded payee)"}: ${money(group.total_minor)} across ${group.count} ${group.count === 1 ? "row" : "rows"} ${group.citations.map(n => `[${n}]`).join(" ")}.`;
        answer += `\nIncluded payees: ${ledger.included_payees.join("; ")}.`;
      }
      if (possibleIdentity.length) {
        const members = possibleIdentityMembers();
        ledger.possible_identity_count = members.length;
        ledger.possible_identity_members = members;
        // Explicitly scope the certified number to confirmed identities. The
        // separate candidates are evidence for review, never amount evidence.
        if (!ledger.included_payees) ledger.included_payees = ledger.groups.map(g => g.merchant);
        answer += possibleIdentityLine(members);
      }
      answer += `\n${vendorCoverageLine(ledger.coverage)}`;
      answer += familyAmbiguityLine;
      return refundResult({ answer, citations, ledger });
    }
    ledger.groups = orderedGroups.map(g => ({ [intent.kind]: safeDescription(g.label),
      category_basis_state: g.state, total_minor: sumMinor(g.rows), citations: g.rows.map(row => cite(row).n),
      possible_transfer_citations: g.rows.filter(row => pairing.candidateRows.has(row.id)).map(row => cite(row).n),
      if_own_transfers_total_minor: sumMinor(withoutCandidates(g.rows)) }));
    answer = `Total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${topicLabel}` : ` by ${intent.kind}`}: ${money(ledger.total_minor)}.`;
    if (!matched.length) answer += " No matching transactions found.";
    for (const g of orderedGroups) answer += `\n${safeDescription(g.label)}${g.state === "proposed" ? " (bank's category (unconfirmed))" : ""}: ${money(sumMinor(g.rows))} ${refs(g.rows)}${g.rows.some(row => pairing.candidateRows.has(row.id)) ? " (includes possible moves between your own accounts)" : ""}.`;
    if (orderedGroups.some(group => group.state === "proposed")) answer += `\nHere are the spending categories from your bank; those marked unconfirmed have not been reviewed.\n${balanceSuggestion}`;
    if (intent.kind === "category" && unsorted.length) {
      ledger.unconfirmed_category_count = unsorted.length;
      answer += '\nUnconfirmed categories: ' + unsorted.length + ' rows totaling ' + money(ledger.unsorted_minor) + '; left out of confirmed category totals.';
    }
    answer += `\nUnsorted: ${money(ledger.unsorted_minor)}${intent.kind === "category" && intent.match && !matched.some(row => !categoryFor(row)) ? " (separate from the requested category)" : ""} ${refs(unsorted)}.`;
    answer += categoryExclusionNote;
    if (incompleteNamed) {
      const subtotal = amount => (amount > 0
        ? `Income from that payer is at least ${money(amount)} (matched subtotal, not complete); ` : "") +
        `I can help review the deposits, but the full income from that payer is unconfirmed. There ${inflows.length === 1 ? "is 1 deposit" : `are ${inflows.length} deposits`}, and ${inflows.length === 1 ? "its bank label may" : "their bank labels may"} not identify who paid.\n${balanceSuggestion}`;
      leadDetail = subtotal(ledger.lead_total_minor) + payerAssumptionNote(matched);
      answer = `${subtotal(ledger.total_minor)} ${refs(matched)}`.trim() + payerAssumptionNote(matched);
      conditionalDetail = subtotal(ledger.if_own_transfers.total_minor) + payerAssumptionNote(matched);
      ledger.attributed_subtotal_minor = matched.length ? ledger.total_minor : null;
      ledger.lead_attributed_subtotal_minor = matched.length ? ledger.lead_total_minor : null;
      ledger.total_minor = null; ledger.lead_total_minor = null;
      ledger.found = matched.length ? true : null;
      ledger.if_own_transfers.attributed_subtotal_minor = matched.length ? ledger.if_own_transfers.total_minor : null;
      ledger.if_own_transfers.total_minor = null;
      ledger.if_own_transfers.complete = false;
      for (const group of ledger.groups) {
        group.attributed_subtotal_minor = group.total_minor; group.total_minor = null;
        group.if_own_transfers_attributed_subtotal_minor = group.if_own_transfers_total_minor;
        group.if_own_transfers_total_minor = null; group.complete = false;
      }
    } else if (payerIncome && !inflows.length) {
      answer = "No deposits at all in this period.";
    }
    if (payerReading) {
      if (intent.kind === "merchant") {
        ledger.complete = false;
        ledger.attribution_incomplete = true;
        for (const group of ledger.groups) group.complete = false;
      }
      if (notPayments.length) {
        // Never a payer and never income; each credit keeps its own amount.
        ledger.not_payments = { total_minor: sumMinor(notPayments), count: notPayments.length,
          rows: notPayments.map(row => ({ n: cite(row).n, amount_minor: row.amount_minor, posted_on: row.posted_on, reason: notPaymentReason(row), verified: provedOwnInflowIds.has(row.id) })) };
        answer += `\nNot counted as payments to you: ${money(ledger.not_payments.total_minor)} (` +
          notPayments.map(row => `${notPaymentReason(row)} ${money(row.amount_minor)} [${cite(row).n}]`).join("; ") + ").";
      }
      if (intent.kind === "merchant") answer += `\nBank payee names may not identify who paid, so the sender of every deposit is still unconfirmed.\n${balanceSuggestion}`;
    }
  } else if (intent.kind === "transfers") {
    // This diagnostic view keeps its gross, outgoing-date contract. Other
    // answer kinds apply lead exclusions to each leg inside their own window.
    const found = pairs.filter(pair => inWindow(pair.out)).sort((a, b) => b.out.posted_on.localeCompare(a.out.posted_on) || b.out.id - a.out.id);
    const outgoing = intent.limit ? found.slice(0, intent.limit) : found;
    // Equal amounts establish review candidates, never numeric membership.
    // Pairing already enforces opposite directions, currency and the window;
    // reciprocal owned endpoints supply the remaining authority to count.
    const counted = outgoing.filter(pair => isDirectedOwnedTransfer(pair, bySlug));
    ledger.total_minor = sumMinor(counted, pair => pair.out.amount_minor);
    ledger.found = outgoing.length > 0;
    if (intent.scopePlan?.type === 'transfer') {
      ledger.transfer_scope = { source: intent.scopePlan.source, destination: intent.scopePlan.destination,
        directed: intent.scopePlan.directed, confirmed_total_minor: ledger.total_minor,
        source_account_count: intent.transferSourceSlugs.length, destination_account_count: intent.transferDestinationSlugs.length };
    }
    answer = `Identified moves between your own accounts: ${money(ledger.total_minor)}, counted once by outgoing posting date.`;
    if (intent.storeMovements) answer += '\nThis is the subtotal of identified pairs, not a total of all possible own-account movements.';
    if (outgoing.length > counted.length) answer += '\nPossible transfers, not counted: equal-amount matches without reciprocal owned-account identification.';
    answer += `\nThis reading checks possible moves with enough account details to review; matching amounts alone do not confirm transfers, and no matches does not prove none occurred.\n${balanceSuggestion}`;
    {
      ledger.limit = intent.limit;
      ledger.rows = outgoing.map(pair => publicRow(pair.out));
      const transferLine = (row, pair) => rowLine(row).replace(candidateMark(row), counted.includes(pair)
        ? " (identified owned transfer, counted once)" : " (possible transfer, not counted)");
      answer += `\nShowing ${outgoing.length} of ${found.length} possible transfers, newest outgoing posting first.\n${outgoing.map(pair => `${transferLine(pair.out, pair)}; received ${transferLine(pair.in, pair)}.`).join('\n')}`;
      const transfers = outgoing.map(pair => ({ candidate: true, counted: counted.includes(pair), excluded_from_totals: !counted.includes(pair), reason: pair.reason, amount_minor: pair.out.amount_minor,
        outgoing: publicRow(pair.out), incoming: publicRow(pair.in) }));
      // The charge reader's existing owned-looking predicate preserves payment
      // candidates that the pairing reader cannot prove. Never add them to sums.
      const unmatchedRows = intent.storeMovements ? [...new Map([...unmatched,
        ...rows.filter(row => !pairing.candidateRows.has(row.id) && isOwnedMovement(row, bySlug))]
        .map(row => [row.id, row])).values()] : unmatched;
      const unmatchedTransfers = unmatchedRows.map(publicRow);
      for (const row of unmatchedRows) answer += `\nPossible transfer, unmatched (not counted): ${rowLine(row)}.`;
      // This count bounds pairs, including the diagnostic rows. The generic
      // totals appendix would otherwise print the entire uncapped pair pool.
      return { answer: `${answer}\n${bounded}`, citations: [...references.values()], ledger: {
        kind: 'transfers', from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        ...(ledger.transfer_scope ? { transfer_scope: ledger.transfer_scope } : {}), limit: intent.limit, total_minor: ledger.total_minor, found: ledger.found,
        match_count: found.length, rows: ledger.rows, transfers, unmatched_transfers: unmatchedTransfers, complete: omittedAccounts.length === 0,
      } };
    }
  } else if (intent.kind === "recurring") {
    const exactPayee = recurringSelectorResolved;
    const selectedRecurringActivity = exactPayee ? activity.filter(row => normalizeMerchantText(row.payee) === normalizeMerchantText(intent.recurringSelector)) : activity;
    // Reciprocal endpoints prove movement. Unpaired nominations stay possible
    // and reach the recurring reader's explicit uncertainty partition.
    const provedOwnedRows = new Set(pairs.filter(pair => isDirectedOwnedTransfer(pair, bySlug)).flatMap(pair => [pair.out.id, pair.in.id]));
    // Paying-account questions detect independently within each account so
    // simultaneous charges at one payee cannot erase one another's cadence.
    const readings = intent.payingAccount ? accounts.map(account => recurringReading(
      selectedRecurringActivity.filter(row => row.effective_account_slug === account.account_slug), intent.to, bySlug, provedOwnedRows, possibleMovementIds))
      : [recurringReading(selectedRecurringActivity, intent.to, bySlug, provedOwnedRows, possibleMovementIds)];
    const reading = Object.fromEntries(['confirmed','setAside','unresolved'].map(key => [key, readings.flatMap(r => r[key])]));
    const unresolvedOwnedRows = reading.unresolved;
    const recurring = reading.confirmed;
    const recurringActivity = recurring.flatMap(g => g.rows);
    ledger.set_aside_recurring = reading.setAside.map(g => ({
      payee: safeDescription(g.rows[0].payee || g.rows[0].description),
      amount_minor: g.typical_minor, cadence: g.cadence,
      dates: g.rows.map(row => row.posted_on), amounts_minor: g.rows.map(row => row.amount_minor),
      citations: g.rows.map(row => cite(row).n),
    }));
    const setAside = ledger.set_aside_recurring.length > 0;
    ledger.possible_owned_movements = unresolvedOwnedRows.map(row => ({ ...publicRow(row), posted_on: row.posted_on, amount_minor: row.amount_minor }));
    if (unresolvedOwnedRows.length) ledger.complete = false;
    const occurrences = group => intent.occurrenceLimit ? group.rows.slice(-intent.occurrenceLimit) : group.rows;
    const recurringGroups = list => intent.payingAccount ? accounts.flatMap(account => detectRecurring(
      list.filter(row => row.effective_account_slug === account.account_slug), intent.to)) : detectRecurring(list, intent.to);
    ledger.recurring = recurring.map(g => ({ merchant: safeDescription(g.merchant), cadence: g.cadence,
      typical_minor: g.typical_minor, monthly_minor: g.monthly_minor, last_charge: g.last_charge,
      ...(intent.payingAccount ? { account_mask: /^\d{1,4}$/.test(bySlug.get(g.rows[0].effective_account_slug).mask || '')
        ? bySlug.get(g.rows[0].effective_account_slug).mask : null, cadence_dates: g.rows.map(row => row.posted_on) } : {}),
      last_amount_minor: g.rows.at(-1).amount_minor, occurrence_count: g.rows.length, detected: true,
      ...(intent.interpretation ? { occurrences: occurrences(g).map(row => ({ posted_on: row.posted_on, amount_minor: row.amount_minor, account_mask: bySlug.get(row.effective_account_slug).mask })) } : {}),
      citations: occurrences(g).map(row => cite(row).n), possible_transfer_citations: occurrences(g).filter(row => pairing.candidateRows.has(row.id)).map(row => cite(row).n) }));
    ledger.confirmed_subtotal_minor = sumMinor(recurring, g => g.monthly_minor);
    ledger.total_minor = setAside ? null : ledger.confirmed_subtotal_minor;
    ledger.monthly_total_minor = ledger.total_minor; ledger.found = recurring.length > 0 || setAside;
    ledger.lead_monthly_total_minor = setAside ? null : sumMinor(recurringGroups(withoutLead(recurringActivity)), g => g.monthly_minor);
    leadDetail = `Estimated monthly money out: ${money(ledger.lead_monthly_total_minor)} (detected, not confirmed).`;
    ledger.if_own_transfers.monthly_total_minor = setAside ? null : sumMinor(recurringGroups(withoutCandidates(recurringActivity)), g => g.monthly_minor);
    conditionalDetail = `estimated monthly total: ${money(ledger.if_own_transfers.monthly_total_minor)}`;
    answer = "Recurring charges detected, not confirmed. " + (recurring.length ? recurring.map(g =>
      `${safeDescription(g.merchant)}: ${g.cadence}, typical ${money(g.typical_minor)}; last charge ${money(g.rows.at(-1).amount_minor)} on ${intent.presentation.date(g.last_charge)}${intent.payingAccount ? `; paying account ${masked(bySlug.get(g.rows[0].effective_account_slug))}; cadence evidence ${g.rows.map(row => intent.presentation.date(row.posted_on)).join(', ')}` : ''} ${refs(g.rows)}.`).join("\n") : "No recurring charges detected.");
    if (unresolvedOwnedRows.length && !setAside) answer += '\nPossible transfers or payments between your own accounts (unresolved; recurring list incomplete):\n' + unresolvedOwnedRows.map(row => `${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)} in ${masked(bySlug.get(row.effective_account_slug))} ${refs([row])}.`).join('\n');
    answer += `\nI can show repeated bank charges as possible patterns, but they do not prove an active subscription; no detected pattern does not prove none exists.\n${balanceSuggestion}`;
    if (!setAside) answer += `\nEstimated monthly total: ${money(ledger.monthly_total_minor)} (weekly amounts use 52/12, rounded to cents per merchant).`;
    if (setAside) {
      answer = recurringSetAsideText(ledger);
      leadDetail = answer;
      conditionalDetail = 'no overall recurring total while charges are set aside';
    }
    if (exactPayee) {
      ledger.selector_applied = true;
      if (!recurringActivity.length && excludedPayments.size) {
        const kinds = [...new Set([...excludedPayments.values()].map(item => item.liabilityKind))];
        const kind = kinds.length === 1 ? kinds[0] : 'loan or card';
        let paymentAnswer = `${safeDescription(intent.recurringSelector)}: that is a payment to your ${kind}, listed separately.`;
        const paymentPatterns = detectRecurring([...excludedPayments.values()].map(item => item.row), intent.to);
        for (const group of paymentPatterns) paymentAnswer += ` ${group.cadence}, typical ${money(group.typical_minor)}; estimated monthly payment ${money(group.monthly_minor)}.`;
        answer = `${paymentAnswer}\n${answer}`;
      }
    }
    if (intent.interpretation) answer += `\nLast ${intent.occurrenceLimit || 10} recorded occurrences of each detected series (up to that limit):\n${recurring.map(g => `${safeDescription(g.merchant)}: ${occurrences(g).slice(-(intent.occurrenceLimit || 10)).map(rowLine).join('; ')}`).join('\n')}`;
    if (intent.annualRecurrenceUnavailable) answer += '\nI checked 400 days for weekly and monthly patterns, but yearly patterns are not assessed. Want to review the weekly and monthly charges?';
    if (setAside) ledger.recurring_context = answer.slice(recurringSetAsideText(ledger).length).trim();
  } else throw new Error("unsupported ledger intent");
  ledger.transfers = pairs.map(pair => ({ candidate: true, excluded_from_totals: false, reason: pair.reason,
    amount_minor: pair.out.amount_minor, outgoing: publicRow(pair.out), incoming: publicRow(pair.in),
    excluded_from_lead: [pair.out, pair.in].some(row => leadExcluded.has(row.id)), kept_reason: keptPairs.get(pair) || null }));
  // Exactly identified liability payments have their own explanation below;
  // they must not reappear as uncertain, unmatched transfers.
  const unmatchedTransfers = unmatched.filter(row => !expensePayments.has(row.id));
  ledger.unmatched_transfers = unmatchedTransfers.map(publicRow);
  if (categoryOwned.size) {
    // Keep flags and copy tied to the exact category membership decision. A
    // gross policy flip cannot turn an excluded movement/payment into spending.
    delete ledger.known_own_transfer_in_lead;
    for (const [index, transfer] of ledger.transfers.entries()) if (categoryOwned.has(pairs[index].out.id)) {
      transfer.excluded_from_totals = true; transfer.excluded_from_lead = true; transfer.kept_reason = null;
    }
  }
  const movementRowLine = (row, pair) => {
    const line = rowLine(row), mark = candidateMark(row);
    if (!categoryOwned.has(pair.out.id)) return line;
    const label = ' (excluded from category spending; raw record retained)';
    return mark ? line.replace(mark, label) : line + label;
  };
  const restored = intent.ownTransfers === "include" && intent.withdrawals === "include" && !leadExcluded.size;
  if (intent.measure || (!restored && (leadExcluded.size || keptPairs.size || intent.kind === 'totals' && excludedPayments.size))) {
    const notes = [];
    if (intent.kind === 'totals' && excludedPayments.size)
      notes.push('payments to loans and cards stay outside spending and income');
    if (noteSummary.own_transfer_pairs) {
      if (categoryOwned.size) notes.push(`${money(noteSummary.own_transfer_minor)} between your own connected accounts excluded from category spending; raw records retained`);
      else if (payerListing) notes.push(`${money(noteSummary.own_transfer_minor)} between your own connected accounts excluded from payer income`);
      else { notes.push(`${money(noteSummary.own_transfer_minor)} between your own connected accounts left out of the first figures; say "including transfers" to count those moves`); ledger.flip.push('including transfers'); }
    }
    if (noteSummary.withdrawal_count) { notes.push(`${money(noteSummary.withdrawal_minor)} in retirement or investment withdrawals left out of the first figures; say "including withdrawals" to count them`); ledger.flip.push("including withdrawals"); }
    if (noteSummary.loan_proceeds_count) { notes.push(`${money(noteSummary.loan_proceeds_minor)} in loan or line-of-credit proceeds left out of the first figures; say "including loan proceeds" to count them`); ledger.flip.push("including loan proceeds"); }
    if (expensePayments.size) notes.push(paymentSummaryLabel([...expensePayments.values()]).startsWith('Payments to your own')
      ? "payments to your own loan/card accounts are shown separately from expenses" : "payments to loans and cards are shown separately from expenses");
    if (unchangedLimitedList && [...leadExcluded.keys()].some(id => !expensePayments.has(id))) notes.push("exclusions apply to the wider candidate pool; the displayed rows are unchanged");
    if (!unchangedLimitedList && [...keptPairs.values()].some(reason => reason.startsWith("other account"))) {
      notes.push('moves with an account outside this question are kept; say "excluding transfers" to leave them out'); ledger.flip.push("excluding transfers");
    }
    if (!notes.length) notes.push(keptPairs.size ? "paired activity stays where listed below" : "only checking, savings and card accounts contribute to money in minus money out");
    // Gross sentences retain their wording and citation order for existing clients.
    const grossHeading = categoryOwned.size ? 'Recorded category spending (excluded movements remain excluded):' : 'With everything counted:';
    answer = `${leadDetail || answer}\nNote: ${notes.join('; ')}.\n${grossHeading}\n${answer}\n${bounded}`;
    const omittedPairs = pairs.filter(pair => !expensePayments.has(pair.out.id) &&
      [pair.out, pair.in].some(row => noteExcluded.has(row.id)));
    if (omittedPairs.length) {
      answer += categoryOwned.size ? "\nRaw movement records (category exclusions are marked):" : "\nMoves between your own connected accounts, left out of the first figures:";
      const leadRowLine = (row, pair) => categoryOwned.has(pair.out.id) ? movementRowLine(row, pair) : rowLine(row).replace(candidateMark(row), leadExcluded.has(row.id)
        ? ` (left out of the first figures as ${leadExcluded.get(row.id)})` : " (outside this answer's accounts or period)");
      for (const pair of omittedPairs) answer += `\n${leadRowLine(pair.out, pair)}; received ${leadRowLine(pair.in, pair)}. Why: ${pair.reason}.`;
    }
    if (keptPairs.size) answer += "\nKept pairs:";
    for (const [pair, reason] of keptPairs) answer += `\n${movementRowLine(pair.out, pair)}; received ${movementRowLine(pair.in, pair)}. ${categoryOwned.has(pair.out.id) ? "Excluded from category spending" : reason}.`;
  } else {
    answer += `\n${bounded}\n${categoryOwned.size || intent.kind === 'category' && excludedPayments.size ? 'Movement/payment records marked excluded remain outside category spending.' : ownMovementCandidates ? 'Possible transfers are included in income and spend, except the possible transfers to your own accounts listed below.' : notPayments.length ? 'Credits that are not payments to you are listed above and left out of every payer figure.' : 'Possible transfers are included in income and spend; no rows were removed as transfers.'}`;
    if (pairs.length) {
      answer += "\nPossible moves between your own accounts:";
      for (const pair of pairs) answer += `\n${movementRowLine(pair.out, pair)}; received ${movementRowLine(pair.in, pair)}. Why: ${pair.reason}.`;
      if (pairs.some(pair => !categoryOwned.has(pair.out.id))) answer += `\nIf these are transfers between your own accounts, with those candidates excluded: ${conditionalDetail}.`;
    }
  }
  const exclusionLabel = row => noteExcluded.has(row.id)
    ? `left out of the first figures as ${leadExcluded.get(row.id)}; kept in the gross figures`
    : `${leadExcluded.get(row.id)} excluded from the wider candidate pool; outside the displayed rows`;
  for (const row of unmatchedTransfers) answer += `\nPossible transfer, unmatched (${categoryOwned.has(row.id) ? "excluded from category spending; raw record retained" : leadExcluded.has(row.id)
    ? exclusionLabel(row)
    : "retained in income/spend totals"}): ${rowLine(row)}.`;
  if (categoryOwned.size) {
    const shown = new Set([...pairs.flatMap(pair => [pair.out.id, pair.in.id]), ...unmatchedTransfers.map(row => row.id)]);
    for (const row of categoryOwned.values()) if (!shown.has(row.id))
      answer += `\nExcluded movement/payment record: ${rowLine(row)}.`;
  }
  if (incompleteNamed) {
    const detail = inflowDetail(cite);
    ledger.complete = false; ledger.attribution_incomplete = true;
    ledger.inflow_count = inflows.length; ledger.inflows = detail.deposits;
    answer += `\n${detail.answer}`;
  }
  if (intent.answerAddOn === 'share' && intent.kind === 'largest' && intent.direction === 'outflow') {
    const share = ledger.share_of_total;
    answer += share ? `\nShare of total: ${money(share.listed_minor)} of ${money(share.total_minor)} in ordinary spending, ${share.percent}%, for the same accounts and ${intent.presentation.period(intent.from, intent.to)}.`
      : '\nI can show the listed expenses, but their share is unconfirmed without a complete positive spending total and confirmed expense types. Want to review the total first?';
  }
  if (ledger.set_aside_recurring?.length) {
    // Generic gross-transfer appendices describe rows as included. That is
    // false for these set-aside charges; keep only recurring qualifications
    // and the account/coverage boundary around the authoritative lists.
    const context = ['I can show repeated bank charges as possible patterns, but they do not prove an active subscription.',
      ledger.recurring_context, bounded].filter(Boolean).join('\n');
    answer = [recurringSetAsideText(ledger), context].join('\n');
    ledger.recurring_context = context + '\n' + pendingNotice;
  }
  return refundResult({ answer, citations, ledger });
}

// The only integration point wraps the existing document path. Non-money
// responses return untouched, including their exact serialized bytes.

async function withHeadLedgerAnswer(options, next) {
  const { env, question, now = Date.now(), access, grantScope, scopePrincipalKind,
    filters = {}, entityScope, ledgerEligible = true } = options;
  const timeZone = env.BRAIN_TIMEZONE ?? null;
  const evaluated = { ...options, now };
  const parsed = classifyLedgerQuestion(question, { now, timeZone });
  if (parsed.kind) {
    const basis = refundBasisForOperand({ question, clause: question,
      intents: [{ vendor_text: parsed.match, account_hint: parsed.accountSelector }],
      operand: { kind: parsed.kind, direction: parsed.direction, vendor: parsed.match || null,
        monthlyBreakdown: parsed.monthlyBreakdown, count: 1 } });
    if (basis.descriptionOnly) parsed.netRefunds = true;
    if (basis.requested && !basis.descriptionOnly) parsed.refundsNotNetted = true;
  }
  // Grammar successes retain their route and zero-call latency.
  const eligible = !access && Boolean(grantScope) && scopeIsUnrestricted(grantScope) &&
    scopePrincipalKind === "owner" && !entityScope?.applied && Object.keys(filters).length === 0 && ledgerEligible;
  const decision = !parsed.kind && eligible ? await extractLedgerIntentDecision({
    env, question, now, timeZone, callLLM: options.callLLM,
  }) : null;
  if (decision?.outcome === 'fallback' && (decision.calendarRefused || ['period_contradiction', 'date_literal_mismatch'].includes(decision.reason))) {
    return Response.json({ mode: 'think', answer: (decision.futurePeriod ? 'This period has not happened yet. No ledger figure is shown.' : 'I could not resolve every requested date or period. No ledger figure is shown; please clarify the date range.') + (decision.unreadCalendar?.length ? ' Unread calendar words: "' + decision.unreadCalendar.join(' ... ') + '".' : ''),
      citations: [], results: [], gaps: [{ type: 'ledger_not_consulted', reason: decision.reason, scope: 'calendar' }],
      evidence_gate: { supported: false, complete: false } });
  }
  const extracted = decision && decision.outcome !== 'fallback' ? decision.intents : null;
  if ((decision?.scopePlan || decision?.operandClauses) && extracted?.length) {
    try {
      const inventory = await readEffectiveAccounts(env);
      // Literal account recognition must precede the committed operand scope.
      // A whole-owner placeholder cannot authorize rows after reinterpretation.
      if (!decision.scopePlan || decision.scopePlan.type === 'operands') {
        for (const intent of extracted) {
          recognizeLiteralAccount(inventory, intent, moneyPresentation({ now, timeZone }));
        }
      }
      // Rebind shared literals after inventory recognition, independently of
      // provider operation kinds. Missing selectors cannot authorize broad rows.
      if (decision.operandClauses && (!decision.scopePlan || decision.scopePlan.type === 'operands')) {
        decision.scopePlan = ledgerOperandScopePlan(decision.operandClauses, extracted);
        for (const [index, intent] of extracted.entries()) {
          const selector = decision.scopePlan.selectors[index];
          if (typeof selector === 'string' && !intent.modelAccountScope) {
            intent.modelAccountScope = selector;
            intent.interpretation = ledgerIntentInterpretation(intent, moneyPresentation({ now, timeZone }));
          }
        }
      }
      const resolved = resolvedLedgerScopePlan(inventory, decision.scopePlan);
      const scopeLiterals = decision.scopePlan.type === 'transfer' ? [decision.scopePlan.source, decision.scopePlan.destination] : decision.scopePlan.selectors;
      const emptyOwnership = scopeLiterals.map(literal => typeof literal === 'string' ? resolveOwnershipScope(inventory, literal) : null);
      if (resolved.reason && emptyOwnership.every(scope => scope && !resolveLedgerScope(inventory, scope.selector).length)) return Response.json({
        mode: 'think', code: 'no_accounts', ownership_scope_empty: true, ledger: null,
        answer: 'No confirmed accounts matching the requested account name and ownership scope were found. Ownership may be unconfirmed for other accounts.',
        citations: [], results: [], gaps: [{ type: 'ledger_not_consulted', reason: 'no_accounts' }],
        evidence_gate: { supported: false, complete: false, reason: 'no_accounts' },
      });
      if (resolved.reason) return Response.json({ mode: 'think', answer: `The requested scopes are ${resolved.reason === 'scope_overlap' ? 'overlapping' : 'unresolved'} in the confirmed account inventory. No scoped total or difference is shown.`,
        citations: [], results: [], gaps: [{ type: 'ledger_not_consulted', reason: resolved.reason }],
        ledger: { kind: 'scope_refused', complete: false, reason: resolved.reason }, evidence_gate: { supported: false, complete: false } });
      for (const [index, intent] of extracted.entries()) {
        intent.scopePlan = decision.scopePlan;
        intent.scopeInventory = JSON.stringify(inventory);
        intent.scopeSlugs = decision.scopePlan.type !== 'transfer' ? resolved.slugs[index] : resolved.slugs.flat();
        if (decision.scopePlan.type === 'transfer') [intent.transferSourceSlugs, intent.transferDestinationSlugs] = resolved.slugs;
      }
    } catch {
      return Response.json({ mode: 'think', answer: 'The confirmed account inventory is unavailable. No scoped total or difference is shown.',
        citations: [], results: [], gaps: [{ type: 'ledger_not_consulted', reason: 'ledger_unavailable' }],
        ledger: { kind: 'scope_refused', complete: false, reason: 'ledger_unavailable' }, evidence_gate: { supported: false, complete: false } });
    }
  }
  const readings = extracted || (parsed.kind ? [parsed] : []);
  // Inject the shared parser/formatters into the focused composer rather than
  // introducing a second import path through the parser's dependency graph.
  const compoundPlan = (intents, labels = []) => compoundBalanceOperands(question, intents, labels,
    { normalizeLedgerIntentWords, ledgerClauseRefusalReason });
  let compound = eligible && (compoundPlan(readings) || compoundPlan([]));
  if (compound) {
    // Only stored labels can protect a conjunction from operand splitting.
    // A model's broad multi-account hint cannot hide a requested operand.
    try {
      const inventory = await readEffectiveAccounts(env);
      // Without bank accounts, the existing document path still owns sources
      // such as QuickBooks. Wording alone cannot establish a bank denominator.
      compound = inventory.length ? compoundPlan(readings, inventory.flatMap(account =>
        (account.members || [account]).map(member => member.label).filter(Boolean))) : null;
    } catch { /* The operand readers below retain a typed read failure. */ }
  }
  if (compound) return Response.json(await compoundBalanceAnswer(compound, { now, timeZone, classifyLedgerQuestion,
    validateLedgerIntentDecision, moneyAccount, ledgerClarificationAnswer, finalLedgerOffer }, async original => {
    if (!original) {
      try { return { part: {}, accounts: await readEffectiveAccounts(env), observations: null }; }
      catch { return { part: { gaps: [gapFor('ledger_unavailable')] }, accounts: [], observations: null }; }
    }
    let accounts = [], observations = null;
    const intent = { ...original, onBalanceObservations: rows => { observations = rows; } };
    const response = await withParsedLedgerAnswer({ ...evaluated, onAccountScope: rows => { accounts = rows; } },
      async gap => Response.json({ ledger: null, citations: [], gaps: gap ? [gap] : [],
        evidence_gate: { supported: false, complete: false } }), intent);
    return { part: await response.json(), accounts, observations, exclusions: balanceExclusionLines(intent) };
  }, decision));
  if (extracted?.length === 1) {
    // Every model reading passes the same reader and coverage guards. A
    // missing figure stays inside clarification, never document synthesis of
    // an unresolved question. No plan is cached or authorized by a later yes.
    const response = await withParsedLedgerAnswer(evaluated, async gap => Response.json({
      mode: "think", answer: null, ledger: null, citations: [], results: [], gaps: gap ? [gap] : [],
      evidence_gate: { supported: false, complete: false, reason: gap?.reason || "ledger_unavailable" },
    }), decision.intents[0]);
    return Response.json(ledgerClarificationAnswer(await response.json(), decision));
  }
  if (!extracted) return withParsedLedgerAnswer(evaluated, next, parsed);
  // Explicit operands retain separate coverage and refusals. No unavailable
  // comparison side may disappear into a document answer or an exact delta.
  // Read both admitted parts before choosing fallback: a later balance
  // refusal owns the whole question even when the first reading is unavailable.
  const parts = [];
  let fallbackRequired = false;
  const hasForecast = extracted.some(intent => intent.forecastRequested);
  for (const intent of extracted) {
    intent.compositeOperand = true;
    const response = await withParsedLedgerAnswer(evaluated,
      async gap => Response.json({ ledger: null, answer: `${intent.interpretation}\n${gap?.detail || plainRouterLimitation('reading_unavailable')}`,
        citations: [], gaps: gap ? [gap] : [], evidence_gate: { supported: false, complete: false } }), intent);
    const part = await response.json();
    // A validated forecast must retain its refusal even when another part or
    // its snapshot is unavailable. Never offer that question to synthesis.
    // A coverage refusal belongs to this operand. Re-parsing the compound
    // wording would erase its period, missing accounts and recovery advice.
    const coverageRefusal = part.gaps?.some(gap => gap.reason === 'period_outside_coverage');
    if (!part.ledger && !hasForecast && !part.ownership_scope_empty && !coverageRefusal && !decision.comparison && !decision.scopePlan) fallbackRequired = true;
    if (!part.ledger) {
      part.ledger = { kind: intent.kind, from: intent.from, to: intent.to, complete: false,
        reason: part.gaps?.[0]?.reason || 'ledger_unavailable', coverage: { complete: false, accounts: part.gaps?.[0]?.accounts || [] },
        operand_coverage: intent.operandCoverage || { complete: false, accounts: [] } };
      part.answer ||= `${intent.interpretation}\nUnavailable. ${(part.gaps || []).map(gap => gap.detail).filter(Boolean).join(' ')}`;
    }
    parts.push(part);
  }
  // Empty ownership denominators remain terminal across comparison parts.
  if (parts.every(part => part.ownership_scope_empty)) return Response.json({
    ...parts[0], answer: parts.map(part => part.answer).join('\n'),
    gaps: parts.flatMap(part => part.gaps), ledger: null,
  });
  if (fallbackRequired) return withParsedLedgerAnswer(evaluated, next, parsed);
  // Two unresolved balance selectors describe the same broad snapshot. Show
  // that list once, retain both refusals, and never fabricate two figures.
  if (extracted.every(intent => intent.kind === 'balance') && parts.every(part => part.ledger?.selector_unresolved)) {
    const folded = { ...extracted[0], modelAccountScope: null, accountSelector: null, accountScopeUnresolved: false,
      balancePurposeComparison: true };
    folded.interpretation = ledgerIntentInterpretation(folded);
    const response = await withParsedLedgerAnswer(evaluated, async () => Response.json({ ledger: null, citations: [], gaps: [] }), folded);
    const body = await response.json();
    body.ledger = body.ledger ? { ...body.ledger, selector_unresolved: true } : null;
    body.answer += '\n' + extracted.map(intent => `This covers all your accounts because '${safeDescription(intent.modelAccountScope)}' did not identify one account. Want to choose an account by its ending digits?`).join('\n');
    return Response.json(ledgerClarificationAnswer(body, { ...decision, intents: [folded] }));
  }
  // Preserve the numeric citation contract across both answers and their
  // structured rows/groups, without editing any amounts or ledger semantics.
  let offset = 0;
  const rebase = (value, shift, key = '') => {
    if (Array.isArray(value)) return value.map(v =>
      ['citations', 'possible_transfer_citations', 'transfer_related_credit_citations'].includes(key) && Number.isInteger(v)
        ? v + shift : rebase(v, shift));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [k, k === 'n' && Number.isInteger(v) ? v + shift : rebase(v, shift, k)]));
    return value;
  };
  const combined = parts.map((part, index) => {
    const interpretation = ledgerIntentInterpretation(extracted[index], extracted[index].presentation, part.ledger?.amount_basis);
    const prefix = `${interpretation}\n`;
    const text = part.answer || plainRouterLimitation('reading_unavailable');
    // Literal selectors can contain citation-shaped text. Keep their exact
    // interpretation bytes outside the numeric evidence-reference rewrite.
    const detail = text.startsWith(prefix) ? text.slice(prefix.length) : text;
    const rebased = { ...part, answer: detail
      .replace(/\[(\d+)\]/g, (_, n) => `[${Number(n) + offset}]`),
      citations: rebase(part.citations, offset), ledger: rebase(part.ledger ?? null, offset) };
    offset += part.citations.length;
    return rebased;
  });
  // Compare only like-for-like, complete figures. Partial coverage cannot
  // certify a period difference, and broad inflow/outflow has two measures.
  let comparison, comparisonUnavailable;
  if (decision.comparison) {
    const usable = part => part && combined.find(entry => entry.ledger === part)?.evidence_gate?.complete === true && part.complete !== false && part.coverage?.complete !== false && !part.classification_uncertain && !part.selector_unresolved && !part.net_refunds_unavailable;
    const figure = (part, intent) => !usable(part) ? null
      : intent.netRefunds || intent.refundsNotNetted ? part.net_expense_minor ?? null
      : part?.kind === 'expense_summary' ? part.expense_total_minor
        : part?.kind === 'totals' && part.income_established === false ? part.combined_inflow_minor
          : part?.kind === 'balance' && new Set(part.accounts.map(account => account.balance_group)).size === 1 ? sumMinor(part.accounts, account => account.current_minor)
          : ['merchant', 'category'].includes(part?.kind) ? part.lead_total_minor ?? part.total_minor : null;
    const basis = intent => JSON.stringify([intent.kind, intent.direction, Boolean(intent.inflowOnly), Boolean(intent.netRefunds),
      Boolean(intent.refundsNotNetted), intent.ownTransfers || null, intent.withdrawals || null, intent.loanProceeds || null,
      Boolean(intent.outflowMeasure)]);
    const compatible = extracted.length === 2 && basis(extracted[0]) === basis(extracted[1]);
    const figures = combined.map((part, index) => figure(part.ledger, extracted[index]));
    comparisonUnavailable = { reason: !compatible ? 'measure_mismatch'
      : combined.some(part => part.ledger.reason) ? 'operand_unavailable'
      : combined.some(part => !usable(part.ledger)) ? 'operand_incomplete' : 'measure_unavailable' };
    if (compatible && figures.every(Number.isSafeInteger)) {
      const difference = figures[0] - figures[1];
      if (Number.isSafeInteger(difference)) comparison = { figures_minor: figures, difference_minor: difference };
    }
    if (compatible && extracted.every(intent => intent.kind === 'totals' && !intent.inflowOnly) && combined.every(part => usable(part.ledger))) {
      const measures = Object.fromEntries([['inflow', 'credits_minor'], ['outflow', 'debits_minor']].map(([name, key]) => {
        const values = combined.map(part => sumMinor(part.ledger.lead_accounts, account => account[key]));
        return [name, { figures_minor: values, difference_minor: values[0] - values[1] }];
      }));
      if (Object.values(measures).every(measure => measure.figures_minor.every(Number.isSafeInteger) && Number.isSafeInteger(measure.difference_minor))) comparison = { measures };
    }
  }
  const selectorLabel = index => extracted[index].modelAccountScope || extracted[index].match || extracted[index].presentation.period(extracted[index].from, extracted[index].to);
  const comparisonLine = measure => `${selectorLabel(0)}: ${money(measure.figures_minor[0])} | ${selectorLabel(1)}: ${money(measure.figures_minor[1])}; first minus second: ${money(measure.difference_minor)}.`;
  const arithmetic = comparison ? `\n\n${comparison.measures
    ? `Money in: ${comparisonLine(comparison.measures.inflow)}\nMoney out: ${comparisonLine(comparison.measures.outflow)}` : comparisonLine(comparison)}`
    : decision.comparison ? `\n\nAn exact difference is unconfirmed without two complete totals measuring the same thing. ${comparisonUnavailable?.reason === 'measure_mismatch'
      ? 'The two totals measure different things or leave out different transactions.' : comparisonUnavailable?.reason === 'operand_unavailable'
        ? 'One or both totals are unavailable; each period and its missing information are listed separately.' : comparisonUnavailable?.reason === 'operand_incomplete'
          ? 'One or both periods have missing bank history or transactions whose purpose is uncertain.' : 'A complete amount measuring the same thing is unavailable for one or both periods.'} Want to review the two totals?` : '';
  return Response.json(ledgerClarificationAnswer({ mode: "think", answer: combined.map(part => part.answer).join("\n\n") + arithmetic,
    citations: combined.flatMap(part => part.citations),
    results: [], gaps: parts.flatMap(part => part.gaps),
    ledger: { kind: "multi", parts: combined.map(part => part.ledger),
      ...(decision.scopePlan?.type === 'partition' ? { partition: { selectors: decision.scopePlan.selectors,
        complete: combined.every(part => part.ledger.complete === true && part.ledger.coverage?.complete !== false), disjoint: true } } : {}), ...(comparison ? { comparison } : decision.comparison ? { comparison_unavailable: comparisonUnavailable } : {}) },
    evidence_gate: { supported: parts.every(part => part.evidence_gate.supported),
      complete: parts.every(part => part.evidence_gate.complete),
      partial: parts.some(part => !part.evidence_gate.complete), reason: "separate ledger answers for explicit question parts" } }, decision));
}

// These notices use the same inventory as the answer, including accounts that
// coverage or kind guards omit. Never echo a provider's raw error payload.
function accountStateDisclosure(accounts) {
  return accounts.flatMap(account => {
    const name = safeDescription(account.label || accountDisplay(account));
    const lines = [];
    if (account.members.some(member => member.institution_status === 'error'))
      lines.push(`${name}: institution sync error; its money figures are unavailable, not zero.`);
    if (account.members.some(member => member.backfill_state && member.backfill_state !== 'complete')) {
      const through = account.coverage_status === 'complete' && account.coverage_basis === 'confirmed'
        ? account.covered_to : null;
      lines.push(`${name}: history is still loading (backfill). History complete through: ${through || 'no confirmed date yet'}; recorded through ${account.covered_to || 'an unknown date'}.`);
    }
    if (account.account_kind === 'other' && account.account_kind_review?.state !== 'current')
      lines.push(`${name}: not counted in cash or spending totals; account kind not confirmed (unconfirmed account type).`);
    return lines;
  }).join('\n');
}

async function withParsedLedgerAnswer(options, next, intent) {
  intent.refundBoundary = options.refundBoundary;
  if (intent.refundsNotNetted || intent.netRefunds) options.refundBoundary.requested = true;
  const { env, question, access, grantScope, scopePrincipalKind,
    filters = {}, entityScope, ledgerEligible = true, now = Date.now() } = options;
  // The question's explicit role activates the invariant by default. Missing
  // plan metadata cannot opt out of protecting a literal payee restriction.
  const protectedPayee = ledgerDescriptorTotal(question)?.descriptor;
  // Direct callers that inject a clock still need the deployed owner-zone binding.
  // A clock controls when the question is evaluated, never which owner calendar
  // applies. Every caller, including a synthetic one, must supply the zone.
  const configuredTimeZone = Object.hasOwn(env, "BRAIN_TIMEZONE");
  const timeZone = env.BRAIN_TIMEZONE ?? null;
  if (intent.kind === "balance") {
    const ownerTime = ownerLedgerDay(now, timeZone);
    if (ownerTime) intent.observationTo = ownerTime.day;
    else intent.ownerTimeZoneUnavailable = true;
  }
  if (intent.kind && intent.kind !== 'balance') intent.loanPaymentSubject = loanPaymentSubject(question, intent);
  // An unsupported question needs ordinary document retrieval. Inventory
  // coincidences cannot add a bank gap or interrupt that unrelated path.
  if (!intent.broad) return next(null);
  // Provider coverage can extend beyond today; it cannot certify future activity.
  // Apply this once at the reader boundary to every grammar and extracted intent.
  const ownerTime = ownerLedgerDay(now, timeZone);
  if (intent.kind !== 'balance' && ownerTime && intent.from > ownerTime.day) {
    return Response.json({ mode: 'think', answer: 'This period has not happened yet. No ledger figure is shown.',
      citations: [], results: [], gaps: [{ type: 'ledger_not_consulted', reason: 'period_not_started', scope: 'calendar' }],
      evidence_gate: { supported: false, complete: false } });
  }
  // A fully past explicit window needs no relative-date arithmetic. A window
  // reaching the UTC day might still be tomorrow for the owner and must stop.
  if (intent.kind && intent.kind !== 'balance' && !ownerTime && intent.to >= ledgerDay(now)) intent.ownerTimeZoneUnavailable = true;
  const requestedTo = intent.requestedTo || intent.to;
  if (intent.kind !== 'balance' && ownerTime && requestedTo > ownerTime.day) {
    intent.requestedTo = requestedTo;
    intent.to = ownerTime.day;
    intent.partialFuturePeriod = true;
  }
  intent.presentation = moneyPresentation({ now, timeZone });
  let accounts = [], gap;
  const unrestrictedOwnerPath = !access && Boolean(grantScope) && scopeIsUnrestricted(grantScope) &&
    scopePrincipalKind === "owner" && !entityScope?.applied && Object.keys(filters).length === 0;
  const deterministicSpendIntent = intent.kind === "expense_summary" ||
    (intent.kind === "merchant" && intent.direction === "outflow" && Boolean(intent.match));
  // Same whole-owner boundary as financialMapStateFor. The remote MCP ask
  // handler explicitly supplies owner + unrestricted scope today; grants and
  // exact-document sessions do not inherit that authority.
  if (!intent.kind) {
    gap = gapFor("ledger_wording_unsupported", [], { presentation: intent.presentation });
  } else if (intent.ownerTimeZoneUnavailable) {
    gap = gapFor("owner_timezone_unavailable", [], intent);
  } else if (!unrestrictedOwnerPath) {
    gap = gapFor("retrieval_scope_restricted", [], { presentation: intent.presentation });
  } else if (!ledgerEligible) {
    // Preserve the pre-retrieval tax-scope guard. A tax-return question cannot
    // acquire bank-ledger authority just because its wording includes income.
    gap = gapFor("unsupported_question", [], { presentation: intent.presentation });
  } else {
    try {
      const inventory = await readEffectiveAccounts(env);
      accounts = inventory;
      if (intent.scopePlan) {
        if (intent.scopeInventory !== JSON.stringify(inventory)) throw new Error('scoped inventory changed');
        accounts = inventory.filter(account => intent.scopeSlugs.includes(account.account_slug));
        if (!accounts.length || accounts.length !== intent.scopeSlugs.length) throw new Error('scoped selection changed');
      }
      if (recognizeLiteralAccount(inventory, intent, intent.presentation, protectedPayee) && intent.scopePlan) {
        const selected = resolveLedgerScope(inventory, intent.modelAccountScope).map(a => a.account_slug);
        if (!selected.length || JSON.stringify(selected) !== JSON.stringify(intent.scopeSlugs)) throw new Error('late account scope changed');
      }
      const cardRoles = ledgerDescriptorTotal(question)?.cardRoles || [];
      // Syntax typos can also be recorded nicknames. Resolve the untouched
      // literal across the inventory before interpreting fuzzy role/kind words.
      // Retain all exact siblings so duplicate identities still clarify.
      const literalSelectors = [intent.literalAccount, intent.literalAccountFrame].filter(Boolean);
      const exactLiteralSelectors = literalSelectors.filter(selector => inventory.some(account =>
        accountSelectorRank(account, selector) === 2));
      // An exact identity admits the literal reading; existing nickname
      // equivalents still compete and must retain their clarification.
      const literalAccounts = inventory.filter(account => exactLiteralSelectors.some(selector =>
        accountSelectorRank(account, selector) > 0));
      if (literalAccounts.length) {
        accounts = literalAccounts;
        intent.accountSelector = intent.literalAccount || intent.literalAccountFrame;
        intent.literalAccountResolved = true;
        intent.accountScopeUnresolved = false;
        intent.singleAccountBalance = true;
        intent.mask = null;
        intent.modelAccountScope = null;
        intent.accountKind = null;
      }
      const ownershipScope = literalAccounts.length ? null :
        resolveOwnershipScope(inventory, intent.modelAccountScope || intent.entityKind) ||
        resolveOwnershipScope(inventory, cardRoles.join(' '));
      if (ownershipScope) {
        intent.ownershipScope = ownershipScope;
        accounts = accounts.filter(account => ownershipScope.accounts.includes(account));
        intent.accountScopeUnresolved = false;
        if (!intent.scopePlan && !ownershipScope.residual && /\b(?:checking|savings|card|loan)\b/.test(ownershipScope.selector)) {
          // Type nouns are generic only when no recorded literal establishes
          // an account identity. Keep exact names inside the ownership join.
          const selectors = [intent.modelAccountScope, ownershipScope.selector].filter(Boolean);
          const exact = selectors.find(value => accounts.some(account => accountSelectorRank(account, value) === 2));
          if (exact) {
            accounts = accounts.filter(account => accountSelectorRank(account, exact) === 2);
            intent.accountSelector = exact;
          } else if (selectors.some(value => inventory.some(account => accountSelectorRank(account, value) === 2))) accounts = [];
        }
        // A committed S4 plan has already resolved this literal as an entity
        // or account. Reinterpreting its residual as a nickname loses entities.
        if (ownershipScope.residual && !intent.scopePlan) {
          // Literal labels win inside the confirmed ownership denominator.
          const selectors = [intent.modelAccountScope, ownershipScope.selector, ownershipScope.residual].filter(Boolean);
          const selector = selectors.find(value => accountsForSelector(accounts, value).length) || ownershipScope.residual;
          accounts = accountsForSelector(accounts, selector);
          intent.accountSelector = selector;
        }
      }
      if (intent.modelAccountScope && !intent.scopePlan && !ownershipScope) {
        // A model selector containing an account or own-business term never
        // filters payees. An unresolved account remains a labeled broad reading.
        const selected = intent.unresolvedAccountRole ? [] : accountsForSelector(inventory, intent.modelAccountScope, true);
        if (selected.length > 0) intent.accountSelector = intent.modelAccountScope;
        else intent.accountScopeUnresolved = true;
        intent.interpretation = ledgerIntentInterpretation(intent);
      }
      if (intent.accountSelector) {
        // Literal labels and masks are stronger than account-kind words that
        // happen to occur inside a label, including unreviewed feed accounts.
        // Balance identity must see every accepted label equivalent, including
        // lower-ranked kind-stripped labels. Transaction ranking is unchanged.
        // Exact competing frames are already selected. Reapplying only the
        // shorter selector would silently discard another recorded identity.
        if (!intent.literalAccountResolved) {
          accounts = accountsForSelector(accounts, intent.accountSelector, Boolean(intent.modelAccountScope), intent.kind === 'balance');
          if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
        }
      } else {
        if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
        if (intent.accountKind) accounts = accounts.filter(a => a.account_kind === intent.accountKind);
      }
      // A protected card-total frame supplies scope independently of nullable
      // provider hints. Intersect after every selector rewrite: labels cannot
      // promote a checking account into the question's confirmed card set.
      if (ledgerDescriptorTotal(question)) accounts = accounts.filter(a =>
        a.account_kind === 'card' && a.members.every(m => m.account_kind === 'card'));
      // Multiple distinct roles in this single-scope frame are unproven.
      // Never widen to all cards when the question's role cannot be resolved.
      if (cardRoles.length > 1) accounts = [];
      else if (cardRoles.length) {
        // Question roles constrain even a null or generic provider hint. Feed
        // labels cannot supply or contradict confirmed entity ownership.
        const roleScope = resolveOwnershipScope(inventory, cardRoles[0]);
        accounts = accounts.filter(account => roleScope.accounts.includes(account));
      }
      if (intent.scopePlan && JSON.stringify(accounts.map(a => a.account_slug).sort()) !==
          JSON.stringify([...intent.scopeSlugs].sort())) throw new Error('operand scope changed');
      if (ownershipScope) ownershipScope.empty = accounts.length === 0;
      if (intent.earliestCoveredDate && accounts.length) {
        const starts = accounts.map(account => account.covered_from).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day || ''));
        if (starts.length === accounts.length && starts.length) {
          intent.from = starts.sort()[0];
          intent.periodLabel = `since ${intent.presentation.date(intent.from)}, the earliest date I have`;
          intent.interpretation = ledgerIntentInterpretation(intent);
        } else throw new Error('earliest coverage unavailable');
      }
      if (intent.compositeOperand) intent.operandCoverage = { from: intent.from, to: intent.to,
        complete: accounts.length > 0 && accounts.every(account => effectivePeriodCovered(account, intent.from, intent.to)),
        accounts: accounts.map(account => ({ account_mask: /^\d{1,4}$/.test(account.mask || '') ? account.mask : null,
          covered_from: account.covered_from || null, covered_to: account.covered_to || null,
          complete: effectivePeriodCovered(account, intent.from, intent.to) })) };
      options.onAccountScope?.(accounts);
      const balanceScope = intent.kind === 'balance' ? balanceAccountScope(accounts, intent) : null;
      if (balanceScope) {
        accounts = balanceScope.accounts;
        intent.balanceExclusions = balanceScope.excluded;
        intent.balanceSelectionAmbiguous = balanceScope.ambiguous;
      }
      if (intent.kind !== 'balance' && (intent.loanPaymentSubject ||
          intent.modelAccountScope && loanAccountSelector(intent.modelAccountScope) &&
          (intent.accountScopeUnresolved || !accounts.length) || intent.accountKind === 'loan' && !accounts.length)) {
        return Response.json({ mode: 'think', ...loanPaymentRefusal(intent),
          results: [], evidence_gate: { supported: false, complete: false, reason: 'loan_payments_unconfirmed' } });
      }
      const disputed = accounts.filter(a => accountLinkRequiredInWindow(a, intent));
      let reason = !accounts.length ? "no_accounts" : disputed.length ? 'ledger_account_link_required' : balanceScope?.reason || (accounts.some(a => a.ambiguous || a.members.some(m => m.basis_state !== "confirmed")) ||
        (!intent.accountSelector && intent.mask && accounts.length !== 1) ? "ambiguous_account" :
        accounts.some(a => a.currency !== "USD") ? "unsupported_currency" : !intent.kind ||
          intent.kind === 'largest' && transactionRankingUnit(intent.rankingQuestion ?? question, intent) !== 'transaction' ? "unsupported_question" : null);
      // A sync error cannot authorize stale figures or a zero, even when the
      // old coverage receipt remains complete. Keep the named refusal visible.
      if (!reason && accounts.some(a => a.members.some(m => m.institution_status === 'error')))
        reason = intent.from && intent.to && !['balance', 'transactions'].includes(intent.kind) &&
          accounts.some(a => !effectivePeriodCovered(a, intent.from, intent.to))
          ? 'period_outside_coverage' : 'ledger_unavailable';
      if (!reason) {
        // Recheck after ALL account rewrites, immediately before any activity
        // reader. Unknown or lost roles refuse before a broadened read.
        if (protectedPayee && (intent.protectedPayee !== protectedPayee ||
            intent.kind !== 'merchant' || typeof intent.match !== 'string' ||
            intent.match.toLowerCase() !== protectedPayee.toLowerCase())) throw new Error('protected payee unavailable');
        let answer = await ledgerAnswer(env, intent, accounts, inventory);
        reason = answer.reason;
        const earlyDefaultDay = intent.defaultedPeriod && Number(intent.to.slice(8, 10)) <= 3;
        // Yesterday's certified coverage can answer the previous month even
        // before today's feed arrives. Only this period-local refusal may
        // enter the two-period path; shared admission refusals remain terminal.
        if (earlyDefaultDay && reason === "period_outside_coverage") {
          const currentGap = gapFor(reason, accounts, intent);
          answer = { answer: `Unavailable. ${currentGap.detail}`, citations: [], gaps: [currentGap],
            ledger: { kind: "expense_summary", from: intent.from, to: intent.to,
              accounts: accountCoverage(accounts), complete: false, reason } };
          reason = null;
        }
        if (!reason) {
          if (intent.compositeOperand) answer.ledger.operand_coverage = intent.operandCoverage;
          // An explicit period never opts into a second answer window. Only
          // posted ordinary expense membership determines an empty default.
          if (intent.defaultedPeriod && (earlyDefaultDay || answer.ledger.row_count === 0)) {
            await addPreviousExpenseMonth(env, intent, accounts, inventory, answer);
          }
          if (intent.kind === 'expense_summary') answer.answer += `\nAccounts covered: ${periodAccountScope(accounts, intent).covered.map(accountDisplay).join('; ')}.`;
          if (intent.modelAccountScope && !intent.accountScopeUnresolved) answer.answer += `\nAccounts used: ${accounts.map(accountDisplay).join('; ')}.`;
          if (intent.earliestCoveredDate) answer.answer += `\n${intent.periodLabel}.`;
          if (intent.perAccountLargest) {
            const parts = [], text = [];
            for (const account of periodAccountScope(accounts, intent).covered) {
              const part = await ledgerAnswer(env, { ...intent, perAccountLargest: false }, [account], inventory);
              if (!part.ledger || part.reason) throw new Error('per-account ranking unavailable');
              // Independently read parts carry their own identity scope. Apply
              // the same boundary before rebasing and embedding their ledger.
              enforceNamedZeroPostcondition(part);
              const offset = answer.citations.length;
              answer.citations.push(...part.citations.map(ref => ({ ...ref, n: ref.n + offset })));
              const rebase = (value, key = '') => Array.isArray(value) ? value.map(entry =>
                ['citations', 'possible_transfer_citations', 'transfer_related_credit_citations'].includes(key) && Number.isInteger(entry) ? entry + offset : rebase(entry)) : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'n' && Number.isInteger(entry) ? entry + offset : rebase(entry, key)])) : value;
              parts.push({ account_mask: account.mask || null, ...rebase(part.ledger) });
              text.push(`${masked(account)}:\n${part.answer.replace(/\[(\d+)\]/g, (_, n) => `[${Number(n) + offset}]`)}`);
            }
            answer.ledger.per_account = parts;
            answer.answer += `\nLargest entries per account:\n${text.join('\n')}`;
          }
          if (intent.accountScopeUnresolved) {
            answer.ledger.selector_unresolved = true;
            answer.answer += `\nThis covers all your accounts because '${safeDescription(intent.modelAccountScope)}' did not identify one account. Want to choose an account by its ending digits?`;
            if (intent.kind !== 'balance' && !intent.monthlyBreakdown) {
              const perAccount = [];
              for (const account of accounts) {
                const part = await ledgerAnswer(env, { ...intent, accountSelector: account.mask || intent.modelAccountScope }, [account], inventory);
                const total = part.ledger?.expense_total_minor ?? part.ledger?.combined_inflow_minor ?? part.ledger?.total_minor;
                const complete = part.ledger && part.ledger.complete !== false && part.ledger.coverage?.complete !== false;
                perAccount.push({ account_mask: account.mask || null, total_minor: complete && Number.isSafeInteger(total) ? total : null });
              }
              answer.ledger.per_account = perAccount;
              answer.answer += `\nPer-account figures: ${perAccount.map(row => `${masked({ mask: row.account_mask })}: ${row.total_minor === null ? 'unavailable for this window' : money(row.total_minor)}`).join('; ')}.`;
            }
          }
          if (intent.pendingRequested) {
            const from = accounts.map(account => account.covered_from).filter(Boolean).sort()[0] || intent.observationTo;
            const pending = await readEffectiveTransactions(env, inventory, { from, to: intent.observationTo,
              effectiveAccountSlugs: accounts.map(account => account.account_slug), pendingOnly: true });
            if (pending.some(row => !readableRow(row))) throw new Error('unreadable pending records');
            const listed = pending.slice(0, 25);
            const refs = listed.map((row, index) => citation(row, accounts.find(account => account.account_slug === row.effective_account_slug), answer.citations.length + index, intent.presentation));
            answer.citations.push(...refs);
            answer.ledger.pending_transactions = { count: pending.length, rows: listed.map((row, index) => ({ n: refs[index].n,
              posted_on: row.posted_on, amount_minor: row.amount_minor, direction: row.direction, account_mask: refs[index].account_mask })) };
            answer.answer += pending.length ? `\nPending transactions (showing ${listed.length} of ${pending.length}; excluded from completed totals):\n${listed.map((row, index) => `${intent.presentation.date(row.posted_on)}: ${money(row.amount_minor)}, ${row.direction}, ${masked({ mask: refs[index].account_mask })} [${refs[index].n}].`).join('\n')}`
              : '\nThe bank feed does not show pending items in these records. Want to check the bank statement?';
          }
          if (intent.kind === 'expense_summary' && !intent.pendingRequested && !intent.monthlyBreakdown) {
            const covered = periodAccountScope(accounts, intent).covered;
            const pending = covered.length ? await readEffectiveTransactions(env, inventory, { from: intent.from, to: intent.to,
              effectiveAccountSlugs: covered.map(account => account.account_slug), pendingOnly: true }) : [];
            if (pending.some(row => !readableRow(row) || row.export_overlap_review)) throw new Error('unreadable pending records');
            if (pending.length) {
              const refs = pending.map((row, index) => citation(row, covered.find(account => account.account_slug === row.effective_account_slug), answer.citations.length + index, intent.presentation));
              answer.citations.push(...refs);
              const total = sumMinor(pending);
              answer.ledger.pending_excluded = { count: pending.length, total_minor: total, citations: refs.map(ref => ref.n) };
              answer.answer += `\nPending activity: ${money(total)} across ${pending.length} ${pending.length === 1 ? 'row' : 'rows'}, excluded from completed ${intent.outflowMeasure ? 'money out' : 'spending'} ${refs.map(ref => `[${ref.n}]`).join(' ')}.`;
            }
          }
          if (intent.answerAddOn === 'freshness') {
            let freshness = answer.ledger.freshness;
            if (!freshness) {
              const snapshots = await readEffectiveBalances(env, inventory,
                { ...intent, observationTo: ownerLedgerDay(now, timeZone)?.day, mask: null, accountKind: null,
                  effectiveAccountSlugs: accounts.map(account => account.account_slug) });
              freshness = accounts.map(account => {
                const row = snapshots.find(row => row.effective_account_slug === account.account_slug && row.basis_state === 'confirmed');
                return { account_mask: /^\d{1,4}$/.test(account.mask || '') ? account.mask : null,
                  as_of: row?.as_of_date || null, last_synced_at: row?.last_synced_at || null };
              });
            }
            answer.ledger.freshness = freshness;
            answer.answer += `\nFreshness: ${freshness.map(row => `${masked({ mask: row.account_mask })}: as of ${intent.presentation.date(row.as_of)}; ${intent.presentation.updated(row.last_synced_at)}`).join('; ')}.`;
          } else if (intent.answerAddOn === 'account') {
            answer.answer += `\nWhich account: ${answer.citations.length ? answer.citations.map(ref => `[${ref.n}] ${masked({ mask: ref.account_mask })}`).join('; ') : 'no matching row was found'}.`;
          } else if (intent.answerAddOn === 'owed') {
            answer.answer += answer.ledger.kind === 'balance'
              ? '\nCard balance meaning: A card balance is money owed on that card.'
              : `\n${plainRouterLimitation('extra_part')}`;
          } else if (intent.answerAddOn === 'share' && !answer.ledger.share_of_total &&
              !(intent.kind === 'largest' && intent.direction === 'outflow')) {
            answer.answer += `\n${plainRouterLimitation('extra_part')}`;
          }
          if (intent.refundsSeparateUnavailable) answer.answer += '\nStore refunds are not split out in this view. Want to review the deposits separately?';
          if (intent.refundsNotNetted && !answer.ledger.net_refunds_unavailable) {
            // Covered gross rows do not prove refund attribution. Preserve
            // gross completeness separately from the unavailable net field.
            Object.assign(answer.ledger, { net_refunds_unavailable: true, amount_basis: 'gross_before_refunds' });
            answer.answer = (intent.kind === 'merchant'
              ? "I cannot confirm spending after refunds because these records do not show which deposits are refunds from this business. "
              : "I cannot confirm spending after refunds because these records do not show which deposits refunded these expenses. ") +
              "The amounts below are before subtracting refunds.\n" + answer.answer;
          }
          if (intent.exactPaymentOnly) answer.answer += '\nThis lookup checks exact amounts only; payouts changed by fees are not inferred. Want to review the deposit amounts?';
          if (intent.payeeBreakdownUnavailable) answer.answer += '\nA payee breakdown is not available in this view. Want to review individual transactions?';
          // The reader admits posted records only. It cannot observe pending
          // activity or certify its absence, even on a posted-only snapshot.
          // Pending and cleared qualifiers use this same plain-language notice.
          if (!isBoundedVendorAbsence(answer.ledger)) {
            if (answer.ledger.kind !== "balance") answer.answer += `\n${pendingNotice}`;
          }
          if (intent.from && intent.to && configuredTimeZone) answer.ledger.time_zone = intent.timeZone;
          const disclosure = accountStateDisclosure(accounts);
          if (disclosure) answer.answer += `\n${disclosure}`;
          if (accounts.some(a => a.members.some(m => m.backfill_state && m.backfill_state !== 'complete')))
            answer.ledger.history_loading = true;
          if (ownershipScope?.unknown.length) {
            answer.ledger.complete = false;
            answer.ledger.ownership_incomplete = true;
            answer.answer += '\nOwnership is unconfirmed for other accounts; this ownership-scoped answer is partial.';
          }
          answer = await guardNamedSelector(env, intent, answer);
          answer = enforceNamedZeroPostcondition(answer);
          const partialCoverage = answer.ledger.partial_reason === "ledger_partial_coverage";
          if (intent.partialFuturePeriod) {
            answer.ledger.complete = false;
            answer.ledger.requested_to = intent.requestedTo;
            answer.ledger.partial_reason = 'period_in_progress';
            answer.ledger.coverage = { ...answer.ledger.coverage, complete: false };
            if (answer.ledger.operand_coverage) answer.ledger.operand_coverage.complete = false;
            answer.answer = 'Partial period: recorded activity only through ' + intent.presentation.date(intent.to) + '. The rest of the requested period has not happened yet.\n' + answer.answer;
          }
          if (intent.financingBoundary) return Response.json({ mode: 'think',
            answer: "No payout schedule or expected-amount source is connected, so I can't tell which financing payouts are still due. The bank feed shows these recent deposits from recorded payer or financing labels (not proof of a financing payout):\n" + answer.answer,
            citations: answer.citations, results: [], gaps: [...(answer.gaps || []),
              ...(partialCoverage ? [gapFor('ledger_partial_coverage', accounts, intent)] : []), { reason: 'financing_schedule_unavailable' }],
            evidence_gate: { supported: false, complete: false, partial: true, reason: 'financing_schedule_unavailable' } });
          if (intent.invoiceArrivalOnly) answer.answer += '\nBank payment arrival does not confirm that an invoice is settled; an invoice-to-payment link is missing.';
          const incomplete = Boolean(answer.ledger.net_refunds_unavailable || answer.ledger.attribution_incomplete || answer.ledger.complete === false ||
            answer.ledger.known_own_transfer_in_lead || answer.ledger.previous_month?.complete === false);
          // An explicit bounded absence needs no repair invitation from a
          // coverage gap. Ambiguous interpretations retain their clarification.
          const composeOffer = isBoundedVendorAbsence(answer.ledger) && !intent.interpretation ? body => body : finalLedgerOffer;
          return new Response(JSON.stringify(composeOffer({ mode: "think", answer: intent.interpretation
            ? `${ledgerIntentInterpretation(intent, intent.presentation, answer.ledger.amount_basis)}\n${answer.answer}` : answer.answer,
          citations: answer.citations, results: [],
          gaps: [...(answer.gaps || []), ...(partialCoverage ? [gapFor("ledger_partial_coverage", accounts, intent)] : [])], ledger: answer.ledger,
          evidence_gate: { supported: answer.ledger.available !== false, complete: !incomplete, partial: incomplete,
            reason: answer.ledger.available === false ? answer.ledger.measure ? "no covered accounts eligible for this measure" : "monthly figures unavailable; see each month's coverage, match or read reason"
              : intent.partialFuturePeriod ? "requested period extends beyond today; recorded activity only through today"
              : answer.ledger.net_refunds_unavailable ? "net of refunds unavailable; gross recorded amounts only"
              : answer.ledger.forecast_supported === false ? "forecast unavailable; current recorded balance observations only"
              : answer.ledger.selector_ambiguous ? "account selector matches multiple accounts; separate recorded balances only"
              : answer.ledger.observation?.exclusions?.some(entry => entry.reason !== 'closed') ? "accounts without a confirmed current connection excluded; complete current total unconfirmed"
              : answer.ledger.ambiguous ? "multiple near-date deposits match; no unique payment is confirmed"
              : partialCoverage ? "available ledger rows are cited, but ledger coverage is not certified complete"
              : answer.ledger.attribution_incomplete ? "payer attribution incomplete in covered ledger rows"
              : answer.ledger.match_basis === "family_and_possible" ? "vendor selector has family and possible matches; no complete total is claimed"
                : answer.ledger.match_basis === "exact_and_possible" ? "vendor selector has exact and possible matches; no complete total is claimed"
                : answer.ledger.match_basis === "possible" ? "vendor selector has possible matches only"
                  : answer.ledger.match_basis === "none" ? "vendor selector has no exact match in covered ledger rows"
                  : answer.ledger.known_own_transfer_in_lead ? "known own-account transfer remains in the first figure"
                    : answer.ledger.classification_uncertain ? "account classification is unconfirmed; expense interpretation is incomplete"
                    : answer.ledger.reason === "period_outside_coverage" ? "month to date is outside ledger coverage"
                    : answer.ledger.previous_month?.complete === false ? "previous calendar month has incomplete ledger evidence"
                    : answer.ledger.coverage?.complete === false && answer.ledger.kind === "expense_summary"
                      ? "partial ledger coverage; figure limited to fully covered accounts"
                      : answer.ledger.coverage?.complete === false ? "vendor subtotal limited to fully covered accounts"
                        : "read from covered ledger rows" } })),
          { headers: { "Content-Type": "application/json" } });
        }
      }
      gap = gapFor(reason, reason === 'ledger_account_link_required' ? disputed : accounts, intent);
    } catch {
      gap = gapFor("ledger_unavailable", accounts, intent);
    }
  }
  const disclosure = accountStateDisclosure(accounts);
  if (disclosure) gap = { ...gap, detail: `${gap.detail}\n${disclosure}` };
  const reason = gap.reason;
  if (intent.ownershipScope?.empty) return Response.json({ mode: 'think', code: reason, ownership_scope_empty: true,
    answer: `No confirmed ${intent.ownershipScope.kind} accounts${intent.ownershipScope.residual ? ' matching the requested account name' : ''} were found. Ownership may be unconfirmed for other accounts.`,
    citations: [], results: [], gaps: [gap], evidence_gate: { supported: false, complete: false, reason } });
  // A missing or unauthorized snapshot cannot hand a forecast request to a
  // document model. The limitation remains useful without inventing a value.
  if (intent.forecastRequested) return new Response(JSON.stringify({ mode: "think", code: reason,
    answer: intent.modelForecast
      ? `${intent.interpretation}\nI can help review your records, but future balances and payments are unknown. ${gap.detail}`
      : `I can help review your records, but future balances and payments are unknown. ${gap.detail}`,
    citations: [], results: [], gaps: [gap], evidence_gate: { supported: false, complete: false, reason } }),
  { headers: { "Content-Type": "application/json" } });
  // Once an unrestricted owner request enters either deterministic spend
  // contract, every ledger refusal is terminal. Documents cannot certify a
  // figure for the rejected account denominator, selector, coverage, or read.
  if ((unrestrictedOwnerPath && deterministicSpendIntent) || ['ledger_account_link_required', 'cash_flow_unsupported',
    'merchant_selector_unsupported', 'merchant_selector_ambiguous', 'coverage_review_required',
    'bank_export_overlap_review_required', 'ledger_account_kind_review_required'].includes(reason)) return new Response(JSON.stringify({ mode: 'think',
    code: reason, answer: null, citations: [], results: [], gaps: [gap],
    evidence_gate: { supported: false, complete: false, reason } }), { headers: { 'Content-Type': 'application/json' } });
  return mergeLedgerGap(await next(gap), gap);
}

// Keep document answers and decisions intact. Add the bank limitation and
// document-source notice only in the owner explanation carried by the gap.
async function mergeLedgerGap(response, gap) {
  if (!response.ok) return response;
  const body = await response.json();
  if (body.answer && body.evidence_gate?.supported !== false && !/^The documents do not answer/i.test(body.answer)) {
    gap = { ...gap, detail: `${documentMoneyNotice}\n${gap.detail}` };
  }
  body.gaps = [gap, ...(body.gaps || []).filter(g => g.type !== gap.type)];
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
}
