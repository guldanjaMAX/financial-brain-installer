import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { searchKeyword } from '../src/lib/store-d1.js';
import { keywordFixture, oldKeyword } from './fixtures/keyword-search.mjs';

// Explicit local benchmark, outside the ordinary test chain. Every byte is
// generated synthetic data; no credentials, corpus files or providers exist.
const f = keywordFixture(200_000);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  const results = [];
  for (const [label, query, terms] of [
    ['common OR', 'invoice payment received', '"invoice" OR "payment" OR "received"'],
    ['selective', 'rareterm', '"rareterm"'],
  ]) {
    const options = { limit: 40 };
    const oldMs = [], newMs = [];
    let returned;
    for (let i = 0; i < 7; i++) {
      // Alternate order so one implementation does not always inherit the
      // other's warmed pages. Record first passes separately from medians.
      let before, after;
      const old = () => { const start = performance.now(); before = oldKeyword(f.db, terms, options); oldMs.push(performance.now() - start); };
      const updated = async () => { const start = performance.now(); after = await searchKeyword(f.env, query, options); newMs.push(performance.now() - start); };
      if (i % 2) { await updated(); old(); } else { old(); await updated(); }
      assert.deepEqual(after, before, `${label}: benchmark result equivalence`);
      returned = before.length;
    }
    results.push({ query: label, rows: f.db.prepare('SELECT count(*) AS n FROM chunks').get().n,
      matches: f.db.prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?').get(terms).n,
      returned,
      old_first_ms: +oldMs[0].toFixed(3), new_first_ms: +newMs[0].toFixed(3),
      old_median_ms: +median(oldMs).toFixed(3), new_median_ms: +median(newMs).toFixed(3),
      old_ms: oldMs.map(value => +value.toFixed(3)), new_ms: newMs.map(value => +value.toFixed(3)) });
  }
  console.log(JSON.stringify({ synthetic: true, sqlite_version: f.db.prepare('SELECT sqlite_version() AS v').get().v,
    repetitions: 7, results }, null, 2));
} finally { f.db.close(); }
