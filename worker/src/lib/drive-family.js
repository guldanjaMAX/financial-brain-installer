import { jsonResponse, privateNoStore } from './core.js';

/** Read one physical base and at most one part candidate in one snapshot.
 * Ambiguous legacy parts also hold coverage: absence, rather than a guessed
 * family expansion or deletion preview, is the proof this narrow check needs.
 */
export async function handleDriveFamily(env, request) {
  const reply = (body, status = 200) => privateNoStore(jsonResponse(body, status));
  const invalid = () => reply({ error: 'Drive family readback needs one exact source and file identity.' }, 400);
  if (!request.body) return invalid();
  const reader = request.body.getReader(), chunks = [];
  let length = 0, body;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) { await reader.cancel(); return invalid(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return invalid(); }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'file_id,source' ||
      typeof body.source !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.source) ||
      typeof body.file_id !== 'string' || !/^[A-Za-z0-9_-]{1,250}$/.test(body.file_id)) return invalid();
  const uid = `${body.source}:${body.file_id}`;
  const row = await env.DB.prepare(`SELECT /* drive_family_base */ doc_uid,source,source_id,deleted_at,meta,
    (SELECT doc_uid FROM documents WHERE doc_uid >= ?2 AND doc_uid < ?3 ORDER BY doc_uid LIMIT 1) AS part_candidate
    FROM documents WHERE doc_uid = ?1 LIMIT 1`).bind(uid, `${uid}#part`, `${uid}#paru`).first();
  let meta;
  try { meta = JSON.parse(row?.meta); } catch { /* unknown provenance holds coverage */ }
  const same = row?.doc_uid === uid && row.source === body.source && row.source_id === body.file_id &&
    row.deleted_at === null && !row.part_candidate && meta && typeof meta === 'object' && !Array.isArray(meta) &&
    !Object.hasOwn(meta, 'part_of') && !Object.hasOwn(meta, 'family_of');
  return reply({ source: body.source, file_id: body.file_id, base_doc_uid: uid, same_identity_single_part: Boolean(same) });
}
