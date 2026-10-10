/** Owner-created private Intuit apps. All secret-bearing work is local. */
import { randomBytes } from 'node:crypto';
import { ownerAppError, quickBooksProductionRedirect, validateQuickBooksOwnerBinding } from '../connectors/quickbooks-owner-binding.mjs';
import { authorizeQuickBooksOwnerApp, finishQuickBooksOwnerAppAuthorization, buildProviderAuthorizationUrl } from '../connectors/provider-oauth.mjs';
import { createQuickBooksCallbackHandoff, openQuickBooksCallbackHandoff } from './quickbooks-callback-client.mjs';
import { sha256Hex } from '../worker/src/lib/quickbooks-callback-crypto.js';

export { ownerAppError };

export function quickBooksOwnerBindingFromManifest(m) {
  const config = m?.corpora?.quickbooks;
  if (config?.enabled !== true || config.environment !== 'production' || !config.owner_app) {
    throw ownerAppError('quickbooks_owner_app_required');
  }
  const app = config.owner_app;
  if (Object.keys(app).sort().join(',') !== 'app_id,company_fingerprint,installation_id,redirect_uri') {
    throw ownerAppError('quickbooks_owner_binding_invalid');
  }
  const origin = `https://${m.brain?.domain || ''}`;
  quickBooksProductionRedirect(origin);
  return validateQuickBooksOwnerBinding({ schema_version: 1, ...app, brain_origin: origin,
    environment: 'production', source: config.source || 'quickbooks' });
}

async function companionReady(binding, options) {
  // Only the locally installed, reviewed companion can provide this
  // capability. Neither manifest flags nor ambient client keys enable it.
  if (typeof options.companion?.assertReady !== 'function') throw ownerAppError('quickbooks_companion_required');
  try { await options.companion.assertReady(binding); }
  catch { throw ownerAppError('quickbooks_companion_unverified'); }
}

export async function setupQuickBooksOwnerApp(m, _manifestPath, flags = {}, options = {}) {
  if (flags['owner-app-setup'] !== true) throw ownerAppError('quickbooks_setup_flag_invalid');
  const binding = quickBooksOwnerBindingFromManifest(m);
  await companionReady(binding, options);
  if (typeof options.companion.prepare !== 'function') throw ownerAppError('quickbooks_transfer_unavailable');
  // The native host owns pairing, portal readback and the secret-bearing
  // transfer. This call carries metadata only and returns a closed receipt.
  let result;
  try { result = await options.companion.prepare(binding); }
  catch { throw ownerAppError('quickbooks_transfer_failed'); }
  if (result?.stage !== 'keys_staged' || result.connected !== false) throw ownerAppError('quickbooks_transfer_unverified');
  return { provider: 'quickbooks', stage: 'keys_staged', connected: false };
}

