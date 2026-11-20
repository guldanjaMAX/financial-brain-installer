// Developer-tool tests only. All checkouts and subprocess homes are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const { pickTests, pickChangedTests, SMOKE_FILES } = await import(process.env.PICKER_TEST_MODULE || '../../ci/pick-tests.mjs');
import { parseArguments } from '../../scripts/run-test-chain-parallel.mjs';

const scratch = resolve('.lane-scratch/tool-picker');
mkdirSync(scratch, { recursive: true });
const worker = 'node --test worker/test/unit.test.mjs';
const docs = 'node test/docs-contract.test.mjs';
const other = 'node test/unrelated.test.mjs';
const helper = 'node test/helper-consumer.test.mjs';
const mono = 'node test/mono.test.mjs';
const caller = 'node test/caller.test.mjs';
function fixture() {
  const root = mkdtempSync(join(scratch, 'checkout-'));
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  const smoke = SMOKE_FILES.map((file) => `node ${file}`);
  const commands = [...smoke, worker, docs, other, helper, mono, caller];
  put('scripts/run-test-chain.mjs', `export const TEST_COMMANDS = ${JSON.stringify(commands)};\nexport const parseTestCommand = (command) => ({kind: 'node', args: command.split(' ').slice(1)});`);
  put('package.json', JSON.stringify({ type: 'module' }));
  for (const file of SMOKE_FILES) put(file, '// smoke fixture\n');
  put('worker/test/unit.test.mjs', "import { unit } from '../src/lib/unit.js';\n");
  put('worker/src/lib/unit.js', 'export function unit() { return 1; }\n');
  put('test/helper-consumer.test.mjs', "import './helpers/load.mjs';\n");
  put('test/helpers/load.mjs', "import '../../worker/src/lib/unit.js';\n");
  put('test/docs-contract.test.mjs', '// documentation contract\n');
  put('test/unrelated.test.mjs', '// unrelated green control\n');
  put('test/mono.test.mjs', '// unitAnswer\n');
  put('test/caller.test.mjs', '// answerRoute\n');
  put('brain.mjs', 'export function unitAnswer() {\n  return 2;\n}\nexport function answerRoute() {\n  return unitAnswer();\n}\n');
  return { root, put, commands, smoke };
}
const selected = (result) => result.commands;
function checkSmoke(result, f) {
  for (const command of f.smoke) {
    assert.ok(selected(result).includes(command), command);
    assert.ok(result.picked.find((row) => row.command === command).reasons.some((s) => s.includes('smoke')));
  }
  assert.equal(result.certifies, false);
  assert.equal(result.mode, 'section');
  assert.ok(result.picked.every((row) => row.reasons.length > 0));
}
async function narrowControl(f) {
  const r = await pickTests({ root: f.root, changedFiles: ['worker/src/lib/unit.js'] });
  assert.equal(r.fullChain, false, r.notes.join('; '));
  assert.ok(r.commands.includes(worker));
  assert.ok(!r.commands.includes(other), 'unrelated arm remains outside the selection');
  return r;
}

test('worker lib reaches direct tests, two-level helpers, and every smoke command in chain order', async () => {
  const f = fixture(); const r = await narrowControl(f);
  checkSmoke(r, f);
  assert.ok(r.commands.includes(helper));
  assert.deepEqual(r.commands, f.commands.filter((c) => f.smoke.includes(c) || [worker, helper].includes(c)));
  assert.match(r.picked.find((row) => row.command === worker).reasons.join(';'), /unit.js/);
});

test('docs-only uses the default area, with a source-change green control', async () => {
  const f = fixture(); await narrowControl(f);
  const r = await pickTests({ root: f.root, changedFiles: ['docs/guide.md'] });
  checkSmoke(r, f); assert.equal(r.fullChain, false);
  assert.ok(r.commands.includes(docs)); assert.ok(!r.commands.includes(worker));
  assert.match(r.picked.find((row) => row.command === docs).reasons.join(';'), /area/);
});

for (const path of ['migrations/d1/9999_fixture.sql', 'package.json', 'scripts/run-test-chain-parallel.mjs', 'ci/pick-tests.mjs', 'unknown/new.kind']) {
  test(`${path} selects the full chain and explains the decision, with narrowing control`, async () => {
    const f = fixture(); await narrowControl(f);
    const r = await pickTests({ root: f.root, changedFiles: [path] });
    checkSmoke(r, f); assert.equal(r.fullChain, true);
    assert.deepEqual(r.commands, f.commands);
    assert.match(r.notes.join(';'), /run the full chain/);
    assert.ok(r.picked.some((row) => row.reasons.some((s) => s.includes(path))), 'fallback decision reached');
  });
}

