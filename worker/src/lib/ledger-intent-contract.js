import { refundBasisSpans } from './ledger-refund-basis.js';
// This guard separates parts and rejects outer tasks. It deliberately does
// not infer a ledger kind, vendor, direction, count, or relative period.
const outerTask = /\b(?:translate|translation|rewrite|rephrase|proofread|explain|define|definition|recommend|advice|hypothetical|course|tuition|proposal|quote|quotation|solve|recipe|riddle)\b|\b(?:what|which) colou?r\b|\bbest bank\b|\b(?:open|choose) an? (?:bank )?account\b|\b(?:price|pricing|charge|cost) (?:for|of) (?:a |an |the |our )?(?:client|customer|course|project|service)\b/i;

// Admission vocabulary is deliberately broader than the operation grammar.
// Inflection and account/activity nouns must not decide the eventual reader.
export const ledgerShorthandDecoy = /\b(?:accts? manager|rev of (?:the )?doc|cc (?:me|them|the team))\b/i;
export const ledgerMoneyCue = /\b(?:accts?|bal|txns?|rev|cc|landed|outgoings|went to|take in|did it hit|come through|money|cash|bank|accounts?|balances?|deposit(?:s|ed|ing)?|expenses?|charges?|purchases?|costs?|bills?|subscriptions?|payments?|pay|paying|paid|spend|spent|spending|income|incoming|outgoing|revenue|transactions?|transfers?|inflows?|outflows?|funds|credits?|debits?|checking|savings|receipts?|renewals?|received|arrived|came in|went out|shelled out)\b|\$\s*\d/i;

const cardAccount = String.raw`(?:(?:my|our|the) (?:(?:business|personal|credit|debit) ){0,2}cards?|(?:credit|debit) cards?)`;
const moneyPeriod = String.raw`(?:today|yesterday|this (?:week|month|quarter|year|yr)|last (?:week|month|quarter|year)|year[ -]to[ -]date|month by month|monthly)`;
const cardAccountCue = new RegExp(String.raw`\b${cardAccount}\b`, 'i');
const moneyPeriodCue = new RegExp(String.raw`\b${moneyPeriod}\b`, 'i');
const descriptorTotal = new RegExp(String.raw`^(?<prefix>(?:on ${cardAccount} ${moneyPeriod},?\s+)?(?:what(?:['’]s| is| was)|show(?: me)?) the total for )(?<descriptor>[\p{L}\p{N} .&/'"“”‘’*#()-]{1,164}?)(?<suffix>(?: on ${cardAccount} ${moneyPeriod})?[?.!]*)$`, 'iu');
const descriptorQuotes = Object.freeze({ '"': '"', "'": "'", '“': '”', '‘': '’' });

// Task words inside an explicitly marked statement descriptor have no task
// authority. Mask only that bounded syntactic role, never an arbitrary model
// selector or the original question used for extraction and literal grounding.
export function ledgerDescriptorTotal(question) {
  const match = descriptorTotal.exec(question);
  if (!match || !match.groups.descriptor.includes('*')) return null;
  let descriptor = match.groups.descriptor;
  // Enclosing delimiters are question syntax, never part of a bank payee.
  if (descriptorQuotes[descriptor[0]] === descriptor.at(-1)) descriptor = descriptor.slice(1, -1);
  if (!descriptor || descriptor.length > 160) return null;
  const prose = `${match.groups.prefix} selector ${match.groups.suffix}`;
  // Read modifiers from the admitted account phrase, not their position or
  // selector bytes. Every role survives nullable/generic provider hints.
  const cardRoles = [...new Set([...prose.matchAll(new RegExp(String.raw`\b${cardAccount}\b`, 'gi'))]
    .flatMap(account => account[0].toLowerCase().match(/\b(?:business|personal)\b/g) || []))];
  return cardAccountCue.test(prose) && moneyPeriodCue.test(prose)
    ? { descriptor, prose, cardRoles } : null;
}

