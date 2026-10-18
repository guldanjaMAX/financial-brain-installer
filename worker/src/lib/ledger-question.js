// Exported inventory is checked against parser kinds and attribution coverage.
export const LEDGER_ANSWER_KINDS = Object.freeze([
  'balance', 'payment', 'totals', 'largest', 'deposits', 'merchant', 'category', 'transfers', 'recurring',
]);

// The grammar is deliberately bounded. Unsupported money questions use the
// ordinary document path without imposing unrelated account-link decisions.
const MONTHS = "january february march april may june july august september october november december".split(" ");
const MONTH = `(${MONTHS.join("|")})`;
const DAY_MS = 86400000;
const GENERIC_SENDERS = new Set("bank payment payments deposit transfer money the my our a an account company client customer someone them".split(" "));
const ledgerWords = text => text.match(/[\p{L}\p{N}]+/gu) || [];
function specificSender(text, bounded = true) {
  const words = ledgerWords(text);
  return (!bounded || (text.length <= 80 && words.length <= 6)) && words.some(word => /\p{L}/u.test(word) && !GENERIC_SENDERS.has(word)) &&
    !/\b(?:second|first|third|next|last|another|other|loan|car|tax)\b/.test(text);
}
export const ledgerDay = (value) => new Date(value).toISOString().slice(0, 10);
export const shiftLedgerDay = (day, delta) => ledgerDay(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS);

function calendarDay(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return Number.isFinite(Date.parse(value)) && ledgerDay(value) === value ? value : null;
}

