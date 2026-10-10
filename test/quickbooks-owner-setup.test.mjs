import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdConnectProvider } from '../brain.mjs';

const manifest = {
  manifest_version: 1,
  client: { slug: 'fixture', display_name: 'Owner', timezone: 'UTC' },
  brain: { version: '0.4.12', domain: 'books-owner.invalid', worker_name: 'fixture-brain' },
  infrastructure: { cloudflare: { account_id: 'fixture-account', storage: 'd1' } },
  corpora: { quickbooks: { enabled: true, environment: 'production', source: 'quickbooks' } },
};

test('P01 production dispatch reaches owner-app preflight; complete control starts authorization once', async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'owner-setup-')));
  try {
    const path = join(dir, 'fixture.manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    let preflights = 0;
    let authorizations = 0;
    let ready = false;
    const options = {
      quiet: true,
      providerRecordLease: { held: true, assertOwned() {} },
      storage: { backend: 'file', platform: 'linux', home: dir },
      ownerSetup: {
        connectQuickBooksOwnerApp: async () => {
          preflights++;
          if (!ready) throw Object.assign(new Error('Owner app is required'), { code: 'quickbooks_owner_app_required' });
          authorizations++;
          return { connected: true, provider: 'quickbooks', import_pending: true };
        },
      },
    };
    await assert.rejects(cmdConnectProvider('quickbooks', path, {}, options), { code: 'quickbooks_owner_app_required' });
    assert.equal(preflights, 1);
    assert.equal(authorizations, 0);
    ready = true;
    assert.equal((await cmdConnectProvider('quickbooks', path, {}, options)).connected, true);
    assert.equal(preflights, 2);
    assert.equal(authorizations, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const binding = Object.freeze({
  schema_version: 1, installation_id: 'installation-fixture-000000000001', app_id: 'owner-private-app',
  brain_origin: 'https://books-owner.invalid', redirect_uri: 'https://books-owner.invalid/api/oauth/quickbooks/callback',
  environment: 'production', source: 'quickbooks',
  company_fingerprint: 'b'.repeat(64),
});

async function fixture(task) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'owner-custody-')));
  const storage = { backend: 'file', platform: 'linux', home: dir };
  try { await task(storage); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('P02 staged keys share protected custody and are never a connected grant; foreign and legacy custody cannot be adopted', async () => {
  const oauth = await import('../connectors/provider-oauth.mjs');
  const { saveTokens } = await import('../connectors/google-auth.mjs');
  await fixture(async (storage) => {
    const pair = { clientId: 'synthetic-client', clientSecret: 'synthetic-private-canary' };
    const receipt = await oauth.stageQuickBooksOwnerApp(binding, pair, storage);
    assert.equal(receipt.stage, 'keys_staged');
    assert.equal(receipt.connected, false);
    assert.equal(JSON.stringify(receipt).includes(pair.clientSecret), false);
    assert.equal(oauth.loadProviderCredentials('quickbooks', storage), null);
    assert.equal((await oauth.quickBooksOwnerAppStatus(binding, storage)).stage, 'keys_staged');
    for (const change of [{ installation_id: 'another-installation-00000000001' }, { app_id: 'other-app' }, { environment: 'sandbox' }]) {
      await assert.rejects(oauth.stageQuickBooksOwnerApp({ ...binding, ...change }, pair, storage));
      assert.equal((await oauth.quickBooksOwnerAppStatus(binding, storage)).stage, 'keys_staged');
    }
    saveTokens({ connection: { client_id: 'legacy-client', refresh_token: 'synthetic-legacy' } }, oauth.providerCredentialOptions('quickbooks', storage));
    await assert.rejects(oauth.stageQuickBooksOwnerApp(binding, pair, storage), { code: 'quickbooks_owner_binding_conflict' });
    assert.equal(oauth.loadProviderCredentials('quickbooks', storage).client_id, 'legacy-client');
  });
});

test('P02 stage preserves the current grant and P07 one company survives reconnect under a new source name', async () => {
  const oauth = await import('../connectors/provider-oauth.mjs');
  const { quickBooksCompanyFingerprint } = await import('../connectors/quickbooks-online.mjs');
  const bound = { ...binding, company_fingerprint: quickBooksCompanyFingerprint('company-one') };
  await fixture(async (storage) => {
    let exchangeCalls = 0;
    const options = {
      storage, now: () => Date.parse('2026-10-10T12:00:00Z'),
      receiveAuthorization: async () => ({ authorizationCode: 'synthetic-code-one', realmId: 'company-one' }),
      fetchImpl: async () => { exchangeCalls++; return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })); },
    };
    await oauth.stageQuickBooksOwnerApp(bound, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }, storage);
    await oauth.authorizeQuickBooksOwnerApp(bound, options);
    assert.equal(exchangeCalls, 1);
    const prior = oauth.loadProviderCredentials('quickbooks', storage);
    assert.ok(prior.quickbooks_binding.sources.quickbooks);
    await oauth.stageQuickBooksOwnerApp(bound, { clientId: 'synthetic-client', clientSecret: 'synthetic-new-secret' }, storage);
    assert.deepEqual(oauth.loadProviderCredentials('quickbooks', storage), prior);
    await assert.rejects(oauth.authorizeQuickBooksOwnerApp(bound, { ...options,
      receiveAuthorization: async () => ({ authorizationCode: 'synthetic-code-two', realmId: 'company-two' }),
    }), { code: 'quickbooks_company_binding_mismatch' });
    assert.equal(exchangeCalls, 1);
    assert.deepEqual(oauth.loadProviderCredentials('quickbooks', storage), prior);
    await assert.rejects(oauth.stageQuickBooksOwnerApp({ ...bound, source: 'other_source', company_fingerprint: quickBooksCompanyFingerprint('company-two') }, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }, storage), { code: 'quickbooks_owner_binding_conflict' });
    await oauth.authorizeQuickBooksOwnerApp(bound, { ...options,
      receiveAuthorization: async () => ({ authorizationCode: 'synthetic-code-three', realmId: 'company-one' }),
    });
    assert.equal(exchangeCalls, 2);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, storage)).connected, true);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, storage)).stage, 'connected');
  });
});

