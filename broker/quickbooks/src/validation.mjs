import { BrokerRefusal, canonical, decode64, refuse } from './crypto.mjs';
import { schema } from './protocol-schema.mjs';

const binary = new Set(['ciphertext', 'iv', 'salt', 'authentication_tag', 'broker_authentication_tag', 'mac']);
const types = new Set(['object', 'array', 'integer', 'null', 'string', 'boolean']);
const keywords = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'uniqueItems', 'x-private']);
function resolve(ref) {
  if (!/^#\/\$defs\/[A-Za-z][A-Za-z0-9]*$/.test(ref) || !Object.hasOwn(schema.$defs, ref.slice(8))) refuse();
  return schema.$defs[ref.slice(8)];
}
function inspect(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  for (const key of Object.keys(value)) if (!keywords.has(key)) refuse();
  if (value.$ref) resolve(value.$ref);
  if ('x-private' in value) {
    if (value['x-private'] !== true) refuse();
    let leaf = value;
    while (leaf.$ref) leaf = resolve(leaf.$ref);
    if (leaf.type !== 'string') refuse();
  }
  if (value.type && !types.has(value.type)) refuse();
  if (value.type === 'object' && (value.additionalProperties !== false || !value.properties || !value.required)) refuse();
  for (const child of Object.values(value.$defs ?? {})) inspect(child);
  for (const child of Object.values(value.properties ?? {})) inspect(child);
  for (const field of ['allOf', 'anyOf', 'oneOf']) for (const child of value[field] ?? []) inspect(child);
  if (value.items) inspect(value.items);
}
inspect(schema);

function matches(rule, value, depth = 0) {
  if (depth > 32) return false;
  if (rule.$ref) {
    if (!matches(resolve(rule.$ref), value, depth + 1)) return false;
    const name = rule.$ref.slice(8);
    if (['capability', 'digest', 'signature'].includes(name)) {
      try {
        const bytes = decode64(value, name === 'digest' ? 32 : name === 'signature' ? 64 : undefined);
        if (name === 'capability' && bytes.length < 32) return false;
      } catch { return false; }
    }
  }
  if ('const' in rule && canonical(rule.const) !== canonical(value)) return false;
  if (rule.enum && !rule.enum.some(item => canonical(item) === canonical(value))) return false;
  if (rule.oneOf && rule.oneOf.filter(child => matches(child, value, depth + 1)).length !== 1) return false;
  if (rule.anyOf && !rule.anyOf.some(child => matches(child, value, depth + 1))) return false;
  if (rule.allOf && !rule.allOf.every(child => matches(child, value, depth + 1))) return false;
  if (rule.type) {
    const okay = rule.type === 'object' ? value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
      : rule.type === 'array' ? Array.isArray(value) : rule.type === 'integer' ? Number.isSafeInteger(value) && !Object.is(value, -0)
        : rule.type === 'null' ? value === null : typeof value === rule.type;
    if (!okay) return false;
  }
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value)) return false;
    const length = [...value].length;
    if (rule.minLength !== undefined && length < rule.minLength) return false;
    if (rule.maxLength !== undefined && length > rule.maxLength) return false;
    if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) return false;
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || Object.is(value, -0) ||
    (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) return false;
  if (rule.type === 'object') {
    if (rule.required.some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(rule.properties, key) || !matches(rule.properties[key], child, depth + 1)) return false;
      if (typeof child === 'string' && binary.has(key)) { try { decode64(child); } catch { return false; } }
    }
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) return false;
    if (rule.maxItems !== undefined && value.length > rule.maxItems) return false;
    if (rule.items && !value.every(item => matches(rule.items, item, depth + 1))) return false;
    if (rule.uniqueItems && new Set(value.map(canonical)).size !== value.length) return false;
  }
  return true;
}
export function assertSchema(name, value) {
  try {
    canonical(value);
    if (!Object.hasOwn(schema.$defs, name) || !matches({ $ref: '#/$defs/' + name }, value)) refuse();
    return value;
  } catch { refuse(); }
}

// Duplicate keys are refused before an object exists; JSON.parse alone loses
// that evidence. Depth and byte limits bound the work before schema traversal.
export function parseStrictJson(text, { canonicalRequired = true } = {}) {
  let offset = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(text[offset] ?? '') && offset < text.length) offset++; };
  function string() {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '\\') { offset++; continue; }
      if (char === '"') {
        let result;
        try { result = JSON.parse(text.slice(start, offset)); } catch { refuse(); }
        if (/[\uD800-\uDFFF]/u.test(result)) refuse();
        return result;
      }
    }
    refuse();
  }
  function value(depth = 0) {
    if (depth > 24) refuse();
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '{') {
      offset++;
      const result = {};
      const seen = new Set();
      whitespace();
      if (text[offset] === '}') { offset++; return result; }
      for (;;) {
        whitespace();
        if (text[offset] !== '"') refuse();
        const key = string();
        if (seen.has(key)) refuse();
        seen.add(key);
        whitespace();
        if (text[offset++] !== ':') refuse();
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') refuse();
      }
    }
    if (char === '[') {
      offset++;
      const result = [];
      whitespace();
      if (text[offset] === ']') { offset++; return result; }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === ']') return result;
        if (delimiter !== ',') refuse();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset));
    if (!number) refuse();
    offset += number[0].length;
    const result = Number(number[0]);
    if (!Number.isSafeInteger(result) || Object.is(result, -0)) refuse();
    return result;
  }
  try {
    const result = value();
    whitespace();
    if (offset !== text.length || (canonicalRequired && canonical(result) !== text)) refuse();
    return result;
  } catch { refuse(); }
}

