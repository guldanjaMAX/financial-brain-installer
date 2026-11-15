import { filterThinkCandidates } from './think-candidate-policy.js';
import { documentAccessSql, scopeSql, filterSql, keywordSearchTerms } from './store-d1.js';
import { customApiVisibilitySql, readWithCustomApiVisibility } from './custom-api-visibility.js';
import { currentMemorySql, legacySchemaMayReadWithoutMemorySupersessions, memorySupersessionIntegrityFailure } from './memory-supersession.js';

// Discovery containers are hints, never proof that a clause was amended.
// Only exact ledger edges bind a correction; titles and semantic similarity
// cannot create a subject identity. All exported neighbors repeat authorization.
export async function discoverDocumentSuccessors(env, rows, { filters = {}, access = null, scope = null, question = "", assess = row => row } = {}) {
  const ids = [...new Set(rows.map(r => r.doc_uid).filter(Boolean))].slice(0,50);
  if (!ids.length || !env.DB) return rows;
  const f = filterSql(filters, 'c', 2);
  const s = scopeSql(scope, 'd', f.nextParam);
  const a = documentAccessSql(access, 'c', 'd', s.nextParam);
  const boundary = pointer => `d.deleted_at IS NULL${f.clause}${s.clause}${a.clause}${customApiVisibilitySql('d',pointer)}`;
  const thread = `d.source=seed.source AND json_valid(d.meta) AND json_valid(seed.meta)
    AND json_type(seed.meta,'$.thread_id')='text' AND length(json_extract(seed.meta,'$.thread_id'))>0
    AND json_extract(d.meta,'$.thread_id')=json_extract(seed.meta,'$.thread_id')`;
  // Declared split families use the same exact identity contract as schema 59.
  // They are containers, not an inferred title/version or cross-source claim.
  const family = alias => `CASE WHEN json_valid(${alias}.meta) THEN
    COALESCE(json_extract(${alias}.meta,'$.family_of'),
      CASE WHEN json_type(${alias}.meta,'$.part_of')='text' THEN
        CASE WHEN instr(json_extract(${alias}.meta,'$.part_of'), ${alias}.source || ':')=1
          THEN json_extract(${alias}.meta,'$.part_of') ELSE ${alias}.source || ':' || json_extract(${alias}.meta,'$.part_of') END END)
    END`;
  const run = (memoryClause, ledger = true) => readWithCustomApiVisibility(env, pointer => {
    const correction = ledger ? `EXISTS (SELECT 1 FROM memory_supersessions edge
      WHERE edge.predecessor_doc_uid=seed.doc_uid AND edge.predecessor_content_hash=seed.content_hash
        AND edge.successor_doc_uid=d.doc_uid AND edge.successor_content_hash=d.content_hash)` : '0';
    return env.DB.prepare(`/* successor-discovery */
      WITH seeds AS MATERIALIZED (
        SELECT DISTINCT d.doc_uid,d.source,d.content_hash,d.meta,d.document_date,d.entity_slug,d.client
        FROM documents d JOIN chunks c ON c.doc_uid=d.doc_uid
        WHERE d.doc_uid IN (SELECT value FROM json_each(?1)) AND ${boundary(pointer)}
      )
      SELECT seed.doc_uid AS predecessor_id,
        CASE WHEN ${correction} THEN 'verified_correction'
          WHEN ${thread} THEN 'same_thread_candidate' ELSE 'same_family_candidate' END AS discovery_reason,
        c.chunk_uid,c.doc_uid,c.text,d.title,d.source,d.source_id,d.uri,d.entity_slug,d.client,
        d.category,d.top_folder,d.platform,d.document_date,d.date_source,d.date_reliable,
        d.text_source,d.text_reliable,d.content_hash,d.meta AS authority_meta,
        c.text AS authority_document_head,COALESCE(src.kind,'unregistered') AS source_kind,0 AS score
      FROM seeds seed JOIN documents d ON d.doc_uid<>seed.doc_uid
      JOIN chunks c ON c.doc_uid=d.doc_uid AND c.chunk_ix=0
      LEFT JOIN sources src ON src.name=d.source
      WHERE ${boundary(pointer)}${memoryClause}
        AND d.entity_slug IS seed.entity_slug AND d.client IS seed.client
        AND (${correction} OR (d.date_reliable=1 AND d.document_date>seed.document_date AND (
          (${thread}) OR (d.source=seed.source AND ${family('seed')} IS NOT NULL AND ${family('d')}=${family('seed')})
        )))
      ORDER BY d.document_date DESC,d.doc_uid,seed.doc_uid LIMIT 101`)
      .bind(JSON.stringify(ids),...f.params,...s.params,...a.params).all();
  });
  let found;
  try { found = await run(currentMemorySql('d')); }
  catch (error) {
    if (await legacySchemaMayReadWithoutMemorySupersessions(env,error)) found = await run('',false);
    else {
      if (memorySupersessionIntegrityFailure(error)) throw error;
      // Discovery failure must not erase readable evidence or claim no successor.
      return rows.map(row => ({...row,selection:{state:'unknown',reason:'discovery_unavailable',
        newer_record:null,operative_record:null,checked_scope:'authorized_links_and_containers',complete:false}}));
    }
  }
  const neighbors = filterThinkCandidates((found.results || []).map(r=>({...r,snippet:r.text})),{question}).rows;
  const output = [], seen = new Set();
  const put = row => { if(!seen.has(row.doc_uid)){seen.add(row.doc_uid);output.push(row);} };
  for(const row of rows) {
    const candidates=neighbors.filter(n=>n.predecessor_id===row.doc_uid);
    const newer=candidates[0];
    put({...row,selection:{state:newer?'unresolved':'unknown',
      reason:newer?newer.discovery_reason:'no_verified_successor_found',
      newer_record:newer?{id:newer.doc_uid,date:newer.document_date!=null && Number.isFinite(Number(newer.document_date))?new Date(Number(newer.document_date)).toISOString():null,date_basis:newer.date_source || 'unverified'}:null,
      operative_record:null,checked_scope:'authorized_links_and_containers',complete:false}});
    // Keep the supporting candidate next to its seed, ahead of unrelated hits.
    // The answer must read both; a timestamp alone never selects governing terms.
    for(const next of candidates.slice(0,2)) {
      const {predecessor_id,discovery_reason,...candidate}=next;
      // Existing rows were assessed before fusion. Reassessing those rows can
      // mistake raw OCR for legacy native text; only new neighbors enter here.
      put({...assess(candidate),selection:{state:'unresolved',reason:discovery_reason,newer_record:null,
        operative_record:null,checked_scope:'authorized_links_and_containers',complete:false}});
    }
  }
  return output;
}

