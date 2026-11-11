import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cmdDeploy, cmdBankProvider, splitStatements } from '../brain.mjs';
import { BANK_PROVIDER_STATE_SQL, BANK_PROVIDER_ESTABLISH_TRANSITION_SQL } from '../operations/bank-provider-command.mjs';

const binding = text => ({ name: 'BANK_FEED_PROVIDER', type: 'plain_text', text });
const response = result => new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { 'content-type': 'application/json' } });

async function fixture(t, { bindings = [], priorEnabled = false, apply = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'brain-first-bank-'));
  const manifestPath = join(directory, 'brain.manifest.json');
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/d1/', import.meta.url);
  for (const file of readdirSync(migrations).filter(x => /^\d{4}_.+\.sql$/.test(x)).sort()) {
    for (const sql of splitStatements(readFileSync(new URL(file, migrations), 'utf8'))) db.exec(sql);
  }
  const manifest = {
    manifest_version: 1, client: { slug: 'fixture', display_name: 'Fixture' }, brain: { version: '0.4.27', worker_name: 'fixture-brain', domain: 'fixture.example.invalid' },
    infrastructure: { cloudflare: { account_id: 'a'.repeat(32), d1_database_id: '11111111-2222-4333-8444-555555555555', storage: 'd1', vectorize_index: 'fixture' } },
    corpora: priorEnabled ? { bank_feed: { enabled: true, provider: 'plaid', environment: 'production' } } : {},
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const inspectBankState = async () => db.prepare(BANK_PROVIDER_STATE_SQL).get();
  const commandOptions = { inspectBankState, readRecoveryFence: () => null, withLifecycle: task => task({ assertOwned() {} }),
    establishTransition: async (_m, transition) => db.prepare(BANK_PROVIDER_ESTABLISH_TRANSITION_SQL).get(transition.transition_ref, new Date().toISOString()),
  };
  if (priorEnabled && apply) db.prepare("UPDATE bank_provider_runtime_state SET deployed_provider='plaid' WHERE id=1").run();
  let liveBindings = apply ? (priorEnabled ? [binding('plaid')] : []) : bindings;
  let puts = 0;
  const fetchBefore = globalThis.fetch;
  const tokenBefore = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'synthetic-fixture';
  globalThis.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    const method = options.method || 'GET';
    if (path.endsWith('/settings')) return response({ bindings: liveBindings });
    if (path.endsWith('/accounts')) return response([{ id: 'a'.repeat(32), name: 'Fixture' }]);
    if (path.endsWith('/fixture-brain') && method === 'PUT') {
      puts++;
      const metadata = JSON.parse(await options.body.get('metadata').text());
      liveBindings = metadata.bindings;
      assert.deepEqual(liveBindings.filter(x => x.name === 'BANK_FEED_PROVIDER'), [binding('simplefin')]);
      return response({});
    }
    if (path.endsWith('/secrets')) return response([{ name: 'BANK_FEED_WRAPPING_KEY_V2', type: 'secret_text' }]);
    if (path.endsWith('/subdomain')) return response({ enabled: true });
    if (path.endsWith('/schedules')) return response([{ cron: '* * * * *' }]);
    throw new Error('unexpected offline request: ' + method + ' ' + path);
  };
  t.after(() => {
    globalThis.fetch = fetchBefore;
    if (tokenBefore === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = tokenBefore;
    db.close(); rmSync(directory, { recursive: true, force: true });
  });
  const cliOptions = {
    commandOptions,
    d1Query: async (_a, _d, sql, params = []) => ({ results: db.prepare(sql).all(...params) }),
    withManifestControl: (_path, task) => task(), write() {},
  };
  const argv = [manifestPath, '--set', 'simplefin', '--enable', '--json'];
  if (apply) {
    const preview = await cmdBankProvider(argv, cliOptions);
    assert.equal(preview.status, 'ready');
    const applied = await cmdBankProvider([...argv, '--apply', '--approve', preview.plan_id], cliOptions);
    assert.equal(applied.status, 'applied');
    assert.ok(applied.backup_path);
    liveBindings = bindings;
  }
  return { db, directory, manifestPath, inspectBankState, commandOptions, get puts() { return puts; },
    preview: () => cmdBankProvider(argv, cliOptions), deploy: () => cmdDeploy(manifestPath, { nextSteps: false,
    d1Query: async (_a, _d, sql, params = []) => ({ results: db.prepare(sql).all(...params) }),
  }) };
}

