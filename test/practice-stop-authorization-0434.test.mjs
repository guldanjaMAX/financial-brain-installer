import assert from 'node:assert/strict';
import test from 'node:test';
import { previewStopAuthorization } from '../practice-run-1125/stop-authorization.mjs';

const clone = value => structuredClone(value);
function fixture() {
  const launcher = { pid: 20, ppid: 1, uid: 501, born: '2026-01-01T00:00:00Z', executable: '/tools/launcher' };
  const invocation = { pid: 30, ppid: 20, uid: 501, born: '2026-01-01T00:01:00Z',
    executable: '/tools/node', entrypoint: '/kit/brain.mjs', runFolder: '/runs/one',
    targetStep: 'tools', argv: ['/kit/brain.mjs', 'technician', '/runs/one/settings.json', '--run', 'tools'] };
  const launchObservation = { launchId: 'observed-launch-one', gated: true, launcher: clone(launcher), invocation: clone(invocation) };
  const processes = [{ pid: 1, ppid: 0, uid: 0, born: 'boot', executable: '/system/init' },
    launcher, invocation, { pid: 31, ppid: 30, uid: 501, born: 'child', executable: '/tools/child' },
    { pid: 40, ppid: 20, uid: 501, born: 'helper', executable: '/kit/helper' }];
  return { launchObservation, observation: { sequence: 1, userId: 501, helperPid: 40, processes } };
}
function fresh(input) { return { ...clone(input.observation), sequence: 2 }; }
function denied(result, label) {
  assert.equal(result.authorizationReached, 1, `${label}: authorization reached`);
  assert.equal(result.authorized, false, `${label}: unauthorized`);
  assert.deepEqual(result.signalRequests, [], `${label}: zero signal requests`);
}
function green(input = fixture()) {
  const preview = previewStopAuthorization(input);
  denied(preview, 'preview');
  assert.equal(preview.reason, null, 'gated invocation selected');
  assert.deepEqual(preview.selectedTree, [31, 30], 'non-empty child-first selection');
  const confirmed = preview.confirm(fresh(input));
  assert.equal(confirmed.authorizationReached, 1);
  assert.equal(confirmed.freshObservationReached, 1);
  assert.equal(confirmed.authorized, true, 'independent launch green control');
  assert.deepEqual(confirmed.signalRequests, [{ pid: 31, signal: 'SIGKILL' }, { pid: 30, signal: 'SIGKILL' }]);
  return preview;
}

test('R1 forged receipt transcript: matching live timer facts cannot prove a launch', () => {
  const input = fixture();
  // Reviewed Windows transcript: same-user Node timer, live facts copied into
  // an edited receipt, no launch ID, preview and hard stop previously accepted.
  const timer = input.observation.processes.find(p => p.pid === 30);
  timer.argv = ['-e', 'setInterval(() => {}, 1000)'];
  timer.entrypoint = '-e';
  input.receipt = { invocation: clone(timer), launcher: clone(input.launchObservation.launcher) };
  delete input.launchObservation;
  const preview = previewStopAuthorization(input);
  denied(preview, 'R1 receipt preview');
  denied(preview.confirm(fresh(input)), 'R1 receipt confirm');
  assert.equal(preview.reason, 'launch-unobserved', 'receipt is never launch proof');
  green();
});

test('R2 exact invocation and birth identity reject every one-field change', () => {
  green();
  const changes = [
    ['born', 'reused-pid'], ['pid', 32], ['ppid', 21], ['uid', 502],
    ['executable', '/decoy/node'], ['entrypoint', '/decoy/brain.mjs'],
    ['runFolder', '/runs/one-more'], ['targetStep', 'doctor'],
    ['argv', ['/kit/brain.mjs', 'technician', '/runs/one/settings.json', '--run', 'tools-extra']],
  ];
  for (const [field, value] of changes) {
    const input = fixture();
    input.observation.processes.find(p => p.pid === 30)[field] = value;
    const preview = previewStopAuthorization(input);
    denied(preview.confirm(fresh(input)), `R2 changed ${field}`);
    assert.ok(preview.reason, `R2 changed ${field}: selection rejected`);
  }
  for (const field of ['launchId', 'gated', 'launcher', 'invocation']) {
    const input = fixture();
    delete input.launchObservation[field];
    const preview = previewStopAuthorization(input);
    denied(preview, `R2 missing ${field}`);
    denied(preview.confirm(fresh(input)), `R2 missing ${field} confirm`);
  }
  for (const field of ['born', 'executable', 'uid']) {
    const input = fixture();
    input.observation.processes.find(p => p.pid === 20)[field] = field === 'uid' ? 502 : 'different';
    denied(previewStopAuthorization(input).confirm(fresh(input)), `R2 launcher ${field}`);
  }
});

