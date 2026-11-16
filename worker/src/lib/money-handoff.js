import { unknownMoneyConfidence, confidenceText } from './money-confidence.js';
// This is a tool-routing boundary, not a question reader. Do not resolve bank periods,
// inspect accounts, or ask a model before handing money work to the assistant.
import { taxQuestionScopeAssessment } from './tax-evidence-scope.js';
import { MONEY_CAPABILITY_TRANSITION, MONEY_ANSWER_DETAILS } from './money-query-contract.js';

const MONEY_SUBJECT = /\b(?:money|cash(?:[ -]flow)?|balances|spend|spent|spending|expenses?|income|revenue|profits?|losses|earn(?:ed|ings)?|payments?|pay|paying|paid|subscriptions?|owe|owed|owing|debts?|loans?|mortgages?|deposits?|withdrawals?|transfers|transactions?|charges|charged|refunds?|payouts?|payroll|budgets?|checking|savings|inflows?|outflows?|receivables?|payables?|bills?|rent|salary|wages?|fees?|interest|credits?|debits?|tax(?:es)?|net worth|bank accounts?|came in|went out)\b|\b(?:my|our|current|available|account|card|bank|loan) balance\b/i;
// Owners can ask for account amounts without using the word balance. Preserve
// their account qualifiers for the assistant rather than parsing them here.
const ACCOUNT_AMOUNT = /\b(?:what(?:'s| is)|what do (?:i|we) have)\s+in\s+(?:each|every|my|our|the)\b[^?!.]*\baccounts?\b|\b(?:what(?:'s| is)|show(?: me)?)\s+(?:(?:my|our|the)\s+)?balance\s+(?:in|of|for)\b/i;
const CURRENCY_AMOUNT = /[$€£]\s*\d|\b\d+(?:\.\d+)?\s*(?:dollars?|euros?|pounds?|USD|EUR|GBP)\b/i;
const DOCUMENT_SUBJECT = /\b(?:leases?|polic(?:y|ies)|quotes?|texts?|calls?|said|told|notice|documents?|agreements?|contracts?|statements?|ledgers?|memos?|emails?|messages?|meetings?|notes?|handbooks?|reports?|invoices?|receipts?)\b/i;
const DOCUMENT_TASK = /^(?:summari[sz]e|find|locate|search|read|quote|translate|rewrite|rephrase|proofread|show|list|where\b)/i;
const DOCUMENT_SAYS = /\b(?:say|says|said|state|states|stated|mention|mentions|contain|contains|require|requires|report|reported)\b/i;
const REQUEST_PREFIX = /^(?:please\s+)?(?:(?:can|could|would|will) you\s+|i(?:'d| would) like (?:you )?to\s+)?(?:please\s+)?/i;
const EXPLANATION = /^(?:define\b|what does\b.+\bmean\b|what (?:is|are)\b.+\b(?:polic(?:y|ies)|rules?|procedures?|process|meaning|definition)\b|explain\b.+\b(?:polic(?:y|ies)|rules?|procedures?|meaning|definition)\b)/i;
const MONEY_TERM = /^(?:what is|explain|define) (?:a |an |the )?(?:cash[ -]flow|(?:current |available |account |card |bank |loan )?balance|income|revenue|profit|payment|deposit)[?!.]*$/i;
const NON_MONEY_SAVINGS = /\bsavings? in (?:time|steps?|effort|energy|materials?|distance)\b/gi;
const TAX_DOCUMENT = /\b(?:forms?|returns?|filings?|schedules?|reported|report|according to|line\s+\d+|1040|1065|1120|1099|941|940)\b/i;

// ---- Payment-state grammar ----
const PAYABLE = '(?:invoices?|bills?|quotes?|quotations?|deposits?|charges?|premiums?|rent|fees?|payments?|balances?|installments?|instalments?|dues|checks?|cheques?|transfers?|amounts?|estimates?|retainers?|tuition|subscriptions?)';
const RECORD_NOUN = '(?:leases?|contracts?|agreements?|polic(?:y|ies)|invoices?|bills?|quotes?|quotations?|statements?|receipts?|handbooks?|memos?|emails?|letters?|notices?|documents?|records?|notes?|reports?|terms|schedules?|proposals?|estimates?|orders?|plans?|forms?|ledgers?|minutes)';
const RECORD_VERB = '(?:say|says|said|state|states|stated|list|lists|listed|show|shows|showed|specify|specifies|mention|mentions|mentioned|require|requires|required|set|sets|give|gives|provide|provides|allow|allows|define|defines|charge|charges|include|includes|call|calls|spell|spells|describe|describes|note|notes|cite|cites|quote|quotes)';
const RECORD_SUBJECT = `(?:(?:the|this|that|these|those|my|our|your|its|their|an?)\\s+)?(?:[\\w'-]+\\s+){0,3}?${RECORD_NOUN}`;
// The record is the subject of the main clause: "What rent does the lease
// state?", "How many paid holidays does the handbook give?". The first
// auxiliary must belong to that record clause, not an earlier bank question.
const RECORD_TERMS = new RegExp(`^(?:what|which|when|where|who|whom|whose|how(?:\\s+(?:much|many|long|often|soon))?)\\b(?:(?!(?:do|does|did|will|would|can|could|should|shall|must)\\b)[^?])*?\\b(?:do|does|did|will|would|can|could|should|shall|must)\\s+${RECORD_SUBJECT}\\s+${RECORD_VERB}\\b`, 'i');
const RECORD_TERMS_YES_NO = new RegExp(`^(?:do|does|did|will|would|can|could)\\s+${RECORD_SUBJECT}\\s+${RECORD_VERB}\\b`, 'i');
// Quoted topics belong to the record request, including their conjunctions
// and question marks. Consume word-internal apostrophes so a possessive cannot
// expose a quoted bank question as an independent request.
const QUOTED_RECORD_TOPIC = /"[^"]*"|“[^”]*”|(?<!\w)(?:'|‘)(?:[^']|(?<=\w)'(?=\w))*'(?!\w)/g;
// A separator starts an independent request only before a question or command
// head. A topic such as "rent and payments" remains inside its record clause.
const INDEPENDENT_REQUEST = /(?:[,;?!]\s*(?:(?:and|but|or)\s+)?|\s+(?:and|but|or)\s+)(?=(?:what|which|when|where|who|whom|whose|how|do|does|did|is|are|was|were|has|have|had|will|would|can|could|should|shall|must|show|list|calculate)\b)/i;
// Money context: a payable thing or an amount. Words such as settle, cover,
// clear, outstanding and due describe money only in this context ("Did we
// settle the dispute?" and "Is anything due on the project?" are not).
const PAYABLE_CONTEXT = new RegExp(`\\b${PAYABLE}\\b|[$€£]\\s*\\d|\\b(?:money|dollars?)\\b`, 'i');
// The owner as payer, in any tense and with adverbs between ("Have I paid",
// "Did I ever pay", "Do I still owe"). Plans and obligations ("Do I need to
// pay", "How much will I pay") are terms, not state.
const BETWEEN = String.raw`(?:(?!(?:need|needs|must|should|will|would|shall|could|might|may|going|supposed|required|expected|plan|want|wants)\b)[\w'-]+\s+){0,3}?`;
const OWNER_PAYS = new RegExp(String.raw`\b(?:I|we)\s+${BETWEEN}(?:pay|pays|paid|paying|owe|owed|owing)\b`, 'i');
const OWNER_SETTLES = new RegExp(String.raw`\b(?:I|we)\s+${BETWEEN}(?:settle|settled|settling|cover|covered|covering|clear|cleared|clearing)\b`, 'i');
const MODAL_OWNER = /\b(?:will|would|should|shall|must|could|might|can|may)\s+(?:I|we)\b|\b(?:I|we)\s+(?:need|needs|have|has|must|should|will|would|shall)\s+(?:to\s+)?(?:pay|owe|cover|settle)\b/i;
const OWNER_PAYMENT_EVENT = /\b(?:my|our)\s+(?:[\w'-]+\s+){0,2}?payments?\b[^?.!]*\b(?:go|goes|went|gone|clear|clears|cleared|post|posts|posted|bounce|bounced|arrive|arrived|process|processed|fail|failed)\b/i;
// "Is the roofer quote paid?", "Has the contractor been paid?", "What is
// owed on invoice 1042?". Terms under a record ("reimbursed under the
// policy") and paid-leave nouns are not payment state.
const PASSIVE_TERMS = String.raw`(?!\s+(?:under|per|according|holidays?|time|leave|vacations?|days?|sick|parental|family)\b)`;
const PASSIVE_MONEY = new RegExp(String.raw`\b(?:is|are|was|were|been|being|be|got|get|gets|has|have|had|still)\s+(?:[\w'-]+\s+){0,4}?(?:paid|refunded|reimbursed|owed|owing)\b${PASSIVE_TERMS}`, 'i');
const PASSIVE_SETTLED = new RegExp(String.raw`\b(?:is|are|was|were|been|being|be|got|get|gets|has|have|had|still)\s+(?:[\w'-]+\s+){0,4}?(?:settled|covered|cleared|closed out|posted)\b(?!\s+(?:by|under|in|per|according)\b)`, 'i');
const PAYABLE_STATE = new RegExp(`\\b${PAYABLE}\\b[^?.!]*\\b(?:clear|clears|cleared|go through|goes through|gone through|went through|covered|closed out|posted|bounced|settled|paid off|paid up)\\b(?!\\s+(?:by|under|in|per|according)\\b)`, 'i');
const UNPAID_STATE = /\b(?:unpaid|outstanding|overdue|past[ -]due|delinquent|in arrears)\b/i;
const DUE_STATE = /\b(?:still|anything|nothing|remaining|left|currently|now|already|past)\b(?:\s+[\w'-]+){0,2}\s+due\b|\bdue\s+(?:now|today|still)\b|\b(?:balance|amount)s?\s+(?:due|owed|owing|remaining|outstanding|left)\b/i;
// Another payer: "Did the client pay the invoice?", "Has the customer paid?".
const ACTIVE_PAYER = /\b(?:did|has|have|had)\s+(?:[\w'-]+\s+){1,3}?(?:pay|paid|settle|settled)\b(?!\s+(?:attention|tribute|respects?)\b)/i;
// A conditional clause after the main clause states terms ("What is the late
// fee if rent is paid after the 5th?", "What happens if I pay late?").
const CONDITIONAL = /(\S)\s+\b(?:if|when|whenever|once|unless|until|in case)\b[^,;?]*/gi;
function paymentStateQuestion(question) {
  const task = question.replace(CONDITIONAL, '$1');
  const money = PAYABLE_CONTEXT.test(task);
  const ownerPays = (OWNER_PAYS.test(task) || money && OWNER_SETTLES.test(task)) && !MODAL_OWNER.test(task);
  return ownerPays || OWNER_PAYMENT_EVENT.test(task) || PASSIVE_MONEY.test(task) || PAYABLE_STATE.test(task) ||
    ACTIVE_PAYER.test(task) && (money || /\b(?:pay|paid)\b/i.test(task)) ||
    money && (PASSIVE_SETTLED.test(task) || UNPAID_STATE.test(task) || DUE_STATE.test(task));
}

const MONEY_CAPABLE_HANDOFF = 'Answer this money question with brain_money_overview first, brain_money_guide, then brain_money_query. State the accounts and dates covered, missing evidence, and estimates. ' + MONEY_ANSWER_DETAILS + ' Preserve the current access limits. Use document tools for supporting documents and context.';

export function moneyQuestionHandoff(question, { moneyToolsAvailable = true, requiredAgentProfile = 'owner-assistant' } = {}) {
  let q = String(question ?? '').normalize('NFKC').replace(/[’]/g, "'").trim();
  // Bank SQL cannot read books balances, receivables or open bills. Preserve
  // the provider's document answer path even when the question says "bank".
  if (/\b(?:quick[\s-]*books|qbo|xero|fresh[\s-]*books)\b/i.test(q)) return null;
  let task = q.replace(REQUEST_PREFIX, '');
  const clauses = task.replace(QUOTED_RECORD_TOPIC, ' ').split(INDEPENDENT_REQUEST);
  const isRecordClause = clause => RECORD_TERMS.test(clause.trim()) || RECORD_TERMS_YES_NO.test(clause.trim());
  if (clauses.some(isRecordClause)) {
    // Exempt only the record request and its quoted topic. Route the remaining
    // independent requests through the existing bank boundary in either order.
    q = clauses.filter(clause => !isRecordClause(clause)).join(' ').trim();
    if (!q) return null;
    task = q.replace(REQUEST_PREFIX, '');
  }
  // Determine the requested object before treating later receipts as evidence.
  // An agreement with payment terms is still a request for that agreement.
  const requestObject = task.split(/\b(?:with|including|along with|backed by)\b/i, 1)[0];
  const supportingDocuments = /^(?:show|list)\b/i.test(task) &&
    requestObject !== task && !DOCUMENT_SUBJECT.test(requestObject) &&
    (MONEY_SUBJECT.test(requestObject) || ACCOUNT_AMOUNT.test(requestObject) || CURRENCY_AMOUNT.test(requestObject));
  // Payment state is bank-first, whatever record noun the owner uses ("the
  // lease invoice", "the policy bill", "the deposit the lease requires", "the
  // roofer quote"): did money move, or is it still owed? The one document
  // exemption is a question whose main clause asks what a record states
  // ("What amount due does the invoice state?", "What does the lease say I
  // owe?"). A relative clause ("the deposit the lease requires") does not
  // make the record the subject of the question.
  const payablePayment = paymentStateQuestion(task);
  const bankActivity = payablePayment || /\b(?:how much|total|amount)\b.*\b(?:pay|paid|spend|spent|owe|owed|owing)\b|\b(?:did (?:I|we) pay|what did (?:I|we) (?:pay|spend))\b/i.test(q);
  if (!bankActivity && !supportingDocuments && DOCUMENT_SUBJECT.test(q)) return null;
  if (EXPLANATION.test(task) || MONEY_TERM.test(task) || !bankActivity && DOCUMENT_SUBJECT.test(q) &&
      (DOCUMENT_SAYS.test(q) || DOCUMENT_TASK.test(task) && !supportingDocuments)) return null;
  // Recorded tax spending, payments and refunds use bank activity. Return-field questions,
  // including incomplete scopes, must still pass the exact document guards.
  const taxActivity = /\btax(?:es)?\b/i.test(q) &&
    /\b(?:pay|paid|paying|payments?|refunds?|refunded|spend|spent|spending|expenses?|outflows?|went out|inflows?|came in|charges?|charged)\b/i.test(q) && !TAX_DOCUMENT.test(q);
  if (!taxActivity && taxQuestionScopeAssessment(q).applicable) return null;
  if (/\bsubscriptions?\b/i.test(q) && /\b(?:active|cancelled|canceled|status|renewal)\b/i.test(q) &&
      !/\b(?:how much|cost|total|paid|paying)\b/i.test(q)) return null;
  const financial = payablePayment || MONEY_SUBJECT.test(q) || ACCOUNT_AMOUNT.test(q) || CURRENCY_AMOUNT.test(q);
  if (q.search(NON_MONEY_SAVINGS) >= 0 && !MONEY_SUBJECT.test(q.replace(NON_MONEY_SAVINGS, '')) && !CURRENCY_AMOUNT.test(q)) return null;
  if (/\bhow much\s+(?:time|effort|energy|space|distance)\b/i.test(q) && !financial) return null;
  // Amount questions default to money when the outer task is still ambiguous.
  // Do not reuse the retired reader's grammar or require it to parse a period.
  if (!financial && !/\bhow much\b/i.test(q)) return null;
  const confidence = unknownMoneyConfidence('No bank rows have been read by this routing step.', 'Read the owner money overview and the requested account/date rows before reporting a bank figure.');
  return {
    confidence:{...confidence,band:confidence.level,basis:confidence.reasons}, confidence_text: confidenceText(confidence),
    mode: 'think', money_handoff: true, money_tools_available: moneyToolsAvailable,
    ...(moneyToolsAvailable ? {} : { required_agent_profile: requiredAgentProfile }),
    answer: (moneyToolsAvailable ? MONEY_CAPABLE_HANDOFF : MONEY_CAPABILITY_TRANSITION.replaceAll('owner-assistant', requiredAgentProfile)) + '\n' + confidenceText(confidence),
    citations: [], results: [], gaps: [],
  };
}
