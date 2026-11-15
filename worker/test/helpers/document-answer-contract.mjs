import assert from 'node:assert/strict';
import { answerSentences } from '../../src/lib/answer-sentences.js';
const flat = value => String(value).replace(/\s+/g, ' ').trim();
const clause = value => flat(String(value).replace(/\[\d+\]/g,'')).replace(/[.\s]+$/,'');
const recordDate = row => {
  const calendar=['calendar:event_start','calendar:all_day_start'].includes(row.date_source);
  const observation=calendar ? row.record_observation || {} : row;
  return (observation.ts ? `${String(observation.ts).slice(0,10)}${observation.date_reliable ? '' : ' (date unverified)'}` : 'date unverified') +
    (row.question_time ? `; ${calendar ? 'event ' : ''}${row.question_time}` : '');
};
function statements(value) {
  const raw = String(value || '');
  let dot = '\uE000';
  while (raw.includes(dot)) dot += '\uE000';
  // JSON-quoted party labels can end in "Inc." before a colon. Protect that
  // punctuation only during splitting, then restore every original byte so
  // the oracle still rejects different labels, amounts and citations.
  const protectedText = raw.replace(/"(?:\\.|[^"\\])*"/g, label => label.replaceAll('.',dot));
  return answerSentences(protectedText).map(sentence => sentence.replaceAll(dot,'.'));
}

const ESTIMATES = new Set([
  'The cited statements are record evidence; present status and completeness remain unverified.',
  'Likely record relevance; attributed statements are not confirmation of your identity, present status or bank payment.',
]);
const HOW_TO_CHECK = new Set([
  'Open the cited originals and reconcile their dates, subjects and figures.',
  'Complete the source search and read the matching originals.',
]);
const UNCITED_HEADERS = [
  'Newer retrieved records were not cited in the draft:',
  'Retrieved records that are not provably older, or that name the same subject, were not cited in the draft:',
];
// The books readers' fixed scope notices (the closed list in money-veto.js
// and quickbooks-money.js). They state limits, never a figure, and are
// accepted only verbatim.
const BOOKS_NOTICES = new Set([
  ...['accounts', 'invoices', 'bills'].flatMap(noun => [
    `Lists only ${noun} found in the retrieved evidence, not a complete QuickBooks inventory.`,
    `Lists only ${noun} found in the retrieved evidence with positive open balances, not a complete QuickBooks inventory.`]),
  'Lists only records found in the retrieved evidence, not a complete QuickBooks inventory.',
  'The documents do not establish a complete list or a company-wide total.',
  'The documents do not establish the requested total.',
  'Check QuickBooks for the complete list.',
  'Amounts are per item.',
  'Credit memos and credit balances are not netted.',
  'No company-wide or net amount owed is established.',
]);
const RUNG4_FIXED = new Set([
  'The available reading contains no readable matching statement.',
  'No permitted readable text was available for this question; their contents remain unverified.',
]);
const MISSING_SUFFIX = ' Any monetary impact or duplicate amount is unknown unless stated in the quoted records.';
const figureValues = value => (String(value).replace(/\[\d+\]/g,'').match(/\d[\d,]*(?:\.\d+)?/g) || []).map(v => v.replace(/,/g,''));
// A list of record labels joined by ", " must be made only of known labels.
function joinedFrom(value, labels) {
  if (value === '') return true;
  return [...labels].sort((a,b) => b.length-a.length).some(label =>
    value === label || value.startsWith(`${label}, `) && joinedFrom(value.slice(label.length+2), labels));
}

// The whole response is consumed: nothing may follow the four contract lines,
// and each contract line is the finalizer's template filled only from this
// body's own metadata. An extra amount anywhere in the response fails.
function assertContract(body, suffix) {
  const lines = suffix.split('\n');
  assert.equal(lines.length, 4, 'the answer ends with exactly the four contract lines');
  const [coverage, missing, estimates, check] = lines;
  const contract = body.answer_contract;
  const m = /^Coverage: Read (\d+) of (\d+) retrieved records from (.+), dated (.+)\.$/.exec(coverage);
  assert.ok(m, `the coverage line is the finalizer template: ${coverage}`);
  assert.equal(Number(m[1]), contract.read_count, 'coverage states the records actually read');
  assert.equal(Number(m[2]), contract.retrieved_count, 'coverage states the records retrieved');
  const rows = [...(body.results || []), ...(body.citations || [])];
  const sources = new Set(rows.map(row => row.source).filter(Boolean));
  assert.ok(m[3] === 'sources unverified' || joinedFrom(m[3], sources), `coverage names only record sources: ${m[3]}`);
  const dates = new Set(rows.map(recordDate));
  assert.ok(m[4] === 'dates unverified' || joinedFrom(m[4], dates), `coverage names only record dates: ${m[4]}`);
  assert.equal(missing, `Missing or counted twice: ${body.confidence.missing.join(' ')}${MISSING_SUFFIX}`,
    'the missing line is exactly the confidence object\'s missing evidence');
  const metadata = JSON.stringify([body.gaps, body.evidence_gate, body.withheld_documents, body.meaning_search, body.time_window,
    rows.map(row => [row.title, row.snippet, row.retrieval_excerpts, row.ts, row.record_observation, row.source])]).replace(/(\d),(?=\d{3}\b)/g, '$1');
  for (const value of figureValues(missing)) assert.ok(metadata.includes(value), `a figure in the missing line comes from this body's metadata: ${value} in ${missing}`);
  assert.ok(estimates.startsWith('Estimates: ') && ESTIMATES.has(estimates.slice(11)), `the estimates line is a fixed template: ${estimates}`);
  assert.ok(check.startsWith('How to check: ') && HOW_TO_CHECK.has(check.slice(14)), `the check line is a fixed template: ${check}`);
}

