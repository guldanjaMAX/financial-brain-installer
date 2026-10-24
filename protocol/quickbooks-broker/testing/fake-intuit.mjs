/**
 * In-memory provider double, never a broker or a real provider client.
 * Synthetic credentials exist only in this object's lifetime. Diagnostics expose
 * counters so tests can prove a refusal reached a guard without leaking inputs.
 */
import { randomBytes } from 'node:crypto';

const ROUTES = ['authorize', 'exchange', 'refresh', 'revoke', 'accounting'];
const FAULTS = ['loss_before', 'loss_after', 'reject', 'malformed', 'missing_refresh', 'changed_company', 'rate_limit', 'server_error'];
const ENTITIES = new Set(['Account', 'Customer', 'Vendor', 'Invoice', 'Payment', 'Bill', 'Purchase', 'JournalEntry', 'Deposit', 'Transfer', 'CreditMemo', 'BillPayment', 'Estimate', 'SalesReceipt', 'RefundReceipt']);
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const refusal = (status, error = 'invalid_request') => json({ error }, status);
const exact = (params, keys) => [...params.keys()].length === keys.length && keys.every((key) => params.getAll(key).length === 1);
const loss = () => Object.assign(new Error('Synthetic provider response unavailable'), { code: 'FAKE_TRANSPORT_LOSS' });