export async function readBoundedText(request, { maxBytes = 12288, contentType } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768) refuse();
  if (contentType && request.headers.get('content-type') !== contentType) refuse('invalid_request', 415);
  if (request.headers.has('content-encoding')) refuse('invalid_request', 415);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) refuse('invalid_request', 413);
  const reader = request.body?.getReader();
  if (!reader) refuse();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); refuse('invalid_request', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    // Preserve BOM bytes so the strict parser can refuse a noncanonical body.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    // Streams are an untrusted boundary too. A claimed error name is not proof
    // that its message or properties came from this module.
    refuse('invalid_request', error instanceof BrokerRefusal && error.status === 413 ? 413 : 400);
  }
}
export async function parseJson(request, { schema: name, maxBytes = 12288, canonicalRequired = true } = {}) {
  const text = await readBoundedText(request, { maxBytes, contentType: 'application/json' });
  const value = parseStrictJson(text, { canonicalRequired });
  return name ? assertSchema(name, value) : value;
}
function fields(encoded) {
  if (!encoded || new TextEncoder().encode(encoded).length > 12288) refuse();
  const result = {};
  try {
    for (const pair of encoded.split('&')) {
      const separator = pair.indexOf('=');
      if (separator < 1) refuse();
      const key = decodeURIComponent(pair.slice(0, separator).replaceAll('+', ' '));
      const value = decodeURIComponent(pair.slice(separator + 1).replaceAll('+', ' '));
      if (Object.hasOwn(result, key)) refuse();
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  } catch { refuse(); }
}
export async function parseLaunch(request) {
  const value = fields(await readBoundedText(request, { contentType: 'application/x-www-form-urlencoded' }));
  value.transaction = parseStrictJson(value.transaction ?? '');
  return assertSchema('launchRequest', value);
}
export function parseCallback(url) {
  if (!(url instanceof URL) || url.hash) refuse();
  return assertSchema('callbackQuery', fields(url.search.slice(1)));
}
export function assertWindow(value, now, maxMs = 60000) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(value?.issued_at) || !Number.isSafeInteger(value?.expires_at) ||
    value.issued_at < 0 || value.issued_at > now + 30000 || value.issued_at >= value.expires_at ||
    value.expires_at > value.issued_at + maxMs || now >= value.expires_at) refuse('expired', 410);
  return value;
}

export function validateCallback(value) {
  assertSchema('callback', value);
  let url;
  try { url = new URL(value); } catch { refuse('binding_mismatch', 403); }
  const host = url.hostname;
  const labels = host.split('.');
  if (url.href !== value || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
    value !== `https://${host}/api/quickbooks/connect/callback` || labels.length < 2 || host.length > 253 ||
    labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^[0-9.]+$/.test(host) || /(^|\.)(?:localhost|local|internal|home|lan)$/.test(host)) refuse('binding_mismatch', 403);
  return url;
}
function publicV4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 ||
      (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}
function publicV6(address) {
  // Accept only global-unicast space. Transition, documentation and special
  // allocation ranges remain refused, including all IPv4-mapped spellings.
  if (typeof address !== 'string' || !/^[0-9a-f:]+$/.test(address) || address.includes(':::')) return false;
  const halves = address.split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const size = left.length + right.length;
  if ((halves.length === 1 && size !== 8) || (halves.length === 2 && size >= 8)) return false;
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return false;
  const words = [...left, ...Array(halves.length === 2 ? 8 - size : 0).fill('0'), ...right].map(part => parseInt(part, 16));
  if ((words[0] & 0xe000) !== 0x2000 || words[0] === 0x2002 || (words[0] === 0x2001 && words[1] < 0x200) ||
    (words[0] === 0x2001 && words[1] === 0xdb8) || (words[0] === 0x3fff && words[1] < 0x1000)) return false;
  return true;
}
export async function resolveCallback(callback, resolve) {
  const url = validateCallback(callback);
  if (typeof resolve !== 'function') refuse('ledger_unavailable', 503);
  let answers;
  try { answers = await resolve(url.hostname); } catch { refuse('ledger_unavailable', 503); }
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 32 ||
    answers.some(address => typeof address !== 'string' || !(address.includes(':') ? publicV6(address) : publicV4(address)))) refuse('binding_mismatch', 403);
  return Object.freeze({ url, addresses: Object.freeze([...answers]) });
}
