import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runReplayChild } from '../eval/fast-loop/child-run.mjs';
import { armReplayStall } from '../eval/fast-loop/child-stall.mjs';
import { replay, ROOT, waitForQuiet } from '../eval/fast-loop/money-replay.mjs';
import { replayRoute } from '../eval/fast-loop/route-replay.mjs';
import { runPrivateArm } from '../eval/fast-loop/private-ledger-replay.mjs';
import { BASE_CASES } from './fixtures/fastloop-money/input.mjs';

const timeout = tail => ({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stderr: tail });
const success = { status: 0, stdout: '{"observations":[]}', stderr: '' };
const rows = [
  { name: 'timeout then success', results: [timeout('first'), success], attempts: 2, lines: 1 },
  { name: 'two timeouts', results: [timeout('first'), timeout('second')], attempts: 2, lines: 2, error: /^REPLAY_CHILD_FAILED:null:ETIMEDOUT.*second/ },
  { name: 'exit status 2', results: [{ status: 2, stderr: 'HOST_FAILURE' }], attempts: 1, lines: 0, error: /^REPLAY_CHILD_FAILED:2:HOST_FAILURE/ },
  { name: 'non-timeout signal kill', results: [{ status: null, signal: 'SIGKILL', stderr: '' }], attempts: 1, lines: 0, error: /^REPLAY_CHILD_FAILED:null:/ },
  { name: 'success first time', results: [success], attempts: 1, lines: 0 },
  { name: 'other spawn error', results: [{ status: null, error: { code: 'EACCES' }, stderr: '' }], attempts: 1, lines: 0, error: /^REPLAY_CHILD_FAILED:null:EACCES/ },
  { name: 'timeout code with exited status', results: [{ status: 2, error: { code: 'ETIMEDOUT' }, stderr: '' }], attempts: 1, lines: 0, error: /^REPLAY_CHILD_FAILED:2:ETIMEDOUT/ },
];
for (const row of rows) test(row.name, () => {
  const calls = [], lines = [], quiet = [];
  let clock = 0;
  const execute = () => runReplayChild({ label: 'REPLAY', args: ['worker.mjs'],
    options: { env: { BRAIN_NO_WRANGLER_LOGIN: '1' }, timeout: 300000 },
    beforeAttempt: () => quiet.push(calls.length), now: () => clock++ * 120000,
    writeStderr: line => lines.push(line),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      // Extra attempts get a green result, so an over-retry cannot hide behind
      // a stub exhaustion error. The exact attempt count still rejects it.
      return row.results[calls.length - 1] || success;
    } });
  if (row.error) assert.throws(execute, { message: row.error });
  else assert.strictEqual(execute(), success);
  assert.equal(calls.length, row.attempts, 'the spawn decision was reached exactly as planned');
  assert.deepEqual(quiet, Array.from({ length: row.attempts }, (_, i) => i), 'each child rechecks host quiet');
  assert.equal(lines.length, row.lines);
  for (const [i, line] of lines.entries()) assert.match(line,
    new RegExp(`^REPLAY_CHILD_TIMEOUT REPLAY attempt=${i + 1} ms=120000 stderr=.*\\n$`));
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, ['worker.mjs']);
    assert.equal(call.options.timeout, 120000, 'caller options cannot enlarge the bound');
    assert.equal(call.options.killSignal, 'SIGKILL', 'a child ignoring SIGTERM must still be bounded');
    assert.deepEqual(call.options.env, { BRAIN_NO_WRANGLER_LOGIN: '1' });
  }
});

test('timeout diagnostics use only the last 400 stderr characters on one line', () => {
  const lines = [];
  const stderr = `discarded-prefix${'x'.repeat(399)}\n`;
  let calls = 0;
  const child = runReplayChild({ label: 'ROUTE', args: [], options: {},
    spawn: () => ++calls === 1 ? timeout(stderr) : success,
    writeStderr: line => lines.push(line), now: () => 0 });
  assert.strictEqual(child, success);
  assert.equal(calls, 2);
  assert.deepEqual(lines, [`REPLAY_CHILD_TIMEOUT ROUTE attempt=1 ms=0 stderr=${'x'.repeat(399)} \n`]);
});

