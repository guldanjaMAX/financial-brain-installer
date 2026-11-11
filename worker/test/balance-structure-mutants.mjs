import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// Run only against disposable reviewed sources, never mutate the checkout.
const root = process.cwd();
// An optional local wrapper can enforce host scheduling without publishing a
// machine-specific path. The default remains portable to non-POSIX runners.
const quietWrapper = process.argv[3];
const quietSpawn = (command, args, options) => quietWrapper
  // Waiting for host scheduling is outside the test's execution time. Keep a
  // bounded allowance for that wait without treating it as an assertion kill.
  ? spawnSync('/bin/sh', [quietWrapper, command, ...args], { ...options, timeout: 600000 })
  : spawnSync(command, args, options);
const childEnv = { BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_BALANCE_MUTANT: '1' };
for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']) {
  if (process.env[name] !== undefined) childEnv[name] = process.env[name];
}

if (process.env.NODE_COMPILE_CACHE) childEnv.NODE_COMPILE_CACHE = process.env.NODE_COMPILE_CACHE;
const base = process.argv[2];
if (!base) throw new Error('supply disposable base archive directory');
const evidenceRoot = fs.mkdtempSync(path.join(tmpdir(), 'brain-balance-mutation-evidence-'));
console.log(JSON.stringify({ evidence_root: evidenceRoot }));
fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(evidenceRoot, 'balance-mutants-')));
childEnv.HOME = path.join(scratch, 'home-test');
fs.cpSync(base, scratch, { recursive: true, filter: source => !source.includes('node_modules') && !source.endsWith('.log') });
fs.symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), 'junction');
const answer = 'worker/src/lib/ledger-answer.js', reader = 'worker/src/lib/ledger-reader.js';
const compound = 'worker/src/lib/ledger-balance-compound.js';
const modules = [answer, reader, compound, 'worker/src/lib/ledger-analysis.js', 'worker/src/lib/ledger-intent.js', 'worker/src/lib/ledger-clarification.js'];
// Integration proof must execute the complete merged dependency graph, not
// balance modules above older transfer or ownership helpers from the archive.
fs.cpSync(path.join(root, 'worker/src'), path.join(scratch, 'worker/src'), { recursive: true });
for (const file of [...modules, 'worker/test/balance-property-generated.test.mjs', 'worker/test/ledger-balance-compound.test.mjs']) fs.copyFileSync(path.join(root, file), path.join(scratch, file));
// Focus mutations on explicit boundary contracts; the full 640-case finder
// runs separately. Discovery shrinking is not a mutation timeout or a kill.
const testArgs = ['--test', '--test-concurrency=1',
  'worker/test/balance-property-generated.test.mjs', 'worker/test/ledger-balance-compound.test.mjs'];
