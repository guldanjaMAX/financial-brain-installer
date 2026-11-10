// Preserve frozen older baselines while requiring the exact reviewed copy for
// the current renderer. Numeric/source expectations are deliberately untouched.
export const POSTED_PLAIN = 'This reading covers completed transactions only; pending activity is not included.\nWant me to show your account balances?';
export const LIVE_PLAIN = "Here are your recorded balances, with the date for each account; these do not show live or available cash.\nWant help refreshing the bank connection for a newer balance?";
export const RECURRING_PLAIN = 'I can show repeated bank charges as possible patterns, but they do not prove an active subscription; no detected pattern does not prove none exists.\nWant me to show your account balances?';
export const CATEGORY_PLAIN = 'Here are the spending categories from your bank; those marked unconfirmed have not been reviewed.\nWant me to show your account balances?';
export const TRANSFERS_PLAIN = 'This reading checks possible moves with enough account details to review; matching amounts alone do not confirm transfers, and no matches does not prove none occurred.\nWant me to show your account balances?';
export const LABELS_PLAIN = 'Income is still unconfirmed; a deposit can be a transfer or another kind of credit, and the bank label alone does not prove its source.\nWant me to show your account balances?\nUncertain deposits remain included.';
export function reviewedPlainCopy(text, { dates = true } = {}) {
  const result = text.replaceAll('Figures use recorded posted rows. Pending activity is not assessed here.', POSTED_PLAIN)
    .replaceAll('Recorded observations, not live or available cash.', LIVE_PLAIN)
    .replaceAll('no posted income or expenses', 'no completed income or expenses')
    .replace(/(Found a deposit of \$[\d,.]+) posted /g, '$1 dated ')
    .replaceAll("I can't forecast next month's bank balance. Here is the current recorded snapshot instead.", 'I can show your recorded balances, but future balances and payments are unknown.\nWant me to show your account balances?')
    .replaceAll('Source and own-account transfer status are not established by a payer label; uncertain credits remain included.', LABELS_PLAIN)
    .replaceAll('Coverage: requested ', 'Bank history: requested ')
    .replaceAll('Coverage: full, all ', 'Bank history: all ')
    .replaceAll(' selected accounts cover ', ' selected accounts include ')
    .replaceAll('Ambiguous: multiple deposits match the supplied payment details; no single payment is confirmed.', 'I found 2 matching deposits in 2026-10-05 through 2026-10-19, so no single payment is confirmed.\nWant me to show your account balances?')
    .replaceAll('\nEstimated monthly total:', `\n${RECURRING_PLAIN}\nEstimated monthly total:`);
  return dates ? reviewedDateCopy(result) : result;
}

// Independent synthetic display expectations. Machine dates are asserted by
// the suites separately; this helper imports no product formatter or reader.
export function reviewedDateCopy(text) {
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const day = value => {
    const [year, month, date] = value.split('-').map(Number);
    return `${names[month - 1]} ${date}${year === 2026 ? '' : `, ${year}`}`;
  };
  const span = (from, to) => {
    const [year, month, date] = from.split('-').map(Number);
    const [endYear, endMonth, endDate] = to.split('-').map(Number);
    if (from === to) return day(from);
    if (date === 1 && endDate === new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate()) {
      const first = `${names[month - 1]}${year === 2026 ? '' : ` ${year}`}`;
      return year === endYear && month === endMonth ? first
        : `${first} through ${names[endMonth - 1]}${endYear === 2026 ? '' : ` ${endYear}`}`;
    }
    return year === endYear && month === endMonth
      ? `${names[month - 1]} ${date} to ${endDate}${year === 2026 ? '' : `, ${year}`}` : `${day(from)} to ${day(to)}`;
  };
  return text.replace(/(You spent .+? at .+?) from /g, '$1 in ')
    .replace(/(You spent|Spending I could check:|Money out I could check:) (\$[\d,.]+) (\d{4}-)/g, '$1 $2 in $3')
    .replace(/\b(\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2})\b/g, (_, from, to) => span(from, to))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, day)
    .replace(/account \*{4}(\d{1,4})/g, 'your account ending $1')
    .replaceAll('feed synced unavailable', 'last update unavailable')
    .replaceAll(' selected covered accounts', ' accounts with records')
    .replaceAll(' selected accounts', ' accounts')
    .replaceAll('across 1 accounts with records', 'across 1 account with records')
    .replaceAll('in October 2026', 'in October')
    .replaceAll('deposits match from ', 'deposits match in ')
    .replaceAll(' Try:', '\nTry:');
}

export function reviewedTitleFields(value) {
  if (Array.isArray(value)) return value.map(reviewedTitleFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['title', 'account_label'].includes(key) && typeof item === 'string' ? reviewedDateCopy(item) : reviewedTitleFields(item)]));
}

export const MONEY_JARGON = /\b(?:posted|reader|schema|intent|provider|manifest|scope|structured[ -]payee|ledger|coverage|classification|snapshot|documents path|selected|interval|certified|provenance|reconciliation)\b|\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}:\d{2}|\*{4}/i;

// The explicit absence contract uses ISO bounds; other prose still rejects ISO.
export const absenceLintText = text => text.replace(/^No charges found for .+ from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} on .+\.$/gm,
  line => line.replace(/\d{4}-\d{2}-\d{2}/g, 'date'));

export const MCP_DELETE_PLAIN = "I can help prepare a deletion preview, but this connection has no permission to delete. Want to use delete_preview with a break-glass connection, then have the owner approve its receipt with a fresh passkey?";
export const MCP_WRITE_PLAIN = "I can help you read records with this connection, but it has no permission to save curated records. Want to reconnect as structured-contributor?";
export const PAYER_PARTIAL_LINE = /^(?:I found \d+ deposits?, but the bank details do not identify (?:it|them) as that payer's payment, so payment is unconfirmed\.|(?:Income from that payer is at least \$[\d,.]+ \(matched subtotal, not complete\); )?I can help review the deposits, but the full income from that payer is unconfirmed\. There (?:is 1 deposit, and its bank label may|are \d+ deposits, and their bank labels may) not identify who paid\.)$/m;

// Frozen expectations move reviewed invitations after all original facts.
// Exact answer comparisons still check every byte, including the chosen offer.
export function reviewedFinalOffer(text, chosen = 'Want me to show your account balances?') {
  const invitations = [
    'Want me to show your account balances?',
    'Want help refreshing the bank connection for a newer balance?',
    'Want to do it now?',
    'Want me to check spending at Vendorwaveworks in October?',
    'Want me to check spending at Goog Kitchen in October?',
  ];
  for (const invitation of invitations) text = text.replaceAll('\n' + invitation, '')
    .replaceAll(' ' + invitation, '');
  return text.trim() + '\n' + chosen;
}
