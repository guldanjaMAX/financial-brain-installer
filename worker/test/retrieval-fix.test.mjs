import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentDate } from '../../ingest/doc-date.mjs';
import { search } from '../src/lib/store-d1.js';
import worker from '../src/index.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const row = (id, title, text, extra = {}) => ({
  chunk_uid: `files:${id}#0`, doc_uid: `files:${id}`, source_id: id,
  source: 'files', source_kind: 'folder', title, text,
  document_date: Date.parse('2026-09-10'), date_source: 'content', date_reliable: 1,
  text_source: 'native', text_reliable: 1, ...extra,
});

function fixture(rows, { select, draft = 'The recorded setting is enabled [1].', verdict } = {}) {
  const calls = { keyword: [], metadata: 0, answer: 0, verifier: 0, prompts: [] };
  const env = {
    STORAGE: 'd1', ADMIN_KEY: randomUUID(), BRAIN_OWNER: 'Fixture Owner',
    DB: { prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async all() {
          if (/name-variant-metadata/.test(sql)) { calls.metadata++; return { results: rows }; }
          if (/chunks_fts MATCH/.test(sql)) {
            calls.keyword.push(args[0]);
            return { results: select ? select(args[0], rows) : rows };
          }
          if (/FROM chunks c JOIN documents/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async first() {
          if (/vector_projection_mutation_id AS mutation_id/.test(sql)) return {
            schema_version: 53, mutation_id: null, projection_status: 'verified',
            bootstrap_epoch: 0, expected_vectors: 0, pending: 0, submitted: 0,
          };
          if (/FROM vector_outbox/.test(sql)) return { n: 0, upserts: 0, deletes: 0, submitted: 0 };
          return null;
        },
        async run() { return {}; },
      };
      return statement;
    } },
    VECTORIZE: { query: async () => ({ matches: [] }), describe: async () => ({ vectorCount: 0 }) },
    AI: { async run(model, input) {
      if (model.includes('bge-')) return { data: [[0.1]] };
      const system = input.messages[0].content;
      calls.prompts.push(input.messages.map(message => message.content).join('\n'));
      const verify = /verify a proposed answer|verify each synthesis item/.test(system);
      calls[verify ? 'verifier' : 'answer']++;
      return { response: verify ? (verdict || { supported: true, complete: true, evidence: [1], conflicts: [] }) : draft };
    } },
  };
  const think = async (q) => {
    const original = Date.now;
    Date.now = () => NOW;
    try {
      const response = await worker.fetch(new Request('https://fixture.invalid/api/rag/think', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY },
        body: JSON.stringify({ q }),
      }), env, { waitUntil() {} });
      assert.equal(response.status, 200);
      return response.json();
    } finally { Date.now = original; }
  };
  return { env, calls, think };
}

 test('explicit body freshness wins over an older filename; an ordinary body date does not', () => {
  const base = { filename: 'Workspace State (2026-08-04).md' };
  assert.equal(documentDate({ ...base, contentHead: 'A milestone is 2026-09-21.' }).source, 'filename');
  const actual = documentDate({ ...base, contentHead: '# State\nLast updated 2026-09-21\nEnabled.' });
  assert.equal(actual.value, Date.parse('2026-09-21'));
  assert.equal(actual.source, 'content');
  assert.equal(actual.reliable, true);
 });
 test('started title is explicit content provenance', () => {
  assert.equal(documentDate({ filename: 'Workspace LOG (started 2026-09-21).md' }).source, 'content');
 });
 test('ranked file families free result slots and keep history on request', async () => {
  const rows = [
    row('b1', 'Workspace plan (backup pre-2026-08-10 edit).xlsx', 'workspace plan'),
    row('b2', 'Copy of Workspace plan.xlsx', 'workspace plan'),
    row('canonical', 'Workspace plan.xlsx', 'workspace plan'),
    row('next', 'Launch checklist.md', 'workspace launch checklist'),
  ];
  const { env, calls } = fixture(rows);
  const history = await search(env, { query: 'workspace plan history', limit: 3 });
  assert.equal(history.results.length, 3);
  const result = await search(env, { query: 'workspace plan', limit: 2 });
  assert.ok(calls.keyword.length >= 2, 'real keyword decision reached');
  assert.deepEqual(result.results.map(r => r.source_id), ['canonical', 'next']);
 });
 test('a missing exact name expands only to one metadata spelling', async () => {
  const rows = [row('record', 'Zorvyn project notes', 'Review the launch checklist.', {
    authority_meta: JSON.stringify({ attendees: ['Zorvyn'] }),
  })];
  const { env, calls } = fixture(rows, { select: terms => /Zorvyn/i.test(terms) ? rows : [] });
  const result = await search(env, { query: 'What was agreed with Zorvan?', limit: 5 });
  assert.ok(calls.keyword.length, 'exact lookup reached');
  assert.equal(result.results[0]?.source_id, 'record');
  assert.equal(result.results[0]?.query_variant?.matched, 'Zorvyn');
 });
 test('domain expansion adds a candidate lane and leaves other queries alone', async () => {
  const target = row('primary', 'Owner panel results.md', 'Panel results are recorded.');
  const { env, calls } = fixture([target], { select: terms => /labs|panel/.test(terms) ? [target] : [] });
  const control = await search(env, { query: 'workspace setting', limit: 5 });
  assert.equal(control.results.length, 0);
  assert.equal(calls.keyword.length, 1);
  const result = await search(env, { query: 'my bloodwork', limit: 5 });
  assert.equal(result.results[0]?.source_id, 'primary');
  assert.ok(calls.keyword.some(terms => /bloodwork/.test(terms)), 'original terms retained');
 });
 test('primary dated present-status evidence is qualified instead of refused', async () => {
  const primary = row('setup', 'Fixture Owner signed agreement.md', 'The current workspace setup is a docking station and external display.', {
    authority_meta: JSON.stringify({ evidence_lineage: { version: 1, kind: 'source_record' }, provenance_receipt: { version: 1, status: 'complete', reason: 'lineage_and_text_recorded', root_ids: ['files:setup'] } }),
  });
  const { think, calls } = fixture([primary], { draft: 'The current workspace setup is a docking station and external display [1].' });
  const result = await think('What is my current workspace setup?');
  assert.equal(calls.verifier, 1, 'verifier decision reached');
  assert.match(result.answer || '', /as of 2026-09-10 \(31 days old\)/i, JSON.stringify(result));
  assert.ok(result.gaps.some(gap => gap.type === 'stale'));
 });
 test('synthesis verifies individual cited spans and drops one unsupported item', async () => {
  const rows = [row('one', 'Workspace review.md', 'Prepare the launch checklist.'), row('two', 'Workspace followup.md', 'Review the access roles.')];
  const { think, calls } = fixture(rows, {
    draft: '- Prepare the launch checklist [1].\n- Review the access roles [2].\n- Close the project [2].',
    verdict: { supported: false, complete: false, evidence: [], items: [
      { item: 1, supported: true, evidence: [{ n: 1, quote: 'Prepare the launch checklist.' }] },
      { item: 2, supported: true, evidence: [{ n: 2, quote: 'Review the access roles.' }] },
      { item: 3, supported: false, evidence: [] },
    ] },
  });
  const result = await think('List all the things I am doing for Workspace.');
  assert.ok(calls.verifier > 0, 'item verifier reached');
  assert.match(result.answer || '', /Prepare the launch checklist/);
  assert.match(result.answer || '', /Review the access roles/);
  assert.doesNotMatch(result.answer || '', /Close the project/);
  assert.equal(result.citations.length, 2);
 });

