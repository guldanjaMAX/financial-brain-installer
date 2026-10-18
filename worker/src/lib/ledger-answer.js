import { createInflowAttributor, payerRegistry, resolveRequestedPayer, selectAttributedInflows, inflowScopeConfirmed, payerAmount } from "./ledger-attribution.js";
import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion, ledgerDay, shiftLedgerDay } from "./ledger-question.js";
import { accountLinkPairsInWindow, accountLinkRequiredInWindow, effectivePeriodCovered, readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions } from "./ledger-reader.js";
import { categoryFor, detectRecurring, isDirectedOwnedTransfer, isLoanAdvance, matchesCategory, matchesMerchant, merchantFor, normalizeMerchantText, pairOwnTransfers, sumMinor } from "./ledger-analysis.js";

const accountMask = account => /^\d{1,4}$/.test(account.mask || "") ? account.mask : null;
const masked = account => accountMask(account) ? `account ****${accountMask(account)}` : "account (mask unavailable)";
const safeDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(Date.parse(value)) && ledgerDay(value) === value ? value : null;
const safeSync = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value || "") &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/(?<=:\d{2})Z$/, '.000Z') ? value : null;
const accountKind = account => ['checking', 'savings', 'card', 'loan', 'line_of_credit', 'investment', 'retirement', 'escrow', 'other'].includes(account?.account_kind)
  ? account.account_kind : 'kind unavailable';
