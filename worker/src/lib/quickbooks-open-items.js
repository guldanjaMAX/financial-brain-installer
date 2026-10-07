/** Non-generative open-item answers. No model draft enters this module. */
const identity = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();

// Match the whole request. A filtered, historical, net-credit, total or compound
// question needs the ordinary answer path; silently dropping a clause is unsafe.
export function quickBooksOpenItemsRequest(question) {
  const q = identity(question).replace(/ in quickbooks(?=,|[?.]?$)/g, "").replace(/[?.]$/, "");
  if (/^which customers have unpaid invoices,? and how much does each (?:one )?owe$/.test(q) ||
      /^who owes (?:us|me)(?: money)?$/.test(q) ||
      /^(?:show|list|what are) (?:(?:my|our|the) )?(?:current )?(?:unpaid invoices|open invoices|open receivables)$/.test(q)) return "Invoice";
  if (/^what bills do (?:we|i) owe$/.test(q) || /^(?:what|which) bills are unpaid$/.test(q) ||
      /^(?:show|list|what are) (?:(?:my|our|the) )?(?:current )?(?:unpaid bills|open bills|open payables)$/.test(q)) return "Bill";
  return null;
}

const MONEY = "([A-Z]{3}) (-?(?:[1-9]\\d{0,2}(?:,\\d{3})+|0|[1-9]\\d*)(?:\\.\\d{2,6}))";
const STAMP = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)";
const DAY = "(\\d{4}-\\d{2}-\\d{2})";
const NAME = "([\\p{L}\\p{N}][\\p{L}\\p{N} '&()/.\\-]{0,179})";
const NUMBER = "([\\p{L}\\p{N}][\\p{L}\\p{N}_/\\-]{0,79})";
const OPENING = new RegExp(`^(Invoice|Bill) ${NUMBER} (to|from) ${NAME}: total ${MONEY}, open balance ${MONEY} \\((unpaid|paid|partially paid|credit balance)\\) as of ${STAMP}; dated ${DAY}(?:, due ${DAY})?(?:, terms ${NAME})?\\. QuickBooks (Invoice|Bill)\\. Balance observed during this sync; the provider queries are not an atomic ledger snapshot\\.(?: |$)`, "u");
const exactTime = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};
const units = (value) => {
  const [whole, fraction] = value.replaceAll(",", "").replace(/^-/, "").split(".");
  return BigInt(whole + fraction.padEnd(6, "0")) * (value.startsWith("-") ? -1n : 1n);
};

function observedItem(doc, entity, now) {
  if (doc.source_kind !== "quickbooks" || doc.date_source !== "quickbooks:balance_snapshot" ||
      doc.date_reliable !== true || doc.text_source !== "native" || doc.text_reliable !== true ||
      doc.lineage?.status !== "known" || doc.lineage.kind !== "source_record" ||
      doc.authority?.eligible === false || !doc.source || doc.source === "?" ||
      !new RegExp(`^${entity.toLowerCase()}:[A-Za-z0-9._~-]{1,128}$`).test(doc.ref || "")) return null;
  // Only the complete leading connector opening supplies facts. Never search
  // its arbitrary memo, description, Details or title for monetary markers.
  const text = String(doc.snippet || "").replace(/^\[[^\]\r\n]*\]\s*/, "");
  const match = OPENING.exec(text);
  if (!match) return null;
  const [, kind, number, direction, party, totalCurrency, total, currency, amount, state, observedAt, dated, due, , marker] = match;
  if (kind !== entity || marker !== entity || direction !== (entity === "Invoice" ? "to" : "from") ||
      party === "not provided" || totalCurrency !== currency ||
      exactTime(`${dated}T00:00:00.000Z`) === null || (due && exactTime(`${due}T00:00:00.000Z`) === null)) return null;
  const time = exactTime(observedAt);
  if (time === null || time !== Date.parse(doc.ts) || time > now || now - time > 86400000) return null;
  const balance = units(amount);
  const totalAmount = units(total);
  const expectedState = balance < 0n ? "credit balance" : balance === 0n ? "paid"
    : balance < totalAmount ? "partially paid" : "unpaid";
  if (state !== expectedState || totalAmount < 0n || balance > totalAmount) return null;
  return { doc, number, party, currency, amount, balance, due, observedAt };
}

/** Authorized retrieval is the boundary, not a full ledger. Inspect even
 * candidates beyond the citation window for stale/conflicting versions. Require
 * one source and observation across relevant records, including paid records,
 * so an older unpaid version cannot survive beside a newly paid observation.
 * Null preserves the generic answer path and its refusal-only money guard.
 */
export function quickBooksOpenItemsAnswer({ question, candidates = [], citationCount = 0, now = Date.now() } = {}) {
  const entity = quickBooksOpenItemsRequest(question);
  if (!entity || !Array.isArray(candidates) || !Number.isFinite(now) ||
      !Number.isInteger(citationCount) || citationCount < 1 || citationCount > 12) return null;
  const items = [];
  for (const [index, doc] of candidates.entries()) {
    if (doc.source_kind !== "quickbooks") continue;
    // A claimed item with missing/mismatched identity is an unresolved peer,
    // not an excuse to cherry-pick the other records for this inventory.
    const mentionsEntity = new RegExp(`^(?:\\[[^\\]\\r\\n]*\\]\\s*)?${entity} `).test(String(doc.snippet || ""));
    if (!String(doc.ref || "").startsWith(`${entity.toLowerCase()}:`) && !mentionsEntity) continue;
    if (doc.n !== index + 1) return null;
    const item = observedItem(doc, entity, now);
    if (!item) return null;
    items.push(item);
  }
  if (!items.length || new Set(items.map((item) => item.observedAt)).size !== 1 ||
      new Set(items.map((item) => item.doc.source)).size !== 1 ||
      new Set(items.map((item) => item.doc.ref)).size !== items.length ||
      new Set(items.map((item) => `${identity(item.number)}:${identity(item.party)}`)).size !== items.length) return null;
  const selected = items.filter((item) => item.balance > 0n && item.doc.n <= citationCount);
  // An empty retrieved subset cannot prove that nobody owes anything.
  if (!selected.length) return null;
  selected.sort((a, b) => a.party < b.party ? -1 : a.party > b.party ? 1 : a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
  const lines = selected.map((item) => `${entity} ${item.number} ${entity === "Invoice" ? "to" : "from"} ${item.party}: ${entity === "Invoice" ? "owes" : "we owe"} ${item.currency} ${item.amount}, ${item.due ? `due ${item.due}` : "due date not provided"}, as of ${item.observedAt.slice(0, 10)} [${item.doc.n}].`);
  const noun = entity === "Invoice" ? "invoices" : "bills";
  return {
    answer: `${lines.join("\n")}\n\nLists only ${noun} found in the retrieved evidence with positive open balances, not a complete QuickBooks inventory. Amounts are per item. Credit memos and credit balances are not netted. No company-wide or net amount owed is established. Check QuickBooks for the complete list.`,
    evidence: selected.map((item) => item.doc.n),
  };
}
