import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProviderSchedulerPlan } from '../operations/provider-scheduler.mjs';
import * as brain from '../brain.mjs';
import * as qb from '../operations/quickbooks-schedule.mjs';
const root = mkdtempSync(join(tmpdir(), 'qb-schedule-'));
const path = join(root, 'brain.manifest.json');
const fixture = () => ({ client: { slug: 'fixture', timezone: 'America/Phoenix' },
  brain: { domain: 'brain.example.invalid' }, corpora: { quickbooks: { enabled: true, source: 'ledger', environment: 'sandbox' }, google_drive: { enabled: true } },
  operations: { quickbooks_schedule: { enabled: true }, daily_refresh: { enabled: true } } });
const now = new Date('2026-07-01T14:00:00.000Z');
const mac = { platform: 'darwin', uid: 501, home: root, localTimeZone: 'America/Phoenix', now };

test('opted-in macOS provider uses two times and the guarded runner; legacy owners keep their old definition', () => {
  writeFileSync(path, JSON.stringify(fixture()));
  const plan = buildProviderSchedulerPlan('quickbooks', path, mac);
  assert.deepEqual(plan.intervals, [{ Minute: 0, Hour: 7 }, { Minute: 0, Hour: 16 }]);
  assert.equal(plan.expectedRefreshSeconds, 86400);
  assert.equal(plan.spec.childArgumentsOf(plan)[0], 'quickbooks-run');
  const legacy = fixture(); delete legacy.operations.quickbooks_schedule;
  writeFileSync(path, JSON.stringify(legacy));
  const unchanged = buildProviderSchedulerPlan('quickbooks', path, mac);
  assert.equal(unchanged.cron, '0 2 * * *');
  assert.equal(unchanged.spec.childArgumentsOf(unchanged)[0], 'ingest');
});

test('Windows ownership reaches QuickBooks status and delegates both legs only on exact healthy readback', async () => {
  let inspections = 0;
  for (const healthy of [false, true]) {
    const m = fixture(); m.corpora.quickbooks_desktop = { enabled: true };
    const plan = await brain.buildConfiguredDailyPlan(m, path, { platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix',
      planLoad: async () => Object.keys(m.corpora).map(key => ({ key, status: 'ready' })),
      quickBooksScheduler: { planQuickBooksSchedule: () => ({ identity: { id: 'fixture' } }), statusQuickBooksSchedule: () => { inspections++; return { installed: true, enabled: true, verified: healthy }; } },
    });
    assert.equal(inspections, healthy ? 2 : 1);
    for (const key of qb.QUICKBOOKS_KEYS) assert.equal(plan.sources.find(s => s.key === key).owner, healthy ? 'existing-local-scheduler' : 'daily-task');
  }
});

test('re-registration reaches the existing daily-on contract and refuses its failed readback before reporting success', async () => {
  let daily = 0; let registrations = 0; let restores = 0;
  const m = fixture();
  for (const healthy of [false, true]) {
    writeFileSync(path, JSON.stringify(m));
    const options = { platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix', now,
      withBrainLifecycleLock: async (_input, run) => run({ assertOwned() {} }),
      cli: { buildConfiguredDailyPlan: async () => ({ identity: { id: 'v1-fixture' } }),
        cmdDaily: async (argv) => { daily++; assert.deepEqual(argv, ['on', path]); return { schedule: { installed: true, enabled: true, verified: healthy } }; } },
      dailyStatus: () => ({ installed: false }), restoreDaily: () => { restores++; },
      quickBooksStatus: () => ({ installed: false, state: null }),
      quickBooksRegister: () => { registrations++; return { installed: true, enabled: true, verified: true }; },
      quickBooksRestore: () => { restores++; }, syncExpectations: async () => {},
    };
    if (!healthy) {
      await assert.rejects(qb.reregisterAfterManifestChange(path, options), { code: 'SCHEDULE_INSTALL_FAILED' });
      assert.equal(daily, 1); assert.equal(registrations, 0); assert.ok(restores >= 1);
    } else {
      const result = await qb.reregisterAfterManifestChange(path, options);
      assert.equal(result.verified, true); assert.equal(daily, 2); assert.equal(registrations, 1);
    }
  }
});

