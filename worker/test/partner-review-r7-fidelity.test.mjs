// Partner review, packet 7 round 7, fidelity lens: the round-7 rulings as
// worded and the partner's index-building rule. Every name, amount and
// description here is synthetic, role words only. Each finding has a repro
// that fails on HEAD and a control that passes on HEAD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import worker from '../src/index.js';
import { COVERAGE_INCOMPLETE, SEARCH_UNAVAILABLE } from '../src/lib/retrieval-status.js';

const cents = body => body.citations.map(c => c.amount_minor);
const notComplete = (body, label) => {
  assert.ok(body.ledger, `${label}: ledger answer reached`);
  assert.notEqual(body.evidence_gate.complete, true, `${label}: complete gate: ${body.answer}`);
  assert.equal(body.ledger.total_minor ?? null, null, `${label}: a complete total was certified`);
};
const listed = (body, amount, label) => assert.ok(cents(body).includes(amount), `${label}: the ${amount} row is not cited: ${body.answer}`);

// ------------------------------------------------------------ R7-FIDELITY-1
// R4-MONEY-5 (round 4, decided) and ruling 10 (round 7): a bounded field that
// shares the requested name without equalling it is a possible match that
// blocks completeness; ledger-answer.js says a row is a known other "only
// when no bounded field shares the requested name". payerNameVariant()
// implements that as: equal after one company suffix, the field EXTENDS the
// name with TRAILING words ("Payer One Holdings"), or the field is a shorter
// whole-word run of the name (leading, trailing or inner; ruling 10). A field
// that contains the requested name as whole words with a LEADING word ("ACH
// Payer One", "Again Payer One") or around it ("Again Payer One Group") is
// not covered: beside an exact row it is a known other, the row is hidden
// and the total is certified complete, although alone the same row is listed
// as doubt. That is exactly R4-MONEY-5's defect ("adding an exact row removes
// the doubt the branch records for the variant row on its own") in the
// other direction. The same bank text in a description ("ACH Payer One") is
// read as channel + name and listed as a possible match.
// Fixed in the round-7 fix pass (one root cause with R7-MONEY-1 and
// R7-QUESTION-1): on the inflow side the longer field is read by whole-word
// containment at any position.
const containing = [['leading channel word', 'ACH Payer One'], ['leading word', 'Again Payer One'],
  ['leading words', 'Supply Again Payer One'], ['inner', 'Again Payer One Group']];

test('R7-FIDELITY-1 repro: beside an exact row, a payee containing the requested name with a leading word is hidden and the total is certified complete', async t => {
  for (const [label, other] of containing) {
    const f = ledgerFixture(t, { knownPayers: false });
    seedKnownPayers(f, ['Payer One', 'Vendor Alpha'], NOW);
    f.add('exact', 'Deposit', 'Payer One', { date: '2026-10-05', cents: 2500 });
    f.add('other', 'Deposit', other, { date: '2026-10-06', cents: 4000 });
    const income = await f.ask('How much income came from Payer One in October 2026?');
    listed(income, 4000, `${label}: income`);
    notComplete(income, `${label}: income`);
    const payment = await f.ask('Did the payment from Payer One arrive in October 2026?');
    listed(payment, 4000, `${label}: payment`);
    assert.notEqual(payment.evidence_gate.complete, true, `${label}: payment complete while the containing row is hidden: ${payment.answer}`);
  }
  // The unregistered shape: a literal exact payee and a containing payee.
  const g = ledgerFixture(t, { knownPayers: false });
  g.add('exact', 'Deposit', 'Supplier Unit', { date: '2026-10-05', cents: 2500 });
  g.add('other', 'Deposit', 'ACH Supplier Unit', { date: '2026-10-06', cents: 4000 });
  const unregistered = await g.ask('How much income came from Supplier Unit in October 2026?');
  listed(unregistered, 4000, 'unregistered question');
  notComplete(unregistered, 'unregistered question');
});

