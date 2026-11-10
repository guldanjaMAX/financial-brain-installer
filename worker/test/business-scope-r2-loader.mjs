import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
const moduleUrl = (source, base) => `data:text/javascript;base64,${Buffer.from(source
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, base).href}${q}`)).toString('base64')}`;
const mutations = {
  B1: ['ledger-intent-scope.js', 'const accounts = exact.length ? exact : resolveAccount?.(inventory, restriction.literal || selector) || [];', 'const accounts = inventory;'],
  B2: ['ledger-intent-scope.js', "if (restriction.type === 'account' && restriction.literal) {", "if (false && restriction.type === 'account' && restriction.literal) {"],
  M1: ['ledger-answer.js', 'if (scopeExclusions.length) {', 'if (false && scopeExclusions.length) {'],
  m1: ['ledger-intent.js', "const roleSpans = raw.intents[index]?.kind === 'transfers' ? [] : ledgerRoleSpans(temporal);", 'const roleSpans = [];'],
};
const mutant = process.env.BUSINESS_SCOPE_R2_MUTANT;
let source = readFileSync(answerUrl, 'utf8');
if (mutant) {
  assert.ok(mutations[mutant], 'known round-two finding mutation');
  const [file, before, after] = mutations[mutant];
  const targetUrl = new URL(file, answerUrl);
  const target = readFileSync(targetUrl, 'utf8');
  assert.equal(target.split(before).length - 1, 1, 'one reached finding mutation site');
  const changed = target.replace(before, after);
  source = file === 'ledger-answer.js' ? changed
    : source.replace(`"./${file}"`, JSON.stringify(moduleUrl(changed, targetUrl)));
}
export const { withLedgerAnswer } = await import(moduleUrl(source, answerUrl));
