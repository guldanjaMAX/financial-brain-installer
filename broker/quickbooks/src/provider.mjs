// The transport is supplied by the deployment boundary. This module has no
// generic URL operation and no ambient fetch fallback, even on failure.
import { assertSchema, parseJson } from './validation.mjs';

export const PROVIDER_ENDPOINTS = Object.freeze({
  authorizationUrl: 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
});
const OFFLINE_ENDPOINTS = Object.freeze({
  authorizationUrl: 'https://intuit.invalid/oauth2/authorize',
  tokenUrl: 'https://intuit.invalid/oauth2/token',
  revokeUrl: 'https://intuit.invalid/oauth2/revoke',
});
export function validateProviderConfig(config) {
  const endpoints = config?.offline === true ? OFFLINE_ENDPOINTS : PROVIDER_ENDPOINTS;
  if (!config || !['sandbox', 'production'].includes(config.environment) ||
      typeof config.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(config.clientId) ||
      typeof config.clientSecret !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(config.clientSecret) ||
      Object.entries(endpoints).some(([key, value]) => config[key] !== value) ||
      config.redirectUri !== (config.offline === true ? 'https://broker.invalid' : 'https://connect.financialbrain.ai') + '/v1/quickbooks/oauth/callback') {
    throw new Error('Invalid broker provider configuration');
  }
}
export async function companyFingerprint(realm) {
  assertSchema('realmId', realm);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`quickbooks-company-v1:${realm}`));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function createProvider({ config, transport, now }) {
  validateProviderConfig(config);
  if (typeof transport !== 'function' || typeof now !== 'function') throw new Error('Invalid broker provider configuration');
  const authorization = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
  async function send(path, body, contentType) {
    return transport(new Request(path, { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization, 'content-type': contentType, accept: 'application/json' }, body }));
  }
  async function tokens(fields, realm, generation) {
    let cleanupToken;
    try {
      assertSchema('realmId', realm);
      assertSchema('generation', generation);
      const response = await send(config.tokenUrl, new URLSearchParams(fields).toString(), 'application/x-www-form-urlencoded');
      // A redirect, server error or unreadable reply never proves noncontact.
      if (response.status === 400 || response.status === 401) return { outcome: 'provider_rejected' };
      if (!response.ok || response.redirected) return { outcome: 'provider_uncertain' };
      const value = await parseJson(response, { maxBytes: 32768, canonicalRequired: false });
      // Even an invalid replacement may contain a usable credential. Keep only
      // this transient cleanup capability so a failed connect can revoke it.
      cleanupToken = [value.refresh_token, value.access_token].find(token => typeof token === 'string' && token.length > 0 && token.length <= 4096);
      const instant = now();
      const expiry = seconds => {
        const result = instant + seconds * 1000;
        if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(result) || result <= instant) throw new Error('Invalid provider result');
        return result;
      };
      if (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' ||
          (value.realmId !== undefined && value.realmId !== realm)) throw new Error('Invalid provider result');
      const bundle = {
        protocol: 'qbo-broker/1', access_token: value.access_token, refresh_token: value.refresh_token,
        token_type: 'Bearer', realm_id: realm, company_fingerprint: await companyFingerprint(realm),
        token_generation: generation, received_at: instant,
        access_expires_at: expiry(value.expires_in), refresh_expires_at: expiry(value.x_refresh_token_expires_in),
        hard_refresh_expires_at: value.x_refresh_token_hard_expires_in === undefined ? null : expiry(value.x_refresh_token_hard_expires_in),
      };
      assertSchema('tokenBundle', bundle);
      if (bundle.hard_refresh_expires_at !== null && bundle.refresh_expires_at > bundle.hard_refresh_expires_at) throw new Error('Invalid provider result');
      return { outcome: 'accepted', bundle };
    } catch {
      // Never attach the caught exception: transports and parsers may carry tokens.
      return cleanupToken ? { outcome: 'provider_uncertain', cleanupToken } : { outcome: 'provider_uncertain' };
    }
  }
  return Object.freeze({
    exchange: (code, realm, generation) => tokens({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }, realm, generation),
    refresh: (token, realm, generation) => tokens({ grant_type: 'refresh_token', refresh_token: token }, realm, generation),
    async revoke(token) {
      try {
        const response = await send(config.revokeUrl, JSON.stringify({ token }), 'application/json');
        if (response.redirected) return 'uncertain';
        if (response.status === 200) return 'confirmed';
        if (response.status === 400 || response.status === 401) return 'rejected';
        return 'uncertain';
      } catch { return 'uncertain'; }
    },
  });
}
