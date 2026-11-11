// These bounded plans carry literal endpoints. Only confirmed inventory can
// resolve them; no model reply, payee, institution or fuzzy alias grants scope.
import { ledgerClauseIsPeriodOperand, ledgerClauseIsOwnerOperand } from './ledger-intent-contract.js';
const period = /\b(?:(?:last|previous|this|current) (?:month|quarter|q|year|yr)|in ['’]\d{2}|(?:in |during )\d{4})\b/gi;
const clean = text => text.replace(/^[\s,?.!]+|[\s,?.!]+$/g, '').replace(/^(?:my|our|the) /i, '').replace(/ (?:accounts?|accts?)$/i, '');
const valid = text => /^[\p{L}\p{N}][\p{L}\p{N} '&-]{0,79}$/u.test(text) && !/\b(?:and|or|vs|versus|from|to|between|except|excluding|without)\b/i.test(text);
export function ledgerScopePlan(question) {
  const transfer = /\btransfers? (between|from) (.+?) (and|to) (.+?)[?.!]*$/i.exec(question);
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
// Role vocabulary is shared by grammar, extracted intents and inventory plans.
// A provider literal may refine a role, but never replace its membership.
const roleNames = { business: 'business', biz: 'business', company: 'business', personal: 'personal', household: 'personal' };
export function ledgerRoleSelector(literal) {
  const match = /^(business|biz|company|personal|household)(?:\s+(.+))?$/.exec(key(literal));
  return match ? { role: roleNames[match[1]], refinement: match[2] || null } : null;
}
// Explicit naming syntax is account identity data, even when its bytes spell
// a role or a date. Keep the exact span before any role inference.
export function ledgerLiteralAccountSelector(text) {
  const matches = [...String(text).matchAll(/\baccounts? (?:named|called)\s+(?:"([^"]+)"|'([^']+)'|(.+?)(?=\s+(?:balances?|spend|spent|spending|last|this|in|during)\b|[?!.]|$))/gi)];
  if (!matches.length) return null;
  if (matches.length !== 1) return { type: 'unresolved', invalid: true };
  const match = matches[0], literal = match[1] || match[2] || match[3];
  const start = match.index + match[0].indexOf(literal);
  return { type: 'account', literal, span: [start, start + literal.length] };
}
export function ledgerRoleSpans(text) {
  const literal = ledgerLiteralAccountSelector(text);
  return [...String(text).matchAll(/\b(?:business|biz|company|personal|household)\b(?! days\b)/gi)]
    .filter(m => !literal?.span || m.index < literal.span[0] || m.index >= literal.span[1])
    .map(m => [m.index, m.index + m[0].length]);
}
// Subject and balance-selector slots remain restrictions even when a provider
// omits their hint. Known financial words inside an entity name do not turn
// that subject into a whole-owner request.
function localScopeSelector(text, intent) {
  if (intent.scopePlan || intent.counterpartyText || intent.descriptionKeyword) return null;
  if (intent.forecastRequested) text = text.replace(/\b(?:(?:for|in|during) )?next (?:week|month|quarter|year)\b/gi, '');
  const subject = /\b(?:what|how much) did (.{1,160}?) (?:spend|pay|receive|bring in|take in)\b/i.exec(text);
  if (intent.match && (!subject || key(subject[1]) !== key(intent.match))) return null;
  let match = subject;
  if (!match && intent.kind === 'balance') match =
    /\bbalances? (?:for|in|on|from) (.{1,160}?)(?=\s+(?:right now|today|as of)\b|[?.!]|$)/i.exec(text) ||
    /\b(?:retrieve|show(?: me)?|give me|what (?:is|are)) (.{1,160}?) balances?\b/i.exec(text);
  if (!match) return null;
  const purpose = /\baccounts? (?:we|i) use for (.+)$/i.exec(match[1]);
  const literal = (purpose ? purpose[1] : match[1]).replace(/^what (?:is|are) /i, ''), wanted = key(literal);
  if (!wanted) return null;
  if (/^(?:(?:all )?(?:my|our|the) |all )?(?:bank )?accounts?$/i.test(literal.trim())) return null;
  if (/^(?:i|we|me|us|my|our|the|owner|(?:all )?(?:(?:my|our|the|bank) )?accounts?)$/.test(wanted)) return null;
  if (!subject && /^(?:(?:current|recorded|latest|available|pending|posted|cleared|statement|ledger|bank|cash|money|a|rundown|of|the|each|and|versus|vs)\s*)+$/.test(wanted)) return null;
  const start = match.index + match[0].indexOf(literal);
  return { literal, source: subject ? 'subject' : 'balance', span: [start, start + literal.length] };
}
// Admission has checked the complete operation. A missing restriction can
// mean owner scope only when that admission explicitly records it.
export function ledgerAdmittedRestriction(text, intent, wholeOwnerRequest = false, localSelectors = true) {
  if (intent.balancePurposeComparison) return { type: 'unresolved', invalid: true };
  const literal = ledgerLiteralAccountSelector(text);
  if (literal) return { ...literal, outsideRole: ledgerRequestedRole(text) };
  const local = localSelectors ? localScopeSelector(text, intent) : null;
  const selector = local?.literal || intent.modelAccountScope || intent.accountSelector;
  const typed = ledgerRoleSelector(selector);
  const role = intent.requestedRole || typed?.role || intent.entityKind;
  if (role) return { type: 'role', role, literal: selector || null, ...(local ? { span: local.span, source: local.source } : {}), outsideRole: selector ? ledgerRequestedRole(text.replace(selector, ' ')) : role };
  if (selector) {
    const kind = local && local.source !== 'subject' && ledgerAccountKindSelector(selector);
    return kind && wholeOwnerRequest ? { type: 'account', accountKind: kind } : { type: 'unresolved', literal: selector, ...(local ? { span: local.span, source: local.source } : {}) };
  }
  const accountKind = intent.accountKind || intent.preferredAccountKind;
  if (intent.mask || accountKind && wholeOwnerRequest) return { type: 'account', mask: intent.mask, accountKind };
  return { type: wholeOwnerRequest ? 'owner' : 'unresolved' };
}
export function ledgerRequestedRole(text) {
  const roles = [...new Set(ledgerRoleSpans(text).map(([a, b]) => roleNames[text.slice(a, b).toLowerCase()]))];
  return roles.length === 1 ? roles[0] : null;
}
export function ledgerAccountKindSelector(literal) {
  const wanted = key(literal);
  return /^(?:(?:credit|debit) )?cards?$/.test(wanted) ? 'card'
    : /^(checking|savings|loan|investment|retirement|escrow)$/.exec(wanted)?.[1] || null;
}
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
export function resolveLedgerScope(inventory, literal) {
  const wanted = key(clean(literal));
  const accountKind = ledgerAccountKindSelector(literal);
  if (accountKind) return inventory.filter(a => a.members.every(m => m.account_kind === accountKind));
  const typed = ledgerRoleSelector(literal);
  if (typed) {
    const accounts = inventory.filter(a => a.members.every(m => typed.role === 'business'
      ? m.entity_kind === 'business' : ['person', 'household'].includes(m.entity_kind)));
    return typed.refinement ? resolveLedgerScope(accounts, typed.refinement) : accounts;
  }
  const entities = inventory.filter(a => a.members.every(m => key(m.entity_label) === wanted));
  if (entities.length) return new Set(entities.map(a => a.entity_slug)).size === 1 ? entities : [];
  const accounts = inventory.filter(a => a.members.every(m => key(m.label) === wanted || /^\d{1,4}$/.test(wanted) && m.mask === wanted));
  return accounts.length === 1 ? accounts : [];
}
export function ledgerUnknownScopeAccounts(inventory, uncertainAccounts = []) {
  return [...inventory.filter(account =>
    !account.members.every(member => member.basis_state === 'confirmed' && ['business', 'person', 'household'].includes(member.entity_kind))), ...uncertainAccounts];
}
export function resolveLedgerOperationScope(inventory, intent, cardRoles = [], uncertainAccounts = [], resolveAccount = null) {
  // Bare roles select confirmed entity kinds, even when a feed label happens
  // to contain the same word. A transfer plan retains both typed endpoints.
  const restriction = intent.scopeRestriction || ledgerAdmittedRestriction('', intent);
  const selector = key(restriction.literal || intent.modelAccountScope || intent.accountSelector);
  if (restriction.invalid) return { type: 'unresolved', role: null, accounts: [], excludedAccounts: [] };
  const hasRole = (account, role) => !role || account.members.every(m => role === 'business' ? m.entity_kind === 'business' : ['person', 'household'].includes(m.entity_kind));
  if (restriction.type === 'account' && restriction.literal) {
    const identity = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const matches = inventory.filter(a => a.members.every(m => identity(m.label) === identity(restriction.literal)) && hasRole(a, restriction.outsideRole));
    return { type: 'account', role: null, accounts: matches.length === 1 ? matches : [], excludedAccounts: [] };
  }
  if (restriction.type === 'account') return { type: 'account', role: null,
    accounts: inventory.filter(a => (!restriction.mask || a.mask === restriction.mask) &&
      (!restriction.accountKind || a.members.every(m => m.account_kind === restriction.accountKind))), excludedAccounts: [] };
  const typed = ledgerRoleSelector(selector);
  if (selector && (!typed || typed.refinement)) {
    const entities = inventory.filter(a => a.members.every(m => key(m.entity_label) === selector));
    if (entities.length) return { type: 'entity', role: null,
      accounts: new Set(entities.map(a => a.entity_slug)).size === 1 &&
        (!intent.accountKind || entities.every(a => a.members.every(m => m.account_kind === intent.accountKind)))
        ? entities.filter(a => hasRole(a, restriction.outsideRole)) : [], excludedAccounts: [] };
  }
  const roleSelector = cardRoles.length === 1 ? cardRoles[0] : intent.requestedRole || typed?.role;
  const role = intent.scopePlan?.type === 'transfer' ? null
    : ['business', 'personal'].includes(roleSelector) ? roleSelector : intent.entityKind || null;
  if (!role) {
    if (intent.scopePlan) return { type: 'account', role: null, accounts: inventory, excludedAccounts: [] };
    if (selector) {
      // Resolve exact confirmed entity identities before any display-label
      // rewrite. A name that does not resolve grants no account authority.
      const exact = resolveLedgerScope(inventory, restriction.literal || selector);
      const accounts = exact.length ? exact : resolveAccount?.(inventory, restriction.literal || selector) || [];
      const entity = accounts.length > 0 && accounts.every(a => a.members.every(m => key(m.entity_label) === selector));
      return { type: entity ? 'entity' : accounts.length ? 'account' : 'unresolved', role: null, accounts, excludedAccounts: [] };
    }
    return { type: restriction.type, role: null, accounts: ['owner', 'account'].includes(restriction.type) ? inventory : [], excludedAccounts: [] };
  }
  const accounts = resolveLedgerScope(inventory, role);
  // Entity membership and account identity are separate confirmations. A
  // proposed account cannot invalidate or join its confirmed role peers.
  const confirmedAccounts = accounts.filter(account => account.members.every(member => member.basis_state === 'confirmed'));
  const excludedAccounts = ledgerUnknownScopeAccounts(inventory, uncertainAccounts);
  const refinement = typed ? typed.refinement : selector || null;
  return { type: 'role', role, accounts: confirmedAccounts, excludedAccounts, refinement, conflictingRole: Boolean(typed && typed.role !== role) };
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
