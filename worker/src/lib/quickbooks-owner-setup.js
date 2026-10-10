/** Owner-only coordination; signed local receipts, never OAuth credentials. */
import { jsonResponse, privateNoStore } from './core.js';
import { sha256Hex } from './quickbooks-callback-crypto.js';

const stages = new Set(['preparing', 'owner_action', 'awaiting_intuit', 'keys_staged', 'connecting',
  'connected', 'import_pending', 'reconnect', 'revocation_uncertain', 'disconnected']);
const reply = (body, status = 200) => privateNoStore(jsonResponse(body, status));
const refused = (code, status) => reply({ error: 'QuickBooks setup needs attention', code }, status);
const exact = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) &&
  Object.keys(body).sort().join(',') === keys.sort().join(',');
const validTime = (value) => value === null || (Number.isSafeInteger(value) && value > 0);

export function setupProgressBytes(origin, installation, payload) {
  return new TextEncoder().encode(JSON.stringify(['quickbooks-owner-progress-v1', origin, installation,
    payload.operation_id, payload.sequence, payload.stage, payload.last_import_at, payload.next_check_at]));
}

async function boundedBody(request) {
  if (request.headers.get('content-type') !== 'application/json') throw new Error('json');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); throw new Error('size'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function safeStatus(row) {
  return { stage: row.stage, connected: ['connected', 'import_pending'].includes(row.stage),
    last_import_at: row.last_import_at, next_check_at: row.next_check_at, local_computer_required: true };
}

export async function handleQuickBooksOwnerSetup(env, request, {
  principal = null, adminAuthorized = false, now = Date.now(),
} = {}) {
  const url = new URL(request.url);
  const action = url.pathname.split('/').at(-1);
  if (request.method !== 'POST') return refused('quickbooks_setup_post_required', 405);
  // Only the local companion uses the separate admin pair route. The page
  // never receives that key. It claims the offered operation in its own
  // authenticated session, then accepts signed progress through that session.
  const pairRoute = url.pathname === '/api/oauth/quickbooks/setup/pair';
  if (action === 'pair' && (!pairRoute || !adminAuthorized)) return refused('admin_key_required', 403);
  if (action !== 'pair' && (principal?.kind !== 'owner' || principal.grantId !== null || principal.denied === true ||
      request.headers.get('X-Brain-App') !== '1' || request.headers.get('Origin') !== url.origin ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site')) return refused('quickbooks_owner_required', 403);
  if (url.protocol !== 'https:' || url.port) return refused('quickbooks_setup_origin_invalid', 403);
  if (!env.DB) return refused('quickbooks_setup_unavailable', 503);
  let body;
  try { body = await boundedBody(request); } catch { return refused('quickbooks_setup_body_invalid', 400); }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(body?.operation_id || '')) return refused('quickbooks_setup_operation_invalid', 400);
  try {
    if (action === 'pair') {
      if (!exact(body, ['operation_id', 'installation_fingerprint', 'public_key']) ||
          !/^[a-f0-9]{64}$/.test(body.installation_fingerprint) ||
          !exact(body.public_key, ['kty', 'crv', 'x', 'y', 'ext', 'key_ops']) ||
          body.public_key.kty !== 'EC' || body.public_key.crv !== 'P-256' ||
          body.public_key.key_ops?.join(',') !== 'verify') return refused('quickbooks_pair_invalid', 400);
      await crypto.subtle.importKey('jwk', body.public_key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const existing = await env.DB.prepare('SELECT operation_id FROM quickbooks_owner_setup WHERE operation_id = ?').bind(body.operation_id).first();
      if (existing) return refused('quickbooks_setup_replay', 409);
      // Bound cleanup, including abandoned offers; no unbounded table scan.
      await env.DB.prepare('DELETE FROM quickbooks_owner_setup WHERE operation_id IN (SELECT operation_id FROM quickbooks_owner_setup WHERE expires_at <= ? LIMIT 100)').bind(now).run();
      await env.DB.prepare(`INSERT INTO quickbooks_owner_setup(operation_id,origin,installation_fingerprint,public_key,expires_at)
        VALUES (?,?,?,?,?)`).bind(body.operation_id, url.origin, body.installation_fingerprint, JSON.stringify(body.public_key), now + 600_000).run();
      return reply({ stage: 'preparing', connected: false }, 201);
    }
    const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)brain_session=([^;]+)/)?.[1];
    if (!cookie) return refused('quickbooks_owner_required', 403);
    const ownerHash = await sha256Hex(cookie);
    const row = await env.DB.prepare('SELECT * FROM quickbooks_owner_setup WHERE operation_id = ?').bind(body.operation_id).first();
    if (!row || row.origin !== url.origin) return refused('quickbooks_pair_required', 409);
    if (row.expires_at <= now || row.revoked) return refused('quickbooks_pair_expired', 410);
    if (action === 'start') {
      if (!exact(body, ['operation_id'])) return refused('quickbooks_setup_body_invalid', 400);
      const won = await env.DB.prepare(`UPDATE quickbooks_owner_setup SET owner_session_hash = ?
        WHERE operation_id = ? AND owner_session_hash IS NULL AND expires_at > ? AND revoked = 0 RETURNING operation_id`)
        .bind(ownerHash, body.operation_id, now).first();
      return won ? reply(safeStatus(row)) : refused('quickbooks_setup_replay', 409);
    }
    if (row.owner_session_hash !== ownerHash) return refused('quickbooks_pair_required', 403);
    if (action === 'status' && exact(body, ['operation_id'])) return reply(safeStatus(row));
    if (action === 'cancel' && exact(body, ['operation_id'])) {
      await env.DB.prepare('UPDATE quickbooks_owner_setup SET revoked = 1 WHERE operation_id = ? AND owner_session_hash = ?')
        .bind(body.operation_id, ownerHash).run();
      return reply({ canceled: true, disconnected: false });
    }
    if (action !== 'progress' || !exact(body, ['operation_id', 'sequence', 'stage', 'last_import_at', 'next_check_at', 'signature']) ||
        !stages.has(body.stage) || !Number.isSafeInteger(body.sequence) || body.sequence < 1 ||
        !validTime(body.last_import_at) || !validTime(body.next_check_at) ||
        (body.last_import_at !== null && body.last_import_at > now) ||
        !/^[A-Za-z0-9_-]{86}$/.test(body.signature)) return refused('quickbooks_progress_invalid', 400);
    const key = await crypto.subtle.importKey('jwk', JSON.parse(row.public_key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signature = Uint8Array.from(atob(body.signature.replace(/-/g, '+').replace(/_/g, '/') + '=='), (c) => c.charCodeAt(0));
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature,
      setupProgressBytes(url.origin, row.installation_fingerprint, body))) return refused('quickbooks_pair_signature_invalid', 403);
    const won = await env.DB.prepare(`UPDATE quickbooks_owner_setup SET stage = ?, sequence = ?, last_import_at = ?, next_check_at = ?
      WHERE operation_id = ? AND owner_session_hash = ? AND sequence = ? AND expires_at > ? AND revoked = 0 RETURNING operation_id`)
      .bind(body.stage, body.sequence, body.last_import_at, body.next_check_at, body.operation_id, ownerHash, body.sequence - 1, now).first();
    if (!won) return refused('quickbooks_setup_replay', 409);
    return reply(safeStatus(body));
  } catch { return refused('quickbooks_setup_store_unavailable', 503); }
}