export async function connectQuickBooksOwnerApp(m, manifestPath, options = {}) {
  const binding = quickBooksOwnerBindingFromManifest(m);
  await companionReady(binding, options);
  if (typeof options.callbackTransport !== 'function' || typeof options.openImpl !== 'function') {
    throw ownerAppError('quickbooks_production_callback_unavailable');
  }
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const transport = async (action, payload) => {
    try { return await options.callbackTransport(action, payload); }
    catch { throw ownerAppError('quickbooks_callback_unavailable'); }
  };
  let intent, expected;
  const recovered = options.freshConsent === true ? null : await finishQuickBooksOwnerAppAuthorization(binding, options.storage || {}, (payload) => transport('finalize', payload));
  if (!recovered) await authorizeQuickBooksOwnerApp(binding, {
    storage: options.storage || {}, fetchImpl: options.fetchImpl, now,
    assertCredentialOwned: options.providerRecordLease?.assertOwned,
    receiveAuthorization: async ({ clientId }) => {
      const { privateKey, publicJwk } = await createQuickBooksCallbackHandoff();
      intent = { intent_id: randomBytes(32).toString('base64url'), state: randomBytes(32).toString('base64url'),
        claim_secret: randomBytes(32).toString('base64url'), source: binding.source, environment: 'production',
        client_id_fingerprint: await sha256Hex(clientId), expected_company_fingerprint: binding.company_fingerprint,
        recipient_public_jwk: publicJwk };
      const started = await transport('start', intent);
      if (started?.status !== 'pending' || started.callback_path !== '/api/oauth/quickbooks/callback' ||
          started.intent_fingerprint !== await sha256Hex(intent.intent_id) ||
          !Number.isSafeInteger(started.created_at) || !Number.isSafeInteger(started.expires_at) ||
          Math.abs(started.created_at - now()) > 60_000 || started.expires_at <= now() ||
          started.expires_at > started.created_at + 600_000) throw ownerAppError('quickbooks_intent_unverified');
      expected = { intent_fingerprint: started.intent_fingerprint, source: binding.source,
        environment: 'production', client_id_fingerprint: intent.client_id_fingerprint,
        expected_company_fingerprint: binding.company_fingerprint, created_at: started.created_at, expires_at: started.expires_at };
      const authorizationUrl = buildProviderAuthorizationUrl('quickbooks', {
        clientId, redirectUri: binding.redirect_uri, state: intent.state,
      });
      let openedBrowser = false;
      try { openedBrowser = await options.openImpl(authorizationUrl) === true; } catch { /* URL and native diagnostics stay local */ }
      if (!openedBrowser) throw ownerAppError('quickbooks_browser_unavailable');
      const identity = { intent_id: intent.intent_id, claim_secret: intent.claim_secret };
      for (let attempt = 0; attempt < 120 && now() < expected.expires_at; attempt++) {
        const status = await transport('status', identity);
        if (status?.status === 'received') {
          const claim = await transport('claim', identity);
          if (claim?.status !== 'received' || claim.intent_fingerprint !== expected.intent_fingerprint ||
              claim.expires_at !== expected.expires_at || now() >= expected.expires_at ||
              claim.callback_fingerprint !== await sha256Hex(JSON.stringify(claim.envelope))) {
            throw ownerAppError('quickbooks_claim_unverified');
          }
          const opened = await openQuickBooksCallbackHandoff({ privateKey, envelope: claim.envelope, expectedBinding: expected });
          return { ...opened, finalization: { ...identity, intent_fingerprint: expected.intent_fingerprint } };
        }
        if (status?.status !== 'pending') throw ownerAppError('quickbooks_callback_not_completed');
        await sleep(5_000);
      }
      throw ownerAppError('quickbooks_callback_timeout');
    },
  });
  if (!recovered) await finishQuickBooksOwnerAppAuthorization(binding, options.storage || {}, (payload) => transport('finalize', payload));
  const rebindRequired = m.operations?.quickbooks_schedule !== undefined;
  if (rebindRequired && options.deferQuickBooksRebind !== true) {
    if (typeof options.reregisterAfterManifestChange !== 'function') throw ownerAppError('quickbooks_schedule_rebind_required');
    await options.reregisterAfterManifestChange(manifestPath, options);
  }
  return { provider: 'quickbooks', connected: true, stage: 'import_pending', import_pending: true,
    ...(rebindRequired && options.deferQuickBooksRebind === true ? { schedule_rebind_required: true } : {}) };
}

export async function disconnectQuickBooksOwnerApp(m, _manifestPath, flags = {}, options = {}) {
  const binding = quickBooksOwnerBindingFromManifest(m);
  if (flags.plan === true) return { requires_confirmation: true, pause_reads: true, revoke_grant: true,
    clear_staged_keys: true, imported_documents_retained: true, source_company_binding_retained: true };
  if (flags.confirm !== true) throw ownerAppError('quickbooks_disconnect_confirmation_required');
  await companionReady(binding, options);
  const oauth = options.oauth || await import('../connectors/provider-oauth.mjs');
  await oauth.quickBooksOwnerAppStatus(binding, options.storage || {});
  let paused = false;
  try { paused = await options.companion.pauseAndVerify(binding) === true; } catch { /* no raw native diagnostics */ }
  if (!paused) throw ownerAppError('quickbooks_pause_unverified');
  let result;
  try {
    result = await oauth.disconnectProvider('quickbooks', { storage: options.storage || {},
      source: binding.source, environment: 'production', fetchImpl: options.fetchImpl });
  } catch { throw ownerAppError('quickbooks_revocation_uncertain'); }
  let verifiedPaused = false;
  try { verifiedPaused = await options.companion.verifyPaused(binding) === true; } catch { /* report only the safe state */ }
  if (!verifiedPaused) throw ownerAppError('quickbooks_pause_unverified');
  return { disconnected: true, remote_revoked: result.remote_revoked === true,
    imported_documents_retained: true, source_company_binding_retained: true, schedules_paused: true };
}
