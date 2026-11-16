import { legacyDocumentResponse } from './document-answer-reading.js';
// Deterministic evidence rubric. The document finalizer adds explicit reasons,
// missing evidence and caps for failed checks, incomplete reads and search gaps.
// Owner surfaces render the same score; model prose may only lower it.

import { independentEvidenceSummary } from "./evidence-lineage.js";

// Owner-facing bands use the founder's contract. Legacy engine scoring stays
// available to existing consumers; connector rendering must not raise a score.
export function ownerConfidence(confidence) {
  const percent = Math.max(0,Math.min(100,Math.floor(Number(confidence?.percent) || 0)));
  return { ...confidence, percent, band:percent>=90?'High':percent>=70?'Medium':'Low',
    missing:confidence?.missing ?? ['Independent verification and complete relevant source coverage.'] };
}

// Retrieval rows have not passed the answer evidence gate. Score only the
// observed reading quality, without borrowing the gate-approved baseline.
export function documentConfidence({ rows = [], gaps = [], degraded = null, unavailable = false, partial = false } = {}) {
  const basis = [], missing = ['The complete relevant document set and independent verification of the answer.'];
  let percent = rows.length ? 80 : 20;
  basis.push(`${rows.length} retrieved record${rows.length===1?'':'s'}; retrieval alone does not verify an answer.`);
  if (!rows.length) missing.push('A matching readable source record.');
  if (rows.some(r=>!(r.date_reliable===true || r.date_reliable===1) || !(r.ts || r.date))) {
    percent-=10; basis.push('At least one record has no reliable date.'); missing.push('Reliable dates for the returned records.');
  }
  if (rows.some(r=>!(r.text_reliable===true || r.text_reliable===1) || r.text_source==='ocr_partial')) {
    percent-=15; basis.push('At least one record has an unverified or partial text reading.'); missing.push('A complete reliable reading of each source.');
  }
  if (partial || gaps.length) {
    percent-=15; basis.push('Declared source coverage or the document page is incomplete.'); missing.push('The missing source periods or remaining document pages.');
  }
  const adjust = gapAdjustments(gaps,degraded);
  percent+=adjust.delta; basis.push(...adjust.basis);
  if (degraded) missing.push('A healthy complete retrieval over the relevant sources.');
  if (unavailable) { percent=Math.min(percent,30); basis.push('Document search is unavailable or incomplete.'); missing.push('A completed search and readable source evidence.'); }
  return { ...ownerConfidence({percent:Math.max(0,percent)}), basis, missing };
}

// Confidence in rejecting a candidate is not confidence in answering the
// owner's question. Ignore the old refusal rubric at both connector surfaces.
export function unansweredDocumentConfidence(options = {}) {
  const score = documentConfidence(options);
  return {...score,...ownerConfidence({...score,percent:Math.min(30,score.percent)}),
    basis:['No record read here answers the question.',...score.basis],
    missing:['A record that states the answer.',...score.missing]};
}

export function ownerConfidenceLine(confidence) {
  const score = ownerConfidence(confidence);
  const basis = confidence?.basis ?? confidence?.reasons ?? ['No confidence assessment was returned.'];
  const missing = confidence?.missing ?? ['Independent verification and complete relevant source coverage.'];
  const clauses = values => values.map(value=>String(value).replace(/[.\s]+$/,'')).join('; ');
  return `Confidence: ${score.band} (${score.percent}%). Why: ${clauses(basis)}. Missing: ${clauses(missing)}.`;
}

// A legacy refusal score measured rejection, not the answer. Current Workers
// send the final contract and its score; compatibility replies must be scored
// from the actual reading rather than importing that retired refusal rubric.
export function documentResponseConfidence(body) {
  if (body.ledger) return { ...ownerConfidence(body.confidence), percent: 0, band: 'Low', level: 'Low',
    basis: ['The compatibility ledger reading has no money-tool confidence assessment.', ...(body.confidence?.basis || [])],
    missing: body.confidence?.missing || ['The money-tool assessment of connected accounts, synced dates, missing periods and uncertain movements.'] };

  // Missing legacy status cannot hide a declared reading gap. Score that
  // evidence without replacing the independent document or bank prose.
  const incomplete = !body.answer_contract && (body.gaps?.length || body.evidence_gate &&
    (body.evidence_gate.supported !== true || body.evidence_gate.complete !== true));
  const scoredBody = incomplete && !body.status && !body.degraded ? { ...body, status: 'coverage_incomplete' } : body;
  const legacy = legacyDocumentResponse(scoredBody);
  if (legacy !== scoredBody) return legacy.confidence;
  const options = { rows:body.results || [], gaps:body.gaps || [], degraded:body.degraded,
    unavailable:body.status === 'search_unavailable' };
  const score = !body.answer_contract && (!body.answer || /^The documents do not answer/i.test(body.answer))
    ? unansweredDocumentConfidence(options)
    : body.confidence ? ownerConfidence(body.confidence) : documentConfidence(options);
  return Number.isFinite(body.confidence?.percent) && body.confidence.percent < score.percent
    ? { ...score, ...ownerConfidence({ ...score, percent: body.confidence.percent }) } : score;
}

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Math.round(value)));

