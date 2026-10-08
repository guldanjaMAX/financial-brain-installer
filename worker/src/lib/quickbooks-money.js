/** Refusal-only contract for generated QuickBooks money. No result from this
 * module approves an answer or substitutes for the evidence/temporal verifier.
 *
 * Free prose cannot be exhaustively parsed for money: scale headings, anaphora,
 * accounting signs and extra subjects all defeated partial matching. Within a
 * QuickBooks evidence context, require complete record-bound statements instead.
 * Anything outside this finite language is ambiguous and is refused, including
 * every generated Account balance. The separate Account renderer is unchanged.
 */
import { quickBooksLabel, quickBooksLabelText, QUICKBOOKS_LABEL_PATTERN } from "./quickbooks-label.js";
const MONEY = "([A-Z]{3} -?(?:[1-9]\\d{0,2}(?:,\\d{3})+|0|[1-9]\\d*)(?:\\.\\d{2,6}))";
const STAMP = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)";
const DAY = "(\\d{4}-\\d{2}-\\d{2})";
const NAME = `(${QUICKBOOKS_LABEL_PATTERN})`;
const ID = "([\\p{L}\\p{N}][\\p{L}\\p{N}_/\\-]{0,79})";
const identity = (value) => quickBooksLabelText(value).toLowerCase();
// Match canonically composed accents before parsing field boundaries. Keep
// raw controls/formatting subject to the existing lexical refusal.
const textOf = (doc) => String(doc?.snippet || "").normalize("NFC").replace(/^\[[^\]\r\n]*\]\s*/, "");
const pattern = (value) => new RegExp(`^${value}$`, "u");
const exactTime = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};
const validDay = (value) => exactTime(`${value}T00:00:00.000Z`) !== null;
const units = (money) => {
  const [whole, fraction = ""] = money.slice(4).replaceAll(",", "").replace(/^-/, "").split(".");
  return BigInt(whole + fraction.padEnd(6, "0")) * (money[4] === "-" ? -1n : 1n);
};
const REFUSAL = "QuickBooks money draft contains an ambiguous or unbound statement; exact cited native records at the latest observation are required";
const NOTICES = [
  "Lists only records found in the retrieved evidence, not a complete QuickBooks inventory.",
  "The documents do not establish a complete list or a company-wide total.",
  "The documents do not establish the requested total.",
];

