import { goldFor, GOLD_VERSION } from '../../test/fixtures/fastloop-money/gold.mjs';
import { evidence } from '../../test/fixtures/fastloop-money/input.mjs';
import { displayFigures, formatMinor, same, total, ORACLE_VERSION } from './money-oracle.mjs';
import { sha } from './money-replay.mjs';
import { readFileSync } from 'node:fs';

export const SCORING_IDENTITY = sha(['./money-score.mjs', './money-oracle.mjs',
  '../../test/fixtures/fastloop-money/gold.mjs'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')));

export const VERDICTS = ['correct', 'partly', 'wrong figure', 'missing source', 'honest refusal', 'over-refusal'];
// Exact reviewed renderer lines for the frozen synthetic bank. Retain the old
// lines for the pinned comparison; do not admit a broader prose pattern.
const PLAIN_ABSENCE = 'I can\'t give a total for "Absent Store" yet. No payee with that exact name was found from 2026-09-01 through 2026-09-30. The bank supplied no payee names for this period. Try: "What are my account balances?"';
const PLAIN_LINES = new Set([
  'No charges found for Absent Store from 2026-09-01 to 2026-09-30 on your account ending 3131, your account ending 4242, your account ending 5353.',
  PLAIN_ABSENCE,
  "I can't show your live or available cash. These balances were recorded earlier; check each account's date. Refresh the bank connection for a newer balance.",
  'Bank history: all 3 selected accounts include 2026-09-01 through 2026-09-30.',
  'Bank history: all 3 selected accounts include 2026-10-01 through 2026-10-31.',
  'Bank history: requested 2026-09-01 through 2026-09-30; 0 contributing, 3 fully covered, 0 omitted accounts; account ****3131 covered through 2026-11-07; account ****4242 covered through 2026-11-07; account ****5353 covered through 2026-11-07.',
  'Bank history: requested 2026-10-01 through 2026-10-31; 1 contributing, 3 fully covered, 0 omitted accounts; account ****3131 covered through 2026-11-07; account ****4242 covered through 2026-11-07; account ****5353 covered through 2026-11-07.',
  'I can\'t confirm that all money out was spending. The account types for account ****4242 have not been confirmed, so some payments may be between your own accounts. Try: "What are my account balances?"',
  'I can\'t forecast next month\'s bank balance. Bank balances show what was recorded, not future payments. Try: "What are my account balances?"',
  'I can\'t say all of this was income. A deposit can be a transfer or another kind of credit; the bank label alone does not prove its source. Try: "What are my account balances?"',
  'I can\'t show pending activity. These figures include posted transactions only. Try: "What are my account balances?"',
  'Money out I could check: $1,010.00 this month; the account types have not been confirmed, so this may include payments between your own accounts.',
  'Uncertain deposits remain included.',
]);
// These frozen display translations admit only the exact new fixture text.
// The original figure, date, account, citation and prose checks run unchanged.
// Consume the original input once so translations can never cascade.
const REVIEWED_LINES = [
  ['Combined recorded inflow: $746.11 gross across 3 accounts with records, September; not established income.', 'Combined recorded inflow: $746.11 across 3 selected covered accounts, 2026-09-01 through 2026-09-30; not established income.'],
  ['Combined recorded inflow: $322.33 gross across 1 account with records, September; not established income.', 'Combined recorded inflow: $322.33 across 1 selected covered accounts, 2026-09-01 through 2026-09-30; not established income.'],
  ['your account ending 3131, October: money in $233.32; money out $610.00.', 'account ****3131, 2026-10-01 through 2026-10-31: money in $233.32; money out $610.00.'],
  ['your account ending 4242, October: money in $0.00; money out $0.00.', 'account ****4242, 2026-10-01 through 2026-10-31: money in $0.00; money out $0.00.'],
  ['your account ending 5353, October: money in $0.00; money out $0.00.', 'account ****5353, 2026-10-01 through 2026-10-31: money in $0.00; money out $0.00.'],
  ["Found a deposit of $177.77 dated October 12 in your account ending 3131: Payer Unit [1].", "Found a deposit of $177.77 posted 2026-10-12 in account ****3131: Payer Unit [1]."],

  ["Here is the money out I could check, with spending still unconfirmed. The account types for your account ending 4242 have not been confirmed, so some payments may be between your own accounts.\nWant me to show your account balances?", "I can't confirm that all money out was spending. The account types for account ****4242 have not been confirmed, so some payments may be between your own accounts. Try: \"What are my account balances?\""],
  ["I checked September, but no payee exactly matched \"Absent Store\", so no store total is confirmed. The bank supplied no payee names for this period.\nWant me to show your account balances?", "I can't give a total for \"Absent Store\" yet. No payee with that exact name was found from 2026-09-01 through 2026-09-30. The bank supplied no payee names for this period. Try: \"What are my account balances?\""],
  ["Income is still unconfirmed; a deposit can be a transfer or another kind of credit, and the bank label alone does not prove its source.\nWant me to show your account balances?", "I can't say all of this was income. A deposit can be a transfer or another kind of credit; the bank label alone does not prove its source. Try: \"What are my account balances?\""],
  ["Here are your recorded balances, with the date for each account; these do not show live or available cash.\nWant help refreshing the bank connection for a newer balance?", "I can't show your live or available cash. These balances were recorded earlier; check each account's date. Refresh the bank connection for a newer balance."],
  ["I can show your recorded balances, but future balances and payments are unknown.\nWant me to show your account balances?", "I can't forecast next month's bank balance. Bank balances show what was recorded, not future payments. Try: \"What are my account balances?\""],
  ["your account ending 4242, September: credits $0.00; debits $0.00 (no completed income or expenses in the covered period).", "account ****4242, 2026-09-01 through 2026-09-30: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)."],
  ["your account ending 4242, October: credits $0.00; debits $0.00 (no completed income or expenses in the covered period).", "account ****4242, 2026-10-01 through 2026-10-31: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)."],
  ["your account ending 5353, October: credits $0.00; debits $0.00 (no completed income or expenses in the covered period).", "account ****5353, 2026-10-01 through 2026-10-31: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)."],
  ["This reading covers completed transactions only; pending activity is not included.\nWant me to show your account balances?", "I can't show pending activity. These figures include posted transactions only. Try: \"What are my account balances?\""],

  // R1 removes the payment from alternate ranking citations as well.
  ["$400.00 on September 12 in your account ending 3131: payment to outside lender [1]", "$400.00 on 2026-09-12 in account ****3131: payment to outside lender [1]"],
  ["$60.00 on September 25 in your account ending 3131: Store One [2]", "$60.00 on 2026-09-25 in account ****3131: Store One [2]"],
  ["$50.00 on September 24 in your account ending 3131: Store Two [3]", "$50.00 on 2026-09-24 in account ****3131: Store Two [3]"],
  ["$40.00 on September 23 in your account ending 3131: Store Three [4]", "$40.00 on 2026-09-23 in account ****3131: Store Three [4]"],
  ["$30.00 on September 22 in your account ending 3131: Store Four [5]", "$30.00 on 2026-09-22 in account ****3131: Store Four [5]"],
  ["$400.00 on September 12 in your account ending 3131: payment to outside lender [2]", "$400.00 on 2026-09-12 in account ****3131: payment to outside lender [2]"],
  ["$60.00 on September 25 in your account ending 3131: Store One [3]", "$60.00 on 2026-09-25 in account ****3131: Store One [3]"],
  ["$50.00 on September 24 in your account ending 3131: Store Two [4]", "$50.00 on 2026-09-24 in account ****3131: Store Two [4]"],
  ["$40.00 on September 23 in your account ending 3131: Store Three [5]", "$40.00 on 2026-09-23 in account ****3131: Store Three [5]"],
  ["$30.00 on September 22 in your account ending 3131: Store Four [6]", "$30.00 on 2026-09-22 in account ****3131: Store Four [6]"],
  ["$400.00 on September 12 in your account ending 3131: payment to account 4242 [1]", "$400.00 on 2026-09-12 in account ****3131: payment to account 4242 [1]"],
  ["You spent $60.00 at Store One in July 31 to October 31. [1].", "You spent $60.00 at Store One from 2026-07-31 through 2026-10-31. [1]."],
  ["Bank history: requested July 31 to October 31; 1 contributing, 3 fully covered, 0 omitted accounts; your account ending 3131 covered through November 7; your account ending 4242 covered through November 7; your account ending 5353 covered through November 7.",
   "Coverage: requested 2026-07-31 through 2026-10-31; 1 contributing, 3 fully covered, 0 omitted accounts; account ****3131 covered through 2026-11-07; account ****4242 covered through 2026-11-07; account ****5353 covered through 2026-11-07."],
  ["Money out I could check: $1,010.00 this month.", "Recorded outgoing subtotal: $1,010.00."],
  [
    "Accounts: your account ending 3131, your account ending 4242, your account ending 5353; September; your account ending 3131: covered through November 7; your account ending 4242: covered through November 7; your account ending 5353: covered through November 7.",
    "Accounts: account ****3131, account ****4242, account ****5353; 2026-09-01 through 2026-09-30; account ****3131: covered through 2026-11-07; account ****4242: covered through 2026-11-07; account ****5353: covered through 2026-11-07."
  ],
  [
    "Accounts: your account ending 3131, your account ending 4242, your account ending 5353; October; your account ending 3131: covered through November 7; your account ending 4242: covered through November 7; your account ending 5353: covered through November 7.",
    "Accounts: account ****3131, account ****4242, account ****5353; 2026-10-01 through 2026-10-31; account ****3131: covered through 2026-11-07; account ****4242: covered through 2026-11-07; account ****5353: covered through 2026-11-07."
  ],
  [
    "Accounts: your account ending 3131, your account ending 4242, your account ending 5353; your account ending 3131: covered through November 7; your account ending 4242: covered through November 7; your account ending 5353: covered through November 7.",
    "Accounts: account ****3131, account ****4242, account ****5353; account ****3131: covered through 2026-11-07; account ****4242: covered through 2026-11-07; account ****5353: covered through 2026-11-07."
  ],
  [
    "Bank history: requested September; 0 contributing, 3 fully covered, 0 omitted accounts; your account ending 3131 covered through November 7; your account ending 4242 covered through November 7; your account ending 5353 covered through November 7.",
    "Bank history: requested 2026-09-01 through 2026-09-30; 0 contributing, 3 fully covered, 0 omitted accounts; account ****3131 covered through 2026-11-07; account ****4242 covered through 2026-11-07; account ****5353 covered through 2026-11-07."
  ],
  [
    "Bank history: requested October; 1 contributing, 3 fully covered, 0 omitted accounts; your account ending 3131 covered through November 7; your account ending 4242 covered through November 7; your account ending 5353 covered through November 7.",
    "Bank history: requested 2026-10-01 through 2026-10-31; 1 contributing, 3 fully covered, 0 omitted accounts; account ****3131 covered through 2026-11-07; account ****4242 covered through 2026-11-07; account ****5353 covered through 2026-11-07."
  ],
  [
    "I can't confirm that all money out was spending. The account types for your account ending 4242 have not been confirmed, so some payments may be between your own accounts.\nTry: \"What are my account balances?\"",
    "I can't confirm that all money out was spending. The account types for account ****4242 have not been confirmed, so some payments may be between your own accounts. Try: \"What are my account balances?\""
  ],
  [
    "I can't give a total for \"Absent Store\" yet. No payee with that exact name was found in September. The bank supplied no payee names for this period.\nTry: \"What are my account balances?\"",
    "I can't give a total for \"Absent Store\" yet. No payee with that exact name was found from 2026-09-01 through 2026-09-30. The bank supplied no payee names for this period. Try: \"What are my account balances?\""
  ],
  [
    "I can't say all of this was income. A deposit can be a transfer or another kind of credit; the bank label alone does not prove its source.\nTry: \"What are my account balances?\"",
    "I can't say all of this was income. A deposit can be a transfer or another kind of credit; the bank label alone does not prove its source. Try: \"What are my account balances?\""
  ],
  [
    "I can't show your live or available cash. These balances were recorded earlier; check each account's date.\nTry: Refresh the bank connection for a newer balance.",
    "I can't show your live or available cash. These balances were recorded earlier; check each account's date. Refresh the bank connection for a newer balance."
  ],
  [
    "I can't forecast next month's bank balance. Bank balances show what was recorded, not future payments.\nTry: \"What are my account balances?\"",
    "I can't forecast next month's bank balance. Bank balances show what was recorded, not future payments. Try: \"What are my account balances?\""
  ],
  [
    "your account ending 4242, September: credits $0.00; debits $0.00 (no posted income or expenses in the covered period).",
    "account ****4242, 2026-09-01 through 2026-09-30: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)."
  ],
  [
    "your account ending 4242, October: credits $0.00; debits $0.00 (no posted income or expenses in the covered period).",
    "account ****4242, 2026-10-01 through 2026-10-31: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)."
  ],
  [
    "your account ending 5353, October: credits $0.00; debits $0.00 (no posted income or expenses in the covered period).",
    "account ****5353, 2026-10-01 through 2026-10-31: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)."
  ],
  [
    "I can't show pending activity. These figures include posted transactions only.\nTry: \"What are my account balances?\"",
    "I can't show pending activity. These figures include posted transactions only. Try: \"What are my account balances?\""
  ],
  [
    "your account ending 3131, October: credits $233.32; debits $1,010.00 [1] [2] [3] [4] [5] [6] [7] [8] [9] [10] [11].",
    "account ****3131, 2026-10-01 through 2026-10-31: credits $233.32; debits $1,010.00 [1] [2] [3] [4] [5] [6] [7] [8] [9] [10] [11]."
  ],
  [
    "your account ending 3131, October: credits $233.32; debits $610.00 [1] [2] [3] [4] [5] [6] [7] [8] [9] [10].",
    "account ****3131, 2026-10-01 through 2026-10-31: credits $233.32; debits $610.00 [1] [2] [3] [4] [5] [6] [7] [8] [9] [10]."
  ],
  [
    "Operating account (your account ending 3131): $5,023.45 as of October 30; last update unavailable [1].",
    "Operating account (account ****3131): $5,023.45 as of 2026-10-30; feed synced unavailable [1]."
  ],
  [
    "Reserve account (your account ending 5353): $2,000.01 as of October 30; last update unavailable [2].",
    "Reserve account (account ****5353): $2,000.01 as of 2026-10-30; feed synced unavailable [2]."
  ],
  [
    "Combined recorded inflow: $746.11 across 3 accounts with records, September; not established income.",
    "Combined recorded inflow: $746.11 across 3 selected covered accounts, 2026-09-01 through 2026-09-30; not established income."
  ],
  [
    "Accounts: your account ending 3131; September; your account ending 3131: covered through November 7.",
    "Accounts: account ****3131; 2026-09-01 through 2026-09-30; account ****3131: covered through 2026-11-07."
  ],
  [
    "Combined recorded inflow: $322.33 across 1 account with records, September; not established income.",
    "Combined recorded inflow: $322.33 across 1 selected covered accounts, 2026-09-01 through 2026-09-30; not established income."
  ],
  [
    "Owned loan (your account ending 4242): $8,800.00 as of October 30; last update unavailable [3].",
    "Owned loan (account ****4242): $8,800.00 as of 2026-10-30; feed synced unavailable [3]."
  ],
  [
    "Found a deposit of $177.77 posted October 12 in your account ending 3131: Payer Unit [1].",
    "Found a deposit of $177.77 posted 2026-10-12 in account ****3131: Payer Unit [1]."
  ],
  [
    "October 12: Outside Lender, -$400.00, Operating account (your account ending 3131) [9].",
    "2026-10-12: Outside Lender, -$400.00, Operating account (account ****3131) [9]."
  ],
  [
    "October 19: Payer Boundary, $33.33, Operating account (your account ending 3131) [7].",
    "2026-10-19: Payer Boundary, $33.33, Operating account (account ****3131) [7]."
  ],
  [
    "October 23: Store Three, -$40.00, Operating account (your account ending 3131) [3].",
    "2026-10-23: Store Three, -$40.00, Operating account (account ****3131) [3]."
  ],
  [
    "Lookup window: October 5 to 19, inclusive (plus or minus 7 days around October 12).",
    "Lookup window: 2026-10-05 through 2026-10-19, inclusive (plus or minus 7 days around 2026-10-12)."
  ],
  [
    "October 22: Store Four, -$30.00, Operating account (your account ending 3131) [4].",
    "2026-10-22: Store Four, -$30.00, Operating account (account ****3131) [4]."
  ],
  [
    "October 21: Store Five, -$20.00, Operating account (your account ending 3131) [5].",
    "2026-10-21: Store Five, -$20.00, Operating account (account ****3131) [5]."
  ],
  [
    "October 12: Payer Unit, $177.77, Operating account (your account ending 3131) [8].",
    "2026-10-12: Payer Unit, $177.77, Operating account (account ****3131) [8]."
  ],
  [
    "October 25: Store One, -$60.00, Operating account (your account ending 3131) [1].",
    "2026-10-25: Store One, -$60.00, Operating account (account ****3131) [1]."
  ],
  [
    "October 24: Store Two, -$50.00, Operating account (your account ending 3131) [2].",
    "2026-10-24: Store Two, -$50.00, Operating account (account ****3131) [2]."
  ],
  [
    "October 20: Store Six, -$10.00, Operating account (your account ending 3131) [6].",
    "2026-10-20: Store Six, -$10.00, Operating account (account ****3131) [6]."
  ],
  [
    "October 12: payment, -$400.00, Operating account (your account ending 3131) [10].",
    "2026-10-12: payment, -$400.00, Operating account (account ****3131) [10]."
  ],
  [
    "$400.00 on October 12 in your account ending 3131: payment to outside lender [2]",
    "$400.00 on 2026-10-12 in account ****3131: payment to outside lender [2]"
  ],
  [
    "$400.00 on October 12 in your account ending 3131: payment to outside lender [1]",
    "$400.00 on 2026-10-12 in account ****3131: payment to outside lender [1]"
  ],
  [
    "$400.00 on October 12 in your account ending 3131: payment to account 4242 [1]",
    "$400.00 on 2026-10-12 in account ****3131: payment to account 4242 [1]"
  ],
  [
    "your account ending 3131, September: credits $322.33; debits $0.00 [1] [4].",
    "account ****3131, 2026-09-01 through 2026-09-30: credits $322.33; debits $0.00 [1] [4]."
  ],
  [
    "your account ending 5353, September: credits $423.78; debits $0.00 [2] [3].",
    "account ****5353, 2026-09-01 through 2026-09-30: credits $423.78; debits $0.00 [2] [3]."
  ],
  [
    "your account ending 3131, September: credits $322.33; debits $0.00 [1] [2].",
    "account ****3131, 2026-09-01 through 2026-09-30: credits $322.33; debits $0.00 [1] [2]."
  ],
  [
    "$40.00 on October 23 in your account ending 3131: Store Three [5]",
    "$40.00 on 2026-10-23 in account ****3131: Store Three [5]"
  ],
  [
    "$40.00 on October 23 in your account ending 3131: Store Three [4]",
    "$40.00 on 2026-10-23 in account ****3131: Store Three [4]"
  ],
  [
    "$30.00 on October 22 in your account ending 3131: Store Four [6]",
    "$30.00 on 2026-10-22 in account ****3131: Store Four [6]"
  ],
  [
    "$30.00 on October 22 in your account ending 3131: Store Four [5]",
    "$30.00 on 2026-10-22 in account ****3131: Store Four [5]"
  ],
  [
    "$60.00 on October 25 in your account ending 3131: Store One [3]",
    "$60.00 on 2026-10-25 in account ****3131: Store One [3]"
  ],
  [
    "$50.00 on October 24 in your account ending 3131: Store Two [4]",
    "$50.00 on 2026-10-24 in account ****3131: Store Two [4]"
  ],
  [
    "$60.00 on October 25 in your account ending 3131: Store One [2]",
    "$60.00 on 2026-10-25 in account ****3131: Store One [2]"
  ],
  [
    "$50.00 on October 24 in your account ending 3131: Store Two [3]",
    "$50.00 on 2026-10-24 in account ****3131: Store Two [3]"
  ],
  [
    "You spent $400.00 at Outside Lender in October. [1].",
    "You spent $400.00 at Outside Lender in October 2026. [1]."
  ],
  [
    "Bank history: all 3 accounts include September.",
    "Bank history: all 3 selected accounts include 2026-09-01 through 2026-09-30."
  ],
  [
    "Bank history: all 3 accounts include October.",
    "Bank history: all 3 selected accounts include 2026-10-01 through 2026-10-31."
  ],
  [
    "Period: September.",
    "Period: 2026-09-01 through 2026-09-30."
  ],
  [
    "Period: October.",
    "Period: 2026-10-01 through 2026-10-31."
  ]
];
function reviewedMoneyCopy(text) {
  let result = '', offset = 0;
  const offers = text.match(/Want[^?\n]*\?/g) || [];
  const approved = ['Want me to show your account balances?', 'Want help refreshing the bank connection for a newer balance?'];
  const finalOffer = offers.length === 1 && approved.includes(offers[0]) && text.endsWith(offers[0]) ? offers[0] : null;
  while (offset < text.length) {
    const match = REVIEWED_LINES.map(([current, legacy]) => {
      // The reviewed current composer moves the invitation after all facts.
      // Admit only the same exact sentences and one reviewed final question.
      const invitation = approved.find(offer => current.endsWith('\n' + offer));
      const fact = finalOffer && invitation ? current.slice(0, -invitation.length - 1) : current;
      return [fact, legacy];
    }).find(([current]) => text.startsWith(current, offset) &&
      (offset + current.length === text.length || text[offset + current.length] === '\n'));
    if (finalOffer && text.slice(offset) === finalOffer) break;
    if (match) { result += match[1]; offset += match[0].length; }
    else {
      const end = text.indexOf('\n', offset);
      const next = end < 0 ? text.length : end;
      result += text.slice(offset, next); offset = next;
    }
    if (text[offset] === '\n') { result += '\n'; offset++; }
  }
  return result;
}
const rowId = citation => Number(/^ledger:transaction:(\d+)$/.exec(citation?.ref || '')?.[1]);
export function scoreObservation(observation, input, gold = goldFor(input.id)) {
  const result = { id: input.id, base: input.base, execution_status: observation?.execution_status || 'missing',
    verdict: null, safety_failures: [], reasons: [], checks: [], figure_results: [], figure_checks: 0, source_checks: 0,
    required_obligations: [...gold.required_obligations],
    required_facts_met: 0, required_facts_total: gold.required_obligations.length, utility: 0, document_answer_tested: false };
  if (result.execution_status !== 'complete') return result;
  const body = observation.body, ledger = body?.ledger ? structuredClone(body.ledger) : null;
  let rawAnswer = body?.answer || '';
  let answer = reviewedMoneyCopy(rawAnswer);
  const exactKnownLines = new Set();
  const nearPayment = gold.contract === 'payment' && input.period.rule === 'anchor minus/plus seven calendar days, inclusive';
  const snapshot = input.snapshot || evidence(input.profile, input.account_reviews), rows = new Map(snapshot.rows.map(r => [r.id, r]));
  // Pending expectations come from the frozen independent envelope, never the answer.
  const balanceContract = ['balance', 'forecast'].includes(gold.contract);
  const balancePending = balanceContract ? snapshot.rows.filter(row => row.pending &&
    snapshot.accounts.some(account => account.slug === row.account && gold.balances.some(b => b.mask === account.mask) &&
      row.date >= account.observed) && row.date <= input.clock.now_utc.slice(0, 10)) : [];
  const pendingOutflow = total(balancePending.filter(row => row.direction === 'outflow').map(row => row.cents));
  const pendingInflow = total(balancePending.filter(row => row.direction === 'inflow').map(row => row.cents));
  const pendingLine = 'Pending after the dated snapshots below (not yet included): outflows ' + formatMinor(pendingOutflow) +
    '; inflows ' + formatMinor(pendingInflow) + '. These amounts are not added to or subtracted from the recorded balances.';
  // The frozen receipt envelopes contain no matching outgoing leg. Review the
  // additive zero-pair breakdown against that independent fact, while keeping
  // the unchanged pinned renderer scoreable by the very same scorer.
  // Historical and current receipts have the same frozen no-owned-movement
  // envelope; only their exact reviewed explanations are accepted.
  const currentOutsideBasis = 'recorded gross inflow minus matched own transfers; includes any possible own transfer listed below';
  const outsideBasis = answer.includes('(' + currentOutsideBasis + ').') ? currentOutsideBasis : answer.includes('(ordinary receipts excluding identified owned movements).')
    ? 'ordinary receipts excluding identified owned movements'
    : 'recorded inflow minus matched transfers; unmatched credits may include unproved own-account moves';
  const breakdownLines = gold.contract === 'receipts' ? [
    'Matched transfers between your own accounts: $0.00 across 0 pairs.',
    `Inflow from outside your covered accounts: ${formatMinor(gold.combined)} (${outsideBasis}).`,
    'Transfers are counted by the inflow posting date; counterpart outflows may fall up to 3 days before or after it.',
  ] : [];
  const hasInflowBreakdown = gold.contract === 'receipts' && (ledger?.matched_own_transfers !== undefined ||
    ledger?.outside_inflow_minor !== undefined || /^(?:Matched transfers between|Inflow from outside|Transfers are counted)/m.test(answer));
  const check = (id, ok, failure = 'missing_fact') => {
    // Structured and visible witnesses bind the same frozen obligation. A
    // later display failure cannot coexist with an earlier successful fact.
    const previous = result.checks.find(c => c.id === id);
    if (previous) {
      previous.ok = previous.ok && Boolean(ok);
      if (!ok) previous.failure = failure;
    } else result.checks.push({ id, ok: Boolean(ok), failure: ok ? null : failure });
    if (!ok) result.reasons.push(id);
    if (!ok && ['wrong_figure', 'unsupported_claim', 'scope', 'ownership'].includes(failure)) result.safety_failures.push(`${failure}:${id}`);
  };
  const finish = () => {
    result.required_facts_total = gold.required_obligations.length;
    result.required_facts_met = gold.required_obligations.filter(id => result.checks.some(c => c.id === id && c.ok)).length;
    result.utility = result.required_facts_met / result.required_facts_total;
    return result;
  };
  const figure = (id, actual, expected) => {
    result.figure_checks++;
    result.figure_results.push({ id, actual: String(actual), expected: String(expected), ok: String(actual) === String(expected) });
    check(id, String(actual) === String(expected), 'wrong_figure');
  };
  if (!observation.trace?.parsed_intents?.length || observation.trace.fixture_accounts < 1) {
    result.execution_status = 'invalid_witness'; return result;
  }
  // Review the added disclosure against independent synthetic rows before
  // projecting it onto the frozen renderer contract. Historical arms keep
  // their original citation cap and wording; new figures never bypass scoring.
  const supplemental = new Set(), pendingRefs = new Set();
  const newPayments = ledger?.payment_exclusions;
  const hasItems = Boolean(newPayments && ['expense', 'repayment', 'ranking'].includes(gold.contract));
  const dateCopy = value => {
    const day = new Date(`${value}T00:00:00Z`);
    const text = day.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
    const year = day.getUTCFullYear();
    return year === new Date(input.clock.now_utc).getUTCFullYear() ? text : `${text}, ${year}`;
  };
  const allCitations = body.citations || [];
  if (newPayments) {
    const expectedIds = gold.repayment_ids || gold.payment_exclusion_ids || gold.excluded_from_account_totals || [];
    const postings = newPayments.rows || [];
    const expectedRows = expectedIds.map(id => rows.get(id));
    check('itemized-payment-membership', same(postings.map(row => rowId(allCitations.find(ref => ref.n === row.n))), expectedIds), 'ownership');
    const expectedMinor = total(expectedRows.map(row => row.cents));
    check('itemized-payment-total', String(newPayments.total_minor) === expectedMinor && newPayments.count === expectedIds.length &&
      String(newPayments.card_minor) === '0' && String(newPayments.loan_minor) === expectedMinor, 'wrong_figure');
    const refs = postings.map(row => `[${row.n}]`).join(' ');
    const header = `Payments to loans and cards (excluded from spending and income): ${formatMinor(expectedMinor)} across ${expectedIds.length} ${expectedIds.length === 1 ? 'payment' : 'payments'} ${refs}.`;
    check('itemized-payment-header', rawAnswer.split('\n').filter(line => line === header).length === 1, 'ownership');
    for (const posting of postings) {
      const ref = allCitations.find(ref => ref.n === posting.n), row = rows.get(rowId(ref));
      const account = snapshot.accounts.find(account => account.slug === row?.account);
      const ownMask = row?.description.match(/\b(?:account |acct no\. xxxx)(\d{4})$/i)?.[1];
      check(`itemized-payment-row:${posting.n}`, Boolean(row) && expectedIds.includes(row.id) &&
        posting.amount_minor === Number(row.cents) && posting.posted_on === row.date && posting.account_mask === account?.mask &&
        posting.payment_kind === 'loan' && posting.own_loan_mask === ownMask, 'ownership');
      const label = ownMask ? `payment to your own loan (ending ${ownMask})` : 'payment to a loan';
      const line = `${label}: ${formatMinor(row?.cents || '0')} on ${dateCopy(row?.date)} in your account ending ${account?.mask} [${posting.n}].`;
      check(`itemized-payment-display:${posting.n}`, rawAnswer.split('\n').filter(text => text === line).length === 1, 'wrong_figure');
      rawAnswer = rawAnswer.split('\n').filter(text => text !== line).join('\n');
      if (hasItems) supplemental.add(posting.n);
    }
    if (hasItems) {
      rawAnswer = rawAnswer.replace(/^Payments to loans and cards \(excluded from spending and income\): (\$[\d,]+\.\d{2}) across (\d+) payments? (?:\[\d+\] ?)+\.$/gm,
        (_, amount, count) => `Payments to your own loan/card accounts: ${amount} across ${count} ${count === '1' ? 'payment' : 'payments'}.`);
      delete ledger.payment_exclusions;
    }
  }
  if (gold.possible_payment_ids || ledger?.possible_payments) {
    // These independent fixtures contain one unpaired endpoint. Validate its
    // full cited disclosure before projecting onto the historical renderer.
    const expectedIds = gold.possible_payment_ids || [];
    const postings = ledger?.possible_payments || [];
    check('possible-payment-membership', same(postings.map(row => rowId(allCitations.find(ref => ref.n === row.n))), expectedIds), 'ownership');
    const expectedMinor = total(expectedIds.map(id => rows.get(id).cents));
    check('possible-payment-included-total', String(ledger?.possible_payments_included_minor) === expectedMinor, 'wrong_figure');
    for (const posting of postings) {
      const row = rows.get(rowId(allCitations.find(ref => ref.n === posting.n)));
      const account = snapshot.accounts.find(account => account.slug === row?.account);
      const label = 'included in money out above, possibly a transfer to your own account (counterpart not proved)';
      check(`possible-payment-row:${posting.n}`, Boolean(row) && expectedIds.includes(row.id) &&
        posting.amount_minor === Number(row.cents) && posting.posted_on === row.date && posting.account_mask === account?.mask &&
        posting.bank_text === row.description && posting.payment_kind === 'own_account' && posting.basis === 'description' &&
        posting.destination === 'account' && posting.included_in_total === true && posting.label === label, 'ownership');
      const line = `${label}: ${formatMinor(row?.cents || '0')} on ${dateCopy(row?.date)}, bank text quoted: "${row?.description}" [${posting.n}].`;
      check(`possible-payment-disclosed:${row?.id}`, rawAnswer.split('\n').filter(text => text === line).length === 1, 'ownership');
      rawAnswer = rawAnswer.split('\n').filter(text => text !== line).join('\n');
    }
    delete ledger.possible_payments;
    delete ledger.possible_payments_included_minor;
  }
  if (ledger?.pending_excluded) {
    const covered = snapshot.accounts.filter(a => a.coverage === 'complete' && a.from <= input.period.from && a.to >= input.period.to);
    const expected = [...rows.values()].filter(row => row.pending && row.date >= input.period.from && row.date <= input.period.to && covered.some(a => a.slug === row.account));
    const pending = ledger.pending_excluded, ids = pending.citations.map(n => rowId(allCitations.find(ref => ref.n === n)));
    check('pending-disclosure-membership', same(ids, expected.map(row => row.id)), 'ownership');
    const cents = total(expected.map(row => row.cents));
    check('pending-disclosure-amount', pending.count === expected.length && String(pending.total_minor) === cents, 'wrong_figure');
    const line = `Pending activity: ${formatMinor(cents)} across ${expected.length} ${expected.length === 1 ? 'row' : 'rows'}, excluded from completed spending ${pending.citations.map(n => `[${n}]`).join(' ')}.`;
    check('pending-disclosure-display', rawAnswer.split('\n').filter(text => text === line).length === 1, 'wrong_figure');
    rawAnswer = rawAnswer.split('\n').filter(text => text !== line).join('\n');
    for (const n of pending.citations) { supplemental.add(n); pendingRefs.add(n); }
    delete ledger.pending_excluded;
  }
  if (rawAnswer.includes('Accounts covered:')) {
    const covered = snapshot.accounts.filter(a => a.coverage === 'complete' && a.from <= input.period.from && a.to >= input.period.to)
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const line = `Accounts covered: ${covered.map(a => { const label = snapshot.reset_import?.account === a.slug ? `account ending ${a.mask}` : a.label; return label ? `${label} (your account ending ${a.mask})` : `your account ending ${a.mask}`; }).join('; ')}.`;
    check('covered-account-names', rawAnswer.split('\n').filter(text => text === line).length === 1, 'scope');
    rawAnswer = rawAnswer.split('\n').filter(text => text !== line).join('\n');
  }
  answer = reviewedMoneyCopy(rawAnswer);
  const shown = displayFigures(answer);
  const citations = allCitations.filter(ref => !supplemental.has(ref.n));
  const unresolvedRefs = [...(body.answer || '').matchAll(/\[(\d+)\]/g)].filter(m => !allCitations.some(c => c.n === Number(m[1])));
  if (unresolvedRefs.length) check('all-displayed-references-resolve', false, 'missing_source');
  check('no-invented-pending-zero', !/\b(?:no|zero) pending|pending (?:charges|activity)(?: are| is|:)? (?:zero|0|none)/i.test(answer), 'unsupported_claim');
  check('no-invented-payment-split', !/\bprincipal\b|interest (?:portion|amount|split)/i.test(answer), 'unsupported_claim');
  for (const citation of allCitations) {
    result.source_checks++;
    const account = snapshot.accounts.find(a => a.mask === citation.account_mask);
    const row = rows.get(rowId(citation));
    const balance = String(citation.ref || '').startsWith('ledger:balance:');
    check(`citation:${citation.n}`, Boolean(account) && (balance
      ? citation.posted_on === account.observed && String(citation.amount_minor) === account.balance
      : Boolean(row) && (!row.pending || pendingRefs.has(citation.n)) && row.date === citation.posted_on && row.account === account.slug &&
        String(citation.amount_minor) === row.cents), 'missing_source');
    const amounts = displayFigures(citation.title);
    figure(`citation-display:${citation.n}`, amounts.length === 1 ? amounts[0].cents : null,
      balance ? account?.balance : row?.cents);
  }
  if (!ledger) {
    // The adapter records only a ledger attempt. Its empty document sentinel
    // cannot earn a tested document answer or a successful forecast refusal.
    check('ledger-attempt-returned-supported-facts', false);
    check('no-amount-without-ledger', shown.length === 0, 'wrong_figure');
    if (answer) check(`unexecuted-document-claim:${sha(answer)}`, false, 'unsupported_claim');
    const refusedCoverage = gold.contract === 'refuse-coverage' &&
      body.gaps?.some(g => g.reason === 'period_outside_coverage') &&
      observation.trace.dependencies.includes('inventory');
    if (refusedCoverage) {
      result.checks = result.checks.filter(c => c.id !== 'ledger-attempt-returned-supported-facts');
      result.reasons = [];
      check('coverage-refusal-reached', true);
      result.verdict = 'honest refusal';
    } else result.verdict = shown.length ? 'wrong figure' : 'over-refusal';
    return finish();
  }
  check('real-fact-read', observation.trace.dependencies.some(d => ['transactions', 'balances'].includes(d)));
  if (gold.contract === 'forecast') {
    // The future window requests a forecast, while the permitted partial
    // answer contains only dated current observations with no forecast range.
    check('current-observations-not-future-scope', ledger.kind === 'balance' && ledger.from == null && ledger.to == null, 'scope');
  } else if (input.period.from) check('period', ledger.from === input.period.from && ledger.to === input.period.to, 'scope');
  if (gold.classification_uncertain) check('unknown-classification-is-not-complete', ledger.complete !== true, 'ownership');

  const ids = list => (list || []).map(rowId);
  const primaryIds = gold.contract === 'ranking' ? ids(ledger.lead_rows)
    : gold.contract === 'transactions' || gold.contract === 'payment' || gold.contract === 'vendor' ? ids(citations) : null;
  const expense = gold.contract === 'expense' || gold.contract === 'repayment';
  const uncertainExpense = expense && gold.classification_uncertain && ledger.classification_complete === false &&
    ledger.complete === false && ledger.expense_total_minor === null && ledger.total_minor === null;
  const retainedIds = uncertainExpense ? [...new Set([...gold.included, ...gold.repayment_ids])] : gold.included || [];
  const retainedTotal = total(retainedIds.map(id => rows.get(id).cents));
  const current = body?.answer || '';
  if (current.includes('This reading covers completed transactions only;') || current.includes('Here are your recorded balances, with the date for each account;')) {
    const offers = current.match(/Want[^?\n]*\?/g) || [];
    check('one-final-reviewed-offer', offers.length === 1 &&
      ['Want me to show your account balances?', 'Want help refreshing the bank connection for a newer balance?'].includes(offers[0]) &&
      current.endsWith(offers[0]), 'unsupported_claim');
  }
  if (expense) {
    if (uncertainExpense) {
      // Withholding a classification never earns its required expense or
      // repayment fact. The disclosed retained subtotal is checked separately.
      check('expense-total', false);
      check('whole-repayment', false);
    } else {
      figure('expense-total', ledger.expense_total_minor, gold.total);
      figure('whole-repayment', ledger.own_account_payments?.total_minor, gold.repayment);
    }
    check('expense-row-count', !uncertainExpense && ledger.row_count === gold.included.length,
      uncertainExpense ? 'missing_fact' : 'wrong_figure');
    const included = new Set(gold.included);
    check('expense-evidence-membership', !uncertainExpense && (!included.size || citations.length > 0) && citations.every(c => included.has(rowId(c))),
      uncertainExpense ? 'missing_fact' : citations.length ? 'ownership' : 'missing_source');
    if (gold.require_posted_disclosure) check('posted-record-limitation', /\bposted\b/i.test(answer) && /\bpending\b/i.test(answer));
    check('whole-payment-no-invented-split', !/\bprincipal\b|interest (?:portion|amount|split)/i.test(answer), 'unsupported_claim');
    check('visible-expense-period', answer.includes(`Period: ${input.period.from} through ${input.period.to}.`), 'scope');
  } else if (gold.contract === 'ranking') {
    check('eligible-ranking-before-limit', same(primaryIds, gold.ids), 'wrong_figure');
    check('ranked-cents', same((ledger.lead_rows || []).map(r => String(r.amount_minor)), gold.cents), 'wrong_figure');
    if (gold.gross_ids) check('original-gross-ranking', same(ids(ledger.rows), gold.gross_ids), 'wrong_figure');
  } else if (gold.contract === 'transactions') {
    check('transaction-order', same(primaryIds, gold.ids), 'wrong_figure');
    check('transaction-dates', same((ledger.rows || []).map(r => r.posted_on), gold.dates), 'wrong_figure');
    check('posted-list-complete', ledger.complete === true);
    check('transaction-heading-count', answer.startsWith(`Newest ${gold.ids.length} transactions:`), 'wrong_figure');
  } else if (gold.contract === 'balance' || gold.contract === 'forecast') {
    for (const balance of gold.balances) {
      const actual = ledger.accounts?.find(a => a.account_mask === balance.mask);
      figure(`balance:${balance.mask}`, actual?.current_minor, balance.cents);
      check(`balance-date:${balance.mask}`, actual?.as_of === gold.observed);
    }
    if (gold.require_roles) check('cash-and-liability-roles', /\bliabilit|\bdebt\b|\bloan\b/i.test(answer) && /\bcash\b|\basset\b/i.test(answer));
    if (gold.contract === 'forecast') check('withhold-future', /cannot|can.t|unavailable|unsupported/i.test(answer), 'unsupported_claim');
  } else if (gold.contract === 'receipts') {
    for (const [mask, cents] of Object.entries(gold.receipts)) {
      figure(`receipts:${mask}`, ledger.accounts?.find(a => a.account_mask === mask)?.credits_minor, cents);
    }
    if (gold.require_combined) check('combined-scoped-receipts', answer.includes(formatMinor(gold.combined)));
    check('uncertain-credit-not-income', !/\b(?:earned|revenue|profit)\b/i.test(answer), 'unsupported_claim');
    if (hasInflowBreakdown) {
      check('receipt-breakdown-structure', same(ledger.matched_own_transfers,
        { total_minor: 0, count: 0, window_days: 3, pairs: [] }) && ledger.matched_transfer_count === 0 &&
        ledger.income_established === false, 'ownership');
      check('receipt-breakdown-display', breakdownLines.every(line => answer.split('\n').filter(l => l === line).length === 1), 'wrong_figure');
    }
  } else if (gold.contract === 'payment') {
    check('exact-payment-row', same(primaryIds, gold.ids), citations.length ? 'wrong_figure' : 'missing_source');
    check('arrival-window', ledger.from === gold.from && ledger.to === gold.to, 'scope');
    check('positive-arrival', ledger.found === true);
  } else if (gold.contract === 'absence') {
    check('scoped-exact-absence', ledger.found === false && ledger.match_basis === 'none' && ledger.total_minor === null &&
      (/exact vendor spend in the covered window/.test(answer) || answer.split("\n").includes(PLAIN_ABSENCE) ||
        answer === 'No charges found for Absent Store from 2026-09-01 to 2026-09-30 on your account ending 3131, your account ending 4242, your account ending 5353.') && ledger.coverage?.complete === true);
    check('no-global-absence', !/never used|never paid|no spending anywhere/i.test(answer), 'unsupported_claim');
  } else if (gold.contract === 'vendor') {
    figure('outside-payment-retained', ledger.total_minor, gold.total);
    check('outside-payment-row', same(primaryIds, gold.ids), citations.length ? 'ownership' : 'missing_source');
    check('vendor-exact', ledger.match_basis === 'exact');
  } else if (gold.contract === 'gross') {
    figure('gross-outflow', total((ledger.accounts || []).map(a => String(a.debits_minor))), gold.debits);
    figure('gross-inflow', total((ledger.accounts || []).map(a => String(a.credits_minor))), gold.credits);
    if (gold.ordinary_totals) figure('ordinary-outflow', total((ledger.lead_accounts || []).map(a => String(a.debits_minor))), gold.ordinary_debits);
  } else if (gold.contract === 'coverage' || gold.contract === 'refuse-coverage') {
    check('coverage-cannot-be-complete', ledger.complete === false, 'unsupported_claim');
    check('coverage-does-not-certify-zero', shown.length === 0, 'wrong_figure');
    check('coverage-gap-disclosed', /partial|incomplete|unproven|not certified/i.test(answer));
  } else { result.execution_status = 'unbound_contract'; return result; }

  if (gold.contract === 'ranking') {
    // Presence is an obligation of the frozen key. Traversing only fields or
    // figures that happen to survive in output cannot detect a missing answer.
    const ordinaryDisplay = answer.split('\nWith everything counted:')[0];
    const displayed = [...ordinaryDisplay.matchAll(/^(-?\$[\d,]+\.\d{2}) on (\d{4}-\d{2}-\d{2}) in account \*{4}(\d{4}): .+ \[(\d+)\]$/gm)]
      .map(m => ({ id: rowId(citations.find(c => c.n === Number(m[4]))),
        cents: displayFigures(m[1])[0].cents, date: m[2], mask: m[3] }));
    const expected = gold.ids.map((id, i) => ({ id, cents: gold.cents[i], date: rows.get(id)?.date,
      mask: snapshot.accounts.find(a => a.slug === rows.get(id)?.account)?.mask }));
    check('displayed-ranking', same(displayed, expected));
    if (gold.repayment) {
      figure('whole-repayment', ledger.own_account_payments?.total_minor, gold.repayment);
      const repaymentLines = answer.split('\n').filter(line => line.startsWith('Payments to your own loan/card accounts:'));
      check('displayed-whole-repayment', repaymentLines.length === 1 &&
        same(displayFigures(repaymentLines[0]).map(a => a.cents), [gold.repayment]));
    }
  }

  // Check every monetary structured field, including conditionals and notes.
  // Expected side is independently evaluated from the declared gold membership.
  const windowRows = [...rows.values()].filter(r => !r.pending && r.date >= (input.period.from || '0000') && r.date <= input.period.to);
  const paymentIds = new Set(gold.payment_exclusion_ids || gold.excluded_from_account_totals || []);
  const paymentMinor = total(windowRows.filter(row => paymentIds.has(row.id)).map(row => row.cents));
  const paymentLine = `Payments to loans and cards (excluded from spending and income): ${formatMinor(paymentMinor)} across ${paymentIds.size} ${paymentIds.size === 1 ? 'payment' : 'payments'} `;
  if (gold.payment_exclusion_ids) {
    const excluded = ledger.payment_exclusions;
    check('payment-exclusions', same((excluded?.rows || []).map(row => rowId(citations.find(c => c.n === row.n))), gold.payment_exclusion_ids) &&
      excluded?.count === paymentIds.size && String(excluded?.total_minor) === paymentMinor, 'ownership');
    const expectedLine = paymentLine + gold.payment_exclusion_ids.map(id => `[${citations.find(c => rowId(c) === id)?.n}]`).join(' ') + '.';
    check('payment-exclusions-disclosed', answer.split('\n').filter(line => line === expectedLine).length === 1, 'ownership');
  }
  // Named conditionals follow the independently declared named membership.
  // A whole-account subtotal cannot pass as an alternative named figure.
  const namedConditionalRows = ['vendor', 'absence'].includes(gold.contract)
    ? windowRows.filter(row => (gold.ids || []).includes(row.id)) : windowRows;
  const accountSum = (mask, direction, ordinary = false, named = false) => total((named ? namedConditionalRows : windowRows).filter(r =>
    !paymentIds.has(r.id) && (!ordinary || !(gold.ordinary_excluded || gold.excluded || []).includes(r.id)) && r.account === snapshot.accounts.find(a => a.mask === mask)?.slug && r.direction === direction).map(r => r.cents));
  if (ledger) {
    // Counts and scope are facts too. Their expected side comes from frozen
    // membership and input coverage, never another output count or its prose.
    const selectedAccounts = snapshot.accounts.filter(a => gold.contract !== 'receipts' || a.mask in gold.receipts)
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const coveredAccounts = selectedAccounts.filter(a => a.coverage === 'complete' &&
      (!input.period.from || a.from <= input.period.from) && a.to >= input.period.to);
    const covered = coveredAccounts.length, selected = selectedAccounts.length;
    if (uncertainExpense && covered === selected) exactKnownLines.add(
      `Coverage: partial, ${covered} of ${selected} selected accounts cover ${input.period.from} through ${input.period.to}; excluded .`);
    const included = retainedIds.map(id => rows.get(id));
    const repaymentCount = uncertainExpense ? 0 : (gold.repayment_ids || []).length;
    const groups = new Map();
    for (const row of included) {
      const label = row.payee.toLowerCase();
      groups.set(label, (groups.get(label) || 0) + 1);
    }
    // Historical readers cap references at five. The current summary retains
    // every posting; derive that contract from actual references and verify its
    // entire independent membership before accepting the larger count.
    const fullEvidence = citations.length > 5 || /\nUnsorted: [^\n]+ \[\d+\]/.test(rawAnswer);
    const cited = fullEvidence ? included.length : Math.min(included.length, 5), omitted = included.length - cited;
    if (expense && fullEvidence) check('complete-group-evidence-membership',
      same(citations.map(rowId).sort((a, b) => a - b), included.map(row => row.id).sort((a, b) => a - b)), 'missing_source');
    const factual = (id, actual, expected) => check(id, expected !== undefined && same(actual, expected), 'unsupported_claim');
    const counters = (value, path = '') => {
      for (const [name, item] of Object.entries(value || {})) {
        const p = path ? `${path}.${name}` : name;
        if (name === 'count' || /_(?:count|pairs)$/.test(name)) {
          let expected;
          if (p === 'observation.pending.count' && balanceContract) expected = balancePending.length;
          else if (p === 'own_account_payments.count') expected = repaymentCount;
          else if (p === 'payment_exclusions.count') expected = paymentIds.size;
          else if (p === 'match_count' && gold.contract === 'payment') expected = gold.ids.length;
          // The frozen receipt inputs have no outgoing counterpart; the new
          // nested count must satisfy the same independent zero-pair fact.
          else if (p === 'matched_own_transfers.count' && gold.contract === 'receipts') expected = 0;
          else if (name === 'transaction_count') expected = (path.startsWith('if_own_transfers.accounts.') ? namedConditionalRows : windowRows).filter(r =>
            !paymentIds.has(r.id) && r.account === snapshot.accounts.find(a => a.mask === value.account_mask)?.slug &&
            (!((gold.ordinary_totals && path.startsWith('lead_accounts.')) || path.startsWith('if_own_transfers.')) || !(gold.ordinary_excluded || gold.excluded || []).includes(r.id))).length;
          else if (path.startsWith('groups.') && name === 'count') expected = groups.get(value.merchant);
          else if (path.startsWith('category_groups.') && name === 'count') expected = value.category === 'Unsorted' ? included.length : undefined;
          else if (p === 'unconfirmed_category_count' && expense) expected = included.length;
          else if (p === 'row_count') expected = expense ? included.length : (gold.ids || []).length;
          else if (p === 'cited_row_count') expected = cited;
          else if (p === 'omitted_row_count') expected = expense ? omitted : Math.max(0, (gold.ids || []).length - 5);
          else if (p === 'group_count') expected = groups.size;
          else if (p === 'omitted_group_count') expected = Math.max(0, groups.size - 10);
          else if (p === 'category_group_count') expected = included.length ? 1 : 0;
          else if (p === 'omitted_category_group_count') expected = 0;
          else if (p === 'coverage.candidate_account_count') expected = selected;
          else if (p === 'coverage.covered_account_count') expected = covered;
          else if (p === 'coverage.omitted_account_count') expected = selected - covered;
          else if (p === 'coverage.contributing_account_count') expected = new Set((gold.ids || []).map(id => rows.get(id)?.account)).size;
          else if (['matched_transfer_count', 'candidate_transfer_count', 'excluded_own_movement_count'].includes(p) ||
            /^default_exclusions\.(?:own_transfer_pairs|withdrawal_count|loan_proceeds_count)$/.test(p)) expected = 0;
          factual(`count:${p}`, item, expected);
        } else if (item && typeof item === 'object') counters(item, p);
      }
    };
    counters(ledger);
    if (ledger.accounts) {
      factual('scope:account-membership', ledger.accounts.map(a => a.account_mask).sort(), selectedAccounts.map(a => a.mask).sort());
      for (const account of ledger.accounts) {
        const source = selectedAccounts.find(a => a.mask === account.account_mask);
        if (Object.hasOwn(account, 'covered_to')) factual(`scope:covered-to:${account.account_mask}`, account.covered_to, source?.to);
        if (Object.hasOwn(account, 'last_synced_at')) factual(`scope:synced:${account.account_mask}`, account.last_synced_at, null);
      }
    }
    if (ledger.coverage && expense) {
      factual('scope:coverage-complete', ledger.coverage.complete, covered === selected);
      factual('scope:coverage-status', ledger.coverage.status, covered === selected ? 'full' : 'partial');
    }
    for (const line of answer.split('\n')) {
      let m;
      if ((m = /^Payments to your own loan\/card accounts: .+ across (\d+) payments?\.$/.exec(line)))
        factual('display-count:repayments', Number(m[1]), repaymentCount);
      else if ((m = /^(.+): -?\$[\d,]+\.\d{2} across (\d+) rows?/.exec(line)))
        factual(`display-count:group:${m[1]}`, Number(m[2]), m[1] === 'Unsorted' ? included.length : groups.get(m[1]));
      else if (line.startsWith('Evidence:')) factual('display-count:evidence', line,
        `Evidence: ${cited} of ${included.length} expense rows cited${omitted ? `, and ${omitted} more rows` : ''}.`);
      else if (line.startsWith('Coverage: full,')) factual('display-scope:coverage', line,
        `Coverage: full, all ${covered} selected accounts cover ${input.period.from} through ${input.period.to}.`);
      else if (line.startsWith('Bank history: all ')) factual('display-scope:coverage', line,
        `Bank history: all ${covered} selected accounts include ${input.period.from} through ${input.period.to}.`);
      else if (line.startsWith('Period:')) factual('display-scope:period', line,
        `Period: ${input.period.from} through ${input.period.to}.`);
      else if (line.startsWith('Accounts:')) factual('display-scope:accounts', line,
        `Accounts: ${selectedAccounts.map(a => `account ****${a.mask}`).join(', ')}; ` +
        (nearPayment ? '' : `${input.period.from} through ${input.period.to}; `) +
        `${selectedAccounts.map(a => `account ****${a.mask}: covered through ${a.to}`).join('; ')}.`);
      else if (line.startsWith('Coverage: requested')) factual('display-scope:vendor', line,
        `Coverage: requested ${input.period.from} through ${input.period.to}; ` +
        `${new Set((gold.ids || []).map(id => rows.get(id)?.account)).size} contributing, ${covered} fully covered, ` +
        `${selected - covered} omitted account${selected - covered === 1 ? '' : 's'}; ` +
        selectedAccounts.map(a => `account ****${a.mask} covered through ${a.to}`).join('; ') + '.');
    }
  }
  const fieldCheck = (value, path = '', parent = null) => {
    for (const [name, item] of Object.entries(value || {})) {
      const p = path ? `${path}.${name}` : name;
      if (/_minor$/.test(name) && item !== null && typeof item !== 'object') {
        let expected;
        if (p === 'amount_minor' && gold.contract === 'payment') {
          const requested = displayFigures(input.question);
          expected = requested.length === 1 ? requested[0].cents : undefined;
        } else if (name === 'amount_minor') expected = rows.get(rowId(value.ref ? value : citations.find(c => c.n === value.n)))?.cents;
        else if (p === 'observation.pending.outflow_minor' && balanceContract) expected = pendingOutflow;
        else if (p === 'observation.pending.inflow_minor' && balanceContract) expected = pendingInflow;
        else if (name === 'current_minor') expected = gold.balances?.find(b => b.mask === value.account_mask)?.cents;
        else if (name === 'credits_minor' || name === 'debits_minor') expected = accountSum(value.account_mask, name === 'credits_minor' ? 'inflow' : 'outflow', (gold.ordinary_totals && path.startsWith('lead_accounts.')) || path.startsWith('if_own_transfers.'), path.startsWith('if_own_transfers.accounts.'));
        else if (name === 'combined_inflow_minor' && gold.contract === 'receipts') expected = gold.combined;
        else if (p === 'outside_inflow_minor' && gold.contract === 'receipts') expected = gold.combined;
        else if (p === 'matched_own_transfers.total_minor' && gold.contract === 'receipts') expected = '0';
        else if (/^(?:default_exclusions\.|excluded_own_transfer_minor$|excluded_own_movement_minor$)/.test(p)) expected = '0';
        else if (p.startsWith('own_account_payments.')) expected = uncertainExpense || name === 'card_minor' ? '0' : gold.repayment;
        else if (p === 'unsorted_minor' && expense) expected = total(retainedIds.map(id => rows.get(id).cents));
        else if (p.startsWith('payment_exclusions.') && name !== 'amount_minor') expected = name === 'card_minor' ? '0' : paymentMinor;
        else if (p === 'retained_outflow_minor' && uncertainExpense) expected = retainedTotal;
        else if (/^(?:expense_total_minor|total_minor)$/.test(p)) expected = gold.total;
        else if (p.startsWith('groups.') && expense) {
          const ids = gold.included.filter(id => rows.get(id)?.payee?.toLowerCase() === value.merchant);
          expected = total(ids.map(id => rows.get(id).cents));
        } else if (p.startsWith('category_groups.') && expense) expected = gold.total;
        else if (name === 'total_minor' && gold.contract === 'ranking') expected = p.startsWith('if_own_transfers.')
          ? total((gold.gross_ids || gold.ids).filter(id => !(gold.excluded || []).includes(id)).map(id => rows.get(id).cents))
          : total(gold.gross_cents || gold.cents);
        else if (['vendor', 'absence'].includes(gold.contract) &&
          /(?:total_minor|unsorted_minor)$/.test(name)) expected = gold.total;
        figure(`field:${p}`, item, expected ?? 'UNSUPPORTED');
      } else if (item && typeof item === 'object') fieldCheck(item, p, value || parent);
    }
  };
  fieldCheck(ledger);

  if (gold.ordinary_totals) exactKnownLines.add('Note: only checking, savings and card accounts contribute to money in minus money out.');
  if (gold.payment_exclusion_ids)
    exactKnownLines.add('Note: payments to loans and cards stay outside spending and income.');
  const lines = answer.split('\n');
  // Required display facts come from the key, independently of traversal.
  // An empty answer, omitted account, or moved heading must not earn credit
  // merely because every surviving amount happens to be correct.
  const validateRequiredDisplay = () => {
    if (balanceContract && ledger.observation) {
    check('pending-disclosure', balancePending.length ? lines.includes(pendingLine)
      : lines.includes('No pending transactions are recorded after these snapshots.'));
    }
    check('visible-answer', Boolean(answer.trim()), 'wrong_figure');
    if (gold.contract === 'balance' || gold.contract === 'forecast') {
      let group = null;
      const groups = new Map();
      for (const line of lines) {
        if (line === 'Cash accounts (recorded balances):') group = 'cash';
        if (line === 'Liabilities (separate from cash):') group = 'liability';
        if (line === 'Other or unknown account types (excluded from cash):') group = 'other';
        if (displayFigures(line).length) groups.set(line, group);
      }
      for (const balance of gold.balances) {
        const displayed = lines.filter(line => line.includes(`account ****${balance.mask}`) && displayFigures(line).length);
        const present = displayed.length === 1 &&
          same(displayFigures(displayed[0]).map(f => f.cents), [balance.cents]) &&
          displayed[0].includes(`as of ${gold.observed};`);
        check(`required-display-balance:${balance.mask}`, present, 'wrong_figure');
        check(`balance:${balance.mask}`, present, 'wrong_figure');
        const expectedGroup = ['checking', 'savings'].includes(balance.kind) && balance.role === 'asset'
          ? 'cash' : ['card', 'loan', 'line_of_credit'].includes(balance.kind) && balance.role === 'liability' ? 'liability' : 'other';
        const actual = ledger.accounts?.find(a => a.account_mask === balance.mask);
        if (gold.require_roles || actual?.balance_group !== undefined) {
          const correctGroup = actual?.balance_group === expectedGroup && displayed.length === 1 && groups.get(displayed[0]) === expectedGroup;
          check(`required-balance-group:${balance.mask}`, correctGroup, 'ownership');
          if (gold.require_roles) check('cash-and-liability-roles', correctGroup, 'ownership');
        }
      }
    }
    if (gold.contract === 'receipts' || gold.contract === 'gross') {
      const masks = gold.receipts ? Object.keys(gold.receipts) : snapshot.accounts.map(a => a.mask);
      check('display-account-membership', same((ledger.accounts || []).map(a => a.account_mask).sort(), [...masks].sort()), 'scope');
      for (const mask of masks) {
        const displayed = lines.filter(line => line.startsWith(`account ****${mask},`) && (!gold.ordinary_totals || !line.includes(': money in ')));
        if (gold.ordinary_totals && gold.ordinary_display !== false) {
          const ordinary = lines.filter(line => line.startsWith(`account ****${mask},`) && line.includes(': money in '));
          check(`required-ordinary-display:${mask}`, ordinary.length === 1 &&
            same(displayFigures(ordinary[0]).map(f => f.cents), [accountSum(mask, 'inflow', true), accountSum(mask, 'outflow', true)]) &&
            ordinary[0].includes(`${input.period.from} through ${input.period.to}`), 'wrong_figure');
        }
        const present = displayed.length === 1 &&
          same(displayFigures(displayed[0]).map(f => f.cents), [accountSum(mask, 'inflow'), accountSum(mask, 'outflow')]) &&
          displayed[0].includes(`${input.period.from} through ${input.period.to}`);
        check(`required-display-account:${mask}`, present, 'wrong_figure');
        if (gold.contract === 'receipts') check(`receipts:${mask}`, present, 'wrong_figure');
      }
      if (gold.require_combined) {
        const correctCount = lines.includes(`Combined recorded inflow: ${formatMinor(gold.combined)} across ${masks.length} selected covered accounts, ${input.period.from} through ${input.period.to}; not established income.`);
        check('combined-account-count', correctCount, 'scope');
        check('combined-scoped-receipts', correctCount, 'scope');
      }
    }
    if (gold.contract === 'ranking' || gold.contract === 'transactions' || gold.contract === 'payment') {
      const section = gold.contract === 'ranking' ? answer.split('\nWith everything counted:')[0].split('\n') : lines;
      for (const id of gold.ids) {
        const row = rows.get(id), cite = citations.find(c => rowId(c) === id) || ledger.lead_rows?.find(c => rowId(c) === id);
        const expected = gold.contract === 'transactions' && row.direction === 'outflow' ? `-${row.cents}` : row.cents;
        const present = Boolean(cite) && section.some(line =>
          line.includes(`[${cite.n}]`) && line.includes(row.date) && same(displayFigures(line).map(f => f.cents), [expected]));
        check(`required-display-row:${id}`, present, 'wrong_figure');
        check(gold.contract === 'ranking' ? 'eligible-ranking-before-limit'
          : gold.contract === 'transactions' ? 'transaction-order' : 'positive-arrival', present, 'wrong_figure');
      }
    }
    if (expense && !uncertainExpense) check('required-display-expense-total', lines.some(line =>
      (/^(?:You spent|Recorded outflow subtotal|Covered-account expense subtotal):? /.test(line) || (PLAIN_LINES.has(line) && line.startsWith("Money out I could check: "))) &&
      same(displayFigures(line).map(f => f.cents), [gold.total])), 'wrong_figure');
  };
  validateRequiredDisplay();
  const exactMoneyLines = new Set();
  if (balanceContract && ledger.observation) {
    check('pending-treatment', ledger.observation.pending?.treatment === 'not_included');

    if (balancePending.length) exactMoneyLines.add(pendingLine);
    exactKnownLines.add(snapshot.accounts.every(account => account.coverage === 'complete')
      ? 'The saved account history is complete.' : 'The saved account history is partial; a complete current total is unconfirmed.');
    if (!balancePending.length) exactKnownLines.add('No pending transactions are recorded after these snapshots.');
  }
  // These frozen snapshots have no category labels; the independent retained
  // expense membership proves both the excluded amount and its row count.
  if (expense && retainedIds.length) exactMoneyLines.add('Unconfirmed categories: ' + retainedIds.length +
    ' rows totaling ' + formatMinor(total(retainedIds.map(id => rows.get(id).cents))) + '; left out of confirmed category totals.');
  if (gold.contract === 'vendor' && input.period.rule === 'trailing calendar months with month-end clamping' && gold.ids.length) {
    const payee = rows.get(gold.ids[0])?.payee;
    if (payee && gold.ids.every(id => rows.get(id)?.payee === payee)) exactMoneyLines.add(
      `You spent ${formatMinor(gold.total)} at ${payee} from ${input.period.from} through ${input.period.to}. ` +
      gold.ids.slice(0, 5).map((_, i) => `[${i + 1}]`).join(' ') + '.');
  }
  let seenDisplay = 0;
  let grossRanking = false;
  for (const line of lines) {
    if (line === 'With everything counted:') grossRanking = true;
    const amounts = displayFigures(line);
    if (!amounts.length) continue;
    seenDisplay += amounts.length;
    for (const match of line.matchAll(/account \*{4}(\d{4})/g)) {
      const permitted = gold.contract === 'receipts' ? Object.keys(gold.receipts) : snapshot.accounts.map(a => a.mask);
      check(`display-account-scope:${seenDisplay}:${match[1]}`, permitted.includes(match[1]), 'scope');
    }
    const d = '-?\\$[\\d,]+\\.\\d{2}', day = '\\d{4}-\\d{2}-\\d{2}', ref = '\\[\\d+\\]';
    const ordinaryAccountLine = gold.ordinary_totals && /^account \*{4}\d{4}, \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}: money in -?\$[\d,]+\.\d{2}; money out -?\$[\d,]+\.\d{2}\.$/.test(line);
    const allowedMoneyLine = ordinaryAccountLine || exactMoneyLines.has(line) || PLAIN_LINES.has(line) || [
      `^Recorded outgoing subtotal: ${d}\\.$`,
      `^You spent ${d} (?:this month|last month|today|yesterday|this week|${day} through ${day})\\.$`,
      `^Recorded outflow subtotal: ${d} (?:this month|last month|today|yesterday|this week|${day} through ${day}); account classification is unconfirmed, so expense interpretation is incomplete\\.$`,
      `^You spent ${d} at [A-Za-z ]+ (?:this month|in [A-Za-z]+ \\d{4})\\. ${ref}(?: ${ref})*\\.$`,
      `^[a-zA-Z ]+: ${d} across \\d+ rows?(?: ${ref})*\\.$`,
      `^Payments to your own loan/card accounts: ${d} across \\d+ payments?\\.$`,
      `^Payments to loans and cards \\(excluded from spending and income\\): ${d} across \\d+ payments? ${ref}(?: ${ref})*\\.$`,
      `^[A-Za-z ]+ \\(account \\*{4}\\d{4}\\): ${d} as of ${day}; feed synced (?:${day}|unavailable) ${ref}\\.$`,
      `^${day}: [A-Za-z ]+, ${d}, [A-Za-z ]+ \\(account \\*{4}\\d{4}\\) ${ref}\\.$`,
      `^${d} on ${day} in account \\*{4}\\d{4}: [A-Za-z0-9 .]+ ${ref}$`,
      `^Found a deposit of ${d} posted ${day} in account \\*{4}\\d{4}: [A-Za-z ]+ ${ref}\\.$`,
      `^account \\*{4}\\d{4}, ${day} through ${day}: credits ${d}; debits ${d} (?:${ref}(?: ${ref})*|\\(no posted income or expenses in the covered period\\))\\.$`,
      `^Combined recorded inflow: ${d} across \\d+ selected covered accounts, ${day} through ${day}; not established income\\.$`,
    ].some(pattern => new RegExp(pattern).test(line)) || breakdownLines.includes(line);
    if (!allowedMoneyLine) check(`unreviewed-money-prose:${sha(line)}`, false, 'unsupported_claim');
    let expected = null;
    if (gold.payment_exclusion_ids && line.startsWith(paymentLine)) expected = [paymentMinor];
    else if (expense) {
      if (line.startsWith('Unconfirmed categories:')) expected = [total(retainedIds.map(id => rows.get(id).cents))];
      else if (/^Recorded outgoing subtotal:/.test(line) && uncertainExpense) expected = [retainedTotal];
      else if (/^(?:You spent|Recorded outflow subtotal|Covered-account expense subtotal|Unsorted:)/.test(line) || (PLAIN_LINES.has(line) && line.startsWith("Money out I could check: "))) expected = [gold.total];
      else if (/^Payments to your own loan\/card accounts:/.test(line)) expected = [gold.repayment];
      else {
        const merchant = line.split(':')[0];
        const groupIds = gold.included.filter(id => rows.get(id)?.payee?.toLowerCase() === merchant);
        if (groupIds.length) expected = [total(groupIds.map(id => rows.get(id).cents))];
      }
    } else if (balanceContract && line === pendingLine) {
      expected = [pendingOutflow, pendingInflow];
    } else if (gold.contract === 'balance' || gold.contract === 'forecast') {
      const mask = /\*{4}(\d{4})/.exec(line)?.[1];
      const balance = gold.balances.find(b => b.mask === mask);
      if (balance) expected = [balance.cents];
      check(`display-balance-date:${mask}`, line.includes(`as of ${gold.observed};`), 'scope');
      check(`display-balance-sync:${mask}`, /; feed synced unavailable /.test(line), 'scope');
    } else if (gold.contract === 'ranking' && /^Payments to your own loan\/card accounts:/.test(line)) {
      expected = [gold.repayment];
    } else if (gold.contract === 'ranking' || gold.contract === 'transactions' || gold.contract === 'payment') {
      const ref = /\[(\d+)\]/.exec(line)?.[1];
      const cite = citations.find(c => c.n === Number(ref)) || ledger.lead_rows?.find(c => c.n === Number(ref)) ||
        (gold.contract === 'transactions' && ref ? { ref: `ledger:transaction:${gold.ids[Number(ref) - 1]}` } : null);
      const id = rowId(cite), allowed = (grossRanking && gold.contract === 'ranking' ? gold.gross_ids || gold.ids : gold.ids).includes(id), row = rows.get(id);
      if (allowed && row) expected = [gold.contract === 'transactions' && row.direction === 'outflow' ? `-${row.cents}` : row.cents];
      check(`display-row-date:${seenDisplay}`, Boolean(row) && line.includes(row.date), 'scope');
    } else if (gold.contract === 'vendor') expected = [gold.total];
    else if (gold.contract === 'receipts' || gold.contract === 'gross') {
      const mask = /\*{4}(\d{4})/.exec(line)?.[1];
      if (gold.contract === 'receipts' && line.startsWith('Combined recorded inflow:')) expected = [gold.combined];
      if (line === breakdownLines[0]) expected = ['0'];
      if (line === breakdownLines[1]) expected = [gold.combined];
      if (mask && /credits|money in/.test(line)) expected = [accountSum(mask, 'inflow', ordinaryAccountLine), accountSum(mask, 'outflow', ordinaryAccountLine)];
      check(`display-period:${seenDisplay}`, breakdownLines.includes(line) || line.includes(`${input.period.from} through ${input.period.to}`), 'scope');
    }
    figure(`display:${seenDisplay}`, JSON.stringify(amounts.map(a => a.cents)), JSON.stringify(expected));
  }
  // This slice has a deterministic renderer, not a model-prose adjudicator.
  // Unrecognized factual prose is held for review, never silently approved.
  for (const line of lines.filter(line => line && !displayFigures(line).length)) {
    if (exactKnownLines.has(line)) continue;
    if (line === breakdownLines[2]) continue;
    if (PLAIN_LINES.has(line)) continue;
    if (['Figures use recorded posted rows. Pending activity is not assessed here.',
      'Recorded observations, not live or available cash.',
      'Cash accounts (recorded balances):', 'Liabilities (separate from cash):',
      'Other or unknown account types (excluded from cash):',
      "I can't forecast next month's bank balance. Here is the current recorded snapshot instead.",
      'Source and own-account transfer status are not established by a payer label; uncertain credits remain included.',
      'Note: payments to your own loan/card accounts are shown separately from expenses.',
      'With everything counted:'].includes(line)) continue;
    if (uncertainExpense && line === 'Expense classification is uncertain; this subtotal may include payments between your own accounts.') continue;
    if (uncertainExpense && line === 'Account classification is unconfirmed; expense interpretation is incomplete.') continue;
    if (gold.contract === 'payment' && line === `Lookup window: ${gold.from} through ${gold.to}, inclusive (plus or minus 7 days around 2026-10-12).`) continue;
    const known = /^(?:Your latest synced balances are below\.|Merchant groups:|Category groups:|Period: \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}\.|Evidence: \d+ of \d+ expense rows cited(?:, and \d+ more rows)?\.|Coverage: full, all \d+ selected accounts cover \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}\.|Newest \d+ transactions?:|Possible transfers are included in income and spend; no rows were removed as transfers\.|Accounts: account \*{4}\d{4}.*\.|Coverage: requested \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2};.*\.|Partial: No transactions were found for .+ as exact vendor spend in the covered window, \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}\. .+)$/;
    if (!known.test(line)) check(`unreviewed-prose:${sha(line)}`, false, 'unsupported_claim');
  }
  check('display-extraction-complete', seenDisplay === shown.length);
  if (shown.length && !citations.length && gold.total !== '0') check('figures-have-sources', false, 'missing_source');
  const wrong = result.safety_failures.some(f => /wrong_figure|ownership|scope/.test(f));
  const missingSource = result.checks.some(c => c.failure === 'missing_source');
  result.verdict = wrong ? 'wrong figure' : missingSource ? 'missing source'
    : result.checks.every(c => c.ok) ? 'correct' : 'partly';
  if (gold.contract === 'forecast' && result.verdict === 'correct') result.verdict = 'partly';
  return finish();
}