export function createFakeIntuit({ now = Date.now, lifetimes = {}, environment = 'sandbox', mutant = null } = {}) {
  if (typeof now !== 'function' || !['sandbox', 'production'].includes(environment) || ![null, 'reuse-code'].includes(mutant)) throw new TypeError('Invalid fake provider configuration');
  const durations = { codeMs: 600_000, accessMs: 3_600_000, refreshMs: 8_640_000_000, hardRefreshMs: 31_536_000_000, ...lifetimes };
  if (Object.keys(durations).length !== 4 || Object.values(durations).some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new TypeError('Invalid fake provider lifetimes');
  const opaque = (label = 'opaque') => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(label)) throw new TypeError('Invalid fake value label');
    return `fake-${label}-${randomBytes(32).toString('base64url')}`;
  };
  const company = () => `fake-company-${randomBytes(12).toString('hex')}`;
  const config = Object.freeze({
    clientId: opaque('app'), clientSecret: opaque('secret'), environment,
    redirectUri: 'https://broker.invalid/v1/quickbooks/oauth/callback',
    authorizationUrl: 'https://intuit.invalid/oauth2/authorize',
    tokenUrl: 'https://intuit.invalid/oauth2/token', revokeUrl: 'https://intuit.invalid/oauth2/revoke',
    apiOrigins: Object.freeze({ sandbox: 'https://sandbox-intuit.invalid', production: 'https://production-intuit.invalid' }),
  });
  const codes = new Map();
  const tokens = new Map();
  const queues = new Map(ROUTES.map((route) => [route, []]));
  const counts = {
    attempted: Object.fromEntries(ROUTES.map((route) => [route, 0])),
    reached: Object.fromEntries(ROUTES.map((route) => [route, 0])),
    mutated: { exchange: 0, refresh: 0, revoke: 0 },
    issuedPairs: 0, accountingReads: 0, deniedWrites: 0, deniedTargets: 0,
  };

  function issuePair(grant) {
    const accessToken = opaque('access');
    const refreshToken = opaque('refresh');
    const instant = now();
    grant.generation += 1;
    tokens.set(accessToken, { type: 'access', grant, generation: grant.generation, expiresAt: instant + durations.accessMs });
    tokens.set(refreshToken, { type: 'refresh', grant, generation: grant.generation, expiresAt: Math.min(instant + durations.refreshMs, grant.hardExpiresAt) });
    counts.issuedPairs += 1;
    // Real token replies need not echo company identity. The callback supplies it;
    // changed_company deliberately models a malicious/inconsistent optional echo.
    return {
      access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer',
      expires_in: Math.ceil(durations.accessMs / 1000),
      x_refresh_token_expires_in: Math.ceil(Math.min(durations.refreshMs, grant.hardExpiresAt - instant) / 1000),
      x_refresh_token_hard_expires_in: Math.ceil((grant.hardExpiresAt - instant) / 1000),
    };
  }

  function usable(record, type) {
    return record?.type === type && !record.grant.revoked && record.generation === record.grant.generation && record.expiresAt > now() && record.grant.hardExpiresAt > now();
  }

  function authorized(request) {
    return request.headers.get('authorization') === `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  }

  function authorize(url, selection) {
    const params = url.searchParams;
    if (!exact(params, ['response_type', 'client_id', 'redirect_uri', 'scope', 'state']) ||
        params.get('response_type') !== 'code' || params.get('client_id') !== config.clientId ||
        params.get('redirect_uri') !== config.redirectUri || params.get('scope') !== 'com.intuit.quickbooks.accounting' ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(params.get('state')) ||
        (selection.environment && selection.environment !== environment)) return refusal(400);
    const callback = new URL(config.redirectUri);
    callback.searchParams.set('state', params.get('state'));
    if (selection.consent === false) callback.searchParams.set('error', 'access_denied');
    else {
      const realmId = selection.realmId ?? company();
      if (!/^[A-Za-z0-9._~-]{1,128}$/.test(realmId)) return refusal(400);
      const code = opaque('code');
      codes.set(code, { realmId, environment, redirectUri: config.redirectUri, expiresAt: now() + durations.codeMs, consumed: false });
      callback.searchParams.set('code', code);
      callback.searchParams.set('realmId', realmId);
    }
    return new Response(null, { status: 302, headers: { location: callback.href } });
  }

  function exchange(fields) {
    if (!exact(fields, ['grant_type', 'code', 'redirect_uri'])) return refusal(400);
    const code = codes.get(fields.get('code'));
    if (!code || (code.consumed && mutant !== 'reuse-code') || code.expiresAt <= now() ||
        fields.get('redirect_uri') !== code.redirectUri || code.environment !== environment) return refusal(400, 'invalid_grant');
    code.consumed = true;
    counts.mutated.exchange += 1;
    return issuePair({ realmId: code.realmId, environment: code.environment, generation: 0, revoked: false, hardExpiresAt: now() + durations.hardRefreshMs });
  }

  function refresh(fields) {
    if (!exact(fields, ['grant_type', 'refresh_token'])) return refusal(400);
    const record = tokens.get(fields.get('refresh_token'));
    if (!usable(record, 'refresh')) return refusal(400, 'invalid_grant');
    counts.mutated.refresh += 1;
    return issuePair(record.grant);
  }

  function revoke(fields) {
    if (!exact(fields, ['token'])) return refusal(400);
    const record = tokens.get(fields.get('token'));
    if (!record) return refusal(400, 'invalid_token');
    // A repeated revocation is idempotent at the provider. The broker must still
    // fence it because a lost response does not prove whether contact occurred.
    if (!record.grant.revoked) { record.grant.revoked = true; counts.mutated.revoke += 1; }
    return json({});
  }

  function accounting(request, url) {
    if (request.method !== 'GET') { counts.deniedWrites += 1; return refusal(405); }
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) return refusal(401, 'invalid_token');
    const record = tokens.get(authorization.slice(7));
    const match = url.pathname.match(/^\/v3\/company\/([A-Za-z0-9._~-]{1,128})\/query$/);
    if (!usable(record, 'access') || !match || record.grant.realmId !== match[1] || config.apiOrigins[record.grant.environment] !== url.origin) return refusal(401, 'invalid_token');
    if (!exact(url.searchParams, ['query'])) return refusal(400);
    const query = url.searchParams.get('query').match(/^SELECT \* FROM ([A-Za-z]+) STARTPOSITION ([0-9]+) MAXRESULTS ([0-9]+)$/i);
    if (!query || !ENTITIES.has(query[1]) || !Number.isSafeInteger(Number(query[2])) || Number(query[2]) < 1 || Number(query[3]) < 1 || Number(query[3]) > 1000) return refusal(400);
    counts.accountingReads += 1;
    return json({ QueryResponse: { [query[1]]: [], startPosition: Number(query[2]), maxResults: 0 } });
  }

  async function dispatch(input, init, selection = {}) {
    let url; let request;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
          !['https://intuit.invalid', ...Object.values(config.apiOrigins)].includes(url.origin)) throw new TypeError();
      request = input instanceof Request && !init ? input : new Request(url, init);
    } catch { counts.deniedTargets += 1; return refusal(404); }
    let route; let fields;
    if (url.origin === 'https://intuit.invalid' && url.pathname === '/oauth2/authorize') {
      route = 'authorize';
      if (request.method !== 'GET') return refusal(405);
    } else if (Object.values(config.apiOrigins).includes(url.origin) && url.pathname.startsWith('/v3/company/')) route = 'accounting';
    else if (url.origin === 'https://intuit.invalid' && ['/oauth2/token', '/oauth2/revoke'].includes(url.pathname) && !url.search) {
      if (request.method !== 'POST') return refusal(405);
      const revoking = url.pathname === '/oauth2/revoke';
      if (request.headers.get('content-type') !== (revoking ? 'application/json' : 'application/x-www-form-urlencoded')) return refusal(415);
      const body = await request.text();
      if (Buffer.byteLength(body) > 12 * 1024) return refusal(413);
      if (revoking) {
        let parsed;
        try { parsed = JSON.parse(body); } catch { return refusal(400); }
        if (!parsed || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.token !== 'string') return refusal(400);
        fields = new URLSearchParams(parsed);
      } else fields = new URLSearchParams(body);
      route = revoking ? 'revoke' : fields.get('grant_type') === 'refresh_token' ? 'refresh' : fields.get('grant_type') === 'authorization_code' ? 'exchange' : null;
      if (!route) return refusal(400, 'unsupported_grant_type');
    } else { counts.deniedTargets += 1; return refusal(404); }

    counts.attempted[route] += 1;
    const fault = queues.get(route).shift();
    if (fault === 'loss_before') throw loss();
    counts.reached[route] += 1;
    if (fields && !authorized(request)) return refusal(401, 'invalid_client');
    if (fault === 'rate_limit') return json({ error: 'rate_limited' }, 429, { 'retry-after': '30' });
    if (fault === 'server_error') return refusal(503, 'temporarily_unavailable');
    if (fault === 'reject') return refusal(400, 'invalid_grant');
    let result = route === 'authorize' ? authorize(url, selection)
      : route === 'exchange' ? exchange(fields)
        : route === 'refresh' ? refresh(fields)
          : route === 'revoke' ? revoke(fields) : accounting(request, url);
    if (result instanceof Response && !result.ok && result.status !== 302) return result;
    if (fault === 'loss_after') throw loss();
    if (fault === 'malformed') return new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });
    if (!(result instanceof Response)) {
      if (fault === 'missing_refresh') delete result.refresh_token;
      if (fault === 'changed_company') result.realmId = company();
      result = json(result);
    }
    return result;
  }

  return Object.freeze({
    config, opaque, company,
    fetch: (input, init) => dispatch(input, init),
    queueFault(route, fault) {
      if (!ROUTES.includes(route) || !FAULTS.includes(fault) ||
          (['missing_refresh', 'changed_company'].includes(fault) && !['exchange', 'refresh'].includes(route))) throw new TypeError('Invalid fake provider fault');
      queues.get(route).push(fault);
    },
    snapshot: () => structuredClone(counts),
    async grant({ state = opaque('state'), realmId, consent = true, environment: selectedEnvironment = environment } = {}) {
      const url = new URL(config.authorizationUrl);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'com.intuit.quickbooks.accounting', state })) url.searchParams.set(key, value);
      const response = await dispatch(url, undefined, { realmId, consent, environment: selectedEnvironment });
      if (response.status !== 302) throw Object.assign(new Error('Synthetic consent was rejected'), { code: 'FAKE_AUTHORIZATION_REJECTED' });
      return { callback: new URL(response.headers.get('location')) };
    },
  });
}
