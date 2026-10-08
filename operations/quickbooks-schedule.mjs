/** Owned QuickBooks scheduling. All native and ingest boundaries are injectable. */
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dailyRefreshIdentity, dailyRefreshPrincipal } from './daily-refresh-plan.mjs';
import { buildDailyRefreshDefinition, createNativeDailyRefreshAdapter, escapeTaskXml, observedWindowsContract, quoteWindowsTaskArgument, statusDailyRefreshSchedule, restoreDailyRefreshSchedule, removeDailyRefreshSchedule } from './daily-refresh-scheduler.mjs';
import { acquireBrainLifecycleLock, withBrainLifecycleLock } from './brain-lifecycle-lock.mjs';
import { quickBooksScheduleState } from './quickbooks-schedule-state.mjs';
import { quickBooksScheduleBinding, quickBooksScheduleRegistrationRequired } from './quickbooks-schedule-binding.mjs';

export const QUICKBOOKS_KEYS = Object.freeze(['quickbooks', 'quickbooks_desktop']);
export const QUICKBOOKS_REFRESH_SECONDS = 86400;
export const QUICKBOOKS_CONSOLE_TITLE = 'Financial Brain is reading QuickBooks, please leave this open';
const MARKER = 'financial-brain-quickbooks-refresh-v1';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const digest = value => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')}`;
const failure = (code, message) => Object.assign(new Error(message), { code });
const dateOf = value => { const d = new Date(value); if (!Number.isFinite(+d)) throw new TypeError('invalid QuickBooks schedule clock'); return d; };
function localClock(timezone, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const offset = (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(+now / 1000) * 1000) / 60000;
  return { offset, minutes: +parts.hour * 60 + +parts.minute, year: +parts.year };
}
export function quickBooksWindow({ timezone, now = new Date(), start = '07:00' } = {}) {
  const invalid = () => failure('QB_SCHEDULE_WINDOW_INVALID', 'QuickBooks refresh must start before the UTC-date cutoff, 30 minutes before UTC midnight in the configured local timezone.');
  if (typeof timezone !== 'string' || timezone !== timezone.trim() || !/^\d{2}:\d{2}$/u.test(start)) throw invalid();
  const [hour, minute] = start.split(':').map(Number);
  if (hour > 23 || minute > 59) throw invalid();
  let clock;
  try { clock = localClock(timezone, dateOf(now)); } catch { throw invalid(); }
  const midnight = clock.offset <= 0 ? 1440 + clock.offset : clock.offset;
  const cutoff = midnight - 30;
  const first = hour * 60 + minute;
  if (first >= cutoff || cutoff <= 0) throw invalid();
  return Object.freeze({ start_minutes: first, cutoff_minutes: cutoff, duration_minutes: cutoff - first,
    last_even_hour: Math.floor((cutoff - 1) / 120) * 2, local_minutes: clock.minutes });
}
/** Fixed native calendars must remain safe on both sides of a DST transition. */
export function quickBooksAnnualWindow({ timezone, now = new Date(), start = '07:00' } = {}) {
  const date = dateOf(now); const year = date.getUTCFullYear();
  let earliest = quickBooksWindow({ timezone, now: date, start });
  for (let day = Date.UTC(year, 0, 1, 12); day < Date.UTC(year + 1, 0, 1, 12); day += 86400000) {
    const candidate = quickBooksWindow({ timezone, now: new Date(day), start });
    if (candidate.cutoff_minutes < earliest.cutoff_minutes) earliest = candidate;
  }
  return earliest;
}
export function planQuickBooksSchedule({ m, manifestPath, platform = process.platform,
  principal = dailyRefreshPrincipal({ platform }), localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = new Date() } = {}) {
  const raw = m?.operations?.quickbooks_schedule;
  const config = raw === undefined ? {} : raw;
  const timezone = config?.timezone ?? m?.client?.timezone ?? localTimezone;
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.enabled !== undefined && typeof config.enabled !== 'boolean') ||
      (config.windowless !== undefined && typeof config.windowless !== 'boolean')) throw failure('QB_SCHEDULE_WINDOW_INVALID', 'QuickBooks schedule configuration is invalid.');
  const start = config.start ?? '07:00';
  const window = quickBooksAnnualWindow({ timezone, now, start });
  const sources = QUICKBOOKS_KEYS.filter(key => m?.corpora?.[key]?.enabled === true).map(key => ({ key,
    source: m.corpora[key].source || key, configuration_hash: digest(m.corpora[key]) }));
  const binding = quickBooksScheduleBinding(m, platform);
  const configurationHash = digest({ sources, start, timezone, windowless: config.windowless === true, binding });
  return Object.freeze({ identity: dailyRefreshIdentity(m, principal), manifest_path: resolve(manifestPath), platform,
    enabled: config.enabled === true, ready: ['win32', 'darwin'].includes(platform) && timezone === localTimezone && binding.data_plane.origin !== null,
    configuration_hash: configurationHash, binding, sources: Object.freeze(sources), timezone, start, window,
    windowless: config.windowless === true, expected_refresh_seconds: QUICKBOOKS_REFRESH_SECONDS });
}
function describeWindow(plan) {
  const time = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const { start_minutes: start, cutoff_minutes: cutoff, last_even_hour: lastEvenHour } = plan.window;
  const times = plan.platform === 'darwin' ? [start, lastEvenHour * 60] :
    Array.from({ length: Math.ceil((cutoff - start) / 120) }, (_, index) => start + index * 120);
  const effective_window = { timezone: plan.timezone, policy: 'earliest-annual-utc-cutoff',
    start_local: time(start), cutoff_local: time(cutoff), cutoff_exclusive: true,
    scheduled_times_local: times.map(time) };
  return { effective_window,
    window_description: `QuickBooks calendar window: ${time(start)} to before ${time(cutoff)} ${plan.timezone} all year. ` +
      `Planned starts: ${times.map(time).join(', ')}. Delayed starts must pass that day's UTC cutoff before reading.` };
}
const taskName = identity => `\\Financial Brain\\QuickBooks ${identity.id}`;
const markerOf = serialized => {
  const match = String(serialized).match(/<Description>financial-brain-quickbooks-refresh-v1:(v1-[a-f0-9]+):(sha256:[a-f0-9]{64})<\/Description>/u);
  return match ? { identity: match[1], definition_hash: match[2] } : null;
};
function nativeHash(contract) { const copy = { ...contract }; delete copy.task_enabled; return digest(JSON.stringify(copy)); }
function observe(identity, serialized) {
  const observed = observedWindowsContract(serialized, { repetition: true });
  return { identity, definition_hash: markerOf(serialized)?.definition_hash || null, native_contract: observed.contract,
    native_definition_hash: observed.valid ? nativeHash(observed.contract) : null,
    native_contract_valid: observed.valid, serialized };
}
export function createQuickBooksScheduleAdapter(options = {}) {
  return createNativeDailyRefreshAdapter({ ...options, platform: 'win32', taskSpec: { name: taskName, marker: markerOf, observe } });
}
export function buildQuickBooksScheduleDefinition(plan, options = {}) {
  const { windowlessHost, windowlessVerified, ...definitionOptions } = options;
  if (plan.platform !== 'win32') throw failure('QB_SCHEDULE_PLATFORM_INVALID', 'Windows QuickBooks task definitions require Windows.');
  if (!/^sid:S-1-[0-9-]+$/u.test(plan.identity.principal)) throw failure('QB_SCHEDULE_PRINCIPAL_INVALID', 'The current Windows user SID is required.');
  const runner = options.runnerPath || fileURLToPath(import.meta.url);
  const base = buildDailyRefreshDefinition({ ...plan, cron: `${plan.window.start_minutes % 60} ${Math.floor(plan.window.start_minutes / 60)} * * *`,
    manifest_path_hash: digest(plan.manifest_path), manifest_content_hash: plan.configuration_hash, source_plan_hash: plan.configuration_hash, max_runtime_minutes: 30 },
    { ...definitionOptions, platform: 'win32', runnerPath: runner });
  if (plan.windowless && (!windowlessHost || windowlessVerified !== true)) {
    throw failure('QB_WINDOWLESS_UNVERIFIED', 'Windowless QuickBooks launch is off until the Windows field gate proves a host.');
  }
  const host = plan.windowless ? windowlessHost : null;
  if (host && (!win32.isAbsolute(host.command || '') || !Array.isArray(host.args))) throw failure('QB_WINDOWLESS_UNVERIFIED', 'The reviewed windowless host is invalid.');
  const payload = { owner_marker: MARKER, identity: plan.identity, name: taskName(plan.identity),
    node_path: base.node_path, runner_path: base.runner_path, manifest_path: plan.manifest_path,
    configuration_hash: plan.configuration_hash, timezone: plan.timezone, start: plan.start,
    duration_minutes: plan.window.duration_minutes, windowless_host: host };
  const definitionHash = digest(payload);
  const argv = [base.runner_path, 'quickbooks-run', plan.manifest_path, '--definition-hash', definitionHash];
  const command = host ? host.command : base.node_path;
  const args = host ? [...host.args, base.node_path, ...argv] : argv;
  const marker = `${MARKER}:${plan.identity.id}:${definitionHash}`;
  const serialized = base.serialized
    .replace(/<Description>[\s\S]*?<\/Description>/u, `<Description>${marker}</Description>`)
    .replace('<CalendarTrigger>', `<CalendarTrigger><Repetition><Interval>PT2H</Interval><Duration>PT${plan.window.duration_minutes}M</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`)
    .replace('<WakeToRun>true</WakeToRun>', '<WakeToRun>false</WakeToRun>')
    .replace(/<Command>[\s\S]*?<\/Command>/u, `<Command>${escapeTaskXml(command)}</Command>`)
    .replace(/<Arguments>[\s\S]*?<\/Arguments>/u, `<Arguments>${escapeTaskXml(args.map(quoteWindowsTaskArgument).join(' '))}</Arguments>`);
  const observed = observe(plan.identity, serialized);
  if (!observed.native_contract_valid) throw new Error('QuickBooks task builder produced an invalid native contract');
  return Object.freeze({ ...payload, ...observed, definition_hash: definitionHash });
}
const owned = state => { if (state?.exists && state.owned !== true) throw failure('SCHEDULE_INSTALL_FAILED', 'A foreign QuickBooks task occupies this identity; nothing was changed.'); };
const exact = (state, definition, enabled = true) => state?.exists === true && state.owned === true && state.enabled === enabled &&
  state.definition?.definition_hash === definition.definition_hash && state.definition?.native_definition_hash === definition.native_definition_hash;
