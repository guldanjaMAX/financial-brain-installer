// Worker-compatible primitives. This module has no I/O, ambient credentials,
// durable cache or provider knowledge. Callers keep decrypted values transient.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const PROTOCOL = 'qbo-broker/1';
const roles = new Set(['launch', 'cookie', 'voucher', 'audit', 'quota', 'no_contact']);

export class BrokerRefusal extends Error {
  constructor(code = 'invalid_request', status = 400) {
    super('broker_refused');
    this.name = 'BrokerRefusal';
    this.code = code;
    this.status = status;
  }
}
export function refuse(code, status) { throw new BrokerRefusal(code, status); }

export function canonical(value, depth = 0) {
  if (depth > 24) refuse();
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) refuse();
    return String(value);
  }
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value)) refuse();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) refuse();
  return `{${Object.keys(value).sort().map(key => `${canonical(key, depth + 1)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
}
export const utf8 = value => encoder.encode(canonical(value));
const textBytes = value => encoder.encode(value);
const join = (...parts) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const transcript = (domain, value) => join(textBytes(domain + '\n'), utf8(value));
export function encode64(value) {
  let raw = '';
  for (const byte of new Uint8Array(value)) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decode64(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 50000) refuse();
  let decoded;
  try { decoded = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { refuse(); }
  if (encode64(decoded) !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) refuse();
  return decoded;
}
export const randomCapability = () => encode64(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = async value => encode64(await crypto.subtle.digest('SHA-256', utf8(value)));
export const digestText = async value => encode64(await crypto.subtle.digest('SHA-256', textBytes(value)));

function exactPublic(value) {
  if (!value || canonical(Object.keys(value).sort()) !== canonical(['crv', 'kty', 'x', 'y']) || value.kty !== 'EC' || value.crv !== 'P-256') refuse();
  decode64(value.x, 32);
  decode64(value.y, 32);
  return value;
}
export async function publicJwk(key) {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key);
  return exactPublic({ kty, crv, x, y });
}
export async function importPublic(value, algorithm = 'ECDSA') {
  try { return await crypto.subtle.importKey('jwk', exactPublic(value), { name: algorithm, namedCurve: 'P-256' }, false, algorithm === 'ECDSA' ? ['verify'] : []); }
  catch { refuse('unauthorized', 401); }
}
export async function signObject(privateKey, domain, value) {
  try { return encode64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, transcript(domain, value))); }
  catch { refuse('unauthorized', 401); }
}
export async function verifyObject(jwk, domain, value, signature) {
  try { return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importPublic(jwk), decode64(signature, 64), transcript(domain, value)); }
  catch { return false; }
}
async function derive(input, salt, info) {
  const material = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, material, 256));
}
async function hmac(key, value) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encode64(await crypto.subtle.sign('HMAC', imported, value));
}
async function verifyHmac(key, value, signature) {
  try {
    const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', imported, decode64(signature, 32), value);
  } catch { return false; }
}
async function encrypt(keyBytes, payload, aad) {
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, utf8(payload)));
    return { iv: encode64(iv), ciphertext: encode64(encrypted.subarray(0, -16)), authentication_tag: encode64(encrypted.subarray(-16)) };
  } catch { refuse(); }
}
async function decrypt(keyBytes, sealed, aad) {
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(sealed.iv, 12), additionalData: aad, tagLength: 128 }, key,
      join(decode64(sealed.ciphertext), decode64(sealed.authentication_tag, 16)));
    const text = decoder.decode(plaintext);
    const value = JSON.parse(text);
    if (canonical(value) !== text) refuse();
    return value;
  } catch { refuse('unauthorized', 401); }
}
export const encryptLocal = (keyBytes, payload, aad) => encrypt(keyBytes, payload, utf8(aad));
export const decryptLocal = (keyBytes, sealed, aad) => decrypt(keyBytes, sealed, utf8(aad));