function mutationArgs(name) {
  let pattern = 'seeded balance properties';
  if (/compound/.test(name)) pattern = 'safe compound: reverse=false fault=missing mixed=false fallback=null';
  if (/incomplete operand/.test(name)) pattern = 'compound measures retain';
  if (/successful operand exclusions/.test(name)) pattern = 'B1 compound broad exclusions';
  if (/third operand/.test(name)) pattern = 'whole-question operands';
  if (/payee literal/.test(name)) pattern = 'literal payee words';
  if (/closed inclusion|closed account summed/.test(name)) pattern = 'closed account is excluded';
  if (/silent pending|pending silently included/.test(name)) pattern = 'pending movements';
  if (/ambiguous single/.test(name)) pattern = 'balance identity 0:';
  if (/candidate list/.test(name)) pattern = 'balance identity 2:';
  if (/status resolves/.test(name)) pattern = 'balance identity 14:';
  if (/exact-only identity/.test(name)) pattern = 'balance identity 6:';
  if (/rank before identity/.test(name)) pattern = 'balance identity 8:';
  if (/empty-open/.test(name)) pattern = 'all-closed balance denominator';
  if (/identity hides link/.test(name)) pattern = 'duplicate ending';
  if (/review R2|review R3/.test(name)) pattern = 'R2/R3 exclusion';
  if (/review R4/.test(name)) pattern = 'R4 safe final';
  if (/empty inventory/.test(name)) pattern = 'no bank accounts exist';
  if (/source qualification/.test(name)) pattern = 'compound source qualification';
  return [...testArgs.slice(0, 2), '--test-name-pattern=' + pattern, ...testArgs.slice(2)];
}
const copied = [];
const inventory = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inventory(file);
    else if (entry.isFile()) copied.push(`${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(scratch, file)}`);
  }
};
inventory(scratch);
fs.writeFileSync(path.join(evidenceRoot, 'copied-source.sha256'), copied.sort().join('\n') + '\n');
const originals = new Map(modules.map(file => [file, fs.readFileSync(path.join(scratch, file), 'utf8')]));
const mutants = [
 ['source qualification bypassed', compound, 'if (/\\b(?:quickbooks|qbo)\\b/i.test(question)) return null;', 'if (false) return null;'],
 ['empty inventory hijacks document routing', answer, 'compound = inventory.length ? compoundPlan', 'compound = true ? compoundPlan'],
 ['compound balance refusal falls through', answer, 'if (compound) return Response.json', 'if (false && compound) return Response.json'],
 ['compound falsely supported', compound, 'supported: false, complete: false, partial: true', 'supported: true, complete: false, partial: true'],
 ['compound successful operand exclusions lost', answer, 'exclusions: balanceExclusionLines(intent)', 'exclusions: []'],
 ['third operand omitted', compound, 'return clauses.map(clause => {', 'return clauses.slice(0, 2).map(clause => {'],
 ['incomplete operand figures leak', compound, 'if (complete) {', 'if (part.ledger) {'],
 ['payee literal becomes operand', compound, '...intents.map(intent => intent.match).filter(Boolean)', '...[]'],
 ['closed inclusion', answer, "accounts: direct ? accounts : accounts.filter(account => account.status === 'open')", 'accounts'],
 ['silent pending', answer, "...(relevant.length ? ['Pending after", "...(false ? ['Pending after"],
 ['ambiguous single selection', answer, 'const disputed = accounts.filter', 'if (intent.mask && accounts.length > 1) accounts = accounts.slice(0, 1);\n      const disputed = accounts.filter'],
 ['nickname gate bypass (expected refusal)', 'worker/src/lib/ledger-intent.js', 'if (!(cue.test(question)', 'if (!(true || cue.test(question)'],
 ['changed cents', answer, 'current_minor: row.current_minor, as_of:', 'current_minor: row.current_minor + 1, as_of:'],
 ['oldest snapshot', reader, 'ORDER BY b.as_of_date DESC', 'ORDER BY b.as_of_date ASC'],
 ['debt in cash', answer, "balanceGroup(account) === 'cash' && account.status === 'open');", "['cash', 'liability'].includes(balanceGroup(account)) && account.status === 'open');"],
 ['false final completeness', 'worker/src/lib/ledger-clarification.js', 'complete: false, partial: true,', 'complete: true, partial: false,'],
 ['closed account summed', answer, "const cashTotal = intent.cashOnlyBalance && cashAccounts.length ? sumMinor(cashAccounts, entry => entry.row.current_minor) : null;", "const cashTotal = intent.cashOnlyBalance && cashAccounts.length ? sumMinor(cashAccounts, entry => entry.row.current_minor) + sumMinor(await readEffectiveBalances(env, inventory, { ...intent, mask: null, accountKind: null, effectiveAccountSlugs: inventory.filter(account => account.status === 'closed').map(account => account.account_slug) }), row => row.current_minor) : null;"],
 ['pending silently included', answer, 'sumMinor(cashAccounts, entry => entry.row.current_minor) : null;', 'sumMinor(cashAccounts, entry => entry.row.current_minor) - plan.record.pending.outflow_minor + plan.record.pending.inflow_minor : null;'],
 ['status resolves identity', answer, "if (ambiguous && (", "if (false && ambiguous && ("],
 ['exact-only identity gate', answer, "accountSelectorRank(account, intent.accountSelector) > 0", 'accountSelectorRank(account, intent.accountSelector) === 2'],
 ['empty-open exclusions lost', answer, "intent.kind === 'balance' ? balanceExclusionLines(intent) : []", "intent.kind === 'balance' && reason !== 'no_accounts' ? balanceExclusionLines(intent) : []"],
 ['identity hides link review', answer, "disputed.length ? 'ledger_account_link_required' : balanceScope?.reason || (", "balanceScope?.reason || (disputed.length ? 'ledger_account_link_required' : "],
 ['candidate list certifies one selection', answer, 'selection_complete: !intent.balanceSelectionAmbiguous', 'selection_complete: true'],
 ['review R1 rank before identity', answer, "Boolean(intent.modelAccountScope), intent.kind === 'balance');", 'Boolean(intent.modelAccountScope));'],
 ['review R2 never-connected exclusion lost', answer, "accounts.filter(account => account.status !== 'open')", "accounts.filter(account => account.status === 'closed')"],
 ['review R3 refusal exclusions lost', answer, "intent.kind === 'balance' ? balanceExclusionLines(intent) : []", "intent.kind === 'balance' && reason === 'no_accounts' ? balanceExclusionLines(intent) : []"],
 ['review R4 intermediate overflow', 'worker/src/lib/ledger-analysis.js', `let total = 0n;
  for (const row of rows) {
    const value = get(row);
    if (!Number.isSafeInteger(value)) throw new Error("ledger total overflow");
    total += BigInt(value);
  }
  const result = Number(total);
  if (!Number.isSafeInteger(result)) throw new Error("ledger total overflow");
  return result;`, `let total = 0;
  for (const row of rows) {
    total += get(row);
    if (!Number.isSafeInteger(total)) throw new Error("ledger total overflow");
  }
  return total;`],
];
const results = [];
// A broken archive or uniformly red harness is not mutation evidence.
const control = quietSpawn(process.execPath, testArgs, {
  cwd: scratch, env: childEnv, encoding: 'utf8', timeout: 180000 });
