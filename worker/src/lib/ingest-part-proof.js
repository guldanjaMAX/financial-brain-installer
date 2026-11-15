import { jsonResponse, privateNoStore } from './core.js';
import { chunkGeometry } from './store.js';
import { activeChunkSql } from './retained-ingest.js';

// Read-only proof, never removal authority. The existing random mutation nonce
// distinguishes equal generation counters after a restored history forks.
export async function handleIngestPartProof(env, request) {
  const reply = (body, status = 200) => privateNoStore(jsonResponse(body, status));
  const invalid = () => reply({ error: 'Part readback needs bounded exact source identities.' }, 400);
  if (!request.body) return invalid();
  const reader = request.body.getReader(), chunks = [];
  let length = 0, body;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32768) { await reader.cancel(); return invalid(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return invalid(); }
  if (!body || Object.keys(body).sort().join(',') !== 'source,source_ids' ||
      typeof body.source !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.source) ||
      !Array.isArray(body.source_ids) || body.source_ids.length < 1 || body.source_ids.length > 50 ||
      body.source_ids.some(id => typeof id !== 'string' || !id || id.length > 500 || /[\u0000-\u001f]/.test(id)) ||
      new Set(body.source_ids).size !== body.source_ids.length) return invalid();
  // One transactional snapshot binds the marker and all bounded PK readbacks.
  // Count a capped active range, never the corpus or retained obsolete tails.
  const [marker, rows] = await env.DB.batch([
    env.DB.prepare('SELECT instance,nonce,generation FROM ingest_removal_generation WHERE id=1'),
    env.DB.prepare(`SELECT d.source_id,d.content_hash,
      (SELECT json_object('n',count(*),'distinct_n',count(DISTINCT chunk_ix),'first',min(chunk_ix),'last',max(chunk_ix))
       FROM (SELECT c.chunk_ix FROM chunks c WHERE c.doc_uid=d.doc_uid${activeChunkSql('c','d')} ORDER BY c.chunk_ix LIMIT 513)) AS chunk_range
      FROM json_each(?1) j JOIN documents d ON d.doc_uid=?2 || ':' || j.value
      WHERE d.source=?2 AND d.source_id=j.value AND d.deleted_at IS NULL`).bind(JSON.stringify(body.source_ids),body.source),
  ]);
  const database = marker?.results?.[0];
  if (!database || !/^[a-f0-9]{32}$/.test(database.instance) || !/^[a-f0-9]{32}$/.test(database.nonce) ||
      !Number.isSafeInteger(database.generation) || database.generation < 0) {
    return reply({ error: 'Current database part proof is unavailable.' }, 503);
  }
  const parts = [];
  for (const row of rows.results) {
    const range = JSON.parse(row.chunk_range);
    if (/^[a-f0-9]{64}$/.test(row.content_hash) && range.n > 0 && range.n <= 512 &&
        range.distinct_n === range.n && range.first === 0 && range.last === range.n - 1) {
      parts.push({source_id:row.source_id,content_hash:row.content_hash,chunk_count:range.n});
    }
  }
  return reply({ source:body.source, database, geometry:chunkGeometry(env), parts });
}