test('P02 opaque transfer refuses unpaired selection and observation exposure before any store mutation', async () => {
  const { createQuickBooksOwnerTransfer } = await import('../operations/quickbooks-owner-transfer.mjs');
  const now = Date.parse('2026-10-10T12:00:00Z');
  let checked = 0, selected = 0, written = 0, suppressed = 0, resumed = 0;
  let allowObservationBoundary = true;
  const helper = createQuickBooksOwnerTransfer({
    now: () => now,
    verifyCompanion: async () => { checked++; return true; },
    suppressObservation: async () => { suppressed++; return allowObservationBoundary; },
    capturePair: async () => { selected++; return { clientId: 'synthetic-client', clientSecret: 'transfer-canary' }; },
    closeCredentialView: async () => true,
    resumeObservation: async () => { resumed++; },
    stage: async () => { written++; return { stage: 'keys_staged', connected: false }; },
  });
  const operation = { operation_id: 'operation-fixture-00000000000001', binding, expires_at: now + 60_000 };
  const selection = { origin: 'https://developer.intuit.com', app_id: binding.app_id, environment: 'production', redirect_uri: binding.redirect_uri };
  for (const change of [{ origin: 'https://other.invalid' }, { app_id: 'other' }, { environment: 'sandbox' }, { redirect_uri: binding.redirect_uri + '/' }]) {
    await assert.rejects(helper.transfer(operation, { ...selection, ...change }), { code: 'quickbooks_portal_binding_mismatch' });
  }
  assert.equal(checked, 4);
  assert.equal(selected, 0);
  allowObservationBoundary = false;
  await assert.rejects(helper.transfer(operation, selection), { code: 'quickbooks_observation_not_suppressed' });
  assert.equal(suppressed, 1);
  assert.equal(written, 0);
  allowObservationBoundary = true;
  const receipt = await helper.transfer(operation, selection);
  assert.deepEqual(receipt, { stage: 'keys_staged', connected: false });
  assert.equal(selected, 1); assert.equal(written, 1); assert.equal(resumed, 1);
  assert.equal(JSON.stringify(receipt).includes('transfer-canary'), false);
  await assert.rejects(helper.transfer(operation, selection), { code: 'quickbooks_setup_operation_replayed' });
  assert.equal(written, 1);
});

async function productionFixture(task) {
  const oauth = await import('../connectors/provider-oauth.mjs');
  const { quickBooksCompanyFingerprint } = await import('../connectors/quickbooks-online.mjs');
  const { encryptQuickBooksCallback, sha256Hex } = await import('../worker/src/lib/quickbooks-callback-crypto.js');
  const now = Date.parse('2026-10-10T12:00:00Z');
  const bound = { ...binding, company_fingerprint: quickBooksCompanyFingerprint('company-one') };
  await fixture(async (storage) => {
    await oauth.stageQuickBooksOwnerApp(bound, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }, storage);
    const m = { ...manifest, corpora: { quickbooks: { ...manifest.corpora.quickbooks, owner_app: {
      installation_id: bound.installation_id, app_id: bound.app_id, company_fingerprint: bound.company_fingerprint,
      redirect_uri: bound.redirect_uri,
    } } } };
    let intent, expected, envelope;
    let authorizationCode = 'synthetic-code';
    const calls = { ready: 0, start: 0, open: 0, status: 0, claim: 0, exchange: 0, finalize: 0, redirects: [] };
    const options = {
      quiet: true, storage, now: () => now, sleep: async () => {},
      companion: { assertReady: async () => { calls.ready++; } },
      openImpl: async (value) => { calls.open++; const url = new URL(value); assert.equal(url.searchParams.get('client_id'), 'synthetic-client'); calls.redirects.push(url.searchParams.get('redirect_uri')); return true; },
      callbackTransport: async (action, payload) => {
        calls[action]++;
        if (action === 'start') {
          intent = payload;
          expected = { intent_fingerprint: await sha256Hex(payload.intent_id), source: bound.source,
            environment: 'production', client_id_fingerprint: payload.client_id_fingerprint,
            expected_company_fingerprint: bound.company_fingerprint, created_at: now, expires_at: now + 600_000 };
          envelope = await encryptQuickBooksCallback({ recipientPublicJwk: payload.recipient_public_jwk, binding: expected,
            authorizationCode, realmId: 'company-one' });
          return { ...expected, status: 'pending', callback_path: '/api/oauth/quickbooks/callback' };
        }
        assert.equal(payload.intent_id, intent.intent_id); assert.equal(payload.claim_secret, intent.claim_secret);
        if (action === 'status') return { status: 'received' };
        if (action === 'claim') return { status: 'received', envelope, intent_fingerprint: expected.intent_fingerprint,
          callback_fingerprint: await sha256Hex(JSON.stringify(envelope)), expires_at: expected.expires_at };
        if (action === 'finalize') return { status: 'finalized', company_fingerprint: payload.company_fingerprint,
          credential_fingerprint: payload.credential_fingerprint, intent_fingerprint: expected.intent_fingerprint };
      },
      fetchImpl: async (_url, request) => {
        calls.exchange++; assert.ok(request.headers.Authorization === `Basic ${Buffer.from('synthetic-client:synthetic-secret').toString('base64')}`); calls.redirects.push(new URLSearchParams(request.body).get('redirect_uri'));
        return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 }));
      },
    };
    await task({ m, options, calls, bound, oauth, setAuthorizationCode: (value) => { authorizationCode = value; } });
  });
}

test('P03/P04 real local adapter uses one redirect and one exchange before exact finalization', async () => {
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, calls, bound }) => {
    const result = await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options);
    assert.equal(result.connected, true); assert.equal(result.import_pending, true);
    assert.equal(calls.start, 1); assert.equal(calls.exchange, 1); assert.equal(calls.finalize, 1);
    assert.deepEqual(calls.redirects, [bound.redirect_uri, bound.redirect_uri]);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  });
});

