// Regression probes execute synthetic consumers before checking their selection.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const { pickTests, SMOKE_FILES } = await import(process.env.PICKER_TEST_MODULE || '../../ci/pick-tests.mjs');

const scratch = resolve('.lane-scratch/tool-picker-r1');
mkdirSync(scratch, { recursive: true });
const consumer = 'node test/consumer.test.mjs';
const direct = 'node test/direct.test.mjs';
const unrelated = 'node test/unrelated.test.mjs';
const quiet = resolve(fileURLToPath(new URL('../../', import.meta.url)), '../..', 'MAC-QUIET');
const runner = fileURLToPath(new URL('../../scripts/run-test-chain-parallel.mjs', import.meta.url));

function fixture(kind = 'literal', bad = false) {
  const root = mkdtempSync(join(scratch, `${kind}-`));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commands = [...SMOKE_FILES.map((file) => `node ${file}`), direct, consumer, unrelated, 'node test/docs-contract.test.mjs'];
  put('scripts/run-test-chain.mjs', `export const TEST_COMMANDS = ${JSON.stringify(commands)};\nexport const parseTestCommand = (command) => ({ kind: 'node', args: command.split(' ').slice(1) });\n`);
  put('package.json', '{"type":"module"}\n');
  for (const file of SMOKE_FILES) put(file, '// synthetic smoke\n');
  put('lib/value.mjs', `export const value = ${bad ? 2 : 1};\n`);
  put('test/direct.test.mjs', "import { value } from '../lib/value.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(typeof value, 'number');\n");
  put('test/unrelated.test.mjs', '// unrelated control\n');
  put('test/docs-contract.test.mjs', '// known area control\n');
  const assertion = "import assert from 'node:assert/strict';\nassert.equal(value, 1);\n";
  let load = "import { value } from '../lib/value.mjs';\n";
  if (kind === 'computed') load = "const path = '../lib/' + 'value.mjs';\nconst { value } = await import(path);\n";
  if (kind === 'concat') load = "const { value } = await import('../lib/' + 'value.mjs');\n";
  if (kind === 'template') load = "const name = 'value';\nconst { value } = await import(`../lib/${name}.mjs`);\n";
  if (kind === 'require-helper') {
    put('lib/value.cjs', `exports.value = ${bad ? 2 : 1};\n`);
    put('test/direct.test.mjs', "import loaded from '../lib/value.cjs';\nimport assert from 'node:assert/strict';\nassert.equal(typeof loaded.value, 'number');\n");
    put('test/helpers/load.cjs', "const path = '../../lib/' + 'value.cjs';\nmodule.exports = require(path);\n");
    load = "import loaded from './helpers/load.cjs';\nconst { value } = loaded;\n";
  }
  if (kind === 'literal-dynamic') load = "const { value } = await import('../lib/value.mjs');\n";
  if (kind === 'symlink') {
    symlinkSync('value.mjs', join(root, 'lib/alias.mjs'));
    load = "import { value } from '../lib/alias.mjs';\n";
  }
  if (kind === 'directory-symlink') {
    symlinkSync('lib', join(root, 'alias'), 'dir');
    load = "import { value } from '../alias/value.mjs';\n";
  }
  if (kind === 'deleted' || kind === 'renamed') {
    if (!bad) put('docs/value.mjs', 'export const value = 1;\n');
    if (bad && kind === 'renamed') put('docs/replacement.mjs', 'export const value = 1;\n');
    load = "import { value } from '../docs/value.mjs';\n";
  }
  put('test/consumer.test.mjs', load + assertion);
  return { root, put, commands };
}

async function select(f, changedFiles) {
  const result = await pickTests({ root: f.root, changedFiles });
  assert.ok(result.commands.length > 0, 'a nonempty selection reached the decision');
  for (const file of SMOKE_FILES) assert.ok(result.commands.includes(`node ${file}`));
  assert.equal(result.certifies, false);
  return result;
}

async function literalControl() {
  const f = fixture('literal-dynamic');
  await import(pathToFileURL(join(f.root, 'test/consumer.test.mjs')));
  const result = await select(f, ['lib/value.mjs']);
  assert.equal(result.fullChain, false, result.notes.join(';'));
  assert.ok(result.commands.includes(consumer));
  assert.ok(!result.commands.includes(unrelated));
}

test('literal dynamic imports retain precision with an executed passing consumer', literalControl);

test('an intact docs source selects its consumer as well as its folder area', async () => {
  const f = fixture('deleted');
  await import(pathToFileURL(join(f.root, 'test/consumer.test.mjs')));
  const result = await select(f, ['docs/value.mjs']);
  assert.equal(result.fullChain, false);
  assert.ok(result.commands.includes(consumer));
  assert.ok(result.commands.includes('node test/docs-contract.test.mjs'));
  assert.ok(!result.commands.includes(unrelated));
});

