import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { inspectSchema, validates, fixture } from './schema-test-helper.mjs';
import { quickBooksCompanyFingerprint } from '../../../connectors/quickbooks-online.mjs';

const catalog = JSON.parse(readFileSync(new URL('../v1/schemas/protocol.schema.json', import.meta.url), 'utf8'));
const opaque = length => randomBytes(Math.ceil(length * 3 / 4)).toString('base64url').slice(0, length);
const sample = name => fixture(catalog, name, opaque);
const check = (name, value, expected) => assert.equal(validates(catalog, name, value), expected, `schema ${name} decision`);
const roots = ['enrollmentChallenge', 'enrollmentIssue', 'installationVoucher', 'startRequest',
  'refreshRequest', 'revokeRequest', 'launchRequest', 'launchResponse', 'callbackQuery',
  'deliveryEnvelope', 'refreshResponse', 'tokenBundle', 'deliveryReceipt', 'revokeResponse',
  'noContactProof', 'auditEvent', 'replayRow', 'quotaRow', 'ownerIntent', 'ownerConnection',
  'ownerFence', 'ownerStatus', 'healthResponse', 'errorResponse', 'transactionPayload',
  'transactionCapsule', 'transactionCookie', 'enrollmentDelivery', 'ownerInstallation',
  'completionEnvelope', 'completionResult', 'completionReceipt', 'ownerCallbackRequest',
  'ownerCallbackReceipt'];

// Reviewed credential-bearing scalar sites. Shared capability/digest types also
// encode public bindings, so their use alone must not create a privacy grant.
const privateSites = [
  'storedCiphertext/properties/ciphertext',
  'enrollmentChallenge/properties/challenge',
  'enrollmentIssue/properties/challenge',
  'enrollmentDelivery/properties/challenge',
  'startBody/properties/delivery_auth_key',
  'refreshBody/properties/refresh_token',
  'refreshBody/properties/delivery_auth_key',
  'revokeBody/properties/token',
  'launchRequest/properties/launch_capability',
  'launchResponse/properties/launch_capability',
  'callbackSuccess/properties/state',
  'callbackSuccess/properties/code',
  'callbackDenied/properties/state',
  'deliveryEnvelope/properties/ciphertext',
  'refreshResponse/properties/ciphertext',
  'tokenBundle/properties/access_token',
  'tokenBundle/properties/refresh_token',
  'realmId',
  'transactionPayload/properties/state',
  'transactionPayload/properties/delivery_auth_key',
  'transactionCapsule/properties/ciphertext',
  'completionEnvelope/properties/ciphertext',
].map(path => '$defs/' + path).sort();
// These are reviewed non-credential fields, including public authentication
// metadata and recurring bindings. They still obey broker retention schemas.
// An unfamiliar name cannot silently classify itself as public.
const publicFields = new Set([
  'aad_hash', 'access_expires_at', 'attempt_count', 'authentication_tag', 'body',
  'body_hash', 'broker_authentication_tag', 'build_id', 'callback', 'claims',
  'committed_at', 'company_fingerprint', 'configuration', 'count', 'created_at',
  'crv', 'delivery_id', 'delivery_key_fingerprint', 'delivery_public_key',
  'dependencies', 'duration_ms', 'envelope_hash', 'environment',
  'ephemeral_public_key', 'error', 'event_id_hash', 'expected_token_generation',
  'expires_at', 'hard_refresh_expires_at', 'header', 'http_status_class',
  'install_fingerprint', 'install_public_key', 'intent', 'intent_hash',
  'issued_at', 'iv', 'key_generation', 'key_version', 'kty', 'last_api_read_at',
  'last_refresh_at', 'launch_capability_hash', 'lease_expires_at', 'lease_id',
  'mac', 'method', 'no_contact_proof', 'operation', 'operation_hash', 'outcome',
  'phase', 'protocol', 'provider_attempts', 'provider_configuration_hash',
  'provider_contact', 'purpose', 'reads_enabled', 'ready', 'receipt',
  'receipt_hash', 'received_at', 'refresh_expires_at', 'replay_ledger',
  'request_id', 'request_id_hash', 'retention_ms', 'retry', 'route', 'salt',
  'signature', 'source_binding', 'start_hash', 'state_hash', 'status',
  'subject_hash', 'subject_kind', 'token_generation', 'token_type',
  'transaction', 'voucher', 'voucher_id', 'window_ms', 'window_start', 'x', 'y',
]);
const privateName = /ciphertext|secret|private_key|(?:^|_)token$|capability$|^realm_?id$|^(state|challenge|code|delivery_auth_key)$/i;
const schemaAt = (root, path) => path.split('/').reduce((node, key) => node[key], root);

