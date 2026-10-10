import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { planDailyRefresh } from '../operations/daily-refresh-plan.mjs';
const qb = await import('../operations/quickbooks-schedule.mjs').catch(() => ({}));
const at = new Date('2026-07-01T14:00:00.000Z');
const fixture = () => ({ client: { slug: 'fixture', timezone: 'America/Phoenix' },
  brain: { domain: 'brain.example.invalid' },
  corpora: { gmail: { enabled: true }, google_drive: { enabled: true }, quickbooks_desktop: { enabled: true } },
  operations: { quickbooks_schedule: { enabled: true } } });
const options = { platform: 'win32', principal: 'sid:S-1-5-21-100', localTimezone: 'America/Phoenix', now: at };
const plan = (m = fixture(), extra = {}) => qb.planQuickBooksSchedule({ m, manifestPath: '/fixtures/brain.manifest.json', ...options, ...extra });

test('unconnected QuickBooks does not change the daily source plan or block other sources', async () => {
  let decisions = 0;
  const daily = (m) => planDailyRefresh({ m, manifestPath: '/fixtures/brain.manifest.json', ...options,
    planLoadFn: async () => { decisions++; return [
      { key: 'gmail', status: 'ready' }, { key: 'google_drive', status: 'ready' },
      { key: 'quickbooks_desktop', status: 'unavailable' },
      { key: 'quickbooks', status: 'unavailable', daily_class: 'machine-pull', reason: 'enabled, but not connected on this machine: fixture' },
      { key: 'unknown', status: 'unavailable' },
    ]; } });
  const m = fixture();
  const absent = structuredClone(m); delete absent.corpora.quickbooks_desktop;
  const control = await daily(absent);
  for (const key of ['quickbooks_desktop', 'quickbooks']) {
    const configured = structuredClone(absent); configured.corpora[key] = { enabled: true };
    const before = decisions;
    const result = await daily(configured);
    assert.equal(decisions, before + 1);
    assert.equal(result.ready, true);
    assert.equal(result.sources.find(s => s.key === key).class, 'connect-required');
    assert.equal(result.sources.find(s => s.key === key).status, 'skipped');
    assert.equal(result.source_plan_hash, control.source_plan_hash);
    assert.notEqual(result.manifest_content_hash, control.manifest_content_hash, 'whole-manifest approval remains mandatory');
    assert.deepEqual(result.sources.filter(s => s.owner === 'daily-task').map(s => s.key), ['gmail', 'google_drive']);
  }
  absent.corpora.unknown = { enabled: true };
  const bad = await daily(absent);
  assert.equal(decisions, 4);
  assert.equal(bad.ready, false, 'unavailable non-QuickBooks control still fails');
});

test('the schedule hash covers QuickBooks configuration without unrelated manifest content', () => {
  assert.equal(typeof qb.planQuickBooksSchedule, 'function');
  const m = fixture(); const first = plan(m);
  m.corpora.gmail.label = 'fixture';
  assert.equal(plan(m).configuration_hash, first.configuration_hash);
  m.corpora.quickbooks_desktop.source = 'ledger';
  assert.notEqual(plan(m).configuration_hash, first.configuration_hash);
});

test('UTC-date window refuses the late start at the real timezone decision, with a morning control', () => {
  assert.equal(typeof qb.quickBooksWindow, 'function');
  let decisions = 0;
  const window = start => qb.quickBooksWindow({ get timezone() { decisions++; return 'America/Los_Angeles'; }, now: at, start });
  assert.throws(() => window('18:00'), { code: 'QB_SCHEDULE_WINDOW_INVALID' });
  assert.equal(decisions, 1);
  assert.equal(window('07:00').cutoff_minutes, 990);
  assert.equal(decisions, 2);
});

