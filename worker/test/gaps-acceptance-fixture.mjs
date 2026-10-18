import '../../test/fixtures/cli-side-effect-tripwire.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProductFixture } from './product-contract-fixture.mjs';
import { Clock } from './query-timing-fixture.mjs';
import { drainOutbox, vectorReadiness } from '../src/lib/store-d1.js';

export const NOW = Date.parse('2034-10-17T19:00:00Z');
export const WRONG_SCOPE = Object.freeze({ supported: false, complete: false, evidence: [],
  reason: 'The recipient system has not confirmed that its address was updated.' });
const testClocks = new WeakMap();
const NativeDate = Date;

// Gold is generated before ingest and never supplied as authority metadata.
export function addressWorld(seed = 1701, arm = 'request') {
  const value = `${100 + seed % 700} Synthetic Road, Fixture City, AZ 85001`;
  const previous = `${900 + seed % 90} Synthetic Lane, Fixture City, AZ 85002`;
  const mail = (id, day, body, sender = 'Record Owner', title = 'Address change') => ({
    source_type: 'gmail', source_id: id, title,
    content: `From: ${sender} <${sender === 'Record Owner' ? 'owner' : 'sender'}@example.invalid>\nTo: service@example.invalid\nDate: ${day}\nSubject: ${title}\n\n${body}`,
    occurred_at: day, date_reliable: true, date_source: 'email_header',
    text_source: 'native', text_reliable: true,
    metadata: { evidence_lineage: { version: 1, kind: 'source_record' } },
  });
  let docs = [
    mail('old-record', '2033-08-02', `My mailing address is ${previous}.`),
    mail('change-request', '2034-03-04', `Please update my address to ${value}. I have moved there.`),
    mail('postal-confirmation', '2034-03-05', 'Your change-of-address request is confirmed, effective 2034-03-04.',
      'Postal Service', 'Address change for Record Owner'),
    mail('distractor', '2033-07-01', 'Delivery hours are nine to five.', 'Service Desk', 'Service hours'),
  ];
  if (arm === 'recent') docs = [mail('recent', '2034-10-16', `My mailing address is ${value}.`)];
  if (arm === 'other') docs = [mail('change-request', '2034-03-04',
    `Please update my address to ${value}. I have moved there.`, 'Other Sender')];
  if (arm === 'hypothetical') docs = [mail('change-request', '2034-03-04',
    `If the move happens, please update my address to ${value}. I intend to move there.`)];
  if (arm === 'correction') docs.push(mail('correction', '2034-04-09', `My mailing address is ${previous}.`));
  return { docs, value, previous, expected: arm === 'correction' ? previous : value,
    day: arm === 'correction' ? '2034-04-09' : arm === 'recent' ? '2034-10-16' : '2034-03-04' };
}