test('P04 response loss leaves an exchange fence and never replays a consumed callback', async () => {
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, calls, bound, oauth }) => {
    options.fetchImpl = async () => { calls.exchange++; throw new Error('synthetic-private-provider-body'); };
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options), { code: 'quickbooks_exchange_outcome_unknown' });
    assert.equal(calls.start, 1); assert.equal(calls.exchange, 1); assert.equal(calls.finalize, 0);
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options), { code: 'quickbooks_exchange_replay' });
    assert.equal(calls.start, 2); assert.equal(calls.exchange, 1);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, options.storage)).stage, 'reconnect');
  });
});

test('P03 redirect validation rejects all drift without normalizing either side', async () => {
  const { validateQuickBooksOwnerBinding, quickBooksProductionRedirect } = await import('../connectors/quickbooks-owner-binding.mjs');
  const expected = quickBooksProductionRedirect(binding.brain_origin);
  let compared = 0;
  for (const redirect of [expected + '/', expected.replace('https:', 'http:'), expected.replace('books-owner', 'alias'),
    expected.replace('.invalid/', '.invalid:443/'), expected.replace('/callback', '/Callback'),
    expected.replace('/callback', '/%63allback'), expected + '?x=1', ' ' + expected]) {
    compared++;
    assert.throws(() => validateQuickBooksOwnerBinding({ ...binding, redirect_uri: redirect }), { code: 'quickbooks_redirect_mismatch' });
  }
  assert.equal(compared, 8);
  assert.equal(validateQuickBooksOwnerBinding(binding).redirect_uri, expected);
  for (const origin of [binding.brain_origin + '/', binding.brain_origin + ':443', 'https://Books-owner.invalid', ' https://books-owner.invalid']) {
    assert.throws(() => quickBooksProductionRedirect(origin), { code: 'quickbooks_origin_invalid' });
  }
});

test('P07 explicit Online and owner-app setup bypass Desktop detection; explicit Desktop keeps its path', async () => {
  const { cmdConnect } = await import('../brain.mjs');
  let probes = 0, online = 0, desktop = 0;
  const options = {
    probeQuickBooksEdition: async () => { probes++; return 'windows-desktop'; },
    connectOnline: async () => { online++; return { edition: 'online' }; },
    connectDesktop: async () => { desktop++; return { edition: 'desktop' }; },
  };
  assert.equal((await cmdConnect('quickbooks', { ...options, argv: ['node', 'brain.mjs', 'connect', 'quickbooks', 'synthetic.manifest.json', '--edition', 'online'] })).edition, 'online');
  assert.equal(online, 1); assert.equal(probes, 0);
  assert.equal((await cmdConnect('quickbooks', { ...options, argv: ['node', 'brain.mjs', 'connect', 'quickbooks', 'synthetic.manifest.json', '--owner-app-setup'] })).edition, 'online');
  assert.equal(online, 2); assert.equal(probes, 0);
  assert.equal((await cmdConnect('quickbooks', { ...options, argv: ['node', 'brain.mjs', 'connect', 'quickbooks', 'synthetic.manifest.json', '--edition', 'desktop'] })).edition, 'desktop');
  assert.equal(desktop, 1);
});

test('P06 refresh retains staged app keys and refuses consumed-token response loss with a reached refresh control', async () => {
  await productionFixture(async ({ m, options, calls, bound, oauth }) => {
    const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
    await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options);
    await oauth.stageQuickBooksOwnerApp(bound, { clientId: 'synthetic-client', clientSecret: 'new-stage-canary' }, options.storage);
    let refreshed = 0;
    const renew = { storage: options.storage, now: Date.parse('2026-10-10T14:00:00Z'),
      quickBooksBinding: { source: bound.source, environment: 'production' },
      fetchImpl: async () => { refreshed++; return new Response(JSON.stringify({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', expires_in: 3600 })); },
    };
    await oauth.providerAccessToken('quickbooks', renew);
    assert.equal(refreshed, 1);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, options.storage)).stage, 'keys_staged');
    renew.now += 7_200_000;
    renew.fetchImpl = async () => { refreshed++; throw new Error('synthetic-response-loss'); };
    await assert.rejects(oauth.providerAccessToken('quickbooks', renew));
    assert.equal(refreshed, 2);
    await assert.rejects(oauth.providerAccessToken('quickbooks', renew), { code: 'refresh_outcome_unknown' });
    assert.equal(refreshed, 2);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, options.storage)).stage, 'reconnect');
    assert.equal(calls.exchange, 1);
  });
});

test('P08 confirmed disconnect pauses reads, clears staged pair and preserves imported records and reservation', async () => {
  const { connectQuickBooksOwnerApp, disconnectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, bound, oauth }) => {
    await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options);
    await oauth.stageQuickBooksOwnerApp(bound, { clientId: 'synthetic-client', clientSecret: 'new-stage-canary' }, options.storage);
    const documents = ['synthetic-imported-document'];
    let paused = 0, revoked = 0, removed = 0;
    let revokeSucceeds = false;
    const disconnect = { ...options,
      companion: { ...options.companion, pauseAndVerify: async () => { paused++; return true; }, verifyPaused: async () => true },
      fetchImpl: async () => { revoked++; if (!revokeSucceeds) throw new Error('synthetic-revoke-response-loss'); return new Response('{}'); },
      removeDocuments: () => { removed++; documents.length = 0; },
    };
    const preview = await disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { plan: true }, disconnect);
    assert.equal(preview.requires_confirmation, true); assert.equal(paused, 0);
    await assert.rejects(disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', {}, disconnect), { code: 'quickbooks_disconnect_confirmation_required' });
    assert.equal(revoked, 0);
    await assert.rejects(disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, disconnect), { code: 'quickbooks_revocation_uncertain' });
    assert.equal(paused, 1); assert.equal(revoked, 1);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, options.storage)).stage, 'reconnect');
    revokeSucceeds = true;
    const receipt = await disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, disconnect);
    assert.equal(receipt.remote_revoked, true); assert.equal(paused, 2); assert.equal(revoked, 2);
    assert.equal(removed, 0); assert.equal(documents.length, 1);
    assert.equal(oauth.loadProviderCredentials('quickbooks', options.storage), null);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, options.storage)).stage, 'owner_action');
    assert.ok(oauth.loadQuickBooksSourceRegistry(options.storage).sources.quickbooks);
  });
});