test('R3 second observation must preserve ancestry, users, roots and selected tree', () => {
  green();
  const mutations = [
    ['ancestry', o => { o.processes.find(p => p.pid === 31).ppid = 20; }],
    ['another user', o => { o.processes.find(p => p.pid === 31).uid = 502; }],
    ['protected helper ancestry', o => { o.processes.find(p => p.pid === 40).ppid = 31; }],
    ['multiple roots', o => { o.processes.push({ ...clone(o.processes.find(p => p.pid === 30)), pid: 50 }); }],
    ['new child', o => { o.processes.push({ pid: 32, ppid: 30, uid: 501, born: 'new', executable: '/tools/child' }); }],
    ['child birth', o => { o.processes.find(p => p.pid === 31).born = 'reused-child'; }],
    ['root birth', o => { o.processes.find(p => p.pid === 30).born = 'reused-root'; }],
    ['child executable', o => { o.processes.find(p => p.pid === 31).executable = '/other/child'; }],
    ['duplicate pid', o => { o.processes.push(clone(o.processes[0])); }],
    ['incomplete ancestry', o => { o.processes = o.processes.filter(p => p.pid !== 20); }],
    ['stale sequence', o => { o.sequence = 1; }],
    ['different observer user', o => { o.userId = 502; }],
    ['different helper', o => { o.helperPid = 31; }],
  ];
  for (const [label, mutate] of mutations) {
    const input = fixture();
    const preview = previewStopAuthorization(input);
    assert.equal(preview.reason, null, `${label}: preview selected`);
    assert.equal(preview.selectedTree.length, 2, `${label}: decision reached with nonempty plan`);
    const observation = fresh(input);
    mutate(observation);
    const result = preview.confirm(observation);
    assert.equal(result.freshObservationReached, 1, `${label}: second observation reached`);
    denied(result, `R3 ${label}`);
  }
});

test('gated green control is preview-only until confirmed', () => { green(); });

test('R1 receipts cannot supply a missing fresh process observation', () => {
  const input = fixture();
  input.receipt = { ...clone(input.launchObservation), observation: clone(input.observation) };
  delete input.observation;
  const preview = previewStopAuthorization(input);
  denied(preview, 'R1 missing observation');
  denied(preview.confirm(input.receipt.observation), 'R1 receipt observation');
  green();
});

test('R2 missing exact identity fields fail closed without substring matching', () => {
  green();
  for (const field of ['pid', 'ppid', 'uid', 'born', 'executable', 'entrypoint', 'runFolder', 'targetStep', 'argv']) {
    const input = fixture();
    delete input.launchObservation.invocation[field];
    const preview = previewStopAuthorization(input);
    denied(preview.confirm(fresh(input)), `R2 missing invocation ${field}`);
    assert.ok(preview.reason, `${field}: rejected at selection`);
  }
});

test('R3 unsafe initial tables never produce a signal request', () => {
  green();
  for (const mode of ['protected', 'user', 'roots']) {
    const input = fixture();
    if (mode === 'protected') input.observation.processes.find(p => p.pid === 40).ppid = 31;
    if (mode === 'user') input.observation.processes.find(p => p.pid === 31).uid = 502;
    if (mode === 'roots') input.observation.processes.push({ ...clone(input.launchObservation.invocation), pid: 50 });
    const preview = previewStopAuthorization(input);
    denied(preview, `R3 initial ${mode}`);
    denied(preview.confirm(fresh(input)), `R3 initial ${mode} confirm`);
    assert.ok(preview.reason);
  }
});