function band(percent) {
  return percent >= 90 ? "High" : percent >= 70 ? "Medium" : "Low";
}

/** Shared gap penalties: what the corpus admits it cannot see. */
function gapAdjustments(gaps, degraded) {
  const basis = [];
  let delta = 0;
  const types = new Set((gaps || []).map((gap) => String(gap?.type || "")));
  if (degraded === "vector") {
    delta -= 15;
    basis.push("vector index not fully query-ready");
  } else if (degraded) {
    // Any other degradation is still half the search missing. Scoring only the
    // one named mode let "no-embedding" and "fts" price in at full confidence,
    // which is the same conflation retrieval-status.js exists to end.
    delta -= 12;
    basis.push(`retrieval degraded: ${String(degraded).slice(0, 40)}`);
  }
  if (types.has("filter_not_applied")) {
    delta -= 10;
    basis.push("a requested filter was not applied");
  }
  if (types.has("stale")) {
    delta -= 8;
    basis.push("newest evidence in the corpus is old for this topic");
  }
  if ((gaps || []).some((gap) => /stopped updating/i.test(String(gap?.detail || "")))) {
    delta -= 8;
    basis.push("a source has stopped updating recently");
  }
  return { delta, basis };
}

/**
 * Confidence in an answer that passed the evidence gate.
 *
 * approvedDocs are the citations the verifier explicitly endorsed — the only
 * documents the reader is shown. Independent agreement is counted over those.
 */