function assertPrivateSchema(root) {
  assert.equal(inspectSchema(root), true);
  const annotated = [];
  const resolve = schema => schema.$ref ? resolve(schemaAt(root, schema.$ref.slice(2))) : schema;
  function visit(schema, path = '') {
    if (schema['x-private'] === true) annotated.push(path);
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      const fieldPath = `${path}/properties/${name}`;
      if (fieldPath === '$defs/errorResponse/properties/code') {
        assert.equal(field.$ref, '#/$defs/outcome', 'public error code must remain a reviewed outcome');
      } else if (privateName.test(name)) {
        const target = resolve(field);
        // Encrypted owner records inherit the scalar marker once from their
        // common storage shape; their IVs and tags are not secret values.
        const leaf = field.$ref === '#/$defs/storedCiphertext' ? target.properties.ciphertext : target;
        assert.ok(field['x-private'] === true || leaf['x-private'] === true,
          'private schema field requires x-private');
      } else {
        assert.ok(publicFields.has(name), 'new schema field requires privacy classification review');
      }
      visit(field, fieldPath);
    }
    for (const [name, child] of Object.entries(schema.$defs ?? {})) visit(child, `$defs/${name}`);
    for (const kind of ['oneOf', 'anyOf', 'allOf']) {
      for (const [index, child] of (schema[kind] ?? []).entries()) visit(child, `${path}/${kind}/${index}`);
    }
    if (schema.items) visit(schema.items, `${path}/items`);
  }
  visit(root);
  assert.deepEqual(annotated.sort(), privateSites, 'private schema sites must match the reviewed inventory');
}

test('private schema fields carry reviewed scalar annotations through references', () => {
  assertPrivateSchema(catalog);
});

test('private schema classification refuses new names and malformed annotations', () => {
  assertPrivateSchema(catalog);
  for (const name of ['recovery_secret', 'unreviewed_value']) {
    const mutant = structuredClone(catalog);
    mutant.$defs.healthResponse.properties[name] = { type: 'string' };
    assert.throws(() => assertPrivateSchema(mutant), { code: 'ERR_ASSERTION' });
  }
  const notPrivate = structuredClone(catalog);
  notPrivate.$defs.refreshResponse.properties.ciphertext['x-private'] = false;
  assert.throws(() => inspectSchema(notPrivate), /schema_private_annotation_invalid/);
  const notScalar = structuredClone(catalog);
  notScalar.$defs.refreshResponse['x-private'] = true;
  assert.throws(() => inspectSchema(notScalar), /schema_private_annotation_not_string/);
});

test('PRIVATE_ANNOTATION_REMOVED mutant is killed at every reviewed site with a passing control', () => {
  assertPrivateSchema(catalog);
  for (const path of privateSites) {
    const mutant = structuredClone(catalog);
    delete schemaAt(mutant, path)['x-private'];
    assert.throws(() => assertPrivateSchema(mutant), { code: 'ERR_ASSERTION' });
  }
});

