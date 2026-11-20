// Synthetic CLI probes. The fake git never delegates to a host git or service.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SMOKE_FILES } from '../../ci/pick-tests.mjs';
const runner = fileURLToPath(new URL('../../scripts/run-test-chain-parallel.mjs', import.meta.url));
const picker = fileURLToPath(new URL('../../ci/pick-tests.mjs', import.meta.url));
const scratch = resolve('.lane-scratch/tool-picker');
const quiet = resolve(process.cwd(), '../..', 'MAC-QUIET');
mkdirSync(scratch, { recursive: true });
function fixture({ failedGit = false } = {}) {
  const root = mkdtempSync(join(scratch, 'cli-'));
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  const commands = [...SMOKE_FILES.map((file) => `node ${file}`), 'node test/unit.test.mjs', 'node test/other.test.mjs'];
  put('scripts/run-test-chain.mjs', `export const TEST_COMMANDS = ${JSON.stringify(commands)};\nexport const parseTestCommand = (command) => ({ kind: 'node', args: command.split(' ').slice(1) });\n`);
  for (const file of SMOKE_FILES) put(file, '// synthetic smoke; no product code\n');
  put('test/unit.test.mjs', "import '../lib/unit.mjs';\n");
  put('test/other.test.mjs', '// green control\n');
  put('lib/unit.mjs', 'export const unit = 1;\n');
  put('bin/launchctl', '#!/bin/sh\nexit 91\n'); chmodSync(join(root, 'bin/launchctl'), 0o700);
  put('bin/git', '');
  put('git-calls.log', '');
  const inventory = [];
  const walk = (dir = '') => { for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const file = dir ? `${dir}/${e.name}` : e.name; if (e.isDirectory()) walk(file); else inventory.push(file);
  } };
  walk();
  // Every invocation is logged, proving the diff decision was reached. Output
  // uses NUL paths, so whitespace and a second command cannot become arguments.
  put('bin/git', `#!/bin/sh\nprintf '%s\\n' "$*" >> git-calls.log\ncase "$*" in\n  *--name-only*4b825dc642cb6eb9a060e54bf8d69288fbee4904*) printf '%s\\000' ${inventory.map((s) => `'${s}'`).join(' ')} ;;\n  *--name-only*) ${failedGit ? 'exit 17' : "printf '%s\\000' lib/unit.mjs"} ;;\n  *rev-parse*) printf '%s\\n' fixture-head ;;\n  *status*) exit 0 ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(join(root, 'bin/git'), 0o700);
  return { root, put, commands };
}
function run(f, entry, args) {
  const home = join(f.root, 'home'); mkdirSync(home, { recursive: true });
  // Repeat the lane's quiet gate immediately before each child Node process.
  const result = spawnSync('/bin/sh', ['-c', `while [ -e ${quiet} ]; do sleep 60; done\nexec nice -n 10 "$@"`, 'picker-probe', process.execPath, entry, ...args], {
    cwd: f.root, encoding: 'utf8', timeout: 45000,
    env: { PATH: `${join(f.root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_LIFECYCLE_LOCK_ROOT: join(f.root, 'locks'), TMPDIR: join(f.root, 'temp') },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('runner executes the exact picked list and writes a section receipt, including git-failure fallback', () => {
  for (const failedGit of [false, true]) {
    const f = fixture({ failedGit });
    const output = run(f, runner, ['--root', f.root, '--changed-since', 'fixture-ref', '--workers', '1', '--scratch', join(f.root, 'scratch'), '--out', join(f.root, 'out')]);
    const receipt = JSON.parse(readFileSync(join(f.root, 'out/results.json'), 'utf8'));
    assert.match(readFileSync(join(f.root, 'git-calls.log'), 'utf8'), /diff --name-only.*fixture-ref/, 'git decision reached');
    assert.match(output, /section run, not a release verdict/);
    assert.equal(receipt.certifies, false); assert.equal(receipt.mode, 'section');
    assert.equal(receipt.selection.fullChain, failedGit);
    const expected = failedGit ? f.commands : f.commands.filter((s) => !s.includes('other.test.mjs'));
    assert.deepEqual(receipt.selection.commands, expected);
    assert.deepEqual(receipt.results.map((r) => r.command), expected);
    assert.equal(receipt.attempted, expected.length); assert.equal(receipt.failed, 0);
    assert.ok(receipt.selection.picked.every((row) => row.reasons.length));
    if (failedGit) assert.match(receipt.selection.notes.join(';'), /git.*run the full chain/);
    rmSync(f.root, { recursive: true });
  }
});

test('picker CLI accepts --areas and explicit changed paths without running tests', () => {
  const f = fixture(); f.put('areas.json', JSON.stringify([{ prefix: 'notes/', tests: ['test/unit.test.mjs'] }]));
  const output = run(f, picker, ['--root', f.root, '--areas', join(f.root, 'areas.json'), '--changed', 'notes/guide.md']);
  const selection = JSON.parse(output);
  assert.equal(selection.fullChain, false); assert.equal(selection.certifies, false);
  assert.ok(selection.commands.includes('node test/unit.test.mjs'));
  assert.ok(!selection.commands.includes('node test/other.test.mjs'));
  assert.match(selection.picked.find((row) => row.command === 'node test/unit.test.mjs').reasons.join(';'), /area notes/);
  rmSync(f.root, { recursive: true });
});

test('an external runner still plans without the optional picker module when the flag is absent', () => {
  const f = fixture();
  f.put('standalone.mjs', readFileSync(runner, 'utf8'));
  const output = run(f, join(f.root, 'standalone.mjs'), ['--root', f.root, '--plan']);
  assert.match(output, /plan: 16\/16 commands/);
  assert.ok(!output.includes('section run'));
  rmSync(f.root, { recursive: true });
});