for (const [ageMinutes, failed, expected] of [[359, false, 'QB_FRESH'], [360, false, 'QB_READY'], [60, true, 'QB_READY']]) {
  test(`snapshot gate age ${ageMinutes}, previous failure ${failed}`, async () => {
    assert.equal(typeof qb.runQuickBooksSchedule, 'function');
    let reads = 0; let ingests = 0; const writes = []; const receipts = [];
    const result = await qb.runQuickBooksSchedule({ plan: plan(), now: () => at,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      state: { read() { reads++; return { last_complete_snapshot_at: new Date(+at - ageMinutes * 60000).toISOString(), last_run_failed: failed }; }, write(_plan, _source, value) { writes.push(value); } },
      listProcesses: async () => ['QBW32.exe'],
      runSource: async () => { ingests++; return { receipt: { status: 'ready', completed_at: at.toISOString() } }; },
      writeReceipt: r => receipts.push(r),
    });
    assert.equal(reads, 1);
    assert.equal(result.sources[0].code, expected);
    assert.equal(ingests, expected === 'QB_READY' ? 1 : 0);
    assert.equal(receipts.length, 1);
    if (expected === 'QB_FRESH') assert.equal(writes.length, 0);
    else assert.equal(writes.at(-1).last_complete_snapshot_at, at.toISOString());
  });
}

test('Desktop process check happens before ingest and sees an open-process control', async () => {
  assert.equal(typeof qb.runQuickBooksSchedule, 'function');
  for (const open of [false, true]) {
    let processes = 0; let spawns = 0; let reads = 0;
    const result = await qb.runQuickBooksSchedule({ plan: plan(), now: () => at,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      state: { read() { reads++; return null; }, write() {} },
      listProcesses: async () => { processes++; return open ? ['QBW.exe'] : ['unrelated.exe']; },
      runSource: async () => { spawns++; return { receipt: { status: 'ready', completed_at: at.toISOString() } }; },
    });
    assert.equal(reads, 1); assert.equal(processes, 1); assert.equal(spawns, open ? 1 : 0);
    assert.equal(result.sources[0].code, open ? 'QB_READY' : 'QB_NOT_OPEN');
    assert.equal(result.status, 'ready', 'a skip is not an error');
  }
});

test('only a ready closed receipt advances snapshot state; a failure is retried', async () => {
  assert.equal(typeof qb.runQuickBooksSchedule, 'function');
  let ingests = 0; let reads = 0; let saved = null;
  for (const status of ['error', 'ready']) {
    const result = await qb.runQuickBooksSchedule({ plan: plan(), now: () => at,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      state: { read() { reads++; return saved; }, write(_plan, _source, value) { saved = value; } },
      listProcesses: async () => ['QBW32.exe'],
      runSource: async () => { ingests++; return { receipt: { status, completed_at: at.toISOString() } }; },
    });
    assert.equal(saved.last_complete_snapshot_at, status === 'ready' ? at.toISOString() : null);
    assert.equal(saved.last_run_failed, status !== 'ready');
    assert.equal(result.status, status);
  }
  assert.equal(reads, 2); assert.equal(ingests, 2);
});

