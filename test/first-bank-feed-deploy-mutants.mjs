// Run alone: each mutant is restored byte-for-byte before the next one.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mutants = [
  ['first-enable allowance', 'brain.mjs', 'if (matches.length === 0) return null;', 'if (matches.length === 0) throw new Error("missing binding mutant");', '^first enable through'],
  ['duplicate refusal', 'brain.mjs', 'matches.length !== 1 || matches[0]?.type', 'matches.length < 1 || matches[0]?.type', '^two bindings'],
  ['different-provider refusal', 'operations/bank-provider-command.mjs', 'if (conflictingSimpleFin || conflictingPrevious)', 'if (false)', '^different binding'],
  ['already-enabled missing-binding refusal', 'operations/bank-provider-command.mjs', 'previous && previous.corpora?.bank_feed?.enabled !== true && state.deployed_provider === "unknown"', 'previous', '^missing binding after'],
  ['exact-fence refusal', 'operations/bank-provider-command.mjs', 'return plan.plan_id === state.transition_ref ? previous : null;', 'return previous;', '^a matching binding cannot hide'],
  ['preview live-binding gate', 'operations/bank-provider-command.mjs', 'if (typeof options.inspectWorkerBankProvider === "function")', 'if (false)', '^initial preview: duplicate binding'],
];
const originals = new Map(mutants.map(([, path]) => [path, readFileSync(new URL('../' + path, import.meta.url))]));
let killed = 0;
try {
  for (const [name, path, before, after, pattern] of mutants) {
    const original = originals.get(path);
    const source = original.toString('utf8');
    assert.equal(source.split(before).length, 2, name + ' mutation must have exactly one target');
    try {
      writeFileSync(new URL('../' + path, import.meta.url), source.replace(before, after));
      const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=' + pattern, 'test/first-bank-feed-deploy.test.mjs'], {
        cwd: root, encoding: 'utf8',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
          BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_TEST_CHAIN: '1' },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, name + ' survived\n' + result.stdout + result.stderr);
      assert.match(result.stdout, /(?:tests 1|# tests 1)/, 'the intended test ran');
      assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|EPERM/);
      killed++;
      console.log('KILLED ' + name);
    } finally {
      writeFileSync(new URL('../' + path, import.meta.url), original);
      assert.deepEqual(readFileSync(new URL('../' + path, import.meta.url)), original);
    }
  }
} finally {
  for (const [path, original] of originals) {
    writeFileSync(new URL('../' + path, import.meta.url), original);
    assert.deepEqual(readFileSync(new URL('../' + path, import.meta.url)), original);
  }
}
console.log('mutants_killed=' + killed + '/' + mutants.length + ' restored=exact');