test('first enable through real apply and real deploy uploads and clears the exact D1 fence', async t => {
  const f = await fixture(t);
  assert.equal((await f.preview()).status, 'transition_pending');
  await f.deploy();
  assert.equal(f.puts, 1);
  assert.equal((await f.inspectBankState()).deployed_provider, 'simplefin');
  assert.equal((await f.inspectBankState()).transition_ref, null);
  assert.equal((await f.preview()).status, 'unchanged');
});

test('one matching live binding deploys', async t => {
  const f = await fixture(t, { bindings: [binding('simplefin')] });
  await f.deploy(); assert.equal(f.puts, 1);
});
for (const [name, options, mutate] of [
  ['two bindings', { bindings: [binding('simplefin'), binding('simplefin')] }],
  ['different binding', { bindings: [binding('custom')] }],
  ['missing binding after feed already enabled', { priorEnabled: true }],
  ['mismatched fence', {}, f => f.db.prepare("UPDATE bank_provider_runtime_state SET transition_ref=? WHERE id=1").run('b'.repeat(64))],
]) test(name + ' refuses before upload', async t => {
  const f = await fixture(t, options); mutate?.(f);
  await assert.rejects(f.preview, /binding|fence|transition/i);
  await assert.rejects(f.deploy, /binding|fence|transition/i); assert.equal(f.puts, 0);
  assert.equal((await f.inspectBankState()).transition_target, 'simplefin');
});



test('a matching binding cannot hide a mismatched D1 fence', async t => {
  const f = await fixture(t, { bindings: [binding('simplefin')] });
  f.db.prepare("UPDATE bank_provider_runtime_state SET transition_ref=? WHERE id=1").run('b'.repeat(64));
  await assert.rejects(f.preview, /binding|fence|transition/i);
  await assert.rejects(f.deploy, /binding|fence|transition/i);
  assert.equal(f.puts, 0);
});

for (const [name, options, ready] of [
  ['never-enabled feed with no binding', { apply: false }, true],
  ['already-enabled feed with no binding', { apply: false, priorEnabled: true }, false],
  ['duplicate binding', { apply: false, bindings: [binding('simplefin'), binding('simplefin')] }, false],
  ['unfenced conflicting SimpleFIN binding', { apply: false, bindings: [binding('simplefin')] }, false],
]) test('initial preview: ' + name, async t => {
  const f = await fixture(t, options);
  if (ready) assert.equal((await f.preview()).status, 'ready');
  else await assert.rejects(f.preview, /binding|fence|transition/i);
  assert.equal(f.puts, 0);
  assert.equal((await f.inspectBankState()).transition_ref, null);
});

test('preview refuses an unfenced live binding that disagrees with the enabled manifest', async t => {
  const f = await fixture(t, { apply: false, priorEnabled: true, bindings: [binding('plaid')] });
  f.db.prepare("UPDATE bank_provider_runtime_state SET deployed_provider='plaid' WHERE id=1").run();
  const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
  manifest.corpora.bank_feed.provider = 'simplefin';
  writeFileSync(f.manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.preview, /binding|fence|transition/i);
  assert.equal(f.puts, 0);
});

test('an exactly fenced existing Plaid provider can still switch to SimpleFIN', async t => {
  const f = await fixture(t, { priorEnabled: true, bindings: [binding('plaid')] });
  assert.equal((await f.preview()).status, 'transition_pending');
  await f.deploy();
  assert.equal(f.puts, 1);
  assert.equal((await f.inspectBankState()).transition_ref, null);
});

test('a missing fence refuses both preview and deploy', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE bank_provider_runtime_state SET transition_target=NULL, transition_ref=NULL, transition_started_at=NULL WHERE id=1").run();
  await assert.rejects(f.preview, /binding|fence|transition/i);
  await assert.rejects(f.deploy, /binding|fence|transition/i);
  assert.equal(f.puts, 0);
});
