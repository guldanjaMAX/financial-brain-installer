// Revision identity is bound to the exact record, rather than exporting the
// corpus dedupe hash. Missing revision proof never earns complete coverage.
export async function documentEvidenceRevision(id, hash) {
  if (!id || !/^[a-f0-9]{64}$/.test(String(hash || ''))) return null;
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${id}\u0000${hash}`));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export function storedReadCoverage({id,revision,chunks,total,bounded=false,servedFrom=0,servedThrough=null,totalChars=null}) {
  const indices=chunks.map(c=>c.chunk_ix);
  const contiguous=indices.length>0 && indices.every((ix,i)=>Number.isSafeInteger(ix)&&ix===i);
  const allStored=Boolean(revision) && contiguous && !bounded && Number(total)===chunks.length;
  const servedAll=servedFrom===0 && (totalChars===null || servedThrough===totalChars);
  return {document_id:id,revision,kind:allStored&&servedAll?'whole_stored_record':'excerpt',
    stored_text_complete:allStored&&servedAll,source_complete:false,
    source_coverage:'extraction_and_original_page_coverage_unverified',
    chunk_indices:indices,expected_stored_chunks:Number.isSafeInteger(Number(total))?Number(total):null,
    contiguous,omitted_stored_chunks:Math.max(0,Number(total)-chunks.length)||0,
    served_from:servedFrom,served_through:servedThrough,total_chars:totalChars,
    thread_complete:false};
}
