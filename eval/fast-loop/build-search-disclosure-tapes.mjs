// Explicit offline authoring only; ordinary replay never runs this command.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { DOCUMENT_CASES, CLOCK_CASES } from '../../test/fixtures/fastloop-route/input.mjs';
import { CASES, loadTapes } from './day3-bench.mjs';
import { baselineHttpSources, baselineSources, workingTreeSources } from './ledger-sources.mjs';
import { batch1Sources } from './batch1-sources.mjs';
import { replayRoute } from './route-replay.mjs';
import { clone, sha256 } from './exact-tape.mjs';

import { decode, reviewedStatement } from './search-disclosure-tape-review.mjs';
export function buildSearchDisclosureTapes({ replayRouteImpl = replayRoute } = {}) {
  const entries = new Map();
  function changes(before, after) {
    assert.equal(before.d1.length, after.d1.length, 'no dependency attempt disappears');
    assert.deepEqual(after.model, before.model, 'model streams remain frozen');
    assert.deepEqual(after.provider, before.provider, 'provider streams remain frozen');
    before.d1.forEach((entry, index) => {
      const next = clone(after.d1[index]);
      if (sha256(entry.input) === sha256(next.input)) return;
      assert.equal(next.input.principal, entry.input.principal);
      assert.equal(next.input.occurrence, entry.input.occurrence);
      const prior = decode(entry.input.request), current = decode(next.input.request);
      if (prior.method === 'batch') {
        assert.equal(current.method, prior.method);
        assert.equal(current.statements.length, prior.statements.length);
        prior.statements.forEach((statement, i) => {
          if (!reviewedStatement(statement, current.statements[i], entry.output[i], next.output[i]))
            next.output[i] = clone(entry.output[i]);
        });
      } else reviewedStatement(prior, current, entry.output, next.output);
      const key = sha256(entry);
      if (entries.has(key)) assert.deepEqual(entries.get(key), next);
      entries.set(key, next);
    });
  }
  function author(cases, previous, sourceOverrides = {}) {
    const run = replayRouteImpl({ cases, capture: true, sourceOverrides });
    assert.ok(run.observations.every(o => o.execution_status === 'complete'));
    assert.equal(run.provider_calls + run.production_writes, 0);
    for (const input of cases) changes(previous[input.id], run.tapes[input.id]);
  }
  const tapes = loadTapes();
  author(CASES, tapes.baseline, baselineHttpSources());
  author(CASES, tapes.batch1, { ...batch1Sources(), 'ledger-reader.js': baselineSources()['ledger-reader.js'],
    'money-veto.js': baselineHttpSources()['money-veto.js'] });
  author(CASES, tapes.candidate, workingTreeSources());
  const route = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-route/tapes.json', import.meta.url)));
  author([...BASE_CASES, ...CONTROLS, ...DOCUMENT_CASES, ...CLOCK_CASES], route);
  for (const authority of ['proxy', 'anonymous']) {
    const input = CONTROLS.find(c => c.id === 'M06/typed');
    const run = replayRouteImpl({ cases: [input], capture: true, authority });
    assert.ok(run.observations.every(o => o.execution_status === 'complete'));
    changes(route[`authority/${authority}`], run.tapes[input.id]);
  }
  return { schema: 1, version: 'search-disclosure-v1', entries: [...entries].map(([before_sha256, after]) => ({ before_sha256, after })) };
}

export function writeSearchDisclosureTapes({ check = false } = {}, { build = buildSearchDisclosureTapes, read = readFileSync, write = writeFileSync } = {}) {
  const patch = build();
  const bytes = JSON.stringify(patch, null, 2) + '\n';
  const target = new URL('../../test/fixtures/fastloop-route/search-disclosure-v1.json', import.meta.url);
  if (check) assert.equal(sha256(read(target, 'utf8')), sha256(bytes), 'owning author reproduces the sealed overlay');
  else write(target, bytes);
  return { entries: patch.entries.length, sha256: sha256(bytes), provider_calls: 0, production_writes: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--check')) throw Error('usage: build-search-disclosure-tapes.mjs [--check]');
  console.log(JSON.stringify(writeSearchDisclosureTapes({ check: args.length === 1 })));
}
