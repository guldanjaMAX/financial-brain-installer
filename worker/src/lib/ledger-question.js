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
  let from, to, boundaryResidual, connector = null, residual = q.trim().replace(/[?!.]+$/, "").trim();
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
    connector = prefix.trim().split(/\s+/)[0] || null;
  }
  return { from, to, residual, boundaryResidual, period: periods[0]?.[0], connector };
}

// One "for <period>" clause, the same period vocabulary questionPeriod reads.
const forPeriodClause = new RegExp(`\\bfor\\s+(?:the\\s+)?((?:${MONTHS.join("|")})(?:\\s+(?:of\\s+)?\\d{4})?|q[1-4](?:\\s+\\d{4})?|last\\s+\\d+\\s+days|(?:last|this) month|so far this year|\\d{4} so far)\\b`);

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
const labelAmount = new RegExp(paymentAmount.source, 'iu');
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
    let rest = withoutMasks(q), forDate = null;
    // Round 7, ruling 3: a single date is a <period> for partner answer 10.
    // "for <date>" can name the day a payment covers, not when it arrived, so
    // it is carried as the for-period and the answer refuses with a "received
    // on <date>" note instead of a silent refusal. The text is the matched
    // date only, never payer text.
    const date = (match, day) => {
      dates.push(day);
      const lead = q.slice(0, match.index).match(/\bfor\s+(?:the\s+)?$/);
      if (lead && forDate === null && rest.includes(lead[0] + match[0])) {
        forDate = match[0]; rest = rest.replace(lead[0] + match[0], "");
      } else rest = rest.replace(match[0], "");
    };
    for (const m of q.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) date(m, calendarDay(m[1], m[2], m[3]));
    for (const m of q.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "g"))) {
      date(m, calendarDay(m[3] || today.slice(0, 4), MONTHS.indexOf(m[1]) + 1, m[2]));
    }
    for (const m of q.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`, "g"))) {
      date(m, calendarDay(m[3], MONTHS.indexOf(m[2]) + 1, m[1]));
    }
    for (const m of q.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) date(m, calendarDay(m[3], m[1], m[2]));
    if (dates.some(d => !d) || new Set(dates).size > 1) return intent;
    let period = dates.length ? { residual: rest } : questionPeriod(rest, today), coveredPeriod = null;
    // A "for <date>" beside an explicit arrival window ("for 2026-09-10
    // arrive in October 2026") reads that window, as answer 10's for-period
    // does (R4-QUESTION-6). A second for-clause or two windows refuse.
    if (forDate) {
      const arrivalWindow = questionPeriod(rest, today);
      if (arrivalWindow.invalid || arrivalWindow.connector === 'for') return intent;
      if (arrivalWindow.period) period = arrivalWindow;
    }
    // Partner answer 10 also covers "for <period>" beside an explicit arrival
    // window ("for September 2026 arrive in October 2026"): read the other
    // period as the window and carry the for-period, so the answer refuses
    // with the same note instead of a silent refusal. Absence is never read.
    if (period.invalid && !dates.length) {
      const covered = rest.match(forPeriodClause);
      const arrivalWindow = covered && questionPeriod(`${rest.slice(0, covered.index)} ${rest.slice(covered.index + covered[0].length)}`, today);
      const named = covered && questionPeriod(covered[1], today);
      if (arrivalWindow && !arrivalWindow.invalid && arrivalWindow.period && !named.invalid && named.period) {
        period = arrivalWindow; coveredPeriod = named.period;
      }
    }
    if (period.invalid) return intent;
    // Partner answer 10: "for <period>" can name the period a payment covers,
    // not when it arrived. Keep the reading so the answer can refuse with a
    // note asking for "received in <period>"; it never certifies absence.
    const forPeriod = forDate || coveredPeriod || (period.connector === 'for' ? period.period : null);
    // A bare month still cannot date an exact payment. Keep the original
    // ambiguity control; an explicit year or relative bounded window is needed.
    // "for <bare month>" is still answer 10's for-period: it refuses with the
    // note (asking for the year) instead of a silent document route (round 6,
    // R6-QUESTION-6). The window is never read for it.
    if (period.period && MONTHS.includes(period.period) && !forPeriod) return intent;
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
      ...(selectorSlot ? { selectorSlotParts: parties } : {}), ...(forPeriod ? { forPeriod } : {}),
      from: period.from || (dates.length ? shiftLedgerDay(dates[0], -7) : shiftLedgerDay(today, amountMinor === null ? -59 : -29)),
      to: period.to || (dates.length ? shiftLedgerDay(dates[0], 7) : today) };
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
  intent.amountMinor, intent.ownTransfers, intent.withdrawals, intent.loanProceeds, intent.exactNamesOnly, intent.forPeriod]);

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


// Partner answers 5, 9, 11 and 13 (round 3) are closed rewrites of the raw
// question. They run once, before any selector span is protected, so every
// parse below, and the payer clauses registry mentions are read from, see the
// same rewritten text. A question none of them touches is passed unchanged.
// The two lists are exactly the partner's, no additions.
export const paymentQualifiers = Object.freeze(['any', 'latest', 'last', 'recent', 'monthly', 'invoice', 'ach', 'wire']);
export const paymentChannels = Object.freeze(['ach', 'zelle', 'wire', 'check', 'venmo', 'paypal']);
const questionRefused = Symbol('question refused at classification');
// Answer 5 says "anywhere": after a comma, semicolon or dash, or in brackets.
// The separator or the bracket pair goes with the phrase, and so does the one
// word that introduces it in a sentence, "with" or "using" (R5-QUESTION-3).
const exactNamesOnlyBracketed = /[\s,;\-\u2013\u2014]*\(\s*(?:(?:with|using)\s+)?exact\s+names\s+only\s*\)/giu;
const exactNamesOnlyPhrase = /(?:^\s*|[\s,;\-\u2013\u2014]+)(?:(?:with|using)\s+)?exact\s+names\s+only\b(?:\s*[:;](?=\s)|[\s,;\-\u2013\u2014]*)/giu;
const slotArticles = new Set(['the', 'my', 'our', 'a', 'an']);
// A word that can name a payer: not grammar (months, connectors, date words,
// arrival verbs, quarters), not an article, not a number or an amount.
const payerSlotWord = word => /^\p{L}/u.test(word) && !payerTerminalWords.has(word) && !slotArticles.has(word) && !/^q[1-4]$/.test(word);
// Auxiliaries that can open the question; inside the slot they are grammar.
const slotAuxiliaries = new Set(['did', 'has', 'have', 'was', 'is', 'were', 'are']);
// Answer 13 sets no position: a closed channel is stripped wherever it is
// followed by a clause boundary: punctuation, the end, a grammar word, an
// amount clause ("via ACH of $25"; R4-QUESTION-3) or a FROM clause ("via Zelle
// from <name>"; R4-QUESTION-2). A channel followed by more name words ("via
// ACH transfer") is not a closed channel and is refused below. "via wire from
// <name>" is no exception: the channel is stripped and <name> is the payer
// (round 7, ruling 6).
// The question's own tail grammar, the words the payment grammar consumes
// after the arrival verb ("yet", "please", "and when"), is a boundary too
// (R5-QUESTION-1).
const clauseBoundary = `(?=\\s*(?:[?!.,;:)]|$)|\\s+(?:${[...payerTerminalWords].filter(word => !['from', 'via', 'by', 'of'].includes(word)).join('|')})\\b|` +
  `\\s+(?:yet|please|and\\s+when)\\b|\\s+(?:of|for)\\s+(?:${paymentAmount.source}))`;
const channelPhrase = new RegExp(`(?:\\s*,)?\\s+via\\s+(?:${paymentChannels.join('|')})\\b${clauseBoundary}`, 'giu');
const channelBeforeFrom = new RegExp(`(?:\\s*,)?\\s+via\\s+(?:${paymentChannels.join('|')})(?=\\s+from\\b)`, 'giu');
const paymentQualifierSet = new Set(paymentQualifiers);
// Answer 9 strips the closed list from the slot before the question's own
// "payment". Dates, periods and amounts may share that slot ("Payer One's
// last month payment"); "recent" is on the closed list, so it is a qualifier
// there, not the 14-day window.
const slotPeriod = `\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4}|q[1-4](?: +\\d{4})?|` +
  `(?:${MONTHS.join('|')})(?: +\\d{1,2}(?:st|nd|rd|th)?)?(?:,? +\\d{4})?|\\d{1,2}(?:st|nd|rd|th)? +(?:${MONTHS.join('|')})(?: +\\d{4})?|` +
  `(?:last|this) +month|last +\\d+ +days|so far this year|\\d{4} so far`;
// A hyphenated run ("e-check", "pre-paid") is one slot word, and a digit-led
// ordinal outside a date or period ("2nd", "10th") is a slot word too: each
// is one unlisted qualifier beside a named payer, never grammar and never a
// second payer clause (R5-QUESTION-2).
const slotToken = new RegExp(`(?<![\\p{L}\\p{N}])(?:${slotPeriod}|${paymentAmount.source})(?![\\p{L}\\p{N}])|([\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*)`, 'giu');
const slotOrdinal = /^\d+(?:st|nd|rd|th)$/;
function paymentSlot(slot) {
  // Words are classified in the grammar's own form (NFKC, lower case), so a
  // compatibility spelling of an auxiliary or article stays grammar.
  const tokens = [...slot.matchAll(slotToken)].map(m => {
    const word = m[1]?.normalize('NFKC').toLowerCase();
    return { start: m.index, end: m.index + m[0].length,
      kind: !m[1] ? 'scope' : paymentQualifierSet.has(word) ? 'qualifier'
        : (payerSlotWord(word) || slotOrdinal.test(word)) && !slotAuxiliaries.has(word) ? 'payer' : 'grammar' };
  });
  const without = list => list.reduceRight((text, token) => text.slice(0, token.start) + text.slice(token.end), slot)
    .replace(/\s+/g, ' ').trim();
  // The closed run leading a noun payer ("the latest Payer One payment"). The
  // statement vocabulary on answer 9's list (ach, wire, invoice) is stripped
  // there too: "the ACH Payer One payment" names "Payer One" (round 7, ruling
  // 7). The unstripped slot stays a competing reading, so a registered name
  // that begins with a listed word ("Wire Works") still answers exactly.
  const leading = [];
  for (const token of tokens) {
    if (token.kind !== 'qualifier') break;
    leading.push(token);
  }
  // The same closed run directly before "payment", after the last payer word
  // ("the Payer One monthly payment", "the Payer One ACH payment";
  // R5-FIDELITY-1 and ruling 7).
  const trailing = [];
  if (tokens.some(token => token.kind === 'payer')) for (const token of tokens.toReversed()) {
    if (token.kind !== 'qualifier') break;
    trailing.push(token);
  }
  const payerWords = tokens.filter(token => token.kind === 'payer').length;
  // A comma that only set a stripped run off from the payer goes with the run
  // ("the Payer One, ACH payment" names "Payer One"; ruling 7). The
  // unstripped slot, comma included, stays the competing reading.
  const unmark = (text, lead, trail) => text.replace(lead ? /^[\s,]+/ : /^\s+/, '').replace(trail ? /[\s,]+$/ : /\s+$/, '');
  return { payer: payerWords > 0, payerWords, qualified: tokens.some(token => token.kind === 'qualifier'),
    stripped: without(tokens.filter(token => token.kind === 'qualifier')),
    nounQualified: leading.length + trailing.length > 0,
    nounStripped: unmark(without([...leading, ...trailing.toReversed()]), leading.length > 0, trailing.length > 0),
    leadQualified: leading.length > 0, leadStripped: unmark(without(leading), leading.length > 0, false) };
}
// The question's own noun is "payment" or "deposit": answer 9's closed list
// is stripped before "deposit" the same way (round 7, ruling 1).
const ownPaymentNoun = new RegExp(`\\b(?:payment|deposit)\\b(?=\\s*(?:[?!.,;:]|$)|\\s+(?:${ARRIVAL}|from|via|of|for|by|in|on|into|to|yet|and|during|over|before|after|between)\\b|\\s+(?:${paymentAmount.source}))`, 'iu');
// The amount may also be followed by a relative period the window grammar
// reads ("of $25 last month arrive"; round 6, R6-QUESTION-2).
const amountAfterName = new RegExp(`\\bfrom\\s+(\\S(?:[\\s\\S]*?\\S)?)(?:\\s+(?:of|for)\\s+(${paymentAmount.source})\\s*,?|\\s*,\\s*(${paymentAmount.source})\\s*,)` +
  `(?=\\s*(?:[?!.]|$)|\\s+(?:${ARRIVAL}|in|on|into|to|during|over|before|after|between|yet|and)\\b|` +
  `\\s+(?:(?:last|this)\\s+month|last\\s+\\d+\\s+days|so\\s+far\\s+this\\s+year|\\d{4}\\s+so\\s+far|recent)\\b)`, 'iu');

function rewriteLedgerQuestion(question, { nounLead = true } = {}) {
  const original = String(question ?? '');
  // Same whole-question cap as the span parser, which refuses longer text
  // anyway; it also bounds the rewrite patterns below.
  if (original.length > 1024) return question;
  // The rewrites read the compatibility form the grammar reads (R5-QUESTION-4):
  // a code point whose NFKC form is plain ASCII letters, digits, "$" or spaces
  // (full-width Latin, a ligature) is read in that form, and comma variants
  // are commas. Other punctuation keeps its raw spelling, since the
  // unsupported-punctuation decision is made before normalization. Every
  // parse normalizes again, so the forms are equivalent there; a question no
  // rewrite changes is still passed on unchanged.
  const read = normalizePayerCommas(original).replace(/[^\x00-\x7f]/gu, char => {
    const form = char.normalize('NFKC');
    return form !== char && /^[A-Za-z0-9$ ]+$/.test(form) ? form : char;
  });
  let text = read, exactNamesOnly = false;
  // Answer 5: "exact names only" anywhere is removed, then restated once at
  // the end of the question, the one place every parse already reads it.
  const flip = () => { exactNamesOnly = true; return ' '; };
  text = text.replace(exactNamesOnlyBracketed, flip).replace(exactNamesOnlyPhrase, flip);
  if (/\b(?:payment|deposit|paid)\b/iu.test(text) && new RegExp(`\\b(?:${ARRIVAL})\\b`, 'iu').test(text)) {
    // Answer 13: "via <channel>" for the closed channel list is removed. A
    // comma before "via" that closes the answer-11 ", $25," amount form stays,
    // so ", $25, via Zelle arrive" reads as ", $25, arrive" (round 6,
    // R6-QUESTION-1).
    const closingAmountComma = new RegExp(`,\\s*(?:${paymentAmount.source})\\s*$`, 'iu');
    const keepAmountComma = (match, ...rest) => {
      const [offset, whole] = rest.slice(-2);
      // ", $25, via Zelle, arrive" already has its closing comma after the
      // channel; only a channel the comma alone set off keeps it.
      return /^\s*,/.test(match) && closingAmountComma.test(whole.slice(0, offset)) &&
        !/^\s*[,;:.?!)]/.test(whole.slice(offset + match.length)) ? ',' : '';
    };
    text = text.replace(channelPhrase, keepAmountComma).replace(channelBeforeFrom, keepAmountComma);
    // Answer 13: "Refuse other 'via' phrases." Every "via" phrase left after
    // the closed channels are stripped refuses at classification, wherever it
    // sits: after a named payer, alone ("the payment via <name>", which can
    // name a channel or an intermediary; R4-FIDELITY-6, round 7 ruling 4) or
    // before a FROM clause ("the payment via <unlisted> from <payer>";
    // R4-QUESTION-2, ruling 5). It is never read as a payer clause.
    if (/\bvia\s+\S/iu.test(text)) return questionRefused;
    // Answer 9: the slot before the question's own "payment" or "deposit"
    // (the first one; ruling 1). Beside a FROM payer anywhere, or after a
    // payer's possessive, closed qualifiers there are stripped. One other word
    // there is an unlisted qualifier, and a closed qualifier mixed with other
    // words is a qualifier run: both refuse, since a qualifier is never a
    // second payer. Two or more other words and no closed qualifier stay the
    // established noun payer clause ("the Payer One payment from Payer Two"),
    // with no registry check: an unlisted phrase such as "direct deposit" or
    // "bill pay" there is a second payer clause refused at the answer (round
    // 7, ruling 8 (b)). A closed qualifier inside a FROM name ("Owner's
    // Monthly Payment Services") is never in that slot. The slot is found the
    // same way whatever the auxiliary ("did", "has", "was", "is" or none),
    // since answer 9 names none (R4-QUESTION-8). The question's own noun is
    // the first one followed by grammar (an arrival verb, a clause word, an
    // amount or the end), never a "Payment" inside a name ("the Payer Payment
    // One payment").
    // A leading "please" (with or without a comma) is filler the payment
    // grammar itself consumes, never a slot word (round 6, R6-FIDELITY-1).
    const payment = ownPaymentNoun.exec(text);
    if (payment) {
      const head = text.slice(0, payment.index), tail = text.slice(payment.index);
      const lead = /^\s*(?:please\b\s*,?\s*)?(?:(?:did|has|have|was|is|were|are)\s+)?(?:(?:the|my|our|a|an)\s+)?/iu.exec(head);
      const named = /\b(?:from|via)\s+\S/iu.test(text);
      const possessive = !named && lead ? [...head.matchAll(/['’]s\s+/giu)].filter(m => m.index >= lead[0].length).at(-1) : null;
      const start = possessive ? possessive.index + possessive[0].length : lead ? lead[0].length : null;
      if (start !== null && !/\b(?:from|via)\b/iu.test(head.slice(start))) {
        const slot = paymentSlot(head.slice(start));
        let replacement = null;
        if (named || possessive) {
          if (slot.payerWords === 1 || (slot.payer && slot.qualified)) return questionRefused;
          if (slot.qualified) replacement = slot.stripped;
        } else if (!slot.payer) {
          if (slot.qualified) replacement = slot.stripped;
        } else if (nounLead && slot.nounQualified) {
          // A noun payer that begins or ends with closed qualifiers ("the
          // latest Payer One payment", "the Payer One monthly payment";
          // R5-FIDELITY-1). The unstripped slot remains a competing reading.
          replacement = slot.nounStripped;
        }
        // The same closed run leading a possessive noun payer ("the latest
        // Payer One's payment") is stripped from the owner, and the
        // unstripped owner remains a competing reading, exactly as for the
        // noun form above (round 6, R6-QUESTION-5).
        let prefix = head.slice(0, start);
        if (possessive && nounLead) {
          const owner = paymentSlot(head.slice(lead[0].length, possessive.index));
          if (owner.payer && owner.leadQualified)
            prefix = `${head.slice(0, lead[0].length)}${owner.leadStripped}${head.slice(possessive.index, start)}`;
        }
        if (replacement !== null || prefix !== head.slice(0, start))
          text = `${prefix}${replacement === null ? head.slice(start) : replacement ? `${replacement} ` : ''}${tail}`;
      }
    }
    // Answer 11: "of $25", "for $25" or ", $25," after the FROM name is amount
    // scope, read exactly as "payment of $25 from <name>".
    const moved = text.match(amountAfterName);
    if (moved) {
      const head = text.slice(0, moved.index), tail = text.slice(moved.index + moved[0].length);
      // A second amount is a conflicting scope, never part of the payer name.
      if (new RegExp(paymentAmount.source, 'iu').test(head)) return questionRefused;
      const noun = [...head.matchAll(/\b(?:payment|deposit)\b/giu)].at(-1);
      const end = noun ? noun.index + noun[0].length : -1;
      if (noun && !/^\s+of\b/iu.test(head.slice(end))) {
        const amount = (moved[2] || moved[3]).replace(/,+$/, '');
        text = `${head.slice(0, end)} of ${amount}${head.slice(end)}from ${moved[1]}${tail}`;
      }
    }
  }
  if (exactNamesOnly) text = text.replace(/^\s+/, '').replace(/[\s,]*([?!.]*)\s*$/u, ', exact names only$1');
  return text === read ? question : text;
}

// Cleanup is an alternative interpretation, not authority to edit a name.
// Reuse the bounded grammar with an opaque slot, preserving the literal span
// and deriving amount scope only from text outside it. The reader decides
// between these interpretations using its one covered snapshot and registry.
export function classifyLedgerQuestion(question, { now = Date.now(), parseLimit = ledgerQuestionLimits.parses } = {}) {
  const rewritten = rewriteLedgerQuestion(question);
  if (rewritten === questionRefused) return { broad: classifyQuestionGrammar(question, { now }).broad, kind: null };
  const intent = classifyRewrittenQuestion(rewritten, now, parseLimit);
  // A noun payer slot that began with a closed qualifier was stripped. Keep
  // the unstripped reading beside it (same scope, a different name): the
  // reader takes whichever one is exact and refuses when both are.
  const unstripped = rewriteLedgerQuestion(question, { nounLead: false });
  if (intent.kind === 'payment' && intent.counterpartyWords?.length && unstripped !== rewritten && unstripped !== questionRefused) {
    const alternative = classifyRewrittenQuestion(unstripped, now, parseLimit);
    if (alternative.kind === 'payment' && alternative.counterpartyWords?.length && alternative.counterparty !== intent.counterparty &&
        alternative.from === intent.from && alternative.to === intent.to && alternative.amountMinor === intent.amountMinor)
      intent.unstrippedReading = alternative;
  }
  return intent;
}

function classifyRewrittenQuestion(question, now, parseLimit) {
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
    // A literal name never absorbs an amount together with a period clause
    // ("payer one of $25 last month"): both are scope, not name text (round
    // 6, R6-QUESTION-2; the span parser applies labelPeriodClause the same way).
    if (labelAmount.test(label) && labelPeriodClause.test(label)) continue;
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