// Only task classification sees masked prose. All callers retain the original
// question for model input, literal binding and evidence. Scope, calendar and
// all other semantic task decisions use the protected frame's prose.
export const ledgerTaskProse = question => ledgerDescriptorTotal(question)?.prose || question;

// Debt-payment subjects cannot borrow ordinary-expense semantics. This closed
// syntactic role excludes a purchase memo or an account label containing debt
// words; exact quoted descriptors retain their existing literal protection.
export function loanPaymentSubject(question, intent = null) {
  let text = ledgerTaskProse(typeof question === 'string' ? question : '');
  if (intent?.match) {
    // An explicitly selected vendor is an identity, not a debt-payment topic.
    // Mask the whole admitted literal in its identity frame, never its prefix.
    const literal = intent.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b(?:at|with|(?:vendor|merchant|payee) (?:named|called)) ["“”']?${literal}["“”']?(?=$|[\\s?.!,])`, 'gi'), ' ');
  }
  const debt = '(?:loans?|mortgages?|lenders?|lines? of credit)';
  const owner = '(?:(?:my|our|the|a|an) )?(?:(?:business|personal|home) )?';
  return new RegExp(`\\b(?:pay|paid|paying|repay|repaid|repaying|payments?|repayments?)(?: (?:on|to|toward|towards|for|off))? ${owner}${debt}\\b`, 'i').test(text) ||
    new RegExp(`\\b${debt} (?:payments?|repayments?|payoffs?)\\b`, 'i').test(text);
}
export const loanAccountSelector = value => /^(?:(?:my|our|the|business|personal|home) )*(?:loans?|mortgages?|lenders?|lines? of credit)(?: accounts?)?$/i.test(value || '');


// These question-only cues grant extraction, never a reader or a figure.
// Do not correct the text: a descriptor, nickname or typo inside a selector
// must still reach literal grounding with its original bytes.
export function boundedLedgerMoneyCue(question) {
  question = ledgerTaskProse(question);
  if (outerTask.test(question) || /\b(?:mean|means|meaning|rules?|policy|policies|tax|pricing|playing|game|poker|appointment|hypothetical)\b/i.test(question)) return false;
  const cards = /\b(?:(?:my|our|the) (?:(?:business|personal|credit|debit) ){0,2}cards?|(?:credit|debit) cards?|card debt)\b/i.test(question);
  const period = moneyPeriodCue.test(question);
  if (cards && /\b(?:owe|owed|owing|debt)\b/i.test(question)) return true;
  if (cards && period && /\btotal\b/i.test(question)) return true;
  if (/\bhow much is on (?:the|my|our) [\p{L}\p{N}][\p{L}\p{N} .&/'*-]{0,100} (?:right now|currently|today)\b/iu.test(question)) return true;
  if (/\b(?:payouts?|payoouts?)\b/i.test(question) && period &&
      /\b(?:biggest|largest|total|how much|show|list|month by month|monthly)\b/i.test(question)) return true;
  if (/\b(?:i|we) (?:spned|spnet) at\b/i.test(question) && /\b(?:how much|what)\b/i.test(question)) return true;
  // This is only an intent cue. The scope plan must still resolve both full
  // endpoint literals against confirmed inventory before any ledger read.
  return period && /\bhow much (?:did|have) (?:i|we) (?:move|moved|transfer) from\b/i.test(question) &&
    /\bfrom [\p{L}\p{N} .&/'*-]{1,100} to [\p{L}\p{N} .&/'*-]{1,100}/iu.test(question);
}
const temporalWords = new Set('this last next previous prior past current today yesterday week month quarter year days weeks months quarters years first second third fourth q jan feb mar apr jun jul aug sep sept oct nov dec q1 q2 q3 q4 january february march april may june july august september october november december'.split(' '));
const tokens = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const periodOnly = text => {
  const parts = tokens(text);
  return parts.length > 0 && parts.every(word => temporalWords.has(word) || /^\d{1,4}$/.test(word));
};
// A shortened calendar operand may inherit only from one substantive core.
// Unknown words are not evidence of either a period or whole-owner scope.
const periodGlue = new Set('in for during the please of to date so far at point same number before'.split(' '));
const operandPeriodWords = new Set([...temporalWords, ...'monday tuesday wednesday thursday friday saturday sunday weekend now yr yrs'.split(' ')]);
const ownerWords = new Set('could can would will you i we my our your me us owner all whole across accounts account ledger bank show retrieve get list give tell please compare compared with to against versus vs how much did do does was were is are has have had spending spend spent expense expenses charges charge money in out income inflow inflows outflow outflows total totals completed posted change difference on by at for and using days day more less than after refunds without counting own transfers twice everything counted gross net'.split(' '));
const requestWrapperWords = new Set('could can would will you i we me us my our please show retrieve get list give tell display find fetch see let'.split(' '));
const countWords = new Map('one two three four five six seven eight nine ten'.split(' ').map((word, index) => [word, index + 1]));
export function ledgerClauseIsPeriodOperand(text) {
  const parts = tokens(text);
  return parts.length > 0 && parts.every(word => operandPeriodWords.has(word) || periodGlue.has(word) || /^\d{1,4}$/.test(word));
}
export function ledgerClauseIsOwnerOperand(text, intent) {
  let remainder = text;
  for (const literal of [intent.match, intent.counterpartyText]) {
    if (typeof literal !== 'string' || !literal) continue;
    remainder = remainder.split(new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ');
  }
  // Amount basis qualifies a quantity, not an account identity. Reuse the
  // closed financial grammar after masking literals; unknown words still refuse.
  const basisSpans = refundBasisSpans(remainder);
  remainder = remainder.split('').map((ch, index) => basisSpans.some(([start, end]) => index >= start && index < end) ? ' ' : ch).join('');
  const parts = tokens(remainder);
  return parts.length > 0 && parts.every(word => operandPeriodWords.has(word) || periodGlue.has(word) || ownerWords.has(word) || /^\d{1,4}$/.test(word));
}
function missingDateFilter(text) {
  const parts = new Set(tokens(text));
  return parts.has('undated') || (['date', 'dates'].some(word => parts.has(word)) &&
    ['missing', 'unknown', 'blank', 'absent', 'no'].some(word => parts.has(word)));
}

// Keep the nullable clause API compatible while its caller reports a closed
// diagnostic for every refusal. No question text enters the diagnostic.
export function ledgerClauseRefusalReason(question) {
  if (outerTask.test(ledgerTaskProse(question))) return 'decoy_outer_task';
  if (missingDateFilter(ledgerTaskProse(question))) return 'capability';
  return 'two_part_unsplittable';
}
// Independence is about a new operand, not a vocabulary of permitted prose.
// A reference to the same payment, amount or account adds no new authority.
const ownPeriod = /\b(?:today|yesterday|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|q[1-4])\b|\b(?:this|last|next|previous|prior|past|current|another|each|every) (?:\d+ )?(?:day|week|weekend|month|quarter|year)s?\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:since|before|after|during|in|on) \d/i;
const literalIn = (text, literal) => typeof literal === 'string' && literal.length > 0 && text.toLowerCase().includes(literal.toLowerCase());
export function ledgerClauseIsDetail(text, intent, core = '') {
  if (outerTask.test(text) || missingDateFilter(text) || periodOnly(text) || ownPeriod.test(text) || /\b(?:since|before|until|through|during)\b/i.test(text)) return false;
  if (/\b\d+(?:[,.]\d+)*\b|(?:\$|\busd\b)\s*\d/i.test(text)) return false;
  let remainder = text;
  // Remove only grounded selectors already carried by the operation. The
  // caller keeps the original question for grounding and all scope checks.
  for (const literal of [intent.vendor_text, intent.account_hint]) {
    if (literalIn(core, literal) && literalIn(remainder, literal)) {
      const offset = remainder.toLowerCase().indexOf(literal.toLowerCase());
      remainder = remainder.slice(0, offset) + remainder.slice(offset + literal.length);
    }
  }
  if (/\b(?:personal|business|household|checking|savings|cards?|loans?|investment|retirement|escrow)\b|\b(?:account|acct)s? (?:named|called|ending|for)\b|\b(?:the|our|my) [\p{L}\p{N}]+ (?:account|acct)s?\b/iu.test(remainder)) return false;
  // New literal payees and named scopes stay independent, including bare
  // labels without a preposition. Lowercase entity phrases need a selector
  // preposition; anaphoric destinations such as 'into that account' do not.
  const named = /\b[A-Z][\p{L}\p{N}]* (?:[A-Z][\p{L}\p{N}]*|Unit)\b/u.test(remainder);
  if (named || /\b(?:at|from|to|for) (?!it\b|that\b|those\b|them\b|the same\b|each\b|every\b|a (?:second|day)\b|the (?:top|total|amount|account)\b)(?:the )?[a-z]+(?: [a-z]+)?\b/i.test(remainder)) return false;
  return true;
}
function ancillary(text, intent) {
  // A literal/cue-bearing clause is a candidate core unless it refers back.
  // This also lets a payee-only total be the substantive clause.
  if (/\b(?:dates?|amounts?|rows|details|ties)\b/i.test(text) && ledgerClauseIsDetail(text, intent)) return true;
  const backReference = /\b(?:it|that|those|them|they|each|their)\b/i.test(text);
  if ((ledgerMoneyCue.test(text) || [intent.vendor_text, intent.amount_text, intent.date_text, intent.account_hint].some(literal => literalIn(text, literal))) && !backReference) return false;
  return ledgerClauseIsDetail(text, intent);
}

export function ledgerClauseDecision(question, intents, { sharedWindow = false, scopePlan = null } = {}) {
  if (outerTask.test(ledgerTaskProse(question))) return null;
  // Dated ledger windows cannot express an absence-of-date predicate. In
  // particular it must never be replaced by the current-month default.
  if (missingDateFilter(ledgerTaskProse(question))) return null;
  if (scopePlan) {
    // Every explicit plan owns one bounded operation span. The remainder must
    // independently satisfy the detail contract, even without a conjunction.
    const [start, end] = scopePlan.span || [];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > question.length || start >= end) return null;
    const clause = question.slice(start, end);
    const remainder = question.slice(0, start) + ' ' + question.slice(end);
    // A count before the matched noun belongs to this operation only when it
    // equals its count field. No other numeral or unknown word is discarded.
    const count = Number(intents[0].count);
    const wrapper = tokens(remainder).filter(word => !(count > 0 && (word === String(count) || countWords.get(word) === count)));
    if (!wrapper.every(word => requestWrapperWords.has(word)) ||
        ledgerMoneyCue.test(remainder) || !ledgerClauseIsDetail(wrapper.join(' '), intents[0], clause)) return null;
    return { outcome: 'ready', clauses: intents.map(() => clause) };
  }
  // A top-category companion uses the same explicit total window, rather
  // than inventing a second default period for its terse second clause.
  if (intents.length === 2 && intents[0].kind === 'totals' && intents[1].kind === 'category' &&
      intents[1].count === 1 && intents[1].vendor_text === null && /\b(?:top|largest|biggest) category\b/i.test(question)) {
    return { outcome: 'ready', clauses: [question, question] };
  }
  let text = question;
  // Literal entity text can itself contain conjunctions. Protect only grounded
  // spans, then restore the original bytes for the period contradiction check.
  const protectedSpans = [];
  const protect = span => { protectedSpans.push(span); return `\u0001${protectedSpans.length - 1}\u0001`; };
  const vendors = [...new Set(intents.map(i => i?.vendor_text).filter(v => typeof v === 'string' && v))]
    .sort((a, b) => b.length - a.length);
  for (const vendor of vendors) {
    const offset = text.toLowerCase().indexOf(vendor.toLowerCase());
    if (offset >= 0) text = text.slice(0, offset) + protect(text.slice(offset, offset + vendor.length)) + text.slice(offset + vendor.length);
  }
  const comparison = text.split(/\b(?:more|less)\b/i.test(text)
    ? /\b(?:against|versus|vs|compared (?:with|to)|than)\b/i : /\b(?:against|versus|vs|compared (?:with|to))\b/i)
    .map(s => s.replace(/\u0001(\d+)\u0001/g, (_, n) => protectedSpans[Number(n)]).trim());
  if (intents.length === 2 && comparison.length === 2 && comparison.every(Boolean) && intents[0].kind === intents[1].kind) {
    return { outcome: 'ready', clauses: comparison, comparison: true };
  }
  text = text.replace(/\b(?:between|from) (?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?|[a-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?) (?:and|to|through) (?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?|[a-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)\b/gi, protect)
    .replace(/\bon or after (?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?|[a-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)\b/gi, protect)
    .replace(/\b(?:came in and went out|money in and out|credits and debits|incoming and outgoing)\b/gi, protect);
  if (intents.every(intent => intent.kind === 'transfers')) text = text.replace(/\bbetween (?:my|our|the) personal and business (?:accounts|accts)\b/gi, protect);
  const clauses = text.split(/\s*;\s*|\b(?:and|also|plus|then|or)\b/i)
    .map(s => s.replace(/\u0001(\d+)\u0001/g, (_, n) => protectedSpans[Number(n)]).trim());
  if (intents.length === 1 && clauses.length > 1 && clauses.every(Boolean)) {
    // A conjunction alone does not establish two requests. A lone financial
    // segment may have background prose or output details beside it. Keep
    // multiple financial segments and standalone period operands closed;
    // neither can be silently dropped to fit the model's one returned part.
    const substantive = clauses.filter(s => !ancillary(s, intents[0]) && (ledgerMoneyCue.test(s) || periodOnly(s)));
    const groundedCore = clauses.find(s => [intents[0].vendor_text, intents[0].amount_text, intents[0].date_text, intents[0].account_hint].some(literal => literalIn(s, literal)));
    const core = groundedCore || substantive[0] || clauses.find(s => ledgerMoneyCue.test(s));
    if (core && substantive.length <= 1 && clauses.every(s => s === core || ledgerClauseIsDetail(s, intents[0], core))) {
      // Keep the complete wording for local monthly/detail handling and all
      // scope guards. A detail never grants authority to erase a restriction.
      return { outcome: 'ready', clauses: [question], calendarCore: core, answerDetail: true };
    }
  }
  if (clauses.length !== intents.length || clauses.some(s => !s)) {
    if (intents.length !== 1) return null;
    const periodOperand = clauses.some(s => periodOnly(s.replace(/^the\s+/i, '')));
    // Separate requested windows still need separate operations. A relative
    // alternative can be clarified, but a one-window reader cannot satisfy
    // an additive period request by silently choosing just one operand.
    if (periodOperand && !/\bor\b/i.test(question)) return null;
    // A useful single reading may survive uncertain segmentation. Keep the
    // whole question for every subsequent scope, grounding and calendar guard;
    // this decision never turns omitted parts into a complete answer.
    return { outcome: 'clarify', clauses: [question], operationCore: clauses[0],
      reason: periodOperand ? 'period_uncertain' : 'single_intent_clause_uncertain' };
  }
  // A period stated on only one activity may govern both. The model cannot
  // authorize an implicit default for the other part of that question.
  if (!sharedWindow && intents.length === 2 && intents.some(i => i.period?.type !== 'none') &&
    intents.some(i => i.period?.type === 'none' && !['balance', 'forecast', 'transactions'].includes(i.kind))) return null;
  return { outcome: 'ready', clauses };
}

// Existing callers authorize only a complete, unambiguous clause plan.
export function ledgerQuestionClauses(question, intents) {
  const decision = ledgerClauseDecision(question, intents);
  return decision?.outcome === 'ready' ? decision.clauses : null;
}
