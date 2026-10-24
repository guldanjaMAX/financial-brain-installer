const PROTOCOL = 'qbo-broker/1';
const MAX_TIME = Number.MAX_SAFE_INTEGER;
const DAY_30 = 2592000000;
const MINUTE_20 = 1200000;
const DIGEST = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ROUTES = new Set(['/v1/quickbooks/installations/issue', '/v1/quickbooks/authorizations', '/v1/quickbooks/launch', '/v1/quickbooks/oauth/callback', '/v1/quickbooks/tokens/refresh', '/v1/quickbooks/tokens/revoke', '/health']);
const PHASES = new Set(['enrollment', 'start', 'launched', 'exchange_started', 'delivered', 'refresh_started', 'refreshed', 'revoke_started', 'revoked', 'failed', 'canceled', 'expired', 'not_sent', 'proof_consumed']);
const OUTCOMES = new Set(['accepted', 'delivered', 'refreshed', 'revoked', 'owner_canceled', 'invalid_request', 'unauthorized', 'expired', 'replayed', 'binding_mismatch', 'quota_exceeded', 'ledger_unavailable', 'provider_rejected', 'provider_uncertain', 'delivery_unconfirmed', 'receipt_invalid', 'wrapping_key_unavailable', 'reauthorization_required', 'no_provider_contact', 'local_destroyed_remote_unknown', 'failed', 'manual_provider_removal_required']);
const FIELDS = {
  event: ['protocol', 'event_id_hash', 'request_id_hash', 'route', 'install_fingerprint', 'intent_hash', 'state_hash', 'phase', 'outcome', 'http_status_class', 'build_id', 'key_generation', 'created_at', 'expires_at', 'duration_ms', 'attempt_count', 'retention_ms'],
  replay: ['protocol', 'route', 'request_id_hash', 'state_hash', 'intent_hash', 'install_fingerprint', 'phase', 'provider_attempts', 'key_generation', 'created_at', 'expires_at'],
  quota: ['protocol', 'route', 'subject_kind', 'subject_hash', 'window_start', 'window_ms', 'count', 'expires_at', 'retention_ms'],
  readiness: ['build_id', 'key_generation', 'ready', 'updated_at'],
};
const TABLES = { event: 'qbo_broker_events', replay: 'qbo_broker_replays', quota: 'qbo_broker_quotas' };
const TRANSITIONS = {
  enrollment: ['delivered', 'failed', 'expired'],
  start: ['launched', 'failed', 'expired', 'canceled'],
  launched: ['exchange_started', 'failed', 'expired', 'canceled'],
  exchange_started: ['delivered', 'failed'],
  refresh_started: ['refreshed', 'failed'],
  revoke_started: ['revoked', 'failed'],
};

