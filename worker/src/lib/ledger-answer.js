import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion, ledgerDay, shiftLedgerDay } from "./ledger-question.js";
import { effectivePeriodCovered, readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions } from "./ledger-reader.js";
import { categoryFor, detectRecurring, excludeMatchedTransfers, matchesCategory, matchesMerchant, merchantFor, pairOwnTransfers, sumMinor } from "./ledger-analysis.js";

const masked = account => /^\d{1,4}$/.test(account.mask || "") ? `account ****${account.mask}` : "account (mask unavailable)";
const money = cents => `${cents < 0 ? "-" : ""}$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const safeDescription = text => String(text || "Deposit").replace(/\d(?:[\s-]*\d){4,}/g, "[redacted]").slice(0, 240);
const accountCoverage = accounts => accounts.map(a => ({
  account_mask: /^\d{1,4}$/.test(a.mask || "") ? a.mask : null,
  covered_to: a.covered_to || null, last_synced_at: a.last_synced_at || null,
}));

function gapFor(reason, accounts = [], intent = {}) {
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
const usableAccount = a => !a.ambiguous && a.currency === "USD" && a.members.every(m => m.basis_state === "confirmed");

async function ledgerAnswer(env, intent, accounts, inventory) {
  if (intent.kind === "balance") {
    const balances = await readEffectiveBalances(env, accounts, intent);
    if (balances.length !== accounts.length || balances.some(b => b.basis_state !== "confirmed" ||
      !Number.isSafeInteger(b.current_minor) || b.currency !== "USD")) return { reason: "balance_unavailable" };
    const citations = balances.map((row, i) => citation(row, accounts.find(a => a.account_slug === row.effective_account_slug), i, true));
    return { answer: balances.map((row, i) => `${masked(accounts.find(a => a.account_slug === row.effective_account_slug))}: ${money(row.current_minor)} as of ${row.as_of_date} [${i + 1}].`).join("\n"),
      citations, ledger: { kind: "balance", accounts: citations.map(c => ({ account_mask: c.account_mask, current_minor: c.amount_minor, as_of: c.posted_on })) } };
  }
  if (accounts.some(a => !effectivePeriodCovered(a, intent.from, intent.to))) return { reason: "period_outside_coverage" };
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
  if (rows.some(row => !readableRow(row))) return { reason: "unreadable_transactions" };
  const bySlug = new Map(inventory.map(a => [a.account_slug, a]));
  if (intent.kind === "payment") {
    const matched = rows.filter(row => {
      const words = new Set(`${row.description || ""} ${row.payee || ""}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
      return intent.counterpartyWords.every(word => words.has(word));
    });
    const citations = matched.map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i));
    const answer = matched.length
      ? matched.map((row, i) => `Found a deposit of ${money(row.amount_minor)} posted ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description)} [${i + 1}].`).join("\n")
      : `No matching deposit in ${accounts.map(masked).join(", ")} between ${intent.from} and ${intent.to}; the bank feed covers through ${accounts.map(a => `${masked(a)}: ${a.live?.covered_to || "unknown (manual records only)"}`).join("; ")}.`;
    return { answer, citations, ledger: { kind: "payment", found: matched.length > 0,
      from: intent.from, to: intent.to, amount_minor: intent.amountMinor, accounts: accountCoverage(accounts) } };
  }
  const eligible = allRows.filter(row => readableRow(row) && usableAccount(bySlug.get(row.effective_account_slug)) &&
    effectivePeriodCovered(bySlug.get(row.effective_account_slug), row.posted_on, row.posted_on));
  const pairing = pairOwnTransfers(eligible);
  const pairs = pairing.pairs.filter(pair => [pair.out, pair.in].some(row => selected.has(row.effective_account_slug) && inWindow(row)));
  const unmatched = pairing.unmatched.filter(row => selected.has(row.effective_account_slug) && inWindow(row));
  const activity = excludeMatchedTransfers(rows, pairing.matched);
  const citations = [], references = new Map();
  const cite = row => {
    if (!references.has(row.id)) {
      const ref = citation(row, bySlug.get(row.effective_account_slug), citations.length);
      references.set(row.id, ref); citations.push(ref);
    }
    return references.get(row.id);
  };
  const refs = list => list.map(row => `[${cite(row).n}]`).join(" ");
  const publicRow = row => ({ ...cite(row), description: safeDescription(row.description || row.payee || "Transaction") });
  const rowLine = row => `${money(row.amount_minor)} on ${row.posted_on} in ${masked(bySlug.get(row.effective_account_slug))}: ${safeDescription(row.description || row.payee || "Transaction")} ${refs([row])}`;
  const bounded = `Accounts: ${accounts.map(masked).join(", ")}; ${intent.from} through ${intent.to}; ${accounts.map(a => `${masked(a)}: covered through ${a.covered_to || "unknown"}`).join("; ")}.`;
  const ledger = { kind: intent.kind, from: intent.from, to: intent.to, accounts: accountCoverage(accounts),
    includes_own_transfers: false, matched_transfer_count: pairs.length };
  let answer;
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
  } else if (["largest", "deposits"].includes(intent.kind)) {
    const found = activity.filter(row => row.direction === intent.direction).sort((a, b) =>
      (intent.kind === "largest" ? b.amount_minor - a.amount_minor : b.posted_on.localeCompare(a.posted_on)) || a.id - b.id);
    const listed = intent.limit ? found.slice(0, intent.limit) : found;
    ledger.found = listed.length > 0; ledger.rows = listed.map(publicRow);
    answer = listed.length ? listed.map(rowLine).join("\n") : `No ${intent.direction === "inflow" ? "deposits" : "expenses"} found.`;
  } else if (["merchant", "category"].includes(intent.kind)) {
    const directionRows = activity.filter(row => row.direction === intent.direction);
    const matched = intent.match ? directionRows.filter(row => (intent.kind === "merchant" ? matchesMerchant : matchesCategory)(row, intent.match)) : directionRows;
    const unsorted = (intent.kind === "category" ? directionRows : matched).filter(row => !categoryFor(row));
    ledger.total_minor = sumMinor(matched); ledger.unsorted_minor = sumMinor(unsorted); ledger.found = matched.length > 0;
    const groups = new Map();
    for (const row of matched) {
      const label = intent.kind === "category" ? categoryFor(row) : merchantFor(row) || "unknown merchant";
      if (intent.kind === "category" && !label) continue;
      const state = intent.kind === "category" ? row.category_basis_state : null;
      const key = JSON.stringify([label, state]);
      if (!groups.has(key)) groups.set(key, { label, state, rows: [] });
      groups.get(key).rows.push(row);
    }
    ledger.groups = [...groups.values()].map(g => ({ [intent.kind]: safeDescription(g.label),
      category_basis_state: g.state, total_minor: sumMinor(g.rows), citations: g.rows.map(row => cite(row).n) }));
    answer = `Total ${intent.direction === "inflow" ? "income" : "spend"}${intent.match ? ` for ${safeDescription(intent.match)}` : ` by ${intent.kind}`}: ${money(ledger.total_minor)}.`;
    if (!matched.length) answer += " No matching transactions found.";
    for (const g of groups.values()) answer += `\n${safeDescription(g.label)}${g.state === "proposed" ? " (bank's category (unconfirmed))" : ""}: ${money(sumMinor(g.rows))} ${refs(g.rows)}.`;
    answer += `\nUnsorted: ${money(ledger.unsorted_minor)}${intent.kind === "category" && intent.match && !matched.some(row => !categoryFor(row)) ? " (separate from the requested category)" : ""} ${refs(unsorted)}.`;
  } else if (intent.kind === "transfers") {
    // A transfer total is counted once by the outgoing posting date. A credit
    // crossing the window edge is still excluded from that window's income.
    const outgoing = pairs.filter(pair => inWindow(pair.out));
    ledger.total_minor = sumMinor(outgoing, pair => pair.out.amount_minor);
    ledger.found = outgoing.length > 0;
    answer = outgoing.length ? `Matched transfers: ${money(ledger.total_minor)}, counted once by outgoing posting date.` : "No matched transfers found by outgoing posting date.";
  } else if (intent.kind === "recurring") {
    const recurring = detectRecurring(activity, intent.to);
    ledger.recurring = recurring.map(g => ({ merchant: safeDescription(g.merchant), cadence: g.cadence,
      typical_minor: g.typical_minor, monthly_minor: g.monthly_minor, last_charge: g.last_charge,
      last_amount_minor: g.rows.at(-1).amount_minor, occurrence_count: g.rows.length, detected: true,
      citations: g.rows.map(row => cite(row).n) }));
    ledger.monthly_total_minor = sumMinor(recurring, g => g.monthly_minor); ledger.found = recurring.length > 0;
    answer = "Recurring charges detected, not confirmed. " + (recurring.length ? recurring.map(g =>
      `${safeDescription(g.merchant)}: ${g.cadence}, typical ${money(g.typical_minor)}; last charge ${money(g.rows.at(-1).amount_minor)} on ${g.last_charge} ${refs(g.rows)}.`).join("\n") : "No recurring charges detected.");
    answer += `\nEstimated monthly total: ${money(ledger.monthly_total_minor)} (weekly amounts use 52/12, rounded to cents per merchant).`;
  } else throw new Error("unsupported ledger intent");
  ledger.transfers = pairs.map(pair => ({ amount_minor: pair.out.amount_minor, outgoing: publicRow(pair.out), incoming: publicRow(pair.in) }));
  ledger.unmatched_transfers = unmatched.map(publicRow);
  answer += `\n${bounded}\nThis answer excludes ${pairs.length} matched transfers between your accounts from income and spend.`;
  for (const pair of pairs) answer += `\nMatched transfer: ${rowLine(pair.out)}; received ${rowLine(pair.in)}.`;
  for (const row of unmatched) answer += `\nPossible transfer, unmatched (retained in income/spend totals): ${rowLine(row)}.`;
  return { answer, citations, ledger };
}

// The only integration point wraps the existing document path. Non-money
// responses return untouched, including their exact serialized bytes.
export async function withLedgerAnswer({ env, question, access, grantScope, scopePrincipalKind,
  filters = {}, entityScope, ledgerEligible = true, now = Date.now() }, next) {
  const intent = classifyLedgerQuestion(question, { now });
  if (!intent.broad) return next(null);
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
      let reason = !accounts.length ? "no_accounts" : accounts.some(a => a.ambiguous || a.members.some(m => m.basis_state !== "confirmed")) ||
        (intent.mask && accounts.length !== 1) ? "ambiguous_account" :
        accounts.some(a => a.currency !== "USD") ? "unsupported_currency" : !intent.kind ? "unsupported_question" : null;
      if (!reason) {
        const answer = await ledgerAnswer(env, intent, accounts, inventory);
        reason = answer.reason;
        if (!reason) return new Response(JSON.stringify({ mode: "think", answer: answer.answer,
          citations: answer.citations, results: [], gaps: [], ledger: answer.ledger,
          evidence_gate: { supported: true, complete: true, reason: "read from covered ledger rows" } }),
        { headers: { "Content-Type": "application/json" } });
      }
      gap = gapFor(reason, accounts, intent);
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
