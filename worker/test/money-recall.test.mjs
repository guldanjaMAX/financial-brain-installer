import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProductFixture } from './product-contract-fixture.mjs';
import { applyMoneyRecallVeto, moneyRecordQualification } from '../src/lib/money-recall.js';
import { applyMoneyVeto } from '../src/lib/money-veto.js';
import { applyTemporalVeto } from '../src/lib/temporal-guard.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const record = (content, date = '2026-10-10') => ({ content, date });
const charge = 'Payer North charged USD 120.00 for October on card ending 4242.';
const question = 'What charge did Payer North record?';
const quoted = (text, n = 1, day = '2026-10-10', no = false) =>
  `${no ? 'No, as' : 'As'} of ${day}, the record states "${text}" [${n}]. Current status is unknown.`;

async function run(t, { q = question, records = [record(charge)], draft = `${charge} [1].`,
  repaired = draft, verdict, empty = false, searchFails = false, verifierFails = false, allowMissing = false } = {}) {
  t.mock.method(Date, 'now', () => NOW);
  let drafts = 0, verifiers = 0, network = 0, searches = 0;
  const prompts = [];
  const numbers = new Map();
  const render = text => String(text).replace(/\[r(\d+)\]/g, (_, i) => `[${numbers.get(Number(i))}]`);
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('network forbidden'); });
  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (String(model).includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
    const system = String(input.messages?.[0]?.content || '');
    const prompt = String(input.messages?.at(-1)?.content || '');
    prompts.push({ system, prompt });
    if (system.includes('verify a proposed answer')) {
      verifiers++;
      if (verifierFails) throw new Error('synthetic verifier unavailable');
      const answer = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(prompt)?.[1] || '';
      const evidence = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])))];
      return { response: { supported: true, complete: true, evidence, conflicts: [],
        reason: 'synthetic verdict', ...(typeof verdict === 'function' ? verdict({ prompt, answer }) : verdict) } };
    }
    drafts++;
    records.forEach((row, i) => {
      const at = prompt.indexOf(row.content);
      if (at >= 0) {
        const preceding = [...prompt.slice(0, at).matchAll(/^\[(\d+)\] \(/gm)];
        numbers.set(i, Number(preceding.at(-1)?.[1]));
      }
    });
    return { response: typeof draft === 'function' ? draft({ system, prompt, drafts }) : render(drafts === 1 ? draft : repaired) };
  } } } });
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','gmail','ready','2026-10-10')");
    for (let i = 0; i < records.length; i++) {
      const response = await fixture.post('/api/admin/brain/ingest/batch', { docs: [{
        source_type: 'records', source_id: `record-${i}`, title: `Payment record ${i}`,
        content: records[i].content, occurred_at: records[i].date,
        date_reliable: true, date_source: 'fixture:record_date', text_source: 'native', text_reliable: true,
        metadata: { evidence_lineage: { version: 1, kind: 'source_record' } },
      }] }, { 'X-Admin-Key': fixture.env.ADMIN_KEY });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).results[0].status, 'created');
    }
    // Synthetic in-memory projection receipt: distinguish a healthy miss from
    // an outbox backlog. This does not contact or certify an actual index.
    fixture.raw('DELETE FROM vector_outbox');
    const vectorCount = fixture.first('SELECT COUNT(*) AS n FROM chunks').n;
    fixture.raw("UPDATE install_state SET vector_projection_status='verified', vector_projection_bootstrap_base_count=? WHERE id=1", vectorCount);
    fixture.env.VECTORIZE.describe = async () => ({ vectorCount, processedUpToMutation: null });
    fixture.env.VECTORIZE.query = async () => {
      searches++;
      if (searchFails) throw new Error('synthetic vector search unavailable');
      return { matches: empty ? [] : fixture.rows('SELECT chunk_uid AS id FROM chunks') };
    };
    if (searchFails) fixture.control.failOn = /FROM chunks_fts/;
    const response = await fixture.post('/api/rag/think', { q }, { 'X-Admin-Key': fixture.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(searches > 0, 'the real retrieval decision was reached');
    const keywordQueries = fixture.seen.sql.filter(sql => /FROM chunks_fts/.test(sql)).length;
    assert.ok(keywordQueries > 0, 'the real keyword decision was reached');
    if (!empty && !searchFails && !allowMissing) {
      assert.ok(body.results.length > 0, 'stored evidence was actually retrieved');
      assert.ok(drafts > 0, 'the real model draft decision was reached');
    }
    assert.equal(network, 0, 'no external fetch was attempted');
    return { body, drafts, verifiers, prompts, render, keywordQueries };
  } finally { fixture.close(); }
}
const accepted = (r, text) => {
  assert.equal(r.body.answer, text, r.body.evidence_gate?.reason);
  assert.equal(r.body.evidence_gate.supported, true);
  assert.ok(r.body.citations.length > 0);
  assert.equal(r.verifiers, 1, 'a real verifier decision was reached');
};
const refused = (r, reason) => {
  assert.equal(r.body.answer, null);
  assert.equal(r.body.evidence_gate?.supported, false);
  assert.deepEqual(r.body.citations, []);
  assert.equal(r.verifiers, 1, 'refusal followed the real verifier decision');
  if (reason) assert.match(r.body.evidence_gate.reason, reason);
};