test('a JSON parse failure after a successful child is never retried', () => {
  let calls = 0;
  assert.throws(() => JSON.parse(runReplayChild({ label: 'ROUTE', args: [], options: {},
    spawn: () => { calls++; return { ...success, stdout: 'invalid-json' }; } }).stdout), SyntaxError);
  assert.equal(calls, 1, 'the parser was reached after one successful spawn');
  assert.deepEqual(JSON.parse(success.stdout), { observations: [] }, 'valid JSON is the green peer');
});

test('caller failure prefixes and private transport refusal survive the shared launcher', () => {
  for (const label of ['REPLAY', 'ROUTE', 'PRIVATE_REPLAY']) {
    let calls = 0;
    assert.throws(() => runReplayChild({ label, args: [], options: {},
      spawn: () => { calls++; return timeout('tail'); }, writeStderr() {} }),
    { message: new RegExp(`^${label}_CHILD_FAILED:null:ETIMEDOUT.*tail`) });
    assert.equal(calls, 2);
  }
});

test('stall timer is unrefed and emits only compact allowlisted report fields', () => {
  const lines = [];
  let fire, unref = 0, reports = 0;
  armReplayStall({ root: ROOT, writeStderr: line => lines.push(line),
    setTimer: (callback, ms) => {
      assert.equal(ms, 30000);
      fire = callback;
      return { unref: () => unref++ };
    },
    getReport: () => {
      reports++;
      return { javascriptStack: { stack: [`at worker (${ROOT}/eval/fast-loop/money-worker.mjs:10:2)`,
        'at internal (node:internal/timers:1:2)', 'at external (/outside/private-source.mjs:3:4)'] },
      libuv: [{ type: 'pipe', is_active: true, filename: 'PRIVATE_INPUT_SENTINEL' },
        { type: 'timer', is_active: false }, { type: '/outside/private-source', is_active: true }],
      nativeStack: [{ symbol: 'node::TriggerNodeReport(v8::Isolate*)' }, { symbol: '/outside/private-library' }],
      environmentVariables: { VALUE: 'PRIVATE_INPUT_SENTINEL' }, header: { cwd: '/outside/private-source' } };
    } });
  assert.equal(unref, 1);
  assert.deepEqual(lines, [], 'normal workers emit no stall report');
  fire();
  assert.equal(reports, 1, 'the report decision was reached');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^REPLAY_CHILD_STALL /);
  const report = JSON.parse(lines[0].slice('REPLAY_CHILD_STALL '.length));
  assert.deepEqual(report.javascript_stack, ['eval/fast-loop/money-worker.mjs:10:2', 'node:internal/timers:1:2', '[external]']);
  assert.deepEqual(report.active_handles, ['pipe']);
  assert.deepEqual(report.native_stack, ['node::TriggerNodeReport', '[external]']);
  assert.doesNotMatch(lines[0], /PRIVATE_INPUT_SENTINEL|\/outside|environmentVariables|filename/);
  assert.ok(!lines[0].includes(ROOT));
});

test('unavailable or permission-denied process report falls back to JavaScript stack only', () => {
  for (const getReport of [() => undefined, () => { throw Error('permission denied PRIVATE_INPUT_SENTINEL'); }]) {
    const lines = [];
    let fire;
    armReplayStall({ root: ROOT, getReport, writeStderr: line => lines.push(line),
      setTimer: callback => { fire = callback; return { unref() {} }; } });
    fire();
    assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0].slice('REPLAY_CHILD_STALL '.length));
    assert.equal(report.report, 'unavailable');
    assert.ok(report.javascript_stack.some(frame => frame.startsWith('eval/fast-loop/child-stall.mjs:')));
    assert.equal(Object.hasOwn(report, 'active_handles'), false);
    assert.equal(Object.hasOwn(report, 'native_stack'), false);
    assert.doesNotMatch(lines[0], /PRIVATE_INPUT_SENTINEL|permission denied/);
  }
});

