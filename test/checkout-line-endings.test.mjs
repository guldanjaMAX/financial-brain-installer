import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
const routeFixture = 'test/fixtures/fastloop-route/disclosure-v1.json';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
// Buffer assertion diffs can expand a large fixture into megabytes of output.
// Compare every byte while keeping failures free of historical source content.
const sameBytes = (actual, expected, label) => assert.ok(actual.equals(expected), label);
const environment = {
  PATH: process.env.PATH || '', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  // Git for Windows accepts NUL, but rejects Node's extended device path \\.\nul.
  BRAIN_NO_WRANGLER_LOGIN: '1', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
};
for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'])
  if (process.platform === 'win32' && process.env[name]) environment[name] = process.env[name];
const repository = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
  cwd: root, env: environment, encoding: 'utf8', timeout: 5000,
});
assert.equal(repository.status, 0, repository.error?.code || repository.stderr);
const gitDirectory = repository.stdout.trim();
assert.ok(gitDirectory, 'the real repository was located without creating Git state');

// Use Git's actual checkout conversion, without a clone, index write, or config
// mutation. Adverse caller settings must not change reviewed text or binaries.
function checkoutBytes(blob, path = blob, workTree = root) {
  const child = spawnSync('git', [
    '-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', '-c', 'core.fsmonitor=false',
    `--git-dir=${gitDirectory}`, `--work-tree=${workTree}`,
    'cat-file', '--filters', `--path=${path}`, `HEAD:${blob}`,
  ], { cwd: workTree, env: environment, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, child.error?.code || child.stderr?.toString());
  assert.ok(child.stdout.length > 0, 'Git reached the real nonempty blob and checkout filter');
  return child.stdout;
}

for (const path of [routeFixture,
  'test/fixtures/fastloop-day3/candidate-disclosure-v1.json',
  'worker/test/fixtures/simplefin/schema59-bank-feed.mjs']) {
  test(`Windows checkout preserves the exact reviewed bytes: ${path}`, () => {
    const original = read(path);
    assert.ok(original.includes(10), 'nonempty multiline historical input');
    assert.ok(!original.includes(13), 'the reviewed input is LF');
    sameBytes(checkoutBytes(path), original, 'checkout must retain the exact reviewed bytes');
  });
}

test('the default preserves LF for text paths without a per-file pin', () => {
  const original = read(routeFixture);
  for (const extension of ['mjs', 'js', 'json', 'md', 'sql', 'yml', 'sh', 'ps1', 'txt'])
    sameBytes(checkoutBytes(routeFixture, `checkout-probe/source.${extension}`), original, extension);
});

test('CMD and BAT checkout conversion uses CRLF', () => {
  const original = read(routeFixture);
  const crlf = Buffer.from(original.toString('utf8').replaceAll('\n', '\r\n'));
  assert.ok(!crlf.equals(original), 'the chosen input reaches line-ending conversion');
  for (const extension of ['cmd', 'bat'])
    sameBytes(checkoutBytes(routeFixture, `checkout-probe/source.${extension}`), crlf, extension);
});

test('the standard npm CMD fixture retains its immutable CRLF bytes', () => {
  const path = 'test/fixtures/machine-prep/npm-standard.cmd';
  const original = read(path);
  assert.ok(original.includes(Buffer.from('\r\n')), 'the fixture reaches the CRLF exception');
  sameBytes(checkoutBytes(path), original, 'the immutable CMD fixture must retain its exact bytes');
});

test('automatic text detection preserves the binary Windows helper', () => {
  const path = 'operations/windows-dpapi-helper.exe';
  const original = read(path);
  assert.ok(original.subarray(0, 8000).includes(0), 'the real binary reaches automatic text detection');
  sameBytes(checkoutBytes(path), original, 'binary bytes must survive checkout unchanged');
});

test('removing only the default LF rule reproduces the CRLF failure after a green control', t => {
  const original = read(routeFixture);
  sameBytes(checkoutBytes(routeFixture), original, 'the fixed checkout is the green peer');
  const rule = /^\* text=auto eol=lf\r?\n/gm;
  assert.equal([...attributes.matchAll(rule)].length, 1, 'one actual checkout decision is mutated');
  const scratch = mkdtempSync(join(tmpdir(), 'checkout-line-endings-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(join(scratch, '.gitattributes'), attributes.replace(rule, ''));
  const broken = checkoutBytes(routeFixture, routeFixture, scratch);
  sameBytes(broken, Buffer.from(original.toString('utf8').replaceAll('\n', '\r\n')), 'the mutant must reach CRLF conversion');
  assert.ok(!broken.equals(original), 'the historical byte check detects the reached conversion');
});

test('both test-chain lists register this checkout regression once', () => {
  const chain = read('scripts/run-test-chain.mjs').toString('utf8');
  const command = '"node --test test/checkout-line-endings.test.mjs"';
  const [before, after] = chain.split('export const TEST_COMMANDS = Object.freeze([');
  assert.ok(before && after, 'both actual chain lists were reached');
  for (const list of [before, after]) assert.equal(list.split(command).length - 1, 1);
});
