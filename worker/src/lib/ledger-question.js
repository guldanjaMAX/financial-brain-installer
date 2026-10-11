// Phase-one grammar is deliberately bounded. Unsupported money questions still
// disclose that document retrieval did not consult the ledger.
const MONTHS = "january february march april may june july august september october november december".split(" ");
const MONTH = `(${MONTHS.join("|")})`;
const DAY_MS = 86400000;
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

export function classifyLedgerQuestion(question, { now = Date.now() } = {}) {
  const q = String(question || "").toLowerCase().replace(/[’]/g, "'").replace(/\bwhat's\b/g, "what is");
  const broad = /\b(?:money|cash|balance|balances|bank|deposit|payment|paid|spend|spent|spending|income|revenue|credits?|debits?|transactions?|transfers?|checking|savings|loan|debt|tax|payroll|invoice|receivable|payable|came in|went out)\b|\$\s*\d/.test(q);
  const base = { broad, kind: null };
  if (!broad) return base;
  const today = ledgerDay(now);
  const maskMatches = [...q.matchAll(/(?:\*{2,}|ending(?:\s+in)?\s+|mask\s+|account\s+)(\d{1,4})\b/g)];
  const masks = [...new Set(maskMatches.map(m => m[1]))];
  if (masks.length > 1) return base;
  const kinds = [...new Set(q.match(/\b(?:checking|savings|card|loan|investment|retirement|escrow)\b/g) || [])];
  const selector = { mask: masks[0] || null, accountKind: kinds.length === 1 ? kinds[0] : null };
  const intent = { ...base, ...selector };
  const withoutMasks = text => maskMatches.reduce((rest, match) => rest.replace(match[0], ""), text);
  const punctuationOnly = text => !text.replace(/[?'.,:]/g, "").trim();
  if (kinds.length > 1) return intent;
  // These qualifiers require a different source or a richer financial model.
  if (/\b(?:quickbooks|qbo|tax|profit|net income|excluding|exclude|without|except|forecast|projected|average|median|largest|smallest|interest)\b/.test(q)) return intent;
  if (/\b(?:balance|balances)\b/.test(q)) {
    // Do not replace a named bank/entity or a historical balance with all accounts.
    const residual = withoutMasks(q).replace(/\b(?:what|is|are|my|our|the|current|latest|bank|account|accounts|balance|balances|checking|savings|card|loan|investment|retirement|escrow|per|each|show|me|please|today|now|ending|in|mask|for|all)\b/g, "");
    return punctuationOnly(residual) ? { ...intent, kind: "balance" } : intent;
  }
  if (/\b(?:payment|deposit|paid)\b/.test(q) && /\b(?:arrive|arrived|received|receive|come|came|land|landed|hit)\b/.test(q)) {
    const amountMinor = amountInCents(q);
    if (amountMinor === null) return intent;
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
    // An explicit but unsupported date must never silently become the last 30 days.
    if (!dates.length && /\b(?:on|between|before|after|yesterday|tomorrow|last|this)\b/.test(q)) return intent;
    const partyMatch = q.match(/\bfrom\s+(.+?)(?=\s+(?:on|into|to|in|for|arrive|arrived|come|came|land|landed|hit)\b|[?]|$)/);
    const counterparty = partyMatch?.[1] || "";
    if (partyMatch) rest = rest.replace(partyMatch[0], "");
    rest = rest.replace(/(?:\$|\busd\s+)\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s+dollars?\b/g, "")
      .replace(/\b(?:did|has|have|was|is|the|a|my|our|payment|deposit|of|paid|arrive|arrived|received|receive|come|came|land|landed|hit|yet|on|in|into|to|account|checking|savings|ending|mask|please)\b/g, "");
    if (!punctuationOnly(rest)) return intent;
    const counterpartyWords = counterparty.match(/[\p{L}\p{N}]+/gu) || [];
    return { ...intent, kind: "payment", amountMinor, counterpartyWords,
      from: dates.length ? shiftLedgerDay(dates[0], -7) : shiftLedgerDay(today, -29),
      to: dates.length ? shiftLedgerDay(dates[0], 7) : today };
  }
  if (/\b(?:money|cash|came in|went out|income|spend|spent|spending|credits?|debits?|inflow|outflow)\b/.test(q)) {
    let from, to;
    const namedMatches = [...q.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{4})\\b`, "g"))];
    const named = namedMatches[0];
    const days = q.match(/\blast\s+(\d+)\s+days\b/);
    const lastMonth = q.match(/\blast month\b/);
    const year = q.match(/\bso far this year\b/);
    if (namedMatches.length + Number(Boolean(days)) + Number(Boolean(lastMonth)) + Number(Boolean(year)) !== 1) return intent;
    if (named) {
      from = calendarDay(named[2], MONTHS.indexOf(named[1]) + 1, 1);
      to = ledgerDay(Date.UTC(Number(named[2]), MONTHS.indexOf(named[1]) + 1, 0));
    } else if (lastMonth) {
      const date = new Date(`${today}T00:00:00Z`);
      from = ledgerDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
      to = ledgerDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
    } else if (days && Number(days[1]) >= 1 && Number(days[1]) <= 3660) {
      from = shiftLedgerDay(today, 1 - Number(days[1])); to = today;
    } else if (year) {
      from = `${today.slice(0, 4)}-01-01`; to = today;
    }
    // Counterparty/category/entity totals are beyond phase one. Never silently
    // broaden them into whole-account totals.
    const residual = withoutMasks(q).replace((named || days || lastMonth || year)[0], "")
      .replace(/\b(?:how|much|money|cash|came|come|in|and|or|went|go|out|income|spend|spent|spending|credits?|debits?|inflow|outflow|did|i|we|what|was|were|is|are|the|total|totals|my|our|account|accounts|bank|checking|savings|card|loan|investment|retirement|escrow|by|per|each|all|during|for|over|show|me|please)\b/g, "");
    if (!punctuationOnly(residual)) return intent;
    if (from && to) return { ...intent, kind: "totals", from, to };
  }
  return intent;
}