test('date labels reject invalid, quoted and unlabelled dates and keep provider clocks', async () => {
  const { withContentFreshness } = await import('../src/lib/content-freshness.js');
  const base = { title: 'State (2026-08-04).md', occurred_at: '2026-08-04', date_source: 'filename', content: 'Updated 2026-09-21' };
  assert.equal(withContentFreshness(base).date_source, 'content');
  for (const content of ['Updated 2026-02-30', '> Updated 2026-09-21', 'Deadline 2026-09-21']) {
    assert.equal(withContentFreshness({ ...base, content }).date_source, 'filename');
  }
  assert.equal(withContentFreshness({ ...base, date_source: 'email_header' }).occurred_at, '2026-08-04');
  assert.equal(documentDate({ filename: 'State (2026-10-01).md', contentHead: 'As of 2026-09-21' }).value, Date.parse('2026-10-01'));
  assert.equal(documentDate({ filename: 'State.md', contentHead: `${'ordinary text\n'.repeat(300)}Updated 2026-09-21` }).value, Date.parse('2026-09-21'));
});

test('family selection keeps newest canonical, separates sources and leaves unrelated ranking unchanged', async () => {
  const { collapseTitleFamilies } = await import('../src/lib/retrieval-expansion.js');
  const old = row('old', 'State (2026-08-04).md', 'old', { document_date: Date.parse('2026-08-04') });
  const fresh = row('fresh', 'State (2026-09-21).md', 'new', { document_date: Date.parse('2026-09-21') });
  const backup = row('backup', 'State BACKUP 2026-10-01-0916.md', 'backup', { document_date: Date.parse('2026-10-01') });
  const different = { ...fresh, source: 'other', source_id: 'other' };
  const rows = [old, backup, fresh, different];
  assert.deepEqual(collapseTitleFamilies(rows, 'state').map(r => r.source_id), ['fresh', 'other']);
  assert.equal(collapseTitleFamilies(rows, 'previous state versions'), rows);
  const controls = [row('a', 'First record.md', 'a'), row('b', 'Second record.md', 'b')];
  assert.deepEqual(collapseTitleFamilies(controls, 'setting'), controls);
});

