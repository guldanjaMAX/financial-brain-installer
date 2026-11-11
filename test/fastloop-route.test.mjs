import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRouteTapes, replayRoute } from '../eval/fast-loop/route-replay.mjs';
import { BASE_CASES, CONTROLS } from './fixtures/fastloop-money/input.mjs';
import { DOCUMENT_CASES, CLOCK_CASES } from './fixtures/fastloop-route/input.mjs';
import { readFileSync } from 'node:fs';
import { replay } from '../eval/fast-loop/money-replay.mjs';
import { typed, exactTape, d1Tape } from '../eval/fast-loop/exact-tape.mjs';

const fixtures = loadRouteTapes();
const good = o => {
  assert.equal(o.execution_status, 'complete');
  assert.deepEqual(o.fatal, []);
};
const one = options => replayRoute(options).observations[0];
const control = CONTROLS.find(c => c.id === 'M06/typed');

test('all twelve base cases execute through both actual paths and preserve ledger bodies', () => {
  const route = replayRoute();
  const direct = replay({ cases: BASE_CASES });
  assert.equal(route.observations.length, 12);
  assert.equal(direct.observations.length, 12);
  let ledger = 0, documents = 0, refused = 0;
  for (const o of route.observations) {
    good(o);
    assert.equal(o.trace.ledger_entries.length, 1);
    assert.ok(o.trace.parsed_intents.length > 0);
    assert.equal(o.http_status, 200);
    assert.equal(o.trace.tasks, o.trace.drained_tasks);
    const peer = direct.observations.find(p => p.id === o.id);
    if (o.body.ledger) {
      ledger++;
      assert.ok(['M01', 'M04', 'M05', 'M08', 'M09', 'M10', 'M12', 'M17'].includes(o.id));
      const { timing, ...body } = o.body;
      assert.deepEqual(body, peer.body);
      assert.ok(o.trace.sql.length > 0);
    } else if (o.id === 'M06') {
      refused++;
      assert.equal(o.body.code, 'ledger_account_kind_review_required');
      assert.equal(o.trace.parsed_intents[0].kind, 'expense_summary');
      assert.ok(o.trace.rows_read.length > 0, 'unreviewed destination decision reached posted rows');
      assert.equal(o.trace.fallback_calls, 0);
      assert.equal(o.body.answer, null);
      assert.deepEqual(o.body.citations, []);
      assert.deepEqual(o.body.results, []);
      assert.equal(o.body.evidence_gate.complete, false);
      const { timing, ...body } = o.body;
      assert.deepEqual(body, peer.body);
    } else {
      documents++;
      assert.ok(['M11', 'M16', 'M20'].includes(o.id));
      assert.equal(o.trace.fallback_calls, 1);
      assert.equal(o.trace.retrieval.length, 1);
      assert.equal(o.body.answer, null);
      assert.deepEqual(o.body.results, []);
      assert.ok(o.trace.providers.length > 0);
    }
  }
  assert.equal(ledger, 8); assert.equal(documents, 3); assert.equal(refused, 1);
  assert.equal(one({ cases: [control] }).body.ledger.expense_total_minor, 61000,
    'the reviewed account peer still certifies the ordinary expense total');
  assert.equal(route.provider_calls, 0); assert.equal(route.production_writes, 0);
});

test('HTTP authorization reaches the proxy restriction and the unauthenticated refusal', () => {
  const proxy = one({ cases: [control], authority: 'proxy', fixtureId: 'authority/proxy' });
  const anonymous = one({ cases: [control], authority: 'anonymous', fixtureId: 'authority/anonymous' });
  good(proxy); good(anonymous);
  assert.equal(proxy.http_status, 200);
  assert.deepEqual(proxy.trace.ledger_entries, [{ principal: 'proxy', all: true }]);
  assert.equal(proxy.trace.parsed_intents[0].kind, 'expense_summary');
  assert.equal(proxy.trace.fallback_calls, 1);
  assert.ok(proxy.body.gaps.some(g => g.reason === 'retrieval_scope_restricted'));
  assert.ok(proxy.trace.sql.length > 0, 'the permitted document path actually ran');
  assert.ok(proxy.trace.sql.every(c => !JSON.stringify(c).includes('fin_accounts')));
  assert.equal(proxy.body.ledger, undefined);
  assert.equal(anonymous.http_status, 401);
  assert.equal(anonymous.body.code, 'session_required');
  assert.equal(anonymous.trace.ledger_entries.length, 0);
  assert.equal(anonymous.trace.sql.length, 0);
  assert.equal(one({ cases: [control] }).body.ledger.total_minor, 61000);
});