test('compact diagnostics retain every active handle type while bounding long stacks', () => {
  const types = ['async', 'check', 'fs_event', 'fs_poll', 'idle', 'pipe', 'poll',
    'prepare', 'process', 'signal', 'tcp', 'timer', 'tty', 'udp'];
  let fire, line;
  armReplayStall({ root: ROOT, writeStderr: value => { line = value; },
    setTimer: callback => { fire = callback; return { unref() {} }; },
    getReport: () => ({
      javascriptStack: { stack: Array(12).fill(`at worker (${ROOT}/${'x'.repeat(300)}.mjs:1:2)`) },
      nativeStack: Array(12).fill({ symbol: `${'x'.repeat(100)}()` }),
      libuv: types.map(type => ({ type, is_active: true })),
    }) });
  fire();
  assert.ok(line.length <= 400);
  const report = JSON.parse(line.slice('REPLAY_CHILD_STALL '.length));
  assert.deepEqual(report.active_handles, types);
  assert.ok(report.javascript_stack.length > 0);
  assert.ok(report.native_stack.length > 0);
});

const callers = [
  { label: 'REPLAY', run: deps => replay({ cases: [BASE_CASES[0]] }, deps), prefix: 'REPLAY_CHILD_FAILED' },
  { label: 'ROUTE', run: deps => replayRoute({ cases: [BASE_CASES[0]] }, deps), prefix: 'ROUTE_CHILD_FAILED' },
  { label: 'PRIVATE_REPLAY', run: deps => runPrivateArm(ROOT, { input_digest: 'synthetic', questions: [{ id: 'one' }] }, deps), prefix: 'PRIVATE_REPLAY_WORKER_FAILED' },
];
for (const caller of callers) test(`${caller.label} retries preserve replay observations and every digest`, () => {
  const observations = [{ id: 'one', execution_status: 'complete', trace: { reached: true } }];
  const body = JSON.stringify({ observations, input_digest: 'synthetic' });
  const child = { ...success, stdout: body, output: [null, body, '', body] };
  const calls = [], lines = [];
  let attempt = 0;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return ++attempt === 1 ? timeout('synthetic stall') : child;
  };
  const direct = caller.run({ spawn: () => child });
  const retried = caller.run({ spawn, writeStderr: line => lines.push(line) });
  assert.equal(calls.length, 2, 'the real replay caller reached its timeout retry');
  assert.equal(lines.length, 1);
  assert.deepEqual(calls[0], calls[1], 'both attempts receive identical argv, allowlisted environment and input bytes');
  assert.deepEqual(retried.observations, direct.observations);
  const digests = Object.keys(direct).filter(key => key.endsWith('_digest'));
  assert.ok(digests.includes('harness_digest'));
  if (caller.label !== 'PRIVATE_REPLAY') for (const key of ['observation_digest', 'input_set_digest']) assert.ok(digests.includes(key));
  for (const key of digests) assert.equal(retried[key], direct[key], key);
});

for (const caller of callers) test(`${caller.label} keeps terminal timeout and non-timeout failure contracts`, () => {
  for (const [child, count] of [[timeout('last-stderr'), 2], [{ status: 2, stderr: 'HOST_FAILURE' }, 1]]) {
    let calls = 0;
    assert.throws(() => caller.run({ spawn: () => { calls++; return child; }, writeStderr() {} }),
      { message: new RegExp(`^${caller.prefix}${count === 2 ? '.*last-stderr' : ''}`) });
    assert.equal(calls, count, 'the actual caller reached exactly the planned attempts');
  }
});

test('private replay keeps its immediate transport-blocked refusal', () => {
  let calls = 0;
  assert.throws(() => callers[2].run({ spawn: () => { calls++; return { status: 86, stderr: 'TEST_SIDE_EFFECT_BLOCKED:fetch' }; } }),
    { message: 'PRIVATE_REPLAY_TRANSPORT_BLOCKED' });
  assert.equal(calls, 1);
});

for (const caller of callers) test(`${caller.label} never retries malformed successful child output`, () => {
  let calls = 0;
  const child = { ...success, stdout: 'invalid-json', output: [null, null, '', 'invalid-json'] };
  assert.throws(() => caller.run({ spawn: () => { calls++; return child; } }));
  assert.equal(calls, 1, 'the successful child reached the real caller parser');
});

