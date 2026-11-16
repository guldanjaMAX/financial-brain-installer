import { documentEvidenceRevision, storedReadCoverage } from './document-read-coverage.js';
export * from './document-answer-reading.js';
import { moneyMinorText } from './money-format.js';
import { ownerConfidenceLine } from './confidence.js';
import { documentAccessSql, scopeSql, filterSql } from './store-d1.js';
import { customApiVisibilitySql, readWithCustomApiVisibility } from './custom-api-visibility.js';
import { unknownMoneyConfidence } from './money-confidence.js';

// Keep the compatibility reader's arithmetic. It does not return the money
// tools' feed/freshness confidence assessment, so that missing assessment is
// scored zero rather than inferring certainty from a successful ledger read.
export function finalizeOwnerLedgerAnswer(body) {
  const unassessed = unknownMoneyConfidence(
    'The recorded ledger reading has no connection, freshness and ambiguity confidence assessment.',
    'The money-tool assessment of connected accounts, synced dates, missing periods and uncertain movements.');
  const basis = [...unassessed.reasons, ...(body.ledger?.qualification ? [body.ledger.qualification] : []), ...(body.gaps || []).map(g => g.detail).filter(Boolean).map(reason => String(reason).replace(/\s+/g, ' '))];
  const ledger = body.ledger || {};
  const missing = [...unassessed.missing, ...(body.gaps || []).map(gap => gap.missing).filter(Boolean), ...(ledger.coverage?.required_statements || []), ...(ledger.excluded_accounts || []).map(account =>
    `Account ${account.account_mask ? `ending ${account.account_mask}` : 'with unverified ending digits'}: ${account.reason === 'balance_unavailable' ? 'no recorded balance observation' : account.reason || 'coverage unverified'}; its missing dollar impact is unknown.`)];
  const confidence = {...unassessed,band:unassessed.level,basis,missing};
  const masks = [...new Set((ledger.accounts || []).map(a => a.account_mask || a.mask).filter(Boolean))];
  const snapshots = (ledger.accounts || []).filter(a => a.as_of).map(a => `ending ${a.account_mask || 'unverified'}: ${a.as_of}`);
  const dates = ledger.from || ledger.to ? `Dates: ${ledger.from || 'from date unverified'} through ${ledger.to || 'through date unverified'}.`
    : snapshots.length ? `Recorded snapshot dates: ${snapshots.join('; ')}.` : 'From/through dates unverified.';
  const coverage = `Accounts: ${masks.length ? masks.map(m => `ending ${m}`).join(', ') : 'account scope unverified'}. ${dates}`;
  const answer = typeof body.answer === 'string' && body.answer.trim() ? body.answer
    : 'This bank reading contains no quantified amount for the requested scope; the account or period evidence is incomplete.';
  const paymentParts = ledger.parts || ledger.months || [ledger];
  const payments = paymentParts.flatMap(part => {
    const primary = [...(part.possible_payments || []), ...(part.possible_transfers || [])];
    const represented = new Set(primary.map(row => row.n));
    return [...primary, ...(part.uncertain_components || []).filter(row => !represented.has(row.n))];
  });
  const paymentImpact = payments.length ? payments.map(row => {
    const endings = (row.connected_counterpart_masks || []).filter(Boolean).map(mask => `ending ${mask}`).join(', ');
    const kind = row.payment_kind === 'own_account' ? 'a transfer to your own account' : `a ${row.payment_kind || 'card'} payment`;
    if (row.uncertainty_only) return `$${moneyMinorText(row.amount_minor, 'USD')} observed movement candidate; membership in the requested measure is unconfirmed.`;
    return `$${moneyMinorText(row.amount_minor, 'USD')}${row.included_in_total ? ' included' : ' not counted as spending'}, possibly ${kind}${endings ? ` to the connected account ${endings}` : ''}${row.destination_unconfirmed && row.included_in_total ? '; up to this amount may be counted twice' : ''}.`;
  }).join(' ') : Number.isSafeInteger(ledger.classification_uncertain_minor) ? `$${moneyMinorText(ledger.classification_uncertain_minor, 'USD')} may be a card payment (unconfirmed); confirm account types and payment membership with original statements.` : null;
  return {...body,answer_error:undefined,status:undefined,
    answer:answer + `\n\nCoverage: ${coverage}\nMissing or counted twice: ${confidence.missing.join(' ')} ${paymentImpact || 'Missing or duplicate dollar impact is unknown.'}\nEstimates: Recorded amounts retain the ledger reader's classifications; unproved movements and present completeness remain unverified.\nHow to check: Compare the named accounts and period with original statements and complete the money-tool evidence assessment.`,
    confidence,confidence_text:ownerConfidenceLine(confidence),answer_contract:{version:1,kind:'ledger'}};
}