test('P09 sandbox invalid host reaches validation; valid control retains exact IPv4-bound localhost callback', async () => {
  const oauth = await import('../connectors/provider-oauth.mjs');
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'owner-sandbox-')));
  try {
    const path = join(dir, 'synthetic.manifest.json');
    let decisions = 0, loads = 0, started = 0, seen;
    const options = { quiet: true, providerRecordLease: { held: true, assertOwned() {} },
      credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
      oauth: { ...oauth,
        providerOAuthConfig: (p) => { decisions++; return oauth.providerOAuthConfig(p); },
        loadQuickBooksCredentials: async () => { loads++; return null; },
        authorizeProvider: async (_p, options) => { started++; seen = options; return options.prepareConnection({ provider_metadata: { realm_id: 'company-one' } }); },
        providerCredentialDescription: () => 'synthetic local store',
      },
    };
    const m = { ...manifest, corpora: { quickbooks: { enabled: true, source: 'quickbooks', environment: 'sandbox', redirect_host: '0.0.0.0' } } };
    writeFileSync(path, JSON.stringify(m));
    await assert.rejects(cmdConnectProvider('quickbooks', path, {}, options), { code: 'quickbooks_redirect_host_invalid' });
    assert.equal(decisions, 1); assert.equal(loads, 0); assert.equal(started, 0);
    m.corpora.quickbooks.redirect_host = 'localhost'; writeFileSync(path, JSON.stringify(m));
    assert.equal((await cmdConnectProvider('quickbooks', path, {}, options)).connected, true);
    assert.equal(started, 1); assert.equal(seen.redirectUri, 'http://localhost:47812/');
    assert.equal(oauth.PROVIDER_LOOPBACK_BIND_ADDRESS, '127.0.0.1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P04 lost finalize acknowledgement resumes protected finalization without another authorization or exchange', async () => {
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, calls, bound, oauth }) => {
    const transport = options.callbackTransport;
    let lose = true;
    options.callbackTransport = async (action, payload) => {
      const result = await transport(action, payload);
      if (action === 'finalize' && lose) throw new Error('synthetic-lost-acknowledgement');
      return result;
    };
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options), { code: 'quickbooks_finalization_outcome_unknown' });
    assert.equal(calls.exchange, 1); assert.equal(calls.finalize, 1);
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, options.storage)).connected, false);
    lose = false;
    assert.equal((await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options)).connected, true);
    assert.equal(calls.start, 1); assert.equal(calls.exchange, 1); assert.equal(calls.finalize, 2);
  });
});

test('production guarded transport decisions have valid pending intents and a complete control', async () => {
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  for (const [action, patch, code] of [
    ['start', { status: 'finalized' }, 'quickbooks_intent_unverified'],
    ['status', { status: 'expired' }, 'quickbooks_callback_not_completed'],
    ['claim', { callback_fingerprint: 'a'.repeat(64) }, 'quickbooks_claim_unverified'],
    ['finalize', { company_fingerprint: 'a'.repeat(64) }, 'quickbooks_finalization_unverified'],
  ]) await productionFixture(async ({ m, options, calls }) => {
    const base = options.callbackTransport;
    options.callbackTransport = async (selected, payload) => {
      const result = await base(selected, payload);
      return selected === action ? { ...result, ...patch } : result;
    };
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options), { code });
    assert.equal(calls[action], 1);
    assert.equal(calls.exchange, action === 'finalize' ? 1 : 0);
  });
  await productionFixture(async ({ m, options, calls }) => {
    assert.equal((await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options)).connected, true);
    assert.equal(calls.finalize, 1);
  });
});

test('local pairing and browser prerequisites refuse before consent and redact native diagnostics', async () => {
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, calls }) => {
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options, companion: null }), { code: 'quickbooks_companion_required' });
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options, callbackTransport: null }), { code: 'quickbooks_production_callback_unavailable' });
    assert.equal(calls.start, 0);
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options, openImpl: async () => false }), { code: 'quickbooks_browser_unavailable' });
    assert.equal(calls.start, 1); assert.equal(calls.exchange, 0);
    assert.equal((await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options)).connected, true);
    assert.equal(calls.exchange, 1);
  });
});

test('binding inputs are exact and malformed pairs cannot enter the store', async () => {
  const { validateQuickBooksOwnerBinding } = await import('../connectors/quickbooks-owner-binding.mjs');
  const oauth = await import('../connectors/provider-oauth.mjs');
  for (const change of [{ schema_version: 2 }, { environment: 'sandbox' }, { installation_id: 'short' }, { app_id: ' bad' },
    { source: 'UPPER' }, { company_fingerprint: 'not-a-fingerprint' }]) {
    assert.throws(() => validateQuickBooksOwnerBinding({ ...binding, ...change }), { code: 'quickbooks_owner_binding_invalid' });
  }
  assert.equal(validateQuickBooksOwnerBinding(binding).app_id, binding.app_id);
  await fixture(async (storage) => {
    await assert.rejects(oauth.stageQuickBooksOwnerApp(binding, { clientId: 'fixture', clientSecret: '' }, storage), { code: 'quickbooks_owner_pair_invalid' });
    assert.equal((await oauth.quickBooksOwnerAppStatus(binding, storage)).stage, 'owner_action');
    await assert.rejects(oauth.authorizeQuickBooksOwnerApp(binding, { storage, receiveAuthorization: async () => { throw new Error('must not start'); } }), { code: 'quickbooks_owner_app_required' });
    assert.equal((await oauth.stageQuickBooksOwnerApp(binding, { clientId: 'fixture', clientSecret: 'synthetic-secret' }, storage)).stage, 'keys_staged');
  });
});

