import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const answer = new URL('../src/lib/ledger-answer.js', import.meta.url);
const analysis = new URL('../src/lib/ledger-analysis.js', import.meta.url);
const reader = new URL('../src/lib/ledger-reader.js', import.meta.url);
const env = { BRAIN_NO_WRANGLER_LOGIN: '1', ...Object.fromEntries(
  ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) };
const mutants = [
  ['primary +1 cent', answer, 'const combined = sumMinor(totals, account => account.credits_minor);', 'const combined = 1 + sumMinor(totals, account => account.credits_minor);'],
  ['rendering +1 cent', answer, 'Combined recorded inflow: ${money(combined)}', 'Combined recorded inflow: ${money(combined + 1)}'],
  ['pending admission', reader, 't.pending=${pendingOnly ? 1 : 0}', 't.pending IN (0,1)'],
  ['spending-transfer exclusion', answer, "const ordinary = membership.ordinary.filter(row => row.direction === \"outflow\" && !payments.has(row.id) &&\n    !['loan', 'line_of_credit'].includes(bySlug.get(row.effective_account_slug)?.account_kind));", 'const ordinary = outflows;'],
  ['unpaired owned leg counted', analysis, "excluded.set(row.id, { kind: advances", "false && excluded.set(row.id, { kind: advances"],
  ['loan counterpart counted twice', analysis, "if (movement) for (const row of [pair.out, pair.in])", "if (movement && movement.kind !== 'owned_liability_payment') for (const row of [pair.out, pair.in])"],
  ['closed account counted after closing', reader, "t.posted_on<=json_extract(m.value,'$.closed_on')", '1=1'],
];
let killed = 0;
for (const [name, path, before, after] of mutants) {
  const original = readFileSync(path, 'utf8');
  if (!original.includes(before)) throw Error(`missing mutation site: ${name}`);
  try {
    let changed = original.replace(before, after);
    // Remove the independent unary proof too, so the loan mutant admits its counterpart.
    if (name === 'loan counterpart counted twice') changed = changed.replace("if (!other || other === source", "if (['loan','line_of_credit'].includes(source.account_kind) || !other || other === source");
    writeFileSync(path, changed);
    const run = spawnSync(process.execPath, ['worker/test/money_inout_property_finder_generated.test.mjs'], { encoding: 'utf8', timeout: 120000, env, windowsHide: true });
    if (run.status === 0 || run.error) throw Error(`survived: ${name}`);
    const receipt = /FINDER_RECEIPT (.+)/.exec(run.stdout);
    if (!receipt || JSON.parse(receipt[1]).wrong_figures < 1) throw Error(`unrelated failure: ${name}`);
    killed++; console.log(`KILLED ${name}`);
  } finally { writeFileSync(path, original); }
}
console.log(`mutants_killed=${killed}/${mutants.length}`);
