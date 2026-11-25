import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const suite = 'worker/test/highwrong-frozen-1114.test.mjs';
const overviewFixturePath = 'worker/test/helpers/money-overview-fixture.mjs';
const quiet = `while [ -e ${resolve(root, '../../MAC-QUIET')} ]; do sleep 60; done`;
const helperUrl = import.meta.url;
const storage = new AsyncLocalStorage();
const cases = [];

// Observation only: never change the value returned to the frozen assertions.
export function recordConfidence(surface, result) {
  const current = storage.getStore();
  if (current && result?.confidence) {
    const c = result.confidence;
    current.scores.push([surface, c.level ?? null, c.band ?? null, c.percent ?? null]);
  }
  return result;
}

export function replayTest(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  const row = { name, knownSkip: Boolean(options?.skip), scores: [], failure: null };
  cases.push(row);
  // The measurement replay also executes the 75 known-limit fixtures. Their
  // existing assertions still fail, and the parent verifies that exact set.
  return nodeTest(name, { ...options, skip: false }, t => storage.run(row, async () => {
    try { await fn(t); }
    catch (error) { row.failure = error.code || error.name; throw error; }
  }));
}

if (process.env.CONF_HIDE_REPLAY_OUTPUT) {
  const replayRoot = resolve(process.env.CONF_HIDE_REPLAY_ROOT);
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (!url.startsWith(pathToFileURL(replayRoot + '/').href)) return loaded;
    const path = relative(replayRoot, fileURLToPath(url)).replaceAll('\\', '/');
    let source = typeof loaded.source === 'string' ? loaded.source : loaded.source && new TextDecoder().decode(loaded.source);
    if (path === overviewFixturePath) {
      // Replay both readers against the archived fixture bytes. The ordinary
      // fixture can evolve to use the production Plaid reference shape.
      source = readFileSync(process.env.CONF_HIDE_REPLAY_OVERVIEW_FIXTURE, 'utf8');
    }
    if (path === suite) {
      const anchor = "import nodeTest from 'node:test';";
      assert.ok(source.includes(anchor), 'frozen test registration anchor exists');
      source = source.replace(anchor, `import { replayTest as nodeTest } from ${JSON.stringify(helperUrl)};
import ${JSON.stringify(new URL('../fixtures/cli-side-effect-tripwire.mjs', helperUrl).href)};`);
    }
    const functions = {
      'worker/src/lib/money-query.js': ['queryMoney'],
      'worker/src/lib/money-overview.js': ['overviewMoney'],
      'worker/src/lib/document-answer-reading.js': ['finalizeDocumentAnswer'],
    }[path];
    if (functions) {
      source += `\nimport { recordConfidence as __record } from ${JSON.stringify(helperUrl)};\n`;
      for (const name of functions) {
        const declaration = new RegExp(`export (async )?function ${name}\\(`);
        assert.ok(declaration.test(source), `${name} observation anchor exists`);
        const async = declaration.exec(source)[1] || '';
        source = source.replace(declaration, `${async}function __original_${name}(`);
        source += `\nexport ${async}function ${name}(...args) { return __record(${JSON.stringify(name)}, ${async ? 'await ' : ''}__original_${name}(...args)); }\n`;
      }
    }
    return source == null ? loaded : { ...loaded, source };
  }});
  // This preload can also run in the test coordinator; only the process that
  // actually registered the fixture cases may publish its observations.
  process.on('exit', () => {
    if (cases.length) writeFileSync(process.env.CONF_HIDE_REPLAY_OUTPUT, JSON.stringify(cases));
  });
}

export function assertSameLevels(baseline, candidate) {
  assert.ok(baseline.length > 0, 'comparison reached a populated baseline');
  assert.equal(JSON.stringify(candidate), JSON.stringify(baseline), 'every frozen case and internal score is byte-identical to HEAD');
}