// A retired null/unchanged-draft assertion now checks the owner's actual
// source reading. Amounts, currency, account masks and payer identity remain
// exact; a model-approved wrong draft never establishes source truth. With
// exact, an admitted answer must equal the expected answer byte for byte and
// an attributed answer may contain nothing but its validated source quotes.
export function assertDocumentAnswer(body, { expected, provisional = false, empty = false, exact = false } = {}) {
  assert.equal(typeof body.answer, 'string');
  assert.ok(body.answer.trim());
  assert.equal(body.answer_error, undefined);
  assert.notEqual(body.status, 'answer_withheld');
  assert.equal(body.answer_contract?.kind, 'document');
  const c = body.confidence;
  assert.ok(Number.isInteger(c?.percent));
  assert.equal(c.band, c.percent >= 90 ? 'High' : c.percent >= 70 ? 'Medium' : 'Low');
  assert.ok(c.basis?.length && c.missing?.length);
  assert.match(body.confidence_text, /Confidence: (?:High|Medium|Low) \(\d+%\).*Why:.*Missing:/s);
  assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  if (provisional) assert.ok(c.percent < 90);
  const split = body.answer.indexOf('\n\nCoverage: ');
  assert.ok(split >= 0, 'the contract follows the answer');
  const prose = body.answer.slice(0, split);
  assertContract(body, body.answer.slice(split + 2));
  const quotes = [...prose.matchAll(/says: ("(?:\\.|[^"\\])*") \[(\d+)\]/g)];
  if (provisional && !empty) assert.ok(quotes.length, 'a provisional answer attributes readable source text');
  for (const match of quotes) {
    const source = body.results?.[Number(match[2]) - 1];
    assert.ok(source, 'the attributed quote resolves to a retrieved source');
    assert.ok([source.snippet,...(source.retrieval_excerpts || [])].some(span=>flat(span).includes(flat(JSON.parse(match[1])))),
      'every quoted figure and subject is in one exact source span');
  }
  // A valid quote cannot license an extra owner-payment claim or amount.
  // Remove only complete attribution lines, then bind every remaining numeric
  // or financial statement to an expected statement or an intact source clause.
  const attributions = [...prose.matchAll(/^(?:Likely relevant: )?As of (.*?), the record ("(?:\\.|[^"\\])*") says: "(?:\\.|[^"\\])*" \[(\d+)\]\.$/gm)];
  const excerpts=[...prose.matchAll(/^An additional retrieved excerpt from the same record says: ("(?:\\.|[^"\\])*") \[(\d+)\]\.$/gm)];
  assert.equal(attributions.length+excerpts.length,quotes.length,'each source quote has a complete attribution');
  let residual = prose;
  for (const excerpt of excerpts) {
    const source=body.results?.[Number(excerpt[2])-1];
    assert.ok(attributions.some(attribution=>attribution[3]===excerpt[2]),'an additional excerpt retains its primary record attribution');
    assert.ok((source?.retrieval_excerpts || []).some(span=>flat(span)===flat(JSON.parse(excerpt[1]))),
      'an additional quote is exactly one authorized retrieval span');
    residual=residual.replace(excerpt[0],'');
  }
  for (const attribution of attributions) {
    const source = body.results?.[Number(attribution[3])-1];
    const title = JSON.parse(attribution[2]);
    assert.equal(attribution[1],recordDate(source),'the attribution date remains source metadata');
    assert.ok(title === String(source.title || 'Untitled record').slice(0,140) ||
      source.source_kind === 'quickbooks' && title === 'QuickBooks record (party label unverified)',
      'the attribution title remains source metadata');
    residual = residual.replace(attribution[0],'');
  }
  const gapNotice = (body.gaps || []).map(gap => flat(String(gap.detail || '').replace(/\[\d+\]/g,''))).filter(Boolean);
  // The application's "Heads up:" line is composed from computed gaps. It is
  // removed only when every one of its sentences is a sentence of this
  // body's own gap details; anything else stays and must validate below.
  const gapText = gapNotice.join(' ');
  // A gap detail can span lines, so the Heads up block runs to the paragraph end.
  residual = residual.split(/\n\s*\n/).filter(paragraph => {
    const heads = /^Heads up: ([\s\S]+)$/.exec(paragraph.trim());
    return !(heads && statements(flat(heads[1])).every(sentence => gapText.includes(flat(sentence))));
  }).join('\n\n');
  residual = flat(residual);
  for (const detail of gapNotice) residual = residual.replace(detail,'');
  for (const [index,row] of (body.results || []).entries()) {
    residual = residual.replace(`"${row.title}" (${recordDate(row)}) [${index+1}]; its statement is included above.`,'');
  }
  // The finalizer's fixed section headers for uncited records.
  for (const header of UNCITED_HEADERS) residual = residual.split(header).join('');
  residual = flat(residual);
  const expectedStatements = statements(expected || '').map(flat);
  if (exact) {
    if (flat(prose) === flat(expected)) assert.equal(prose, String(expected), 'an admitted answer is exactly the expected answer');
    else assert.equal(residual, '', `an attributed answer contains only validated source quotes: ${residual}`);
  }
  // Closed world: every remaining sentence, with or without a figure, is an
  // expected statement, an intact clause of the record it cites, or a fixed
  // finalizer template. "The invoice is unpaid." cannot ride along unseen.
  for (const sentence of statements(residual)) {
    if (BOOKS_NOTICES.has(sentence)) continue;
    if (empty && body.answer_contract.rung === 4) {
      // Retrieval counts describe a bounded search, never a money observation.
      const count = body.answer_contract.retrieved_count;
      const sourceName = '[\\w.-]+';
      const sourceList = `(?:${sourceName}(?:, ${sourceName})*|the requested sources \\(source inventory unverified\\))`;
      const timestamp = '\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)?';
      const through = `(?:dates unverified|${sourceName}: ${timestamp}(?:, ${sourceName}: ${timestamp})*)`;
      if (count === 0 && new RegExp(`^Not found in 0 records returned by this search from ${sourceList}, read through ${through}\\.$`).test(sentence)) continue;
      if (body.withheld_documents?.count > 0 && sentence === `${body.withheld_documents.count} retrieved record(s) reached the sensitive-record screen.`) continue;
      if (sentence === `${count} record(s) were returned; the search is incomplete and matching records may be missing.` ||
          sentence === `${count} record(s) were returned; their missing text is unverified.`) continue;
      if (RUNG4_FIXED.has(sentence)) continue;
    }
    const cited = [...sentence.matchAll(/\[(\d+)\]/g)].map(match => body.results?.[Number(match[1])-1]);
    // A sentence with no figure or money word may also be an expected
    // statement verbatim; a figure always needs its cited record.
    const figure = /\d|[$€£]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|dollars?|cents?|paid|spent|owed|charged|balance|payment)\b/i.test(sentence);
    if (!figure && expectedStatements.includes(flat(sentence))) continue;
    assert.ok(cited.length && cited.every(Boolean), `every statement resolves to its cited record: ${sentence}`);
    const sourceStatements = cited.flatMap(row => statements(row.snippet || '').map(clause));
    assert.ok(expectedStatements.includes(flat(sentence)) || sourceStatements.includes(clause(sentence)),
      `every stated figure, payer, account and period must belong to a grounded complete statement: ${sentence}`);
  }
  if (expected !== undefined) {
    // Preserve every original figure assertion even when new attribution
    // changes grammar. Currency/sign/unit and owner identity are not erased.
    const claim = String(expected).replace(/\[\d+\]/g, '').replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})\b(?:, (\d{4}))?/g, (date, month, day, year) => {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const suffix = `${String(months.indexOf(month)+1).padStart(2,'0')}-${day.padStart(2,'0')}`;
      assert.ok(year ? prose.includes(`${year}-${suffix}`) : new RegExp(`\\d{4}-${suffix}`).test(prose), `the cited date remains: ${date}`);
      return '';
    }).replace(/\b\d{4}-\d{2}-\d{2}\b/g, date => {
      assert.ok(prose.includes(date), `the exact source date remains: ${date}`);
      return '';
    });
    for (const m of claim.matchAll(/(?:[-$€£]|USD\s*|CAD\s*)?\d+(?:,\d{3})*(?:\.\d+)?(?:%|[kmb]|\s*(?:thousand|million|billion)|\/(?:month|year))?/gi)) {
      const escaped = m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(prose, new RegExp(`(?<![-+\\d])${escaped}(?![\\p{L}\\p{N}]|[.,]\\d)`, 'u'), `the original exact figure remains: ${m[0]}`);
    }
    for (const m of claim.matchAll(/Payer\s+[A-Z][a-z]+|(?:card|account)\s+ending\s+\d+/gi)) {
      assert.ok(prose.toLowerCase().includes(m[0].toLowerCase()), `the original payer or account remains: ${m[0]}`);
    }
    if (!quotes.length) assert.ok(flat(prose).includes(flat(expected)), 'an unattributed answer preserves the approved fact');
  }
}

