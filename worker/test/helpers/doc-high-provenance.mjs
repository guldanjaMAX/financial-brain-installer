import assert from 'node:assert/strict';

// These older controls prove exact quotation, not governing applicability.
// Keep their figures and add the new decision receipt to every re-pin.
export function assertUnprovedDocument(body, figure) {
  assert.ok(body.confidence.percent<90,'a document figure with unproved provenance stays below High');
  const proof=body.answer_contract.provenance;
  assert.ok(proof?.checked_records>0,'the provenance decision point read the cited records');
  assert.equal(proof.complete,false);
  assert.ok(proof.checks.some(check=>!check.proven),'at least one of the five required source checks is missing');
  assert.match(body.answer,/says:/,'the figure is attributed to its source');
  if (figure) assert.ok(body.answer.includes(figure),`the exact source figure remains: ${figure}`);
  assert.match(body.confidence_text,/Why:.*Missing:/s);
}
