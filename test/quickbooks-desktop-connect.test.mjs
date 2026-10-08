import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, lstatSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestPlanStore } from './helpers/ingest-plan-store.mjs';
import { connectQuickBooksDesktop, disconnectQuickBooksDesktop, desktopBindingStore, makeDesktopBinding } from '../connectors/quickbooks-desktop-binding.mjs';
import { desktopFixture, desktopBridge, SNAPSHOT } from './fixtures/quickbooks-desktop-qbxml.mjs';
import { probeQuickBooksEdition, hasDesktopElevation } from '../connectors/quickbooks-edition-probe.mjs';
import * as brain from '../brain.mjs';
const { quickBooksWorkerClock, cmdIngestQuickBooksDesktop, planLoad, cmdConnect, providerConfigurationFingerprint } = brain;

const manifestPath = String.raw`C:\Fixtures\brain.manifest.json`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function harness(rows = desktopFixture()) {
  const calls = []; let manifest = { client: { slug: 'owner' }, brain: { domain: 'brain.example.invalid' }, corpora: {
    gmail: { enabled: true }, google_drive: { enabled: true } } }; let binding = null;
  const bridge = desktopBridge(rows, { calls });
  const deps = { platform: 'win32', brainPath: String.raw`C:\Runtime\brain.mjs`, nodePath: String.raw`C:\Runtime\node.exe`, principal: 'sid:S-1-5-21-100',
    now: () => new Date(SNAPSHOT), monotonic: () => 0, sleep: async () => { calls.push('sleep'); }, log: value => calls.push({ log: value }),
    readManifest: async () => structuredClone(manifest), writeManifest: async (_path, next) => { calls.push('manifest'); assert.ok(binding); manifest = next; },
    bindingStore: { read: async () => binding, write: async value => { calls.push('binding'); binding = value; }, remove: async () => { calls.push('remove-binding'); binding = null; } },
    listQuickBooksSources: async () => { calls.push('edition-guard'); return []; },
    verifyHelper: async () => { calls.push('signature'); return { ok: true }; }, hasElevation: async () => { calls.push('elevation'); return false; },
    startTask: async task => { calls.push({ task }); return { started: true, verified: true }; },
    listProcesses: async () => { calls.push('process'); return ['QBW32.exe']; }, bridge,
    registerSource: async source => { calls.push({ source }); }, reregister: async () => { calls.push('both-tasks'); return { verified: true }; },
    runSnapshot: async () => { calls.push('snapshot'); return { enumeration_complete: true, code: 'QB_FRESHNESS_UNVERIFIED', tally: { created: 9 } }; },
    previewForget: async args => { calls.push({ preview: args }); return { documents: 9, generation: 1 }; },
    forget: async args => { calls.push({ forget: args }); return { sourceUnregistered: true, removed: 9 }; },
  };
  return { calls, deps, manifest: () => manifest, binding: () => binding };
}
const attended = deps => connectQuickBooksDesktop({ manifestPath, flags: { 'attended-probe': true } }, deps);

test('connect starts a bounded one-shot without touching the manifest or helper bridge', async () => {
  const h = harness(); const before = hash(h.manifest());
  const result = await connectQuickBooksDesktop({ manifestPath }, h.deps);
  assert.equal(result.status, 'pending'); assert.equal(hash(h.manifest()), before); assert.equal(h.binding(), null);
  assert.deepEqual(h.calls.slice(0, 3), ['edition-guard', 'signature', 'elevation']);
  assert.equal(h.calls.filter(call => call.operation).length, 0);
  assert.deepEqual(h.calls.find(call => call.task).task.arguments, [h.deps.brainPath, 'connect', 'quickbooks-desktop', manifestPath, '--attended-probe']);
  assert.match(h.calls.find(call => call.task).task.serialized, /<ExecutionTimeLimit>PT15M/);
});

