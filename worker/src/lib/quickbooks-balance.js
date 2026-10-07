/** Claim-specific support for a directly observed QuickBooks balance. */
export const QUICKBOOKS_BALANCE_DATE_SOURCE = "quickbooks:balance_snapshot";
const BALANCE = /\b(?:balances?|owes?|owed|remaining credit)\b/i;
const normalized = (value) => ` ${String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const recordText = (doc) => String(doc?.snippet || "").replace(/^\[[^\]\r\n]*\]\s*/, "");
const accountName = (doc) => /^[^:\r\n]+? account ([^:\r\n]+):/.exec(recordText(doc))?.[1];
const MONEY = /(?:\b[A-Z]{3}\s*|\$\s*)-?\d/;
const AS_OF_DATE = /\b(?:as of|through)\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?|[A-Za-z]+ \d{1,2},? \d{4})(?![Tt\d+-]|:\d)/gi;
// Paired presentation wrappers are safe to remove. A bare tilde is an
// approximation sign; a single underscore can be part of an account identity.
const plain = (value) => String(value).replace(/(\*\*|__|`)([^\n]+?)\1/g, "$2");
const identity = (value) => plain(value).toLowerCase().replace(/\s+/g, " ").trim();
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function compactAccountBalanceClaim(sentence, doc) {
  const account = accountName(doc);
  if (!account) return false;
  const subject = escape(plain(account)).replace(/\s+/g, "\\s+");
  // Colon/value lists imply a balance in this branch. Merely mentioning an
  // account and money does not prove income, spending or a recurring payment.
  return new RegExp(`(?<![a-z0-9])${subject}\\s*(?:\\([^)]*\\)\\s*)?:\\s*(?:[a-z]{3}\\s*|\\$\\s*)?-?\\d`, "i").test(plain(sentence));
}
const amountKey = (value) => {
  const [whole, fraction = ""] = value.replaceAll(",", "").split(".");
  return `${whole.startsWith("-") ? "-" : ""}${BigInt(whole.replace(/^-/, ""))}.${fraction.replace(/0+$/, "")}`;
};

// Identify the evidence independently of generated prose. An unsupported
// table or heading must be eligible for repair even when no row parsed.
export function isQuickBooksAccountBalanceRecord(doc) {
  return doc?.source_kind === "quickbooks" && doc.date_source === QUICKBOOKS_BALANCE_DATE_SOURCE &&
    Boolean(accountName(doc));
}

export function isQuickBooksBalanceClaim(sentence, doc) {
  return (BALANCE.test(sentence) || compactAccountBalanceClaim(sentence, doc)) &&
    (doc?.date_source === QUICKBOOKS_BALANCE_DATE_SOURCE || doc?.source_kind === "quickbooks");
}