test('exact and ambiguous names do not silently select a variant', async () => {
  const exactRows = [row('exact', 'Zorvan review', 'Zorvan review')];
  const exact = fixture(exactRows);
  assert.equal((await search(exact.env, { query: 'Review Zorvan', limit: 5 })).results.length, 1);
  assert.equal(exact.calls.metadata, 0);
  const ambiguousRows = [row('a', 'Zorvyn review', ''), row('b', 'Zorven review', '')];
  const ambiguous = fixture(ambiguousRows, { select: () => [] });
  const result = await search(ambiguous.env, { query: 'Review Zorvan', limit: 5 });
  assert.ok(ambiguous.calls.metadata > 0, 'ambiguity decision reached metadata');
  assert.equal(result.results.length, 0);
  const lower = fixture([], { select: () => [] });
  await search(lower.env, { query: 'review workspace', limit: 5 });
  assert.equal(lower.calls.keyword.length, 1);
  assert.equal(lower.calls.metadata, 0);
});

test('dated status refuses unreliable evidence and surfaces a newer conflict', async () => {
  const primary = row('setup', 'Fixture Owner signed agreement.md', 'The current workspace setup is a docking station and external display.', {
    authority_meta: JSON.stringify({ evidence_lineage: { version: 1, kind: 'source_record' }, provenance_receipt: {
      version: 1, status: 'complete', reason: 'lineage_and_text_recorded', root_ids: ['files:setup'],
    } }),
  });
  const draft = 'The current workspace setup is a docking station and external display [1].';
  const good = fixture([primary], { draft });
  assert.match((await good.think('What is my current workspace setup?')).answer || '', /31 days old/);
  const untrusted = fixture([{ ...primary, text_source: 'ocr', text_reliable: 0 }], { draft });
  assert.equal((await untrusted.think('What is my current workspace setup?')).answer, null);
  assert.equal(untrusted.calls.verifier, 1);
  const conflict = row('conflict', 'Fixture Owner workspace change.md', 'The external display was removed.', { document_date: Date.parse('2026-10-01') });
  const checked = fixture([primary, conflict], { draft: draft.replace('[1]', '[2]'), verdict: { supported: true, complete: true, evidence: [2],
    conflicts: [{ n: 1, quote: 'The external display was removed.' }] } });
  const result = await checked.think('What is my current workspace setup?');
  assert.equal(checked.calls.verifier, 1);
  assert.equal(result.answer, null);
  assert.ok(result.gaps.some(gap => gap.type === 'status_conflict'));
  assert.ok(checked.calls.prompts.some(prompt => prompt.includes('The external display was removed.')));
});

test('synthesis requires each span in its own citation and keeps non-list answers unchanged', async () => {
  const rows = [row('one', 'Workspace review.md', 'Prepare the launch checklist.'), row('two', 'Workspace followup.md', 'Review the access roles.')];
  const draft = '- Prepare the launch checklist [1].\n- Review the access roles [2].';
  const checked = fixture(rows, { draft, verdict: { items: [
    { item: 1, supported: true, evidence: [{ n: 1, quote: 'Prepare the launch checklist.' }] },
    { item: 2, supported: true, evidence: [{ n: 2, quote: 'Prepare the launch checklist.' }] },
  ] } });
  const result = await checked.think('What is left for Workspace?');
  assert.ok(checked.calls.verifier > 0);
  assert.match(result.answer || '', /Prepare the launch checklist/);
  assert.doesNotMatch(result.answer || '', /Review the access roles/);
  assert.equal(result.citations.length, 1);
  const control = fixture(rows, { draft: 'Prepare the launch checklist [1].' });
  const ordinary = await control.think('What was recorded for Workspace?');
  assert.equal(control.calls.verifier, 1);
  assert.equal(ordinary.answer, 'Prepare the launch checklist [1].');
});

test('an already dated status gets an age, while a historical question is unchanged', async () => {
  const { qualifyDatedStatus } = await import('../src/lib/dated-status-answer.js');
  const answer = 'As of 2026-09-10, the current setup is enabled [1].';
  const input = { question: 'What is the current setup?', answer, now: NOW,
    docs: [{ n: 1, ts: '2026-09-10', date_reliable: true, text_source: 'native', text_reliable: true, authority: { tier: 'T1' } }] };
  const current = qualifyDatedStatus(input);
  assert.match(current.answer, /As of 2026-09-10 \(31 days old\)/);
  assert.deepEqual(current.evidence, [1]);
  assert.equal(qualifyDatedStatus({ ...input, question: 'What was the setup in 2026-09-10?' }).answer, answer);
});

test('rejecting every synthesis item remains failed verification, never a claim of corpus absence', async () => {
  const checked = fixture([row('one', 'Workspace notes.md', 'Prepare the checklist.')], {
    draft: '- Close the project [1].', verdict: { items: [{ item: 1, supported: false, evidence: [] }] },
  });
  const result = await checked.think('List all the workspace tasks');
  assert.equal(checked.calls.verifier, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.answer, null);
  assert.equal(result.status, 'answer_withheld');
  assert.equal(result.citations.length, 0);
  assert.match(result.notice || '', /evidence check did not support the draft/i);
});
