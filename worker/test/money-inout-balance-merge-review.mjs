import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_BALANCE_REF = 'partner/FIX-0427-BALANCE-STRUCT';
const MODULES = ['worker/src/lib/ledger-answer.js', 'worker/src/lib/ledger-reader.js'];
const TEST = 'worker/test/balance-property-generated.test.mjs';

// Manual cross-lane gate: Git only reads revisions or emits a merge to stdout.
// All module replacement and synthetic SQLite work stay in system temp.
export function reviewMoneyBalanceMerge({ root = ROOT, balanceRef = DEFAULT_BALANCE_REF,
  spawn = spawnSync, node = process.execPath } = {}) {
  assert.match(balanceRef, /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/);
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const git = args => {
    const result = spawn('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true,
      maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, 'read-only Git operation must succeed');
    return result.stdout;
  };
  const base = git(['merge-base', 'HEAD', balanceRef]).trim();
  const temp = resolve(tmpdir());
  const sandbox = mkdtempSync(join(temp, 'money-balance-review-'));
  try {
    for (const directory of ['worker/src', 'migrations/d1'])
      cpSync(join(root, directory), join(sandbox, directory), { recursive: true });
    for (const file of ['worker/test/ledger-review-fixture.mjs', 'eval/fast-loop/money-oracle.mjs']) {
      mkdirSync(dirname(join(sandbox, file)), { recursive: true });
      cpSync(join(root, file), join(sandbox, file));
    }
    writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(sandbox, TEST), git(['show', `${balanceRef}:${TEST}`]));
    const combined = new Map();
    for (const [index, file] of MODULES.entries()) {
      const inputs = ['ours', 'base', 'theirs'].map(label => join(sandbox, `${index}-${label}`));
      writeFileSync(inputs[0], readFileSync(join(root, file)));
      writeFileSync(inputs[1], git(['show', `${base}:${file}`]));
      const balance = git(['show', `${balanceRef}:${file}`]);
      writeFileSync(inputs[2], balance);
      combined.set(file, git(['merge-file', '-p', ...inputs]));
      writeFileSync(join(sandbox, file), balance);
    }
    const run = () => {
      const result = spawn(node, [TEST], { cwd: sandbox, env, encoding: 'utf8', windowsHide: true,
        timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const output = (result.stdout || '') + (result.stderr || '');
      return { status: result.status, passed: Number(/(?:ℹ|#) pass (\d+)/u.exec(output)?.[1]),
        total: Number(/(?:ℹ|#) tests (\d+)/u.exec(output)?.[1]),
        output: output.replaceAll(sandbox, '<system-temp>').replaceAll(sandbox.replaceAll('\\', '/'), '<system-temp>') };
    };
    const balance = run();
    assert.equal(balance.status, 0, 'the balance lane alone must pass before attributing a merge regression');
    for (const [file, content] of combined) writeFileSync(join(sandbox, file), content);
    return { balance, combined: run() };
  } finally {
    // Only remove the freshly created child of the verified system temp root.
    assert.equal(dirname(resolve(sandbox)), temp);
    assert.ok(basename(sandbox).startsWith('money-balance-review-'));
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 1, 'usage: node worker/test/money-inout-balance-merge-review.mjs [balance-ref]');
  const result = reviewMoneyBalanceMerge({ balanceRef: args[0] || DEFAULT_BALANCE_REF });
  console.log(JSON.stringify({ balance: `${result.balance.passed}/${result.balance.total}`,
    combined: `${result.combined.passed}/${result.combined.total}` }));
  if (result.combined.status !== 0) console.error(result.combined.output.trimEnd().split(/\r?\n/).slice(-40).join('\n'));
  process.exitCode = result.combined.status ?? 1;
}