test('clock governs ledger defaults, document retrieval windows and freshness end to end', () => {
  const [month, window] = replayRoute({ cases: CLOCK_CASES }).observations;
  good(month); good(window);
  assert.equal(month.body.ledger.from, '2026-09-01');
  assert.equal(month.body.ledger.to, '2026-09-30');
  assert.equal(month.body.ledger.total_minor, 0);
  assert.ok(month.trace.sql.length >= 2);
  assert.ok(window.body.time_window);
  assert.ok(JSON.stringify(window.body.time_window).includes('2026-10-01'));
  assert.equal(window.trace.models.length, 2);
  assert.equal(window.body.results[0].ts, '2026-10-30T00:00:00.000Z');
  assert.ok(!window.body.gaps.some(g => g.type === 'stale'));
});

test('default Worker response bytes survive instrumentation on every money and document path', () => {
  const cases = [...BASE_CASES, ...DOCUMENT_CASES];
  const traced = replayRoute({ cases });
  const plain = replayRoute({ cases, trace: false });
  for (let i = 0; i < cases.length; i++) {
    good(traced.observations[i]); good(plain.observations[i]);
    assert.equal(traced.observations[i].raw_body, plain.observations[i].raw_body);
    assert.equal(traced.observations[i].http_status, plain.observations[i].http_status);
  }
});

test('exact synthetic tapes drive draft, answer repair, check and check retry through final gates', () => {
  const observations = replayRoute({ cases: DOCUMENT_CASES }).observations;
  assert.deepEqual(observations.map(o => o.trace.models.length), [2, 3, 3, 2, 2, 2]);
  for (const o of observations) {
    good(o);
    assert.equal(o.body.answer, 'The protocol release color is violet [1].');
    assert.equal(o.body.evidence_gate.supported, true);
    assert.deepEqual(o.body.evidence_gate.evidence, [1]);
    assert.equal(o.body.citations.length, 1);
    assert.equal(o.trace.model_boundary, 'injected-callLLM-no-accounting');
    assert.ok(o.trace.delivered_spans.length > 0);
  }
});

for (const fault of ['sql', 'bind']) {
  test(`caught ${fault} drift remains SNAPSHOT_MISS after the real ledger refusal`, () => {
    const bad = one({ cases: [control], fault });
    assert.equal(bad.execution_status, 'snapshot_miss');
    assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
    assert.ok(bad.trace.sql.length > 0);
    assert.equal(bad.body.code, 'ledger_unavailable');
    assert.throws(() => good(bad));
    good(one({ cases: [control] }));
  });
}
for (const fault of ['model', 'model-check', 'model-prompt', 'model-name', 'model-messages']) {
  test(`caught ${fault} drift remains MODEL_TAPE_MISS after the real answer handling`, () => {
    const bad = one({ cases: [DOCUMENT_CASES[0]], fault });
    assert.equal(bad.execution_status, 'model_tape_miss');
    assert.ok(bad.fatal.includes('MODEL_TAPE_MISS'));
    assert.ok(bad.trace.models.length > 0);
    assert.equal(bad.body.answer, null);
    assert.ok(bad.body.answer_error);
    assert.throws(() => good(bad));
    good(one({ cases: [DOCUMENT_CASES[0]] }));
  });
}

test('missing model attempts cannot pass by accepting an early product return', () => {
  const changed = structuredClone(fixtures);
  changed.D01.model.push(structuredClone(changed.D01.model.at(-1)));
  const bad = one({ cases: [DOCUMENT_CASES[0]], fixtures: changed });
  assert.equal(bad.body.evidence_gate.supported, true, 'product completed before the missing-call audit');
  assert.equal(bad.execution_status, 'model_tape_miss');
  assert.throws(() => good(bad));
  good(one({ cases: [DOCUMENT_CASES[0]] }));
});

test('a scheduled dependency miss stays fatal after the HTTP body has completed', () => {
  const bad = one({ cases: [control], fault: 'scheduled-sql' });
  assert.equal(bad.body.ledger.total_minor, 61000);
  assert.equal(bad.trace.tasks, 1);
  assert.equal(bad.trace.drained_tasks, 1);
  assert.ok(bad.trace.sql.length >= 3);
  assert.equal(bad.execution_status, 'snapshot_miss');
  assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
  assert.throws(() => good(bad));
  good(one({ cases: [control] }));
});

