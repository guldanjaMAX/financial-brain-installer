import assert from 'node:assert/strict';

// R7 replaces confirmed shorthand presence with a cited, visibly partial
// possible match. This checks every authority-bearing output, not just prose.
export function assertPossibleMatch(body, subtotal) {
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.found, null);
  assert.equal(body.ledger.total_is_exact, false);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.lead_total_minor, null);
  assert.equal(body.ledger.subtotal_is_partial, true);
  if (subtotal !== undefined) assert.equal(body.ledger.attributed_subtotal_minor, subtotal);
  assert.match(body.answer, /matched by name similarity, not an exact merchant\/payer name/);
  assert.match(body.answer, /exact names only/);
  assert.ok(body.ledger.flip.includes('exact names only'));
  assert.doesNotMatch(body.answer, /Found a deposit|No matching deposit|Total (?:spend|income)/i);
  assert.equal(body.ledger.if_own_transfers.total_minor, null);
}

export function assertExactSelection(body, amount) {
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.ledger.found, true);
  assert.ok(body.citations.length > 0);
  assert.ok(body.citations.every(c => c.amount_minor === amount));
  if (body.ledger.kind === 'merchant') {
    assert.equal(body.ledger.total_minor, amount);
    assert.equal(body.ledger.total_is_exact, true);
  }
}
