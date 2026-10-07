import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import worker from '../src/index.js';

export const ANCHOR = Date.parse('2026-10-07T15:00:00Z');
export class Clock {
  ms = 0;
  pending = [];
  events = [];
  now = () => this.ms;
  operation(stage, duration, value, fail = false) {
    this.events.push({ stage, start: this.ms });
    return new Promise((resolve, reject) => this.pending.push({ at: this.ms + duration, run: () => {
      if (fail) reject(new Error('synthetic provider failure'));
      else resolve(value);
    } }));
  }
  async finish(promise) {
    let done = false, value, error;
    promise.then(v => { value = v; done = true; }, e => { error = e; done = true; });
    for (let turns = 0; turns < 10000 && !done; turns++) {
      for (let i = 0; i < 300; i++) await Promise.resolve();
      // Web Crypto authentication settles on the event loop, independently of
      // the fake providers. Let it finish without advancing the virtual clock.
      await new Promise(setImmediate);
      if (done) break;
      this.pending.sort((a, b) => a.at - b.at);
      const next = this.pending.shift();
      if (!next) continue;
      this.ms = next.at;
      next.run();
    }
    assert.ok(done, 'virtual scheduler completed');
    if (error) throw error;
    return value;
  }
}

export function fixture({ approve = true, answerMs = 7000, verifierMs = 4000,
  answerFails = false, verifierFails = false, empty = false, keywordFails = false,
  vectorFails = false, profile = 'technician' } = {}) {
  const clock = new Clock();
  const counts = { embedding: 0, keyword: 0, coverage: 0, vector: 0, answer: 0, verifier: 0, auth: 0 };
  const row = {
    chunk_uid: 'curated:fixture#0', doc_uid: 'curated:fixture', source: 'curated',
    source_kind: 'curated', source_id: 'fixture', title: 'Recorded threshold',
    text: 'The release threshold is seven units.', document_date: ANCHOR - 86400000,
    date_reliable: 1, date_source: 'fixture:recorded', text_source: 'native', text_reliable: 1,
  };
  const rows = empty ? [] : [row];
  const env = {
    STORAGE: 'd1', ADMIN_KEY: randomUUID(), RAG_PROXY_KEY: randomUUID(),
    DB: {
      exec: async () => ({}),
      prepare(sql) {
        const stmt = {
          bind() { return stmt; },
          async all() {
            if (/FROM sources s/.test(sql) && /source_inventory/.test(sql)) {
              counts.coverage++;
              return clock.operation('coverage', 500, { results: [] });
            }
            if (/chunks_fts MATCH/.test(sql)) {
              counts.keyword++;
              return clock.operation('keyword', 1200, { results: rows }, keywordFails);
            }
            if (/FROM chunks c JOIN documents/.test(sql)) {
              return clock.operation('hydration', 100, { results: rows });
            }
            return { results: [] };
          },
          async first() {
            if (/FROM oauth_tokens/.test(sql)) {
              counts.auth++;
              return { token_hash: 'fixture', scope: profile, session_generation: 1, expires_at: ANCHOR + 86400000 };
            }
            if (/FROM owner_auth_state/.test(sql)) return { session_generation: 1 };
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return clock.operation('projection', 100, {
                schema_version: 48, mutation_id: null, projection_status: 'verified',
                bootstrap_epoch: 0, expected_vectors: rows.length, pending: 0, submitted: 0,
              });
            }
            if (/FROM vector_outbox/.test(sql)) return { n: 0, upserts: 0, deletes: 0, submitted: 0 };
            if (/SUM\(est_cost_usd_micros\)/.test(sql)) return { m: 0 };
            return null;
          },
          async run() { return {}; },
        };
        return stmt;
      },
    },
    VECTORIZE: {
      query: async () => {
        counts.vector++;
        return clock.operation('vector', 600, { matches: rows.map(r => ({ id: r.chunk_uid })) }, vectorFails);
      },
      describe: async () => ({ vectorCount: rows.length, processedUpToMutation: null }),
    },
    AI: {
      async run(model, input) {
        if (model.includes('bge-')) {
          counts.embedding++;
          return clock.operation('embedding', 800, { data: [[0.1, 0.2]] });
        }
        const verify = input.messages[0].content.includes('verify a proposed answer');
        counts[verify ? 'verifier' : 'answer']++;
        return clock.operation(verify ? 'verifier' : 'answer', verify ? verifierMs : answerMs, {
          response: verify ? JSON.stringify({ supported: approve, complete: approve, evidence: approve ? [1] : [], reason: 'synthetic verdict' })
            : 'The release threshold is seven units. [1]',
          usage: { prompt_tokens: 50, completion_tokens: 12 },
        }, verify ? verifierFails : answerFails);
      },
    },
  };
  async function request(route = 'think', { credential = 'admin', body, timingOptions = {}, requestHeaders = {} } = {}) {
    const path = route === 'mcp' ? '/mcp' : `/api/rag/${route}`;
    const headers = { 'Content-Type': 'application/json' };
    if (route === 'mcp') headers.Authorization = `Bearer ${randomUUID()}`;
    else if (credential !== 'none') headers['X-Admin-Key'] = credential === 'admin' ? env.ADMIN_KEY : env.RAG_PROXY_KEY;
    Object.assign(headers, requestHeaders);
    const response = await clock.finish(worker.fetch(new Request(`https://fixture.invalid${path}`, {
      method: 'POST', headers,
      body: JSON.stringify(body ?? (route === 'mcp'
        ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question: 'What threshold was recorded?' } } }
        : { q: 'What threshold was recorded?' })),
    }), env, { waitUntil() {} }, { now: clock.now, ...timingOptions }));
    return { response, body: await response.json() };
  }
  return { clock, env, counts, request };
}