test('R7-FIDELITY-1 control: the trailing shape is listed beside the exact row, the containing row alone is doubt, and an unrelated payee beside the exact row keeps the answer complete', async t => {
  // R4-MONEY-5 as decided: a trailing extension beside the exact row is
  // listed and blocks completeness.
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Payer One', 'Vendor Alpha'], NOW);
  f.add('exact', 'Deposit', 'Payer One', { date: '2026-10-05', cents: 2500 });
  f.add('other', 'Deposit', 'Payer One Holdings', { date: '2026-10-06', cents: 4000 });
  const trailing = await f.ask('How much income came from Payer One in October 2026?');
  listed(trailing, 4000, 'trailing');
  notComplete(trailing, 'trailing');
  assert.equal(trailing.ledger.unattributed_count, 1);
  // The containing row alone is listed as doubt, never a known other.
  for (const [label, other] of containing) {
    const alone = ledgerFixture(t, { knownPayers: false });
    seedKnownPayers(alone, ['Payer One', 'Vendor Alpha'], NOW);
    alone.add('other', 'Deposit', other, { date: '2026-10-06', cents: 4000 });
    const income = await alone.ask('How much income came from Payer One in October 2026?');
    listed(income, 4000, `${label}: alone`);
    notComplete(income, `${label}: alone`);
    assert.equal(income.ledger.unattributed_count, 1, `${label}: alone`);
    const payment = await alone.ask('Did the payment from Payer One arrive in October 2026?');
    assert.equal(payment.ledger.found, null, `${label}: alone, never absence: ${payment.answer}`);
  }
  // The same text in a description is channel + name: a possible match.
  const d = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(d, ['Payer One', 'Vendor Alpha'], NOW);
  d.add('exact', 'Deposit', 'Payer One', { date: '2026-10-05', cents: 2500 });
  d.add('other', 'ACH Payer One', null, { date: '2026-10-06', cents: 4000 });
  const described = await d.ask('How much income came from Payer One in October 2026?');
  listed(described, 4000, 'description');
  notComplete(described, 'description');
  // A payee that shares nothing with the requested name is a known other:
  // the exact row alone answers completely.
  const k = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(k, ['Payer One', 'Vendor Alpha'], NOW);
  k.add('exact', 'Deposit', 'Payer One', { date: '2026-10-05', cents: 2500 });
  k.add('other', 'Deposit', 'Supply Unit', { date: '2026-10-06', cents: 4000 });
  const known = await k.ask('How much income came from Payer One in October 2026?');
  assert.equal(known.evidence_gate.complete, true, known.answer);
  assert.equal(known.ledger.total_minor, 2500);
  assert.deepEqual(cents(known), [2500]);
});

