import './scheduler-rebind-boundary.mjs';
import { boundaryCalls } from './scheduler-rebind-boundary.mjs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as inventory from '../operations/update-scheduler-inventory.mjs';
import * as core from '../operations/drive-scheduler.mjs';
import * as curatedModule from '../operations/curated-sync-scheduler.mjs';
import * as daemon from '../operations/whatsapp-daemon.mjs';
import * as quickbooks from '../operations/quickbooks-schedule.mjs';
import { buildWhatsappDrainSchedulerPlan } from '../operations/whatsapp-drain-scheduler.mjs';
import { acquireSourceIngestLock, probeSourceIngestLock } from '../operations/source-ingest-lock.mjs';
import { acquireBrainLifecycleLock, writeBrainRecoveryFence, clearBrainRecoveryFence } from '../operations/brain-lifecycle-lock.mjs';
import { loadCuratedSyncPlan, prepareCuratedCorpus, runCuratedDualSync } from '../operations/curated-dual-sync.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
// Exercise the exact orchestration bodies without starting the CLI dispatcher.
const cli = readFileSync(join(root, 'brain.mjs'), 'utf8');
const bodies = cli.slice(cli.indexOf('async function pauseCapturedOwnedSchedulers('), cli.indexOf('async function hydrateExistingOwnedSchedulerSnapshots('));
const binding = `import { readFileSync } from 'node:fs';
import { pauseAdditionalUpdateScheduler, restoreAdditionalUpdateScheduler } from '${new URL('../operations/update-scheduler-inventory.mjs', import.meta.url).href}';
const loadManifest = path => ({ m: JSON.parse(readFileSync(path, 'utf8')) });`;
const { pauseCapturedOwnedSchedulers, restoreExistingOwnedSchedulers } = await import('data:text/javascript;base64,' + Buffer.from(binding + bodies.replaceAll('async function ', 'export async function ')).toString('base64'));