// Old labels remain searchable only as private seeds for exact verified edges.
// This separate bounded lane never exports the historical seed or authorizes a
// title/subject guess. It is disabled once overload recovery is selected.
export async function discoverCorrectionSearchSeeds(env,query,{filters={},scope=null,access=null}={}) {
  const terms=keywordSearchTerms(query);if(!terms)return [];
  const f=filterSql(filters,'c',2),s=scopeSql(scope,'d',f.nextParam),a=documentAccessSql(access,'c','d',s.nextParam);
  const boundary=pointer=>`d.deleted_at IS NULL${f.clause}${s.clause}${a.clause}${customApiVisibilitySql('d',pointer)}`;
  try {
    const result=await readWithCustomApiVisibility(env,pointer=>env.DB.prepare(`/* verified-correction-search */
      WITH correction_candidates AS MATERIALIZED (
        SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?1 LIMIT 400
      ), authorized_predecessors AS MATERIALIZED (
        SELECT DISTINCT d.doc_uid,d.content_hash FROM correction_candidates candidate
        JOIN chunks c ON c.id=candidate.rowid JOIN documents d ON d.doc_uid=c.doc_uid
        WHERE ${boundary(pointer)}
      )
      SELECT c.chunk_uid,c.doc_uid,c.text,d.title,d.source,d.source_id,d.uri,d.entity_slug,d.client,
        d.category,d.top_folder,d.platform,d.document_date,d.date_source,d.date_reliable,
        d.text_source,d.text_reliable,d.content_hash,d.meta AS authority_meta,
        c.text AS authority_document_head,COALESCE(src.kind,'unregistered') AS source_kind,0 AS score
      FROM authorized_predecessors seed
      JOIN memory_supersessions edge ON edge.predecessor_doc_uid=seed.doc_uid AND edge.predecessor_content_hash=seed.content_hash
      JOIN documents d ON d.doc_uid=edge.successor_doc_uid AND d.content_hash=edge.successor_content_hash
      JOIN chunks c ON c.doc_uid=d.doc_uid AND c.chunk_ix=0
      LEFT JOIN sources src ON src.name=d.source
      WHERE ${boundary(pointer)}${currentMemorySql('d')}
      ORDER BY d.document_date DESC,d.doc_uid LIMIT 50`)
      .bind(terms,...f.params,...s.params,...a.params).all());
    return filterThinkCandidates((result.results || []).map(row=>({...row,snippet:row.text})),{question:query}).rows;
  } catch(error) {
    if(await legacySchemaMayReadWithoutMemorySupersessions(env,error))return [];
    throw error;
  }
}
