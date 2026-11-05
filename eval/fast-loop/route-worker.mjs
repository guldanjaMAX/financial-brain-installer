// Trusted replay host. The Worker runs in a separate capability compartment.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { seed, SQL_CONTRACTS } from './money-worker.mjs';
import { prepareBankExportImport } from '../../worker/src/lib/fin-import.js';
import { workerCompartment } from './worker-compartment.mjs';
import { clone, typed, sha256, exactTape, d1Tape, modelRequest } from './exact-tape.mjs';
import { ARMS, runRetrievalArm } from './retrieval-arms.mjs';
import { armReplayStall } from './child-stall.mjs';

const executionStatus = fatal => !fatal.length ? 'complete'
  : fatal[0] === 'MODEL_TAPE_MISS' ? 'model_tape_miss'
    : fatal[0] === 'SNAPSHOT_MISS' ? 'snapshot_miss' : 'harness_error';

export async function executeRoutes(request) {
  const started = performance.now();
  const root = realpathSync(request.root);
  const fixtures = request.fixtures;
  const observations = [];
  const tapes = {};
  const sourceFiles = {};
  const guards = { transport_tripwire: Boolean(globalThis[Symbol.for('brain.test.cli-side-effect-tripwire.installed')]),
    scoped_read: process.permission.has('fs.read', root),
    external_read: process.permission.has('fs.read', resolve(root, '../synthetic-private')),
    subprocess: process.permission.has('child'), filesystem_write: process.permission.has('fs.write', root) };
  if (!guards.transport_tripwire || !guards.scoped_read || guards.external_read || guards.subprocess || guards.filesystem_write) throw Error('HOST_GUARD_MISSING');
  if (request.arms) {
    const fatal = [];
    const fail = code => { fatal.push(code); throw Error(code); };
    const compartment = await workerCompartment({ root, clock: request.inputs[0].clock, fail, trace: false,
      hooks: { model: () => fail('MODEL_TAPE_MISS') } });
    const arms = [];
    for (const arm of ARMS) arms.push(await runRetrievalArm(compartment.search, arm, { fail, fault: request.fault }));
    return { arms, fatal, guards, provider_calls: 0, production_writes: 0 };
  }
  for (const input of request.inputs) {
    const at = performance.now();
    const fatal = [];
    const trace = { sql: [], providers: [], models: [], parsed_intents: [], ledger_entries: [],
      fallback_calls: 0, retrieval: [], denied_effects: [], tasks: 0, drained_tasks: 0,
      host_guards: guards, production_writes: 0, model_boundary: 'injected-callLLM-no-accounting',
      delivered_spans: [], snapshot_checks: 0, fixture_accounts: input.snapshot.accounts.length,
      dependencies: [], rows_read: [], acquired_chunks: [] };
    const fail = (code, kind = code) => { fatal.push(code); trace.denied_effects.push(kind); throw Error(code); };
    const principal = request.authority || 'owner';
    const fixtureId = request.fixtureId || input.id;
    let db;
    const tasks = [];
    const channels = {};
    const recording = { d1: [], provider: [], model: [] };
    recording.identity = sha256({ snapshot: input.snapshot, documents: input.documents || [] });
    const counters = {};
    const call = (channel, value, responder) => {
      if (request.capture) {
        const occurrence = counters[channel] = (counters[channel] || 0) + 1;
        const entry = { input: { schema: 1, principal, occurrence, request: typed(value) } };
        recording[channel].push(entry);
        trace[channel === 'd1' ? 'sql' : channel === 'model' ? 'models' : 'providers'].push(clone(entry.input));
        try { entry.output = clone(responder(value)); return clone(entry.output); }
        catch (error) { entry.error = 'SYNTHETIC_DEPENDENCY_ERROR'; throw error; }
      }
      return channels[channel].call(value);
    };
    try {
      if (request.capture) {
        db = new DatabaseSync(':memory:');
        const migrations = readdirSync(resolve(root, 'migrations/d1')).filter(f => f.endsWith('.sql')).sort();
        for (const file of migrations) db.exec(readFileSync(resolve(root, 'migrations/d1', file), 'utf8'));
        db.prepare(`INSERT INTO install_state(id,client_slug,product_version,schema_version,installed_at)
          VALUES (1,'synthetic','0.4.22',?,'2026-10-30T00:00:00Z')`).run(Number(migrations.at(-1).split('_')[0]));
        seed(db, input.snapshot, input.clock.now_utc);
        if (input.snapshot.reset_import) {
          const reset = input.snapshot.reset_import;
          const plan = prepareBankExportImport({ ok: true, accounts: [{ accountKey: reset.account,
            accountKind: reset.kind, balanceRole: reset.role, mask: '4242', transactions: [] }] },
          { entitySlug: 'owner', now: input.clock.now_utc,
            origin: { provenance: 'feed', sourceFeed: 'bank-feed:synthetic' } });
          if (!plan.receipt.imported || plan.statements.length < 2) fail('IMPORT_PLAN_MISSING');
          for (const [sql, binds] of plan.statements) db.prepare(sql).run(...binds);
        }
        if (input.documents) seedDocuments(db, input.documents);
        db.exec('PRAGMA query_only=ON');
      } else {
        const fixture = fixtures[fixtureId];
        trace.snapshot_checks++;
        if (!fixture) fail('SNAPSHOT_MISS');
        if (fixture.identity !== recording.identity) fail('SNAPSHOT_MISS');
        for (const name of ['d1', 'provider', 'model']) {
          const entries = fixture[name];
          const code = name === 'model' ? 'MODEL_TAPE_MISS' : 'SNAPSHOT_MISS';
          channels[name] = exactTape({ entries, code, principal, fatal,
            calls: trace[name === 'd1' ? 'sql' : name === 'model' ? 'models' : 'providers'] });
        }
      }
      const sqlRead = ({ sql, binds, method }) => {
        const head = sql.replace(/^\s*\/\*[\s\S]*?\*\//, '').trim();
        // SQLite's query_only enforces CTE safety; words inside SQL literals
        // (for example an outbox operation) are not database write attempts.
        if (!/^(?:SELECT|WITH)\b/i.test(head)) return fail('WRITE_DENIED');
        const rows = db.prepare(sql).all(...binds);
        return method === 'first' ? rows[0] || null : { success: true, results: rows };
      };
      const d1 = { call(value) {
        if (request.fault === 'sql') value = { ...value, sql: `${value.sql || ''} ` };
        if (request.fault === 'bind') value = { ...value, binds: [...(value.binds || []), null] };
        const result = call('d1', value, v => v.method === 'batch' ? v.statements.map(s => sqlRead({ ...s, method: 'all' })) : sqlRead(v));
        const statements = value.method === 'batch' ? value.statements : [value];
        const responses = value.method === 'batch' ? result : [result];
        statements.forEach((s, i) => {
          const kind = SQL_CONTRACTS.get(sha256(s.sql));
          if (kind) trace.dependencies.push(kind);
          if (kind === 'transactions') trace.rows_read.push(...clone(responses[i]?.results || []));
          for (const row of responses[i]?.results || []) {
            if (row.chunk_uid && typeof row.text === 'string' &&
                !trace.acquired_chunks.some(chunk => chunk.chunk_uid === row.chunk_uid)) {
              trace.acquired_chunks.push({ chunk_uid: row.chunk_uid, doc_uid: row.doc_uid,
                text_sha256: sha256(row.text) });
            }
          }
        });
        return result;
      } };
      const provider = (method, args) => call('provider', { method, args }, () => {
        if (method === 'embedding') return { data: (Array.isArray(args[1].text) ? args[1].text : [args[1].text]).map(() => [0.1, 0.2]) };
        if (method === 'query') return { matches: (input.vectorIds || []).map(id => ({ id, score: 0.9 })) };
        if (method === 'describe') return { vectorCount: input.documents?.length || 0, dimensions: 2 };
        return fail('SNAPSHOT_MISS');
      });
      const env = { STORAGE: 'd1', BRAIN_TIMEZONE: input.clock.owner_time_zone, BRAIN_OWNER: 'owner',
        // Opaque synthetic authority is built in memory and never emitted.
        ADMIN_KEY: ['fixture', 'owner'].join(':'), RAG_PROXY_KEY: ['fixture', 'reader'].join(':'),
        DB: d1Tape(d1), AI: { run: (...args) => provider('embedding', args) },
        VECTORIZE: { query: (...args) => provider('query', args), describe: (...args) => provider('describe', args) } };
      const hooks = {
        intent: intent => trace.parsed_intents.push(clone(intent)),
        ledger: options => trace.ledger_entries.push({ principal: options.scopePrincipalKind, all: options.grantScope?.all === true }),
        fallback: () => trace.fallback_calls++,
        retrieved: result => trace.retrieval.push(clone(result)),
        model: options => {
          let value = modelRequest(options);
          if (request.fault === 'model') value = { ...value, max_tokens: value.max_tokens + 1 };
          if (request.fault === 'model-check' && value.label === 'rag-evidence-gate') value = { ...value, max_tokens: value.max_tokens + 1 };
          if (request.fault === 'model-prompt') value = { ...value, system: `${value.system}\nChanged instruction.` };
          if (request.fault === 'model-name') value = { ...value, model: `${value.model}-changed` };
          if (request.fault === 'model-messages') value = { ...value,
            messages: value.messages.map(message => ({ ...message, content: `${message.content} ` })) };
          return call('model', value, () => {
            const n = recording.model.length;
            const reply = input.modelOutputs?.[n - 1];
            if (reply === undefined) return fail('MODEL_TAPE_MISS');
            return { content: [{ type: 'text', text: reply }], model: value.model,
              stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } };
          });
        },
      };
      const compartment = await workerCompartment({ root, clock: input.clock, fail, hooks,
        trace: request.trace !== false, sourceOverrides: request.sourceOverrides });
      Object.assign(sourceFiles, compartment.sourceFiles);
      const headers = { 'Content-Type': 'application/json' };
      if (principal !== 'anonymous') headers['X-Admin-Key'] = principal === 'owner' ? env.ADMIN_KEY : env.RAG_PROXY_KEY;
      const ctx = { waitUntil(task) { trace.tasks++; tasks.push(Promise.resolve(task).finally(() => trace.drained_tasks++)); } };
      const response = await compartment.worker.fetch(new Request('https://synthetic.invalid/api/rag/think', {
        method: 'POST', headers, body: JSON.stringify({ q: input.question, ...(input.request || {}) }),
      }), env, ctx);
      const raw = await response.text();
      if (request.fault === 'scheduled-sql') ctx.waitUntil(Promise.resolve().then(() => env.DB.prepare('SELECT 1 AS unrecorded').all()));
      await Promise.allSettled(tasks);
      if (!request.capture) for (const channel of Object.values(channels)) { try { channel.finish(); } catch {} }
      trace.delivered_spans = deliveredSpans(input.documents || [], trace.models, trace.acquired_chunks);
      observations.push({ id: input.id, base: input.base, http_status: response.status,
        raw_body: raw, body: JSON.parse(raw), trace, fatal: [...new Set(fatal)],
        execution_status: executionStatus(fatal),
        elapsed_ms: performance.now() - at });
      if (request.capture) tapes[input.id] = recording;
    } catch (error) {
      await Promise.allSettled(tasks);
      observations.push({ id: input.id, base: input.base, execution_status: fatal.length ? executionStatus(fatal) : 'harness_error',
        fatal: [...new Set([...fatal, error.code || error.message])], trace,
        ...(request.capture ? { capture_error: error.message } : {}) });
    } finally { db?.close(); }
  }
  return { schema: 1, mode: 'actual-worker-http-recorded-strict', observations, source_files: sourceFiles,
    source_digest: sha256(sourceFiles), warm_ms: performance.now() - started,
    provider_calls: 0, production_writes: 0, ...(request.capture ? { tapes } : {}) };
}