export async function acceptanceFixture(t, { delays = {}, verdict = WRONG_SCOPE,
  draft = 'The retrieved record does not establish a completed system update. [1]', now = NOW } = {}) {
  let context = testClocks.get(t);
  if (!context) {
    context = { clock: new Clock(), external: 0 };
    testClocks.set(t, context);
    t.mock.property(globalThis, 'Date', class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now + context.clock.ms])); }
      static now() { return now + context.clock.ms; }
    });
    t.mock.method(globalThis, 'fetch', async () => { context.external++; throw new Error('external fetch forbidden'); });
  }
  const { clock } = context;
  const f = await createProductFixture({ env: {
    ADMIN_KEY: randomUUID(), SESSION_SIGNING_KEY: randomUUID(), BRAIN_OWNER: 'Record Owner',
  } });
  t.after(() => { f.close(); assert.equal(context.external, 0, 'no external transport attempted'); });
  const counts = { ingested: 0, keyword: 0, vector: 0, readiness: 0, marker: 0,
    embedding: 0, answer: 0, verifier: 0, writes: 0 };
  const control = { delayed: false, vectorFails: false, answerFails: false, verifierFails: false };
  const schedule = (stage, value, fail = false) => control.delayed
    ? clock.operation(stage, delays[stage] || 0, value, fail)
    : fail ? Promise.reject(new Error('synthetic provider failure')) : Promise.resolve(value);
  const nativePrepare = f.DB.prepare;
  f.DB.prepare = sql => {
    const wrap = statement => ({ ...statement,
      bind: (...args) => wrap(statement.bind(...args)),
      all: async () => {
        if (/chunks_fts MATCH/.test(sql)) { counts.keyword++; await schedule('keyword', null); }
        return statement.all();
      },
      first: async () => {
        if (/search-projection-marker/.test(sql)) counts.marker++;
        return statement.first();
      },
      run: async () => { counts.writes++; return statement.run(); },
    });
    return wrap(nativePrepare(sql));
  };
  const visible = new Map();
  let mutation = null, sequence = 0;
  f.env.VECTORIZE = {
    async upsert(rows) {
      rows.forEach(row => visible.set(row.id, row));
      mutation = `synthetic-${++sequence}`;
      return { mutationId: mutation };
    },
    async deleteByIds(ids) { ids.forEach(id => visible.delete(id)); return { mutationId: mutation = `synthetic-${++sequence}` }; },
    async getByIds(ids) { return ids.map(id => visible.get(id)).filter(Boolean); },
    async describe() {
      counts.readiness++;
      return schedule('readiness', { vectorCount: visible.size, processedUpToMutation: mutation });
    },
    async query() {
      counts.vector++;
      return schedule('vector', { matches: [...visible.values()].map(row => ({ id: row.id, score: 0.9 })) }, control.vectorFails);
    },
  };
  f.env.AI = { async run(model, input) {
    if (model.includes('bge-')) {
      counts.embedding++;
      return schedule('embedding', { data: [[0.1, 0.2, 0.3]] });
    }
    const verify = input.messages[0].content.includes('verify a proposed answer');
    const stage = verify ? 'verifier' : 'answer';
    counts[stage]++;
    const response = verify ? (typeof verdict === 'function' ? verdict(input) : verdict)
      : (typeof draft === 'function' ? draft(input, counts.answer) : draft);
    return schedule(stage, { response }, control[`${stage}Fails`]);
  } };
  async function ingest(docs) {
    // This fixture owns the complete generated source. Registration establishes
    // connector/history scope; it does not elevate any document's authority.
    for (const source of new Set(docs.map(doc => doc.source_type))) f.raw(
      `INSERT OR IGNORE INTO sources(name,kind,status,created_at,last_complete_sweep_at,last_ingest_at,expected_refresh_seconds)
       VALUES (?,?,'ready',?,?,?,86400)`, source, source, new Date(now).toISOString(),
      new Date(now).toISOString(), new Date(now).toISOString());
    for (const doc of docs) {
      const response = await f.post('/api/admin/brain/ingest', doc, { 'X-Admin-Key': f.env.ADMIN_KEY });
      assert.equal(response.status, 200, 'normal synthetic ingest admitted');
      const body = await response.json();
      assert.ok(body.doc_uid, 'ingest produced a durable identity');
      counts.ingested++;
    }
    assert.equal(f.first('SELECT COUNT(*) n FROM documents').n, counts.ingested);
  }
  async function drain() {
    for (let attempt = 0; attempt < 10; attempt++) {
      await drainOutbox(f.env, { embed: async () => [0.1, 0.2, 0.3],
        embedBatch: async texts => texts.map(() => [0.1, 0.2, 0.3]), maxBatches: 10 });
      if ((await vectorReadiness(f.env)).ready) return;
    }
    assert.fail('real outbox drain must verify the synthetic projection');
  }
  function dispatch(route = 'think', q = 'what is my address?', body = {}) {
    return f.worker.fetch(new Request(`https://brain.invalid/api/rag/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
      body: JSON.stringify({ q, ...body }),
    }), f.env, { waitUntil() {} }, { now: clock.now });
  }
  async function request(route = 'think', q = 'what is my address?', body = {}) {
    const before = { ...counts }, start = clock.ms;
    control.delayed = true;
    const response = await clock.finish(dispatch(route, q, body));
    control.delayed = false;
    const result = { response, body: await response.json(), elapsed: clock.ms - start,
      counts: Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - before[key]])) };
    assert.equal(context.external, 0, 'each arm denied external fetch');
    return result;
  }
  return { ...f, clock, counts, dbControl: f.control, control, ingest, drain, dispatch, request, noExternal: () => assert.equal(context.external, 0) };
}

export function reachedRetrieval(result) {
  assert.equal(result.response.status, 200);
  assert.ok(result.counts.keyword > 0 && result.counts.vector > 0, 'both retrieval decisions reached');
  assert.ok(result.body.results.length > 0, 'retrieved stored candidates');
  assert.ok(result.body.timing.stages.premise_temporal.calls > 0, 'temporal decision reached');
  assert.ok(result.body.evidence_gate, 'evidence decision completed');
}

export function assertAddress(result, gold) {
  reachedRetrieval(result);
  // Score the rendered claim and its citations against generator facts, never
  // use the model verdict or supported flag as the correctness oracle.
  assert.equal(typeof result.body.answer, 'string', 'answerable owner fact must be useful');
  assert.ok(result.body.answer.includes(gold.expected), 'exact independently generated address');
  assert.ok(result.body.answer.includes(gold.day), 'exact source date');
  assert.match(result.body.answer, /retrieved|records|email/i);
  assert.doesNotMatch(result.body.answer, /(?:billing|account|recipient) system (?:is|was|has been) updated/i);
  assert.ok(result.body.citations.some(doc => String(doc.date || doc.ts || '').startsWith(gold.day)),
    'dated citation survives rendering');
}