import { installProviderScheduler, snapshotQuickBooksProviderScheduler } from '../operations/provider-scheduler.mjs';
import { statusDailyRefreshSchedule } from '../operations/daily-refresh-scheduler.mjs';

function nativeMemory(initial = null) {
  let state = initial; let writes = 0; let reads = 0;
  return { get state() { return state; }, get writes() { return writes; }, get reads() { return reads; },
    read() { reads++; return state; },
    install(definition) { writes++; state = { exists: true, owned: true, enabled: true, definition }; },
    setEnabled(_identity, enabled) { state = { ...state, enabled }; },
    remove() { state = null; writes++; },
  };
}

test('real daily-on rebinds whole-manifest approval, is idempotent, and restores exact prior tasks if QuickBooks registration fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-rebind-'));
  const manifest = join(home, 'brain.manifest.json');
  const m = fixture(); writeFileSync(manifest, JSON.stringify(m));
  const daily = nativeMemory(); const quickbooks = nativeMemory();
  const native = { platform: 'win32', home, nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\operations\daily-refresh-run.mjs`, nodeRealpath: p => p, nodePathExists: () => true,
    nodePathStat: () => ({ isFile: () => true }), nodePathAccess() {}, runnerPathUsable: () => true };
  const qbNative = { ...native, runnerPath: String.raw`C:\Runtime\operations\quickbooks-schedule.mjs`, runtimeUsable: () => true, adapter: quickbooks };
  let planning = 0; let lockCalls = 0; let expectations = 0;
  const keyFile = join(home, 'fixture-key-file'); writeFileSync(keyFile, 'synthetic-fixture-material', { mode: 0o600 });
  const opts = { platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix', now,
    withBrainLifecycleLock: async (_input, run) => { lockCalls++; return run({ assertOwned() {} }); },
    planLoad: async ({ m: current }) => { planning++; return Object.keys(current.corpora).map(key => ({ key, status: 'ready' })); },
    schedulerOptions: native, schedulerAdapter: daily, quickBooksSchedulerOptions: qbNative,
    resolveAdminKey: () => readFileSync(keyFile, 'utf8'), resolveBaseUrl: async () => 'https://brain.example.invalid',
    postSourceExpectation: async (_base, _key, body) => { expectations++; assert.equal(body.expected_refresh_seconds, 86400); },
    readSourceInventory: async () => ({ sources: [] }),
  };
  const first = await qb.reregisterAfterManifestChange(manifest, opts);
  assert.equal(first.verified, true); assert.ok(planning >= 2); assert.ok(expectations >= 2);
  const originalDaily = structuredClone(daily.state); const originalQuickBooks = structuredClone(quickbooks.state);
  const nativeWrites = daily.writes + quickbooks.writes;
  await qb.reregisterAfterManifestChange(manifest, opts);
  assert.equal(daily.writes + quickbooks.writes, nativeWrites, 'repeating the transaction does not replace matching tasks');
  m.corpora.quickbooks.source = 'ledger-next'; writeFileSync(manifest, JSON.stringify(m));
  let registrations = 0;
  await assert.rejects(qb.reregisterAfterManifestChange(manifest, { ...opts, quickBooksRegister() { registrations++; throw new Error('fixture registration refusal'); } }), { code: 'SCHEDULE_INSTALL_FAILED' });
  assert.equal(registrations, 1); assert.equal(lockCalls, 3);
  assert.deepEqual(daily.state, originalDaily); assert.deepEqual(quickbooks.state, originalQuickBooks);
  const changedPlan = await brain.buildConfiguredDailyPlan(m, manifest, { ...opts, existingSchedulerOwners: ['quickbooks', 'quickbooks_desktop'] });
  assert.equal(statusDailyRefreshSchedule(changedPlan, { ...native, adapter: daily }).verified, false, 'the safe old daily task refuses the changed manifest');
});

test('macOS registration reads the loaded argv and restores the old plist after a failed exact readback', () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-provider-'));
  const manifest = join(home, 'brain.manifest.json'); writeFileSync(manifest, JSON.stringify(fixture()));
  let loaded = null; let prints = 0; let installs = 0; let failNextRead = false;
  const argumentsIn = xml => [...(xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u)?.[1] || '').matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(m => m[1]);
  const options = { ...mac, home, nodePath: process.execPath, launchctl(args) {
    if (args[0] === 'print') {
      prints++;
      if (!loaded) return { status: 113 };
      const argv = argumentsIn(loaded);
      if (failNextRead) { failNextRead = false; argv[0] = '/fixture/wrong-node'; }
      return { status: 0, stdout: `state = waiting\narguments = {\n${argv.join('\n')}\n}\n` };
    }
    if (args[0] === 'bootstrap') { installs++; loaded = readFileSync(args[2], 'utf8'); return { status: 0 }; }
    if (args[0] === 'bootout') { loaded = null; return { status: 0 }; }
    assert.equal(args[0], 'enable'); return { status: 0 };
  } };
  const first = installProviderScheduler('quickbooks', manifest, options);
  assert.equal(first.verified, true); assert.equal(installs, 1); assert.ok(prints >= 3);
  const before = readFileSync(first.plistPath, 'utf8');
  assert.equal(installProviderScheduler('quickbooks', manifest, options).changed, false);
  assert.equal(installs, 1);
  const changed = fixture(); changed.corpora.quickbooks.source = 'ledger-next'; writeFileSync(manifest, JSON.stringify(changed));
  const launchctl = options.launchctl;
  const failed = { ...options, launchctl(args) {
    const result = launchctl(args); if (args[0] === 'bootstrap' && installs === 2) failNextRead = true; return result;
  } };
  assert.throws(() => installProviderScheduler('quickbooks', manifest, failed), /exact readback/u);
  assert.equal(installs, 3, 'a failed replacement and the previous definition both reached bootstrap');
  assert.equal(readFileSync(first.plistPath, 'utf8'), before); assert.equal(loaded, before);
  assert.equal(snapshotQuickBooksProviderScheduler(manifest, options).verified, false, 'old definition is safe but requires rebind');
});

test('macOS schedule-off verifies native removal and retains the previous definition when bootout did not stop it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-remove-'));
  const manifest = join(home, 'brain.manifest.json'); writeFileSync(manifest, JSON.stringify(fixture()));
  let loaded = null; let ignoredStops = 1; let stops = 0; let daily = 0;
  const options = { ...mac, home, quiet: true, localTimezone: 'America/Phoenix', nodePath: process.execPath,
    withBrainLifecycleLock: async (_input, run) => run({ assertOwned() {} }), syncExpectations: async () => {},
    cli: { buildConfiguredDailyPlan: async () => ({ identity: { id: 'v1-fixture' } }),
      cmdDaily: async () => { daily++; return { schedule: { installed: true, enabled: true, verified: true } }; },
      writeManifestAtomically: (p, value) => writeFileSync(p, JSON.stringify(value)) },
    dailyStatus: () => ({ installed: false }), restoreDaily() {},
    launchctl(args) {
      if (args[0] === 'print') {
        if (!loaded) return { status: 113 };
        const block = loaded.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u)[1];
        const argv = [...block.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(m => m[1]);
        return { status: 0, stdout: `state = waiting\narguments = {\n${argv.join('\n')}\n}\n` };
      }
      if (args[0] === 'bootstrap') { loaded = readFileSync(args[2], 'utf8'); return { status: 0 }; }
      if (args[0] === 'bootout') { stops++; if (ignoredStops > 0) ignoredStops--; else loaded = null; return { status: 0 }; }
      assert.equal(args[0], 'enable'); return { status: 0 };
    } };
  const first = installProviderScheduler('quickbooks', manifest, options);
  const prior = readFileSync(first.plistPath, 'utf8');
  await assert.rejects(qb.commandQuickBooksSchedule(['schedule', 'off', manifest], options), { code: 'SCHEDULE_INSTALL_FAILED' });
  assert.ok(stops >= 1, 'the actual removal decision was reached'); assert.equal(daily, 1);
  assert.equal(readFileSync(first.plistPath, 'utf8'), prior); assert.equal(loaded, prior);
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).operations.quickbooks_schedule.enabled, true);
  const control = await qb.commandQuickBooksSchedule(['schedule', 'off', manifest], options);
  assert.equal(control.verified, true); assert.equal(daily, 2); assert.equal(loaded, null);
  assert.equal(snapshotQuickBooksProviderScheduler(manifest, options).installed, false);
});

test('Online connect rebind happens after its source lease is released and before success', async () => {
  const manifest = join(root, 'online-connect.manifest.json'); writeFileSync(manifest, JSON.stringify(fixture()));
  let held = false; let connected = 0; let rebound = 0;
  const opts = { quiet: true, environment: {},
    withSourceIngestLock: async (_input, run) => { held = true; try { return await run({ assertOwned() { assert.equal(held, true); } }); } finally { held = false; } },
    oauth: { PROVIDER_DEFAULT_PORT: 3210, providerOAuthConfig: () => ({ label: 'QuickBooks', clientSecretRequired: false }),
      quickBooksSandboxRedirectUri: () => 'http://localhost:3210/callback',
      loadQuickBooksCredentials: async () => ({ client_id: 'fixture-public-id' }),
      authorizeProvider: async () => { connected++; return { provider_metadata: { realm_id: 'fixture-company' } }; },
      assertQuickBooksSourceBinding() {}, providerCredentialDescription: () => 'fixture protected store' },
    reregisterAfterManifestChange: async () => { rebound++; assert.equal(held, false, 'lifecycle acquisition must not happen inside the source lease'); return { verified: true }; },
  };
  const result = await brain.cmdConnectProvider('quickbooks', manifest, {}, opts);
  assert.equal(result.connected, true); assert.equal(connected, 1); assert.equal(rebound, 1);
  await assert.rejects(brain.cmdConnectProvider('quickbooks', manifest, {}, { ...opts, reregisterAfterManifestChange: async () => {
    rebound++; throw Object.assign(new Error('fixture daily attention'), { code: 'SCHEDULE_INSTALL_FAILED' });
  } }), { code: 'SCHEDULE_INSTALL_FAILED' });
  assert.equal(connected, 2); assert.equal(rebound, 2);
});

test('an explicit schedule-off preference still rebinds daily approval after Online connect and disconnect', async () => {
  const manifest = join(root, 'schedule-off-connect.manifest.json');
  const keyFile = join(root, 'disconnect-fixture-key-file'); writeFileSync(keyFile, 'synthetic-fixture-material', { mode: 0o600 });
  for (const preference of [false, true, undefined]) {
    const m = fixture();
    if (preference === undefined) delete m.operations.quickbooks_schedule;
    else m.operations.quickbooks_schedule.enabled = preference;
    writeFileSync(manifest, JSON.stringify(m));
    let connects = 0; let disconnects = 0; let rebounds = 0; let legacyRemovals = 0;
    const options = { quiet: true, environment: {},
      withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
      oauth: { PROVIDER_DEFAULT_PORT: 3210, providerOAuthConfig: () => ({ label: 'QuickBooks', clientSecretRequired: false }),
        quickBooksSandboxRedirectUri: () => 'http://localhost:3210/callback',
        loadQuickBooksCredentials: async () => ({ client_id: 'fixture-public-id' }),
        authorizeProvider: async () => { connects++; return { provider_metadata: { realm_id: 'fixture-company' } }; },
        disconnectProvider: async () => { disconnects++; return { already_disconnected: true }; },
        assertQuickBooksSourceBinding() {}, providerCredentialDescription: () => 'fixture protected store' },
      scheduler: { removeProviderScheduler() { legacyRemovals++; return { removed: false }; } },
      resolveAdminKey: () => readFileSync(keyFile, 'utf8'), resolveBaseUrl: async () => 'https://brain.example.invalid', postSourceExpectation() {},
      reregisterAfterManifestChange: async () => { rebounds++; return { verified: true }; } };
    await brain.cmdConnectProvider('quickbooks', manifest, {}, options);
    await brain.cmdDisconnectProvider('quickbooks', manifest, {}, options);
    assert.equal(connects, 1); assert.equal(disconnects, 1);
    assert.equal(rebounds, preference === undefined ? 0 : 2);
    assert.equal(legacyRemovals, preference === undefined ? 1 : 0);
  }
});

test('scheduled CLI rejects definition drift before state or ingest; the exact definition reaches the real gate', async () => {
  const manifest = join(root, 'scheduled.manifest.json'); const m = fixture();
  m.corpora = { quickbooks_desktop: { enabled: true } }; writeFileSync(manifest, JSON.stringify(m));
  const opts = { platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix', now,
    clock: () => now, withBrainLifecycleLock: async (_input, run) => run({ assertOwned() {} }),
    quickBooksSchedulerOptions: { nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`,
      runnerPath: String.raw`C:\Runtime\operations\quickbooks-schedule.mjs`, nodeRealpath: p => p, runtimeUsable: () => true } };
  const plan = qb.planQuickBooksSchedule({ m, manifestPath: manifest, ...opts });
  const definition = qb.buildQuickBooksScheduleDefinition(plan, opts.quickBooksSchedulerOptions);
  const adapter = nativeMemory({ exists: true, owned: true, enabled: true, definition });
  opts.quickBooksSchedulerOptions.adapter = adapter;
  let states = 0; let ingests = 0; let processes = 0;
  opts.state = { read() { states++; return null; }, write() {} };
  opts.runSource = async () => { ingests++; return { receipt: { status: 'ready', completed_at: now.toISOString() } }; };
  opts.listProcesses = () => { processes++; return ['QBW32.exe']; };
  await assert.rejects(brain.cmdQuickBooksRun(manifest, { ...opts, expectedDefinitionHash: `sha256:${'0'.repeat(64)}` }), { code: 'SCHEDULE_RUN_FAILED' });
  assert.equal(adapter.reads, 1); assert.equal(states, 0); assert.equal(ingests, 0); assert.equal(processes, 0);
  const control = await brain.cmdQuickBooksRun(manifest, { ...opts, expectedDefinitionHash: definition.definition_hash });
  assert.equal(control.status, 'ready'); assert.equal(adapter.reads, 2); assert.equal(states, 1); assert.equal(ingests, 1); assert.equal(processes, 1);
});