test('attended success orders binding, manifest, source registration, both tasks and one snapshot', async () => {
  const h = harness(); const result = await attended(h.deps);
  assert.equal(result.status, 'connected'); assert.equal(result.code, 'QB_FRESHNESS_UNVERIFIED');
  assert.ok(h.calls.indexOf('binding') < h.calls.indexOf('manifest'));
  assert.ok(h.calls.indexOf('manifest') < h.calls.indexOf('both-tasks'));
  assert.ok(h.calls.indexOf('both-tasks') < h.calls.indexOf('snapshot'));
  assert.deepEqual(h.calls.find(call => call.source).source, { source: 'quickbooks_desktop', kind: 'quickbooks', expected_refresh_seconds: 86400 });
  const plan = await planLoad({ m: h.manifest(), manifestPath, platform: 'win32', probes: { gmail: () => ({ connected: true }), google_drive: () => ({ connected: true }) } });
  for (const key of ['gmail', 'google_drive', 'quickbooks_desktop']) assert.equal(plan.find(row => row.key === key).status, 'ready');
  const mac = await planLoad({ m: h.manifest(), manifestPath, platform: 'darwin', probes: { gmail: () => ({ connected: true }), google_drive: () => ({ connected: true }) } });
  assert.equal(mac.find(row => row.key === 'quickbooks_desktop').status, 'unavailable');
});

for (const [name, update, code, reached] of [
  ['elevated', h => { h.deps.hasElevation = async () => { h.calls.push('elevation'); return true; }; }, 'QB_ELEVATED', 'elevation'],
  ['broad grant', h => { const rows = desktopFixture(); rows.PreferencesRet[0]['CurrentAppAccessRights.IsAutomaticLoginAllowed'] = 'true'; h.deps.bridge = desktopBridge(rows, { calls: h.calls }); }, 'QB_GRANT_TOO_BROAD', 'probe'],
  ['prompts', h => { const bridge = h.deps.bridge; h.deps.bridge = async input => input.operation === 'probe2' ? (h.calls.push(input), { ok: false, code: 'QB_GRANT_PROMPTS' }) : bridge(input); }, 'QB_GRANT_PROMPTS', 'probe2'],
  ['missing signature', h => { h.deps.verifyHelper = async () => { h.calls.push('signature'); return { ok: false }; }; }, 'QB_HELPER_UNAVAILABLE', 'signature'],
]) test(`connect ${name} reaches the refusal and leaves the manifest byte-identical`, async () => {
  assert.equal((await attended(harness().deps)).status, 'connected');
  const h = harness(); const before = hash(h.manifest()); update(h);
  await assert.rejects(attended(h.deps), { code });
  assert.ok(h.calls.some(call => call === reached || call.operation === reached));
  assert.equal(hash(h.manifest()), before); assert.equal(h.binding(), null); assert.equal(h.calls.filter(call => call.task).length, 0);
});

test('non-US connection retains the explicit boundary notice', async () => {
  const rows = desktopFixture(); rows.HostRet[0].Country = 'CA';
  const h = harness(rows); const result = await attended(h.deps);
  assert.match(result.notice, /money answers are US-only/); assert.equal(h.binding().country, 'CA');
});

test('lost binding cannot adopt existing Desktop families without a company identity readback', async () => {
  assert.equal((await attended(harness().deps)).status, 'connected');
  const h = harness();
  h.deps.listQuickBooksSources = async () => { h.calls.push('stored-company'); return [{ name: 'quickbooks_desktop', kind: 'quickbooks', family_count: 3 }]; };
  const before = hash(h.manifest());
  await assert.rejects(attended(h.deps), { code: 'QB_BINDING_RECOVERY_REQUIRED' });
  assert.ok(h.calls.includes('stored-company')); assert.ok(h.calls.some(call => call.operation === 'probe2'));
  assert.equal(hash(h.manifest()), before); assert.equal(h.binding(), null);
});

test('disconnect uses the exact company-bound preview, and preserves other corpora', async () => {
  const h = harness(); await attended(h.deps);
  const fingerprint = h.binding().fingerprint;
  const preview = await disconnectQuickBooksDesktop({ manifestPath }, h.deps);
  assert.equal(preview.code, 'QB_REMOVAL_APPROVAL_REQUIRED');
  assert.equal(h.calls.filter(call => call.preview).length, 1); assert.equal(h.calls.filter(call => call.forget).length, 0);
  const result = await disconnectQuickBooksDesktop({ manifestPath, flags: { 'approve-removals': preview.fingerprint } }, h.deps);
  assert.equal(result.status, 'disconnected'); assert.equal(h.binding(), null);
  assert.equal(h.manifest().corpora.quickbooks_desktop.enabled, false); assert.equal(h.manifest().corpora.gmail.enabled, true);
  assert.equal(h.calls.filter(call => call.forget).length, 1);
  assert.deepEqual(h.calls.find(call => call.forget).forget, { source: 'quickbooks_desktop', companyFingerprint: fingerprint, preview: { documents: 9, generation: 1 } });
  assert.equal(h.calls.filter(call => call === 'both-tasks').length, 2);
});