export function computeAnswerConfidence({ approvedDocs = [], gaps = [], degraded = null, partial = null, claim = null } = {}) {
  const basis = [];
  // A surviving answer has, by construction, passed citation checks and the
  // second-model evidence gate. That baseline is what the 65 encodes.
  let score = 65;
  basis.push(`evidence gate approved ${approvedDocs.length} citation${approvedDocs.length === 1 ? "" : "s"}`);
  // Distinct origins do not prove agreement. Credit only a substantive span
  // shared by all the cited records; conflicting values earn no bonus.
  const spans = approvedDocs.map(d => new Set(String(d.snippet || '').toLowerCase().split(/[.!?\n]+/)
    .map(s => s.replace(/\s+/g,' ').trim()).filter(s => s.length>=16)));
  // The whole claim is compared case-sensitively: 250 mW and 250 MW, or
  // 5 mg per mL and 5 mg per ML, are different facts wherever the case
  // change sits in the clause. Citation markers and the space before them go.
  const claimText = String(claim || '').replace(/\s*\[\d+\]/g,'').replace(/\s+/g,' ').trim().replace(/[.\s]+$/,'');
  const agrees = spans.length>1 && (claimText
    ? approvedDocs.every(d => String(d.snippet || '').replace(/\s+/g,' ').includes(claimText))
    : [...(spans[0] || [])].some(span => spans.every(set => set.has(span))));
  const citationLineage = independentEvidenceSummary(approvedDocs);
  if (citationLineage.unknown_documents) {
    basis.push(`${citationLineage.unknown_documents} citation${citationLineage.unknown_documents === 1 ? " has" : "s have"} unknown lineage and earned no corroboration credit`);
  }

  const authorityRows = approvedDocs
    .map((doc) => ({ doc, authority: doc?.authority }))
    .filter(({ authority }) => authority && Number.isFinite(Number(authority.rank)) && authority.tier);
  if (authorityRows.length) {
    const eligible = authorityRows.filter(({ authority }) => authority.eligible !== false);
    const strongestPool = eligible.length ? eligible : authorityRows;
    const strongest = strongestPool.slice().sort((a, b) =>
      Number(a.authority.rank) - Number(b.authority.rank)
    )[0].authority;
    basis.push(`strongest evidence is ${strongest.tier} ${strongest.name}: ${strongest.reason}`);

    // Agreement earns confidence only when the agreeing records are actually
    // authoritative for this claim. Three meeting notes are three historical
    // copies, not three independent current authorities.
    const highAuthorityDocs = authorityRows.filter(({ authority }) =>
      authority.eligible !== false && authority.authoritative === true && Number(authority.rank) <= 2
    );
    const independent = independentEvidenceSummary(highAuthorityDocs.map(({ doc }) => doc));
    const distinctHighAuthority = agrees ? independent.groups : 0;
    if (distinctHighAuthority >= 3) {
      score += 15;
      basis.push(`${distinctHighAuthority} independent T1 or T2 source families agree`);
    } else if (distinctHighAuthority === 2) {
      score += 10;
      basis.push("two independent T1 or T2 source families agree");
    } else {
      basis.push("no high-authority agreement bonus");
    }
    if (independent.known_documents > independent.groups) {
      basis.push(`${independent.known_documents} high-authority citations resolve to ${independent.groups} derivation ${independent.groups === 1 ? "family" : "families"}`);
    }

    const currentClaim = authorityRows.some(({ authority }) => authority.current === true);
    if (currentClaim && distinctHighAuthority === 0 && Number(strongest.rank) >= 4) {
      score -= 10;
      basis.push("current claim rests only on historical recollection, with no T1 or T2 authority");
    }
  } else {
    // A legacy comparison adapter can still return and cite a useful document,
    // but an id or filename cannot prove where it came from. Only an explicit
    // source-family contract earns corroboration credit.
    const independent = independentEvidenceSummary(approvedDocs);
    const distinctDocs = agrees ? independent.groups : 0;
    if (distinctDocs >= 3) {
      score += 15;
      basis.push(`${distinctDocs} independent source families agree`);
    } else if (distinctDocs === 2) {
      score += 10;
      basis.push("two independent source families agree");
    } else {
      basis.push(approvedDocs.length === 1 ? "single supporting document" : "independent corroboration is not established");
    }
  }

  const dated = approvedDocs.filter((doc) => doc.ts);
  if (dated.length && dated.every((doc) => doc.date_reliable === true)) {
    score += 10;
    basis.push("every cited date is reliable");
  } else if (dated.some((doc) => doc.date_reliable !== true)) {
    score -= 8;
    basis.push("a cited date is unverified");
  } else if (!dated.length) {
    score -= 5;
    basis.push("cited evidence is undated");
  }

  // Evidence a machine read off a picture of a page. The rubric does not judge
  // how well it read; it prices the fact that a reading step stands between the
  // page and the sentence, which a text layer does not have. A partial read is
  // worse than a whole one because some page of that document is missing from
  // the evidence entirely, and the answer cannot know which.
  const ocrDocs = approvedDocs.filter((doc) => doc.text_source === "ocr" || doc.text_source === "ocr_partial");
  if (ocrDocs.length) {
    const partial = ocrDocs.some((doc) => doc.text_source === "ocr_partial");
    const all = ocrDocs.length === approvedDocs.length;
    score -= partial ? 18 : 12;
    basis.push(
      `${all ? "every" : `${ocrDocs.length} of ${approvedDocs.length}`} cited document was read by OCR from a scanned image` +
      (partial ? ", and at least one has pages that could not be read" : ""),
    );
  }

  // A partial answer is an honest one: every kept sentence passed the gate,
  // and the missing part is named beside it rather than hidden inside a
  // refusal. It is still weaker than a complete answer, and the basis says so.
  if (partial) {
    score -= 10;
    basis.push(`answer is partial: ${String(partial).replace(/\.$/, "")}`);
  }

  const adjust = gapAdjustments(gaps, degraded);
  score += adjust.delta;
  basis.push(...adjust.basis);

  const percent = clamp(score, 5, 95);
  return { percent, band: band(percent), basis };
}

/**
 * Confidence in the refusal from this search, never in whole-corpus absence.
 * Rejected nearest candidates only establish that these records did not
 * support an answer. Healthy retrieval does not prove that every record was read.
 */
export function refusalConfidence({ gaps = [], degraded = null, resultCount = 0, sources = [] } = {}) {
  const basis = [];
  let score = 30;
  basis.push(resultCount > 0
    ? `checked ${resultCount} nearest candidate${resultCount === 1 ? "" : "s"}${sources.length ? ` across ${sources.join(", ")}` : ""}; none supported the claim`
    : "this search returned no candidates");
  basis.push("this search does not establish whole-corpus absence");

  const adjust = gapAdjustments(gaps, degraded);
  // Blind spots limit how well this search supports a refusal. A higher score
  // still cannot extend its scope beyond the records checked.
  score += adjust.delta * 1.5;
  basis.push(...adjust.basis);

  const percent = clamp(score, 0, 30);
  return { percent, band: band(percent), basis };
}

/** One-line rendering shared by the CLI and anything else that prints it. */
export function confidenceLine(confidence, { refused = false } = {}) {
  if (!confidence || !Number.isFinite(confidence.percent)) return null;
  return ownerConfidenceLine(confidence);
}