export function scoreRun(run, inputs) {
  if (run?.mode !== 'real-ledger-synthetic-sqlite' || run.provider_calls !== 0 || run.production_writes !== 0 ||
    !run.node_version || !run.source_files || !Object.keys(run.source_files).length ||
    ['source_digest', 'migration_digest', 'harness_digest', 'input_set_digest', 'observation_digest']
      .some(key => !/^[a-f0-9]{64}$/.test(run[key] || ''))) throw Error('INVALID_RUN_IDENTITY');
  if (!run || run.observation_digest !== sha(run.observations) || run.observations.length !== inputs.length ||
    new Set(run.observations.map(o => o.id)).size !== inputs.length ||
    !same(run.observations.map(o => o.id), inputs.map(c => c.id))) throw Error('RUN_SET_MISMATCH');
  if (run.scoring_identity && run.scoring_identity !== SCORING_IDENTITY) throw Error('SCORING_IDENTITY_MISMATCH');
  const replayInputs = inputs.map(c => ({ ...c, snapshot: c.snapshot || evidence(c.profile, c.account_reviews) }));
  if (run.input_set_digest !== sha(replayInputs) ||
    run.observations.some((o, i) => o.input_digest !== sha(replayInputs[i]))) throw Error('INPUT_IDENTITY_MISMATCH');
  const scores = inputs.map((c, i) => scoreObservation(run.observations[i], c));
  const counts = Object.fromEntries(VERDICTS.map(v => [v, scores.filter(s => s.verdict === v).length]));
  return { schema: 1, bank_version: run.bank_version, gold_version: GOLD_VERSION, oracle_version: ORACLE_VERSION,
    planned: inputs.length, attempted: scores.length, complete: scores.filter(s => s.execution_status === 'complete').length,
    invalid: scores.filter(s => s.execution_status !== 'complete').length, counts, scores,
    adjudicated: scores.filter(s => s.verdict !== null).length,
    required_facts_met: scores.reduce((n, s) => n + s.required_facts_met, 0),
    required_facts_total: scores.reduce((n, s) => n + s.required_facts_total, 0) };
}