test('changed snapshot bytes cannot borrow a successful tape', () => {
  const changed = { ...DOCUMENT_CASES[0], documents: DOCUMENT_CASES[0].documents.map(d => ({ ...d, revision: 'other-revision' })) };
  const bad = one({ cases: [changed] });
  assert.equal(bad.execution_status, 'snapshot_miss');
  assert.equal(bad.trace.snapshot_checks, 1);
  assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
  assert.throws(() => good(bad));
  good(one({ cases: [DOCUMENT_CASES[0]] }));
});

test('an earlier SQL miss is not relabeled by unconsumed downstream model calls', () => {
  const bad = one({ cases: [DOCUMENT_CASES[0]], fault: 'sql' });
  assert.ok(bad.trace.sql.length > 0);
  assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
  assert.ok(bad.fatal.includes('MODEL_TAPE_MISS'));
  assert.equal(bad.execution_status, 'snapshot_miss');
  assert.throws(() => good(bad));
  good(one({ cases: [DOCUMENT_CASES[0]] }));
});

test('source spans bind exact Unicode offsets, revisions, composition contributors and negation', () => {
  const [unicode, , , composed] = replayRoute({ cases: DOCUMENT_CASES }).observations;
  const span = unicode.trace.delivered_spans[0];
  assert.equal(span.source_start, 0);
  assert.equal(span.source_end, Array.from(DOCUMENT_CASES[0].documents[0].text).length);
  assert.equal(span.revision, 'synthetic-revision-1');
  assert.equal(span.origin_ambiguous, false);
  assert.ok(span.text.includes('not authorized'));
  assert.deepEqual(composed.trace.delivered_spans.map(s => s.chunk_uid), ['protocol:record#0', 'protocol:record#1']);
  assert.equal(composed.body.results.length, 1, 'two chunks collapsed to one document');
  assert.ok(composed.trace.delivered_spans[1].text.includes('not authorized'));
  const mutation = structuredClone(composed);
  mutation.trace.delivered_spans = mutation.trace.delivered_spans.slice(0, 1);
  const supportsNegation = o => assert.ok(o.trace.delivered_spans.some(s => s.chunk_uid === 'protocol:record#1' && s.text.includes('not authorized')));
  supportsNegation(composed); assert.throws(() => supportsNegation(mutation));
});

test('a filtered-out identical source cannot inherit a delivered prompt span', () => {
  const o = one({ cases: [DOCUMENT_CASES.find(c => c.id === 'D06/filtered')] });
  good(o);
  assert.equal(o.body.results.length, 1);
  assert.equal(o.body.results[0].source, 'protocol');
  assert.deepEqual(o.trace.delivered_spans.map(s => s.chunk_uid), ['protocol:record#0']);
  assert.ok(one({ cases: [DOCUMENT_CASES[0]] }).trace.delivered_spans.length > 0);
});

test('seven retrieval arms assert rows, identities, degradation and real attempt counts', () => {
  const run = replayRoute({ arms: true });
  assert.deepEqual(run.fatal, []);
  assert.equal(run.arms.length, 7);
  const expected = [
    [1, null, null, 1, 0, 0], [0, null, null, 1, 0, 0],
    [1, 'fts', 'keyword-query-failed', 1, 1, 0],
    [1, 'vector', 'vector-query-failed', 2, 0, 2],
    [0, 'retrieval', 'keyword-and-vector-query-failed', 2, 1, 2],
    [0, 'retrieval', 'keyword-and-vector-query-failed', 2, 1, 2],
  ];
  for (const [index, values] of expected.entries()) {
    const o = run.arms[index];
    assert.deepEqual([o.result.results.length, o.result.degraded, o.result.degraded_reason,
      o.calls.vector.length, o.calls.keyword_errors, o.calls.vector_errors], values);
    assert.equal(o.calls.sql.filter(c => /chunks_fts MATCH/.test(c.sql)).length, 1);
    assert.equal(o.calls.returned_rows, values[0]);
    assert.deepEqual(o.result.results.map(r => r.chunk_uid), values[0] ? ['role-source:role-record#0'] : []);
    if (values[0]) assert.equal(o.result.results[0].text, 'The owner role approved the role record.');
  }
  assert.equal(run.arms[4].calls.shared_error_identity, false);
  assert.equal(run.arms[5].calls.shared_error_identity, true);
  assert.deepEqual(run.arms[6].calls, { sql: [], vector: [], keyword_errors: 0, vector_errors: 0,
    scope_refusals: 1, returned_rows: 0, shared_error_identity: false });
  const mutated = replayRoute({ arms: true, fault: 'drop-evidence' });
  assert.ok(mutated.arms[0].calls.sql.length > 0);
  assert.equal(mutated.arms[0].result.results.length, 0);
  assert.throws(() => assert.equal(mutated.arms[0].result.results.length, 1));
  assert.ok(new Set(run.arms.map(o => JSON.stringify(o.result))).size > 2);
});