for (const [file, failure] of [['money-worker.mjs', 'REPLAY_HOST_FAILURE'],
  ['route-worker.mjs', 'ROUTE_HOST_FAILURE'], ['private-ledger-worker.mjs', 'PRIVATE_REPLAY_WORKER_FAILED']]) {
  test(`${file} arms the real report callback under permission mode before parsing input`, () => {
    const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC', TEST_REPORT_SENTINEL: 'PRIVATE_INPUT_SENTINEL' };
    for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[name]) env[name] = process.env[name];
    const run = diagnostic => {
      waitForQuiet(env);
      return spawnSync(process.execPath, ['--experimental-vm-modules', '--permission', '--no-warnings',
        `--allow-fs-read=${ROOT}`, '--import', pathToFileURL(resolve(ROOT, 'test/fixtures/cli-side-effect-tripwire.mjs')).href,
        ...(diagnostic ? ['--import', pathToFileURL(resolve(ROOT, 'test/fixtures/replay-stall-tripwire.mjs')).href] : []),
        resolve(ROOT, 'eval/fast-loop', file)], {
        cwd: ROOT, env, input: 'invalid-json PRIVATE_INPUT_SENTINEL', encoding: 'utf8',
        timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
    };
    const normal = run(false), stalled = run(true);
    for (const child of [normal, stalled]) {
      assert.equal(child.status, 2, 'the real worker reached its input parser');
      assert.match(child.stderr, new RegExp(failure));
      assert.equal(child.stdout, '');
    }
    assert.doesNotMatch(normal.stderr, /REPLAY_CHILD_STALL/);
    const lines = stalled.stderr.split('\n').filter(line => line.startsWith('REPLAY_CHILD_STALL '));
    assert.equal(lines.length, 1, 'the real worker reached its timer callback');
    assert.ok(lines[0].length < 400, 'the complete diagnosis survives the launcher stderr tail');
    const report = JSON.parse(lines[0].slice('REPLAY_CHILD_STALL '.length));
    assert.ok(report.javascript_stack.length > 0);
    if (report.report !== 'unavailable') {
      assert.ok(report.native_stack.length > 0);
      assert.ok(Array.isArray(report.active_handles));
    }
    assert.doesNotMatch(lines[0], /PRIVATE_INPUT_SENTINEL|environmentVariables|\/Users\/|file:\/\/\//);
  });
}

for (const [label, pattern] of [['direct adapter', '^in-memory worker executes three real paths'],
  ['CLI wrapper', '^synthetic D1 export replays three real ledger paths']]) {
  test(`private ${label} recovers one injected timeout through its real test path`, () => {
    const env = { PATH: process.env.PATH || '', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[key]) env[key] = process.env[key];
    waitForQuiet(env);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(resolve(ROOT, 'test/fixtures/replay-timeout-tripwire.mjs')).href,
      '--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, resolve(ROOT, 'test/private-ledger-replay.test.mjs')], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output);
    assert.match(output, /REPLAY_TIMEOUT_DECISION_REACHED/);
    assert.match(output, /REPLAY_TIMEOUT_GREEN_REACHED attempts=2/);
    assert.doesNotMatch(output, /REPLAY_OUTER_BUDGET_SHORT/);
    if (label === 'CLI wrapper') assert.match(output, /REPLAY_OUTER_BUDGET_REACHED/);
  });
}

test('private CLI keeps its original rejection of unexpected stderr after a recovered timeout', () => {
  const env = { PATH: process.env.PATH || '', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[key]) env[key] = process.env[key];
  waitForQuiet(env);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(resolve(ROOT, 'test/fixtures/replay-timeout-tripwire.mjs')).href + '?unexpected-stderr',
    '--test', '--test-reporter=tap', '--test-name-pattern=^synthetic D1 export replays three real ledger paths', resolve(ROOT, 'test/private-ledger-replay.test.mjs')], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${child.stdout || ''}\n${child.stderr || ''}`;
  assert.equal(child.status, 1, output);
  assert.match(output, /REPLAY_TIMEOUT_DECISION_REACHED/);
  assert.match(output, /REPLAY_TIMEOUT_GREEN_REACHED attempts=2/, 'a real green worker completed before stderr was rejected');
  assert.match(output, /REPLAY_CHILD_TIMEOUT malformed/);
  assert.match(output, /expected: ''/);
});
