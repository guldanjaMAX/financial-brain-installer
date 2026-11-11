import { ledgerRoleSelector } from './ledger-intent-scope-role.js';
import { localLedgerWindow } from './ledger-intent.js';
import { ownerLedgerDay } from './ledger-question.js';

// Only the grammar's punctuation is ignorable. Keep every other character as
// a token, including a hyphen outside a word, so normalization cannot hide it.
const tokenPattern = /[\p{L}\p{N}]+|(?<![\p{L}\p{N}])-|-(?![\p{L}\p{N}])|[^\p{L}\p{N}\s?.,'-]/gu;
const tokensOf = value => [...String(value || '').matchAll(tokenPattern)];
const wordToken = value => /^[\p{L}\p{N}]+$/u.test(value);
const words = value => tokensOf(value).map(([token]) => wordToken(token) ? token.normalize('NFKC').toLowerCase() : token).join(' ');
// Completeness is a proof of full consumption, never the absence of a known
// complement. Provider selectors still authorize the role independently.
export function ledgerAccountComplementAdmission(question, intents = [], { now = Date.now(), timeZone = null } = {}) {
  const result = { type: 'account-complement', complete: false, detected: false, complements: [], remainder: words(question).split(' ').filter(Boolean) };
  if (typeof question !== 'string') return result;
  const text = words(question);
  const lead = '(?:please )?(?:(?:what was|what did(?: the)?|how much did(?: the)?|show(?: me)?|tell me|(?:could|can) you (?:show|retrieve)|retrieve) )?';
  const subject = '(?:(?:my|our) )?(business|personal|company|household|biz)(?: accounts?)?';
  const measure = '(?:spending|spend|expenses|money out|money in|income|deposits)';
  const category = intents.length === 1 && intents[0].kind === 'category' && ALLOWED_PURE_SELECTORS.includes('category')
    ? words(intents[0].match) : '';
  // Only an admitted category can occupy this slot. Escape literal tokens so
  // category punctuation cannot change the grammar or consume another slot.
  const literal = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reading = literal ? `(?:${literal} ${measure}|${measure} (?:(?:in|on|for|at) )?${literal})` : measure;
  const core = new RegExp(`^${lead}${subject} ${reading} (.+)$`).exec(text);
  if (core) {
    // Use the same tokens for offsets and grammar, retaining raw symbols before
    // compatibility normalization can turn them into permitted punctuation.
    const raw = question.replace(/[\p{L}\p{N}]+/gu, token => token.normalize('NFKC')).toLowerCase();
    const tokens = tokensOf(raw);
    const period = raw.slice(tokens[tokens.length - core[2].split(' ').length].index);
    const today = ownerLedgerDay(now, timeZone)?.day;
    const window = today && localLedgerWindow(period, today);
    if (window && !window.invalid && window.consumed?.length) {
      // Calendar admission also records financial lexical spans such as
      // "after fees". Only independently parsed calendar atoms can consume
      // this slot; those financial spans must remain leftover tokens.
      const spans = window.consumed.filter(([start, end]) => {
        const atom = localLedgerWindow(period.slice(start, end), today);
        return atom && !atom.invalid && atom.consumed?.length &&
          tokensOf(period.slice(start, end)).every(([token]) => wordToken(token));
      });
      const residue = period.split('').map((ch, i) => spans.some(([a, b]) => i >= a && i < b) ? ' ' : ch).join('');
      // Even an admitted category literal cannot consume a forbidden symbol.
      const prefixSymbols = tokens.filter(token => token.index < raw.length - period.length && !wordToken(token[0]));
      result.remainder = [...prefixSymbols.map(([token]) => token), ...words(residue).split(' ').filter(Boolean)];
      if (spans.length && result.remainder.length === 0) result.complete = true;
    }
  }
  result.detected = !result.complete && result.remainder.length > 0;
  if (result.detected) result.complements.push({ type: 'unconsumed', literal: result.remainder.join(' ') });
  return result;
}
// Share canonical aliases with the confirmed-membership resolver. Literal
// labels are checked separately before any role can authorize a reading.
export function ledgerQuestionRoles(question) {
  return [...new Set(words(question).split(' ').map(word => ledgerRoleSelector(word)?.role).filter(Boolean))];
}
export function ledgerRoleQuestionShape(question, context = {}) {
  const roles = ledgerQuestionRoles(question);
  const admission = ledgerAccountComplementAdmission(question, [], context);
  return { type: admission.complete && roles.length === 1 ? 'candidate' : 'base', roles };
}

// Role hints can name the standalone scope. Every other admitted literal owns
// its words before role binding, including financial nouns in a payee label.
export function ledgerRoleSelectorOverlap(intents, vendorLiterals = []) {
  return vendorLiterals.some(literal => ledgerQuestionRoles(literal).length) || intents.some(intent => {
    const payees = [intent.match, intent.protectedPayee, intent.counterpartyText, intent.descriptionKeyword];
    if (payees.some(literal => ledgerQuestionRoles(literal).length)) return true;
    return [intent.modelAccountScope, intent.accountSelector].some(literal => {
      if (!ledgerQuestionRoles(literal).length) return false;
      const scope = words(literal).replace(/^(?:my|our|the) /, '').replace(/ accounts?$/, '');
      const role = ledgerRoleSelector(scope);
      return !role || Boolean(role.refinement);
    });
  });
}

// This is the only policy switch. Removing category restores ordinary HEAD
// behavior for every role/category question without changing role membership.
export const ALLOWED_PURE_SELECTORS = Object.freeze(['role', 'category']);

export function ledgerCanonicalRoleHint(value) {
  // Punctuation and extra identifier words are identity data. The role
  // contract permits only whole standalone aliases and neutral owner framing.
  const hint = String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const canonical = /^(?:(?:all|each|every)(?: of)? )?(?:(?:my|our|the) )?(business|biz|company|personal|household)(?: accounts?)?$/.exec(hint);
  return canonical ? ledgerRoleSelector(canonical[1]).role : null;
}

// The generic grammar represents a canonical role in its accountSelector slot.
// Admit that enum as a role before binding; every non-role identifier retains
// the original object and therefore the late-binding account guard.
export function ledgerGrammarRoleIntent(intent) {
  const role = ledgerCanonicalRoleHint(intent.accountSelector);
  if (!role) return intent;
  const { accountSelector, ...reading } = intent;
  return { ...reading, requestedRole: role };
}

// Inspect identity fields independently of category text. A category literal
// and an account hint may have identical bytes and still be two restrictions.
export function ledgerPureRole(intents, admittedSelectors = []) {
  if (!intents?.length) return null;
  const selectors = [...admittedSelectors];
  for (const intent of intents) {
    const role = intent.requestedRole || intent.entityKind;
    if (role) selectors.push({ type: 'role', role: ledgerCanonicalRoleHint(role) });
    for (const literal of [intent.modelAccountScope]) {
      if (!literal) continue;
      const role = ledgerCanonicalRoleHint(literal);
      selectors.push(role ? { type: 'role', role } : { type: 'account', literal });
    }
    if (intent.amountMinor !== null && intent.amountMinor !== undefined) selectors.push({ type: 'amount' });
    const restriction = intent.scopeRestriction;
    if (restriction && restriction.type !== 'owner') {
      // The balance grammar may retain the grammatical link before its
      // measure (business accounts and their balances). Wire account hints
      // remain independently checked, including those exact same bytes.
      const literal = restriction.source === 'balance'
        ? restriction.literal?.replace(/ accounts? and their$/i, ' accounts') : restriction.literal;
      const role = restriction.type === 'role' && ledgerCanonicalRoleHint(literal || restriction.role);
      selectors.push(role ? { type: 'role', role } : { type: 'account', literal: restriction.literal });
    }
    if (intent.kind === 'category' && intent.match) selectors.push({ type: 'category', literal: intent.match });
    else if (intent.match) selectors.push({ type: 'payee', literal: intent.match });
    for (const field of ['accountSelector', 'mask', 'accountKind', 'preferredAccountKind', 'protectedPayee', 'counterpartyText',
      'descriptionKeyword', 'recurringSelector', 'amountText', 'entityLabel', 'scopePlan', 'transferSourceSlugs', 'transferDestinationSlugs']) {
      if (intent[field]) selectors.push({ type: field, literal: intent[field] });
    }
  }
  const roles = [...new Set(selectors.filter(s => s.type === 'role').map(s => s.role))];
  if (roles.length !== 1 || !['business', 'personal'].includes(roles[0])) return null;
  if (selectors.some(selector => !ALLOWED_PURE_SELECTORS.includes(selector.type))) return null;
  return roles[0];
}

// Text can only veto a selector-admitted reading. Consume a category solely
// for that veto, after selectors have independently passed the policy gate.
export function ledgerRoleCategoryShape(question, intents, context = {}, admittedSelectors = []) {
  if (!ledgerPureRole(intents, admittedSelectors)) return null;
  if (intents?.length !== 1 || intents[0].kind !== 'category') return null;
  const admission = ledgerAccountComplementAdmission(question, intents, context);
  const roles = ledgerQuestionRoles(question);
  return admission.complete && roles.length === 1 ? { type: 'candidate', roles } : null;
}