for (const fault of ['arm-sql', 'arm-bind']) {
  test(`retrieval arm ${fault} cannot bypass exact snapshot matching`, () => {
    const bad = replayRoute({ arms: true, fault });
    assert.ok(bad.arms[0].calls.sql.length > 0);
    assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
    const green = replayRoute({ arms: true });
    assert.deepEqual(green.fatal, []);
    assert.equal(green.arms[0].result.results.length, 1);
  });
}

test('typed SQL tape enforces method, principal, ordered batches and consumption', async () => {
  const request = { sql: 'SELECT ?1', binds: [1], method: 'all' };
  const entries = [{ input: { schema: 1, principal: 'owner', occurrence: 1, request: typed(request) }, output: { results: [{ value: 1 }] } }];
  const make = (principal = 'owner', data = entries) => {
    const fatal = [], calls = [];
    const tape = exactTape({ entries: data, code: 'SNAPSHOT_MISS', principal, fatal, calls });
    return { tape, db: d1Tape(tape), fatal, calls };
  };
  const green = make();
  assert.deepEqual(await green.db.prepare('SELECT ?1').bind(1).all(), { results: [{ value: 1 }] });
  green.tape.finish(); assert.equal(green.calls.length, 1);
  for (const operation of [x => x.db.prepare('SELECT ?1').bind('1').all(),
    x => x.db.prepare('SELECT ?1').bind(1).first(), x => x.db.batch([x.db.prepare('SELECT ?1').bind(1)]),
    x => x.db.prepare('SELECT ?1 ').bind(1).all()]) {
    const bad = make(); await assert.rejects(operation(bad), /SNAPSHOT_MISS/);
    assert.equal(bad.calls.length, 1); assert.deepEqual(bad.fatal, ['SNAPSHOT_MISS']);
  }
  const principal = make('proxy'); await assert.rejects(principal.db.prepare('SELECT ?1').bind(1).all(), /SNAPSHOT_MISS/);
  const unconsumed = make(); assert.throws(() => unconsumed.tape.finish(), /SNAPSHOT_MISS/);
});

test('cropped source tracing cannot claim undelivered repeated tail spans', () => {
  const o = replayRoute({ cases: [DOCUMENT_CASES.find(c => c.id === 'D05/crop')] }).observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.trace.models.length, 2);
  assert.ok(o.trace.delivered_spans.length > 0);
  assert.ok(o.trace.delivered_spans.every(s => s.source_end < 900));
  assert.ok(o.trace.delivered_spans.every(s => !s.text.includes('not authorized')));
});

test('actual HTTP entry reaches owner ledger and preserves frozen response bytes', () => {
  const input = CONTROLS.find(c => c.id === 'M06/typed');
  const run = replayRoute({ cases: [input] });
  const o = run.observations[0];
  assert.equal(o.execution_status, 'complete');
  assert.ok(o.trace.sql.length > 0);
  assert.equal(o.body.ledger.total_minor, 61000);
  assert.equal(o.http_status, 200);
  assert.equal(o.raw_body, replayRoute({ cases: [input], trace: false }).observations[0].raw_body);
});

test('pending disclosure tapes keep a nonempty green peer and reject the untouched older stream', () => {
  const original = JSON.parse(readFileSync(new URL('./fixtures/fastloop-route/tapes.json', import.meta.url), 'utf8'));
  const green = one({ cases: [control], fixtures });
  good(green);
  assert.equal(green.body.ledger.expense_total_minor, 61000);
  assert.ok(green.trace.rows_read.length > 0, 'real posted decision reached');
  const stale = one({ cases: [control], fixtures: original });
  assert.equal(stale.execution_status, 'snapshot_miss');
  assert.ok(stale.trace.rows_read.length > 0, 'old stream reached posted facts before the additional pending read');
  assert.ok(stale.fatal.includes('SNAPSHOT_MISS'));
});
