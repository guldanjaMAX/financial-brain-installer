import { moneyAccount, moneyPresentation } from "./money-format.js";
import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion, ledgerDay, ownerLedgerDay, shiftLedgerDay } from "./ledger-question.js";
import { extractLedgerIntentDecision, ledgerIntentInterpretation, normalizeLedgerIntentWords } from "./ledger-intent.js";
import { finalLedgerOffer, ledgerClarificationAnswer } from "./ledger-clarification.js";
import { refundBasisForOperand } from "./ledger-refund-basis.js";
import { monthlyLedgerAnswer } from "./ledger-monthly.js";
import { accountLinkRequiredInWindow, effectivePeriodCovered, readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions } from "./ledger-reader.js";
import { accountKindReviewRequired, categoryFor, classifyOwnedMovement, detectRecurring, isDirectedOwnedTransfer, isLoanAdvance, isTransferCandidate, isUncategorizedBucket, matchesCategory, matchesMerchant, matchesSender, merchantFor, merchantMatchBasis, normalizeLedgerText, normalizeMerchantText, ownedLiabilityPaymentKind, pairOwnTransfers, selectVendorFamily, sumMinor } from "./ledger-analysis.js";

import { accountEndings, balanceSuggestion, documentMoneyNotice, originalRecordSuggestion, pendingNotice, plainBankGap, plainRouterLimitation } from "./ledger-wording.js";

