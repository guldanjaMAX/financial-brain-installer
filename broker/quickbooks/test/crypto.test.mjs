import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { canonical, decode64, encode64, randomCapability, sha256, publicJwk, signObject,
  verifyObject, createBrokerCrypto, sealEnvelope, openEnvelope } from '../src/crypto.mjs';
import { assertSchema, parseJson, parseLaunch, parseCallback, validateCallback,
  resolveCallback, assertWindow } from '../src/validation.mjs';
import { schema } from '../src/protocol-schema.mjs';

const protocol = 'qbo-broker/1';
const keys = async (usage = 'ECDSA') => crypto.subtle.generateKey({ name: usage, namedCurve: 'P-256' }, true,
  usage === 'ECDSA' ? ['sign', 'verify'] : ['deriveBits']);
const secret = () => randomCapability();
const bad = /broker_refused/;

test('canonical bytes and binary spelling have passing controls and reject ambiguities', () => {
  assert.equal(canonical({ z: 1, a: { c: true, b: null } }), '{"a":{"b":null,"c":true},"z":1}');
  assert.equal(canonical('\ud83d\ude00'), '"\ud83d\ude00"');
  for (const value of [-0, NaN, 1.5, undefined, '\ud800', new Date()]) assert.throws(() => canonical(value), bad);
  const good = randomCapability();
  assert.ok(encode64(decode64(good, 32)) === good);
  for (const value of [good + '=', good.slice(0, -1), '!'.repeat(43)]) assert.throws(() => decode64(value, 32), bad);
  assert.throws(() => decode64('AB', 1), bad);
});

test('ES256 proves exact object, domain and public key without private key fields', async () => {
  const key = await keys();
  const other = await keys();
  const jwk = await publicJwk(key.publicKey);
  const object = { protocol, generation: 1, request_id: randomCapability() };
  const signature = await signObject(key.privateKey, protocol + '/request', object);
  assert.equal(await verifyObject(jwk, protocol + '/request', object, signature), true);
  assert.equal(await verifyObject(jwk, protocol + '/receipt', object, signature), false);
  assert.equal(await verifyObject(jwk, protocol + '/request', { ...object, generation: 2 }, signature), false);
  assert.equal(await verifyObject(await publicJwk(other.publicKey), protocol + '/request', object, signature), false);
  assert.equal(await verifyObject({ ...jwk, d: secret() }, protocol + '/request', object, signature), false);
});

test('one-secret voucher, hashes and sealed contexts bind role and generation', async () => {
  const clientSecret = secret();
  const service = createBrokerCrypto({ clientSecret, keyGeneration: 1 });
  const changed = createBrokerCrypto({ clientSecret, keyGeneration: 2 });
  const key = await keys();
  const claims = { protocol, voucher_id: randomCapability(), install_public_key: await publicJwk(key.publicKey),
    callback: 'https://owner.invalid/api/quickbooks/connect/callback', environment: 'sandbox',
    key_generation: 1, issued_at: 1000, expires_at: 61000 };
  const voucher = await service.mintVoucher(claims);
  assert.equal(await service.verifyVoucher(voucher, 2000), true);
  assert.equal(await service.verifyVoucher({ ...voucher, claims: { ...claims, environment: 'production' } }, 2000), false);
  assert.equal(await service.verifyVoucher(voucher, 61000), false);
  assert.equal(await changed.verifyVoucher(voucher, 2000), false);
  const capsule = await service.seal('launch', { protocol, value: secret() });
  assert.ok(canonical(await service.open('launch', capsule)) === canonical(await service.open('launch', capsule)));
  await assert.rejects(service.open('cookie', capsule), bad);
  await assert.rejects(changed.open('launch', capsule), bad);
  assert.notEqual(await service.hash('state', 'same'), await service.hash('request', 'same'));
  assert.notEqual(await service.hash('install', voucher), await changed.hash('install', voucher));
});

test('ECDH delivery authenticates sender before decryption and binds every header byte', async () => {
  const key = await keys('ECDH');
  const other = await keys('ECDH');
  const auth = secret();
  const tokenCanary = secret();
  const header = { protocol, purpose: 'connect', token_generation: 1 };
  const envelope = await sealEnvelope(header, { token: tokenCanary }, await publicJwk(key.publicKey), auth);
  assert.ok(canonical(await openEnvelope(envelope, key.privateKey, auth)) === canonical({ token: tokenCanary }));
  assert.ok(!JSON.stringify(envelope).includes(tokenCanary));
  await assert.rejects(openEnvelope(envelope, other.privateKey, auth), bad);
  await assert.rejects(openEnvelope(envelope, key.privateKey, secret()), bad);
  await assert.rejects(openEnvelope({ ...envelope, header: { ...header, token_generation: 2 } }, key.privateKey, auth), bad);
  await assert.rejects(openEnvelope({ ...envelope, broker_authentication_tag: secret() }, key.privateKey, auth), bad);

  // Removing sender verification keeps public-key decryption possible. The same
  // rejection invariant must fail against that actual changed implementation.
  const source = readFileSync(new URL('../src/crypto.mjs', import.meta.url), 'utf8');
  const marker = 'if (!await verifyHmac(senderKey, utf8(unsigned), envelope.broker_authentication_tag)) refuse();';
  assert.ok(source.includes(marker));
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(source.replace(marker, '')).toString('base64'));
  let killed = false;
  try { await assert.rejects(mutant.openEnvelope({ ...envelope, broker_authentication_tag: secret() }, key.privateKey, auth), bad); }
  catch (error) { killed = error.code === 'ERR_ASSERTION'; }
  assert.equal(killed, true, 'MISSING_SENDER_MAC is killed');
});

