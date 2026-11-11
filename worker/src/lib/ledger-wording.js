import { moneyAccount, moneyAccounts } from './money-format.js';
// Presentation only. Refusal codes, admission, amounts and citations stay with
// the caller; a wording helper must never promote a partial result to a total.
export const balanceSuggestion = 'Want me to show your account balances?';
export const originalRecordSuggestion = 'Want to check the original record?';
export const pendingNotice = `This reading covers completed transactions only; pending activity is not included.\n${balanceSuggestion}`;
export const documentMoneyNotice = "This answer comes from your documents; I did not match it to your bank data.";
export function plainMoneyCheck(rule) {
  const reasons = {
    ambiguous_boundary: "It is unclear which words belong together, so the amount is unconfirmed.",
    document_coverage: "A document excerpt does not prove that every payment was checked or that none are missing.",
    missing_citation: "The amount has no source reference beside it.",
    unreliable_date: "The supporting record has no reliable date.",
    ineligible_support: "The cited material is not an original record I can use to confirm money.",
    span_mismatch: "The amount, account, or month does not match the cited words.",
    citation_outside_window: "The supporting record is outside the dates you asked about.",
    claim_outside_window: "The payment date in the record is outside the dates you asked about.",
    incomplete_claim: "Some payment details are still unknown in the records checked.",
    claim_date_unknown: "The record does not say when the payment arrived, was completed, or became due.",
  };
  return `I can help review the source, but ${['incomplete_claim', 'claim_date_unknown'].includes(rule) ? 'some money details are still unconfirmed' : 'this money claim is unconfirmed'}. ${reasons[rule]}\n${originalRecordSuggestion}`;
}
export const accountEndings = moneyAccounts;

export function plainRouterLimitation(reason) {
  const details = {
    balance_meaning: 'I can help review what a recorded balance means, but bank transactions alone do not establish that meaning.',
    custom_grouping: 'I can help review recorded bank categories, but a custom grouping has not been added.',
    extra_part: 'I can help review completed bank transactions, but the extra part is still unanswered.',
    reading_unavailable: 'I can help check the bank connection, but the records needed to confirm a figure are unavailable.',
  };
  return `${details[reason] || details.reading_unavailable}\n${balanceSuggestion}`;
}

export function plainBankGap(reason, accounts, intent) {
  const history = intent.presentation.history(accounts);
  const withHistory = (text, suggestion = balanceSuggestion) => [text, history, suggestion].filter(Boolean).join('\n');
  const details = {
    ledger_account_kind_review_required: "Before I count this as spending, I need to know which accounts are cards or loans. It's a one-time question. Want to do it now?",
    ledger_wording_unsupported: 'I want to make sure I get this right. I can show you balances, recent transactions, or what you spent in a set period. Which would help most?',
    owner_timezone_unavailable: `I can check a month and year, but relative dates need a valid time zone.\nWant to choose a month and year?`,
    cash_flow_unsupported: 'Cash flow gets tricky here, since some card purchases may not be paid yet. I can show money in and money out side by side instead. Want that?',
    merchant_selector_unsupported: "That store's name is hidden, shortened, or unknown on your statement, so I do not want to guess. If you tell me roughly what it was, I'll look again.",
    merchant_selector_ambiguous: `A different spelling with "and" or "&" may be a different business, so those names stay separate.\n${balanceSuggestion}`,
    coverage_review_required: withHistory("I can help review the bank records, but an earlier import may have left gaps between dates, so a complete total is unconfirmed.", 'Want help checking the bank statements?'),
    bank_export_overlap_review_required: withHistory("I can help compare the bank records, but two exports may count the same purchase twice, so a reliable total is unconfirmed.", 'Want help comparing the original statements?'),
    ledger_partial_coverage: withHistory("This is a partial reading of the bank records; some days may be missing, so the list or ranking may be incomplete."),
    ledger_account_link_required: `I can help review these records, but an import and a bank connection may describe the same account, so they stay separate: ${accountEndings(accounts)}.\nWant help reviewing them together?`,
    no_accounts: `I can help find the right account, but no connected account matches this request${intent.mask ? ` for ${moneyAccount({ mask: intent.mask })}` : ''}.\nWant help connecting the account you want to ask about?`,
    ambiguous_account: withHistory("I can help choose the right account, but its details are still unconfirmed.", 'Want help confirming which account to use?'),
    unsupported_currency: withHistory("I can help review a US dollar account separately, but at least one of these accounts uses another currency, so a combined US dollar total is unconfirmed.", 'Want to choose a US dollar account?'),
    balance_unavailable: withHistory("I can help review the bank connection, but a confirmed US dollar balance dated on or before today is missing or unreadable, so not every balance is available.", 'Want help refreshing the bank connection?'),
    period_outside_coverage: withHistory(`I can help check the bank records for ${intent.presentation.period(intent.from, intent.to)}, but some bank days are missing, so a complete answer is unconfirmed.`) +
      `\nAccounts missing bank history: ${accountEndings(accounts)}.\nRefresh the bank connection or import statements covering every requested date for these accounts, then try again.`,
    unreadable_transactions: withHistory("I can help review these transactions, but some amounts, dates, currencies, or directions are unconfirmed, so no total is confirmed."),
    retrieval_scope_restricted: "I can help with the records this session permits, but limited access or document filters keep bank accounts out of this answer.\nWant to use your owner session without document filters?",
    unsupported_question: "I can help review your completed bank transactions, but they do not establish this fact on their own.\nWant help finding records that establish it?",
    ledger_unavailable: withHistory("I can help check the bank connection, but the bank data was not read successfully or exceeded the account or transaction limit.", 'Want help checking the connection before trying again?'),
  };
  // Unknown future codes still fail visibly without echoing internal codes.
  return (details[reason] || "I can help check the bank connection, but the needed bank records are still unverified.\nWant help checking the bank connection?").trim();
}