test('empty diff selects only smoke and explicitly says so, with non-empty control', async () => {
  const f = fixture(); await narrowControl(f);
  const r = await pickTests({ root: f.root, changedFiles: [] });
  assert.deepEqual(r.commands, f.smoke); checkSmoke(r, f);
  assert.match(r.notes.join(';'), /empty diff.*smoke/i);
});

test('rename considers both paths, including the deleted import target', async () => {
  const f = fixture(); await narrowControl(f);
  const r = await pickTests({ root: f.root, changedFiles: [{ path: 'worker/src/lib/replacement.js', oldPath: 'worker/src/lib/unit.js' }] });
  assert.ok(r.commands.includes(worker)); checkSmoke(r, f);
  assert.equal(r.fullChain, true, 'unmapped rename destination fails safe');
  assert.match(r.notes.join(';'), /replacement.js/);
});

test('registered untracked test picks its chain command; unregistered test requires full chain', async () => {
  const f = fixture(); await narrowControl(f);
  const registered = await pickTests({ root: f.root, changedFiles: ['worker/test/unit.test.mjs'] });
  assert.equal(registered.fullChain, false); assert.ok(registered.commands.includes(worker));
  f.put('test/new.test.mjs', '// new candidate\n');
  const r = await pickTests({ root: f.root, changedFiles: ['test/new.test.mjs'] });
  assert.equal(r.fullChain, true); assert.deepEqual(r.commands, f.commands);
  assert.match(r.notes.join(';'), /unregistered.*test\/new.test.mjs/i);
  checkSmoke(r, f);
});

test('monolith hunks select function mentions and transitive in-file callers', async () => {
  const f = fixture(); await narrowControl(f);
  for (const path of ['brain.mjs', 'worker/src/index.js']) {
    if (path !== 'brain.mjs') f.put(path, readFileSync(join(f.root, 'brain.mjs'), 'utf8'));
    const r = await pickTests({ root: f.root, changedFiles: [{ path, diff: '@@ -2 +2 @@\n-  return 1;\n+  return 2;\n' }] });
    assert.equal(r.fullChain, false, r.notes.join(';'));
    assert.ok(r.commands.includes(mono)); assert.ok(r.commands.includes(caller));
    assert.ok(!r.commands.includes(worker)); checkSmoke(r, f);
    const ambiguous = await pickTests({ root: f.root, changedFiles: [path] });
    assert.equal(ambiguous.fullChain, true); assert.deepEqual(ambiguous.commands, f.commands);
  }
});

test('explicit areas map no-edge paths; invalid or empty maps fail safe', async () => {
  const f = fixture(); await narrowControl(f);
  const r = await pickTests({ root: f.root, changedFiles: ['notes/readme.txt'], areas: [{ prefix: 'notes/', tests: ['test/docs-*.test.mjs'] }] });
  assert.equal(r.fullChain, false); assert.ok(r.commands.includes(docs)); checkSmoke(r, f);
  const empty = await pickTests({ root: f.root, changedFiles: ['notes/readme.txt'], areas: [] });
  assert.equal(empty.fullChain, true); assert.deepEqual(empty.commands, f.commands);
});

test('git error selects everything after reaching the git decision; valid injected diff narrows', async () => {
  const f = fixture(); let calls = 0;
  const failGit = () => { calls++; throw new Error('fixture git failure'); };
  const r = await pickChangedTests({ root: f.root, ref: 'fixture-ref', git: failGit });
  assert.equal(calls, 1); assert.deepEqual(r.commands, f.commands); assert.equal(r.fullChain, true);
  assert.match(r.notes.join(';'), /git.*run the full chain/i); checkSmoke(r, f);
  const okGit = (args) => {
    if (args.includes('--name-only')) return Buffer.from('worker/src/lib/unit.js\0');
    if (args.includes('--numstat')) return Buffer.from('');
    return Buffer.from('');
  };
  const control = await pickChangedTests({ root: f.root, ref: 'fixture-ref', git: okGit, untracked: () => [] });
  assert.equal(control.fullChain, false, control.notes.join(';')); assert.ok(control.commands.includes(worker));
});

test('runner parses picker options and prevents an --only intersection or compare-only bypass', () => {
  const opts = parseArguments(['--changed-since', 'HEAD~1', '--areas', 'fixture.json', '--plan']);
  assert.equal(opts.changedSince, 'HEAD~1'); assert.ok(opts.areas.endsWith('fixture.json'));
  assert.throws(() => parseArguments(['--changed-since', 'HEAD', '--only', 'unit']), /cannot combine/);
  assert.throws(() => parseArguments(['--changed-since', 'HEAD', '--compare', 'x', '--against', 'y']), /cannot combine/);
});