export class BrokerStoreError extends Error {
  constructor(code) { super(code); this.name = 'BrokerStoreError'; this.code = code; }
}
const fail = code => { throw new BrokerStoreError(code); };
function integer(value, low = 0, high = MAX_TIME) { return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= low && value <= high; }
function digest(value, nullable = false) { return (nullable && value === null) || (typeof value === 'string' && DIGEST.test(value)); }
function exact(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function equal(left, right, fields) { return exact(left, fields) && fields.every(field => left[field] === right[field]); }

// The write boundary accepts only fixed metadata shapes; callers cannot smuggle
// raw failures or credentials into a JSON payload or an open text column.
export function validateBrokerRow(kind, row) {
  const fields = FIELDS[kind];
  if (!fields || !exact(row, fields)) fail('invalid_record');
  if (kind === 'readiness') {
    if (!digest(row.build_id) || !integer(row.key_generation, 1) || typeof row.ready !== 'boolean' || !integer(row.updated_at)) fail('invalid_record');
    return true;
  }
  if (row.protocol !== PROTOCOL || !ROUTES.has(row.route) || !integer(row.expires_at)) fail('invalid_record');
  if (kind === 'quota') {
    if (!['install', 'network', 'global'].includes(row.subject_kind) || !digest(row.subject_hash) || !integer(row.window_start) || !integer(row.window_ms, 1, 3600000) || !integer(row.count, 0, 1000000000) || !integer(row.retention_ms, 1, MINUTE_20) || row.expires_at <= row.window_start || row.expires_at > row.window_start + row.retention_ms) fail('invalid_record');
    return true;
  }
  if (!PHASES.has(row.phase) || !digest(row.request_id_hash, kind === 'event') || !digest(row.state_hash, true) || !digest(row.intent_hash, true) || !digest(row.install_fingerprint, kind === 'event') || !integer(row.key_generation, 1) || !integer(row.created_at) || row.expires_at <= row.created_at || row.expires_at > row.created_at + DAY_30) fail('invalid_record');
  if (kind === 'replay') {
    if (!integer(row.provider_attempts, 0, 1)) fail('invalid_record');
    if (['exchange_started', 'refresh_started', 'refreshed', 'revoke_started', 'revoked'].includes(row.phase) && row.provider_attempts !== 1) fail('invalid_record');
    if (['enrollment', 'start', 'launched', 'canceled', 'expired', 'not_sent', 'proof_consumed'].includes(row.phase) && row.provider_attempts !== 0) fail('invalid_record');
    if (['/v1/quickbooks/tokens/refresh', '/v1/quickbooks/tokens/revoke'].includes(row.route) && row.intent_hash === null) fail('invalid_record');
  } else if (!digest(row.event_id_hash) || !OUTCOMES.has(row.outcome) || !['2xx', '3xx', '4xx', '5xx'].includes(row.http_status_class) || !digest(row.build_id) || !integer(row.duration_ms, 0, 600000) || !integer(row.attempt_count, 0, 3) || !integer(row.retention_ms, 1, DAY_30) || row.expires_at > row.created_at + row.retention_ms) fail('invalid_record');
  return true;
}

export function createBrokerStore(db, { now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || typeof now !== 'function') fail('ledger_unavailable');
  const bind = (sql, values = []) => db.prepare(sql).bind(...values);
  const read = async (sql, values = []) => {
    try { return await bind(sql, values).first(); } catch { fail('ledger_unavailable'); }
  };
  const batch = async statements => {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length || results.some(result => result?.success === false)) fail('ledger_unavailable');
    return results;
  };
  const insert = (kind, row, suffix = '') => bind(`INSERT INTO ${TABLES[kind]} (${FIELDS[kind].join(',')}) VALUES (${FIELDS[kind].map(() => '?').join(',')})${suffix}`, FIELDS[kind].map(field => row[field]));
  const selectReplay = hash => bind('SELECT * FROM qbo_broker_replays WHERE request_id_hash = ?', [hash]);
  const checkResult = (result, row, kind) => {
    const found = result?.results;
    if (!Array.isArray(found) || found.length !== 1 || !equal(found[0], row, FIELDS[kind])) fail('ledger_unavailable');
    validateBrokerRow(kind, found[0]);
    return { ...found[0] };
  };
  async function duplicate(row) {
    const found = await read('SELECT request_id_hash FROM qbo_broker_replays WHERE request_id_hash = ? OR (state_hash IS NOT NULL AND state_hash = ?) OR (route = ? AND install_fingerprint = ? AND intent_hash = ? AND phase <> ? AND route IN (?,?)) LIMIT 1', [row.request_id_hash, row.state_hash, row.route, row.install_fingerprint, row.intent_hash, 'proof_consumed', '/v1/quickbooks/tokens/refresh', '/v1/quickbooks/tokens/revoke']);
    return Boolean(found);
  }
  function validateRate(item) {
    if (!exact(item, ['route', 'installFingerprint', 'since', 'limit']) || !ROUTES.has(item.route) || !digest(item.installFingerprint) || !integer(item.since) || !integer(item.limit, 1, 1000000000)) fail('invalid_record');
  }
  return {
    async recordEvent(row) {
      validateBrokerRow('event', row);
      try {
        const results = await batch([insert('event', row), bind('SELECT * FROM qbo_broker_events WHERE event_id_hash = ?', [row.event_id_hash])]);
        return checkResult(results[1], row, 'event');
      } catch { fail('ledger_unavailable'); }
    },
    async createReplay(row, { limits = [] } = {}) {
      validateBrokerRow('replay', row);
      if (!Array.isArray(limits) || limits.length > 4) fail('invalid_record');
      limits.forEach(validateRate);
      const guards = limits.map(() => '(SELECT COUNT(*) FROM qbo_broker_replays WHERE route = ? AND install_fingerprint = ? AND created_at >= ?) < ?');
      const values = [...FIELDS.replay.map(field => row[field]), ...limits.flatMap(item => [item.route, item.installFingerprint, item.since, item.limit])];
      const sql = `INSERT INTO qbo_broker_replays (${FIELDS.replay.join(',')}) SELECT ${FIELDS.replay.map(() => '?').join(',')}${guards.length ? ` WHERE ${guards.join(' AND ')}` : ''}`;
      let results;
      try { results = await batch([bind(sql, values), selectReplay(row.request_id_hash)]); }
      catch { if (await duplicate(row)) fail('replayed'); fail('ledger_unavailable'); }
      if (results[0]?.meta?.changes !== 1) fail('quota_exceeded');
      return checkResult(results[1], row, 'replay');
    },
    async getReplay(hash) {
      if (!digest(hash)) fail('invalid_record');
      const row = await read('SELECT * FROM qbo_broker_replays WHERE request_id_hash = ?', [hash]);
      if (row) validateBrokerRow('replay', row);
      return row ? { ...row } : null;
    },
    async getReplayByState(hash) {
      if (!digest(hash)) fail('invalid_record');
      const row = await read('SELECT * FROM qbo_broker_replays WHERE state_hash = ?', [hash]);
      if (row) validateBrokerRow('replay', row);
      return row ? { ...row } : null;
    },
    async transitionReplay(hash, expectedPhase, nextPhase, { providerAttempts } = {}) {
      if (!digest(hash) || !TRANSITIONS[expectedPhase]?.includes(nextPhase) || (providerAttempts !== undefined && !integer(providerAttempts, 0, 1))) fail('invalid_transition');
      const old = await this.getReplay(hash);
      if (!old || old.phase !== expectedPhase) fail('replayed');
      const attempts = providerAttempts ?? old.provider_attempts;
      if (attempts < old.provider_attempts || (nextPhase === 'exchange_started' && attempts !== 1)) fail('invalid_transition');
      const next = { ...old, phase: nextPhase, provider_attempts: attempts };
      validateBrokerRow('replay', next);
      let results;
      try {
        results = await batch([bind('UPDATE qbo_broker_replays SET phase = ?, provider_attempts = ? WHERE request_id_hash = ? AND phase = ? AND provider_attempts = ? AND expires_at > ?', [nextPhase, attempts, hash, expectedPhase, old.provider_attempts, now()]), selectReplay(hash)]);
      } catch { fail('ledger_unavailable'); }
      if (results[0]?.meta?.changes !== 1) fail('replayed');
      return checkResult(results[1], next, 'replay');
    },
    async consumeProof(originalHash, replacement, { limits = [] } = {}) {
      if (!digest(originalHash)) fail('invalid_record');
      validateBrokerRow('replay', replacement);
      if (!Array.isArray(limits) || limits.length > 4) fail('invalid_record');
      limits.forEach(validateRate);
      const original = await this.getReplay(originalHash);
      if (!original || original.phase !== 'not_sent' || original.provider_attempts !== 0) fail('replayed');
      if (replacement.route !== '/v1/quickbooks/tokens/revoke' || original.route !== replacement.route || original.install_fingerprint !== replacement.install_fingerprint || original.intent_hash !== replacement.intent_hash || original.key_generation !== replacement.key_generation || replacement.phase !== 'revoke_started' || replacement.provider_attempts !== 1) fail('invalid_transition');
      const consumed = { ...original, phase: 'proof_consumed' };
      const guards = limits.map(() => '(SELECT COUNT(*) FROM qbo_broker_replays WHERE route = ? AND install_fingerprint = ? AND created_at >= ?) < ?');
      const rateValues = limits.flatMap(item => [item.route, item.installFingerprint, item.since, item.limit]);
      let results;
      try {
        results = await batch([
          bind(`UPDATE qbo_broker_replays SET phase = 'proof_consumed' WHERE request_id_hash = ? AND phase = 'not_sent' AND provider_attempts = 0 AND expires_at > ?${guards.length ? ` AND ${guards.join(' AND ')}` : ''}`, [originalHash, now(), ...rateValues]),
          bind(`INSERT INTO qbo_broker_replays (${FIELDS.replay.join(',')}) SELECT ${FIELDS.replay.map(() => '?').join(',')} WHERE changes() = 1`, FIELDS.replay.map(field => replacement[field])),
          selectReplay(originalHash), selectReplay(replacement.request_id_hash),
        ]);
      } catch { if (await duplicate(replacement)) fail('replayed'); fail('ledger_unavailable'); }
      if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
        const latest = results[2]?.results?.[0];
        if (latest?.phase === 'not_sent' && latest.expires_at > now()) {
          for (const item of limits) {
            if (await this.countRequests({ route: item.route, installFingerprint: item.installFingerprint, since: item.since }) >= item.limit) fail('quota_exceeded');
          }
        }
        fail('replayed');
      }
      checkResult(results[2], consumed, 'replay');
      return checkResult(results[3], replacement, 'replay');
    },
    async admitQuota(entries) {
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) fail('invalid_record');
      const statements = [];
      for (const item of entries) {
        if (!exact(item, ['row', 'limit']) || !integer(item.limit, 1, 1000000000)) fail('invalid_record');
        validateBrokerRow('quota', item.row);
        if (item.row.count !== 0) fail('invalid_record');
        const row = { ...item.row, count: 1 };
        const readCounter = () => bind('SELECT * FROM qbo_broker_quotas WHERE route = ? AND subject_kind = ? AND subject_hash = ? AND window_start = ? AND window_ms = ?', [row.route, row.subject_kind, row.subject_hash, row.window_start, row.window_ms]);
        // NULL deliberately trips the NOT NULL constraint on exhaustion. D1
        // rolls back the entire batch, including earlier quota increments.
        // The pre-read lives inside that same transaction, so exact +1 readback
        // cannot race a concurrent admission or trust write metadata alone.
        statements.push(readCounter());
        statements.push(bind(`INSERT INTO qbo_broker_quotas (${FIELDS.quota.join(',')}) VALUES (${FIELDS.quota.map(() => '?').join(',')}) ON CONFLICT(route,subject_kind,subject_hash,window_start,window_ms) DO UPDATE SET count = CASE WHEN count < ? THEN count + 1 ELSE NULL END`, [...FIELDS.quota.map(field => row[field]), item.limit]));
        statements.push(readCounter());
      }
      let results;
      try { results = await batch(statements); }
      catch (error) {
        if (/NOT NULL constraint failed: qbo_broker_quotas\.count/.test(String(error?.message))) fail('quota_exceeded');
        fail('ledger_unavailable');
      }
      const rows = [];
      for (let index = 0; index < entries.length; index++) {
        const prior = results[index * 3]?.results;
        if (!Array.isArray(prior) || prior.length > 1) fail('ledger_unavailable');
        if (prior[0]) validateBrokerRow('quota', prior[0]);
        const expectedCount = (prior[0]?.count ?? 0) + 1;
        const found = results[index * 3 + 2]?.results?.[0];
        if (results[index * 3 + 1]?.meta?.changes !== 1 || !found || !integer(found.count, 1, entries[index].limit) || !equal(found, { ...entries[index].row, count: expectedCount }, FIELDS.quota)) fail('ledger_unavailable');
        validateBrokerRow('quota', found);
        rows.push({ ...found });
      }
      return rows;
    },
    async countRequests(item) {
      validateRate({ ...item, limit: 1 });
      const result = await read('SELECT COUNT(*) AS count FROM qbo_broker_replays WHERE route = ? AND install_fingerprint = ? AND created_at >= ?', [item.route, item.installFingerprint, item.since]);
      if (!integer(result?.count)) fail('ledger_unavailable');
      return result.count;
    },
    async providerCircuitAllows(route, { since, limit = 20 } = {}) {
      if (!ROUTES.has(route) || !integer(since) || !integer(limit, 1, 1000000000)) fail('invalid_record');
      const result = await read("SELECT COUNT(*) AS count FROM qbo_broker_events WHERE route = ? AND created_at >= ? AND outcome IN ('provider_rejected','provider_uncertain')", [route, since]);
      if (!integer(result?.count)) fail('ledger_unavailable');
      return result.count < limit;
    },
    async getReadiness() {
      const row = await read('SELECT build_id,key_generation,ready,updated_at FROM qbo_broker_readiness WHERE singleton = 1');
      if (!row) return null;
      if (row.ready !== 0 && row.ready !== 1) fail('ledger_unavailable');
      const record = { ...row, ready: row.ready === 1 };
      validateBrokerRow('readiness', record);
      return record;
    },
    async setReadiness(row) {
      validateBrokerRow('readiness', row);
      let results;
      try {
        results = await batch([bind('INSERT INTO qbo_broker_readiness (singleton,build_id,key_generation,ready,updated_at) VALUES (1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET build_id=excluded.build_id,key_generation=excluded.key_generation,ready=excluded.ready,updated_at=excluded.updated_at', [row.build_id, row.key_generation, row.ready ? 1 : 0, row.updated_at]), bind('SELECT build_id,key_generation,ready,updated_at FROM qbo_broker_readiness WHERE singleton = 1')]);
      } catch { fail('ledger_unavailable'); }
      const found = results[1]?.results?.[0];
      if (!found || (found.ready !== 0 && found.ready !== 1) || !equal({ ...found, ready: found.ready === 1 }, row, FIELDS.readiness)) fail('ledger_unavailable');
      return { ...row };
    },
    async inspectReadiness() { return this.getReadiness(); },
    async isVoucherRevoked(fingerprint) {
      if (!digest(fingerprint)) fail('invalid_record');
      return Boolean(await read("SELECT event_id_hash FROM qbo_broker_events WHERE install_fingerprint = ? AND route = '/v1/quickbooks/installations/issue' AND phase = 'revoked' AND outcome = 'revoked' AND expires_at > ? LIMIT 1", [fingerprint, now()]));
    },
    async cleanup({ limit = 100 } = {}) {
      if (!integer(limit, 1, 1000)) fail('invalid_record');
      let remaining = limit;
      let deleted = 0;
      for (const table of Object.values(TABLES)) {
        if (remaining === 0) break;
        let results;
        try { results = await batch([bind(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`, [now(), remaining])]); }
        catch { fail('ledger_unavailable'); }
        const count = results[0]?.meta?.changes;
        if (!integer(count, 0, remaining)) fail('ledger_unavailable');
        remaining -= count;
        deleted += count;
      }
      return deleted;
    },
    async inspect() {
      const output = {};
      for (const [kind, table] of Object.entries(TABLES)) {
        let result;
        try { result = await bind(`SELECT * FROM ${table} ORDER BY rowid`).all(); } catch { fail('ledger_unavailable'); }
        if (!Array.isArray(result?.results)) fail('ledger_unavailable');
        output[`${kind}s`] = result.results.map(row => { validateBrokerRow(kind, row); return { ...row }; });
      }
      return output;
    },
  };
}