// Reapply access at the text read, including custom-API current pointers. The
// returned identity came from authorized retrieval, never from model prose.
// Read whole chunks, with an explicit partial receipt when the page is bounded.
export async function readDocumentEvidence(env, rows, { access = null, scope = { all:true }, filters = {} } = {}) {
  const cache = new Map();
  const readOne = async row => {
    if (!env.DB || !row.doc_uid) return null;
    try {
      const a = documentAccessSql(access, 'c', 'd', 2);
      const s = scopeSql(scope, 'c', a.nextParam);
      const f = filterSql(filters, 'c', s.nextParam);
      const result = await readWithCustomApiVisibility(env, pointer => env.DB.prepare(
        `SELECT c.doc_uid, c.chunk_ix, c.text, d.content_hash, COUNT(*) OVER() AS total_chunks
         FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid
         WHERE c.doc_uid=?1 AND d.deleted_at IS NULL${customApiVisibilitySql('d', pointer)}${a.clause}${s.clause}${f.clause}
         ORDER BY c.chunk_ix LIMIT 501`
      ).bind(row.doc_uid, ...a.params, ...s.params, ...f.params).all());
      const chunks = (result?.results || []).filter(c => c.doc_uid === row.doc_uid);
      if (!chunks.length) return null;
      const read = chunks.slice(0,500);
      return {chunks:read,total:Number(chunks[0].total_chunks),bounded:chunks.length>500,
        storedText:read.map(c=>c.text).join('\n\n'),
        revision:await documentEvidenceRevision(row.doc_uid,chunks[0].content_hash)};
    } catch { return null; }
  };
  const output = new Array(rows.length);
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(2,rows.length)},async()=>{
    while(cursor<rows.length) {
      const index=cursor++,row=rows[index];
      const key=JSON.stringify([row.doc_uid,row.evidence_revision || null]);
      if(!cache.has(key)) cache.set(key,readOne(row));
      // Cache only the database snapshot. Each hit can carry a different
      // authorized span beyond chunk 500, and must retain its own metadata.
      const read=await cache.get(key);
      const retrieved=row.source_excerpts || [row.snippet || row.text || ''];
      if(!read) {
        output[index]={...row,snippet:retrieved[0],retrieval_excerpts:retrieved.slice(1),
          read_complete:false,read_coverage:{document_id:row.doc_uid,
          revision:row.evidence_revision || null,kind:'excerpt',stored_text_complete:false,
          source_complete:false,thread_complete:false,reason:'read_unavailable'}};
        continue;
      }
      const sameRevision=!row.evidence_revision || row.evidence_revision===read.revision;
      const snippet=read.storedText;
      const coverage=storedReadCoverage({id:row.doc_uid,revision:read.revision,chunks:read.chunks,
        total:read.total,bounded:read.bounded,servedThrough:snippet.length,totalChars:snippet.length});
      if(!sameRevision) {
        coverage.stored_text_complete=false;coverage.kind='excerpt';coverage.revision_changed=true;
      }
      // Complete readings contain source chunks alone. A partial reading keeps
      // each hit's pure out-of-page spans separately, never retrieval labels.
      // Revision drift cannot reintroduce excerpts from the superseded read.
      const excerpts=sameRevision && !coverage.stored_text_complete
        ? retrieved.filter(span=>span && !text(snippet).includes(text(span))) : [];
      output[index]={...row,snippet,retrieval_excerpts:excerpts,
        evidence_revision:read.revision,read_coverage:coverage,read_complete:coverage.stored_text_complete};
    }
  }));
  return output;
}


const text = value => String(value || '').replace(/\s+/g, ' ').trim();