export function quickBooksBalanceSupportsClaim(sentence, doc, { now = Date.now() } = {}) {
  // source_kind comes from the authenticated source registry, never a title or
  // arbitrary snapshot_at metadata. Renaming a source keeps its registered kind.
  if (doc?.source_kind !== "quickbooks" || doc.date_source !== QUICKBOOKS_BALANCE_DATE_SOURCE ||
      doc.date_reliable !== true || doc.text_source !== "native" || doc.text_reliable !== true ||
      doc.lineage?.kind !== "source_record" || !isQuickBooksBalanceClaim(sentence, doc)) return false;
  const time = Date.parse(doc.ts);
  if (!Number.isFinite(time) || time > now) return false;
  // Every explicit qualifier must agree, not merely one matching date anywhere
  // in a compound answer. Full timestamps must match the observation instant.
  const dates = [...sentence.matchAll(AS_OF_DATE)];
  if (!dates.length || dates.length !== [...sentence.matchAll(/\b(?:as of|through)\b/gi)].length || dates.some((match) => {
    const observedDay = new Date(time).toISOString().slice(0, 10);
    const claimed = match[1];
    if (/^\d{4}-\d{2}-\d{2}T/i.test(claimed)) return Date.parse(claimed) !== time;
    const allowed = [observedDay, ...["long", "short"].map((month) => new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", month, day: "numeric", year: "numeric",
    }).format(new Date(time)))].map((value) => value.toLowerCase().replaceAll(",", ""));
    return !allowed.includes(claimed.toLowerCase().replaceAll(",", ""));
  })) return false;
  // Stored chunks carry the document title in a bracketed header. It is not
  // part of the record's party name and may be longer than the public title.
  const evidence = recordText(doc);
  const observed = /\b(?:balance|remaining credit) ([A-Z]{3}) (-?\d[\d,]*(?:\.\d+)?) (?:\([^)]*\) )?as of (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(evidence);
  if (!observed || observed[3] !== new Date(time).toISOString()) return false;
  // Consume the ENTIRE claim, not a matching substring. Any unparsed subject,
  // sign, currency, multiplier or additional state clause fails closed.
  const account = accountName(doc);
  const transaction = /^(Invoice|Bill) ([^:]+?) (?:to|from) ([^:]+):/.exec(evidence) ||
    /^(Credit memo) ([^:]+?) for (.+?) on \d{4}-\d{2}-\d{2}:/.exec(evidence);
  const party = transaction?.[3] || /^([^:]+): open balance/.exec(evidence)?.[1];
  const subjects = account ? [account] : party ? [party] : [];
  if (transaction) {
    const [, kind, number, name] = transaction;
    for (const join of ["for", kind === "Invoice" ? "to" : kind === "Bill" ? "from" : "for"]) {
      subjects.push(`${kind} ${number} ${join} ${name}`);
    }
  }
  if (!subjects.length) return false;
  const subjectPattern = subjects.map((subject) => escape(plain(subject)).replace(/\s+/g, "\\s+")).join("|");
  const datePattern = "(?:as of|through)\\s+(?:\\d{4}-\\d{2}-\\d{2}(?:T[\\d:.]+(?:Z|[+-]\\d{2}:\\d{2}))?|[A-Za-z]+ \\d{1,2},? \\d{4})";
  const qualifier = `(?:${datePattern})`;
  const amount = "(?:[A-Z]{3}\\s+|\\$\\s*)-?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,6})?";
  const balancePredicate = "(?:(?:an? )?(?:open |current )?balance|remaining credit)(?: of)?";
  const predicate = `(?:(?:currently )?has ${balancePredicate}|(?:currently )?owes|:\\s*(?:${balancePredicate}|owes)?)`;
  const claim = plain(sentence).replace(/\[\d+\]/g, "").trim().replace(/^[-•]\s+/, "").trim();
  const match = new RegExp(`^(?:${qualifier},?\\s+)?(?:${subjectPattern})\\s*(${predicate})\\s*(${amount})(?: \\(owes (${amount})\\))?(?:\\s+${qualifier})?\\s*[.]?$`, "i").exec(claim);
  if (!match) return false;
  if (/\bremaining credit\b/i.test(match[1]) !== observed[0].startsWith("remaining credit")) return false;
  const money = (value) => /^(?:([A-Z]{3})\s+|(\$)\s*)(-?[\d,]+(?:\.\d+)?)$/.exec(value);
  const sameMoney = (value, expected) => {
    const parsed = money(value);
    return parsed && (parsed[1] || "USD") === observed[1] && amountKey(parsed[3]) === amountKey(expected);
  };
  const cardLiability = /^Credit Card account /.test(evidence) && observed[2].startsWith("-");
  const owing = /\bowes$/i.test(match[1]);
  if (owing && !cardLiability) return false;
  if (!sameMoney(match[2], owing ? observed[2].slice(1) : observed[2])) return false;
  return !match[3] || (cardLiability && !owing && sameMoney(match[3], observed[2].slice(1)));
}

/** Split only named QuickBooks account balances, preserving local citations.
 * The generic current-status rule still handles relationships and other sources.
 * A citation to an unrelated account must never freshen this account's balance.
 */
