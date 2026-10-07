/** Exact observed Account facts only. This module never accepts model prose. */
const QUICKBOOKS_BALANCE_DATE_SOURCE = "quickbooks:balance_snapshot";
const identity = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
const recordText = (doc) => String(doc?.snippet || "").replace(/^\[[^\]\r\n]*\]\s*/, "");

// Whole-question admission: a balance request with another material clause
// still needs the normal generator/verifier. Do not silently drop that clause.
export function quickBooksBalanceRequest(question) {
  const q = String(question || "").trim();
  if (/^what bank and credit card accounts are in quickbooks,? and what are their current balances\?$/i.test(q)) {
    return { types: new Set(["Bank", "Credit Card"]) };
  }
  const general = /^(?:what are|show|list) (?:(?:my|our|the) )?(?:current )?(?:quickbooks )?(bank(?: and credit card)?(?: accounts?)?|credit card(?: and bank)?(?: accounts?)?|accounts?) balances(?: in quickbooks)?[?.]?$/i.exec(q);
  if (general) {
    const scope = general[1].toLowerCase();
    return { types: /^accounts?$/.test(scope) ? null : new Set([
      ...(scope.includes("bank") ? ["Bank"] : []), ...(scope.includes("credit card") ? ["Credit Card"] : []),
    ]) };
  }
  const named = /^what is (?:the )?current balance (?:of|for) (.+?)(?: in quickbooks)?\??$/i.exec(q);
  return named ? { name: identity(named[1]) } : null;
}

const ACCOUNT_TYPES = new Set([
  "Bank", "Credit Card", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset",
  "Accounts Payable", "Other Current Liability", "Long Term Liability", "Equity", "Income",
  "Cost of Goods Sold", "Expense", "Other Income", "Other Expense", "Non-Posting",
]);
const SAFE_ACCOUNT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} '&()/-]{0,179}$/u;

function observedAccount(doc, now) {
  if (doc.source_kind !== "quickbooks" || doc.date_source !== QUICKBOOKS_BALANCE_DATE_SOURCE ||
      doc.date_reliable !== true || doc.text_source !== "native" || doc.text_reliable !== true ||
      doc.lineage?.status !== "known" || doc.lineage?.kind !== "source_record" ||
      doc.authority?.eligible === false || !doc.ref?.startsWith("account:")) return null;
  // Parse the entire connector opening and its Account marker. A number in
  // Details, a title, a derived summary or an incomplete excerpt cannot qualify.
  const match = /^([A-Za-z ]+) account ([^:]+): balance ([A-Z]{3}) (-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2,6}))(?: \(owes ([A-Z]{3}) ((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2,6}))\))? as of (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.\s+QuickBooks Account\./.exec(recordText(doc));
  if (!match) return null;
  const [, type, name, currency, amount, owedCurrency, owed, observedAt] = match;
  if (!ACCOUNT_TYPES.has(type) || !SAFE_ACCOUNT_NAME.test(name) || name === "not provided") return null;
  const time = Date.parse(observedAt);
  // Current money is volatile. This path admits at most one day's observation,
  // never a fresh account that launders an older account in the same list.
  if (!Number.isFinite(time) || new Date(time).toISOString() !== observedAt || time !== Date.parse(doc.ts) || time > now || now - time > 86400000) return null;
  const liability = type === "Credit Card" && amount.startsWith("-");
  if (liability ? owedCurrency !== currency || owed !== amount.slice(1) : owed !== undefined) return null;
  const day = observedAt.slice(0, 10);
  const claim = `${name} (${type}): ${liability ? `owes ${currency} ${owed}` : `balance ${currency} ${amount}`} as of ${day} [${doc.n}].`;
  return { name, type, observedAt, claim, n: doc.n, source: doc.source };
}

/** A non-generative proposal from authorized, numbered retrieval evidence.
 * Null means use the ordinary answer path. No new retrieval, totals, stored
 * summaries or company-wide completeness claims are introduced here.
 */
export function quickBooksBalanceAnswer({ question, results, docs, now = Date.now() } = {}) {
  const request = quickBooksBalanceRequest(question);
  if (!request || !Array.isArray(results) || !Array.isArray(docs) || !Number.isFinite(now)) return null;
  const accounts = [];
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    const ref = row.ref_key || row.drive_file_id;
    if (row.source_kind !== "quickbooks" || !String(ref || "").startsWith("account:")) continue;
    // Inspect the entire retrieved window, including candidates outside the
    // twelve citation slots. Extra accounts may reveal a conflicting snapshot,
    // but cannot be listed unless the route assigned them a public citation.
    const doc = docs[i] || { ...row, n: i + 1, ref,
      snippet: String(row.snippet || "").replace(/\s+/g, " ").slice(0, 900) };
    if (doc.n !== i + 1 || doc.ref !== ref) return null;
    const heading = /^([^:]+?) account ([^:]+):/.exec(recordText(doc));
    if (!heading || !ACCOUNT_TYPES.has(heading[1])) return null;
    // An expense account or a different named account cannot establish or
    // invalidate the requested account's balance. Unknown headings still
    // decline admission because their scope cannot be established.
    if (request.name ? identity(heading[2]) !== request.name : request.types && !request.types.has(heading[1])) continue;
    const account = observedAccount(doc, now);
    if (!account) return null;
    accounts.push(account);
  }
  if (!accounts.length || new Set(accounts.map((a) => a.observedAt)).size !== 1 ||
      new Set(accounts.map((a) => a.source)).size !== 1 ||
      new Set(accounts.map((a) => identity(a.name))).size !== accounts.length) return null;
  const selected = accounts.filter((a) => a.n <= docs.length &&
    (request.name ? identity(a.name) === request.name : !request.types || request.types.has(a.type)));
  if (!selected.length) return null;
  selected.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    answer: `${selected.map((a) => a.claim).join("\n")}\n\nLists only accounts found in the retrieved evidence, not a complete QuickBooks inventory. Check QuickBooks for the complete list.`,
    evidence: selected.map((a) => a.n),
  };
}