test('QuickBooks CLI entry points do not enter the control-plane credential wrapper', async () => {
  let dispatches = 0; let credentials = 0;
  for (const command of ['quickbooks', 'quickbooks-run']) {
    await brain.runCliCommandWithCredentialBoundary(command, () => { dispatches++; }, { withWranglerSession() { credentials++; assert.fail('credential wrapper'); } });
  }
  assert.equal(dispatches, 2); assert.equal(credentials, 0);
});

test('native Windows registration observes the real XML parser and refuses a changed trigger or foreign owner', () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-native-'));
  let xml = null; let inspections = 0; let mutations = 0;
  const opts = { platform: 'win32', home, environment: { SystemRoot: String.raw`C:\Windows` },
    nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`, runnerPath: String.raw`C:\Runtime\operations\quickbooks-schedule.mjs`,
    nodeRealpath: p => p, runtimeUsable: () => true, spawn(command, args, child) {
      assert.equal(command, String.raw`C:\Windows\System32\schtasks.exe`);
      assert.deepEqual(child.env, { SystemRoot: String.raw`C:\Windows` });
      if (args[0] === '/Query') { inspections++; return args.includes('/XML') ? { status: xml ? 0 : 1, stdout: xml || '' } : { status: 0, stdout: '"\\Fixture\\Task","N/A","Ready"' }; }
      if (args[0] === '/Create') { mutations++; xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf16le').replace(/^\ufeff/u, ''); return { status: 0 }; }
      assert.fail('unexpected native mutation');
    } };
  const plan = qb.planQuickBooksSchedule({ m: fixture(), manifestPath: path, platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix', now });
  assert.equal(qb.registerQuickBooksSchedule(plan, opts).verified, true);
  assert.equal(mutations, 1); assert.ok(inspections >= 4);
  assert.equal(qb.statusQuickBooksSchedule(plan, opts).verified, true);
  const correct = xml; const before = inspections;
  xml = xml.replace('<Interval>PT2H</Interval>', '<Interval>PT1H</Interval>');
  assert.equal(qb.statusQuickBooksSchedule(plan, opts).verified, false); assert.equal(inspections, before + 1);
  xml = correct.replace('financial-brain-quickbooks-refresh-v1:', 'foreign-refresh-v1:');
  assert.throws(() => qb.registerQuickBooksSchedule(plan, opts), /foreign/u); assert.equal(mutations, 1);
  xml = correct; assert.equal(qb.statusQuickBooksSchedule(plan, opts).verified, true);
});

test('schedule on/off/status uses the two-task transaction and persists only an exactly verified intent', async () => {
  const manifest = join(root, 'schedule-command.manifest.json');
  const m = fixture(); delete m.operations.quickbooks_schedule; writeFileSync(manifest, JSON.stringify(m));
  let daily = 0; let installs = 0; let removes = 0; let installed = false; let expectations = 0;
  const options = { quiet: true, platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix', now,
    withBrainLifecycleLock: async (_input, run) => run({ assertOwned() {} }),
    cli: { buildConfiguredDailyPlan: async () => ({ identity: { id: 'v1-fixture' } }),
      writeManifestAtomically: (p, value) => writeFileSync(p, JSON.stringify(value)),
      cmdDaily: async () => { daily++; return { schedule: { installed: true, enabled: true, verified: true } }; } },
    dailyStatus: () => ({ installed: false }), restoreDaily() {},
    quickBooksStatus: () => ({ installed, enabled: installed, verified: installed, state: null }),
    quickBooksRegister: () => { installs++; installed = true; return { installed: true, enabled: true, verified: true }; },
    quickBooksRemove: () => { removes++; installed = false; return { removed: true }; },
    quickBooksRestore() {}, syncExpectations: async () => { expectations++; },
  };
  // Packet 07's connect hook also enables the new schedule when no preference exists.
  assert.equal((await qb.reregisterAfterManifestChange(manifest, options)).verified, true);
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).operations.quickbooks_schedule.enabled, true);
  assert.equal((await brain.cmdQuickBooks(['schedule', 'status', manifest], options)).verified, true);
  assert.equal((await brain.cmdQuickBooks(['schedule', 'off', manifest], options)).verified, true);
  assert.equal(installed, false); assert.equal(removes, 1);
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).operations.quickbooks_schedule.enabled, false);
  assert.equal((await brain.cmdQuickBooks(['schedule', 'on', manifest], options)).verified, true);
  assert.equal(installs, 2); assert.equal(daily, 3); assert.equal(expectations, 3);
  const before = readFileSync(manifest, 'utf8');
  let refusals = 0;
  await assert.rejects(brain.cmdQuickBooks(['schedule', 'off', manifest], { ...options, cli: { ...options.cli,
    cmdDaily: async () => { refusals++; return { schedule: { verified: false } }; } },
  }), { code: 'SCHEDULE_INSTALL_FAILED' });
  assert.equal(refusals, 1); assert.equal(readFileSync(manifest, 'utf8'), before);
});

test('both editions publish a one-day freshness expectation using the QuickBooks kind', async () => {
  const manifest = join(root, 'expectations.manifest.json'); const m = fixture();
  m.corpora.quickbooks_desktop = { enabled: true, source: 'desktop-ledger' }; writeFileSync(manifest, JSON.stringify(m));
  const keyFile = join(root, 'expectation-fixture-key-file'); writeFileSync(keyFile, 'synthetic-fixture-material', { mode: 0o600 });
  const writes = []; let daily = 0;
  const result = await qb.reregisterAfterManifestChange(manifest, { platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix', now,
    withBrainLifecycleLock: async (_input, run) => run({ assertOwned() {} }),
    cli: { buildConfiguredDailyPlan: async () => ({ identity: { id: 'v1-fixture' } }),
      cmdDaily: async () => { daily++; return { schedule: { installed: true, enabled: true, verified: true } }; } },
    dailyStatus: () => ({ installed: false }), quickBooksStatus: () => ({ installed: false, state: null }),
    quickBooksRegister: () => ({ installed: true, enabled: true, verified: true }),
    resolveAdminKey: () => readFileSync(keyFile, 'utf8'), resolveBaseUrl: async () => 'https://brain.example.invalid',
    postSourceExpectation: async (_base, _key, payload) => writes.push(payload),
  });
  assert.equal(result.verified, true); assert.equal(daily, 1);
  assert.deepEqual(writes, [{ source: 'ledger', kind: 'quickbooks', expected_refresh_seconds: 86400 },
    { source: 'desktop-ledger', kind: 'quickbooks', expected_refresh_seconds: 86400 }]);
});

test('a provider calendar cannot claim health when its configured timezone differs from the machine', () => {
  const manifest = join(root, 'timezone.manifest.json'); const m = fixture();
  m.operations.quickbooks_schedule.timezone = 'America/New_York'; writeFileSync(manifest, JSON.stringify(m));
  let clocks = 0;
  const options = { ...mac, get now() { clocks++; return now; } };
  assert.throws(() => buildProviderSchedulerPlan('quickbooks', manifest, options), /timezone must match/u);
  assert.ok(clocks >= 1, 'the configured calendar reached the timezone/window calculation');
  m.operations.quickbooks_schedule.timezone = 'America/Phoenix'; writeFileSync(manifest, JSON.stringify(m));
  assert.equal(buildProviderSchedulerPlan('quickbooks', manifest, options).intervals.length, 2);
});

test('QuickBooks and daily status show the effective annual window and distinguish planned times from verified installation', async () => {
  const manifest = join(root, 'window-status.manifest.json');
  const m = fixture(); m.client.timezone = 'America/New_York'; writeFileSync(manifest, JSON.stringify(m));
  const native = { platform: 'win32', home: root, nodePath: String.raw`C:\Runtime\node.exe`,
    runnerPath: String.raw`C:\Runtime\operations\quickbooks-schedule.mjs`, nodeRealpath: p => p, runtimeUsable: () => true };
  const quickbooks = nativeMemory(); const daily = nativeMemory();
  const options = { quiet: true, platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/New_York', now,
    existingSchedulerOwners: [], planLoad: async () => Object.keys(m.corpora).map(key => ({ key, status: 'ready' })),
    schedulerAdapter: daily, schedulerOptions: native, quickBooksSchedulerOptions: { ...native, adapter: quickbooks },
    readSourceInventory: async () => ({ sources: [] }) };
  for (const installed of [false, true]) {
    if (installed) qb.registerQuickBooksSchedule(qb.planQuickBooksSchedule({ m, manifestPath: manifest, ...options }), options.quickBooksSchedulerOptions);
    const before = quickbooks.reads;
    const status = await brain.cmdQuickBooks(['schedule', 'status', manifest], options);
    assert.ok(quickbooks.reads > before, 'status inspected the native definition');
    assert.equal(status.verified, installed);
    assert.deepEqual(status.effective_window, { timezone: 'America/New_York', policy: 'earliest-annual-utc-cutoff',
      start_local: '07:00', cutoff_local: '18:30', cutoff_exclusive: true,
      scheduled_times_local: ['07:00', '09:00', '11:00', '13:00', '15:00', '17:00'] });
    assert.match(status.window_description, /07:00.*18:30.*America\/New_York.*all year/u);
    const dailyStatus = await brain.cmdDaily(['status', manifest], options);
    assert.deepEqual(dailyStatus.quickbooks_schedule, status);
    const lines = [];
    await brain.cmdDaily(['status', manifest], { ...options, quiet: false, log: line => lines.push(line) });
    assert.ok(lines.some(line => line.includes(status.window_description)), 'plain daily status prints the window');
  }
  delete m.operations.quickbooks_schedule; writeFileSync(manifest, JSON.stringify(m));
  const before = quickbooks.reads;
  const legacy = await brain.cmdDaily(['status', manifest], options);
  assert.equal(Object.hasOwn(legacy, 'quickbooks_schedule'), false);
  assert.equal(quickbooks.reads, before, 'legacy daily status never inspects the new task');
});

test('macOS status and actual provider intervals retain the conservative annual window across DST', async () => {
  const manifest = join(root, 'mac-window-status.manifest.json');
  const m = fixture(); m.client.timezone = 'America/New_York'; writeFileSync(manifest, JSON.stringify(m));
  let inspections = 0;
  for (const date of ['2026-01-15T14:00:00Z', '2026-07-15T14:00:00Z']) {
    const options = { ...mac, now: new Date(date), quiet: true, localTimeZone: 'America/New_York', localTimezone: 'America/New_York',
      providerScheduler: { snapshotQuickBooksProviderScheduler() { inspections++; return { installed: true, loaded: true, verified: true }; } } };
    const providerPlan = buildProviderSchedulerPlan('quickbooks', manifest, options);
    assert.deepEqual(providerPlan.intervals, [{ Minute: 0, Hour: 7 }, { Minute: 0, Hour: 18 }]);
    const status = await brain.cmdQuickBooks(['schedule', 'status', manifest], options);
    assert.deepEqual(status.effective_window.scheduled_times_local, ['07:00', '18:00']);
    assert.equal(status.effective_window.cutoff_local, '18:30');
    assert.equal(status.verified, true);
  }
  assert.equal(inspections, 2);
});

test('daily status visibly skips an unconnected leg and keeps the other sources planned', async () => {
  const manifest = join(root, 'unconnected-status.manifest.json');
  const m = fixture(); delete m.operations.quickbooks_schedule;
  m.corpora.gmail = { enabled: true }; writeFileSync(manifest, JSON.stringify(m));
  let plans = 0;
  for (const connected of [false, true]) {
    const lines = [];
    const result = await brain.cmdDaily(['status', manifest], { platform: 'win32', principal: 'sid:S-1-5-21-100',
      localTimezone: 'America/Phoenix', existingSchedulerOwners: [], schedulerAdapter: nativeMemory(),
      planLoad: async () => { plans++; return Object.keys(m.corpora).map(key => key === 'quickbooks' && !connected
        ? { key, daily_class: 'machine-pull', status: 'unavailable', reason: 'enabled, but not connected on this machine: fixture' }
        : { key, status: 'ready' }); }, readSourceInventory: async () => ({ sources: [] }), log: line => lines.push(line) });
    assert.equal(plans, connected ? 2 : 1);
    assert.equal(result.plan.ready, true);
    assert.deepEqual(result.plan.sources.filter(row => row.owner === 'daily-task').map(row => row.key).sort(),
      connected ? ['gmail', 'google_drive', 'quickbooks'] : ['gmail', 'google_drive']);
    const row = result.sources.find(row => row.source === 'quickbooks');
    assert.equal(row.current_state, connected ? 'unknown' : 'skipped');
    if (!connected) assert.ok(lines.some(line => /quickbooks.*skipped.*not connected/u.test(line)));
  }
});