test('transfer lifecycle refuses unverified pairing, expiry, unsafe observation recovery and private helper errors', async () => {
  const { createQuickBooksOwnerTransfer } = await import('../operations/quickbooks-owner-transfer.mjs');
  const now = Date.parse('2026-10-10T12:00:00Z');
  const selection = { origin: 'https://developer.intuit.com', app_id: binding.app_id, environment: 'production', redirect_uri: binding.redirect_uri };
  let checks = 0, reads = 0, writes = 0;
  const deps = {
    now: () => now, verifyCompanion: async () => { checks++; return true; },
    suppressObservation: async () => true, capturePair: async () => { reads++; return { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }; },
    closeCredentialView: async () => true, resumeObservation: async () => {}, stage: async () => { writes++; },
  };
  const operation = { operation_id: 'operation-fixture-00000000000001', binding, expires_at: now + 60_000 };
  await assert.rejects(createQuickBooksOwnerTransfer(deps).transfer({ ...operation, expires_at: now - 1 }, selection), { code: 'quickbooks_setup_operation_expired' });
  assert.equal(checks, 0);
  await assert.rejects(createQuickBooksOwnerTransfer({ ...deps, verifyCompanion: async () => { checks++; return false; } }).transfer(operation, selection), { code: 'quickbooks_companion_required' });
  assert.equal(checks, 1); assert.equal(reads, 0);
  await assert.rejects(createQuickBooksOwnerTransfer({ ...deps, closeCredentialView: async () => false }).transfer(operation, selection), { code: 'quickbooks_credential_view_unverified' });
  assert.equal(reads, 1); assert.equal(writes, 1);
  await assert.rejects(createQuickBooksOwnerTransfer({ ...deps, resumeObservation: async () => { throw new Error('native-canary'); } }).transfer(operation, selection), { code: 'quickbooks_observation_resume_failed' });
  await assert.rejects(createQuickBooksOwnerTransfer({ ...deps, capturePair: async () => { reads++; throw new Error('native-canary'); } }).transfer(operation, selection), (error) => {
    assert.equal(error.code, 'quickbooks_transfer_unverified'); assert.equal(error.message.includes('native-canary'), false); return true;
  });
  assert.equal(reads, 3); assert.equal(writes, 2);
  assert.equal((await createQuickBooksOwnerTransfer(deps).transfer(operation, selection)).stage, 'keys_staged');
  assert.equal(writes, 3);
});

test('owner setup command refuses missing transfer and verifies the returned staged receipt', async () => {
  const { setupQuickBooksOwnerApp, quickBooksOwnerBindingFromManifest } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, calls }) => {
    let prepares = 0;
    const flags = { 'owner-app-setup': true };
    await assert.rejects(setupQuickBooksOwnerApp(m, 'synthetic.manifest.json', {}, options), { code: 'quickbooks_setup_flag_invalid' });
    await assert.rejects(setupQuickBooksOwnerApp(m, 'synthetic.manifest.json', flags, options), { code: 'quickbooks_transfer_unavailable' });
    assert.equal(calls.ready, 1);
    const companion = { ...options.companion, prepare: async () => { prepares++; return { stage: 'connected', connected: true }; } };
    await assert.rejects(setupQuickBooksOwnerApp(m, 'synthetic.manifest.json', flags, { ...options, companion }), { code: 'quickbooks_transfer_unverified' });
    assert.equal(prepares, 1);
    companion.prepare = async () => { prepares++; return { stage: 'keys_staged', connected: false }; };
    assert.equal((await setupQuickBooksOwnerApp(m, 'synthetic.manifest.json', flags, { ...options, companion })).connected, false);
    assert.equal(prepares, 2);
    assert.throws(() => quickBooksOwnerBindingFromManifest({ ...m, corpora: { quickbooks: { ...m.corpora.quickbooks, owner_app: null } } }), { code: 'quickbooks_owner_app_required' });
    assert.throws(() => quickBooksOwnerBindingFromManifest({ ...m, corpora: { quickbooks: { ...m.corpora.quickbooks, owner_app: { ...m.corpora.quickbooks.owner_app, environment: 'sandbox' } } } }), { code: 'quickbooks_owner_binding_invalid' });
  });
});

test('P09 sandbox cannot adopt a production-staged singleton before opening a listener', async () => {
  const oauth = await import('../connectors/provider-oauth.mjs');
  await fixture(async (storage) => {
    await oauth.stageQuickBooksOwnerApp(binding, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }, storage);
    let opened = 0;
    await assert.rejects(oauth.authorizeProvider('quickbooks', {
      storage, clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
      openImpl: () => { opened++; return true; }, prepareConnection: () => { throw new Error('must not prepare'); },
    }), { code: 'quickbooks_owner_binding_conflict' });
    assert.equal(opened, 0);
    assert.equal((await oauth.quickBooksOwnerAppStatus(binding, storage)).stage, 'keys_staged');
  });
});

test('binding rejects coerced identifiers instead of accepting different typed values', async () => {
  const { validateQuickBooksOwnerBinding } = await import('../connectors/quickbooks-owner-binding.mjs');
  for (const change of [{ app_id: 1 }, { source: 1 }, { installation_id: 1234567890123456 }]) {
    assert.throws(() => validateQuickBooksOwnerBinding({ ...binding, ...change }), { code: 'quickbooks_owner_binding_invalid' });
  }
  assert.equal(validateQuickBooksOwnerBinding(binding).app_id, binding.app_id);
});