const uid = process.getuid?.() ?? 501;
const homes = [];
const decode = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
function parsePlist(bytes) {
  const text = String(bytes);
  const field = name => decode(text.match(new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? '');
  const args = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u)?.[1] ?? '';
  return { Label: field('Label'), WorkingDirectory: field('WorkingDirectory'),
    EnvironmentVariables: { BRAIN_MANIFEST_PATH: field('BRAIN_MANIFEST_PATH'), WA_DATA_DIR: field('WA_DATA_DIR') },
    ProgramArguments: [...args.matchAll(/<string>([^<]*)<\/string>/gu)].map(match => decode(match[1])),
    RunAtLoad: /<key>RunAtLoad<\/key>\s*<true\s*\/>/u.test(text) };
}
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rebind-case-')));
  homes.push(home);
  const manifestPath = join(home, 'brain.manifest.json');
  const keyPath = join(home, 'fixture-admin');
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  const m = { client: { slug: 'fixture', timezone: 'UTC' },
    brain: { version: '0.4.22', domain: 'brain.example.invalid', worker_name: 'fixture-brain' },
    infrastructure: { cloudflare: { storage: 'd1', account_id: '1'.repeat(32), d1_database_id: '11111111-2222-4333-8444-555555555555' } },
    corpora: { whatsapp: { enabled: true } }, operations: { admin_key_secret: `file://${keyPath}` } };
  writeFileSync(manifestPath, JSON.stringify(m), { mode: 0o600 });
  const loaded = new Map(), disabled = new Set(), calls = [], starts = [];
  const native = { platform: 'darwin', uid, home, nodePath: process.execPath,
    brainPath: join(root, 'brain.mjs'), parseInstalledPlist: parsePlist, localTimeZone: 'UTC',
    lockProbeSpawn: () => ({ status: 0 }) };
  native.launchctl = args => {
    calls.push(args);
    if (args[0] === 'list') return { status: 0, stdout: `PID Status Label\n${[...loaded.keys()].map(service => `- 0 ${service.split('/').at(-1)}`).join('\n')}\n` };
    if (args[0] === 'print-disabled') return { status: 0, stdout: `disabled services = {\n${[...disabled].map(service => `"${service.split('/').at(-1)}" => true`).join('\n')}\n}` };
    if (args[0] === 'disable') disabled.add(args[1]);
    if (args[0] === 'enable') disabled.delete(args[1]);
    if (args[0] === 'print') {
      const item = loaded.get(args[1]);
      if (!item) return { status: 113, stderr: 'not found' };
      return { status: 0, stdout: `path = ${item.path}\nstate = ${item.state ?? 'waiting'}\nproperties = ${item.runAtLoad ? 'runatload' : 'none'}\narguments = {\n${item.args.join('\n')}\n}\n` };
    }
    if (args[0] === 'bootout') loaded.delete(args[1]);
    if (args[0] === 'bootstrap') {
      const definition = parsePlist(readFileSync(args[2]));
      const service = `${args[1]}/${definition.Label}`;
      if (disabled.has(service)) return { status: 5, stderr: 'disabled' };
      loaded.set(service, { path: args[2], args: definition.ProgramArguments, runAtLoad: definition.RunAtLoad });
      // Model launchd's documented RunAtLoad trigger without executing the job.
      if (definition.RunAtLoad) starts.push(definition.ProgramArguments[2] ?? 'resident');
    }
    return { status: 0, stdout: '' };
  };
  const options = { platform: 'darwin', schedulerOptions: { home }, legacySchedulerOptions: native };
  function installFile(plan, text, isDisabled = false) {
    mkdirSync(dirname(plan.plistPath), { recursive: true, mode: 0o700 });
    writeFileSync(plan.plistPath, text, { mode: 0o600 });
    if (isDisabled) disabled.add(plan.service);
    else loaded.set(plan.service, { path: plan.plistPath, args: plan.programArguments });
  }
  return { home, manifestPath, m, native, options, loaded, disabled, calls, starts, installFile };
}
function addDrain(f, { stale = false, disabled = false } = {}) {
  const plan = buildWhatsappDrainSchedulerPlan(f.manifestPath, { ...f.native,
    ...(stale ? { brainPath: join(f.home, 'old-runtime', 'brain.mjs') } : {}) });
  f.installFile(plan, core.renderLaunchAgentPlist(plan), disabled);
  return plan;
}
function addCurated(f, { stale = false, disabled = false } = {}) {
  const planPath = join(f.home, 'curated-plan.json');
  writeFileSync(planPath, JSON.stringify({ schema_version: 1, root: 'corpus', expected_documents: 1,
    expected_roles: { authoritative: 1, superseded: 0, plain: 0 }, ledger_namespace: 'fixture-curated-namespace',
    documents: [{ relative_path: 'fixture.md', role: 'authoritative', legacy_source_type: 'curated', legacy_source_id: 'fixture-id', metadata: {} }],
    transforms: Object.fromEntries(['authoritative', 'superseded', 'plain'].map(role => [role, { content_prefix: '', title_prefix: '' }])),
    common_metadata: {}, cloudflare_target: { manifest: f.manifestPath, backend: 'cloudflare_d1' },
    ledger_file: 'curated-ledger.json', scheduler: { slug: 'fixture-curated', cron: '10 7 * * *', timezone: 'UTC' } }), { mode: 0o600 });
  const plan = curatedModule.buildCuratedSchedulerPlan(planPath, { ...f.native,
    ...(stale ? { schedulerPath: join(f.home, 'old-runtime', 'curated-sync-scheduler.mjs') } : {}) });
  f.installFile(plan, curatedModule.renderCuratedLaunchAgentPlist(plan), disabled);
  return plan;
}
function addDaemon(f, disabled) {
  f.options.whatsappDaemonOptions = { binaryPath: process.execPath };
  const plan = daemon.buildWhatsappDaemonPlan(f.manifestPath, { ...f.native, binaryPath: process.execPath });
  f.installFile(plan, daemon.renderDaemonPlist(plan), disabled);
  return plan;
}
async function captureOne(f, kind) {
  const entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options);
  const entry = entries.find(item => item.snapshot.jobKind === kind);
  assert.ok(entry, 'owned job decision reached');
  assert.ok(f.calls.some(call => call[0] === 'print' && call[1] === entry.snapshot.service), 'native definition inspected');
  return entry;
}
async function rebind(f, kind) {
  const entry = await captureOne(f, kind);
  await inventory.pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entry, f.options);
  const row = await inventory.reconcileAdditionalUpdateScheduler(f.m, f.manifestPath, entry, f.options);
  await inventory.verifyUpdateSchedulerInventory(f.m, f.manifestPath, [entry], f.options);
  inventory.releaseUpdateSchedulerReservations([entry]);
  return { entry, row };
}
const cases = [];
const check = (id, body) => cases.push({ id, body });
for (const kind of ['whatsapp-drain', 'curated-sync']) check(`CONTROL-load-time-counter-${kind}`, async facts => {
  const f = fixture();
  if (kind === 'curated-sync') {
    const plan = addCurated(f);
    curatedModule.reinstallScheduledCuratedSync(plan.path, f.native);
  } else {
    addDrain(f);
    core.installScheduler(f.manifestPath, { ...f.native, spec: (await import('../operations/whatsapp-drain-scheduler.mjs')).WHATSAPP_DRAIN_SCHEDULER_SPEC });
  }
  facts.decisionReached = f.calls.some(call => call[0] === 'bootstrap');
  assert.equal(f.starts.length, 1, 'the synthetic native trigger observes ordinary load-time runs');
});
check('CONTROL-disabled-drain-rebind', async facts => {
  const f = fixture(), plan = addDrain(f, { stale: true, disabled: true });
  const { row, entry } = await rebind(f, 'whatsapp-drain');
  await inventory.verifyUpdateSchedulerInventory(f.m, f.manifestPath, [entry], f.options);
  facts.decisionReached = f.calls.some(call => call[0] === 'disable');
  facts.state = row.state; facts.starts = f.starts.length;
  assert.equal(row.state, 'moved'); assert.equal(f.disabled.has(plan.service), true); assert.equal(f.starts.length, 0);
});
for (const stale of [false, true]) check(`R1-disabled-curated-registration-${stale ? 'stale' : 'current'}`, async facts => {
  const f = fixture(), plan = addCurated(f, { stale, disabled: true });
  const { row } = await rebind(f, 'curated-sync');
  facts.decisionReached = f.calls.some(call => call[0] === 'disable');
  assert.equal(row.state, stale ? 'moved' : 'already current');
  assert.equal(f.disabled.has(plan.service), true);
  assert.equal(f.loaded.has(plan.service), false);
  assert.equal(f.starts.length, 0);
  assert.ok(f.calls.every(call => call[0] !== 'bootstrap'));
});
for (const kind of ['whatsapp-drain', 'curated-sync']) check(`R1-no-start-on-${kind}-rebind`, async facts => {
  const f = fixture();
  if (kind === 'curated-sync') addCurated(f, { stale: true }); else addDrain(f, { stale: true });
  const { row } = await rebind(f, kind);
  facts.decisionReached = f.calls.some(call => call[0] === 'bootstrap');
  facts.state = row.state; facts.starts = f.starts.length;
  assert.equal(row.state, 'moved'); assert.equal(f.starts.length, 0, 'rebind must not request a data job');
});
check('R1-second-current-curated-update-has-no-new-start', async facts => {
  const f = fixture(); addCurated(f, { stale: true });
  const first = await rebind(f, 'curated-sync'); assert.equal(first.row.state, 'moved');
  const before = f.starts.length;
  const second = await rebind(f, 'curated-sync');
  facts.decisionReached = f.calls.filter(call => call[0] === 'bootstrap').length === 2;
  facts.state = second.row.state; facts.extraStarts = f.starts.length - before;
  assert.equal(second.row.state, 'already current'); assert.equal(f.starts.length - before, 0);
});
for (const policy of ['none', 'runatload', 'unknown']) check(`R1-loaded-policy-${policy}`, async facts => {
  const f = fixture(); addDrain(f, { stale: true });
  const { entry } = await rebind(f, 'whatsapp-drain');
  const nativeLaunch = f.native.launchctl;
  f.native.launchctl = args => {
    const result = nativeLaunch(args);
    if (args[0] === 'print' && result.status === 0) result.stdout = result.stdout.replace(/properties = [^\n]*\n/u,
      policy === 'unknown' ? '' : `properties = ${policy}\n`);
    return result;
  };
  let failure;
  try { await inventory.verifyUpdateSchedulerInventory(f.m, f.manifestPath, [entry], f.options); } catch (error) { failure = error; }
  facts.decisionReached = f.calls.some(call => call[0] === 'print' && call[1] === entry.snapshot.service);
  assert.equal(Boolean(failure), policy !== 'none');
});
for (const kind of ['whatsapp-drain', 'curated-sync', 'whatsapp-daemon']) check(`${kind === 'whatsapp-drain' ? 'CONTROL' : 'R2'}-disabled-${kind}-rollback`, async facts => {
  const f = fixture();
  const plan = kind === 'curated-sync' ? addCurated(f, { disabled: true }) : kind === 'whatsapp-daemon' ? addDaemon(f, true) : addDrain(f, { disabled: true });
  const entry = await captureOne(f, kind);
  assert.equal(entry.snapshot.wasDisabled, true);
  await inventory.pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entry, f.options);
  const before = f.calls.length;
  await inventory.restoreAdditionalUpdateScheduler(f.m, f.manifestPath, entry, f.options);
  facts.decisionReached = f.calls.slice(before).some(call => ['disable', 'enable'].includes(call[0]));
  facts.disabledAfterRestore = f.disabled.has(plan.service);
  facts.loadedAfterRestore = f.loaded.has(plan.service);
  assert.equal(f.disabled.has(plan.service), true); assert.equal(f.loaded.has(plan.service), false);
});
for (const busy of [false, true]) check(`${busy ? 'R4' : 'CONTROL'}-curated-source-lock`, async facts => {
  const f = fixture(); addCurated(f);
  const lockOptions = { sourceName: 'curated', statePath: join(f.home, 'curated-ledger.json'), home: f.home, isOwnerAlive: () => true };
  const lease = busy ? acquireSourceIngestLock(lockOptions) : null;
  try {
    const lockState = probeSourceIngestLock(lockOptions);
    assert.equal(lockState.busy, busy);
    let entries, failure;
    try { entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options); } catch (error) { failure = error; }
    facts.decisionReached = f.calls.some(call => call[0] === 'print');
    facts.lockHeld = lockState.busy; facts.refused = Boolean(failure); facts.entries = entries?.length ?? 0;
    if (busy) assert.equal(Boolean(failure), true, 'held source lease must refuse update capture');
    else { assert.equal(failure, undefined); assert.equal(entries.length, 1); }
  } finally { lease?.release(); }
});
for (const running of [false, true]) check(`CONTROL-native-curated-${running ? 'running' : 'idle'}`, async facts => {
  const f = fixture(), plan = addCurated(f);
  if (running) f.loaded.get(plan.service).state = 'running';
  let failure, entries;
  try { entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options); } catch (error) { failure = error; }
  facts.decisionReached = f.calls.some(call => call[0] === 'print');
  facts.refused = Boolean(failure);
  assert.equal(Boolean(failure), running);
  if (!running) assert.equal(entries.length, 1);
  assert.ok(f.calls.every(call => ['print', 'list', 'print-disabled'].includes(call[0])));
});
check('R4-source-reservation-spans-pause-rebind-and-acceptance', async facts => {
  const f = fixture(); addCurated(f, { stale: true });
  const entry = await captureOne(f, 'curated-sync');
  const lockOptions = { sourceName: 'curated', statePath: join(f.home, 'curated-ledger.json'), home: f.home };
  const competingWriter = () => {
    facts.decisionReached = true;
    assert.throws(() => acquireSourceIngestLock(lockOptions), { code: 'source_ingest_already_running' });
  };
  try {
    competingWriter();
    await inventory.pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entry, f.options);
    competingWriter();
    const row = await inventory.reconcileAdditionalUpdateScheduler(f.m, f.manifestPath, entry, f.options);
    assert.equal(row.state, 'moved'); competingWriter();
    await inventory.verifyUpdateSchedulerInventory(f.m, f.manifestPath, [entry], f.options);
    competingWriter();
    assert.equal(f.starts.length, 0);
  } finally { inventory.releaseUpdateSchedulerReservations([entry]); }
  const control = acquireSourceIngestLock(lockOptions); control.release();
});
for (const busy of [false, true]) check(`R4-advisory-lock-${busy ? 'busy' : 'idle'}`, async facts => {
  const f = fixture(), plan = addCurated(f);
  mkdirSync(dirname(plan.lockPath), { recursive: true, mode: 0o700 });
  writeFileSync(plan.lockPath, '', { mode: 0o600 });
  let probes = 0;
  f.native.lockProbeSpawn = () => { probes++; return { status: busy ? 75 : 0 }; };
  let failure, entries;
  try { entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options); } catch (error) { failure = error; }
  facts.decisionReached = probes > 0;
  assert.equal(Boolean(failure), busy);
  inventory.releaseUpdateSchedulerReservations(entries || []);
});
for (const barrier of ['none', 'update-lease', 'recovery-fence']) check(`R1-curated-writer-${barrier}`, async facts => {
  const f = fixture(), plan = addCurated(f);
  mkdirSync(join(f.home, 'corpus'), { mode: 0o700 });
  writeFileSync(join(f.home, 'corpus', 'fixture.md'), '# Synthetic document\nFixture body.\n', { mode: 0o600 });
  const machineLockRoot = join(f.home, 'machine-locks');
  const lockOptions = { manifestPath: f.manifestPath, machineLockRoot };
  let lock;
  const transactionId = '1'.repeat(32);
  if (barrier === 'update-lease') lock = acquireBrainLifecycleLock({ ...lockOptions, operation: 'update' });
  if (barrier === 'recovery-fence') writeBrainRecoveryFence({ ...lockOptions, transactionId });
  let credentials = 0, writes = 0, requests = 0, failure, report;
  const document = prepareCuratedCorpus(plan.curatedPlan, { planDirectory: f.home }).documents[0];
  try {
    try { report = await runCuratedDualSync(plan.curatedPlan, {
      mode: 'sync', planDirectory: f.home, home: f.home, lifecycleLockOptions: { machineLockRoot },
      resolveTarget: () => { credentials++; return { backend: 'cloudflare_d1', baseUrl: 'https://brain.example.invalid', adminKey: randomBytes(32).toString('hex') }; },
      fetch: async (url, options) => {
        requests++;
        const body = JSON.parse(options.body);
        let value;
        if (url.endsWith('/ingest')) { writes++; value = { action: 'unchanged', doc_uid: `curated:${body.source_id}` }; }
        else if (url.endsWith('/source-families')) value = { source: 'curated', families: [`curated:${document.cloudflareEnvelope.source_id}`], next_cursor: null };
        else value = { confirmed: true, doc_uid: `curated:${body.source_id}`, envelope_sha256: document.envelopeHash };
        return { ok: true, status: 200, text: async () => JSON.stringify(value) };
      },
    }); } catch (error) { failure = error; }
    facts.decisionReached = plan.targetManifestFingerprints.cloudflare.length > 0;
    if (barrier === 'none') {
      assert.ifError(failure); assert.equal(report.ok, true); assert.equal(credentials, 1); assert.equal(writes, 1); assert.equal(requests, 3);
    } else {
      assert.match(failure?.message || '', /already running or local lock/);
      assert.equal(credentials, 0); assert.equal(writes, 0); assert.equal(requests, 0);
    }
  } finally {
    lock?.release();
    if (barrier === 'recovery-fence') clearBrainRecoveryFence({ ...lockOptions, transactionId });
  }
});
for (const failureMode of ['none', 'before-effect', 'after-effect']) check(`${failureMode === 'before-effect' ? 'R7' : 'CONTROL'}-partial-pause-${failureMode}`, async facts => {
  const f = fixture(), plan = addCurated(f);
  const entry = await captureOne(f, 'curated-sync');
  const launch = f.native.launchctl;
  let attemptedBootout = false;
  f.native.launchctl = args => {
    if (args[0] === 'bootout' && !attemptedBootout) {
      attemptedBootout = true;
      if (failureMode === 'before-effect') return { status: 5, stderr: 'synthetic refusal' };
      const result = launch(args);
      if (failureMode === 'after-effect') return { status: 5, stderr: 'synthetic lost acknowledgement' };
      return result;
    }
    return launch(args);
  };
  let pauseFailure, restoreFailure;
  try { await pauseCapturedOwnedSchedulers(f.manifestPath, [entry], f.options); } catch (error) { pauseFailure = error; }
  // The update's outer pre-mutation catch makes this same restore call.
  try { await restoreExistingOwnedSchedulers(f.manifestPath, [entry], f.options); } catch (error) { restoreFailure = error; }
  facts.decisionReached = attemptedBootout;
  facts.pauseFailed = Boolean(pauseFailure); facts.restoreFailed = Boolean(restoreFailure);
  facts.disabledAfterRollback = f.disabled.has(plan.service); facts.loadedAfterRollback = f.loaded.has(plan.service);
  assert.equal(Boolean(pauseFailure), failureMode !== 'none');
  assert.equal(Boolean(restoreFailure), false);
  assert.equal(f.disabled.has(plan.service), false); assert.equal(f.loaded.has(plan.service), true);
});
for (const failRestore of [false, true]) check(`R7-restores-every-attempted-job-${failRestore ? 'partial' : 'healthy'}`, async facts => {
  const f = fixture(), calls = [];
  const snapshots = [
    { kind: 'drive', snapshot: { exists: true }, module: { restoreDriveScheduler: () => { calls.push('drive'); } } },
    { kind: 'folder', snapshot: { exists: true }, module: { restoreFolderScheduler: () => {
      calls.push('folder'); if (failRestore) throw new Error('synthetic restore refusal');
    } } },
  ];
  let failure;
  try { await restoreExistingOwnedSchedulers(f.manifestPath, snapshots, f.options); } catch (error) { failure = error; }
  facts.decisionReached = calls.length > 0;
  assert.deepEqual(calls, ['folder', 'drive'], 'a failed restoration cannot hide another affected entry');
  assert.equal(Boolean(failure), failRestore);
  if (failure) assert.match(failure.message, /folder: prior state remains unverified/);
});
function windowsFixture({ enabled = true, nativeXml = true } = {}) {
  const f = fixture();
  f.m.corpora = { quickbooks: { enabled: true } };
  f.m.operations.quickbooks_schedule = { enabled: true, timezone: 'UTC' };
  writeFileSync(f.manifestPath, JSON.stringify(f.m), { mode: 0o600 });
  const options = { platform: 'win32', principal: 'sid:S-1-5-21-100-200-300-1001', localTimezone: 'UTC', now: new Date('2026-01-01T00:00:00Z') };
  const plan = quickbooks.planQuickBooksSchedule({ m: f.m, manifestPath: f.manifestPath, ...options });
  const paths = { platform: 'win32', home: f.home, nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`, runnerPath: String.raw`C:\Runtime\quickbooks-schedule.mjs` };
  const desired = quickbooks.buildQuickBooksScheduleDefinition(plan, paths);
  const setXmlEnabled = (text, value) => text.replace(/(<Settings>[\s\S]*?<Enabled>)(true|false)(<\/Enabled>)/u, `$1${value}$3`);
  let xml = setXmlEnabled(desired.serialized, enabled);
  let state = { exists: true, owned: true, enabled, definition: desired };
  const events = [], nativeCalls = [];
  const spawn = (_command, args) => {
    nativeCalls.push(args);
    events.push(args[0]);
    if (args[0] === '/Query') {
      if (args.includes('/FO')) return { status: 0, stdout: '"\\Other\\Task","N/A","Ready"\r\n' };
      return xml === null ? { status: 1, stdout: '' } : { status: 0, stdout: xml };
    }
    if (args[0] === '/Change') { xml = setXmlEnabled(xml, args.includes('/ENABLE')); return { status: 0, stdout: '' }; }
    if (args[0] === '/Create') { xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf16le').replace(/^\ufeff/u, ''); return { status: 0, stdout: '' }; }
    throw new Error('unexpected synthetic Windows operation');
  };
  const adapter = nativeXml ? quickbooks.createQuickBooksScheduleAdapter({ ...paths, spawn, environment: { SystemRoot: String.raw`C:\Windows` } }) : {
    read: () => { events.push('read'); return state; },
    setEnabled: (_identity, value) => { events.push('setEnabled'); state = { ...state, enabled: value }; },
    install: definition => { events.push('install'); state = { exists: true, owned: true, enabled: true, definition }; },
  };
  options.quickBooksSchedulerOptions = { ...paths, adapter, runtimeUsable: () => true };
  return { ...f, options, plan, desired, adapter, events, nativeCalls, setState: value => { state = value; },
    replaceXml: value => { xml = value === null ? null : setXmlEnabled(value.serialized, enabled); } };
}
for (const nativeXml of [false, true]) check(`${nativeXml ? 'R3' : 'CONTROL'}-Windows-enabled-pause`, async facts => {
  const f = windowsFixture({ nativeXml });
  const entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options);
  assert.equal(entries.length, 1);
  let failure;
  try { await inventory.pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], f.options); } catch (error) { failure = error; }
  facts.decisionReached = f.events.includes(nativeXml ? '/Change' : 'setEnabled');
  const after = f.adapter.read(f.plan.identity);
  facts.paused = after.enabled === false;
  facts.immutableContractUnchanged = after.definition.native_definition_hash === entries[0].snapshot.state.definition.native_definition_hash;
  facts.xmlChanged = after.definition.serialized !== entries[0].snapshot.serialized;
  facts.pauseAccepted = !failure;
  facts.failureCode = failure ? (failure.message === 'QuickBooks pause readback failed' ? 'PAUSE_XML_MISMATCH' : 'OTHER') : null;
  assert.equal(facts.paused, true); assert.equal(facts.immutableContractUnchanged, true); assert.equal(failure, undefined);
});
check('CONTROL-Windows-already-disabled-pause', async facts => {
  const f = windowsFixture({ enabled: false });
  const entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options);
  assert.equal(entries.length, 1);
  await inventory.pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], f.options);
  facts.decisionReached = f.events.includes('/Change'); facts.enabled = f.adapter.read(f.plan.identity).enabled;
  assert.equal(facts.enabled, false);
});
for (const enabled of [true, false]) check(`R3-Windows-native-rebind-${enabled ? 'enabled' : 'disabled'}`, async facts => {
  const f = windowsFixture({ enabled });
  const old = quickbooks.buildQuickBooksScheduleDefinition(f.plan, { ...f.options.quickBooksSchedulerOptions,
    nodePath: String.raw`C:\OldRuntime\node.exe` });
  f.replaceXml(old);
  const entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options);
  assert.equal(entries.length, 1);
  await inventory.pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], f.options);
  const row = await inventory.reconcileAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], f.options);
  facts.decisionReached = f.nativeCalls.some(args => args[0] === '/Create');
  assert.equal(row.state, 'moved');
  assert.equal(f.adapter.read(f.plan.identity).enabled, enabled);
  if (!enabled) assert.ok(f.nativeCalls.every(args => !args.includes('/ENABLE')), 'disabled XML is installed directly');
  await inventory.verifyUpdateSchedulerInventory(f.m, f.manifestPath, entries, f.options);
});
for (const drift of ['current', 'missing', 'stale']) check(`${drift === 'current' ? 'CONTROL' : 'R5'}-Windows-disabled-final-${drift}`, async facts => {
  const f = windowsFixture({ enabled: false });
  const entries = await inventory.captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options);
  assert.equal(entries.length, 1);
  if (drift === 'missing') f.replaceXml(null);
  if (drift === 'stale') {
    const old = quickbooks.buildQuickBooksScheduleDefinition(f.plan, { ...f.options.quickBooksSchedulerOptions, nodePath: String.raw`C:\OldRuntime\node.exe` });
    f.replaceXml(old);
  }
  const before = f.events.length;
  let failure;
  try { await inventory.verifyUpdateSchedulerInventory(f.m, f.manifestPath, entries, f.options); } catch (error) { failure = error; }
  facts.decisionReached = f.events.length >= before + 2; facts.drift = drift; facts.accepted = !failure;
  assert.equal(Boolean(failure), drift !== 'current');
});

for (const { id, body } of cases) test(id, {
  skip: process.platform === 'win32' && !id.includes('Windows') && 'macOS fixtures require POSIX ownership',
}, async () => {
  const facts = { decisionReached: false };
  await body(facts);
  assert.equal(facts.decisionReached, true, 'the native decision was reached');
});
test.after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  assert.deepEqual(boundaryCalls, [], 'offline boundaries stayed injected');
});
