/** Claim-specific support for a directly observed QuickBooks balance. */
export const QUICKBOOKS_BALANCE_DATE_SOURCE = "quickbooks:balance_snapshot";
const BALANCE = /\b(?:balances?|owes?|owed|remaining credit)\b/i;
const RELATIONSHIP_OR_STATE = /\b(?:client|relationship|engagement|active|inactive|closed|stopped|ended|terminated|cancelled|canceled|ceased|churned|left|no longer|still|partner|member|patient|employee|tenant)\b/i;
const normalized = (value) => ` ${String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const amountKey = (value) => {
  const [whole, fraction = ""] = value.replaceAll(",", "").split(".");
  return `${BigInt(whole)}.${fraction.replace(/0+$/, "")}`;
};

export function isQuickBooksBalanceClaim(sentence, doc) {
  return BALANCE.test(sentence) &&
    (doc?.date_source === QUICKBOOKS_BALANCE_DATE_SOURCE || doc?.source_kind === "quickbooks");
}

export function quickBooksBalanceSupportsClaim(sentence, doc, { now = Date.now() } = {}) {
  // source_kind comes from the authenticated source registry, never a title or
  // arbitrary snapshot_at metadata. Renaming a source keeps its registered kind.
  if (doc?.source_kind !== "quickbooks" || doc.date_source !== QUICKBOOKS_BALANCE_DATE_SOURCE ||
      doc.date_reliable !== true || doc.text_source !== "native" || doc.text_reliable !== true ||
      doc.lineage?.kind !== "source_record" || !BALANCE.test(sentence) || RELATIONSHIP_OR_STATE.test(sentence)) return false;
  const time = Date.parse(doc.ts);
  if (!Number.isFinite(time) || time > now) return false;
  // Stored chunks carry the document title in a bracketed header. It is not
  // part of the record's party name and may be longer than the public title.
  const evidence = String(doc.snippet || "").replace(/^\[[^\]\r\n]*\]\s*/, "");
  const observed = /\b(?:balance|remaining credit) ([A-Z]{3}) (-?\d[\d,]*(?:\.\d+)?) (?:\([^)]*\) )?as of (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(evidence);
  if (!observed || observed[3] !== new Date(time).toISOString()) return false;
  // Require the same account or party in this sentence. A newest balance for
  // another account cannot freshen an older account's balance.
  const account = /^[^:]+? account ([^:]+):/.exec(evidence)?.[1];
  const party = /^(?:Invoice [^:]+ to |Bill [^:]+ from )([^:]+):/.exec(evidence)?.[1] ||
    /^Credit memo [^:]+ for (.+?) on \d{4}-\d{2}-\d{2}:/.exec(evidence)?.[1];
  const namedBalance = /^([^:]+): open balance/.exec(evidence)?.[1];
  const subject = account || party || namedBalance;
  if (!subject || !normalized(sentence).includes(normalized(subject))) return false;
  const amounts = [...String(sentence).matchAll(/(?:\b([A-Z]{3})\s*|(\$)\s*)(-?\d[\d,]*(?:\.\d+)?)/g)];
  return amounts.length > 0 && amounts.every((match) =>
    (match[1] || (match[2] ? "USD" : "")) === observed[1] && amountKey(match[3]) === amountKey(observed[2]));
}