test('read-only edition and elevation probes use injected registry/files only', () => {
  let calls = 0;
  const registry = key => { calls++; return key.includes('CLSID') ? 'REG_SZ {synthetic}' : key.includes('Uninstall') ? 'QuickBooks' : ''; };
  assert.equal(probeQuickBooksEdition({ platform: 'win32', registry }), 'windows-desktop'); assert.ok(calls >= 2);
  assert.equal(probeQuickBooksEdition({ platform: 'win32', registry: () => '', readShortcuts: () => ['remoteapplicationname:s:QuickBooks'] }), 'hosted');
  assert.equal(probeQuickBooksEdition({ platform: 'darwin', listApps: () => ['QuickBooks 2024.app'] }), 'mac-desktop');
  assert.equal(probeQuickBooksEdition({ platform: 'linux' }), 'none');
  let queried = 0;
  assert.equal(hasDesktopElevation({ registry: () => { queried++; return String.raw`  C:\Program Files\QuickBooks\QBW32.exe    REG_SZ    ~ RUNASADMIN`; } }), true);
  assert.ok(queried); assert.equal(hasDesktopElevation({ registry: () => '' }), false);
});

test('edition router reaches Online only when local probing returns none', async () => {
  let online = 0; let probes = 0; const logs = [];
  for (const edition of ['mac-desktop', 'hosted', 'none']) {
    const result = await cmdConnect('quickbooks', { argv: ['node', 'brain.mjs', 'connect', 'quickbooks', manifestPath],
      probeQuickBooksEdition: () => { probes++; return edition; }, log: value => logs.push(value),
      connectOnline: async () => { online++; return { status: 'online' }; } });
    assert.equal(result.status, edition === 'none' ? 'online' : 'unavailable');
  }
  assert.equal(probes, 3); assert.equal(online, 1); assert.equal(logs.length, 2);
});

test('Worker time ignores a PC two hours fast and refuses missing date after a reached read', async () => {
  let ticks = 500; let reads = 0;
  const clock = await quickBooksWorkerClock({ readWorkerDate: async () => { reads++; return 'Wed, 07 Oct 2026 12:00:00 GMT'; }, monotonic: () => ticks });
  ticks += 321; assert.equal(clock(), '2026-10-07T12:00:00.321Z');
  await assert.rejects(quickBooksWorkerClock({ readWorkerDate: async () => { reads++; return null; }, monotonic: () => ticks }), { code: 'QB_CLOCK_UNVERIFIED' });
  assert.equal(reads, 2);
});

test('binding is owner-only, exactly read back and rejects links without replacing them', async () => {
  const root = join(process.env.HOME, 'binding-tests'); mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = realpathSync.native(mkdtempSync(join(root, 'case-')));
  try {
    const store = desktopBindingStore({ home, platform: 'darwin' });
    const value = makeDesktopBinding({ accounts: desktopFixture().AccountRet, country: 'US' });
    store.write(value); assert.deepEqual(store.read(), value);
    const path = join(home, '.brain', 'quickbooks-desktop.json'); assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8').includes('Checking'), false);
    store.remove(); const target = join(home, 'target'); writeFileSync(target, 'unchanged'); symlinkSync(target, path);
    await assert.rejects(async () => store.write(value), { code: 'QB_BINDING_INVALID' });
    assert.equal(readFileSync(target, 'utf8'), 'unchanged');
  } finally { rmSync(home, { recursive: true }); }
});

test('configuration fingerprint binds Desktop company without changing other provider bytes', () => {
  const a = providerConfigurationFingerprint('quickbooks', 'quickbooks_desktop', { enabled: true }, { qbo_company_fingerprint: 'a'.repeat(64) });
  const b = providerConfigurationFingerprint('quickbooks', 'quickbooks_desktop', { enabled: true }, { qbo_company_fingerprint: 'b'.repeat(64) });
  assert.notEqual(a, b);
  assert.equal(providerConfigurationFingerprint('slack', 'slack', { enabled: true }), providerConfigurationFingerprint('slack', 'slack', { enabled: true }, { qbo_company_fingerprint: 'a'.repeat(64) }));
});

