import assert from 'node:assert/strict';
import { finalizeOwnerLedgerAnswer } from '../../src/lib/document-answer.js';
import { assertLedgerAnswer } from './document-answer-contract.mjs';

export function assertOwnerLedgerReading(body) {
  const owner = finalizeOwnerLedgerAnswer(body);
  assertLedgerAnswer(owner, body);
  assert.doesNotMatch(owner.answer, /withheld|cannot|can't/i);
  return owner;
}

// Rule table row 1: count observed money out, name the duplicate bound, and
// keep ownership unproved. A populated total must never become a refusal.
export function assertCountedMovement(body, { debits, credits, amount }) {
  const sum = (rows, field) => rows.reduce((n, row) => n + row[field], 0);
  for (const rows of [body.ledger.accounts, body.ledger.lead_accounts]) {
    assert.ok(rows?.length, 'the real reader populated the activity decision');
    assert.equal(sum(rows, 'debits_minor'), debits);
    assert.equal(sum(rows, 'credits_minor'), credits);
  }
  assert.equal(body.ledger.complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.matched_transfer_count, 0, 'uncertainty cannot prove a pair');
  assert.equal(body.ledger.default_exclusions.own_transfer_minor, 0);
  const refs = body.ledger.transfers.flatMap(pair => [pair.outgoing.ref, pair.incoming.ref]);
  assert.equal(new Set(refs).size, refs.length, 'one posting cannot belong to multiple candidate pairs');
  assert.equal(body.ledger.possible_payments_included_minor, amount);
  const candidates = body.ledger.possible_payments.filter(row => row.amount_minor === amount);
  assert.equal(candidates.length, 1, 'the outgoing uncertainty is disclosed once');
  assert.equal(candidates[0].included_in_total, true);
  assert.equal(candidates[0].destination_unconfirmed, true);
  assert.ok(body.citations.some(row => row.n === candidates[0].n && row.amount_minor === amount));
  const dollars = '$' + (amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(body.answer.includes(`up to ${dollars} may be counted twice`));
  assert.doesNotMatch(body.answer, /withheld|cannot|can't/i);
  return assertOwnerLedgerReading(body);
}