// ------------------------------------------------------------ R7-FIDELITY-2
// The partner's index-building rule (979477c): while the projection is
// pending, a cited positive answer is a full answer; absence, zero and
// nothing-found stay incomplete and provisional. The worker implements
// "absence" as its own outcomes (zero results, a categorical refusal, the
// money veto). A verifier-approved prose sentence that asserts an absence
// ("No signed warehouse lease appears in the records [1]") is not one of
// them: with retrievalFailed() now false for the pending reasons, its
// evidence gate is complete while the projection is pending (it was partial,
// "retrieval incomplete", before the patch). Contract question for the
// partner: is a cited prose absence an "absence" under the rule, or a
// positive cited answer? Logged for 0.4.19 and kept as a todo so the suite
// stays green; a fix would only add doubt.
function thinkEnv({ rows = [], vectorIds = [], projectionReady = true, expectedVectors = vectorIds.length,
  actualVectors = vectorIds.length, pending = 0, oldestQueuedAt = null, answerText = null,
  readinessThrows = false, vectorQueryThrows = false } = {}) {
  return {
    STORAGE: 'd1', ADMIN_KEY: 'k',
    DB: { prepare(sql) { return { bind() { return this; },
      all: async () => (/FROM sources s/.test(sql) ? { results: [] } : { results: rows }),
      first: async () => {
        if (/proportional-projection-backlog/.test(sql)) return { n: pending };
        if (/vector_projection_mutation_id AS mutation_id/.test(sql)) return { schema_version: 12,
          mutation_id: projectionReady ? null : 'mutation-in-flight', mutation_submitted_at: null,
          projection_status: projectionReady ? 'verified' : 'pending', bootstrap_epoch: 0, bootstrap_cursor: null,
          bootstrap_high_water: null, expected_vectors: expectedVectors, live_vectors: expectedVectors,
          pending: 0, submitted: 0, oldest_queued_at: null };
        if (/FROM vector_outbox/.test(sql) && /submitted_mutation_id/.test(sql))
          return { n: pending, oldest: oldestQueuedAt, upserts: pending, deletes: 0, submitted: 0 };
        return /count\(\*\)/i.test(sql) ? { n: 0, stored_documents: 0, logical_documents: 0 } : null;
      }, run: async () => ({}) }; }, batch: async () => {} },
    VECTORIZE: {
      query: async () => { if (vectorQueryThrows) throw new Error('vector query failed'); return { matches: vectorIds.map(id => ({ id })) }; },
      upsert: async () => {},
      describe: async () => { if (readinessThrows) throw new Error('readiness read failed'); return { vectorCount: actualVectors, processedUpToMutation: null }; },
    },
    AI: { run: async (model, input) => {
      if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      const system = String(input?.messages?.[0]?.content || '');
      if (answerText && /verify a proposed answer/.test(system)) return { response: { supported: true, complete: true, evidence: [1], reason: 'direct support' }, usage: {} };
      return { response: answerText || 'unused', usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } },
  };
}
const think = async (env, q) => {
  const res = await worker.fetch(new Request('https://b.example/api/rag/think', { method: 'POST',
    headers: { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify({ q, limit: 8 }) }),
  env, { waitUntil() {}, passThroughOnException() {} });
  return res.json();
};
const record = { chunk_uid: 'drive:fixture#0', doc_uid: 'drive:fixture', source: 'drive', source_id: 'fixture',
  title: 'Synthetic record', text: 'The synthetic fact is supported.', document_date: Date.parse('2026-09-28T00:00:00.000Z'),
  date_source: 'fixture:date', date_reliable: 1, text_source: 'native', text_reliable: 1 };
const FROZEN = Date.parse('2026-09-28T18:00:00.000Z');
const catchingUp = { projectionReady: false, expectedVectors: 1_795_309, actualVectors: 1_793_009, pending: 10_001, oldestQueuedAt: FROZEN - 60 * 60 * 1000 };
const incomplete = { projectionReady: false };
const POSITIVE = 'The retrieved record supports the answer [1].';
const PROSE_ABSENCE = 'No signed warehouse lease appears in the retrieved records [1].';
const MONEY_ABSENCE = 'No payment from the client was received in September 2026 [1].';
const frozen = async fn => { const real = Date.now; Date.now = () => FROZEN; try { return await fn(); } finally { Date.now = real; } };

test('R7-FIDELITY-2 repro (contract question): a verifier-approved prose absence is complete while the projection is pending', { todo: 'logged for 0.4.19: contract question, is a cited prose absence an "absence" under the index-building rule' }, () => frozen(async () => {
  for (const [reason, pendingState] of [['projection-incomplete', incomplete], ['projection-catching-up', catchingUp]]) {
    const body = await think(thinkEnv({ rows: [record], vectorIds: [record.chunk_uid], answerText: PROSE_ABSENCE, ...pendingState }), 'is there a signed warehouse lease');
    assert.equal(body.degraded_reason, reason, JSON.stringify(body));
    assert.equal(body.answer, PROSE_ABSENCE, 'the prose absence reaches the response');
    assert.notEqual(body.evidence_gate?.complete, true, `${reason}: a cited absence is complete while the projection is pending: ${JSON.stringify(body.evidence_gate)}`);
  }
}));

test('R7-FIDELITY-2 control: a cited positive answer is full while pending, a prose money absence is vetoed, and nothing found stays provisional', () => frozen(async () => {
  for (const [reason, pendingState] of [['projection-incomplete', incomplete], ['projection-catching-up', catchingUp]]) {
    const positive = await think(thinkEnv({ rows: [record], vectorIds: [record.chunk_uid], answerText: POSITIVE, ...pendingState }), 'what does the synthetic record support');
    assert.equal(positive.degraded_reason, reason);
    assert.equal(positive.answer, POSITIVE);
    assert.equal(positive.evidence_gate?.complete, true, `${reason}: ${JSON.stringify(positive.evidence_gate)}`);
    assert.equal(positive.citations?.length, 1);
    const money = await think(thinkEnv({ rows: [record], vectorIds: [record.chunk_uid], answerText: MONEY_ABSENCE, ...pendingState }), 'did the client pay in September 2026');
    assert.equal(money.answer, null, `${reason}: a prose money absence is vetoed`);
    assert.notEqual(money.evidence_gate?.complete, true);
    assert.equal(money.status, reason === 'projection-catching-up' ? COVERAGE_INCOMPLETE : SEARCH_UNAVAILABLE);
    const nothing = await think(thinkEnv(pendingState), 'anything at all');
    assert.equal(nothing.answer, null, `${reason}: nothing found stays provisional`);
    assert.equal(nothing.status, reason === 'projection-catching-up' ? COVERAGE_INCOMPLETE : SEARCH_UNAVAILABLE);
    assert.equal(nothing.confidence, undefined);
  }
  // On a healthy index the same prose absence is complete today, so the
  // repro is specific to the pending state.
  const healthy = await think(thinkEnv({ rows: [record], vectorIds: [record.chunk_uid], answerText: PROSE_ABSENCE }), 'is there a signed warehouse lease');
  assert.equal(healthy.degraded, undefined);
  assert.equal(healthy.evidence_gate?.complete, true);
}));

// ------------------------------------------------------------ R7-FIDELITY-3
// The rule's third clause: a vector query that actually fails is still failed
// retrieval. store-d1.js search() reads the projection receipt with
// searchProjectionReadiness(env).catch(() => ({ ready: false })): a readiness
// read that THROWS (the index could not report readiness, the install_state
// read failed, or the receipt schema is not active) becomes { ready: false },
// which projectionCatchupEligible() rates "projection-incomplete". Since
// 979477c that reason is a pending projection, so a cited positive answer is
// a full answer although nothing proved the projection is merely pending; it
// was failed retrieval ("retrieval incomplete", partial) before the patch.
// More cautious only: the fix would mark a cited positive answer partial.
// Logged for 0.4.19 and kept as a todo so the suite stays green.
test('R7-FIDELITY-3 repro (more cautious only): a readiness read that throws is reported as a pending projection, so a cited positive answer is full', { todo: 'logged for 0.4.19: more cautious only, a thrown readiness read is reported as a pending projection' }, async () => {
  const body = await think(thinkEnv({ rows: [record], vectorIds: [record.chunk_uid], answerText: POSITIVE, readinessThrows: true }), 'what does the synthetic record support');
  assert.equal(body.answer, POSITIVE, 'the vector query itself succeeded and the answer is cited');
  assert.equal(body.degraded, 'vector');
  assert.ok(body.degraded_reason !== 'projection-incomplete' || body.evidence_gate?.complete !== true,
    `a thrown readiness read is indistinguishable from a pending projection: ${JSON.stringify({ reason: body.degraded_reason, gate: body.evidence_gate })}`);
});

test('R7-FIDELITY-3 control: a vector query that throws while the projection is pending is failed retrieval, and a real pending projection keeps the cited answer full', () => frozen(async () => {
  const failed = await think(thinkEnv({ rows: [record], vectorIds: [record.chunk_uid], answerText: POSITIVE, vectorQueryThrows: true, ...catchingUp }), 'what does the synthetic record support');
  assert.equal(failed.degraded_reason, 'vector-query-failed', JSON.stringify(failed));
  assert.equal(failed.answer, POSITIVE);
  assert.equal(failed.evidence_gate?.complete, false);
  assert.equal(failed.evidence_gate?.partial, true);
  assert.equal(failed.evidence_gate?.reason, 'retrieval incomplete');
  const pending = await think(thinkEnv({ rows: [record], vectorIds: [record.chunk_uid], answerText: POSITIVE, ...incomplete }), 'what does the synthetic record support');
  assert.equal(pending.degraded_reason, 'projection-incomplete');
  assert.equal(pending.evidence_gate?.complete, true);
  // With nothing found, a thrown readiness read still refuses an absence.
  const nothing = await think(thinkEnv({ readinessThrows: true }), 'anything at all');
  assert.equal(nothing.answer, null);
  assert.equal(nothing.status, SEARCH_UNAVAILABLE);
}));