export function replayFrozenLevels(t) {
  const destination = process.env.CONF_HIDE_REPLAY_RECEIPT_DIR && resolve(process.env.CONF_HIDE_REPLAY_RECEIPT_DIR);
  if (destination) {
    assert.ok(destination.startsWith(root + '/'), 'receipts stay inside the worktree');
    mkdirSync(destination, { recursive: true });
  }
  const scratch = mkdtempSync(join(tmpdir(), 'frozen-confidence-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // Both arms use the same calendar and an isolated home for any CLI I/O.
  const env = { PATH: process.env.PATH, HOME: scratch, TZ: 'UTC', LANG: 'C', LC_ALL: 'C',
    BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_TEST_LAUNCHCTL: join(scratch, 'launchctl'),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  writeFileSync(join(scratch, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const head = join(scratch, 'head');
  mkdirSync(head);
  const git = args => execFileSync('git', args, { cwd: root, env, maxBuffer: 128 * 1024 * 1024 });
  const sha = git(['rev-parse', 'HEAD']).toString().trim();
  execFileSync('tar', ['-xf', '-', '-C', head], { input: git(['archive', 'HEAD']), env });
  const inventory = [];
  function hashTree(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) hashTree(path);
      else if (entry.isFile()) inventory.push([relative(head, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  }
  hashTree(head);
  assert.ok(inventory.length > 0, 'every copied HEAD source has a SHA-256 receipt');
  if (destination) writeFileSync(join(destination, 'copied-sources.json'), JSON.stringify({ head: sha, sha256: inventory }, null, 2) + '\n');
  // SQLite fixtures read migrations from disk rather than through the loader.
  // Both arms must use the same schema and fixture bytes, except the approved
  // owner-display assertion in the frozen test itself.
  const fixturePaths = new Set(['worker/test/helpers/doc-high-provenance.mjs',
    'worker/test/helpers/clean-money-fixture.mjs',
    'worker/test/product-contract-fixture.mjs']);
  for (const [path, hash] of inventory.filter(([p]) => p.startsWith('migrations/d1/') || fixturePaths.has(p))) {
    assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), hash, `same replay fixture: ${path}`);
  }
  if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(head, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const arms = [];
  for (const [arm, productRoot] of [['head', head], ['candidate', root]]) {
    if (process.platform === 'darwin') execFileSync('/bin/sh', ['-c', quiet], { env });
    const output = join(scratch, `${arm}.json`);
    const args = ['--import', helperUrl, '--test', '--test-reporter=tap', join(productRoot, suite)];
    const result = spawnSync(process.platform === 'win32' ? process.execPath : 'nice',
      process.platform === 'win32' ? args : ['-n', '10', process.execPath, ...args], {
      cwd: productRoot, env: { ...env, CONF_HIDE_REPLAY_ROOT: productRoot, CONF_HIDE_REPLAY_OUTPUT: output,
        CONF_HIDE_REPLAY_OVERVIEW_FIXTURE: join(head, overviewFixturePath) },
      // The archived engine can spend over 15 minutes on 483 real SQLite
      // cases when the runner is shared. Keep a finite cap on each arm.
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60 * 1000,
    });
    assert.ifError(result.error);
    assert.ok(existsSync(output), `${arm} replay produced observations: ${result.stderr.slice(0, 300)}`);
    const bytes = readFileSync(output, 'utf8');
    if (destination) {
      writeFileSync(join(destination, `${arm}-levels.json`), bytes + '\n');
      writeFileSync(join(destination, `${arm}-replay.txt`), result.stdout + result.stderr);
    }
    const observations = JSON.parse(bytes);
    assert.equal(observations.length, 483, 'every frozen case was reached');
    assert.equal(observations.filter(row => row.knownSkip).length, 75, 'known-limit set is unchanged');
    for (const row of observations) {
      if (row.failure) {
        assert.ok(row.knownSkip, `only known-limit assertions may fail: ${row.name}`);
        assert.equal(row.failure, 'ERR_ASSERTION', 'host or runtime errors never count as a known limit');
      }
      if (row.knownSkip) assert.ok(row.scores.length > 0, `known-limit fixture reached its score: ${row.name}`);
    }
    assert.equal(result.status, 1, 'only the existing known-limit assertions fail in the measurement replay');
    const counts = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)]
      .map(([, key, value]) => [key, Number(value)]));
    const failures = observations.filter(row => row.failure).length;
    assert.deepEqual(counts, { tests: 483, pass: 483 - failures, fail: failures, skipped: 0 },
      'no extra hook, loader or runtime failure is hidden by the known-limit failures');
    assert.ok(observations.reduce((n, row) => n + row.scores.length, 0) > 483, 'real score computations were reached');
    arms.push(observations);
  }
  assertSameLevels(arms[0], arms[1]);
  const receipt = { head: sha, copied_sources: inventory, cases: arms[0].length,
    scores: arms[0].reduce((n, row) => n + row.scores.length, 0), observations: arms[0] };
  if (destination) {
    writeFileSync(join(destination, 'frozen-levels.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  return receipt;
}