test('staging requires exact readback even after the protected backend verified its own commit', async () => {
  const oauth = await import('../connectors/provider-oauth.mjs');
  await fixture(async (base) => {
    const items = new Map(); let baseReads = 0, writes = 0, tamper = true;
    const storage = { ...base, backend: 'keychain', platform: 'darwin',
      runSecurity: (args, options = {}) => {
        const account = args[args.indexOf('-a') + 1];
        if (args[0] === 'add-generic-password') {
          writes++; items.set(account, options.input.replace(/\n$/, ''));
          if (account === 'local-quickbooks-connection') baseReads = 0;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'delete-generic-password') { items.delete(account); return { status: 0, stdout: '', stderr: '' }; }
        if (!items.has(account)) return { status: 44, stdout: '', stderr: '' };
        if (account === 'local-quickbooks-connection' && args.includes('-w')) {
          baseReads++;
          if (tamper && baseReads === 3) return { status: 0, stdout: '{}', stderr: '' };
        }
        return { status: 0, stdout: items.get(account), stderr: '' };
      },
    };
    const pair = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' };
    await assert.rejects(oauth.stageQuickBooksOwnerApp(binding, pair, storage), { code: 'quickbooks_owner_store_unverified' });
    assert.ok(writes > 0); assert.equal(baseReads, 3);
    tamper = false;
    assert.equal((await oauth.stageQuickBooksOwnerApp(binding, pair, storage)).stage, 'keys_staged');
  });
});

test('authorization refuses changed custody and a missing code after a valid company callback', async () => {
  const { quickBooksCompanyFingerprint } = await import('../connectors/quickbooks-online.mjs');
  const oauth = await import('../connectors/provider-oauth.mjs');
  const bound = { ...binding, company_fingerprint: quickBooksCompanyFingerprint('company-one') };
  await fixture(async (storage) => {
    let callbacks = 0, exchanges = 0;
    const pair = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' };
    await oauth.stageQuickBooksOwnerApp(bound, pair, storage);
    await assert.rejects(oauth.authorizeQuickBooksOwnerApp(bound, { storage }), { code: 'quickbooks_companion_required' });
    const opts = { storage, now: () => Date.parse('2026-10-10T12:00:00Z'),
      fetchImpl: async () => { exchanges++; return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })); },
      receiveAuthorization: async () => { callbacks++; return { realmId: 'company-one', authorizationCode: '' }; },
    };
    await assert.rejects(oauth.authorizeQuickBooksOwnerApp(bound, opts), { code: 'quickbooks_code_required' });
    assert.equal(callbacks, 1); assert.equal(exchanges, 0);
    opts.receiveAuthorization = async () => {
      callbacks++; await oauth.stageQuickBooksOwnerApp(bound, { ...pair, clientSecret: 'new-synthetic-secret' }, storage);
      return { realmId: 'company-one', authorizationCode: 'synthetic-code' };
    };
    await assert.rejects(oauth.authorizeQuickBooksOwnerApp(bound, opts), { code: 'credential_changed_during_authorization' });
    assert.equal(callbacks, 2); assert.equal(exchanges, 0);
    opts.receiveAuthorization = async () => ({ realmId: 'company-one', authorizationCode: 'synthetic-code' });
    assert.equal((await oauth.authorizeQuickBooksOwnerApp(bound, opts)).connected, true);
    assert.equal(exchanges, 1);
  });
});

test('remaining callback, scheduling and pairing guard controls are observable', async () => {
  const { connectQuickBooksOwnerApp, disconnectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  const { quickBooksProductionRedirect } = await import('../connectors/quickbooks-owner-binding.mjs');
  assert.throws(() => quickBooksProductionRedirect('not a URL'), { code: 'quickbooks_origin_invalid' });
  await productionFixture(async ({ m, options, calls }) => {
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options,
      companion: { assertReady: async () => { calls.ready++; throw new Error('native-private-canary'); } },
    }), { code: 'quickbooks_companion_unverified' });
    assert.equal(calls.ready, 1); assert.equal(calls.start, 0);
    const base = options.callbackTransport;
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options,
      callbackTransport: async (action, payload) => { await base(action, payload); throw new Error('native-private-canary'); },
    }), { code: 'quickbooks_callback_unavailable' });
    assert.equal(calls.start, 1); assert.equal(calls.open, 0);
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options,
      callbackTransport: async (action, payload) => action === 'status' ? (calls.status++, { status: 'pending' }) : base(action, payload),
    }), { code: 'quickbooks_callback_timeout' });
    assert.equal(calls.status, 120); assert.equal(calls.exchange, 0);
    const scheduled = { ...m, operations: { quickbooks_schedule: { enabled: true } } };
    await assert.rejects(connectQuickBooksOwnerApp(scheduled, 'synthetic.manifest.json', options), { code: 'quickbooks_schedule_rebind_required' });
    assert.equal(calls.exchange, 1);
  });
  await productionFixture(async ({ m, options, calls }) => {
    let rebinds = 0;
    assert.equal((await connectQuickBooksOwnerApp({ ...m, operations: { quickbooks_schedule: {} } }, 'synthetic.manifest.json', {
      ...options, reregisterAfterManifestChange: async () => { rebinds++; },
    })).connected, true);
    assert.equal(rebinds, 1); assert.equal(calls.finalize, 1);
    let pauses = 0, verifies = 0, revokes = 0;
    const disconnect = { ...options, fetchImpl: async () => { revokes++; return new Response('{}'); }, companion: {
      ...options.companion, pauseAndVerify: async () => { pauses++; return false; }, verifyPaused: async () => { verifies++; return false; },
    } };
    await assert.rejects(disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, disconnect), { code: 'quickbooks_pause_unverified' });
    assert.equal(pauses, 1); assert.equal(revokes, 0);
    disconnect.companion.pauseAndVerify = async () => { pauses++; return true; };
    await assert.rejects(disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, disconnect), { code: 'quickbooks_pause_unverified' });
    assert.equal(revokes, 1); assert.equal(verifies, 1);
    disconnect.companion.verifyPaused = async () => { verifies++; return true; };
    assert.equal((await disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, disconnect)).disconnected, true);
    assert.equal(verifies, 2);
  });
});

