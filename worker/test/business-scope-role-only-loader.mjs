import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
const moduleUrl = (source, base) => `data:text/javascript;base64,${Buffer.from(source
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, base).href}${q}`)).toString('base64')}`;
const mutations = {
  'selector-role-restriction': ['ledger-answer-role.js', 'ledgerRoleSelectorOverlap(decision.intents, decision.vendorLiterals)', 'false'],
  'base-bypass': ['ledger-answer.js', "if (roleCategoryCandidate && shape.roles.length !== 1) return withHeadLedgerAnswer(options, next);", "if (shape.type !== 'pure') return withRoleLedgerAnswer(options, next, () => withHeadLedgerAnswer(options, next));"],
  'purity-bypass': ['ledger-answer.js', "if (roleCategoryCandidate && shape.roles.length !== 1) return withHeadLedgerAnswer(options, next);", "if (shape.type !== 'pure') return withRoleLedgerAnswer({ ...options, roleOnlyScope: 'business' }, next, () => withHeadLedgerAnswer(options, next));"],
  'role-widen': ['ledger-intent-scope-role.js', 'const accounts = resolveLedgerScope(inventory, role);', 'const accounts = inventory;'],
  'role-silent': ['ledger-intent-scope-role.js', 'const excludedAccounts = ledgerUnknownScopeAccounts(inventory, uncertainAccounts);', 'const excludedAccounts = [];'],
};
const mutant = process.env.BUSINESS_ROLE_ONLY_MUTANT;
let source = readFileSync(answerUrl, 'utf8');
if (mutant) {
  assert.ok(mutations[mutant], 'known mutation');
  const [file, before, after] = mutations[mutant];
  const targetUrl = new URL(file, answerUrl);
  const target = readFileSync(targetUrl, 'utf8');
  assert.equal(target.split(before).length - 1, 1, 'exactly one mutation site reached');
  const changed = target.replace(before, after);
  if (file === 'ledger-answer.js') source = changed;
  else if (file === 'ledger-answer-role.js') {
    source = source.replace('from "./ledger-answer-role.js"', `from ${JSON.stringify(moduleUrl(changed, targetUrl))}`);
  }
  else {
    const roleAnswerUrl = new URL('ledger-answer-role.js', answerUrl);
    let roleAnswer = readFileSync(roleAnswerUrl, 'utf8');
    if (file === 'ledger-role-boundary.js') {
      source = source.replace('from "./ledger-role-boundary.js"', `from ${JSON.stringify(moduleUrl(changed, targetUrl))}`);
    } else {
      assert.ok(roleAnswer.includes("from \"./ledger-intent-scope-role.js\""), 'role scope dependency reached');
      roleAnswer = roleAnswer.replace('from "./ledger-intent-scope-role.js"', `from ${JSON.stringify(moduleUrl(changed, targetUrl))}`);
      source = source.replace('from "./ledger-answer-role.js"', `from ${JSON.stringify(moduleUrl(roleAnswer, roleAnswerUrl))}`);
    }
  }

  console.log(`mutation_loaded=${mutant}`);
}
// Expose the untouched ordinary handler for focused tests that run without an
// external checkout. The population suite independently pins its source bytes
// and compares the public dispatcher with the archived HEAD graph.
source = source.replace('async function withHeadLedgerAnswer(options, next) {',
  'export async function withHeadLedgerAnswer(options, next) {');
export const { withLedgerAnswer, withHeadLedgerAnswer: headLedgerAnswer } = await import(moduleUrl(source, answerUrl));

// The chain has no lane-specific environment. Reuse the pinned ordinary reader
// through a module URL while keeping the oracle-availability assertion active.
export const headOracleUrl = moduleUrl(`export { headLedgerAnswer as withLedgerAnswer } from ${JSON.stringify(import.meta.url)};`, import.meta.url);
