import { scopeIsUnrestricted } from "./grants.js";
import { classifyLedgerQuestion } from "./ledger-question.js";
import { effectivePeriodCovered, readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions } from "./ledger-reader.js";

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

async function ledgerAnswer(env, intent, accounts) {
  if (intent.kind === "balance") {
    const balances = await readEffectiveBalances(env, accounts, intent);
    if (balances.length !== accounts.length || balances.some(b => b.basis_state !== "confirmed" ||
      !Number.isSafeInteger(b.current_minor) || b.currency !== "USD")) return { reason: "balance_unavailable" };
    const citations = balances.map((row, i) => citation(row, accounts.find(a => a.account_slug === row.effective_account_slug), i, true));
    return { answer: balances.map((row, i) => `${masked(accounts.find(a => a.account_slug === row.effective_account_slug))}: ${money(row.current_minor)} as of ${row.as_of_date} [${i + 1}].`).join("\n"),
      citations, ledger: { kind: "balance", accounts: citations.map(c => ({ account_mask: c.account_mask, current_minor: c.amount_minor, as_of: c.posted_on })) } };
  }
  if (accounts.some(a => !effectivePeriodCovered(a, intent.from, intent.to))) return { reason: "period_outside_coverage" };
  const rows = await readEffectiveTransactions(env, accounts, intent);
  if (rows.some(row => row.basis_state !== "confirmed" || !row.posted_on ||
    !Number.isSafeInteger(row.amount_minor) || row.currency !== "USD" || !["inflow", "outflow"].includes(row.direction))) {
    return { reason: "unreadable_transactions" };
  }
  const bySlug = new Map(accounts.map(a => [a.account_slug, a]));
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
  const totals = accounts.map(account => {
    const ownRows = rows.filter(row => row.effective_account_slug === account.account_slug);
    let credits = 0, debits = 0;
    for (const row of ownRows) {
      if (row.direction === "inflow") credits += row.amount_minor;
      else debits += row.amount_minor;
      if (!Number.isSafeInteger(credits) || !Number.isSafeInteger(debits)) throw new Error("ledger total overflow");
    }
    return { account_mask: account.mask, credits_minor: credits, debits_minor: debits, transaction_count: ownRows.length };
  });
  const citations = rows.map((row, i) => citation(row, bySlug.get(row.effective_account_slug), i));
  const answer = totals.map((total, i) => {
    const refs = rows.map((row, n) => row.effective_account_slug === accounts[i].account_slug ? `[${n + 1}]` : "").filter(Boolean).join(" ");
    return `${masked(accounts[i])}, ${intent.from} through ${intent.to}: credits ${money(total.credits_minor)}; debits ${money(total.debits_minor)}${refs ? ` ${refs}` : " (no posted transactions in the covered period)"}.`;
  }).join("\n") + "\nThese totals include transfers between your own accounts; transfer pairing is not available yet.";
  return { answer, citations, ledger: { kind: "totals", from: intent.from, to: intent.to, accounts: totals, includes_own_transfers: true } };
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
      accounts = await readEffectiveAccounts(env);
      if (intent.mask) accounts = accounts.filter(a => a.mask === intent.mask);
      if (intent.accountKind) accounts = accounts.filter(a => a.account_kind === intent.accountKind);
      let reason = !accounts.length ? "no_accounts" : accounts.some(a => a.ambiguous || a.members.some(m => m.basis_state !== "confirmed")) ||
        (intent.mask && accounts.length !== 1) ? "ambiguous_account" :
        accounts.some(a => a.currency !== "USD") ? "unsupported_currency" : !intent.kind ? "unsupported_question" : null;
      if (!reason) {
        const answer = await ledgerAnswer(env, intent, accounts);
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