const adapterFor = options => options.adapter || createQuickBooksScheduleAdapter(options);
export function statusQuickBooksSchedule(plan, options = {}) {
  const state = adapterFor(options).read(plan.identity); owned(state);
  if (!state?.exists) return { installed: false, enabled: false, verified: false, state };
  const definition = buildQuickBooksScheduleDefinition(plan, options);
  const usable = options.runtimeUsable || (d => { try { accessSync(d.node_path, constants.X_OK); return statSync(d.node_path).isFile() && statSync(d.runner_path).isFile(); } catch { return false; } });
  return { installed: true, enabled: state.enabled === true, verified: plan.enabled && plan.ready && exact(state, definition) && usable(definition) === true, state, definition };
}
export function restoreQuickBooksSchedule(plan, snapshot, options = {}) {
  const adapter = adapterFor(options); const current = adapter.read(plan.identity); owned(current);
  if (snapshot?.exists) {
    owned(snapshot);
    adapter.install(snapshot.definition, { replaceOwned: current?.exists === true, expected: current });
    if (!snapshot.enabled) adapter.setEnabled(plan.identity, false);
    if (!exact(adapter.read(plan.identity), snapshot.definition, snapshot.enabled === true)) throw new Error('QuickBooks rollback did not pass exact readback');
  } else if (current?.exists) {
    adapter.remove(plan.identity, { expected: current });
    if (adapter.read(plan.identity)?.exists) throw new Error('The partial QuickBooks task remains installed');
  }
}
export function registerQuickBooksSchedule(plan, options = {}) {
  if (!plan.ready || !plan.enabled || !plan.sources.length) throw failure('SCHEDULE_INSTALL_FAILED', 'An enabled QuickBooks plan with brain.domain in this machine timezone is required.');
  const definition = buildQuickBooksScheduleDefinition(plan, options);
  const adapter = adapterFor(options); const before = adapter.read(plan.identity); owned(before);
  if (exact(before, definition)) return { installed: true, verified: true, enabled: true, changed: false, definition };
  try {
    adapter.install(definition, { replaceOwned: before?.exists === true, expected: before });
    const readback = adapter.read(plan.identity);
    if (!exact(readback, definition)) throw failure('SCHEDULE_INSTALL_FAILED', 'QuickBooks task exact readback failed.');
    return { installed: true, verified: true, enabled: true, changed: true, definition };
  } catch (error) {
    restoreQuickBooksSchedule(plan, before, { ...options, adapter });
    throw error;
  }
}
export function removeQuickBooksSchedule(plan, options = {}) {
  const adapter = adapterFor(options); const before = adapter.read(plan.identity); owned(before);
  if (!before?.exists) return { removed: false };
  adapter.remove(plan.identity, { expected: before });
  if (adapter.read(plan.identity)?.exists) throw failure('SCHEDULE_INSTALL_FAILED', 'QuickBooks task removal did not pass readback.');
  return { removed: true };
}
export function listQuickBooksProcesses({ spawn = spawnSync, environment = process.env } = {}) {
  const root = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  if (!win32.isAbsolute(root || '')) throw failure('SCHEDULE_RUN_FAILED', 'Windows process inspection is unavailable.');
  const result = spawn(win32.join(root, 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: { SystemRoot: root, ...(environment.WINDIR ? { WINDIR: environment.WINDIR } : {}) },
  });
  if (result?.status !== 0) throw failure('SCHEDULE_RUN_FAILED', 'Windows process inspection failed.');
  return String(result.stdout || '').split(/\r?\n/u).filter(Boolean).map(line => {
    const match = line.match(/^"([^"]+)","\d+",/u);
    if (!match) throw failure('SCHEDULE_RUN_FAILED', 'Windows process inspection returned an invalid result.');
    return match[1];
  });
}
export async function runQuickBooksSchedule({ plan, now = () => new Date(), state = quickBooksScheduleState(),
  acquireLock = acquireBrainLifecycleLock, listProcesses = listQuickBooksProcesses, runSource, writeReceipt = () => {} } = {}) {
  if (!plan?.enabled || !plan.ready || typeof runSource !== 'function') throw failure('SCHEDULE_RUN_FAILED', 'An enabled QuickBooks plan and source runner are required.');
  let lock;
  try { lock = acquireLock({ manifestPath: plan.manifest_path, operation: 'quickbooks-refresh' }); }
  catch (error) {
    if (!['brain_lifecycle_busy', 'brain_lifecycle_recovery_required'].includes(error.code)) throw error;
    return { status: 'deferred', code: error.code, sources: [] };
  }
  const results = [];
  try {
    const deadline = +dateOf(now()) + 30 * 60000;
    const outsideWindow = (at = dateOf(now())) => {
      const window = quickBooksWindow({ timezone: plan.timezone, now: at, start: plan.start });
      return +at >= deadline || window.local_minutes < window.start_minutes || window.local_minutes >= window.cutoff_minutes;
    };
    for (const source of plan.sources) {
      lock.assertOwned();
      let prior = null; let stateRead = false; let receipt;
      try {
        const began = dateOf(now());
        prior = await state.read(plan, source); stateRead = true;
        let code;
        const checkedAt = dateOf(now());
        const age = prior?.last_complete_snapshot_at ? +checkedAt - Date.parse(prior.last_complete_snapshot_at) : Infinity;
        if (plan.platform === 'darwin' && source.key === 'quickbooks_desktop') code = 'QB_PLATFORM_UNAVAILABLE';
        else if (outsideWindow(checkedAt)) code = 'QB_OUTSIDE_WINDOW';
        else if (age >= 0 && age < 6 * 3600000 && prior?.last_run_failed === false) code = 'QB_FRESH';
        else if (source.key === 'quickbooks_desktop' && !(await listProcesses()).some(name => /^QBW[^\\/]*\.exe$/iu.test(name))) code = 'QB_NOT_OPEN';
        // Process inspection and durable state writes may span the cutoff.
        // Recheck their completion, not only the time when the run began.
        if (!code && outsideWindow()) code = 'QB_OUTSIDE_WINDOW';
        if (code) {
          receipt = { source: source.key, status: 'skipped', code };
        } else {
          // Persist retry intent first. A crash cannot make a partial run fresh.
          lock.assertOwned();
          await state.write(plan, source, { last_complete_snapshot_at: prior?.last_complete_snapshot_at || null, last_run_failed: true });
          const result = outsideWindow() ? { status: 'skipped', code: 'QB_OUTSIDE_WINDOW' }
            : await runSource(source, { assertOwned: () => lock.assertOwned() });
          if (result?.status === 'skipped' && ['QB_CONNECT_REQUIRED', 'QB_OUTSIDE_WINDOW'].includes(result?.code)) {
            lock.assertOwned();
            await state.write(plan, source, { last_complete_snapshot_at: prior?.last_complete_snapshot_at || null,
              last_run_failed: prior?.last_run_failed === true });
            receipt = { source: source.key, status: 'skipped', code: result.code };
          } else {
            const closed = result?.receipt;
            const closedAt = Date.parse(closed?.completed_at);
            if (closed?.status !== 'ready' || !Number.isFinite(closedAt) || closedAt < +began || closedAt > +dateOf(now())) throw failure('SCHEDULE_RUN_FAILED', 'QuickBooks did not close a ready source receipt.');
            lock.assertOwned();
            await state.write(plan, source, { last_complete_snapshot_at: new Date(closedAt).toISOString(), last_run_failed: false });
            receipt = { source: source.key, status: 'ready', code: 'QB_READY' };
          }
        }
      } catch {
        if (stateRead) {
          // If the lease or state store failed, do not turn the failed write
          // into fresh evidence. The next run must verify that boundary again.
          try { lock.assertOwned(); await state.write(plan, source, {
            last_complete_snapshot_at: prior?.last_complete_snapshot_at || null, last_run_failed: true,
          }); } catch { /* The error receipt remains explicit; no cursor advances. */ }
        }
        receipt = { source: source.key, status: 'error', code: 'SCHEDULE_RUN_FAILED' };
      }
      results.push(receipt); await writeReceipt(receipt);
    }
    return { status: results.some(r => r.status === 'error') ? 'error' : 'ready', sources: results };
  } finally { lock.release(); }
}