test('runner selection is exact and results carry the non-certifying receipt', async () => {
  // Static integration guard complements subprocess CLI coverage without running product tests.
  const text = readFileSync(new URL('../../scripts/run-test-chain-parallel.mjs', import.meta.url), 'utf8');
  assert.match(text, /pickChangedTests/); assert.match(text, /certifies:/);
  assert.match(text, /section run, not a release verdict/);
  assert.match(text, /mode: "section", selection/);
  assert.ok(!JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).files.includes('ci/'));
});

test('git inventory includes untracked tests, ignores scratch outputs, and preserves rename sides', async () => {
  const f = fixture();
  f.put('.gitignore', 'generated/\n*.log\n!keep.log\n');
  const tracked = [];
  const walk = (dir = '') => { for (const e of readdirSync(join(f.root, dir), { withFileTypes: true })) {
    const file = dir ? `${dir}/${e.name}` : e.name; if (e.isDirectory()) walk(file); else tracked.push(file);
  } }; walk();
  const calls = [];
  const git = (args) => {
    calls.push(args);
    return args.includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904') ? tracked.join('\0') : 'worker/src/lib/unit.js\0';
  };
  f.put('generated/ignored.kind', '// generated\n'); f.put('ignored.log', '// generated\n');
  const control = await pickChangedTests({ root: f.root, ref: 'fixture-ref', git });
  assert.equal(control.fullChain, false, control.notes.join(';'));
  assert.ok(control.commands.includes(worker)); assert.ok(!control.commands.includes(other));
  assert.ok(calls.some((args) => args.includes('fixture-ref') && args.includes('--no-renames')), 'ref-to-worktree decision reached');
  f.put('test/new candidate.test.mjs', '// untracked\n');
  const r = await pickChangedTests({ root: f.root, ref: 'fixture-ref', git });
  assert.equal(r.fullChain, true); assert.deepEqual(r.commands, f.commands);
  assert.ok(r.changedFiles.includes('test/new candidate.test.mjs'), 'untracked decision reached');
  const renameGit = (args) => args.includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904') ? tracked.join('\0') : 'worker/src/lib/unit.js\0worker/src/lib/replacement.js\0';
  const renamed = await pickChangedTests({ root: f.root, ref: 'fixture-ref', git: renameGit, untracked: () => [] });
  assert.ok(renamed.changedFiles.includes('worker/src/lib/unit.js'));
  assert.ok(renamed.changedFiles.includes('worker/src/lib/replacement.js'));
  assert.ok(renamed.commands.includes(worker));
});


test('empty or flag-shaped --changed-since values cannot start an accidental full run', () => {
  assert.equal(parseArguments(['--changed-since', 'HEAD']).changedSince, 'HEAD');
  assert.throws(() => parseArguments(['--changed-since', '']), /needs a git reference/);
  assert.throws(() => parseArguments(['--changed-since', '--plan']), /needs a git reference/);
});

test('unsupported double-star ignore syntax cannot hide an untracked test', async () => {
  const f = fixture(); f.put('.gitignore', '/test**generated/*.test.mjs\n');
  const tracked = [];
  const walk = (dir = '') => { for (const e of readdirSync(join(f.root, dir), { withFileTypes: true })) {
    const file = dir ? `${dir}/${e.name}` : e.name; if (e.isDirectory()) walk(file); else tracked.push(file);
  } }; walk();
  const git = (args) => args.includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904') ? tracked.join('\0') : 'worker/src/lib/unit.js\0';
  const control = await pickChangedTests({ root: f.root, ref: 'fixture-ref', git });
  assert.equal(control.fullChain, false); assert.ok(control.commands.includes(worker));
  f.put('test/deep/generated/new.test.mjs', '// untracked\n');
  const r = await pickChangedTests({ root: f.root, ref: 'fixture-ref', git });
  assert.ok(r.changedFiles.includes('test/deep/generated/new.test.mjs'), 'untracked inventory decision reached');
  assert.equal(r.fullChain, true); assert.deepEqual(r.commands, f.commands);
});


test('the mandatory smoke contract has fourteen unique files including the chain-completeness guard', () => {
  assert.equal(SMOKE_FILES.length, 14);
  assert.equal(new Set(SMOKE_FILES).size, 14);
  assert.ok(SMOKE_FILES.includes('test/test-chain-complete.test.mjs'));
  assert.ok(SMOKE_FILES.includes('worker/test/highwrong-frozen-1114.test.mjs'));
});
