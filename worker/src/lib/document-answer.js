import { calendarCancellationPresentation } from './calendar-cancellation.js';
import { documentEvidenceRevision, storedReadCoverage } from './document-read-coverage.js';
export * from './document-answer-reading.js';
import { moneyMinorText } from './money-format.js';
import { ownerConfidenceLine } from './confidence.js';
import { documentAccessSql, scopeSql, filterSql } from './store-d1.js';
import { customApiVisibilitySql, readWithCustomApiVisibility } from './custom-api-visibility.js';
import { withMicrosoftStatusText } from './microsoft-retained-status.js';
import { filterThinkCandidates } from './think-candidate-policy.js';
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


const DOCUMENT_READ_BYTES = 160_000;
const REQUEST_READ_BYTES = 2_000_000;
const SCREEN_DOCUMENT_BYTES = 1_000_000;
const SCREEN_REQUEST_BYTES = 24_000_000;

export const SENSITIVE_SCREENING_INCOMPLETE = Object.freeze({
  type: 'sensitive_screening_incomplete',
  detail: 'The sensitive-record check could not finish for some matching records. This answer uses the remaining screened evidence.',
  missing: 'A complete sensitive-record check for matching records that exceeded the read budget or could not be read.',
});

// Count only the authorized window plus one sentinel. Charge UTF-8 bytes
// and space for joined separators before returning text across the binding.
export async function readDocumentEvidence(env, rows, { access = null, scope = { all:true }, filters = {}, screening = null } = {}) {
  const readOne = async (row, budget, screenOnly = false) => {
    if (!env.DB || !row.doc_uid) return null;
    try {
      const a = documentAccessSql(access, 'c', 'd', 2);
      const s = scopeSql(scope, 'c', a.nextParam);
      const f = filterSql(filters, 'c', s.nextParam);
      const byteLimit = '?' + f.nextParam;
      // The calendar status is a closed metadata value read with the same
      // authorized row. It crosses the binding once, on the first row only,
      // and only as one of the values the cancellation presentation reads.
      const result = await readWithCustomApiVisibility(env, pointer => env.DB.prepare(
        `WITH authorized AS MATERIALIZED (
           SELECT c.id, c.doc_uid, c.chunk_ix, d.content_hash,
             CASE WHEN d.date_source IN ('calendar:event_start','calendar:all_day_start') AND json_valid(d.meta)
               THEN CASE WHEN json_extract(d.meta,'$.status') IN ('cancelled','confirmed','tentative')
                 THEN json_extract(d.meta,'$.status') END END AS calendar_status,
             CASE WHEN d.date_source IN ('calendar:event_start','calendar:all_day_start')
               THEN d.date_source END AS calendar_date_source
           FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid
           WHERE c.doc_uid=?1 AND d.deleted_at IS NULL${customApiVisibilitySql('d', pointer)}${a.clause}${s.clause}${f.clause}
           ORDER BY c.chunk_ix LIMIT 501
         ), counted AS (
           SELECT *, COUNT(*) OVER() AS bounded_chunks FROM authorized
         ), sized AS (
           SELECT a.*, SUM(length(CAST(c.text AS BLOB)) + 2) OVER (
             ORDER BY a.chunk_ix, a.id ROWS UNBOUNDED PRECEDING
           ) AS bytes_through, ROW_NUMBER() OVER (ORDER BY a.chunk_ix, a.id) AS position
           FROM counted a JOIN chunks c ON c.id=a.id
         )
         SELECT a.doc_uid, a.chunk_ix, a.content_hash, a.bounded_chunks AS total_chunks, a.bytes_through,
           CASE WHEN a.position=1 THEN a.calendar_status END AS calendar_status,
           CASE WHEN a.position=1 THEN a.calendar_date_source END AS calendar_date_source,
           CASE WHEN a.bytes_through <= ${byteLimit} THEN c.text END AS text
         FROM sized a JOIN chunks c ON c.id=a.id
         WHERE (a.bytes_through <= ${byteLimit} OR a.position=1)
           ${screenOnly ? 'AND a.position <= 500 /* sensitive-screen-window */' : ''}
         ORDER BY a.position`
      ).bind(row.doc_uid, ...a.params, ...s.params, ...f.params, budget).all());
      const chunks = (result?.results || []).filter(c => c.doc_uid === row.doc_uid);
      if (!chunks.length) return null;
      const read = chunks.slice(0,500).filter(chunk => typeof chunk.text === 'string');
      const storedText = read.map(c => c.text).join('\n\n');
      const total = Number(chunks[0].total_chunks);
      const revision = await documentEvidenceRevision(row.doc_uid,chunks[0].content_hash);
      const coverage = storedReadCoverage({id:row.doc_uid,revision,chunks:read,total,bounded:total>read.length,
        servedThrough:storedText.length,totalChars:storedText.length});
      if (total === 501) coverage.stored_chunk_count_is_lower_bound = true;
      return {
        storedText, coverage, revision,
        cancellation:calendarCancellationPresentation({...row,date_source:chunks[0].calendar_date_source},
          {status:chunks[0].calendar_status}),
        screenComplete:read.length === Math.min(total,500),
        bytes:typeof chunks.at(-1).text === 'string' ? chunks.at(-1).bytes_through || 0 : 0,
      };
    } catch { return null; }
  };

  const keyFor = row => JSON.stringify([row.doc_uid,row.evidence_revision || null]);
  const distinct = [...new Map(rows.filter(row => !screening || !row.retrieval_projection_incomplete)
    .map(row => [keyFor(row), row]))];
  const reads = new Map();
  let remaining = REQUEST_READ_BYTES;
  // Reserve both budgets before either query runs. Reclaim unused space for
  // later candidates in rank order, independent of D1 completion order.
  for (let i = 0; i < distinct.length; i += 2) {
    const pair = distinct.slice(i,i+2);
    const budget = Math.min(DOCUMENT_READ_BYTES, Math.floor(remaining / pair.length));
    const pages = await Promise.all(pair.map(([,row]) => readOne(row,budget)));
    for (const [index, [key]] of pair.entries()) {
      const page = pages[index];
      reads.set(key,page);
      remaining -= page?.bytes || 0;
    }
  }
  let remainingScreenBytes = SCREEN_REQUEST_BYTES;
  let incomplete = 0;
  let withheldCount = 0;
  const omittedIds = new Set();
  const omit = row => { if (row.doc_uid) omittedIds.add(row.doc_uid); };
  const reasons = new Set();
  const evidence = [];
  const admit = (row, screenText) => {
    // An excerpt already present in the screened body keeps its body context.
    // Separate hits outside that window still pass through the label screen.
    const candidate = screenText === undefined ? row : {
      ...row, snippet:screenText,
      retrieval_excerpts:outsideSnippet(row.retrieval_excerpts, screenText),
    };
    const decision = filterThinkCandidates([candidate], screening);
    if (decision.rows.length) evidence.push(row);
    else {
      withheldCount++;
      omit(row);
      for (const reason of decision.withheld.reasons) reasons.add(reason);
    }
  };
  for (const candidate of rows) {
    const {retrieval_projection_incomplete: projectionIncomplete, ...row} = candidate;
    const read = reads.get(keyFor(row));
    const retrieved = row.source_excerpts || [row.snippet || row.text || ''];
    // The D1 think projection carries a receipt even when all its fields fit.
    // A failed authorized read cannot clear admission for that candidate.
    if (screening && (projectionIncomplete || (projectionIncomplete !== undefined && !read) ||
        (row.evidence_revision && row.evidence_revision !== read?.revision))) {
      incomplete++;
      omit(row);
      continue;
    }
    if (!read) {
      const excerpt = {...row,snippet:withMicrosoftStatusText(retrieved[0], row.microsoft_provider_status),
        retrieval_excerpts:retrieved.slice(1),
        read_complete:false,read_coverage:{document_id:row.doc_uid,
        revision:row.evidence_revision || null,kind:'excerpt',stored_text_complete:false,
        source_complete:false,thread_complete:false,reason:'read_unavailable'}};
      if (screening) admit(excerpt);
      else evidence.push(excerpt);
      continue;
    }
    const sameRevision = !row.evidence_revision || row.evidence_revision === read.revision;
    const coverage = sameRevision ? read.coverage : {...read.coverage,
      stored_text_complete:false,kind:'excerpt',revision_changed:true};
    // A metadata-only row still verifies revision before retaining a hit.
    // The closed provider-status overlay is separate from stored-text coverage
    // and never changes its content hash or character count. A partial reading keeps
    // each hit's pure out-of-page spans separately, never retrieval labels.
    // Revision drift cannot reintroduce excerpts from the superseded read.
    const snippet = withMicrosoftStatusText(read.storedText || (sameRevision ? retrieved[0] : ''),
      row.microsoft_provider_status);
    const excerpts = sameRevision && !coverage.stored_text_complete ? outsideSnippet(retrieved, snippet) : [];
    const prepared = {...row,...read.cancellation,snippet,retrieval_excerpts:excerpts,
      evidence_revision:read.revision,read_coverage:coverage,read_complete:coverage.stored_text_complete};
    if (!screening) evidence.push(prepared);
    else if (read.screenComplete) admit(prepared);
    else {
      // Preserve cross-chunk matches and opening context in the old window.
      // Only one transient window is held, and its revision must match.
      const budget = Math.min(SCREEN_DOCUMENT_BYTES, remainingScreenBytes);
      const page = budget > 0 && read.revision ? await readOne(row, budget, true) : null;
      remainingScreenBytes -= page?.bytes || 0;
      if (!page?.screenComplete || page.revision !== read.revision ||
          page.coverage.expected_stored_chunks !== coverage.expected_stored_chunks) {
        incomplete++;
        omit(row);
      } else admit(prepared, page.storedText);
    }
  }
  if (!screening) return evidence;
  const permitted = evidence.map(row => {
    if (!omittedIds.has(row.selection?.newer_record?.id)) return row;
    return {...row, selection:{...row.selection,state:'unknown',reason:'discovery_unavailable',
      newer_record:null,operative_record:null,complete:false}};
  });
  return { rows:permitted, incomplete, withheld:withheldCount ? {
    count:withheldCount,examined_count:rows.length,reasons:[...reasons].sort(),
  } : undefined };
}

const text = value => String(value || '').replace(/\s+/g, ' ').trim();

function outsideSnippet(excerpts, snippet) {
  if (!excerpts.length) return [];
  const normalized = text(snippet);
  return excerpts.filter(span => span && !normalized.includes(text(span)));
}