// Compare the finalized owner surface with a completed compatibility reading.
// Every ledger field and displayed amount stays exact across the boundary.
export function assertLedgerAnswer(body, expected) {
  assert.ok(expected.ledger || expected.code && expected.evidence_gate?.complete === false, 'a populated compatibility decision or typed limitation was reached');
  for (const key of ['ledger','citations','results','gaps','evidence_gate']) assert.deepEqual(body[key], expected[key], key);
  assert.equal(body.answer_contract?.kind, 'ledger');
  const prose = expected.answer || 'This bank reading contains no quantified amount for the requested scope; the account or period evidence is incomplete.';
  assert.ok(body.answer.startsWith(prose + '\n\nCoverage: '), 'the recorded reading stays verbatim');
  const [coverage,missing,estimates,check] = body.answer.slice(prose.length + 2).split('\n');
  const masks = new Set((expected.ledger?.accounts || []).map(a => String(a.account_mask || a.mask)).filter(m => m && m !== 'undefined'));
  for (const [,mask] of coverage.matchAll(/ending (\d+)/g)) assert.ok(masks.has(mask), 'coverage cannot invent an account');
  for (const key of ['from','to']) if (expected.ledger?.[key]) assert.ok(coverage.includes(expected.ledger[key]), 'coverage retains the recorded period');
  const paymentParts = expected.ledger?.parts || expected.ledger?.months || [expected.ledger || {}];
  const payments = paymentParts.flatMap(part => {
    const primary = [...(part.possible_payments || []), ...(part.possible_transfers || [])];
    const represented = new Set(primary.map(row => row.n));
    return [...primary, ...(part.uncertain_components || []).filter(row => !represented.has(row.n))];
  });
  const dollars = value => '$' + (value / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const paymentLines = payments.map(row => {
    const endings = (row.connected_counterpart_masks || []).filter(Boolean).map(mask => `ending ${mask}`).join(', ');
    const kind = row.payment_kind === 'own_account' ? 'a transfer to your own account' : `a ${row.payment_kind || 'card'} payment`;
    if (row.uncertainty_only) return `${dollars(row.amount_minor)} observed movement candidate; membership in the requested measure is unconfirmed.`;
    return `${dollars(row.amount_minor)}${row.included_in_total ? ' included' : ' not counted as spending'}, possibly ${kind}${endings ? ` to the connected account ${endings}` : ''}${row.destination_unconfirmed && row.included_in_total ? '; up to this amount may be counted twice' : ''}.`;
  });
  assert.equal(missing, 'Missing or counted twice: ' + body.confidence.missing.join(' ') + ' ' +
    (paymentLines.length ? paymentLines.join(' ') : Number.isSafeInteger(expected.ledger?.classification_uncertain_minor) ? `${dollars(expected.ledger.classification_uncertain_minor)} may be a card payment (unconfirmed); confirm account types and payment membership with original statements.` : 'Missing or duplicate dollar impact is unknown.'));
  assert.equal(estimates, "Estimates: Recorded amounts retain the ledger reader's classifications; unproved movements and present completeness remain unverified.");
  assert.equal(check, 'How to check: Compare the named accounts and period with original statements and complete the money-tool evidence assessment.');
  assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.equal(body.confidence?.percent, 0, 'a compatibility read cannot invent the missing feed assessment');
  assert.match(body.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
  assert.deepEqual(body.answer.match(/-?\$[\d,]+\.\d+/g) || [], [...(prose.match(/-?\$[\d,]+\.\d+/g) || []), ...payments.map(row => dollars(row.amount_minor)), ...(paymentLines.length || !Number.isSafeInteger(expected.ledger?.classification_uncertain_minor) ? [] : [dollars(expected.ledger.classification_uncertain_minor)])], 'only the declared possible-payment dollars enter the footer');
}
