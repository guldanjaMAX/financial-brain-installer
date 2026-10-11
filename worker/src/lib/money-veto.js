/** Deterministic last-word veto for document-backed money prose. Passing means
 * only that these guards found no mismatch; this module cannot approve a draft.
 * Document retrieval never proves a whole-window absence, regardless of a
 * model verdict or a document's claims about its own completeness. Ledger
 * answers have a separate deterministic route and do not enter this contract.
 */
import { answerSentences } from "./answer-sentences.js";
import { isAgentDerivedArtifact } from "./evidence-lineage.js";
import { parseCanonicalEvidenceDate, queryTimeWindow, reliableDocumentTime } from "./query-intent.js";

const MONEY_TOPIC = /\b(?:money|financial|bank|cards?|accounts?|statements?|charges?|charged|payments?|paid|unpaid|invoices?|bills?|owe[ds]?|due|refunds?|debits?|credits?|transactions?|spend|spent|expenses?|income|revenue|fees?|costs?|prices?|tax|salary|wages?|receipts?)\b/i;
const CURRENCY = /[$€£¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|dollars?|euros?|pounds?|cents?)\b/i;
const UNCONFIRMED = /\b(?:documents?|sources?|evidence|records?)\s+(?:do(?:es)? not|don['’]t|doesn['’]t|cannot|can['’]t)\s+(?:confirm|establish|cover|show|provide|answer|verify|prove)\b|\b(?:cannot|can['’]t|could not|unable to)\s+(?:be\s+)?(?:confirm|verify|establish|determine)\b|\b(?:not (?:confirmed|covered|established|verified|known)|unconfirmed|unknown|insufficient evidence)\b/i;
const ABSENCE = /\b(?:no|without|zero)\s+(?:(?:duplicate|unusual|missing|outstanding|unpaid|overdue|further|other|additional|remaining)\s+)*(?:charges?|payments?|balances?|bills?|invoices?|statements?|transactions?|debts?|amounts?|fees?|duplicates?)\b|\b(?:nothing|none)\s+(?:(?:is|was|are|were|remains?|else)\s+)*(?:due|owed|outstanding|missing|unpaid|overdue)\b|\b(?:all|every)\s+(?:[\w-]+\s+){0,4}(?:statements?|payments?|bills?|invoices?)\s+(?:(?:are|is|were|was|have been|has been)\s+)?(?:present|available|received|paid|complete|accounted for)\b|\b(?:complete (?:set|list)|no (?:duplicates?|anomalies)|paid (?:everything|in full))\b/i;
const MONTHS = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/gi;
const NUMBERS = /(?<![\p{L}\p{N}])[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:million|billion|thousand)|[kmb]|%)?(?![\p{L}\p{N}])/giu;
const CURRENCIES = /[$€£¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|dollars?|euros?|pounds?|cents?)\b/gi;
const MONEY_LITERALS = new RegExp(`[-+−]?(?:[$€£¥]\\s*|\\b(?:USD|EUR|GBP|CAD|AUD|JPY)\\s+)${NUMBERS.source}`, "giu");
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
// Decimal strings keep exact magnitude without floating point or lost signs.
const decimal = text => canonical(text).replaceAll(",", "").replace("−", "-")
  .replace(/^\+/, "").replace(/^(-?)0+(?=\d)/, "$1")
  .replace(/(\.\d*?)0+(?=\s*(?:million|billion|thousand|[kmb%])?$)/, "$1")
  .replace(/\.(?=\s*(?:million|billion|thousand|[kmb%])?$)/, "");
const figuresIn = text => matches(text.replace(/([-+−])([$€£¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY))\s*(?=\d)/gi, "$2 $1"), NUMBERS).map(decimal);
const monthsIn = text => matches(text, MONTHS).map(month => month.slice(0, 3));
const moneyIn = text => matches(text, MONEY_LITERALS).map(literal => {
  const pair = /^([-+−]?)([$€£¥]|[a-z]+)\s*(.*)$/i.exec(literal);
  return JSON.stringify([pair[2], decimal(pair[1] + pair[3])]);
});
const currencyInSpan = (claim, span) => {
  const currencies = new Set(matches(span, CURRENCIES));
  const money = new Set(moneyIn(span));
  // Finding CAD beside one amount and USD beside another cannot establish a
  // new CAD/amount pair, even though both tokens occur in the same excerpt.
  return matches(claim, CURRENCIES).every((currency) => currencies.has(currency)) &&
    moneyIn(claim).every((literal) => money.has(literal));
};