test('vendored closed catalog equals contract and refuses extra sensitive fields', () => {
  const expected = JSON.parse(readFileSync(new URL('../../../protocol/quickbooks-broker/v1/schemas/protocol.schema.json', import.meta.url)));
  assert.deepEqual(schema, expected);
  const control = { protocol, ready: true, build_id: 'synthetic-build', key_generation: 1, dependencies: { replay: true, quota: true } };
  // A primitive control avoids inventing health fields when the contract changes.
  assertSchema('protocol', protocol);
  assert.throws(() => assertSchema('publicKey', { kty: 'EC', crv: 'P-256', x: secret(), y: secret(), d: secret() }), bad);
  assert.throws(() => assertSchema('protocol', control), bad);
});

test('bounded parsing refuses duplicates, invalid UTF8, media changes, compression and oversized streams', async () => {
  const req = (body, contentType = 'application/json', extra = {}) => new Request('https://broker.invalid', {
    method: 'POST', headers: { 'content-type': contentType, ...extra }, body });
  assert.deepEqual(await parseJson(req('{"a":1}')), { a: 1 });
  for (const body of ['{"a":1,"a":2}', '{"z":1,"a":2}', '{"a":"\\ud800"}', '{"a":-0}']) await assert.rejects(parseJson(req(body)), bad);
  await assert.rejects(parseJson(req(new Uint8Array([0xff]))), bad);
  await assert.rejects(parseJson(req(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))), bad);
  await assert.rejects(parseJson(req('{}', 'application/json; charset=utf-8')), bad);
  await assert.rejects(parseJson(req('{}', 'application/json', { 'content-encoding': 'gzip' })), bad);
  await assert.rejects(parseJson(req(' '.repeat(12289))), bad);
  assert.deepEqual(await parseJson(req('{ "z": 1, "a": 2 }'), { canonicalRequired: false }), { z: 1, a: 2 });
});

test('a stream error cannot impersonate a local refusal or expose its canary message', async () => {
  const tokenCanary = secret();
  const read = body => parseJson(new Request('https://broker.invalid', { method: 'POST', duplex: 'half',
    headers: { 'content-type': 'application/json' }, body }));
  assert.deepEqual(await read('{"a":1}'), { a: 1 });
  const stream = new ReadableStream({ start(controller) {
    controller.error(Object.assign(new Error(tokenCanary), { name: 'BrokerRefusal', code: 'unauthorized' }));
  } });
  let safe = false;
  try { await read(stream); } catch (error) { safe = error.message === 'broker_refused'; }
  assert.equal(safe, true, 'stream exception must use a local fixed refusal');
});

test('launch and callback have exact keys and canonical encoded fields', async () => {
  const service = createBrokerCrypto({ clientSecret: secret(), keyGeneration: 1 });
  const transaction = await service.seal('launch', { protocol, value: secret() });
  const body = new URLSearchParams({ protocol, launch_capability: secret(), transaction: canonical(transaction) }).toString();
  const req = value => new Request('https://broker.invalid', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: value });
  assertSchema('launchRequest', await parseLaunch(req(body)));
  await assert.rejects(parseLaunch(req(body + '&protocol=qbo-broker%2F1')), bad);
  const query = new URL('https://broker.invalid/callback');
  query.search = new URLSearchParams({ state: secret(), code: secret(), realmId: 'synthetic.realm' });
  assertSchema('callbackSuccess', parseCallback(query));
  assert.throws(() => parseCallback(new URL(query.href + '&code=' + secret())), bad);
  assert.throws(() => parseCallback(new URL(query.href + '&extra=1')), bad);
});

test('callback URL and all DNS answers must be canonical public destinations', async () => {
  const good = 'https://owner.invalid/api/quickbooks/connect/callback';
  assert.equal(validateCallback(good).href, good);
  assert.deepEqual((await resolveCallback(good, async () => ['93.184.216.34'])).addresses, ['93.184.216.34']);
  for (const value of ['http://owner.invalid/api/quickbooks/connect/callback', good + '#x', good + '?x=1',
    'https://owner.invalid:443/api/quickbooks/connect/callback', 'https://127.0.0.1/api/quickbooks/connect/callback',
    'https://localhost/api/quickbooks/connect/callback', 'https://OWNER.invalid/api/quickbooks/connect/callback',
    'https://owner.invalid/a/../api/quickbooks/connect/callback', 'https://owner.invalid/api/quickbooks/connect/%63allback']) assert.throws(() => validateCallback(value), bad);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '192.0.2.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) {
    await assert.rejects(resolveCallback(good, async () => ['93.184.216.34', address]), bad);
  }
  assertWindow({ issued_at: 1000, expires_at: 61000 }, 2000);
  for (const value of [{ issued_at: 1000, expires_at: 61001 }, { issued_at: 40000, expires_at: 50000 }, { issued_at: 1000, expires_at: 2000 }]) assert.throws(() => assertWindow(value, 2000), bad);
});
