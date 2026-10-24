import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion, ledgerDay, shiftLedgerDay } from "./ledger-question.js";
import { accountLinkPairsInWindow, accountLinkRequiredInWindow, effectivePeriodCovered, readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions } from "./ledger-reader.js";
import { categoryFor, detectRecurring, isDirectedOwnedTransfer, isLoanAdvance, matchesCategory, matchesMerchant, matchesSender, merchantFor, normalizeMerchantText, pairOwnTransfers, sumMinor } from "./ledger-analysis.js";
import {
  ANSWER_WITHHELD, COVERAGE_CATASTROPHIC, COVERAGE_FINE, COVERAGE_INCOMPLETE,
  LEDGER_REFUSAL_REASONS, classifyQuestionCoverage, coverageCalendarDayEnd,
  ledgerRefusalPolicy, refusalNextAction,
} from "./retrieval-status.js";

const masked = account => /^\d{1,4}$/.test(account.mask || "") ? `account ****${account.mask}` : "account (mask unavailable)";
const money = cents => `${cents < 0 ? "-" : ""}$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const safeDescription = text => String(text || "Deposit").replace(/\d(?:[\s-]*\d){4,}/g, "[redacted]").slice(0, 240);
const accountCoverage = accounts => accounts.map(a => ({
  account_mask: /^\d{1,4}$/.test(a.mask || "") ? a.mask : null,
  covered_to: a.covered_to || null, last_synced_at: a.last_synced_at || null,
}));

function gapFor(reason, accounts = [], intent = {}) {
  const policy = ledgerRefusalPolicy(reason);
  const review = {
    cash_flow_unsupported: "Cash flow is not supported. Posted card purchases can be unpaid, and combining card charges with checking and savings activity is not a cash-flow measure. Ask for money in and money out, or the bounded profit/net income surplus; neither is accounting profit or cash flow.",
    merchant_selector_unsupported: "This printed merchant label is redacted, shortened or unknown and cannot identify an exact merchant safely. Quote the original by-merchant list line with its period and account scope; do not turn this refusal into zero or guess the hidden text.",
    merchant_selector_ambiguous: "This merchant spelling differs from a stored label only by and or &. Use the exact printed label, including its literal conjunction, or quote the by-merchant list line. Do not substitute and for & or combine different merchants.",
    coverage_review_required: "A previous partial import may have widened a complete coverage interval across unobserved days. Transactions are retained, but this interval is unproven until its coverage is independently reviewed and re-established. No total or zero is certified.",
    bank_export_overlap_review_required: "Overlapping bank exports use different transaction identities. Existing rows and provenance are retained. Review the original exports and statements to determine whether these are duplicate records or separate purchases before a separately approved reconciliation. No total or zero is certified, and no rows were merged or deleted.",
  };
  if (review[reason]) return { type: "ledger_not_consulted", reason, code: reason,
    ...(intent.from ? { from: intent.from, to: intent.to } : {}), detail: review[reason] };
  if (reason === 'ledger_account_link_required') {
    // Display one relevant pair; the admission decision checks every edge.
    const pair = accounts.flatMap(a => accountLinkPairsInWindow(a, intent))[0];
    const describe = (a, role) => `${role}: ${String(a?.institution || 'institution unavailable').replace(/[\r\n]/g, ' ').slice(0, 100)}, ${masked(a || {})}, ${a?.account_kind || 'kind unavailable'}`;
    const slug = a => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(a?.account_slug || '') ? a.account_slug : '<account>';
    return { type: 'ledger_not_consulted', reason, code: reason,
      ...(intent.from ? { from: intent.from, to: intent.to } : {}),
      detail: `Confirm whether these records describe the same account: ${describe(pair?.manual, 'manual import')}; ${describe(pair?.live, 'live feed')}. No money was removed. Preview with brain ledger link-accounts <manifest> --manual ${slug(pair?.manual)} --live ${slug(pair?.live)} --preview. Approve only if they are the same account; use --apply --approve <hash>. An outdated link can be reviewed with --unlink --preview.` };
  }
  const coverage = accountCoverage(accounts);
  const detail = coverage.length ? coverage.map(a =>
    `${a.account_mask ? `****${a.account_mask}` : "mask unavailable"}: covered through ${a.covered_to || "unknown"}, feed last synced ${a.last_synced_at || "unknown"}`
  ).join("; ") : "No authorized account coverage was available.";
  return {
    type: reason === "period_outside_coverage" ? "ledger_out_of_coverage" : "ledger_not_consulted",
    reason, accounts: coverage,
    ...(policy?.catastrophic === false ? { code: reason } : {}),
    source: "bank ledger",
    source_kind: "ledger",
    last_good_sync_at: accounts.map((account) => account.last_synced_at).filter(Boolean).sort()[0] || null,
    ...(intent.from ? { from: intent.from, to: intent.to } : {}),
    detail: `${policy?.notice || "The bank ledger could not answer this question."} ${detail} Document dates do not measure bank-feed freshness.`,
  };
}

function instant(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function neverSyncedLiveGap(accounts, intent, balances = null) {
  // Balance ranking may select a newer manual snapshot from an approved pair.
  // Eligibility still belongs to the whole effective account: a connected live
  // member that has never synced cannot be hidden by the selected row.
  const neverSyncedLive = accounts.flatMap((account) => account.members || [account])
    .filter((member) => member.feed_mode === "live" && instant(member.last_synced_at) === null);
  if (neverSyncedLive.length) {
    return gapFor("live_feed_never_synced", accounts, intent);
  }
  return null;
}

function balanceCoveragePlan(accounts, intent, now, balances, timeZone) {
  const neverSynced = neverSyncedLiveGap(accounts, intent, balances);
  if (neverSynced) return { intent, gaps: [neverSynced], catastrophic: neverSynced };
  // A selected manual observation may supply the amount, but every connected
  // live member still supplies freshness for its approved effective account.
  const liveObservations = accounts.flatMap((account) => account.members || [account])
    .filter((member) => member.feed_mode === "live")
    .map((member) => {
      const synced = instant(member.last_synced_at);
      return synced === null ? null : { instant: synced, value: new Date(synced).toISOString(), calendarDay: null };
    });
  const observations = [...liveObservations, ...(Array.isArray(balances) ? balances : []).map((row) => {
    const synced = instant(row?.last_synced_at);
    if (synced !== null) return { instant: synced, value: new Date(synced).toISOString(), calendarDay: null };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(row?.as_of_date || "") ? row.as_of_date : null;
    const observed = coverageCalendarDayEnd(day, timeZone);
    return observed === null ? null : { instant: observed, value: new Date(observed).toISOString(), calendarDay: day };
  })].filter(Boolean);
  if (!observations.length) return { intent, gaps: [], catastrophic: null };
  const oldest = observations.sort((left, right) => left.instant - right.instant)[0];
  const nowMs = instant(now) ?? Date.now();
  if (nowMs - oldest.instant < 2 * 86_400_000) return { intent, gaps: [], catastrophic: null };
  const coveredThrough = oldest.calendarDay || new Date(oldest.instant).toISOString().slice(0, 10);
  return { intent, catastrophic: null, gaps: [{
    type: "ledger_coverage_stale",
    source: "bank ledger",
    source_kind: "ledger",
    last_good_sync_at: oldest.value,
    ...(oldest.calendarDay ? { coverage_calendar_date: oldest.calendarDay } : {}),
    days_since_ingest: Math.floor((nowMs - oldest.instant) / 86_400_000),
    covered_through: coveredThrough,
    accounts: accountCoverage(accounts),
    detail: `The selected bank balance was last proved current on ${coveredThrough}; newer activity may be missing.`,
  }] };
}

function ledgerCoveragePlan(accounts, intent, now, balances = null, timeZone = "UTC") {
  if (intent.kind === "balance") return balanceCoveragePlan(accounts, intent, now, balances, timeZone);
  if (!intent.from || !intent.to) return { intent, gaps: [], catastrophic: null };
  const neverSynced = neverSyncedLiveGap(accounts, intent);
  if (neverSynced) return { intent, gaps: [neverSynced], catastrophic: neverSynced };
  // This is an integrity refusal, not ordinary staleness. Keep the existing
  // named gate so a widened legacy interval cannot be treated as partially
  // usable merely because its stored endpoints overlap the question.
  if (accounts.some((account) => account.members.some((member) => member.coverage_review_required))) {
    return { intent, gaps: [], catastrophic: null };
  }
  const requestedTo = intent.to;
  const coveredThrough = accounts.map((account) => account.covered_to).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "")).sort()[0] || null;
  const boundedTo = coveredThrough && coveredThrough < requestedTo ? coveredThrough : requestedTo;
  if (!coveredThrough || boundedTo < intent.from ||
      accounts.some((account) => !effectivePeriodCovered(account, intent.from, boundedTo))) {
    const catastrophic = gapFor("period_outside_coverage", accounts, intent);
    return { intent, gaps: [catastrophic], catastrophic };
  }

  const nowMs = instant(now) ?? Date.now();
  const lastGoodValues = accounts.map((account) => {
    const synced = instant(account.last_synced_at);
    if (synced !== null) return { instant: synced, value: new Date(synced).toISOString(), calendarDay: null };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(account.covered_to || "") ? account.covered_to : null;
    const observed = coverageCalendarDayEnd(day, timeZone);
    return observed === null ? null : { instant: observed, value: new Date(observed).toISOString(), calendarDay: day };
  }).filter(Boolean);
  const lastGood = lastGoodValues.length
    ? lastGoodValues.sort((left, right) => left.instant - right.instant)[0]
    : null;
  const partial = boundedTo < requestedTo;
  const stale = lastGood !== null && nowMs - lastGood.instant >= 2 * 86_400_000;
  const gaps = partial || stale ? [{
    type: "ledger_coverage_stale",
    source: "bank ledger",
    source_kind: "ledger",
    last_good_sync_at: lastGood?.value || null,
    ...(lastGood?.calendarDay ? { coverage_calendar_date: lastGood.calendarDay } : {}),
    days_since_ingest: lastGood === null ? null : Math.floor((nowMs - lastGood.instant) / 86_400_000),
    covered_through: boundedTo,
    ...(partial ? { missing_from: shiftLedgerDay(boundedTo, 1) } : {}),
    requested_through: requestedTo,
    accounts: accountCoverage(accounts),
    detail: `The bank ledger is covered through ${boundedTo}; activity after that date may be missing from the requested period through ${requestedTo}.`,
  }] : [];
  return { intent: { ...intent, to: boundedTo }, gaps, catastrophic: null };
}

function sourceCoverageGaps(sourceCoverage) {
  if (sourceCoverage?.unavailable) return [{
    type: "coverage_unavailable",
    detail: "Source coverage could not be checked. The answer may omit material from a paused source.",
  }];
  return Array.isArray(sourceCoverage?.gaps) ? sourceCoverage.gaps : [];
}

async function fallbackWithGap(next, gap, allGaps = [gap]) {
  const response = await next(gap);
  if (!response.ok) return response;
  const body = await response.json();
  const leading = [gap, ...allGaps.filter((candidate) => candidate !== gap)];
  const leadingTypes = new Set(leading.map((candidate) => candidate.type));
  body.gaps = [...leading, ...(body.gaps || []).filter((candidate) => !leadingTypes.has(candidate.type))];
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
}

function hardLedgerRefusal(gap, allGaps = [gap]) {
  const policy = ledgerRefusalPolicy(gap?.reason);
  const catastrophic = policy?.catastrophic === true;
  const ordered = [gap, ...allGaps.filter((candidate) => candidate !== gap)];
  const seen = new Set();
  const gaps = ordered.filter((candidate) => {
    const key = `${candidate?.type || "unknown"}:${candidate?.reason || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return new Response(JSON.stringify({
    mode: "think",
    status: catastrophic ? COVERAGE_INCOMPLETE : ANSWER_WITHHELD,
    coverage_classification: catastrophic ? COVERAGE_CATASTROPHIC : COVERAGE_FINE,
    ledger_refusal_class: policy?.cause_class || "coverage_outage",
    notice: gap.detail || policy?.notice,
    code: gap.code || undefined,
    answer: null,
    next_action: refusalNextAction({
      status: catastrophic ? COVERAGE_INCOMPLETE : ANSWER_WITHHELD,
      ledgerReason: gap?.reason,
    }),
    citations: [],
    results: [],
    gaps,
    evidence_gate: {
      supported: false,
      complete: false,
      evidence: [],
      reason: policy?.notice || gap.reason || "the recognized ledger question could not be answered from readable covered ledger rows",
    },
  }), { headers: { "Content-Type": "application/json" } });
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
    if ((moveKind(outKind) || withdrawalKind(outKind)) && moveKind(inKind) && !isDirectedOwnedTransfer(pair, bySlug)) {
      keptPairs.set(pair, "counterparty evidence is insufficient or conflicting, kept in the figures");
      continue;
    }
    if (moveKind(outKind) && moveKind(inKind)) {
      if (intent.ownTransfers !== "include" && (bothInScope || intent.ownTransfers === "exclude")) {
        omit(pair.out); omit(pair.in); ownPairs.push(pair);
      } else if (!bothInScope && intent.ownTransfers !== "include") {
        keptPairs.set(pair, "other account is outside this question, kept in money in and money out");
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
  return { excluded, keptPairs, summary: { own_transfer_pairs: ownPairs.length,
    own_transfer_minor: sumMinor(ownPairs, pair => pair.out.amount_minor),
    withdrawal_count: withdrawals.size, withdrawal_minor: sumMinor([...withdrawals.values()]),
    loan_proceeds_count: loanProceeds.size, loan_proceeds_minor: sumMinor([...loanProceeds.values()]) } };
}

async function ledgerAnswer(env, intent, accounts, inventory, preparedBalances = null) {
  if (intent.measure === "cash_flow") return { reason: "cash_flow_unsupported" };
  if (intent.measure && !accounts.some(a => moveKind(a.account_kind))) return { reason: "unsupported_question" };
  if (intent.kind === "balance") {
    const balances = preparedBalances || await readEffectiveBalances(env, accounts, intent);
    if (balances.length !== accounts.length || balances.some(b => b.basis_state !== "confirmed" ||
      !Number.isSafeInteger(b.current_minor) || b.currency !== "USD")) return { reason: "balance_unavailable" };
    const citations = balances.map((row, i) => citation(row, accounts.find(a => a.account_slug === row.effective_account_slug), i, true));
    return { answer: balances.map((row, i) => `${masked(accounts.find(a => a.account_slug === row.effective_account_slug))}: ${money(row.current_minor)} as of ${row.as_of_date} [${i + 1}].`).join("\n"),
      citations, ledger: { kind: "balance", accounts: citations.map(c => ({ account_mask: c.account_mask, current_minor: c.amount_minor, as_of: c.posted_on })) } };
  }
  if (accounts.some(a => a.members.some(m => m.coverage_review_required))) return { reason: "coverage_review_required" };
  if (accounts.some(a => !effectivePeriodCovered(a, intent.from, intent.to))) return { reason: "period_outside_coverage" };
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
  if (intent.kind === "merchant" && intent.match) {
    const wanted = normalizeMerchantText(intent.match);
    const directionRows = rows.filter(row => row.direction === intent.direction);
    const conjunction = text => text.replace(/\b(and)\b|&/g, "and");
    if (!directionRows.some(row => matchesMerchant(row, intent.match)) && directionRows.some(row =>
      conjunction(merchantFor(row)) === conjunction(wanted))) return { reason: "merchant_selector_ambiguous" };
  }
  const eligible = allRows.filter(row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
    effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on));
  const pairing = pairOwnTransfers(eligible, bySlug);
  const pairs = pairing.pairs.filter(pair => [pair.out, pair.in].some(row => selected.has(row.effective_account_slug) && inWindow(row)));
  const unmatched = pairing.unmatched.filter(row => selected.has(row.effective_account_slug) && inWindow(row));
  // Pairs never change stored rows or existing gross keys. Qualifying pairs
  // leave the lead figures; the unchanged gross figures are always printed.
  // Notes describe only rows feeding this answer, including its Unsorted line.
  // An unrelated transfer elsewhere in the window cannot change a merchant total.
  let figureRows = rows;
  if (["largest", "deposits", "merchant", "category"].includes(intent.kind)) {
    figureRows = rows.filter(row => row.direction === intent.direction);
    if (intent.match) figureRows = figureRows.filter(row =>
      (intent.kind === "merchant" ? matchesMerchant : matchesCategory)(row, intent.match) ||
      (intent.kind === "category" && !categoryFor(row)));
  } else if (intent.kind === "recurring") figureRows = detectRecurring(rows, intent.to).flatMap(group => group.rows);
  const { excluded: leadExcluded, keptPairs, summary } = leadExclusions(figureRows, intent.kind === "transfers" ? [] : pairs, selected, bySlug,
    intent.kind === "transfers" ? { withdrawals: "include" } : intent);
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
  const candidateMark = row => pairing.candidateRows.has(row.id) ? " (possible move between your own accounts, included)" : "";
  const publicRow = row => ({ ...cite(row), ...(incompleteNamed ? {} : { description: safeDescription(row.description || row.payee || "Transaction") }), possible_own_transfer: pairing.candidateRows.has(row.id) });
  const rowLine = row => `${money(row.amount_minor)} on ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}${incompleteNamed ? "" : `: ${safeDescription(row.description || row.payee || "Transaction")}`}${candidateMark(row)} ${refs([row])}`;
  const bounded = `Accounts: ${accounts.map(masked).join(", ")}; ${intent.from} through ${intent.to}; ${accounts.map(a => `${masked(a)}: covered through ${a.covered_to || "unknown"}`).join("; ")}.`;
  const ledger = { kind: intent.kind, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
    includes_own_transfers: true, matched_transfer_count: 0, candidate_transfer_count: pairs.length,
    lead: leadExcluded.size ? "default_exclusions" : "gross", default_exclusions: summary, flip: [] };
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
    const matched = intent.match ? directionRows.filter(row => (intent.kind === "merchant" ? matchesMerchant : matchesCategory)(row, intent.match)) : directionRows;
    const unsorted = (intent.kind === "category" ? directionRows : matched).filter(row => !categoryFor(row));
    ledger.total_minor = sumMinor(matched); ledger.unsorted_minor = sumMinor(unsorted); ledger.found = matched.length > 0;
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
  return { answer, citations, ledger };
}

// The only integration point wraps the existing document path. Non-money
// responses return untouched, including their exact serialized bytes.

export async function withLedgerAnswer({ env, question, access, grantScope, scopePrincipalKind,
  filters = {}, entityScope, ledgerEligible = true, now = Date.now(), sourceCoverage = null }, next) {
  const intent = classifyLedgerQuestion(question, { now });
  // An unsupported question needs ordinary document retrieval. Inventory
  // coincidences cannot add a bank gap or interrupt that unrelated path.
  if (!intent.broad || !intent.kind) return next(null);
  let accounts = [], gap;
  // Same whole-owner boundary as financialMapStateFor. The remote MCP ask
  // handler explicitly supplies owner + unrestricted scope today; grants and
  // exact-document sessions do not inherit that authority.
  if (access || !grantScope || !scopeIsUnrestricted(grantScope) || scopePrincipalKind !== "owner" ||
    entityScope?.applied || Object.keys(filters).length) {
    gap = gapFor("retrieval_scope_restricted");
  } else if (!ledgerEligible) {
    // Preserve the pre-retrieval tax-scope guard. A tax-return question cannot
    // acquire bank-ledger authority just because its wording includes income.
    gap = gapFor("unsupported_question");
  } else {
    try {
      const inventory = await readEffectiveAccounts(env);
      accounts = inventory;
      if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
      if (intent.accountKind) accounts = accounts.filter(a => a.account_kind === intent.accountKind);
      const disputed = accounts.filter(a => accountLinkRequiredInWindow(a, intent));
      let reason = !accounts.length ? "no_accounts" : disputed.length ? 'ledger_account_link_required' : accounts.some(a => a.ambiguous || a.members.some(m => m.basis_state !== "confirmed")) ||
        (intent.mask && accounts.length !== 1) ? "ambiguous_account" :
        accounts.some(a => a.currency !== "USD") ? "unsupported_currency" : !intent.kind ? "unsupported_question" : null;
      if (!reason) {
        const preparedBalances = intent.kind === "balance"
          ? await readEffectiveBalances(env, accounts, intent)
          : null;
        const plan = ledgerCoveragePlan(accounts, intent, now, preparedBalances, env.BRAIN_TIMEZONE);
        const allCoverageGaps = [...sourceCoverageGaps(sourceCoverage), ...plan.gaps];
        const coverage = classifyQuestionCoverage({
          question,
          questionType: "money",
          periodStart: intent.from || null,
          gaps: allCoverageGaps,
          evidenceSources: ["ledger"],
          now,
          timeZone: env.BRAIN_TIMEZONE,
        });
        if (plan.catastrophic || coverage.refuse) {
          return hardLedgerRefusal(plan.catastrophic || coverage.catastrophic_gaps[0], allCoverageGaps);
        }
        const answer = await ledgerAnswer(env, plan.intent, accounts, inventory, preparedBalances);
        reason = answer.reason;
        if (!reason) return new Response(JSON.stringify({ mode: "think",
          answer: coverage.answer_prefix ? `${coverage.answer_prefix} ${answer.answer}` : answer.answer,
          ...(coverage.side_note ? { side_note: coverage.side_note } : {}),
          citations: answer.citations, results: [], gaps: allCoverageGaps, ledger: answer.ledger,
          evidence_gate: { supported: true, complete: !answer.ledger.attribution_incomplete,
            reason: answer.ledger.attribution_incomplete ? "payer attribution incomplete in covered ledger rows" : "read from covered ledger rows" } }),
        { headers: { "Content-Type": "application/json" } });
      }
      gap = gapFor(reason, reason === 'ledger_account_link_required' ? disputed : accounts, intent);
    } catch {
      gap = gapFor("ledger_unavailable", accounts, intent);
    }
  }
  if (LEDGER_REFUSAL_REASONS.has(gap?.reason)) return hardLedgerRefusal(gap);
  return fallbackWithGap(next, gap);
}