function moneySentences(text) {
  // NUL is refused at entry, so it cannot collide with original prose. Protect
  // only paired quoted labels; neither output nor the global splitter changes.
  const protectedText = text.replace(/["“][^"”\n]+["”]/g, (label) => label.replaceAll(".", "\0"));
  return answerSentences(protectedText).map((sentence) => sentence.replaceAll("\0", "."));
}

function quotedValues(text) {
  return [...text.matchAll(/["“]([^"”\n]+)["”]|`([^`\n]+)`/g)].map((match) => canonical(match[1] || match[2]));
}

function inSpan(sentence, question, doc) {
  // Only the exact excerpt supplied to the model is evidence. Titles, other
  // chunks and uncited records cannot lend a figure or an account identifier.
  const span = canonical(String(doc.snippet || "").replace(/^\[[^\]\r\n]*\]\s*/, ""));
  const claim = withoutCitations(sentence);
  // A citation's reliable day is displayed beside the excerpt. An as-of date
  // can use that day, but a statement year or account number is still a scalar
  // that must occur in the body, never just the title or date metadata.
  const days = claim.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  if (days.some((day) => !span.includes(day) && !String(doc.ts || "").startsWith(day))) return false;
  const figures = figuresIn(claim.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""));
  const spanFigures = new Set(figuresIn(span));
  const months = monthsIn(claim);
  const spanMonths = new Set(monthsIn(span));
  const ids = [...`${question}\n${claim}`.matchAll(ACCOUNT_IDS)].map((match) => canonical(match[1] || match[2]));
  const tokens = new Set(span.match(/[\p{L}\p{N}*_-]+/gu) || []);
  return figures.every((figure) => spanFigures.has(figure)) &&
    matches(claim, WORD_FIGURES).every((figure) => matches(span, WORD_FIGURES).includes(figure)) &&
    currencyInSpan(claim, span) &&
    months.every((month) => spanMonths.has(month)) &&
    ids.every((id) => tokens.has(id)) &&
    quotedValues(claim).every((quote) => span.includes(quote));
}

function eventKind(question) {
  if (/\bdue\b/i.test(question)) return "due";
  if (/\b(?:posted|posting)\b/i.test(question)) return "posted";
  if (/\b(?:paid|payment|payments|received|arrived)\b/i.test(question)) return "paid";
  return null;
}

function eventDates(span, kind) {
  const label = kind === "due" ? "due(?: date)?" : kind === "posted" ? "post(?:ed|ing)(?: date)?" : "(?:paid|payment(?: date)?|received|arrived)";
  const date = "(?:\\d{4}-\\d{2}-\\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4})";
  const pattern = new RegExp(`\\b${label}\\s*(?:(?:on|by|is|:|of)\\s*)?(${date})\\b`, "gi");
  return [...span.matchAll(pattern)].map(match => {
    const raw = match[1];
    if (/^\d{4}-/.test(raw)) return parseCanonicalEvidenceDate(raw);
    const parts = raw.replace(",", "").split(/\s+/);
    const month = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(parts[0].slice(0, 3).toLowerCase()) + 1;
    return parseCanonicalEvidenceDate(`${parts[2]}-${String(month).padStart(2, "0")}-${parts[1].padStart(2, "0")}`);
  }).filter(value => value !== null);
}

function primary(doc) {
  // Missing derivation metadata does not make an older primary record an
  // agent restatement. It may support its own dated span, without earning
  // independent-corroboration credit. Explicit agent demotions still win.
  return doc.lineage?.kind !== "agent_derived" &&
    doc.authority?.tier !== "T4" && doc.authority?.eligible !== false &&
    !isAgentDerivedArtifact(doc);
}

export function applyMoneyVeto({ question, answer, evidenceGate, docs = [], now = Date.now() } = {}) {
  const unchanged = { answer, evidenceGate };
  if (!answer || evidenceGate?.supported !== true) return unchanged;
  if (!MONEY_TOPIC.test(`${question || ""} ${answer}`) && !CURRENCY.test(answer) &&
      !/\b(?:(?:my|our|account|card|bank|checking|savings|loan|current|available|outstanding)\s+balances?|balances?\s+(?:of|on|in|for|due))\b/i.test(`${question || ""} ${answer}`)) return unchanged;
  const veto = (reason) => ({ answer: null, evidenceGate: {
    ...evidenceGate, supported: false, complete: false, evidence: [], reason,
  } });
  if (answer.includes("\0")) return veto("A money claim contains an ambiguous text boundary.");
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
    if (ABSENCE.test(claim) || (COVERAGE_QUESTION.test(question) && /^(?:yes|no|none)\b/i.test(claim))) return veto("Only a ledger can establish absence or completeness over the whole window; document excerpts cannot.");
    const hasFacts = CURRENCY.test(claim) || MONEY_TOPIC.test(claim) ||
      matches(withoutCitations(claim), NUMBERS).length || matches(claim, MONTHS).length || matches(claim, WORD_FIGURES).length;
    if (!hasFacts) continue;
    const numbers = [...sentence.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    const cited = docs.filter((doc) => numbers.includes(doc.n) && evidenceGate.evidence?.includes(doc.n));
    if (!cited.length) return veto("A money claim has no exact cited span.");
    if (cited.some((doc) => reliableDocumentTime(doc) === null)) return veto("A supporting money citation has no reliable date.");
    const records = cited.filter(primary);
    if (!records.length) return veto("Money claims need eligible non-agent support; agent-derived or T4 material alone is insufficient.");
    const kind = eventKind(question);
    const supporting = records.filter(doc => inSpan(claim, question, kind ? { ...doc, ts: "" } : doc));
    if (!supporting.length) return veto("A money figure, month list or account identifier does not match the exact cited span.");
    if (window) {
      if (kind) {
        // Bind dates to the same supported claim, not an unrelated line in the
        // invoice, and never substitute the document's creation date.
        const dates = supporting.flatMap(doc => moneySentences(String(doc.snippet || ""))
          .filter(snippet => inSpan(claim, question, { ...doc, snippet, ts: "" }))
          .flatMap(snippet => eventDates(snippet, kind)));
        const unique = [...new Set(dates)];
        if (unique.length !== 1) { incomplete = true; claimDateUnknown = true; }
        else if (unique[0] < window.start || unique[0] >= window.end) {
          return veto("The supported money claim date falls outside the question's window.");
        }
      } else if (cited.some(doc => reliableDocumentTime(doc) < window.start || reliableDocumentTime(doc) >= window.end)) {
        return veto("A supporting money citation falls outside the question's window.");
      }
    }
  }
  if (incomplete) return { answer, evidenceGate: { ...evidenceGate, complete: false, partial: true,
    ...(claimDateUnknown ? { reason: "The cited span does not establish the payment, posting or due date within the requested window." } : {}) } };
  return unchanged;
}
