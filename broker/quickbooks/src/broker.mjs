import { canonical, randomCapability, sha256, verifyObject, importPublic, createBrokerCrypto } from './crypto.mjs';
import { assertSchema, assertWindow, parseJson, parseLaunch, parseCallback, validateCallback, resolveCallback } from './validation.mjs';
import { createProvider, companyFingerprint, validateProviderConfig } from './provider.mjs';

const PROTOCOL = 'qbo-broker/1';
const ROOT = '/v1/quickbooks';
export const ROUTES = Object.freeze({ issue: ROOT + '/installations/issue', start: ROOT + '/authorizations',
  launch: ROOT + '/launch', callback: ROOT + '/oauth/callback', refresh: ROOT + '/tokens/refresh',
  revoke: ROOT + '/tokens/revoke', health: '/health', result: ROOT + '/result' });
const RETENTION = 30 * 86400_000;
const COOKIE = '__Secure-qbo_transaction';
const HEADERS = Object.freeze({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
class Refusal extends Error {
  constructor(code, status = 400) { super('Broker request refused'); this.code = code; this.status = status; }
}
const refuse = (code, status) => { throw new Refusal(code, status); };
const same = (a, b) => canonical(a) === canonical(b);
const without = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const json = (value, status = 200) => new Response(canonical(value), { status, headers: { ...HEADERS, 'content-type': 'application/json' } });

/** All effects are explicit dependencies; this module never imports owner data code. */
export function createBroker({ config: suppliedConfig, store, providerTransport, ownerTransport, resolve,
  verifyAccess, now = Date.now, observe = () => {}, logEvent = () => {},
  networkAddress = () => 'unattributed', beforeRevokeFence = () => true, circuitAllows = () => true }) {
  const config = Object.freeze({ ...suppliedConfig });
  validateProviderConfig(config);
  assertSchema('digest', config.buildId);
  assertSchema('generation', config.keyGeneration);
  if (!store || typeof ownerTransport !== 'function' || typeof resolve !== 'function' ||
      typeof verifyAccess !== 'function') throw new Error('Invalid broker dependencies');
  const crypt = createBrokerCrypto({ clientSecret: config.clientSecret, keyGeneration: config.keyGeneration });
  const provider = createProvider({ config, transport: providerTransport, now });
  const brokerOrigin = new URL(config.redirectUri).origin;
  const configurationHash = () => sha256({ environment: config.environment, client_id: config.clientId,
    authorization_endpoint: config.authorizationUrl, token_endpoint: config.tokenUrl,
    revoke_endpoint: config.revokeUrl, redirect_uri: config.redirectUri });

  async function ready() {
    const value = await store.getReadiness();
    return value?.ready === true && value.build_id === config.buildId && value.key_generation === config.keyGeneration;
  }
  async function health() {
    let available = false;
    try { available = await ready(); } catch { /* Stable dependency status only. */ }
    return json({ protocol: PROTOCOL, build_id: config.buildId, key_generation: config.keyGeneration,
      ready: available, dependencies: { replay_ledger: available ? 'ready' : 'unavailable', configuration: 'ready' } }, available ? 200 : 503);
  }
  async function audit(row, phase, outcome, status = 200, attempts = 0) {
    const instant = now();
    const event = { protocol: PROTOCOL, event_id_hash: await crypt.hash('event', randomCapability()),
      request_id_hash: row?.request_id_hash ?? null, route: row.route,
      install_fingerprint: row?.install_fingerprint ?? null, intent_hash: row?.intent_hash ?? null,
      state_hash: row?.state_hash ?? null, phase, outcome, http_status_class: `${Math.floor(status / 100)}xx`,
      build_id: config.buildId, key_generation: config.keyGeneration, created_at: instant,
      expires_at: instant + RETENTION, duration_ms: 0, attempt_count: attempts, retention_ms: RETENTION };
    assertSchema('auditEvent', event);
    await store.recordEvent(event);
    // The logging boundary accepts exactly this closed projection, never a Request.
    logEvent(Object.freeze({ ...event }));
  }
  async function replay(route, requestId, voucher, intent = null, state = null, phase = 'start', attempts = 0) {
    const instant = now();
    return { protocol: PROTOCOL, route, request_id_hash: await crypt.hash('request', requestId),
      state_hash: state ? await crypt.hash('state', state) : null,
      intent_hash: intent ? await crypt.hash('intent', intent) : null,
      install_fingerprint: await crypt.hash('install', voucher), phase, provider_attempts: attempts,
      key_generation: config.keyGeneration, created_at: instant, expires_at: instant + RETENTION };
  }
  async function voucher(value, prefix) {
    observe(`${prefix}.voucher.generation.checked`);
    if (value?.claims?.key_generation !== config.keyGeneration) refuse('unauthorized', 401);
    if (!await crypt.verifyVoucher(value, now())) refuse('unauthorized', 401);
    validateCallback(value.claims.callback);
    if (value.claims.environment !== config.environment ||
        await store.isVoucherRevoked(await crypt.hash('install', value))) refuse('binding_mismatch', 403);
    return value.claims;
  }
  async function proof(request, kind) {
    observe(`${kind}.proof.checked`);
    const value = await parseJson(request, { schema: kind === 'start' ? 'startRequest' : `${kind}Request` });
    assertWindow(value, now());
    const claims = await voucher(value.voucher, kind);
    if (value.method !== request.method || value.route !== new URL(request.url).pathname || value.key_generation !== config.keyGeneration) refuse('unauthorized', 401);
    if (await sha256(value.body) !== value.body_hash ||
        !await verifyObject(claims.install_public_key, 'qbo-broker/1/request', without(value, 'signature'), value.signature)) refuse('unauthorized', 401);
    observe(`${kind}.signature.checked`);
    observe(`${kind}.voucher.binding.checked`);
    if (value.body.callback !== claims.callback || value.body.environment !== claims.environment) refuse('binding_mismatch', 403);
    if (kind !== 'revoke') await importPublic(value.body.delivery_public_key, 'ECDH');
    observe('request.replay.checked');
    if (await store.getReplay(await crypt.hash('request', value.request_id))) refuse('replayed', 409);
    return value;
  }
  async function quota(request, route, install, kind) {
    observe(`${kind}.quota.checked`);
    if (!await circuitAllows(route) || !await store.providerCircuitAllows(route, { since: Math.max(0, now() - 60_000), limit: 20 })) refuse('quota_exceeded', 429);
    const instant = now();
    const entries = [];
    const add = (subjectKind, subjectHash, window, limit) => {
      const start = Math.floor(instant / window) * window;
      entries.push({ row: { protocol: PROTOCOL, route, subject_kind: subjectKind, subject_hash: subjectHash,
        window_start: start, window_ms: window, count: 0, expires_at: start + Math.min(window * 2, 1200_000),
        retention_ms: Math.min(window * 2, 1200_000) }, limit });
    };
    if (kind === 'start') {
      add('install', install, 600_000, 5);
      add('network', await crypt.hash('address', networkAddress(request)), 600_000, 20);
    }
    if (kind === 'callback') add('network', await crypt.hash('address', networkAddress(request)), 60_000, 30);
    if (kind === 'refresh') add('install', install, 600_000, 2);
    // Coarse route admission supplements the separately injected provider circuit.
    add('global', await crypt.hash('request', `global:${route}`), 60_000, 1000);
    await store.admitQuota(entries);
  }
  async function pinned(request, callback) {
    const destination = await resolveCallback(callback, resolve);
    // The injected transport must preserve Host/TLS name and use only these
    // validated addresses. No unpinned production transport ships in this lane.
    const response = await ownerTransport(request, Object.freeze({ hostname: destination.url.hostname, addresses: Object.freeze([...destination.addresses]) }));
    if (response.redirected || response.status >= 300 && response.status < 400) refuse('delivery_unconfirmed', 503);
    return response;
  }
  async function issue(request) {
    observe('enrollment.access.checked');
    if (await verifyAccess(request) !== true) refuse('unauthorized', 401);
    observe('enrollment.callback.checked');
    const value = await parseJson(request, { schema: 'enrollmentIssue' });
    assertWindow(value, now());
    const callback = validateCallback(value.callback);
    if (value.environment !== config.environment) refuse('binding_mismatch', 403);
    observe('enrollment.challenge.checked');
    const challengeResponse = await pinned(new Request(callback.origin + '/api/quickbooks/connect/enrollment/challenge', {
      headers: { authorization: `Bearer ${value.challenge}` }, redirect: 'manual' }), value.callback);
    if (!challengeResponse.ok) refuse('unauthorized', 401);
    const challenge = await parseJson(challengeResponse, { schema: 'enrollmentChallenge' });
    assertWindow(challenge, now(), 120_000);
    if (challenge.challenge !== value.challenge || challenge.callback !== value.callback || challenge.environment !== value.environment ||
        challenge.key_generation !== config.keyGeneration || !same(challenge.install_public_key, value.install_public_key) ||
        !await verifyObject(value.install_public_key, 'qbo-broker/1/challenge', without(challenge, 'signature'), challenge.signature)) refuse('unauthorized', 401);
    const issued = now();
    const issuedVoucher = await crypt.mintVoucher({ protocol: PROTOCOL, environment: config.environment,
      key_generation: config.keyGeneration, voucher_id: randomCapability(), issued_at: issued, expires_at: issued + 86400_000,
      callback: value.callback, install_public_key: value.install_public_key });
    const row = await replay(ROUTES.issue, value.request_id, issuedVoucher, null, value.challenge, 'enrollment');
    await store.createReplay(row);
    await audit(row, 'enrollment', 'accepted', 202);
    const deliveryBytes = canonical({ protocol: PROTOCOL, challenge: value.challenge, voucher: issuedVoucher });
    const expectedAcknowledgement = { protocol: PROTOCOL, outcome: 'committed_readback', install_fingerprint: await sha256(issuedVoucher) };
    const deadline = Math.min(now() + 10_000, challenge.expires_at);
    let delivered = false;
    let failure = 'delivery_unconfirmed';
    // Reuse the one minted voucher and exact bytes only within this invocation.
    // A lost acknowledgement must not restart challenge verification or issuance.
    for (let attempt = 0; attempt < 3 && now() < deadline; attempt++) {
      try {
        const response = await pinned(new Request(callback.origin + '/api/quickbooks/connect/enrollment/voucher', {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - now())),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${value.challenge}` },
          body: deliveryBytes }), value.callback);
        if (!response.ok) continue;
        const acknowledgement = await parseJson(response);
        if (!same(acknowledgement, expectedAcknowledgement)) { failure = 'receipt_invalid'; continue; }
        delivered = true;
        break;
      } catch { /* Lost acknowledgements are retried with identical bytes only. */ }
    }
    if (!delivered) refuse(failure, 503);
    await audit(row, 'enrollment', 'delivered', 202);
    observe('enrollment.voucher.delivered');
    return json({ protocol: PROTOCOL, code: 'accepted', retry: 'never' }, 202);
  }
  const cookieValue = capsule => `${capsule.key_generation}.${capsule.iv}.${capsule.ciphertext}.${capsule.authentication_tag}`;
  const cookieHeader = (capsule, expiry) => `${COOKIE}=${cookieValue(capsule)}; Path=${ROUTES.callback}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expiry - now()) / 1000))}`;
  const clearCookie = `${COOKIE}=; Path=${ROUTES.callback}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  async function start(request) {
    const value = await proof(request, 'start');
    const state = randomCapability(), capability = randomCapability();
    const payload = { protocol: PROTOCOL, voucher: value.voucher, install_fingerprint: await sha256(value.voucher),
      intent: value.body.intent, request_id: value.request_id, callback: value.body.callback, environment: value.body.environment,
      delivery_public_key: value.body.delivery_public_key, delivery_key_fingerprint: await sha256(value.body.delivery_public_key),
      state, launch_capability_hash: await crypt.hash('launch', capability), start_hash: await sha256(value),
      issued_at: value.issued_at, expires_at: Math.min(value.issued_at + 600_000, value.voucher.claims.expires_at),
      key_generation: config.keyGeneration, provider_configuration_hash: await configurationHash(),
      delivery_auth_key: value.body.delivery_auth_key, expected_token_generation: value.body.expected_token_generation };
    assertSchema('transactionPayload', payload);
    const transaction = await crypt.seal('launch', payload);
    assertSchema('transactionCapsule', transaction);
    const cookie = await crypt.seal('cookie', payload);
    if (new TextEncoder().encode(cookieHeader(cookie, payload.expires_at)).length >= 4096) refuse('invalid_request', 413);
    const response = { protocol: PROTOCOL, launch_capability: capability, transaction, expires_at: Math.min(payload.issued_at + 120_000, payload.expires_at) };
    assertSchema('launchResponse', response);
    const row = await replay(ROUTES.start, value.request_id, value.voucher, value.body.intent, state);
    observe('start.admission.checked');
    await quota(request, ROUTES.start, row.install_fingerprint, 'start');
    await store.createReplay(row);
    await audit(row, 'start', 'accepted', 201);
    return json(response, 201);
  }
  async function context(payload, prefix) {
    assertSchema('transactionPayload', payload);
    if (payload.key_generation !== config.keyGeneration || payload.expires_at <= now() || payload.issued_at > now() + 30_000 ||
        payload.expires_at > payload.issued_at + 600_000) refuse('expired', 410);
    const claims = await voucher(payload.voucher, prefix);
    if (payload.callback !== claims.callback || payload.environment !== claims.environment ||
        payload.install_fingerprint !== await sha256(payload.voucher) ||
        payload.provider_configuration_hash !== await configurationHash() ||
        payload.delivery_key_fingerprint !== await sha256(payload.delivery_public_key)) refuse('binding_mismatch', 403);
    const row = await store.getReplay(await crypt.hash('request', payload.request_id));
    if (!row || row.state_hash !== await crypt.hash('state', payload.state) || row.install_fingerprint !== await crypt.hash('install', payload.voucher) ||
        row.intent_hash !== await crypt.hash('intent', payload.intent) || row.key_generation !== config.keyGeneration) refuse('binding_mismatch', 403);
    return row;
  }
  async function launch(request) {
    const value = await parseLaunch(request);
    const payload = await crypt.open('launch', value.transaction);
    observe('launch.expiry.checked');
    if (now() >= payload.issued_at + 120_000) refuse('expired', 410);
    const row = await context(payload, 'launch');
    if (await crypt.hash('launch', value.launch_capability) !== payload.launch_capability_hash) refuse('unauthorized', 401);
    observe('launch.replay.checked');
    const cookie = await crypt.seal('cookie', payload);
    const cookieText = cookieHeader(cookie, payload.expires_at);
    if (new TextEncoder().encode(cookieText).length >= 4096) refuse('invalid_request', 413);
    await store.transitionReplay(row.request_id_hash, 'start', 'launched');
    await audit({ ...row, route: ROUTES.launch }, 'launched', 'accepted', 303);
    const url = new URL(config.authorizationUrl);
    for (const [name, value] of Object.entries({ client_id: config.clientId, redirect_uri: config.redirectUri,
      response_type: 'code', scope: 'com.intuit.quickbooks.accounting', state: payload.state })) url.searchParams.set(name, value);
    return new Response(null, { status: 303, headers: { ...HEADERS, location: url.href, 'set-cookie': cookieText } });
  }
  function callbackCookie(request) {
    const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (matches.length !== 1 || matches[0].length > 4096) refuse('unauthorized', 401);
    const pieces = matches[0].slice(COOKIE.length + 1).split('.');
    if (pieces.length !== 4 || !/^[1-9][0-9]*$/.test(pieces[0])) refuse('unauthorized', 401);
    return { key_generation: Number(pieces[0]), iv: pieces[1], ciphertext: pieces[2], authentication_tag: pieces[3] };
  }
  function header(payload, purpose, generation) {
    return { protocol: PROTOCOL, purpose, delivery_id: randomCapability(), request_id: payload.request_id,
      install_fingerprint: payload.install_fingerprint, intent: payload.intent, callback: payload.callback,
      environment: payload.environment, key_generation: config.keyGeneration,
      delivery_key_fingerprint: payload.delivery_key_fingerprint, token_generation: generation,
      expires_at: payload.expires_at };
  }
  async function deliver(payload, envelope, expectedOutcome) {
    const bytes = canonical(envelope);
    if (new TextEncoder().encode(bytes).length > 32768) return false;
    const deadline = Math.min(now() + 10_000, payload.expires_at);
    for (let attempt = 0; attempt < 3 && now() < deadline; attempt++) {
      try {
        observe('delivery.destination.checked');
        const response = await pinned(new Request(payload.callback, { method: 'POST', redirect: 'manual',
          signal: AbortSignal.timeout(Math.max(1, deadline - now())), headers: { 'content-type': 'application/json' }, body: bytes }), payload.callback);
        observe('delivery.response.checked');
        if (!response.ok) continue;
        const receipt = await parseJson(response, { schema: expectedOutcome === 'committed_readback' ? 'deliveryReceipt' : 'completionReceipt' });
        const claims = receipt.claims;
        const expected = { ...without(envelope.header, 'purpose', 'callback', 'delivery_key_fingerprint', 'expires_at'),
          envelope_hash: await sha256(envelope), outcome: expectedOutcome, committed_at: claims.committed_at };
        if (!same(claims, expected) || claims.committed_at > now() + 30_000 || claims.committed_at > payload.expires_at ||
            !await verifyObject(payload.voucher.claims.install_public_key, 'qbo-broker/1/receipt', claims, receipt.signature)) continue;
        return true;
      } catch { observe('delivery.response.checked'); }
    }
    return false;
  }
  async function completion(payload, outcome) {
    if (now() >= payload.expires_at) return false;
    const envelope = await crypt.sealEnvelope(header(payload, 'completion', payload.expected_token_generation),
      { protocol: PROTOCOL, outcome }, payload.delivery_public_key, payload.delivery_auth_key);
    return deliver(payload, envelope, outcome);
  }
  async function cleanupGrant(payload, token) {
    const row = await replay(ROUTES.revoke, randomCapability(), payload.voucher, payload.intent, null, 'revoke_started', 1);
    await store.createReplay(row);
    await audit(row, 'revoke_started', 'accepted');
    observe('broker.revoke.sent');
    const outcome = await provider.revoke(token);
    await store.transitionReplay(row.request_id_hash, 'revoke_started', outcome === 'confirmed' ? 'revoked' : 'failed');
    await audit(row, outcome === 'confirmed' ? 'revoked' : 'failed', outcome === 'confirmed' ? 'revoked' : 'provider_uncertain');
    return outcome;
  }
  async function callback(request) {
    let target = brokerOrigin + ROUTES.result;
    let payload;
    try {
      observe('callback.binding.checked');
      const callbackUrl = new URL(request.url);
      if (callbackUrl.origin !== brokerOrigin || callbackUrl.hash || !await ready()) refuse('ledger_unavailable', 503);
      await quota(request, ROUTES.callback, null, 'callback');
      const query = parseCallback(new URL(request.url));
      const cookie = callbackCookie(request);
      observe('callback.cookie.binding.checked');
      payload = await crypt.open('cookie', cookie);
      if (query.state !== payload.state) refuse('binding_mismatch', 403);
      const row = { ...await context(payload, 'callback'), route: ROUTES.callback };
      target = new URL(payload.callback).origin + '/app/connect/quickbooks';
      observe('callback.replay.checked');
      if (query.error === 'access_denied') {
        await store.transitionReplay(row.request_id_hash, 'launched', 'canceled');
        await audit(row, 'canceled', 'owner_canceled', 303);
        await completion(payload, 'owner_canceled');
      } else {
        observe('broker.exchange.fence.attempted');
        await store.transitionReplay(row.request_id_hash, 'launched', 'exchange_started', { providerAttempts: 1 });
        await audit(row, 'exchange_started', 'accepted');
        observe('broker.exchange.fenced');
        observe('broker.exchange.sent');
        const result = await provider.exchange(query.code, query.realmId, payload.expected_token_generation);
        if (result.outcome !== 'accepted') {
          if (result.cleanupToken) {
            try { await cleanupGrant(payload, result.cleanupToken); } catch { /* The original exchange remains consumed. */ }
            finally { result.cleanupToken = null; }
          }
          await store.transitionReplay(row.request_id_hash, 'exchange_started', 'failed');
          await audit(row, 'failed', result.outcome, 303, 1);
          await completion(payload, result.outcome === 'provider_uncertain' ? 'manual_provider_removal_required' : 'failed');
        } else {
          let delivered = false;
          try {
            const envelope = await crypt.sealEnvelope(header(payload, 'connect', payload.expected_token_generation), result.bundle,
              payload.delivery_public_key, payload.delivery_auth_key);
            delivered = await deliver(payload, envelope, 'committed_readback');
          } finally {
            if (!delivered) {
              // Cleanup is a distinct, durably fenced mutation during this same
              // invocation. No token or encrypted envelope is queued for later.
              try { await cleanupGrant(payload, result.bundle.refresh_token); } catch { /* Fail closed. */ }
              await store.transitionReplay(row.request_id_hash, 'exchange_started', 'failed');
              await audit(row, 'failed', 'delivery_unconfirmed', 303, 1);
              // The callback could not be confirmed within its delivery budget.
              // Its pending owner intent expires visibly; do not claim receipt
              // of a fourth notification or retain tokens to send one later.
            }
            result.bundle = null;
          }
          if (delivered) {
            await store.transitionReplay(row.request_id_hash, 'exchange_started', 'delivered');
            await audit(row, 'delivered', 'delivered', 303, 1);
          }
        }
      }
    } catch {
      // With an untrusted binding only route-level metadata is admissible.
      try { await audit({ route: ROUTES.callback }, 'failed', 'invalid_request', 303); } catch { /* No logging fallback. */ }
    }
    finally { payload = null; }
    return new Response(null, { status: 303, headers: { ...HEADERS, location: target, 'set-cookie': clearCookie } });
  }
  async function refresh(request) {
    const value = await proof(request, 'refresh');
    if (await companyFingerprint(value.body.realm_id) !== value.body.company_fingerprint) refuse('binding_mismatch', 403);
    const row = await replay(ROUTES.refresh, value.request_id, value.voucher, value.body.intent, null, 'refresh_started', 1);
    await quota(request, ROUTES.refresh, row.install_fingerprint, 'refresh');
    await store.createReplay(row, { limits: [{ route: ROUTES.refresh, installFingerprint: row.install_fingerprint, since: now() - 3600_000, limit: 6 }] });
    await audit(row, 'refresh_started', 'accepted');
    observe('broker.refresh.sent');
    const result = await provider.refresh(value.body.refresh_token, value.body.realm_id, value.body.token_generation + 1);
    value.body.refresh_token = '';
    if (result.outcome !== 'accepted') {
      await store.transitionReplay(row.request_id_hash, 'refresh_started', 'failed');
      await audit(row, 'failed', result.outcome, 503, 1);
      refuse(result.outcome, 503);
    }
    try {
      const payload = { ...value.body, request_id: value.request_id, install_fingerprint: await sha256(value.voucher),
        delivery_key_fingerprint: await sha256(value.body.delivery_public_key), expires_at: Math.min(value.expires_at, value.voucher.claims.expires_at) };
      const envelope = await crypt.sealEnvelope(header(payload, 'refresh', value.body.token_generation + 1), result.bundle,
        value.body.delivery_public_key, value.body.delivery_auth_key);
      await store.transitionReplay(row.request_id_hash, 'refresh_started', 'refreshed');
      await audit(row, 'refreshed', 'refreshed', 200, 1);
      return json(envelope);
    } finally { result.bundle = null; }
  }
  async function revoke(request) {
    const value = await proof(request, 'revoke');
    const fingerprint = await sha256(value.voucher);
    const common = { protocol: PROTOCOL, request_id: value.request_id, install_fingerprint: fingerprint,
      intent: value.body.intent, token_generation: value.body.token_generation, key_generation: config.keyGeneration, issued_at: now() };
    const row = await replay(ROUTES.revoke, value.request_id, value.voucher, value.body.intent, null, 'revoke_started', 1);
    const rateLimits = [{ route: ROUTES.revoke, installFingerprint: row.install_fingerprint, since: now() - 3600_000, limit: 3 }];
    await quota(request, ROUTES.revoke, row.install_fingerprint, 'revoke');
    observe('broker.revoke.fence.attempted');
    if (value.body.no_contact_proof) {
      const proof = value.body.no_contact_proof;
      const claims = proof.claims;
      const expected = { protocol: PROTOCOL, request_id: claims.request_id, install_fingerprint: fingerprint,
        intent: value.body.intent, token_generation: value.body.token_generation, key_generation: config.keyGeneration,
        expires_at: claims.expires_at, provider_contact: 'not_sent', operation_hash: await sha256(without(value.body, 'no_contact_proof')) };
      if (!same(claims, expected) || claims.expires_at <= now() || claims.expires_at > now() + 120_000 ||
          !await crypt.verifyMac('no_contact', 'qbo-broker/1/no-contact', claims, proof.mac)) refuse('unauthorized', 401);
      await store.consumeProof(await crypt.hash('request', claims.request_id), row, { limits: rateLimits });
    } else if (await beforeRevokeFence() === false) {
      row.phase = 'not_sent'; row.provider_attempts = 0;
      await store.createReplay(row, { limits: rateLimits });
      await audit(row, 'not_sent', 'no_provider_contact');
      const claims = { protocol: PROTOCOL, request_id: value.request_id, install_fingerprint: fingerprint,
        intent: value.body.intent, token_generation: value.body.token_generation, key_generation: config.keyGeneration,
        expires_at: Math.min(now() + 120_000, value.voucher.claims.expires_at), provider_contact: 'not_sent',
        operation_hash: await sha256(without(value.body, 'no_contact_proof')) };
      return json({ ...common, outcome: 'rejected', provider_contact: 'not_sent', no_contact_proof: {
        claims, mac: await crypt.mac('no_contact', 'qbo-broker/1/no-contact', claims) } });
    } else {
      await store.createReplay(row, { limits: rateLimits });
    }
    await audit(row, 'revoke_started', 'accepted');
    observe('broker.revoke.sent');
    const outcome = await provider.revoke(value.body.token);
    value.body.token = '';
    await store.transitionReplay(row.request_id_hash, 'revoke_started', outcome === 'confirmed' ? 'revoked' : 'failed');
    await audit(row, outcome === 'confirmed' ? 'revoked' : 'failed', outcome === 'confirmed' ? 'revoked' : outcome === 'rejected' ? 'provider_rejected' : 'provider_uncertain', 200, 1);
    return json({ ...common, outcome, provider_contact: 'attempted' });
  }
  return Object.freeze({ async fetch(request) {
    const url = new URL(request.url);
    const known = Object.values(ROUTES).includes(url.pathname);
    if (!known) return json({ protocol: PROTOCOL, code: 'invalid_request', retry: 'never' }, 404);
    if (url.pathname === ROUTES.callback && request.method === 'GET') return callback(request);
    try {
      if (url.origin !== brokerOrigin || url.username || url.password || url.hash || url.search) refuse('invalid_request', 400);
      const read = [ROUTES.callback, ROUTES.health, ROUTES.result].includes(url.pathname);
      if (request.method !== (read ? 'GET' : 'POST')) refuse('invalid_request', 405);
      if (url.pathname === ROUTES.health) return health();
      if (url.pathname === ROUTES.result) return new Response('<!doctype html><title>QuickBooks return</title><p>Return to your Brain to check the connection status.</p>', { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' } });
      if (!await ready()) refuse('ledger_unavailable', 503);
      return await ({ [ROUTES.issue]: issue, [ROUTES.start]: start, [ROUTES.launch]: launch,
        [ROUTES.refresh]: refresh, [ROUTES.revoke]: revoke })[url.pathname](request);
    } catch (error) {
      const knownCodes = new Set(['invalid_request', 'unauthorized', 'expired', 'replayed', 'binding_mismatch', 'quota_exceeded', 'ledger_unavailable', 'provider_rejected', 'provider_uncertain', 'delivery_unconfirmed', 'receipt_invalid']);
      const code = knownCodes.has(error?.code) ? error.code : 'ledger_unavailable';
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status :
        code === 'replayed' ? 409 : code === 'quota_exceeded' ? 429 : 503;
      try { await audit({ route: url.pathname }, 'failed', code, status); } catch { /* Unavailable D1 never falls back to raw logs. */ }
      return json({ protocol: PROTOCOL, code, retry: code === 'provider_uncertain' ? 'fresh_consent' : status === 503 || status === 429 ? 'after_delay' : 'never' }, status);
    }
  } });
}