export function quickBooksAccountBalanceAssertions(sentence, docs) {
  if (!BALANCE.test(sentence) && !MONEY.test(sentence)) return null;
  const accounts = docs.filter((doc) => doc.source_kind === "quickbooks" && accountName(doc));
  if (!BALANCE.test(sentence) && !accounts.some((doc) => compactAccountBalanceClaim(sentence, doc))) return null;
  // Strip presentation marks on both sides of matching. Keep punctuation and
  // offsets so amounts and citations remain bound to their own account clause.
  const text = plain(sentence);
  const names = [...new Set(accounts.map(accountName))].sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  const pattern = names.map((name) => escape(plain(name)).replace(/\s+/g, "\\s+")).join("|");
  const mentions = [...text.matchAll(new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, "gi"))];
  if (!mentions.length) return null;
  const prefix = text.slice(0, mentions[0].index);
  // Amount-before-subject prose is deliberately left to the single-record
  // checker. Do not silently drop an unassigned amount when splitting.
  if (/(?:\b[A-Z]{3}\s*|\$\s*)-?\d/.test(prefix)) return null;
  const pieces = mentions.map((mention, index) => {
    const piece = text.slice(mention.index, mentions[index + 1]?.index ?? text.length);
    return index < mentions.length - 1 ? piece.replace(/(?:[,;]\s*(?:and\s+)?|\s+and\s+)$/i, "").trim() : piece;
  });
  const citations = (value) => [...value.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  // A trailing citation group can cover the whole enumeration only when no
  // earlier clause supplies local citations. Mixed missing citations refuse.
  const sharedCitations = pieces.slice(0, -1).every((part) => citations(part).length === 0)
    ? citations(pieces.at(-1)) : [];
  return pieces.map((piece, index) => {
    const subject = identity(mentions[index][0]);
    const relevant = accounts.filter((doc) => identity(accountName(doc)) === subject);
    const numbers = citations(piece).length ? citations(piece) : sharedCitations;
    const citedSources = new Set(relevant.filter((doc) => numbers.includes(doc.n)).map((doc) => doc.source));
    const candidates = relevant.filter((doc) => citedSources.has(doc.source) && doc.date_reliable === true && Number.isFinite(Date.parse(doc.ts)));
    const newestTime = Math.max(...candidates.map((doc) => Date.parse(doc.ts)));
    return {
      accountBalance: true,
      sentence: `${prefix}${piece}${citations(piece).length ? "" : numbers.map((n) => ` [${n}]`).join("")}`,
      evidence: candidates.filter((doc) => Date.parse(doc.ts) === newestTime),
    };
  });
}

/** A dated list heading qualifies only the following account bullets. It
 * cannot lend a date to unrelated prose, another provider, or a later section.
 */
export function quickBooksBalanceAnswerAssertions(sentences, docs) {
  const assertions = [];
  const bullet = /^\s*[-*•]\s+/;
  let heading = "";
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    const headingText = plain(sentence);
    const dates = [...headingText.matchAll(AS_OF_DATE)];
    const remainder = dates.length === 1 ? normalized(headingText.replace(dates[0][0], "")).trim() : null;
    const headingOnly = remainder !== null && /:\s*$/.test(headingText) &&
      /^(?:(?:quickbooks|bank|and|credit|card|cards|account|accounts|balance|balances|current|the|following|are|in|with)\s*)*$/.test(remainder);
    const next = sentences[index + 1] || "";
    if (headingOnly && bullet.test(next) && quickBooksAccountBalanceAssertions(next, docs)) {
      heading = dates[0][0];
      continue;
    }
    if (!bullet.test(sentence)) heading = "";
    const accounts = quickBooksAccountBalanceAssertions(heading ? `${heading}, ${sentence.replace(bullet, "")}` : sentence, docs);
    if (accounts) assertions.push(...accounts);
    else {
      heading = "";
      assertions.push({ sentence });
    }
  }
  return assertions;
}
