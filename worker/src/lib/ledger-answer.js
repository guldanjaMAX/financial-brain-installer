import { createInflowAttributionBudget, createInflowAttributor, boundedPayerFields, exactPayerFieldAdmitted, payerFieldsAgree, payerRegistryHasDamage, payerRegistry, payerQuestionRegistry, resolveRequestedPayer, selectAttributedInflows, inflowScopeConfirmed, payerAmount } from "./ledger-attribution.js";
import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion, ledgerDay, shiftLedgerDay, payerMentionsCoverQuestion } from "./ledger-question.js";
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
  // A placeholder is renderer text, not a bank field. Masking it would print a
  // redaction tail claiming an identifier was hidden where none was read.
  if (text === null || text === undefined || text === "") return "Deposit";
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
// Only read bank text is masked; the placeholder for a row with neither field
// is renderer text and prints plainly.
const rowDescription = row => row.description || row.payee ? safeDescription(row.description || row.payee) : "Transaction";
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
    ...(reading.query_only ? { query_only: true } : {}),
    // Prefix/suffix are canonical constants from the closed grammar, not raw text.
    ...(reading.prefix ? { prefix: reading.prefix } : { suffix: reading.suffix }),
    count: rows.length, amount_minor: sumMinor(rows),
    citations: rows.map(row => refs.get(`ledger:transaction:${row.id}`)).filter(Number.isInteger), flip: 'exact names only',
  }));
}

const answerBudgetExhausted = payers => [...payers.values()].some(payer => payer.evidence.parser?.refusal === 'answer-operation-limit');

function withPayerAssumptions(result, rows, payers) {
  if (answerBudgetExhausted(payers)) {
    const detail = 'The answer reached its sender parsing work limit. Some rows read remain unattributed; no complete total or absence is confirmed. Subtotals are partial.';
    result.gaps = [...(result.gaps || []), { type: 'ledger_attribution_budget', reason: 'answer_operation_limit', detail }];
    result.answer += `\n${detail}`;
    result.evidence_gate = { supported: true, complete: false, partial: true, reason: 'answer_operation_limit' };
  }
  const assumptions = payerAssumptions(rows, payers, result.citations);
  if (!assumptions.length) return result;
  result.assumptions = assumptions;
  result.notes = assumptions.map(a => `Read the description as "${a.prefix ? `${a.prefix} + ${a.identity}` : `${a.identity} + ${a.suffix}`}": ${a.count} ${a.count === 1 ? 'row' : 'rows'} totaling ${money(a.amount_minor)} ${a.count === 1 ? 'rests' : 'rest'} on that reading of ${a.query_only ? 'the requested payer phrase' : 'a confirmed identity'}; say "${a.flip}" to leave these out of payer attribution and retain their amounts as unattributed`);
  result.ledger.flip = [...(result.ledger.flip || []), 'exact names only'];
  return result;
}

