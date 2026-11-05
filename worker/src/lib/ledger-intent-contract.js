// This guard separates parts and rejects outer tasks. It deliberately does
// not infer a ledger kind, vendor, direction, count, or relative period.
const outerTask = /\b(?:translate|translation|rewrite|rephrase|proofread|explain|define|definition|recommend|advice|hypothetical|course|tuition|proposal|quote|quotation|solve|recipe|riddle)\b|\b(?:what|which) colou?r\b|\bbest bank\b|\b(?:open|choose) an? (?:bank )?account\b|\b(?:price|pricing|charge|cost) (?:for|of) (?:a |an |the |our )?(?:client|customer|course|project|service)\b/i;

// Admission vocabulary is deliberately broader than the operation grammar.
// Inflection and account/activity nouns must not decide the eventual reader.
export const ledgerShorthandDecoy = /\b(?:accts? manager|rev of (?:the )?doc|cc (?:me|them|the team))\b/i;
export const ledgerMoneyCue = /\b(?:accts?|bal|txns?|rev|cc|landed|outgoings|went to|take in|did it hit|come through|money|cash|bank|accounts?|balances?|deposit(?:s|ed|ing)?|expenses?|charges?|purchases?|costs?|bills?|subscriptions?|payments?|pay|paying|paid|spend|spent|spending|income|incoming|outgoing|revenue|transactions?|transfers?|inflows?|outflows?|funds|credits?|debits?|checking|savings|receipts?|renewals?|received|arrived|came in|went out|shelled out)\b|\$\s*\d/i;
const temporalWords = new Set('this last next previous prior past current today yesterday week month quarter year days weeks months quarters years first second third fourth q1 q2 q3 q4 january february march april may june july august september october november december'.split(' '));
const tokens = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const periodOnly = text => {
  const parts = tokens(text);
  return parts.length > 0 && parts.every(word => temporalWords.has(word) || /^\d{1,4}$/.test(word));
};
function missingDateFilter(text) {
  const parts = new Set(tokens(text));
  return parts.has('undated') || (['date', 'dates'].some(word => parts.has(word)) &&
    ['missing', 'unknown', 'blank', 'absent', 'no'].some(word => parts.has(word)));
}

// Keep the nullable clause API compatible while its caller reports a closed
// diagnostic for every refusal. No question text enters the diagnostic.
export function ledgerClauseRefusalReason(question) {
  if (outerTask.test(question)) return 'decoy_outer_task';
  if (missingDateFilter(question)) return 'capability';
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

export function ledgerClauseDecision(question, intents, { sharedWindow = false } = {}) {
  if (outerTask.test(question)) return null;
  // Dated ledger windows cannot express an absence-of-date predicate. In
  // particular it must never be replaced by the current-month default.
  if (missingDateFilter(question)) return null;
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
    return { outcome: 'clarify', clauses: [question],
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