// An incomplete recurring reading is a list, never a zero-valued total.
export function recurringSetAsideText(ledger) {
  if (!ledger?.set_aside_recurring?.length) return null;
  const money = n => (n < 0 ? '-' : '') + '$' + Math.floor(Math.abs(n) / 100).toLocaleString('en-US') + '.' + String(Math.abs(n) % 100).padStart(2, '0');
  const refs = g => (g.citations || []).map(n => '[' + n + ']').join(' ');
  const confirmed = ledger.recurring || [];
  const lines = confirmed.length ? ['Recurring charges detected, not confirmed subscriptions:',
    ...confirmed.map(g => g.merchant + ': ' + g.cadence + ', typical ' + money(g.typical_minor) + '; last charge ' + money(g.last_amount_minor) + ' on ' + g.last_charge +
      (g.cadence_dates ? '; paying account ' + (/^\d{1,4}$/.test(g.account_mask || '') ? 'ending ' + g.account_mask : '(mask unavailable)') + '; cadence evidence ' + g.cadence_dates.join(', ') : '') + ' ' + refs(g) + '.'),
    'Confirmed recurring charges estimated monthly subtotal: ' + money(ledger.confirmed_subtotal_minor) + '.'] : [];
  lines.push('Possible transfers or payments between your own accounts: set-aside recurring-pattern charges:');
  for (const g of ledger.set_aside_recurring) lines.push(g.payee + ': ' + g.cadence + '; ' + g.dates.map((date, i) => money(g.amounts_minor?.[i] ?? g.amount_minor) + ' on ' + date).join('; ') + ' ' + refs(g) + '.');
  lines.push('These may be payments to your own accounts, so they are not counted.');
  return lines.join('\n');
}

// All surfaces render the same cited postings, including monthly composition.
// The remainder preserves every omitted cent and its supporting references.
export function paymentExclusionLines(payments, presentation, { omitTotal = false } = {}) {
  const money = cents => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
  const refs = rows => rows.map(row => `[${row.n}]`).join(' ');
  const ordered = [...payments.rows].sort((a, b) => b.amount_minor - a.amount_minor ||
    b.posted_on.localeCompare(a.posted_on) || a.n - b.n);
  const pairingUncertain = ordered.some(row => row.pairing_uncertain);
  const unit = pairingUncertain ? 'posting' : 'payment';
  const lines = [`Payments to loans and cards (excluded from spending and income): ${omitTotal ? '' : `${money(payments.total_minor)} across `}${payments.count} ${unit}${payments.count === 1 ? '' : 's'} ${refs(ordered)}.`];
  if (pairingUncertain) lines.push('Payment pairing is uncertain; all unpaired postings are retained. The economic payment count and total are unconfirmed.');
  for (const row of ordered.slice(0, 5)) {
    const label = row.payment_kind === 'card' ? 'payment to a card'
      : row.own_loan_mask ? `payment to your own loan (ending ${row.own_loan_mask})` : 'payment to a loan';
    lines.push(`${label}: ${money(row.amount_minor)} on ${presentation.date(row.posted_on)} in ${moneyAccount({ mask: row.account_mask })} [${row.n}]${row.match_basis === 'possible' ? '; possible vendor-description matches, payee attribution remains unconfirmed' : ''}.`);
  }
  const rest = ordered.slice(5);
  if (rest.length) lines.push(`and ${rest.length} more: ${money(rest.reduce((sum, row) => sum + row.amount_minor, 0))} ${refs(rest)}.`);
  return lines.join('\n');
}
