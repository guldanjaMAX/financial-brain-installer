import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdConnect, cmdConnectProvider } from '../brain.mjs';

test('CLI edition and setup flags refuse ambiguity before edition probing, with an explicit Online control', async () => {
  let probes = 0, connects = 0;
  const options = { probeQuickBooksEdition: async () => { probes++; return 'online'; },
    connectOnline: async () => { connects++; return { edition: 'online' }; } };
  const run = (args) => cmdConnect('quickbooks', { ...options,
    argv: ['node', 'brain.mjs', 'connect', 'quickbooks', 'synthetic.manifest.json', ...args] });
  await assert.rejects(run(['--edition', 'unknown']), /must be online or desktop/);
  await assert.rejects(run(['--owner-app-setup', 'true']), /does not take a value/);
  await assert.rejects(run(['--owner-app-setup', '--edition', 'desktop']), /for QuickBooks Online/);
  assert.equal(probes, 0); assert.equal(connects, 0);
  assert.equal((await run(['--edition', 'online'])).edition, 'online');
  assert.equal(connects, 1);
});

test('CLI production dispatch, setup and explicit reconnect retain their separate decisions', async () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'owner-cli-')));
  try {
    const path = join(folder, 'synthetic.manifest.json');
    const m = { manifest_version: 1, client: { slug: 'fixture', display_name: 'Owner', timezone: 'UTC' },
      brain: { version: '0.4.12', domain: 'books-owner.invalid' },
      infrastructure: { cloudflare: { account_id: 'fixture-account', storage: 'd1' } },
      corpora: { quickbooks: { enabled: true, environment: 'production' } } };
    writeFileSync(path, JSON.stringify(m));
    let connects = 0, setups = 0, fresh = false;
    const options = { quiet: true, storage: { backend: 'file', platform: 'linux', home: folder },
      providerRecordLease: { held: true, assertOwned() {} }, ownerSetup: {
        connectQuickBooksOwnerApp: async (_m, _path, opts) => { connects++; fresh = opts.freshConsent; return { connected: true }; },
        setupQuickBooksOwnerApp: async () => { setups++; return { connected: false }; },
      } };
    await assert.rejects(cmdConnectProvider('quickbooks', path, { reconnect: 'true' }, options), /does not take a value/);
    assert.equal(connects, 0);
    assert.equal((await cmdConnectProvider('quickbooks', path, { reconnect: true }, options)).connected, true);
    assert.equal(connects, 1); assert.equal(fresh, true);
    await cmdConnectProvider('quickbooks', path, { 'owner-app-setup': true }, options);
    assert.equal(setups, 1);
    m.corpora.quickbooks.environment = 'sandbox'; writeFileSync(path, JSON.stringify(m));
    await assert.rejects(cmdConnectProvider('quickbooks', path, { 'owner-app-setup': true }, options), /requires the production environment/);
    assert.equal(setups, 1);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
