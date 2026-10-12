import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { uploadFolderEntriesOf, feedPathsOverlap } from '../operations/feed-folders.mjs';
import { planDailyRefresh } from '../operations/daily-refresh-plan.mjs';
import { resolveSourceKind, isSourceKindConflict } from '../worker/src/lib/source-receipt.js';
import { fixture, NOW } from '../worker/test/ledger-review-fixture.mjs';

// Port of the independent review probe, using this checkout's function bodies.
// CLI initialization and credential helpers are not imported. Readiness and
// transport boundaries are injected; registration uses the real Worker handler.
const cli = readFileSync(new URL('../brain.mjs', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
function fn(source, name) {
  const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(match, `pinned function exists: ${name}`);
  const end = source.indexOf('\n}', match.index) + 2;
  assert.ok(end > match.index);
  return source.slice(match.index, end).replace(/^export /, '');
}
function constant(source, name) {
  const match = source.match(new RegExp(`(?:export )?const ${name} =\\s*[\\s\\S]+?;(?=\\r?\\n|$)`));
  assert.ok(match, `pinned constant exists: ${name}`);
  return match[0].replace(/^export /, '');
}
const never = () => { throw new Error('Uninjected external operation'); };
const context = vm.createContext({
  Date: class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } },
  uploadFolderEntriesOf, feedPathsOverlap,
  cmdIngestCalendar: never, cmdIngestImessage: never, cmdIngestWhatsapp: never,
  cmdIngestLocal: never, cmdIngestRemote: never, cmdIngestIphoneBackup: never, cmdIngestProvider: never,
  defaultLoadProbes: () => ({}), die: never, process: { platform: 'win32' },
  resolveSourceKind, isSourceKindConflict, D1: 'd1', backendOf: env => env.STORAGE,
  jsonResponse: (body, status = 200) => Response.json(body, { status }),
});
vm.runInContext([
  constant(cli, 'PROVIDER_CONNECTOR_IDS'), constant(cli, 'PROVIDER_LOAD_METADATA'),
  constant(cli, 'PROVIDER_LOAD_PROOF_NOTE'), constant(cli, 'DAILY_PLAN_KEY_WORKER_KIND'),
  constant(worker, 'SOURCE_KINDS'),
  ...['uploadFoldersOf', 'uploadFeedTopologyConflict', 'normalizeLoadKey', 'loadSourceRegistry', 'planLoad', 'syncDailySourceExpectations'].map(name => fn(cli, name)),
  fn(worker, 'handleSourceExpectation'),
].join('\n'), context);

async function registration(t, key) {
  const f = fixture(t);
  const home = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'daily-kind-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const manifestPath = resolve(home, `synthetic-${key}.json`);
  const adminKeyFile = resolve(home, `fixture-${key}.key`);
  writeFileSync(adminKeyFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const m = { client: { slug: 'owner', timezone: 'UTC' }, corpora: { [key]: { enabled: true, path: resolve(home, 'documents'), folders: [{ path: resolve(home, 'documents'), source: 'fixture-documents' }] } },
    operations: { daily_refresh: { enabled: true, timezone: 'UTC' } }, admin_key_file: adminKeyFile };
  writeFileSync(manifestPath, JSON.stringify(m));
  let probes = 0;
  const plan = await planDailyRefresh({ m, manifestPath, platform: 'win32', principal: 'fixture-principal', localTimezone: 'UTC', existingSchedulerOwners: [],
    planLoadFn: context.planLoad, planLoadOptions: { probes: { [key]: async () => { probes++; return { connected: true }; } } } });
  assert.equal(probes, 1, 'real load planner reached injected readiness decision');
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].class, 'machine-pull');
  assert.equal(plan.sources[0].owner, 'daily-task');
  assert.equal(plan.sources[0].status, 'ready');
  const posts = [];
  await context.syncDailySourceExpectations(m, manifestPath, plan, 86400, {
    resolveAdminKey: () => readFileSync(adminKeyFile, 'utf8'), resolveBaseUrl: async () => 'https://fixture.invalid',
    launchctl: never,
    postSourceExpectation: async (_base, _key, body) => {
      const response = await context.handleSourceExpectation(f.env, { json: async () => body });
      posts.push({ kind: body.kind, source: body.source, status: response.status, body: await response.json() });
    },
  });
  assert.equal(posts.length, 1, 'registration decision reached');
  assert.equal(f.first('SELECT kind FROM sources WHERE name=?', posts[0].source)?.kind, posts[0].kind,
    'Worker readback agrees with the posted kind');
  return posts[0];
}

test('control: Drive plan registers the Worker drive kind', async t => {
  const result = await registration(t, 'google_drive');
  assert.equal(result.kind, 'drive');
  assert.equal(result.status, 200);
});

for (const [key, kind] of [['local_folder', 'upload'], ['quickbooks_desktop', 'quickbooks']]) test(`F4 daily registration: ${key} needs its Worker kind`, async t => {
  assert.equal((await registration(t, 'google_drive')).status, 200, 'green mapping control');
  const result = await registration(t, key);
  assert.equal(result.kind, kind);
  assert.equal(result.status, 200, `${key} sent ${result.kind}: ${JSON.stringify(result.body)}`);
});

const dailyKeys = Object.entries(context.loadSourceRegistry()).filter(([, entry]) => entry.dailyClass === 'machine-pull').map(([key]) => key);
assert.ok(dailyKeys.length > 0, 'registry enumeration is nonempty');
for (const key of dailyKeys) test(`F4 every daily-eligible registry entry registers an actual Worker kind: ${key}`, async t => {
  const result = await registration(t, key);
  assert.ok(vm.runInContext('SOURCE_KINDS', context).has(result.kind), `${key}: unsupported posted kind ${result.kind}`);
  assert.equal(result.status, 200);
});
