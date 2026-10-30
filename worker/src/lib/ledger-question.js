// The grammar is deliberately bounded. Unsupported money questions use the
// ordinary document path without imposing unrelated account-link decisions.
const MONTHS = "january february march april may june july august september october november december".split(" ");
const MONTH = `(${MONTHS.join("|")})`;
const DAY_MS = 86400000;
const GENERIC_SENDERS = new Set("bank payment payments deposit transfer money the my our a an account company client customer someone them".split(" "));
const ledgerWords = text => text.match(/[\p{L}\p{N}]+/gu) || [];
function specificSender(text) {
  const words = ledgerWords(text);
  return text.length <= 80 && words.length <= 6 && words.some(word => /\p{L}/u.test(word) && !GENERIC_SENDERS.has(word)) &&
    !/\b(?:second|first|third|next|last|another|other|loan|car|tax)\b/.test(text);
}
export const ledgerDay = (value) => new Date(value).toISOString().slice(0, 10);
export const shiftLedgerDay = (day, delta) => ledgerDay(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS);

function calendarDay(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return Number.isFinite(Date.parse(value)) && ledgerDay(value) === value ? value : null;
}

// Turn one instant into the owner's calendar day without applying a fixed
// offset or parsing locale-formatted text. Returning null keeps an invalid or
// missing configured zone visible to the caller.
function ownerLedgerDay(value, timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone !== timeZone.trim()) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    const fields = {};
    for (const part of formatter.formatToParts(new Date(value))) {
      if (["year", "month", "day"].includes(part.type)) fields[part.type] = Number(part.value);
    }
    const day = calendarDay(fields.year, fields.month, fields.day);
    return day ? { day, timeZone } : null;
  } catch {
    return null;
  }
}

