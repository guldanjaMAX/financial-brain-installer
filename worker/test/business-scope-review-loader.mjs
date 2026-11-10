import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
const moduleUrl = (source, base) => `data:text/javascript;base64,${Buffer.from(source
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, base).href}${q}`)).toString('base64')}`;
const mutations = {
  R1: ['ledger-intent-scope.js',
    'const roleSelector = cardRoles.length === 1 ? cardRoles[0] : intent.requestedRole || typed?.role;',
    "const roleSelector = cardRoles.length === 1 ? cardRoles[0] : ['business', 'personal'].includes(selector) ? selector : null;"],
  R2: ['ledger-answer.js',
    'if (operationScope.role) {\n        // A role is typed authority',
    'if (false && operationScope.role) {\n        // A role is typed authority'],
  R3: ['ledger-answer.js',
    'if (operationScope.role) operationScope.excludedAccounts.push(...await readUncertainScopeAccounts(env));',
    'if (false && operationScope.role) operationScope.excludedAccounts.push(...await readUncertainScopeAccounts(env));'],
  R4: ['ledger-answer.js',
    'const scopeExclusions = scopeExclusionRecords(ledgerUnknownScopeAccounts(inventory, await readUncertainScopeAccounts(env)));',
    'const scopeExclusions = [];'],
};
const mutant = process.env.BUSINESS_SCOPE_REVIEW_MUTANT;
let source = readFileSync(answerUrl, 'utf8');
if (mutant) {
  assert.ok(mutations[mutant], 'known finding mutation');
  const [file, before, after] = mutations[mutant];
  const targetUrl = new URL(file, answerUrl);
  const target = readFileSync(targetUrl, 'utf8');
  assert.equal(target.split(before).length - 1, 1, 'one finding mutation site');
  const changed = target.replace(before, after);
  source = file === 'ledger-answer.js' ? changed
    : source.replace(`"./${file}"`, JSON.stringify(moduleUrl(changed, targetUrl)));
}
export const { withLedgerAnswer } = await import(moduleUrl(source, answerUrl));
