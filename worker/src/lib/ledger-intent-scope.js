// These bounded plans carry literal endpoints. Only confirmed inventory can
// resolve them; no model reply, payee, institution or fuzzy alias grants scope.
import { resolveOwnershipScope } from './ledger-owner-scope.js';
import { ledgerClauseIsPeriodOperand, ledgerClauseIsOwnerOperand } from './ledger-intent-contract.js';
const period = /\b(?:(?:last|previous|this|current) (?:month|quarter|q|year|yr)|in ['’]\d{2}|(?:in |during )\d{4})\b/gi;
const clean = text => text.replace(/^[\s,?.!]+|[\s,?.!]+$/g, '').replace(/^(?:my|our|the) /i, '').replace(/ (?:accounts?|accts?)$/i, '');
const valid = text => /^[\p{L}\p{N}][\p{L}\p{N} '&-]{0,79}$/u.test(text) && !/\b(?:and|or|vs|versus|from|to|between|except|excluding|without)\b/i.test(text);
export function ledgerScopePlan(question) {
  const transfer = /\b(?:how much (?:did|have) (?:i|we) )?(?:transfers?|move|moved) (between|from) (.+?) (and|to) (.+?)[?.!]*$/i.exec(question);
  if (transfer) {
    const source = clean(transfer[2]), destination = clean(transfer[4].replace(period, ''));
    if (!valid(source) || !valid(destination) || (transfer[1].toLowerCase() === 'between') !== (transfer[3].toLowerCase() === 'and')) return { invalid: true };
    return { type: 'transfer', source, destination, directed: transfer[1].toLowerCase() === 'from', span: [transfer.index, transfer.index + transfer[0].length] };
  }
  const split = /\b(?:split|break down) (.+)$/i.exec(question);
  if (!split) return null;
  // A category/payment-type breakdown keeps its existing reader contract.
  if (!/\b(?:vs|versus)\b/i.test(split[1]) && !/\bby\b.+,.+\band\b/i.test(split[1])) return null;
  const body = split[1].replace(period, '').replace(/\b(?:spending|expenses|money out)\b/gi, '')
    .replace(/^\s*(?:for|by|across|between|into)?\s*/i, '').trim();
  const selectors = body.split(/\s*\b(?:vs|versus|and)\b\s*|\s*,\s*/i).filter(Boolean).map(clean);
  return selectors.length >= 2 && selectors.length <= 3 && selectors.every(valid)
    ? { type: 'partition', selectors, span: [split.index, split.index + split[0].length] } : { invalid: true };
}
const key = value => clean(String(value || '')).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function ledgerOperandScopePlan(clauses, intents) {
  const scopes = [...new Map(intents.filter(i => i.modelAccountScope).map(i => [key(i.modelAccountScope), i.modelAccountScope])).values()];
  const cores = clauses.filter(clause => !ledgerClauseIsPeriodOperand(clause));
  const shared = cores.length === 1 && scopes.length === 1 && cores[0].toLowerCase().includes(scopes[0].toLowerCase()) ? scopes[0] : null;
  // An abbreviated operand cannot lose the only core's unresolved literal.
  // Inventory recognition may turn that merchant into an exact account scope;
  // otherwise a heterogeneous model reply has not established a shared filter.
  const unresolvedShared = cores.length === 1 &&
    intents.some(intent => intent.kind === 'merchant' && intent.match && !intent.modelAccountScope) &&
    intents.some(intent => !intent.match && !intent.modelAccountScope);
  const selectors = intents.map((intent, index) => {
    if (unresolvedShared) return null;
    if (intent.modelAccountScope) return intent.modelAccountScope;
    if (shared) return shared;
    // Whole-owner scope is explicit plan data, never the meaning of null.
    // A missing field beside another restricted operation remains unresolved
    // unless this operand itself explicitly asks for all accounts.
    const explicitOwner = /\ball (?:my |our |the )?accounts\b|\bwhole (?:owner )?ledger\b/i.test(clauses[index]);
    return (!scopes.length || explicitOwner) && ledgerClauseIsOwnerOperand(clauses[index], intent) ? { wholeOwner: true } : null;
  });
  return { type: 'operands', selectors };
}
function exactScopeIdentity(inventory, wanted) {
  // Null permits generic scope resolution. An empty array means a recognized
  // but ambiguous identity and must remain terminal, never a broader fallback.
  const entities = inventory.filter(a => a.members.every(m => key(m.entity_label) === wanted));
  if (entities.length) return new Set(entities.map(a => a.entity_slug)).size === 1 ? entities : [];
  const accounts = inventory.filter(a => a.members.every(m => key(m.label) === wanted || /^\d{1,4}$/.test(wanted) && m.mask === wanted));
  if (!accounts.length) return null;
  return accounts.length === 1 ? accounts : [];
}
export function resolveLedgerScope(inventory, literal) {
  const wanted = key(clean(literal));
  const ownership = resolveOwnershipScope(inventory, literal);
  if (ownership) {
    // Bare business/personal remain the historical whole-role selectors. An
    // exact compound identity, including "Business Checking", keeps S4's
    // narrower entity/account selection before type nouns are discarded.
    if (!['business', 'personal'].includes(wanted)) {
      const exact = exactScopeIdentity(ownership.accounts, wanted);
      if (exact) return exact;
      // A known type-word identity outside this owner set cannot turn into
      // an all-business/personal total after its type noun is removed.
      if (!ownership.residual && exactScopeIdentity(inventory, wanted)) return [];
    }
    if (!ownership.residual) return ownership.accounts;
    // Preserve S4's exact entity-before-account identity rule, inside the
    // ownership denominator. A role word in an entity name cannot widen it.
    for (const selector of [literal, ownership.selector, ownership.residual]) {
      const exact = exactScopeIdentity(ownership.accounts, key(selector));
      if (exact) return exact;
    }
    return [];
  }
  if (['checking','savings'].includes(wanted)) return inventory.filter(a => a.members.every(m => m.account_kind === wanted));
  if (wanted === 'personal') return inventory.filter(a => a.members.every(m => ['person','household'].includes(m.entity_kind)));
  if (wanted === 'business') return inventory.filter(a => a.members.every(m => m.entity_kind === 'business'));
  return exactScopeIdentity(inventory, wanted) || [];
}
export function resolvedLedgerScopePlan(inventory, plan) {
  const literals = plan.type === 'transfer' ? [plan.source, plan.destination] : plan.selectors;
  const selections = literals.map(literal => literal?.wholeOwner === true && Object.keys(literal).length === 1 ? inventory
    : typeof literal === 'string' ? resolveLedgerScope(inventory, literal) : []);
  if (selections.some(group => !group.length)) return { reason: 'scope_unresolved' };
  const slugs = selections.map(group => group.map(a => a.account_slug));
  if (plan.type !== 'operands' && new Set(slugs.flat()).size !== slugs.flat().length) return { reason: 'scope_overlap' };
  return { selections, slugs };
}
