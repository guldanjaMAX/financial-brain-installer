import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion, ledgerDay, shiftLedgerDay } from "./ledger-question.js";
import { accountLinkRequiredInWindow, effectivePeriodCovered, readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions } from "./ledger-reader.js";
import { categoryFor, classifyOwnedMovement, detectRecurring, isDirectedOwnedTransfer, isLoanAdvance, matchesCategory, matchesMerchant, matchesSender, merchantFor, merchantMatchBasis, normalizeMerchantText, ownedLiabilityPaymentKind, pairOwnTransfers, sumMinor } from "./ledger-analysis.js";

const masked = account => /^\d{1,4}$/.test(account.mask || "") ? `account ****${account.mask}` : "account (mask unavailable)";
const money = cents => `${cents < 0 ? "-" : ""}$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const safeDescription = text => String(text || "Deposit").replace(/\d(?:[\s-]*\d){4,}/g, "[redacted]").slice(0, 240);
const accountDisplay = account => {
  const label = String(account?.label || "").replace(/\d(?:[\s-]*\d){4,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 120);
  return label ? /^\d{1,4}$/.test(account?.mask || "") ? `${label} (${masked(account)})` : label : masked(account || {});
};
const normalizeAccountText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
const withoutAccountKind = value => value.replace(/\b(?:account|acct|credit|card|checking|savings|loan|investment|retirement|escrow)\b/g, "").replace(/\s+/g, " ").trim();
function accountSelectorRank(account, selector) {
  const wanted = normalizeAccountText(selector);
  if (!wanted) return 0;
  let rank = 0;
  for (const member of account.members || [account]) {
    if (/^\d{1,4}$/.test(member.mask || "") && (wanted === member.mask ||
        new RegExp(`^(?:(?:account|acct|card|checking|savings|loan) )?(?:ending (?:in )?)?${member.mask}$`).test(wanted))) rank = 2;
    const label = normalizeAccountText(member.label);
    if (label && wanted === label) rank = 2;
    else if (label && withoutAccountKind(wanted) && withoutAccountKind(wanted) === withoutAccountKind(label)) {
      rank = Math.max(rank, 1);
    }
  }
  return rank;
}
function accountsForSelector(inventory, selector) {
  const ranked = inventory.map(account => ({ account, rank: accountSelectorRank(account, selector) }));
  const best = Math.max(0, ...ranked.map(row => row.rank));
  return best ? ranked.filter(row => row.rank === best).map(row => row.account) : [];
}
const simpleFinUnreviewedAccount = account => (account.members || [account]).every(member =>
  member.feed_mode === "live" && member.account_kind === "other" && member.balance_role === "neither" &&
  /^simplefin-[a-f0-9]{16,59}$/.test(member.account_slug || "") && /^bank-feed:/.test(member.source_feed || ""));
const accountCoverage = accounts => accounts.map(a => ({
  account_mask: /^\d{1,4}$/.test(a.mask || "") ? a.mask : null,
  covered_to: a.covered_to || null, last_synced_at: a.last_synced_at || null,
}));
const balanceKindOrder = new Map(["checking", "savings", "card", "loan", "line_of_credit"].map((kind, index) => [kind, index]));
const compactPeriodLabel = ({ from, to }) => {
  const [year, month, day] = String(from || "").split("-").map(Number);
  if (day === 1 && String(to || "").slice(0, 7) === String(from).slice(0, 7)) {
    const monthEnd = ledgerDay(Date.UTC(year, month, 0));
    if (to !== monthEnd) return "this month";
    const monthName = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"][month - 1];
    if (monthName) return `in ${monthName} ${year}`;
  }
  return `from ${from} through ${to}`;
};

function gapFor(reason, accounts = [], intent = {}) {
  const review = {
    ledger_wording_unsupported: 'The bank records were not checked for this wording. Try: "What are my account balances?", "How much money came in and went out in September 2026?", or "Did the payment of $123.45 arrive?"',
    owner_timezone_unavailable: "The owner's configured IANA time zone is missing or invalid, so a current or relative bank-ledger window cannot be derived. Use an explicit historical date or month and year, or correct the configured owner time zone.",
    cash_flow_unsupported: "Cash flow is not supported. Posted card purchases can be unpaid, and combining card charges with checking and savings activity is not a cash-flow measure. Ask for money in and money out, or the bounded profit/net income surplus; neither is accounting profit or cash flow.",
    merchant_selector_unsupported: "This printed merchant label is redacted, shortened or unknown and cannot identify an exact merchant safely. Quote the original by-merchant list line with its period and account scope; do not turn this refusal into zero or guess the hidden text.",
    merchant_selector_ambiguous: "This merchant spelling differs from a stored label only by and or &. Use the exact printed label, including its literal conjunction, or quote the by-merchant list line. Do not substitute and for & or combine different merchants.",
    coverage_review_required: "A previous partial import may have widened a complete coverage interval across unobserved days. Transactions are retained, but this interval is unproven until its coverage is independently reviewed and re-established. No total or zero is certified.",
    bank_export_overlap_review_required: "Overlapping bank exports use different transaction identities. Existing rows and provenance are retained. Review the original exports and statements to determine whether these are duplicate records or separate purchases before a separately approved reconciliation. No total or zero is certified, and no rows were merged or deleted.",
    ledger_partial_coverage: "The listed ledger rows are usable, but the connected ledger interval is not certified complete. The answer is a cited partial view of what was found, not a complete ranking or proof of zero.",
  };
  if (review[reason]) return { type: reason === "ledger_partial_coverage" ? "ledger_partial_coverage" : "ledger_not_consulted", reason, code: reason,
    ...(intent.from ? { from: intent.from, to: intent.to } : {}), detail: review[reason] };
  if (reason === 'ledger_account_link_required') {
    return { type: 'ledger_not_consulted', reason, code: reason,
      ...(intent.from ? { from: intent.from, to: intent.to } : {}),
      detail: "A manual import and live feed may describe the same account. The Brain is missing the owner's confirmation that they are the same account. Ask the installer to review the two records with the owner. Until then, no total or zero is certified, and no account or transaction history is changed." };
  }
  const coverage = accountCoverage(accounts);
  const detail = coverage.length ? coverage.map(a =>
    `${a.account_mask ? `****${a.account_mask}` : "mask unavailable"}: covered through ${a.covered_to || "unknown"}, feed last synced ${a.last_synced_at || "unknown"}`
  ).join("; ") : "No authorized account coverage was available.";
  return {
    type: reason === "period_outside_coverage" ? "ledger_out_of_coverage" : "ledger_not_consulted",
    reason, accounts: coverage,
    ...(intent.from ? { from: intent.from, to: intent.to } : {}),
    detail: `The bank ledger did not answer this question (${reason.replaceAll("_", " ")}). ${detail} Document dates do not measure bank-feed freshness.`,
  };
}

function citation(row, account, index, balance = false) {
  const amount = balance ? row.current_minor : row.amount_minor;
  const day = balance ? row.as_of_date : row.posted_on;
  const member = account.members.find(a => a.account_slug === row.source_account_slug);
  return {
    n: index + 1, source: "ledger", source_kind: "ledger",
    ref: `ledger:${balance ? "balance" : "transaction"}:${row.id}`,
    title: `${masked(account)}: ${money(amount)} on ${day}`,
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
  const excluded = new Set(), ownPairs = [], withdrawals = new Map(), loanProceeds = new Map(), keptPairs = new Map();
  const knownOwnTransferRows = new Set(), scopedKnownTransferRows = new Set();
  const inAnswer = new Set(rows.map(row => row.id));
  const kind = row => bySlug.get(row.effective_account_slug).account_kind;
  const omit = row => { if (inAnswer.has(row.id)) excluded.add(row.id); };
  // A category code is evidence; description words and institution names are
  // never withdrawal evidence. Proposed feed categories count by this rule.
  if (intent.withdrawals !== "include") for (const row of rows) {
    if (row.direction === "inflow" && moveKind(kind(row)) &&
        /^TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS$/i.test(row.category || "") &&
        ["proposed", "confirmed"].includes(row.category_basis_state)) {
      omit(row); withdrawals.set(row.id, row);
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
        omit(pair.out); omit(pair.in); ownPairs.push(pair);
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
        omit(pair.out); omit(pair.in); withdrawals.set(pair.in.id, pair.in);
      }
    } else if (isLoanAdvance(pair, bySlug) && selected.has(pair.in.effective_account_slug)) {
      if (intent.loanProceeds !== "include") {
        omit(pair.out); omit(pair.in); loanProceeds.set(pair.in.id, pair.in);
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

function expenseSummary({ intent, accounts, requestedAccounts, omittedAccounts, rows, pairs, pairing, bySlug }) {
  const outflows = rows.filter(row => row.direction === "outflow");
  const ownTransfers = new Map(), payments = new Map();
  for (const pair of pairs) {
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
  const citations = evidenceRows.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index));
  const citationById = new Map(evidenceRows.map((row, index) => [row.id, index + 1]));
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
  const displayedCategories = orderedCategories.slice(0, 10).map(group => ({
    category: safeDescription(group.category), total_minor: group.total_minor, count: group.count,
    citations: [...group.rows].sort(rowOrder).map(row => citationById.get(row.id)).filter(Boolean),
  }));
  const paymentRows = [...payments.values()];
  const paymentTotal = sumMinor(paymentRows, item => item.row.amount_minor);
  const cardMinor = sumMinor(paymentRows.filter(item => item.liabilityKind === "card"), item => item.row.amount_minor);
  const loanMinor = sumMinor(paymentRows.filter(item => item.liabilityKind === "loan"), item => item.row.amount_minor);
  const totalMinor = sumMinor(ordinary);
  const omittedRowCount = ordinary.length - citations.length;
  const complete = omittedAccounts.length === 0;
  const coverage = {
    status: complete ? "full" : "partial", complete,
    candidate_account_count: requestedAccounts.length,
    covered_account_count: accounts.length,
    omitted_account_count: omittedAccounts.length,
    excluded_accounts: omittedAccounts.map(account => ({
      account_mask: /^\d{1,4}$/.test(account.mask || "") ? account.mask : null,
      account_kind: account.account_kind,
    })),
  };
  const ledger = {
    kind: "expense_summary", from: intent.from, to: intent.to,
    accounts: accountCoverage(accounts), coverage, complete,
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
  const label = intent.periodLabel === "this month" ? "this month"
    : intent.periodLabel === "last month" ? "last month"
      : intent.periodLabel === "today" ? "today"
        : intent.periodLabel === "yesterday" ? "yesterday"
          : intent.periodLabel === "this week" ? "this week"
            : `${intent.from} through ${intent.to}`;
  const partial = complete ? "" : " (partial coverage)";
  let answer = complete
    ? `You spent ${money(totalMinor)} ${label}.\nPeriod: ${intent.from} through ${intent.to}.`
    : `Covered-account expense subtotal: ${money(totalMinor)} ${label}${partial}.\nPeriod: ${intent.from} through ${intent.to}.`;
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
  if (paymentRows.length) answer += `\nPayments to your own loan/card accounts: ${money(paymentTotal)} across ${paymentRows.length} ${paymentRows.length === 1 ? "payment" : "payments"}.`;
  answer += `\nEvidence: ${citations.length} of ${ordinary.length} expense rows cited${omittedRowCount ? `, and ${omittedRowCount} more rows` : ""}.`;
  answer += complete
    ? `\nCoverage: full, all ${accounts.length} selected accounts cover ${intent.from} through ${intent.to}.`
    : `\nCoverage: partial, ${accounts.length} of ${requestedAccounts.length} selected accounts cover ${intent.from} through ${intent.to}; excluded ${omittedAccounts.map(masked).join(", ")}.`;
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

async function ledgerAnswer(env, intent, accounts, inventory) {
  if (intent.measure === "cash_flow") return { reason: "cash_flow_unsupported" };
  if (intent.measure && !accounts.some(a => moveKind(a.account_kind))) return { reason: "unsupported_question" };
  if (intent.kind === "balance") {
    const snapshotAccounts = intent.accountSelector ? inventory : accounts;
    const observed = await readEffectiveBalances(env, snapshotAccounts, intent.accountSelector
      ? { ...intent, mask: null, accountKind: null,
        effectiveAccountSlugs: accounts.map(account => account.account_slug) } : intent);
    const selected = new Set(accounts.map(account => account.account_slug));
    const balances = observed.filter(row => selected.has(row.effective_account_slug));
    if (balances.length !== accounts.length || balances.some(b => b.basis_state !== "confirmed" ||
      !Number.isSafeInteger(b.current_minor) || b.currency !== "USD")) return { reason: "balance_unavailable" };
    const ordered = balances.map(row => ({ row, account: accounts.find(a => a.account_slug === row.effective_account_slug) }));
    if (ordered.some(entry => !entry.account)) return { reason: "balance_unavailable" };
    ordered.sort((a, b) => (balanceKindOrder.get(a.account.account_kind) ?? balanceKindOrder.size) -
      (balanceKindOrder.get(b.account.account_kind) ?? balanceKindOrder.size) ||
      String(a.account.mask || "").localeCompare(String(b.account.mask || "")) ||
      a.account.account_slug.localeCompare(b.account.account_slug));
    const cited = ordered.slice(0, 5);
    const citations = cited.map(({ row, account }, index) => citation(row, account, index, true));
    const ledgerAccounts = ordered.map(({ row, account }) => ({
      account_mask: /^\d{1,4}$/.test(account.mask || "") ? account.mask : null,
      current_minor: row.current_minor, as_of: row.as_of_date, last_synced_at: row.last_synced_at || null,
    }));
    const answer = ["Your latest synced balances are below.", ...cited.map(({ row, account }, index) => {
      const synced = /^\d{4}-\d{2}-\d{2}/.exec(String(row.last_synced_at || ""))?.[0] || "unavailable";
      return `${accountDisplay(account)}: ${money(row.current_minor)} as of ${row.as_of_date}; feed synced ${synced} [${index + 1}].`;
    }), ...(ordered.length > cited.length ? [`and ${ordered.length - cited.length} more accounts`] : [])].join("\n");
    return { answer, citations, ledger: { kind: "balance", accounts: ledgerAccounts } };
  }
  if (intent.kind === "transactions") {
    const knownStarts = accounts.map(account => account.covered_from).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day || ""));
    const from = knownStarts.length === accounts.length ? knownStarts.sort().at(-1) : shiftLedgerDay(intent.to, -3659);
    const snapshotAccounts = intent.accountSelector ? inventory : accounts;
    const observed = await readEffectiveTransactions(env, snapshotAccounts, {
      ...intent, from, mask: intent.accountSelector ? null : intent.mask,
      accountKind: intent.accountSelector ? null : intent.accountKind,
      effectiveAccountSlugs: intent.accountSelector ? accounts.map(account => account.account_slug) : null,
    });
    const selected = new Set(accounts.map(account => account.account_slug));
    const rows = observed.filter(row => selected.has(row.effective_account_slug));
    if (rows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
    if (rows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
    rows.sort((a, b) => b.posted_on.localeCompare(a.posted_on) || b.id - a.id);
    const listed = rows.slice(0, intent.limit);
    const bySlug = new Map(inventory.map(account => [account.account_slug, account]));
    const citations = listed.map((row, index) => citation(row, bySlug.get(row.effective_account_slug), index));
    const complete = listed.length === intent.limit && accounts.every(account => effectivePeriodCovered(account, from, intent.to));
    const lines = listed.map((row, index) => {
      const account = bySlug.get(row.effective_account_slug);
      const amount = row.direction === "outflow" ? -row.amount_minor : row.amount_minor;
      return `${row.posted_on}: ${safeDescription(row.payee || row.description || "Payee unavailable")}, ${money(amount)}, ${accountDisplay(account)} [${index + 1}].`;
    });
    const heading = complete
      ? `Newest ${listed.length} transaction${listed.length === 1 ? "" : "s"}:`
      : `Partial list from available ledger records (${listed.length} transaction${listed.length === 1 ? "" : "s"} found; completeness is not proven):`;
    return { answer: `${heading}${lines.length ? `\n${lines.join("\n")}` : " no readable transactions were found."}`,
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
  const allRows = await readEffectiveTransactions(env, payment ? accounts : inventory, payment ? intent : {
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
    return { deposits, answer: `In-scope deposits (showing ${listed.length} of ${inflows.length}):\n${deposits.map(row =>
      `${row.posted_on}: ${money(row.amount_minor)} in ${masked({ mask: row.account_mask })} [${row.n}].`).join("\n")}` };
  };
  if (intent.kind === "payment") {
    const matched = rows.filter(row => {
      if (row.direction !== "inflow" || (intent.amountMinor !== null && row.amount_minor !== intent.amountMinor)) return false;
      // An amount narrows an attributed receipt; it cannot promote a memo
      // subject to sender or override a different explicit payee.
      return matchesSender(row, intent.counterpartyWords);
    });
    // The first read preserves the base positive path. Before claiming an
    // empty period, re-read without an amount predicate to see every inflow.
    if (!matched.length && intent.counterpartyWords.length && intent.amountMinor !== null) {
      const windowRows = await readEffectiveTransactions(env, accounts, { ...intent, amountMinor: null });
      if (windowRows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
      if (windowRows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
      inflows = windowRows.filter(row => row.direction === "inflow");
    }
    const citations = matched.map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i));
    if (!matched.length && intent.counterpartyWords.length && inflows.length) {
      const detail = inflowDetail(row => {
        const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length);
        citations.push(ref); return ref;
      });
      return { answer: `I can't confirm whether that payer paid.\n${detail.answer}\nAccounts: ${accounts.map(masked).join(", ")}; ${intent.from} through ${intent.to}; ${accounts.map(a => `${masked(a)}: covered through ${a.covered_to || "unknown"}`).join("; ")}.`,
        citations, ledger: { kind: "payment", found: null, total_minor: null, complete: false,
          from: intent.from, to: intent.to, amount_minor: intent.amountMinor, accounts: accountCoverage(accounts),
          attribution_incomplete: true, inflow_count: inflows.length, inflows: detail.deposits } };
    }
    const answer = matched.length
      ? matched.map((row, i) => `Found a deposit of ${money(row.amount_minor)} posted ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description)} [${i + 1}].`).join("\n")
      : `${intent.counterpartyWords.length && !inflows.length ? "No deposits at all in this period" : "No matching deposit"} in ${accounts.map(masked).join(", ")} between ${intent.from} and ${intent.to}; the bank feed covers through ${accounts.map(a => `${masked(a)}: ${a.live?.covered_to || "unknown (manual records only)"}`).join("; ")}.`;
    return { answer, citations, ledger: { kind: "payment", found: matched.length > 0,
      from: intent.from, to: intent.to, amount_minor: intent.amountMinor, accounts: accountCoverage(accounts) } };
  }
  let namedOutflowMerchant = null;
  if (intent.kind === "merchant" && intent.match) {
    const wanted = normalizeMerchantText(intent.match);
    const directionRows = rows.filter(row => row.direction === intent.direction);
    if (intent.direction === "outflow") {
      const exact = directionRows.filter(row => merchantMatchBasis(row, intent.match) === "exact");
      namedOutflowMerchant = { directionRows, exact,
        possible: directionRows.filter(row => merchantMatchBasis(row, intent.match) === "possible") };
    }
    const conjunction = text => text.replace(/\b(and)\b|&/g, "and");
    if (!directionRows.some(row => matchesMerchant(row, intent.match)) && directionRows.some(row =>
      conjunction(merchantFor(row)) === conjunction(wanted))) return { reason: "merchant_selector_ambiguous" };
  }
  const eligible = allRows.filter(row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
    effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on));
  const pairing = pairOwnTransfers(eligible, bySlug);
  const pairs = pairing.pairs.filter(pair => intent.kind === "expense_summary"
    ? selected.has(pair.out.effective_account_slug) && inWindow(pair.out)
    : [pair.out, pair.in].some(row => selected.has(row.effective_account_slug) && inWindow(row)));
  const unmatched = pairing.unmatched.filter(row => selected.has(row.effective_account_slug) && inWindow(row));
  if (intent.kind === "expense_summary") return expenseSummary({
    intent, accounts, requestedAccounts, omittedAccounts, rows, pairs, pairing, bySlug,
  });
  // Pairs never change stored rows or existing gross keys. Qualifying pairs
  // leave the lead figures; the unchanged gross figures are always printed.
  // Notes describe only rows feeding this answer, including its Unsorted line.
  // An unrelated transfer elsewhere in the window cannot change a merchant total.
  let figureRows = rows;
  if (["largest", "deposits", "merchant", "category"].includes(intent.kind)) {
    figureRows = rows.filter(row => row.direction === intent.direction);
    if (intent.match) figureRows = namedOutflowMerchant
      ? [...namedOutflowMerchant.exact, ...namedOutflowMerchant.possible]
      : figureRows.filter(row =>
        (intent.kind === "merchant" ? matchesMerchant : matchesCategory)(row, intent.match) ||
        (intent.kind === "category" && !categoryFor(row)));
  } else if (intent.kind === "recurring") figureRows = detectRecurring(rows, intent.to).flatMap(group => group.rows);
  const { excluded: leadExcluded, keptPairs, knownOwnTransferRows, scopedKnownTransferRows, summary } = leadExclusions(figureRows, intent.kind === "transfers" ? [] : pairs, selected, bySlug,
    intent.kind === "transfers" ? { withdrawals: "include" } : namedOutflowMerchant ? { ...intent, ownTransfers: "exclude" } : intent);
  // Compact vendor spend excludes only bilaterally proved own movements and
  // payments to an exactly identified owned liability. A possible transfer is
  // never enough, and the omitted account's rows never enter the subtotal.
  if (namedOutflowMerchant) for (const pair of pairs) {
    if (!isDirectedOwnedTransfer(pair, bySlug)) continue;
    const outKind = bySlug.get(pair.out.effective_account_slug)?.account_kind;
    const inKind = bySlug.get(pair.in.effective_account_slug)?.account_kind;
    if (!(moveKind(outKind) && (moveKind(inKind) || ["loan", "line_of_credit"].includes(inKind)))) continue;
    if (figureRows.some(row => row.id === pair.out.id)) leadExcluded.add(pair.out.id);
    if (figureRows.some(row => row.id === pair.in.id)) leadExcluded.add(pair.in.id);
  }
  let noteSummary = summary, noteExcluded = leadExcluded, unchangedLimitedList = false;
  const withoutLead = list => list.filter(row => !leadExcluded.has(row.id));
  const activity = rows;
  const withoutCandidates = list => list.filter(row => !pairing.candidateRows.has(row.id));
  const citations = [], references = new Map();
  const cite = row => {
    if (!references.has(row.id)) {
      const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length);
      references.set(row.id, ref); citations.push(ref);
    }
    return references.get(row.id);
  };
  const refs = list => list.map(row => `[${cite(row).n}]`).join(" ");
  const candidateMark = row => scopedKnownTransferRows.has(row.id)
    ? " (known move between your own accounts, kept in money in and money out)"
    : pairing.candidateRows.has(row.id) ? " (possible move between your own accounts, included)" : "";
  const publicRow = row => ({ ...cite(row), ...(incompleteNamed ? {} : { description: safeDescription(row.description || row.payee || "Transaction") }), possible_own_transfer: pairing.candidateRows.has(row.id) });
  const rowLine = row => `${money(row.amount_minor)} on ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}${incompleteNamed ? "" : `: ${safeDescription(row.description || row.payee || "Transaction")}`}${candidateMark(row)} ${refs([row])}`;
  const bounded = `Accounts: ${accounts.map(masked).join(", ")}; ${intent.from} through ${intent.to}; ${accounts.map(a => `${masked(a)}: covered through ${a.covered_to || "unknown"}`).join("; ")}.`;
  const vendorCoverage = contributingRows => ({
    complete: omittedAccounts.length === 0,
    candidate_account_count: requestedAccounts.length,
    covered_account_count: accounts.length,
    omitted_account_count: omittedAccounts.length,
    contributing_account_count: new Set(contributingRows.map(row => row.effective_account_slug)).size,
  });
  const vendorCoverageLine = coverage => `Coverage: requested ${intent.from} through ${intent.to}; ` +
    `${coverage.contributing_account_count} contributing, ${coverage.covered_account_count} fully covered, ` +
    `${coverage.omitted_account_count} omitted account${coverage.omitted_account_count === 1 ? "" : "s"}; ` +
    accounts.map(account => `${masked(account)} covered through ${account.covered_to || "unknown"}`).join("; ") + ".";
  const ledger = { kind: intent.kind, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
    includes_own_transfers: true, matched_transfer_count: 0, candidate_transfer_count: pairs.length,
    lead: leadExcluded.size ? "default_exclusions" : "gross", default_exclusions: summary, flip: [] };
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
      return `${masked(accounts[i])}, ${intent.from} through ${intent.to}: credits ${money(total.credits_minor)}; debits ${money(total.debits_minor)} ${refs(ownRows) || "(no posted income or expenses in the covered period)"}.`;
    }).join("\n");
    ledger.lead_accounts = accounts.map(account => {
      const ownRows = withoutLead(rows.filter(row => row.effective_account_slug === account.account_slug));
      return { account_mask: account.mask, credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
        debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
    });
    leadDetail = ledger.lead_accounts.map((total, i) => `${masked(accounts[i])}, ${intent.from} through ${intent.to}: money in ${money(total.credits_minor)}; money out ${money(total.debits_minor)}.`).join("\n");
    if (intent.measure) {
      ledger.measure = intent.measure;
      ledger.net_minor = sumMinor(ledger.lead_accounts.filter((_, i) => moveKind(accounts[i].account_kind)), a => a.credits_minor - a.debits_minor);
      ledger.net_label = "money in minus money out, not accounting profit or cash flow";
      leadDetail = `Money in minus money out, not accounting profit or cash flow: ${money(ledger.net_minor)}.\n${leadDetail}`;
      for (const account of accounts.filter(a => !moveKind(a.account_kind)))
        leadDetail += `\n${masked(account)}: ${account.account_kind} account, left out of money in minus money out; only checking, savings and card accounts contribute.`;
    }
  } else if (["largest", "deposits"].includes(intent.kind)) {
    const found = activity.filter(row => row.direction === intent.direction).sort((a, b) =>
      (intent.kind === "largest" ? b.amount_minor - a.amount_minor : b.posted_on.localeCompare(a.posted_on)) || a.id - b.id);
    const listed = intent.limit ? found.slice(0, intent.limit) : found;
    ledger.found = listed.length > 0; ledger.rows = listed.map(publicRow);
    ledger.if_own_transfers.total_minor = sumMinor(withoutCandidates(listed));
    conditionalDetail = `total of the listed ${intent.direction === "inflow" ? "deposits" : "expenses"}: ${money(ledger.if_own_transfers.total_minor)}`;
    answer = listed.length ? listed.map(rowLine).join("\n") : `No ${intent.direction === "inflow" ? "deposits" : "expenses"} found.`;
    // Filter before the limit so an excluded top row does not hide the next expense.
    const eligible = withoutLead(found);
    const leadListed = intent.limit ? eligible.slice(0, intent.limit) : eligible;
    ledger.lead_rows = leadListed.map(publicRow);
    leadDetail = leadListed.length ? leadListed.map(rowLine).join("\n") : `No ${intent.direction === "inflow" ? "deposits" : "expenses"} found in the first figures.`;
    if (intent.limit) {
      // Pool exclusions can sit below the cutoff. Only a removed displayed
      // row justifies a removal amount or an invitation to flip this list.
      const displayed = leadExclusions(listed, pairs, selected, bySlug, intent);
      noteSummary = displayed.summary; noteExcluded = displayed.excluded;
      unchangedLimitedList = listed.length === leadListed.length && listed.every((row, i) => row.id === leadListed[i].id);
    }
  } else if (["merchant", "category"].includes(intent.kind)) {
    const directionRows = activity.filter(row => row.direction === intent.direction);
    const matched = namedOutflowMerchant ? orderedVendorRows(withoutLead(namedOutflowMerchant.exact))
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
          coverage: vendorCoverage(possible),
          excluded_own_movement_count: namedOutflowMerchant.possible.length - possible.length,
        };
        answer = `Partial: ${possible.length} bank-text row${possible.length === 1 ? "" : "s"} may be related, ` +
          `but no structured payee exactly matches. No vendor-spend figure is available.\n` +
          vendorCoverageLine(possibleLedger.coverage);
        return { answer, citations: [], ledger: possibleLedger };
      }
      const suggestions = closestPayeeNames(namedOutflowMerchant.directionRows, intent.match);
      ledger.match_basis = "none"; ledger.complete = false; ledger.found = false; ledger.total_minor = null;
      ledger.row_count = 0; ledger.closest_payees = suggestions;
      ledger.coverage = vendorCoverage([]);
      ledger.excluded_own_movement_count = namedOutflowMerchant.exact.length + namedOutflowMerchant.possible.length;
      ledger.excluded_own_movement_minor = sumMinor([...namedOutflowMerchant.exact, ...namedOutflowMerchant.possible]
        .filter(row => leadExcluded.has(row.id)));
      ledger.if_own_transfers.total_minor = null; ledger.if_own_transfers.complete = false;
      answer = `Partial: No transactions were found for ${safeDescription(intent.match)} as exact vendor spend in the covered window, ${intent.from} through ${intent.to}. ` +
        (suggestions.length ? `Closest payee names in this window: ${suggestions.join("; ")}.` : "No structured payee names are available in this window.") +
        `\n${vendorCoverageLine(ledger.coverage)}`;
      return { answer, citations, ledger };
    }
    const unsorted = (intent.kind === "category" ? directionRows : matched).filter(row => !categoryFor(row));
    ledger.total_minor = sumMinor(matched); ledger.unsorted_minor = sumMinor(unsorted); ledger.found = matched.length > 0;
    if (namedOutflowMerchant) { ledger.match_basis = "exact"; ledger.complete = omittedAccounts.length === 0; }
    ledger.lead_total_minor = sumMinor(withoutLead(matched));
    leadDetail = `Total money ${intent.direction === "inflow" ? "in" : "out"}${intent.match ? ` for ${safeDescription(intent.match)}` : ` by ${intent.kind}`}: ${money(ledger.lead_total_minor)}; Unsorted: ${money(sumMinor(withoutLead(unsorted)))}.`;
    ledger.if_own_transfers.total_minor = sumMinor(withoutCandidates(matched));
    ledger.if_own_transfers.unsorted_minor = sumMinor(withoutCandidates(unsorted));
    conditionalDetail = `total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${safeDescription(intent.match)}` : ` by ${intent.kind}`}: ${money(ledger.if_own_transfers.total_minor)}; Unsorted: ${money(ledger.if_own_transfers.unsorted_minor)}`;
    const groups = new Map();
    for (const row of matched) {
      const label = intent.kind === "category" ? categoryFor(row) : merchantFor(row) || "unknown merchant";
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
      const citedRows = matched.slice(0, 5);
      for (const row of citedRows) cite(row);
      ledger.row_count = matched.length;
      ledger.omitted_row_count = Math.max(0, matched.length - citedRows.length);
      ledger.coverage = vendorCoverage([...matched, ...possible]);
      ledger.excluded_own_movement_count = namedOutflowMerchant.exact.length + namedOutflowMerchant.possible.length -
        matched.length - possible.length;
      ledger.excluded_own_movement_minor = sumMinor([...namedOutflowMerchant.exact, ...namedOutflowMerchant.possible]
        .filter(row => leadExcluded.has(row.id)));
      ledger.groups = orderedGroups.map(g => ({ merchant: safeDescription(g.label),
        category_basis_state: g.state, total_minor: sumMinor(g.rows),
        citations: g.rows.flatMap(row => references.has(row.id) ? [references.get(row.id).n] : []),
        possible_transfer_citations: g.rows.flatMap(row => pairing.candidateRows.has(row.id) && references.has(row.id)
          ? [references.get(row.id).n] : []),
        if_own_transfers_total_minor: sumMinor(withoutCandidates(g.rows)) }));
      const compactPublicRow = row => {
        const existing = references.get(row.id);
        const ref = existing || { ...citation(row, bySlug.get(row.effective_account_slug), 0), n: null };
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
        ledger.match_basis = "exact_and_possible";
        ledger.complete = false;
        ledger.exact_match_count = matched.length;
        ledger.possible_match_count = possible.length;
        ledger.exact_subtotal_minor = ledger.total_minor;
        ledger.possible_subtotal_minor = sumMinor(possible);
        ledger.lead_exact_subtotal_minor = ledger.lead_total_minor;
        ledger.lead_total_minor = null;
        ledger.if_own_transfers.exact_subtotal_minor = ledger.if_own_transfers.total_minor;
        ledger.if_own_transfers.possible_subtotal_minor = sumMinor(withoutCandidates(possible));
        ledger.if_own_transfers.total_minor = null;
        ledger.if_own_transfers.complete = false;
        ledger.total_minor = null;
        answer = `Partial: Exact structured-payee subtotal for ${safeDescription(displayVendor)} ${compactPeriodLabel(intent)} is ` +
          `${money(ledger.exact_subtotal_minor)}. Possible bank-text subtotal is ${money(ledger.possible_subtotal_minor)}. ` +
          `These subtotals are separate; this is not a complete vendor total.`;
      } else if (!ledger.coverage.complete) {
        ledger.partial_subtotal_minor = ledger.total_minor;
        ledger.total_minor = null;
        answer = `Partial: exact-match subtotal for ${safeDescription(displayVendor)} ${compactPeriodLabel(intent)} is ` +
          `${money(ledger.partial_subtotal_minor)}. This is not a complete total.`;
      } else answer = `You spent ${money(ledger.total_minor)} at ${safeDescription(displayVendor)} ${compactPeriodLabel(intent)}.`;
      if (evidence) answer += ` ${evidence}.`;
      answer += `\n${vendorCoverageLine(ledger.coverage)}`;
      return { answer, citations, ledger };
    }
    ledger.groups = orderedGroups.map(g => ({ [intent.kind]: safeDescription(g.label),
      category_basis_state: g.state, total_minor: sumMinor(g.rows), citations: g.rows.map(row => cite(row).n),
      possible_transfer_citations: g.rows.filter(row => pairing.candidateRows.has(row.id)).map(row => cite(row).n),
      if_own_transfers_total_minor: sumMinor(withoutCandidates(g.rows)) }));
    answer = `Total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${safeDescription(intent.match)}` : ` by ${intent.kind}`}: ${money(ledger.total_minor)}.`;
    if (!matched.length) answer += " No matching transactions found.";
    for (const g of orderedGroups) answer += `\n${safeDescription(g.label)}${g.state === "proposed" ? " (bank's category (unconfirmed))" : ""}: ${money(sumMinor(g.rows))} ${refs(g.rows)}${g.rows.some(row => pairing.candidateRows.has(row.id)) ? " (includes possible moves between your own accounts)" : ""}.`;
    answer += `\nUnsorted: ${money(ledger.unsorted_minor)}${intent.kind === "category" && intent.match && !matched.some(row => !categoryFor(row)) ? " (separate from the requested category)" : ""} ${refs(unsorted)}.`;
    if (incompleteNamed) {
      const subtotal = amount => amount > 0
        ? `Income from that payer is at least ${money(amount)} (matched subtotal, not complete).`
        : "I can't confirm the income from that payer.";
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
      answer += "\nNote: Labels come from your bank and may not identify who paid.";
    }
  } else if (intent.kind === "transfers") {
    // This diagnostic view keeps its gross, outgoing-date contract. Other
    // answer kinds apply lead exclusions to each leg inside their own window.
    const outgoing = pairs.filter(pair => inWindow(pair.out));
    ledger.total_minor = sumMinor(outgoing, pair => pair.out.amount_minor);
    ledger.found = outgoing.length > 0;
    answer = outgoing.length ? `Possible moves between your own accounts: ${money(ledger.total_minor)}, counted once by outgoing posting date; not confirmed.` : "No possible moves between your own accounts found by outgoing posting date.";
  } else if (intent.kind === "recurring") {
    const recurring = detectRecurring(activity, intent.to);
    ledger.recurring = recurring.map(g => ({ merchant: safeDescription(g.merchant), cadence: g.cadence,
      typical_minor: g.typical_minor, monthly_minor: g.monthly_minor, last_charge: g.last_charge,
      last_amount_minor: g.rows.at(-1).amount_minor, occurrence_count: g.rows.length, detected: true,
      citations: g.rows.map(row => cite(row).n), possible_transfer_citations: g.rows.filter(row => pairing.candidateRows.has(row.id)).map(row => cite(row).n) }));
    ledger.monthly_total_minor = sumMinor(recurring, g => g.monthly_minor); ledger.found = recurring.length > 0;
    ledger.lead_monthly_total_minor = sumMinor(detectRecurring(withoutLead(activity), intent.to), g => g.monthly_minor);
    leadDetail = `Estimated monthly money out: ${money(ledger.lead_monthly_total_minor)} (detected, not confirmed).`;
    ledger.if_own_transfers.monthly_total_minor = sumMinor(detectRecurring(withoutCandidates(activity), intent.to), g => g.monthly_minor);
    conditionalDetail = `estimated monthly total: ${money(ledger.if_own_transfers.monthly_total_minor)}`;
    answer = "Recurring charges detected, not confirmed. " + (recurring.length ? recurring.map(g =>
      `${safeDescription(g.merchant)}: ${g.cadence}, typical ${money(g.typical_minor)}; last charge ${money(g.rows.at(-1).amount_minor)} on ${g.last_charge} ${refs(g.rows)}.`).join("\n") : "No recurring charges detected.");
    answer += `\nEstimated monthly total: ${money(ledger.monthly_total_minor)} (weekly amounts use 52/12, rounded to cents per merchant).`;
  } else throw new Error("unsupported ledger intent");
  ledger.transfers = pairs.map(pair => ({ candidate: true, excluded_from_totals: false, reason: pair.reason,
    amount_minor: pair.out.amount_minor, outgoing: publicRow(pair.out), incoming: publicRow(pair.in),
    excluded_from_lead: [pair.out, pair.in].some(row => leadExcluded.has(row.id)), kept_reason: keptPairs.get(pair) || null }));
  ledger.unmatched_transfers = unmatched.map(publicRow);
  const restored = intent.ownTransfers === "include" && intent.withdrawals === "include" && !leadExcluded.size;
  if (intent.measure || (!restored && (leadExcluded.size || keptPairs.size))) {
    const notes = [];
    if (noteSummary.own_transfer_pairs) { notes.push(`${money(noteSummary.own_transfer_minor)} between your own connected accounts left out of the first figures; say "including transfers" to count those moves`); ledger.flip.push("including transfers"); }
    if (noteSummary.withdrawal_count) { notes.push(`${money(noteSummary.withdrawal_minor)} in retirement or investment withdrawals left out of the first figures; say "including withdrawals" to count them`); ledger.flip.push("including withdrawals"); }
    if (noteSummary.loan_proceeds_count) { notes.push(`${money(noteSummary.loan_proceeds_minor)} in loan or line-of-credit proceeds left out of the first figures; say "including loan proceeds" to count them`); ledger.flip.push("including loan proceeds"); }
    if (unchangedLimitedList && leadExcluded.size) notes.push("exclusions apply to the wider candidate pool; the displayed rows are unchanged");
    if (!unchangedLimitedList && [...keptPairs.values()].some(reason => reason.startsWith("other account"))) {
      notes.push('moves with an account outside this question are kept; say "excluding transfers" to leave them out'); ledger.flip.push("excluding transfers");
    }
    if (!notes.length) notes.push(keptPairs.size ? "paired activity stays where listed below" : "only checking, savings and card accounts contribute to money in minus money out");
    // Gross sentences retain their wording and citation order for existing clients.
    answer = `${leadDetail || answer}\nNote: ${notes.join("; ")}.\nWith everything counted:\n${answer}\n${bounded}`;
    const omittedPairs = pairs.filter(pair => [pair.out, pair.in].some(row => noteExcluded.has(row.id)));
    if (omittedPairs.length) {
      answer += "\nMoves between your own connected accounts, left out of the first figures:";
      const leadRowLine = row => rowLine(row).replace(candidateMark(row), leadExcluded.has(row.id)
        ? " (left out of the first figures)" : " (outside this answer's accounts or period)");
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
  for (const row of unmatched) answer += `\nPossible transfer, unmatched (${leadExcluded.has(row.id)
    ? noteExcluded.has(row.id) ? "left out of the first figures as a retirement or investment withdrawal; kept in the gross figures"
      : "retirement or investment withdrawal excluded from the wider candidate pool; outside the displayed rows"
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
    answer = ledger.found
      ? `Partial answer from available ledger records. This ranking may be incomplete because SimpleFIN coverage is not yet certified complete.\n${answer}`
      : `Partial answer from available ledger records. No matching expenses were found in those records, but incomplete SimpleFIN coverage does not prove zero or a complete list.\n${answer}`;
  }
  return { answer, citations, ledger };
}

// The only integration point wraps the existing document path. Non-money
// responses return untouched, including their exact serialized bytes.

export async function withLedgerAnswer(options, next) {
  const { env, question, access, grantScope, scopePrincipalKind,
    filters = {}, entityScope, ledgerEligible = true, now = Date.now() } = options;
  // Direct callers that inject a clock still need the deployed owner-zone binding.
  // A clock controls when the question is evaluated, never which owner calendar
  // applies. Every caller, including a synthetic one, must supply the zone.
  const configuredTimeZone = Object.hasOwn(env, "BRAIN_TIMEZONE");
  const timeZone = env.BRAIN_TIMEZONE ?? null;
  const intent = classifyLedgerQuestion(question, { now, timeZone });
  // An unsupported question needs ordinary document retrieval. Inventory
  // coincidences cannot add a bank gap or interrupt that unrelated path.
  if (!intent.broad) return next(null);
  let accounts = [], gap;
  const unrestrictedOwnerPath = !access && Boolean(grantScope) && scopeIsUnrestricted(grantScope) &&
    scopePrincipalKind === "owner" && !entityScope?.applied && Object.keys(filters).length === 0;
  const deterministicSpendIntent = intent.kind === "expense_summary" ||
    (intent.kind === "merchant" && intent.direction === "outflow" && Boolean(intent.match));
  // Same whole-owner boundary as financialMapStateFor. The remote MCP ask
  // handler explicitly supplies owner + unrestricted scope today; grants and
  // exact-document sessions do not inherit that authority.
  if (!intent.kind) {
    gap = gapFor("ledger_wording_unsupported");
  } else if (intent.ownerTimeZoneUnavailable) {
    gap = gapFor("owner_timezone_unavailable", [], intent);
  } else if (!unrestrictedOwnerPath) {
    gap = gapFor("retrieval_scope_restricted");
  } else if (!ledgerEligible) {
    // Preserve the pre-retrieval tax-scope guard. A tax-return question cannot
    // acquire bank-ledger authority just because its wording includes income.
    gap = gapFor("unsupported_question");
  } else {
    try {
      const inventory = await readEffectiveAccounts(env);
      accounts = inventory;
      if (intent.accountSelector) {
        // Literal labels and masks are stronger than account-kind words that
        // happen to occur inside a label, including unreviewed feed accounts.
        accounts = accountsForSelector(inventory, intent.accountSelector);
        if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
      } else {
        if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
        if (intent.accountKind) accounts = accounts.filter(a => a.account_kind === intent.accountKind);
      }
      const disputed = accounts.filter(a => accountLinkRequiredInWindow(a, intent));
      let reason = !accounts.length ? "no_accounts" : disputed.length ? 'ledger_account_link_required' : accounts.some(a => a.ambiguous || a.members.some(m => m.basis_state !== "confirmed")) ||
        (!intent.accountSelector && intent.mask && accounts.length !== 1) ? "ambiguous_account" :
        accounts.some(a => a.currency !== "USD") ? "unsupported_currency" : !intent.kind ? "unsupported_question" : null;
      if (!reason) {
        const answer = await ledgerAnswer(env, intent, accounts, inventory);
        reason = answer.reason;
        if (!reason) {
          if (intent.from && intent.to && configuredTimeZone) answer.ledger.time_zone = intent.timeZone;
          const partialCoverage = answer.ledger.partial_reason === "ledger_partial_coverage";
          const incomplete = Boolean(answer.ledger.attribution_incomplete || answer.ledger.complete === false ||
            answer.ledger.known_own_transfer_in_lead);
          return new Response(JSON.stringify({ mode: "think", answer: answer.answer,
          citations: answer.citations, results: [],
          gaps: partialCoverage ? [gapFor("ledger_partial_coverage", accounts, intent)] : [], ledger: answer.ledger,
          evidence_gate: { supported: true, complete: !incomplete, partial: incomplete,
            reason: partialCoverage ? "available ledger rows are cited, but ledger coverage is not certified complete"
              : answer.ledger.attribution_incomplete ? "payer attribution incomplete in covered ledger rows"
              : answer.ledger.match_basis === "exact_and_possible" ? "vendor selector has exact and possible matches; no complete total is claimed"
                : answer.ledger.match_basis === "possible" ? "vendor selector has possible matches only"
                  : answer.ledger.match_basis === "none" ? "vendor selector has no exact match in covered ledger rows"
                  : answer.ledger.known_own_transfer_in_lead ? "known own-account transfer remains in the first figure"
                    : answer.ledger.coverage?.complete === false && answer.ledger.kind === "expense_summary"
                      ? "partial ledger coverage; figure limited to fully covered accounts"
                      : answer.ledger.coverage?.complete === false ? "vendor subtotal limited to fully covered accounts"
                        : "read from covered ledger rows" } }),
          { headers: { "Content-Type": "application/json" } });
        }
      }
      gap = gapFor(reason, reason === 'ledger_account_link_required' ? disputed : accounts, intent);
    } catch {
      gap = gapFor("ledger_unavailable", accounts, intent);
    }
  }
  const reason = gap.reason;
  // Once an unrestricted owner request enters either deterministic spend
  // contract, every ledger refusal is terminal. Documents cannot certify a
  // figure for the rejected account denominator, selector, coverage, or read.
  if ((unrestrictedOwnerPath && deterministicSpendIntent) || ['ledger_account_link_required', 'cash_flow_unsupported',
    'merchant_selector_unsupported', 'merchant_selector_ambiguous', 'coverage_review_required',
    'bank_export_overlap_review_required'].includes(reason)) return new Response(JSON.stringify({ mode: 'think',
    code: reason, answer: null, citations: [], results: [], gaps: [gap],
    evidence_gate: { supported: false, complete: false, reason } }), { headers: { 'Content-Type': 'application/json' } });
  return mergeLedgerGap(await next(gap), gap);
}

// Item B's shared merger is not present at this base. Keep the compatibility
// seam byte-equivalent for existing gaps while the time-zone refusal joins it.
async function mergeLedgerGap(response, gap) {
  if (!response.ok) return response;
  const body = await response.json();
  body.gaps = [gap, ...(body.gaps || []).filter(g => g.type !== gap.type)];
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
}
