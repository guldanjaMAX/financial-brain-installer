// Exported inventory is checked against parser kinds and attribution coverage.
export const LEDGER_ANSWER_KINDS = Object.freeze([
  'balance', 'payment', 'totals', 'largest', 'deposits', 'merchant', 'category', 'transfers', 'recurring',
]);

// Preserve comma positions before either question or bank-field grammar can
// discard punctuation. This fixed mapping is shared with attribution.
export const normalizePayerCommas = value => String(value || '')
  .replace(/[\u060c\u3001\uff0c\uff64\ufe50\ufe51\u2e41\u1802\u1808\ua4fe\ua60d\u07f8\u055d]/g, ',');
export const hasUnsupportedPayerPunctuation = value => [...normalizePayerCommas(value)]
  .some(char => /\p{Po}/u.test(char) && !".'&-/#,".includes(char));

// The grammar is deliberately bounded. Unsupported money questions use the
// ordinary document path without imposing unrelated account-link decisions.
export const payerQuestionGrammar = Object.freeze({
  arrivals: Object.freeze("arrive arrived receive received come came land landed hit reach reached clear cleared post posted".split(" ")),
  months: Object.freeze("january february march april may june july august september october november december".split(" ")),
  connectors: Object.freeze("on in at for by from to via into during over between before after of".split(" ")),
  dateWords: Object.freeze("last this recent month year days today yesterday tomorrow".split(" ")),
  filler: Object.freeze(["please", "thanks", "for me", "if you can", "right now", "exactly", "again"]),
});
const MONTHS = payerQuestionGrammar.months;
const trailingQuestionFiller = new RegExp(`(?:[, ]+(?:${payerQuestionGrammar.filler.join('|')}))+$`);
const spendQuestionFiller = new RegExp(`\\b(?:${payerQuestionGrammar.filler.join('|')})\\b`, 'g');
const payerTerminalWords = new Set([...MONTHS, ...payerQuestionGrammar.connectors, ...payerQuestionGrammar.dateWords, ...payerQuestionGrammar.arrivals]);
const terminalDate = new RegExp(`\\b(?:${MONTHS.join('|')}|q[1-4])(?: +[0-9]{1,4}){0,2}$|\\b[0-9]{4}-[0-9]{2}-[0-9]{2}$|\\b[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$`);
const terminalGrammarWord = label => payerTerminalWords.has(ledgerWords(label).at(-1)) || terminalDate.test(label);
const danglingConnector = new RegExp(`^[ ,]+(?:${payerQuestionGrammar.connectors.join('|')}) +(?:${[...payerQuestionGrammar.connectors, ...payerQuestionGrammar.arrivals].join('|')})\\b`);
const MONTH = `(${MONTHS.join("|")})`;
const DAY_MS = 86400000;
const GENERIC_SENDERS = new Set("bank payment payments deposit transfer money the my our a an account company client customer someone them".split(" "));
const ledgerWords = text => text.match(/[\p{L}\p{N}]+/gu) || [];
function specificSender(text, bounded = true) {
  const words = ledgerWords(text);
  return (!bounded || (text.length <= 80 && words.length <= 6)) && words.some(word => /\p{L}/u.test(word) && !GENERIC_SENDERS.has(word)) &&
    !(bounded ? /\b(?:second|first|third|next|last|another|other|loan|car|tax)\b/
      : /\b(?:second|first|third|next|another|other|loan|car|tax)\b/).test(text);
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
function questionPeriod(q, today, protectSpend = false) {
  const pattern = new RegExp(`\\b(?:${MONTHS.join("|")})(?:\\s+(?:of\\s+)?\\d{4})?\\b|\\bq[1-4](?:\\s+\\d{4})?\\b|\\blast\\s+\\d+\\s+days\\b|\\b(?:last|this) month\\b|\\bso far this year\\b|\\b\\d{4} so far\\b|\\brecent\\b`, "g");
  let matches = [...q.matchAll(pattern)];
  if (protectSpend) {
    const spend = q.match(new RegExp(spendPattern.source.replace('^', '(?:^|, *)')));
    if (spend && spend[1] !== 'by') {
      const start = spend.index + spend[0].length - spend[2].length;
      const external = matches.find(match => {
        if (match.index < start) return false;
        if (/\b(?:in|during|for|over) +(?:the +)?$/.test(q.slice(start, match.index))) return true;
        // Bare relative periods at the end retain their original grammar.
        // A relative phrase followed by more name text remains in the span.
        const relative = !MONTHS.includes(match[0].split(' ')[0]) && !/^q[1-4]/.test(match[0]);
        const tail = q.slice(match.index + match[0].length).replace(/[?!.]+$/, '').replace(trailingQuestionFiller, '').trim();
        return relative && !tail;
      });
      // A bare month inside a merchant name is not another period clause.
      // Explicit clauses after the name still all participate in ambiguity.
      matches = matches.filter(match => match.index < start || (external && match.index >= external.index));
    }
  }
  // "Recent deposits in September" has one explicit period; recent is a
  // listing modifier there. It supplies the 14-day default only on its own.
  const periods = matches.some(m => m[0] !== "recent") ? matches.filter(m => m[0] !== "recent") : matches;
  if (periods.length > 1) return { invalid: true };
  let from, to, boundaryResidual, residual = q.trim().replace(/[?!.]+$/, "").trim();
  if (periods.length) {
    const period = periods[0][0], parts = period.replace(/ of /, " ").split(/\s+/);
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
    const at = periods[0].index;
    const prefix = q.slice(0, at).match(/\b(?:in|during|for|over)\s+(?:the\s+)?$/)?.[0] || '';
    const before = residual.slice(0, at - prefix.length), after = residual.slice(at + period.length);
    boundaryResidual = `${before} \u0001 ${after}`;
    residual = (before + after).trim();
  }
  return { from, to, residual, boundaryResidual, period: periods[0]?.[0] };
}

const spendPattern = /^(?:how much did (?:i|we) spend|(?:show(?: me)? |what is (?:my |the )?)spend(?:ing)?)(?: (at|on|by) (.+))$/;
function spendSelectorText(residual) {
  // Preserve the period boundary until its tail is consumed. Concatenating
  // an unknown tail onto the merchant would turn an understood expense into $0.
  const filler = trailingQuestionFiller;
  const parts = residual.split('\u0001');
  if (parts.length > 2) return null; // Raw input cannot inject another boundary.
  const [beforePeriod, afterPeriod] = parts;
  if (afterPeriod !== undefined && spendPattern.test(beforePeriod.trim())) {
    if (afterPeriod.replace(filler, '').trim()) return null;
    residual = beforePeriod.trim();
  } else residual = residual.replace('\u0001', '').replace(/\s+/g, ' ').trim();
  if (spendPattern.test(residual)) residual = residual.replace(filler, '').trim();
  return residual;
}

function phaseTwoQuestion(q, intent, today) {
  // The same closed filler grammar applies on either side of the selector
  // and period clause. Unknown words remain for grammar or row-match refusal.
  if (/\bspend(?:ing)?\b/.test(q)) q = q.replace(spendQuestionFiller, ' ').replace(/\s+/g, ' ').trim();
  const period = questionPeriod(q, today, true);
  if (period.invalid) return null;
  let { from, to, residual } = period;
  residual = period.boundaryResidual ?? residual;
  // Account clauses are explicit and literal. A named bank or entity cannot
  // be consumed as filler, nor can a merchant named "card" select card accounts.
  const selected = residual.match(/\b(?:in|for|of|into)\s+(?:(?:my|the)\s+)?(?:(checking|savings|card|loan|investment|retirement|escrow)\s+)?account(?:\s+(?:ending(?:\s+in)?\s+)?(\d{1,4}))?\b/);
  if (selected) residual = residual.replace(selected[0], "");
  residual = residual.replace(/,/g, "").replace(/\s+/g, " ").trim();
  residual = spendSelectorText(residual);
  if (residual === null) return null;
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
  const spending = residual.match(spendPattern);
  const income = residual.match(/^(?:how much income(?: came)?|how much did (?:i|we) receive|(?:show(?: me)? |what is (?:my |the )?)income) (from|by|in category) (.+)$/);
  const filter = spending || income;
  if (filter && from) {
    const direction = spending ? "outflow" : "inflow";
    const mode = filter[1], value = filter[2].trim();
    if (/\b(?:in|during|for|over|between|before|after|account|accounts|entity|or|month|year|q[1-4])\b/.test(value) ||
        (mode !== "at" && mode !== "from" && /\band\b/.test(value))) return null;
    if (mode === "by") return ["merchant", "category"].includes(value) ? { ...result, kind: value, direction, match: null } : null;
    if (!/[\p{L}\p{N}]/u.test(value)) return null;
    return { ...result, kind: ["at", "from"].includes(mode) ? "merchant" : "category", direction, match: value };
  }
  return null;
}

const ARRIVAL = payerQuestionGrammar.arrivals.join("|");
const paymentAmount = /(?:\$|\busd\s+)\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s+dollars?\b/g;
const nounExternalAmount = new RegExp(`'s +(?:${paymentAmount.source})$`);
// One date or period may sit between the possessive and "payment" ("Payer
// One's September 2026 payment", "Payer One's last month payment"); the 's
// still belongs to the noun grammar. The relative forms are exactly the ones
// questionPeriod consumes as the window.
const possessiveDate = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4}|q[1-4](?: +\\d{4})?|(?:${MONTHS.join('|')})(?: +\\d{1,2}(?:st|nd|rd|th)?)?(?:,? +\\d{4})?|recent|(?:last|this) +month|last +\\d+ +days|so far this year|\\d{4} so far)`;
const nounPossessive = new RegExp(`^((?:did|has|have) +.*?)'s(?= +(?:${possessiveDate} +)?payment +(?:${ARRIVAL}|from|via|of)\\b)`);
function stripNounPossessive(text) {
  // Amount and possessive are one noun-payment grammar. Remove the amount
  // before deciding whether 's belongs to that noun. Amount scope is carried
  // separately through every protected-span and registry-coverage parse.
  if (/^(?:did|has|have)\b/.test(text) && /\bpayment\b/.test(text))
    text = text.replace(paymentAmount, '').replace(/\s+/g, ' ').trim();
  // A possessive inside a FROM payer is part of that registered spelling.
  return text.replace(nounPossessive, (match, payer) => /\bpayment +(?:from|via)\b/.test(payer) ? match : payer);
}
function paymentParties(text, selectorSlot = false) {
  // Currency words qualify the amount, never a noun-form payer.
  text = text.replace(paymentAmount, '').replace(/\s+/g, ' ').trim();
  const clause = preposition => text.match(new RegExp(`\\b${preposition}\\s+(.+?)(?=\\s+(?:on|into|to|in|for|from|via|${ARRIVAL})\\b|[?,]|$)`));
  // A payer ending in "payment" after FROM must not also be consumed as a
  // noun-first payer, duplicating the clause and certifying a false nonmatch.
  const namedPayment = /^(?:did|has|have)\s+(?:(?:the|my|our|a|an)\s+)?payment\s+(?:from|via)\b/.test(text) ? null
    : (selectorSlot && text.match(/^(?:did|has|have)\s+(?:(?:the|my|our|a|an)\s+)?(selectorplaceholder)\s+payment\b/)) ||
      text.match(/^(?:did|has|have)\s+(?:(?:the|my|our|a|an)\s+)?([\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+){0,3})\s+payment\b/u);
  const named = namedPayment && !/^(?:the|my|our|a|an)$/.test(namedPayment[1]) ? namedPayment[1] : "";
  return { partyMatch: clause("from"), viaMatch: clause("via"), namedPayment, named };
}

