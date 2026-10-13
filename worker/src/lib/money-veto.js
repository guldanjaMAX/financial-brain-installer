/** Deterministic last-word veto for document-backed money prose. Passing means
 * only that these guards found no mismatch; this module cannot approve a draft.
 * Document retrieval never proves a whole-window absence, regardless of a
 * model verdict or a document's claims about its own completeness. Ledger
 * answers have a separate deterministic route and do not enter this contract.
 */
import { answerSentences } from "./answer-sentences.js";
import { isAgentDerivedArtifact } from "./evidence-lineage.js";
import { parseCanonicalEvidenceDate, queryEntityAnchors, queryTimeWindow, reliableDocumentTime } from "./query-intent.js";

const MONEY_TOPIC = /\b(?:money|financial|bank|cards?|accounts?|statements?|charges?|charged|payments?|paid|unpaid|invoices?|bills?|owe[ds]?|due|refunds?|debits?|credits?|transactions?|spend|spent|expenses?|income|revenue|fees?|costs?|prices?|tax|salary|wages?|receipts?)\b/i;
const CURRENCY = /[$€£¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|dollars?|euros?|pounds?|cents?)\b/i;
const UNCONFIRMED = /\b(?:documents?|sources?|evidence|records?)\s+(?:do(?:es)? not|don['’]t|doesn['’]t|cannot|can['’]t)\s+(?:confirm|establish|cover|show|provide|answer|verify|prove)\b|\b(?:cannot|can['’]t|could not|unable to)\s+(?:be\s+)?(?:confirm|verify|establish|determine)\b|\b(?:not (?:confirmed|covered|established|verified|known)|unconfirmed|unknown|insufficient evidence)\b/i;
const ABSENCE = /\b(?:no|without|zero)\s+(?:(?:duplicate|unusual|missing|outstanding|unpaid|overdue|further|other|additional|remaining)\s+)*(?:charges?|payments?|balances?|bills?|invoices?|statements?|transactions?|debts?|amounts?|fees?|duplicates?)\b|\b(?:nothing|none)\s+(?:(?:is|was|are|were|remains?|else)\s+)*(?:due|owed|outstanding|missing|unpaid|overdue)\b|\b(?:all|every)\s+(?:[\w-]+\s+){0,4}(?:statements?|payments?|bills?|invoices?)\s+(?:(?:are|is|were|was|have been|has been)\s+)?(?:present|available|received|paid|complete|accounted for)\b|\b(?:complete (?:set|list)|no (?:duplicates?|anomalies)|paid (?:everything|in full))\b/i;
const MONTHS = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/gi;
const NUMBERS = /(?<![\p{L}\p{N}])[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:million|billion|thousand)|[kmb]|%)?(?![\p{L}\p{N}])/giu;
const CURRENCIES = /[$€£¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|dollars?|euros?|pounds?|cents?)\b/gi;
const NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)";
const WORD_FIGURES = new RegExp(`\\b${NUMBER_WORD}(?:[ -]+(?:and[ -]+)?${NUMBER_WORD})*\\b`, "gi");
const COVERAGE_QUESTION = /\b(?:duplicate|unusual|missing|all|every|complete|any)\b/i;
const ACCOUNT_IDS = /\b(?:account|card)\s+(?:(?:(?:number|ending(?: in)?|ends in|no\.)\s*|#\s*)([\p{L}\p{N}*xX-]+)|((?=[\p{L}\p{N}*-]*\d)[\p{L}\p{N}*-]+))\b/giu;
// These fixed renderer notices describe limits, not financial facts. Do not
// demand a bank citation for application copy or treat a request to check the
// full ledger as a claim that the retrieved subset is complete.
const SCOPE_NOTICE = /^(?:Lists only (?:accounts|invoices|bills) found in the retrieved evidence(?: with positive open balances)?, not a complete QuickBooks inventory\.|Check QuickBooks for the complete list\.|Amounts are per item\.|Credit memos and credit balances are not netted\.|No company-wide or net amount owed is established\.)$/;
const canonical = (text) => String(text || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const withoutCitations = (text) => String(text || "").replace(/\[\d+\]/g, "");
const matches = (text, re) => [...text.matchAll(re)].map((match) => canonical(match[0]));
// Decimal strings preserve magnitude and sign even beyond Number's safe range.
const decimal = text => {
  const parts = /^([-+−]?)([\d,]+)(?:\.(\d+))?\s*(thousand|million|billion|[kmb%])?$/.exec(canonical(text));
  if (!parts) return canonical(text);
  const [, sign, whole, fraction = "", suffix = ""] = parts;
  const shift = { k: 3, thousand: 3, m: 6, million: 6, b: 9, billion: 9 }[suffix] || 0;
  const digits = whole.replaceAll(",", "") + fraction.padEnd(shift, "0");
  const point = digits.length - Math.max(0, fraction.length - shift);
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, "");
  const tail = digits.slice(point).replace(/0+$/, "");
  return (sign === "-" || sign === "−" ? "-" : "") + integer + (tail ? `.${tail}` : "") + (suffix === "%" ? "%" : "");
};
const SMALL_WORDS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS_WORDS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function simpleWords(text) {
  const words = canonical(text).replaceAll("-", " ").split(/\s+/);
  let scale = 1;
  if (words.length === 1 && ["thousand", "million", "billion"].includes(words[0])) return text;
  if (["thousand", "million", "billion"].includes(words.at(-1))) {
    scale = { thousand: 1000, million: 1000000, billion: 1000000000 }[words.pop()];
  }
  let total = 0;
  if (words[1] === "hundred" && SMALL_WORDS.indexOf(words[0]) > 0 && SMALL_WORDS.indexOf(words[0]) < 10) {
    total = SMALL_WORDS.indexOf(words.shift()) * 100; words.shift();
    if (words[0] === "and") words.shift();
  }
  if (words.length === 1 && SMALL_WORDS.includes(words[0])) total += SMALL_WORDS.indexOf(words.shift());
  else if (TENS_WORDS.includes(words[0])) {
    total += (TENS_WORDS.indexOf(words.shift()) + 2) * 10;
    if (words.length === 1 && SMALL_WORDS.indexOf(words[0]) > 0 && SMALL_WORDS.indexOf(words[0]) < 10) total += SMALL_WORDS.indexOf(words.shift());
  }
  return words.length ? text : String(total * scale);
}
// Single marker and four-character display masks are recognized as whole
// groups. A suffix inside a longer or mixed mask is not an account identity.
const MASK = /(?<![\p{L}\p{N}*•])(?:x|•{4}|•|\*{4})(\d{4})(?![\p{L}\p{N}*•])/giu;
const normalizedFacts = text => canonical(text)
  .replace(WORD_FIGURES, simpleWords)
  .replace(MASK, "$1")
  .replace(/([-+−])([$€£¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY))\s*(?=\d)/gi, "$2 $1");
function accountIds(text) {
  return [
    ...[...normalizedFacts(text).matchAll(ACCOUNT_IDS)].map(match => canonical(match[1] || match[2])),
    ...[...String(text || "").matchAll(MASK)].map(match => match[1]),
    // Keep unsupported mask groups opaque on both sides of the decision;
    // otherwise an invalid mask in the claim can degrade to bare digits.
    ...matches(normalizedFacts(text), /(?<![\p{L}\p{N}*•])[x*•]+\d+(?![\p{L}\p{N}*•])/giu),
    ...[...String(text || "").matchAll(/\b(?:ending(?: in)?|ends in)\s+(\d{4})(?![\p{L}\p{N}])/giu)].map(match => match[1]),
  ];
}
const figuresIn = text => matches(normalizedFacts(text), NUMBERS).map(decimal);
const MONTH_ORDER = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
function monthsIn(text) {
  const months = matches(text, MONTHS).map(month => month.slice(0, 3));
  const range = new RegExp(`(${MONTHS.source})\\s*(?:[-–—]|through|to)\\s*(${MONTHS.source})`, "gi");
  for (const match of text.matchAll(range)) {
    const start = MONTH_ORDER.indexOf(match[1].toLowerCase().slice(0, 3));
    const end = MONTH_ORDER.indexOf(match[2].toLowerCase().slice(0, 3));
    // A wrapped range requires every intervening month too; no endpoint-only proof.
    for (let i = start; ; i = (i + 1) % 12) { months.push(MONTH_ORDER[i]); if (i === end) break; }
  }
  for (const match of text.matchAll(/\bq([1-4])\b/gi)) months.push(...MONTH_ORDER.slice((Number(match[1]) - 1) * 3, Number(match[1]) * 3));
  return [...new Set(months)];
}
const currencyCode = currency => ({ "$": "usd", dollars: "usd", dollar: "usd", "€": "eur", euro: "eur", euros: "eur", "£": "gbp", pound: "gbp", pounds: "gbp", "¥": "jpy", cent: "cent", cents: "cent" }[canonical(currency)] || canonical(currency));
const CURRENCY_TOKEN = `(?:[$€£¥]|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|dollars?|euros?|pounds?|cents?)\\b)`;
const RATE_WORD = "(?:monthly|annual(?:ly)?|yearly|weekly|daily|hourly|quarterly|biweekly|bimonthly|semiannual(?:ly)?|biennial(?:ly)?)";
const RATE = new RegExp(`^(?:\\s*(?:/\\s*|per\\s+|(?:a|an|each|every)\\s+)(months?|mo|years?|yr|annum|weeks?|days?|hours?|quarters?)\\b|\\s+(${RATE_WORD})\\b)`, "i");
const RATE_HINT = new RegExp(`\\b${RATE_WORD}\\b|\\b(?:per|every|each|a|an)\\s+(?:[a-z0-9-]+\\s+){0,2}(?:months?|mo|years?|yr|weeks?|days?|hours?|quarters?|fortnights?|annum)\\b|\\b(?:every|each)\\s*$`, "i");
const rateUnit = value => ({ mo: "month", months: "month", monthly: "month", yr: "year", years: "year", annum: "year", annual: "year", annually: "year", yearly: "year", weeks: "week", weekly: "week", days: "day", daily: "day", hours: "hour", hourly: "hour", quarters: "quarter", quarterly: "quarter" }[value] || value);
function amountFacts(text) {
  const normalized = normalizedFacts(text);
  const amounts = [...normalized.matchAll(NUMBERS)];
  return amounts.map((match, index) => {
    // Keep rate hints beside their own amount. A date or account number
    // cannot inherit a later amount's unit merely by sharing the sentence.
    const previous = amounts[index - 1];
    const before = normalized.slice(previous ? previous.index + previous[0].length : 0, match.index);
    const after = normalized.slice(match.index + match[0].length, amounts[index + 1]?.index);
    const prefix = new RegExp(`(${CURRENCY_TOKEN}(?:\\s*${CURRENCY_TOKEN})*)\\s*$`, "i").exec(before);
    const suffix = new RegExp(`^\\s*(${CURRENCY_TOKEN}(?:\\s*${CURRENCY_TOKEN})*)`, "i").exec(after);
    const codes = [...new Set(matches(`${prefix?.[1] || ""} ${suffix?.[1] || ""}`, CURRENCIES).map(currencyCode))];
    const rate = RATE.exec(suffix ? after.slice(suffix[0].length) : after);
    const ratePrefix = prefix ? before.slice(0, prefix.index) : before;
    // Rate words cannot be swallowed as filler. A plan's annual label may
    // precede a monthly fee, but two competing fee units remain ambiguous.
    const leadingRate = new RegExp(`\\b(${RATE_WORD})\\s+(?:(?!${RATE_WORD}\\b)[a-z-]+\\s+){0,6}$`).exec(ratePrefix);
    const earlierRates = leadingRate ? ratePrefix.slice(0, leadingRate.index) : "";
    const planLabel = new RegExp(`^\\s*${RATE_WORD}\\s+plan\\s+with\\s+$`).test(earlierRates);
    const competingLeadingRate = RATE_HINT.test(earlierRates) && !planLabel;
    const trailingUnit = rateUnit(rate?.[1] || rate?.[2] || "");
    const leadingUnit = rateUnit(leadingRate?.[1] || "");
    // Explicit but unparsed rate prose must not degrade to a unitless amount.
    // Ambiguous compound intervals stay on the refusing side of this veto.
    const unparsedRate = !leadingUnit && RATE_HINT.test(before.split(/[;.!?]|\band\b/).at(-1)) ||
      !trailingUnit && RATE_HINT.test(after.split(/[;.!?]|\band\b/)[0]);
    return { value: decimal(match[0]), currency: codes[0] || null,
      conflictingCurrency: codes.length > 1,
      conflictingRate: unparsedRate || competingLeadingRate || !!(trailingUnit && leadingUnit && trailingUnit !== leadingUnit),
      rate: trailingUnit || leadingUnit };
  });
}
const currencyInSpan = (claim, span) => {
  const currencies = new Set(matches(span, CURRENCIES).map(currencyCode));
  const money = amountFacts(span);
  // A bare shorthand can support a dollar rendering only when this entire
  // span has no explicit currency. Explicit currencies stay bound to amounts.
  return matches(claim, CURRENCIES).map(currencyCode).every(currency => currencies.has(currency) || (currency === "usd" && !currencies.size)) &&
    amountFacts(claim).filter(fact => fact.currency || fact.rate || fact.conflictingRate).every(fact => !fact.conflictingCurrency && !fact.conflictingRate && money.some(candidate =>
      !candidate.conflictingCurrency && !candidate.conflictingRate && candidate.value === fact.value && candidate.rate === fact.rate &&
      (!fact.currency || candidate.currency === fact.currency || (fact.currency === "usd" && !candidate.currency && !currencies.size))));
};

function moneySentences(text) {
  // NUL is refused at entry, so it cannot collide with original prose. Protect
  // only paired quoted labels; neither output nor the global splitter changes.
  const protectedText = text.replace(/["“][^"”\n]+["”]/g, (label) => label.replaceAll(".", "\0"));
  return answerSentences(protectedText).map((sentence) => sentence.replaceAll("\0", "."));
}

// Split independent financial assertions, retaining comma-separated month
// lists. Conjunctions cannot lend a predicate, account or date across claims.
function moneyClauses(text) {
  return moneySentences(text).flatMap(sentence => {
    // Retain "and" only inside a pure month-list tail. A month followed by
    // another account, predicate or qualifier must still start a new clause.
    const monthTail = new RegExp(`^\\s*${MONTHS.source}(?:\\s*,?\\s*(?:and\\s+)?${MONTHS.source})*\\s*[.!?]?\\s*$`, "i");
    const parts = sentence.split(/;|\b(?:but|however|while|whereas|then)\b|,\s*(?=(?:card|account|charged?|refunded?|paid|payment|invoice|fee)\b)/i);
    return parts.flatMap(part => part.split(/\band\b/i).reduce((clauses, piece) => {
      const previous = clauses.at(-1);
      if (previous && new RegExp(`${MONTHS.source}\\s*,?\\s*$`, "i").test(previous) && monthTail.test(piece)) clauses[clauses.length - 1] += ` and ${piece}`;
      else clauses.push(piece);
      return clauses;
    }, []));
  });
}

function quotedValues(text) {
  return [...text.matchAll(/["“]([^"”\n]+)["”]|`([^`\n]+)`/g)].map((match) => canonical(match[1] || match[2]));
}

const exactExcerpt = doc => String(doc.snippet || "").replace(/^\[[^\]\r\n]*\]\s*/, "");

function inSpan(sentence, question, doc, checkMonths = true, eventDateRequired = false) {
  // Only the exact excerpt supplied to the model is evidence. Titles, other
  // chunks and uncited records cannot lend a figure or an account identifier.
  const span = canonical(exactExcerpt(doc));
  const claim = withoutCitations(sentence);
  // A citation's reliable day is displayed beside the excerpt. An as-of date
  // can use that day, but a statement year or account number is still a scalar
  // that must occur in the body, never just the title or date metadata.
  const days = [...claim.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)];
  if (days.some(match => {
    const day = match[0];
    // A leading explicit as-of date describes the record, even when the
    // question asks about payment. It cannot lend its day to a payment,
    // posting or due-date assertion elsewhere in the same sentence.
    const observation = /^(?:No,\s*)?As of\s+$/i.test(claim.slice(0, match.index).trimStart()) &&
      reliableDocumentTime(doc) !== null;
    return !span.includes(day) && !((!eventDateRequired || observation) && String(doc.ts || "").startsWith(day));
  })) return false;
  const figures = figuresIn(claim.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""));
  const spanFigures = new Set(figuresIn(span));
  const months = monthsIn(claim);
  const spanMonths = new Set(monthsIn(span));
  const ids = accountIds(`${question}\n${claim}`);
  // A matching charge amount is not evidence of an account with those digits.
  const tokens = new Set(accountIds(span));
  return figures.every((figure) => spanFigures.has(figure)) &&
    matches(normalizedFacts(claim).replace(NUMBERS, ""), WORD_FIGURES).every((figure) =>
      matches(normalizedFacts(span).replace(NUMBERS, ""), WORD_FIGURES).includes(figure)) &&
    currencyInSpan(claim, span) &&
    (!checkMonths || months.every((month) => spanMonths.has(month))) &&
    ids.every((id) => tokens.has(id)) &&
    quotedValues(claim).every((quote) => span.includes(quote));
}

function boundMonths(doc, claim, question) {
  const ids = accountIds(`${question}\n${claim}`);
  // The exact dated excerpt is source prose, not an account/entity label that
  // must fit inside each clause. Recognize it locally by equality and citation,
  // never by caller-supplied offsets or a quotation substring. Question labels,
  // subject anchors and account IDs still bind each supporting month clause.
  const quote = /^(?:As|No, as) of \d{4}-\d{2}-\d{2}, the record states "([^"\n]+)" \[(\d+)\]\.$/.exec(claim);
  const wholeExcerpt = quote && quote[1] === exactExcerpt(doc) && Number(quote[2]) === doc.n;
  const labels = [...quotedValues(question), ...(wholeExcerpt ? [] : quotedValues(claim))];
  const anchors = wholeExcerpt ? queryEntityAnchors(question).map(canonical) : [];
  return moneyClauses(exactExcerpt(doc)).filter(span => {
    const present = new Set(accountIds(span));
    const words = ` ${canonical(span).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    return ids.every(id => present.has(id)) && labels.every(label => canonical(span).includes(label)) &&
      anchors.every(anchor => words.includes(` ${anchor.replace(/[^\p{L}\p{N}]+/gu, ' ')} `));
  }).flatMap(monthsIn);
}

function eventKind(question) {
  if (/\bdue\b/i.test(question)) return "due";
  if (/\b(?:posted|posting)\b/i.test(question)) return "posted";
  if (/\b(?:pay|paid|payment|payments|received|arrived)\b/i.test(question)) return "paid";
  return null;
}

const EXPLICIT_DATE = "(?:\\d{4}-\\d{2}-\\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4})";
function parseSpanDate(raw) {
  if (/^\d{4}-/.test(raw)) return parseCanonicalEvidenceDate(raw);
  const parts = raw.replace(",", "").split(/\s+/);
  const month = MONTH_ORDER.indexOf(parts[0].slice(0, 3).toLowerCase()) + 1;
  return parseCanonicalEvidenceDate(`${parts[2]}-${String(month).padStart(2, "0")}-${parts[1].padStart(2, "0")}`);
}
function eventDates(span, kind) {
  const label = kind === "due" ? "due(?: date)?" : kind === "posted" ? "post(?:ed|ing)(?: date)?" : "(?:paid|payment(?: date)?|received|arrived)";
  const pattern = new RegExp(`\\b${label}\\s*(?:(?:on|by|is|:|of)\\s*)?(${EXPLICIT_DATE})\\b`, "gi");
  return [...span.matchAll(pattern)].map(match => parseSpanDate(match[1])).filter(value => value !== null);
}
const CLAIM_GLUE = new Set("a an the and or of on in at for by to from with as is was were are be been has have had it this that card account ending ends number no date dated recorded statement says owner your my our".split(" "));
function claimTerms(text) {
  return (normalizedFacts(withoutCitations(text)).replace(new RegExp(EXPLICIT_DATE, "gi"), " ")
    .replace(CURRENCIES, " ").replace(NUMBERS, " ").match(/[\p{L}][\p{L}-]*/gu) || [])
    .filter(term => !CLAIM_GLUE.has(term));
}
function claimSpan(claim, question, doc) {
  if (!inSpan(claim, question, doc)) return false;
  // Scalars alone cannot bind an undated charge to a dated refund or a second
  // charge. Retain the predicate and item words as well as amount/account.
  const terms = claimTerms(claim), present = new Set(claimTerms(doc.snippet));
  return terms.length > 0 && terms.every(term => present.has(term));
}
function claimTime(doc, claim, question) {
  const stored = reliableDocumentTime(doc);
  if (stored !== null) return stored;
  // Do not promote metadata, use a title/header date, or borrow a date from a
  // neighboring sentence. A fallback needs one unambiguous, valid claim day.
  const body = exactExcerpt(doc);
  const dates = moneyClauses(body)
    .filter(snippet => claimSpan(claim, question, { ...doc, snippet, ts: "" }))
    .flatMap(snippet => [...snippet.matchAll(new RegExp(`\\b(${EXPLICIT_DATE})\\b`, "gi"))].map(match => parseSpanDate(match[1])));
  const unique = [...new Set(dates)];
  return unique.length === 1 && unique[0] !== null ? unique[0] : null;
}

function primary(doc) {
  // Missing derivation metadata does not make an older primary record an
  // agent restatement. It may support its own dated span, without earning
  // independent-corroboration credit. Explicit agent demotions still win.
  return doc.lineage?.kind !== "agent_derived" &&
    doc.authority?.tier !== "T4" && doc.authority?.eligible !== false &&
    !isAgentDerivedArtifact(doc);
}

// Shared only to keep other refuse-only guards outside the money contract.
export function isMoneyAnswer(question, answer) {
  return MONEY_TOPIC.test(`${question || ""} ${answer || ""}`) || CURRENCY.test(answer || "") ||
    /\b(?:(?:my|our|account|card|bank|checking|savings|loan|current|available|outstanding)\s+balances?|balances?\s+(?:of|on|in|for|due))\b/i.test(`${question || ""} ${answer || ""}`);
}

export function applyMoneyVeto({ question, answer, evidenceGate, docs = [], now = Date.now() } = {}) {
  const unchanged = { answer, evidenceGate };
  if (!answer || evidenceGate?.supported !== true) return unchanged;
  if (!isMoneyAnswer(question, answer)) return unchanged;
  const diagnostic = (rule, refused = true) => ({ type: "money_veto", rule, count: 1,
    detail: refused ? "The money evidence check refused a claim." : "The money evidence check qualified an incomplete answer." });
  const veto = (rule, reason) => ({ gap: diagnostic(rule), answer: null, evidenceGate: {
    ...evidenceGate, supported: false, complete: false, evidence: [], reason,
  } });
  if (answer.includes("\0")) return veto("ambiguous_boundary", "A money claim contains an ambiguous text boundary.");
  const window = queryTimeWindow(question, { now });
  let incomplete = false, claimDateUnknown = false;
  for (const sentence of moneySentences(answer)) {
    if (SCOPE_NOTICE.test(sentence)) continue;
    // An explicit limit is a partial answer, never a positive absence claim.
    // Keep any factual prefix in a mixed sentence subject to the same checks.
    const uncertainty = sentence.search(UNCONFIRMED);
    if (uncertainty >= 0) incomplete = true;
    const contrast = uncertainty >= 0 ? /[,;]\s*(?:but|however|yet)\b/i.exec(sentence.slice(uncertainty)) : null;
    const prefix = uncertainty >= 0 ? sentence.slice(0, uncertainty) : sentence;
    // "Payment status is unconfirmed" carries no affirmative financial fact.
    // Preserve it as a limit without asking it to cite an invented status.
    if (uncertainty >= 0 && !contrast && !CURRENCY.test(prefix) &&
        !matches(withoutCitations(prefix), NUMBERS).length) continue;
    const claim = uncertainty >= 0
      ? prefix + (contrast ? sentence.slice(uncertainty + contrast.index + contrast[0].length) : "")
      : sentence;
    if (!claim.trim() || !/[\p{L}\p{N}]/u.test(claim)) continue;
    if (ABSENCE.test(claim) || (COVERAGE_QUESTION.test(question) && /^(?:yes|no|none)\b/i.test(claim))) return veto("document_coverage", "Only a ledger can establish absence or completeness over the whole window; document excerpts cannot.");
    const hasFacts = CURRENCY.test(claim) || MONEY_TOPIC.test(claim) ||
      figuresIn(withoutCitations(claim)).length || monthsIn(claim).length || matches(claim, WORD_FIGURES).length;
    if (!hasFacts) continue;
    const numbers = [...sentence.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    const cited = docs.filter((doc) => numbers.includes(doc.n) && evidenceGate.evidence?.includes(doc.n));
    if (!cited.length) return veto("missing_citation", "A money claim has no exact cited span.");
    const times = new Map(cited.map(doc => [doc, claimTime(doc, claim, question)]));
    if (cited.some((doc) => times.get(doc) === null)) return veto("unreliable_date", "A supporting money citation has no reliable date.");
    const records = cited.filter(primary);
    if (!records.length) return veto("ineligible_support", "Money claims need eligible non-agent support; agent-derived or T4 material alone is insufficient.");
    const kind = eventKind(question);
    const supporting = records.filter(doc => inSpan(claim, question, doc, false, Boolean(kind)));
    const spanMonths = new Set(supporting.flatMap(doc => boundMonths(doc, claim, question)));
    if (!supporting.length || !monthsIn(claim).every(month => spanMonths.has(month))) return veto("span_mismatch", "A money figure, month list or account identifier does not match the exact cited span.");
    if (window) {
      if (kind) {
        // Bind dates to the same supported claim, not an unrelated line in the
        // invoice, and never substitute the document's creation date.
        const dates = supporting.flatMap(doc => moneyClauses(exactExcerpt(doc))
          .filter(snippet => claimSpan(claim, question, { ...doc, snippet, ts: "" }))
          .flatMap(snippet => eventDates(snippet, kind)));
        const unique = [...new Set(dates)];
        if (unique.length !== 1) { incomplete = true; claimDateUnknown = true; }
        else if (unique[0] < window.start || unique[0] >= window.end) {
          return veto("claim_outside_window", "The supported money claim date falls outside the question's window.");
        }
      } else if (cited.some(doc => times.get(doc) < window.start || times.get(doc) >= window.end)) {
        return veto("citation_outside_window", "A supporting money citation falls outside the question's window.");
      }
    }
  }
  if (incomplete) return { gap: diagnostic(claimDateUnknown ? "claim_date_unknown" : "incomplete_claim", false), answer, evidenceGate: { ...evidenceGate, complete: false, partial: true,
    ...(claimDateUnknown ? { reason: "The cited span does not establish the payment, posting or due date within the requested window." } : {}) } };
  return unchanged;
}