test('public ingest and load legs forward the held lifecycle lease into Desktop', async () => {
  const m = { client: { slug: 'owner' }, brain: { domain: 'brain.example.invalid' }, corpora: { quickbooks_desktop: { enabled: true } } };
  let reached = 0; let locks = 0;
  const options = { platform: 'win32', lifecycleLockHeld: true, assertOwned() {},
    withBrainLifecycleLock: async (_input, run) => { locks++; return run({ assertOwned() {} }); },
    ingestQuickBooksDesktop: async (_m, _path, _flags, passed) => { reached++; assert.equal(passed?.lifecycleLockHeld, true); return { code: 'fixture' }; } };
  const plan = await planLoad({ m, manifestPath, platform: 'win32', options, commands: { ingestQuickBooksDesktop: options.ingestQuickBooksDesktop } });
  assert.equal(plan[0].status, 'ready'); await plan[0].legs[0].run(); assert.equal(reached, 1);
  assert.equal(typeof brain.cmdIngest, 'function');
  const path = join(process.env.HOME, 'nested-lock.manifest.json'); writeFileSync(path, JSON.stringify(m));
  const output = await brain.cmdIngest(path, { ...options, lifecycleLockHeld: false, flags: { from: 'quickbooks-desktop' } });
  assert.equal(output.code, 'fixture'); assert.equal(reached, 2); assert.equal(locks, 1);
});

test('Desktop public command classification never opens the outer control-plane credential session', async () => {
  let sessions = 0; let runs = 0;
  const options = { withWranglerSession: async run => { sessions++; return run(); } };
  await brain.runCliCommandWithCredentialBoundary('verify', () => { runs++; }, options);
  assert.equal(sessions, 1, 'the positive control reaches the outer session dependency');
  for (const [command, argv] of [
    ['connect', ['quickbooks', manifestPath]], ['connect', ['quickbooks-desktop', manifestPath, '--attended-probe']],
    ['disconnect', ['quickbooks-desktop', manifestPath]], ['ingest', [manifestPath, '--from', 'quickbooks-desktop']],
    ['load', [manifestPath, '--only', 'quickbooks_desktop']],
  ]) await brain.runCliCommandWithCredentialBoundary(brain.classifyCliCredentialBoundary(command, argv), () => { runs++; }, options);
  assert.equal(runs, 6); assert.equal(sessions, 1);
});

test('the attended child waits for its launching command lease before entering the shared binding lease', async () => {
  const h = harness(); let waits = 0; let records = 0;
  const result = await brain.cmdConnectQuickBooksDesktop(manifestPath, { 'attended-probe': true }, {
    ...h.deps, quiet: true,
    withBrainLifecycleLock: async () => { throw Object.assign(new Error('fixture busy'), { code: 'brain_lifecycle_busy' }); },
    withBrainLifecycleLockWait: async (input, run) => { waits++; assert.equal(input.waitMs, 30000); return run({ assertOwned() {} }); },
    withSourceIngestLock: async (input, run) => { records++; assert.equal(input.sharedRecord, 'provider:quickbooks-desktop'); return run({ assertOwned() {} }); },
  });
  assert.equal(result.status, 'connected'); assert.equal(waits, 1); assert.equal(records, 1);
});

test('non-Windows connect refuses before any lifecycle or binding write', async () => {
  const h = harness();
  const green = await brain.cmdConnectQuickBooksDesktop(manifestPath, { 'attended-probe': true }, { ...h.deps,
    lifecycleLockHeld: true, withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
  });
  assert.equal(green.status, 'connected');
  let locks = 0;
  await assert.rejects(brain.cmdConnectQuickBooksDesktop(manifestPath, {}, { platform: 'darwin',
    withBrainLifecycleLock: async (_input, run) => { locks++; return run({ assertOwned() {} }); },
    withSourceIngestLock: async (_input, run) => { locks++; return run({ assertOwned() {} }); },
  }), { code: 'QB_NOT_INSTALLED' });
  assert.equal(locks, 0);
});

test('the CLI one-shot binds the verified current-user SID and injected executable paths', async () => {
  const h = harness(); let principals = 0;
  const result = await brain.cmdConnectQuickBooksDesktop(manifestPath, {}, { ...h.deps, principal: undefined,
    resolvePrincipal: () => { principals++; return 'sid:S-1-5-21-100'; },
    lifecycleLockHeld: true, withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
  });
  assert.equal(result.status, 'pending'); assert.equal(principals, 1);
  const task = h.calls.find(call => call.task).task;
  assert.equal(task.command, h.deps.nodePath); assert.equal(task.arguments[0], h.deps.brainPath);
  assert.match(task.serialized, /<UserId>S-1-5-21-100<\/UserId>/);
});

