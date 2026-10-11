import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Mutate the actual helper source in memory, preserving its real imports.
// Nothing is written over product source and no external process is launched.
async function mutant(file, before, after) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), 'mutation reached its intended decision');
  const code = source.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

test('freshness probe kills filename-first mutation', async () => {
  const good = await import('../src/lib/content-freshness.js');
  const bad = await mutant('content-freshness.js', 'if (explicit === null) return null;', 'return null;');
  const input = { title: 'State (2026-08-04).md', content: 'Last updated 2026-09-21', dateSource: 'filename', date: Date.parse('2026-08-04') };
  assert.equal(good.contentFreshness(input).value, Date.parse('2026-09-21'));
  assert.equal(bad.contentFreshness(input), null);
});
test('family probe kills disabled-collapse mutation', async () => {
  const good = await import('../src/lib/retrieval-expansion.js');
  const bad = await mutant('retrieval-expansion.js', "if (HISTORY.test(String(query || ''))) return rows;", 'return rows;');
  const rows = [{ source: 'files', title: 'Copy of State.md' }, { source: 'files', title: 'State.md' }];
  assert.equal(good.collapseTitleFamilies(rows, 'state').length, 1);
  assert.equal(bad.collapseTitleFamilies(rows, 'state').length, 2);
});
test('name probe kills disabled edit-distance matching', async () => {
  const good = await import('../src/lib/retrieval-expansion.js');
  const bad = await mutant('retrieval-expansion.js', 'return edits + (i < a.length || j < b.length ? 1 : 0) === 1;', 'return false;');
  const rows = [{ title: 'Zorvyn review' }];
  assert.equal(good.metadataNameVariant('Zorvan', rows).matched, 'Zorvyn');
  assert.equal(bad.metadataNameVariant('Zorvan', rows), null);
});
test('topic probe kills disabled synonym map', async () => {
  const good = await import('../src/lib/retrieval-expansion.js');
  const bad = await mutant('retrieval-expansion.js', 'return DOMAINS.filter', 'return [].filter');
  assert.ok(good.domainExpansion('my bloodwork').includes('labs'));
  assert.deepEqual(bad.domainExpansion('my bloodwork'), []);
});
test('dated-state probe kills removal of qualification', async () => {
  const good = await import('../src/lib/dated-status-answer.js');
  const bad = await mutant('dated-status-answer.js', 'const qualified = sentences.map(sentence => {', 'const qualified = sentences.map(sentence => { return sentence;');
  const input = { question: 'What is my current workspace setup?', answer: 'The current setup is enabled [1].',
    now: Date.parse('2026-10-11'), docs: [{ n: 1, ts: '2026-09-10', date_reliable: true, text_source: 'native', text_reliable: true, authority: { tier: 'T1' } }] };
  assert.match(good.qualifyDatedStatus(input).answer, /31 days old/);
  assert.equal(bad.qualifyDatedStatus(input).answer, input.answer);
});
test('item probe kills citation-span validation bypass', async () => {
  const good = await import('../src/lib/synthesis-answer.js');
  const bad = await mutant('synthesis-answer.js', 'normalize(doc.snippet).includes(quote)', 'true');
  const input = { question: 'List all the workspace tasks', answer: '- Prepare the checklist [1].\n- Close the project [2].',
    docs: [{ n: 1, snippet: 'Prepare the checklist.' }, { n: 2, snippet: 'Review the access roles.' }],
    verify: async () => JSON.stringify({ items: [
      { item: 1, supported: true, evidence: [{ n: 1, quote: 'Prepare the checklist.' }] },
      { item: 2, supported: true, evidence: [{ n: 2, quote: 'Close the project.' }] },
    ] }) };
  const control = await good.verifySynthesis(input);
  const mutated = await bad.verifySynthesis(input);
  assert.equal(control.dropped, 1);
  assert.equal(mutated.dropped, 0);
  assert.doesNotMatch(control.answer, /Close the project/);
  assert.match(mutated.answer, /Close the project/);
});