// Every selector-span grammar parse for one question spends one shared work
// budget, like the statement parser's operation limit. The length and start
// caps alone still allow nested span enumeration to multiply; overflow
// refuses the whole question rather than pruning readings.
export const ledgerQuestionLimits = Object.freeze({ parses: 30000 });
const questionBudgetSpent = Symbol('question parse budget');
function budgetedGrammar(budget, question, options) {
  if (budget) {
    if (budget.remaining <= 0) throw questionBudgetSpent;
    budget.remaining--;
  }
  return classifyQuestionGrammar(question, options);
}

function classifyQuestionGrammar(question, { now = Date.now(), selectorSlot = false, amountSource = question } = {}) {
  let q = stripNounPossessive(normalizePayerCommas(question).normalize("NFKC").toLowerCase().replace(/[’]/g, "'").replace(/\bwhat's\b/g, "what is"));
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
    const { partyMatch, viaMatch, namedPayment, named } = paymentParties(q, selectorSlot);
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
    const amountText = normalizePayerQuestion(amountSource);
    const amountMinor = amountInCents(amountText);
    if (amountMinor === null && /\$|\busd\b|\bdollars?\b/.test(amountText)) return intent;
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
    rest = period.residual.replace(paymentAmount, '').replace(/\s+/g, ' ').trim();
    if (dates.length && /\b(?:before|after|between)\b/.test(rest)) return intent;
    if (!dates.length && !period.from && /\b(?:on|between|before|after|yesterday|tomorrow|last|this)\b/.test(rest)) return intent;
    const arrival = ARRIVAL;
    const { partyMatch, viaMatch, namedPayment, named } = paymentParties(rest, selectorSlot);
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

export const normalizePayerQuestion = value => normalizePayerCommas(value).normalize('NFKC').toLowerCase()
  .replace(/’/g, "'").replace(/\s+/g, ' ').trim();
const questionGrammarText = value => stripNounPossessive(normalizePayerQuestion(value).replace(/\bwhat's\b/g, 'what is'));

function unsupportedQuestionPunctuation(question) {
  const raw = normalizePayerCommas(question), spans = [];
  // Decide on raw punctuation BEFORE compatibility normalization. Map only
  // refused characters into the bounded grammar text so routing/registered
  // coverage keep their existing offsets. Prefix normalization accounts for
  // composed letters, expanded glyphs, whitespace and contractions before it.
  for (const match of raw.matchAll(/\p{Po}/gu)) {
    if (!hasUnsupportedPayerPunctuation(match[0])) continue;
    const end = questionGrammarText(raw.slice(0, match.index + match[0].length)).length;
    spans.push({ start: end - questionGrammarText(match[0]).length, end });
  }
  return spans;
}
const questionScope = intent => JSON.stringify([intent.kind, intent.from, intent.to, intent.mask, intent.accountKind,
  intent.amountMinor, intent.ownTransfers, intent.withdrawals, intent.loanProceeds, intent.exactNamesOnly]);

// Registry mentions are identity authority. Grammar only verifies that every
// payer clause is fully occupied by a mention and that the scope is unchanged.
// Replace all mentions together so Payment/FROM inside a name cannot erase a
// different payer clause. A partly covered clause never becomes an exact name.
export function payerMentionsCoverQuestion(intent, mentions) {
  if (!intent.payerQuestion || !mentions.length) return false;
  const question = intent.payerQuestion.text, slot = 'selectorplaceholder';
  const coveredBy = (clause, mention) => mention.start <= clause.start &&
    (mention.end >= clause.end || (/^[.?!]+$/.test(question.slice(mention.end, clause.end)) &&
      /^(?:[, ]*exact names only)?[?!.]*$/.test(question.slice(clause.end).trim())));
  const complete = intent.payerReadings?.filter(reading => reading.complete) || [];
  const clauseSets = intent.payerClauseSets || [];
  // Keep identity conflicts independent of coverage. Once all mentions agree
  // on one slug, overlapping aliases can describe alternative covered parses.
  // A same-entity alias in account narration need not replace that narration.
  // A registered spelling may itself start with FROM and contain the parser's
  // shorter clause. Preserve the question's structural cue by replacing the
  // covered clause span, while the containing mention still decides identity.
  const spans = [...new Map([...complete, ...clauseSets.flat()]
    .filter(clause => mentions.some(mention => coveredBy(clause, mention)))
    .map(clause => [`${clause.start}:${clause.end}`, clause])).values()]
    .sort((a, b) => a.start - b.start || b.end - a.end);
  function coveredParse(selected) {
    const covered = clause => selected.some(mention => coveredBy(clause, mention));
    // Generic comma tails cannot disappear in the unprotected grammar. Each
    // separate noun/FROM clause also needs full coverage in the chosen parse.
    if (!complete.some(covered) || (clauseSets.length && !clauseSets.some(clauses => clauses.every(covered)))) return false;
    let text = question;
    for (const span of selected.toReversed()) text = text.slice(0, span.start) + slot + text.slice(span.end);
    const parsed = classifyQuestionGrammar(text, { now: intent.payerQuestion.now, selectorSlot: true,
      amountSource: intent.payerQuestion.amountSource });
    if (questionScope(parsed) !== questionScope(intent)) return false;
    if (parsed.kind === 'payment') return parsed.selectorSlotParts?.length > 0 && parsed.selectorSlotParts.every(part => part === slot);
    return parsed.kind === 'merchant' && parsed.direction === 'inflow' && parsed.match === slot;
  }
  // Coverage is a bounded existence proof for a single already-resolved slug.
  // Try complete compatible sets first; if no proof fits the budget, refuse.
  let steps = 0;
  function visit(index, selected) {
    if (++steps > 64) return false;
    if (index === spans.length) return coveredParse(selected);
    const span = spans[index];
    if ((!selected.length || span.start >= selected.at(-1).end) && visit(index + 1, [...selected, span])) return true;
    return visit(index + 1, selected);
  }
  return visit(0, []);
}

// A payer label never contains a connector-introduced period clause. The
// plain grammar refuses two periods; admitting "payer one in september 2026
// and" as a name would let the second period alone scope the question.
// A bare month inside a name ("October Ventures") is not such a clause.
// Nor does it contain a complete period expression without a connector
// ("payer one september 2026 and"): a month with its year, a dated quarter or
// a relative period is never name text, so it cannot be stuffed into a label
// while a second period scopes the question.
const labelPeriodClause = new RegExp(`\\b(?:in|during|for|over|between|before|after) +(?:the +)?(?:${MONTHS.join('|')}|q[1-4]|last|this|so far|recent|\\d{4} so far)\\b|` +
  `\\b(?:(?:${MONTHS.join('|')}) +(?:of +)?\\d{4}|q[1-4] +\\d{4}|last +\\d+ +days|(?:last|this) +month|so far this year|\\d{4} so far)\\b`);

// Protect a whole selector BEFORE the intent grammar removes periods, account
// words or punctuation. Reusing that grammar with an opaque slot keeps every
// supported question form in one place. These readings route the question only;
// registry mentions over the entire question decide identity after the read.
function classifyPayerQuestion(question, { now = Date.now(), amountSource = question, budget } = {}) {
  const options = { now, amountSource };
  if (String(question || '').length > 1024) return { broad: true, kind: null };
  const original = budgetedGrammar(budget, question, options);
  // Natural receive questions can lack a money keyword. Read their original
  // selectors with the same grammar before protecting names, without changing
  // the fallback routing or inventing an account from a candidate reading.
  const originalSelectors = original.broad ? original : budgetedGrammar(budget, question, { ...options, selectorSlot: true });
  const text = questionGrammarText(question);
  const starts = [...text.matchAll(/\b(?:from|via) +/g)].map(m => m.index + m[0].length);
  const noun = text.match(/^(?:did|has|have) +(?:(?:the|my|our|a|an) +)?/);
  if (noun) starts.push(noun[0].length);
  if (!starts.length) return original;
  // Bounds apply before the quadratic span enumeration. Refuse overflow,
  // including an otherwise valid shorter selector, rather than prune readings.
  if (text.length > 512 || starts.length > 12 || /[\p{Cc}\p{Cf}]/u.test(String(question || '')))
    return { broad: original.broad, kind: null };
  const unsupportedPunctuation = unsupportedQuestionPunctuation(question);
  const slot = 'selectorplaceholder';
  if (text.includes(slot)) return { broad: original.broad, kind: null };
  const readings = [], clauseSets = [];
  const labelPattern = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M} &'()._/:#,\-]*[\p{L}\p{N}).])?$/u;
  for (const start of starts) {
    for (let end = start + 1; end <= text.length; end++) {
      if (end < text.length && !/[ ,?!.]/.test(text[end])) continue;
      const label = text.slice(start, end);
      if (!labelPattern.test(label) || terminalGrammarWord(label) || labelPeriodClause.test(label)) continue;
      // The old payment filler pass consumes "in arrive" or a repeated "in".
      // That cannot authorize shortening a rejected terminal-connector name.
      if (danglingConnector.test(text.slice(end))) continue;
      if (amountInCents(label) !== null) continue;
      const parsed = budgetedGrammar(budget, text.slice(0, start) + slot + text.slice(end), { ...options, selectorSlot: true });
      if (!(parsed.kind === 'payment' && parsed.selectorSlotParts.includes(slot)) &&
          !(parsed.kind === 'merchant' && parsed.direction === 'inflow' && parsed.match === slot)) continue;
      if (parsed.selectorSlotParts?.some(part => part !== slot && terminalGrammarWord(part))) continue;
      // The whole-question cap bounds these spans. A six-word clipping rule
      // would drop alternatives that include a period or a longer legal name.
      if (parsed.kind === 'payment' && (parsed.amountMinor === null || start === noun?.[0].length) &&
          (!specificSender(label, false) || !ledgerWords(label).some(word => !GENERIC_SENDERS.has(word) && !['from', 'via'].includes(word)))) continue;
      if (parsed.mask !== (originalSelectors.mask ?? null) || parsed.accountKind !== (originalSelectors.accountKind ?? null) ||
          ['exactNamesOnly', 'ownTransfers', 'withdrawals', 'loanProceeds'].some(key => parsed[key] !== originalSelectors[key])) continue;
      readings.push({ label, start, end, parsed });
    }
  }
  // Two noun/FROM slots can each contain grammar words or punctuation. Protect
  // both for routing, so an internal FROM in either label cannot hide the other
  // slot. Registry mentions still make the sole identity decision after reading.
  if (noun) for (const bridge of text.matchAll(/ +payment +(?:from|via) +/g)) {
    const first = { start: noun[0].length, end: bridge.index };
    first.label = text.slice(first.start, first.end);
    if (!labelPattern.test(first.label) || terminalGrammarWord(first.label) || labelPeriodClause.test(first.label) ||
        !specificSender(first.label, false) || amountInCents(first.label) !== null) continue;
    const start = bridge.index + bridge[0].length;
    for (let end = start + 1; end <= text.length; end++) {
      if (end < text.length && !/[ ,?!.]/.test(text[end])) continue;
      const label = text.slice(start, end);
      if (!labelPattern.test(label) || terminalGrammarWord(label) || labelPeriodClause.test(label) ||
          !specificSender(label, false) || amountInCents(label) !== null) continue;
      if (danglingConnector.test(text.slice(end))) continue;
      const parsed = budgetedGrammar(budget, text.slice(0, first.start) + slot + bridge[0] + slot + text.slice(end),
        { ...options, selectorSlot: true });
      if (parsed.kind !== 'payment' || parsed.selectorSlotParts.length !== 2 || !parsed.selectorSlotParts.every(part => part === slot)) continue;
      if (parsed.mask !== (originalSelectors.mask ?? null) || parsed.accountKind !== (originalSelectors.accountKind ?? null) ||
          ['exactNamesOnly', 'ownTransfers', 'withdrawals', 'loanProceeds'].some(key => parsed[key] !== originalSelectors[key])) continue;
      readings.push({ ...first, parsed }, { label, start, end, parsed });
      clauseSets.push({ clauses: [first, { label, start, end }], parsed });
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
  const scope = questionScope;
  const originalScope = scope(original);
  const chosen = readings.find(r => scope(r.parsed) === originalScope) || readings[0];
  const sameScope = readings.filter(r => scope(r.parsed) === scope(chosen.parsed));
  const complete = r => !sameScope.some(other => other.start < r.start && other.end >= r.end) &&
    (!sameScope.some(other => other.start === r.start && other.end > r.end) ||
    new RegExp(`^ +(?:${ARRIVAL})(?= *[?!.]|$| +(?:in|on|into|to|my|our|the|account|yet|please)\\b)`).test(text.slice(r.end)) ||
    (r.start === noun?.[0].length && new RegExp(`^ +payment +(?:${ARRIVAL}|from|via|of)\\b`).test(text.slice(r.end))) ||
    new RegExp(`^ +(?:in|during|for|over) +(?:the +)?(?:${MONTHS.join('|')}|q[1-4]|last|this|so far|recent|\\d{4} so far)\\b`).test(text.slice(r.end)));
  const whole = sameScope.find(complete);
  const scopedSets = clauseSets.filter(set => scope(set.parsed) === scope(chosen.parsed));
  const completeSets = scopedSets.filter(set => !scopedSets.some(other =>
    other.clauses[0].end === set.clauses[0].end && other.clauses[1].end > set.clauses[1].end));
  // Disjoint selector slots (a channel-named payment FROM another label)
  // require agreement too. Overlapping spans are alternatives for one slot.
  const groups = [];
  for (const r of [...readings].sort((a, b) => a.start - b.start || b.end - a.end)) {
    let group = groups.at(-1);
    if (!group || r.start >= group.end) { group = { start: r.start, end: r.end }; groups.push(group); }
    else group.end = Math.max(group.end, r.end);
    r.group = groups.length - 1;
  }
  // Refuse all query-only readings when a complete payer clause contains raw
  // unsupported punctuation. A shorter alternative must not discard the mark
  // and acquire authority. Independently registered mentions remain usable.
  const unsupported = [...sameScope.filter(complete), ...completeSets.flatMap(set => set.clauses)]
    .some(clause => unsupportedPunctuation.some(mark => mark.start < clause.end && mark.end > clause.start));
  const intent = { ...chosen.parsed, payerQuestion: { text, now, amountSource, unsupportedPunctuation: unsupported },
    payerClauseSets: completeSets.map(set => set.clauses),
    payerReadings: readings.map(r => ({ label: r.label, start: r.start, end: r.end, group: r.group,
    complete: scope(r.parsed) === scope(chosen.parsed) && complete(r),
    sameScope: scope(r.parsed) === scope(chosen.parsed) })) };
  delete intent.selectorSlotParts;
  // Structural boundaries are alternative readings even when the remaining
  // name words cannot form question grammar. Such a prefix participates in
  // conflicts, but cannot authorize a claim by discarding the remainder.
  const boundaries = new RegExp(`,|\\b(?:${payerQuestionGrammar.connectors.join('|')}|${ARRIVAL})\\b`, 'g');
  const labels = new Set(intent.payerReadings.map(r => r.label));
  for (const reading of [...intent.payerReadings]) for (const match of reading.label.matchAll(boundaries)) {
    for (const label of [reading.label.slice(0, match.index).trim(), reading.label.slice(match.index + match[0].length).trim()]) {
      if (!label || labels.has(label) || terminalGrammarWord(label)) continue;
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


// Cleanup is an alternative interpretation, not authority to edit a name.
// Reuse the bounded grammar with an opaque slot, preserving the literal span
// and deriving amount scope only from text outside it. The reader decides
// between these interpretations using its one covered snapshot and registry.
export function classifyLedgerQuestion(question, { now = Date.now(), parseLimit = ledgerQuestionLimits.parses } = {}) {
  const budget = { remaining: Number.isSafeInteger(parseLimit) && parseLimit >= 0
    ? Math.min(parseLimit, ledgerQuestionLimits.parses) : 0 };
  try {
    return classifyBoundedLedgerQuestion(question, now, budget);
  } catch (error) {
    if (error !== questionBudgetSpent) throw error;
    // One unbudgeted top-level parse keeps the routing flag; no selector
    // reading survives an exhausted budget.
    return { broad: classifyQuestionGrammar(question, { now }).broad, kind: null };
  }
}

function classifyBoundedLedgerQuestion(question, now, budget) {
  const original = classifyPayerQuestion(question, { now, budget });
  // An amount-only payment has no name selector to reinterpret. Preserve its
  // amount and shorter default window instead of inventing a numeric payer.
  if (original.kind === 'payment' && !original.counterpartyWords.length) return original;
  const text = normalizePayerQuestion(question);
  const merchant = original.kind === 'merchant' && original.direction === 'outflow' && original.match;
  // Printed privacy labels remain explicit unsupported-selector refusals;
  // span enumeration must not reroute them to an unqualified document answer.
  if (merchant && (/\[redacted\]/i.test(original.match) || original.match.length >= 240)) return original;
  if (!merchant && !text.match(spendQuestionFiller) && !text.match(paymentAmount)) return original;
  // A rejected literal boundary must not re-enter the lossy cleaned parser.
  if (text.length > 512 || /[\p{Cc}\p{Cf}]/u.test(String(question || '')))
    return { broad: original.broad, kind: null };
  const slot = 'literalnameplaceholder';
  if (text.includes(slot)) return { broad: true, kind: null };
  const starts = [...text.matchAll(/\b(?:at|on|from|via|in category) +/g)].map(m => m.index + m[0].length);
  const noun = text.match(/^(?:did|has|have|show(?: me)?|what (?:was|is)) +(?:(?:the|my|our|a|an) +)?/);
  if (noun && !/^(?:payment|deposit)(?: +of)? +(?:from|via)\b/.test(text.slice(noun[0].length).replace(paymentAmount, '').replace(/\s+/g, ' ').trim())) starts.push(noun[0].length);
  if (starts.length > 12) return { broad: original.broad, kind: null };
  const clean = value => value.replace(spendQuestionFiller, ' ').replace(paymentAmount, ' ').replace(/\s+/g, ' ').trim();
  const candidates = [];
  for (const start of starts) for (let end = start + 1; end <= text.length; end++) {
    if (end < text.length && !/[ ,?!.']/u.test(text[end])) continue;
    const label = text.slice(start, end).trimEnd(), cleaned = clean(label);
    if (!/[\p{L}\p{N}]/u.test(label) ||
        !/^[\p{L}\p{N}\p{M} &'()._/:#,$-]+$/u.test(label)) continue;
    // Only a terminal noun possessive/amount belongs to the payment grammar.
    // FROM names and internal possessives stay literal. A following possessive
    // marks the outer noun boundary even when the name itself ends in one.
    if (start === noun?.[0].length && !text.slice(end).startsWith("'s") &&
        (nounExternalAmount.test(label) || /'s$/.test(label))) continue;
    const before = text.slice(0, start).replace(spendQuestionFiller, ' ').replace(/^[ ,]+/, '');
    const after = text.slice(end).replace(spendQuestionFiller, ' ');
    const protectedText = before + slot + after;
    const parsed = classifyPayerQuestion(protectedText, { now, budget });
    const isPayer = parsed.kind === 'payment' || parsed.kind === 'merchant' && parsed.direction === 'inflow';
    const name = parsed.kind === 'payment' ? parsed.counterparty : parsed.match;
    if (!['merchant', 'category', 'payment'].includes(parsed.kind) || name !== slot) continue;
    // Protecting a name must not swallow account selection or explicit flags.
    // In particular, an unsupported account tail cannot become name text.
    if (parsed.mask !== (original.mask ?? null) || parsed.accountKind !== (original.accountKind ?? null) ||
        ['exactNamesOnly', 'ownTransfers', 'withdrawals', 'loanProceeds'].some(key => parsed[key] !== original[key])) continue;
    const raw = { ...parsed };
    if (isPayer) {
      const at = parsed.payerQuestion.text.indexOf(slot), delta = label.length - slot.length;
      const span = reading => ({ ...reading,
        ...(reading.label ? { label: reading.label.replace(slot, label) } : {}),
        ...(reading.parent ? { parent: reading.parent.replace(slot, label) } : {}),
        ...(Number.isInteger(reading.start) ? { start: reading.start > at ? reading.start + delta : reading.start,
          end: reading.end > at ? reading.end + delta : reading.end } : {}) });
      raw.payerQuestion = { ...parsed.payerQuestion, text: parsed.payerQuestion.text.replace(slot, label),
        amountSource: protectedText };
      raw.payerReadings = parsed.payerReadings.map(span);
      raw.payerClauseSets = parsed.payerClauseSets.map(clauses => clauses.map(span));
    }
    if (parsed.kind === 'payment') { raw.counterparty = label; raw.counterpartyWords = ledgerWords(label); }
    else raw.match = label;
    const cleanedText = before + cleaned + after;
    // For the cleaned reading the removed amount lies outside the selected
    // shortened name. Preserve that scope; it never applies to the RAW name.
    const alternate = cleaned ? classifyPayerQuestion(cleanedText, { now, budget, amountSource: before + label.replace(spendQuestionFiller, ' ') + after }) : { kind: null };
    // Removing an amount from a literal payer also changes the default
    // payment window (60 days without an amount, 30 with one). Preserve both
    // readings; the wider RAW read covers the CLEANED window as well.
    const today = ledgerDay(now);
    const defaultAmountWindow = raw.kind === 'payment' && raw.amountMinor === null &&
      Number.isSafeInteger(alternate.amountMinor) && raw.from === shiftLedgerDay(today, -59) && raw.to === today &&
      alternate.from === shiftLedgerDay(today, -29) && alternate.to === today;
    if (alternate.kind && (alternate.kind !== raw.kind || alternate.direction !== raw.direction ||
        (!defaultAmountWindow && (alternate.from !== raw.from || alternate.to !== raw.to)) ||
        alternate.mask !== raw.mask || alternate.accountKind !== raw.accountKind)) continue;
    candidates.push({ start, end, raw, cleaned: alternate, labels: [label, cleaned] });
  }
  // If cleanup changed a selector but no bounded original span survived,
  // it cannot fall back to certifying the shortened name.
  if (!candidates.length) return { broad: original.broad, kind: null };
  // A complete span takes precedence over its subspans. Independent selector
  // clauses remain under the existing multi-payer grammar and refusal rules.
  const maximal = candidates.filter(c => !candidates.some(other => other !== c &&
    other.start <= c.start && other.end >= c.end && (other.start < c.start || other.end > c.end)));
  if (maximal.length !== 1) return { ...original, selectorUnproven: true };
  const longest = maximal[0];
  const periodBoundary = new RegExp(`^ +(?:in|during|for|over) +(?:the +)?(?:${MONTHS.join('|')}|q[1-4]|last|this|so far|recent|\\d{4} so far)\\b`);
  const bounded = candidates.filter(candidate => candidate.start === longest.start && periodBoundary.test(text.slice(candidate.end)));
  const preferred = bounded[0] || longest;
  const { raw, cleaned, labels } = preferred;
  // No name text changed. Keep the existing grammar's scope and punctuation
  // guards, including unsupported terminal connector names.
  if (labels[0] === labels[1] && !merchant) return original;
  const alternatives = [longest, ...bounded].filter(candidate => candidate !== preferred);
  return { ...raw, selectorReadings: { raw, cleaned, labels, alternatives: alternatives.map(candidate => candidate.raw) } };
}
