import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync,
  hkdfSync, randomBytes, sign, verify, diffieHellman, timingSafeEqual } from 'node:crypto';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const contract = () => read('../v1/wire-contract.json');
// A test fixture for the deliberately restricted canonical JSON domain. This
// never parses public input or signs a real request and is not exported.
function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('canonical_invalid');
    return String(value);
  }
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value)) throw new Error('canonical_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('canonical_invalid');
  return `{${Object.keys(value).sort().map(key => `${canonical(key)}:${canonical(value[key])}`).join(',')}}`;
}
const bytes = value => Buffer.from(canonical(value));
const hash = value => createHash('sha256').update(bytes(value)).digest('base64url');
const derive = (secret, label, generation = 1) => Buffer.from(hkdfSync('sha256', secret,
  Buffer.from(`qbo-broker/1:generation:${generation}`), Buffer.from(label), 32));

test('wire version and route schemas agree; no data route or recovery route exists', () => {
  const wire = contract();
  const schema = read('../v1/schemas/protocol.schema.json');
  const state = read('../v1/state-machine.json');
  assert.equal(wire.protocol, 'qbo-broker/1');
  assert.equal(schema.$defs.protocol.const, wire.protocol);
  assert.equal(state.protocol, wire.protocol);
  assert.equal(wire.routes.length, 7);
  for (const route of wire.routes) {
    for (const name of [route.request_schema, route.response_schema].filter(Boolean)) assert.ok(schema.$defs[name]);
    assert.ok(!route.path.includes('/v3/company/') && !route.path.includes('recovery'));
  }
  assert.equal(wire.limits.control_bytes, 12 * 1024);
  assert.equal(wire.limits.delivery_bytes, 32 * 1024);
  assert.equal(wire.limits.intent_ms, 600_000);
  assert.equal(wire.limits.launch_ms, 120_000);
});

test('canonical byte fixture is insertion-order independent and rejects ambiguous values', () => {
  contract();
  assert.equal(canonical({ z: 1, a: { c: true, b: null } }), '{"a":{"b":null,"c":true},"z":1}');
  assert.equal(canonical({ b: 'text', a: 1 }), canonical({ a: 1, b: 'text' }));
  for (const invalid of [NaN, Infinity, 1.5, -0, undefined, '\ud800', new Date()]) assert.throws(() => canonical(invalid), /canonical_invalid/);
  assert.equal(Buffer.byteLength(canonical('é')), 4, 'wire caps count UTF-8 bytes, not code units');
});

test('request ES256 proof binds route, timestamp, request ID, voucher and exact body hash', () => {
  const wire = contract();
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const request = { protocol: wire.protocol, method: 'POST', route: wire.routes[1].path,
    request_id: randomBytes(32).toString('base64url'), issued_at: 1, expires_at: 60_001,
    key_generation: 1, voucher: { claims: { environment: 'sandbox' }, mac: randomBytes(32).toString('base64url') },
    body: { environment: 'sandbox' } };
  request.body_hash = hash(request.body);
  const transcript = request => Buffer.concat([Buffer.from(`${wire.domains.request}\n`), bytes(request)]);
  const signature = sign('sha256', transcript(request), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  assert.equal(signature.length, 64);
  const authentic = request => request.body_hash === hash(request.body) && verify('sha256', transcript(request),
    { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  assert.equal(authentic(request), true);
  for (const patch of [{ route: wire.routes[4].path }, { method: 'GET' }, { issued_at: 2 },
    { request_id: randomBytes(32).toString('base64url') }, { key_generation: 2 },
    { body: { environment: 'production' } }, { voucher: { ...request.voucher, mac: randomBytes(32).toString('base64url') } }]) {
    assert.equal(authentic({ ...request, ...patch }), false);
  }
});

test('one-secret fixture derives distinct keys by role and invalidates prior generations', () => {
  const wire = contract();
  const syntheticSecret = randomBytes(32);
  const keys = Object.values(wire.broker_hkdf_labels).map(label => derive(syntheticSecret, label));
  assert.equal(new Set(keys.map(key => key.toString('hex'))).size, keys.length);
  for (const label of Object.values(wire.broker_hkdf_labels)) {
    assert.ok(derive(syntheticSecret, label).equals(derive(syntheticSecret, label)), 'deterministic control');
    assert.ok(!derive(syntheticSecret, label).equals(derive(syntheticSecret, label, 2)), 'generation binding');
    assert.ok(!derive(syntheticSecret, label).equals(derive(randomBytes(32), label)), 'root rotation binding');
  }
});

test('delivery fixture requires sender MAC, owner key and exact authenticated header', () => {
  const wire = contract();
  const owner = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sender = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const wrongOwner = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const authKey = randomBytes(32);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const header = { protocol: wire.protocol, purpose: 'connect', environment: 'sandbox', token_generation: 1 };
  const aesKey = (privateKey, publicKey) => Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), salt,
    Buffer.from(`${wire.domains.envelope}\n${canonical(header)}`), 32));
  const cipher = createCipheriv('aes-256-gcm', aesKey(sender.privateKey, owner.publicKey), iv);
  cipher.setAAD(bytes(header));
  const plaintext = randomBytes(32);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = { header, ephemeral_public_key: sender.publicKey.export({ format: 'jwk' }),
    salt: salt.toString('base64url'), iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'),
    authentication_tag: cipher.getAuthTag().toString('base64url') };
  const macKey = Buffer.from(hkdfSync('sha256', authKey, salt,
    Buffer.from(`${wire.domains.sender_auth}\n${canonical(header)}`), 32));
  const mac = input => createHmac('sha256', macKey).update(bytes(input)).digest();
  const senderMac = mac(envelope);
  const open = (input, privateKey = owner.privateKey, tag = senderMac) => {
    if (!timingSafeEqual(mac(input), tag)) throw new Error('sender_refused');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(privateKey, sender.publicKey), iv);
    decipher.setAAD(bytes(input.header));
    decipher.setAuthTag(Buffer.from(input.authentication_tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(input.ciphertext, 'base64url')), decipher.final()]);
  };
  assert.ok(open(envelope).equals(plaintext), 'authentic round trip');
  assert.throws(() => open(envelope, wrongOwner.privateKey));
  assert.throws(() => open(envelope, owner.privateKey, randomBytes(32)), /sender_refused/);
  assert.throws(() => open({ ...envelope, header: { ...header, environment: 'production' } }), /sender_refused/);
  assert.throws(() => open({ ...envelope, ciphertext: randomBytes(32).toString('base64url') }), /sender_refused/);
});