const nativeOptions = { nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`,
  runnerPath: String.raw`C:\Runtime\operations\quickbooks-schedule.mjs`, nodeRealpath: value => value, runtimeUsable: () => true };
function adapterFixture(initial = null) {
  let state = initial; let reads = 0; let writes = 0; let fault = false;
  return { get reads() { return reads; }, get writes() { return writes; }, get state() { return state; },
    fault() { fault = true; },
    read() { reads++; return state; },
    install(definition) { writes++; state = { exists: true, owned: true, enabled: true, definition };
      if (fault) { fault = false; state = { ...state, definition: { ...definition, native_definition_hash: 'corrupt' } }; } },
    setEnabled(_id, enabled) { state = { ...state, enabled }; }, remove() { writes++; state = null; },
  };
}

test('Windows definition repeats within the cutoff and uses the exact current-user safety settings', () => {
  assert.equal(typeof qb.buildQuickBooksScheduleDefinition, 'function');
  for (const timezone of ['America/Phoenix', 'America/New_York']) {
    for (const date of ['2026-01-15T14:00:00Z', '2026-07-15T14:00:00Z']) {
      const m = fixture(); m.client.timezone = timezone;
      const desired = { ...plan(m, { localTimezone: timezone, now: new Date(date) }), manifest_path: '/fixtures/brain.manifest.json' };
      const definition = qb.buildQuickBooksScheduleDefinition(desired, nativeOptions);
      const label = timezone === 'America/Phoenix' ? 'phoenix' : 'new-york';
      const season = date.includes('-01-') ? 'standard' : 'daylight';
      const expected = readFileSync(new URL(`./fixtures/quickbooks-schedule/${label}-${season}.xml`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      // XML whitespace uses either checkout newline; every other byte remains exact.
      for (const ending of ['\n', '\r\n']) {
        assert.equal(definition.serialized, expected.replace(/\n/g, ending).replace(/\r\n/g, '\n'));
      }
      const c = definition.native_contract;
      assert.equal(c.repetition_interval, 'PT2H');
      assert.equal(c.repetition_duration, `PT${desired.window.duration_minutes}M`);
      assert.equal(c.user_id, 'S-1-5-21-100');
      assert.equal(c.logon_type, 'InteractiveToken'); assert.equal(c.run_level, 'LeastPrivilege');
      assert.equal(c.start_when_available, true); assert.equal(c.wake_to_run, false);
      assert.equal(c.multiple_instances_policy, 'IgnoreNew'); assert.equal(c.execution_time_limit, 'PT30M');
      assert.match(c.arguments, /quickbooks-run/u);
      assert.equal(definition.native_contract_valid, true);
      if (timezone === 'America/New_York') assert.ok(desired.window.cutoff_minutes <= 1170);
    }
  }
});

test('registration is idempotent, refuses a foreign task, and restores the previous exact definition after failed readback', () => {
  assert.equal(typeof qb.registerQuickBooksSchedule, 'function');
  const desired = plan(); const adapter = adapterFixture(); const opts = { ...nativeOptions, adapter };
  qb.registerQuickBooksSchedule(desired, opts);
  assert.equal(adapter.writes, 1); assert.ok(adapter.reads >= 2);
  assert.equal(qb.registerQuickBooksSchedule(desired, opts).changed, false);
  assert.equal(adapter.writes, 1);
  const previous = adapter.state;
  const edited = fixture(); edited.corpora.quickbooks_desktop.source = 'ledger';
  adapter.fault();
  assert.throws(() => qb.registerQuickBooksSchedule(plan(edited), opts), { code: 'SCHEDULE_INSTALL_FAILED' });
  assert.equal(adapter.writes, 3); assert.deepEqual(adapter.state, previous);
  assert.equal(qb.statusQuickBooksSchedule(desired, opts).verified, true);
  const foreign = adapterFixture({ ...previous, owned: false });
  assert.throws(() => qb.registerQuickBooksSchedule(desired, { ...opts, adapter: foreign }), /foreign/u);
  assert.equal(foreign.reads, 1); assert.equal(foreign.writes, 0);
});

test('windowless launch is off by default and cannot opt into an unproven host', () => {
  const m = fixture(); const control = qb.buildQuickBooksScheduleDefinition(plan(m), nativeOptions);
  assert.equal(control.native_contract.command, nativeOptions.nodePath);
  let decisions = 0;
  m.operations.quickbooks_schedule.windowless = true;
  assert.throws(() => qb.buildQuickBooksScheduleDefinition(plan(m), { ...nativeOptions,
    get windowlessHost() { decisions++; return null; } }), { code: 'QB_WINDOWLESS_UNVERIFIED' });
  assert.equal(decisions, 1);
});

test('process inspection failure is an error receipt, while the no-process control is a skip', async () => {
  let calls = 0;
  for (const failed of [true, false]) {
    const receipts = []; let saved = null;
    const result = await qb.runQuickBooksSchedule({ plan: plan(), now: () => at,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      state: { read() { return saved; }, write(_p, _s, value) { saved = value; } },
      listProcesses: () => { calls++; if (failed) throw new Error('fixture failure'); return []; },
      runSource: () => assert.fail('no ingest before the process gate passes'), writeReceipt: r => receipts.push(r),
    });
    assert.equal(calls, failed ? 1 : 2); assert.equal(receipts.length, 1);
    assert.equal(result.status, failed ? 'error' : 'ready');
    assert.equal(receipts[0].status, failed ? 'error' : 'skipped');
    if (failed) assert.equal(saved.last_run_failed, true);
  }
});

test('an unconnected leg stays visibly skipped and is not recorded as a failed read', async () => {
  let ingests = 0; let saved = null;
  for (const connected of [false, true]) {
    const result = await qb.runQuickBooksSchedule({ plan: plan(), now: () => at,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      state: { read() { return saved; }, write(_p, _s, value) { saved = value; } },
      listProcesses: () => ['QBW32.exe'],
      runSource: () => { ingests++; return connected ? { receipt: { status: 'ready', completed_at: at.toISOString() } } : { status: 'skipped', code: 'QB_CONNECT_REQUIRED' }; },
    });
    assert.equal(ingests, connected ? 2 : 1);
    assert.equal(result.sources[0].status, connected ? 'ready' : 'skipped');
    assert.equal(saved.last_run_failed, false);
  }
});

test('the fixed annual definition stays identical while catch-up reads use the actual-date cutoff', async () => {
  const m = fixture(); m.client.timezone = 'America/New_York';
  const winter = plan(m, { localTimezone: m.client.timezone, now: new Date('2026-01-15T14:00:00Z') });
  const summer = plan(m, { localTimezone: m.client.timezone, now: new Date('2026-07-15T14:00:00Z') });
  assert.equal(winter.window.cutoff_minutes, 1110);
  assert.equal(summer.window.cutoff_minutes, 1110);
  assert.equal(qb.buildQuickBooksScheduleDefinition(winter, nativeOptions).serialized,
    qb.buildQuickBooksScheduleDefinition(summer, nativeOptions).serialized);
  for (const date of ['2026-01-15', '2026-07-15']) {
    for (const [time, allowed] of [['23:29:59', true], ['23:30:00', false], ['23:31:00', false]]) {
      const clock = new Date(`${date}T${time}.000Z`);
      let reads = 0; let processes = 0; let ingests = 0;
      const result = await qb.runQuickBooksSchedule({ plan: summer, now: () => clock,
        acquireLock: () => ({ assertOwned() {}, release() {} }), state: { read() { reads++; return null; }, write() {} },
        listProcesses() { processes++; return ['QBW32.exe']; },
        runSource() { ingests++; return { receipt: { status: 'ready', completed_at: clock.toISOString() } }; } });
      assert.equal(reads, 1, 'each cutoff decision reads the source state');
      assert.equal(processes, allowed ? 1 : 0); assert.equal(ingests, allowed ? 1 : 0);
      assert.equal(result.sources[0].code, allowed ? 'QB_READY' : 'QB_OUTSIDE_WINDOW');
    }
  }
});

test('slow state and process checks cannot authorize a read after the actual cutoff', async () => {
  for (const slowBoundary of ['state', 'process', 'write', 'none']) {
    let clock = new Date('2026-07-15T23:29:59.000Z');
    let reads = 0; let processes = 0; let ingests = 0; let writes = 0;
    const delay = boundary => { if (slowBoundary === boundary) clock = new Date('2026-07-15T23:30:00.000Z'); };
    const result = await qb.runQuickBooksSchedule({ plan: plan(), now: () => clock,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      state: { read() { reads++; delay('state'); return null; }, write() { writes++; delay('write'); } },
      listProcesses() { processes++; delay('process'); return ['QBW32.exe']; },
      runSource() { ingests++; return { receipt: { status: 'ready', completed_at: clock.toISOString() } }; } });
    assert.equal(reads, 1);
    assert.equal(processes, slowBoundary === 'state' ? 0 : 1);
    if (slowBoundary === 'write') assert.ok(writes >= 1, 'the slow persistence boundary was reached');
    assert.equal(ingests, slowBoundary === 'none' ? 1 : 0);
    assert.equal(result.sources[0].code, slowBoundary === 'none' ? 'QB_READY' : 'QB_OUTSIDE_WINDOW');
  }
});

test('each source reaches a fresh cutoff decision after the preceding source finishes', async () => {
  const m = fixture(); m.corpora.quickbooks = { enabled: true };
  for (const firstEndsAtCutoff of [true, false]) {
    let clock = new Date('2026-07-15T23:29:59.000Z');
    const reads = []; const ingests = []; let processes = 0;
    const result = await qb.runQuickBooksSchedule({ plan: plan(m), now: () => clock,
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      state: { read(_p, source) { reads.push(source.key); return null; }, write() {} },
      listProcesses() { processes++; return ['QBW32.exe']; },
      runSource(source) {
        ingests.push(source.key);
        if (firstEndsAtCutoff) clock = new Date('2026-07-15T23:30:00.000Z');
        return { receipt: { status: 'ready', completed_at: clock.toISOString() } };
      } });
    assert.deepEqual(reads, ['quickbooks', 'quickbooks_desktop']);
    assert.deepEqual(ingests, firstEndsAtCutoff ? ['quickbooks'] : reads);
    assert.equal(processes, firstEndsAtCutoff ? 0 : 1);
    assert.equal(result.sources[1].code, firstEndsAtCutoff ? 'QB_OUTSIDE_WINDOW' : 'QB_READY');
  }
});