export function createBrokerCrypto({ clientSecret, keyGeneration }) {
  if ((typeof clientSecret !== 'string' && !(clientSecret instanceof Uint8Array)) || !Number.isSafeInteger(keyGeneration) || keyGeneration < 1) refuse();
  const material = typeof clientSecret === 'string' ? textBytes(clientSecret) : clientSecret;
  if (material.length < 16) refuse();
  const key = role => {
    if (!roles.has(role)) refuse();
    return derive(material, textBytes(`${PROTOCOL}:generation:${keyGeneration}`), textBytes(`${PROTOCOL}/key/${role === 'no_contact' ? 'no-contact' : role}`));
  };
  const mac = async (role, domain, value) => hmac(await key(role), transcript(domain, value));
  const verifyMac = async (role, domain, value, signature) => verifyHmac(await key(role), transcript(domain, value), signature);
  return Object.freeze({
    hash: async (label, value) => {
      if (!new Set(['install', 'event', 'request', 'intent', 'state', 'launch', 'address']).has(label)) refuse();
      return hmac(await key(label === 'address' ? 'quota' : 'audit'), join(textBytes(label + '\n'), label === 'install' ? utf8(value) : textBytes(value)));
    },
    mac, verifyMac,
    mintVoucher: async claims => ({ claims, mac: await mac('voucher', `${PROTOCOL}/voucher`, claims) }),
    verifyVoucher: async (voucher, now) => {
      try {
        const c = voucher.claims;
        return Object.keys(voucher).length === 2 && c.protocol === PROTOCOL && c.key_generation === keyGeneration &&
          Number.isSafeInteger(c.issued_at) && Number.isSafeInteger(c.expires_at) && c.issued_at <= now + 30000 &&
          c.issued_at < c.expires_at && c.expires_at <= c.issued_at + 86400000 && now < c.expires_at &&
          await verifyMac('voucher', `${PROTOCOL}/voucher`, c, voucher.mac);
      } catch { return false; }
    },
    seal: async (role, payload) => {
      if (!['launch', 'cookie'].includes(role)) refuse();
      const sealed = await encrypt(await key(role), payload, transcript(`${PROTOCOL}/${role}`, { protocol: PROTOCOL, key_generation: keyGeneration }));
      return { key_generation: keyGeneration, ...sealed };
    },
    open: async (role, capsule) => {
      if (!['launch', 'cookie'].includes(role) || capsule.key_generation !== keyGeneration ||
        canonical(Object.keys(capsule).sort()) !== canonical(['authentication_tag', 'ciphertext', 'iv', 'key_generation'])) refuse('unauthorized', 401);
      return decrypt(await key(role), capsule, transcript(`${PROTOCOL}/${role}`, { protocol: PROTOCOL, key_generation: keyGeneration }));
    },
    sealEnvelope, openEnvelope,
  });
}

export async function sealEnvelope(header, payload, deliveryPublicKey, deliveryAuthKey) {
  try {
    const peer = await importPublic(deliveryPublicKey, 'ECDH');
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, ephemeral.privateKey, 256);
    const key = await derive(shared, salt, transcript(`${PROTOCOL}/envelope`, header));
    const unsigned = { header, ephemeral_public_key: await publicJwk(ephemeral.publicKey), salt: encode64(salt),
      ...await encrypt(key, payload, utf8(header)) };
    const senderKey = await derive(decode64(deliveryAuthKey, 32), salt, transcript(`${PROTOCOL}/sender-auth`, header));
    return { ...unsigned, broker_authentication_tag: await hmac(senderKey, utf8(unsigned)) };
  } catch { refuse('unauthorized', 401); }
}
export async function openEnvelope(envelope, privateKey, deliveryAuthKey) {
  try {
    const { broker_authentication_tag, ...unsigned } = envelope;
    const salt = decode64(envelope.salt, 32);
    const senderKey = await derive(decode64(deliveryAuthKey, 32), salt, transcript(`${PROTOCOL}/sender-auth`, envelope.header));
    if (!await verifyHmac(senderKey, utf8(unsigned), envelope.broker_authentication_tag)) refuse();
    const peer = await importPublic(envelope.ephemeral_public_key, 'ECDH');
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
    const key = await derive(shared, salt, transcript(`${PROTOCOL}/envelope`, envelope.header));
    return decrypt(key, envelope, utf8(envelope.header));
  } catch { refuse('unauthorized', 401); }
}