function readManifest(path, options) {
  return (options.readManifest || (p => JSON.parse(readFileSync(p, 'utf8'))))(path);
}
function schedulingOptions(options) {
  return { ...options, ...(options.schedulerOptions || {}), ...(options.quickBooksSchedulerOptions || {}) };
}
async function schedulerOperations(plan, manifestPath, options) {
  const native = schedulingOptions(options);
  if (plan.platform === 'win32') return {
    status: options.quickBooksStatus || (() => statusQuickBooksSchedule(plan, native)),
    register: options.quickBooksRegister || (() => registerQuickBooksSchedule(plan, native)),
    remove: options.quickBooksRemove || (() => removeQuickBooksSchedule(plan, native)),
    restore: options.quickBooksRestore || (snapshot => restoreQuickBooksSchedule(plan, snapshot?.state, native)),
  };
  const provider = options.providerScheduler || await import('./provider-scheduler.mjs');
  const providerOptions = { ...options, ...(options.legacySchedulerOptions || {}), ...(options.quickBooksSchedulerOptions || {}) };
  return {
    status: () => provider.snapshotQuickBooksProviderScheduler(manifestPath, providerOptions),
    register: () => provider.installProviderScheduler('quickbooks', manifestPath, providerOptions),
    remove: () => provider.removeQuickBooksProviderScheduler(manifestPath, providerOptions),
    restore: snapshot => provider.restoreQuickBooksProviderSnapshot(manifestPath, snapshot, providerOptions),
  };
}
async function expectations(m, path, seconds, options, cli) {
  if (options.syncExpectations) return options.syncExpectations(m, path, seconds);
  const sources = QUICKBOOKS_KEYS.filter(key => m.corpora?.[key]?.enabled === true);
  if (!sources.length) return;
  const key = (options.resolveAdminKey || cli.resolveAdminKey)(path);
  if (!key) throw failure('SCHEDULE_INSTALL_FAILED', 'No durable admin key is available for QuickBooks freshness verification.');
  const base = await options.resolveBaseUrl(m, null);
  for (const source of sources) await (options.postSourceExpectation || cli.postSourceExpectation)(base, key, {
    source: m.corpora[source].source || source, kind: 'quickbooks', expected_refresh_seconds: seconds,
  });
}
/** The same owned daily-on transaction is used after either edition writes its manifest. */
export async function reregisterAfterManifestChange(manifestPath, options = {}) {
  if (!options.lifecycleLockHeld) return (options.withBrainLifecycleLock || withBrainLifecycleLock)({
    manifestPath, operation: 'quickbooks-schedule', ...(options.lifecycleLockOptions || {}),
  }, () => reregisterAfterManifestChange(manifestPath, { ...options, lifecycleLockHeld: true }));
  const cli = options.cli || await import('../brain.mjs');
  options = { ...cli.quickBooksScheduleDependencies?.(), ...options };
  const m = readManifest(manifestPath, options);
  if (m.operations?.quickbooks_schedule === undefined && QUICKBOOKS_KEYS.some(key => m.corpora?.[key]?.enabled === true)) {
    // Calling this hook after an attended connect opts into the dedicated task.
    // Existing installs never call it until a new path is explicitly enabled.
    const writer = options.writeManifestAtomically || cli.writeManifestAtomically;
    const intended = { ...m, operations: { ...m.operations, quickbooks_schedule: { enabled: true } } };
    writer(manifestPath, intended, { backupLabel: 'quickbooks-connect-schedule' });
    try { return await reregisterAfterManifestChange(manifestPath, options); }
    catch (error) { writer(manifestPath, m, { backupLabel: 'quickbooks-connect-schedule-rollback' }); throw error; }
  }
  const plan = planQuickBooksSchedule({ m, manifestPath, ...options });
  if (!plan.ready) throw failure('SCHEDULE_INSTALL_FAILED', 'QuickBooks scheduling requires a supported platform and the same timezone as this machine.');
  const operations = await schedulerOperations(plan, manifestPath, options);
  const beforeQuickBooks = operations.status();
  const beforePlan = await cli.buildConfiguredDailyPlan(m, manifestPath, options);
  const dailyOptions = { platform: options.platform, ...(options.schedulerOptions || {}),
    ...(options.schedulerAdapter ? { adapter: options.schedulerAdapter } : {}) };
  const beforeDaily = (options.dailyStatus || statusDailyRefreshSchedule)(beforePlan, dailyOptions);
  const owners = (beforePlan.sources || []).filter(s => s.owner === 'existing-local-scheduler' && !QUICKBOOKS_KEYS.includes(s.key)).map(s => s.key);
  const willSchedule = plan.enabled && plan.sources.length > 0;
  if (willSchedule) owners.push(...QUICKBOOKS_KEYS);
  let dailyAttempted = false; let quickBooksAttempted = false;
  try {
    dailyAttempted = true;
    // The lifecycle lease keeps the temporarily rebound daily runner from
    // starting before its dedicated QuickBooks owner is installed/read back.
    const daily = await cli.cmdDaily(['on', manifestPath], { ...options, flags: {}, quiet: true,
      lifecycleLockHeld: true, existingSchedulerOwners: owners, allowQuickBooksOnly: true });
    if (!daily?.schedule?.installed || !daily.schedule.enabled || !daily.schedule.verified) throw new Error('Daily readback failed');
    quickBooksAttempted = true;
    const quickbooks = willSchedule ? operations.register() : operations.remove();
    if (willSchedule && (quickbooks?.installed !== true || quickbooks?.verified !== true)) throw new Error('QuickBooks readback failed');
    await expectations(m, manifestPath, willSchedule ? QUICKBOOKS_REFRESH_SECONDS : null, options, cli);
    return { verified: true, daily, quickbooks };
  } catch (cause) {
    let restored = true;
    if (quickBooksAttempted) { try { operations.restore(beforeQuickBooks); } catch { restored = false; } }
    if (dailyAttempted) {
      try {
        if (options.restoreDaily) options.restoreDaily(beforeDaily);
        else if (beforeDaily.installed) restoreDailyRefreshSchedule({ identity: beforePlan.identity, exists: true,
          enabled: beforeDaily.enabled === true, definition: beforeDaily.state.definition }, dailyOptions);
        else removeDailyRefreshSchedule(beforePlan, dailyOptions);
        const current = readManifest(manifestPath, options);
        if (JSON.stringify(current.operations?.daily_refresh) !== JSON.stringify(m.operations?.daily_refresh)) {
          (options.writeManifestAtomically || cli.writeManifestAtomically)(manifestPath, m, { backupLabel: 'quickbooks-daily-intent-rollback' });
        }
      } catch { restored = false; }
    }
    const error = failure('SCHEDULE_INSTALL_FAILED', restored
      ? 'Daily imports are installed, but their definition no longer matches this manifest. The previous safe schedule was preserved; daily schedule needs attention.'
      : 'Daily schedule needs attention. The prior native schedule could not be restored and must be inspected before retrying.');
    error.needs_attention = true; error.rollback_verified = restored;
    // Do not include provider output or local paths in this public failure.
    throw error;
  }
}
export async function commandQuickBooksSchedule(argv, options = {}) {
  const [noun, action, manifestPath, ...flags] = argv;
  if (noun !== 'schedule' || !['on', 'off', 'status'].includes(action) || !manifestPath || flags.some(f => f !== '--json')) {
    throw failure('SCHEDULE_INSTALL_FAILED', 'Use QuickBooks schedule on, off or status with a manifest.');
  }
  const cli = options.cli || await import('../brain.mjs');
  options = { ...cli.quickBooksScheduleDependencies?.(), ...options };
  if (action === 'status') {
    const m = readManifest(manifestPath, options);
    const plan = planQuickBooksSchedule({ m, manifestPath, ...options });
    const operations = await schedulerOperations(plan, manifestPath, options);
    const status = operations.status();
    const result = { installed: status.installed === true, enabled: status.enabled === true || status.loaded === true,
      verified: status.verified === true, expected_refresh_seconds: QUICKBOOKS_REFRESH_SECONDS, ...describeWindow(plan) };
    if (!options.quiet) console.log(JSON.stringify(result));
    return result;
  }
  return (options.withBrainLifecycleLock || withBrainLifecycleLock)({ manifestPath, operation: 'quickbooks-schedule',
    ...(options.lifecycleLockOptions || {}),
  }, async () => {
    const m = readManifest(manifestPath, options);
    const next = { ...m, operations: { ...m.operations, quickbooks_schedule: { ...m.operations?.quickbooks_schedule, enabled: action === 'on' } } };
    const writer = options.writeManifestAtomically || cli.writeManifestAtomically;
    writer(manifestPath, next, { backupLabel: 'quickbooks-schedule-intent' });
    try {
      const result = await reregisterAfterManifestChange(manifestPath, { ...options, cli, lifecycleLockHeld: true });
      if (!options.quiet) console.log(JSON.stringify({ verified: result.verified, enabled: action === 'on' }));
      return result;
    } catch (error) {
      writer(manifestPath, m, { backupLabel: 'quickbooks-schedule-intent-rollback' });
      throw error;
    }
  });
}
export async function runQuickBooksScheduleCli(manifestPath, options = {}) {
  const cli = options.cli || await import('../brain.mjs');
  options = { ...cli.quickBooksScheduleDependencies?.(), ...options };
  if (!options.lifecycleLockHeld) {
    try {
      return await (options.withBrainLifecycleLock || withBrainLifecycleLock)({
        manifestPath, operation: 'quickbooks-refresh', ...(options.lifecycleLockOptions || {}),
      }, lock => runQuickBooksScheduleCli(manifestPath, { ...options, lifecycleLockHeld: true, lifecycleLease: lock }));
    } catch (error) {
      if (['brain_lifecycle_busy', 'brain_lifecycle_recovery_required'].includes(error.code)) return { status: 'deferred', code: error.code, sources: [] };
      throw error;
    }
  }
  const m = readManifest(manifestPath, options);
  const plan = planQuickBooksSchedule({ m, manifestPath, ...options });
  if (plan.platform === 'win32') {
    const status = statusQuickBooksSchedule(plan, schedulingOptions(options));
    if (!status.verified || status.definition.definition_hash !== options.expectedDefinitionHash) throw quickBooksScheduleRegistrationRequired();
  } else if (plan.platform === 'darwin') {
    const providers = options.providerScheduler || await import('./provider-scheduler.mjs');
    const status = providers.statusProviderScheduler('quickbooks', manifestPath, { ...options, ...(options.legacySchedulerOptions || {}) });
    if (!status.definitionMatches || !status.loaded || status.configHash !== options.expectedProviderConfigHash) throw quickBooksScheduleRegistrationRequired();
  }
  const runSource = options.runSource || (async source => {
    if (source.key === 'quickbooks_desktop') {
      // Packet 07 supplies the adapter. Missing capability is visible and can
      // never be mistaken for a successful snapshot or suppress other sources.
      if (!options.runDesktopSource) return { status: 'skipped', code: 'QB_CONNECT_REQUIRED' };
      return options.runDesktopSource(m, manifestPath, source, options);
    }
    const planned = await cli.planLoad({ m, manifestPath, flags: { only: source.key }, options,
      ...(options.probes ? { probes: options.probes } : {}) });
    const entry = planned.find(row => row.key === source.key);
    if (entry?.reason?.startsWith('enabled, but not connected on this machine:')) return { status: 'skipped', code: 'QB_CONNECT_REQUIRED' };
    if (entry?.status !== 'ready') throw failure('SCHEDULE_RUN_FAILED', 'QuickBooks source is unavailable.');
    let receipt = null;
    await cli.cmdIngestProvider(m, manifestPath, { from: source.key }, { ...options,
      postSourceReceipt: async (...args) => {
        const response = await (options.postSourceReceipt || cli.postSourceReceipt)(...args);
        // Capture only after the real receipt endpoint has accepted the close.
        if (args[2]?.status === 'ready' || args[2]?.status === 'error') receipt = args[2];
        return response;
      },
    });
    return { receipt };
  });
  if (plan.platform === 'win32') process.title = QUICKBOOKS_CONSOLE_TITLE;
  return runQuickBooksSchedule({ plan, now: options.clock || (() => new Date()), state: options.state || quickBooksScheduleState(options),
    acquireLock: () => ({ assertOwned: () => options.lifecycleLease?.assertOwned(), release() {} }),
    listProcesses: options.listProcesses || (() => listQuickBooksProcesses(options)), runSource,
    writeReceipt: options.writeReceipt || (() => {}) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path, flag, hash] = process.argv.slice(2);
  if (command !== 'quickbooks-run' || !path || flag !== '--definition-hash' || !/^sha256:[a-f0-9]{64}$/u.test(hash || '')) {
    console.error('QuickBooks scheduled invocation is invalid.'); process.exitCode = 1;
  } else {
    if (process.platform === 'win32') process.title = QUICKBOOKS_CONSOLE_TITLE;
    runQuickBooksScheduleCli(path, { expectedDefinitionHash: hash }).then(result => {
      console.log(JSON.stringify(result)); process.exitCode = result.status === 'error' ? 1 : 0;
    }).catch(() => { console.error('QuickBooks schedule needs attention. Re-register the schedule before retrying. Issue code: SCHEDULE_RUN_FAILED'); process.exitCode = 1; });
  }
}