// The real connector and SQLite removal route share this fixture. A legacy
// family delete or a provider/credential request cannot leave the process.
globalThis.fetch = async () => { throw new Error('unexpected network attempt'); };
for (const large of [false, true]) test(`Desktop ${large ? 'large' : 'small'} removal saves accepted work and requires a separate exact apply`, async t => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'desktop-plan-')));
  const path = join(home, 'manifest.json');
  const keyFile = join(home, 'fixture-admin-key'); writeFileSync(keyFile, 'synthetic-fixture-key', { mode: 0o600 });
  const m = { brain: { domain: 'brain.example.invalid' }, corpora: { quickbooks_desktop: { enabled: true } } };
  writeFileSync(path, JSON.stringify(m));
  const rows = desktopFixture(); rows.TxnDeletedRet = [{ TxnDelType: 'Invoice', TxnID: 'FF-999' }];
  let binding = makeDesktopBinding({ accounts: rows.AccountRet, country: 'US' });
  const store = ingestPlanStore(); store.put('quickbooks_desktop:invoice:FF-999');
  if (!large) for (let i = 0; i < 20; i++) store.put(`quickbooks_desktop:payment:EE-${i}`);
  t.after(() => { store.db.close(); rmSync(home, { recursive: true, force: true }); });
  const receipts = []; const requests = []; const logs = []; const locks = [];
  let bindingLeaseLost = false; let loseLeaseOnPreview = false;
  let forgotten = 0; let bindingReads = 0; let bindingWrites = 0; let bridgeCalls = 0;
  const bridge = desktopBridge(rows);
  const options = { platform: 'win32', lifecycleLockHeld: true, assertOwned() {},
    withSourceIngestLock: async (input, task) => {
      const name = input.sharedRecord || input.sourceName; locks.push(name);
      try { return await task({ assertOwned() {
        assert.ok(locks.includes(name));
        if (name === 'provider:quickbooks-desktop' && bindingLeaseLost) throw Object.assign(new Error('fixture lease lost'), { code: 'source_ingest_lock_lost' });
      } }); }
      finally { assert.equal(locks.pop(), name); }
    },
    bindingStore: { read: async () => { bindingReads++; assert.ok(locks.includes('provider:quickbooks-desktop')); return binding; },
      write: async next => { bindingWrites++; assert.ok(locks.includes('provider:quickbooks-desktop')); binding = next; } },
    resolveAdminKey: () => readFileSync(keyFile, 'utf8'), resolveBaseUrl: async () => 'https://brain.example.invalid',
    readWorkerDate: async () => 'Wed, 07 Oct 2026 12:00:00 GMT', monotonic: () => 0,
    bridge: async input => { bridgeCalls++; return bridge(input); }, log: value => logs.push(value),
    listStoredSourceFamilies: store.inventory,
    removalPlanRequest: async input => {
      assert.ok(locks.includes('provider:quickbooks-desktop'));
      const result = await store.request(input);
      if (loseLeaseOnPreview && input.body.action === 'preview') bindingLeaseLost = true;
      return result;
    },
    removalPlanRuntime: () => 'fixture-runtime',
    postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return {}; },
    requestIngestBatch: async ({ docs }) => {
      requests.push(docs);
      for (const doc of docs) store.put(`${doc.source_type}:${doc.source_id}`, doc.metadata);
      return { results: docs.map(doc => ({ source_id: doc.source_id, status: 'created' })) };
    },
    applyDriveRemovals: async () => { forgotten++; throw new Error('legacy deletion reached'); },
  };
  const readState = () => JSON.parse(readFileSync(join(home, '.brain-ingest-quickbooks_desktop.json'), 'utf8'));
  await assert.rejects(cmdIngestQuickBooksDesktop(m, path, {}, options), { code: 'SAFETY_REVIEW_REQUIRED' });
  assert.equal(requests.length, 1); assert.equal(requests[0].length, 9);
  assert.ok(store.calls.inventory > 0 && store.calls.preview > 0);
  assert.equal(store.calls.apply, 0); assert.equal(forgotten, 0);
  assert.ok(store.uids().includes(`quickbooks_desktop:${requests[0][0].source_id}`));
  assert.equal(binding.pending_removals.company_fingerprint, binding.fingerprint);
  assert.equal(binding.last_complete_snapshot_at, null);
  assert.equal(receipts.at(-1).status, 'error'); assert.equal(receipts.at(-1).docs_added, 9);
  assert.deepEqual(readState().ingest_removal_plan.targets, ['quickbooks_desktop:invoice:FF-999']);
  const approval = readState().ingest_removal_plan.providerApproval;
  assert.equal(Boolean(approval), large);
  // Aggregate consent on ordinary ingest is never authority to delete.
  await assert.rejects(cmdIngestQuickBooksDesktop(m, path, { 'approve-removals': binding.pending_removals.fingerprint }, options),
    { code: 'SAFETY_REVIEW_REQUIRED' });
  assert.equal(requests.length, 2); assert.equal(store.calls.apply, 0); assert.equal(forgotten, 0);
  const flags = { from: 'quickbooks-desktop', source: 'quickbooks_desktop',
    'apply-removals': readState().ingest_removal_plan.fingerprint,
    ...(approval ? { 'approve-removals': approval } : {}) };
  const beforeBridge = bridgeCalls; const beforeWrites = bindingWrites;
  // The public dispatcher takes the same exact apply path and keeps injection.
  const apply = value => brain.cmdIngest(path, { ...options, flags: value });
  await assert.rejects(apply({ ...flags, 'apply-removals': 'f'.repeat(64) }), { code: 'SAFETY_REVIEW_REQUIRED' });
  if (large) await assert.rejects(apply({ ...flags, 'approve-removals': undefined }), { code: 'SAFETY_REVIEW_REQUIRED' });
  const savedBinding = structuredClone(binding); const beforeReads = bindingReads;
  binding = { ...binding, fingerprint: 'e'.repeat(64),
    pending_removals: { ...binding.pending_removals, company_fingerprint: 'e'.repeat(64) } };
  await assert.rejects(apply(flags), { code: 'SAFETY_REVIEW_REQUIRED' });
  assert.ok(bindingReads > beforeReads, 'changed company check was reached under its lease');
  assert.equal(store.calls.apply, 0); binding = savedBinding;
  binding = { ...binding, last_complete_snapshot_at: SNAPSHOT };
  await assert.rejects(apply(flags), { code: 'SAFETY_REVIEW_REQUIRED' });
  assert.equal(store.calls.apply, 0); binding = savedBinding;
  loseLeaseOnPreview = true; const previews = store.calls.preview;
  await assert.rejects(apply(flags), { code: 'source_ingest_lock_lost' });
  assert.ok(store.calls.preview > previews, 'shared lease loss followed the authenticated preview');
  assert.equal(store.calls.apply, 0); bindingLeaseLost = false; loseLeaseOnPreview = false;
  // Green control applies only the saved physical target and reads it back.
  const applied = await apply(flags);
  assert.equal(applied.removed, 1); assert.equal(store.calls.apply, 1);
  assert.equal(store.uids().includes('quickbooks_desktop:invoice:FF-999'), false);
  assert.ok(store.uids().includes(`quickbooks_desktop:${requests[0][0].source_id}`));
  assert.equal(bridgeCalls, beforeBridge); assert.equal(bindingWrites, beforeWrites);
  assert.equal(binding.last_complete_snapshot_at, null);
  assert.equal(forgotten, 0); assert.equal(readState().ingest_removal_plan, undefined);
  const resumed = await cmdIngestQuickBooksDesktop(m, path, {}, options);
  assert.equal(resumed.tally.created, 9); assert.equal(resumed.removed, 0);
  assert.equal(resumed.code, 'QB_FRESHNESS_UNVERIFIED');
  assert.equal(binding.pending_removals, null); assert.equal(binding.last_complete_snapshot_at, null);
  assert.equal(resumed.walk_complete, false); assert.ok(Object.values(binding.previous_counts).some(n => n > 0));
  assert.equal(requests.length, 3); assert.ok(logs.every(line => !line.includes('Vendor One')));
  let clockReads = 0; let sends = 0;
  await assert.rejects(cmdIngestQuickBooksDesktop(m, path, {}, { ...options,
    readWorkerDate: async () => { clockReads++; return null; }, requestIngestBatch: async () => { sends++; } }),
    { code: 'QB_CLOCK_UNVERIFIED' });
  assert.equal(clockReads, 1); assert.equal(sends, 0);
  await assert.rejects(cmdIngestQuickBooksDesktop(m, path, {}, { ...options,
    requestIngestBatch: async () => { sends++; throw Object.assign(new Error('private provider detail'), { code: 'SAFETY_REVIEW_REQUIRED' }); } }),
    error => { assert.equal(error.code, 'QB_OPERATION_FAILED'); assert.doesNotMatch(error.message, /private provider detail/); return true; });
  assert.equal(sends, 1, 'non-review errors still reach the sanitized owner boundary');
});
