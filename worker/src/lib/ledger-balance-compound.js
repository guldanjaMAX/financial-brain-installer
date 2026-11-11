const selector = intent => intent.modelAccountScope || intent.accountSelector || intent.mask;
const hasLiteral = (text, literal) => literal && text.toLowerCase().includes(literal.toLowerCase());
const balanceCue = /\bbalances?\b|\bhow much (?:money |cash )?do i have\b/i;

// This is a refusal boundary, not authority to read a quantity. Inspect the
// whole question before the two-intent model limit can hide another operand.
// Literal selectors and same-operation details are not independent operands.
export function compoundBalanceOperands(question, intents, labels, { normalizeLedgerIntentWords, ledgerClauseRefusalReason }) {
  if (ledgerClauseRefusalReason(question) === 'decoy_outer_task') return null;
  // The existing parser reserves these source-qualified questions for document
  // evidence. Bank inventory cannot change which source the owner requested.
  if (/\b(?:quickbooks|qbo)\b/i.test(question)) return null;
  if (/[\n\r{}<>`]/.test(question) || /\b(?:ignore|disregard|override|system|assistant|instructions?|schema|json|prompt)\b/i.test(question)) return null;
  const normalized = normalizeLedgerIntentWords(question);
  if (!balanceCue.test(normalized) && !intents.some(intent => intent.kind === 'balance')) return null;
  const literals = [...new Set([...labels, ...intents.map(selector)
    .filter(value => value && !/\b(?:and|plus|versus|vs|against)\b/i.test(value)),
    ...intents.map(intent => intent.match).filter(Boolean)])].sort((a, b) => b.length - a.length);
  const spans = [];
  let text = normalized;
  for (const literal of literals) {
    const value = normalizeLedgerIntentWords(literal);
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), match => {
      spans.push(match); return `\u0001${spans.length - 1}\u0001`;
    });
  }
  // These conjunctions belong to one activity or calendar operand.
  text = text.replace(/\b(?:money in and out|came in and went out|credits and debits|incoming and outgoing)\b/gi, match => {
    spans.push(match); return `\u0001${spans.length - 1}\u0001`;
  });
  const comparison = /\b(?:compare|comparison|difference|versus|vs|against|side by side|compared)\b/i.test(text);
  const pieces = text.split(comparison
    ? /\b(?:versus|vs|against|compared (?:with|to)|and|also|plus|then)\b|;|,(?=\s*\S)/i
    : /\b(?:and|also|plus|then)\b|;/i)
    .map(piece => piece.replace(/\u0001(\d+)\u0001/g, (_, n) => spans[Number(n)]).replace(/^[\s,]+|[\s?.!,]+$/g, ''))
    .filter(Boolean);
  const quantity = /\b(?:balances?|money|expenses?|charges?|spend|spent|spending|transactions?|deposits?|payments?|inflows?|outflows?|purchases?|transfers?|recurring|income|profit)\b/i;
  const scope = /\b(?:accounts?|checking|savings|cards?|loans?|personal|business)\b/i;
  const clauses = pieces.filter(piece => {
    if (/\bwhich account (?:pays|paid|holds|receives)\b/i.test(piece)) return true;
    if (/\b(?:mean|means|meaning|enough|current is|which (?:card )?account|when was|not counting)\b/i.test(piece)) return false;
    if (balanceCue.test(piece) || quantity.test(piece)) return true;
    if (intents.some(intent => hasLiteral(piece, selector(intent)))) return true;
    if (/^(?:we|i)\b/i.test(piece)) return false;
    if (comparison) return !/^(?:the )?(?:(?:this|last|next|previous) (?:week|month|year)|today|yesterday)$/i.test(piece);
    return scope.test(piece) && !/\b(?:it|that|those|them|their|same)\b/i.test(piece);
  });
  if (clauses.length < 2) {
    return intents.length > 1 && intents.some(intent => intent.kind === 'balance')
      ? intents.map(intent => ({ clause: intent.interpretation, intent })) : null;
  }
  const used = new Set();
  return clauses.map(clause => {
    let index = intents.findIndex((intent, i) => !used.has(i) && hasLiteral(clause, selector(intent) || intent.match));
    if (index < 0) index = intents.findIndex((intent, i) => !used.has(i) && !selector(intent) &&
      !intent.balancePurposeComparison && !intent.balanceMeasures &&
      (intent.kind === 'balance' ? balanceCue.test(clause) : !balanceCue.test(clause)));
    if (index >= 0) used.add(index);
    return { clause, intent: index >= 0 ? intents[index] : null,
      inheritedBalance: comparison || intents.every(intent => intent.kind === 'balance') };
  });
}

function standaloneBalance(operand, context) {
  const { classifyLedgerQuestion, validateLedgerIntentDecision } = context;
  const { clause } = operand;
  // Only a balance frame can lend its noun to a bare comparison selector.
  // All other unhandled operands remain explicit unavailable parts.
  if (!balanceCue.test(clause) && !operand.inheritedBalance) return null;
  if (!balanceCue.test(clause) && /\b(?:show|total|retrieve|include|list|spent|spend)\b.*\b(?:charges?|expenses?|spending|transactions?|deposits?|payments?|money|income)\b/i.test(clause)) return null;
  const measure = /\b(available|statement|ledger|pending|current)\b/i.exec(clause)?.[1]?.toLowerCase();
  if (measure && !/\b(?:accounts?|cards?|checking|savings|loans?)\b/i.test(clause)) {
    return { ...classifyLedgerQuestion('What are my account balances?', context),
      balanceMeasures: [measure], compoundMeasure: measure };
  }
  let hint = clause.replace(/^.*?\b(?:difference|comparison)\s+between\s+/i, '')
    .replace(/^.*?\bbalances?\s+(?:in|on|for|of)\s+/i, '')
    .replace(/^(?:(?:could|can|would) you )?(?:please )?(?:retrieve|show|tell me|compare|what (?:is|are)|what['’]s)\s+(?:(?:my|our|the)\s+)?/i, '')
    .replace(/\s+balances?\b.*$/i, '').replace(/^(?:my|our|the)\s+/i, '').trim();
  if (!hint || hint === clause && balanceCue.test(hint)) return null;
  const question = balanceCue.test(clause) ? clause : `Could you retrieve the balance for ${clause}?`;
  const decision = validateLedgerIntentDecision({ intents: [{ kind: 'balance', account_hint: hint,
    period: { type: 'none' } }] }, question, context);
  return decision.outcome !== 'fallback' && decision.intents.length === 1 ? decision.intents[0] : null;
}

// Numeric references are local to an operand. Rebase only evidence fields;
// an account label containing citation-shaped text remains literal data.
function rebase(value, shift, key = '') {
  if (Array.isArray(value)) return value.map(entry =>
    ['citations', 'possible_transfer_citations', 'transfer_related_credit_citations'].includes(key) && Number.isInteger(entry)
      ? entry + shift : rebase(entry, shift));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([name, entry]) => [name, name === 'n' && Number.isInteger(entry) ? entry + shift : rebase(entry, shift, name)]));
  return value;
}

export async function compoundBalanceAnswer(operands, context, evaluate, decision) {
  const { moneyAccount, ledgerClarificationAnswer, finalLedgerOffer } = context;
  const records = [], parts = [], citations = [], gaps = [], lines = [
    'I cannot confirm this compound balance request. Each reading below stands alone; no combined figure or difference is confirmed.',
  ];
  for (const operand of operands) {
    const intent = operand.intent || standaloneBalance(operand, context);
    const result = await evaluate(intent, operand.clause);
    const { part, accounts, observations } = result;
    const measureUnavailable = intent?.compoundMeasure && (intent.compoundMeasure === 'available'
      ? !part.ledger?.accounts?.length || part.ledger.accounts.some(account => !Number.isSafeInteger(account.available_minor))
      : intent.compoundMeasure !== 'current');
    const complete = Boolean(!measureUnavailable && part.ledger && part.evidence_gate?.complete && part.ledger.complete !== false &&
      part.ledger.coverage?.complete !== false && !part.ledger.selector_unresolved && !intent.forecastRequested);
    const status = accounts.map(account => {
      const row = observations?.find(row => row.effective_account_slug === account.account_slug);
      return { account_mask: /^\d{1,4}$/.test(account.mask || '') ? account.mask : null,
        status: account.status, ...(intent?.kind === 'balance' ? { snapshot_status: !observations || !row && account.status !== 'open' ? 'not_checked' : row && row.basis_state === 'confirmed' &&
          Number.isSafeInteger(row.current_minor) && row.currency === 'USD' ? 'recorded' : 'missing_or_unreadable' } : {}) };
    });
    records.push({ kind: intent?.kind || null, complete, accounts: status });
    const heading = intent?.interpretation || (intent?.compoundMeasure
      ? `${intent.compoundMeasure === 'ledger' ? 'Running account' : intent.compoundMeasure} balance`
      : operand.clause || 'unresolved reading');
    lines.push(`Operand ${records.length}: ${heading}`);
    if (!intent) lines.push('The accounts for this part are unconfirmed; the following accounts are candidates.');
    accounts.forEach((account, index) => lines.push(`${moneyAccount(account, { label: true })}: ${String(account.status || 'status unconfirmed').replaceAll('_', ' ')}${status[index].snapshot_status === 'missing_or_unreadable' ? '; missing recorded balance or unreadable amount' : ''}.`));
    if (measureUnavailable) (part.gaps ||= []).push({ type: 'ledger_not_consulted', reason: 'balance_unavailable',
      detail: `A complete independent ${intent.compoundMeasure === 'ledger' ? 'running account' : intent.compoundMeasure} balance reading is unconfirmed; no figure is shown for this part.` });
    gaps.push(...(part.gaps || []));
    if (complete) {
      const offset = citations.length;
      const prefix = `${intent.interpretation}\n`;
      const detail = part.answer?.startsWith(prefix) ? part.answer.slice(prefix.length) : part.answer;
      lines.push(detail?.replace(/\[(\d+)\]/g, (_, n) => `[${Number(n) + offset}]`) || 'No figure available.');
      citations.push(...rebase(part.citations || [], offset));
      parts.push(rebase(part.ledger, offset));
    } else {
      parts.push(null);
      const details = (part.gaps || []).map(gap => gap.detail).filter(Boolean);
      for (const exclusion of result.exclusions || []) {
        if (!details.some(detail => detail.includes(exclusion))) details.push(exclusion);
      }
      if (intent?.forecastRequested) lines.push('I can help review your records, but future balances and payments are unknown.');
      lines.push(...details, ...(details.length ? [] : ['This operand is incomplete; no figure is confirmed.']));
    }
  }
  const body = { mode: 'think', code: 'compound_balance_unsupported', answer: lines.join('\n'),
    ledger: { kind: 'multi', compound_refused: true, complete: false, operands: records, parts }, citations, results: [], gaps,
    evidence_gate: { supported: false, complete: false, partial: true, reason: 'compound balance request refused; independent operand readings only' } };
  return decision?.intents?.length ? ledgerClarificationAnswer(body, decision) : finalLedgerOffer(body);
}