function amountInCents(text) {
  const matches = [...text.matchAll(/(?:\$|\busd\s+)(\d[\d,]*(?:\.\d+)?)(?!\d)|\b(\d[\d,]*(?:\.\d+)?)\s+dollars?\b/gi)];
  if (matches.length !== 1) return null;
  const decimal = matches[0][1] || matches[0][2];
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(decimal)) return null;
  const [whole, fraction = ""] = decimal.replaceAll(",", "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

// Exactly one supported period is removed. Unconsumed qualifiers still have
// to match a bounded intent grammar, so a second scope cannot become a total.
function questionPeriod(q, today) {
  const pattern = new RegExp(`\\b(?:${MONTHS.join("|")})(?:\\s+\\d{4})?\\b|\\bq[1-4](?:\\s+\\d{4})?\\b|\\blast\\s+\\d+\\s+days\\b|\\b(?:last|this) month\\b|\\bso far this year\\b|\\b\\d{4} so far\\b|\\brecent\\b`, "g");
  const matches = [...q.matchAll(pattern)];
  // "Recent deposits in September" has one explicit period; recent is a
  // listing modifier there. It supplies the 14-day default only on its own.
  const periods = matches.some(m => m[0] !== "recent") ? matches.filter(m => m[0] !== "recent") : matches;
  if (periods.length > 1) return { invalid: true };
  let from, to, residual = q.trim().replace(/[?!.]+$/, "").trim();
  if (periods.length) {
    const period = periods[0][0], parts = period.split(/\s+/);
    const year = Number(parts[1]) || Number(today.slice(0, 4));
    if (MONTHS.includes(parts[0])) {
      const month = MONTHS.indexOf(parts[0]);
      from = ledgerDay(Date.UTC(year, month, 1)); to = ledgerDay(Date.UTC(year, month + 1, 0));
      // A question in the current named month asks about posted activity so
      // far. State the bounded end; future months remain outside coverage.
      if (from.slice(0, 7) === today.slice(0, 7)) to = today;
    } else if (/^q[1-4]$/.test(parts[0])) {
      const month = (Number(parts[0][1]) - 1) * 3;
      from = ledgerDay(Date.UTC(year, month, 1)); to = ledgerDay(Date.UTC(year, month + 3, 0));
    } else if (["last month", "this month"].includes(period)) {
      const date = new Date(`${today}T00:00:00Z`);
      const month = date.getUTCMonth() - (period === "last month" ? 1 : 0);
      from = ledgerDay(Date.UTC(date.getUTCFullYear(), month, 1));
      to = period === "this month" ? today : ledgerDay(Date.UTC(date.getUTCFullYear(), month + 1, 0));
    } else if (period === "so far this year" || /^\d{4} so far$/.test(period)) {
      const selectedYear = period === "so far this year" ? today.slice(0, 4) : parts[0];
      if (selectedYear !== today.slice(0, 4)) return { invalid: true };
      from = `${selectedYear}-01-01`; to = today;
    } else if (period === "recent") {
      from = shiftLedgerDay(today, -13); to = today;
    } else if (Number(parts[1]) >= 1 && Number(parts[1]) <= 3660) {
      from = shiftLedgerDay(today, 1 - Number(parts[1])); to = today;
    }
    if (!from || !to) return { invalid: true };
    residual = residual.replace(new RegExp(`(?:\\b(?:in|during|for|over)\\s+(?:the\\s+)?)?${period}\\b`), "").trim();
  }
  return { from, to, residual, period: periods[0]?.[0] };
}

function phaseTwoQuestion(q, intent, today) {
  const period = questionPeriod(q, today);
  if (period.invalid) return null;
  let { from, to, residual } = period;
  // Account clauses are explicit and literal. A named bank or entity cannot
  // be consumed as filler, nor can a merchant named "card" select card accounts.
  const selected = residual.match(/\b(?:in|for|of|into)\s+(?:(?:my|the)\s+)?(?:(checking|savings|card|loan|investment|retirement|escrow)\s+)?account\s+(?:ending(?:\s+in)?\s+)?(\d{1,4})\b/);
  if (selected) residual = residual.replace(selected[0], "");
  residual = residual.replace(/,/g, "").replace(/\s+/g, " ").trim();
  const result = { ...intent, mask: selected?.[2] || null, accountKind: selected?.[1] || null, from, to };
  const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const count = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  const largest = residual.match(new RegExp(`^(?:(?:what (?:were|are)|show(?: me)?|list) )?(?:my |the )?(?:${count} (?:largest|biggest)|(?:largest|biggest|top)(?: ${count})?) (expenses|charges|deposits)$`));
  if (largest && from) {
    const requested = largest[1] || largest[2];
    const limit = requested ? numberWords[requested] || Number(requested) : 10;
    return limit >= 1 && limit <= 100 ? { ...result, kind: "largest", limit, direction: largest[3] === "deposits" ? "inflow" : "outflow" } : null;
  }
  if (from && /^(?:(?:what|which) deposits came in|(?:what (?:were|are)|show(?: me)?|list) (?:my |the )?(?:recent )?deposits)$/.test(residual)) {
    return { ...result, kind: "deposits", direction: "inflow" };
  }
  if (from && /^(?:how much did (?:i|we) transfer between (?:my|our) (?:own )?accounts|(?:show(?: me)?|list) (?:my |our )?(?:own[- ]account )?transfers(?: between (?:my|our) (?:own )?accounts)?)$/.test(residual)) {
    return { ...result, kind: "transfers" };
  }
  if (/^(?:what recurring (?:subscriptions|charges) am i paying for(?: and how much per month)?|(?:show(?: me)?|list|what are) (?:my )?(?:recurring (?:subscriptions|charges)|subscriptions)(?: and (?:the|their) monthly total)?)$/.test(residual)) {
    return { ...result, kind: "recurring", from: from || shiftLedgerDay(today, -119), to: to || today, direction: "outflow" };
  }
  if (from && /^(?:(?:what (?:was|is)|show(?: me)?) (?:my )?spending (?:by category|top categories)|what (?:were|are) my top spending categories)$/.test(residual)) {
    return { ...result, kind: "category", direction: "outflow", match: null, ranked: /\btop\b/.test(residual) };
  }
  // Short noun-first requests retain the same merchant/category attribution as
  // the existing "spend at/on" forms. Only software/SaaS is a category alias.
  const nounSpend = residual.match(/^(?:show(?: me)?|what (?:was|is)) (?:my )?(.+?) spend(?:ing)?$/);
  if (nounSpend) {
    const name = nounSpend[1];
    if (name.length > 80 || ledgerWords(name).length > 6 || !/\p{L}/u.test(name) ||
        !/^[\p{L}\p{N}\s&/.'-]+$/u.test(name) ||
        /\b(?:my|our|the|income|versus|vs|business|entity|money|cash|accounts?|largest|biggest|top|total|net|how|what|much|very)\b/.test(name) ||
        // A lone past-participle ("authorized", "allocated") qualifies spending;
        // it is not a merchant. Those questions stay with documents.
        (ledgerWords(name).length === 1 && /ed$/.test(name))) return null;
    residual = `show spending ${/^(?:software|saas|software\/saas)$/.test(name) ? "on" : "at"} ${name}`;
  }
  const spending = residual.match(/^(?:how much did (?:i|we) spend|(?:show(?: me)? |what is (?:my |the )?)spend(?:ing)?)(?: (at|on|by) (.+))$/);
  const income = residual.match(/^(?:how much income(?: came)?|how much did (?:i|we) receive|(?:show(?: me)? |what is (?:my |the )?)income) (from|by|in category) (.+)$/);
  const filter = spending || income;
  if (filter && from) {
    const direction = spending ? "outflow" : "inflow";
    const mode = filter[1], value = filter[2].trim();
    if (/\b(?:in|during|for|over|between|before|after|account|accounts|entity|or|last|month|year|q[1-4])\b/.test(value) ||
        (mode !== "at" && mode !== "from" && /\band\b/.test(value))) return null;
    if (mode === "by") return ["merchant", "category"].includes(value) ? { ...result, kind: value, direction, match: null } : null;
    if (!/[\p{L}\p{N}]/u.test(value)) return null;
    return { ...result, kind: ["at", "from"].includes(mode) ? "merchant" : "category", direction, match: value };
  }
  return null;
}

const ARRIVAL = "arrive|arrived|receive|received|come|came|land|landed|hit|reach|reached|clear|cleared|post|posted";
function paymentParties(text) {
  const clause = preposition => text.match(new RegExp(`\\b${preposition}\\s+(.+?)(?=\\s+(?:on|into|to|in|for|from|via|${ARRIVAL})\\b|[?,]|$)`));
  // A payer ending in "payment" after FROM must not also be consumed as a
  // noun-first payer, duplicating the clause and certifying a false nonmatch.
  const namedPayment = /^(?:did|has|have)\s+(?:(?:the|my|our|a|an)\s+)?payment\s+(?:from|via)\b/.test(text) ? null
    : text.match(/^(?:did|has|have)\s+(?:(?:the|my|our|a|an)\s+)?([\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+){0,3})\s+payment\b/u);
  const named = namedPayment && !/^(?:the|my|our|a|an)$/.test(namedPayment[1]) ? namedPayment[1] : "";
  return { partyMatch: clause("from"), viaMatch: clause("via"), namedPayment, named };
}

function classifyQuestionGrammar(question, { now = Date.now(), selectorSlot = false } = {}) {
  let q = String(question || "").normalize("NFKC").toLowerCase().replace(/[’]/g, "'").replace(/\bwhat's\b/g, "what is");
  const broad = /\b(?:money|cash|profit|bank|deposits?|expenses?|charges?|subscriptions|recurring (?:charges|subscriptions)|payment|paid|spend|spent|spending|income|revenue|credits?|debits?|transactions?|transfers?|checking|savings|loan|debt|tax|payroll|invoice|receivable|payable|came in|went out)\b|\$\s*\d/.test(q) || /\b(?:(?:my|our|account|card|bank|checking|savings|loan|current|available|outstanding)\s+balances?|balances?\s+(?:of|on|in|for|due))\b/.test(q);
  const base = { broad: broad || selectorSlot, kind: null };
  if (!broad && !selectorSlot) return base;
  // Consume only these bounded clause families. Duplicate or conflicting
  // clauses refuse; the remaining grammar still has to consume every word.
  // Strip before account selection so "investment withdrawals" is not a kind.
  const transfers = [...q.matchAll(/(?:,\s*)?\b(excluding|without|not counting|including) (?:my |our )?(?:own )?transfers(?: between (?:my|our) (?:own )?accounts)?\b/g)];
  const withdrawals = [...q.matchAll(/(?:,\s*)?\bincluding (?:retirement |investment )?withdrawals\b/g)];
  const loanProceeds = [...q.matchAll(/(?:,\s*)?\bincluding loan proceeds\b/g)];
  // Like transfer flips, the owner repeats the scoped question with this
  // qualifier. Do not silently widen an unsupported standalone follow-up.
  const exactNames = q.match(/,?\s+exact names only(?=[?!.]*$)/);
  if (exactNames) q = q.replace(exactNames[0], '');
  if (transfers.length > 1 || withdrawals.length > 1 || loanProceeds.length > 1) return base;
  const flags = {};
  if (transfers.length) { flags.ownTransfers = transfers[0][1] === "including" ? "include" : "exclude"; q = q.replace(transfers[0][0], ""); }
  if (withdrawals.length) { flags.withdrawals = "include"; q = q.replace(withdrawals[0][0], ""); }
  if (loanProceeds.length) { flags.loanProceeds = "include"; q = q.replace(loanProceeds[0][0], ""); }
  q = q.replace(/\s+/g, " ").trim();
  const today = ledgerDay(now);
  let scopeText = q;
  if (/\b(?:payment|deposit|paid)\b/.test(q) && new RegExp(`\\b(?:${ARRIVAL})\\b`).test(q)) {
    const { partyMatch, viaMatch, namedPayment, named } = paymentParties(q);
    for (const match of [partyMatch, viaMatch, named ? namedPayment : null]) if (match) scopeText = scopeText.replace(match[0], "");
  }
  const maskMatches = [...scopeText.matchAll(/(?:\*{2,}|ending(?:\s+in)?\s+|mask\s+|account\s+)(\d{1,4})\b/g)];
  const masks = [...new Set(maskMatches.map(m => m[1]))];
  if (masks.length > 1) return base;
  const kinds = [...new Set(scopeText.match(/\b(?:checking|savings|card|loan|investment|retirement|escrow)\b/g) || [])];
  const selector = { mask: masks[0] || null, accountKind: kinds.length === 1 ? kinds[0] : null };
  const intent = { ...base, ...selector, ...flags, ...(exactNames ? { exactNamesOnly: true } : {}) };
  const withoutMasks = text => maskMatches.reduce((rest, match) => rest.replace(match[0], ""), text);
  const punctuationOnly = text => !text.replace(/[?'.,:]/g, "").trim();
  if (kinds.length > 1) return intent;
  // These qualifiers require a different source or a richer financial model.
  if (/\b(?:quickbooks|qbo|tax|excluding|exclude|without|except|including|not counting|budgeted|budget|approved|authori[sz]ed|allocated|proposed|committed|permitted|planned|projected|expected|estimated|forecast|target|allowed|average|median|smallest|interest)\b/.test(q)) return intent;
  if (/\b(?:profit|net income|cash flow)\b/.test(q)) {
    const period = questionPeriod(q, today);
    if (period.invalid || !period.from || !period.to) return intent;
    const residual = period.residual.replace(/\s+/g, " ").trim();
    const form = residual.match(/^(?:what (?:was|is|were) (?:my|our|the) (profit|net income|cash flow)|how much (profit) did (?:i|we) make)(?: (?:for|in|of) (?:(?:my|our|the) )?(?:(checking|savings|card|loan|investment|retirement|escrow) )?account(?: (?:ending(?: in)? |mask )?(\d{1,4}))?)?$/);
    if (!form) return intent;
    return { ...intent, kind: "totals", measure: (form[1] || form[2]).replaceAll(" ", "_"),
      from: period.from, to: period.to };
  }
  const phaseTwo = phaseTwoQuestion(q, intent, today);
  if (phaseTwo) return phaseTwo.kind === "transfers" && Object.keys(flags).length ? intent : phaseTwo;
  if (/\b(?:balance|balances)\b/.test(q)) {
    if (Object.keys(flags).length) return intent;
    // Do not replace a named bank/entity or a historical balance with all accounts.
    const residual = withoutMasks(q).replace(/\b(?:what|is|are|my|our|the|current|latest|bank|account|accounts|balance|balances|checking|savings|card|loan|investment|retirement|escrow|per|each|show|me|please|today|now|ending|in|mask|for|all)\b/g, "");
    return punctuationOnly(residual) ? { ...intent, kind: "balance" } : intent;
  }
  if (/\b(?:payment|deposit|paid)\b/.test(q) && /\b(?:arrive|arrived|received|receive|come|came|land|landed|hit|reach|reached|clear|cleared|post|posted)\b/.test(q)) {
    if (Object.keys(flags).length) return intent;
    const amountMinor = amountInCents(q);
    if (amountMinor === null && /\$|\busd\b|\bdollars?\b/.test(q)) return intent;
    const dates = [];
    let rest = withoutMasks(q);
    const date = (match, day) => { dates.push(day); rest = rest.replace(match[0], ""); };
    for (const m of q.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) date(m, calendarDay(m[1], m[2], m[3]));
    for (const m of q.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "g"))) {
      date(m, calendarDay(m[3] || today.slice(0, 4), MONTHS.indexOf(m[1]) + 1, m[2]));
    }
    for (const m of q.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`, "g"))) {
      date(m, calendarDay(m[3], MONTHS.indexOf(m[2]) + 1, m[1]));
    }
    for (const m of q.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) date(m, calendarDay(m[3], m[1], m[2]));
    if (dates.some(d => !d) || new Set(dates).size > 1) return intent;
    const period = dates.length ? { residual: rest } : questionPeriod(rest, today);
    if (period.invalid) return intent;
    // A bare month still cannot date an exact payment. Keep the original
    // ambiguity control; an explicit year or relative bounded window is needed.
    if (period.period && MONTHS.includes(period.period)) return intent;
    rest = period.residual;
    if (dates.length && /\b(?:before|after|between)\b/.test(rest)) return intent;
    if (!dates.length && !period.from && /\b(?:on|between|before|after|yesterday|tomorrow|last|this)\b/.test(rest)) return intent;
    const arrival = ARRIVAL;
    const { partyMatch, viaMatch, namedPayment, named } = paymentParties(rest);
    // Apply one specificity rule to every sender form. Generic-only clauses
    // cannot identify an amountless payment; keep all words in specific names
    // so rejecting generic narration never widens a query to every deposit.
    const parties = [named, viaMatch?.[1], partyMatch?.[1]].filter(Boolean);
    // An amount does not establish which ordinal payment was meant, and a
    // generic adjective must not become sender evidence by being consumed.
    if (named && !specificSender(named)) return intent;
    if (amountMinor === null && (!parties.length || parties.some(party => !specificSender(party)))) return intent;
    const counterparty = parties.join(" ");
    if (partyMatch) rest = rest.replace(partyMatch[0], "");
    if (viaMatch) rest = rest.replace(viaMatch[0], "");
    if (named) rest = rest.replace(namedPayment[0], "payment");
    rest = rest.replace(/(?:\$|\busd\s+)\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s+dollars?\b/g, "")
      .replace(/,?\s+and when\b/g, "")
      .replace(new RegExp(`\\b(?:did|has|have|was|is|the|a|my|our|payment|deposit|of|paid|${arrival}|yet|on|in|into|to|account|bank|checking|savings|card|loan|investment|retirement|escrow|ending|mask|please)\\b`, "g"), "");
    if (!punctuationOnly(rest)) return intent;
    const counterpartyWords = counterparty.match(/[\p{L}\p{N}]+/gu) || [];
    if (amountMinor === null && !counterpartyWords.length) return intent;
    return { ...intent, kind: "payment", amountMinor, counterpartyWords, counterparty,
      ...(selectorSlot ? { selectorSlotParts: parties } : {}),
      from: dates.length ? shiftLedgerDay(dates[0], -7) : period.from || shiftLedgerDay(today, amountMinor === null ? -59 : -29),
      to: dates.length ? shiftLedgerDay(dates[0], 7) : period.to || today };
  }
  if (/\b(?:money|cash|came in|went out|income|spend|spent|spending|expenses?|credits?|debits?|inflow|outflow)\b/.test(q)) {
    const { from, to, residual: rest, invalid } = questionPeriod(withoutMasks(q), today);
    if (invalid || !from || !to) return intent;
    const residual = rest.replace(/\b(?:how|much|money|cash|came|come|in|into|of|and|or|went|go|out|income|spend|spent|spending|expenses?|credits?|debits?|inflow|outflow|did|i|we|what|was|were|is|are|the|total|totals|my|our|account|accounts|bank|checking|savings|card|loan|investment|retirement|escrow|by|per|each|all|during|for|over|show|me|please)\b/g, "");
    if (punctuationOnly(residual)) return { ...intent, kind: "totals", from, to };
  }
  return intent;
}

// Protect a whole selector BEFORE the intent grammar removes periods, account
// words or punctuation. Reusing that grammar with an opaque slot keeps every
// supported question form in one place. All successful boundaries survive;
// the snapshot registry, not a longest/first-match heuristic, decides identity.
export function classifyLedgerQuestion(question, { now = Date.now() } = {}) {
  const options = { now };
  if (String(question || '').length > 1024) return { broad: true, kind: null };
  const original = classifyQuestionGrammar(question, options);
  const text = String(question || '').normalize('NFKC').toLowerCase().replace(/’/g, "'")
    .replace(/\bwhat's\b/g, 'what is').replace(/\s+/g, ' ').trim();
  const starts = [...text.matchAll(/\b(?:from|via) +/g)].map(m => m.index + m[0].length);
  const noun = text.match(/^(?:did|has|have) +(?:(?:the|my|our|a|an) +)?/);
  if (noun) starts.push(noun[0].length);
  if (!starts.length) return original;
  // Bounds apply before the quadratic span enumeration. Refuse overflow,
  // including an otherwise valid shorter selector, rather than prune readings.
  if (text.length > 512 || starts.length > 12 || /[\p{Cc}\p{Cf}]/u.test(String(question || '')))
    return { broad: original.broad, kind: null };
  const slot = 'selectorplaceholder';
  if (text.includes(slot)) return { broad: original.broad, kind: null };
  const readings = [];
  for (const start of starts) {
    for (let end = start + 1; end <= text.length; end++) {
      if (end < text.length && !/[ ,?!.]/.test(text[end])) continue;
      const label = text.slice(start, end);
      if (!/^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M} &'()._/:#,\-]*[\p{L}\p{N})])?$/u.test(label)) continue;
      if (amountInCents(label) !== null) continue;
      const parsed = classifyQuestionGrammar(text.slice(0, start) + slot + text.slice(end), { ...options, selectorSlot: true });
      if (!(parsed.kind === 'payment' && parsed.selectorSlotParts.includes(slot)) &&
          !(parsed.kind === 'merchant' && parsed.direction === 'inflow' && parsed.match === slot)) continue;
      // The whole-question cap bounds these spans. A six-word clipping rule
      // would drop alternatives that include a period or a longer legal name.
      if (parsed.kind === 'payment' && (parsed.amountMinor === null || start === noun?.[0].length) &&
          (!specificSender(label, false) || !ledgerWords(label).some(word => !GENERIC_SENDERS.has(word) && !['from', 'via'].includes(word)))) continue;
      readings.push({ label, start, end, parsed });
    }
  }
  if (!readings.length) {
    // An unsupported complete spelling must not re-enter the old comma/filler
    // cleanup through its already-shortened selector. Amount-only and other
    // non-payer intents retain their original routing.
    const named = (original.kind === 'payment' && original.counterpartyWords.length) ||
      (original.kind === 'merchant' && original.direction === 'inflow' && original.match);
    return named ? { broad: original.broad, kind: null } : original;
  }
  const scope = intent => JSON.stringify([intent.kind, intent.from, intent.to, intent.mask, intent.accountKind,
    intent.amountMinor, intent.ownTransfers, intent.withdrawals, intent.loanProceeds, intent.exactNamesOnly]);
  const originalScope = scope(original);
  const chosen = readings.find(r => scope(r.parsed) === originalScope) || readings[0];
  const sameScope = readings.filter(r => scope(r.parsed) === scope(chosen.parsed));
  const complete = r => !sameScope.some(other => other.start < r.start && other.end >= r.end) &&
    (!sameScope.some(other => other.start === r.start && other.end > r.end) ||
    new RegExp(`^ +(?:${ARRIVAL})(?= *[?!.]|$| +(?:in|on|into|to|my|our|the|account|yet|please)\\b)`).test(text.slice(r.end)) ||
    (r.start === noun?.[0].length && new RegExp(`^ +payment +(?:${ARRIVAL}|from|via|of)\\b`).test(text.slice(r.end))) ||
    new RegExp(`^ +(?:in|during|for|over) +(?:the +)?(?:${MONTHS.join('|')}|q[1-4]|last|this|so far|recent|\\d{4} so far)\\b`).test(text.slice(r.end)));
  const whole = sameScope.find(complete);
  // Disjoint selector slots (a channel-named payment FROM another label)
  // require agreement too. Overlapping spans are alternatives for one slot.
  const groups = [];
  for (const r of [...readings].sort((a, b) => a.start - b.start || b.end - a.end)) {
    let group = groups.at(-1);
    if (!group || r.start >= group.end) { group = { start: r.start, end: r.end }; groups.push(group); }
    else group.end = Math.max(group.end, r.end);
    r.group = groups.length - 1;
  }
  const intent = { ...chosen.parsed, payerReadings: readings.map(r => ({ label: r.label, group: r.group,
    complete: scope(r.parsed) === scope(chosen.parsed) && complete(r),
    sameScope: scope(r.parsed) === scope(chosen.parsed) })) };
  delete intent.selectorSlotParts;
  // Structural boundaries are alternative readings even when the remaining
  // name words cannot form question grammar. Such a prefix participates in
  // conflicts, but cannot authorize a claim by discarding the remainder.
  const boundaries = new RegExp(`,|\\b(?:from|via|by|for|in|of|on|into|to|${ARRIVAL})\\b`, 'g');
  const labels = new Set(intent.payerReadings.map(r => r.label));
  for (const reading of [...intent.payerReadings]) for (const match of reading.label.matchAll(boundaries)) {
    for (const label of [reading.label.slice(0, match.index).trim(), reading.label.slice(match.index + match[0].length).trim()]) {
      if (!label || labels.has(label)) continue;
      labels.add(label);
      intent.payerReadings.push({ label, parent: reading.label, group: reading.group, complete: false, sameScope: reading.sameScope });
    }
  }
  if (intent.kind === 'payment') {
    intent.counterparty = whole.label;
    intent.counterpartyWords = ledgerWords(whole.label);
    const parties = paymentParties(text);
    if (original.kind === 'payment' && [parties.named, parties.partyMatch, parties.viaMatch].filter(Boolean).length > 1)
      intent.counterpartyWords = original.counterpartyWords;
  } else intent.match = whole.label;
  return intent;
}
