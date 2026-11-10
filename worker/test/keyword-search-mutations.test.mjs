import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { search, searchKeyword } from '../src/lib/store-d1.js';
import { differentialCases, keywordFixture } from './fixtures/keyword-search.mjs';
import { searchFailureLogging } from './fixtures/search-failure-logging.mjs';

const sourceUrl = new URL('../src/lib/store-d1.js', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
function mutate(before, after) {
  assert.equal(source.split(before).length - 1, 1, 'mutant changes exactly one real decision');
  return source.replace(before, after);
}
async function loadMutant(code) {
  assert.notEqual(code, source, 'mutation must change reviewed source');
  const absolute = code.replace(/from (["'])(\.[^"']+)\1/g,
    (_match, quote, path) => `from ${quote}${new URL(path, sourceUrl).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`);
}

test('all five keyword and warning mutants are killed by the real-path probes', async t => {
  const f = keywordFixture();
  try {
    assert.equal(await differentialCases(searchKeyword, f), 24, 'unmutated differential green control');
    await searchFailureLogging(search);
    const mutants = [
      ['widening removed', mutate('candidateCount !== candidates', 'true'), /source widening/],
      ['fallback removed', mutate(
        'return env.DB.prepare(sql(memoryClause, withCurrentPointer)).bind(...params).all();',
        'return { results: [] };'), /source fallback/],
      ['source filter dropped', mutate(
        'WHERE 1 = 1${predicates(memoryClause, withCurrentPointer)}',
        'WHERE 1 = 1${predicates(memoryClause, withCurrentPointer).replace(" AND c.source = ?3", " AND (?3 IS NULL OR ?3 IS NOT NULL)")}'), /source widening/],
      ['tie-breaker removed', source.replaceAll('ORDER BY score, rowid', 'ORDER BY score')
        .replaceAll('ORDER BY top.score, top.rowid', 'ORDER BY top.score')
        .replaceAll('ORDER BY score, _keyword_rowid', 'ORDER BY score')
        .replaceAll('ORDER BY bm25(chunks_fts), chunks_fts.rowid', 'ORDER BY bm25(chunks_fts)'), /tie-breaker/],
      ['query text in log', mutate(
        'error: searchFailureCategory(error),',
        'error: { ...searchFailureCategory(error), message: String(error?.message || "Search stage failed").slice(0, 300) },'), /private query/],
    ];
    for (const [name, code, reason] of mutants) {
      await t.test(name, async () => {
        const mutant = await loadMutant(code);
        await assert.rejects(name === 'query text in log'
          ? searchFailureLogging(mutant.search)
          : differentialCases(mutant.searchKeyword, f), reason, 'semantic assertion kills the mutant');
      });
    }
  } finally { f.db.close(); }
});