function record(doc) {
  const text = textOf(doc);
  // The entire opening must precede the connector's own entity marker. Later
  // Details, arbitrary text mentioning a party, and title matches are not facts.
  const header = /^(.*?)\. QuickBooks (Account|Customer|Vendor|Invoice|Bill|CreditMemo|BillPayment)\. (.*)$/.exec(text);
  if (!header) return null;
  const [, opening, entity, rest] = header;
  // A label can itself contain a forged opening/marker. Ambiguous repeated
  // markers or a missing native observation preface cannot define field slots.
  if ([...text.matchAll(/\bQuickBooks (?:Account|Customer|Vendor|Invoice|Bill|CreditMemo|BillPayment)\./g)].length !== 1 ||
      (entity !== "BillPayment" && !rest.startsWith("Balance observed during this sync; the provider queries are not an atomic ledger snapshot."))) return null;
  if (!/^[a-z]+:[A-Za-z0-9._~-]{1,128}$/.test(doc.ref || "")) return null;
  if (!String(doc.ref || "").startsWith(`${entity.toLowerCase()}:`)) return null;
  const observed = entity === "BillPayment"
    ? new RegExp(`^Historical provider record\\. Observed during sync at ${STAMP}\\.`).exec(rest)?.[1]
    : new RegExp(` as of ${STAMP}(?:;|$)`).exec(opening)?.[1];
  const parsed = { doc, opening, entity, observed, key: null, statements: [] };
  const add = (statement) => parsed.statements.push(`${statement} [${doc.n}].`);
  const dates = observed ? [...new Set([observed, observed.slice(0, 10)])] : [];
  if (entity === "Account") return parsed;
  if (entity === "Invoice" || entity === "Bill") {
    const direction = entity === "Invoice" ? "to" : "from";
    const match = pattern(`${entity} ${ID} ${direction} ${NAME}: total ${MONEY}, open balance ${MONEY} \\((unpaid|paid|partially paid|credit balance)\\) as of ${STAMP}; dated ${DAY}(?:, due ${DAY})?(?:, terms ${NAME})?`).exec(opening);
    if (!match) return parsed;
    const [, number, party, total, balance, state, asOf, dated, due, terms = ""] = match;
    parsed.key = `${entity}:${identity(number)}:${identity(party)}`;
    const expectedState = units(balance) < 0n ? "credit balance" : units(balance) === 0n ? "paid"
      : units(balance) < units(total) ? "partially paid" : "unpaid";
    const numberLabel = quickBooksLabel(number, { identifier: true });
    const partyLabel = quickBooksLabel(party);
    const termsLabel = terms && quickBooksLabel(terms);
    if (!numberLabel || !partyLabel || (terms && !termsLabel) || asOf !== observed || total.slice(0, 3) !== balance.slice(0, 3) || state !== expectedState ||
        !validDay(dated) || (due && !validDay(due))) return parsed;
    add(`${entity} ${numberLabel} ${direction} ${partyLabel}: total ${total}, open balance ${balance} (${state}) as of ${asOf}; dated ${dated}${due ? `, due ${due}` : ""}${terms ? `, terms ${termsLabel}` : ""}`);
    for (const date of dates) {
      add(`${entity} ${numberLabel} ${entity === "Invoice" ? "for" : "from"} ${partyLabel} has an open balance of ${balance} as of ${date}`);
      add(`${entity} ${numberLabel} ${direction} ${partyLabel}: open balance ${balance} (${state}) as of ${date}`);
      if (entity === "Invoice" && units(balance) > 0n) add(`${partyLabel} owes ${balance} on Invoice ${numberLabel} as of ${date}`);
      if (entity === "Bill" && units(balance) > 0n) add(`We owe ${balance} to ${partyLabel} on Bill ${numberLabel} as of ${date}`);
    }
  } else if (entity === "Customer" || entity === "Vendor") {
    const match = pattern(`${NAME}: open balance ${MONEY} as of ${STAMP}`).exec(opening);
    if (!match) return parsed;
    const [, party, balance] = match;
    parsed.key = `${entity}:${identity(party)}`;
    const partyLabel = quickBooksLabel(party);
    if (!partyLabel) return parsed;
    for (const date of dates) add(`${partyLabel}: open balance ${balance} as of ${date}`);
  } else if (entity === "CreditMemo") {
    const match = pattern(`Credit memo ${ID} for ${NAME} on ${DAY}: total ${MONEY}, remaining credit ${MONEY} as of ${STAMP}`).exec(opening);
    if (!match) return parsed;
    const [, number, party, date, total, balance] = match;
    parsed.key = `${entity}:${identity(number)}:${identity(party)}`;
    const numberLabel = quickBooksLabel(number, { identifier: true });
    const partyLabel = quickBooksLabel(party);
    if (!numberLabel || !partyLabel || !validDay(date) || total.slice(0, 3) !== balance.slice(0, 3)) return parsed;
    add(`Credit memo ${numberLabel} for ${partyLabel} on ${date}: total ${total}, remaining credit ${balance} as of ${observed}`);
    for (const asOf of dates) add(`Credit memo ${numberLabel} for ${partyLabel} has remaining credit of ${balance} as of ${asOf}`);
  } else if (entity === "BillPayment") {
    const match = pattern(`Bill payment to ${NAME} on ${DAY}: ${MONEY} by (credit card|cash|check) \\(${NAME}\\)(, for bill [\\p{L}\\p{N}_/\\-]+(?:, bill [\\p{L}\\p{N}_/\\-]+)*)?`).exec(opening);
    if (!match) return parsed;
    const [, party, date, amount, method, account, links = ""] = match;
    parsed.key = `${entity}:${doc.ref}`;
    const partyLabel = quickBooksLabel(party);
    const accountLabel = quickBooksLabel(account);
    const billLabels = [...links.matchAll(/bill ([\p{L}\p{N}_/\-]+)/gu)].map((match) => quickBooksLabel(match[1], { identifier: true }));
    if (!partyLabel || !accountLabel || billLabels.some((label) => !label) || !validDay(date) || units(amount) < 0n) return parsed;
    const linkedBills = billLabels.length ? ` for ${billLabels.map((label) => `bill ${label}`).join(", ")}` : "";
    add(`Bill payment to ${partyLabel} on ${date}: ${amount} by ${method} (${accountLabel})${linkedBills ? `,${linkedBills}` : ""}`);
    add(`${partyLabel} was paid ${amount} by ${method} on ${date}${linkedBills}`);
  }
  // A flattened excerpt cannot distinguish structural Line/Details markers
  // from those same strings inside a memo or description. Never promote that
  // tail to monetary facts, even when its numbers match a genuine total.
  // Nor can a word blacklist prove that arbitrary prose contains no money
  // (e.g. "eighty bucks"). Purpose/line-item answers require structured field
  // provenance before they can join this finite language.
  return parsed;
}

