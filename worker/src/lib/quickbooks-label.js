/** Provider labels are data, never an extra clause in an approved claim.
 * Quoting is the boundary even for words we do not recognize. Money, state
 * language and citation/formatting syntax are additionally refused: hiding
 * those inside quotes would still leave a misleading financial answer.
 */
export const quickBooksLabelText = (value) => String(value || "").normalize("NFKC")
  .replace(/[\p{Cc}\p{Cf}\p{Z}\s]+/gu, " ").trim();

// Shared with the record-opening parsers. This is only a lexical shape;
// every captured label must still pass the punctuation and meaning vetoes.
export const QUICKBOOKS_LABEL_PATTERN = String.raw`[\p{L}\p{N}][\p{L}\p{N} '&()/.+,#’\-]{0,179}`;
const LABEL_SHAPE = new RegExp(`^${QUICKBOOKS_LABEL_PATTERN}$`, "u");

export function quickBooksLabel(value, { identifier = false } = {}) {
  if (typeof value !== "string") return null;
  const text = quickBooksLabelText(value);
  const shape = identifier ? /^[\p{L}\p{N}][\p{L}\p{N}_/\-]{0,79}$/u
    : LABEL_SHAPE;
  // Brackets, quotes, Markdown/HTML and other delimiters cannot reach output.
  // Refuse rather than deleting part of a subject and silently changing it.
  if (!shape.test(text) || text === "not provided") return null;
  // A smart apostrophe stays inside a word; '#' is a location-number prefix,
  // never a heading. Only a letter's trailing '+' (A+ Supply) is lexical,
  // not a sign. All remaining pluses still reach the unchanged money veto.
  if (/(?<!\p{L})’|’(?!\p{L})|(?<! )#|#(?![0-9]+(?: \p{L}|$))/u.test(text)) return null;
  const moneyText = text.replace(/(?<=\p{L})\+(?= \p{L}|$)/gu, "");
  if (/\p{Sc}|[%+\u2212\u00b1]|(?:^|[\s(])-\s*\d|\(\s*\d|\d[.,]\d|\b[A-Z]{3}\s+-?\d/u.test(moneyText) ||
      /\b(?:amounts?|balances?|owes?|owed|paid|costs?|charges?|fees?|dollars?|cents?|bucks?|euros?|pounds?|pesos?|yen|yuan|rupees?|francs?|hundred|thousands?|millions?|billions?|trillions?|percent(?:age)?|per cent|basis points?|USD|CAD|EUR|GBP|AUD|NZD|JPY|CHF|CNY|INR)\b/iu.test(text) ||
      /\b(?:is|are|was|were|has|have|had|remains?|continues?|ongoing|active|inactive|current|former|still|terminated|cancelled|canceled|expires?|expired|renewed|provides?|receives?)\b/iu.test(text)) return null;
  return JSON.stringify(text);
}