test('schema catalog is versioned, supported, and exact-key at every object boundary', () => {
  assert.equal(catalog.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(catalog.$id, 'urn:financial-brain:qbo-broker:1:schemas');
  assert.equal(inspectSchema(catalog), true);
  for (const name of roots) {
    const control = sample(name);
    check(name, control, true);
    check(name, { ...control, unexpected: opaque(43) }, false);
  }
});

test('schema helper refuses unsupported keywords and unresolved references', () => {
  assert.equal(inspectSchema(catalog), true);
  const unsupported = structuredClone(catalog);
  unsupported.$defs.auditEvent.format = 'custom';
  assert.throws(() => inspectSchema(unsupported), /schema_keyword_unsupported/);
  const missing = structuredClone(catalog);
  missing.$defs.auditEvent = { $ref: '#/$defs/absent' };
  assert.throws(() => inspectSchema(missing), /schema_ref_missing/);
});

test('signed requests reject wrong version, route, missing proof, and private delivery keys', () => {
  for (const name of ['startRequest', 'refreshRequest', 'revokeRequest']) {
    const control = sample(name);
    check(name, control, true);
    for (const changed of [
      { ...control, protocol: 'qbo-broker/0' },
      { ...control, route: '/v3/company/query' },
      { ...control, method: 'GET' },
      { ...control, signature: opaque(42) },
      { ...control, request_id: opaque(42) },
      { ...control, body_hash: opaque(44) },
      { ...control, key_generation: 0 },
    ]) check(name, changed, false);
    const missing = structuredClone(control);
    delete missing.signature;
    check(name, missing, false);
    if (name !== 'revokeRequest') {
      const privateKey = structuredClone(control);
      privateKey.body.delivery_public_key.d = opaque(43);
      check(name, privateKey, false);
    }
  }
});

test('launch and callback schemas reject short or long capabilities and ambiguous provider outcomes', () => {
  const launch = sample('launchRequest');
  check('launchRequest', launch, true);
  for (const length of [42, 129]) check('launchRequest', { ...launch, launch_capability: opaque(length) }, false);
  const callback = sample('callbackQuery');
  check('callbackQuery', callback, true);
  check('callbackQuery', { state: callback.state, error: 'access_denied' }, true);
  check('callbackQuery', { ...callback, error: 'access_denied' }, false);
  check('callbackQuery', { ...callback, error_description: opaque(43) }, false);
  check('callbackQuery', { ...callback, realmId: 'company invalid' }, false);
  check('callbackQuery', { state: callback.state }, false);
});

test('opaque realm and company fingerprint preserve the existing connector contract', () => {
  const realm = `fixture.${opaque(43)}~`;
  const company = quickBooksCompanyFingerprint(realm);
  assert.match(company, /^[a-f0-9]{64}$/);
  check('callbackQuery', { ...sample('callbackQuery'), realmId: realm }, true);
  check('tokenBundle', { ...sample('tokenBundle'), realm_id: realm, company_fingerprint: company }, true);
  check('tokenBundle', { ...sample('tokenBundle'), realm_id: `${realm} ` }, false);
  check('tokenBundle', { ...sample('tokenBundle'), company_fingerprint: opaque(43) }, false);
});

test('launch carries sealed context and cookie-sized ciphertext without durable callback storage', () => {
  for (const name of ['launchRequest', 'launchResponse']) {
    const control = sample(name);
    check(name, control, true);
    assert.ok(control.transaction, 'sealed transaction is required');
    const missing = structuredClone(control);
    delete missing.transaction;
    check(name, missing, false);
    check(name, { ...control, transaction: { ...control.transaction, ciphertext: opaque(3501) } }, false);
  }
  const payload = sample('transactionPayload');
  check('transactionPayload', payload, true);
  check('transactionPayload', { ...payload, refresh_token: opaque(64) }, false);
  check('transactionPayload', { ...payload, code: opaque(43) }, false);
});

test('token and encrypted envelope schemas require replacement grant and correct cryptographic lengths', () => {
  const bundle = sample('tokenBundle');
  check('tokenBundle', bundle, true);
  const missing = structuredClone(bundle);
  delete missing.refresh_token;
  check('tokenBundle', missing, false);
  check('tokenBundle', { ...bundle, token_type: 'Basic' }, false);
  for (const name of ['deliveryEnvelope', 'refreshResponse']) {
    const envelope = sample(name);
    check(name, envelope, true);
    check(name, { ...envelope, iv: opaque(15) }, false);
    check(name, { ...envelope, authentication_tag: opaque(21) }, false);
    check(name, { ...envelope, ciphertext: opaque(40001) }, false);
    const wrongPurpose = structuredClone(envelope);
    wrongPurpose.header.purpose = name === 'deliveryEnvelope' ? 'refresh' : 'connect';
    check(name, wrongPurpose, false);
  }
});

test('token envelopes require sender proof from an operation-specific owner secret', () => {
  for (const name of ['startRequest', 'refreshRequest']) {
    const control = sample(name);
    check(name, control, true);
    assert.ok(control.body.delivery_auth_key, 'delivery sender key is required');
    const missing = structuredClone(control);
    delete missing.body.delivery_auth_key;
    check(name, missing, false);
  }
  for (const name of ['deliveryEnvelope', 'refreshResponse']) {
    const control = sample(name);
    check(name, control, true);
    assert.ok(control.broker_authentication_tag, 'sender authentication tag is required');
    const missing = structuredClone(control);
    delete missing.broker_authentication_tag;
    check(name, missing, false);
    check(name, { ...control, broker_authentication_tag: opaque(42) }, false);
  }
  const intent = sample('ownerIntent');
  check('ownerIntent', intent, true);
  assert.equal(typeof intent.delivery_auth_key, 'object', 'owner stores sender key encrypted');
  check('ownerIntent', { ...intent, delivery_auth_key: opaque(43) }, false);
});

test('verified completion can carry only a stable outcome and requires the same sender proof', () => {
  const result = sample('completionResult');
  check('completionResult', result, true);
  for (const outcome of ['owner_canceled', 'failed', 'manual_provider_removal_required']) {
    check('completionResult', { ...result, outcome }, true);
  }
  check('completionResult', { ...result, outcome: 'connected' }, false);
  check('completionResult', { ...result, refresh_token: opaque(43) }, false);
  check('completionResult', { ...result, provider_error: opaque(43) }, false);
  const envelope = sample('completionEnvelope');
  check('completionEnvelope', envelope, true);
  check('ownerCallbackRequest', envelope, true);
  check('ownerCallbackRequest', sample('deliveryEnvelope'), true);
  check('ownerCallbackRequest', sample('refreshResponse'), false);
  const missingTag = structuredClone(envelope);
  delete missingTag.broker_authentication_tag;
  check('completionEnvelope', missingTag, false);
  check('completionEnvelope', { ...envelope, header: { ...envelope.header, purpose: 'connect' } }, false);
  const receipt = sample('completionReceipt');
  check('completionReceipt', receipt, true);
  check('ownerCallbackReceipt', receipt, true);
  check('ownerCallbackReceipt', sample('deliveryReceipt'), true);
  check('completionReceipt', { ...receipt, claims: { ...receipt.claims, outcome: 'committed_readback' } }, false);
  const intent = sample('ownerIntent');
  check('ownerIntent', intent, true);
  check('ownerIntent', { ...intent, receipt }, true);
});

test('owner intent stores source reservation and expected generation for delivery comparison', () => {
  const intent = sample('ownerIntent');
  check('ownerIntent', intent, true);
  assert.ok(intent.source_binding, 'intent identifies the reserved source');
  assert.ok(intent.expected_token_generation, 'intent declares the expected generation');
  for (const key of ['source_binding', 'expected_token_generation']) {
    const missing = structuredClone(intent);
    delete missing[key];
    check('ownerIntent', missing, false);
  }
});

test('pending and saved owner intents require both encrypted delivery keys', () => {
  const pending = sample('ownerIntent');
  for (const status of ['pending', 'saved']) {
    const control = { ...pending, status };
    check('ownerIntent', control, true);
    for (const key of ['delivery_private_key', 'delivery_auth_key']) {
      const missing = { ...control };
      delete missing[key];
      check('ownerIntent', missing, false);
      check('ownerIntent', { ...control, [key]: null }, false);
    }
  }
});

test('terminal owner intents retain receipt replay material with delivery keys absent', () => {
  const pending = sample('ownerIntent');
  check('ownerIntent', pending, true);
  for (const status of ['committed', 'canceled', 'failed', 'expired']) {
    const receipt = status === 'expired' ? null
      : sample(status === 'committed' ? 'deliveryReceipt' : 'completionReceipt');
    if (receipt) {
      receipt.claims.intent = pending.intent;
      if (status !== 'committed') receipt.claims.outcome = status === 'canceled' ? 'owner_canceled' : 'failed';
    }
    // Terminal state is a replay receipt, not an encrypted-key tombstone.
    const control = {
      protocol: pending.protocol, intent: pending.intent, status,
      delivery_id: receipt?.claims.delivery_id ?? null,
      envelope_hash: receipt?.claims.envelope_hash ?? null, receipt,
    };
    check('ownerIntent', control, true);
    for (const key of ['delivery_private_key', 'delivery_auth_key']) {
      check('ownerIntent', { ...control, [key]: pending[key] }, false);
      check('ownerIntent', { ...control, [key]: null }, false);
    }
    for (const key of ['delivery_id', 'envelope_hash', 'receipt']) {
      const missing = { ...control };
      delete missing[key];
      check('ownerIntent', missing, false);
    }
    check('ownerIntent', { ...control, callback: pending.callback }, false);
    check('ownerIntent', { ...control, delivery_public_key: pending.delivery_public_key }, false);
    check('ownerIntent', { ...control, status: 'pending' }, false);
    check('ownerIntent', { ...control, status: 'saved' }, false);
  }
});

test('committed owner intent requires a complete token-delivery replay receipt', () => {
  const receipt = sample('deliveryReceipt');
  const control = {
    protocol: receipt.claims.protocol, intent: receipt.claims.intent, status: 'committed',
    delivery_id: receipt.claims.delivery_id, envelope_hash: receipt.claims.envelope_hash, receipt,
  };
  check('ownerIntent', control, true);
  for (const key of ['delivery_id', 'envelope_hash', 'receipt']) {
    check('ownerIntent', { ...control, [key]: null }, false);
  }
  check('ownerIntent', { ...control, delivery_id: null, envelope_hash: null, receipt: null }, false);
  check('ownerIntent', { ...control, receipt: sample('completionReceipt') }, false);
});

test('owner connection schema disables reads during reauthorization and disconnect', () => {
  const connection = sample('ownerConnected');
  for (const name of ['ownerConnected', 'ownerConnection']) {
    for (const status of ['connected', 'delayed']) {
      check(name, { ...connection, status, reads_enabled: true }, true);
      check(name, { ...connection, status, reads_enabled: false }, true);
    }
    for (const status of ['reauthorization_required', 'disconnecting']) {
      check(name, { ...connection, status, reads_enabled: false }, true);
      check(name, { ...connection, status, reads_enabled: true }, false);
    }
  }
});

test('owner status schema permits enabled reads only while connected or delayed', () => {
  const statusRecord = sample('ownerStatus');
  for (const status of ['connected', 'delayed']) {
    check('ownerStatus', { ...statusRecord, status, reads_enabled: true }, true);
    check('ownerStatus', { ...statusRecord, status, reads_enabled: false }, true);
  }
  for (const status of ['not_connected', 'connecting', 'reauthorization_required',
    'disconnecting', 'disconnected', 'local_destroyed_remote_unknown']) {
    check('ownerStatus', { ...statusRecord, status, reads_enabled: false }, true);
    check('ownerStatus', { ...statusRecord, status, reads_enabled: true }, false);
  }
});

test('signed start and sealed transaction preserve the owner target token generation', () => {
  const start = sample('startRequest');
  check('startRequest', start, true);
  assert.ok(start.body.expected_token_generation, 'signed start declares target generation');
  const missingStart = structuredClone(start);
  delete missingStart.body.expected_token_generation;
  check('startRequest', missingStart, false);
  const transaction = sample('transactionPayload');
  check('transactionPayload', transaction, true);
  assert.ok(transaction.expected_token_generation, 'sealed context preserves target generation');
  const missingTransaction = structuredClone(transaction);
  delete missingTransaction.expected_token_generation;
  check('transactionPayload', missingTransaction, false);
});

test('replay ledger can persist no-contact authority and its one-time consumption', () => {
  const replay = sample('replayRow');
  check('replayRow', replay, true);
  check('replayRow', { ...replay, phase: 'not_sent', provider_attempts: 0 }, true);
  check('replayRow', { ...replay, phase: 'proof_consumed', provider_attempts: 0 }, true);
  check('replayRow', { ...replay, phase: 'arbitrary_provider_error' }, false);
});

test('durable broker schemas cannot accept callback, provider identity, credentials, or payloads', () => {
  const forbidden = ['callback', 'callback_host', 'owner_name', 'company_name', 'email', 'realm_id',
    'company_fingerprint', 'token_fingerprint', 'access_token', 'refresh_token', 'ciphertext',
    'authorization_code', 'voucher', 'request_body', 'request_headers', 'provider_response',
    'error_description', 'stack', 'user_agent'];
  for (const name of ['auditEvent', 'replayRow', 'quotaRow']) {
    const control = sample(name);
    check(name, control, true);
    for (const key of forbidden) check(name, { ...control, [key]: opaque(43) }, false);
  }
  const event = sample('auditEvent');
  check('auditEvent', { ...event, outcome: opaque(43) }, false);
  check('auditEvent', { ...event, network_hash: opaque(43) }, false);
  const quota = sample('quotaRow');
  check('quotaRow', { ...quota, retention_ms: 1200001 }, false);
});

test('revoke distinguishes proof of no contact from attempted rejection and uncertainty', () => {
  const attempted = sample('revokeResponse');
  check('revokeResponse', attempted, true);
  for (const outcome of ['confirmed', 'rejected', 'uncertain']) check('revokeResponse', { ...attempted, outcome }, true);
  check('revokeResponse', { ...attempted, no_contact_proof: sample('noContactProof') }, false);
  check('revokeResponse', { ...attempted, provider_contact: 'not_sent' }, false);
  const rejected = { ...attempted, outcome: 'rejected', provider_contact: 'not_sent', no_contact_proof: sample('noContactProof') };
  check('revokeResponse', rejected, true);
  check('revokeResponse', { ...rejected, outcome: 'confirmed' }, false);
  check('revokeResponse', { ...rejected, outcome: 'uncertain' }, false);
});

test('refresh carries the owner realm and no-contact retry proof binds the original operation', () => {
  const refresh = sample('refreshRequest');
  check('refreshRequest', refresh, true);
  assert.ok(refresh.body.realm_id, 'refresh preserves owner realm');
  const missingRealm = structuredClone(refresh);
  delete missingRealm.body.realm_id;
  check('refreshRequest', missingRealm, false);
  const proof = sample('noContactProof');
  check('noContactProof', proof, true);
  assert.ok(proof.claims.operation_hash, 'proof binds original operation');
  const missingHash = structuredClone(proof);
  delete missingHash.claims.operation_hash;
  check('noContactProof', missingHash, false);
});

test('MUTANT AUDIT_EXTRA_FIELD is killed by the privacy contract with a passing control', () => {
  const control = sample('auditEvent');
  const probe = { ...control, refresh_token: opaque(64) };
  const privacyContract = schema => {
    assert.equal(validates(schema, 'auditEvent', control), true, 'audit control');
    assert.equal(validates(schema, 'auditEvent', probe), false, 'audit privacy refusal');
  };
  privacyContract(catalog);
  const mutant = structuredClone(catalog);
  mutant.$defs.auditEvent.additionalProperties = true;
  assert.equal(validates(mutant, 'auditEvent', probe), true, 'mutant reaches the weakened boundary');
  assert.throws(() => privacyContract(mutant), { code: 'ERR_ASSERTION' });
});