function seedDocuments(db, documents) {
  for (const d of documents) {
    db.prepare("INSERT OR IGNORE INTO sources(name,kind,status,created_at) VALUES (?,'upload','ready','2026-10-30T00:00:00Z')").run(d.source);
    db.prepare(`INSERT OR IGNORE INTO documents(doc_uid,source,source_id,title,content_hash,document_date,ingested_at,text_source,text_reliable,date_source,date_reliable)
      VALUES (?,?,?,?,?,?,0,'native',1,'fixture:fixed-date',1)`).run(d.doc_uid, d.source, d.doc_uid, d.title, sha256(d.doc_uid), Date.parse(d.date || '2026-10-30T00:00:00Z'));
    db.prepare('INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source,title,document_date) VALUES (?,?,?,?,?,?,?)').run(d.chunk_uid, d.doc_uid, d.index, d.text, d.source, d.title, Date.parse(d.date || '2026-10-30T00:00:00Z'));
  }
  // This deliberately tiny synthetic provider has exactly these seeded chunks.
  // Fixture preparation establishes the index receipt before query_only.
  db.prepare('UPDATE install_state SET vector_projection_bootstrap_base_count=? WHERE id=1').run(documents.length);
}

// Source offsets use Unicode code points. Prompt offsets are computed against
// the actual generated message, never a reconstructed or gold-only prompt.
export function deliveredSpans(documents, calls, acquired) {
  const spans = [];
  const candidates = documents.filter(doc => acquired.some(chunk => chunk.chunk_uid === doc.chunk_uid &&
    chunk.doc_uid === doc.doc_uid && chunk.text_sha256 === sha256(doc.text)));
  for (const call of calls) {
    const fields = Object.fromEntries(call.request[1].map(([key, value]) => [key, value]));
    const label = fields.label?.[1];
    if (!['rag-think', 'rag-think-repair'].includes(label)) continue;
    const message = fields.messages?.[1]?.[0]?.[1]?.find(([key]) => key === 'content')?.[1]?.[1];
    if (!message) continue;
    const block = message.split('\n\nDOCUMENTS:\n')[1]?.split('\n\nKNOWN GAPS')[0] || '';
    const normalized = normalizeMap(block);
    const blockOffset = Array.from(message.slice(0, message.indexOf(block))).length;
    for (const doc of candidates) {
      const source = normalizeMap(doc.text);
      // One maximal contiguous match per contributor. Repeated source padding
      // must not reuse a prompt window to invent delivery of later occurrences.
      const best = longestMatch(source.text, normalized.text);
      if (best.length >= 16) {
        const { start, offset, length, ambiguous } = best;
        const piece = source.text.slice(start, start + length);
        spans.push({ chunk_uid: doc.chunk_uid, doc_uid: doc.doc_uid, revision: doc.revision,
          source_sha256: sha256(doc.text), source_start: source.map[start], source_end: source.map[start + length - 1] + 1,
          prompt_start: blockOffset + normalized.map[offset], prompt_end: blockOffset + normalized.map[offset + length - 1] + 1,
          origin_ambiguous: ambiguous || candidates.some(other => other.chunk_uid !== doc.chunk_uid &&
            normalizeMap(other.text).text.includes(piece)), text: piece, model_occurrence: call.occurrence });
      }
    }
  }
  return spans;
}