const masked = moneyAccount;
const money = cents => `${cents < 0 ? "-" : ""}$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const safeDescription = text => String(text || "Deposit").replace(/\d(?:[\s-]*\d){4,}/g, "[redacted]").slice(0, 240);
const accountDisplay = account => moneyAccount(account, { label: true });
const normalizeAccountText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
const withoutAccountKind = value => value.replace(/\b(?:account|acct|credit|card|checking|savings|loan|investment|retirement|escrow)\b/g, "").replace(/\s+/g, " ").trim();
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
function accountsForSelector(inventory, selector, scopeWords = false) {
  const ranked = inventory.map(account => ({ account, rank: accountSelectorRank(account, selector, scopeWords) }));
  const best = Math.max(0, ...ranked.map(row => row.rank));
  return best ? ranked.filter(row => scopeWords ? row.rank > 0 : row.rank === best).map(row => row.account) : [];
}
const simpleFinUnreviewedAccount = account => (account.members || [account]).every(member =>
  member.feed_mode === "live" && member.account_kind === "other" && member.balance_role === "neither" &&
  /^simplefin-[a-f0-9]{16,59}$/.test(member.account_slug || "") && /^bank-feed:/.test(member.source_feed || ""));
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
  const detail = plainBankGap(reason, accounts, intent);
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

function leadExclusions(rows, pairs, selected, bySlug, intent) {
  if (intent.kind === "largest" && intent.direction === "outflow") {
    const { ownTransfers, payments } = ordinaryExpenseSelection(rows, pairs, bySlug);
    // Explicit transfer inclusion remains a requested alternate view. The
    // ordinary ranking and summary share the same proved expense membership.
    const removedTransfers = intent.ownTransfers === "include" ? [] : [...ownTransfers.values()];
    const excluded = new Map(removedTransfers.map(row => [row.id, "a matched own-account transfer"]));
    for (const [id, payment] of payments) excluded.set(id, `a payment to your own ${payment.liabilityKind} account`);
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

function ordinaryExpenseSelection(rows, pairs, bySlug) {
  const outflows = rows.filter(row => row.direction === "outflow");
  const inAnswer = new Set(outflows.map(row => row.id));
  const ownTransfers = new Map(), payments = new Map();
  for (const pair of pairs) {
    // Padding and a counterpart in another selected period cannot exclude a
    // row that does not contribute to this answer's outgoing expense pool.
    if (!inAnswer.has(pair.out.id)) continue;
    const movement = classifyOwnedMovement(pair, bySlug);
    if (movement?.kind === "own_transfer") ownTransfers.set(pair.out.id, pair.out);
    if (movement?.kind === "owned_liability_payment") {
      payments.set(pair.out.id, { row: pair.out, liabilityKind: movement.liabilityKind });
    }
  }
  for (const row of outflows) {
    if (ownTransfers.has(row.id) || payments.has(row.id)) continue;
    const liabilityKind = ownedLiabilityPaymentKind(row, bySlug);
    if (liabilityKind) payments.set(row.id, { row, liabilityKind });
  }
  const ordinary = outflows.filter(row => !ownTransfers.has(row.id) && !payments.has(row.id));
  return { ordinary, ownTransfers, payments };
}

function expenseSummary({ intent, accounts, requestedAccounts, omittedAccounts, rows, pairs, pairing, bySlug, citationOffset = 0 }) {
  const { ordinary, ownTransfers, payments } = ordinaryExpenseSelection(rows, pairs, bySlug);
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
  const evidenceRows = [...ordinary].sort(rowOrder).slice(0, 5);
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
      ledger: { kind: "expense_summary", from: intent.from, to: intent.to,
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
    group_count: orderedGroups.length, groups: displayedGroups,
    omitted_group_count: Math.max(0, orderedGroups.length - displayedGroups.length),
    category_group_count: orderedCategories.length, category_groups: displayedCategories,
    omitted_category_group_count: Math.max(0, orderedCategories.length - displayedCategories.length),
    excluded_own_transfer_minor: sumMinor([...ownTransfers.values()]),
    own_account_payments: { total_minor: paymentTotal, count: paymentRows.length,
      card_minor: cardMinor, loan_minor: loanMinor },
    includes_own_transfers: false,
    matched_transfer_count: ownTransfers.size,
    candidate_transfer_count: pairing.pairs.length,
  };
  const partial = complete ? "" : " (some accounts missing dates)";
  let answer = classificationUncertain
    ? `Money out I could check: ${money(totalMinor)} ${label}.\nPeriod: ${intent.presentation.period(intent.from, intent.to)}.`
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
  if (ledger.omitted_group_count) answer += `\nAnd ${ledger.omitted_group_count} more merchant groups.`;
  if (displayedCategories.length) {
    answer += "\nCategory groups:";
    for (const group of displayedCategories) {
      answer += `\n${group.category}: ${money(group.total_minor)} across ${group.count} ${group.count === 1 ? "row" : "rows"}.`;
    }
  }
  if (ledger.omitted_category_group_count) answer += `\nAnd ${ledger.omitted_category_group_count} more category groups.`;
  if (intent.showExcludedTransfers || (intent.interpretation && ledger.excluded_own_transfer_minor > 0)) answer += `\nExcluded detected own-account transfers: ${money(ledger.excluded_own_transfer_minor)}.`;
  if (paymentRows.length) answer += `\nPayments to your own loan/card accounts: ${money(paymentTotal)} across ${paymentRows.length} ${paymentRows.length === 1 ? "payment" : "payments"}.`;
  answer += `\nEvidence: ${citations.length} of ${ordinary.length} expense rows cited${omittedRowCount ? `, and ${omittedRowCount} more rows` : ""}.`;
  answer += coverageComplete
    ? `\nBank history: all ${accounts.length} accounts include ${intent.presentation.period(intent.from, intent.to)}.`
    : `\nBank history: ${accounts.length} of ${requestedAccounts.length} accounts include ${intent.presentation.period(intent.from, intent.to)}; excluded ${omittedAccounts.map(masked).join(", ")}.`;
  return { answer, citations, ledger };
}
const closestPayeeNames = (rows, query, limit = 3) => {
  const wanted = normalizeMerchantText(query), wantedTokens = new Set(wanted.split(" ").filter(Boolean));
  const choices = new Map();
  for (const row of rows) {
    const normalized = normalizeMerchantText(row.payee);
    if (!normalized) continue;
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
  const currentDetail = lines.filter(line => /^(?:Payments to your own loan\/card accounts:|Evidence:|Bank history:|Here is the money out|Here is a partial view)/.test(line));
  const headline = [`Month to date (${intent.presentation.period(intent.from, intent.to)}): ${lines[0]}`, refs, ...currentDetail].filter(Boolean).join(" ");
  const currentNotes = lines.filter(line => /^(?:Your account|Want )/.test(line));
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

async function ledgerAnswer(env, intent, accounts, inventory) {
  if (intent.monthlyBreakdown) return monthlyLedgerAnswer(intent, accounts,
    month => ledgerAnswer(env, month, accounts, inventory));
  if (intent.measure === "cash_flow") return { reason: "cash_flow_unsupported" };
  if (intent.measure && !accounts.some(a => moveKind(a.account_kind))) return { reason: "unsupported_question" };
  if (intent.kind === "balance") {
    const snapshotAccounts = intent.accountSelector || intent.entityKind ? inventory : accounts;
    const observed = await readEffectiveBalances(env, snapshotAccounts, { ...(intent.accountSelector || intent.entityKind
      ? { ...intent, mask: null, accountKind: null,
        effectiveAccountSlugs: accounts.map(account => account.account_slug) } : intent),
      includeAvailable: Boolean(intent.balanceMeasures || intent.pendingRequested) });
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
    const cited = intent.interpretation ? ordered : ordered.slice(0, 5);
    const citations = cited.map(({ row, account }, index) => ({ ...citation(row, account, index, intent.presentation, true),
      ...(intent.balanceMeasures ? { available_minor: Number.isSafeInteger(row.available_minor) ? row.available_minor : null } : {}) }));
    const ledgerAccounts = ordered.map(({ row, account }) => ({
      account_mask: /^\d{1,4}$/.test(account.mask || "") ? account.mask : null,
      balance_group: balanceGroup(account),
      ...(intent.balancePurposeComparison ? { account_kind: account.account_kind || null } : {}),
      current_minor: row.current_minor, as_of: row.as_of_date, last_synced_at: row.last_synced_at || null,
      ...(intent.balanceMeasures ? { available_minor: Number.isSafeInteger(row.available_minor) ? row.available_minor : null } : {}),
    }));
    const cashAccounts = ordered.filter(({ account }) => balanceGroup(account) === 'cash');
    const cashTotal = intent.cashOnlyBalance && cashAccounts.length ? sumMinor(cashAccounts, entry => entry.row.current_minor) : null;
    const headings = { cash: "Cash accounts (recorded balances):", liability: "Liabilities (separate from cash):",
      other: "Other or unknown account types (excluded from cash):" };
    let previousGroup;
    const answer = [...(intent.forecastRequested ? [intent.modelForecast
      ? `I can show your recorded balances, but future balances and payments are unknown.\n${balanceSuggestion}`
      : `I can show your recorded balances, but future balances and payments are unknown.\n${balanceSuggestion}`] : []),
      "Your latest synced balances are below.", "Here are your recorded balances, with the date for each account; these do not show live or available cash.\nWant help refreshing the bank connection for a newer balance?",
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
    return { answer, citations, ledger: { kind: "balance", accounts: ledgerAccounts,
      ...(intent.answerAddOn === 'freshness' ? { freshness: ledgerAccounts.map(row => ({
        account_mask: row.account_mask, as_of: row.as_of, last_synced_at: row.last_synced_at })) } : {}),
      ...(intent.cashOnlyBalance ? { cash_only: { total_minor: cashTotal, account_masks: cashAccounts.map(({ account }) => /^\d{1,4}$/.test(account.mask || '') ? account.mask : null) } } : {}),
      ...(intent.forecastRequested ? { forecast_supported: false, complete: false } : {}) } };
  }
  if (intent.kind === "transactions") {
    const knownStarts = accounts.map(account => account.covered_from).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day || ""));
    const from = intent.interpretation && intent.from ? intent.from
      : knownStarts.length === accounts.length ? knownStarts.sort().at(-1) : shiftLedgerDay(intent.to, -3659);
    const snapshotAccounts = intent.accountSelector ? inventory : accounts;
    const observed = await readEffectiveTransactions(env, snapshotAccounts, {
      ...intent, from, mask: intent.accountSelector ? null : intent.mask,
      accountKind: intent.accountSelector ? null : intent.accountKind,
      effectiveAccountSlugs: intent.accountSelector ? accounts.map(account => account.account_slug) : null,
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
  const requestedAccounts = accounts;
  const namedOutflowRequest = intent.kind === "merchant" && intent.direction === "outflow" && Boolean(intent.match);
  const omittedAccounts = accounts.filter(a => !effectivePeriodCovered(a, intent.from, intent.to));
  const periodCovered = accounts.every(a => effectivePeriodCovered(a, intent.from, intent.to));
  const partialSimpleFinRanking = intent.kind === "largest" && !periodCovered && accounts.every(simpleFinUnreviewedAccount);
  if (intent.kind === "expense_summary" || namedOutflowRequest) {
    accounts = accounts.filter(a => effectivePeriodCovered(a, intent.from, intent.to));
    if (!accounts.length) return { reason: "period_outside_coverage" };
  } else if (!periodCovered && !partialSimpleFinRanking) return { reason: "period_outside_coverage" };
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
  // The amount SQL predicate is inflow-only. Other directions read the bounded
  // window and apply exact cents and direction locally below.
  const paymentIntent = payment && ['outflow', 'both'].includes(intent.direction) ? { ...intent, amountMinor: null } : intent;
  const paymentRead = intent.accountSelector ? { ...paymentIntent, mask: null, accountKind: null,
    effectiveAccountSlugs: accounts.map(account => account.account_slug) } : paymentIntent;
  const allRows = await readEffectiveTransactions(env, payment && !intent.accountSelector ? accounts : inventory, payment ? paymentRead : {
    from: shiftLedgerDay(intent.from, -6), to: shiftLedgerDay(intent.to, 6),
  });
  const inWindow = row => row.posted_on >= intent.from && row.posted_on <= intent.to;
  const selected = new Set(accounts.map(a => a.account_slug));
  const rows = allRows.filter(row => selected.has(row.effective_account_slug) && (!row.posted_on || inWindow(row)));
  if (rows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
  if (rows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
  const bySlug = new Map(inventory.map(a => [a.account_slug, a]));
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
    const matched = rows.filter(row => {
      if ((searchDirection !== 'both' && row.direction !== searchDirection) || (intent.amountMinor !== null && row.amount_minor !== intent.amountMinor)) return false;
      // An amount narrows an attributed receipt; it cannot promote a memo
      // subject to sender or override a different explicit payee.
      return matchesSender(row, intent.counterpartyWords);
    });
    // The first read preserves the base positive path. Before claiming an
    // empty period, re-read without an amount predicate to see every inflow.
    if (!matched.length && intent.counterpartyWords.length && intent.amountMinor !== null) {
      const windowRows = await readEffectiveTransactions(env, intent.accountSelector ? inventory : accounts, { ...paymentRead, amountMinor: null });
      if (windowRows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
      if (windowRows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
      inflows = windowRows.filter(row => row.direction === "inflow");
    }
    const citations = matched.map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i, intent.presentation));
    if (searchDirection === 'inflow' && !matched.length && intent.counterpartyWords.length && inflows.length) {
      const detail = inflowDetail(row => {
        const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length, intent.presentation);
        citations.push(ref); return ref;
      });
      return { answer: `I found ${inflows.length} deposit${inflows.length === 1 ? "" : "s"}, but the bank details do not identify ${inflows.length === 1 ? "it" : "them"} as that payer's payment, so payment is unconfirmed.\n${balanceSuggestion}\n${detail.answer}\nAccounts: ${accounts.map(masked).join(", ")}; ${intent.presentation.period(intent.from, intent.to)}; ${accounts.map(a => `${masked(a)}: covered through ${intent.presentation.date(a.covered_to)}`).join("; ")}.${nearWindow}`,
        citations, ledger: { kind: "payment", found: null, total_minor: null, complete: false,
          from: intent.from, to: intent.to, amount_minor: intent.amountMinor, accounts: accountCoverage(accounts),
          attribution_incomplete: true, inflow_count: inflows.length, inflows: detail.deposits } };
    }
    const ambiguous = Boolean((intent.nearDate || intent.paymentCandidates) && matched.length > 1);
    const answer = (ambiguous ? `I found ${matched.length} matching ${paymentLabel}s in ${intent.presentation.period(intent.from, intent.to)}, so no single payment is confirmed.\n${balanceSuggestion}\n` : "") + (matched.length
      ? matched.map((row, i) => `Found a ${paymentLabel} of ${money(row.amount_minor)}${searchDirection === 'both' ? ` (${row.direction})` : ''} dated ${intent.presentation.date(row.posted_on)} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description)} [${i + 1}].`).join("\n")
      : `${searchDirection === 'inflow' && intent.counterpartyWords.length && !inflows.length ? "No deposits at all in this period" : `No matching ${paymentLabel}`} in ${accounts.map(masked).join(", ")} during ${intent.presentation.period(intent.from, intent.to)}; the bank feed covers through ${accounts.map(a => `${masked(a)}: ${a.live?.covered_to ? intent.presentation.date(a.live.covered_to) : "unknown (manual records only)"}`).join("; ")}.`) + nearWindow +
      (intent.nearDate ? `\nAccounts: ${accounts.map(masked).join(", ")}; ${accounts.map(a => `${masked(a)}: covered through ${intent.presentation.date(a.covered_to)}`).join("; ")}.` : "");
    const paymentLimit = !matched.length
      ? `\nI checked the dates and accounts shown and found no matching completed ${paymentLabel}; payment outside those dates and accounts remains unconfirmed.\n${balanceSuggestion}` : "";
    return { answer: answer + paymentLimit + directionLabel, citations, ledger: { kind: "payment", ...(searchDirection !== 'inflow' ? { direction: searchDirection } : {}), found: ambiguous ? null : matched.length > 0,
      ...(intent.nearDate || intent.paymentCandidates ? { ambiguous, complete: !ambiguous, match_count: matched.length, ...(intent.nearDate ? { anchor_date: intent.nearDate } : {}) } : {}),
      from: intent.from, to: intent.to, amount_minor: intent.amountMinor, accounts: accountCoverage(accounts) } };
  }
  // A feed category is evidence; an arbitrary merchant-looking word is not.
  // This model-only path never replaces an exact payee with a guessed category.
  if (intent.interpretation && intent.direction === 'outflow' && ['merchant', 'category'].includes(intent.kind) && intent.match) {
    const wanted = normalizeMerchantText(intent.match);
    const exactPayee = rows.some(row => row.direction === 'outflow' && merchantMatchBasis(row, intent.match) === 'exact');
    const categoryMatch = rows.some(row => row.direction === 'outflow' && categoryFor(row) === wanted);
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
  // Decide on the full scoped period before category selection can discard
  // unknown membership. Model readings share the deterministic category guard
  // and its citations; an exact payee still keeps the merchant path.
  const categoryTotalUnconfirmed = Boolean(intent.categorySelector && !isUncategorizedBucket(intent.categorySelector) &&
    rows.some(row => row.direction === intent.direction && !categoryFor(row)));
  if (categoryTotalUnconfirmed) intent.kind = 'category';
  if (intent.interpretation && intent.direction === 'inflow' && intent.match && /^(?:refunds?|reimbursements?)$/i.test(intent.match)) {
    const keyword = intent.match.toLowerCase().replace(/s$/, '');
    const matched = inflows.filter(row => (String(row.description || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .some(word => word === keyword || word === `${keyword}s`));
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
    const wanted = normalizeMerchantText(intent.match);
    const directionRows = rows.filter(row => row.direction === intent.direction);
    if (intent.direction === "outflow") {
      namedOutflowMerchant = { directionRows, ...selectVendorFamily(directionRows, intent.match) };
    }
    const conjunction = text => text.replace(/\b(and)\b|&/g, "and");
    if (!directionRows.some(row => matchesMerchant(row, intent.match)) && directionRows.some(row =>
      conjunction(merchantFor(row)) === conjunction(wanted))) return { reason: "merchant_selector_ambiguous" };
  }
  const eligible = row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
    effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on);
  const inflowPairing = intent.kind === "totals" && intent.inflowOnly;
  // An unresolved or uncovered posted competitor can block ownership proof.
  // Removing it before mutual uniqueness would invent a pair. Only after that
  // decision may confirmed, usable, covered endpoints support a subtraction.
  // Preserve the existing advisory admission for other answer kinds.
  const pairingRows = inflowPairing ? allRows : allRows.filter(eligible);
  const pairing = pairOwnTransfers(pairingRows, bySlug, { directedEvidence: inflowPairing });
  if ((intent.kind === 'expense_summary' || intent.kind === 'largest' && intent.direction === 'outflow') &&
      rows.some(row => accountKindReviewRequired(row, bySlug))) return { reason: 'ledger_account_kind_review_required' };
  const pairs = pairing.pairs.filter(pair => [pair.out, pair.in].every(eligible)).filter(pair => intent.kind === "expense_summary"
    ? selected.has(pair.out.effective_account_slug) && inWindow(pair.out)
    : [pair.out, pair.in].some(row => selected.has(row.effective_account_slug) && inWindow(row)));
  const unmatched = pairing.unmatched.filter(row => selected.has(row.effective_account_slug) && inWindow(row));
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
    return summary;
  }
  if (intent.kind === "expense_summary") {
    const result = expenseSummary({ intent, accounts, requestedAccounts, omittedAccounts, rows, pairs, pairing, bySlug,
      citationOffset: intent.citationOffset });
    // Coverage may be partial, but expense membership and an integer total
    // are required before partitioning the covered ordinary spending.
    if (intent.remainderSelector && result.ledger.classification_uncertain === false && Number.isSafeInteger(result.ledger.total_minor)) {
      const { ordinary } = ordinaryExpenseSelection(rows, pairs, bySlug);
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
    if (intent.netRefunds && result.ledger.classification_uncertain === false && Number.isSafeInteger(result.ledger.total_minor)) {
      // This is a description-word reading, never an inferred refund type.
      // Both operands share the exact scope, window and coverage decision.
      // An account review can withhold the expense total. Null must not become
      // zero through subtraction and advertise a net figure in that case.
      const refunds = rows.filter(row => row.direction === 'inflow' && /\brefunds?\b/i.test(normalizeLedgerText(row.description)));
      const refundMinor = sumMinor(refunds), net = result.ledger.total_minor - refundMinor;
      if (!Number.isSafeInteger(net)) throw new Error('ledger total overflow');
      const refs = refunds.map((row, index) => citation(row, bySlug.get(row.effective_account_slug),
        (intent.citationOffset ?? 0) + result.citations.length + index, intent.presentation));
      result.citations.push(...refs);
      Object.assign(result.ledger, { refund_description_minor: refundMinor, net_expense_minor: net });
      result.answer = `${result.ledger.complete === false ? 'Partial view of the recorded transactions. ' : ''}Ordinary expenses less inflows with 'refund' in the description: ${money(net)}; ordinary expenses ${money(result.ledger.total_minor)}, refund description inflows ${money(refundMinor)} ${refs.map(ref => `[${ref.n}]`).join(' ')}.\n${result.answer}`;
    }
    return result;
  }
  if (intent.kind === "totals" && intent.inflowOnly) {
    // The question asks for receipts, not earned income. Preserve every
    // selected credit, even a transfer-looking credit without ownership proof.
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
      selected.has(pair.in.effective_account_slug) && inWindow(pair.in) &&
      [pair.out, pair.in].every(row => bySlug.get(row.effective_account_slug).account_kind !== "other") &&
      isDirectedOwnedTransfer(pair, bySlug));
    const matchedInflowMinor = sumMinor(matchedInflowPairs, pair => pair.in.amount_minor);
    const leadSelection = leadExclusions(rows, pairs, selected, bySlug, {
      ...intent, withdrawals: "include", loanProceeds: intent.loanProceeds === "exclude" ? "exclude" : "include",
    });
    const leadAccounts = accounts.map(account => {
      const ownRows = rows.filter(row => row.effective_account_slug === account.account_slug && !leadSelection.excluded.has(row.id));
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
    const transferRefs = inflows.filter(row => !matchedCreditIds.has(row.id) &&
      (isTransferCandidate(row) || pairing.candidateRows.has(row.id)))
      .map(row => citationById.get(row.id).n);
    const matchedRefs = matchedTransfers.flatMap(pair => [pair.outgoing_citation, pair.incoming_citation])
      .map(n => `[${n}]`).join(" ");
    const lines = totals.map((total, index) => {
      const ownRefs = rows.filter(row => row.effective_account_slug === accounts[index].account_slug)
        .map(row => `[${citationById.get(row.id).n}]`).join(" ");
      return `${masked(accounts[index])}, ${intent.presentation.period(intent.from, intent.to)}: credits ${money(total.credits_minor)}; debits ${money(total.debits_minor)} ${ownRefs || "(no completed income or expenses in the covered period)"}.`;
    });
    return { answer: [loanNote + `Combined recorded inflow: ${money(combined)} across ${accounts.length} account${accounts.length === 1 ? "" : "s"} with records, ${intent.presentation.period(intent.from, intent.to)}; not established income.`,
      `Matched transfers between your own accounts: ${money(matchedInflowMinor)} across ${matchedTransfers.length} ${matchedTransfers.length === 1 ? "pair" : "pairs"}${matchedRefs ? ` ${matchedRefs}` : ""}.`,
      `Inflow from outside your covered accounts: ${money(combined - matchedInflowMinor)} (recorded inflow minus matched transfers; unmatched credits may include unproved own-account moves).`,
      "Transfers are counted by the inflow posting date; counterpart outflows may fall up to 3 days before or after it.",
      ...lines, `Income is still unconfirmed; a deposit can be a transfer or another kind of credit, and the bank label alone does not prove its source.\n${balanceSuggestion}`,
      "Uncertain deposits remain included.",
      ...(transferRefs.length ? [`Transfer-related credits (included; ownership not assumed): ${transferRefs.map(n => `[${n}]`).join(" ")}.`] : []),
      `Accounts: ${accounts.map(masked).join(", ")}; ${intent.presentation.period(intent.from, intent.to)}; ${accounts.map(a => `${masked(a)}: covered through ${intent.presentation.date(a.covered_to)}`).join("; ")}.`].join("\n"),
    citations, ledger: { kind: "totals", from: intent.from, to: intent.to, accounts: totals, lead_accounts: leadAccounts,
      combined_inflow_minor: combined, includes_own_transfers: true, income_established: false,
      outside_inflow_minor: combined - matchedInflowMinor, matched_transfer_count: matchedTransfers.length,
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
    const description = ` ${normalizeLedgerText(row.description)} `;
    const keyword = normalizeLedgerText(intent.descriptionKeyword);
    if (!keyword) return false;
    if (/^(?:refunds?|reimbursements?)$/.test(keyword)) {
      const singular = keyword.replace(/s$/, '');
      return [singular, `${singular}s`].some(word => description.includes(` ${word} `));
    }
    return description.includes(` ${keyword} `);
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
  const { excluded: leadExcluded, keptPairs, knownOwnTransferRows, scopedKnownTransferRows, summary, expensePayments = new Map() } = leadExclusions(figureRows, intent.kind === "transfers" ? [] : pairs, selected, bySlug,
    intent.kind === "transfers" ? { withdrawals: "include" } : namedOutflowMerchant ? { ...intent, ownTransfers: "exclude" } : intent);
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
  const activity = rows;
  const withoutCandidates = list => list.filter(row => !pairing.candidateRows.has(row.id));
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
  const rowLine = row => `${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)} in ${masked(bySlug.get(row.effective_account_slug))}${incompleteNamed ? "" : `: ${safeDescription(row.description || row.payee || "Transaction")}`}${candidateMark(row)} ${refs([row])}`;
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
    const ownRows = withoutCandidates(rows.filter(row => row.effective_account_slug === account.account_slug));
    return { account_mask: account.mask, credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
      debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
  });
  ledger.if_own_transfers = { accounts: conditionalAccounts };
  let conditionalDetail = conditionalAccounts.map((a, i) => `${masked(accounts[i])}: credits ${money(a.credits_minor)}; debits ${money(a.debits_minor)}`).join("; ");
  let answer, leadDetail;
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
    const categoryRanking = intent.kind === "largest" && intent.matchType === "category";
    const selectorMatches = categoryRanking ? matchesCategory : matchesMerchant;
    if (categoryRanking) {
      ledger.selector_type = "category";
      ledger.category_selector = intent.match;
      ledger.complete = !partialSimpleFinRanking;
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
        return { answer, citations, ledger };
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
      if (!partialSimpleFinRanking && !ledger.classification_uncertain &&
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
    const directionRows = activity.filter(row => row.direction === intent.direction);
    const matched = namedOutflowMerchant ? orderedVendorRows(withoutLead(namedOutflowMerchant.matched))
      : intent.match ? directionRows.filter(row => (intent.kind === "merchant" ? matchesMerchant : matchesCategory)(row, intent.match)) : directionRows;
    if (namedOutflowMerchant && !matched.length) {
      const possible = orderedVendorRows(withoutLead(namedOutflowMerchant.possible));
      if (possible.length) {
        // Description text can suggest review candidates, but it is not vendor
        // identity evidence. Return counts only so no amount, citation, or
        // echoed bank text can be mistaken for exact-vendor support.
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
        return { answer, citations: [], ledger: possibleLedger };
      }
      const suggestions = closestPayeeNames(namedOutflowMerchant.directionRows, intent.match);
      ledger.match_basis = "none"; ledger.complete = false; ledger.found = false; ledger.total_minor = null;
      ledger.row_count = 0; ledger.closest_payees = suggestions;
      ledger.coverage = vendorCoverage([]);
      ledger.excluded_own_movement_count = namedOutflowMerchant.matched.length + namedOutflowMerchant.possible.length;
      ledger.excluded_own_movement_minor = sumMinor([...namedOutflowMerchant.matched, ...namedOutflowMerchant.possible]
        .filter(row => leadExcluded.has(row.id)));
      ledger.if_own_transfers.total_minor = null; ledger.if_own_transfers.complete = false;
      // Suggestions are labels, never evidence for the refused amount. A safe
      // balance question avoids guessing a vendor when no safe name can be printed.
      const suggestionRows = ordinaryExpenseSelection(namedOutflowMerchant.directionRows, pairs, bySlug).ordinary;
      const suggestion = closestPayeeNames(suggestionRows, intent.match).find(label =>
        label.length < 80 && /^[\p{L}\p{N} &/.'-]+$/u.test(label) && !/\[redacted\]/i.test(label) &&
        !/\b(?:in|during|for|over|between|before|after|account|accounts|entity|or|last|month|year|excluding|including)\b/i.test(label));
      const monthStart = intent.from.endsWith("-01") && intent.from.slice(0, 7) === intent.to.slice(0, 7) &&
        intent.to === ledgerDay(Date.UTC(Number(intent.from.slice(0, 4)), Number(intent.from.slice(5, 7)), 0));
      const vendorQuestion = suggestion && monthStart && omittedAccounts.length === 0
        ? `Want me to check spending at ${suggestion} in ${intent.presentation.month(intent.from)}?` : balanceSuggestion;
      answer = `I checked ${intent.presentation.period(intent.from, intent.to)}, but no payee exactly matched "${safeDescription(intent.match)}", so no store total is confirmed. ` +
        (suggestions.length ? `Closest payee names: ${suggestions.join("; ")}.` : "The bank supplied no payee names for this period.") +
        `\n${vendorQuestion}\n${vendorCoverageLine(ledger.coverage)}` + familyAmbiguityLine;
      Object.assign(ledger, familyAmbiguity);
      return { answer, citations, ledger };
    }
    const unsorted = (intent.kind === "category" ? directionRows : matched).filter(row => !categoryFor(row));
    const explicitBucket = intent.kind === "category" && isUncategorizedBucket(intent.match);
    const topicLabel = explicitBucket ? "the uncategorized bucket" : safeDescription(intent.match);
    if (explicitBucket) { ledger.category_bucket = "uncategorized"; ledger.complete = true; }
    // Unclassified rows cannot prove that an arbitrary requested topic had
    // a complete topic amount, even beside confirmed category rows. Keep both
    // evidence groups, but withhold every total until membership is known.
    if (intent.kind === "category" && intent.match && !explicitBucket && unsorted.length) {
      ledger.total_minor = null; ledger.lead_total_minor = null; ledger.found = null;
      ledger.expense_total_minor = null;
      ledger.unsorted_minor = sumMinor(unsorted); ledger.complete = false;
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
      if (confirmed.length) {
        ledger.confirmed_category_subtotal_minor = sumMinor(confirmed);
        answer += `\nConfirmed in ${safeDescription(intent.match)} (subtotal): ${money(ledger.confirmed_category_subtotal_minor)} ${refs(confirmed)}.`;
      }
      answer += `\nTransactions without a confirmed category: ${money(ledger.unsorted_minor)} ${refs(unsorted)}.`;
      answer += `\n${bounded}\n${originalRecordSuggestion}`;
      return { answer, citations, ledger };
    }
    ledger.total_minor = sumMinor(matched); ledger.unsorted_minor = sumMinor(unsorted); ledger.found = matched.length > 0;
    if (namedOutflowMerchant) { ledger.match_basis = "exact"; ledger.complete = omittedAccounts.length === 0; }
    ledger.lead_total_minor = sumMinor(withoutLead(matched));
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
      const includesFamily = family.length > 0;
      const basis = includesFamily ? "family" : "exact";
      // Family breakdowns cite every contributing row, including products that
      // would fall outside the compact exact-vendor citation limit.
      const citedRows = includesFamily ? matched : matched.slice(0, 5);
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
      if (possible.length) {
        ledger.match_basis = `${basis}_and_possible`;
        ledger.complete = false;
        if (!includesFamily) ledger.exact_match_count = matched.length;
        ledger.possible_match_count = possible.length;
        ledger[`${basis}_subtotal_minor`] = ledger.total_minor;
        ledger.possible_subtotal_minor = sumMinor(possible);
        ledger[`lead_${basis}_subtotal_minor`] = ledger.lead_total_minor;
        ledger.lead_total_minor = null;
        ledger.if_own_transfers[`${basis}_subtotal_minor`] = ledger.if_own_transfers.total_minor;
        ledger.if_own_transfers.possible_subtotal_minor = sumMinor(withoutCandidates(possible));
        ledger.if_own_transfers.total_minor = null;
        ledger.if_own_transfers.complete = false;
        ledger.total_minor = null;
        answer = `Here is a partial view for "${safeDescription(displayVendor)}": the bank names ${includesFamily ? "these payees" : "it"} on charges totaling ` +
          `${money(ledger[`${basis}_subtotal_minor`])}; another ${money(ledger.possible_subtotal_minor)} only mentions it in the transaction text. ` +
          `These amounts stay separate, with no complete store total confirmed.\n${balanceSuggestion}`;
      } else if (!ledger.coverage.complete) {
        ledger.partial_subtotal_minor = ledger.total_minor;
        ledger.total_minor = null;
        answer = `Here is a partial subtotal for "${safeDescription(displayVendor)}": the charges I can use total ` +
          `${money(ledger.partial_subtotal_minor)} ${compactPeriodLabel(intent)}; ${omittedAccounts.length} account${omittedAccounts.length === 1 ? " is" : "s are"} missing some dates: ${accountEndings(omittedAccounts)}.\n${balanceSuggestion}`;
      } else answer = `You spent ${money(ledger.total_minor)} at ${safeDescription(displayVendor)} ${compactPeriodLabel(intent)}.`;
      if (evidence) answer = answer.includes(`\n${balanceSuggestion}`)
        ? answer.replace(`.\n${balanceSuggestion}`, ` ${evidence}.\n${balanceSuggestion}`) : `${answer} ${evidence}.`;
      if (includesFamily) {
        ledger.included_payees = ledger.groups.map(g => g.merchant);
        for (const group of ledger.groups) answer += `\n${group.merchant}: ${money(group.total_minor)} across ${group.count} ${group.count === 1 ? "row" : "rows"} ${group.citations.map(n => `[${n}]`).join(" ")}.`;
        answer += `\nIncluded payees: ${ledger.included_payees.join("; ")}.`;
        if (ledger.exact_match_count) {
          const added = ledger.groups.filter(g => normalizeMerchantText(g.merchant) !== normalizeMerchantText(intent.match));
          answer += `\nalso includes: ${added.map(g => g.merchant).join("; ")}.`;
        }
      }
      answer += `\n${vendorCoverageLine(ledger.coverage)}`;
      answer += familyAmbiguityLine;
      return { answer, citations, ledger };
    }
    ledger.groups = orderedGroups.map(g => ({ [intent.kind]: safeDescription(g.label),
      category_basis_state: g.state, total_minor: sumMinor(g.rows), citations: g.rows.map(row => cite(row).n),
      possible_transfer_citations: g.rows.filter(row => pairing.candidateRows.has(row.id)).map(row => cite(row).n),
      if_own_transfers_total_minor: sumMinor(withoutCandidates(g.rows)) }));
    answer = `Total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${topicLabel}` : ` by ${intent.kind}`}: ${money(ledger.total_minor)}.`;
    if (!matched.length) answer += " No matching transactions found.";
    for (const g of orderedGroups) answer += `\n${safeDescription(g.label)}${g.state === "proposed" ? " (bank's category (unconfirmed))" : ""}: ${money(sumMinor(g.rows))} ${refs(g.rows)}${g.rows.some(row => pairing.candidateRows.has(row.id)) ? " (includes possible moves between your own accounts)" : ""}.`;
    if (orderedGroups.some(group => group.state === "proposed")) answer += `\nHere are the spending categories from your bank; those marked unconfirmed have not been reviewed.\n${balanceSuggestion}`;
    answer += `\nUnsorted: ${money(ledger.unsorted_minor)}${intent.kind === "category" && intent.match && !matched.some(row => !categoryFor(row)) ? " (separate from the requested category)" : ""} ${refs(unsorted)}.`;
    if (incompleteNamed) {
      const subtotal = amount => (amount > 0
        ? `Income from that payer is at least ${money(amount)} (matched subtotal, not complete); ` : "") +
        `I can help review the deposits, but the full income from that payer is unconfirmed. There ${inflows.length === 1 ? "is 1 deposit" : `are ${inflows.length} deposits`}, and ${inflows.length === 1 ? "its bank label may" : "their bank labels may"} not identify who paid.\n${balanceSuggestion}`;
      leadDetail = subtotal(ledger.lead_total_minor);
      answer = `${subtotal(ledger.total_minor)} ${refs(matched)}`.trim();
      conditionalDetail = subtotal(ledger.if_own_transfers.total_minor);
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
    if (intent.kind === "merchant" && intent.direction === "inflow" && !intent.match) {
      ledger.complete = false;
      ledger.attribution_incomplete = true;
      for (const group of ledger.groups) group.complete = false;
      answer += `\nBank payee names may not identify who paid, so the sender of every deposit is still unconfirmed.\n${balanceSuggestion}`;
    }
  } else if (intent.kind === "transfers") {
    // This diagnostic view keeps its gross, outgoing-date contract. Other
    // answer kinds apply lead exclusions to each leg inside their own window.
    const found = pairs.filter(pair => inWindow(pair.out)).sort((a, b) => b.out.posted_on.localeCompare(a.out.posted_on) || b.out.id - a.out.id);
    const outgoing = intent.limit ? found.slice(0, intent.limit) : found;
    ledger.total_minor = sumMinor(outgoing, pair => pair.out.amount_minor);
    ledger.found = outgoing.length > 0;
    answer = outgoing.length ? `Possible moves between your own accounts: ${money(ledger.total_minor)}, counted once by outgoing posting date; not confirmed.` : "No possible moves between your own accounts found by outgoing posting date.";
    answer += `\nThis reading checks possible moves with enough account details to review; matching amounts alone do not confirm transfers, and no matches does not prove none occurred.\n${balanceSuggestion}`;
    if (intent.limit) {
      ledger.limit = intent.limit;
      ledger.rows = outgoing.map(pair => publicRow(pair.out));
      answer += `\nShowing ${outgoing.length} of ${found.length} possible transfers, newest outgoing posting first.\n${outgoing.map(pair => `${rowLine(pair.out)}; received ${rowLine(pair.in)}.`).join('\n')}`;
      const transfers = outgoing.map(pair => ({ candidate: true, reason: pair.reason, amount_minor: pair.out.amount_minor,
        outgoing: publicRow(pair.out), incoming: publicRow(pair.in) }));
      // This count bounds pairs, including the diagnostic rows. The generic
      // totals appendix would otherwise print the entire uncapped pair pool.
      return { answer: `${answer}\n${bounded}`, citations: [...references.values()], ledger: {
        kind: 'transfers', from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        limit: intent.limit, total_minor: ledger.total_minor, found: ledger.found,
        match_count: found.length, rows: ledger.rows, transfers, complete: omittedAccounts.length === 0,
      } };
    }
  } else if (intent.kind === "recurring") {
    const exactPayee = intent.recurringSelector && activity.some(row => normalizeMerchantText(row.payee) === normalizeMerchantText(intent.recurringSelector));
    const recurringActivity = exactPayee ? activity.filter(row => normalizeMerchantText(row.payee) === normalizeMerchantText(intent.recurringSelector)) : activity;
    const recurring = detectRecurring(recurringActivity, intent.to);
    const occurrences = group => intent.occurrenceLimit ? group.rows.slice(-intent.occurrenceLimit) : group.rows;
    ledger.recurring = recurring.map(g => ({ merchant: safeDescription(g.merchant), cadence: g.cadence,
      typical_minor: g.typical_minor, monthly_minor: g.monthly_minor, last_charge: g.last_charge,
      last_amount_minor: g.rows.at(-1).amount_minor, occurrence_count: g.rows.length, detected: true,
      ...(intent.interpretation ? { occurrences: occurrences(g).map(row => ({ posted_on: row.posted_on, amount_minor: row.amount_minor, account_mask: bySlug.get(row.effective_account_slug).mask })) } : {}),
      citations: occurrences(g).map(row => cite(row).n), possible_transfer_citations: occurrences(g).filter(row => pairing.candidateRows.has(row.id)).map(row => cite(row).n) }));
    ledger.monthly_total_minor = sumMinor(recurring, g => g.monthly_minor); ledger.found = recurring.length > 0;
    ledger.lead_monthly_total_minor = sumMinor(detectRecurring(withoutLead(recurringActivity), intent.to), g => g.monthly_minor);
    leadDetail = `Estimated monthly money out: ${money(ledger.lead_monthly_total_minor)} (detected, not confirmed).`;
    ledger.if_own_transfers.monthly_total_minor = sumMinor(detectRecurring(withoutCandidates(recurringActivity), intent.to), g => g.monthly_minor);
    conditionalDetail = `estimated monthly total: ${money(ledger.if_own_transfers.monthly_total_minor)}`;
    answer = "Recurring charges detected, not confirmed. " + (recurring.length ? recurring.map(g =>
      `${safeDescription(g.merchant)}: ${g.cadence}, typical ${money(g.typical_minor)}; last charge ${money(g.rows.at(-1).amount_minor)} on ${intent.presentation.date(g.last_charge)} ${refs(g.rows)}.`).join("\n") : "No recurring charges detected.");
    answer += `\nI can show repeated bank charges as possible patterns, but they do not prove an active subscription; no detected pattern does not prove none exists.\n${balanceSuggestion}`;
    answer += `\nEstimated monthly total: ${money(ledger.monthly_total_minor)} (weekly amounts use 52/12, rounded to cents per merchant).`;
    if (intent.interpretation) answer += `\nLast ${intent.occurrenceLimit || 10} recorded occurrences of each detected series (up to that limit):\n${recurring.map(g => `${safeDescription(g.merchant)}: ${occurrences(g).slice(-(intent.occurrenceLimit || 10)).map(rowLine).join('; ')}`).join('\n')}`;
    if (intent.annualRecurrenceUnavailable) answer += '\nI checked 400 days for weekly and monthly patterns, but yearly patterns are not assessed. Want to review the weekly and monthly charges?';
    if (intent.recurringSelector && !exactPayee) {
      const closest = [...new Set(activity.map(row => row.payee).filter(payee => payee &&
        normalizeMerchantText(payee).includes(normalizeMerchantText(intent.recurringSelector))))].sort().slice(0, 5);
      ledger.selector_applied = false;
      answer += '\nThis recurring-charge reading has not been narrowed by category. Want to review the full list?';
      if (closest.length) answer += `\nClosest payees containing the word: ${closest.map(safeDescription).join(', ')}.`;
    }
  } else throw new Error("unsupported ledger intent");
  ledger.transfers = pairs.map(pair => ({ candidate: true, excluded_from_totals: false, reason: pair.reason,
    amount_minor: pair.out.amount_minor, outgoing: publicRow(pair.out), incoming: publicRow(pair.in),
    excluded_from_lead: [pair.out, pair.in].some(row => leadExcluded.has(row.id)), kept_reason: keptPairs.get(pair) || null }));
  // Exactly identified liability payments have their own explanation below;
  // they must not reappear as uncertain, unmatched transfers.
  const unmatchedTransfers = unmatched.filter(row => !expensePayments.has(row.id));
  ledger.unmatched_transfers = unmatchedTransfers.map(publicRow);
  const restored = intent.ownTransfers === "include" && intent.withdrawals === "include" && !leadExcluded.size;
  if (intent.measure || (!restored && (leadExcluded.size || keptPairs.size))) {
    const notes = [];
    if (noteSummary.own_transfer_pairs) { notes.push(`${money(noteSummary.own_transfer_minor)} between your own connected accounts left out of the first figures; say "including transfers" to count those moves`); ledger.flip.push("including transfers"); }
    if (noteSummary.withdrawal_count) { notes.push(`${money(noteSummary.withdrawal_minor)} in retirement or investment withdrawals left out of the first figures; say "including withdrawals" to count them`); ledger.flip.push("including withdrawals"); }
    if (noteSummary.loan_proceeds_count) { notes.push(`${money(noteSummary.loan_proceeds_minor)} in loan or line-of-credit proceeds left out of the first figures; say "including loan proceeds" to count them`); ledger.flip.push("including loan proceeds"); }
    if (expensePayments.size) notes.push("payments to your own loan/card accounts are shown separately from expenses");
    if (unchangedLimitedList && leadExcluded.size) notes.push("exclusions apply to the wider candidate pool; the displayed rows are unchanged");
    if (!unchangedLimitedList && [...keptPairs.values()].some(reason => reason.startsWith("other account"))) {
      notes.push('moves with an account outside this question are kept; say "excluding transfers" to leave them out'); ledger.flip.push("excluding transfers");
    }
    if (!notes.length) notes.push(keptPairs.size ? "paired activity stays where listed below" : "only checking, savings and card accounts contribute to money in minus money out");
    // Gross sentences retain their wording and citation order for existing clients.
    answer = `${leadDetail || answer}\nNote: ${notes.join("; ")}.\nWith everything counted:\n${answer}\n${bounded}`;
    const omittedPairs = pairs.filter(pair => !expensePayments.has(pair.out.id) &&
      [pair.out, pair.in].some(row => noteExcluded.has(row.id)));
    if (omittedPairs.length) {
      answer += "\nMoves between your own connected accounts, left out of the first figures:";
      const leadRowLine = row => rowLine(row).replace(candidateMark(row), leadExcluded.has(row.id)
        ? ` (left out of the first figures as ${leadExcluded.get(row.id)})` : " (outside this answer's accounts or period)");
      for (const pair of omittedPairs) answer += `\n${leadRowLine(pair.out)}; received ${leadRowLine(pair.in)}. Why: ${pair.reason}.`;
    }
    if (keptPairs.size) answer += "\nKept pairs:";
    for (const [pair, reason] of keptPairs) answer += `\n${rowLine(pair.out)}; received ${rowLine(pair.in)}. ${reason}.`;
  } else {
    answer += `\n${bounded}\nPossible transfers are included in income and spend; no rows were removed as transfers.`;
    if (pairs.length) {
      answer += "\nPossible moves between your own accounts:";
      for (const pair of pairs) answer += `\n${rowLine(pair.out)}; received ${rowLine(pair.in)}. Why: ${pair.reason}.`;
      answer += `\nIf these are transfers between your own accounts, with those candidates excluded: ${conditionalDetail}.`;
    }
  }
  const exclusionLabel = row => noteExcluded.has(row.id)
    ? `left out of the first figures as ${leadExcluded.get(row.id)}; kept in the gross figures`
    : `${leadExcluded.get(row.id)} excluded from the wider candidate pool; outside the displayed rows`;
  for (const row of unmatchedTransfers) answer += `\nPossible transfer, unmatched (${leadExcluded.has(row.id)
    ? exclusionLabel(row)
    : "retained in income/spend totals"}): ${rowLine(row)}.`;
  if (incompleteNamed) {
    const detail = inflowDetail(cite);
    ledger.complete = false; ledger.attribution_incomplete = true;
    ledger.inflow_count = inflows.length; ledger.inflows = detail.deposits;
    answer += `\n${detail.answer}`;
  }
  if (partialSimpleFinRanking) {
    ledger.complete = false;
    ledger.partial_reason = "ledger_partial_coverage";
    answer = (ledger.found
      ? `Here are the expenses I found in a partial ranking; the bank connection has not supplied every day in the requested period.\n${balanceSuggestion}`
      : `I checked the saved transactions and found no matches, but some days may be missing, so this is a partial ranking and does not confirm there were no expenses.\n${balanceSuggestion}`) + `\n${answer}`;
  }
  if (intent.answerAddOn === 'share' && intent.kind === 'largest' && intent.direction === 'outflow') {
    const share = ledger.share_of_total;
    answer += share ? `\nShare of total: ${money(share.listed_minor)} of ${money(share.total_minor)} in ordinary spending, ${share.percent}%, for the same accounts and ${intent.presentation.period(intent.from, intent.to)}.`
      : '\nI can show the listed expenses, but their share is unconfirmed without a complete positive spending total and confirmed expense types. Want to review the total first?';
  }
  if (expensePayments.size) {
    // The payment summary owns this explanation. A dated excluded-row appendix
    // repeats the same liability payment and is not an ordinary expense row.
    answer += `\nPayments to your own loan/card accounts: ${money(ledger.own_account_payments.total_minor)} across ${expensePayments.size} ${expensePayments.size === 1 ? "payment" : "payments"}.`;
  }
  return { answer, citations, ledger };
}

// The only integration point wraps the existing document path. Non-money
// responses return untouched, including their exact serialized bytes.

export async function withLedgerAnswer(options, next) {
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
  const extracted = decision && decision.outcome !== 'fallback' ? decision.intents : null;
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
  // Validate both parts before reading. If either cannot be answered, retain
  // the original document behavior rather than presenting a partial question
  // as fully answered. Each part uses the same reviewed read/composition path.
  const parts = [];
  const hasForecast = extracted.some(intent => intent.forecastRequested);
  for (const intent of extracted) {
    const response = await withParsedLedgerAnswer(evaluated,
      async gap => Response.json({ ledger: null, answer: `${intent.interpretation}\n${gap?.detail || plainRouterLimitation('reading_unavailable')}`,
        citations: [], gaps: gap ? [gap] : [], evidence_gate: { supported: false, complete: false } }), intent);
    const part = await response.json();
    // A validated forecast must retain its refusal even when another part or
    // its snapshot is unavailable. Never offer that question to synthesis.
    if (!part.ledger && !hasForecast) return withParsedLedgerAnswer(evaluated, next, parsed);
    parts.push(part);
  }
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
    const interpretation = extracted[index].interpretation;
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
  let comparison;
  if (decision.comparison) {
    const usable = part => part && part.complete !== false && part.coverage?.complete !== false && !part.classification_uncertain && !part.selector_unresolved && !part.net_refunds_unavailable;
    const figure = (part, intent) => !usable(part) ? null
      : intent.netRefunds || intent.refundsNotNetted ? part.net_expense_minor ?? null
      : part?.kind === 'expense_summary' ? part.expense_total_minor
        : part?.kind === 'totals' && part.income_established === false ? part.combined_inflow_minor
          : part?.kind === 'balance' && new Set(part.accounts.map(account => account.balance_group)).size === 1 ? sumMinor(part.accounts, account => account.current_minor)
          : ['merchant', 'category'].includes(part?.kind) ? part.lead_total_minor ?? part.total_minor : null;
    const figures = combined.map((part, index) => figure(part.ledger, extracted[index]));
    if (figures.every(Number.isSafeInteger)) {
      const difference = figures[0] - figures[1];
      if (Number.isSafeInteger(difference)) comparison = { figures_minor: figures, difference_minor: difference };
    }
    if (extracted.every(intent => intent.kind === 'totals' && !intent.inflowOnly) && combined.every(part => usable(part.ledger))) {
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
    : decision.comparison ? '\n\nAn exact difference is unconfirmed without two complete totals measuring the same thing. Want to review the two totals?' : '';
  return Response.json(ledgerClarificationAnswer({ mode: "think", answer: combined.map(part => part.answer).join("\n\n") + arithmetic,
    citations: combined.flatMap(part => part.citations),
    results: [], gaps: parts.flatMap(part => part.gaps),
    ledger: { kind: "multi", parts: combined.map(part => part.ledger), ...(comparison ? { comparison } : {}) },
    evidence_gate: { supported: parts.every(part => part.evidence_gate.supported),
      complete: parts.every(part => part.evidence_gate.complete),
      partial: parts.some(part => !part.evidence_gate.complete), reason: "separate ledger answers for two question parts" } }, decision));
}

async function withParsedLedgerAnswer(options, next, intent) {
  const { env, question, access, grantScope, scopePrincipalKind,
    filters = {}, entityScope, ledgerEligible = true, now = Date.now() } = options;
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
  // An unsupported question needs ordinary document retrieval. Inventory
  // coincidences cannot add a bank gap or interrupt that unrelated path.
  if (!intent.broad) return next(null);
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
      if (intent.interpretation && !intent.modelAccountScope && intent.kind === 'merchant' && intent.match && accountsForSelector(inventory, intent.match).length) {
        // Recorded account labels can identify the owner's business without
        // containing an account noun. Keep unrelated payees out of that label.
        intent.modelAccountScope = intent.match;
        intent.kind = intent.direction === 'inflow' ? 'deposits' : 'expense_summary';
        if (intent.kind === 'deposits') intent.limit = 10;
        delete intent.match;
        delete intent.merchantPreposition;
      }
      if (intent.modelAccountScope) {
        // A model selector containing an account or own-business term never
        // filters payees. An unresolved account remains a labeled broad reading.
        const selected = intent.unresolvedAccountRole ? [] : accountsForSelector(inventory, intent.modelAccountScope, true);
        if (selected.length > 0) intent.accountSelector = intent.modelAccountScope;
        else intent.accountScopeUnresolved = true;
        intent.interpretation = ledgerIntentInterpretation(intent);
      }
      // Entity type comes from the confirmed owned-entity join, never from a
      // model label or account display name. The balance batch rechecks it.
      if (intent.entityKind) accounts = accounts.filter(a => a.members.every(m => m.entity_kind === intent.entityKind));
      if (intent.accountSelector) {
        // Literal labels and masks are stronger than account-kind words that
        // happen to occur inside a label, including unreviewed feed accounts.
        accounts = accountsForSelector(inventory, intent.accountSelector, Boolean(intent.modelAccountScope));
        if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
      } else {
        if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
        if (intent.accountKind) accounts = accounts.filter(a => a.account_kind === intent.accountKind);
      }
      if (intent.earliestCoveredDate) {
        const starts = accounts.map(account => account.covered_from).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day || ''));
        if (starts.length === accounts.length && starts.length) {
          intent.from = starts.sort()[0];
          intent.periodLabel = `since ${intent.presentation.date(intent.from)}, the earliest date I have`;
          intent.interpretation = ledgerIntentInterpretation(intent);
        } else throw new Error('earliest coverage unavailable');
      }
      const disputed = accounts.filter(a => accountLinkRequiredInWindow(a, intent));
      let reason = !accounts.length ? "no_accounts" : disputed.length ? 'ledger_account_link_required' : accounts.some(a => a.ambiguous || a.members.some(m => m.basis_state !== "confirmed")) ||
        (!intent.accountSelector && intent.mask && accounts.length !== 1) ? "ambiguous_account" :
        accounts.some(a => a.currency !== "USD") ? "unsupported_currency" : !intent.kind ? "unsupported_question" : null;
      if (!reason) {
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
          // An explicit period never opts into a second answer window. Only
          // posted ordinary expense membership determines an empty default.
          if (intent.defaultedPeriod && (earlyDefaultDay || answer.ledger.row_count === 0)) {
            await addPreviousExpenseMonth(env, intent, accounts, inventory, answer);
          }
          if (intent.modelAccountScope && !intent.accountScopeUnresolved) answer.answer += `\nAccounts used: ${accounts.map(accountDisplay).join('; ')}.`;
          if (intent.earliestCoveredDate) answer.answer += `\n${intent.periodLabel}.`;
          if (intent.perAccountLargest) {
            const parts = [], text = [];
            for (const account of accounts) {
              const part = await ledgerAnswer(env, { ...intent, perAccountLargest: false }, [account], inventory);
              if (!part.ledger || part.reason) throw new Error('per-account ranking unavailable');
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
          if (intent.refundsNotNetted) {
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
          if (answer.ledger.kind !== "balance") answer.answer += `\n${pendingNotice}`;
          if (intent.from && intent.to && configuredTimeZone) answer.ledger.time_zone = intent.timeZone;
          const partialCoverage = answer.ledger.partial_reason === "ledger_partial_coverage";
          const incomplete = Boolean(answer.ledger.net_refunds_unavailable || answer.ledger.attribution_incomplete || answer.ledger.complete === false ||
            answer.ledger.known_own_transfer_in_lead || answer.ledger.previous_month?.complete === false);
          return new Response(JSON.stringify(finalLedgerOffer({ mode: "think", answer: intent.interpretation
            ? `${intent.interpretation}\n${answer.answer}` : answer.answer,
          citations: answer.citations, results: [],
          gaps: [...(answer.gaps || []), ...(partialCoverage ? [gapFor("ledger_partial_coverage", accounts, intent)] : [])], ledger: answer.ledger,
          evidence_gate: { supported: true, complete: !incomplete, partial: incomplete,
            reason: answer.ledger.net_refunds_unavailable ? "net of refunds unavailable; gross recorded amounts only"
              : answer.ledger.forecast_supported === false ? "forecast unavailable; current recorded balance observations only"
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
  const reason = gap.reason;
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