function temporalIntent(intent, ownerTime, derivedWindow) {
  const result = { ...intent, timeZone: ownerTime?.timeZone || null };
  delete result.derivedWindow;
  if (derivedWindow && !ownerTime) {
    delete result.from;
    delete result.to;
    result.ownerTimeZoneUnavailable = true;
  }
  return result;
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
function questionPeriod(q, today, { allowPastMonth = false } = {}) {
  const monthPeriods = allowPastMonth ? "last|this|past" : "last|this";
  const pattern = new RegExp(`\\b(?:${MONTHS.join("|")})(?:\\s+\\d{4})?\\b|\\bq[1-4](?:\\s+\\d{4})?\\b|\\blast\\s+\\d+\\s+days\\b|\\b(?:${monthPeriods}) month\\b|\\bthis week\\b|\\b(?:today|yesterday)\\b|\\bso far this year\\b|\\b\\d{4} so far\\b|\\brecent\\b`, "g");
  const matches = [...q.matchAll(pattern)];
  // "Recent deposits in September" has one explicit period; recent is a
  // listing modifier there. It supplies the 14-day default only on its own.
  const periods = matches.some(m => m[0] !== "recent") ? matches.filter(m => m[0] !== "recent") : matches;
  if (periods.length > 1) return { invalid: true };
  let from, to, derived = false, residual = q.trim().replace(/[?!.]+$/, "").trim();
  if (periods.length) {
    const period = periods[0][0], parts = period.split(/\s+/);
    const year = Number(parts[1]) || Number(today.slice(0, 4));
    if (MONTHS.includes(parts[0])) {
      const month = MONTHS.indexOf(parts[0]);
      from = ledgerDay(Date.UTC(year, month, 1)); to = ledgerDay(Date.UTC(year, month + 1, 0));
      derived = !parts[1];
      // An inferred-year named month asks about posted activity so far when it
      // is current. A month with an explicit year keeps fixed calendar bounds
      // regardless of the owner time-zone state.
      const current = from.slice(0, 7) === today.slice(0, 7);
      if (derived && current) to = today;
    } else if (/^q[1-4]$/.test(parts[0])) {
      const month = (Number(parts[0][1]) - 1) * 3;
      from = ledgerDay(Date.UTC(year, month, 1)); to = ledgerDay(Date.UTC(year, month + 3, 0));
      derived = !parts[1];
    } else if (["last month", "this month"].includes(period)) {
      const date = new Date(`${today}T00:00:00Z`);
      const month = date.getUTCMonth() - (period === "last month" ? 1 : 0);
      from = ledgerDay(Date.UTC(date.getUTCFullYear(), month, 1));
      to = period === "this month" ? today : ledgerDay(Date.UTC(date.getUTCFullYear(), month + 1, 0));
      derived = true;
    } else if (period === "past month") {
      from = shiftLedgerDay(today, -29); to = today;
      derived = true;
    } else if (period === "today") {
      from = today; to = today;
      derived = true;
    } else if (period === "yesterday") {
      from = shiftLedgerDay(today, -1); to = from;
      derived = true;
    } else if (period === "this week") {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      from = shiftLedgerDay(today, -((weekday + 6) % 7)); to = today;
      derived = true;
    } else if (period === "so far this year" || /^\d{4} so far$/.test(period)) {
      const selectedYear = period === "so far this year" ? today.slice(0, 4) : parts[0];
      if (selectedYear !== today.slice(0, 4)) return { invalid: true };
      from = `${selectedYear}-01-01`; to = today;
      derived = true;
    } else if (period === "recent") {
      from = shiftLedgerDay(today, -13); to = today;
      derived = true;
    } else if (Number(parts[1]) >= 1 && Number(parts[1]) <= 3660) {
      from = shiftLedgerDay(today, 1 - Number(parts[1])); to = today;
      derived = true;
    }
    if (!from || !to) return { invalid: true };
    residual = residual.replace(new RegExp(`(?:\\b(?:in|during|for|over)\\s+(?:the\\s+)?)?${period}\\b`), "").trim();
  }
  return { from, to, derived, residual, period: periods[0]?.[0] };
}

function everydayTotalsQuestion(q, today) {
  const text = q.trim().replace(/[?!.]+$/, "").trim();
  if (!/^(?:how much did (?:i|we) spend in the past month|how much money came in over the past month)$/.test(text)) return null;
  const period = questionPeriod(text, today, { allowPastMonth: true });
  const expense = /^how much did (?:i|we) spend/.test(text);
  return { kind: expense ? "expense_summary" : "totals", mask: null, accountKind: null,
    ...(expense ? { direction: "outflow" } : {}), from: period.from, to: period.to };
}

// These subject-first forms are an exact allow-list. In particular, a failed
// candidate does not make a bare "pay" token money-shaped.
function everydayPaymentQuestion(q, today) {
  const text = q.trim().replace(/[?!.]+$/, "").trim();
  const rolling = { from: shiftLedgerDay(today, -29), to: today };
  const defaultWindow = { from: shiftLedgerDay(today, -59), to: today };
  let payer = null, window = null;
  for (const [pattern, selectedWindow] of [
    [/^did (.+?) pay$/, defaultWindow],
    [/^has (.+?) paid$/, defaultWindow],
    [/^did (.+?) pay in the past month$/, rolling],
    [/^has (.+?) paid in the last 30 days$/, rolling],
  ]) {
    const match = text.match(pattern);
    if (match) { payer = match[1]; window = selectedWindow; break; }
  }
  if (!payer) {
    const bareMonth = text.match(new RegExp(`^did (.+?) pay in ${MONTH}$`));
    const passiveMonth = text.match(new RegExp(`^was i paid by (.+?) in ${MONTH}$`));
    const match = bareMonth || passiveMonth;
    if (match) {
      payer = match[1];
      const month = MONTHS.indexOf(match[2]);
      const currentMonth = Number(today.slice(5, 7)) - 1;
      if (month > currentMonth) return null;
      const year = Number(today.slice(0, 4));
      const from = ledgerDay(Date.UTC(year, month, 1));
      window = { from, to: month === currentMonth ? today : ledgerDay(Date.UTC(year, month + 1, 0)) };
    }
  }
  if (payer) {
    if (!specificSender(payer) || /\b(?:been|tax|payroll|invoice|receivable|payable)\b/.test(payer)) return null;
    return { kind: "payment", mask: null, accountKind: null, amountMinor: null,
      counterpartyWords: ledgerWords(payer), ...window };
  }
  for (const pattern of [
    /^did i get paid (\$\s*\d[\d,]*(?:\.\d{1,2})?) in the past month$/,
    /^were we paid (\$\s*\d[\d,]*(?:\.\d{1,2})?) in the last 30 days$/,
  ]) {
    const match = text.match(pattern);
    if (!match) continue;
    const amountMinor = amountInCents(match[1]);
    if (amountMinor === null) return null;
    return { kind: "payment", mask: null, accountKind: null, amountMinor,
      counterpartyWords: [], ...rolling };
  }
  return null;
}

function phaseTwoQuestion(q, intent, today) {
  const clean = q.trim().replace(/[?!.]+$/, "").trim();
  const transactionCount = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  const lastTransactions = clean.match(new RegExp(`^(?:(?:what (?:were|are)|show(?: me)?|list) )?(?:my )?(?:last|latest|most recent) ${transactionCount} transactions?(?: (?:on|for|from|in) (?:(?:my|the) )?(.+))?$`));
  if (lastTransactions) {
    const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const requestedLimit = numberWords[lastTransactions[1]] || Number(lastTransactions[1]);
    const accountSelector = lastTransactions[2]?.trim() || null;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 ||
        (accountSelector && (accountSelector.length > 80 || !/^[\p{L}\p{N}\s&/.'*-]+$/u.test(accountSelector)))) return null;
    return { ...intent, kind: "transactions", requestedLimit, limit: Math.min(requestedLimit, 25),
      accountSelector, from: null, to: today };
  }
  const period = questionPeriod(q, today);
  if (period.invalid) return null;
  let { from, to, residual } = period;
  // Account clauses are explicit and literal. A named bank or entity cannot
  // be consumed as filler, nor can a merchant named "card" select card accounts.
  const selected = residual.match(/\b(?:in|for|of|into)\s+(?:(?:my|the)\s+)?(?:(checking|savings|card|loan|investment|retirement|escrow)\s+)?account\s+(?:ending(?:\s+in)?\s+)?(\d{1,4})\b/);
  if (selected) residual = residual.replace(selected[0], "");
  residual = residual.replace(/,/g, "").replace(/\s+/g, " ").trim();
  const result = { ...intent, mask: selected?.[2] || null, accountKind: selected?.[1] || null,
    from, to, derivedWindow: Boolean(period.derived) };
  const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const count = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  const expenseForm = /^(?:(?:what|how much)(?: money)? went out|what (?:are|were) my expenses|what (?:is|was) my spending|(?:how much|what) did (?:i|we) spend)(?: and on what)?$/;
  if (expenseForm.test(residual)) {
    // Keep the periodless default deliberately narrow. It is an owner-zone
    // current-month request, not permission to guess a window for every spend
    // phrase that failed to name one.
    if (!from && residual !== "what are my expenses") return null;
    const defaultedWindow = !from;
    if (!from) {
      from = `${today.slice(0, 7)}-01`;
      to = today;
    }
    return { ...result, kind: "expense_summary", direction: "outflow", from, to,
      derivedWindow: Boolean(result.derivedWindow || defaultedWindow),
      periodLabel: period.period || "this month" };
  }
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
    return { ...result, kind: "recurring", from: from || shiftLedgerDay(today, -119), to: to || today,
      derivedWindow: Boolean(period.derived || !from), direction: "outflow" };
  }
  if (from && /^(?:(?:what (?:was|is)|show(?: me)?) (?:my )?spending (?:by category|top categories)|what (?:were|are) my top spending categories)$/.test(residual)) {
    return { ...result, kind: "category", direction: "outflow", match: null, ranked: /\btop\b/.test(residual) };
  }
  // Short noun-first requests retain the same merchant/category attribution as
  // the existing "spend at/on" forms. Only software/SaaS is a category alias.
  const nounSpend = residual.match(/^(?:show(?: me)?|what (?:was|is)) (?:my )?(.+?) spend(?:ing)?$/);
  let implicitSpend = false;
  if (nounSpend) {
    const name = nounSpend[1];
    if (name.length > 80 || ledgerWords(name).length > 6 || !/\p{L}/u.test(name) ||
        !/^[\p{L}\p{N}\s&/.'-]+$/u.test(name) ||
        /\b(?:my|our|the|income|versus|vs|business|entity|money|cash|accounts?|largest|biggest|top|total|net|how|what|much|very)\b/.test(name) ||
        // A lone past-participle ("authorized", "allocated") qualifies spending;
        // it is not a merchant. Those questions stay with documents.
        (ledgerWords(name).length === 1 && /ed$/.test(name))) return null;
    implicitSpend = true;
    residual = `show spending ${/^(?:software|saas|software\/saas)$/.test(name) ? "on" : "at"} ${name}`;
  }
  const spending = residual.match(/^(?:how much did (?:i|we) spend|(?:show(?: me)? |what is (?:my |the )?)spend(?:ing)?)(?: (at|on|by) (.+))$/);
  const paid = residual.match(/^how much did (?:i|we) pay (to) (.+)$/);
  const income = residual.match(/^(?:how much income(?: came)?|how much did (?:i|we) receive|(?:show(?: me)? |what is (?:my |the )?)income) (from|by|in category) (.+)$/);
  const filter = spending || paid || income;
  if (filter && from) {
    const direction = spending || paid ? "outflow" : "inflow";
    const mode = filter[1], value = filter[2].trim();
    if (/\b(?:in|during|for|over|between|before|after|account|accounts|entity|or|last|month|year|q[1-4]|excluding|exclude|without|except|including|not counting)\b/.test(value) ||
        (mode !== "at" && mode !== "from" && /\band\b/.test(value))) return null;
    if (mode === "by") return ["merchant", "category"].includes(value) ? { ...result, kind: value, direction, match: null } : null;
    if (!/[\p{L}\p{N}]/u.test(value)) return null;
    return { ...result, kind: ["at", "from", "to"].includes(mode) ? "merchant" : "category",
      direction, match: value, merchantPreposition: implicitSpend ? null : mode };
  }
  return null;
}

const ARRIVAL = "arrive|arrived|receive|received|come|came|land|landed|hit|reach|reached|clear|cleared|post|posted";
function paymentParties(text) {
  const clause = preposition => text.match(new RegExp(`\\b${preposition}\\s+(.+?)(?=\\s+(?:on|into|to|in|for|from|via|${ARRIVAL})\\b|[?,]|$)`));
  const namedPayment = text.match(/^(?:did|has|have)\s+(?:(?:the|my|our|a|an)\s+)?([\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+){0,3})\s+payment\b/u);
  const named = namedPayment && !/^(?:the|my|our|a|an)$/.test(namedPayment[1]) ? namedPayment[1] : "";
  return { partyMatch: clause("from"), viaMatch: clause("via"), namedPayment, named };
}

// A keyword makes a question worth parsing, but it does not by itself prove
// that the owner asked for a money fact. Policy and document frames stay on
// ordinary retrieval, while an owner/account frame, a quantified request, or
// a concrete payment event can still receive unsupported-wording guidance.
function hasPositiveLedgerIntent(q, { everydayPayment, everydayTotals } = {}) {
  if (everydayPayment || everydayTotals) return true;
  if (/\b(?:rules?|polic(?:y|ies)|process(?:es)?|procedures?|guidance|handbook|clause|documentation|requirements?|instructions?)\b/.test(q) ||
      /^(?:summarize|where (?:is|are)|find)\b/.test(q) || /^what does .+\bsay\b/.test(q)) return false;
  const financialSubject = /\b(?:money|cash|profit|bank|accounts?|balances?|deposits?|expenses?|charges?|subscriptions?|payments?|pay|paid|spend|spent|spending|income|revenue|credits?|debits?|transactions?|transfers?|checking|savings|loans?|debt|tax|payroll|invoices?|receivables?|payables?|came in|went out)\b|\$\s*\d/.test(q);
  if (!financialSubject) return false;
  return /\b(?:my|our|i|we|me)\b/.test(q) ||
    /^(?:how (?:much|many)|what|which|did|has|have|was|were|show|list|tell)\b/.test(q) ||
    /\b(?:payment|deposit|invoice)\b.*\b(?:paid|arrive|arrived|received|posted|cleared)\b/.test(q) ||
    /\b(?:came in|went out)\b|\$\s*\d/.test(q);
}

export function classifyLedgerQuestion(question, { now = Date.now(), timeZone = "UTC" } = {}) {
  const sourceQuestion = String(question || "").normalize("NFKC").replace(/[’]/g, "'")
    .replace(/\bwhat's\b/gi, match => match[0] === "W" ? "What is" : "what is");
  let q = sourceQuestion.toLowerCase();
  const ownerTime = ownerLedgerDay(now, timeZone);
  // The UTC day is only a parser probe when the configured zone is invalid.
  // Derived bounds are removed by temporalIntent before the intent can reach
  // account or transaction SQL.
  const today = ownerTime?.day || ledgerDay(now);
  const everydayPayment = everydayPaymentQuestion(q, today);
  const everydayTotals = everydayTotalsQuestion(q, today);
  const nonMoneySavings = /\bsavings? in (?:time|steps?|effort|energy|materials?|distance)\b/.test(q) &&
    !/\b(?:money|cash|bank|accounts?|balances?|deposits?|expenses?|charges?|payments?|spend|spent|income|revenue|credits?|debits?|transactions?|transfers?|loans?|debt|tax|payroll|invoices?)\b|\$\s*\d/.test(q.replace(/\bsavings? in (?:time|steps?|effort|energy|materials?|distance)\b/g, ""));
  const broad = !nonMoneySavings && (Boolean(everydayPayment || everydayTotals) || /\b(?:money|cash|profit|bank|deposits?|expenses?|charges?|subscriptions|recurring (?:charges|subscriptions)|payment|pay|paid|spend|spent|spending|income|revenue|credits?|debits?|transactions?|transfers?|checking|savings|loan|debt|tax|payroll|invoice|receivable|payable|came in|went out)\b|\$\s*\d/.test(q) || /\b(?:(?:my|our|account|card|bank|checking|savings|loan|current|available|outstanding)\s+balances?|balances?\s+(?:of|on|in|for|due))\b/.test(q) ||
    /\b(?:my|our)\s+[\p{L}\p{N}][\p{L}\p{N}\s&/.'*-]{0,80}\s+balances?\b/u.test(q));
  const base = { broad, kind: null };
  const positiveUnsupported = hasPositiveLedgerIntent(q, { everydayPayment, everydayTotals });
  const unsupported = candidate => positiveUnsupported ? candidate : { broad: false, kind: null };
  if (everydayPayment) return temporalIntent({ ...base, ...everydayPayment }, ownerTime, true);
  if (everydayTotals) return temporalIntent({ ...base, ...everydayTotals }, ownerTime, true);
  if (!broad) return base;
  // Consume only these bounded clause families. Duplicate or conflicting
  // clauses refuse; the remaining grammar still has to consume every word.
  // Strip before account selection so "investment withdrawals" is not a kind.
  const transfers = [...q.matchAll(/(?:,\s*)?\b(excluding|without|not counting|including) (?:my |our )?(?:own )?transfers(?: between (?:my|our) (?:own )?accounts)?\b/g)];
  const withdrawals = [...q.matchAll(/(?:,\s*)?\bincluding (?:retirement |investment )?withdrawals\b/g)];
  const loanProceeds = [...q.matchAll(/(?:,\s*)?\bincluding loan proceeds\b/g)];
  if (transfers.length > 1 || withdrawals.length > 1 || loanProceeds.length > 1) return unsupported(base);
  const flags = {};
  if (transfers.length) { flags.ownTransfers = transfers[0][1] === "including" ? "include" : "exclude"; q = q.replace(transfers[0][0], ""); }
  if (withdrawals.length) { flags.withdrawals = "include"; q = q.replace(withdrawals[0][0], ""); }
  if (loanProceeds.length) { flags.loanProceeds = "include"; q = q.replace(loanProceeds[0][0], ""); }
  q = q.replace(/\s+/g, " ").trim();
  let scopeText = q;
  if (/\b(?:payment|deposit|paid)\b/.test(q) && new RegExp(`\\b(?:${ARRIVAL})\\b`).test(q)) {
    const { partyMatch, viaMatch, namedPayment, named } = paymentParties(q);
    for (const match of [partyMatch, viaMatch, named ? namedPayment : null]) if (match) scopeText = scopeText.replace(match[0], "");
  }
  const maskMatches = [...scopeText.matchAll(/(?:\*{2,}|ending(?:\s+in)?\s+|mask\s+|account\s+)(\d{1,4})\b/g)];
  const masks = [...new Set(maskMatches.map(m => m[1]))];
  if (masks.length > 1) return unsupported(base);
  const kinds = [...new Set(scopeText.match(/\b(?:checking|savings|card|loan|investment|retirement|escrow)\b/g) || [])];
  const selector = { mask: masks[0] || null, accountKind: kinds.length === 1 ? kinds[0] : null };
  const intent = { ...base, ...selector, ...flags };
  const withoutMasks = text => maskMatches.reduce((rest, match) => rest.replace(match[0], ""), text);
  const punctuationOnly = text => !text.replace(/[?'.,:]/g, "").trim();
  if (kinds.length > 1) return unsupported(intent);
  const phaseTwo = phaseTwoQuestion(q, intent, today);
  const resolvePhaseTwo = candidate => {
    const resolved = temporalIntent(candidate, ownerTime,
      candidate.derivedWindow || candidate.kind === "transactions");
    if (resolved.kind !== "merchant" || !resolved.match) return resolved;
    const selectorOffset = sourceQuestion.toLowerCase().indexOf(resolved.match.toLowerCase());
    return selectorOffset < 0 ? resolved : { ...resolved,
      match: sourceQuestion.slice(selectorOffset, selectorOffset + resolved.match.length) };
  };
  // A bounded literal preposition is stronger evidence of an exact merchant
  // than a command word inside that merchant's name. Other uses of the same
  // word still reach the refusal list below.
  if (phaseTwo?.kind === "merchant" && ["at", "from", "to"].includes(phaseTwo.merchantPreposition)) return resolvePhaseTwo(phaseTwo);
  if (phaseTwo?.kind === "transactions") return resolvePhaseTwo(phaseTwo);
  if (/\b(?:balance|balances)\b/.test(q) && !Object.keys(flags).length) {
    const clean = withoutMasks(q).trim().replace(/[?!.]+$/, "").trim();
    const named = clean.match(/^(?:what (?:is|are)|show(?: me)?|tell me) (?:my|our|the) (.+?) balances?$/) ||
      clean.match(/^(?:(?:what (?:is|are)|show(?: me)?|tell me) (?:the )?)?balances? on (?:my|our|the) (.+)$/);
    if (named) {
      const accountSelector = named[1].replace(/\s+/g, " ").trim();
      const meaningful = accountSelector.replace(/\b(?:current|latest|bank|account|accounts|checking|savings|card|loan|investment|retirement|escrow|ending|in|mask|all)\b/g, "").trim();
      if (accountSelector.length <= 80 && /^[\p{L}\p{N}\s&/.'*-]+$/u.test(accountSelector) &&
          !/\b(?:and|or|payment|payments)\b/.test(accountSelector)) {
        // In a named balance form, an explicit mask is itself the literal
        // selector even when removing its phrase leaves only a generic kind.
        return { ...intent, kind: "balance", accountSelector: meaningful ? accountSelector : intent.mask };
      }
    }
  }
  // These qualifiers require a different source or a richer financial model.
  if (/\b(?:quickbooks|qbo|tax|excluding|exclude|without|except|including|not counting|budgeted|budget|approved|authori[sz]ed|allocated|proposed|committed|permitted|planned|projected|expected|estimated|forecast|target|allowed|average|median|smallest|interest)\b/.test(q)) return unsupported(intent);
  if (/\b(?:profit|net income|cash flow)\b/.test(q)) {
    const period = questionPeriod(q, today);
    if (period.invalid || !period.from || !period.to) return unsupported(intent);
    const residual = period.residual.replace(/\s+/g, " ").trim();
    const form = residual.match(/^(?:what (?:was|is|were) (?:my|our|the) (profit|net income|cash flow)|how much (profit) did (?:i|we) make)(?: (?:for|in|of) (?:(?:my|our|the) )?(?:(checking|savings|card|loan|investment|retirement|escrow) )?account(?: (?:ending(?: in)? |mask )?(\d{1,4}))?)?$/);
    if (!form) return unsupported(intent);
    return temporalIntent({ ...intent, kind: "totals", measure: (form[1] || form[2]).replaceAll(" ", "_"),
      from: period.from, to: period.to }, ownerTime, period.derived);
  }
  if (phaseTwo) {
    if (phaseTwo.kind === "transfers" && Object.keys(flags).length) return unsupported(intent);
    return resolvePhaseTwo(phaseTwo);
  }
  if (/\b(?:balance|balances)\b/.test(q)) {
    if (Object.keys(flags).length) return unsupported(intent);
    // Do not replace a named bank/entity or a historical balance with all accounts.
    const residual = withoutMasks(q).replace(/\b(?:what|is|are|my|our|the|current|latest|bank|account|accounts|balance|balances|checking|savings|card|loan|investment|retirement|escrow|per|each|show|me|please|today|now|ending|in|mask|for|all)\b/g, "");
    return punctuationOnly(residual) ? { ...intent, kind: "balance" } : unsupported(intent);
  }
  if (/\b(?:payment|deposit|paid)\b/.test(q) && /\b(?:arrive|arrived|received|receive|come|came|land|landed|hit|reach|reached|clear|cleared|post|posted)\b/.test(q)) {
    if (Object.keys(flags).length) return unsupported(intent);
    const amountMinor = amountInCents(q);
    if (amountMinor === null && /\$|\busd\b|\bdollars?\b/.test(q)) return unsupported(intent);
    const dates = [];
    let dateNeedsOwnerDay = false;
    let rest = withoutMasks(q);
    const date = (match, day) => { dates.push(day); rest = rest.replace(match[0], ""); };
    for (const m of q.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) date(m, calendarDay(m[1], m[2], m[3]));
    for (const m of q.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "g"))) {
      if (!m[3]) dateNeedsOwnerDay = true;
      date(m, calendarDay(m[3] || today.slice(0, 4), MONTHS.indexOf(m[1]) + 1, m[2]));
    }
    for (const m of q.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`, "g"))) {
      date(m, calendarDay(m[3], MONTHS.indexOf(m[2]) + 1, m[1]));
    }
    for (const m of q.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) date(m, calendarDay(m[3], m[1], m[2]));
    if (dates.some(d => !d) || new Set(dates).size > 1) return unsupported(intent);
    const period = dates.length ? { residual: rest } : questionPeriod(rest, today);
    if (period.invalid) return unsupported(intent);
    // A bare month still cannot date an exact payment. Keep the original
    // ambiguity control; an explicit year or relative bounded window is needed.
    if (period.period && MONTHS.includes(period.period)) return unsupported(intent);
    rest = period.residual;
    if (dates.length && /\b(?:before|after|between)\b/.test(rest)) return unsupported(intent);
    if (!dates.length && !period.from && /\b(?:on|between|before|after|yesterday|tomorrow|last|this)\b/.test(rest)) return unsupported(intent);
    const arrival = ARRIVAL;
    const { partyMatch, viaMatch, namedPayment, named } = paymentParties(rest);
    // Apply one specificity rule to every sender form. Generic-only clauses
    // cannot identify an amountless payment; keep all words in specific names
    // so rejecting generic narration never widens a query to every deposit.
    const parties = [named, viaMatch?.[1], partyMatch?.[1]].filter(Boolean);
    // An amount does not establish which ordinal payment was meant, and a
    // generic adjective must not become sender evidence by being consumed.
    if (named && !specificSender(named)) return unsupported(intent);
    if (amountMinor === null && (!parties.length || parties.some(party => !specificSender(party)))) return unsupported(intent);
    const counterparty = parties.join(" ");
    if (partyMatch) rest = rest.replace(partyMatch[0], "");
    if (viaMatch) rest = rest.replace(viaMatch[0], "");
    if (named) rest = rest.replace(namedPayment[0], "payment");
    rest = rest.replace(/(?:\$|\busd\s+)\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s+dollars?\b/g, "")
      .replace(/,?\s+and when\b/g, "")
      .replace(new RegExp(`\\b(?:did|has|have|was|is|the|a|my|our|payment|deposit|of|paid|${arrival}|yet|on|in|into|to|account|bank|checking|savings|card|loan|investment|retirement|escrow|ending|mask|please)\\b`, "g"), "");
    if (!punctuationOnly(rest)) return unsupported(intent);
    const counterpartyWords = counterparty.match(/[\p{L}\p{N}]+/gu) || [];
    if (amountMinor === null && !counterpartyWords.length) return unsupported(intent);
    return temporalIntent({ ...intent, kind: "payment", amountMinor, counterpartyWords,
      from: dates.length ? shiftLedgerDay(dates[0], -7) : period.from || shiftLedgerDay(today, amountMinor === null ? -59 : -29),
      to: dates.length ? shiftLedgerDay(dates[0], 7) : period.to || today }, ownerTime,
    dateNeedsOwnerDay || (!dates.length && (period.derived || !period.from)));
  }
  if (/\b(?:money|cash|came in|went out|income|spend|spent|spending|expenses?|credits?|debits?|inflow|outflow)\b/.test(q)) {
    const { from, to, derived, residual: rest, invalid } = questionPeriod(withoutMasks(q), today);
    if (invalid || !from || !to) return unsupported(intent);
    const residual = rest.replace(/\b(?:how|much|money|cash|came|come|in|into|of|and|or|went|go|out|income|spend|spent|spending|expenses?|credits?|debits?|inflow|outflow|did|i|we|what|was|were|is|are|the|total|totals|my|our|account|accounts|bank|checking|savings|card|loan|investment|retirement|escrow|by|per|each|all|during|for|over|show|me|please)\b/g, "");
    if (punctuationOnly(residual)) return temporalIntent({ ...intent, kind: "totals", from, to }, ownerTime, derived);
  }
  return unsupported(intent);
}