test('transfer expiry while the credential view is suppressed cannot write keys', async () => {
  const { createQuickBooksOwnerTransfer } = await import('../operations/quickbooks-owner-transfer.mjs');
  let clock = Date.parse('2026-10-10T12:00:00Z'), reads = 0, writes = 0, closed = 0;
  const selection = { origin: 'https://developer.intuit.com', app_id: binding.app_id, environment: 'production', redirect_uri: binding.redirect_uri };
  const operation = { operation_id: 'operation-fixture-00000000000001', binding, expires_at: clock + 60_000 };
  const helper = createQuickBooksOwnerTransfer({ now: () => clock, verifyCompanion: async () => true,
    suppressObservation: async () => true, closeCredentialView: async () => { closed++; return true; }, resumeObservation: async () => {},
    capturePair: async () => { reads++; clock += 60_000; return { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }; },
    stage: async () => { writes++; },
  });
  await assert.rejects(helper.transfer(operation, selection), { code: 'quickbooks_transfer_unverified' });
  assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(closed, 1);
  assert.equal((await helper.transfer({ ...operation, operation_id: 'operation-fixture-00000000000002', expires_at: clock + 120_000 }, selection)).stage, 'keys_staged');
  assert.equal(writes, 1);
});

test('disconnect preserves staged keys when an exchange may have created an unrevokeable grant', async () => {
  const { connectQuickBooksOwnerApp, disconnectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, calls, bound, oauth }) => {
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options,
      fetchImpl: async () => { calls.exchange++; throw new Error('synthetic-response-loss'); },
    }), { code: 'quickbooks_exchange_outcome_unknown' });
    assert.equal(calls.exchange, 1);
    const disconnect = { ...options, companion: { ...options.companion,
      pauseAndVerify: async () => true, verifyPaused: async () => true },
      fetchImpl: async () => new Response('{}'),
    };
    await assert.rejects(disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, disconnect), { code: 'quickbooks_revocation_uncertain' });
    assert.equal((await oauth.quickBooksOwnerAppStatus(bound, options.storage)).stage, 'reconnect');
    await oauth.authorizeQuickBooksOwnerApp(bound, { ...options,
      receiveAuthorization: async () => ({ realmId: 'company-one', authorizationCode: 'synthetic-new-code' }),
    });
    assert.equal((await disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, disconnect)).remote_revoked, true);
  });
});

test('real production CLI dispatch uses protected keys and never ambient client credentials', async () => {
  await productionFixture(async ({ m, options, calls }) => {
    const path = join(options.storage.home, 'synthetic.manifest.json');
    writeFileSync(path, JSON.stringify(m));
    const result = await cmdConnectProvider('quickbooks', path, {}, { ...options,
      providerRecordLease: { held: true, assertOwned() {} },
      environment: { QUICKBOOKS_CLIENT_ID: 'ambient-must-not-win', QUICKBOOKS_CLIENT_SECRET: 'ambient-must-not-win' },
      credentials: { clientId: 'injected-must-not-win', clientSecret: 'injected-must-not-win' },
    });
    assert.equal(result.connected, true); assert.equal(calls.start, 1); assert.equal(calls.exchange, 1);
  });
});

test('a tampered active binding refuses staging and unresolved authorization fences token use', async () => {
  const { loadTokens, saveTokens } = await import('../connectors/google-auth.mjs');
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, bound, oauth }) => {
    await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options);
    const storage = oauth.providerCredentialOptions('quickbooks', options.storage);
    const saved = loadTokens(storage);
    const damaged = structuredClone(saved);
    damaged.connection.quickbooks_owner_app.app_id = 'different-app';
    saveTokens(damaged, storage);
    await assert.rejects(oauth.stageQuickBooksOwnerApp(bound, { clientId: 'fixture', clientSecret: 'synthetic-secret' }, options.storage), { code: 'quickbooks_owner_binding_conflict' });
    assert.ok(saved.connection.quickbooks_binding.sources.quickbooks);
    saveTokens({ ...saved, quickbooks_authorization: { state: 'outcome_unknown', code_fingerprint: 'a'.repeat(64) } }, storage);
    let reads = 0;
    await assert.rejects(oauth.providerAccessToken('quickbooks', { storage: options.storage, now: Date.parse('2026-10-10T12:05:00Z'),
      quickBooksBinding: { source: 'quickbooks', environment: 'production' }, fetchImpl: async () => { reads++; throw new Error('must not read'); },
    }), { code: 'quickbooks_authorization_unverified' });
    assert.equal(reads, 0);
    saveTokens(saved, storage);
    assert.equal((await oauth.providerAccessToken('quickbooks', { storage: options.storage, now: Date.parse('2026-10-10T12:05:00Z'),
      quickBooksBinding: { source: 'quickbooks', environment: 'production' },
    })).refreshed, false);
  });
});

test('malformed finalization identity is refused after reaching the company-bound callback', async () => {
  const oauth = await import('../connectors/provider-oauth.mjs');
  const { quickBooksCompanyFingerprint } = await import('../connectors/quickbooks-online.mjs');
  const bound = { ...binding, company_fingerprint: quickBooksCompanyFingerprint('company-one') };
  await fixture(async (storage) => {
    await oauth.stageQuickBooksOwnerApp(bound, { clientId: 'fixture', clientSecret: 'synthetic-secret' }, storage);
    let callbacks = 0, exchanges = 0;
    const opts = { storage, now: () => Date.parse('2026-10-10T12:00:00Z'),
      receiveAuthorization: async () => { callbacks++; return { realmId: 'company-one', authorizationCode: 'synthetic-code', finalization: { intent_id: 'invalid' } }; },
      fetchImpl: async () => { exchanges++; return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })); },
    };
    await assert.rejects(oauth.authorizeQuickBooksOwnerApp(bound, opts), { code: 'quickbooks_finalization_unverified' });
    assert.equal(callbacks, 1); assert.equal(exchanges, 1);
    assert.equal(oauth.loadProviderCredentials('quickbooks', storage), null);
    opts.receiveAuthorization = async () => ({ realmId: 'company-one', authorizationCode: 'synthetic-fresh-code' });
    assert.equal((await oauth.authorizeQuickBooksOwnerApp(bound, opts)).connected, true);
  });
});

