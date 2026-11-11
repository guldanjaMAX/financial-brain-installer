// These are the two deliberate C3 envelope additions. Every financial field,
// amount, citation, scope and remaining response byte must still match the pin.
export function grossCompatibility(body) {
  const value = structuredClone(body);
  for (const part of value.ledger?.parts || []) delete part.operand_coverage;
  if (value.evidence_gate?.reason === 'question needs clarification; separate ledger answers for explicit question parts')
    value.evidence_gate.reason = 'question needs clarification; separate ledger answers for two question parts';
  return value;
}
