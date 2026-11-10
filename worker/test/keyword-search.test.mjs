import test from 'node:test';
import assert from 'node:assert/strict';
import { searchKeyword } from '../src/lib/store-d1.js';
import { differentialCases, keywordFixture, oldKeyword, candidateLimit } from './fixtures/keyword-search.mjs';

for (const zoneCount of [97, 98]) {
  test(`keyword candidate query preserves the ${zoneCount + 2}-binding scope budget`, async () => {
    const f = keywordFixture(1000, { maxBindings: 100 });
    try {
      const zones = ['books', ...Array.from({ length: zoneCount - 1 }, (_, i) => `zone-${i}`)];
      for (const zone of zones.slice(1)) {
        f.db.prepare('INSERT INTO sources VALUES(?,?,?)').run(`source-${zone}`, 'upload', zone);
      }
      const options = { limit: 5, scope: { zones } };
      const expected = oldKeyword(f.db, '"payment"', options);
      assert.equal(expected.length, 5, 'old full-query control returns real rows');
      assert.deepEqual(await searchKeyword(f.env, 'payment', options), expected);
      const attempts = f.calls.filter(call => /chunks_fts MATCH/.test(call.sql));
      assert.ok(attempts.some(call => /keyword_candidates/.test(call.sql)), 'bounded FTS decision reached');
      assert.ok(attempts.every(call => call.params.length === zoneCount + 2), 'no extra candidate binding');
      assert.ok(attempts.every(call => !call.bindingRefused), 'D1 variable ceiling accepted every attempt');
    } finally { f.db.close(); }
  });
}

test('keyword candidate widening stays differential with the full FTS query', async () => {
  const f = keywordFixture();
  try { assert.equal(await differentialCases(searchKeyword, f), 24); }
  finally { f.db.close(); }
});

test('zero survivors widen at an exact full page and stop on proven FTS exhaustion', async () => {
  const f = keywordFixture(400);
  try {
    const hidden = await searchKeyword(f.env, 'payment', { limit: 5, filters: { source: 'absent-source' } });
    assert.deepEqual(hidden, []);
    const attempts = f.calls.filter(call => /chunks_fts MATCH/.test(call.sql));
    assert.deepEqual(attempts.map(candidateLimit), [400, 3200], 'exactly K requires an exhaustion check');
    assert.ok(attempts.every(call => call.rows === 1), 'zero-match sentinel carried the nonempty candidate count');
    assert.ok(attempts.every(call => /keyword_candidates/.test(call.sql)), 'exhaustion avoids full-query fallback');
    const visible = await searchKeyword(f.env, 'payment', { limit: 5 });
    assert.equal(visible.length, 5, 'same corpus and query have positive visible control');
  } finally { f.db.close(); }
});

test('nonpositive SQLite limits preserve the full-query contract', async () => {
  const f = keywordFixture(1000);
  try {
    for (const limit of [-1, 0]) {
      const options = { limit };
      const actual = await searchKeyword(f.env, 'payment', options);
      const expected = oldKeyword(f.db, '"payment"', options);
      assert.equal(actual.length, expected.length, 'SQLite limit retains its full result count');
      assert.deepEqual(actual, expected);
      assert.ok(f.calls.some(call => /chunks_fts MATCH/.test(call.sql)), 'real LIMIT decision reached');
    }
  } finally { f.db.close(); }
});

test('legacy retry removes memory authority only before schema 37 and keeps API rows hidden', async () => {
  for (const version of [36, 37]) {
    const f = keywordFixture(1000);
    try {
      f.db.exec(`DROP TABLE memory_supersessions; DROP TABLE custom_api_current_jobs;
        DROP TABLE custom_api_document_versions; UPDATE install_state SET schema_version=${version}`);
      const options = { limit: 5 };
      if (version === 36) {
        const actual = await searchKeyword(f.env, 'invoice', options);
        assert.deepEqual(actual, oldKeyword(f.db, '"invoice"', options, { memory: false, pointers: false }));
        assert.ok(actual.length > 0, 'legacy control reads actual rows');
      } else {
        await assert.rejects(searchKeyword(f.env, 'invoice', options), /memory_supersessions/);
      }
      assert.ok(f.calls.some(call => /schema_version FROM install_state/.test(call.sql)), 'legacy schema decision reached');
      assert.ok(f.calls.some(call => /chunks_fts MATCH/.test(call.sql)), 'actual FTS read attempted');
    } finally { f.db.close(); }
  }
});