test('A: missing per-sentence citation gets one model repair and full verification', async t => {
  const first = 'Payer North charged USD 120.00. Card ending 4242 was charged USD 120.00 [1].';
  const fixed = 'Payer North charged USD 120.00 [1]. Card ending 4242 was charged USD 120.00 [1].';
  const r = await run(t, { draft: first, repaired: fixed });
  accepted(r, fixed);
  assert.equal(r.drafts, 2);
  assert.ok(r.prompts.some(p => p.prompt.includes('REGENERATION REQUIREMENTS')));
});

test('A control: already cited figure remains byte-identical without repair', async t => {
  const answer = 'Payer North charged USD 120.00 [1].';
  const r = await run(t, { draft: answer });
  accepted(r, answer); assert.equal(r.drafts, 1);
});

test('A control: a repeated missing citation still refuses after bounded repair', async t => {
  const r = await run(t, { draft: 'Payer North charged USD 120.00. Card ending 4242 was charged USD 120.00 [1].' });
  refused(r, /no exact cited span/); assert.equal(r.drafts, 2);
});

const oldStatus = 'Payer North subscription is cancelled.';
const unrelated = 'Payer North subscription contact address was updated.';
const statusQuestion = 'What is the current subscription payment status for Payer North?';
// Bind draft citations to the document numbers actually supplied by retrieval.
const history = quoted(oldStatus, 'r0', '2026-10-01');

test('B: model-written exact dated history survives a newer non-contradicting record', async t => {
  const r = await run(t, { q: statusQuestion,
    records: [record(oldStatus, '2026-10-01'), record(unrelated)], draft: history });
  accepted(r, r.render(history));
  assert.equal(r.body.evidence_gate.partial, true);
  assert.ok(r.prompts.some(p => p.prompt.includes('ALL RETRIEVED EVIDENCE FOR CONFLICT REVIEW')));
});