function reliable(record, now) {
  const { doc, entity, observed } = record;
  const time = exactTime(observed);
  const historical = entity === "BillPayment";
  return doc.source_kind === "quickbooks" && doc.text_source === "native" && doc.text_reliable === true &&
    doc.date_reliable === true && doc.lineage?.status === "known" && doc.lineage.kind === "source_record" &&
    doc.authority?.eligible !== false && time !== null && time <= now &&
    (historical ? doc.date_source === "quickbooks:provider_timestamp" && Number.isFinite(Date.parse(doc.ts)) && Date.parse(doc.ts) <= time
      : doc.date_source === "quickbooks:balance_snapshot" && time === Date.parse(doc.ts) && now - time <= 86400000);
}

/** Supplies a finite language to the generator and a veto to the route. Passing
 * the veto only means no deterministic mismatch was found, never supported=true.
 * All retrieved candidates participate in the latest-observation check, even
 * those outside the numbered citation window.
 */
export function quickBooksMoneyPolicy({ question, draft, docs = [], candidates = docs, observedAnswer = null, now = Date.now() } = {}) {
  const scoped = /\b(?:quick[\s-]*books|qbo)\b/i.test(`${question || ""} ${draft || ""}`) || candidates.some((doc) =>
    doc.source_kind === "quickbooks" || String(doc.date_source || "").startsWith("quickbooks:") || /\bQuickBooks (?:Account|Customer|Vendor|Invoice|Bill|CreditMemo|BillPayment)\./.test(textOf(doc)));
  if (!scoped) return null;
  const records = candidates.map(record).filter(Boolean);
  const statements = [];
  for (const doc of docs) {
    const current = record(doc);
    if (!current || !current.key || !reliable(current, now)) continue;
    // A malformed same-provider record may be a competing version whose
    // identity or amount cannot be read. It cannot silently vanish from a
    // latest-observation comparison just because parsing failed.
    const unresolvedPeer = candidates.some((other) => other.source === doc.source &&
      String(other.ref || "").startsWith(`${current.entity.toLowerCase()}:`) && !record(other)?.key);
    if (unresolvedPeer) continue;
    const peers = records.filter((other) => other.doc.source === doc.source &&
      (other.doc.ref === doc.ref || other.key === current.key));
    // Unknown dates or ambiguous concurrent versions cannot become current by
    // choosing the nicer citation. Compare identity symmetrically on both sides.
    if (peers.some((other) => exactTime(other.observed) === null ||
        exactTime(other.observed) > exactTime(current.observed) ||
        (other.observed === current.observed && (other.opening !== current.opening || !reliable(other, now))))) continue;
    statements.push(...current.statements);
  }
  const allowed = new Set([...statements, ...NOTICES]);
  return {
    instruction: [
      "QUICKBOOKS MONEY CONTRACT: If answering from these QuickBooks records, select relevant complete lines from the list below and copy them exactly, one per line (optional '- ' bullets). Do not add a heading, sum, subtotal, range, words-for-numbers, paraphrase, currency symbol, scale, sign change, additional subject, or Heads up line. Never copy a memo, description or line-item claim from the documents; those free-text boundaries do not establish a monetary field. Do not present a transaction amount as a balance. The separate evidence verifier must still support the answer to the question. If no listed statement answers it, say exactly: The documents do not answer the question.",
      ...statements, ...NOTICES,
    ].join("\n"),
    refusal(answer) {
      // Only the route's non-generative proposal may supply this contract.
      // Its labels use the same boundary above; require the entire proposal
      // unchanged, including its scope caveat. Never add it to model options.
      if (observedAnswer) return answer === observedAnswer.answer ? null : REFUSAL;
      const lines = String(answer || "").split(/\r?\n/).map((line) => line.trim().replace(/^- /, "")).filter(Boolean);
      return lines.length && lines.every((line) => allowed.has(line)) && lines.some((line) => statements.includes(line)) ? null : REFUSAL;
    },
    // This is formatting, not approval. The route uses it only after both the
    // independent verifier and the refusal check, and rechecks the retained
    // body. Sentence splitting can detach a dotted party name from its money.
    partialBody(answer, allowedNumbers) {
      return String(answer || "").split(/\r?\n/).filter((line) => {
        const statement = line.trim().replace(/^- /, "");
        if (!statements.includes(statement)) return false;
        const numbers = [...statement.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
        return numbers.length === 1 && allowedNumbers.has(numbers[0]);
      }).join("\n");
    },
  };
}