const money = cents => `${cents < 0 ? "-" : ""}$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
export function maskLedgerCandidateField(text) {
  // Free-form letters can be identifiers too. Mask every long run, including
  // separator-spaced runs, before truncation. No guessed bank-label vocabulary
  // can make an otherwise opaque identifier safe to print.
  const value = String(text || "Deposit").normalize("NFKC");
  const chars = value.match(/[\p{L}\p{N}]/gu) || [];
  // Treat the entire free-text field as one possibly separated identifier.
  // Symbols, combining marks and invisible separators cannot split it into
  // apparently safe short fragments. Exact dates and money are separate fields.
  // Compatibility normalization can lengthen input (one ligature becomes
  // several letters), so either the original or the rendered length counts.
  const long = [...String(text || "Deposit")].length >= 5 || [...value].length >= 5;
  return long ? `[redacted] ****${chars.slice(-4).join("")}` : value.slice(0, 240);
}
const safeDescription = maskLedgerCandidateField;
const accountCoverage = accounts => accounts.map(a => ({
  account_mask: accountMask(a),
  covered_to: safeDay(a.covered_to), last_synced_at: safeSync(a.last_synced_at),
}));

function payerAssumptions(rows, payers, citations) {
  const groups = new Map();
  for (const row of rows) {
    const attribution = payers?.get(row.id);
    const reading = attribution?.state === 'assumed' ? attribution.reading : null;
    if (!reading) continue;
    const key = JSON.stringify([normalizeMerchantText(reading.identity), reading.prefix, reading.suffix]);
    if (!groups.has(key)) groups.set(key, { reading, rows: [] });
    groups.get(key).rows.push(row);
  }
  const refs = new Map(citations.map(c => [c.ref, c.n]));
  return [...groups.values()].map(({ reading, rows }) => ({
    type: 'payer_shorthand', identity: safeDescription(reading.identity),
    // Prefix/suffix are canonical constants from the closed grammar, not raw text.
    ...(reading.prefix ? { prefix: reading.prefix } : { suffix: reading.suffix }),
    count: rows.length, amount_minor: sumMinor(rows),
    citations: rows.map(row => refs.get(`ledger:transaction:${row.id}`)), flip: 'exact names only',
  }));
}

function withPayerAssumptions(result, rows, payers) {
  const assumptions = payerAssumptions(rows, payers, result.citations);
  if (!assumptions.length) return result;
  result.assumptions = assumptions;
  result.notes = assumptions.map(a => `Read the description as "${a.prefix ? `${a.prefix} + ${a.identity}` : `${a.identity} + ${a.suffix}`}": ${a.count} ${a.count === 1 ? 'row' : 'rows'} totaling ${money(a.amount_minor)} ${a.count === 1 ? 'rests' : 'rest'} on that reading of a confirmed identity; say "${a.flip}" to leave these out of payer attribution and retain their amounts as unattributed`);
  result.ledger.flip = [...(result.ledger.flip || []), 'exact names only'];
  return result;
}

function gapFor(reason, accounts = [], intent = {}) {
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
    const describe = (a, role) => `${role}: ${a?.institution ? safeDescription(a.institution) : 'institution unavailable'}, ${masked(a || {})}, ${accountKind(a)}`;
    return { type: 'ledger_not_consulted', reason, code: reason,
      ...(intent.from ? { from: intent.from, to: intent.to } : {}),
      detail: `Confirm whether these records describe the same account: ${describe(pair?.manual, 'manual import')}; ${describe(pair?.live, 'live feed')}. No money was removed. Preview with brain ledger link-accounts <manifest> --manual <manual-account> --live <live-account> --preview. Use the original account slugs from your local ledger inventory in those placeholders. Approve only if they are the same account; use --apply --approve <hash>. An outdated link can be reviewed with --unlink --preview.` };
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
    account_mask: accountMask(account),
    posted_on: day, amount_minor: amount, currency: row.currency,
    last_synced_at: safeSync(row.last_synced_at),
    supplied_by: ['manual', 'live'].includes(member?.feed_mode) ? member.feed_mode : "unknown",
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

async function ledgerAnswer(env, intent, accounts, inventory) {
  if (intent.measure === "cash_flow") return { reason: "cash_flow_unsupported" };
  if (intent.measure && !accounts.some(a => moveKind(a.account_kind))) return { reason: "unsupported_question" };
  if (intent.kind === "balance") {
    const balances = await readEffectiveBalances(env, accounts, intent);
    if (balances.length !== accounts.length || balances.some(b => b.basis_state !== "confirmed" ||
      !Number.isSafeInteger(b.current_minor) || b.currency !== "USD" || !safeDay(b.as_of_date))) return { reason: "balance_unavailable" };
    const citations = balances.map((row, i) => citation(row, accounts.find(a => a.account_slug === row.effective_account_slug), i, true));
    return { answer: balances.map((row, i) => `${masked(accounts.find(a => a.account_slug === row.effective_account_slug))}: ${money(row.current_minor)} as of ${row.as_of_date} [${i + 1}].`).join("\n"),
      citations, ledger: { kind: "balance", accounts: citations.map(c => ({ account_mask: c.account_mask, current_minor: c.amount_minor, as_of: c.posted_on })) } };
  }
  if (accounts.some(a => a.members.some(m => m.coverage_review_required))) return { reason: "coverage_review_required" };
  if (accounts.some(a => !effectivePeriodCovered(a, intent.from, intent.to))) return { reason: "period_outside_coverage" };
  if (intent.kind === "merchant" && intent.match && (/\[redacted\]/i.test(intent.match) ||
      ["unknown merchant", "unattributed"].includes(normalizeMerchantText(intent.match)) || intent.match.length >= 240))
    return { reason: "merchant_selector_unsupported" };
  // Pairing needs the other owned account even when the answer selects one
  // mask/kind. Six padding days prove mutual uniqueness: a counterpart within
  // three days may itself have a competing leg another three days away. Only
  // rows inside the requested window contribute to its income or spend.
  const payment = intent.kind === "payment";
  const namedIncome = intent.kind === "merchant" && intent.direction === "inflow" && intent.match;
  const namedPayer = Boolean(namedIncome || (payment && intent.counterpartyWords.length));
  const attributionNeeded = !payment || namedPayer;
  const snapshot = await readEffectiveTransactions(env, payment ? accounts : inventory, payment
    ? { ...intent, ...(namedPayer ? { amountMinor: null } : {}), payerIdentities: attributionNeeded }
    : { from: shiftLedgerDay(intent.from, -6), to: shiftLedgerDay(intent.to, 6), payerIdentities: attributionNeeded });
  const allRows = attributionNeeded ? snapshot.rows : snapshot;
  const identities = payerRegistry(attributionNeeded ? snapshot.identities : []);
  const wanted = namedPayer ? resolveRequestedPayer(intent, identities) : null;
  const selectorAmbiguous = ['ambiguous', 'unresolved'].includes(wanted?.state);
  const selectorCandidates = [...new Set((wanted?.candidates || []).map(safeDescription))];
  const attribute = createInflowAttributor(identities);
  const payers = new Map(allRows.filter(row => row.direction === 'inflow').map(row => [row.id, attribute(row)]));
  const payerMatches = row => wanted?.state === 'unique' && payers.get(row.id)?.entity_slug === wanted.slug;
  const merchantMatches = namedIncome ? payerMatches : row => matchesMerchant(row, intent.match);
  const inWindow = row => row.posted_on >= intent.from && row.posted_on <= intent.to;
  const selected = new Set(accounts.map(a => a.account_slug));
  const rows = allRows.filter(row => selected.has(row.effective_account_slug) && (!row.posted_on || inWindow(row)));
  if (rows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
  if (rows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
  const bySlug = new Map(inventory.map(a => [a.account_slug, a]));
  if (payment || namedIncome) {
    const candidates = rows.filter(row => row.direction === "inflow");
    const { matched, unattributed } = namedPayer
      ? selectAttributedInflows(candidates, payers, { wanted, amountMinor: payment ? intent.amountMinor : null, exactNamesOnly: intent.exactNamesOnly })
      : { matched: candidates.filter(row => intent.amountMinor === null || row.amount_minor === intent.amountMinor), unattributed: [] };
    // A named-income answer with unknown receipts must not flow into the
    // complete-total renderer, including its zero and conditional-total keys.
    // Fully attributed income retains the usual transfer and grouping rules.
    if (payment || unattributed.length || selectorAmbiguous) {
      const citations = [...matched, ...unattributed].map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i));
      let answer = matched.length
        ? matched.map((row, i) => `Found a deposit of ${money(row.amount_minor)} posted ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description)} [${i + 1}].`).join("\n")
        : unattributed.length || selectorAmbiguous ? "" : `No matching deposit in ${accounts.map(masked).join(", ")} between ${intent.from} and ${intent.to}; the bank feed covers through ${accounts.map(a => `${masked(a)}: ${safeDay(a.live?.covered_to) || "unknown (manual records only)"}`).join("; ")}.`;
      const confirmed = matched.filter(row => payers.get(row.id)?.state === 'confirmed');
      const confirmedSubtotal = namedIncome && confirmed.length ? payerAmount(sumMinor(confirmed), false) : null;
      const attributedSubtotal = namedIncome && matched.length ? payerAmount(sumMinor(matched), false) : null;
      if (namedIncome) answer = `Income from ${safeDescription(intent.match)} is not yet known for ${intent.from} through ${intent.to}.` +
        (matched.length ? `${attributedSubtotal === null ? '' : `\n${confirmed.length === matched.length ? "Confirmed subtotal of attributed deposits" : "Attributed subtotal"} (before transfer exclusions): ${money(attributedSubtotal)}.`}\n${answer}` : "");
      const gaps = [];
      const unattributedCitations = unattributed.map((_, i) => matched.length + i + 1);
      const payerCandidates = [...new Set(unattributed.flatMap(row => payers.get(row.id)?.evidence.ambiguous ? payers.get(row.id).evidence.candidates : []))].map(safeDescription);
      if (unattributed.length || selectorAmbiguous) {
        const detail = selectorAmbiguous
          ? `I can't confirm which payer you mean: ${wanted.state === 'ambiguous' ? 'the requested label identifies more than one confirmed entity' : 'the complete requested name or its boundary is not confirmed'}. Candidate payer readings: ${selectorCandidates.join('; ')}. There are ${unattributed.length} candidate deposits between ${intent.from} and ${intent.to}; use a unique legal name or owner label.`
          : `I found ${unattributed.length} ${unattributed.length === 1 ? "deposit that doesn't" : "deposits that don't"} show who paid between ${intent.from} and ${intent.to}; I can't confirm whether any came from the requested payer.`;
        answer += `${answer ? "\n" : ""}${detail}`;
        if (payerCandidates.length) answer += `\nThe description has ambiguous payer readings: ${payerCandidates.join('; ')}. I can't confirm which reading applies.`;
        for (const [i, row] of unattributed.entries()) answer += `\nUnattributed deposit: ${money(row.amount_minor)} posted ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description)} [${unattributedCitations[i]}].`;
        gaps.push({ type: "ledger_attribution_unknown", reason: "sender_attribution_unknown",
          from: intent.from, to: intent.to, count: unattributed.length, citations: unattributedCitations, detail });
      }
      return withPayerAssumptions({ answer, citations, gaps,
        ...(unattributed.length || selectorAmbiguous ? { evidence_gate: { supported: true, complete: false, partial: true, reason: "sender_attribution_unknown" } } : {}),
        ledger: { kind: intent.kind, inflow_total_minor: sumMinor(candidates), found: matched.length ? true : unattributed.length || selectorAmbiguous ? null : false,
        ...(selectorAmbiguous ? { payer_selector_ambiguous: true, payer_selector_candidates: selectorCandidates } : {}),
        ...(payerCandidates.length ? { payer_candidates: payerCandidates } : {}),
        ...(namedIncome ? { total_minor: null, lead_total_minor: null, confirmed_subtotal_minor: confirmedSubtotal, attributed_subtotal_minor: attributedSubtotal,
          confirmed_citations: confirmed.map(row => matched.indexOf(row) + 1) } : { amount_minor: intent.amountMinor }),
        ...(unattributed.length ? { unattributed_count: unattributed.length, unattributed_citations: unattributedCitations } : {}),
        from: intent.from, to: intent.to, accounts: accountCoverage(accounts) } }, matched, payers);
    }
  }
  // Named income already used independent identities. The legacy merchant
  // text parser can strip a real terminal name word and must not overrule it.
  if (intent.kind === "merchant" && intent.match && !namedIncome) {
    const wanted = normalizeMerchantText(intent.match);
    const directionRows = rows.filter(row => row.direction === intent.direction);
    const conjunction = text => text.replace(/\b(and)\b|&/g, "and");
    if (!directionRows.some(merchantMatches) && directionRows.some(row =>
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
      (intent.kind === "merchant" ? merchantMatches(row) : matchesCategory(row, intent.match)) ||
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
  const attributedRows = new Map();
  const publicAttribution = row => {
    if (row.direction !== 'inflow') return {};
    const attribution = payers.get(row.id);
    const usable = attribution?.state === 'confirmed' ||
      (attribution?.state === 'assumed' && !intent.exactNamesOnly && row.amount_minor > 0);
    if (usable) attributedRows.set(row.id, row);
    return { attribution_state: usable ? attribution.state : 'unknown',
      payer: usable ? safeDescription(attribution.reading.identity) : 'Unattributed',
      ...(attribution?.evidence.ambiguous ? { payer_candidates: [...new Set(attribution.evidence.candidates.map(safeDescription))] } : {}) };
  };
  const publicRow = row => ({ ...cite(row), ...publicAttribution(row), description: safeDescription(row.description || row.payee || "Transaction"), possible_own_transfer: pairing.candidateRows.has(row.id) });
  const payerLine = row => {
    if (row.direction !== 'inflow') return '';
    const attribution = publicAttribution(row);
    return attribution.attribution_state === 'unknown' ? `; payer: Unattributed${attribution.payer_candidates?.length ? ` (candidate readings: ${attribution.payer_candidates.join('; ')})` : ''}` : '';
  };
  const rowLine = row => `${money(row.amount_minor)} on ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description || row.payee || "Transaction")}${payerLine(row)}${candidateMark(row)} ${refs([row])}`;
  const bounded = `Accounts: ${accounts.map(masked).join(", ")}; ${intent.from} through ${intent.to}; ${accounts.map(a => `${masked(a)}: covered through ${safeDay(a.covered_to) || "unknown"}`).join("; ")}.`;
  const ledger = { kind: intent.kind, inflow_total_minor: sumMinor(rows.filter(row => row.direction === "inflow")), from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
    includes_own_transfers: true, matched_transfer_count: 0, candidate_transfer_count: pairs.length,
    lead: leadExcluded.size ? "default_exclusions" : "gross", default_exclusions: summary, flip: [] };
  const conditionalAccounts = accounts.map(account => {
    const ownRows = withoutCandidates(rows.filter(row => row.effective_account_slug === account.account_slug));
    return { account_mask: accountMask(account), credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
      debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
  });
  ledger.if_own_transfers = { accounts: conditionalAccounts };
  let conditionalDetail = conditionalAccounts.map((a, i) => `${masked(accounts[i])}: credits ${money(a.credits_minor)}; debits ${money(a.debits_minor)}`).join("; ");
  let answer, leadDetail, payerZeroUnknown = false;
  if (intent.kind === "totals") {
    ledger.accounts = accounts.map(account => {
      const ownRows = activity.filter(row => row.effective_account_slug === account.account_slug);
      return { account_mask: accountMask(account), credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
        debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
    });
    answer = ledger.accounts.map((total, i) => {
      const ownRows = activity.filter(row => row.effective_account_slug === accounts[i].account_slug);
      return `${masked(accounts[i])}, ${intent.from} through ${intent.to}: credits ${money(total.credits_minor)}; debits ${money(total.debits_minor)} ${refs(ownRows) || "(no posted income or expenses in the covered period)"}.`;
    }).join("\n");
    ledger.lead_accounts = accounts.map(account => {
      const ownRows = withoutLead(rows.filter(row => row.effective_account_slug === account.account_slug));
      return { account_mask: accountMask(account), credits_minor: sumMinor(ownRows.filter(r => r.direction === "inflow")),
        debits_minor: sumMinor(ownRows.filter(r => r.direction === "outflow")), transaction_count: ownRows.length };
    });
    leadDetail = ledger.lead_accounts.map((total, i) => `${masked(accounts[i])}, ${intent.from} through ${intent.to}: money in ${money(total.credits_minor)}; money out ${money(total.debits_minor)}.`).join("\n");
    if (intent.measure) {
      ledger.measure = intent.measure;
      ledger.net_minor = sumMinor(ledger.lead_accounts.filter((_, i) => moveKind(accounts[i].account_kind)), a => a.credits_minor - a.debits_minor);
      ledger.net_label = "money in minus money out, not accounting profit or cash flow";
      leadDetail = `Money in minus money out, not accounting profit or cash flow: ${money(ledger.net_minor)}.\n${leadDetail}`;
      for (const account of accounts.filter(a => !moveKind(a.account_kind)))
        leadDetail += `\n${masked(account)}: ${accountKind(account)} account, left out of money in minus money out; only checking, savings and card accounts contribute.`;
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
    const matched = intent.match ? directionRows.filter(row => (intent.kind === "merchant" ? merchantMatches(row) : matchesCategory(row, intent.match))) : directionRows;
    const unsorted = (intent.kind === "category" ? directionRows : matched).filter(row => !categoryFor(row));
    // Exclusions cannot turn an assumed payer reading into a certified zero,
    // including conditional transfer totals. Keep the supported gross figure.
    const hasShorthand = namedIncome && matched.some(row => payers.get(row.id)?.state === 'assumed');
    const scopeConfirmed = inflowScopeConfirmed(rows, payers);
    const payerTotal = (list, payerFigure = Boolean(namedIncome)) => {
      const total = sumMinor(list);
      const displayed = payerFigure ? payerAmount(total, scopeConfirmed) : total;
      if (displayed === null) payerZeroUnknown = true;
      return displayed;
    };
    const totalText = total => total === null ? 'not confirmed' : money(total);
    ledger.total_minor = payerTotal(matched);
    if (intent.kind === 'merchant' && intent.direction === 'inflow') ledger.total_is_exact = !intent.match || scopeConfirmed;
    ledger.unsorted_minor = sumMinor(unsorted); ledger.found = matched.length > 0;
    ledger.lead_total_minor = payerTotal(withoutLead(matched));
    leadDetail = `Total money ${intent.direction === "inflow" ? "in" : "out"}${intent.match ? ` for ${safeDescription(intent.match)}` : ` by ${intent.kind}`}: ${totalText(ledger.lead_total_minor)}; Unsorted: ${money(sumMinor(withoutLead(unsorted)))}.`;
    if (hasShorthand && ledger.lead_total_minor === null) leadDetail = `Income before exclusions: ${money(ledger.total_minor)}.\n${leadDetail}`;
    ledger.if_own_transfers.total_minor = payerTotal(withoutCandidates(matched));
    ledger.if_own_transfers.unsorted_minor = sumMinor(withoutCandidates(unsorted));
    conditionalDetail = `total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${safeDescription(intent.match)}` : ` by ${intent.kind}`}: ${totalText(ledger.if_own_transfers.total_minor)}; Unsorted: ${money(ledger.if_own_transfers.unsorted_minor)}`;
    const groups = new Map();
    for (const row of matched) {
      const attribution = intent.kind === 'merchant' && row.direction === 'inflow' ? publicAttribution(row) : null;
      const label = intent.kind === "category" ? categoryFor(row) : attribution
        ? attribution.payer : merchantFor(row) || "unknown merchant";
      if (intent.kind === "category" && !label) continue;
      const state = intent.kind === "category" ? row.category_basis_state : null;
      const key = JSON.stringify([attribution ? attribution.attribution_state === 'unknown' ? null : payers.get(row.id).entity_slug : label, state]);
      if (!groups.has(key)) groups.set(key, { label, state, attribution, candidates: new Set(), rows: [] });
      if (attribution?.attribution_state === 'assumed') groups.get(key).attribution = attribution;
      for (const candidate of attribution?.payer_candidates || []) groups.get(key).candidates.add(candidate);
      groups.get(key).rows.push(row);
    }
    const orderedGroups = [...groups.values()];
    if (intent.ranked) orderedGroups.sort((a, b) => sumMinor(b.rows) - sumMinor(a.rows) || a.label.localeCompare(b.label));
    ledger.groups = orderedGroups.map(g => ({ [intent.kind]: g.attribution ? g.label : safeDescription(g.label),
      ...(g.attribution ? { attribution_state: g.attribution.attribution_state,
        total_is_exact: g.attribution.attribution_state === 'confirmed' && scopeConfirmed } : {}),
      ...(g.candidates.size ? { payer_candidates: [...g.candidates] } : {}),
      category_basis_state: g.state, total_minor: payerTotal(g.rows, Boolean(g.attribution && g.attribution.attribution_state !== 'unknown')), citations: g.rows.map(row => cite(row).n),
      possible_transfer_citations: g.rows.filter(row => pairing.candidateRows.has(row.id)).map(row => cite(row).n),
      if_own_transfers_total_minor: payerTotal(withoutCandidates(g.rows), Boolean(g.attribution && g.attribution.attribution_state !== 'unknown') || Boolean(namedIncome)) }));
    answer = `Total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${safeDescription(intent.match)}` : ` by ${intent.kind}`}: ${money(ledger.total_minor)}.`;
    if (!matched.length) answer += " No matching transactions found.";
    for (const g of orderedGroups) answer += `\n${g.attribution ? g.label : safeDescription(g.label)}${g.attribution && !scopeConfirmed && g.attribution.attribution_state !== 'unknown' ? ' (attributed subtotal)' : ''}${g.candidates.size ? ` (candidate readings: ${[...g.candidates].join('; ')})` : ''}${g.state === "proposed" ? " (bank's category (unconfirmed))" : ""}: ${totalText(payerTotal(g.rows, Boolean(g.attribution && g.attribution.attribution_state !== 'unknown')))} ${refs(g.rows)}${g.rows.some(row => pairing.candidateRows.has(row.id)) ? " (includes possible moves between your own accounts)" : ""}.`;
    answer += `\nUnsorted: ${money(ledger.unsorted_minor)}${intent.kind === "category" && intent.match && !matched.some(row => !categoryFor(row)) ? " (separate from the requested category)" : ""} ${refs(unsorted)}.`;
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
  const uncertainty = payerZeroUnknown ? {
    gaps: [{ type: 'ledger_attribution_unknown', reason: 'payer_zero_unconfirmed',
      detail: 'A zero is not confirmed for this payer while a deposit lacks confirmed attribution.' }],
    evidence_gate: { supported: true, complete: false, partial: true, reason: 'payer_zero_unconfirmed' },
  } : {};
  if (payerZeroUnknown) answer += `\n${uncertainty.gaps[0].detail}`;
  // Notes follow displayed payer claims, including gross rows, excluded rows
  // and transfer diagnostics. Exact-only never removes the underlying amounts.
  return withPayerAssumptions({ answer, citations, ledger, ...uncertainty }, [...attributedRows.values()], payers);
}

// The only integration point wraps the existing document path. Non-money
// responses return untouched, including their exact serialized bytes.

export async function withLedgerAnswer({ env, question, access, grantScope, scopePrincipalKind,
  filters = {}, entityScope, ledgerEligible = true, now = Date.now() }, next) {
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
        const answer = await ledgerAnswer(env, intent, accounts, inventory);
        reason = answer.reason;
        if (!reason) return new Response(JSON.stringify({ mode: "think",
          answer: answer.answer + (answer.notes?.length ? `\nNote: ${answer.notes.join('; ')}.` : ''),
          ...(answer.assumptions?.length ? { assumptions: answer.assumptions, notes: answer.notes } : {}),
          citations: answer.citations, results: [], gaps: answer.gaps || [], ledger: answer.ledger,
          evidence_gate: answer.evidence_gate || { supported: true, complete: true, reason: "read from covered ledger rows" } }),
        { headers: { "Content-Type": "application/json" } });
      }
      gap = gapFor(reason, reason === 'ledger_account_link_required' ? disputed : accounts, intent);
      // Documents cannot resolve a disputed ledger identity or authorize a
      // financial total that this deterministic account decision refused.
      if (['ledger_account_link_required', 'cash_flow_unsupported', 'merchant_selector_unsupported',
        'merchant_selector_ambiguous', 'coverage_review_required', 'bank_export_overlap_review_required'].includes(reason)) return new Response(JSON.stringify({ mode: 'think',
        code: reason, answer: null, citations: [], results: [], gaps: [gap],
        evidence_gate: { supported: false, complete: false, reason } }), { headers: { 'Content-Type': 'application/json' } });
    } catch {
      gap = gapFor("ledger_unavailable", accounts, intent);
    }
  }
  const response = await next(gap);
  if (!response.ok) return response;
  const body = await response.json();
  body.gaps = [gap, ...(body.gaps || []).filter(g => g.type !== gap.type)];
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
}