if (control.status !== 0) throw new Error('unmutated control failed: ' + control.stdout + control.stderr);
console.log(JSON.stringify({ control: 'green', exit: control.status }));
for (const [name, file, before, after] of mutants) {
  const original = originals.get(file);
  if (!original.includes(before)) throw new Error('mutation missing: ' + name);
  try {
    fs.writeFileSync(path.join(scratch, file), original.replace(before, after));
    let run = quietSpawn(process.execPath, mutationArgs(name), { cwd: scratch, env: childEnv, encoding: 'utf8', timeout: 180000 });
    // A surviving focused probe retries the complete green control contract.
    if (run.status === 0) run = quietSpawn(process.execPath, testArgs, { cwd: scratch, env: childEnv, encoding: 'utf8', timeout: 180000 });
    const output = run.stdout + run.stderr;
    const killed = run.status === 1 && /AssertionError/.test(output);
    results.push({ name, killed, exit: run.status, ...(run.error ? { error_code: run.error.code } : {}) });
    console.log(JSON.stringify(results.at(-1)));
    fs.writeFileSync(path.join(evidenceRoot, `mutant-${results.length}.log`), output);
  } finally { fs.writeFileSync(path.join(scratch, file), original); }
  if (fs.readFileSync(path.join(scratch, file), 'utf8') !== original) throw new Error('mutant not restored: ' + name);
}
fs.writeFileSync(path.join(evidenceRoot, 'mutant-results.json'), JSON.stringify(results, null, 2));
const restored = [...originals].map(([file, original]) => ({ file,
  restored: fs.readFileSync(path.join(scratch, file), 'utf8') === original,
  matches_checkout: fs.readFileSync(path.join(root, file), 'utf8') === original }));
for (const file of ['worker/test/balance-property-generated.test.mjs', 'worker/test/ledger-balance-compound.test.mjs']) restored.push({ file, matches_checkout:
  fs.readFileSync(path.join(scratch, file), 'utf8') ===
  fs.readFileSync(path.join(root, file), 'utf8') });
fs.writeFileSync(path.join(evidenceRoot, 'restoration.json'), JSON.stringify(restored, null, 2));
if (restored.some(row => row.restored === false || !row.matches_checkout)) throw new Error('restoration readback failed');
if (results.some(result => !result.killed)) process.exitCode = 1;