// Fixed reason vocabulary and the same free-field masker apply to every
// refusal candidate. Never echo raw parser fragments or bank identifiers.
function attributionUncertainty(row, attribution, selectorAmbiguous, exactNamesOnly) {
  if (attribution.state === 'assumed') return exactNamesOnly
    ? 'shorthand reading excluded by exact names only' : 'shorthand cannot rule out another payer';
  if (attribution.evidence.ambiguous) return 'competing payer readings';
  if (row.payee_has_nul || row.description_has_nul) return 'damaged bank field';
  if (attribution.evidence.sender_unread) return 'statement sender could not be read';
  if (row.payee) return 'bank payer field does not establish the requested identity';
  if (attribution.evidence.parser && !attribution.evidence.parser.complete) return 'statement sender could not be completely parsed';
  return selectorAmbiguous ? 'requested payer phrase could not be resolved' : 'sender identity is not confirmed';
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

// Exactness belongs to the original selector and bounded evidence, never to
// the success of a cleanup predicate. All alternatives share one snapshot and
// one parsing budget; unresolved literal fields still participate in conflict.
function chooseLiteralSelector(intent, identities, rows, budget) {
  const labelOf = reading => reading.kind === 'payment' ? reading.counterparty : reading.match;
  if (!['merchant', 'category', 'payment'].includes(intent.kind) || !labelOf(intent)) return { intent };
  // Categories have their own bank taxonomy (including software/SaaS aliases),
  // not a merchant/payer identity. Preserve that separate selection contract.
  if (intent.kind === 'category') {
    if (!intent.selectorReadings) return { intent };
    const { raw, cleaned, labels } = intent.selectorReadings;
    const matches = reading => reading.kind ? rows.filter(row => row.direction === reading.direction && matchesCategory(row, reading.match)) : [];
    const literal = matches(raw), alternate = matches(cleaned);
    if (literal.length && alternate.length && JSON.stringify(literal.map(row => row.id)) !== JSON.stringify(alternate.map(row => row.id)))
      return { refusal: 'ambiguous', labels };
    if (literal.length) return { intent: raw };
    if (alternate.length) return { intent: cleaned };
    return { refusal: 'unmatched', labels };
  }
  const payer = intent.kind === 'payment' || intent.kind === 'merchant' && intent.direction === 'inflow';
  const labels = intent.selectorReadings?.labels || [labelOf(intent)];
  const evaluate = reading => {
    if (!reading.kind) return { exact: false, matched: [], possible: [] };
    const label = labelOf(reading), key = normalizeMerchantText(label);
    const ids = identities.get(key) || new Set();
    const scoped = rows.filter(row => row.posted_on >= reading.from && row.posted_on <= reading.to &&
      row.direction === (payer ? 'inflow' : reading.direction));
    const amountMatches = row => reading.kind !== 'payment' || reading.amountMinor === null || row.amount_minor === reading.amountMinor;
    if (!payer) {
      const possible = scoped.filter(row => matchesMerchant(row, label));
      const slug = ids.size === 1 ? [...ids][0] : null;
      const matched = scoped.filter(row => {
        if (!row.payee || row.payee_has_nul) return false;
        const field = normalizeMerchantText(row.payee), aliases = identities.get(field);
        return field === key || slug && aliases?.size === 1 && aliases.has(slug);
      });
      return { exact: matched.length > 0, matched, possible, ids,
        conflict: ids.size > 1 || payerRegistryHasDamage(identities) && !slug };
    }
    const attribute = createInflowAttributor(payerQuestionRegistry(reading, identities), { budget });
    const attributions = new Map(scoped.map(row => [row.id, attribute(row)]));
    const fields = new Map(scoped.map(row => [row.id, boundedPayerFields(row, attributions.get(row.id), identities)]));
    const wanted = resolveRequestedPayer(reading, identities, [...attributions.values()]);
    const coversName = payerMentionsCoverQuestion(reading, (reading.payerReadings || []).filter(span =>
      Number.isInteger(span.start) && normalizeMerchantText(span.label) === key));
    const registered = wanted.state === 'unique' && wanted.registered !== false;
    const slug = registered ? wanted.slug : coversName && ids.size === 1 ? [...ids][0] : null;
    const literal = row => fields.get(row.id)?.fields.some(field => normalizeMerchantText(field) === key);
    const sameIdentity = row => slug && attributions.get(row.id)?.state === 'confirmed' && attributions.get(row.id)?.entity_slug === slug;
    // The question can equal a labelled sender while the payee differs only by
    // a closed trailing company suffix. That is EXACT agreement (as in R4B),
    // so the admitted sender field supports the row as the payee would.
    const agreeingSender = row => payerFieldsAgree(row.payee, label) &&
      ['confirmed', 'observed'].includes(attributions.get(row.id)?.state) &&
      fields.get(row.id)?.fields.some(field => normalizeMerchantText(field) === key && exactPayerFieldAdmitted(label, field));
    const supportedLiteral = row => coversName && literal(row) && (registered || !reading.payerQuestion?.unsupportedPunctuation) &&
      (row.payee ? registered || exactPayerFieldAdmitted(label, row.payee) || agreeingSender(row)
        : ['confirmed', 'observed'].includes(attributions.get(row.id)?.state));
    // Attribution covers the entire window, including other amounts. They
    // neither enter this selection nor become unknown merely due to its filter.
    const matched = scoped.filter(row => amountMatches(row) && (supportedLiteral(row) || sameIdentity(row)) && !fields.get(row.id)?.conflict);
    const possible = selectAttributedInflows(scoped, attributions, { wanted, amountMinor: reading.kind === 'payment' ? reading.amountMinor : null,
      exactNamesOnly: reading.exactNamesOnly }).matched;
    // A registered substring cannot become an exact question reading merely
    // because attribution resolved it. Whole-clause coverage is still required.
    const conflict = ids.size > 1 || wanted.state === 'ambiguous' || payerRegistryHasDamage(identities) && !registered ||
      scoped.some(row => literal(row) && fields.get(row.id)?.conflict);
    return { exact: registered || matched.length > 0, matched, possible, ids, conflict,
      conflictRows: new Set(scoped.filter(row => fields.get(row.id)?.conflict).map(row => row.id)),
      knownRows: new Set(scoped.filter(row => !fields.get(row.id)?.conflict && (!literal(row) || supportedLiteral(row)) &&
        (fields.get(row.id)?.fields.length || attributions.get(row.id)?.state === 'confirmed')).map(row => row.id)),
      attributions, candidates: wanted.candidates, blockedLiteral: scoped.some(row => literal(row) && !supportedLiteral(row)),
      exhausted: answerBudgetExhausted(attributions) };
  };
  const raw = intent.selectorReadings?.raw || intent;
  const literal = evaluate(raw);
  const alternatives = (intent.selectorReadings?.alternatives || []).map(reading => ({ reading, result: evaluate(reading) }));
  const cleaned = intent.selectorReadings?.cleaned;
  const alternate = cleaned ? evaluate(cleaned) : { possible: [] };
  if (literal.exhausted && !intent.selectorReadings) {
    if (literal.possible.some(row => literal.attributions.get(row.id)?.state === 'assumed'))
      return { intent, possible: literal.possible, attributions: literal.attributions, labels };
    return { intent, attributions: literal.attributions };
  }
  if (literal.exhausted || alternate.exhausted || alternatives.some(a => a.result.exhausted)) return { refusal: 'budget', labels };
  // Without alternative readings the conflict keeps the legacy attribution
  // path, but it is still a conflict: the answer can show what it read and
  // never certify a complete total, zero or absence from it.
  if (literal.conflict) return intent.selectorReadings
    ? { refusal: 'ambiguous', labels: literal.candidates?.length > 1 ? literal.candidates : labels }
    : { intent, attributions: literal.attributions, literalConflict: payer, conflictRows: literal.conflictRows || new Set() };
  const exact = [{ reading: raw, result: literal }, ...alternatives].filter(a => a.result.exact &&
    (a.result.matched.length || !a.result.possible.length));
  const key = result => JSON.stringify([[...(result.ids || [])].sort(), result.matched.map(row => row.id).sort((a, b) => a - b)]);
  if (exact.some(a => a.result.conflict) || new Set(exact.map(a => key(a.result))).size > 1)
    return { refusal: 'ambiguous', labels: exact.map(a => labelOf(a.reading)) };
  if (exact.length && !intent.selectorUnproven) {
    const chosen = exact[0];
    // Rows matched only by description containment block completeness, the
    // same as unattributed receipts on the inflow side: the exact rows are a
    // partial subtotal and the others are listed as possible matches.
    if (!payer) {
      const exactIds = new Set(chosen.result.matched.map(row => row.id));
      const others = chosen.result.possible.filter(row => !exactIds.has(row.id));
      if (others.length) return { intent: chosen.reading, possible: others, exactMatches: chosen.result.matched, labels };
    }
    return { intent: chosen.reading, exact: true, attributions: chosen.result.attributions, knownRows: chosen.result.knownRows,
      exactRows: new Set(chosen.result.matched.map(row => row.id)) };
  }
  if (literal.blockedLiteral && cleaned) return { refusal: 'ambiguous', labels };
  const possible = [...new Map([...literal.possible, ...alternate.possible, ...(alternate.matched || [])].map(row => [row.id, row])).values()];
  if (possible.length) return { intent: raw, possible, labels, attributions: new Map([
    ...(literal.attributions || []), ...(alternate.attributions || [])]) };
  // Keep the established uncertainty detail for ordinary unresolved payers.
  // Cleanup nonmatches use the explicit null-total contract.
  return intent.selectorReadings || intent.selectorUnproven || !payer ? { refusal: 'unmatched', labels } : { intent, attributions: literal.attributions };
}

function possibleSelectorAnswer(selection, accounts, inventory, scopedRows, allRows) {
  const { intent } = selection;
  // Exact rows beside possible matches (an outflow merchant whose bounded
  // payee field equals the question while other rows match only by
  // description): presence is shown, but the exact rows are a partial
  // subtotal and never a complete total, zero or absence.
  const exactRows = selection.exactMatches || [], mixed = exactRows.length > 0;
  const rows = intent.exactNamesOnly ? [] : selection.possible;
  const total = sumMinor(rows), subtotal = total > 0 ? total : null;
  const exactTotal = sumMinor(exactRows), exactSubtotal = exactTotal > 0 ? exactTotal : null;
  const bySlug = new Map(inventory.map(account => [account.account_slug, account]));
  const listedRows = [...exactRows, ...rows].slice(0, 10);
  const citations = listedRows.map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i));
  const note = 'matched by name similarity, not an exact merchant/payer name; say "exact names only" to exclude these possible matches.';
  const excluded = selection.possible.length;
  const detail = mixed
    ? intent.exactNamesOnly ? `Exact names only leaves out ${excluded} possible ${excluded === 1 ? 'match' : 'matches'} by name similarity, so no complete total or absence is confirmed.`
      : 'Some rows match the exact name and others are possible matches. No complete total or absence is confirmed.'
    : intent.exactNamesOnly ? 'Exact names only excludes the possible matches. No complete total, presence or absence is confirmed.'
    : 'These are possible matches. No complete total, presence or absence is confirmed.';
  const assumed = withPayerAssumptions({ answer: '', citations, ledger: {} },
    rows.filter(row => row.amount_minor > 0), selection.attributions || new Map());
  const assumptions = assumed.assumptions || [];
  const pairing = pairOwnTransfers(allRows.filter(row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
    effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on)), bySlug);
  const selected = new Set(accounts.map(account => account.account_slug));
  const { summary } = leadExclusions([...exactRows, ...rows], pairing.pairs, selected, bySlug, intent);
  const candidates = [...exactRows, ...rows].filter(row => pairing.candidateRows.has(row.id));
  const transferNotes = [
    ...(summary.withdrawal_count ? ['The partial subtotal is before transfer exclusions, including withdrawals.'] : []),
    ...(candidates.length ? ['Possible moves between your own accounts remain in this partial subtotal.'] : []),
  ];
  const notes = [...(assumed.notes || []), note, ...transferNotes];
  const exactCitations = citations.slice(0, exactRows.length).map(c => c.n);
  const possibleCitations = citations.slice(exactRows.length).map(c => c.n);
  return { answer: `${detail}${mixed && exactSubtotal !== null ? ` Exact-name subtotal (partial; before exclusions): ${money(exactSubtotal)}.` : ''}` +
      `${subtotal === null ? '' : ` ${mixed ? 'Possible-match subtotal' : 'Partial subtotal'} before exclusions: ${money(subtotal)}.`}\nNote: ${notes.join('; ')}.` +
      citations.filter(c => c.amount_minor > 0).map(c => `\n${exactCitations.includes(c.n) ? 'Exact match' : 'Possible match'}: ${money(c.amount_minor)} posted ${c.posted_on} [${c.n}].`).join(''),
    citations, assumptions: assumptions.length ? assumptions : [{ type: 'name_similarity', count: rows.length, flip: 'exact names only' }], notes,
    gaps: [{ type: 'ledger_selector_possible', reason: 'name_similarity', detail }],
    evidence_gate: { supported: true, complete: false, partial: true, reason: 'name_similarity' },
    ledger: { kind: intent.kind, found: mixed ? true : null, total_minor: null, lead_total_minor: null, total_is_exact: false,
      inflow_total_minor: sumMinor(scopedRows.filter(row => row.direction === 'inflow')),
      subtotal_is_partial: true, attributed_subtotal_minor: mixed ? exactSubtotal : subtotal, confirmed_subtotal_minor: mixed ? exactSubtotal : null,
      ...(mixed ? { exact_count: exactRows.length, exact_citations: exactCitations, possible_count: excluded,
        possible_subtotal_minor: subtotal, possible_citations: possibleCitations } : {}),
      from: intent.from, to: intent.to, accounts: accountCoverage(accounts), rows: citations,
      candidate_transfer_count: candidates.length, default_exclusions: summary,
      groups: [{ total_minor: null, total_is_exact: false, if_own_transfers_total_minor: null }],
      omitted_count: Math.max(0, exactRows.length + rows.length - citations.length), flip: ['exact names only'], if_own_transfers: { total_minor: null } } };
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
  const inWindow = row => row.posted_on >= intent.from && row.posted_on <= intent.to;
  const selected = new Set(accounts.map(a => a.account_slug));
  let rows = allRows.filter(row => selected.has(row.effective_account_slug) && (!row.posted_on || inWindow(row)));
  if (rows.some(row => row.export_overlap_review)) return { reason: "bank_export_overlap_review_required" };
  if (rows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
  if (intent.kind === 'merchant' && intent.direction === 'outflow' && intent.match) {
    const wanted = normalizeMerchantText(intent.match), conjunction = text => text.replace(/\b(and)\b|&/g, 'and');
    const outgoing = rows.filter(row => row.direction === 'outflow');
    if (!outgoing.some(row => matchesMerchant(row, intent.match)) && outgoing.some(row =>
      conjunction(merchantFor(row)) === conjunction(wanted))) return { reason: 'merchant_selector_ambiguous' };
  }
  const attributionBudget = createInflowAttributionBudget();
  const selection = chooseLiteralSelector(intent, identities, rows, attributionBudget);
  if (selection.possible) return possibleSelectorAnswer(selection, accounts, inventory, rows, allRows);
  if (selection.refusal) {
    const ambiguous = selection.refusal === 'ambiguous', budget = selection.refusal === 'budget';
    const labels = selection.labels.map(safeDescription);
    const detail = budget ? 'The answer reached its sender parsing work limit while comparing names. No complete total or presence or absence is confirmed.' : ambiguous ? `I can't tell whether you mean ${labels[0]} or ${labels[1] || 'a competing payer reading'}. Use a unique registered label or the complete statement name.`
      : `No matching transactions were found for ${labels[0]} in the covered accounts. The merchant may appear under a different name on statements.`;
    const reason = budget ? 'answer_operation_limit' : ambiguous ? 'selector_cleanup_ambiguous' : 'statement_name_unconfirmed';
    return { answer: detail, citations: [], gaps: [{ type: budget ? 'ledger_attribution_budget' : ambiguous ? 'ledger_selector_ambiguous' : 'ledger_selector_unmatched', reason, detail }],
      ledger: { kind: intent.kind, found: ambiguous || budget ? null : false, total_minor: null, lead_total_minor: null,
        total_is_exact: false, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
        ...(ambiguous ? { selector_ambiguous: true, selector_candidates: labels,
          ...(namedPayer ? { payer_selector_ambiguous: true, payer_selector_candidates: labels } : {}) } : {}),
        if_own_transfers: { total_minor: null } },
      evidence_gate: { supported: true, complete: false, partial: true, reason } };
  }
  intent = selection.intent;
  // A cleaned amount reading may select the shorter default window.
  rows = rows.filter(inWindow);
  const attribute = createInflowAttributor(namedPayer ? payerQuestionRegistry(intent, identities) : identities, { budget: attributionBudget });
  const payers = new Map(allRows.filter(row => row.direction === 'inflow').map(row => [row.id, selection.attributions?.get(row.id) || attribute(row)]));
  // Literal bank fields are answer-local evidence, not new registry entries.
  // Keep their source visible even when a shorter registered mention prevented
  // the old question-local lookup from resolving the complete raw name.
  if (namedPayer && selection.exactRows) for (const row of rows) {
    if (!selection.exactRows.has(row.id) || ['confirmed', 'observed'].includes(payers.get(row.id)?.state)) continue;
    const previous = payers.get(row.id);
    payers.set(row.id, { ...previous, state: 'observed', entity_slug: previous?.entity_slug || Symbol('literal payer'),
      reading: { identity: row.payee || intent.counterparty || intent.match, query_only: true },
      evidence: { ...previous?.evidence, source: row.payee ? 'payee' : 'description' } });
  }
  // This is an answer-wide refusal, including transfer padding and other
  // accounts read. Decide before any complete-total text or keys are built.
  const budgetExhausted = answerBudgetExhausted(payers);
  // Only selected, readable receipts inside the requested window can supply
  // phrase evidence. Transfer padding and other accounts cannot resolve it.
  const wanted = namedPayer ? resolveRequestedPayer(intent, identities,
    rows.filter(row => row.direction === 'inflow').map(row => payers.get(row.id))) : null;
  const selectorAmbiguous = !selection.exact && ['ambiguous', 'unresolved'].includes(wanted?.state);
  const selectorCandidates = [...new Set((wanted?.candidates || []).map(safeDescription))];
  const phraseOnly = !selection.exact && wanted?.registered === false;
  // The literal-conflict fallback has no exact/possible split. It may reach
  // the complete renderer only when every receipt in scope is confirmed; an
  // assumed (shorthand) or observed row there is a possible match, so the
  // answer stays incomplete with an attributed subtotal.
  const literalConflict = Boolean(namedPayer && selection.literalConflict &&
    rows.some(row => row.direction === 'inflow' && payers.get(row.id)?.state !== 'confirmed'));
  const payerMatches = row => selection.exactRows ? selection.exactRows.has(row.id) : wanted?.state === 'unique' && payers.get(row.id)?.entity_slug === wanted.slug;
  const merchantMatches = selection.exactRows ? row => selection.exactRows.has(row.id) : namedIncome ? payerMatches : row => matchesMerchant(row, intent.match);
  const bySlug = new Map(inventory.map(a => [a.account_slug, a]));
  if (payment || namedIncome) {
    const candidates = rows.filter(row => row.direction === "inflow");
    const { matched, unattributed } = namedPayer && selection.exactRows?.size
      ? { matched: candidates.filter(row => selection.exactRows.has(row.id)),
        unattributed: candidates.filter(row => !selection.knownRows?.has(row.id)) }
      : namedPayer
      ? selectAttributedInflows(candidates, payers, { wanted, amountMinor: payment ? intent.amountMinor : null, exactNamesOnly: intent.exactNamesOnly })
      : { matched: candidates.filter(row => intent.amountMinor === null || row.amount_minor === intent.amountMinor), unattributed: [] };
    // A named-income answer with unknown receipts must not flow into the
    // complete-total renderer, including its zero and conditional-total keys.
    // Fully attributed income retains the usual transfer and grouping rules.
    if (payment || unattributed.length || selectorAmbiguous || phraseOnly || budgetExhausted || literalConflict) {
      const listedUnattributed = unattributed.slice(0, 10);
      const uncertain = budgetExhausted || unattributed.length || selectorAmbiguous || (phraseOnly && (!matched.length || namedIncome)) ||
        (literalConflict && (!matched.length || namedIncome));
      const citations = [...matched, ...listedUnattributed].map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i));
      const payerEvidence = matched.flatMap((row, i) => payers.get(row.id)?.state === 'observed' ? [{
        type: payers.get(row.id).evidence.source === 'payee' ? 'bank_payee' : 'statement_sender',
        identity: safeDescription(payers.get(row.id).reading.identity), citations: [i + 1],
      }] : []);
      const phraseBasis = row => {
        const attribution = payers.get(row.id);
        if (attribution?.state !== 'observed') return '';
        const label = safeDescription(attribution.reading.identity);
        return attribution.evidence.source === 'payee' ? `; your bank lists the payer as ${label}`
          : `; the statement line names ${label} as sender`;
      };
      let answer = matched.length
        ? matched.map((row, i) => `Found a deposit of ${money(row.amount_minor)} posted ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description)}${phraseBasis(row)} [${i + 1}].`).join("\n")
        : uncertain ? "" : `No matching deposit in ${accounts.map(masked).join(", ")} between ${intent.from} and ${intent.to}; the bank feed covers through ${accounts.map(a => `${masked(a)}: ${safeDay(a.live?.covered_to) || "unknown (manual records only)"}`).join("; ")}.`;
      const confirmed = matched.filter(row => payers.get(row.id)?.state === 'confirmed');
      const confirmedSubtotal = namedIncome && confirmed.length ? payerAmount(sumMinor(confirmed), false) : null;
      const attributedSubtotal = namedIncome && matched.length ? payerAmount(sumMinor(matched), false) : null;
      if (namedIncome) answer = `Income from ${safeDescription(intent.match)} is not yet known for ${intent.from} through ${intent.to}.` +
        (matched.length ? `${attributedSubtotal === null ? '' : `\n${confirmed.length === matched.length ? "Confirmed subtotal of attributed deposits" : "Attributed subtotal"} (${budgetExhausted ? 'partial; ' : ''}before transfer exclusions): ${money(attributedSubtotal)}.`}\n${answer}` : "");
      const gaps = [];
      const unattributedCitations = listedUnattributed.map((_, i) => matched.length + i + 1);
      const uncertainCandidates = listedUnattributed.map((row, i) => ({
        posted_on: row.posted_on, amount_minor: row.amount_minor,
        field: row.payee ? 'bank_payee' : 'description', label: safeDescription(row.payee || row.description),
        reason: attributionUncertainty(row, payers.get(row.id), selectorAmbiguous, intent.exactNamesOnly), citation: unattributedCitations[i],
      }));
      const payerCandidates = [...new Set(unattributed.flatMap(row => payers.get(row.id)?.evidence.ambiguous ? payers.get(row.id).evidence.candidates : []))].slice(0, 10).map(safeDescription);
      if (unattributed.length || selectorAmbiguous || (phraseOnly && (!matched.length || namedIncome)) ||
          (literalConflict && (!matched.length || namedIncome))) {
        const detail = selectorAmbiguous
          ? `I can't confirm which payer you mean: ${wanted.state === 'ambiguous' ? 'the question has ambiguous payer readings' : 'the complete requested name or its boundary is not confirmed'}. Candidate payer readings: ${selectorCandidates.join('; ')}. There are ${unattributed.length} candidate deposits between ${intent.from} and ${intent.to}; use the exact bank payer field, statement sender, or a unique registered label.`
          : phraseOnly ? `These matches support the requested phrase for this answer only. The payer is not registered, so I can't confirm a complete income total or absence.`
          : unattributed.length ? `I found ${unattributed.length} ${unattributed.length === 1 ? "deposit that doesn't" : "deposits that don't"} show who paid between ${intent.from} and ${intent.to}; I can't confirm whether any came from the requested payer.`
          : `A deposit's bank payer field and statement sender are not the same spelling, so I can't confirm a complete income total or absence.`;
        answer += `${answer ? "\n" : ""}${detail}`;
        const exactMatches = matched.filter(row => payers.get(row.id)?.state !== 'assumed' && !selection.conflictRows?.has(row.id)).length;
        answer += `\nFound ${exactMatches} exact matches; ${unattributed.length} deposits I couldn't attribute.`;
        if (payerCandidates.length) answer += `\nThe description has ambiguous payer readings: ${payerCandidates.join('; ')}. I can't confirm which reading applies.`;
        for (const candidate of uncertainCandidates) answer += `\nUnattributed deposit: ${money(candidate.amount_minor)} posted ${candidate.posted_on}; ${candidate.field === 'bank_payee' ? "bank's payer field" : 'statement description'}: ${candidate.label}; uncertain because ${candidate.reason} [${candidate.citation}].`;
        if (unattributed.length > listedUnattributed.length) answer += `\nShowing ${listedUnattributed.length} of ${unattributed.length} candidate deposits; ${unattributed.length - listedUnattributed.length} more are not listed.`;
        gaps.push({ type: "ledger_attribution_unknown", reason: "sender_attribution_unknown",
          from: intent.from, to: intent.to, count: unattributed.length, citations: unattributedCitations, detail });
      }
      return withPayerAssumptions({ answer, citations, gaps,
        ...(payerEvidence.length ? { payer_evidence: payerEvidence } : {}),
        ...(uncertain ? { evidence_gate: { supported: true, complete: false, partial: true, reason: "sender_attribution_unknown" } } : {}),
        ledger: { kind: intent.kind, inflow_total_minor: sumMinor(candidates), found: matched.length ? true : uncertain ? null : false,
        ...(budgetExhausted || namedIncome ? { total_is_exact: false, subtotal_is_partial: true } : {}),
        ...(selectorAmbiguous ? { payer_selector_ambiguous: true, payer_selector_candidates: selectorCandidates } : {}),
        ...(payerCandidates.length ? { payer_candidates: payerCandidates } : {}),
        ...(namedIncome ? { total_minor: null, lead_total_minor: null, confirmed_subtotal_minor: confirmedSubtotal, attributed_subtotal_minor: attributedSubtotal,
          confirmed_citations: confirmed.map(row => matched.indexOf(row) + 1) } : { amount_minor: intent.amountMinor }),
        ...(uncertain ? { unattributed_count: unattributed.length, unattributed_citations: unattributedCitations,
          unattributed_candidates: uncertainCandidates, unattributed_omitted_count: unattributed.length - listedUnattributed.length } : {}),
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
  if (budgetExhausted) {
    // No answer kind can render a complete figure after the shared budget
    // fails. Preserve read amounts and citations as explicitly partial data,
    // without producing conditional, grouped, net or recurring total claims.
    const listed = figureRows.slice(0, 10);
    const citations = listed.map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i));
    const partial = {
      inflow_minor: sumMinor(figureRows.filter(row => row.direction === 'inflow')),
      outflow_minor: sumMinor(figureRows.filter(row => row.direction === 'outflow')),
    };
    const answer = `Partial subtotal of read inflows before exclusions: ${money(partial.inflow_minor)}; partial subtotal of read outflows before exclusions: ${money(partial.outflow_minor)}.\n` +
      listed.map((row, i) => `${money(row.amount_minor)} posted ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))} [${i + 1}].`).join('\n') +
      (figureRows.length > listed.length ? `\nShowing ${listed.length} of ${figureRows.length} read transactions.` : '');
    return withPayerAssumptions({ answer, citations, ledger: { kind: intent.kind,
      from: intent.from, to: intent.to, accounts: accountCoverage(accounts), found: null,
      total_minor: null, lead_total_minor: null, total_is_exact: false, subtotal_is_partial: true,
      partial_subtotals: partial, inflow_total_minor: sumMinor(rows.filter(row => row.direction === 'inflow')),
      rows: citations, omitted_count: figureRows.length - listed.length } }, [], payers);
  }
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
      (selection.exactRows?.has(row.id) && attribution?.state === 'observed') ||
      (attribution?.state === 'assumed' && !intent.exactNamesOnly && row.amount_minor > 0);
    if (usable) attributedRows.set(row.id, row);
    return { attribution_state: usable ? attribution.state : 'unknown',
      payer: usable ? safeDescription(attribution.reading.identity) : 'Unattributed',
      ...(attribution?.evidence.ambiguous ? { payer_candidates: [...new Set(attribution.evidence.candidates.map(safeDescription))] } : {}) };
  };
  const publicRow = row => ({ ...cite(row), ...publicAttribution(row), description: rowDescription(row), possible_own_transfer: pairing.candidateRows.has(row.id) });
  const payerLine = row => {
    if (row.direction !== 'inflow') return '';
    const attribution = publicAttribution(row);
    return attribution.attribution_state === 'unknown' ? `; payer: Unattributed${attribution.payer_candidates?.length ? ` (candidate readings: ${attribution.payer_candidates.join('; ')})` : ''}` : '';
  };
  const rowLine = row => `${money(row.amount_minor)} on ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${rowDescription(row)}${payerLine(row)}${candidateMark(row)} ${refs([row])}`;
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
    // A literal selector with no rows proves only a nonmatch, not a complete
    // zero: statement spellings and categories may differ from the question.
    // Decide on the covered gross rows before any optional exclusions.
    if (intent.match && !matched.length && (intent.direction === 'outflow' || intent.kind === 'category')) {
      const selector = safeDescription(intent.match);
      const detail = 'The merchant may appear under a different name on statements.';
      return { answer: `No matching transactions were found for ${selector} in the covered accounts.\n${bounded}\n${detail}`,
        citations, ledger: { ...ledger, found: false, total_minor: null, lead_total_minor: null,
          total_is_exact: false, groups: [], if_own_transfers: { ...ledger.if_own_transfers, total_minor: null } },
        gaps: [{ type: 'ledger_selector_unmatched', reason: 'statement_name_unconfirmed', detail }],
        evidence_gate: { supported: true, complete: false, partial: true, reason: 'statement_name_unconfirmed' } };
    }
    const unsorted = (intent.kind === "category" ? directionRows : matched).filter(row => !categoryFor(row));
    // Exclusions cannot turn an assumed payer reading into a certified zero,
    // including conditional transfer totals. Keep the supported gross figure.
    const hasShorthand = namedIncome && matched.some(row => payers.get(row.id)?.state === 'assumed');
    const scopeConfirmed = selection.exact || inflowScopeConfirmed(rows, payers);
    const payerTotal = (list, payerFigure = Boolean(namedIncome)) => {
      const total = sumMinor(list);
      const displayed = payerFigure ? payerAmount(total, scopeConfirmed) : total;
      if (displayed === null) payerZeroUnknown = true;
      return displayed;
    };
    const totalText = total => total === null ? 'not confirmed' : money(total);
    ledger.total_minor = payerTotal(matched);
    if (selection.exact) ledger.total_is_exact = true;
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
  const payerEvidence = namedIncome && selection.exactRows ? [...attributedRows.values()].filter(row =>
    selection.exactRows.has(row.id) && payers.get(row.id)?.state === 'observed').map(row => {
      const attribution = payers.get(row.id), identity = safeDescription(attribution.reading.identity);
      const bank = attribution.evidence.source === 'payee';
      answer += bank ? `\nYour bank lists the payer as ${identity} [${cite(row).n}].`
        : `\nThe statement line names ${identity} as sender [${cite(row).n}].`;
      return { type: bank ? 'bank_payee' : 'statement_sender', identity, citations: [cite(row).n] };
    }) : [];
  return withPayerAssumptions({ answer, citations, ledger, ...uncertainty,
    ...(payerEvidence.length ? { payer_evidence: payerEvidence } : {}) }, [...attributedRows.values()], payers);
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
          ...(answer.payer_evidence?.length ? { payer_evidence: answer.payer_evidence } : {}),
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
