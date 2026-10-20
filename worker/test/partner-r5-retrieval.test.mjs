import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retrievalFailed } from '../src/lib/store-d1.js';

// Wire outcomes from both adapters, including legacy scope refusal. Projection
// gaps also block completeness, though they are not provider exceptions.
const outcomes = [
  [null, null, false],
  ['fts', 'keyword-query-failed', true],
  ['fts', 'keyword-search-unavailable', true],
  ['vector', 'vector-query-failed', true],
  ['vector', 'projection-catching-up', true],
  ['vector', 'projection-incomplete', true],
  ['vector', 'entity-vector-authority-unindexed', true],
  ['retrieval', 'keyword-and-vector-query-failed', true],
  ['no-embedding', 'embedding-unavailable', true],
  ['document-access-unavailable', 'exact-document-scope-requires-d1', true],
  ['document-access-unavailable', 'zone-scope-requires-d1', true],
  ['scoped-vector', 'document-scope-keyword-only', false],
  ['scoped-vector', 'zone-scope-keyword-only', false],
];
test('F2 every store degradation is classified and new failure outcomes cannot certify completeness', () => {
  const emitted = new Set();
  for (const name of ['store-d1.js', 'store.js']) {
    const source = readFileSync(new URL(`../src/lib/${name}`, import.meta.url), 'utf8');
    for (const m of source.matchAll(/\bdegraded\s*[:=]\s*(null|"[a-z-]+")/g)) emitted.add(JSON.parse(m[1]));
  }
  assert.ok(emitted.has('no-embedding') && emitted.has('document-access-unavailable'), 'both real store emitters inspected');
  assert.deepEqual([...emitted].sort(), [...new Set(outcomes.map(([value]) => value))].sort());
  for (const [value, reason, failed] of outcomes) assert.equal(retrievalFailed(value, reason), failed, `${value}:${reason}`);
  assert.equal(retrievalFailed(undefined), false, 'healthy omitted field control');
  assert.equal(retrievalFailed(null, 'embedding-unavailable'), true, 'failure reason cannot be lost with a missing token');
  assert.equal(retrievalFailed('scoped-vector', 'embedding-unavailable'), true, 'scope label cannot hide an actual failure');
  assert.equal(retrievalFailed('future-retrieval-failure'), true, 'unrecognized failure stays incomplete');
});
