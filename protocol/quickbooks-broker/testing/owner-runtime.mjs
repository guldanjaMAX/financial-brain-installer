// Offline owner fixture: real cryptographic boundaries and SQLite commits, no
// deployment or substitute for the product owner's authentication integration.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  canonical, randomCapability, publicJwk, sha256, signObject, openEnvelope,
  encryptLocal, decryptLocal,
} from '../../../broker/quickbooks/src/crypto.mjs';
import { assertSchema, parseJson } from '../../../broker/quickbooks/src/validation.mjs';

const PROTOCOL = 'qbo-broker/1';
const START = '/v1/quickbooks/authorizations';
const REFRESH = '/v1/quickbooks/tokens/refresh';
const REVOKE = '/v1/quickbooks/tokens/revoke';
const CALLBACK = '/api/quickbooks/connect/callback';
const CHALLENGE = '/api/quickbooks/connect/enrollment/challenge';
const VOUCHER = '/api/quickbooks/connect/enrollment/voucher';
const BROKER = 'https://broker.invalid';
const response = (body, status = 200) => new Response(canonical(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const refuse = (status = 400) => response({ protocol: PROTOCOL, code: 'owner_request_refused' }, status);
const same = (left, right) => canonical(left) === canonical(right);
const empty = value => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
const companyFingerprint = async realm => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(`quickbooks-company-v1:${realm}`)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function createOwnerRuntime({ origin, now, transport, apiOrigins, observe, faults }) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE state (kind TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE intents (intent TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX intents_expiry ON intents (json_extract(value, '$.expires_at'), intent)
      WHERE json_extract(value, '$.status') = 'pending';
    CREATE TABLE receipts (delivery_id TEXT PRIMARY KEY, envelope_hash TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE imported_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO imported_records VALUES (1, 'synthetic retained record');
  `);
  const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
  const authHeaders = { authorization: `Bearer ${randomCapability()}` };
  const callback = origin + CALLBACK;
  let pendingEnrollment;
  let lease = false;
  let commitCount = 0;
  let readbackCount = 0;
  let enrollmentReadbackAttemptCount = 0;
  let intentExpiryReadbackCount = 0;
  let intentExpiryReadbackAttemptCount = 0;
  const get = kind => {
    const row = sqlite.prepare('SELECT value FROM state WHERE kind=?').get(kind);
    return row ? JSON.parse(row.value) : null;
  };
  const put = (kind, value) => sqlite.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(kind, canonical(value));
  const intentGet = intent => {
    const row = sqlite.prepare('SELECT value FROM intents WHERE intent=?').get(intent);
    return row ? JSON.parse(row.value) : null;
  };
  const intentPut = value => sqlite.prepare('INSERT OR REPLACE INTO intents VALUES (?,?)').run(value.intent, canonical(value));
  // A terminal intent is only replay evidence. Project explicitly so active
  // context and encrypted keys cannot survive as fields or null placeholders.
  const terminalIntent = (intent, status, receipt = null) => ({
    protocol: PROTOCOL, intent: intent.intent, status,
    delivery_id: receipt?.claims.delivery_id ?? null,
    envelope_hash: receipt?.claims.envelope_hash ?? null, receipt,
  });
  function storeTerminalIntent(record) {
    assertSchema('ownerIntent', record);
    intentPut(record);
    const stored = intentGet(record.intent);
    assertSchema('ownerIntent', stored);
    return stored;
  }
  const seal = (value, aad) => encryptLocal(wrappingKey, value, aad);
  const unseal = (value, aad) => decryptLocal(wrappingKey, value, aad);
  const privateKey = async () => crypto.subtle.importKey('jwk',
    await unseal(get('installation').private_key, 'install-key'),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const voucher = async () => unseal(get('installation').voucher, 'install-voucher');
  const post = (path, body) => transport(new Request(BROKER + path, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: canonical(body),
  }));

  // The fixture session is an injected authenticated owner boundary. The test
  // never grants authority by putting a Boolean in the signed broker body.
  function authenticated(request) {
    observe('owner.authentication.checked');
    return request.headers.get('authorization') === authHeaders.authorization;
  }

  async function boundedJson(request, maximum) {
    return parseJson(request, { maxBytes: maximum });
  }

  async function prepareEnrollment({ challengeValid = true, callback: proposed = callback } = {}) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = await publicJwk(pair.publicKey);
    const challenge = {
      protocol: PROTOCOL, challenge: randomCapability(), callback,
      install_public_key: publicKey, environment: 'sandbox', key_generation: 1,
      issued_at: now(), expires_at: now() + 120_000,
    };
    const signature = await signObject(pair.privateKey, 'qbo-broker/1/challenge', challenge);
    pendingEnrollment = {
      challenge: { ...challenge, signature: challengeValid ? signature : (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1) },
      privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
      consumed: false,
    };
    return {
      protocol: PROTOCOL, request_id: randomCapability(), challenge: challenge.challenge,
      callback: proposed, install_public_key: publicKey, environment: 'sandbox',
      issued_at: now(), expires_at: now() + 60_000,
    };
  }

  async function receiveVoucher(request) {
    const body = await boundedJson(request, 12_288);
    assertSchema('enrollmentDelivery', body);
    const deliveryHash = await sha256(body);
    const pending = pendingEnrollment;
    if (!pending || body.challenge !== pending.challenge.challenge) return refuse(403);
    const replayAcknowledgement = () => {
      const consumed = get('enrollment');
      if (!consumed || consumed.challenge !== body.challenge || consumed.delivery_hash !== deliveryHash) return refuse(403);
      observe('owner.enrollment.acknowledgement.replayed');
      return response(consumed.acknowledgement);
    };
    // A replay grants no new authority and needs neither the destroyed key nor
    // an unexpired challenge. Changed canonical bytes cannot reuse this receipt.
    if (pending.consumed) return replayAcknowledgement();
    if (pending.challenge.expires_at <= now()) return refuse(403);
    const claims = body.voucher.claims;
    if (claims.callback !== callback || claims.environment !== pending.challenge.environment ||
        claims.key_generation !== pending.challenge.key_generation ||
        !same(claims.install_public_key, pending.challenge.install_public_key) || claims.expires_at <= now()) return refuse(403);
    const fingerprint = await sha256(body.voucher);
    const record = {
      voucher: await seal(body.voucher, 'install-voucher'), private_key: await seal(pending.privateKey, 'install-key'),
      fingerprint, key_generation: claims.key_generation,
    };
    const acknowledgement = { protocol: PROTOCOL, outcome: 'committed_readback', install_fingerprint: fingerprint };
    const consumed = { challenge: body.challenge, consumed: true, delivery_hash: deliveryHash, acknowledgement };
    // Encryption yields. Another delivery may have committed while it ran.
    if (pending !== pendingEnrollment) return refuse(403);
    if (pending.consumed) return replayAcknowledgement();
    if (pending.challenge.expires_at <= now() || claims.expires_at <= now()) return refuse(403);
    sqlite.exec('BEGIN');
    try {
      put('installation', record);
      put('enrollment', consumed);
      enrollmentReadbackAttemptCount++;
      observe('owner.enrollment.readback.attempted');
      if (faults.delete('owner.enrollment.readback') || !same(get('installation'), record) ||
          !same(get('enrollment'), consumed)) throw new Error('owner_enrollment_unverified');
      sqlite.exec('COMMIT');
    } catch {
      sqlite.exec('ROLLBACK');
      return refuse(503);
    }
    pending.consumed = true;
    pending.privateKey = null;
    observe('owner.enrollment.committed');
    return response(acknowledgement);
  }

  async function newIntent(purpose = 'connect') {
    const installation = get('installation');
    if (!installation) throw new Error('owner_not_enrolled');
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const intent = randomCapability();
    const publicKey = await publicJwk(pair.publicKey);
    const authKey = randomCapability();
    const current = get('connection');
    const record = {
      purpose, intent, request_id: randomCapability(), callback, environment: 'sandbox',
      install_fingerprint: installation.fingerprint, key_generation: installation.key_generation,
      delivery_public_key: publicKey, delivery_key_fingerprint: await sha256(publicKey),
      private_key: await seal(await crypto.subtle.exportKey('jwk', pair.privateKey), intent + ':private'),
      auth_key: await seal(authKey, intent + ':authentication'),
      created_at: now(), expires_at: now() + 600_000, expected_token_generation: (current?.token_generation ?? 0) + 1,
      status: 'pending',
    };
    intentPut(record);
    put('last_intent', { intent });
    return record;
  }

  function expirePendingIntents() {
    // An unavailable callback cannot report terminal status to this Worker.
    // Owner status makes that timeout visible without retaining delivery keys.
    // A fixed indexed batch also reaches older intents on subsequent polls.
    sqlite.exec('BEGIN IMMEDIATE');
    let expiredCount = 0;
    try {
      const overdue = sqlite.prepare(`SELECT value FROM intents
        WHERE json_extract(value, '$.status') = 'pending'
          AND json_extract(value, '$.expires_at') <= ?
        ORDER BY json_extract(value, '$.expires_at'), intent LIMIT 32`).all(now());
      for (const row of overdue) {
        const expired = terminalIntent(JSON.parse(row.value), 'expired');
        const stored = storeTerminalIntent(expired);
        intentExpiryReadbackAttemptCount++;
        observe('owner.intent.expiry.readback.attempted');
        if (faults.delete('owner.intent.expiry.readback') || !same(stored, expired))
          throw new Error('owner_intent_readback_failed');
        expiredCount++;
      }
      sqlite.exec('COMMIT');
    } catch {
      sqlite.exec('ROLLBACK');
      throw new Error('owner_intent_expiry_unavailable');
    }
    intentExpiryReadbackCount += expiredCount;
    if (expiredCount) observe('owner.intent.expiry.readback');
  }

  async function signRequest(route, body, requestId = randomCapability()) {
    const installation = get('installation');
    const unsigned = {
      protocol: PROTOCOL, method: 'POST', route, request_id: requestId,
      issued_at: now(), expires_at: now() + 60_000, key_generation: installation.key_generation,
      voucher: await voucher(), body, body_hash: await sha256(body),
    };
    return { ...unsigned, signature: await signObject(await privateKey(), 'qbo-broker/1/request', unsigned) };
  }

  async function credential(field) {
    const connection = get('connection');
    return unseal(connection[field], `${connection.source}:${connection.token_generation}:${field}`);
  }

  async function makeSigned(route, bodyOverrides = {}, operation) {
    if (route === START) {
      const intent = operation ?? await newIntent();
      const body = {
        intent: intent.intent, callback, environment: intent.environment,
        delivery_public_key: intent.delivery_public_key,
        delivery_auth_key: await unseal(intent.auth_key, intent.intent + ':authentication'),
        expected_token_generation: intent.expected_token_generation, ...bodyOverrides,
      };
      return signRequest(route, body, intent.request_id);
    }
    const connection = get('connection');
    if (!connection) throw new Error('owner_connection_missing');
    if (route === REFRESH) {
      const intent = operation ?? await newIntent('refresh');
      const body = {
        intent: intent.intent, callback, environment: connection.environment,
        delivery_public_key: intent.delivery_public_key,
        delivery_auth_key: await unseal(intent.auth_key, intent.intent + ':authentication'),
        token_generation: connection.token_generation, company_fingerprint: connection.company_fingerprint,
        refresh_token: await credential('refresh_token'), realm_id: await credential('realm_id'), ...bodyOverrides,
      };
      return signRequest(route, body, intent.request_id);
    }
    if (route === REVOKE) {
      const body = {
        intent: operation?.intent ?? randomCapability(), callback, environment: connection.environment,
        token_generation: connection.token_generation, token: await credential('refresh_token'),
        token_type: 'refresh_token', ...bodyOverrides,
      };
      return signRequest(route, body);
    }
    throw new Error('owner_route_refused');
  }

  async function decodeBoundEnvelope(envelope, expectedPurpose) {
    assertSchema(expectedPurpose === 'refresh' ? 'refreshResponse' : 'ownerCallbackRequest', envelope);
    const header = envelope.header;
    const intent = intentGet(header.intent);
    const installation = get('installation');
    if (!intent || !installation || intent.status !== 'pending' || intent.expires_at <= now() ||
        header.expires_at <= now() || header.expires_at > intent.expires_at ||
        header.callback !== callback || header.install_fingerprint !== installation.fingerprint ||
        header.request_id !== intent.request_id || header.environment !== intent.environment ||
        header.key_generation !== intent.key_generation || header.delivery_key_fingerprint !== intent.delivery_key_fingerprint ||
        header.token_generation !== intent.expected_token_generation ||
        (expectedPurpose === 'refresh' ? header.purpose !== 'refresh' : !['connect', 'completion'].includes(header.purpose))) {
      throw new Error('owner_binding_refused');
    }
    const privateJwk = await unseal(intent.private_key, intent.intent + ':private');
    const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const authKey = await unseal(intent.auth_key, intent.intent + ':authentication');
    return { intent, payload: await openEnvelope(envelope, key, authKey) };
  }

  async function encryptedConnection(bundle, intent) {
    assertSchema('tokenBundle', bundle);
    const current = get('connection');
    if (bundle.token_generation !== intent.expected_token_generation || bundle.received_at > now() + 30_000 ||
        bundle.access_expires_at <= now() || bundle.refresh_expires_at <= now() ||
        bundle.company_fingerprint !== await companyFingerprint(bundle.realm_id) ||
        (current && (current.company_fingerprint !== bundle.company_fingerprint ||
          current.token_generation + 1 !== bundle.token_generation ||
          (current.hard_refresh_expires_at && (bundle.hard_refresh_expires_at === null ||
            bundle.hard_refresh_expires_at > current.hard_refresh_expires_at))))) {
      throw new Error('owner_bundle_refused');
    }
    const source = current?.source ?? randomCapability();
    const connection = {
      source, environment: intent.environment, company_fingerprint: bundle.company_fingerprint,
      token_generation: bundle.token_generation, access_expires_at: bundle.access_expires_at,
      refresh_expires_at: bundle.refresh_expires_at, hard_refresh_expires_at: bundle.hard_refresh_expires_at,
      status: 'connected', schedule_enabled: true,
    };
    for (const field of ['access_token', 'refresh_token', 'realm_id'])
      connection[field] = await seal(bundle[field], `${source}:${bundle.token_generation}:${field}`);
    return connection;
  }

  async function receiveEnvelope(request) {
    observe('owner.delivery.binding.checked');
    const envelope = await boundedJson(request, 32_768);
    const hash = await sha256(envelope);
    const previous = sqlite.prepare('SELECT * FROM receipts WHERE delivery_id=?').get(envelope.header?.delivery_id ?? '');
    if (previous) return previous.envelope_hash === hash ? response(JSON.parse(previous.value)) : refuse(409);
    const { intent, payload } = await decodeBoundEnvelope(envelope, 'connect');
    let outcome;
    let connection;
    if (envelope.header.purpose === 'completion') {
      assertSchema('completionResult', payload);
      outcome = payload.outcome;
      intent.status = outcome === 'owner_canceled' ? 'canceled' : 'failed';
    } else {
      connection = await encryptedConnection(payload, intent);
      outcome = 'committed_readback';
      intent.status = 'committed';
    }
    const header = envelope.header;
    const receipt = await deliveryReceipt(header, hash, outcome);
    const terminal = terminalIntent(intent, intent.status, receipt);
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      if (connection) put('connection', connection);
      const stored = storeTerminalIntent(terminal);
      if ((connection && !same(get('connection'), connection)) || !same(stored, terminal)) throw new Error('owner_readback_failed');
      sqlite.prepare('INSERT INTO receipts VALUES (?,?,?)').run(header.delivery_id, hash, canonical(receipt));
      sqlite.exec('COMMIT');
    } catch { sqlite.exec('ROLLBACK'); throw new Error('owner_commit_failed'); }
    if (connection) { commitCount++; readbackCount++; observe('owner.connection.readback'); }
    return response(receipt);
  }

  async function deliveryReceipt(header, hash, outcome) {
    const claims = Object.fromEntries(['protocol', 'delivery_id', 'request_id', 'install_fingerprint', 'intent',
      'environment', 'key_generation', 'token_generation'].map(key => [key, header[key]]));
    Object.assign(claims, { envelope_hash: hash, outcome, committed_at: now() });
    return { claims, signature: await signObject(await privateKey(), 'qbo-broker/1/receipt', claims) };
  }

  async function start() {
    if (!get('installation')) return refuse(403);
    const intent = await newIntent();
    return post(START, await makeSigned(START, {}, intent));
  }

  async function refresh() {
    const current = get('connection');
    if (!current || current.status !== 'connected' || get('fence') || lease) return refuse(409);
    observe('owner.refresh.due.checked');
    if (current.access_expires_at > now() + 600_000) return response({ protocol: PROTOCOL, status: 'connected' });
    if (current.refresh_expires_at <= now() || (current.hard_refresh_expires_at && current.hard_refresh_expires_at <= now())) return refuse(410);
    lease = true;
    try {
      const intent = await newIntent('refresh');
      const signed = await makeSigned(REFRESH, {}, intent);
      put('fence', { purpose: 'refresh', generation: current.token_generation, intent: intent.intent, outcome_unknown: true });
      observe('owner.refresh.fenced');
      const result = await post(REFRESH, signed);
      if (!result.ok) throw new Error('owner_refresh_failed');
      const envelope = await boundedJson(result, 32_768);
      const decoded = await decodeBoundEnvelope(envelope, 'refresh');
      const next = await encryptedConnection(decoded.payload, intent);
      put('connection', next);
      observe('owner.refresh.readback.attempted');
      if (faults.delete('owner.refresh.readback') || !same(get('connection'), next)) throw new Error('owner_refresh_readback_failed');
      readbackCount++;
      observe('owner.refresh.readback');
      const receipt = await deliveryReceipt(envelope.header, await sha256(envelope), 'committed_readback');
      const terminal = terminalIntent(intent, 'committed', receipt);
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        if (!same(storeTerminalIntent(terminal), terminal)) throw new Error('owner_intent_readback_failed');
        sqlite.exec('COMMIT');
      } catch { sqlite.exec('ROLLBACK'); throw new Error('owner_intent_commit_failed'); }
      sqlite.prepare('DELETE FROM state WHERE kind=?').run('fence');
      return response({ protocol: PROTOCOL, status: 'connected' });
    } catch {
      const retained = get('connection');
      if (retained) put('connection', { ...retained, status: 'reauthorization_required', schedule_enabled: false });
      return refuse(503);
    } finally { lease = false; }
  }

  async function disconnect(body) {
    let connection = get('connection');
    if (!connection || lease) return refuse(409);
    let fence = get('fence');
    const retry = body.retry_same_operation === true;
    if (fence && (!retry || fence.purpose !== 'revoke' || !fence.proof)) return refuse(409);
    lease = true;
    try {
      put('connection', { ...connection, status: 'disconnecting', schedule_enabled: false });
      observe('owner.schedule.disabled');
      const operation = fence ?? { purpose: 'revoke', generation: connection.token_generation, intent: randomCapability(), outcome_unknown: true };
      put('fence', operation);
      observe('owner.revoke.fenced');
      const signed = await makeSigned(REVOKE, retry ? { no_contact_proof: operation.proof } : {}, operation);
      const result = await post(REVOKE, signed);
      if (!result.ok) return refuse(503);
      const value = await boundedJson(result, 12_288);
      assertSchema('revokeResponse', value);
      if (value.request_id !== signed.request_id || value.intent !== operation.intent ||
          value.install_fingerprint !== get('installation').fingerprint || value.token_generation !== connection.token_generation ||
          value.key_generation !== get('installation').key_generation || value.issued_at > now() + 30_000) return refuse(403);
      if (value.provider_contact === 'not_sent') {
        const claims = value.no_contact_proof.claims;
        const unsignedBody = { ...signed.body }; delete unsignedBody.no_contact_proof;
        if (claims.request_id !== signed.request_id || claims.intent !== operation.intent ||
            claims.install_fingerprint !== get('installation').fingerprint || claims.token_generation !== connection.token_generation ||
            claims.key_generation !== get('installation').key_generation || claims.expires_at <= now() ||
            claims.operation_hash !== await sha256(unsignedBody)) return refuse(403);
        put('fence', { ...operation, proof: value.no_contact_proof, no_contact_proof_verified: true });
        put('connection', { ...get('connection'), status: 'disconnected' });
        return response({ protocol: PROTOCOL, status: 'disconnected' });
      }
      connection = get('connection');
      connection.status = 'disconnected';
      connection.remote_revocation = value.outcome;
      if (value.outcome === 'confirmed') {
        for (const field of ['access_token', 'refresh_token', 'realm_id']) delete connection[field];
        sqlite.prepare('DELETE FROM state WHERE kind=?').run('fence');
      }
      put('connection', connection);
      return response({ protocol: PROTOCOL, status: 'disconnected', remote_revocation: value.outcome });
    } catch { return refuse(503); }
    finally { lease = false; }
  }

  async function fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin || url.search || url.hash) return refuse(400);
      if (url.pathname === CHALLENGE && request.method === 'GET') {
        if (!pendingEnrollment || pendingEnrollment.consumed || pendingEnrollment.challenge.expires_at <= now() ||
            request.headers.get('authorization') !== `Bearer ${pendingEnrollment.challenge.challenge}`) return refuse(403);
        return response(pendingEnrollment.challenge);
      }
      if (url.pathname === VOUCHER && request.method === 'POST') return await receiveVoucher(request);
      if (url.pathname === CALLBACK && request.method === 'POST') return await receiveEnvelope(request);
      if (!authenticated(request)) return refuse(401);
      if (request.method === 'GET' && url.pathname === '/api/quickbooks/status') {
        try { expirePendingIntents(); return response(inspect()); }
        catch { return refuse(503); }
      }
      if (request.method !== 'POST') return refuse(405);
      // Owner requests in these probes use ordinary JSON, while the broker wire
      // writer always emits canonical bytes. Exact key checks guard controls.
      const body = await request.json();
      if (url.pathname === '/api/quickbooks/connect/start' && empty(body)) return await start();
      if (url.pathname === '/api/quickbooks/refresh' && empty(body)) return await refresh();
      if (url.pathname === '/api/quickbooks/disconnect' && (empty(body) ||
          same(body, { retry_same_operation: true }))) return await disconnect(body);
      return refuse(400);
    } catch (error) { return refuse(error?.status === 413 ? 413 : 400); }
  }

  function inspect() {
    const connection = get('connection');
    const fence = get('fence');
    const intent = get('last_intent') && intentGet(get('last_intent').intent);
    const intentCounts = sqlite.prepare(`SELECT
      count(CASE WHEN json_extract(value, '$.status') = 'pending' THEN 1 END) AS pending,
      coalesce(sum((json_extract(value, '$.private_key') IS NOT NULL) +
        (json_extract(value, '$.auth_key') IS NOT NULL)), 0) AS keys FROM intents`).get();
    return {
      status: connection?.status ?? 'disconnected', intentStatus: intent?.status ?? null,
      intentKeyCount: ['private_key', 'auth_key'].filter(key => intent?.[key] != null).length,
      pendingIntentCount: intentCounts.pending, temporaryIntentKeyCount: intentCounts.keys,
      enrollmentReadbackAttemptCount, intentExpiryReadbackCount, intentExpiryReadbackAttemptCount,
      tokenGeneration: connection?.token_generation ?? 0,
      tokenCiphertextCount: ['access_token', 'refresh_token', 'realm_id'].filter(key => connection?.[key]).length,
      connectionCommitCount: commitCount, connectionReadbackCount: readbackCount,
      scheduleEnabled: connection?.schedule_enabled ?? false,
      readsEnabled: connection?.status === 'connected' && !fence,
      importedRecordCount: sqlite.prepare('SELECT count(*) AS count FROM imported_records').get().count,
      outcomeUnknown: fence?.outcome_unknown ?? false, remoteRevocation: connection?.remote_revocation ?? null,
      fenceFingerprint: fence ? createHash('sha256').update(canonical(fence)).digest('hex') : null,
      noContactProofVerified: fence?.no_contact_proof_verified ?? false,
    };
  }

  async function runScheduledRead() {
    if (!get('connection')?.schedule_enabled) return false;
    return runDirectRead();
  }

  async function runDirectRead() {
    const connection = get('connection');
    if (connection?.status !== 'connected' || get('fence')) return false;
    const realm = await credential('realm_id');
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(realm) || await companyFingerprint(realm) !== connection.company_fingerprint) throw new Error('owner_company_refused');
    const url = new URL(`/v3/company/${realm}/query`, apiOrigins[connection.environment]);
    url.searchParams.set('query', 'SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 1000');
    const result = await transport(new Request(url, {
      method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${await credential('access_token')}`, accept: 'application/json' },
    }));
    if (!result.ok) throw new Error('owner_read_unavailable');
    // The test fixture proves routing only. It does not import returned records.
    await result.arrayBuffer();
    return true;
  }

  return {
    fetch, authHeaders, prepareEnrollment, inspect, runScheduledRead, runDirectRead,
    // Private fixture inspection reads stored bytes without adding them to the
    // owner status route or broker privacy snapshot.
    inspectIntents: () => sqlite.prepare('SELECT value FROM intents ORDER BY intent').all().map(row => JSON.parse(row.value)),
    signedRequest: async ({ route, bodyOverrides = {} }) => new Request(BROKER + route, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
      body: canonical(await makeSigned(route, bodyOverrides)),
    }),
  };
}