function longestMatch(source, prompt) {
  let previous = new Uint32Array(prompt.length + 1);
  let best = { start: 0, offset: 0, length: 0, ambiguous: false };
  for (let i = 1; i <= source.length; i++) {
    const next = new Uint32Array(prompt.length + 1);
    for (let j = 1; j <= prompt.length; j++) {
      if (source[i - 1] !== prompt[j - 1]) continue;
      const length = next[j] = previous[j - 1] + 1;
      if (length > best.length) best = { start: i - length, offset: j - length, length, ambiguous: false };
      else if (length === best.length && i - length !== best.start) best.ambiguous = true;
    }
    previous = next;
  }
  return best;
}

function normalizeMap(text) {
  let normalized = ''; const map = []; let whitespace = false;
  for (const [index, point] of Array.from(text).entries()) {
    if (/\s/u.test(point)) {
      if (!whitespace) { normalized += ' '; map.push(index); }
      whitespace = true;
    } else {
      normalized += point;
      for (let i = 0; i < point.length; i++) map.push(index);
      whitespace = false;
    }
  }
  return { text: normalized, map };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  armReplayStall();
  try { process.stdout.write(JSON.stringify(await executeRoutes(JSON.parse(readFileSync(0, 'utf8'))))); }
  catch { process.stderr.write('ROUTE_HOST_FAILURE\n'); process.exitCode = 2; }
}