for (const kind of ['computed', 'concat', 'template', 'require-helper', 'symlink', 'directory-symlink', 'deleted', 'renamed']) {
  test(`${kind}: retain an executed failing consumer despite a recognized edge or area`, async () => {
    await literalControl();
    const good = fixture(kind);
    await import(pathToFileURL(join(good.root, 'test/consumer.test.mjs')));
    const bad = fixture(kind, true);
    const missing = kind === 'deleted' || kind === 'renamed';
    await assert.rejects(import(pathToFileURL(join(bad.root, 'test/consumer.test.mjs'))), {
      code: missing ? 'ERR_MODULE_NOT_FOUND' : 'ERR_ASSERTION',
    }, 'the real changed consumer ran and failed for the expected reason');
    await import(pathToFileURL(join(bad.root, 'test/direct.test.mjs')));
    const changedFiles = missing ? (kind === 'renamed'
      ? [{ path: 'docs/replacement.mjs', oldPath: 'docs/value.mjs' }]
      : ['docs/value.mjs']) : [kind === 'require-helper' ? 'lib/value.cjs' : 'lib/value.mjs'];
    const result = await select(bad, changedFiles);
    assert.ok(result.commands.includes(consumer), 'picker must retain the executed failing consumer');
    assert.equal(result.fullChain, true, 'uncertain dependencies must widen to the full chain');
    assert.deepEqual(result.commands, bad.commands);
  });
}

test('an escaping symlink stops mapping before any dependency read through it', async () => {
  await literalControl();
  const f = fixture();
  // A nonexistent target outside the checkout proves the guard inspects the
  // link itself, rather than following it or accepting existsSync(false).
  symlinkSync('../../absent-outside.mjs', join(f.root, 'lib/escape.mjs'));
  f.put('test/consumer.test.mjs', "import '../lib/escape.mjs';\n");
  const result = await select(f, ['lib/value.mjs']);
  assert.equal(result.fullChain, true);
  assert.deepEqual(result.commands, f.commands);
  assert.match(result.notes.join(';'), /symlink/);
});

function runSynthetic(f) {
  f.put('bin/launchctl', '#!/bin/sh\nexit 91\n');
  chmodSync(join(f.root, 'bin/launchctl'), 0o700);
  f.put('fixture-admin-key', ['fixture', 'only', 'value'].join('-'));
  chmodSync(join(f.root, 'fixture-admin-key'), 0o600);
  f.put('fixture-config.json', JSON.stringify({ adminKeyFile: 'fixture-admin-key' }));
  f.put('bin/git', '');
  f.put('git-calls.log', '');
  const inventory = [];
  const walk = (dir = '') => {
    for (const entry of readdirSync(join(f.root, dir), { withFileTypes: true })) {
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file); else inventory.push(file);
    }
  };
  walk();
  f.put('bin/git', `#!/bin/sh\nprintf '%s\\n' "$*" >> git-calls.log\ncase "$*" in\n *--name-only*4b825dc642cb6eb9a060e54bf8d69288fbee4904*) printf '%s\\000' ${inventory.map((s) => `'${s}'`).join(' ')} ;;\n *--name-only*) printf '%s\\000' lib/value.mjs ;;\n *rev-parse*) printf '%s\\n' fixture-head ;;\n *) exit 0 ;;\nesac\n`);
  chmodSync(join(f.root, 'bin/git'), 0o700);
  const home = join(f.root, 'home');
  mkdirSync(home, { recursive: true });
  const result = spawnSync('/bin/sh', ['-c', `while [ -e ${quiet} ]; do sleep 60; done\nexec nice -n 10 "$@"`, 'picker-safety-probe', process.execPath, runner,
    '--root', f.root, '--changed-since', 'fixture-ref', '--workers', '1', '--keep-temp', '--scratch', join(f.root, 'scratch'), '--out', join(f.root, 'out')], {
    cwd: f.root, encoding: 'utf8', timeout: 45000,
    env: { PATH: `${join(f.root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_LIFECYCLE_LOCK_ROOT: join(f.root, 'locks'), TMPDIR: join(f.root, 'temp') },
  });
  assert.equal(result.error, undefined, 'synthetic runner completed');
  const receipt = JSON.parse(readFileSync(join(f.root, 'out/results.json'), 'utf8'));
  assert.match(readFileSync(join(f.root, 'git-calls.log'), 'utf8'), /diff --name-only.*fixture-ref/, 'git selection decision reached');
  assert.ok(receipt.selection.commands.length > 0);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.mode, 'section');
  return { result, receipt };
}

test('actual changed-since runner executes the computed-import consumer and reports its failure', async () => {
  const good = runSynthetic(fixture('computed'));
  assert.equal(good.result.status, 0, good.result.stderr);
  assert.equal(good.receipt.failed, 0);
  const bad = runSynthetic(fixture('computed', true));
  assert.ok(bad.receipt.selection.commands.includes(consumer), 'runner must retain the failing computed-import consumer');
  assert.deepEqual(bad.receipt.results.map((row) => row.command), bad.receipt.selection.commands);
  assert.equal(bad.result.status, 1);
  assert.equal(bad.receipt.failed, 1);
  assert.equal(bad.receipt.results.find((row) => row.command === consumer).outcome, 'fail');
  assert.match(bad.receipt.results.find((row) => row.command === consumer).tail.join('\n'), /ERR_ASSERTION/);
});
