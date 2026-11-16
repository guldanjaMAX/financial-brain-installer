// Rehearsal 2026-11-15 Q1: a named client document must not be pushed out of
// the answer window by a long email thread. Real migrations, ingest route,
// D1 search and /api/rag/think; only DB, VECTORIZE and AI are substituted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import worker from '../src/index.js';
import { search } from '../src/lib/store-d1.js';
import { withFirstPartySourceProvenance } from '../src/lib/provenance-receipt.js';

globalThis.fetch = async () => { throw new Error('network forbidden'); };
const Q = 'What does the Bluebird consulting agreement say about cancelling?';

async function fixture({ threadSize = 12 } = {}) {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../../migrations/d1/', import.meta.url);
  const files = readdirSync(dir).filter(n => n.endsWith('.sql')).sort();
  for (const name of files) db.exec(readFileSync(new URL(name, dir), 'utf8'));
  db.exec("INSERT INTO install_state(id,client_slug,product_version,installed_at) VALUES(1,'fixture','0.0.0','2026-01-01')");
  db.exec("INSERT INTO sources(name,kind,created_at) VALUES('gmail','gmail','2026-01-01'),('client_files','folder','2026-01-01')");
  db.prepare('UPDATE install_state SET schema_version=? WHERE id=1').run(Number(files.at(-1).slice(0, 4)));
  const statement = (sql, binds = []) => {
    const run = () => {
      const s = db.prepare(sql), args = binds.length ? [Object.fromEntries(binds.map((v, i) => [String(i + 1), v]))] : [];
      return s.columns().length ? { results: s.all(...args), meta: { changes: 0 } } : { meta: { changes: Number(s.run(...args).changes) } };
    };
    return { bind: (...v) => statement(sql, v), all: async () => run(), first: async () => run().results?.[0] ?? null, run: async () => run(), execute: run };
  };
  const env = { STORAGE: 'd1', ADMIN_KEY: randomBytes(32).toString('hex'), BRAIN_OWNER: 'Fixture Owner',
    ANSWER_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    DB: { prepare: statement, batch: async items => {
      db.exec('BEGIN IMMEDIATE');
      try { const r = items.map(i => i.execute()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    } },
    // Semantic lane deliberately ranks the named document first: the defect
    // is ordering after fusion, not candidate generation.
    VECTORIZE: { query: async (_v, { topK }) => ({ matches: db.prepare(
      "SELECT chunk_uid id FROM chunks ORDER BY (doc_uid LIKE 'client_files:%') DESC, id").all().slice(0, topK) }) },
    AI: { async run(model, input) {
      if (model.includes('bge-')) return { data: (input.text || []).map(() => [0.1]) };
      const verify = /verify a proposed answer|verify each synthesis item/.test(String(input.messages?.[0]?.content || ''));
      return { response: verify ? { supported: true, complete: true, evidence: [1], conflicts: [] } : 'Either party may cancel with 30 days written notice [1].' };
    } } };
  const post = async (path, body) => {
    const res = await worker.fetch(new Request(`https://owner.invalid${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY }, body: JSON.stringify(body) }), env, { waitUntil() {} });
    assert.equal(res.status, 200); return res.json();
  };
  const docs = [withFirstPartySourceProvenance({ source_type: 'client_files', source_id: 'bluebird.docx',
    title: '2026-09-01 - Bluebird - Consulting agreement',
    content: 'Consulting Agreement between the owner and Bluebird Studio. Term: 6 months. Either party may cancel with 30 days written notice.',
    occurred_at: '2026-09-01T00:00:00.000Z', date_source: 'content', date_reliable: true, metadata: { category: 'client_files' },
  }, { textSource: 'native', textReliable: true })];
  for (let i = 0; i < threadSize; i++) docs.push(withFirstPartySourceProvenance({ source_type: 'gmail', source_id: `eo${i}`,
    title: 'Re: E&O and Cyber Quotes', content: `Consulting E&O quote ${i}. You may cancel any time; no cancellation fees under the broker agreement.`,
    occurred_at: new Date(Date.parse('2026-09-22T16:00:00Z') + i * 2 * 864e5).toISOString(), date_source: 'gmail_internal', date_reliable: true,
    metadata: { category: 'gmail', thread_id: 'thread-eo' } }, { textSource: 'native', textReliable: true }));
  await post('/api/admin/brain/ingest/batch', { docs });
  return { env, post, close: () => db.close() };
}

test('a long same-thread email family does not outrank a named document', async () => {
  const f = await fixture();
  try {
    const r = await search(f.env, { query: Q, embedding: Promise.resolve([0.1]), limit: 50, projectionReadiness: { ready: true } });
    assert.equal(r.results[0]?.source, 'client_files', 'best fused document keeps rank 1');
    const thread = r.results.filter(x => x.source === 'gmail');
    assert.ok(thread.some(x => x.selection?.state === 'unresolved'), 'thread discovery still marks newer records');
    const think = await f.post('/api/rag/think', { q: Q, limit: 8 });
    assert.ok(think.citations.some(c => c.source === 'client_files'), 'named document reaches the 12-record answer window');
  } finally { f.close(); }
});
