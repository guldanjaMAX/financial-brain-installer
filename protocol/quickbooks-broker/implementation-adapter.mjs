// Offline integration glue. All broker decisions come from the package handler;
// the owner fixture executes cryptography and commits to its own SQLite store.
import { createBroker } from '../../broker/quickbooks/src/broker.mjs';
import { createBrokerStore } from '../../broker/quickbooks/src/store.mjs';
import { createSqliteD1 } from '../../broker/quickbooks/test/support/sqlite-d1.mjs';
import { canonical, randomCapability } from '../../broker/quickbooks/src/crypto.mjs';
import { createOwnerRuntime } from './testing/owner-runtime.mjs';
import { backup } from 'node:sqlite';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createProbeAdapter({ now, origins, brokerConfig, brokerFetch, ownerFetch, resolve, observe }) {
  const { db, sqlite } = createSqliteD1();
  const faults = new Set();
  const brokerLogs = [];
  const access = randomCapability();
  const buildId = randomCapability();
  let generation = 1;
  let broker;
  let pendingRestart = Promise.resolve();
  const owners = await Promise.all(origins.map(origin => createOwnerRuntime({
    origin, now, transport: ownerFetch, apiOrigins: brokerConfig.apiOrigins, observe, faults,
  })));

  function storeWithFaults() {
    const store = createBrokerStore(db, { now });
    return new Proxy(store, {
      get(target, property) {
        const method = target[property];
        if (typeof method !== 'function') return method;
        return (...args) => {
          if (property === 'admitQuota' && faults.delete('broker.quota.unavailable')) db.failNext('batch');
          if (property === 'createReplay' && args[0]?.route === '/v1/quickbooks/authorizations' &&
              faults.delete('broker.replay.unavailable')) db.failNext('batch');
          if (property === 'transitionReplay' && args[2] === 'exchange_started' &&
              faults.delete('broker.replay.commit')) db.failNext('batch');
          return method.apply(target, args);
        };
      },
    });
  }

  async function restartBroker() {
    const store = storeWithFaults();
    await store.setReadiness({ build_id: buildId, key_generation: generation, ready: true, updated_at: now() });
    broker = await createBroker({
      config: { ...brokerConfig, buildId, keyGeneration: generation, offline: true }, store,
      providerTransport: brokerFetch,
      // The in-memory transport binds the exact origin and never opens DNS or a
      // socket. A deployment must provide a reviewed transport that really pins.
      ownerTransport: (request, { addresses, hostname }) => {
        if (!Array.isArray(addresses) || addresses.length === 0 || new URL(request.url).hostname !== hostname)
          throw new Error('offline_destination_binding_refused');
        return brokerFetch(request);
      },
      resolve, now, observe, logEvent: event => brokerLogs.push(event),
      verifyAccess: async request => request.headers.get('authorization') === `Bearer ${access}`,
      beforeRevokeFence: async () => !faults.delete('broker.revoke.before_fence'),
    });
  }
  await restartBroker();

  return {
    broker: { fetch: async request => { await pendingRestart; return broker.fetch(request); } }, owners,
    fixtures: {
      async enroll({ owner, authorized = true, challengeValid = true, callback }) {
        const issue = await owners[owner].prepareEnrollment({ challengeValid, callback });
        return broker.fetch(new Request('https://broker.invalid/v1/quickbooks/installations/issue', {
          method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${access}` } : {}) },
          body: canonical(issue),
        }));
      },
      signedRequest: ({ owner, ...options }) => owners[owner].signedRequest(options),
    },
    inspect() {
      const events = sqlite.prepare('SELECT * FROM qbo_broker_events').all().map(row => ({ ...row }));
      const replays = sqlite.prepare('SELECT * FROM qbo_broker_replays').all().map(row => ({ ...row }));
      const quotas = sqlite.prepare('SELECT * FROM qbo_broker_quotas').all().map(row => ({ ...row }));
      return {
        brokerRows: [...events, ...replays, ...quotas], brokerLogs: [...brokerLogs],
        // Global deployment metadata is also exposed without projection. It is
        // distinct from the three lane 5 per-operation retention shapes.
        brokerReadiness: sqlite.prepare('SELECT * FROM qbo_broker_readiness').all().map(row => ({ ...row })),
        voucherIssueCount: events.filter(row => row.route === '/v1/quickbooks/installations/issue' && row.outcome === 'accepted').length,
        exchangeFences: replays.filter(row => row.state_hash !== null && row.provider_attempts === 1).length,
        owners: owners.map(owner => owner.inspect()),
      };
    },
    armFault(name) {
      if (name === 'broker.rotate_generation') {
        generation++;
        // Generation readiness must change together with its new handler. The
        // next fetch awaits this local restart; no stale instance is reused.
        pendingRestart = restartBroker();
      } else faults.add(name);
    },
    restartBroker,
    async inspectDatabase() {
      // This is a complete SQLite image, including free pages, for the privacy
      // gate. Scratch exists only in the operating-system temporary directory.
      const directory = await mkdtemp(join(tmpdir(), 'qbo-broker-image-'));
      const file = join(directory, 'broker.sqlite');
      try { await backup(sqlite, file); return await readFile(file); }
      finally { await unlink(file).catch(() => {}); await rmdir(directory).catch(() => {}); }
    },
    runScheduledRead: ({ owner }) => owners[owner].runScheduledRead(),
    runDirectRead: ({ owner }) => owners[owner].runDirectRead(),
  };
}