test('B control: a newer contradiction still refuses dated history', async t => {
  const newer = 'Payer North subscription restarted.';
  const r = await run(t, { q: statusQuestion,
    records: [record(oldStatus, '2026-10-01'), record(newer)], draft: history,
    verdict: ({ prompt }) => ({ conflicts: [{ n: Number(/\[(\d+)\] \([^\n]*\n[^\n]*Payer North subscription restarted/.exec(prompt)?.[1]), quote: newer }] }) });
  refused(r, /conflict/);
});

test('B control: conflict review cannot be omitted', async t => {
  const r = await run(t, { q: statusQuestion,
    records: [record(oldStatus, '2026-10-01'), record(unrelated)], draft: history,
    verdict: { conflicts: undefined } });
  refused(r, /conflict check unavailable/);
});

test('C: a cancelled-payment premise is repaired to a scoped cited negative fact', async t => {
  const answer = quoted(oldStatus, 1, '2026-10-10', true);
  const r = await run(t, { q: 'When is my next subscription payment for Payer North?',
    records: [record(oldStatus)], draft: 'No payment is due [1].', repaired: answer });
  accepted(r, answer); assert.equal(r.drafts, 2);
});

test('C control: an unchanged whole-window absence still refuses', async t => {
  const r = await run(t, { q: 'When is my next subscription payment for Payer North?',
    records: [record(oldStatus)], draft: 'No payment is due [1].' });
  refused(r, /ledger/); assert.equal(r.drafts, 2);
});

test('D: search with no surfaced evidence stays null and never calls an answer model', async t => {
  const r = await run(t, { empty: true, q: 'What revenue breakdown?', records: [record('Mechanical settings stable.')] });
  assert.equal(r.body.answer, null); assert.deepEqual(r.body.results, []);
  assert.equal(r.drafts, 0); assert.equal(r.verifiers, 0);
  assert.notEqual(r.body.status, 'search_unavailable', 'a healthy miss is distinguished from failed search');
});

test('D control: surfacing the record permits its cited answer', async t => {
  accepted(await run(t), `${charge} [1].`);
});

test('E: verifier unavailability stays null with an explicit error', async t => {
  const r = await run(t, { verifierFails: true });
  refused(r); assert.ok(r.body.answer_error);
});

test('E: both search paths failing stay search_unavailable', async t => {
  const r = await run(t, { searchFails: true });
  assert.equal(r.body.answer, null); assert.equal(r.body.status, 'search_unavailable');
  assert.equal(r.drafts, 0); assert.equal(r.verifiers, 0);
});

test('E control: an upstream negative verdict cannot be upgraded by exact quotation', async t => {
  const r = await run(t, { draft: quoted(charge), verdict: { supported: false, evidence: [], reason: 'synthetic rejection' } });
  refused(r, /synthetic rejection/);
});

test('F: an unqualified current figure from an older record is refused', async t => {
  const r = await run(t, { q: 'What is the current revenue for Payer North?',
    records: [record('Payer North revenue USD 120.00.', '2024-10-01'), record('Payer North revenue USD 180.00.')],
    draft: 'Payer North revenue is USD 120.00 [r0].' });
  refused(r, /older money evidence/);
});

test('F control: the model may quote the newest figure with its date', async t => {
  const answer = quoted('Payer North revenue USD 180.00.', 'r1');
  const r = await run(t, { q: 'What is the current revenue for Payer North?',
    records: [record('Payer North revenue USD 120.00.', '2024-10-01'), record('Payer North revenue USD 180.00.')],
    draft: answer });
  accepted(r, r.render(answer));
});

for (const [label, wrong] of [
  ['figure', charge.replace('120.00', '121.00')],
  ['payer', charge.replace('Payer North', 'Payer South')],
  ['month', charge.replace('October', 'September')],
  ['account mask', charge.replace('4242', '4343')],
]) test(`adversarial: wrong ${label} refuses even with a permissive verifier`, async t => {
  const r = await run(t, { draft: quoted(wrong) });
  refused(r, /span|quote/);
});

test('adversarial: a different quoted payer in the question cannot borrow a record', async t => {
  const r = await run(t, { q: 'What charge did "Payer South" record?', draft: quoted(charge) });
  refused(r, /subject|quote|span/);
});

test('adversarial: a quote cannot negate or omit a clause from its source sentence', async t => {
  const content = 'Payer North did not pay USD 120.00 for October on card ending 4242.';
  const r = await run(t, { records: [record(content)], draft: quoted(content.replace('did not pay', 'paid')) });
  refused(r, /span|quote/);
});

test('quote control: exact same-record quotation stays verbatim', async t => {
  accepted(await run(t, { draft: quoted(charge) }), quoted(charge));
});


test('observation control: a record date cannot become a claimed payment date', async t => {
  const r = await run(t, { q: 'When did Payer North pay?',
    records: [record('Payer North paid USD 120.00.')],
    draft: 'Payer North paid USD 120.00 on 2026-10-10 [1].' });
  refused(r, /span/);
});

test('observation control: the wrong as-of day still refuses an exact quote', async t => {
  const r = await run(t, { draft: quoted(charge, 1, '2026-10-09') });
  refused(r, /quote/);
});


test('D: bounded lexical expansion surfaces a sales record for a revenue-breakdown question', async t => {
  const answer = 'Sales gross USD 120.00 [1].';
  const r = await run(t, { q: 'What revenue breakdown?', records: [record('Sales gross USD 120.00.')],
    empty: true, allowMissing: true, draft: answer });
  accepted(r, answer);
  assert.ok(r.keywordQueries >= 2, 'the expansion reached actual SQL retrieval');
});


test('C: an unpaid-invoice premise is repaired to the cited invoice status', async t => {
  const content = 'Payer North invoice remains unpaid.';
  const answer = quoted(content, 1, '2026-10-10', true);
  const r = await run(t, { q: 'Payer North paid, right?', records: [record(content)],
    draft: 'No payment received [1].', repaired: answer });
  accepted(r, answer); assert.equal(r.drafts, 2);
});

test('quote offsets bind the exact model-visible excerpt after its storage header', async t => {
  const r = await run(t, { draft: quoted(charge) });
  accepted(r, quoted(charge));
  const spans = r.body.evidence_gate.quoted_spans;
  assert.equal(spans.length, 1);
  const span = spans[0];
  const snippet = r.body.results[span.n - 1].snippet.replace(/\s+/g, ' ').slice(0, 900);
  assert.equal(snippet.slice(span.start, span.end), charge);
  assert.ok(span.start >= 0 && span.end > span.start);
});

test('adversarial: changing the payer in a question without a month still refuses', async t => {
  const content = 'Payer North charged USD 120.00.';
  const r = await run(t, { q: 'What charge did "Payer South" record?', records: [record(content)], draft: quoted(content) });
  refused(r, /subject|quote/);
});

test('adversarial: a negated cancellation cannot justify the negative-premise form', async t => {
  const content = 'Payer North subscription was not cancelled.';
  const r = await run(t, { q: 'When is my next subscription payment for Payer North?', records: [record(content)],
    draft: quoted(content, 1, '2026-10-10', true) });
  refused(r, /quote/);
});


test('observation control: one as-of day cannot lend its date to a later payment clause', async t => {
  const r = await run(t, { q: 'When did Payer North pay?', records: [record('Payer North paid USD 120.00.')],
    draft: 'As of 2026-10-10, Payer North paid USD 120.00 on 2026-10-10 [1].' });
  refused(r, /span/);
});

test('E: one empty money completion gets a bounded model retry and verification', async t => {
  const answer = 'Payer North charged USD 120.00 [1].';
  const r = await run(t, { draft: '', repaired: answer });
  accepted(r, answer); assert.equal(r.drafts, 2);
});

test('E control: repeated empty completions remain null with a reviewed error', async t => {
  const r = await run(t, { draft: '' });
  assert.equal(r.body.answer, null);
  assert.deepEqual(r.body.citations, []);
  assert.equal(r.drafts, 2, 'both generation decisions were reached');
  assert.equal(r.verifiers, 0, 'empty drafts never enter a verifier');
  assert.equal(r.body.answer_error, 'Answer generation is unavailable right now. Try again in a moment.');
});

const paymentQuestion = 'Payer North paid, right?';
const unpaid = 'Payer North invoice remains unpaid.';
const paid = 'Payer North paid USD 120.00.';
for (const repair of [false, true]) {
  test(`B01 control: same-payer unpaid quotation survives ${repair ? 'repair' : 'ordinary generation'}`, async t => {
    const answer = quoted(unpaid, 1, '2026-10-10', true);
    const r = await run(t, { q: paymentQuestion, records: [record(unpaid)],
      draft: repair ? 'No payment was received [1].' : answer, repaired: answer });
    assert.equal(r.drafts, repair ? 2 : 1);
    accepted(r, answer);
  });

  test(`B01: wrong-payer unpaid quotation refuses after ${repair ? 'repair' : 'ordinary generation'}`, async t => {
    const content = `${paid} Payer South invoice remains unpaid.`;
    const answer = quoted(content, 1, '2026-10-10', true);
    const r = await run(t, { q: paymentQuestion, records: [record(content)],
      draft: repair ? 'No payment was received [1].' : answer, repaired: answer });
    assert.equal(r.drafts, repair ? 2 : 1);
    assert.equal(r.verifiers, 1, 'the approval decision was reached');
    refused(r);
  });
}

test('B01 attribution control: ordinary positive payment survives the other payer unpaid record', async t => {
  const answer = 'Payer North paid USD 120.00 [1].';
  const r = await run(t, { q: paymentQuestion,
    records: [record(`${paid} Payer South invoice remains unpaid.`)], draft: answer });
  assert.equal(r.drafts, 1);
  accepted(r, answer);
});

for (const [label, content] of [
  ['two-sentence month excerpt', `${charge} The invoice is provisional.`],
  ['single-sentence month control', charge],
  ['two-sentence control without month', `${charge.replace(' for October', '')} The invoice is provisional.`],
]) test(`B02: ${label} survives qualified recall after repair`, async t => {
  const answer = quoted(content);
  const r = await run(t, { records: [record(content)], draft: '', repaired: answer });
  assert.equal(r.drafts, 2);
  assert.equal(r.verifiers, 1, 'the exact-quote verifier decision was reached');
  const spans = r.body.evidence_gate.quoted_spans;
  assert.ok(spans.length, 'exact-quote offsets were recognized before the final veto');
  const span = spans[0];
  const snippet = r.body.results[span.n - 1].snippet.replace(/\s+/g, ' ').slice(0, 900);
  assert.ok(span.start >= 0);
  assert.equal(snippet.slice(span.start, span.end), content);
  accepted(r, answer);
});

const recallInput = content => ({ question, answer: quoted(content), now: NOW, timeZone: 'UTC',
  docs: [{ n: 1, snippet: `[record] ${content}`, ts: '2026-10-10', date_reliable: true,
    text_source: 'native', text_reliable: true }],
  evidenceGate: { supported: true, complete: true, evidence: [1] } });

test('B02 localized: whole-excerpt qualification retains months through the final veto', () => {
  const control = recallInput(charge);
  assert.equal(applyMoneyVeto(control).evidenceGate.supported, true);
  const content = `${charge} The invoice is provisional.`;
  const input = recallInput(content);
  const recognized = moneyRecordQualification(input);
  assert.deepEqual(recognized.evidence, [1], 'entire exact quote recognition reached');
  assert.equal(input.docs[0].snippet.slice(recognized.spans[0].start, recognized.spans[0].end), content);
  assert.equal(applyMoneyRecallVeto(input).evidenceGate.supported, true);
  assert.equal(applyMoneyVeto(input).evidenceGate.supported, true);
});

for (const content of [charge, `${charge} The invoice is provisional.`]) test('B01/B02 invariants: guards preserve rejected verdicts and never mutate input', () => {
  for (const guard of [applyMoneyRecallVeto, applyMoneyVeto, applyTemporalVeto]) {
    const control = recallInput(content);
    assert.ok(moneyRecordQualification(control).evidence.length, 'matching qualification decision reached');
    const approved = guard(control);
    assert.equal(approved.evidenceGate.supported, true);
    assert.equal(approved.answer, control.answer);
    const input = { ...control,
      evidenceGate: { supported: false, complete: false, evidence: [], reason: 'fixture rejection' } };
    const saved = structuredClone(input);
    assert.equal(guard(input).evidenceGate.supported, false);
    assert.deepEqual(input, saved);
  }
});

for (const [label, q, content] of [
  ['negative question', 'Payer North did not pay, right?', unpaid],
  ['unpaid question', 'Is Payer North invoice unpaid?', unpaid],
  ['open question', 'What is the payment status for Payer North?', unpaid],
  ['missing subject', 'Was the invoice paid?', unpaid],
  ['negation inside apparent subject', 'No Payer North paid, right?', 'No Payer North invoice remains unpaid.'],
  ['same-payer different invoice', 'Payer North paid invoice 17, right?',
    'Payer North paid invoice 17. Payer North invoice 18 remains unpaid.'],
  ['same-payer different amount', 'Did Payer North pay USD 120.00?',
    'Payer North paid USD 120.00. Payer North did not pay USD 180.00.'],
  ['same-payer different month', 'Did Payer North pay for October?',
    'Payer North paid for October. Payer North did not pay for September.'],
  ['same-payer different account', 'Did Payer North pay on card ending 4242?',
    'Payer North paid on card ending 4242. Payer North did not pay on card ending 4343.'],
  ['same-payer different date', 'Did Payer North pay on 2026-10-09?',
    'Payer North paid on 2026-10-09. Payer North did not pay on 2026-10-08.'],
  ['same-sentence other payer', paymentQuestion,
    'Payer North paid USD 120.00 but Payer South invoice remains unpaid.'],
  ['mentioned subject is not payer', paymentQuestion,
    'For Payer North, Payer South invoice remains unpaid.'],
  ['hypothetical unpaid', paymentQuestion,
    'If Payer North invoice remains unpaid, contact the payer.'],
  ['cancellation does not contradict completed payment', paymentQuestion, oldStatus],
  ['unpaid does not cancel future payment', 'When is my next subscription payment for Payer North?', unpaid],
]) test(`B01 binding refuses ${label}`, async t => {
  const answer = quoted(content, 1, '2026-10-10', true);
  const r = await run(t, { q, records: [record(content)], draft: answer });
  assert.equal(r.drafts, 1);
  assert.equal(r.verifiers, 1, 'nonempty exact quote reached verification');
  refused(r);
});

for (const [q, content] of [
  ['Payer North paid invoice 17, right?', 'Payer North invoice 17 remains unpaid.'],
  ['Did Payer North pay USD 120.00?', 'Payer North did not pay USD 120.00.'],
  ['Did Payer North pay for October?', 'Payer North did not pay for October.'],
  ['Did Payer North pay on card ending 4242?', 'Payer North did not pay on card ending 4242.'],
  ['Did Payer North pay on 2026-10-09?', 'Payer North did not pay on 2026-10-09.'],
]) test('B01 payment control: explicitly requested payment has its own direct negation', async t => {
  const answer = quoted(content, 1, '2026-10-10', true);
  const r = await run(t, { q, records: [record(content)], draft: answer });
  accepted(r, answer);
});

test('B02 boundary: an excerpt cannot supply another account or payer month', () => {
  const content = `${charge} The invoice is provisional.`;
  const control = recallInput(content);
  assert.deepEqual(moneyRecordQualification(control).evidence, [1]);
  assert.equal(applyMoneyVeto(control).answer, control.answer);
  for (const [q, text] of [
    ['Which months for card ending 4242?',
      'Card ending 4242 statement months: October. Card ending 4343 statement months: September.'],
    ['Which months for account `Reserve`?',
      'Account `Reserve` statement months: October. Account `Spending` statement months: September.'],
    ['Which months for Payer North?',
      'Payer North statement months: October. Payer South statement months: September.'],
  ]) {
    const input = { ...recallInput(text), question: q };
    assert.equal(input.evidenceGate.supported, true, 'approved exact excerpt reaches month binding');
    assert.deepEqual(moneyRecordQualification(input).evidence, [1]);
    const result = applyMoneyVeto(input);
    assert.equal(result.answer, null);
    assert.equal(result.evidenceGate.supported, false);
    assert.equal(result.gap.rule, 'span_mismatch');
  }
});

test('B02 boundary: omitted source text and forged quotation offsets still refuse', async t => {
  const content = `${charge} The charge was not authorized.`;
  const r = await run(t, { records: [record(content)], draft: '', repaired: quoted(charge) });
  assert.equal(r.drafts, 2);
  refused(r, /span|quote/);
  const input = recallInput(content);
  input.answer = quoted(charge.replace('October', 'September'));
  input.evidenceGate.quoted_spans = [{ n: 1, start: 9, end: 9 + charge.length }];
  assert.equal(input.evidenceGate.supported, true);
  assert.equal(applyMoneyVeto(input).gap.rule, 'span_mismatch');
});

test('B02 boundary: exact account labels cannot lose punctuation in a whole quotation', () => {
  const input = { ...recallInput('Account `Reserve-one` statement months: October. The invoice is provisional.'),
    question: 'Which months for account `Reserve-one`?' };
  assert.deepEqual(moneyRecordQualification(input).evidence, [1]);
  assert.equal(applyMoneyVeto(input).answer, input.answer);
  const probe = { ...input, question: 'Which months for account `Reserve one`?' };
  assert.equal(probe.evidenceGate.supported, true, 'exact quoted excerpt reaches the final veto');
  assert.equal(applyMoneyVeto(probe).gap.rule, 'span_mismatch');
});

for (const content of [unpaid, `${charge} The invoice is provisional.`]) {
  test('B01/B02: verifier rejection after repaired exact quotation remains rejected', async t => {
    const negative = content === unpaid;
    const r = await run(t, { q: negative ? paymentQuestion : question, records: [record(content)],
      draft: negative ? 'No payment was received [1].' : '',
      repaired: quoted(content, 1, '2026-10-10', negative),
      verdict: { supported: false, complete: false, evidence: [], reason: 'fixture rejection' } });
    assert.equal(r.drafts, 2);
    assert.equal(r.verifiers, 1, 'the repaired quotation reached the rejecting verifier');
    refused(r, /fixture rejection/);
  });
}
