import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../src/lib/', import.meta.url);
const source = name => readFileSync(new URL(name, root), 'utf8');
const moduleUrl = (text, base) => `data:text/javascript;base64,${Buffer.from(text.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
  (_, q, path) => `from ${q}${new URL(path, base).href}${q}`)).toString('base64')}`;
const mutations = {
  's7-expense-widen': ['answer', 'const ordinary = membership.ordinary.filter(row => row.direction === "outflow" && !payments.has(row.id) &&', 'const ordinary = outflows.filter(row => !payments.has(row.id) &&'],
  's7-inflow-widen': ['answer', 'const ownRows = membership.ordinary.filter(row => row.effective_account_slug === account.account_slug);', 'const ownRows = rows.filter(row => row.effective_account_slug === account.account_slug);'],
  'closed-default-true': ['boundary', "complete: false, detected: false", "complete: true, detected: false"],
  'closed-ignore-one': ['boundary', "const period = raw.slice(tokens[tokens.length - core[2].split(' ').length].index);", "const period = raw.slice(tokens[tokens.length - core[2].split(' ').length].index).replace(/^(last month) \\S+$/, '$1');"],
  'closed-ignore-tail': ['boundary', "const period = raw.slice(tokens[tokens.length - core[2].split(' ').length].index);", "const period = raw.slice(tokens[tokens.length - core[2].split(' ').length].index).replace(/^(last month) .+$/, '$1');"],
  'closed-possessive-label': ['boundary', 'const text = words(question);', "const text = words(question).replace(/ in my [\\p{L}\\p{N} ]+?(?= last month\\b)/gu, '');"],
  'closed-role-label': ['boundary', 'const text = words(question);', "const text = words(question).replace(/ in my (?:business|personal|company|household|biz) [\\p{L}\\p{N} ]+?(?= last month\\b)/gu, '');"],
  'complement-detector-removed': ['answer', 'if (!accountComplement.complete || accountComplement.detected) return ordinaryAnswer();', 'if (false) return ordinaryAnswer();'],
  'complement-possessive-dropped': ['boundary', 'if (!match[2] && !/^(in|on)$/i.test(match[1])) continue;', 'if (match[2] || !/^(in|on)$/i.test(match[1])) continue;'],
  'complement-mask-dropped': ['boundary', 'text.matchAll(mask)', 'text.matchAll(/(?!)/g)'],
  'complement-incomplete-ignored': ['answer', '!accountComplement.complete || accountComplement.detected', 'accountComplement.detected'],
  'complement-linebreak-dropped': ['boundary', '([^?!;]+?)', '([^\\r\\n?!;]+?)'],
  'account-hint-dropped': ['boundary', "if (selectors.some(selector => !ALLOWED_PURE_SELECTORS.includes(selector.type))) return null;", "if (selectors.filter(selector => selector.type !== 'account').some(selector => !ALLOWED_PURE_SELECTORS.includes(selector.type))) return null;"],
  'text-establishes': ['boundary', 'if (!intents?.length) return null;', "if (!intents?.length) return null; const textRoles = ledgerQuestionRoles(intents.map(i => i.match || '').join(' ')); if (textRoles.length === 1) return textRoles[0];"],
  'binding-clears-account': ['answer', 'if (ledgerPureRole([{ ...intent, requestedRole: role }]) !== role) return false;', 'intent.modelAccountScope = null; intent.accountSelector = null; if (ledgerPureRole([{ ...intent, requestedRole: role }]) !== role) return false;'],
  'constant-allows-account': ['boundary', "Object.freeze(['role', 'category'])", "Object.freeze(['role', 'category', 'account'])"],
  'category-erases-selector': ['boundary', 'if (!literal) continue;', "if (!literal || literal === intent.match && intent.kind === 'category') continue;"],
  'fallback-ignored': ['boundary', '!ALLOWED_PURE_SELECTORS.includes(selector.type)', "!(selector.type === 'category' || ALLOWED_PURE_SELECTORS.includes(selector.type))"],
};
const mutant = process.env.BUSINESS_SELECTOR_MUTANT;
function graph(fallback = false) {
  const texts = { boundary: source('ledger-role-boundary.js'), intent: source('ledger-intent-role.js'),
    answer: source('ledger-answer-role.js'), entry: source('ledger-answer.js') };
  if (fallback) {
    const from = "Object.freeze(['role', 'category'])";
    assert.equal(texts.boundary.split(from).length - 1, 1, 'one fallback switch site');
    texts.boundary = texts.boundary.replace(from, "Object.freeze(['role'])");
  }
  if (mutant && (!fallback || mutant !== 'constant-allows-account')) {
    assert.ok(mutations[mutant], 'known selector mutation');
    const [file, from, to] = mutations[mutant];
    // The fallback mutation operates on the same gate in both policy modes.
    assert.equal(texts[file].split(from).length - 1, 1, 'exactly one reached mutation site');
    texts[file] = texts[file].replace(from, to);
  }
  // Literal import replacement preserves every unrelated module's real graph.
  const wire = (text, name, url) => text.replaceAll(`from './${name}'`, `from "${url}"`).replaceAll(`from "./${name}"`, `from "${url}"`);
  const boundaryUrl = moduleUrl(texts.boundary, new URL('ledger-role-boundary.js', root));
  const intentUrl = moduleUrl(wire(texts.intent, 'ledger-role-boundary.js', boundaryUrl), new URL('ledger-intent-role.js', root));
  const answerText = wire(wire(texts.answer, 'ledger-role-boundary.js', boundaryUrl), 'ledger-intent-role.js', intentUrl);
  const answerUrl = moduleUrl(answerText, new URL('ledger-answer-role.js', root));
  const entryText = wire(wire(texts.entry, 'ledger-answer-role.js', answerUrl), 'ledger-role-boundary.js', boundaryUrl);
  return { boundaryUrl, answerUrl, entryUrl: moduleUrl(entryText, new URL('ledger-answer.js', root)) };
}
const normal = graph(), fallback = graph(true);
export const boundary = await import(normal.boundaryUrl);
export const { bindPureRole } = await import(normal.answerUrl);
export const { withLedgerAnswer } = await import(normal.entryUrl);
export const { withLedgerAnswer: fallbackAnswer } = await import(fallback.entryUrl);
if (mutant) console.log(`mutation_loaded=${mutant}`);