test('refresh commit refuses an installation binding changed during the provider request', async () => {
  const { loadTokens, saveTokens } = await import('../connectors/google-auth.mjs');
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, oauth }) => {
    await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options);
    let renewals = 0;
    const storage = oauth.providerCredentialOptions('quickbooks', options.storage);
    await assert.rejects(oauth.providerAccessToken('quickbooks', {
      storage: options.storage, now: Date.parse('2026-10-10T14:00:00Z'),
      quickBooksBinding: { source: 'quickbooks', environment: 'production' },
      fetchImpl: async () => {
        renewals++;
        const store = loadTokens(storage);
        store.quickbooks_installation.app_id = 'another-app';
        saveTokens(store, storage);
        return new Response(JSON.stringify({ access_token: 'synthetic-renewed', refresh_token: 'synthetic-rotated', expires_in: 3600 }));
      },
    }), { code: 'refresh_persistence_unverified' });
    assert.equal(renewals, 1);
  });
});

test('explicit reconnect starts fresh consent when an expired finalization can no longer be acknowledged', async () => {
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  await productionFixture(async ({ m, options, calls, setAuthorizationCode }) => {
    const transport = options.callbackTransport;
    let unavailable = true;
    options.callbackTransport = async (action, payload) => {
      if (action === 'finalize' && unavailable) { calls.finalize++; throw new Error('synthetic-expired-intent'); }
      return transport(action, payload);
    };
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options), { code: 'quickbooks_finalization_outcome_unknown' });
    assert.equal(calls.exchange, 1);
    setAuthorizationCode('synthetic-fresh-code'); unavailable = false;
    assert.equal((await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options, freshConsent: true })).connected, true);
    assert.equal(calls.start, 2); assert.equal(calls.exchange, 2); assert.equal(calls.finalize, 2);
  });
});

test('pending finalization verifies the exact current local credential before acknowledging it', async () => {
  const { connectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  const { loadTokens, saveTokens } = await import('../connectors/google-auth.mjs');
  await productionFixture(async ({ m, options, calls, oauth }) => {
    const transport = options.callbackTransport;
    let lose = true;
    options.callbackTransport = async (action, payload) => {
      const result = await transport(action, payload);
      if (action === 'finalize' && lose) throw new Error('synthetic-response-loss');
      return result;
    };
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options), { code: 'quickbooks_finalization_outcome_unknown' });
    const storage = oauth.providerCredentialOptions('quickbooks', options.storage);
    const saved = loadTokens(storage);
    const changed = structuredClone(saved); changed.connection.access_token = 'synthetic-concurrent-replacement';
    saveTokens(changed, storage); lose = false;
    await assert.rejects(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options), { code: 'quickbooks_finalization_unverified' });
    assert.equal(calls.finalize, 1); assert.equal(calls.exchange, 1);
    saveTokens(saved, storage);
    assert.equal((await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options)).connected, true);
    assert.equal(calls.finalize, 2); assert.equal(calls.exchange, 1);
  });
});

test('native companion failures never expose their private diagnostic body', async () => {
  const { createQuickBooksOwnerTransfer } = await import('../operations/quickbooks-owner-transfer.mjs');
  const { setupQuickBooksOwnerApp, connectQuickBooksOwnerApp, disconnectQuickBooksOwnerApp } = await import('../operations/quickbooks-owner-setup.mjs');
  const failure = async () => { throw new Error('private-native-canary'); };
  const refuses = async (promise, code) => assert.rejects(promise, (error) => {
    assert.equal(error.code, code); assert.equal(error.message.includes('private-native-canary'), false); return true;
  });
  const clock = Date.parse('2026-10-10T12:00:00Z');
  const operation = { operation_id: 'operation-fixture-00000000000001', binding, expires_at: clock + 60_000 };
  const selection = { origin: 'https://developer.intuit.com', app_id: binding.app_id, environment: 'production', redirect_uri: binding.redirect_uri };
  let reads = 0;
  const deps = { now: () => clock, verifyCompanion: async () => true, suppressObservation: async () => true,
    capturePair: async () => { reads++; return { clientId: 'fixture', clientSecret: 'synthetic-secret' }; },
    closeCredentialView: async () => true, resumeObservation: async () => {}, stage: async () => {} };
  await refuses(createQuickBooksOwnerTransfer({ ...deps, verifyCompanion: failure }).transfer(operation, selection), 'quickbooks_companion_required');
  await refuses(createQuickBooksOwnerTransfer({ ...deps, suppressObservation: failure }).transfer(operation, selection), 'quickbooks_observation_not_suppressed');
  assert.equal(reads, 0);
  assert.equal((await createQuickBooksOwnerTransfer(deps).transfer(operation, selection)).stage, 'keys_staged');
  await productionFixture(async ({ m, options, calls }) => {
    await refuses(setupQuickBooksOwnerApp(m, 'synthetic.manifest.json', { 'owner-app-setup': true }, {
      ...options, companion: { ...options.companion, prepare: failure },
    }), 'quickbooks_transfer_failed');
    await refuses(connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { ...options, openImpl: failure }), 'quickbooks_browser_unavailable');
    assert.equal(calls.start, 1); assert.equal(calls.exchange, 0);
    await refuses(disconnectQuickBooksOwnerApp(m, 'synthetic.manifest.json', { confirm: true }, {
      ...options, companion: { ...options.companion, pauseAndVerify: failure },
    }), 'quickbooks_pause_unverified');
    assert.equal((await connectQuickBooksOwnerApp(m, 'synthetic.manifest.json', options)).connected, true);
  });
});
